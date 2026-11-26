/** Pure glue: Logs sources (`agentLogsRunning.ts`) × Rust's dev apps (`src/features/procs/`).
 * `app` sources sit under the app claiming them by name prefix (longest wins); a Service whose
 * tailed file IS an app's console belongs to it by PATH, never by name (launchers `execve`). */

import { devAppForSource } from "../procs/procsFormat";
import type { ActiveStream } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import type { ServicePaths } from "./agentLogsLinks";
import type { RunningSource } from "./agentLogsRunning";
import type { LogLine } from "./agentLogsTypes";

const NO_PATHS: ServicePaths = new Map();

export interface AppSourcePlacement {
  /** App key → the `app` sources it claims, in the order given (the sidebar's order). */
  byApp: ReadonlyMap<string, RunningSource[]>;
  /** `app` sources no listed app claims — each shown as a row of its own. */
  unclaimed: RunningSource[];
  /** Service (`task`) source → the app whose console it tails (by path). */
  serviceOwners: ReadonlyMap<string, DevApp>;
  /** Keys of the apps with a RUNNING stream here — an `app` tail or the Service on their console. */
  liveKeys: ReadonlySet<string>;
}

/** An app's console files: stdout/stderr (a `log`-kind file is one it opened, not its output). */
export function consolePaths(app: Pick<DevApp, "logFiles">): string[] {
  return app.logFiles.filter((f) => f.kind !== "log").map((f) => f.path);
}

/** The app whose console a Service tails (exact path), or null. On ties the first listed wins:
 * Rust lists the IDE's own apps first. */
export function appForService(source: string, apps: readonly DevApp[], paths: ServicePaths): DevApp | null {
  const tailed = new Set<string>();
  for (const [path, src] of paths) if (src === source) tailed.add(path);
  if (tailed.size === 0) return null;
  return apps.find((a) => consolePaths(a).some((p) => tailed.has(p))) ?? null;
}

/** The Service sources whose tailed file is `app`'s console, in the order their paths were seen. */
export function serviceSourcesOf(app: Pick<DevApp, "logFiles">, paths: ServicePaths): string[] {
  const out: string[] = [];
  for (const p of consolePaths(app)) {
    const src = paths.get(p);
    if (src !== undefined && !out.includes(src)) out.push(src);
  }
  return out;
}

/** Split `app` sources between claiming apps (name prefix) and orphans; name the owner of every
 * Service whose tailed file is an app's console (path). */
export function placeAppSources(
  sources: readonly RunningSource[],
  apps: readonly DevApp[],
  paths: ServicePaths = NO_PATHS,
): AppSourcePlacement {
  const byApp = new Map<string, RunningSource[]>();
  const unclaimed: RunningSource[] = [];
  const serviceOwners = new Map<string, DevApp>();
  const liveKeys = new Set<string>();
  for (const s of sources) {
    const owner = s.kind === "task" ? appForService(s.source, apps, paths) : s.kind === "app" ? devAppForSource(s.source, apps) : null;
    if (s.kind === "app" && owner === null) unclaimed.push(s);
    if (owner === null) continue;
    if (s.running) liveKeys.add(owner.key);
    if (s.kind === "task") {
      serviceOwners.set(s.source, owner);
      continue;
    }
    const list = byApp.get(owner.key) ?? [];
    list.push(s);
    byApp.set(owner.key, list);
  }
  return { byApp, unclaimed, serviceOwners, liveKeys };
}

/** Row label under its app: the part after `<name> · `; the full name if the prefix is missing
 * (a label must never be empty). */
export function streamLabel(source: string, app: Pick<DevApp, "name">): string {
  const prefix = `${app.name} · `;
  const rest = source.startsWith(prefix) ? source.slice(prefix.length) : "";
  return rest === "" ? source : rest;
}

/** Is `source` `app`'s: a tail started for it here, named after it, or its console's Service. */
export function isAppSource(
  source: string,
  app: Pick<DevApp, "key" | "logFiles">,
  streams: readonly ActiveStream[],
  apps: readonly DevApp[],
  paths: ServicePaths = NO_PATHS,
): boolean {
  if (streams.some((x) => x.appKey === app.key && x.source === source)) return true;
  if (serviceSourcesOf(app, paths).includes(source)) return true;
  return devAppForSource(source, apps)?.key === app.key;
}

/** What `app`'s row solos: its console Service first (its log, running or not), its tails, and
 * every RUNNING `app` source it claims (survives a window reload). Empty → "Pick a log" card. */
export function appSoloSources(
  app: DevApp,
  streams: readonly ActiveStream[],
  running: readonly RunningSource[],
  apps: readonly DevApp[],
  paths: ServicePaths = NO_PATHS,
): string[] {
  const out = serviceSourcesOf(app, paths);
  for (const x of streams) if (x.appKey === app.key && !out.includes(x.source)) out.push(x.source);
  for (const s of running) {
    if (s.kind !== "app" || !s.running || out.includes(s.source)) continue;
    if (devAppForSource(s.source, apps)?.key === app.key) out.push(s.source);
  }
  return out;
}

/** Keep `app` selected only if every picked source is the app's (empty = its "nothing streams
 * yet" state); `null` (All) deselects it. */
export function pickKeepsApp(
  only: readonly string[] | null,
  app: Pick<DevApp, "key" | "logFiles">,
  streams: readonly ActiveStream[],
  apps: readonly DevApp[],
  paths: ServicePaths = NO_PATHS,
): boolean {
  if (only === null) return false;
  return only.every((s) => isAppSource(s, app, streams, apps, paths));
}

/* ── an agent's running apps ─────────────────────────────────────────────── */

/** Source label → agent id of its first line. A root agent and its terminal share a label and
 * the root's id (`DevApp.agentId`): the join between an Agents row and that agent's apps. */
export function agentIdsBySource(lines: readonly Pick<LogLine, "source" | "agentId">[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) if (l.agentId !== null && !out.has(l.source)) out.set(l.source, l.agentId);
  return out;
}

/** The apps the IDE started for `agentId`, in Rust's order. */
export function appsOfAgent(agentId: string | null | undefined, apps: readonly DevApp[]): DevApp[] {
  if (agentId === null || agentId === undefined) return [];
  return apps.filter((a) => a.origin === "ide" && a.agentId === agentId);
}

/** `1 app` / `2 apps`. */
export function appCountLabel(n: number): string {
  return `${n} ${n === 1 ? "app" : "apps"}`;
}

/* ── the Apps group's "All apps" row ─────────────────────────────────────── */

/** Every app stream: each listed app's {@link appSoloSources} in list order, then orphan `app`
 * streams; no duplicates. */
export function allAppSources(
  apps: readonly DevApp[],
  streams: readonly ActiveStream[],
  running: readonly RunningSource[],
  paths: ServicePaths,
  unclaimed: readonly RunningSource[],
): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    if (!out.includes(s)) out.push(s);
  };
  for (const a of apps) appSoloSources(a, streams, running, apps, paths).forEach(add);
  for (const u of unclaimed) add(u.source);
  return out;
}

/** Is the pick exactly `sources` (as a set, order aside)? The All apps row's pressed state. */
export function isExactPick(only: readonly string[] | null, sources: readonly string[]): boolean {
  if (only === null || sources.length === 0 || only.length !== sources.length) return false;
  return sources.every((s) => only.includes(s));
}

/** Sidebar label of whoever launched an IDE app: its agent's source, else its terminal's, read
 * from the lines (null until one names it). A renamed terminal uses its live title (as its row). */
export function launcherLabelOf(
  app: Pick<DevApp, "origin" | "agentId" | "terminalId">,
  lines: readonly Pick<LogLine, "agentId" | "terminalId" | "source" | "kind">[],
  renamed: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (app.origin !== "ide") return null;
  if (app.agentId !== null) {
    const a = lines.find((l) => l.agentId === app.agentId && l.kind !== "task" && l.kind !== "app");
    if (a) return a.source;
  }
  if (app.terminalId !== null) {
    const t = lines.find(
      (l) => l.terminalId === app.terminalId && l.agentId === null && (l.kind === "output" || l.kind === "system"),
    );
    if (t) return renamed.get(t.source) ?? t.source;
  }
  return null;
}
