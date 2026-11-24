/**
 * "Was this tab released OUTSIDE the window?" — the drag half of tear-off
 * (docs/design/tab-tearoff.md §5).
 *
 * HTML5 drag cannot see a drop outside the window: `dragend` fires either way, and a drag
 * released over the desktop is indistinguishable, in the DOM, from a cancelled one. And
 * Tauri's own drag-drop events are off on purpose (`dragDropEnabled: false` is load-bearing —
 * turning it on kills HTML5 drag on Windows). So the answer is asked of the OS, once, at
 * `dragend`: where is the cursor, and where is the window?
 *
 * The decision is a pure function ({@link releasedOutside}) so every awkward input is a unit
 * test — multi-monitor negative coordinates, mixed-DPI macOS, and Wayland, where tao's
 * `cursor_position` returns a hard-coded `(0, 0)` (not an error, so nothing fails loudly):
 * there the gesture degrades to "nothing happens" and the Move to New Window command is the
 * way out. The OS reads that feed it ({@link probeRelease}) are kept apart and thin.
 */

import {
  cursorPosition,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";

import { isMac } from "../../features/shortcuts/shortcuts";
import type { ScreenPoint } from "./contract";

/** A window's outer rectangle (`outerPosition()` + `outerSize()`), as the platform reports it. */
export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything {@link releasedOutside} needs, read from the OS at `dragend`. */
export interface ReleaseProbe {
  /** `cursorPosition()`, raw; `null` when it could not be read. */
  cursor: ScreenPoint | null;
  /** The source window's outer frame, raw. */
  frame: WindowFrame;
  /**
   * The factor the platform scaled `cursor` by. On macOS tao multiplies EVERY cursor reading
   * by the PRIMARY monitor's factor, while a window's frame is scaled by its OWN monitor's —
   * so on a mixed-DPI desk the two raw numbers are in different units. Elsewhere both are
   * physical pixels of one virtual desktop, and both factors are 1.
   */
  cursorScale: number;
  /** The factor the platform scaled `frame` by (see `cursorScale`). */
  frameScale: number;
}

/**
 * How far past the window's edge a release still counts as inside, in logical pixels — so
 * letting go a hair outside the frame by accident does not spawn a window. (Chrome's
 * equivalent is its 15 px vertical detach magnetism.)
 */
export const EDGE_SLOP = 8;

const usable = (n: number): boolean => Number.isFinite(n);
const factor = (n: number): number => (usable(n) && n > 0 ? n : 1);

/**
 * True only when the cursor is DEFINITELY outside the window, beyond `slop`.
 *
 * Every doubt answers false, because a false "outside" opens a window the user never asked
 * for, while a false "inside" costs nothing (the command still works):
 * - no cursor reading, or a non-finite one;
 * - exactly `(0, 0)` — Wayland's hard-coded answer. A real release in the very corner of the
 *   primary display reads the same and is given up on purpose;
 * - a frame with a non-finite edge.
 * Negative coordinates are ordinary: a monitor left of or above the primary one.
 */
export function releasedOutside(probe: ReleaseProbe, slop: number = EDGE_SLOP): boolean {
  const { cursor, frame } = probe;
  if (!cursor || !usable(cursor.x) || !usable(cursor.y)) return false;
  if (cursor.x === 0 && cursor.y === 0) return false;
  if (![frame.x, frame.y, frame.width, frame.height].every(usable)) return false;

  const cs = factor(probe.cursorScale);
  const fs = factor(probe.frameScale);
  const x = cursor.x / cs;
  const y = cursor.y / cs;
  const left = frame.x / fs - slop;
  const top = frame.y / fs - slop;
  const right = (frame.x + frame.width) / fs + slop;
  const bottom = (frame.y + frame.height) / fs + slop;
  return x < left || x > right || y < top || y > bottom;
}

/**
 * Read the cursor and this window's frame from the OS, with the scale factors
 * {@link releasedOutside} needs. `null` when any read fails — the caller treats that as
 * "not outside", exactly like an unknown cursor.
 */
export async function probeRelease(): Promise<ReleaseProbe | null> {
  try {
    const win = getCurrentWindow();
    const [cursor, position, size] = await Promise.all([
      cursorPosition(),
      win.outerPosition(),
      win.outerSize(),
    ]);
    const [cursorScale, frameScale] = isMac()
      ? await Promise.all([
          primaryMonitor().then((m) => m?.scaleFactor ?? 1),
          win.scaleFactor(),
        ])
      : [1, 1];
    return {
      cursor: { x: cursor.x, y: cursor.y },
      frame: { x: position.x, y: position.y, width: size.width, height: size.height },
      cursorScale,
      frameScale,
    };
  } catch {
    return null;
  }
}
