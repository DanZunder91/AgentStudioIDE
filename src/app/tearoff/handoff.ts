/** Tab hand-off (docs/design/tab-tearoff.md): DESCRIBE, RELEASE (PTY lives; receiver is the only
 * writer), then SEND, so nothing here resizes it after re-attach; failure re-adopts. Arrivals are
 * idempotent by `tabKey`: a detached window's first claim can return a tab twice (held + mail). */

import {
  abandon as abandonEditor,
  applyCarriedText,
  exportEditor,
  seedEditor,
} from "../../features/editor/EditorRegistry";
import { logWarn } from "../../features/logs/logStore";
import { abandon as abandonTerminal } from "../../features/terminal/TerminalRegistry";
import { leafOfTab, useAppStore, viewTabIds } from "../store";
import { asAgentId, asTabId, asTerminalId, type AgentId, type Tab, type TabId } from "../types";
import { tabKey, type Mail, type ScreenPoint, type TornTab } from "./contract";
import { tearoffClaim, tearoffOpen, tearoffSend } from "./ipc";
import { MAIN_WINDOW } from "./windowRole";

const state = () => useAppStore.getState();

/* ─────────────────────────────── describing ─────────────────────────────── */

/** Describe `tabId` for another window, or `null` if it cannot move. `history: false` (holdings
 * report) skips the undo stack. The switch rules; `TEAROFF_KINDS` mirrors it (tested). */
export function describeTab(tabId: TabId, opts: { history: boolean } = { history: true }): TornTab | null {
  const s = state();
  const tab = s.tabs[tabId];
  if (!tab) return null;
  const ref = tab.ref;
  switch (ref.kind) {
    case "terminal":
      return {
        kind: "terminal",
        terminalId: ref.terminalId,
        title: tab.title,
        customTitle: tab.customTitle ?? null,
      };
    case "agent-terminal":
      return {
        kind: "agent-terminal",
        terminalId: ref.terminalId,
        agentId: ref.agentId,
        title: tab.title,
        // One name per agent, and it lives on the agent (types.ts `Tab.customTitle`). The
        // tab's own field is the fallback `adoptOne` parks a name in when the agent row had
        // not arrived yet, so a name is never dropped on a round trip.
        customTitle: s.agents[ref.agentId]?.customTitle ?? tab.customTitle ?? null,
      };
    case "editor":
      return {
        kind: "editor",
        path: ref.path,
        title: tab.title,
        customTitle: tab.customTitle ?? null,
        buffer: exportEditor(ref.path, opts),
      };
    case "diff":
      return { kind: "diff", path: ref.path, title: tab.title };
    case "metrics":
      return { kind: "metrics", cwd: ref.cwd };
    case "agent-logs":
      return { kind: "agent-logs" };
    case "network":
      return { kind: "network" };
    case "village":
      return { kind: "village" };
    default:
      return null;
  }
}

/** Every tab in this window, in on-screen order (each view's panes, left to right). */
export function orderedTabIds(): TabId[] {
  const s = state();
  return s.views.flatMap((view) => viewTabIds(s, view.id));
}

/** Describe every tab here that can move — the hand-back on close, and the holdings report. */
export function describeAll(opts: { history: boolean }): TornTab[] {
  return orderedTabIds().flatMap((id) => {
    const torn = describeTab(id, opts);
    return torn ? [torn] : [];
  });
}

/* ─────────────────────────────── releasing ──────────────────────────────── */

/** Take `tabId` out of this window without closing it or killing the PTY. `torn` must be
 * described BEFORE this call (the buffer cannot be read after it). */
export function releaseTab(tabId: TabId, torn: TornTab): void {
  state().layoutActions.releaseTab(tabId);
  if (torn.kind === "terminal" || torn.kind === "agent-terminal") {
    abandonTerminal(asTerminalId(torn.terminalId));
  } else if (torn.kind === "editor") {
    abandonEditor(torn.path);
  }
}

/* ──────────────────────────────── arriving ──────────────────────────────── */

/** The tab here whose identity is `key`, if this window holds one. */
export function findTabByKey(tabs: Record<TabId, Tab>, key: string): TabId | null {
  for (const tab of Object.values(tabs)) {
    if (tabKey(tab.ref) === key) return tab.id;
  }
  return null;
}

/** Switch to the view holding `tabId`, make it the focused pane's active tab; no-op if absent. */
export function revealTab(tabId: TabId): void {
  const s = state();
  const view = s.views.find((v) => viewTabIds(s, v.id).includes(tabId));
  if (!view) return;
  if (view.id !== s.activeViewId) s.layoutActions.activateView(view.id);
  const after = state();
  // Non-null: the view holding the tab is the live one now, so its tree has the tab.
  const leaf = leafOfTab(after.layout, tabId)!;
  after.layoutActions.setActiveTab(leaf.id, tabId);
}

/** >0 while this window is opening tabs it must show HERE (see `openHere`). */
let openingHere = 0;

/** Run `open` with the open router bypassed: an arriving tab lands here even if the (trailing)
 * holdings cache says otherwise. Also the fallback when a routed-to window is gone. */
export function openHere<T>(open: () => T): T {
  openingHere += 1;
  try {
    return open();
  } finally {
    openingHere -= 1;
  }
}

/** Is an `openHere` running? (the router's bypass) */
export function isOpeningHere(): boolean {
  return openingHere > 0;
}

/** Rehydrate tabs, skipping any here already (by `tabKey`), and front the last (the one just
 * moved). Returns the tab ids, existing or new, in order. */
export function adoptTornTabs(tabs: readonly TornTab[]): TabId[] {
  const ids = openHere(() => tabs.map(adoptOne));
  const last = ids[ids.length - 1];
  if (last) revealTab(last);
  return ids;
}

function adoptOne(torn: TornTab): TabId {
  const key = tabKey(torn);
  const existing = findTabByKey(state().tabs, key);
  if (existing) {
    // A terminal or a singleton already here is the same thing twice; an editor is two
    // buffers that may disagree, and the arriving one may be the only copy of some edits.
    if (torn.kind === "editor") foldIntoOpenEditor(torn);
    return existing;
  }
  const { layoutActions, editorActions } = state();
  switch (torn.kind) {
    case "terminal":
    case "agent-terminal": {
      const agentId = torn.kind === "agent-terminal" ? asAgentId(torn.agentId) : undefined;
      // The reattach path, not a spawn: `rebuildTerminalTabs` configures the registry with
      // `reattach: true`, so the TerminalView that mounts re-binds the RUNNING process.
      layoutActions.rebuildTerminalTabs([
        {
          id: asTerminalId(torn.terminalId),
          kind: torn.kind,
          title: torn.title,
          cwd: "",
          cols: 0,
          rows: 0,
          status: "live",
          ...(agentId ? { agentId } : {}),
        },
      ]);
      // Non-null: `rebuildTerminalTabs` has just minted it (an existing one returned above).
      const tabId = findTabByKey(state().tabs, key)!;
      applyName(torn, tabId);
      return tabId;
    }
    case "editor": {
      // Seed BEFORE the tab exists, so the CodeEditor that mounts for it finds the carried
      // buffer instead of reading the file (which would drop the unsaved edits).
      if (torn.buffer) seedEditor(torn.path, torn.buffer);
      const tabId = layoutActions.openEditorTab(torn.path);
      if (torn.buffer) editorActions.setEditorDirty(torn.path, torn.buffer.text !== torn.buffer.baseline);
      applyName(torn, tabId);
      return tabId;
    }
    case "diff":
      return layoutActions.openDiffTab(torn.path);
    case "metrics":
      return layoutActions.openMetricsTab(torn.cwd);
    case "agent-logs":
      return layoutActions.openAgentLogsTab();
    case "network":
      return layoutActions.openNetworkTab();
    case "village":
      return layoutActions.openVillageTab();
  }
}

/** An editor arrived for a file already open here (one path, one tab): keep ours if nothing
 * unsaved arrived or the text matches; else apply it via `applyCarriedText` so ours stays one
 * undo away (logged if ours was unsaved too). */
function foldIntoOpenEditor(torn: Extract<TornTab, { kind: "editor" }>): void {
  const incoming = torn.buffer;
  if (!incoming || incoming.text === incoming.baseline) return;
  const here = exportEditor(torn.path, { history: false });
  if (here?.text === incoming.text) return;
  if (here && here.text !== here.baseline) {
    logWarn(
      "tearoff",
      `Two unsaved copies of ${torn.path} met — the one that just arrived is shown`,
      "Undo (Cmd/Ctrl+Z) in that tab brings back the text this window had",
    );
  }
  void applyCarriedText(torn.path, incoming.text);
}

/** Carry a tab's custom name across: on the agent for an agent tab, on the tab otherwise. */
function applyName(torn: Extract<TornTab, { customTitle: string | null }>, tabId: TabId): void {
  const name = torn.customTitle;
  const s = state();
  if (torn.kind !== "agent-terminal") {
    if (name) s.layoutActions.renameTab(tabId, name);
    return;
  }
  const agentId = asAgentId(torn.agentId);
  const agent = s.agents[agentId];
  if (agent) {
    if ((agent.customTitle ?? null) !== name) s.agentActions.renameAgent(agentId, name);
    return;
  }
  // No agent row to carry the name (the fleet mirror has not delivered it): show it on the
  // tab, and park it in the tab's own field so the next move still carries it.
  if (name) {
    useAppStore.setState((d) => {
      d.tabs[tabId].title = name;
      d.tabs[tabId].customTitle = name;
    });
  }
}

/* ───────────────────────────────── moving ───────────────────────────────── */

/** Moves under way: released here, their send not yet settled. */
const inFlight = new Set<Promise<void>>();

/** Resolves once every move under way settles; an emptied window waits on it before closing,
 * as a failed send re-adopts the tab into it. */
export function movesSettled(): Promise<void> {
  return Promise.allSettled([...inFlight]).then(() => undefined);
}

/** Mark a move under way; returns its end call. Begun BEFORE release, since releasing empties
 * the window and closeIfEmpty must already see the move. */
function beginMove(): () => void {
  let end!: () => void;
  const settled = new Promise<void>((resolve) => (end = resolve));
  inFlight.add(settled);
  return () => {
    inFlight.delete(settled);
    end();
  };
}

/** Release `torn` here, run `send`, and take the tab back if the send fails. */
async function move(tabId: TabId, torn: TornTab, send: () => Promise<unknown>, failure: string): Promise<boolean> {
  const done = beginMove();
  try {
    releaseTab(tabId, torn);
    await send();
    return true;
  } catch (err) {
    adoptTornTabs([torn]);
    logWarn("tearoff", failure, String(err));
    return false;
  } finally {
    done();
  }
}

/** Move `tabId` into a NEW window (menu command, or dragged out and dropped at `at`). Resolves
 * whether it moved; on failure the tab is back and the reason is in the diagnostics log. */
export async function moveTabToNewWindow(tabId: TabId, at: ScreenPoint | null = null): Promise<boolean> {
  const torn = describeTab(tabId);
  if (!torn) return false;
  return move(tabId, torn, () => tearoffOpen([torn], at), "Could not open a new window — the tab stayed here");
}

/** Move `tabId` into the existing window `to` (the main one, for "Move to Main Window"). */
export async function moveTabToWindow(tabId: TabId, to: string): Promise<boolean> {
  const torn = describeTab(tabId);
  if (!torn) return false;
  return move(
    tabId,
    torn,
    () => tearoffSend(to, { t: "adopt", tabs: [torn] }),
    `Could not move the tab to ${to} — it stayed here`,
  );
}

/** "Move to Main Window" — from a detached window. */
export function moveTabToMainWindow(tabId: TabId): Promise<boolean> {
  return moveTabToWindow(tabId, MAIN_WINDOW);
}

/* ────────────────────────────────── mail ────────────────────────────────── */

/** Act on one message from another window. */
export function handleMail(mail: Mail): void {
  const s = state();
  switch (mail.t) {
    case "adopt":
      adoptTornTabs(mail.tabs);
      return;
    case "focus": {
      const tabId = findTabByKey(s.tabs, mail.key);
      if (tabId) revealTab(tabId);
      return;
    }
    case "close": {
      // Already confirmed in the window that sent it (the rail's busy-terminal gate), so the
      // primitive, never `requestCloseTab` — asking twice is a bug, not caution.
      const tabId = findTabByKey(s.tabs, mail.key);
      if (tabId) s.layoutActions.closeTab(tabId);
      return;
    }
    case "dismissed":
      // The tab was closed for good in a detached window: the rail row and the pin go too,
      // exactly as if it had been closed here. Its PTY is already gone.
      s.agentActions.removeAgent(asAgentId(mail.agentId));
      return;
    case "give":
      // One of our tabs was dropped on another window. A stale id (the tab moved or closed
      // since the drag began) describes nothing, and `moveTabToWindow` does nothing with it.
      void moveTabToWindow(asTabId(mail.tabId), mail.to);
      return;
    case "renamed":
      applyRemoteRename(asAgentId(mail.agentId), mail.name);
      return;
  }
}

/** >0 while a rename that came FROM another window is being applied (see `isRemoteRename`). */
let remoteRename = 0;

/** Apply another window's rename of an agent — an unknown agent is nobody's to name here. */
function applyRemoteRename(agentId: AgentId, name: string | null): void {
  const s = state();
  if (!s.agents[agentId]) return;
  remoteRename += 1;
  try {
    s.agentActions.renameAgent(agentId, name);
  } finally {
    remoteRename -= 1;
  }
}

/** Is the rename happening now one another window sent? Its watcher must not echo it back. */
export function isRemoteRename(): boolean {
  return remoteRename > 0;
}

/** Claim and act on this window's mail. `recover` (boot only) also adopts what Rust says we hold
 * (page reload); never on a doorbell, where it could resurrect a just-closed tab. */
export async function drainMail(recover: boolean): Promise<void> {
  try {
    const claim = await tearoffClaim();
    if (recover) adoptTornTabs(claim.tabs);
    for (const mail of claim.mail) handleMail(mail);
  } catch (err) {
    logWarn("tearoff", "Could not collect this window's tabs", String(err));
  }
}
