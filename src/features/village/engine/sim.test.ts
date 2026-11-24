import { describe, expect, it } from "vitest";
import { TILE, type Ambience, type CharacterView, type Dir, type Prop, type Seat, type VillageActivity, type VillageAgent, type World } from "../villageTypes";
import { asciiWorld } from "./testWorld";
import { buildCityWorld, planCity } from "./city";
import { FX_SEC, MAX_DT, RESULT_BEAT, SIT_OFFSET, VillageSim, WALK_SPEED } from "./sim";
import { buildWorld, isIndoorTile, planHouses, walkable } from "./world";

function agent(key: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "external",
    title: `T-${key}`,
    folder: "proj",
    activity: "idle",
    tool: null,
    ideAgentId: null,
    lastActivityAt: null,
    ...extra,
  };
}

function setup(agents: VillageAgent[], seed = 1) {
  const sim = new VillageSim({ seed });
  const world = buildWorld(planHouses(agents));
  sim.setWorld(world);
  sim.setAgents(agents);
  return { sim, world };
}

const view = (sim: VillageSim, key: string): CharacterView => {
  const v = sim.characters().find((c) => c.key === key);
  if (!v) throw new Error(`no character ${key}`);
  return v;
};

/** Tile a character stands on (undoing the sitting offset). */
const tileOf = (v: CharacterView) => ({
  col: Math.floor(v.x / TILE),
  row: Math.round((v.y - (v.seated ? SIT_OFFSET : 0) - TILE) / TILE),
});

const seatOf = (world: World, v: CharacterView): Seat | undefined => {
  const t = tileOf(v);
  return world.seats.find((s) => s.col === t.col && s.row === t.row);
};

/** Tick in 0.1 s steps until `pred` holds (returns true) or `maxSec` elapses (returns false). */
function runUntil(sim: VillageSim, maxSec: number, pred: () => boolean): boolean {
  for (let t = 0; t < maxSec; t += 0.1) {
    if (pred()) return true;
    sim.tick(0.1);
  }
  return pred();
}

const run = (sim: VillageSim, sec: number) => runUntil(sim, sec, () => false);

/** Let spawn effects finish. */
const settle = (sim: VillageSim) => run(sim, FX_SEC + 0.05);

describe("VillageSim basics", () => {
  it("starts on an empty default world with no characters", () => {
    const sim = new VillageSim();
    expect(sim.time).toBe(0);
    expect(sim.characters()).toEqual([]);
    expect(sim.pcOn("nope")).toBe(false);
  });

  it("clamps dt to [0, 0.1]", () => {
    const sim = new VillageSim();
    sim.tick(5);
    expect(sim.time).toBeCloseTo(MAX_DT);
    sim.tick(-1);
    expect(sim.time).toBeCloseTo(MAX_DT);
    sim.tick(0.05);
    expect(sim.time).toBeCloseTo(0.15);
  });

  it("is deterministic for a seed", () => {
    const agents = ["a", "b", "c"].map((k) => agent(k));
    const trace = (seed: number) => {
      const { sim } = setup(agents, seed);
      const out: string[] = [];
      for (let i = 0; i < 600; i++) {
        sim.tick(0.1);
        if (i % 20 === 0) out.push(sim.characters().map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)},${c.anim}`).join("|"));
      }
      return out;
    };
    expect(trace(7)).toEqual(trace(7));
    expect(trace(7)).not.toEqual(trace(8));
  });
});

describe("spawn / despawn effects", () => {
  it("plays a 0.3 s spawn effect, then a 0.3 s despawn before the character disappears", () => {
    const { sim } = setup([agent("a", { activity: "typing" })]);
    expect(view(sim, "a").fx).toEqual({ kind: "spawn", t: 0 });
    sim.tick(0.1);
    sim.tick(0.05);
    expect(view(sim, "a").fx!.t).toBeCloseTo(0.5);
    sim.tick(0.1);
    sim.tick(0.06);
    expect(view(sim, "a").fx).toBeNull();

    sim.setAgents([]);
    expect(view(sim, "a").fx).toEqual({ kind: "despawn", t: 0 });
    sim.tick(0.1);
    sim.tick(0.1);
    expect(view(sim, "a").fx!.kind).toBe("despawn");
    // A second removal does not restart the effect.
    sim.setAgents([]);
    expect(view(sim, "a").fx!.t).toBeCloseTo(2 / 3);
    sim.tick(0.1);
    expect(sim.characters()).toEqual([]);
  });

  it("revives a character that comes back mid-despawn", () => {
    const { sim } = setup([agent("a")]);
    settle(sim);
    sim.setAgents([]);
    sim.tick(0.1);
    sim.setAgents([agent("a", { title: "back" })]);
    const v = view(sim, "a");
    expect(v.fx).toEqual({ kind: "spawn", t: 0 });
    expect(v.label).toBe("back");
    run(sim, 1);
    expect(view(sim, "a").fx).toBeNull();
  });
});

describe("activities", () => {
  it("typing: sits at a pc seat in its house, types, and switches the pc on", () => {
    const { sim, world } = setup([agent("a", { activity: "typing", tool: "Edit" })]);
    const v = view(sim, "a");
    const seat = seatOf(world, v)!;
    expect(seat).toBeDefined();
    expect(seat.houseKey).toBe("proj");
    expect(v).toMatchObject({ seated: true, anim: "type", dir: "up", tool: "Edit", label: "T-a", origin: "external", isSubagent: false });
    expect(v.y).toBe(seat.row * TILE + TILE + SIT_OFFSET);
    expect(sim.pcOn(seat.pcId!)).toBe(true);
    const other = world.seats.find((s) => s !== seat)!;
    expect(sim.pcOn(other.pcId!)).toBe(false);
    // type frames alternate every 0.3 s
    settle(sim);
    const frames = new Set<number>();
    for (let i = 0; i < 10; i++) {
      sim.tick(0.1);
      frames.add(view(sim, "a").frame);
    }
    expect([...frames].sort()).toEqual([0, 1]);
  });

  it("reading uses the read anim, thinking types; both light the pc", () => {
    const { sim, world } = setup([agent("r", { activity: "reading" }), agent("t", { activity: "thinking" })]);
    expect(view(sim, "r").anim).toBe("read");
    expect(view(sim, "t").anim).toBe("type");
    for (const k of ["r", "t"]) expect(sim.pcOn(seatOf(world, view(sim, k))!.pcId!)).toBe(true);
  });

  it("waiting: sits idle with a sticky waiting bubble and the pc off", () => {
    const { sim, world } = setup([agent("a", { activity: "waiting" })]);
    run(sim, 30);
    const v = view(sim, "a");
    expect(v).toMatchObject({ seated: true, anim: "idle", frame: 0, bubble: "waiting", bubbleAlpha: 1 });
    expect(sim.pcOn(seatOf(world, v)!.pcId!)).toBe(false);
    sim.setAgents([agent("a", { activity: "typing" })]);
    expect(view(sim, "a")).toMatchObject({ bubble: null, anim: "type", seated: true });
  });

  it("waiting → idle clears the bubble and stands up", () => {
    const { sim } = setup([agent("a", { activity: "waiting" })]);
    settle(sim);
    sim.setAgents([agent("a", { activity: "idle" })]);
    expect(view(sim, "a")).toMatchObject({ bubble: null, seated: false, anim: "idle" });
  });

  it.each<VillageActivity>(["done", "error"])("%s: shows a bubble for 2 s that fades over 0.5 s, and stands up", (act) => {
    const { sim } = setup([agent("a", { activity: "typing" })]);
    settle(sim);
    sim.setAgents([agent("a", { activity: act })]);
    let v = view(sim, "a");
    expect(v).toMatchObject({ bubble: act, bubbleAlpha: 1, seated: false, anim: "idle" });
    for (let i = 0; i < 20; i++) sim.tick(0.1); // 2.0 s
    expect(view(sim, "a").bubbleAlpha).toBeCloseTo(1);
    sim.tick(0.1);
    sim.tick(0.1);
    sim.tick(0.05); // 2.25 s
    expect(view(sim, "a").bubbleAlpha).toBeCloseTo(0.5);
    sim.tick(0.1);
    sim.tick(0.1);
    sim.tick(0.06);
    v = view(sim, "a");
    expect(v.bubble).toBeNull();
    expect(v.bubbleAlpha).toBe(0);
  });

  it("a done bubble keeps fading through idle but is cleared by new work", () => {
    const { sim } = setup([agent("a", { activity: "done" })]);
    expect(view(sim, "a").bubble).toBe("done");
    sim.setAgents([agent("a", { activity: "idle" })]);
    expect(view(sim, "a").bubble).toBe("done");
    sim.setAgents([agent("a", { activity: "reading" })]);
    expect(view(sim, "a").bubble).toBeNull();
  });

  it("idle: rests at the desk briefly, then wanders — house, plaza and campfire — and comes home", () => {
    const { sim, world } = setup([agent("a")], 3);
    const v0 = view(sim, "a");
    const home = seatOf(world, v0)!;
    expect(v0).toMatchObject({ seated: true, anim: "idle" });
    expect(sim.pcOn(home.pcId!)).toBe(false);
    const house = world.houses[0];
    const fire = world.props.find((p) => p.kind === "campfire")!;
    const visited = { house: false, plaza: false, fire: false, home: false, walked: false };
    const frames = new Set<number>();
    let prev = v0;
    let leftHome = false;
    for (let i = 0; i < 15000; i++) {
      sim.tick(0.1);
      const v = view(sim, "a");
      // never faster than walk speed (allow the 1-tile snap on arrival)
      expect(Math.hypot(v.x - prev.x, (v.y - (v.seated ? SIT_OFFSET : 0)) - (prev.y - (prev.seated ? SIT_OFFSET : 0)))).toBeLessThanOrEqual(WALK_SPEED * 0.1 + 1e-6);
      prev = v;
      if (v.anim === "walk") {
        visited.walked = true;
        frames.add(v.frame);
        continue;
      }
      const t = tileOf(v);
      expect(walkable(world, t.col, t.row) || (t.col === home.col && t.row === home.row)).toBe(true);
      if (!v.seated) leftHome = true;
      const inHouse = t.col >= house.col && t.col < house.col + house.w && t.row >= house.row && t.row < house.row + house.h;
      if (inHouse && !v.seated) visited.house = true;
      if (world.tiles[t.row * world.cols + t.col] === "plaza") visited.plaza = true;
      if (Math.abs(t.col - fire.col) <= 1 && Math.abs(t.row - fire.row) <= 1) visited.fire = true;
      if (leftHome && v.seated && seatOf(world, v) === home) visited.home = true;
      if (Object.values(visited).every(Boolean)) break;
    }
    expect(visited).toEqual({ house: true, plaza: true, fire: true, home: true, walked: true });
    expect([...frames].sort()).toEqual([0, 1, 2, 3]);
  });

  it("typing → idle stands up immediately; idle → typing walks back to the seat mid-stroll", () => {
    const { sim, world } = setup([agent("a", { activity: "typing" })], 5);
    settle(sim);
    const home = seatOf(world, view(sim, "a"))!;
    sim.setAgents([agent("a", { activity: "idle" })]);
    expect(view(sim, "a")).toMatchObject({ seated: false, anim: "idle" });
    // wait until it is out walking, somewhere away from home
    expect(runUntil(sim, 120, () => view(sim, "a").anim === "walk" && seatOf(world, view(sim, "a")) !== home)).toBe(true);
    expect(runUntil(sim, 120, () => {
      const t = tileOf(view(sim, "a"));
      return Math.abs(t.col - home.col) + Math.abs(t.row - home.row) > 3;
    })).toBe(true);
    sim.setAgents([agent("a", { activity: "typing" })]);
    expect(runUntil(sim, 60, () => view(sim, "a").seated)).toBe(true);
    expect(seatOf(world, view(sim, "a"))).toBe(home);
    expect(view(sim, "a").anim).toBe("type");
  });

  it("an activity going active while walking home keeps the path and sits", () => {
    const { sim, world } = setup([agent("a")], 11);
    const home = seatOf(world, view(sim, "a"))!;
    // Walk until it is heading home: seated again after having left.
    let left = false;
    let caught = false;
    for (let i = 0; i < 20000 && !caught; i++) {
      sim.tick(0.1);
      const v = view(sim, "a");
      if (!v.seated) left = true;
      if (left && v.anim === "walk") {
        const t = tileOf(v);
        if (Math.abs(t.col - home.col) + Math.abs(t.row - home.row) <= 2 && i % 3 === 0) {
          sim.setAgents([agent("a", { activity: "thinking" })]);
          caught = true;
        }
      }
    }
    expect(caught).toBe(true);
    expect(runUntil(sim, 60, () => view(sim, "a").seated)).toBe(true);
    expect(seatOf(world, view(sim, "a"))).toBe(home);
    expect(view(sim, "a").anim).toBe("type");
  });
});

describe("resting and strolling", () => {
  it("a resting agent that gets work starts typing on the spot", () => {
    const { sim, world } = setup([agent("a")]);
    settle(sim);
    expect(view(sim, "a")).toMatchObject({ seated: true, anim: "idle" });
    sim.setAgents([agent("a", { activity: "typing" })]);
    const v = view(sim, "a");
    expect(v).toMatchObject({ seated: true, anim: "type" });
    expect(sim.pcOn(seatOf(world, v)!.pcId!)).toBe(true);
  });

  it("finishing while out for a stroll keeps walking", () => {
    const { sim } = setup([agent("a")], 5);
    expect(runUntil(sim, 120, () => view(sim, "a").anim === "walk")).toBe(true);
    sim.setAgents([agent("a", { activity: "done" })]);
    expect(view(sim, "a")).toMatchObject({ anim: "walk", bubble: "done" });
  });

  it("goes home to rest even when already standing on its seat", () => {
    // Two plaza tiles; the seat is the left one (no chair prop, so anyone may stand there).
    const seats: Seat[] = [{ id: "s", houseKey: "h", col: 0, row: 0, facing: "up", pcId: null }];
    const w = asciiWorld(["oo"], { seats, plaza: { col: 1, row: 0 } });
    const sim = new VillageSim({ seed: 12 });
    sim.setWorld(w);
    sim.setAgents([agent("a", { folder: "h" })]);
    let restsAfterStroll = 0;
    let strolled = false;
    let wasSeated = true;
    for (let i = 0; i < 50000 && restsAfterStroll < 6; i++) {
      sim.tick(0.1);
      const v = view(sim, "a");
      if (v.anim === "walk") strolled = true;
      if (v.seated && !wasSeated && strolled) restsAfterStroll++;
      wasSeated = v.seated;
    }
    expect(restsAfterStroll).toBe(6);
  });
});

describe("seats", () => {
  it("seatFor names the seat a character holds (its desk, for the context bar) — null for an unknown key or no seat", () => {
    const { sim, world } = setup(["a", "b"].map((k) => agent(k, { activity: "typing" })));
    expect(sim.seatFor("a")).toEqual(seatOf(world, view(sim, "a")));
    expect(sim.seatFor("nobody")).toBeNull();
    // A world without its house: everyone is still here, and nobody holds a seat.
    sim.setWorld(buildWorld([]));
    expect(sim.seatFor("a")).toBeNull();
  });

  it("seating lists who sits where — seated only, with its parent and activity; not walkers, not the despawning", () => {
    const agents = [agent("a", { activity: "typing" }), agent("s", { parentKey: "a", activity: "reading" }), agent("b", { activity: "typing" })];
    const { sim, world } = setup(agents);
    settle(sim);
    runUntil(sim, 30, () => sim.seating().length === 3);
    const seated = sim.seating();
    // Roster order: roots first, then sub-agents.
    expect(seated.map((x) => [x.key, x.parentKey, x.activity])).toEqual([
      ["a", null, "typing"],
      ["b", null, "typing"],
      ["s", "a", "reading"],
    ]);
    for (const x of seated) expect(x.seatId).toBe(seatOf(world, view(sim, x.key))!.id);
    // Removed: it despawns and leaves the list at once, though its sprite still fades out.
    sim.setAgents(agents.filter((x) => x.key !== "b"));
    expect(sim.seating().map((x) => x.key).sort()).toEqual(["a", "s"]);
    // Nobody sits in a world without their house.
    sim.setWorld(buildWorld([]));
    expect(sim.seating()).toEqual([]);
  });

  it("seating leaves out a character that holds a seat but has got up from it (an idle stroll)", () => {
    const { sim } = setup([agent("a", { activity: "idle" })]);
    settle(sim);
    expect(runUntil(sim, 600, () => view(sim, "a").anim === "walk")).toBe(true);
    expect(sim.seatFor("a")).not.toBeNull(); // still its seat…
    expect(sim.seating()).toEqual([]); // …but it is not sitting at it
  });

  it("assigns seats by key, independent of input order, and keeps them across calls", () => {
    const keys = ["d", "b", "a", "c"];
    const seatsFor = (order: string[]) => {
      const { sim, world } = setup(order.map((k) => agent(k, { activity: "typing" })));
      return Object.fromEntries(keys.map((k) => [k, seatOf(world, view(sim, k))!.id]));
    };
    const s1 = seatsFor(keys);
    expect(seatsFor([...keys].reverse())).toEqual(s1);
    expect(new Set(Object.values(s1)).size).toBe(4);
    expect(s1.a < s1.b).toBe(true);

    // Repeated setAgents with reordering + a newcomer: nobody moves.
    const { sim, world } = setup(keys.map((k) => agent(k, { activity: "typing" })));
    const before = Object.fromEntries(keys.map((k) => [k, seatOf(world, view(sim, k))!.id]));
    sim.setAgents([...keys.reverse(), "0"].map((k) => agent(k, { activity: "typing" })));
    for (const k of keys) expect(seatOf(world, view(sim, k))!.id).toBe(before[k]);
  });

  it("keeps assignments across a world rebuild that adds houses and seats", () => {
    const first = ["a", "b", "c"].map((k) => agent(k, { activity: "typing" }));
    const { sim, world } = setup(first);
    const before = Object.fromEntries(first.map((a) => [a.key, seatOf(world, view(sim, a.key))!.id]));
    const more = [
      ...first,
      agent("d", { activity: "typing" }),
      agent("e", { activity: "typing" }),
      agent("ide", { folder: "aaa", origin: "ide", activity: "typing" }),
    ];
    const w2 = buildWorld(planHouses(more));
    sim.setWorld(w2);
    sim.setAgents(more);
    for (const a of first) {
      const v = view(sim, a.key);
      expect(v.seated).toBe(true);
      expect(seatOf(w2, v)!.id).toBe(before[a.key]);
    }
    expect(seatOf(w2, view(sim, "ide"))!.houseKey).toBe("aaa");
    expect(seatOf(w2, view(sim, "e"))!.houseKey).toBe("proj");
  });

  it("frees a departed agent's seat for the next one", () => {
    const four = ["a", "b", "c", "d"].map((k) => agent(k, { activity: "typing" }));
    const { sim, world } = setup(four);
    const seatB = seatOf(world, view(sim, "b"))!.id;
    sim.setAgents([...four.filter((a) => a.key !== "b"), agent("e", { activity: "typing" })]);
    expect(seatOf(world, view(sim, "e"))!.id).toBe(seatB);
  });

  it("prefers seats with a pc", () => {
    const seats: Seat[] = [
      { id: "s0", houseKey: "h", col: 1, row: 1, facing: "up", pcId: null },
      { id: "s1", houseKey: "h", col: 3, row: 1, facing: "up", pcId: "pc1" },
    ];
    const props: Prop[] = [{ id: "pc1", kind: "pc", col: 3, row: 0, w: 1, h: 1, seatId: "s1" }];
    const w = asciiWorld([".....", ".....", "....."], { seats, props, plaza: { col: 2, row: 2 } });
    const sim = new VillageSim();
    sim.setWorld(w);
    sim.setAgents([agent("z", { folder: "h", activity: "typing" })]);
    expect(seatOf(w, view(sim, "z"))!.id).toBe("s1");
    sim.setAgents([agent("z", { folder: "h", activity: "typing" }), agent("y", { folder: "h", activity: "typing" })]);
    expect(seatOf(w, view(sim, "y"))!.id).toBe("s0");
    // A third finds the house full: it works where it stands.
    sim.setAgents(["z", "y", "x"].map((k) => agent(k, { folder: "h", activity: "typing" })));
    run(sim, 1);
    expect(view(sim, "x")).toMatchObject({ seated: false, anim: "type" });
  });

  it("an agent whose house isn't built yet works at the plaza, then moves in on rebuild", () => {
    const sim = new VillageSim();
    const a = agent("a", { folder: "newproj", activity: "typing" });
    sim.setAgents([a]);
    settle(sim);
    sim.tick(0.1);
    const v = view(sim, "a");
    expect(v).toMatchObject({ seated: false, anim: "type" });
    const w = buildWorld(planHouses([a]));
    sim.setWorld(w);
    expect(view(sim, "a").seated).toBe(true);
    expect(seatOf(w, view(sim, "a"))!.houseKey).toBe("newproj");
  });

  it("a full house sends the overflow to its door; idle overflow wanders", () => {
    const agents = ["a", "b", "c", "d", "e"].map((k) => agent(k, { activity: "typing" }));
    const sim = new VillageSim();
    const w = buildWorld(planHouses(agents.slice(0, 4)));
    sim.setWorld(w);
    sim.setAgents(agents);
    settle(sim);
    sim.tick(0.1);
    const v = view(sim, "e");
    expect(v).toMatchObject({ seated: false, anim: "type" });
    const h = w.houses[0];
    const t = tileOf(v);
    expect(Math.abs(t.col - h.doorCol) + Math.abs(t.row - (h.doorRow - 1))).toBeLessThanOrEqual(1);
    sim.setAgents(agents.map((a) => (a.key === "e" ? { ...a, activity: "idle" as const } : a)));
    expect(runUntil(sim, 60, () => view(sim, "e").anim === "walk")).toBe(true);
  });

  it("drops a seat whose house disappeared and re-places the agent", () => {
    const a = agent("a", { activity: "typing" });
    const { sim } = setup([a]);
    const w2 = buildWorld([]);
    sim.setWorld(w2);
    const v = view(sim, "a");
    expect(v.seated).toBe(false);
    const t = tileOf(v);
    expect(walkable(w2, t.col, t.row)).toBe(true);
  });

  it("moving to another folder moves the agent to the other house", () => {
    const agents = [agent("a", { activity: "typing" }), agent("b", { folder: "other", activity: "typing" })];
    const { sim, world } = setup(agents);
    settle(sim);
    sim.setAgents([agent("a", { folder: "other", activity: "typing" }), agents[1]]);
    expect(view(sim, "a").seated).toBe(false);
    expect(runUntil(sim, 120, () => view(sim, "a").seated)).toBe(true);
    expect(seatOf(world, view(sim, "a"))!.houseKey).toBe("other");
  });

  it("changing folder while walking home cancels the homecoming", () => {
    const agents = [agent("a"), agent("b", { folder: "other" })];
    const { sim, world } = setup(agents, 2);
    const home = seatOf(world, view(sim, "a"))!;
    let left = false;
    let moved = false;
    for (let i = 0; i < 30000 && !moved; i++) {
      sim.tick(0.1);
      const v = view(sim, "a");
      if (!v.seated) left = true;
      const t = tileOf(v);
      if (left && v.anim === "walk" && Math.abs(t.col - home.col) + Math.abs(t.row - home.row) === 1) {
        sim.setAgents([agent("a", { folder: "other" }), agents[1]]);
        moved = true;
      }
    }
    expect(moved).toBe(true);
    run(sim, 2);
    const v = view(sim, "a");
    expect(v.seated).toBe(false);
  });
});

describe("unreachable seats and degenerate worlds", () => {
  // Left room: door + floor. Right room: the only seat, sealed off.
  const sealed = () => {
    const seats: Seat[] = [{ id: "s", houseKey: "h", col: 6, row: 1, facing: "up", pcId: "pc" }];
    const props: Prop[] = [{ id: "pc", kind: "pc", col: 6, row: 0, w: 1, h: 1, seatId: "s" }];
    return asciiWorld(["oooo#___", "oooo#___", "oooo#___"], {
      seats,
      props,
      plaza: { col: 1, row: 1 },
      houses: [{ key: "h", label: "h", col: 0, row: 0, w: 4, h: 3, doorCol: 1, doorRow: 3, hasIde: false }],
    });
  };

  it("works in place when its seat cannot be reached, and gives up going home", () => {
    const w = sealed();
    const sim = new VillageSim({ seed: 4 });
    sim.setWorld(w);
    sim.setAgents([agent("x", { folder: "h", activity: "typing" }), agent("y", { folder: "h" })]);
    settle(sim);
    // y has no seat; it stands in the left room.
    expect(tileOf(view(sim, "y")).col).toBeLessThan(4);
    // x leaves; y inherits the sealed seat without being teleported.
    sim.setAgents([agent("y", { folder: "h" })]);
    run(sim, 1);
    expect(tileOf(view(sim, "y")).col).toBeLessThan(4);
    // idle: wanders the left room many times, never reaching home
    run(sim, 600);
    const v = view(sim, "y");
    expect(v.seated).toBe(false);
    expect(tileOf(v).col).toBeLessThan(4);
    // active: can't reach the desk → works in place
    sim.setAgents([agent("y", { folder: "h", activity: "typing" })]);
    run(sim, 1);
    expect(view(sim, "y")).toMatchObject({ seated: false, anim: "type" });
    expect(sim.pcOn("pc")).toBe(false);
  });

  it("an agent mid-stroll whose seat becomes unreachable types where it stands", () => {
    const w = sealed();
    const sim = new VillageSim({ seed: 9 });
    sim.setWorld(w);
    sim.setAgents([agent("x", { folder: "h", activity: "typing" }), agent("y", { folder: "h" })]);
    settle(sim);
    sim.setAgents([agent("y", { folder: "h" })]);
    expect(runUntil(sim, 200, () => view(sim, "y").anim === "walk")).toBe(true);
    sim.setAgents([agent("y", { folder: "h", activity: "reading" })]);
    sim.tick(0.1);
    const v = view(sim, "y");
    expect(v).toMatchObject({ anim: "read", seated: false });
    expect(v.x % TILE).toBe(TILE / 2);
  });

  it("an active agent walking across its own chair sits down right there", () => {
    // A corridor whose middle tile is the agent's chair; it is walked onto when re-pathing.
    const seats: Seat[] = [{ id: "s", houseKey: "h", col: 2, row: 0, facing: "up", pcId: null }];
    const props: Prop[] = [{ id: "c", kind: "chair", col: 2, row: 0, w: 1, h: 1, facing: "up" }];
    const w = asciiWorld(["oo.oo"], {
      seats,
      props,
      plaza: { col: 0, row: 0 },
      houses: [{ key: "h", label: "h", col: 0, row: 0, w: 5, h: 1, doorCol: 4, doorRow: 1, hasIde: false }],
    });
    const sim = new VillageSim({ seed: 1 });
    sim.setWorld(w);
    sim.setAgents([agent("y", { folder: "h" })]);
    settle(sim);
    // Idle agents leave the chair; eventually one stroll crosses it with the agent standing on it.
    let sat = false;
    for (let i = 0; i < 40000 && !sat; i++) {
      sim.tick(0.1);
      const v = view(sim, "y");
      const t = tileOf(v);
      if (v.anim === "walk" && t.col === 2 && v.x === 2 * TILE + TILE / 2) {
        sim.setAgents([agent("y", { folder: "h", activity: "typing" })]);
        sim.tick(0.01);
        sat = view(sim, "y").seated;
      }
    }
    expect(sat).toBe(true);
  });

  it("a world with nowhere to stand leaves characters at the plaza point and still wanders safely", () => {
    const w = asciiWorld(["~~~", "~~~"], { plaza: { col: 1, row: 1 } });
    const sim = new VillageSim();
    sim.setWorld(w);
    sim.setAgents([agent("a"), agent("s", { parentKey: "missing" })]);
    run(sim, 60);
    expect(tileOf(view(sim, "a"))).toEqual({ col: 1, row: 1 });
    expect(tileOf(view(sim, "s"))).toEqual({ col: 1, row: 1 });
  });

  it("wanders onto grass when a world has no plaza tiles, house or campfire", () => {
    const w = asciiWorld(["....", "...."], { plaza: { col: 0, row: 0 } });
    const sim = new VillageSim();
    sim.setWorld(w);
    sim.setAgents([agent("a")]);
    run(sim, 120);
    expect(tileOf(view(sim, "a"))).toEqual({ col: 0, row: 0 });
  });
});

describe("sub-agents", () => {
  it("each sit at their own team seat with a laptop, nearest the parent, and work there", () => {
    const parent = agent("p", { activity: "typing" });
    const subs = [1, 2, 3].map((i) => agent(`s${i}`, { parentKey: "p", activity: i === 2 ? "reading" : "typing" }));
    const { sim, world } = setup([parent, ...subs]);
    const pSeat = seatOf(world, view(sim, "p"))!;
    expect(pSeat.forSub).toBeUndefined();
    const dist = (s: Seat) => Math.abs(s.col - pSeat.col) + Math.abs(s.row - pSeat.row);
    const taken = subs.map((s) => {
      const v = view(sim, s.key);
      expect(v).toMatchObject({ isSubagent: true, seated: true });
      expect(v.fx).toEqual({ kind: "spawn", t: 0 });
      const seat = seatOf(world, v)!;
      expect(seat.forSub).toBe(true);
      expect(v.dir).toBe(seat.facing);
      return seat;
    });
    expect(new Set(taken.map((t) => t.id)).size).toBe(3);
    // the three nearest team seats to the parent's desk
    const free = world.seats.filter((s) => s.forSub).map(dist).sort((a, b) => a - b);
    expect(taken.map(dist).sort((a, b) => a - b)).toEqual(free.slice(0, 3));
    settle(sim);
    sim.tick(0.1);
    expect(view(sim, "s1").anim).toBe("type");
    expect(view(sim, "s2").anim).toBe("read");
    for (const t of taken) expect(sim.pcOn(t.pcId!)).toBe(true);
    expect(world.props.find((p) => p.id === taken[0].pcId)!.kind).toBe("laptop");
  });

  it("all look different: from their parent and from each other", () => {
    const parent = agent("p", { activity: "typing" });
    const subs = Array.from({ length: 8 }, (_, i) => agent(`s${i}`, { parentKey: "p", activity: "typing" }));
    const { sim } = setup([parent, ...subs]);
    const looks = sim.characters().map((v) => `${v.palette}/${v.hueShift}`);
    expect(new Set(looks).size).toBe(9);
    // the first six on screen spread over the six base sheets
    expect(new Set(sim.characters().slice(0, 6).map((v) => v.palette)).size).toBe(6);
  });

  it("sit in their ROOT's house even from another folder, a sub-agent's sub-agent too", () => {
    const root = agent("r", { folder: "home", activity: "typing" });
    const sub = agent("s", { folder: "worktree", parentKey: "r", activity: "typing" });
    const grand = agent("g", { folder: "elsewhere", parentKey: "s", activity: "reading" });
    const { sim, world } = setup([root, sub, grand]);
    for (const k of ["s", "g"]) expect(seatOf(world, view(sim, k))).toMatchObject({ houseKey: "home", forSub: true });
  });

  it("prefer the team seat nearest their own parent", () => {
    // four roots fill the desk row; d sits at the right-most desk
    const roots = ["a", "b", "c", "d"].map((k) => agent(k, { activity: "typing" }));
    const subs = [agent("d1", { parentKey: "d" }), ...[1, 2, 3, 4, 5].map((i) => agent(`a${i}`, { parentKey: "a" }))];
    const { sim, world } = setup([...roots, ...subs]);
    const h = world.houses[0];
    const col = (k: string) => seatOf(world, view(sim, k))!.col - h.col;
    expect(col("d")).toBe(10);
    expect(col("d1")).toBeGreaterThanOrEqual(9); // the right-hand table
    for (const k of ["a1", "a2", "a3", "a4"]) expect(col(k)).toBeLessThanOrEqual(3); // the left-hand one
    expect(col("a5")).toBeGreaterThanOrEqual(9); // left table full: the next nearest
    // a seatless parent: the sub's seat is the one nearest the parent itself
    const extra = [...roots, agent("e", { activity: "typing" }), agent("e1", { parentKey: "e", activity: "typing" })];
    const w2 = buildWorld([{ key: "proj", label: "proj", seats: 4, subSeats: 4, hasIde: false }]);
    const sim2 = new VillageSim();
    sim2.setWorld(w2);
    sim2.setAgents(extra);
    expect(seatOf(w2, view(sim2, "e"))).toBeUndefined();
    const et = tileOf(view(sim2, "e"));
    const nearest = w2.seats
      .filter((s) => s.forSub)
      .map((s) => Math.abs(s.col - et.col) + Math.abs(s.row - et.row))
      .sort((x, y) => x - y)[0];
    const e1 = seatOf(w2, view(sim2, "e1"))!;
    expect(e1.forSub).toBe(true);
    expect(Math.abs(e1.col - et.col) + Math.abs(e1.row - et.row)).toBe(nearest);
  });

  it("roots never take team seats and sub-agents never take desks", () => {
    // 5 roots in a 4-desk house with 4 free team seats: the fifth root stays seatless.
    const roots = Array.from({ length: 5 }, (_, i) => agent(`r${i}`, { activity: "typing" }));
    const sub = agent("s", { parentKey: "r0", activity: "typing" });
    const world = buildWorld([{ key: "proj", label: "proj", seats: 4, subSeats: 4, hasIde: false }]);
    const sim = new VillageSim();
    sim.setWorld(world);
    sim.setAgents([...roots, sub]);
    run(sim, 30);
    for (const r of roots) expect(seatOf(world, view(sim, r.key))?.forSub).not.toBe(true);
    expect(roots.filter((r) => view(sim, r.key).seated)).toHaveLength(4);
    // and with no team seat at all, a sub-agent stands by its parent — never at a free desk
    const w2 = buildWorld([{ key: "proj", label: "proj", seats: 8, subSeats: 0, hasIde: false }]);
    const sim2 = new VillageSim();
    sim2.setWorld(w2);
    sim2.setAgents([agent("p", { activity: "typing" }), sub]);
    run(sim2, 30);
    expect(view(sim2, "s").seated).toBe(false);
    expect(seatOf(w2, view(sim2, "s"))).toBeUndefined();
  });

  it("overflow next to the parent when every team seat is taken, and move to one freed by a departure", () => {
    const parent = agent("p", { activity: "typing" });
    const subs = Array.from({ length: 5 }, (_, i) => agent(`s${i}`, { parentKey: "p", activity: "typing" }));
    const world = buildWorld([{ key: "proj", label: "proj", seats: 4, subSeats: 4, hasIde: false }]);
    const sim = new VillageSim();
    sim.setWorld(world);
    sim.setAgents([parent, ...subs]);
    settle(sim);
    sim.tick(0.1);
    const over = view(sim, "s4");
    expect(over).toMatchObject({ seated: false, anim: "type" });
    const pt = tileOf(view(sim, "p"));
    const ot = tileOf(over);
    expect(Math.abs(ot.col - pt.col) + Math.abs(ot.row - pt.row)).toBeLessThanOrEqual(2);
    // s0 leaves: s4 takes its laptop and walks over
    const freed = seatOf(world, view(sim, "s0"))!;
    sim.setAgents([parent, ...subs.slice(1)]);
    expect(runUntil(sim, 30, () => view(sim, "s4").seated)).toBe(true);
    expect(seatOf(world, view(sim, "s4"))!.id).toBe(freed.id);
    sim.tick(0.1);
    expect(sim.pcOn(freed.pcId!)).toBe(true);
  });

  it("an idle overflow sub-agent takes a freed seat but waits to work before walking there", () => {
    const parent = agent("p", { activity: "typing" });
    const subs = Array.from({ length: 5 }, (_, i) => agent(`s${i}`, { parentKey: "p", activity: i === 4 ? "idle" : "typing" }));
    const world = buildWorld([{ key: "proj", label: "proj", seats: 4, subSeats: 4, hasIde: false }]);
    const sim = new VillageSim();
    sim.setWorld(world);
    sim.setAgents([parent, ...subs]);
    settle(sim);
    const at = tileOf(view(sim, "s4"));
    sim.setAgents([parent, ...subs.slice(1)]);
    run(sim, 5);
    expect(tileOf(view(sim, "s4"))).toEqual(at);
    sim.setAgents([parent, ...subs.slice(1, 4), { ...subs[4], activity: "typing" }]);
    expect(runUntil(sim, 30, () => view(sim, "s4").seated)).toBe(true);
  });

  it("stay at their laptop (lid dark) when idle or done, and light it again when they work", () => {
    const parent = agent("p", { activity: "typing" });
    const sub = agent("s", { parentKey: "p", activity: "typing" });
    const { sim, world } = setup([parent, sub]);
    settle(sim);
    const seat = seatOf(world, view(sim, "s"))!;
    expect(sim.pcOn(seat.pcId!)).toBe(true);
    sim.setAgents([parent, { ...sub, activity: "done" }]);
    run(sim, 120);
    expect(view(sim, "s")).toMatchObject({ seated: true, anim: "idle" });
    expect(sim.pcOn(seat.pcId!)).toBe(false);
    sim.setAgents([parent, { ...sub, activity: "reading" }]);
    sim.tick(0.1);
    expect(view(sim, "s")).toMatchObject({ seated: true, anim: "read" });
    expect(sim.pcOn(seat.pcId!)).toBe(true);
    // spawned idle: seated, resting, never wandering off
    const idle = agent("i", { parentKey: "p" });
    sim.setAgents([parent, sub, idle]);
    run(sim, 120);
    expect(view(sim, "i").seated).toBe(true);
    expect(seatOf(world, view(sim, "i"))!.forSub).toBe(true);
  });

  it("release their team seat on despawn, for the next sub-agent", () => {
    const parent = agent("p", { activity: "typing" });
    const a = agent("a", { parentKey: "p", activity: "typing" });
    const world = buildWorld([{ key: "proj", label: "proj", seats: 4, subSeats: 4, hasIde: false }]);
    const sim = new VillageSim();
    sim.setWorld(world);
    sim.setAgents([parent, a]);
    const seat = seatOf(world, view(sim, "a"))!;
    sim.setAgents([parent]);
    expect(sim.pcOn(seat.pcId!)).toBe(false);
    sim.setAgents([parent, agent("b", { parentKey: "p", activity: "typing" })]);
    expect(seatOf(world, view(sim, "b"))!.id).toBe(seat.id);
  });

  it("keep their team seat across a rebuild of the same house, and move when the root moves house", () => {
    const parent = agent("p", { activity: "typing" });
    const sub = agent("s", { parentKey: "p", activity: "typing" });
    const { sim, world } = setup([parent, sub]);
    const before = seatOf(world, view(sim, "s"))!.id;
    const w2 = buildWorld(planHouses([parent, sub, agent("z", { folder: "zzz" })]));
    sim.setWorld(w2);
    expect(seatOf(w2, view(sim, "s"))!.id).toBe(before);
    const moved = { ...parent, folder: "other" };
    sim.setAgents([moved, sub]);
    const w3 = buildWorld(planHouses([moved, sub]));
    sim.setWorld(w3);
    expect(seatOf(w3, view(sim, "s"))).toMatchObject({ houseKey: "other", forSub: true });
  });

  it("stand by their parent when the root's house is not built yet", () => {
    const sim = new VillageSim();
    sim.setWorld(buildWorld([]));
    sim.setAgents([agent("p"), agent("s", { parentKey: "p", activity: "typing" })]);
    expect(view(sim, "s").seated).toBe(false);
    // and leave without a seat to give back
    sim.setAgents([]);
    expect(view(sim, "s").fx!.kind).toBe("despawn");
  });

  it("never stand right below their parent (it would hide the parent), unless it is the only free tile", () => {
    // A seated parent with a crowd: the tile under its chair stays clear.
    const parent = agent("p", { activity: "typing" });
    const subs = Array.from({ length: 8 }, (_, i) => agent(`s${i}`, { parentKey: "p", activity: "typing" }));
    const { sim } = setup([parent, ...subs]);
    const pt = tileOf(view(sim, "p"));
    for (const s of subs) expect(tileOf(view(sim, s.key))).not.toEqual({ col: pt.col, row: pt.row + 1 });

    // A 1-wide column: the parent on row 0, the sub skips row 1 for row 2…
    const column = (n: number) => {
      const sim2 = new VillageSim();
      sim2.setWorld(asciiWorld(Array.from({ length: n }, () => "."), { plaza: { col: 0, row: 0 } }));
      sim2.setAgents([agent("p"), agent("s", { parentKey: "p" })]);
      return { p: tileOf(view(sim2, "p")), s: tileOf(view(sim2, "s")) };
    };
    expect(column(3)).toEqual({ p: { col: 0, row: 0 }, s: { col: 0, row: 2 } });
    // …but takes it when nothing else is free, rather than sharing the parent's tile.
    expect(column(2)).toEqual({ p: { col: 0, row: 0 }, s: { col: 0, row: 1 } });
  });

  it("stand still when idle, show done bubbles, and despawn when removed", () => {
    const parent = agent("p", { activity: "typing" });
    const sub = agent("s", { parentKey: "p", activity: "typing" });
    const { sim } = setup([parent, sub]);
    settle(sim);
    sim.tick(0.1);
    sim.setAgents([parent, { ...sub, activity: "done" }]);
    const at = tileOf(view(sim, "s"));
    expect(view(sim, "s")).toMatchObject({ anim: "idle", bubble: "done" });
    run(sim, 60);
    expect(tileOf(view(sim, "s"))).toEqual(at);
    sim.setAgents([parent]);
    expect(view(sim, "s").fx!.kind).toBe("despawn");
    run(sim, 0.5);
    expect(sim.characters().map((c) => c.key)).toEqual(["p"]);
  });

  it("are re-placed next to their parent on a world rebuild", () => {
    const parent = agent("p", { activity: "typing" });
    const sub = agent("s", { parentKey: "p", activity: "waiting" });
    const { sim } = setup([parent, sub]);
    const w2 = buildWorld(planHouses([agent("x", { folder: "aaa", origin: "ide" }), parent]));
    sim.setWorld(w2);
    const pt = tileOf(view(sim, "p"));
    const st = tileOf(view(sim, "s"));
    expect(Math.abs(pt.col - st.col) + Math.abs(pt.row - st.row)).toBeLessThanOrEqual(2);
    expect(view(sim, "s")).toMatchObject({ bubble: "waiting" });
  });

  it("with an unknown parent spawn by the plaza with their own palette", () => {
    const { sim, world } = setup([agent("orphan", { parentKey: "ghost", activity: "typing" })]);
    const v = view(sim, "orphan");
    const t = tileOf(v);
    expect(Math.abs(t.col - world.plaza.col) + Math.abs(t.row - world.plaza.row)).toBeLessThanOrEqual(2);
    expect(v.palette).toBe(0);
  });
});

describe("palettes", () => {
  it("gives six roots distinct bases, then hue-shifted repeats; subs count, the departed don't", () => {
    const roots = Array.from({ length: 8 }, (_, i) => agent(`r${i}`));
    const sub = agent("sub", { parentKey: "r0" });
    const { sim } = setup([...roots, sub]);
    const vs = roots.map((r) => view(sim, r.key));
    expect(vs.slice(0, 6).map((v) => [v.palette, v.hueShift])).toEqual([0, 1, 2, 3, 4, 5].map((p) => [p, 0]));
    expect(vs[6].palette).toBe(0);
    expect(vs[7].palette).toBe(1);
    for (const v of vs.slice(6)) expect(v.hueShift).toBeGreaterThanOrEqual(45);
    // the sub-agent counts too, and never wears its parent's look
    const sv = view(sim, "sub");
    expect(sv.palette).toBe(2);
    expect([sv.palette, sv.hueShift]).not.toEqual([vs[0].palette, vs[0].hueShift]);

    // r3 leaves: the next newcomer takes its now least-used base, unshifted.
    sim.setAgents([...roots.filter((r) => r.key !== "r3"), sub, agent("new")]);
    expect(view(sim, "new")).toMatchObject({ palette: 3, hueShift: 0 });
  });

  it("keeps a character's palette for life", () => {
    const { sim } = setup([agent("a"), agent("b")]);
    const before = view(sim, "b").palette;
    sim.setAgents([agent("b")]);
    sim.setAgents([agent("b"), agent("c")]);
    expect(view(sim, "b").palette).toBe(before);
  });
});

describe("world swaps", () => {
  it("teleports walkers home and keeps idle agents valid", () => {
    const agents = ["a", "b"].map((k) => agent(k));
    const { sim } = setup(agents, 6);
    expect(runUntil(sim, 120, () => sim.characters().some((c) => c.anim === "walk"))).toBe(true);
    const w2 = buildWorld(planHouses([...agents, agent("z", { folder: "zzz" })]));
    sim.setWorld(w2);
    for (const v of sim.characters()) {
      expect(v.anim).not.toBe("walk");
      expect(v.seated).toBe(true);
      expect(seatOf(w2, v)!.houseKey).toBe("proj");
    }
  });

  it("leaves despawning characters alone", () => {
    const { sim } = setup([agent("a"), agent("s", { parentKey: "a" })]);
    sim.setAgents([]);
    sim.setWorld(buildWorld([]));
    expect(sim.characters().every((c) => c.fx?.kind === "despawn")).toBe(true);
    run(sim, 0.5);
    expect(sim.characters()).toEqual([]);
  });
});

describe("ambience: staying indoors", () => {
  const sky = (stayIndoors: boolean): Ambience => ({
    phase: "afternoon",
    daylight: 0.7,
    tint: { color: "#5a6478", alpha: 0.2 },
    weather: stayIndoors ? "rain" : "clear",
    intensity: stayIndoors ? 0.8 : 0,
    wind: 0,
    lightsOn: false,
    campfireLit: !stayIndoors,
    stayIndoors,
  });
  const inside = (world: World, v: CharacterView) => {
    const t = tileOf(v);
    return isIndoorTile(world, t.col, t.row);
  };
  const roster = () => [agent("a1"), agent("a2"), agent("a3"), agent("b1", { folder: "other" }), agent("b2", { folder: "other" })];

  it("property: when the rain starts every idle root walks in within 30 s and never steps outside again", () => {
    let caughtOutside = 0;
    for (let seed = 1; seed <= 10; seed++)
      for (const startAt of [4, 19, 37, 66, 113, 170]) {
        const { sim, world } = setup(roster(), seed);
        run(sim, startAt);
        const keys = sim.characters().map((c) => c.key);
        caughtOutside += keys.filter((k) => !inside(world, view(sim, k))).length;
        sim.setAmbience(sky(true));
        expect(runUntil(sim, 30, () => keys.every((k) => inside(world, view(sim, k))))).toBe(true);
        // Collect, don't assert per tick: 60 scenes × 2400 ticks × 5 agents of `expect`
        // blew the 5 s budget under coverage instrumentation.
        const escaped: string[] = [];
        for (let t = 0; t < 240; t += 0.1) {
          sim.tick(0.1);
          for (const c of sim.characters())
            if (!inside(world, c)) escaped.push(`seed ${seed} start ${startAt} ${c.key} t=${t.toFixed(1)}`);
        }
        expect(escaped).toEqual([]);
      }
    // the property was exercised on characters that really were outdoors
    expect(caughtOutside).toBeGreaterThan(10);
  }, 30_000);

  it("a root caught mid-step when the rain starts never jumps back — it finishes the step, then heads in", () => {
    let checked = 0;
    for (let seed = 1; seed <= 10 && checked < 5; seed++) {
      const { sim, world } = setup(roster(), seed);
      sim.setAmbience(sky(false));
      // find a moment where somebody is strolling OUTDOORS, partway through a step
      const mover = () =>
        sim.characters().find((c) => c.anim === "walk" && !inside(world, c) && (c.x % TILE !== TILE / 2 || c.y % TILE !== 0));
      if (!runUntil(sim, 120, () => mover() !== undefined)) continue;
      const before = mover()!;
      sim.setAmbience(sky(true));
      sim.tick(0.001);
      const after = view(sim, before.key);
      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
      checked++;
      expect(runUntil(sim, 30, () => inside(world, view(sim, before.key)))).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("once the rain stops they roam outdoors again; repeating the same sky changes nothing", () => {
    const { sim, world } = setup(roster(), 3);
    sim.setAmbience(sky(true));
    run(sim, 60);
    sim.setAmbience(sky(false));
    sim.setAmbience(sky(false));
    expect(runUntil(sim, 600, () => sim.characters().some((c) => !inside(world, c)))).toBe(true);

    // a repeated stayIndoors is a no-op (same seed → same scene with or without the repeat)
    const once = setup(roster(), 8);
    const twice = setup(roster(), 8);
    run(once.sim, 50);
    run(twice.sim, 50);
    once.sim.setAmbience(sky(true));
    twice.sim.setAmbience(sky(true));
    twice.sim.setAmbience(sky(true));
    run(once.sim, 20);
    run(twice.sim, 20);
    expect(twice.sim.characters()).toEqual(once.sim.characters());
  });

  it("working roots, seated sub-agents and departing characters are left alone", () => {
    const agents = [agent("w", { activity: "typing" }), agent("s", { parentKey: "w", activity: "typing" }), agent("gone")];
    const { sim, world } = setup(agents, 2);
    settle(sim);
    sim.setAgents(agents.slice(0, 2));
    const before = sim.characters();
    sim.setAmbience(sky(true));
    expect(sim.characters()).toEqual(before);
    run(sim, 2);
    expect(view(sim, "w")).toMatchObject({ seated: true, anim: "type" });
    expect(view(sim, "s")).toMatchObject({ seated: true });
    expect(inside(world, view(sim, "w"))).toBe(true);
    expect(sim.characters().some((c) => c.key === "gone")).toBe(false);
  });

  it("an agent whose house is not built (or is sealed off) just waits where it is — never strolls outdoors", () => {
    const { sim } = setup([agent("a")], 5);
    sim.setWorld(buildWorld([]));
    settle(sim);
    const start = tileOf(view(sim, "a"));
    sim.setAmbience(sky(true));
    run(sim, 120);
    expect(tileOf(view(sim, "a"))).toEqual(start);

    const sealed = asciiWorld(["####..", "#__#..", "####..", "......"], {
      plaza: { col: 5, row: 3 },
      houses: [{ key: "h", label: "h", col: 1, row: 1, w: 2, h: 1, doorCol: 5, doorRow: 3, hasIde: false }],
    });
    const s2 = new VillageSim({ seed: 6 });
    s2.setWorld(sealed);
    s2.setAgents([agent("y", { folder: "h" })]);
    settle(s2);
    expect(tileOf(view(s2, "y"))).toEqual({ col: 5, row: 2 });
    s2.setAmbience(sky(true));
    run(s2, 120);
    expect(tileOf(view(s2, "y"))).toEqual({ col: 5, row: 2 });
    expect(view(s2, "y").anim).toBe("idle");
  });

  it("a root caught STROLLING outdoors with no way into its house finishes the stroll — no freeze, no teleport", () => {
    // The house is walled in all round; the plaza beside it is open.
    const world = asciiWorld(["####oooo", "#__#oooo", "####oooo", "oooooooo"], {
      plaza: { col: 6, row: 3 },
      houses: [{ key: "h", label: "h", col: 1, row: 1, w: 2, h: 1, doorCol: 6, doorRow: 3, hasIde: false }],
    });
    const sim = new VillageSim({ seed: 4 });
    sim.setWorld(world);
    sim.setAgents([agent("y", { folder: "h" })]);
    expect(runUntil(sim, 300, () => view(sim, "y").anim === "walk")).toBe(true);
    const before = view(sim, "y");
    sim.setAmbience(sky(true));
    sim.tick(0.001);
    const after = view(sim, "y");
    expect(after.anim).toBe("walk");
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
    // It arrives where it was going — outdoors, there being no way in — and stands there.
    expect(runUntil(sim, 30, () => view(sim, "y").anim === "idle")).toBe(true);
    expect(inside(world, view(sim, "y"))).toBe(false);
  });
});

describe("the commute — a city with a Seats lounge", () => {
  /** A leader of folder `folder` and `n` sub-agents under it (all IDE agents). */
  const team = (lead: string, folder: string, n: number, extra: Partial<VillageAgent> = {}): VillageAgent[] => [
    agent(lead, { folder, origin: "ide", activity: "typing" }),
    ...Array.from({ length: n }, (_, i) => agent(`${lead}.s${i}`, { parentKey: lead, folder: "x", origin: "ide", activity: "typing", ...extra })),
  ];
  const cityWorld = (list: VillageAgent[], seats: number | null = 64) => {
    const roster = planCity(list);
    return { roster, world: seats === null ? buildCityWorld(roster.plans) : buildCityWorld(roster.plans, { seats }) };
  };
  /** A city sim: the world, then the agents, then (when given) who holds which bench. */
  function citySim(list: VillageAgent[], benches?: [string, number][], seats: number | null = 64) {
    const { roster, world } = cityWorld(list, seats);
    const sim = new VillageSim({ seed: 1, stayPut: true });
    sim.setWorld(world);
    if (benches) sim.setLoungeSeats(new Map(benches));
    sim.setAgents(roster.agents);
    return { sim, world, roster };
  }
  const bench = (world: World, i: number): Prop => world.props.find((p) => p.kind === "bench" && p.index === i)!;
  /** Feet px of a tile, the sim's convention — and of one sitting there (drawn SIT_OFFSET lower). */
  const feet = (col: number, row: number) => ({ x: col * TILE + 8, y: (row + 1) * TILE });
  const sitting = (col: number, row: number) => ({ x: col * TILE + 8, y: (row + 1) * TILE + SIT_OFFSET });
  /**
   * The commute's waypoints read off the World CONTRACT (the specified route): its bench (or the lounge
   * lift's lowest stop), the aisle below it, the lounge's lift there, up to the far sidewalk, across
   * the road to the near sidewalk, along it to its building's lift column, in at the door, up to the
   * seat's row, along it to the seat.
   */
  function contractRoute(world: World, benchIdx: number | null, seat: Seat): { x: number; y: number }[] {
    const city = world.city!;
    const down = city.lounge!.lift;
    const up = city.buildings.find((b) => b.floors.includes(seat.houseKey))!.lift!;
    const b = benchIdx === null ? { col: down.col, row: down.bottom - 1 } : bench(world, benchIdx);
    const start = benchIdx === null ? [] : [feet(b.col, b.row), feet(b.col, b.row + 1)];
    return [
      ...start,
      feet(down.col, b.row + 1),
      feet(down.col, down.top),
      feet(down.col, city.street),
      feet(up.col, city.street),
      feet(up.col, up.bottom),
      feet(up.col, seat.row),
      feet(seat.col, seat.row),
    ];
  }
  /** The segment of `pts` the point is on, searching from `from` on; -1 when on none. */
  function segmentOf(pts: { x: number; y: number }[], x: number, y: number, from: number): number {
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const within = (v: number, a: number, b: number) => v >= Math.min(a, b) - 1e-6 && v <= Math.max(a, b) + 1e-6;
    for (let i = Math.max(0, from); i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      if ((near(a.x, b.x) && near(x, a.x) && within(y, a.y, b.y)) || (near(a.y, b.y) && near(y, a.y) && within(x, a.x, b.x))) return i;
    }
    return -1;
  }
  /** Which way the spec says one faces on segment i of `pts`: DOWN in a lift; walking, the way it goes. */
  function specFacing(pts: { x: number; y: number }[], i: number, rides: ReadonlySet<number>): Dir {
    if (rides.has(i)) return "down";
    const [a, b] = [pts[i], pts[i + 1]];
    if (b.x !== a.x) return b.x > a.x ? "right" : "left";
    return b.y < a.y ? "up" : "down";
  }
  interface Sample {
    t: number;
    v: CharacterView;
    seg: number;
  }
  /**
   * Tick 1/60 s at a time until `key` gets up and sits down again (or `maxSec`), checking every frame
   * in between lies on `pts`, segment by segment in order; returns the samples from the first frame
   * it is up (seg −1 = sitting down at the end).
   */
  function follow(sim: VillageSim, key: string, pts: { x: number; y: number }[], maxSec: number): Sample[] {
    const out: Sample[] = [];
    let seg = 0;
    for (let t = 0; t < maxSec; t += 1 / 60) {
      sim.tick(1 / 60);
      const v = view(sim, key);
      if (v.seated && out.length === 0) continue;
      if (v.seated) {
        out.push({ t, v, seg: -1 });
        return out;
      }
      const at = segmentOf(pts, v.x, v.y, seg);
      if (at < 0) throw new Error(`off the route at t=${t.toFixed(2)}: (${v.x}, ${v.y}) after segment ${seg}`);
      seg = at;
      out.push({ t, v, seg });
    }
    return out;
  }
  const deskOf = (sim: VillageSim, key: string) => sim.seatFor(key)!;
  /** Run until `key` is seated at its desk (working). */
  const toDesk = (sim: VillageSim, key: string) => runUntil(sim, 20, () => sim.seating().some((a) => a.key === key));

  it("a busy sub-agent appears ON the bench it holds, facing us, with the spawn effect — not at its desk, its PC dark; its leader stays at its own desk", () => {
    const { sim, world } = citySim(team("g", "gazelle", 1), [["g", 0], ["g.s0", 5]]);
    const b = bench(world, 5);
    const v = view(sim, "g.s0");
    expect(v).toMatchObject({ ...sitting(b.col, b.row), seated: true, dir: "down", anim: "idle", fx: { kind: "spawn", t: 0 } });
    expect(v.riding).toBeUndefined();
    const desk = deskOf(sim, "g.s0");
    expect(desk.forSub).toBe(true);
    expect(sim.pcOn(desk.pcId!)).toBe(false);
    expect(sim.seating().map((a) => a.key)).toEqual(["g"]);
    expect([...sim.loungeClaims()]).toEqual([5]);
    // The leader never commutes: at its floor's desk from the start, and it stays there.
    const lead = world.seats.find((s) => s.id === sim.seatFor("g")!.id)!;
    expect(view(sim, "g")).toMatchObject({ ...sitting(lead.col, lead.row), seated: true, dir: "down" });
    // It sits out its spawn effect on the bench, PC still dark.
    run(sim, FX_SEC / 2);
    expect(view(sim, "g.s0")).toMatchObject({ seated: true, x: feet(b.col, b.row).x });
    expect(sim.pcOn(desk.pcId!)).toBe(false);
  });

  it("then travels the route — aisle, the lounge's lift, across the road, the sidewalk, its door, its lift, its row — walking briskly, riding in a car facing us, and sits and works at its desk", () => {
    const { sim, world } = citySim(team("g", "gazelle", 3), [["g", 0], ["g.s0", 1], ["g.s1", 2], ["g.s2", 13]]);
    const desk = deskOf(sim, "g.s2");
    const pts = contractRoute(world, 13, desk);
    const rides = new Set([2, 6]);
    const samples = follow(sim, "g.s2", pts, 30);
    const last = samples[samples.length - 1];
    // Every positive-length segment was travelled, in order, and it ended seated AT ITS DESK.
    const seen = new Set(samples.map((s) => s.seg));
    for (let i = 0; i < pts.length - 1; i++) if (pts[i].x !== pts[i + 1].x || pts[i].y !== pts[i + 1].y) expect(seen.has(i)).toBe(true);
    expect(last.v).toMatchObject({ ...sitting(desk.col, desk.row), seated: true, dir: "up", anim: "type" });
    expect(sim.pcOn(desk.pcId!)).toBe(true);
    expect(sim.seating().some((a) => a.key === "g.s2" && a.seatId === desk.id)).toBe(true);
    expect(sim.loungeClaims().has(13)).toBe(true); // away from its bench, which stays its own
    // Inside a segment (not on a corner): a car round it on the lifts, facing us; walking otherwise,
    // facing the way it goes; never seated on the way.
    const corner = (v: CharacterView) => pts.some((p) => p.x === v.x && p.y === v.y);
    for (const s of samples.slice(0, -1)) {
      expect(s.v.seated).toBe(false);
      if (corner(s.v)) continue;
      expect([s.seg, s.v.dir]).toEqual([s.seg, specFacing(pts, s.seg, rides)]);
      expect([s.seg, s.v.riding === true, s.v.anim]).toEqual([s.seg, rides.has(s.seg), rides.has(s.seg) ? "idle" : "walk"]);
    }
    // The walk animation steps while walking.
    expect(new Set(samples.filter((s) => s.v.anim === "walk").map((s) => s.v.frame)).size).toBe(4);
    // Brisk: faster than an idle stroll the whole way, and under 12 s door to door.
    let length = 0;
    for (let i = 0; i < pts.length - 1; i++) length += Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
    const took = last.t - samples[0].t;
    expect(took).toBeLessThan(length / (2 * WALK_SPEED));
    expect(took).toBeLessThan(12);
  });

  it("done at its desk: stays seated for its result's beat, then comes back the same way, sits on its bench facing us — and despawns there, still sitting", () => {
    const list = team("g", "gazelle", 1);
    const { sim, world, roster } = citySim(list, [["g", 0], ["g.s0", 6]]);
    expect(toDesk(sim, "g.s0")).toBe(true);
    const desk = deskOf(sim, "g.s0");
    const done = roster.agents.map((a) => (a.key === "g.s0" ? { ...a, activity: "done" as const } : a));
    sim.setAgents(done);
    // Its result leaves from its desk: it is still seated there (lid dark) for the beat.
    run(sim, RESULT_BEAT - 0.15);
    expect(sim.seating().map((a) => a.key)).toContain("g.s0");
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(desk.col, desk.row), seated: true, anim: "idle" });
    expect(sim.pcOn(desk.pcId!)).toBe(false);
    run(sim, 0.2);
    expect(view(sim, "g.s0").seated).toBe(false);
    expect(sim.seating().map((a) => a.key)).not.toContain("g.s0");
    // Back the same way: the route reversed.
    const back = contractRoute(world, 6, desk).reverse();
    const samples = follow(sim, "g.s0", back, 30);
    const b = bench(world, 6);
    expect(samples[samples.length - 1].v).toMatchObject({ ...sitting(b.col, b.row), seated: true, dir: "down", anim: "idle" });
    expect(new Set(samples.map((s) => s.seg)).size).toBeGreaterThanOrEqual(8);
    // Crossing back over the road it faces down; it waits on its bench for as long as it is listed.
    const crossing = samples.find((s) => s.seg === 4 && !back.some((p) => p.x === s.v.x && p.y === s.v.y))!;
    expect(crossing.v.dir).toBe("down");
    run(sim, 60);
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(b.col, b.row), seated: true });
    expect(sim.seating().map((a) => a.key)).toEqual(["g"]);
    expect([...sim.loungeClaims()]).toEqual([6]);
    // Removed: the despawn plays on the bench, sitting; the bench is claimed until it is gone.
    sim.setAgents(done.filter((a) => a.key !== "g.s0"));
    sim.tick(0.1);
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(b.col, b.row), seated: true, fx: { kind: "despawn" } });
    expect([...sim.loungeClaims()]).toEqual([6]);
    run(sim, FX_SEC);
    expect(sim.characters().map((c) => c.key)).toEqual(["g"]);
    expect([...sim.loungeClaims()]).toEqual([]);
  });

  it("a rebuild during its result's beat re-seats it at its desk — and it still heads back when the beat is over", () => {
    const list = team("g", "gazelle", 1);
    const { sim, roster } = citySim(list, [["g", 0], ["g.s0", 3]]);
    expect(toDesk(sim, "g.s0")).toBe(true);
    sim.setAgents(roster.agents.map((a) => (a.key === "g.s0" ? { ...a, activity: "done" as const } : a)));
    run(sim, RESULT_BEAT / 2);
    sim.setWorld(cityWorld(list).world); // the same plan, built again
    expect(view(sim, "g.s0")).toMatchObject({ seated: true, anim: "idle" });
    expect(sim.seating().map((a) => a.key)).toContain("g.s0");
    run(sim, RESULT_BEAT + 0.1);
    expect(view(sim, "g.s0").seated).toBe(false);
    expect(sim.seating().map((a) => a.key)).not.toContain("g.s0");
  });

  it("a done sub-agent appears on its bench and stays there; woken, it leaves — its PC dark until it sits at its desk", () => {
    const { sim, world, roster } = citySim(team("g", "gazelle", 1, { activity: "done" }), [["g", 0]]);
    const b = bench(world, 0); // the first bench nobody claims (the leader holds it, but it sits at its desk)
    run(sim, 30);
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(b.col, b.row), seated: true, dir: "down", anim: "idle" });
    const desk = deskOf(sim, "g.s0");
    sim.setAgents(roster.agents.map((a) => ({ ...a, activity: "typing" as const })));
    expect(sim.pcOn(desk.pcId!)).toBe(false);
    expect(view(sim, "g.s0").seated).toBe(true);
    sim.tick(0.1);
    expect(view(sim, "g.s0")).toMatchObject({ seated: false, anim: "walk", dir: "down" });
    expect(sim.pcOn(desk.pcId!)).toBe(false);
    expect(toDesk(sim, "g.s0")).toBe(true);
    expect(sim.pcOn(desk.pcId!)).toBe(true);
  });

  it("changes its mind where it stands: finishing mid-trip turns it round, busy again mid-return turns it round again", () => {
    const { sim, world, roster } = citySim(team("g", "gazelle", 1), [["g", 0], ["g.s0", 2]]);
    const desk = deskOf(sim, "g.s0");
    const pts = contractRoute(world, 2, desk);
    run(sim, FX_SEC + 3); // well on its way: past the lounge
    const mid = view(sim, "g.s0");
    const seg = segmentOf(pts, mid.x, mid.y, 0);
    expect(seg).toBeGreaterThanOrEqual(3);
    const as = (activity: VillageActivity) => roster.agents.map((a) => (a.key === "g.s0" ? { ...a, activity } : a));
    sim.setAgents(as("error"));
    sim.tick(1 / 60);
    const turned = view(sim, "g.s0");
    // No jump: one frame's step, and back along the way it came.
    expect(Math.hypot(turned.x - mid.x, turned.y - mid.y)).toBeLessThanOrEqual(160 / 60 + 1e-6);
    expect(segmentOf(pts, turned.x, turned.y, 0)).toBeLessThanOrEqual(seg);
    run(sim, 1);
    const back = view(sim, "g.s0");
    expect(segmentOf(pts, back.x, back.y, 0)).toBeLessThan(seg);
    // Busy again before it is home: round again, to its desk.
    sim.setAgents(as("reading"));
    expect(toDesk(sim, "g.s0")).toBe(true);
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(desk.col, desk.row), anim: "read" });
    // And when it finishes at last, it reaches its bench.
    sim.setAgents(as("idle"));
    const b = bench(world, 2);
    expect(runUntil(sim, 20, () => view(sim, "g.s0").seated && view(sim, "g.s0").x === feet(b.col, b.row).x)).toBe(true);
  });

  it("removed mid-trip — riding a lift, even — it despawns where it is", () => {
    const { sim, roster } = citySim(team("g", "gazelle", 1), [["g", 0], ["g.s0", 3]]);
    expect(runUntil(sim, 10, () => view(sim, "g.s0").riding === true)).toBe(true);
    const at = view(sim, "g.s0");
    sim.setAgents(roster.agents.filter((a) => a.key !== "g.s0"));
    for (let i = 0; i < 2; i++) {
      sim.tick(0.1);
      expect(view(sim, "g.s0")).toMatchObject({ x: at.x, y: at.y, fx: { kind: "despawn" }, riding: true });
    }
    run(sim, FX_SEC);
    expect(sim.characters().map((c) => c.key)).toEqual(["g"]);
    expect([...sim.loungeClaims()]).toEqual([]);
  });

  it("a world rebuild mid-trip re-routes it from where it stands — the street moved, a building appeared — never to its desk", () => {
    const list = team("g", "gazelle", 1);
    const { sim, world } = citySim(list, [["g", 0], ["g.s0", 4]]);
    const near = world.city!.street;
    // On the near sidewalk, walking to its building.
    expect(runUntil(sim, 10, () => view(sim, "g.s0").y === feet(0, near).y && view(sim, "g.s0").anim === "walk")).toBe(true);
    sim.tick(0.05);
    const before = view(sim, "g.s0");
    // A tall new building (three floors) joins the street: the street moves down, buildings shift.
    const grown = [...list, ...["t1", "t2", "t3"].map((k) => agent(k, { folder: "tower", origin: "ide", activity: "typing" }))];
    const next = cityWorld(grown);
    expect(next.world.city!.street).toBeGreaterThan(near);
    sim.setWorld(next.world);
    sim.setAgents(next.roster.agents);
    const after = view(sim, "g.s0");
    // Same street row of the new world, same x (clamped to its leg), still walking — not at its desk.
    expect(after).toMatchObject({ y: feet(0, next.world.city!.street).y, seated: false });
    const lift = next.world.city!.buildings.find((b) => b.key === "gazelle")!.lift!;
    const span = [feet(next.world.city!.lounge!.lift.col, 0).x, feet(lift.col, 0).x].sort((a, b) => a - b);
    expect(after.x).toBe(Math.min(span[1], Math.max(span[0], before.x)));
    // …and carries on along the new route to its (moved) desk.
    const desk = deskOf(sim, "g.s0");
    const pts = contractRoute(next.world, 4, desk);
    const samples = follow(sim, "g.s0", pts.slice(4), 20);
    expect(samples[samples.length - 1].v).toMatchObject({ ...sitting(desk.col, desk.row), seated: true });
  });

  it("a rebuild while it rides its building's lift (the floor grew a desk row) keeps it in the lift, at the same height", () => {
    // Gazelle has two floors; the team works upstairs, so its lift ride is six tiles long.
    const list = [agent("g0", { folder: "gazelle", origin: "ide", activity: "typing" }), ...team("g", "gazelle", 20)];
    const benches: [string, number][] = list.map((a, i) => [a.key, i]);
    const { sim, world } = citySim(list, benches);
    const lift = world.city!.buildings.find((b) => b.key === "gazelle")!.lift!;
    // In its building's lift: riding, above the door.
    let up = false;
    for (let t = 0; t < 15 && !up; t += 1 / 60) {
      sim.tick(1 / 60);
      const v = view(sim, "g.s19");
      up = v.riding === true && v.y < (lift.bottom - 1) * TILE;
    }
    expect(up).toBe(true);
    const before = view(sim, "g.s19");
    expect(before.x).toBe(feet(lift.col, 0).x);
    const grown = [...list, ...Array.from({ length: 2 }, (_, i) => agent(`g.n${i}`, { parentKey: "g", folder: "x", origin: "ide", activity: "typing" }))];
    const next = cityWorld(grown);
    const nlift = next.world.city!.buildings.find((b) => b.key === "gazelle")!.lift!;
    expect(nlift.bottom).toBeGreaterThan(lift.bottom); // taller floors: the street went down
    sim.setWorld(next.world);
    sim.setAgents(next.roster.agents);
    const after = view(sim, "g.s19");
    expect(after).toMatchObject({ x: feet(nlift.col, 0).x, riding: true, seated: false });
    expect(after.y).toBe(Math.min((nlift.bottom + 1) * TILE, Math.max(before.y, (deskOf(sim, "g.s19").row + 1) * TILE)));
    expect(toDesk(sim, "g.s19")).toBe(true);
  });

  it("the view hands the benches over AFTER the agents: a newcomer moves to the bench it holds while it is still appearing — once gone, it keeps the one it left from", () => {
    const { sim, world, roster } = citySim(team("g", "gazelle", 1)); // no benches handed over yet
    const first = bench(world, 0);
    expect(view(sim, "g.s0")).toMatchObject(sitting(first.col, first.row));
    sim.setLoungeSeats(new Map([["g", 0], ["g.s0", 9]]));
    const held = bench(world, 9);
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(held.col, held.row), seated: true, fx: { kind: "spawn" } });
    expect([...sim.loungeClaims()]).toEqual([9]);
    expect(toDesk(sim, "g.s0")).toBe(true);
    sim.setLoungeSeats(new Map([["g", 0], ["g.s0", 30]]));
    expect([...sim.loungeClaims()]).toEqual([9]);
    sim.setAgents(roster.agents.map((a) => (a.key === "g.s0" ? { ...a, activity: "done" as const } : a)));
    expect(runUntil(sim, 20, () => view(sim, "g.s0").seated && view(sim, "g.s0").x === feet(held.col, 0).x)).toBe(true);
  });

  it("a whole team arriving at once (the city's first roster) sits on the benches it holds, whatever it guessed before the seats came", () => {
    const list = team("g", "gazelle", 4);
    // The view's order: the agents first (each guesses the first bench nobody claims: 0, 1, 2, 3)…
    const { sim, world } = citySim(list);
    expect([...sim.loungeClaims()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // …then the holders' benches — each one another newcomer guessed.
    const held: [string, number][] = [["g", 0], ["g.s0", 3], ["g.s1", 2], ["g.s2", 1], ["g.s3", 4]];
    sim.setLoungeSeats(new Map(held));
    for (const [key, i] of held.slice(1)) expect([key, view(sim, key)]).toMatchObject([key, sitting(bench(world, i).col, bench(world, i).row)]);
  });

  it("newcomers whose bench another still claims take what is left only after every newcomer has its own", () => {
    const lead = agent("g", { folder: "gazelle", origin: "ide", activity: "typing" });
    const sub = (k: string, activity: VillageActivity) => agent(k, { parentKey: "g", folder: "x", origin: "ide", activity });
    const { roster, world } = cityWorld([lead, sub("g.x", "done"), sub("g.a", "typing"), sub("g.b", "typing")], 16);
    const sim = new VillageSim({ seed: 1, stayPut: true });
    sim.setWorld(world);
    sim.setLoungeSeats(new Map([["g.x", 0]]));
    sim.setAgents(roster.agents.filter((a) => a.key === "g" || a.key === "g.x"));
    settle(sim); // X sits on bench 0, done
    sim.setAgents(roster.agents);
    // A holds 0 — X's; B holds 1. B gets 1, A the first bench left after that: 2 (not B's).
    sim.setLoungeSeats(new Map([["g", 5], ["g.a", 0], ["g.b", 1]]));
    expect(view(sim, "g.b")).toMatchObject(sitting(bench(world, 1).col, bench(world, 1).row));
    expect(view(sim, "g.a")).toMatchObject(sitting(bench(world, 2).col, bench(world, 2).row));
  });

  it("never shares a bench: a newcomer whose bench another still claims takes the first one nobody claims; with none left it waits at the lounge lift's lowest stop — and gets a bench when it comes back", () => {
    // Two benches. A sits on 1 (done, waiting to be removed); the room hands its desk to B.
    const lead = agent("g", { folder: "gazelle", origin: "ide", activity: "typing" });
    const sub = (k: string, activity: VillageActivity) => agent(k, { parentKey: "g", folder: "x", origin: "ide", activity });
    const { roster, world } = cityWorld([lead, sub("g.a", "done"), sub("g.b", "typing"), sub("g.c", "typing")], 2);
    const sim = new VillageSim({ seed: 1, stayPut: true });
    sim.setWorld(world);
    const only = (keys: string[]) => roster.agents.filter((x) => keys.includes(x.key));
    sim.setLoungeSeats(new Map([["g", 0], ["g.a", 1]]));
    sim.setAgents(only(["g", "g.a"]));
    settle(sim);
    expect(view(sim, "g.a")).toMatchObject(sitting(bench(world, 1).col, bench(world, 1).row));
    // B holds 1, which A still claims: B takes 0 (the leader's, at its desk — nobody claims it).
    sim.setLoungeSeats(new Map([["g", 0], ["g.b", 1]]));
    sim.setAgents(only(["g", "g.a", "g.b"]));
    expect(view(sim, "g.b")).toMatchObject({ ...sitting(bench(world, 0).col, bench(world, 0).row), seated: true });
    settle(sim);
    // C holds a bench past the room's two: no bench left for it.
    sim.setLoungeSeats(new Map([["g", 0], ["g.b", 1], ["g.c", 2]]));
    sim.setAgents(only(["g", "g.a", "g.b", "g.c"]));
    const low = world.city!.lounge!.lift;
    expect(view(sim, "g.c")).toMatchObject({ ...feet(low.col, low.bottom), seated: false, dir: "down", anim: "idle" });
    expect([...sim.loungeClaims()].sort()).toEqual([0, 1]);
    // It still goes to work — from the lift's lowest stop.
    const desk = deskOf(sim, "g.c");
    const samples = follow(sim, "g.c", contractRoute(world, null, desk), 20);
    expect(samples[samples.length - 1].v).toMatchObject({ ...sitting(desk.col, desk.row), seated: true });
    // A is removed, freeing bench 1; C finishes and comes back to it.
    sim.setAgents(only(["g", "g.b", "g.c"]).map((x) => (x.key === "g.c" ? { ...x, activity: "done" as const } : x)));
    run(sim, FX_SEC + RESULT_BEAT + 0.1);
    expect([...sim.loungeClaims()].sort()).toEqual([0, 1]);
    const one = bench(world, 1);
    expect(runUntil(sim, 20, () => view(sim, "g.c").seated && view(sim, "g.c").x === feet(one.col, one.row).x)).toBe(true);
  });

  it("a bench number past the lounge's benches is no bench: it takes the first one nobody claims", () => {
    const { sim, world } = citySim(team("g", "gazelle", 2), [["g", 0], ["g.s0", 0], ["g.s1", 64]]);
    expect(view(sim, "g.s1")).toMatchObject(sitting(bench(world, 1).col, bench(world, 1).row));
  });

  it("a rebuild keeps a commuter's bench — or, its bench gone (fewer seats), gives it another; a commuter on its bench stays on it", () => {
    const list = team("g", "gazelle", 2, { activity: "done" });
    const { sim } = citySim(list, [["g", 0], ["g.s0", 70], ["g.s1", 5]], 80);
    expect([...sim.loungeClaims()].sort((x, y) => x - y)).toEqual([5, 70]);
    const next = cityWorld(list, 64);
    sim.setWorld(next.world);
    expect([...sim.loungeClaims()].sort((x, y) => x - y)).toEqual([0, 5]);
    for (const [key, i] of [
      ["g.s0", 0],
      ["g.s1", 5],
    ] as const)
      expect(view(sim, key)).toMatchObject({ ...sitting(bench(next.world, i).col, bench(next.world, i).row), seated: true });
  });

  it("a busy sub-agent with no desk (its floor is not built) waits on its bench", () => {
    const { roster } = cityWorld(team("g", "gazelle", 1));
    const { world } = cityWorld([agent("o", { folder: "other", origin: "ide", activity: "typing" })]);
    const sim = new VillageSim({ seed: 1, stayPut: true });
    sim.setWorld(world);
    sim.setAgents(roster.agents);
    const b = bench(world, 0);
    run(sim, 10);
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(b.col, b.row), seated: true, activity: "typing" });
    expect(sim.seatFor("g.s0")).toBeNull();
  });

  it("a commuter whose desk is gone in a rebuild stops where it stands", () => {
    const { sim } = citySim(team("g", "gazelle", 1), [["g", 0], ["g.s0", 0]]);
    expect(runUntil(sim, 10, () => view(sim, "g.s0").anim === "walk" && view(sim, "g.s0").dir === "right")).toBe(true);
    const at = view(sim, "g.s0");
    sim.setWorld(cityWorld([agent("o", { folder: "other", origin: "ide", activity: "typing" })]).world);
    expect(view(sim, "g.s0")).toMatchObject({ x: at.x, y: at.y, anim: "idle", seated: false });
  });

  it("without a lounge (a city with no capacity layout) nothing changes: sub-agents appear at their desks and claim no bench", () => {
    const { sim } = citySim(team("g", "gazelle", 2), [["g.s0", 3]], null);
    for (const k of ["g.s0", "g.s1"]) {
      const desk = deskOf(sim, k);
      expect(view(sim, k)).toMatchObject({ ...sitting(desk.col, desk.row), seated: true, dir: "up" });
    }
    expect([...sim.loungeClaims()]).toEqual([]);
    expect(sim.seating().map((a) => a.key)).toEqual(["g", "g.s0", "g.s1"]);
  });

  it("a sub-agent seated before the city had a lounge keeps its desk, takes a bench at the rebuild, and goes back to it when done", () => {
    const list = team("g", "gazelle", 1);
    const { sim, roster } = citySim(list, undefined, null);
    settle(sim);
    const lounged = cityWorld(list).world;
    sim.setLoungeSeats(new Map([["g", 0], ["g.s0", 4]]));
    sim.setWorld(lounged);
    const desk = deskOf(sim, "g.s0");
    expect(view(sim, "g.s0")).toMatchObject({ ...sitting(desk.col, desk.row), seated: true, anim: "type" });
    expect([...sim.loungeClaims()]).toEqual([4]);
    sim.setAgents(roster.agents.map((a) => (a.key === "g.s0" ? { ...a, activity: "done" as const } : a)));
    const b = bench(lounged, 4);
    expect(runUntil(sim, 20, () => view(sim, "g.s0").seated && view(sim, "g.s0").x === feet(b.col, b.row).x)).toBe(true);
  });
});
