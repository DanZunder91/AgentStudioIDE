/**
 * railTabsLayout — the rail tab strip's width budget as CODE.
 *
 * History, because it is the reason this module exists: the strip's budget lived
 * in prose (an App.css comment + the RailTabs header) and went stale TWICE — the
 * "four glyphs always fit" era shipped a wrap, and the sixth (Tools) tab shipped
 * another until the browser tier caught it and the gap was shaved 14px → 10px.
 * That second fix ended with a warning: a SEVENTH tab does not fit at 10px
 * (169px vs 159px at the drag-min) and needs "a real answer (a smaller glyph, an
 * overflow menu), not another gap shave". The seventh tab (Git) is here, and this
 * is the real answer: the strip shows only as many tabs as the width affords and
 * folds the rest behind a tab-sized "⋯" trigger that opens a menu.
 *
 * DETERMINISTIC on purpose — pure arithmetic over the store's `rightRailWidth`,
 * no ResizeObserver and no DOM reads. The rail's width only ever changes through
 * `setRightRailWidth` (drag, clamped to [RAIL_MIN_W, RAIL_MAX_W]), so the store
 * value IS the layout truth; measuring the box would only add a frame of lag and
 * a source of flake. It also makes the cut testable in jsdom, where boxes are 0×0.
 *
 * The constants mirror `src/App.css` (`.rail__tabs` / `.rail__tab`) and the
 * `.rail--right` border. If a pixel changes there it must change here — and
 * `src/e2e/railChrome.browser.test.tsx` re-derives needed-vs-available from the
 * LIVE boxes precisely so that drift turns a comment lie into a red test.
 */

/** One tab's width: 13px glyph + 2 × 2px `.rail__tab` horizontal padding. */
export const TAB_W = 17;

/** `.rail__tabs` column-gap. 10px since the sixth tab's shave. */
export const TAB_GAP = 10;

/** Chrome the strip pays before any tab: 1px `.rail--right` border-left + 2 × 10px `.rail__tabs` horizontal padding. */
export const STRIP_CHROME = 21;

/** The "⋯" overflow trigger is styled exactly like a tab, so it costs exactly one. */
export const TRIGGER_W = 17;

/**
 * How many of `tabCount` tabs the strip shows at `railWidth`.
 *
 * - Returns `tabCount` (all visible, NO trigger) when every tab fits:
 *   `tabCount·TAB_W + (tabCount−1)·TAB_GAP ≤ railWidth − STRIP_CHROME`.
 * - Otherwise the largest `n ≥ 1` such that n tabs PLUS the trigger fit:
 *   `n·TAB_W + (n−1)·TAB_GAP + TAB_GAP + TRIGGER_W ≤ available`, which collapses
 *   to `n ≤ (available − TRIGGER_W) / (TAB_W + TAB_GAP)`.
 * - Clamped to a minimum of 1: even an absurd width never hides EVERY tab
 *   (never 0, never negative).
 * - A non-finite or non-positive `railWidth` means "collapsed / not yet measured",
 *   and an unmeasured rail must not hide tabs (the same spirit as
 *   `fitPreviewZoom`'s degenerate-box guard): all visible.
 *
 * Anchors, for the reader who wants the sum checked: at 180 (RAIL_MIN_W) the
 * available run is 159px; seven tabs need 7×17 + 6×10 = 179 (over), and the cut
 * lands at 5 visible (5×17 + 4×10 + 10 + 17 = 152 ≤ 159 — six-plus-trigger would
 * be 179). At 300 (the default) all seven fit outright (179 ≤ 279). And because
 * TRIGGER_W = TAB_W, six-plus-trigger costs EXACTLY what seven tabs cost — so
 * with seven tabs the strip never shows six: it goes 5+trigger straight to 7.
 */
export function visibleTabCount(railWidth: number, tabCount: number): number {
  if (!Number.isFinite(railWidth) || railWidth <= 0) return tabCount;

  const available = railWidth - STRIP_CHROME;

  // Everything fits on one row — no trigger, nothing hidden.
  if (tabCount * TAB_W + (tabCount - 1) * TAB_GAP <= available) return tabCount;

  // Overflow: reserve the trigger (one more gap + one tab-sized button) and take
  // the largest n that still fits. The inequality in the docblock solves to this
  // floor because n·TAB_W + (n−1)·TAB_GAP + TAB_GAP + TRIGGER_W
  // = n·(TAB_W + TAB_GAP) + TRIGGER_W.
  const n = Math.floor((available - TRIGGER_W) / (TAB_W + TAB_GAP));
  return Math.max(1, n);
}
