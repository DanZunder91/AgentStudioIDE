/** Labels drawn at SCREEN scale (a real font, sharp at any zoom) on a backing box, anchored in the
 * world. `placeLabels` lays them out greedily in rank order: an overlapping label moves one line
 * down, then is dropped. */

import type { DrawItem } from "../villageTypes";
import type { Camera } from "./camera";
import { sx, sy } from "./paint";
import type { DrawTarget } from "./renderTypes";

/** Derived from DrawItem, never restated, so `STYLE` must name exactly the engine's tones. */
export type LabelTone = Extract<DrawItem, { t: "label" }>["tone"];

interface ToneStyle {
  size: number;
  weight: string;
  color: string;
  backing: string;
  border: string | null;
  pad: number;
  maxChars: number;
}

const STYLE: Record<LabelTone, ToneStyle> = {
  house: {
    size: 12,
    weight: "bold ",
    color: "#ffe9b0",
    backing: "#5b3a22",
    border: "#a87444",
    pad: 5,
    maxChars: 28,
  },
  agent: {
    size: 10,
    weight: "",
    color: "#e6e8ee",
    backing: "rgba(12, 14, 20, 0.78)",
    border: null,
    pad: 3,
    maxChars: 18,
  },
  floor: {
    size: 10,
    weight: "",
    color: "#f3ead6",
    backing: "rgba(38, 30, 24, 0.84)",
    border: "#8a6440",
    pad: 4,
    maxChars: 24,
  },
  // A capacity house's board / HQ floor plate (villageTypes `civic`): a cooler slate plate so a
  // figure ("Seats 3/10") never reads as a project's house board.
  civic: {
    size: 11,
    weight: "bold ",
    color: "#e8f1ff",
    backing: "#2c3e5a",
    border: "#6d8fbf",
    pad: 5,
    maxChars: 28,
  },
  // A usage gauge's own caption ("5h 41%"), under the gauge: small, on the civic slate.
  gauge: {
    size: 9,
    weight: "",
    color: "#e8f1ff",
    backing: "rgba(28, 40, 60, 0.88)",
    border: null,
    pad: 3,
    maxChars: 12,
  },
};
const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
/** Screen px kept clear between two placed labels. */
export const LABEL_GAP = 2;

/** `measureText` widths by font + text: the same few strings repeat every frame. Bounded: past
 * the cap it starts over. */
const WIDTHS = new Map<string, number>();
const WIDTHS_CAP = 512;

function textWidth(ctx: DrawTarget, font: string, text: string): number {
  const key = `${font}\u0000${text}`;
  let w = WIDTHS.get(key);
  if (w === undefined) {
    if (WIDTHS.size >= WIDTHS_CAP) WIDTHS.clear();
    ctx.font = font;
    w = ctx.measureText(text).width;
    WIDTHS.set(key, w);
  }
  return w;
}

/** Long titles end in an ellipsis so a label never spans half the village (agent tags are shorter). */
export function clipLabel(text: string, max = STYLE.house.maxChars): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A screen-pixel box. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A measured label: its text, font and screen box (before collision placement). */
export interface LabelLayout {
  text: string;
  tone: LabelTone;
  font: string;
  box: Box;
}

/** Measures a label at world (wx, wy): top-centre (agent), centre (house, civic, gauge) or
 * left-middle (floor). `pixelRatio` scales the font for Retina. null for blank text or text that
 * cannot fit `maxW` (world px). */
export function layoutLabel(
  ctx: DrawTarget,
  cam: Camera,
  wx: number,
  wy: number,
  text: string,
  tone: LabelTone,
  pixelRatio = 1,
  maxW?: number,
): LabelLayout | null {
  const style = STYLE[tone];
  const trimmed = text.trim();
  let label = clipLabel(trimmed, style.maxChars);
  if (!label) return null;
  const pr = pixelRatio > 0 ? pixelRatio : 1;
  const size = Math.round((style.size + (cam.zoom / pr >= 4 ? 2 : 0)) * pr);
  const font = `${style.weight}${size}px ${FONT_FAMILY}`;
  const pad = Math.round(style.pad * pr);
  const widthOf = (s: string): number => Math.ceil(textWidth(ctx, font, s)) + pad * 2;
  let w = widthOf(label);
  if (maxW !== undefined) {
    const room = Math.floor(maxW * cam.zoom);
    // Shorter by one letter until it fits; one letter and the ellipsis is as short as it gets.
    for (let n = label.length - 1; w > room && n >= 2; n--) {
      label = clipLabel(trimmed, n);
      w = widthOf(label);
    }
    if (w > room) return null;
  }
  const h = size + Math.round(4 * pr);
  const x = tone === "floor" ? sx(cam, wx) : Math.round(sx(cam, wx) - w / 2);
  const anchor = sy(cam, wy);
  const y = tone === "agent" ? anchor : Math.round(anchor - h / 2);
  return { text: label, tone, font, box: { x, y, w, h } };
}

/** true when two boxes (grown by LABEL_GAP) intersect. */
export function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w + LABEL_GAP &&
    b.x < a.x + a.w + LABEL_GAP &&
    a.y < b.y + b.h + LABEL_GAP &&
    b.y < a.y + a.h + LABEL_GAP
  );
}

/** One label to place: its box, and whether it must be drawn even when it collides. */
export interface PlaceRequest {
  box: Box;
  force: boolean;
}

/** Greedy, in rank order: a forced label is placed as is; any other where it is, then one line
 * lower, whichever is clear first, else dropped (null). */
export function placeLabels(requests: readonly PlaceRequest[]): (Box | null)[] {
  const placed: Box[] = [];
  return requests.map(({ box, force }) => {
    const spots = force
      ? [box]
      : [box, { ...box, y: box.y + box.h + LABEL_GAP }];
    const spot = spots.find(
      (s) => force || !placed.some((p) => overlaps(s, p)),
    );
    if (!spot) return null;
    placed.push(spot);
    return spot;
  });
}

/** Paint a measured label into `box` (its placed position). */
export function paintLabel(
  ctx: DrawTarget,
  layout: LabelLayout,
  box: Box,
): void {
  const style = STYLE[layout.tone];
  ctx.font = layout.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = style.backing;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  if (style.border) {
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
  }
  ctx.fillStyle = style.color;
  ctx.fillText(layout.text, box.x + box.w / 2, box.y + Math.round(box.h / 2));
}

/** Measure and paint one label where its anchor puts it (no collision placement). */
export function drawLabel(
  ctx: DrawTarget,
  cam: Camera,
  wx: number,
  wy: number,
  text: string,
  tone: LabelTone,
  pixelRatio = 1,
): void {
  const layout = layoutLabel(ctx, cam, wx, wy, text, tone, pixelRatio);
  if (layout) paintLabel(ctx, layout, layout.box);
}
