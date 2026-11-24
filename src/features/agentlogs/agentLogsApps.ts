/**
 * Agent Logs × dev apps on this machine — the pure glue
 * between the Logs sources (derived from the lines, `agentLogsRunning.ts`) and the dev apps
 * Rust lists (`src/features/procs/`). No React, no IPC.
 *
 * A dev app's stream logs as `kind: "app"` with `source` `<name> · <file>` / `<name> · docker`.
 * The sidebar places each such source UNDER the app that claims it
 * (`devAppForSource` — the name prefix, longest name wins), so the streams started from an app
 * appear under it like services. A source no listed app claims (its app exited; a
 * file tail outlives the process that wrote it) is a row of its own in the same group.
 *
 * **An Apps row IS its log stream.** A Service (a
 * background task an agent started) whose tailed file IS an app's stdout/stderr — Claude's
 * `…/tasks/<id>.output`, the file its `run_in_background` redirects to — belongs to that app.
 * The match is by PATH, never by the service's name: a typical service is
 * `python3 · bg` (the launcher `python3 run_server.py …`, which `execve`d
 * `./target/debug/gazelle`), so only the path can put `gazelle` on it. Such a service stays in
 * the Services group (the flat list stays alongside) but is LABELLED with the app's
 * name, and it is what a click on the app solos — raw gazelle lines, no agent command blocks.
 * Clicking either row selects the app and solos that stream, so both rows read as selected.
 *
 * Selecting an app solos its streams; any OTHER pick (All, a terminal, the toolbar picker, an
 * error badge of another source) deselects the app. What counts as "its" stream is
 * {@link isAppSource}: a tail this UI started for it, or a source named after it.
 */

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

/**
 * The paths an app's CONSOLE goes to: its stdout / stderr files (a `log`-kind file is one it
 * opened, not where it prints — a service tailing that is not "the app's stream").
 */
export function consolePaths(app: Pick<DevApp, "logFiles">): string[] {
  return app.logFiles.filter((f) => f.kind !== "log").map((f) => f.path);
}

/**
 * The listed app whose console a Service source tails (by exact path), or null. When
 * several apps name the path (a parent and a child writing one file), the first listed wins —
 * Rust's order puts the IDE's own apps first, which is the one the user is looking for.
 */
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

/**
 * Split the `app`-kind sources between the apps that claim them (by name prefix) and the
 * orphans; name the owner of every Service whose tailed file is an app's console (by path).
 */
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

/**
 * A stream's row label under its app: the part after `<name> · ` (`server.log`, `docker`) —
 * the app's own row already says whose it is. A source that does not carry the prefix (it
 * cannot, when {@link placeAppSources} put it there, but the label must never be empty) keeps
 * its full name.
 */
export function streamLabel(source: string, app: Pick<DevApp, "name">): string {
  const prefix = `${app.name} · `;
  const rest = source.startsWith(prefix) ? source.slice(prefix.length) : "";
  return rest === "" ? source : rest;
}

/**
 * Is `source` one of `app`'s streams: a tail this UI started for it, a source named after it,
 * or the Service that tails its console.
 */
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

/**
 * What a click on `app`'s row solos: the Service tailing its console (first: it IS the
 * app's log, running or not, since its lines are the app's), every tail started for it here,
 * plus every RUNNING `app` source it claims in the ring (a tail started before a window reload
 * is not in the procs store, but its lines are still arriving). Empty when it streams nothing
 * — the panel then shows the card with "Pick a log to stream".
 */
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

/**
 * Should a new source pick keep `app` selected? Only when every source it shows is one of the
 * app's (an empty pick is the app's own "nothing streams yet" state). `null` = All: not the app.
 */
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

/**
 * Source label → the agent id its lines carry (the first one seen). A root agent's row and its
 * terminal share one label, and their lines carry the root's id, which is what `DevApp.agentId`
 * names — so this is the join between an Agents row and the apps that agent started.
 */
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

/**
 * Every app stream at once: what each listed app's click would solo ({@link appSoloSources}, in
 * the list's order), then the orphan `app` streams whose app has exited — no duplicates. Empty
 * when no app streams anything.
 */
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

/**
 * The sidebar's own label for whoever launched an IDE app: its agent's source (`claude · gazelle`)
 * when Rust names an agent, else its terminal's (`bash · workspace`). Read from the lines, because
 * the source label IS the sidebar row's name. Null when no line has named it yet. A terminal the
 * user renamed (`renamed`, `agentLogsTitles.renamedTerminalLabels`) is named by its live title
 * (`by gazelle`), exactly as its Terminals row reads.
 */
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
