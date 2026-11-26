/** Tear-off wiring per window kind (docs/design/tab-tearoff.md); decisions live in `handoff.ts`.
 * A detached window runs NO layout prefs, app-wide pollers or terminal rebuild from the snapshot.
 * One-window listeners target this window's label: an `Any` listener hears every `emit_to`. */

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

/** Replace the holdings cache; re-save the layout when the set of terminals held elsewhere
 * changes (the file lists those agents, with names, while they are away). */
export function syncHoldings(holdings: readonly Holding[]): void {
  const before = heldTerminals().join("\n");
  setHoldings(holdings);
  if (heldTerminals().join("\n") !== before) persistLayoutNow();
}

/* ────────────────────────── routing to the holder ────────────────────────── */

/** Window to bring forward for an agent selected here, or `null` if its terminal is here (or
 * nowhere). From a detached window, "held by no detached window" means the main window. */
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

/** `TerminalRegistry.setRemoteDisposer`: closing a terminal held by a detached window is sent to
 * it, which closes without asking (the user already confirmed here). */
export function disposeRemote(terminalId: TerminalId): boolean {
  const key = `${TERMINAL_KEY}${terminalId}`;
  const holder = holderOf(key);
  if (!holder || holder === currentWindowLabel()) return false;
  void tearoffSend(holder, { t: "close", key }).catch(noop);
  return true;
}

/** Open router (`routeOpensElsewhere`): bring a tab held elsewhere forward. Never while adopting
 * (holdings can trail the mail); if the holder is gone it opens here (a click never no-ops). */
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

/** Wire tear-off into the main window. Run AFTER `startBridge` settles: an earlier adoption's
 * `rebuildTerminalTabs` eats `pendingRestore` and dumps all restored terminals in one pane. */
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

/** Stop reporting. After the hand-back Rust has released this window's tabs; a later report would
 * re-add them, and the destroy path would post them to main twice (resurrecting closed ones). */
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

/** Close handshake: every tab, fully described, to the main window, then close. Close even if
 * the send fails: Rust re-homes this window's last report (only the newest keystrokes at risk). */
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

/** Mirror the fleet (snapshot, then telemetry, in bridge.ts's order). Events also reach this
 * window's terminals (`onTerminalSideOf`): the main registry has no entry for tabs living HERE. */
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

/** Close if still empty once moves in flight land: a failed move puts its tab back here. */
export async function closeIfEmpty(): Promise<void> {
  await movesSettled();
  if (!isEmpty()) return;
  quiesce();
  await tearoffClose().catch(noop);
}

/** Report holdings when tabs change, tell main when an agent closed for good here, close once
 * empty. Returns the unsubscribe. */
export function watchDetachedWindow(): () => void {
  const offTabs = useAppStore.subscribe(
    (s) => s.tabs,
    () => {
      if (isEmpty()) void closeIfEmpty();
      else scheduleReport();
    },
  );
  // A vanished agent is a dismissal (moves never remove it), so main's rail and pin registry hear
  // of it. Renames go to main too (the only disk writer) unless main sent them; every report
  // carries the name so a crash re-home brings back the newest one.
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

/** Boot a detached window (see the module header). Resolves the watcher's unsubscribe; only
 * tests call it, the page's teardown is its realm ending. */
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
