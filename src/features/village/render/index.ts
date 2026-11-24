/**
 * Agent Village renderer — public API (the panel consumes only this).
 * Contract types (DrawItem, CharacterView, …) live in ../villageTypes.ts.
 */

export type { DrawTarget, SpriteBank } from "./renderTypes";
export type { Camera } from "./camera";
export { worldToScreen, screenToWorld, fitCamera, clampZoom } from "./camera";
export { loadSprites } from "./sprites";
export { renderFrame, type RenderView } from "./frame";
export { paintAmbience, paintPuddles, isWet } from "./ambience";
export {
  defaultMakeLayer,
  paintGround,
  type GroundLayer,
  type MakeLayer,
} from "./ground";
