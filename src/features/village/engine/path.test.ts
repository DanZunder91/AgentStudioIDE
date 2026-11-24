import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Prop } from "../villageTypes";
import { findPath, type Tile } from "./path";
import { asciiWorld } from "./testWorld";
import { walkable } from "./world";

const open = asciiWorld([".....", ".....", ".....", ".....", "....."]);

function assertValidPath(world: ReturnType<typeof asciiWorld>, from: Tile, path: Tile[], allow?: Tile) {
  let prev = from;
  for (const step of path) {
    expect(Math.abs(step.col - prev.col) + Math.abs(step.row - prev.row)).toBe(1);
    const isAllowed = allow && allow.col === step.col && allow.row === step.row;
    expect(isAllowed || walkable(world, step.col, step.row)).toBe(true);
    prev = step;
  }
}

describe("findPath", () => {
  it("returns [] when already there and a shortest 4-connected path otherwise", () => {
    expect(findPath(open, { col: 2, row: 2 }, { col: 2, row: 2 })).toEqual([]);
    const p = findPath(open, { col: 0, row: 0 }, { col: 3, row: 4 })!;
    expect(p).toHaveLength(7);
    expect(p[p.length - 1]).toEqual({ col: 3, row: 4 });
    assertValidPath(open, { col: 0, row: 0 }, p);
  });

  it("returns null for out-of-bounds endpoints", () => {
    expect(findPath(open, { col: -1, row: 0 }, { col: 1, row: 1 })).toBeNull();
    expect(findPath(open, { col: 0, row: 0 }, { col: 5, row: 0 })).toBeNull();
    expect(findPath(open, { col: 0, row: 9 }, { col: 0, row: 0 })).toBeNull();
    expect(findPath(open, { col: 0, row: 0 }, { col: 0, row: -1 })).toBeNull();
  });

  it("returns null for unwalkable or unreachable targets", () => {
    const w = asciiWorld(["..#..", "..#..", "..#~."]);
    expect(findPath(w, { col: 0, row: 0 }, { col: 2, row: 1 })).toBeNull(); // wall
    expect(findPath(w, { col: 0, row: 0 }, { col: 3, row: 2 })).toBeNull(); // water
    expect(findPath(w, { col: 0, row: 0 }, { col: 4, row: 0 })).toBeNull(); // other side
  });

  it("routes around walls and blocking props, through non-blocking ones", () => {
    const props: Prop[] = [
      { id: "d", kind: "desk", col: 1, row: 1, w: 2, h: 1 },
      { id: "p", kind: "pc", col: 1, row: 1, w: 1, h: 1 },
      { id: "k", kind: "coffee", col: 3, row: 0, w: 1, h: 1 },
    ];
    const w = asciiWorld(["....", "....", "...."], { props });
    expect(walkable(w, 1, 1)).toBe(false);
    expect(walkable(w, 3, 0)).toBe(true);
    const p = findPath(w, { col: 1, row: 0 }, { col: 1, row: 2 })!;
    expect(p).toHaveLength(4);
    assertValidPath(w, { col: 1, row: 0 }, p);
  });

  it("lets only the owner path into its chair (own-chair exemption)", () => {
    const chair: Prop = { id: "c", kind: "chair", col: 2, row: 1, w: 1, h: 1, facing: "up" };
    const w = asciiWorld(["#####", "#...#", "#####"], { props: [chair] });
    const seat = { col: 2, row: 1 };
    expect(findPath(w, { col: 1, row: 1 }, seat)).toBeNull();
    expect(findPath(w, { col: 1, row: 1 }, seat, undefined, seat)).toEqual([seat]);
    // Nobody else walks THROUGH it either…
    expect(findPath(w, { col: 1, row: 1 }, { col: 3, row: 1 })).toBeNull();
    // …but a character standing on its chair can always leave.
    expect(findPath(w, seat, { col: 3, row: 1 })).toEqual([{ col: 3, row: 1 }]);
    expect(findPath(w, { col: 1, row: 1 }, seat, undefined, null)).toBeNull();
  });

  it("honours the extra blocked set", () => {
    const w = asciiWorld(["...", "...", "..."]);
    const blocked = new Set(["1,0", "1,1"]);
    const p = findPath(w, { col: 0, row: 0 }, { col: 2, row: 0 }, blocked)!;
    expect(p).toHaveLength(6);
    expect(p.some((t) => blocked.has(`${t.col},${t.row}`))).toBe(false);
    expect(findPath(w, { col: 0, row: 0 }, { col: 1, row: 1 }, blocked)).toBeNull();
  });

  it("matches a reference BFS distance on random grids (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.constantFrom(".", ".", ".", "#"), { minLength: 6, maxLength: 6 }), { minLength: 6, maxLength: 6 }),
        fc.nat(35),
        fc.nat(35),
        (grid, a, b) => {
          const w = asciiWorld(grid.map((r) => r.join("")));
          const from = { col: a % 6, row: Math.floor(a / 6) };
          const to = { col: b % 6, row: Math.floor(b / 6) };
          // reference: naive BFS distance
          const dist = new Map<string, number>([[`${from.col},${from.row}`, 0]]);
          const q: Tile[] = [from];
          while (q.length) {
            const t = q.shift()!;
            for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
              const n = { col: t.col + dc, row: t.row + dr };
              const k = `${n.col},${n.row}`;
              if (!walkable(w, n.col, n.row) || dist.has(k)) continue;
              dist.set(k, dist.get(`${t.col},${t.row}`)! + 1);
              q.push(n);
            }
          }
          const p = findPath(w, from, to);
          const expected = a === b ? 0 : dist.get(`${to.col},${to.row}`);
          if (expected === undefined) expect(p).toBeNull();
          else {
            expect(p).toHaveLength(expected);
            assertValidPath(w, from, p!);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
