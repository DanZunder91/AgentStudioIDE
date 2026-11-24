/**
 * Agent Village — one frame. The engine has already z-sorted the DrawItems;
 * this clears the target and paints them in order, crisp (smoothing off,
 * integer zoom, integer-snapped positions).
 *
 * Cost per frame: with a cached ground layer (`view.ground`, see ground.ts) the
 * static ground is ONE `drawImage` instead of thousands of fills; everything else
 * (water, the Seats LAN's cables and packets, the project rooms' Wi-Fi pulses, walls, props,
 * characters, bubbles, labels) is culled to the view first.
 */

import {
  TILE,
  type Ambience,
  type DrawItem,
  type VehicleView,
  type WeatherParticle,
  type World,
} from "../villageTypes";
import { isWet, paintAmbience, paintPuddles } from "./ambience";
import type { Box } from "./backdropLights";
import { paintCityBackdrop } from "./city";
import type { Camera } from "./camera";
import { drawMeter } from "./capacity";
import { characterBox, drawBubble, drawCharacter } from "./characters";
import { paintCrossing } from "./crossing";
import type { GroundLayer } from "./ground";
import { isCachedGround } from "./ground";
import { drawCable, drawPacket, drawWifi } from "./lan";
import { CAR_H, CAR_W, drawCar, drawShaft } from "./lift";
import { drawLounge } from "./lounge";
import { drawNeonSign, neonLayout } from "./neon";
import {
  layoutLabel,
  paintLabel,
  placeLabels,
  type LabelLayout,
  type LabelTone,
} from "./labels";
import { onScreen, sx, sy } from "./paint";
import { drawProp } from "./props";
import { drawWalker, walkerBox } from "./streetLife";
import { drawVehicle, vehicleBox } from "./vehicles";
import type { DrawTarget, SpriteBank } from "./renderTypes";
import { drawTile, drawWall } from "./tiles";
import { TORII_HEIGHT } from "./tokyoProps";

/** The canvas size in device px, plus an optional clock (ms) for water/fountain/campfire animation. */
export interface RenderView {
  w: number;
  h: number;
  timeMs?: number;
  /**
   * The pre-painted ground of THIS frame's world and bank (ground.ts). When given, it
   * is blitted once and the `tile` items it holds are skipped; absent/null, every
   * tile is painted (a host without a canvas to cache into).
   */
  ground?: GroundLayer | null;
  /** Device px per CSS px (labels scale their font by it so they read the same on Retina). Default 1. */
  pixelRatio?: number;
  /**
   * Time of day + weather (ambience.ts). Absent = no sky at all (the old look). Present,
   * the outdoors is graded and the weather painted after the world and before bubbles
   * and labels; puddles go down right after the ground.
   */
  ambience?: Ambience;
  /** This frame's weather particles (world px). Default none. */
  particles?: readonly WeatherParticle[];
  /** Lightning brightness 0..1 this frame. Default 0. */
  flash?: number;
  /**
   * The world being drawn — its houses are cut out of the grade, its lamps and doors glow; a
   * city world also gets its sky backdrop (render/city.ts). Default: no houses, no props.
   */
  world?: World;
}

const NO_WORLD: World = {
  cols: 0,
  rows: 0,
  tiles: [],
  houses: [],
  props: [],
  seats: [],
  plaza: { col: 0, row: 0 },
};

/**
 * Label tones drawn whatever they collide with: they name the buildings themselves. Typed by
 * the tone union, so a tone that no longer exists cannot linger here.
 */
/** Whole tiles the torii's art rises above its 1-tile footprint (the cull must reach its top beam). */
const TORII_RISE_TILES = Math.ceil((TORII_HEIGHT - TILE) / TILE);

const FORCED: ReadonlySet<LabelTone> = new Set<LabelTone>(["house", "civic", "gauge"]);

/** World box around a character's feet that holds its sprite, marker, bubble and effects. */
const CHAR_BOX = { left: 16, up: 64, w: 32, h: 72 } as const;
/** Screen-px margin (per unit pixel ratio) for a label: ≤ 28 chars of ≤ 14 px monospace either side, two lines tall. */
const LABEL_HALF_W = 220;
const LABEL_H = 48;

/**
 * Paint `items` (already z-sorted) through `cam`. A null or `fallback` bank
 * draws every sprite as a coloured rectangle; procedural art is unaffected.
 */
export function renderFrame(
  ctx: DrawTarget,
  items: DrawItem[],
  cam: Camera,
  bank: SpriteBank | null,
  view: RenderView,
): void {
  const art = bank && !bank.fallback ? bank : null;
  const t = view.timeMs ?? 0;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, view.w, view.h);
  const amb = view.ambience;
  const world = view.world ?? NO_WORLD;
  // A city has a sky: painted first, under the ground (its sky tiles are transparent).
  const ground = view.ground;
  if (world.city) paintCityBackdrop(ctx, amb, world, cam, view, t, ground);
  if (ground)
    ctx.drawImage(
      ground.image,
      0,
      0,
      ground.w,
      ground.h,
      sx(cam, 0),
      sy(cam, 0),
      ground.w * cam.zoom,
      ground.h * cam.zoom,
    );
  const pr = view.pixelRatio ?? 1;
  const labels: { layout: LabelLayout; force: boolean }[] = [];
  // The City's vehicles drawn this frame: the night-lights pass lights their lamps (render/vehicles.ts).
  const lit: VehicleView[] = [];
  // …and the box of every agent and passer-by on the street: the backdrop's lights leave them out. (A
  // vehicle's art never rises above the street's top — render/vehicles.ts `ART_H` is the far lane's depth.)
  const street: Box[] = [];
  const near = (x: number, y: number): boolean =>
    onScreen(
      cam,
      view,
      x - CHAR_BOX.left,
      y - CHAR_BOX.up,
      CHAR_BOX.w,
      CHAR_BOX.h,
    );
  // Each sky layer goes down once, at its depth: puddles at the first non-ground item
  // (the engine sends the ground first), the rest at the first bubble/label. The Seats LAN
  // is INDOORS and never triggers the sky: its cables (right after the ground) get the
  // puddles laid before them — puddles sit on path/plaza/road tiles, never in a house, so
  // the two never share a pixel — and its packets (after the scene) go down before the grade.
  // A project room's Wi-Fi pulses are indoor traffic too: drawn with the packets, before the grade.
  let wet = !amb;
  let sky = !amb;
  // The road's markings (the City's pedestrian crossing, render/crossing.ts) go down once, right
  // after the ground and before the puddles on it — every frame, not in the cached ground, whose
  // street the backdrop copies beside the world (a crossing there would repeat every world-width).
  let marked = false;
  const puddles = (): void => {
    if (!marked) {
      marked = true;
      paintCrossing(ctx, cam, world, view);
    }
    if (wet) return;
    wet = true;
    paintPuddles(ctx, amb as Ambience, world, cam, view, t);
  };
  const ambience = (): void => {
    puddles();
    if (sky) return;
    sky = true;
    paintAmbience(
      ctx,
      amb as Ambience,
      view.particles ?? [],
      view.flash ?? 0,
      world,
      cam,
      view,
      t,
      lit,
      street,
    );
  };
  for (const item of items) {
    if (item.t === "bubble" || item.t === "label") ambience();
    else if (item.t !== "tile") puddles();
    switch (item.t) {
      case "tile":
        if (ground && isCachedGround(item)) break;
        if (onScreen(cam, view, item.col * TILE, item.row * TILE, TILE, TILE))
          drawTile(ctx, cam, item, art, t);
        break;
      case "wall":
        if (
          onScreen(
            cam,
            view,
            item.col * TILE,
            (item.row - 1) * TILE,
            TILE,
            2 * TILE,
          )
        )
          drawWall(ctx, cam, item, art);
        break;
      case "prop": {
        // Tall art reaches above its footprint: a tile for trees and the fountain, nearly three
        // for the torii (its top beam is 43 px over its 1-tile footprint's bottom).
        const { col, row, w, h } = item.prop;
        const rise = item.prop.kind === "torii" ? TORII_RISE_TILES : 1;
        if (
          onScreen(
            cam,
            view,
            col * TILE,
            (row - rise) * TILE,
            w * TILE,
            (h + rise) * TILE,
          )
        )
          drawProp(ctx, cam, item, art, t, amb);
        break;
      }
      case "character":
        if (near(item.c.x, item.c.y)) {
          drawCharacter(ctx, cam, item.c, art);
          street.push(characterBox(item.c));
        }
        break;
      case "bubble":
        if (near(item.c.x, item.c.y)) drawBubble(ctx, cam, item.c);
        break;
      case "cable":
        drawCable(ctx, cam, item, view);
        break;
      case "packet":
        drawPacket(ctx, cam, item, view);
        break;
      case "lounge":
        // The city's lounge dressing (render/lounge.ts): its back wall to its last aisle.
        if (onScreen(cam, view, item.col * TILE, item.row * TILE, item.w * TILE, (2 + 2 * item.benchRows) * TILE)) drawLounge(ctx, cam, item);
        break;
      case "neon": {
        // A project building's neon sign (render/neon.ts); an id with no style draws nothing.
        const sign = neonLayout(item);
        if (sign && onScreen(cam, view, ...sign.box)) drawNeonSign(ctx, cam, sign, t);
        break;
      }
      case "wifi":
        drawWifi(ctx, cam, item, view);
        break;
      case "shaft":
        // A lift shaft (render/lift.ts): its column, its rows — the lamp over its top door included.
        if (onScreen(cam, view, item.col * TILE, item.top * TILE, TILE, (item.bottom - item.top + 1) * TILE)) drawShaft(ctx, cam, item);
        break;
      case "car":
        if (onScreen(cam, view, item.x - CAR_W / 2, item.y - CAR_H, CAR_W, CAR_H)) drawCar(ctx, cam, item);
        break;
      case "vehicle":
        // A car, taxi or bus on the City's road (render/vehicles.ts); a wet road sprays behind it.
        if (onScreen(cam, view, ...vehicleBox(item.v))) {
          drawVehicle(ctx, cam, item.v, !!amb && isWet(amb.weather));
          lit.push(item.v);
        }
        break;
      case "walker":
        // A City passer-by (render/streetLife.ts): its umbrella leans with the wind.
        if (onScreen(cam, view, ...walkerBox(item))) {
          drawWalker(ctx, cam, item, art, amb?.wind ?? 0);
          street.push(walkerBox(item));
        }
        break;
      case "meter":
        if (onScreen(cam, view, item.x - 1, item.y - 1, item.w + 2, 4)) drawMeter(ctx, cam, item);
        break;
      case "label": {
        const x = sx(cam, item.x);
        const y = sy(cam, item.y);
        if (
          x + LABEL_HALF_W * pr <= 0 ||
          x - LABEL_HALF_W * pr >= view.w ||
          y + LABEL_H * pr <= 0 ||
          y - LABEL_H * pr >= view.h
        )
          break;
        const layout = layoutLabel(
          ctx,
          cam,
          item.x,
          item.y,
          item.text,
          item.tone,
          pr,
          item.maxW,
        );
        // House boards (capacity boards and gauge captions too) and the hovered character's
        // tag are always drawn; the rest take turns.
        if (layout)
          labels.push({
            layout,
            force: FORCED.has(item.tone) || item.priority === 0,
          });
        break;
      }
    }
  }
  ambience();
  // Labels last, laid out together so none overlaps another (the engine sent them in rank
  // order). Boards and plates (house, floor, civic, gauge) are painted first, then agent tags in
  // REVERSE rank, so the top-ranked tag (the hovered one) ends up on top of anything it was
  // forced over.
  const boxes = placeLabels(
    labels.map((l) => ({ box: l.layout.box, force: l.force })),
  );
  const paint = (i: number): void => {
    const box = boxes[i];
    if (box) paintLabel(ctx, labels[i].layout, box);
  };
  labels.forEach((l, i) => l.layout.tone !== "agent" && paint(i));
  for (let i = labels.length - 1; i >= 0; i--)
    if (labels[i].layout.tone === "agent") paint(i);
  ctx.globalAlpha = 1;
}
