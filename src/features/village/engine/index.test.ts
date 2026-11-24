import { describe, expect, it } from "vitest";
import * as engine from "./index";

describe("engine barrel", () => {
  it("exposes exactly the public engine API", () => {
    expect(Object.keys(engine).sort()).toEqual(
      [
        "MAX_PARTICLES",
        "SIT_OFFSET",
        "VillageSim",
        "WeatherFx",
        "buildCityWorld",
        "buildDrawList",
        "buildWorld",
        "cityGround",
        "computeAmbience",
        "dayPhaseAt",
        "findPath",
        "floorKey",
        "hitTest",
        "indoorTest",
        "isIndoorTile",
        "planCity",
        "planHouses",
        "rainSlant",
        "walkable",
      ].sort(),
    );
    const sim = new engine.VillageSim({ seed: 1 });
    const world = engine.buildWorld(engine.planHouses([]));
    sim.setWorld(world);
    expect(engine.buildDrawList(world, sim.characters(), (id) => sim.pcOn(id), sim.time).length).toBeGreaterThan(0);
    expect(engine.hitTest([], 0, 0)).toBeNull();
    expect(engine.walkable(world, world.plaza.col, world.plaza.row)).toBe(true);
    expect(engine.findPath(world, world.plaza, world.plaza)).toEqual([]);
    expect(engine.isIndoorTile(world, world.plaza.col, world.plaza.row)).toBe(false);
    expect(engine.indoorTest(world)(world.plaza.col * 16, world.plaza.row * 16)).toBe(false);
    expect(engine.dayPhaseAt(15 * 60, null, null)).toBe("afternoon");
    const amb = engine.computeAmbience(new Date(2026, 9, 14, 15, 0), null, { weather: "rain", phase: "auto" });
    sim.setAmbience(amb);
    const fx = new engine.WeatherFx(1);
    fx.update(0.05, amb, { x: 0, y: 0, w: 200, h: 200 }, () => false);
    expect(fx.particles().length).toBeLessThanOrEqual(engine.MAX_PARTICLES);
    expect(engine.rainSlant(0)).toBe(0);
    const city = engine.buildCityWorld(engine.planCity([]).plans);
    expect(city.city?.buildings).toEqual([]);
    expect(engine.floorKey("a")).toBe("floor:a");
    expect(engine.cityGround(city)(0, city.city!.street * 16)).toBe(true);
  });
});
