/** Pure math for the markdown preview's zoom (ctrl/cmd+wheel, ctrl/cmd+drag, −/%/+ buttons). Kept
 * out of `MarkdownPreview.tsx` so the store shares the UI's clamp without its CSS/mermaid. */

export const PREVIEW_ZOOM_MIN = 0.25;
export const PREVIEW_ZOOM_MAX = 4;
export const PREVIEW_ZOOM_DEFAULT = 1;

/** One −/+ button press multiplies/divides by this — ≈ one wheel notch. */
export const PREVIEW_ZOOM_STEP = 1.25;

/** Per pixel-normalized wheel delta: one ~100px notch ≈ the button step (exp(0.22) ≈ 1.246). */
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

/** Zoom after a ctrl/cmd+wheel; negative deltaY zooms in. Exponential, so steps compose
 * symmetrically. */
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

/** Scroll delta keeping the content under the cursor still. `unscaled` = (clientX −
 * bodyRect.left) / oldZoom; add the result to scroll after the new scale is applied. */
export function anchorScrollDelta(
  unscaled: number,
  oldZoom: number,
  newZoom: number,
): number {
  return unscaled * (newZoom - oldZoom);
}

/** Zoom that fits one diagram to the pane, out or in. On-screen size is `min(natural, paneWidth)
 * · Z` and that `min` is independent of Z, so scaling `current` by the ratio fits exactly. Device
 * px at `current`; a zero or non-finite size returns `current`. */
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
