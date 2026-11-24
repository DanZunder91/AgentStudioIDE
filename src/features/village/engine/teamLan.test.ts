import { afterEach, describe, expect, it, vi } from "vitest";

import { TILE, type House, type LanEvent, type Prop, type SeatedAgent, type VillageActivity, type VillageAgent, type World } from "../villageTypes";
import { drawProp } from "../render/props";
import type { SpriteBank } from "../render/renderTypes";
import { recorder } from "../render/testRecorder";
import { UP_LAPTOP_LIFT } from "../render/props";
import { buildCityWorld, floorKey, planCity } from "./city";
import { MAX_TRIP, type CableRun, type LanPacket, type LanPoint } from "./lan";
import { hashString } from "./rng";
import { ANTENNA_RISE, LAPTOP_LIFT, teamLanTraffic, teamLanWiring, type TeamLanTraffic, type TeamRoomWiring, type WifiPulse } from "./teamLan";
import { buildWorld, planHouses } from "./world";

// ───────────────────────────── fixtures ─────────────────────────────

function agent(key: string, folder: string, parentKey: string | null = null): VillageAgent {
  return { key, parentKey, origin: "external", title: key, folder, activity: "typing", tool: null, ideAgentId: null, lastActivityAt: null };
}
const subs = (root: string, folder: string, n: number): VillageAgent[] => Array.from({ length: n }, (_, i) => agent(`${root}.${i}`, folder, root));

/**
 * Village: alpha — two roots, 6 sub-agents (8 team seats: two tables, one team row); beta — one root,
 * 13 sub-agents and a sub-agent of a sub-agent (16 seats: four tables, two team rows); delta — 2
 * sub-agents (one table: a branch that stops at the door column); gamma — no sub-agents, no router.
 */
const VILLAGE_AGENTS = [
  agent("a", "alpha"),
  agent("a2", "alpha"),
  ...subs("a", "alpha", 5),
  ...subs("a2", "alpha", 1),
  agent("b", "beta"),
  ...subs("b", "beta", 13),
  agent("b.0.x", "beta", "b.0"),
  agent("d", "delta"),
  ...subs("d", "delta", 2),
  agent("g", "gamma"),
];
/** City: proj — leader L with 13 sub-agents (14 team PCs, one desk row, on every floor) and leader M with none; quiet — no team. */
const CITY_AGENTS = [agent("L", "proj"), ...subs("L", "proj", 13), agent("M", "proj"), agent("Q", "quiet")];
/**
 * City, several desk rows (after every 10 tables, continue vertically): tall — leader T
 * with `n` sub-agents and leader U with one, so BOTH floors have `n` rounded up to desks of two, in
 * rows of 20 seats; short — one desk row.
 */
const rowsAgents = (n: number): VillageAgent[] => [
  agent("T", "tall"),
  ...subs("T", "tall", n),
  agent("U", "tall"),
  ...subs("U", "tall", 1),
  agent("V", "short"),
  ...subs("V", "short", 3),
];

/**
 * Interior offsets: the door column the village router hangs in; the city router's column (over the
 * end of the leader's desk) and the building's lift, the column right of it (the street door's).
 */
const DOOR = 6;
const ROUTER = 3;
const LIFT = 4;
/** Team seats per city desk row, and the rows between two desk rows (an aisle, the desks, the chairs). */
const ROW_SEATS = 20;
const PITCH = 3;

const hasTeam = (w: World, h: House): boolean => w.seats.some((s) => s.houseKey === h.key && s.forSub);
const noRouters = (w: World): World => ({ ...w, props: w.props.filter((p) => p.kind !== "router") });

/** The router the contract puts in every project room with a team seat. */
function contractRouters(w: World): Prop[] {
  return w.houses
    .filter((h) => !h.capacity && hasTeam(w, h))
    .map((h) => ({ id: `${h.key}:router`, kind: "router" as const, col: h.col + (w.city ? ROUTER : DOOR), row: h.row + (w.city ? 1 : 0), w: 1, h: 1 }));
}

/** A copy of a real built world whose routers are exactly the contract's (whatever the builder does). */
const withRouters = (w: World): World => ({ ...w, props: [...noRouters(w).props, ...contractRouters(w)] });

const village = (): World => withRouters(buildWorld(planHouses(VILLAGE_AGENTS)));
const city = (): World => withRouters(buildCityWorld(planCity(CITY_AGENTS).plans));
const tall = (n: number): World => withRouters(buildCityWorld(planCity(rowsAgents(n)).plans, { seats: 6 }));

const mid = (col: number): number => col * TILE + TILE / 2;
const house = (w: World, key: string): House => w.houses.find((h) => h.key === key) as House;
const roomOf = (wiring: TeamRoomWiring[], key: string): TeamRoomWiring => wiring.find((r) => r.room === key) as TeamRoomWiring;
const propById = (w: World, id: string): Prop => w.props.find((p) => p.id === id) as Prop;

/** The leg p→q lies on run r (same line, inside its extent). */
function legOnRun(p: LanPoint, q: LanPoint, r: CableRun): boolean {
  if (p.x === q.x) return r.x0 === r.x1 && r.x0 === p.x && Math.min(p.y, q.y) >= r.y0 && Math.max(p.y, q.y) <= r.y1;
  return r.y0 === r.y1 && r.y0 === p.y && Math.min(p.x, q.x) >= r.x0 && Math.max(p.x, q.x) <= r.x1;
}

/** Length two runs share (0 unless collinear and overlapping). */
function shared(a: CableRun, b: CableRun): number {
  if (a.x0 === a.x1 && b.x0 === b.x1 && a.x0 === b.x0) return Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  if (a.y0 === a.y1 && b.y0 === b.y1 && a.y0 === b.y0) return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  return 0;
}

/** The kind of tile under world px (x, y). */
const tileAt = (w: World, x: number, y: number) => w.tiles[Math.floor(y / TILE) * w.cols + Math.floor(x / TILE)];

/** Every world px along a run (or a straight segment), ends included. */
function along(x0: number, y0: number, x1: number, y1: number): LanPoint[] {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  return Array.from({ length: n + 1 }, (_, k) => ({ x: x0 + ((x1 - x0) * k) / Math.max(1, n), y: y0 + ((y1 - y0) * k) / Math.max(1, n) }));
}

/** Distance from p to the segment a→b. */
function toSegment(p: LanPoint, a: LanPoint, b: LanPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Every contract the wiring makes, against the world's real seats and props. */
function expectWellFormed(w: World, wiring: TeamRoomWiring[]): void {
  for (const room of wiring) {
    const h = house(w, room.room);
    const teamSeats = w.seats.filter((s) => s.houseKey === h.key && s.forSub);
    const bossSeats = w.seats.filter((s) => s.houseKey === h.key && !s.forSub && s.pcId !== null);
    expect(Object.keys(room.routes), room.room).toEqual(teamSeats.map((s) => s.id));
    expect(Object.keys(room.antennas), room.room).toEqual(bossSeats.map((s) => s.id));
    for (const seat of teamSeats) {
      const route = room.routes[seat.id];
      const pc = propById(w, seat.pcId as string);
      // The port: the PC's / laptop's tile centre column, first; the router's port, last.
      expect(route[0].x, seat.id).toBe(mid(pc.col));
      expect(route[route.length - 1], seat.id).toEqual(room.hub);
      for (let k = 1; k < route.length; k++) {
        const [p, q] = [route[k - 1], route[k]];
        expect(p.x === q.x && p.y === q.y, `${seat.id} leg ${k} has no length`).toBe(false);
        expect(p.x === q.x || p.y === q.y, `${seat.id} leg ${k} is diagonal`).toBe(true);
        expect(
          room.runs.some((r) => legOnRun(p, q, r)),
          `${seat.id} leg ${k} is off the cable`,
        ).toBe(true);
      }
    }
    const vertices = Object.values(room.routes).flat();
    room.runs.forEach((r, i) => {
      expect(r.x0 === r.x1 || r.y0 === r.y1, `${room.room} run ${i} is diagonal`).toBe(true);
      expect(r.x0 <= r.x1 && r.y0 <= r.y1, `${room.room} run ${i} is not normalised`).toBe(true);
      expect(r.x1 - r.x0 + r.y1 - r.y0, `${room.room} run ${i} has no length`).toBeGreaterThan(0);
      for (const end of [
        { x: r.x0, y: r.y0 },
        { x: r.x1, y: r.y1 },
      ])
        expect(
          vertices.some((v) => v.x === end.x && v.y === end.y),
          `${room.room} run ${i} dangles`,
        ).toBe(true);
      for (let j = i + 1; j < room.runs.length; j++) expect(shared(r, room.runs[j]), `${room.room} runs ${i} and ${j} overlap`).toBe(0);
      // Indoors on the floor, every px of it: never through a wall, never out of the room.
      for (const p of along(r.x0, r.y0, r.x1, r.y1)) {
        expect(tileAt(w, p.x, p.y), `${room.room} run ${i} at (${p.x}, ${p.y})`).toBe("floor");
        expect(p.x >= h.col * TILE && p.x < (h.col + h.w) * TILE && p.y >= h.row * TILE && p.y < (h.row + h.h) * TILE).toBe(true);
      }
    });
    // An air hop flies inside the room: every px between a boss's antenna and the router is its floor.
    for (const [id, a] of Object.entries(room.antennas))
      for (const p of along(a.x, a.y, room.hub.x, room.hub.y)) expect(tileAt(w, p.x, p.y), `${id}'s hop at (${p.x}, ${p.y})`).toBe("floor");
  }
}

const seat = (key: string, seatId: string, parentKey: string | null = null, activity: VillageActivity = "typing"): SeatedAgent => ({
  key,
  parentKey,
  activity,
  seatId,
});
const hueOf = (key: string): number => hashString(key) % 360;

// ───────────────────────────── wiring ─────────────────────────────

describe("the router contract", () => {
  it("the builders' own routers stand exactly where this file's tests put them (the seam)", () => {
    for (const w of [
      buildWorld(planHouses(VILLAGE_AGENTS)),
      buildCityWorld(planCity(CITY_AGENTS).plans),
      buildCityWorld(planCity(rowsAgents(45)).plans, { seats: 6 }),
    ]) {
      const own = w.props.filter((p) => p.kind === "router").sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(own).toEqual(contractRouters(w).sort((a, b) => (a.id < b.id ? -1 : 1)));
      expect(teamLanWiring(w)).toEqual(teamLanWiring(withRouters(w)));
    }
  });
});

describe("teamLanWiring — the village (top-down)", () => {
  /** Interior column offsets of a team row's two tables. */
  const TABLE_COLS = [1, 9];

  it.each([
    ["alpha", 8],
    ["beta", 16],
    ["delta", 4],
  ])("%s (%i team seats): a trunk down the door column, a branch along each table row's middle row, a drop to each laptop", (key, seats) => {
    const w = village();
    const h = house(w, key);
    const room = roomOf(teamLanWiring(w), key);
    const hub = { x: mid(h.col + DOOR), y: h.row * TILE + TILE / 2 };
    expect(room.hub).toEqual(hub);

    // One desk row (≤ 4 roots), so the first team row starts 5 rows into the room: decor, walkway, desks, chairs, walkway.
    const tablesTop = h.row + 5;
    const lap = (i: number) => {
      const t = Math.floor(i / 4);
      const s = i % 4;
      const top = tablesTop + 6 * Math.floor(t / 2);
      const tr = top + 1;
      return { col: h.col + TABLE_COLS[t % 2] + (s % 2) * 2, row: s < 2 ? tr : tr + 2, up: s >= 2, bus: (tr + 1) * TILE + TILE / 2 };
    };
    // The builder put the laptops where the layout says (so what follows is about the LAN).
    expect(
      w.props.filter((p) => p.kind === "laptop" && p.id.startsWith(`${key}:`)).map((p) => [p.id, p.col, p.row, p.facing]),
    ).toEqual(Array.from({ length: seats }, (_, i) => [`${key}:laptop:${i}`, lap(i).col, lap(i).row, lap(i).up ? "up" : "down"]));

    const port = (i: number) => ({ x: mid(lap(i).col), y: lap(i).row * TILE + TILE / 2 - (lap(i).up ? 12 : 0) });
    const rows = Math.ceil(seats / 8);
    const buses = Array.from({ length: rows }, (_, k) => {
      const xs = Array.from({ length: Math.min(8, seats - 8 * k) }, (_, j) => mid(lap(8 * k + j).col));
      const y = lap(8 * k).bus;
      return { x0: Math.min(hub.x, ...xs), y0: y, x1: Math.max(hub.x, ...xs), y1: y };
    });
    const trunk = { x0: hub.x, y0: hub.y, x1: hub.x, y1: buses[rows - 1].y0 };
    const drops = Array.from({ length: seats }, (_, i) => {
      const { x, y } = port(i);
      return { x0: x, y0: Math.min(y, lap(i).bus), x1: x, y1: Math.max(y, lap(i).bus) };
    });
    expect(room.runs).toEqual([trunk, ...buses, ...drops]);
    expect(room.routes).toEqual(
      Object.fromEntries(Array.from({ length: seats }, (_, i) => [`${key}:subseat:${i}`, [port(i), { x: port(i).x, y: lap(i).bus }, { x: hub.x, y: lap(i).bus }, hub]])),
    );
    expectWellFormed(w, teamLanWiring(w));
  });

  it("in numbers: the trunk crosses the desks to the first table row's middle; a lone table's branch stops at the door column", () => {
    const w = village();
    const alpha = roomOf(teamLanWiring(w), "alpha");
    const [trunk, branch, ...drops] = alpha.runs;
    // Router (decor row) → walkway, desks, chairs, walkway, the top chairs, the table's top row → its middle row.
    expect(trunk.y1 - trunk.y0).toBe(7 * TILE);
    expect(branch.x1 - branch.x0).toBe(10 * TILE); // the left table's left laptop (offset 1) → the right table's right one (11)
    // A laptop showing its keyboard (the sitter above) is 16 px above the branch; one showing its screen 4 px below.
    expect(drops.map((d) => d.y1 - d.y0)).toEqual([16, 16, 4, 4, 16, 16, 4, 4]);
    const delta = roomOf(teamLanWiring(w), "delta");
    expect(delta.runs[1].x1).toBe(delta.hub.x);
    expect(delta.runs[1].x0).toBe(delta.hub.x - 5 * TILE);
  });

  it("a table hides the cable it feeds: every drop, and the branch from the table's edge on, lies under it", () => {
    const w = village();
    for (const room of teamLanWiring(w)) {
      const tables = w.props.filter((p) => p.kind === "table" && p.id.startsWith(`${room.room}:`));
      const on = (t: Prop, x: number, y: number) => x >= t.col * TILE && x <= (t.col + t.w) * TILE && y >= t.row * TILE && y <= (t.row + t.h) * TILE;
      const under = (x: number, y: number) => tables.some((t) => on(t, x, y));
      for (const [id, route] of Object.entries(room.routes)) {
        const [port, onBus] = route;
        // The port, the drop and the point where it meets the branch: all on the table.
        for (const p of along(port.x, port.y, onBus.x, onBus.y)) expect(under(p.x, p.y), `${id} at (${p.x}, ${p.y})`).toBe(true);
        // The branch runs along the MIDDLE row of the laptop's own table: one table row above it, one below.
        const own = tables.filter((t) => on(t, port.x, port.y));
        expect(own, id).toHaveLength(1);
        expect(onBus.y, id).toBe((own[0].row + 1) * TILE + TILE / 2);
      }
      // What shows (not under a table) is in the aisle or the door column, never on a chair row.
      for (const r of room.runs)
        for (const p of along(r.x0, r.y0, r.x1, r.y1))
          if (!under(p.x, p.y)) expect(p.x === room.hub.x || tables.some((t) => p.y > t.row * TILE && p.y < (t.row + t.h) * TILE)).toBe(true);
    }
  });

  it("a boss's antenna is the top of its desk PC's art; a laptop's port is on the laptop the renderer draws", () => {
    const w = village();
    const bank = { furniture: () => ({ width: 16, height: 32 }) } as unknown as SpriteBank;
    const artBox = (p: Prop) => {
      const ctx = recorder();
      drawProp(ctx, { zoom: 1, ox: 0, oy: 0 }, { prop: p, on: false, frame: 0 }, bank, 0);
      const boxes = [
        ...ctx.of("fillRect").map((c) => c.args as number[]),
        ...ctx.of("drawImage").map((c) => (c.args as number[]).slice(5)),
      ];
      return {
        x0: Math.min(...boxes.map((b) => b[0])),
        x1: Math.max(...boxes.map((b) => b[0] + b[2])),
        y0: Math.min(...boxes.map((b) => b[1])),
        y1: Math.max(...boxes.map((b) => b[1] + b[3])),
      };
    };
    for (const room of teamLanWiring(w)) {
      for (const [id, a] of Object.entries(room.antennas)) {
        const pc = propById(w, w.seats.find((s) => s.id === id)?.pcId as string);
        expect(pc.kind).toBe("pc");
        const box = artBox(pc);
        expect(a).toEqual({ x: mid(pc.col), y: box.y0 });
        // (The PC sprite's top pixel row is opaque, so its blit box IS its art.)
        expect(a.y).toBe(pc.row * TILE - (ANTENNA_RISE.pc as number));
      }
      for (const [id, route] of Object.entries(room.routes)) {
        const lap = propById(w, w.seats.find((s) => s.id === id)?.pcId as string);
        const box = artBox(lap);
        expect(route[0].x > box.x0 && route[0].x < box.x1 && route[0].y > box.y0 && route[0].y < box.y1, `${id}'s port is off its laptop`).toBe(true);
      }
    }
    expect(LAPTOP_LIFT).toBe(UP_LAPTOP_LIFT);
  });

  it("is the same wiring whatever order the props come in, and rooms come in house order", () => {
    const w = village();
    expect(teamLanWiring(w).map((r) => r.room)).toEqual(["alpha", "beta", "delta"]);
    expect(w.houses.map((h) => h.key)).toEqual(["alpha", "beta", "delta", "gamma"]);
    expect(teamLanWiring({ ...w, props: [...w.props].reverse() })).toEqual(teamLanWiring(w));
  });

  it("is cached per World object — a hit, a miss, and an empty answer cached too", () => {
    const w = village();
    const wiring = teamLanWiring(w);
    expect(teamLanWiring(w)).toBe(wiring);
    const copy: World = { ...w };
    expect(teamLanWiring(copy)).not.toBe(wiring);
    expect(teamLanWiring(copy)).toEqual(wiring);
    // Worlds are immutable; mutating one here only makes the cache VISIBLE.
    const bare = noRouters(w);
    expect(teamLanWiring(bare)).toEqual([]);
    bare.props.push(...contractRouters(w));
    expect(teamLanWiring(bare)).toEqual([]);
    expect(teamLanWiring({ ...bare })).toEqual(wiring);
  });
});

describe("teamLanWiring — the city (side view)", () => {
  it("every one-row floor: one tray along the headroom row from the router, a drop to each PC — no trunk; the leader's antenna on its monitor", () => {
    // The wiring before the floors grew desk rows, the router one column further left now.
    const w = city();
    const wiring = teamLanWiring(w);
    expect(wiring.map((r) => r.room)).toEqual([floorKey("L"), floorKey("M")]);
    for (const room of wiring) {
      const f = house(w, room.room);
      const [H, A, B] = [f.row + 1, f.row + 2, f.row + 3];
      const hub = { x: mid(f.col + ROUTER), y: H * TILE + TILE / 2 };
      expect(room.hub).toEqual(hub);
      // 13 sub-agents → 14 team PCs on EVERY floor of the building, in desks of two, pitch 3, on row A.
      const pcCol = (i: number) => f.col + 5 + 3 * Math.floor(i / 2) + (i % 2);
      expect(w.props.filter((p) => p.kind === "pc" && p.id.startsWith(`${room.room}:`)).map((p) => [p.col, p.row])).toEqual(
        Array.from({ length: 14 }, (_, i) => [pcCol(i), A]),
      );
      const tray = { x0: hub.x, y0: hub.y, x1: mid(pcCol(13)), y1: hub.y };
      const drops = Array.from({ length: 14 }, (_, i) => ({ x0: mid(pcCol(i)), y0: hub.y, x1: mid(pcCol(i)), y1: A * TILE + 2 }));
      expect(room.runs).toEqual([tray, ...drops]);
      expect(room.routes).toEqual(
        Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`${room.room}:team:${i}`, [{ x: mid(pcCol(i)), y: A * TILE + 2 }, { x: mid(pcCol(i)), y: hub.y }, hub]])),
      );
      // The monitor stands on the big desk at (col + 1, B), beside the leader's chair (its keyboard is in
      // front of the chair); its back panel tops out 15 px above that tile.
      expect(room.antennas).toEqual({ [`${room.room}:lead`]: { x: mid(f.col + 1), y: B * TILE - 15 } });
      // In numbers: router (col + 3) → the last PC (col + 24) is 21 tiles of tray; each drop 10 px.
      expect([room.runs[0].x1 - room.runs[0].x0, room.runs[1].y1 - room.runs[1].y0]).toEqual([21 * TILE, 10]);
    }
    expectWellFormed(w, wiring);
  });

  /** Where city team seat `i` of floor `f` has its PC: desks of two at a pitch of 3, ROW_SEATS to a row, rows PITCH apart. */
  const pcAt = (f: House, i: number) => {
    const j = i % ROW_SEATS;
    return { col: f.col + 5 + 3 * Math.floor(j / 2) + (j % 2), row: f.row + 2 + PITCH * Math.floor(i / ROW_SEATS) };
  };

  it.each([
    [21, 22, 2], // a second row of one desk
    [40, 40, 2], // two full rows
    [45, 46, 3],
  ])("%i sub-agents (%i seats, %i desk rows): the first row on the tray, each later row on its own bus in the aisle above it, a trunk down the router's column", (n, seats, rows) => {
    const w = tall(n);
    const wiring = teamLanWiring(w);
    expect(wiring.map((r) => r.room)).toEqual([floorKey("T"), floorKey("U"), floorKey("V")]);
    for (const room of wiring.slice(0, 2)) {
      const f = house(w, room.room);
      const H = f.row + 1;
      const hub = { x: mid(f.col + ROUTER), y: H * TILE + TILE / 2 };
      expect(room.hub).toEqual(hub);
      // The builder put the PCs where the layout says (so what follows is about the LAN).
      expect(w.props.filter((p) => p.kind === "pc" && p.id.startsWith(`${room.room}:`)).map((p) => [p.col, p.row])).toEqual(
        Array.from({ length: seats }, (_, i) => [pcAt(f, i).col, pcAt(f, i).row]),
      );
      const rowOf = (i: number) => Math.floor(i / ROW_SEATS);
      // Row 0: the tray at the router's own height. Row k: 4 px above its desk row's top edge.
      const busY = (k: number) => (k === 0 ? hub.y : pcAt(f, k * ROW_SEATS).row * TILE - 4);
      const port = (i: number) => ({ x: mid(pcAt(f, i).col), y: pcAt(f, i).row * TILE + 2 });
      const trunk = { x0: hub.x, y0: hub.y, x1: hub.x, y1: busY(rows - 1) };
      const buses = Array.from({ length: rows }, (_, k) => ({ x0: hub.x, y0: busY(k), x1: port(Math.min(seats, (k + 1) * ROW_SEATS) - 1).x, y1: busY(k) }));
      const drops = Array.from({ length: seats }, (_, i) => ({ x0: port(i).x, y0: busY(rowOf(i)), x1: port(i).x, y1: port(i).y }));
      expect(room.runs).toEqual([trunk, ...buses, ...drops]);
      expect(room.routes).toEqual(
        Object.fromEntries(
          Array.from({ length: seats }, (_, i) => {
            const y = busY(rowOf(i));
            return [`${room.room}:team:${i}`, rowOf(i) === 0 ? [port(i), { x: port(i).x, y }, hub] : [port(i), { x: port(i).x, y }, { x: hub.x, y }, hub]];
          }),
        ),
      );
      // A later row's seat goes up the TRUNK: its last leg runs straight up the router's column, past the tray.
      const second = room.routes[`${room.room}:team:${ROW_SEATS}`];
      expect(second.slice(-2).map((p) => p.x)).toEqual([hub.x, hub.x]);
      expect(second[second.length - 2].y - hub.y).toBe(PITCH * TILE + 4); // the headroom row's lower half, the desk and chair rows, the aisle row less 4 px
      expect(room.antennas).toEqual({ [`${room.room}:lead`]: { x: mid(f.col + 1), y: (f.row + 3) * TILE - 15 } });
    }
    // The one-row building next door: the tray alone, as ever.
    const short = wiring[2];
    expect(short.runs.filter((r) => r.y0 === r.y1)).toHaveLength(1);
    expect(short.runs.every((r) => r.y0 === r.y1 || r.y1 - r.y0 === 10)).toBe(true);
    expectWellFormed(w, wiring);
  });

  it("a later row's bus runs in the aisle row above its desks, clear of every prop; the trunk is the router's column, never the lift's", () => {
    const w = tall(45);
    for (const room of teamLanWiring(w).slice(0, 2)) {
      const f = house(w, room.room);
      const lift = w.city?.buildings.find((b) => b.floors.includes(room.room))?.lift;
      expect(lift?.col).toBe(f.col + LIFT);
      const liftX = (lift?.col as number) * TILE;
      // Vertical cable: the trunk and the drops — none of it inside the lift's column, where the car rides.
      const vertical = room.runs.filter((r) => r.x0 === r.x1);
      expect(vertical.filter((r) => r.x0 >= liftX && r.x0 < liftX + TILE)).toEqual([]);
      const trunk = vertical.find((r) => r.x0 === room.hub.x) as CableRun;
      expect(trunk.x0).toBe(mid(f.col + ROUTER));
      expect(trunk.y1 - trunk.y0).toBe(2 * PITCH * TILE + 4);
      const buses = room.runs.filter((r) => r.y0 === r.y1).slice(1);
      expect(buses).toHaveLength(2);
      for (const [k, bus] of buses.entries()) {
        const desks = f.row + 2 + PITCH * (k + 1);
        expect(Math.floor(bus.y0 / TILE), `bus ${k + 1}`).toBe(desks - 1);
        const onIt = w.props.filter((p) => p.row === desks - 1 && (p.col + p.w) * TILE > bus.x0 && p.col * TILE < bus.x1);
        expect(onIt, `bus ${k + 1}`).toEqual([]);
      }
    }
  });

  it("the leader's antenna is the top of the monitor art the renderer draws", () => {
    const w = city();
    const room = teamLanWiring(w)[0];
    const monitor = propById(w, `${room.room}:monitor`);
    const ctx = recorder();
    drawProp(ctx, { zoom: 1, ox: 0, oy: 0 }, { prop: monitor, on: false, frame: 0 }, null, 0);
    const top = Math.min(...ctx.of("fillRect").map((c) => (c.args as number[])[1]));
    expect(room.antennas[`${room.room}:lead`].y).toBe(top);
    expect(ANTENNA_RISE.monitor).toBe(monitor.row * TILE - top);
  });
});

describe("teamLanWiring — what gets no wiring", () => {
  it("no router, or no team seat: [] — a house / floor without sub-agents has neither", () => {
    expect(teamLanWiring(noRouters(village()))).toEqual([]);
    expect(teamLanWiring(noRouters(city()))).toEqual([]);
    const lonely = buildWorld(planHouses([agent("g", "gamma")]));
    expect(teamLanWiring(withRouters(lonely))).toEqual([]);
    // A router standing in a room with no team seats wires nothing.
    const g = house(village(), "gamma");
    const w = village();
    const stray: Prop = { id: "gamma:router", kind: "router", col: g.col + DOOR, row: g.row, w: 1, h: 1 };
    expect(teamLanWiring({ ...w, props: [...w.props, stray] })).toEqual(teamLanWiring(w));
    // Nor does one in the capacity HQ's Seats lounge (benches, no PC) or on its Memory floor: no seat is there at all.
    const hq = withRouters(buildCityWorld(planCity(CITY_AGENTS).plans, { seats: 6 }));
    const strays: Prop[] = (["seats", "memory"] as const).map((kind) => {
      const room = hq.houses.find((h) => h.capacity === kind) as House;
      expect(hq.seats.some((s) => s.houseKey === room.key)).toBe(false);
      return { id: `${room.key}:router`, kind: "router", col: room.col + 1, row: room.row + 1, w: 1, h: 1 };
    });
    expect(teamLanWiring({ ...hq, props: [...hq.props, ...strays] }).map((r) => r.room)).toEqual([floorKey("L"), floorKey("M")]);
  });

  it("a router only wires its OWN room: moved outside every house, or into the next house, it wires neither", () => {
    const w = village();
    const [alpha, gamma] = [house(w, "alpha"), house(w, "gamma")];
    for (const to of [
      { col: alpha.col - 3, row: alpha.row }, // the grass outside alpha's west wall
      { col: gamma.col + DOOR, row: gamma.row }, // gamma: a room with no team seats
    ]) {
      const moved = w.props.map((p) => (p.id === "alpha:router" ? { ...p, ...to } : p));
      expect(teamLanWiring({ ...w, props: moved }).map((r) => r.room)).toEqual(["beta", "delta"]);
    }
  });

  it("a team seat whose laptop is gone, stands outside the room, or stands on no table has no route — the rest keep theirs", () => {
    const w = village();
    const full = roomOf(teamLanWiring(w), "delta");
    const d = house(w, "delta");
    const variants: Prop[][] = [
      w.props.filter((p) => p.id !== "delta:laptop:1"),
      w.props.map((p) => (p.id === "delta:laptop:1" ? { ...p, col: d.col - 4 } : p)),
      w.props.map((p) => (p.id === "delta:laptop:1" ? { ...p, col: d.col + 6 } : p)), // the door column: no table there
    ];
    for (const props of variants) {
      const room = roomOf(teamLanWiring({ ...w, props }), "delta");
      expect(Object.keys(room.routes)).toEqual(["delta:subseat:0", "delta:subseat:2", "delta:subseat:3"]);
      expect(room.routes["delta:subseat:0"]).toEqual(full.routes["delta:subseat:0"]);
    }
    // Every laptop gone: no team seat routes, so the room is not wired at all.
    const none = w.props.filter((p) => !(p.kind === "laptop" && p.id.startsWith("delta:")));
    expect(teamLanWiring({ ...w, props: none }).map((r) => r.room)).toEqual(["alpha", "beta"]);
  });

  it("a city team PC standing on ANOTHER floor is not cabled across the slab (the city has no table to stop it)", () => {
    const c = city();
    const ground = house(c, floorKey("L"));
    // Straight up one floor: inside floor M's rect, nobody's PC there.
    const props = c.props.map((p) => (p.id === `${floorKey("L")}:pc:0` ? { ...p, row: p.row - 5 } : p));
    expect(house(c, floorKey("M")).row).toBe(ground.row - 5);
    const [l, m] = teamLanWiring({ ...c, props });
    const [intactL, intactM] = teamLanWiring(c);
    expect(Object.keys(l.routes)).toEqual(Array.from({ length: 13 }, (_, i) => `${floorKey("L")}:team:${i + 1}`));
    for (const id of Object.keys(l.routes)) expect(l.routes[id]).toEqual(intactL.routes[id]);
    expect(m).toEqual(intactM);
  });

  it("a boss seat with no PC (or none in the room) has no antenna; any other screen's antenna is its tile's top edge", () => {
    const w = village();
    const alpha = house(w, "alpha");
    const props = w.props
      .filter((p) => p.id !== "alpha:pc:1")
      .map((p) => (p.id === "alpha:pc:2" ? { ...p, kind: "laptop" as const } : p.id === "alpha:pc:0" ? { ...p, col: alpha.col - 3 } : p));
    const seats = w.seats.map((s) => (s.id === "alpha:seat:3" ? { ...s, pcId: null } : s));
    const room = roomOf(teamLanWiring({ ...w, props, seats }), "alpha");
    const pc2 = propById(w, "alpha:pc:2");
    // seat 0's PC stands outside the house now, seat 1's is gone, seat 3 has none.
    expect(room.antennas).toEqual({ "alpha:seat:2": { x: mid(pc2.col), y: pc2.row * TILE } });
    expect(Object.keys(roomOf(teamLanWiring(w), "alpha").antennas)).toEqual(["alpha:seat:0", "alpha:seat:1", "alpha:seat:2", "alpha:seat:3"]);
  });
});

// ───────────────────────────── traffic ─────────────────────────────

/**
 * A hand-made room "R": the router at (48, 0); team seat "p" 48 px left of it, team seat "c" 36 px
 * straight below it, team seat "c2" 48 px right of it; boss seat "B" whose antenna is 30 px left of
 * and 40 px above the router (a 50 px hop), boss seat "B2" 30 px right of and 40 px above it (another
 * 50 px hop). A second room "S" far to the right: team seat "s", boss seat "SB".
 */
const ROOM: TeamRoomWiring = {
  room: "R",
  hub: { x: 48, y: 0 },
  runs: [],
  routes: {
    p: [
      { x: 0, y: 0 },
      { x: 48, y: 0 },
    ],
    c: [
      { x: 48, y: 36 },
      { x: 48, y: 0 },
    ],
    c2: [
      { x: 96, y: 0 },
      { x: 48, y: 0 },
    ],
  },
  antennas: { B: { x: 18, y: -40 }, B2: { x: 78, y: -40 } },
};
const OTHER: TeamRoomWiring = {
  room: "S",
  hub: { x: 500, y: 0 },
  runs: [],
  routes: {
    s: [
      { x: 500, y: 30 },
      { x: 500, y: 0 },
    ],
  },
  antennas: { SB: { x: 470, y: -40 } },
};
const WIRING = [ROOM, OTHER];

/**
 * Who sits where: boss "b" (seat B) started "c" (seat c) and "q" (seat p); "q" started "c2" (seat c2);
 * boss "b2" (seat B2) has nobody; in room S, boss "o" started "s".
 */
const SEATED: SeatedAgent[] = [
  seat("b", "B"),
  seat("c", "c", "b"),
  seat("q", "p", "b"),
  seat("c2", "c2", "q"),
  seat("b2", "B2"),
  seat("o", "SB"),
  seat("s", "s", "o"),
];

const ev = (kind: LanEvent["kind"], key: string, at: number): LanEvent => ({ kind, key, at });
const traffic = (events: LanEvent[], t: number, seated: SeatedAgent[] = SEATED): TeamLanTraffic => teamLanTraffic(WIRING, seated, events, t);
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
/** Packets as [x, y, kind], rounded, for numbers worked out by hand. */
const where = (ps: LanPacket[]): [number, number, string][] => ps.map((p) => [r6(p.x), r6(p.y), p.kind]);
/** Pulses as [x, y, phase], rounded. */
const rings = (ws: WifiPulse[]): [number, number, number][] => ws.map((w) => [r6(w.x), r6(w.y), r6(w.phase)]);
const NOTHING = { packets: [], wifi: [], busy: new Set() };

describe("teamLanTraffic — a packet only for a real communication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no event, nothing: no packet, no Wi-Fi, no busy router — however hard everyone works", () => {
    const working = SEATED.map((a) => ({ ...a, activity: "typing" as const }));
    for (let t = -3; t < 30; t += 0.1) expect(traffic([], t, working)).toEqual(NOTHING);
    expect(teamLanTraffic([], SEATED, [ev("task", "c", 0)], 0.5)).toEqual(NOTHING);
  });

  it("a TASK from a boss flies OVER THE AIR from its antenna to the router, then runs down the child's cable", () => {
    // A 50 px hop + 36 px of cable = 86 px at 48 px/s, from t = 10.
    const at = (t: number) => traffic([ev("task", "c", 10)], t);
    expect(where(at(10).packets)).toEqual([[18, -40, "team"]]); // leaving the boss's antenna
    // 0.5 s: 24 px along the hop — 24/50 of (30, 40) from the antenna; both antennas pulse, 0.48 across.
    expect(where(at(10.5).packets)).toEqual([[32.4, -20.8, "team"]]);
    expect(rings(at(10.5).wifi)).toEqual([
      [48, 0, 0.48],
      [18, -40, 0.48],
    ]);
    expect(at(10.5).wifi.map((w) => w.hue)).toEqual([hueOf("b"), hueOf("b")]);
    // 1.5 s: 72 px — 22 px down the child's cable; off the air, so no Wi-Fi. The router is busy.
    expect(where(at(11.5).packets)).toEqual([[48, 22, "team"]]);
    expect(at(11.5).wifi).toEqual([]);
    expect(at(11.5).busy).toEqual(new Set(["R"]));
    expect(at(11.5).packets[0].hue).toBe(hueOf("b"));
    expect(at(11.8)).toEqual(NOTHING); // arrived at 86/48 s
  });

  it("a RESULT to a boss runs the same way back: up the child's cable, then over the air to its antenna", () => {
    const at = (t: number) => traffic([ev("result", "c", 10)], t);
    expect(where(at(10).packets)).toEqual([[48, 36, "team"]]); // leaving the child's port
    expect(where(at(10.25).packets)).toEqual([[48, 24, "team"]]);
    expect(at(10.25).wifi).toEqual([]); // still on cable
    // 1.5 s: 72 px — 36 px of cable, then 36 of the 50 px hop: 14 px short of the antenna.
    expect(where(at(11.5).packets)).toEqual([[26.4, -28.8, "team"]]);
    expect(rings(at(11.5).wifi)).toEqual([
      [48, 0, 0.72],
      [18, -40, 0.72],
    ]);
    expect(at(11.8)).toEqual(NOTHING);
  });

  it("between two sub-agents it is all cable: the parent's PC → the router → the child's PC, and no Wi-Fi", () => {
    // q (seat p) → c2: 48 + 48 = 96 px, 2 s.
    const task = (t: number) => traffic([ev("task", "c2", 0)], t);
    expect(where(task(0.25).packets)).toEqual([[12, 0, "team"]]);
    expect(where(task(1.5).packets)).toEqual([[72, 0, "team"]]);
    const result = (t: number) => traffic([ev("result", "c2", 0)], t);
    expect(where(result(0.25).packets)).toEqual([[84, 0, "team"]]);
    expect(where(result(1.5).packets)).toEqual([[24, 0, "team"]]);
    for (let t = 0; t < 2; t += 0.01)
      for (const tr of [task(t), result(t)]) {
        expect(tr.wifi, `${t}`).toEqual([]);
        expect(tr.packets).toHaveLength(1);
        expect(tr.packets[0].y).toBe(0);
        expect(tr.busy).toEqual(new Set(["R"]));
      }
  });

  it("a TOOL call is one round-trip to the router: on cable from a team seat, over the air both ways from a boss", () => {
    // c (a team seat): 36 px up, 36 px back, 1.5 s — never on the air.
    const c = (t: number) => traffic([ev("tool", "c", 5)], t);
    expect(where(c(5.25).packets)).toEqual([[48, 24, "uplink"]]);
    expect(where(c(6).packets)).toEqual([[48, 12, "uplink"]]);
    expect(c(6.5)).toEqual(NOTHING);
    for (let t = 5; t < 6.5; t += 0.01) expect(c(t).wifi).toEqual([]);
    // b (a boss): the 50 px hop out and back = 100 px in MAX_TRIP (50 px/s); both legs pulse.
    const b = (t: number) => traffic([ev("tool", "b", 5)], t);
    expect(where(b(5.4).packets)).toEqual([[30, -24, "uplink"]]); // going out: 20 px from the antenna
    expect(rings(b(5.4).wifi)).toEqual([
      [48, 0, 0.4],
      [18, -40, 0.4],
    ]);
    expect(where(b(6.2).packets)).toEqual([[42, -8, "uplink"]]); // coming back: 10 px from the router
    expect(rings(b(6.2).wifi)).toEqual([
      [48, 0, 0.2],
      [18, -40, 0.2],
    ]);
    expect(b(7)).toEqual(NOTHING);
    expect(b(6.2).packets[0].hue).toBe(hueOf("b"));
    for (let t = 5; t < 7; t += 0.01) expect(b(t).wifi, `${t}`).toHaveLength(2);
  });

  it("the trip window is [the event, its arrival): an instant early or on arrival, nothing — the future and the past are dark", () => {
    const task = [ev("task", "c2", 10)]; // all cable, 96 px: exactly 2 s
    expect(traffic(task, 10).packets).toHaveLength(1);
    expect(traffic(task, 10 - 1e-9)).toEqual(NOTHING);
    expect(traffic(task, 12 - 1e-9).packets).toHaveLength(1);
    expect(traffic(task, 12)).toEqual(NOTHING);
    for (const at of [-100, 3, 1e6]) expect(traffic([ev("tool", "b", at), ev("task", "c", at), ev("result", "s", at)], 20), `${at}`).toEqual(NOTHING);
  });

  it("Wi-Fi only while a packet is ON an air hop: a boss's task pulses on its hop, never on the cable", () => {
    let on = 0;
    let off = 0;
    for (let t = 10; t < 12; t += 0.01) {
      const tr = traffic([ev("task", "c", 10)], t);
      if (tr.packets.length === 0) {
        expect(tr.wifi).toEqual([]);
        continue;
      }
      const [p] = tr.packets;
      const onHop = toSegment(p, ROOM.antennas.B, ROOM.hub) < 1e-9 && p.y < 0;
      expect(tr.wifi.length, `${t}s at (${p.x}, ${p.y})`).toBe(onHop ? 2 : 0);
      for (const w of tr.wifi) expect(w.phase >= 0 && w.phase < 1, `${w.phase}`).toBe(true);
      if (onHop) on++;
      else off++;
    }
    expect([on > 50, off > 50]).toEqual([true, true]);
  });

  it("one pulse per antenna: a boss sending two tasks pulses once, the router serving two bosses once — the first packet sets it", () => {
    // At 0.3: b's task to c 14.4 px up its hop, b's task to q (98 px: 49 px/s) 9.8 px up it, b2's tool 15 px up B2's.
    const tr = traffic([ev("task", "c", 0), ev("task", "q", 0.1), ev("tool", "b2", 0)], 0.3);
    expect(tr.packets).toHaveLength(3);
    expect(rings(tr.wifi)).toEqual([
      [48, 0, 0.288],
      [18, -40, 0.288],
      [78, -40, 0.3],
    ]);
    expect(tr.wifi.map((w) => w.hue)).toEqual([hueOf("b"), hueOf("b"), hueOf("b2")]);
    // Two rooms: a router each, a boss each; both routers busy.
    const two = traffic([ev("task", "c", 0), ev("task", "s", 0)], 0.3);
    expect(two.wifi.map((w) => [w.x, w.y])).toEqual([
      [48, 0],
      [18, -40],
      [500, 0],
      [470, -40],
    ]);
    expect(two.busy).toEqual(new Set(["R", "S"]));
    expect(traffic([ev("task", "s", 0)], 0.3).busy).toEqual(new Set(["S"]));
  });

  it("one packet per event at most, in event order", () => {
    const events = [ev("tool", "c", 0), ev("task", "c2", 0.5), ev("result", "c", 1), ev("tool", "ghost", 0), ev("task", "s", 0.2)];
    for (let t = -1; t < 5; t += 0.05) {
      const underWay = events.filter((e) => t >= e.at && t < e.at + MAX_TRIP).length;
      expect(traffic(events, t).packets.length, `${t}`).toBeLessThanOrEqual(underWay);
    }
    // At 1.2: c's tool 57.6 px round (21.6 px back down), c2's task 33.6 px along q's cable, c's result
    // 9.6 px up, s's task 48 px along SB's 50 px hop (48/50 of (30, 40) from SB's antenna at (470, -40)).
    expect(where(traffic(events, 1.2).packets)).toEqual([
      [48, 21.6, "uplink"],
      [33.6, 0, "team"],
      [48, 26.4, "team"],
      [498.8, -1.6, "team"],
    ]);
  });

  it("on a floor of several desk rows, a later row's packet runs the cable: its drop, its row's bus, the trunk — the air only for the boss", () => {
    const w = tall(45);
    const wiring = teamLanWiring(w);
    const k = floorKey("T");
    const room = roomOf(wiring, k);
    const { hub } = room;
    // Seat 20 is row 2's first PC: 2 tiles right of the router; its bus 52 px under the hub (the wiring test's numbers).
    const bus2 = hub.y + 52;
    const port20 = { x: hub.x + 2 * TILE, y: bus2 + 6 };
    expect(room.routes[`${k}:team:20`]).toEqual([port20, { x: port20.x, y: bus2 }, { x: hub.x, y: bus2 }, hub]);
    const seated = [seat("T", `${k}:lead`), seat("a", `${k}:team:0`, "T"), seat("b", `${k}:team:20`, "a"), seat("c", `${k}:team:45`, "T")];
    const at = (e: LanEvent, t: number) => teamLanTraffic(wiring, seated, [e], t);
    // b's TOOL call: 90 px up (6 drop, 32 bus, 52 trunk) and 90 back, in MAX_TRIP — 90 px/s.
    const tool = ev("tool", "b", 0);
    expect(where(at(tool, 0).packets)).toEqual([[port20.x, port20.y, "uplink"]]);
    expect(where(at(tool, 0.25).packets)).toEqual([[port20.x - 16.5, bus2, "uplink"]]); // along its bus
    expect(where(at(tool, 0.5).packets)).toEqual([[hub.x, bus2 - 7, "uplink"]]); // up the trunk
    expect(where(at(tool, 1).packets)).toEqual([[hub.x, hub.y, "uplink"]]); // at the router
    expect(where(at(tool, 1.25).packets)).toEqual([[hub.x, hub.y + 22.5, "uplink"]]); // back down the trunk
    expect(at(tool, 1.25).busy).toEqual(new Set([k]));
    // a (row 1) → b (row 2), all cable: 42 px to the router, then 90 down b's way — 132 px at 66 px/s.
    // At 1 s: 24 px down the trunk, below the tray and above row 2's bus.
    const task = ev("task", "b", 0);
    expect(where(at(task, 1).packets)).toEqual([[hub.x, hub.y + 24, "team"]]);
    expect(where(at(task, 2 - 1e-9).packets).map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([[port20.x, port20.y]]);
    expect(at(task, 1).packets[0].hue).toBe(hueOf("T"));
    // The boss → c (row 3): over the air to the router, then cable all the way down to row 3; Wi-Fi only on the hop.
    const boss = ev("task", "c", 0);
    const port45 = room.routes[`${k}:team:45`][0];
    let air = 0;
    let trunk = 0;
    for (let t = 0; t < MAX_TRIP; t += 0.01) {
      const tr = at(boss, t);
      if (tr.packets.length === 0) continue;
      const [p] = tr.packets;
      const onHop = toSegment(p, room.antennas[`${k}:lead`], hub) < 1e-9;
      const onRun = room.runs.some((r) => p.x >= r.x0 - 1e-9 && p.x <= r.x1 + 1e-9 && p.y >= r.y0 - 1e-9 && p.y <= r.y1 + 1e-9);
      expect(onHop || onRun, `${t}s at (${p.x}, ${p.y})`).toBe(true);
      expect(tr.wifi.length, `${t}s`).toBe(onHop && (p.x !== hub.x || p.y !== hub.y) ? 2 : 0);
      if (onHop) air++;
      if (p.x === hub.x && p.y > bus2) trunk++; // down the trunk past row 2's bus, on to row 3's
    }
    expect([air > 10, trunk > 10]).toEqual([true, true]);
    const end = at(boss, MAX_TRIP - 1e-9).packets[0];
    expect([Math.round(end.x), Math.round(end.y)]).toEqual([port45.x, port45.y]);
  });

  it("no way, no packet: a task or a result needs the child on a team seat and its parent on another wired seat of the same room", () => {
    const cases: [string, SeatedAgent[], LanEvent[]][] = [
      ["nobody seated by that key", SEATED, [ev("tool", "ghost", 0), ev("task", "ghost", 0), ev("result", "ghost", 0)]],
      ["a root has no parent to hear from", SEATED, [ev("task", "b", 0), ev("result", "b2", 0)]],
      ["a root on a team seat", [seat("r", "c")], [ev("task", "r", 0), ev("result", "r", 0)]],
      ["the parent is not seated", [seat("x", "c", "gone")], [ev("task", "x", 0), ev("result", "x", 0)]],
      ["the parent sits in another room", [seat("o", "SB"), seat("x", "c", "o")], [ev("task", "x", 0), ev("result", "x", 0)]],
      ["its own parent", [seat("x", "c", "x")], [ev("task", "x", 0), ev("result", "x", 0)]],
      ["the parent on a seat with no wiring", [seat("p0", "nowhere"), seat("x", "c", "p0")], [ev("task", "x", 0), ev("result", "x", 0)]],
      ["the child on a boss seat", [seat("p0", "p"), seat("x", "B", "p0")], [ev("task", "x", 0), ev("result", "x", 0)]],
      ["the caller on a seat with no wiring", [seat("z", "nowhere")], [ev("tool", "z", 0)]],
    ];
    for (const [why, seated, events] of cases)
      for (let t = 0; t < MAX_TRIP; t += 0.05) expect(traffic(events, t, seated), `${why} at ${t}`).toEqual(NOTHING);
    // …yet each of those agents' own tool calls still run: the room's link is only for the pair.
    expect(where(traffic([ev("tool", "x", 0)], 0.25, [seat("o", "SB"), seat("x", "c", "o")]).packets)).toEqual([[48, 24, "uplink"]]);
    expect(where(traffic([ev("tool", "x", 0)], 0.25, [seat("x", "c", "x")]).packets)).toEqual([[48, 24, "uplink"]]);
    expect(traffic([ev("tool", "x", 0)], 0.25, [seat("p0", "p"), seat("x", "B", "p0")]).wifi).toHaveLength(2); // a boss seat: over the air
  });

  it("the hue is the topmost SEATED ancestor's — anywhere, not only in this room — and parents that loop share one", () => {
    const seated = [seat("top", "SB"), seat("mid", "p", "top"), seat("leaf", "c2", "mid")];
    const hues = (events: LanEvent[], s: SeatedAgent[]) => traffic(events, 0.5, s).packets.map((p) => p.hue);
    expect(hues([ev("task", "leaf", 0), ev("tool", "mid", 0), ev("tool", "top", 0)], seated)).toEqual([hueOf("top"), hueOf("top"), hueOf("top")]);
    // "gone" is not seated: s heads its own team.
    expect(hues([ev("task", "ss", 0)], [seat("s", "p", "gone"), seat("ss", "c", "s")])).toEqual([hueOf("s")]);
    // y ↔ x loop on two team seats: the loop's smallest key's hue.
    const loop = [seat("y", "p", "x"), seat("x", "c", "y")];
    expect(hues([ev("task", "y", 0), ev("result", "x", 0)], loop)).toEqual([hueOf("x"), hueOf("x")]);
    expect(new Set([hueOf("b"), hueOf("b2"), hueOf("top")]).size).toBe(3); // the precondition: distinct teams, distinct colours
  });

  it("on real rooms: every packet on a cable or an air hop, every pulse at a router or an antenna — the same every time, no clock, no randomness", () => {
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    for (const [w, seated] of [
      [
        village(),
        [
          seat("b", "beta:seat:0"),
          ...Array.from({ length: 15 }, (_, i) => seat(`b.${i}`, `beta:subseat:${i}`, i % 4 === 3 ? `b.${i - 1}` : "b", i % 2 ? "reading" : "typing")),
        ],
      ],
      [city(), [seat("L", `${floorKey("L")}:lead`), ...Array.from({ length: 14 }, (_, i) => seat(`L.${i}`, `${floorKey("L")}:team:${i}`, "L"))]],
      [
        tall(45),
        [
          seat("T", `${floorKey("T")}:lead`),
          ...Array.from({ length: 46 }, (_, i) => seat(`T.${i}`, `${floorKey("T")}:team:${i}`, i % 3 === 2 ? `T.${i - 21 < 0 ? i - 1 : i - 21}` : "T")),
        ],
      ],
    ] as [World, SeatedAgent[]][]) {
      const wiring = teamLanWiring(w);
      const room = wiring.find((r) => Object.keys(r.routes).includes(seated[1].seatId)) as TeamRoomWiring;
      const events = seated.flatMap((a, i) => [ev("tool", a.key, i * 0.3), ev("task", a.key, i * 0.45), ev("result", a.key, 7 + i * 0.4)]);
      const hubs = [room.hub, ...Object.values(room.antennas)];
      let seen = 0;
      let rang = 0;
      for (let t = -1; t < 16; t += 0.13) {
        const tr = teamLanTraffic(wiring, seated, events, t);
        expect(teamLanTraffic(wiring, seated, events, t)).toEqual(tr);
        expect(tr.packets.length).toBeLessThanOrEqual(events.filter((e) => t >= e.at && t < e.at + MAX_TRIP).length);
        expect([...tr.busy]).toEqual(tr.packets.length > 0 ? [room.room] : []);
        seen += tr.packets.length;
        rang += tr.wifi.length;
        for (const p of tr.packets) {
          const onRun = room.runs.some((r) => p.x >= r.x0 - 1e-9 && p.x <= r.x1 + 1e-9 && p.y >= r.y0 - 1e-9 && p.y <= r.y1 + 1e-9);
          const onHop = Object.values(room.antennas).some((a) => toSegment(p, a, room.hub) < 1e-9);
          expect(onRun || onHop, `(${p.x}, ${p.y}) at ${t}s`).toBe(true);
          expect(p.hue).toBe(hueOf(seated[0].key));
        }
        // Each pulse at a distinct antenna of the room; none without a packet in the air.
        expect(new Set(tr.wifi.map((p) => `${p.x},${p.y}`)).size).toBe(tr.wifi.length);
        for (const p of tr.wifi) {
          expect(hubs.some((h) => h.x === p.x && h.y === p.y)).toBe(true);
          expect(p.phase >= 0 && p.phase < 1).toBe(true);
        }
        if (tr.wifi.length > 0)
          expect(tr.packets.some((p) => Object.values(room.antennas).some((a) => toSegment(p, a, room.hub) < 1e-9 && (p.x !== room.hub.x || p.y !== room.hub.y)))).toBe(true);
      }
      expect([seen > seated.length, rang > 0]).toEqual([true, true]);
    }
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});
