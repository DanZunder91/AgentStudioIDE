/** Canonical shared types: docs/design/ARCHITECTURE.md §2, mirrored in src-tauri/src/model.rs
 * (serde: structs camelCase, enums snake_case). Change all three together; never fork these types.
 * Wire types cross the Rust<->JS boundary; UI-only types never do. */

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

/** A fan-out tree node as Rust sends it (serde struct in `src-tauri/src/model.rs`). Client-only
 * fields live on `AgentNode`: if it isn't in this interface, Rust never sent it. */
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

/** A fan-out tree node as the store holds it: the wire shape plus client-only fields.
 * Hydrate wire → store at the ONE boundary (bridge / fleet_snapshot). */
export interface AgentNode extends AgentNodeWire {
  childIds: AgentId[]; // derived from parentId edges; ordered
  sessionId: SessionId | null; // root agents own a Session; sub-agents null in v1
  expanded: boolean; // AgentTree disclosure
  unread: number; // notifications attributable to this agent
  /** Custom name, or null for the derived `title`; shown in the rail row and the agent's tab.
   * Client-only: `hydrateAgent` preserves it across re-snapshots. */
  customTitle?: string | null;
  /** User pinned this ROOT for restore-on-restart. Client-only mirror of Rust's pin registry
   * (`pinned-agents.json`); `hydrateAgent` keeps `prev?.pinned ?? false` so a re-snapshot never
   * flips a pin. Never set on sub-agents: they re-materialize once the root resumes. */
  pinned?: boolean;
  /** How this ROOT came back after a restart (`src-tauri/src/open_agents.rs`). Client-only: seeded
   * at boot (`applyRestoredAgents`), kept by `hydrateAgent`, cleared on the next `running` or
   * `exited` exactly when Rust drops it. null/absent: not restored, or the marker is done. */
  restored?: RestoredMarker | null;
}

/** Restore-ladder rung (docs/design/agent-restart-restore.md): `resumed` = same conversation,
 * `fresh` = new conversation in the same folder, `dormant` = not relaunched, shown ended. */
export type RestoreOutcome = "resumed" | "fresh" | "dormant";

/** See `AgentNode.restored`. */
export interface RestoredMarker {
  outcome: RestoreOutcome;
  /** true: mid-turn at quit; only the user may tell it to continue (nothing is sent for them).
   * false: idle. null: the app did not close cleanly, so unknown. */
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

/** The whole fleet in one shot: startup paint and re-attach to live PTYs after a UI restart.
 * Also the only way a terminal's death (`TerminalMeta.status`/`exitCode`) is observable. */
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
  /** Custom tab name, or null for `title`. Plain terminal / editor tabs only: agent tabs use
   * `AgentNode.customTitle` so the rail row and the tab stay in lockstep. */
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
    // Past Claude sessions for a folder ("Recover session"): lists
    // `~/.claude/projects/<mangled-cwd>/*.jsonl` read-only (never WRITE under `~/.claude`);
    // double-click resumes one via `resumeSessionId`.
    | { kind: "session-picker"; cwd: string }
    // Claude metrics dashboard; a singleton tab (one set of numbers per machine).
    // `cwd` scopes the report; the metrics store does the read-only Rust-side scan.
    | { kind: "metrics"; cwd: string | null }
    // Database query console, keyed by the SAVED connection id; everything else is read from the
    // `db` slice, so the tab cannot go stale. One console per connection (one session).
    | { kind: "db-console"; connectionId: string }
    // "Compare with HEAD" for one file: keyed and deduped by absolute path like `editor`, but a
    // distinct kind so a file can be open for editing AND as a diff. Read-only (no `dirty`, never
    // in the unsaved-changes flow) and not persisted.
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

/** One sub-agent transcript entry (`subagent_activity`), rendered read-only, chat-style. */
export interface ActivityEntry {
  role: string;
  text: string;
  tool?: string;
  timestamp: number;
}

/** One `read_dir` entry. Rust scopes `read_dir` to the workspace/recent roots and errs outside
 * them (shown as a calm empty state). */
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

/** Which persistent panel the right rail shows; the single declaration (`store.ts`'s `UiState`
 * and `RailTabs`' `TABS` read it). Union order is the display order of `RailTabs`' strip. */
export type RightRailTab =
  | "files"
  | "vault"
  | "history"
  | "collections"
  /** The database client's saved-connection list. */
  | "db"
  /** Self-contained developer utilities (epoch ↔ date converter): no PTY, Rust or network. */
  | "tools"
  /** Source control: working-tree changes per root plus the project's open GitHub PRs. One tab
   * hosts both because of the strip's width budget (see `RailTabs`' header). */
  | "git";

/** The single pivot: changing selectedAgentId re-points center + right rail. */
export interface Selection {
  selectedAgentId: AgentId | null;
  activeSessionId: SessionId | null; // derived: session of selected agent's root
  rightRailTab: RightRailTab;
}
