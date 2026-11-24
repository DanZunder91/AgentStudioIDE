/**
 * Ambience — the village's sky: which part of the day it is on the user's LOCAL
 * clock, how bright it is outdoors, the colour grade, and what the weather does to
 * the villagers (lamps on, campfire out, everyone indoors).
 *
 * Weather and time of day follow the user's local conditions: when it is raining there it rains
 * here, and in the afternoon it is afternoon outside the house. Pure: the clock is passed in (`now`) and only its LOCAL wall-clock fields
 * are read (`getHours`/`getMinutes`/`getSeconds`), so the result is the same on any
 * DST offset — 15:00 is afternoon whether the zone is UTC+1 or UTC+2 today.
 *
 * Also the City's sky (`citySky`): its colours per time of day, keyframed on `skyClock` (the
 * phase plus how far through it the clock is) and painted through the outdoor grade's inverse.
 */

import type { Ambience, DayPhase, PhaseOverride, WeatherKind, WeatherOverride, WeatherWire } from "../villageTypes";

/** Fallback sunrise / sunset (local minutes) when the weather report has none. */
export const DEFAULT_SUNRISE_MIN = 6 * 60;
export const DEFAULT_SUNSET_MIN = 18 * 60;
const DAY_MIN = 24 * 60;
/** Fixed noon window, local minutes (11:30–13:30). */
const NOON_START = 11 * 60 + 30;
const NOON_END = 13 * 60 + 30;

/** Minutes since local midnight of a Date (seconds included, so the curves glide). */
export function localMinutesOf(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function wrapDay(m: number): number {
  return ((m % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/**
 * Put sunrise, sunset and the clock on ONE unwrapped timeline. A sunset at or
 * before sunrise on the wall clock (Reykjavik in June: up 02:55, down 00:03) is
 * really after midnight, so it moves a day later; and a minute just past midnight
 * that still belongs to that late dusk moves a day later too, so dusk keeps
 * fading past 00:00 instead of snapping to night.
 */
function timeline(localMinutes: number, sunriseMin: number, sunsetMin: number): { m: number; sr: number; ss: number } {
  const m = wrapDay(localMinutes);
  const sr = sunriseMin;
  const ss = sunsetMin <= sr ? sunsetMin + DAY_MIN : sunsetMin;
  return { m: m < sr - 45 && m + DAY_MIN < ss + 40 ? m + DAY_MIN : m, sr, ss };
}

/**
 * The part of the day at `localMinutes` (minutes since local midnight). Sunrise /
 * sunset default to 06:00 / 18:00 when null; a sunset past midnight is handled.
 * Windows:
 *   dawn sunrise±45m · morning → 11:30 · noon 11:30–13:30 · afternoon → sunset−90m
 *   · evening → sunset−20m · dusk → sunset+40m · night otherwise.
 */
export function dayPhaseAt(localMinutes: number, sunriseMin: number | null, sunsetMin: number | null): DayPhase {
  const { m, sr, ss } = timeline(localMinutes, sunriseMin ?? DEFAULT_SUNRISE_MIN, sunsetMin ?? DEFAULT_SUNSET_MIN);
  if (m >= sr - 45 && m < sr + 45) return "dawn";
  if (m >= ss - 20 && m < ss + 40) return "dusk";
  if (m >= ss - 90 && m < ss - 20) return "evening";
  if (m < sr - 45 || m >= ss + 40) return "night";
  if (m < NOON_START) return "morning";
  if (m < NOON_END) return "noon";
  return "afternoon";
}

// ───────────────────────────── grading curves ─────────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Grade {
  color: Rgb;
  alpha: number;
}

/** `#rrggbb` (or the short `#rgb`) → channels. */
function hex(h: string): Rgb {
  const body = h.length === 4 ? h.slice(1).replace(/./g, (d) => d + d) : h.slice(1);
  const n = parseInt(body, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const NIGHT: Grade = { color: hex("#0b1640"), alpha: 0.55 };
const DAWN_GLOW: Grade = { color: hex("#ff9a7a"), alpha: 0.16 };
const CLEAR_DAY: Grade = { color: hex("#fff4d6"), alpha: 0 };
const WARM: Grade = { color: hex("#ffb060"), alpha: 0.1 };
const SUNSET: Grade = { color: hex("#ff7a30"), alpha: 0.24 };
const TWILIGHT: Grade = { color: hex("#6a3a8c"), alpha: 0.38 };

/**
 * Daylight at the START and END of each phase, and the tint stops spread evenly
 * across it; values match across boundaries so the sky never pops.
 */
const CURVES: Record<DayPhase, { light: [number, number]; tint: Grade[] }> = {
  night: { light: [0.15, 0.15], tint: [NIGHT, NIGHT] },
  dawn: { light: [0.15, 0.7], tint: [NIGHT, DAWN_GLOW] },
  morning: { light: [0.7, 1], tint: [DAWN_GLOW, CLEAR_DAY] },
  noon: { light: [1, 1], tint: [CLEAR_DAY, CLEAR_DAY] },
  afternoon: { light: [1, 0.8], tint: [CLEAR_DAY, WARM] },
  evening: { light: [0.8, 0.55], tint: [WARM, SUNSET] },
  dusk: { light: [0.55, 0.15], tint: [SUNSET, TWILIGHT, NIGHT] },
};

/** [start, end) local minutes of `phase` (night has no meaningful span — callers use t = 0). */
function phaseWindow(phase: DayPhase, sr: number, ss: number): [number, number] {
  switch (phase) {
    case "dawn":
      return [sr - 45, sr + 45];
    case "morning":
      return [sr + 45, NOON_START];
    case "noon":
      return [NOON_START, NOON_END];
    case "afternoon":
      return [NOON_END, ss - 90];
    case "evening":
      return [ss - 90, ss - 20];
    case "dusk":
      return [ss - 20, ss + 40];
    default:
      return [0, 0];
  }
}

/** How far through its phase `m` is, 0..1 (0 for a degenerate window). */
function phaseProgress(phase: DayPhase, m: number, sr: number, ss: number): number {
  const [start, end] = phaseWindow(phase, sr, ss);
  return end > start ? clamp01((m - start) / (end - start)) : 0;
}

/** How much each weather greys + darkens the outdoors at full intensity. */
const OVERCAST: Record<WeatherKind, number> = {
  clear: 0,
  cloudy: 0.35,
  fog: 0.5,
  drizzle: 0.4,
  rain: 0.55,
  snow: 0.25,
  storm: 0.75,
};
const OVERCAST_GREY = hex("#5a6478");

/** Intensity used when the user forces a weather the live report doesn't have. */
const DEFAULT_INTENSITY: Record<WeatherKind, number> = {
  clear: 0,
  cloudy: 0.6,
  fog: 0.6,
  drizzle: 0.3,
  rain: 0.7,
  snow: 0.6,
  storm: 1,
};

/** The tint `t` (0..1) of the way through evenly spaced `stops`. */
function sampleTint(stops: Grade[], t: number): Grade {
  const span = stops.length - 1;
  const i = Math.min(span - 1, Math.floor(t * span));
  const u = t * span - i;
  const a = stops[i];
  const b = stops[i + 1];
  return { color: lerpRgb(a.color, b.color, u), alpha: lerp(a.alpha, b.alpha, u) };
}

const finiteOr = (v: number, d: number) => (Number.isFinite(v) ? v : d);

/** Where a FORCED phase puts the sun or moon (its middle, as `computeAmbience` grades it). */
const FORCED_ARC: Record<DayPhase, NonNullable<Ambience["arc"]>> = {
  dawn: { body: "sun", t: 0.03 },
  morning: { body: "sun", t: 0.25 },
  noon: { body: "sun", t: 0.5 },
  afternoon: { body: "sun", t: 0.7 },
  evening: { body: "sun", t: 0.88 },
  dusk: { body: "sun", t: 0.97 },
  night: { body: "moon", t: 0.5 },
};

/**
 * The sun from sunrise to sunset, the moon from sunset to the next sunrise, each by how far
 * through its span `m` is — all on `timeline`'s unwrapped minutes, so a sunset past midnight
 * keeps the sun up until it really sets.
 */
export function skyArc(m: number, sr: number, ss: number): NonNullable<Ambience["arc"]> {
  if (m >= sr && m < ss) return { body: "sun", t: (m - sr) / (ss - sr) };
  const since = m >= ss ? m - ss : m + DAY_MIN - ss;
  return { body: "moon", t: clamp01(since / (sr + DAY_MIN - ss)) };
}

/** `base` with a grey-blue overcast layer composited OVER it (`g` = that layer's alpha). */
function overcast(base: Grade, g: number): Grade {
  if (g <= 0) return base;
  const alpha = g + base.alpha * (1 - g);
  const w = g / alpha;
  return { color: lerpRgb(base.color, OVERCAST_GREY, w), alpha };
}

/**
 * Everything the renderer needs for the sky this frame. `now`'s local wall clock
 * picks the phase (sunrise/sunset from `weather` when it has them); `weather` null →
 * clear, calm. HUD overrides win over the live values. `zone` (the machine's IANA time zone)
 * is carried through for the City's skyline landmarks.
 */
export function computeAmbience(
  now: Date,
  weather: WeatherWire | null,
  override: { weather: WeatherOverride; phase: PhaseOverride },
  zone?: string,
): Ambience {
  const { m, sr, ss } = timeline(
    localMinutesOf(now),
    weather?.sunriseMs != null ? localMinutesOf(new Date(weather.sunriseMs)) : DEFAULT_SUNRISE_MIN,
    weather?.sunsetMs != null ? localMinutesOf(new Date(weather.sunsetMs)) : DEFAULT_SUNSET_MIN,
  );

  const autoPhase = override.phase === "auto";
  const phase: DayPhase = override.phase === "auto" ? dayPhaseAt(m, sr, ss) : override.phase;
  // A forced phase shows its middle; the live clock glides through it.
  const t = autoPhase ? phaseProgress(phase, m, sr, ss) : 0.5;

  const liveKind = weather?.kind ?? "clear";
  const kind = override.weather === "auto" ? liveKind : override.weather;
  const liveIntensity = clamp01(finiteOr(weather?.intensity ?? 0, 0));
  const intensity = kind === liveKind && weather ? liveIntensity : DEFAULT_INTENSITY[kind];
  const wind = Math.min(1, Math.max(-1, finiteOr(weather?.wind ?? 0, 0)));

  const curve = CURVES[phase];
  const strength = OVERCAST[kind] * (0.5 + 0.5 * intensity);
  const daylight = clamp01(lerp(curve.light[0], curve.light[1], t) * (1 - 0.5 * strength));
  const grade = overcast(sampleTint(curve.tint, t), strength * 0.45);

  const wet = kind === "rain" || kind === "drizzle" || kind === "snow" || kind === "storm";
  return {
    phase,
    progress: t,
    daylight,
    tint: { color: toHex(grade.color), alpha: Math.round(grade.alpha * 1000) / 1000 },
    weather: kind,
    intensity,
    wind,
    lightsOn: phase === "night" || phase === "dusk" || phase === "evening" || kind === "storm" || (kind === "rain" && intensity > 0.6),
    campfireLit: !wet,
    stayIndoors: kind === "rain" || kind === "storm" || kind === "snow" || (kind === "drizzle" && intensity > 0.5) || phase === "night",
    arc: autoPhase ? skyArc(m, sr, ss) : FORCED_ARC[phase],
    ...(zone && { zone }),
  };
}

// ───────────────────────────── the outdoor grade, as arithmetic ─────────────────────────────

/** Overcast veil strength per weather (scaled by intensity) that `paintAmbience` lays over the grade; clear/fog get none. */
export const VEIL: Record<WeatherKind, number> = {
  clear: 0,
  cloudy: 0.14,
  fog: 0,
  drizzle: 0.1,
  rain: 0.16,
  snow: 0.08,
  storm: 0.24,
};
/** The veil's colour. */
export const VEIL_COLOR = "#6f7684";

/** The veil's alpha this frame. */
export function veilAlpha(amb: Pick<Ambience, "weather" | "intensity">): number {
  return VEIL[amb.weather] * (0.5 + 0.5 * amb.intensity);
}

/**
 * The outdoor grade as one affine map, `seen = paint·k + c`: exactly what `paintAmbience` does to an
 * opaque outdoor pixel — the tint at its (capped) alpha, then the veil over that.
 */
function gradeMap(amb: Pick<Ambience, "tint" | "weather" | "intensity">): { k: number; c: Rgb } {
  const a = amb.tint.alpha > 0 ? Math.min(1, amb.tint.alpha) : 0;
  const v = veilAlpha(amb);
  const tint = hex(amb.tint.color);
  const veil = hex(VEIL_COLOR);
  const k = (1 - a) * (1 - v);
  const ch = (t: number, w: number) => t * a * (1 - v) + w * v;
  return { k, c: { r: ch(tint.r, veil.r), g: ch(tint.g, veil.g), b: ch(tint.b, veil.b) } };
}

/** The colour a pixel painted `paint` is SEEN as once the outdoor grade has gone over it. */
export function gradeColor(amb: Pick<Ambience, "tint" | "weather" | "intensity">, paint: string): string {
  const { k, c } = gradeMap(amb);
  const p = hex(paint);
  return toHex({ r: p.r * k + c.r, g: p.g * k + c.g, b: p.b * k + c.b });
}

/**
 * The colour to PAINT so that, after the outdoor grade, the viewer sees `seen` — the grade's inverse,
 * clamped to what a canvas can hold (a grade at alpha `a` caps how bright and how dark anything under
 * it can end up; past that cap the nearest reachable colour is the answer).
 */
function ungrade(map: { k: number; c: Rgb }, seen: Rgb): Rgb {
  if (map.k < 1e-6) return seen;
  const ch = (s: number, c: number) => Math.min(255, Math.max(0, (s - c) / map.k));
  return { r: ch(seen.r, map.c.r), g: ch(seen.g, map.c.g), b: ch(seen.b, map.c.b) };
}

// ───────────────────────────── the City's sky ─────────────────────────────
//
// On a City still at 16:19 in Tokyo, sunset 17:05, the sky did not look
// like 4 pm, and a sunset would suit that hour better. The sky used to be ONE day
// gradient, tinted by the outdoor grade — and an orange tint at alpha ≤ 0.24 over blue makes
// grey-lavender, never a sunset. So the City's sky now has its own colours per time of day,
// keyframed on `skyClock` and blended between neighbours, so it glides minute by minute.
//
// The grade still goes over the WHOLE city, sky included: everything standing in the sky (trees,
// lamps, landmarks, the far skyline's neighbours) must be lit exactly like the street, and the
// village (no sky) must not change at all. The sky's colours are therefore authored as SEEN and
// painted through the grade's inverse (`ungrade`), so the grade lands on them exactly once.
// Through the plain day (late morning → mid-afternoon) the sky is the old day sky under the
// grade, unchanged — `CITY_DAY` is painted as it always was.

const PHASE_ORDER: readonly DayPhase[] = ["night", "dawn", "morning", "noon", "afternoon", "evening", "dusk"];

/**
 * Where in the day the sky is, as ONE continuous number: night 0 · dawn 1…2 · morning 2…3 ·
 * noon 3…4 · afternoon 4…5 · evening 5…6 · dusk 6…7 (and 7 is night again). Each phase ends exactly
 * where the next one starts, so the number never jumps — except 7 → 0, which is the same sky.
 */
export function skyClock(amb: Pick<Ambience, "phase" | "progress">): number {
  if (amb.phase === "night") return 0;
  return PHASE_ORDER.indexOf(amb.phase) + clamp01(finiteOr(amb.progress ?? 0.5, 0.5));
}

/** The noon look — the sky, sun, clouds and far skyline the City always had (render/city.ts `CITY`). */
export const CITY_DAY = {
  sky: ["#4c8ddf", "#5797e3", "#62a1e7", "#6eabeb", "#7bb5ef", "#89bff2", "#98c8f4", "#a8d1f6", "#b8daf8", "#c8e3f9"],
  sun: "#ffe27a",
  sunCore: "#fff3c2",
  sunGlow: { color: "#ffeca0", alpha: 0.35 },
  skyline: "#93abc6",
  skylineEdge: "#a7bcd3",
  skylinePane: "#7d94b1",
  cloud: { light: "#f4f7fb", grey: "#c3cad4", dark: "#8a93a1", storm: "#6c7482" },
  cloudUnder: "#e2e8f0",
} as const;

export type CloudShade = keyof typeof CITY_DAY.cloud;

/**
 * How many sky bands the City paints, top → horizon: twice the day's ten, so a sunset steps in
 * finer bands. By day each pair is one colour, and the painter merges equal neighbours — the
 * plain day is still exactly its ten bands.
 */
export const SKY_BANDS = 2 * CITY_DAY.sky.length;

/**
 * One keyframe of the City's look, as SEEN. `sky` holds five stops (top → horizon) at `SKY_STOPS`;
 * `cloud` / `under` are LIGHT colours a cloud's own shade is multiplied by (white = as by day), so a
 * storm cloud stays dark at sunset and a fair one turns gold.
 */
interface SkyKey {
  at: number;
  sky: readonly [string, string, string, string, string];
  sun: string;
  core: string;
  glow: string;
  glowA: number;
  r: number;
  /** The warm glow low on the sun's side of the sky; alpha 0 = none. */
  bloom: string;
  bloomA: number;
  cloud: string;
  under: string;
  block: string;
  edge: string;
  pane: string;
}

/** Where the five stops of a key's sky sit, 0 = top of the sky .. 1 = the horizon. */
const SKY_STOPS = [0, 0.35, 0.65, 0.88, 1] as const;

const NIGHT_KEY: Omit<SkyKey, "at"> = {
  sky: ["#060a20", "#0a1029", "#0e1634", "#141d42", "#1d2650"],
  sun: "#ffa050", core: "#ffd890", glow: "#ff9a60", glowA: 0.3, r: 10,
  bloom: "#000000", bloomA: 0,
  cloud: "#3c4466", under: "#30365a",
  block: "#121832", edge: "#1a2240", pane: "#0b0f26",
};

/** The keyframes, in `skyClock` order. Between two, every colour blends linearly. */
const KEYS: readonly SkyKey[] = [
  { at: 0, ...NIGHT_KEY },
  { at: 1, ...NIGHT_KEY }, // dawn starts (sunrise − 45 min)
  {
    at: 1.3, // first light
    sky: ["#18224e", "#2e3368", "#594a86", "#a46888", "#e0907e"],
    sun: "#ff9a50", core: "#ffd08a", glow: "#ff9070", glowA: 0.35, r: 10,
    bloom: "#ff9a80", bloomA: 0.22,
    cloud: "#a088b8", under: "#e89090",
    block: "#34345e", edge: "#5a4a78", pane: "#262648",
  },
  {
    at: 1.55, // sunrise: pink and peach
    sky: ["#3a5698", "#6670ac", "#b08ab4", "#f0a8a0", "#ffc898"],
    sun: "#ffa850", core: "#ffe0a0", glow: "#ffb080", glowA: 0.35, r: 9,
    bloom: "#ffb890", bloomA: 0.25,
    cloud: "#f2c8d4", under: "#ffb898",
    block: "#6e6c92", edge: "#d4a0a0", pane: "#56547a",
  },
  {
    at: 2, // morning (sunrise + 45 min): pale and fresh
    sky: ["#568fd8", "#79ade6", "#a4c8ec", "#d4e0ea", "#f2e4d2"],
    sun: "#ffd060", core: "#fff0b8", glow: "#ffe0a0", glowA: 0.35, r: 8,
    bloom: "#ffe8c8", bloomA: 0.1,
    cloud: "#fff6ee", under: "#f0dcd2",
    block: "#96a8c0", edge: "#c8cfd8", pane: "#8090aa",
  },
  {
    at: 2.8, // the plain day (the sky is `CITY_DAY` under the grade from here — see `dayWeight`)
    sky: ["#4c8ddf", "#6eabeb", "#93c6f3", "#b4d8f7", "#c8e3f9"],
    sun: "#ffe27a", core: "#fff3c2", glow: "#ffeca0", glowA: 0.35, r: 7,
    bloom: "#fff4d6", bloomA: 0,
    cloud: "#ffffff", under: "#e8edf3",
    block: "#93abc6", edge: "#a7bcd3", pane: "#7d94b1",
  },
  {
    at: 4.5, // mid-afternoon: still the plain day
    sky: ["#4c8ddf", "#6eabeb", "#93c6f3", "#b4d8f7", "#c8e3f9"],
    sun: "#ffe27a", core: "#fff3c2", glow: "#ffeca0", glowA: 0.35, r: 7,
    bloom: "#fff4d6", bloomA: 0,
    cloud: "#ffffff", under: "#e8edf3",
    block: "#93abc6", edge: "#a7bcd3", pane: "#7d94b1",
  },
  {
    at: 5, // sunset − 90 min: golden hour begins, a cream-gold horizon
    sky: ["#4f88d2", "#6fa6e2", "#a6c8e8", "#e8e2c4", "#f6dcaa"],
    sun: "#ffd25a", core: "#fff0b0", glow: "#ffd890", glowA: 0.35, r: 8,
    bloom: "#ffe0a0", bloomA: 0.14,
    cloud: "#fff0dc", under: "#f8d8a8",
    block: "#a2a8bc", edge: "#e0c8a0", pane: "#848ca4",
  },
  {
    at: 5.6, // golden hour: warm gold low, a softer blue high — light in between, never grey
    sky: ["#4a7cc4", "#86a8d4", "#e6d2b0", "#ffc882", "#ffb45a"],
    sun: "#ffb43c", core: "#ffe08a", glow: "#ffc070", glowA: 0.38, r: 9,
    bloom: "#ffc878", bloomA: 0.22,
    cloud: "#ffe4c4", under: "#ffc078",
    block: "#a294a8", edge: "#f0b878", pane: "#7c708c",
  },
  {
    at: 6, // sunset − 20 min: the sky catches fire
    sky: ["#3a5aa4", "#6a70aa", "#b88098", "#f49a6c", "#ff9644"],
    sun: "#ff8a2e", core: "#ffc068", glow: "#ff9a58", glowA: 0.4, r: 10,
    bloom: "#ffa060", bloomA: 0.28,
    cloud: "#f8c0b0", under: "#ff9a68",
    block: "#806c8c", edge: "#e09070", pane: "#605070",
  },
  {
    at: 6 + 1 / 3, // sunset: orange → coral → magenta → violet → deep blue
    sky: ["#283676", "#54468a", "#a85488", "#ee6a5c", "#ff7e34"],
    sun: "#ff5a24", core: "#ff9a50", glow: "#ff7048", glowA: 0.42, r: 11,
    bloom: "#ff7a50", bloomA: 0.3,
    cloud: "#d890a8", under: "#ff7a5a",
    block: "#4e3e6a", edge: "#a0607a", pane: "#3a2e56",
  },
  {
    at: 6 + 2 / 3, // twilight (sunset + 20 min)
    sky: ["#121a48", "#242a62", "#44367a", "#7c4a7c", "#c0645c"],
    sun: "#e8401e", core: "#ff7a40", glow: "#e0503a", glowA: 0.35, r: 11,
    bloom: "#d06058", bloomA: 0.2,
    cloud: "#6c5488", under: "#b0607a",
    block: "#26244a", edge: "#3c3260", pane: "#1c1a3a",
  },
  { at: 7, ...NIGHT_KEY }, // night (sunset + 40 min)
];

/**
 * How much the sky follows its own keyframes (1) rather than being the plain `CITY_DAY` sky under the
 * shared grade (0): 0 from late morning to mid-afternoon — the day looks as it always did — ramping
 * in over the morning and out into golden hour.
 */
export function dayWeight(s: number): number {
  if (s <= 2 || s >= 5) return 1;
  if (s < 2.8) return (2.8 - s) / 0.8;
  if (s > 4.5) return (s - 4.5) / 0.5;
  return 0;
}

/**
 * Share of the far skyline's windows with a light on, 0..1: none by day, the first few as golden hour
 * deepens (about 70 minutes before sunset — "after 4 pm" in Tokyo in October), more through sunset
 * and twilight, the most at night, going out again at dawn. Each window has its own threshold
 * (render/city.ts `windowLit`), so the set of lit windows only grows as this rises.
 */
const LIT: readonly [number, number][] = [
  [0, 0.4],
  [1, 0.4],
  [1.5, 0.12],
  [2, 0], // morning: all out
  [5.3, 0], // sunset − 69 min: 15:56 for a 17:05 sunset
  [5.6, 0.04],
  [6, 0.12],
  [6 + 1 / 3, 0.2],
  [6 + 2 / 3, 0.3],
  [7, 0.4],
];

export function litShare(s: number): number {
  // Clamped to the table (it strictly increases), so a pair of rows always brackets the clock.
  const c = Math.min(Math.max(s, LIT[0][0]), LIT[LIT.length - 1][0]);
  const i = Math.max(1, LIT.findIndex(([s1]) => c <= s1));
  const [s0, v0] = LIT[i - 1];
  const [s1, v1] = LIT[i];
  return lerp(v0, v1, (c - s0) / (s1 - s0));
}

/** Everything the City paints in its sky this frame, as PAINT colours (the grade has yet to go over them). */
export interface CitySky {
  /** The sky bands, top → horizon (`SKY_BANDS` of them; equal neighbours are painted as one). */
  bands: string[];
  /**
   * What each band is MEANT to look like once graded — the authored colour. The canvas shows exactly
   * this wherever the grade can reach it, and the nearest reachable colour where it cannot.
   */
  seen: string[];
  sun: { color: string; core: string; glow: string; r: number };
  /** The warm glow low on the sun's side; alpha 0 = none. `side` 0 = the left end of the sun's arc, 1 = the right. */
  bloom: { color: string; alpha: number; side: number };
  cloud: Record<CloudShade, { body: string; under: string }>;
  skyline: { block: string; edge: string; pane: string };
  /** Share of the far skyline's windows lit (`litShare`). */
  lit: number;
}

function key(s: number): { a: SkyKey; b: SkyKey; u: number } {
  // Clamped to the last key, so a pair always brackets it (the clock never runs past night).
  const c = Math.min(s, KEYS[KEYS.length - 1].at);
  const i = Math.max(1, KEYS.findIndex((k) => c <= k.at));
  const a = KEYS[i - 1];
  const b = KEYS[i];
  return { a, b, u: (c - a.at) / (b.at - a.at) }; // the keys strictly increase
}

/** A key's sky stop colour at `y` (0 top .. 1 horizon). */
function skyAt(k: SkyKey, y: number): Rgb {
  // y is 0..1 and the last stop is 1, so some stop always brackets it.
  const i = Math.max(1, SKY_STOPS.findIndex((t) => Math.min(y, 1) <= t));
  return lerpRgb(hex(k.sky[i - 1]), hex(k.sky[i]), (y - SKY_STOPS[i - 1]) / (SKY_STOPS[i] - SKY_STOPS[i - 1]));
}

const mul = (a: Rgb, light: Rgb): Rgb => ({ r: (a.r * light.r) / 255, g: (a.g * light.g) / 255, b: (a.b * light.b) / 255 });

const rgba = ({ r, g, b }: Rgb, alpha: number): string =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(alpha * 1000) / 1000})`;

/** Weather on an authored (clear-sky) colour: overcast greys it toward its own luminance and dims it. */
function weathered(c: Rgb, cover: number): Rgb {
  if (cover <= 0) return c;
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const grey = { r: l * 0.92, g: l * 0.97, b: Math.min(255, l * 1.08) };
  const d = 1 - 0.3 * cover;
  const m = lerpRgb(c, grey, Math.min(0.9, 1.3 * cover));
  return { r: m.r * d, g: m.g * d, b: m.b * d };
}

let memo: { amb: Ambience | undefined; sky: CitySky } | null = null;

/**
 * The City's sky this frame (memoised per Ambience object: the backdrop and the after-grade pass
 * ask for it in the same frame). No ambience = the plain day, no windows lit.
 */
export function citySky(amb: Ambience | undefined): CitySky {
  if (memo && memo.amb === amb) return memo.sky;
  const sky = buildCitySky(amb);
  memo = { amb, sky };
  return sky;
}

function buildCitySky(amb: Ambience | undefined): CitySky {
  if (!amb) {
    const D = CITY_DAY;
    const cloud = {} as CitySky["cloud"];
    for (const shade of Object.keys(D.cloud) as CloudShade[])
      cloud[shade] = { body: D.cloud[shade], under: toHex(mul(hex(D.cloud[shade]), hex(D.cloudUnder))) };
    return {
      bands: Array.from({ length: SKY_BANDS }, (_, i) => D.sky[Math.floor((i * D.sky.length) / SKY_BANDS)]),
      seen: Array.from({ length: SKY_BANDS }, (_, i) => D.sky[Math.floor((i * D.sky.length) / SKY_BANDS)]),
      sun: { color: D.sun, core: D.sunCore, glow: rgba(hex(D.sunGlow.color), D.sunGlow.alpha), r: 7 },
      bloom: { color: "#000000", alpha: 0, side: 0.5 },
      cloud,
      skyline: { block: D.skyline, edge: D.skylineEdge, pane: D.skylinePane },
      lit: 0,
    };
  }
  const s = skyClock(amb);
  const w = dayWeight(s);
  const { a, b, u } = key(s);
  const map = gradeMap(amb);
  const cover = OVERCAST[amb.weather] * (0.5 + 0.5 * amb.intensity);
  /** How a thing whose plain-day colour is `day` and whose authored look now is `look` should be SEEN. */
  const target = (day: Rgb, look: Rgb): Rgb => {
    const seenDay = { r: day.r * map.k + map.c.r, g: day.g * map.k + map.c.g, b: day.b * map.k + map.c.b };
    return lerpRgb(seenDay, weathered(look, cover), w);
  };
  /** …and the colour to paint it, so the grade turns it into that (by day: just its day colour). */
  const paint = (day: Rgb, look: Rgb): string => (w === 0 ? toHex(day) : toHex(ungrade(map, target(day, look))));
  const pick = (f: (k: SkyKey) => string): Rgb => lerpRgb(hex(f(a)), hex(f(b)), u);
  const D = CITY_DAY;

  const band = (i: number) => {
    const y = (i + 0.5) / SKY_BANDS;
    return { day: hex(D.sky[Math.floor((i * D.sky.length) / SKY_BANDS)]), look: lerpRgb(skyAt(a, y), skyAt(b, y), u) };
  };
  const bands = Array.from({ length: SKY_BANDS }, (_, i) => paint(band(i).day, band(i).look));
  const seen = Array.from({ length: SKY_BANDS }, (_, i) => toHex(target(band(i).day, band(i).look)));
  const glowA = lerp(a.glowA, b.glowA, u);
  const sun = {
    color: paint(hex(D.sun), pick((k) => k.sun)),
    core: paint(hex(D.sunCore), pick((k) => k.core)),
    glow: rgba(hex(paint(hex(D.sunGlow.color), pick((k) => k.glow))), lerp(D.sunGlow.alpha, glowA, w)),
    r: Math.round(lerp(7, lerp(a.r, b.r, u), w)),
  };
  const bloomA = lerp(a.bloomA, b.bloomA, u) * w * (1 - Math.min(1, cover));
  const light = pick((k) => k.cloud);
  const under = pick((k) => k.under);
  const cloud = {} as CitySky["cloud"];
  for (const shade of Object.keys(D.cloud) as CloudShade[]) {
    const day = hex(D.cloud[shade]);
    cloud[shade] = { body: paint(day, mul(day, light)), under: paint(mul(day, hex(D.cloudUnder)), mul(day, under)) };
  }
  return {
    bands,
    seen,
    sun,
    bloom: { color: paint(hex("#fff4d6"), pick((k) => k.bloom)), alpha: Math.round(bloomA * 1000) / 1000, side: s < 3.5 ? 0 : 1 },
    cloud,
    skyline: {
      block: paint(hex(D.skyline), pick((k) => k.block)),
      edge: paint(hex(D.skylineEdge), pick((k) => k.edge)),
      pane: paint(hex(D.skylinePane), pick((k) => k.pane)),
    },
    lit: litShare(s),
  };
}
