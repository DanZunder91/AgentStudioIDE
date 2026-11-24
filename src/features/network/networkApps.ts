/**
 * Network ↔ dev apps: the IDE-traffic sidebar lists the same by-language
 * Apps as the Logs sidebar (`procs/DevAppsSection`), the user picks apps one by one, and each
 * row says whether that app's HTTP can reach this view at all (the capture guard — an agent can run
 * `gazelle` with every proxy variable stripped, and the view must say so). Pure: every function
 * here is a function of the flows, the picks and Rust's `procs_list`.
 *
 * ── Which flows are an app's ({@link flowInApp}) ──
 * 1. The flow's client pid IS the app's pid — the proxy resolved the socket to that process.
 * 2. Otherwise, by executable name (`processNameOf` — netcap's `client_name`), but only for a
 *    client pid that no LISTED app owns: that keeps an app's flows after it exits or restarts
 *    (the old pid is gone), while two `node` apps in two repos stay apart (each owns its pid).
 *
 * DECIDED: "the app's pid tree" is the app's own pid. `procs_list` does not send children
 * (a launcher like `cargo run` is already collapsed into the binary it runs, which is the
 * process that opens the sockets), and a child with another executable — a `curl` a script
 * runs — is its own process in the Process picker. Widening this needs Rust to send the tree.
 *
 * ── A pick is a snapshot ({@link AppPick}) ──
 * The selection keeps what matching needs (pid + process name), not just the key, so a picked
 * app that exits keeps showing its flows instead of hiding everything.
 */

import { processNameOf } from "../procs/procsFormat";
import type { DevApp, DevRuntime } from "../procs/procsTypes";
import type { FlowPredicate } from "./networkFilter";
import type { FlowSummary } from "./networkTypes";

export interface AppPick {
  /** `DevApp.key`. */
  key: string;
  /** Null for a container (no host pid: only the name rule can match it). */
  pid: number | null;
  /** The display name, for a picked app that is no longer listed. */
  name: string;
  /** `processNameOf(app)` — the client name its flows carry. */
  process: string | null;
}

export function pickOf(app: DevApp): AppPick {
  return { key: app.key, pid: app.pid, name: app.name, process: processNameOf(app) };
}

/** The pids the listed apps own — a client pid in here belongs to THAT app, never by name to another. */
export function listedPids(apps: readonly DevApp[]): Set<number> {
  const out = new Set<number>();
  for (const a of apps) if (a.pid !== null) out.add(a.pid);
  return out;
}

/** Is `f` one of `pick`'s flows (module doc)? */
export function flowInApp(f: Pick<FlowSummary, "client">, pick: AppPick, owned: ReadonlySet<number>): boolean {
  if (f.client === null) return false;
  if (pick.pid !== null && f.client.pid === pick.pid) return true;
  if (owned.has(f.client.pid)) return false;
  return pick.process !== null && f.client.name === pick.process;
}

/** The app picker's predicate — null (inactive) on "All apps". */
export function appPredicate(selection: readonly AppPick[] | null, apps: readonly DevApp[]): FlowPredicate {
  if (selection === null) return null;
  const owned = listedPids(apps);
  return (f) => selection.some((p) => flowInApp(f, p, owned));
}

/** How many of `flows` are `app`'s. */
export function appFlowCount(flows: readonly Pick<FlowSummary, "client">[], app: DevApp, apps: readonly DevApp[]): number {
  const pick = pickOf(app);
  const owned = listedPids(apps);
  let n = 0;
  for (const f of flows) if (flowInApp(f, pick, owned)) n += 1;
  return n;
}

/**
 * One row's capture state:
 * - `captured` — its flows are arriving, or Rust verified its env points at the proxy;
 * - `uncaptured` — an IDE app whose env does not (Rust's `captured === false`) and nothing of
 *   it has arrived: its HTTP cannot show here — offer Restart with capture;
 * - `external` — started outside the IDE, nothing arrived: point it at the proxy by hand
 *   (Whole Mac's "Capture this app" guide);
 * - `unknown` — an IDE app whose env the OS hides, or the IDE injects no proxy.
 * Arrived flows win: they are proof, whatever the env said.
 */
export type CaptureState = "captured" | "uncaptured" | "external" | "unknown";

export function captureState(app: Pick<DevApp, "origin" | "captured">, flowsSeen: number): CaptureState {
  if (flowsSeen > 0 || app.captured === true) return "captured";
  if (app.origin === "external") return "external";
  return app.captured === false ? "uncaptured" : "unknown";
}

/* ── the words ─────────────────────────────────────────────────────────────── */

export function notCapturedText(name: string): string {
  return `${name} was started without the IDE's proxy — its launcher removed the proxy variables, so its HTTP calls can't reach Network.`;
}

export function receivingText(name: string, count: number): string {
  return count > 0 ? `✓ Receiving ${name}'s requests — ${count} so far` : `✓ Captured — no requests from ${name} yet`;
}

/** Where an IDE app's requests show — named exactly, so the user knows which picker to look at. */
export function whereText(source: string, process: string | null): string {
  return `They appear under IDE traffic, Source ${source}, Process ${process ?? "unknown"}.`;
}

export const RUST_GO_CAVEAT =
  "Most Rust and Go apps use a built-in certificate list and ignore the IDE's CA — their HTTPS shows as host, timing and size, not contents.";

/** The runtimes {@link RUST_GO_CAVEAT} is about. */
export function ignoresIdeCa(runtime: DevRuntime): boolean {
  return runtime === "rust" || runtime === "go";
}

export const LIVE_CONNS_TITLE = "Right now — its live connections";
/** Before the first sample — the sampler named as the Network toggle names its view ("Whole computer" off macOS). */
export function liveConnsWaiting(viewName: string): string {
  return `Waiting for the ${viewName} sampler…`;
}
export const LIVE_CONNS_NONE = "No open connections right now.";
