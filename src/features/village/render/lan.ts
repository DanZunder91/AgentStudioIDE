/** Seats-room LAN (engine/lan.ts): 2-px cables darker than every floor, team packets, uplink
 * glints. Below zoom 1 what must survive is painted LAST (a cable's core, a packet's body); all is
 * culled to the view first (a frame can carry ~100 runs and hundreds of packets). */

import type { DrawItem } from "../villageTypes";
import type { Camera } from "./camera";
import { onScreen, rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** Cable colours, exported for the tests: the lit edge and the dark core. */
export const CABLE = { shine: "#4a5468", core: "#1c212c" } as const;
/** A cable's width, world px: one lit edge + one core. */
export const CABLE_W = 2;

/** Packet sizes, world px: a team packet's body and rim, an uplink's whole dot. */
export const PACKET = { body: 3, rim: 1, uplink: 2 } as const;

/** A team packet's colours: a bright body in the team's hue, a dark rim of the same hue. */
export function teamPacketColors(hue: number): { body: string; rim: string } {
  return { body: `hsl(${hue}, 85%, 66%)`, rim: `hsl(${hue}, 60%, 20%)` };
}

/** An uplink packet's colour: the team's hue, washed out and see-through — quieter traffic. */
export function uplinkPacketColor(hue: number): string {
  return `hsla(${hue}, 30%, 85%, 0.75)`;
}

type Cable = Extract<DrawItem, { t: "cable" }>;
type Packet = Extract<DrawItem, { t: "packet" }>;
type View = { w: number; h: number };

/** One run of LAN cable (axis-aligned, per the contract), capped at both ends; nothing off-screen. */
export function drawCable(ctx: DrawTarget, cam: Camera, item: Cable, view: View): void {
  const half = CABLE_W / 2;
  const x = Math.min(item.x0, item.x1) - half;
  const y = Math.min(item.y0, item.y1) - half;
  const horizontal = item.y0 === item.y1;
  const w = horizontal ? Math.abs(item.x1 - item.x0) + CABLE_W : CABLE_W;
  const h = horizontal ? CABLE_W : Math.abs(item.y1 - item.y0) + CABLE_W;
  if (!onScreen(cam, view, x, y, w, h)) return;
  // The lit edge first, the core last: below 1 they can share a screen row, and the dark one reads.
  if (horizontal) {
    rect(ctx, cam, x, y, w, half, CABLE.shine);
    rect(ctx, cam, x, y + half, w, half, CABLE.core);
  } else {
    rect(ctx, cam, x, y, half, h, CABLE.shine);
    rect(ctx, cam, x + half, y, half, h, CABLE.core);
  }
}

/** One packet on the LAN this frame, centred on (x, y); nothing off-screen. */
export function drawPacket(ctx: DrawTarget, cam: Camera, item: Packet, view: View): void {
  const { x, y, hue } = item;
  if (item.kind === "uplink") {
    // Exactly over the cable's two px: [x − 1, x + 1).
    const r = PACKET.uplink / 2;
    if (onScreen(cam, view, x - r, y - r, PACKET.uplink, PACKET.uplink))
      rect(ctx, cam, x - r, y - r, PACKET.uplink, PACKET.uplink, uplinkPacketColor(hue));
    return;
  }
  // The body's centre pixel is (x, y); the rim one pixel round it.
  const b = Math.floor(PACKET.body / 2);
  const o = b + PACKET.rim;
  const outer = PACKET.body + 2 * PACKET.rim;
  if (!onScreen(cam, view, x - o, y - o, outer, outer)) return;
  const c = teamPacketColors(hue);
  rect(ctx, cam, x - o, y - o, outer, outer, c.rim);
  rect(ctx, cam, x - b, y - b, PACKET.body, PACKET.body, c.body);
}

// ── Wi-Fi (engine/teamLan.ts) ── A pulse is a 1-px midpoint-circle RING (no canvas arc, no AA)
// growing MIN_R → MAX_R as `phase` goes 0 → 1; a ring because the name board hides what rises
// above the router. Its dark rim and pale line read on any floor; the line is painted last.

/** A pulse's radius range, world px: just sent → fully spread. */
export const WIFI = { minR: 2, maxR: 12 } as const;

/** A pulse's radius at `phase` (clamped to 0..1): whole px, MIN_R at 0 up to MAX_R at 1. */
export function wifiRadius(phase: number): number {
  const p = Math.min(1, Math.max(0, phase));
  return WIFI.minR + Math.round(p * (WIFI.maxR - WIFI.minR));
}

/** A pulse's ring (pale) and rim (dark) in the team's hue, fading from opaque at 0 to gone at 1. */
export function wifiColors(hue: number, phase: number): { ring: string; rim: string } {
  const fade = 1 - Math.min(1, Math.max(0, phase));
  const a = (v: number) => Math.round(v * fade * 1000) / 1000;
  return { ring: `hsla(${hue}, 90%, 80%, ${a(1)})`, rim: `hsla(${hue}, 60%, 18%, ${a(0.85)})` };
}

/** One horizontal run of a ring's cells: (dx, dy) from the centre, `n` cells long. */
type Run = { dx: number; dy: number; n: number };

/** The cells of a 1-px circle of radius r round (0, 0) — the midpoint algorithm, 8-connected. */
function circleCells(r: number): Set<string> {
  const cells = new Set<string>();
  let x = r;
  let y = 0;
  let err = 1 - r;
  while (x >= y) {
    for (const [a, b] of [
      [x, y],
      [y, x],
      [-y, x],
      [-x, y],
      [-x, -y],
      [-y, -x],
      [y, -x],
      [x, -y],
    ])
      cells.add(`${a},${b}`);
    y++;
    if (err < 0) err += 2 * y + 1;
    else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
  return cells;
}

/** Cells → horizontal runs, top to bottom, left to right. */
function runsOf(cells: Set<string>): Run[] {
  const pts = [...cells].map((k) => k.split(",").map(Number)).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const runs: Run[] = [];
  for (const [dx, dy] of pts) {
    const last = runs[runs.length - 1];
    if (last && last.dy === dy && last.dx + last.n === dx) last.n++;
    else runs.push({ dx, dy, n: 1 });
  }
  return runs;
}

/** Per radius: the ring's runs and its rim's (the circle one px further out, minus the ring's own cells). */
const RING_CACHE = new Map<number, { ring: Run[]; rim: Run[] }>();

function ringRuns(r: number): { ring: Run[]; rim: Run[] } {
  let hit = RING_CACHE.get(r);
  if (!hit) {
    const ring = circleCells(r);
    const rim = circleCells(r + 1);
    for (const k of ring) rim.delete(k);
    hit = { ring: runsOf(ring), rim: runsOf(rim) };
    RING_CACHE.set(r, hit);
  }
  return hit;
}

type Wifi = Extract<DrawItem, { t: "wifi" }>;

/** One pulse: rim, then ring, `wifiRadius(phase)` round (x, y). Nothing once faded (phase ≥ 1 or
 * NaN) or off-screen. */
export function drawWifi(ctx: DrawTarget, cam: Camera, item: Wifi, view: View): void {
  const { x, y, phase, hue } = item;
  if (!(phase < 1)) return;
  const r = wifiRadius(phase);
  const reach = r + 1;
  if (!onScreen(cam, view, x - reach, y - reach, 2 * reach + 1, 2 * reach + 1)) return;
  const { ring, rim } = ringRuns(r);
  const c = wifiColors(hue, phase);
  for (const s of rim) rect(ctx, cam, x + s.dx, y + s.dy, s.n, 1, c.rim);
  for (const s of ring) rect(ctx, cam, x + s.dx, y + s.dy, s.n, 1, c.ring);
}
