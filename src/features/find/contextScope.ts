/**
 * contextScope — which workspace a find overlay should DEFAULT to.
 *
 * Ctrl+F and Ctrl+O searched every workspace by default,
 * when they should follow the window that is open — from a gazelle file or a
 * gazelle terminal the search should cover gazelle. Before
 * this, `useScope` defaulted to the primary root (`workspaceRoot`, or the first
 * open root) no matter what the user was looking at, so in a multi-root window
 * Cmd/Ctrl+Shift+O from a `gazelle` file searched some other repo.
 *
 * The answer is two pure questions, both here so they are unit-testable without a
 * component:
 *  1. **Which paths is the user "in", most specific first?** (`contextPaths`)
 *     — the focused pane's active tab (a file tab's path, a terminal's / agent's
 *     cwd, a session picker's or the metrics panel's folder); then the last tab
 *     that COULD name a folder and was focused (`ContextMemory` — so a gazelle
 *     console followed by a switch to the village still means gazelle); then the
 *     last FILE tab activated anywhere (`activeFilePath`'s sticky clause — the
 *     same memory the Files rail crosshair follows).
 *  2. **Which open root owns that path?** (`rootForPath`) — the LONGEST root that
 *     contains it on a path-segment boundary (`/a/gen` never owns `/a/gazelle/x`),
 *     or the root itself when the path IS a root (a terminal's cwd usually is).
 *
 * `contextRoot` combines them: the first candidate that some open root owns. A
 * candidate no root owns (a terminal spawned in `~`, a file opened from outside
 * every root) is skipped rather than ending the search, so it cannot knock the
 * scope back to the primary root while a later candidate still names gazelle.
 *
 * Reads only; never writes the store.
 */

import { activeFilePath, findNode, leavesOf, type LayoutState } from "../../app/store";
import { rootContaining } from "../../app/revealPath";
import { samePath } from "../../lib/paths";
import type { AgentId, AgentNode, Tab, TabId, TerminalId } from "../../app/types";

/**
 * Where a plain terminal's cwd comes from. The store does not keep it — `Tab`
 * carries only a `terminalId` and the spawn cwd lives in the terminal registry
 * (`getTerminalMeta`, the cwd Rust actually opened the PTY in) — so it is injected,
 * keeping this module pure and the tests free of a live PTY.
 */
export type TerminalCwdLookup = (terminalId: TerminalId) => string | null;

/** The slice of the store `contextPaths` reads: the layout plus the agents (for a cwd). */
export type ContextState = LayoutState & {
  agents: Record<AgentId, Pick<AgentNode, "cwd">>;
};

/**
 * The folder or file a single tab is "about", or null when it names none.
 *
 * An agent terminal prefers the AGENT's cwd (where `claude` is actually running —
 * the hook payload's cwd) and only then the PTY's spawn cwd.
 */
export function tabContextPath(
  tab: Tab | undefined,
  agents: ContextState["agents"],
  terminalCwd: TerminalCwdLookup,
): string | null {
  if (tab === undefined) return null;
  const ref = tab.ref;
  switch (ref.kind) {
    case "editor":
    case "diff":
      return ref.path;
    case "agent-terminal":
      return agents[ref.agentId]?.cwd || terminalCwd(ref.terminalId);
    case "terminal":
      return terminalCwd(ref.terminalId);
    case "agent-activity":
      return agents[ref.agentId]?.cwd || null;
    case "session-picker":
    case "metrics":
      return ref.cwd;
    default:
      return null;
  }
}

/**
 * The tab kinds `tabContextPath` can answer for — the ones worth remembering. A
 * terminal is in even though its cwd may not be known yet: it is checked again on
 * every read, so an unknown cwd simply falls through to the next candidate.
 */
const CONTEXT_KINDS: ReadonlySet<Tab["ref"]["kind"]> = new Set([
  "editor",
  "diff",
  "terminal",
  "agent-terminal",
  "agent-activity",
  "session-picker",
  "metrics",
]);

/**
 * The last focused tab that could name a folder — the "most recently active tab
 * that has a path" fallback. The store remembers only the last FILE
 * (`lastFilePath`), which loses a gazelle terminal the moment the
 * pane switches to the village; this is the same idea one notch wider.
 *
 * It keeps the tab's `ref` alongside its id and is honored only while
 * `s.tabs[tabId].ref` is still that exact object: a closed tab, a reset store, or
 * an id later reused for a different tab (test harnesses do that) is inert rather
 * than wrong — the same validate-on-read rule `activeFilePath` uses, with no
 * close-path bookkeeping. `ref` rather than the whole record because a record is
 * rebuilt for incidental edits (an editor's `dirty` flag) that do not move it.
 */
export interface ContextMemory {
  tabId: TabId;
  ref: Tab["ref"];
}

/** The focused pane's active tab id (the first leaf when `focusedPaneId` is stale). */
function focusedTabId(s: LayoutState): TabId | null {
  const focused = findNode(s.layout, s.focusedPaneId);
  // `focusedPaneId` always names a live leaf (store invariant); the first leaf is
  // the same defensive fallback `targetLeaf` uses.
  const leaf = focused && focused.type === "leaf" ? focused : leavesOf(s.layout)[0];
  return leaf.activeTabId;
}

/**
 * The next `ContextMemory` given the current state — a reducer, run on every store
 * update by `useScope`'s module-level subscription. Remembers the focused tab when
 * its kind can name a folder; otherwise (the village, settings, nothing focused…)
 * keeps `prev`, which is the whole point. O(panes): cheap enough for every update.
 */
export function rememberContextTab(
  prev: ContextMemory | null,
  s: LayoutState,
): ContextMemory | null {
  const tabId = focusedTabId(s);
  const tab = tabId === null ? undefined : s.tabs[tabId];
  if (tab === undefined || !CONTEXT_KINDS.has(tab.ref.kind)) return prev;
  if (prev && prev.tabId === tab.id && prev.ref === tab.ref) return prev;
  return { tabId: tab.id, ref: tab.ref };
}

/** The remembered tab, while it is still live and still the same tab; else undefined. */
function recalled(memory: ContextMemory | null, s: LayoutState): Tab | undefined {
  if (memory === null) return undefined;
  const tab = s.tabs[memory.tabId];
  return tab !== undefined && tab.ref === memory.ref ? tab : undefined;
}

/**
 * The paths the user is "in", most specific first: the focused pane's active
 * tab's context, then the remembered context tab's (`memory`), then the last file
 * tab activated anywhere (validated against the live tabs by `activeFilePath`).
 * Unknowns are dropped, so it is empty when nothing names a folder.
 */
export function contextPaths(
  s: ContextState,
  terminalCwd: TerminalCwdLookup,
  memory: ContextMemory | null = null,
): string[] {
  const tabId = focusedTabId(s);
  const candidates = [
    tabContextPath(tabId === null ? undefined : s.tabs[tabId], s.agents, terminalCwd),
    tabContextPath(recalled(memory, s), s.agents, terminalCwd),
    activeFilePath(s),
  ];
  return candidates.filter((p): p is string => p !== null);
}

/**
 * The open root the user is "in": the first of `contextPaths` that some root in
 * `roots` owns (`rootForPath`), or null when none does — the caller then keeps
 * its own default (the primary root).
 */
export function contextRoot(
  roots: readonly string[],
  s: ContextState,
  terminalCwd: TerminalCwdLookup,
  memory: ContextMemory | null = null,
): string | null {
  for (const path of contextPaths(s, terminalCwd, memory)) {
    const root = rootForPath(roots, path);
    if (root !== null) return root;
  }
  return null;
}

/**
 * The open root that owns `path`: the root itself when `path` IS a root (a
 * terminal opened in it), else the longest root strictly containing it, honoring
 * segment boundaries. Returns the root exactly as it appears in `roots` (so it is
 * a valid `<option>` value), or null when none owns it. Either separator; Windows
 * paths without case (a terminal whose cwd says `c:\w` is in the root `C:\w`).
 */
export function rootForPath(roots: readonly string[], path: string | null): string | null {
  if (!path) return null;
  const exact = roots.find((root) => samePath(root, path));
  return exact ?? rootContaining(roots, path);
}
