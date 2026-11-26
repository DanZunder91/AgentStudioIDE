/** Agent Village's shared contract: data (villageModel, villageIpc) → engine (engine/*, no DOM) →
 * render (render/*) → panel. External agents are read-only from ~/.claude/projects (Rust). World
 * units are unscaled art px (1 tile = TILE); nothing persists. */

/** Size of one tile in art pixels. */
export const TILE = 16;

/** World px a SEATED sprite is raised above its `y` (the sim puts `y` below the chair for depth
 * sorting), so the head shows above the chair back; the hit box follows. */
export const SEAT_LIFT = 9;

// ───────────────────────────── data ─────────────────────────────

export type VillageOrigin = "ide" | "external";

/** `typing` = a writing tool, `reading` = Read/Grep/Glob/WebFetch/WebSearch/LS, `thinking` = no
 * tool known, `waiting` = needs the user, `idle` = turn over, `done`/`error` = finished. */
export type VillageActivity =
  | "typing"
  | "reading"
  | "thinking"
  | "waiting"
  | "idle"
  | "done"
  | "error";

export interface VillageAgent {
  /** Stable, unique across both origins. IDE: the AgentId. External: "ext:" + opaque key from Rust. */
  key: string;
  /** Parent's `key` for a sub-agent, else null. */
  parentKey: string | null;
  origin: VillageOrigin;
  /** Short display label (never prompt text for external agents — privacy). */
  title: string;
  /** House key: the folder's basename (both origins use the basename so one folder = one house). */
  folder: string;
  activity: VillageActivity;
  /** Current/last tool name ("Edit", "Bash", "Task"…) or null. Never tool arguments. */
  tool: string | null;
  /** The IDE AgentId to select on click (origin "ide" only). */
  ideAgentId: string | null;
  /** Epoch ms of the last known activity, or null. */
  lastActivityAt: number | null;
  /** External only: the app its `claude` runs in ("iTerm2"), or null; a click fronts it. Never a
   * path. */
  host?: string | null;
  /** City only: the TERMINAL id of a plain IDE console (a tab with no agent), shown as its own
   * floor; a click fronts that tab. Absent for agents. */
  consoleId?: string | null;
  /** Tool calls SEEN so far, monotonic; one uplink packet per new call. Absent = unknown (no
   * packets). */
  toolCalls?: number;
  /** Language id ("rust", "typescript"…) of this agent's work, or null/absent: its building's neon.
   * Only the id crosses from Rust, never a path (privacy). */
  language?: string | null;
}

/** A real communication the LANs show: a sub-agent's TASK (spawned) or RESULT (finished), or a TOOL
 * call. Observed by `VillageView`; nothing moves without one. */
export interface LanEvent {
  kind: "task" | "result" | "tool";
  /** task / result: the sub-agent; tool: the agent that called the tool. */
  key: string;
  /** When it was observed, seconds on the view's sim clock (`VillageSim.time`). */
  at: number;
}

/** Wire type returned by the Rust `list_external_agents` command (camelCase JSON). */
export interface ExternalAgentWire {
  /** Opaque, stable per session/sub-agent (a hash — the Claude session id never crosses the wire). */
  key: string;
  parentKey: string | null;
  title: string;
  /** Basename of the session's cwd. */
  folder: string;
  activity: "running" | "waiting" | "idle" | "done" | "error";
  tool: string | null;
  lastActivityMs: number;
  /** A live `claude` process claims this session (by id, else as its folder's newest since start);
   * null = unknown (no process table, e.g. Windows). Unclaimed sessions are not sent. */
  alive: boolean | null;
  /** Display name of the GUI app the session's `claude` runs in ("iTerm2"), or null. Never a path. */
  host: string | null;
  /** The session's language id, voted by extension in Rust (`external_agents/language.rs`, shared
   * `projectLanguages.json`), or null. Sub-agents carry their session's. Never a path. */
  language: string | null;
}

export interface ExternalAgentsReport {
  agents: ExternalAgentWire[];
  scannedAtMs: number;
}

// ───────────────────────────── engine ─────────────────────────────

/** `sky` (city) is painted as nothing so the sky backdrop shows; `road` (city) is asphalt. */
export type TileKind = "grass" | "path" | "floor" | "wall" | "water" | "plaza" | "sky" | "road";

/** Furniture & props. `src` picks the art: vendored pixel-agents PNG or our own procedural sprite. */
export type PropKind =
  | "desk" // 2×1 tiles, blocking
  | "table" // 3×3 team table (vendored TABLE_FRONT art), blocking — where sub-agents sit
  | "laptop" // 1×1 (own art), sits ON a team table in front of a sub seat; has on/off states
  | "pc" // sits ON a desk (not blocking by itself); has on/off states
  | "chair" // 1×1, a seat; not blocking for its owner
  | "plant" // 1×1, blocking
  | "bookshelf" // 2×1, blocking, against a wall
  | "bin" // 1×1
  | "coffee" // 1×1, sits on a desk/table
  | "sofa" // 2×1
  | "tree" // 2×2 (own art), blocking
  | "fountain" // 3×3 (own art), blocking — the village plaza centrepiece
  | "lamp" // 1×1 (own art), blocking
  | "sign" // 1×1 (own art) — the house's name board (the name is the `house` DrawItem label)
  | "campfire" // 1×1 (own art) — where idle agents gather
  | "monitor" // 2×1 (own art) — city: a floor leader's workstation on its desk: the monitor seen from BEHIND beside the leader, the keyboard in front of it; on/off
  | "rack" // 1×1 (own art, 2 tiles tall) — capacity: a server rack in the Memory house / floor, its units lit by RAM in use
  | "gauge" // 2×1 (own art, rising 2 tiles) — capacity: a usage-limit meter in the Usage house / floor
  | "hall" // the whole Seats house below its decor row (own art) — capacity: the selected agent's context window as 200 cinema seats (20 × 10, /context's own grid), a character dressed in its category's colour on every taken one; blocking
  | "router" // 1×1 (own art) — a project room's Wi-Fi router: its team's PCs / laptops are cabled to it, its boss (root / floor leader) talks to it over the air (engine/teamLan.ts); not blocking
  // The Tokyo theme (engine/streetTheme.ts — only where the machine's time zone is Asia/Tokyo):
  | "sakura" // 2×2 (own art), blocking like a tree — a cherry tree in bloom, its petals falling
  | "vending" // 1×1 (own art, 2 tiles tall) — a lit drinks vending machine; not blocking (it stands on a walkway's edge)
  | "torii" // 3×1 (own art, rising ~3 tiles) — a shrine gate; not blocking (you walk through it)
  // The city's lounge under the street (engine/city.ts):
  | "bench" // 1×1 (own art) — capacity: one lounge seat (`index`), facing the viewer; four in a row read as one bench; not blocking
  | "lift" // 1×1 (own art, rising ~2 tiles) — the lounge elevator's kiosk on the far sidewalk; not blocking
  | "metro"; // 2×1 (own art) — the subway's street entrance on the far sidewalk, stairs down to its station (`CitySubway`); not blocking

export type Dir = "down" | "up" | "left" | "right";

export interface Prop {
  id: string;
  kind: PropKind;
  /** Tile coords of the top-left of the footprint. */
  col: number;
  row: number;
  /** Footprint in tiles. */
  w: number;
  h: number;
  /** For chairs (and laptops): which way a seated character faces. */
  facing?: Dir;
  /** For pc / laptop: the seat whose occupant switches it on. */
  seatId?: string;
  /** Optional text for a sign. The village leaves it unset: a house's name is drawn once, as the `house` label. */
  label?: string;
  /** Capacity props: a seat desk's or rack's number, or a gauge's window (0 = 5-hour session, 1 =
   * week). */
  index?: number;
  /** Capacity props only: the building (village house / city HQ floor) whose figure this prop shows. */
  capacity?: CapacityKind;
}

export interface Seat {
  id: string;
  houseKey: string;
  col: number;
  row: number;
  facing: Dir;
  /** pc (or laptop) prop id in front of this seat, if any. */
  pcId: string | null;
  /** true for a team-table seat (with a laptop): only sub-agents sit here, and sub-agents sit nowhere else. */
  forSub?: boolean;
}

export interface House {
  key: string; // folder
  label: string;
  /** Interior rect in tiles (walls are drawn around it). */
  col: number;
  row: number;
  w: number;
  h: number;
  /** Door tile (in the bottom wall). */
  doorCol: number;
  doorRow: number;
  /** true if any member is an IDE agent (roof tint), purely cosmetic. */
  hasIde: boolean;
  /** Set on a CAPACITY house (village) or HQ floor (city): which figure it shows. Nobody lives here. */
  capacity?: CapacityKind;
}

/** City view: one building per project folder; its FLOORS are the world's `houses`, and this holds
 * only the shell, street door and sign. */
export interface CityBuilding {
  /** The folder (basename) — also its sign. */
  key: string;
  label: string;
  /** Outer rect in tiles, walls included: the roof slab's row down to the street-level front wall. */
  col: number;
  row: number;
  w: number;
  h: number;
  /** The street door, in the bottom (front) wall row. */
  doorCol: number;
  /** House keys of its floors, ground floor first. */
  floors: string[];
  hasIde: boolean;
  /** The capacity HQ (its Memory and Usage floors; its Seats are the lounge under the street) — not a project. */
  hq?: boolean;
  /** The project's language (its agents' most common), or null: its neon sign. Never set on the HQ.
   */
  language?: string | null;
  /** A project building's lift up its door column (its sub-agents are the only riders); absent on
   * the HQ and without a team. */
  lift?: CityLift;
}

/** A lift shaft, one column wide; riders board or leave only at `top`, `bottom` and `stops`. */
export interface CityLift {
  col: number;
  /** Its highest and lowest rows (top ≤ bottom). */
  top: number;
  bottom: number;
  /** Rows a rider may board or leave, top to bottom incl. `top` and `bottom`: a building's
   * desk-chair rows then its door row; the lounge's far sidewalk then each bench aisle. */
  stops: number[];
}

/** The City's subway: a tunnel under the lounge running the whole street (drawn across the view), a
 * station under its entrance, the entrance a `metro` prop on the far sidewalk. */
export interface CitySubway {
  /** The tunnel's ceiling row and its floor (track-bed) row; the three rows between are the tunnel. */
  top: number;
  bottom: number;
  /** The train's row (wheels on its bottom edge); the body rises 38 px (`render/subway.ts` CAR_H),
   * leaving 22 px under the tunnel's lamps. */
  rail: number;
  /** The station's platform, columns [col0, col1), under the entrance. */
  station: { col0: number; col1: number };
  /** The street entrance (the `metro` prop, 2 tiles wide): its left column and its row (the far sidewalk). */
  entrance: { col: number; row: number };
}

/** The Seats LOUNGE under the street, centred below the HQ: a bench per seat. A busy agent rides
 * `lift` up, crosses at `lift.col`, walks and rides its building's lift to its desk, and comes
 * back the same way. */
export interface CityLounge {
  /** Its house key (`capacityKey("lounge")`) — the lounge is that house in `World.houses`. */
  key: string;
  lift: CityLift;
}

export interface CityInfo {
  /** First row below the buildings (the near sidewalk) of the top street; every building's front
   * wall is on the row above. */
  street: number;
  buildings: CityBuilding[];
  /** The lounge under the street; absent in a city without a capacity layout. */
  lounge?: CityLounge;
  /** The subway under the lounge; present exactly when the lounge is. */
  subway?: CitySubway;
}

export interface World {
  cols: number;
  rows: number;
  /** Row-major, length cols*rows. */
  tiles: TileKind[];
  houses: House[];
  props: Prop[];
  seats: Seat[];
  /** Plaza centre tile (gathering spot for idle agents). */
  plaza: { col: number; row: number };
  /** Set for a CITY world (side view: sky, street, buildings of floors); absent for the village. */
  city?: CityInfo;
}

export type CharacterAnim = "idle" | "walk" | "type" | "read";

/** One character as the renderer needs it, produced each frame by VillageSim. */
export interface CharacterView {
  key: string;
  /** World px of the character's FEET (bottom-centre). */
  x: number;
  y: number;
  dir: Dir;
  anim: CharacterAnim;
  /** Frame index within the anim (walk 0..3 → sheet cols 0,1,2,1; type 0..1; read 0..1). */
  frame: number;
  /** Base sheet 0..5 and extra hue shift in degrees (0 = none). */
  palette: number;
  hueShift: number;
  seated: boolean;
  origin: VillageOrigin;
  isSubagent: boolean;
  activity: VillageActivity;
  label: string;
  tool: string | null;
  /** Bubble over the head, and its opacity 0..1. */
  bubble: "waiting" | "done" | "error" | null;
  bubbleAlpha: number;
  /** Spawn/despawn effect progress 0..1, or null when none. */
  fx: { kind: "spawn" | "despawn"; t: number } | null;
  /** In a lift now (engine/commute.ts): the draw list puts a car round it. Absent = on foot or
   * seated. */
  riding?: boolean;
}

/** Who sits at which seat this frame (`VillageSim.seating`), SEATED only; what a room's LAN wires
 * up. */
export interface SeatedAgent {
  key: string;
  /** The agent that started it; null for a root. */
  parentKey: string | null;
  activity: VillageActivity;
  /** `Seat.id` of the seat it sits at. */
  seatId: string;
}

/** A z-sorted draw instruction. The engine sorts; the renderer just paints in order. */
export type DrawItem =
  | { t: "tile"; col: number; row: number; kind: TileKind; variant: number }
  | {
      t: "wall";
      col: number;
      row: number;
      mask: number /* N=1 E=2 S=4 W=8 */;
      /** The owning house's hue (degrees) — each house gets its own warm tint. Absent = the default plaster. */
      hue?: number;
      /** A house's street-facing wall: one tile tall (cap + facade), so it never covers the room's
       * last row. */
      front?: boolean;
    }
  | {
      t: "prop";
      prop: Prop;
      on: boolean;
      frame: number;
      /** A capacity rack's or gauge's reading this frame (engine/capacity.ts); absent on every other prop. */
      reading?: PropReading;
    }
  | { t: "character"; c: CharacterView }
  | { t: "bubble"; c: CharacterView }
  | {
      /** A project building's NEON blade sign (render/neon.ts). (x, y) = world px of its hang point
       * on the right wall's face (`neonAnchor`). Only when `CityBuilding.language` is known; never
       * the HQ. */
      t: "neon";
      x: number;
      y: number;
      /** The building's language id ("rust"). */
      language: string;
      /** The building's key: seeds its sign's deterministic flicker. */
      building: string;
    }
  | {
      /** The Seats lounge hall (render/lounge.ts), painted at its back wall's depth so benches,
       * waiters and riders draw over it. TILES: first column, back-wall row (`House.row`), width.
       */
      t: "lounge";
      col: number;
      row: number;
      w: number;
      /** Bench rows: bench row k is `row + 2 + 2k`, its aisle the row below. */
      benchRows: number;
      /** The lift's column, kept clear of the dressing (its shaft is render/lift.ts's). */
      lift: number;
    }
  | {
      /** One straight LAN cable run (engine/lan.ts), world px, axis-aligned; drawn right after the
       * ground tiles so furniture covers it. */
      t: "cable";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  | {
      /** A packet this frame (engine/lan.ts or teamLan.ts), world px centre, moving ONLY on a real
       * `LanEvent`: `team` = task or result in the team's hue; `uplink` = a tool call's round
       * trip. Drawn after the scene. */
      t: "packet";
      x: number;
      y: number;
      kind: "team" | "uplink";
      /** Degrees, 0..359: the team's colour (from its root agent's key). */
      hue: number;
    }
  | {
      /** A Wi-Fi pulse at a router or boss-desk antenna (engine/teamLan.ts), world px centre;
       * `phase` 0 just sent .. 1 faded. Drawn with the packets. */
      t: "wifi";
      x: number;
      y: number;
      phase: number;
      /** Degrees, 0..359: the team's colour. */
      hue: number;
    }
  | {
      /** A context-window fill bar over an agent's desk; (x, y) its top-left, `w` its width, world
       * px. */
      t: "meter";
      x: number;
      y: number;
      w: number;
      /** 0..1 */
      fill: number;
      tone: MeterTone;
    }
  | {
      t: "label";
      /** World anchor: an agent label hangs from y (top-centre); a house label is centred on
       * (x, y); a floor plate starts at x, centred on y. */
      x: number;
      y: number;
      text: string;
      /** `floor` = a city floor plate; `civic` = a capacity board or HQ plate with its figure;
       * `gauge` = a usage gauge's caption. */
      tone: "house" | "agent" | "floor" | "civic" | "gauge";
      /** Placement rank, lower first (`placeLabels`): 0 hovered (always drawn), 1 waiting on the
       * user, 2 root, 3 sub-agent. House labels always draw. */
      priority?: number;
      /** Widest the box may be, WORLD px: screen-sized labels would spill below zoom 1, so it is
       * clipped, or not drawn if not one letter fits. */
      maxW?: number;
    }
  | {
      /** A lift SHAFT, one tile column wide (render/lift.ts). Drawn after the scene, OVER the walls
       * and slabs it crosses, before riders and cars. TILES. */
      t: "shaft";
      col: number;
      /** The first and last tile rows it is drawn over (inclusive). */
      top: number;
      bottom: number;
      /** The rows with a landing door (the lift's stops it passes). */
      stops: readonly number[];
    }
  | {
      /** A lift CAR round a rider (render/lift.ts): `back` before the rider, `front` after, so the
       * rider is inside. (x, y) = the rider's feet, world px. */
      t: "car";
      x: number;
      y: number;
      part: "back" | "front";
    }
  | {
      /** A vehicle this frame (engine/traffic.ts; art render/vehicles.ts), z-sorted by the road
       * under its wheels. Decoration: never hit-tested, labelled or counted. */
      t: "vehicle";
      v: VehicleView;
    }
  | {
      /** A PASSER-BY this frame (engine/streetLife.ts; art render/streetLife.ts): no agent marker,
       * never hit-tested, hovered, labelled or counted. (x, y) = feet, world px; on subway stairs
       * `y` is the cut line. Z: `walkerZ`. */
      t: "walker";
      /** Its serial number: a new one per passer-by, the same for its whole walk. */
      id: number;
      x: number;
      y: number;
      dir: "left" | "right";
      /** `walk` (`frame` 0..3 of the walk cycle) or standing `idle` (at a vending machine). */
      anim: "walk" | "idle";
      frame: number;
      /** Its look: a character sheet 0..5 and a hue shift (degrees). */
      palette: number;
      hueShift: number;
      /** World px it has gone down the subway stairs (0 = on the sidewalk): its sprite drawn that much lower, cut at `y`. */
      sink: number;
      /** How open its umbrella is: 0 = none or closed .. 1 = open. */
      umbrella: number;
      /** Its umbrella's colour (render/umbrella.ts `CANOPIES`, wrapped). */
      canopy: number;
      /** The vending machine it is buying a drink from this frame, or null. */
      vend: WalkerVend | null;
      /** The can it carries once it has bought one, or null. */
      drink: WalkerDrink | null;
    };

/** A passer-by's vending-machine purchase; engine/streetLife.ts `VEND` names its steps. */
export interface WalkerVend {
  /** World px of the machine's left edge and of its bottom (its sidewalk tile's). */
  x0: number;
  bottom: number;
  /** Its prop id (its colours: render/tokyoProps.ts `vendingVariant`). */
  machine: string;
  /** The button pressed: 0..4, under the machine's five bottle columns. */
  button: number;
  /** Seconds since the buyer stopped. */
  t: number;
}

/** The can a passer-by carries after buying it: which drink (machine and button — its colour), and whether it is sipping now. */
export interface WalkerDrink {
  machine: string;
  button: number;
  sip: boolean;
}

/** A vehicle as the renderer needs it, made each frame by `TrafficFx` (engine/traffic.ts).
 * Decoration: no vehicle stands for anything measured. */
export type VehicleKind = "car" | "kei" | "taxi" | "bus";

export interface VehicleView {
  kind: VehicleKind;
  /** World px: the body's LEFT end and its length (whichever way it faces). */
  x: number;
  w: number;
  /** World px of the road under its wheels (their bottom edge): its lane row's bottom, like a walker's feet. */
  y: number;
  /** +1 drives right (the far lane), −1 drives left (the near lane): Japan keeps left (engine/traffic.ts). */
  dir: 1 | -1;
  /** Its paint: an index into render/vehicles.ts' table for its kind (a car's colour, a taxi's style, a bus's livery). */
  livery: number;
  /** World px driven so far: turns its wheels. */
  odo: number;
  /** Slowing down or standing: its brake lights are on. */
  braking: boolean;
  /** Its own hash (who sits at a bus's windows). */
  seed: number;
  /** World px per second right now (a wet road sprays behind a moving one). */
  speed: number;
}

// ──── ambience (time of day + weather) ──── Follows the user's local conditions; outdoors is
// graded by the local clock, house interiors stay lit.

export type WeatherKind = "clear" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

export type DayPhase = "night" | "dawn" | "morning" | "noon" | "afternoon" | "evening" | "dusk";

/** Wire type of the Rust `village_weather` command (camelCase JSON). */
export interface WeatherWire {
  kind: WeatherKind;
  /** 0..1 — how heavy (precipitation rate / cloud cover mapped). */
  intensity: number;
  temperatureC: number | null;
  /** Wind direction-relevant horizontal component, -1 (blowing left) .. 1 (right); 0 when unknown. */
  wind: number;
  /** Today's local sunrise/sunset as epoch ms, null when unknown. */
  sunriseMs: number | null;
  sunsetMs: number | null;
  /** City-level place name the coordinates came from (e.g. "Tokyo"), never finer than a city. */
  place: string;
  fetchedAtMs: number;
}

/** User override from the HUD; "auto" = follow the live clock / live weather. */
export type WeatherOverride = "auto" | WeatherKind;
export type PhaseOverride = "auto" | DayPhase;

/** Everything the engine + renderer need to paint the sky this frame. Pure data. */
export interface Ambience {
  phase: DayPhase;
  /** How far through `phase` the clock is, 0..1 (forced phase 0.5, night 0), so the City's sky
   * glides through a phase (`engine/ambience.ts skyClock`). Absent = 0.5. */
  progress?: number;
  /** The machine's IANA time zone ("Asia/Tokyo"), also the live weather's city: the skyline shows
   * its landmarks. Absent = a generic skyline. */
  zone?: string;
  /** 0 = darkest night .. 1 = full noon sun. Drives the outdoor grade. */
  daylight: number;
  /** Outdoor colour grade to multiply/overlay: CSS colour + alpha 0..1 (alpha 0 = none). */
  tint: { color: string; alpha: number };
  weather: WeatherKind;
  intensity: number;
  wind: number;
  /** Lamps, lit windows and the campfire glow at night/dusk/storm. */
  lightsOn: boolean;
  /** The campfire is out in rain/snow/storm. */
  campfireLit: boolean;
  /** Idle agents stay indoors (bad weather or night). */
  stayIndoors: boolean;
  /** City sky body (sun sunrise to sunset, else moon) and how far it has crossed, 0 left .. 1
   * right. Absent = no sun or moon (the village has no sky). */
  arc?: { body: "sun" | "moon"; t: number };
}

/** One weather particle in WORLD px. */
export interface WeatherParticle {
  kind: "rain" | "snow" | "splash";
  x: number;
  y: number;
  /** Rain streak length (px) / snow flake size / splash radius. */
  size: number;
  alpha: number;
}

// ──── capacity ──── Seats, Memory and Usage (5-hour and weekly limits) are a building each in both
// views, plus each agent's context window as a bar over its desk.

/** Wire `AgentMemory` of `machine_capacity` (src-tauri/src/capacity.rs, camelCase). */
export interface AgentMemoryWire {
  /** Live `claude` sessions: CLI processes whose parent is not itself a `claude`. */
  sessions: number;
  /** Every counted `claude` CLI process (sessions + their own `claude` helpers). */
  claudeProcesses: number;
  claudeRssBytes: number;
  /** Processes the sessions started (MCP servers, shells, dev servers), each once. */
  toolProcesses: number;
  toolRssBytes: number;
}

/** Wire `MachineCapacity` of `machine_capacity`. Every figure is `null` where this OS cannot say. */
export interface MachineCapacityWire {
  logicalCpus: number | null;
  totalMemBytes: number | null;
  availableMemBytes: number | null;
  /** `null` where there is no process table (Windows). */
  agents: AgentMemoryWire | null;
  sampledAtMs: number;
}

/** Capacity buildings: Seats (the selected agent's context, 200 seats), Memory and Usage (a house
 * each in the village, an HQ floor each in the city), and the City-only `lounge` under the street.
 */
export type CapacityKind = "seats" | "memory" | "usage" | "lounge";

/** What the capacity buildings must have room for (it shapes the world, so it changes rarely). */
export interface CapacityLayout {
  /** Lounge benches: a fixed 64, or one per live agent if more. The Village ignores it (its Seats
   * hall is a fixed 200). */
  seats: number;
}

/** Fill severity of a meter: the usage strip's and the context card's own bands; `unknown` = no reading. */
export type MeterTone = "ok" | "warn" | "danger" | "unknown";

/** A meter's reading: how full (0..1) and how worried to look. */
export interface Meter {
  fill: number;
  tone: MeterTone;
}

/** A capacity prop's reading this frame. */
export type PropReading =
  /** A rack: how many of its units the agents light, and how many everything else in use; the rest are dark. */
  | { kind: "rack"; agents: number; other: number; known: boolean }
  /** A gauge: its window's meter, or null with no reading. */
  | { kind: "gauge"; meter: Meter | null }
  /** A lounge bench with an anonymous WAITER (a free seat: no holder, no sim character); look from
   * the bench's number. */
  | { kind: "waiter"; palette: number; hueShift: number; pose: WaiterPose }
  /** The Seats hall: the selected agent's context window seat by seat (`HallFrame`); null before the first frame. */
  | { kind: "hall"; hall: HallFrame | null };

/** The selected agent's context as `/context`'s 200-cell grid: `cells[i]` is seat i's category key
 * (`free-space` empty, `autocompact-buffer` reserved), front row first. `cells` null = no reading:
 * drawn as unknown, never empty. */
export interface HallFrame {
  cells: readonly string[] | null;
  /** Percent of the window in use, as `/context` printed it; null without a reading. */
  usedPct: number | null;
  /** The Context card's 50 / 80 bands for `usedPct`; `unknown` without a reading. */
  tone: MeterTone;
}

/** A lounge waiter's pose; asleep at night is the renderer's call (it has the sky). */
export type WaiterPose = "still" | "shift" | "read";

/** Who holds a seat desk: the agent, what it is doing, and who started it (null = a root). */
export interface SeatHolder {
  key: string;
  activity: VillageActivity;
  parentKey: string | null;
}

/** What the capacity buildings show THIS frame (from `capacityModel`); the world holds only the
 * furniture. */
export interface CapacityFrame {
  /** The City's lounge: bench i's holder, or null when free; one bench per live agent. Empty in the
   * Village. */
  desks: (SeatHolder | null)[];
  /** The Seats hall — the selected agent's context window — in both views. */
  hall: HallFrame;
  /** Shares of physical RAM, 0..1: held by the agents, and in use by everything (agents included). null = unknown. */
  memory: { agents: number | null; used: number | null };
  /** The account's windows; null = no reading. */
  usage: { session: Meter | null; week: Meter | null };
  /** Context-window fill per agent key — only agents with a reading. */
  context: Readonly<Record<string, Meter>>;
  /** Each building's board / plate, figures included ("Seats 3/10"). */
  captions: Readonly<Record<CapacityKind, string>>;
  /** The Usage gauges' own captions ("5h 41%", "week 58%"), session first. */
  gaugeCaptions: readonly [string, string];
}
