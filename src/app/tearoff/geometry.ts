/** Was the tab released OUTSIDE the window? (tab-tearoff.md §5). HTML5 can't tell, and Tauri
 * drag-drop stays off (`dragDropEnabled: false`: on, it kills HTML5 drag on Windows), so the OS
 * is asked at `dragend`; the pure {@link releasedOutside} decides. */

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
  /** Factor the platform scaled `cursor` by. macOS tao scales cursors by the PRIMARY monitor's
   * factor but frames by their own, so mixed-DPI units differ; elsewhere both are 1. */
  cursorScale: number;
  /** The factor the platform scaled `frame` by (see `cursorScale`). */
  frameScale: number;
}

/** Logical px past the edge that still count as inside, so an accidental hair-outside release
 * does not spawn a window. */
export const EDGE_SLOP = 8;

const usable = (n: number): boolean => Number.isFinite(n);
const factor = (n: number): number => (usable(n) && n > 0 ? n : 1);

/** True only when DEFINITELY outside beyond `slop`; every doubt is false (a false "outside"
 * opens an unwanted window): missing/non-finite reads, a non-finite frame, and exactly `(0, 0)`
 * (Wayland's hard-coded cursor). Negative coordinates are normal (monitors left/above). */
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

/** Read the cursor, this window's frame and scale factors from the OS; `null` on any failure,
 * which the caller treats as "not outside". */
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
