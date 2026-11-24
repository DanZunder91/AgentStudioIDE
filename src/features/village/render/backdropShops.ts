/**
 * Agent Village — the City's YOKOCHŌ: a row of small food shops behind the street, under paper lanterns
 * and kana signs — the front of the City's backdrop in Tokyo (render/backdrop.ts is the contract; `SHOPS`
 * is its nearest MID layer, before the neon canyon, render/backdropCanyon.ts, with the high-rises behind,
 * render/backdropTowers.ts).
 *
 * At Fit, a strip of low haze beside a tall gazelle leaves the background empty; these shops fill it
 * with ramen shops and the like, under neon signs for ramen and soba in katakana, sushi in hiragana and
 * karaoke — four big signs — by day and by night. They stand in front of the towers and the canyon, with
 * open sky between their clusters.
 *
 * THE ROW — clusters of two- and three-storey Tokyo shophouses standing on the horizon in the open street
 * beyond both ends of the city, in front of the haze and behind everything the world draws. Within a
 * cluster the shops stand wall to wall, an alley now and then; no shop touching one of the backdrop's
 * QUIET stretches is built (render/backdrop.ts `inQuiet`): the open sky between clusters (`airSpans`,
 * 64–120 px per 288 px — the canyon's gaps too, so they line up front and back) and the city's own span,
 * whose street gaps hold the temples, Tokyo Tower and the sakura in front of calm apartments. A storey is 32 world px (2 tiles): a shop door is a little shorter than a
 * passer-by and a window an eighth of a project floor, so the row reads nearer than the haze (whose
 * windows are 1×2 px) and still well behind the world's own buildings. Its colours are mixed 15 % of the
 * way towards the haze's (more in rain and fog; the lanterns, noren, awnings and signs half that, so they
 * stay vivid): the aerial perspective that puts it between the two.
 *
 *        ▄▄▄▄▄▄▄▄▄▄                 ┌──────────┐      kawara (tiled) roof, or a flat roof with a
 *      ▄▄██████████▄▄          ▓▓▓▓ │ カラオケ │      water tank, a stair house or a kana signboard
 *     ┌──────────────┐ ┌──┐   ┌────┴──────────┴─┐
 *     │ ▯▯  ▯▯   ▯▯  │ │ラ│   │ ▯▯   ▯▯   ▯▯   │    upper floors: windows, balconies, AC units,
 *     │▀▀▀▀▀▀▀▀▀▀▀▀▀▀│ │ー│   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│    a pot plant, laundry
 *     │ ▯▯  ▯▯   ▯▯  │ │メ│   │ ▯▯   ▯▯   ▯▯   │
 *     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │ン│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓    a tiled eave (or a striped awning)
 *     │ ● ┃▌▌▌┃ ●  ▢ │ └──┘ │ ● ┃▌▌▌┃ ●         │    red chōchin lanterns, a split noren curtain
 *     │   ┃░░░┃      │      │   ┃░░░┃           │    over a sliding door of lit paper panes
 *
 * About one shop in three hangs a vertical BLADE SIGN (tategaki), its word from `SIGN_WORDS` laid out by
 * render/kana.ts on a plate in its kind's colours: ラーメン yellow on red, ソバ white on indigo, すし red on
 * white, カレー on orange, コーヒー cream on brown, カラオケ white on magenta, バー pink on purple; a roof in
 * eighteen carries a horizontal signboard (カラオケ, ゲーム, ホテル, バー, コーヒー).
 *
 * THE FEATURED FOUR — ラーメン, ソバ, すし and カラオケ — are always in view at Fit, on BIG signs: their
 * kana twice the size (16 px, readable at Fit on a @2x screen, where a glyph of the others is 8),
 * each shop raised to three storeys to hold one (`feature`). They take the shops nearest the city's ends
 * whose sign stands in the OPEN street beyond them, inside what Fit frames (render/landmarks.ts
 * `placeLandmarks(…).span`), out of the quiet stretches and clear of every temple, street tree, lamp or
 * torii, and the projects' own neon blade signs — in the reference city, a cluster of tall shops right of
 * Agent Studio, past its torii. A street with no such room falls back, in order, to a usual-size sign
 * there, then to just past the frame (which the view's own width at Fit shows). In a street with no
 * building at all they stand nearest the middle of its frame.
 *
 * NIGHT (`paintLights`, after the grade, every light through `fillLit`): the shop fronts glow warm but
 * modest — paper doors, back-lit noren, display windows, light spilling under the eaves — the lanterns
 * glow red, and the signs light up as neon: the plate a back-lit box, the kana in bright tubes, all rising
 * with `neonStrength` (render/neon.ts), from nothing at noon to full at night (and part-way in a storm's
 * gloom); only the four featured big signs, the focal points, wear a halo. Now and then one kana stutters
 * (`neonFlicker`, deterministic per sign and time). Upstairs, single windows come on one by one in a dim
 * warm (some a cool white) as `s.lit` rises, each at its own threshold — 28 % at full night, and a floor
 * in four stays vacant, never lit.
 *
 * THE CALM PASS (zoomed ×2 on a City at night, the row looked overloaded — a sign-lit shop behind a
 * shrine in a narrow gap between the city's buildings, blades everywhere round the karaoke building —
 * while the idea of some neon-lit buildings, a night district with more behind it, still made sense): a
 * hierarchy, not wallpaper. The four big signs carry the neon; the rest recedes — blades on a third of
 * the shops, a signboard on a roof in eighteen, no halo but the four's, dimmer fronts and windows — and
 * nothing at all in the city's own span. By the calm pass's measures, the row's lit pixels at ×2 by
 * night and its signs per 1000 px of street are about half what they were.
 *
 * LANDMARKS are never hidden: over each shop `roofLimit(…, ["far", "tower"])` caps
 * its roof; a shop that would rise into a crown first loses its rooftop tank, stair house or signboard,
 * then storeys (`settle`).
 *
 * WORLD-LOCKED (a skyline that slides under a pan is a bug): the row is laid out in fixed CHUNKS
 * of the world (`CHUNK` px), each a pure function of its index, so a pan or a zoom never re-rolls it; the
 * per-world part (the landmarks' caps, the city's own span left quiet, the featured four) is settled
 * once per World. The quiet stretches are world-locked too. `faceAt` reads a per-column height table
 * built with each chunk.
 *
 * COST — every chunk's shops are settled once per World and their art compiled once (rects in shop
 * coordinates, a colour index and a level of detail each); a frame walks only the chunks in view and
 * skips any rect off screen. Below `PANE_ZOOM` (the haze's threshold) only the big shapes are drawn,
 * the kana of a small sign as one block a glyph; from `FINE_ZOOM` the finest detail (lattices, lantern
 * ribs, tank panels, window hoods and sills) joins in.
 * Measured in headless Chromium, the reference city (its Tokyo backdrop whole, towers and
 * canyon behind):
 *   - Fit, 1280×800 @2x (zoom 1): by day 0.23 ms (893 rects); at night 0.19 ms through the frame's
 *     `fillLit` (389 lights; 0.11 ms of it is filling them, the rest cutting them round the street's
 *     trees, lamps and sprites, render/backdropLights.ts);
 *   - Fit @1x (zoom 9/16): 0.08 ms (308 rects) and 0.12 ms; zoomed to 2 on the open street: 0.13 and
 *     0.09 ms.
 */

import { CITY_DAY } from "../engine/ambience";
import { artBox } from "../engine/streetTheme";
import { TILE, type Ambience, type CityInfo, type WeatherKind, type World } from "../villageTypes";
import type { Camera } from "./camera";
import { citySpan, inQuiet, roofLimit, type BackdropLayer, type BackdropLightScene, type BackdropScene } from "./backdrop";
import { kanaText, KANA_H, KANA_W, type Run } from "./kana";
import { landmarksFor, placeLandmarks } from "./landmarks";
import { neonFlicker, neonSignsOf, neonStrength } from "./neon";
import { hash, sx, sy } from "./paint";

// ───────────────────────────── sizes ─────────────────────────────

/** World px of a shop-width unit; shops are 3–9 of them wide, alleys 1–2. */
const UNIT = 8;
/** Units per layout chunk: the row is laid out afresh from the left edge of every 256-px chunk. */
const CHUNK_UNITS = 32;
/** World px per layout chunk. */
export const CHUNK = CHUNK_UNITS * UNIT;
/** World px of the ground floor (the shop front, its eave included) and of each floor above it. */
export const GROUND = 32;
export const STOREY = 32;
/** Rows of a kawara roof, and of a flat roof's parapet. */
const HIP_ROWS = 8;
const PARAPET = 3;
/** World px of a sliding door, and from the street up to a blade sign's lower edge. */
const DOOR_H = 20;
const SIGN_BOTTOM = 20;
/** How many chunks past what Fit frames the featured four may go looking for a shop. */
const SEARCH = 3;
/** The narrowest shop that can hang one of the featured big signs, and a door beside it. */
const BIG_W = 5 * UNIT;
/** A rooftop signboard: the kana, 2 px of air and a 1-px rim all round, on a 4-px steel frame. */
const BOARD_PAD = 3;
const BOARD_H = KANA_H + 2 * BOARD_PAD;
const BOARD_FRAME = 4;
/** Upper-floor windows. */
const WIN_W = 10;
const WIN_H = 12;
/** The tallest a shop stands: three storeys, a flat roof and a signboard on it. */
export const MAX_H = GROUND + 2 * STOREY + PARAPET + BOARD_FRAME + BOARD_H;
/** Below this zoom a 1-px detail is under ¾ of a screen px: only the big shapes are drawn (render/city.ts). */
const PANE_ZOOM = 0.75;
/** From this zoom the finest detail is drawn: it only reads zoomed in, where few shops are in view. */
const FINE_ZOOM = 2;
/** Chunks kept per World before the cache starts over (panning far away builds new ones). */
const MAX_CHUNKS = 256;

/** Which levels of detail a rect is drawn at: zoomed out, from `PANE_ZOOM`, from `FINE_ZOOM`. */
const COARSE = 1;
const PANE = 2;
const FINE = 4;
const ALL = COARSE | PANE | FINE;
const DETAIL = PANE | FINE;

// ───────────────────────────── colours ─────────────────────────────

/**
 * The row by day, before the haze (`HAZE_MIX`) — our own palette: plaster, tile and wood walls, grey and
 * blue-glazed kawara, wooden shop fronts, paper, the noren's dyes, red lanterns, and each sign's plate and
 * kana. Exported for the tests (`shopPalette` holds them in this order).
 */
export const SHOP_DAY = {
  wallCream: "#e6dbc2",
  wallStone: "#c4bdb0",
  wallSand: "#d6bf98",
  wallTile: "#b4c6ae",
  wallWhite: "#e9e7e0",
  wallRose: "#d7b9b0",
  wallWood: "#8c6648",
  shade: "#6f6458",
  frontWood: "#7c5838",
  post: "#4c3424",
  pipe: "#8c9096",
  frosted: "#c3d0d8",
  board: "#3a3430",
  chalk: "#e8e4da",
  pot: "#a85d3a",
  crate: "#d89a2a",
  crateDark: "#9a6a1c",
  frontDark: "#2f2a30",
  frontCafe: "#4a3626",
  frontNight: "#3a3444",
  eave: "#5b6170",
  eaveLight: "#8c92a0",
  eaveDrip: "#33363f",
  tileGrey: "#5d6372",
  tileGreyAlt: "#4e5362",
  tileBlue: "#4b5f7e",
  tileBlueAlt: "#3f506c",
  ridge: "#30333c",
  doorFrame: "#3c2a1e",
  paper: "#efe5cb",
  glassDoor: "#4f4a48",
  display: "#6a5848",
  food: "#d8a050",
  norenRed: "#b3292b",
  norenIndigo: "#24316a",
  norenWhite: "#e8e2d2",
  norenNavy: "#1f2a48",
  norenRod: "#2a2224",
  norenBrown: "#74361f",
  lantern: "#cf3428",
  lanternDark: "#962420",
  lanternLight: "#f0806a",
  lanternWhite: "#efe8d6",
  lanternCap: "#26201f",
  awningOrange: "#d5742a",
  awningBrown: "#6a4228",
  awningCream: "#efe0c2",
  frame: "#c2c6cc",
  glass: "#5e7a96",
  glassLight: "#8ea9c3",
  curtain: "#e4d4bc",
  balcony: "#c6c2ba",
  rail: "#dedad2",
  ac: "#dcdedf",
  acFan: "#7a7f86",
  plant: "#4f8a3a",
  plantLight: "#74b058",
  laundryPole: "#8d939b",
  laundryA: "#f2f2ee",
  laundryB: "#79a5d6",
  laundryC: "#e48a8a",
  parapet: "#bcb7ac",
  coping: "#d6d2c9",
  steel: "#3d3e46",
  tank: "#b2c8d3",
  tankLine: "#8fa9b6",
  stair: "#cdc7ba",
  stairDoor: "#55504a",
  rim: "#25212a",
  ramenPlate: "#c4302a",
  ramenText: "#ffd545",
  sobaPlate: "#283a7c",
  sobaText: "#f4f1e8",
  sushiPlate: "#f0ece2",
  sushiText: "#c2282c",
  curryPlate: "#dc7822",
  curryText: "#fff2d6",
  coffeePlate: "#5c3a22",
  coffeeText: "#f0dcb8",
  karaokePlate: "#c42a88",
  karaokeText: "#fff6fb",
  barPlate: "#4a2c74",
  barText: "#f2c2ff",
  gamePlate: "#1d6ad0",
  gameText: "#ffe14a",
  hotelPlate: "#20786a",
  hotelText: "#f2fff8",
} as const;
type Col = keyof typeof SHOP_DAY;
const NAMES = Object.keys(SHOP_DAY) as Col[];
const IDX = Object.fromEntries(NAMES.map((n, i) => [n, i])) as Record<Col, number>;

/** The far skyline's day colour (engine/ambience.ts `CITY_DAY.skyline`): what the row's colours lean towards. */
export const HAZE = CITY_DAY.skyline;
/** How far towards the haze the row's day colours are mixed: a touch hazier than the world's buildings. */
const HAZE_MIX = 0.15;
/** …and how much more in each weather: rain and fog wash it out, as they do the landmarks (render/landmarks.ts `SEEN`). */
const WEATHER_MIX: Record<WeatherKind, number> = { clear: 0, cloudy: 0.05, drizzle: 0.08, snow: 0.12, rain: 0.12, storm: 0.1, fog: 0.3 };

/** `#rrggbb` mixed `t` of the way towards `#rrggbb` `to`. */
function mix(from: string, to: string, t: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** The dyes and paints the eye goes to — the lanterns, the noren, the awnings and every sign — take half the haze: they stay vivid. */
const ACCENT = /^(lantern|noren|awning)|Plate$|Text$/;

const palettes = new Map<WeatherKind, readonly string[]>();

/** The row's day colours in `weather`, hazed (built once per weather). */
export function shopPalette(weather: WeatherKind): readonly string[] {
  let p = palettes.get(weather);
  if (!p) {
    const t = HAZE_MIX + WEATHER_MIX[weather];
    p = NAMES.map((n) => mix(SHOP_DAY[n], HAZE, ACCENT.test(n) ? t / 2 : t));
    palettes.set(weather, p);
  }
  return p;
}

/** The lights, after the grade — never hazed: a lit sign cuts through the dusk. */
const LIT = {
  paper: "#ffdc96",
  glassDoor: "#ffd27a",
  spill: "#ffc870",
  slit: "#fff0c0",
  window: "#e6cf98",
  windowCool: "#d6e0e8",
  lantern: "#ff5a36",
  lanternCore: "#ffb070",
  lanternHalo: "#ff5030",
  lanternWhite: "#fff0c8",
  lanternWhiteCore: "#ffffff",
  lanternWhiteHalo: "#ffe0a0",
} as const;

// ───────────────────────────── the shops ─────────────────────────────

/** What a sign says and how it lights: its plate and kana by day (colour names), and lit at night. */
interface SignStyle {
  plate: Col;
  text: Col;
  /** The plate, back-lit. */
  glow: string;
  /** The kana's neon tubes. */
  tube: string;
}

/** Every `SIGN_WORDS` word's sign (render/backdrop.ts): `shops.test.ts` pins that each has one. */
export const SIGNS: Readonly<Record<string, SignStyle>> = {
  ラーメン: { plate: "ramenPlate", text: "ramenText", glow: "#ff4a36", tube: "#fff27a" },
  ソバ: { plate: "sobaPlate", text: "sobaText", glow: "#4f6cff", tube: "#ffffff" },
  すし: { plate: "sushiPlate", text: "sushiText", glow: "#fff4e0", tube: "#ff2a2a" },
  カレー: { plate: "curryPlate", text: "curryText", glow: "#ff9a2e", tube: "#fff6e0" },
  コーヒー: { plate: "coffeePlate", text: "coffeeText", glow: "#c0763c", tube: "#ffe6b4" },
  カラオケ: { plate: "karaokePlate", text: "karaokeText", glow: "#ff3ab4", tube: "#ffffff" },
  バー: { plate: "barPlate", text: "barText", glow: "#9a5cff", tube: "#ffc8f6" },
  ゲーム: { plate: "gamePlate", text: "gameText", glow: "#3a8cff", tube: "#fff27a" },
  ホテル: { plate: "hotelPlate", text: "hotelText", glow: "#2ee0c0", tube: "#ffffff" },
};

/** A kind of shop: its blade sign's word (none for an izakaya), its front and how it is hung. */
export type Kind = "ramen" | "soba" | "sushi" | "curry" | "coffee" | "karaoke" | "bar" | "izakaya";

interface KindStyle {
  word: string | null;
  front: Col;
  door: "paper" | "glass";
  /** A noren curtain over the door (its dye, and lit), or a striped awning instead of the tiled eave. */
  noren: Col | null;
  norenLit: string;
  awning: Col | null;
  lantern: "red" | "white" | "row" | null;
}

const KINDS: Readonly<Record<Kind, KindStyle>> = {
  ramen: { word: "ラーメン", front: "frontWood", door: "paper", noren: "norenRed", norenLit: "#ff6a50", awning: null, lantern: "red" },
  soba: { word: "ソバ", front: "frontWood", door: "paper", noren: "norenIndigo", norenLit: "#6f86ec", awning: null, lantern: "white" },
  sushi: { word: "すし", front: "frontWood", door: "paper", noren: "norenWhite", norenLit: "#fff2d2", awning: null, lantern: "red" },
  curry: { word: "カレー", front: "frontCafe", door: "glass", noren: null, norenLit: "", awning: "awningOrange", lantern: null },
  coffee: { word: "コーヒー", front: "frontCafe", door: "glass", noren: null, norenLit: "", awning: "awningBrown", lantern: null },
  karaoke: { word: "カラオケ", front: "frontNight", door: "glass", noren: null, norenLit: "", awning: null, lantern: null },
  bar: { word: "バー", front: "frontDark", door: "paper", noren: "norenNavy", norenLit: "#5a74c8", awning: null, lantern: "red" },
  izakaya: { word: null, front: "frontWood", door: "paper", noren: "norenBrown", norenLit: "#e0884e", awning: null, lantern: "row" },
};

/** The kinds a shop is drawn from, weighted (the narrowest are bars and stand-up izakaya). */
const KIND_DRAW: readonly Kind[] = [
  "ramen", "ramen", "ramen", "soba", "soba", "sushi", "sushi",
  "curry", "coffee", "karaoke", "bar", "bar", "izakaya", "izakaya",
];
const NARROW_DRAW: readonly Kind[] = ["bar", "bar", "izakaya", "ramen"];

/**
 * The featured four (the three food words, then karaoke), in the order they choose their shops: the
 * four-kana words first, which need the tallest fronts.
 */
export const FEATURED: readonly Kind[] = ["ramen", "karaoke", "soba", "sushi"];

/** The rooftop signboards' words. */
const ROOF_WORDS: readonly string[] = ["カラオケ", "ゲーム", "ホテル", "バー", "コーヒー"];

/** Shop widths, in units (24–72 px), weighted towards the middle. */
const WIDTHS: readonly number[] = [3, 4, 5, 5, 6, 6, 6, 7, 7, 8, 9];

const WALLS: readonly Col[] = ["wallCream", "wallStone", "wallSand", "wallTile", "wallWhite", "wallRose", "wallWood"];

/** A roof: kawara tiles (grey or blue-glazed), or flat with nothing, a water tank, a stair house or a signboard on it. */
type Roof = "grey" | "blue" | "flat" | "tank" | "stair" | "board";

/** One shop of the row, settled for its World. Read-only outside this module (its art is compiled lazily). */
export interface Shop {
  /** Left edge and width, world px. */
  readonly x: number;
  readonly w: number;
  /** 1–3, the ground floor included. */
  storeys: number;
  roof: Roof;
  /** The rooftop signboard's word (when `roof` is "board"). */
  readonly board: string;
  kind: Kind;
  /** The blade sign's word, or null (an izakaya, or a shop lowered to one storey). */
  word: string | null;
  /** The blade sign hangs at the shop's left edge (else its right). */
  readonly signLeft: boolean;
  /** One of the featured four (`feature`). */
  featured: boolean;
  /** Its blade sign is twice the size (one of the featured four, where its front can hold it). */
  big: boolean;
  readonly seed: number;
  /** It hangs a blade sign (about one shop in three — the calm pass; the featured four always). */
  readonly blade: boolean;
  art?: Art;
}

/** World px a shop stands above the horizon (its tallest column). */
export function shopHeight(shop: Pick<Shop, "storeys" | "roof" | "board">): number {
  const body = GROUND + (shop.storeys - 1) * STOREY;
  switch (shop.roof) {
    case "grey":
    case "blue":
      return body + HIP_ROWS + 1;
    case "flat":
      return body + PARAPET;
    case "tank":
      return body + PARAPET + 12;
    case "stair":
      return body + PARAPET + 9;
    case "board":
      return body + PARAPET + BOARD_FRAME + BOARD_H;
  }
}

/** A rooftop signboard's width for `word`. */
const boardW = (word: string): number => kanaText(word, false).w + 2 * BOARD_PAD;

/**
 * The shops chunk `c` lays out, before any World settles them: a pure function of `c`. From the
 * chunk's left edge, shops of 3–9 units, now and then a 1–2-unit alley before one (never the chunk's
 * first, never leaving no room for it); the last shop takes what is left of the chunk, and a remainder
 * too narrow for a shop is an alley too. So no gap in the row is wider than 2 units.
 */
function rawChunk(c: number): Shop[] {
  const out: Shop[] = [];
  for (let u = 0, i = 0; CHUNK_UNITS - u >= WIDTHS[0]; i++) {
    const h = hash(c, i, 401);
    const alley = i > 0 && h % 6 === 0 ? 1 + ((h >>> 3) % 4 === 0 ? 1 : 0) : 0;
    if (CHUNK_UNITS - u - alley >= WIDTHS[0]) u += alley;
    const units = Math.min(CHUNK_UNITS - u, WIDTHS[(h >>> 5) % WIDTHS.length]);
    out.push(shopAt(c * CHUNK + u * UNIT, units * UNIT, hash(c, i, 409)));
    u += units;
  }
  return out;
}

/** A shop `w` px wide at world x `x`, rolled from hash `h`. */
function shopAt(x: number, w: number, h: number): Shop {
  const pool = w <= 3 * UNIT ? NARROW_DRAW : KIND_DRAW;
  const kind = pool[(h >>> 9) % pool.length];
  const fits = ROOF_WORDS.filter((word) => boardW(word) <= w - 4);
  const board = fits.length ? fits[(h >>> 20) % fits.length] : "";
  // Kawara and flat roofs, tanks and stair houses; a rooftop signboard on one roof in eighteen.
  const rolls: readonly Roof[] = [
    "grey", "grey", "grey", "grey", "blue", "blue", "flat", "flat", "flat",
    "flat", "flat", "tank", "tank", "tank", "tank", "stair", "stair", "board",
  ];
  let roof = rolls[(h >>> 3) % rolls.length];
  if (roof === "board" && !board) roof = "tank";
  const storeys = 2 + (h % 5 < 2 ? 1 : 0);
  const signLeft = ((h >>> 14) & 1) === 1;
  const blade = (h >>> 23) % 3 === 0;
  return { x, w, storeys, roof, board, kind, word: KINDS[kind].word, signLeft, blade, featured: false, big: false, seed: h };
}

// ───────────────────────────── settling, per World ─────────────────────────────

/** What a World's row is settled against. */
interface Settle {
  world: World;
  amb: Ambience | undefined;
  horizon: number;
  featured: ReadonlyMap<number, Feature>;
}

/** One of the featured four, as a shop takes it: the word's kind, and a big sign or the usual one. */
interface Feature {
  kind: Kind;
  big: boolean;
}

/**
 * `shop` settled in its World — or null when it is left out: every shop touching one of the backdrop's
 * quiet stretches is (`inQuiet`: the open sky between the clusters, and the city's own span — so none
 * stands behind a building or in the street's gaps between them). One of the featured four (`st.featured`)
 * takes its kind — and with a big sign, three storeys (the sign kept while its front still holds it).
 * Under a landmark's crown it first loses its rooftop
 * tank, stair house or signboard, then storeys (one storey hangs no blade sign) — never the last: the
 * landmarks keep their crowns clear of the haze (render/landmarks.ts), so the lowest cap of all, the
 * Tower's in the shortest sky (240 px), still leaves room for a storey under kawara (41 px).
 * Only the featured four and about one shop in three hang a blade sign (`blade`).
 */
function settle(shop: Shop, st: Settle): Shop | null {
  if (inQuiet(st.world, shop.x, shop.x + shop.w)) return null;
  const f = st.featured.get(shop.x);
  if (f) {
    shop.kind = f.kind;
    shop.featured = true;
    shop.big = f.big;
    if (f.big) shop.storeys = 3;
  }
  const limit = roofLimit(st.world, st.amb, st.horizon, shop.x, shop.x + shop.w, ["far", "tower"]);
  while (st.horizon - shopHeight(shop) < limit) {
    if (shop.roof === "tank" || shop.roof === "stair" || shop.roof === "board") shop.roof = "flat";
    else shop.storeys--;
  }
  shop.word = shop.storeys > 1 && (shop.blade || shop.featured) ? KINDS[shop.kind].word : null;
  // A big sign needs the front to hang on: ラーメン and カラオケ three storeys, ソバ and すし two.
  shop.big &&= shop.storeys > 1 && SIGN_BOTTOM + (bladePlate(shop, 0) as number[])[3] <= GROUND + (shop.storeys - 1) * STOREY;
  return shop;
}

/** A chunk of the row, settled: its shops, and the height of the row above the horizon at each of its columns. */
interface Chunk {
  shops: Shop[];
  heights: Uint8Array;
}

/** A World's row: its zone (the landmarks it settles under), what it settles against, and its chunks so far. */
interface Memo {
  zone: string | undefined;
  st: Settle;
  chunks: Map<number, Chunk>;
}

const MEMO = new WeakMap<World, Memo>();

/** What `world`'s row settles against (the City's street is its horizon). */
function settleOf(world: World, amb: Ambience | undefined, featured: ReadonlyMap<number, Feature>): Settle {
  const city = world.city as CityInfo;
  return { world, amb, horizon: city.street * TILE, featured };
}

/** Chunk `c` of the row, settled (cached). */
function chunkOf(m: Memo, c: number): Chunk {
  const hit = m.chunks.get(c);
  if (hit) return hit;
  if (m.chunks.size >= MAX_CHUNKS) m.chunks.clear();
  const shops: Shop[] = [];
  for (const raw of rawChunk(c)) {
    const s = settle(raw, m.st);
    if (s) shops.push(s);
  }
  // A shop's outline runs bottom up, so each column ends at its top.
  const heights = new Uint8Array(CHUNK);
  for (const s of shops) for (const [dx, w, up] of outline(s)) heights.fill(up, s.x - c * CHUNK + dx, s.x - c * CHUNK + dx + w);
  const chunk = { shops, heights };
  m.chunks.set(c, chunk);
  return chunk;
}

/**
 * The world box [x, y, w, h] of `shop`'s blade sign plate, or null when it hangs none: the kana, 1 px of
 * air and a 1-px rim either side — all twice the size for one of the featured four (`big`).
 */
export function bladePlate(shop: Pick<Shop, "x" | "w" | "word" | "big" | "signLeft">, horizon: number): [number, number, number, number] | null {
  if (!shop.word) return null;
  const scale = shop.big ? 2 : 1;
  const w = KANA_W * scale + 2 * (scale + 1);
  const h = kanaText(shop.word, true).h * scale + 2 * (scale + 1);
  return [shop.signLeft ? shop.x + 1 : shop.x + shop.w - 1 - w, horizon - SIGN_BOTTOM - h, w, h];
}

/** Do two world boxes [x, y, w, h] overlap? */
const overlap = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/**
 * Which shops take the featured four words (shop x → its kind and sign). A candidate for a word is a
 * shop out of the quiet stretches — so in the open street beyond the city's ends — that, taking it, still
 * hangs its sign under any landmark's crown: a big one where its front can hold it (ラーメン and カラオケ
 * three storeys, ソバ and すし two), else the usual one; and clear of every temple, street prop rising
 * above the street and project neon sign. Best first: inside what Fit frames, then just past it — at
 * each, a big sign before the usual one, then the nearest the city's ends. The four-kana words choose first.
 */
function feature(world: World, amb: Ambience | undefined): Map<number, Feature> {
  const st = settleOf(world, amb, new Map());
  const { horizon } = st;
  const layout = placeLandmarks(world, horizon, landmarksFor(amb?.zone));
  const [s0, s1] = layout.span;
  const front: number[][] = [
    ...layout.placed.filter((p) => p.spec.layer === "near").map((p) => [p.x - p.hw, horizon - p.h, 2 * p.hw + 1, p.h]),
    ...world.props.map(artBox).filter((b) => b.row * TILE < horizon).map((b) => [b.col * TILE, b.row * TILE, b.w * TILE, b.h * TILE]),
    ...neonSignsOf(world).map((l) => l.sign.box),
  ];
  // The city's ends; in a street with no building at all, the middle of its frame.
  const mid = Math.round((s0 + s1) / 2);
  const [e0, e1] = citySpan(world) ?? [mid, mid];
  const out = new Map<number, Feature>();
  for (const kind of FEATURED) {
    let best: { x: number; rank: number; d: number; big: boolean } | null = null;
    for (const big of [true, false])
      // Three chunks past the frame either side: out past the world's own props a free shop always stands.
      for (let c = Math.floor(s0 / CHUNK) - SEARCH; c * CHUNK < s1 + SEARCH * CHUNK; c++)
        for (const raw of rawChunk(c)) {
          if (out.has(raw.x) || (big && raw.w < BIG_W)) continue;
          const shop = settle(raw, { ...st, featured: new Map([[raw.x, { kind, big }]]) });
          // Left out, too low for any sign, or its front too short for the big one.
          if (!shop?.word || shop.big !== big) continue;
          const p = bladePlate(shop, horizon) as [number, number, number, number];
          if (front.some((b) => overlap(p, b))) continue;
          const inside = p[0] >= s0 && p[0] + p[2] <= s1;
          // Where it stands, then a big sign before the usual one; along the street, left to right, so of two as near the left one.
          const rank = 2 * (inside ? 0 : 1) + (big ? 0 : 1);
          const d = p[0] >= e1 ? p[0] - e1 : e0 - p[0];
          if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { x: shop.x, rank, d, big };
        }
    const b = best as { x: number; big: boolean };
    out.set(b.x, { kind, big: b.big });
  }
  return out;
}

/** `world`'s row in the zone of `amb` (rebuilt when the zone changes: it moves the landmarks). */
function memoOf(world: World, amb: Ambience | undefined): Memo {
  const hit = MEMO.get(world);
  if (hit && hit.zone === amb?.zone) return hit;
  const m: Memo = { zone: amb?.zone, st: settleOf(world, amb, feature(world, amb)), chunks: new Map() };
  MEMO.set(world, m);
  return m;
}

/**
 * Walk `world`'s settled shops reaching into world x ∈ [x0, x1), left to right (`visit` per shop). The
 * same World and zone always give the same shops, wherever the view is.
 */
export function forEachShop(world: World, amb: Ambience | undefined, x0: number, x1: number, visit: (shop: Shop) => void): void {
  const m = memoOf(world, amb);
  for (let c = Math.floor(x0 / CHUNK); c * CHUNK < x1; c++) for (const s of chunkOf(m, c).shops) if (s.x < x1 && s.x + s.w > x0) visit(s);
}

/** World y where the row's face begins at world x — the top of the shop standing there, or the street's top in an alley or the air. */
function faceAt(world: World, amb: Ambience | undefined, x: number): number {
  const m = memoOf(world, amb);
  const c = Math.floor(x / CHUNK);
  return m.st.horizon - chunkOf(m, c).heights[Math.floor(x) - c * CHUNK];
}

// ───────────────────────────── the art ─────────────────────────────

/**
 * A shop's silhouette: column runs [dx, w, up] solid from `up` px above the horizon down to it, bottom
 * up (a later run is never lower where it overlaps an earlier one). The art is painted inside it, and
 * `faceAt` is its top.
 */
function outline(s: Shop): [number, number, number][] {
  const body = GROUND + (s.storeys - 1) * STOREY;
  const out: [number, number, number][] = [[0, s.w, body]];
  if (s.roof === "grey" || s.roof === "blue") {
    for (let r = 0; r < HIP_ROWS; r += 2) out.push([r >> 1, s.w - 2 * (r >> 1), body + r + 2]);
    out.push([3, 2, body + HIP_ROWS + 1], [s.w - 5, 2, body + HIP_ROWS + 1]);
    return out;
  }
  const deck = body + PARAPET;
  out.push([0, s.w, deck]);
  const at = extraAt(s);
  if (s.roof === "tank") out.push([at, 12, deck + 2], [at + 1, 10, deck + 11], [at + 3, 6, deck + 12]);
  if (s.roof === "stair") out.push([at, 12, deck + 9]);
  if (s.roof === "board") out.push([at, boardW(s.board), deck + BOARD_FRAME + BOARD_H]);
  return out;
}

/** Where on a flat roof its tank, stair house or signboard stands (dx). */
function extraAt(s: Shop): number {
  const w = s.roof === "board" ? boardW(s.board) : 12;
  return 2 + ((s.seed >>> 22) % (s.w - w - 3));
}

/** A light: a world-px rect in shop coordinates, its colour and its alpha. */
type Light = [dx: number, dy: number, w: number, h: number, color: string, alpha: number];

/** A sign's lights: the back-lit plate and halo, its kana's tubes (one list a glyph) and its stutter seed. */
interface SignLights {
  plate: Light[];
  glyphs: { x: number; y: number; runs: Run[] }[];
  tube: string;
  /** A big sign's kana are drawn whole at every zoom. */
  big: boolean;
  seed: number;
}

/** A shop's art, compiled once: day rects [dx, dy, w, h, colour, detail] (dy up from the horizon is negative) and its lights. */
interface Art {
  rects: number[];
  front: Light[];
  windows: { r: [number, number, number, number]; t: number; cool: boolean }[];
  signs: SignLights[];
}

/** Compile `s`'s art (see the file comment for the composition). */
function compile(s: Shop): Art {
  const rects: number[] = [];
  const art: Art = { rects, front: [], windows: [], signs: [] };
  const put = (dx: number, dy: number, w: number, h: number, c: Col, lod: number) => rects.push(dx, dy, w, h, IDX[c], lod);
  const k = KINDS[s.kind];
  const W = s.w;
  const body = GROUND + (s.storeys - 1) * STOREY;
  // The silhouette's body: the upper walls, and the party wall on its left.
  put(0, -body, W, body, WALLS[(s.seed >>> 25) % WALLS.length], ALL);
  put(0, -body, 1, body, "shade", DETAIL);
  // The blade sign's plate, and the strip of the front it hangs over.
  const plate = bladePlate(s, 0);
  const pw = plate ? plate[2] : 0;
  const [a, b] = s.signLeft ? [pw + 2, W - 2] : [2, W - pw - 2];
  roof(s, put, body);
  for (let f = 1; f < s.storeys; f++) floor(s, put, art, -GROUND - f * STOREY, plate);
  // A drain pipe down one side of some, from the gutter to the eave.
  if ((s.seed >>> 27) % 3 === 0) put(s.signLeft ? W - 2 : 1, -body, 1, body - GROUND, "pipe", DETAIL);
  shopFront(s, k, put, art, a, b);
  if (plate) sign(put, art, s.word as string, plate[0] - s.x, plate[1], true, s.big ? 2 : 1, hash(s.x, 1, 433));
  if (s.roof === "board") sign(put, art, s.board, extraAt(s), -body - PARAPET - BOARD_FRAME - BOARD_H, false, 1, hash(s.x, 2, 433));
  return art;
}

type Put = (dx: number, dy: number, w: number, h: number, c: Col, lod: number) => void;

/** The roof over a body `body` px tall: kawara in four courses narrowing up to a dark ridge, or a flat roof's parapet and what stands on it. */
function roof(s: Shop, put: Put, body: number): void {
  const W = s.w;
  if (s.roof === "grey" || s.roof === "blue") {
    const tones: readonly Col[] =
      s.roof === "grey" ? ["tileGrey", "tileGreyAlt", "tileGrey", "ridge"] : ["tileBlue", "tileBlueAlt", "tileBlue", "ridge"];
    for (let r = 0; r < HIP_ROWS; r += 2) {
      const i = r >> 1;
      put(i, -body - r - 2, W - 2 * i, 2, tones[i], ALL);
      if (i < 3) put(i, -body - r - 2, W - 2 * i, 1, "eaveLight", FINE);
    }
    put(0, -body - 1, W, 1, "eaveDrip", FINE);
    put(3, -body - HIP_ROWS - 1, 2, 1, "ridge", ALL);
    put(W - 5, -body - HIP_ROWS - 1, 2, 1, "ridge", ALL);
    return;
  }
  const deck = body + PARAPET;
  put(0, -deck, W, PARAPET, "parapet", ALL);
  put(0, -deck, W, 1, "coping", DETAIL);
  const at = extraAt(s);
  if (s.roof === "tank") {
    put(at, -deck - 2, 12, 2, "steel", ALL);
    put(at + 1, -deck - 11, 10, 9, "tank", ALL);
    put(at + 3, -deck - 12, 6, 1, "tankLine", ALL);
    put(at + 4, -deck - 10, 1, 8, "tankLine", FINE);
    put(at + 7, -deck - 10, 1, 8, "tankLine", FINE);
    put(at + 1, -deck - 7, 10, 1, "tankLine", FINE);
  }
  if (s.roof === "stair") {
    put(at, -deck - 9, 12, 9, "stair", ALL);
    put(at, -deck - 9, 12, 1, "steel", DETAIL);
    put(at + 7, -deck - 7, 3, 7, "stairDoor", DETAIL);
  }
  if (s.roof === "board") put(at, -deck - BOARD_FRAME, boardW(s.board), BOARD_FRAME, "steel", ALL);
}

/**
 * An upper floor whose top is at `y0` (from the horizon): its windows (clear glass, some curtained, or
 * frosted) under little hoods and clear of the sign's plate, then a balcony — an AC unit, a pot plant or
 * the washing — or an AC unit on the wall.
 */
function floor(s: Shop, put: Put, art: Art, y0: number, plate: number[] | null): void {
  const W = s.w;
  // The plate covers its strip of this floor when it reaches up into the window band.
  const blocked = plate !== null && plate[1] < y0 + 8 + WIN_H;
  const a = blocked && s.signLeft ? plate[2] + 3 : 3;
  const b = blocked && !s.signLeft ? W - plate[2] - 3 : W - 3;
  const span = b - a;
  const n = Math.max(1, Math.min(3, Math.floor((span + 4) / 16)));
  const gap = (span - n * WIN_W) / (n + 1);
  const h = hash(s.x, y0, 419);
  const frosted = (s.seed >>> 18) % 3 === 0;
  const vacant = (h >>> 16) % 4 === 0;
  put(0, y0 + STOREY - 2, W, 2, "shade", DETAIL);
  const balcony = span >= 24 && h % 2 === 0;
  for (let i = 0; i < n; i++) {
    const wx = Math.round(a + gap * (i + 1) + WIN_W * i);
    put(wx - 1, y0 + 7, WIN_W + 2, 1, "shade", FINE);
    put(wx, y0 + 8, WIN_W, WIN_H, "frame", ALL);
    put(wx + 1, y0 + 9, WIN_W - 2, WIN_H - 2, frosted ? "frosted" : "glass", ALL);
    if (frosted) put(wx + 1, y0 + 13, WIN_W - 2, 1, "frame", DETAIL);
    else put(wx + 1, y0 + 9, WIN_W - 2, 3, "glassLight", DETAIL);
    if (!frosted && (h >>> (4 + i)) % 3 === 0) put(wx + 1, y0 + 9, 3, WIN_H - 2, "curtain", DETAIL);
    put(wx + 4, y0 + 9, 1, WIN_H - 2, "frame", DETAIL);
    put(wx - 1, y0 + 8 + WIN_H, WIN_W + 2, 1, "coping", FINE);
    const wh = hash(s.x + wx, y0, 421);
    // A floor in four stands vacant: never lit.
    if (!vacant) art.windows.push({ r: [wx + 1, y0 + 9, WIN_W - 2, WIN_H - 2], t: (wh % 1000) / 1000, cool: (wh >>> 10) % 4 === 0 });
    if (!balcony && i === 0 && (h >>> 8) % 2 === 0) {
      put(wx + 1, y0 + 23, 7, 5, "ac", DETAIL);
      put(wx + 2, y0 + 24, 3, 3, "acFan", DETAIL);
    }
  }
  if (!balcony) return;
  // A balcony across the floor: an AC unit at one end, a pot plant or the washing out.
  const ac = (h >>> 12) % 2 === 0 ? a + 1 : b - 9;
  put(ac, y0 + 14, 8, 7, "ac", DETAIL);
  put(ac + 1, y0 + 15, 4, 4, "acFan", DETAIL);
  if ((h >>> 14) % 2 === 0) {
    const lx = ac === a + 1 ? a + 11 : a + 2;
    put(lx, y0 + 11, Math.min(14, span - 12), 1, "laundryPole", DETAIL);
    put(lx + 1, y0 + 12, 3, 7, "laundryA", DETAIL);
    put(lx + 5, y0 + 12, 3, 6, "laundryB", DETAIL);
    put(lx + 9, y0 + 12, 3, 7, "laundryC", FINE);
  } else {
    const px = ac === a + 1 ? b - 6 : a + 2;
    put(px, y0 + 15, 4, 5, "plant", DETAIL);
    put(px + 1, y0 + 14, 2, 2, "plantLight", FINE);
  }
  put(a, y0 + 20, span, 7, "balcony", ALL);
  put(a, y0 + 19, span, 1, "rail", DETAIL);
  put(a, y0 + 27, span, 1, "shade", FINE);
}

/**
 * The ground floor, its door and noren between dx `a` and `b`: a tiled eave (or the kind's striped
 * awning) over a wooden front between two posts, a sliding door of paper (or glass) panes with a
 * lattice and a kick panel, the noren split into flaps on its rod, lanterns either side where there is
 * room — and under one a menu board, a pot plant or a stack of crates — and a display window beyond.
 */
function shopFront(s: Shop, k: KindStyle, put: Put, art: Art, a: number, b: number): void {
  const W = s.w;
  const top = -GROUND;
  put(0, top + 4, W, GROUND - 4, k.front, ALL);
  put(0, top + 4, 2, GROUND - 4, "post", DETAIL);
  put(W - 2, top + 4, 2, GROUND - 4, "post", DETAIL);
  // The eave: a strip of kawara, or the kind's striped awning.
  if (k.awning) {
    put(0, top, W, 5, k.awning, ALL);
    for (let x = 2; x < W; x += 4) put(x, top, 2, 4, "awningCream", DETAIL);
    art.front.push([0, top, W, 5, LIT.spill, 0.2]);
  } else {
    put(0, top, W, 4, "eave", ALL);
    put(0, top, W, 1, "eaveLight", DETAIL);
    put(0, top + 3, W, 1, "eaveDrip", FINE);
  }
  art.front.push([2, top + 4, W - 4, 2, LIT.spill, 0.25]);
  // The door, a little off the middle of the front.
  const room = b - a;
  const dw = room >= 34 ? 16 : room >= 24 ? 12 : Math.max(6, room - 4);
  const dx = a + Math.floor((room - dw) / 2) + ((s.seed >>> 26) % 2 === 0 ? 0 : Math.min(2, Math.floor((room - dw) / 2)));
  const half = dw >> 1;
  put(dx, -DOOR_H, dw, DOOR_H, "doorFrame", ALL);
  put(dx + 1, -DOOR_H + 1, dw - 2, DOOR_H - 5, k.door === "paper" ? "paper" : "glassDoor", ALL);
  put(dx + half, -DOOR_H + 1, 1, DOOR_H - 5, "doorFrame", DETAIL);
  if (k.door === "paper") {
    put(dx + 1, -12, dw - 2, 1, "doorFrame", DETAIL);
    put(dx + (half >> 1), -DOOR_H + 1, 1, DOOR_H - 5, "doorFrame", FINE);
    put(dx + half + (half >> 1), -DOOR_H + 1, 1, DOOR_H - 5, "doorFrame", FINE);
    // At night each leaf glows above and below its middle bar.
    art.front.push(
      [dx + 1, -DOOR_H + 1, half - 1, 7, LIT.paper, 0.7],
      [dx + half + 1, -DOOR_H + 1, dw - half - 2, 7, LIT.paper, 0.7],
      [dx + 1, -11, half - 1, 7, LIT.paper, 0.7],
      [dx + half + 1, -11, dw - half - 2, 7, LIT.paper, 0.7],
    );
  } else {
    put(dx + half - 2, -12, 1, 4, "frame", FINE);
    art.front.push(
      [dx + 1, -DOOR_H + 1, half - 1, DOOR_H - 5, LIT.glassDoor, 0.65],
      [dx + half + 1, -DOOR_H + 1, dw - half - 2, DOOR_H - 5, LIT.glassDoor, 0.65],
    );
  }
  // The noren: hung on a rod over the door, split into flaps.
  const nx = Math.max(a, dx - 1);
  const nw = Math.min(b, dx + dw + 1) - nx;
  if (k.noren) {
    const flaps = nw >= 14 ? 3 : 2;
    put(nx, top + 4, nw, 11, k.noren, ALL);
    put(nx, top + 4, nw, 1, "norenRod", DETAIL);
    art.front.push([nx, top + 5, nw, 10, k.norenLit, 0.6]);
    for (let f = 1; f < flaps; f++) {
      const fx = nx + Math.round((f * nw) / flaps);
      put(fx, top + 7, 1, 8, "doorFrame", DETAIL);
      art.front.push([fx, top + 7, 1, 8, LIT.slit, 0.6]);
    }
  }
  // Lanterns either side of the door where there is room, a little something under one, and a display window beyond.
  if (k.lantern === "row") {
    // A string of small red lanterns along the eave, in front of the noren's rod too.
    for (let x = a; x + 3 <= b; x += 5) {
      put(x, top + 4, 3, 5, "lantern", DETAIL);
      put(x, top + 4, 3, 1, "lanternCap", FINE);
      art.front.push([x, top + 5, 3, 4, LIT.lantern, 0.8]);
    }
  }
  const sides = [
    [nx - a, nx - 6, dx - 8],
    [b - nx - nw, nx + nw, dx + dw + 8],
  ] as const;
  sides.forEach(([space, lx, wx], i) => {
    if (space < 6) return;
    if (k.lantern === "red" || k.lantern === "white") lantern(put, art, lx, k.lantern === "white");
    if (i === (s.seed >>> 28) % 2) stoop(put, lx, (s.seed >>> 29) % 3, k.lantern === "row");
    if (space < 18) return;
    const ww = Math.min(12, space - 8);
    const x = i === 0 ? wx - ww : wx;
    put(x, -17, ww, 11, "doorFrame", ALL);
    put(x + 1, -16, ww - 2, 9, "display", ALL);
    put(x + 2, -10, ww - 4, 2, "food", FINE);
    art.front.push([x + 1, -16, ww - 2, 9, LIT.glassDoor, 0.6]);
  });
}

/** Under a lantern at dx `x`, on the street: a menu board, a pot plant or (at an izakaya, always) a stack of beer crates. */
function stoop(put: Put, x: number, roll: number, izakaya: boolean): void {
  if (izakaya || roll === 0) {
    put(x, -8, 6, 8, "crate", DETAIL);
    put(x, -5, 6, 1, "crateDark", FINE);
    put(x, -2, 6, 1, "crateDark", FINE);
  } else if (roll === 1) {
    put(x, -10, 6, 8, "board", DETAIL);
    put(x + 1, -8, 4, 1, "chalk", FINE);
    put(x + 1, -6, 3, 1, "chalk", FINE);
    put(x, -2, 1, 2, "doorFrame", DETAIL);
    put(x + 5, -2, 1, 2, "doorFrame", DETAIL);
  } else {
    put(x + 1, -4, 4, 4, "pot", DETAIL);
    put(x, -10, 6, 6, "plant", DETAIL);
    put(x + 1, -11, 3, 2, "plantLight", FINE);
  }
}

/** A paper chōchin hung from the eave at dx `x`: caps, a round body, a highlight and a rib — red, or white with a black band. */
function lantern(put: Put, art: Art, x: number, white: boolean): void {
  const y = -GROUND + 4;
  put(x + 1, y, 4, 1, "lanternCap", DETAIL);
  put(x, y + 1, 6, 7, white ? "lanternWhite" : "lantern", ALL);
  put(x + 1, y + 8, 4, 1, "lanternCap", DETAIL);
  put(x + 1, y + 2, 1, 5, white ? "norenWhite" : "lanternLight", DETAIL);
  put(x, y + 4, 6, 1, white ? "lanternCap" : "lanternDark", white ? DETAIL : FINE);
  art.front.push(
    [x - 1, y, 8, 9, white ? LIT.lanternWhiteHalo : LIT.lanternHalo, 0.1],
    [x, y + 1, 6, 7, white ? LIT.lanternWhite : LIT.lantern, 0.85],
    [x + 1, y + 2, 4, 5, white ? LIT.lanternWhiteCore : LIT.lanternCore, 0.7],
  );
}

/** A sign for `word` with its plate's top-left at (dx, dy): a rim, the plate, its kana — vertical (a blade sign) or across (a rooftop board). */
function sign(put: Put, art: Art, word: string, dx: number, dy: number, vertical: boolean, scale: number, seed: number): void {
  const style = SIGNS[word];
  const text = kanaText(word, vertical);
  const pad = vertical ? scale + 1 : BOARD_PAD;
  const w = text.w * scale + 2 * pad;
  const h = text.h * scale + 2 * pad;
  put(dx, dy, w, h, "rim", ALL);
  put(dx + 1, dy + 1, w - 2, h - 2, style.plate, ALL);
  // Glyph by glyph (a stuttering tube is one glyph): its cell, and its runs from the sign's origin.
  const glyphs = [...word].map((ch, i) => {
    const x = dx + pad + (vertical ? 0 : i * (KANA_W + 1) * scale);
    const y = dy + pad + (vertical ? i * (KANA_H + 1) * scale : 0);
    // Zoomed out a small sign's kana is a block a glyph; a big one's still reads.
    if (scale === 1) put(x + 1, y + 1, KANA_W - 2, KANA_H - 2, style.text, COARSE);
    const runs = kanaText(ch, vertical).runs.map(([rx, ry, rw, rh]): Run => [x + rx * scale, y + ry * scale, rw * scale, rh * scale]);
    for (const [rx, ry, rw, rh] of runs) put(rx, ry, rw, rh, style.text, scale === 1 ? DETAIL : ALL);
    return { x, y, runs };
  });
  // Back-lit; a halo only round the featured big signs, the focal points (the calm pass).
  const glow: Light = [dx + 1, dy + 1, w - 2, h - 2, style.glow, scale > 1 ? 0.85 : 0.6];
  art.signs.push({
    plate: scale > 1 ? [[dx - 2, dy - 1, w + 4, h + 2, style.glow, 0.14], [dx - 1, dy - 3, w + 2, h + 6, style.glow, 0.08], glow] : [glow],
    glyphs,
    tube: style.tube,
    big: scale > 1,
    seed,
  });
}

/** `shop`'s art, compiled on first use. */
function artOf(shop: Shop): Art {
  return (shop.art ??= compile(shop));
}

// ───────────────────────────── painting ─────────────────────────────

/** The level of detail at `zoom`. */
const lodAt = (zoom: number): number => (zoom >= FINE_ZOOM ? FINE : zoom >= PANE_ZOOM ? PANE : COARSE);

/** Is the row's band — `MAX_H` above the street, down to it — on screen? */
function inView(s: BackdropScene): boolean {
  return sy(s.cam, s.horizon) > 0 && sy(s.cam, s.horizon - MAX_H) < s.view.h;
}

/** Fill a world-px rect in the current fillStyle, edges snapped like `rect` (render/paint.ts) — nothing when it is off the view. */
function fill(ctx: BackdropScene["ctx"], cam: Camera, view: { w: number; h: number }, wx: number, wy: number, w: number, h: number): void {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  const pw = Math.max(1, sx(cam, wx + w) - x);
  const ph = Math.max(1, sy(cam, wy + h) - y);
  if (x + pw <= 0 || y + ph <= 0 || x >= view.w || y >= view.h) return;
  ctx.fillRect(x, y, pw, ph);
}

/** Is a world-px rect on the view? (A light off it is not handed to `fillLit` at all.) */
function seen(cam: Camera, view: { w: number; h: number }, wx: number, wy: number, w: number, h: number): boolean {
  const x = sx(cam, wx);
  const y = sy(cam, wy);
  return x + Math.max(1, sx(cam, wx + w) - x) > 0 && y + Math.max(1, sy(cam, wy + h) - y) > 0 && x < view.w && y < view.h;
}

/** The day pass: every shop in view, its rects of this zoom's detail, in the weather's hazed colours. */
function paint(s: BackdropScene): void {
  if (!inView(s)) return;
  const { ctx, cam, view, horizon } = s;
  const pal = shopPalette(s.amb?.weather ?? "clear");
  const lod = lodAt(cam.zoom);
  ctx.globalAlpha = 1;
  let last = -1;
  forEachShop(s.world, s.amb, s.x0, s.x1, (shop) => {
    const r = artOf(shop).rects;
    for (let i = 0; i < r.length; i += 6) {
      if ((r[i + 5] & lod) === 0) continue;
      if (r[i + 4] !== last) {
        last = r[i + 4];
        ctx.fillStyle = pal[last];
      }
      fill(ctx, cam, view, shop.x + r[i], horizon + r[i + 1], r[i + 2], r[i + 3]);
    }
  });
}

/** The share of the rooms upstairs lit when `lit` of the far skyline's windows are: 28 % at full night, a floor in four vacant. */
const ROOMS_LIT = 0.7;

/**
 * The night pass: the shop fronts, lanterns and signs at `neonStrength`, the upstairs windows by their
 * thresholds — every light through `s.fillLit`, and none by day.
 */
function paintLights(s: BackdropLightScene): void {
  const k = neonStrength(s.amb);
  const share = Math.min(1, s.lit * ROOMS_LIT);
  if ((k <= 0 && share <= 0) || !inView(s)) return;
  const { ctx, cam, view, horizon } = s;
  const glyphs = cam.zoom >= PANE_ZOOM;
  const light = (shop: Shop, [dx, dy, w, h, color, alpha]: Light, strength: number) => {
    if (!seen(cam, view, shop.x + dx, horizon + dy, w, h)) return;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * strength;
    s.fillLit(shop.x + dx, horizon + dy, w, h);
  };
  const lightShop = (shop: Shop) => {
    const art = artOf(shop);
    for (const win of art.windows) if (win.t < share) light(shop, [...win.r, win.cool ? LIT.windowCool : LIT.window, 0.75], 1);
    if (k <= 0) return;
    for (const f of art.front) light(shop, f, k);
    for (const sg of art.signs) {
      for (const p of sg.plate) light(shop, p, k);
      const out = neonFlicker(sg.seed, s.timeMs, sg.glyphs.length);
      sg.glyphs.forEach((g, i) => {
        if (i === out) return;
        if (!glyphs && !sg.big) light(shop, [g.x + 1, g.y + 1, KANA_W - 2, KANA_H - 2, sg.tube, 1], k);
        else for (const [rx, ry, rw, rh] of g.runs) light(shop, [rx, ry, rw, rh, sg.tube, 1], k);
      });
    }
  };
  forEachShop(s.world, s.amb, s.x0, s.x1, lightShop);
  ctx.globalAlpha = 1;
}

/**
 * The front of the City's backdrop in Tokyo (render/backdrop.ts): a MID layer — clusters of yokochō food
 * shops in front of the haze and the neon canyon, behind the temples and the world, open sky between
 * them, their lanterns, noren and kana signs glowing at night.
 */
export const SHOPS: BackdropLayer = {
  paint,
  paintLights,
  faceAt: (s, x) => faceAt(s.world, s.amb, x),
};
