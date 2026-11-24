/**
 * Agent Village — a tiny pixel KANA font for the City's shop signs.
 *
 * The backdrop behind the street has neon signs for ramen and soba in katakana, and for sushi in
 * hiragana. The signs spell a fixed list of words (`SIGN_WORDS`,
 * render/backdrop.ts: ラーメン ソバ すし カレー コーヒー カラオケ バー ゲーム ホテル), and this
 * module draws exactly the kana those words need — nothing else, so a character the font lacks is
 * contract drift and throws rather than drawing a silent gap.
 *
 * Our own glyphs, drawn from each kana's stroke structure (no pixel font's bitmaps were
 * copied — the art carries no licence). The neon font's idiom (render/neon.ts): rows of `X`, each
 * glyph pre-merged into as few rectangles as it takes, so a sign costs a few dozen `fillRect`s.
 *
 * The cell is 8×8. The first cut (same day) was 7×7, and 7×7 cannot carry the dakuten: the two
 * marks of ゛ need three columns and two rows of their own in the top-right corner plus a clear
 * pixel between them and the body, and in seven rows ゲ's crossbar had to run straight into them.
 * At 8×8 every glyph is drawn on one set of rules:
 *
 *   - every stroke is 1 px — no 2×2 block of lit pixels anywhere, not even where strokes meet
 *     (オ's ノ leaves the crossbar beside its stem, not out of the crossing), so no glyph looks
 *     bolder than its neighbour;
 *   - a glyph fills the cell (8×8) unless the real kana is smaller than its em: コ sits in the middle
 *     6×6, and ー / ｜ are 6 px long, centred;
 *   - ゛ is two 2-px ticks at columns 5 and 7, rows 0–1, and the body keeps a pixel clear of them
 *     (バ's right stroke starts at row 3; ゲ is ケ moved one row down, its tail folded into the
 *     bottom row, so its crossbar runs under the marks with a clear row between);
 *   - stroke DIRECTION tells the look-alikes apart: ソ's dot stands upright and its long stroke
 *     falls from the very top; ン's dot lies flat and its long stroke rises from the bottom-left to
 *     the right edge a quarter of the way down; し's stem rounds off into a short rise, レ's turns a
 *     sharp corner into a long one;
 *   - す keeps its loop (3 rows, left of the stem) and its tail; ホ, テ, す and ｜ share one stem
 *     column (4), so a vertical sign's strokes line up.
 *
 * Each glyph was checked by eye on a contact sheet beside the system font (×10, and every word both
 * ways); kana.test.ts pins the art and these rules, kana.browser.test.tsx the real pixels.
 *
 * SIZE: at a typical Fit (1280×800 @2x the City's zoom is 1) a world px is one device px, so a
 * glyph is 8 device px — about the smallest a kana stays legible. A sign meant to be read from Fit
 * scales the runs (every run × k), never the art.
 *
 * Vertical signs (tategaki) read top to bottom, and the long-vowel mark turns with the line: `ー`
 * becomes `｜`, as on every Japanese blade sign.
 */

/** A glyph cell, world px: what one character takes along a line (plus the line's `gap`). */
export const KANA_W = 8;
export const KANA_H = 8;

/** One filled rectangle, world px from its cell's (or its text's) top-left. */
export type Run = readonly [dx: number, dy: number, w: number, h: number];

/** The long-vowel mark of horizontal text, and the stroke it becomes in vertical text. */
const CHOON = "ー";
const CHOON_V = "｜";

/** 8×8 kana, top row first (`X` = lit). Our own (see the header for the rules they follow). */
const FONT: Readonly<Record<string, readonly string[]>> = {
  // ── katakana ──
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
  [CHOON]: ["........", "........", "........", ".XXXXXX.", "........", "........", "........", "........"],
  [CHOON_V]: ["........", "....X...", "....X...", "....X...", "....X...", "....X...", "....X...", "........"],
  // ── hiragana ──
  す: ["....X...", "XXXXXXXX", "....X...", "..XXX...", ".X..X...", "..XXX...", "....X...", "...X...."],
  し: [".X......", ".X......", ".X......", ".X......", ".X......", ".X.....X", ".X....X.", "..XXXX.."],
};

/**
 * A glyph as few rectangles as it takes: each row's runs of `X`, each merged down into the run
 * right above it when that one has the same columns (a stem is one tall rect, not eight).
 */
function glyphRuns(rows: readonly string[]): Run[] {
  const out: [number, number, number, number][] = [];
  let above: [number, number, number, number][] = [];
  rows.forEach((row, y) => {
    above = [...row.matchAll(/X+/g)].map(({ index: x, 0: { length: w } }) => {
      const same = above.find((r) => r[0] === x && r[2] === w);
      if (same) {
        same[3]++;
        return same;
      }
      const r: [number, number, number, number] = [x, y, w, 1];
      out.push(r);
      return r;
    });
  });
  return out;
}

const GLYPHS: ReadonlyMap<string, Run[]> = new Map(Object.entries(FONT).map(([ch, rows]) => [ch, glyphRuns(rows)]));

/** Every character the font draws (the vertical long-vowel stroke included). */
export const KANA_CHARS = [...GLYPHS.keys()].join("");

/**
 * `text` laid out as one line of glyphs — top to bottom when `vertical` (its `ー` turned upright),
 * else left to right — `gap` world px apart: the runs from the text's top-left, and its size. Throws
 * on a character the font lacks (the signs are a fixed list: a gap would be a silent typo).
 */
export function kanaText(text: string, vertical: boolean, gap = 1): { runs: Run[]; w: number; h: number } {
  const chars = [...text];
  const runs: Run[] = [];
  chars.forEach((raw, i) => {
    const ch = vertical && raw === CHOON ? CHOON_V : raw;
    const glyph = GLYPHS.get(ch);
    if (!glyph) throw new Error(`kana: no glyph for "${raw}" in "${text}"`);
    const ox = vertical ? 0 : i * (KANA_W + gap);
    const oy = vertical ? i * (KANA_H + gap) : 0;
    for (const [dx, dy, w, h] of glyph) runs.push([ox + dx, oy + dy, w, h]);
  });
  const along = chars.length * (vertical ? KANA_H : KANA_W) + Math.max(0, chars.length - 1) * gap;
  return vertical ? { runs, w: KANA_W, h: along } : { runs, w: along, h: KANA_H };
}
