# Agent Studio — Canonical Architecture

> **Status:** Authoritative. This is the single source of truth the code is
> built from: fan-out detection, the PTY/streaming substrate, the React/Zustand
> UI, and one set of decisions across them.
>
> **Milestones:** M0–M4 (§8).
>

Where a choice had to be made, this doc makes it in one line, tagged
**Decision:**, with the reason. The contract in §2 wins over any conflicting
snippet elsewhere.

---

## 1. System overview

Two processes-in-one, two data planes. The **Rust core** owns every OS resource
(PTYs, child processes, file watches, transcript tailers). The **React UI** is a
pure view over normalized state plus a set of long-lived terminal/editor
instances that live *outside* React. They talk over exactly three channels.

```
┌──────────────────────────── Tauri v2 app (single process) ─────────────────────────────┐
│                                                                                          │
│  ┌───────────────────── RUST CORE (tokio multi-thread) ──────────────────────┐          │
│  │                                                                            │          │
│  │   SessionSupervisor (actor, mpsc command loop)                             │          │
│  │        owns ──►  Terminals: HashMap<TerminalId, TerminalRuntime>           │          │
│  │        owns ──►  Agent forest: HashMap<AgentId, AgentNode> (parentId edges)│          │
│  │          │                                                                 │          │
│  │   ┌──────┴─────┐      ┌───────────────┐      ┌──────────────────────────┐  │          │
│  │   │ PTY manager│      │ AgentAdapter  │      │ FS watcher (notify +      │  │          │
│  │   │ portable-  │      │  └ transcript-│      │  debouncer, per workspace)│  │          │
│  │   │ pty +      │      │    tailer task│      └──────────────────────────┘  │          │
│  │   │ reader/    │      │  (JSONL →     │                                     │          │
│  │   │ writer/    │      │   FanoutDelta)│                                     │          │
│  │   │ waiter thrd│      └───────────────┘                                     │          │
│  │   └──────┬─────┘                                                            │          │
│  └──────────┼─────────────────────────────────────────────────────────────────┘         │
│             │                                                                            │
│   ═══ HOT plane ═══        ═══════════════ COLD plane ═══════════════                    │
│   PTY bytes                agent://event (telemetry)     fs://change (tree deltas)        │
│   per-terminal             app.emit JSON                 app.emit JSON                    │
│   tauri::ipc::Channel                                                                     │
│   <raw bytes>                                                                             │
│             │                       │                            │                       │
│  ┌──────────▼───────────────────────▼────────────────────────────▼──────────┐           │
│  │                     REACT UI (WebView) — Zustand store                     │           │
│  │                                                                            │           │
│  │  LEFT RAIL             CENTER WORK AREA              RIGHT RAIL             │           │
│  │  AgentTree (fan-out)   PaneTree: xterm.js / CM6      Workspace file tree    │          │
│  │  ← agent://event       ← Channel bytes → xterm       ← fs://change          │          │
│  │  (telemetry nodes)       (bypasses React state)      (per selected agent)  │           │
│  └────────────────────────────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**The three channels (this is the contract surface):**

| Plane | Channel | Direction | Carries | Volume |
|---|---|---|---|---|
| **Hot** | `tauri::ipc::Channel<Raw bytes>` (one per terminal) | Rust→UI | Coalesced PTY output, binary-safe | High; never JSON, never touches the store |
| **Cold** | Tauri event `agent://event` | Rust→UI | Fan-out telemetry deltas (`AgentEvent`) | Low; coalesced in Rust |
| **Cold** | Tauri event `fs://change` | Rust→UI | Workspace tree patches (`FsPatch`) | Low; debounced in Rust |
| control | `#[tauri::command]` invocations | UI→Rust | open/write/resize/close, spawn_agent, read_dir, snapshot | Low |

**Decision — event names.** Canonical events are `agent://event` and
`fs://change`, not one event per kind (`fleet:node-added` / `session:status` /
`workspace:fs-delta`) — one telemetry event carrying a tagged `AgentEvent`, one
FS event carrying a tagged `FsPatch`. Reason: fewer event names, discriminated
unions reduce over the same reducer.

**Governing invariant:** high-volume byte
streams *never* enter React state. Terminal bytes flow `Channel → xterm.write`;
editor text lives in CodeMirror's `EditorState`. The store holds only metadata.

---

## 2. Canonical data model (THE contract)

Everything references this section. Two categories:

- **Wire types** — cross the Rust↔JS boundary; defined once in Rust with `serde`
  and mirrored in TypeScript. `AgentNode`, `AgentEvent`, `TerminalMeta`,
  `DirEntry`, `FsPatch`.
- **UI-only types** — never cross the wire; TypeScript only. `Session`, `Tab`,
  `PaneNode`, `Workspace`/`WorkspaceTreeNode`, `Selection`.

### 2.0 Naming (read this first)

| Concept | Alternative name (UI side) | Alternative name (core side) | **Canonical decision** |
|---|---|---|---|
| The supervised PTY unit | `TerminalHandle` (`ptyId: number`) | `SessionMeta`/`SessionRuntime` (`SessionId = ulid`) | **`Terminal`**, keyed by **`TerminalId` (ULID string)**. There is no numeric `ptyId`; the ULID *is* the handle. |
| "Session" | UI layout container (owns panes/tabs) | one PTY+child | **`Session` = UI-only layout container.** The Rust PTY unit is a **`Terminal`**. This removes the clash. |
| The actor | — | `SessionSupervisor` | Keep **`SessionSupervisor`** — it supervises the whole fleet (terminals + agent forest). Name is fine; it just doesn't own a wire type called "Session". |
| Fan-out node | `AgentNode` | `AgentSession`/`SessionMeta` | **`AgentNode`** everywhere (wire + UI). |
| Status enum | `'running' \| 'waiting_input' \| …` | `Running, WaitingForInput, Error(String)` | **`idle \| running \| waiting_input \| done \| error`** (snake_case string union); error detail carried in a separate optional field, not `Error(String)`. |
| Telemetry channel | `agent://event` | `fleet:node-added` etc. | **`agent://event`** (single tagged stream). |
| FS channel | `fs://change` | `workspace:fs-delta` | **`fs://change`**. |

> **`prompt`, not `presetId`.** `agent_spawn` takes `prompt: Option<String>`
> (seed an agent with a task). There is no `presetId`: agent presets don't exist;
> reintroduce it only when they do, and as an addition, not a rename. A mismatch
> here would fail silently, because serde ignores unknown fields — so the TS
> wrapper and the Rust command must use the same name.

> **Decision — an agent's `TerminalId` IS its `AgentId`.** Not a convention, a
> requirement: `agent_spawn` takes no `terminalId`, so a client that mints its own
> gets a PTY that **streams output but silently ignores every keystroke, resize and
> close** — a dead keyboard with no error, because the `Channel` is handed over
> directly while `write`/`resize`/`close` address an id Rust never registered.

**Decision — all ids are ULID strings on the wire.** Sortable, unique,
JSON-safe, and lets the store re-point by swapping an id. Claude's own
`agentId` (e.g. `a0000000000000001`) is used verbatim as the `AgentId` for
sub-agents discovered from transcripts; root agents get a fresh ULID.

### 2.1 TypeScript — identifiers

```ts
type Brand<K, T> = K & { readonly __brand: T };
type AgentId     = Brand<string, 'AgentId'>;      // fan-out tree node (ULID or Claude agentId)
type TerminalId  = Brand<string, 'TerminalId'>;   // 1:1 with a Rust PTY handle (ULID)
type SessionId   = Brand<string, 'SessionId'>;    // UI layout container (client-only, ULID)
type PaneId      = Brand<string, 'PaneId'>;
type TabId       = Brand<string, 'TabId'>;
type EditorDocId = Brand<string, 'EditorDocId'>;
type WorkspaceId = Brand<string, 'WorkspaceId'>;
type WsNodeId    = Brand<string, 'WsNodeId'>;
```

### 2.2 Wire types (TypeScript view; Rust mirror in §2.5)

```ts
type AgentStatus = 'idle' | 'running' | 'waiting_input' | 'done' | 'error';
type AgentKind   = 'orchestrator' | 'subagent';

// AgentNode — emitted by fleet_snapshot; the store augments it with UI-only fields.
interface AgentNode {
  id: AgentId;
  parentId: AgentId | null;          // null => root orchestrator
  kind: AgentKind;
  title: string;                     // "Tidy up the parsers"
  status: AgentStatus;
  branch: string;                    // "trunk"
  cwd: string;                       // absolute; shown as "trunk • ~/projects/proj"
  runtime: string;                   // AgentAdapter id, e.g. "claude-code"
  startedAt: number | null;
  finishedAt: number | null;
  lastActivityAt: number;

  // ── UI-only augmentation (NOT from the wire; store-maintained) ──
  childIds: AgentId[];               // derived from parentId edges; ordered
  sessionId: SessionId | null;       // root agents own a Session; sub-agents = null (v1)
  expanded: boolean;                 // AgentTree disclosure
  unread: number;                    // notifications attributable to this agent
}

// AgentEvent — the ONLY telemetry payload on `agent://event` (tagged by `t`).
type AgentEvent =
  | { t: 'agent_started';    agentId: AgentId; parentId: AgentId | null;
      title: string; cwd: string; branch: string; runtime: string }
  | { t: 'subagent_spawned'; parentId: AgentId; childAgentId: AgentId;
      title: string; cwd: string; branch: string; runtime: string }
  | { t: 'status';           agentId: AgentId; status: AgentStatus }
  | { t: 'activity';         agentId: AgentId; at: number }
  | { t: 'exited';           agentId: AgentId; code: number }
  | { t: 'title';            agentId: AgentId; title: string };

// TerminalMeta — PTY metadata (never bytes). Returned by terminal_open / fleet_snapshot.
type TerminalKind   = 'agent-terminal' | 'terminal';
type TerminalStatus = 'live' | 'exited';
interface TerminalMeta {
  id: TerminalId;
  kind: TerminalKind;
  title: string;
  cwd: string;
  cols: number; rows: number;
  status: TerminalStatus;
  exitCode?: number;
  agentId?: AgentId;                 // set for agent-terminals
}

// DirEntry — one row of a directory listing (right rail; lazy).
interface DirEntry { name: string; path: string; isDir: boolean; size: number; mtime: number }

// FsPatch — the ONLY payload on `fs://change` (tagged by `op`).
type GitStatus = 'modified' | 'added' | 'deleted' | 'untracked';
type FsPatch =
  | { op: 'created';    parentPath: string; entry: DirEntry }
  | { op: 'removed';    path: string }
  | { op: 'renamed';    from: string; to: string }
  | { op: 'git_status'; changes: Array<{ path: string; status: GitStatus }> };
```

### 2.3 UI-only types — layout, tabs, selection

```ts
// Session — a workspace context that owns the center layout. One per root orchestrator.
interface Session {
  id: SessionId;
  rootAgentId: AgentId;
  workspaceId: WorkspaceId;
  layout: PaneNode;                  // the split-pane tree (below)
  focusedPaneId: PaneId;             // blue top-border; where new tabs open
  tabs: Record<TabId, Tab>;
  terminals: Record<TerminalId, TerminalMeta>;
  docs: Record<EditorDocId, EditorDoc>;
  createdAt: number;
}

type TabKind = 'agent-terminal' | 'terminal' | 'editor';
interface Tab {
  id: TabId;
  kind: TabKind;
  title: string;
  icon: string;                      // resolved from kind + doc language
  ref:
    | { kind: 'agent-terminal'; terminalId: TerminalId; agentId: AgentId }
    | { kind: 'terminal';       terminalId: TerminalId }
    | { kind: 'editor';         docId: EditorDocId };
  dirty?: boolean;
}

interface EditorDoc { id: EditorDocId; path: string; language: string; dirty: boolean }
// text buffer lives in CodeMirror EditorState, NOT here.

// PaneNode — the split-pane layout tree, stored per Session.
type Orientation = 'row' | 'column';            // 'row' = side-by-side (vertical divider)
type PaneNode = SplitNode | LeafNode;
interface SplitNode { id: PaneId; type: 'split'; orientation: Orientation;
                      children: PaneNode[]; sizes: number[] }   // sizes sum to 1
interface LeafNode  { id: PaneId; type: 'leaf'; tabIds: TabId[]; activeTabId: TabId | null }

// Workspace — the right-rail file tree (normalized, lazy).
interface Workspace {
  id: WorkspaceId; rootPath: string; rootNodeId: WsNodeId;
  nodes: Record<WsNodeId, WorkspaceTreeNode>; expandedIds: Set<WsNodeId>;
}
interface WorkspaceTreeNode {
  id: WsNodeId; parentId: WsNodeId | null;
  name: string; path: string; kind: 'dir' | 'file';
  childIds: WsNodeId[] | null;       // null => not yet loaded (lazy expand)
  loading?: boolean;
  gitStatus?: GitStatus | null;
}

// Selection — the single pivot.
type RightRailTab = 'files' | 'find' | 'vault';
interface Selection {
  selectedAgentId: AgentId | null;   // highlighted row in the left rail
  activeSessionId: SessionId | null; // DERIVED: session of selected agent's root
  rightRailTab: RightRailTab;
}
```

### 2.4 Command surface (canonical)

**Decision.** Use `terminal_*` for PTY lifecycle (precise) and `agent_spawn` for
creating an agent (noun-verb, like the `terminal_*` set), rather than
`pty_subscribe`/`pty_write`/`pty_resize`/`spawn_agent`. All ids are strings.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `agent_spawn` | `{ agentId, runtime, prompt?, cwd, rows, cols, onOutput: Channel }` | `TerminalMeta` | Spawns `claude` in a PTY. **No `terminalId`:** an agent terminal's `TerminalId` **IS** its `AgentId` (`supervisor/mod.rs` keys it that way) — the client must not mint a separate one. M3 adds the fan-out tailer. |
| `terminal_open` | `{ terminalId, program, args, cwd, rows, cols, onOutput: Channel }` | `TerminalMeta` | Plain shell PTY (program defaults to `$SHELL`). |
| `terminal_write` | `{ terminalId, data: Uint8Array }` | `()` | Keystrokes. |
| `terminal_resize` | `{ terminalId, rows, cols }` | `()` | Debounced 50 ms UI-side. |
| `terminal_close` | `{ terminalId }` | `()` | Kills child, tears down PTY + tailer. |
| `fleet_snapshot` | `{}` | `{ agents: AgentNode[]; terminals: TerminalMeta[] }` | Initial paint / restart re-attach. |
| `read_dir` | `{ path }` | `DirEntry[]` | Lazy child load (dirs-first sorted). |
| `read_file` | `{ path }` | `string` (raw body if large) | Editor open. |
| `run_find` | `{ root, query }` | `FindHit[]` | ripgrep via `ignore` crate (M4). |

### 2.5 Rust mirror (wire protocol, serde)

```rust
// serde convention: structs → camelCase (match TS fields); enums → snake_case (match string unions).
pub type AgentId    = String;   // ULID or Claude agentId
pub type TerminalId = String;   // ULID

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus { Idle, Running, WaitingInput, Done, Error }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind { Orchestrator, Subagent }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNode {
    pub id: AgentId,
    pub parent_id: Option<AgentId>,
    pub kind: AgentKind,
    pub title: String,
    pub status: AgentStatus,
    pub branch: String,
    pub cwd: String,
    pub runtime: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_activity_at: i64,
    // error detail (flat, optional) — NOT an enum payload, so JSON stays a string union
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentStarted    { agent_id: AgentId, parent_id: Option<AgentId>, title: String, cwd: String, branch: String, runtime: String },
    SubagentSpawned { parent_id: AgentId, child_agent_id: AgentId, title: String, cwd: String, branch: String, runtime: String },
    Status          { agent_id: AgentId, status: AgentStatus },
    Activity        { agent_id: AgentId, at: i64 },
    Exited          { agent_id: AgentId, code: i32 },
    Title           { agent_id: AgentId, title: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    pub id: TerminalId,
    pub kind: TerminalKind,          // AgentTerminal | Terminal, serde snake_case
    pub title: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalStatus,      // Live | Exited
    pub exit_code: Option<i32>,
    pub agent_id: Option<AgentId>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry { pub name: String, pub path: String, pub is_dir: bool, pub size: u64, pub mtime: i64 }

#[derive(Clone, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FsPatch {
    Created   { parent_path: String, entry: DirEntry },
    Removed   { path: String },
    Renamed   { from: String, to: String },
    GitStatus { changes: Vec<GitChange> },
}
```

Internal (non-`Serialize`) live state stays server-side and is *not* part of the
contract:

```rust
struct TerminalRuntime {
    meta: TerminalMeta,
    pty: PtyHandle,                                    // master/slave, writer, child (§3)
    output_channel: Channel<InvokeResponseBody>,      // set on open (hot plane)
    killer: Box<dyn ChildKiller + Send + Sync>,
    _tailer: Option<tokio::task::JoinHandle<()>>,      // agent terminals only
}
```

---

## 3. Rust core module layout

`src-tauri/src/` — modules mirror the two planes (`pty`+`stream` = hot;
`supervisor`+`agent`+`workspace` = cold). `agent/` is the **only**
Claude-specific code; everything else is runtime-agnostic.

```
src-tauri/
├─ Cargo.toml
├─ tauri.conf.json            # windows, bundle targets, identifier
├─ capabilities/default.json  # Tauri v2 permission set (fs, etc.)
├─ build.rs
└─ src/
   ├─ main.rs                 # Linux env workarounds (§6) + Builder + .manage(supervisor)
   ├─ lib.rs                  # run(): builder wiring, command registration, plugins
   ├─ model.rs                # ALL §2.5 wire types (serde) — the contract, one place
   ├─ pty/
   │  ├─ mod.rs               # PtyHandle: spawn_pty, resize, write_input, cleanup
   │  └─ reader.rs            # blocking reader thread → bounded mpsc<Bytes> (backpressure)
   ├─ stream/
   │  └─ coalesce.rs          # pump_to_ui: time(8ms)+size(32KB) batching → ipc::Channel
   ├─ supervisor/
   │  ├─ mod.rs               # SessionSupervisor actor loop; SupervisorHandle (mpsc)
   │  ├─ registry.rs          # HashMap<TerminalId, TerminalRuntime> + agent forest
   │  └─ commands.rs          # #[tauri::command] fns → SupervisorMsg (§2.4)
   ├─ agent/
   │  ├─ adapter.rs           # AgentAdapter trait — the runtime seam (§5)
   │  └─ claude.rs            # Claude Code adapter: spawn spec + transcript tailer + JSONL parse
   └─ workspace/
      ├─ watch.rs             # notify + notify-debouncer-full → fs://change (FsPatch)
      └─ fs.rs                # read_dir (ignore-aware), read_file, run_find (ripgrep)
```

**Concurrency model — supervisor as an actor.** One
`SessionSupervisor` task owns all `TerminalRuntime`s + the agent forest, driven
by an mpsc command channel. The hot path (PTY bytes) does **not** touch the
supervisor — reader thread → coalescer → `Channel` is lock-free per terminal. The
supervisor is only on the low-frequency control path (open/write/resize/exit/
fan-out). No `Arc<Mutex<HashMap>>` contention regardless of fleet size.

### Pinned crate deps (`Cargo.toml`)

| Crate | Version | Role |
|---|---|---|
| `tauri` | **2.9.x** | app framework, IPC `Channel`, bundler (rustc ≥ 1.77) |
| `tauri-build` | 2.x | build script |
| `tauri-plugin-fs` | 2.4.x | fs access (right rail / editor) |
| `tauri-plugin-store` | 2.x | persist session layout (re-attach; deferred wiring) |
| `tauri-plugin-updater` | 2.x | auto-update (deferred; sign artifacts now) |
| `portable-pty` | **0.9.x** | cross-platform PTY incl. Windows ConPTY |
| `tokio` | 1.x | async runtime (`rt-multi-thread,macros,sync,io-util,process,time`) |
| `bytes` | 1.x | zero-copy byte buffers (hot path) |
| `notify` | **8.x** | filesystem watching |
| `notify-debouncer-full` | **0.7.x** | debounced FS events (MSRV 1.85) |
| `ignore` | 0.4.x | gitignore-aware tree walk + Find |
| `serde` / `serde_json` | 1.x | wire schema + transcript parse |
| `ulid` | 1.x | sortable ids |
| `anyhow` / `thiserror` | 1.x | errors |
| `tracing` / `tracing-subscriber` | 0.1 / 0.3 | logging |

**Key PTY facts that shape the code** (do not relearn the hard way):
`portable-pty`'s reader/writer are **blocking** `std::io` — bridge to tokio with a
dedicated OS thread per reader → bounded `mpsc<Bytes>(256)` (backpressure: full
channel parks the reader, fills the kernel PTY buffer, throttles the child).
Grab `pair.master.try_clone_reader()` **before** moving the pair; grab
`child.clone_killer()` up front so you can kill while `wait()` blocks.

**Verified PTY facts (measured — do not "simplify" these away):**
- 🔴 **`drop(pair.slave)` after spawn is LOAD-BEARING, and only Linux proves it.**
  A C probe against both kernels: on **Linux**, the master `read` returns `EIO`
  when the slave is dropped but **blocks forever if the slave is leaked**; macOS
  revokes the tty on session-leader exit and reports EOF either way. So
  `mem::forget(pair.slave)` **hangs and fails on Linux while staying green on
  macOS.** Passing locally on a Mac proves nothing here — **the Ubuntu test
  leg is genuinely load-bearing**, not box-ticking.
- **`EIO`-as-EOF is handled upstream.** `portable-pty` already normalizes it
  (`unix.rs:96`: `EIO` → `Ok(0)`) before our reader sees it, so our
  `Err(_) => break` arm is unreachable *for EIO*. The arm is defence-in-depth,
  not the EIO handler.
- ⚠️ **`openpty` races under concurrent creation on macOS** (~50% failure at
  17-way parallel spawn; **not** exhaustion — 35 of a 511 limit). Serial passes
  100%. **M3's fan-out spawns agents in bursts through this same path**, so this
  is a product concern, not a test artifact. Under investigation.

---

## 4. Frontend structure

`src/` — Vite + React 19 + TypeScript. `features/` mirror the three rails.

```
src/
├─ main.tsx
├─ app/
│  ├─ store.ts            # Zustand store (slices below)
│  ├─ ipc.ts              # invoke wrappers + Channel plumbing (§2.4)
│  ├─ bridge.ts           # listen('agent://event'), listen('fs://change') → store reducers
│  └─ theme.ts            # 3-tier CSS-var tokens; xterm/CM theme derivation
├─ features/
│  ├─ fleet/              # LeftRail, AgentTree, AgentNode (recursive), status pills
│  ├─ terminal/           # useTerminal hook + TerminalRegistry (xterm instances, non-React)
│  ├─ editor/             # CodeMirror 6 tab, language lazy-load
│  └─ workspace/          # RightRail, FileTree, FindPanel, VaultPanel(stub)
└─ components/            # AppShell, TitleBar, PaneTree, Pane, TabBar, SplitContainer, StatusBar
```

**Component hierarchy** (the load-bearing nodes):
`<AppShell>` (3-col CSS grid) → `<LeftRail>`(`<AgentTree>`→recursive `<AgentNode>`)
· `<CenterWorkArea sessionId>` → `<PaneTree>` (split-node → `<SplitContainer>`;
leaf → `<Pane>` = `<TabBar>` + `<PaneToolbar>` + `<TabView>` switching on tab
kind: `<AgentTerminalView>` / `<TerminalView>` / `<EditorView>`) · `<RightRail
workspaceRootId>` → `<FileTree>` / `<FindPanel>` / `<VaultPanel>`. `<OverlayLayer>`
portals the new-agent menu, context menus, command palette, toasts.

### Zustand store slices + key actions

**Decision — Zustand + Immer + `subscribeWithSelector`** (a
"lightweight store"). Reason: the store is written **mostly from imperative
Rust-event callbacks** — `getState()`/`setState()` need no Provider/hook, so
`bridge.ts` writes directly; selector-scoped subscriptions mean one agent's
telemetry re-renders one row.

```ts
interface AppStore {
  // domain (all normalized: flat Record maps, parentId/childIds trees)
  agents: Record<AgentId, AgentNode>;   rootAgentIds: AgentId[];
  sessions: Record<SessionId, Session>;
  workspaces: Record<WorkspaceId, Workspace>;
  selection: Selection;
  // ui / runtime
  ui: { theme: 'dark'|'light'|'system'; leftCollapsed: boolean; rightCollapsed: boolean;
        leftWidth: number; rightWidth: number };
  bridge: { status: 'connecting'|'ready'|'lost' };
  // action groups (all mutate via Immer producers)
  agentActions: AgentActions;       // createAgent, selectAgent (the pivot), spawnChild,
                                    //   updateAgentStatus, removeAgent
  layoutActions: LayoutActions;     // openTab, closeTab, setActiveTab, splitPane,
                                    //   resizePane, moveTab, focusPane
  workspaceActions: WorkspaceActions; // ensureWorkspaceLoaded, toggleDir, applyFsPatch,
                                    //   setRightRailTab, runFind
  uiActions: UiActions;             // setTheme, toggleLeft/Right, setRailWidth
}
```

- **`selectAgent(id)` is the single pivot**: it re-points center + right
  rail by changing *ids only* — sets `selection.selectedAgentId` and derives
  `activeSessionId = rootOf(agent).sessionId`. `<CenterWorkArea sessionId>` swaps
  the whole layout tree in one render; `<RightRail>` swaps the workspace root.
- **`spawnChild(ev)` is called ONLY by the telemetry reducer**, never the UI — it
  inserts a sub-agent under `parentId`, which makes a new row **appear live**
  under its parent (the headline). A sub-agent (or root) that exits **on its own**
  stays greyed (`done`/`error`) for inspection.
- **Dismissal removes; it does not archive**.
  *Explicit dismissal* = the user closing the agent's tab **or** clicking the ✕ on
  its row. It kills the child if still alive and **removes the agent and its whole
  sub-tree** from the rail and the fleet — a closed agent is gone, not kept as a
  `done` node. `removeAgent` cascades to descendants. The tab-✕ and row-✕ run the
  **same** dismissal path. ⚠️ A dismissed agent must **stay** dismissed: late
  telemetry (`exited`/`status`/`activity`) for it is a no-op and `adoptOrphans`
  must never resurrect it as a ghost root.

### Split-pane — final pick

**Decision — own the `PaneNode` tree in the Zustand store; render split
*containers* with `allotment`; hand-roll the drag-tab-between-panes handler.** Do
**not** adopt a framework that owns the layout model (`react-mosaic`,
`dockview`). Reason: the layout must be swappable per-session and
patched by the same store as everything else, so the *model* must be ours; but
resize math/a11y/touch is solved — borrow it from `allotment` (VS Code's Split
View; controlled `sizes` + `onChange`, matches the reference aesthetic).
`react-resizable-panels` is an equivalent alt. `dockview` is the fallback only if
hand-rolling drag-tab proves costly — then it owns layout while Zustand keeps
agents/sessions/selection. The tree is canonicalized after every mutation
(single-child splits collapse, same-orientation nests flatten, empty leaves are
removed, sizes renormalize).

### Terminal & editor integration points

- **Terminal — `@xterm/xterm` 6.0.x** (scoped package; the unscoped `xterm` is
  deprecated — do not install it). A non-React `TerminalRegistry` (plain module,
  `Map<TerminalId, Terminal>`) owns the instances and is the *only* place bytes
  land: `channel.onmessage = (buf) => term.write(new Uint8Array(buf))`. The React
  `<XtermCanvas>` only mounts/unmounts the DOM host via `useLayoutEffect`. On
  session switch, **detach the DOM but keep the instance** (`display:none`) so
  scrollback/cursor survive. Addons: `addon-fit` (sizing), `addon-webgl`
  (fast path), `addon-web-links`, `addon-serialize` (persist/replay for
  virtualization + re-attach). ⚠️ **`addon-canvas` is GONE** — abandoned upstream
  (last publish 2024-07-14) and unusable with xterm 6; **never re-add it**.
  **Renderer:** attempt WebGL → fall back to **DOM**, on every platform.
  Virtualize offscreen terminals (biggest perf win for a fleet).
- **Editor — CodeMirror 6** (via `@uiw/react-codemirror`; editing supports
  supervision, not a full IDE). Lazy-`import()` the `@codemirror/lang-*`
  package by file extension. Guard pathological files: `> ~3 MB` or very long
  lines → open read-only, disable heavy extensions. Text lives in `EditorState`,
  never the store.
- **Theming** — three-tier CSS custom properties (primitives → semantic →
  component); `data-theme="dark|light"` on `<html>` + a `system` mode. xterm and
  CM6 themes are **derived from the same tokens** (`getComputedStyle`), so all
  three surfaces stay in lockstep on theme switch.

---

## 5. The fan-out mechanism (headline)

This is M3 and the reason the product exists (*no shipping GUI uses the live
recursive sub-agent tree as its primary surface*). The tree is **derived from
Claude Code's own telemetry**, not
by parsing our UI.

### 5.1 Chosen approach

**Decision — transcript-tailing is primary; hooks are an optional real-time
enhancement.** Reason:
transcript JSONL is the *source of truth* — it works for finished, resumed, and
running sessions, survives app restart (resume from saved file offsets), needs no
user configuration, and naturally handles concurrent agents at any nesting depth.
Hooks (HTTP POST to `localhost:9999` on `SubagentStart`/`SubagentStop`) give
lower-latency notification but only for live sessions and require injecting config
— so tailing always takes precedence and hooks are confirmatory. The Agent SDK is
**rejected for v1**: it has no PTY, conflicting with the terminal-first design
("agents run in real terminals the user sees").

### 5.2 What transcript-tailing reads

> 🔴 **Discovery is not identity.** The "mangled cwd → project dir" lookup
> below is **discovery, NOT identity**. It **cannot distinguish two agents running
> in the same cwd** — a completely normal case (two agents on one repo). cmux
> shipped exactly this heuristic and then **deleted it**; their
> `agent-session-tracking-spec.md` is a postmortem reading *"Never from
> terminal-title matching. Never from newest-file-by-mtime."* Do not repeat it.
>
> **We spawn the `claude` process ourselves, so we can dictate identity instead of
> inferring it:** inject a protected id at PTY spawn (env var) and/or mint the
> session id on the command line, then bind `TerminalId ↔ sessionId`
> **deterministically, with zero heuristics**. Mangled-cwd discovery is only a
> fallback for agents we did *not* spawn.

Watch `~/.claude/projects/<project-path>/` (path = cwd with non-alphanumerics →
`-`). Files:

```
~/.claude/projects/-Users-you-projects-AgentStudioIDE/
  <session-id>.jsonl                                   ← parent session
  <session-id>/subagents/agent-<agent-id>.jsonl        ← each sub-agent
```

Parsing rules:

> ⚠️ **Checked against real transcripts.** Each rule below was verified against a
> large sample of transcripts in `~/.claude/projects/` (see
> [`testing-strategy.md`](./testing-strategy.md) for the reproduction). The obvious
> readings — the spawn tool is `TaskCreate`, the tree is the directory nesting — are
> wrong and would produce a broken fan-out. **Do not "simplify" these back.**

- Each JSONL line has `type`, `timestamp`, `sessionId`, `cwd`, `gitBranch`.
- ✅ **The spawn tool is `Agent` — NOT `TaskCreate`.** Verified: both
  `"name":"Agent"` and `"name":"TaskCreate"` occur, and **every `TaskCreate` call
  carries a `subject` field** — it is an unrelated **to-do tool**. A parser
  matching `TaskCreate` finds **zero real
  sub-agents and one phantom per to-do item**.
- ✅ **`isSidechain: true` is real** and marks sub-agent lines.
- ✅ **Undocumented `.meta.json` sidecars** sit beside sub-agent
  transcripts carrying exactly `agentType`, `description`, `toolUseId`,
  **`spawnDepth`**. This is a cleaner primary source *and* gives a second,
  independent edge derivation to cross-check the tree against.
- ❌ **Linkage is NOT by directory structure.** **Every descendant, at every depth,
  lands in the same flat `<session-id>/subagents/` dir** — directory nesting cannot
  encode the tree, so deriving edges that way renders the fan-out **flat**,
  destroying the headline feature. Use the **explicit ids** (`agentId` /
  `toolUseId`) plus `spawnDepth` from the
  sidecars. **Pin the exact JSON paths with fixtures in the parser's tests** rather
  than trusting this prose.
- ✅ **Recursion is confirmed in real data**, not hypothetical: `spawnDepth`
  takes both **1 and 2** — sub-agents really do spawn sub-agents. The product
  thesis holds.
- Status is inferred from message recency (writing & last msg < 30 s ⇒ `running`;
  final assistant msg ⇒ `done`; `StopFailure`/permission denial ⇒ `error`; open
  interactive prompt ⇒ `waiting_input`).

### 5.3 The `AgentAdapter` seam

The tailer sits behind a trait so other runtimes (aider, codex, custom) plug in
their own detector without touching the core. Claude-specific code is
confined to `agent/claude.rs`.

```rust
pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;                                   // "claude-code"
    /// Command + args to launch this runtime in a PTY.
    fn spawn_spec(&self, cwd: &Path, prompt: Option<&str>) -> SpawnSpec;
    /// Start watching this agent's telemetry; push FanoutDelta as sub-agents appear.
    fn start_fanout_tailer(&self, agent_id: AgentId, cwd: &Path,
                           tx: mpsc::Sender<SupervisorMsg>) -> tokio::task::JoinHandle<()>;
    /// Derive status (running / waiting_input / done / error) from a telemetry line.
    fn status_hint(&self, line: &serde_json::Value) -> Option<AgentStatus>;
}
```

The tailer detects a spawn → sends `SupervisorMsg::FanoutDelta { parent, child:
AgentNode }` → the supervisor upserts the node and `app.emit("agent://event",
AgentEvent::SubagentSpawned{..})`.

### 5.4 End-to-end: a sub-agent becomes a live left-rail node

```
Rust: portable-pty runs `claude` ──bytes──► ipc::Channel ──► xterm.write()  (center pane)
Rust: agent/claude.rs tails <session>/subagents/*.jsonl
        detects isSidechain:true + new agentId
   ──► SupervisorMsg::FanoutDelta ──► supervisor upserts AgentNode
   ──► app.emit("agent://event", { t:'subagent_spawned', parentId, childAgentId, … })
UI:   bridge.ts listen('agent://event') ──► agentActions.spawnChild(ev)
   ──► agents[child] = …;  agents[parent].childIds.push(child)
UI:   <AgentNode> for parent re-renders ──► new child row animates in   ← HEADLINE
Rust: notify sees the sub-agent write files ──► fs://change ──► FileTree updates (right rail)
```

Everything is decoupled: bytes → emulator, telemetry → agent map, FS →
workspace tree; the three planes never block each other. **Adopted from prior
art for the tree:** bubble a "needs input" badge **up the ancestor
chain** so a blocked deep descendant is visible from a collapsed trunk;
peek-without-attach on hover/select; depth-aware collapse/expand + roll-up status
on collapsed subtrees.

---

## 6. Cross-platform notes

Must-do items per WebView. The big risk is **Linux WebKitGTK**;
macOS/Windows are the good cases.

**Linux — WebKitGTK (highest risk):**
- ⚠️ **Renderer: attempt WebGL → DOM on every platform, with no Linux
  special-case.** There is no Canvas rung: `@xterm/addon-canvas` is abandoned and
  unusable on xterm 6. WebKitGTK masks the GPU string and its WebGL2 context can be
  silently software-backed or throw `Context lost` — but that is a *speed*, not a
  *correctness*, problem: creation failure throws synchronously → DOM instantly,
  and software WebGL (SwiftShader) was verified to render correctly. Context loss
  costs ~3s stalled (xterm waits for restore) and then lands on the **slow DOM
  path** — so the env workarounds below matter more than before.
  `setRendererPreference('dom')` is the override lever; the Ubuntu/NVIDIA gate is
  where real data can overturn this.
- Ship these env workarounds **conditionally** (detect NVIDIA / failed first
  paint; they slow the good path), set before `tauri::Builder`:
  ```rust
  #[cfg(target_os = "linux")] {
      std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
      std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
      // last resort for silent crash on resize:
      // std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
  }
  ```
- End users need `libwebkit2gtk-4.1`; declare it in `.deb`/`.rpm`. Watch inotify
  `fs.inotify.max_user_watches`; watch lazily (only expanded dirs) and always
  ignore `.git/`, `node_modules/`, `target/`.

**Windows — WebView2 + ConPTY:** WebView2 is fast and WebGL works (good case);
bundle the Evergreen bootstrapper for older machines. PTY = ConPTY via
`portable-pty` (transparent); it injects its own resize/repaint sequences and
handles newlines slightly differently — **test `claude`'s TUI (boxes, status
lines) explicitly on Windows.** Requires Win 10 1809+.

**macOS — WKWebView:** WebGL works well; cleanest of the three. PTY via forkpty
(reference path). Apple Developer ID cert + notarization required for
distribution.

**Electron fallback gate:** **Benchmark M1 (one terminal) and an M3
fleet on a mid-range Ubuntu/NVIDIA box before committing past M2.** Staged
fallback, cheapest first: (1) force DOM on Linux (`setRendererPreference('dom')`
— note this rung is weaker now that Canvas is gone, so step 2 carries more weight);
(2) virtualize offscreen
terminals, lower flush rate, cap scrollback; (3) move the byte plane to a
`127.0.0.1` websocket (the transport is swappable behind `openTerminal`); (4) swap
the webview; (5) **Electron** — last resort; the Rust PTY/supervisor core is
reusable via a sidecar behind the same Channel-vs-websocket seam, so the port cost
is the shell, not the engine. Keep the transport seam abstract until the gate.

---

## 7. M0 scaffold recipe (copy-pasteable)

Scaffolds Tauri v2 + React + TS non-interactively on macOS. **Package manager =
npm.** The repo root already contains `docs/` and
`.git/`, and `create-tauri-app` wants an empty target dir, so we scaffold into a
temp subdir and lift the app files up.

```bash
cd /Users/you/projects/AgentStudioIDE

# 1. Scaffold into a temp dir (fully non-interactive)
npm create tauri-app@latest agent-studio-scaffold -- \
  --template react-ts \
  --manager npm \
  --identifier com.agentstudio.app \
  --yes

# 2. Lift the generated app files into the repo root (preserve docs/ and .git/)
rsync -a --exclude node_modules agent-studio-scaffold/ ./
rm -rf agent-studio-scaffold

# 3. Install JS deps + Tauri CLI (from the scaffolded package.json)
npm install

# 4. Frontend deps (§4)
npm i @xterm/xterm @xterm/addon-fit @xterm/addon-webgl @xterm/addon-canvas \
      @xterm/addon-web-links @xterm/addon-serialize \
      zustand immer allotment \
      codemirror @codemirror/view @codemirror/state @uiw/react-codemirror

# 5. Rust deps (§3) — run inside src-tauri/
( cd src-tauri && \
  cargo add portable-pty@0.9 && \
  cargo add tokio@1 --features rt-multi-thread,macros,sync,io-util,process,time && \
  cargo add bytes@1 notify@8 notify-debouncer-full@0.7 ignore@0.4 \
            serde@1 serde_json@1 ulid@1 anyhow@1 thiserror@1 && \
  cargo add serde --features derive && \
  cargo add tauri-plugin-fs@2 )

# 6. Run the app (opens the native window with the 3-pane shell)
npm run tauri dev
```

**Resulting tree (top level after step 2):**

```
Agent Studio/
├─ index.html
├─ package.json          # has "tauri" script + @tauri-apps/cli
├─ vite.config.ts
├─ tsconfig.json
├─ src/                  # React app (main.tsx, App.tsx) — replace with §4 structure incrementally
├─ src-tauri/            # Rust crate (Cargo.toml, tauri.conf.json, src/main.rs, src/lib.rs)
├─ public/
└─ docs/                 # untouched (design/*)
```

**First files to add — the empty 3-pane shell.** Replace the generated
`src/App.tsx` and `src/App.css`:

```tsx
// src/App.tsx — static 3-column shell; no logic yet (M0 acceptance = it boots to this)
export default function App() {
  return (
    <div className="app-shell">
      <aside className="left-rail">Agents</aside>
      <main className="center">Work area</main>
      <aside className="right-rail">Workspace</aside>
    </div>
  );
}
```

```css
/* src/App.css — dark, monospace, 3-col grid. Two resizable rails come in M1. */
:root { color-scheme: dark; --bg-app:#0d1117; --bg-surface:#161b22;
        --text:#c9d1d9; --border:#21262d; --accent:#3b82f6;
        --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg-app); color: var(--text); font-family: var(--mono); }
.app-shell { display: grid; grid-template-columns: 260px 1fr 300px; height: 100vh; }
.left-rail, .right-rail { background: var(--bg-surface); padding: 12px;
                          overflow: auto; }
.left-rail  { border-right: 1px solid var(--border); }
.right-rail { border-left:  1px solid var(--border); }
.center { padding: 12px; overflow: auto; }
```

Import `./App.css` from `App.tsx` (or `main.tsx`). **M0 acceptance:** `npm run
tauri dev` opens a native window showing three dark columns.

---

## 8. Build order (work items → milestones)

Maps the v1 milestones. Each milestone is a vertical increment, not a layer.

| Milestone | Work items | Deliverable |
|---|---|---|
| **M0 — Scaffold** | §7 recipe; `model.rs` stub; CSS-var theme tokens; GitHub Actions matrix (mac/win/ubuntu) building signed-ish artifacts; Linux env workarounds (§6). | App boots to the empty 3-pane shell on macOS; CI green on 3 OSes. |
| **M1 — Terminals** | `pty/` + `stream/` (portable-pty reader thread → bounded mpsc → coalescer → `ipc::Channel`); `useTerminal` + `TerminalRegistry` (§4); tabs; `PaneTree` + `allotment` splits. **← §6 Linux/NVIDIA benchmark gate here.** | One real PTY terminal in the center; input/output/resize; tabs; H/V splits. |
| **M2 — Agents** | `supervisor/` actor + registry; `agent/adapter.rs` + `agent/claude.rs` `spawn_spec`; left rail (`AgentTree`/`AgentNode`, status pills, `branch • cwd`); `workspace/` watch + `read_dir`; `selectAgent` pivot re-points center + right rail. | "New agent" opens a `claude` terminal in a chosen cwd; right-rail file tree follows selection. |
| **M3 — Fan-out** 🌟 | `agent/claude.rs` transcript tailer → `FanoutDelta` → `agent://event`; `spawnChild` reducer; recursive live tree render; status roll-up + "needs input" bubbling; peek-on-hover. (Optional hooks HTTP listener.) | Spawned sub-agents appear as live recursive left-rail nodes; selecting one shows its activity. **The headline.** |
| **M4 — Editor & Find** | `editor/` CodeMirror 6 tab (lazy `lang-*`, large-file guard, save); `workspace/fs.rs` `run_find` (ripgrep via `ignore`); `FindPanel`. | Open a file from the tree, syntax-highlight, save; project search. |

**Deferred (post-v1):** Vault tab, multi-runtime
adapters, persistence/re-attach, auto-update & code-signing, worktree-per-agent
isolation as default, full theming polish.

---

## 9. Open risks & contradictions

**Settled choices** (made in this doc; listed so they are not reopened):

1. **`Session` semantic clash** — `Session` could mean one PTY or a UI layout
   container. → Rust PTY unit is **`Terminal`**; `Session` is UI-only (§2.0).
2. **PTY id type** — `ptyId: number` vs `SessionId = ulid`. → all ids are
   **ULID strings**; the `TerminalId` *is* the handle (§2.1).
3. **Command names** — `pty_subscribe/pty_write/pty_resize/spawn_agent` vs
   `terminal_open/terminal_write/terminal_resize`. → canonical `terminal_*` +
   `agent_spawn` (§2.4).
4. **Event names** — `fleet:node-added` etc. vs `agent://event`/`fs://change`.
   → **`agent://event`** + **`fs://change`**, one tagged payload each (§1, §2.2).
5. **Status enum** — `WaitingForInput`/`Error(String)` vs `waiting_input`/`error`.
   → snake_case string union + separate optional `error` field (§2.2, §2.5).
6. **Split-pane library** — `allotment` vs `dockview`. → **own the tree
   + `allotment`**, dockview only as fallback (§4).

**Open design questions** (none block M0–M3):

- **Vault tab** — secrets / saved prompts / MCP configs. Shipped as a stub
  `VaultPanel` in v1.
- **Per-pane toolbar icon semantics** — the ~4-icon top-right cluster
  (view/new-tab · open-in-browser · split-V · split-H/close) is to be settled
  before wiring actions.
- **Sub-agent panes** — v1 sub-agents are **read-only telemetry nodes** (Claude
  sub-agents run in-process, no own PTY). The model already accommodates giving
  them a `sessionId` later so the `selectAgent` pivot Just Works — decide if/when
  they get their own terminal.
- **Persistence / re-attach** (a hard requirement, but deferred to
  post-v1) — the store is JSON-serializable by construction (ids + metadata, no
  live handles); on restart, `fleet_snapshot` re-attaches to live PTYs. Confirm
  the persistence store (`tauri-plugin-store`) and offset-file scheme
  (`.agent-studio-offsets.json`) before M-persistence.
- **Isolation model** — prior art shows **git-worktree-per-agent** is the
  near-universal expectation; adopt as the default (post-v1), with optional
  container isolation for untrusted code. Not in the M0–M4 slice.

**Standing technical risks** (ranked; mitigations in-doc):

1. **Linux WebKitGTK perf/stability** for a WebGL-terminal app → Canvas fallback +
   §6 staged plan; **gate at M1**.
2. **Many-PTY resource use** → actor + bounded channels + offscreen virtualization;
   watch thread counts (consolidate waiters into one poll loop if the fleet grows).
3. **Binary-safe high-throughput streaming** → raw-bytes `Channel` + Rust-side
   coalescing (§1 hot plane); the one thing to get exactly right.
