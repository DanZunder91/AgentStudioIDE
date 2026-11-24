/**
 * Agent Village — the shared contract between its four layers.
 *
 *   data  (villageModel.ts, villageIpc.ts)  → VillageAgent[]
 *   engine (engine/*, pure TS, no DOM)      → World + VillageSim → DrawItem[]
 *   render (render/*, canvas via DrawTarget) → pixels
 *   panel  (VillagePanel.tsx)               → wires the three + HUD/tooltip
 *
 * A pixel-art village (inspired by pixel-agents, MIT — see src/assets/pixel-agents/)
 * where every Claude Code agent on this machine is a character: the ones the IDE runs
 * AND the ones running in some other terminal (discovered read-only from
 * ~/.claude/projects by the Rust `list_external_agents` command). One house per
 * project folder; sub-agents sit at the team tables of their root's house, each at its
 * own laptop (next to their parent only when every team seat is taken).
 *
 * World units are PIXELS of the unscaled art (1 tile = TILE px). The renderer
 * multiplies by an integer zoom. Nothing here is persisted.
 */

/** Size of one tile in art pixels. */
export const TILE = 16;

/**
 * World px a SEATED character's sprite is drawn above its `y`. The sim puts a sitter's
 * `y` a few px below its chair tile (for depth sorting); drawn from there the chair back
 * would hide the whole head, so the renderer raises the sprite (and the engine's hit box
 * follows) — head and shoulders show above the chair back, the pixel-agents look.
 */
export const SEAT_LIFT = 9;

// ───────────────────────────── data ─────────────────────────────

export type VillageOrigin = "ide" | "external";

/**
 * What a character is doing. `typing` = a writing tool (Edit/Write/Bash/…),
 * `reading` = Read/Grep/Glob/WebFetch/WebSearch/LS, `thinking` = running with no
 * tool known, `waiting` = needs the user (permission / input), `idle` = turn over,
 * `done` / `error` = finished (sub-agents mostly).
 */
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
  /**
   * External only: display name of the app its `claude` runs in ("iTerm2", "Terminal"),
   * or null when unknown — a click brings that app to the front. Never a path.
   */
  host?: string | null;
  /**
   * City view only: the TERMINAL id of a plain IDE CONSOLE (a terminal tab with no agent),
   * which the city shows as a floor of its own with the console's user at the desk. A click
   * brings that terminal's tab to the front. Absent/null for every agent.
   */
  consoleId?: string | null;
  /**
   * How many tool calls this agent has been SEEN making, monotonic (each one is a real model
   * round-trip) — the LAN shows one uplink packet per new call. Absent = unknown (no packets).
   */
  toolCalls?: number;
  /**
   * The programming language this agent's work is in, as a language id ("rust", "typescript"…),
   * or null / absent when unknown. The City lights its building's NEON sign in it. Only the id
   * ever crosses from Rust — never a path or a file name (privacy).
   */
  language?: string | null;
}

/**
 * A real communication the LANs show as packets (packets move only
 * when agents communicate with each other): a sub-agent was given its TASK (it was spawned), it
 * sent its RESULT back (it finished), or an agent made a TOOL call (a round-trip to the model).
 * Observed by `VillageView` from the agents it is handed; nothing moves without one.
 */
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
  /**
   * true when a live `claude` process claims this session (by `--session-id`/`--resume`
   * id, else as its folder's newest session since the process started); null = unknown
   * (no process table, e.g. Windows). Sessions no process claims are not sent at all.
   */
  alive: boolean | null;
  /** Display name of the GUI app the session's `claude` runs in ("iTerm2"), or null. Never a path. */
  host: string | null;
  /**
   * The session's language id ("rust", "typescript"…): the files its tool calls named, voted by
   * extension in Rust (`external_agents/language.rs`, the shared `projectLanguages.json`); null when
   * none says. Sub-agents carry their session's. An id — never a path or a file name.
   */
  language: string | null;
}

export interface ExternalAgentsReport {
  agents: ExternalAgentWire[];
  scannedAtMs: number;
}

// ───────────────────────────── engine ─────────────────────────────

/**
 * `sky` (city only) is painted as nothing — the city's sky backdrop shows through it;
 * `road` (city only) is the street's asphalt.
 */
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
  /**
   * Capacity props only: which one this is — a seat desk's number (its desk, PC and chair),
   * a rack's number (racks fill in this order), or a gauge's window (0 = the 5-hour session,
   * 1 = the week).
   */
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

/**
 * City view: everything running is a building, and every console or
 * agent takes one floor of it. One building per project folder; its FLOORS are
 * the world's `houses` (so the sim seats each leader and its team on their own floor), and
 * this record holds what only a building has: its outer shell, its street door and its sign.
 */
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
  /**
   * The project's language (`VillageAgent.language`, its agents' most common one), or null when
   * none is known: the building's neon sign. Never set on the HQ.
   */
  language?: string | null;
  /**
   * The elevator of a project building with a team (its sub-agents are the only riders), up its door
   * column through every floor. Absent on the HQ and on a building without a team.
   */
  lift?: CityLift;
}

/**
 * An elevator shaft (busy agents ride an elevator up to the street and
 * go to their building). Vertical, one column wide; a rider gets on and off only at `top`, `bottom` and the
 * rows in `stops`.
 */
export interface CityLift {
  col: number;
  /** Its highest and lowest rows (top ≤ bottom). */
  top: number;
  bottom: number;
  /**
   * Every row a rider may get on or off at, top to bottom, `top` and `bottom` included. A project
   * building's: each floor's desk-chair rows (top floor first), then its street door's row
   * (`bottom`). The lounge's: the far sidewalk (`top`), then each bench row's aisle.
   */
  stops: number[];
}

/**
 * The CITY's SUBWAY (a subway under the seats, with an entrance somewhere on
 * the map and a train that goes out and comes back every three minutes): a tunnel dug in under the Seats
 * lounge that runs the whole street (past the world's ends too — render/ draws it across the view), a
 * station under its street entrance, and that entrance — a `metro` prop on the far sidewalk, left of the
 * lounge, whose stairs go down beside the lounge to the station.
 */
export interface CitySubway {
  /** The tunnel's ceiling row and its floor (track-bed) row; the three rows between are the tunnel. */
  top: number;
  bottom: number;
  /**
   * The row the train runs on: its wheels on this row's bottom edge. Its body rises 38 px from there
   * (`render/subway.ts` CAR_H — taller than two rows so its doors are taller than a person), leaving
   * 22 px of headroom under the tunnel's lamps.
   */
  rail: number;
  /** The station's platform, columns [col0, col1), under the entrance. */
  station: { col0: number; col1: number };
  /** The street entrance (the `metro` prop, 2 tiles wide): its left column and its row (the far sidewalk). */
  entrance: { col: number; row: number };
}

/**
 * The Seats LOUNGE: the capacity HQ's seats are no longer desks but a waiting
 * room UNDER THE STREET, centred below the HQ — a bench seat per seat (`bench` props, numbered like
 * the Seats desks), where agents wait to be called. A busy agent leaves its bench, rides `lift` up
 * to the far sidewalk, crosses the road at `lift.col` (in front of the HQ's door), walks the near
 * sidewalk to its building, rides that building's lift up to its floor and sits at its desk; when
 * it is done it comes back the same way.
 */
export interface CityLounge {
  /** Its house key (`capacityKey("lounge")`) — the lounge is that house in `World.houses`. */
  key: string;
  lift: CityLift;
}

export interface CityInfo {
  /**
   * First street row below the buildings (the near sidewalk) of the FIRST (top) street; every
   * building on it has its front wall on the row above.
   */
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
  /**
   * In a lift right now (the city's commute, engine/commute.ts): the draw list puts a car round it.
   * Absent = on foot, seated or standing.
   */
  riding?: boolean;
}

/**
 * Who sits at which seat this frame (`VillageSim.seating`): a character SEATED at its seat — not
 * walking to it, not despawning. What a project room's LAN (engine/teamLan.ts) wires up.
 */
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
      /**
       * true for a house's bottom (street-facing) wall: drawn one tile tall as a cap + a
       * darker facade instead of a 2-tile back wall, so it never covers the room's last row.
       */
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
      /**
       * A project building's NEON sign (a neon sign that says the project's
       * language — a Rust project such as gazelle gets Rust-style neon lights): a vertical blade sign hanging off the
       * building's right wall, its language's short name stacked in pixel letters in that
       * language's colours (render/neon.ts). (x, y) = world px of the point it hangs from: the
       * right wall's outer face, level with the sign's top (engine/drawList.ts `neonAnchor`).
       * Only on a project building whose `CityBuilding.language` is known — never on the HQ.
       */
      t: "neon";
      x: number;
      y: number;
      /** The building's language id ("rust"). */
      language: string;
      /** The building's key: seeds its sign's deterministic flicker. */
      building: string;
    }
  | {
      /**
       * The city's Seats LOUNGE, dressed (render/lounge.ts): an underground
       * waiting hall — warm lamps under its ceiling, a panelled wainscot behind each bench row, a
       * plant at each row's ends. Painted on its back surface, at its back wall's depth, so its
       * benches, the agents waiting on them and every rider are drawn over it. TILES: the
       * interior's first column, its back-wall row (`House.row`) and its width.
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
      /**
       * One straight run of the Seats room's LAN cable (engine/lan.ts), world px, axis-aligned:
       * on the floor between the desk rows (village) or along the back wall (city). Drawn right
       * after the ground tiles, so the furniture and the sitters cover it.
       */
      t: "cable";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  | {
      /**
       * A data packet this frame — on the Seats LAN (engine/lan.ts) or a project room's LAN
       * (engine/teamLan.ts) — world px centre. Packets move ONLY on real communication (`LanEvent`):
       * `team` = a sub-agent's task (parent → child, at its spawn) or result (child → parent, when it
       * finishes), in the team's hue; `uplink` = one tool call's round trip to the switch / router.
       * Drawn after the scene, before the meters.
       */
      t: "packet";
      x: number;
      y: number;
      kind: "team" | "uplink";
      /** Degrees, 0..359: the team's colour (from its root agent's key). */
      hue: number;
    }
  | {
      /**
       * A Wi-Fi pulse at an antenna this frame (engine/teamLan.ts): a project room's router, or
       * its boss's desk, while the boss and its team talk over the air. World px centre of the
       * antenna; `phase` 0..1 = how far this pulse has spread (0 just sent, 1 faded out).
       * Drawn with the packets: after the scene, before the meters.
       */
      t: "wifi";
      x: number;
      y: number;
      phase: number;
      /** Degrees, 0..359: the team's colour. */
      hue: number;
    }
  | {
      /**
       * A small fill bar floating over an agent's desk: its context window.
       * World px: (x, y) is the bar's top-left, `w` its width.
       */
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
      /**
       * World anchor: an agent label's box hangs from y (top-centre); a house label is
       * centred on (x, y); a floor plate's box starts at x (left edge), centred on y.
       */
      x: number;
      y: number;
      text: string;
      /**
       * `floor` = a city floor's name plate; `civic` = a capacity house's board or HQ floor plate, with its figure
       * ("Seats 3/10"); `gauge` = a usage gauge's own small caption ("5h 41%").
       */
      tone: "house" | "agent" | "floor" | "civic" | "gauge";
      /**
       * Placement rank, lower first (labels.ts `placeLabels`): 0 = hovered (always drawn),
       * 1 = waiting on the user, 2 = root agent, 3 = sub-agent. House labels are always drawn.
       */
      priority?: number;
      /**
       * Widest the box may be, WORLD px (a city floor plate: its floor). Labels are screen-sized,
       * so below zoom 1 a plate would spill past its building; with a cap it is clipped to fit —
       * or not drawn when not even one letter fits.
       */
      maxW?: number;
    }
  | {
      /**
       * A lift SHAFT (busy agents ride an elevator): a project building's
       * (`CityBuilding.lift`) or the lounge's (`CityLounge.lift`), one tile column wide — rails
       * on a dark strip, a landing door at each stop (render/lift.ts). Drawn after the scene, so it
       * runs OVER the back walls and slabs it crosses, and before the riders and their cars. TILES.
       */
      t: "shaft";
      col: number;
      /** The first and last tile rows it is drawn over (inclusive). */
      top: number;
      bottom: number;
      /** The rows with a landing door (the lift's stops it passes). */
      stops: readonly number[];
    }
  | {
      /**
       * A lift CAR round a rider this frame (render/lift.ts): `back` (its back wall and frame) right
       * before the rider, `front` (its lintel, sill and side posts) right after it, so the rider is
       * inside. (x, y) = the rider's feet, world px.
       */
      t: "car";
      x: number;
      y: number;
      part: "back" | "front";
    }
  | {
      /**
       * A vehicle on the City's road this frame (engine/traffic.ts `TrafficFx`; art: render/vehicles.ts).
       * Z-sorted with the street by the road under its wheels (`VehicleView.y`): the far lane behind the
       * near lane, both in front of the near sidewalk's lamps, trees and walkers and behind everything
       * on the far sidewalk. Decoration: never hit-tested, never labelled, never counted.
       */
      t: "vehicle";
      v: VehicleView;
    }
  | {
      /**
       * A PASSER-BY on a City sidewalk this frame (engine/streetLife.ts `StreetLife`, art:
       * render/streetLife.ts; people walk on the street too, and in the
       * rain some of them, not all, carry an umbrella). Anonymous, drawn from the character sheets
       * with NO agent marker and no bubble — never a sim character, so never hit-tested, hovered,
       * labelled or counted. (x, y) = world px of its feet on the sidewalk; on the subway stairs `y` is
       * the line its sprite is cut at. Z-sorted in front of its sidewalk's props (`walkerZ`).
       */
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

/**
 * A passer-by buying a drink (someone goes to buy something at the
 * vending machine): the machine and how far through the purchase it is — engine/streetLife.ts `VEND` names the
 * steps (pay, a button flashes, the can drops into the tray, the buyer takes it).
 */
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

/**
 * The City's TRAFFIC (taxis, cars and buses, at random and only as many
 * as it takes to make the city look alive): a vehicle as the renderer needs it, produced each frame by
 * `TrafficFx` (engine/traffic.ts). Decoration — no vehicle stands for anything measured.
 */
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

// ───────────────────────────── ambience (time of day + weather) ─────────────────────────────
//
// Weather and time of day follow the user's local conditions: rain when it rains there, afternoon
// outside the house in the afternoon. Outdoors is graded by the local clock (sunrise/sunset from the weather report when known); house interiors stay lit.

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
  /**
   * How far through `phase` the clock is: 0 = its start .. 1 = its end. A forced phase is shown at
   * its middle (0.5); night is 0 (its sky does not change across it). It lets the City's sky glide
   * through a phase — golden hour deepening into sunset, sunset into twilight — instead of stepping
   * at the phase's edges (`engine/ambience.ts skyClock`). Absent = 0.5.
   */
  progress?: number;
  /**
   * The machine's IANA time zone ("Asia/Tokyo") — the same thing the live weather picks its city
   * from; the City's skyline shows that city's landmarks. Absent = unknown (a generic skyline).
   */
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
  /**
   * The city's sky (side view): which body is up — the sun from sunrise to sunset, the moon
   * otherwise — and how far it has crossed, 0 = just risen on the left .. 1 = setting on the
   * right. Absent = no sun or moon drawn (the village is seen from above and has no sky).
   */
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

// ───────────────────────────── capacity ───────────────────────────────────────────
//
// Both the Village and the City show the agents' seats — the available ones, and of the reserved
// ones how many are in use — and the memory available to agents. Three figures, a building each: Seats (how many agents can work at
// once vs how many do), Memory (what the agents hold vs the machine) and Usage (the account's
// 5-hour and weekly limits); plus each agent's context window as a bar over its desk.

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

/**
 * The capacity buildings: Seats (the selected agent's context window — a hall of `/context`'s 200
 * seats), Memory and Usage are a house each in the village and a floor each of the city's HQ; the
 * `lounge` is the City's waiting room under the street (its 64 benches, where agents wait to be
 * called), which the village does not have.
 */
export type CapacityKind = "seats" | "memory" | "usage" | "lounge";

/** What the capacity buildings must have room for (it shapes the world, so it changes rarely). */
export interface CapacityLayout {
  /**
   * Benches in the City's lounge: a fixed 64, or more — one for every live agent. The Seats are a
   * fixed hall of `/context`'s 200 seats in both views, so the Village gives 0 and ignores it.
   */
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
  /**
   * A city lounge bench with an anonymous agent WAITING on it (a free seat — no holder, no sim
   * character): its look (a character sheet and hue, from the bench's number) and its pose this frame.
   */
  | { kind: "waiter"; palette: number; hueShift: number; pose: WaiterPose }
  /** The Seats hall: the selected agent's context window seat by seat (`HallFrame`); null before the first frame. */
  | { kind: "hall"; hall: HallFrame | null };

/**
 * The Seats hall this frame, in the Village's Seats house and on the City HQ's Seats floor
 * (`/context`'s grid is what the seats mean, in both views): the selected agent's context window
 * as `/context`'s own 200-cell grid — `cells[i]` is the category key seat i is taken by (`free-space` = an empty seat,
 * `autocompact-buffer` = a reserved one), in the CLI's order, front row first. `cells` null = no
 * reading (nothing selected, a sub-agent, or not read yet): the seats are drawn as unknown, never as
 * empty.
 */
export interface HallFrame {
  cells: readonly string[] | null;
  /** Percent of the window in use, as `/context` printed it; null without a reading. */
  usedPct: number | null;
  /** The Context card's 50 / 80 bands for `usedPct`; `unknown` without a reading. */
  tone: MeterTone;
}

/**
 * A lounge waiter's pose: sitting `still`, a brief `shift` in its seat, or `read`ing a paper. Asleep
 * at night is the renderer's (it has the sky): a still sitter with a "z".
 */
export type WaiterPose = "still" | "shift" | "read";

/** Who holds a seat desk: the agent, what it is doing, and who started it (null = a root). */
export interface SeatHolder {
  key: string;
  activity: VillageActivity;
  parentKey: string | null;
}

/**
 * What the capacity buildings show THIS frame — plain data, made by `capacityModel` from the
 * machine sample, the usage store and the context store. The world holds only the furniture.
 */
export interface CapacityFrame {
  /**
   * The City's lounge: bench i's holder, or null for a free bench. Its length is the bench count:
   * every live agent has one. Empty in the Village (it has no lounge).
   */
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
