/**
 * Pure helpers for the dev-apps views. No React, no IPC.
 */

import type { DevApp, DevRuntime } from "./procsTypes";

/** The last path segment (either separator — a Linux path or a Windows one). */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  // `split` always yields at least one element; a trailing separator yields "" → keep the path.
  return parts[parts.length - 1] || path;
}

/**
 * The command as one line. 🔴 Renders exactly the argv Rust sent — which Rust already masked —
 * and adds nothing but quotes around an argument containing whitespace, so the line is
 * unambiguous. It never looks anything up, and it never shows env (Rust never sends it).
 */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

/** How long it has been running: `42s`, `7m`, `3h 12m`, `2d 4h`. */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The ports as `:3000 :5173` — at most `max`, then `+N`. */
export function portsLabel(ports: readonly number[], max = 2): string {
  const shown = ports.slice(0, max).map((p) => `:${p}`);
  const rest = ports.length - shown.length;
  return rest > 0 ? `${shown.join(" ")} +${rest}` : shown.join(" ");
}

/**
 * The store's id for one stream of one app: its file path, or `docker` for a container's logs.
 * Not Rust's key (that arrives with the tail) — this one exists before the tail does, so a
 * double click on Stream can be refused while the first one is in flight.
 */
export function streamId(appKey: string, path: string | null): string {
  return `${appKey}\u0000${path ?? "docker"}`;
}

/**
 * The grouping rule for `kind: "app"` log lines: a line's `source` is
 * `<name> · <file>` / `<name> · docker`, so it belongs under the DevApp whose `name` it starts
 * with, followed by ` · `. The separator is part of the match, so `web-admin · x.log` is never
 * claimed by an app named `web`; and when two names both match (`api` and `api · v2`, since a
 * name may itself contain the separator) the LONGEST wins. Null = no listed app claims it
 * (the app exited; the stream is then an orphan the Logs view shows on its own).
 */
export function devAppForSource(source: string, apps: readonly DevApp[]): DevApp | null {
  let best: DevApp | null = null;
  for (const a of apps) {
    if (source.startsWith(`${a.name} · `) && (best === null || a.name.length > best.name.length)) best = a;
  }
  return best;
}

/* ── apps the IDE's own terminals and agents started ──────────────────────── */

/** The sidebar group's title — the top group, **Apps**. */
export const APPS_TITLE = "Apps";

/**
 * The Apps group's sub-sections, one per runtime, in this order (grouped by language or
 * runtime — Rust first; Shell last, it is the least specific). EVERY one
 * is shown, empty or not (every option stays visible).
 */
export const RUNTIME_ORDER: readonly DevRuntime[] = ["rust", "jvm", "node", "python", "go", "docker", "shell"];

/** A sub-section's heading — the runtime AND its toolchain, since the rows carry no badge. */
export const RUNTIME_SECTION_LABELS: Readonly<Record<DevRuntime, string>> = {
  rust: "Rust · Cargo",
  jvm: "JVM",
  node: "Node · JS",
  python: "Python",
  go: "Go",
  docker: "Docker",
  shell: "Shell",
};

export interface RuntimeSection {
  runtime: DevRuntime;
  apps: DevApp[];
}

/**
 * Group the apps by runtime — one entry per {@link RUNTIME_ORDER} runtime, an empty one too. Within a
 * section: the apps with a live log stream first (`isLive`), then the ones the IDE started,
 * then the external ones — and otherwise Rust's order (a stable sort, so Rust's order holds
 * inside each rank). A build that predates `origin` sends none, which ranks as external: that
 * build listed only external apps.
 */
export function groupByRuntime(apps: readonly DevApp[], isLive: (app: DevApp) => boolean = () => false): RuntimeSection[] {
  const rank = (a: DevApp): number => (isLive(a) ? 0 : a.origin === "ide" ? 1 : 2);
  return RUNTIME_ORDER.map((runtime) => ({
    runtime,
    apps: apps.filter((a) => a.runtime === runtime).sort((a, b) => rank(a) - rank(b)),
  }));
}

/**
 * The row's small tag: `by claude · gazelle` for an app the IDE started (who started it — the
 * agent's or terminal's title), `by the IDE` when Rust could not name it, `external` otherwise.
 */
export function originTag(app: Pick<DevApp, "origin" | "launchedBy">, sidebarLabel: string | null = null): string {
  if (app.origin !== "ide") return "external";
  // The Logs sidebar's own name for that agent/terminal wins (`bash · workspace`), so the tag and
  // the Terminals row read the same; Rust's bare title (`bash`) is the fallback.
  return `by ${sidebarLabel ?? app.launchedBy ?? "the IDE"}`;
}

/**
 * The name Network's Process picker knows the app by: netcap's `client_name` — the executable's
 * basename without a Windows `.exe` (`/work/gazelle/target/debug/gazelle` → `gazelle`). Falls
 * back to argv[0]'s basename when Rust could not read the exe; null when it has neither (a
 * container), so the card does not offer a link to nothing.
 */
export function processNameOf(app: Pick<DevApp, "exe" | "argv">): string | null {
  const path = app.exe ?? app.argv[0] ?? null;
  if (path === null || path === "") return null;
  return basename(path).replace(/\.exe$/i, "");
}

/* ── the capture guard ──────────────────────────────────────────────────────── */

/** The card's warning and the sidebar ⚠'s tooltip, for an app with `captured === false`. */
export function uncapturedText(app: Pick<DevApp, "name">): string {
  return `${app.name} was started without the IDE's proxy — its HTTP calls can't show in Network.`;
}

/** The IDE apps whose HTTP cannot show in Network (`captured === false`), in Rust's order. */
export function uncapturedApps(apps: readonly DevApp[]): DevApp[] {
  return apps.filter((a) => a.origin === "ide" && a.captured === false && a.pid !== null);
}
