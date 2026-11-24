/**
 * The dev-apps store — the list Rust polls, the app the user selected, the log streams this UI
 * started, and the Restart-in-the-IDE flow.
 *
 * Its own feature-local `create(...)`. Everything a user does here lives in it rather than in
 * component state, because the Logs panel is a TAB and remounts on every switch:
 * a restart confirm, a stream error or the selected app must survive that.
 *
 * ── Polling runs only while something is on screen ──
 * `procs_list` walks every process's fds, so it costs CPU. Views hold it with
 * {@link acquireProcs} on mount and let go with {@link releaseProcs} on unmount (or just call
 * {@link useProcsPolling}). The stop is DEFERRED one macrotask and cancelled by a re-acquire, so
 * React StrictMode's mount → unmount → mount (and a tab move's remount) keeps exactly one
 * interval — the Network view's `machineStore` pattern. A tick that lands while the previous
 * `procs_list` is still in flight is skipped, so a slow scan never stacks calls. A failure is not
 * sticky: the next tick tries again and a success clears the error.
 *
 * ── Streams ──
 * Only streams started FROM HERE are tracked; Rust's key comes back with the tail and is the only
 * handle Stop uses. A stream outlives its app's row on purpose: a file tail keeps working after
 * the process that wrote it exits, and the Logs view keeps showing it as a source of its own.
 */

import { useEffect } from "react";
import { create } from "zustand";

import { streamId } from "./procsFormat";
import { pickLogFile, procsList, restartInIde, restartPrepare, tailApp, tailDocker, untail } from "./procsIpc";
import { PROCS_POLL_MS, type DevApp, type DevRuntime, type ProcsList } from "./procsTypes";

export interface ActiveStream {
  /** {@link streamId}: the app key + the path (or `docker`). */
  id: string;
  appKey: string;
  /** Null = the container's `docker logs`. */
  path: string | null;
  /** Rust's tail key — what `logstream_untail` takes. */
  key: string;
  /** The `source` its LogLines carry. */
  source: string;
}

export type RestartPhase = "confirm" | "running" | "failed";

export interface RestartState {
  appKey: string;
  phase: RestartPhase;
  /** Set only in `failed`. */
  error: string | null;
}

export interface ProcsState {
  list: ProcsList | null;
  listError: string | null;
  /** When the last successful `procs_list` landed — the card's clock for "uptime". */
  polledAtMs: number | null;
  selectedKey: string | null;
  streams: ActiveStream[];
  /** Stream ids whose tail/untail is in flight. */
  busy: string[];
  /** The last stream error per app key, shown inline on its card. */
  streamErrors: Record<string, string>;
  /** At most one restart at a time — it SIGTERMs a process. */
  restart: RestartState | null;
  /**
   * The Apps group's runtime sections the user opened or closed. Absent = the default: open
   * while it has apps, closed while empty ({@link runtimeSectionOpen}). Here, not in component
   * state, so a tab switch keeps it.
   */
  runtimeOpen: Partial<Record<DevRuntime, boolean>>;
}

const initial = (): ProcsState => ({
  list: null,
  listError: null,
  polledAtMs: null,
  selectedKey: null,
  streams: [],
  busy: [],
  streamErrors: {},
  restart: null,
  runtimeOpen: {},
});

export const useProcsStore = create<ProcsState>()(initial);

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ── polling ───────────────────────────────────────────────────────────────── */

let holders = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/** One `procs_list` now. Skipped while the previous one is still running. */
export async function pollProcsOnce(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const list = await procsList();
    // A reply that is not a list (a build without the command answering `undefined`) is an
    // error, not a crash of the Logs sidebar that mounts this section.
    if (typeof list !== "object" || list === null || !Array.isArray(list.apps)) throw new Error("procs_list returned no list");
    useProcsStore.setState({ list, listError: null, polledAtMs: Date.now() });
  } catch (e) {
    useProcsStore.setState({ listError: msg(e) });
  } finally {
    inFlight = false;
  }
}

/** A dev-apps view mounted: poll now, then every {@link PROCS_POLL_MS}, while anyone holds it. */
export function acquireProcs(): void {
  holders += 1;
  if (stopTimer !== null) {
    // A remount inside the grace period: polling never stopped, so do not restart it.
    clearTimeout(stopTimer);
    stopTimer = null;
    return;
  }
  if (holders !== 1) return;
  void pollProcsOnce();
  pollTimer = setInterval(() => void pollProcsOnce(), PROCS_POLL_MS);
}

/** The view unmounted: stop after one macrotask unless something re-acquires first. */
export function releaseProcs(): void {
  holders -= 1;
  if (holders > 0) return;
  stopTimer = setTimeout(() => {
    stopTimer = null;
    stopPolling();
  }, 0);
}

function stopPolling(): void {
  // `clearInterval(undefined)` is a no-op — the reset seam calls this with no interval running.
  clearInterval(pollTimer ?? undefined);
  pollTimer = null;
}

/** Hold the poll for this component's lifetime. */
export function useProcsPolling(): void {
  useEffect(() => {
    acquireProcs();
    return releaseProcs;
  }, []);
}

/* ── selection ─────────────────────────────────────────────────────────────── */

export function selectDevApp(key: string | null): void {
  useProcsStore.setState({ selectedKey: key });
}

/** The selected app as of the latest poll — null when nothing is selected or it has exited. */
export function selectedDevApp(s: ProcsState): DevApp | null {
  return s.list?.apps.find((a) => a.key === s.selectedKey) ?? null;
}

/** Hook form of {@link selectedDevApp}, for the host's card mount point. */
export function useSelectedDevApp(): DevApp | null {
  return useProcsStore(selectedDevApp);
}

/* ── the Apps group's runtime sections ────────────────────────────────────── */

/** Is `runtime`'s section open: the user's choice, else open exactly while it has apps. */
export function runtimeSectionOpen(s: Pick<ProcsState, "runtimeOpen">, runtime: DevRuntime, count: number): boolean {
  return s.runtimeOpen[runtime] ?? count > 0;
}

/** A section heading's click: flip what it shows NOW (so the first click on a default flips it). */
export function toggleRuntimeSection(runtime: DevRuntime, count: number): void {
  useProcsStore.setState((s) => ({ runtimeOpen: { ...s.runtimeOpen, [runtime]: !runtimeSectionOpen(s, runtime, count) } }));
}

/* ── streams ───────────────────────────────────────────────────────────────── */

export function streamsOf(s: ProcsState, appKey: string): ActiveStream[] {
  return s.streams.filter((x) => x.appKey === appKey);
}

/**
 * Start one stream: `path` = a file of `app`'s (tailed by pid), null = its container's logs.
 * Resolves to the new stream's `source`, or null when it did not start (already streaming, in
 * flight, nothing to tail, or Rust refused — the error is then on the card).
 */
export async function startStream(app: DevApp, path: string | null): Promise<string | null> {
  const id = streamId(app.key, path);
  const s = useProcsStore.getState();
  if (s.busy.includes(id) || s.streams.some((x) => x.id === id)) return null;
  // The card only offers what can be tailed, so these are the "Rust sent a shape the card
  // did not expect" guard: a file needs a pid to name, docker needs a container id.
  const target = path === null ? app.containerId : app.pid;
  if (target === null) return null;
  useProcsStore.setState({ busy: [...s.busy, id] });
  try {
    const started = path === null ? await tailDocker(app.containerId as string) : await tailApp(app.pid as number, path);
    useProcsStore.setState((st) => {
      const { [app.key]: _cleared, ...streamErrors } = st.streamErrors;
      return {
        busy: st.busy.filter((b) => b !== id),
        streams: [...st.streams, { id, appKey: app.key, path, key: started.key, source: started.source }],
        streamErrors,
      };
    });
    return started.source;
  } catch (e) {
    useProcsStore.setState((st) => ({
      busy: st.busy.filter((b) => b !== id),
      streamErrors: { ...st.streamErrors, [app.key]: `Could not stream: ${msg(e)}` },
    }));
    return null;
  }
}

/** Stop a stream this UI started. */
export async function stopStream(id: string): Promise<void> {
  const s = useProcsStore.getState();
  const stream = s.streams.find((x) => x.id === id);
  if (stream === undefined || s.busy.includes(id)) return;
  useProcsStore.setState({ busy: [...s.busy, id] });
  try {
    // `false` (the tail had already ended on its own) is a stop too: nothing tails it now.
    await untail(stream.key);
    useProcsStore.setState((st) => ({
      busy: st.busy.filter((b) => b !== id),
      streams: st.streams.filter((x) => x.id !== id),
    }));
  } catch (e) {
    useProcsStore.setState((st) => ({
      busy: st.busy.filter((b) => b !== id),
      streamErrors: { ...st.streamErrors, [stream.appKey]: `Could not stop: ${msg(e)}` },
    }));
  }
}

/** "Pick a log file…": Rust's dialog, then tail what was picked. Null when cancelled or failed. */
export async function pickAndStream(app: DevApp): Promise<string | null> {
  let path: string | null;
  try {
    path = await pickLogFile();
  } catch (e) {
    useProcsStore.setState((st) => ({ streamErrors: { ...st.streamErrors, [app.key]: `Could not pick a file: ${msg(e)}` } }));
    return null;
  }
  if (path === null) return null;
  return startStream(app, path);
}

export function dismissStreamError(appKey: string): void {
  useProcsStore.setState((st) => {
    const { [appKey]: _gone, ...streamErrors } = st.streamErrors;
    return { streamErrors };
  });
}

/* ── restart in the IDE ────────────────────────────────────────────────────── */

/** Open the confirm for `appKey`. Refused while another restart is running. */
export function requestRestart(appKey: string): void {
  useProcsStore.setState((s) => (s.restart?.phase === "running" ? {} : { restart: { appKey, phase: "confirm", error: null } }));
}

/** Cancel the confirm (or dismiss a failure). A running restart cannot be cancelled from here. */
export function cancelRestart(): void {
  useProcsStore.setState((s) => (s.restart?.phase === "running" ? {} : { restart: null }));
}

/**
 * The user confirmed: prepare (Rust re-reads the pid and mints a token), then restart. Resolves
 * to the new terminal's id, or null on failure (the error is then on the card).
 *
 * DECIDED — pid reuse: the confirm named what the LAST POLL saw, up to 3 s old. If the pid has
 * since been reused by another program, `prepare`'s summary names that program, and we stop
 * there — the token is never spent, so nothing is SIGTERMed that the user did not confirm.
 */
export async function confirmRestart(app: DevApp): Promise<string | null> {
  const r = useProcsStore.getState().restart;
  if (r === null || r.appKey !== app.key || r.phase !== "confirm" || app.pid === null) return null;
  useProcsStore.setState({ restart: { appKey: app.key, phase: "running", error: null } });
  const fail = (error: string): null => {
    useProcsStore.setState({ restart: { appKey: app.key, phase: "failed", error } });
    return null;
  };
  try {
    const prepared = await restartPrepare(app.pid);
    if (prepared.summary.name !== app.name) {
      return fail(`pid ${app.pid} is now ${prepared.summary.name}, not ${app.name} — nothing was stopped.`);
    }
    const { terminalId } = await restartInIde(prepared.token);
    useProcsStore.setState({ restart: null });
    return terminalId;
  } catch (e) {
    return fail(`Could not restart: ${msg(e)}`);
  }
}

/** Test seam: forget everything, including the poll and any pending stop. */
export function resetProcsStore(): void {
  holders = 0;
  inFlight = false;
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  stopPolling();
  useProcsStore.setState(initial(), true);
}
