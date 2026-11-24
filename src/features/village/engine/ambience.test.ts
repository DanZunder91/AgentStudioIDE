import { describe, expect, it } from "vitest";
import type { DayPhase, WeatherKind, WeatherWire } from "../villageTypes";
import {
  CITY_DAY,
  DEFAULT_SUNRISE_MIN,
  DEFAULT_SUNSET_MIN,
  SKY_BANDS,
  VEIL,
  citySky,
  computeAmbience,
  dayPhaseAt,
  dayWeight,
  gradeColor,
  litShare,
  localMinutesOf,
  skyClock,
  veilAlpha,
} from "./ambience";

const AUTO = { weather: "auto", phase: "auto" } as const;
/** A LOCAL wall-clock time on 2026-10-14 (the Date constructor reads local fields). */
const at = (h: number, m = 0, s = 0) => new Date(2026, 9, 14, h, m, s);
const hm = (h: number, m = 0) => h * 60 + m;

function wire(kind: WeatherKind, extra: Partial<WeatherWire> = {}): WeatherWire {
  return { kind, intensity: 0.8, temperatureC: 14, wind: 0.3, sunriseMs: null, sunsetMs: null, place: "Tokyo", fetchedAtMs: 0, ...extra };
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

describe("dayPhaseAt", () => {
  it("walks the default day (06:00 sunrise, 18:00 sunset) with exact boundaries", () => {
    const cases: [number, DayPhase][] = [
      [0, "night"],
      [hm(5, 14), "night"],
      [hm(5, 15), "dawn"],
      [hm(6, 44), "dawn"],
      [hm(6, 45), "morning"],
      [hm(11, 29), "morning"],
      [hm(11, 30), "noon"],
      [hm(13, 29), "noon"],
      [hm(13, 30), "afternoon"],
      [hm(16, 29), "afternoon"],
      [hm(16, 30), "evening"],
      [hm(17, 39), "evening"],
      [hm(17, 40), "dusk"],
      [hm(18, 39), "dusk"],
      [hm(18, 40), "night"],
      [hm(23, 59), "night"],
    ];
    for (const [m, phase] of cases) expect([m, dayPhaseAt(m, null, null)]).toEqual([m, phase]);
    expect(DEFAULT_SUNRISE_MIN).toBe(360);
    expect(DEFAULT_SUNSET_MIN).toBe(1080);
  });

  it("follows the given sunrise / sunset", () => {
    const sr = hm(7, 30);
    const ss = hm(20, 0);
    expect(dayPhaseAt(hm(6, 30), sr, ss)).toBe("night");
    expect(dayPhaseAt(hm(7, 0), sr, ss)).toBe("dawn");
    expect(dayPhaseAt(hm(8, 15), sr, ss)).toBe("morning");
    expect(dayPhaseAt(hm(18, 0), sr, ss)).toBe("afternoon");
    expect(dayPhaseAt(hm(18, 30), sr, ss)).toBe("evening");
    expect(dayPhaseAt(hm(19, 45), sr, ss)).toBe("dusk");
    expect(dayPhaseAt(hm(20, 40), sr, ss)).toBe("night");
  });

  it("wraps minutes outside one day", () => {
    expect(dayPhaseAt(hm(15) + 1440, null, null)).toBe("afternoon");
    expect(dayPhaseAt(-60, null, null)).toBe("night");
    expect(dayPhaseAt(hm(12) - 2 * 1440, null, null)).toBe("noon");
  });

  it("handles a sunset past midnight (Reykjavik in June: up 02:55, down 00:03)", () => {
    const sr = hm(2, 55);
    const ss = hm(0, 3);
    expect(dayPhaseAt(hm(9), sr, ss)).toBe("morning");
    expect(dayPhaseAt(hm(12), sr, ss)).toBe("noon");
    expect(dayPhaseAt(hm(15), sr, ss)).toBe("afternoon");
    expect(dayPhaseAt(hm(20), sr, ss)).toBe("afternoon");
    expect(dayPhaseAt(hm(22, 40), sr, ss)).toBe("evening");
    expect(dayPhaseAt(hm(23, 50), sr, ss)).toBe("dusk");
    expect(dayPhaseAt(hm(0, 5), sr, ss)).toBe("dusk");
    expect(dayPhaseAt(hm(0, 42), sr, ss)).toBe("dusk");
    expect(dayPhaseAt(hm(0, 43), sr, ss)).toBe("night");
    expect(dayPhaseAt(hm(2, 0), sr, ss)).toBe("night");
    expect(dayPhaseAt(hm(2, 30), sr, ss)).toBe("dawn");
  });

  it("a late sunset (23:50) keeps dusk going past 00:00 instead of snapping to night", () => {
    const ss = hm(23, 50);
    expect(dayPhaseAt(hm(12), hm(4), ss)).toBe("noon");
    expect(dayPhaseAt(hm(23, 59), hm(4), ss)).toBe("dusk");
    expect(dayPhaseAt(hm(0, 5), hm(4), ss)).toBe("dusk");
    expect(dayPhaseAt(hm(0, 30), hm(4), ss)).toBe("night");
    expect(dayPhaseAt(0, hm(4), hm(23, 50))).toBe("dusk");
  });

  it("covers every minute with exactly the expected order through a day", () => {
    const order: DayPhase[] = [];
    for (let m = 0; m < 1440; m++) {
      const p = dayPhaseAt(m, null, null);
      if (order[order.length - 1] !== p) order.push(p);
    }
    expect(order).toEqual(["night", "dawn", "morning", "noon", "afternoon", "evening", "dusk", "night"]);
  });
});

describe("computeAmbience", () => {
  it("reads only the LOCAL wall clock — the same local time is the same phase on any date / DST side", () => {
    expect(localMinutesOf(at(15, 30, 30))).toBe(hm(15, 30) + 0.5);
    for (const d of [new Date(2026, 2, 29, 15, 0), new Date(2026, 9, 25, 15, 0), new Date(2026, 6, 1, 15, 0), at(15)]) {
      expect(computeAmbience(d, null, AUTO).phase).toBe("afternoon");
    }
  });

  it("no weather → clear, calm, campfire lit; afternoon is warm and bright", () => {
    const a = computeAmbience(at(15), null, AUTO);
    expect(a).toMatchObject({ phase: "afternoon", weather: "clear", intensity: 0, wind: 0, lightsOn: false, campfireLit: true, stayIndoors: false });
    expect(a.daylight).toBeGreaterThan(0.85);
    expect(a.daylight).toBeLessThanOrEqual(1);
    expect(a.tint.alpha).toBeGreaterThan(0);
    expect(a.tint.alpha).toBeLessThan(0.1);
    const [r, , b] = rgb(a.tint.color);
    expect(r).toBeGreaterThan(b); // warm
  });

  it("noon is full sun with no grade; night is a deep blue grade, dim, lamps on, everyone in", () => {
    const noon = computeAmbience(at(12, 30), null, AUTO);
    expect(noon).toMatchObject({ phase: "noon", daylight: 1, tint: { alpha: 0 } });
    const night = computeAmbience(at(2), null, AUTO);
    expect(night).toMatchObject({ phase: "night", daylight: 0.15, tint: { color: "#0b1640", alpha: 0.55 }, lightsOn: true, stayIndoors: true });
  });

  it("takes sunrise / sunset from the weather report, as local minutes", () => {
    const w = wire("clear", { intensity: 0, sunriseMs: at(7, 30).getTime(), sunsetMs: at(17, 0).getTime() });
    expect(computeAmbience(at(7), w, AUTO).phase).toBe("dawn");
    expect(computeAmbience(at(7), null, AUTO).phase).toBe("morning");
    expect(computeAmbience(at(15, 45), w, AUTO).phase).toBe("evening");
    expect(computeAmbience(at(15, 45), null, AUTO).phase).toBe("afternoon");
    // only one of the two known
    expect(computeAmbience(at(15, 45), { ...w, sunriseMs: null }, AUTO).phase).toBe("evening");
    expect(computeAmbience(at(7), { ...w, sunsetMs: null }, AUTO).phase).toBe("dawn");
  });

  it("with a sunset past midnight the day is bright and dusk fades smoothly across 00:00", () => {
    const w = wire("clear", { intensity: 0, sunriseMs: at(2, 55).getTime(), sunsetMs: at(0, 3).getTime() });
    expect(computeAmbience(at(12), w, AUTO)).toMatchObject({ phase: "noon", daylight: 1, stayIndoors: false, lightsOn: false });
    expect(computeAmbience(at(15), w, AUTO)).toMatchObject({ phase: "afternoon", stayIndoors: false });
    const before = computeAmbience(at(23, 59), w, AUTO);
    const after = computeAmbience(at(0, 1), w, AUTO);
    expect([before.phase, after.phase]).toEqual(["dusk", "dusk"]);
    expect(after.daylight).toBeLessThan(before.daylight);
    expect(before.daylight - after.daylight).toBeLessThan(0.02);
  });

  it("daylight never decreases from dawn through morning into noon, and glides with no jumps all day", () => {
    let prev = -1;
    for (let m = hm(5, 15); m <= hm(13, 30); m++) {
      const d = computeAmbience(at(0, m), null, AUTO).daylight;
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    let last = computeAmbience(at(0, 0), null, AUTO);
    for (let m = 1; m < 1440; m++) {
      const cur = computeAmbience(at(0, m), null, AUTO);
      expect(Math.abs(cur.daylight - last.daylight)).toBeLessThan(0.02);
      expect(Math.abs(cur.tint.alpha - last.tint.alpha)).toBeLessThan(0.02);
      last = cur;
    }
  });

  it("phase characteristics: dawn/dusk dim, evening mid, afternoon bright, dusk goes purple", () => {
    const dl = (h: number, m: number) => computeAmbience(at(h, m), null, AUTO).daylight;
    expect(dl(6, 0)).toBeCloseTo(0.425, 2);
    expect(dl(17, 5)).toBeCloseTo(0.675, 1);
    expect(dl(15, 0)).toBeCloseTo(0.9, 1);
    const dusk = computeAmbience(at(18, 10), null, AUTO);
    expect(dusk.phase).toBe("dusk");
    expect(dusk.lightsOn).toBe(true);
    const [r, g, b] = rgb(dusk.tint.color);
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g); // orange mixing into night blue
    const evening = computeAmbience(at(17), null, AUTO);
    expect(evening).toMatchObject({ phase: "evening", lightsOn: true, stayIndoors: false });
  });

  it("rain this afternoon: overcast grey-blue grade, darker, campfire out, everyone indoors", () => {
    const clear = computeAmbience(at(15), null, AUTO);
    const rain = computeAmbience(at(15), wire("rain", { intensity: 0.8 }), AUTO);
    expect(rain).toMatchObject({ phase: "afternoon", weather: "rain", intensity: 0.8, wind: 0.3, lightsOn: true, campfireLit: false, stayIndoors: true });
    expect(rain.daylight).toBeLessThan(clear.daylight);
    expect(rain.tint.alpha).toBeGreaterThan(clear.tint.alpha);
    const [r, g, b] = rgb(rain.tint.color);
    expect(b).toBeGreaterThan(r - 40); // desaturated towards grey-blue
    expect(Math.abs(r - g)).toBeLessThan(80);
    expect(computeAmbience(at(15), wire("rain", { intensity: 0.5 }), AUTO).lightsOn).toBe(false);
  });

  it("each weather's effects", () => {
    const amb = (k: WeatherKind, intensity = 0.8) => computeAmbience(at(12, 30), wire(k, { intensity }), AUTO);
    expect(amb("storm")).toMatchObject({ lightsOn: true, campfireLit: false, stayIndoors: true });
    expect(amb("snow")).toMatchObject({ lightsOn: false, campfireLit: false, stayIndoors: true });
    expect(amb("drizzle", 0.4)).toMatchObject({ campfireLit: false, stayIndoors: false });
    expect(amb("drizzle", 0.6).stayIndoors).toBe(true);
    for (const k of ["cloudy", "fog"] as const) {
      const a = amb(k);
      expect(a).toMatchObject({ lightsOn: false, campfireLit: true, stayIndoors: false });
      expect(a.daylight).toBeLessThan(1);
      expect(a.tint.alpha).toBeGreaterThan(0);
    }
    expect(amb("storm").daylight).toBeLessThan(amb("cloudy").daylight);
  });

  it("sanitises the wire: intensity clamped / NaN → 0, wind clamped to ±1 / NaN → 0", () => {
    expect(computeAmbience(at(15), wire("rain", { intensity: 3, wind: 5 }), AUTO)).toMatchObject({ intensity: 1, wind: 1 });
    expect(computeAmbience(at(15), wire("rain", { intensity: -1, wind: -5 }), AUTO)).toMatchObject({ intensity: 0, wind: -1 });
    expect(computeAmbience(at(15), wire("rain", { intensity: NaN, wind: NaN }), AUTO)).toMatchObject({ intensity: 0, wind: 0 });
  });

  it("overrides win: a forced phase shows its middle, a forced weather its default intensity unless it is the live one", () => {
    const n = computeAmbience(at(23), null, { weather: "auto", phase: "noon" });
    expect(n).toMatchObject({ phase: "noon", daylight: 1, stayIndoors: false });
    const night = computeAmbience(at(12), null, { weather: "auto", phase: "night" });
    expect(night).toMatchObject({ phase: "night", stayIndoors: true, lightsOn: true });
    expect(computeAmbience(at(12), null, { weather: "auto", phase: "dawn" }).daylight).toBeCloseTo(0.425, 3);

    const live = wire("rain", { intensity: 0.4 });
    expect(computeAmbience(at(15), live, { weather: "storm", phase: "auto" })).toMatchObject({ weather: "storm", intensity: 1 });
    expect(computeAmbience(at(15), live, { weather: "rain", phase: "auto" }).intensity).toBe(0.4);
    expect(computeAmbience(at(15), live, { weather: "clear", phase: "auto" })).toMatchObject({ weather: "clear", intensity: 0, campfireLit: true });
    expect(computeAmbience(at(15), null, { weather: "snow", phase: "auto" })).toMatchObject({ weather: "snow", intensity: 0.6, wind: 0 });
    expect(computeAmbience(at(15), null, { weather: "clear", phase: "auto" }).intensity).toBe(0);
  });

  it("tint is always a #rrggbb colour with alpha in [0, 1]", () => {
    const kinds: WeatherKind[] = ["clear", "cloudy", "fog", "drizzle", "rain", "snow", "storm"];
    for (const k of kinds)
      for (let h = 0; h < 24; h++) {
        const a = computeAmbience(at(h, 17), wire(k, { intensity: 1 }), AUTO);
        expect(a.tint.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(a.tint.alpha).toBeGreaterThanOrEqual(0);
        expect(a.tint.alpha).toBeLessThanOrEqual(1);
        expect(a.daylight).toBeGreaterThanOrEqual(0);
        expect(a.daylight).toBeLessThanOrEqual(1);
      }
  });
});

describe("the city's sun and moon (Ambience.arc)", () => {
  const at = (h: number, m = 0, weather: WeatherWire | null = null) =>
    computeAmbience(new Date(2026, 9, 15, h, m), weather, { weather: "auto", phase: "auto" }).arc;

  it("puts the sun up from sunrise to sunset and the moon up the rest of the night, each crossing left to right", () => {
    expect(at(6)).toEqual({ body: "sun", t: 0 });
    expect(at(12)).toEqual({ body: "sun", t: 0.5 });
    expect(at(17, 59)!.t).toBeCloseTo(719 / 720);
    expect(at(18)).toEqual({ body: "moon", t: 0 });
    expect(at(0)).toEqual({ body: "moon", t: 0.5 });
    expect(at(23)!.t).toBeLessThan(at(3)!.t);
    expect(at(5, 59)).toMatchObject({ body: "moon" });
  });

  it("follows the report's sunrise and sunset — one past midnight keeps the sun up until it really sets", () => {
    const reykjavik: WeatherWire = {
      kind: "clear",
      intensity: 0,
      temperatureC: 9,
      wind: 0,
      sunriseMs: new Date(2026, 5, 21, 2, 55).getTime(),
      sunsetMs: new Date(2026, 5, 21, 0, 3).getTime(),
      place: "Reykjavík",
      fetchedAtMs: 0,
    };
    expect(at(23, 50, reykjavik)).toMatchObject({ body: "sun" });
    expect(at(0, 1, reykjavik)).toMatchObject({ body: "sun" });
    expect(at(1, 0, reykjavik)).toMatchObject({ body: "moon" });
    expect(at(3, 0, reykjavik)).toMatchObject({ body: "sun" });
  });

  it("puts a FORCED phase's body where that phase's middle would be", () => {
    const forced = (phase: DayPhase) => computeAmbience(new Date(2026, 9, 15, 3, 0), null, { weather: "auto", phase }).arc;
    expect(forced("noon")).toEqual({ body: "sun", t: 0.5 });
    expect(forced("morning")!.t).toBeLessThan(forced("afternoon")!.t);
    expect(forced("night")).toEqual({ body: "moon", t: 0.5 });
    expect(["dawn", "morning", "noon", "afternoon", "evening", "dusk"].map((p) => forced(p as DayPhase)!.body)).toEqual(
      Array(6).fill("sun"),
    );
  });
});

// ───────────────────────────── the City's sky ─────────────────────────────

/** Tokyo, 2026-10-19: sunrise 05:52, sunset 17:05 — so 16:19 is Evening. */
const TOKYO = (kind: WeatherKind = "clear", intensity = 0): WeatherWire => ({
  kind,
  intensity,
  temperatureC: 24,
  wind: 0,
  sunriseMs: new Date(2026, 9, 19, 5, 52).getTime(),
  sunsetMs: new Date(2026, 9, 19, 17, 5).getTime(),
  place: "Tokyo",
  fetchedAtMs: 0,
});
const tokyo = (h: number, m = 0, w: WeatherWire = TOKYO()) => computeAmbience(new Date(2026, 9, 19, h, m), w, AUTO);
const forced = (phase: DayPhase) => computeAmbience(new Date(2026, 9, 19, 3, 0), null, { weather: "auto", phase });

/** HSL of a #rrggbb: hue in degrees, saturation and lightness 0..1. */
function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return { h, s, l };
}
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** What the viewer SEES of every sky band (each band's paint, through the outdoor grade). */
const seenBands = (amb: ReturnType<typeof tokyo>) => citySky(amb).bands.map((b) => gradeColor(amb, b));
/** Is `h` (degrees) within [from, to], wrapping through 0? */
const hueIn = (h: number, from: number, to: number) => (from <= to ? h >= from && h <= to : h >= from || h <= to);

describe("Ambience.progress", () => {
  it("says how far through its phase the clock is — 16:19 with a 17:05 sunset is 44 of evening's 70 minutes", () => {
    const a = tokyo(16, 19);
    expect(a.phase).toBe("evening");
    expect(a.progress).toBeCloseTo(44 / 70, 4);
    // Each phase starts at 0 (evening at sunset − 90, dusk at sunset − 20).
    expect(tokyo(15, 35)).toMatchObject({ phase: "evening", progress: 0 });
    expect(tokyo(16, 45)).toMatchObject({ phase: "dusk", progress: 0 });
    expect(tokyo(17, 15).progress).toBeCloseTo(30 / 60, 4);
    // A forced phase is shown at its middle; night has no span its sky changes over.
    for (const p of ["morning", "afternoon", "evening", "night"] as DayPhase[]) expect(forced(p).progress).toBe(0.5);
    expect(tokyo(23).progress).toBe(0);
  });
});

describe("skyClock", () => {
  it("is the phase's index plus its progress — night 0, dawn 1…, dusk …7 — and forced phases sit mid-phase", () => {
    expect(skyClock(tokyo(23))).toBe(0);
    expect(skyClock(tokyo(12, 30))).toBeCloseTo(3.5, 3);
    expect(skyClock(tokyo(16, 19))).toBeCloseTo(5 + 44 / 70, 4);
    expect(skyClock(tokyo(17, 5))).toBeCloseTo(6 + 1 / 3, 4); // sunset itself
    expect([skyClock(forced("morning")), skyClock(forced("afternoon")), skyClock(forced("evening"))]).toEqual([2.5, 4.5, 5.5]);
    expect(skyClock({ phase: "noon" })).toBe(3.5); // absent progress = mid-phase
    expect(skyClock({ phase: "noon", progress: NaN })).toBe(3.5);
  });

  it("only ever moves forward, in small steps, from dawn to the end of dusk", () => {
    let prev = skyClock(tokyo(5, 7)); // dawn starts at sunrise − 45 min
    expect(prev).toBeCloseTo(1, 3);
    for (let m = 5 * 60 + 8; m < 17 * 60 + 45; m++) {
      const s = skyClock(tokyo(0, m));
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s - prev).toBeLessThan(0.05);
      prev = s;
    }
    expect(prev).toBeGreaterThan(6.98);
    expect(skyClock(tokyo(17, 45))).toBe(0); // and night is 0 again: the same sky as 7
  });
});

describe("dayWeight / litShare", () => {
  it("leaves the plain day alone from late morning to mid-afternoon, and owns the sky from golden hour to the next morning", () => {
    expect([2.8, 3, 3.5, 4, 4.5].map(dayWeight)).toEqual([0, 0, 0, 0, 0]);
    expect([0, 1, 1.5, 2, 5, 5.6, 6.5, 7].map(dayWeight)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(dayWeight(2.4)).toBeCloseTo(0.5);
    expect(dayWeight(4.75)).toBeCloseTo(0.5);
  });

  it("lights no far window by day, the first ones just before 4 pm for a 17:05 sunset, more each minute after, the most at night", () => {
    expect(litShare(skyClock(tokyo(12)))).toBe(0);
    expect(litShare(skyClock(tokyo(15, 50)))).toBe(0);
    expect(litShare(skyClock(tokyo(16, 5)))).toBeGreaterThan(0);
    expect(litShare(skyClock(tokyo(16, 19)))).toBeGreaterThan(0.02);
    let prev = 0;
    for (let m = 13 * 60 + 30; m < 17 * 60 + 45; m++) {
      const v = litShare(skyClock(tokyo(0, m)));
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    const night = litShare(skyClock(tokyo(21)));
    expect(night).toBeGreaterThanOrEqual(prev);
    expect(night).toBeGreaterThan(0.3);
    expect(night).toBeLessThan(0.5);
    // They go out through dawn, and the morning has none.
    expect(litShare(skyClock(tokyo(5, 40)))).toBeLessThan(night);
    expect(litShare(skyClock(tokyo(7)))).toBe(0);
    for (const s of [-1, 0, 3.5, 7, 9]) expect(litShare(s)).toBeGreaterThanOrEqual(0);
  });
});

describe("gradeColor (the outdoor grade as arithmetic)", () => {
  it("is paintAmbience's two layers composited over a pixel: the tint at its capped alpha, then the veil", () => {
    // A hand-worked case: #808080 under #ff0000 at 0.25, then a storm veil (0.24 at intensity 1) of #6f7684.
    const amb = { tint: { color: "#ff0000", alpha: 0.25 }, weather: "storm" as const, intensity: 1 };
    expect(veilAlpha(amb)).toBe(0.24);
    const tinted = [128 * 0.75 + 255 * 0.25, 128 * 0.75, 128 * 0.75];
    const seen = [0x6f, 0x76, 0x84].map((v, i) => Math.round(tinted[i] * 0.76 + v * 0.24));
    expect(rgb(gradeColor(amb, "#808080"))).toEqual(seen);
    // No grade at all leaves a colour alone; an alpha past 1 is capped like the painter caps it.
    expect(gradeColor({ tint: { color: "#000", alpha: 0 }, weather: "clear", intensity: 0 }, "#4c8ddf")).toBe("#4c8ddf");
    expect(gradeColor({ tint: { color: "#123", alpha: 3 }, weather: "fog", intensity: 1 }, "#4c8ddf")).toBe("#112233");
    expect(VEIL.clear).toBe(0);
  });
});

describe("citySky — the City's sky through the day", () => {
  it("noon is the plain day the City always had: the ten day bands, the yellow sun, no glow, no windows lit", () => {
    const noon = citySky(tokyo(12, 30));
    expect(noon.bands).toHaveLength(SKY_BANDS);
    expect([...new Set(noon.bands)]).toEqual([...CITY_DAY.sky]);
    expect(noon.sun).toEqual({ color: CITY_DAY.sun, core: CITY_DAY.sunCore, glow: "rgba(255, 236, 160, 0.35)", r: 7 });
    expect(noon.bloom.alpha).toBe(0);
    expect(noon.lit).toBe(0);
    expect(noon.skyline).toEqual({ block: CITY_DAY.skyline, edge: CITY_DAY.skylineEdge, pane: CITY_DAY.skylinePane });
    // No ambience at all is the same plain day.
    expect(citySky(undefined).bands).toEqual(noon.bands);
    // Mid-afternoon too (the panel's 15:00 with the default 18:00 sunset): the day bands, under the grade as before.
    expect([...new Set(citySky(computeAmbience(at(15), null, AUTO)).bands)]).toEqual([...CITY_DAY.sky]);
  });

  it("16:19 with a 17:05 sunset is GOLDEN HOUR: a warm gold horizon under a still-blue top — not the old grey lavender", () => {
    const sky = seenBands(tokyo(16, 19));
    const top = hsl(sky[0]);
    const low = hsl(sky[SKY_BANDS - 2]);
    expect(hueIn(top.h, 200, 230)).toBe(true); // blue up high
    expect(hueIn(low.h, 22, 50)).toBe(true); // gold low
    expect(low.s).toBeGreaterThan(0.6);
    const [r, , b] = rgb(sky[SKY_BANDS - 2]);
    expect(r - b).toBeGreaterThan(80);
    // The warmth climbs a good part of the sky, not just the band the skyline hides.
    expect(seenBands(tokyo(16, 19)).filter((c) => rgb(c)[0] > rgb(c)[2] + 30).length).toBeGreaterThanOrEqual(SKY_BANDS / 4);
  });

  it("dusk is a SUNSET: orange at the horizon, through pink and violet, to deep blue overhead", () => {
    const sky = seenBands(tokyo(16, 55));
    expect(hueIn(hsl(sky[SKY_BANDS - 1]).h, 10, 40)).toBe(true); // orange
    expect(hsl(sky[SKY_BANDS - 1]).s).toBeGreaterThan(0.6);
    expect(sky.some((c) => hueIn(hsl(c).h, 300, 355) && hsl(c).s > 0.25)).toBe(true); // pink / magenta
    expect(sky.some((c) => hueIn(hsl(c).h, 250, 299))).toBe(true); // violet
    const top = rgb(sky[0]);
    expect(top[2]).toBeGreaterThan(top[0] + 40); // deep blue
    expect(lum(sky[0])).toBeLessThan(110);
    // After sunset the twilight sky is darker overhead than the sunset's, and still warm low.
    const twilight = seenBands(tokyo(17, 20));
    expect(lum(twilight[0])).toBeLessThan(lum(sky[0]));
    expect(rgb(twilight[SKY_BANDS - 1])[0]).toBeGreaterThan(rgb(twilight[SKY_BANDS - 1])[2]);
  });

  it("night is deep navy, a little lighter at the horizon (the city's glow); dawn is pink and peach", () => {
    const night = seenBands(tokyo(21));
    for (const c of night) expect(lum(c)).toBeLessThan(60);
    for (const c of night) expect(rgb(c)[2]).toBeGreaterThan(rgb(c)[0]);
    expect(lum(night[SKY_BANDS - 1])).toBeGreaterThan(lum(night[0]));
    const dawn = seenBands(tokyo(5, 55)); // just past sunrise
    const low = hsl(dawn[SKY_BANDS - 1]);
    expect(hueIn(low.h, 0, 40) || hueIn(low.h, 330, 360)).toBe(true);
    expect(rgb(dawn[0])[2]).toBeGreaterThan(rgb(dawn[0])[0]); // still blue overhead
  });

  it("each forced phase of the HUD chip has its look: Morning and Afternoon blue, Evening golden, Night navy", () => {
    const look = (p: DayPhase) => seenBands(forced(p));
    for (const p of ["morning", "afternoon"] as DayPhase[]) {
      const sky = look(p);
      expect(rgb(sky[0])[2]).toBeGreaterThan(rgb(sky[0])[0] + 80);
      expect(rgb(sky[SKY_BANDS - 1])[2]).toBeGreaterThanOrEqual(rgb(sky[SKY_BANDS - 1])[0] - 10);
    }
    const evening = look("evening");
    expect(hueIn(hsl(evening[SKY_BANDS - 2]).h, 22, 50)).toBe(true);
    expect(rgb(evening[SKY_BANDS - 2])[0] - rgb(evening[SKY_BANDS - 2])[2]).toBeGreaterThan(60);
    expect(look("night").every((c) => lum(c) < 60)).toBe(true);
    // Morning is not just the afternoon again: its low sky is paler and warmer.
    expect(look("morning")[SKY_BANDS - 1]).not.toBe(look("afternoon")[SKY_BANDS - 1]);
  });

  it("the sun grows and reddens as it nears the horizon; clouds catch the light, and a storm's stay dark", () => {
    const sun = (h: number, m: number) => citySky(tokyo(h, m)).sun;
    expect(sun(12, 0).r).toBe(7);
    expect(hueIn(hsl(gradeColor(tokyo(12), sun(12, 0).color)).h, 45, 60)).toBe(true); // yellow
    let r = 7;
    for (let m = 12 * 60; m < 17 * 60 + 5; m += 5) {
      expect(sun(0, m).r).toBeGreaterThanOrEqual(r);
      r = sun(0, m).r;
    }
    expect(sun(16, 55).r).toBeGreaterThanOrEqual(10);
    expect(hueIn(hsl(gradeColor(tokyo(16, 55), sun(16, 55).color)).h, 5, 32)).toBe(true); // orange-red
    // Clouds: a fair one's underside goes pink/orange at sunset; at night they are dark.
    const sunset = tokyo(17, 5);
    const under = rgb(gradeColor(sunset, citySky(sunset).cloud.light.under));
    expect(under[0]).toBeGreaterThan(under[1] + 50);
    expect(lum(gradeColor(tokyo(21), citySky(tokyo(21)).cloud.light.body))).toBeLessThan(80);
    const storm = tokyo(17, 5, TOKYO("storm", 1));
    expect(lum(gradeColor(storm, citySky(storm).cloud.storm.body))).toBeLessThan(lum(gradeColor(sunset, citySky(sunset).cloud.light.body)));
  });

  it("weather greys the sunset: rain at dusk is the same sky, less saturated", () => {
    const clear = hsl(seenBands(tokyo(16, 55))[SKY_BANDS - 1]);
    const rain = hsl(seenBands(tokyo(16, 55, TOKYO("rain", 0.8)))[SKY_BANDS - 1]);
    expect(rain.s).toBeLessThan(clear.s - 0.2);
    expect(citySky(tokyo(16, 55, TOKYO("rain", 0.8))).bloom.alpha).toBeLessThan(citySky(tokyo(16, 55)).bloom.alpha);
  });

  // The steepest real step is twilight falling (~8 of 255 per channel per minute at 17:28); a pop
  // at a phase edge or a missing ramp is 30+.
  it("never pops: every colour the sky paints moves at most 12/255 from one minute to the next, all day, in any weather", () => {
    const diff = (a: string, b: string) => Math.max(...rgb(a).map((v, i) => Math.abs(v - rgb(b)[i])));
    for (const w of [TOKYO(), TOKYO("rain", 0.8), null]) {
      const amb = (m: number) => computeAmbience(new Date(2026, 9, 19, 0, m), w, AUTO);
      const seen = (a: ReturnType<typeof amb>) => {
        const k = citySky(a);
        const g = (c: string) => gradeColor(a, c);
        // The glow is a translucent wash: what shows of it is its colour × its alpha.
        const bloom = rgb(g(k.bloom.color)).map((v) => Math.round(v * k.bloom.alpha));
        const wash = "#" + bloom.map((v) => v.toString(16).padStart(2, "0")).join("");
        return [...k.bands.map(g), g(k.sun.color), g(k.sun.core), g(k.cloud.light.body), g(k.cloud.light.under), g(k.skyline.block), g(k.skyline.pane), wash];
      };
      let prevAmb = amb(0);
      let prev = seen(prevAmb);
      for (let m = 1; m <= 1440; m++) {
        const a = amb(m);
        const cur = seen(a);
        for (let i = 0; i < cur.length; i++) expect([m, i, diff(cur[i], prev[i])]).toEqual([m, i, expect.toSatisfy((d: number) => d <= 12)]);
        expect(Math.abs(citySky(a).lit - citySky(prevAmb).lit)).toBeLessThan(0.01);
        expect(Math.abs(citySky(a).sun.r - citySky(prevAmb).sun.r)).toBeLessThanOrEqual(1);
        prevAmb = a;
        prev = cur;
      }
    }
  });

  it("is painted through the grade's inverse, so the grade lands on the sky ONCE (within a unit of rounding, where reachable)", () => {
    // At 16:19 the evening's warm tint is ~0.19: painting the target colours as-is would tint them twice.
    const amb = tokyo(16, 19);
    expect(amb.tint.alpha).toBeGreaterThan(0.15);
    const paint = citySky(amb).bands;
    const seen = seenBands(amb);
    // The painted colours are NOT what is seen (they were pre-compensated), and seen ≠ paint graded twice.
    expect(paint).not.toEqual(seen);
    const twice = seen.map((c) => gradeColor(amb, c));
    expect(twice[SKY_BANDS - 2]).not.toBe(seen[SKY_BANDS - 2]);
  });
});

describe("the village's grade is untouched by the City's sky", () => {
  it("16:19 with a 17:05 sunset still grades the village exactly as before — the evening's warm tint, nothing else", () => {
    // Pinned values: CURVES (WARM → SUNSET across evening) were not changed by the sky work.
    expect(tokyo(16, 19).tint).toEqual({ color: "#ff8e42", alpha: 0.188 });
    expect(tokyo(16, 55).tint).toEqual({ color: "#cd654f", alpha: 0.287 });
    expect(tokyo(21).tint).toEqual({ color: "#0b1640", alpha: 0.55 });
  });
});

describe("citySky under an opaque grade", () => {
  it("paints the authored colours as they are — under a fully opaque grade nothing can be recovered, and nothing divides by zero", () => {
    const amb = computeAmbience(new Date(2026, 9, 19, 16, 19), null, { weather: "clear", phase: "auto" });
    const opaque = { ...amb, tint: { color: "#000000", alpha: 1 } };
    const look = citySky(opaque);
    expect(look.bands).toEqual(look.seen);
    expect(look.bands.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
    // An ordinary grade paints something else than it means (the inverse at work).
    expect(citySky(amb).bands).not.toEqual(citySky(amb).seen);
  });
});
