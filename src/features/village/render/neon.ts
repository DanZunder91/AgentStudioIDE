/**
 * Agent Village — the City's NEON signs: every project building wears its language in light.
 *
 * After Tokyo neon-street references — pink, blue and cyan glowing signs, a pixel-art shop with a
 * red neon sign and a vertical "SHOP" blade sign — each building wears a neon sign naming its
 * language, in that language's style: gazelle is Rust, so it shows Rust-style neon. Our own
 * procedural pixel art; the references were inspiration only (no third-party art, so no licence to
 * track).
 *
 * The look — a vertical BLADE sign, the reference's "SHOP" sign:
 *
 *        wall │╶┐┌───────────┐     two dark brackets reach out of the right wall's face to the plate;
 *             │ ││┌─────────┐│     the plate is dark glass with a 1-px neon tube round its edge
 *             │  ││  R R R  ││     (the language's FRAME colour) and the short name stacked letter
 *             │  ││  U   U  ││     over letter in 5×7 pixel tubes (its LETTER colour) — RUST in Rust
 *             │  ││  S S S  ││     orange, TS in TypeScript blue, PY in Python yellow on a blue
 *             │ ││  T T T  ││     frame, GO in gopher cyan…
 *             │╶┘└───────────┘
 *
 * Where it hangs is the engine's call (engine/drawList.ts `neonAnchor`: the right wall, high up,
 * out over the gap after the building); this module owns the size, the art and the light.
 *
 * Two passes, the vending machines' pattern (render/tokyoProps.ts + render/ambience.ts):
 *   - `drawNeonSign` — in the scene, graded like everything outdoors: by day a sign of coloured
 *     tubes on dark glass;
 *   - `paintNeonLights` — after the outdoor grade (render/ambience.ts), scaled by how dark it is
 *     (`neonStrength`: nothing at noon, rising through the evening, full at night and in a storm's
 *     gloom): the tubes re-lit at full brightness so they SHINE on a dark street, a coloured halo
 *     round the sign that lands on the facade and the gap's air, and a pool of the same colour on
 *     the sidewalk below. Clipped (by the caller) to the outdoors, so no light leaks into a room.
 *
 * Now and then a letter stutters — the tube drops out for a few blinks and catches again
 * (`neonFlicker`): one window in three of `FLICKER_PERIOD_MS` per building, at a moment and on a
 * letter chosen by a hash of the building's key and the window. Deterministic, never random: the
 * same frame time always draws the same sign.
 *
 * An unknown language id draws NO sign (`neonLayout` → null). Every id either detector can send
 * comes from `projectLanguages.json`, and `neon.test.ts` pins that each one has a style here — so an
 * id without one is contract drift, and a sign that guessed its name would present a guess as a
 * fact; the building simply stays as it is without a language.
 *
 * Cost per frame: layouts are memoised per draw item (the engine's are the same objects every frame
 * of a World) and the light pass's signs per World; glyphs are pre-merged rectangles (RUST is 18
 * rects); everything is culled to the view first.
 */

import { hashString } from "../engine/rng";
import { neonAnchor } from "../engine/drawList";
import { TILE, type Ambience, type World } from "../villageTypes";
import type { Camera } from "./camera";
import { hash, onScreen, rect } from "./paint";
import type { DrawTarget } from "./renderTypes";

// ───────────────────────────── the styles ─────────────────────────────

/** A language's sign: its short name and its two neon colours. */
export interface NeonStyle {
  /** Stacked top to bottom; at most `MAX_LETTERS` glyphs of `GLYPHS`. */
  label: string;
  /** The letters' tubes. */
  letter: string;
  /** The tube round the plate's edge. */
  frame: string;
}

/**
 * Each language's sign, in its own colours — the language's logo / community colour pushed to a
 * neon brightness. Keyed by the ids of `src/features/village/projectLanguages.json` (every one of
 * them has a row: `neon.test.ts`).
 */
export const NEON: Readonly<Record<string, NeonStyle>> = {
  rust: { label: "RUST", letter: "#ff8a3d", frame: "#e8471f" }, // Rust orange, a rust-red frame
  typescript: { label: "TS", letter: "#7cc4ff", frame: "#3d8eff" }, // TypeScript blue
  javascript: { label: "JS", letter: "#ffe74a", frame: "#ffb800" }, // JS yellow
  python: { label: "PY", letter: "#ffd43b", frame: "#4b8bff" }, // Python: yellow on blue
  go: { label: "GO", letter: "#5fe3ff", frame: "#00add8" }, // gopher cyan
  java: { label: "JAVA", letter: "#ff9a3c", frame: "#5b9bd5" }, // coffee orange, Duke blue
  kotlin: { label: "KT", letter: "#c08bff", frame: "#ff7a59" }, // Kotlin's violet-to-orange
  swift: { label: "SWIFT", letter: "#ff7a50", frame: "#ff4d2e" }, // Swift orange
  c: { label: "C", letter: "#9cc4ff", frame: "#5a7fc0" }, // steel blue
  cpp: { label: "C++", letter: "#6fb6ff", frame: "#2f7fd8" }, // C++ blue
  csharp: { label: "C#", letter: "#c48bff", frame: "#9b4dff" }, // C# purple
  "objective-c": { label: "OBJC", letter: "#8fd3ff", frame: "#4a90e2" },
  ruby: { label: "RUBY", letter: "#ff5a6a", frame: "#ff2244" }, // ruby red
  php: { label: "PHP", letter: "#b3b6ff", frame: "#7a7fd8" }, // PHP lavender
  dart: { label: "DART", letter: "#4fd8ff", frame: "#1a8fd6" },
  elixir: { label: "EX", letter: "#c78bff", frame: "#7a4ab0" }, // Elixir purple
  erlang: { label: "ERL", letter: "#ff5a7a", frame: "#c1124a" },
  haskell: { label: "HS", letter: "#b49cff", frame: "#6a54b8" },
  scala: { label: "SCALA", letter: "#ff5a4a", frame: "#d42a1a" }, // Scala red
  lua: { label: "LUA", letter: "#7f8cff", frame: "#3445d8" }, // Lua navy, lit
  zig: { label: "ZIG", letter: "#ffbd3c", frame: "#f08a00" }, // Zig amber
  shell: { label: "SH", letter: "#7dff8a", frame: "#2ed058" }, // terminal green
  clojure: { label: "CLJ", letter: "#8be36a", frame: "#5a8fff" }, // Clojure green and blue
  ocaml: { label: "ML", letter: "#ffa24a", frame: "#ec6813" }, // OCaml orange
  fsharp: { label: "F#", letter: "#62d5ff", frame: "#378bba" },
  julia: { label: "JL", letter: "#cf7bff", frame: "#58c45a" }, // Julia's purple and green dots
  r: { label: "R", letter: "#7fb2ff", frame: "#2a6fd6" },
  perl: { label: "PERL", letter: "#9fb8d8", frame: "#4a6a9a" },
  nim: { label: "NIM", letter: "#ffe45c", frame: "#d6a800" }, // Nim crown gold
  crystal: { label: "CR", letter: "#f2f2f2", frame: "#9a9a9a" }, // Crystal white
  elm: { label: "ELM", letter: "#62e0ff", frame: "#3a7fc1" },
  solidity: { label: "SOL", letter: "#c8c8d8", frame: "#8a8aa8" },
  vue: { label: "VUE", letter: "#7dffc0", frame: "#42b883" }, // Vue green
  svelte: { label: "SV", letter: "#ff7a4a", frame: "#ff3e00" }, // Svelte orange
  gdscript: { label: "GD", letter: "#7fc8ff", frame: "#478cbf" }, // Godot blue
};

/** The most letters a sign stacks: its height must fit the smallest building (`neon.test.ts`). */
export const MAX_LETTERS = 5;

// ───────────────────────────── the font ─────────────────────────────

/** A glyph cell, world px. */
export const GLYPH_W = 5;
export const GLYPH_H = 7;

/** 5×7 pixel letters, top row first (`X` = tube). Our own; every letter a label may use. */
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: [".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  B: ["XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX."],
  C: [".XXX.", "X...X", "X....", "X....", "X....", "X...X", ".XXX."],
  D: ["XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX."],
  E: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  F: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "X...."],
  G: [".XXX.", "X...X", "X....", "X.XXX", "X...X", "X...X", ".XXXX"],
  H: ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  I: [".XXX.", "..X..", "..X..", "..X..", "..X..", "..X..", ".XXX."],
  J: ["..XXX", "...X.", "...X.", "...X.", "...X.", "X..X.", ".XX.."],
  K: ["X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X"],
  L: ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  M: ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  N: ["X...X", "X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X"],
  O: [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  P: ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  R: ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  S: [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
  T: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  U: ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  V: ["X...X", "X...X", "X...X", "X...X", "X...X", ".X.X.", "..X.."],
  W: ["X...X", "X...X", "X...X", "X.X.X", "X.X.X", "X.X.X", ".X.X."],
  X: ["X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X"],
  Y: ["X...X", "X...X", ".X.X.", "..X..", "..X..", "..X..", "..X.."],
  Z: ["XXXXX", "....X", "...X.", "..X..", ".X...", "X....", "XXXXX"],
  "+": [".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....."],
  "#": [".X.X.", ".X.X.", "XXXXX", ".X.X.", "XXXXX", ".X.X.", ".X.X."],
};

/** One filled rectangle of a glyph, world px from the cell's top-left. */
type Run = readonly [dx: number, dy: number, w: number, h: number];

/**
 * A glyph as few rectangles as it takes: each row's runs, then a run merged down into the next
 * row's identical one (a stem is one tall rect, not seven).
 */
function glyphRects(rows: readonly string[]): Run[] {
  const out: [number, number, number, number][] = [];
  let above: [number, number, number, number][] = [];
  for (let y = 0; y < GLYPH_H; y++) {
    const row: [number, number, number, number][] = [];
    for (let x = 0; x < GLYPH_W; ) {
      if (rows[y][x] !== "X") {
        x++;
        continue;
      }
      const x0 = x;
      while (x < GLYPH_W && rows[y][x] === "X") x++;
      const same = above.find((r) => r[0] === x0 && r[2] === x - x0);
      if (same) {
        same[3]++;
        row.push(same);
      } else {
        const r: [number, number, number, number] = [x0, y, x - x0, 1];
        out.push(r);
        row.push(r);
      }
    }
    above = row;
  }
  return out;
}

const GLYPHS: ReadonlyMap<string, Run[]> = new Map(Object.entries(FONT).map(([ch, rows]) => [ch, glyphRects(rows)]));

/** The letters a label may use. */
export const NEON_LETTERS = [...GLYPHS.keys()].join("");

// ───────────────────────────── geometry ─────────────────────────────

/** How far the plate hangs off the wall's face (the brackets span it), world px. */
export const PLATE_OUT = 3;
/** The plate's width: a dark rim, the frame tube, two px of air either side of a 5-px letter. */
export const PLATE_W = 13;
/** From the plate's edge to its letters (rim 1 + tube 1 + air 2). */
const INSET = 4;
/** Air between two stacked letters. */
const LETTER_GAP = 2;
/** World px of the night halo round the plate, and of the light pool on the sidewalk. */
const HALO = [3, 7, 12] as const;
const POOL_W = 16;

/** The plate's height for `n` letters. */
export function plateHeight(n: number): number {
  return 2 * INSET + n * GLYPH_H + (n - 1) * LETTER_GAP;
}

/** A sign ready to paint: its style, where its plate is and its letters' rects (world px). */
export interface NeonLayout {
  style: NeonStyle;
  /** The plate's top-left and size. */
  px: number;
  py: number;
  ph: number;
  /** The wall face the brackets come out of. */
  wall: number;
  /** Each letter's rects, absolute world px. */
  letters: Run[][];
  /** Dimmed letter colour, for a letter whose tube has dropped out. */
  dim: string;
  /** The flicker seed (a hash of the building's key). */
  seed: number;
  /** World [x, y, w, h] of all its art (brackets + plate): what the frame culls by. */
  box: [number, number, number, number];
}

/** `#rrggbb` mixed `t` of the way towards `#rrggbb` `to`. */
function mix(from: string, to: string, t: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** `#rrggbb` as `rgba(…, a)`. */
function rgba(color: string, a: number): string {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The glass behind the tubes, the brackets, and the colour an unlit tube fades to. */
export const NEON_ART = { back: "#141019", metal: "#2c2b36", unlit: "#1a1420" } as const;

/** The sign hanging at world (x, y) — `neonAnchor`'s point — in `language`'s style; null for an unknown id. */
function layoutAt(x: number, y: number, language: string, building: string): NeonLayout | null {
  const style = NEON[language];
  if (!style) return null;
  const px = x + PLATE_OUT;
  const n = style.label.length;
  const ph = plateHeight(n);
  const letters = [...style.label].map((ch, i) =>
    (GLYPHS.get(ch) as Run[]).map(([dx, dy, w, h]): Run => [px + INSET + dx, y + INSET + i * (GLYPH_H + LETTER_GAP) + dy, w, h]),
  );
  return {
    style,
    px,
    py: y,
    ph,
    wall: x,
    letters,
    dim: mix(style.letter, NEON_ART.unlit, 0.65),
    seed: hashString(building),
    box: [x - 1, y, PLATE_OUT + 1 + PLATE_W, ph],
  };
}

const LAYOUTS = new WeakMap<object, NeonLayout | null>();

/**
 * The layout of a "neon" draw item, memoised per item (the engine hands the same item every frame
 * of a World). null = no style for its language: nothing is drawn.
 */
export function neonLayout(item: { x: number; y: number; language: string; building: string }): NeonLayout | null {
  if (LAYOUTS.has(item)) return LAYOUTS.get(item) as NeonLayout | null;
  const out = layoutAt(item.x, item.y, item.language, item.building);
  LAYOUTS.set(item, out);
  return out;
}

// ───────────────────────────── the flicker ─────────────────────────────

/** One flicker chance per building per this many ms; a flicker lasts `FLICKER_MS`, in steps. */
export const FLICKER_PERIOD_MS = 8000;
export const FLICKER_MS = 600;
const FLICKER_STEP_MS = 75;

/**
 * Which letter's tube has dropped out at `timeMs`, or -1 for none. One window in three flickers, at
 * a moment and on a letter of its own (a hash of `seed` and the window); within the flicker the
 * tube cuts out on some 75-ms steps and catches on others — a stutter, not a blink. Pure.
 */
export function neonFlicker(seed: number, timeMs: number, letters: number): number {
  const w = Math.floor(timeMs / FLICKER_PERIOD_MS);
  const h = hash(seed, w, 211);
  if (h % 3 !== 0) return -1;
  const local = timeMs - w * FLICKER_PERIOD_MS - ((h >>> 4) % (FLICKER_PERIOD_MS - FLICKER_MS));
  if (local < 0 || local >= FLICKER_MS) return -1;
  if (hash(seed, w, Math.floor(local / FLICKER_STEP_MS)) % 2 === 0) return -1;
  return (h >>> 16) % letters;
}

// ───────────────────────────── painting ─────────────────────────────

/** The frame tube and the letters (`dark` = the letter that has dropped out: dimmed, or skipped when `relight`). */
function tubes(ctx: DrawTarget, cam: Camera, s: NeonLayout, dark: number, relight: boolean): void {
  const { px, py, ph, style } = s;
  rect(ctx, cam, px + 1, py + 1, PLATE_W - 2, 1, style.frame);
  rect(ctx, cam, px + 1, py + ph - 2, PLATE_W - 2, 1, style.frame);
  rect(ctx, cam, px + 1, py + 2, 1, ph - 4, style.frame);
  rect(ctx, cam, px + PLATE_W - 2, py + 2, 1, ph - 4, style.frame);
  s.letters.forEach((runs, i) => {
    if (i === dark && relight) return;
    const color = i === dark ? s.dim : style.letter;
    for (const [x, y, w, h] of runs) rect(ctx, cam, x, y, w, h, color);
  });
}

/** A sign in the scene: brackets, dark glass with a faint lit wash, the tubes (one may be stuttering). */
export function drawNeonSign(ctx: DrawTarget, cam: Camera, s: NeonLayout, timeMs: number): void {
  const { px, py, ph, wall, style } = s;
  rect(ctx, cam, wall - 1, py + 2, PLATE_OUT + 2, 2, NEON_ART.metal);
  rect(ctx, cam, wall - 1, py + ph - 4, PLATE_OUT + 2, 2, NEON_ART.metal);
  rect(ctx, cam, px, py, PLATE_W, ph, NEON_ART.back);
  rect(ctx, cam, px + 2, py + 2, PLATE_W - 4, ph - 4, rgba(style.letter, 0.14));
  tubes(ctx, cam, s, neonFlicker(s.seed, timeMs, s.letters.length), false);
}

/** Daylight at and above which the signs throw no light, and the span over which they reach full strength. */
const NEON_DAY = 0.85;
const NEON_RAMP = 0.7;

/**
 * How strongly the signs light their surroundings, 0..1: 0 in full daylight (noon, a bright
 * afternoon), rising through the evening and dusk, 1 at night (daylight 0.15) — and part-way in a
 * storm's daytime gloom, when a lit sign would show too.
 */
export function neonStrength(amb: Pick<Ambience, "daylight">): number {
  return Math.min(1, Math.max(0, (NEON_DAY - amb.daylight) / NEON_RAMP));
}

/** A city's signs for the light pass, built once per World. */
interface LitSign {
  sign: NeonLayout;
  /** The sidewalk's top, world px: the pool of light lies there. */
  walk: number;
  /** World [x, y, w, h] of everything the light pass paints for it. */
  glow: [number, number, number, number];
}

const LIT = new WeakMap<World, LitSign[]>();

/** Every project building's sign (known language, never the HQ) with its light's reach. */
export function neonSignsOf(world: World): readonly LitSign[] {
  const hit = LIT.get(world);
  if (hit) return hit;
  const out: LitSign[] = [];
  const city = world.city;
  for (const b of city?.buildings ?? []) {
    if (b.hq || !b.language) continue;
    const a = neonAnchor(b);
    const sign = layoutAt(a.x, a.y, b.language, b.key);
    if (!sign) continue;
    const walk = (city as NonNullable<World["city"]>).street * TILE;
    // The widest halo band; the sidewalk pool (2·POOL_W, centred) is narrower than it.
    const r = HALO[HALO.length - 1];
    out.push({ sign, walk, glow: [sign.px - r, sign.py - r, PLATE_W + 2 * r, walk + 6 - (sign.py - r)] });
  }
  LIT.set(world, out);
  return out;
}

/**
 * The signs' light, after the outdoor grade (render/ambience.ts `paintAmbience`, inside its
 * outdoors clip): per sign on screen, a coloured halo (crossed bands, brightest at the plate) that
 * falls on the facade and the air of the gap, a pool on the sidewalk under it, and the tubes re-lit
 * at full brightness — all scaled by `neonStrength`. A stuttering letter stays dark. A no-op by day.
 */
export function paintNeonLights(
  ctx: DrawTarget,
  amb: Ambience,
  world: World,
  cam: Camera,
  view: { w: number; h: number },
  timeMs: number,
): void {
  const k = neonStrength(amb);
  if (k <= 0) return;
  for (const { sign, walk, glow } of neonSignsOf(world)) {
    if (!onScreen(cam, view, ...glow)) continue;
    const { px, py, ph, style } = sign;
    const halo = rgba(style.letter, 0.07);
    ctx.globalAlpha = k;
    for (const r of HALO) {
      rect(ctx, cam, px - r, py - (r >> 1), PLATE_W + 2 * r, ph + r, halo);
      rect(ctx, cam, px - (r >> 1), py - r, PLATE_W + r, ph + 2 * r, halo);
    }
    // Its light on the sidewalk below: a bright pool under it, a wider faint one round that.
    const cx = px + PLATE_W / 2;
    rect(ctx, cam, cx - POOL_W / 2, walk, POOL_W, 3, rgba(style.letter, 0.16));
    rect(ctx, cam, cx - POOL_W, walk + 3, POOL_W * 2, 3, rgba(style.letter, 0.09));
    tubes(ctx, cam, sign, neonFlicker(sign.seed, timeMs, sign.letters.length), true);
  }
  ctx.globalAlpha = 1;
}
