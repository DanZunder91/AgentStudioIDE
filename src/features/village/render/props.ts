/**
 * Agent Village — furniture and outdoor props.
 *
 * Indoor furniture uses the vendored pixel-agents PNGs (desk/table, team table,
 * PC on/off frames, chair by facing, plant, bookshelf, bin, coffee, sofa). The
 * sub-agents' laptops, the city leaders' monitors (seen from behind) and the outdoor
 * props — tree, fountain, lamp, sign, campfire — are OUR procedural pixel art. Every
 * sprite is anchored to the BOTTOM of its footprint and centred across it, so
 * tall art (a 16×32 PC, a tree) rises above its tiles the way a top-down view
 * expects. Without art a prop degrades to a flat footprint-sized rectangle.
 */

import { TILE, type Ambience, type Prop, type PropReading } from "../villageTypes";
import type { Camera } from "./camera";
import { drawGauge, drawRack } from "./capacity";
import { drawHall } from "./hall";
import { blit, rect } from "./paint";
import { drawKiosk, KIOSK } from "./lift";
import { BENCH, drawBench } from "./lounge";
import { drawRouter } from "./router";
import { drawMetroEntrance, LINE } from "./subway";
import { drawSakura, drawTorii, drawVending, vendingVariant } from "./tokyoProps";
import type { DrawTarget, FurnitureId, SpriteBank } from "./renderTypes";
import { FURNITURE_SIZE } from "./sprites";

/** How far surface items (PC, coffee) are lifted so they sit on the desk top rather than its front edge. */
export const SURFACE_LIFT = 8;

const FALLBACK_COLOR: Record<Prop["kind"], string> = {
  desk: "#8a5a32",
  table: "#a87a4a",
  laptop: "#9aa0aa",
  pc: "#2b2f3a",
  chair: "#a0703c",
  plant: "#3f8a35",
  bookshelf: "#6b4423",
  bin: "#7d808a",
  coffee: "#e9e2d6",
  sofa: "#6c7fb0",
  tree: "#2f6b2a",
  fountain: "#8d8a84",
  lamp: "#3a3a40",
  sign: "#a0703c",
  campfire: "#e8662a",
  monitor: "#3d4250",
  rack: "#2a3140",
  gauge: "#4a5468",
  hall: "#6a1f2b",
  router: "#2b3140",
  sakura: "#f2a7c3",
  vending: "#2d5bd1",
  torii: "#d23b2a",
  bench: BENCH.wood,
  lift: KIOSK.canopy,
  metro: LINE,
};

/** Which vendored PNG a furniture prop uses, and whether it is mirrored; null for our own art. */
export function furnitureSprite(
  prop: Prop,
  on: boolean,
  frame: number,
): { id: FurnitureId; flip: boolean } | null {
  switch (prop.kind) {
    case "desk":
      return {
        id: prop.w >= 3 ? "DESK_FRONT" : "SMALL_TABLE_FRONT",
        flip: false,
      };
    case "table":
      return { id: "TABLE_FRONT", flip: false };
    case "pc": {
      const f = ((Math.trunc(frame) % 3) + 3) % 3;
      const on3: FurnitureId[] = [
        "PC_FRONT_ON_1",
        "PC_FRONT_ON_2",
        "PC_FRONT_ON_3",
      ];
      return { id: on ? on3[f] : "PC_FRONT_OFF", flip: false };
    }
    case "chair":
      if (prop.facing === "up") return { id: "WOODEN_CHAIR_BACK", flip: false };
      if (prop.facing === "right")
        return { id: "WOODEN_CHAIR_SIDE", flip: false };
      if (prop.facing === "left")
        return { id: "WOODEN_CHAIR_SIDE", flip: true };
      return { id: "WOODEN_CHAIR_FRONT", flip: false };
    case "sofa":
      return {
        id: prop.facing === "up" ? "SOFA_BACK" : "SOFA_FRONT",
        flip: false,
      };
    case "plant":
      return { id: "PLANT", flip: false };
    case "bookshelf":
      return { id: "BOOKSHELF", flip: false };
    case "bin":
      return { id: "BIN", flip: false };
    case "coffee":
      return { id: "COFFEE", flip: false };
    default:
      return null;
  }
}

// ───────────────────────── our own outdoor art ─────────────────────────
// (x0, bottom) = left edge and bottom edge of the footprint, world px.

function tree(ctx: DrawTarget, cam: Camera, x0: number, bottom: number): void {
  rect(ctx, cam, x0 + 6, bottom - 3, 20, 3, "rgba(0, 0, 0, 0.22)");
  rect(ctx, cam, x0 + 13, bottom - 11, 6, 10, "#6b4423");
  rect(ctx, cam, x0 + 13, bottom - 11, 2, 10, "#80552e");
  rect(ctx, cam, x0 + 3, bottom - 32, 26, 22, "#2f6b2a");
  rect(ctx, cam, x0 + 1, bottom - 27, 30, 13, "#2f6b2a");
  rect(ctx, cam, x0 + 8, bottom - 36, 16, 5, "#2f6b2a");
  rect(ctx, cam, x0 + 6, bottom - 32, 15, 11, "#3f8a35");
  rect(ctx, cam, x0 + 10, bottom - 35, 9, 4, "#4a9a3e");
  rect(ctx, cam, x0 + 9, bottom - 31, 6, 3, "#62b450");
  rect(ctx, cam, x0 + 22, bottom - 20, 2, 2, "#62b450");
}

function fountain(
  ctx: DrawTarget,
  cam: Camera,
  x0: number,
  bottom: number,
  phase: number,
): void {
  const y0 = bottom - 3 * TILE;
  rect(ctx, cam, x0 + 3, bottom - 4, 42, 4, "rgba(0, 0, 0, 0.2)");
  rect(ctx, cam, x0 + 2, y0 + 12, 44, 33, "#8d8a84"); // basin wall
  rect(ctx, cam, x0 + 2, y0 + 12, 44, 3, "#bdb9b1"); // rim
  rect(ctx, cam, x0 + 6, y0 + 16, 36, 22, "#3b76c4"); // water
  rect(ctx, cam, x0 + 6, y0 + 30, 36, 8, "#2f63a9");
  rect(ctx, cam, x0 + 8 + (phase % 4) * 3, y0 + 20, 5, 1, "#8fc1f0");
  rect(ctx, cam, x0 + 30 - (phase % 4) * 3, y0 + 33, 5, 1, "#8fc1f0");
  rect(ctx, cam, x0 + 20, y0 + 18, 8, 16, "#bdb9b1"); // pillar
  rect(ctx, cam, x0 + 18, y0 + 14, 12, 4, "#a7a39b"); // top bowl
  rect(ctx, cam, x0 + 22, y0 + 4, 4, 10, "#8fc1f0"); // spout
  rect(ctx, cam, x0 + 23, y0 + 2, 2, 2, "#d6ecff");
  const drop = phase % 2 === 0 ? 0 : 2;
  rect(ctx, cam, x0 + 17, y0 + 8 + drop, 1, 2, "#8fc1f0");
  rect(ctx, cam, x0 + 30, y0 + 10 - drop, 1, 2, "#8fc1f0");
}

/** The lamp's glass when it is off (daytime): cold, unlit. */
export const LAMP_GLASS_OFF = "#8d8f84";

function lamp(
  ctx: DrawTarget,
  cam: Camera,
  x0: number,
  bottom: number,
  lit: boolean,
): void {
  // Glow: two crossed bands, so it reads as a soft round halo (brighter where they
  // overlap) and not as a pale square stamped on the grass.
  if (lit) {
    rect(ctx, cam, x0 + 4, bottom - 32, 8, 13, "rgba(255, 224, 138, 0.16)");
    rect(ctx, cam, x0 + 2, bottom - 30, 12, 9, "rgba(255, 224, 138, 0.16)");
  }
  rect(ctx, cam, x0 + 5, bottom - 3, 6, 3, "#3a3a40");
  rect(ctx, cam, x0 + 7, bottom - 24, 2, 22, "#3a3a40");
  rect(ctx, cam, x0 + 5, bottom - 28, 6, 5, "#3a3a40");
  rect(ctx, cam, x0 + 6, bottom - 27, 4, 3, lit ? "#ffe08a" : LAMP_GLASS_OFF);
}

/** How far a screen-facing laptop is lifted above its tile's bottom edge, px. */
export const UP_LAPTOP_LIFT = 12;

/** Laptop colours. Exported for the tests (they read the screen pixel back). */
export const LAPTOP = {
  shell: "#b4bac4",
  keys: "#7d838e",
  lid: "#9aa0aa",
  bezel: "#3a3f4a",
  screenOn: "#5fc8ff",
  screenOff: "#1f2430",
  text: "#e6f6ff",
  glow: "rgba(120, 210, 255, 0.2)",
} as const;

/**
 * A sub-agent's laptop on a team table, lit while its owner works (screen glow +
 * flickering text lines over 3 frames), dark otherwise. `facing` is the SITTER's:
 * "up" (sitting below it) shows the screen; "down" (sitting above it) shows the
 * keyboard behind the lid's back, with the screen's light spilling over the keys
 * and a lit logo. Drawn inside its own 16×16 tile, on the table top.
 */
function laptop(
  ctx: DrawTarget,
  cam: Camera,
  x0: number,
  bottom: number,
  facing: Prop["facing"],
  on: boolean,
  phase: number,
): void {
  const b = bottom;
  if (facing === "down") {
    if (on) rect(ctx, cam, x0 + 2, b - 17, 12, 6, LAPTOP.glow);
    rect(ctx, cam, x0 + 3, b - 15, 10, 3, LAPTOP.shell); // keyboard, behind the lid
    rect(ctx, cam, x0 + 4, b - 14, 8, 1, on ? LAPTOP.text : LAPTOP.keys);
    rect(ctx, cam, x0 + 3, b - 12, 10, 7, LAPTOP.lid); // lid back, facing the viewer
    rect(ctx, cam, x0 + 3, b - 12, 10, 1, LAPTOP.shell);
    rect(ctx, cam, x0 + 7, b - 9, 2, 2, on ? LAPTOP.screenOn : LAPTOP.keys); // logo
    rect(ctx, cam, x0 + 3, b - 5, 10, 1, "rgba(0, 0, 0, 0.25)");
    return;
  }
  // Raised to the table's middle row: the sitter below is drawn in front and its head
  // would hide a laptop on the near edge (the PC on a desk is lifted the same way).
  const t = b - UP_LAPTOP_LIFT;
  if (on) rect(ctx, cam, x0 + 2, t - 20, 12, 10, LAPTOP.glow);
  rect(ctx, cam, x0 + 2, t - 8, 12, 1, "rgba(0, 0, 0, 0.25)");
  rect(ctx, cam, x0 + 2, t - 11, 12, 3, LAPTOP.shell); // base
  rect(ctx, cam, x0 + 3, t - 10, 10, 1, LAPTOP.keys);
  rect(ctx, cam, x0 + 3, t - 19, 10, 8, LAPTOP.bezel); // lid
  rect(ctx, cam, x0 + 4, t - 18, 8, 6, on ? LAPTOP.screenOn : LAPTOP.screenOff);
  if (on) {
    rect(ctx, cam, x0 + 5, t - 17, 3 + (phase % 3), 1, LAPTOP.text);
    rect(ctx, cam, x0 + 5, t - 15, 5 - (phase % 2) * 2, 1, LAPTOP.text);
  }
}

/** A city leader's monitor and keyboard colours. Exported for the tests (they read the LED and the keys back). */
export const MONITOR = {
  shell: "#3d4250",
  rim: "#5a6070",
  vent: "#2b2f39",
  ledOn: "#7dff9a",
  ledOff: "#252a33",
  glow: "rgba(140, 200, 255, 0.2)",
  keyboard: "#e3e6eb",
  keys: "#9aa1ab",
  keyLit: "#ffffff",
  keyShadow: "rgba(0, 0, 0, 0.22)",
} as const;

/**
 * A city leader's workstation (prop kind `monitor`, 2 tiles wide from x0): in the LEFT tile its
 * monitor, seen from BEHIND (the leader faces the street, so its screen faces the leader) — a dark back
 * panel on a stand with a power LED, and while its owner works the screen's light spilling round its
 * edges; in the RIGHT tile, right in front of the leader's chair, its KEYBOARD on the desk's board,
 * one key lit and hopping along it while its owner types (with only a screen beside them, the leaders
 * had nothing under their hands to type on — and a monitor moved in front is still not a keyboard).
 * A monitor in front would hide the seated leader's face; the keyboard is low, so the face shows over
 * it and the hands sit on it.
 */
function monitor(ctx: DrawTarget, cam: Camera, x0: number, bottom: number, on: boolean, phase: number): void {
  const b = bottom;
  if (on) rect(ctx, cam, x0 + 2, b - 32, 14, 12, MONITOR.glow);
  rect(ctx, cam, x0 + 6, b - 19, 6, 2, MONITOR.vent); // foot
  rect(ctx, cam, x0 + 8, b - 22, 2, 3, MONITOR.shell); // neck
  rect(ctx, cam, x0 + 3, b - 31, 12, 9, MONITOR.shell); // back panel
  rect(ctx, cam, x0 + 3, b - 31, 12, 1, MONITOR.rim);
  rect(ctx, cam, x0 + 6, b - 28, 6, 1, MONITOR.vent);
  rect(ctx, cam, x0 + 6, b - 26, 6, 1, MONITOR.vent);
  rect(ctx, cam, x0 + 13, b - 24, 1, 1, on ? MONITOR.ledOn : MONITOR.ledOff);
  // The keyboard, centred in the next tile (the leader's column), lying on the board.
  const k = x0 + TILE;
  rect(ctx, cam, k + 2, b - 17, 12, 1, MONITOR.keyShadow);
  rect(ctx, cam, k + 2, b - 20, 12, 3, MONITOR.keyboard);
  rect(ctx, cam, k + 3, b - 19, 10, 1, MONITOR.keys);
  if (on) rect(ctx, cam, k + 3 + 2 * (phase % 5), b - 19, 2, 1, MONITOR.keyLit);
}

/** The house's name board — art only: the name itself is the engine's floating `house` label. */
function sign(ctx: DrawTarget, cam: Camera, x0: number, bottom: number): void {
  rect(ctx, cam, x0 + 3, bottom - 9, 2, 9, "#6b4423");
  rect(ctx, cam, x0 + 11, bottom - 9, 2, 9, "#6b4423");
  rect(ctx, cam, x0 + 1, bottom - 16, 14, 8, "#a0703c");
  rect(ctx, cam, x0 + 1, bottom - 16, 14, 1, "#c08a4e");
  rect(ctx, cam, x0 + 1, bottom - 9, 14, 1, "#6b4423");
  rect(ctx, cam, x0 + 3, bottom - 14, 10, 1, "#5a3a1a");
  rect(ctx, cam, x0 + 3, bottom - 12, 7, 1, "#5a3a1a");
}

/** Colours of a campfire the rain put out. Exported for the tests. */
export const CAMPFIRE_OUT = {
  logs: "#3a2a1e",
  char: "#22201e",
  smoke: "rgba(170, 170, 176, 0.5)",
} as const;

/** Campfire: stones, crossed logs and a three-step flame flicker — or, put out, charred logs and a wisp of smoke. */
function campfire(
  ctx: DrawTarget,
  cam: Camera,
  x0: number,
  bottom: number,
  phase: number,
  lit: boolean,
): void {
  if (!lit) {
    rect(ctx, cam, x0 + 2, bottom - 4, 12, 3, "#6a6862");
    rect(ctx, cam, x0 + 3, bottom - 6, 10, 2, CAMPFIRE_OUT.logs);
    rect(ctx, cam, x0 + 5, bottom - 7, 6, 1, CAMPFIRE_OUT.char);
    // Smoke: three puffs rising and drifting with the phase, thinning as they climb.
    for (let k = 0; k < 3; k++) {
      const rise = (phase + k * 2) % 6;
      ctx.globalAlpha = 1 - k * 0.3;
      rect(
        ctx,
        cam,
        x0 + 7 + ((phase + k) % 3) - 1,
        bottom - 10 - k * 3 - rise,
        k === 0 ? 2 : 1,
        2,
        CAMPFIRE_OUT.smoke,
      );
    }
    ctx.globalAlpha = 1;
    return;
  }
  rect(ctx, cam, x0 + 1, bottom - 14, 14, 13, "rgba(255, 150, 60, 0.18)"); // glow
  rect(ctx, cam, x0 + 2, bottom - 4, 12, 3, "#7d7a74");
  rect(ctx, cam, x0 + 3, bottom - 6, 10, 2, "#6b4423");
  rect(ctx, cam, x0 + 5, bottom - 7, 6, 1, "#80552e");
  const flames: [number, number, number][][] = [
    [
      [6, 12, 4],
      [7, 14, 2],
    ],
    [
      [5, 11, 5],
      [7, 13, 2],
    ],
    [
      [6, 13, 5],
      [8, 15, 1],
    ],
  ];
  const [outer, inner] = flames[phase % 3];
  rect(
    ctx,
    cam,
    x0 + outer[0],
    bottom - outer[1],
    outer[2],
    outer[1] - 6,
    "#e8662a",
  );
  rect(
    ctx,
    cam,
    x0 + inner[0],
    bottom - inner[1] + 3,
    inner[2],
    inner[1] - 10,
    "#ffd34d",
  );
}

/**
 * One prop. `on`/`frame` drive the PC / laptop screen and a router's LEDs; `reading`
 * the capacity props (the Seats hall, racks, gauges, a lounge bench's waiter);
 * `timeMs` drives the fountain, the campfire and the hall's audience. `ambience`
 * (absent = the old always-lit look) turns lamps on only with `lightsOn` and puts the
 * campfire out when `!campfireLit`.
 */
export function drawProp(
  ctx: DrawTarget,
  cam: Camera,
  item: { prop: Prop; on: boolean; frame: number; reading?: PropReading },
  bank: SpriteBank | null,
  timeMs: number,
  ambience?: Ambience,
): void {
  const { prop } = item;
  const x0 = prop.col * TILE;
  const bottom = (prop.row + prop.h) * TILE;
  const phase = Math.max(0, Math.trunc(item.frame)) + Math.floor(timeMs / 140);
  switch (prop.kind) {
    case "tree":
      return tree(ctx, cam, x0, bottom);
    case "fountain":
      return fountain(ctx, cam, x0, bottom, phase);
    case "lamp":
      return lamp(ctx, cam, x0, bottom, ambience?.lightsOn ?? true);
    case "sign":
      return sign(ctx, cam, x0, bottom);
    case "campfire":
      return campfire(
        ctx,
        cam,
        x0,
        bottom,
        phase,
        ambience?.campfireLit ?? true,
      );
    case "laptop":
      return laptop(ctx, cam, x0, bottom, prop.facing, item.on, phase);
    case "monitor":
      return monitor(ctx, cam, x0, bottom, item.on, phase);
    case "rack":
      return drawRack(ctx, cam, x0, bottom, item.reading);
    case "gauge":
      return drawGauge(ctx, cam, x0, bottom, item.reading);
    case "hall":
      return drawHall(ctx, cam, x0, bottom, item.reading, timeMs, prop.w * TILE);
    case "router":
      return drawRouter(ctx, cam, x0, bottom, item.on, item.frame);
    case "sakura":
      return drawSakura(ctx, cam, x0, bottom, timeMs / 1000);
    case "vending":
      return drawVending(ctx, cam, x0, bottom, vendingVariant(prop.id), ambience?.lightsOn ?? false);
    case "torii":
      return drawTorii(ctx, cam, x0, bottom);
    case "bench":
      return drawBench(ctx, cam, x0, bottom, prop.index as number, item.reading, bank, timeMs, ambience);
    case "lift":
      return drawKiosk(ctx, cam, x0, bottom, ambience?.lightsOn ?? false);
    case "metro":
      return drawMetroEntrance(ctx, cam, x0, bottom, ambience?.lightsOn ?? false);
  }
  const pick = furnitureSprite(prop, item.on, item.frame) as {
    id: FurnitureId;
    flip: boolean;
  };
  const img = bank?.furniture(pick.id) ?? null;
  if (!img) {
    rect(
      ctx,
      cam,
      x0,
      bottom - prop.h * TILE,
      prop.w * TILE,
      prop.h * TILE,
      FALLBACK_COLOR[prop.kind],
    );
    return;
  }
  const size = FURNITURE_SIZE[pick.id];
  const lift = prop.kind === "pc" || prop.kind === "coffee" ? SURFACE_LIFT : 0;
  const x = x0 + Math.round((prop.w * TILE - size.w) / 2);
  blit(
    ctx,
    cam,
    img,
    0,
    0,
    size.w,
    size.h,
    x,
    bottom - size.h - lift,
    pick.flip,
  );
}
