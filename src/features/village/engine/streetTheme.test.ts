import { describe, expect, it } from "vitest";

import type { Prop, TileKind, VillageAgent, World } from "../villageTypes";
import { buildCityWorld, planCity } from "./city";
import { findPath } from "./path";
import { artBox, crossingOf, dressCity, dressVillage, dressWorld, themeFor } from "./streetTheme";
import { buildWorld, isBlockingProp, planHouses, walkGrid } from "./world";

const TOKYO = "Asia/Tokyo";

function agent(key: string, folder: string, over: Partial<VillageAgent> = {}): VillageAgent {
  return {
    key,
    parentKey: null,
    origin: "ide",
    title: key,
    folder,
    activity: "idle",
    tool: null,
    ideAgentId: null,
    lastActivityAt: null,
    ...over,
  };
}

/** `n` root agents, each in its own folder, the first `subs` of them with a sub-agent. */
function roster(n: number, subs = 0): VillageAgent[] {
  const out: VillageAgent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(agent(`r${i}`, `proj-${String.fromCharCode(97 + i)}`));
    if (i < subs) out.push(agent(`s${i}`, `proj-${String.fromCharCode(97 + i)}`, { parentKey: `r${i}` }));
  }
  return out;
}

const village = (n: number, capacity = true): World => buildWorld(planHouses(roster(n)), capacity ? { seats: 4 } : undefined);
const city = (n: number, capacity = true, subs = 0): World =>
  buildCityWorld(planCity(roster(n, subs)).plans, capacity ? { seats: 4 } : undefined);

/** Every village / city shape the tests sweep: 0..9 houses, with and without the capacity row / HQ. */
const VILLAGES: [string, () => World][] = [];
const CITIES: [string, () => World][] = [];
for (const cap of [true, false])
  for (let n = 0; n <= 9; n++) {
    VILLAGES.push([`village ${n} houses${cap ? " + capacity" : ""}`, () => village(n, cap)]);
    CITIES.push([`city ${n} buildings${cap ? " + HQ" : ""}`, () => city(n, cap, n % 3)]);
  }
const ALL = [...VILLAGES, ...CITIES];

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const themed = (w: World) => w.props.filter((p) => p.kind === "vending" || p.kind === "torii");
const ofKind = (w: World, kind: Prop["kind"]) => w.props.filter((p) => p.kind === kind);
const kindAt = (w: World, c: number, r: number) => w.tiles[r * w.cols + c];
const bin = (col: number, row: number): Prop => ({ id: `bin:${col},${row}`, kind: "bin", col, row, w: 1, h: 1 });

/** `w` with the tiles at `edits` changed — its props, plaza and city record untouched. */
function retiled(w: World, edits: [number, number, TileKind][]): World {
  const tiles = [...w.tiles];
  for (const [c, r, k] of edits) tiles[r * w.cols + c] = k;
  return { ...w, tiles };
}

/** The plaza square's top row and the fountain's column. */
const plazaOf = (d: World) => ({
  top: Math.min(...d.tiles.flatMap((k, i) => (k === "plaza" ? [Math.floor(i / d.cols)] : []))),
  cx: d.plaza.col,
});

function overlaps(a: Prop, b: Prop): boolean {
  const x = artBox(a);
  const y = artBox(b);
  return x.col < y.col + y.w && y.col < x.col + x.w && x.row < y.row + y.h && y.row < x.row + x.h;
}

/** Every tile reachable from `from` over the world's walk grid (BFS, 4-connected). */
function reach(w: World, from: { col: number; row: number }): Set<number> {
  const grid = walkGrid(w);
  const start = from.row * w.cols + from.col;
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const i = queue.shift() as number;
    const c = i % w.cols;
    const r = (i - c) / w.cols;
    for (const [dc, dr] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows) continue;
      const ni = nr * w.cols + nc;
      if (seen.has(ni) || grid[ni] !== 1) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return seen;
}

describe("themeFor — the theme from the machine's IANA time zone", () => {
  it("Tokyo (and the IANA alias 'Japan') is the Tokyo theme", () => {
    expect(themeFor("Asia/Tokyo")).toBe("tokyo");
    expect(themeFor("Japan")).toBe("tokyo");
  });

  it("anything else — another zone, a near miss, nothing — has no theme", () => {
    for (const z of ["Europe/Madrid", "UTC", "Asia/Seoul", "America/New_York", "asia/tokyo", "Asia/Tokyo ", "Tokyo", "", undefined, null])
      expect(themeFor(z), String(z)).toBeNull();
  });
});

describe("the theme's props and walking", () => {
  it("a vending machine and a torii block nobody; a sakura blocks exactly like the tree it replaces", () => {
    expect(isBlockingProp("vending")).toBe(false);
    expect(isBlockingProp("torii")).toBe(false);
    expect(isBlockingProp("sakura")).toBe(isBlockingProp("tree"));
  });
});

describe("dressing outside Tokyo", () => {
  it.each(ALL)("leaves the %s exactly as built — the same object", (_, make) => {
    const w = make();
    for (const z of ["Europe/Madrid", "UTC", undefined, null, ""]) {
      expect(dressVillage(w, z)).toBe(w);
      expect(dressCity(w, z)).toBe(w);
      expect(dressWorld(w, z)).toBe(w);
    }
  });

  it("a dresser never touches the other scene's world, even in Tokyo", () => {
    const v = village(3);
    const c = city(3);
    expect(dressCity(v, TOKYO)).toBe(v);
    expect(dressVillage(c, TOKYO)).toBe(c);
  });
});

describe("dressing in Tokyo — both scenes", () => {
  it.each(ALL)("%s: a new world; the input untouched (deep-frozen, compared with a copy taken before)", (_, make) => {
    const w = make();
    const before = structuredClone(w);
    deepFreeze(w);
    const d = dressWorld(w, TOKYO);
    expect(d).not.toBe(w);
    expect(w).toEqual(before);
    // Only the props changed: tiles, houses, seats, plaza and the city record are the very same objects.
    for (const k of ["tiles", "houses", "seats", "plaza", "city"] as const) expect(d[k]).toBe(w[k]);
    expect([d.cols, d.rows]).toEqual([w.cols, w.rows]);
  });

  it.each(ALL)("%s: every prop it was built with is still there, in order — a tree may only have blossomed", (_, make) => {
    const w = make();
    const d = dressWorld(w, TOKYO);
    const kept = d.props.filter((p) => p.kind !== "vending" && p.kind !== "torii");
    expect(kept).toHaveLength(w.props.length);
    kept.forEach((p, i) => {
      const o = w.props[i];
      if (o.kind === "tree" && p.kind === "sakura") {
        expect({ ...p, kind: "tree", id: o.id }).toEqual(o); // same footprint, same everything else
        expect(p.id).toBe(o.id.replace(/(^|:)tree(?=:|$)/, "$1sakura"));
      } else expect(p).toBe(o);
    });
  });

  it.each(ALL)("%s: no theme prop's footprint or art overlaps another prop's", (_, make) => {
    const d = dressWorld(make(), TOKYO);
    for (const t of themed(d)) for (const p of d.props) if (p !== t) expect(overlaps(t, p), `${t.id} × ${p.id}`).toBe(false);
  });

  it.each(ALL)("%s: walking is exactly as before — not one walkable tile gained or lost", (_, make) => {
    const w = make();
    const d = dressWorld(w, TOKYO);
    expect(Array.from(walkGrid(d))).toEqual(Array.from(walkGrid(w)));
  });

  it.each(ALL)("%s: deterministic — a second build of the same scene dresses identically", (_, make) => {
    expect(dressWorld(make(), TOKYO)).toEqual(dressWorld(make(), TOKYO));
  });

  it.each(ALL)("%s: idempotent — a dressed world dresses to itself, cached or rebuilt from scratch", (_, make) => {
    const d = dressWorld(make(), TOKYO);
    expect(dressWorld(d, TOKYO)).toBe(d);
    // A copy is not in any cache: it goes through the whole dresser and still changes nothing.
    const copy = structuredClone(d);
    expect(dressWorld(copy, TOKYO)).toBe(copy);
    // Dressing the same input twice hands back the same dressed object (the panel's memo stays put).
    const w = make();
    expect(dressWorld(w, TOKYO)).toBe(dressWorld(w, TOKYO));
  });

  it("a re-dress drops machines and a gate standing anywhere else and places them by the rules again", () => {
    const d = dressVillage(village(4), TOKYO);
    const stray: Prop = { id: "tokyo:vending:0,0", kind: "vending", col: 0, row: 1, w: 1, h: 1 };
    const moved = { ...d, props: [...d.props, stray] };
    expect(dressVillage(moved, TOKYO).props).toEqual(d.props);
  });

  /** A dressed world with ONE prop wrong but the count unchanged — so only a field-by-field look can tell. */
  const wrongOne: [string, (d: World) => Prop[]][] = [
    ["the gate a column off its spot", (d) => d.props.map((p) => (p.kind === "torii" ? { ...p, col: p.col + 1 } : p))],
    [
      "a blossom back to a plain tree",
      (d) => {
        const i = d.props.findIndex((p) => p.kind === "sakura");
        return d.props.map((p, j) => (j === i ? { ...p, kind: "tree", id: p.id.replace("sakura", "tree") } : p));
      },
    ],
  ];
  it.each(wrongOne)("a re-dress of a world with as many props but %s puts it right — a new world, not the input", (_, spoil) => {
    const d = dressVillage(village(4), TOKYO);
    const wrong: World = { ...d, props: spoil(d) };
    expect(wrong.props).toHaveLength(d.props.length);
    expect(wrong.props).not.toEqual(d.props);
    const again = dressVillage(wrong, TOKYO);
    expect(again).not.toBe(wrong);
    expect(again.props).toEqual(d.props);
  });
});

describe("dressVillage — Tokyo", () => {
  it.each(VILLAGES)("%s: a third of the trees (rounded up) blossom, on the same tiles", (_, make) => {
    const w = make();
    const d = dressVillage(w, TOKYO);
    const trees = ofKind(w, "tree");
    expect(trees.length).toBeGreaterThan(0);
    expect(ofKind(d, "sakura")).toHaveLength(Math.ceil(trees.length / 3));
    expect(ofKind(d, "tree")).toHaveLength(trees.length - Math.ceil(trees.length / 3));
    const spots = (ps: Prop[]) => ps.map((p) => `${p.col},${p.row},${p.w},${p.h}`).sort();
    expect(spots([...ofKind(d, "tree"), ...ofKind(d, "sakura")])).toEqual(spots(trees));
  });

  it.each(VILLAGES)("%s: one torii, the plaza's gate — north of the square, on the fountain's column; you walk through its middle", (_, make) => {
    const d = dressVillage(make(), TOKYO);
    const { top, cx } = plazaOf(d);
    const gates = ofKind(d, "torii");
    expect(gates).toHaveLength(1);
    const [g] = gates;
    expect([g.row, g.w, g.h]).toEqual([top - 1, 3, 1]);
    // Centred on the fountain's column — unless another prop's art is in the way there; then the nearest shift.
    const centred: Prop = { ...g, col: cx - 1 };
    const inTheWay = (t: Prop) => d.props.some((p) => p.kind !== "torii" && p.kind !== "vending" && overlaps(t, p));
    if (!inTheWay(centred)) expect(g.col).toBe(cx - 1);
    else for (let s = 1; s < Math.abs(g.col - (cx - 1)); s++) for (const c of [cx - 1 - s, cx - 1 + s]) expect(inTheWay({ ...g, col: c })).toBe(true);
    expect(Math.abs(g.col + 1 - cx)).toBeLessThanOrEqual(3);
    const mid = g.col + 1;
    for (let k = 0; k < 3; k++) expect(["grass", "path"]).toContain(kindAt(d, g.col + k, g.row));
    // A walker comes down from the row above, through the gate's middle tile, into the plaza.
    expect(kindAt(d, mid, g.row + 1)).toBe("plaza");
    expect(findPath(d, { col: mid, row: g.row - 1 }, { col: mid, row: g.row + 1 })).toEqual([
      { col: mid, row: g.row },
      { col: mid, row: g.row + 1 },
    ]);
  });

  it.each(VILLAGES)("%s: two vending machines side by side on the grass beside the gate, a tile clear of it, facing the plaza", (_, make) => {
    const d = dressVillage(make(), TOKYO);
    const { top, cx } = plazaOf(d);
    const machines = ofKind(d, "vending");
    expect(machines).toHaveLength(2);
    const [a, b] = machines;
    expect([a.row, b.row, b.col - a.col]).toEqual([top - 1, top - 1, 1]);
    for (const m of machines) {
      expect([m.w, m.h]).toEqual([1, 1]);
      expect(kindAt(d, m.col, m.row)).toBe("grass");
      expect(kindAt(d, m.col, m.row + 1)).toBe("plaza");
    }
    const [g] = ofKind(d, "torii");
    expect(b.col < g.col ? g.col - b.col : a.col - (g.col + 2)).toBeGreaterThanOrEqual(2);
    // Left of the gate, cx-5 and cx-4, unless something there is in the way.
    const free = (c: number) => !d.props.some((p) => p.kind !== "vending" && overlaps({ ...a, col: c }, p));
    if (free(cx - 5) && free(cx - 4)) expect([a.col, b.col]).toEqual([cx - 5, cx - 4]);
  });

  it("with the capacity row north of the plaza nothing is in the way: the gate exactly centred, the machines at cx-5, cx-4", () => {
    for (const n of [0, 1, 4, 9]) {
      const d = dressVillage(village(n), TOKYO);
      const { top, cx } = plazaOf(d);
      expect(themed(d).map((p) => [p.kind, p.col, p.row])).toEqual([
        ["torii", cx - 1, top - 1],
        ["vending", cx - 5, top - 1],
        ["vending", cx - 4, top - 1],
      ]);
    }
  });

  it.each(VILLAGES)("%s: every house door still reaches the plaza", (_, make) => {
    const d = dressVillage(make(), TOKYO);
    for (const h of d.houses)
      expect(findPath(d, { col: h.doorCol, row: h.doorRow }, d.plaza), `${h.key} → plaza`).not.toBeNull();
  });

  it("the plain three-house village, pinned: the machines, the gate, the blossoming trees", () => {
    const d = dressVillage(village(3, false), TOKYO);
    const at = (p: Prop) => `${p.kind}@${p.col},${p.row}`;
    expect(themed(d).map(at)).toMatchInlineSnapshot(`
      [
        "torii@19,14",
        "vending@15,14",
        "vending@16,14",
      ]
    `);
    expect(ofKind(d, "sakura").map(at)).toMatchInlineSnapshot(`
      [
        "sakura@33,14",
        "sakura@25,24",
        "sakura@32,24",
        "sakura@25,27",
        "sakura@31,35",
      ]
    `);
  });
});

describe("dressing in Tokyo — the fallbacks", () => {
  it("village: when no PAIR of machines fits by the plaza, one machine goes where a single one fits", () => {
    const base = village(4);
    const plazaRows = [...new Set(base.tiles.map((t, i) => (t === "plaza" ? Math.floor(i / base.cols) : -1)).filter((r) => r >= 0))];
    const [top, bottom] = [Math.min(...plazaRows), Math.max(...plazaRows)];
    // A bin on every EVEN column of the rows the machines (and their art) would use: no two neighbours are free.
    const bins: Prop[] = [];
    for (const r of [top - 2, top - 1, bottom, bottom + 1]) for (let c = 0; c < base.cols; c += 2) bins.push(bin(c, r));
    const dressed = dressVillage({ ...base, props: [...base.props, ...bins] }, "Asia/Tokyo");
    const machines = ofKind(dressed, "vending");
    expect(machines).toHaveLength(1);
    expect(machines[0].col % 2).toBe(1);
    expect([top - 1, bottom + 1]).toContain(machines[0].row);
  });

  it("city: an empty street still gets its torii, at the right end with room either side", () => {
    const empty = buildCityWorld([]);
    const gates = ofKind(dressCity(empty, "Asia/Tokyo"), "torii");
    expect(gates).toHaveLength(1);
    const [g] = gates;
    expect(g.row).toBe(empty.city!.street);
    // Lamps stand at 4, 12, 20, 28, 36 on a 40-column street: the rightmost three columns with a free
    // tile either side are 32..34 (33..35 would touch the lamp at 36; 37..39 starts right beside it).
    expect(empty.props.filter((p) => p.kind === "lamp").map((p) => p.col)).toEqual([4, 12, 20, 28, 36]);
    expect([g.col, g.w]).toEqual([32, 3]);
  });

  // The village gate's ground rules. In the built village the centred spot always passes them (it is
  // pinned exactly centred above), so each test spoils ONE tile of it and watches the gate move on.
  const gateOf = (w: World) => ofKind(dressVillage(w, TOKYO), "torii").map((g) => [g.col, g.row]);

  it("village: the gate stands on open ground only — water under the centred spot moves it to the nearest clear one", () => {
    const base = village(4);
    const { top, cx } = plazaOf(base);
    expect(gateOf(base)).toEqual([[cx - 1, top - 1]]);
    const wet = retiled(base, [[cx - 1, top - 1, "water"]]);
    // A shift of one left (cx-2..cx) still holds the water; one right (cx..cx+2) is clear.
    expect(gateOf(wet)).toEqual([[cx, top - 1]]);
  });

  it("village: no wall under the gate's art — a wall at its very top (two rows up) moves it the same way", () => {
    const base = village(4);
    const { top, cx } = plazaOf(base);
    expect(gateOf(retiled(base, [[cx - 1, top - 3, "wall"]]))).toEqual([[cx, top - 1]]);
  });

  it("village: no wall over a machine — a wall over the left pair's spot sends the pair right of the gate", () => {
    const base = village(4);
    const { top, cx } = plazaOf(base);
    const machines = (w: World) => ofKind(dressVillage(w, TOKYO), "vending").map((m) => [m.col, m.row]);
    expect(machines(base)).toEqual([
      [cx - 5, top - 1],
      [cx - 4, top - 1],
    ]);
    expect(machines(retiled(base, [[cx - 5, top - 2, "wall"]]))).toEqual([
      [cx + 4, top - 1],
      [cx + 5, top - 1],
    ]);
  });

  it.each([
    ["a road tile in the sidewalk", 0, "road"],
    ["a wall over the sidewalk", -1, "wall"],
    ["a wall at the top of the gate's art", -2, "wall"],
  ] as const)("city: %s where the gate would stand moves it on to the next spot with room", (_, dr, kind) => {
    const empty = buildCityWorld([]);
    const sr = empty.city!.street;
    const gate = (w: World) => ofKind(dressCity(w, TOKYO), "torii").map((g) => [g.col, g.row]);
    expect(gate(empty)).toEqual([[32, sr]]);
    // 31..33 and 32..34 hold the spoiled column 33 too; 30..32 has a free tile either side (29 and 33).
    expect(gate(retiled(empty, [[33, sr + dr, kind]]))).toEqual([[30, sr]]);
  });

  it("city: an empty street with no room anywhere along its sidewalk gets no gate at all — the world comes back as it was", () => {
    const empty = buildCityWorld([]);
    const sr = empty.city!.street;
    // A bin every fourth column: no three free columns with a free one either side, anywhere.
    const bins: Prop[] = [];
    for (let c = 2; c < empty.cols; c += 4) bins.push(bin(c, sr));
    const crowded: World = { ...empty, props: [...empty.props, ...bins] };
    const d = dressCity(crowded, TOKYO);
    expect(ofKind(d, "torii")).toEqual([]);
    expect(d).toBe(crowded);
  });

  it("city: with the street's right end taken, the gate stands at its left end — a free tile short of the first lamp", () => {
    const w = city(1, false);
    const sr = w.city!.street;
    const [b] = w.city!.buildings;
    const blocked: World = { ...w, props: [...w.props] };
    for (let c = b.col + b.w; c < w.cols; c++) blocked.props.push(bin(c, sr));
    const lamp = ofKind(w, "lamp").find((l) => l.col < b.col)!;
    expect(lamp.col).toBe(b.col - 2);
    const [g] = ofKind(dressCity(blocked, TOKYO), "torii");
    // Its right column is lamp-2: one free tile (lamp-1) between them. lamp-5 would stand right beside it.
    expect([g.col, g.row]).toEqual([lamp.col - 4, sr]);
  });

  it("city: something on the far sidewalk under the last building moves the gate left until it clears it", () => {
    // Two projects, one either side of the HQ: no room at either end of the near sidewalk.
    const w = city(2);
    const sr = w.city!.street;
    const last = w.city!.buildings.at(-1)!;
    const right = last.col + last.w;
    const gate = (x: World) => ofKind(dressCity(x, TOKYO), "torii").map((g) => [g.col, g.row]);
    expect(gate(w)).toEqual([[right - 3, sr + 3]]);
    // A bin at right-2: the spans starting at right-3 and right-4 hold it; right-5..right-3 is the first clear.
    expect(gate({ ...w, props: [...w.props, bin(right - 2, sr + 3)] })).toEqual([[right - 5, sr + 3]]);
  });

  it("city: a gate pushed along the far sidewalk to the lounge's kiosk skips the crossing's landing — the kiosk's tile and one either side", () => {
    const w = city(2);
    const sr = w.city!.street;
    const { col } = w.city!.lounge!.lift;
    expect(ofKind(w, "lift").map((k) => [k.col, k.row])).toEqual([[col, sr + 3]]);
    // Bins on the far sidewalk from four right of the kiosk to the street's end: the first span the
    // scan finds free of them is col+1..col+3, which only the landing's right tile (col+1) holds.
    const bins: Prop[] = [];
    for (let c = col + 4; c < w.cols; c++) bins.push(bin(c, sr + 3));
    const [g] = ofKind(dressCity({ ...w, props: [...w.props, ...bins] }, TOKYO), "torii");
    // col-3..col-1 holds the landing's left tile; col-4..col-2 is the first span clear of all of it.
    expect([g.col, g.row]).toEqual([col - 4, sr + 3]);
  });
});

describe("crossingOf — the pedestrian crossing in front of the HQ", () => {
  it("runs from the HQ's door on the near sidewalk across both lanes to the lounge's kiosk on the far one, three tiles wide", () => {
    for (const n of [0, 1, 2, 5, 9]) {
      const w = city(n, true, n % 3);
      const { street, lounge, buildings } = w.city!;
      const hq = buildings.find((b) => b.hq)!;
      const x = crossingOf(w)!;
      expect(x).toEqual({ col: lounge!.lift.col - 1, row: street, w: 3, h: 4 });
      // Its top row is the near sidewalk right under the HQ's door (the door in its middle column)…
      expect(x.col + 1).toBe(hq.doorCol);
      expect(hq.row + hq.h).toBe(x.row);
      expect(kindAt(w, hq.doorCol, x.row - 1)).toBe("floor");
      // …then the two lanes, then the far sidewalk with the kiosk in its middle.
      for (let k = 0; k < 3; k++)
        expect([0, 1, 2, 3].map((d) => kindAt(w, x.col + k, x.row + d))).toEqual(["path", "road", "road", "path"]);
      expect(ofKind(w, "lift").map((p) => [p.col, p.row])).toEqual([[x.col + 1, x.row + 3]]);
    }
  });

  it("there is none without the lounge: a city built without a capacity layout, an empty street, the village", () => {
    expect(crossingOf(city(3, false))).toBeNull();
    expect(crossingOf(buildCityWorld([]))).toBeNull();
    expect(crossingOf(village(3))).toBeNull();
  });

  it.each(CITIES)("%s: nothing the dresser places stands on the crossing, either landing or the kiosk — footprint or art", (_, make) => {
    const d = dressCity(make(), TOKYO);
    const x = crossingOf(d);
    if (!x) return;
    for (const t of themed(d)) {
      const b = artBox(t);
      const apart = b.col + b.w <= x.col || x.col + x.w <= b.col || b.row + b.h <= x.row || x.row + x.h <= b.row;
      expect(apart, t.id).toBe(true);
    }
  });
});

describe("dressCity — Tokyo", () => {
  /** The sidewalk row under each building (its front wall is the row above). */
  const sidewalk = (b: { row: number; h: number }) => b.row + b.h;

  it.each(CITIES)("%s: half the street trees (rounded up) blossom, on the same tiles", (_, make) => {
    const w = make();
    const d = dressCity(w, TOKYO);
    const trees = ofKind(w, "tree");
    expect(ofKind(d, "sakura")).toHaveLength(Math.ceil(trees.length / 2));
    expect(ofKind(d, "tree")).toHaveLength(trees.length - Math.ceil(trees.length / 2));
  });

  it.each(CITIES)("%s: vending machines stand on a sidewalk, against a front wall or a gap's sky, never before a door", (_, make) => {
    const d = dressCity(make(), TOKYO);
    const city = d.city!;
    const machines = ofKind(d, "vending");
    if (city.buildings.length > 0) expect(machines.length).toBeGreaterThan(0);
    const doors = new Set(city.buildings.map((b) => b.doorCol));
    const rows = new Set(city.buildings.map(sidewalk));
    for (const m of machines) {
      expect([m.w, m.h]).toEqual([1, 1]);
      expect(rows.has(m.row), m.id).toBe(true);
      expect(kindAt(d, m.col, m.row)).toBe("path");
      expect(["wall", "sky"]).toContain(kindAt(d, m.col, m.row - 1));
      expect(doors.has(m.col), m.id).toBe(false);
    }
  });

  it.each(CITIES)("%s: half the buildings (rounded up) have a machine two tiles left of their door, every third of them a pair; a third of the gaps' free tiles one", (_, make) => {
    const d = dressCity(make(), TOKYO);
    const { buildings } = d.city!;
    const machines = ofKind(d, "vending");
    const at = (c: number, r: number) => machines.some((m) => m.col === c && m.row === r);
    const withOne = buildings.filter((b) => at(b.doorCol - 2, sidewalk(b)));
    expect(withOne).toHaveLength(Math.ceil(buildings.length / 2));
    const pairs = withOne.filter((b) => at(b.doorCol - 3, sidewalk(b)));
    expect(pairs).toHaveLength(Math.ceil(withOne.length / 3));
    // Nothing else stands in front of a building: the rest are in the gaps, on open sky's sidewalk.
    const inGaps = machines.filter((m) => kindAt(d, m.col, m.row - 1) === "sky");
    expect(inGaps.length + withOne.length + pairs.length).toBe(machines.length);
    // A gap's free tiles: sidewalk under open sky between the first and last building, clear of the lamp and the tree.
    if (buildings.length > 1) {
      const sr = sidewalk(buildings[0]);
      const plain = dressCity(make(), "UTC");
      let free = 0;
      for (let c = buildings[0].col; c < buildings.at(-1)!.col + buildings.at(-1)!.w; c++)
        if (kindAt(d, c, sr - 1) === "sky" && !plain.props.some((p) => overlaps({ id: "x", kind: "vending", col: c, row: sr, w: 1, h: 1 }, p))) free++;
      expect(inGaps).toHaveLength(Math.ceil(free / 3));
      expect(free).toBe(buildings.length - 1); // one per gap: the column between its lamp and its tree
    }
  });

  it("a machine needs a sidewalk under it and a wall or open sky behind it: an opening in the facade, or no sidewalk, moves it on", () => {
    const w = city(3);
    const d = dressCity(w, TOKYO);
    const b = d.city!.buildings.find((x) => ofKind(d, "vending").some((m) => m.col === x.doorCol - 2 && m.row === sidewalk(x)))!;
    expect(b).toBeDefined();
    const sr = sidewalk(b);
    const at = (x: World, c: number) => ofKind(x, "vending").some((m) => m.col === c && m.row === sr);
    const retile = (edits: [number, number, TileKind][]): World => retiled(w, edits);
    // An opening in the front wall where the machine would stand (a door's floor tile): it goes right of the door.
    const opening = dressCity(retile([[b.doorCol - 2, sr - 1, "floor"]]), TOKYO);
    expect(at(opening, b.doorCol - 2)).toBe(false);
    expect(at(opening, b.doorCol + 2)).toBe(true);
    // No sidewalk on either side of the door: no machine in front of this building at all.
    const road = dressCity(retile([[b.doorCol - 2, sr, "road"], [b.doorCol + 2, sr, "road"]]), TOKYO);
    for (const c of [b.doorCol - 3, b.doorCol - 2, b.doorCol + 2, b.doorCol + 3]) expect(at(road, c), `col ${c}`).toBe(false);
  });

  it.each(CITIES)("%s: every street door reaches exactly the tiles it did before", (_, make) => {
    const w = make();
    const d = dressCity(w, TOKYO);
    for (const b of d.city!.buildings) {
      const door = { col: b.doorCol, row: b.row + b.h - 1 };
      expect(reach(d, door)).toEqual(reach(w, door));
      // …and that includes the sidewalk tile right under it.
      expect(reach(d, door).has(sidewalk(b) * d.cols + b.doorCol)).toBe(true);
    }
  });

  it.each(CITIES)("%s: one torii on the street — three path tiles, nothing but open sky or road over it", (_, make) => {
    const d = dressCity(make(), TOKYO);
    const gates = ofKind(d, "torii");
    expect(gates).toHaveLength(1);
    const [g] = gates;
    const street = d.city!.street;
    expect([street, street + 3]).toContain(g.row);
    const over = g.row === street ? "sky" : "road";
    for (let k = 0; k < 3; k++) {
      expect(kindAt(d, g.col + k, g.row)).toBe("path");
      expect(kindAt(d, g.col + k, g.row - 1)).toBe(over);
      expect(kindAt(d, g.col + k, g.row - 2)).toBe(over);
    }
  });

  it("a small city has room at the end of its street: the torii stands on the near sidewalk, just past the last lamp", () => {
    const d = dressCity(city(1, false), TOKYO);
    const street = d.city!.street;
    const [g] = ofKind(d, "torii");
    const last = d.city!.buildings.at(-1)!;
    const lamp = d.props.filter((p) => p.kind === "lamp").at(-1)!;
    expect(lamp.col).toBeGreaterThanOrEqual(last.col + last.w);
    expect([g.col, g.row]).toEqual([lamp.col + 2, street]);
  });

  it("the HQ in the middle, more built on one side: the torii stands in the other side's empty stretch, as close to its last building as fits", () => {
    // One project (it goes right of the HQ), or three (two right, one left): the left end is empty street.
    for (const n of [1, 3]) {
      const d = dressCity(city(n), TOKYO);
      const { street, buildings } = d.city!;
      const first = buildings[0];
      const last = buildings.at(-1)!;
      expect(first.col).toBeGreaterThan(d.cols - (last.col + last.w) + 5);
      const [g] = ofKind(d, "torii");
      // Its right column two short of the first building's lamp: one free tile between them.
      const lamp = ofKind(d, "lamp").find((l) => l.col === first.col - 2)!;
      expect(lamp).toBeDefined();
      expect([g.col, g.row]).toEqual([lamp.col - 4, street]);
    }
  });

  it("a street built alike on both sides of the HQ, with no room at either end: the torii stands across the road, under the last building", () => {
    for (const n of [2, 4]) {
      const d = dressCity(city(n), TOKYO);
      const street = d.city!.street;
      const [g] = ofKind(d, "torii");
      const last = d.city!.buildings.at(-1)!;
      expect(last.hq).toBeUndefined();
      expect(g.row).toBe(street + 3);
      expect(g.col).toBe(last.col + last.w - 3);
    }
  });

  it("an empty street still gets its gate: at its right end, a tile clear of the lamps either side", () => {
    const d = dressCity(buildCityWorld([]), TOKYO);
    const [g] = ofKind(d, "torii");
    expect(g.row).toBe(d.city!.street);
    const lamps = ofKind(d, "lamp").map((p) => p.col);
    const after = lamps.filter((c) => c > g.col + 2);
    // No lamp under it; the nearest one either side is at least one free tile away.
    expect(lamps.filter((c) => c >= g.col && c <= g.col + 2)).toEqual([]);
    expect(Math.min(...after) - (g.col + 2)).toBeGreaterThanOrEqual(2);
    expect(g.col - Math.max(...lamps.filter((c) => c < g.col))).toBeGreaterThanOrEqual(2);
    // The right end: no spot further right would have had room (past the last lamp there is none).
    expect(after).toHaveLength(1);
    expect(d.cols - 1 - after[0]).toBeLessThan(3 + 1);
    expect(ofKind(d, "vending")).toEqual([]);
  });

  it("the HQ and three buildings, pinned: the machines, the gate, the blossoming trees", () => {
    // One project left of the HQ (cols 15–22, door 20), the HQ (27–40, door 34), two right of it
    // (45–52, door 50; 57–64, door 62); gaps of lamp, free tile, tree after each.
    const d = dressCity(city(3), TOKYO);
    expect(d.city!.buildings.map((b) => [b.col, b.doorCol])).toEqual([
      [15, 20],
      [27, 34],
      [45, 50],
      [57, 62],
    ]);
    const at = (p: Prop) => `${p.kind}@${p.col},${p.row}`;
    // Two of four buildings get a machine two tiles left of the door (the first chosen a pair); one of
    // the three gaps' free tiles another; the gate at the left end, where the street is empty.
    expect(themed(d).map(at)).toMatchInlineSnapshot(`
      [
        "vending@60,15",
        "vending@59,15",
        "vending@18,15",
        "vending@42,15",
        "torii@9,15",
      ]
    `);
    expect(ofKind(d, "sakura").map(at)).toMatchInlineSnapshot(`
      [
        "sakura@25,14",
        "sakura@43,14",
      ]
    `);
  });

  it("the HQ alone, pinned: its pair of machines left of its door, clear of the crossing; the gate at the street's right end", () => {
    const d = dressCity(city(0), TOKYO);
    const [hq] = d.city!.buildings;
    expect([hq.col, hq.doorCol, d.city!.lounge!.lift.col, d.cols]).toEqual([13, 20, 20, 40]);
    expect(themed(d).map((p) => `${p.kind}@${p.col},${p.row}`)).toMatchInlineSnapshot(`
      [
        "vending@18,15",
        "vending@17,15",
        "torii@30,15",
      ]
    `);
  });
});
