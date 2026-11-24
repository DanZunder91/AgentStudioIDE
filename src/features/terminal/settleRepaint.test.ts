/**
 * The settle repaint's rules (`settleRepaint.ts`), one test each, on a terminal whose frames
 * the test draws by hand — so "a frame was drawn", "output was parsed" and "the animation
 * frame ran" happen exactly when the test says. The same module on real xterm and a real
 * WebGL canvas, in real layout, is `restoredPaint.browser.test.tsx`.
 *
 * What the rules protect against, on an engine that shows a canvas one draw late
 * (WebKitGTK): a terminal whose last draw was its output shows the frame before it —
 * blank — until something draws again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSettleRepaint, SETTLE_REPAINT_MS, type Repaintable } from "./settleRepaint";

/** A terminal the test drives: `draw()` is xterm finishing a frame, `parse()` a write landing. */
function fakeTerminal(rows = 30) {
  const renders = new Set<() => void>();
  const writes = new Set<() => void>();
  const refresh = vi.fn<(start: number, end: number) => void>();
  const listen = (set: Set<() => void>) => (fn: () => void) => {
    set.add(fn);
    return { dispose: () => set.delete(fn) };
  };
  const term = {
    rows,
    refresh,
    onRender: listen(renders),
    onWriteParsed: listen(writes),
  } as unknown as Repaintable;
  return {
    term,
    refresh,
    draw: () => renders.forEach((fn) => fn()),
    parse: () => writes.forEach((fn) => fn()),
    listeners: () => renders.size + writes.size,
  };
}

/** One animation frame's worth of time — the fake rAF runs its callbacks on it. */
const FRAME_MS = 16;

describe("installSettleRepaint", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws the whole screen once more when a frame was the last one for a while", () => {
    const t = fakeTerminal(30);
    installSettleRepaint(t.term, () => true);
    t.parse();
    t.draw(); // the replay's frame — on a lagging engine, NOT the one on screen

    vi.advanceTimersByTime(SETTLE_REPAINT_MS - 1);
    expect(t.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.refresh.mock.calls).toEqual([[0, 29]]);
  });

  it("its own frame does not arm it again — one repaint, not a loop", () => {
    const t = fakeTerminal();
    installSettleRepaint(t.term, () => true);
    t.parse();
    t.draw(); // output's frame — it, and only it, carried the output
    vi.advanceTimersByTime(SETTLE_REPAINT_MS);
    expect(t.refresh).toHaveBeenCalledTimes(1);

    t.draw(); // xterm draws the repaint in the next animation frame
    vi.advanceTimersByTime(FRAME_MS + SETTLE_REPAINT_MS * 10);
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it("any frame arms it, not only output — a blur redraw can be the last draw too", () => {
    const t = fakeTerminal();
    installSettleRepaint(t.term, () => true);
    t.draw(); // no `parse()`: a focus change, a resize, a renderer that just took over
    vi.advanceTimersByTime(SETTLE_REPAINT_MS);
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it("frames that keep coming push it back, so streaming output is not drawn twice", () => {
    const t = fakeTerminal();
    installSettleRepaint(t.term, () => true);
    for (let i = 0; i < 5; i++) {
      t.parse();
      t.draw();
      vi.advanceTimersByTime(SETTLE_REPAINT_MS - 10);
    }
    expect(t.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it("a write that lands before its frame is drawn makes that frame output's — it arms again", () => {
    const t = fakeTerminal();
    installSettleRepaint(t.term, () => true);
    t.draw();
    vi.advanceTimersByTime(SETTLE_REPAINT_MS); // repaint #1 requested…
    t.parse(); // …a write lands before its frame…
    t.draw(); // …and xterm draws both in ONE frame: the write's last frame
    vi.advanceTimersByTime(SETTLE_REPAINT_MS);
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });

  it("a repaint the terminal never drew (hidden, paused) does not claim the next real frame", () => {
    const t = fakeTerminal();
    installSettleRepaint(t.term, () => true);
    t.draw();
    vi.advanceTimersByTime(SETTLE_REPAINT_MS); // repaint requested; xterm is paused, draws nothing
    vi.advanceTimersByTime(FRAME_MS); // the animation frame passes without a draw

    t.draw(); // shown again: xterm's full refresh — a real frame, and possibly the last
    vi.advanceTimersByTime(SETTLE_REPAINT_MS);
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });

  it("asks whether it is wanted when the repaint is due, not when it was armed", () => {
    // The DOM renderer drew the frame; WebGL (lazily loaded) has taken over by the time it is due.
    let webgl = false;
    const t = fakeTerminal();
    installSettleRepaint(t.term, () => webgl);
    t.draw();
    webgl = true;
    vi.advanceTimersByTime(SETTLE_REPAINT_MS);
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing for the DOM renderer, which has no canvas to lag", () => {
    const t = fakeTerminal();
    installSettleRepaint(t.term, () => false);
    t.parse();
    t.draw();
    vi.advanceTimersByTime(SETTLE_REPAINT_MS * 10);
    expect(t.refresh).not.toHaveBeenCalled();
  });

  it("dispose cancels a repaint that is due and stops listening", () => {
    const t = fakeTerminal();
    const handle = installSettleRepaint(t.term, () => true);
    expect(t.listeners()).toBe(2);
    t.draw();
    handle.dispose();
    expect(t.listeners()).toBe(0);
    vi.advanceTimersByTime(SETTLE_REPAINT_MS * 10);
    expect(t.refresh).not.toHaveBeenCalled();
  });
});
