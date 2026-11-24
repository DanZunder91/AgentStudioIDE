/**
 * Pure logic of the Whole-computer table: which apps and sockets are shown, in what
 * order, and how their numbers read. Everything here is a function of a sample plus the
 * user's choices, so a test can pin one rule at a time.
 */

import type { AppPickerItem } from "../../components/AppPicker";
import { isMac } from "../shortcuts/shortcuts";
import { formatSize } from "./networkFormat";
import type { MachineApp, MachineBackend, MachineConn, MachineSample } from "./networkTypes";

export type MachineSortKey = "rateIn" | "rateOut" | "bytesIn" | "bytesOut" | "name" | "conns";
export type SortDir = "asc" | "desc";
export interface MachineSort {
  key: MachineSortKey;
  dir: SortDir;
}

/** Numbers sort biggest-first on the first click; a name reads A→Z. */
export function defaultDir(key: MachineSortKey): SortDir {
  return key === "name" ? "asc" : "desc";
}

/**
 * A socket that is not talking to anyone: a TCP listener, or a UDP socket with no peer.
 * Both have `remote: null` in the contract; the state check also covers a backend that
 * reports a listener's wildcard peer.
 */
export function isListener(c: MachineConn): boolean {
  return c.remote === null || c.state.toLowerCase() === "listen";
}

export interface ShownApp {
  app: MachineApp;
  /** The sockets shown for it (listeners and filter misses removed). */
  conns: MachineConn[];
}

export interface MachineView {
  selection: string[] | null;
  filter: string;
  hideListeners: boolean;
}

function connMatches(c: MachineConn, q: string): boolean {
  return `${c.local} ${c.remote ?? ""} ${c.remoteHost ?? ""} ${c.state} ${c.proto}`.toLowerCase().includes(q);
}

/**
 * Apply the app selection, Hide listeners and the text filter.
 *
 * - An app whose every socket is a listener disappears under Hide listeners; an app the
 *   backend reported with NO sockets stays (it is traffic without a socket list, not a
 *   listener).
 * - The filter matches an app by name or pid (all its sockets stay), else by socket
 *   (only the matching sockets stay, and the app drops out if none do).
 */
export function shownApps(sample: MachineSample | null, v: MachineView): ShownApp[] {
  if (!sample) return [];
  const q = v.filter.trim().toLowerCase();
  const out: ShownApp[] = [];
  for (const app of sample.apps) {
    if (v.selection !== null && !v.selection.includes(app.name)) continue;
    let conns = v.hideListeners ? app.connections.filter((c) => !isListener(c)) : app.connections;
    if (app.connections.length > 0 && conns.length === 0) continue;
    if (q && !`${app.name} ${app.pid}`.toLowerCase().includes(q)) {
      conns = conns.filter((c) => connMatches(c, q));
      if (conns.length === 0) continue;
    }
    out.push({ app, conns });
  }
  return out;
}

function numberOf(s: ShownApp, key: Exclude<MachineSortKey, "name">): number | null {
  return key === "conns" ? s.conns.length : s.app[key];
}

/**
 * Sort shown apps. A `null` number (the backend cannot see bytes) sorts LAST in either
 * direction — it is unknown, not zero. Ties fall back to name, then pid, so the order is
 * stable across one-second samples.
 */
export function sortApps(rows: readonly ShownApp[], sort: MachineSort): ShownApp[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byName = (a: ShownApp, b: ShownApp): number =>
    a.app.name.localeCompare(b.app.name, undefined, { sensitivity: "base" }) || a.app.pid - b.app.pid;
  return rows.slice().sort((a, b) => {
    if (sort.key === "name") return sign * byName(a, b);
    const x = numberOf(a, sort.key);
    const y = numberOf(b, sort.key);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
      return byName(a, b);
    }
    return sign * (x - y) || byName(a, b);
  });
}

/**
 * The sorts (and table columns) that read byte counts: rates and totals. A backend that cannot
 * see bytes (`MachineStatus.hasBytes = false` — Windows' connection tables carry none) would show
 * four columns of `—` forever, so the view hides them there and keeps them where bytes exist.
 */
export const BYTE_SORTS: ReadonlySet<MachineSortKey> = new Set(["rateIn", "rateOut", "bytesIn", "bytesOut"]);

/**
 * The sort actually applied: a byte sort on a backend with no bytes would order every row by
 * an unknown — its column is hidden there, so the table falls back to busiest first (connection
 * count). The user's choice is kept, so it comes back with the columns.
 */
export function effectiveSort(sort: MachineSort, hasBytes: boolean): MachineSort {
  return hasBytes || !BYTE_SORTS.has(sort.key) ? sort : { key: "conns", dir: "desc" };
}

export interface MachineSummary {
  apps: number;
  conns: number;
  rateIn: number | null;
  rateOut: number | null;
}

/** Totals over what the table shows. A rate is null only when NO shown app has one. */
export function summarizeShown(rows: readonly ShownApp[]): MachineSummary {
  let conns = 0;
  let rateIn: number | null = null;
  let rateOut: number | null = null;
  for (const r of rows) {
    conns += r.conns.length;
    if (r.app.rateIn !== null) rateIn = (rateIn ?? 0) + r.app.rateIn;
    if (r.app.rateOut !== null) rateOut = (rateOut ?? 0) + r.app.rateOut;
  }
  return { apps: rows.length, conns, rateIn, rateOut };
}

/** The AppPicker's rows: one per app NAME (several pids merge), count = its sockets. */
export function appItems(sample: MachineSample | null): AppPickerItem[] {
  if (!sample) return [];
  const counts = new Map<string, number>();
  for (const a of sample.apps) counts.set(a.name, (counts.get(a.name) ?? 0) + a.connections.length);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([name, count]) => ({ id: name, label: name, count }));
}

/** `—` stands for "the backend cannot see this", never for zero. */
export const DASH = "—";

export const NO_BYTES_TITLE =
  "Not available: this platform's connection backend can't see byte counts for this socket or process.";

/**
 * A null RATE next to a known byte count is not a blind backend: Rust sends `rateIn: null`
 * on the first sample after a start (a rate needs two) and for a socket it can't match to
 * its predecessor (`rates.rs`). Pinned by the contract goldens (a backend's first sample).
 */
export const NO_RATE_TITLE = "No rate yet: a rate needs two samples (about a second) of this socket or process.";

/** The title of a `—` rate cell: blind backend when the bytes are unknown too, else not yet. */
export function rateNaTitle(bytes: number | null): string {
  return bytes === null ? NO_BYTES_TITLE : NO_RATE_TITLE;
}

export function bytesCell(n: number | null): string {
  return n === null ? DASH : formatSize(Math.round(n));
}

export function rateCell(n: number | null): string {
  return n === null ? DASH : `${formatSize(Math.round(n))}/s`;
}

/** `api.example.com (93.184.216.34:443)` when resolved; the bare peer otherwise. */
export function remoteCell(c: MachineConn): string {
  if (c.remote === null) return DASH;
  return c.remoteHost ? `${c.remoteHost} (${c.remote})` : c.remote;
}

/** Why a peer has no name next to it: most CDN edges simply have no PTR record. */
export const NO_RDNS_TITLE = "no reverse DNS record — CDN addresses rarely have one";

/** The Remote (host) cell's hover: the full text, or — for a bare address — why it is bare. */
export function remoteTitle(c: MachineConn): string {
  if (c.remote !== null && !c.remoteHost) return `${c.remote} — ${NO_RDNS_TITLE}`;
  return remoteCell(c);
}

export const OTHER_USER_TITLE =
  "Another user's process — the OS doesn't reveal which without admin rights.";

/**
 * The machine view's name: "Whole Mac" on the macOS backend, "Whole computer" on every other.
 * With no status yet (or in a sentence written far from one), the platform decides — the nettop
 * backend runs exactly on macOS, so the answer is the same. Every sentence that names this view
 * goes through here: five of them used to hardcode "Whole Mac", which a Windows user reads as
 * a view that does not exist.
 */
export function modeLabel(backend: MachineBackend | null | undefined): string {
  if (backend == null) return isMac() ? "Whole Mac" : "Whole computer";
  return backend === "macos-nettop" ? "Whole Mac" : "Whole computer";
}
