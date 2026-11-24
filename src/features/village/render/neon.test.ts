/**
 * The City's neon signs (every building wears a neon sign naming its
 * language, in that language's style — gazelle is Rust, so its sign is Rust's): the styles and
 * the shared language table, the 5×7 tube font, where a sign hangs (never over a room, the door,
 * the name, a neighbour or the street's props), the deterministic flicker, the night light — and
 * the engine's emission and the frame's dispatch that carry it on screen.
 *
 * Expectations are written by hand: the letters' pixels are drawn here, not read
 * back off the font under test.
 */

import { describe, expect, it } from "vitest";

import { buildCityWorld, type CityPlan } from "../engine/city";
import { buildDrawList, neonAnchor, NEON_DROP } from "../engine/drawList";
import projectLanguages from "../projectLanguages.json";
import { TILE, type Ambience, type CityBuilding, type DrawItem, type World } from "../villageTypes";
import { paintAmbience } from "./ambience";
import type { Camera } from "./camera";
import { renderFrame } from "./frame";
import {
  drawNeonSign,
  FLICKER_MS,
  FLICKER_PERIOD_MS,
  GLYPH_H,
  GLYPH_W,
  MAX_LETTERS,
  NEON,
  NEON_ART,
  NEON_LETTERS,
  neonFlicker,
  neonLayout,
  neonSignsOf,
  neonStrength,
  paintNeonLights,
  PLATE_OUT,
  PLATE_W,
  plateHeight,
  type NeonLayout,
} from "./neon";
import { recorder, type DrawCall } from "./testRecorder";

const cam: Camera = { zoom: 1, ox: 0, oy: 0 };

/** A fill as a world-px box (zoom 1, no offset: screen px are world px). */
const box = (c: DrawCall) => {
  const [x, y, w, h] = c.args as number[];
  return { x, y, w, h, color: c.fillStyle, alpha: c.alpha };
};
type Box = ReturnType<typeof box>;
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const asBox = ([x, y, w, h]: readonly number[]) => ({ x, y, w, h });
const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

const amb = (over: Partial<Ambience> = {}): Ambience => ({
  phase: "night",
  daylight: 0.15,
  tint: { color: "#0b1640", alpha: 0.55 },
  weather: "clear",
  intensity: 0,
  wind: 0,
  lightsOn: true,
  campfireLit: true,
  stayIndoors: true,
  ...over,
});

/** A sign item as the engine makes it. */
const item = (language: string, x = 100, y = 40, building = "gazelle") => ({ t: "neon" as const, x, y, language, building });

/** A moment at which `seed`'s sign is steady (no letter out), and one at which letter `want` is out. */
function steadyAt(seed: number, letters: number): number {
  for (let t = 0; ; t += 25) if (neonFlicker(seed, t, letters) === -1) return t;
}
function flickerAt(seed: number, letters: number): { t: number; letter: number } {
  for (let t = 0; ; t += 25) {
    const letter = neonFlicker(seed, t, letters);
    if (letter >= 0) return { t, letter };
  }
}

/** The pixels a set of absolute rects lights inside a 5×7 cell at (x0, y0), as `X`/`.` rows — and whether any pixel was painted twice. */
function bitmap(rects: readonly Box[], x0: number, y0: number): { rows: string[]; twice: boolean } {
  const cells = Array.from({ length: GLYPH_H }, () => Array<number>(GLYPH_W).fill(0));
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells[y - y0][x - x0]++;
  return { rows: cells.map((row) => row.map((n) => (n > 0 ? "X" : ".")).join("")), twice: cells.flat().some((n) => n > 1) };
}

// ───────────────────────────── styles ─────────────────────────────

describe("the styles", () => {
  it("every language of the shared table has a sign, and every sign is a language of the table", () => {
    const languages = new Set(Object.values(projectLanguages.extensions));
    expect(languages.size).toBeGreaterThanOrEqual(30);
    expect(new Set(Object.keys(NEON))).toEqual(languages);
  });

  it("the flagship signs say their language in its colours (hand-checked)", () => {
    expect(NEON.rust).toEqual({ label: "RUST", letter: "#ff8a3d", frame: "#e8471f" });
    expect(NEON.typescript.label).toBe("TS");
    expect(NEON.go.label).toBe("GO");
    expect(NEON.javascript.label).toBe("JS");
    // Rust orange: red over green over blue.
    const [r, g, b] = rgb(NEON.rust.letter);
    expect(r > g && g > b).toBe(true);
    // TypeScript blue, Go cyan: blue leads.
    for (const lang of ["typescript", "go"]) {
      const [tr, , tb] = rgb(NEON[lang].letter);
      expect(tb).toBeGreaterThan(tr);
    }
    // Python: yellow letters on a blue frame.
    expect(NEON.python.label).toBe("PY");
    const [yr, yg, yb] = rgb(NEON.python.letter);
    expect(Math.min(yr, yg)).toBeGreaterThan(yb + 100);
    const [fr, , fb] = rgb(NEON.python.frame);
    expect(fb).toBeGreaterThan(fr + 100);
  });

  it("every label is 1..MAX_LETTERS letters the font has, every colour a #rrggbb", () => {
    expect(MAX_LETTERS).toBe(5);
    for (const [lang, s] of Object.entries(NEON)) {
      expect(s.label.length, lang).toBeGreaterThanOrEqual(1);
      expect(s.label.length, lang).toBeLessThanOrEqual(MAX_LETTERS);
      for (const ch of s.label) expect(NEON_LETTERS, `${lang}: ${ch}`).toContain(ch);
      expect(s.letter, lang).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.frame, lang).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

// ───────────────────────────── the font and the layout ─────────────────────────────

describe("neonLayout — the plate and its letters", () => {
  it("is 13 px wide, 6 + 9 per letter tall, hanging PLATE_OUT off the wall face", () => {
    expect([plateHeight(1), plateHeight(2), plateHeight(4), plateHeight(5)]).toEqual([15, 24, 42, 51]);
    const s = neonLayout(item("rust")) as NeonLayout;
    expect(PLATE_W).toBe(13);
    expect(PLATE_OUT).toBe(3);
    expect([s.px, s.py, s.ph, s.wall]).toEqual([103, 40, 42, 100]);
    // Brackets (from 1 px inside the wall) and plate: what the frame culls by.
    expect(s.box).toEqual([99, 40, 17, 42]);
  });

  it("stacks RUST in 5×7 tube letters, 9 px apart — 18 rects, no pixel twice", () => {
    const s = neonLayout(item("rust")) as NeonLayout;
    const want = [
      ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
      ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
      [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
      ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
    ];
    expect(s.letters).toHaveLength(4);
    s.letters.forEach((runs, i) => {
      const got = bitmap(
        runs.map(([x, y, w, h]) => ({ x, y, w, h, color: "", alpha: 1 })),
        s.px + 4,
        s.py + 4 + 9 * i,
      );
      expect(got.rows, `letter ${i}`).toEqual(want[i]);
      expect(got.twice).toBe(false);
    });
    // Stems are merged into tall rects: few fills per frame.
    expect(s.letters.map((r) => r.length)).toEqual([8, 3, 5, 2]);
  });

  it("draws the symbols of C++ and C#", () => {
    const plus = (neonLayout(item("cpp")) as NeonLayout).letters[1];
    const hash = (neonLayout(item("csharp")) as NeonLayout).letters[1];
    const at = (runs: NeonLayout["letters"][number], i: number) =>
      bitmap(runs.map(([x, y, w, h]) => ({ x, y, w, h, color: "", alpha: 1 })), 107, 40 + 4 + 9 * i).rows;
    expect(at(plus, 1)).toEqual([".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....."]);
    expect(at(hash, 1)).toEqual([".X.X.", ".X.X.", "XXXXX", ".X.X.", "XXXXX", ".X.X.", ".X.X."]);
  });

  it("every letter of every label lies inside the plate, between its frame tubes", () => {
    for (const lang of Object.keys(NEON)) {
      const s = neonLayout(item(lang)) as NeonLayout;
      for (const runs of s.letters)
        for (const [x, y, w, h] of runs) {
          expect(x >= s.px + 4 && x + w <= s.px + PLATE_W - 4, lang).toBe(true);
          expect(y >= s.py + 4 && y + h <= s.py + s.ph - 4, lang).toBe(true);
        }
    }
  });

  it("is memoised per item, and an id with no style lays out (and so draws) nothing", () => {
    const it1 = item("go");
    expect(neonLayout(it1)).toBe(neonLayout(it1));
    expect(neonLayout(item("go"))).not.toBe(neonLayout(it1));
    const odd = item("brainfuck");
    expect(neonLayout(odd)).toBeNull();
    expect(neonLayout(odd)).toBeNull();
  });
});

// ───────────────────────────── where it hangs ─────────────────────────────

describe("neonAnchor — on the right wall, high up, clear of everything", () => {
  const building = (over: Partial<CityBuilding> = {}): CityBuilding => ({
    key: "gazelle",
    label: "gazelle",
    col: 10,
    row: 3,
    w: 8,
    h: 6, // one floor of five tiles plus the street-level front wall: the smallest a city builds
    doorCol: 15,
    floors: ["floor:a"],
    hasIde: false,
    ...over,
  });

  it("hangs from the right wall's outer face, a tile and 2 px below the roof line", () => {
    expect(NEON_DROP).toBe(TILE + 2);
    expect(neonAnchor(building())).toEqual({ x: 18 * TILE, y: 3 * TILE + 18 });
    // Taller (more floors, more desk rows): still at the top.
    expect(neonAnchor(building({ row: 1, h: 26 }))).toEqual({ x: 18 * TILE, y: TILE + 18 });
  });

  it("for EVERY style, on the smallest building: over the wall and the gap's first column only, below the roof, above the door row and a walker's head", () => {
    const b = building();
    const frontTop = (b.row + b.h - 1) * TILE; // the front wall row, where the door is
    for (const lang of Object.keys(NEON)) {
      const s = neonLayout({ ...neonAnchor(b), language: lang, building: b.key }) as NeonLayout;
      const [x, y, w, h] = s.box;
      expect(x, lang).toBeGreaterThanOrEqual((b.col + b.w - 1) * TILE); // never over a room
      expect(x + w, lang).toBeLessThanOrEqual((b.col + b.w + 1) * TILE); // the gap's lamp column
      expect(y, lang).toBeGreaterThanOrEqual(b.row * TILE + TILE); // the name hangs over the roof
      expect(y + h, lang).toBeLessThanOrEqual(frontTop - 8); // a sidewalk walker's head, the lamp
    }
  });

  const plan = (key: string, team: number, floors: number): CityPlan => ({
    key,
    label: key,
    team,
    floors: Array.from({ length: floors }, (_, i) => ({ key: `floor:${key}${i}`, label: `${key}${i}`, ide: i === 0 })),
    hasIde: true,
  });

  /** A real city — HQ and all — with a language on every project building (and, wrongly, on the HQ). */
  function city(): World {
    const built = buildCityWorld([plan("alpha", 0, 1), plan("beta", 6, 2), plan("gamma", 24, 1), plan("zeta", 2, 3)], { seats: 8 });
    const c = built.city as NonNullable<World["city"]>;
    const langs: Record<string, string> = { alpha: "rust", beta: "typescript", gamma: "python", zeta: "swift" };
    return { ...built, city: { ...c, buildings: c.buildings.map((b) => ({ ...b, language: b.hq ? "go" : langs[b.key] })) } };
  }

  it("in a real city: never on another building, a room, a door or a street prop's art; the HQ has none", () => {
    const world = city();
    const { buildings } = world.city as NonNullable<World["city"]>;
    const signs = buildDrawList(world, [], () => false, 0).filter((d): d is Extract<DrawItem, { t: "neon" }> => d.t === "neon");
    expect(new Map(signs.map((s) => [s.building, s.language]))).toEqual(
      new Map([
        ["alpha", "rust"],
        ["beta", "typescript"],
        ["gamma", "python"],
        ["zeta", "swift"],
      ]),
    );
    expect(signs).toHaveLength(4);
    const rect = (b: CityBuilding) => ({ x: b.col * TILE, y: b.row * TILE, w: b.w * TILE, h: b.h * TILE });
    const inside = (p: World["props"][number], b: CityBuilding) =>
      p.col >= b.col && p.col + p.w <= b.col + b.w && p.row >= b.row && p.row + p.h <= b.row + b.h;
    for (const sign of signs) {
      const s = asBox((neonLayout(sign) as NeonLayout).box);
      const own = buildings.find((b) => b.key === sign.building) as CityBuilding;
      for (const other of buildings) if (other !== own) expect(overlaps(s, rect(other)), `${sign.building} on ${other.key}`).toBe(false);
      for (const h of world.houses) expect(overlaps(s, { x: h.col * TILE, y: h.row * TILE, w: h.w * TILE, h: h.h * TILE })).toBe(false);
      const door = { x: own.doorCol * TILE, y: (own.row + own.h - 1) * TILE, w: TILE, h: TILE };
      expect(overlaps(s, door)).toBe(false);
      // The street's lamps and trees (art up to a tile above the footprint — the frame's cull rule).
      for (const p of world.props.filter((p) => !buildings.some((b) => inside(p, b)))) {
        const art = { x: p.col * TILE, y: (p.row - 1) * TILE, w: p.w * TILE, h: (p.h + 1) * TILE };
        expect(overlaps(s, art), `${sign.building} on ${p.id}`).toBe(false);
      }
    }
  });

  it("the building's name is painted after (over) its sign, and hangs above it", () => {
    const world = city();
    const items = buildDrawList(world, [], () => false, 0);
    const w = world.cols * TILE;
    const ctx = recorder();
    renderFrame(ctx, items, cam, null, { w, h: world.rows * TILE, world, timeMs: steadyAt(0, 4) });
    const calls = ctx.calls;
    const lastSign = calls.map((c) => c.fillStyle).lastIndexOf(NEON.rust.frame);
    const name = calls.findIndex((c) => c.op === "fillText" && c.args[0] === "alpha");
    expect(lastSign).toBeGreaterThan(0);
    expect(name).toBeGreaterThan(lastSign);
    const label = items.find((d) => d.t === "label" && d.text === "alpha") as Extract<DrawItem, { t: "label" }>;
    const sign = items.find((d) => d.t === "neon" && d.building === "alpha") as Extract<DrawItem, { t: "neon" }>;
    expect(label.y).toBeLessThan(sign.y - TILE);
  });
});

// ───────────────────────────── the engine's emission ─────────────────────────────

describe("buildDrawList — one sign per project building with a language", () => {
  const plan = (key: string): CityPlan => ({ key, label: key, team: 2, floors: [{ key: `floor:${key}`, label: key, ide: false }], hasIde: false });
  /** A city of buildings `p0`, `p1`… with these languages (and, wrongly, one on the HQ). */
  const withLangs = (langs: (string | null)[]): World => {
    const built = buildCityWorld(langs.map((_, i) => plan(`p${i}`)), { seats: 4 });
    const c = built.city as NonNullable<World["city"]>;
    const of = (key: string) => langs[Number(key.slice(1))];
    return { ...built, city: { ...c, buildings: c.buildings.map((b) => ({ ...b, language: b.hq ? "rust" : of(b.key) })) } };
  };

  it("at its anchor, never for the HQ or an unknown language; after its building's walls, before the street's lamps", () => {
    const world = withLangs(["go", null, "ruby"]);
    const items = buildDrawList(world, [], () => false, 0);
    const signs = items.filter((d) => d.t === "neon");
    const byKey = new Map((world.city as NonNullable<World["city"]>).buildings.map((b) => [b.key, b]));
    const at = (key: string) => neonAnchor(byKey.get(key) as CityBuilding);
    expect(signs).toHaveLength(2);
    expect(signs).toEqual(
      expect.arrayContaining([
        { t: "neon", ...at("p0"), language: "go", building: "p0" },
        { t: "neon", ...at("p2"), language: "ruby", building: "p2" },
      ]),
    );
    const firstLamp = items.findIndex((d) => d.t === "prop" && d.prop.kind === "lamp");
    for (const s of signs) {
      // Over its whole wall (every wall piece of its building is painted before it)…
      const b = byKey.get((s as Extract<DrawItem, { t: "neon" }>).building) as CityBuilding;
      const own = items.filter(
        (d) => d.t === "wall" && d.col >= b.col && d.col < b.col + b.w && d.row >= b.row && d.row < b.row + b.h,
      );
      expect(own.length).toBeGreaterThan(b.h);
      for (const wall of own) expect(items.indexOf(s)).toBeGreaterThan(items.indexOf(wall));
      // …and under the street's lamps.
      expect(items.indexOf(s)).toBeLessThan(firstLamp);
    }
  });

  it("the same objects every frame of a World (so their layouts are memoised); none in the village", () => {
    const world = withLangs(["go"]);
    const a = buildDrawList(world, [], () => false, 0).filter((d) => d.t === "neon");
    const b = buildDrawList(world, [], () => false, 5).filter((d) => d.t === "neon");
    expect(a).toHaveLength(1);
    expect(b[0]).toBe(a[0]);
    const village: World = { ...world, city: undefined };
    expect(buildDrawList(village, [], () => false, 0).some((d) => d.t === "neon")).toBe(false);
  });
});

// ───────────────────────────── the flicker ─────────────────────────────

describe("neonFlicker — a letter stutters now and then, deterministically", () => {
  it("is rare, short, deterministic and per building", () => {
    const horizon = 300 * FLICKER_PERIOD_MS;
    // One pass per seed, one assertion per property (an `expect` per sample is what makes such a scan slow).
    const windows = (seed: number) => {
      const out = new Set<number>();
      const values = new Set<number>();
      let on = 0;
      let samples = 0;
      let unstable = 0;
      for (let t = 0; t < horizon; t += 25) {
        samples++;
        const v = neonFlicker(seed, t, 4);
        if (v !== neonFlicker(seed, t, 4)) unstable++;
        values.add(v);
        if (v >= 0) {
          on++;
          out.add(Math.floor(t / FLICKER_PERIOD_MS));
        }
      }
      return { windows: out, share: on / samples, values, unstable };
    };
    const a = windows(12345);
    const b = windows(67890);
    // About one window in three flickers (never all, never none), each for well under a second.
    expect(a.windows.size).toBeGreaterThan(60);
    expect(a.windows.size).toBeLessThan(150);
    expect(a.share).toBeGreaterThan(0);
    expect(a.share).toBeLessThan(0.04);
    expect(b.windows).not.toEqual(a.windows);
    expect(a.unstable + b.unstable).toBe(0);
    // …and it is not always the same letter that goes — but always one of the sign's.
    expect(a.values).toEqual(new Set([-1, 0, 1, 2, 3]));
  });

  it("stutters inside its window: the tube drops out and catches, on one letter, within FLICKER_MS", () => {
    const seed = 4242;
    const { t } = flickerAt(seed, 3);
    const w = Math.floor(t / FLICKER_PERIOD_MS);
    const seen = new Map<number, number>();
    let first = Infinity;
    let last = -Infinity;
    for (let u = w * FLICKER_PERIOD_MS; u < (w + 1) * FLICKER_PERIOD_MS; u += 5) {
      const v = neonFlicker(seed, u, 3);
      seen.set(v, (seen.get(v) ?? 0) + 1);
      if (v >= 0) {
        first = Math.min(first, u);
        last = Math.max(last, u);
      }
    }
    expect(seen.size).toBe(2); // steady (-1) and one letter
    expect(last - first).toBeLessThan(FLICKER_MS);
    // Within the burst the tube catches again between drop-outs.
    let flips = 0;
    for (let u = first; u < last; u += 5) if ((neonFlicker(seed, u, 3) >= 0) !== (neonFlicker(seed, u + 5, 3) >= 0)) flips++;
    expect(flips).toBeGreaterThan(1);
  });
});

// ───────────────────────────── drawing ─────────────────────────────

describe("drawNeonSign — the sign in the scene", () => {
  const fills = (s: NeonLayout, t: number) => {
    const ctx = recorder();
    drawNeonSign(ctx, cam, s, t);
    return ctx.of("fillRect").map(box);
  };

  it("brackets, dark glass with a faint lit wash, the frame tube, then the letters", () => {
    const s = neonLayout(item("rust")) as NeonLayout;
    const f = fills(s, steadyAt(s.seed, 4));
    expect(f.slice(0, 8).map(({ x, y, w, h, color }) => [x, y, w, h, color])).toEqual([
      [99, 42, 5, 2, NEON_ART.metal],
      [99, 78, 5, 2, NEON_ART.metal],
      [103, 40, 13, 42, NEON_ART.back],
      [105, 42, 9, 38, "rgba(255, 138, 61, 0.14)"],
      [104, 41, 11, 1, NEON.rust.frame],
      [104, 80, 11, 1, NEON.rust.frame],
      [104, 42, 1, 38, NEON.rust.frame],
      [114, 42, 1, 38, NEON.rust.frame],
    ]);
    const letters = f.slice(8);
    expect(letters).toHaveLength(18);
    expect(letters.every((r) => r.color === NEON.rust.letter)).toBe(true);
  });

  it("a stuttering letter is drawn as a dark tube, the others lit", () => {
    const s = neonLayout(item("rust")) as NeonLayout;
    const { t, letter } = flickerAt(s.seed, 4);
    const f = fills(s, t).slice(8);
    const dark = f.filter((r) => r.color === s.dim);
    expect(dark).toHaveLength(s.letters[letter].length);
    expect(f.length - dark.length).toBe(18 - s.letters[letter].length);
    // The dark tube is the letter colour sunk 65% of the way to an unlit tube:
    // #ff8a3d → #1a1420 = (255·.35 + 26·.65, 138·.35 + 20·.65, 61·.35 + 32·.65) = (106, 61, 42).
    expect(s.dim).toBe("#6a3d2a");
  });
});

describe("renderFrame — the neon dispatch", () => {
  const run = (items: DrawItem[], camera: Camera = cam) => {
    const ctx = recorder();
    renderFrame(ctx, items, camera, null, { w: 400, h: 200, timeMs: 0 });
    return ctx.of("fillRect");
  };

  it("draws a sign on screen, culls one off it, and draws nothing for an unknown language", () => {
    expect(run([item("rust")]).some((c) => c.fillStyle === NEON.rust.frame)).toBe(true);
    expect(run([item("rust")], { zoom: 1, ox: -1000, oy: 0 })).toHaveLength(0);
    expect(run([item("klingon")])).toHaveLength(0);
  });
});

// ───────────────────────────── the light ─────────────────────────────

describe("neonStrength — how far the signs light the street", () => {
  it("nothing in daylight, rising through the evening, full at night", () => {
    expect(neonStrength({ daylight: 1 })).toBe(0);
    expect(neonStrength({ daylight: 0.85 })).toBe(0);
    expect(neonStrength({ daylight: 0.5 })).toBeCloseTo(0.5);
    expect(neonStrength({ daylight: 0.15 })).toBeCloseTo(1);
    expect(neonStrength({ daylight: 0 })).toBe(1);
  });
});

describe("paintNeonLights — the night light", () => {
  const plan = (key: string): CityPlan => ({ key, label: key, team: 0, floors: [{ key: `floor:${key}`, label: key, ide: false }], hasIde: false });
  const world = (langs: (string | null)[]): World => {
    const built = buildCityWorld(langs.map((_, i) => plan(`p${i}`)), { seats: 2 });
    const c = built.city as NonNullable<World["city"]>;
    const of = (key: string) => langs[Number(key.slice(1))];
    return { ...built, city: { ...c, buildings: c.buildings.map((b) => ({ ...b, language: b.hq ? "go" : of(b.key) })) } };
  };
  const paint = (w: World, a: Ambience, t = 0, camera: Camera = cam) => {
    const ctx = recorder();
    paintNeonLights(ctx, a, w, camera, { w: w.cols * TILE, h: w.rows * TILE }, t);
    return { ctx, fills: ctx.of("fillRect").map(box) };
  };

  it("one lit sign per project building with a styled language — not the HQ, not an unknown id; none in the village", () => {
    const w = world(["rust", "klingon", null, "go"]);
    expect(neonSignsOf(w).map((s) => s.sign.style.label).sort()).toEqual(["GO", "RUST"]);
    expect(neonSignsOf(w)).toBe(neonSignsOf(w));
    expect(neonSignsOf({ ...w, city: undefined })).toEqual([]);
  });

  it("by day it paints nothing", () => {
    expect(paint(world(["rust"]), amb({ daylight: 1, phase: "noon" })).fills).toHaveLength(0);
  });

  it("at night: a halo in the sign's colour, a pool on the sidewalk below, the tubes re-lit — all inside its glow box", () => {
    const w = world(["rust"]);
    const [lit] = neonSignsOf(w);
    const { sign, walk } = lit;
    const t = steadyAt(sign.seed, 4);
    const { ctx, fills } = paint(w, amb(), t);
    const halo = fills.filter((f) => f.color === "rgba(255, 138, 61, 0.07)");
    expect(halo).toHaveLength(6);
    // The widest band reaches 12 px round the plate: onto the wall face on the left.
    expect(Math.min(...halo.map((f) => f.x))).toBe(sign.px - 12);
    expect(Math.min(...halo.map((f) => f.x))).toBeLessThan(sign.wall);
    const pool = fills.filter((f) => f.y >= walk);
    expect(pool.map(({ y, h, color }) => [y, h, color])).toEqual([
      [walk, 3, "rgba(255, 138, 61, 0.16)"],
      [walk + 3, 3, "rgba(255, 138, 61, 0.09)"],
    ]);
    expect(fills.filter((f) => f.color === NEON.rust.frame)).toHaveLength(4);
    expect(fills.filter((f) => f.color === NEON.rust.letter)).toHaveLength(18);
    for (const f of fills) expect(overlaps(f, asBox(lit.glow)) && f.x >= lit.glow[0] && f.x + f.w <= lit.glow[0] + lit.glow[2]).toBe(true);
    for (const f of fills) expect(f.y + f.h).toBeLessThanOrEqual(lit.glow[1] + lit.glow[3]);
    for (const f of fills) expect(f.y).toBeGreaterThanOrEqual(lit.glow[1]);
    expect(fills.every((f) => f.alpha === 1)).toBe(true);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("at dusk at half strength; a stuttering letter stays dark; off screen nothing", () => {
    const w = world(["rust"]);
    const [{ sign }] = neonSignsOf(w);
    const half = paint(w, amb({ daylight: 0.5, phase: "dusk" }), steadyAt(sign.seed, 4));
    expect(half.fills.length).toBeGreaterThan(0);
    expect(half.fills.every((f) => Math.abs(f.alpha - 0.5) < 1e-9)).toBe(true);
    expect(half.ctx.globalAlpha).toBe(1);
    const { t, letter } = flickerAt(sign.seed, 4);
    const night = paint(w, amb(), t).fills;
    expect(night.filter((f) => f.color === NEON.rust.letter)).toHaveLength(18 - sign.letters[letter].length);
    // The stuttering tube is not re-lit at all — not even in its dim colour: it stays as graded.
    expect(night.some((f) => f.color === sign.dim)).toBe(false);
    expect(paint(w, amb(), 0, { zoom: 1, ox: -100000, oy: 0 }).fills).toHaveLength(0);
  });

  it("paintAmbience lights them by their own measure (not `lightsOn`), inside the outdoors clip", () => {
    const w = world(["rust"]);
    const [{ sign }] = neonSignsOf(w);
    const ctx = recorder();
    // A stormy afternoon: dark enough for the signs, `lightsOn` notwithstanding.
    paintAmbience(ctx, amb({ daylight: 0.45, lightsOn: false, phase: "afternoon" }), [], 0, w, cam, { w: w.cols * TILE, h: w.rows * TILE }, steadyAt(sign.seed, 4));
    const ops = ctx.calls.map((c) => (c.op === "fillRect" && c.fillStyle === "rgba(255, 138, 61, 0.07)" ? "halo" : c.op));
    const clip = ops.indexOf("clip");
    const halo = ops.indexOf("halo");
    expect(clip).toBeGreaterThanOrEqual(0);
    expect(halo).toBeGreaterThan(clip);
    // …and before that clip is lifted: the save under it is still open at the last halo band (the
    // night sky nests a save/clip/restore of its own in between, balanced).
    const depth = (i: number) => ops.slice(0, i).reduce((d, o) => d + (o === "save" ? 1 : o === "restore" ? -1 : 0), 0);
    expect(depth(clip)).toBeGreaterThan(0);
    expect(depth(ops.lastIndexOf("halo"))).toBeGreaterThanOrEqual(depth(clip));
  });
});
