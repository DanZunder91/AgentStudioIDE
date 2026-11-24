import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SEAT_LIFT, TILE, type CapacityFrame, type CharacterView, type DrawItem, type HallFrame, type LanEvent, type Prop, type Seat, type VillageAgent } from "../villageTypes";
import {
  buildDrawList,
  characterZ,
  hitTest,
  HOUSE_FLOORS,
  HOUSE_HUES,
  houseStyles,
  LABEL_RANK,
  labelRank,
  liftShafts,
  LOUNGE_STYLE,
  READER_EVERY,
  ROUTINE_MIN,
  ROUTINE_SPREAD,
  SHIFT_SEC,
  WAITER_HUES,
  waiterLook,
  waiterPose,
  METER_W,
  meterSpot,
  PROP_FRAME_SEC,
  RACK_UNITS,
  rackReading,
  propZ,
  THRESHOLD_FLOOR,
  wallMask,
} from "./drawList";
import { buildCityWorld, planCity } from "./city";
import { hashString } from "./rng";
import { teamLanTraffic, teamLanWiring } from "./teamLan";
import { SIT_OFFSET, VillageSim } from "./sim";
import { asciiWorld } from "./testWorld";
import { buildWorld, planHouses, RACKS } from "./world";

function cv(key: string, extra: Partial<CharacterView> = {}): CharacterView {
  return {
    key,
    x: 40,
    y: 64,
    dir: "down",
    anim: "idle",
    frame: 0,
    palette: 0,
    hueShift: 0,
    seated: false,
    origin: "ide",
    isSubagent: false,
    activity: "idle",
    label: key,
    tool: null,
    bubble: null,
    bubbleAlpha: 0,
    fx: null,
    ...extra,
  };
}

function agent(key: string, extra: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "external",
    title: key,
    folder: "proj",
    activity: "idle",
    tool: null,
    ideAgentId: null,
    lastActivityAt: null,
    ...extra,
  };
}

const never = () => false;

/** The z the engine used for a scene item (walls, props, characters). */
function zOf(item: DrawItem): number {
  if (item.t === "wall") return (item.row + 1) * TILE;
  if (item.t === "prop") return propZ(item.prop);
  if (item.t === "character") return characterZ(item.c);
  throw new Error(`not a scene item: ${item.t}`);
}

describe("buildDrawList layering", () => {
  it("emits ground tiles first (row-major, no walls), then the scene, then bubbles, then labels", () => {
    const w = buildWorld([{ key: "h", label: "House H", seats: 4, subSeats: 0, hasIde: false }]);
    const chars = [cv("a", { bubble: "waiting", bubbleAlpha: 1 }), cv("b", { x: 300, y: 300 })];
    const list = buildDrawList(w, chars, never, 0);
    const kinds = list.map((i) => i.t);
    const firstNonTile = kinds.findIndex((k) => k !== "tile");
    expect(kinds.slice(firstNonTile).includes("tile")).toBe(false);
    expect(firstNonTile).toBe(w.tiles.filter((t) => t !== "wall").length);
    const tiles = list.slice(0, firstNonTile) as Extract<DrawItem, { t: "tile" }>[];
    for (let i = 1; i < tiles.length; i++)
      expect(tiles[i].row * w.cols + tiles[i].col).toBeGreaterThan(tiles[i - 1].row * w.cols + tiles[i - 1].col);
    const house = w.houses[0];
    const style = houseStyles([house.key]).get(house.key)!;
    for (const t of tiles) {
      expect(t.kind).toBe(w.tiles[t.row * w.cols + t.col]);
      if (t.kind === "floor") {
        // ONE floor for the whole room (no per-tile patchwork); the door is a dark threshold.
        const isDoor = t.col === house.doorCol && t.row === house.doorRow;
        expect(t.variant).toBe(isDoor ? THRESHOLD_FLOOR : style.floor);
      } else {
        expect(t.variant).toBeGreaterThanOrEqual(0);
        expect(t.variant).toBeLessThan(4);
      }
    }
    expect(new Set(tiles.filter((t) => t.kind !== "floor").map((t) => t.variant)).size).toBe(4);
    // tail: one bubble, then house labels, then agent labels
    const tail = list.slice(list.findIndex((i) => i.t === "bubble"));
    expect(tail.map((i) => (i.t === "label" ? `label:${i.tone}` : i.t))).toEqual([
      "bubble",
      "label:house",
      "label:agent",
      "label:agent",
    ]);
    // The house board is centred over the house, on its back wall — above the interior.
    expect(tail[1]).toEqual({ t: "label", x: (house.col + house.w / 2) * TILE, y: house.row * TILE - 12, text: "House H", tone: "house" });
    expect((tail[1] as { y: number }).y).toBeLessThan(house.row * TILE);
    expect((tail[1] as { y: number }).y).toBeGreaterThan((house.row - 2) * TILE);
    expect(tail[2]).toEqual({ t: "label", x: 40, y: 65, text: "a", tone: "agent", priority: LABEL_RANK.root });
    // all walls and props present exactly once
    expect(list.filter((i) => i.t === "wall")).toHaveLength(w.tiles.filter((t) => t === "wall").length);
    expect(list.filter((i) => i.t === "prop")).toHaveLength(w.props.length);
  });

  it("builds the static ground and walls once per World, never mutated by a frame", () => {
    const world = buildWorld(planHouses([agent("a")]));
    const a = buildDrawList(world, [], () => false, 0);
    const b = buildDrawList(world, [], () => true, 1);
    expect(a).not.toBe(b); // a fresh list per frame…
    const statics = (l: DrawItem[]) => l.filter((i) => i.t === "tile" || i.t === "wall");
    // …whose tile and wall items are the SAME objects (no per-frame allocation)…
    statics(a).forEach((item, i) => expect(statics(b)[i]).toBe(item));
    expect(statics(a).length).toBe(world.cols * world.rows);
    // …and a new World gets its own.
    const other = buildDrawList(buildWorld(planHouses([agent("a")])), [], () => false, 0);
    expect(statics(other)[0]).not.toBe(statics(a)[0]);
    expect(statics(other)).toEqual(statics(a));
  });

  it("skips bubbles that have faded out", () => {
    const w = asciiWorld(["..."]);
    const list = buildDrawList(w, [cv("a", { bubble: "done", bubbleAlpha: 0 }), cv("b", { bubble: "error", bubbleAlpha: 0.3 })], never, 0);
    expect(list.filter((i) => i.t === "bubble").map((i) => (i as { c: CharacterView }).c.key)).toEqual(["b"]);
  });

  it("z-sorts the scene by bottom edge for any simulated state (property)", () => {
    const agents = [
      ...["a", "b", "c", "d", "e"].map((k, i) => agent(k, { activity: (["typing", "idle", "reading", "waiting", "idle"] as const)[i] })),
      agent("s", { parentKey: "a", activity: "typing" }),
      agent("o", { folder: "other", origin: "ide", activity: "thinking" }),
    ];
    const world = buildWorld(planHouses(agents));
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 0, max: 400 }), (seed, ticks) => {
        const sim = new VillageSim({ seed });
        sim.setWorld(world);
        sim.setAgents(agents);
        for (let i = 0; i < ticks; i++) sim.tick(0.1);
        const chars = sim.characters();
        const list = buildDrawList(world, chars, (id) => sim.pcOn(id), sim.time);
        const scene = list.filter((i) => i.t === "wall" || i.t === "prop" || i.t === "character");
        for (let i = 1; i < scene.length; i++) expect(zOf(scene[i])).toBeGreaterThanOrEqual(zOf(scene[i - 1]));
        expect(scene.filter((i) => i.t === "character")).toHaveLength(chars.length);
      }),
      { numRuns: 40 },
    );
  });

  it("puts a seated typist in front of desk and pc but behind its up-facing chair", () => {
    const agents = [agent("a", { activity: "typing" })];
    const world = buildWorld(planHouses(agents));
    const sim = new VillageSim();
    sim.setWorld(world);
    sim.setAgents(agents);
    const c = sim.characters()[0];
    const seat = world.seats.find((s) => s.col * TILE + 8 === c.x && s.row * TILE + TILE + SIT_OFFSET === c.y)!;
    const list = buildDrawList(world, [c], (id) => sim.pcOn(id), 0);
    const idx = (pred: (i: DrawItem) => boolean) => list.findIndex(pred);
    const desk = idx((i) => i.t === "prop" && i.prop.kind === "desk" && i.prop.col === seat.col && i.prop.row === seat.row - 1);
    const pc = idx((i) => i.t === "prop" && i.prop.id === seat.pcId);
    const ch = idx((i) => i.t === "character");
    const chair = idx((i) => i.t === "prop" && i.prop.kind === "chair" && i.prop.col === seat.col && i.prop.row === seat.row);
    expect(desk).toBeLessThan(pc);
    expect(pc).toBeLessThan(ch);
    expect(ch).toBeLessThan(chair);
    expect(list[pc]).toMatchObject({ on: true });
  });

  it("seats sub-agents at the team table: the far side behind table and laptop, the near side in front, laptops lit", () => {
    const agents = [agent("p", { activity: "typing" }), ...[0, 1, 2, 3].map((i) => agent(`s${i}`, { parentKey: "p", activity: "typing" }))];
    const world = buildWorld(planHouses(agents));
    const sim = new VillageSim();
    sim.setWorld(world);
    sim.setAgents(agents);
    const chars = sim.characters();
    const list = buildDrawList(world, chars, (id) => sim.pcOn(id), 0);
    const idx = (pred: (i: DrawItem) => boolean) => list.findIndex(pred);
    const table = idx((i) => i.t === "prop" && i.prop.kind === "table");
    for (const seat of world.seats.filter((s) => s.forSub)) {
      const c = chars.find((v) => v.x === seat.col * TILE + 8 && v.y === seat.row * TILE + TILE + SIT_OFFSET)!;
      const ch = idx((i) => i.t === "character" && i.c.key === c.key);
      const lap = idx((i) => i.t === "prop" && i.prop.id === seat.pcId);
      expect(list[lap]).toMatchObject({ on: true });
      expect(table).toBeLessThan(lap);
      if (seat.facing === "down") expect(ch).toBeLessThan(table);
      else expect(lap).toBeLessThan(ch);
    }
  });

  it("draws a character standing below a wall in front of it, one behind it behind", () => {
    const w = asciiWorld(["...", "###", "..."]);
    const above = cv("above", { x: 24, y: 16 }); // row 0
    const below = cv("below", { x: 24, y: 48 }); // row 2
    const list = buildDrawList(w, [below, above], never, 0).filter((i) => i.t !== "tile");
    const order = list.map((i) => (i.t === "character" ? i.c.key : i.t));
    expect(order.slice(0, 5)).toEqual(["above", "wall", "wall", "wall", "below"]);
  });
});

describe("props", () => {
  it("animates lit pcs, the fountain and the campfire every 0.2 s over 3 frames", () => {
    const props: Prop[] = [
      { id: "pc-on", kind: "pc", col: 0, row: 0, w: 1, h: 1, seatId: "s" },
      { id: "pc-off", kind: "pc", col: 1, row: 0, w: 1, h: 1 },
      { id: "lap-on", kind: "laptop", col: 2, row: 0, w: 1, h: 1, seatId: "s2" },
      { id: "lap-off", kind: "laptop", col: 4, row: 0, w: 1, h: 1, seatId: "s3" },
      { id: "f", kind: "fountain", col: 0, row: 1, w: 3, h: 3 },
      { id: "c", kind: "campfire", col: 3, row: 0, w: 1, h: 1 },
      { id: "t", kind: "tree", col: 3, row: 2, w: 2, h: 2 },
    ];
    const w = asciiWorld([".....", ".....", ".....", "....."], { props });
    const frames = (time: number) => {
      const list = buildDrawList(w, [], (id) => id === "pc-on" || id === "lap-on", time);
      return Object.fromEntries(
        list.filter((i) => i.t === "prop").map((i) => {
          const p = i as Extract<DrawItem, { t: "prop" }>;
          return [p.prop.id, `${p.on ? "on" : "off"}:${p.frame}`];
        }),
      );
    };
    expect(frames(0)).toEqual({ "pc-on": "on:0", "pc-off": "off:0", "lap-on": "on:0", "lap-off": "off:0", f: "on:0", c: "on:0", t: "off:0" });
    expect(frames(PROP_FRAME_SEC + 0.01)).toMatchObject({ "pc-on": "on:1", "lap-on": "on:1", f: "on:1", c: "on:1", "pc-off": "off:0", "lap-off": "off:0" });
    expect(frames(2 * PROP_FRAME_SEC + 0.01)["pc-on"]).toBe("on:2");
    expect(frames(3 * PROP_FRAME_SEC + 0.01)["pc-on"]).toBe("on:0");
  });

  it("computes prop z from the footprint bottom with surface/chair nudges", () => {
    const base = { id: "x", col: 2, row: 3, w: 1, h: 1 };
    expect(propZ({ ...base, kind: "desk", w: 2 })).toBe(64);
    expect(propZ({ ...base, kind: "pc" })).toBe(64.5);
    expect(propZ({ ...base, kind: "coffee" })).toBe(64.5);
    expect(propZ({ ...base, kind: "chair", facing: "up" })).toBe(65);
    expect(propZ({ ...base, kind: "chair", facing: "down" })).toBe(64);
    expect(propZ({ ...base, kind: "tree", h: 2 })).toBe(80);
    // a laptop sorts in front of the 3-row team table it stands on
    expect(propZ({ ...base, kind: "table", w: 3, h: 3 })).toBe(96);
    expect(propZ({ ...base, kind: "laptop", facing: "up", row: 5 })).toBe(96.5);
    expect(propZ({ ...base, kind: "laptop", facing: "down" })).toBe(96.5);
  });
});

describe("wallMask", () => {
  it("encodes N=1 E=2 S=4 W=8, with out-of-bounds as not-wall", () => {
    const w = asciiWorld(["###", "#.#", "###"]);
    expect(wallMask(w, 0, 0)).toBe(2 | 4);
    expect(wallMask(w, 1, 0)).toBe(2 | 8);
    expect(wallMask(w, 2, 0)).toBe(4 | 8);
    expect(wallMask(w, 0, 1)).toBe(1 | 4);
    expect(wallMask(w, 2, 2)).toBe(1 | 8);
    const cross = asciiWorld([".#.", "###", ".#."]);
    expect(wallMask(cross, 1, 1)).toBe(15);
    const list = buildDrawList(cross, [], never, 0);
    expect(list.find((i) => i.t === "wall" && i.col === 1 && i.row === 1)).toEqual({ t: "wall", col: 1, row: 1, mask: 15 });
  });
});

describe("hitTest", () => {
  it("hits the 16×32 box above the feet", () => {
    const chars = [cv("a", { x: 40, y: 64 })];
    expect(hitTest(chars, 40, 50)).toBe("a");
    expect(hitTest(chars, 32, 32)).toBe("a"); // top-left corner inclusive
    expect(hitTest(chars, 48, 50)).toBeNull(); // right edge exclusive
    expect(hitTest(chars, 31.9, 50)).toBeNull();
    expect(hitTest(chars, 40, 64)).toBeNull(); // feet line exclusive
    expect(hitTest(chars, 40, 31.9)).toBeNull();
    expect(hitTest([], 0, 0)).toBeNull();
  });

  it("returns the topmost (front-most) character, later wins ties, ignores despawning", () => {
    const back = cv("back", { x: 40, y: 60 });
    const front = cv("front", { x: 42, y: 66 });
    expect(hitTest([front, back], 41, 55)).toBe("front");
    expect(hitTest([back, front], 41, 55)).toBe("front");
    const twin = cv("twin", { x: 40, y: 60 });
    expect(hitTest([back, twin], 40, 50)).toBe("twin");
    expect(hitTest([back, { ...front, fx: { kind: "despawn", t: 0.5 } }], 41, 55)).toBe("back");
    expect(hitTest([{ ...front, fx: { kind: "spawn", t: 0.5 } }], 41, 55)).toBe("front");
  });

  it("orders seated characters by their chair tile, not the drawn offset", () => {
    const seated = cv("seated", { x: 40, y: 64 + SIT_OFFSET, seated: true });
    const standing = cv("standing", { x: 40, y: 67 });
    expect(characterZ(seated)).toBe(64.5);
    expect(hitTest([standing, seated], 40, 55)).toBe("standing");
  });
});

describe("house styles", () => {
  it("gives every house its own hue and floor while any are left, deterministically", () => {
    const keys = ["Agent Studio", "gazelle", "agentstudio-demo", "a", "b", "c"];
    const styles = houseStyles(keys);
    expect(new Set(keys.map((k) => styles.get(k)!.hue)).size).toBe(HOUSE_HUES.length);
    expect(new Set(keys.map((k) => styles.get(k)!.floor)).size).toBe(HOUSE_FLOORS.length);
    for (const k of keys) {
      expect(HOUSE_HUES).toContain(styles.get(k)!.hue);
      expect(HOUSE_FLOORS).toContain(styles.get(k)!.floor);
    }
    expect(houseStyles(keys)).toEqual(styles);
    // A house's look comes from its own key: alone, it gets the same style as when first.
    expect(houseStyles(["gazelle"]).get("gazelle")).toEqual(houseStyles(["gazelle", "x"]).get("gazelle"));
    // Past the palette size the options start a fresh round instead of failing.
    const many = houseStyles([...keys, "seventh"]);
    expect(HOUSE_HUES).toContain(many.get("seventh")!.hue);
  });

  it("tints a house's walls with its hue; only the bottom (door) row is a front wall", () => {
    const w = buildWorld([{ key: "h", label: "H", seats: 4, subSeats: 0, hasIde: false }]);
    const house = w.houses[0];
    const { hue } = houseStyles(["h"]).get("h")!;
    const walls = buildDrawList(w, [], never, 0).filter((i): i is Extract<DrawItem, { t: "wall" }> => i.t === "wall");
    expect(walls.length).toBeGreaterThan(0);
    for (const wall of walls) {
      expect(wall.hue).toBe(hue);
      expect(wall.front === true).toBe(wall.row === house.doorRow);
    }
    // Walls that belong to no house keep the default look.
    const loose = buildDrawList(asciiWorld(["###"]), [], never, 0).filter((i) => i.t === "wall");
    for (const wall of loose) expect(wall).toEqual({ t: "wall", col: expect.any(Number), row: 0, mask: expect.any(Number) });
  });
});

describe("agent labels", () => {
  const rankOf = (c: CharacterView, hovered: string | null = null) => labelRank(c, hovered);

  it("ranks hovered > waiting > root > sub-agent", () => {
    expect(rankOf(cv("a", { isSubagent: true, activity: "waiting" }), "a")).toBe(LABEL_RANK.hovered);
    expect(rankOf(cv("a", { isSubagent: true, activity: "waiting" }))).toBe(LABEL_RANK.waiting);
    expect(rankOf(cv("a"))).toBe(LABEL_RANK.root);
    expect(rankOf(cv("a", { isSubagent: true }))).toBe(LABEL_RANK.sub);
    expect(LABEL_RANK.hovered).toBeLessThan(LABEL_RANK.waiting);
    expect(LABEL_RANK.waiting).toBeLessThan(LABEL_RANK.root);
    expect(LABEL_RANK.root).toBeLessThan(LABEL_RANK.sub);
  });

  it("emits agent labels in rank order (stable front-to-back within a rank), the hovered one first", () => {
    const w = asciiWorld(["...."]);
    const chars = [
      cv("sub", { isSubagent: true, y: 10 }),
      cv("root1", { y: 20 }),
      cv("wait", { activity: "waiting", y: 30 }),
      cv("root2", { y: 40 }),
      cv("hover", { isSubagent: true, y: 50 }),
    ];
    const labels = (hovered: string | null) =>
      buildDrawList(w, chars, never, 0, hovered)
        .filter((i): i is Extract<DrawItem, { t: "label" }> => i.t === "label")
        .map((l) => `${l.text}:${l.priority}`);
    expect(labels("hover")).toEqual(["hover:0", "wait:1", "root1:2", "root2:2", "sub:3"]);
    expect(labels(null)).toEqual(["wait:1", "root1:2", "root2:2", "sub:3", "hover:3"]);
  });

  it("hangs a sitter's label below its chair tile, not below its depth-offset y", () => {
    const sitter = cv("s", { seated: true, y: 64 + SIT_OFFSET });
    const [label] = buildDrawList(asciiWorld(["."]), [sitter], never, 0).filter((i) => i.t === "label");
    expect(label).toMatchObject({ x: 40, y: 65 });
  });
});

describe("hitTest when seated", () => {
  it("follows the raised sprite of a sitter", () => {
    const sitter = cv("s", { seated: true, x: 40, y: 64 + SIT_OFFSET });
    const feet = sitter.y - SEAT_LIFT;
    expect(hitTest([sitter], 40, feet - 1)).toBe("s");
    expect(hitTest([sitter], 40, feet - 31)).toBe("s");
    expect(hitTest([sitter], 40, feet + 1)).toBeNull();
    expect(hitTest([sitter], 40, feet - 33)).toBeNull();
  });
});

describe("a city", () => {
  const plans = planCity([
    agent("lead", { folder: "gazelle", origin: "ide", activity: "typing" }),
    ...Array.from({ length: 10 }, (_, i) => agent(`s${i}`, { parentKey: "lead", activity: "typing" })),
    agent("term:1", { folder: "gazelle", origin: "ide", consoleId: "1" }),
    agent("far", { folder: "demo" }),
  ]).plans;
  const city = buildCityWorld(plans);

  it("dresses each BUILDING in one look — every floor alike — with its street wall as the front and the door's threshold", () => {
    const list = buildDrawList(city, [], never, 0);
    const styles = houseStyles(city.city!.buildings.map((b) => b.key));
    for (const b of city.city!.buildings) {
      const inside = (c: number, r: number) => c >= b.col && c < b.col + b.w && r >= b.row && r < b.row + b.h;
      const front = b.row + b.h - 1;
      const style = styles.get(b.key)!;
      const walls = list.filter((i): i is Extract<DrawItem, { t: "wall" }> => i.t === "wall" && inside(i.col, i.row));
      expect(walls.length).toBeGreaterThan(0);
      for (const w of walls) {
        expect(w.hue).toBe(style.hue);
        expect(w.front === true).toBe(w.row === front);
      }
      const floors = list.filter((i): i is Extract<DrawItem, { t: "tile" }> => i.t === "tile" && i.kind === "floor" && inside(i.col, i.row));
      for (const f of floors) expect(f.variant).toBe(f.col === b.doorCol && f.row === front ? THRESHOLD_FLOOR : style.floor);
    }
    // Two buildings, two looks.
    expect(new Set(city.city!.buildings.map((b) => styles.get(b.key)!.hue)).size).toBe(2);
  });

  it("labels the city: a sign over every roof, a plate on every floor's slab — and nothing else, not even on a crowded floor", () => {
    const labels = buildDrawList(city, [], never, 0).filter((i): i is Extract<DrawItem, { t: "label" }> => i.t === "label");
    const signs = labels.filter((l) => l.tone === "house");
    expect(signs.map((l) => l.text)).toEqual(["gazelle", "demo"]);
    city.city!.buildings.forEach((b, i) => {
      expect(signs[i]).toMatchObject({ x: (b.col + b.w / 2) * TILE, y: b.row * TILE - 14 });
      expect(signs[i].priority).toBeUndefined(); // forced, like a house's board
    });
    const plates = labels.filter((l) => l.tone === "floor");
    expect(plates.map((l) => l.text)).toEqual(city.houses.map((h) => h.label));
    city.houses.forEach((h, i) =>
      // A plate never runs past its floor: capped at the floor's width less the inset either side.
      expect(plates[i]).toMatchObject({ x: h.col * TILE + 2, y: (h.row - 1) * TILE + 8, priority: LABEL_RANK.root, maxW: h.w * TILE - 4 }),
    );
    // The lead's floor has 10 sub-agents (past the old cap of 8): all 10 at a desk, no "+N".
    expect(city.seats.filter((s) => s.houseKey === "floor:lead" && s.forSub)).toHaveLength(10);
    expect(labels).toHaveLength(signs.length + plates.length);
  });

  it("never draws a '+N' on a floor, whatever its team (0..40 sub-agents): signs and plates only", () => {
    for (let n = 0; n <= 40; n++) {
      const world = buildCityWorld(
        planCity([
          agent("lead", { folder: "gazelle", origin: "ide" }),
          ...Array.from({ length: n }, (_, i) => agent(`s${i}`, { parentKey: "lead", activity: i % 3 ? "done" : "typing" })),
          agent("term:1", { folder: "gazelle", origin: "ide", consoleId: "1" }),
        ]).plans,
      );
      const labels = buildDrawList(world, [], never, 0).filter((i): i is Extract<DrawItem, { t: "label" }> => i.t === "label");
      const words = labels.map((l) => [l.tone, l.text]);
      expect([n, words]).toEqual([n, [["house", "gazelle"], ["floor", "lead"], ["floor", "term:1"]]]);
    }
  });

  it("tags only the HOVERED character — a floor's plate already names its leader", () => {
    const chars = [cv("lead", { x: 100, y: 100 }), cv("s0", { isSubagent: true, x: 120, y: 120 }), cv("far", { x: 300, y: 100 })];
    const tags = (hovered: string | null) =>
      buildDrawList(city, chars, never, 0, hovered)
        .filter((i): i is Extract<DrawItem, { t: "label" }> => i.t === "label" && i.tone === "agent")
        .map((l) => [l.text, l.priority]);
    expect(tags(null)).toEqual([]);
    expect(tags("s0")).toEqual([["s0", LABEL_RANK.hovered]]);
    expect(tags("gone")).toEqual([]);
  });

  it("sorts a leader's monitor in front of its desk and lights it while its owner works", () => {
    const base = { id: "m", col: 2, row: 3, w: 1, h: 1 };
    expect(propZ({ ...base, kind: "monitor" })).toBe(64.5);
    const monitors = (on: boolean) =>
      buildDrawList(city, [], () => on, 0)
        .filter((i): i is Extract<DrawItem, { t: "prop" }> => i.t === "prop" && i.prop.kind === "monitor")
        .map((i) => i.on);
    expect(monitors(true)).toEqual(city.houses.map(() => true));
    expect(monitors(false)).toEqual(city.houses.map(() => false));
  });
});

describe("capacity", () => {
  const holder = (key: string, activity: VillageAgent["activity"] = "typing") => ({ key, activity, parentKey: null });
  /** A hall reading: 3 seats of messages, 1 reserved, 196 free (any 200 cells do: the draw list passes them through). */
  const HALL: HallFrame = {
    cells: ["messages", "messages", "messages", ...Array.from({ length: 196 }, () => "free-space"), "autocompact-buffer"],
    usedPct: 2,
    tone: "ok",
  };
  /** A City frame: the lounge's benches (2 of 4 held), the Seats hall, each board its own caption. */
  function frame(over: Partial<CapacityFrame> = {}): CapacityFrame {
    return {
      desks: [holder("a"), holder("b", "idle"), null, null],
      hall: HALL,
      memory: { agents: 0.25, used: 0.5 },
      usage: { session: { fill: 0.41, tone: "ok" }, week: null },
      context: {},
      captions: { seats: "Seats 3/200", memory: "Memory 2.0 GB", usage: "Usage 41% · ?", lounge: "Lounge 2/4" },
      gaugeCaptions: ["5h 41%", "week ?"],
      ...over,
    };
  }
  const noSeat = () => null;
  const props = (items: DrawItem[]) => items.filter((i): i is Extract<DrawItem, { t: "prop" }> => i.t === "prop");
  const labels = (items: DrawItem[]) => items.filter((i): i is Extract<DrawItem, { t: "label" }> => i.t === "label");
  const people = (items: DrawItem[]) => items.filter((i): i is Extract<DrawItem, { t: "character" }> => i.t === "character").map((i) => i.c);

  describe("rackReading", () => {
    const total = RACKS * RACK_UNITS;
    it("fills rack by rack: the agents' units first, then the rest of the used RAM", () => {
      const m = { agents: 10 / total, used: 20 / total };
      expect(rackReading(m, 0)).toEqual({ kind: "rack", agents: 8, other: 0, known: true });
      expect(rackReading(m, 1)).toEqual({ kind: "rack", agents: 2, other: 6, known: true });
      expect(rackReading(m, 2)).toEqual({ kind: "rack", agents: 0, other: 4, known: true });
      expect(rackReading(m, 3)).toEqual({ kind: "rack", agents: 0, other: 0, known: true });
    });
    it("0 / 50 / 100 %: all dark, half the units, every unit", () => {
      const lit = (used: number) => Array.from({ length: RACKS }, (_, i) => rackReading({ agents: 0, used }, i)).reduce((n, r) => n + (r.kind === "rack" ? r.other : 0), 0);
      expect([lit(0), lit(0.5), lit(1)]).toEqual([0, total / 2, total]);
    });
    it("a tiny agent share still lights one unit; unknown pieces count as nothing; all unknown is 'unknown'", () => {
      expect(rackReading({ agents: 0.0001, used: null }, 0)).toEqual({ kind: "rack", agents: 1, other: 0, known: true });
      expect(rackReading({ agents: null, used: 1 / RACKS }, 0)).toEqual({ kind: "rack", agents: 0, other: 8, known: true });
      expect(rackReading({ agents: null, used: null }, 0)).toEqual({ kind: "rack", agents: 0, other: 0, known: false });
      expect(rackReading(null, 0)).toEqual({ kind: "rack", agents: 0, other: 0, known: false });
    });
  });

  it("meterSpot: on the free right tile of a desk above an up-facing sitter, on the front of a leader's desk below", () => {
    const up: Seat = { id: "s", houseKey: "h", col: 3, row: 5, facing: "up", pcId: null };
    expect(meterSpot(up)).toEqual({ x: 4 * TILE + 1, y: 5 * TILE - 5 });
    expect(meterSpot({ ...up, facing: "down" })).toEqual({ x: 3 * TILE + 1, y: 7 * TILE - 5 });
  });

  describe("in the village", () => {
    const world = buildWorld(planHouses([agent("a", { activity: "typing" })]), { seats: 4 });
    /** A village frame: no lounge (no desks, an empty lounge caption), the hall. */
    const villageFrame = (over: Partial<CapacityFrame> = {}): CapacityFrame =>
      frame({ desks: [], hall: HALL, captions: { seats: "Seats 3/200", memory: "Memory 2.0 GB", usage: "Usage 41% · ?", lounge: "" }, ...over });
    const hallItems = (items: DrawItem[]) => props(items).filter((i) => i.prop.kind === "hall");

    it("hands the hall prop the frame's own hall as its reading — dark, frame 0 — and { hall: null } before the first frame", () => {
      const items = buildDrawList(world, [], () => true, 0.7, null, { frame: villageFrame(), seatOf: noSeat });
      const [hall] = hallItems(items);
      expect(hallItems(items)).toHaveLength(1);
      expect(hall.prop.id).toBe("cap/seats:hall");
      expect(hall.reading).toStrictEqual({ kind: "hall", hall: HALL });
      expect((hall.reading as { hall: HallFrame }).hall).toBe(HALL); // the very object: nothing copied per frame
      expect([hall.on, hall.frame]).toEqual([false, 0]);
      // No capacity frame yet: a hall with no reading (null — never undefined, never an empty hall).
      expect(hallItems(buildDrawList(world, [], () => true, 0.7))[0].reading).toStrictEqual({ kind: "hall", hall: null });
      // An unknown hall (no cells: nothing selected, a sub-agent, not read yet) is passed on as it is.
      const unknown: HallFrame = { cells: null, usedPct: null, tone: "unknown" };
      expect(hallItems(buildDrawList(world, [], () => true, 0, null, { frame: villageFrame({ hall: unknown }), seatOf: noSeat }))[0].reading).toStrictEqual({
        kind: "hall",
        hall: { cells: null, usedPct: null, tone: "unknown" },
      });
    });

    it("draws nobody in the Seats house: no stand-in at any desk, whatever the frame's desks say", () => {
      // Even a frame that names holders (a city-shaped one) seats no one in the Village: there are no desks.
      for (const desks of [[], [holder("a"), holder("b", "reading"), null, null]]) {
        const items = buildDrawList(world, [], () => false, 0.31, null, { frame: villageFrame({ desks }), seatOf: noSeat });
        expect(people(items)).toEqual([]);
        expect(items.some((i) => i.t === "bubble")).toBe(false);
        expect(labels(items).some((l) => /^\+\d+$/.test(l.text))).toBe(false);
      }
    });

    it("no cable and no packet in a Seats house — with no team room the village has no LAN at all, whatever is said", () => {
      const events: LanEvent[] = [
        { kind: "tool", key: "a", at: 3 },
        { kind: "task", key: "a", at: 3 },
        { kind: "result", key: "a", at: 3 },
      ];
      for (const t of [0, 3, 3.2, 4]) {
        const f = villageFrame({ desks: [holder("a"), holder("b"), null, null] });
        const items = buildDrawList(world, [], () => false, t, null, { frame: f, seatOf: noSeat }, [], events);
        expect(items.filter((i) => i.t === "cable" || i.t === "packet" || i.t === "wifi"), `${t}`).toEqual([]);
      }
      expect(buildDrawList(world, [], () => false, 3.1, null, null, [], events).some((i) => i.t === "cable" || i.t === "packet")).toBe(false);
    });

    it("reads the racks and gauges, and captions the gauges and the boards with this frame's figures", () => {
      const items = buildDrawList(world, [], () => false, 0, null, { frame: villageFrame(), seatOf: noSeat });
      const racks = props(items).filter((i) => i.prop.kind === "rack");
      expect(racks[0].reading).toEqual(rackReading(frame().memory, 0));
      const gauges = props(items).filter((i) => i.prop.kind === "gauge");
      expect(gauges.map((g) => g.reading)).toEqual([
        { kind: "gauge", meter: { fill: 0.41, tone: "ok" } },
        { kind: "gauge", meter: null },
      ]);
      const civic = labels(items).filter((l) => l.tone === "civic").map((l) => l.text);
      expect(civic).toEqual(["Seats 3/200", "Memory 2.0 GB", "Usage 41% · ?"]);
      const g = labels(items).filter((l) => l.tone === "gauge");
      expect(g.map((l) => l.text)).toEqual(["5h 41%", "week ?"]);
      const g0 = gauges[0].prop;
      expect([g[0].x, g[0].y]).toEqual([(g0.col + 1) * TILE, (g0.row - 1) * TILE - 6]);
      // Project houses keep their wooden board.
      expect(labels(items).filter((l) => l.tone === "house").map((l) => l.text)).toEqual(["proj"]);
    });

    it("without a capacity frame: an unread hall, unknown racks and gauges, boards that only name the building, nobody seated", () => {
      const items = buildDrawList(world, [], () => true, 0);
      expect(props(items).filter((i) => i.prop.capacity === "seats").map((i) => [i.prop.kind, i.on, i.reading])).toStrictEqual([["hall", false, { kind: "hall", hall: null }]]);
      expect(props(items).find((i) => i.prop.kind === "rack")!.reading).toEqual({ kind: "rack", agents: 0, other: 0, known: false });
      expect(props(items).find((i) => i.prop.kind === "gauge")!.reading).toEqual({ kind: "gauge", meter: null });
      expect(labels(items).filter((l) => l.tone === "civic").map((l) => l.text)).toEqual(["Seats", "Memory", "Usage"]);
      expect(labels(items).some((l) => l.tone === "gauge")).toBe(false);
      expect(people(items)).toEqual([]);
      // Plain props carry no reading.
      expect(props(items).filter((i) => !i.prop.capacity).every((i) => !("reading" in i))).toBe(true);
    });

    it("a frame but no Seats house (a world built without capacity): no hall, nobody drawn", () => {
      const plain = buildWorld(planHouses([agent("a")]));
      const items = buildDrawList(plain, [], () => false, 0, null, { frame: villageFrame(), seatOf: noSeat });
      expect(hallItems(items)).toEqual([]);
      expect(people(items)).toEqual([]);
    });

    it("draws a context bar over the desk of every agent with a reading that holds a seat — after the scene, before bubbles", () => {
      const seat: Seat = { id: "s", houseKey: "proj", col: 6, row: 9, facing: "up", pcId: null };
      const ctx = { a: { fill: 0.6, tone: "warn" as const }, gone: { fill: 0.1, tone: "ok" as const } };
      const waiting = cv("w", { bubble: "waiting", bubbleAlpha: 1 });
      const items = buildDrawList(world, [waiting], () => false, 0, null, {
        frame: villageFrame({ context: ctx }),
        seatOf: (k) => (k === "a" ? seat : null),
      });
      const meters = items.filter((i) => i.t === "meter");
      expect(meters).toEqual([{ t: "meter", ...meterSpot(seat), w: METER_W, fill: 0.6, tone: "warn" }]);
      const at = items.indexOf(meters[0]);
      expect(items.findIndex((i) => i.t === "bubble")).toBeGreaterThan(at);
      expect(items.slice(0, at).some((i) => i.t === "meter" || i.t === "bubble" || i.t === "label")).toBe(false);
    });
  });

  describe("in the city", () => {
    const roster = planCity([agent("a", { origin: "ide", activity: "typing" })]);
    const world = buildCityWorld(roster.plans, { seats: 4 });

    it("signs the HQ as a civic board, plates its floors, and boards the lounge on the soil above its back wall — centred", () => {
      const items = buildDrawList(world, [], () => false, 0, null, { frame: frame(), seatOf: noSeat });
      const civic = labels(items).filter((l) => l.tone === "civic");
      // The HQ's sign, its two floors (ground first), then the lounge under the street and the Seats hall under that.
      expect(civic.map((l) => l.text)).toEqual(["Capacity HQ", "Memory 2.0 GB", "Usage 41% · ?", "Lounge 2/4", "Seats 3/200"]);
      const lounge = world.houses.find((h) => h.capacity === "lounge")!;
      const board = civic[3];
      expect(board.x).toBe((lounge.col + lounge.w / 2) * TILE);
      // Centred on the lift (the HQ's door column) and on the soil row: under the far sidewalk, over the back wall.
      expect(board.x).toBe((world.city!.lounge!.lift.col + 0.5) * TILE);
      expect(board.y).toBe((lounge.row - 1) * TILE + TILE / 2);
      expect(board.y).toBeGreaterThan((world.city!.street + 4) * TILE);
      expect(board.y).toBeLessThan(lounge.row * TILE);
      // The project's floor keeps its plain plate.
      expect(labels(items).filter((l) => l.tone === "floor")).toHaveLength(1);
      // Without a frame the boards only name the buildings.
      const bare = labels(buildDrawList(world, [], () => false, 0)).filter((l) => l.tone === "civic");
      expect(bare.map((l) => l.text)).toEqual(["Capacity HQ", "Memory", "Usage", "Lounge", "Seats"]);
    });

    it("boards the Seats hall on the row of earth between the lounge's floor wall and the hall's top wall, centred on the lift — each board its own caption", () => {
      const lounge = world.houses.find((h) => h.capacity === "lounge")!;
      const lift = world.city!.lounge!.lift.col;
      // The lounge's board reads `captions.lounge`, the hall's `captions.seats` — never each other's.
      const f = frame({ captions: { seats: "S-board", memory: "M-board", usage: "U-board", lounge: "L-board" } });
      const civic = labels(buildDrawList(world, [], () => false, 0, null, { frame: f, seatOf: noSeat })).filter((l) => l.tone === "civic");
      expect(civic.map((l) => l.text)).toEqual(["Capacity HQ", "M-board", "U-board", "L-board", "S-board"]);
      const hallBoard = civic[4];
      // The lounge's floor wall is the row under its room; the earth row under that holds the hall's board.
      const earth = lounge.row + lounge.h + 1;
      expect([hallBoard.x, hallBoard.y]).toEqual([(lift + 0.5) * TILE, earth * TILE + 8]);
      expect(world.tiles[earth * world.cols + lift]).toBe("sky");
      expect(world.tiles[(earth + 1) * world.cols + lift]).toBe("wall");
      // An unread hall's board says so; the lounge's still counts its benches.
      const unread = frame({ hall: { cells: null, usedPct: null, tone: "unknown" }, captions: { seats: "Seats ?", memory: "", usage: "", lounge: "Lounge 2/4" } });
      const texts = labels(buildDrawList(world, [], () => false, 0, null, { frame: unread, seatOf: noSeat })).filter((l) => l.tone === "civic").map((l) => l.text);
      expect(texts.slice(3)).toEqual(["Lounge 2/4", "Seats ?"]);
    });

    it("hands the City's hall prop the frame's own hall as its reading — the very object, dark, frame 0 — and { hall: null } before the first frame", () => {
      const lift = world.city!.lounge!.lift.col;
      const items = buildDrawList(world, [], () => true, 0.7, null, { frame: frame(), seatOf: noSeat });
      const halls = props(items).filter((i) => i.prop.kind === "hall");
      expect(halls.map((i) => [i.prop.id, i.prop.col, i.prop.w, i.prop.h])).toEqual([["cap/seats:hall", lift - 6, 13, 9]]);
      const [hall] = halls;
      expect(hall.reading).toStrictEqual({ kind: "hall", hall: HALL });
      expect((hall.reading as { hall: HallFrame }).hall).toBe(HALL); // nothing copied per frame
      expect([hall.on, hall.frame]).toEqual([false, 0]);
      // An unknown hall is passed on as it is; no frame yet: no reading (null, never undefined).
      const unknown: HallFrame = { cells: null, usedPct: null, tone: "unknown" };
      const read = (cap: Parameters<typeof buildDrawList>[5]) => props(buildDrawList(world, [], () => true, 0, null, cap)).find((i) => i.prop.kind === "hall")!.reading;
      expect(read({ frame: frame({ hall: unknown }), seatOf: noSeat })).toStrictEqual({ kind: "hall", hall: { cells: null, usedPct: null, tone: "unknown" } });
      expect(read(null)).toStrictEqual({ kind: "hall", hall: null });
    });

    it("a city draws no cable or packet under the street (neither the lounge nor the Seats hall has a LAN) — one hall, no PC there, no stand-in anywhere", () => {
      const f = frame({ desks: [holder("a"), { key: "s", activity: "typing", parentKey: "a" }, null, null] });
      const events: LanEvent[] = [
        { kind: "task", key: "s", at: 3 },
        { kind: "tool", key: "a", at: 3 },
      ];
      const items = buildDrawList(world, [], () => false, 3.1, null, { frame: f, seatOf: noSeat }, [], events);
      expect(items.some((i) => i.t === "cable" || i.t === "packet")).toBe(false);
      expect(props(items).filter((i) => i.prop.kind === "hall").map((i) => i.prop.id)).toEqual(["cap/seats:hall"]);
      expect(props(items).some((i) => i.prop.kind === "pc" && i.prop.capacity)).toBe(false);
      expect(people(items)).toEqual([]);
    });
    it("puts the leader's context bar on the front of its big desk", () => {
      const sim = new VillageSim({ seed: 1, stayPut: true });
      sim.setWorld(world);
      sim.setAgents(roster.agents);
      // As the view hands it: who sits where (a city with a lounge draws a bar only over a desk its agent sits at).
      const items = buildDrawList(
        world,
        sim.characters(),
        (id) => sim.pcOn(id),
        0,
        null,
        { frame: frame({ context: { a: { fill: 0.9, tone: "danger" } } }), seatOf: (k) => sim.seatFor(k) },
        sim.seating(),
      );
      const lead = sim.seatFor("a")!;
      expect(items.filter((i) => i.t === "meter")).toEqual([{ t: "meter", ...meterSpot(lead), w: METER_W, fill: 0.9, tone: "danger" }]);
      expect(meterSpot(lead).y).toBe((lead.row + 2) * TILE - 5);
    });
  });
});

describe("a project room's LAN — the team cabled to its router, the boss on Wi-Fi (engine/teamLan.ts)", () => {
  const world = buildWorld(planHouses([agent("a"), agent("s", { parentKey: "a" })]));
  const boss = world.seats.find((x) => x.houseKey === "proj" && !x.forSub)!;
  const team = world.seats.find((x) => x.houseKey === "proj" && x.forSub)!;
  const seated = (child: VillageAgent["activity"]) => [
    { key: "a", parentKey: null, activity: "idle" as const, seatId: boss.id },
    { key: "s", parentKey: "a", activity: child, seatId: team.id },
  ];
  const router = (items: DrawItem[]) =>
    items.find((i): i is Extract<DrawItem, { t: "prop" }> => i.t === "prop" && i.prop.kind === "router")!;

  it("draws the room's cables with the tiles, under everything — with or without anyone seated", () => {
    const runs = teamLanWiring(world).flatMap((r) => r.runs);
    expect(runs.length).toBeGreaterThan(0);
    for (const s of [[], seated("typing")]) {
      const items = buildDrawList(world, [], () => false, 0, null, null, s);
      expect(items.filter((i) => i.t === "cable")).toEqual(runs.map((r) => ({ t: "cable", ...r })));
      const first = items.findIndex((i) => i.t === "cable");
      expect(items.slice(0, first).every((i) => i.t === "tile")).toBe(true);
    }
  });

  const room = teamLanWiring(world)[0];
  const antenna = room.antennas[boss.id];
  const wifi = (items: DrawItem[]) => items.filter((i) => i.t === "wifi");
  const packets = (items: DrawItem[]) => items.filter((i) => i.t === "packet");
  /** The boss hands its sub-agent a task at t = 1. */
  const task: LanEvent[] = [{ kind: "task", key: "s", at: 1 }];

  it("while the boss's task is in the air: Wi-Fi rings at the router and the boss, then the packet, after the scene and before the bars; the router blinks", () => {
    const s = seated("typing");
    const t = 1.1; // 4.8 px into the hop
    const items = buildDrawList(world, [cv("x")], () => false, t, null, null, s, task);
    expect(wifi(items).map((w) => (w.t === "wifi" ? [w.x, w.y, w.hue] : null))).toEqual([
      [room.hub.x, room.hub.y, hashString("a") % 360],
      [antenna.x, antenna.y, hashString("a") % 360],
    ]);
    const tr = teamLanTraffic(teamLanWiring(world), s, task, t);
    expect(wifi(items)).toEqual(tr.wifi.map((p) => ({ t: "wifi", ...p })));
    expect(packets(items)).toEqual(tr.packets.map((p) => ({ t: "packet", ...p })));
    expect(packets(items)).toHaveLength(1);
    const kinds = items.map((i) => i.t);
    expect(kinds.indexOf("wifi")).toBeGreaterThan(Math.max(kinds.lastIndexOf("character"), kinds.lastIndexOf("prop")));
    expect(kinds.indexOf("packet")).toBeGreaterThan(kinds.lastIndexOf("wifi"));
    const r = router(items);
    expect([r.on, r.frame]).toEqual([true, Math.floor(t / PROP_FRAME_SEC) % 3]);
  });

  it("once the task is down on the cable: its packet but no rings — and the router still blinks until it lands", () => {
    const s = seated("typing");
    const moments = Array.from({ length: 300 }, (_, k) => 1 + k / 100).map((t) => ({ t, items: buildDrawList(world, [], () => false, t, null, null, s, task) }));
    const cabled = moments.filter((m) => packets(m.items).length === 1 && wifi(m.items).length === 0);
    expect(cabled.length).toBeGreaterThan(10);
    for (const m of cabled) expect(router(m.items).on, `${m.t}`).toBe(true);
    // Landed: dark again.
    const landed = moments.filter((m) => packets(m.items).length === 0);
    expect(landed.length).toBeGreaterThan(10);
    for (const m of landed) expect([router(m.items).on, wifi(m.items)], `${m.t}`).toEqual([false, []]);
  });

  it("no event: no rings, no packets, a dark router — even while the sub-agent types; nobody seated: the same", () => {
    for (const s of [seated("typing"), seated("idle"), []])
      for (const t of [0, 1.3, 4.2]) {
        const items = buildDrawList(world, [], () => false, t, null, null, s);
        expect(items.some((i) => i.t === "wifi" || i.t === "packet")).toBe(false);
        expect([router(items).on, router(items).frame]).toEqual([false, 0]);
      }
    // An event for someone not seated here moves nothing either.
    const items = buildDrawList(world, [], () => false, 1.1, null, null, [], task);
    expect([items.some((i) => i.t === "wifi" || i.t === "packet"), router(items).on]).toEqual([false, false]);
  });

  it("one tool call, one LAN: the project room carries its round-trip — the Seats house, now the hall, carries nothing", () => {
    const both = buildWorld(planHouses([agent("a"), agent("s", { parentKey: "a" })]), { seats: 4 });
    const bossSeat = both.seats.find((x) => x.houseKey === "proj" && !x.forSub)!;
    const teamSeat = both.seats.find((x) => x.houseKey === "proj" && x.forSub)!;
    const s = [
      { key: "a", parentKey: null, activity: "typing" as const, seatId: bossSeat.id },
      { key: "s", parentKey: "a", activity: "typing" as const, seatId: teamSeat.id },
    ];
    const f: CapacityFrame = {
      desks: [],
      hall: { cells: null, usedPct: null, tone: "unknown" },
      memory: { agents: null, used: null },
      usage: { session: null, week: null },
      context: {},
      captions: { seats: "", memory: "", usage: "", lounge: "" },
      gaugeCaptions: ["", ""],
    };
    const items = buildDrawList(both, [], () => false, 0, null, { frame: f, seatOf: () => null }, s, [{ kind: "tool", key: "s", at: 0 }]);
    const laptop = both.props.find((p) => p.id === teamSeat.pcId)!;
    expect(laptop.facing).toBe("down"); // the precondition: a far-side laptop, so its art (and its port) is not lifted
    // One packet, at the sub-agent's laptop port (its tile's centre), in a's hue.
    expect(packets(items)).toEqual([{ t: "packet", x: laptop.col * TILE + 8, y: laptop.row * TILE + 8, kind: "uplink", hue: hashString("a") % 360 }]);
    // The team room's cables are all there is, and they all lie in the project house — none in the Seats house.
    const cables = items.filter((i): i is Extract<DrawItem, { t: "cable" }> => i.t === "cable");
    expect(cables).toEqual(teamLanWiring(both).flatMap((r) => r.runs).map((r) => ({ t: "cable", ...r })));
    expect(cables.length).toBeGreaterThan(0);
    const inside = (h: (typeof both.houses)[number], x: number, y: number) =>
      x >= (h.col - 1) * TILE && x <= (h.col + h.w + 1) * TILE && y >= (h.row - 1) * TILE && y <= (h.doorRow + 1) * TILE;
    const proj = both.houses.find((h) => h.key === "proj")!;
    const seatsHouse = both.houses.find((h) => h.capacity === "seats")!;
    for (const c of cables) {
      expect(inside(proj, c.x0, c.y0) && inside(proj, c.x1, c.y1), JSON.stringify(c)).toBe(true);
      expect(inside(seatsHouse, c.x0, c.y0) || inside(seatsHouse, c.x1, c.y1), JSON.stringify(c)).toBe(false);
    }
    // Only the project room's router blinks; no prop in the village is a switch.
    const lit = items.filter((i): i is Extract<DrawItem, { t: "prop" }> => i.t === "prop" && i.on && i.prop.kind !== "pc" && i.prop.kind !== "laptop" && i.prop.kind !== "fountain" && i.prop.kind !== "campfire");
    expect(lit.map((i) => i.prop.id)).toEqual(["proj:router"]);
    expect(items.some((i) => i.t === "prop" && (i.prop.kind as string) === "switch")).toBe(false);
  });
});

describe("the City's lounge — its walls, its dressing, its waiters", () => {
  const roster = planCity([agent("a", { folder: "gazelle", origin: "ide", activity: "typing" })]);
  const world = buildCityWorld(roster.plans, { seats: 64 });
  const lounge = world.houses.find((h) => h.capacity === "lounge")!;
  const lift = world.city!.lounge!.lift.col;
  const holder = (key: string, activity: VillageAgent["activity"] = "typing") => ({ key, activity, parentKey: null });
  const frameOf = (desks: CapacityFrame["desks"]): CapacityFrame => ({
    desks,
    hall: { cells: null, usedPct: null, tone: "unknown" },
    memory: { agents: null, used: null },
    usage: { session: null, week: null },
    context: {},
    captions: { seats: "Seats ?", memory: "Memory ?", usage: "Usage ? · ?", lounge: "Lounge" },
    gaugeCaptions: ["5h ?", "week ?"],
  });
  const free = (n: number): CapacityFrame["desks"] => Array.from({ length: n }, () => null);
  const benches = (items: DrawItem[]) =>
    items.filter((i): i is Extract<DrawItem, { t: "prop" }> => i.t === "prop" && i.prop.kind === "bench").sort((a, b) => a.prop.index! - b.prop.index!);
  /** Inside the lounge's outer walls (walls included). */
  const inLounge = (c: number, r: number) => c >= lounge.col - 1 && c <= lounge.col + lounge.w && r >= lounge.row && r <= lounge.row + lounge.h;

  it("walls the lounge in a look of its own — every wall its hue, its bottom wall the only FRONT one, its hall one floor — the buildings keep theirs", () => {
    expect(HOUSE_HUES as readonly number[]).not.toContain(LOUNGE_STYLE.hue);
    expect(HOUSE_FLOORS as readonly number[]).not.toContain(LOUNGE_STYLE.floor);
    const list = buildDrawList(world, [], never, 0);
    const walls = list.filter((i): i is Extract<DrawItem, { t: "wall" }> => i.t === "wall" && inLounge(i.col, i.row));
    // Its back wall, both sides and its bottom wall.
    expect(walls).toHaveLength(2 * (lounge.w + 2) + 2 * (lounge.h - 1));
    for (const w of walls) {
      expect(w.hue).toBe(LOUNGE_STYLE.hue);
      expect(w.front === true).toBe(w.row === lounge.row + lounge.h);
    }
    const floors = list.filter((i): i is Extract<DrawItem, { t: "tile" }> => i.t === "tile" && i.kind === "floor" && inLounge(i.col, i.row));
    expect(floors).toHaveLength(lounge.w * (lounge.h - 1));
    for (const f of floors) expect(f.variant).toBe(LOUNGE_STYLE.floor);
    // The buildings' looks are picked from their keys, as before the lounge.
    const styles = houseStyles(world.city!.buildings.map((b) => b.key));
    for (const b of world.city!.buildings) {
      const inside = (i: DrawItem) => i.t === "wall" && i.col >= b.col && i.col < b.col + b.w && i.row >= b.row && i.row < b.row + b.h;
      for (const w of list.filter(inside)) expect((w as Extract<DrawItem, { t: "wall" }>).hue).toBe(styles.get(b.key)!.hue);
    }
  });

  it("walls the Seats hall under the lounge in the lounge's look — its bottom wall the only FRONT one (one tile tall), so its last row of seats is never covered", () => {
    const hall = world.houses.find((h) => h.capacity === "seats")!;
    const list = buildDrawList(world, [], never, 0);
    const inHall = (c: number, r: number) => c >= hall.col - 1 && c <= hall.col + hall.w && r >= hall.row && r <= hall.row + hall.h;
    const walls = list.filter((i): i is Extract<DrawItem, { t: "wall" }> => i.t === "wall" && inHall(i.col, i.row));
    // 13 wide, 9 rows of hall: the top wall and the floor wall are 15 pieces each, the sides 9 each.
    expect(walls).toHaveLength(15 + 15 + 9 + 9);
    for (const w of walls) {
      expect(w.hue).toBe(188);
      expect(w.front === true).toBe(w.row === hall.row + 10);
    }
    // The floor wall row is the hall prop's bottom edge: a front piece is one tile tall, so the prop's
    // last row (its tenth row of seats) keeps every pixel.
    const prop = world.props.find((p) => p.kind === "hall" && p.capacity === "seats")!;
    expect(prop.row + prop.h).toBe(hall.row + 10);
  });

  it("dresses the lounge once per World: one `lounge` item after its back wall's pieces, before its side walls below, its benches and anyone in it", () => {
    const sim = new VillageSim({ seed: 1, stayPut: true });
    sim.setWorld(world);
    sim.setAgents(roster.agents);
    const list = buildDrawList(world, sim.characters(), never, 0, null, { frame: frameOf(free(64)), seatOf: noSeatOf });
    const dressing = list.filter((i) => i.t === "lounge");
    expect(dressing).toEqual([{ t: "lounge", col: lounge.col, row: lounge.row, w: lounge.w, benchRows: 4, lift }]);
    const at = list.indexOf(dressing[0]);
    const idx = (pred: (i: DrawItem) => boolean) => list.map((i, k) => (pred(i) ? k : -1)).filter((k) => k >= 0);
    const back = idx((i) => i.t === "wall" && inLounge(i.col, i.row) && i.row === lounge.row);
    const below = idx((i) => i.t === "wall" && inLounge(i.col, i.row) && i.row > lounge.row);
    expect(back.length).toBe(lounge.w + 2);
    expect(Math.max(...back)).toBeLessThan(at);
    expect(Math.min(...below)).toBeGreaterThan(at);
    expect(Math.min(...idx((i) => i.t === "prop" && i.prop.kind === "bench"))).toBeGreaterThan(at);
    // Built with the World, not per frame: the same item every frame.
    expect(buildDrawList(world, [], never, 9).find((i) => i.t === "lounge")).toBe(dressing[0]);
    // More bench rows when the lounge grows; none without a lounge (a city built without capacity, a village).
    expect(buildDrawList(buildCityWorld(roster.plans, { seats: 65 }), [], never, 0).find((i) => i.t === "lounge")).toMatchObject({ benchRows: 5 });
    expect(buildDrawList(buildCityWorld(roster.plans), [], never, 0).some((i) => i.t === "lounge")).toBe(false);
    expect(buildDrawList(buildWorld(planHouses([agent("a")]), { seats: 4 }), [], never, 0).some((i) => i.t === "lounge")).toBe(false);
  });

  it("a waiter on every FREE bench (no holder, no sim character's claim) — a held bench is EMPTY, its agent away at work", () => {
    const desks = free(64);
    desks[0] = holder("a");
    desks[2] = holder("b", "idle");
    const t = 7.25;
    const items = buildDrawList(world, [], never, t, null, { frame: frameOf(desks), seatOf: noSeatOf, claims: new Set([3, 40]) });
    const seats = benches(items);
    expect(seats.map((b) => b.prop.index)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    const waiting = seats.filter((b) => b.reading).map((b) => b.prop.index);
    expect(waiting).toEqual(Array.from({ length: 64 }, (_, i) => i).filter((i) => ![0, 2, 3, 40].includes(i)));
    for (const b of seats) {
      const i = b.prop.index!;
      if (b.reading) expect(b.reading).toEqual({ kind: "waiter", ...waiterLook(i), pose: waiterPose(i, t) });
      else expect("reading" in b).toBe(false);
      expect([b.on, b.frame]).toEqual([false, 0]);
    }
    // The waiters are the benches' own art: no character, so never hit-tested, tagged or bubbled.
    expect(items.some((i) => i.t === "character" || i.t === "bubble")).toBe(false);
    expect(labels(items).some((l) => l.tone === "agent")).toBe(false);
  });

  it("no claims: every free bench waits; no capacity frame yet: nobody is known to be anywhere — every bench empty", () => {
    const desks = free(64);
    desks[5] = holder("a");
    const open = benches(buildDrawList(world, [], never, 0, null, { frame: frameOf(desks), seatOf: noSeatOf }));
    expect(open.filter((b) => b.reading).length).toBe(63);
    expect(benches(buildDrawList(world, [], never, 0)).some((b) => b.reading)).toBe(false);
  });

  it("waiterLook: the same per bench every time — one of the six sheets, one of WAITER_HUES — and the hall mixed", () => {
    const looks = Array.from({ length: 64 }, (_, i) => waiterLook(i));
    expect(looks).toEqual(Array.from({ length: 64 }, (_, i) => waiterLook(i)));
    for (const l of looks) {
      expect(l.palette).toBeGreaterThanOrEqual(0);
      expect(l.palette).toBeLessThan(6);
      expect(WAITER_HUES as readonly number[]).toContain(l.hueShift);
    }
    expect(new Set(looks.map((l) => l.palette)).size).toBe(6);
    expect(new Set(looks.map((l) => l.hueShift)).size).toBe(WAITER_HUES.length);
    // Few hues, none a big shift (a big one turns a face green).
    expect(WAITER_HUES.every((h) => Math.min(h, 360 - h) <= 15)).toBe(true);
  });

  it("waiterPose: still most of the time; a shift only at the end of a bench's own routine; one bench in READER_EVERY reads half of it; never in step", () => {
    const DT = 0.05;
    const N = 64;
    const span = 3 * (ROUTINE_MIN + ROUTINE_SPREAD);
    const steps = Math.round(span / DT);
    const poses = Array.from({ length: N }, (_, i) => Array.from({ length: steps }, (_, k) => waiterPose(i, k * DT)));
    let readers = 0;
    for (let i = 0; i < N; i++) {
      const p = poses[i];
      // Each shift is one run of ~SHIFT_SEC, and runs start a routine apart (ROUTINE_MIN..+SPREAD−1 s).
      const starts = p.map((x, k) => (x === "shift" && (k === 0 || p[k - 1] !== "shift") ? k * DT : -1)).filter((x) => x > 0);
      expect(starts.length, `bench ${i}`).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < starts.length; k++) {
        const gap = starts[k] - starts[k - 1];
        expect(gap).toBeGreaterThanOrEqual(ROUTINE_MIN - DT);
        expect(gap).toBeLessThanOrEqual(ROUTINE_MIN + ROUTINE_SPREAD - 1 + DT);
      }
      const shift = p.filter((x) => x === "shift").length * DT;
      expect(shift / (starts.length + 1)).toBeLessThanOrEqual(SHIFT_SEC + DT);
      const read = p.filter((x) => x === "read").length / steps;
      if (read > 0) {
        readers++;
        expect(read).toBeGreaterThan(0.4);
        expect(read).toBeLessThan(0.6);
      }
      expect(p.filter((x) => x === "still").length / steps).toBeGreaterThan(read > 0 ? 0.35 : 0.9);
    }
    // About one in READER_EVERY (a hash, so not exactly), and never the whole hall at once.
    expect(readers).toBeGreaterThan(N / READER_EVERY / 2);
    expect(readers).toBeLessThan((N / READER_EVERY) * 2);
    for (let k = 0; k < steps; k++) expect(poses.filter((p) => p[k] === "shift").length).toBeLessThan(N / 4);
    // Deterministic in (bench, time).
    expect(waiterPose(9, 123.4)).toBe(waiterPose(9, 123.4));
  });
});

const noSeatOf = () => null;
const labels = (items: DrawItem[]) => items.filter((i): i is Extract<DrawItem, { t: "label" }> => i.t === "label");

describe("the lifts (busy agents ride an elevator) — shafts and cars", () => {
  const roster = planCity([
    agent("g", { folder: "gazelle", origin: "ide", activity: "typing" }),
    agent("g2", { folder: "gazelle", origin: "ide", activity: "typing" }),
    ...Array.from({ length: 3 }, (_, i) => agent(`g.s${i}`, { parentKey: "g", activity: "typing" })),
    agent("solo", { folder: "solo", origin: "ide" }),
  ]);
  const world = buildCityWorld(roster.plans, { seats: 32 });
  const city = world.city!;
  const gazelle = city.buildings.find((b) => b.key === "gazelle")!;
  const shafts = (items: readonly DrawItem[]) => items.filter((i): i is Extract<DrawItem, { t: "shaft" }> => i.t === "shaft");
  const tileAt = (c: number, r: number) => world.tiles[r * world.cols + c];

  it("a shaft per lift — each building with a team, and the lounge — none for a building without a lift, none in the village", () => {
    const all = liftShafts(world);
    const lift = gazelle.lift!;
    const down = city.lounge!.lift;
    expect(city.buildings.find((b) => b.key === "solo")!.lift).toBeUndefined();
    expect(all).toEqual([
      // From the row above its top stop (a car is two tiles tall) to the row above its street door;
      // a landing door at every stop but the street door.
      { t: "shaft", col: lift.col, top: lift.top - 1, bottom: lift.bottom - 1, stops: lift.stops.slice(0, -1) },
      // From the soil under the kiosk down to the last aisle; a landing door at every aisle.
      { t: "shaft", col: down.col, top: down.top + 1, bottom: down.bottom, stops: down.stops.slice(1) },
    ]);
    expect(liftShafts(world)).toBe(all); // once per World
    expect(liftShafts(buildWorld(planHouses([agent("v")])))).toEqual([]);
    expect(liftShafts(buildCityWorld(roster.plans))).toHaveLength(1); // no lounge, no lounge shaft
  });

  it("runs over the back walls and slabs between floors, never over the street door or the far sidewalk's kiosk", () => {
    const [building, lounge] = liftShafts(world) as Extract<DrawItem, { t: "shaft" }>[];
    const front = gazelle.row + gazelle.h - 1;
    expect(building.bottom).toBe(front - 1);
    // The upper floor's back wall is crossed: a wall tile in the shaft's column, inside its span.
    const walls = [];
    for (let r = building.top; r <= building.bottom; r++) if (tileAt(building.col, r) === "wall") walls.push(r);
    expect(walls.length).toBeGreaterThan(0);
    const kiosk = world.props.find((p) => p.kind === "lift")!;
    expect([lounge.col, lounge.top]).toEqual([kiosk.col, kiosk.row + 1]);
    // And the lounge's: through its back wall, down to the aisle above its floor wall.
    const hall = world.houses.find((h) => h.key === city.lounge!.key)!;
    expect(tileAt(lounge.col, hall.row)).toBe("wall");
    expect(lounge.top).toBeLessThan(hall.row);
    expect(tileAt(lounge.col, lounge.bottom + 1)).toBe("wall");
  });

  it("draws the shafts after the scene, then every rider inside its car (back, rider, front), front to back — riders out of the scene, their bubbles kept", () => {
    const walker = cv("walker", { x: 200, y: (city.street + 1) * TILE });
    const high = cv("high", { x: gazelle.lift!.col * TILE + 8, y: 100, riding: true, bubble: "done", bubbleAlpha: 1 });
    const low = cv("low", { x: city.lounge!.lift.col * TILE + 8, y: (city.lounge!.lift.bottom + 1) * TILE, riding: true });
    const list = buildDrawList(world, [low, walker, high], never, 0);
    const at = (pred: (i: DrawItem) => boolean) => list.findIndex(pred);
    const lastScene = list.reduce((n, item, i) => (item.t === "wall" || item.t === "prop" || (item.t === "character" && item.c === walker) ? i : n), -1);
    const firstShaft = at((i) => i.t === "shaft");
    expect(firstShaft).toBe(lastScene + 1);
    expect(shafts(list)).toEqual(liftShafts(world));
    const after = list.slice(firstShaft + 2, firstShaft + 8);
    expect(after).toEqual([
      { t: "car", x: high.x, y: high.y, part: "back" },
      { t: "character", c: high },
      { t: "car", x: high.x, y: high.y, part: "front" },
      { t: "car", x: low.x, y: low.y, part: "back" },
      { t: "character", c: low },
      { t: "car", x: low.x, y: low.y, part: "front" },
    ]);
    // Each rider is drawn once; the walker stays in the scene.
    expect(list.filter((i) => i.t === "character").map((i) => (i as { c: CharacterView }).c.key)).toEqual(["walker", "high", "low"]);
    expect(list.filter((i) => i.t === "bubble").map((i) => (i as { c: CharacterView }).c.key)).toEqual(["high"]);
    // A hovered rider is still tagged.
    expect(buildDrawList(world, [high], never, 0, "high").some((i) => i.t === "label" && i.tone === "agent" && i.text === "high")).toBe(true);
  });

  it("no lift, no shaft and no car: the village draws its characters in the scene as before", () => {
    const village = buildWorld(planHouses([agent("v")]));
    const list = buildDrawList(village, [cv("v")], never, 0);
    expect(list.some((i) => i.t === "shaft" || i.t === "car")).toBe(false);
    expect(list.filter((i) => i.t === "character")).toHaveLength(1);
  });
});

describe("context bars and the city's commuters (a bar hangs over a desk only while its agent sits there)", () => {
  /** A capacity frame with context readings for `keys` — only what the bars read. */
  const capOf = (keys: string[], seatOf: (k: string) => Seat | null) => ({
    frame: {
      desks: [],
      hall: { cells: null, usedPct: null, tone: "unknown" as const },
      memory: { agents: null, used: null },
      usage: { session: null, week: null },
      context: Object.fromEntries(keys.map((k) => [k, { fill: 0.5, tone: "ok" as const }])),
      captions: { seats: "Seats", memory: "Memory", usage: "Usage", lounge: "Lounge" },
      gaugeCaptions: ["", ""] as const,
    },
    seatOf,
  });
  const meters = (items: DrawItem[]) => items.filter((i): i is Extract<DrawItem, { t: "meter" }> => i.t === "meter");
  const city = (seats?: number) => {
    const roster = planCity([
      agent("g", { folder: "gazelle", origin: "ide", activity: "typing" }),
      agent("g.s0", { parentKey: "g", origin: "ide", activity: "typing" }),
    ]);
    const world = seats === undefined ? buildCityWorld(roster.plans) : buildCityWorld(roster.plans, { seats });
    const sim = new VillageSim({ seed: 1, stayPut: true });
    sim.setWorld(world);
    sim.setAgents(roster.agents);
    const draw = () => buildDrawList(world, sim.characters(), (id) => sim.pcOn(id), sim.time, null, capOf(["g", "g.s0"], (k) => sim.seatFor(k)), sim.seating());
    return { sim, draw };
  };

  it("in a city with a lounge: no bar over the desk of a sub-agent on its bench or on its way — its bar appears as it sits down", () => {
    const { sim, draw } = city(16);
    const desk = sim.seatFor("g.s0")!;
    const lead = sim.seatFor("g")!;
    // On its bench: only the leader's bar.
    expect(meters(draw()).map((m) => [m.x, m.y])).toEqual([[meterSpot(lead).x, meterSpot(lead).y]]);
    // On its way: still none over its desk.
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    expect(sim.seating().map((a) => a.key)).toEqual(["g"]);
    expect(meters(draw())).toHaveLength(1);
    // Sitting at its desk: its bar is over it.
    for (let i = 0; i < 150 && !sim.seating().some((a) => a.key === "g.s0"); i++) sim.tick(0.1);
    expect(meters(draw()).map((m) => [m.x, m.y])).toEqual([
      [meterSpot(lead).x, meterSpot(lead).y],
      [meterSpot(desk).x, meterSpot(desk).y],
    ]);
  });

  it("without a lounge nothing changes: a bar hangs over the agent's desk whether or not it sits there (a city without capacity, the village)", () => {
    const { draw } = city();
    expect(meters(draw())).toHaveLength(2); // both at their desks from the start
    // The village: a root out for a stroll keeps its bar on its desk.
    const world = buildWorld(planHouses([agent("w", { activity: "idle" })]));
    const sim = new VillageSim({ seed: 1 });
    sim.setWorld(world);
    sim.setAgents([agent("w", { activity: "idle" })]);
    for (let i = 0; i < 600 && sim.characters()[0].seated; i++) sim.tick(0.1);
    expect(sim.characters()[0].seated).toBe(false);
    const seat = sim.seatFor("w")!;
    const items = buildDrawList(world, sim.characters(), never, sim.time, null, capOf(["w"], (k) => sim.seatFor(k)), sim.seating());
    expect(sim.seating()).toEqual([]);
    expect(meters(items).map((m) => [m.x, m.y])).toEqual([[meterSpot(seat).x, meterSpot(seat).y]]);
  });
});
