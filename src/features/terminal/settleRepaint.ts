/** WebKitGTK shows a WebGL canvas one draw late, so a terminal's last draw never reaches screen.
 * After {@link SETTLE_REPAINT_MS} with no draw, redraw once. Every frame arms it except our own
 * (unless output was parsed first); WebGL only, checked when due; hidden terminals arm nothing. */

import type { IDisposable, Terminal } from "@xterm/xterm";

/** Longer than a frame, so streaming output is not doubled; short enough that the stale frame
 * never reads as blank. */
export const SETTLE_REPAINT_MS = 80;

/** The slice of xterm this needs — real xterm in production. */
export type Repaintable = Pick<Terminal, "onRender" | "onWriteParsed" | "refresh" | "rows">;

/** `wanted()` (is a canvas renderer active?) is asked each time a repaint is due. Dispose with
 * the terminal. */
export function installSettleRepaint(term: Repaintable, wanted: () => boolean): IDisposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Our repaint was requested and its frame not yet drawn (nor given up on). */
  let ownFramePending = false;
  /** Output was parsed after the last frame — the next frame shows it. */
  let outputPending = false;

  const repaint = (): void => {
    if (!wanted()) return;
    ownFramePending = true;
    term.refresh(0, term.rows - 1);
    // Requested after xterm's own frame (inside `refresh`): runs right after the repaint's draw,
    // or drops the claim if xterm drew nothing (paused).
    requestAnimationFrame(() => {
      ownFramePending = false;
    });
  };

  const written = term.onWriteParsed(() => {
    outputPending = true;
  });

  const drawn = term.onRender(() => {
    // `ownFramePending` is left for the animation-frame callback above to drop: it runs
    // right after this draw, in the same batch.
    const ours = ownFramePending && !outputPending;
    outputPending = false;
    if (ours) return;
    clearTimeout(timer);
    timer = setTimeout(repaint, SETTLE_REPAINT_MS);
  });

  return {
    dispose(): void {
      clearTimeout(timer);
      written.dispose();
      drawn.dispose();
    },
  };
}
