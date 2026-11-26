/** The Seats hall via the recording fake; real pixels are hall.browser.test.tsx's. Every expected
 * colour and pixel position is a literal written by hand. */

import { describe, expect, it } from "vitest";

import type { PropReading } from "../villageTypes";
import { drawHall, hallLeft, legendOf, SCREEN_W, SEATS_SPAN, seatLook, seatOrigin, seatShifting } from "./hall";
import { recorder, type RecordingTarget } from "./testRecorder";

const cam = { zoom: 1, ox: 0, oy: 0 };
/** The hall's footprint in these tests: left edge 32, 13 tiles (208 px) wide, 9 tiles (144 px) tall. */
const X0 = 32;
const TOP = 48;
const BOTTOM = TOP + 144;
const HALL_W = 208;
const HALL_PX_H = 144;

/** Every category colour the Context card paints (context.css), by hand. */
const CATEGORY_HEX = [
  "#a1a1aa", // system prompt
  "#71717a", // system tools
  "#52525b", // system tools (deferred)
  "#22b8cf", // MCP tools
  "#138a9c", // MCP server instructions
  "#d97430", // memory files
  "#d4b83a", // skills
  "#4cae6b", // agents
  "#a371f7", // messages
  "#f778ba", // extra-0 … extra-5
  "#79c0ff",
  "#ffa198",
  "#7ee787",
  "#d2a8ff",
  "#e3b341",
];
const SKIN_HEX = ["#f1c7a3", "#d9a07a", "#a8714f", "#7a4e33"];
const HAIR_HEX = ["#2a1d17", "#5a3a22", "#c9a25a", "#9a9aa0", "#b5532a", "#1b1b22"];

const hallOf = (cells: readonly string[] | null, usedPct: number | null = 11, tone: "ok" | "warn" | "danger" | "unknown" = "ok"): PropReading => ({
  kind: "hall",
  hall: { cells, usedPct, tone },
});

/** 200 cells: `head` first, the rest free. */
const cellsOf = (...head: string[]): string[] => [...head, ...new Array(200 - head.length).fill("free-space")];

function draw(reading: PropReading | undefined, timeMs = 0, zoom = 1, widthPx?: number): RecordingTarget {
  const ctx = recorder();
  if (widthPx === undefined) drawHall(ctx, { ...cam, zoom }, X0, BOTTOM, reading, timeMs);
  else drawHall(ctx, { ...cam, zoom }, X0, BOTTOM, reading, timeMs, widthPx);
  return ctx;
}

/** The colour the recorded fills leave at screen pixel (x, y): the LAST fillRect covering it, or null. */
function pixel(ctx: RecordingTarget, x: number, y: number): string | null {
  let out: string | null = null;
  for (const c of ctx.of("fillRect")) {
    const [rx, ry, rw, rh] = c.args as number[];
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) out = c.fillStyle;
  }
  return out;
}

/** Seat `i`'s top-left on screen at zoom 1, for the X0/TOP above. */
function seatAt(i: number): { x: number; y: number } {
  const o = seatOrigin(i);
  return { x: X0 + o.x, y: TOP + o.y };
}

/** The fills issued exactly at (x, y, w, h). */
const fillsAt = (ctx: RecordingTarget, x: number, y: number, w: number, h: number) =>
  ctx
    .of("fillRect")
    .filter((c) => c.args[0] === x && c.args[1] === y && c.args[2] === w && c.args[3] === h)
    .map((c) => c.fillStyle);

describe("seatOrigin — /context's 20 × 10 grid as two blocks of ten either side of the aisle", () => {
  it("puts the corners and both sides of the aisle where they belong (literal px from the hall's top-left)", () => {
    expect(seatOrigin(0)).toEqual({ x: 8, y: 16 }); // front row, far left
    expect(seatOrigin(1)).toEqual({ x: 17, y: 16 }); // one pitch (9 px) along
    expect(seatOrigin(9)).toEqual({ x: 89, y: 16 }); // the last seat left of the aisle
    expect(seatOrigin(10)).toEqual({ x: 110, y: 16 }); // the first right of it: 9 px + the 12-px aisle on
    expect(seatOrigin(19)).toEqual({ x: 191, y: 16 }); // front row, far right
    expect(seatOrigin(20)).toEqual({ x: 8, y: 28 }); // the second row: one row pitch (12 px) back
    expect(seatOrigin(30)).toEqual({ x: 110, y: 28 });
    expect(seatOrigin(180)).toEqual({ x: 8, y: 124 }); // back row, far left
    expect(seatOrigin(199)).toEqual({ x: 191, y: 124 }); // back row, far right
  });

  it("every seat's 9 × 12 box is inside the 13 × 9-tile footprint, and no two seats overlap", () => {
    const boxes = Array.from({ length: 200 }, (_, i) => seatOrigin(i));
    for (const [i, { x, y }] of boxes.entries()) {
      expect(x, `seat ${i}`).toBeGreaterThanOrEqual(0);
      expect(x + 9, `seat ${i}`).toBeLessThanOrEqual(HALL_W);
      expect(y, `seat ${i}`).toBeGreaterThanOrEqual(16); // under the screen
      expect(y + 12, `seat ${i}`).toBeLessThanOrEqual(HALL_PX_H);
    }
    for (let a = 0; a < 200; a++)
      for (let b = a + 1; b < 200; b++) {
        const [p, q] = [boxes[a], boxes[b]];
        const overlap = p.x < q.x + 9 && q.x < p.x + 9 && p.y < q.y + 12 && q.y < p.y + 12;
        expect(overlap, `seats ${a} and ${b}`).toBe(false);
      }
  });

  it("no seat sits in the aisle: columns 0–9 end at 98, columns 10–19 start at 110", () => {
    for (let i = 0; i < 200; i++) {
      const { x } = seatOrigin(i);
      if (i % 20 < 10) expect(x + 9, `seat ${i}`).toBeLessThanOrEqual(98);
      else expect(x, `seat ${i}`).toBeGreaterThanOrEqual(110);
    }
  });

  it("the aisle's carpet runs from the front row to the back of the hall, between the blocks", () => {
    expect(fillsAt(draw(hallOf(cellsOf())), X0 + 100, TOP + 16, 8, 128)).toEqual(["#4a1e28"]);
  });

  it("everything the hall paints stays inside its footprint — any reading, shifting or not, at zoom 1 and 3", () => {
    const readings = [hallOf(new Array(200).fill("messages"), 100, "danger"), hallOf(cellsOf("system-prompt")), hallOf(new Array(200).fill("autocompact-buffer")), undefined];
    for (const zoom of [1, 3])
      for (const r of readings)
        for (const t of [0, 1700, 4300, 9900]) {
          const fills = draw(r, t, zoom).of("fillRect").map((c) => c.args as number[]);
          expect(fills.length).toBeGreaterThan(200 * 4);
          for (const [x, y, w, h] of fills) {
            expect(x).toBeGreaterThanOrEqual(X0 * zoom);
            expect(x + w).toBeLessThanOrEqual((X0 + HALL_W) * zoom);
            expect(y).toBeGreaterThanOrEqual(TOP * zoom);
            expect(y + h).toBeLessThanOrEqual(BOTTOM * zoom);
          }
        }
  });
});

describe("seatLook — a seat keeps its look", () => {
  it("is the seat number's alone: the same every call, dealt from the skin and hair palettes", () => {
    for (let i = 0; i < 200; i++) {
      const look = seatLook(i);
      expect(seatLook(i)).toEqual(look);
      expect(SKIN_HEX).toContain(look.skin);
      expect(HAIR_HEX).toContain(look.hair);
    }
  });

  it("varies across the audience: several skins and hair colours, not one look repeated", () => {
    const looks = Array.from({ length: 200 }, (_, i) => seatLook(i));
    expect(new Set(looks.map((l) => l.skin)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(looks.map((l) => l.hair)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(looks.map((l) => `${l.skin}/${l.hair}`)).size).toBeGreaterThanOrEqual(10);
  });

  it("the drawn character wears that look — whatever the reading, the same seat has the same head", () => {
    for (const i of [0, 7, 13]) {
      const { skin, hair } = seatLook(i);
      const { x, y } = seatAt(i);
      for (const key of ["messages", "skills", "system-tools"]) {
        const cells = new Array(200).fill(key);
        const ctx = draw(hallOf(cells), 0);
        // Still (timeMs 0 is checked below to be still for these seats): ears at y + 3, hair y + 1..4.
        if (seatShifting(i, 0)) continue;
        expect(pixel(ctx, x + 1, y + 3), `seat ${i} ear`).toBe(skin);
        expect(pixel(ctx, x + 7, y + 3), `seat ${i} ear`).toBe(skin);
        expect(pixel(ctx, x + 4, y + 1), `seat ${i} crown`).toBe(hair);
        expect(pixel(ctx, x + 4, y + 3), `seat ${i} back of the head`).toBe(hair);
      }
    }
    expect([0, 7, 13].filter((i) => seatShifting(i, 0))).toEqual([]);
  });
});

describe("seatShifting — briefly, each on its own rhythm", () => {
  const STEP = 0.05;
  const SAMPLES = 2400; // two minutes

  it("is a function of (seat, time) only", () => {
    for (let i = 0; i < 200; i += 7)
      for (let k = 0; k < 400; k++) expect(seatShifting(i, k * 0.3)).toBe(seatShifting(i, k * 0.3));
  });

  it("every seat shifts now and then, but only a small fraction of the time, half a second at a go", () => {
    for (let i = 0; i < 200; i++) {
      let on = 0;
      let run = 0;
      let longest = 0;
      for (let k = 0; k < SAMPLES; k++) {
        if (seatShifting(i, k * STEP)) {
          on++;
          run++;
          longest = Math.max(longest, run);
        } else run = 0;
      }
      expect(on, `seat ${i}`).toBeGreaterThan(0);
      expect(on / SAMPLES, `seat ${i}`).toBeLessThan(0.1);
      // A shift lasts half a second: 10 samples of 50 ms (11 with a boundary on each end).
      expect(longest, `seat ${i}`).toBeGreaterThanOrEqual(9);
      expect(longest, `seat ${i}`).toBeLessThanOrEqual(11);
    }
  });

  it("not in unison: at any moment only a few seats shift, and different seats shift at different times", () => {
    let most = 0;
    for (let k = 0; k < SAMPLES; k++) {
      let n = 0;
      for (let i = 0; i < 200; i++) if (seatShifting(i, k * STEP)) n++;
      most = Math.max(most, n);
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(40);
    const firstShift = Array.from({ length: 200 }, (_, i) => {
      for (let k = 0; k < SAMPLES; k++) if (seatShifting(i, k * STEP)) return k;
      return -1;
    });
    expect(new Set(firstShift).size).toBeGreaterThan(50);
  });

  it("a shifting character's head rises one pixel; its shirt and the chair stay put", () => {
    const i = 3;
    let still = -1;
    let shifting = -1;
    for (let k = 0; k < 4000 && (still < 0 || shifting < 0); k++) {
      const t = k * 0.05;
      if (seatShifting(i, t)) shifting = shifting < 0 ? t : shifting;
      else still = still < 0 ? t : still;
    }
    expect(still).toBeGreaterThanOrEqual(0);
    expect(shifting).toBeGreaterThanOrEqual(0);
    const cells = new Array(200).fill("messages");
    const { x, y } = seatAt(i);
    const { hair } = seatLook(i);
    const a = draw(hallOf(cells), still * 1000);
    const b = draw(hallOf(cells), shifting * 1000);
    expect(fillsAt(a, x + 2, y + 2, 5, 3)).toEqual([hair]);
    expect(fillsAt(b, x + 2, y + 1, 5, 3)).toEqual([hair]);
    expect(fillsAt(b, x + 2, y + 2, 5, 3)).toEqual([]);
    for (const ctx of [a, b]) {
      expect(fillsAt(ctx, x + 1, y + 6, 7, 4)).toEqual(["#a371f7"]);
      expect(fillsAt(ctx, x + 1, y + 10, 7, 2)).toEqual(["#6a1f2b"]);
    }
  });
});

describe("legendOf — the screen's legend", () => {
  it("each category in the hall once, in seat order; free space and the autocompact buffer are not categories", () => {
    expect(
      legendOf(["system-prompt", "free-space", "system-tools", "system-prompt", "autocompact-buffer", "messages", "system-tools", "free-space"]),
    ).toEqual(["system-prompt", "system-tools", "messages"]);
    expect(legendOf(["messages", "skills", "messages", "memory-files"])).toEqual(["messages", "skills", "memory-files"]);
    expect(legendOf(["free-space", "autocompact-buffer", "free-space"])).toEqual([]);
    expect(legendOf([])).toEqual([]);
  });
});

describe("drawHall — what each seat paints", () => {
  it("a taken seat: a character from behind in its category's colour — messages purple", () => {
    const ctx = draw(hallOf(cellsOf("messages")));
    const { x, y } = seatAt(0);
    expect([x, y]).toEqual([40, 64]);
    // Shoulders, then the back, in the category's colour.
    expect(fillsAt(ctx, 42, 69, 5, 1)).toEqual(["#a371f7"]);
    expect(fillsAt(ctx, 41, 70, 7, 4)).toEqual(["#a371f7"]);
    expect(pixel(ctx, 44, 72)).toBe("#a371f7");
    // The chair's arms either side and the backrest in front of the sitter.
    expect(fillsAt(ctx, 40, 71, 1, 5)).toEqual(["#3a2328"]);
    expect(fillsAt(ctx, 48, 71, 1, 5)).toEqual(["#3a2328"]);
    expect(fillsAt(ctx, 41, 74, 7, 2)).toEqual(["#6a1f2b"]);
    expect(fillsAt(ctx, 41, 74, 7, 1)).toEqual(["#a33a4a"]);
    // No empty cushion under a sitter.
    expect(fillsAt(ctx, 41, 70, 7, 4)).not.toContain("#8b2e3c");
  });

  it("each category dresses its sitter in its own colour", () => {
    const keys = ["system-prompt", "system-tools", "mcp-tools", "mcp-server-instructions", "memory-files", "skills", "agents", "custom-agents", "messages"];
    const want = ["#a1a1aa", "#71717a", "#22b8cf", "#138a9c", "#d97430", "#d4b83a", "#4cae6b", "#4cae6b", "#a371f7"];
    const ctx = draw(hallOf(cellsOf(...keys)));
    keys.forEach((key, i) => {
      const { x, y } = seatAt(i);
      expect(pixel(ctx, x + 4, y + 8), key).toBe(want[i]);
    });
  });

  it("a free seat is an empty velvet chair: the cushion, no character", () => {
    const ctx = draw(hallOf(cellsOf("messages")));
    const { x, y } = seatAt(1);
    expect([x, y]).toEqual([49, 64]);
    expect(fillsAt(ctx, 50, 70, 7, 4)).toEqual(["#8b2e3c"]);
    expect(pixel(ctx, 53, 72)).toBe("#8b2e3c");
    expect(pixel(ctx, 53, 66)).toBeNull(); // nobody's head over it
    const colours = ctx
      .of("fillRect")
      .filter((c) => (c.args[0] as number) >= x && (c.args[0] as number) < x + 9 && (c.args[1] as number) >= y && (c.args[1] as number) < y + 12)
      .map((c) => c.fillStyle);
    expect(new Set(colours)).toEqual(new Set(["#3a2328", "#8b2e3c", "#6a1f2b", "#a33a4a"]));
  });

  it("a reserved seat (the autocompact buffer) has a white card with a ✕ on its cushion — nobody on it", () => {
    const ctx = draw(hallOf(cellsOf("messages", "autocompact-buffer")));
    const { x, y } = seatAt(1);
    expect(fillsAt(ctx, x + 1, y + 6, 7, 4)).toEqual(["#8b2e3c"]);
    expect(fillsAt(ctx, x + 2, y + 5, 5, 4)).toEqual(["#d9dde4"]);
    // The ✕: two diagonals crossing at the card's centre.
    for (const [dx, dy] of [[3, 6], [5, 6], [4, 7], [3, 8], [5, 8]]) expect(fillsAt(ctx, x + dx, y + dy, 1, 1), `${dx},${dy}`).toEqual(["#5b6472"]);
    expect(ctx.of("fillRect").filter((c) => c.fillStyle === "#5b6472")).toHaveLength(5);
    // Between the strokes the card shows.
    for (const [dx, dy] of [[4, 6], [3, 7], [5, 7], [4, 8], [2, 5], [6, 8]]) expect(pixel(ctx, x + dx, y + dy), `${dx},${dy}`).toBe("#d9dde4");
    // No sitter: no skin, no hair, no category colour on that seat.
    expect(pixel(ctx, x + 4, y + 2)).toBeNull();
  });

  it("a short reading seats the rest as free, and a full one fills all 200 seats", () => {
    const short = draw(hallOf(["messages", "skills"]));
    expect(pixel(short, seatAt(2).x + 4, seatAt(2).y + 8)).toBe("#8b2e3c");
    expect(pixel(short, seatAt(199).x + 4, seatAt(199).y + 8)).toBe("#8b2e3c");
    const full = draw(hallOf(new Array(200).fill("skills"), 100, "danger"));
    for (let i = 0; i < 200; i++) expect(pixel(full, seatAt(i).x + 4, seatAt(i).y + 8), `seat ${i}`).toBe("#d4b83a");
    expect(full.of("fillRect").filter((c) => c.fillStyle === "#8b2e3c")).toHaveLength(0);
  });

  it("no reading: grey chairs and a '?' on the screen — never an empty hall, never a category colour", () => {
    const unknownSet = new Set(["#3a2328", "#4a1e28", "#2a3140", "#0f1420", "#8b93a3", "#4a505c", "#3a3f4a", "#5a606c"]);
    const readings: (PropReading | undefined)[] = [
      undefined,
      { kind: "hall", hall: null },
      hallOf(null, null, "unknown"),
      { kind: "gauge", meter: null }, // another prop's reading is no reading for the hall
    ];
    for (const r of readings) {
      const ctx = draw(r, 2500);
      const fills = ctx.of("fillRect").map((c) => c.fillStyle);
      expect(new Set(fills), JSON.stringify(r)).toEqual(unknownSet);
      for (const hex of CATEGORY_HEX) expect(fills, hex).not.toContain(hex);
      // 200 grey chairs, no velvet cushion and no seated character (skin or hair).
      expect(fills.filter((c) => c === "#4a505c")).toHaveLength(200);
      for (const c of ["#8b2e3c", ...SKIN_HEX, ...HAIR_HEX]) expect(fills).not.toContain(c);
      for (let i = 0; i < 200; i += 11) expect(pixel(ctx, seatAt(i).x + 4, seatAt(i).y + 8), `seat ${i}`).toBe("#4a505c");
      // The screen: its frame and dark face, a "?" in the middle, no track and no bar.
      expect(fillsAt(ctx, X0 + 44, TOP + 1, 120, 12)).toEqual(["#2a3140"]);
      expect(fillsAt(ctx, X0 + 45, TOP + 2, 118, 10)).toEqual(["#0f1420"]);
      const mark = ctx
        .of("fillRect")
        .filter((c) => c.fillStyle === "#8b93a3")
        .map((c) => c.args);
      expect(mark).toEqual([
        [X0 + 101, TOP + 3, 4, 1],
        [X0 + 105, TOP + 4, 1, 2],
        [X0 + 103, TOP + 6, 2, 1],
        [X0 + 103, TOP + 7, 1, 1],
        [X0 + 103, TOP + 9, 1, 1],
      ]);
    }
  });

  it("cells but no percent: the seats are seated, the screen still says '?' (no bar it cannot fill)", () => {
    const ctx = draw(hallOf(cellsOf("messages"), null, "unknown"));
    expect(pixel(ctx, seatAt(0).x + 4, seatAt(0).y + 8)).toBe("#a371f7");
    const fills = ctx.of("fillRect").map((c) => c.fillStyle);
    expect(fills.filter((c) => c === "#8b93a3")).toHaveLength(5);
    expect(fills).not.toContain("#232b38");
  });
});

describe("drawHall — the screen: legend and fill bar", () => {
  /** The screen's fills on the bar row (y = TOP + 8, 2 px tall), as [x, w, colour]. */
  const barRow = (ctx: RecordingTarget) =>
    ctx
      .of("fillRect")
      .filter((c) => c.args[1] === TOP + 8 && c.args[3] === 2)
      .map((c) => [c.args[0], c.args[2], c.fillStyle]);
  /** The legend's swatches (6 × 2 at y = TOP + 4), as [x, colour]. */
  const swatches = (ctx: RecordingTarget) =>
    ctx
      .of("fillRect")
      .filter((c) => c.args[1] === TOP + 4 && c.args[2] === 6 && c.args[3] === 2)
      .map((c) => [c.args[0], c.fillStyle]);

  it("a swatch per category in seat order, 8 px apart from the face's left", () => {
    const ctx = draw(hallOf(cellsOf("messages", "system-prompt", "free-space", "autocompact-buffer", "messages", "skills")));
    expect(swatches(ctx)).toEqual([
      [X0 + 48, "#a371f7"],
      [X0 + 56, "#a1a1aa"],
      [X0 + 64, "#d4b83a"],
    ]);
  });

  it("at most 14 swatches, all inside the screen's face", () => {
    const keys = [
      "system-prompt", "system-tools", "system-tools-deferred", "mcp-tools", "mcp-server-instructions", "memory-files", "skills", "agents", "messages",
      ...Array.from({ length: 11 }, (_, k) => `new-category-${k}`),
    ];
    const ctx = draw(hallOf(cellsOf(...keys)));
    const s = swatches(ctx);
    expect(s).toHaveLength(14);
    expect(s.slice(0, 9).map(([, c]) => c)).toEqual(["#a1a1aa", "#71717a", "#52525b", "#22b8cf", "#138a9c", "#d97430", "#d4b83a", "#4cae6b", "#a371f7"]);
    expect(s.map(([x]) => x)).toEqual([48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144, 152].map((dx) => X0 + dx));
    // The last one ends at X0 + 158, inside the face (X0 + 45 .. X0 + 163).
    expect((s[13][0] as number) + 6).toBeLessThanOrEqual(X0 + 163);
  });

  it("the fill bar: 11 % of a 110-px track is 12 px, in the Context card's tone", () => {
    expect(barRow(draw(hallOf(cellsOf("messages"), 11, "ok")))).toEqual([
      [X0 + 48, 110, "#232b38"],
      [X0 + 48, 12, "#4cc38a"],
    ]);
    expect(barRow(draw(hallOf(cellsOf("messages"), 60, "warn")))).toEqual([
      [X0 + 48, 110, "#232b38"],
      [X0 + 48, 66, "#e3b341"],
    ]);
    expect(barRow(draw(hallOf(cellsOf("messages"), 100, "danger")))).toEqual([
      [X0 + 48, 110, "#232b38"],
      [X0 + 48, 110, "#f85149"],
    ]);
  });

  it("0 % draws no fill; a sliver (0.2 %) still draws 1 px; out-of-range percents are clamped", () => {
    expect(barRow(draw(hallOf(cellsOf(), 0, "ok")))).toEqual([[X0 + 48, 110, "#232b38"]]);
    expect(barRow(draw(hallOf(cellsOf(), -5, "ok")))).toEqual([[X0 + 48, 110, "#232b38"]]);
    expect(barRow(draw(hallOf(cellsOf("system-prompt"), 0.2, "ok")))).toEqual([
      [X0 + 48, 110, "#232b38"],
      [X0 + 48, 1, "#4cc38a"],
    ]);
    expect(barRow(draw(hallOf(cellsOf("messages"), 150, "danger")))).toEqual([
      [X0 + 48, 110, "#232b38"],
      [X0 + 48, 110, "#f85149"],
    ]);
  });

  it("with a reading the screen shows no '?'", () => {
    expect(draw(hallOf(cellsOf("messages"))).of("fillRect").some((c) => c.fillStyle === "#8b93a3")).toBe(false);
  });
});

describe("hallLeft — the seats centred in a hall of any width", () => {
  it("the span is two blocks of ten 9-px seats and a 12-px aisle (192 px); the screen is 120 px", () => {
    expect([SEATS_SPAN, SCREEN_W]).toEqual([192, 120]);
  });

  it("the Village's 208 → 8, exactly the span → 0, 200 → 4; odd leftovers round down; narrower than the span → 0, never negative", () => {
    expect(hallLeft(208)).toBe(8);
    expect(hallLeft(192)).toBe(0);
    expect(hallLeft(200)).toBe(4);
    expect(hallLeft(209)).toBe(8);
    expect(hallLeft(193)).toBe(0);
    expect(hallLeft(240)).toBe(24);
    expect(hallLeft(191)).toBe(0);
    expect(hallLeft(160)).toBe(0);
    expect(hallLeft(0)).toBe(0);
  });

  it("seatOrigin takes the hall's margin: 0 for a 192-px hall, the Village's 8 by default", () => {
    expect(seatOrigin(0, 0)).toEqual({ x: 0, y: 16 });
    expect(seatOrigin(9, 0)).toEqual({ x: 81, y: 16 });
    expect(seatOrigin(10, 0)).toEqual({ x: 102, y: 16 });
    expect(seatOrigin(19, 0)).toEqual({ x: 183, y: 16 });
    expect(seatOrigin(199, 0)).toEqual({ x: 183, y: 124 });
    expect(seatOrigin(10, 4)).toEqual({ x: 106, y: 16 });
    expect(seatOrigin(10)).toEqual({ x: 110, y: 16 }); // the Village's margin (8) by default
  });
});

describe("drawHall — width-aware: the same hall in a 192-px prop", () => {
  const W192 = 192;

  it("seat 0 at x0 + 0, seat 10 at x0 + 102 (right of the aisle), seat 199 at x0 + 183 — literal px", () => {
    const ctx = draw(hallOf(cellsOf("messages", ...new Array(9).fill("free-space"), "skills")), 0, 1, W192);
    // Seat 0's back (x + 1, y + 6, 7 × 4) in messages purple, at x0 + 0.
    expect(fillsAt(ctx, X0 + 1, TOP + 16 + 6, 7, 4)).toEqual(["#a371f7"]);
    // Its left arm at x0 + 0 (x, y + 7, 1 × 5).
    expect(fillsAt(ctx, X0 + 0, TOP + 16 + 7, 1, 5)).toEqual(["#3a2328"]);
    // Seat 10 (skills yellow), at x0 + 102.
    expect(fillsAt(ctx, X0 + 103, TOP + 16 + 6, 7, 4)).toEqual(["#d4b83a"]);
    expect(fillsAt(ctx, X0 + 102, TOP + 16 + 7, 1, 5)).toEqual(["#3a2328"]);
    // Seat 199 (free), at x0 + 183, the back row: its cushion and its right arm at the hall's right edge.
    expect(fillsAt(ctx, X0 + 184, TOP + 124 + 6, 7, 4)).toEqual(["#8b2e3c"]);
    expect(fillsAt(ctx, X0 + 191, TOP + 124 + 7, 1, 5)).toEqual(["#3a2328"]);
    // Nothing is drawn where the Village's 208-px hall would put seat 0 (x0 + 8).
    expect(fillsAt(ctx, X0 + 9, TOP + 16 + 6, 7, 4)).toEqual([]);
  });

  it("the aisle's carpet runs between the blocks: x0 + 92, 8 px wide", () => {
    const ctx = draw(hallOf(cellsOf()), 0, 1, W192);
    expect(fillsAt(ctx, X0 + 92, TOP + 16, 8, 128)).toEqual(["#4a1e28"]);
    expect(fillsAt(ctx, X0 + 100, TOP + 16, 8, 128)).toEqual([]);
  });

  it("the screen is centred: its frame at x0 + 36 (120 px), its face at x0 + 37, the legend and the bar from x0 + 40", () => {
    const ctx = draw(hallOf(cellsOf("messages", "system-prompt"), 11, "ok"), 0, 1, W192);
    expect(fillsAt(ctx, X0 + 36, TOP + 1, 120, 12)).toEqual(["#2a3140"]);
    expect(fillsAt(ctx, X0 + 37, TOP + 2, 118, 10)).toEqual(["#0f1420"]);
    expect(fillsAt(ctx, X0 + 40, TOP + 4, 6, 2)).toEqual(["#a371f7"]);
    expect(fillsAt(ctx, X0 + 48, TOP + 4, 6, 2)).toEqual(["#a1a1aa"]);
    expect(fillsAt(ctx, X0 + 40, TOP + 8, 110, 2)).toEqual(["#232b38"]);
    expect(fillsAt(ctx, X0 + 40, TOP + 8, 12, 2)).toEqual(["#4cc38a"]);
    // Not where the 208-px hall puts it.
    expect(fillsAt(ctx, X0 + 44, TOP + 1, 120, 12)).toEqual([]);
  });

  it("with no reading the '?' is centred on the 192-px screen too", () => {
    const mark = draw(undefined, 0, 1, W192)
      .of("fillRect")
      .filter((c) => c.fillStyle === "#8b93a3")
      .map((c) => c.args);
    expect(mark).toEqual([
      [X0 + 93, TOP + 3, 4, 1],
      [X0 + 97, TOP + 4, 1, 2],
      [X0 + 95, TOP + 6, 2, 1],
      [X0 + 95, TOP + 7, 1, 1],
      [X0 + 95, TOP + 9, 1, 1],
    ]);
  });

  it("everything it paints stays inside the 192-px footprint, at zoom 1 and 3", () => {
    for (const zoom of [1, 3])
      for (const r of [hallOf(new Array(200).fill("messages"), 100, "danger"), hallOf(cellsOf("autocompact-buffer")), undefined]) {
        const fills = draw(r, 4300, zoom, W192).of("fillRect").map((c) => c.args as number[]);
        expect(fills.length).toBeGreaterThan(200 * 4);
        for (const [x, y, w, h] of fills) {
          expect(x).toBeGreaterThanOrEqual(X0 * zoom);
          expect(x + w).toBeLessThanOrEqual((X0 + W192) * zoom);
          expect(y).toBeGreaterThanOrEqual(TOP * zoom);
          expect(y + h).toBeLessThanOrEqual(BOTTOM * zoom);
        }
      }
  });

  it("a 208-px hall is the default: the same draw calls with or without the width", () => {
    const r = hallOf(cellsOf("messages", "skills", "autocompact-buffer"), 11, "ok");
    expect(draw(r, 1700, 1, 208).calls).toEqual(draw(r, 1700).calls);
    // And a 208-px hall draws the Village's: seat 0 at x0 + 8, the screen at x0 + 44.
    const ctx = draw(r, 0, 1, 208);
    expect(fillsAt(ctx, X0 + 9, TOP + 16 + 6, 7, 4)).toEqual(["#a371f7"]);
    expect(fillsAt(ctx, X0 + 44, TOP + 1, 120, 12)).toEqual(["#2a3140"]);
  });

  it("a 200-px hall: the seats 4 px in, the screen 40 px in", () => {
    const ctx = draw(hallOf(cellsOf("messages")), 0, 1, 200);
    expect(fillsAt(ctx, X0 + 5, TOP + 16 + 6, 7, 4)).toEqual(["#a371f7"]);
    expect(fillsAt(ctx, X0 + 40, TOP + 1, 120, 12)).toEqual(["#2a3140"]);
    expect(fillsAt(ctx, X0 + 96, TOP + 16, 8, 128)).toEqual(["#4a1e28"]);
  });
});
