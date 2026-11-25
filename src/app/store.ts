/**
 * The Zustand store — M1 slice: the split-pane layout + tabs.
 *
 * Per ARCHITECTURE §4: Zustand + Immer + `subscribeWithSelector`. The store is
 * written **imperatively from Rust event callbacks** (bridge.ts), so everything
 * here must work through `useAppStore.getState()` / `.setState()` with no
 * Provider and no hook.
 *
 * ── M1 scope: a single implicit session ──────────────────────────────────────
 * ARCHITECTURE §2.3 defines a `Session` that owns { layout, focusedPaneId, tabs,
 * terminals, docs }. M1 ships exactly one, implicitly, so those three fields sit
 * at the store root. Everything below is deliberately shaped to nest under
 * `sessions: Record<SessionId, Session>` at M2 **without a rewrite**:
 *
 *   - `LayoutState` is the exact sub-shape of `Session` this slice touches, and
 *     every reducer is a pure function over a `LayoutState` draft — never over
 *     the store root. At M2 each reducer body is reused verbatim against
 *     `draft.sessions[sessionId]`; only the `set()` wrappers grow a lookup.
 *   - The tree helpers below are pure and take `PaneNode`, so they are
 *     session-agnostic already.
 *
 * Types come from `./types` (THE contract) and are never redefined here.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { current, enableMapSet, isDraft } from "immer";

// Lets immer produce over `Set`/`Map` state — used by `collapsedFolders`.
// One-time, idempotent global registration.
enableMapSet();

// The terminal feature's public surface. Two calls, both addressed to whoever
// owns tab lifetime (i.e. this store), per that module's own contract:
//   - configureTerminal: "lets a caller that knows the cwd/program stay
//     decoupled from the component that mounts it" — our openTerminalTab knows
//     the cwd; <TerminalView terminalId> (all Pane may pass) does not.
//   - dispose: "call when a tab is closed for good (unmount only detaches)" —
//     without it, closing a tab would leak the xterm instance and its PTY.
// Effects live in the action wrappers only; the reducers below stay pure.
import {
  configureTerminal,
  dispose,
  setDefaultTerminalCwd,
} from "../features/terminal";
import type { TerminalSpawnOptions } from "../features/terminal";
// The editor twin of the terminal `dispose` above. A mounted <CodeEditor>'s
// unmount disposes its buffer via detach — but a BACKGROUND editor tab (not its
// pane's active tab) has no mounted component, so closing it must dispose here
// or the registry entry outlives the tab and the next open of that path shows
// "Loading…" forever (its store slice is gone; ensureEditor early-returns).
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
// The durable API store. `saveApiStore` is a runtime import — the
// persistence EFFECT the collection/environment action wrappers run (never
// inside a `set` producer), the same shape as `setWorkspaceRoot`'s
// `setDefaultTerminalCwd`. The wire types are type-only.
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
// The persisted-recents effect (multi-root Files). `addBrowseRoot` runs
// it in its wrapper — exactly like `setWorkspaceRoot`'s `setDefaultTerminalCwd` —
// to AUTHORIZE `read_dir` on a picker-opened folder: `read_dir`'s allowed_roots
// are the recent projects ∪ the workspace root, so a browse root must be recorded
// there or its listing rejects. Best-effort; never blocks opening the folder.
import { ensureAgentHooks, pushRecentProject } from "../features/fleet/fleetIpc";
import {
  DEFAULT_RAIL_GROUP_STYLE,
  parseRailGroupStyle,
  type RailGroupStyle,
} from "../features/fleet/railGroupStyle";
// The pin registry effects. Aliased so they do not collide with the
// `pinAgent`/`unpinAgent` ACTION names below: these are the persistence EFFECTS
// the action wrappers run (never inside a `set` producer), the same shape as
// `saveApiStore`. Both swallow their own failure, so a missing backend never
// surfaces here. `PinnedAgentView` is type-only (the boot-reconcile input).
import {
  pinAgent as persistPin,
  unpinAgent as persistUnpin,
} from "../features/fleet/fleetIpc";
import type { PinnedAgentView, RestoredAgentView } from "../features/fleet/fleetIpc";
export type { PinnedAgentView, RestoredAgentView } from "../features/fleet/fleetIpc";
// Rail layout prefs (folder order + per-rail collapse), persisted so a manual sort
// and collapse state survive a restart. `saveLayoutPrefs` is the
// runtime EFFECT the reorder/collapse action wrappers run — never inside a `set`
// producer, the same rule as `setWorkspaceRoot`'s `setDefaultTerminalCwd`. Wire type
// is type-only.
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
// The database client's wire seam. Runtime imports, because unlike the API store
// there is no local mirror to persist: the DB store is written BY Rust, so an "upsert"
// IS the IPC call and the record it returns is what lands here. Every one of these runs
// in an action WRAPPER, never inside a `set` producer.
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

/**
 * A results grid's remembered view. `columns` is the column-name signature of
 * the result it was taken from: a sort is an index, and an index only means
 * something against the columns it was chosen on. Re-running a query with
 * different columns must NOT restore the old sort — it would silently order by
 * whatever now sits at that position, which is the hazard `ResultsGrid`'s own
 * new-result reset exists to prevent.
 */
export interface GridView {
  sort: GridSortState | null;
  widthPx: Record<number, number>;
  columns: string[];
}
// The pure ordering rules — what a saved arrangement means when tables are added or dropped
// underneath it. Imported so the store and `<DbTree/>` apply the SAME order; two copies would
// disagree the moment a schema changed, and the store's copy is the one that gets persisted.
// `moveBefore` is aliased: the folder rail already imports one of that name from
// `app/folderOrder`. They are NOT interchangeable — this one adds the db tree's self-drop
// guard (dropping a row onto itself must be a no-op, not "send it to the bottom"), so the
// collision is resolved by renaming rather than by reusing whichever was in scope.
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
// Shareable config bundles. Runtime imports, because — exactly as with the
// db slice — each of these actions IS an IPC call plus a reduction: the file is read and
// written by Rust (its bytes never cross the boundary), and the picker is the one part of the
// flow a jsdom test cannot drive. Every call runs in an action WRAPPER, never inside a `set`
// producer.
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

/**
 * The AgentAdapter id we ask Rust to spawn. Named here rather than
 * inlined because the frontend must NOT know how to launch a runtime — only
 * which one it wants; `agent/claude.rs` owns the actual spawn spec.
 */
const DEFAULT_RUNTIME = "claude-code";

/**
 * PURE: everything `layout-prefs.json` holds, read off the store — the rail prefs
 * (folder order, both collapse sets) AND the center layout (views, their names,
 * their pane arrangement). Exported so a test can assert the blob without going
 * through the IPC spy.
 */
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

/**
 * Persist the current layout prefs to Rust. THE effect the reorder/collapse/view
 * action wrappers run — never inside a `set` producer. Best-effort by
 * construction (`saveLayoutPrefs` swallows its own failure), so a dropped write is
 * re-issued by the next mutation and never surfaces here. Reads straight from
 * `getState()` so the caller does not have to thread the whole prefs blob through.
 *
 * ── Which actions call it, and the one that deliberately does not ────────────
 * Every action that changes what the blob holds — each view action, every action
 * that moves a tab or reshapes the tree, and the three renames — calls this in its
 * wrapper. The single exception is `resizePane`: allotment emits `onChange` per
 * drag *frame*, so persisting there would be a file write per animation frame.
 * Pane sizes ride along on the next mutation that does persist, which is the
 * cheapest honest track — a resize is the one layout change nobody notices losing.
 */
function persistLayoutPrefs(get: () => AppStore): void {
  void saveLayoutPrefs(layoutPrefsBlob(get()));
}

/**
 * PURE: the Files-rail collapse set for "focus follows agent" — every folder in
 * `roots` collapsed EXCEPT `keep` (the folder to leave expanded). `keep === null`
 * (or a `keep` not present in `roots`) collapses everything. Exported so the
 * selection→collapse logic is unit-testable in isolation from the store.
 */
export function collapseAllBut(
  roots: readonly string[],
  keep: string | null,
): Set<string> {
  return new Set(roots.filter((path) => path !== keep));
}

/**
 * Wrapper EFFECT applied after a selection change / on toggling the
 * setting ON: when `focusFollowsAgent` is set, collapse every folder EXCEPT the
 * SELECTED agent's working directory — in BOTH rails, in lockstep — then persist.
 * The right (Files) rail's roots are `collapsedRoots`; the left (Agents) rail's
 * folder groups are `collapsedFolders`, keyed by the distinct root-agent cwds (the
 * same grouping `flattenFleet` does). A sub-agent has no cwd of its own, so its ROOT
 * agent's cwd (`rootOf`) is the folder kept expanded on both sides. The pure part
 * (`collapseAllBut`) computes each set; the persist is the side effect — hence this
 * lives OUTSIDE any immer producer. A NO-OP (collapse left unchanged) when the setting
 * is off, nothing is selected, or the selection has no resolvable cwd.
 */
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

/**
 * Effects other modules attach to the SELECT-AGENT GESTURE — `selectAgent`, the rail click —
 * and deliberately not to selection changes in general: removing the selected agent also
 * re-points the selection, and that must not look like the user asking for anything.
 *
 * Tab tear-off is the user (docs/design/tab-tearoff.md): clicking an agent whose terminal
 * lives in another OS window brings that window, and the tab, to the front. Run in the
 * action WRAPPER, after the producer, like every other effect here.
 */
const agentSelectedHooks = new Set<(agentId: AgentId) => void>();

/** Run `hook` after every `selectAgent`. Returns the unsubscribe. */
export function onAgentSelected(hook: (agentId: AgentId) => void): () => void {
  agentSelectedHooks.add(hook);
  return () => {
    agentSelectedHooks.delete(hook);
  };
}

/**
 * Tab tear-off's other two seams into this store, installed by `app/tearoff/boot.ts` and
 * inert until then — so everything that never boots tear-off (every other test) sees the
 * behaviour it always had.
 *
 * `routeOpen`: an open action for a tab ANOTHER OS window holds brings that window forward
 * instead of opening a second copy here. Two editor tabs on one file in two realms are two
 * live writers for it (the main window must not keep one); two network tabs are
 * two realms driving one process-global machine. The router answers whether it routed;
 * `openHere` is what it runs if the other window turns out to be gone. A routed open
 * returns `TAB_ELSEWHERE` — no tab id in THIS window names it.
 *
 * `heldElsewhere`: the terminal ids other windows show. `layoutPrefsBlob` keeps the agents
 * among them in the persisted layout, names included (the lost-rename bug must not come back
 * for an agent whose tab happens to sit in another window when the app quits).
 */
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
 * Exported for reuse/testing. All operate on plain `PaneNode` trees, so they
 * work identically on an M2 per-session tree.
 */

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

/**
 * Canonicalize the tree (ARCHITECTURE §4). Run after EVERY mutation:
 *
 *   a. collapse a split with a single child into that child;
 *   b. flatten a nested split of the same orientation into its parent, scaling
 *      the grandchildren by the child's share (so the visual layout is stable);
 *   c. drop empty leaves listed in `prune`;
 *   d. renormalize every `sizes[]` to sum to 1;
 *   e. never remove the last leaf — an empty root leaf is a valid resting state.
 *
 * On (c): pruning is **opt-in per call**, not a blanket "delete every empty
 * leaf". `splitPane` deliberately creates an empty leaf (it moves nothing and
 * renders the "New terminal" placeholder), so a blanket rule would instantly
 * undo every split. Callers pass the leaf that just lost its content —
 * `closeTab`/`moveTab` pass a source leaf that emptied (closing the
 * last tab collapses the leaf), `closePane` passes its target.
 */
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

/**
 * A **view**: one whole layout of panes, switched as a unit (a window-style
 * view that holds, say, four terminals, with a switch to
 * another view that holds two more — the iTerm2/tmux window model).
 * The ViewBar is the top level; a pane's
 * own tab strip reads as sub-tabs beneath it.
 *
 * Branded like `PaneId`/`TabId` so a raw string can never be passed where a view
 * is meant (types.ts owns the brand helper for the Rust↔JS contract types; a
 * ViewId is client-only, so its brand lives here with the slice that owns it).
 */
export type ViewId = string & { readonly __brand: "ViewId" };
export const asViewId = (s: string): ViewId => s as ViewId;

/**
 * One view's persisted shape. **For the ACTIVE view this is a STALE SNAPSHOT,
 * not live state** — see `LayoutState.views`.
 */
export interface ViewSnapshot {
  id: ViewId;
  /** User-visible label. Defaults to the first free "View N"; renameable. */
  name: string;
  layout: PaneNode;
  focusedPaneId: PaneId;
}

/**
 * The exact sub-shape of ARCHITECTURE §2.3's `Session` that this slice owns.
 * At M2 this becomes the per-session record; reducers below already take it.
 */
/**
 * A close gesture that is waiting on the user because it would kill a terminal
 * that is doing something.
 *
 * Held as ONE record rather than a `TabId` like `confirmCloseTab`, because the
 * gestures this gate has to cover are not all per-tab: closing a PANE kills every
 * terminal in it in a single click, and the fleet rail's ✕ closes an agent by
 * agent id. `confirmCloseTab` could not be reused for any of that — it holds a
 * single tab id and its dialog narrows on `ref.kind === "editor"`, so putting a
 * terminal in that slot renders nothing and the tab neither closes nor prompts.
 */
export interface PendingTerminalClose {
  /** The gesture to replay if the user confirms — never re-derived at that point. */
  scope:
    | { kind: "tab"; tabId: TabId }
    | { kind: "pane"; paneId: PaneId }
    | { kind: "agent"; agentId: AgentId };
  /**
   * The busy terminals this gesture would kill, as the backend reported them at
   * the moment of the click. Snapshotted on purpose: the dialog names what the
   * user is about to lose, and re-asking while the dialog is open would let the
   * list change out from under the sentence they are reading.
   */
  terminals: BusyTerminal[];
}

export interface LayoutState {
  /** The ACTIVE view's pane tree — the one source of truth while it is active. */
  layout: PaneNode;
  /**
   * A close waiting on "are you sure?", or null. Absence IS "nothing pending" —
   * no tombstones, the `findBars` convention.
   */
  pendingTerminalClose: PendingTerminalClose | null;
  /** The ACTIVE view's focused pane — likewise live, not a copy. */
  focusedPaneId: PaneId;
  /**
   * Every tab in the window, across ALL views — deliberately **global**.
   *
   * This is what makes `moveTabToView` free: the `Tab`, its `TerminalId` and its
   * PTY are never touched by a move, only which pane's `tabIds` holds the id. A
   * per-view tab registry would mean re-keying a live terminal to move it.
   */
  tabs: Record<TabId, Tab>;
  /**
   * The path of the last FILE tab (`editor` or `diff`) that was made active, in
   * any pane and any view — the memory behind `activeFilePath`'s sticky second
   * clause. UI-transient: never persisted, and never cleaned up on close.
   *
   * It is written in exactly two places — `activateTab` (every open-or-refocus
   * path funnels through it) and `setActiveTab` (the tab strip, which assigns
   * `activeTabId` directly) — and read only through `activeFilePath`, which
   * discards it when no tab shows that file any more. A stale value is therefore
   * inert rather than wrong, which is why the close/rename/delete paths need no
   * bookkeeping for it.
   */
  lastFilePath: string | null;
  /**
   * The views, in display (bar) order.
   *
   * ⚠️ **`views[activeViewId]` is a SNAPSHOT and goes stale the moment its view
   * is activated.** `layout`/`focusedPaneId` above stay the live fields of the
   * active view, so every pre-existing layout action keeps mutating exactly one
   * place and needed no change. The snapshot is refreshed by a **write-back on
   * switch** (`activateView`/`createView`/`closeView` call `writeBackActiveView`
   * BEFORE loading another view's tree).
   *
   * So: read the ACTIVE view's tree from `layout`, never from `views` — and read
   * an INACTIVE view's tree from `views`, where it is authoritative. `viewTabIds`
   * / `liveTreeOfView` encode that rule; prefer them to hand-rolling it.
   *
   * Only the active view is ever mounted. Inactive views are pure data and their
   * terminals survive regardless: `TerminalRegistry` owns the xterm instance and
   * the PTY outside React, so unmounting a pane detaches a DOM host and nothing
   * more — only `dispose()` tears a terminal down.
   */
  views: ViewSnapshot[];
  /** Always names a member of `views`; `views` is never empty. */
  activeViewId: ViewId;
  /**
   * Boot-only carry-over from the persisted center layout: for each restored
   * pane, which terminals belonged in it (in order) and which one was selected.
   *
   * It exists because the restore happens in two steps that cannot be merged:
   * `applyCenterLayout` rebuilds the ARRANGEMENT from `layout-prefs.json` while
   * `fleet_snapshot` is still in flight, so the leaves come back empty; then
   * `rebuildTerminalTabs` mints the tabs for the PTYs that actually came back and
   * consumes this to put each one in its own pane. **Empty in steady state** —
   * `rebuildTerminalTabs` clears it, and nothing else ever writes it.
   */
  pendingRestore: Record<PaneId, RestoreSlot>;
}

/**
 * Which side of a pane a tab was dropped on (drag-to-edge → split).
 *
 * UI-only, so it lives here rather than in `types.ts` (the Rust↔JS contract).
 * `left`/`right` split `row` (side-by-side); `top`/`bottom` split `column`
 * (stacked) — see `Orientation` in types.ts. The `center` zone is not an edge:
 * it is a plain `moveTab`, so it is not part of this type.
 */
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
  /**
   * Mint a TerminalId + open a terminal tab in `paneId` (default: focused).
   *
   * Passing `agentId` makes it an **agent-terminal**: same tab, same PTY path,
   * same registry — the only difference is the `ref`, which binds the terminal
   * to an agent so fan-out telemetry is attributable to it (identical
   * rendering; the ONLY difference is that it is bound to an agentId), and the
   * spawn command the registry routes to.
   *
   * `runtime` is required alongside `agentId` (ARCHITECTURE §2.4): it names an
   * AgentAdapter, never a program — which binary to launch is `agent/claude.rs`'s
   * business alone.
   */
  openTerminalTab(opts?: {
    cwd?: string;
    paneId?: PaneId;
    agentId?: AgentId;
    runtime?: string;
    title?: string;
  }): TabId;
  /**
   * Open (or re-focus) a read-only editor tab for `path` (M4). Deduped by path:
   * re-clicking a file that is already open activates its existing tab instead
   * of minting a second. Title = the filename. Returns the tab id either way.
   */
  openEditorTab(path: string): TabId;
  /**
   * Open (or re-focus) the HEAD↔working-tree diff for `path` — the file tree's
   * **Git ▸ Compare with HEAD**.
   *
   * Deduped by path, exactly like `openEditorTab`: comparing the same file twice
   * re-focuses the one diff rather than minting a twin. It dedupes against `diff`
   * tabs ONLY, so a file that is open for editing also opens as a diff — those
   * are two different views of one file, and having one steal the other's tab
   * would make the second gesture look broken.
   *
   * Title = the filename, like an editor tab; the repo-relative path is in the
   * view's own header, because only Rust knows where the repo root is.
   *
   * Pure state mutation, like `openEditorTab`: no PTY, no IPC here — `<DiffView>`
   * runs `git_file_diff` itself when it mounts. The tab is **read-only**, so it
   * never becomes dirty and never participates in the unsaved-changes flow.
   */
  openDiffTab(path: string): TabId;
  /**
   * Open a new API request tab. With no argument, mints a fresh
   * request in the `api` slice (GET, empty); pass an existing `requestId` (e.g. one
   * a History re-run just created + populated) to open a tab for it instead. Opens
   * a tab that references the request by id and activates it in the focused leaf.
   * No PTY — a pure state mutation, like `openEditorTab`. Returns the new tab id.
   */
  openApiRequestTab(requestId?: string): TabId;
  /** Open a request-sequence tab, minting the sequence if none is given. */
  openSequenceTab(sequenceId?: string): TabId;
  /**
   * Open (or re-focus) the past-sessions picker for a folder ("Recover
   * session"). Deduped by `cwd` — like `openEditorTab` by path: right-clicking
   * the same folder's agent twice re-focuses the one picker. Pure state
   * mutation; the picker fetches its list itself when it mounts.
   */
  openSessionPickerTab(cwd: string): TabId;
  /**
   * Open (or re-focus) the Claude metrics dashboard.
   *
   * A **singleton**: there is one set of numbers about this machine, so a second
   * tab would be the same panel twice — unlike the editor (one per file) or the
   * session picker (one per folder), which dedupe by their key. Re-calling this
   * re-focuses the existing tab and re-points it at `cwd` if the project changed,
   * so "show me metrics" from two different places lands in one place.
   *
   * Pure state mutation, like `openEditorTab`: no PTY, and the panel runs its own
   * (Rust-side, read-only) scan when it mounts.
   */
  openMetricsTab(cwd: string | null): TabId;
  /**
   * Open (or re-focus) the fleet-wide Agent Logs tab.
   * A **singleton** — one fleet, one stream.
   */
  openAgentLogsTab(): TabId;
  /**
   * Open (or re-focus) the Network traffic tab — the capture proxy's flow table
   * (same design doc). A **singleton** — one proxy per app run.
   */
  openNetworkTab(): TabId;
  /**
   * Open (or re-focus) the Agent Village tab — every Claude Code
   * agent on this machine as a pixel-art character. A **singleton** — one machine, one village.
   */
  openVillageTab(): TabId;
  /**
   * Open (or re-focus) the query console for a saved database connection.
   *
   * Deduped by `connectionId`, like `openEditorTab` by path — and for a stronger
   * reason than tidiness: a second console on the same connection would be a second
   * view of ONE session, so the read-only badge, the row limit and a running query
   * could disagree between two tabs that look interchangeable.
   *
   * Pure state mutation, like `openEditorTab`: no PTY, no `db_open`. Opening a
   * session is `dbActions.openDbSession`, which the console runs itself when it
   * mounts — the tab must be openable for a connection that is not connected yet.
   */
  openDbConsoleTab(connectionId: string): TabId;
  closeTab(tabId: TabId): void;
  /**
   * Take a tab out of this window WITHOUT closing it — the hand-off half of moving it to
   * another OS window (tab tear-off, docs/design/tab-tearoff.md).
   *
   * Everything `closeTab` does to the LAYOUT (detach, prune an emptied pane, repair focus,
   * sweep inactive views) and nothing it does to the THING: no `dispose`, no
   * `disposeEditorBuffer`, no agent dismissal, no unpin. The PTY, the agent and the buffer
   * all live on in the window the tab is going to; `app/tearoff` describes the tab first and
   * abandons this window's view of it after. A no-op for an unknown id.
   */
  releaseTab(tabId: TabId): void;
  /**
   * Close the focused pane's ACTIVE tab, when it is a terminal or an editor (file)
   * — the Cmd/Ctrl+W binding. Routes through `requestCloseTab`, so a dirty editor
   * still raises the unsaved-changes confirm. A no-op when the focused pane has no
   * active tab, or its active tab is some other kind (nothing to reflexively close).
   */
  closeActiveTab(): void;
  /**
   * Rename a tab. Empty/whitespace `name` (or null) clears the custom name,
   * reverting to the derived `title`. For an agent-terminal tab, prefer
   * `agentActions.renameAgent` — the custom name belongs to the agent so the
   * rail row and tab stay in lockstep; this action only sets `Tab.customTitle`.
   */
  renameTab(tabId: TabId, name: string | null): void;
  setActiveTab(paneId: PaneId, tabId: TabId): void;
  /** Split `paneId`; moves nothing. Returns the new (empty, focused) leaf. */
  splitPane(paneId: PaneId, orientation: Orientation): PaneId;
  /** `sizes` may be pixels (straight from allotment's onChange) or fractions. */
  resizePane(splitPaneId: PaneId, sizes: number[]): void;
  focusPane(paneId: PaneId): void;
  /**
   * Move a tab into a pane.
   *
   * With `index`, insert at that position in the destination strip instead of
   * appending — which is also how a tab is **reordered within its own pane**
   * (`toPaneId` = the pane it already lives in). Without `index`, moving a tab
   * into its own pane stays a no-op, as it always was.
   *
   * `index` is interpreted against the strip **as the user sees it**, i.e. with
   * the dragged tab still in place; the shift from removing it is handled here.
   */
  moveTab(tabId: TabId, toPaneId: PaneId, index?: number): void;
  /**
   * Drop a tab on a pane's edge: split that pane and land the tab in the new
   * leaf on that side. The direct-manipulation counterpart to the toolbar's
   * split buttons, and the way a user builds 3+ panes without them.
   *
   * Atomic on purpose — `splitPane` + `moveTab` would be two renders, two
   * canonicalize passes, and could not place the new pane *before* the target.
   */
  moveTabToEdge(tabId: TabId, targetPaneId: PaneId, edge: SplitEdge): void;
  /**
   * Close a whole leaf + its tabs (the PaneToolbar's close-pane button).
   * Not in ARCHITECTURE's action list, but the toolbar needs it: an empty pane
   * has no tabs left to close, so `closeTab` alone can never dismiss one.
   */
  closePane(paneId: PaneId): void;
  /**
   * Dismiss the terminal-close confirm, leaving every terminal alive. This is
   * what Escape, Cancel and a backdrop click all land on — never the close.
   */
  /**
   * Close a pane, but first confirm if it would kill a BUSY terminal. The gated
   * wrapper the pane ✕ calls; `closePane` remains the unguarded primitive.
   */
  requestClosePane(paneId: PaneId): void;
  cancelTerminalClose(): void;
  /** Carry out the close the confirm was holding, killing its terminals. */
  proceedTerminalClose(): void;
  /**
   * Rebuild a tab for every terminal in a `fleet_snapshot`, so a window that
   * reloaded (Rust + PTYs alive, JS store reset) shows its terminals again.
   *
   * Idempotent: a terminal that already has a tab is skipped, so it is safe to
   * call on every snapshot — a fresh launch has no terminals (no-op), a reload
   * has them all. Each rebuilt terminal is configured to **reattach** (the
   * registry re-subscribes to the live PTY via `terminal_reattach`, never
   * re-opens). Exited terminals get an "ended" tab.
   */
  rebuildTerminalTabs(terminals: readonly TerminalMeta[]): void;

  /* ───────────────────────────── views ───────────────────────────── */

  /**
   * New view holding one empty pane, activated. Returns its id.
   *
   * Writes the outgoing view back first (it is about to stop being live). With
   * no `name`, takes the first free "View N" — free, not `length + 1`, so
   * creating after a close never collides with a surviving name.
   */
  createView(name?: string): ViewId;
  /**
   * Switch views. **Writes `layout`/`focusedPaneId` back into
   * `views[activeViewId]` FIRST**, then loads the target's tree into them.
   *
   * A no-op when `id` is already active (it must NOT write back in that case:
   * there is nothing to switch, and touching the snapshot would be a needless
   * re-render) or unknown. Nothing is disposed — the outgoing view's terminals
   * only lose their DOM host.
   */
  activateView(id: ViewId): void;
  /** Rename a view. Trims; an empty/whitespace name is REFUSED, not stored. */
  renameView(id: ViewId, name: string): void;
  /**
   * Close a view — **rescuing its tabs, never killing them.**
   *
   * The view's tabs are moved into the focused pane of the view that is active
   * *after* the close (the neighbour when the active view is the one closing,
   * otherwise the untouched active view) — so they always land somewhere the
   * user is looking. Nothing is disposed, no `Tab` record is deleted, and no id
   * is left in `tabs` without a pane: the two failure modes (silently killing
   * running agents in a store with no undo, and leaking orphaned tabs) are both
   * excluded by construction. Only the closed view's *pane arrangement* is lost.
   *
   * Refused for the last remaining view, and for an unknown id. Call
   * `viewTabIds(state, id).length` first to tell the user what will move.
   */
  closeView(id: ViewId): void;
  /**
   * Move a tab into `viewId`'s focused pane — the cross-view counterpart of
   * `moveTab`.
   *
   * **Touches neither the `tabs` registry nor the terminal**, so the PTY and its
   * scrollback survive the move (the tab object identity and its `TerminalId`
   * are unchanged). Works in every direction — out of the active view, into it,
   * or between two inactive ones (mutating snapshots directly). A source pane
   * that empties is pruned by the same `withTabDetached` + `canonicalize` path
   * `closeTab`/`moveTab` use — there is one emptiness rule, not two.
   *
   * A no-op when the tab is already in the destination pane, or when either id
   * is unknown.
   */
  moveTabToView(tabId: TabId, viewId: ViewId): void;
  /**
   * Reorder the view bar: move `viewId` to sit immediately **before**
   * `beforeViewId`, or to the end when that is null — the same "drop A onto B"
   * contract as `moveRootAgent`/`moveFolder`, through the same shared,
   * property-tested `moveBefore` helper. A no-op for an unknown `viewId`.
   */
  reorderViews(viewId: ViewId, beforeViewId: ViewId | null): void;
  /**
   * Restore the center layout persisted in `layout-prefs.json` — the views, their
   * names, their pane arrangement, and which one was on screen.
   *
   * **Boot only** (`bridge.ts`), and a pure reconcile: NO persist, exactly like
   * `applyLayoutPrefs` — this IS what was just read off disk.
   *
   * The leaves come back empty: the terminals do not exist yet at this point in
   * boot. What belonged in each pane is parked in `pendingRestore` for
   * `rebuildTerminalTabs`, which runs once `fleet_snapshot` resolves.
   *
   * An empty/absent `views` is a no-op — a first-ever launch, or a store written
   * by a build that predates this. The boot view is kept rather than blanked.
   */
  applyCenterLayout(prefs: LayoutPrefs): void;
}

/* ────────────────────────────── fleet slice ────────────────────────────── */

/**
 * The agent forest + the selection pivot (ARCHITECTURE §4).
 *
 * Normalized exactly like the layout slice: a flat `Record` keyed by id, with
 * the tree expressed as `parentId`/`childIds` edges — never nested objects. So
 * telemetry for one agent is an O(1) write to one record, which is what lets the
 * rail re-render one row instead of a subtree (see `<AgentRow>`).
 *
 * M2 ships roots only; `spawnChild` (M3) hangs sub-agents off `childIds` and
 * every consumer already handles arbitrary depth (see `flattenFleet`).
 */
export interface FleetState {
  agents: Record<AgentId, AgentNode>;
  /** Root orchestrators, in creation order — the rail's top level. */
  rootAgentIds: AgentId[];
  selection: Selection;
  /**
   * Ids the user has **dismissed** — a tombstone against resurrection.
   *
   * Dismissal and telemetry race: after `removeAgent(X)`, Rust can still emit a
   * late `exited`/`status`/`activity`/`agent_started` for X (it dropped X from
   * its own forest at about the same instant, but events already in flight land
   * anyway). Without this guard, a stray `agent_started` — or a `fleet_snapshot`
   * taken a beat before the close — would re-create X as a ghost row, the same
   * class as the orphan-at-root bug. A dismissed agent must STAY dismissed.
   *
   * **Bounded** (FIFO, `TOMBSTONE_CAP`): late telemetry arrives within seconds,
   * so a short memory suffices and the set cannot grow without limit across a
   * long session of spawning and dismissing agents. Ordered oldest→newest.
   */
  dismissedAgentIds: AgentId[];
  /**
   * Paths whose folder-group is collapsed in the rail. A folder is
   * grouped by its root agents' `cwd`; ABSENCE means expanded — folders default
   * open (the opposite of the sub-agent tree default, and intentional).
   */
  collapsedFolders: Set<string>;
}

export interface AgentActions {
  /**
   * "+ New agent". Mints an `AgentId`, registers the node, and opens its
   * `agent-terminal` tab through the same path as any other terminal tab.
   * Returns the new id; selects it.
   */
  createAgent(opts: { cwd: string; title?: string; runtime?: string }): AgentId;
  /**
   * THE pivot (ARCHITECTURE §2.8). Re-points the centre — and, from M2's right
   * rail onward, the workspace — by swapping *ids only*: no data moves.
   */
  selectAgent(agentId: AgentId): void;
  /** Disclosure caret. Collapsed subtrees vanish from `flattenFleet`. */
  toggleAgentExpanded(agentId: AgentId): void;
  /** Folder-group disclosure. Toggles `path` in `collapsedFolders`. */
  toggleFolderCollapsed(path: string): void;
  /**
   * Reorder a ROOT agent within its folder: move `agentId` to sit
   * immediately before `targetAgentId` (or to the end of the root list when null) in
   * `rootAgentIds`. The left rail groups roots by cwd preserving `rootAgentIds`
   * order, so moving an agent ahead of a same-folder sibling reorders that folder's
   * rows. Session-only — NOT persisted: agent ids are minted per run, so there is
   * nothing stable to restore (folder order + collapse are the persisted bits).
   * A no-op for a sub-agent (only roots live in `rootAgentIds`) or a missing record.
   */
  moveRootAgent(agentId: AgentId, targetAgentId: AgentId | null): void;
  /**
   * Rename an agent (rail row AND its agent-terminal tab — one custom name per
   * agent). Empty/whitespace `name` (or null) clears it, reverting to the
   * derived `title`. Survives re-snapshots via `hydrateAgent`.
   */
  renameAgent(agentId: AgentId, name: string | null): void;
  /**
   * Remove an agent and its whole subtree from the forest, and tombstone every
   * id so late telemetry cannot resurrect it (see `dismissedAgentIds`).
   *
   * Fires on **explicit dismissal only** — a natural `exited` leaves the row
   * greyed `done`/`error` for inspection until the user acts. This is the pure
   * forest half; `dismissAgent` is the user-facing gesture that also closes the
   * agent's terminal tab.
   */
  removeAgent(agentId: AgentId): void;
  /**
   * The user-facing "dismiss this agent" — the ✕ on an `AgentRow`, and where
   * closing an agent's tab converges.
   *
   * Kills the child (via the tab's terminal teardown, which calls
   * `terminal_close`) AND removes the agent from the rail — the user is done
   * with it, not keeping a greyed `done` node. When the agent has an open tab
   * this delegates to `closeTab`, so the row ✕ and the tab ✕ run the **one**
   * dismissal path. A sub-agent (no tab of its own, M3) is removed directly.
   */
  dismissAgent(agentId: AgentId): void;
  /** Dismiss an agent, but first confirm if its terminal is busy (the rail's ✕). */
  requestDismissAgent(agentId: AgentId): void;
  /**
   * The ONLY entry point for telemetry (`agent://event`), called by `bridge.ts`.
   *
   * One tagged union reduced by one reducer, per ARCHITECTURE §1. Note what is
   * NOT in this interface: `spawnChild`. It is a module-private function
   * reachable only from inside this reducer, so "the UI must never spawn a
   * child row" is enforced by construction rather than by a comment.
   */
  applyAgentEvent(event: AgentEvent): void;
  /** `fleet_snapshot` on startup / re-attach: paint whatever Rust already has. */
  applyFleetSnapshot(agents: readonly AgentNode[]): void;
  /**
   * Pin a ROOT agent for restore-on-restart. Sets the flag AND
   * persists to Rust's pin registry (the EFFECT, run in the wrapper — never in a
   * `set` producer, same rule as `setWorkspaceRoot`'s `setDefaultTerminalCwd`).
   * No-op (flag AND effect) for a sub-agent or a missing record: sub-agents are
   * transcript-derived, so there is nothing durable to persist. Idempotent.
   */
  pinAgent(agentId: AgentId): void;
  /**
   * Unpin: clear the flag AND drop it from the registry (the persist effect).
   * Best-effort + idempotent on the Rust side, so a double-unpin is harmless.
   */
  unpinAgent(agentId: AgentId): void;
  /**
   * Boot only (`bridge.ts`): reconcile the persisted pin registry against the
   * fleet snapshot already applied. Rust auto-spawns pinned roots on boot, so
   * they arrive through `fleet_snapshot()` + the usual re-attach as normal
   * rows; this flags each matching row `pinned` so it shows its persistent
   * signal. A pin whose row is absent (Rust could not bring it back) is simply
   * skipped — there is no row to flag. Pure reconcile: no persist effect (this IS
   * what Rust just handed us).
   */
  applyPinnedAgents(views: readonly PinnedAgentView[]): void;
  /**
   * Boot only (`bridge.ts`): put the "Resumed after restart" marker on each root the
   * boot restore brought back (`restored_agents()`, phase 1 of "agents survive a
   * restart"). Same shape as `applyPinnedAgents`: the rows are already here (Rust
   * re-spawned them before the first snapshot), a view whose row is absent is skipped,
   * and it is a pure reconcile — nothing is persisted, nothing is sent to an agent.
   * The marker then comes down on its own at the agent's next turn or its end.
   */
  applyRestoredAgents(views: readonly RestoredAgentView[]): void;
}

/* ──────────────────────────── workspace slice ──────────────────────────── */

export interface WorkspaceState {
  /**
   * The folder new agents/terminals open in — the user's project root.
   *
   * `null` until startup resolves it (`bridge.ts` → `default_workspace`). This
   * exists because opening in the app binary's cwd (`.` → `src-tauri` in dev)
   * landed agents in a project with no persisted `claude` history, so ↑ recall
   * had nothing to recall. It is per-project; the root is what makes it right.
   */
  workspaceRoot: string | null;
  /**
   * Recently-used project folders, most-recent first. Loaded from
   * Rust on startup (`recent_projects`) and kept in front-of-mind order: powers
   * the ⚡ quick-launch (recentProjects[0]) and the rail's folder ordering.
   */
  recentProjects: string[];
  /**
   * Folders the user manually opened in the Files panel, most-recent
   * first and deduped. These are **browse-only** roots — a folder shown in the
   * right rail with no agent of its own. The Files panel's actual roots are the
   * `workspaceRoots` selector's union of these with the root agents' cwds; this
   * field holds only the manual half (the half that persists once every agent in
   * it closes). `workspaceRoot` (single) is unaffected — Find + new-terminal cwd
   * still ride on it.
   */
  browseRoots: string[];
  /**
   * The user's manual folder ordering — the SINGLE source of truth both rails sort
   * by. A folder's absolute path appears here once; both the left
   * (Agents) rail (`flattenFleet`) and the right (Files) rail (`workspaceRoots`) map
   * their visible folders through `orderFolders(paths, folderOrder)`, so a drag in
   * either rail — which rewrites this list — keeps the two sides in the same sort.
   *
   * Seeded from the persisted store on boot, then kept complete by `syncFolderOrder`
   * (any newly-discovered folder is appended). Paths no longer visible are retained,
   * so a folder that reappears keeps its slot — the same "persist even when absent"
   * behaviour as `recentProjects`.
   */
  folderOrder: string[];
  /**
   * Folder paths collapsed in the RIGHT (Files) rail — persisted so a restart
   * reopens them the way the user left them. ABSENCE means expanded
   * (the default). The left rail's equivalent is `collapsedFolders` (FleetState);
   * the two are intentionally independent — collapsing a folder's agents does not
   * collapse its files.
   */
  collapsedRoots: Set<string>;
  /**
   * "Focus follows agent" (persisted setting). When true, selecting/changing the
   * active agent in the left rail collapses every OTHER Files-rail folder and leaves
   * the selected agent's working-directory folder expanded. When false (the default),
   * agent selection does not touch `collapsedRoots` — today's behaviour. Seeded from
   * the persisted store on boot (`applyLayoutPrefs`) and flipped by
   * `setFocusFollowsAgent`, which persists it via the same wholesale save.
   */
  focusFollowsAgent: boolean;
  /**
   * How the agent rail draws a project (Settings → Interface → Project groups). Persisted
   * with the rest of the rail prefs; `applyLayoutPrefs` seeds it on boot, reading anything
   * this build does not know as the default ("card").
   */
  railGroupStyle: RailGroupStyle;
}

export interface WorkspaceActions {
  /**
   * Set the workspace root, and re-point the terminal default cwd to match so
   * "+ New terminal" opens there too. The `setDefaultTerminalCwd` effect runs
   * in this wrapper, never a reducer.
   */
  setWorkspaceRoot(path: string): void;
  /** Replace the recent-projects list (from Rust on startup). */
  setRecentProjects(paths: readonly string[]): void;
  /**
   * Move `path` to the front of the recent-projects list (dedup). Called
   * whenever an agent is launched in a folder, so ⚡ and folder ordering track
   * usage. The Rust `push_recent_project` is the persisted source of truth; this
   * mirrors it into the store immediately for the UI.
   */
  addRecentProject(path: string): void;
  /**
   * Open a browse-only root in the Files panel: prepend `path` to
   * `browseRoots` (dedup — an already-open folder moves to the front), and
   * AUTHORIZE it for `read_dir` by pushing it to the persisted recents. That
   * push is the EFFECT, run in the wrapper (never a reducer), the same shape as
   * `setWorkspaceRoot`'s `setDefaultTerminalCwd`.
   */
  addBrowseRoot(path: string): void;
  /** Close a browse root (its ✕ in the Files panel). Drops it from `browseRoots`. */
  removeBrowseRoot(path: string): void;
  /**
   * Ensure every currently-visible folder is present in `folderOrder`, appending any
   * that are new (in the given order) so both rails have a total order to sort by.
   * A no-op — including NO persist and NO state write — when nothing was added, so it
   * is safe to call on every telemetry tick (see `bridge.registerFleetRoots`).
   * Persists only when the order actually grew.
   */
  syncFolderOrder(paths: readonly string[]): void;
  /**
   * Reorder a folder: move `path` to sit immediately before `targetPath` (or to the
   * end when `targetPath` is null) in `folderOrder`. Drives BOTH rails' folder DnD —
   * a drag in either rail calls this, and because both read `folderOrder` the other
   * rail moves in lockstep. Persists.
   */
  moveFolder(path: string, targetPath: string | null): void;
  /**
   * Right-rail (Files) folder disclosure. Toggles `path` in
   * `collapsedRoots` and persists, so the collapse survives a restart. The left
   * rail's counterpart is `agentActions.toggleFolderCollapsed`.
   */
  toggleRootCollapsed(path: string): void;
  /**
   * Set the "focus follows agent" toggle and PERSIST it (the wrapper effect, never
   * inside the producer). When turning it ON, the collapse is applied
   * IMMEDIATELY to the CURRENT selection, so the setting takes effect at once rather
   * than only on the next agent click. Turning it OFF just clears the flag (the
   * existing collapse state is left as the user last had it).
   */
  setFocusFollowsAgent(on: boolean): void;
  /** Choose how the agent rail draws projects, and persist it. */
  setRailGroupStyle(style: RailGroupStyle): void;
  /**
   * Boot only (`bridge.ts`): seed `folderOrder` + both collapse sets + the
   * `focusFollowsAgent` setting from the persisted store. Pure reconcile — NO persist
   * (this IS what Rust just handed us), the same shape as `applyPinnedAgents`.
   */
  applyLayoutPrefs(prefs: LayoutPrefs): void;
}

/* ── the Files-panel roots selector ───────────────────────────────────────── */

/** The exact slice `workspaceRoots` reads — a structural subset of the store, so
 *  the component (or a test) can pass the three fields, or the whole state. */
interface WorkspaceRootsSlice {
  rootAgentIds: readonly AgentId[];
  agents: Record<AgentId, AgentNode>;
  browseRoots: readonly string[];
  /**
   * The shared folder order. Optional so a caller that predates it (or a
   * test) can omit it and get the historical discovery-order behaviour; when present,
   * the returned roots are sorted by it so the Files rail matches the Agents rail.
   */
  folderOrder?: readonly string[];
}

/**
 * The Files panel's roots: one per UNIQUE folder path — the distinct
 * cwds of the ROOT agents (the same dedup the AGENTS rail's folder grouping does)
 * followed by the user-opened browse roots, deduped by exact path. A folder that is
 * BOTH an agent cwd and a browse root appears ONCE. N agents in one folder → one root.
 *
 * The final order is `folderOrder`: the same list the left rail sorts by,
 * so both rails show folders in the same sequence and a drag in one moves the other.
 * Discovery order (agent cwds first, then browse roots) is only the fallback for a
 * folder not yet in `folderOrder` — a transient, since `syncFolderOrder` keeps them
 * all listed.
 */
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

/**
 * Reactive UI state for one open file, keyed by path (the heavy buffer lives in
 * the non-React EditorRegistry, which survives tab switches; this is only the
 * lightweight state the header + tab need). `dirty` is NOT here — it rides on the
 * tab record (`Tab.dirty`) so the existing tab dot renders it unchanged.
 */
export interface EditorUiState {
  status: "loading" | "ready" | "error";
  /**
   * Editable normal text files open writable by default (like a normal IDE).
   * False = oversized / binary-gated → read-only, no editing (the safety rail is
   * the • dirty dot + Cmd/Ctrl+S + the close-confirm, not an opt-in gate).
   */
  editable: boolean;
  /** Last save's error message, or null; kept until the next edit/save. */
  saveError: string | null;
  /** Bumps on each successful save — drives the transient "Saved" flash. */
  savedAt: number;
  /**
   * The file changed on disk while THIS buffer had unsaved edits.
   *
   * 🔴 Only ever set for a dirty buffer. A clean one is reloaded silently — that
   * is the whole point, since this app exists to watch agents edit your files.
   * A dirty one is never overwritten behind the user's back: the editor shows a
   * notice with a Reload, and the choice is theirs. Losing work to a background
   * refresh would be a far worse bug than the staleness it fixes.
   */
  staleOnDisk: boolean;
  /**
   * Markdown-preview zoom for this file (1 = 100%). Held here — not in the
   * component — so it survives tab switches (the `DbConsoleState.splitFraction`
   * precedent); session-only on purpose, like every per-view UI fraction.
   */
  previewZoom: number;
  /**
   * The user flipped this previewable file to its raw SOURCE.
   *
   * Held here rather than in `CodeEditor` because it is per-TAB state, and it is
   * the last member of that family to move: `Pane` renders only the ACTIVE tab
   * and a cross-pane drag re-parents the subtree, so React remounts on both —
   * and a `useState(true)` toggle therefore snapped back to Preview on every tab
   * switch and every drag. False (the rendered view) is the default for every
   * kind, so absence reads correctly as "show me the rendered thing".
   */
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
  /**
   * Set the markdown-preview zoom for a path. Clamped by the preview's own
   * `clampPreviewZoom`; unknown paths are a no-op, never a crash.
   */
  setPreviewZoom(path: string, zoom: number): void;
  /**
   * Show the raw SOURCE of a previewable file instead of its rendered view.
   * Unknown paths are a no-op, never a crash — same contract as
   * `setPreviewZoom`, whose slice this rides in.
   */
  setShowSource(path: string, showSource: boolean): void;
  /** Forget a path's UI state (its tab closed). */
  disposeEditor(path: string): void;
  /**
   * Close a tab, but a DIRTY editor first raises the unsaved-changes confirm
   * (set `confirmCloseTab`) instead of closing outright. Everything else closes
   * immediately, exactly like `closeTab`.
   */
  requestCloseTab(tabId: TabId): void;
  /** Dismiss the confirm without closing. */
  cancelCloseTab(): void;
  /** Close the tab pending confirmation (Discard, or Save-then-close). */
  closePendingTab(): void;
}

/* ──────────────────────────── LSP slice ───────────────────────────────────────── */

/**
 * One usage of a symbol (find-usages). Mirrors a Find-in-Files hit so
 * the references panel can reuse the same row rendering: an absolute `path` to
 * jump to, a `display` path (relative to the workspace root when possible), a
 * 1-based `line`/`col` (the `revealInEditor` contract), and the source `lineText`
 * with the reference span marked by UTF-16 offsets `[matchStart, matchEnd)`.
 */
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

/**
 * Reactive UI state for code intelligence (LSP), keyed by `LanguageId`. The
 * JSON-RPC client + document sync live in `features/editor/lsp/`; this holds only
 * the calm status surface the editor header shows.
 */
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
  /**
   * Whether the Find-in-Files overlay is open. Lifted here so the
   * Cmd/Ctrl+Shift+F hotkey AND the right rail's Find tab drive the SAME overlay
   * — the tab is an action that opens it, not a persistent panel.
   */
  findInFilesOpen: boolean;
  /**
   * Which PERSISTENT panel the right rail shows.
   * "find" is not here: Find is a momentary overlay action (`findInFilesOpen`), so
   * opening it never changes which panel is mounted — only Files ↔ Vault ↔ History.
   */
  rightRailTab: RightRailTab;
  /** Whether the left rail (AGENTS) is collapsed (VS-Code-style panel toggle). */
  leftRailCollapsed: boolean;
  /** Whether the right rail (Files/Vault/History) is collapsed. */
  rightRailCollapsed: boolean;
  /** Left rail width in px (drag-resizable); clamped to [RAIL_MIN_W, RAIL_MAX_W]. */
  leftRailWidth: number;
  /** Right rail width in px (drag-resizable); clamped to [RAIL_MIN_W, RAIL_MAX_W]. */
  rightRailWidth: number;
  /**
   * A one-shot "reveal this file in the Files tree" request (IntelliJ's
   * "Select Opened File"). Set by `uiActions.revealActiveFile()`;
   * consumed by the WorkspaceTree root subtree whose root contains `path`
   * (expand the ancestor chain → select the file → scroll it into view).
   * `token` is a monotonic counter so revealing the SAME path twice re-fires —
   * the consumer remembers the last token it handled, the same seen-token
   * pattern as the tree's `rootCreate`. UI-transient; never persisted.
   *
   * `root` is the workspace root that owns `path`, or **null when no open root
   * contains it** — and that null is the whole reason the field exists. Before
   * it, such a reveal was a silent total no-op: the request was posted, every
   * subtree early-returned because the path was not under ITS root, and the only
   * visible effect was the rail flipping to Files. The answer is computed once
   * here (where the roots and the longest-match rule already live) and carried on
   * the request, so the tree can SAY so instead of re-deriving it.
   */
  fileReveal: { path: string; token: number; root: string | null } | null;
}

/**
 * One local find bar's surviving state. `cursor` is the match ordinal the user
 * had walked to; a surface clamps it against the CURRENT match list on mount,
 * because the content may have changed while the tab was away.
 */
export interface FindBarState {
  open: boolean;
  query: string;
  cursor: number;
  /**
   * The response body's Raw/Formatted choice — same unmount, same loss, same
   * fix, and it belongs with the bar because the search semantics differ by
   * view (raw matches punctuation; formatted matches what the tree draws).
   * Other surfaces simply never set it.
   */
  view?: "raw" | "formatted";
}

export interface UiActions {
  /**
   * Merge a patch into one find bar's state, creating it as
   * `{open:false, query:"", cursor:0}` first. One writer for every surface, so
   * "how a find bar survives a tab move" has exactly one answer.
   */
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
  /**
   * IntelliJ's "Select Opened File": reveal the file the Files rail is
   * on — `activeFilePath`, i.e. the focused pane's file tab, or the last file tab
   * activated anywhere if the focused pane is showing a terminal. A no-op only
   * when no file tab is open at all. Makes the target visible first —
   * un-collapses the right rail, switches it to Files, and expands a collapsed
   * containing root — then posts the one-shot `fileReveal` request the owning
   * root subtree consumes (expand ancestors → select → scroll).
   *
   * This is the deliberate, LOUD gesture. The tree's row highlight follows
   * `activeFilePath` on its own and must NOT do any of the above — see
   * `WorkspaceTree`.
   */
  revealActiveFile(): void;
}

/* ──────────────────────────── API client slice ───────────────────────────────────────── */

/**
 * One editable request-header row. `enabled` gates whether it is actually sent
 * (an unchecked row stays visible but is dropped from the wire request), and the
 * stable `id` keys the row so editing one never re-orders the others.
 */
export interface HeaderRow {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

/**
 * One line in the WS console's message log. `dir` is the direction
 * (`out` sent, `in` received, `sys` a lifecycle note); `data` is the payload (or
 * the note text); `at` is an epoch-ms timestamp the CALLER stamps (`Date.now()`)
 * so the reducer that appends it stays pure and deterministic in tests.
 */
export interface WsLogEntry {
  dir: "out" | "in" | "sys";
  data: string;
  at: number;
}

/**
 * Live state for one request's WebSocket console. Lives in the store
 * (not component state) so the connection survives tab switches: the `onEvent`
 * callback keeps appending here after the view unmounts, and a re-mount just
 * reads it back. `connectionId` is the handle `ws_send`/`ws_close` address — it
 * is set from the `ws_connect` promise resolve, independently of the `open`
 * event that flips `status` (the two can land in either order). In-memory ONLY
 * (secrets never touch disk): a `wss://` URL or a message never touches disk.
 */
export interface WsState {
  status: "idle" | "connecting" | "open" | "closed" | "error";
  connectionId: string | null;
  messages: WsLogEntry[];
  draft: string;
  error: string | null;
}

/**
 * Live state for one request's gRPC console. Lives in the
 * store (not component state) so the reflected schema + last response survive a
 * tab switch — the view can unmount and re-mount and read the accumulated state
 * back (same rationale as `WsState`). In-memory ONLY: an endpoint,
 * message, or metadata value never touches disk.
 *
 * `endpoint`/`message`/`metadata` are NOT stored here — they reuse the request's
 * `url`/`body`/`headers` (the same way `WsState` overloads `url`). This sub-state
 * holds only what is gRPC-specific: the plaintext flag, the reflected schema, the
 * selection, and the last call's outcome.
 */
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

/**
 * Live state for one request's A/B compare mode (HTTP lane): a SECOND
 * method+url ("B") sent simultaneously with the request's
 * own ("A"), with both outcomes rendered side by side. Headers and body are NOT
 * stored here — B reuses the request's own, so the comparison varies only what
 * the second bar shows (same rationale as `GrpcState` overloading `url`/`body`).
 *
 * Lives in the store (not component state) so both responses, the selected key
 * and the sort toggle survive a tab switch — `Pane` unmounts the inactive tab
 * (the `DbConsoleState.splitFraction` precedent). In-memory ONLY.
 */
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

/**
 * UI state for one open API request, keyed by id (ARCHITECTURE-style normalized
 * record). In-memory ONLY — the secret-safety rule: this record persists
 * nothing, so a bearer token typed into a header never touches disk. `response`
 * and `error` are the last send's outcome (mutually exclusive on success);
 * `sending` is true while a send is in flight.
 *
 * `protocol` toggles the tab between the HTTP request/response
 * surface, the live WebSocket console (`ws`), and the gRPC console
 * (`grpc`) — each sub-state holds that surface's whole state.
 */
/**
 * Undo history for a request BODY (an edit to a request body must stay
 * undoable with Cmd+Z after switching to another window or after executing
 * the request).
 *
 * 🔴 **In the store on purpose, because the browser's own undo cannot do this
 * job.** The body is a CONTROLLED `<textarea>`; `Pane` unmounts an inactive tab,
 * so switching tabs destroys that DOM node and the native undo stack with it, and
 * any programmatic rewrite (Format, a pasted curl, loading a saved request) makes
 * the browser drop it too. A history that survives those is a history that does
 * not live in the DOM.
 */
export interface BodyHistory {
  /** Snapshots BEFORE each edit group, oldest first. */
  past: string[];
  /** Snapshots undone away, for redo. Cleared by any fresh edit. */
  future: string[];
  /** When the last edit landed — the coalescing clock (see `patchApiRequest`). */
  at: number;
}

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

/**
 * One step of a sequence.
 *
 * 🔴 **A step OWNS its request** (`requestId` → a real `ApiRequestState`) rather
 * than pointing at a saved collection request. `saveRequestToCollection` upserts
 * **by name** and mints a **brand-new id** each time, so a saved-request id is not
 * stable and a sequence holding one would dangle silently the first time the user
 * re-saved. Owning it also means a step reuses the whole request editor for free.
 */
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

/**
 * A named list of requests run in order, carrying values forward (to test a
 * flow).
 *
 * 🔴 **In memory only, exactly like `apiRequests` — and `captured` is the reason
 * that is not negotiable.** It holds live bearer tokens by construction. Writing
 * it to `api-store.json` would put credentials on disk (against the whole
 * secret-safety premise) *and* fire a whole-blob save per step from a launch-time mirror that
 * Rust also writes — the lost-update shape (two writers, one file, one in-memory
 * mirror), at high frequency. A sequence is a scratchpad; losing it on restart is correct.
 */
export interface SequenceState {
  id: string;
  name: string;
  steps: SequenceStep[];
  running: boolean;
  /**
   * Stop at the first failing step, or run them all anyway.
   *
   * A real toggle rather than a constant because both are needed: a
   * chained flow's later steps are usually meaningless once one fails (hence the
   * `true` default), but a list of independent checks wants every outcome.
   */
  stopOnFailure: boolean;
  expandedStepId: string | null;
  /**
   * The run-scoped capture bag: `name → value`, accumulated as steps run.
   *
   * In the store rather than a local inside the runner **because a step run
   * MANUALLY has to see values captured by an earlier, separate run** — that is
   * exactly what stepping through a flow one request at a time means (requests are
   * runnable manually, one by one, not only automatically).
   * Cleared by `resetSequenceRun`, so a fresh run can never inherit a stale token
   * and report a green that the next person cannot reproduce.
   */
  captured: Record<string, string>;
}

export interface ApiState {
  apiRequests: Record<string, ApiRequestState>;
  /** Request sequences, by id. In memory only — see `SequenceState`. */
  sequences: Record<string, SequenceState>;
  /**
   * Saved requests. Persisted via the Rust store; header/url/body
   * keep any `{{VAR}}` placeholders LITERAL — a secret is never written into a
   * collection.
   */
  apiCollections: SavedRequest[];
  /**
   * Saved-request FOLDERS, **already in display order** —
   * Rust owns the ordering and hands the list back sorted, so nothing here re-sorts
   * it. A request with no `folderId` is at the root, which is why every request that
   * existed before folders needs no migration.
   *
   * Mutated only by the `api_folder_*` / `api_request_move` commands, each of which
   * returns the whole store and re-hydrates this mirror — never by a local edit
   * followed by a blob save.
   */
  apiFolders: ApiFolder[];
  /**
   * Ids of the folders the user has collapsed in the Collections rail. A `Set` for
   * the same reason `collapsedRoots` is one, and persisted in `layout-prefs.json`
   * (the file that already means "which folders are shut") rather than in
   * `api-store.json` — a UI preference has no business in the Vault.
   */
  collapsedApiFolders: Set<string>;
  /** Named variable sets (which hold live tokens). Persisted via the Rust store. */
  apiEnvironments: Environment[];
  /** The environment whose variables the send path substitutes, or null. */
  activeEnvironmentId: string | null;
  /**
   * True once the durable store has been hydrated from Rust (the view loads it
   * on first mount). Gates the one-time load so re-opening the API tab does not
   * re-fetch and clobber in-flight edits.
   */
  apiStoreLoaded: boolean;
  /**
   * The persisted request history — every executed request, oldest
   * first (the panel renders newest-first). Each entry keeps `{{VAR}}` LITERAL, so
   * no resolved secret is ever recorded. No cap, no dedup.
   */
  apiHistory: HistoryEntry[];
  /** True once history has been hydrated from Rust — gates the one-time load. */
  apiHistoryLoaded: boolean;
  /**
   * The open "name this request" dialog, or null when closed. Set when
   * Cmd/Ctrl+S fires on an API-request tab that still carries the default title, so
   * the user must pick a name before it lands in Collections. Carries the request to
   * save AND the tab to retitle once named.
   */
  saveRequestPrompt: { requestId: string; tabId: TabId } | null;
}

/**
 * Sequence editing + run bookkeeping. The RUNNING itself lives in
 * `features/api/sequenceExecute.ts` — these only move state, never send.
 */
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
  /**
   * Copy an existing request into a brand-new one and return its id — Postman's
   * Duplicate. Returns `null` when `sourceId` names nothing.
   */
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
  /**
   * Mark the A/B send in flight. Starting (`true`) clears BOTH previous
   * outcomes; the executor settles it (`false`) only once both sides land.
   */
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
  /**
   * Snapshot the live request (method/url/headers/body) into the collections
   * under `name`, minting a fresh id. Text is stored with `{{VAR}}` placeholders
   * LITERAL — never a resolved secret. Replaces an existing collection of the
   * same name in place, else appends. Persists.
   */
  saveRequestToCollection(requestId: string, name: string): void;
  /** Drop a saved request by id. Persists. */
  deleteCollection(id: string): void;
  /**
   * Copy a saved request's fields into an open request (method/url/headers/body);
   * each saved header becomes a fresh enabled row. A no-op if either id is
   * unknown. Mutates only the request, so it does NOT persist the durable store.
   */
  loadCollectionIntoRequest(collectionId: string, requestId: string): void;
  /**
   * Open a saved request in a NEW API-request tab (the Collections rail).
   * Mints a fresh request, restores the saved fields INCLUDING its protocol (so a
   * gRPC/WS save re-opens into the right surface), opens a tab for it, and titles
   * the tab with the saved name. Returns the new tab id, or null for an unknown id.
   */
  openSavedRequest(collectionId: string): TabId | null;
  /**
   * Cmd/Ctrl+S from the focused pane. If its active tab is an API
   * request: save it into Collections — using the tab's custom name if the user
   * renamed it, else opening the name dialog (`saveRequestPrompt`) because the tab
   * still carries the default "New request". A no-op (returns false) when the active
   * tab is any other kind, so an editor's own Cmd/Ctrl+S file-save still wins.
   */
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

  /**
   * Re-read `api-store.json` and re-hydrate this mirror. A no-op if the read failed
   * (`readApiStore` returns null), because blanking the mirror on a transient failure
   * is how the blob save would then blank the file.
   *
   * 🔴 Exists because Rust also writes this file: `db_connection_upsert` puts a DB
   * password in the Vault. The mirror is hydrated once per app run, so without this
   * the password is invisible until restart AND the next collection edit writes the
   * pre-password snapshot back over it.
   */
  refreshApiStore(): Promise<void>;
  /**
   * Create a folder. Blank/whitespace names are dropped here as well as in Rust —
   * the round trip is pointless when the answer is already known.
   *
   * Every folder action below goes through a Rust command that re-reads the file and
   * returns the WHOLE store, and re-hydrates from that return value. None of them
   * mutate local state and then blob-save it, which is the shape that loses writes.
   */
  createApiFolder(name: string): Promise<void>;
  /** Rename a folder. Blank names are dropped, as on create. */
  renameApiFolder(id: string, name: string): Promise<void>;
  /**
   * Delete a folder. Its saved requests are **returned to the root, never deleted** —
   * the decision is Rust's `delete_folder`, asserted there and in the store tests.
   */
  deleteApiFolder(id: string): Promise<void>;
  /** File a saved request under `folderId`, or at the root when it is null. */
  moveRequestToFolder(requestId: string, folderId: string | null): Promise<void>;
  /**
   * Reorder: put folder `id` immediately BEFORE `beforeId` (or last, when null).
   * Computed with the shared, property-tested `moveBefore` — the same primitive both
   * rails' folder drags use — so this repo has exactly one list-move.
   */
  moveApiFolder(id: string, beforeId: string | null): Promise<void>;
  /** Disclose/collapse a folder in the Collections rail. Persists to layout prefs. */
  toggleApiFolderCollapsed(id: string): void;

  /* ── request history ── */

  /** Replace the history log from a loaded store; mark loaded. The READ side — does
   *  NOT persist (this IS what Rust just handed us). */
  hydrateApiHistory(store: HistoryStore): void;
  /**
   * Append one executed request to the history log and persist. `entry` carries the
   * LITERAL request (`{{VAR}}` kept, no resolved secret) plus its outcome and an
   * `at` timestamp; the action mints the id. No cap, no dedup.
   */
  recordApiHistory(entry: Omit<HistoryEntry, "id">): void;
  /** Empty the history log and persist. */
  clearApiHistory(): void;
  /**
   * Copy a history entry's request fields into an open request
   * (method/url/headers/body); each recorded header becomes a fresh enabled row. A
   * no-op if either id is unknown. Mutates only the request — does not persist.
   */
  loadHistoryIntoRequest(entryId: string, requestId: string): void;
  /**
   * Replace an open request's method/url/headers/body from a parsed cURL import
   * (Postman-style). Each header becomes a fresh enabled row; a null body
   * clears to "". A no-op if the request id is unknown. Does not persist.
   */
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

/**
 * What we know about ONE connection's live session.
 *
 * Keyed by CONNECTION id, not session id: every consumer (the rail row, the console tab,
 * the delete confirm) starts from a connection, and a `Record<sessionId, …>` would make
 * "is this connection connected?" a scan. Rust holds the real registry; this is the
 * store's mirror of it, in the same relationship `recentProjects` has to the persisted
 * recents.
 *
 * There is no `"idle"` status: absence IS idle. A record exists only from the moment a
 * connect is attempted, so "never connected" and "connected then closed" cannot drift
 * apart into two spellings of the same thing.
 */
export interface DbSessionState {
  status: "opening" | "open" | "error";
  /** The opaque handle `db_query`/`db_close` address. Never a DSN, never a credential. */
  sessionId: DbSessionId | null;
  /** The server's own version string — the proof a real round trip happened, not a socket. */
  serverVersion: string | null;
  latencyMs: number | null;
  /**
   * Why it failed, as ONE honest sentence — either Rust's already-mapped-and-redacted
   * `DbTestResult.error`, or `describeDbError` of the rejection's code. **Never** a raw
   * driver string: `sqlx` and libpq echo the DSN they dialled into their error text.
   */
  error: string | null;
}

/**
 * One query console's contents. Survives a tab switch; deliberately does NOT survive a
 * restart — a half-typed statement restored against a database is a footgun, and the
 * durable thing is a *saved query* (a later slice), which is an explicit gesture.
 */
export interface DbConsoleState {
  /** The editor buffer. */
  text: string;
  /** One entry per statement, in execution order. Empty until the first run. */
  results: DbResultSet[];
  /**
   * The *call* failed (no session, TLS, timeout). A failed statement is a result.
   *
   * Holds the **code and the sentence**, not the code alone. It used to hold only the code, and
   * that was half of a misattribution bug: even after Rust started sending
   * a sentence worth reading, there was nowhere between the rejection and the results pane for it
   * to live, so `<DbConsole/>` had no choice but to re-describe the code.
   */
  error: DbFailure | null;
  /** A query is in flight AND we are still waiting for it — see `runToken`. */
  running: boolean;
  /**
   * Bumped on every run and on every Stop. A reply whose token is stale is **discarded**.
   *
   * This is the half of Stop that cannot fail, and it is why the button is instant: `db_cancel`
   * asks the server as well, but every engine's cancel is advisory and three engines
   * have none at all — so the local half still carries the guarantee.
   */
  runToken: number;
  /** The editor's share of the split — session-only, held here across tab switches. */
  splitFraction: number;
  /**
   * Which saved query this console is editing, or `null` for an unnamed buffer.
   *
   * The **name is carried alongside the id** rather than looked up in `dbSavedQueries`, and
   * that is load-bearing: `db_saved_query_upsert` requires a name on every call (an update
   * with a blank one is refused), so a ⌘S that could not find the record would have nothing
   * to send. Holding both makes the update self-contained — the keystroke cannot fail because
   * a *list* has not been loaded.
   */
  savedQuery: { id: string; name: string } | null;
  /**
   * Why the last save failed, as one mapped sentence, or `null`.
   *
   * Separate from `error` (which is a failed *query*) because they are different events with
   * different next moves, and because a save failure must not clear the results the user just
   * got. `<DbConsole/>` has no prop for it — it is presentational and owned elsewhere — so
   * `<DbConsoleTab/>` renders it above the console.
   */
  saveError: string | null;
  /**
   * Why the last **cancel** could not be delivered, as one sentence, or `null`.
   *
   * Its own field for the reason `saveError` is: three different events with three different next
   * moves. A failed cancel must not read as a failed query (`error`) — the query is fine, and may
   * well still be running — and it must not clear the results the user already has. The commonest
   * value is not a failure at all but a fact: MongoDB, Redis and DynamoDB have no server-side
   * cancel, so pressing Stop there says so instead of appearing to work.
   */
  cancelError: string | null;
}

/** See {@link DbState.dbAgentNotice}. */
export interface DbAgentNotice {
  connectionId: string;
  created: boolean;
  agent: string | null;
  /**
   * A query the agent ran: its text, Agent Studio's refusal (`error`) or what came back
   * (`outcome`, e.g. "2 rows"), and whether the console shows its results — `"busy"` when the
   * user's own run held the console, `"closed"` when the console is not connected.
   */
  ran?: {
    query: string;
    error: string | null;
    outcome: string | null;
    console: "shown" | "busy" | "closed";
  };
  /**
   * A query the agent wrote that was kept OUT of a console holding the user's own text. It goes
   * in only when the user presses "Put in console" (`putAgentDbQueryInConsole`).
   */
  offer?: string;
}

export interface DbState {
  /** The engine registry, exactly as `db_engines()` served it. Rendered, never interpreted. */
  dbEngines: EngineSpec[];
  /**
   * The saved connections, as Rust last handed them back. **Holds no secret by
   * construction**: `passwordRef` is `""` or a `{{VAR}}` name, and a raw `url` has had its
   * credentials split out server-side before it was ever persisted.
   */
  dbConnections: DbConnection[];
  /**
   * True once the registry AND the connection store have been read once. Gates the one-shot
   * load, so re-opening the DB rail tab does not refetch — and is deliberately NOT set on a
   * failure, so a transient error is retried on the next mount instead of going sticky.
   */
  dbLoaded: boolean;
  /** A PANEL-level failure (the load, a delete), already mapped to one sentence. */
  dbError: string | null;
  /** Live sessions, keyed by connection id. Absence = not connected. */
  dbSessions: Record<string, DbSessionState>;
  /**
   * The open query consoles' contents, keyed by connection id.
   *
   * 🔴 **This is in the store because `Pane` unmounts the inactive tab.** `TabView` renders
   * only the active tab, so a console holding its SQL in component state loses the whole
   * buffer the moment you click the terminal beside it — the single most destructive thing
   * a query editor can do. Keying by connection id (not tab id) matches
   * `openDbConsoleTab`'s dedupe: one console per connection, one session, one draft.
   */
  dbConsoles: Record<string, DbConsoleState>;
  /**
   * The open connection dialog, or `null` when closed. `connectionId: null` means "new".
   *
   * In the store rather than in `<DbPanel/>`'s own state because the dialog will also be
   * opened from elsewhere (the console tab's "Edit connection"), and two components each
   * holding their own copy of "is the modal open" is how two modals end up on screen.
   */
  dbDialog: { connectionId: string | null } | null;
  /**
   * What an agent just did that the user must hear about, shown as a notice at the top of the DB
   * panel until dismissed: a connection it added or opened through `agent-studio db connect`, a
   * query it ran through `agent-studio db query` (`ran` — every run, refused ones too, so nothing
   * an agent does to a database goes unseen), or a query it wrote for a console the user was
   * already writing in (`offer`). `agent` is the agent's name when its terminal is an agent we
   * know, else `null` ("an agent").
   */
  dbAgentNotice: DbAgentNotice | null;
  /**
   * The lazily-loaded object tree, one subtree per connection id.
   *
   * In the store, not in `<DbTree/>`'s own state, although a tree buffer is usually
   * component state, not app state. There is a concrete reason: `<RailTabs/>` unmounts the
   * whole DB panel when the user clicks Files, so a tree in component state re-issues one
   * `db_children` call per expanded level on the way back. Those are catalogue queries against
   * a production server, paid for a rail-tab click. A tree buffer is not interesting state, but
   * it cannot live somewhere this app unmounts on a UI toggle.
   *
   * Dropped wholesale on disconnect and on delete: a cached table list from a session that is
   * gone is a tree the user can click and get `not-found` from.
   */
  dbTrees: Record<string, DbTreeState>;
  /**
   * The saved queries, per connection id.
   *
   * Keyed by CONNECTION, not by session, because that is the requirement: after the app
   * has been closed, double-clicking the database must still show the list. Read
   * with `db_saved_queries`, which takes a connection id and needs no session at all — so the
   * list is there even when the database is unreachable.
   */
  dbSavedQueries: Record<string, DbSavedQueryListState>;

  /**
   * The user's hand-arranged tree order, per connection id → parent `nodeKey` → child labels
   * (tables can be reordered by hand, for example A, B, C into C, B, A).
   *
   * A SIBLING of `dbTrees`, deliberately not a field inside it. `refreshDbTree` empties
   * `dbTrees[id].children` on every schema refresh and after every write from a console, and
   * `dbTrees[id]` is deleted wholesale on disconnect and on a connection edit — so an
   * arrangement stored in there would survive until the first `CREATE TABLE` and then quietly
   * vanish. This one is backed by `db-tree-order.json` and outlives all of it, which is the
   * whole point of the feature.
   *
   * An ABSENT entry means "no custom order" and renders as the engines' alphabetical order.
   * An empty array is never stored — see `dbTreeOrderSet`, where clearing and dragging are the
   * same command precisely so the two cannot mean different things on disk.
   */
  dbTreeOrders: Record<string, Record<string, string[]>>;

  /**
   * Every local find bar's state, keyed by the SURFACE's own stable key
   * (the find bar used to disappear on a tab move, the HTTP request view
   * included).
   *
   * `Pane` renders only the active tab and a cross-pane drag re-parents the
   * subtree, so a component's `useState` dies on every tab switch and every
   * move — which is exactly where every find bar except the editor's kept its
   * open/query/cursor. This is the same store-over-component-state decision as
   * `dbConsoles` and `bodyHistory`, made once for all find surfaces instead of
   * per-surface again: the key namespaces them (`api:<requestId>`,
   * `compare:<requestId>:<side>`, `preview:<path>`, `grid:<connectionId>:<resultIndex>` (one bar per rows-result — a script run renders several grids in one console),
   * `terminal:<terminalId>`), so two tabs can never share a bar by accident.
   *
   * The editor's CM6 find deliberately does NOT move here: its state already
   * survives inside the `EditorRegistry`-owned view, and a second copy would
   * be a second source of truth. Same for the terminal's QUERY (it survives in
   * the TerminalRegistry) — only the terminal bar's `open` uses this.
   *
   * An ABSENT key means "closed, empty" — `dropFindBar` deletes rather than
   * zeroes, so closing a bar cannot leave a tombstone per tab forever.
   */
  findBars: Record<string, FindBarState>;

  /**
   * Where the user had scrolled each tab surface to, keyed the same way as
   * [`findBars`] (without it, after scrolling a database response and
   * switching tabs, coming back lands at the top again; the same happens on
   * the HTTP requests).
   *
   * Same root cause as the find bars and the same remedy: `Pane` unmounts an
   * inactive tab, so a scroll offset — which lives in a DOM node, not in React
   * — dies with it. Persisted on unmount and restored on mount rather than
   * written on every scroll event: a tab move is the only moment the value is
   * needed, and one write per move beats hundreds per drag.
   */
  scrollOffsets: Record<string, number>;

  /**
   * A results grid's VIEW of its data — the column it is sorted by and any
   * hand-dragged column widths — keyed like [`findBars`] (without it, a sorted
   * grid went back to its original order after a tab move).
   *
   * Third member of the same family as `findBars` and `scrollOffsets`, and the
   * last piece of `ResultsGrid` a tab move could still throw away. A sort is a
   * question the user asked of the data; losing it on a tab switch makes the
   * grid feel like it forgets what it was told.
   *
   * Deliberately NOT persisted to disk: it describes one result set, and a
   * result set does not outlive the session that ran the query.
   */
  gridViews: Record<string, GridView>;
  /**
   * The open "name this query" dialog, or `null`.
   *
   * Deliberately the same shape as `saveRequestPrompt`, because ⌘S must mean the same thing in
   * both surfaces: with a `savedQuery` the keystroke updates in place, and
   * without one it has to ask for a name before there is anything to create. Rendered by
   * `<DbConsoleTab/>` rather than by a host in `App.tsx` — the tab owns the keystroke, and a
   * dialog for a console that has been closed cannot then be left on screen.
   *
   * It carries the **SQL**, not just the connection id, and that is not redundancy: what the
   * user pressed ⌘S *on* is what should be saved, and the confirm then needs no second read of
   * a console record that may no longer exist. The first version re-read
   * `dbConsoles[id]?.text ?? ""` and the coverage ratchet flagged the fallback as unreachable —
   * which was the signal that the value should travel with the request instead of being looked
   * up again.
   */
  dbSaveQueryPrompt: { connectionId: string; sql: string } | null;
}

export interface DbActions {
  /**
   * Read the engine registry + the saved connections, ONCE. A second call while
   * `dbLoaded` is a no-op; a call after a failure retries.
   *
   * Both reads are issued together (`Promise.all`) because the dialog is useless without
   * either one, so serialising them would only make the panel's first paint slower. Never
   * rejects: a failure lands in `dbError` as one mapped sentence, because a panel that
   * throws on mount takes the rail down with it.
   */
  loadDbStore(): Promise<void>;
  /**
   * Apply a load's result. The READ side — no persistence effect, because this IS what
   * Rust just handed us and writing it straight back would be a wasted write.
   */
  hydrateDbStore(engines: EngineSpec[], store: DbConnectionStore): void;
  /**
   * Persist a draft through `db_connection_upsert` and apply the record Rust returns.
   *
   * `password` is the plaintext the user typed and travels as a SEPARATE argument —
   * it is never merged into `draft`, never stored here, and never logged. `id` is `null` to
   * create, a ULID to update in place.
   *
   * **Rejects** (with an `Error` carrying one mapped sentence) rather than swallowing: the
   * dialog owns the failure display, and a Save that silently did nothing is the worst
   * possible outcome of a form.
   */
  upsertDbConnection(
    draft: DbConnectionDraft,
    password: string,
    id: string | null,
  ): Promise<DbConnection>;
  /**
   * An agent added (or re-opened) a connection through `agent-studio db connect`. Rust has
   * already written `db-connections.json` and, for a password, the Vault in `api-store.json`,
   * underneath two slices whose load-once gates say they are current — so both gates are
   * re-armed (LESSONS §34), the list is reloaded, and the DB tab is brought into view with a
   * notice naming the agent. The notice is set at once; the promise settles when the list has
   * been read again (it never rejects), which is when a connection `db connect` just added
   * can be connected (`openDbSession` fails as "no longer exists" on an id it does not hold).
   */
  showAgentDbConnection(event: {
    connectionId: string;
    terminalId: string;
    created: boolean;
  }): Promise<void>;
  /**
   * An agent ran a query through `agent-studio db query`: show the user what ran and what came
   * back, WITHOUT taking focus from the terminal they are watching.
   *
   * Every run is told in the DB panel's notice — connection, query, Agent Studio's refusal
   * (`error`) or what came back (`outcome`) — whatever state the console is in, so a run on a
   * console that is busy or not connected is not lost. The console tab is opened in the background
   * when it is not open yet (activated only in a pane with no active tab), and its results become
   * `results` (the agent's note first, built by the caller) unless the user's own run holds it.
   *
   * **A console buffer holding the user's text is never modified.** An empty one gets the query
   * (unlinked from any saved query, so ⌘S cannot write it over one); otherwise the notice offers
   * the query with "Put in console". A write refreshes the object tree, as a console write does.
   */
  showAgentDbQuery(event: {
    connectionId: string;
    terminalId: string;
    query: string;
    error: string | null;
    outcome: string | null;
    results: DbResultSet[];
  }): Promise<void>;
  /**
   * An agent wrote a query for a console (`agent-studio db console`) that holds the user's own
   * text: the text is left as it is, and the DB panel's notice offers the query instead.
   */
  offerAgentDbQuery(event: { connectionId: string; terminalId: string; query: string }): void;
  /**
   * The notice's "Put in console": the offered query replaces the console's text and unlinks its
   * saved query (so ⌘S cannot write the agent's text over it), and the console comes to the front.
   * The user's click is the only way an agent's query lands in a buffer that held their text.
   */
  putAgentDbQueryInConsole(): void;
  /** Dismiss the agent notice. */
  dismissDbAgentNotice(): void;
  /** Delete a connection (Rust cascades its live sessions) and drop our mirror of it. */
  deleteDbConnection(id: string): Promise<void>;
  /**
   * Connect: probe for the server version, then open the durable session.
   *
   * Two dials, because the command surface leaves no alternative — `db_open` returns a
   * session id and nothing else, and no command probes an OPEN session, so the version
   * (the only evidence of a real round trip) has to come from `db_test_connection`. This
   * wants either a `ServerInfo` on `db_open`'s reply or a `db_probe`.
   *
   * Never rejects. A failure is a status, because an unreachable database is a normal
   * thing to find out and must not take the rail down (a failed expand is a calm
   * inline note).
   */
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
  /**
   * Run `text` (default: the console's whole buffer) through `db_query` and apply the results.
   *
   * 🔴 `text` exists because of a bug: ⌘⏎ passed only the *mode*
   * `"statement"` and this action sent the entire buffer, so Rust counted the statements it was
   * given and refused it as multi-statement. The mode is a permission, not a payload — the
   * caller has to say **what** to run, and only the editor knows (the caret and the selection
   * live in its CM6 state). Absent, it still means "the whole buffer", which is what Script
   * means and what every caller without an editor to ask must fall back to.
   *
   * Never rejects: a failed call is `error`, because a throw here would come out of a
   * keystroke handler with nowhere to be caught. Requires an OPEN session — with none,
   * it reports `no-session` rather than silently doing nothing.
   */
  runDbQuery(connectionId: string, mode: DbRunMode, text?: string): Promise<void>;
  /**
   * Stop the running query: ask the server to cancel it, and stop waiting either way.
   *
   * 🔴 **The two halves are deliberately independent, and the order matters.** Bumping
   * `runToken` orphans the in-flight reply and stops the spinner immediately — that is local
   * and cannot fail. The cancel is a round trip that may fail, may be refused (MongoDB, Redis
   * and DynamoDB have no server-side cancel), and is **advisory even when it succeeds**:
   * PostgreSQL's `pg_cancel_backend` sends SIGINT and the backend stops at its next
   * interruptible point.
   *
   * So the UI stops waiting regardless, and a failed cancel is recorded as a console notice
   * rather than thrown — the user pressed Stop, and the button must not appear stuck because
   * the server declined. Older builds had no `db_cancel` at all, and this action was only
   * ever the first half.
   */
  stopWaitingForDbQuery(connectionId: string): void;

  /* ─────────────── the object tree and saved queries ─────────────────────────── */

  /**
   * Read ONE level of the tree through `db_children` and cache it under the node's key.
   *
   * A **no-op when that level is already cached or already in flight** — which is the whole of
   * "one `db_children` call per first expand": re-expanding a collapsed database costs nothing.
   * `force` is the Retry path: it drops the cached failure and asks again.
   *
   * Never rejects. A failure lands in `dbTrees[id].failed[key]` as one mapped sentence, which
   * `<DbTree/>` renders **on that node**: a failed expand is a calm inline note, never
   * a panel-level error. A dropped VPN must not take the rail down.
   */
  loadDbChildren(
    connectionId: string,
    sessionId: DbSessionId,
    node: DbNodeRefWire,
    force?: boolean,
  ): Promise<void>;
  /**
   * Expand or collapse a node, loading its level on the first expand only.
   *
   * The IPC call is fired from this WRAPPER after the `set` that flips the flag, never from
   * inside the producer. Collapsing keeps the cache — that is what makes
   * re-expanding free — and keeps any inline failure, so a user who collapses a broken node
   * still sees why when they open it again.
   */
  toggleDbNode(
    connectionId: string,
    sessionId: DbSessionId | null,
    node: DbNodeRefWire,
  ): void;
  /** Drop a connection's whole subtree. Called on disconnect: a cached list from a dead
   *  session is a tree that answers `not-found` when clicked. */
  clearDbTree(connectionId: string): void;
  /**
   * Invalidate a connection's cached tree **without collapsing it** — what a write, and the
   * Refresh button, actually ask for.
   *
   * 🔴 The bug this exists for: an edit to the database was not
   * reflected until the view was changed. `dbTrees` cached every level it had ever read and
   * **nothing invalidated it after a write**, so a `CREATE TABLE` / `DROP` left the rail
   * showing the shape it first loaded — including each node's `count_label` ("12 tables"),
   * which Rust bakes in at fetch time and which therefore rides the same cache.
   *
   * **Why not {@link clearDbTree}.** That deletes the whole record, `expanded` included, so
   * every level the user had opened would snap shut — one annoyance traded for a worse one.
   * `children` **presence is the loaded marker** (see `DbTreeState.children`), so dropping
   * *just* `children` (and `failed`) says "read this again" while the user's shape survives.
   *
   * **The cost, stated honestly: one `db_children` per level that is CURRENTLY ON SCREEN** —
   * never per level ever loaded. This action issues no IPC at all; it only invalidates.
   * `<DbTree/>` then re-renders each visible level as `idle` and fetches it there
   * (`renderLevel`'s idle arm), so a cached-but-collapsed level is dropped for free and costs
   * nothing until it is opened again.
   *
   * **Overlapping refreshes cannot double-fire**, because a second invalidation of an already
   * invalidated tree is the same write. The fetches that follow are deduped by
   * `loadDbChildren`'s own in-flight guard. ⚠️ The one gap, recorded rather than papered over:
   * a `db_children` that was **already in flight** when this ran still writes its (pre-write)
   * answer into the cache when it lands — closing that would need a generation token on
   * `DbTreeState`, and the escape hatch for it is the same Refresh button.
   *
   * A no-op for a connection with no cached tree: refreshing something nobody has expanded
   * must not create an entry, because an entry with an empty `children` is exactly what the
   * tree treats as "go and fetch it".
   */
  refreshDbTree(connectionId: string): void;
  /**
   * Read a connection's saved queries (`db_saved_queries`).
   *
   * Never rejects; a failure is `dbSavedQueries[id].error`. Takes no session — see the state
   * field's comment: requirement 9 must survive the database being unreachable.
   */
  loadDbSavedQueries(connectionId: string): Promise<void>;
  /**
   * Read this connection's hand-arranged tree order from disk. Never rejects: a failure leaves
   * the orders empty, which renders alphabetically — the state the user had before the feature.
   */
  loadDbTreeOrder(connectionId: string): Promise<void>;
  /**
   * Drop `moved` immediately before `before` in `parentKey`'s level (or at the end when
   * `before` is null), and persist.
   *
   * Both are child LABELS. The new order is computed from what is DISPLAYED right now — the
   * saved order applied to the children currently cached — so the result is always a total
   * order over what the user can actually see, and there is no separate "materialise the
   * implicit alphabetical order on the first drag" step to get wrong.
   */
  moveDbTreeNode(connectionId: string, parentKey: string, moved: string, before: string | null): void;
  /** Forget one level's arrangement, back to the engine's alphabetical order. */
  resetDbTreeOrder(connectionId: string, parentKey: string): void;
  /**
   * Open a saved query in the connection's console (creating or re-focusing the tab), with the
   * console adopting its id and name so the next ⌘S **updates** it rather than asking for a
   * name again.
   */
  openDbSavedQuery(connectionId: string, query: SavedQueryRecord): void;
  /**
   * Put `sql` in the connection's console and focus it — the double-click-a-table path.
   *
   * Clears any `savedQuery`: the browse statement is a *new* buffer, and inheriting the
   * previously-open saved query's id would make the next ⌘S silently overwrite someone's saved
   * query with a `SELECT *`.
   */
  openDbQueryInConsole(connectionId: string, sql: string): void;
  /**
   * ⌘/Ctrl+S in a console.
   *
   * Returns what it did, as a word rather than a boolean, because there are three outcomes and
   * two of them are successes: `"saved"` (the console had a `savedQuery`, so it was updated in
   * place), `"prompted"` (no id yet — the name dialog is now open), `"empty"` (nothing to save;
   * the keystroke must not create an empty query, and `db_saved_query_upsert` would refuse it
   * anyway). Never rejects: it is called from a keydown handler with nowhere to catch.
   */
  saveDbConsoleQuery(connectionId: string): Promise<"saved" | "prompted" | "empty">;
  /** Confirm the name dialog: create the query, adopt it into the console, close the dialog. */
  confirmDbSaveQueryName(name: string): Promise<void>;
  /** Dismiss the name dialog without saving. */
  cancelDbSaveQueryName(): void;
  /**
   * Create (`id: null`) or update a saved query and refresh the connection's list.
   *
   * Never rejects — the refusals in `queries.rs` (blank name, empty SQL, stale id) are normal
   * outcomes of a keystroke, so they land in the console's `saveError` as one mapped sentence.
   * Resolves the stored record on success, `null` on failure, so a caller can tell.
   */
  upsertDbSavedQuery(
    connectionId: string,
    id: string | null,
    name: string,
    sql: string,
  ): Promise<SavedQueryRecord | null>;
  /**
   * Delete a saved query and drop it from the list.
   *
   * `removed: false` means our list was stale; the same filter is the repair, and it is applied
   * either way — but a stale delete is reported rather than passed over, matching
   * `deleteDbConnection`'s choice for the identical situation.
   */
  deleteDbSavedQuery(connectionId: string, id: string): Promise<void>;
}

/* ─────────────────── shareable config bundles ───────────────────────────────── */

/**
 * The export flow's state — and note what is NOT here: **the draft.**
 *
 * The mode, the label, the id selections and (in `sealed` mode) the passphrase all stay in
 * `<ExportDialog/>`'s own component state and travel to `exportBundle` as one argument. That
 * is the same division `<ConnectionDialog/>` uses for a typed database password, and the
 * reason is the passphrase: the only way to *guarantee* it is never in the store is for the
 * whole draft never to be. The cost is real and worth stating — the export dialog loses its
 * label and selection if it unmounts — and it is accepted because that dialog is a modal
 * gesture, not one of the tab surfaces `Pane` unmounts (which is exactly why `dbConsoles`
 * had to go the other way).
 */
export interface PortabilityExportState {
  /** An export is in flight (the picker is NOT part of this — see `exportBundle`). */
  busy: boolean;
  /** The last export's failure as ONE mapped sentence, or null. Never a raw wire string. */
  error: string | null;
  /**
   * The last successful export: what Rust wrote, and where.
   *
   * The header comes from Rust rather than from the request, so the counts the summary
   * renders are a MEASUREMENT of the file on disk — including `secretValues: 0`, which is the
   * one number a person actually wants confirmed before they paste a bundle into Slack.
   */
  done: { header: BundleHeader; path: string } | null;
}

/**
 * The import flow's state. Import is **inspect-then-apply**, so this holds a
 * dry run and the user's edits to it — never a passphrase.
 *
 * The whole record is deliberately shaped so a wrong passphrase is retryable **without
 * reopening the file** (a failure must never go sticky): a failed inspect clears nothing —
 * not `srcPath`, not `plan`, not `overrides` — it only writes `error`, and the next attempt
 * clears that before it starts.
 */
export interface PortabilityImportState {
  /** The chosen file, or null when nothing has been picked. Rust reads it; we never do. */
  srcPath: string | null;
  /**
   * The latest dry run. For a sealed bundle inspected without a passphrase this is a real
   * plan with `unsealed: false` — a header, counts and a label, which is what lets the dialog
   * describe the file honestly *before* asking for anything.
   */
  plan: ImportPlan | null;
  /** An inspect or an import is in flight. */
  busy: boolean;
  /** The last inspect/import failure as ONE mapped sentence, or null. */
  error: string | null;
  /**
   * Per-item action overrides, keyed by `ImportItem.id`. Absent = use the plan's default.
   *
   * 🔴 **In the store because the dialog can be unmounted and remounted.** This app unmounts
   * inactive tabs, and losing a person's item-by-item review of an untrusted config — the
   * security surface of this whole feature — because they clicked a terminal is
   * not acceptable. Same reasoning that moved `dbConsoles` out of the console component.
   *
   * Survives a re-inspect on purpose: choices made while reading a sealed bundle's structure
   * are still the choices the user made once it unseals.
   */
  overrides: Record<string, ImportAction>;
  /**
   * Whether an incoming secret value may replace one this machine already has.
   *
   * **Defaults to `false`, and that is a security default, not a preference** (see
   * `ImportChoices`): taking someone else's value for a variable you already use is how a
   * working setup breaks in a way nobody traces back to an import.
   */
  overwriteExistingSecrets: boolean;
  /**
   * Whether imported DB connections are made read-only.
   *
   * **Defaults to `true`**, and like the flag above that is a security default rather than a
   * preference — but unlike it, this one used to be a *forced value* in Rust. A later
   * change made it the importer's decision: the reasoning still
   * justifies leaning read-only (a connection that has just arrived is new on this machine), and it
   * never justified removing the choice from the person reading the review screen.
   */
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

  /**
   * Pick a destination, then write the bundle. Resolves the header on success, `null` when
   * the user cancelled the picker **or** when it failed — `portabilityExport.error` is what
   * distinguishes the two, and it is `null` after a cancel.
   *
   * **Never rejects**, unlike `upsertDbConnection`. The difference is who owns the failure
   * display: a Save that silently did nothing must throw at a form which then stays open,
   * whereas this dialog stays open regardless and shows either the written path or the
   * failure beside the Export button — the retry (a different mode, a shorter selection) is
   * made *here*, so the message has to live here too.
   *
   * `options` is transient: it carries the sealing passphrase and is never stored (see
   * {@link PortabilityExportState}).
   */
  exportBundle(options: ExportOptions): Promise<BundleHeader | null>;

  /**
   * Pick a bundle and inspect it with no passphrase — step 1 of the flow.
   *
   * A NEW file resets everything about the previous one (plan, overrides, result): those
   * choices were about a different file, and silently applying them to this one would be the
   * worst kind of carry-over.
   */
  chooseImportFile(): Promise<void>;
  /**
   * Re-run the dry run on `srcPath`. The engine behind both steps, exposed because the
   * passphrase retry is a re-inspect and nothing else.
   *
   * Never rejects: a failure is `error`, because this is called from a click handler with
   * nowhere to catch. Keeps the previous plan on failure, so a wrong passphrase leaves the
   * dialog exactly as it was — file still chosen, description still on screen, field ready.
   */
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

  /**
   * Apply the plan. Resolves the result, or `null` when it failed / no file is chosen.
   *
   * The passphrase is an ARGUMENT (null for a `structure` bundle) because it was never
   * stored: Rust re-reads and re-opens the file, so inspect and import are independent calls
   * and no secret has to live between them.
   *
   * On success this clears `dbLoaded` / `apiStoreLoaded` and re-issues the DB load, because
   * Rust has just rewritten `db-connections.json` and `api-store.json` underneath a store
   * that thinks it is up to date. Without it a successful import shows the user nothing at
   * all until they restart: the suites are green and the screen is empty.
   */
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
 * Pure functions over a LayoutState draft (Immer). Kept free of the store root
 * so M2 can apply them to `draft.sessions[sessionId]` unchanged.
 */

/**
 * `paneId` if it still names a leaf of `layout`, else that tree's first leaf.
 *
 * The one "repair a focus pointer" rule, shared by the live state (`ensureFocus`)
 * and by a view snapshot's `focusedPaneId` — a snapshot's focus can be pruned by
 * a cross-view tab move exactly as the live one can, and two rules could disagree.
 */
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

/**
 * `leaf` without `tabId`, with activation moved to a sensible neighbour. Pure.
 *
 * The single implementation of "a leaf loses a tab", shared by `closeTab` and
 * both drop planners — which is what lets the drop *preview* run the real
 * mutation against a copy of the tree instead of re-deriving it.
 *
 * Total by construction rather than by a guard: a tab that is not here filters
 * out to the same list, and cannot be `activeTabId`, so the index is never
 * consulted. That keeps this free of a defensive branch no caller can reach.
 */
function leafWithoutTab(leaf: LeafNode, tabId: TabId): LeafNode {
  const i = leaf.tabIds.indexOf(tabId);
  const tabIds = leaf.tabIds.filter((id) => id !== tabId);
  const activeTabId =
    leaf.activeTabId === tabId
      ? (tabIds[Math.min(i, tabIds.length - 1)] ?? null)
      : leaf.activeTabId;
  return { ...leaf, tabIds, activeTabId };
}

/**
 * A drop index the caller measured from the DOM, made safe to splice with:
 * clamped into range, integral, and defaulting to "append" for junk (a NaN
 * from an unlaid-out tab strip must not silently become index 0).
 */
function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) return max;
  return Math.min(Math.max(Math.trunc(index), 0), max);
}

/** Leaves that emptied out get pruned; a leaf that still has tabs does not. */
const pruneIfEmpty = (leaf: LeafNode): ReadonlySet<PaneId> =>
  leaf.tabIds.length === 0 ? new Set([leaf.id]) : new Set<PaneId>();

/**
 * Recanonicalize after a structural edit. `current()` snapshots the Immer draft
 * to a plain tree first — canonicalize is pure and rebuilds nodes, and feeding
 * draft proxies back into the draft is a footgun.
 */
function recanonicalize(s: LayoutState, prune?: ReadonlySet<PaneId>): void {
  s.layout = canonicalize(current(s.layout), prune);
  ensureFocus(s);
}

/* ─────────────────────────── drop planning ───────────────────────────
 * The tree a drop WOULD produce, without performing it.
 *
 * These exist because the drop *preview* has to show the truth. A preview drawn
 * as "half of the pane under the cursor" is a lie in the general case: the drop
 * also prunes the source leaf if it empties, which can collapse a single-child
 * split, which lets the survivor expand *beyond the hovered pane* — up to the
 * whole container. That is the half-screen preview bug, and it is why the
 * naive preview looks fine at 3+ panes (no collapse)
 * and wrong at 2 (collapse).
 *
 * So the planners are the ONE implementation of "what does this drop do", and
 * both the action and the preview run them. Deriving the preview any other way
 * is how the two drift apart again — which is exactly the bug.
 */

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

/**
 * What `moveTab(tabId, toPaneId, index)` would produce, or null for a no-op.
 * Mirrors that action exactly — see `LayoutActions.moveTab` for the semantics.
 */
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

/**
 * What `moveTabToEdge(tabId, targetPaneId, edge)` would produce, or null for a
 * no-op. Mirrors that action exactly — see `LayoutActions.moveTabToEdge`.
 */
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

  // Wrap the target in a fresh split. If its parent already runs the same
  // orientation, canonicalize's flatten rule turns this into a sibling insert
  // at the right index — which is how a drop on an edge grows a row from 2
  // panes to 3, 4, n (no arbitrary cap).
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

/**
 * Where a leaf sits inside the tree's container, as fractions of it
 * (`{left, top, width, height}`, each 0..1). Null if the leaf is not there.
 *
 * Fractions rather than pixels because that is exactly what the tree knows: a
 * split's `sizes` ARE its children's shares of its box, recursively. The caller
 * turns them into CSS percentages against the container, so this needs no
 * measurement and cannot disagree with what allotment lays out — both are
 * driven by the same `sizes`.
 */
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

/**
 * The box a drop at `zone` would land the tab in, as fractions of the work area.
 *
 * THE function the drop preview renders, and the reason it cannot lie: it runs
 * the same planners the actions run. `zone` is `dropZone.ts`'s answer to "which
 * edge is the cursor in?"; this answers the different question "what rect will
 * result?", which only the tree can know.
 *
 * **A drop that changes nothing still has an answer**, and it is not "no
 * preview". The question the preview answers is "where does this terminal end
 * up if I let go here?" — and for a no-op the honest answer is "exactly where it
 * already is". Returning null for those made the preview vanish for the whole
 * time the cursor was over the dragged tab's own pane, i.e. the first half of
 * every drag: the blue drop highlight then went missing mid-drag.
 *
 * Null is reserved for "this is not a question about a real tab and a real
 * leaf" — a tab or pane that is not in the tree, or a target that is a split.
 * Those are internal errors, not gestures, and must stay distinguishable from a
 * no-op rather than being silently swallowed by the same branch.
 */
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

/**
 * Ask whether any of `terminalIds` is busy, then either hold the gesture for a
 * confirm or let it through.
 *
 * Deliberately takes CALLBACKS rather than the store's `get`/`set`: the whole of
 * the decision is then testable without a store, and — more importantly — the
 * two outcomes are named at every call site, so nobody can add a fourth close
 * path that asks the question and forgets to act on the answer.
 *
 * 🔴 The empty case must call `proceed()`, not fall through. An early return
 * here would make every close of an idle terminal silently do nothing, which is
 * a far worse bug than the one this gate exists to fix and would look exactly
 * like a frozen UI.
 */
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

/**
 * A busy COMMAND is named the way its tab is. The backend only knows the shell's program
 * ("powershell", "zsh") — never the IDE's own tab title (the folder name, "Terminal 3") or
 * a rename — so the dialog said "powershell has a command still running" over a tab called
 * something else (on Windows; the same on macOS with "zsh"). An AGENT keeps
 * the backend's label: that is the session's name, which the rail shows too.
 */
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

/**
 * Promote the plain terminal tab an ad-hoc agent bound to into an agent-terminal.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Ad-hoc detection: the user types `claude` in an ordinary shell, Rust's
 * SessionStart listener emits `agent_started`, and the agent's id EQUALS that
 * terminal's id — Rust keys the ad-hoc agent by its terminal (the same
 * `AgentId === TerminalId` invariant spawned agents use). The rail then shows
 * the agent, but the *tab* was born plain (`{kind:'terminal'}`, no agentId), so
 * without promotion it never carries the agentId — and `closeTab` can't dismiss
 * the agent (the bug: the tab closes but the agent lingers). Promotion makes
 * `agentIdOf` return the id, after which the existing close/dismiss paths just
 * work — no parallel wiring.
 *
 * ── Metadata only ────────────────────────────────────────────────────────────
 * Same `terminalId`, same registry entry, same scrollback. `<TerminalView>` is
 * keyed on `terminalId`, which does not change, so the emulator never remounts.
 *
 * ── Idempotent ───────────────────────────────────────────────────────────────
 * Only a plain `terminal` tab matches. A spawned agent's tab is already
 * `agent-terminal`; a re-fired `agent_started` finds a tab that is already
 * promoted. Both fail the `kind === 'terminal'` filter, so a second call is a
 * no-op — no second promotion.
 */
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

/**
 * The name a REBUILT terminal's tab wears until the user renames it.
 *
 * An agent's tab wears its FOLDER's name — exactly what it wore when it was spawned
 * (`createAgent` → `openTerminalTab` → `terminalTitle(cwd)`). Rust's `meta.title` is the
 * adapter's display name ("claude"), which is what the rail ROW shows; handing it to the tab
 * renamed every agent's tab across a restart and a webview reload — the restart E2E
 * read "workspace" before and "claude" after, for the same agent, while its row
 * said "claude" throughout. A restored agent must look exactly as it did.
 *
 * `meta.cwd` is the cwd the agent was spawned in (the supervisor's cwd poller never rewrites
 * it), so it yields the same folder. When it is empty — a tab arriving from another window
 * (tab tear-off), which carries the title it wore over there as `meta.title` — that title
 * wins. A plain shell keeps `meta.title` as it always has: its "Terminal 3" lived only in the
 * JS heap and cannot be re-derived.
 */
function rebuiltTabTitle(meta: TerminalMeta): string {
  return (meta.agentId ? folderName(meta.cwd) : null) ?? meta.title;
}

/* ───────────────────────── fleet reducers ─────────────────────────
 * Pure functions over a FleetState draft, mirroring the layout slice's shape.
 */

/**
 * Hydrate a wire `AgentNode` into a store one.
 *
 * `AgentNode` carries four UI-only fields the wire never sends (ARCHITECTURE
 * §2.2: "store-maintained, NOT from the wire"). Rust cannot know them, and a snapshot
 * that omitted them would leave `childIds` undefined — which every consumer
 * would then have to guard. Defaults are applied once, here, so the rest of the
 * frontend can treat an `AgentNode` as total.
 */
function hydrateAgent(wire: AgentNodeWire, prev?: AgentNode): AgentNode {
  return {
    ...wire,
    // An agent claiming to be its own parent is malformed telemetry, and the
    // naive handling is worse than it looks: it would sit only in its OWN
    // childIds, reachable from no root, so the rail could never draw it and the
    // user could never dismiss it. Normalized to a root here — at the one
    // boundary where wire data becomes store data — so nothing downstream
    // (linkAgent, rootOf, flattenFleet) has to know the case exists.
    parentId: wire.parentId === wire.id ? null : wire.parentId,
    // Derived from parentId edges by `linkAgent`, never trusted from the wire.
    childIds: prev?.childIds ?? [],
    sessionId: prev?.sessionId ?? null,
    // Disclosure and unread are *view* state: a re-snapshot must not collapse
    // a tree the user opened, or re-ring a notification they already read.
    //
    // Note there is no `?? wire.x` fallback on any of these four. There cannot
    // be: `AgentNodeWire` does not declare them, so the compiler now rejects
    // reading them — which is the point of splitting the two types. Previously
    // the fallback read `undefined` from a field Rust never sends and silently
    // did the right thing for the wrong reason.
    //
    // Default COLLAPSED (`?? false`): a fan-out tree opens with subagents hidden
    // behind the ▶ caret, and the roll-up ("3 running") shows on the collapsed
    // parent (flattenFleet computes it regardless of `expanded`). `prev?.expanded`
    // first is load-bearing: a parent the user manually expanded stays expanded
    // when new children arrive or a snapshot re-fires. This line is THE default —
    // it overrides the `expanded` on every node handed to `upsertAgent`.
    expanded: prev?.expanded ?? false,
    unread: prev?.unread ?? 0,
    // The user's custom name is view state too — a re-snapshot or a Rust title
    // update must never wipe it. Same preserve-prev rule as `expanded`.
    customTitle: prev?.customTitle ?? null,
    // The pin flag is client-only and preserved the same way: a
    // re-snapshot or Rust status/title update must never wipe a pin the user set
    // (or one seeded at boot). No wire fallback — `AgentNodeWire` does not
    // declare it, so the registry seeds it once (`applyPinnedAgents`), never the
    // wire. This is the guarantee that a pin toggled mid-boot survives the race.
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

/**
 * Raise the unread badge on an agent and every ancestor.
 *
 * A deep descendant blocked on input must be visible from a
 * *collapsed* trunk, or the fan-out tree hides the one thing you must act on.
 */
function bubbleUnread(s: FleetState, agentId: AgentId): void {
  walkAncestry(s, agentId, (agent) => {
    agent.unread += 1;
  });
}

/**
 * Reading an agent clears its badge — and takes its contribution back out of
 * every ancestor's roll-up.
 *
 * The roll-up has to unwind the same way it wound up. Zeroing only the agent
 * leaves its parents advertising a "needs input" that has been answered, and
 * since that count is exactly what draws the eye to a collapsed trunk, a badge
 * that never clears trains the user to ignore the one signal that matters.
 */
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

  // Surfaced as a root rather than dropped when it is a genuine root, or an
  // orphan whose parent has not arrived yet. (A self-parent never reaches here:
  // `hydrateAgent` already normalized it to a root.) A visible agent in the
  // wrong place beats an invisible one the user cannot dismiss.
  if (!parent) {
    if (!s.rootAgentIds.includes(id)) s.rootAgentIds.push(id);
    return;
  }
  if (!parent.childIds.includes(id)) parent.childIds.push(id);
}

/**
 * Upsert an agent, preserving UI-only state across re-snapshots.
 * Shared by `agent_started`, `applyFleetSnapshot` and `spawnChild`.
 *
 * Re-links when the parent changed. Linking only on first insert leaves the old
 * parent still naming the agent in `childIds` while the agent names a new one —
 * a forest that disagrees with itself, which the rail renders as a duplicate.
 * Re-parenting is not hypothetical: a replayed `subagent_spawned`, or an
 * `agent_started` for an id we first met as somebody's child, both land here.
 */
function upsertAgent(s: FleetState, wire: AgentNode): void {
  // A dismissed agent stays dismissed. This one guard covers every creation
  // path — `agent_started`, `subagent_spawned`, and a stale `fleet_snapshot`
  // that still lists it — because they all land here. Skipping also skips
  // `adoptOrphans` below, which is correct: nothing should re-home under a dead
  // parent.
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

/**
 * Re-home any root that was waiting for THIS agent to exist.
 *
 * Events are not ordered across agents: `subagent_spawned` can beat its
 * parent's `agent_started`, and `fleet_snapshot` is a flat array in whatever
 * order Rust walked it. `linkAgent` surfaces such a child as a root so it stays
 * visible — but without this, it stays there *forever*, and at M3 that means a
 * sub-agent silently rendering as a top-level orchestrator instead of nesting
 * under its parent. Adoption is what makes arrival order stop mattering.
 */
function adoptOrphans(s: FleetState, parentId: AgentId): void {
  const orphans = s.rootAgentIds.filter(
    (rootId) => rootId !== parentId && s.agents[rootId]?.parentId === parentId,
  );
  for (const orphanId of orphans) {
    unlinkAgent(s, orphanId);
    linkAgent(s, s.agents[orphanId]);
  }
}

/**
 * M3, and callable ONLY from `applyAgentEvent` — never exported as an action.
 *
 * This is the headline: a sub-agent appearing here makes a new row animate in
 * under its parent, purely from telemetry (ARCHITECTURE §5.4).
 */
function spawnChild(
  s: FleetState,
  ev: Extract<AgentEvent, { t: "subagent_spawned" }>,
): void {
  // A dismissed subtree stays dismissed. The CHILD's own id is fresh (so
  // `upsertAgent`'s tombstone guard would not catch it), but its PARENT was
  // tombstoned when the user closed the tree — and Rust's tailer can emit one
  // more child a beat later. Without this, that child would be created with a
  // dead parent and surface as a ghost ROOT (`linkAgent`'s orphan path). The
  // guard is parent-scoped precisely because the child id is new.
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

/**
 * Remove `tabId` from a draft leaf, moving activation to a surviving neighbour
 * (or null when it empties). Same activeTab rule as `leafWithoutTab`, but it
 * mutates the Immer draft in place so a batch can detach many tabs before a
 * single recanonicalize — feeding a reassigned (plain) layout back into
 * `current()` per tab is what Immer rejects. Returns whether the leaf held it.
 */
function detachTabFromDraftLeaf(leaf: LeafNode, tabId: TabId): boolean {
  const i = leaf.tabIds.indexOf(tabId);
  if (i === -1) return false;
  leaf.tabIds.splice(i, 1);
  if (leaf.activeTabId === tabId) {
    leaf.activeTabId = leaf.tabIds[Math.min(i, leaf.tabIds.length - 1)] ?? null;
  }
  return true;
}

/**
 * Close every tab in `tabIds` (deleting its record and detaching it from its
 * leaf), then canonicalize once so an emptied leaf is pruned and any single
 * child split collapses — exactly what `closeTab` does, but batched.
 *
 * `s.layout` may already be a plain (reassigned) tree here, not a live draft:
 * `closeTab` canonicalizes its terminal tab first, THEN dismisses the agent,
 * whose sub-agents' activity tabs land in this sweep. `current()` only accepts a
 * draft, so snapshot it only when it still is one — the plain tree is fed
 * straight through (its in-place edits above are already baked in).
 */
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

/**
 * Remove `agentId` and its whole subtree, and tombstone every removed id.
 *
 * The pure core shared by `removeAgent`, `dismissAgent`, and closing an agent's
 * tab. Cascades depth-first (M3: closing a root drops its sub-agents) — for M2
 * there are no children, but the cascade is built now so nothing walls it in.
 *
 * Tombstones even when the agent is already absent: a dismiss can race ahead of
 * the create it is cancelling, and "dismissed" must win regardless of order.
 *
 * Also closes each removed agent's read-only activity tab (M3): a sub-agent owns
 * no PTY, so `closeTab`'s terminal path never reaches it, and a left-behind
 * `<ActivityView>` would poll a dropped agent every 1.5 s forever.
 * Widened to the full store draft so this one core cleans up tabs for every
 * removal path — direct dismiss AND the root cascade — in one place.
 */
function removeAgentFromForest(
  s: LayoutState & FleetState,
  agentId: AgentId,
  // Out-param: doomed ids that were PINNED are pushed here so the caller can
  // fire the `unpinAgent` persist EFFECT after the `set` returns (the invoke is
  // never a producer step). Dismissing a pinned agent MUST also unpin it, or
  // `pinned_agents()` would re-materialize a tombstoned agent next boot — a
  // "zombie pin". Collected in the producer, fired in the wrapper,
  // exactly as `dismissAgent` already issues `dispose(...)` outside the producer.
  // Required (every removal path threads it) — passed `[]` when there is nothing
  // to fire, never omitted.
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
    // A pinned root being removed must be unpinned too (else it zombie-resurrects
    // next boot). Only roots are ever pinned, so in practice this is `agentId`
    // itself, but the whole subtree is checked so no pin can slip through. Every
    // doomed id has a record (collect only walks existing agents), so a direct
    // read is safe here.
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

/**
 * Record that `tabId` is being made active, when it is a FILE tab — the memory
 * behind `activeFilePath`'s sticky fallback. A no-op for every other tab kind,
 * so switching to a terminal keeps the Files rail pointed where it was.
 */
function noteFileTab(s: LayoutState, tabId: TabId): void {
  const path = tabFilePath(s.tabs[tabId]);
  if (path !== null) s.lastFilePath = path;
}

/**
 * Make `tabId` the active tab in whichever pane holds it, and focus that pane.
 *
 * The primitive behind "clicking an agent focuses its terminal" (the pivot). Both
 * assignments are guarded so re-activating an already-active tab in an
 * already-focused pane is a genuine no-op — Immer then produces no new state
 * and nothing re-renders.
 *
 * Written as a scan rather than `leafOfTab(...) ?? return` on purpose: every
 * tab record lives in exactly one leaf (a store invariant), so a null-guard's
 * "not found" arm would be unreachable dead code. The loop simply falls through
 * instead — no branch to leave forever uncovered.
 */
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

  // Not in the visible view — so look through the others and SWITCH to the one holding it.
  //
  // Without this, clicking an agent in the left rail whose terminal you had moved to another
  // view does nothing at all: the scan above walks only the live tree, finds nothing, and
  // returns silently. A click that is a no-op is indistinguishable from a broken rail, and the
  // tab is not lost — it is one view away.
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

/**
 * The leaf a newly-opened tab lands in: the named pane when it is a leaf,
 * else the first leaf. `focusedPaneId` always names a live leaf (store
 * invariant), so the fallback is defensive rather than a path the public actions
 * can reach — but it keeps tab-opening total instead of throwing on a stale id.
 */
function targetLeaf(s: LayoutState, paneId: PaneId): LeafNode {
  const target = findNode(s.layout, paneId);
  return target && target.type === "leaf" ? target : leavesOf(s.layout)[0];
}

/**
 * The absolute path of the ONE file a tab shows, or null for a tab that shows
 * no single file (terminal, activity, API, metrics, db-console, …).
 *
 * `diff` is in deliberately. A *Compare with HEAD* tab is a real
 * file at a real path in the tree, and the previous editor-only rule meant the
 * Files rail went blank and its crosshair greyed out the moment you compared a
 * file — a button that does nothing and says nothing, which is the exact
 * problem this rule was rewritten to fix. Every other kind genuinely has no
 * path to reveal (a `session-picker`/`metrics` `cwd` is a FOLDER, not a file).
 */
function tabFilePath(tab: Tab | undefined): string | null {
  if (tab === undefined) return null;
  return tab.ref.kind === "editor" || tab.ref.kind === "diff" ? tab.ref.path : null;
}

/** Is some tab, in any view, still showing the file at `path`? */
function hasFileTabFor(tabs: Record<TabId, Tab>, path: string): boolean {
  return Object.values(tabs).some((tab) => tabFilePath(tab) === path);
}

/**
 * The file the Files rail is "on": the crosshair's target, the crosshair's
 * enabled rule, AND the tree row that shows as selected. **One value for all
 * three**, so the button and the highlight can never disagree about which file
 * the user is looking at.
 *
 * 🔴 The sticky second clause fixes a bug (pressing the button should select the
 * file, so it is clear which one is open). The rule used to be
 * "the focused pane's active tab, if it is an editor" — and `focusedPaneId` is
 * written by ANY mousedown in ANY pane (`Pane.tsx`'s `onMouseDownCapture`), so
 * clicking into a terminal — the normal state of this app — silently disabled
 * the button while an editor sat visible right next to it. It also boots
 * pointing at the first leaf (`focusedPaneId` is not persisted), so after a
 * restart the button was dead until an editor pane was clicked.
 *
 * So the focused pane wins when it HAS a file tab, and otherwise we fall back to
 * the last file tab that was activated anywhere. That fallback is validated
 * against the live tabs on every read rather than being cleaned up on close:
 *  - a path whose tab was closed (or renamed/moved/deleted, which closes and
 *    reopens the tab at the new path) stops being the answer immediately, with
 *    no close-path bookkeeping to forget; and
 *  - `lastFilePath` therefore cannot outlive its tab, which is what lets the
 *    test harness reset `tabs` without also having to know about this field.
 */
export function activeFilePath(s: LayoutState): string | null {
  const tabId = targetLeaf(s, s.focusedPaneId).activeTabId;
  const active = tabFilePath(tabId === null ? undefined : s.tabs[tabId]);
  if (active !== null) return active;
  const remembered = s.lastFilePath;
  return remembered !== null && hasFileTabFor(s.tabs, remembered) ? remembered : null;
}

/**
 * Open a sub-agent's read-only activity tab (M3), placed in the focused leaf.
 * No PTY, so — unlike `openTerminalTab` — this is a pure state mutation with no
 * effect to run in the action wrapper. Returns the new tab id (not yet active;
 * the caller activates it). `agent` is the already-resolved node (selectAgent
 * guards its existence), so its title is read directly, no fallback name.
 */
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
 * Pure helpers over `LayoutState.views`. The invariant they all preserve:
 *
 *   the tab records in `tabs` === the union of the tab ids in EVERY view's tree
 *   (the active view's read from the live `layout`, the rest from their snapshot)
 *
 * — orphans in either direction are the bug class this section exists to prevent.
 */

/** A draft-safe plain tree: `canonicalize`/`replaceNode` must never see a draft. */
const plainTree = (tree: PaneNode): PaneNode =>
  isDraft(tree) ? current(tree) : tree;

/**
 * The minimum a "read a view's tree" helper needs. Narrower than `LayoutState` on
 * purpose: `<ViewBar>` and `serializeCenterLayout` both read view trees without
 * holding the whole slice, and neither should have to fabricate the fields it has
 * no business knowing about (`pendingRestore` least of all).
 */
export type ViewTreeSource = Pick<
  LayoutState,
  "layout" | "views" | "activeViewId"
>;

/**
 * The AUTHORITATIVE tree of `view`: the live `layout` when it is the active view
 * (whose snapshot is stale by design), the snapshot's own tree otherwise. May be
 * a draft — pass it through `plainTree` before rebuilding it.
 */
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

/**
 * Refresh `views[activeViewId]` from the live `layout`/`focusedPaneId`.
 *
 * **Run this BEFORE the active view changes** — that is the entire mechanism by
 * which a view keeps its tree while another one is live.
 *
 * A scan rather than `find(...) ?? return`, for the reason `activateTab` gives:
 * `activeViewId` always names a member of `views` (store invariant), so a
 * "not found" arm would be unreachable dead code.
 */
function writeBackActiveView(s: LayoutState): void {
  for (const view of s.views) {
    if (view.id !== s.activeViewId) continue;
    view.layout = plainTree(s.layout);
    view.focusedPaneId = s.focusedPaneId;
    return;
  }
}

/**
 * Every tab id held by `viewId`, in visual order — live for the active view.
 *
 * Exported because a "close this view?" confirmation that does not name what is
 * at stake is not a confirmation: the ViewBar reads `.length` off this to say
 * how many terminals a close would move.
 */
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

/**
 * `tree` with `tabIds` appended to `paneId`'s leaf, which becomes active. Pure —
 * rebuilds through `replaceNode` rather than mutating, because the tree it is
 * handed may be shared with (structurally) some other slot of the state.
 * `paneId` is always a leaf here: every caller routes it through `focusedOrFirst`.
 */
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

/**
 * Drop `tabIds` from every INACTIVE view's snapshot, pruning a leaf that empties.
 *
 * The other half of orphan-freedom: `closeTab`/`closeTabs` delete the record and
 * repair the LIVE tree, which would leave a dangling id in a snapshot when the
 * closed tab lives in a view that is not on screen (dismissing an agent whose
 * terminal was moved to another view does exactly that). Activating that view
 * would then render a tab id with no record.
 *
 * The write-back is unconditional, deliberately. A `changed` flag used to guard
 * it, and it was unfalsifiable: for a view that holds none of `tabIds`, `tree` IS
 * `plainTree(view.layout)` — the same object Immer would compare against — so the
 * assignment is already a no-op and the snapshot keeps its identity either way
 * (pinned by "closing a tab leaves the inactive views … as the SAME snapshot").
 * A branch no test can distinguish is dead weight, not an optimisation.
 */
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
 * Two bugs, one gap: nothing wrote the center layout down.
 *
 *   1. A renamed tab or view lost its name across a quit and reopen.
 *      `Tab.customTitle`, `AgentNode.customTitle` and `ViewSnapshot.name` all
 *      lived only in the JS heap. (The pin registry has a `customTitle` column,
 *      but nothing ever wrote it: `pin_agent` reads Rust's own `node.title`,
 *      which is the adapter default forever.)
 *   2. With two views and one agent in each, both agents were in one view after a reopen.
 *      `rebuildTerminalTabs` put every restored terminal into the focused leaf
 *      of the active view, because there was nothing on disk to say otherwise.
 *
 * The fix is one blob in `layout-prefs.json` and two pure functions:
 * `serializeCenterLayout` (store → disk) and `hydrateCenterLayout` (disk →
 * store). They are inverses, and the round-trip is property-tested as such.
 *
 * ── What is keyed on what, and why ──────────────────────────────────────────
 * A `TabId` is minted fresh every boot, so the blob keys on `TerminalId`, which
 * is durable exactly where it needs to be: an agent terminal's TerminalId IS its
 * AgentId, and Rust re-spawns a pinned root under that same id. So a
 * restored agent can be matched back to the pane it was in. A plain shell's PTY
 * dies with the app and its id matches nothing next launch — its pane slot is
 * simply pruned. (Across a *webview reload* the PTY survives, so a plain
 * terminal's tab and its rename come back too.)
 *
 * ── Why it hydrates in two steps ────────────────────────────────────────────
 * Boot restores the arrangement (`applyCenterLayout`) before the terminals exist
 * (`fleet_snapshot` has not resolved yet), so the leaves come back EMPTY and the
 * per-pane contents are parked in `pendingRestore` until `rebuildTerminalTabs`
 * mints the tabs and fills them in.
 */

/**
 * What the persisted blob said belongs in one pane, held between
 * `applyCenterLayout` and `rebuildTerminalTabs`. Empty in steady state.
 */
export interface RestoreSlot {
  terminals: PersistedTerminal[];
  activeTerminalId: string | null;
}

/** The slice of the store `serializeCenterLayout` reads. */
export type CenterLayoutSource = ViewTreeSource &
  Pick<LayoutState, "tabs"> &
  Pick<FleetState, "agents">;

/**
 * The custom name a tab must carry across a restart.
 *
 * An agent terminal's rename lives on the AGENT (`renameAgent`), because the rail
 * row and the center tab both read it from there and must not drift; every other
 * terminal's lives on the tab (`renameTab`). One function, so the save side and
 * the restore side cannot disagree about which of the two owns the name.
 */
function customNameOf(s: CenterLayoutSource, tab: Tab): string | null {
  const agentId = agentIdOf(tab);
  if (!agentId) return tab.customTitle ?? null;
  return s.agents[agentId]?.customTitle ?? null;
}

/**
 * The exact inverse of `customNameOf`: put a restored rename back on whichever of
 * the agent / the tab owns it. `null` (never renamed) is left alone rather than
 * written, so a restore cannot clear a name telemetry has already supplied.
 */
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

/**
 * PURE: the center layout as it goes to disk — every view in bar order, and which
 * one is on screen.
 *
 * Reads the ACTIVE view's tree from the live `layout`, never from its snapshot
 * (which is stale by design — see `LayoutState.views`). That is the single
 * subtlety here, and getting it wrong would persist the user's *previous*
 * arrangement on every save.
 */
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

/**
 * Write the agents another OS window shows (`parked`, tab tear-off) into the active view's
 * first pane, each with the name the agent carries here. That pane is where a restored
 * terminal with no slot would land anyway; what this adds is that the agent's NAME survives
 * a quit while its tab is away. Only agents: a plain shell dies with the app, and its name
 * lives in the other window. One already in the layout is not written twice.
 */
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
  // Repair rather than throw. This is a file on disk: a hand-edit or a future
  // version can hand us a split with the wrong number of children or sizes, and
  // the whole store contract is that a bad file degrades instead of breaking
  // boot. (`Orientation` is a real enum in Rust, so a junk orientation never
  // reaches here — the blob is rejected at the door.)
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

/**
 * PURE: the persisted views, back as live `ViewSnapshot`s with EMPTY leaves, plus
 * the per-pane contents `rebuildTerminalTabs` will fill in once the terminals
 * exist. The inverse of `serializeCenterLayout`.
 */
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

/**
 * Drop panes left empty by a restore, in every view.
 *
 * A pane whose terminals did not come back — an unpinned agent, a shell that died
 * with the app — would otherwise reopen as a blank half of a split. `canonicalize`
 * collapses the split around it and never removes a view's last leaf, so a view
 * that restored nothing survives as one empty pane rather than disappearing.
 */
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

/**
 * Persist the durable API store after a mutation — an EFFECT, run in the action
 * wrapper only, never inside a `set` producer (same rule as `setWorkspaceRoot`'s
 * `setDefaultTerminalCwd`). `state` is the post-mutation snapshot (`get()`), so
 * this writes what the mutation just produced. `saveApiStore` swallows its own
 * failure, so a missing backend never surfaces here.
 */
function persistApiStore(state: ApiState): void {
  void saveApiStore({
    collections: state.apiCollections,
    environments: state.apiEnvironments,
    activeEnvironmentId: state.activeEnvironmentId,
    // 🔴 `folders` MUST be here. This is a whole-blob save: Rust replaces the file with
    // exactly what is in this object, and `folders` is `#[serde(default)]`, so omitting
    // it would not error — it would deserialize as `[]` and delete every folder the user
    // made, the next time they deleted a saved request. A field added to the store and
    // forgotten here is silent data loss, which is why
    // `deleting_a_saved_request_does_not_take_the_folders_with_it` exists.
    folders: state.apiFolders,
  });
}

/** Keep at most this many body snapshots — a bounded, generous depth. */
const BODY_HISTORY_MAX = 200;
/** Edits closer together than this join one undo step (CodeMirror's own default). */
const BODY_GROUP_MS = 500;

/**
 * Record the body about to be replaced, coalescing a burst of typing.
 *
 * Within `BODY_GROUP_MS` of the previous edit nothing is pushed: the snapshot
 * already on top is the text from before the burst began, which is what one
 * Cmd+Z should restore. Without this, undo would step back one keystroke at a
 * time — technically correct and useless.
 */
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

/**
 * Persist the request history after a mutation — same effect-in-wrapper rule as
 * `persistApiStore`. `saveApiHistory` swallows its own failure.
 */
function persistApiHistory(state: ApiState): void {
  void saveApiHistory({ entries: state.apiHistory });
}

/**
 * The database slice's boot state.
 *
 * Everything empty and `dbLoaded: false` — the panel's first mount is what reads Rust.
 * Note there is no "persist this" counterpart to `persistApiStore` here, and that is the
 * structural difference between the two features: the API store is a JS-side mirror that
 * Rust writes on command, while `db-connections.json` is written **only** by
 * `db_connection_upsert`, which validates, splits credentials and mints the Vault variable
 * server-side. There is nothing this store could persist that would be safe to persist.
 */
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

/**
 * An agent's query and a console buffer: an empty buffer takes it as a new one (unlinked from a
 * saved query, so ⌘S cannot write the agent's text over one) and `null` is returned; a buffer
 * holding other text is NOT touched, and the query is returned to be offered instead. A buffer
 * that already holds exactly the query, or an empty query, needs neither.
 */
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

/**
 * A session record that failed to open. One constructor rather than four object literals,
 * because the interesting property is that a failure carries **no** version and **no**
 * latency: a stale "PostgreSQL 17.2" next to an error is exactly the kind of cheap lie the
 * dialog's `updateDraft` also exists to prevent.
 */
function failedSession(error: string): DbSessionState {
  return { status: "error", sessionId: null, serverVersion: null, latencyMs: null, error };
}

/**
 * Said when a delete found nothing to delete. Exported so the panel's test can assert the
 * exact sentence rather than a substring of it.
 */
export const DB_ALREADY_GONE_NOTE =
  "That connection was already gone — the list has been refreshed.";

/**
 * The same statement about a saved query. Its own sentence rather than a shared one: this note
 * appears in the tree, where "the list" means the query list, and `DB_ALREADY_GONE_NOTE`
 * appears next to the connection rows.
 */
export const DB_SAVED_QUERY_ALREADY_GONE_NOTE =
  "That saved query was already gone — the list has been refreshed.";

/**
 * The import flow's boot state — also what "start over" means.
 *
 * `overwriteExistingSecrets: false` is the security default of the import flow, which is why it
 * is written HERE, once: a default duplicated at a second site is a default that can be reset
 * to the unsafe value by whichever copy someone forgets.
 */
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

/**
 * The portability slice's boot state.
 *
 * Exported so `src/test/store-harness.ts` can reset the WHOLE slice with one
 * `Object.assign` instead of listing keys by hand. That is deliberate: a new key added here
 * and forgotten there has already cost this repo 35 red tests once and a stale error asserted
 * as a fresh one another time (see the harness's own comments).
 *
 * There is no "persist this" counterpart to `persistApiStore`, and there must not be: nothing
 * in this slice is durable. A bundle lives in a file the user chose, and Rust is the only
 * thing that reads or writes it.
 */
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
            // Deliberately NOT copied: the response, the error, the sending flag
            // and the body history. A duplicate has not been sent — showing the
            // original's response under a request that never ran would be a lie,
            // and inheriting its undo stack would let Cmd+Z rewrite the copy into
            // edits that were never made to it.
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
            // Placeholders stay LITERAL — the header/url/body are snapshotted
            // exactly as typed, so a `{{TOKEN}}` never becomes the real secret
            // in a saved collection. Header rows collapse to the
            // on-wire {name,value} shape (the enabled flag is row scaffolding).
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
          // Mint a fresh request, pour the saved fields (incl. protocol) into it,
          // open a tab, and title the tab with the saved name. createApiRequest +
          // loadCollectionIntoRequest are pure api mutations; openApiRequestTab +
          // renameTab are layout — composed here via get(), never nested in a
          // producer (same rule the other cross-slice openers follow).
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
            // gRPC entry: restore the protocol + the endpoint/service/
            // method so re-running goes back through the gRPC console. `url`/`body`/
            // `headers` above already carry the endpoint/message/metadata. A missing
            // `protocol` reads as HTTP (back-compat), leaving `req.protocol` be.
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
        // Every one of these is: ask Rust → it re-reads the file, mutates, writes
        // atomically, returns the WHOLE store → hydrate from that. Never "mutate here,
        // then blob-save", because the blob save is the lost-update path.

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
        // Pure status transitions; the console (GrpcConsole.tsx) runs the grpc_*
        // EFFECTS (reflect via grpcIpc, send via executeGrpcRequest), so these
        // stay deterministic.
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
       * Every action here is an `async` WRAPPER: the IPC call happens outside any `set`
       * producer and the result is applied in one, which is the wrapper rule in its purest form
       * — the effect and the reduction are not even in the same function body. */
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
            // Re-thrown as an `Error` whose MESSAGE is the mapped sentence, never Rust's
            // string: the dialog renders whatever it catches, and a driver message can
            // carry the DSN it dialled. The original goes on `cause` — not
            // rendered anywhere, and safe to keep because `DbError::to_wire` redacts
            // before it rejects, so the detail is already scrubbed of the secrets that
            // were in play.
            throw new Error(dbErrorMessage(e), { cause: e });
          }
          set((s) => {
            // Replace in place when Rust returned an id we already hold — which is how an
            // edit keeps its position in the list instead of jumping to the bottom.
            const at = s.dbConnections.findIndex((c) => c.id === saved.id);
            if (at === -1) s.dbConnections.push(saved);
            else s.dbConnections[at] = saved;
            // 🔴 **The edited record must not leave a session on the OLD one** (the bug:
            // after the database URL was edited, a reopened query console still used the
            // old URL). This mirror is what `DbConsoleTab` reads to decide it is
            // connected, so leaving it is the bug this guards against: the row showed the new
            // URL while every query went down the socket dialled from the old one.
            //
            // Rust closes the real session in `db_connection_upsert`, exactly as it does on
            // delete — so, as on the delete path, there is nothing to close here. Only the
            // mirror, and the subtree the old server answered: every ref in it addresses a
            // session id that is now invalid, and its tables may not exist on the new host.
            //
            // Dropped unconditionally, including for a pure rename. The alternative — diffing
            // the connect-affecting fields — cannot be made honest: a password can change while
            // `passwordRef` stays byte-identical (the secret moves in the Vault, not the record),
            // so a fingerprint would silently keep a session authenticated with the old one. The
            // cost of over-invalidating is one click on Connect; the cost of missing one is
            // querying the wrong database, or writing to a connection you just marked read-only.
            //
            // What deliberately SURVIVES: `dbConsoles` (the user's unsaved query text — an edit
            // is not a reason to lose it), `dbSavedQueries` (keyed by connection, read without
            // a session), and `dbTreeOrders` (the hand-arranged table order). Contrast
            // `deleteDbConnection`, which drops all three: there, the connection itself is gone.
            //
            // The order survives on the same reasoning as the saved queries, and it is a
            // decision rather than an oversight. It is a
            // preference the user spent time on, not server state; if the edit was a typo fix
            // or a port change the arrangement still applies verbatim, and if the new host has
            // different tables the stale entries are simply skipped by `applyOrder`. Dropping
            // it would silently discard that work every time someone corrected a URL.
            delete s.dbSessions[saved.id];
            delete s.dbTrees[saved.id];
            s.dbError = null;
          });
          // 🔴 LOST UPDATE. `db_connection_upsert` writes a `forever`
          // password into the Vault — which is `api-store.json`, the same file the API
          // slice mirrors in memory and rewrites WHOLESALE on any collection/Vault edit.
          // That mirror is hydrated once per app run, so without this re-read the new
          // password was invisible until restart AND the next `persistApiStore` wrote the
          // pre-password snapshot straight back over it. Awaited (not fire-and-forget) so
          // the mirror is current before this action's caller can trigger another save.
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
            // The hand-arranged table order goes too. Rust cascades it on disk
            // (`db_connection_delete` → `tree_order::remove_for_connection`), so keeping our
            // copy would leave an arrangement in memory for a connection that no longer
            // exists anywhere — and it would be re-adopted by the next connection that
            // happened to be minted with the same id.
            delete s.dbTreeOrders[id];
            // And the console, plus any open "name this query" dialog that belonged to it.
            // 🔴 Not tidiness: `db_saved_query_upsert` does NOT validate that `connectionId`
            // names a live connection, so confirming a dialog left over a deleted connection
            // would write a saved query that is an orphan the moment it lands — the exact
            // thing `queries.rs`'s delete cascade exists to prevent.
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
            // 🔴 **ONE dial.** This used to probe with `db_test_connection` and then
            // call `db_open` — two complete dials, two TLS handshakes, two authentications, the
            // first one's connection thrown away, purely to learn the server version. Against a
            // remote cluster that roughly doubled the time to open. `db_open` now returns the
            // version and the latency from the connection it actually keeps.
            //
            // `password: null` because a saved connection's `{{VAR}}` is resolved from the Vault
            // inside Rust; a `session`/`never` connection has nothing stored, and then this fails
            // as `auth`, which is the truth about it.
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
            // 🔴 **Rust's own sentence, not our code→sentence mapping**, and this is what keeps the
            // one-dial change from costing diagnosis quality. The probe path used to render
            // `DbTestResult.error` verbatim — contract-guaranteed mapped + redacted prose — and a
            // rejection from `db_open` carries the **same `DbError.message`**, built by the same
            // code (`test_connection` literally copies it into that field). So the detail is exactly
            // as safe and strictly more specific: "That database does not exist on the server.
            // FATAL: …" rather than "check the host, the port, and the settings this engine
            // requires". Decided here, at this one call site, rather than by widening
            // `DETAIL_IS_THE_ANSWER` — that list governs prose whose safety is not established.
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
            // The cached subtree dies with the session that answered it: every ref in it
            // addresses a session id that is about to be invalid, so re-expanding a level
            // after a reconnect must ask the NEW session rather than replay old answers.
            // The saved-query list deliberately SURVIVES — it is keyed by connection and read
            // without a session, which is the whole of requirement 9.
            delete s.dbTrees[id];
          });
          if (sessionId === null) return;
          try {
            await dbClose(sessionId);
          } catch {
            // Deliberately swallowed, and the only swallow in this slice. `db_close` is
            // idempotent and returns no error of its own, so a rejection here can only be
            // a transport failure — at which point the session is already unreachable, our
            // state already says "closed", and there is no action for the user to take.
            // Surfacing it would be noise on a gesture that succeeded.
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
            // `clampSplit` is the console's own function, imported rather than re-derived,
            // so the store and the divider can never disagree about the bounds — and it
            // absorbs a non-finite value, which as a `flex-grow` would silently collapse
            // a pane rather than throw.
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
          // The connection AND an open session, both required. The row limit is the
          // connection's, and there is no defensible guess for it: sending the engine
          // default would silently run a query under a different cap than the one the
          // connection promises. `not-found`'s sentence covers both cases exactly.
          if (
            connection === undefined ||
            session?.status !== "open" ||
            session.sessionId === null
          ) {
            set((s) => {
              const c = (s.dbConsoles[id] ??= blankDbConsole());
              c.running = false;
              // `not-found` IS the code for this: "that connection or session no longer
              // exists — reload the panel and open it again." My first version invented a
              // `"no-session"` code that is not in `DB_ERROR_CODES`, which typecheck caught
              // — a code the mapper has no sentence for would have rendered as "unknown".
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
            // 🔴 The bug: an edit to the database was not
            // reflected until the view was changed. A write invalidates the object tree, and
            // until now nothing told the tree so — see `refreshDbTree`.
            //
            // **`kind === "affected"` IS the write signal, and it is already on the wire.**
            // `src-tauri/src/db/result.rs` documents `Affected` as *"a write: `rows_affected`
            // is the payload"*, and the SQL path (`engine.rs`) classifies every statement that
            // returned no rows and is not row-returning that way — so a `CREATE TABLE` arrives
            // as `affected` with `rowsAffected: 0` (ClickHouse sends `null`). Keyed on the
            // KIND and never on `rowsAffected > 0`: DDL affects no rows, and DDL is exactly
            // the case that broke.
            //
            // Not `"message"` — that is a notice or a **database error**, and re-reading the
            // catalogue after a statement the server refused is noise. Not `"rows"` — a read
            // changes nothing, and refreshing on it would fire catalogue queries after every
            // SELECT, which is the cost `dbTrees` exists to avoid.
            //
            // The EFFECT is in the wrapper, outside the producer.
            //
            // The store's standing worry — argued at length on `dbTrees` — is about paying
            // catalogue queries for a **passive** gesture (a rail-tab click). This is the
            // opposite track: the user has just written to the database and is waiting to see
            // the change. Deliberately *not* gated on `runToken`: a stopped run's reply is
            // discarded for display, but the write it reports still reached the server, so the
            // tree is stale either way.
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
          // 2. The EFFECT, in the wrapper: ask the server to stop. Best-effort by
          //    design — an engine with no server-side cancel rejects, and that is information,
          //    not a failure of the gesture. It lands as a console notice; nothing throws,
          //    because the button has already done the part it can guarantee.
          if (sessionId === null) return;
          void dbCancel(sessionId).catch((e: unknown) => {
            set((s) => {
              const c = s.dbConsoles[id];
              if (c === undefined) return;
              // Rust's own sentence when it sent one — "This engine has no server-side cancel"
              // is exactly the thing to show, and the canned per-code prose would replace it with
              // "the database call failed for an unrecognised reason". Same choice, and the same
              // reasoning, as the connect path above.
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
          // The effect, outside the producer. `loadDbChildren` decides for itself whether
          // there is anything to fetch, so this does not duplicate the cache check. Two
          // conditions besides "opening", and neither is defensive: the `Saved queries` node
          // is answered by `db_saved_queries` (`isServerAnswered`), and a row can be expanded
          // with no session at all — that is the state a failed connect leaves behind, and it
          // is exactly when the saved queries still have to be visible.
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
          // Never rejects. A missing or unreadable `db-tree-order.json` means "nobody has
          // dragged anything", which renders alphabetically — the behaviour that existed
          // before this feature. Surfacing an error banner for it would be noise about a
          // preference file.
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
          // The order the user is looking at: the saved arrangement applied to the children
          // currently cached. Computing from the DISPLAYED list is what makes the first drag
          // on an untouched level work without a separate materialisation step — the result
          // is a total order over exactly what is on screen.
          const displayed = applyOrder(
            get().dbTrees[id]?.children[parentKey] ?? [],
            (n) => n.label,
            get().dbTreeOrders[id]?.[parentKey] ?? [],
          ).map((n) => n.label);
          // Nothing on screen means no gesture happened: the drag can only start from a
          // rendered row. Without this guard `moveBefore([], "a", …)` returns `["a"]`, which
          // differs from `[]` and would therefore be WRITTEN — persisting a one-item
          // arrangement the user never made, which then pins that table to the top of the
          // level forever. Defensive, and the store test that found it says so.
          if (displayed.length === 0) return;
          const next = moveTreeNodeBefore(displayed, moved, before);
          // A drag that put the row back where it started writes nothing: no re-render, no
          // file, no chance of a spurious conflict with another level's save.
          if (sameOrder(displayed, next)) return;
          set((s) => {
            (s.dbTreeOrders[id] ??= {})[parentKey] = next;
          });
          // Fire-and-forget with a caught rejection, like every other optimistic write in
          // this slice: the arrangement is already on screen, and a failed write to a
          // preference file is not something the user can act on mid-drag. It reappears
          // alphabetically on the next launch, which is honest about what was saved.
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
       * Same shape as the db slice: every action is an `async` WRAPPER whose IPC call (and
       * whose native file picker) happens outside any `set` producer, with only the result
       * applied inside one.
       *
       * 🔴 No action here writes a passphrase into state. It is an argument on `exportBundle`
       * (inside `options`), on `inspectBundle`/`unsealImport` and on `applyImport`, and in all
       * three cases it goes straight to the wire. There is no field it could land in, which
       * is a stronger guarantee than a rule about not filling one in. */
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
            // A plan that came back STILL SEALED after a passphrase was supplied is a failed
            // unseal that resolved rather than rejected — `ImportPlan.unsealed` is documented
            // as `false` when the passphrase "was wrong". Rust may instead reject with
            // `bad-passphrase`; both are handled, because a UI that only handled one would
            // show an unchanged dialog and no reason for it. With `passphrase: null` the same
            // `unsealed: false` is the normal "this file is sealed" state and NOT an error.
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
            // Rust has just rewritten `db-connections.json` and `api-store.json` underneath
            // two slices whose load-once gates say they are current. Re-arming both gates is
            // what makes the imported connections and environments appear when their panels
            // next mount (this app unmounts inactive tabs, so that is the very next visit).
            s.dbLoaded = false;
            s.apiStoreLoaded = false;
          });
          // …and for a DB panel that is mounted RIGHT NOW, re-arming the gate is not enough:
          // its load runs on mount. So re-issue it here, in the wrapper. `loadDbStore` never
          // rejects (a failure lands in `dbError`), which is why this can be fire-and-forget.
          // The API/Vault panels own their own loader (a component effect, not a store
          // action), so the re-armed flag is all this slice can honestly do for them — noted
          // for the code that wires the dialogs.
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
          // Effect first, in the wrapper: authorize `read_dir` on this folder by
          // recording it in the persisted recents (allowed_roots = recents ∪
          // workspaceRoot). Best-effort — the folder still opens if the push
          // fails; only its listing would be scoped-out until a later retry.
          void pushRecentProject(path).catch(() => {
            // Persisting recents is a nicety; never block opening the folder on it.
          });
          // Install the ad-hoc-detection hook for this opened folder:
          // opening a folder spawns no terminal, so without this a `claude` typed
          // in a terminal launched here later would go undetected. Best-effort in
          // lockstep with the recents push — a failure must never break opening it.
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
          // A terminal doing something gets its own confirm. This is the one
          // gate that covers the tab ✕, middle-click
          // AND the native Cmd/Ctrl+W, because all three already route here —
          // which is precisely why the check belongs at this junction and not at
          // the three call sites.
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

          // Same path as any other terminal tab — the agent-ness is carried by
          // the tab's `ref` and by which command the registry routes to, not by
          // a parallel spawn mechanism. `runtime` must travel with `agentId` or
          // the registry throws rather than quietly hand the user a shell.
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

            // Clearing comes FIRST, and deliberately before the
            // already-selected bail-out. An agent that is *already* selected is
            // exactly the one that can raise a badge while you watch it: it
            // blocks on a prompt, the row lights up, you click it — and with
            // the bail-out first, nothing happens and the badge sticks forever.
            // Assigning an unchanged value is free under Immer, so re-selecting
            // a read agent still produces no new state.
            clearUnread(s, agentId);

            // Re-point the center (the pivot). Roots own a terminal;
            // sub-agents (no PTY — they run in-process) instead reveal a
            // read-only activity view, created on first selection (M3). Both
            // before the bail-out, so re-clicking an already-selected agent
            // whose center was navigated elsewhere brings its view back to
            // front. Uniform for spawned and ad-hoc roots (ad-hoc after
            // `promoteTabForAgent`).
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
          // The lost-rename bug, for an agent row / its center tab. The name is
          // persisted with the CENTER LAYOUT, not with the pin registry: the pin
          // registry only knows pinned roots, and giving one fact two writers is
          // how the two disagree. See `serializeCenterLayout`.
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
          // Same path as closing the tab: find the agent's terminal tab and
          // close it. `closeTab` tears down the PTY (its `dispose` calls
          // `terminal_close`) AND removes the agent from the forest — including
          // the pin cleanup — so the row ✕ and the tab ✕ converge on one
          // behaviour (no fork). A pinned root has a terminal tab, so this is the
          // path its dismissal actually takes.
          const tabId = findAgentTab(get().tabs, agentId);
          if (tabId) {
            get().layoutActions.closeTab(tabId);
            return;
          }
          // No tab to close — a sub-agent telemetry node (M3), or an agent whose
          // tab is already gone. Remove it directly, and still kill any live
          // child: an agent terminal is keyed by its agentId, so that id IS the
          // TerminalId. `dispose` is idempotent, so a dead child is a no-op.
          const unpinned: AgentId[] = [];
          set((s) => removeAgentFromForest(s, agentId, unpinned));
          dispose(asTerminalId(agentId));
          // Unpin any removed pin so it cannot zombie-resurrect next boot.
          for (const id of unpinned) void persistUnpin(id);
          persistLayoutPrefs(get);
        },

        applyFleetSnapshot: (agents) =>
          set((s) => {
            // Upsert, never replace: a snapshot arriving after a re-attach must
            // not blow away expanded/unread the user is looking at.
            //
            // One pass is enough even though the array is unordered — a child
            // that precedes its parent is surfaced as a root, then adopted when
            // the parent lands (see `adoptOrphans`). That is the same mechanism
            // out-of-order live telemetry needs, so there is only one code path
            // to get right.
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
            // Flag each snapshot row Rust reports as pinned. A pin whose row is
            // absent (resume expired / spawn refused) has no row to flag and is
            // skipped — the happy path rides entirely on the usual re-attach
            // that already painted the auto-spawned roots. Pure reconcile: no
            // persist (this IS what Rust just handed us).
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
                  // A root is born IDLE (parked at its prompt; the turn/activity
                  // hooks drive it to running/idle — mirrors the Rust node default).
                  // A sub-agent announced via `agent_started` is born running: it
                  // exists only because it is already doing work.
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
                // Ad-hoc agent (`claude` typed in a plain terminal): bind its
                // tab so closing it dismisses the agent. Guarded on the agent
                // actually existing — a tombstoned id that `upsertAgent` just
                // skipped must NOT promote a tab to point at a dead agent.
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
          // Cmd/Ctrl+W closes whatever tab is active — any kind (terminal, editor,
          // API request, activity). Route via requestCloseTab so a dirty editor
          // still raises the unsaved-changes confirm; every other kind falls
          // straight through to closeTab (an agent-terminal also dismisses its
          // agent, as its ✕ does; an activity tab stops its polling).
          if (s.tabs[tabId]) s.editorActions.requestCloseTab(tabId);
        },

        openTerminalTab: (opts) => {
          const tabId = asTabId(newId());

          /**
           * An agent terminal's TerminalId **is** its AgentId.
           *
           * Not a convenience — Rust keys an agent's PTY by its agentId and
           * `agent_spawn` accepts no terminalId at all (`supervisor/mod.rs`:
           * `let terminal_id = spec.agent_id.clone()`). Minting a fresh id here
           * is the M2 bug in two parts: the registry never learns there is an
           * agent (so it routes to `terminal_open` and the user gets bash),
           * and even once it does, a divergent id fails as a **dead keyboard** —
           * `agent_spawn` succeeds, bytes stream over the Channel that was
           * handed over directly, and every write/resize/close addresses an id
           * Rust never registered. Output appears; typing does nothing; nothing
           * errors. The registry checks the identity too (`openAgentPty`), so
           * the two halves of this contract fail loudly rather than silently.
           */
          const terminalId = opts?.agentId
            ? asTerminalId(opts.agentId)
            : asTerminalId(newId());

          // Pre-register the spawn options: the PTY is opened lazily by the
          // registry when <TerminalView> first mounts, and this is the only
          // place that knows the cwd/agent (Tab carries neither — types.ts is
          // the contract). `runtime` must travel WITH `agentId`: the registry
          // throws rather than fall back to a shell, which is the bug it exists
          // to prevent.
          if (opts?.cwd || opts?.agentId) {
            // Only keys we actually have. `configureTerminal` merges
            // (`{...previous, ...opts}`), so an explicit `agentId: undefined`
            // would not be inert — it would erase an agentId set by an earlier
            // call, turning an agent terminal back into a shell.
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
          // Dedupe by path against `diff` tabs only — an editor tab for the same
          // file is a DIFFERENT view and must keep its own tab (see the action's
          // doc). No IPC in the wrapper: the view fetches its own diff on mount,
          // so this stays a pure state mutation like openEditorTab.
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
              // NOT the bare filename: a diff tab routinely sits next to an EDITOR
              // tab for the same file, and two tabs reading `a.ts` differ only by a
              // small icon. The suffix says which view this is, and echoes the menu
              // item that opened it ("Compare with HEAD").
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
          // Singleton, not keyed dedupe: find the ONE metrics tab if it exists,
          // re-point it at the current project and re-focus it. Re-pointing matters
          // because the tab outlives a folder switch — a dashboard still labelled
          // with the previous project would be showing the wrong numbers under the
          // right title, which is worse than showing none.
          const existing = Object.values(get().tabs).find(
            (t) => t.ref.kind === "metrics",
          );
          if (existing) {
            set((s) => {
              // The whole ref is REPLACED rather than mutating `ref.cwd` in place: the
              // latter needs a `ref.kind === "metrics"` narrowing guard whose false
              // branch is provably unreachable (we found this tab *by* that predicate),
              // and an unreachable branch is a coverage hole pretending to be defence.
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
          // The request's UI state lives in the api slice; the tab only references
          // it by id (types.ts is the contract — the Tab carries no request data).
          // No PTY, so this is a pure state mutation, like openEditorTab. A caller
          // (History re-run) may hand in an already-created + populated request;
          // otherwise mint a fresh empty one.
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

            // 1. Put each restored terminal back where the user left it: its
            //    own view, its own pane, in its own order — and wearing the name
            //    they gave it. This is the whole fix for both agents ending up in
            //    one view; before it, every branch below was the fallback.
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

            // 2. Anything the blob did not account for — a terminal opened since
            //    the last save, or a boot with no persisted layout at all — lands
            //    where it always did: the focused leaf of the view on screen.
            //    (The canonical tree always has ≥1 leaf, so no guard — see
            //    `leavesOf`'s invariant.)
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

          // 🔴 Persist, even though this is the restore side.
          //
          // `bridge.ts` boots in this order: applyCenterLayout → fleet_snapshot →
          // **registerFleetRoots** → rebuildTerminalTabs. That middle step calls
          // `syncFolderOrder`, which persists — at the exact moment the views have
          // been restored but their leaves are still EMPTY. The file on disk then
          // said "two views, no terminals", and quitting before touching anything
          // made that the new truth: a restore that erases what it restored.
          //
          // So the placement pass writes the corrected blob (tabs placed, dead
          // panes pruned) as its last act. Unlike `applyCenterLayout` — a pure
          // read-back, which still must not persist — this genuinely changes the
          // arrangement, so writing it down is not an echo.
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
            // Remove + tombstone the agent in the same commit, so a late event
            // cannot slip a ghost row in between the two writes.
            // The tab may live in a view that is not on screen (`leafOfTab`
            // above only sees the ACTIVE tree), which would leave its id dangling
            // in that view's snapshot with no record behind it.
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
            // The tab strip assigns `activeTabId` directly rather than going
            // through `activateTab`, so it has to record the file itself —
            // otherwise clicking an editor tab moves the editor but not the
            // Files rail's highlight.
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

            // Normalizing in place IS the canonical form here: a resize changes
            // no structure, so a full canonicalize pass (and its tree rebuild,
            // per drag frame) would be pure churn. The equality guard drops the
            // no-op onChange that allotment fires on container resize.
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

        // Both drops delegate to the pure planners above. That is deliberate and
        // load-bearing, not tidiness: the drag PREVIEW runs the very same
        // planner against the current tree, so "what the user is shown" and
        // "what the drop does" cannot drift apart. They did drift — the preview
        // used to be drawn as a rectangle inside the hovered pane, which misses
        // the source-prune → single-child-collapse the planner performs, and
        // that is the half-screen preview bug.
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
          // The pane ✕ kills every terminal in the pane in ONE click, with no
          // undo — the sharpest version of the problem, and a path
          // that bypassed the confirm entirely. A gated WRAPPER, exactly like
          // `requestCloseTab` over `closeTab`: `closePane` stays the synchronous
          // primitive every internal caller and the confirm's own replay use, so
          // asking the user can never become something a caller does by accident.
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
          // Editor tabs die with the pane too — and only the ACTIVE one had a
          // mounted component to dispose itself on unmount. Disposing here also
          // drops each path's `editors` slice, so a later open reloads from
          // disk instead of resurrecting the dead pane's stale buffer.
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
            // Every current id is in `order` (it was built from them); an UNKNOWN
            // `viewId` is appended there and simply matches nothing here, which is
            // why this needs no membership guard to be a no-op. Ranked by `indexOf`
            // rather than a lookup map for exactly that reason: a map read would
            // need a `?? 0` fallback that no input can reach, and a handful of
            // views is not a place to track a dead branch for a micro-optimisation.
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
          // Clear FIRST, then replay. Two reasons, and the second is the one that
          // would bite: the dialog unmounts the instant the record goes, so the
          // user does not watch it sit there through the teardown — and the
          // replay calls the PRIMITIVES (`closeTab` / `closePane` /
          // `dismissAgent`), never the `request*` wrappers, so "the user said
          // yes" can never be re-expressed as "ask again". Routing the replay
          // through a wrapper instead is the loop this ordering makes impossible.
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
