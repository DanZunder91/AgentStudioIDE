/**
 * The capacity art: racks lit bottom-up (agents bright, the rest of the used RAM amber, free dark),
 * gauges lit in their severity colour, the desks' context bar — and every "no reading" drawn as
 * missing, never as empty.
 */

import { describe, expect, it } from "vitest";

import type { PropReading } from "../villageTypes";
import { drawGauge, drawMeter, drawRack, GAUGE, GAUGE_BANDS, METER, METER_H, METER_TONE, RACK } from "./capacity";
import { recorder, type RecordingTarget } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };
const BOTTOM = 64;

/** The LED colours of a rack's eight units, bottom-up (each unit's LED is its 6-px-wide fill). */
function leds(ctx: RecordingTarget): string[] {
  return ctx
    .of("fillRect")
    .filter((c) => c.args[2] === 6 && c.args[3] === 1)
    .map((c) => c.fillStyle);
}

/** A gauge's eight band colours, bottom-up. */
function bands(ctx: RecordingTarget): string[] {
  return ctx
    .of("fillRect")
    .filter((c) => c.args[2] === 14 && c.args[3] === 2)
    .map((c) => c.fillStyle);
}

describe("drawRack", () => {
  it("lights the agents' units first, then the rest of the used RAM, the free units dark", () => {
    const ctx = recorder();
    drawRack(ctx, cam, 0, BOTTOM, { kind: "rack", agents: 2, other: 3, known: true });
    expect(leds(ctx)).toEqual([RACK.agents, RACK.agents, RACK.other, RACK.other, RACK.other, RACK.off, RACK.off, RACK.off]);
  });

  it("0 % is all dark, 100 % all lit", () => {
    const off = recorder();
    drawRack(off, cam, 0, BOTTOM, { kind: "rack", agents: 0, other: 0, known: true });
    expect(new Set(leds(off))).toEqual(new Set([RACK.off]));
    const full = recorder();
    drawRack(full, cam, 0, BOTTOM, { kind: "rack", agents: 8, other: 0, known: true });
    expect(new Set(leds(full))).toEqual(new Set([RACK.agents]));
  });

  it("unknown (or no reading at all) is grey dashes — not a dark, empty rack", () => {
    for (const r of [{ kind: "rack", agents: 0, other: 0, known: false } as PropReading, undefined, { kind: "gauge", meter: null } as PropReading]) {
      const ctx = recorder();
      drawRack(ctx, cam, 0, BOTTOM, r);
      const l = leds(ctx);
      expect(l).toHaveLength(8);
      expect(l.filter((c) => c === RACK.unknown)).toHaveLength(4);
      expect(l).not.toContain(RACK.off);
    }
  });

  it("stands on its footprint and rises two tiles", () => {
    const ctx = recorder();
    drawRack(ctx, cam, 16, BOTTOM, undefined);
    const cabinet = ctx.of("fillRect").find((c) => c.fillStyle === RACK.cabinet)!;
    expect(cabinet.args).toEqual([18, BOTTOM - 31, 12, 29]);
  });
});

describe("drawGauge", () => {
  it("lights bands bottom-up in proportion, in the meter's tone: 0, 50 and 100 %", () => {
    const at = (fill: number, tone: "ok" | "warn" | "danger") => {
      const ctx = recorder();
      drawGauge(ctx, cam, 0, BOTTOM, { kind: "gauge", meter: { fill, tone } });
      return bands(ctx);
    };
    expect(at(0, "ok")).toEqual(new Array(GAUGE_BANDS).fill(GAUGE.band));
    expect(at(0.5, "warn")).toEqual([...new Array(4).fill(METER_TONE.warn), ...new Array(4).fill(GAUGE.band)]);
    expect(at(1, "danger")).toEqual(new Array(GAUGE_BANDS).fill(METER_TONE.danger));
  });

  it("a sliver of use still lights one band", () => {
    const ctx = recorder();
    drawGauge(ctx, cam, 0, BOTTOM, { kind: "gauge", meter: { fill: 0.01, tone: "ok" } });
    expect(bands(ctx).filter((c) => c === METER_TONE.ok)).toHaveLength(1);
  });

  it("no reading: dark 'unknown' bands and a '?' mark, never an empty gauge", () => {
    for (const r of [{ kind: "gauge", meter: null } as PropReading, undefined, { kind: "rack", agents: 1, other: 0, known: true } as PropReading]) {
      const ctx = recorder();
      drawGauge(ctx, cam, 0, BOTTOM, r);
      expect(new Set(bands(ctx))).toEqual(new Set([GAUGE.unknown]));
      expect(ctx.of("fillRect").filter((c) => c.fillStyle === GAUGE.mark).length).toBeGreaterThan(0);
    }
    const known = recorder();
    drawGauge(known, cam, 0, BOTTOM, { kind: "gauge", meter: { fill: 0.2, tone: "ok" } });
    expect(known.of("fillRect").some((c) => c.fillStyle === GAUGE.mark)).toBe(false);
  });
});

describe("drawMeter — the context bar over a desk", () => {
  const meter = (fill: number, tone: "ok" | "warn" | "danger" | "unknown") => {
    const ctx = recorder();
    drawMeter(ctx, cam, { t: "meter", x: 10, y: 20, w: 14, fill, tone });
    return ctx.of("fillRect");
  };

  it("a border, the track, and the fill in its tone, proportional to the width", () => {
    const calls = meter(0.5, "warn");
    expect(calls.map((c) => c.fillStyle)).toEqual([METER.border, METER.track, METER_TONE.warn]);
    expect(calls[0].args).toEqual([9, 19, 16, METER_H + 2]);
    expect(calls[2].args).toEqual([10, 20, 7, METER_H]);
  });

  it("0 % draws no fill; a sliver draws one pixel; 100 % fills the track", () => {
    expect(meter(0, "ok")).toHaveLength(2);
    expect(meter(0.01, "ok")[2].args[2]).toBe(1);
    expect(meter(1, "danger")[2].args[2]).toBe(14);
    expect(meter(1, "unknown")[2].fillStyle).toBe(METER_TONE.unknown);
  });
});
