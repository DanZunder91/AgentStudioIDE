/** Network ↔ dev apps, pure over flows, picks and `procs_list`. A flow is an app's by client pid,
 * else by executable name only for a pid no listed app owns (keeps exited apps' flows, keeps two
 * `node` apps apart). An app is its own pid (no children sent); a pick snapshots pid + name. */

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

/** `captured`: flows arrived or Rust verified the env (arrived flows win: they are proof);
 * `uncaptured`: IDE app, env lacks the proxy, nothing arrived; `external`: started outside the
 * IDE, nothing arrived; `unknown`: IDE app whose env the OS hides, or no proxy injected. */
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
