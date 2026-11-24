/**
 * Tear-off wiring for each kind of window — the composition-root half of
 * docs/design/tab-tearoff.md. Plumbing, like `bridge.ts`: listeners and subscriptions that
 * hand each thing to `handoff.ts`, where the decisions live.
 *
 * ── The main window (`startTearoffHost`) ──────────────────────────────────────
 * Claims its mailbox (tabs coming home), keeps the holdings cache, routes the close of a
 * terminal another window holds to that window, and turns a rail click on an agent held
 * elsewhere into "bring that window forward" — as it does an open of a file or singleton
 * another window already shows (the store's open router). It also keeps what only it can
 * keep for the tabs it lent out: the layout file still lists the agents held elsewhere,
 * with their names, and a rename on either side reaches the other (`renamed` mail).
 *
 * ── A detached window (`startTearoffWindow`) ──────────────────────────────────
 * A minimal shell: NO layout prefs (it never loads them, and `saveLayoutPrefs` refuses
 * outside the main window), NO app-wide pollers (usage, git, metrics belong to the rails it
 * does not render; diskWatch runs, but over this window's own editors only — a partition,
 * not a duplicate), and NO terminal rebuild from the fleet snapshot (that would steal every
 * terminal in the app). What it does run:
 *   - a fleet MIRROR — the snapshot's agents plus `agent://event` — so agent tabs show their
 *     names and the Village has its villagers;
 *   - its mailbox: the first claim recovers what Rust says it holds (a page reload), and
 *     adopts its pending mail (the tabs it was opened for);
 *   - a holdings REPORT whenever its tabs change or an editor is edited (debounced), which is
 *     what Rust re-homes to the main window if this window dies without saying goodbye;
 *   - the close handshake: on `tearoff://closing`, every tab — unsaved text and undo stack
 *     included — goes to the main window, then the window closes itself;
 *   - closing itself when its last tab leaves (Chrome's behaviour), and telling the main
 *     window when an agent's tab was closed for good here, so its rail row and pin go too;
 *   - telling the main window when an agent is renamed here, since only the main window
 *     writes names to disk.
 *
 * Listeners that are addressed to ONE window are registered with this window's label as
 * the target. A JS listener on the default `Any` target receives every `emit_to`, whatever
 * label it names (tauri `event/listener.rs` `match_any_or_filter`) — so without the target,
 * every window would answer every doorbell.
 */

import { listen, type EventTarget } from "@tauri-apps/api/event";

import { onEditorEdit } from "../../features/editor/EditorRegistry";
import { fleetSnapshot, defaultWorkspace } from "../../features/fleet/fleetIpc";
import { setRemoteDisposer } from "../../features/terminal/TerminalRegistry";
import { AGENT_EVENT, onTerminalSideOf } from "../bridge";
import {
  onAgentSelected,
  persistLayoutNow,
  provideHeldElsewhere,
  routeOpensElsewhere,
  useAppStore,
} from "../store";
import type { AgentEvent, AgentId, AgentNode, Tab, TabId, TerminalId } from "../types";
import { TERMINAL_KEY, type Holding } from "./contract";
import {
  describeAll,
  drainMail,
  findTabByKey,
  isOpeningHere,
  isRemoteRename,
  movesSettled,
  openHere,
} from "./handoff";
import {
  CLOSING_EVENT,
  HOLDINGS_EVENT,
  MAIL_EVENT,
  tearoffClose,
  tearoffHoldings,
  tearoffReport,
  tearoffSend,
} from "./ipc";
import { currentWindowLabel, isMainWindow, MAIN_WINDOW } from "./windowRole";

/** Shared swallow for best-effort sends. */
const noop = (): void => {};

/* ─────────────────────────────── holdings ─────────────────────────────── */

/** key → the detached window holding it. Replaced wholesale on every broadcast. */
let heldBy = new Map<string, string>();

/** Replace the holdings cache (a broadcast, or the boot read). */
export function setHoldings(holdings: readonly Holding[]): void {
  const next = new Map<string, string>();
  for (const h of holdings) for (const key of h.keys) next.set(key, h.label);
  heldBy = next;
}

/** Which detached window holds `key`, if any — `null` means the main window (or nobody). */
export function holderOf(key: string): string | null {
  return heldBy.get(key) ?? null;
}

/** The terminal ids detached windows hold, sorted — the store's `heldElsewhere` provider. */
export function heldTerminals(): string[] {
  return [...heldBy.keys()]
    .filter((key) => key.startsWith(TERMINAL_KEY))
    .map((key) => key.slice(TERMINAL_KEY.length))
    .sort();
}

/**
 * The main window's holdings update: replace the cache, and re-save the layout when the set
 * of terminals held elsewhere changed — the file lists those agents (with their names) for
 * as long as they are away, so it must hear when one leaves or comes back.
 */
export function syncHoldings(holdings: readonly Holding[]): void {
  const before = heldTerminals().join("\n");
  setHoldings(holdings);
  if (heldTerminals().join("\n") !== before) persistLayoutNow();
}

/* ────────────────────────── routing to the holder ────────────────────────── */

/**
 * The window to bring forward for an agent selected here, or `null` when its terminal is
 * in this window (or nowhere). From a detached window, "not held by any detached window"
 * means the main window has it.
 */
export function windowShowing(agentId: AgentId): string | null {
  const s = useAppStore.getState();
  // A sub-agent has no PTY anywhere: `selectAgent` has just opened (or found) its activity
  // tab HERE, and raising another window over it would take the focus it was just given.
  if (s.agents[agentId]?.kind === "subagent") return null;
  const key = `${TERMINAL_KEY}${agentId}`;
  if (findTabByKey(s.tabs, key) || hasTabFor(s.tabs, agentId)) return null;
  const holder = holderOf(key) ?? (isMainWindow() ? null : MAIN_WINDOW);
  return holder === currentWindowLabel() ? null : holder;
}

/** Does this window show any tab of `agentId` (its terminal, or an activity view of it)? */
function hasTabFor(tabs: Record<TabId, Tab>, agentId: AgentId): boolean {
  return Object.values(tabs).some((t) => "agentId" in t.ref && t.ref.agentId === agentId);
}

/** `onAgentSelected` hook: an agent whose terminal is elsewhere brings that window forward. */
export function forwardSelection(agentId: AgentId): void {
  const to = windowShowing(agentId);
  if (to) void tearoffSend(to, { t: "focus", key: `${TERMINAL_KEY}${agentId}` }).catch(noop);
}

/**
 * `TerminalRegistry.setRemoteDisposer`: the close of a terminal this window has never shown
 * goes to the detached window holding it (the rail ✕ on an agent moved to another window).
 * The user already confirmed in this window, so that window closes it without asking.
 */
export function disposeRemote(terminalId: TerminalId): boolean {
  const key = `${TERMINAL_KEY}${terminalId}`;
  const holder = holderOf(key);
  if (!holder || holder === currentWindowLabel()) return false;
  void tearoffSend(holder, { t: "close", key }).catch(noop);
  return true;
}

/**
 * The store's open router (`routeOpensElsewhere`): a tab another window holds is brought
 * forward there instead of opened again here. Never while this window is adopting a tab
 * (the holdings broadcast can trail the mail that brings it), and if the holder turns out
 * to be gone, the tab opens here after all — a click must never do nothing.
 */
export function routeOpen(key: string, fallback: () => void): boolean {
  if (isOpeningHere()) return false;
  const holder = holderOf(key);
  if (!holder || holder === currentWindowLabel()) return false;
  void tearoffSend(holder, { t: "focus", key }).catch(() => openHere(fallback));
  return true;
}

/** The agents whose custom name changed between two snapshots of the fleet. */
export function renamedAgents(
  agents: Record<AgentId, AgentNode>,
  prev: Record<AgentId, AgentNode>,
): Array<{ agentId: AgentId; name: string | null }> {
  const out: Array<{ agentId: AgentId; name: string | null }> = [];
  for (const [id, agent] of Object.entries(agents) as Array<[AgentId, AgentNode]>) {
    const before = prev[id];
    const name = agent.customTitle ?? null;
    if (before && (before.customTitle ?? null) !== name) out.push({ agentId: id, name });
  }
  return out;
}

/* ───────────────────────────── the main window ───────────────────────────── */

/**
 * Wire tear-off into the main window. Run AFTER `startBridge` settles: adopting a tab is a
 * `rebuildTerminalTabs`, and one run before the boot restore has placed the persisted
 * layout would consume `pendingRestore` and dump every restored terminal in one pane.
 */
export async function startTearoffHost(): Promise<() => void> {
  const target: EventTarget = { kind: "WebviewWindow", label: MAIN_WINDOW };
  setRemoteDisposer(disposeRemote);
  const offs = [
    onAgentSelected(forwardSelection),
    routeOpensElsewhere(routeOpen),
    provideHeldElsewhere(heldTerminals),
    // A rename on the main rail of an agent another window shows: that tab says it too.
    // One that came from that window is not sent back to it.
    useAppStore.subscribe(
      (s) => s.agents,
      (agents, prev) => {
        if (isRemoteRename()) return;
        for (const { agentId, name } of renamedAgents(agents, prev)) {
          const holder = holderOf(`${TERMINAL_KEY}${agentId}`);
          if (holder) void tearoffSend(holder, { t: "renamed", agentId, name }).catch(noop);
        }
      },
    ),
  ];
  await listen<Holding[]>(HOLDINGS_EVENT, (e) => syncHoldings(e.payload));
  await listen<string>(MAIL_EVENT, (e) => {
    if (e.payload === MAIN_WINDOW) void drainMail(false);
  }, { target });
  syncHoldings(await tearoffHoldings());
  // Anything posted while this page was loading — a detached window that closed during a
  // reload, say. The main window holds nothing in Rust's ledger, so `recover` adopts none.
  await drainMail(false);
  return () => {
    for (const off of offs) off();
  };
}

/* ──────────────────────────── a detached window ──────────────────────────── */

/** Debounce for the holdings report: one IPC per burst of typing, not per keystroke. */
export const REPORT_DEBOUNCE_MS = 250;

let reportTimer: ReturnType<typeof setTimeout> | null = null;
/** The running `watchDetachedWindow`'s unsubscribe, so a closing window can silence it. */
let stopWatching: (() => void) | null = null;

/**
 * Stop reporting: cancel a pending report and the watcher that schedules them. Once the
 * hand-back is posted, Rust has already released this window's tabs — a report landing
 * after it would put them all back in the ledger, and the destroy path would then post them
 * to the main window a second time (resurrecting any the user closed there meanwhile).
 */
function quiesce(): void {
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = null;
  stopWatching?.();
}

/** Send this window's holdings now (and cancel a pending debounced one). */
export function reportNow(): void {
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = null;
  void tearoffReport(describeAll({ history: false }));
}

/** Send this window's holdings after the debounce. */
export function scheduleReport(): void {
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = setTimeout(reportNow, REPORT_DEBOUNCE_MS);
}

/**
 * The close handshake: every tab, fully described, to the main window — then close. If the
 * send fails, close anyway: Rust re-homes this window's last report when it is destroyed,
 * so the terminals still come home (only the newest unsaved keystrokes are at risk).
 */
export async function handBackAndClose(): Promise<void> {
  quiesce();
  const tabs = describeAll({ history: true });
  try {
    if (tabs.length > 0) await tearoffSend(MAIN_WINDOW, { t: "adopt", tabs });
  } catch {
    /* re-homed from the last report by the destroy path */
  }
  await tearoffClose().catch(noop);
}

/**
 * Mirror the fleet: the snapshot's agents, then live telemetry, in bridge.ts's order.
 * Each event also reaches this window's terminals (`onTerminalSideOf`): a killed agent
 * whose tab lives HERE must un-stick here — the main window's registry has no entry for it.
 */
async function startFleetMirror(): Promise<void> {
  const { agentActions } = useAppStore.getState();
  let ready = false;
  const pending: AgentEvent[] = [];
  const apply = (event: AgentEvent): void => {
    agentActions.applyAgentEvent(event);
    onTerminalSideOf(event);
  };
  await listen<AgentEvent>(AGENT_EVENT, (e) => {
    if (ready) apply(e.payload);
    else pending.push(e.payload);
  });
  try {
    agentActions.applyFleetSnapshot((await fleetSnapshot()).agents);
  } catch {
    /* live events still describe the fleet */
  } finally {
    ready = true;
    for (const event of pending) apply(event);
    pending.length = 0;
  }
}

const isEmpty = (): boolean => Object.keys(useAppStore.getState().tabs).length === 0;

/**
 * Close this window if it is (still) empty once every move in flight has landed — a move
 * that failed puts its tab back, and the window must still be here to show it.
 */
export async function closeIfEmpty(): Promise<void> {
  await movesSettled();
  if (!isEmpty()) return;
  quiesce();
  await tearoffClose().catch(noop);
}

/**
 * React to this window's own store: report holdings when the tabs change, tell the main
 * window when an agent was closed for good here, and close the window once it is empty.
 * Returns the unsubscribe.
 */
export function watchDetachedWindow(): () => void {
  const offTabs = useAppStore.subscribe(
    (s) => s.tabs,
    () => {
      if (isEmpty()) void closeIfEmpty();
      else scheduleReport();
    },
  );
  // An agent leaves this window's mirror only through a removal — `closeTab` on its tab,
  // or a `close` posted from the main rail — never through a move (`releaseTab` leaves the
  // fleet alone). So a vanished agent is a dismissal, and the main window's rail and pin
  // registry must hear of it. A redundant one (the main window started it) is a no-op there.
  //
  // A rename here goes to the main window too — the only one that writes names to disk —
  // unless the main window sent it; and either way the next report carries it, so a re-home
  // after a crash brings back the newest name rather than the one the tab arrived with.
  const offAgents = useAppStore.subscribe(
    (s) => s.agents,
    (agents, prev) => {
      for (const id of Object.keys(prev)) {
        if (!(id in agents)) void tearoffSend(MAIN_WINDOW, { t: "dismissed", agentId: id }).catch(noop);
      }
      const renamed = renamedAgents(agents, prev);
      if (renamed.length === 0) return;
      scheduleReport();
      if (isRemoteRename()) return;
      for (const { agentId, name } of renamed) {
        void tearoffSend(MAIN_WINDOW, { t: "renamed", agentId, name }).catch(noop);
      }
    },
  );
  const offEdits = onEditorEdit(scheduleReport);
  const stop = (): void => {
    offTabs();
    offAgents();
    offEdits();
    if (stopWatching === stop) stopWatching = null;
  };
  stopWatching = stop;
  return stop;
}

/**
 * Boot a detached window. See the module header for what runs and what never does.
 * Resolves the watcher's unsubscribe (a no-op when the window closed at once) — the page
 * never calls it, its realm's end is the teardown; tests do.
 */
export async function startTearoffWindow(): Promise<() => void> {
  const label = currentWindowLabel();
  const target: EventTarget = { kind: "WebviewWindow", label };
  setRemoteDisposer(disposeRemote);
  onAgentSelected(forwardSelection);
  // Routes to OTHER detached windows only: the main window's tabs are not in the ledger.
  routeOpensElsewhere(routeOpen);
  // A "+" terminal opened here starts where the main window's would.
  void defaultWorkspace()
    .then((root) => useAppStore.getState().workspaceActions.setWorkspaceRoot(root))
    .catch(noop);
  await startFleetMirror();
  await listen<Holding[]>(HOLDINGS_EVENT, (e) => setHoldings(e.payload));
  await listen<string>(MAIL_EVENT, (e) => {
    if (e.payload === label) void drainMail(false);
  }, { target });
  await listen(CLOSING_EVENT, () => void handBackAndClose(), { target });
  setHoldings(await tearoffHoldings());
  await drainMail(true);
  // Opened for tabs that never arrived (their mail was lost): nothing to show, so go.
  if (isEmpty()) {
    await tearoffClose().catch(noop);
    return noop;
  }
  const stop = watchDetachedWindow();
  reportNow();
  return stop;
}
