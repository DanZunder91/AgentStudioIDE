/** Which workspace a find overlay defaults to: the first of `contextPaths` (focused tab, then the
 * remembered context tab, then the last file tab) owned by an open root (`rootForPath`). Unowned
 * candidates are skipped. Read-only over the store. */

import { activeFilePath, findNode, leavesOf, type LayoutState } from "../../app/store";
import { rootContaining } from "../../app/revealPath";
import { samePath } from "../../lib/paths";
import type { AgentId, AgentNode, Tab, TabId, TerminalId } from "../../app/types";

/** A plain terminal's cwd is not in the store (the registry's `getTerminalMeta` has it), so it
 * is injected, keeping this module pure. */
export type TerminalCwdLookup = (terminalId: TerminalId) => string | null;

/** The slice of the store `contextPaths` reads: the layout plus the agents (for a cwd). */
export type ContextState = LayoutState & {
  agents: Record<AgentId, Pick<AgentNode, "cwd">>;
};

/** The folder or file a tab is about, or null. An agent terminal prefers the agent's hook cwd
 * over the PTY's spawn cwd. */
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

/** Tab kinds worth remembering. Terminals count even with an unknown cwd: it is re-read each
 * time, and an unknown simply falls through. */
const CONTEXT_KINDS: ReadonlySet<Tab["ref"]["kind"]> = new Set([
  "editor",
  "diff",
  "terminal",
  "agent-terminal",
  "agent-activity",
  "session-picker",
  "metrics",
]);

/** The last focused tab that could name a folder (wider than `lastFilePath`). Honoured only while
 * `s.tabs[tabId].ref` is the same object, so closed or reused tabs go inert; `ref`, not the
 * record, since records are rebuilt for incidental edits like `dirty`. */
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

/** Reducer run on every store update: remember the focused tab if it can name a folder, else
 * keep `prev`. O(panes). */
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

/** Paths the user is in, most specific first: focused tab, `memory`, last file tab. Unknowns are
 * dropped. */
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

/** First of `contextPaths` some root owns, or null (the caller keeps the primary root). */
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

/** `path`'s owning root: the root itself, else the longest strictly containing it on a segment
 * boundary, as spelled in `roots` (a valid `<option>` value); null if none. Either separator;
 * Windows paths compare case-insensitively. */
export function rootForPath(roots: readonly string[], path: string | null): string | null {
  if (!path) return null;
  const exact = roots.find((root) => samePath(root, path));
  return exact ?? rootContaining(roots, path);
}
