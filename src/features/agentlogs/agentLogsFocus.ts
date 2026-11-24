/**
 * Agent Logs → "take me there". Clicking a row's source label focuses the tab that
 * produced it, when that tab still exists.
 *
 * Resolution order:
 *   1. The line's TERMINAL tab (plain `terminal` or `agent-terminal`) — the most precise
 *      answer, wherever it lives: a tab parked in another view switches to that view
 *      first (the same rule `activateTab` follows for the agent rail).
 *   2. Its AGENT via `selectAgent` — the rail's own action, so a sub-agent reveals (or
 *      opens) its `agent-activity` tab exactly as clicking it in the tree does. A root
 *      agent qualifies only while its terminal tab exists: `selectAgent` on a tab-less
 *      root would change the selection and focus nothing, which is a link to nowhere.
 *   3. Nothing — the label renders as plain text and its title says why.
 */

import {
  leafOfTab,
  useAppStore,
  viewTabIds,
  type AppStore,
  type ViewSnapshot,
} from "../../app/store";
import type { AgentId, LeafNode, TabId, TerminalId } from "../../app/types";
import { revealMachinePid } from "../network/machineStore";
import { setNetworkMode, showAppFlows } from "../network/networkStore";
import type { LogLine } from "./agentLogsTypes";

export type FocusTarget = { kind: "tab"; tabId: TabId } | { kind: "agent"; agentId: AgentId };

export type FocusSource = Pick<AppStore, "tabs" | "agents" | "layout" | "views" | "activeViewId">;

type LineRef = Pick<LogLine, "terminalId" | "agentId">;

/** The view holding `tabId`, or undefined for an orphaned record. */
function viewOf(s: FocusSource, tabId: TabId): ViewSnapshot | undefined {
  return s.views.find((v) => viewTabIds(s, v.id).includes(tabId));
}

export function focusTargetFor(line: LineRef, s: FocusSource): FocusTarget | null {
  const tabs = Object.values(s.tabs);
  if (line.terminalId !== null) {
    const tab = tabs.find(
      (t) =>
        (t.ref.kind === "terminal" || t.ref.kind === "agent-terminal") &&
        t.ref.terminalId === line.terminalId,
    );
    if (tab && viewOf(s, tab.id)) return { kind: "tab", tabId: tab.id };
  }
  if (line.agentId !== null) {
    const agent = s.agents[line.agentId as AgentId];
    if (agent?.kind === "subagent") return { kind: "agent", agentId: agent.id };
    if (agent && tabs.some((t) => t.ref.kind === "agent-terminal" && t.ref.agentId === agent.id)) {
      return { kind: "agent", agentId: agent.id };
    }
  }
  return null;
}

/** Why a source label is not a link — the tooltip on the plain-text label. */
export function unavailableReason(line: LineRef): string {
  if (line.terminalId !== null) return "That terminal is closed — there is no tab to focus";
  if (line.agentId !== null) return "That agent is no longer open — there is no tab to focus";
  return "Not tied to a terminal or agent";
}

/** Focus the line's tab. Returns false when there is nothing left to focus. */
export function focusLogSource(line: LineRef): boolean {
  const st = useAppStore.getState();
  const target = focusTargetFor(line, st);
  if (!target) return false;
  if (target.kind === "agent") {
    st.agentActions.selectAgent(target.agentId);
    return true;
  }
  const view = viewOf(st, target.tabId) as ViewSnapshot;
  if (view.id !== st.activeViewId) st.layoutActions.activateView(view.id);
  const now = useAppStore.getState();
  const leaf = leafOfTab(now.layout, target.tabId) as LeafNode;
  now.layoutActions.setActiveTab(leaf.id, target.tabId);
  return true;
}

/**
 * A dev app's "Restart in the IDE" succeeded: Rust has opened a PTY with this
 * id, so bring it to the front. When a tab already holds it (a fleet snapshot got there
 * first), that tab is focused — the line-focus rule above. Otherwise a tab is made for it
 * through `rebuildTerminalTabs`, the store's one "adopt a live PTY" path: it REATTACHES (the
 * registry replays scrollback via `terminal_reattach`), never re-opens, and is idempotent, so a
 * snapshot racing this cannot mint a second tab. Returns whether a tab ended up focused.
 */
export function focusTerminalTab(terminalId: string, title: string, cwd: string | null): boolean {
  const line = { terminalId, agentId: null };
  if (focusLogSource(line)) return true;
  useAppStore.getState().layoutActions.rebuildTerminalTabs([
    { id: terminalId as TerminalId, kind: "terminal", title, cwd: cwd ?? "", cols: 80, rows: 24, status: "live" },
  ]);
  return focusLogSource(line);
}

/**
 * A dev app card's "connections →": the Network tab, in Whole Mac mode, with
 * that pid's row selected and expanded (`machineStore.revealMachinePid` — found by pid, since
 * the sampler's key is `<process name>:<pid>` and a dev app is named after its project).
 */
export function showConnectionsOf(pid: number): void {
  setNetworkMode("machine");
  revealMachinePid(pid);
  useAppStore.getState().layoutActions.openNetworkTab();
}

/**
 * An IDE app card's "requests →": the Network tab in IDE traffic, every other
 * narrowing undone, the Process picker on exactly the app's process name — `showAppFlows`, the
 * capture guide's "show them", so the link cannot land on a table a leftover pick hides.
 */
export function showRequestsOf(processName: string): void {
  showAppFlows([processName]);
  useAppStore.getState().layoutActions.openNetworkTab();
}

/**
 * What an `ide-terminal` console calls its terminal: the title its tab shows
 * right now — an agent terminal's is its agent's (custom name first, the rail rule), a plain
 * terminal's is its own custom name, else the derived title. Null when no tab holds it.
 */
export function terminalTitleOf(terminalId: string, s: Pick<AppStore, "tabs" | "agents">): string | null {
  for (const t of Object.values(s.tabs)) {
    if (t.ref.kind === "agent-terminal" && t.ref.terminalId === terminalId) {
      const agent = s.agents[t.ref.agentId];
      return agent?.customTitle ?? agent?.title ?? t.title;
    }
    if (t.ref.kind === "terminal" && t.ref.terminalId === terminalId) return t.customTitle ?? t.title;
  }
  return null;
}
