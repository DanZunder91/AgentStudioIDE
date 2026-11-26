/** Backdrop invariants: every landmark crown stays in sight; the kana font spells every sign. */

import { describe, expect, it } from "vitest";

import { buildCityWorld, computeAmbience } from "../engine";
import { TILE } from "../villageTypes";
import { AIR_CHUNK, AIR_MAX, AIR_MIN, airSpans, citySpan, CROWN_PAD, inAir, inQuiet, quietSpans, roofLimit, SIGN_WORDS } from "./backdrop";
import { kanaText } from "./kana";
import { landmarkCrown, landmarksFor, placeLandmarks } from "./landmarks";

const floorsOf = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: true }));
/** The reference city: a seven-floor gazelle left of the HQ, a one-floor project right of it. */
const world = buildCityWorld(
  [
    { key: "chat-server", label: "chat-server", team: 2, hasIde: true, floors: floorsOf("t", 1) },
    { key: "gazelle", label: "gazelle", team: 26, hasIde: true, floors: floorsOf("g", 7) },
  ],
  { seats: 64 },
);
const horizon = world.city!.street * TILE;
const tokyo = computeAmbience(new Date(2026, 9, 27, 13, 0), null, { weather: "clear", phase: "auto" }, "Asia/Tokyo");
const placed = placeLandmarks(world, horizon, landmarksFor("Asia/Tokyo")).placed;
const crownOf = (kind: string) => landmarkCrown(placed.find((p) => p.spec.kind === kind)!);

describe("roofLimit", () => {
  it("is no limit in a city with no landmarks (no zone, or a zone without a skyline)", () => {
    expect(roofLimit(world, undefined, horizon, -1e6, 1e6, ["far", "tower"])).toBe(-Infinity);
    const utc = computeAmbience(new Date(2026, 9, 27, 13, 0), null, { weather: "clear", phase: "auto" }, "UTC");
    expect(roofLimit(world, utc, horizon, -1e6, 1e6, ["far", "tower"])).toBe(-Infinity);
  });

  it("keeps a roof CROWN_PAD under a crown it would stand under", () => {
    const fuji = crownOf("fuji");
    const mid = Math.round((fuji.x0 + fuji.x1) / 2);
    expect(roofLimit(world, tokyo, horizon, mid, mid + 1, ["far"])).toBe(fuji.bottom + CROWN_PAD);
  });

  it("pads the crown's span CROWN_PAD either side — and no further", () => {
    // Fuji is the only "far" landmark: no other crown can answer for it.
    expect(placed.filter((p) => p.spec.layer === "far").map((p) => p.spec.kind)).toEqual(["fuji"]);
    const fuji = crownOf("fuji");
    const limit = (x0: number, x1: number) => roofLimit(world, tokyo, horizon, x0, x1, ["far"]);
    expect(limit(fuji.x0 - CROWN_PAD - 4, fuji.x0 - CROWN_PAD + 1)).toBe(fuji.bottom + CROWN_PAD);
    expect(limit(fuji.x0 - CROWN_PAD - 4, fuji.x0 - CROWN_PAD)).toBe(-Infinity);
    expect(limit(fuji.x1 + CROWN_PAD - 1, fuji.x1 + CROWN_PAD + 4)).toBe(fuji.bottom + CROWN_PAD);
    expect(limit(fuji.x1 + CROWN_PAD, fuji.x1 + CROWN_PAD + 4)).toBe(-Infinity);
  });

  it("counts only the layers asked for: a HIGH layer stands behind the towers, a MID one in front", () => {
    const tower = crownOf("tokyo-tower");
    const mid = Math.round((tower.x0 + tower.x1) / 2);
    expect(roofLimit(world, tokyo, horizon, mid, mid + 1, ["far"])).toBe(-Infinity);
    expect(roofLimit(world, tokyo, horizon, mid, mid + 1, ["far", "tower"])).toBe(tower.bottom + CROWN_PAD);
  });

  it("over several crowns, keeps under the LOWEST of them", () => {
    const crowns = placed.filter((p) => p.spec.layer !== "near").map(landmarkCrown);
    const x0 = Math.min(...crowns.map((c) => c.x0));
    const x1 = Math.max(...crowns.map((c) => c.x1));
    expect(roofLimit(world, tokyo, horizon, x0, x1, ["far", "tower"])).toBe(Math.max(...crowns.map((c) => c.bottom)) + CROWN_PAD);
  });
});

describe("SIGN_WORDS", () => {
  it("are the three first — ramen and soba in katakana, sushi in hiragana — and each says something else", () => {
    expect(SIGN_WORDS.slice(0, 3).map((w) => w.text)).toEqual(["ラーメン", "ソバ", "すし"]);
    expect(new Set(SIGN_WORDS.map((w) => w.text)).size).toBe(SIGN_WORDS.length);
    expect(new Set(SIGN_WORDS.map((w) => w.meaning)).size).toBe(SIGN_WORDS.length);
  });

  it("are every one spelled by the kana font, both ways", () => {
    for (const { text } of SIGN_WORDS) {
      expect(kanaText(text, false).runs.length).toBeGreaterThan(0);
      expect(kanaText(text, true).runs.length).toBeGreaterThan(0);
    }
  });
});

describe("the open sky between the clusters", () => {
  it("is one stretch per chunk, AIR_MIN–AIR_MAX wide, inside its chunk — the same whatever span asks", () => {
    const all = airSpans(-10 * AIR_CHUNK, 10 * AIR_CHUNK);
    expect(all).toHaveLength(20);
    all.forEach(([a, b], i) => {
      const c = Math.floor(a / AIR_CHUNK);
      expect(c).toBe(i - 10);
      expect(b - a).toBeGreaterThanOrEqual(AIR_MIN);
      expect(b - a).toBeLessThanOrEqual(AIR_MAX);
      expect(b).toBeLessThanOrEqual((c + 1) * AIR_CHUNK);
    });
    expect(new Set(all.map(([a, b]) => b - a)).size).toBeGreaterThan(3);
    // World-locked: a narrower window sees exactly the stretches that overlap it.
    for (const [x0, x1] of [
      [-500, 300],
      [17, 18],
      [1000, 2600],
    ])
      expect(airSpans(x0, x1)).toEqual(all.filter(([a, b]) => b > x0 && a < x1));
  });

  it("tells a building that touches a stretch from one that does not", () => {
    const [prev, [a, b], next] = airSpans(-AIR_CHUNK, 2 * AIR_CHUNK);
    expect(inAir(a, a + 1)).toBe(true);
    expect(inAir(b - 1, b)).toBe(true);
    // Just outside: free, unless the neighbouring chunk's stretch starts (or ends) right there.
    expect(inAir(a - 1, a)).toBe(prev[1] === a);
    expect(inAir(b, b + 1)).toBe(next[0] === b);
    expect(inAir(prev[1], a)).toBe(false);
  });
});

describe("the quiet stretches: the open sky and the city's own span", () => {
  const bs = world.city!.buildings;
  const span = citySpan(world)!;

  it("the city's span runs from its outermost wall to its outermost wall; no buildings, no span", () => {
    expect(span).toEqual([Math.min(...bs.map((b) => b.col * TILE)), Math.max(...bs.map((b) => (b.col + b.w) * TILE))]);
    expect(citySpan(buildCityWorld([]))).toBeNull();
  });

  it("are the open sky's stretches, with the city's span merged into any it overlaps, in world order", () => {
    const x0 = span[0] - 3 * AIR_CHUNK;
    const x1 = span[1] + 3 * AIR_CHUNK;
    const quiet = quietSpans(world, x0, x1);
    const air = airSpans(x0, x1);
    // Sorted and apart.
    for (let i = 1; i < quiet.length; i++) expect(quiet[i][0]).toBeGreaterThan(quiet[i - 1][1]);
    // The city's span is inside one of them, and every stretch of sky is inside one.
    expect(quiet.some(([a, b]) => a <= span[0] && b >= span[1])).toBe(true);
    for (const [a, b] of air) expect(quiet.some(([p, q]) => p <= a && q >= b)).toBe(true);
    // Away from the city they are exactly the open sky's.
    expect(quiet.filter(([a, b]) => b < span[0] || a > span[1])).toEqual(air.filter(([a, b]) => b < span[0] || a > span[1]));
    // A window that misses the city sees the sky's stretches alone; a city with no buildings has none of its own.
    expect(quietSpans(world, span[1] + 10 * AIR_CHUNK, span[1] + 12 * AIR_CHUNK)).toEqual(airSpans(span[1] + 10 * AIR_CHUNK, span[1] + 12 * AIR_CHUNK));
    expect(quietSpans(buildCityWorld([]), 0, AIR_CHUNK)).toEqual(airSpans(0, AIR_CHUNK));
  });

  it("tell a building inside the city's span (or in the sky) from one outside both", () => {
    expect(inQuiet(world, span[0], span[0] + 1)).toBe(true);
    expect(inQuiet(world, span[1] - 1, span[1])).toBe(true);
    const [a] = airSpans(span[1] + 4 * AIR_CHUNK, span[1] + 5 * AIR_CHUNK)[0];
    expect(inQuiet(world, a, a + 1)).toBe(true);
    // Just past a stretch of sky that does not touch the city: not quiet.
    const [, b] = airSpans(span[1] + 4 * AIR_CHUNK, span[1] + 5 * AIR_CHUNK)[0];
    expect(inQuiet(world, b, b + 1)).toBe(inAir(b, b + 1));
  });
});

