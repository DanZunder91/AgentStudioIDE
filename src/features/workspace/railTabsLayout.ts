/** The rail strip's width budget as code: as many tabs as fit, the rest behind a tab-sized "⋯".
 * Pure arithmetic over the store's `rightRailWidth` (the layout truth; jsdom-testable). Constants
 * mirror `src/App.css`; `src/e2e/railChrome.browser.test.tsx` turns drift red. */

/** One tab's width: 13px glyph + 2 × 2px `.rail__tab` horizontal padding. */
export const TAB_W = 17;

/** `.rail__tabs` column-gap. 10px since the sixth tab's shave. */
export const TAB_GAP = 10;

/** Chrome the strip pays before any tab: 1px `.rail--right` border-left + 2 × 10px `.rail__tabs` horizontal padding. */
export const STRIP_CHROME = 21;

/** The "⋯" overflow trigger is styled exactly like a tab, so it costs exactly one. */
export const TRIGGER_W = 17;

/** Tabs shown at `railWidth`: all (no trigger) when they fit, else the largest n ≥ 1 that fits
 * with the trigger; an unmeasured or non-positive width shows all. TRIGGER_W = TAB_W, so seven
 * tabs go from 5 + trigger straight to 7 (at 180: 5 visible; at 300: all). */
export function visibleTabCount(railWidth: number, tabCount: number): number {
  if (!Number.isFinite(railWidth) || railWidth <= 0) return tabCount;

  const available = railWidth - STRIP_CHROME;

  // Everything fits on one row — no trigger, nothing hidden.
  if (tabCount * TAB_W + (tabCount - 1) * TAB_GAP <= available) return tabCount;

  // n·TAB_W + (n−1)·TAB_GAP + TAB_GAP + TRIGGER_W = n·(TAB_W + TAB_GAP) + TRIGGER_W ≤ available.
  const n = Math.floor((available - TRIGGER_W) / (TAB_W + TAB_GAP));
  return Math.max(1, n);
}
