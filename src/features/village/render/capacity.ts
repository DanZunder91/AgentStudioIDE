/**
 * Agent Village — the capacity art: the Memory building's server racks, the Usage
 * building's two gauges, and the small context bar over an agent's desk. Our own procedural pixel
 * art, anchored like every prop: (x0, bottom) = the footprint's left and bottom edges, world px.
 *
 * A missing reading is drawn as MISSING — a rack's grey dashes, a gauge's dark bands with a "?" —
 * never as an empty (0%) one, which would claim something we do not know.
 */

import type { DrawItem, MeterTone, PropReading } from "../villageTypes";
import type { Camera } from "./camera";
import { rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** Fill colours by severity (the usage strip's / context card's green → amber → red). Exported for the tests. */
export const METER_TONE: Readonly<Record<MeterTone, string>> = {
  ok: "#4cc38a",
  warn: "#e3b341",
  danger: "#f85149",
  unknown: "#6b7280",
};

/** Rack colours. Exported for the tests (they read the unit LEDs back). */
export const RACK = {
  cabinet: "#2a3140",
  cap: "#3d4860",
  slot: "#161b24",
  agents: "#5fe0b0",
  other: "#b08a3e",
  off: "#2c3442",
  unknown: "#4a505c",
} as const;

/** Units per rack, drawn bottom-up (the engine's RACK_UNITS). */
const UNITS = 8;

/**
 * A server rack: a cabinet two tiles tall with eight unit slots, lit from the bottom up — the
 * agents' share bright, everything else in use dim amber, free units dark. Unknown: grey dashes.
 */
export function drawRack(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, reading: PropReading | undefined): void {
  const r = reading?.kind === "rack" ? reading : null;
  rect(ctx, cam, x0 + 2, bottom - 2, 12, 2, "rgba(0, 0, 0, 0.25)");
  rect(ctx, cam, x0 + 2, bottom - 31, 12, 29, RACK.cabinet);
  rect(ctx, cam, x0 + 2, bottom - 31, 12, 1, RACK.cap);
  rect(ctx, cam, x0 + 2, bottom - 31, 1, 29, RACK.cap);
  for (let u = 0; u < UNITS; u++) {
    const y = bottom - 6 - u * 3;
    rect(ctx, cam, x0 + 4, y, 8, 2, RACK.slot);
    let led: string = RACK.off;
    if (!r?.known) led = u % 2 === 0 ? RACK.unknown : RACK.slot;
    else if (u < r.agents) led = RACK.agents;
    else if (u < r.agents + r.other) led = RACK.other;
    rect(ctx, cam, x0 + 5, y, 6, 1, led);
  }
}

/** Gauge colours. Exported for the tests. */
export const GAUGE = {
  frame: "#4a5468",
  face: "#141a24",
  band: "#232b38",
  unknown: "#2e3542",
  mark: "#8b93a3",
  plinth: "#3a4152",
} as const;

/** Bands in a gauge, bottom-up. */
export const GAUGE_BANDS = 8;

/**
 * A usage gauge: a framed window of eight bands lit bottom-up in proportion to the window's use
 * (a non-zero use lights at least one), in its severity colour. No reading: dark bands and a "?".
 */
export function drawGauge(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, reading: PropReading | undefined): void {
  const meter = reading?.kind === "gauge" ? reading.meter : null;
  rect(ctx, cam, x0 + 2, bottom - 4, 28, 4, GAUGE.plinth);
  rect(ctx, cam, x0 + 5, bottom - 31, 22, 27, GAUGE.frame);
  rect(ctx, cam, x0 + 7, bottom - 29, 18, 24, GAUGE.face);
  const lit = meter ? Math.max(meter.fill > 0 ? 1 : 0, Math.round(meter.fill * GAUGE_BANDS)) : 0;
  for (let b = 0; b < GAUGE_BANDS; b++) {
    const y = bottom - 8 - b * 3;
    let color: string = meter ? GAUGE.band : GAUGE.unknown;
    if (meter && b < lit) color = METER_TONE[meter.tone];
    rect(ctx, cam, x0 + 9, y, 14, 2, color);
  }
  if (meter) return;
  // A "?" over the dark bands: no reading.
  rect(ctx, cam, x0 + 14, bottom - 25, 4, 1, GAUGE.mark);
  rect(ctx, cam, x0 + 18, bottom - 24, 1, 3, GAUGE.mark);
  rect(ctx, cam, x0 + 16, bottom - 21, 2, 1, GAUGE.mark);
  rect(ctx, cam, x0 + 16, bottom - 20, 1, 2, GAUGE.mark);
  rect(ctx, cam, x0 + 16, bottom - 16, 1, 1, GAUGE.mark);
}

/** The context bar's border and empty track. Exported for the tests. */
export const METER = { border: "rgba(8, 10, 16, 0.9)", track: "#2a2f3a" } as const;
/** Its height, world px (inside the border). */
export const METER_H = 2;

/** A small fill bar over an agent's desk: its context window, green → amber → red. */
export function drawMeter(ctx: DrawTarget, cam: Camera, item: Extract<DrawItem, { t: "meter" }>): void {
  const { x, y, w, fill, tone } = item;
  rect(ctx, cam, x - 1, y - 1, w + 2, METER_H + 2, METER.border);
  rect(ctx, cam, x, y, w, METER_H, METER.track);
  const filled = Math.max(fill > 0 ? 1 : 0, Math.round(w * fill));
  if (filled > 0) rect(ctx, cam, x, y, filled, METER_H, METER_TONE[tone]);
}
