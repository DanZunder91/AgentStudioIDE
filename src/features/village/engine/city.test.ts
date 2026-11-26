import { describe, expect, it } from "vitest";

import { fitCamera } from "../render/camera";
import { TILE, type Prop, type VillageAgent, type World } from "../villageTypes";
import {
  benchRows,
  buildCityWorld,
  cityGround,
  deskRows,
  floorHeight,
  floorKey,
  floorWidth,
  FLOOR_H,
  HQ_KEY,
  HQ_LABEL,
  HQ_W,
  LOUNGE_ROW_SEATS,
  LOUNGE_W,
  planCity,
  ROW_DESKS,
  ROW_PITCH,
  STATION_W,
  stationCols,
  TUNNEL_ROWS,
  type CityPlan,
} from "./city";
import { TRAIN_LEN } from "./subway";
import { isIndoorTile, RACKS, walkable, walkGrid } from "./world";
import { SIT_OFFSET, VillageSim } from "./sim";

function agent(key: string, folder: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "ide",
    title: `t-${key}`,
    folder,
    activity: "typing",
    tool: null,
    ideAgentId: key,
    lastActivityAt: null,
    ...extra,
  };
}

const ext = (key: string, folder: string, extra: Partial<VillageAgent> = {}) =>
  agent(key, folder, { origin: "external", ideAgentId: null, ...extra });
const term = (id: string, folder: string, extra: Partial<VillageAgent> = {}) =>
  agent(`term:${id}`, folder, { ideAgentId: null, consoleId: id, activity: "idle", ...extra });
const subs = (parent: string, n: number, extra: Partial<VillageAgent> = {}) =>
  Array.from({ length: n }, (_, i) => agent(`${parent}.s${i}`, "anywhere", { parentKey: parent, ...extra }));

const kindAt = (w: World, c: number, r: number) => w.tiles[r * w.cols + c];

describe("planCity", () => {
  it("makes one building per folder and one floor per root agent or console — IDE buildings first, then by folder", () => {
    const { plans } = planCity([
      ext("e1", "zeta"),
      agent("a1", "beta"),
      term("1", "alpha"),
      ext("e2", "alpha"),
      // Sorts FIRST by name, yet has no IDE floor: it goes after every IDE building.
      ext("e3", "aaa"),
      agent("a2", "beta"),
    ]);
    expect(plans.map((p) => [p.key, p.label, p.hasIde, p.floors.length])).toEqual([
      ["alpha", "alpha", true, 2], // a console is an IDE floor
      ["beta", "beta", true, 2],
      ["aaa", "aaa", false, 1],
      ["zeta", "zeta", false, 1],
    ]);
  });

  it("stacks a building's floors IDE agents first, then IDE consoles, then agents outside the IDE, each in arrival order", () => {
    const { plans } = planCity([ext("e1", "p"), term("2", "p"), agent("a1", "p"), term("1", "p"), agent("a2", "p"), ext("e0", "p")]);
    expect(plans[0].floors.map((f) => f.key)).toEqual(
      ["a1", "a2", "term:2", "term:1", "e1", "e0"].map(floorKey),
    );
    expect(plans[0].floors.map((f) => f.ide)).toEqual([true, true, true, true, false, false]);
    // A floor is named after its leader: the agent's title, or the console tab's name.
    expect(plans[0].floors[2].label).toBe("t-term:2");
  });

  it("puts EVERY sub-agent of a root on its floor — busy ones first — and never counts a '+N'", () => {
    const done = subs("r", 6, { activity: "done" });
    const busy = subs("q", 5, { activity: "typing" }).map((s) => ({ ...s, parentKey: "r" }));
    // A sub-agent of a sub-agent still works for the floor's leader.
    const nested = agent("deep", "x", { parentKey: busy[0].key, activity: "reading" });
    const { plans, agents } = planCity([agent("r", "p"), ...done, ...busy, nested]);
    // The floor's plan is its name and nothing else: no overflow count anywhere.
    expect(plans[0].floors).toEqual([{ key: floorKey("r"), label: "t-r", ide: true }]);
    expect(plans[0].team).toBe(12);
    const seated = agents.filter((a) => a.parentKey !== null).map((a) => a.key);
    // All six busy ones (input order), then ALL six finished ones — past the old cap of 8.
    expect(seated).toEqual([...busy.map((s) => s.key), "deep", ...done.map((s) => s.key)]);
  });

  it("seats a leader's 13 sub-agents — all of them, on 14 seats (desks of two)", () => {
    const team = subs("r", 13);
    const { plans, agents } = planCity([agent("r", "p"), ...team]);
    expect(plans[0].team).toBe(14);
    expect(agents.map((a) => [a.key, a.parentKey, a.folder])).toEqual([
      ["r", null, floorKey("r")],
      ...team.map((s) => [s.key, "r", floorKey("r")]),
    ]);
  });

  it("keeps busy sub-agents first however many there are: 10 finished ones listed before 5 busy ones", () => {
    const done = subs("r", 10, { activity: "done" });
    const busy = subs("q", 5, { activity: "thinking" }).map((s) => ({ ...s, parentKey: "r" }));
    const waiting = agent("w", "p", { parentKey: "r", activity: "waiting" });
    const { agents } = planCity([agent("r", "p"), ...done, waiting, ...busy]);
    expect(agents.slice(1).map((a) => a.key)).toEqual(["w", ...busy.map((s) => s.key), ...done.map((s) => s.key)]);
  });

  it("counts sub-agents of sub-agents on their ROOT's floor, however deep, desks and all", () => {
    const direct = subs("r", 9);
    const grand = subs(direct[0].key, 3);
    const great = subs(grand[2].key, 1);
    const { plans, agents } = planCity([agent("r", "p"), ...direct, ...grand, ...great, agent("o", "p"), ...subs("o", 1)]);
    expect(plans[0].team).toBe(14); // 13 under r → 14 seats; o's single sub does not set the width
    expect(agents.filter((a) => a.parentKey === "r").map((a) => a.key)).toEqual([...direct, ...grand, ...great].map((s) => s.key));
  });

  it("places every sub-agent whose root is known — only the orphans (and their own sub-agents) are left out", () => {
    const list = [
      agent("r1", "p"),
      ...subs("r1", 11),
      ext("r2", "q"),
      ...subs("r2", 9, { activity: "idle" }),
      ...subs("r1.s3", 4),
      agent("orphan", "p", { parentKey: "ghost" }),
      ...subs("orphan", 2),
      term("1", "p"),
    ];
    const { agents } = planCity(list);
    const lost = new Set(["orphan", "orphan.s0", "orphan.s1"]);
    expect(agents.map((a) => a.key).sort()).toEqual(list.map((a) => a.key).filter((k) => !lost.has(k)).sort());
    expect(agents).toHaveLength(list.length - lost.size);
  });

  it("rewrites the sim's agents for the city: a leader's house is its floor, its team hangs directly under it", () => {
    const { agents } = planCity([agent("r", "proj"), agent("s", "elsewhere", { parentKey: "r" }), agent("n", "x", { parentKey: "s" })]);
    expect(agents.map((a) => [a.key, a.parentKey, a.folder])).toEqual([
      ["r", null, floorKey("r")],
      ["s", "r", floorKey("r")],
      ["n", "r", floorKey("r")],
    ]);
    // Everything else about the agent is untouched (the card reads the originals anyway).
    expect(agents[1]).toMatchObject({ title: "t-s", origin: "ide", activity: "typing" });
  });

  it("leaves out sub-agents whose root is unknown — there is no floor to seat them on", () => {
    const { plans, agents } = planCity([agent("r", "p"), agent("orphan", "p", { parentKey: "ghost" })]);
    expect(agents.map((a) => a.key)).toEqual(["r"]);
    expect(plans[0].floors).toEqual([{ key: floorKey("r"), label: "t-r", ide: true }]);
    expect(plans[0].team).toBe(0);
  });

  it("makes a building as wide as its widest floor, in desks of two — rounded UP, never capped", () => {
    const team = (n: number) => planCity([agent("r", "p"), ...subs("r", n), agent("o", "p")]).plans[0].team;
    expect([0, 1, 2, 3, 8, 9, 13, 30, 31].map(team)).toEqual([0, 2, 2, 4, 8, 10, 14, 30, 32]);
    // Two floors of one building, 3 and 13 sub-agents: the building follows the widest.
    const two = planCity([agent("a", "p"), ...subs("a", 3), agent("b", "p"), ...subs("b", 13)]).plans;
    expect(two.map((p) => [p.key, p.team, p.floors.length])).toEqual([["p", 14, 2]]);
    // Coarse on purpose: the width (and so the plan) changes every SECOND sub-agent, not every one.
    const sigs = Array.from({ length: 41 }, (_, n) => JSON.stringify(planCity([agent("r", "p"), ...subs("r", n)]).plans));
    const changes = sigs.slice(1).filter((s, i) => s !== sigs[i]).length;
    expect(changes).toBe(20);
  });

  it("is deterministic and independent of which building's agents arrive first", () => {
    const list = [agent("a", "b2"), ext("e", "b1"), agent("c", "b3"), term("9", "b1")];
    expect(planCity(list)).toEqual(planCity(list));
    expect(planCity([...list].reverse()).plans.map((p) => p.key)).toEqual(planCity(list).plans.map((p) => p.key));
  });

  it("gives each building its agents' most common known language — sub-agents count, ties go to code-unit order, none is null", () => {
    const lang = (language: string | null | undefined) => ({ language });
    const { plans } = planCity([
      agent("a", "rusty", lang("rust")),
      agent("a.1", "x", { parentKey: "a", ...lang("typescript") }),
      agent("a.2", "x", { parentKey: "a", ...lang("typescript") }),
      agent("b", "rusty", lang("rust")),
      agent("b.1", "x", { parentKey: "b", ...lang("rust") }),
      agent("c", "tie", lang("python")),
      agent("d", "tie", lang("go")),
      agent("e", "none"),
      term("1", "none", lang(null)),
    ]);
    expect(plans.map((p) => [p.key, p.language])).toEqual([
      ["none", null],
      ["rusty", "rust"], // 3 rust (two leaders, one sub-agent) beat 2 typescript
      ["tie", "go"], // 1–1: "go" < "python"
    ]);
    // …and the building carries it to the renderer (its neon sign).
    const w = buildCityWorld(plans);
    expect(w.city!.buildings.map((b) => b.language)).toEqual([null, "rust", "go"]);
  });

  it("names floors by their leader's key", () => {
    expect(floorKey("ext:abc")).toBe("floor:ext:abc");
  });
});

/** Plans for `floors` (team sizes per floor), all in one building `key`. */
function plan(key: string, team: number, floors: number): CityPlan {
  return {
    key,
    label: key,
    team,
    hasIde: true,
    floors: Array.from({ length: floors }, (_, i) => ({ key: `floor:${key}-${i}`, label: `${key} ${i}`, ide: true })),
  };
}

describe("buildCityWorld", () => {
  it("stands every building on the same street, its floors stacked FLOOR_H tiles apart from the ground floor up", () => {
    const w = buildCityWorld([plan("a", 2, 1), plan("b", 0, 3), plan("c", 4, 2)]);
    const { street, buildings } = w.city!;
    expect(buildings.map((b) => b.key)).toEqual(["a", "b", "c"]);
    for (const b of buildings) {
      expect(b.row + b.h - 1).toBe(street - 1); // the front wall sits right above the sidewalk
      expect(b.h).toBe(FLOOR_H * b.floors.length + 1);
      b.floors.forEach((key, i) => {
        const h = w.houses.find((x) => x.key === key)!;
        // The house is the floor's room: back wall, headroom, leader row, desk row.
        expect([h.col, h.row, h.w, h.h]).toEqual([b.col + 1, street - 1 - FLOOR_H * (i + 1) + 1, b.w - 2, FLOOR_H - 1]);
        expect(h.doorCol).toBe(b.doorCol);
        expect(h.doorRow).toBe(street - 1);
      });
    }
    // Left to right, never overlapping, with room between them.
    for (let i = 1; i < buildings.length; i++) expect(buildings[i].col).toBeGreaterThan(buildings[i - 1].col + buildings[i - 1].w);
    // A building is as wide as its floors need: walls + plant, big desk ×3, aisle, desks of two + aisle, decor.
    expect(buildings.map((b) => b.w)).toEqual([floorWidth(2) + 2, floorWidth(0) + 2, floorWidth(4) + 2]);
    expect([floorWidth(0), floorWidth(2), floorWidth(8)]).toEqual([6, 9, 18]);
  });

  it("furnishes every floor: the leader's big desk facing the street, and a desk + PC + chair per team seat", () => {
    const w = buildCityWorld([plan("p", 4, 2)]);
    for (const h of w.houses) {
      const k = h.key;
      const [W, H, A, B] = [h.row, h.row + 1, h.row + 2, h.row + 3];
      const seats = w.seats.filter((s) => s.houseKey === k);
      const lead = seats.find((s) => !s.forSub)!;
      expect(lead).toEqual({ id: `${k}:lead`, houseKey: k, col: h.col + 2, row: A, facing: "down", pcId: `${k}:monitor` });
      const prop = (id: string) => w.props.find((p) => p.id === id) as Prop;
      expect(prop(`${k}:desk:lead`)).toMatchObject({ kind: "desk", col: h.col + 1, row: B, w: 3, h: 1 });
      // The leader's workstation: the monitor beside its chair and the keyboard right in front of it — one
      // 2-tile prop whose right tile is the chair's column (without it they had nothing to type on).
      expect(prop(`${k}:monitor`)).toMatchObject({ kind: "monitor", col: h.col + 1, row: B, w: 2, seatId: lead.id });
      expect(lead.col).toBe(h.col + 2);
      expect(prop(`${k}:chair:lead`)).toMatchObject({ kind: "chair", col: lead.col, row: lead.row, facing: "down" });
      const team = seats.filter((s) => s.forSub);
      expect(team.map((s) => s.id)).toEqual([0, 1, 2, 3].map((i) => `${k}:team:${i}`));
      for (const s of team) {
        expect(s).toMatchObject({ row: B, facing: "up" });
        expect(prop(s.pcId!)).toMatchObject({ kind: "pc", col: s.col, row: A, seatId: s.id });
        expect(w.props.some((p) => p.kind === "chair" && p.col === s.col && p.row === B && p.facing === "up")).toBe(true);
        // …on a desk of two against the wall.
        expect(w.props.some((p) => p.kind === "desk" && p.w === 2 && p.row === A && s.col >= p.col && s.col < p.col + 2)).toBe(true);
      }
      expect(prop(`${k}:shelf`)).toMatchObject({ kind: "bookshelf", row: H });
      // The back wall runs the building's full width, the rest of the floor is floor.
      for (let c = h.col - 1; c <= h.col + h.w; c++) expect(kindAt(w, c, W)).toBe("wall");
      for (const r of [W - 1, H, A, B]) for (let c = h.col; c < h.col + h.w; c++) expect(kindAt(w, c, r)).toBe("floor");
    }
  });

  it("keeps a floor's ids when the city around it changes, so nobody loses their desk", () => {
    const before = buildCityWorld([plan("p", 2, 1)]);
    const after = buildCityWorld([plan("a", 0, 1), plan("p", 2, 1), plan("q", 8, 3)]);
    const ids = (w: World, key: string) => w.seats.filter((s) => s.houseKey === key).map((s) => s.id);
    expect(ids(after, "floor:p-0")).toEqual(ids(before, "floor:p-0"));
    expect(ids(before, "floor:p-0")).toHaveLength(3);
  });

  it("walls each building in: outer walls from its top floor's back wall down, and a street door in the front wall", () => {
    const w = buildCityWorld([plan("p", 0, 2)]);
    const b = w.city!.buildings[0];
    const front = b.row + b.h - 1;
    for (let r = b.row + 1; r <= front; r++) {
      expect(kindAt(w, b.col, r)).toBe("wall");
      expect(kindAt(w, b.col + b.w - 1, r)).toBe("wall");
    }
    // The roof row's corners stay open sky: the corner wall pieces rise over them.
    expect(kindAt(w, b.col, b.row)).toBe("sky");
    for (let c = b.col; c < b.col + b.w; c++) expect(kindAt(w, c, front)).toBe(c === b.doorCol ? "floor" : "wall");
    expect(b.doorCol).toBe(b.col + 5); // under the aisle beside the leader's desk
  });

  it("lays the street under every building: sidewalk, two lanes of road, sidewalk — the first lane on an EVEN row", () => {
    for (let floors = 1; floors <= 4; floors++) {
      const w = buildCityWorld([plan("p", 2, floors)]);
      const { street } = w.city!;
      expect(w.rows).toBe(street + 4);
      for (let c = 0; c < w.cols; c++) {
        expect([0, 1, 2, 3].map((d) => kindAt(w, c, street + d))).toEqual(["path", "road", "road", "path"]);
        expect(kindAt(w, c, 0)).toBe("sky");
      }
      // render/tiles.ts draws the kerb on an even road row and the centre dashes on an odd one.
      expect((street + 1) % 2).toBe(0);
      // Sky rows above the roof hold the building's sign.
      expect(w.city!.buildings[0].row).toBeGreaterThanOrEqual(4);
    }
  });

  it("lines the street with a lamp at both ends and in every gap, and a tree in every gap", () => {
    const w = buildCityWorld([plan("a", 0, 1), plan("b", 2, 2), plan("c", 0, 1)]);
    const lamps = w.props.filter((p) => p.kind === "lamp");
    const trees = w.props.filter((p) => p.kind === "tree");
    expect(lamps).toHaveLength(4);
    expect(trees).toHaveLength(2);
    const { street, buildings } = w.city!;
    for (const p of [...lamps, ...trees]) {
      expect(p.row + p.h - 1).toBe(street);
      expect(p.col).toBeGreaterThanOrEqual(0);
      expect(p.col + p.w).toBeLessThanOrEqual(w.cols);
      // …never inside a building.
      for (const b of buildings) expect(p.col + p.w <= b.col || p.col >= b.col + b.w).toBe(true);
    }
    expect(lamps[0].col).toBeLessThan(buildings[0].col);
    expect(lamps[3].col).toBeGreaterThan(buildings[2].col + buildings[2].w - 1);
  });

  it("an EMPTY city is still a street under a sky, wide and tall enough to frame", () => {
    const w = buildCityWorld([]);
    expect(w.city).toEqual({ street: w.rows - 4, buildings: [] });
    expect([w.houses, w.seats]).toEqual([[], []]);
    expect(w.cols).toBe(40);
    expect(w.rows).toBeGreaterThan(10);
    expect(w.props.filter((p) => p.kind === "lamp").map((p) => p.col)).toEqual([4, 12, 20, 28, 36]);
    const cam = fitCamera(w.cols * TILE, w.rows * TILE, 1600, 1000);
    expect(Object.values(cam).every(Number.isFinite)).toBe(true);
    expect(cam.zoom).toBeGreaterThanOrEqual(1);
  });

  it("frames every building: centred, inside the world, with sky above the tallest one", () => {
    const w = buildCityWorld([plan("a", 8, 4), plan("b", 8, 1), plan("c", 8, 2), plan("d", 8, 1)]);
    expect(w.cols % 2).toBe(0); // even, so a copy of the street beside it keeps the dashes in step
    const left = w.city!.buildings[0].col;
    const last = w.city!.buildings[3];
    const right = w.cols - (last.col + last.w);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    expect(left).toBeGreaterThanOrEqual(3);
    for (const b of w.city!.buildings) expect(b.row).toBeGreaterThanOrEqual(4);
    // Fit covers the whole world, and so every building in it.
    const cam = fitCamera(w.cols * TILE, w.rows * TILE, 1200, 700);
    for (const b of w.city!.buildings) {
      expect(cam.ox + b.col * TILE * cam.zoom).toBeGreaterThanOrEqual(cam.ox);
      expect(cam.ox + (b.col + b.w) * TILE * cam.zoom).toBeLessThanOrEqual(cam.ox + w.cols * TILE * cam.zoom);
    }
  });

  it("carries each floor's name on its house — and no overflow count — and is deterministic", () => {
    const plans = [plan("p", 8, 2)];
    const w = buildCityWorld(plans);
    expect(w.houses.map((h) => [h.label, h.hasIde])).toEqual([
      ["p 0", true],
      ["p 1", true],
    ]);
    expect(w.houses.some((h) => "more" in h)).toBe(false);
    expect(buildCityWorld(plans)).toEqual(w);
  });

  it("gives a 13-sub-agent floor 14 team seats, every PC and chair inside the floor, 9 tiles wider than an 8-seat one", () => {
    const roster = planCity([agent("r", "p"), ...subs("r", 13)]);
    const w = buildCityWorld(roster.plans);
    const h = w.houses[0];
    expect(h.key).toBe(floorKey("r"));
    const team = w.seats.filter((s) => s.houseKey === h.key && s.forSub);
    expect(team.map((s) => s.id)).toEqual(Array.from({ length: 14 }, (_, i) => `${h.key}:team:${i}`));
    const inside = (p: { col: number; row: number; w: number; h: number }) =>
      p.col >= h.col && p.col + p.w <= h.col + h.w && p.row >= h.row && p.row + p.h <= h.row + h.h;
    const pcs = w.props.filter((p) => p.kind === "pc" && p.id.startsWith(`${h.key}:`));
    const chairs = w.props.filter((p) => p.kind === "chair" && p.id.startsWith(`${h.key}:chair:`) && p.id !== `${h.key}:chair:lead`);
    const desks = w.props.filter((p) => p.kind === "desk" && p.id !== `${h.key}:desk:lead`);
    expect([pcs.length, chairs.length, desks.length]).toEqual([14, 14, 7]);
    for (const p of [...pcs, ...chairs, ...desks]) expect([p.id, inside(p)]).toEqual([p.id, true]);
    // No two pieces of furniture on one tile: a PC per desk tile, a chair under each.
    expect(new Set(pcs.map((p) => `${p.col},${p.row}`)).size).toBe(14);
    expect(new Set(chairs.map((p) => `${p.col},${p.row}`)).size).toBe(14);
    // Three more desks of two (pitch 3) than the 8-seat building: 9 tiles wider.
    const eight = buildCityWorld([plan("p", 8, 1)]).city!.buildings[0];
    expect(w.city!.buildings[0].w - eight.w).toBe(9);
    expect(floorWidth(14) - floorWidth(8)).toBe(9);
  });
});

describe("cityGround", () => {
  it("is the street at any x (it runs on past the world) and every roof — never the open sky or a facade", () => {
    const w = buildCityWorld([plan("p", 2, 2)]);
    const ground = cityGround(w);
    const { street, buildings } = w.city!;
    const b = buildings[0];
    for (const x of [-500, 0, 300, w.cols * TILE + 500]) {
      expect(ground(x, street * TILE)).toBe(true);
      expect(ground(x, (street + 4) * TILE - 1)).toBe(true);
      expect(ground(x, (street + 4) * TILE)).toBe(false);
      expect(ground(x, TILE)).toBe(false);
    }
    const roofY = b.row * TILE + 4;
    expect(ground(b.col * TILE, roofY)).toBe(true);
    expect(ground((b.col + b.w) * TILE - 1, roofY)).toBe(true);
    expect(ground(b.col * TILE - 1, roofY)).toBe(false);
    expect(ground((b.col + b.w) * TILE, roofY)).toBe(false);
    expect(ground(b.col * TILE + 8, (b.row + 2) * TILE)).toBe(false); // the facade below the roof
  });
});

describe("the sim in a city", () => {
  const list = [
    agent("lead", "p", { activity: "idle" }),
    ...subs("lead", 3),
    term("7", "p", { activity: "typing" }),
    ext("far", "q", { activity: "done" }),
  ];

  function citySim(): { sim: VillageSim; world: World } {
    const roster = planCity(list);
    const world = buildCityWorld(roster.plans);
    const sim = new VillageSim({ seed: 3, stayPut: true });
    sim.setWorld(world);
    sim.setAgents(roster.agents);
    return { sim, world };
  }

  it("seats each leader at its floor's big desk facing the street, and its team at that floor's desks", () => {
    const { sim, world } = citySim();
    const at = (key: string) => sim.characters().find((c) => c.key === key)!;
    for (const key of ["lead", "term:7", "far"]) {
      const seat = world.seats.find((s) => s.id === `${floorKey(key)}:lead`)!;
      expect(at(key)).toMatchObject({ x: seat.col * TILE + 8, y: (seat.row + 1) * TILE + SIT_OFFSET, dir: "down", seated: true });
    }
    for (let i = 0; i < 3; i++) {
      const c = at(`lead.s${i}`);
      const seat = world.seats.find((s) => s.forSub && s.col * TILE + 8 === c.x && (s.row + 1) * TILE + SIT_OFFSET === c.y)!;
      expect(seat.houseKey).toBe(floorKey("lead"));
      expect(c).toMatchObject({ dir: "up", seated: true, isSubagent: true });
    }
    // Working leaders switch their monitor on; the idle one's stays dark.
    expect(sim.pcOn(`${floorKey("term:7")}:monitor`)).toBe(true);
    expect(sim.pcOn(`${floorKey("lead")}:monitor`)).toBe(false);
  });

  it("never lets anyone wander off a floor: idle and finished leaders rest in their chairs for good", () => {
    const { sim } = citySim();
    const before = sim.characters().map((c) => [c.key, c.x, c.y]);
    for (let i = 0; i < 1200; i++) sim.tick(0.1); // two minutes
    const after = sim.characters();
    expect(after.map((c) => [c.key, c.x, c.y])).toEqual(before);
    expect(after.every((c) => c.seated && c.anim !== "walk")).toBe(true);
    // A leader that finishes mid-turn sits back, it does not stand up and stroll.
    sim.setAgents(planCity(list.map((a) => (a.key === "term:7" ? { ...a, activity: "idle" as const } : a))).agents);
    for (let i = 0; i < 600; i++) sim.tick(0.1);
    expect(sim.characters().find((c) => c.key === "term:7")).toMatchObject({ seated: true, anim: "idle" });
  });

  /** The seat a settled character sits on: the one whose chair its sprite is drawn on. */
  const seatUnder = (world: World, c: { x: number; y: number }) =>
    world.seats.find((s) => s.col * TILE + 8 === c.x && (s.row + 1) * TILE + SIT_OFFSET === c.y);
  function settle(sim: VillageSim): void {
    for (let i = 0; i < 20; i++) sim.tick(0.1);
  }

  it("seats every one of a 13-strong team — each at its own desk on its leader's floor, nobody left standing", () => {
    const team = subs("lead", 13);
    const roster = planCity([agent("lead", "p"), ...team, agent("other", "p"), ...subs("other", 3)]);
    const world = buildCityWorld(roster.plans);
    const sim = new VillageSim({ seed: 3, stayPut: true });
    sim.setWorld(world);
    sim.setAgents(roster.agents);
    settle(sim);
    const chars = sim.characters();
    expect(chars).toHaveLength(2 + 13 + 3);
    const seatIds = chars.map((c) => seatUnder(world, c)?.id ?? `${c.key}: no seat`);
    expect(seatIds.filter((id) => id.endsWith("no seat"))).toEqual([]);
    expect(new Set(seatIds).size).toBe(chars.length);
    expect(chars.every((c) => c.seated)).toBe(true);
    for (const s of team) {
      const seat = seatUnder(world, chars.find((c) => c.key === s.key)!)!;
      expect([s.key, seat.houseKey, seat.forSub]).toEqual([s.key, floorKey("lead"), true]);
    }
  });

  it("gives the BUSY sub-agents the desks nearest their leader when a team arrives together", () => {
    const done = subs("lead", 10, { activity: "done" });
    const busy = subs("q", 3, { activity: "typing" }).map((s) => ({ ...s, parentKey: "lead" }));
    const roster = planCity([agent("lead", "p"), ...done, ...busy]);
    const world = buildCityWorld(roster.plans);
    const sim = new VillageSim({ seed: 3, stayPut: true });
    sim.setWorld(world);
    sim.setAgents(roster.agents);
    settle(sim);
    const seatOf = (key: string) => seatUnder(world, sim.characters().find((c) => c.key === key)!)?.id;
    const seat = (i: number) => `${floorKey("lead")}:team:${i}`;
    expect(busy.map((s) => seatOf(s.key))).toEqual([0, 1, 2].map(seat));
    expect(done.map((s) => seatOf(s.key))).toEqual(Array.from({ length: 10 }, (_, i) => seat(i + 3)));
  });

  it("keeps everyone at the same desk while a team grows a desk — the one rebuild every second sub-agent moves nobody", () => {
    const roster = (n: number) => planCity([agent("lead", "p"), ...subs("lead", n), agent("o", "q")]);
    const sim = new VillageSim({ seed: 3, stayPut: true });
    let world = buildCityWorld(roster(13).plans);
    sim.setWorld(world);
    sim.setAgents(roster(13).agents);
    settle(sim);
    // A desk is its seat id AND its place on the floor (from the floor's own corner: the street
    // re-centres when a building widens, so absolute columns may move).
    const desks = () =>
      new Map(
        sim.characters().map((c) => {
          const s = seatUnder(world, c);
          const h = world.houses.find((x) => x.key === s?.houseKey);
          return [c.key, s && h ? [s.id, s.col - h.col, s.row - h.row] : "no seat"];
        }),
      );
    const before = desks();
    // The 14th sub-agent takes the 14th seat: same plan, no rebuild. The 15th needs a new desk.
    expect(roster(14).plans).toEqual(roster(13).plans);
    sim.setAgents(roster(14).agents);
    expect(roster(15).plans).not.toEqual(roster(14).plans);
    const wider = buildCityWorld(roster(15).plans);
    expect(wider.city!.buildings[0].w - world.city!.buildings[0].w).toBe(3);
    // As the panel does it: the new world first, then the agents it was built for.
    world = wider;
    sim.setWorld(world);
    sim.setAgents(roster(15).agents);
    settle(sim);
    const after = desks();
    expect(before.size).toBe(2 + 13);
    for (const [key, desk] of before) expect([key, after.get(key)]).toEqual([key, desk]);
    expect([after.get("lead.s13"), after.get("lead.s14")].map((d) => (d as unknown[])[0])).toEqual(
      [13, 14].map((i) => `${floorKey("lead")}:team:${i}`),
    );
  });
});

describe("buildCityWorld — the Capacity HQ", () => {
  const roster = planCity([agent("a", "gazelle"), ...subs("a", 3), agent("b", "zeta")]);
  const hqOf = (w: World) => w.city!.buildings.find((b) => b.hq)!;

  it("without a capacity layout the city is exactly as before", () => {
    expect(buildCityWorld(roster.plans, undefined)).toEqual(buildCityWorld(roster.plans));
    expect(buildCityWorld(roster.plans).city!.buildings.some((b) => b.hq)).toBe(false);
    expect(buildCityWorld(roster.plans).city!.lounge).toBeUndefined();
  });

  it("stands in the CENTRE of the street: two floors — Memory on the ground, then Usage — its door in the middle", () => {
    const w = buildCityWorld(roster.plans, { seats: 64 });
    const hq = hqOf(w);
    expect([hq.key, hq.label, hq.hq, hq.hasIde, hq.lift, hq.language]).toEqual([HQ_KEY, HQ_LABEL, true, false, undefined, undefined]);
    // The world is as wide on both sides of it: its middle is the world's.
    expect(2 * hq.col + hq.w).toBe(w.cols);
    expect(hq.floors).toEqual(["cap/memory", "cap/usage"]);
    const floors = hq.floors.map((k) => w.houses.find((h) => h.key === k)!);
    expect(floors.map((f) => f.capacity)).toEqual(["memory", "usage"]);
    expect(floors[0].row - floors[1].row).toBe(FLOOR_H);
    expect(hq.h).toBe(2 * FLOOR_H + 1);
    // As wide as its racks need, whatever the seat count; its street door in the middle of its front.
    expect(hq.w).toBe(HQ_W + 2);
    expect(hq.doorCol).toBe(hq.col + 1 + HQ_W / 2);
    expect(kindAt(w, hq.doorCol, w.city!.street - 1)).toBe("floor");
    for (const seats of [0, 16, 64, 100]) expect(hqOf(buildCityWorld(roster.plans, { seats })).w).toBe(HQ_W + 2);
    // gazelle (the wider) on the right, zeta on the left — both inside the world, the street's margin kept.
    const [left, , right] = w.city!.buildings;
    expect([left.key, right.key]).toEqual(["zeta", "gazelle"]);
    expect(left.col).toBeGreaterThanOrEqual(3);
    expect(w.cols - (right.col + right.w)).toBeGreaterThanOrEqual(3);
  });

  it("puts each project on the side with less street taken so far, the right on a tie — the first ones nearest the HQ", () => {
    // Widths 9, 6, 18, 6: right (tie), left, right (left had less? no: 13 > 0 → left)… pinned below.
    const plans = [plan("a", 2, 1), plan("b", 0, 1), plan("c", 8, 1), plan("d", 0, 2)];
    const w = buildCityWorld(plans, { seats: 64 });
    const keys = w.city!.buildings.map((b) => b.key);
    // a (9+2) → right; b → left (11 > 0); c → left? left = 12, right = 15 → left; d: left = 36 > right = 15 → right.
    expect(keys).toEqual(["c", "b", HQ_KEY, "a", "d"]);
    const hq = hqOf(w);
    // Left to right, never overlapping, a gap between neighbours, all inside the world.
    const bs = w.city!.buildings;
    for (let i = 1; i < bs.length; i++) expect(bs[i].col - (bs[i - 1].col + bs[i - 1].w)).toBe(4);
    expect(bs[0].col).toBeGreaterThanOrEqual(3);
    expect(w.cols - (bs[bs.length - 1].col + bs[bs.length - 1].w)).toBeGreaterThanOrEqual(3);
    expect(2 * hq.col + hq.w).toBe(w.cols);
    expect(w.cols % 2).toBe(0);
    // With no project at all, the HQ still stands in the middle, a lamp either side, no tree.
    const alone = buildCityWorld([], { seats: 2 });
    expect(2 * hqOf(alone).col + hqOf(alone).w).toBe(alone.cols);
  });

  it("Memory floor: the racks; Usage floor: the two gauges — on the floor's bottom row, indoors, blocking", () => {
    const w = buildCityWorld([], { seats: 4 });
    const racks = w.props.filter((p) => p.kind === "rack");
    const gauges = w.props.filter((p) => p.kind === "gauge");
    expect(racks.map((p) => p.index)).toEqual(Array.from({ length: RACKS }, (_, i) => i));
    expect(gauges.map((p) => p.index)).toEqual([0, 1]);
    const mem = w.houses.find((h) => h.capacity === "memory")!;
    const use = w.houses.find((h) => h.capacity === "usage")!;
    for (const r of racks) expect(r.row).toBe(mem.row + 3);
    for (const g of gauges) expect(g.row).toBe(use.row + 3);
    for (const p of [...racks, ...gauges]) {
      expect(isIndoorTile(w, p.col, p.row)).toBe(true);
      expect(walkable(w, p.col, p.row)).toBe(false);
      expect(p.col + p.w).toBeLessThanOrEqual(mem.col + mem.w);
    }
  });

  it("has no Seats desks, PCs or switch in the city — its Seats are a hall under the lounge, nobody's desk", () => {
    const w = buildCityWorld(roster.plans, { seats: 20 });
    expect(w.props.filter((p) => (p.kind as string) === "switch" || (p.kind === "pc" && p.capacity) || p.id.startsWith("cap/seats:desk"))).toEqual([]);
    expect(w.seats.filter((s) => s.houseKey.startsWith("cap/"))).toEqual([]);
  });

  it("has exactly one hall prop — the Seats hall, 13 × 9 — whatever the bench count; none without a capacity layout", () => {
    for (const seats of [0, 1, 16, 64, 65, 200]) {
      const w = buildCityWorld(roster.plans, { seats });
      const halls = w.props.filter((p) => p.kind === "hall" || p.id.endsWith(":hall"));
      expect(halls.map((p) => [p.id, p.kind, p.capacity, p.w, p.h]), `${seats} benches`).toEqual([["cap/seats:hall", "hall", "seats", 13, 9]]);
      // Two capacity rooms under the street: the lounge (a bench per agent) and the Seats hall — one of each.
      expect(w.houses.filter((h) => h.capacity === "seats").map((h) => [h.key, h.label])).toEqual([["cap/seats", "Seats"]]);
      expect(w.houses.filter((h) => h.capacity === "lounge").map((h) => [h.key, h.label])).toEqual([["cap/lounge", "Lounge"]]);
      expect(w.props.filter((p) => p.kind === "bench")).toHaveLength(seats);
    }
    expect(buildCityWorld(roster.plans).props.some((p) => p.kind === "hall")).toBe(false);
    expect(buildCityWorld(roster.plans).houses.some((h) => h.capacity)).toBe(false);
    expect(buildCityWorld([], { seats: 64 }).props.filter((p) => p.kind === "hall")).toHaveLength(1);
  });

  it("keeps the HQ exactly as it was: two floors, Memory then Usage, 11 rows tall, whatever the bench count — the Seats hall is not a floor of it", () => {
    for (const seats of [0, 16, 64, 65, 200]) {
      const w = buildCityWorld(roster.plans, { seats });
      const hq = hqOf(w);
      expect(hq.floors, `${seats} benches`).toEqual(["cap/memory", "cap/usage"]);
      // Two floors of 5 rows and the street-level front wall.
      expect(hq.h).toBe(11);
      expect(hq.row + hq.h).toBe(w.city!.street);
      // The capacity rooms, in order: the HQ's two floors, then the lounge and the hall under the street.
      expect(w.houses.filter((h) => h.capacity).map((h) => [h.key, h.capacity])).toEqual([
        ["cap/memory", "memory"],
        ["cap/usage", "usage"],
        ["cap/lounge", "lounge"],
        ["cap/seats", "seats"],
      ]);
      // Neither the hall nor the lounge is inside the HQ: both lie wholly below the street.
      for (const h of w.houses.filter((x) => x.capacity === "seats" || x.capacity === "lounge")) expect(h.row).toBeGreaterThan(w.city!.street + 3);
    }
  });

  it("an HQ alone still makes a city: a lamp after it, no tree", () => {
    const w = buildCityWorld([], { seats: 2 });
    expect(w.city!.buildings).toHaveLength(1);
    expect(w.props.filter((p) => p.id.startsWith("street:tree"))).toEqual([]);
    expect(w.props.filter((p) => p.id.startsWith("street:lamp"))).toHaveLength(2);
  });

  it("the sim still seats each leader on its own floor with the HQ standing in the middle", () => {
    const w = buildCityWorld(roster.plans, { seats: 64 });
    const sim = new VillageSim({ seed: 1, stayPut: true });
    sim.setWorld(w);
    sim.setAgents(roster.agents);
    expect(sim.seatFor("a")?.id).toBe(`${floorKey("a")}:lead`);
    expect(sim.seatFor("b")?.id).toBe(`${floorKey("b")}:lead`);
  });
});

describe("buildCityWorld — the lounge under the street", () => {
  const roster = planCity([agent("a", "gazelle"), ...subs("a", 3), agent("b", "zeta")]);
  const benches = (w: World) => w.props.filter((p) => p.kind === "bench");

  it("is the Lounge house, dug in under the far sidewalk below the HQ: soil, back wall, headroom, a bench row and its aisle per 16 benches", () => {
    for (const seats of [1, 16, 17, 64, 80]) {
      const w = buildCityWorld(roster.plans, { seats });
      const { street, lounge } = w.city!;
      const hq = w.city!.buildings.find((b) => b.hq)!;
      const room = w.houses.find((h) => h.key === lounge!.key)!;
      expect(lounge!.key).toBe("cap/lounge");
      expect([room.capacity, room.label, room.hasIde]).toEqual(["lounge", "Lounge", false]);
      expect(benchRows(seats)).toBe(Math.ceil(seats / LOUNGE_ROW_SEATS));
      // One soil row under the far sidewalk, then its back wall (the house's first row).
      expect(room.row).toBe(street + 5);
      expect([room.w, room.h]).toEqual([LOUNGE_W, 2 + 2 * benchRows(seats)]);
      // Centred on the HQ's door: its lift.
      expect(lounge!.lift.col).toBe(hq.doorCol);
      expect(2 * room.col + room.w - 1).toBe(2 * hq.doorCol);
      // Walls all round (the back wall is the house's first row), floor inside, open ground around it.
      const bottom = room.row + room.h;
      for (let c = room.col - 1; c <= room.col + room.w; c++) {
        expect([c, kindAt(w, c, room.row), kindAt(w, c, bottom)]).toEqual([c, "wall", "wall"]);
        expect(kindAt(w, c, room.row - 1)).toBe("sky");
        expect(kindAt(w, c, bottom + 1)).toBe("sky");
      }
      for (let r = room.row + 1; r < bottom; r++) {
        expect([kindAt(w, room.col - 1, r), kindAt(w, room.col + room.w, r)]).toEqual(["wall", "wall"]);
        for (let c = room.col; c < room.col + room.w; c++) expect(kindAt(w, c, r)).toBe("floor");
      }
      expect(kindAt(w, room.col - 2, room.row + 1)).toBe("sky");
      // A row of earth below it, the Seats hall's top wall, its 9 rows, its floor wall (bottom + 12), a row
      // of earth, then the subway tunnel (5 rows), then a row of earth: the world's end.
      expect(w.houses.find((h) => h.capacity === "seats")!.row).toBe(bottom + 2);
      expect(w.city!.subway!.top).toBe(bottom + 14);
      expect(w.rows).toBe(bottom + 20);
    }
  });

  it("has a bench per agent, numbered in reading order: two benches of four each side of the lift, sixteen to a row", () => {
    const w = buildCityWorld(roster.plans, { seats: 70 });
    const room = w.houses.find((h) => h.capacity === "lounge")!;
    const lift = w.city!.lounge!.lift.col;
    const bs = benches(w);
    expect(bs.map((p) => p.index)).toEqual(Array.from({ length: 70 }, (_, i) => i));
    expect(new Set(bs.map((p) => `${p.col},${p.row}`)).size).toBe(70);
    for (const p of bs) {
      expect(p).toMatchObject({ id: `cap/lounge:bench:${p.index}`, w: 1, h: 1, facing: "down", capacity: "lounge" });
      const i = p.index as number;
      // Its row: the bench rows start under the headroom, two rows apart.
      expect(p.row).toBe(room.row + 2 + 2 * Math.floor(i / LOUNGE_ROW_SEATS));
      // Inside the room, never in the lift's column or the aisle beside it, never on the margin.
      expect(p.col).toBeGreaterThan(room.col);
      expect(p.col).toBeLessThan(room.col + room.w - 1);
      expect(Math.abs(p.col - lift)).toBeGreaterThan(1);
      // Its half: the first eight of a row left of the lift, the next eight right of it.
      expect(p.col < lift).toBe(i % LOUNGE_ROW_SEATS < 8);
    }
    // Reading order: left to right along a row, then the next row.
    for (let i = 1; i < 70; i++)
      if (i % LOUNGE_ROW_SEATS) expect(bs[i].col).toBeGreaterThan(bs[i - 1].col);
      else expect(bs[i].row).toBe(bs[i - 1].row + 2);
    // Benches of four: a gap after every fourth seat of a half.
    const row0 = bs.slice(0, LOUNGE_ROW_SEATS).map((p) => p.col - lift);
    expect(row0).toEqual([-10, -9, -8, -7, -5, -4, -3, -2, 2, 3, 4, 5, 7, 8, 9, 10]);
  });

  it("has a lift from the far sidewalk (its kiosk) down through every bench row's aisle, in front of the HQ's door", () => {
    const w = buildCityWorld(roster.plans, { seats: 64 });
    const { street, lounge } = w.city!;
    const room = w.houses.find((h) => h.capacity === "lounge")!;
    const aisles = [0, 1, 2, 3].map((k) => room.row + 3 + 2 * k);
    expect(lounge!.lift).toEqual({ col: lounge!.lift.col, top: street + 3, bottom: aisles[3], stops: [street + 3, ...aisles] });
    expect(w.props.filter((p) => p.kind === "lift")).toEqual([{ id: "cap/lounge:lift", kind: "lift", col: lounge!.lift.col, row: street + 3, w: 1, h: 1 }]);
    // Every aisle stop is clear floor along the whole row, and nothing stands in the lift's column below the sidewalk.
    for (const r of aisles) for (let c = room.col; c < room.col + room.w; c++) expect(w.props.some((p) => p.col === c && p.row === r)).toBe(false);
    for (let r = street + 4; r <= lounge!.lift.bottom; r++) expect(w.props.some((p) => p.col === lounge!.lift.col && p.row === r)).toBe(false);
  });

  it("is none without a capacity layout, and the HQ has no lift of its own", () => {
    expect(buildCityWorld(roster.plans).city!.lounge).toBeUndefined();
    expect(benches(buildCityWorld(roster.plans))).toEqual([]);
    expect(buildCityWorld(roster.plans).rows).toBe(buildCityWorld(roster.plans).city!.street + 4);
  });
});

describe("buildCityWorld — the subway under the lounge", () => {
  const roster = planCity([agent("a", "gazelle"), ...subs("a", 3), agent("b", "zeta")]);

  it("digs a tunnel under the Seats hall (under the lounge): a row of earth, the ceiling, three rows of tunnel, the track bed, a row of earth", () => {
    for (const seats of [1, 64, 80]) {
      const w = buildCityWorld(roster.plans, { seats });
      const hall = w.houses.find((h) => h.capacity === "seats")!;
      const sub = w.city!.subway!;
      // The hall's floor wall: its top wall, then its 9 rows.
      const hallFloor = hall.row + 10;
      expect(kindAt(w, w.city!.lounge!.lift.col, hallFloor)).toBe("wall");
      expect(kindAt(w, w.city!.lounge!.lift.col, hallFloor + 1)).toBe("sky");
      expect(sub.top).toBe(hallFloor + 2);
      expect(TUNNEL_ROWS).toBe(5);
      expect(sub.bottom).toBe(sub.top + 4);
      expect(sub.rail).toBe(sub.bottom - 1);
      expect(w.rows).toBe(sub.bottom + 2);
      // The tunnel's rows are left to the renderer (it runs past the world's ends): no tile there is built on.
      for (let r = sub.top; r <= sub.bottom; r++) for (let c = 0; c < w.cols; c++) expect(kindAt(w, c, r)).toBe("sky");
    }
  });

  it("puts its street entrance on the far sidewalk, left of the lounge and clear of it, with the station's platform under it", () => {
    const w = buildCityWorld(roster.plans, { seats: 64 });
    const { street, subway, lounge } = w.city!;
    const room = w.houses.find((h) => h.capacity === "lounge")!;
    const sub = subway!;
    expect(w.props.filter((p) => p.kind === "metro")).toEqual([{ id: "city:metro", kind: "metro", col: sub.entrance.col, row: street + 3, w: 2, h: 1 }]);
    expect(sub.entrance.row).toBe(street + 3);
    // Three columns of earth between its stairs and the lounge's left wall; never on the lift's crossing.
    expect(room.col - 1 - (sub.entrance.col + 2)).toBe(3);
    expect(Math.abs(sub.entrance.col - lounge!.lift.col)).toBeGreaterThan(2);
    // Nothing else stands on its two sidewalk tiles.
    for (const c of [sub.entrance.col, sub.entrance.col + 1])
      expect(w.props.filter((p) => p.kind !== "metro" && p.row === street + 3 && c >= p.col && c < p.col + p.w)).toEqual([]);
    // The platform: the whole train and a tile past each end of it (34 columns), under the entrance,
    // inside the world — this entrance is 11 columns from the west end, so the platform starts there.
    expect(STATION_W).toBe(34);
    expect(STATION_W * TILE).toBeGreaterThanOrEqual(TRAIN_LEN + 2 * TILE);
    expect(sub.entrance.col).toBe(11);
    expect(sub.station).toEqual({ col0: 0, col1: 34 });
    expect(sub.station.col0).toBeGreaterThanOrEqual(0);
    expect(sub.station.col1).toBeLessThanOrEqual(w.cols);
  });

  it("centres the platform under the entrance, slides it whole into the world near an end, and never makes it wider than the world", () => {
    // Centred on the entrance's middle (its left column + 1): 16 columns left of the entrance, 18 right.
    expect(stationCols(50, 120)).toEqual({ col0: 34, col1: 68 });
    expect((34 + 68) / 2).toBe(50 + 1);
    // Near the west end, or the east end: slid in, still 34 wide, still under the entrance's two columns.
    expect(stationCols(3, 120)).toEqual({ col0: 0, col1: 34 });
    expect(stationCols(110, 120)).toEqual({ col0: 86, col1: 120 });
    for (const e of [0, 3, 15, 16, 50, 100, 110, 118]) {
      const { col0, col1 } = stationCols(e, 120);
      expect(col1 - col0).toBe(STATION_W);
      expect(col0 <= e && e + 2 <= col1).toBe(true);
    }
    // A world narrower than the platform: all of it.
    expect(stationCols(5, 20)).toEqual({ col0: 0, col1: 20 });
  });

  it("is none without a capacity layout (there is no lounge to dig under)", () => {
    const w = buildCityWorld(roster.plans);
    expect(Object.keys(w.city!)).toEqual(["street", "buildings"]);
    expect(w.props.filter((p) => p.kind === "metro")).toEqual([]);
  });
});

describe("buildCityWorld — the Seats hall under the lounge (the hall in both views)", () => {
  const roster = planCity([agent("a", "gazelle"), ...subs("a", 3), agent("b", "zeta")]);
  const hallOf = (w: World) => w.houses.find((h) => h.capacity === "seats")!;
  const loungeOf = (w: World) => w.houses.find((h) => h.capacity === "lounge")!;

  it("is one hall prop, 13 × 9, centred on the lounge's lift column — one row of earth between the lounge's floor wall and its top wall", () => {
    for (const seats of [1, 16, 17, 64, 80]) {
      const w = buildCityWorld(roster.plans, { seats });
      const lift = w.city!.lounge!.lift.col;
      expect(lift).toBe(w.city!.buildings.find((b) => b.hq)!.doorCol);
      const lounge = loungeOf(w);
      const loungeFloor = lounge.row + lounge.h;
      expect(kindAt(w, lift, loungeFloor)).toBe("wall");
      const hall = hallOf(w);
      // One row of earth across the hall's whole width (its board hangs there), then its top wall.
      expect(hall.row, `${seats} benches`).toBe(loungeFloor + 2);
      for (let c = lift - 7; c <= lift + 7; c++) expect([c, kindAt(w, c, loungeFloor + 1)]).toEqual([c, "sky"]);
      // Thirteen columns, the lift's in the middle: six either side of it.
      expect(hall).toMatchObject({ key: "cap/seats", label: "Seats", col: lift - 6, row: loungeFloor + 2, w: 13, h: 10, hasIde: false, capacity: "seats" });
      expect(w.props.filter((p) => p.kind === "hall")).toEqual([
        { id: "cap/seats:hall", kind: "hall", col: lift - 6, row: loungeFloor + 3, w: 13, h: 9, capacity: "seats" },
      ]);
      // Nobody sits in it: it is a picture of the context window, not a room with desks.
      expect(w.seats.filter((s) => s.houseKey === "cap/seats")).toEqual([]);
    }
  });

  it("is walled all round — its top wall, both sides, its floor wall — floor inside under the hall prop, open earth round it", () => {
    for (const seats of [1, 64, 65]) {
      const w = buildCityWorld(roster.plans, { seats });
      const lift = w.city!.lounge!.lift.col;
      const top = hallOf(w).row;
      const floor = top + 10;
      let walls = 0;
      let floors = 0;
      for (let r = top; r <= floor; r++)
        for (let c = lift - 7; c <= lift + 7; c++) {
          const edge = r === top || r === floor || c === lift - 7 || c === lift + 7;
          expect([c, r, kindAt(w, c, r)]).toEqual([c, r, edge ? "wall" : "floor"]);
          if (edge) walls++;
          else floors++;
        }
      // 15 wide wall to wall, 11 tall: 2 × 15 + 2 × 9 wall tiles round 13 × 9 floor tiles.
      expect([walls, floors]).toEqual([48, 117]);
      // The hall prop covers exactly that floor.
      const prop = w.props.find((p) => p.kind === "hall")!;
      expect([prop.col, prop.row, prop.col + prop.w - 1, prop.row + prop.h - 1]).toEqual([lift - 6, top + 1, lift + 6, floor - 1]);
      // Open earth round it: a column either side, the row under its floor wall.
      for (let r = top; r <= floor; r++) expect([r, kindAt(w, lift - 8, r), kindAt(w, lift + 8, r)]).toEqual([r, "sky", "sky"]);
      for (let c = lift - 8; c <= lift + 8; c++) expect([c, kindAt(w, c, floor + 1)]).toEqual([c, "sky"]);
    }
  });

  it("goes down with the lounge: each extra bench row (65+ benches, 16 at a time) pushes the hall and the tunnel down by exactly its two rows — the street and the hall's columns stay", () => {
    /** Rows from the street (and the hall's column from the lift) of everything under it. */
    const at = (seats: number) => {
      const w = buildCityWorld(roster.plans, { seats });
      const s = w.city!.street;
      const prop = w.props.find((p) => p.kind === "hall")!;
      return { street: s, col: hallOf(w).col - w.city!.lounge!.lift.col, hall: hallOf(w).row - s, prop: prop.row - s, tunnel: w.city!.subway!.top - s, rows: w.rows - s };
    };
    const street = at(64).street;
    // 64 benches, 4 bench rows: the street's 4 rows, earth, the lounge (back wall, headroom, 4 × bench row
    // + aisle) and its floor wall at +15, earth, the hall's top wall at +17, its 9 rows, its floor wall at
    // +27, earth, the tunnel from +29 (5 rows), earth: 35 rows from the street to the world's end.
    expect(at(64)).toEqual({ street, col: -6, hall: 17, prop: 18, tunnel: 29, rows: 35 });
    // 65 benches: a fifth bench row and its aisle — everything under the lounge two rows lower.
    expect(at(65)).toEqual({ street, col: -6, hall: 19, prop: 20, tunnel: 31, rows: 37 });
    expect(at(80)).toEqual(at(65));
    expect(at(81)).toEqual({ street, col: -6, hall: 21, prop: 22, tunnel: 33, rows: 39 });
    // A smaller lounge lifts it the same way: one bench row.
    expect(at(16)).toEqual({ street, col: -6, hall: 11, prop: 12, tunnel: 23, rows: 29 });
  });

  it("lies inside the world and inside the lounge's walls' span, whatever the street round it", () => {
    const wide = planCity([agent("w", "wide"), ...subs("w", 40), agent("n", "narrow")]).plans;
    for (const plans of [[], roster.plans, wide])
      for (const seats of [16, 64, 65]) {
        const w = buildCityWorld(plans, { seats });
        const hall = hallOf(w);
        const lounge = loungeOf(w);
        // Its walls: a column either side of its 13, and its floor wall 10 rows under its top wall.
        expect(hall.col - 1).toBeGreaterThanOrEqual(0);
        expect(hall.col + 13).toBeLessThan(w.cols);
        expect(hall.row + 10).toBeLessThan(w.rows);
        // Narrower than the lounge above it (15 wall to wall against 25): its walls stand inside the lounge's.
        expect(hall.col - 1).toBeGreaterThan(lounge.col - 1);
        expect(hall.col + 13).toBeLessThan(lounge.col + lounge.w);
        expect([hall.col - 1 - (lounge.col - 1), lounge.col + lounge.w - (hall.col + 13)]).toEqual([5, 5]);
      }
  });
});

describe("buildCityWorld — desk rows (after every 10 tables, continue vertically)", () => {
  it("fills a row with ROW_DESKS desks, then grows the floor a desk row taller instead of wider", () => {
    expect([0, 2, 18, 20, 22, 40, 42].map(deskRows)).toEqual([1, 1, 1, 1, 2, 2, 3]);
    expect([1, 2, 3].map(floorHeight)).toEqual([FLOOR_H, FLOOR_H + ROW_PITCH, FLOOR_H + 2 * ROW_PITCH]);
    expect([18, 20, 22, 64].map(floorWidth)).toEqual([33, 36, 36, 36]);
    expect(ROW_DESKS).toBe(10);
  });

  it("puts team seat i on row i ÷ 20, desks of two three columns apart — every desk, PC and chair inside the floor", () => {
    const w = buildCityWorld([plan("p", 46, 1)]);
    const h = w.houses[0];
    expect(h.h).toBe(floorHeight(3) - 1);
    const [W, A] = [h.row, h.row + 2];
    const team = w.seats.filter((s) => s.forSub);
    expect(team).toHaveLength(46);
    const prop = (id: string) => w.props.find((p) => p.id === id)!;
    team.forEach((s, i) => {
      const r = Math.floor(i / 20);
      const j = i % 20;
      const col = h.col + 5 + 3 * Math.floor(j / 2) + (j % 2);
      expect([s.id, s.col, s.row]).toEqual([`${h.key}:team:${i}`, col, A + ROW_PITCH * r + 1]);
      expect(prop(`${h.key}:pc:${i}`)).toMatchObject({ col, row: A + ROW_PITCH * r });
      expect(prop(`${h.key}:chair:${i}`)).toMatchObject({ col, row: A + ROW_PITCH * r + 1, facing: "up" });
      if (j % 2 === 0) expect(prop(`${h.key}:desk:${i / 2}`)).toMatchObject({ col, row: A + ROW_PITCH * r, w: 2 });
    });
    for (const p of w.props.filter((x) => x.id.startsWith(`${h.key}:`))) {
      expect(p.col).toBeGreaterThanOrEqual(h.col);
      expect(p.col + p.w).toBeLessThanOrEqual(h.col + h.w);
      expect(p.row).toBeGreaterThan(W);
      expect(p.row + p.h).toBeLessThanOrEqual(h.row + h.h);
    }
    // The aisle above each later desk row is clear.
    for (const r of [A + 2, A + 5]) expect(w.props.filter((p) => p.row === r && p.id.startsWith(`${h.key}:`))).toEqual([]);
    // Every row but the back wall is floor.
    for (let r = h.row - 1; r < h.row + h.h; r++) expect(kindAt(w, h.col + 6, r)).toBe(r === W ? "wall" : "floor");
  });

  it("gives every floor of a building the most crowded one's desk rows, and stacks them that far apart", () => {
    const roster = planCity([agent("r", "p"), ...subs("r", 25), agent("q", "p"), ...subs("q", 2)]);
    const w = buildCityWorld(roster.plans);
    const [ground, upper] = w.houses;
    expect([ground.h, upper.h]).toEqual([floorHeight(2) - 1, floorHeight(2) - 1]);
    expect(ground.row - upper.row).toBe(floorHeight(2));
    expect(w.city!.buildings[0].h).toBe(2 * floorHeight(2) + 1);
  });

  it("keeps the seats a team already had where they were on their floor when it wraps onto a new row", () => {
    const at = (team: number) => {
      const w = buildCityWorld([plan("p", team, 1)]);
      const h = w.houses[0];
      return w.seats.filter((s) => s.forSub).map((s) => [s.id, s.col - h.col, s.row - h.row]);
    };
    expect(at(22).slice(0, 20)).toEqual(at(20));
  });
});

describe("buildCityWorld — a project building's lift", () => {
  it("runs up the door column of a building with a team, stopping at every floor's chair rows and at the door — clear of every prop", () => {
    const roster = planCity([agent("r", "p"), ...subs("r", 25), agent("q", "p"), agent("s", "solo")]);
    const w = buildCityWorld(roster.plans, { seats: 64 });
    // "solo" has no team: nobody ever rides to it, so it has no lift.
    expect(w.city!.buildings.filter((x) => !x.hq && !x.lift).map((x) => x.key)).toEqual(["solo"]);
    for (const b of w.city!.buildings.filter((x) => x.lift)) {
      const front = b.row + b.h - 1;
      const lift = b.lift!;
      expect(lift.col).toBe(b.doorCol);
      expect(lift.bottom).toBe(front);
      expect(lift.top).toBe(lift.stops[0]);
      expect(lift.stops).toEqual([...lift.stops].sort((x, y) => x - y));
      expect(lift.stops[lift.stops.length - 1]).toBe(front);
      // The stops: each floor's chair rows (the leader's desk row is the first), nothing else.
      const floors = b.floors.map((k) => w.houses.find((h) => h.key === k)!);
      const chairRows = floors.flatMap((h) => Array.from({ length: (h.h - 1) / ROW_PITCH }, (_, k) => h.row + 3 + ROW_PITCH * k));
      expect(lift.stops).toEqual([...chairRows.sort((x, y) => x - y), front]);
      // Every team seat's row is a stop.
      for (const s of w.seats.filter((x) => x.forSub && floors.some((h) => h.key === x.houseKey))) expect(lift.stops).toContain(s.row);
      // Nothing stands in the lift's column, from its top floor's slab to the door.
      for (let r = b.row; r <= front; r++) expect(w.props.filter((p) => p.col <= lift.col && lift.col < p.col + p.w && p.row <= r && r < p.row + p.h)).toEqual([]);
    }
  });
});

describe("buildCityWorld — a project floor's Wi-Fi router (engine/teamLan.ts)", () => {
  const routers = (w: World) => w.props.filter((p) => p.kind === "router");
  const covers = (p: Prop, c: number, r: number) => c >= p.col && c < p.col + p.w && r >= p.row && r < p.row + p.h;
  /** Teams of 1 (a desk of two), 12 and 13 (seven desks); b2 has no sub-agents but its building has
   * a team, so it gets the desks and a router; delta has no team (an agent and a console). */
  const roster = planCity([
    agent("a", "alpha"),
    ...subs("a", 1),
    agent("b", "beta"),
    ...subs("b", 12),
    agent("b2", "beta"),
    agent("c", "gamma"),
    ...subs("c", 13),
    agent("d", "delta"),
    term("1", "delta"),
  ]);
  const teamed = roster.plans.filter((p) => p.team > 0);
  const prop = (w: World, id: string) => w.props.find((p) => p.id === id)!;

  it("hangs exactly one on every floor of a building with a team, at (floor col + 3, floor row + 1)", () => {
    const w = buildCityWorld(roster.plans);
    expect(teamed.map((p) => [p.key, p.team, p.floors.length])).toEqual([
      ["alpha", 2, 1],
      ["beta", 12, 2],
      ["gamma", 14, 1],
    ]);
    expect(routers(w)).toHaveLength(4);
    for (const plan of teamed)
      for (const { key } of plan.floors) {
        const floor = w.houses.find((h) => h.key === key)!;
        // The contract the team LAN model wires from: the headroom row under the back wall, 1×1, no capacity.
        expect(routers(w).filter((p) => p.id.startsWith(`${key}:`))).toEqual([
          { id: `${key}:router`, kind: "router", col: floor.col + 3, row: floor.row + 1, w: 1, h: 1 },
        ]);
        const r = prop(w, `${key}:router`);
        expect(r.col).toBeLessThan(floor.col + floor.w);
        expect(kindAt(w, r.col, r.row)).toBe("floor");
        expect(kindAt(w, r.col, r.row - 1)).toBe("wall"); // the floor's back wall
        expect(isIndoorTile(w, r.col, r.row)).toBe(true);
      }
  });

  it("over the end of the leader's desk, beside the lift: left of the lift, the first team desk and the shelf on its row", () => {
    const w = buildCityWorld(roster.plans);
    for (const { key: bk, floors } of teamed)
      for (const { key } of floors) {
        const r = prop(w, `${key}:router`);
        const lead = prop(w, `${key}:desk:lead`);
        const desk0 = prop(w, `${key}:desk:0`);
        const shelf = prop(w, `${key}:shelf`);
        const lift = w.city!.buildings.find((b) => b.key === bk)!.lift!;
        expect(r.col).toBe(lead.col + lead.w - 1);
        expect(r.col).toBe(lift.col - 1);
        expect(r.col).toBe(desk0.col - 2);
        expect(shelf.row).toBe(r.row);
        expect(shelf.col).toBeGreaterThan(lift.col);
        // Nothing else on its tile's row-mates' way down: the lift column beside it is clear on every row of the floor.
        expect(w.props.filter((p) => p.id.startsWith(`${key}:`) && covers(p, lift.col, r.row + 1))).toEqual([]);
      }
  });

  it("shares its tile with no other prop and blocks nobody", () => {
    const w = buildCityWorld(roster.plans, { seats: 6 });
    expect(routers(w)).toHaveLength(4);
    for (const r of routers(w)) {
      expect(w.props.filter((p) => p !== r && covers(p, r.col, r.row))).toEqual([]);
      expect(walkable(w, r.col, r.row)).toBe(true);
    }
    const without: World = { ...w, props: w.props.filter((p) => p.kind !== "router") };
    expect(Array.from(walkGrid(w))).toEqual(Array.from(walkGrid(without)));
  });

  it("none on a building without a team, none on the Capacity HQ's floors, none in an empty city", () => {
    const w = buildCityWorld(roster.plans, { seats: 6 });
    const bare = roster.plans.find((p) => p.key === "delta")!;
    expect(bare.team).toBe(0);
    for (const h of w.houses.filter((x) => x.capacity || bare.floors.some((f) => f.key === x.key))) {
      expect(w.props.filter((p) => p.kind === "router" && p.col >= h.col && p.col < h.col + h.w && p.row >= h.row && p.row < h.row + h.h)).toEqual([]);
      expect(w.props.some((p) => p.kind === "router" && p.id.startsWith(`${h.key}:`))).toBe(false);
    }
    expect(routers(buildCityWorld([], { seats: 4 }))).toEqual([]);
    expect(routers(buildCityWorld([]))).toEqual([]);
    expect(routers(buildCityWorld(planCity([agent("x", "p"), term("2", "p")]).plans))).toEqual([]);
  });

  it("keeps its id across rebuilds, and when other buildings come and go", () => {
    expect(routers(buildCityWorld(roster.plans))).toEqual(routers(buildCityWorld(roster.plans)));
    const ids = (w: World) => routers(w).map((p) => p.id).sort();
    const more = planCity([agent("z", "zzz"), ...subs("z", 3)]).plans;
    const big = buildCityWorld([...roster.plans, ...more], { seats: 4 });
    expect(ids(big)).toEqual([...ids(buildCityWorld(roster.plans)), `${floorKey("z")}:router`].sort());
    for (const r of routers(big)) {
      const floor = big.houses.find((h) => r.id === `${h.key}:router`)!;
      expect([r.col, r.row]).toEqual([floor.col + 3, floor.row + 1]);
    }
  });
});
