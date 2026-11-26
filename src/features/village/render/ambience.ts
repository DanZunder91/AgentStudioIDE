/** The sky, OUTDOORS only: every layer is clipped to the screen less house interiors (even-odd),
 * so rooms stay lit and dry. `paintPuddles` goes right after the ground, `paintAmbience` after the
 * world and before bubbles/labels. Per-frame cost is bounded and allocation-free. */

import {
  TILE,
  type Ambience,
  type CityInfo,
  type VehicleView,
  type WeatherKind,
  type WeatherParticle,
  type World,
} from "../villageTypes";
import { VEIL_COLOR, veilAlpha } from "../engine/ambience";
import { rainSlant } from "../engine/weatherFx";
import type { Box } from "./backdropLights";
import type { Camera } from "./camera";
import { paintCityNight, screenRect } from "./city";
import { hash, onScreen, rect, sx, sy } from "./paint";
import type { DrawTarget } from "./renderTypes";
import { paintNeonLights } from "./neon";
import { vendingGlow, vendingGlowBox } from "./tokyoProps";
import { liftShafts } from "../engine/drawList";
import { kioskGlow, kioskGlowBox, shaftGlow, shaftGlowBox } from "./lift";
import { paintSubwayLights } from "./subway";
import { paintVehicleLights } from "./vehicles";

/** Colours, exported for the tests. */
export const SKY = {
  rain: "#cfe2ff",
  splash: "#d6e6ff",
  snow: "#f7f9ff",
  fog: "#e6eaee",
  veil: VEIL_COLOR,
  flash: "#e4ecff",
  lamp: "rgba(255, 214, 140, 0.13)",
  fire: "rgba(255, 150, 70, 0.14)",
  door: "rgba(255, 200, 120, 0.16)",
  window: "rgba(255, 186, 84, 0.3)",
  puddle: "rgba(38, 52, 78, 0.3)",
  puddleShine: "rgba(190, 215, 255, 0.35)",
  ripple: "#cfe0ff",
} as const;

/** World px of warm light round a lit city floor (its window frame at night). */
const GLOW = 4;

/** Weather that leaves the ground wet. */
export function isWet(kind: WeatherKind): boolean {
  return kind === "drizzle" || kind === "rain" || kind === "storm";
}

/** Screen rects (x, y, w, h) of the house interiors that intersect the view. */
export function interiorRects(
  world: World,
  cam: Camera,
  view: { w: number; h: number },
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const h of world.houses) {
    if (
      !onScreen(cam, view, h.col * TILE, h.row * TILE, h.w * TILE, h.h * TILE)
    )
      continue;
    out.push([
      sx(cam, h.col * TILE),
      sy(cam, h.row * TILE),
      h.w * TILE * cam.zoom,
      h.h * TILE * cam.zoom,
    ]);
  }
  return out;
}

/** The outdoors on screen: the village's rect clipped to the view, so the panel's backdrop is
 * never graded or rained on. No world (cols 0) or a city: the whole view. */
export function outdoorRect(
  world: World,
  cam: Camera,
  view: { w: number; h: number },
): [number, number, number, number] {
  if (world.cols <= 0 || world.city) return [0, 0, view.w, view.h];
  const x0 = Math.max(0, sx(cam, 0));
  const y0 = Math.max(0, sy(cam, 0));
  const x1 = Math.min(view.w, sx(cam, world.cols * TILE));
  const y1 = Math.min(view.h, sy(cam, world.rows * TILE));
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

/** A soft round pool of light centred on world (cx, cy): stacked crossed bands, brightest at the core. */
function glow(
  ctx: DrawTarget,
  cam: Camera,
  cx: number,
  cy: number,
  radii: readonly number[],
  color: string,
): void {
  for (const r of radii) {
    rect(
      ctx,
      cam,
      cx - r,
      cy - Math.round(r * 0.6),
      2 * r,
      Math.round(r * 1.2),
      color,
    );
    rect(
      ctx,
      cam,
      cx - Math.round(r * 0.6),
      cy - r,
      Math.round(r * 1.2),
      2 * r,
      color,
    );
  }
}

/** Night lights: lamp halos (+ a pool on the ground), the campfire, warm spill from every door. */
function lights(
  ctx: DrawTarget,
  amb: Ambience,
  world: World,
  cam: Camera,
  view: { w: number; h: number },
): void {
  for (const p of world.props) {
    const x0 = p.col * TILE;
    const bottom = (p.row + p.h) * TILE;
    if (
      p.kind === "lamp" &&
      onScreen(cam, view, x0 - 24, bottom - 56, 64, 64)
    ) {
      glow(ctx, cam, x0 + 8, bottom - 26, [8, 14, 20], SKY.lamp);
      rect(ctx, cam, x0 - 4, bottom - 3, 24, 5, SKY.lamp);
    } else if (
      p.kind === "campfire" &&
      amb.campfireLit &&
      onScreen(cam, view, x0 - 24, bottom - 40, 64, 56)
    ) {
      glow(ctx, cam, x0 + 8, bottom - 7, [10, 18, 26], SKY.fire);
    } else if (p.kind === "vending" && onScreen(cam, view, ...vendingGlowBox(x0, bottom))) {
      // A Tokyo vending machine's lit display spills onto the street at night.
      vendingGlow(ctx, cam, x0, bottom);
    } else if (p.kind === "lift" && onScreen(cam, view, ...kioskGlowBox(x0, bottom))) {
      // The lounge lift's kiosk: its lit booth spills onto the far sidewalk.
      kioskGlow(ctx, cam, x0, bottom);
    }
  }
  // The city's lift shafts glow where they cross the dark facade (the clip keeps the rooms out).
  for (const s of liftShafts(world)) if (onScreen(cam, view, ...shaftGlowBox(s))) shaftGlow(ctx, cam, s);
  // Every door spills light on the path outside: a house's, or a city building's street door.
  const doors = world.city
    ? world.city.buildings.map((b) => ({ col: b.doorCol, row: b.row + b.h - 1 }))
    : world.houses.map((h) => ({ col: h.doorCol, row: h.doorRow }));
  for (const d of doors) {
    const x = d.col * TILE;
    const y = (d.row + 1) * TILE;
    if (!onScreen(cam, view, x - 4, y - TILE, TILE + 8, TILE + 12)) continue;
    rect(ctx, cam, x + 2, y - TILE + 2, TILE - 4, TILE - 2, SKY.door);
    rect(ctx, cam, x + 3, y, TILE - 6, 4, SKY.door);
    rect(ctx, cam, x + 1, y + 4, TILE - 2, 4, SKY.door);
    rect(ctx, cam, x - 1, y + 8, TILE + 2, 3, SKY.door);
  }
  // A city's lit floors: warm light round each floor's window (the clip keeps the room itself
  // out, so only a frame of glow lands on the facade).
  if (world.city)
    for (const h of world.houses)
      if (onScreen(cam, view, h.col * TILE - GLOW, h.row * TILE - GLOW, h.w * TILE + 2 * GLOW, h.h * TILE + 2 * GLOW))
        rect(ctx, cam, h.col * TILE - GLOW, h.row * TILE - GLOW, h.w * TILE + 2 * GLOW, h.h * TILE + 2 * GLOW, SKY.window);
}

/** A city's stars, moon and far lit windows (golden hour on), clipped to open sky: above the
 * street and outside every building (even-odd). */
function nightSky(
  ctx: DrawTarget,
  amb: Ambience,
  world: World,
  city: CityInfo,
  cam: Camera,
  view: { w: number; h: number },
  timeMs: number,
  street: readonly Box[],
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, view.w, sy(cam, city.street * TILE));
  for (const b of city.buildings) ctx.rect(...screenRect(cam, b.col * TILE, b.row * TILE, b.w * TILE, b.h * TILE));
  ctx.clip("evenodd");
  paintCityNight(ctx, amb, world, cam, view, timeMs, street);
  ctx.restore();
}

/** Drifting translucent bands across the view (screen space, so they read as weather, not terrain). */
function fog(
  ctx: DrawTarget,
  amb: Ambience,
  cam: Camera,
  view: { w: number; h: number },
  t: number,
): void {
  ctx.fillStyle = SKY.fog;
  ctx.globalAlpha = 0.1 + 0.1 * amb.intensity;
  ctx.fillRect(0, 0, view.w, view.h);
  const segW = Math.max(1, Math.round(view.w * 0.7));
  const period = view.w + segW;
  for (let i = 0; i < 3; i++) {
    const h = (12 + 6 * i) * cam.zoom;
    const y = Math.round(
      view.h * (0.18 + 0.3 * i) + Math.sin(t / 4000 + i) * 6 * cam.zoom,
    );
    const speed = 0.006 * cam.zoom * (1 + 0.4 * i) * (amb.wind < 0 ? -1 : 1);
    ctx.globalAlpha = 0.08 + 0.1 * amb.intensity;
    for (let k = 0; k < 2; k++) {
      const raw = t * speed + i * 997 + (k * period) / 2;
      const x = Math.round((((raw % period) + period) % period) - segW);
      ctx.fillRect(x, y, segW, h);
      ctx.fillRect(
        x + Math.round(segW / 6),
        y + Math.round(h / 4),
        Math.round((segW * 2) / 3),
        Math.round(h / 2),
      );
    }
  }
}

/** One pass over the particles: rain streaks (slanted by the wind), splash rings, snow flakes. */
function particles(
  ctx: DrawTarget,
  amb: Ambience,
  list: readonly WeatherParticle[],
  cam: Camera,
  view: { w: number; h: number },
): void {
  // The streak runs from the drop (x, y) up to (x − rainSlant·size, y − size) — the
  // exact geometry WeatherFx aims and filters (and its indoor property test checks).
  const k = -rainSlant(amb.wind);
  for (const p of list) {
    if (
      !onScreen(
        cam,
        view,
        p.x - p.size - 2,
        p.y - p.size - 2,
        2 * p.size + 4,
        2 * p.size + 4,
      )
    )
      continue;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
    if (p.kind === "rain") {
      // ≤ 3 stepped segments, never more than px of length (so none is 0 tall): the
      // top one sits at the full slant, the bottom one exactly at the drop.
      const len = Math.max(1, Math.round(p.size));
      const slant = k * len;
      const segs = Math.min(3, len, 1 + Math.round(Math.abs(slant)));
      for (let i = 0; i < segs; i++) {
        const top = Math.floor((i * len) / segs);
        const bottom = Math.floor(((i + 1) * len) / segs);
        const off = segs === 1 ? 0 : Math.round(slant * (1 - i / (segs - 1)));
        rect(ctx, cam, p.x + off, p.y - len + top, 1, bottom - top, SKY.rain);
      }
    } else if (p.kind === "splash") {
      const r = Math.round(p.size);
      if (r < 1) {
        rect(ctx, cam, p.x, p.y, 1, 1, SKY.splash);
      } else {
        rect(ctx, cam, p.x - r, p.y, 1, 1, SKY.splash);
        rect(ctx, cam, p.x + r, p.y, 1, 1, SKY.splash);
        rect(ctx, cam, p.x - r + 1, p.y - 1, 2 * r - 1, 1, SKY.splash);
      }
    } else {
      const s = p.size < 1.5 ? 1 : 2;
      rect(ctx, cam, p.x, p.y, s, s, SKY.snow);
    }
  }
}

/** Outdoor non-ground layers, after the world, before bubbles and labels. `flash` 0..1 is the
 * lightning; `vehicles` are this frame's City vehicles, whose lamps the night lights switch on. */
export function paintAmbience(
  ctx: DrawTarget,
  amb: Ambience,
  list: readonly WeatherParticle[],
  flash: number,
  world: World,
  cam: Camera,
  view: { w: number; h: number },
  timeMs: number,
  vehicles: readonly VehicleView[] = [],
  street: readonly Box[] = [],
): void {
  ctx.save();
  ctx.beginPath();
  // Built in place (no tuples — this runs every frame); same rects as outdoorRect/interiorRects.
  if (world.cols <= 0 || world.city) ctx.rect(0, 0, view.w, view.h);
  else {
    const x0 = Math.max(0, sx(cam, 0));
    const y0 = Math.max(0, sy(cam, 0));
    const x1 = Math.min(view.w, sx(cam, world.cols * TILE));
    const y1 = Math.min(view.h, sy(cam, world.rows * TILE));
    ctx.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  }
  for (const h of world.houses) {
    if (!onScreen(cam, view, h.col * TILE, h.row * TILE, h.w * TILE, h.h * TILE)) continue;
    ctx.rect(sx(cam, h.col * TILE), sy(cam, h.row * TILE), h.w * TILE * cam.zoom, h.h * TILE * cam.zoom);
  }
  ctx.clip("evenodd");
  if (amb.tint.alpha > 0) {
    ctx.fillStyle = amb.tint.color;
    ctx.globalAlpha = Math.min(1, amb.tint.alpha);
    ctx.fillRect(0, 0, view.w, view.h);
  }
  // The overcast veil (its strength per weather lives with the grade's arithmetic, which the
  // City's sky inverts — engine/ambience.ts `veilAlpha`).
  const veil = veilAlpha(amb);
  if (veil > 0) {
    ctx.fillStyle = SKY.veil;
    ctx.globalAlpha = veil;
    ctx.fillRect(0, 0, view.w, view.h);
  }
  ctx.globalAlpha = 1;
  if (world.city) nightSky(ctx, amb, world, world.city, cam, view, timeMs, street);
  if (amb.lightsOn) lights(ctx, amb, world, cam, view);
  // The subway's lamps, station, stairwell, entrance sign and train (render/subway.ts).
  if (amb.lightsOn) paintSubwayLights(ctx, cam, world, view, timeMs);
  // The City's traffic: headlamps and their beam, tail lights, taxi lamps, lit buses (render/vehicles.ts).
  if (amb.lightsOn) paintVehicleLights(ctx, cam, view, vehicles);
  // The City's neon signs light the street as it darkens — by their own measure, not `lightsOn`.
  paintNeonLights(ctx, amb, world, cam, view, timeMs);
  if (amb.weather === "fog") fog(ctx, amb, cam, view, timeMs);
  particles(ctx, amb, list, cam, view);
  if (flash > 0) {
    ctx.fillStyle = SKY.flash;
    ctx.globalAlpha = Math.min(1, flash) * 0.55;
    ctx.fillRect(0, 0, view.w, view.h);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

interface Puddle {
  col: number;
  row: number;
  /** World px of the body. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Ripple centre, world px. */
  cx: number;
  cy: number;
  /** Ripple phase offset, ms (de-synchronises the rings). */
  phase: number;
}

/** Puddle layout per World object: it depends only on the tiles, so it is built once. */
const puddleCache = new WeakMap<World, Puddle[]>();

/** Every puddle of `world`, row-major: ≈ 1 in 6 path/plaza/road tiles, stable per tile. */
export function puddlesOf(world: World): readonly Puddle[] {
  const cached = puddleCache.get(world);
  if (cached) return cached;
  const out: Puddle[] = [];
  for (let row = 0; row < world.rows; row++) {
    for (let col = 0; col < world.cols; col++) {
      const kind = world.tiles[row * world.cols + col];
      if (kind !== "path" && kind !== "plaza" && kind !== "road") continue;
      const hh = hash(col, row, 41);
      if (hh % 6 !== 0) continue;
      const w = 5 + ((hh >>> 4) % 5);
      const h = 2 + ((hh >>> 8) % 2);
      const x = col * TILE + 1 + ((hh >>> 11) % (TILE - w - 1));
      const y = row * TILE + 3 + ((hh >>> 15) % (TILE - h - 5));
      out.push({ col, row, x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1), phase: hh % 900 });
    }
  }
  puddleCache.set(world, out);
  return out;
}

/** Fill a world-px rect in the CURRENT fillStyle (the batches below set it once). */
function fill(ctx: DrawTarget, cam: Camera, wx: number, wy: number, w: number, h: number): void {
  ctx.fillRect(sx(cam, wx), sy(cam, wy), w * cam.zoom, h * cam.zoom);
}

/** Puddles on ≈ 1 in 6 path/plaza/road tiles (stable per tile) with ripples; no-op unless it
 * rains. Those tiles are never indoors, so no clip. Colour-batched: few style changes a frame. */
export function paintPuddles(
  ctx: DrawTarget,
  amb: Ambience,
  world: World,
  cam: Camera,
  view: { w: number; h: number },
  timeMs: number,
): void {
  if (!isWet(amb.weather)) return;
  const span = TILE * cam.zoom;
  const c0 = Math.max(0, Math.floor(-cam.ox / span));
  const r0 = Math.max(0, Math.floor(-cam.oy / span));
  const c1 = Math.min(world.cols - 1, Math.floor((view.w - cam.ox) / span));
  const r1 = Math.min(world.rows - 1, Math.floor((view.h - cam.oy) / span));
  const all = puddlesOf(world);
  const seen = (p: Puddle) => p.col >= c0 && p.col <= c1 && p.row >= r0 && p.row <= r1;
  ctx.globalAlpha = 1;
  ctx.fillStyle = SKY.puddle;
  for (const p of all) {
    if (!seen(p)) continue;
    fill(ctx, cam, p.x + 1, p.y - 1, p.w - 2, p.h + 2);
    fill(ctx, cam, p.x, p.y, p.w, p.h);
  }
  ctx.fillStyle = SKY.puddleShine;
  for (const p of all) if (seen(p)) fill(ctx, cam, p.x + 1, p.y, Math.max(1, p.w >> 2), 1);
  // A ring every ~0.9 s per puddle, de-synchronised by the tile hash: radius 1 → 3, fading.
  ctx.fillStyle = SKY.ripple;
  for (let r = 1; r <= 3; r++) {
    ctx.globalAlpha = 0.7 - 0.2 * r;
    for (const p of all) {
      if (!seen(p) || 1 + Math.floor(((timeMs + p.phase) % 900) / 300) !== r) continue;
      fill(ctx, cam, p.cx - r, p.cy, 1, 1);
      fill(ctx, cam, p.cx + r, p.cy, 1, 1);
      fill(ctx, cam, p.cx - r + 1, p.cy - 1, 2 * r - 1, 1);
      fill(ctx, cam, p.cx - r + 1, p.cy + 1, 2 * r - 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}
