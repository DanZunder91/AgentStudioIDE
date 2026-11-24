/**
 * Preview zoom — the pure math behind the markdown preview's canvas-style zoom
 * (ctrl/cmd+scroll to zoom, ctrl/cmd+drag to pan, − / % / + buttons in the
 * editor bar).
 *
 * Lives apart from `MarkdownPreview.tsx` so the store can import the exact
 * clamp the UI uses (the `clampSplit` precedent in db/console) without pulling
 * the component's CSS/mermaid imports into its module graph.
 */

export const PREVIEW_ZOOM_MIN = 0.25;
export const PREVIEW_ZOOM_MAX = 4;
export const PREVIEW_ZOOM_DEFAULT = 1;

/** One −/+ button press multiplies/divides by this — ≈ one wheel notch. */
export const PREVIEW_ZOOM_STEP = 1.25;

/**
 * Wheel-to-zoom rate on pixel-normalized deltas. Chosen so one classic mouse
 * notch (≈100px) ≈ the button step: exp(0.22) ≈ 1.246, and trackpad pinch
 * (ctrlKey wheel events with single-digit deltas) moves in fine increments.
 */
const WHEEL_ZOOM_RATE = 0.0022;

/* WheelEvent.deltaMode values, named locally so this module stays DOM-free. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** Chromium's wheel convention is 3 lines ≈ 100px — so one line ≈ 100/3 px. */
const LINE_PIXELS = 100 / 3;
const PAGE_PIXELS = 800;

/** Clamp into [MIN, MAX]; non-finite input falls back to the default (100%). */
export function clampPreviewZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return PREVIEW_ZOOM_DEFAULT;
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, zoom));
}

/** One −/+ button press: multiply (in) or divide (out) by the step, clamped. */
export function stepPreviewZoom(current: number, direction: 1 | -1): number {
  const base = clampPreviewZoom(current);
  return clampPreviewZoom(
    direction === 1 ? base * PREVIEW_ZOOM_STEP : base / PREVIEW_ZOOM_STEP,
  );
}

/**
 * The next zoom after a ctrl/cmd+wheel event. Negative deltaY (wheel up /
 * pinch out) zooms in; positive zooms out. Exponential, so steps compose
 * symmetrically and a pinch feels linear.
 */
export function wheelPreviewZoom(
  current: number,
  deltaY: number,
  deltaMode: number,
): number {
  const px =
    deltaMode === DOM_DELTA_LINE
      ? deltaY * LINE_PIXELS
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * PAGE_PIXELS
        : deltaY;
  return clampPreviewZoom(clampPreviewZoom(current) * Math.exp(-px * WHEEL_ZOOM_RATE));
}

/**
 * Scroll adjustment that keeps the content point under the cursor stationary
 * across a zoom change. `unscaled` is the cursor offset in the body's UNSCALED
 * coordinate space ((clientX − bodyRect.left) / oldZoom); the return value is
 * added to scrollLeft/scrollTop after the new scale has been applied.
 */
export function anchorScrollDelta(
  unscaled: number,
  oldZoom: number,
  newZoom: number,
): number {
  return unscaled * (newZoom - oldZoom);
}

/**
 * The zoom that makes one diagram fit the pane — the "Fit" control pinned to
 * each rendered diagram (a button over the diagram that zooms it automatically,
 * to 50% in some cases and 200% in others). Both of those numbers
 * come out of this one rule: a diagram taller than the pane zooms OUT to be
 * seen whole, a diagram smaller than the pane zooms IN to fill it, and a wide
 * short one is already fitted at 100% and stays there.
 *
 * It is measurement-based, not metadata-based, and that is what makes it exact
 * for every diagram type without asking mermaid anything. The key property:
 * at zoom Z a diagram's on-screen size is `min(natural, paneWidth) · Z`, and
 * that `min` does NOT depend on Z — the CSS ceiling is
 * `calc(100% * var(--mdp-zoom))`, a constant in CSS pixels. So the
 * on-screen size is exactly linear in the zoom, and scaling the CURRENT zoom by
 * the ratio the diagram is currently off by lands on the fit precisely.
 *
 * `diagram` and `pane` are both in device pixels, measured at `current` zoom.
 * A zero or non-finite dimension — a collapsed pane, a diagram that has not
 * been laid out — returns `current` unchanged rather than a garbage zoom.
 */
export function fitPreviewZoom(
  current: number,
  diagram: { width: number; height: number },
  pane: { width: number; height: number },
): number {
  const base = clampPreviewZoom(current);
  const dims = [diagram.width, diagram.height, pane.width, pane.height];
  if (dims.some((n) => !Number.isFinite(n) || n <= 0)) return base;
  const ratio = Math.min(pane.width / diagram.width, pane.height / diagram.height);
  return clampPreviewZoom(base * ratio);
}

/** Display label for the reset button: 1.254 → "125%". */
export function formatPreviewZoom(zoom: number): string {
  return `${Math.round(clampPreviewZoom(zoom) * 100)}%`;
}
