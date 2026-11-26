/** The panel's imperative core, outside React for DOM-free tests: one view per scene (village or
 * city) owns sim, world, camera and sprites. Camera and `view` are DEVICE px; pointer methods take
 * CSS px and apply the DPR. */

import {
  buildCityWorld,
  buildDrawList,
  buildWorld,
  cityGround,
  hitTest,
  indoorTest,
  VillageSim,
  WeatherFx,
  type CityPlan,
  type HousePlan,
} from "./engine";
import { neonSigns } from "./engine/drawList";
import { StreetLife } from "./engine/streetLife";
import { TrafficFx } from "./engine/traffic";
import { MAX_TRIP } from "./engine/lan";
import {
  defaultMakeLayer,
  fitCamera,
  paintGround,
  renderFrame,
  screenToWorld,
  type Camera,
  type DrawTarget,
  type GroundLayer,
  type MakeLayer,
  type SpriteBank,
} from "./render";
import { capacityFrame, type CapacityInputs } from "./capacityModel";
import { MIN_FIT_ZOOM, MIN_ZOOM, stepZoom, worldToScreen } from "./render/camera";
import { landmarkCrown, landmarksFor, placeLandmarks, type LandmarkKind } from "./render/landmarks";
import { neonLayout } from "./render/neon";
import {
  TILE,
  type Ambience,
  type CapacityFrame,
  type CapacityKind,
  type CharacterView,
  type DayPhase,
  type LanEvent,
  type VillageActivity,
  type VillageAgent,
  type WeatherKind,
  type World,
} from "./villageTypes";

/** Tiles of air Fit keeps either side of a city's buildings, and of sky above the tallest (its sign). */
const FIT_AIR = 1;
const FIT_SKY = 2;
/** The village's Fit floor: the largest sixteenth down to ½ that shows it whole; one too big even
 * at ½ is framed on its civic row. Below ½ characters are unreadable. */
const VILLAGE_MIN_FIT = 1 / 2;
/** Tiles kept above a civic house's interior (wall + name board) and below it (wall + path). */
const CIVIC_ABOVE = 2;
const CIVIC_BELOW = 2;

/** Movement (CSS px) past which a mouse press is a drag, not a click. */
export const DRAG_SLOP = 3;

/** Wheel px per zoom step (about one notch): a trackpad sends dozens of small deltas, and a step
 * per event would leap to MAX_ZOOM in one flick. */
export const WHEEL_STEP_PX = 50;
/** A pause this long between wheel events starts a fresh gesture (drops the remainder). */
export const WHEEL_IDLE_MS = 150;

/** Sim seconds a LAN event is kept: twice `MAX_TRIP` plus a second, so no packet still being drawn
 * loses its event. */
export const LAN_EVENT_TTL = 2 * MAX_TRIP + 1;
/** Most tool packets one agent may have waiting: a jump of 40 calls sends this many, not 40 (the
 * LAN shows activity, not a ledger). */
export const TOOL_BURST = 5;
/** Sim seconds between two tool packets of one agent, so they never overlap on its cable. */
export const TOOL_GAP = 0.25;

/** A sub-agent in one of these has sent its result back. */
const FINISHED: ReadonlySet<VillageActivity> = new Set(["done", "error"]);

/** What a view draws: the village of houses, or the city of buildings. */
export type Scene = "village" | "city";

/** A capacity building on screen (`VillageView.capacityBoxes`): whole CSS px relative to the canvas. */
export interface CapacityBox {
  kind: CapacityKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A neon sign on screen: its building, language and art box in whole CSS px relative to the
 * canvas. */
export interface NeonBox {
  building: string;
  language: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A landmark's crown on screen (`VillageView.landmarkBoxes`): whole CSS px relative to the canvas. */
export interface LandmarkBox {
  kind: LandmarkKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class VillageView {
  readonly sim: VillageSim;
  readonly scene: Scene;
  /** How far Fit may zoom out: a city may go below 1 to be seen whole; a village never does (it
   * would float in dark margins). */
  private readonly minZoom: number;
  private _world: World;
  private _cam: Camera = { zoom: 1, ox: 0, oy: 0 };
  private _view = { w: 0, h: 0 };
  private dpr = 1;
  private bank: SpriteBank | null = null;
  /** World size the camera was last fitted to; null = never fitted. */
  private fitted: { cols: number; rows: number } | null = null;
  /** True until the user pans or zooms (and again after Fit): the camera re-fits on every stage or
   * world change (see `autoFit`). */
  private follow = true;
  private last: number | null = null;
  private chars: CharacterView[] = [];
  /** The character under the pointer: its label is always drawn, whatever the crowd. */
  private hovered: string | null = null;
  /** Ground pre-painted per (world, art bank) pair, never per frame. `layer` null means the host
   * has no canvas (tiles are painted per frame); kept so it is not retried. */
  private ground: { world: World; art: SpriteBank | null; layer: GroundLayer | null } | null = null;
  private readonly makeLayer: MakeLayer;
  /** The sky this frame (null = none yet: the frame is drawn without any grade). */
  private amb: Ambience | null = null;
  private readonly fx: WeatherFx;
  /** The City's passers-by (engine/streetLife.ts) — decoration, never characters: not picked, not counted. */
  private readonly street: StreetLife;
  /** The City's cars, taxis and buses (engine/traffic.ts) — decoration, never characters: not picked, not counted. */
  private readonly traffic: TrafficFx;
  /** World px → "inside a house" (rain never falls through a roof into a room). */
  private indoors: (wx: number, wy: number) => boolean;
  /** City only: world px → street or roof, where a drop splashes (elsewhere it is open sky). */
  private splashes: ((wx: number, wy: number) => boolean) | undefined;
  /** What the capacity buildings show this frame (null = none yet: boards say only their names). */
  private capacity: CapacityFrame | null = null;
  /** Device px at the top of the view kept clear of the world at Fit (the HUD floats there). */
  private insetTop = 0;
  private insetCss = 0;
  /** The agents of the last `setAgents`, by key — what the next one is diffed against. */
  private roster = new Map<string, VillageAgent>();
  /** The LANs' recent traffic, handed to the draw list each frame; pruned after LAN_EVENT_TTL. */
  private events: LanEvent[] = [];
  /** A lounge city's sub-agents given a task but not yet at their desk; each task is stamped when
   * it first sits. */
  private awaiting = new Set<string>();

  /** `makeLayer` = where the ground layer is painted (tests inject a fake canvas). */
  constructor(seed = 1, makeLayer: MakeLayer = defaultMakeLayer, scene: Scene = "village") {
    this.makeLayer = makeLayer;
    this.scene = scene;
    this.minZoom = scene === "city" ? MIN_FIT_ZOOM : MIN_ZOOM;
    this.sim = new VillageSim({ seed, stayPut: scene === "city" });
    this.fx = new WeatherFx(seed);
    this.street = new StreetLife(seed);
    this.traffic = new TrafficFx(seed);
    this._world = scene === "city" ? buildCityWorld([]) : buildWorld([]);
    this.indoors = indoorTest(this._world);
    this.splashes = this.splashTest(this._world);
    this.sim.setWorld(this._world);
  }

  private splashTest(world: World): ((wx: number, wy: number) => boolean) | undefined {
    return world.city ? cityGround(world) : undefined;
  }

  get world(): World {
    return this._world;
  }

  get camera(): Camera {
    return this._cam;
  }

  /** Backing-store size in device px. */
  get view(): { w: number; h: number } {
    return this._view;
  }

  /** The character the pointer is over (null = none). */
  setHovered(key: string | null): void {
    this.hovered = key;
  }

  setBank(bank: SpriteBank | null): void {
    this.bank = bank;
  }

  /** Swap in a rebuilt world (the panel only calls this when the house plan changed). */
  setWorld(world: World): void {
    this._world = world;
    this.indoors = indoorTest(world);
    this.splashes = this.splashTest(world);
    this.sim.setWorld(world);
    this.autoFit();
  }

  /** Inputs for the capacity buildings and desks' context bars (cheap; call on any change). Lounge
   * holders keep their benches across calls. */
  setCapacity(input: CapacityInputs): void {
    this.capacity = capacityFrame(input, this.capacity);
    // The city's commuters: each holder's lounge bench (the sim ignores it without a lounge).
    const benches = new Map<string, number>();
    this.capacity.desks.forEach((h, i) => {
      if (h) benches.set(h.key, i);
    });
    this.sim.setLoungeSeats(benches);
  }

  /** This view's capacity picture (null before the first `setCapacity`). */
  get capacityFrame(): CapacityFrame | null {
    return this.capacity;
  }

  /** CSS px at the top of the stage that the HUD covers; Fit keeps the world below it. */
  setInset(topCss: number): void {
    this.insetCss = Math.max(0, topCss);
    this.insetTop = Math.round(this.insetCss * this.dpr);
    this.autoFit();
  }

  /** Time of day + weather (cheap; the panel calls it on every clock tick). */
  setAmbience(amb: Ambience): void {
    // A new zone brings (or takes away) a skyline whose tips Fit frames (`fitTarget`): a camera that
    // still follows the stage is refitted to it.
    const skyline = landmarksFor(amb.zone) !== landmarksFor(this.amb?.zone);
    this.amb = amb;
    this.sim.setAmbience(amb);
    if (skyline && this.follow) this.fit();
  }

  get ambience(): Ambience | null {
    return this.amb;
  }

  /** Where weather falls this frame, world px: the visible village, or for a city everything on
   * screen above the far sidewalk. */
  private weatherRect(): { x: number; y: number; w: number; h: number } {
    const city = this._world.city;
    if (!city) return this.visibleWorldRect();
    const a = screenToWorld(this._cam, 0, 0);
    const b = screenToWorld(this._cam, this._view.w, this._view.h);
    const bottom = Math.min(b.y, (city.street + 4) * TILE);
    return { x: a.x, y: a.y, w: Math.max(0, b.x - a.x), h: Math.max(0, bottom - a.y) };
  }

  /** The part of the world on screen, in world px, clipped to the village (w/h 0 = none). */
  visibleWorldRect(): { x: number; y: number; w: number; h: number } {
    const a = screenToWorld(this._cam, 0, 0);
    const b = screenToWorld(this._cam, this._view.w, this._view.h);
    const x = Math.max(0, a.x);
    const y = Math.max(0, a.y);
    const r = Math.min(this._world.cols * TILE, b.x);
    const btm = Math.min(this._world.rows * TILE, b.y);
    return { x, y, w: Math.max(0, r - x), h: Math.max(0, btm - y) };
  }

  /** Sets the roster, diffing it into LAN events: task (new sub-agent, known parent), result (turns
   * done/error), tool (`toolCalls` up). Off screen, changes only rebase. With a lounge, a task
   * stamps when its sub-agent first SITS; unseated results/tools are DROPPED. */
  setAgents(agents: VillageAgent[]): void {
    this.sim.setAgents(agents);
    this.chars = this.sim.characters();
    const prev = this.roster;
    this.roster = new Map(agents.map((a) => [a.key, a]));
    for (const key of this.awaiting) if (!this.roster.has(key)) this.awaiting.delete(key);
    if (this.last === null) return;
    const now = this.sim.time;
    // Who is at its desk now, in a city with a lounge (null: everyone counts, as without one).
    const atDesk = this._world.city?.lounge ? new Set(this.sim.seating().map((s) => s.key)) : null;
    for (const a of agents) {
      const was = prev.get(a.key);
      if (a.parentKey !== null && !was && prev.has(a.parentKey)) {
        if (atDesk) this.awaiting.add(a.key);
        else this.events.push({ kind: "task", key: a.key, at: now });
      }
      if (atDesk && !atDesk.has(a.key)) continue;
      if (a.parentKey !== null && was && !FINISHED.has(was.activity) && FINISHED.has(a.activity)) {
        this.events.push({ kind: "result", key: a.key, at: now });
      }
      if (was?.toolCalls !== undefined && a.toolCalls !== undefined && a.toolCalls > was.toolCalls) {
        this.toolPackets(a.key, a.toolCalls - was.toolCalls, now);
      }
    }
  }

  /** `calls` new tool calls of `key` as packets, TOOL_GAP apart after any still queued, never more
   * than TOOL_BURST waiting. */
  private toolPackets(key: string, calls: number, now: number): void {
    let next = now;
    let waiting = 0;
    for (const e of this.events) {
      if (e.kind !== "tool" || e.key !== key) continue;
      next = Math.max(next, e.at + TOOL_GAP);
      if (e.at >= now) waiting++;
    }
    const n = Math.min(calls, TOOL_BURST - waiting);
    for (let i = 0; i < n; i++) this.events.push({ kind: "tool", key, at: next + i * TOOL_GAP });
  }

  /** The canvas box changed (CSS px). Returns the backing-store size to give the canvas. */
  resize(cssW: number, cssH: number, dpr: number): { w: number; h: number } {
    this.dpr = dpr > 0 ? dpr : 1;
    this._view = { w: Math.round(cssW * this.dpr), h: Math.round(cssH * this.dpr) };
    this.insetTop = Math.round(this.insetCss * this.dpr);
    this.autoFit();
    return this._view;
  }

  /** Re-fit after a stage or world change. An untouched camera re-fits EVERY time (the first size
   * can be a sliver of a pane still being laid out); a user's camera is kept unless the world grew
   * or none of it is on screen. */
  private autoFit(): void {
    if (this._view.w <= 0 || this._view.h <= 0) return;
    const f = this.fitted;
    const grew = !f || this._world.cols > f.cols || this._world.rows > f.rows;
    const seen = this.visibleWorldRect();
    const lost = seen.w <= 0 || seen.h <= 0;
    if (this.follow || grew || lost) this.fit();
  }

  /** Largest zoom that shows the whole village or city, centred (a city may go below 1); the camera
   * then follows the stage again. A 0×0 stage leaves the camera alone. */
  fit(): void {
    this.follow = true;
    if (this._view.w <= 0 || this._view.h <= 0) return;
    this._cam = this.fitView();
    this.fitted = { cols: this._world.cols, rows: this._world.rows };
  }

  /** Fit's frame, world px: the whole village, or a city's buildings and street plus air, CENTRED
   * ON THE HQ if any (render/landmarks.ts uses the same span; a test pins both). Up to `FIT_SKY`
   * rows over the top roof and a tile over the tallest landmark's tip. */
  fitTarget(): { x: number; y: number; w: number; h: number } {
    const { cols, rows, city, houses } = this._world;
    const all = { x: 0, y: 0, w: cols * TILE, h: rows * TILE };
    if (!city || city.buildings.length === 0) return all;
    const tips = placeLandmarks(this._world, city.street * TILE, landmarksFor(this.amb?.zone)).placed.map((p) => Math.floor((p.base - p.h) / TILE) - 1);
    const r0 = Math.min(Math.max(0, Math.min(...city.buildings.map((b) => b.row)) - FIT_SKY), ...tips);
    const h = (rows - r0) * TILE;
    const first = Math.min(...city.buildings.map((b) => b.col));
    const last = Math.max(...city.buildings.map((b) => b.col + b.w));
    const hq = city.buildings.find((b) => b.hq);
    if (!hq) {
      const c0 = Math.max(0, first - FIT_AIR);
      const c1 = Math.min(cols, last + FIT_AIR);
      return { x: c0 * TILE, y: r0 * TILE, w: (c1 - c0) * TILE, h };
    }
    // An HQ comes with its lounge (both are the capacity layout); the lounge's walls stand a tile
    // outside its room.
    const room = houses.find((x) => x.capacity === "lounge") as World["houses"][number];
    const mid = hq.col + hq.w / 2;
    const half = Math.max(mid - Math.min(first, room.col - 1), Math.max(last, room.col + room.w + 1) - mid) + FIT_AIR;
    return { x: (mid - half) * TILE, y: r0 * TILE, w: 2 * half * TILE, h };
  }

  /** Camera fitting `fitTarget` below the HUD inset (at most half the view), centred; a target
   * taller than that space starts right under the HUD. */
  private fitView(): Camera {
    const r = this.fitTarget();
    const top = Math.min(this.insetTop, Math.floor(this._view.h / 2));
    const room = this._view.h - top;
    const cam = fitCamera(r.w, r.h, this._view.w, room, this.scene === "village" ? VILLAGE_MIN_FIT : this.minZoom);
    // A village taller than the room even at its floor: keep the civic row (the capacity houses) in
    // view — centred in the room, without leaving a gap above the world's top or below its bottom.
    const band = this.scene === "village" && r.h * cam.zoom > room ? this.civicBand() : null;
    if (band) {
      const z = cam.zoom;
      const centred = top + Math.round((room - (band.y1 - band.y0) * z) / 2) - band.y0 * z;
      const oy = Math.max(this._view.h - r.h * z, Math.min(top, centred));
      return { zoom: z, ox: cam.ox, oy };
    }
    // Overflowing with a HUD in the way: start right under it rather than centring its top behind it.
    const oy = top > 0 && r.h * cam.zoom > room ? top : cam.oy + top;
    return { zoom: cam.zoom, ox: cam.ox - r.x * cam.zoom, oy: oy - r.y * cam.zoom };
  }

  /** The village's civic row, world px from its name boards to the path below — null without one. */
  private civicBand(): { y0: number; y1: number } | null {
    const civic = this._world.houses.filter((h) => h.capacity);
    if (civic.length === 0) return null;
    return {
      y0: (Math.min(...civic.map((h) => h.row)) - CIVIC_ABOVE) * TILE,
      y1: (Math.max(...civic.map((h) => h.row + h.h)) + CIVIC_BELOW) * TILE,
    };
  }

  pan(dxCss: number, dyCss: number): void {
    if (dxCss === 0 && dyCss === 0) return;
    const c = this._cam;
    this._cam = { zoom: c.zoom, ox: c.ox + dxCss * this.dpr, oy: c.oy + dyCss * this.dpr };
    this.follow = false;
  }

  /** Zoom by `step` steps keeping the world point under the anchor (CSS px; default the centre)
   * fixed. Out stops at 1, or a city's whole-view zoom below 1. False when already at a limit. */
  zoomBy(step: number, anchorCss?: { x: number; y: number }): boolean {
    const c = this._cam;
    const floor = this._view.w > 0 && this._view.h > 0 ? Math.min(MIN_ZOOM, this.fitView().zoom) : MIN_ZOOM;
    const zoom = stepZoom(c.zoom, step, floor);
    if (zoom === c.zoom) return false;
    const sx = anchorCss ? anchorCss.x * this.dpr : this._view.w / 2;
    const sy = anchorCss ? anchorCss.y * this.dpr : this._view.h / 2;
    const p = screenToWorld(c, sx, sy);
    this._cam = { zoom, ox: Math.round(sx - p.x * zoom), oy: Math.round(sy - p.y * zoom) };
    this.follow = false;
    return true;
  }

  /** The capacity building under a pointer (CSS px relative to the canvas), or null: a village
   * capacity house (walls, board, doorstep) or a city HQ floor. */
  pickCapacity(xCss: number, yCss: number): CapacityKind | null {
    const p = screenToWorld(this._cam, xCss * this.dpr, yCss * this.dpr);
    const col = Math.floor(p.x / TILE);
    const row = Math.floor(p.y / TILE);
    for (const h of this._world.houses) {
      if (!h.capacity) continue;
      const box = this.capacityTiles(h);
      if (col >= box.c0 && col <= box.c1 && row >= box.r0 && row <= box.r1) return h.capacity;
    }
    return null;
  }

  /** The tiles (inclusive) a capacity building answers the pointer on — see `pickCapacity`. */
  private capacityTiles(h: World["houses"][number]): { c0: number; c1: number; r0: number; r1: number } {
    return this._world.city
      ? { c0: h.col, c1: h.col + h.w - 1, r0: h.row - 1, r1: h.row + h.h - 1 }
      : { c0: h.col - 1, c1: h.col + h.w, r0: h.row - 2, r1: h.doorRow + 1 };
  }

  /** Each capacity building's `pickCapacity` box in whole CSS px, clipped to the canvas, off-screen
   * ones left out. Published as `data-capacity-boxes` so the E2E can find canvas-only buildings. */
  capacityBoxes(): CapacityBox[] {
    const out: CapacityBox[] = [];
    for (const h of this._world.houses) {
      if (!h.capacity) continue;
      const t = this.capacityTiles(h);
      const box = this.screenBox(t.c0 * TILE, t.r0 * TILE, (t.c1 + 1) * TILE, (t.r1 + 1) * TILE);
      if (box) out.push({ kind: h.capacity, ...box });
    }
    return out;
  }

  /** On-screen art box of each neon sign the draw list paints, clipped to the canvas; off-screen or
   * unstyled ones are left out. Published as `data-neon-boxes` so the E2E proves a sign is DRAWN.
   */
  neonBoxes(): NeonBox[] {
    const out: NeonBox[] = [];
    for (const { item } of neonSigns(this._world)) {
      const s = neonLayout(item);
      if (!s) continue;
      const [x, y, w, h] = s.box;
      const box = this.screenBox(x, y, x + w, y + h);
      if (box) out.push({ building: item.building, language: item.language, ...box });
    }
    return out;
  }

  /** On-screen CROWN of each skyline landmark (the part no building may hide), clipped to the
   * canvas; temples and off-screen ones are left out. Published as `data-landmark-boxes` for the
   * E2E. */
  landmarkBoxes(): LandmarkBox[] {
    const city = this._world.city;
    if (!city) return [];
    const out: LandmarkBox[] = [];
    for (const p of placeLandmarks(this._world, city.street * TILE, landmarksFor(this.amb?.zone)).placed) {
      if (p.spec.layer === "near") continue;
      const c = landmarkCrown(p);
      const box = this.screenBox(c.x0, c.top, c.x1, c.bottom);
      if (box) out.push({ kind: p.spec.kind, ...box });
    }
    return out;
  }

  /** World px rect → whole CSS px relative to the canvas, clipped to it; null when none of it is on screen. */
  private screenBox(wx0: number, wy0: number, wx1: number, wy1: number): { x: number; y: number; w: number; h: number } | null {
    const a = worldToScreen(this._cam, wx0, wy0);
    const b = worldToScreen(this._cam, wx1, wy1);
    const x0 = Math.max(0, Math.round(a.x / this.dpr));
    const y0 = Math.max(0, Math.round(a.y / this.dpr));
    const x1 = Math.min(Math.round(this._view.w / this.dpr), Math.round(b.x / this.dpr));
    const y1 = Math.min(Math.round(this._view.h / this.dpr), Math.round(b.y / this.dpr));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** The character under a pointer (CSS px relative to the canvas), or null. */
  pick(xCss: number, yCss: number): string | null {
    const p = screenToWorld(this._cam, xCss * this.dpr, yCss * this.dpr);
    return hitTest(this.chars, p.x, p.y);
  }

  /** Forget the last frame time, so a resumed loop doesn't see the pause as one huge dt. */
  pause(): void {
    this.last = null;
  }

  /** One animation frame: advance the sim, then paint (skipped without a context). */
  frame(nowMs: number, ctx: DrawTarget | null): void {
    const dt = this.last === null ? 0 : (nowMs - this.last) / 1000;
    this.last = nowMs;
    this.sim.tick(dt);
    this.chars = this.sim.characters();
    const t = this.sim.time;
    this.events = this.events.filter((e) => t - e.at <= LAN_EVENT_TTL);
    // A commuter's task, stamped the moment it first sits at its desk (see `setAgents`).
    if (this.awaiting.size > 0)
      for (const s of this.sim.seating()) if (this.awaiting.delete(s.key)) this.events.push({ kind: "task", key: s.key, at: t });
    const amb = this.amb;
    if (amb) this.fx.update(dt, amb, this.weatherRect(), this.indoors, this.splashes);
    // The City's sidewalks: the stretch they walk holds the whole world and the view's span of the street;
    // the subway's stairs follow the train, on the frame clock the renderer draws it with (`nowMs`).
    this.street.update(dt, this._world, amb, screenToWorld(this._cam, 0, 0).x, screenToWorld(this._cam, this._view.w, 0).x, nowMs);
    // The City's road (none in the Village): its traffic yields to the agents on, or about to step on,
    // the HQ's crossing.
    this.traffic.update(dt, this._world, amb, this.chars, { x0: screenToWorld(this._cam, 0, 0).x, x1: screenToWorld(this._cam, this._view.w, 0).x });
    if (!ctx) return;
    const cap = this.capacity && {
      frame: this.capacity,
      seatOf: (key: string) => this.sim.seatFor(key),
      // The lounge benches a commuter is on, away from or heading back to: no waiter is drawn there.
      claims: this.sim.loungeClaims(),
    };
    const items = buildDrawList(
      this._world,
      this.chars,
      (id) => this.sim.pcOn(id),
      this.sim.time,
      this.hovered,
      cap,
      this.sim.seating(),
      this.events,
      this.street.walkers(),
      this.traffic.vehicles(),
    );
    const art = this.bank && !this.bank.fallback ? this.bank : null;
    let ground = this.ground;
    if (!ground || ground.world !== this._world || ground.art !== art) {
      const { cols, rows } = this._world;
      ground = { world: this._world, art, layer: paintGround(this.makeLayer, items, cols, rows, art) };
      this.ground = ground;
    }
    renderFrame(ctx, items, this._cam, this.bank, {
      w: this._view.w,
      h: this._view.h,
      timeMs: nowMs,
      ground: ground.layer,
      pixelRatio: this.dpr,
      // Always the world: a city paints its sky from it, ambience or not.
      world: this._world,
      ...(amb && { ambience: amb, particles: this.fx.particles(), flash: this.fx.flash() }),
    });
  }
}

// ───────────────────────────── HUD helpers ─────────────────────────────

export interface VillageCounts {
  ide: number;
  outside: number;
  /** Agents mid-turn: typing, reading, thinking or waiting on the user. */
  active: number;
}

const ACTIVE: ReadonlySet<VillageActivity> = new Set(["typing", "reading", "thinking", "waiting"]);

export function countAgents(agents: VillageAgent[]): VillageCounts {
  const out: VillageCounts = { ide: 0, outside: 0, active: 0 };
  for (const a of agents) {
    if (a.origin === "ide") out.ide++;
    else out.outside++;
    if (ACTIVE.has(a.activity)) out.active++;
  }
  return out;
}

/** The canvas's accessible name — the counts, in words. */
export function villageSummary(c: VillageCounts, sky?: { weather: WeatherKind | null; phase: DayPhase }): string {
  const base = `Agent Village: ${c.ide} in the IDE, ${c.outside} outside the IDE, ${c.active} active`;
  return sky ? `${base} — ${skySummary(sky.weather, sky.phase)}` : base;
}

/** "1 building", "3 floors": a count and its noun, singular when it is one. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The city canvas's accessible name: its buildings and floors, then the same counts and sky as the village's. */
export function citySummary(
  shape: { buildings: number; floors: number; consoles: number },
  c: VillageCounts,
  sky: { weather: WeatherKind | null; phase: DayPhase },
): string {
  const city = `${count(shape.buildings, "building")}, ${count(shape.floors, "floor")} (${count(shape.consoles, "console")})`;
  return `Agent City: ${city}; ${c.ide} agents in the IDE, ${c.outside} outside the IDE, ${c.active} active — ${skySummary(sky.weather, sky.phase)}`;
}

const SKY_WORD: Record<WeatherKind, string> = {
  clear: "Clear",
  cloudy: "Cloudy",
  fog: "Foggy",
  drizzle: "Drizzling",
  rain: "Raining",
  snow: "Snowing",
  storm: "Stormy",
};

/** The sky part of the canvas's accessible name ("Raining · afternoon"); `weather` null gives only
 * the time of day. */
export function skySummary(weather: WeatherKind | null, phase: DayPhase): string {
  return weather ? `${SKY_WORD[weather]} · ${phase}` : phase.charAt(0).toUpperCase() + phase.slice(1);
}

/** Stable plan signature: the world is rebuilt only when it changes, so the scene doesn't jump. */
export function planSignature(plans: readonly HousePlan[] | readonly CityPlan[]): string {
  return JSON.stringify(plans);
}

const ACTIVITY_WORD: Record<VillageActivity, string> = {
  typing: "Typing",
  reading: "Reading",
  thinking: "Thinking",
  waiting: "Waiting for you",
  idle: "Idle",
  done: "Done",
  error: "Error",
};

/** "Typing · Edit", "Idle". */
export function activityText(activity: VillageActivity, tool: string | null): string {
  const word = ACTIVITY_WORD[activity];
  return tool ? `${word} · ${tool}` : word;
}

/** A console's activity, in a shell's words (cityModel maps "something is running" onto these). */
export function consoleActivityText(activity: VillageActivity): string {
  if (activity === "typing") return "Running a command";
  if (activity === "thinking") return "Running claude";
  return "At the prompt";
}

/** "just now", "42s ago", "3 min ago", "2 h ago", "4 d ago". */
export function agoText(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
