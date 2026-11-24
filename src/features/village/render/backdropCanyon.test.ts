/**
 * The City's backdrop canyon in Tokyo (render/backdropCanyon.ts): sign-clad mid-rise buildings
 * in clusters between stretches of open sky, karaoke among their signs.
 *
 * Through a recording fake (render/testRecorder.ts): the layout (world-locked clusters on the ground
 * between the backdrop's air, shoulder to shoulder, 5–9 storeys; nothing in the air; the four featured words, two a
 * blade in turn, and a pink karaoke box each cluster), the landmarks' crowns never covered over a sweep of
 * cities, `faceAt` the exact top of what the day pass paints, nothing painted off the view, fine detail
 * only from PANE_ZOOM up, the day rasters blitted at a whole zoom the very rects of the rect pass (a fake
 * OffscreenCanvas records them) — and the night: nothing lit by day, every light through `fillLit` at
 * `neonStrength`, never in the air nor inside a temple's box, a stuttering letter dark, the lit windows
 * only growing, the light rasters bounded. Real pixels are the browser tier's
 * (backdropCanyon.browser.test.tsx).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCityWorld, computeAmbience, planCity } from "../engine";
import { citySky } from "../engine/ambience";
import { dressWorld } from "../engine/streetTheme";
import type { CityPlan } from "../engine/city";
import { TILE, type Ambience, type DayPhase, type VillageAgent, type WeatherKind, type World } from "../villageTypes";
import { VillageView } from "../villageView";
import { AIR_CHUNK, airSpans, citySpan, CROWN_PAD, inQuiet, quietSpans, roofLimit, SIGN_WORDS, type BackdropLightScene, type BackdropScene } from "./backdrop";
import {
  BLADE_RISE,
  bladeWidth,
  CANYON,
  CANYON_ART,
  canyonLayout,
  canyonSigns,
  FEATURED,
  FLOORS_MAX,
  FLOORS_MIN,
  MAX_RASTERS,
  PANEL_H,
  PLATE_GAP,
  PICTO_RUNS,
  SCENE_MS,
  SCREEN_GLOW,
  screenScene,
  SKY_SHARE,
  STOREY,
  type CanyonSign,
} from "./backdropCanyon";
import type { Camera } from "./camera";
import { KANA_H, KANA_W, kanaText } from "./kana";
import { landmarkCrown, landmarksFor, placeLandmarks } from "./landmarks";
import { neonStrength } from "./neon";
import { sx, sy } from "./paint";
import { recorder, type RecordingTarget } from "./testRecorder";

// ───────────────────────────── worlds and skies ─────────────────────────────

const agentOf = (key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent => ({
  key,
  parentKey: null,
  origin: "ide",
  title: key,
  folder,
  activity: "typing",
  tool: null,
  ideAgentId: key,
  lastActivityAt: null,
  ...extra,
});
/** The reference city: a seven-floor gazelle of 26 seats a floor, the HQ, a small Agent Studio — dressed for Tokyo. */
function referenceCity(): World {
  const agents = [
    ...Array.from({ length: 7 }, (_, i) => agentOf(`g${i}`, "gazelle", { language: "rust" })),
    ...Array.from({ length: 26 }, (_, i) => agentOf(`g0.s${i}`, "gazelle", { parentKey: "g0", language: "rust" })),
    agentOf("a0", "Agent Studio", { language: "typescript" }),
    agentOf("a0.s0", "Agent Studio", { parentKey: "a0", language: "typescript" }),
  ];
  return dressWorld(buildCityWorld(planCity(agents).plans, { seats: 64 }), "Asia/Tokyo");
}
const reference = referenceCity();

const plan = (i: number, floors: number, team = 2): CityPlan => ({
  key: `p${i}`,
  label: `p${i}`,
  team,
  hasIde: true,
  floors: Array.from({ length: floors }, (_, f) => ({ key: `floor:${i}:${f}`, label: `a${i}.${f}`, ide: true })),
});
/** A city of projects of `floors` floors each, beside the capacity HQ. */
const city = (floors: number[], team = 2): World => buildCityWorld(floors.map((f, i) => plan(i, f, i === 0 ? team : 2)), { seats: 64 });
/** The lowest city there is: the HQ and two one-floor projects (a sky of 240 px). */
const low = city([1, 1]);

const horizonOf = (w: World): number => w.city!.street * TILE;

/** The sky in `phase` and `weather`, in Tokyo unless `zone` says otherwise. */
function sky(phase: DayPhase, weather: WeatherKind = "clear", zone: string | undefined = "Asia/Tokyo"): Ambience {
  return computeAmbience(new Date(2026, 9, 26, 15, 0), null, { weather, phase }, zone);
}
const noon = sky("noon");
const night = sky("night");
const dusk = sky("dusk");

// ───────────────────────────── scenes ─────────────────────────────

type Recorded = BackdropScene & { ctx: RecordingTarget };

/** The day pass's scene for `cam` over a `view`, as render/city.ts builds it. */
function scene(world: World, amb: Ambience | undefined, cam: Camera, view: { w: number; h: number }, timeMs = 0): Recorded {
  const ox = Math.round(cam.ox);
  return { ctx: recorder(), cam, world, view, amb, horizon: horizonOf(world), timeMs, x0: (0 - ox) / cam.zoom, x1: (view.w - ox) / cam.zoom };
}

interface Lit {
  x: number;
  y: number;
  w: number;
  h: number;
  style: unknown;
  alpha: number;
}

/** The night pass's scene, its `fillLit` recording each light (with the style and alpha it was given). */
function lightScene(world: World, amb: Ambience, cam: Camera, view: { w: number; h: number }, timeMs = 0, lit = citySky(amb).lit): BackdropLightScene & { ctx: RecordingTarget; lights: Lit[] } {
  const s = scene(world, amb, cam, view, timeMs);
  const lights: Lit[] = [];
  return {
    ...s,
    amb,
    dark: Math.min(1, Math.max(0, (0.6 - amb.daylight) / 0.45)),
    lit,
    lights,
    fillLit: (x, y, w, h) => lights.push({ x, y, w, h, style: s.ctx.fillStyle, alpha: s.ctx.globalAlpha }),
    hidden: () => false,
  };
}

/** A camera at zoom `z` whose view starts at world x `x0` and shows the canyon's band (the street's top 40 px above the bottom). */
function camAt(world: World, x0: number, z = 1, h = 360): { cam: Camera; view: { w: number; h: number } } {
  return { cam: { zoom: z, ox: -Math.round(x0 * z), oy: Math.round(h - 40 - horizonOf(world) * z) }, view: { w: 1024, h } };
}

/** The fills a recorder holds, with the style each was painted in. */
const fills = (ctx: RecordingTarget) => ctx.of("fillRect").map((c) => ({ x: c.args[0] as number, y: c.args[1] as number, w: c.args[2] as number, h: c.args[3] as number, color: c.fillStyle }));

/** The vertical signs of a span, a blade (its plates, top down) each: the plates of one blade share its column. */
function bladesOf(signs: CanyonSign[]): CanyonSign[][] {
  const columns = new Map<string, CanyonSign[]>();
  for (const g of signs) if (g.vertical) columns.set(`${g.box[0]},${g.box[2]}`, [...(columns.get(`${g.box[0]},${g.box[2]}`) ?? []), g]);
  return [...columns.values()].map((p) => p.sort((a, b) => a.box[1] - b.box[1]));
}

/** The camera VillageView's Fit gives `world` in a `w`×`h` CSS px pane at `dpr` (HUD 117 px tall), in Tokyo. */
function fitOf(world: World, w: number, h: number, dpr: number): { cam: Camera; view: { w: number; h: number } } {
  const v = new VillageView(1, () => null, "city");
  v.resize(w, h, dpr);
  v.setInset(117);
  v.setWorld(world);
  v.setAmbience(noon);
  return { cam: v.camera, view: v.view };
}

/** The world x span a camera shows. */
const spanOf = (cam: Camera, view: { w: number }): [number, number] => [-Math.round(cam.ox) / cam.zoom, (view.w - Math.round(cam.ox)) / cam.zoom];

/** The backdrop's air span in air chunk `a` (render/backdrop.ts). */
const airOf = (a: number): [number, number] => airSpans(a * AIR_CHUNK, (a + 1) * AIR_CHUNK)[0];
/** Cluster `a`'s whole span — its ground, then the air after it — and its ground alone. */
const clusterOf = (a: number): [number, number] => [airOf(a)[1], airOf(a + 1)[1]];
const groundOf = (a: number): [number, number] => [airOf(a)[1], airOf(a + 1)[0]];
/** Cluster `a`'s ground in `world` less its quiet (the city's span), as the stretches a building may stand on. */
function stretchesOf(world: World, a: number): [number, number][] {
  const x1 = groundOf(a)[1];
  let x0 = groundOf(a)[0];
  const out: [number, number][] = [];
  for (const [q0, q1] of quietSpans(world, x0, x1)) {
    if (q0 - x0 >= 48) out.push([x0, q0]);
    x0 = Math.max(x0, q1);
  }
  if (x1 - x0 >= 48) out.push([x0, x1]);
  return out;
}
/** A camera at zoom `z` framing clusters `a` to `b` (inclusive) exactly: no blade straddles its edges. */
function camOn(world: World, a: number, b = a, z = 1): { cam: Camera; view: { w: number; h: number } } {
  const out = camAt(world, clusterOf(a)[0], z);
  out.view.w = Math.round((clusterOf(b)[1] - clusterOf(a)[0]) * z);
  return out;
}

// ───────────────────────────── a fake raster host ─────────────────────────────

/** A pattern made from a fake raster, remembering its last transform. */
interface FakePattern {
  raster: FakeRaster;
  transform: DOMMatrix2DInit | null;
  setTransform(t: DOMMatrix2DInit): void;
}

/** An OffscreenCanvas standing in for the browser's: a recording context that can make a pattern. */
class FakeRaster {
  static made: FakeRaster[] = [];
  readonly ctx: RecordingTarget & { createPattern(image: unknown, repeat: string): FakePattern };
  constructor(
    public width: number,
    public height: number,
  ) {
    this.ctx = Object.assign(recorder(), {
      createPattern: (_image: unknown, repeat: string): FakePattern => {
        expect(repeat).toBe("no-repeat");
        return {
          raster: this,
          transform: null,
          setTransform(t) {
            this.transform = t;
          },
        };
      },
    });
    FakeRaster.made.push(this);
  }
  getContext(): RecordingTarget {
    return this.ctx;
  }
}

/**
 * What a day pass painted, as screen fills in paint order: its own fills, and each fake raster it blitted
 * laid out where it landed (at a whole zoom, exactly where its rects would be).
 */
function painting(ctx: RecordingTarget): { x: number; y: number; w: number; h: number; color: string }[] {
  return ctx.calls.flatMap((c) => {
    if (c.op === "fillRect") return [{ x: c.args[0] as number, y: c.args[1] as number, w: c.args[2] as number, h: c.args[3] as number, color: c.fillStyle }];
    const [image, , , sw, , dx, dy, dw] = c.args as [FakeRaster, number, number, number, number, number, number, number];
    const z = dw / sw;
    return fills(image.ctx).map((f) => ({ x: dx + f.x * z, y: dy + f.y * z, w: f.w * z, h: f.h * z, color: f.color }));
  });
}

/** No canvas host at all, as jsdom has none of its own. */
function noCanvas(): void {
  vi.stubGlobal("OffscreenCanvas", undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}

beforeEach(() => {
  FakeRaster.made = [];
  vi.stubGlobal("OffscreenCanvas", FakeRaster);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ───────────────────────────── the layout ─────────────────────────────

describe("the canyon's layout", () => {
  const h = horizonOf(reference);

  it("stands in clusters on the ground between the backdrop's QUIET stretches — the open sky and the city's own span — shoulder to shoulder from the end of one to the start of the next, 48–95 px wide, 5–9 storeys of 20 px where nothing lowers them; a ground too narrow stays sky", () => {
    const seen = { w: new Set<number>(), floors: new Set<number>() };
    let stretches = 0;
    let none = 0;
    let cut = 0;
    for (let a = -40; a < 40; a++) {
      const [c0, c1] = clusterOf(a);
      // No zone: no landmark to stand under; the reference city's sky is tall enough for nine storeys.
      const { buildings } = canyonLayout(reference, undefined, h, c0, c1);
      for (const b of buildings) expect(inQuiet(reference, b.x, b.x + b.w), `${b.x}+${b.w}`).toBe(false);
      const ground = stretchesOf(reference, a);
      if (ground.length === 0) none++;
      if (ground.length && (ground[0][0] !== groundOf(a)[0] || ground.at(-1)![1] !== groundOf(a)[1])) cut++;
      // Every stretch filled from its start to its end, nothing else built.
      expect(buildings.reduce((sum, b) => sum + b.w, 0)).toBe(ground.reduce((sum, [g0, g1]) => sum + g1 - g0, 0));
      for (const [g0, g1] of ground) {
        stretches++;
        const here = buildings.filter((b) => b.x >= g0 && b.x + b.w <= g1);
        expect(here[0].x).toBe(g0);
        here.forEach((b, i) => {
          expect(b.x + b.w).toBe(i + 1 < here.length ? here[i + 1].x : g1);
          expect(b.w).toBeGreaterThanOrEqual(48);
          expect(b.w).toBeLessThan(96);
          expect(b.floors).toBeGreaterThanOrEqual(FLOORS_MIN);
          expect(b.floors).toBeLessThanOrEqual(FLOORS_MAX);
          expect(b.top).toBe(h - b.floors * STOREY - 3);
          seen.w.add(b.w);
          seen.floors.add(b.floors);
        });
      }
    }
    expect(stretches).toBeGreaterThan(60);
    // Not vacuous: grounds too narrow (or all the city's) stay sky; and a city's span cuts a ground short
    // (in the low cities beside its narrow span) — building only on what is left of it.
    expect(none).toBeGreaterThan(0);
    for (const world of [low, city([1]), city([3]), city([1, 2])])
      for (let a = -3; a < 6; a++) {
        const ground = stretchesOf(world, a);
        if (!ground.length || (ground[0][0] === groundOf(a)[0] && ground.at(-1)![1] === groundOf(a)[1])) continue;
        cut++;
        const built = canyonLayout(world, undefined, horizonOf(world), ...clusterOf(a)).buildings;
        expect(built.reduce((sum, b) => sum + b.w, 0)).toBe(ground.reduce((sum, [g0, g1]) => sum + g1 - g0, 0));
        for (const b of built) expect(inQuiet(world, b.x, b.x + b.w)).toBe(false);
      }
    expect(cut).toBeGreaterThan(0);
    expect([...seen.floors].sort()).toEqual([5, 6, 7, 8, 9]);
    expect(seen.w.size).toBeGreaterThanOrEqual(5);
    // A storey is 1¼ tiles.
    expect(STOREY).toBe(1.25 * TILE);
  });

  it("leaves no sliver beside the city: wherever its span falls against the air, a stretch it leaves is a building wide or sky", () => {
    let slivers = 0;
    for (let d = -24; d <= 24; d++) {
      // The reference city, moved d tiles along the street.
      const city = reference.city!;
      const world: World = { ...reference, city: { ...city, buildings: city.buildings.map((b) => ({ ...b, col: b.col + d })) } };
      const [w0, w1] = citySpan(world)!;
      for (let a = Math.floor(w0 / AIR_CHUNK) - 1; a <= Math.floor(w1 / AIR_CHUNK); a++) {
        const [g0, g1] = groundOf(a);
        if (w0 > g0 && w0 < g0 + 48) slivers++;
        if (w1 < g1 && w1 > g1 - 48) slivers++;
        for (const b of canyonLayout(world, undefined, h, ...clusterOf(a)).buildings) {
          expect(b.w, `${b.x}+${b.w} beside a city at ${w0}..${w1}`).toBeGreaterThanOrEqual(48);
          expect(inQuiet(world, b.x, b.x + b.w)).toBe(false);
        }
      }
    }
    // Not vacuous: the city's walls fell within a building's width of a stretch's ends.
    expect(slivers).toBeGreaterThan(2);
  });

  it("signs every other building and leaves the rest windows only; a signed one hangs ONE blade of two plates, inside its own wall and never down into its ground floor — and each cluster of four buildings or more a KARAOKE BOX, its tallest 56 px wide or more (never the screen's), a giant カラオケ over signboards of mics", () => {
    let boxes = 0;
    let big = 0;
    let mics = 0;
    let signed = 0;
    let total = 0;
    let screened = 0;
    const firsts = new Set<number>();
    const plastic = new Set(CANYON_ART.plastics.map((q) => q.day));
    // A pictogram is 9×7, centred on its board.
    const [pw, py] = [9, Math.floor((PANEL_H - 7) / 2)];
    const clusters = 40;
    for (let a = 8; a < 8 + clusters; a++) {
      const [c0, c1] = clusterOf(a);
      const { buildings, screens } = canyonLayout(reference, night, h, c0, c1);
      const signs = canyonSigns(reference, night, h, c0, c1);
      const columns = bladesOf(signs);
      const { cam, view } = camOn(reference, a);
      const s = scene(reference, noon, cam, view);
      CANYON.paint(s);
      const [ox, oy] = [Math.round(cam.ox), Math.round(cam.oy)];
      const painted = painting(s.ctx).map((f) => ({ ...f, x: f.x - ox, y: f.y - oy }));
      const day = new Set(painted.map((f) => `${f.x} ${f.y} ${f.w} ${f.h}`));
      const boardsOf = (b: (typeof buildings)[number]) => painted.filter((f) => f.h === PANEL_H && plastic.has(f.color) && f.x >= b.x && f.x < b.x + b.w);
      // One blade at most a building; a building without one wears no sign at all, only windows.
      const bladeOf = (b: (typeof buildings)[number]) => columns.filter((p) => p[0].box[0] >= b.x && p[0].box[0] < b.x + b.w);
      const withBlade = buildings.map((b) => bladeOf(b).length);
      for (const [n, b] of withBlade.map((n, i) => [n, buildings[i]] as const)) {
        expect(n).toBeLessThanOrEqual(1);
        total++;
        signed += n;
        if (n === 0) {
          expect(boardsOf(b)).toEqual([]);
          expect(signs.filter((g) => g.box[0] >= b.x && g.box[0] < b.x + b.w)).toEqual([]);
        }
      }
      // Every other building signed (the karaoke box always): never two unsigned side by side — from a
      // place of the cluster's own (its first building signed or not).
      for (let i = 1; i < buildings.length; i++) expect(withBlade[i - 1] + withBlade[i]).toBeGreaterThan(0);
      if (buildings.length) firsts.add(withBlade[0]);
      // An unsigned building wears no plastic at all — no board, no fascia over its shop; a signed one a fascia.
      buildings.forEach((b, i) => {
        const plasticOf = painted.filter((f) => plastic.has(f.color) && f.x >= b.x && f.x < b.x + b.w && f.y >= b.top);
        const fascia = plasticOf.some((f) => f.x === b.x + 1 && f.y === h - STOREY + 2 && f.w === b.w - 1 && f.h === 3);
        if (withBlade[i] === 0) expect(plasticOf, `the unsigned building at ${b.x}`).toEqual([]);
        else expect(fascia, `the signed building at ${b.x}`).toBe(true);
      });
      // A screen stands only on a signed building.
      for (const sc of screens) expect(withBlade[buildings.findIndex((b) => sc.box[0] >= b.x && sc.box[0] < b.x + b.w)]).toBe(1);
      screened += screens.length;
      let box = 0;
      for (const plates of columns) {
        const [x, y, w] = plates[0].box;
        const b = buildings.find((o) => x >= o.x && x + w <= o.x + o.w) as (typeof buildings)[number];
        expect(y).toBe(b.top - BLADE_RISE);
        const last = plates[plates.length - 1].box;
        expect(last[1] + last[3]).toBeLessThanOrEqual(h - STOREY);
        const k = (w - 6) / KANA_W;
        expect(w).toBe(bladeWidth(k));
        for (const g of plates) expect(g.box[3]).toBe(6 + k * kanaText(g.text, true).h);
        if (k === 1) {
          expect(plates.length).toBe(2);
          continue;
        }
        box++;
        expect(plates.map((g) => g.text)).toEqual(["カラオケ"]);
        expect(b.w).toBeGreaterThanOrEqual(56);
        expect(screens.some((sc) => sc.box[0] >= b.x && sc.box[0] < b.x + b.w)).toBe(false);
        for (const o of buildings) if (o.w >= 56 && o.x < b.x) expect(o.floors).toBeLessThan(b.floors);
        for (const o of buildings) if (o.w >= 56) expect(o.floors).toBeLessThanOrEqual(b.floors);
        // Its signboards are mics (or plain plastic): no word on them.
        expect(signs.filter((g) => !g.vertical && g.box[0] >= b.x && g.box[0] < b.x + b.w)).toEqual([]);
        for (const f of boardsOf(b)) {
          const mic = PICTO_RUNS[2].every(([dx, dy, rw, rh]) => day.has(`${f.x + Math.floor((f.w - pw) / 2) + dx} ${f.y + py + dy} ${rw} ${rh}`));
          const plain = day.has(`${f.x} ${f.y + 4} ${f.w} 3`) || day.has(`${f.x + f.w - 9} ${f.y + 2} 7 ${PANEL_H - 4}`);
          expect(mic || plain, `a board of the karaoke box at (${f.x}, ${f.y})`).toBe(true);
          mics += mic ? 1 : 0;
        }
      }
      // A box in every cluster of four or more (one with a building 56 px wide), in none smaller.
      expect(box).toBe(buildings.length >= 4 && buildings.some((b) => b.w >= 56) ? 1 : 0);
      big += buildings.length >= 4 ? 1 : 0;
      boxes += box;
    }
    expect(boxes).toBeGreaterThan(0.5 * big);
    expect(big).toBeGreaterThan(5);
    expect(mics).toBeGreaterThan(0);
    // About half signed (the calm pass).
    expect(signed / total).toBeGreaterThan(0.45);
    expect(signed / total).toBeLessThan(0.65);
    expect([...firsts].sort()).toEqual([0, 1]);
    expect(screened).toBeGreaterThan(0);
  });

  it("puts signboards on a third of a signed building's storeys at most, never on two storeys in a row — and none on an unsigned one", () => {
    const plastic = new Set(CANYON_ART.plastics.map((q) => q.day));
    let boards = 0;
    const tops = new Set<boolean>();
    for (let a = 8; a < 40; a++) {
      if (!built(a)) continue;
      const { cam, view } = camOn(reference, a);
      const s = scene(reference, noon, cam, view);
      CANYON.paint(s);
      const [ox, oy] = [Math.round(cam.ox), Math.round(cam.oy)];
      const painted = painting(s.ctx).filter((f) => f.h === PANEL_H && plastic.has(f.color));
      const { buildings, screens } = canyonLayout(reference, noon, h, ...clusterOf(a));
      const blades = canyonSigns(reference, noon, h, ...clusterOf(a)).filter((g) => g.vertical);
      for (const b of buildings) {
        const mine = painted.filter((f) => f.x - ox >= b.x && f.x - ox < b.x + b.w).sort((p, q) => p.y - q.y);
        // A signed building's boards fall here and there down it: its top storey a board, or windows.
        const signed = blades.some((g) => g.box[0] >= b.x && g.box[0] < b.x + b.w);
        if (signed && b.floors >= 3 && !screens.some((sc) => sc.box[0] >= b.x && sc.box[0] < b.x + b.w)) tops.add(mine.some((f) => f.y - oy === b.top + 6));
        expect(mine.length).toBeLessThanOrEqual(Math.floor(b.floors / 3));
        for (let i = 1; i < mine.length; i++) {
          expect(mine[i].y - mine[i - 1].y).toBeGreaterThan(STOREY);
          expect(mine[i].color, `boards of the building at ${b.x}`).not.toBe(mine[i - 1].color);
        }
        boards += mine.length;
        expect(mine.every((f) => f.y - oy > b.top)).toBe(true);
      }
    }
    expect(boards).toBeGreaterThan(20);
    expect([...tops].sort()).toEqual([false, true]);
  });

  it("wears the four featured words, two a blade in turn along every cluster — so any two neighbours show all four — and only SIGN_WORDS anywhere, every one of them shown", () => {
    // Sushi in hiragana; karaoke last.
    expect(FEATURED).toEqual(["ラーメン", "ソバ", "すし", "カラオケ"]);
    const words = new Set(SIGN_WORDS.map((w) => w.text));
    const shown = new Set<string>();
    const starts = new Set<string>();
    let pairs = 0;
    for (let a = -60; a < 60; a++) {
      const [c0, c1] = clusterOf(a);
      const signs = canyonSigns(reference, night, h, c0, c1);
      for (const g of signs) {
        expect(words.has(g.text), g.text).toBe(true);
        shown.add(`${g.vertical ? "|" : "-"}${g.text}`);
      }
      const blades = bladesOf(signs)
        .filter((p) => p[0].box[2] === bladeWidth(1))
        .sort((p, q) => p[0].box[0] - q[0].box[0]);
      for (const plates of blades) {
        const i = FEATURED.indexOf(plates[0].text);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(plates[1].text).toBe(FEATURED[(i + 1) % 4]);
      }
      if (blades.length) starts.add(blades[0][0].text);
      for (let j = 1; j < blades.length; j++) {
        expect(FEATURED.indexOf(blades[j][0].text)).toBe((FEATURED.indexOf(blades[j - 1][0].text) + 2) % 4);
        expect(new Set([...blades[j - 1], ...blades[j]].map((g) => g.text)).size).toBe(4);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(15);
    // Each cluster starts the turn at a place of its own: two small neighbouring clusters show different pairs.
    expect(starts.size).toBe(4);
    // Every word shows on a signboard, and the featured four on blades.
    for (const w of words) expect(shown.has("-" + w), w).toBe(true);
    for (const w of FEATURED) expect(shown.has("|" + w), w).toBe(true);
  });

  it("shows ラーメン, ソバ, すし and カラオケ on blades in the open street past BOTH ends of the reference city at Fit, @2x and @1x", () => {
    const walls = reference.city!.buildings.map((b) => [b.col * TILE, (b.col + b.w) * TILE]);
    const first = Math.min(...walls.map((w) => w[0]));
    const last = Math.max(...walls.map((w) => w[1]));
    for (const [w, hh, dpr] of [
      [1280, 800, 2],
      [1280, 800, 1],
    ]) {
      const { cam, view } = fitOf(reference, w, hh, dpr);
      const [x0, x1] = spanOf(cam, view);
      for (const [a, b] of [
        [x0, first],
        [last, x1],
      ]) {
        const read = canyonSigns(reference, night, h, a, b)
          .filter((g) => g.vertical)
          .map((g) => g.text);
        for (const word of FEATURED) expect(read, `${w}×${hh}@${dpr} over [${a}, ${b})`).toContain(word);
      }
    }
  });

  it("hangs two words as two signs, never one: a plate each, PLATE_GAP of bare wall and two steel hangers between, the second in colours of its own", () => {
    const { cam, view } = camOn(reference, 8, 19);
    const [x0, x1] = spanOf(cam, view);
    const s = scene(reference, noon, cam, view);
    CANYON.paint(s);
    const day = painting(s.ctx);
    const at = (wx: number, wy: number) => day.filter((f) => sx(cam, wx) >= f.x && sx(cam, wx) < f.x + f.w && sy(cam, wy) >= f.y && sy(cam, wy) < f.y + f.h).at(-1)?.color;
    const pairs = bladesOf(canyonSigns(reference, noon, h, x0, x1)).filter((p) => p.length === 2);
    expect(pairs.length).toBeGreaterThan(8);
    const steel = new Set([CANYON_ART.steel]);
    for (const [a, b] of pairs) {
      const [x, y, w, ph] = a.box;
      expect(PLATE_GAP).toBeGreaterThanOrEqual(5);
      expect(b.box).toEqual([x, y + ph + PLATE_GAP, w, b.box[3]]);
      // The gap: the wall, but for the two hangers; no plate, no glyph, no tube.
      const gap = new Set<string>();
      for (let gy = y + ph; gy < y + ph + PLATE_GAP; gy++) for (let gx = x; gx < x + w; gx++) gap.add(at(gx, gy) as string);
      const walls = new Set(CANYON_ART.facades.map((t) => t.wall));
      for (const c of gap) expect(walls.has(c) || steel.has(c), `the gap under ${a.text}: ${c}`).toBe(true);
      expect(at(x + 2, y + ph + 1)).toBe(CANYON_ART.steel);
      expect(at(x + w - 4, y + ph + 1)).toBe(CANYON_ART.steel);
      // Its own colours: the second word's letters (neon) or its plate (a box) unlike the first's.
      const ink = (g: CanyonSign) => {
        const [dx, dy] = kanaText(g.text, true).runs[0];
        return at(g.box[0] + 3 + dx, g.box[1] + 3 + dy);
      };
      const plate = (g: CanyonSign) => at(g.box[0], g.box[1]);
      if (plate(a) === CANYON_ART.back) expect(ink(b), `${a.text} over ${b.text}`).not.toBe(ink(a));
      else expect(plate(b), `${a.text} over ${b.text}`).not.toBe(plate(a));
    }
  });

  it("stands up from its roof only what a roof wears: a blade 6 px, a tank 9 on its 2-px base, a stair house 9, a billboard 18–24 on its plinth", () => {
    const s = scene(reference, undefined, { zoom: 1, ox: 0, oy: 0 }, { w: 1, h: 1 });
    const seen = new Set<number>();
    const { buildings } = canyonLayout(reference, undefined, h, 2400, 9000);
    let bare = 0;
    for (const b of buildings) {
      const ups = new Set<number>();
      for (let x = b.x; x < b.x + b.w; x++) {
        const up = b.top - CANYON.faceAt(s, x);
        expect([0, 2, BLADE_RISE, 9, 18, 21, 24], `x ${x}`).toContain(up);
        seen.add(up);
        ups.add(up);
      }
      if ([...ups].every((up) => up === 0 || up === BLADE_RISE)) bare++;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 2, BLADE_RISE, 9, 18, 21, 24]);
    // The calm pass: many a roof bare — about two in five.
    expect(bare / buildings.length).toBeGreaterThan(0.25);
    expect(bare / buildings.length).toBeLessThan(0.6);
  });

  it("writes every signboard's word inside its board", () => {
    let words = 0;
    for (const g of canyonSigns(reference, noon, h, 2400, 16000)) {
      const t = kanaText(g.text, g.vertical);
      if (!g.vertical) {
        expect(g.box[3]).toBe(PANEL_H);
        expect(t.w + 4).toBeLessThanOrEqual(g.box[2]);
        words++;
      }
    }
    expect(words).toBeGreaterThan(10);
  });

  it("never covers a landmark's crown — over a sweep of cities of 0–3 projects of 1–12 floors: no face rises above CROWN_PAD under Fuji's snow or a tower's deck, CROWN_PAD either side", () => {
    let lowered = 0;
    let crowns = 0;
    const cities: World[] = [reference, low];
    for (const floors of [[], [1], [3], [1, 1], [2, 5], [7, 1], [1, 7, 3], [12, 5], [1, 12, 1], [4, 9, 11]]) for (const team of [2, 26]) cities.push(city(floors, team));
    for (const world of cities) {
      const wh = horizonOf(world);
      const s = scene(world, night, { zoom: 1, ox: 0, oy: 0 }, { w: 1, h: 1 });
      for (const p of placeLandmarks(world, wh, landmarksFor("Asia/Tokyo")).placed) {
        if (p.spec.layer === "near") continue;
        const c = landmarkCrown(p);
        crowns++;
        for (let x = c.x0 - CROWN_PAD; x < c.x1 + CROWN_PAD; x++) expect(CANYON.faceAt(s, x), `${p.spec.kind} at x ${x}`).toBeGreaterThanOrEqual(c.bottom + CROWN_PAD);
      }
      const cap = wh - Math.round(SKY_SHARE * (wh - TILE));
      for (const g of canyonSigns(world, night, wh, -600, world.cols * TILE + 600)) if (g.vertical) expect(g.box[1] + g.box[3], g.text).toBeLessThanOrEqual(wh - STOREY);
      for (const b of canyonLayout(world, night, wh, -600, world.cols * TILE + 600).buildings.filter((o) => o.floors < FLOORS_MIN)) {
        lowered++;
        // Lowered no more than it must be: its roof object goes first, so one storey more would break the limit.
        const limit = Math.max(roofLimit(world, night, wh, b.x, b.x + b.w, ["far", "tower"]), cap);
        expect(b.top - BLADE_RISE).toBeGreaterThanOrEqual(limit);
        if (b.floors > 1) expect(b.top - STOREY - BLADE_RISE).toBeLessThan(limit);
      }
    }
    // Not vacuous: crowns were tested, and some buildings had to come down for them.
    expect(crowns).toBe(3 * cities.length);
    expect(lowered).toBeGreaterThan(0);
  });

  it("stays under SKY_SHARE of a low city's sky (roofs, billboards, tanks and blades all)", () => {
    for (const world of [low, city([1]), city([2, 1])]) {
      const wh = horizonOf(world);
      const cap = wh - Math.round(SKY_SHARE * (wh - TILE));
      const s = scene(world, undefined, { zoom: 1, ox: 0, oy: 0 }, { w: 1, h: 1 });
      let tallest = wh;
      for (let x = -800; x < 1600; x++) tallest = Math.min(tallest, CANYON.faceAt(s, x));
      expect(tallest).toBeGreaterThanOrEqual(cap);
      // …and reaches it: a low city's canyon is as tall as its sky allows.
      expect(tallest - cap).toBeLessThan(STOREY);
    }
  });

  it("is world-locked: a building is a function of world x alone — the same whichever cluster is laid out first, for any World built the same", () => {
    const sa = scene(referenceCity(), night, { zoom: 1, ox: 0, oy: 0 }, { w: 1, h: 1 });
    const sb = scene(referenceCity(), night, { zoom: 3, ox: 999, oy: -7 }, { w: 5, h: 5 });
    const xs = Array.from({ length: 900 }, (_, i) => -2000 + i * 7);
    const fa = xs.map((x) => CANYON.faceAt(sa, x));
    const fb = [...xs].reverse().map((x) => CANYON.faceAt(sb, x)).reverse();
    expect(fb).toEqual(fa);
    // A fractional x reads its whole pixel's column — where the next column's face differs too.
    const step = xs.find((x) => CANYON.faceAt(sa, x) !== CANYON.faceAt(sa, x + 1)) as number;
    expect(CANYON.faceAt(sa, step + 0.5)).toBe(CANYON.faceAt(sa, step));
    expect(CANYON.faceAt(sa, step + 0.99)).toBe(CANYON.faceAt(sa, step));
  });

  it("lays a new canyon for a new horizon or city: no zone, no crown to stand under", () => {
    const tall = city([1, 7, 3]);
    const th = horizonOf(tall);
    // Paris has no landmark: nothing is lowered under one there, so in some city it stands taller.
    let taller = 0;
    for (const world of [low, city([1]), city([2, 1]), tall]) {
      const wh = horizonOf(world);
      const tokyo = canyonLayout(world, night, wh, -2000, world.cols * TILE + 2000).buildings;
      const nowhere = canyonLayout(world, sky("night", "clear", "Europe/Paris"), wh, -2000, world.cols * TILE + 2000).buildings;
      expect(canyonLayout(world, night, wh, -2000, world.cols * TILE + 2000).buildings).toEqual(tokyo);
      taller += nowhere.filter((b, i) => b.floors > tokyo[i].floors).length;
    }
    expect(taller).toBeGreaterThan(0);
    // A different horizon lays it out on that street (far from any crown: the same storeys).
    const [g0, g1] = groundOf(30);
    const here = canyonLayout(tall, night, th, g0, g1).buildings[0];
    expect(canyonLayout(tall, night, th + TILE, g0, g1).buildings[0].top).toBe(here.top + TILE);
  });

  it("shows the sky in the backdrop's quiet — the open stretches and the city's own span: faceAt is the street there, nothing is painted by day nor lit at night", () => {
    const s = scene(reference, noon, { zoom: 1, ox: 0, oy: 0 }, { w: 1, h: 1 });
    let columns = 0;
    const quiet = quietSpans(reference, -3000, 3000);
    // The city's span, wall to wall, is one of them.
    const [w0, w1] = citySpan(reference)!;
    expect(quiet.some(([a, b]) => a <= w0 && b >= w1)).toBe(true);
    for (const [a, b] of quiet)
      for (let x = a; x < b; x++) {
        expect(CANYON.faceAt(s, x), `x ${x}`).toBe(h);
        columns++;
      }
    expect(columns).toBeGreaterThan(2000);
    const inside = (x: number, w: number) => quiet.some(([a, b]) => x < b && a < x + w);
    for (const [z, x0] of [
      [1, 1184],
      [2, 1184],
      [0.5, 1184],
      [1, -650],
      [0.5, 100],
    ] as const) {
      const { cam, view } = camAt(reference, x0, z);
      const day = scene(reference, noon, cam, view, 0);
      CANYON.paint(day);
      const ox = Math.round(cam.ox);
      const painted = painting(day.ctx);
      expect(painted.length).toBeGreaterThan(0);
      // Below 1 a rect is snapped to whole screen px (≥ 1 of them): it may round up to 1/z world px over an edge.
      const slack = z < 1 ? 1 / z : 0;
      for (const f of painted) expect(inside((f.x - ox) / z + slack, f.w / z - 2 * slack), JSON.stringify(f)).toBe(false);
      const lit = lightScene(reference, night, cam, view, 0, 1);
      CANYON.paintLights(lit);
      expect(lit.lights.length).toBeGreaterThan(0);
      for (const l of lit.lights) expect(inside(l.x, l.w), JSON.stringify({ ...l, style: 0 })).toBe(false);
    }
  });

});

// ───────────────────────────── the day pass ─────────────────────────────

/** Which world pixels a zoom-1 day pass painted (opaque colours only), over the view's columns and rows. */
function painted(s: Recorded): { at: (wx: number, wy: number) => boolean; columns: number[] } {
  const { cam, view } = s;
  const grid = new Uint8Array(view.w * view.h);
  for (const f of painting(s.ctx)) {
    expect(f.color, "a day colour is opaque").toMatch(/^#[0-9a-f]{6}$/);
    for (let y = Math.max(0, f.y); y < Math.min(view.h, f.y + f.h); y++) for (let x = Math.max(0, f.x); x < Math.min(view.w, f.x + f.w); x++) grid[y * view.w + x] = 1;
  }
  const ox = Math.round(cam.ox);
  const oy = Math.round(cam.oy);
  return {
    at: (wx, wy) => grid[(wy + oy) * view.w + (wx + ox)] === 1,
    columns: Array.from({ length: view.w }, (_, i) => i - ox),
  };
}

describe("the day pass", () => {
  it("faceAt is exactly the top of what it paints — nothing above it, everything under it down to the street", () => {
    for (const [world, x0] of [
      [reference, -600],
      [reference, 1400],
      [reference, 2600],
      [low, -900],
      [city([12, 5]), 1700],
    ] as const) {
      const h = horizonOf(world);
      const s = scene(world, noon, { zoom: 1, ox: -x0, oy: -(h - 300) }, { w: 1100, h: 320 });
      CANYON.paint(s);
      const px = painted(s);
      let faces = 0;
      const wrong: string[] = [];
      for (const x of px.columns) {
        const face = CANYON.faceAt(s, x);
        for (let y = h - 300; y < face; y++) if (px.at(x, y)) wrong.push(`(${x}, ${y}) painted over the face ${face}`);
        for (let y = face; y < h; y++) if (!px.at(x, y)) wrong.push(`(${x}, ${y}) bare under the face ${face}`);
        if (px.at(x, h)) wrong.push(`(${x}, ${h}) painted on the street`);
        if (face < h) faces++;
      }
      expect(wrong.slice(0, 5)).toEqual([]);
      expect(faces).toBeGreaterThan(300);
    }
  });

  it("paints nothing off the view, whatever the camera — and nothing at all when its band is off screen, or over the city", () => {
    for (const z of [0.25, 0.5625, 1, 2, 3])
      for (const dx of [-5000, -333, 1601, 3000, 9000]) {
        const { cam, view } = camAt(reference, dx, z);
        const s = scene(reference, dusk, cam, view, 4321);
        CANYON.paint(s);
        expect(s.ctx.calls.length).toBeGreaterThan(0);
        for (const c of s.ctx.calls) {
          // A fill, or a raster blitted: [x, y, w, h] on screen.
          const [x, y, w, hh] = (c.op === "drawImage" ? c.args.slice(5) : c.args) as number[];
          expect(["fillRect", "drawImage"]).toContain(c.op);
          expect(x < view.w && y < view.h && x + w > 0 && y + hh > 0, JSON.stringify([c.op, x, y, w, hh])).toBe(true);
        }
      }
    const h = horizonOf(reference);
    // The view's bottom just over the canyon's lower roofs: only its tallest reach into it.
    for (const z of [1, 2]) {
      const s = scene(reference, noon, { zoom: z, ox: -1500 * z, oy: 400 - (h - 200) * z }, { w: 1024, h: 400 });
      CANYON.paint(s);
      for (const c of s.ctx.calls) {
        const [x, y, w, hh] = (c.op === "drawImage" ? c.args.slice(5) : c.args) as number[];
        expect(x < 1024 && y < 400 && x + w > 0 && y + hh > 0, JSON.stringify([c.op, x, y, w, hh])).toBe(true);
      }
    }
    // Zoomed onto gazelle's top floors (the band below the view), and onto the lounge (above it): the
    // canyon is not even looked at — a world it has never laid out stays untouched.
    for (const oy of [-(h - 300) * 2 + 2000, -(h + 100) * 2]) {
      const untouched = new Proxy(referenceCity(), {
        get: () => {
          throw new Error("the canyon was walked off screen");
        },
      });
      const s = { ...scene(reference, noon, { zoom: 2, ox: 0, oy }, { w: 800, h: 600 }), world: untouched };
      CANYON.paint(s);
      CANYON.paintLights({ ...lightScene(reference, night, { zoom: 2, ox: 0, oy }, { w: 800, h: 600 }), world: untouched });
      expect(s.ctx.calls).toEqual([]);
    }
    // Over the city — a cluster of its quiet span — nothing is painted at all, not even a screen.
    const [g0, g1] = groundOf(0);
    expect(g0 >= citySpan(reference)![0] && g1 <= citySpan(reference)![1]).toBe(true);
    const behind = scene(reference, noon, camOn(reference, 0).cam, camOn(reference, 0).view, 0);
    CANYON.paint(behind);
    expect(behind.ctx.calls).toEqual([]);
  });

  it("is world-locked: a pan or a zoom shows the same buildings on the same world pixels", () => {
    const at = (z: number, x0: number) => {
      const { cam, view } = camAt(reference, x0, z, 260 * z + 40);
      const s = scene(reference, noon, cam, view, 0);
      CANYON.paint(s);
      const ox = Math.round(cam.ox);
      const oy = Math.round(cam.oy);
      // Back to world px (whole zooms: exact), those whole inside [1500, 1800).
      return new Set(
        painting(s.ctx)
          .map((f) => ({ ...f, x: (f.x - ox) / z, y: (f.y - oy) / z, w: f.w / z, h: f.h / z }))
          .filter((f) => f.x >= 1500 && f.x + f.w <= 1800)
          .map((f) => `${f.color} ${f.x} ${f.y} ${f.w} ${f.h}`),
      );
    };
    const base = at(1, 1400);
    expect(base.size).toBeGreaterThan(150);
    expect(at(1, 1437)).toEqual(base);
    expect(at(2, 1490)).toEqual(base);
    expect(at(3, 1499)).toEqual(base);
  });

  it("is deterministic: the same frame of the same city paints the same calls, time and again", () => {
    const run = () => {
      const { cam, view } = camAt(reference, 1200, 1);
      const s = scene(referenceCity(), noon, cam, view, 98_765);
      CANYON.paint(s);
      return painting(s.ctx);
    };
    expect(run()).toEqual(run());
  });

  it("at a whole zoom blits each cluster's day raster — painted once, the very rects it would paint one by one; below 1 (or with no canvas) paints the rects", () => {
    const world = referenceCity();
    const at = (z: number, w = world) => {
      const { cam, view } = camOn(w, 9, 12, z);
      const s = scene(w, noon, cam, view, 0);
      CANYON.paint(s);
      return s;
    };
    const blitted = at(1);
    // Clusters 9 to 12, a raster each (each has ground for buildings out here).
    for (let a = 9; a <= 12; a++) expect(groundOf(a)[1] - groundOf(a)[0]).toBeGreaterThanOrEqual(48);
    expect(blitted.ctx.of("drawImage").length).toBe(4);
    const made = FakeRaster.made.length;
    expect(made).toBe(4);
    const again = at(2);
    expect(FakeRaster.made.length).toBe(made);
    // The rasters hold the fine art, not its coarse stand-ins: a raster's rects are the rect pass's own.
    const asRects = (s: Recorded) =>
      new Set(
        painting(s.ctx)
          .filter((f) => f.x < s.view.w && f.y < s.view.h && f.x + f.w > 0 && f.y + f.h > 0)
          .map((f) => `${f.color} ${f.x} ${f.y} ${f.w} ${f.h}`),
      );
    noCanvas();
    const bare = referenceCity();
    const one = at(1, bare);
    expect(one.ctx.of("drawImage")).toEqual([]);
    expect(asRects(blitted)).toEqual(asRects(one));
    expect(asRects(again)).toEqual(asRects(at(2, bare)));
    // Below 1, rects (snapped, the coarse art) even where a canvas is to be had.
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.stubGlobal("OffscreenCanvas", FakeRaster);
    expect(at(0.5).ctx.of("drawImage")).toEqual([]);
  });

  it("draws fine detail only from PANE_ZOOM up: a signboard's word in glyphs at zoom 1, a bar of ink at ½ — and its blade's the same", () => {
    const h = horizonOf(reference);
    const signs = canyonSigns(reference, noon, h, 1500, 2100);
    const board = signs.find((g) => !g.vertical) as CanyonSign;
    const blade = signs.find((g) => g.vertical && g.box[2] === bladeWidth(1)) as CanyonSign;
    const inks = new Set([...CANYON_ART.plastics.map((p) => p.ink), ...CANYON_ART.tubes.map((t) => t.day)]);
    const at = (z: number) => {
      const { cam, view } = camAt(reference, 1450, z);
      const s = scene(reference, noon, cam, view);
      CANYON.paint(s);
      const has = (wx: number, wy: number, w: number, hh: number) =>
        painting(s.ctx).some((f) => inks.has(f.color) && f.x === sx(cam, wx) && f.y === sy(cam, wy) && f.w === Math.max(1, sx(cam, wx + w) - sx(cam, wx)) && f.h === Math.max(1, sy(cam, wy + hh) - sy(cam, wy)));
      const t = kanaText(board.text, false);
      const tx = board.box[0] + Math.floor((board.box[2] - t.w) / 2);
      const runs = t.runs.every(([dx, dy, w, hh]) => has(tx + dx, board.box[1] + 2 + dy, w, hh));
      const bar = has(tx, board.box[1] + 4, t.w, KANA_H - 4);
      const v = kanaText(blade.text, true);
      const bladeRuns = v.runs.every(([dx, dy, w, hh]) => has(blade.box[0] + 3 + dx, blade.box[1] + 3 + dy, w, hh));
      const bladeBar = has(blade.box[0] + 3 + Math.floor((KANA_W - 3) / 2), blade.box[1] + 3, 3, v.h);
      return { runs, bar, bladeRuns, bladeBar };
    };
    expect(at(1)).toEqual({ runs: true, bar: false, bladeRuns: true, bladeBar: false });
    expect(at(0.5)).toEqual({ runs: false, bar: true, bladeRuns: false, bladeBar: true });
  });

  it("writes the karaoke box's カラオケ at twice the font's size: every glyph run doubled at zoom 1, a bar as tall as the word below PANE_ZOOM", () => {
    const h = horizonOf(reference);
    const giant = canyonSigns(reference, noon, h, 1300, 2600).find((g) => g.vertical && g.box[2] === bladeWidth(2)) as CanyonSign;
    expect(giant.text).toBe("カラオケ");
    const t = kanaText(giant.text, true);
    const [bx, by] = giant.box;
    const at = (z: number) => {
      const { cam, view } = camAt(reference, bx - 200, z);
      const s = scene(reference, noon, cam, view);
      CANYON.paint(s);
      const got = new Set(painting(s.ctx).map((f) => `${f.x} ${f.y} ${f.w} ${f.h}`));
      const has = (wx: number, wy: number, w: number, hh: number) => got.has(`${sx(cam, wx)} ${sy(cam, wy)} ${Math.max(1, sx(cam, wx + w) - sx(cam, wx))} ${Math.max(1, sy(cam, wy + hh) - sy(cam, wy))}`);
      return {
        runs: t.runs.every(([dx, dy, w, hh]) => has(bx + 3 + 2 * dx, by + 3 + 2 * dy, 2 * w, 2 * hh)),
        bar: has(bx + 3 + Math.floor((2 * KANA_W - 6) / 2), by + 3, 6, 2 * t.h),
      };
    };
    expect(at(1)).toEqual({ runs: true, bar: false });
    expect(at(0.5)).toEqual({ runs: false, bar: true });
  });

  it("wears pictograms our own, each a few merged runs inside a signboard", () => {
    expect(PICTO_RUNS.length).toBe(7);
    for (const runs of PICTO_RUNS) {
      expect(runs.length).toBeGreaterThan(2);
      expect(runs.length).toBeLessThan(12);
      for (const [x, y, w, h] of runs) {
        expect(x + w).toBeLessThanOrEqual(9);
        expect(y + h).toBeLessThanOrEqual(7);
      }
    }
    // A stem merges down: the mic's stand is one tall run.
    expect(PICTO_RUNS[2]).toContainEqual([4, 4, 1, 2]);
    expect(PANEL_H).toBe(KANA_H + 4);
  });
});

// ───────────────────────────── the screens ─────────────────────────────

describe("the video screens", () => {
  const h = horizonOf(reference);
  const screens = canyonLayout(reference, noon, h, 2400, 2400 + 80 * AIR_CHUNK).screens;

  it("stand on one cluster in four or so (never two on one), and play a scene per SCENE_MS — bars, a sunrise, a wipe, a word twice the font's size, rings — all inside the screen, deterministic", () => {
    // Rare: one cluster in four at most, never two in one.
    expect(screens.length).toBeGreaterThanOrEqual(4);
    expect(screens.length).toBeLessThanOrEqual(80 / 3);
    for (let a = -30; a < 30; a++) expect(canyonLayout(reference, noon, h, ...clusterOf(a)).screens.length).toBeLessThanOrEqual(1);
    // Each big enough for a word twice the font's size: two storeys tall, on a building 64 px wide or more.
    for (const sc of canyonLayout(reference, noon, h, -30000, 30000).screens) {
      expect(sc.box[2]).toBeGreaterThanOrEqual(40);
      expect(sc.box[3]).toBe(2 * STOREY - 7);
    }
    const shapes = new Set<string>();
    for (const sc of screens.slice(0, 2))
      for (let n = 0; n < 60; n++)
        for (const f of [0.1, 0.5, 0.9]) {
          const t = (n + f) * SCENE_MS;
          const rects = screenScene(sc, t);
          expect(screenScene(sc, t)).toEqual(rects);
          expect(rects.length).toBeGreaterThan(0);
          const [x, y, w, hh] = sc.box;
          for (const [color, rx, ry, rw, rh] of rects) {
            expect([...CANYON_ART.screen, "#ffffff"]).toContain(color);
            expect(rx >= x && ry >= y && rx + rw <= x + w && ry + rh <= y + hh && rw > 0 && rh > 0).toBe(true);
          }
          // The scene's kind, by its rects' shape.
          if (rects.length === 5 && rects.every((r) => r[2] === y && r[4] === hh)) shapes.add("bars");
          else if (rects.some((r) => r[0] === "#ffffff")) shapes.add("sun");
          else if (rects.every((r, j) => r[1] === x + 3 * j && r[2] === y + 3 * j && r[3] === w - 6 * j && r[4] === hh - 6 * j)) shapes.add(rects.length > 1 ? "rings" : "a field");
          else if (rects.length === 2 && rects[1][1] === x && rects[1][4] === hh) shapes.add("wipe");
          else shapes.add("word");
        }
    expect([...shapes].sort()).toEqual(["bars", "rings", "sun", "wipe", "word"]);
  });

  it("changes its picture over a scene, and from scene to scene", () => {
    const sc = screens[0];
    const frames = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(screenScene(sc, i * 400))));
    expect(frames.size).toBeGreaterThan(10);
  });

  it("is painted per frame in the day pass, the same screen at the same time", () => {
    const sc = screens[0];
    const { cam, view } = camAt(reference, sc.box[0] - 100, 1);
    const paintAt = (t: number) => {
      const s = scene(reference, noon, cam, view, t);
      CANYON.paint(s);
      return painting(s.ctx).filter((f) => f.x >= sx(cam, sc.box[0]) && f.x < sx(cam, sc.box[0] + sc.box[2]) && f.y >= sy(cam, sc.box[1]) && f.y < sy(cam, sc.box[1] + sc.box[3]));
    };
    const a = paintAt(0);
    for (const [color, x, y, w, hh] of screenScene(sc, 0)) expect(a).toContainEqual({ x: sx(cam, x), y: sy(cam, y), w, h: hh, color });
    expect(paintAt(3 * SCENE_MS)).not.toEqual(a);
  });
});

// ───────────────────────────── the night ─────────────────────────────

/** The fills of a light scene through a pattern (the rasters), and their pattern. */
const patternFills = (lights: Lit[]) => lights.filter((l) => typeof l.style === "object");

/** World x a view may start at to show a video screen past the reference city (and plenty else). */
const SCREEN_X = canyonLayout(reference, noon, horizonOf(reference), 1300, 4000).screens[0].box[0] - 300;

/** Is cluster `a`'s ground wide enough for a building? (Else it is all sky, and lit nothing.) */
const built = (a: number): boolean => groundOf(a)[1] - groundOf(a)[0] >= 48;

/** A built cluster's light raster at night (lit share `lit`), as world-px rect strings "colour x y w h", and the pattern. */
function rasterOf(world: World, a: number, lit = 1): { pattern: FakePattern; rects: string[]; boxes: [string, number, number, number, number][]; cam: Camera } {
  const { cam, view } = camOn(world, a);
  const s = lightScene(world, night, cam, view, 0, lit);
  CANYON.paintLights(s);
  const pattern = patternFills(s.lights)[0].style as FakePattern;
  const tr = pattern.transform as DOMMatrix2DInit;
  const [ox, oy] = [tr.e! - Math.round(cam.ox), tr.f! - Math.round(cam.oy)];
  const boxes = fills(pattern.raster.ctx).map((f): [string, number, number, number, number] => [f.color, f.x + ox, f.y + oy, f.w, f.h]);
  return { pattern, rects: boxes.map((b) => b.join(" ")), boxes, cam };
}

describe("the night pass", () => {
  it("lights nothing by day: at noon, on a fair afternoon, and on a fair morning", () => {
    for (const amb of [noon, sky("afternoon"), sky("morning")]) {
      expect(neonStrength(amb)).toBe(0);
      const { cam, view } = camAt(reference, 1300);
      const s = lightScene(reference, amb, cam, view);
      CANYON.paintLights(s);
      expect(s.lights).toEqual([]);
      expect(s.ctx.calls).toEqual([]);
    }
    expect(FakeRaster.made).toEqual([]);
  });

  it("at night lights every light through fillLit — never a fill of its own — at neonStrength, the rasters as patterns mapped world → screen", () => {
    for (const amb of [night, dusk, sky("night", "rain"), sky("noon", "storm")]) {
      const k = neonStrength(amb);
      expect(k).toBeGreaterThan(0);
      for (const z of [1, 2]) {
        const { cam, view } = camAt(reference, SCREEN_X, z);
        const s = lightScene(reference, amb, cam, view, 1234);
        CANYON.paintLights(s);
        expect(s.ctx.of("fillRect")).toEqual([]);
        expect(s.lights.length).toBeGreaterThan(0);
        // The rasters at neonStrength; the screens under the neon, well under it.
        expect(SCREEN_GLOW).toBeLessThanOrEqual(0.6);
        for (const l of s.lights) expect(l.alpha).toBe(typeof l.style === "string" ? k * SCREEN_GLOW : k);
        const fromRasters = patternFills(s.lights);
        expect(fromRasters.length).toBeGreaterThan(0);
        for (const l of fromRasters) {
          const t = (l.style as FakePattern).transform as DOMMatrix2DInit;
          expect(t.a).toBe(z);
          expect(t.d).toBe(z);
          expect(t.b).toBe(0);
          expect(t.c).toBe(0);
          // The raster's origin, back in world px, is on the world grid.
          expect(Number.isInteger((t.e! - Math.round(cam.ox)) / z)).toBe(true);
        }
        // The screens' scenes are lit rect by rect, in their colours.
        expect(s.lights.some((l) => typeof l.style === "string" && CANYON_ART.screen.includes(l.style))).toBe(true);
        expect(s.ctx.globalAlpha).toBe(1);
      }
    }
  });

  it("lights nothing off the view, whatever the camera", () => {
    for (const z of [0.25, 0.5625, 1, 3])
      for (const dx of [-4000, 1220, 1601]) {
        const { cam, view } = camAt(reference, dx, z);
        const s = lightScene(reference, night, cam, view, 777);
        CANYON.paintLights(s);
        expect(s.lights.length).toBeGreaterThan(0);
        const [x0, x1] = spanOf(cam, view);
        const top = -Math.round(cam.oy) / z;
        const bottom = (view.h - Math.round(cam.oy)) / z;
        for (const l of s.lights) expect(l.x + l.w > x0 && l.x < x1 && l.y + l.h > top && l.y < bottom, JSON.stringify(l)).toBe(true);
        for (const l of patternFills(s.lights)) expect(l.x >= Math.floor(x0) && l.x + l.w <= Math.ceil(x1) && l.y >= Math.floor(top) && l.y + l.h <= Math.ceil(bottom), JSON.stringify(l)).toBe(true);
      }
    // A view of a thin band of sky over the roofs: what stands under it lights nothing, never a fill of no size.
    const h = horizonOf(reference);
    const thin = lightScene(reference, night, { zoom: 1, ox: 1250, oy: 190 - h }, { w: 4000, h: 12 });
    CANYON.paintLights(thin);
    for (const l of thin.lights) expect(l.w > 0 && l.h > 0, JSON.stringify({ ...l, style: 0 })).toBe(true);
    // …and nothing at all when its band is off screen.
    const s = lightScene(reference, night, { zoom: 2, ox: 0, oy: 2000 }, { w: 800, h: 600 });
    CANYON.paintLights(s);
    expect(s.lights).toEqual([]);
  });

  it("never lights inside a temple's box — a pagoda standing out in the open street, in front of the canyon — and lights the rest of it", () => {
    // The HQ and a one-floor project: its pagoda stands past the city's left wall, in front of a cluster.
    const world = city([1]);
    const wh = horizonOf(world);
    const temples = placeLandmarks(world, wh, landmarksFor("Asia/Tokyo"))
      .placed.filter((p) => p.spec.layer === "near")
      .map((p) => [p.x - p.hw, wh - p.h - 2, 2 * p.hw + 1, p.h + 2]);
    const [px, , pw] = temples[0];
    const ahead = canyonLayout(world, night, wh, px, px + pw).buildings;
    expect(ahead.length).toBeGreaterThan(0);
    const { cam, view } = camAt(world, px - 200, 1);
    const s = lightScene(world, night, cam, view, 0);
    CANYON.paintLights(s);
    const lit = patternFills(s.lights);
    expect(lit.length).toBeGreaterThan(0);
    for (const [x, y, w, hh] of temples) for (const l of lit) expect(l.x < x + w && x < l.x + l.w && l.y < y + hh && y < l.y + l.h, JSON.stringify(l)).toBe(false);
    // Lit right up to the pagoda's side: a fill ends at its box's left edge.
    expect(lit.some((l) => l.x + l.w === px)).toBe(true);
  });

  it("lets a neon blade's letter stutter out now and then: that glyph's cell alone goes dark — each of a blade's plates on its own", () => {
    const h = horizonOf(reference);
    // Whole clusters past the city's right end: no blade straddles the view's edges.
    const { cam, view } = camOn(reference, 8, 11);
    const [x0, x1] = spanOf(cam, view);
    // The glyph cells of every plate in view, from its sign.
    const plates = canyonSigns(reference, night, h, x0, x1).filter((g) => g.vertical);
    const cells: [number, number, number, number][] = [];
    const plateOf = new Map<[number, number, number, number], CanyonSign>();
    for (const g of plates) {
      const [bx, by, bw] = g.box;
      const k = (bw - 6) / KANA_W;
      for (let j = 0; j < [...g.text].length; j++) {
        const cell: [number, number, number, number] = [bx + 3, by + 3 + k * j * (KANA_H + 1), k * KANA_W, k * KANA_H];
        cells.push(cell);
        plateOf.set(cell, g);
      }
    }
    const lower = new Set(bladesOf(plates).flatMap((p) => p.slice(1)));
    let lowerStutters = 0;
    let both = 0;
    const covered = (lit: Lit[], x: number, y: number) => lit.some((l) => x >= l.x && x < l.x + l.w && y >= l.y && y < l.y + l.h);
    let stutters = 0;
    for (let t = 0; t < 60_000; t += 75) {
      const s = lightScene(reference, night, cam, view, t);
      CANYON.paintLights(s);
      const lit = patternFills(s.lights);
      const dark = cells.filter(([x, y, w, hh]) => !covered(lit, x + (w >> 1), y + (hh >> 1)));
      // A plate stutters a glyph at a time; the two plates of a blade each on their own.
      const darkPlates = dark.map((c) => plateOf.get(c) as CanyonSign);
      expect(new Set(darkPlates).size).toBe(dark.length);
      lowerStutters += darkPlates.filter((g) => lower.has(g)).length;
      if (bladesOf(darkPlates).some((p) => p.length === 2)) both++;
      for (const [x, y, w, hh] of dark) {
        stutters++;
        // Its own pixels all dark, the pixels round it all lit (another cell of the blade, or its glass).
        for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) expect(covered(lit, xx, yy)).toBe(false);
        for (const [xx, yy] of [
          [x - 1, y],
          [x + w, y],
          [x, y - 1],
          [x, y + hh],
        ])
          expect(covered(lit, xx, yy), `around the cell at (${x}, ${y}), t ${t}`).toBe(true);
      }
      expect(dark.length).toBeLessThanOrEqual(3);
      // Nothing else of the cluster's light goes dark: per raster, its fills cover their bounding box but the dark cells.
      const groups = new Map<unknown, Lit[]>();
      for (const l of lit) groups.set(l.style, [...(groups.get(l.style) ?? []), l]);
      for (const g of groups.values()) {
        const gx0 = Math.min(...g.map((l) => l.x));
        const gy0 = Math.min(...g.map((l) => l.y));
        const gx1 = Math.max(...g.map((l) => l.x + l.w));
        const gy1 = Math.max(...g.map((l) => l.y + l.h));
        const hole = (gx1 - gx0) * (gy1 - gy0) - g.reduce((sum, l) => sum + l.w * l.h, 0);
        const inside = dark.filter(([x, y, w, hh]) => x >= gx0 && y >= gy0 && x + w <= gx1 && y + hh <= gy1);
        expect(hole, `t ${t}`).toBe(inside.reduce((sum, [, , w, hh]) => sum + w * hh, 0));
      }
    }
    // Now and then — not never, not often (≈ 1 frame in 80 a neon plate); a lower plate too, on its own
    // (never with its upper one here).
    expect(stutters).toBeGreaterThan(0);
    expect(stutters).toBeLessThan(0.03 * 800 * plates.length);
    expect(lowerStutters).toBeGreaterThan(0);
    expect(lowerStutters).toBeLessThan(stutters);
    expect(both).toBe(0);
  });

  it("holds its lights in a raster per cluster, painted once and again only when the windows' lit share steps — and the lit windows only grow", () => {
    const world = referenceCity();
    const { cam, view } = camOn(world, 10);
    const at = (lit: number) => {
      const s = lightScene(world, night, cam, view, 0, lit);
      CANYON.paintLights(s);
      return patternFills(s.lights)[0].style as FakePattern;
    };
    const a = at(0.1);
    expect(FakeRaster.made.length).toBe(1);
    expect(at(0.1 + 0.2 / 32 / 2)).toBe(a);
    expect(FakeRaster.made.length).toBe(1);
    const b = at(0.4);
    expect(FakeRaster.made.length).toBe(2);
    const windowsOf = (p: FakePattern) =>
      new Set(
        fills(p.raster.ctx)
          .filter((f) => CANYON_ART.windows.includes(f.color))
          .map((f) => `${f.x} ${f.y} ${f.w} ${f.h} ${f.color}`),
      );
    // The signboards' plastic lit from behind, and their ink lit over it.
    const lit = fills(b.raster.ctx);
    expect(lit.some((f) => f.h === PANEL_H && CANYON_ART.plastics.some((p) => p.lit === f.color))).toBe(true);
    expect(lit.some((f) => CANYON_ART.plastics.some((p) => p.inkLit === f.color))).toBe(true);
    const few = windowsOf(a);
    const more = windowsOf(b);
    expect(few.size).toBeGreaterThan(0);
    expect(more.size).toBeGreaterThan(few.size);
    for (const w of few) expect(more.has(w)).toBe(true);
    // No windows lit at all before the first step.
    expect(windowsOf(at(0.01)).size).toBe(0);
    // A raster's size is its cluster's lights' box: within the cluster (and a halo), not past the street.
    const [c0, c1] = clusterOf(10);
    for (const r of FakeRaster.made) {
      expect(r.width).toBeLessThanOrEqual(c1 - c0 + 2 * 9);
      expect(r.height).toBeLessThan(FLOORS_MAX * STOREY + 3 + 2 * STOREY);
    }
  });

  it("lights single windows — never a band: a few px each, apart, dim warm or now and then cool; ≈ 20–35 % at full night, none before the City lights any, and the vacant flats never", () => {
    const world = referenceCity();
    const h2 = horizonOf(world);
    const share = citySky(night).lit;
    let panes = 0;
    let litNight = 0;
    let litAll = 0;
    let bays = 0;
    for (let a = 8; a < 30; a++) {
      if (!built(a)) continue;
      const glass = new Set(CANYON_ART.facades.map((t) => t.glass));
      const { cam, view } = camOn(world, a);
      const day = scene(world, noon, cam, view);
      CANYON.paint(day);
      panes += painting(day.ctx).filter((f) => glass.has(f.color)).length;
      const win = (lit: number) =>
        rasterOf(world, a, lit)
          .boxes.filter(([color]) => CANYON_ART.windows.includes(color))
          .map(([, ...nums]) => nums);
      const all = win(1);
      const { buildings } = canyonLayout(world, night, h2, ...clusterOf(a));
      for (const [x, y, w, hh] of all) {
        // A window, not a band: at most 6 px wide (a shop bay), never touching the next one.
        expect(w).toBeLessThanOrEqual(6);
        expect(all.some(([x2, y2, w2]) => y2 === y && (x2 === x + w || x2 + w2 === x))).toBe(false);
        expect(y + hh).toBeLessThanOrEqual(h2);
        if (w < 6) continue;
        // A shop's bay, inside its building's shop glass.
        bays++;
        expect(y).toBe(h2 - STOREY + 9);
        expect(buildings.some((b) => x >= b.x + 3 && x + w <= b.x + b.w - 3)).toBe(true);
      }
      litAll += all.length - all.filter(([, , w]) => w === 6).length;
      litNight += win(share).length;
      // Before the City lights its windows, none of the canyon's.
      expect(win(0)).toEqual([]);
    }
    // Lit tonight: about a quarter of them; even at the most, the vacant flats (two in five) stay dark.
    expect(litNight / panes).toBeGreaterThan(0.2);
    expect(litNight / panes).toBeLessThan(0.35);
    expect(litAll / panes).toBeLessThan(0.65);
    expect(bays).toBeGreaterThan(10);
    // Mostly the dim warm.
    expect(CANYON_ART.windows.filter((c) => c === "#e6cf98").length / CANYON_ART.windows.length).toBeGreaterThanOrEqual(0.75);
  });

  it("throws a halo only round its featured blades and the karaoke box, at alpha 0.15 at most — none round a signboard", () => {
    const world = referenceCity();
    const h2 = horizonOf(world);
    let halos = 0;
    let giants = 0;
    let lamps = 0;
    for (let a = 8; a < 20; a++) {
      if (!built(a)) continue;
      const rects = rasterOf(world, a).boxes;
      const plates = canyonSigns(world, night, h2, ...clusterOf(a)).filter((g) => g.vertical);
      for (const [color, x, y, w, hh] of rects) {
        const alpha = color.startsWith("rgba") ? Number(color.slice(color.lastIndexOf(",") + 1, -1)) : 1;
        if (color === CANYON_ART.veil || alpha === 1 || alpha === 0.5) continue;
        // A halo: soft, and round one of the plates — 3 px all round it, the giant's 6.
        expect(alpha).toBeLessThanOrEqual(0.15);
        const g = plates.find((q) => x < q.box[0] && y < q.box[1] && x + w > q.box[0] + q.box[2] && y + hh > q.box[1] + q.box[3]);
        expect(g, `${color} at (${x}, ${y})`).toBeDefined();
        const r = (3 * (g!.box[2] - 6)) / KANA_W;
        expect([x, y, w, hh]).toEqual([g!.box[0] - r, g!.box[1] - r, g!.box[2] + 2 * r, g!.box[3] + 2 * r]);
        giants += r === 6 ? 1 : 0;
        halos++;
      }
      // The billboards half lit by their lamps: never a solid light in a billboard's colours.
      const board = new Set(CANYON_ART.billboard);
      lamps += rects.filter(([color]) => color.endsWith(", 0.5)")).length;
      expect(rects.filter(([color]) => board.has(color))).toEqual([]);
      // One halo a plate, no more.
      expect(rects.filter(([color]) => color.startsWith("rgba") && color !== CANYON_ART.veil && !color.endsWith(", 0.5)")).length).toBe(plates.length);
    }
    expect(halos).toBeGreaterThan(10);
    expect(giants).toBeGreaterThan(0);
    expect(lamps).toBeGreaterThan(0);
  });

  it("lights no plate's gap: the bare wall between a blade's two plates takes only the veil and the halos — no tube, no plastic, no letter", () => {
    const world = referenceCity();
    const h = horizonOf(world);
    let gaps = 0;
    for (let a = 8; a < 18; a++) {
      if (!built(a)) continue;
      const solid = rasterOf(world, a).boxes.filter(([color]) => color.startsWith("#"));
      const [c0, c1] = clusterOf(a);
      for (const [p] of bladesOf(canyonSigns(world, night, h, c0, c1)).filter((q) => q.length === 2)) {
        const [x, y, w, ph] = p.box;
        gaps++;
        for (const [color, fx, fy, fw, fh] of solid) expect(fx < x + w && x < fx + fw && fy < y + ph + PLATE_GAP && y + ph < fy + fh, `${color} in the gap under ${p.text}`).toBe(false);
      }
    }
    expect(gaps).toBeGreaterThan(4);
  });

  it("veils every facade at night (they sink back behind their signs), lights every plastic blade's plate from behind in its own plastic — and the karaoke box's カラオケ in pink neon", () => {
    const world = referenceCity();
    const h = horizonOf(world);
    let boxes = 0;
    let karaoke = 0;
    for (let a = 8; a < 30; a++) {
      if (!built(a)) continue;
      const { rects, cam } = rasterOf(world, a);
      const lit = new Set(rects);
      const [c0, c1] = clusterOf(a);
      for (const b of canyonLayout(world, night, h, c0, c1).buildings) expect(lit.has(`${CANYON_ART.veil} ${b.x} ${b.top} ${b.w} ${h - b.top}`)).toBe(true);
      // A plastic blade's plate: its plastic lit over the whole plate (a neon one's glass stays dark).
      const day = scene(world, noon, cam, camOn(world, a).view);
      CANYON.paint(day);
      const painted = painting(day.ctx);
      for (const g of canyonSigns(world, night, h, c0, c1).filter((q) => q.vertical)) {
        const [x, y, w, ph] = g.box;
        if (w === bladeWidth(2)) {
          // The karaoke box: its glyphs, twice the font's size, in pink tubes in a violet frame.
          karaoke++;
          for (const [dx, dy, rw, rh] of kanaText(g.text, true).runs) expect(lit.has(`${CANYON_ART.karaoke.tube.lit} ${x + 3 + 2 * dx} ${y + 3 + 2 * dy} ${2 * rw} ${2 * rh}`)).toBe(true);
          expect(lit.has(`${CANYON_ART.karaoke.frame.lit} ${x + 1} ${y + 1} ${w - 2} 1`)).toBe(true);
          continue;
        }
        const plastic = CANYON_ART.plastics.find((q) => painted.some((f) => f.color === q.day && f.x === sx(cam, x) && f.y === sy(cam, y) && f.w === w && f.h === ph));
        if (!plastic) continue;
        boxes++;
        expect(lit.has(`${plastic.lit} ${x} ${y} ${w} ${ph}`), `${g.text} lit in ${plastic.lit}`).toBe(true);
      }
    }
    expect(boxes).toBeGreaterThan(3);
    expect(karaoke).toBeGreaterThan(3);
  });

  it("lights the coarse art below PANE_ZOOM: a signboard's word is a bar of light, not glyphs", () => {
    const world = referenceCity();
    const h = horizonOf(world);
    // A cluster with a word on a signboard, its tenant open (its plate lit).
    let a = 8;
    const litBoard = (c: number) =>
      canyonSigns(world, night, h, ...clusterOf(c)).find((g) => !g.vertical && rasterOf(world, c).boxes.some(([color, x, y, w, hh]) => CANYON_ART.plastics.some((q) => q.lit === color) && x === g.box[0] && y === g.box[1] && w === g.box[2] && hh === PANEL_H));
    while (!litBoard(a)) a++;
    const board = litBoard(a) as CanyonSign;
    const t = kanaText(board.text, false);
    const tx = board.box[0] + Math.floor((board.box[2] - t.w) / 2);
    // The raster's origin in world px (the same box fine or coarse), read exactly at zoom 1.
    const [ox, oy] = (() => {
      const { cam, view } = camOn(world, a);
      const s = lightScene(world, night, cam, view, 0);
      CANYON.paintLights(s);
      const tr = (patternFills(s.lights)[0].style as FakePattern).transform as DOMMatrix2DInit;
      return [tr.e! - Math.round(cam.ox), tr.f! - Math.round(cam.oy)];
    })();
    const rasterAt = (z: number) => {
      const { cam, view } = camOn(world, a, a, z);
      const s = lightScene(world, night, cam, view, 0);
      CANYON.paintLights(s);
      const p = patternFills(s.lights)[0].style as FakePattern;
      const rects = fills(p.raster.ctx).map((f) => `${f.x + ox} ${f.y + oy} ${f.w} ${f.h}`);
      return {
        glyphs: t.runs.every(([dx, dy, w, hh]) => rects.includes(`${tx + dx} ${board.box[1] + 2 + dy} ${w} ${hh}`)),
        bar: rects.includes(`${tx} ${board.box[1] + 4} ${t.w} ${KANA_H - 4}`),
      };
    };
    expect(rasterAt(1)).toEqual({ glyphs: true, bar: false });
    expect(rasterAt(0.5)).toEqual({ glyphs: false, bar: true });
  });

  it("keeps at most MAX_RASTERS rasters: lighting a cluster again after many others paints it again, a recent one does not", () => {
    const world = referenceCity();
    const light = (a: number) => {
      const { cam, view } = camOn(world, a);
      CANYON.paintLights(lightScene(world, night, cam, view, 0));
    };
    // The built clusters from 10 on (one all sky holds no raster).
    const lit: number[] = [];
    for (let a = 10; lit.length < MAX_RASTERS + 1; a++) if (built(a)) lit.push(a);
    for (const a of lit.slice(0, MAX_RASTERS)) light(a);
    expect(FakeRaster.made.length).toBe(MAX_RASTERS);
    // Lit again, the first is the most recent: the next new cluster's raster costs the second its, not it.
    light(lit[0]);
    expect(FakeRaster.made.length).toBe(MAX_RASTERS);
    light(lit[MAX_RASTERS]);
    expect(FakeRaster.made.length).toBe(MAX_RASTERS + 1);
    light(lit[0]);
    expect(FakeRaster.made.length).toBe(MAX_RASTERS + 1);
    light(lit[1]);
    expect(FakeRaster.made.length).toBe(MAX_RASTERS + 2);
    // Its fine and coarse rasters are kept apart (a zoom across PANE_ZOOM paints the other).
    const { cam, view } = camOn(world, lit[0], lit[0], 0.5);
    CANYON.paintLights(lightScene(world, night, cam, view, 0));
    expect(FakeRaster.made.length).toBeGreaterThan(MAX_RASTERS + 2);
  });

  it("keeps a raster for every cluster of a view showing more than MAX_RASTERS of them — a frame never paints them all again", () => {
    const world = referenceCity();
    const cam = { zoom: 1 / 8, ox: 0, oy: 600 - 20 - horizonOf(world) / 8 };
    const view = { w: 1800, h: 600 };
    expect(view.w / cam.zoom / AIR_CHUNK).toBeGreaterThan(MAX_RASTERS);
    CANYON.paintLights(lightScene(world, night, cam, view, 0));
    const made = FakeRaster.made.length;
    expect(made).toBeGreaterThan(MAX_RASTERS);
    CANYON.paintLights(lightScene(world, night, cam, view, 100));
    expect(FakeRaster.made.length).toBe(made);
  });

  it("lights each stretch of a cluster's ground on its own — both, where the city's span splits one — and nothing between them, nothing twice", () => {
    let split = 0;
    // No real city is narrow enough to split a cluster's ground (the HQ alone is too wide): one of a lone
    // two-tile building is, wherever it stands.
    for (let col = 0; col < 40; col += 3) {
      const city = reference.city!;
      const world: World = { ...reference, city: { ...city, buildings: [{ ...city.buildings[0], col, w: 2 }] } };
      for (let a = -1; a < 3; a++) {
        const ground = stretchesOf(world, a);
        if (ground.length !== 2) continue;
        split++;
        const { cam, view } = camOn(world, a);
        const s = lightScene(world, night, cam, view, 0, 1);
        CANYON.paintLights(s);
        const lit = patternFills(s.lights);
        for (const [g0, g1] of ground) expect(lit.some((l) => l.x >= g0 && l.x + l.w <= g1)).toBe(true);
        for (const l of lit) expect(ground.some(([g0, g1]) => l.x >= g0 && l.x + l.w <= g1), JSON.stringify({ ...l, style: 0 })).toBe(true);
        // Each pixel lit once (at neonStrength, not twice over): no two fills overlap.
        lit.forEach((p, i) => {
          for (const q of lit.slice(i + 1)) expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, JSON.stringify([p, q].map((l) => ({ ...l, style: 0 })))).toBe(false);
        });
      }
    }
    expect(split).toBeGreaterThan(0);
  });

  it("lights nothing of a cluster the city's quiet span holds", () => {
    const { cam, view } = camOn(reference, 0);
    const s = lightScene(reference, night, cam, view, 0);
    CANYON.paintLights(s);
    expect(s.lights).toEqual([]);
  });

  it("on a host with no 2D canvas (jsdom) lights only the screens", () => {
    noCanvas();
    const world = referenceCity();
    const { cam, view } = camAt(world, SCREEN_X, 1);
    const s = lightScene(world, night, cam, view, 0);
    CANYON.paintLights(s);
    expect(s.lights.length).toBeGreaterThan(0);
    for (const l of s.lights) expect(typeof l.style).toBe("string");
  });

  it("is deterministic: the same night frame lights the same rects", () => {
    const run = () => {
      const { cam, view } = camAt(reference, 1300, 1);
      const s = lightScene(reference, night, cam, view, 5555);
      CANYON.paintLights(s);
      return s.lights.map((l) => ({ ...l, style: typeof l.style === "string" ? l.style : "pattern" }));
    };
    expect(run()).toEqual(run());
  });
});
