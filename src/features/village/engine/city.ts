/** City view: one building per folder, one FLOOR per root agent or plain console (its leader), each
 * sub-agent with a desk (no cap: crowded floors grow wider, then taller). The village engine, not a
 * fork: floors are `World.houses`; city-only shells live in `World.city`. */

import {
  TILE,
  type CapacityKind,
  type CapacityLayout,
  type CityBuilding,
  type CityLift,
  type CityLounge,
  type CitySubway,
  type House,
  type Prop,
  type Seat,
  type TileKind,
  type VillageAgent,
  type World,
} from "../villageTypes";
import { TRAIN_LEN } from "./subway";
import { CAPACITY_LABEL, capacityKey, HALL_H, RACKS, rootOf } from "./world";

/** Team seats come in desks of two, so a building's width changes every second sub-agent, not every one. */
const TEAM_BLOCK = 2;
/** Tiles per floor with ONE desk row: slab, back wall, headroom, leader row, desk row. */
export const FLOOR_H = 5;
/** Desks (tables of two) in one row; the next one starts a new row below (after every 10 tables, continue vertically). */
export const ROW_DESKS = 10;
/** Team seats in one desk row. */
const ROW_SEATS = ROW_DESKS * TEAM_BLOCK;
/** Tiles each desk row past the first adds to a floor: an aisle, the desk row, the chair row. */
export const ROW_PITCH = 3;
/** Sky rows above the tallest roof (its sign, the sun's arc). */
const SKY_ROWS = 4;
/** Street rows below the buildings: near sidewalk, two lanes of road, far sidewalk. */
const STREET_ROWS = 4;
/** Empty columns left of the first building and right of the last. */
const MARGIN = 3;
/** Columns between two buildings: a street lamp and a tree. */
const GAP = 4;
/** The narrowest city (an empty street still reads as a street). */
const MIN_COLS = 40;
/** Floors an EMPTY city is as tall as — so the sky has the height of a small block. */
const EMPTY_FLOORS = 2;

// ───────────────────────────── plan ─────────────────────────────

/** One floor. No sub-agent count on purpose: the world never reads it, and an exact count would
 * change `planSignature` and rebuild the world on EVERY sub-agent spawn. */
export interface CityFloorPlan {
  /** The floor's house key (`floorKey` of its leader). */
  key: string;
  /** Its name plate: the agent's title, or the console tab's name. */
  label: string;
  /** The leader runs in the IDE (an IDE agent or an IDE console). */
  ide: boolean;
}

export interface CityPlan {
  /** The folder. */
  key: string;
  label: string;
  /** Team seats on EVERY floor: the most crowded floor's sub-agents rounded UP to desks of two,
   * never capped. Within one `ROW_DESKS` row it sets the width; past it, every floor's
   * `deskRows`. */
  team: number;
  /** Ground floor first. */
  floors: CityFloorPlan[];
  hasIde: boolean;
  /** Its agents' most common known language (`VillageAgent.language`; ties: code-unit order), or null — the neon sign. */
  language?: string | null;
}

export interface CityRoster {
  plans: CityPlan[];
  /** Sim characters: a leader's `folder` is its floor's key; each sub-agent with a known root hangs
   * under its floor's leader (unknown root: left out). Order: leader, busy subs, the rest; the sim
   * hands out desks in that order, and a taken desk is kept. */
  agents: VillageAgent[];
}

/** The house key of the floor `leaderKey` leads. */
export function floorKey(leaderKey: string): string {
  return `floor:${leaderKey}`;
}

/** Floor order inside a building: IDE agents, then IDE consoles, then agents outside the IDE. */
function floorRank(a: VillageAgent): number {
  if (a.origin === "external") return 2;
  return a.consoleId ? 1 : 0;
}

/** Mid-turn: these take the desks nearest their leader when a team arrives together; finished ones sit further down. */
const BUSY = new Set(["typing", "reading", "thinking", "waiting"]);

/** Stable by construction: buildings IDE-first then by folder (code-unit order), floors by
 * `floorRank` then input order, teams busy-first. No cap: a bigger team is a wider building. */
export function planCity(agents: VillageAgent[]): CityRoster {
  const byKey = new Map(agents.map((a) => [a.key, a]));
  const roots = agents.filter((a) => a.parentKey === null);
  const subsOf = new Map<string, VillageAgent[]>(roots.map((r) => [r.key, []]));
  for (const a of agents) {
    if (a.parentKey === null) continue;
    const root = rootOf(a, byKey);
    if (root) (subsOf.get(root.key) as VillageAgent[]).push(a);
  }

  const buildings = new Map<string, { floors: CityFloorPlan[]; team: VillageAgent[][]; leaders: VillageAgent[]; hasIde: boolean }>();
  const ordered = roots.map((r, i) => ({ r, i })).sort((a, b) => floorRank(a.r) - floorRank(b.r) || a.i - b.i);
  for (const { r } of ordered) {
    let b = buildings.get(r.folder);
    if (!b) buildings.set(r.folder, (b = { floors: [], team: [], leaders: [], hasIde: false }));
    const subs = subsOf.get(r.key) as VillageAgent[];
    const team = [...subs.filter((s) => BUSY.has(s.activity)), ...subs.filter((s) => !BUSY.has(s.activity))];
    const ide = r.origin === "ide";
    b.floors.push({ key: floorKey(r.key), label: r.title, ide });
    b.team.push(team);
    b.leaders.push(r);
    if (ide) b.hasIde = true;
  }

  const plans: CityPlan[] = [];
  // IDE buildings first, then the others, each by folder (keys are unique: no ties).
  const byFolder = ([ka]: [string, unknown], [kb]: [string, unknown]) => (ka < kb ? -1 : 1);
  const all = [...buildings];
  const keyed = [...all.filter(([, b]) => b.hasIde).sort(byFolder), ...all.filter(([, b]) => !b.hasIde).sort(byFolder)];
  const out: VillageAgent[] = [];
  for (const [key, b] of keyed) {
    const widest = Math.max(...b.team.map((t) => t.length));
    const language = mostCommon([...b.leaders, ...b.team.flat()].map((a) => a.language));
    plans.push({ key, label: key, team: Math.ceil(widest / TEAM_BLOCK) * TEAM_BLOCK, floors: b.floors, hasIde: b.hasIde, language });
    b.leaders.forEach((leader, i) => {
      const fk = floorKey(leader.key);
      out.push({ ...leader, folder: fk });
      for (const s of b.team[i]) out.push({ ...s, parentKey: leader.key, folder: fk });
    });
  }
  return { plans, agents: out };
}

/** The most frequent known value (null / absent ignored); a tie goes to the first in code-unit order; null when none. */
function mostCommon(values: readonly (string | null | undefined)[]): string | null {
  const count = new Map<string, number>();
  for (const v of values) if (v) count.set(v, (count.get(v) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [v, n] of count)
    if (n > most || (n === most && v < (best as string))) {
      best = v;
      most = n;
    }
  return best;
}

// ───────────────────────────── world ─────────────────────────────

/** Interior width: plant, big desk ×3, the lift's aisle, then desks of two + an aisle each (at
 * most `ROW_DESKS`; more go on another row), and decor. */
export function floorWidth(team: number): number {
  return 5 + 3 * (Math.min(team, ROW_SEATS) / TEAM_BLOCK) + 1;
}

/** Desk rows on a floor of `seats` seats: one per `ROW_DESKS` desks, at least one. */
export function deskRows(seats: number): number {
  return Math.max(1, Math.ceil(seats / ROW_SEATS));
}

/** Tiles of a floor with `rows` desk rows: `FLOOR_H`, and `ROW_PITCH` more per row past the first. */
export function floorHeight(rows: number): number {
  return FLOOR_H + ROW_PITCH * (rows - 1);
}

/** Team seat `i`'s PC column and row offsets from the floor's first desk: desks of two 3 columns
 * apart, `ROW_DESKS` to a row, rows `ROW_PITCH` apart. */
function deskSpot(i: number): { dc: number; dr: number } {
  const j = i % ROW_SEATS;
  return { dc: 3 * Math.floor(j / TEAM_BLOCK) + (j % TEAM_BLOCK), dr: ROW_PITCH * Math.floor(i / ROW_SEATS) };
}

// ───────────────────────────── the capacity HQ ───────────────────────────────────────────

/** The HQ building's key and sign. */
export const HQ_KEY = "cap/hq";
export const HQ_LABEL = "Capacity HQ";
/** The HQ's floors, ground first. Seats is not a floor but the hall under the LOUNGE, so the
 * skyline the landmarks are sized from does not change (a third floor pushed Fuji out of frame). */
const HQ_FLOORS: readonly CapacityKind[] = ["memory", "usage"];
/** The HQ's interior width: eight racks in two banks of four, an aisle and a plant. */
export const HQ_W = 12;
/** Interior column offsets of the Memory floor's racks, and of the Usage floor's two gauges. */
const HQ_RACKS = [1, 2, 3, 4, 6, 7, 8, 9];
const HQ_GAUGES = [1, 7];

// ───────────────────────────── the lounge ─────────────────────────────

/** Lounge seats per bench row: on each side of the lift, two benches of four. */
export const LOUNGE_ROW_SEATS = 16;
/** Seats on one bench. */
const BENCH = 4;
/** Interior columns on each side of the lounge's lift: a margin, a bench, a gap, a bench, an aisle. */
const LOUNGE_SIDE = 1 + BENCH + 1 + BENCH + 1;
/** The lounge's interior width: both sides and the lift between them. */
export const LOUNGE_W = 2 * LOUNGE_SIDE + 1;
/** Rows of earth between the far sidewalk and the lounge's back wall (the lounge's board hangs there). */
const LOUNGE_DEPTH = 1;
/** Rows of earth between the Seats hall's floor and the subway tunnel's ceiling. */
const LOUNGE_BELOW = 1;
/** Rows of earth between the lounge's floor and the Seats hall's top wall (the hall's board hangs there). */
const HALL_DEPTH = 1;
/** The Seats hall's interior width: the Village's Seats house's, so the hall is the very same picture. */
export const HALL_W = 13;
/** The subway tunnel's rows: its ceiling, three rows of tunnel (headroom, the train's body), its track bed. */
export const TUNNEL_ROWS = 5;
/** Rows of earth below the tunnel. */
const SUBWAY_BELOW = 1;
/** Columns between the lounge's left wall and the subway entrance (whose stairs go down beside it). */
const ENTRANCE_GAP = 3;
/** Platform width in columns: the whole train plus a tile beyond each end, so it always stops
 * alongside. */
export const STATION_W = Math.ceil(TRAIN_LEN / TILE) + 2;

/** Platform columns [col0, col1): centred under the entrance, slid whole into the world near its
 * ends (never cut short, or the train would overhang), no wider than the world. */
export function stationCols(entrance: number, cols: number): { col0: number; col1: number } {
  const col0 = Math.max(0, Math.min(cols - STATION_W, entrance + 1 - Math.floor(STATION_W / 2)));
  return { col0, col1: Math.min(cols, col0 + STATION_W) };
}

/** Bench rows in a lounge of `seats` seats: one per `LOUNGE_ROW_SEATS`, at least one. */
export function benchRows(seats: number): number {
  return Math.max(1, Math.ceil(seats / LOUNGE_ROW_SEATS));
}

/** Lounge seat `i` from the lift's column (`dc`) and first bench row (`dr`), in reading order;
 * bench rows are two apart, the aisle between being the riders' walk to the lift. */
function benchSpot(i: number): { dc: number; dr: number } {
  const half = LOUNGE_ROW_SEATS / 2;
  const j = i % LOUNGE_ROW_SEATS;
  const m = j % half;
  const off = Math.floor(m / BENCH) * (BENCH + 1) + (m % BENCH);
  return { dc: j < half ? off - (LOUNGE_SIDE - 1) : off + 2, dr: 2 * Math.floor(i / LOUNGE_ROW_SEATS) };
}

/** Outer height (tiles) of a building whose floors are `heights` tall: the floors plus the street-level front wall. */
function buildingHeight(heights: readonly number[]): number {
  return heights.reduce((sum, h) => sum + h, 0) + 1;
}

/** One building on the street: the HQ, or a project's (`fh`: each of its floors' height). */
type Slot = { hq: true; w: number } | { hq: false; w: number; plan: CityPlan; fh: number };

/** Side-view city for `plans`. Pure and deterministic; ids derive from floor keys, so desks survive
 * rebuilds. With `capacity` the HQ is centred and each project goes on the side with less street
 * (right on a tie); without it, buildings stand centred in plan order. */
export function buildCityWorld(plans: CityPlan[], capacity?: CapacityLayout): World {
  const projects: Slot[] = plans.map((plan) => ({ hq: false, plan, fh: floorHeight(deskRows(plan.team)), w: floorWidth(plan.team) + 2 }));
  const hqW = HQ_W + 2;
  /** Street taken on each side of the HQ: its buildings and the gap before each. */
  let left = 0;
  let right = 0;
  let slots = projects;
  if (capacity) {
    const l: Slot[] = [];
    const r: Slot[] = [];
    for (const p of projects)
      if (right <= left) {
        r.push(p);
        right += p.w + GAP;
      } else {
        l.push(p);
        left += p.w + GAP;
      }
    slots = [...l.reverse(), { hq: true, w: hqW }, ...r];
  }
  const count = slots.length;
  const tallest = Math.max(
    buildingHeight(Array.from({ length: EMPTY_FLOORS }, () => FLOOR_H)),
    ...slots.map((b) => (b.hq ? buildingHeight(HQ_FLOORS.map(() => FLOOR_H)) : buildingHeight(b.plan.floors.map(() => b.fh)))),
  );
  const used = slots.reduce((s, b) => s + b.w, 0) + GAP * Math.max(0, count - 1);
  // Even, so a copy of the street laid beside the world (render/city.ts) keeps the lane dashes in step.
  const width = Math.max(MIN_COLS, 2 * MARGIN + (capacity ? Math.max(2 * Math.max(left, right) + hqW, LOUNGE_W + 2) : used));
  const cols = width + (width % 2);
  // The front-wall row every building stands on — kept EVEN (one more sky row when needed),
  // so the first road row is even and the road tiles draw its kerb on top and the centre
  // dashes on the second lane (render/tiles.ts decides by row parity).
  const front = SKY_ROWS + tallest - 1 + ((SKY_ROWS + tallest - 1) % 2);
  const street = front + 1;
  const benches = capacity ? benchRows(capacity.seats) : 0;
  /** The lounge's back-wall row, and the wall row under its floor. */
  const loungeTop = street + STREET_ROWS + LOUNGE_DEPTH;
  const loungeFloor = loungeTop + 2 + 2 * benches;
  /** The Seats hall's top wall row (under a row of earth below the lounge, where its board hangs)
   * and the wall row under its floor. */
  const hallTop = loungeFloor + 1 + HALL_DEPTH;
  const hallFloor = hallTop + HALL_H + 1;
  /** The subway tunnel's ceiling row, under a row of earth below the Seats hall. */
  const tunnelTop = hallFloor + 1 + LOUNGE_BELOW;
  const rows = capacity ? tunnelTop + TUNNEL_ROWS + SUBWAY_BELOW : street + STREET_ROWS;

  const tiles = new Array<TileKind>(cols * rows).fill("sky");
  const set = (c: number, r: number, k: TileKind) => {
    tiles[r * cols + c] = k;
  };
  for (let c = 0; c < cols; c++) {
    set(c, street, "path");
    set(c, street + 1, "road");
    set(c, street + 2, "road");
    set(c, street + 3, "path");
  }

  const props: Prop[] = [];
  const seats: Seat[] = [];
  const houses: House[] = [];
  const buildings: CityBuilding[] = [];
  let lounge: CityLounge | undefined;
  let subway: CitySubway | undefined;

  let x = capacity ? Math.floor((cols - hqW) / 2) - left : Math.floor((cols - used) / 2);
  const lamps: number[] = count === 0 ? [4, 12, 20, 28, 36] : [x - 2];

  /** Shell walls of a building from `x0` to `x1` whose top floor's slab is `top`, its door at `doorCol`. */
  const shell = (x0: number, x1: number, top: number, doorCol: number): void => {
    for (let r = top + 1; r <= front; r++) {
      set(x0, r, "wall");
      set(x1, r, "wall");
    }
    for (let c = x0; c <= x1; c++) set(c, front, "wall");
    set(doorCol, front, "floor");
  };
  /** A floor of `fh` rows whose slab is row `s`: every row a floor but the back wall (`s + 1`), which runs wall to wall. */
  const floorRows = (x0: number, x1: number, s: number, fh: number): void => {
    for (let r = s; r < s + fh; r++) for (let c = x0 + 1; c < x1; c++) set(c, r, r === s + 1 ? "wall" : "floor");
    set(x0, s + 1, "wall");
    set(x1, s + 1, "wall");
  };
  /** After a building: the gap — a lamp, a free column, a tree; after the last one just a lamp. */
  const gapAfter = (bi: number): void => {
    if (bi + 1 < count) {
      lamps.push(x);
      props.push({ id: `street:tree:${bi}`, kind: "tree", col: x + 2, row: street - 1, w: 2, h: 2 });
    } else lamps.push(x + 1);
    x += GAP;
  };

  /** The HQ, from `x0` to `x1`, the lounge under the street in front of it, and the Seats hall under that. */
  const hq = (x0: number, x1: number, seatCount: number): void => {
    const ic = x0 + 1;
    const h = buildingHeight(HQ_FLOORS.map(() => FLOOR_H));
    const top = front - h + 1;
    // The door in the middle of its front: the crossing and the lounge's lift line up with it.
    const doorCol = ic + HQ_W / 2;
    shell(x0, x1, top, doorCol);
    HQ_FLOORS.forEach((kind, fi) => {
      const s = front - FLOOR_H * (fi + 1);
      const B = s + 4;
      floorRows(x0, x1, s, FLOOR_H);
      const k = capacityKey(kind);
      houses.push({ key: k, label: CAPACITY_LABEL[kind], col: ic, row: s + 1, w: HQ_W, h: FLOOR_H - 1, doorCol, doorRow: front, hasIde: false, capacity: kind });
      props.push({ id: `${k}:plant`, kind: "plant", col: ic + HQ_W - 1, row: B, w: 1, h: 1 });
      if (kind === "memory")
        for (let i = 0; i < RACKS; i++)
          props.push({ id: `${k}:rack:${i}`, kind: "rack", col: ic + HQ_RACKS[i], row: B, w: 1, h: 1, capacity: kind, index: i });
      else
        HQ_GAUGES.forEach((off, i) =>
          props.push({ id: `${k}:gauge:${i}`, kind: "gauge", col: ic + off, row: B, w: 2, h: 1, capacity: kind, index: i }),
        );
    });
    buildings.push({ key: HQ_KEY, label: HQ_LABEL, col: x0, row: top, w: x1 - x0 + 1, h, doorCol, floors: HQ_FLOORS.map(capacityKey), hasIde: false, hq: true });

    // The lounge: its lift right under the HQ's door, a bench seat per seat on both sides of it.
    const lift = doorCol;
    const lc = lift - LOUNGE_SIDE;
    for (let r = loungeTop; r <= loungeFloor; r++)
      for (let c = lc - 1; c <= lc + LOUNGE_W; c++) {
        const edge = r === loungeTop || r === loungeFloor || c === lc - 1 || c === lc + LOUNGE_W;
        set(c, r, edge ? "wall" : "floor");
      }
    const key = capacityKey("lounge");
    houses.push({ key, label: CAPACITY_LABEL.lounge, col: lc, row: loungeTop, w: LOUNGE_W, h: loungeFloor - loungeTop, doorCol: lift, doorRow: loungeTop, hasIde: false, capacity: "lounge" });
    for (let i = 0; i < seatCount; i++) {
      const { dc, dr } = benchSpot(i);
      props.push({ id: `${key}:bench:${i}`, kind: "bench", col: lift + dc, row: loungeTop + 2 + dr, w: 1, h: 1, facing: "down", capacity: "lounge", index: i });
    }
    // The Seats hall (the selected agent's context window), centred under the lounge: the Village's
    // hall, seen from the back of the room. Nobody walks in; its board hangs in the earth above it.
    const hc = lift - Math.floor(HALL_W / 2);
    for (let r = hallTop; r <= hallFloor; r++)
      for (let c = hc - 1; c <= hc + HALL_W; c++) {
        const edge = r === hallTop || r === hallFloor || c === hc - 1 || c === hc + HALL_W;
        set(c, r, edge ? "wall" : "floor");
      }
    const seatsKey = capacityKey("seats");
    houses.push({ key: seatsKey, label: CAPACITY_LABEL.seats, col: hc, row: hallTop, w: HALL_W, h: HALL_H + 1, doorCol: lift, doorRow: hallTop, hasIde: false, capacity: "seats" });
    props.push({ id: `${seatsKey}:hall`, kind: "hall", col: hc, row: hallTop + 1, w: HALL_W, h: HALL_H, capacity: "seats" });

    // Its kiosk on the far sidewalk, where a rider comes up (and the crossing to the HQ starts).
    const sidewalk = street + STREET_ROWS - 1;
    props.push({ id: `${key}:lift`, kind: "lift", col: lift, row: sidewalk, w: 1, h: 1 });
    const stops = [sidewalk, ...Array.from({ length: benches }, (_, k) => loungeTop + 3 + 2 * k)];
    lounge = { key, lift: { col: lift, top: sidewalk, bottom: stops[benches], stops } };

    // The subway under it all: its street entrance on the far sidewalk left of the lounge (its stairs go
    // down beside the lounge's wall), the station's platform under the entrance.
    const entrance = lc - 1 - ENTRANCE_GAP - 2;
    props.push({ id: "city:metro", kind: "metro", col: entrance, row: sidewalk, w: 2, h: 1 });
    subway = {
      top: tunnelTop,
      bottom: tunnelTop + TUNNEL_ROWS - 1,
      rail: tunnelTop + TUNNEL_ROWS - 2,
      station: stationCols(entrance, cols),
      entrance: { col: entrance, row: sidewalk },
    };
  };

  /** A project's building from `x0` to `x1`: `fh`-row floors, ground floor first, and its lift up the door column. */
  const project = (x0: number, x1: number, plan: CityPlan, fh: number): void => {
    const iw = x1 - x0 - 1;
    const ic = x0 + 1;
    const h = buildingHeight(plan.floors.map(() => fh));
    const top = front - h + 1;
    // Shell: outer walls from the top floor's back wall down; the front wall with its door.
    const doorCol = ic + 4;
    shell(x0, x1, top, doorCol);
    const stops: number[] = [];

    plan.floors.forEach((floor, fi) => {
      const s = front - fh * (fi + 1);
      const W = s + 1;
      const H = s + 2;
      const A = s + 3;
      const B = s + 4;
      floorRows(x0, x1, s, fh);
      const k = floor.key;
      houses.push({ key: k, label: floor.label, col: ic, row: W, w: iw, h: fh - 1, doorCol, doorRow: front, hasIde: floor.ide });

      // The leader: the big desk facing the street; its workstation — the monitor seen from behind
      // beside the chair, and the KEYBOARD right in front of it (without it the agents had
      // nothing to type on — a monitor, but no keyboard) — one 2-tile prop from the monitor's column; a coffee.
      const leadSeat = `${k}:lead`;
      const monitor = `${k}:monitor`;
      props.push({ id: `${k}:plant`, kind: "plant", col: ic, row: A, w: 1, h: 1 });
      props.push({ id: `${k}:chair:lead`, kind: "chair", col: ic + 2, row: A, w: 1, h: 1, facing: "down" });
      props.push({ id: `${k}:desk:lead`, kind: "desk", col: ic + 1, row: B, w: 3, h: 1 });
      props.push({ id: monitor, kind: "monitor", col: ic + 1, row: B, w: 2, h: 1, seatId: leadSeat });
      props.push({ id: `${k}:coffee`, kind: "coffee", col: ic + 3, row: B, w: 1, h: 1 });
      seats.push({ id: leadSeat, houseKey: k, col: ic + 2, row: A, facing: "down", pcId: monitor });

      // The team: desks of two against the back wall, each seat its own PC; ROW_DESKS to a row.
      for (let i = 0; i < plan.team; i++) {
        const { dc, dr } = deskSpot(i);
        const c = ic + 5 + dc;
        const a = A + dr;
        if (i % TEAM_BLOCK === 0) props.push({ id: `${k}:desk:${i / TEAM_BLOCK}`, kind: "desk", col: c, row: a, w: 2, h: 1 });
        const seatId = `${k}:team:${i}`;
        const pcId = `${k}:pc:${i}`;
        props.push({ id: pcId, kind: "pc", col: c, row: a, w: 1, h: 1, seatId });
        props.push({ id: `${k}:chair:${i}`, kind: "chair", col: c, row: a + 1, w: 1, h: 1, facing: "up" });
        seats.push({ id: seatId, houseKey: k, col: c, row: a + 1, facing: "up", pcId, forSub: true });
      }
      // A team floor's Wi-Fi router (engine/teamLan.ts): back wall, headroom row, over the end of
      // the leader's desk (the next column is the lift's). A team makes the floor ≥ 9 wide: shelf
      // clear.
      if (plan.team > 0) props.push({ id: `${k}:router`, kind: "router", col: ic + 3, row: H, w: 1, h: 1 });
      props.push({ id: `${k}:shelf`, kind: "bookshelf", col: ic + iw - 2, row: H, w: 2, h: 1 });
      props.push({ id: `${k}:bin`, kind: "bin", col: ic + iw - 1, row: B, w: 1, h: 1 });
      // The lift stops at each of the floor's chair rows (its team's, and the leader's desk row).
      for (let r = B; r < s + fh; r += ROW_PITCH) stops.push(r);
    });
    stops.sort((a, b) => a - b).push(front);
    // Only a building with a team has a lift: sub-agents are the only riders (leaders stay put).
    const lift: CityLift | undefined = plan.team > 0 ? { col: doorCol, top: stops[0], bottom: front, stops } : undefined;
    buildings.push({
      key: plan.key,
      label: plan.label,
      col: x0,
      row: top,
      w: x1 - x0 + 1,
      h,
      doorCol,
      floors: plan.floors.map((f) => f.key),
      hasIde: plan.hasIde,
      language: plan.language ?? null,
      ...(lift ? { lift } : {}),
    });
  };

  slots.forEach((slot, bi) => {
    const x0 = x;
    const x1 = x0 + slot.w - 1;
    if (slot.hq) hq(x0, x1, (capacity as CapacityLayout).seats);
    else project(x0, x1, slot.plan, slot.fh);
    x = x1 + 1;
    // The gap after this building: a lamp, a free column, a tree (2×2, standing on the
    // sidewalk); after the last one, just a lamp.
    gapAfter(bi);
  });
  lamps.forEach((col, i) => props.push({ id: `street:lamp:${i}`, kind: "lamp", col, row: street, w: 1, h: 1 }));

  return {
    cols,
    rows,
    tiles,
    houses,
    props,
    seats,
    plaza: { col: Math.floor(cols / 2), row: street },
    city: { street, buildings, ...(lounge ? { lounge, subway } : {}) },
  };
}

/** `WeatherFx.update`'s `ground`: the street (any x: it runs past the world) and building roofs;
 * anywhere else is open sky, where a drop simply ends. */
export function cityGround(world: World): (wx: number, wy: number) => boolean {
  const city = world.city as NonNullable<World["city"]>;
  const top = city.street * TILE;
  const bottom = (city.street + STREET_ROWS) * TILE;
  const roofs = city.buildings.map((b) => ({ x0: b.col * TILE, x1: (b.col + b.w) * TILE, y0: b.row * TILE, y1: (b.row + 1) * TILE }));
  return (wx, wy) => (wy >= top && wy < bottom) || roofs.some((r) => wx >= r.x0 && wx < r.x1 && wy >= r.y0 && wy < r.y1);
}
