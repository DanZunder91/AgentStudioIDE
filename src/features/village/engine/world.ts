/**
 * The village map: which houses exist (`planHouses`) and the tile/prop layout
 * built from them (`buildWorld`). Pure and deterministic — the same plans
 * always produce an identical `World`, so the sim and renderer can rebuild it
 * freely without the scene jumping.
 *
 * Layout (tiles):
 *
 *   grass margin
 *   ┌house┐ ┌house┐ ┌house┐      ← a row of houses, bottoms aligned
 *   └─d───┘ └─d───┘ └─d───┘        d = door gap in the bottom wall
 *  |  :s      :s      :s    |    ← yard: path stub below each door + sign
 *  |========================|    ← horizontal road under the row
 *  |      plaza band        |    ← fountain, campfire, lamps, pond (once, mid-way)
 *   ...more house rows...
 *
 * `|` are vertical roads between every house column; they cross every road
 * row and the plaza band, so every door is path-connected to the plaza.
 *
 * Inside a house: decor along the top wall, then rows of 4 workstations
 * (2×1 desk + pc on its left tile + chair below facing up), one walkway row
 * after each, then (only when the house has sub-agents) rows of TEAM TABLES,
 * and a sofa/bin row at the bottom. The interior's middle column (the door
 * column) is always clear — but for a house with team tables, whose Wi-Fi
 * router (not blocking) hangs on the back wall at the top of that column.
 *
 * Team tables are where sub-agents sit — each at its own laptop. One team row
 * is 6 tiles tall and holds up to two 3×3 tables (left and right of the door
 * column), each seating 4: two chairs above it facing down, two below facing
 * up, a laptop on the table in front of every chair:
 *
 *      c . c          c = chair (top pair faces down, bottom pair faces up)
 *      L T L          L = laptop on the table's top / bottom row, T = table
 *      T T T
 *      L T L
 *      c . c
 *      . . .          walkway
 */

import {
  TILE,
  type CapacityKind,
  type CapacityLayout,
  type Dir,
  type House,
  type Prop,
  type PropKind,
  type Seat,
  type TileKind,
  type VillageAgent,
  type World,
} from "../villageTypes";
import { hash2 } from "./rng";

export interface HousePlan {
  key: string;
  label: string;
  seats: number;
  /** Team-table seats for this house's sub-agents: a multiple of 4, 0 when it has none. */
  subSeats: number;
  hasIde: boolean;
}

/** Seats are allocated in blocks of this many (one row of desks; one team table). */
export const SEAT_BLOCK = 4;
/** Team tables per team row (one each side of the door column). */
const TABLES_PER_ROW = 2;
/** Tiles per team row: chair row, 3 table rows, chair row, walkway. */
const TEAM_ROW_H = 6;
/** Footprint of a team table, tiles. */
export const TEAM_TABLE_W = 3;
export const TEAM_TABLE_H = 3;
/** Interior column offsets of the team tables in a row — symmetric about the door column. */
const TABLE_OFFSETS = [1, 9];

/**
 * The root a sub-agent ultimately belongs to: follow `parentKey` up through
 * `byKey` (sub-agents of sub-agents included). null when the chain breaks
 * (an unknown parent) or loops.
 */
export function rootOf<T extends { key: string; parentKey: string | null }>(a: T, byKey: ReadonlyMap<string, T>): T | null {
  let cur: T | undefined = a;
  const seen = new Set<string>();
  while (cur && cur.parentKey !== null) {
    if (seen.has(cur.key)) return null;
    seen.add(cur.key);
    cur = byKey.get(cur.parentKey);
  }
  return cur ?? null;
}

/**
 * One house per folder that has at least one ROOT agent. Sub-agents never get a
 * house of their own: the sim seats them at their ROOT's team tables (or by the
 * plaza when the root is unknown), so a sub-agent in another folder (a worktree,
 * a parent that `cd`'d) would otherwise leave an empty house nobody can enter.
 * Seats = root agents in the folder rounded UP to a multiple of 4 (min 4), so the
 * layout doesn't churn every time one agent appears. Sub-agents count towards their
 * ROOT's house (whatever their own folder): `subSeats` = those rounded up to a
 * multiple of 4, 0 when there are none (a sub-agent whose root is unknown counts
 * nowhere). IDE houses first, then by key (code-unit order, not locale order —
 * deterministic on every machine).
 */
export function planHouses(agents: VillageAgent[]): HousePlan[] {
  const byKey = new Map<string, { roots: number; subs: number; hasIde: boolean }>();
  for (const a of agents) {
    if (a.parentKey !== null) continue;
    let h = byKey.get(a.folder);
    if (!h) byKey.set(a.folder, (h = { roots: 0, subs: 0, hasIde: false }));
    h.roots++;
    if (a.origin === "ide") h.hasIde = true;
  }
  const agentByKey = new Map(agents.map((a) => [a.key, a]));
  for (const a of agents) {
    if (a.parentKey === null) continue;
    const root = rootOf(a, agentByKey);
    if (root) (byKey.get(root.folder) as { subs: number }).subs++;
  }
  const plans: HousePlan[] = [];
  for (const [key, h] of byKey) {
    const seats = Math.max(SEAT_BLOCK, Math.ceil(h.roots / SEAT_BLOCK) * SEAT_BLOCK);
    const subSeats = Math.ceil(h.subs / SEAT_BLOCK) * SEAT_BLOCK;
    plans.push({ key, label: key, seats, subSeats, hasIde: h.hasIde });
  }
  return plans.sort((a, b) =>
    // keys are unique (one plan per folder), so there are no ties to break
    a.hasIde !== b.hasIde ? (a.hasIde ? -1 : 1) : a.key < b.key ? -1 : 1,
  );
}

// ───────────────────────────── layout constants ─────────────────────────────

/** Interior width of every house (tiles). */
const IW = 13;
/** Interior column offsets of the four desks in a row. */
const DESK_OFFSETS = [1, 4, 7, 10];
/** Door column offset inside the interior (a clear column). */
const DOOR_OFFSET = 6;
/** Horizontal pitch of a house column: grass, 15-wide house, grass, road. */
const SLOT = IW + 5;
const TOP_MARGIN = 3;
const BOTTOM_MARGIN = 2;
const MIN_WIDTH = 33;
const PLAZA_BAND = 10;
/** Half-width of the plaza square around the fountain. */
const PLAZA_HALF = 6;

// ───────────────────────────── capacity ───────────────────────────────────────────

/** The Village's three capacity houses, in street order (the City's `lounge` is not one of them). */
export const CAPACITY_KINDS: readonly CapacityKind[] = ["seats", "memory", "usage"];

/** Their boards' names (the figure is added each frame: `CapacityFrame.captions`). */
export const CAPACITY_LABEL: Readonly<Record<CapacityKind, string>> = { seats: "Seats", memory: "Memory", usage: "Usage", lounge: "Lounge" };

/**
 * The house (village) / floor (city) key of a capacity building. A `/` can never be in a folder's
 * basename, so no project's house can ever share it.
 */
export function capacityKey(kind: CapacityKind): string {
  return `cap/${kind}`;
}

/** Server racks in the Memory building; they light in this order. */
export const RACKS = 8;
/** Interior column offsets of the Memory house's racks: two banks of four, the door column clear. */
const RACK_OFFSETS = [1, 2, 3, 4, 8, 9, 10, 11];
/** Interior column offsets of the Usage house's two gauges (5-hour, week). */
const GAUGE_OFFSETS = [2, 9];
/** Interior height of the Memory and Usage houses: decor, walkway, the 2-tile-tall row, walkway, lounge. */
const CIVIC_LOW_H = 6;

/**
 * The Seats hall (the selected agent's context window as `/context`'s 200 seats,
 * render/hall.ts): `HALL_H` tiles tall, the whole interior wide, right under the decor row.
 */
export const HALL_H = 9;
/** Interior height of the Seats house: the decor row, the hall, and the lounge row by the door. */
const SEATS_H = 1 + HALL_H + 1;

/** Desk rows for `seats` seats (at least one). */
function deskBlocks(seats: number): number {
  return Math.max(1, Math.ceil(seats / SEAT_BLOCK));
}

/** Team rows for `subSeats` sub seats (0 when none). */
function teamRows(subSeats: number): number {
  return Math.ceil(subSeats / (SEAT_BLOCK * TABLES_PER_ROW));
}

/** Interior height: decor row + walkway + 3 rows per desk block + 6 per team row + bottom row. */
function interiorHeight(plan: Pick<HousePlan, "seats" | "subSeats">): number {
  return 3 * deskBlocks(plan.seats) + TEAM_ROW_H * teamRows(plan.subSeats) + 3;
}

/** Props a character can never walk through. pc/coffee/laptop sit on a desk or table that already blocks. */
const BLOCKING = new Set<PropKind>([
  "desk",
  "table",
  "chair",
  "plant",
  "bookshelf",
  "bin",
  "sofa",
  "tree",
  "sakura",
  "fountain",
  "lamp",
  "sign",
  "campfire",
  "rack",
  "gauge",
  "hall",
]);

export function isBlockingProp(kind: PropKind): boolean {
  return BLOCKING.has(kind);
}

/** A row of the village's house grid: its project plans, or the civic row of capacity houses. */
interface GridRow {
  top: number;
  bottom: number; // outer bottom wall row
  plans: HousePlan[];
  /** Set on the civic row: the capacity building each plan is. */
  civic?: CapacityKind[];
  /** Slots the row is shifted right by, to centre it under a wider grid. */
  shift: number;
}

/** The capacity houses as plans. Each is a fixed size (the Seats hall always has 200 seats). */
function civicPlans(): HousePlan[] {
  return CAPACITY_KINDS.map((kind) => ({ key: capacityKey(kind), label: CAPACITY_LABEL[kind], seats: 0, subSeats: 0, hasIde: false }));
}

/** Interior height of a capacity house. */
function civicHeight(kind: CapacityKind): number {
  return kind === "seats" ? SEATS_H : CIVIC_LOW_H;
}

/**
 * Deterministic village layout for `plans` (in the given order). With `capacity`, a CIVIC ROW of
 * three capacity houses — Seats, Memory, Usage — faces the plaza from the north (the grid is at
 * least three houses wide then, and narrower project rows are centred on it); without it the
 * layout is exactly the plain village.
 */
export function buildWorld(plans: HousePlan[], capacity?: CapacityLayout): World {
  const n = plans.length;
  const perRow = Math.max(1, Math.ceil(Math.sqrt(n)));
  const houseRows = Math.ceil(n / perRow);
  const plazaAfter = Math.ceil(houseRows / 2);
  const civic = capacity ? civicPlans() : null;
  const gridPerRow = civic ? Math.max(perRow, civic.length) : perRow;

  const baseW = 5 + SLOT * gridPerRow;
  const cols = Math.max(baseW, MIN_WIDTH);
  const xOff = Math.floor((cols - baseW) / 2);
  const roadCols: number[] = [];
  for (let i = 0; i <= gridPerRow; i++) roadCols.push(xOff + 2 + SLOT * i);

  // ── vertical plan: where each house row, the civic row and the plaza band sit ──
  const rowPlans: GridRow[] = [];
  let y = TOP_MARGIN;
  let plazaTop = 0;
  const pushRow = (members: HousePlan[], heights: number[], width: number, kinds?: CapacityKind[]): void => {
    const outerH = Math.max(...heights) + 2;
    rowPlans.push({ top: y, bottom: y + outerH - 1, plans: members, shift: Math.floor((gridPerRow - width) / 2), ...(kinds && { civic: kinds }) });
    // bottom wall, yard, road, one grass row for the next roofline
    y += outerH + 3;
  };
  // plazaAfter ≤ houseRows, so the band is always placed (after the last row when there are 0–1 rows).
  for (let r = 0; r <= houseRows; r++) {
    if (r === plazaAfter) {
      if (civic) pushRow(civic, CAPACITY_KINDS.map((kind) => civicHeight(kind)), civic.length, [...CAPACITY_KINDS]);
      plazaTop = y;
      y += PLAZA_BAND;
    }
    if (r === houseRows) break;
    const members = plans.slice(r * perRow, (r + 1) * perRow);
    pushRow(
      members,
      members.map((p) => interiorHeight(p)),
      perRow,
    );
  }
  const rows = y + BOTTOM_MARGIN;

  const tiles = new Array<TileKind>(cols * rows).fill("grass");
  const set = (c: number, r: number, k: TileKind) => {
    tiles[r * cols + c] = k;
  };
  const props: Prop[] = [];
  const seats: Seat[] = [];
  const houses: House[] = [];

  // ── roads ──
  for (const rc of roadCols) for (let r = TOP_MARGIN; r < rows - BOTTOM_MARGIN; r++) set(rc, r, "path");
  const firstRoad = roadCols[0];
  const lastRoad = roadCols[roadCols.length - 1];
  for (const rp of rowPlans) for (let c = firstRoad; c <= lastRoad; c++) set(c, rp.bottom + 2, "path");

  // ── plaza band ──
  const cx = Math.floor(cols / 2);
  for (let c = firstRoad; c <= lastRoad; c++) set(c, plazaTop + 5, "path");
  for (let r = plazaTop + 1; r <= plazaTop + 8; r++)
    for (let c = cx - PLAZA_HALF; c <= cx + PLAZA_HALF; c++) set(c, r, "plaza");
  const plaza = { col: cx, row: plazaTop + 6 };
  props.push({ id: "plaza:fountain", kind: "fountain", col: cx - 1, row: plazaTop + 2, w: 3, h: 3 });
  props.push({ id: "plaza:campfire", kind: "campfire", col: cx + 4, row: plazaTop + 6, w: 1, h: 1 });
  const lampSpots: [number, number][] = [
    [cx - PLAZA_HALF, plazaTop + 1],
    [cx + PLAZA_HALF, plazaTop + 1],
    [cx - PLAZA_HALF, plazaTop + 8],
    [cx + PLAZA_HALF, plazaTop + 8],
  ];
  lampSpots.forEach(([c, r], i) => props.push({ id: `plaza:lamp:${i}`, kind: "lamp", col: c, row: r, w: 1, h: 1 }));

  // A little 3×2 pond east of the plaza, slid right until it sits on clean grass.
  for (let pc = cx + PLAZA_HALF + 2; pc + 2 < cols - 2; pc++) {
    let clear = true;
    for (let r = plazaTop + 7; r <= plazaTop + 8; r++)
      for (let c = pc; c < pc + 3; c++) if (tiles[r * cols + c] !== "grass") clear = false;
    if (clear) {
      for (let r = plazaTop + 7; r <= plazaTop + 8; r++) for (let c = pc; c < pc + 3; c++) set(c, r, "water");
      break;
    }
  }

  // ── houses ──
  for (const rp of rowPlans) {
    rp.plans.forEach((plan, j) => {
      const kind = rp.civic?.[j];
      const ih = kind ? civicHeight(kind) : interiorHeight(plan);
      const hc = xOff + 5 + SLOT * (j + rp.shift);
      const hr = rp.bottom - ih;
      const doorCol = hc + DOOR_OFFSET;
      const doorRow = hr + ih;
      for (let r = hr - 1; r <= doorRow; r++)
        for (let c = hc - 1; c <= hc + IW; c++) {
          const edge = r === hr - 1 || r === doorRow || c === hc - 1 || c === hc + IW;
          set(c, r, edge ? "wall" : "floor");
        }
      set(doorCol, doorRow, "floor");
      set(doorCol, doorRow + 1, "path");
      houses.push({
        key: plan.key,
        label: plan.label,
        col: hc,
        row: hr,
        w: IW,
        h: ih,
        doorCol,
        doorRow,
        hasIde: plan.hasIde,
        ...(kind && { capacity: kind }),
      });
      const k = plan.key;
      props.push({ id: `${k}:sign`, kind: "sign", col: doorCol + 1, row: doorRow + 1, w: 1, h: 1 });

      // decor along the top wall
      props.push({ id: `${k}:plant:0`, kind: "plant", col: hc, row: hr, w: 1, h: 1 });
      props.push({ id: `${k}:bookshelf:0`, kind: "bookshelf", col: hc + 1, row: hr, w: 2, h: 1 });
      props.push({ id: `${k}:bookshelf:1`, kind: "bookshelf", col: hc + 10, row: hr, w: 2, h: 1 });
      props.push({ id: `${k}:plant:1`, kind: "plant", col: hc + 12, row: hr, w: 1, h: 1 });

      // A project room with team tables gets its Wi-Fi router (engine/teamLan.ts cables the team's
      // laptops and PCs to it; the root talks to it over the air): the Seats switch's spot — the door
      // column on the decor row, always clear. Not blocking, so the door column stays walkable.
      if (!kind && plan.subSeats > 0) props.push({ id: `${k}:router`, kind: "router", col: hc + DOOR_OFFSET, row: hr, w: 1, h: 1 });

      if (kind) {
        furnishCivic(props, kind, k, hc, hr);
        props.push({ id: `${k}:sofa`, kind: "sofa", col: hc, row: doorRow - 1, w: 2, h: 1 });
        props.push({ id: `${k}:bin`, kind: "bin", col: hc + 12, row: doorRow - 1, w: 1, h: 1 });
        return;
      }

      // workstations
      const blocks = deskBlocks(plan.seats);
      for (let b = 0; b < blocks; b++) {
        const dr = hr + 2 + 3 * b;
        DESK_OFFSETS.forEach((off, d) => {
          const i = b * SEAT_BLOCK + d;
          const dc = hc + off;
          const pcId = `${k}:pc:${i}`;
          const seatId = `${k}:seat:${i}`;
          props.push({ id: `${k}:desk:${i}`, kind: "desk", col: dc, row: dr, w: 2, h: 1 });
          props.push({ id: pcId, kind: "pc", col: dc, row: dr, w: 1, h: 1, seatId });
          if (i % 2 === 1) props.push({ id: `${k}:coffee:${i}`, kind: "coffee", col: dc + 1, row: dr, w: 1, h: 1 });
          props.push({ id: `${k}:chair:${i}`, kind: "chair", col: dc, row: dr + 1, w: 1, h: 1, facing: "up" });
          seats.push({ id: seatId, houseKey: k, col: dc, row: dr + 1, facing: "up", pcId });
        });
      }

      // team tables: one seat + laptop per sub-agent
      const tablesTop = hr + 2 + 3 * blocks;
      for (let t = 0; t * SEAT_BLOCK < plan.subSeats; t++) {
        const top = tablesTop + TEAM_ROW_H * Math.floor(t / TABLES_PER_ROW);
        const tc = hc + TABLE_OFFSETS[t % TABLES_PER_ROW];
        const tr = top + 1;
        props.push({ id: `${k}:table:${t}`, kind: "table", col: tc, row: tr, w: TEAM_TABLE_W, h: TEAM_TABLE_H });
        // seats 0,1 above (facing down), 2,3 below (facing up); left then right
        const spots: [number, number, number, Dir][] = [
          [tc, top, tr, "down"],
          [tc + 2, top, tr, "down"],
          [tc, tr + TEAM_TABLE_H, tr + TEAM_TABLE_H - 1, "up"],
          [tc + 2, tr + TEAM_TABLE_H, tr + TEAM_TABLE_H - 1, "up"],
        ];
        spots.forEach(([col, row, lapRow, facing], s) => {
          const i = t * SEAT_BLOCK + s;
          const seatId = `${k}:subseat:${i}`;
          const pcId = `${k}:laptop:${i}`;
          props.push({ id: `${k}:subchair:${i}`, kind: "chair", col, row, w: 1, h: 1, facing });
          props.push({ id: pcId, kind: "laptop", col, row: lapRow, w: 1, h: 1, facing, seatId });
          seats.push({ id: seatId, houseKey: k, col, row, facing, pcId, forSub: true });
        });
      }

      // lounge corner along the bottom wall
      props.push({ id: `${k}:sofa`, kind: "sofa", col: hc, row: doorRow - 1, w: 2, h: 1 });
      props.push({ id: `${k}:bin`, kind: "bin", col: hc + 12, row: doorRow - 1, w: 1, h: 1 });
    });
  }

  // ── trees: scattered on open grass, never touching a road, wall, plaza or prop ──
  const occupied = new Uint8Array(cols * rows);
  for (const p of props) for (let r = p.row; r < p.row + p.h; r++) for (let c = p.col; c < p.col + p.w; c++) occupied[r * cols + c] = 1;
  const clearGrass = (c: number, r: number) =>
    c < 0 || r < 0 || c >= cols || r >= rows || (tiles[r * cols + c] === "grass" && occupied[r * cols + c] === 0);
  // From row 1: a tree's canopy reaches a few px above its footprint, and on row 0 it
  // would poke out over the top edge of the map.
  for (let r = 1; r + 1 < rows; r++)
    for (let c = 0; c + 1 < cols; c++) {
      if (hash2(c, r) % 5 !== 0) continue;
      let ok = true;
      for (let rr = r - 1; rr <= r + 2 && ok; rr++) for (let cc = c - 1; cc <= c + 2 && ok; cc++) ok = clearGrass(cc, rr);
      if (!ok) continue;
      props.push({ id: `tree:${c},${r}`, kind: "tree", col: c, row: r, w: 2, h: 2 });
      for (let rr = r; rr <= r + 1; rr++) for (let cc = c; cc <= c + 1; cc++) occupied[rr * cols + cc] = 1;
    }

  return { cols, rows, tiles, houses, props, seats, plaza };
}

/**
 * A capacity house's furniture. Seats: the HALL — the whole interior under the decor row, its 200
 * seats painted by the frame (render/hall.ts: the selected agent's context window, a character in
 * its category's colour on every taken seat). Memory: a row of server racks. Usage: two gauges, the
 * 5-hour window and the week.
 */
function furnishCivic(props: Prop[], kind: CapacityKind, k: string, hc: number, hr: number): void {
  if (kind === "seats") {
    props.push({ id: `${k}:hall`, kind: "hall", col: hc, row: hr + 1, w: IW, h: HALL_H, capacity: kind });
    return;
  }
  if (kind === "memory") {
    RACK_OFFSETS.forEach((off, i) =>
      props.push({ id: `${k}:rack:${i}`, kind: "rack", col: hc + off, row: hr + 3, w: 1, h: 1, capacity: kind, index: i }),
    );
    return;
  }
  GAUGE_OFFSETS.forEach((off, i) =>
    props.push({ id: `${k}:gauge:${i}`, kind: "gauge", col: hc + off, row: hr + 3, w: 2, h: 1, capacity: kind, index: i }),
  );
}

// ───────────────────────────── walkability ─────────────────────────────

const WALKABLE_TILES = new Set<TileKind>(["grass", "path", "floor", "plaza"]);

/** Cached per World object: 1 = a character may stand here. Props must lie in bounds. */
const gridCache = new WeakMap<World, Uint8Array>();

/** Row-major walkability grid (tile walkable and not under a blocking prop). Cached per World. */
export function walkGrid(world: World): Uint8Array {
  let grid = gridCache.get(world);
  if (grid) return grid;
  const { cols, rows, tiles } = world;
  grid = new Uint8Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = WALKABLE_TILES.has(tiles[i]) ? 1 : 0;
  for (const p of world.props) {
    if (!BLOCKING.has(p.kind)) continue;
    for (let r = p.row; r < p.row + p.h; r++)
      for (let c = p.col; c < p.col + p.w; c++) grid[r * cols + c] = 0;
  }
  gridCache.set(world, grid);
  return grid;
}

/** True when a character may stand on (col,row): in bounds, a walkable tile, no blocking prop. */
export function walkable(world: World, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= world.cols || row >= world.rows) return false;
  return walkGrid(world)[row * world.cols + col] === 1;
}

// ───────────────────────────── indoors ─────────────────────────────

/** Cached per World object: 1 = inside some house (interior rect or its door tile). */
const indoorCache = new WeakMap<World, Uint8Array>();

function indoorGrid(world: World): Uint8Array {
  const cached = indoorCache.get(world);
  if (cached) return cached;
  const { cols } = world;
  const grid = new Uint8Array(cols * world.rows);
  const mark = (c: number, r: number) => {
    if (c >= 0 && r >= 0 && c < cols && r < world.rows) grid[r * cols + c] = 1;
  };
  for (const h of world.houses) {
    for (let r = h.row; r < h.row + h.h; r++) for (let c = h.col; c < h.col + h.w; c++) mark(c, r);
    mark(h.doorCol, h.doorRow);
  }
  // A city is seen from the side: a building's walls and slabs are its facade, and no rain
  // falls through one — the whole shell is indoors, except its top row: the roof, where
  // rain lands.
  for (const b of world.city?.buildings ?? [])
    for (let r = b.row + 1; r < b.row + b.h; r++) for (let c = b.col; c < b.col + b.w; c++) mark(c, r);
  indoorCache.set(world, grid);
  return grid;
}

/**
 * True when (col,row) is indoors: inside some house's interior rect, or its door
 * tile — in a city, anywhere inside a building's shell below its roof. Walls and everything else are
 * outdoors (rain falls on the roof walls, not on the floor). Out of bounds → false. The
 * weather never draws on indoor tiles, and in bad weather idle agents only wander among them.
 */
export function isIndoorTile(world: World, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= world.cols || row >= world.rows) return false;
  return indoorGrid(world)[row * world.cols + col] === 1;
}

/**
 * A hot-path "is world px (wx, wy) indoors?" test for ONE world: the grid is looked
 * up once here, not per call (the weather fx asks ~1000× a frame). Same answers as
 * `isIndoorTile` on the tile under the point.
 */
export function indoorTest(world: World): (wx: number, wy: number) => boolean {
  const grid = indoorGrid(world);
  const { cols, rows } = world;
  return (wx, wy) => {
    const c = Math.floor(wx / TILE);
    const r = Math.floor(wy / TILE);
    return c >= 0 && r >= 0 && c < cols && r < rows && grid[r * cols + c] === 1;
  };
}
