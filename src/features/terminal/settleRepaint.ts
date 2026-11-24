/**
 * settleRepaint — a WebGL terminal never lets the frame it drew last be its last one.
 *
 * ## The problem
 *
 * After an app restart two agents came back in two panes. The focused one (B) showed its
 * replayed scrollback; the other (A) stayed BLANK indefinitely (7+ s on a recording) — an
 * outline cursor frozen at row 0 — although Rust had replayed its bytes. Chromium paints both
 * (`restoredPaint.browser.test.tsx`); this is the Linux webview (WebKitGTK, software GL in the
 * E2E container).
 *
 * ## What a recording shows (read frame by frame at 10 fps, not assumed)
 *
 * Every frame fits one rule, and no other explanation tried fits them all (a paused renderer
 * would not have drawn A's blur frame; slow software GL would have caught up within seconds):
 * WebKitGTK puts a WebGL canvas on screen ONE DRAW LATE — the screen shows the frame before the
 * last one the canvas drew, until it draws again. An inference from pixels: this tier cannot
 * run WebKitGTK, so the Docker E2E is the check.
 *   - A, after the restart: its last draw was the replay (banner, cursor on row 1). On screen
 *     was the draw before it — its blur redraw: an empty screen, outline cursor on row 0.
 *     Nothing drew A again (an unfocused terminal has no blinking cursor), so it stayed so.
 *   - B, focused: the same lag, but its blinking cursor draws every 600 ms, so each blink put
 *     the previous frame up — the banner appeared one blink late. The same cause makes
 *     the E2E's pixels trail its log by ~1 s.
 *   - Before the restart, B — blurred while A was typed into — kept a SOLID cursor on screen
 *     for seconds: the pre-blur frame. A blurred terminal draws an outline cursor; its blur
 *     redraw was its last draw, so it never showed.
 *   - The second launch, A alone and focused: blank for one blink, then the banner.
 *
 * The lag is the engine's (WebKitGTK's compositor is out of our reach); what makes it bite is
 * ours: a terminal's LAST draw before it goes quiet is the one that never reaches the screen.
 * So after a terminal has drawn, and then drawn nothing for {@link SETTLE_REPAINT_MS}, it draws
 * the same frame once more. On a lagging engine that puts the real frame up; anywhere else it
 * repaints identical pixels. A quiet unfocused terminal draws nothing, so costs nothing; a
 * focused one draws once more per cursor blink (which also makes the blink itself honest on
 * the lagging engine).
 *
 * ## The rules, and why each one
 *
 * - EVERY frame arms it, not only frames with output: a blur redraw, a resize, a renderer that
 *   just took over (the WebGL addon loads lazily, its first frame is a fresh canvas's first)
 *   can each be the last draw.
 * - Except our own repaint's frame — or it would repaint forever.
 * - …unless output was parsed before that frame was drawn: xterm merges refresh requests into
 *   one animation frame, and the merged frame carries the output, whose last frame must not
 *   hide behind our "this one is ours".
 * - A repaint xterm swallowed (a hidden terminal is paused and draws nothing) must not leave
 *   "the next frame is ours" behind: the claim expires at the next animation frame — after the
 *   one xterm's own callback, requested first, would have drawn in.
 * - WebGL only, decided when the repaint is due (the renderer changes under a terminal: WebGL
 *   loads late, and degrades to DOM on a context loss). The DOM renderer has no canvas to lag.
 * - Hidden terminals (the detached holder) draw nothing, so they arm nothing — no timer runs
 *   for a background agent streaming off screen.
 */

import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * How long a terminal must have drawn nothing before it draws its last frame again. Longer than
 * a frame, so output that streams (and draws every frame anyway) is not doubled; short enough
 * that the stale frame is never on screen long enough to read as "blank".
 */
export const SETTLE_REPAINT_MS = 80;

/** The slice of xterm this needs — real xterm in production. */
export type Repaintable = Pick<Terminal, "onRender" | "onWriteParsed" | "refresh" | "rows">;

/**
 * Wire the settle repaint into `term`. `wanted()` — "is a canvas renderer active?" — is asked
 * each time a repaint is due. Dispose with the terminal.
 */
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
    // Requested AFTER xterm's own animation frame (inside `refresh`), so it runs right after
    // the draw of the repaint — or, if xterm drew nothing (paused), it drops the claim anyway.
    // No later repaint can be requested before it runs: that needs a frame drawn after this
    // one, and this callback runs in the same batch as that frame's draw.
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
