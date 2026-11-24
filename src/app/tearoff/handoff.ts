/**
 * The hand-off — a tab leaves this window, a tab arrives (docs/design/tab-tearoff.md).
 *
 * Leaving is three steps, in this order, and the order is the design:
 *   1. DESCRIBE the tab (`describeTab`): everything another realm needs to rebuild it —
 *      for an editor that includes the unsaved text and the undo stack;
 *   2. RELEASE it here (`releaseTab`): out of the layout WITHOUT closing it, and this
 *      window's view of it torn down WITHOUT killing anything — `TerminalRegistry.abandon`
 *      leaves the PTY running, `EditorRegistry.abandon` drops the buffer this window held,
 *      so the window the tab went to is the only live writer for that file;
 *   3. SEND the description (`tearoff_open` for a new window, `tearoff_send` for an
 *      existing one). If that fails the tab is ADOPTED straight back, exactly as a returning
 *      tab would be — one rehydration path, never two.
 *
 * Releasing BEFORE sending is deliberate: by the time the other window re-attaches a
 * terminal, nothing here can still push a resize at it.
 *
 * Arriving (`adoptTornTabs`) goes through the store's own open paths — a terminal through
 * `rebuildTerminalTabs`, which configures it to REATTACH (same PTY, ring replayed,
 * TUI repainted), never to spawn. Every arrival is idempotent by `tabKey`, because a detached
 * window's first claim can return the same tab twice (once as held, once as mail).
 */

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

/**
 * Describe `tabId` for another window, or `null` for a kind that cannot move (or an unknown
 * id). `history: false` is the periodic holdings report — text only, no undo stack.
 *
 * The switch is the authority on what can move; `TEAROFF_KINDS` mirrors it for the menu,
 * and a test pins the two together.
 */
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

/**
 * Take `tabId` out of this window without closing it: the layout forgets it, and this
 * window's view of the terminal / buffer is torn down without killing the PTY. `torn` is
 * the description taken BEFORE this call (the buffer cannot be read after it).
 */
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

/**
 * Bring `tabId` to the front: switch to the view holding it, then make it its pane's active
 * tab (and that pane the focused one). A no-op for a tab this window does not hold.
 */
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

/**
 * Run `open` with the store's open router out of the way (`routeOpensElsewhere`): a tab
 * arriving here must land here, even if the holdings cache — a broadcast that can trail the
 * mail by a moment — still says another window holds it. Also how a routed open falls back
 * when the window it was routed to turns out to be gone.
 */
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

/**
 * Rehydrate described tabs into this window, skipping any already here (by `tabKey`), and
 * bring the last one to the front — it is the one the user just moved. Returns the tab ids,
 * existing or new, in order.
 */
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

/**
 * An editor tab arrived for a file this window already has open — a duplicate the open
 * router could not prevent (it was opened from a window that cannot see where the file is
 * held, or the holdings cache trailed). One path is one tab here, so the arriving buffer
 * is folded into the one already open, and neither copy of unsaved text is lost:
 *  - nothing unsaved arrived (still loading, or `text === baseline`): the tab here stays;
 *  - the same text is already here: nothing to do;
 *  - otherwise the arriving text is applied to the tab here as an ordinary edit
 *    (`applyCarriedText`), so whatever this window had stays one Cmd/Ctrl+Z away — and if
 *    that was itself unsaved, the diagnostics log says so.
 */
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

/**
 * Resolves once every move under way has settled. A detached window whose last tab just
 * left waits on this before closing itself: closing first would race the send, and a failed
 * send re-adopts the tab — into a window that must still be there to show it.
 */
export function movesSettled(): Promise<void> {
  return Promise.allSettled([...inFlight]).then(() => undefined);
}

/**
 * Mark a move as under way and get the call that ends it. Begun BEFORE the tab is released:
 * releasing is what empties a window, and whoever reacts to that (closeIfEmpty) must already
 * see this move in flight — registering at the send would be one step too late.
 */
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

/**
 * Move `tabId` into a NEW window — the "Move to New Window" command, and a tab dragged out
 * and released outside its window (`at` = where). Resolves whether it moved; a tab that
 * could not leave is back where it was, and the reason is in the diagnostics log.
 */
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

/**
 * Claim this window's mail and act on it. `recover` (boot only) also adopts the tabs Rust
 * says this window holds — how a detached window gets them back after its page reloads.
 * NOT on a doorbell: a tab closed here a moment ago can still be in Rust's copy until the
 * next report lands, and adopting it would resurrect it.
 */
export async function drainMail(recover: boolean): Promise<void> {
  try {
    const claim = await tearoffClaim();
    if (recover) adoptTornTabs(claim.tabs);
    for (const mail of claim.mail) handleMail(mail);
  } catch (err) {
    logWarn("tearoff", "Could not collect this window's tabs", String(err));
  }
}
