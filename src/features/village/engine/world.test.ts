import { describe, expect, it } from "vitest";
import type { VillageAgent, World } from "../villageTypes";
import { findPath } from "./path";
import {
  buildWorld,
  CAPACITY_KINDS,
  capacityKey,
  HALL_H,
  isBlockingProp,
  isIndoorTile,
  planHouses,
  RACKS,
  rootOf,
  TEAM_TABLE_H,
  TEAM_TABLE_W,
  walkable,
  walkGrid,
  type HousePlan,
} from "./world";

function agent(key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "external",
    title: key,
    folder,
    activity: "idle",
    tool: null,
    ideAgentId: null,
    lastActivityAt: null,
    ...extra,
  };
}

function plans(n: number): HousePlan[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `proj-${String(i).padStart(2, "0")}`,
    label: `Project ${i}`,
    seats: 4 * (1 + (i % 3)),
    subSeats: 4 * (i % 4),
    hasIde: i % 4 === 0,
  }));
}

const kindAt = (w: World, c: number, r: number) => w.tiles[r * w.cols + c];

/** BFS restricted to path/plaza tiles that are walkable. */
function roadConnected(w: World, from: { col: number; row: number }, to: { col: number; row: number }): boolean {
  const seen = new Set<string>([`${from.col},${from.row}`]);
  const q = [from];
  while (q.length) {
    const t = q.shift()!;
    if (t.col === to.col && t.row === to.row) return true;
    for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const n = { col: t.col + dc, row: t.row + dr };
      const k = `${n.col},${n.row}`;
      if (seen.has(k) || !walkable(w, n.col, n.row)) continue;
      const kind = kindAt(w, n.col, n.row);
      if (kind !== "path" && kind !== "plaza") continue;
      seen.add(k);
      q.push(n);
    }
  }
  return false;
}

describe("planHouses", () => {
  it("returns one house per root folder, rounding root seats up to blocks of 4", () => {
    const got = planHouses([
      agent("a1", "alpha"),
      agent("a2", "alpha"),
      agent("a3", "alpha"),
      agent("a4", "alpha"),
      agent("a5", "alpha"),
      agent("sub", "alpha", { parentKey: "a1" }),
      agent("b1", "beta"),
      agent("g-sub", "gamma", { parentKey: "elsewhere" }),
    ]);
    expect(got).toEqual([
      { key: "alpha", label: "alpha", seats: 8, subSeats: 4, hasIde: false },
      { key: "beta", label: "beta", seats: 4, subSeats: 0, hasIde: false },
    ]);
  });

  it("never builds a house for a sub-agent's own folder", () => {
    // An IDE sub-agent in a worktree, and one whose parent later cd'd: both sit by
    // their parent, so neither folder may get an (unoccupiable) house.
    const got = planHouses([
      agent("root", "repo", { origin: "ide" }),
      agent("wt-sub", "repo-worktree", { parentKey: "root", origin: "ide" }),
      agent("old-sub", "before-cd", { parentKey: "root" }),
    ]);
    // …and both count towards the ROOT's house team tables.
    expect(got).toEqual([{ key: "repo", label: "repo", seats: 4, subSeats: 4, hasIde: true }]);
  });

  it("counts sub-agents (and theirs) into their root's house, in team-table blocks of 4", () => {
    const subs = (n: number, extra: VillageAgent[] = []) =>
      planHouses([
        agent("root", "home"),
        agent("other", "away"),
        ...Array.from({ length: n }, (_, i) => agent(`s${i}`, `wt-${i}`, { parentKey: "root" })),
        ...extra,
      ]).map((p) => [p.key, p.subSeats]);
    expect(subs(0)).toEqual([["away", 0], ["home", 0]]);
    expect([1, 4, 5, 8, 9].map((n) => subs(n)[1][1])).toEqual([4, 4, 8, 8, 12]);
    // a sub-agent of a sub-agent belongs to the same root house
    expect(subs(4, [agent("grand", "x", { parentKey: "s0" })])).toEqual([["away", 0], ["home", 8]]);
    // an unknown root, or a parent loop, counts nowhere
    const loop = [agent("l1", "x", { parentKey: "l2" }), agent("l2", "x", { parentKey: "l1" })];
    expect(subs(1, [agent("orphan", "x", { parentKey: "ghost" }), ...loop])).toEqual([["away", 0], ["home", 4]]);
  });

  it("rootOf walks parent chains and gives up on breaks and loops", () => {
    const m = new Map(
      [
        { key: "r", parentKey: null },
        { key: "a", parentKey: "r" },
        { key: "b", parentKey: "a" },
        { key: "x", parentKey: "y" },
        { key: "y", parentKey: "x" },
        { key: "o", parentKey: "ghost" },
      ].map((e) => [e.key, e]),
    );
    expect(rootOf(m.get("b")!, m)?.key).toBe("r");
    expect(rootOf(m.get("r")!, m)?.key).toBe("r");
    expect(rootOf(m.get("x")!, m)).toBeNull();
    expect(rootOf(m.get("o")!, m)).toBeNull();
  });

  it("sorts IDE houses first, then by code-unit order", () => {
    const got = planHouses([
      agent("1", "zeta"),
      agent("2", "Beta"),
      agent("3", "alpha"),
      agent("4", "mid", { origin: "ide" }),
      agent("5", "able", { origin: "ide" }),
      agent("6", "alpha"),
    ]);
    expect(got.map((p) => [p.key, p.hasIde])).toEqual([
      ["able", true],
      ["mid", true],
      ["Beta", false],
      ["alpha", false],
      ["zeta", false],
    ]);
    expect(planHouses([])).toEqual([]);
  });

  it("does not churn the seat count for every new agent", () => {
    const seatsFor = (n: number) => planHouses(Array.from({ length: n }, (_, i) => agent(`k${i}`, "f")))[0].seats;
    expect([1, 2, 3, 4, 5, 8, 9].map(seatsFor)).toEqual([4, 4, 4, 4, 8, 8, 12]);
  });
});

describe("buildWorld", () => {
  it.each([0, 1, 5, 20])("is deterministic for %i houses", (n) => {
    expect(buildWorld(plans(n))).toEqual(buildWorld(plans(n)));
  });

  it.each([0, 1, 5, 20])("connects every door to the plaza by road for %i houses", (n) => {
    const w = buildWorld(plans(n));
    expect(w.houses).toHaveLength(n);
    expect(walkable(w, w.plaza.col, w.plaza.row)).toBe(true);
    expect(kindAt(w, w.plaza.col, w.plaza.row)).toBe("plaza");
    for (const h of w.houses) {
      expect(kindAt(w, h.doorCol, h.doorRow)).toBe("floor");
      expect(kindAt(w, h.doorCol, h.doorRow + 1)).toBe("path");
      expect(roadConnected(w, { col: h.doorCol, row: h.doorRow + 1 }, w.plaza)).toBe(true);
      // and from inside the house, by any walkable route
      expect(findPath(w, { col: h.doorCol, row: h.doorRow - 1 }, w.plaza)).not.toBeNull();
    }
  });

  it.each([1, 5, 20])("encloses each of %i houses in walls with exactly one door gap", (n) => {
    const w = buildWorld(plans(n));
    for (const h of w.houses) {
      let gaps = 0;
      for (let r = h.row - 1; r <= h.row + h.h; r++)
        for (let c = h.col - 1; c <= h.col + h.w; c++) {
          const edge = r === h.row - 1 || r === h.row + h.h || c === h.col - 1 || c === h.col + h.w;
          const k = kindAt(w, c, r);
          if (!edge) expect(k).toBe("floor");
          else if (k !== "wall") {
            gaps++;
            expect([c, r]).toEqual([h.doorCol, h.doorRow]);
          }
        }
      expect(gaps).toBe(1);
      expect(h.doorRow).toBe(h.row + h.h);
    }
  });

  it("furnishes each house: seats with desk, pc and an up-facing chair, plus decor and a sign", () => {
    const ps = plans(5);
    const w = buildWorld(ps);
    for (const plan of ps) {
      const h = w.houses.find((x) => x.key === plan.key)!;
      expect(h.label).toBe(plan.label);
      expect(h.hasIde).toBe(plan.hasIde);
      const seats = w.seats.filter((s) => s.houseKey === plan.key && !s.forSub);
      expect(seats).toHaveLength(plan.seats);
      for (const s of seats) {
        expect(s.facing).toBe("up");
        const pc = w.props.find((p) => p.id === s.pcId)!;
        expect(pc).toMatchObject({ kind: "pc", seatId: s.id, col: s.col, row: s.row - 1 });
        const desk = w.props.find((p) => p.kind === "desk" && p.col === s.col && p.row === s.row - 1)!;
        expect(desk).toMatchObject({ w: 2, h: 1 });
        const chair = w.props.find((p) => p.kind === "chair" && p.col === s.col && p.row === s.row)!;
        expect(chair.facing).toBe("up");
        // The owner can always reach its chair from the door.
        expect(findPath(w, { col: h.doorCol, row: h.doorRow }, s, undefined, s)).not.toBeNull();
        // Inside the interior.
        expect(s.col).toBeGreaterThanOrEqual(h.col);
        expect(s.row).toBeLessThan(h.row + h.h);
      }
      const kinds = new Set(w.props.filter((p) => p.id.startsWith(`${plan.key}:`)).map((p) => p.kind));
      for (const k of ["plant", "bookshelf", "bin", "coffee", "sofa", "sign"] as const) expect(kinds.has(k)).toBe(true);
      const sign = w.props.find((p) => p.id === `${plan.key}:sign`)!;
      expect(sign).toMatchObject({ row: h.doorRow + 1, col: h.doorCol + 1 });
      expect(sign.label).toBeUndefined(); // the house name is drawn once, by the `house` label
    }
  });

  it("gives each house one team seat per sub seat: a chair, a laptop on a team table, reachable from the door", () => {
    const ps = plans(8);
    const w = buildWorld(ps);
    for (const plan of ps) {
      const h = w.houses.find((x) => x.key === plan.key)!;
      const subs = w.seats.filter((s) => s.houseKey === plan.key && s.forSub);
      expect(subs).toHaveLength(plan.subSeats);
      const tables = w.props.filter((p) => p.kind === "table" && p.id.startsWith(`${plan.key}:`));
      expect(tables).toHaveLength(plan.subSeats / 4);
      const laptops = new Set<string>();
      for (const s of subs) {
        expect(s.pcId).not.toBeNull();
        laptops.add(s.pcId!);
        const lap = w.props.find((p) => p.id === s.pcId)!;
        expect(lap).toMatchObject({ kind: "laptop", seatId: s.id, col: s.col, facing: s.facing, w: 1, h: 1 });
        const chair = w.props.find((p) => p.kind === "chair" && p.col === s.col && p.row === s.row)!;
        expect(chair.facing).toBe(s.facing);
        // the laptop sits on a table, on the edge row facing its seat
        const table = tables.find((t) => lap.col >= t.col && lap.col < t.col + t.w && lap.row >= t.row && lap.row < t.row + t.h)!;
        expect(table).toMatchObject({ w: TEAM_TABLE_W, h: TEAM_TABLE_H });
        if (s.facing === "down") expect([lap.row, s.row]).toEqual([table.row, table.row - 1]);
        else {
          expect(s.facing).toBe("up");
          expect([lap.row, s.row]).toEqual([table.row + TEAM_TABLE_H - 1, table.row + TEAM_TABLE_H]);
        }
        expect(findPath(w, { col: h.doorCol, row: h.doorRow }, s, undefined, s)).not.toBeNull();
        expect(s.row).toBeLessThan(h.row + h.h - 1); // above the sofa row
      }
      expect(laptops.size).toBe(subs.length);
      // the door column stays clear all the way up
      for (let r = h.row + 1; r < h.doorRow; r++) expect(walkable(w, h.doorCol, r)).toBe(true);
    }
    // the desks keep their ids and places whatever the team tables do
    const bare = buildWorld([{ key: "x", label: "x", seats: 4, subSeats: 0, hasIde: false }]);
    const team = buildWorld([{ key: "x", label: "x", seats: 4, subSeats: 12, hasIde: false }]);
    expect(team.seats.filter((s) => !s.forSub).map((s) => s.id)).toEqual(bare.seats.map((s) => s.id));
    expect(bare.props.some((p) => p.kind === "table" || p.kind === "laptop")).toBe(false);
    // 4 and 8 sub seats share one team row; 12 needs a second
    const rowsFor = (n: number) => buildWorld([{ key: "x", label: "x", seats: 4, subSeats: n, hasIde: false }]).houses[0].h;
    expect([0, 4, 8, 12].map(rowsFor)).toEqual([6, 12, 12, 18]);
  });

  it("decorates the village: fountain, campfire, lamps, trees and a pond", () => {
    for (const n of [0, 1, 5, 20]) {
      const w = buildWorld(plans(n));
      const count = (k: string) => w.props.filter((p) => p.kind === k).length;
      expect(w.props.find((p) => p.kind === "fountain")).toMatchObject({ w: 3, h: 3 });
      expect(count("campfire")).toBe(1);
      expect(count("lamp")).toBe(4);
      expect(count("tree")).toBeGreaterThan(3);
      expect(w.tiles.filter((t) => t === "water")).toHaveLength(6);
      for (const p of w.props.filter((x) => x.kind === "tree")) {
        // The canopy overhangs its footprint upward: never from the top row, off the map.
        expect(p.row).toBeGreaterThanOrEqual(1);
        for (let r = p.row; r < p.row + 2; r++) for (let c = p.col; c < p.col + 2; c++) expect(kindAt(w, c, r)).toBe("grass");
      }
    }
  });

  it("keeps props in bounds, blocking props apart and roads clear", () => {
    const w = buildWorld(plans(20));
    const owner = new Map<number, string>();
    for (const p of w.props) {
      expect(p.col).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.col + p.w).toBeLessThanOrEqual(w.cols);
      expect(p.row + p.h).toBeLessThanOrEqual(w.rows);
      if (!isBlockingProp(p.kind)) continue;
      for (let r = p.row; r < p.row + p.h; r++)
        for (let c = p.col; c < p.col + p.w; c++) {
          const i = r * w.cols + c;
          expect(owner.get(i)).toBeUndefined();
          owner.set(i, p.id);
          expect(kindAt(w, c, r)).not.toBe("path");
          expect(kindAt(w, c, r)).not.toBe("wall");
        }
    }
    expect(new Set(w.props.map((p) => p.id)).size).toBe(w.props.length);
    expect(new Set(w.seats.map((s) => s.id)).size).toBe(w.seats.length);
  });

  it("grows with the number and size of houses", () => {
    const a = buildWorld(plans(1));
    const b = buildWorld(plans(5));
    const c = buildWorld(plans(20));
    expect(b.cols * b.rows).toBeGreaterThan(a.cols * a.rows);
    expect(c.cols * c.rows).toBeGreaterThan(b.cols * b.rows);
    const small = buildWorld([{ key: "x", label: "x", seats: 4, subSeats: 0, hasIde: false }]);
    const big = buildWorld([{ key: "x", label: "x", seats: 16, subSeats: 0, hasIde: false }]);
    expect(big.rows).toBeGreaterThan(small.rows);
    expect(big.seats).toHaveLength(16);
    // A plan with 0 seats still gets a minimal room of 4.
    expect(buildWorld([{ key: "x", label: "x", seats: 0, subSeats: 0, hasIde: false }]).seats).toHaveLength(4);
  });

  it("keeps seat ids stable when other houses are added", () => {
    const before = buildWorld([{ key: "m", label: "m", seats: 4, subSeats: 0, hasIde: false }]);
    const after = buildWorld([
      { key: "a", label: "a", seats: 4, subSeats: 0, hasIde: true },
      { key: "m", label: "m", seats: 8, subSeats: 0, hasIde: false },
    ]);
    const ids = (w: World) => w.seats.filter((s) => s.houseKey === "m").map((s) => s.id);
    expect(ids(after).slice(0, 4)).toEqual(ids(before));
  });
});

describe("walkable", () => {
  it("rejects out of bounds, walls, water and blocking props", () => {
    const w = buildWorld(plans(1));
    const h = w.houses[0];
    expect(walkable(w, -1, 0)).toBe(false);
    expect(walkable(w, 0, -1)).toBe(false);
    expect(walkable(w, w.cols, 0)).toBe(false);
    expect(walkable(w, 0, w.rows)).toBe(false);
    expect(walkable(w, h.col - 1, h.row)).toBe(false); // wall
    expect(walkable(w, h.doorCol, h.doorRow)).toBe(true); // door
    const s = w.seats[0];
    expect(walkable(w, s.col, s.row)).toBe(false); // chair
    expect(walkable(w, s.col, s.row - 1)).toBe(false); // desk under the pc
    const water = w.tiles.indexOf("water");
    expect(walkable(w, water % w.cols, Math.floor(water / w.cols))).toBe(false);
    expect(walkable(w, w.plaza.col, w.plaza.row)).toBe(true);
    expect(walkGrid(w)).toBe(walkGrid(w));
  });

  it("classifies prop kinds", () => {
    expect(isBlockingProp("desk")).toBe(true);
    expect(isBlockingProp("pc")).toBe(false);
    expect(isBlockingProp("coffee")).toBe(false);
    expect(isBlockingProp("table")).toBe(true);
    expect(isBlockingProp("laptop")).toBe(false);
  });
});

describe("buildWorld — the civic row of capacity houses", () => {
  const civic = (w: World) => w.houses.filter((h) => h.capacity);

  it("without a capacity layout the village is exactly as before", () => {
    for (const n of [0, 1, 3, 7]) expect(buildWorld(plans(n), undefined)).toEqual(buildWorld(plans(n)));
    expect(civic(buildWorld(plans(3)))).toEqual([]);
  });

  it("adds Seats, Memory and Usage houses side by side, keyed so no folder can collide", () => {
    const w = buildWorld(plans(2), { seats: 6 });
    expect(civic(w).map((h) => [h.key, h.label, h.capacity, h.hasIde])).toEqual([
      ["cap/seats", "Seats", "seats", false],
      ["cap/memory", "Memory", "memory", false],
      ["cap/usage", "Usage", "usage", false],
    ]);
    expect(CAPACITY_KINDS.map(capacityKey)).toEqual(["cap/seats", "cap/memory", "cap/usage"]);
    const [s, m, u] = civic(w);
    expect(m.col - s.col).toBe(u.col - m.col);
    // Bottoms aligned: one row, facing the plaza.
    expect(new Set(civic(w).map((h) => h.doorRow)).size).toBe(1);
  });

  it("the civic row faces the plaza from the north: its road is just above the plaza band", () => {
    const w = buildWorld(plans(4), { seats: 4 });
    const [s] = civic(w);
    const fountain = w.props.find((p) => p.kind === "fountain")!;
    expect(s.doorRow).toBeLessThan(fountain.row);
    // Every project house is above or below it, never in its row.
    for (const h of w.houses.filter((x) => !x.capacity)) expect(h.doorRow === s.doorRow).toBe(false);
    // Door → plaza by road, like every house.
    expect(roadConnected(w, { col: s.doorCol, row: s.doorRow + 1 }, w.plaza)).toBe(true);
  });

  it("a small village widens to three houses and centres its project rows on the grid", () => {
    const plain = buildWorld(plans(1));
    const w = buildWorld(plans(1), { seats: 4 });
    expect(w.cols).toBeGreaterThan(plain.cols);
    const project = w.houses.find((h) => !h.capacity)!;
    const middle = civic(w)[1];
    expect(project.col).toBe(middle.col);
  });

  it("a wide village keeps its width and centres the civic row instead", () => {
    const plain = buildWorld(plans(25));
    const w = buildWorld(plans(25), { seats: 4 });
    expect(w.cols).toBe(plain.cols);
    const cols = civic(w).map((h) => h.col);
    const projectCols = [...new Set(w.houses.filter((h) => !h.capacity).map((h) => h.col))].sort((a, b) => a - b);
    // 5 per row: the civic row takes slots 1..3.
    expect(cols).toEqual(projectCols.slice(1, 4));
  });

  it("Memory: a row of numbered racks, Usage: two numbered gauges — all inside, all blocking", () => {
    const w = buildWorld([], { seats: 4 });
    const racks = w.props.filter((p) => p.kind === "rack");
    const gauges = w.props.filter((p) => p.kind === "gauge");
    expect(racks.map((p) => [p.capacity, p.index])).toEqual(Array.from({ length: RACKS }, (_, i) => ["memory", i]));
    expect(gauges.map((p) => [p.capacity, p.index, p.w])).toEqual([
      ["usage", 0, 2],
      ["usage", 1, 2],
    ]);
    for (const p of [...racks, ...gauges]) {
      expect(isIndoorTile(w, p.col, p.row)).toBe(true);
      expect(walkable(w, p.col, p.row)).toBe(false);
    }
    expect(isBlockingProp("rack")).toBe(true);
    expect(isBlockingProp("gauge")).toBe(true);
    // Neither stands on the door column.
    for (const h of civic(w)) for (const p of [...racks, ...gauges]) expect(p.col <= h.doorCol && h.doorCol < p.col + p.w).toBe(false);
  });

  describe("the Seats house is the context HALL (`/context`'s 200 seats, render/hall.ts)", () => {
    const k = capacityKey("seats");
    const seatsHouse = (w: World) => w.houses.find((x) => x.key === k)!;
    const halls = (w: World) => w.props.filter((p) => p.kind === "hall");
    /** True when prop p's footprint overlaps the house's interior or its walls. */
    const inHouse = (p: World["props"][number], h: World["houses"][number]) =>
      p.col < h.col + h.w + 1 && p.col + p.w > h.col - 1 && p.row < h.doorRow + 1 && p.row + p.h > h.row - 1;
    const villages = () => [buildWorld([], { seats: 0 }), buildWorld(plans(2), { seats: 4 }), buildWorld(plans(7), { seats: 20 }), buildWorld(plans(25), { seats: 64 })];

    it("exactly one hall prop in the world: the Seats house's, 13 wide and 9 tall, right under its decor row", () => {
      expect(HALL_H).toBe(9);
      for (const w of villages()) {
        const h = seatsHouse(w);
        expect(halls(w)).toEqual([{ id: "cap/seats:hall", kind: "hall", col: h.col, row: h.row + 1, w: 13, h: 9, capacity: "seats" }]);
        // The whole interior wide, every tile of it a floor tile inside the house.
        expect([h.w, h.col + h.w]).toEqual([13, halls(w)[0].col + 13]);
        for (let r = h.row + 1; r < h.row + 10; r++)
          for (let c = h.col; c < h.col + 13; c++) {
            expect(kindAt(w, c, r)).toBe("floor");
            expect(isIndoorTile(w, c, r)).toBe(true);
          }
        expect(isBlockingProp("hall")).toBe(true);
      }
    });

    it("nothing else of the old room: no desk, PC, chair or switch in the Seats house — the decor, the hall, the lounge and the sign only, and no sim seat", () => {
      for (const w of villages()) {
        const h = seatsHouse(w);
        const mine = w.props.filter((p) => inHouse(p, h));
        expect(mine.map((p) => p.id).sort()).toEqual(
          ["cap/seats:bin", "cap/seats:bookshelf:0", "cap/seats:bookshelf:1", "cap/seats:hall", "cap/seats:plant:0", "cap/seats:plant:1", "cap/seats:sofa"].sort(),
        );
        expect(w.props.filter((p) => p.id.startsWith(`${k}:`)).map((p) => p.id).sort()).toEqual(
          ["cap/seats:bin", "cap/seats:bookshelf:0", "cap/seats:bookshelf:1", "cap/seats:hall", "cap/seats:plant:0", "cap/seats:plant:1", "cap/seats:sign", "cap/seats:sofa"].sort(),
        );
        const kinds: string[] = mine.map((p) => p.kind);
        for (const gone of ["desk", "pc", "chair", "switch", "router"]) expect(kinds, gone).not.toContain(gone);
        // Not in the whole village either: no prop is a switch, and no PC is a numbered Seats PC.
        expect(w.props.filter((p) => (p.kind as string) === "switch" || (p.kind === "pc" && (p.capacity !== undefined || p.index !== undefined)))).toEqual([]);
        expect(w.seats.filter((x) => x.houseKey === k)).toEqual([]);
      }
    });

    it("is 11 tiles tall inside (decor row, the 9-row hall, the lounge row) whatever the agent count — the world does not change as agents come and go", () => {
      const agents = (n: number) => Array.from({ length: n }, (_, i) => agent(`k${i}`, "repo", i > 0 ? { parentKey: "k0" } : {}));
      for (const n of [0, 1, 4, 5, 13, 40]) {
        const w = buildWorld(planHouses(agents(n)), { seats: n });
        const h = seatsHouse(w);
        expect([n, h.h, h.doorRow - h.row]).toEqual([n, 11, 11]);
        // Memory and Usage keep their 6.
        expect(w.houses.filter((x) => x.capacity && x.capacity !== "seats").map((x) => x.h)).toEqual([6, 6]);
      }
      // The layout's seat count shapes nothing in the Village: every count builds the very same world.
      for (const ps of [plans(0), plans(3), plans(9)]) {
        const base = buildWorld(ps, { seats: 0 });
        for (const seats of [1, 4, 14, 20, 64, 200]) expect(buildWorld(ps, { seats }), `${seats} seats`).toEqual(base);
      }
    });

    it("its tiles are not walkable; the door column below it — the lounge row and the door — still is, and reached from the door", () => {
      for (const w of villages()) {
        const h = seatsHouse(w);
        const row = (r: number) => Array.from({ length: 13 }, (_, i) => (walkable(w, h.col + i, r) ? "." : "#")).join("");
        // The decor row: plant, two bookshelves … two bookshelves, plant.
        expect(row(h.row)).toBe("###.......###");
        for (let r = h.row + 1; r < h.row + 10; r++) expect(row(r), `hall row ${r - h.row}`).toBe("#############");
        // The lounge row by the door: sofa (2), open floor, bin.
        expect(row(h.row + 10)).toBe("##..........#");
        expect([h.doorCol - h.col, h.doorRow - h.row]).toEqual([6, 11]);
        expect(walkable(w, h.doorCol, h.doorRow)).toBe(true);
        expect(walkable(w, h.doorCol, h.doorRow - 1)).toBe(true);
        expect(walkable(w, h.doorCol, h.doorRow - 2)).toBe(false); // the hall's last row
        expect(findPath(w, { col: h.doorCol, row: h.doorRow + 1 }, { col: h.doorCol, row: h.doorRow - 1 })).not.toBeNull();
      }
    });

    it("shares no tile with another blocking prop, and blocking props stay apart across the whole capacity village", () => {
      const w = buildWorld(plans(20), { seats: 16 });
      const owner = new Map<number, string>();
      for (const p of w.props) {
        expect(p.col + p.w).toBeLessThanOrEqual(w.cols);
        expect(p.row + p.h).toBeLessThanOrEqual(w.rows);
        if (!isBlockingProp(p.kind)) continue;
        for (let r = p.row; r < p.row + p.h; r++)
          for (let c = p.col; c < p.col + p.w; c++) {
            expect(owner.get(r * w.cols + c), `${p.id} at ${c},${r}`).toBeUndefined();
            owner.set(r * w.cols + c, p.id);
          }
      }
      expect(new Set(w.props.map((p) => p.id)).size).toBe(w.props.length);
    });

    it("only the Seats house has one: none in Memory, Usage, a project house, or a village without capacity", () => {
      const w = buildWorld(plans(3), { seats: 4 });
      for (const h of w.houses.filter((x) => x.capacity !== "seats")) expect(w.props.filter((p) => p.kind === "hall" && inHouse(p, h))).toEqual([]);
      expect(halls(buildWorld(plans(3)))).toEqual([]);
      expect(halls(buildWorld([]))).toEqual([]);
    });
  });

  it("every capacity house keeps the cosy decor and a sign by its door", () => {
    const w = buildWorld([], { seats: 2 });
    for (const h of civic(w)) {
      expect(w.props.some((p) => p.id === `${h.key}:sign`)).toBe(true);
      expect(w.props.some((p) => p.id === `${h.key}:sofa`)).toBe(true);
      expect(w.props.some((p) => p.id === `${h.key}:plant:0`)).toBe(true);
    }
  });
});

describe("buildWorld — a project room's Wi-Fi router (engine/teamLan.ts)", () => {
  const routers = (w: World) => w.props.filter((p) => p.kind === "router");
  const covers = (p: World["props"][number], c: number, r: number) => c >= p.col && c < p.col + p.w && r >= p.row && r < p.row + p.h;
  /** plans(8): sub seats 0, 4, 8, 12, 0, 4, 8, 12 — teams of every size and houses without one, IDE houses first. */
  const mixed = () => buildWorld(plans(8));

  it("hangs exactly one in every project house with team tables, at the door column on the top interior row", () => {
    const w = mixed();
    const teamed = plans(8).filter((p) => p.subSeats > 0);
    expect(teamed.length).toBeGreaterThan(0);
    expect(routers(w)).toHaveLength(teamed.length);
    for (const plan of teamed) {
      const h = w.houses.find((x) => x.key === plan.key)!;
      const mine = routers(w).filter((p) => p.id.startsWith(`${h.key}:`));
      // The contract the team LAN model wires from: (house col + 6, house row), 1×1, no capacity, no index.
      expect(mine).toEqual([{ id: `${h.key}:router`, kind: "router", col: h.col + 6, row: h.row, w: 1, h: 1 }]);
      const [r] = mine;
      expect(r.col).toBe(h.doorCol);
      // Inside the room, on its floor, on the back wall (the tile above is the house's top wall).
      expect(kindAt(w, r.col, r.row)).toBe("floor");
      expect(isIndoorTile(w, r.col, r.row)).toBe(true);
      expect(kindAt(w, r.col, r.row - 1)).toBe("wall");
    }
  });

  it("none in a house without team tables, and none at all in a village without sub-agents", () => {
    const w = mixed();
    for (const plan of plans(8).filter((p) => p.subSeats === 0)) {
      const h = w.houses.find((x) => x.key === plan.key)!;
      expect(w.props.filter((p) => p.kind === "router" && p.col >= h.col && p.col < h.col + h.w && p.row >= h.row && p.row <= h.doorRow)).toEqual([]);
      expect(w.props.some((p) => p.id === `${h.key}:router`)).toBe(false);
    }
    expect(routers(buildWorld(plans(8).map((p) => ({ ...p, subSeats: 0 }))))).toEqual([]);
    expect(routers(buildWorld([]))).toEqual([]);
  });

  it("follows the agents: a root's sub-agents put one in ITS house — not in the folder a sub-agent runs in", () => {
    const agents: VillageAgent[] = [
      agent("r", "alpha"),
      agent("s", "elsewhere", { parentKey: "r" }),
      agent("lonely", "beta"),
      agent("orphan", "gamma", { parentKey: "nobody" }),
    ];
    const w = buildWorld(planHouses(agents));
    expect(routers(w).map((p) => p.id)).toEqual(["alpha:router"]);
  });

  it("none in a capacity house — the Seats house is its hall — whatever the seat count", () => {
    for (const seats of [0, 4, 20]) {
      const w = buildWorld(plans(4), { seats });
      for (const h of w.houses.filter((x) => x.capacity)) {
        expect(w.props.filter((p) => p.kind === "router" && p.col >= h.col && p.col < h.col + h.w && p.row >= h.row && p.row <= h.doorRow)).toEqual([]);
        expect(w.props.some((p) => p.kind === "router" && p.id.startsWith(`${h.key}:`))).toBe(false);
      }
      // …while the project houses with teams keep theirs.
      expect(routers(w)).toHaveLength(plans(4).filter((p) => p.subSeats > 0).length);
    }
  });

  it("shares its tile with no other prop — decor, desks and team tables all miss it", () => {
    const w = mixed();
    expect(routers(w).length).toBeGreaterThan(0);
    for (const r of routers(w)) expect(w.props.filter((p) => p !== r && covers(p, r.col, r.row))).toEqual([]);
  });

  it("is not blocking: walkability is exactly what it would be without it, the door column clear all the way up", () => {
    const w = mixed();
    expect(isBlockingProp("router")).toBe(false);
    const without: World = { ...w, props: w.props.filter((p) => p.kind !== "router") };
    expect(Array.from(walkGrid(w))).toEqual(Array.from(walkGrid(without)));
    for (const r of routers(w)) {
      expect(walkable(w, r.col, r.row)).toBe(true);
      const h = w.houses.find((x) => r.id === `${x.key}:router`)!;
      for (let row = h.row; row < h.doorRow; row++) expect(walkable(w, h.doorCol, row)).toBe(true);
    }
  });

  it("keeps its id across rebuilds, and when other houses come and go", () => {
    expect(routers(mixed())).toEqual(routers(mixed()));
    const ids = (w: World) => routers(w).map((p) => p.id).sort();
    const small = buildWorld(plans(4));
    const big = buildWorld([...plans(4), { key: "zz-new", label: "zz-new", seats: 4, subSeats: 4, hasIde: false }]);
    expect(ids(big)).toEqual([...ids(small), "zz-new:router"].sort());
    // Each id still names the house the router stands in.
    for (const r of routers(big)) {
      const h = big.houses.find((x) => r.id === `${x.key}:router`)!;
      expect([r.col, r.row]).toEqual([h.col + 6, h.row]);
    }
  });
});
