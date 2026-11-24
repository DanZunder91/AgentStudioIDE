/**
 * Where things are in the Agent Village / City canvas — for the close-up stills of things that are
 * ONLY pixels and have no product position hook (a project's house, a City floor, the plaza, the
 * skyline, the Seats lounge, a lift), for the STRUCTURE behind each still (who sits where, which props
 * stand where, which building carries which language), and for the moments of the City's COMMUTE
 * (a sub-agent riding a lift, crossing the street — engine/commute.ts). (The capacity buildings, the
 * neon signs and the landmarks' crowns have product hooks — the canvas's `data-capacity-boxes`,
 * `data-neon-boxes` and `data-landmark-boxes`; the spec reads the first itself, and the scene carries
 * the other two, read after the app has painted a frame so they match the camera the scene reports.)
 *
 * How: READ-ONLY, through React's own fiber link on the canvas element (`__reactFiber$…`, present in
 * production builds too): up to the `VillagePanel` component, whose `useState` holds the two
 * `VillageView`s (`{ village, city }`), recognised by shape (`city.capacityBoxes` is a function), not by
 * a minified name. From the live view it reads the public getters `world`, `camera`, `ambience`, the
 * sim's clock (`sim.time`) and `sim.seatFor(key)`; and two things that are private in TypeScript but
 * plain properties at run time: the view's last frame of characters (`VillageView.chars`, the
 * `CharacterView`s the renderer drew) and a commuter's trip in the sim (`VillageSim.chars` → its
 * `state` and `trip` — `Route` + `Cursor`, engine/commute.ts), which is what times a commute still.
 * Tiles are projected to canvas CSS px with the camera's own formula (`render/camera.ts`
 * `worldToScreen`). Nothing is called that changes state.
 *
 * The code that runs in the page is installed ONCE as `window.__e2eVillage` (see {@link install}): the
 * scene, a background TRACKER of one newcomer's places (every frame, so a 0.4 s crossing is never
 * missed between two WebDriver round trips) and in-page WAITS that check their condition on every
 * animation frame. It only reads.
 *
 * This is test-side knowledge of the app's internals, so it is confined to this file. If a product hook
 * for these positions ever lands (a `data-…-boxes` like the capacity one), switch to it.
 */

import { browser } from "@wdio/globals";

/** A box in CSS px, relative to the canvas's top-left — NOT clipped to the canvas. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rect in world TILES. */
export interface Rect {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface SceneHouse {
  /** Village: the folder. City: the floor's key (`floor:<leader key>`), or a capacity house's (`cap/seats`…). */
  key: string;
  label: string;
  /** Set on a capacity house / HQ floor / the city's Seats lounge. */
  capacity: string | null;
  /** Its interior, tiles (`House` col/row/w/h). */
  rect: Rect;
  /** Walls (and, in the village, the name board and the step outside) included — the hover box's rule. */
  box: Box;
  /** Seats in the house; `teamSeats` = the team-table seats (sub-agents only). */
  seats: number;
  teamSeats: number;
  /** The team seats' chair rows, top first: the tile row and how many team seats are on it. */
  chairRows: { row: number; seats: number }[];
  /** How many distinct columns the team seats take. */
  teamCols: number;
  /** Prop kind → how many stand inside `box`. */
  props: Record<string, number>;
}

/** A lift shaft (`CityLift`), tiles — plus where its column is on screen. */
export interface SceneLift {
  col: number;
  top: number;
  bottom: number;
  stops: number[];
  /** The shaft, `top`..`bottom` on its column, CSS px. */
  box: Box;
}

export interface SceneBuilding {
  /** The folder (or the HQ's key). */
  key: string;
  floors: string[];
  hq: boolean;
  /** Its outer rect (walls included), tiles. */
  rect: Rect;
  box: Box;
  /** Its street door's column (tiles). */
  doorCol: number;
  /** `CityBuilding.language` — what its neon sign says; null when none is known (and on the HQ). */
  language: string | null;
  /** Its lift (a building with a team has one), or null. */
  lift: SceneLift | null;
}

/** The city's Seats lounge under the street (`CityLounge` + its house). */
export interface SceneLounge {
  key: string;
  /** Its interior (`House`), tiles: `row` is its back-wall row. */
  rect: Rect;
  /** Walls and the soil row above (where its board hangs) included — its `data-capacity-boxes` box. */
  box: Box;
  /** Its bench seats (`bench` props), by seat number. */
  benches: { index: number; col: number; row: number }[];
  lift: SceneLift;
  /** The lift's kiosk on the far sidewalk (`lift` prop), or null. */
  kiosk: { col: number; row: number } | null;
}

/**
 * Where a character is, by the City's geography (the commute's stages — engine/commute.ts):
 * `bench` (seated in the lounge), `lounge` (on foot in it), `lounge-lift` (riding it), `far-sidewalk`,
 * `crossing` (on the road at the lounge lift's column), `road` (on the road anywhere else — a commuter
 * never is), `near-sidewalk`, `lift:<building>` (riding that building's lift), `door:<building>`,
 * `floor:<floor key>` (on foot on a floor), `desk:<floor key>` (seated on it), `hq`, `outside`; in the
 * village always `village`.
 */
export type Place = string;

export interface SceneChar {
  key: string;
  label: string;
  sub: boolean;
  activity: string;
  seated: boolean;
  riding: boolean;
  fx: string | null;
  place: Place;
  /** The tile it stands on (its feet), rounded. */
  col: number;
  row: number;
  /** Its feet, canvas CSS px. */
  feet: { x: number; y: number };
  /** The seat it holds (`VillageSim.seatFor`): its desk, or null. */
  seat: { col: number; row: number; houseKey: string } | null;
}

export interface SceneCity {
  buildings: SceneBuilding[];
  /** The canvas y where the (first) street meets the sky. */
  horizon: number;
  /** `CityInfo.street`: the near sidewalk's row; the road is the next two, the far sidewalk the one after. */
  street: number;
  /** The whole world, CSS px. */
  world: Box;
  lounge: SceneLounge | null;
  /** The subway under the lounge (`CitySubway`), tiles — and its tunnel band on screen. Null without a lounge. */
  subway: {
    top: number;
    bottom: number;
    rail: number;
    station: { col0: number; col1: number };
    entrance: { col: number; row: number };
    /** The tunnel (ceiling to track bed) across the world, CSS px. */
    box: Box;
  } | null;
}

/**
 * The City's street life over a stretch of REAL frames (`watchLife`): what the traffic (`TrafficFx`) and
 * the passers-by (`StreetLife`) put on screen — decoration, never agents. Counted only while on screen
 * (within the camera's span).
 */
export interface LifeWatch {
  frames: number;
  /** Distinct passers-by seen (their serial ids) and the most at once. */
  walkers: number;
  maxWalkers: number;
  /** Distinct vehicles seen (their own hashes) and the most at once, and their kinds. */
  vehicles: number;
  maxVehicles: number;
  kinds: string[];
  /** Distinct passers-by seen under an OPEN umbrella (≥ 0.9 open), and under any umbrella at all (> 0). */
  umbrellasOpen: number;
  umbrellasAny: number;
  /** Distinct passers-by seen going down / coming up the subway stairs, and buying a drink. */
  stairs: number;
  buying: number;
  /** How many sim characters (agents) there were at the start and at the end — street life never adds any. */
  agents: { first: number; last: number };
}

export interface Scene {
  mode: string;
  /** `Ambience.zone`: the IANA zone the picture was given (null = none). */
  zone: string | null;
  phase: string | null;
  zoom: number;
  /** CSS px per tile at this zoom (for growing a box by whole tiles). */
  tilePx: number;
  canvas: { left: number; top: number; width: number; height: number };
  /** The floating HUD's bottom edge, canvas-relative CSS px. */
  hudBottom: number;
  houses: SceneHouse[];
  /** Prop kind → count, over the whole world. */
  props: Record<string, number>;
  /** Where the props of the {@link LANDMARK_KINDS} stand (footprint, CSS px) — to frame a close-up on them. */
  landmarks: { kind: string; box: Box }[];
  /** Village only: the plaza square (its `plaza` tiles). */
  plaza: Box | null;
  city: SceneCity | null;
  /** Every character of the last frame. */
  chars: SceneChar[];
  /**
   * The neon signs DRAWN this frame — the canvas's `data-neon-boxes` (`VillageView.neonBoxes`, made
   * from the very draw items the renderer paints): building, language and the sign's box, clipped to
   * the canvas; a sign off screen is left out. Empty in the village.
   */
  neon: { building: string; language: string; box: Box }[];
  /**
   * The skyline landmarks' CROWNS on screen — the canvas's `data-landmark-boxes`
   * (`VillageView.landmarkBoxes`: the Skytree's and Tokyo Tower's tip down to their lowest deck, Fuji's
   * snow cap — the part no building may hide), clipped to the canvas; one off screen is left out. Only
   * a City in a zone with landmarks (Asia/Tokyo) has any.
   */
  crowns: { kind: string; box: Box }[];
}

/** Props whose positions the probe reports (few per world — not the trees or the desks). */
export const LANDMARK_KINDS = ["vending", "torii", "router", "switch", "fountain", "metro"] as const;

/** One step of a tracked character's day: where it was from `t` ms (after tracking started) on. */
export interface TrackEntry {
  t: number;
  place: Place;
  col: number;
  row: number;
  /** The sim's state for it (`bench`, `commute`, `type`…) and, travelling, its trip's leg and direction. */
  state: string | null;
  leg: number | null;
  dir: number | null;
  activity: string | null;
}

export interface Track {
  /** The tracked newcomer (the first sub-agent that was not there when tracking started), once seen. */
  key: string | null;
  label: string | null;
  /** Its places, one entry per change. */
  entries: TrackEntry[];
}

/**
 * What an in-page wait waits for (checked on EVERY animation frame):
 *   - `crowd`: at least `street` sub-agents out on the street at once (the far sidewalk, the
 *     crossing, the near sidewalk) — the stream, not only riders stacked in one lift shaft;
 *   - `settled`: every busy sub-agent seated at its desk (and at least one there);
 *   - `umbrella`: a passer-by under an open umbrella on screen (the City's street life, in the rain);
 *   - `place`: the character (`key`, default the tracked newcomer) is at a place starting with `place`;
 *   - `leg`: the character, travelling in direction `dir` (+1 to its desk, −1 back to its bench), is
 *     `leadS` seconds (wall clock, at the sim's measured pace) from the point `at` (0..1) along its
 *     trip's leg `leg` (engine/commute.ts: 2 = the lounge's lift, 3 = the crossing, 6 = its building's
 *     lift). A still taken right then lands ON that point: `leadS` is how long a still takes to be grabbed.
 */
export type WaitCond =
  | { kind: "crowd"; street: number }
  | { kind: "settled" }
  | { kind: "umbrella" }
  | { kind: "place"; key?: string; place: Place }
  | { kind: "leg"; key?: string; leg: number; at: number; dir: 1 | -1; leadS: number };

export interface WaitResult {
  ok: boolean;
  /** The character it was about (place / leg), as it was when the wait ended. */
  char: SceneChar | null;
  /** `leg`: the target point was already passed — `missed` when it is off that leg already. */
  late: boolean;
  missed: boolean;
  /** `leg`: seconds (wall) to the target point when it ended; negative = passed. */
  etaS: number | null;
  /** Sim seconds per wall second, as measured over the wait (≈ 1; less when frames are slow). */
  rate: number;
  /** What it last saw (a failed wait's evidence). */
  detail: string;
}

/** Bumped whenever the page code changes, so a stale install is replaced. */
const PROBE_VERSION = 5;

/**
 * The page side, installed as `window.__e2eVillage`. Runs IN THE PAGE (serialised by WebDriver):
 * self-contained, constants inlined.
 */
function install(version: number): void {
  type Obj = Record<string, unknown>;
  type Rct = { col: number; row: number; w: number; h: number };
  type HouseW = Rct & { key: string; label: string; doorRow: number; capacity?: string };
  type PropW = Rct & { kind: string; index?: number };
  type SeatW = { houseKey: string; col: number; row: number; forSub?: boolean };
  type LiftW = { col: number; top: number; bottom: number; stops: number[] };
  type BuildingW = Rct & { key: string; floors: string[]; hq?: boolean; doorCol: number; language?: string | null; lift?: LiftW };
  type WorldW = {
    cols: number;
    rows: number;
    tiles: string[];
    houses: HouseW[];
    props: PropW[];
    seats: SeatW[];
    city?: { street: number; buildings: BuildingW[]; lounge?: { key: string; lift: LiftW } };
  };
  type CharW = { key: string; x: number; y: number; seated: boolean; riding?: boolean; isSubagent: boolean; activity: string; label: string; fx: { kind: string } | null };
  type SimCharW = { state: string; trip: { route: { points: { col: number; row: number }[]; rides: boolean[] }; cur: { leg: number; d: number; dir: number } } | null };
  type SimW = { time: number; seatFor: (k: string) => SeatW | null; chars?: Map<string, SimCharW> };
  type ViewW = { world: WorldW; camera: { zoom: number; ox: number; oy: number }; ambience: { zone?: string; phase?: string } | null; chars?: CharW[]; sim: SimW };
  type Found = { view: ViewW; mode: string; canvas: HTMLCanvasElement };
  type W = Window & { __e2eVillage?: Obj & { version: number }; __e2eTrack?: Obj };

  const w = window as W;
  if (w.__e2eVillage?.version === version) return;

  /** `villageTypes.ts` TILE — world px per tile. */
  const TILE = 16;
  /** engine/sim.ts SIT_OFFSET — a seated character is drawn this many px lower. */
  const SIT = 6;
  /** engine/commute.ts COMMUTE_WALK / COMMUTE_RIDE — px per SIM second; only for timing stills. */
  const WALK = 120;
  const RIDE = 160;
  const ACTIVE = new Set(["typing", "reading", "thinking", "waiting"]);
  const ON_THE_WAY = (p: string) => p === "lounge-lift" || p === "far-sidewalk" || p === "crossing" || p === "road" || p === "near-sidewalk" || p.startsWith("lift:") || p.startsWith("door:");

  const find = (): Found | { error: string } => {
    const canvas = document.querySelector('[data-testid="village-canvas"]') as HTMLCanvasElement | null;
    const mode = document.querySelector('[data-testid="village-panel"]')?.getAttribute("data-mode") ?? "";
    if (!canvas) return { error: "no village canvas" };
    const fiberKey = Object.keys(canvas).find((k) => k.startsWith("__reactFiber$"));
    for (let f = fiberKey ? ((canvas as unknown as Obj)[fiberKey] as Obj | null) : null; f; f = f.return as Obj | null) {
      for (let h = f.memoizedState as Obj | null; h && typeof h === "object" && "next" in h; h = h.next as Obj | null) {
        const st = h.memoizedState as Obj | null;
        const city = st && typeof st === "object" ? (st.city as Obj | undefined) : undefined;
        if (city && st && st.village && typeof city.capacityBoxes === "function") return { view: st[mode] as ViewW, mode, canvas };
      }
    }
    return { error: `no VillageView behind the canvas (mode ${mode}, fiber key ${fiberKey ?? "none"})` };
  };

  /** World px → canvas CSS px (render/camera.ts worldToScreen, then ÷ DPR). */
  const projector = (f: Found) => {
    const cam = f.view.camera;
    const r = f.canvas.getBoundingClientRect();
    const dpr = r.width > 0 ? f.canvas.width / r.width : 1;
    const px = (wx: number, wy: number) => ({ x: (cam.ox + wx * cam.zoom) / dpr, y: (cam.oy + wy * cam.zoom) / dpr });
    /** Inclusive tile range → CSS box. */
    const tiles = (c0: number, r0: number, c1: number, r1: number) => {
      const a = px(c0 * TILE, r0 * TILE);
      const b = px((c1 + 1) * TILE, (r1 + 1) * TILE);
      return { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) };
    };
    return { px, tiles, dpr, rect: r };
  };

  /** Where a character is (see `Place` in village-scene.ts). */
  const placeOf = (c: CharW, world: WorldW): { place: string; col: number; row: number } => {
    const col = Math.round(c.x / TILE - 0.5);
    const row = Math.round((c.y - (c.seated ? SIT : 0)) / TILE - 1);
    const city = world.city;
    if (!city) return { place: "village", col, row };
    const lounge = city.lounge;
    const at = (place: string) => ({ place, col, row });
    const inside = (h: Rct) => col >= h.col && col < h.col + h.w && row >= h.row && row < h.row + h.h;
    if (c.riding) {
      if (lounge && col === lounge.lift.col && row >= city.street) return at("lounge-lift");
      const b = city.buildings.find((x) => x.lift && x.lift.col === col && row >= x.row && row < x.row + x.h);
      return at(b ? `lift:${b.key}` : "lift:?");
    }
    const S = city.street;
    if (row === S) return at("near-sidewalk");
    if (row === S + 1 || row === S + 2) return at(lounge && col === lounge.lift.col ? "crossing" : "road");
    if (row === S + 3) return at("far-sidewalk");
    const room = lounge ? world.houses.find((h) => h.key === lounge.key) : undefined;
    // The lounge's interior: its back-wall row down to the row above its floor wall.
    if (room && inside({ col: room.col, row: room.row, w: room.w, h: room.h })) return at(c.seated ? "bench" : "lounge");
    const floor = world.houses.find((h) => !h.capacity && inside(h));
    if (floor) return at(`${c.seated ? "desk" : "floor"}:${floor.key}`);
    if (world.houses.some((h) => h.capacity && inside(h))) return at("hq");
    const door = city.buildings.find((b) => row === b.row + b.h - 1 && col === b.doorCol);
    return at(door ? `door:${door.key}` : "outside");
  };

  const charsOf = (f: Found) => {
    const p = projector(f);
    return (f.view.chars ?? []).map((c) => {
      const where = placeOf(c, f.view.world);
      const seat = f.view.sim.seatFor(c.key);
      return {
        key: c.key,
        label: c.label,
        sub: c.isSubagent,
        activity: c.activity,
        seated: c.seated,
        riding: Boolean(c.riding),
        fx: c.fx ? c.fx.kind : null,
        place: where.place,
        col: where.col,
        row: where.row,
        feet: { x: Math.round(p.px(c.x, c.y).x), y: Math.round(p.px(c.x, c.y).y) },
        seat: seat ? { col: seat.col, row: seat.row, houseKey: seat.houseKey } : null,
      };
    });
  };

  /** Two animation frames: the app's loop has painted (and refreshed its `data-…-boxes`) since the call. */
  const painted = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  const scene = async (landmarkKinds: readonly string[]) => {
    await painted();
    const f = find();
    if ("error" in f) return f;
    const { world } = f.view;
    const cam = f.view.camera;
    const { tiles, px, rect: r, dpr } = projector(f);
    const hud = document.querySelector('[data-testid="village-hud"]')?.getBoundingClientRect();
    const isCity = Boolean(world.city);
    const count = (props: PropW[]) => {
      const out: Record<string, number> = {};
      for (const p of props) out[p.kind] = (out[p.kind] ?? 0) + 1;
      return out;
    };

    const houses = world.houses.map((h) => {
      // The same tile box `VillageView.capacityTiles` answers the pointer on.
      const t = isCity
        ? { c0: h.col, c1: h.col + h.w - 1, r0: h.row - 1, r1: h.row + h.h - 1 }
        : { c0: h.col - 1, c1: h.col + h.w, r0: h.row - 2, r1: h.doorRow + 1 };
      const inside = world.props.filter((p) => p.col >= t.c0 && p.col <= t.c1 && p.row >= t.r0 && p.row <= t.r1);
      const seats = world.seats.filter((s) => s.houseKey === h.key);
      const team = seats.filter((s) => s.forSub);
      const rows = new Map<number, number>();
      for (const s of team) rows.set(s.row, (rows.get(s.row) ?? 0) + 1);
      return {
        key: h.key,
        label: h.label,
        capacity: h.capacity ?? null,
        rect: { col: h.col, row: h.row, w: h.w, h: h.h },
        box: tiles(t.c0, t.r0, t.c1, t.r1),
        seats: seats.length,
        teamSeats: team.length,
        chairRows: [...rows].sort((a, b) => a[0] - b[0]).map(([row, n]) => ({ row, seats: n })),
        teamCols: new Set(team.map((s) => s.col)).size,
        props: count(inside),
      };
    });

    let plaza = null;
    if (!isCity) {
      let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
      world.tiles.forEach((k, i) => {
        if (k !== "plaza") return;
        const c = i % world.cols, rr = Math.floor(i / world.cols);
        c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, rr); r1 = Math.max(r1, rr);
      });
      if (c1 >= c0) plaza = tiles(c0, r0, c1, r1);
    }

    const lift = (l: LiftW) => ({ col: l.col, top: l.top, bottom: l.bottom, stops: [...l.stops], box: tiles(l.col, l.top, l.col, l.bottom) });
    let city = null;
    if (world.city) {
      const lw = world.city.lounge;
      const room = lw ? world.houses.find((h) => h.key === lw.key) : undefined;
      const kiosk = world.props.find((p) => p.kind === "lift");
      const sw = (world.city as { subway?: { top: number; bottom: number; rail: number; station: { col0: number; col1: number }; entrance: { col: number; row: number } } }).subway;
      city = {
        subway: sw
          ? { top: sw.top, bottom: sw.bottom, rail: sw.rail, station: { ...sw.station }, entrance: { ...sw.entrance }, box: tiles(0, sw.top, world.cols - 1, sw.bottom) }
          : null,
        buildings: world.city.buildings.map((b) => ({
          key: b.key,
          floors: b.floors,
          hq: Boolean(b.hq),
          rect: { col: b.col, row: b.row, w: b.w, h: b.h },
          box: tiles(b.col, b.row, b.col + b.w - 1, b.row + b.h - 1),
          doorCol: b.doorCol,
          language: b.language ?? null,
          lift: b.lift ? lift(b.lift) : null,
        })),
        horizon: Math.round(px(0, world.city.street * TILE).y),
        street: world.city.street,
        world: tiles(0, 0, world.cols - 1, world.rows - 1),
        lounge:
          lw && room
            ? {
                key: lw.key,
                rect: { col: room.col, row: room.row, w: room.w, h: room.h },
                box: tiles(room.col, room.row - 1, room.col + room.w - 1, room.row + room.h - 1),
                benches: world.props
                  .filter((p) => p.kind === "bench")
                  .map((p) => ({ index: p.index ?? -1, col: p.col, row: p.row }))
                  .sort((a, b) => a.index - b.index),
                lift: lift(lw.lift),
                kiosk: kiosk ? { col: kiosk.col, row: kiosk.row } : null,
              }
            : null,
      };
    }
    const landmarks = world.props
      .filter((p) => landmarkKinds.includes(p.kind))
      .map((p) => ({ kind: p.kind, box: tiles(p.col, p.row, p.col + p.w - 1, p.row + p.h - 1) }));

    return {
      mode: f.mode,
      zone: f.view.ambience?.zone ?? null,
      phase: f.view.ambience?.phase ?? null,
      zoom: cam.zoom,
      tilePx: (TILE * cam.zoom) / dpr,
      canvas: { left: r.left, top: r.top, width: r.width, height: r.height },
      hudBottom: hud ? hud.bottom - r.top : 0,
      houses,
      props: count(world.props),
      landmarks,
      plaza,
      city,
      chars: charsOf(f),
      neon: (JSON.parse(f.canvas.getAttribute("data-neon-boxes") ?? "[]") as { building: string; language: string; x: number; y: number; w: number; h: number }[]).map(
        (n) => ({ building: n.building, language: n.language, box: { x: n.x, y: n.y, w: n.w, h: n.h } }),
      ),
      crowns: (JSON.parse(f.canvas.getAttribute("data-landmark-boxes") ?? "[]") as { kind: string; x: number; y: number; w: number; h: number }[]).map(
        (c) => ({ kind: c.kind, box: { x: c.x, y: c.y, w: c.w, h: c.h } }),
      ),
    };
  };

  /** The tracker: the first sub-agent that was not on screen when it started, its place every frame. */
  const track = () => {
    const f = find();
    const before = new Set("error" in f ? [] : (f.view.chars ?? []).map((c) => c.key));
    const T = { key: null as string | null, label: null as string | null, entries: [] as Obj[], started: performance.now(), stop: false };
    w.__e2eTrack = T;
    const step = () => {
      if (T.stop || w.__e2eTrack !== T) return;
      const g = find();
      if (!("error" in g) && g.view.world.city) {
        const chars = g.view.chars ?? [];
        if (!T.key) {
          const n = chars.find((c) => c.isSubagent && !before.has(c.key));
          if (n) {
            T.key = n.key;
            T.label = n.label;
          }
        }
        if (T.key) {
          const c = chars.find((x) => x.key === T.key);
          const sc = g.view.sim.chars?.get(T.key as string);
          const p = c ? placeOf(c, g.view.world) : { place: "gone", col: -1, row: -1 };
          const last = T.entries[T.entries.length - 1] as { place: string } | undefined;
          if (!last || last.place !== p.place)
            T.entries.push({
              t: Math.round(performance.now() - T.started),
              place: p.place,
              col: p.col,
              row: p.row,
              state: sc?.state ?? null,
              leg: sc?.trip ? sc.trip.cur.leg : null,
              dir: sc?.trip ? sc.trip.cur.dir : null,
              activity: c?.activity ?? null,
            });
          if (T.entries.length >= 400) T.stop = true;
        }
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const trackLog = () => {
    const T = w.__e2eTrack as { key: string | null; label: string | null; entries: Obj[] } | undefined;
    return T ? { key: T.key, label: T.label, entries: T.entries } : { key: null, label: null, entries: [] };
  };

  const stopTrack = () => {
    const T = w.__e2eTrack as { stop: boolean } | undefined;
    if (T) T.stop = true;
  };

  type Cond =
    | { kind: "crowd"; street: number }
    | { kind: "settled" }
    | { kind: "umbrella" }
    | { kind: "place"; key?: string; place: string }
    | { kind: "leg"; key?: string; leg: number; at: number; dir: number; leadS: number };

  /** Seconds (SIM time) to travel between arc positions `a` and `b` of a route, at each leg's speed. */
  const between = (lens: number[], rides: boolean[], a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let t = 0;
    let acc = 0;
    lens.forEach((len, l) => {
      const overlap = Math.max(0, Math.min(hi, acc + len) - Math.max(lo, acc));
      t += overlap / (rides[l] ? RIDE : WALK);
      acc += len;
    });
    return t;
  };

  const wait = (cond: Cond, timeoutMs: number) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      let sample: { wall: number; sim: number } | null = null;
      let rate = 1;
      let detail = "";
      const done = (ok: boolean, f: Found | null, key: string | null, extra: Obj = {}) => {
        const char = f && key ? (charsOf(f).find((c) => c.key === key) ?? null) : null;
        resolve({ ok, char, late: false, missed: false, etaS: null, rate, detail, ...extra });
      };
      const step = () => {
        const f = find();
        if ("error" in f) {
          detail = f.error;
        } else {
          const now = performance.now();
          if (!sample) sample = { wall: now, sim: f.view.sim.time };
          else if (now - sample.wall > 250) rate = (f.view.sim.time - sample.sim) / ((now - sample.wall) / 1000);
          // A place / leg wait is about `cond.key`, or (absent — JSON drops it) the tracked newcomer.
          const key = cond.kind === "place" || cond.kind === "leg" ? (cond.key ?? (w.__e2eTrack?.key as string | null | undefined) ?? null) : null;
          const chars = charsOf(f);
          if (cond.kind === "crowd") {
            const going = chars.filter((c) => c.sub && ON_THE_WAY(c.place));
            const out = going.filter((c) => c.place === "far-sidewalk" || c.place === "crossing" || c.place === "near-sidewalk").length;
            const where = new Map<string, number>();
            for (const c of going) where.set(c.place, (where.get(c.place) ?? 0) + 1);
            detail = `${going.length} on their way, ${out} on the street: ${JSON.stringify(Object.fromEntries(where))}`;
            if (out >= cond.street) return done(true, f, null);
          } else if (cond.kind === "umbrella") {
            const v = f.view as unknown as { camera: { ox: number; oy: number; zoom: number }; street?: { walkers(): readonly { x: number; y: number; umbrella: number }[] } };
            const cam = v.camera;
            const x0 = -cam.ox / cam.zoom + 2 * TILE;
            const x1 = (f.canvas.width - cam.ox) / cam.zoom - 2 * TILE;
            const y0 = -cam.oy / cam.zoom;
            const y1 = (f.canvas.height - cam.oy) / cam.zoom;
            const under = (v.street?.walkers() ?? []).filter((w) => w.umbrella >= 0.9 && w.x > x0 && w.x < x1 && w.y > y0 && w.y < y1);
            detail = `${under.length} under open umbrellas on screen`;
            if (under.length > 0) return done(true, f, null);
          } else if (cond.kind === "settled") {
            const busy = chars.filter((c) => c.sub && ACTIVE.has(c.activity) && c.fx === null);
            const away = busy.filter((c) => !c.place.startsWith("desk:"));
            detail = `${busy.length - away.length}/${busy.length} busy sub-agents at their desks; not yet: ${away.slice(0, 8).map((c) => `${c.label}@${c.place}`).join(", ")}`;
            if (busy.length > 0 && away.length === 0) return done(true, f, null);
          } else if (key) {
            const c = chars.find((x) => x.key === key);
            detail = c ? `${c.label} at ${c.place}` : `${key} not on screen`;
            if (c && cond.kind === "place") {
              if (c.place.startsWith(cond.place)) return done(true, f, key);
            } else if (c && cond.kind === "leg") {
              const sc = f.view.sim.chars?.get(key);
              const trip = sc?.state === "commute" ? sc.trip : null;
              if (trip && trip.cur.dir === cond.dir) {
                const pts = trip.route.points;
                const lens = pts.slice(0, -1).map((a, i) => (Math.abs(pts[i + 1].col - a.col) + Math.abs(pts[i + 1].row - a.row)) * TILE);
                const pos = (leg: number, d: number) => lens.slice(0, leg).reduce((s, l) => s + l, 0) + d;
                const s = pos(trip.cur.leg, trip.cur.d);
                const target = pos(cond.leg, cond.at * lens[cond.leg]);
                const eta = between(lens, trip.route.rides, s, target) / Math.max(0.05, rate);
                detail = `${c.label} at ${c.place}, leg ${trip.cur.leg} (${Math.round(trip.cur.d)} px), ${eta.toFixed(2)} s from leg ${cond.leg} @ ${cond.at}`;
                const ahead = cond.dir > 0 ? target >= s : target <= s;
                if (!ahead) return done(true, f, key, { late: true, missed: trip.cur.leg !== cond.leg, etaS: -eta });
                if (eta <= cond.leadS) return done(true, f, key, { etaS: eta });
              } else if (sc) detail += ` (sim state ${sc.state}${sc.trip ? `, dir ${sc.trip.cur.dir}` : ""})`;
            }
          }
        }
        if (performance.now() - t0 > timeoutMs) return done(false, "error" in f ? null : f, null);
        requestAnimationFrame(step);
      };
      step();
    });

  /**
   * Street life over `ms` of real frames (every animation frame): the traffic's vehicles and the
   * passers-by on screen, read off the view's `TrafficFx.vehicles()` and `StreetLife.walkers()` (private
   * in TypeScript, plain properties at run time; both return their arrays, nothing is changed).
   */
  type Veh = { kind: string; x: number; w: number; seed: number };
  type Walker = { id: number; x: number; umbrella: number; sink: number; vend: unknown };
  const life = (ms: number) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const walkers = new Set<number>();
      const vehicles = new Set<number>();
      const kinds = new Set<string>();
      const open = new Set<number>();
      const any = new Set<number>();
      const stairs = new Set<number>();
      const buying = new Set<number>();
      let frames = 0;
      let maxW = 0;
      let maxV = 0;
      let first = -1;
      let last = -1;
      const step = () => {
        const f = find();
        if (!("error" in f)) {
          const v = f.view as unknown as ViewW & { traffic?: { vehicles(): readonly Veh[] }; street?: { walkers(): readonly Walker[] } };
          const cam = v.camera;
          const x0 = -cam.ox / cam.zoom;
          const x1 = (f.canvas.width - cam.ox) / cam.zoom;
          const ws = (v.street?.walkers() ?? []).filter((w) => w.x >= x0 && w.x <= x1);
          const vs = (v.traffic?.vehicles() ?? []).filter((c) => c.x + c.w >= x0 && c.x <= x1);
          for (const w of ws) {
            walkers.add(w.id);
            if (w.umbrella >= 0.9) open.add(w.id);
            if (w.umbrella > 0) any.add(w.id);
            if (w.sink > 0) stairs.add(w.id);
            if (w.vend) buying.add(w.id);
          }
          for (const c of vs) {
            vehicles.add(c.seed);
            kinds.add(c.kind);
          }
          maxW = Math.max(maxW, ws.length);
          maxV = Math.max(maxV, vs.length);
          const n = (v.chars ?? []).length;
          if (first < 0) first = n;
          last = n;
          frames++;
        }
        if (performance.now() - t0 >= ms)
          return resolve({
            frames,
            walkers: walkers.size,
            maxWalkers: maxW,
            vehicles: vehicles.size,
            maxVehicles: maxV,
            kinds: [...kinds].sort(),
            umbrellasOpen: open.size,
            umbrellasAny: any.size,
            stairs: stairs.size,
            buying: buying.size,
            agents: { first, last },
          });
        requestAnimationFrame(step);
      };
      step();
    });

  w.__e2eVillage = { version, scene, track, trackLog, stopTrack, wait, life } as Obj & { version: number };
}

/** What {@link install} puts on `window` — how the calls below reach it from a serialised function. */
type ProbeWindow = {
  __e2eVillage: {
    scene: (kinds: readonly string[]) => Promise<unknown>;
    track: () => void;
    trackLog: () => Track;
    stopTrack: () => void;
    wait: (cond: WaitCond, timeoutMs: number) => Promise<WaitResult>;
    life: (ms: number) => Promise<LifeWatch>;
  };
};

/** Install (or replace a stale) page probe. Cheap when it is already there. */
async function ensureProbe(): Promise<void> {
  await browser.execute(install, PROBE_VERSION);
}

/** The picture on screen, read off the live `VillageView` (see the module note). Throws if it cannot be found. */
export async function scene(): Promise<Scene> {
  await ensureProbe();
  const s = (await browser.execute((kinds: readonly string[]) => (window as unknown as ProbeWindow).__e2eVillage.scene(kinds), LANDMARK_KINDS)) as Scene | { error: string };
  if ("error" in s) throw new Error(`village scene probe: ${s.error}`);
  return s;
}

/** Start tracking the next sub-agent to appear (the City must be on screen). Replaces any earlier tracker. */
export async function startTracking(): Promise<void> {
  await ensureProbe();
  await browser.execute(() => (window as unknown as ProbeWindow).__e2eVillage.track());
}

/** The tracker's record so far. */
export async function tracked(): Promise<Track> {
  await ensureProbe();
  return browser.execute(() => (window as unknown as ProbeWindow).__e2eVillage.trackLog());
}

/** Watch the City's street life over `ms` (≤ 20 s: one WebDriver script) of real frames — see {@link LifeWatch}. */
export async function watchLife(ms: number): Promise<LifeWatch> {
  await ensureProbe();
  return browser.execute((m: number) => (window as unknown as ProbeWindow).__e2eVillage.life(m), Math.min(ms, 20_000));
}

/** Stop the tracker (its record stays readable). */
export async function stopTracking(): Promise<void> {
  await ensureProbe();
  await browser.execute(() => (window as unknown as ProbeWindow).__e2eVillage.stopTrack());
}

/**
 * Wait IN THE PAGE (every animation frame) until `cond` holds, up to `timeoutMs`. Long waits are cut
 * into pieces under WebDriver's 30 s script timeout. Resolves with `ok: false` on timeout — the caller
 * decides whether that fails the spec (it carries `detail`, what the page last saw).
 */
export async function waitInPage(cond: WaitCond, timeoutMs: number): Promise<WaitResult> {
  await ensureProbe();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const slice = Math.max(1, Math.min(20_000, deadline - Date.now()));
    const r = await browser.execute(
      (c: WaitCond, ms: number) => (window as unknown as ProbeWindow).__e2eVillage.wait(c, ms),
      cond,
      slice,
    );
    if (r.ok || Date.now() >= deadline) return r;
  }
}

/** A house (village) or floor (city) by key; throws with what IS there when it is missing. */
export function houseOf(s: Scene, key: string): SceneHouse {
  const h = s.houses.find((x) => x.key === key);
  if (!h) throw new Error(`no house "${key}" in the ${s.mode}: ${s.houses.map((x) => x.key).join(", ")}`);
  return h;
}

/** A City building by folder; throws with what IS there when it is missing. */
export function buildingOf(s: Scene, folder: string): SceneBuilding {
  const b = s.city?.buildings.find((x) => x.key === folder);
  if (!b) throw new Error(`no building "${folder}" in the city: ${(s.city?.buildings ?? []).map((x) => x.key).join(", ")}`);
  return b;
}

/** The City's capacity HQ; throws when there is none. */
export function hqOf(s: Scene): SceneBuilding {
  const b = s.city?.buildings.find((x) => x.hq);
  if (!b) throw new Error(`no Capacity HQ in the ${s.mode}: ${(s.city?.buildings ?? []).map((x) => x.key).join(", ")}`);
  return b;
}

/** The City's Seats lounge; throws when there is none. */
export function loungeOf(s: Scene): SceneLounge {
  const l = s.city?.lounge;
  if (!l) throw new Error(`no Seats lounge in the ${s.mode}`);
  return l;
}

/** `box` grown by `px` on every side. */
export function grow(box: Box, px: number): Box {
  return { x: box.x - px, y: box.y - px, w: box.w + 2 * px, h: box.h + 2 * px };
}

/** The smallest box holding all of `boxes` (at least one). */
export function union(boxes: readonly Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Is `inner`'s centre inside `outer`? */
export function centredIn(inner: Box, outer: Box): boolean {
  const c = { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 };
  return c.x > outer.x && c.x < outer.x + outer.w && c.y > outer.y && c.y < outer.y + outer.h;
}

/* ── Tokyo's backdrop as PIXELS (render/backdrop.ts: high-rises, the neon canyon, the yokochō shops) ── */

/**
 * The colour classes {@link bandColours} counts, by HSV (value 0..255, saturation 0..1, hue in degrees):
 *   - `neon`: saturated AND bright — a lit tube, a back-lit sign plate, a lantern. The night sky is dark,
 *     a star or the moon is white, and the haze's lit windows (#ffd987, render/city.ts) are only 0.47
 *     saturated — none of them is neon;
 *   - `coloured`: a painted colour that is not the sky's blue — a sign plate, an awning, a shop front by
 *     day. The day sky and Fuji's slopes are blue, the haze and the high-rises pale and greyish, clouds
 *     and snow white — none of them counts.
 */
export const PIXEL_CLASSES = {
  neon: { sat: 0.6, value: 170 },
  coloured: { sat: 0.45, value: 120, skyHue: [190, 240] },
} as const;

/** What share (0..1) of a canvas band's pixels is of each of {@link PIXEL_CLASSES}. */
export interface BandColours {
  pixels: number;
  neon: number;
  coloured: number;
}

/**
 * Classify the canvas's REAL pixels over `boxes` (canvas CSS px; turned into device px with the canvas's
 * own ratio and clipped to it) once the app has painted a frame since the call — {@link PIXEL_CLASSES}.
 * The canvas is the panel's 2D one (VillagePanel's `getContext("2d")`), so `getImageData` reads exactly
 * what the frame painted; the HUD floating over it is DOM, never in it. The pixels are counted in the
 * page (a band is tens of thousands of them, never shipped over WebDriver). Read-only.
 */
export async function bandColours(boxes: readonly Box[]): Promise<BandColours> {
  return browser.execute(
    async (want: readonly Box[], cls: typeof PIXEL_CLASSES) => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const c = document.querySelector('[data-testid="village-canvas"]') as HTMLCanvasElement;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      const dpr = c.width / c.getBoundingClientRect().width;
      let pixels = 0;
      let neon = 0;
      let coloured = 0;
      for (const b of want) {
        const x0 = Math.max(0, Math.floor(b.x * dpr));
        const y0 = Math.max(0, Math.floor(b.y * dpr));
        const x1 = Math.min(c.width, Math.ceil((b.x + b.w) * dpr));
        const y1 = Math.min(c.height, Math.ceil((b.y + b.h) * dpr));
        if (x1 <= x0 || y1 <= y0) continue;
        const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, bl] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(r, g, bl);
          const span = max - Math.min(r, g, bl);
          const sat = max > 0 ? span / max : 0;
          pixels++;
          if (sat >= cls.neon.sat && max >= cls.neon.value) neon++;
          if (sat >= cls.coloured.sat && max >= cls.coloured.value) {
            // The hue, in degrees (span > 0 here: a coloured pixel is saturated).
            const h = max === r ? ((g - bl) / span + 6) % 6 : max === g ? (bl - r) / span + 2 : (r - g) / span + 4;
            const hue = h * 60;
            if (hue < cls.coloured.skyHue[0] || hue > cls.coloured.skyHue[1]) coloured++;
          }
        }
      }
      return { pixels, neon: pixels > 0 ? neon / pixels : 0, coloured: pixels > 0 ? coloured / pixels : 0 };
    },
    boxes,
    PIXEL_CLASSES,
  );
}
