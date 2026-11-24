/**
 * The WHOLE-COMPUTER store — every app's sockets, one full sample per second.
 *
 * Its own `create(...)`, not the app store, and every choice the user makes here — sort,
 * selection, filter, Hide listeners, expanded apps, pause — lives in it rather than in
 * component state, because the Network panel is a TAB and remounts on every switch.
 *
 * ── Sampling runs only while the mode is on screen ──
 * `nettop` / `/proc` sampling costs CPU every second, so the view holds it with
 * {@link acquireMachine} on mount and lets go with {@link releaseMachine} on unmount.
 * The stop is DEFERRED one macrotask and cancelled by a re-acquire, so React StrictMode's
 * mount → unmount → mount (and a tab move's remount) sends exactly one `netmachine_start`
 * and no stop. Leaving the mode for real sends exactly one `netmachine_stop`.
 *
 * ── Listen first, then start ──
 * The event subscription is made before `netmachine_start`, so the first sample is never
 * emitted into a gap. It stays for the app's life (samples only flow while running). A
 * failed subscription or start is not sticky: the next entry tries again.
 */

import { create } from "zustand";

import { defaultDir, type MachineSort, type MachineSortKey } from "./machineFormat";
import { listenSamples, netmachineStart, netmachineStatus, netmachineStop } from "./netmachineIpc";
import type { MachineSample, MachineStatus } from "./networkTypes";

export interface MachineState {
  status: MachineStatus | null;
  statusError: string | null;
  /** The newest sample received. */
  latest: MachineSample | null;
  paused: boolean;
  /** What the table shows while paused. */
  frozen: MachineSample | null;
  sort: MachineSort;
  /** App NAMES; null = all apps (AppPicker's contract). */
  selection: string[] | null;
  filter: string;
  hideListeners: boolean;
  /** Expanded app keys (`name:pid`). */
  expanded: string[];
  /** The keyboard cursor (an app key). */
  selectedKey: string | null;
  /** The app key whose "Capture this app" guide is open; at most one. */
  guideKey: string | null;
  /**
   * A pid {@link revealMachinePid} asked for that no sample has shown yet: the first sample
   * that has it selects + expands its row, then this goes back to null.
   */
  pendingPid: number | null;
  /** Open the pending pid's "Capture this app" guide when its row is found (Network's Apps sidebar). */
  pendingGuide: boolean;
}

const initial = (): MachineState => ({
  status: null,
  statusError: null,
  latest: null,
  paused: false,
  frozen: null,
  sort: { key: "rateIn", dir: "desc" },
  selection: null,
  filter: "",
  hideListeners: true,
  expanded: [],
  selectedKey: null,
  guideKey: null,
  pendingPid: null,
  pendingGuide: false,
});

export const useMachineStore = create<MachineState>()(initial);

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The sample the table shows: frozen while paused, else the newest. */
export function displayedSample(s: MachineState): MachineSample | null {
  return s.paused ? s.frozen : s.latest;
}

/** One `netmachine://sample` — a full replacement, never a merge. */
export function receiveSample(sample: MachineSample): void {
  useMachineStore.setState((s) => ({ latest: sample, ...revealIn(s, sample) }));
}

/** The pending pid's row in `sample`, selected and expanded — or no change while it is absent. */
function revealIn(s: MachineState, sample: MachineSample | null): Partial<MachineState> {
  if (s.pendingPid === null || sample === null) return {};
  const app = sample.apps.find((a) => a.pid === s.pendingPid);
  if (app === undefined) return {};
  return {
    pendingPid: null,
    pendingGuide: false,
    selectedKey: app.key,
    expanded: s.expanded.includes(app.key) ? s.expanded : [...s.expanded, app.key],
    ...(s.pendingGuide ? { guideKey: app.key } : {}),
  };
}

/* ── lifecycle ─────────────────────────────────────────────────────────────── */

let listening: Promise<boolean> | null = null;
let unlisten: (() => void) | null = null;
let holders = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let statusLoad: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** How often the open view re-reads the status, so a sampler that dies is SAID, not frozen. */
export const MACHINE_STATUS_POLL_MS = 2_000;

function startPolling(): void {
  // Pinned by the contract seam test: Rust records a dead nettop in
  // `netmachine_status` but emits nothing, so without this the table froze on the last
  // sample with no explanation. Same cadence as the Logs view's `syslog_status` poll.
  pollTimer = setInterval(() => {
    netmachineStatus().then(
      (status) => useMachineStore.setState({ status, statusError: null }),
      (e: unknown) => useMachineStore.setState({ statusError: msg(e) }),
    );
  }, MACHINE_STATUS_POLL_MS);
}

function stopPolling(): void {
  // `clearInterval(null)` is a no-op, so no guard is needed.
  clearInterval(pollTimer ?? undefined);
  pollTimer = null;
}

function ensureListening(): Promise<boolean> {
  if (listening) return listening;
  listening = listenSamples(receiveSample).then(
    (un) => {
      unlisten = un;
      return true;
    },
    (e: unknown) => {
      listening = null;
      useMachineStore.setState({ statusError: msg(e) });
      return false;
    },
  );
  return listening;
}

async function startSampling(): Promise<void> {
  if (!(await ensureListening())) return;
  try {
    const status = await netmachineStart();
    useMachineStore.setState({ status, statusError: null });
  } catch (e) {
    useMachineStore.setState({ statusError: msg(e) });
  }
}

async function stopSampling(): Promise<void> {
  // A live sample left behind would greet the next visit with minutes-old rates; a
  // frozen (paused) one is the user's and stays.
  useMachineStore.setState({ latest: null });
  try {
    const status = await netmachineStop();
    useMachineStore.setState({ status, statusError: null });
  } catch (e) {
    useMachineStore.setState({ statusError: msg(e) });
  }
}

/** The Whole-computer view mounted: sample while at least one holder is on screen. */
export function acquireMachine(): void {
  holders += 1;
  if (stopTimer !== null) {
    // A remount inside the grace period: sampling never stopped, so do not restart it.
    clearTimeout(stopTimer);
    stopTimer = null;
    return;
  }
  if (holders === 1) {
    void startSampling();
    startPolling();
  }
}

/** The view unmounted: stop after one macrotask unless something re-acquires first. */
export function releaseMachine(): void {
  holders -= 1;
  if (holders > 0) return;
  stopTimer = setTimeout(() => {
    stopTimer = null;
    stopPolling();
    void stopSampling();
  }, 0);
}

/**
 * Fetch the status once for the mode switch's label ("Whole Mac") before the mode is
 * ever entered. Idempotent while in flight or known; a failure is not sticky.
 */
export function ensureMachineStatus(): Promise<void> {
  if (statusLoad) return statusLoad;
  if (useMachineStore.getState().status !== null) return Promise.resolve();
  statusLoad = netmachineStatus().then(
    (status) => {
      statusLoad = null;
      // A start that landed meanwhile is newer than this read.
      if (useMachineStore.getState().status === null) useMachineStore.setState({ status, statusError: null });
    },
    (e: unknown) => {
      statusLoad = null;
      useMachineStore.setState({ statusError: msg(e) });
    },
  );
  return statusLoad;
}

/* ── view actions ──────────────────────────────────────────────────────────── */

export function setMachinePaused(paused: boolean): void {
  useMachineStore.setState((s) => {
    if (paused === s.paused) return {};
    return paused ? { paused: true, frozen: s.latest } : { paused: false, frozen: null };
  });
}

/** Click a header: a new key starts in its natural direction; the same key flips. */
export function sortBy(key: MachineSortKey): void {
  useMachineStore.setState((s) => ({
    sort:
      s.sort.key === key
        ? { key, dir: s.sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultDir(key) },
  }));
}

export function setMachineSelection(selection: string[] | null): void {
  useMachineStore.setState({ selection });
}

export function setMachineFilter(filter: string): void {
  useMachineStore.setState({ filter });
}

export function setHideListeners(hideListeners: boolean): void {
  useMachineStore.setState({ hideListeners });
}

export function toggleExpanded(key: string): void {
  useMachineStore.setState((s) => ({
    expanded: s.expanded.includes(key) ? s.expanded.filter((k) => k !== key) : [...s.expanded, key],
  }));
}

export function setExpanded(key: string, open: boolean): void {
  useMachineStore.setState((s) => {
    if (s.expanded.includes(key) === open) return {};
    return { expanded: open ? [...s.expanded, key] : s.expanded.filter((k) => k !== key) };
  });
}

export function selectApp(key: string | null): void {
  // The user moved the cursor: a reveal still waiting for its pid must not take it back.
  useMachineStore.setState({ selectedKey: key, pendingPid: null, pendingGuide: false });
}

/**
 * A dev app card's "connections →": put this
 * pid's row in front of the user — selected and expanded. The caller only knows the pid (a
 * dev app is named after its project, `web`; the sampler names the process, `node`), and the
 * row's key is `name:pid`, so the row is found by pid: in the newest sample now, else in the
 * first sample that has it (sampling starts when Whole Mac mounts, so there may be none yet).
 *
 * Every narrowing that could hide the row is undone, as `showAppFlows` does for IDE traffic:
 * the app picker, the text filter, and Hide listeners — a dev server's ports ARE listeners, so
 * leaving it on would land on a table without the very sockets the link was for. Pause is
 * lifted too: a frozen table would never show the row. Switching the panel's MODE is the
 * caller's job (`networkStore.setNetworkMode("machine")`) — this store does not own it.
 * `openGuide` also opens the row's "Capture this app" guide (Network's Apps sidebar, for an
 * external app: "point it at the proxy by hand").
 */
export function revealMachinePid(pid: number, openGuide = false): void {
  useMachineStore.setState((s) => {
    const cleared: MachineState = {
      ...s,
      selection: null,
      filter: "",
      hideListeners: false,
      paused: false,
      frozen: null,
      pendingPid: pid,
      pendingGuide: openGuide,
    };
    return { ...cleared, ...revealIn(cleared, s.latest) };
  });
}

/** Open one app's capture guide (null closes it). Opening it also expands the row it sits under. */
export function setCaptureGuide(key: string | null): void {
  useMachineStore.setState((s) => ({
    guideKey: key,
    expanded: key !== null && !s.expanded.includes(key) ? [...s.expanded, key] : s.expanded,
  }));
}

/** Test seam: forget everything, including the subscription and any pending stop. */
export function resetMachineStore(): void {
  unlisten?.();
  unlisten = null;
  listening = null;
  holders = 0;
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  stopPolling();
  statusLoad = null;
  useMachineStore.setState(initial(), true);
}
