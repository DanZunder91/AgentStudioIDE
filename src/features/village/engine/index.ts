/** Agent Village engine: pure TS, no DOM/canvas/React; other layers code against this surface. */

export { planHouses, buildWorld, walkable, isIndoorTile, indoorTest, type HousePlan } from "./world";
export { findPath } from "./path";
export { VillageSim, SIT_OFFSET } from "./sim";
export { buildDrawList, hitTest } from "./drawList";
export { dayPhaseAt, computeAmbience } from "./ambience";
export { WeatherFx, rainSlant, MAX_PARTICLES } from "./weatherFx";
export { planCity, buildCityWorld, cityGround, floorKey, type CityPlan } from "./city";
