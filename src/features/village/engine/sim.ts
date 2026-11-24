/**
 * VillageSim — the character simulation (pixel-agents' OfficeState + character
 * FSM, reimplemented for a village of houses).
 *
 * Three states, as in pixel-agents: IDLE (standing), WALK (following a BFS
 * path) and TYPE (at work — at a desk, or in place for sub-agents and agents
 * without a seat). Everything else is derived for the renderer in
 * `characters()`:
 *
 *   typing / thinking → walk to own seat, type      reading → same, read anim
 *   waiting           → sit at seat, sticky "waiting" bubble
 *   idle              → stand up, wander (house / plaza / campfire), pause
 *                       2–20 s, go home to rest every 3–6 moves
 *   done / error      → like idle, plus a 2 s bubble that fades over 0.5 s
 *
 * Sub-agents sit at the TEAM TABLES of their root's house (`Seat.forSub`), each at
 * its own laptop — the free sub seat nearest the parent's seat. They spawn right on
 * it, type/read there while working, and stay seated (resting) when idle/done; roots
 * never take a sub seat and sub-agents never take a desk. Only when every sub seat is
 * taken does a sub-agent fall back to the nearest free tile next to its parent, typing
 * where it stands (it moves to a sub seat as soon as one frees up). Every character
 * gets its OWN look (`pickPalette` over all live characters), so a parent and its
 * sub-agents never read as clones. New characters play a 0.3 s spawn effect; removed
 * ones a 0.3 s despawn effect, then vanish.
 *
 * Ambience (`setAmbience`): in bad weather or at night (`Ambience.stayIndoors`) idle
 * wandering only ever targets tiles inside the agent's own house, and anyone strolling
 * outside when the rain starts turns around and walks back in through the door.
 *
 * `stayPut` (the city view): roots keep their desk too — an idle or finished leader rests
 * in its chair, lights off, exactly like a sub-agent; nobody wanders a floor.
 *
 * The COMMUTE (a city with a lounge, `World.city.lounge`: agents wait
 * in the lounge under the street; one that is needed rides an elevator up to the street and goes
 * to its building, and when done it returns the same way and sits down to wait again). There a
 * SUB-AGENT lives in two places: its BENCH in the lounge (the seat number the view
 * hands over with `setLoungeSeats` — its capacity desk) and its desk on its leader's floor. It
 * appears ON its bench (spawn effect), and while busy travels the route of engine/commute.ts to its
 * desk — down to the aisle, the lounge's lift up to the far sidewalk, across the road, along the near
 * sidewalk, in at its building's door, up that lift, along the seat's row — and sits and works there
 * as ever (its PC lights only once it is seated). Done / error / idle at its desk, it stays seated
 * `RESULT_BEAT` (its result packet leaves from that desk — the team LAN wires only seated agents),
 * then goes back the same way and sits on its bench until it is removed. Finishing (or getting busy
 * again) mid-trip turns it round where it is; removed mid-trip, it despawns where it is; a world
 * rebuild re-routes it from where it stands (engine/commute.ts `project`) — never a teleport to its
 * desk. A bench another character already claims is never shared: a newcomer then takes the first
 * bench nobody claims, and with none left it stands at the lounge lift's lowest stop. Roots never
 * commute (`stayPut`: they keep their floor's desk). Without a lounge none of this applies.
 *
 * Pure and deterministic: time only advances through `tick(dt)` and all
 * randomness comes from a seeded mulberry32. `tick` allocates nothing on the
 * steady-state path (paths are only computed at decision points).
 */

import { TILE, type Ambience, type CharacterAnim, type CharacterView, type CityLounge, type Dir, type Seat, type SeatedAgent, type VillageActivity, type VillageAgent, type VillageOrigin, type World } from "../villageTypes";
import { advance, benchTiles, commuteRoute, facing, legLength, LEGS, place, project, riding, type Cursor, type Route } from "./commute";
import { MAX_TRIP } from "./lan";
import { pickPalette, type PaletteChoice } from "./palette";
import { findPath, type Tile } from "./path";
import { intRange, mulberry32, range, type Rng } from "./rng";
import { buildWorld, isIndoorTile, rootOf, walkGrid } from "./world";

/** Walk speed, px per second (3 tiles/s). */
export const WALK_SPEED = 48;
export const WALK_FRAME_SEC = 0.15;
export const TYPE_FRAME_SEC = 0.3;
export const FX_SEC = 0.3;
export const BUBBLE_SEC = 2;
export const BUBBLE_FADE_SEC = 0.5;
export const MAX_DT = 0.1;
/** Seated characters are drawn this many px lower, sinking into the chair. Baked into `CharacterView.y`. */
export const SIT_OFFSET = 6;
const WANDER_PAUSE: [number, number] = [2, 20];
const WANDER_MOVES: [number, number] = [3, 6];
/** Rest at the desk after walking home on its own. */
const HOME_REST: [number, number] = [20, 60];
/** Rest after being placed at the desk (spawn / world rebuild) while not working. */
const PLACED_REST: [number, number] = [2, 8];
/**
 * Seconds a commuter that finished stays seated at its desk before it heads back to the lounge: the
 * longest a LAN packet takes (`MAX_TRIP`), so its RESULT packet — which the team LAN draws only
 * between SEATED agents (`seating`) — leaves from its desk instead of vanishing as it stands up.
 */
export const RESULT_BEAT = MAX_TRIP;
/** A commuter's walk frames step faster in proportion to its brisk walk (engine/commute.ts COMMUTE_WALK). */
export const COMMUTE_FRAME_SEC = WALK_FRAME_SEC / 2.5;

/**
 * `bench` (a commuter): sitting on its lounge bench — or, with none, standing at the lounge lift's
 * lowest stop; `commute`: on its way between the bench and its desk (`Char.trip`).
 */
type State = "idle" | "walk" | "type" | "bench" | "commute";

/** A commuter's trip: its route and where on it it is. */
interface Trip {
  route: Route;
  cur: Cursor;
}

interface Char {
  key: string;
  isSub: boolean;
  parentKey: string | null;
  origin: VillageOrigin;
  label: string;
  tool: string | null;
  folder: string;
  activity: VillageActivity;
  palette: number;
  hueShift: number;
  state: State;
  col: number;
  row: number;
  x: number;
  y: number;
  dir: Dir;
  path: Tile[];
  pathIdx: number;
  progress: number;
  frame: number;
  frameTimer: number;
  seatId: string | null;
  seated: boolean;
  resting: boolean;
  restTimer: number;
  goingHome: boolean;
  wanderTimer: number;
  wanderCount: number;
  wanderLimit: number;
  bubble: "waiting" | "done" | "error" | null;
  bubbleTimer: number;
  fx: "spawn" | "despawn" | null;
  fxT: number;
  /** A commuter's lounge bench (its seat number), or null: none — it waits at the lounge lift's lowest stop. */
  bench: number | null;
  /** A commuter's current trip (state `commute`); its last one otherwise. */
  trip: Trip | null;
}

/** Activities that send a character to its desk. */
function isActive(a: VillageActivity): boolean {
  return a === "typing" || a === "reading" || a === "thinking" || a === "waiting";
}

/** Activities that light up the pc in front of the seat. */
function isWorking(a: VillageActivity): boolean {
  return a === "typing" || a === "reading" || a === "thinking";
}

function dirBetween(from: Tile, to: Tile): Dir {
  if (to.col > from.col) return "right";
  if (to.col < from.col) return "left";
  return to.row < from.row ? "up" : "down";
}

export class VillageSim {
  private rng: Rng;
  private _time = 0;
  private world!: World;
  private chars = new Map<string, Char>();
  private seatById = new Map<string, Seat>();
  private seatsByHouse = new Map<string, Seat[]>();
  private seatOwner = new Map<string, string>();
  private pcSeat = new Map<string, string>();
  private houseTiles = new Map<string, Tile[]>();
  private plazaTiles: Tile[] = [];
  private fireTiles: Tile[] = [];
  /** Ambience.stayIndoors: idle wandering is confined to the house interior. */
  private indoorsOnly = false;
  /** Roots never leave their seat (the city): see the module note. */
  private readonly stayPut: boolean;
  /** The lounge's bench tiles by seat number (a city with a lounge; else empty). */
  private benches: Tile[] = [];
  /** Who holds which lounge bench (`setLoungeSeats`: agent key → seat number). */
  private loungeSeats: ReadonlyMap<string, number> = new Map();
  /** `loungeClaims`' answer, refilled on each call (no allocation per frame). */
  private claims = new Set<number>();

  constructor(opts: { seed?: number; stayPut?: boolean } = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    this.stayPut = opts.stayPut ?? false;
    this.indexWorld(buildWorld([]));
  }

  /** Seconds of simulated time (sum of clamped `tick` deltas). */
  get time(): number {
    return this._time;
  }

  /**
   * Swap in a rebuilt world. Seat ids are stable across rebuilds (`<house>:seat:<i>`),
   * so assignments survive; a seat that vanished or moved house is reassigned.
   * Every character is re-placed (house positions shift when houses are added).
   */
  setWorld(world: World): void {
    this.indexWorld(world);
    for (const c of this.chars.values()) {
      const seat = c.seatId ? this.seatById.get(c.seatId) : undefined;
      if (c.seatId && seat?.houseKey !== this.homeOf(c)) this.releaseSeat(c);
    }
    this.assignSeats();
    for (const c of this.chars.values()) if (!c.isSub && c.fx !== "despawn") this.placeHome(c);
    for (const c of this.liveSubs()) if (!c.seatId) this.assignSubSeat(c);
    for (const c of this.liveSubs()) this.resettle(c);
  }

  /**
   * Who holds which bench of the city's lounge — agent key → seat number (the capacity frame's
   * desk index; `VillageView` hands it over whenever the desks change). A sub-agent still appearing
   * on its bench moves to the one it holds (the view sends the seats right AFTER the agents, so a
   * newcomer first sits on the first free bench); one that has left keeps the bench it left from.
   */
  setLoungeSeats(seats: ReadonlyMap<string, number>): void {
    this.loungeSeats = seats;
    const appearing = [...this.chars.values()].filter((c) => c.state === "bench" && c.fx === "spawn");
    // Their first picks were made without these seats: let go of them all, give each the bench it
    // holds where nobody else is, and only then the rest a free one — so a newcomer's guess never
    // keeps another newcomer off the bench it holds (the first roster of a city is all newcomers).
    for (const c of appearing) c.bench = null;
    for (const c of appearing) {
      const want = seats.get(c.key);
      if (want !== undefined && this.benchFree(want, c)) c.bench = want;
    }
    for (const c of appearing) {
      if (c.bench === null) c.bench = this.pickBench(c);
      this.toBench(c);
    }
  }

  /**
   * The lounge benches a character is on, leaving from, away from or heading back to — every
   * commuter's, despawning ones included (they are still drawn there). The lounge draws no waiter
   * on them. The same Set, refilled on every call: read it before the next.
   */
  loungeClaims(): ReadonlySet<number> {
    this.claims.clear();
    for (const c of this.chars.values()) if (c.bench !== null) this.claims.add(c.bench);
    return this.claims;
  }

  /** Reconcile with the current agent list: spawn new, update existing, despawn missing. */
  setAgents(agents: VillageAgent[]): void {
    const seen = new Set<string>();
    for (const a of agents) seen.add(a.key);
    for (const c of this.chars.values()) if (!seen.has(c.key) && c.fx !== "despawn") this.despawn(c);
    // Roots first (seats are then handed out in key order, whatever the input order),
    // then sub-agents, which spawn next to their already-placed parents.
    const fresh: Char[] = [];
    for (const a of agents) if (a.parentKey === null) this.upsert(a, fresh);
    this.assignSeats();
    for (const c of fresh) this.placeHome(c);
    for (const a of agents) if (a.parentKey !== null) this.upsert(a, fresh);
    // Overflow sub-agents (seatless) move to a team seat freed by a departure.
    for (const c of this.liveSubs()) {
      if (c.seatId || !this.assignSubSeat(c)) continue;
      if (c.state === "type") this.toIdle(c); // the next tick walks it to the new seat
    }
  }

  /**
   * Apply the sky. When `stayIndoors` switches on, every idle or strolling root that is
   * (or is heading) outdoors walks back into its house; from then on wandering never
   * targets an outdoor tile. Switching it off just lets them roam again.
   */
  setAmbience(amb: Ambience): void {
    const was = this.indoorsOnly;
    this.indoorsOnly = amb.stayIndoors;
    if (!amb.stayIndoors || was) return;
    for (const c of this.chars.values()) this.headInside(c);
  }

  /** Advance the simulation. `dtSec` is clamped to [0, 0.1] so a backgrounded tab can't fling anyone through walls. */
  tick(dtSec: number): void {
    const dt = Math.min(Math.max(dtSec, 0), MAX_DT);
    this._time += dt;
    for (const c of this.chars.values()) this.update(c, dt);
  }

  /** A fresh render snapshot of every character (despawning ones included, with their fx). */
  characters(): CharacterView[] {
    const out: CharacterView[] = [];
    for (const c of this.chars.values()) {
      let anim: CharacterAnim = "idle";
      const rides = c.state === "commute" && riding((c.trip as Trip).route, (c.trip as Trip).cur);
      if (c.state === "walk" || (c.state === "commute" && !rides)) anim = "walk";
      else if (c.state === "type" && !c.resting && c.activity !== "waiting")
        anim = c.activity === "reading" ? "read" : "type";
      const view: CharacterView = {
        key: c.key,
        x: c.x,
        y: c.y + (c.seated ? SIT_OFFSET : 0),
        dir: c.dir,
        anim,
        frame: anim === "idle" ? 0 : c.frame,
        palette: c.palette,
        hueShift: c.hueShift,
        seated: c.seated,
        origin: c.origin,
        isSubagent: c.isSub,
        activity: c.activity,
        label: c.label,
        tool: c.tool,
        bubble: c.bubble,
        bubbleAlpha: c.bubble ? Math.min(1, c.bubbleTimer / BUBBLE_FADE_SEC) : 0,
        fx: c.fx ? { kind: c.fx, t: Math.min(1, c.fxT) } : null,
      };
      if (rides) view.riding = true;
      out.push(view);
    }
    return out;
  }

  /**
   * Who is SEATED where right now — at its seat, not walking to or from it (a despawn releases the
   * seat, so the departing are never listed), not travelling, not on a lounge bench; resting sitters
   * included (the room's LAN still connects them). Roster order. What a project room's LAN
   * (engine/teamLan.ts) wires up.
   */
  seating(): SeatedAgent[] {
    const out: SeatedAgent[] = [];
    for (const c of this.chars.values())
      if (c.state === "type" && c.seated && c.seatId) out.push({ key: c.key, parentKey: c.parentKey, activity: c.activity, seatId: c.seatId });
    return out;
  }

  /** The seat `key` holds (its desk, where its context bar goes), or null: no such character, or no seat. */
  seatFor(key: string): Seat | null {
    const c = this.chars.get(key);
    return (c && this.seatOf(c)) ?? null;
  }

  /** Is this pc switched on? True when its seat's occupant is sitting THERE working (not on its lounge bench). */
  pcOn(propId: string): boolean {
    const seatId = this.pcSeat.get(propId);
    const owner = seatId ? this.seatOwner.get(seatId) : undefined;
    const c = owner ? this.chars.get(owner) : undefined;
    return !!c && c.state === "type" && c.seated && !c.resting && isWorking(c.activity);
  }

  // ───────────────────────────── world indexing ─────────────────────────────

  private indexWorld(world: World): void {
    this.world = world;
    this.benches = benchTiles(world);
    const grid = walkGrid(world);
    const ok = (c: number, r: number) =>
      c >= 0 && r >= 0 && c < world.cols && r < world.rows && grid[r * world.cols + c] === 1;
    this.seatById.clear();
    this.seatsByHouse.clear();
    this.pcSeat.clear();
    for (const s of world.seats) {
      this.seatById.set(s.id, s);
      const list = this.seatsByHouse.get(s.houseKey) ?? [];
      list.push(s);
      this.seatsByHouse.set(s.houseKey, list);
      if (s.pcId) this.pcSeat.set(s.pcId, s.id);
    }
    this.houseTiles.clear();
    for (const h of world.houses) {
      const tiles: Tile[] = [];
      for (let r = h.row; r < h.row + h.h; r++) for (let c = h.col; c < h.col + h.w; c++) if (ok(c, r)) tiles.push({ col: c, row: r });
      this.houseTiles.set(h.key, tiles);
    }
    this.plazaTiles = [];
    for (let r = 0; r < world.rows; r++)
      for (let c = 0; c < world.cols; c++) if (world.tiles[r * world.cols + c] === "plaza" && ok(c, r)) this.plazaTiles.push({ col: c, row: r });
    this.fireTiles = [];
    for (const p of world.props) {
      if (p.kind !== "campfire") continue;
      for (let r = p.row - 1; r <= p.row + 1; r++) for (let c = p.col - 1; c <= p.col + 1; c++) if (ok(c, r)) this.fireTiles.push({ col: c, row: r });
    }
  }

  // ───────────────────────────── roster ─────────────────────────────

  /** Update or create a character. New roots are queued on `fresh` for seating + placement. */
  private upsert(a: VillageAgent, fresh: Char[]): void {
    const existing = this.chars.get(a.key);
    if (existing) {
      if (existing.fx === "despawn") {
        existing.fx = "spawn";
        existing.fxT = 0;
      }
      existing.label = a.title;
      existing.tool = a.tool;
      existing.origin = a.origin;
      if (!existing.isSub && existing.folder !== a.folder) {
        this.releaseSeat(existing);
        existing.goingHome = false;
        existing.folder = a.folder;
        if (existing.state === "type") this.standUp(existing);
      }
      this.setActivity(existing, a.activity);
      return;
    }

    const isSub = a.parentKey !== null;
    const used: PaletteChoice[] = [];
    for (const o of this.chars.values()) if (o.fx !== "despawn") used.push({ palette: o.palette, hueShift: o.hueShift });
    const { palette, hueShift } = pickPalette(a.key, used);
    const c: Char = {
      key: a.key,
      isSub,
      parentKey: a.parentKey,
      origin: a.origin,
      label: a.title,
      tool: a.tool,
      folder: a.folder,
      activity: a.activity,
      palette,
      hueShift,
      state: "idle",
      col: 0,
      row: 0,
      x: 0,
      y: 0,
      dir: "down",
      path: [],
      pathIdx: 0,
      progress: 0,
      frame: 0,
      frameTimer: 0,
      seatId: null,
      seated: false,
      resting: false,
      restTimer: 0,
      goingHome: false,
      wanderTimer: 0,
      wanderCount: 0,
      wanderLimit: 0,
      bubble: null,
      bubbleTimer: 0,
      fx: "spawn",
      fxT: 0,
      bench: null,
      trip: null,
    };
    this.chars.set(c.key, c);
    this.applyBubble(c, a.activity);
    if (isSub) {
      this.assignSubSeat(c);
      // A commuter appears ON its lounge bench, as the waiter there would stand up.
      if (this.commutes(c)) {
        c.bench = this.pickBench(c);
        this.toBench(c);
      } else this.placeSub(c);
    } else fresh.push(c);
  }

  private despawn(c: Char): void {
    c.fx = "despawn";
    c.fxT = 0;
    this.releaseSeat(c);
  }

  private setActivity(c: Char, act: VillageActivity): void {
    if (act === c.activity) return;
    c.activity = act;
    this.applyBubble(c, act);
    // A traveller turns round where it is: busy → towards its desk, finished → back to its bench.
    if (c.state === "commute") {
      (c.trip as Trip).cur.dir = isActive(act) ? 1 : -1;
      return;
    }
    if (isActive(act)) c.resting = false;
    else if (c.state === "type") {
      // A seated sub-agent stays at its laptop (lid dark) until it despawns; in the city
      // (`stayPut`) so does a leader. A commuter only for its result's beat, then it heads back.
      if (this.keepsSeat(c) && c.seated) {
        c.resting = true;
        c.restTimer = this.commutes(c) ? RESULT_BEAT : Infinity;
      } else this.standUp(c);
    }
  }

  private applyBubble(c: Char, act: VillageActivity): void {
    if (act === "waiting") {
      c.bubble = "waiting";
      c.bubbleTimer = Infinity;
    } else if (act === "done" || act === "error") {
      c.bubble = act;
      c.bubbleTimer = BUBBLE_SEC + BUBBLE_FADE_SEC;
    } else if (act !== "idle" || c.bubble === "waiting") {
      c.bubble = null;
    }
  }

  // ───────────────────────────── seats ─────────────────────────────

  /** Seat every live root that has none, in key order (so the result doesn't depend on arrival order within a batch). */
  private assignSeats(): void {
    const needy = [...this.chars.values()].filter((c) => !c.isSub && !c.seatId && c.fx !== "despawn");
    needy.sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const c of needy) this.assignSeat(c);
  }

  /** First free (non-team) seat in the agent's house, preferring one with a pc. */
  private assignSeat(c: Char): void {
    const seats = this.seatsByHouse.get(c.folder);
    if (!seats) return;
    let pick: Seat | undefined;
    for (const s of seats) {
      if (s.forSub || this.seatOwner.has(s.id)) continue;
      if (s.pcId) {
        pick = s;
        break;
      }
      pick ??= s;
    }
    if (!pick) return;
    c.seatId = pick.id;
    this.seatOwner.set(pick.id, c.key);
  }

  /** Live (not despawning) sub-agents, in roster order. */
  private liveSubs(): Char[] {
    return [...this.chars.values()].filter((c) => c.isSub && c.fx !== "despawn");
  }

  /** The house a character belongs to: its own folder for a root, its ROOT's for a sub-agent (null: unknown root). */
  private homeOf(c: Char): string | null {
    if (!c.isSub) return c.folder;
    return rootOf(c, this.chars)?.folder ?? null;
  }

  /**
   * Give sub-agent `c` the free team seat in its root's house nearest its parent's
   * seat (or the parent itself when it has none); ties go to the first in layout
   * order. Returns whether a seat was taken.
   */
  private assignSubSeat(c: Char): boolean {
    const home = this.homeOf(c);
    const seats = home === null ? undefined : this.seatsByHouse.get(home);
    if (!seats) return false;
    const parent = this.chars.get(c.parentKey as string) as Char;
    const anchor: Tile = this.seatOf(parent) ?? parent;
    let pick: Seat | undefined;
    let best = Infinity;
    for (const s of seats) {
      if (!s.forSub || this.seatOwner.has(s.id)) continue;
      const d = Math.abs(s.col - anchor.col) + Math.abs(s.row - anchor.row);
      if (d < best) {
        best = d;
        pick = s;
      }
    }
    if (!pick) return false;
    c.seatId = pick.id;
    this.seatOwner.set(pick.id, c.key);
    return true;
  }

  private releaseSeat(c: Char): void {
    if (c.seatId) this.seatOwner.delete(c.seatId);
    c.seatId = null;
    // Its desk, that is: one sitting on its lounge bench stays sitting there (a despawn plays on the bench).
    if (c.state !== "bench") c.seated = false;
  }

  private seatOf(c: Char): Seat | undefined {
    return c.seatId ? this.seatById.get(c.seatId) : undefined;
  }

  // ───────────────────────────── placement ─────────────────────────────

  private setTile(c: Char, col: number, row: number): void {
    c.col = col;
    c.row = row;
    c.x = col * TILE + TILE / 2;
    c.y = row * TILE + TILE;
  }

  private placeHome(c: Char): void {
    const seat = this.seatOf(c);
    if (seat) {
      if (isActive(c.activity)) this.sit(c, seat);
      else this.rest(c, seat, PLACED_REST);
      return;
    }
    const house = this.world.houses.find((h) => h.key === c.folder);
    const start = house ? { col: house.doorCol, row: house.doorRow - 1 } : this.world.plaza;
    const t = this.nearestFree(start, c);
    this.setTile(c, t.col, t.row);
    this.toIdle(c);
  }

  /** A sub-agent at its team seat (working, or resting with the lid dark); next to its parent without one. */
  private placeSub(c: Char): void {
    const seat = this.seatOf(c);
    if (!seat) return this.placeNearParent(c);
    if (isActive(c.activity)) this.sit(c, seat);
    else this.rest(c, seat, PLACED_REST);
  }

  private placeNearParent(c: Char): void {
    const parent = this.chars.get(c.parentKey as string);
    // Never on the tile right below the parent: drawn in front of it (2.5D), a sub-agent
    // there hides its parent's whole body — the one character the cluster is about.
    const below = parent ? { col: parent.col, row: parent.row + 1 } : null;
    const t = this.nearestFree(parent ?? this.world.plaza, c, below);
    this.setTile(c, t.col, t.row);
    if (parent) c.dir = parent.dir;
    this.toIdle(c);
  }

  /**
   * BFS from `start` over walkable tiles (the start itself may be a chair) to the
   * first walkable tile no other live character stands on, passing over `avoid` while
   * any other free tile is reachable. Falls back to `start`.
   */
  private nearestFree(start: Tile, self: Char, avoid: Tile | null = null): Tile {
    const { cols } = this.world;
    const taken = new Set<number>();
    for (const o of this.chars.values()) if (o !== self && o.fx !== "despawn") taken.add(o.row * cols + o.col);
    if (avoid) {
      const found = this.bfsFree(start, new Set([...taken, avoid.row * cols + avoid.col]));
      if (found) return found;
    }
    return this.bfsFree(start, taken) ?? start;
  }

  /** The first walkable tile not in `taken`, breadth-first from `start`; null when none. */
  private bfsFree(start: Tile, taken: Set<number>): Tile | null {
    const { cols, rows } = this.world;
    const grid = walkGrid(this.world);
    const s = start.row * cols + start.col;
    const seen = new Uint8Array(cols * rows);
    const queue = [s];
    seen[s] = 1;
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (grid[cur] === 1 && !taken.has(cur)) return { col: cur % cols, row: Math.floor(cur / cols) };
      const c = cur % cols;
      const r = Math.floor(cur / cols);
      const next = [
        [c, r - 1],
        [c, r + 1],
        [c - 1, r],
        [c + 1, r],
      ];
      for (const [nc, nr] of next) {
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (seen[ni] || grid[ni] !== 1) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    return null;
  }

  // ───────────────────────────── state changes ─────────────────────────────

  private sit(c: Char, seat: Seat): void {
    this.setTile(c, seat.col, seat.row);
    c.state = "type";
    c.seated = true;
    c.resting = false;
    c.goingHome = false;
    c.dir = seat.facing;
    c.frame = 0;
    c.frameTimer = 0;
    c.path = [];
  }

  private rest(c: Char, seat: Seat, span: [number, number]): void {
    this.sit(c, seat);
    c.resting = true;
    // A sub-agent never wanders: it rests at its laptop until it works again or despawns — or, a
    // commuter, until its result's beat is over and it heads back to the lounge.
    if (this.commutes(c)) c.restTimer = RESULT_BEAT;
    else c.restTimer = this.keepsSeat(c) ? Infinity : range(this.rng, span[0], span[1]);
  }

  /** Sub-agents never leave their seat; with `stayPut`, nobody does. */
  private keepsSeat(c: Char): boolean {
    return c.isSub || this.stayPut;
  }

  private typeInPlace(c: Char): void {
    this.setTile(c, c.col, c.row);
    c.state = "type";
    c.seated = false;
    c.resting = false;
    c.frame = 0;
    c.frameTimer = 0;
    c.path = [];
  }

  private toIdle(c: Char): void {
    c.state = "idle";
    c.seated = false;
    c.resting = false;
    c.goingHome = false;
    c.frame = 0;
    c.path = [];
    c.wanderTimer = range(this.rng, WANDER_PAUSE[0], WANDER_PAUSE[1]);
  }

  private standUp(c: Char): void {
    this.toIdle(c);
    c.wanderCount = 0;
    c.wanderLimit = intRange(this.rng, WANDER_MOVES[0], WANDER_MOVES[1]);
  }

  private walk(c: Char, path: Tile[]): void {
    c.state = "walk";
    c.seated = false;
    c.resting = false;
    c.path = path;
    c.pathIdx = 0;
    c.progress = 0;
    c.frame = 0;
    c.frameTimer = 0;
  }

  /** Active and not at work yet: go to the seat, or type where you stand. */
  private startWork(c: Char): void {
    const seat = this.seatOf(c);
    if (!seat) return this.typeInPlace(c);
    if (c.col === seat.col && c.row === seat.row) return this.sit(c, seat);
    const path = findPath(this.world, c, seat, undefined, seat);
    if (path) this.walk(c, path);
    else this.typeInPlace(c);
  }

  private wander(c: Char): void {
    c.wanderTimer = range(this.rng, WANDER_PAUSE[0], WANDER_PAUSE[1]);
    const seat = this.seatOf(c);
    if (seat && c.wanderCount >= c.wanderLimit) {
      c.wanderCount = 0;
      c.wanderLimit = intRange(this.rng, WANDER_MOVES[0], WANDER_MOVES[1]);
      const path = findPath(this.world, c, seat, undefined, seat);
      if (path?.length === 0) this.rest(c, seat, HOME_REST);
      else if (path) {
        this.walk(c, path);
        c.goingHome = true;
      }
      return;
    }
    const roll = this.rng();
    const house = this.houseTiles.get(c.folder);
    let pool = this.plazaTiles;
    if (this.indoorsOnly) pool = house ?? [];
    else if (roll < 0.45 && house?.length) pool = house;
    else if (roll >= 0.8 && this.fireTiles.length) pool = this.fireTiles;
    if (pool.length === 0) return;
    const target = pool[Math.floor(this.rng() * pool.length)];
    const path = findPath(this.world, c, target);
    if (path?.length) {
      c.wanderCount++;
      this.walk(c, path);
    }
  }

  /** Bad weather: an idle/strolling root outdoors (or walking out) heads for a tile inside its house. */
  private headInside(c: Char): void {
    // Working roots head for their desks anyway; sub-agents never wander; sitters are inside.
    if (c.isSub || c.fx === "despawn" || isActive(c.activity) || c.state === "type" || c.goingHome) return;
    const at = c.state === "walk" ? c.path[c.path.length - 1] : c;
    if (isIndoorTile(this.world, at.col, at.row)) return;
    const house = this.houseTiles.get(c.folder);
    if (!house?.length) return;
    const target = house[Math.floor(this.rng() * house.length)];
    if (c.state === "walk") {
      // Mid-step: finish entering the next tile (keep `progress`, no snap back to
      // the last tile reached), then carry on home from there.
      const from = c.path[c.pathIdx];
      const path = findPath(this.world, from, target);
      if (!path) return;
      c.path = [from, ...path];
      c.pathIdx = 0;
      return;
    }
    const path = findPath(this.world, c, target);
    if (!path?.length) return;
    this.walk(c, path);
  }

  private arrive(c: Char): void {
    c.path = [];
    if (isActive(c.activity)) return this.startWork(c);
    // goingHome ⇔ the path ended at our seat (folder changes clear it), so we're on it.
    if (c.goingHome) return this.rest(c, this.seatOf(c) as Seat, HOME_REST);
    this.toIdle(c);
  }

  // ───────────────────────────── the commute (a city with a lounge) ─────────────────────────────

  /** A sub-agent in a city with a lounge: it commutes between its bench and its desk. */
  private commutes(c: Char): boolean {
    return c.isSub && !!this.world.city?.lounge;
  }

  /**
   * The bench `c` should use: the one it holds (`setLoungeSeats`) unless another character already
   * claims it; else the first bench no character claims; else none (null). Claims alone keep two
   * characters off one bench, whatever the holders say: a holder already in the sim has its own bench.
   */
  private pickBench(c: Char): number | null {
    const want = this.loungeSeats.get(c.key);
    if (want !== undefined && this.benchFree(want, c)) return want;
    for (let i = 0; i < this.benches.length; i++) if (this.benchFree(i, c)) return i;
    return null;
  }

  /** Bench `i` exists in this world and no character but `c` is on it, away from it or heading to it. */
  private benchFree(i: number, c: Char): boolean {
    if (i >= this.benches.length) return false;
    for (const o of this.chars.values()) if (o !== c && o.bench === i) return false;
    return true;
  }

  /** Sit `c` on its bench, facing us — or, with no bench, stand at the lounge lift's lowest stop. */
  private toBench(c: Char): void {
    const lift = (this.world.city?.lounge as CityLounge).lift;
    const at = c.bench === null ? { col: lift.col, row: lift.bottom } : this.benches[c.bench];
    this.setTile(c, at.col, at.row);
    c.state = "bench";
    c.seated = c.bench !== null;
    c.resting = false;
    c.dir = "down";
    c.frame = 0;
    c.path = [];
  }

  /** Its route between its bench and its desk in this world; null without a desk. */
  private routeFor(c: Char): Route | null {
    const seat = this.seatOf(c);
    return seat ? commuteRoute(this.world, c.bench === null ? null : this.benches[c.bench], seat) : null;
  }

  /** Busy on its bench: off to its desk — once it has one (until then it waits where it is). */
  private leaveBench(c: Char): void {
    const route = this.routeFor(c);
    if (!route) return;
    this.travelFrom(c, { route, cur: { leg: 0, d: 0, dir: 1 } });
  }

  /** Done at its desk (its result's beat over): back to the lounge — to a bench, if it had none. */
  private leaveDesk(c: Char): void {
    if (c.bench === null) c.bench = this.pickBench(c);
    const route = this.routeFor(c) as Route;
    this.travelFrom(c, { route, cur: { leg: LEGS - 1, d: legLength(route, LEGS - 1), dir: -1 } });
  }

  private travelFrom(c: Char, trip: Trip): void {
    c.trip = trip;
    c.state = "commute";
    c.seated = false;
    c.resting = false;
    c.frame = 0;
    c.frameTimer = 0;
    this.follow(c, trip);
  }

  /** Its position, tile and facing from where it is on its trip. */
  private follow(c: Char, trip: Trip): void {
    place(trip.route, trip.cur, c);
    c.dir = facing(trip.route, trip.cur);
  }

  /** One tick of a trip; at its end it sits — at its desk (busy) or on its bench (done). */
  private travel(c: Char, dt: number): void {
    const trip = c.trip as Trip;
    const arrived = advance(trip.route, trip.cur, dt);
    c.frameTimer += dt;
    if (c.frameTimer >= COMMUTE_FRAME_SEC) {
      c.frameTimer -= COMMUTE_FRAME_SEC;
      c.frame = (c.frame + 1) % 4;
    }
    this.follow(c, trip);
    if (!arrived) return;
    // Heading out ⇔ busy (`setActivity` keeps the two in step), so out ends at work.
    if (trip.cur.dir > 0) this.sit(c, this.seatOf(c) as Seat);
    else this.toBench(c);
  }

  /**
   * A sub-agent after a world rebuild. Outside a lounge city: at its desk, as ever. A commuter keeps
   * its bench (a bench that is gone, or none: it picks again) and is re-placed where it is in its
   * day: on its bench, at its desk, or — travelling — on the same leg of the new route, at the point
   * nearest where it stood (no teleport to its desk). One whose desk is gone stops where it stands.
   */
  private resettle(c: Char): void {
    if (!this.commutes(c)) return this.placeSub(c);
    if (c.bench === null || c.bench >= this.benches.length) c.bench = this.pickBench(c);
    if (c.state === "bench") return this.toBench(c);
    if (c.state !== "commute") return this.placeSub(c);
    const trip = c.trip as Trip;
    const route = this.routeFor(c);
    if (!route) return this.toIdle(c);
    trip.cur.d = project(route, trip.cur.leg, c.x, c.y);
    trip.route = route;
    this.follow(c, trip);
  }

  // ───────────────────────────── per-frame update ─────────────────────────────

  private update(c: Char, dt: number): void {
    if (c.fx) {
      c.fxT += dt / FX_SEC;
      if (c.fxT < 1) return;
      if (c.fx === "despawn") {
        this.chars.delete(c.key);
        return;
      }
      c.fx = null;
      c.fxT = 0;
    }
    if (c.bubble) {
      c.bubbleTimer -= dt;
      if (c.bubbleTimer <= 0) c.bubble = null;
    }
    switch (c.state) {
      case "type":
        c.frameTimer += dt;
        if (c.frameTimer >= TYPE_FRAME_SEC) {
          c.frameTimer -= TYPE_FRAME_SEC;
          c.frame = (c.frame + 1) % 2;
        }
        if (c.resting) {
          c.restTimer -= dt;
          if (c.restTimer <= 0) {
            if (this.commutes(c)) this.leaveDesk(c);
            else this.standUp(c);
          }
        }
        return;
      case "bench":
        if (isActive(c.activity)) this.leaveBench(c);
        return;
      case "commute":
        return this.travel(c, dt);
      case "idle":
        if (isActive(c.activity)) this.startWork(c);
        else if (!c.isSub) {
          c.wanderTimer -= dt;
          if (c.wanderTimer <= 0) this.wander(c);
        }
        return;
      case "walk":
        this.step(c, dt);
    }
  }

  private step(c: Char, dt: number): void {
    // Became active mid-stroll: head for the desk now (re-path if the stroll ends elsewhere).
    const seat = this.seatOf(c);
    if (isActive(c.activity) && seat && !c.goingHome) {
      const end = c.path[c.path.length - 1];
      if (end.col !== seat.col || end.row !== seat.row) {
        const path = findPath(this.world, c, seat, undefined, seat);
        if (!path) return this.typeInPlace(c);
        if (path.length === 0) return this.sit(c, seat);
        c.path = path;
        c.pathIdx = 0;
        c.progress = 0;
      }
      // From here on the path ends at the seat — `arrive` relies on it.
      c.goingHome = true;
    }
    c.frameTimer += dt;
    if (c.frameTimer >= WALK_FRAME_SEC) {
      c.frameTimer -= WALK_FRAME_SEC;
      c.frame = (c.frame + 1) % 4;
    }
    c.progress += (WALK_SPEED / TILE) * dt;
    let next = c.path[c.pathIdx];
    c.dir = dirBetween(c, next);
    if (c.progress >= 1) {
      this.setTile(c, next.col, next.row);
      c.progress -= 1;
      c.pathIdx++;
      if (c.pathIdx >= c.path.length) return this.arrive(c);
      next = c.path[c.pathIdx];
      c.dir = dirBetween(c, next);
    }
    c.x = (c.col + (next.col - c.col) * c.progress) * TILE + TILE / 2;
    c.y = (c.row + (next.row - c.row) * c.progress) * TILE + TILE;
  }
}
