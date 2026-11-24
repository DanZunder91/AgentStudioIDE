import { describe, expect, it } from "vitest";
import type { VillageAgent } from "../villageTypes";
import { buildCityWorld } from "./city";
import { asciiWorld } from "./testWorld";
import { buildWorld, indoorTest, isIndoorTile, planHouses } from "./world";

const agent = (key: string, folder: string): VillageAgent => ({
  key,
  parentKey: null,
  origin: "external",
  title: key,
  folder,
  activity: "idle",
  tool: null,
  ideAgentId: null,
  lastActivityAt: null,
});

describe("isIndoorTile", () => {
  it("is true exactly on house interiors and their door tiles", () => {
    const world = buildWorld(planHouses([agent("a", "alpha"), agent("b", "beta"), agent("c", "gamma")]));
    const expected = new Set<string>();
    for (const h of world.houses) {
      for (let r = h.row; r < h.row + h.h; r++) for (let c = h.col; c < h.col + h.w; c++) expected.add(`${c},${r}`);
      expected.add(`${h.doorCol},${h.doorRow}`);
    }
    for (let r = 0; r < world.rows; r++)
      for (let c = 0; c < world.cols; c++) {
        const tile = world.tiles[r * world.cols + c];
        const inside = isIndoorTile(world, c, r);
        expect([c, r, inside]).toEqual([c, r, expected.has(`${c},${r}`)]);
        // floor is exactly the indoors; walls, roads, grass, plaza are outdoors
        expect(inside).toBe(tile === "floor");
      }
    // the tile below a door (the yard path) is outdoors
    const h = world.houses[0];
    expect(isIndoorTile(world, h.doorCol, h.doorRow + 1)).toBe(false);
  });

  it("is false out of bounds and with no houses; houses poking out of the map are clipped", () => {
    const empty = buildWorld([]);
    expect(isIndoorTile(empty, empty.plaza.col, empty.plaza.row)).toBe(false);
    const w = asciiWorld(["____", "____"], {
      houses: [{ key: "x", label: "x", col: -2, row: -1, w: 4, h: 2, doorCol: 9, doorRow: 9, hasIde: false }],
    });
    expect(isIndoorTile(w, 0, 0)).toBe(true);
    expect(isIndoorTile(w, 1, 0)).toBe(true);
    expect(isIndoorTile(w, 2, 0)).toBe(false);
    expect(isIndoorTile(w, 0, 1)).toBe(false);
    for (const [c, r] of [[-1, 0], [0, -1], [4, 0], [0, 2]]) expect(isIndoorTile(w, c, r)).toBe(false);
    // cached per world: a second query answers the same
    expect(isIndoorTile(w, 0, 0)).toBe(true);
  });

  it("indoorTest answers isIndoorTile for the tile under any world px, in and out of bounds", () => {
    const world = buildWorld(planHouses([agent("a", "alpha"), agent("b", "beta")]));
    const inside = indoorTest(world);
    for (let r = -1; r <= world.rows; r++)
      for (let c = -1; c <= world.cols; c++)
        for (const [dx, dy] of [[0, 0], [15.9, 7.5]]) {
          const wx = c * 16 + dx;
          const wy = r * 16 + dy;
          expect([wx, wy, inside(wx, wy)]).toEqual([wx, wy, isIndoorTile(world, c, r)]);
        }
    const h = world.houses[0];
    expect(inside(h.col * 16 + 1, h.row * 16 + 1)).toBe(true);
  });
});

describe("indoors in a city", () => {
  it("is the whole shell of every building below its roof — walls and slabs included — and none of the sky or street", () => {
    const world = buildCityWorld([
      { key: "p", label: "p", team: 2, hasIde: true, floors: [0, 1].map((i) => ({ key: `floor:${i}`, label: `${i}`, ide: true })) },
    ]);
    const b = world.city!.buildings[0];
    for (let r = 0; r < world.rows; r++)
      for (let c = 0; c < world.cols; c++) {
        const inShell = c >= b.col && c < b.col + b.w && r > b.row && r < b.row + b.h;
        expect([c, r, isIndoorTile(world, c, r)]).toEqual([c, r, inShell]);
      }
    // The roof is outdoors: rain lands on it.
    expect(isIndoorTile(world, b.col + 2, b.row)).toBe(false);
  });
});
