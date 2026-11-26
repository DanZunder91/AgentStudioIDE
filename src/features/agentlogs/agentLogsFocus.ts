/** "Take me there" from a log row's source label: its TERMINAL tab (switching view if needed),
 * else its agent via `selectAgent` (a root only while its terminal tab exists, or it links
 * nowhere), else nothing: the label is plain text with a title saying why. */

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

/** After "Restart in the IDE": focus the tab holding the new PTY, or adopt it via
 * `rebuildTerminalTabs` (REATTACHES, idempotent, so a racing snapshot can't mint a second tab).
 * Returns whether a tab ended up focused. */
export function focusTerminalTab(terminalId: string, title: string, cwd: string | null): boolean {
  const line = { terminalId, agentId: null };
  if (focusLogSource(line)) return true;
  useAppStore.getState().layoutActions.rebuildTerminalTabs([
    { id: terminalId as TerminalId, kind: "terminal", title, cwd: cwd ?? "", cols: 80, rows: 24, status: "live" },
  ]);
  return focusLogSource(line);
}

/** "connections →": Network tab, Whole Mac mode, the pid's row revealed
 * (`machineStore.revealMachinePid`; by pid, since the sampler key is `<process name>:<pid>`). */
export function showConnectionsOf(pid: number): void {
  setNetworkMode("machine");
  revealMachinePid(pid);
  useAppStore.getState().layoutActions.openNetworkTab();
}

/** "requests →": Network in IDE traffic via `showAppFlows`, every other narrowing undone so no
 * leftover pick hides the app's process. */
export function showRequestsOf(processName: string): void {
  showAppFlows([processName]);
  useAppStore.getState().layoutActions.openNetworkTab();
}

/** The title an `ide-terminal` console's tab shows now (agent terminal: its agent's name, custom
 * first; plain: custom, else derived). Null when no tab holds it. */
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
