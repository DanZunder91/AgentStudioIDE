import { afterEach, describe, expect, it, vi } from "vitest";

import { TILE, type SeatHolder, type VillageActivity } from "../villageTypes";
import * as lan from "./lan";
import { inFlight, MAX_TRIP, PACKET_SPEED, pcPort, pointAt, routeLength, starWiring, teamHue, teamRoot, type LanPoint } from "./lan";
import { hashString } from "./rng";

const holder = (key: string, activity: VillageActivity = "typing", parentKey: string | null = null): SeatHolder => ({ key, activity, parentKey });
const hueOf = (key: string): number => hashString(key) % 360;
/** A point rounded to 1e-6 px, for comparing with numbers worked out by hand. */
const near = (p: { x: number; y: number } | null): [number, number] | null => (p ? [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6] : null);

// ───────────────────────────── the Seats room's LAN is gone ─────────────────────────────

describe("the Village's Seats room has no LAN any more (its Seats are the context hall)", () => {
  it("lan.ts no longer exports the Seats-room wiring or its packets — only the pieces every LAN shares", () => {
    const exported = Object.keys(lan);
    for (const gone of ["lanWiring", "lanPackets", "wire"]) expect(exported, gone).not.toContain(gone);
    for (const kept of ["starWiring", "pcPort", "teamRoot", "teamHue", "inFlight", "routeLength", "pointAt", "PACKET_SPEED", "MAX_TRIP", "BRANCH_LIFT"])
      expect(exported, kept).toContain(kept);
  });
});

// ───────────────────────────── the trip maths (every LAN's packets) ─────────────────────────────

describe("inFlight — the trip rule every packet runs by", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A parent 48 px left of the hub along y = 0; a child 36 px straight below it. */
  const PARENT: LanPoint[] = [
    { x: 0, y: 0 },
    { x: 48, y: 0 },
  ];
  const CHILD: LanPoint[] = [
    { x: 48, y: 36 },
    { x: 48, y: 0 },
  ];

  it("the trip rule's numbers", () => {
    expect([PACKET_SPEED, MAX_TRIP]).toEqual([48, 2]);
  });

  it("a one-way trip (a task): out along head, through the hub, back along tail — 84 px at 48 px/s, 1.75 s", () => {
    const at = (age: number) => near(inFlight(PARENT, CHILD, false, age));
    expect(at(0)).toEqual([0, 0]); // leaving the parent's port
    expect(at(0.25)).toEqual([12, 0]);
    expect(at(1)).toEqual([48, 0]); // at the hub
    expect(at(1.5)).toEqual([48, 24]); // 24 px down the child's cable, 12 px from its port
    expect(inFlight(PARENT, CHILD, false, 0.25)).toEqual({ x: 12, y: 0, d: 12, length: 84, lh: 48 });
  });

  it("the same way back (a result): tail's first point, the hub, head's first point", () => {
    const at = (age: number) => near(inFlight(PARENT, CHILD, true, age));
    expect(at(0)).toEqual([48, 36]);
    expect(at(0.25)).toEqual([48, 24]);
    expect(at(0.75)).toEqual([48, 0]);
    expect(at(1.5)).toEqual([12, 0]); // 12 px from the parent's port
  });

  it("a round-trip (a tool call) is head = tail: up its own cable to the hub and back down it — 72 px, 1.5 s", () => {
    const at = (age: number) => near(inFlight(CHILD, CHILD, false, age));
    expect(at(0)).toEqual([48, 36]);
    expect(at(0.25)).toEqual([48, 24]); // going up
    expect(at(0.75)).toEqual([48, 0]); // turning at the hub
    expect(at(1)).toEqual([48, 12]); // coming back down
    expect(at(1.25)).toEqual([48, 24]);
    expect(at(1.5)).toBeNull(); // home
  });

  it("the trip window is [0, arrival): an instant early, or on arrival, nothing", () => {
    expect(inFlight(PARENT, CHILD, false, 0)).not.toBeNull();
    expect(inFlight(PARENT, CHILD, false, -1e-9)).toBeNull();
    expect(inFlight(PARENT, CHILD, false, 1.75 - 1e-9)).not.toBeNull();
    expect(inFlight(PARENT, CHILD, false, 1.75)).toBeNull();
    for (const age of [-100, 3, 1e6]) for (const back of [false, true]) expect(inFlight(PARENT, CHILD, back, age), `${age}`).toBeNull();
  });

  it("a long way runs faster — no trip outlasts MAX_TRIP; a short one still runs at PACKET_SPEED", () => {
    const far: LanPoint[] = [
      { x: 0, y: 0 },
      { x: 480, y: 0 },
    ];
    const farTail: LanPoint[] = [
      { x: 960, y: 0 },
      { x: 480, y: 0 },
    ];
    // 960 px in 2 s = 480 px/s, not PACKET_SPEED's 20 s.
    expect(inFlight(far, farTail, false, 1)).toEqual({ x: 480, y: 0, d: 480, length: 960, lh: 480 });
    expect(near(inFlight(far, farTail, false, 1.5))).toEqual([720, 0]);
    expect(inFlight(far, farTail, false, 1.99)).not.toBeNull();
    expect(inFlight(far, farTail, false, 2)).toBeNull();
    // 24 px at 48 px/s: half a second, not stretched to MAX_TRIP.
    const short: LanPoint[] = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
    ];
    const shortTail: LanPoint[] = [
      { x: 24, y: 0 },
      { x: 12, y: 0 },
    ];
    expect(near(inFlight(short, shortTail, false, 0.25))).toEqual([12, 0]);
    expect(inFlight(short, shortTail, false, 0.5)).toBeNull();
  });

  it("is pure: the same answer every time — no clock, no randomness", () => {
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    for (let age = -1; age < 3; age += 0.37) expect(inFlight(PARENT, CHILD, false, age)).toEqual(inFlight(PARENT, CHILD, false, age));
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});

describe("teamRoot / teamHue — a team's colour", () => {
  const seated = (hs: SeatHolder[]) => new Map(hs.map((h) => [h.key, h]));

  it("is the topmost SEATED ancestor: a chain that breaks stops at the last one reached", () => {
    const family = seated([holder("r"), holder("s", "typing", "r"), holder("ss", "typing", "s")]);
    for (const k of ["r", "s", "ss"]) expect(teamRoot(family.get(k) as SeatHolder, family), k).toBe("r");
    // "gone" is not seated: s heads its own team.
    const broken = seated([holder("s", "typing", "gone"), holder("ss", "typing", "s")]);
    expect(teamRoot(broken.get("ss") as SeatHolder, broken)).toBe("s");
  });

  it("parents that loop have no top: the loop's smallest key stands in, for every member — a holder named as its own parent is its own team", () => {
    const loop = seated([holder("y", "typing", "x"), holder("x", "typing", "y")]);
    expect([teamRoot(loop.get("y") as SeatHolder, loop), teamRoot(loop.get("x") as SeatHolder, loop)]).toEqual(["x", "x"]);
    const tail = seated([holder("c", "typing", "b"), holder("b", "typing", "a"), holder("a", "typing", "b")]);
    expect(teamRoot(tail.get("c") as SeatHolder, tail)).toBe("a");
    const self = seated([holder("me", "typing", "me")]);
    expect(teamRoot(self.get("me") as SeatHolder, self)).toBe("me");
  });

  it("two teams, two colours", () => {
    expect(hueOf("alpha")).not.toBe(hueOf("beta")); // the precondition: these two keys do differ
    expect([teamHue("alpha"), teamHue("beta")]).toEqual([hueOf("alpha"), hueOf("beta")]);
  });
});

// ───────────────────────────── shared with the project rooms' LANs (engine/teamLan.ts) ─────────────────────────────

describe("the helpers engine/teamLan.ts shares", () => {
  it("routeLength / pointAt: an axis-aligned leg moves exactly s px; a diagonal one (the Wi-Fi air hop) along its direction", () => {
    const hop: LanPoint[] = [
      { x: 18, y: -40 },
      { x: 48, y: 0 },
      { x: 48, y: 36 },
    ];
    expect(routeLength(hop)).toBe(50 + 36); // a 30-40-50 diagonal, then 36 px straight down
    expect(pointAt(hop, 0)).toEqual({ x: 18, y: -40 });
    const p = pointAt(hop, 25);
    expect(p.x).toBeCloseTo(33, 12);
    expect(p.y).toBeCloseTo(-20, 12);
    expect(pointAt(hop, 50 + 10)).toEqual({ x: 48, y: 10 });
    expect(pointAt(hop, 999)).toEqual({ x: 48, y: 36 });
    // Axis-aligned arithmetic is exact (no hypot, no division): 0.1 px along stays 0.1 px.
    expect(pointAt([{ x: 0, y: 0 }, { x: 0, y: -3 }], 0.1)).toEqual({ x: 0, y: -0.1 });
  });

  it("inFlight: head walked forwards, tail backwards (or the reverse); how far it has come; null outside its trip", () => {
    const head: LanPoint[] = [
      { x: 0, y: 0 },
      { x: 48, y: 0 },
    ];
    const tail: LanPoint[] = [
      { x: 48, y: 36 },
      { x: 48, y: 0 },
    ];
    expect(inFlight(head, tail, false, 1.5)).toEqual({ x: 48, y: 24, d: 72, length: 84, lh: 48 });
    expect(inFlight(head, tail, true, 1.5)).toEqual({ x: 12, y: 0, d: 72, length: 84, lh: 48 });
    expect(inFlight(head, tail, false, 0)).toEqual({ x: 0, y: 0, d: 0, length: 84, lh: 48 });
    expect(inFlight(head, tail, true, 0)).toEqual({ x: 48, y: 36, d: 0, length: 84, lh: 48 });
    for (const age of [-0.01, 1.75, 9]) for (const back of [false, true]) expect(inFlight(head, tail, back, age), `${age} ${back}`).toBeNull();
    // A way of no length (a port AT the hub) has no trip at all.
    const at: LanPoint[] = [{ x: 5, y: 5 }];
    expect(inFlight(at, at, false, 0)).toBeNull();
  });

  it("starWiring is every LAN's shape; pcPort its port; teamRoot/teamHue its colour", () => {
    const hub = { x: 100, y: 8 };
    const star = starWiring(hub, [
      { port: { x: 40, y: 50 }, busY: 40 },
      { port: { x: 160, y: 50 }, busY: 40 },
      { port: { x: 40, y: 90 }, busY: 80 },
    ]);
    expect(star.runs).toEqual([
      { x0: 100, y0: 8, x1: 100, y1: 80 },
      { x0: 40, y0: 40, x1: 160, y1: 40 },
      { x0: 40, y0: 80, x1: 100, y1: 80 },
      { x0: 40, y0: 40, x1: 40, y1: 50 },
      { x0: 160, y0: 40, x1: 160, y1: 50 },
      { x0: 40, y0: 80, x1: 40, y1: 90 },
    ]);
    expect(star.routes[2]).toEqual([{ x: 40, y: 90 }, { x: 40, y: 80 }, { x: 100, y: 80 }, hub]);
    expect(pcPort({ id: "p", kind: "pc", col: 3, row: 5, w: 1, h: 1 })).toEqual({ x: 3 * TILE + 8, y: 5 * TILE + 2 });
    const seated = new Map([holder("r"), holder("s", "typing", "r"), holder("t", "typing", "s")].map((h) => [h.key, h]));
    expect(teamRoot(seated.get("t") as SeatHolder, seated)).toBe("r");
    expect(teamHue("r")).toBe(hueOf("r"));
  });
});
