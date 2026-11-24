/**
 * THE CONTRACT — canonical shared types.
 *
 * Source of truth: docs/design/ARCHITECTURE.md §2. Mirrored in Rust in
 * src-tauri/src/model.rs (serde: structs camelCase, enums snake_case).
 *
 * Do not fork these types into feature modules. If a shape must change, change
 * it here AND in model.rs AND note it in ARCHITECTURE.md §2.
 *
 * Wire types cross the Rust<->JS boundary. UI-only types never do.
 */

/* ────────────────────────── identifiers ────────────────────────── */

type Brand<K, T> = K & { readonly __brand: T };

export type AgentId = Brand<string, "AgentId">; // fan-out node (ULID or Claude agentId)
export type TerminalId = Brand<string, "TerminalId">; // 1:1 with a Rust PTY handle (ULID)
export type SessionId = Brand<string, "SessionId">; // UI layout container (client-only)
export type PaneId = Brand<string, "PaneId">;
export type TabId = Brand<string, "TabId">;
export type EditorDocId = Brand<string, "EditorDocId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type WsNodeId = Brand<string, "WsNodeId">;

/** Cast helpers — ids are opaque strings at runtime. */
export const asTerminalId = (s: string) => s as TerminalId;
export const asAgentId = (s: string) => s as AgentId;
export const asPaneId = (s: string) => s as PaneId;
export const asTabId = (s: string) => s as TabId;

/* ──────────────────── wire types (Rust <-> UI) ──────────────────── */

export type AgentStatus = "idle" | "running" | "waiting_input" | "done" | "error";
export type AgentKind = "orchestrator" | "subagent";

/**
 * A fan-out tree node **as Rust sends it** — mirrored by the serde struct in
 * `src-tauri/src/model.rs`.
 *
 * This is deliberately split from `AgentNode`. The fields below the line in the
 * store version are client-only and Rust *cannot* populate them; declaring them
 * required on the wire was a lie that surfaces as a runtime `undefined`, not a
 * type error. If it isn't in this interface, Rust never sent it.
 */
export interface AgentNodeWire {
  id: AgentId;
  parentId: AgentId | null; // null => root orchestrator
  kind: AgentKind;
  title: string;
  status: AgentStatus;
  branch: string;
  cwd: string;
  runtime: string; // AgentAdapter id, e.g. "claude-code"
  startedAt: number | null;
  finishedAt: number | null;
  lastActivityAt: number;
  error?: string;
}

/**
 * A fan-out tree node **as the store holds it**: the wire shape plus the fields
 * only the client can know. Hydrate wire → store at the ONE boundary (bridge /
 * fleet_snapshot). Never assume Rust sent these.
 */
export interface AgentNode extends AgentNodeWire {
  childIds: AgentId[]; // derived from parentId edges; ordered
  sessionId: SessionId | null; // root agents own a Session; sub-agents null in v1
  expanded: boolean; // AgentTree disclosure
  unread: number; // notifications attributable to this agent
  /**
   * User's custom name for this agent, or null to use the derived `title`.
   * Client-only (never on `AgentNodeWire`); `hydrateAgent` preserves it across
   * re-snapshots so a Rust title/status update never wipes it. Shown in the rail
   * row AND the agent's center tab — one custom name per agent.
   */
  customTitle?: string | null;
  /**
   * Whether the user pinned this ROOT agent for restore-on-restart.
   * Client-only (never on `AgentNodeWire`): the durable source of truth is
   * Rust's pin registry (`pinned-agents.json`, read via `pinned_agents()`); this
   * flag is the store's in-session mirror, exactly as `recentProjects` mirrors
   * the persisted recents. `hydrateAgent` preserves it across re-snapshots like
   * `customTitle`/`expanded` (`prev?.pinned ?? false`, no wire fallback), so a
   * stale re-snapshot can never flip a pin the user set (or one seeded at boot by
   * `applyPinnedAgents`). Only ever true for a root orchestrator — sub-agents are
   * transcript-derived and re-materialize for free once the root resumes.
   */
  pinned?: boolean;
  /**
   * How this ROOT came back after Agent Studio restarted — the "Resumed after restart"
   * marker (phase 1 of "agents survive a restart", `src-tauri/src/open_agents.rs`).
   * Client-only like `pinned`: seeded once at boot from `restored_agents()`
   * (`applyRestoredAgents`), preserved across re-snapshots by `hydrateAgent`, and
   * cleared at the agent's next turn (`running`) or its end (`exited`) — the same
   * moments Rust drops it, so a webview reload re-reads the same truth. `null`/absent:
   * not a restored agent, or the marker has done its job.
   */
  restored?: RestoredMarker | null;
}

/**
 * The rung of the restore ladder (docs/design/agent-restart-restore.md) a restored agent
 * came back on: `resumed` — the same conversation (`claude --resume`); `fresh` — a new
 * conversation in the same folder (the old one was never saved); `dormant` — not
 * re-launched (its folder is gone, or it would not start), shown ended until the user
 * closes it.
 */
export type RestoreOutcome = "resumed" | "fresh" | "dormant";

/** See `AgentNode.restored`. */
export interface RestoredMarker {
  outcome: RestoreOutcome;
  /**
   * `true`: it was mid-turn when Agent Studio closed — the quit interrupted it, and only
   * the user can tell it to continue (nothing is ever sent on their behalf). `false`:
   * it was idle. `null`: the app did not close cleanly, so nobody knows.
   */
  wasWorking: boolean | null;
}

/** The ONLY telemetry payload on the `agent://event` channel. Used from M3. */
export type AgentEvent =
  | {
      t: "agent_started";
      agentId: AgentId;
      parentId: AgentId | null;
      title: string;
      cwd: string;
      branch: string;
      runtime: string;
    }
  | {
      t: "subagent_spawned";
      parentId: AgentId;
      childAgentId: AgentId;
      title: string;
      cwd: string;
      branch: string;
      runtime: string;
    }
  | { t: "status"; agentId: AgentId; status: AgentStatus }
  | { t: "activity"; agentId: AgentId; at: number }
  | { t: "exited"; agentId: AgentId; code: number }
  | { t: "title"; agentId: AgentId; title: string };

export type TerminalKind = "agent-terminal" | "terminal";
export type TerminalStatus = "live" | "exited";

/** PTY metadata — never bytes. Returned by terminal_open. */
export interface TerminalMeta {
  id: TerminalId;
  kind: TerminalKind;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exitCode?: number;
  agentId?: AgentId;
}

/**
 * Returned by `fleet_snapshot` — the whole fleet in one shot.
 *
 * Two jobs: the initial paint on startup, and re-attaching to still-live PTYs
 * after the UI restarts. It is also the ONLY way a terminal's death is
 * observable (`TerminalMeta.status`/`exitCode` are written on child exit but
 * were unreadable until this existed).
 */
export interface FleetSnapshot {
  agents: AgentNodeWire[]; // wire shape — the store hydrates these into AgentNode
  terminals: TerminalMeta[];
}

/** One row of a directory listing (right rail). Used from M2. */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export type GitStatus = "modified" | "added" | "deleted" | "untracked";

/** The ONLY payload on the `fs://change` channel. Used from M2. */
export type FsPatch =
  | { op: "created"; parentPath: string; entry: DirEntry }
  | { op: "removed"; path: string }
  | { op: "renamed"; from: string; to: string }
  | { op: "git_status"; changes: Array<{ path: string; status: GitStatus }> };

/* ─────────────────── UI-only types (never on the wire) ─────────────────── */

export type TabKind =
  | "agent-terminal"
  | "terminal"
  | "editor"
  | "agent-activity"
  | "api-request"
  | "sequence"
  | "session-picker"
  | "metrics"
  | "db-console"
  | "diff"
  | "agent-logs"
  | "network"
  | "village";

export interface Tab {
  id: TabId;
  kind: TabKind;
  title: string;
  /**
   * User's custom name for this tab, or null to use the derived `title`. For an
   * agent-terminal / agent-activity tab the custom name lives on the AGENT
   * (`AgentNode.customTitle`) so the rail row and the tab stay in lockstep —
   * this field is used only by plain terminal / editor tabs.
   */
  customTitle?: string | null;
  icon?: string;
  ref:
    | { kind: "agent-terminal"; terminalId: TerminalId; agentId: AgentId }
    | { kind: "terminal"; terminalId: TerminalId }
    // A read-only file viewer (M4). Keyed by the absolute file path — clicking a
    // file in the workspace tree opens/dedupes an editor tab by that path.
    | { kind: "editor"; path: string }
    // A sub-agent's read-only transcript view (M3). No PTY: sub-agents run
    // in-process, so selecting one reveals its activity, not a terminal.
    | { kind: "agent-activity"; agentId: AgentId }
    // A built-in API-client request. Keyed by a `requestId` into the
    // store's `api` slice — the tab carries no request data of its own.
    | { kind: "api-request"; requestId: string }
    // A list of requests run in order. Keyed by a
    // `sequenceId` into the api slice — like `api-request`, the tab carries no
    // data of its own, so it cannot go stale against the store.
    | { kind: "sequence"; sequenceId: string }
    // Past Claude sessions for a folder ("Recover session"). Keyed by the
    // folder's cwd — the picker lists `~/.claude/projects/<mangled-cwd>/*.jsonl`
    // (read-only; the app must never WRITE under `~/.claude`) and double-click resumes
    // one via the existing `resumeSessionId` spawn path.
    | { kind: "session-picker"; cwd: string }
    // The Claude metrics dashboard. A **singleton** tab — there is one set
    // of numbers about this machine, so a second one would be the same panel twice.
    // The ref carries the project root the report is scoped to; the panel hands it
    // to the metrics store, which does the (Rust-side, read-only) scan.
    | { kind: "metrics"; cwd: string | null }
    // The database client's query console. Keyed by the SAVED
    // connection's id — everything else the console needs (the engine's query language,
    // the guardrails, the live session) is read from the `db` slice by that id, so the
    // tab carries no connection data and cannot go stale against the store. One console
    // per connection: a second tab for the same connection would be the same session
    // twice, which is how a read-only badge and a running query disagree.
    | { kind: "db-console"; connectionId: string }
    // "Compare with HEAD" for one file. Keyed by the same
    // absolute path an `editor` tab is keyed by, and deduped the same way — a
    // second Compare on a file already being compared re-focuses that tab rather
    // than minting a twin. The two kinds are distinct refs on purpose: a file can
    // legitimately be open for editing AND open as a diff at the same time, and
    // one dedupe key covering both would make the second gesture steal the first
    // tab. Read-only, so it never carries `dirty` and never reaches the
    // unsaved-changes flow (which narrows on `kind === "editor"`), and it is not
    // persisted — a diff is re-openable from the tree it was launched from.
    | { kind: "diff"; path: string }
    // The fleet-wide log stream.
    // A **singleton**, like `metrics`: there is one fleet, so a second tab would be the
    // same stream twice. Carries no data — the panel reads the Rust-side ring itself.
    | { kind: "agent-logs" }
    // The capture-proxy traffic table (same design doc). Singleton for the same reason:
    // there is one proxy per app run.
    | { kind: "network" }
    // The Agent Village: every Claude Code agent on this machine as a
    // pixel-art character. A **singleton** — one machine, one village. Carries no data: the
    // panel reads the fleet from the store and polls the external scan itself.
    | { kind: "village" };
  dirty?: boolean;
}

/**
 * One entry of a sub-agent's transcript (M3, `subagent_activity`). Rendered
 * read-only, chat-style: user/assistant `text`, and `tool` name for a tool call.
 */
export interface ActivityEntry {
  role: string;
  text: string;
  tool?: string;
  timestamp: number;
}

/**
 * One entry from a directory read (M4 workspace tree). The wire shape of Rust's
 * `read_dir` command: it is security-scoped to the workspace/recent roots and
 * returns Err for a path outside them (surfaced as a calm empty state).
 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Text buffer lives in CodeMirror EditorState, never here. Used from M4. */
export interface EditorDoc {
  id: EditorDocId;
  path: string;
  language: string;
  dirty: boolean;
}

/** 'row' = side-by-side (vertical divider); 'column' = stacked. */
export type Orientation = "row" | "column";

export interface SplitNode {
  id: PaneId;
  type: "split";
  orientation: Orientation;
  children: PaneNode[];
  sizes: number[]; // sums to 1
}

export interface LeafNode {
  id: PaneId;
  type: "leaf";
  tabIds: TabId[];
  activeTabId: TabId | null;
}

/** The split-pane layout tree. */
export type PaneNode = SplitNode | LeafNode;

/** A workspace context that owns the center layout. One per root orchestrator. */
export interface Session {
  id: SessionId;
  rootAgentId: AgentId;
  workspaceId: WorkspaceId;
  layout: PaneNode;
  focusedPaneId: PaneId; // where new tabs open
  tabs: Record<TabId, Tab>;
  terminals: Record<TerminalId, TerminalMeta>;
  docs: Record<EditorDocId, EditorDoc>;
  createdAt: number;
}

/** The right-rail file tree (normalized, lazy). Used from M2. */
export interface WorkspaceTreeNode {
  id: WsNodeId;
  parentId: WsNodeId | null;
  name: string;
  path: string;
  kind: "dir" | "file";
  childIds: WsNodeId[] | null; // null => not yet loaded (lazy expand)
  loading?: boolean;
  gitStatus?: GitStatus | null;
  languageId?: string; // for the file icon (docs/design/file-icons.md)
}

export interface Workspace {
  id: WorkspaceId;
  rootPath: string;
  rootNodeId: WsNodeId;
  nodes: Record<WsNodeId, WorkspaceTreeNode>;
  expandedIds: Set<WsNodeId>;
}

/**
 * Which PERSISTENT panel the right rail shows.
 *
 * ⚠️ This union once drifted into a lie: it still read
 * `"files" | "find" | "vault"` while `store.ts` had grown `"history"` and
 * `"collections"` inline and dropped `"find"` (Find became a momentary overlay,
 * `findInFilesOpen`, so it never changes which panel is mounted). Two declarations of the
 * same set, and the one in the contract was the wrong one — `RightRailTab` was imported
 * nowhere, so nothing noticed. It is now the single declaration: `store.ts`'s `UiState` and
 * `RailTabs`' `TABS` table both read it, so a new tab cannot be added to one and not the
 * other.
 */
export type RightRailTab =
  | "files"
  | "vault"
  | "history"
  | "collections"
  /** The database client's saved-connection list. */
  | "db"
  /**
   * Self-contained developer utilities — the epoch ↔ human date converter first
   * (a small Tools tab, placed next to the database tab). Purely local: no PTY,
   * no Rust command, no network, so unlike every other panel here it has nothing
   * to go stale against. Added LAST on purpose — the
   * order of this union is the display order of `RailTabs`' strip.
   */
  | "tools"
  /**
   * Source control: working-tree changes per workspace root
   * (added / modified / deleted, the same colors the Files tree wears) and the
   * project's open GitHub pull requests with an author filter. One tab hosts both
   * views — the strip's width budget is why (see `RailTabs`' header).
   */
  | "git";

/** The single pivot: changing selectedAgentId re-points center + right rail. */
export interface Selection {
  selectedAgentId: AgentId | null;
  activeSessionId: SessionId | null; // derived: session of selected agent's root
  rightRailTab: RightRailTab;
}
