/** The Zustand store (ARCHITECTURE §4: Zustand + Immer + `subscribeWithSelector`), written
 * imperatively from Rust event callbacks (bridge.ts) via `getState()`/`setState()`, no Provider.
 * Reducers are pure over a `LayoutState` draft; types come from `./types`, never redefined. */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { current, enableMapSet, isDraft } from "immer";

// Lets immer produce over `Set`/`Map` state — used by `collapsedFolders`.
// One-time, idempotent global registration.
enableMapSet();

// This store owns tab lifetime: `configureTerminal` hands the cwd to whatever mounts the terminal;
// `dispose` on final close (unmount only detaches), or the xterm and PTY leak.
// Effects live in the action wrappers only; the reducers stay pure.
import {
  configureTerminal,
  dispose,
  setDefaultTerminalCwd,
} from "../features/terminal";
import type { TerminalSpawnOptions } from "../features/terminal";
// A background editor tab has no mounted <CodeEditor> to dispose its buffer, so closing it must
// dispose here, or reopening that path shows "Loading…" forever.
import { disposeEditorBuffer } from "../features/editor";
import { terminalsBusy, type BusyTerminal } from "../features/terminal/terminalBusyIpc";
import {
  asAgentId,
  asPaneId,
  asTabId,
  asTerminalId,
  type AgentEvent,
  type AgentId,
  type AgentNode,
  type AgentNodeWire,
  type LeafNode,
  type Orientation,
  type PaneId,
  type PaneNode,
  type RightRailTab,
  type Selection,
  type Tab,
  type TabId,
  type TerminalId,
  type TerminalMeta,
} from "./types";
// Pure path logic for "reveal active file in the Files tree" (IntelliJ's
// "Select Opened File" crosshair). `rootContaining` picks the longest
// root that owns a path, so `revealActiveFile` can un-collapse the right folder.
import { rootContaining } from "./revealPath";
// The API client's response wire type. Type-only, so this pulls in
// no runtime dependency on the feature — the store just holds the last response.
import type { HttpResponse } from "../features/api/httpIpc";
// The gRPC lane's wire types (native tonic). Type-only —
// the store holds the reflected schema and the last unary response.
import type { GrpcResponse, GrpcSchema } from "../features/api/grpcIpc";
// The parsed shape of an imported cURL command. Type-only.
import type { ParsedCurl } from "../features/api/curlParse";
export type {
  GrpcMetadata,
  GrpcMethodInfo,
  GrpcRequest,
  GrpcResponse,
  GrpcSchema,
  GrpcServiceInfo,
} from "../features/api/grpcIpc";
// `saveApiStore` is the effect the collection/environment wrappers run, never inside a `set`
// producer. The wire types are type-only.
import {
  createApiFolder as createApiFolderIpc,
  deleteApiFolder as deleteApiFolderIpc,
  moveRequestToFolder as moveRequestToFolderIpc,
  readApiStore,
  renameApiFolder as renameApiFolderIpc,
  reorderApiFolders as reorderApiFoldersIpc,
  saveApiStore,
} from "../features/api/apiStoreIpc";
import type {
  ApiFolder,
  ApiStore,
  Environment,
  SavedRequest,
} from "../features/api/apiStoreIpc";
// Re-exported so consumers (the view, tests) can pull the durable-store wire
// types from the store surface alongside the slice types.
export type {
  ApiFolder,
  ApiStore,
  Environment,
  EnvVar,
  SavedRequest,
} from "../features/api/apiStoreIpc";
// The persisted request HISTORY. Same effect-in-wrapper shape as
// `saveApiStore`: `saveApiHistory` is the persistence effect the record/clear
// action wrappers run, never inside a `set` producer. Wire types are type-only.
import { saveApiHistory } from "../features/api/historyIpc";
import type { HistoryEntry, HistoryStore } from "../features/api/historyIpc";
export type { HistoryEntry, HistoryStore } from "../features/api/historyIpc";
// `addBrowseRoot` records a picker-opened folder in recents because `read_dir`'s allowed_roots are
// recents ∪ workspace root; best-effort, never blocks opening the folder.
import { ensureAgentHooks, pushRecentProject } from "../features/fleet/fleetIpc";
import {
  DEFAULT_RAIL_GROUP_STYLE,
  parseRailGroupStyle,
  type RailGroupStyle,
} from "../features/fleet/railGroupStyle";
// Pin registry effects, aliased to avoid the `pinAgent`/`unpinAgent` action names; run in wrappers,
// never in a producer. Both swallow their own failure.
import {
  pinAgent as persistPin,
  unpinAgent as persistUnpin,
} from "../features/fleet/fleetIpc";
import type { PinnedAgentView, RestoredAgentView } from "../features/fleet/fleetIpc";
export type { PinnedAgentView, RestoredAgentView } from "../features/fleet/fleetIpc";
// `saveLayoutPrefs` is the effect the reorder/collapse/view wrappers run, never in a producer.
import { saveLayoutPrefs } from "./layoutPrefsIpc";
import type {
  LayoutPrefs,
  PersistedPane,
  PersistedTerminal,
  PersistedView,
} from "./layoutPrefsIpc";
export type { LayoutPrefs } from "./layoutPrefsIpc";
// A tab's identity across OS windows (tab tear-off). Dependency-free (types only), so the
// open actions can ask "does another window hold this?" in the same words the hand-off uses.
import { tabKey } from "./tearoff/contract";
// The pure folder-ordering primitives shared by BOTH rails. Kept in a
// dependency-free module so the left rail's `flattenFleet` and this store's
// `workspaceRoots` cannot disagree about folder order.
import { appendMissing, moveBefore, orderFolders } from "./folderOrder";
// The DB store is written by Rust, so an "upsert" IS the IPC call and its returned record lands
// here. Every one runs in an action wrapper, never inside a `set` producer.
import {
  connectionInput,
  dbChildren,
  dbCancel,
  dbClose,
  dbConnectionDelete,
  dbConnectionUpsert,
  dbConnectionsLoad,
  dbEngines as loadDbEngines,
  dbOpen,
  dbQuery,
  dbSavedQueries,
  dbTreeOrder,
  dbTreeOrderSet,
  dbSavedQueryDelete,
  dbSavedQueryUpsert,
} from "../features/db/dbIpc";
import type {
  DbNodeRefWire,
  DbTreeNode,
  SavedQueryRecord,
} from "../features/db/dbIpc";
import type { DbLevelOrder } from "../features/db/types";
import type { SortState as GridSortState } from "../features/db/console/sortRows";

/** A results grid's remembered view. `columns` is the column signature it was taken from: a sort
 * is an index, so a re-run with different columns must not restore it. */
export interface GridView {
  sort: GridSortState | null;
  widthPx: Record<number, number>;
  columns: string[];
}
// Shared with `<DbTree/>` so both apply one order (the store's copy is persisted). `moveBefore` is
// aliased: unlike `app/folderOrder`'s, dropping a row onto itself is a no-op.
import {
  applyOrder,
  moveBefore as moveTreeNodeBefore,
  sameOrder,
} from "../features/db/treeOrder";
// The tree's pure logic — cache addressing and the blank-state factories. Imported rather
// than re-derived so the store and `<DbTree/>` can never disagree about a node's key, which
// would show up as a level that loads and then renders nowhere.
import {
  blankDbTree,
  blankSavedQueryList,
  isServerAnswered,
  nodeKey,
  type DbSavedQueryListState,
  type DbTreeState,
} from "../features/db/dbTreeFormat";
// The rejection → one-honest-sentence mapper. A raw driver string can contain the DSN it
// dialled, and therefore a password, so no db failure reaches state unmapped.
import {
  dbErrorMessage,
  dbFailure,
  describeDbFailure,
  splitDbError,
  type DbFailure,
} from "../features/db/dbErrors";
// The console's own split clamp, imported so the store cannot drift from the divider it
// is storing the position of.
import { clampSplit } from "../features/db/console/consoleFormat";
// Same pattern for the markdown preview's zoom: the preview's own clamp + default,
// so store and UI can never disagree about the zoom bounds.
import {
  PREVIEW_ZOOM_DEFAULT,
  clampPreviewZoom,
} from "../features/editor/previewZoom";
// The one shared piece of dialog copy the store needs: what to say when a test failed and
// the mapper had nothing at all to report.
import type {
  DbConnection,
  DbConnectionDraft,
  DbConnectionStore,
  DbResultSet,
  DbRunMode,
  DbSessionId,
  EngineSpec,
} from "../features/db/types";
// Re-exported so consumers (the panel, its tests) can pull the db wire types from the
// store surface alongside the slice types, exactly as the API store's are.
export type {
  DbConnection,
  DbConnectionDraft,
  DbConnectionStore,
  DbResultSet,
  DbRunMode,
  DbSessionId,
  EngineSpec,
} from "../features/db/types";
// Config bundles: each action is an IPC call plus a reduction (Rust reads and writes the file);
// always in a wrapper, never inside a `set` producer.
import {
  importChoices,
  pickBundleDestination,
  pickBundleSource,
  portabilityExport,
  portabilityImport,
  portabilityInspect,
} from "../features/portability/portabilityIpc";
// The rejection → one-honest-sentence mapper. A bundle is untrusted input that arrived by
// email, so its own text must never reach the UI (see that file's header).
import {
  describePortabilityError,
  portabilityErrorMessage,
} from "../features/portability/portabilityErrors";
import type {
  BundleHeader,
  ExportOptions,
  ImportAction,
  ImportPlan,
  ImportResult,
} from "../features/portability/types";
// Re-exported so the dialogs can pull the bundle wire types from the store surface alongside
// the slice types, exactly as the db and api ones are.
export type {
  Bundle,
  BundleCounts,
  BundleHeader,
  BundleMode,
  ExportOptions,
  ImportAction,
  ImportChoices,
  ImportItem,
  ImportPlan,
  ImportResult,
  PortabilityErrorCode,
} from "../features/portability/types";

/** The AgentAdapter id to spawn; the frontend names a runtime, never how to launch it
 * (`agent/claude.rs` owns the spawn spec). */
const DEFAULT_RUNTIME = "claude-code";

/** PURE: everything `layout-prefs.json` holds (rail prefs and the center layout), read off the
 * store. Exported so tests can assert the blob without the IPC spy. */
export function layoutPrefsBlob(s: AppStore): LayoutPrefs {
  // Plus the agent terminals another OS window shows: this window is the only one that
  // writes the file, so it keeps them — and their names — for them (`provideHeldElsewhere`).
  const center = serializeCenterLayout(s, heldElsewhere());
  return {
    folderOrder: [...s.folderOrder],
    collapsedFolders: [...s.collapsedFolders],
    collapsedRoots: [...s.collapsedRoots],
    focusFollowsAgent: s.focusFollowsAgent,
    railGroupStyle: s.railGroupStyle,
    collapsedApiFolders: [...s.collapsedApiFolders],
    views: center.views,
    activeViewId: center.activeViewId,
  };
}

/** Persist layout prefs (best-effort; the next mutation re-saves). Every action that changes the
 * blob calls it in its wrapper, except `resizePane`: allotment fires per drag frame, so sizes ride
 * along on the next persisting mutation. */
function persistLayoutPrefs(get: () => AppStore): void {
  void saveLayoutPrefs(layoutPrefsBlob(get()));
}

/** PURE: every folder in `roots` collapsed except `keep` (null or absent collapses all). */
export function collapseAllBut(
  roots: readonly string[],
  keep: string | null,
): Set<string> {
  return new Set(roots.filter((path) => path !== keep));
}

/** When `focusFollowsAgent` is on, collapse every folder except the selected agent's root cwd in
 * both rails (`collapsedRoots` right, `collapsedFolders` left), then persist. No-op when off,
 * nothing is selected, or no cwd resolves. A wrapper effect, outside any producer. */
function applyFocusFollow(): void {
  const s = useAppStore.getState();
  if (!s.focusFollowsAgent) return;
  const selected = s.selection.selectedAgentId;
  if (!selected) return;
  const keep = rootOf(s.agents, selected)?.cwd ?? null;
  if (keep === null) return;
  // Right rail (Files) — one root per unique folder path (incl. opened browse roots).
  const collapsedRoots = collapseAllBut(workspaceRoots(s), keep);
  // Left rail (Agents) — folder groups keyed by the distinct cwds of the ROOT agents,
  // the exact grouping `flattenFleet` builds. Same "all but the kept folder" rule, so
  // selecting an agent focuses its folder in the Agents rail too, not only in Files.
  const agentCwds = s.rootAgentIds
    .map((id) => s.agents[id]?.cwd)
    .filter((cwd): cwd is string => cwd !== undefined);
  const collapsedFolders = collapseAllBut(agentCwds, keep);
  useAppStore.setState((d) => {
    d.collapsedRoots = collapsedRoots;
    d.collapsedFolders = collapsedFolders;
  });
  persistLayoutPrefs(useAppStore.getState);
}

/** Effects on the select-agent gesture only (a rail click), not any selection change: removing
 * the selected agent re-points selection without the user asking. Tear-off uses it to bring the
 * window holding that terminal forward. Run in the wrapper, after the producer. */
const agentSelectedHooks = new Set<(agentId: AgentId) => void>();

/** Run `hook` after every `selectAgent`. Returns the unsubscribe. */
export function onAgentSelected(hook: (agentId: AgentId) => void): () => void {
  agentSelectedHooks.add(hook);
  return () => {
    agentSelectedHooks.delete(hook);
  };
}

/** Tear-off seams from `app/tearoff/boot.ts`, inert until installed. `routeOpen`: opening a tab
 * another window holds brings it forward (`TAB_ELSEWHERE`), never a second live writer.
 * `heldElsewhere`: terminal ids other windows show, kept in `layoutPrefsBlob` with their names. */
export type OpenRouter = (key: string, openHere: () => void) => boolean;
const notRouted: OpenRouter = () => false;
let routeOpen: OpenRouter = notRouted;

/** What an open action returns when the tab was brought forward in another window. */
export const TAB_ELSEWHERE = asTabId("");

/** Install the open router. Returns the uninstall. */
export function routeOpensElsewhere(router: OpenRouter): () => void {
  routeOpen = router;
  return () => {
    if (routeOpen === router) routeOpen = notRouted;
  };
}

const noneHeld = (): readonly string[] => [];
let heldElsewhere: () => readonly string[] = noneHeld;

/** Install the "terminals other windows hold" provider. Returns the uninstall. */
export function provideHeldElsewhere(provider: () => readonly string[]): () => void {
  heldElsewhere = provider;
  return () => {
    if (heldElsewhere === provider) heldElsewhere = noneHeld;
  };
}

/** Persist the layout now — for a change no store action makes (who holds what). */
export function persistLayoutNow(): void {
  persistLayoutPrefs(useAppStore.getState);
}

/* ────────────────────────── pure tree helpers ──────────────────────────
 * Exported for reuse and tests; all operate on plain `PaneNode` trees. */

const SIZE_EPSILON = 1e-4;

const newId = () => crypto.randomUUID();

/** A fresh, empty leaf pane. */
export function makeLeaf(): LeafNode {
  return { id: asPaneId(newId()), type: "leaf", tabIds: [], activeTabId: null };
}

/** Every leaf in visual (left-to-right / top-to-bottom) order. */
export function leavesOf(node: PaneNode): LeafNode[] {
  return node.type === "leaf" ? [node] : node.children.flatMap(leavesOf);
}

/** Depth-first lookup by PaneId (matches splits and leaves). */
export function findNode(node: PaneNode, id: PaneId): PaneNode | null {
  if (node.id === id) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const hit = findNode(child, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** The leaf currently holding `tabId`, if any. */
export function leafOfTab(root: PaneNode, tabId: TabId): LeafNode | null {
  return leavesOf(root).find((leaf) => leaf.tabIds.includes(tabId)) ?? null;
}

/** Scale any positive weights (fractions, pixels, ratios) to sum to exactly 1. */
function normalizeSizes(sizes: number[]): number[] {
  const safe = sizes.map((n) => (Number.isFinite(n) && n > 0 ? n : 0));
  const total = safe.reduce((a, b) => a + b, 0);
  // No `|| 1` guard on the divisor: it would be unreachable. `map` does not run
  // its callback on an empty array, so `safe.length` is >= 1 wherever this is
  // evaluated — the "safety" would only ever be dead weight.
  if (total <= 0) return safe.map(() => 1 / safe.length);
  return safe.map((n) => n / total);
}

function sizesEqual(a: number[], b: number[]): boolean {
  return (
    a.length === b.length &&
    a.every((n, i) => Math.abs(n - b[i]) < SIZE_EPSILON)
  );
}

/** Rebuild `root`, replacing the node with `id` by `fn(node)`. Pure. */
export function replaceNode(
  root: PaneNode,
  id: PaneId,
  fn: (node: PaneNode) => PaneNode,
): PaneNode {
  if (root.id === id) return fn(root);
  if (root.type === "leaf") return root;
  return {
    ...root,
    children: root.children.map((child) => replaceNode(child, id, fn)),
  };
}

/** Canonicalize after EVERY mutation (ARCHITECTURE §4): collapse single-child splits, flatten
 * same-orientation nesting (scaling sizes), drop empty leaves in `prune`, renormalize sizes, keep
 * the last leaf. Pruning is opt-in so `splitPane`'s fresh empty leaf survives. */
export function canonicalize(
  root: PaneNode,
  prune: ReadonlySet<PaneId> = new Set(),
): PaneNode {
  // (e) the root leaf always survives, empty or not.
  if (root.type === "leaf") return root;

  const walk = (node: PaneNode): PaneNode | null => {
    if (node.type === "leaf") {
      return node.tabIds.length === 0 && prune.has(node.id) ? null : node;
    }

    const children: PaneNode[] = [];
    const weights: number[] = [];
    const fallback = 1 / (node.children.length || 1);

    node.children.forEach((rawChild, i) => {
      const child = walk(rawChild);
      if (!child) return;
      const share = node.sizes[i] ?? fallback;

      // (b) flatten same-orientation nesting, distributing this child's share.
      if (child.type === "split" && child.orientation === node.orientation) {
        const inner = normalizeSizes(child.sizes);
        child.children.forEach((grandChild, j) => {
          children.push(grandChild);
          weights.push(share * (inner[j] ?? 1 / child.children.length));
        });
        return;
      }

      children.push(child);
      weights.push(share);
    });

    if (children.length === 0) return null;
    if (children.length === 1) return children[0]; // (a) collapse single-child split
    return { ...node, children, sizes: normalizeSizes(weights) }; // (d)
  };

  return walk(root) ?? makeLeaf(); // (e) tree emptied out entirely
}

/* ────────────────────────────── slice types ────────────────────────────── */

/** A view: one whole pane layout switched as a unit (the iTerm2/tmux window model). Client-only,
 * so its brand lives here rather than in types.ts. */
export type ViewId = string & { readonly __brand: "ViewId" };
export const asViewId = (s: string): ViewId => s as ViewId;

/** One view's persisted shape; for the ACTIVE view a stale snapshot (see `LayoutState.views`). */
export interface ViewSnapshot {
  id: ViewId;
  /** User-visible label. Defaults to the first free "View N"; renameable. */
  name: string;
  layout: PaneNode;
  focusedPaneId: PaneId;
}

/** A close waiting on the user because it would kill a busy terminal. One record, not a `TabId`
 * like `confirmCloseTab`: closing a pane, or an agent by id, kills several terminals at once. */
export interface PendingTerminalClose {
  /** The gesture to replay if the user confirms — never re-derived at that point. */
  scope:
    | { kind: "tab"; tabId: TabId }
    | { kind: "pane"; paneId: PaneId }
    | { kind: "agent"; agentId: AgentId };
  /** Busy terminals as reported at the click, snapshotted so the dialog's list cannot change while
   * the user reads it. */
  terminals: BusyTerminal[];
}

/** The sub-shape of ARCHITECTURE §2.3's `Session` this slice owns; reducers take it. */
export interface LayoutState {
  /** The ACTIVE view's pane tree — the one source of truth while it is active. */
  layout: PaneNode;
  /** A close waiting on "are you sure?", or null (absence is "nothing pending"). */
  pendingTerminalClose: PendingTerminalClose | null;
  /** The ACTIVE view's focused pane — likewise live, not a copy. */
  focusedPaneId: PaneId;
  /** Every tab in the window across ALL views, so `moveTabToView` only moves an id between panes
   * and never re-keys a live terminal. */
  tabs: Record<TabId, Tab>;
  /** Path of the last file tab (`editor`/`diff`) made active anywhere, `activeFilePath`'s
   * fallback. Written only by `activateTab` and `setActiveTab`; never cleaned up, since
   * `activeFilePath` ignores a path no tab shows. */
  lastFilePath: string | null;
  /** Views in bar order. `views[activeViewId]` is a STALE snapshot: read the active tree from
   * `layout`, inactive ones from here (`viewTabIds`/`liveTreeOfView`); switches write back first.
   * Only the active view mounts; `TerminalRegistry` keeps other views' terminals alive. */
  views: ViewSnapshot[];
  /** Always names a member of `views`; `views` is never empty. */
  activeViewId: ViewId;
  /** Boot-only: per restored pane, its terminals in order and the selected one. `applyCenterLayout`
   * restores empty leaves before the snapshot; `rebuildTerminalTabs` consumes and clears this. */
  pendingRestore: Record<PaneId, RestoreSlot>;
}

/** The edge a tab was dropped on (drag-to-edge splits): left/right split `row`, top/bottom split
 * `column`. UI-only; `center` is a plain `moveTab`. */
export type SplitEdge = "left" | "right" | "top" | "bottom";

const EDGE_ORIENTATION: Record<SplitEdge, Orientation> = {
  left: "row",
  right: "row",
  top: "column",
  bottom: "column",
};

/** left/top put the new pane BEFORE the target; right/bottom after it. */
const EDGE_IS_LEADING: Record<SplitEdge, boolean> = {
  left: true,
  top: true,
  right: false,
  bottom: false,
};

export interface LayoutActions {
  /** Mint a TerminalId and open a terminal tab in `paneId` (default: focused). With `agentId` it is
   * an agent-terminal (same PTY path, telemetry attributed to the agent); `runtime` then names an
   * AgentAdapter, never a program (ARCHITECTURE §2.4). */
  openTerminalTab(opts?: {
    cwd?: string;
    paneId?: PaneId;
    agentId?: AgentId;
    runtime?: string;
    title?: string;
  }): TabId;
  /** Open or re-focus a read-only editor tab for `path`, deduped by path. Returns the tab id. */
  openEditorTab(path: string): TabId;
  /** Open or re-focus the HEAD vs working-tree diff for `path`, deduped against diff tabs only (an
   * editor tab of the same file is a different view). Pure state: `<DiffView>` runs
   * `git_file_diff` on mount. Read-only, so never dirty. */
  openDiffTab(path: string): TabId;
  /** Open an API request tab for `requestId`, or mint a fresh GET request. Pure state, no PTY. */
  openApiRequestTab(requestId?: string): TabId;
  /** Open a request-sequence tab, minting the sequence if none is given. */
  openSequenceTab(sequenceId?: string): TabId;
  /** Open or re-focus a folder's past-sessions picker ("Recover session"), deduped by `cwd`. */
  openSessionPickerTab(cwd: string): TabId;
  /** Open or re-focus the metrics dashboard: a singleton (one machine's numbers), re-pointed at
   * `cwd` if the project changed. Pure state; the panel runs its own read-only scan on mount. */
  openMetricsTab(cwd: string | null): TabId;
  /** Open or re-focus the fleet-wide Agent Logs tab (a singleton). */
  openAgentLogsTab(): TabId;
  /** Open or re-focus the Network tab, the capture proxy's flow table (a singleton). */
  openNetworkTab(): TabId;
  /** Open or re-focus the Agent Village tab: this machine's agents as pixel art (a singleton). */
  openVillageTab(): TabId;
  /** Open or re-focus a saved connection's query console, deduped by `connectionId`: two consoles
   * would be two views of ONE session that could disagree. Pure state, no `db_open`; the console
   * opens its session on mount, so the tab can open before the connection does. */
  openDbConsoleTab(connectionId: string): TabId;
  closeTab(tabId: TabId): void;
  /** Take a tab out of this window WITHOUT closing it (tear-off, docs/design/tab-tearoff.md): only
   * the layout half of `closeTab`; no dispose, buffer disposal, dismissal or unpin, since the PTY,
   * agent and buffer live on in the other window. No-op for an unknown id. */
  releaseTab(tabId: TabId): void;
  /** Cmd/Ctrl+W: close the focused pane's active tab (any kind) via `requestCloseTab`, so a
   * dirty editor still confirms. No-op with no active tab. */
  closeActiveTab(): void;
  /** Rename a tab; empty or null reverts to the derived title. For an agent-terminal use
   * `agentActions.renameAgent`: the name belongs to the agent so row and tab stay in sync. */
  renameTab(tabId: TabId, name: string | null): void;
  setActiveTab(paneId: PaneId, tabId: TabId): void;
  /** Split `paneId`; moves nothing. Returns the new (empty, focused) leaf. */
  splitPane(paneId: PaneId, orientation: Orientation): PaneId;
  /** `sizes` may be pixels (straight from allotment's onChange) or fractions. */
  resizePane(splitPaneId: PaneId, sizes: number[]): void;
  focusPane(paneId: PaneId): void;
  /** Move a tab into a pane; with `index`, insert there, which also reorders within its own pane
   * (without it, same pane is a no-op). `index` counts the strip as drawn, dragged tab in it. */
  moveTab(tabId: TabId, toPaneId: PaneId, index?: number): void;
  /** Drop a tab on a pane's edge: split it and land the tab on that side. Atomic: `splitPane` +
   * `moveTab` would render twice and cannot place the new pane before the target. */
  moveTabToEdge(tabId: TabId, targetPaneId: PaneId, edge: SplitEdge): void;
  /** Close a leaf and its tabs (close-pane button): an empty pane has no tab for `closeTab`. */
  closePane(paneId: PaneId): void;
  /** Close a pane, confirming first if it would kill a busy terminal (the pane ✕); `closePane` is
   * the unguarded primitive. `cancelTerminalClose` (Escape, Cancel, backdrop) keeps all alive. */
  requestClosePane(paneId: PaneId): void;
  cancelTerminalClose(): void;
  /** Carry out the close the confirm was holding, killing its terminals. */
  proceedTerminalClose(): void;
  /** Rebuild a tab per `fleet_snapshot` terminal after a reload (Rust and PTYs alive, JS reset).
   * Idempotent: terminals with a tab are skipped. Rebuilt ones reattach via `terminal_reattach`,
   * never re-open; exited ones get an "ended" tab. */
  rebuildTerminalTabs(terminals: readonly TerminalMeta[]): void;

  /* ───────────────────────────── views ───────────────────────────── */

  /** New view with one empty pane, activated; writes the outgoing view back first. Default name
   * is the first free "View N" (not `length + 1`, which collides after a close). */
  createView(name?: string): ViewId;
  /** Switch views: write `layout`/`focusedPaneId` back into `views[activeViewId]` FIRST, then load
   * the target. No-op (and no write-back) when already active or unknown. Nothing is disposed. */
  activateView(id: ViewId): void;
  /** Rename a view. Trims; an empty/whitespace name is REFUSED, not stored. */
  renameView(id: ViewId, name: string): void;
  /** Close a view, moving its tabs into the focused pane of the view active after the close:
   * nothing is disposed or orphaned, only the arrangement is lost. Refused for the last view or an
   * unknown id; `viewTabIds(state, id)` tells the user what will move. */
  closeView(id: ViewId): void;
  /** Move a tab into `viewId`'s focused pane, any direction, without touching `tabs` or the
   * terminal, so PTY and scrollback survive. Emptied source panes prune via `withTabDetached` +
   * `canonicalize`. No-op if already there or an id is unknown. */
  moveTabToView(tabId: TabId, viewId: ViewId): void;
  /** Move `viewId` just before `beforeViewId` (end if null) via the shared `moveBefore`, like
   * `moveRootAgent`/`moveFolder`. No-op for an unknown `viewId`. */
  reorderViews(viewId: ViewId, beforeViewId: ViewId | null): void;
  /** Boot only: restore persisted views and their arrangement, no persist. Leaves come back empty;
   * their terminals wait in `pendingRestore` for `rebuildTerminalTabs`. Empty `views` (a first
   * launch) is a no-op that keeps the boot view. */
  applyCenterLayout(prefs: LayoutPrefs): void;
}

/* ────────────────────────────── fleet slice ────────────────────────────── */

/** The agent forest + selection pivot (ARCHITECTURE §4), normalized: flat records with
 * `parentId`/`childIds` edges, so one agent's telemetry is one O(1) write and one row render. */
export interface FleetState {
  agents: Record<AgentId, AgentNode>;
  /** Root orchestrators, in creation order — the rail's top level. */
  rootAgentIds: AgentId[];
  selection: Selection;
  /** Tombstones for dismissed ids: late telemetry or a stale `fleet_snapshot` must not resurrect
   * a dismissed agent as a ghost row. Bounded FIFO (`TOMBSTONE_CAP`, oldest first): late events
   * land within seconds. */
  dismissedAgentIds: AgentId[];
  /** Folder groups (keyed by root agents' `cwd`) collapsed in the rail; absent means expanded. */
  collapsedFolders: Set<string>;
}

export interface AgentActions {
  /** "+ New agent": mint an `AgentId`, register the node, open its agent-terminal tab, select. */
  createAgent(opts: { cwd: string; title?: string; runtime?: string }): AgentId;
  /** THE pivot (ARCHITECTURE §2.8): re-points the center and workspace by swapping ids only. */
  selectAgent(agentId: AgentId): void;
  /** Disclosure caret. Collapsed subtrees vanish from `flattenFleet`. */
  toggleAgentExpanded(agentId: AgentId): void;
  /** Folder-group disclosure. Toggles `path` in `collapsedFolders`. */
  toggleFolderCollapsed(path: string): void;
  /** Move a root agent just before `targetAgentId` (end if null) in `rootAgentIds`, reordering
   * its folder's rows. Session-only: agent ids are minted per run. No-op for a sub-agent. */
  moveRootAgent(agentId: AgentId, targetAgentId: AgentId | null): void;
  /** Rename an agent (rail row and its tab); empty or null reverts to the derived title. Survives
   * re-snapshots via `hydrateAgent`. */
  renameAgent(agentId: AgentId, name: string | null): void;
  /** Remove an agent and its subtree, tombstoning every id (`dismissedAgentIds`). Explicit
   * dismissal only: a natural exit leaves the row greyed. The pure half of `dismissAgent`. */
  removeAgent(agentId: AgentId): void;
  /** The user's dismiss (row ✕, or closing its tab): kills the child and removes the row. With an
   * open tab it delegates to `closeTab`, so both ✕s share one path; a sub-agent goes directly. */
  dismissAgent(agentId: AgentId): void;
  /** Dismiss an agent, but first confirm if its terminal is busy (the rail's ✕). */
  requestDismissAgent(agentId: AgentId): void;
  /** The only telemetry entry point (`agent://event`, from `bridge.ts`), ARCHITECTURE §1.
   * `spawnChild` is private to this reducer, so the UI cannot spawn a child row by design. */
  applyAgentEvent(event: AgentEvent): void;
  /** `fleet_snapshot` on startup / re-attach: paint whatever Rust already has. */
  applyFleetSnapshot(agents: readonly AgentNode[]): void;
  /** Pin a root agent for restore-on-restart: sets the flag and persists to Rust's registry in the
   * wrapper. No-op for a sub-agent (transcript-derived) or missing record. Idempotent. */
  pinAgent(agentId: AgentId): void;
  /** Unpin: clear the flag and drop it from the registry; a double unpin is harmless. */
  unpinAgent(agentId: AgentId): void;
  /** Boot only: flag snapshot rows that are in the pin registry (Rust already re-spawned them). A
   * pin with no row is skipped. Pure reconcile, no persist. */
  applyPinnedAgents(views: readonly PinnedAgentView[]): void;
  /** Boot only: mark roots the boot restore brought back (`restored_agents()`) "Resumed after
   * restart"; absent rows are skipped, nothing is persisted or sent. The marker clears at the
   * agent's next turn or its end. */
  applyRestoredAgents(views: readonly RestoredAgentView[]): void;
}

/* ──────────────────────────── workspace slice ──────────────────────────── */

export interface WorkspaceState {
  /** Folder new agents/terminals open in; null until `default_workspace` resolves. Never the app
   * binary's cwd: an agent there has no `claude` history to recall. */
  workspaceRoot: string | null;
  /** Recent project folders, most recent first (from `recent_projects`); feeds ⚡ quick-launch
   * (`[0]`) and the rail's folder ordering. */
  recentProjects: string[];
  /** Browse-only Files roots the user opened (most recent first, deduped); visible roots are the
   * `workspaceRoots` union with root agents' cwds. `workspaceRoot` is separate (Find, new cwd). */
  browseRoots: string[];
  /** The manual folder order, the single source both rails sort by (`orderFolders`), so a drag in
   * either moves both. Seeded on boot, kept complete by `syncFolderOrder`; paths no longer visible
   * keep their slot. */
  folderOrder: string[];
  /** Folders collapsed in the right (Files) rail; persisted, absent means expanded. Independent of
   * the left rail's `collapsedFolders`. */
  collapsedRoots: Set<string>;
  /** Persisted "focus follows agent": selecting an agent collapses every other Files-rail folder
   * and expands its cwd. Off by default; seeded by `applyLayoutPrefs`. */
  focusFollowsAgent: boolean;
  /** How the agent rail draws a project (Settings → Interface → Project groups); persisted with
   * the rail prefs, unknown values read as the default ("card"). */
  railGroupStyle: RailGroupStyle;
}

export interface WorkspaceActions {
  /** Set the workspace root and re-point the default terminal cwd to it (a wrapper effect). */
  setWorkspaceRoot(path: string): void;
  /** Replace the recent-projects list (from Rust on startup). */
  setRecentProjects(paths: readonly string[]): void;
  /** Move `path` to the front of recents (dedup) on every agent launch; Rust's
   * `push_recent_project` is the persisted source of truth, mirrored here for the UI. */
  addRecentProject(path: string): void;
  /** Prepend a browse-only Files root (dedup moves it to the front) and authorize it for
   * `read_dir` by pushing it to persisted recents, an effect in the wrapper. */
  addBrowseRoot(path: string): void;
  /** Close a browse root (its ✕ in the Files panel). Drops it from `browseRoots`. */
  removeBrowseRoot(path: string): void;
  /** Append newly visible folders to `folderOrder` so both rails have a total order. No state
   * write and no persist when nothing was added, so it is safe on every telemetry tick. */
  syncFolderOrder(paths: readonly string[]): void;
  /** Move `path` just before `targetPath` (end if null) in `folderOrder`; drives both rails'
   * folder DnD, which move together. Persists. */
  moveFolder(path: string, targetPath: string | null): void;
  /** Toggle `path` in `collapsedRoots` (Files rail) and persist; the left rail's counterpart is
   * `agentActions.toggleFolderCollapsed`. */
  toggleRootCollapsed(path: string): void;
  /** Set and persist "focus follows agent". Turning it on applies the collapse to the current
   * selection at once; turning it off leaves collapse state as it is. */
  setFocusFollowsAgent(on: boolean): void;
  /** Choose how the agent rail draws projects, and persist it. */
  setRailGroupStyle(style: RailGroupStyle): void;
  /** Boot only: seed folder order, both collapse sets and `focusFollowsAgent`; no persist. */
  applyLayoutPrefs(prefs: LayoutPrefs): void;
}

/* ── the Files-panel roots selector ───────────────────────────────────────── */

/** The exact slice `workspaceRoots` reads — a structural subset of the store, so
 *  the component (or a test) can pass the three fields, or the whole state. */
interface WorkspaceRootsSlice {
  rootAgentIds: readonly AgentId[];
  agents: Record<AgentId, AgentNode>;
  browseRoots: readonly string[];
  /** The shared folder order; optional (a caller may omit it and get discovery order). */
  folderOrder?: readonly string[];
}

/** The Files panel's roots: distinct root-agent cwds, then browse roots, deduped by path, sorted
 * by `folderOrder` like the left rail. Discovery order only places a folder not yet in it. */
export function workspaceRoots(s: WorkspaceRootsSlice): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  const add = (path: string | undefined): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    roots.push(path);
  };
  for (const id of s.rootAgentIds) add(s.agents[id]?.cwd);
  for (const path of s.browseRoots) add(path);
  return s.folderOrder ? orderFolders(roots, s.folderOrder) : roots;
}

/* ──────────────────────────── editor slice ───────────────────────────────────────── */

/** Lightweight per-path UI state for an open file; the buffer lives in EditorRegistry. `dirty`
 * rides on `Tab.dirty` instead, so the tab dot renders it. */
export interface EditorUiState {
  status: "loading" | "ready" | "error";
  /** Normal text files are writable by default; false = oversized or binary-gated, read-only. */
  editable: boolean;
  /** Last save's error message, or null; kept until the next edit/save. */
  saveError: string | null;
  /** Bumps on each successful save — drives the transient "Saved" flash. */
  savedAt: number;
  /** The file changed on disk while this buffer had unsaved edits (only set when dirty; clean
   * buffers reload silently). Never overwrite a dirty buffer: the editor offers Reload instead. */
  staleOnDisk: boolean;
  /** Markdown-preview zoom (1 = 100%), kept here to survive tab switches; session-only. */
  previewZoom: number;
  /** The user flipped this previewable file to raw source. Per-tab store state, since `Pane`
   * remounts on tab switch and drag; false (rendered) is the default for every kind. */
  showSource: boolean;
}

export interface EditorsState {
  editors: Record<string, EditorUiState>;
  /** A dirty editor tab awaiting the discard/save/cancel confirm, or null. */
  confirmCloseTab: TabId | null;
}

export interface EditorActions {
  /** First mount of a path: mark it loading (idempotent — skips if known). */
  initEditor(path: string): void;
  /** Content loaded: ready, and whether it is small enough to edit. */
  editorReady(path: string, editable: boolean): void;
  /** read_file failed (binary / oversized / unreadable): a calm error state. */
  editorFailed(path: string): void;
  /** Buffer diverged from (or re-matched) disk — sets the tab's dirty dot. */
  setEditorDirty(path: string, dirty: boolean): void;
  /** Flag (or clear) "changed on disk while you had unsaved edits". */
  setEditorStale(path: string, stale: boolean): void;
  /** Save succeeded: clear dirty + error, flash "Saved". */
  editorSaved(path: string): void;
  /** Save failed: surface the message, keep the buffer dirty. */
  editorSaveFailed(path: string, message: string): void;
  /** Set a path's preview zoom, clamped by `clampPreviewZoom`; an unknown path is a no-op. */
  setPreviewZoom(path: string, zoom: number): void;
  /** Show a previewable file's raw source instead of its rendering; unknown path is a no-op. */
  setShowSource(path: string, showSource: boolean): void;
  /** Forget a path's UI state (its tab closed). */
  disposeEditor(path: string): void;
  /** Close a tab, except a DIRTY editor raises the unsaved-changes confirm (`confirmCloseTab`). */
  requestCloseTab(tabId: TabId): void;
  /** Dismiss the confirm without closing. */
  cancelCloseTab(): void;
  /** Close the tab pending confirmation (Discard, or Save-then-close). */
  closePendingTab(): void;
}

/* ──────────────────────────── LSP slice ───────────────────────────────────────── */

/** One find-usages hit, shaped like a Find-in-Files hit for row reuse: `line`/`col` are 1-based
 * (`revealInEditor`), the match is UTF-16 `[matchStart, matchEnd)` in `lineText`. */
export interface ReferenceHit {
  path: string;
  display: string;
  line: number;
  col: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

/** The result of a find-usages query — drives the references panel. */
export interface ReferencesResult {
  /** The symbol whose usages these are (the panel header). */
  symbol: string;
  /** Every usage, in the server's order (the panel groups them by file). */
  hits: ReferenceHit[];
  /** True while the query is still in flight (the panel shows "Finding usages…"). */
  loading: boolean;
}

/** LSP status for the editor header, keyed by `LanguageId`; the client lives in
 * `features/editor/lsp/`. */
export interface LspState {
  /** languageId → a calm "install <server>" hint when the server is absent. */
  lspInstallHints: Record<string, string>;
  /** languageIds whose install hint the user dismissed this session. */
  lspDismissedHints: string[];
  /** languageIds whose server is still indexing (a query is retrying on -32801). */
  lspIndexing: string[];
  /** The open find-usages result (the references panel), or null when closed. */
  lspReferences: ReferencesResult | null;
}

export interface LspActions {
  /** Record a calm install hint (server for `languageId` is not installed). */
  setLspInstallHint(languageId: string, hint: string): void;
  /** Dismiss the install hint for `languageId` (stays gone this session). */
  dismissLspHint(languageId: string): void;
  /** Mark a language's server as indexing (or done) — drives the indicator. */
  setLspIndexing(languageId: string, indexing: boolean): void;
  /** Open/update the references panel (find-usages result, or its loading state). */
  setReferences(result: ReferencesResult): void;
  /** Close the references panel. */
  clearReferences(): void;
}

/* ──────────────────────────────── UI slice ──────────────────────────────── */

/** Transient, view-only chrome state (no persistence, no IPC). */
export interface UiState {
  /** Whether the keyboard-shortcuts reference overlay is open. */
  shortcutsOpen: boolean;
  /** Find-in-Files overlay open; shared by Cmd/Ctrl+Shift+F and the rail's Find action. */
  findInFilesOpen: boolean;
  /** The right rail's persistent panel; Find is an overlay (`findInFilesOpen`), not a panel. */
  rightRailTab: RightRailTab;
  /** Whether the left rail (AGENTS) is collapsed (VS-Code-style panel toggle). */
  leftRailCollapsed: boolean;
  /** Whether the right rail (Files/Vault/History) is collapsed. */
  rightRailCollapsed: boolean;
  /** Left rail width in px (drag-resizable); clamped to [RAIL_MIN_W, RAIL_MAX_W]. */
  leftRailWidth: number;
  /** Right rail width in px (drag-resizable); clamped to [RAIL_MIN_W, RAIL_MAX_W]. */
  rightRailWidth: number;
  /** One-shot "reveal in Files tree" request from `revealActiveFile()`; the subtree owning `root`
   * consumes it. `token` increments so the same path re-fires. `root` is null when no open root
   * contains `path`, so the tree can say so. Transient. */
  fileReveal: { path: string; token: number; root: string | null } | null;
}

/** One find bar's state; `cursor` is clamped against the current matches on mount, since the
 * content may have changed while the tab was away. */
export interface FindBarState {
  open: boolean;
  query: string;
  cursor: number;
  /** The response body's Raw/Formatted view, kept with the bar because search differs by view. */
  view?: "raw" | "formatted";
}

export interface UiActions {
  /** Merge a patch into one find bar, creating `{open:false, query:"", cursor:0}` first; the
   * single writer for every surface. */
  patchFindBar(key: string, patch: Partial<FindBarState>): void;
  /** Forget a bar entirely (Esc / ✕) — absence is the closed state. */
  dropFindBar(key: string): void;
  /** Remember where a tab surface was scrolled to, so a tab move can restore it. */
  setScrollOffset(key: string, top: number): void;
  /** Remember a grid's sort + column widths, so a tab move can restore them. */
  setGridView(key: string, view: GridView): void;
  /** Toggle the shortcuts overlay (the Cmd/Ctrl+/ hotkey + the titlebar button). */
  toggleShortcuts(): void;
  /** Close the shortcuts overlay (Esc / the close button / opening elsewhere). */
  closeShortcuts(): void;
  /** Toggle the Find-in-Files overlay (the Cmd/Ctrl+Shift+F hotkey + the Find rail tab). */
  toggleFindInFiles(): void;
  /** Open/close the Find-in-Files overlay explicitly (Esc / the ✕ / a result click close it). */
  setFindInFilesOpen(open: boolean): void;
  /** Switch the right rail's persistent panel (Files / Vault / History). */
  setRightRailTab(tab: RightRailTab): void;
  /** Toggle the left rail (AGENTS) collapsed/expanded — the titlebar panel button. */
  toggleLeftRail(): void;
  /** Toggle the right rail (Files/Vault/History) collapsed/expanded. */
  toggleRightRail(): void;
  /** Set the left rail width in px (from a drag); clamped to [RAIL_MIN_W, RAIL_MAX_W]. */
  setLeftRailWidth(px: number): void;
  /** Set the right rail width in px (from a drag); clamped to [RAIL_MIN_W, RAIL_MAX_W]. */
  setRightRailWidth(px: number): void;
  /** "Select Opened File": un-collapse the right rail, switch to Files, expand the owning root, and
   * post `fileReveal` for `activeFilePath`; a no-op with no file tab. The loud gesture: the tree's
   * passive highlight must not do any of this. */
  revealActiveFile(): void;
}

/* ──────────────────────────── API client slice ───────────────────────────────────────── */

/** One request-header row: a disabled row stays visible but is not sent; the stable `id` keeps
 * edits from reordering rows. */
export interface HeaderRow {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

/** One WS console log line (`sys` = a lifecycle note). The caller stamps `at` (epoch ms) so
 * the appending reducer stays pure. */
export interface WsLogEntry {
  dir: "out" | "in" | "sys";
  data: string;
  at: number;
}

/** One request's WebSocket console, in the store so the connection survives tab switches.
 * `connectionId` comes from the `ws_connect` resolve, independent of the `open` event (either
 * order). In memory only: URLs and messages never touch disk. */
export interface WsState {
  status: "idle" | "connecting" | "open" | "closed" | "error";
  connectionId: string | null;
  messages: WsLogEntry[];
  draft: string;
  error: string | null;
}

/** One request's gRPC console, in the store to survive tab switches; in memory only. Endpoint,
 * message and metadata reuse the request's `url`/`body`/`headers`; only gRPC state is here. */
export interface GrpcState {
  /** h2c (no TLS) when true, TLS when false. Mirrors grpcurl's -plaintext. */
  plaintext: boolean;
  /** The reflected services/methods, or null until a reflect succeeds. */
  schema: GrpcSchema | null;
  /** The picked service FQN, or "" — drives the method picker. */
  service: string;
  /** The picked method name, or "". */
  method: string;
  /** True while a reflection call is in flight (gates the Reflect button). */
  listing: boolean;
  /** A reflection failure message, or null (shown inline; manual entry stays open). */
  listError: string | null;
  /** True while a unary call is in flight (gates Send). */
  sending: boolean;
  /** The last call's outcome — a resolved response INCLUDING a non-OK status. */
  response: GrpcResponse | null;
  /** A TRANSPORT-failure message (not a non-OK status), or null. */
  error: string | null;
}

/** One side's outcome in an A/B compare send — response XOR error once settled. */
export interface CompareOutcome {
  response: HttpResponse | null;
  error: string | null;
}

/** A/B compare (HTTP): a second method+url sent alongside the request's own, side by side.
 * B reuses the request's headers and body. In the store to survive tab switches; memory only. */
export interface CompareState {
  /** True when the HTTP lane is in A/B compare mode (second bar + split view). */
  enabled: boolean;
  /** Request B's method (side A is the request's own `method`). */
  method: string;
  /** Request B's url (side A is the request's own `url`). */
  url: string;
  /** True from Send until BOTH sides settle — one Send, two wires. */
  sending: boolean;
  /** Side A's outcome. Kept apart from `response`/`error` so leaving compare
   *  mode restores the single-send view untouched. */
  a: CompareOutcome;
  /** Side B's outcome. */
  b: CompareOutcome;
  /** The key NAME selected for cross-highlight in BOTH JSON trees, or null. */
  selectedKey: string | null;
  /** Recursively sort object keys in both trees so the structures align. */
  sortKeys: boolean;
}

/** Undo history for a request body, in the store because the controlled `<textarea>` loses the
 * native undo stack on unmount (tab switch) and on any programmatic rewrite. */
export interface BodyHistory {
  /** Snapshots BEFORE each edit group, oldest first. */
  past: string[];
  /** Snapshots undone away, for redo. Cleared by any fresh edit. */
  future: string[];
  /** When the last edit landed — the coalescing clock (see `patchApiRequest`). */
  at: number;
}

/** UI state for one open API request. In memory only: a token typed into a header never touches
 * disk. `protocol` switches the tab between HTTP, the WebSocket console and the gRPC console. */
export interface ApiRequestState {
  id: string;
  method: string;
  url: string;
  headers: HeaderRow[];
  body: string;
  /** Undo/redo for `body`. See `BodyHistory`. */
  bodyHistory: BodyHistory;
  response: HttpResponse | null;
  sending: boolean;
  error: string | null;
  protocol: "http" | "ws" | "grpc";
  ws: WsState;
  grpc: GrpcState;
  compare: CompareState;
}

/** One value a step lifts out of its response: `name ← path`. */
export interface SequenceCapture {
  id: string;
  /** The `{{name}}` later steps use. */
  name: string;
  /** Where to find it in the parsed body — see `extractPath`. */
  path: string;
}

/** One sequence step. It OWNS its request (`requestId`): saved-request ids are re-minted on every
 * save by name, so pointing at one would dangle. */
export interface SequenceStep {
  id: string;
  requestId: string;
  captures: SequenceCapture[];
  /** `null` = any 2xx passes. Otherwise the status must match exactly. */
  expectStatus: number | null;
  outcome: "idle" | "running" | "passed" | "failed" | "skipped";
  /** One human sentence when `outcome === "failed"`. */
  failure: string | null;
  /** What THIS step captured on its last run — for the row's ✓/✗ per capture. */
  capturedPreview: Record<string, string>;
}

/** Requests run in order, carrying values forward. In memory only: `captured` holds live bearer
 * tokens, and saving would race Rust's writes to api-store.json. Lost on restart, by design. */
export interface SequenceState {
  id: string;
  name: string;
  steps: SequenceStep[];
  running: boolean;
  /** Stop at the first failing step, or run all: chained flows want stop (the default),
   * independent checks want every outcome. */
  stopOnFailure: boolean;
  expandedStepId: string | null;
  /** The run's capture bag (`name → value`), in the store so a manually run step sees values from
   * an earlier run. `resetSequenceRun` clears it so a fresh run never inherits a stale token. */
  captured: Record<string, string>;
}

export interface ApiState {
  apiRequests: Record<string, ApiRequestState>;
  /** Request sequences, by id. In memory only — see `SequenceState`. */
  sequences: Record<string, SequenceState>;
  /** Saved requests, persisted via Rust; `{{VAR}}` placeholders stay literal, never a secret. */
  apiCollections: SavedRequest[];
  /** Saved-request folders in display order (Rust sorts them); no `folderId` means root. Changed
   * only by `api_folder_*`/`api_request_move`, re-hydrating from the store they return. */
  apiFolders: ApiFolder[];
  /** Folders collapsed in the Collections rail, persisted in `layout-prefs.json`, not
   * `api-store.json`: a UI preference has no business in the Vault. */
  collapsedApiFolders: Set<string>;
  /** Named variable sets (which hold live tokens). Persisted via the Rust store. */
  apiEnvironments: Environment[];
  /** The environment whose variables the send path substitutes, or null. */
  activeEnvironmentId: string | null;
  /** True once hydrated from Rust; gates the one-time load so reopening the tab cannot clobber
   * in-flight edits. */
  apiStoreLoaded: boolean;
  /** Persisted history of every executed request, oldest first; `{{VAR}}` literal, no resolved
   * secret. No cap, no dedup. */
  apiHistory: HistoryEntry[];
  /** True once history has been hydrated from Rust — gates the one-time load. */
  apiHistoryLoaded: boolean;
  /** The "name this request" dialog, opened when Cmd/Ctrl+S hits a request still default-titled;
   * carries the request to save and the tab to retitle. */
  saveRequestPrompt: { requestId: string; tabId: TabId } | null;
}

/** Sequence editing and run bookkeeping; running lives in `features/api/sequenceExecute.ts`. */
export interface SequenceActions {
  /** Mint an empty sequence and return its id. */
  createSequence(): string;
  /** Append a step (minting the request it owns) and return the STEP's id. */
  addSequenceStep(sequenceId: string): string;
  /** Remove a step AND dispose the request it owned, so nothing leaks. */
  removeSequenceStep(sequenceId: string, stepId: string): void;
  /** Move `stepId` to sit before `beforeStepId`, or to the end for `null`. */
  moveSequenceStep(sequenceId: string, stepId: string, beforeStepId: string | null): void;
  setSequenceName(sequenceId: string, name: string): void;
  setStopOnFailure(sequenceId: string, value: boolean): void;
  /** Expand one step, or `null` to collapse. One at a time — it is an accordion. */
  expandSequenceStep(sequenceId: string, stepId: string | null): void;
  setStepExpectStatus(sequenceId: string, stepId: string, status: number | null): void;
  addStepCapture(sequenceId: string, stepId: string): void;
  setStepCapture(
    sequenceId: string,
    stepId: string,
    captureId: string,
    patch: Partial<Pick<SequenceCapture, "name" | "path">>,
  ): void;
  removeStepCapture(sequenceId: string, stepId: string, captureId: string): void;
  /** The runner's write-back for one step. */
  setStepOutcome(
    sequenceId: string,
    stepId: string,
    outcome: SequenceStep["outcome"],
    failure: string | null,
    capturedPreview: Record<string, string>,
  ): void;
  setSequenceRunning(sequenceId: string, running: boolean): void;
  /** Merge newly captured values into the run-scoped bag (last write wins). */
  mergeSequenceCaptured(sequenceId: string, values: Record<string, string>): void;
  /** Every step back to `idle`, failures cleared, and the capture bag emptied. */
  resetSequenceRun(sequenceId: string): void;
}

export interface ApiActions {
  /** Mint a new request (GET, empty url/body/headers) and return its id. */
  createApiRequest(): string;
  /** Duplicate a request into a new one and return its id, or null for an unknown source. */
  duplicateApiRequest(sourceId: string): string | null;
  /** Patch the method / url / body of a request. */
  patchApiRequest(
    id: string,
    patch: Partial<Pick<ApiRequestState, "method" | "url" | "body">>,
  ): void;
  /** Step the body back one edit group. A no-op with nothing to undo. */
  undoApiBody(id: string): void;
  /** Re-apply the last undone body edit. A no-op with nothing to redo. */
  redoApiBody(id: string): void;
  /** Append an empty, enabled header row. */
  addHeader(id: string): void;
  /** Patch one header row (name / value / enabled). */
  updateHeader(
    id: string,
    headerId: string,
    patch: Partial<Pick<HeaderRow, "name" | "value" | "enabled">>,
  ): void;
  /** Drop a header row. */
  removeHeader(id: string, headerId: string): void;
  /** Mark a request as in-flight (or settled). */
  setApiSending(id: string, sending: boolean): void;
  /** Record a successful response — also clears any error and the sending flag. */
  setApiResponse(id: string, response: HttpResponse): void;
  /** Record a send error — also clears the sending flag. */
  setApiError(id: string, error: string): void;

  /* ── A/B compare (HTTP lane) ── */

  /** Toggle A/B compare mode on the HTTP lane. */
  setCompareEnabled(id: string, enabled: boolean): void;
  /** Patch request B's method / url. */
  patchCompare(
    id: string,
    patch: Partial<Pick<CompareState, "method" | "url">>,
  ): void;
  /** Mark the A/B send in flight; `true` clears both outcomes, `false` once both sides land. */
  setCompareSending(id: string, sending: boolean): void;
  /** Record one side's response — clears that side's error. Leaves `sending`
   *  alone: each side lands as it arrives, the executor settles the flag. */
  setCompareResponse(id: string, side: "a" | "b", response: HttpResponse): void;
  /** Record one side's transport error — clears that side's response. */
  setCompareError(id: string, side: "a" | "b", error: string): void;
  /** Select (or clear, with null) the key name cross-highlighted in both trees. */
  setCompareSelectedKey(id: string, key: string | null): void;
  /** Turn recursive key-sorting of both trees on/off. */
  setCompareSortKeys(id: string, sortKeys: boolean): void;

  /* ── durable store: collections + environments ── */

  /** Replace collections/environments/active from a loaded store; mark loaded.
   *  Does NOT persist — it is the READ side (persisting straight back would be a
   *  wasted write of what Rust just handed us). */
  hydrateApiStore(store: ApiStore): void;
  /** Snapshot a request into collections under `name` with a fresh id, `{{VAR}}` literal;
   * replaces a same-named entry in place, else appends. Persists. */
  saveRequestToCollection(requestId: string, name: string): void;
  /** Drop a saved request by id. Persists. */
  deleteCollection(id: string): void;
  /** Copy a saved request into an open one, headers as fresh enabled rows. No-op for an unknown
   * id; does not persist. */
  loadCollectionIntoRequest(collectionId: string, requestId: string): void;
  /** Open a saved request in a new tab, restoring its protocol and titling the tab with its name.
   * Returns the tab id, or null for an unknown id. */
  openSavedRequest(collectionId: string): TabId | null;
  /** Cmd/Ctrl+S on an API-request tab: save under its custom name, or open `saveRequestPrompt` if
   * still default. Returns false for other tab kinds, so an editor's own save wins. */
  saveActiveApiRequest(): boolean;
  /** Confirm the save-name dialog: save under `name`, retitle the tab, close the dialog. */
  confirmSaveRequestName(name: string): void;
  /** Dismiss the save-name dialog without saving. */
  cancelSaveRequestName(): void;
  /** Add an empty environment and return its id. Persists. */
  addEnvironment(name: string): string;
  /** Rename an environment (unknown id: no-op). Persists. */
  renameEnvironment(id: string, name: string): void;
  /** Delete an environment; clears the active pointer if it named this one. Persists. */
  deleteEnvironment(id: string): void;
  /** Set (or clear, with null) the active environment. Persists. */
  setActiveEnvironment(id: string | null): void;
  /** Upsert a variable by key within an environment (unknown env: no-op). Persists. */
  setEnvVar(envId: string, key: string, value: string): void;
  /** Remove a variable by key from an environment. Persists. */
  removeEnvVar(envId: string, key: string): void;

  /* ── saved-request folders ── */

  /** Re-read `api-store.json` into this mirror (no-op on a failed read, so a blob save cannot
   * blank the file). Rust also writes it (`db_connection_upsert` puts a DB password in the Vault),
   * and a stale mirror would write the old snapshot back over it. */
  refreshApiStore(): Promise<void>;
  /** Create a folder (blank names dropped here too). Every folder action is a Rust command that
   * returns the WHOLE store to re-hydrate from; a local edit plus blob save would lose writes. */
  createApiFolder(name: string): Promise<void>;
  /** Rename a folder. Blank names are dropped, as on create. */
  renameApiFolder(id: string, name: string): Promise<void>;
  /** Delete a folder; its requests return to the root, never deleted (Rust's `delete_folder`). */
  deleteApiFolder(id: string): Promise<void>;
  /** File a saved request under `folderId`, or at the root when it is null. */
  moveRequestToFolder(requestId: string, folderId: string | null): Promise<void>;
  /** Put folder `id` just before `beforeId` (last if null), via the shared `moveBefore`. */
  moveApiFolder(id: string, beforeId: string | null): Promise<void>;
  /** Disclose/collapse a folder in the Collections rail. Persists to layout prefs. */
  toggleApiFolderCollapsed(id: string): void;

  /* ── request history ── */

  /** Replace the history log from a loaded store; mark loaded. The READ side — does
   *  NOT persist (this IS what Rust just handed us). */
  hydrateApiHistory(store: HistoryStore): void;
  /** Append an executed request to history and persist; `{{VAR}}` literal, the action mints ids. */
  recordApiHistory(entry: Omit<HistoryEntry, "id">): void;
  /** Empty the history log and persist. */
  clearApiHistory(): void;
  /** Copy a history entry into an open request, headers as fresh enabled rows. No-op for unknown
   * ids; does not persist. */
  loadHistoryIntoRequest(entryId: string, requestId: string): void;
  /** Replace a request's method/url/headers/body from parsed cURL; headers become enabled rows,
   * a null body becomes "". No-op for an unknown id; does not persist. */
  importCurl(requestId: string, parsed: ParsedCurl): void;

  /* ── WebSocket console ── */

  /** Toggle a request between the HTTP surface, the WS console, and the gRPC console. */
  setApiProtocol(id: string, protocol: "http" | "ws" | "grpc"): void;
  /** A connect is in flight: `connecting`, clearing any prior id/error. */
  wsConnecting(id: string): void;
  /** The socket's `open` event arrived: `open`. Status only — the id lands
   *  separately via `wsConnected`, so this is robust to the two racing. */
  wsOpened(id: string): void;
  /** The `ws_connect` promise resolved: stash the `connectionId`. Does NOT touch
   *  `status` (the `open` event owns that), so an id that arrives before or after
   *  the event both land correctly. */
  wsConnected(id: string, connectionId: string): void;
  /** The socket closed (remote or via Disconnect): `closed`, id cleared. `note`,
   *  when given, is appended as a sys log entry (a caller wanting a real
   *  timestamp appends via `wsAppendMessage` instead). */
  wsClosed(id: string, note?: string): void;
  /** A transport error: `error` + the message; id cleared. */
  wsErrored(id: string, message: string): void;
  /** Append one line to the console log (the caller stamps `at`). */
  wsAppendMessage(id: string, entry: WsLogEntry): void;
  /** Edit the outbound-message draft. */
  setWsDraft(id: string, text: string): void;

  /* ── gRPC console (native tonic) ── */

  /** Set the plaintext/TLS flag. */
  setGrpcPlaintext(id: string, plaintext: boolean): void;
  /** A reflection call is in flight: `listing = true`, clearing any prior listError. */
  grpcListing(id: string): void;
  /** Reflection succeeded: stash the schema, clear listing/listError. Resets the
   *  selection if the current service/method is no longer present. */
  grpcListed(id: string, schema: GrpcSchema): void;
  /** Reflection failed: `listing = false`, set listError (manual entry stays open). */
  grpcListError(id: string, message: string): void;
  /** Pick a service (resets method to "" — the method list depends on the service). */
  setGrpcService(id: string, service: string): void;
  /** Pick a method. */
  setGrpcMethod(id: string, method: string): void;
  /** Mark a unary call in-flight (or settled). */
  setGrpcSending(id: string, sending: boolean): void;
  /** Record a resolved unary response (INCLUDING a non-OK status); clears error + sending. */
  setGrpcResponse(id: string, response: GrpcResponse): void;
  /** Record a TRANSPORT-failure error; clears sending. (A non-OK status is NOT this.) */
  setGrpcError(id: string, error: string): void;
}

/* ─────────────────────── database client slice ───────────────────────────── */

/** One connection's live session, keyed by connection id (consumers start from a connection);
 * mirrors Rust's registry. No "idle": absence is idle, so a record exists only once a connect is
 * attempted. */
export interface DbSessionState {
  status: "opening" | "open" | "error";
  /** The opaque handle `db_query`/`db_close` address. Never a DSN, never a credential. */
  sessionId: DbSessionId | null;
  /** The server's own version string — the proof a real round trip happened, not a socket. */
  serverVersion: string | null;
  latencyMs: number | null;
  /** One mapped, redacted sentence; never a raw driver string (sqlx and libpq echo the DSN). */
  error: string | null;
}

/** One query console's contents: survives tab switches, deliberately not a restart (restoring a
 * half-typed statement is a footgun; saved queries are the durable form). */
export interface DbConsoleState {
  /** The editor buffer. */
  text: string;
  /** One entry per statement, in execution order. Empty until the first run. */
  results: DbResultSet[];
  /** The call failed (no session, TLS, timeout); a failed statement is a result. Holds the code
   * and Rust's sentence, so `<DbConsole/>` need not re-describe the code. */
  error: DbFailure | null;
  /** A query is in flight AND we are still waiting for it — see `runToken`. */
  running: boolean;
  /** Bumped on every run and Stop; a reply with a stale token is discarded. This local half makes
   * Stop instant and reliable, since server-side cancel is advisory or absent. */
  runToken: number;
  /** The editor's share of the split — session-only, held here across tab switches. */
  splitFraction: number;
  /** The saved query being edited, or null. The name travels with the id because
   * `db_saved_query_upsert` requires one, so ⌘S works without the list loaded. */
  savedQuery: { id: string; name: string } | null;
  /** Why the last save failed, or null; separate from `error` so it never clears results.
   * `<DbConsoleTab/>` renders it, since `<DbConsole/>` is presentational. */
  saveError: string | null;
  /** Why the last cancel failed, or null; not `error` (the query may still run), and it never
   * clears results. Often a fact: MongoDB, Redis and DynamoDB have no server-side cancel. */
  cancelError: string | null;
}

/** See {@link DbState.dbAgentNotice}. */
export interface DbAgentNotice {
  connectionId: string;
  created: boolean;
  agent: string | null;
  /** A query the agent ran: text, the refusal (`error`) or outcome ("2 rows"), and whether the
   * console shows it (`busy`: the user's run held it; `closed`: not connected). */
  ran?: {
    query: string;
    error: string | null;
    outcome: string | null;
    console: "shown" | "busy" | "closed";
  };
  /** An agent's query kept out of a console holding the user's text; inserted only via
   * `putAgentDbQueryInConsole`. */
  offer?: string;
}

export interface DbState {
  /** The engine registry, exactly as `db_engines()` served it. Rendered, never interpreted. */
  dbEngines: EngineSpec[];
  /** Saved connections as Rust returned them, with no secrets: `passwordRef` is "" or a `{{VAR}}`
   * name, and URL credentials are split out server-side. */
  dbConnections: DbConnection[];
  /** True once registry and connection store are read; gates the one-shot load. Not set on
   * failure, so a transient error retries on the next mount. */
  dbLoaded: boolean;
  /** A PANEL-level failure (the load, a delete), already mapped to one sentence. */
  dbError: string | null;
  /** Live sessions, keyed by connection id. Absence = not connected. */
  dbSessions: Record<string, DbSessionState>;
  /** Open consoles' contents by connection id, in the store because `Pane` unmounts inactive tabs
   * (losing the SQL). Keyed like `openDbConsoleTab`'s dedupe: one console per connection. */
  dbConsoles: Record<string, DbConsoleState>;
  /** The open connection dialog (`connectionId: null` = new), or null. In the store so every
   * opener shares one "is it open", never two modals. */
  dbDialog: { connectionId: string | null } | null;
  /** What an agent did that the user must see, atop the DB panel until dismissed: a connection it
   * added or opened, every query it ran (refused too), or a query offered for a busy console.
   * `agent` is the agent's name, or null. */
  dbAgentNotice: DbAgentNotice | null;
  /** Lazily loaded object trees per connection id, in the store because `<RailTabs/>` unmounts the
   * DB panel and a remount would re-run catalogue queries. Dropped on disconnect and delete. */
  dbTrees: Record<string, DbTreeState>;
  /** Saved queries per connection id, read via `db_saved_queries` without a session, so the list
   * shows after a restart even when the database is unreachable. */
  dbSavedQueries: Record<string, DbSavedQueryListState>;

  /** Hand-arranged tree order: connection id → parent `nodeKey` → child labels. A sibling of
   * `dbTrees` (cleared on refresh and disconnect), backed by `db-tree-order.json`. Absent means
   * alphabetical; an empty array is never stored (see `dbTreeOrderSet`). */
  dbTreeOrders: Record<string, Record<string, string[]>>;

  /** Local find bars by surface key (`api:<requestId>`, `grid:<connectionId>:<n>`, …), since `Pane`
   * remounts on tab switch and drag. Not the editor's CM6 find or the terminal query (registries
   * hold those). Absent = closed; `dropFindBar` deletes, leaving no tombstones. */
  findBars: Record<string, FindBarState>;

  /** Scroll offset per tab surface (keyed like `findBars`): `Pane` unmounts inactive tabs, losing
   * DOM scroll. Saved on unmount and restored on mount, not per scroll event. */
  scrollOffsets: Record<string, number>;

  /** A results grid's view (sort, dragged widths), keyed like `findBars`, so a tab move keeps it.
   * Not persisted: it describes one result set, which does not outlive its session. */
  gridViews: Record<string, GridView>;
  /** The "name this query" dialog, or null; shaped like `saveRequestPrompt` so ⌘S means the same.
   * Rendered by `<DbConsoleTab/>`, which owns the keystroke. Carries the SQL so the confirm saves
   * what ⌘S was pressed on, without re-reading a console that may be gone. */
  dbSaveQueryPrompt: { connectionId: string; sql: string } | null;
}

export interface DbActions {
  /** Read the engine registry and saved connections once (in parallel); a no-op while `dbLoaded`,
   * retried after a failure. Never rejects: failures land in `dbError`, so the rail survives. */
  loadDbStore(): Promise<void>;
  /** Apply a load's result; no persist, since this IS what Rust just returned. */
  hydrateDbStore(engines: EngineSpec[], store: DbConnectionStore): void;
  /** Persist a draft via `db_connection_upsert` and apply the returned record (`id` null creates).
   * `password` travels separately: never merged into `draft`, stored or logged. Rejects with one
   * mapped sentence: the dialog shows the failure, never a silent no-op Save. */
  upsertDbConnection(
    draft: DbConnectionDraft,
    password: string,
    id: string | null,
  ): Promise<DbConnection>;
  /** An agent added or re-opened a connection (`agent-studio db connect`); Rust wrote both files,
   * so re-arm both load-once gates (LESSONS §34), reload, and show the DB tab with a notice.
   * Resolves once the list is re-read (never rejects): then `openDbSession` can find the id. */
  showAgentDbConnection(event: {
    connectionId: string;
    terminalId: string;
    created: boolean;
  }): Promise<void>;
  /** An agent ran a query (`agent-studio db query`): always told in the notice, without stealing
   * focus; the console opens in the background and shows results unless the user's run holds it.
   * A buffer holding the user's text is never modified: the notice offers the query instead. */
  showAgentDbQuery(event: {
    connectionId: string;
    terminalId: string;
    query: string;
    error: string | null;
    outcome: string | null;
    results: DbResultSet[];
  }): Promise<void>;
  /** An agent's query for a console holding the user's text (`agent-studio db console`): the text
   * stays, and the notice offers the query. */
  offerAgentDbQuery(event: { connectionId: string; terminalId: string; query: string }): void;
  /** "Put in console": replace the console's text with the offered query, unlink its saved query
   * (so ⌘S cannot overwrite it), focus it. The only way an agent's query replaces user text. */
  putAgentDbQueryInConsole(): void;
  /** Dismiss the agent notice. */
  dismissDbAgentNotice(): void;
  /** Delete a connection (Rust cascades its live sessions) and drop our mirror of it. */
  deleteDbConnection(id: string): Promise<void>;
  /** Connect: probe the server version with `db_test_connection` (`db_open` returns only a
   * session id), then open the session. Never rejects: an unreachable database is a status. */
  openDbSession(id: string): Promise<void>;
  /** Disconnect: drop our mirror, then close Rust's session. Idempotent, like `db_close`. */
  closeDbSession(id: string): Promise<void>;
  /** Open the connection dialog — `null` for a new connection, an id to edit one. */
  openDbDialog(connectionId: string | null): void;
  /** Close the connection dialog without saving. */
  closeDbDialog(): void;
  /** Edit a console's buffer. Creates the console record on first keystroke. */
  setDbConsoleText(connectionId: string, text: string): void;
  /** Move a console's split divider. Clamped by the console's own `clampSplit`. */
  setDbConsoleSplit(connectionId: string, fraction: number): void;
  /** Run `text` (default: the whole buffer) through `db_query`. Only the editor knows what to run
   * (caret, selection); the mode is a permission, not a payload. Never rejects (called from a
   * keystroke): failures are `error`, and no session reports `no-session`. */
  runDbQuery(connectionId: string, mode: DbRunMode, text?: string): Promise<void>;
  /** Stop: bump `runToken` (orphans the reply, stops the spinner, cannot fail), then ask the
   * server to cancel, which is advisory or unsupported (MongoDB, Redis, DynamoDB). A failed cancel
   * becomes a console notice, never a throw, so Stop never looks stuck. */
  stopWaitingForDbQuery(connectionId: string): void;

  /* ─────────────── the object tree and saved queries ─────────────────────────── */

  /** Read one tree level via `db_children` and cache it; a no-op if cached or in flight (`force`
   * retries). Never rejects: a failure is an inline note on that node (`dbTrees[id].failed`). */
  loadDbChildren(
    connectionId: string,
    sessionId: DbSessionId,
    node: DbNodeRefWire,
    force?: boolean,
  ): Promise<void>;
  /** Expand or collapse a node, loading on first expand (IPC from the wrapper, after the `set`).
   * Collapsing keeps the cache and any inline failure. */
  toggleDbNode(
    connectionId: string,
    sessionId: DbSessionId | null,
    node: DbNodeRefWire,
  ): void;
  /** Drop a connection's whole subtree. Called on disconnect: a cached list from a dead
   *  session is a tree that answers `not-found` when clicked. */
  clearDbTree(connectionId: string): void;
  /** Invalidate a tree after a write or Refresh WITHOUT collapsing it: drops only `children` and
   * `failed` (presence is the loaded marker), so visible levels refetch. A `db_children` already
   * in flight can still land stale. No-op without a cached tree (an entry would mean "fetch"). */
  refreshDbTree(connectionId: string): void;
  /** Read a connection's saved queries (`db_saved_queries`), no session needed. Never rejects; a
   * failure is `dbSavedQueries[id].error`. */
  loadDbSavedQueries(connectionId: string): Promise<void>;
  /** Load this connection's tree order; never rejects (a failure renders alphabetically). */
  loadDbTreeOrder(connectionId: string): Promise<void>;
  /** Move label `moved` just before `before` (end if null) in `parentKey`'s level, and persist.
   * The order is computed from what is displayed now, so it is total over visible children. */
  moveDbTreeNode(connectionId: string, parentKey: string, moved: string, before: string | null): void;
  /** Forget one level's arrangement, back to the engine's alphabetical order. */
  resetDbTreeOrder(connectionId: string, parentKey: string): void;
  /** Open a saved query in the connection's console, adopting its id and name so ⌘S updates it. */
  openDbSavedQuery(connectionId: string, query: SavedQueryRecord): void;
  /** Put `sql` in the console and focus it (double-click a table). Clears `savedQuery`, or the
   * next ⌘S would overwrite a saved query with this `SELECT *`. */
  openDbQueryInConsole(connectionId: string, sql: string): void;
  /** ⌘/Ctrl+S in a console: `saved` (updated in place), `prompted` (name dialog opened) or
   * `empty` (nothing saved). Never rejects: called from a keydown handler. */
  saveDbConsoleQuery(connectionId: string): Promise<"saved" | "prompted" | "empty">;
  /** Confirm the name dialog: create the query, adopt it into the console, close the dialog. */
  confirmDbSaveQueryName(name: string): Promise<void>;
  /** Dismiss the name dialog without saving. */
  cancelDbSaveQueryName(): void;
  /** Create (`id: null`) or update a saved query and refresh the list. Never rejects: refusals
   * land in `saveError`. Resolves the record, or null on failure. */
  upsertDbSavedQuery(
    connectionId: string,
    id: string | null,
    name: string,
    sql: string,
  ): Promise<SavedQueryRecord | null>;
  /** Delete a saved query and drop it from the list. `removed: false` (a stale list) is still
   * filtered but reported, like `deleteDbConnection`. */
  deleteDbSavedQuery(connectionId: string, id: string): Promise<void>;
}

/* ─────────────────── shareable config bundles ───────────────────────────────── */

/** Export state. The draft (mode, label, selections, passphrase) stays in `<ExportDialog/>` so
 * the passphrase never reaches the store; the dialog is modal, so losing it on unmount is fine. */
export interface PortabilityExportState {
  /** An export is in flight (the picker is NOT part of this — see `exportBundle`). */
  busy: boolean;
  /** The last export's failure as ONE mapped sentence, or null. Never a raw wire string. */
  error: string | null;
  /** The last export, with Rust's header: counts measured from the file, including
   * `secretValues: 0`. */
  done: { header: BundleHeader; path: string } | null;
}

/** Import state (inspect, then apply); never a passphrase. A failed inspect only writes `error`,
 * keeping `srcPath`, `plan` and `overrides`, so a wrong passphrase is retryable. */
export interface PortabilityImportState {
  /** The chosen file, or null when nothing has been picked. Rust reads it; we never do. */
  srcPath: string | null;
  /** The latest dry run; a sealed bundle without a passphrase still gives a real plan
   * (`unsealed: false`) so the dialog can describe it first. */
  plan: ImportPlan | null;
  /** An inspect or an import is in flight. */
  busy: boolean;
  /** The last inspect/import failure as ONE mapped sentence, or null. */
  error: string | null;
  /** Per-item action overrides by `ImportItem.id` (absent = plan default). In the store so the
   * security review survives an unmount; kept across re-inspects (sealed choices still apply). */
  overrides: Record<string, ImportAction>;
  /** Whether an incoming secret may replace one already here. False is a security default
   * (`ImportChoices`): a silently replaced value breaks a setup untraceably. */
  overwriteExistingSecrets: boolean;
  /** Whether imported DB connections become read-only. Defaults true (a connection new to this
   * machine), but it is the importer's choice. */
  forceReadOnly: boolean;
  /** What the last apply actually did, as Rust counted it. Null until an import runs. */
  result: ImportResult | null;
}

export interface PortabilityState {
  /** Which bundle dialog is open, or null. Mirrors `dbDialog`: one owner, so never two. */
  portabilityDialog: "export" | "import" | null;
  portabilityExport: PortabilityExportState;
  portabilityImport: PortabilityImportState;
}

export interface PortabilityActions {
  /** Open the export or the import dialog. */
  openPortabilityDialog(which: "export" | "import"): void;
  /** Close whichever is open. Leaves the import's state alone — see `resetImport`. */
  closePortabilityDialog(): void;

  /** Pick a destination and write the bundle. Resolves the header, or null on cancel or failure
   * (`portabilityExport.error` tells them apart). Never rejects: the dialog shows the outcome.
   * `options` carries the passphrase and is never stored. */
  exportBundle(options: ExportOptions): Promise<BundleHeader | null>;

  /** Pick a bundle and inspect it without a passphrase. A new file resets the plan, overrides and
   * result: choices about another file must not carry over. */
  chooseImportFile(): Promise<void>;
  /** Re-run the dry run on `srcPath` (the passphrase retry). Never rejects (click handler): a
   * failure is `error` and keeps the previous plan, so the dialog stays as it was. */
  inspectBundle(srcPath: string, passphrase: string | null): Promise<void>;
  /** Step 2: unseal the already-chosen file. A no-op when no file has been chosen. */
  unsealImport(passphrase: string): Promise<void>;

  /** Override one item's action. */
  setImportAction(itemId: string, action: ImportAction): void;
  /** Drop every override, going back to the plan's own defaults. */
  clearImportActions(): void;
  /** Allow (or forbid) an incoming secret to replace one already on this machine. */
  setOverwriteExistingSecrets(allow: boolean): void;
  /** Whether imported connections are made read-only — the review screen's toggle. Default `true`. */
  setImportForceReadOnly(readOnly: boolean): void;

  /** Apply the plan; resolves the result, or null on failure or no file. The passphrase is an
   * argument because it is never stored. On success re-arms `dbLoaded`/`apiStoreLoaded` and
   * reloads DB: Rust just rewrote both files, which would otherwise show nothing until restart. */
  applyImport(passphrase: string | null): Promise<ImportResult | null>;
  /** Forget the whole import: the file, the plan, the choices, the result. */
  resetImport(): void;
}

export interface AppStore
  extends
    LayoutState,
    FleetState,
    WorkspaceState,
    EditorsState,
    LspState,
    UiState,
    ApiState,
    DbState,
    PortabilityState {
  layoutActions: LayoutActions;
  agentActions: AgentActions;
  workspaceActions: WorkspaceActions;
  editorActions: EditorActions;
  lspActions: LspActions;
  uiActions: UiActions;
  apiActions: ApiActions;
  sequenceActions: SequenceActions;
  dbActions: DbActions;
  portabilityActions: PortabilityActions;
}

/* ───────────────────────────── reducers ─────────────────────────────
 * Pure functions over a LayoutState draft (Immer), kept free of the store root. */

/** `paneId` if it still names a leaf of `layout`, else the first leaf: the one focus-repair
 * rule, shared by live focus (`ensureFocus`) and view snapshots, which moves can prune too. */
function focusedOrFirst(layout: PaneNode, paneId: PaneId): PaneId {
  const focused = findNode(layout, paneId);
  if (focused && focused.type === "leaf") return paneId;
  // Unguarded on purpose: `canonicalize` invariant (e) — "never remove the last
  // leaf" — means every tree has at least one, so a "no leaves" fallback would be
  // a branch no input can reach (and a permanently uncovered one).
  return leavesOf(layout)[0].id;
}

/** Repair focus if it points at a pruned/collapsed pane. */
function ensureFocus(s: LayoutState): void {
  s.focusedPaneId = focusedOrFirst(s.layout, s.focusedPaneId);
}

/** `leaf` without `tabId`, activation moved to a neighbour. Pure: shared by `closeTab` and the
 * drop planners so the preview runs the real mutation. Total without a guard (an absent tab
 * filters to the same list and is never `activeTabId`). */
function leafWithoutTab(leaf: LeafNode, tabId: TabId): LeafNode {
  const i = leaf.tabIds.indexOf(tabId);
  const tabIds = leaf.tabIds.filter((id) => id !== tabId);
  const activeTabId =
    leaf.activeTabId === tabId
      ? (tabIds[Math.min(i, tabIds.length - 1)] ?? null)
      : leaf.activeTabId;
  return { ...leaf, tabIds, activeTabId };
}

/** Clamp a DOM-measured drop index into range; junk (NaN from an unlaid-out strip) appends
 * rather than becoming 0. */
function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) return max;
  return Math.min(Math.max(Math.trunc(index), 0), max);
}

/** Leaves that emptied out get pruned; a leaf that still has tabs does not. */
const pruneIfEmpty = (leaf: LeafNode): ReadonlySet<PaneId> =>
  leaf.tabIds.length === 0 ? new Set([leaf.id]) : new Set<PaneId>();

/** Recanonicalize after a structural edit; `current()` first, since canonicalize rebuilds nodes
 * and feeding draft proxies back into the draft is a footgun. */
function recanonicalize(s: LayoutState, prune?: ReadonlySet<PaneId>): void {
  s.layout = canonicalize(current(s.layout), prune);
  ensureFocus(s);
}

/* ─────────────────────────── drop planning ───────────────────────────
 * The tree a drop WOULD produce. Actions and the drag preview share these, since a drop can prune
 * its source and collapse a split, letting the survivor grow past the hovered pane. */

/** The outcome of a drop: the tree it produces and where the tab lands. */
export interface MovePlan {
  /** The canonicalized tree the drop would produce. */
  layout: PaneNode;
  /** The leaf the dragged tab ends up in — always present in `layout`. */
  landedPaneId: PaneId;
}

/** The tree with `tabId` removed from whichever leaf holds it, plus that leaf. */
function withTabDetached(
  layout: PaneNode,
  from: LeafNode,
  tabId: TabId,
): { layout: PaneNode; prune: ReadonlySet<PaneId> } {
  const detached = replaceNode(layout, from.id, (node) =>
    leafWithoutTab(node as LeafNode, tabId),
  );
  // Read the source leaf back from the NEW tree: whether it emptied out (and so
  // gets pruned, and so may collapse its parent) is the whole question.
  const source = findNode(detached, from.id) as LeafNode;
  return { layout: detached, prune: pruneIfEmpty(source) };
}

/** What `moveTab` would produce, or null for a no-op; mirrors `LayoutActions.moveTab` exactly. */
export function planMoveTab(
  layout: PaneNode,
  tabId: TabId,
  toPaneId: PaneId,
  index?: number,
): MovePlan | null {
  const from = leafOfTab(layout, tabId);
  const to = findNode(layout, toPaneId);
  if (!from || !to || to.type !== "leaf") return null;

  const samePane = from.id === to.id;
  if (samePane && index === undefined) return null;

  const fromIndex = from.tabIds.indexOf(tabId);
  let at = index ?? to.tabIds.length;
  if (samePane) {
    // `index` was measured against the strip WITH this tab still in it, so
    // every position after it shifts left by one on removal.
    if (at > fromIndex) at -= 1;
    at = clampIndex(at, to.tabIds.length - 1);
    if (at === fromIndex) return null; // dropped exactly where it already sits
  } else {
    at = clampIndex(at, to.tabIds.length);
  }

  const { layout: detached, prune } = withTabDetached(layout, from, tabId);
  const inserted = replaceNode(detached, toPaneId, (node) => {
    const leaf = node as LeafNode;
    const tabIds = [...leaf.tabIds];
    tabIds.splice(at, 0, tabId);
    return { ...leaf, tabIds, activeTabId: tabId };
  });

  // `to` gains a tab, so it is never pruned and canonicalize preserves it.
  return { layout: canonicalize(inserted, prune), landedPaneId: toPaneId };
}

/** What `moveTabToEdge` would produce, or null for a no-op; mirrors the action exactly. */
export function planMoveTabToEdge(
  layout: PaneNode,
  tabId: TabId,
  targetPaneId: PaneId,
  edge: SplitEdge,
): MovePlan | null {
  const from = leafOfTab(layout, tabId);
  const target = findNode(layout, targetPaneId);
  if (!from || !target || target.type !== "leaf") return null;

  // Dropping a pane's ONLY tab on that same pane's edge would split it, empty
  // the source half, prune it and collapse straight back — the user asked for
  // nothing, so do nothing (and, per the planner contract, preview nothing).
  if (from.id === target.id && from.tabIds.length <= 1) return null;

  const { layout: detached, prune } = withTabDetached(layout, from, tabId);

  const landed: LeafNode = {
    id: asPaneId(newId()),
    type: "leaf",
    tabIds: [tabId],
    activeTabId: tabId,
  };

  // Wrap the target in a fresh split; if its parent has the same orientation, canonicalize
  // flattens it into a sibling insert, so an edge drop grows a row to any number of panes.
  const wrapped = replaceNode(detached, targetPaneId, (leaf) => ({
    id: asPaneId(newId()),
    type: "split",
    orientation: EDGE_ORIENTATION[edge],
    children: EDGE_IS_LEADING[edge] ? [landed, leaf] : [leaf, landed],
    sizes: [0.5, 0.5],
  }));

  // `landed` holds a tab, so it always survives canonicalization.
  return { layout: canonicalize(wrapped, prune), landedPaneId: landed.id };
}

/** A leaf's box as fractions (0..1) of the tree's container. A split's `sizes` are its children's
 * shares, so this needs no measurement and matches allotment, driven by the same `sizes`. */
export interface FractionalRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function fractionalRectOfLeaf(
  root: PaneNode,
  leafId: PaneId,
): FractionalRect | null {
  const walk = (
    node: PaneNode,
    box: { left: number; top: number; width: number; height: number },
  ): { left: number; top: number; width: number; height: number } | null => {
    if (node.type === "leaf") return node.id === leafId ? box : null;

    let offset = 0;
    for (let i = 0; i < node.children.length; i++) {
      // `sizes[i]` is defined for every child on a canonical tree (rule d, and
      // property-tested), so no `??` fallback here: an unreachable guard over a
      // proven invariant is dead weight that only ever hides a real breakage.
      const share = node.sizes[i];
      const childBox =
        node.orientation === "row"
          ? {
              left: box.left + offset * box.width,
              top: box.top,
              width: share * box.width,
              height: box.height,
            }
          : {
              left: box.left,
              top: box.top + offset * box.height,
              width: box.width,
              height: share * box.height,
            };
      const hit = walk(node.children[i], childBox);
      if (hit) return hit;
      offset += share;
    }
    return null;
  };

  return walk(root, { left: 0, top: 0, width: 1, height: 1 });
}

/** The box a drop at `zone` would land the tab in, from the same planners the actions run. A
 * no-op returns where the tab already is (null blanked the preview mid-drag); null is only for a
 * tab or pane not in the tree, or a split target. */
export function planDropRect(
  layout: PaneNode,
  tabId: TabId,
  paneId: PaneId,
  zone: SplitEdge | "center",
): FractionalRect | null {
  const plan =
    zone === "center"
      ? planMoveTab(layout, tabId, paneId)
      : planMoveTabToEdge(layout, tabId, paneId, zone);
  // A plan's landed leaf is always in its own tree, so this never falls through.
  if (plan) return fractionalRectOfLeaf(plan.layout, plan.landedPaneId);

  // No plan: the drop is a no-op, so the tab keeps the box it already has.
  const target = findNode(layout, paneId);
  const home = leafOfTab(layout, tabId);
  if (!home || !target || target.type !== "leaf") return null;
  return fractionalRectOfLeaf(layout, home.id);
}

/** The PTY behind a tab, if it has one (editor / agent-activity have none). */
function terminalIdOf(tab: Tab | undefined): TerminalId | null {
  if (!tab) return null;
  const ref = tab.ref;
  return ref.kind === "terminal" || ref.kind === "agent-terminal"
    ? ref.terminalId
    : null;
}

/** Ask if any terminal is busy, then hold the gesture for a confirm or proceed. Callbacks name
 * both outcomes at every call site. The empty case must call `proceed()`: an early return would
 * make every idle close silently do nothing. */
async function gateTerminalClose(
  terminalIds: TerminalId[],
  scope: PendingTerminalClose["scope"],
  hold: (pending: PendingTerminalClose) => void,
  proceed: () => void,
  titleOf: (id: TerminalId) => string | null,
): Promise<void> {
  const busy = await terminalsBusy(terminalIds);
  if (busy.length === 0) {
    proceed();
    return;
  }
  hold({ scope, terminals: busy.map((b) => namedByItsTab(b, titleOf(b.id))) });
}

/** Name a busy COMMAND by its tab title: the backend only knows the shell's program
 * ("powershell", "zsh"). An agent keeps the backend's label, the session name the rail shows. */
function namedByItsTab(busy: BusyTerminal, tabTitle: string | null): BusyTerminal {
  return busy.reason === "command" && tabTitle ? { ...busy, label: tabTitle } : busy;
}

/** A plain terminal tab's shown title (custom name first), or null when no tab holds it. */
function plainTerminalTitle(tabs: Record<TabId, Tab>, terminalId: TerminalId): string | null {
  for (const t of Object.values(tabs)) {
    if (t.ref.kind === "terminal" && t.ref.terminalId === terminalId) {
      return t.customTitle?.trim() || t.title;
    }
  }
  return null;
}

/** The agent a tab is bound to, if it is an agent-terminal (never for a shell). */
function agentIdOf(tab: Tab | undefined): AgentId | null {
  if (!tab) return null;
  return tab.ref.kind === "agent-terminal" ? tab.ref.agentId : null;
}

/** Promote the plain tab an ad-hoc agent bound to (agent id == terminal id) to agent-terminal,
 * so `agentIdOf` works and closing it dismisses the agent. Metadata only: same `terminalId`, no
 * remount. Idempotent: only a plain `terminal` tab matches. */
function promoteTabForAgent(s: LayoutState, agentId: AgentId): void {
  // Ad-hoc: the agent's id IS its terminal's id. Cast to compare against the
  // TerminalId-branded ref field.
  const terminalId = asTerminalId(agentId);
  for (const tab of Object.values(s.tabs)) {
    if (tab.ref.kind === "terminal" && tab.ref.terminalId === terminalId) {
      tab.kind = "agent-terminal";
      tab.ref = { kind: "agent-terminal", terminalId, agentId };
      // A terminalId lives in exactly one tab, so the first match is the only.
      return;
    }
  }
}

let terminalSeq = 0;

/** "~/projects/gazelle" → "gazelle"; no cwd (or only separators) → null. */
function folderName(cwd?: string): string | null {
  const base = cwd
    ?.replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop();
  return base && base.length > 0 ? base : null;
}

/** "~/projects/gazelle" → "gazelle"; no cwd → "Terminal 3". */
function terminalTitle(cwd?: string): string {
  return folderName(cwd) ?? `Terminal ${++terminalSeq}`;
}

/** A rebuilt tab's title until renamed: an agent's tab wears its folder name (as when spawned;
 * `meta.title` is the rail's "claude"); with no cwd (a tab from another window) `meta.title`
 * wins, and a plain shell keeps `meta.title`. */
function rebuiltTabTitle(meta: TerminalMeta): string {
  return (meta.agentId ? folderName(meta.cwd) : null) ?? meta.title;
}

/* ───────────────────────── fleet reducers ─────────────────────────
 * Pure functions over a FleetState draft, mirroring the layout slice's shape.
 */

/** Hydrate a wire `AgentNode`, defaulting the four UI-only fields the wire never sends
 * (ARCHITECTURE §2.2) once here, so every consumer can treat an `AgentNode` as total. */
function hydrateAgent(wire: AgentNodeWire, prev?: AgentNode): AgentNode {
  return {
    ...wire,
    // A self-parent would be reachable from no root (undrawable, undismissable); normalize it to
    // a root at this one boundary so nothing downstream handles the case.
    parentId: wire.parentId === wire.id ? null : wire.parentId,
    // Derived from parentId edges by `linkAgent`, never trusted from the wire.
    childIds: prev?.childIds ?? [],
    sessionId: prev?.sessionId ?? null,
    // View state survives re-snapshots, with no wire fallback (`AgentNodeWire` lacks these).
    // Default collapsed (sub-agents behind ▶, roll-up still shown); `prev?.expanded` first so a
    // tree the user opened stays open. This line is THE default for `upsertAgent`.
    expanded: prev?.expanded ?? false,
    unread: prev?.unread ?? 0,
    // The user's custom name is view state too — a re-snapshot or a Rust title
    // update must never wipe it. Same preserve-prev rule as `expanded`.
    customTitle: prev?.customTitle ?? null,
    // Client-only, preserved like the above: a re-snapshot must never wipe a pin; seeded only by
    // `applyPinnedAgents`, so a pin toggled mid-boot survives the race.
    pinned: prev?.pinned ?? false,
    // The "Resumed after restart" marker: client-only, seeded once at boot
    // (`applyRestoredAgents`), so a re-snapshot must not wipe it either.
    restored: prev?.restored ?? null,
  };
}

/** Walk `parentId` to the root orchestrator. Cycle-safe, so bad telemetry
 *  cannot hang the pivot. */
export function rootOf(
  agents: Record<AgentId, AgentNode>,
  agentId: AgentId,
): AgentNode | null {
  const seen = new Set<AgentId>();
  let cursor = agents[agentId];
  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = agents[cursor.parentId];
    if (!parent) break;
    cursor = parent;
  }
  return cursor ?? null;
}

/** Raise the unread badge on an agent and every ancestor, so a blocked descendant shows on a
 * collapsed trunk. */
function bubbleUnread(s: FleetState, agentId: AgentId): void {
  walkAncestry(s, agentId, (agent) => {
    agent.unread += 1;
  });
}

/** Clear an agent's badge and take its contribution out of every ancestor's roll-up, or the
 * trunk keeps advertising an answered "needs input". */
function clearUnread(s: FleetState, agentId: AgentId): void {
  // Total by contract, not by guard: the only caller resolves the agent first,
  // so a `?.` here would be an unreachable branch pretending to be safety.
  const cleared = s.agents[agentId].unread;
  if (cleared === 0) return;
  walkAncestry(s, agentId, (agent, isSelf) => {
    // Floored: an ancestor may have been dismissed and re-linked since, and a
    // negative badge is worse than a slightly stale one.
    agent.unread = isSelf ? 0 : Math.max(0, agent.unread - cleared);
  });
}

/** Apply `fn` to an agent and each ancestor. Cycle-safe: bad telemetry must not spin. */
function walkAncestry(
  s: FleetState,
  agentId: AgentId,
  fn: (agent: AgentNode, isSelf: boolean) => void,
): void {
  const seen = new Set<AgentId>();
  let cursor: AgentNode | undefined = s.agents[agentId];
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    fn(cursor, cursor.id === agentId);
    cursor = cursor.parentId ? s.agents[cursor.parentId] : undefined;
  }
}

/** Insert `agentId` into its parent's `childIds` (or the root list). Idempotent. */
function linkAgent(s: FleetState, agent: AgentNode): void {
  const { id, parentId } = agent;
  const parent = parentId === null ? undefined : s.agents[parentId];

  // A genuine root, or an orphan whose parent has not arrived: surface it as a root (self-parents
  // were normalized in `hydrateAgent`). Visible in the wrong place beats invisible.
  if (!parent) {
    if (!s.rootAgentIds.includes(id)) s.rootAgentIds.push(id);
    return;
  }
  if (!parent.childIds.includes(id)) parent.childIds.push(id);
}

/** Upsert an agent, preserving UI-only state (`agent_started`, snapshots, `spawnChild`).
 * Re-links when the parent changed (a replayed spawn, or a child later started as a root), or
 * the old parent keeps it in `childIds` and the rail shows a duplicate. */
function upsertAgent(s: FleetState, wire: AgentNode): void {
  // Dismissed stays dismissed: every creation path lands here. Skipping also skips `adoptOrphans`,
  // so nothing re-homes under a dead parent.
  if (isDismissed(s, wire.id)) return;

  const prev = s.agents[wire.id];
  const reparented = prev !== undefined && prev.parentId !== wire.parentId;

  // Unlink BEFORE the record is overwritten: `unlinkAgent` reads the *current*
  // parentId to find which list to remove from, and that is still the old one.
  if (reparented) unlinkAgent(s, wire.id);

  s.agents[wire.id] = hydrateAgent(wire, prev);
  if (!prev || reparented) linkAgent(s, s.agents[wire.id]);
  adoptOrphans(s, wire.id);
}

/** Re-home roots waiting for this agent: events are unordered across agents and snapshots are
 * flat, so a child can arrive first; without adoption it stays a top-level root forever. */
function adoptOrphans(s: FleetState, parentId: AgentId): void {
  const orphans = s.rootAgentIds.filter(
    (rootId) => rootId !== parentId && s.agents[rootId]?.parentId === parentId,
  );
  for (const orphanId of orphans) {
    unlinkAgent(s, orphanId);
    linkAgent(s, s.agents[orphanId]);
  }
}

/** Callable only from `applyAgentEvent`, never an action: a sub-agent row appears under its
 * parent purely from telemetry (ARCHITECTURE §5.4). */
function spawnChild(
  s: FleetState,
  ev: Extract<AgentEvent, { t: "subagent_spawned" }>,
): void {
  // The child id is fresh, so `upsertAgent`'s tombstone check misses it; a late child of a
  // dismissed parent would surface as a ghost root, so check the parent.
  if (isDismissed(s, ev.parentId)) return;

  const now = Date.now();
  upsertAgent(s, {
    id: ev.childAgentId,
    parentId: ev.parentId,
    kind: "subagent",
    title: ev.title,
    status: "running",
    branch: ev.branch,
    cwd: ev.cwd,
    runtime: ev.runtime,
    startedAt: now,
    finishedAt: null,
    lastActivityAt: now,
    childIds: [],
    // v1 sub-agents are read-only telemetry nodes: no PTY, so no Session.
    // The field exists so the selection pivot Just Works if that changes.
    sessionId: null,
    // Collapsed by default (hydrateAgent's `?? false` is the real authority here;
    // kept in sync so the literal never misleads). A spawned child must NOT pop
    // its parent open — the parent's `expanded` is untouched by this upsert.
    expanded: false,
    unread: 0,
  });
}

/** Most recent this many dismissals are remembered — see `dismissedAgentIds`. */
const TOMBSTONE_CAP = 512;

function tombstone(s: FleetState, agentId: AgentId): void {
  if (s.dismissedAgentIds.includes(agentId)) return;
  s.dismissedAgentIds.push(agentId);
  // FIFO eviction: the oldest tombstone falls off once we exceed the cap. The
  // evicted id is so far in the past that no live telemetry could still name it.
  if (s.dismissedAgentIds.length > TOMBSTONE_CAP) s.dismissedAgentIds.shift();
}

function isDismissed(s: FleetState, agentId: AgentId): boolean {
  return s.dismissedAgentIds.includes(agentId);
}

/** Remove `tabId` from a draft leaf in place (same activation rule as `leafWithoutTab`) so a
 * batch can detach many tabs before one recanonicalize. Returns whether the leaf held it. */
function detachTabFromDraftLeaf(leaf: LeafNode, tabId: TabId): boolean {
  const i = leaf.tabIds.indexOf(tabId);
  if (i === -1) return false;
  leaf.tabIds.splice(i, 1);
  if (leaf.activeTabId === tabId) {
    leaf.activeTabId = leaf.tabIds[Math.min(i, leaf.tabIds.length - 1)] ?? null;
  }
  return true;
}

/** Close every tab in `tabIds`, then canonicalize once (a batched `closeTab`). `s.layout` may
 * already be a plain tree (`closeTab` canonicalized first); `current()` only takes a draft. */
function closeTabs(s: LayoutState, tabIds: readonly TabId[]): void {
  if (tabIds.length === 0) return;
  const emptied = new Set<PaneId>();
  for (const tabId of tabIds) {
    delete s.tabs[tabId];
    for (const leaf of leavesOf(s.layout)) {
      if (!detachTabFromDraftLeaf(leaf, tabId)) continue;
      if (leaf.tabIds.length === 0) emptied.add(leaf.id);
      break;
    }
  }
  s.layout = canonicalize(plainTree(s.layout), emptied);
  ensureFocus(s);
  // Same reason as `closeTab`'s call: the loop above only walks the ACTIVE tree,
  // so a swept tab sitting in another view would leave a dangling id there.
  sweepTabsFromInactiveViews(s, tabIds);
}

/** Remove an agent's subtree and tombstone every id, even if absent (a dismiss can beat its
 * create). Also closes each removed agent's activity tab, which `closeTab`'s terminal path never
 * reaches and which would otherwise poll a dropped agent forever. */
function removeAgentFromForest(
  s: LayoutState & FleetState,
  agentId: AgentId,
  // Out-param: removed PINNED ids, so the caller fires the `unpinAgent` effect after `set` (else
  // the pin resurrects a tombstoned agent next boot). Required; pass `[]` when there is none.
  unpinned: AgentId[],
): void {
  if (!s.agents[agentId]) {
    tombstone(s, agentId);
    return;
  }

  // Collect the subtree BEFORE deleting anything — a removed parent must take
  // its descendants with it, or `linkAgent` would resurface them as roots.
  const doomed: AgentId[] = [];
  const collect = (id: AgentId) => {
    const agent = s.agents[id];
    if (!agent || doomed.includes(id)) return; // cycle-safe
    doomed.push(id);
    agent.childIds.forEach(collect);
  };
  collect(agentId);

  unlinkAgent(s, agentId);
  const activityTabs: TabId[] = [];
  for (const id of doomed) {
    // Unpin removed pinned agents (only roots are pinned, but check the whole subtree); every
    // collected id has a record.
    if (s.agents[id].pinned) unpinned.push(id);
    delete s.agents[id];
    tombstone(s, id);
    // Sweep the sub-agent's activity tab, if one is open, so its poller unmounts.
    const activityTab = findActivityTab(s.tabs, id);
    if (activityTab) activityTabs.push(activityTab);
  }
  closeTabs(s, activityTabs);

  if (
    s.selection.selectedAgentId &&
    doomed.includes(s.selection.selectedAgentId)
  ) {
    s.selection.selectedAgentId = s.rootAgentIds[0] ?? null;
    s.selection.activeSessionId = null;
  }
}

/** Remember `tabId` for `activeFilePath` when it is a file tab; other kinds leave the Files rail
 * where it was. */
function noteFileTab(s: LayoutState, tabId: TabId): void {
  const path = tabFilePath(s.tabs[tabId]);
  if (path !== null) s.lastFilePath = path;
}

/** Activate `tabId` in whichever pane holds it and focus that pane: the pivot's primitive. Both
 * writes are guarded so re-activation produces no new state. A scan, not a null-guard: every tab
 * lives in exactly one leaf, so a "not found" arm would be dead code. */
function activateTab(s: LayoutState, tabId: TabId): void {
  // Before the scan, so it runs once for the cross-view recursion below too: a
  // file tab being activated is what the Files rail follows (`activeFilePath`).
  // Non-file tabs leave the memory alone — that is the whole point of it.
  noteFileTab(s, tabId);
  for (const leaf of leavesOf(s.layout)) {
    if (!leaf.tabIds.includes(tabId)) continue;
    if (leaf.activeTabId !== tabId) leaf.activeTabId = tabId;
    if (s.focusedPaneId !== leaf.id) s.focusedPaneId = leaf.id;
    return;
  }

  // Not in the visible view: switch to the view holding it, or the click silently does nothing.
  for (const view of s.views) {
    if (view.id === s.activeViewId) continue;
    if (!leavesOf(view.layout).some((leaf) => leaf.tabIds.includes(tabId))) continue;
    writeBackActiveView(s);
    s.layout = view.layout;
    s.focusedPaneId = view.focusedPaneId;
    s.activeViewId = view.id;
    // Now that it IS the live tree, the ordinary path can do the focusing.
    activateTab(s, tabId);
    return;
  }
}

/** The tab currently showing `agentId`'s terminal, if one is open. */
function findAgentTab(
  tabs: Record<TabId, Tab>,
  agentId: AgentId,
): TabId | null {
  for (const tab of Object.values(tabs)) {
    if (tab.ref.kind === "agent-terminal" && tab.ref.agentId === agentId) {
      return tab.id;
    }
  }
  return null;
}

/** The read-only activity view for `agentId`, if one is open. */
function findActivityTab(
  tabs: Record<TabId, Tab>,
  agentId: AgentId,
): TabId | null {
  for (const tab of Object.values(tabs)) {
    if (tab.ref.kind === "agent-activity" && tab.ref.agentId === agentId) {
      return tab.id;
    }
  }
  return null;
}

/** The read-only editor tab for `path`, if one is open (dedupe by path). */
function findEditorTab(tabs: Record<TabId, Tab>, path: string): TabId | null {
  for (const tab of Object.values(tabs)) {
    if (tab.ref.kind === "editor" && tab.ref.path === path) {
      return tab.id;
    }
  }
  return null;
}

/** The last path segment — an editor tab's title. `split` never yields an empty
 * array, so the final index is always a string (no fallback branch needed). */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** The leaf a new tab lands in: `paneId` if it is a leaf, else the first leaf. Defensive (focus
 * always names a live leaf), but keeps tab-opening total on a stale id. */
function targetLeaf(s: LayoutState, paneId: PaneId): LeafNode {
  const target = findNode(s.layout, paneId);
  return target && target.type === "leaf" ? target : leavesOf(s.layout)[0];
}

/** The absolute path of the one file a tab shows, or null. `diff` counts (a real file in the
 * tree, so the crosshair stays live); a `session-picker`/`metrics` `cwd` is a folder. */
function tabFilePath(tab: Tab | undefined): string | null {
  if (tab === undefined) return null;
  return tab.ref.kind === "editor" || tab.ref.kind === "diff" ? tab.ref.path : null;
}

/** Is some tab, in any view, still showing the file at `path`? */
function hasFileTabFor(tabs: Record<TabId, Tab>, path: string): boolean {
  return Object.values(tabs).some((tab) => tabFilePath(tab) === path);
}

/** The file the Files rail is on: crosshair target, its enabled rule and the selected row, one
 * value for all three. The focused pane's file tab, else the last file tab activated anywhere
 * (focus moves on any mousedown), validated against live tabs on every read. */
export function activeFilePath(s: LayoutState): string | null {
  const tabId = targetLeaf(s, s.focusedPaneId).activeTabId;
  const active = tabFilePath(tabId === null ? undefined : s.tabs[tabId]);
  if (active !== null) return active;
  const remembered = s.lastFilePath;
  return remembered !== null && hasFileTabFor(s.tabs, remembered) ? remembered : null;
}

/** Open a sub-agent's read-only activity tab in the focused leaf: pure state, no PTY. Returns
 * the tab id, not yet active; `agent` is already resolved, so its title is read directly. */
function openActivityTab(s: LayoutState & FleetState, agent: AgentNode): TabId {
  const tabId = asTabId(newId());
  s.tabs[tabId] = {
    id: tabId,
    kind: "agent-activity",
    title: agent.customTitle ?? agent.title,
    ref: { kind: "agent-activity", agentId: agent.id },
  };
  targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
  return tabId;
}

/** The tab bound to `terminalId` (either terminal kind), if one is open. */
function findTerminalTab(
  tabs: Record<TabId, Tab>,
  terminalId: TerminalId,
): TabId | null {
  for (const tab of Object.values(tabs)) {
    if (
      (tab.ref.kind === "terminal" || tab.ref.kind === "agent-terminal") &&
      tab.ref.terminalId === terminalId
    ) {
      return tab.id;
    }
  }
  return null;
}

/** Detach `agentId` from whichever list currently holds it. */
function unlinkAgent(s: FleetState, agentId: AgentId): void {
  const agent = s.agents[agentId];
  const parent = agent?.parentId ? s.agents[agent.parentId] : undefined;
  if (parent) parent.childIds = parent.childIds.filter((id) => id !== agentId);
  s.rootAgentIds = s.rootAgentIds.filter((id) => id !== agentId);
}

function initialFleetState(): FleetState {
  return {
    agents: {},
    rootAgentIds: [],
    selection: {
      selectedAgentId: null,
      // Derived from the selected agent's root; stays null until M2 sessions.
      activeSessionId: null,
      rightRailTab: "files",
    },
    dismissedAgentIds: [],
    collapsedFolders: new Set<string>(),
  };
}

/* ────────────────────────────── views ──────────────────────────────
 * Pure helpers over `LayoutState.views`. Invariant: the records in `tabs` are exactly the tab ids
 * in every view's tree (active from `layout`, others from snapshots); no orphans either way. */

/** A draft-safe plain tree: `canonicalize`/`replaceNode` must never see a draft. */
const plainTree = (tree: PaneNode): PaneNode =>
  isDraft(tree) ? current(tree) : tree;

/** What reading a view's tree needs, narrower than `LayoutState` so `<ViewBar>` and
 * `serializeCenterLayout` need not fabricate fields (`pendingRestore` least of all). */
export type ViewTreeSource = Pick<
  LayoutState,
  "layout" | "views" | "activeViewId"
>;

/** `view`'s authoritative tree: live `layout` for the active view (its snapshot is stale), else
 * the snapshot. May be a draft: pass it through `plainTree` before rebuilding. */
function liveTreeOfView(s: ViewTreeSource, view: ViewSnapshot): PaneNode {
  return view.id === s.activeViewId ? s.layout : view.layout;
}

/** The authoritative focused pane of `view` — live for the active one. */
function focusOfView(s: LayoutState, view: ViewSnapshot): PaneId {
  return view.id === s.activeViewId ? s.focusedPaneId : view.focusedPaneId;
}

/** Write `tree`/`focus` to wherever `view` keeps them (live fields, or snapshot). */
function writeViewTree(
  s: LayoutState,
  view: ViewSnapshot,
  tree: PaneNode,
  focus: PaneId,
): void {
  if (view.id === s.activeViewId) {
    s.layout = tree;
    s.focusedPaneId = focus;
  } else {
    view.layout = tree;
    view.focusedPaneId = focus;
  }
}

/** Refresh `views[activeViewId]` from live `layout`/`focusedPaneId`; run BEFORE the active view
 * changes. A scan, not `find ?? return`: `activeViewId` always names a view. */
function writeBackActiveView(s: LayoutState): void {
  for (const view of s.views) {
    if (view.id !== s.activeViewId) continue;
    view.layout = plainTree(s.layout);
    view.focusedPaneId = s.focusedPaneId;
    return;
  }
}

/** Every tab id in `viewId`, in visual order (live for the active view); the ViewBar uses
 * `.length` to say how many terminals a close would move. */
export function viewTabIds(s: ViewTreeSource, viewId: ViewId): TabId[] {
  const view = s.views.find((v) => v.id === viewId);
  if (!view) return [];
  return leavesOf(liveTreeOfView(s, view)).flatMap((leaf) => [...leaf.tabIds]);
}

/** The first free "View N" — free, not `count + 1`, so a close can't collide. */
function nextViewName(views: readonly ViewSnapshot[]): string {
  const taken = new Set(views.map((v) => v.name));
  let n = 1;
  while (taken.has(`View ${n}`)) n += 1;
  return `View ${n}`;
}

/** A fresh view around one empty pane. */
function makeView(name: string): ViewSnapshot {
  const leaf = makeLeaf();
  return { id: asViewId(newId()), name, layout: leaf, focusedPaneId: leaf.id };
}

/** `tree` with `tabIds` appended to `paneId`'s leaf, made active. Rebuilds via `replaceNode`
 * since the tree may be shared; `paneId` is a leaf (callers use `focusedOrFirst`). */
function withTabsAttached(
  tree: PaneNode,
  paneId: PaneId,
  tabIds: readonly TabId[],
): PaneNode {
  return replaceNode(tree, paneId, (node) => {
    const leaf = node as LeafNode;
    return {
      ...leaf,
      tabIds: [...leaf.tabIds, ...tabIds],
      activeTabId: tabIds[tabIds.length - 1],
    };
  });
}

/** Drop `tabIds` from every inactive view's snapshot, pruning emptied leaves: `closeTab` repairs
 * only the live tree, which would leave dangling ids. The write-back is unconditional: for an
 * untouched view it is the same object, so Immer keeps the snapshot's identity. */
function sweepTabsFromInactiveViews(
  s: LayoutState,
  tabIds: readonly TabId[],
): void {
  for (const view of s.views) {
    if (view.id === s.activeViewId) continue;
    let tree = plainTree(view.layout);
    for (const tabId of tabIds) {
      const from = leafOfTab(tree, tabId);
      // This view does not hold that tab — the common case, since a close sweeps
      // every view but the tab lives in exactly one.
      if (!from) continue;
      const detached = withTabDetached(tree, from, tabId);
      tree = canonicalize(detached.layout, detached.prune);
    }
    view.layout = tree;
    view.focusedPaneId = focusedOrFirst(tree, view.focusedPaneId);
  }
}

/* ─────────────────── the center layout, across a restart ───────────────────
 * `serializeCenterLayout`/`hydrateCenterLayout` (inverses, property-tested) keep views, panes and
 * renames in `layout-prefs.json`, keyed by durable `TerminalId` (an agent's is its AgentId). */

/** One pane's persisted contents, held from `applyCenterLayout` to `rebuildTerminalTabs`. */
export interface RestoreSlot {
  terminals: PersistedTerminal[];
  activeTerminalId: string | null;
}

/** The slice of the store `serializeCenterLayout` reads. */
export type CenterLayoutSource = ViewTreeSource &
  Pick<LayoutState, "tabs"> &
  Pick<FleetState, "agents">;

/** The custom name a tab carries across a restart: an agent terminal's lives on the AGENT (row
 * and tab read it there), others on the tab. One function so save and restore agree. */
function customNameOf(s: CenterLayoutSource, tab: Tab): string | null {
  const agentId = agentIdOf(tab);
  if (!agentId) return tab.customTitle ?? null;
  return s.agents[agentId]?.customTitle ?? null;
}

/** Inverse of `customNameOf`. `null` is left alone, so a restore never clears a name telemetry
 * already supplied. */
function restoreCustomName(
  s: LayoutState & FleetState,
  tab: Tab,
  customTitle: string | null,
): void {
  if (customTitle === null) return;
  const agentId = agentIdOf(tab);
  if (!agentId) {
    tab.customTitle = customTitle;
    return;
  }
  // The agent row is painted from `applyFleetSnapshot`, which bridge.ts runs
  // BEFORE this — but a terminal whose agent failed to re-materialize has no row
  // to name, and must not conjure one.
  const agent = s.agents[agentId];
  if (agent) agent.customTitle = customTitle;
}

/** One pane, on its way to disk. */
function serializePane(s: CenterLayoutSource, node: PaneNode): PersistedPane {
  if (node.type === "split") {
    return {
      type: "split",
      orientation: node.orientation,
      sizes: [...node.sizes],
      children: node.children.map((child) => serializePane(s, child)),
    };
  }
  const terminals: PersistedTerminal[] = [];
  for (const tabId of node.tabIds) {
    const tab = s.tabs[tabId];
    const terminalId = terminalIdOf(tab);
    // Terminals only. An editor / API / metrics / activity tab has no durable id
    // to key on and is re-openable from its own source (a path, a request id),
    // so persisting a husk of one would restore a tab pointing at nothing.
    if (terminalId) terminals.push({ terminalId, customTitle: customNameOf(s, tab) });
  }
  return {
    type: "leaf",
    terminals,
    activeTerminalId: node.activeTabId
      ? terminalIdOf(s.tabs[node.activeTabId])
      : null,
  };
}

/** PURE: the center layout for disk, every view in bar order plus the active one. Reads the
 * active view from live `layout`, never its stale snapshot. */
export function serializeCenterLayout(
  s: CenterLayoutSource,
  parked: readonly string[] = [],
): {
  views: PersistedView[];
  activeViewId: string;
} {
  const views = s.views.map((view) => ({
    id: view.id,
    name: view.name,
    layout: serializePane(s, liveTreeOfView(s, view)),
  }));
  parkHeldAgents(s, views, parked);
  return { views, activeViewId: s.activeViewId };
}

/** Write agents another window shows (tear-off) into the active view's first pane with their
 * names here, so a name survives a quit while the tab is away. Agents only; no duplicates. */
function parkHeldAgents(
  s: CenterLayoutSource,
  views: PersistedView[],
  parked: readonly string[],
): void {
  const placed = new Set(views.flatMap((v) => persistedTerminalIds(v.layout)));
  const extra = parked
    .filter((id) => !placed.has(id) && s.agents[asAgentId(id)])
    .map((id) => ({ terminalId: id, customTitle: s.agents[asAgentId(id)].customTitle ?? null }));
  if (extra.length === 0) return;
  // Non-null: `activeViewId` always names a view (the store's own invariant).
  const active = views.find((v) => v.id === s.activeViewId)!;
  firstPersistedLeaf(active.layout).terminals.push(...extra);
}

function persistedTerminalIds(node: PersistedPane): string[] {
  return node.type === "leaf"
    ? node.terminals.map((t) => t.terminalId)
    : node.children.flatMap(persistedTerminalIds);
}

function firstPersistedLeaf(node: PersistedPane): Extract<PersistedPane, { type: "leaf" }> {
  return node.type === "leaf" ? node : firstPersistedLeaf(node.children[0]);
}

/** One pane, on its way back. Fresh `PaneId`s; contents parked in `pending`. */
function hydratePane(
  node: PersistedPane,
  pending: Record<PaneId, RestoreSlot>,
): PaneNode {
  if (node.type === "leaf") {
    const leaf = makeLeaf();
    pending[leaf.id] = {
      terminals: node.terminals,
      activeTerminalId: node.activeTerminalId,
    };
    return leaf;
  }
  const children = node.children.map((child) => hydratePane(child, pending));
  // Repair rather than throw: a hand-edited or future file may carry a malformed split, and a
  // bad file must degrade, not break boot. (Junk orientations are rejected in Rust.)
  if (children.length < 2) return children[0] ?? makeLeaf();
  return {
    id: asPaneId(newId()),
    type: "split",
    orientation: node.orientation,
    children,
    sizes:
      node.sizes.length === children.length
        ? normalizeSizes(node.sizes)
        : children.map(() => 1 / children.length),
  };
}

/** PURE: persisted views back as `ViewSnapshot`s with EMPTY leaves, plus the per-pane contents
 * for `rebuildTerminalTabs`. Inverse of `serializeCenterLayout`. */
export function hydrateCenterLayout(views: readonly PersistedView[]): {
  views: ViewSnapshot[];
  pendingRestore: Record<PaneId, RestoreSlot>;
} {
  const pendingRestore: Record<PaneId, RestoreSlot> = {};
  return {
    views: views.map((view) => {
      const layout = hydratePane(view.layout, pendingRestore);
      return {
        id: asViewId(view.id),
        name: view.name,
        layout,
        // Focus is not persisted (it would mean persisting pane ids to point
        // at); the first leaf is where a new terminal opens until the first click.
        focusedPaneId: leavesOf(layout)[0].id,
      };
    }),
    pendingRestore,
  };
}

/** Drop panes a restore left empty in every view (their terminals did not return). A view's
 * last leaf is never removed, so a view that restored nothing stays as one empty pane. */
function pruneEmptyPanes(s: LayoutState): void {
  for (const view of s.views) {
    const tree = plainTree(liveTreeOfView(s, view));
    const empty = new Set(
      leavesOf(tree)
        .filter((leaf) => leaf.tabIds.length === 0)
        .map((leaf) => leaf.id),
    );
    const pruned = canonicalize(tree, empty);
    writeViewTree(s, view, pruned, focusedOrFirst(pruned, focusOfView(s, view)));
  }
}

function initialLayoutState(): LayoutState {
  // Boot to a single empty pane: it renders the "New terminal" placeholder.
  // Opening a PTY is a side effect and must not happen at module load.
  const view = makeView("View 1");
  // The initial snapshot deliberately shares `view.layout` with the live tree:
  // it IS the active view, so the snapshot is stale-by-design from here on.
  return {
    layout: view.layout,
    focusedPaneId: view.focusedPaneId,
    pendingTerminalClose: null,
    tabs: {},
    lastFilePath: null,
    views: [view],
    activeViewId: view.id,
    pendingRestore: {},
  };
}

function initialWorkspaceState(): WorkspaceState {
  // Unknown until startup asks Rust; the UI shows a "choose a folder" affordance.
  // `folderOrder`/`collapsedRoots` boot empty and are seeded from the persisted
  // store by `applyLayoutPrefs` in bridge.ts.
  return {
    workspaceRoot: null,
    recentProjects: [],
    browseRoots: [],
    folderOrder: [],
    collapsedRoots: new Set<string>(),
    // Off by default (today's behaviour); seeded from the persisted store on boot.
    focusFollowsAgent: false,
    railGroupStyle: DEFAULT_RAIL_GROUP_STYLE,
  };
}

function initialEditorsState(): EditorsState {
  return { editors: {}, confirmCloseTab: null };
}

function initialLspState(): LspState {
  return {
    lspInstallHints: {},
    lspDismissedHints: [],
    lspIndexing: [],
    lspReferences: null,
  };
}

/** Drag-resize bounds for the side rails (px). Keeps a rail usable (not a sliver)
 *  and from eating the center pane. */
export const RAIL_MIN_W = 180;
export const RAIL_MAX_W = 560;

/** Clamp a rail width to [RAIL_MIN_W, RAIL_MAX_W]; a non-finite drag value (NaN)
 *  falls back to the min rather than poisoning the layout. */
function clampRailWidth(px: number): number {
  if (!Number.isFinite(px)) return RAIL_MIN_W;
  return Math.max(RAIL_MIN_W, Math.min(RAIL_MAX_W, px));
}

function initialUiState(): UiState {
  return {
    shortcutsOpen: false,
    findInFilesOpen: false,
    rightRailTab: "files",
    leftRailCollapsed: false,
    rightRailCollapsed: false,
    leftRailWidth: 260,
    rightRailWidth: 300,
    fileReveal: null,
  };
}

function initialApiState(): ApiState {
  return {
    apiRequests: {},
    sequences: {},
    apiCollections: [],
    apiFolders: [],
    // Boots EMPTY (= everything expanded) and is seeded from `layout-prefs.json` by
    // `applyLayoutPrefs`, exactly like `collapsedRoots`.
    collapsedApiFolders: new Set<string>(),
    apiEnvironments: [],
    activeEnvironmentId: null,
    apiStoreLoaded: false,
    apiHistory: [],
    apiHistoryLoaded: false,
    saveRequestPrompt: null,
  };
}

/** Persist the API store after a mutation: an effect in the wrapper, never in a producer.
 * `state` is post-mutation (`get()`); `saveApiStore` swallows its own failure. */
function persistApiStore(state: ApiState): void {
  void saveApiStore({
    collections: state.apiCollections,
    environments: state.apiEnvironments,
    activeEnvironmentId: state.activeEnvironmentId,
    // `folders` MUST be here: a whole-blob save, and serde defaults a missing field to `[]`,
    // deleting every folder (`deleting_a_saved_request_does_not_take_the_folders_with_it`).
    folders: state.apiFolders,
  });
}

/** Keep at most this many body snapshots — a bounded, generous depth. */
const BODY_HISTORY_MAX = 200;
/** Edits closer together than this join one undo step (CodeMirror's own default). */
const BODY_GROUP_MS = 500;

/** Record the body about to be replaced. Within `BODY_GROUP_MS` of the last edit nothing is
 * pushed, so one Cmd+Z undoes a whole burst of typing, not one keystroke. */
function recordBodyEdit(req: ApiRequestState, now: number): void {
  const h = req.bodyHistory;
  // A fresh edit invalidates the redo branch, exactly as every editor does.
  h.future = [];
  if (now - h.at < BODY_GROUP_MS && h.past.length > 0) {
    h.at = now;
    return;
  }
  h.past.push(req.body);
  if (h.past.length > BODY_HISTORY_MAX) h.past.shift();
  h.at = now;
}

/** Persist request history after a mutation, the same wrapper rule as `persistApiStore`. */
function persistApiHistory(state: ApiState): void {
  void saveApiHistory({ entries: state.apiHistory });
}

/** The DB slice's boot state, empty until the panel's first mount reads Rust. Nothing to
 * persist: `db-connections.json` is written only by `db_connection_upsert` (validation, Vault). */
function initialDbState(): DbState {
  return {
    dbEngines: [],
    dbConnections: [],
    dbLoaded: false,
    dbError: null,
    dbSessions: {},
    dbDialog: null,
    dbAgentNotice: null,
    dbConsoles: {},
    dbTrees: {},
    dbSavedQueries: {},
    dbTreeOrders: {},
    findBars: {},
    scrollOffsets: {},
    gridViews: {},
    dbSaveQueryPrompt: null,
  };
}

/** The name the DB panel's notice gives an agent: its own name when we know it, else `null`. */
function agentName(agent: { title: string; customTitle?: string | null } | undefined): string | null {
  return agent === undefined ? null : (agent.customTitle ?? agent.title);
}

/** An empty buffer takes the agent's query (unlinked from a saved query) and returns null; a
 * buffer with other text is untouched and the query is returned to offer. A buffer already
 * holding it, or an empty query, needs neither. */
export function putOrOffer(c: DbConsoleState, query: string): string | null {
  if (c.text.trim() === "") {
    c.text = query;
    c.savedQuery = null;
    c.saveError = null;
    return null;
  }
  return query.trim() === "" || c.text.trim() === query.trim() ? null : query;
}

/** A console the user has not run anything in yet. */
export function blankDbConsole(): DbConsoleState {
  return {
    text: "",
    results: [],
    error: null,
    running: false,
    runToken: 0,
    splitFraction: 0.5,
    savedQuery: null,
    saveError: null,
    cancelError: null,
  };
}

/** A failed session record carries no version and no latency, so no stale "PostgreSQL 17.2"
 * sits next to an error. */
function failedSession(error: string): DbSessionState {
  return { status: "error", sessionId: null, serverVersion: null, latencyMs: null, error };
}

/** Shown when a delete found nothing; exported so tests assert the exact sentence. */
export const DB_ALREADY_GONE_NOTE =
  "That connection was already gone — the list has been refreshed.";

/** The same for a saved query: shown in the tree, where "the list" is the query list. */
export const DB_SAVED_QUERY_ALREADY_GONE_NOTE =
  "That saved query was already gone — the list has been refreshed.";

/** The import flow's boot state and "start over". `overwriteExistingSecrets: false`, the
 * security default, is written only here. */
export function initialImportState(): PortabilityImportState {
  return {
    srcPath: null,
    plan: null,
    busy: false,
    error: null,
    overrides: {},
    overwriteExistingSecrets: false,
    // `true` here, once, for the same reason the line above is here once: the safe default belongs
    // at a single site, or a second copy can reset it to the unsafe value.
    forceReadOnly: true,
    result: null,
  };
}

/** The portability slice's boot state, exported so the test harness resets the whole slice in
 * one `Object.assign`. Never persisted: Rust alone reads and writes bundle files. */
export function initialPortabilityState(): PortabilityState {
  return {
    portabilityDialog: null,
    portabilityExport: { busy: false, error: null, done: null },
    portabilityImport: initialImportState(),
  };
}

/* ────────────────────────────── the store ────────────────────────────── */

export const useAppStore = create<AppStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      ...initialLayoutState(),
      ...initialFleetState(),
      ...initialWorkspaceState(),
      ...initialEditorsState(),
      ...initialLspState(),
      ...initialUiState(),
      ...initialApiState(),
      ...initialDbState(),
      ...initialPortabilityState(),

      uiActions: {
        patchFindBar: (key, patch) =>
          set((s) => {
            const bar = (s.findBars[key] ??= { open: false, query: "", cursor: 0 });
            Object.assign(bar, patch);
          }),

        dropFindBar: (key) =>
          set((s) => {
            delete s.findBars[key];
          }),

        setGridView: (key, view) =>
          set((s) => {
            s.gridViews[key] = view;
          }),

        setScrollOffset: (key, top) =>
          set((s) => {
            // 0 is stored like any other offset: "scrolled back to the top" is a
            // position the user chose, and dropping it would silently mean
            // "restore wherever you were last".
            s.scrollOffsets[key] = top;
          }),

        toggleShortcuts: () =>
          set((s) => {
            s.shortcutsOpen = !s.shortcutsOpen;
          }),
        closeShortcuts: () =>
          set((s) => {
            s.shortcutsOpen = false;
          }),
        toggleFindInFiles: () =>
          set((s) => {
            s.findInFilesOpen = !s.findInFilesOpen;
          }),
        setFindInFilesOpen: (open) =>
          set((s) => {
            s.findInFilesOpen = open;
          }),
        setRightRailTab: (tab) =>
          set((s) => {
            s.rightRailTab = tab;
          }),
        toggleLeftRail: () =>
          set((s) => {
            s.leftRailCollapsed = !s.leftRailCollapsed;
          }),
        toggleRightRail: () =>
          set((s) => {
            s.rightRailCollapsed = !s.rightRailCollapsed;
          }),
        setLeftRailWidth: (px) =>
          set((s) => {
            s.leftRailWidth = clampRailWidth(px);
          }),
        setRightRailWidth: (px) =>
          set((s) => {
            s.rightRailWidth = clampRailWidth(px);
          }),
        revealActiveFile: () => {
          const path = activeFilePath(get());
          if (path === null) return;
          // Longest-root match, so nested roots resolve to the deepest owner —
          // the same subtree the WorkspaceTree consumer will claim the request in.
          const root = rootContaining(workspaceRoots(get()), path);
          const expandRoot = root !== null && get().collapsedRoots.has(root);
          set((s) => {
            // Make the target visible before asking the tree to walk to it.
            s.rightRailCollapsed = false;
            s.rightRailTab = "files";
            if (expandRoot && root !== null) s.collapsedRoots.delete(root);
            s.fileReveal = { path, token: (s.fileReveal?.token ?? 0) + 1, root };
          });
          // Only the root un-collapse is durable layout state (`collapsedRoots`
          // persists across restarts); the reveal itself is transient. Persist in
          // the wrapper, and only when something durable changed.
          if (expandRoot) persistLayoutPrefs(get);
        },
      },

      apiActions: {
        createApiRequest: () => {
          const id = newId();
          set((s) => {
            s.apiRequests[id] = {
              id,
              method: "GET",
              url: "",
              headers: [],
              body: "",
              bodyHistory: { past: [], future: [], at: 0 },
              response: null,
              sending: false,
              error: null,
              protocol: "http",
              ws: {
                status: "idle",
                connectionId: null,
                messages: [],
                draft: "",
                error: null,
              },
              grpc: {
                // Localhost dev servers are usually plaintext; a safe default for
                // the common case (the panel makes TLS a one-toggle opt-in).
                plaintext: true,
                schema: null,
                service: "",
                method: "",
                listing: false,
                listError: null,
                sending: false,
                response: null,
                error: null,
              },
              compare: {
                enabled: false,
                method: "GET",
                url: "",
                sending: false,
                a: { response: null, error: null },
                b: { response: null, error: null },
                selectedKey: null,
                sortKeys: false,
              },
            };
          });
          return id;
        },

        duplicateApiRequest: (sourceId) => {
          // Minted OUTSIDE the producer, then filled in one set.
          const source = get().apiRequests[sourceId];
          if (!source) return null;
          const id = get().apiActions.createApiRequest();
          set((s) => {
            // Non-null both: `createApiRequest` minted `copy` a statement ago,
            // and `from` was proven to exist before that. A guard here would be
            // an unreachable branch, which the coverage gate flagged.
            const copy = s.apiRequests[id]!;
            const from = s.apiRequests[sourceId]!;
            copy.method = from.method;
            copy.url = from.url;
            copy.body = from.body;
            copy.protocol = from.protocol;
            // Fresh row ids: two requests sharing a header row id would have the
            // editors write over each other the moment either is edited.
            copy.headers = from.headers.map((h) => ({
              id: newId(),
              name: h.name,
              value: h.value,
              enabled: h.enabled,
            }));
            // gRPC's picker selection travels too, so a duplicated gRPC call
            // opens ready to send rather than half-configured.
            copy.grpc.service = from.grpc.service;
            copy.grpc.method = from.grpc.method;
            // Not copied: response, error, sending flag, body history. The copy
            // was never sent, and Cmd+Z must not replay the original's edits.
          });
          return id;
        },

        patchApiRequest: (id, patch) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            // Every body writer goes through here — typing, Format, a pasted
            // curl, loading a saved request — so this is the one place that has
            // to record history, and all of them become undoable for free.
            if (patch.body !== undefined && patch.body !== req.body) {
              recordBodyEdit(req, Date.now());
            }
            Object.assign(req, patch);
          }),

        undoApiBody: (id) =>
          set((s) => {
            const req = s.apiRequests[id];
            const previous = req?.bodyHistory.past.pop();
            if (!req || previous === undefined) return;
            req.bodyHistory.future.push(req.body);
            req.body = previous;
            // Zeroed so the next keystroke starts a NEW group rather than
            // coalescing into the one we just stepped out of.
            req.bodyHistory.at = 0;
          }),

        redoApiBody: (id) =>
          set((s) => {
            const req = s.apiRequests[id];
            const next = req?.bodyHistory.future.pop();
            if (!req || next === undefined) return;
            req.bodyHistory.past.push(req.body);
            req.body = next;
            req.bodyHistory.at = 0;
          }),

        addHeader: (id) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req)
              req.headers.push({
                id: newId(),
                name: "",
                value: "",
                enabled: true,
              });
          }),

        updateHeader: (id, headerId, patch) =>
          set((s) => {
            const row = s.apiRequests[id]?.headers.find(
              (h) => h.id === headerId,
            );
            if (row) Object.assign(row, patch);
          }),

        removeHeader: (id, headerId) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.headers = req.headers.filter((h) => h.id !== headerId);
          }),

        setApiSending: (id, sending) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.sending = sending;
          }),

        setApiResponse: (id, response) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.response = response;
            req.error = null;
            req.sending = false;
          }),

        setApiError: (id, error) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.error = error;
            req.sending = false;
          }),

        // ── A/B compare (HTTP lane) ──

        setCompareEnabled: (id, enabled) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.compare.enabled = enabled;
          }),

        patchCompare: (id, patch) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) Object.assign(req.compare, patch);
          }),

        setCompareSending: (id, sending) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.compare.sending = sending;
            // A fresh run must not render one stale side next to one live one.
            if (sending) {
              req.compare.a = { response: null, error: null };
              req.compare.b = { response: null, error: null };
            }
          }),

        setCompareResponse: (id, side, response) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.compare[side] = { response, error: null };
          }),

        setCompareError: (id, side, error) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.compare[side] = { response: null, error };
          }),

        setCompareSelectedKey: (id, key) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.compare.selectedKey = key;
          }),

        setCompareSortKeys: (id, sortKeys) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.compare.sortKeys = sortKeys;
          }),

        // ── durable store: collections + environments ──
        // The READ side: no persist (this IS what Rust just handed us).
        hydrateApiStore: (store) =>
          set((s) => {
            s.apiCollections = store.collections;
            s.apiEnvironments = store.environments;
            s.activeEnvironmentId = store.activeEnvironmentId;
            // Taken as-is: Rust returns `folders` already in display order, and a
            // second sort here is exactly the duplicate ordering this slice avoids.
            s.apiFolders = store.folders;
            s.apiStoreLoaded = true;
          }),

        saveRequestToCollection: (requestId, name) => {
          set((s) => {
            const req = s.apiRequests[requestId];
            if (!req) return;
            // Placeholders stay literal (a `{{TOKEN}}` never becomes the secret);
            // header rows collapse to the wire {name,value} shape.
            const saved: SavedRequest = {
              id: newId(),
              name,
              method: req.method,
              url: req.url,
              headers: req.headers.map((h) => ({
                name: h.name,
                value: h.value,
              })),
              body: req.body,
              protocol: req.protocol,
              // The gRPC tail is snapshotted only for a gRPC request, so an HTTP/WS
              // save stays clean (matches the Rust `skip_serializing_if` contract).
              ...(req.protocol === "grpc"
                ? {
                    grpcService: req.grpc.service,
                    grpcMethod: req.grpc.method,
                    plaintext: req.grpc.plaintext,
                  }
                : {}),
            };
            const i = s.apiCollections.findIndex((c) => c.name === name);
            if (i >= 0) s.apiCollections[i] = saved;
            else s.apiCollections.push(saved);
          });
          persistApiStore(get());
        },

        deleteCollection: (id) => {
          set((s) => {
            s.apiCollections = s.apiCollections.filter((c) => c.id !== id);
          });
          persistApiStore(get());
        },

        loadCollectionIntoRequest: (collectionId, requestId) =>
          set((s) => {
            const saved = s.apiCollections.find((c) => c.id === collectionId);
            const req = s.apiRequests[requestId];
            if (!saved || !req) return;
            req.method = saved.method;
            req.url = saved.url;
            // Each saved header becomes a fresh enabled row (the collection has
            // no enabled/id — it is on-wire {name,value} only).
            req.headers = saved.headers.map((h) => ({
              id: newId(),
              name: h.name,
              value: h.value,
              enabled: true,
            }));
            req.body = saved.body;
            // Restore the surface the request was saved on. A legacy
            // entry with no `protocol` is HTTP. The gRPC tail restores the picker
            // selection + transport so a saved gRPC call re-opens ready to send.
            req.protocol = saved.protocol ?? "http";
            if (saved.protocol === "grpc") {
              req.grpc.service = saved.grpcService ?? "";
              req.grpc.method = saved.grpcMethod ?? "";
              req.grpc.plaintext = saved.plaintext ?? false;
            }
          }),

        openSavedRequest: (collectionId) => {
          const saved = get().apiCollections.find((c) => c.id === collectionId);
          if (!saved) return null;
          // Composed via get() from pure api and layout actions, never nested in a producer.
          const rid = get().apiActions.createApiRequest();
          get().apiActions.loadCollectionIntoRequest(collectionId, rid);
          const tabId = get().layoutActions.openApiRequestTab(rid);
          get().layoutActions.renameTab(tabId, saved.name);
          return tabId;
        },

        saveActiveApiRequest: () => {
          const s = get();
          const tabId = targetLeaf(s, s.focusedPaneId).activeTabId;
          if (!tabId) return false;
          const tab = s.tabs[tabId];
          if (!tab || tab.ref.kind !== "api-request") return false;
          const requestId = tab.ref.requestId;
          // A user-renamed tab already names the request → save straight to
          // Collections. A tab still on the default title has no name to use, so
          // open the dialog (`saveRequestPrompt`) instead of guessing one.
          const custom = tab.customTitle?.trim();
          if (custom) {
            s.apiActions.saveRequestToCollection(requestId, custom);
          } else {
            set((d) => {
              d.saveRequestPrompt = { requestId, tabId };
            });
          }
          return true;
        },

        confirmSaveRequestName: (name) => {
          const prompt = get().saveRequestPrompt;
          const trimmed = name.trim();
          // Guard: an empty name never lands (the dialog disables confirm on empty,
          // this is the belt-and-braces). Save, retitle the tab so it reads as its
          // saved name, then close the dialog.
          if (prompt && trimmed) {
            get().apiActions.saveRequestToCollection(prompt.requestId, trimmed);
            get().layoutActions.renameTab(prompt.tabId, trimmed);
          }
          set((s) => {
            s.saveRequestPrompt = null;
          });
        },

        cancelSaveRequestName: () =>
          set((s) => {
            s.saveRequestPrompt = null;
          }),

        // ── request history ──
        // READ side: no persist (this IS what Rust just handed us).
        hydrateApiHistory: (store) =>
          set((s) => {
            s.apiHistory = store.entries;
            s.apiHistoryLoaded = true;
          }),

        recordApiHistory: (entry) => {
          // Mint the id in the wrapper (Immer producers stay pure). Append —
          // never cap, never dedup (no limit, no cache).
          const withId: HistoryEntry = { ...entry, id: newId() };
          set((s) => {
            s.apiHistory.push(withId);
          });
          persistApiHistory(get());
        },

        clearApiHistory: () => {
          set((s) => {
            s.apiHistory = [];
          });
          persistApiHistory(get());
        },

        loadHistoryIntoRequest: (entryId, requestId) =>
          set((s) => {
            const entry = s.apiHistory.find((e) => e.id === entryId);
            const req = s.apiRequests[requestId];
            if (!entry || !req) return;
            req.method = entry.method;
            req.url = entry.url;
            // Each recorded header becomes a fresh enabled row (history stores the
            // on-wire {name,value} only — `{{VAR}}` kept literal).
            req.headers = entry.headers.map((h) => ({
              id: newId(),
              name: h.name,
              value: h.value,
              enabled: true,
            }));
            req.body = entry.body;
            // gRPC entry: restore protocol, endpoint, service and method; no protocol = HTTP.
            if (entry.protocol === "grpc") {
              req.protocol = "grpc";
              req.grpc.service = entry.grpcService ?? "";
              req.grpc.method = entry.method;
            }
          }),

        importCurl: (requestId, parsed) =>
          set((s) => {
            const req = s.apiRequests[requestId];
            if (!req) return;
            req.method = parsed.method;
            req.url = parsed.url;
            req.headers = parsed.headers.map((h) => ({
              id: newId(),
              name: h.name,
              value: h.value,
              enabled: true,
            }));
            req.body = parsed.body ?? "";
          }),

        addEnvironment: (name) => {
          const id = newId();
          set((s) => {
            s.apiEnvironments.push({ id, name, variables: [] });
          });
          persistApiStore(get());
          return id;
        },

        renameEnvironment: (id, name) => {
          set((s) => {
            const env = s.apiEnvironments.find((e) => e.id === id);
            if (env) env.name = name;
          });
          persistApiStore(get());
        },

        deleteEnvironment: (id) => {
          set((s) => {
            s.apiEnvironments = s.apiEnvironments.filter((e) => e.id !== id);
            // A dangling active pointer would substitute a deleted env's vars;
            // clear it when the active env is the one removed.
            if (s.activeEnvironmentId === id) s.activeEnvironmentId = null;
          });
          persistApiStore(get());
        },

        setActiveEnvironment: (id) => {
          set((s) => {
            s.activeEnvironmentId = id;
          });
          persistApiStore(get());
        },

        setEnvVar: (envId, key, value) => {
          set((s) => {
            const env = s.apiEnvironments.find((e) => e.id === envId);
            if (!env) return;
            const existing = env.variables.find((v) => v.key === key);
            if (existing) existing.value = value;
            else env.variables.push({ key, value });
          });
          persistApiStore(get());
        },

        removeEnvVar: (envId, key) => {
          set((s) => {
            const env = s.apiEnvironments.find((e) => e.id === envId);
            if (env) env.variables = env.variables.filter((v) => v.key !== key);
          });
          persistApiStore(get());
        },

        // ── saved-request folders ──
        // Ask Rust (re-read, mutate, atomic write, return the WHOLE store), then hydrate;
        // never mutate here and blob-save, which loses updates.

        refreshApiStore: async () => {
          const store = await readApiStore();
          // `null` means the READ failed, which is not the same as "the file is empty".
          // Hydrating an empty store here would blank the mirror, and the next blob save
          // would write that blank over the user's real file.
          if (store) get().apiActions.hydrateApiStore(store);
        },

        createApiFolder: async (name) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          const next = await createApiFolderIpc(trimmed);
          if (next) get().apiActions.hydrateApiStore(next);
        },

        renameApiFolder: async (id, name) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          const next = await renameApiFolderIpc(id, trimmed);
          if (next) get().apiActions.hydrateApiStore(next);
        },

        deleteApiFolder: async (id) => {
          const next = await deleteApiFolderIpc(id);
          if (next) get().apiActions.hydrateApiStore(next);
          // The collapse entry goes with it. Left behind it would be inert (it names
          // nothing), but a folder created later could never reuse the id, and a prefs
          // file that only grows is a small leak with no upside.
          set((s) => {
            s.collapsedApiFolders.delete(id);
          });
          persistLayoutPrefs(get);
        },

        moveRequestToFolder: async (requestId, folderId) => {
          const next = await moveRequestToFolderIpc(requestId, folderId);
          if (next) get().apiActions.hydrateApiStore(next);
        },

        moveApiFolder: async (id, beforeId) => {
          // `moveBefore` is the repo's ONE list-move (property-tested, shared with both
          // rails' folder drags). Rust validates that what comes back is a permutation
          // of what it holds, so a stale rail is refused rather than silently applied.
          const ids = moveBefore(
            get().apiFolders.map((f) => f.id),
            id,
            beforeId,
          );
          const next = await reorderApiFoldersIpc(ids);
          if (next) get().apiActions.hydrateApiStore(next);
        },

        toggleApiFolderCollapsed: (id) => {
          set((s) => {
            if (s.collapsedApiFolders.has(id)) s.collapsedApiFolders.delete(id);
            else s.collapsedApiFolders.add(id);
          });
          persistLayoutPrefs(get);
        },

        // ── WebSocket console ──
        // Pure status transitions; the console (WsConsole.tsx) runs the ws_*
        // EFFECTS and stamps every log entry's `at`, so these stay deterministic.
        setApiProtocol: (id, protocol) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.protocol = protocol;
          }),

        wsConnecting: (id) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.ws.status = "connecting";
            req.ws.connectionId = null;
            req.ws.error = null;
          }),

        wsOpened: (id) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.ws.status = "open";
          }),

        wsConnected: (id, connectionId) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.ws.connectionId = connectionId;
          }),

        wsClosed: (id, note) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.ws.status = "closed";
            req.ws.connectionId = null;
            if (note !== undefined)
              req.ws.messages.push({ dir: "sys", data: note, at: 0 });
          }),

        wsErrored: (id, message) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.ws.status = "error";
            req.ws.error = message;
            req.ws.connectionId = null;
          }),

        wsAppendMessage: (id, entry) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.ws.messages.push(entry);
          }),

        setWsDraft: (id, text) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.ws.draft = text;
          }),

        // ── gRPC console (native tonic) ──
        // Pure status transitions; GrpcConsole.tsx runs the grpc_* effects.
        setGrpcPlaintext: (id, plaintext) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.grpc.plaintext = plaintext;
          }),

        grpcListing: (id) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.grpc.listing = true;
            req.grpc.listError = null;
          }),

        grpcListed: (id, schema) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.grpc.schema = schema;
            req.grpc.listing = false;
            req.grpc.listError = null;
            // Keep a still-valid selection; otherwise reset it (the reflected schema
            // may no longer expose the previously-picked service/method).
            const stillValid = schema.services.some(
              (svc) =>
                svc.name === req.grpc.service &&
                svc.methods.some((m) => m.name === req.grpc.method),
            );
            if (!stillValid) {
              req.grpc.service = "";
              req.grpc.method = "";
            }
          }),

        grpcListError: (id, message) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.grpc.listing = false;
            req.grpc.listError = message;
          }),

        setGrpcService: (id, service) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.grpc.service = service;
            // The method list depends on the service, so a new service clears it.
            req.grpc.method = "";
          }),

        setGrpcMethod: (id, method) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.grpc.method = method;
          }),

        setGrpcSending: (id, sending) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (req) req.grpc.sending = sending;
          }),

        setGrpcResponse: (id, response) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.grpc.response = response;
            req.grpc.error = null;
            req.grpc.sending = false;
          }),

        setGrpcError: (id, error) =>
          set((s) => {
            const req = s.apiRequests[id];
            if (!req) return;
            req.grpc.error = error;
            req.grpc.sending = false;
          }),
      },

      /* ───────────────────────────── request sequences ─────────────────────────────
       * Editing + run bookkeeping ONLY. The running lives in
       * `features/api/sequenceExecute.ts`, so nothing here ever sends. */
      sequenceActions: {
        createSequence: () => {
          const id = newId();
          set((s) => {
            s.sequences[id] = {
              id,
              name: "New sequence",
              steps: [],
              running: false,
              // Default ON: in a chained flow a later step is usually meaningless
              // once an earlier one failed. It is a toggle because both
              // behaviours are needed.
              stopOnFailure: true,
              expandedStepId: null,
              captured: {},
            };
          });
          return id;
        },

        addSequenceStep: (sequenceId) => {
          // The request is minted OUTSIDE the producer — `createApiRequest`
          // is itself an action with its own `set`.
          const requestId = get().apiActions.createApiRequest();
          const stepId = newId();
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (!seq) return;
            seq.steps.push({
              id: stepId,
              requestId,
              captures: [],
              expectStatus: null,
              outcome: "idle",
              failure: null,
              capturedPreview: {},
            });
            // A brand-new step is the one you want to fill in, so open it.
            seq.expandedStepId = stepId;
          });
          return stepId;
        },

        removeSequenceStep: (sequenceId, stepId) => {
          // Read the owned request id BEFORE the producer removes the step.
          const owned = get().sequences[sequenceId]?.steps.find((t) => t.id === stepId)?.requestId;
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (!seq) return;
            seq.steps = seq.steps.filter((t) => t.id !== stepId);
            if (seq.expandedStepId === stepId) seq.expandedStepId = null;
            // The step OWNED this request; leaving it behind would leak one into
            // `apiRequests` for the life of the process on every removal.
            if (owned !== undefined) delete s.apiRequests[owned];
          });
        },

        moveSequenceStep: (sequenceId, stepId, beforeStepId) =>
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (!seq) return;
            // `moveBefore` is the repo's ONE list-move primitive (property-tested,
            // shared with the folder rails) — never a second implementation.
            const order = moveBefore(
              seq.steps.map((t) => t.id),
              stepId,
              beforeStepId,
            );
            const byId = new Map(seq.steps.map((t) => [t.id, t]));
            // Non-null: `moveBefore` only ever permutes the ids it was given, so
            // every id in `order` is a key of `byId`. A `?? []` here would be an
            // unreachable branch, which the coverage gate would (correctly) flag.
            seq.steps = order.map((id) => byId.get(id)!);
          }),

        setSequenceName: (sequenceId, name) =>
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (seq) seq.name = name;
          }),

        setStopOnFailure: (sequenceId, value) =>
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (seq) seq.stopOnFailure = value;
          }),

        expandSequenceStep: (sequenceId, stepId) =>
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (seq) seq.expandedStepId = stepId;
          }),

        setStepExpectStatus: (sequenceId, stepId, status) =>
          set((s) => {
            const step = s.sequences[sequenceId]?.steps.find((t) => t.id === stepId);
            if (step) step.expectStatus = status;
          }),

        addStepCapture: (sequenceId, stepId) =>
          set((s) => {
            const step = s.sequences[sequenceId]?.steps.find((t) => t.id === stepId);
            if (step) step.captures.push({ id: newId(), name: "", path: "" });
          }),

        setStepCapture: (sequenceId, stepId, captureId, patch) =>
          set((s) => {
            const step = s.sequences[sequenceId]?.steps.find((t) => t.id === stepId);
            const cap = step?.captures.find((c) => c.id === captureId);
            if (!cap) return;
            if (patch.name !== undefined) cap.name = patch.name;
            if (patch.path !== undefined) cap.path = patch.path;
          }),

        removeStepCapture: (sequenceId, stepId, captureId) =>
          set((s) => {
            const step = s.sequences[sequenceId]?.steps.find((t) => t.id === stepId);
            if (step) step.captures = step.captures.filter((c) => c.id !== captureId);
          }),

        setStepOutcome: (sequenceId, stepId, outcome, failure, capturedPreview) =>
          set((s) => {
            const step = s.sequences[sequenceId]?.steps.find((t) => t.id === stepId);
            if (!step) return;
            step.outcome = outcome;
            step.failure = failure;
            step.capturedPreview = capturedPreview;
          }),

        setSequenceRunning: (sequenceId, running) =>
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (seq) seq.running = running;
          }),

        mergeSequenceCaptured: (sequenceId, values) =>
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (seq) seq.captured = { ...seq.captured, ...values };
          }),

        resetSequenceRun: (sequenceId) =>
          set((s) => {
            const seq = s.sequences[sequenceId];
            if (!seq) return;
            for (const step of seq.steps) {
              step.outcome = "idle";
              step.failure = null;
              step.capturedPreview = {};
            }
            // The capture bag goes too: a fresh run that inherited the previous
            // run's token could pass on a credential the run never actually
            // obtained — a green that the next person cannot reproduce.
            seq.captured = {};
          }),
      },

      /* ────────────────── database client ────────────────────────
       * Every action is an async wrapper: IPC outside any `set`, result applied in one. */
      dbActions: {
        loadDbStore: async () => {
          // One-shot. Not a module latch: the flag lives in state, so it re-arms between
          // tests and a failed load (which does NOT set it) is retried on the next mount.
          if (get().dbLoaded) return;
          try {
            const [engines, store] = await Promise.all([
              loadDbEngines(),
              dbConnectionsLoad(),
            ]);
            get().dbActions.hydrateDbStore(engines, store);
          } catch (e) {
            const message = dbErrorMessage(e);
            set((s) => {
              s.dbError = message;
            });
          }
        },

        showAgentDbConnection: async ({ connectionId, terminalId, created }) => {
          const agent = agentName(get().agents[terminalId as AgentId]);
          set((s) => {
            s.dbLoaded = false;
            s.apiStoreLoaded = false;
            s.rightRailCollapsed = false;
            s.rightRailTab = "db";
            s.dbAgentNotice = {
              connectionId,
              created,
              agent,
            };
          });
          // A mounted panel only loads on mount, so re-issue it; it never rejects.
          await get().dbActions.loadDbStore();
        },

        showAgentDbQuery: async ({ connectionId, terminalId, query, error, outcome, results }) => {
          // The connection record names the tab and configures the console; a no-op when loaded,
          // and it never rejects.
          await get().dbActions.loadDbStore();
          const agent = agentName(get().agents[terminalId as AgentId]);
          set((s) => {
            const c = (s.dbConsoles[connectionId] ??= blankDbConsole());
            const offer = putOrOffer(c, query);
            const console_ = c.running
              ? "busy"
              : s.dbSessions[connectionId]?.status === "open"
                ? "shown"
                : "closed";
            // The user's own run holds the console: its results stay theirs.
            if (!c.running) {
              c.results = results;
              c.error = null;
            }
            s.rightRailCollapsed = false;
            s.rightRailTab = "db";
            s.dbAgentNotice = {
              connectionId,
              created: false,
              agent,
              ran: { query, error, outcome, console: console_ },
              ...(offer === null ? {} : { offer }),
            };
            const open = Object.values(s.tabs).some(
              (t) => t.ref.kind === "db-console" && t.ref.connectionId === connectionId,
            );
            if (open) return;
            const tabId = asTabId(newId());
            s.tabs[tabId] = {
              id: tabId,
              kind: "db-console",
              title: s.dbConnections.find((x) => x.id === connectionId)?.name ?? "Database",
              ref: { kind: "db-console", connectionId },
            };
            const leaf = targetLeaf(s, s.focusedPaneId);
            leaf.tabIds.push(tabId);
            if (leaf.activeTabId === null) activateTab(s, tabId);
          });
          if (results.some((r) => r.kind === "affected")) {
            get().dbActions.refreshDbTree(connectionId);
          }
        },

        offerAgentDbQuery: ({ connectionId, terminalId, query }) => {
          const agent = agentName(get().agents[terminalId as AgentId]);
          set((s) => {
            s.rightRailCollapsed = false;
            s.rightRailTab = "db";
            s.dbAgentNotice = {
              connectionId,
              created: false,
              agent,
              offer: query,
            };
          });
        },

        putAgentDbQueryInConsole: () => {
          const notice = get().dbAgentNotice;
          if (notice?.offer === undefined) return;
          const { connectionId, offer } = notice;
          get().layoutActions.openDbConsoleTab(connectionId);
          set((s) => {
            const c = (s.dbConsoles[connectionId] ??= blankDbConsole());
            c.text = offer;
            c.savedQuery = null;
            c.saveError = null;
            s.dbAgentNotice = null;
          });
        },

        dismissDbAgentNotice: () =>
          set((s) => {
            s.dbAgentNotice = null;
          }),

        hydrateDbStore: (engines, store) =>
          set((s) => {
            s.dbEngines = engines;
            s.dbConnections = store.connections;
            s.dbLoaded = true;
            s.dbError = null;
          }),

        upsertDbConnection: async (draft, password, id) => {
          let saved: DbConnection;
          try {
            // The draft and the password are SEPARATE arguments all the way down. There is
            // no point on this path where a secret is inside a record.
            saved = await dbConnectionUpsert(connectionInput(draft, id), password);
          } catch (e) {
            // Rethrow with the mapped sentence: the dialog renders what it catches, and a
            // driver message can carry the DSN. `cause` keeps the original, already redacted.
            throw new Error(dbErrorMessage(e), { cause: e });
          }
          set((s) => {
            // Replace in place when Rust returned an id we already hold — which is how an
            // edit keeps its position in the list instead of jumping to the bottom.
            const at = s.dbConnections.findIndex((c) => c.id === saved.id);
            if (at === -1) s.dbConnections.push(saved);
            else s.dbConnections[at] = saved;
            // Drop the session mirror and tree on every edit, even a rename (Rust closed the
            // real session): the password can change with `passwordRef` unchanged. Console text,
            // saved queries and tree order survive; `deleteDbConnection` drops all three.
            delete s.dbSessions[saved.id];
            delete s.dbTrees[saved.id];
            s.dbError = null;
          });
          // `db_connection_upsert` writes the password into api-store.json, which the API
          // slice rewrites wholesale; re-read it (awaited) before anything saves it back.
          await get().apiActions.refreshApiStore();
          return saved;
        },

        deleteDbConnection: async (id) => {
          let removed: boolean;
          try {
            // Rust closes the connection's live sessions before it removes the record, so
            // there is nothing to close here — only our mirror to drop.
            removed = (await dbConnectionDelete(id)).removed;
          } catch (e) {
            const message = dbErrorMessage(e);
            set((s) => {
              s.dbError = message;
            });
            return;
          }
          set((s) => {
            s.dbConnections = s.dbConnections.filter((c) => c.id !== id);
            delete s.dbSessions[id];
            // The subtree and the saved-query list go with it. Rust cascades the queries on
            // disk (`db_connection_delete` → `remove_for_connection`), so keeping our copy
            // would leave a list in memory of queries that no longer exist anywhere.
            delete s.dbTrees[id];
            delete s.dbSavedQueries[id];
            // Rust already removed the tree order on disk; keeping it here could hand it to a
            // future connection minted with the same id.
            delete s.dbTreeOrders[id];
            // And the console, plus its open "name this query" dialog: `db_saved_query_upsert`
            // does not validate `connectionId`, so confirming it would write an orphan query.
            delete s.dbConsoles[id];
            if (s.dbSaveQueryPrompt?.connectionId === id) s.dbSaveQueryPrompt = null;
            // `removed: false` means the record was not there — our list was stale, and the
            // same filter is the repair. Said out loud rather than passed over: the row
            // vanishing either way would make a stale list indistinguishable from a delete.
            s.dbError = removed ? null : DB_ALREADY_GONE_NOTE;
          });
        },

        openDbSession: async (id) => {
          const conn = get().dbConnections.find((c) => c.id === id);
          if (conn === undefined) {
            set((s) => {
              s.dbSessions[id] = failedSession(dbErrorMessage("not-found"));
            });
            return;
          }
          set((s) => {
            s.dbSessions[id] = {
              status: "opening",
              sessionId: null,
              serverVersion: null,
              latencyMs: null,
              error: null,
            };
          });
          try {
            // One dial: `db_open` returns the version and latency from the connection it keeps.
            // `password: null`: Rust resolves a saved `{{VAR}}`; with nothing stored it is `auth`.
            const opened = await dbOpen(id, null);
            set((s) => {
              s.dbSessions[id] = {
                status: "open",
                sessionId: opened.sessionId,
                serverVersion: opened.serverVersion,
                latencyMs: opened.latencyMs,
                error: null,
              };
            });
          } catch (e) {
            // Rust's own sentence: `db_open`'s `DbError.message` is the same mapped, redacted prose
            // as `DbTestResult.error`, and more specific than our code mapping. Decided for this
            // call site only, not by widening `DETAIL_IS_THE_ANSWER`.
            const failure = describeDbFailure(e);
            const message = splitDbError(e).detail ?? failure.message;
            set((s) => {
              s.dbSessions[id] = failedSession(message);
            });
          }
        },

        closeDbSession: async (id) => {
          const sessionId = get().dbSessions[id]?.sessionId ?? null;
          // Drop the mirror FIRST, so the row reads "not connected" the instant the user
          // asks — the close is a round trip, and a row that stays "open" for its duration
          // invites a second click on a session that is already going away.
          set((s) => {
            delete s.dbSessions[id];
            // The cached tree dies with its session (its refs address an invalid id); saved
            // queries survive, keyed by connection and read without a session.
            delete s.dbTrees[id];
          });
          if (sessionId === null) return;
          try {
            await dbClose(sessionId);
          } catch {
            // The only swallow in this slice: `db_close` is idempotent, so a rejection is a
            // transport failure on a session already shown closed; nothing for the user to do.
          }
        },

        openDbDialog: (connectionId) =>
          set((s) => {
            s.dbDialog = { connectionId };
          }),

        closeDbDialog: () =>
          set((s) => {
            s.dbDialog = null;
          }),

        setDbConsoleText: (id, text) =>
          set((s) => {
            const c = (s.dbConsoles[id] ??= blankDbConsole());
            c.text = text;
          }),

        setDbConsoleSplit: (id, fraction) =>
          set((s) => {
            const c = (s.dbConsoles[id] ??= blankDbConsole());
            // The console's own `clampSplit`, so store and divider agree on bounds; it also
            // absorbs a non-finite value that as `flex-grow` would silently collapse a pane.
            c.splitFraction = clampSplit(fraction);
          }),

        runDbQuery: async (id, mode, text) => {
          const console_ = get().dbConsoles[id] ?? blankDbConsole();
          const session = get().dbSessions[id];
          // What the caller asked for, or the whole buffer when it did not ask. The fallback
          // is what keeps every existing caller (and Script) working unchanged.
          const sql = text ?? console_.text;
          // A blank buffer is not an error and not a round trip: the toolbar already
          // disables Run, and a keyboard shortcut must agree with the button it mirrors.
          if (sql.trim() === "") return;
          const connection = get().dbConnections.find((c) => c.id === id);
          // Both the connection and an open session are required: the row limit is the
          // connection's, and an engine default would silently run under a different cap.
          if (
            connection === undefined ||
            session?.status !== "open" ||
            session.sessionId === null
          ) {
            set((s) => {
              const c = (s.dbConsoles[id] ??= blankDbConsole());
              c.running = false;
              // `not-found` is the code: its sentence covers a missing connection or session.
              c.error = dbFailure("not-found");
              c.results = [];
            });
            return;
          }
          const sessionId = session.sessionId;
          // Taken BEFORE the await and compared after: this token is the whole mechanism
          // by which a stopped (or superseded) run's reply is thrown away instead of
          // overwriting the newer one's.
          const token = console_.runToken + 1;
          const rowLimit = connection.rowLimit;
          set((s) => {
            const c = (s.dbConsoles[id] ??= blankDbConsole());
            c.running = true;
            c.runToken = token;
            c.error = null;
            // Cleared, not kept: leaving the previous run's rows on screen under a spinner
            // reads as "these are the results", and the user cannot tell which run they
            // belong to.
            c.results = [];
          });
          try {
            const results = await dbQuery(sessionId, sql, mode, rowLimit);
            set((s) => {
              const c = s.dbConsoles[id];
              if (c === undefined || c.runToken !== token) return;
              c.results = results;
              c.error = null;
              c.running = false;
            });
            // A write invalidates the object tree (`refreshDbTree`). Key on kind `affected`, which
            // covers DDL (0 or null rows), never `rowsAffected > 0`. Not gated on `runToken`: a
            // stopped run's write still reached the server.
            if (results.some((r) => r.kind === "affected")) {
              get().dbActions.refreshDbTree(id);
            }
          } catch (e) {
            // Both halves of the failure, decided here once. For a statement problem this is
            // Rust's own sentence naming the shape the engine wanted; for everything else it is
            // our sentence for the code. Either way the console renders it and describes nothing.
            const failure = describeDbFailure(e);
            set((s) => {
              const c = s.dbConsoles[id];
              if (c === undefined || c.runToken !== token) return;
              c.error = failure;
              c.running = false;
            });
          }
        },

        stopWaitingForDbQuery: (id) => {
          // 1. Local, immediate, cannot fail: orphan the reply and stop the spinner.
          const sessionId = get().dbSessions[id]?.sessionId ?? null;
          set((s) => {
            const c = s.dbConsoles[id];
            if (c === undefined) return;
            c.runToken += 1;
            c.running = false;
            c.cancelError = null;
          });
          // 2. Ask the server to stop (the effect, in the wrapper). Best-effort: an engine with
          //    no cancel rejects, which becomes a console notice, never a throw.
          if (sessionId === null) return;
          void dbCancel(sessionId).catch((e: unknown) => {
            set((s) => {
              const c = s.dbConsoles[id];
              if (c === undefined) return;
              // Rust's own sentence when present ("no server-side cancel"), as on connect.
              c.cancelError = splitDbError(e).detail ?? dbErrorMessage(e);
            });
          });
        },

        /* ─────────── the object tree and saved queries ─────────────────────── */

        loadDbChildren: async (id, sessionId, node, force = false) => {
          const key = nodeKey(node);
          const tree = get().dbTrees[id] ?? blankDbTree();
          // The cache check IS the "one call per first expand" rule. `force` is Retry, which
          // must get past a cached failure — otherwise the button cannot succeed, which is
          // the sticky-failure shape (a transient failure must never stick).
          if (tree.loading[key] === true) return;
          if (!force && (key in tree.children || tree.failed[key] !== undefined)) return;
          set((s) => {
            const t = (s.dbTrees[id] ??= blankDbTree());
            t.loading[key] = true;
            // Cleared before the attempt, not after it: a stale sentence sitting under a
            // spinner reads as "it failed again" before the call has even answered.
            delete t.failed[key];
          });
          let children: DbTreeNode[];
          try {
            children = await dbChildren(sessionId, node);
          } catch (e) {
            const message = dbErrorMessage(e);
            set((s) => {
              const t = (s.dbTrees[id] ??= blankDbTree());
              delete t.loading[key];
              t.failed[key] = message;
            });
            return;
          }
          set((s) => {
            const t = (s.dbTrees[id] ??= blankDbTree());
            delete t.loading[key];
            // Assigned even when empty: a present entry is the "loaded" marker, so `[]` is
            // how "expand it and find nothing" is told apart from "not read yet".
            t.children[key] = children;
          });
        },

        toggleDbNode: (id, sessionId, node) => {
          const key = nodeKey(node);
          const opening = get().dbTrees[id]?.expanded[key] !== true;
          set((s) => {
            const t = (s.dbTrees[id] ??= blankDbTree());
            if (opening) t.expanded[key] = true;
            else delete t.expanded[key];
          });
          // `loadDbChildren` checks the cache itself. Only server-answered nodes with a session
          // fetch here: Saved queries uses `db_saved_queries`, needing no session (failed connect).
          if (opening && sessionId !== null && isServerAnswered(node)) {
            void get().dbActions.loadDbChildren(id, sessionId, node);
          }
        },

        clearDbTree: (id) =>
          set((s) => {
            delete s.dbTrees[id];
          }),

        refreshDbTree: (id) =>
          set((s) => {
            const t = s.dbTrees[id];
            // Nothing cached, nothing stale. Creating a blank record here would be worse than
            // doing nothing: an entry whose `children` is empty is indistinguishable from
            // "expanded but unread", and the tree would go and fetch a level nobody opened.
            if (t === undefined) return;
            // Presence in `children` IS the loaded marker, so emptying it is the whole of
            // "read every visible level again". `expanded` is deliberately NOT touched — it is
            // the user's shape, and this action exists precisely so it survives.
            t.children = {};
            // A cached failure is stale for the same reason a cached level is: after a write
            // the user is owed a fresh attempt, not last time's error note under a Retry.
            t.failed = {};
            // `loading` is deliberately kept: those calls are already on the wire, and clearing
            // the flag would let a second one start beside the first.
          }),

        loadDbTreeOrder: async (id) => {
          // Never rejects: a missing or unreadable `db-tree-order.json` means alphabetical.
          let levels: DbLevelOrder[];
          try {
            levels = await dbTreeOrder(id);
          } catch {
            return;
          }
          set((s) => {
            const byParent: Record<string, string[]> = {};
            for (const level of levels) byParent[level.parentKey] = level.keys;
            s.dbTreeOrders[id] = byParent;
          });
        },

        moveDbTreeNode: (id, parentKey, moved, before) => {
          // Order from what is displayed (saved order over cached children), so the first
          // drag on an untouched level needs no materialisation step.
          const displayed = applyOrder(
            get().dbTrees[id]?.children[parentKey] ?? [],
            (n) => n.label,
            get().dbTreeOrders[id]?.[parentKey] ?? [],
          ).map((n) => n.label);
          // No rows on screen means no real drag; `moveBefore([], "a", …)` would persist a
          // one-item order pinning that table to the top forever.
          if (displayed.length === 0) return;
          const next = moveTreeNodeBefore(displayed, moved, before);
          // A drag that put the row back where it started writes nothing: no re-render, no
          // file, no chance of a spurious conflict with another level's save.
          if (sameOrder(displayed, next)) return;
          set((s) => {
            (s.dbTreeOrders[id] ??= {})[parentKey] = next;
          });
          // Fire-and-forget like every optimistic write here: a failed preference write is
          // not actionable mid-drag, and the next launch shows what was actually saved.
          void dbTreeOrderSet(id, parentKey, next).catch(() => undefined);
        },

        resetDbTreeOrder: (id, parentKey) => {
          set((s) => {
            const forConnection = s.dbTreeOrders[id];
            if (forConnection !== undefined) delete forConnection[parentKey];
          });
          // An empty `keys` IS the clear — one command for both gestures, so "no custom order"
          // has exactly one representation on disk.
          void dbTreeOrderSet(id, parentKey, []).catch(() => undefined);
        },

        loadDbSavedQueries: async (id) => {
          set((s) => {
            const list = (s.dbSavedQueries[id] ??= blankSavedQueryList());
            list.loading = true;
            list.error = null;
          });
          let queries: SavedQueryRecord[];
          try {
            queries = await dbSavedQueries(id);
          } catch (e) {
            const message = dbErrorMessage(e);
            set((s) => {
              const list = (s.dbSavedQueries[id] ??= blankSavedQueryList());
              list.loading = false;
              list.error = message;
            });
            return;
          }
          set((s) => {
            const list = (s.dbSavedQueries[id] ??= blankSavedQueryList());
            list.loading = false;
            // Replaced, not merged: Rust owns the order (newest-updated first, id tiebreak)
            // and a merge would let a locally-appended record sit in the wrong place.
            list.queries = queries;
          });
        },

        openDbSavedQuery: (id, query) => {
          // The tab first (a layout action, and the same dedupe a double-click uses), then the
          // console's contents. Both are `set`s; neither is an IPC call, so there is no effect
          // to keep out of a producer here.
          get().layoutActions.openDbConsoleTab(id);
          set((s) => {
            const c = (s.dbConsoles[id] ??= blankDbConsole());
            c.text = query.sql;
            // Adopted, so the NEXT ⌘S updates this query instead of asking for a name — the
            // half of "the keystroke means the same thing in both surfaces" that makes
            // an opened query editable rather than a one-way copy.
            c.savedQuery = { id: query.id, name: query.name };
            c.saveError = null;
          });
        },

        openDbQueryInConsole: (id, sql) => {
          get().layoutActions.openDbConsoleTab(id);
          set((s) => {
            const c = (s.dbConsoles[id] ??= blankDbConsole());
            c.text = sql;
            // 🔴 Cleared. A browse statement is a new buffer, and inheriting the previously
            // opened saved query's id would make the next ⌘S overwrite someone's saved SQL
            // with `SELECT * FROM …` and report it as a successful save.
            c.savedQuery = null;
            c.saveError = null;
          });
        },

        saveDbConsoleQuery: async (id) => {
          const c = get().dbConsoles[id];
          const sql = c?.text ?? "";
          // Refused here rather than at the wire: `db_saved_query_upsert` would also refuse an
          // empty buffer, but a round trip to be told what we already know would surface as an
          // error banner on a keystroke the user did not really mean.
          if (sql.trim() === "") return "empty";
          const existing = c?.savedQuery ?? null;
          if (existing === null) {
            set((s) => {
              s.dbSaveQueryPrompt = { connectionId: id, sql };
            });
            return "prompted";
          }
          await get().dbActions.upsertDbSavedQuery(id, existing.id, existing.name, sql);
          return "saved";
        },

        confirmDbSaveQueryName: async (name) => {
          const prompt = get().dbSaveQueryPrompt;
          // Reachable: the dialog's own Enter handler and a stray keystroke can both land here
          // after a close. Doing nothing beats creating a query against a guessed connection.
          if (prompt === null) return;
          // Closed BEFORE the await, so the modal does not sit over the panel for the length
          // of a disk write; a refusal reappears as the console's `saveError`, which is
          // visible without the dialog.
          set((s) => {
            s.dbSaveQueryPrompt = null;
          });
          // The SQL comes from the REQUEST, not from a second read of the console — see the
          // state field's comment. It is also the more correct choice: what the keystroke was
          // about is what gets saved.
          await get().dbActions.upsertDbSavedQuery(
            prompt.connectionId,
            null,
            name,
            prompt.sql,
          );
        },

        cancelDbSaveQueryName: () =>
          set((s) => {
            s.dbSaveQueryPrompt = null;
          }),

        upsertDbSavedQuery: async (id, savedId, name, sql) => {
          let saved: SavedQueryRecord;
          try {
            saved = await dbSavedQueryUpsert({
              id: savedId,
              connectionId: id,
              name,
              sql,
            });
          } catch (e) {
            const message = dbErrorMessage(e);
            set((s) => {
              const c = (s.dbConsoles[id] ??= blankDbConsole());
              c.saveError = message;
            });
            return null;
          }
          set((s) => {
            const c = (s.dbConsoles[id] ??= blankDbConsole());
            c.savedQuery = { id: saved.id, name: saved.name };
            c.saveError = null;
            const list = (s.dbSavedQueries[id] ??= blankSavedQueryList());
            const at = list.queries.findIndex((q) => q.id === saved.id);
            // An update replaces in place (so the list does not jump); a create goes to the
            // FRONT, matching `queries::for_connection`'s newest-updated-first order — the one
            // Rust would send on the next read, so the optimistic list and a reload agree.
            if (at === -1) list.queries.unshift(saved);
            else list.queries[at] = saved;
            list.error = null;
          });
          return saved;
        },

        deleteDbSavedQuery: async (id, savedId) => {
          let removed: boolean;
          try {
            removed = await dbSavedQueryDelete(savedId);
          } catch (e) {
            const message = dbErrorMessage(e);
            set((s) => {
              const list = (s.dbSavedQueries[id] ??= blankSavedQueryList());
              list.error = message;
            });
            return;
          }
          set((s) => {
            const list = (s.dbSavedQueries[id] ??= blankSavedQueryList());
            list.queries = list.queries.filter((q) => q.id !== savedId);
            // Said out loud, exactly as `deleteDbConnection` does: without this a stale list
            // and a real delete look identical, because the row vanishes either way.
            list.error = removed ? null : DB_SAVED_QUERY_ALREADY_GONE_NOTE;
            const c = s.dbConsoles[id];
            // A console editing the deleted query must forget its id, or the next ⌘S would
            // hit `queries.rs`'s stale-id refusal and report a save failure for a query the
            // user deliberately deleted.
            if (c?.savedQuery?.id === savedId) c.savedQuery = null;
          });
        },
      },

      /* ────────────── shareable config bundles ────────────────────────────
       * Async wrappers like the db slice. No passphrase ever lands in state: it is only an
       * argument (`exportBundle`, `inspectBundle`/`unsealImport`, `applyImport`) sent on. */
      portabilityActions: {
        openPortabilityDialog: (which) =>
          set((s) => {
            s.portabilityDialog = which;
          }),

        closePortabilityDialog: () =>
          set((s) => {
            s.portabilityDialog = null;
          }),

        exportBundle: async (options) => {
          // The picker first, and OUTSIDE `busy`: it is a modal OS window, so a spinner
          // behind it would be describing the wrong wait, and a cancel would have to unset a
          // flag it never should have set.
          const destPath = await pickBundleDestination(options.label);
          if (destPath === null) return null;
          set((s) => {
            s.portabilityExport = { busy: true, error: null, done: null };
          });
          let header: BundleHeader;
          try {
            header = await portabilityExport(options, destPath);
          } catch (e) {
            const message = portabilityErrorMessage(e);
            set((s) => {
              s.portabilityExport = { busy: false, error: message, done: null };
            });
            return null;
          }
          set((s) => {
            // `path` is kept next to the header so the summary can say WHERE the file went.
            // A person who just wrote a file containing their config needs to be able to find
            // it, and the picker's answer is the only record of that.
            s.portabilityExport = { busy: false, error: null, done: { header, path: destPath } };
          });
          return header;
        },

        chooseImportFile: async () => {
          const srcPath = await pickBundleSource();
          // Cancelled: nothing changes, and in particular no error is written. A cancel is
          // not a failure, and a dialog that says one happened trains people to ignore it.
          if (srcPath === null) return;
          // A different file means the previous file's plan, choices and result are all void.
          set((s) => {
            s.portabilityImport = { ...initialImportState(), srcPath };
          });
          await get().portabilityActions.inspectBundle(srcPath, null);
        },

        inspectBundle: async (srcPath, passphrase) => {
          set((s) => {
            s.portabilityImport.srcPath = srcPath;
            s.portabilityImport.busy = true;
            // Cleared BEFORE the call, which is what makes a failure non-sticky:
            // the previous attempt's message must not still be on screen while this one runs,
            // or a retry that succeeded still reads as broken.
            s.portabilityImport.error = null;
            // A re-inspect invalidates the last apply's report — it described a plan that is
            // about to be replaced.
            s.portabilityImport.result = null;
          });
          let plan: ImportPlan;
          try {
            plan = await portabilityInspect(srcPath, passphrase);
          } catch (e) {
            const message = portabilityErrorMessage(e);
            set((s) => {
              s.portabilityImport.busy = false;
              s.portabilityImport.error = message;
              // `plan` and `srcPath` deliberately UNTOUCHED: a wrong passphrase must be
              // retryable without reopening the file, so the header-only plan from step 1
              // stays on screen with the passphrase field beside it.
            });
            return;
          }
          set((s) => {
            s.portabilityImport.busy = false;
            s.portabilityImport.plan = plan;
            // A still-sealed plan after a passphrase is a wrong passphrase that resolved (Rust may
            // also reject `bad-passphrase`; both handled). With a null passphrase it is normal.
            s.portabilityImport.error =
              passphrase !== null && !plan.unsealed
                ? describePortabilityError("bad-passphrase")
                : null;
          });
        },

        unsealImport: async (passphrase) => {
          const srcPath = get().portabilityImport.srcPath;
          // No file, nothing to unseal. A guard rather than a throw: the dialog cannot show a
          // passphrase field before a file is chosen, so this is unreachable by gesture — and
          // an unreachable throw out of a click handler is worse than a no-op.
          if (srcPath === null) return;
          await get().portabilityActions.inspectBundle(srcPath, passphrase);
        },

        setImportAction: (itemId, action) =>
          set((s) => {
            s.portabilityImport.overrides[itemId] = action;
          }),

        clearImportActions: () =>
          set((s) => {
            s.portabilityImport.overrides = {};
          }),

        setOverwriteExistingSecrets: (allow) =>
          set((s) => {
            s.portabilityImport.overwriteExistingSecrets = allow;
          }),

        setImportForceReadOnly: (readOnly) =>
          set((s) => {
            s.portabilityImport.forceReadOnly = readOnly;
          }),

        applyImport: async (passphrase) => {
          const { srcPath, overrides, overwriteExistingSecrets, forceReadOnly } =
            get().portabilityImport;
          if (srcPath === null) return null;
          // Built through the IPC module's builder, which COPIES the override map — the store's
          // own object must not be reachable from an in-flight call's arguments.
          const choices = importChoices(overrides, overwriteExistingSecrets, forceReadOnly);
          set((s) => {
            s.portabilityImport.busy = true;
            s.portabilityImport.error = null;
            s.portabilityImport.result = null;
          });
          let result: ImportResult;
          try {
            result = await portabilityImport(srcPath, passphrase, choices);
          } catch (e) {
            const message = portabilityErrorMessage(e);
            set((s) => {
              s.portabilityImport.busy = false;
              s.portabilityImport.error = message;
              // Plan and choices survive: a failed apply is retryable, and re-reviewing an
              // untrusted config from scratch is not a reasonable thing to ask twice.
            });
            return null;
          }
          set((s) => {
            s.portabilityImport.busy = false;
            s.portabilityImport.result = result;
            s.portabilityImport.error = null;
            // Rust rewrote both files under two load-once gates; re-arm them so imported items
            // appear when those panels next mount.
            s.dbLoaded = false;
            s.apiStoreLoaded = false;
          });
          // A mounted DB panel loads only on mount, so reload here (`loadDbStore` never rejects).
          // API/Vault panels load in component effects; the re-armed flag is all we can do.
          void get().dbActions.loadDbStore();
          return result;
        },

        resetImport: () =>
          set((s) => {
            s.portabilityImport = initialImportState();
          }),
      },

      workspaceActions: {
        setWorkspaceRoot: (path) => {
          // Effect first, in the wrapper: re-point the registry's default cwd so
          // a plain "+ New terminal" (which carries no cwd of its own) also
          // opens in the project, not the app binary's dir.
          setDefaultTerminalCwd(path);
          set((s) => {
            s.workspaceRoot = path;
          });
        },

        setRecentProjects: (paths) =>
          set((s) => {
            s.recentProjects = [...paths];
          }),

        addRecentProject: (path) =>
          set((s) => {
            s.recentProjects = [
              path,
              ...s.recentProjects.filter((p) => p !== path),
            ];
          }),

        addBrowseRoot: (path) => {
          // Effect first: authorize `read_dir` by recording the folder in persisted recents
          // (allowed_roots = recents ∪ workspaceRoot). Best-effort: the folder still opens.
          void pushRecentProject(path).catch(() => {
            // Persisting recents is a nicety; never block opening the folder on it.
          });
          // Install the ad-hoc hook (opening a folder spawns no terminal, so a later `claude`
          // there would go undetected). Best-effort; never breaks opening the folder.
          void ensureAgentHooks(path).catch(() => {});
          set((s) => {
            s.browseRoots = [path, ...s.browseRoots.filter((p) => p !== path)];
          });
        },

        removeBrowseRoot: (path) =>
          set((s) => {
            s.browseRoots = s.browseRoots.filter((p) => p !== path);
          }),

        syncFolderOrder: (paths) => {
          let grew = false;
          set((s) => {
            const next = appendMissing(s.folderOrder, paths);
            // `appendMissing` returns the SAME reference when nothing was added, so
            // this both skips the write AND keeps the state reference stable (no
            // spurious re-render / no persist on a quiet telemetry tick).
            if (next === s.folderOrder) return;
            s.folderOrder = next;
            grew = true;
          });
          // Persist only when the order actually grew (a new folder appeared).
          if (grew) persistLayoutPrefs(get);
        },

        moveFolder: (path, targetPath) => {
          set((s) => {
            s.folderOrder = moveBefore(s.folderOrder, path, targetPath);
          });
          persistLayoutPrefs(get);
        },

        toggleRootCollapsed: (path) => {
          set((s) => {
            if (s.collapsedRoots.has(path)) s.collapsedRoots.delete(path);
            else s.collapsedRoots.add(path);
          });
          persistLayoutPrefs(get);
        },

        setFocusFollowsAgent: (on) => {
          set((s) => {
            s.focusFollowsAgent = on;
          });
          // Persist the flag itself (the wrapper effect, never in the producer). This
          // runs unconditionally so the setting sticks even when there is no selection
          // yet — `applyFocusFollow` below may early-return without persisting.
          persistLayoutPrefs(get);
          // Turning it ON takes effect at once for whatever is currently selected.
          if (on) applyFocusFollow();
        },

        setRailGroupStyle: (style) => {
          set((s) => {
            s.railGroupStyle = style;
          });
          persistLayoutPrefs(get);
        },

        applyLayoutPrefs: (prefs) =>
          set((s) => {
            // Pure reconcile — seed from the persisted store, no persist (this IS
            // what Rust just handed us; persisting straight back would be a wasted
            // write). Copy the arrays so the store owns its own mutable state.
            s.folderOrder = [...prefs.folderOrder];
            s.collapsedFolders = new Set(prefs.collapsedFolders);
            s.collapsedRoots = new Set(prefs.collapsedRoots);
            s.focusFollowsAgent = prefs.focusFollowsAgent ?? false;
            // An older file has no style (null/absent), a newer build's may be one this
            // build does not know: both read as the default.
            s.railGroupStyle = parseRailGroupStyle(prefs.railGroupStyle);
            // `?? []` for the same reason `focusFollowsAgent` has `?? false`: a prefs
            // file written by a build before this field existed simply omits it.
            s.collapsedApiFolders = new Set(prefs.collapsedApiFolders ?? []);
          }),
      },

      editorActions: {
        initEditor: (path) =>
          set((s) => {
            if (s.editors[path]) return; // already loaded/loading — keep it
            s.editors[path] = {
              status: "loading",
              editable: false,
              saveError: null,
              savedAt: 0,
              staleOnDisk: false,
              previewZoom: PREVIEW_ZOOM_DEFAULT,
              showSource: false,
            };
          }),

        editorReady: (path, editable) =>
          set((s) => {
            const e = s.editors[path];
            if (!e) return;
            e.status = "ready";
            e.editable = editable;
          }),

        editorFailed: (path) =>
          set((s) => {
            const e = s.editors[path];
            if (e) e.status = "error";
          }),

        setEditorStale: (path, stale) =>
          set((s) => {
            const e = s.editors[path];
            if (e) e.staleOnDisk = stale;
          }),

        setEditorDirty: (path, dirty) =>
          set((s) => {
            const tabId = findEditorTab(s.tabs, path);
            if (tabId) s.tabs[tabId].dirty = dirty;
          }),

        editorSaved: (path) =>
          set((s) => {
            const e = s.editors[path];
            if (e) {
              e.saveError = null;
              e.savedAt += 1;
            }
            const tabId = findEditorTab(s.tabs, path);
            if (tabId) s.tabs[tabId].dirty = false;
          }),

        editorSaveFailed: (path, message) =>
          set((s) => {
            const e = s.editors[path];
            if (e) e.saveError = message;
          }),

        setPreviewZoom: (path, zoom) =>
          set((s) => {
            const e = s.editors[path];
            // `clampPreviewZoom` is the preview's own function, imported rather
            // than re-derived (the `clampSplit` precedent), and it also absorbs
            // non-finite input.
            if (e) e.previewZoom = clampPreviewZoom(zoom);
          }),

        setShowSource: (path, showSource) =>
          set((s) => {
            const e = s.editors[path];
            if (e) e.showSource = showSource;
          }),

        disposeEditor: (path) =>
          set((s) => {
            delete s.editors[path];
          }),

        requestCloseTab: (tabId) => {
          const tab = get().tabs[tabId];
          const isDirtyEditor =
            !!tab && tab.ref.kind === "editor" && !!tab.dirty;
          if (isDirtyEditor) {
            set((s) => {
              s.confirmCloseTab = tabId;
            });
            return;
          }
          // A busy terminal gets its own confirm, here because the tab ✕, middle-click and
          // Cmd/Ctrl+W all route through this junction.
          const terminalId = terminalIdOf(tab);
          if (terminalId) {
            void gateTerminalClose(
              [terminalId],
              { kind: "tab", tabId },
              (pending) => set((s) => void (s.pendingTerminalClose = pending)),
              () => get().layoutActions.closeTab(tabId),
              (id) => plainTerminalTitle(get().tabs, id),
            );
            return;
          }
          get().layoutActions.closeTab(tabId);
        },

        cancelCloseTab: () =>
          set((s) => {
            s.confirmCloseTab = null;
          }),

        closePendingTab: () => {
          const tabId = get().confirmCloseTab;
          set((s) => {
            s.confirmCloseTab = null;
          });
          if (tabId) get().layoutActions.closeTab(tabId);
        },
      },

      lspActions: {
        setLspInstallHint: (languageId, hint) =>
          set((s) => {
            s.lspInstallHints[languageId] = hint;
          }),

        dismissLspHint: (languageId) =>
          set((s) => {
            if (!s.lspDismissedHints.includes(languageId)) {
              s.lspDismissedHints.push(languageId);
            }
          }),

        setLspIndexing: (languageId, indexing) =>
          set((s) => {
            const has = s.lspIndexing.includes(languageId);
            if (indexing && !has) s.lspIndexing.push(languageId);
            else if (!indexing && has) {
              s.lspIndexing = s.lspIndexing.filter((id) => id !== languageId);
            }
          }),

        setReferences: (result) =>
          set((s) => {
            s.lspReferences = result;
          }),

        clearReferences: () =>
          set((s) => {
            s.lspReferences = null;
          }),
      },

      agentActions: {
        createAgent: ({ cwd, title, runtime }) => {
          const agentId = asAgentId(newId());
          const now = Date.now();

          set((s) => {
            upsertAgent(s, {
              id: agentId,
              parentId: null,
              kind: "orchestrator",
              title:
                title ?? cwd.split(/[/\\]/).filter(Boolean).pop() ?? "agent",
              status: "idle",
              branch: "",
              cwd,
              runtime: runtime ?? DEFAULT_RUNTIME,
              startedAt: now,
              finishedAt: null,
              lastActivityAt: now,
              childIds: [],
              sessionId: null,
              expanded: false, // collapsed by default (hydrateAgent is the authority)
              unread: 0,
            });
          });

          // The same path as any terminal tab; agent-ness rides on `ref`. `runtime` must travel
          // with `agentId` or the registry throws rather than hand the user a shell.
          get().layoutActions.openTerminalTab({
            cwd,
            agentId,
            title,
            runtime: runtime ?? DEFAULT_RUNTIME,
          });
          get().agentActions.selectAgent(agentId);
          return agentId;
        },

        selectAgent: (agentId) => {
          set((s) => {
            const agent = s.agents[agentId];
            if (!agent) return;

            // Clear BEFORE the already-selected bail-out: the selected agent can raise a badge
            // while watched, and clicking it must clear it. Unchanged writes are free in Immer.
            clearUnread(s, agentId);

            // The pivot: roots show their terminal, sub-agents (no PTY) an activity view made on
            // first selection. Before the bail-out, so re-clicking brings the view back to front.
            if (agent.kind === "subagent") {
              const activityTab =
                findActivityTab(s.tabs, agentId) ?? openActivityTab(s, agent);
              activateTab(s, activityTab);
            } else {
              const tabId = findAgentTab(s.tabs, agentId);
              if (tabId) activateTab(s, tabId);
            }

            if (s.selection.selectedAgentId === agentId) return;
            s.selection.selectedAgentId = agentId;
            // `activeSessionId` is plumbed for the multi-session milestone; it
            // is set-but-unread in M2 (there is no `sessions` map yet), so the
            // tab-activation above is what actually delivers the focus today.
            s.selection.activeSessionId =
              rootOf(s.agents, agentId)?.sessionId ?? null;
          });
          // "Focus follows agent" (a wrapper effect): outside the producer,
          // because it mutates `collapsedRoots` AND persists. A no-op when the setting
          // is off, so the historical selection semantics are untouched by default.
          applyFocusFollow();
          for (const hook of agentSelectedHooks) hook(agentId);
        },

        toggleAgentExpanded: (agentId) =>
          set((s) => {
            const agent = s.agents[agentId];
            if (!agent) return;
            agent.expanded = !agent.expanded;
          }),

        toggleFolderCollapsed: (path) => {
          set((s) => {
            // Absent => expanded (default). Toggling adds/removes the path.
            if (s.collapsedFolders.has(path)) s.collapsedFolders.delete(path);
            else s.collapsedFolders.add(path);
          });
          // Persist the new collapse state, in the wrapper — never in the
          // producer above.
          persistLayoutPrefs(get);
        },

        moveRootAgent: (agentId, targetAgentId) =>
          set((s) => {
            // Roots only: a sub-agent is not in `rootAgentIds`, so `moveBefore` would
            // simply append it there and surface it as a phantom root. Guard on both.
            if (!s.rootAgentIds.includes(agentId)) return;
            s.rootAgentIds = moveBefore(s.rootAgentIds, agentId, targetAgentId);
          }),

        renameAgent: (agentId, name) => {
          set((s) => {
            const agent = s.agents[agentId];
            if (!agent) return;
            // Empty/whitespace clears the custom name (revert to derived title).
            const trimmed = name?.trim();
            agent.customTitle = trimmed ? trimmed : null;
          });
          // Agent names persist with the center layout, not the pin registry (which knows
          // only pinned roots): one fact, one writer. See `serializeCenterLayout`.
          persistLayoutPrefs(get);
        },

        removeAgent: (agentId) => {
          const unpinned: AgentId[] = [];
          set((s) => removeAgentFromForest(s, agentId, unpinned));
          // Drop any removed pin from the registry (the EFFECT, in the wrapper).
          for (const id of unpinned) void persistUnpin(id);
          // Removing an agent closes its activity tab, which reshapes the tree.
          persistLayoutPrefs(get);
        },

        requestDismissAgent: (agentId) => {
          // The fleet rail's ✕ is the third bypass: it reaches `closeTab`
          // directly, and for an agent terminal the agentId IS the TerminalId.
          void gateTerminalClose(
            [asTerminalId(agentId)],
            { kind: "agent", agentId },
            (pending) => set((s) => void (s.pendingTerminalClose = pending)),
            () => get().agentActions.dismissAgent(agentId),
            (id) => plainTerminalTitle(get().tabs, id),
          );
        },

        dismissAgent: (agentId) => {
          // Close the agent's tab: `closeTab` tears down the PTY and removes the agent (pin
          // cleanup included), so the row ✕ and tab ✕ share one path.
          const tabId = findAgentTab(get().tabs, agentId);
          if (tabId) {
            get().layoutActions.closeTab(tabId);
            return;
          }
          // No tab (a sub-agent, or the tab is gone): remove directly and still kill any live
          // child (its agentId IS the TerminalId; `dispose` is idempotent).
          const unpinned: AgentId[] = [];
          set((s) => removeAgentFromForest(s, agentId, unpinned));
          dispose(asTerminalId(agentId));
          // Unpin any removed pin so it cannot zombie-resurrect next boot.
          for (const id of unpinned) void persistUnpin(id);
          persistLayoutPrefs(get);
        },

        applyFleetSnapshot: (agents) =>
          set((s) => {
            // Upsert, never replace, so a late snapshot keeps expanded/unread. One pass works on
            // the unordered array: early children surface as roots, then get adopted.
            for (const wire of agents) upsertAgent(s, wire);
          }),

        pinAgent: (agentId) => {
          set((s) => {
            const agent = s.agents[agentId];
            // Root-only: sub-agents are transcript-derived, nothing to persist or
            // re-spawn. Defense in depth with AgentRow, which only renders the
            // toggle for a root orchestrator.
            if (!agent || agent.kind !== "orchestrator") return;
            agent.pinned = true;
          });
          // EFFECT (wrapper, never a producer): persist to the registry — but only
          // if the flag actually landed, so a call on a sub-agent/missing record
          // does not issue a spurious `pin_agent`.
          const agent = get().agents[agentId];
          if (agent?.kind === "orchestrator") void persistPin(agentId);
        },

        unpinAgent: (agentId) => {
          set((s) => {
            const agent = s.agents[agentId];
            if (agent) agent.pinned = false;
          });
          // Drop from the registry. Idempotent + best-effort on the Rust side, so
          // firing unconditionally (even for an already-unpinned agent) is safe.
          void persistUnpin(agentId);
        },

        applyRestoredAgents: (views) =>
          set((s) => {
            // Roots only: the restore re-launches roots, and their sub-agents grow
            // back from the transcript with nothing to explain. A view whose row is
            // absent is skipped (no row to mark), exactly like a pin.
            for (const view of views) {
              const agent = s.agents[view.agentId];
              if (agent?.kind !== "orchestrator") continue;
              agent.restored = { outcome: view.outcome, wasWorking: view.wasWorking };
            }
          }),

        applyPinnedAgents: (views) =>
          set((s) => {
            // Flag rows Rust reports pinned; a pin with no row (expired resume, refused
            // spawn) is skipped. No persist.
            for (const view of views) {
              const agent = s.agents[view.agentId];
              if (agent) agent.pinned = true;
            }
          }),

        applyAgentEvent: (event) =>
          set((s) => {
            switch (event.t) {
              case "agent_started": {
                const now = Date.now();
                upsertAgent(s, {
                  id: event.agentId,
                  parentId: event.parentId,
                  kind: event.parentId === null ? "orchestrator" : "subagent",
                  title: event.title,
                  // Roots are born idle (at their prompt, as in Rust); a sub-agent seen
                  // via `agent_started` is born running, since it exists to work.
                  status: event.parentId === null ? "idle" : "running",
                  branch: event.branch,
                  cwd: event.cwd,
                  runtime: event.runtime,
                  startedAt: now,
                  finishedAt: null,
                  lastActivityAt: now,
                  childIds: [],
                  sessionId: null,
                  expanded: false, // collapsed by default (hydrateAgent is the authority)
                  unread: 0,
                });
                // Ad-hoc agent: bind its tab so closing it dismisses the agent; never
                // for a tombstoned id `upsertAgent` just skipped.
                if (s.agents[event.agentId]) {
                  promoteTabForAgent(s, event.agentId);
                }
                return;
              }
              case "subagent_spawned":
                // Wired, inert until Rust emits it (M3) — but the reducer is the
                // only door it can ever come through.
                spawnChild(s, event);
                return;
              case "status": {
                const agent = s.agents[event.agentId];
                if (!agent) return;
                agent.status = event.status;
                agent.lastActivityAt = Date.now();
                // A new turn is the user talking to a restored agent again: its
                // "Resumed after restart" marker has said what it had to say (Rust
                // drops it at the same moment — `on_activity`).
                if (event.status === "running") agent.restored = null;
                // A blocked agent is the one thing worth interrupting for, and
                // it must be findable from a collapsed trunk.
                if (event.status === "waiting_input")
                  bubbleUnread(s, event.agentId);
                return;
              }
              case "activity": {
                const agent = s.agents[event.agentId];
                if (!agent) return;
                agent.lastActivityAt = event.at;
                return;
              }
              case "exited": {
                const agent = s.agents[event.agentId];
                if (!agent) return;
                // Finished agents stay greyed for inspection; only explicit
                // dismissal removes them (ARCHITECTURE §4).
                agent.status = event.code === 0 ? "done" : "error";
                if (event.code !== 0) agent.error = `exit code ${event.code}`;
                agent.finishedAt = Date.now();
                agent.lastActivityAt = agent.finishedAt;
                // An ended agent is no longer "resumed": its row says how it ended.
                agent.restored = null;
                return;
              }
              case "title": {
                const agent = s.agents[event.agentId];
                if (!agent) return;
                agent.title = event.title;
                return;
              }
            }
          }),
      },

      layoutActions: {
        closeActiveTab: () => {
          const s = get();
          const tabId = targetLeaf(s, s.focusedPaneId).activeTabId;
          if (!tabId) return;
          // Any kind, via requestCloseTab so a dirty editor confirms; an agent-terminal
          // also dismisses its agent, an activity tab stops polling.
          if (s.tabs[tabId]) s.editorActions.requestCloseTab(tabId);
        },

        openTerminalTab: (opts) => {
          const tabId = asTabId(newId());

          /** An agent terminal's TerminalId IS its AgentId: Rust keys the PTY by agentId
           * (`agent_spawn` takes no terminalId); a divergent id gives a dead keyboard. */
          const terminalId = opts?.agentId
            ? asTerminalId(opts.agentId)
            : asTerminalId(newId());

          // Pre-register spawn options: the registry opens the PTY lazily on first mount, and
          // only this knows the cwd/agent. `runtime` must travel with `agentId` (no fallback).
          if (opts?.cwd || opts?.agentId) {
            // Only keys we have: `configureTerminal` merges, so `agentId: undefined`
            // would erase an earlier agentId, turning an agent terminal into a shell.
            const spawn: TerminalSpawnOptions = {};
            if (opts.cwd) spawn.cwd = opts.cwd;
            if (opts.agentId) {
              spawn.agentId = opts.agentId;
              // Travels with agentId, always: the registry throws on an agentId
              // without a runtime rather than silently spawning a shell.
              spawn.runtime = opts.runtime;
            }
            configureTerminal(terminalId, spawn);
          }

          set((s) => {
            const leaf = targetLeaf(s, opts?.paneId ?? s.focusedPaneId);

            const agentId = opts?.agentId;
            // One tab shape, two refs. `agent-terminal` renders identically —
            // it is the binding to an agentId that makes fan-out telemetry
            // attributable.
            const tab: Tab = agentId
              ? {
                  id: tabId,
                  kind: "agent-terminal",
                  title: opts?.title ?? terminalTitle(opts?.cwd),
                  ref: { kind: "agent-terminal", terminalId, agentId },
                }
              : {
                  id: tabId,
                  kind: "terminal",
                  title: opts?.title ?? terminalTitle(opts?.cwd),
                  ref: { kind: "terminal", terminalId },
                };
            s.tabs[tabId] = tab;
            leaf.tabIds.push(tabId);
            leaf.activeTabId = tabId;
            s.focusedPaneId = leaf.id;
            // No structural change: a leaf gaining a tab cannot decanonicalize.
          });
          persistLayoutPrefs(get);
          return tabId;
        },

        openEditorTab: (path) => {
          // Dedupe by path: re-clicking an open file re-focuses its tab. No PTY,
          // so this is a pure state mutation (no effect in the wrapper) — the
          // editor pulls the file itself via `read_file` when it mounts.
          const existing = findEditorTab(get().tabs, path);
          if (existing) {
            set((s) => activateTab(s, existing));
            return existing;
          }
          if (routeOpen(tabKey({ kind: "editor", path }), () => get().layoutActions.openEditorTab(path))) {
            return TAB_ELSEWHERE;
          }
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = {
              id: tabId,
              kind: "editor",
              title: fileName(path),
              ref: { kind: "editor", path },
            };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openDiffTab: (path) => {
          // Dedupe against `diff` tabs only (an editor tab is a different view); the view
          // fetches its own diff on mount.
          const existing = Object.values(get().tabs).find(
            (t) => t.ref.kind === "diff" && t.ref.path === path,
          );
          if (existing) {
            set((s) => activateTab(s, existing.id));
            return existing.id;
          }
          if (routeOpen(tabKey({ kind: "diff", path }), () => get().layoutActions.openDiffTab(path))) {
            return TAB_ELSEWHERE;
          }
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = {
              id: tabId,
              kind: "diff",
              // Not the bare filename: it often sits beside an editor tab of the
              // same file; the suffix echoes "Compare with HEAD".
              title: `${fileName(path)} ↔ HEAD`,
              ref: { kind: "diff", path },
            };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openSessionPickerTab: (cwd) => {
          // Dedupe by cwd: one picker per folder, re-focused on re-open (the
          // same contract as openEditorTab's by-path dedupe).
          const tabs = get().tabs;
          const existing = Object.values(tabs).find(
            (t) => t.ref.kind === "session-picker" && t.ref.cwd === cwd,
          );
          if (existing) {
            set((s) => activateTab(s, existing.id));
            return existing.id;
          }
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = {
              id: tabId,
              kind: "session-picker",
              title: `Sessions — ${fileName(cwd)}`,
              ref: { kind: "session-picker", cwd },
            };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openMetricsTab: (cwd) => {
          // Singleton: re-point the one metrics tab at the current project and focus it, so
          // it never shows another project's numbers.
          const existing = Object.values(get().tabs).find(
            (t) => t.ref.kind === "metrics",
          );
          if (existing) {
            set((s) => {
              // Replace the whole ref: mutating `ref.cwd` needs a kind guard whose
              // false branch is unreachable (the tab was found by that kind).
              s.tabs[existing.id].ref = { kind: "metrics", cwd };
              activateTab(s, existing.id);
            });
            return existing.id;
          }
          if (routeOpen(tabKey({ kind: "metrics", cwd }), () => get().layoutActions.openMetricsTab(cwd))) {
            return TAB_ELSEWHERE;
          }
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = {
              id: tabId,
              kind: "metrics",
              title: "Metrics",
              ref: { kind: "metrics", cwd },
            };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openAgentLogsTab: () => {
          // Singleton (the `metrics` precedent): re-focus the one tab if it exists.
          const existing = Object.values(get().tabs).find((t) => t.ref.kind === "agent-logs");
          if (existing) {
            set((s) => activateTab(s, existing.id));
            return existing.id;
          }
          if (routeOpen(tabKey({ kind: "agent-logs" }), () => get().layoutActions.openAgentLogsTab())) return TAB_ELSEWHERE;
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = { id: tabId, kind: "agent-logs", title: "Logs", ref: { kind: "agent-logs" } };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openNetworkTab: () => {
          // Singleton (the `metrics` precedent): re-focus the one tab if it exists.
          const existing = Object.values(get().tabs).find((t) => t.ref.kind === "network");
          if (existing) {
            set((s) => activateTab(s, existing.id));
            return existing.id;
          }
          if (routeOpen(tabKey({ kind: "network" }), () => get().layoutActions.openNetworkTab())) return TAB_ELSEWHERE;
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = { id: tabId, kind: "network", title: "Network", ref: { kind: "network" } };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openVillageTab: () => {
          // Singleton (the `network` precedent): re-focus the one tab if it exists.
          const existing = Object.values(get().tabs).find((t) => t.ref.kind === "village");
          if (existing) {
            set((s) => activateTab(s, existing.id));
            return existing.id;
          }
          if (routeOpen(tabKey({ kind: "village" }), () => get().layoutActions.openVillageTab())) return TAB_ELSEWHERE;
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = { id: tabId, kind: "village", title: "Village", ref: { kind: "village" } };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openApiRequestTab: (requestId) => {
          // The tab references the api slice's request by id; pure state. A History re-run
          // may pass an already-populated request, else mint an empty one.
          const rid = requestId ?? get().apiActions.createApiRequest();
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = {
              id: tabId,
              kind: "api-request",
              title: "New request",
              ref: { kind: "api-request", requestId: rid },
            };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openSequenceTab: (sequenceId) => {
          // Same shape as openApiRequestTab and deliberately NOT deduped: two tabs
          // on one sequence would be two views of the same store slice, which is
          // harmless, and a user comparing two flows side by side is a real thing.
          const sid = sequenceId ?? get().sequenceActions.createSequence();
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = {
              id: tabId,
              kind: "sequence",
              // Titled by the sequence's own name, which is why TabBar needs its
              // own icon arm — otherwise it reads as a terminal.
              title: s.sequences[sid]?.name ?? "Sequence",
              ref: { kind: "sequence", sequenceId: sid },
            };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        openDbConsoleTab: (connectionId) => {
          // Deduped by connectionId — the same shape `openEditorTab` uses for a path. The
          // console's own state (the editor text, the last result set) lives in whatever
          // slice that component owns; this tab references the connection by id only.
          const existing = Object.values(get().tabs).find(
            (t) => t.ref.kind === "db-console" && t.ref.connectionId === connectionId,
          );
          if (existing) {
            set((s) => {
              activateTab(s, existing.id);
            });
            return existing.id;
          }
          const name =
            get().dbConnections.find((c) => c.id === connectionId)?.name ?? "Database";
          const tabId = asTabId(newId());
          set((s) => {
            s.tabs[tabId] = {
              id: tabId,
              kind: "db-console",
              title: name,
              ref: { kind: "db-console", connectionId },
            };
            targetLeaf(s, s.focusedPaneId).tabIds.push(tabId);
            activateTab(s, tabId);
          });
          return tabId;
        },

        rebuildTerminalTabs: (terminals) => {
          // Plan first (pure), THEN commit. Effects (`configureTerminal`) live
          // in the action wrapper, never inside the `set` producer — same rule
          // as `openTerminalTab`.
          const open = get().tabs;
          const seen = new Set<TerminalId>();
          const planned: Array<{
            tabId: TabId;
            tab: Tab;
            terminalId: TerminalId;
          }> = [];

          for (const meta of terminals) {
            const terminalId = meta.id;
            // Idempotent against both the existing store and duplicates inside
            // this same snapshot.
            if (findTerminalTab(open, terminalId) || seen.has(terminalId))
              continue;
            seen.add(terminalId);

            const agentId = meta.agentId ?? null;
            const ended = meta.status === "exited";
            const base = rebuiltTabTitle(meta);
            const title = ended ? `${base} · ended` : base;

            // Reattach, don't spawn: the PTY is alive from before the reload, so
            // no `runtime` is needed (the registry's reattach path skips the
            // agent spawn entirely). cwd travels for the eventual re-open case.
            const spawn: TerminalSpawnOptions = { reattach: true };
            if (meta.cwd) spawn.cwd = meta.cwd;
            if (agentId) spawn.agentId = agentId;
            configureTerminal(terminalId, spawn);

            const tabId = asTabId(newId());
            const tab: Tab = agentId
              ? {
                  id: tabId,
                  kind: "agent-terminal",
                  title,
                  ref: { kind: "agent-terminal", terminalId, agentId },
                }
              : {
                  id: tabId,
                  kind: "terminal",
                  title,
                  ref: { kind: "terminal", terminalId },
                };
            planned.push({ tabId, tab, terminalId });
          }

          // `pendingRestore` is the other reason to run: a persisted arrangement
          // whose terminals did NOT all come back still needs its empty panes
          // pruned, even when nothing new is being placed.
          const restoring = Object.keys(get().pendingRestore).length > 0;
          if (planned.length === 0 && !restoring) return; // fresh launch, nothing new

          set((s) => {
            // Index the freshly-minted tabs by the durable id the blob keys on.
            const unplaced = new Map<string, TabId>();
            for (const { tabId, tab, terminalId } of planned) {
              s.tabs[tabId] = tab;
              unplaced.set(terminalId, tabId);
            }

            // 1. Put each restored terminal back in its own view and pane, in order, named.
            for (const view of s.views) {
              for (const leaf of leavesOf(liveTreeOfView(s, view))) {
                const slot = s.pendingRestore[leaf.id];
                if (!slot) continue;
                const placed: TabId[] = [];
                let active: TabId | null = null;
                for (const entry of slot.terminals) {
                  const tabId = unplaced.get(entry.terminalId);
                  // That terminal did not come back — an unpinned agent, or a
                  // plain shell that died with the app. Its slot just goes away.
                  if (!tabId) continue;
                  unplaced.delete(entry.terminalId);
                  placed.push(tabId);
                  restoreCustomName(s, s.tabs[tabId], entry.customTitle);
                  if (entry.terminalId === slot.activeTerminalId) active = tabId;
                }
                if (placed.length === 0) continue;
                // The leaf is freshly hydrated, so it is empty — push, not splice.
                leaf.tabIds.push(...placed);
                leaf.activeTabId = active ?? placed[0];
              }
            }

            // 2. Anything the blob does not cover (opened since the last save, or no saved
            //    layout) lands in the active view's focused leaf (there is always ≥1 leaf).
            if (unplaced.size > 0) {
              const target = findNode(s.layout, s.focusedPaneId);
              const leaf =
                target && target.type === "leaf"
                  ? target
                  : leavesOf(s.layout)[0];
              for (const tabId of unplaced.values()) {
                leaf.tabIds.push(tabId);
                leaf.activeTabId ??= tabId;
              }
            }

            // 3. A leaf gaining tabs cannot decanonicalize — but a restored pane
            //    whose terminals never arrived is empty and must go.
            if (restoring) {
              pruneEmptyPanes(s);
              s.pendingRestore = {}; // single-use, by contract
            }
          });

          // Persist on the restore side too: boot's `registerFleetRoots` → `syncFolderOrder`
          // saved the views while still empty, so write the corrected blob. (`applyCenterLayout`
          // is a pure read-back and must not persist.)
          persistLayoutPrefs(get);
        },

        closeTab: (tabId) => {
          const tab = get().tabs[tabId];
          const terminalId = terminalIdOf(tab);
          // An agent's tab closing IS dismissing the agent (the agent is closed too,
          // since it will not be reopened). Read the id before
          // the tab record is deleted.
          const agentId = agentIdOf(tab);
          // An editor tab closing forgets its UI state; the registry disposes the
          // CM6 buffer when its host detaches to a now-tabless path.
          const editorPath =
            tab && tab.ref.kind === "editor" ? tab.ref.path : null;
          // Collect any pinned ids the removal drops, to unpin AFTER the set
          // (the invoke is an EFFECT, not a producer step) — dismissing a pinned
          // agent must also drop its registry entry.
          const unpinned: AgentId[] = [];
          set((s) => {
            const leaf = leafOfTab(s.layout, tabId);
            delete s.tabs[tabId];
            if (leaf) {
              // Same pure detach the drop planners use — see `withTabDetached`.
              const { layout, prune } = withTabDetached(
                current(s.layout),
                leaf,
                tabId,
              );
              s.layout = canonicalize(layout, prune);
              ensureFocus(s);
            }
            // Remove and tombstone in one commit so no late event slips a ghost row in; sweep
            // inactive views too (`leafOfTab` sees only the active tree).
            sweepTabsFromInactiveViews(s, [tabId]);
            if (agentId) removeAgentFromForest(s, agentId, unpinned);
            if (editorPath) delete s.editors[editorPath];
            if (s.confirmCloseTab === tabId) s.confirmCloseTab = null;
          });
          // Closed for good: tear the emulator + PTY down (idempotent).
          if (terminalId) dispose(terminalId);
          // Same for an editor's CM6 buffer. Idempotent with the detach path (a
          // mounted editor's unmount also disposes); REQUIRED for a background
          // tab, which has no mounted component to detach.
          if (editorPath) disposeEditorBuffer(editorPath);
          // Drop any removed pin from the registry (best-effort).
          for (const id of unpinned) void persistUnpin(id);
          persistLayoutPrefs(get);
        },

        releaseTab: (tabId) => {
          if (!get().tabs[tabId]) return;
          set((s) => {
            const tab = s.tabs[tabId];
            delete s.tabs[tabId];
            // The same layout steps as `closeTab`, in the same order — one emptiness
            // rule, not two. The tab may sit in a view that is not on screen.
            const leaf = leafOfTab(s.layout, tabId);
            if (leaf) {
              const { layout, prune } = withTabDetached(current(s.layout), leaf, tabId);
              s.layout = canonicalize(layout, prune);
              ensureFocus(s);
            }
            sweepTabsFromInactiveViews(s, [tabId]);
            // This window's UI state for the buffer goes with it (the registry entry is
            // abandoned by the caller); the buffer itself is in the other window now.
            if (tab.ref.kind === "editor") delete s.editors[tab.ref.path];
            if (s.confirmCloseTab === tabId) s.confirmCloseTab = null;
            const pending = s.pendingTerminalClose?.scope;
            if (pending?.kind === "tab" && pending.tabId === tabId) s.pendingTerminalClose = null;
          });
          persistLayoutPrefs(get);
        },

        renameTab: (tabId, name) => {
          set((s) => {
            const tab = s.tabs[tabId];
            if (!tab) return;
            const trimmed = name?.trim();
            tab.customTitle = trimmed ? trimmed : null;
          });
          persistLayoutPrefs(get);
        },

        setActiveTab: (paneId, tabId) => {
          set((s) => {
            const leaf = findNode(s.layout, paneId);
            if (!leaf || leaf.type !== "leaf") return;
            if (!leaf.tabIds.includes(tabId)) return;
            leaf.activeTabId = tabId;
            s.focusedPaneId = paneId;
            // The strip sets `activeTabId` directly, bypassing `activateTab`, so record
            // the file here or the Files rail's highlight stays put.
            noteFileTab(s, tabId);
          });
          persistLayoutPrefs(get);
        },

        splitPane: (paneId, orientation) => {
          let created: PaneId | undefined;
          set((s) => {
            const target = findNode(s.layout, paneId);
            if (!target || target.type !== "leaf") return; // only leaves split
            const newLeaf = makeLeaf();
            created = newLeaf.id;

            // Always wrap in a fresh split; canonicalize's flatten rule turns a
            // same-orientation nest into a sibling insert (halving this pane's
            // share), so that case needs no special handling here.
            const next = replaceNode(current(s.layout), paneId, (leaf) => ({
              id: asPaneId(newId()),
              type: "split",
              orientation,
              children: [leaf, newLeaf],
              sizes: [0.5, 0.5],
            }));

            s.layout = canonicalize(next);
            s.focusedPaneId = newLeaf.id; // the new empty leaf takes focus
          });
          persistLayoutPrefs(get);
          return created ?? paneId;
        },

        resizePane: (splitPaneId, sizes) =>
          set((s) => {
            const node = findNode(s.layout, splitPaneId);
            if (!node || node.type !== "split") return;
            if (sizes.length !== node.children.length) return;

            // A resize changes no structure: normalize in place, no canonicalize per drag
            // frame. The equality guard drops allotment's no-op onChange on container resize.
            const next = normalizeSizes(sizes);
            if (sizesEqual(node.sizes, next)) return;
            node.sizes = next;
          }),

        focusPane: (paneId) =>
          set((s) => {
            if (s.focusedPaneId === paneId) return;
            const leaf = findNode(s.layout, paneId);
            if (!leaf || leaf.type !== "leaf") return;
            s.focusedPaneId = paneId;
          }),

        // Both drops delegate to the pure planners, which the drag preview also runs,
        // so what the user is shown and what the drop does cannot drift.
        moveTab: (tabId, toPaneId, index) => {
          set((s) => {
            const plan = planMoveTab(current(s.layout), tabId, toPaneId, index);
            if (!plan) return;
            s.layout = plan.layout;
            s.focusedPaneId = plan.landedPaneId;
            ensureFocus(s);
          });
          persistLayoutPrefs(get);
        },

        moveTabToEdge: (tabId, targetPaneId, edge) => {
          set((s) => {
            const plan = planMoveTabToEdge(
              current(s.layout),
              tabId,
              targetPaneId,
              edge,
            );
            if (!plan) return;
            s.layout = plan.layout;
            // The landed leaf always survives canonicalization (it holds a tab,
            // so it is never pruned), so focus needs no repair pass here.
            s.focusedPaneId = plan.landedPaneId;
          });
          persistLayoutPrefs(get);
        },

        requestClosePane: (paneId) => {
          // Gated wrapper for the pane ✕ (kills every terminal in it, no undo), like
          // `requestCloseTab`; `closePane` stays the primitive internal callers and the replay use.
          const leaf = findNode(get().layout, paneId);
          const live =
            leaf && leaf.type === "leaf"
              ? leaf.tabIds.flatMap((tabId) => {
                  const t = terminalIdOf(get().tabs[tabId]);
                  return t ? [t] : [];
                })
              : [];
          if (live.length === 0) {
            get().layoutActions.closePane(paneId);
            return;
          }
          void gateTerminalClose(
            live,
            { kind: "pane", paneId },
            (pending) => set((s) => void (s.pendingTerminalClose = pending)),
            () => get().layoutActions.closePane(paneId),
            (id) => plainTerminalTitle(get().tabs, id),
          );
        },

        closePane: (paneId) => {
          const before = get();
          const target = findNode(before.layout, paneId);
          const doomed =
            target && target.type === "leaf"
              ? target.tabIds.flatMap((tabId) => {
                  const terminalId = terminalIdOf(before.tabs[tabId]);
                  return terminalId ? [terminalId] : [];
                })
              : [];
          // Dispose editor buffers too (only the active one had a mounted component),
          // dropping each `editors` slice so a later open reloads from disk.
          const doomedEditors =
            target && target.type === "leaf"
              ? target.tabIds.flatMap((tabId) => {
                  const tab = before.tabs[tabId];
                  return tab && tab.ref.kind === "editor" ? [tab.ref.path] : [];
                })
              : [];

          set((s) => {
            const leaf = findNode(s.layout, paneId);
            if (!leaf || leaf.type !== "leaf") return;

            for (const tabId of leaf.tabIds) delete s.tabs[tabId];
            leaf.tabIds = [];
            leaf.activeTabId = null;
            // If this is the last leaf, canonicalize keeps it (now empty).
            recanonicalize(s, new Set([paneId]));
          });

          for (const terminalId of doomed) dispose(terminalId);
          for (const path of doomedEditors) disposeEditorBuffer(path);
          persistLayoutPrefs(get);
        },

        /* ─────────────────────────── views ─────────────────────────── */

        createView: (name) => {
          const trimmed = name?.trim();
          // Built outside the producer (like every other minted id here), so the
          // returned id needs no definite-assignment dance.
          const view = makeView(trimmed ? trimmed : nextViewName(get().views));
          set((s) => {
            // The outgoing view stops being live the moment we reassign
            // `layout` below — snapshot it first or its tree is lost.
            writeBackActiveView(s);
            s.views.push(view);
            s.layout = view.layout;
            s.focusedPaneId = view.focusedPaneId;
            s.activeViewId = view.id;
          });
          persistLayoutPrefs(get);
          return view.id;
        },

        activateView: (id) => {
          set((s) => {
            // Already active: nothing to switch, and no write-back (touching the
            // snapshot here would be a state change for no reason).
            if (id === s.activeViewId) return;
            const target = s.views.find((v) => v.id === id);
            if (!target) return;
            // WRITE-BACK FIRST, then load. Reversed, the outgoing view's tree is
            // overwritten by the incoming one and the user loses a layout.
            writeBackActiveView(s);
            const tree = plainTree(target.layout);
            s.layout = tree;
            s.focusedPaneId = focusedOrFirst(tree, target.focusedPaneId);
            s.activeViewId = id;
          });
          persistLayoutPrefs(get);
        },

        renameView: (id, name) => {
          set((s) => {
            // Refused, not silently stored: an unnamed tab in the bar is
            // unclickable-by-name and there is no undo to get the old one back.
            const trimmed = name.trim();
            if (!trimmed) return;
            const view = s.views.find((v) => v.id === id);
            if (view) view.name = trimmed;
          });
          // The lost-rename bug, in one line: a rename that is not written down
          // dies with the process.
          persistLayoutPrefs(get);
        },

        closeView: (id) => {
          set((s) => {
            // The last view is the window itself — closing it would leave nothing
            // to render and nowhere to rescue its tabs to.
            if (s.views.length <= 1) return;
            const i = s.views.findIndex((v) => v.id === id);
            if (i < 0) return;

            // Read the doomed view's tabs BEFORE it leaves the array. They are
            // rescued, not closed: no `dispose`, no `delete s.tabs[...]`.
            const rescued = viewTabIds(s, id);
            const wasActive = id === s.activeViewId;
            s.views.splice(i, 1);

            if (wasActive) {
              // The neighbour takes over: the next view, else the previous one.
              // No write-back — the view we would write to no longer exists.
              const survivor = s.views[Math.min(i, s.views.length - 1)];
              const tree = plainTree(survivor.layout);
              s.layout = tree;
              s.focusedPaneId = focusedOrFirst(tree, survivor.focusedPaneId);
              s.activeViewId = survivor.id;
            }

            // Land them in the pane the user is now looking at, either way.
            if (rescued.length > 0) {
              s.layout = withTabsAttached(
                plainTree(s.layout),
                s.focusedPaneId,
                rescued,
              );
            }
          });
          persistLayoutPrefs(get);
        },

        moveTabToView: (tabId, viewId) => {
          set((s) => {
            const target = s.views.find((v) => v.id === viewId);
            if (!target) return;

            // Locate the tab and snapshot its tree in ONE pass, so the tree we
            // searched is the tree we rebuild (a second lookup would have an
            // unreachable "not found" arm).
            let found: { view: ViewSnapshot; tree: PaneNode; from: LeafNode } | null =
              null;
            for (const view of s.views) {
              const tree = plainTree(liveTreeOfView(s, view));
              const from = leafOfTab(tree, tabId);
              if (from) {
                found = { view, tree, from };
                break;
              }
            }
            if (!found) return; // no view holds this tab

            const sameView = found.view.id === target.id;
            // Already sitting in the destination pane — the user asked for
            // nothing. (Cross-view, `from.id` can never equal the target's focus.)
            if (sameView && found.from.id === focusOfView(s, target)) return;

            // ONE emptiness rule: the same detach `closeTab`/`moveTab` use, so a
            // pane that empties behind the tab is pruned identically.
            const detached = withTabDetached(found.tree, found.from, tabId);
            const source = canonicalize(detached.layout, detached.prune);

            // Within one view the two edits compose on a single tree.
            const targetTree = sameView
              ? source
              : plainTree(liveTreeOfView(s, target));
            const landing = focusedOrFirst(targetTree, focusOfView(s, target));
            const attached = withTabsAttached(targetTree, landing, [tabId]);

            if (!sameView) {
              writeViewTree(
                s,
                found.view,
                source,
                focusedOrFirst(source, focusOfView(s, found.view)),
              );
            }
            writeViewTree(s, target, attached, landing);
            // `tabs` is untouched on every path above — that is the point: the
            // Tab record, its TerminalId and its PTY never move.
          });
          persistLayoutPrefs(get);
        },

        reorderViews: (viewId, beforeViewId) => {
          set((s) => {
            // The shared, property-tested list-move — never a hand-rolled splice.
            const order = moveBefore(
              s.views.map((v) => v.id),
              viewId,
              beforeViewId,
            );
            // An unknown `viewId` is appended to `order` and matches nothing, so no guard;
            // `indexOf`, not a map, to avoid an unreachable `?? 0`.
            s.views.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
          });
          persistLayoutPrefs(get);
        },

        cancelTerminalClose: () =>
          set((s) => {
            s.pendingTerminalClose = null;
          }),

        proceedTerminalClose: () => {
          const pending = get().pendingTerminalClose;
          // Clear FIRST, then replay the primitives (`closeTab`/`closePane`/`dismissAgent`),
          // never the `request*` wrappers, so a confirmed close can never ask again.
          set((s) => {
            s.pendingTerminalClose = null;
          });
          if (!pending) return;
          const { scope } = pending;
          if (scope.kind === "tab") get().layoutActions.closeTab(scope.tabId);
          else if (scope.kind === "pane") get().layoutActions.closePane(scope.paneId);
          else get().agentActions.dismissAgent(scope.agentId);
        },

        applyCenterLayout: (prefs) =>
          set((s) => {
            const persisted = prefs.views ?? [];
            // Nothing on disk (first launch, or a store predating this field):
            // keep the boot view rather than blanking the window.
            if (persisted.length === 0) return;
            const restored = hydrateCenterLayout(persisted);
            s.views = restored.views;
            s.pendingRestore = restored.pendingRestore;
            // An `activeViewId` naming no view (a view closed by a build that
            // wrote the id but not the view) falls back to the first — the store
            // invariant is that it ALWAYS names a member of `views`.
            const active =
              restored.views.find((v) => v.id === prefs.activeViewId) ??
              restored.views[0];
            s.activeViewId = active.id;
            // Shares the snapshot's tree, exactly as `initialLayoutState` does:
            // it IS the active view, so its snapshot is stale-by-design from here.
            s.layout = active.layout;
            s.focusedPaneId = active.focusedPaneId;
          }),
      },
    })),
  ),
);

/** Imperative handle for bridge.ts / Rust event callbacks (no Provider). */
export const layoutActions = () => useAppStore.getState().layoutActions;
