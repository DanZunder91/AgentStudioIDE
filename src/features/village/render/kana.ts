/** Pixel kana for the City's signs: only the kana `SIGN_WORDS` (render/backdrop.ts) needs; a
 * missing one throws, never a silent gap. 8×8 cells, 1-px strokes (no 2×2 lit block); kana.test.ts
 * pins the art and rules. Vertical signs turn `ー` into `｜`; scale the runs, never the art. */

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

/** A glyph's `X` runs, each merged into the run above when columns match (a stem is one rect). */
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

/** `text` as one line of glyph runs from its top-left, `gap` world px apart (top to bottom with an
 * upright `ー` when `vertical`), plus its size. Throws on a character the font lacks. */
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
