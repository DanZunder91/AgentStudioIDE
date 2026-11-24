/**
 * The shop signs' pixel kana (render/kana.ts) — the art pinned glyph by glyph, the drawing rules it
 * follows proven as properties, and `kanaText`'s layout of every word a sign may spell (neon
 * signs for ramen and soba in katakana, sushi in hiragana).
 *
 * Real pixels (a canvas, through the engine's snapping `rect`) are kana.browser.test.tsx's job.
 */

import { describe, expect, it } from "vitest";

import { SIGN_WORDS } from "./backdrop";
import { KANA_CHARS, KANA_H, KANA_W, kanaText, type Run } from "./kana";

/**
 * The art, hand-checked against the system font on the contact sheet — a pixel
 * changed here or in kana.ts is a glyph redrawn, so it has to be redrawn in both.
 */
const ART: Readonly<Record<string, readonly string[]>> = {
  ラ: [".XXXXXX.", "........", "XXXXXXXX", ".......X", "......X.", ".....X..", "...XX...", "XXX....."],
  メ: ["......X.", "......X.", ".....X..", "..X.X...", "...X....", "..X.X...", ".X...X..", "X......."],
  ン: ["........", "XX......", "..X....X", ".......X", "......X.", ".....X..", "...XX...", "XXX....."],
  ソ: [".X....X.", ".X....X.", "..X...X.", "......X.", ".....X..", "....X...", "..XX....", "XX......"],
  バ: [".....X.X", ".....X.X", "..X.....", "..X..X..", ".X....X.", ".X....X.", "X......X", "X......X"],
  カ: ["..X.....", "..X.....", "XXXXXXX.", "..X...X.", "..X...X.", ".X....X.", ".X....X.", "X...XX.."],
  オ: [".....X..", ".....X..", "XXXXXXXX", "...X.X..", "..X..X..", ".X...X..", "X....X..", "....XX.."],
  ケ: ["..X.....", "..X.....", ".XXXXXXX", "X....X..", ".....X..", "....X...", "...X....", ".XX....."],
  ゲ: [".....X.X", "..X..X.X", "..X.....", ".XXXXXXX", "X....X..", ".....X..", "....X...", ".XXX...."],
  レ: [".X......", ".X......", ".X......", ".X......", ".X.....X", ".X...XX.", ".X.XX...", ".XX....."],
  コ: ["........", ".XXXXXX.", "......X.", "......X.", "......X.", "......X.", ".XXXXXX.", "........"],
  ヒ: [".X......", ".X......", ".X......", ".X...XX.", ".XXXX...", ".X......", ".X......", "..XXXXXX"],
  ム: ["...X....", "...X....", "..X.....", "..X.....", ".X...X..", ".X....X.", "XXXXXXX.", ".......X"],
  ホ: ["....X...", ".XXXXXXX", "....X...", "....X...", "..X.X.X.", ".X..X..X", "....X...", "...XX..."],
  テ: [".XXXXXX.", "........", "XXXXXXXX", "....X...", "....X...", "...X....", "..X.....", "XX......"],
  ル: [".....X..", "..X..X..", "..X..X..", "..X..X..", "..X..X..", ".X...X.X", ".X...XX.", "X....X.."],
  ー: ["........", "........", "........", ".XXXXXX.", "........", "........", "........", "........"],
  "｜": ["........", "....X...", "....X...", "....X...", "....X...", "....X...", "....X...", "........"],
  す: ["....X...", "XXXXXXXX", "....X...", "..XXX...", ".X..X...", "..XXX...", "....X...", "...X...."],
  し: [".X......", ".X......", ".X......", ".X......", ".X......", ".X.....X", ".X....X.", "..XXXX.."],
};

/** A `w×h` raster of `runs` as `X`/`.` rows, and whether any pixel was painted twice. Throws on a run off the raster. */
function raster(runs: readonly Run[], w: number, h: number): { rows: string[]; twice: boolean } {
  const cells = Array.from({ length: h }, () => Array<number>(w).fill(0));
  for (const [x, y, rw, rh] of runs) {
    if (x < 0 || y < 0 || rw < 1 || rh < 1 || x + rw > w || y + rh > h) throw new Error(`run ${[x, y, rw, rh]} off ${w}×${h}`);
    for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) cells[j][i]++;
  }
  return { rows: cells.map((r) => r.map((n) => (n ? "X" : ".")).join("")), twice: cells.flat().some((n) => n > 1) };
}

/** One glyph's runs, from the cell's top-left. */
const runsOf = (ch: string): Run[] => kanaText(ch, false).runs;

/** The lit pixels of a bitmap. */
const lit = (rows: readonly string[]): [number, number][] =>
  rows.flatMap((row, y) => [...row].flatMap((c, x): [number, number][] => (c === "X" ? [[x, y]] : [])));

/** The glyph's separate marks — 8-connected groups of lit pixels — as boxes [x, y, w, h], in scan order. */
function marks(rows: readonly string[]): [number, number, number, number][] {
  const seen = new Set<string>();
  const out: [number, number, number, number][] = [];
  for (const [x0, y0] of lit(rows)) {
    if (seen.has(`${x0},${y0}`)) continue;
    const group: [number, number][] = [];
    const stack: [number, number][] = [[x0, y0]];
    seen.add(`${x0},${y0}`);
    while (stack.length) {
      const [x, y] = stack.pop() as [number, number];
      group.push([x, y]);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${x + dx},${y + dy}`;
          if (rows[y + dy]?.[x + dx] === "X" && !seen.has(k)) {
            seen.add(k);
            stack.push([x + dx, y + dy]);
          }
        }
    }
    const xs = group.map(([x]) => x);
    const ys = group.map(([, y]) => y);
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1]);
  }
  return out;
}

/** The bounding box [x0, y0, x1, y1] (inclusive) of a bitmap's ink. */
function bbox(rows: readonly string[]): [number, number, number, number] {
  const px = lit(rows);
  const xs = px.map(([x]) => x);
  const ys = px.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ───────────────────────────── the font ─────────────────────────────

describe("the font", () => {
  it("is an 8×8 cell, and draws exactly the kana the signs spell — plus the upright long-vowel stroke, nothing else", () => {
    expect([KANA_W, KANA_H]).toEqual([8, 8]);
    const spelled = new Set(SIGN_WORDS.flatMap(({ text }) => [...text]));
    expect(new Set(KANA_CHARS)).toEqual(new Set([...spelled, "｜"]));
    expect([...KANA_CHARS]).toHaveLength(spelled.size + 1);
    expect(Object.keys(ART).sort()).toEqual([...KANA_CHARS].sort());
  });

  it("every glyph's runs paint exactly its bitmap — each pixel once, nothing outside the cell", () => {
    for (const ch of KANA_CHARS) {
      const got = raster(runsOf(ch), KANA_W, KANA_H);
      expect(got.rows, ch).toEqual(ART[ch]);
      expect(got.twice, ch).toBe(false);
    }
  });

  it("merges each glyph into as few rects as its rows allow — a stem is one rect", () => {
    expect(runsOf("｜")).toEqual([[4, 1, 1, 6]]);
    expect(runsOf("ー")).toEqual([[1, 3, 6, 1]]);
    expect(runsOf("コ")).toEqual([
      [1, 1, 6, 1],
      [6, 2, 1, 4],
      [1, 6, 6, 1],
    ]);
    expect(runsOf("し")).toEqual([
      [1, 0, 1, 7],
      [7, 5, 1, 1],
      [6, 6, 1, 1],
      [2, 7, 4, 1],
    ]);
    const counts = Object.fromEntries([...KANA_CHARS].map((ch) => [ch, runsOf(ch).length]));
    expect(counts).toEqual({
      ラ: 7, メ: 10, ン: 7, ソ: 7, バ: 8, カ: 7, オ: 8, ケ: 7, ゲ: 8, レ: 5,
      コ: 3, ヒ: 5, ム: 7, ホ: 8, テ: 6, ル: 7, ー: 1, "｜": 1, す: 9, し: 4,
    });
    // Nothing is left to merge: no run ends where another begins on a row they share, and none sits
    // right on top of one of the same columns.
    for (const ch of KANA_CHARS) {
      const runs = runsOf(ch);
      for (const a of runs)
        for (const b of runs) {
          const shareRow = a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
          expect(shareRow && a[0] + a[2] === b[0], `${ch}: ${a} touches ${b}`).toBe(false);
          expect(a[0] === b[0] && a[2] === b[2] && a[1] + a[3] === b[1], `${ch}: ${a} over ${b}`).toBe(false);
        }
    }
  });

  it("draws every stroke 1 px: no 2×2 block of lit pixels in any glyph, not even where strokes meet", () => {
    for (const ch of KANA_CHARS) {
      const rows = ART[ch];
      for (let y = 0; y + 1 < KANA_H; y++)
        for (let x = 0; x + 1 < KANA_W; x++) {
          const block = rows[y][x] + rows[y][x + 1] + rows[y + 1][x] + rows[y + 1][x + 1];
          expect(block, `${ch} at ${x},${y}`).not.toBe("XXXX");
        }
    }
  });

  it("sits every glyph in the cell the same way: on the bottom row, from the top, at least 7 px wide — コ, ー and ｜ centred", () => {
    for (const ch of KANA_CHARS) {
      if ("コー｜".includes(ch)) continue;
      const [x0, y0, x1, y1] = bbox(ART[ch]);
      expect(y1, `${ch} stands on the bottom row`).toBe(KANA_H - 1);
      expect(y0, `${ch} rises to the top`).toBeLessThanOrEqual(1);
      expect(x1 - x0 + 1, `${ch} fills the width`).toBeGreaterThanOrEqual(KANA_W - 1);
    }
    // The small ones, centred: コ in the middle 6×6, ー and ｜ 6 px long, the ｜ on the stem column
    // that ホ, テ and す share (so a vertical sign's strokes line up).
    expect(bbox(ART["コ"])).toEqual([1, 1, 6, 6]);
    expect(bbox(ART["ー"])).toEqual([1, 3, 6, 3]);
    expect(bbox(ART["｜"])).toEqual([4, 1, 4, 6]);
    for (const ch of "ホテす") expect(lit(ART[ch]).filter(([x]) => x === 4).length, ch).toBeGreaterThanOrEqual(3);
  });

  it("keeps the dakuten apart: two 2-px ticks, a dark column between, a clear pixel round them", () => {
    for (const ch of "バゲ") {
      const m = marks(ART[ch]);
      // Each tick is a mark of its own (8-connected: not even a corner touches the body).
      expect(m, ch).toContainEqual([5, 0, 1, 2]);
      expect(m, ch).toContainEqual([7, 0, 1, 2]);
      expect(ART[ch][0][6] + ART[ch][1][6], ch).toBe("..");
    }
    // No other glyph carries a tick there.
    for (const ch of KANA_CHARS) if (!"バゲ".includes(ch)) expect(marks(ART[ch]), ch).not.toContainEqual([7, 0, 1, 2]);
  });

  it("draws each kana as its strokes: the separate marks a reader sees", () => {
    const count = Object.fromEntries([...KANA_CHARS].map((ch) => [ch, marks(ART[ch]).length]));
    expect(count).toEqual({
      ラ: 2, メ: 1, ン: 2, ソ: 2, バ: 4, カ: 1, オ: 1, ケ: 1, ゲ: 3, レ: 1,
      コ: 1, ヒ: 1, ム: 1, ホ: 3, テ: 2, ル: 2, ー: 1, "｜": 1, す: 1, し: 1,
    });
  });

  it("tells ソ from ン by stroke direction: ソ's dot stands and its stroke falls from the top; ン's lies flat and rises lower", () => {
    const [soDot, soStroke] = marks(ART["ソ"]);
    const [nDot, nStroke] = marks(ART["ン"]);
    expect(soDot[3]).toBeGreaterThan(soDot[2]); // upright
    expect(nDot[2]).toBeGreaterThan(nDot[3]); // flat
    expect(soStroke[1]).toBe(0); // from the very top
    expect(nStroke[1]).toBeGreaterThanOrEqual(2); // a quarter of the way down
    expect(nStroke[0] + nStroke[2]).toBe(KANA_W); // to the right edge
  });

  it("tells し from レ: し rounds off into a short rise, レ turns a sharp corner into a long one", () => {
    const rise = (rows: readonly string[]) => KANA_H - Math.min(...lit(rows).filter(([x]) => x === KANA_W - 1).map(([, y]) => y));
    expect(rise(ART["レ"])).toBeGreaterThan(rise(ART["し"]));
    expect(ART["レ"][7][1]).toBe("X"); // the corner
    expect(ART["し"][7][1]).toBe("."); // the curve
  });

  it("keeps す's loop: a ring left of the stem, its hole dark", () => {
    const rows = ART["す"];
    expect([rows[3].slice(1, 5), rows[4].slice(1, 5), rows[5].slice(1, 5)]).toEqual([".XXX", "X..X", ".XXX"]);
  });
});

// ───────────────────────────── kanaText ─────────────────────────────

/** `word`'s expected raster: the art of each of its glyphs (ー upright when vertical), `gap` apart. */
function expected(word: string, vertical: boolean, gap: number): string[] {
  const chars = [...word].map((ch) => (vertical && ch === "ー" ? "｜" : ch));
  if (vertical) return chars.flatMap((ch, i) => [...(i ? Array<string>(gap).fill(".".repeat(KANA_W)) : []), ...ART[ch]]);
  return ART[chars[0]].map((_, y) => chars.map((ch) => ART[ch][y]).join(".".repeat(gap)));
}

describe("kanaText", () => {
  it("spells every sign word both ways: each glyph's art in its place, the text's size right", () => {
    for (const { text } of SIGN_WORDS) {
      const n = [...text].length;
      for (const vertical of [false, true]) {
        const t = kanaText(text, vertical);
        expect([t.w, t.h], text).toEqual(vertical ? [KANA_W, n * KANA_H + (n - 1)] : [n * KANA_W + (n - 1), KANA_H]);
        const got = raster(t.runs, t.w, t.h);
        expect(got.rows, `${text} ${vertical ? "vertical" : "horizontal"}`).toEqual(expected(text, vertical, 1));
        expect(got.twice).toBe(false);
      }
    }
  });

  it("turns ー upright in vertical text only — every other glyph is the same both ways", () => {
    const h = kanaText("バー", false).runs;
    const v = kanaText("バー", true).runs;
    expect(h.slice(-1)).toEqual([[KANA_W + 1 + 1, 3, 6, 1]]); // ー, after バ and the gap
    expect(v.slice(-1)).toEqual([[4, KANA_H + 1 + 1, 1, 6]]); // ｜, under バ and the gap
    expect(v.slice(0, -1)).toEqual(h.slice(0, -1));
    expect(kanaText("ー", true).runs).toEqual(kanaText("｜", false).runs);
    expect(kanaText("｜", true).runs).toEqual(kanaText("｜", false).runs);
  });

  it("sets the glyphs `gap` px apart — 1 by default — and sizes the text to match", () => {
    expect(kanaText("ソバ", false)).toEqual(kanaText("ソバ", false, 1));
    expect(kanaText("ソバ", true)).toEqual(kanaText("ソバ", true, 1));
    for (const gap of [0, 1, 3]) {
      for (const vertical of [false, true]) {
        const t = kanaText("ソバ", vertical, gap);
        const step = (vertical ? KANA_H : KANA_W) + gap;
        expect([t.w, t.h]).toEqual(vertical ? [KANA_W, 2 * KANA_H + gap] : [2 * KANA_W + gap, KANA_H]);
        // バ is ソ's cell moved one step along the line.
        const ba = runsOf("バ").map(([x, y, w, h]) => (vertical ? [x, y + step, w, h] : [x + step, y, w, h]));
        expect(t.runs.slice(runsOf("ソ").length)).toEqual(ba);
        expect(raster(t.runs, t.w, t.h).rows).toEqual(expected("ソバ", vertical, gap));
      }
    }
  });

  it("lays out a single glyph as the glyph itself, and an empty text as nothing at all", () => {
    expect(kanaText("す", false)).toEqual({ runs: runsOf("す"), w: KANA_W, h: KANA_H });
    expect(kanaText("す", true, 5)).toEqual({ runs: runsOf("す"), w: KANA_W, h: KANA_H });
    expect(kanaText("", false, 3)).toEqual({ runs: [], w: 0, h: KANA_H });
    expect(kanaText("", true, 3)).toEqual({ runs: [], w: KANA_W, h: 0 });
  });

  it("throws on a character the font lacks, naming it — a sign never draws a silent gap", () => {
    expect(() => kanaText("ア", false)).toThrow('kana: no glyph for "ア" in "ア"');
    // Sushi is hiragana (the chosen spelling): its katakana is not in the font.
    expect(() => kanaText("スシ", true)).toThrow('kana: no glyph for "ス" in "スシ"');
    expect(() => kanaText("ラーメンX", false)).toThrow('kana: no glyph for "X" in "ラーメンX"');
    expect(() => kanaText("ｰ", true)).toThrow(/no glyph for "ｰ"/); // the half-width mark is not ー
    // A character beyond the BMP is named whole, not as half a surrogate pair.
    expect(() => kanaText("ラーメン🍜", false)).toThrow('kana: no glyph for "🍜" in "ラーメン🍜"');
  });

  it("is deterministic and hands out fresh runs (a caller's edit cannot reach the font)", () => {
    const a = kanaText("カラオケ", true);
    expect(kanaText("カラオケ", true)).toEqual(a);
    (a.runs[0] as unknown as number[])[0] = 99;
    expect(kanaText("カラオケ", true).runs[0][0]).not.toBe(99);
  });
});
