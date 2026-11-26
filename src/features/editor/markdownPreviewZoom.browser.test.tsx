/** Preview zoom geometry needs a real layout engine: jsdom has 0x0 rects and inert scroll boxes.
 * Fixtures hand-write post-hydration markup DOMPurify keeps; `--rendered` keeps mermaid off it. */

import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownPreview } from "./MarkdownPreview";
import { PREVIEW_ZOOM_MIN, anchorScrollDelta, wheelPreviewZoom } from "./previewZoom";

// A fenced-block delimiter kept out of the template literals below.
const F = "```";

/** Tall, deliberately narrow content: many short paragraphs + a short-lined
 *  fenced block. Nothing here overflows 600px horizontally at zoom 1. */
const DOC = [
  "# Zoom fixture",
  "",
  ...Array.from({ length: 40 }, (_, i) => [`Paragraph ${i} — short line.`, ""]).flat(),
  `${F}txt`,
  ...Array.from({ length: 20 }, (_, i) => `code ${i}`),
  F,
].join("\n");

/** Hand-written `sizeDiagramForZoom` output (natural width, no inline max-width, `--rendered`)
 * for a 2400px-wide schema, far past the 600px pane. */
const WIDE_ID = "wide-diagram";
const NATURAL_W = 2400;
const WIDE_DOC =
  `${DOC}\n\n<pre class="markdown-preview__mermaid markdown-preview__mermaid--rendered">` +
  `<svg id="${WIDE_ID}" style="width: ${NATURAL_W}px; height: auto;" ` +
  `viewBox="0 0 ${NATURAL_W} 900"></svg></pre>\n`;

/** A wide README image: a `data:` src skips the inlining pass (no image-read IPC), and explicit
 * width/height give it layout before decode. */
const WIDE_IMG_ID = "wide-img";
const WIDE_IMG_DOC =
  `${DOC}\n\n<img id="${WIDE_IMG_ID}" width="${NATURAL_W}" height="900" ` +
  `src="data:image/svg+xml;charset=utf-8,` +
  `%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='${NATURAL_W}'%20height='900'%3E%3C/svg%3E">\n`;

/** The preview in a definite 600×400 box (`.markdown-preview` is height:100%). */
const view = (zoom: number, text: string = DOC): React.JSX.Element => (
  <div style={{ width: 600, height: 400 }}>
    <MarkdownPreview text={text} zoom={zoom} />
  </div>
);

/** The parent owns the zoom (the CodeEditor shape): the anchor scroll applies only after the new
 * zoom is laid out. Uses the wide fixture so horizontal scroll is real. */
function ZoomHarness(): React.JSX.Element {
  const [zoom, setZoom] = useState(2);
  return (
    <div style={{ width: 600, height: 400 }}>
      <MarkdownPreview text={WIDE_DOC} zoom={zoom} onZoomChange={setZoom} />
    </div>
  );
}

/** A diagram block plus its Fit control as the component leaves them. `height: auto` + viewBox
 * keep the aspect ratio, which makes a height-constrained fit testable. */
const diagramBlock = (id: string, width: number, height: number): string =>
  `<pre class="markdown-preview__mermaid markdown-preview__mermaid--rendered">` +
  `<svg id="${id}" style="width: ${width}px; height: auto;" viewBox="0 0 ${width} ${height}"></svg>` +
  `<button class="markdown-preview__fit" data-mdp-fit data-testid="diagram-fit" type="button">Fit</button>` +
  `</pre>`;

/** 400x600 at zoom 2 is height-constrained and fits at ~67%, above the 25% clamp floor. After the
 * 40 paragraphs of DOC, so it starts below the fold. */
const TALL_ID = "tall-diagram";
const TALL_DOC = `${DOC}\n\n${diagramBlock(TALL_ID, 400, 600)}\n`;

/** Claim 6/7: 200x100 — smaller than the pane on BOTH axes at zoom 1, with the
 *  width the tighter of the two, so a correct fit grows it until the width is
 *  the pane and the height still has room to spare. */
const SMALL_ID = "small-diagram";
const SMALL_DOC = `${DOC}\n\n${diagramBlock(SMALL_ID, 200, 100)}\n`;

/** Fit renders only under a controlled zoom, and the deferred `scrollIntoView` lands only after the
 * new zoom is laid out, so this harness round-trips the zoom. */
function FitHarness({
  text,
  initial,
}: {
  text: string;
  initial: number;
}): React.JSX.Element {
  const [zoom, setZoom] = useState(initial);
  return (
    <div style={{ width: 600, height: 400 }}>
      <MarkdownPreview text={text} zoom={zoom} onZoomChange={setZoom} />
    </div>
  );
}

/** A stable no-op handler: `isControlled` only asks whether *some* handler
 *  exists, and a fresh arrow per render would churn the hydration effect. */
const ignoreZoom = (): void => undefined;

/** Controlled, but with the zoom pinned by the CALLER — claim 7 has to set the
 *  zoom to two exact values and never clicks anything, which is the one thing a
 *  self-owning harness cannot do. */
const controlled = (zoom: number, text: string): React.JSX.Element => (
  <div style={{ width: 600, height: 400 }}>
    <MarkdownPreview text={text} zoom={zoom} onZoomChange={ignoreZoom} />
  </div>
);

const container = () => screen.getByTestId("markdown-preview");
const body = () => container().querySelector<HTMLElement>(".markdown-preview__body")!;
/** The live zoom, read back off the body. Numeric, never string (Chromium rounds to 6 digits). */
const zoomNow = (): number => Number(body().style.zoom);
const rectOf = (id: string): DOMRect => document.getElementById(id)!.getBoundingClientRect();

/** The pane's content box as `onFitClick` measures it (client size minus 20/26/40 padding).
 * Re-measured per assertion: a fit can retire a classic scrollbar and resize the pane. */
function paneBox(): { width: number; height: number } {
  const el = container();
  const style = getComputedStyle(el);
  return {
    width: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    height: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
  };
}

/** The container's scrollport (its padding box) in viewport coordinates — the
 *  box `scrollIntoView` aligns against, and therefore the box claim 8 asks the
 *  fitted diagram to be inside of. */
function scrollportBox(): { top: number; bottom: number; left: number; right: number } {
  const el = container();
  const rect = el.getBoundingClientRect();
  const top = rect.top + el.clientTop;
  const left = rect.left + el.clientLeft;
  return { top, bottom: top + el.clientHeight, left, right: left + el.clientWidth };
}

afterEach(() => {
  // Defensive: end any drag a failed assertion left open, so the window-level
  // listeners and the body class never leak into the next test (house pattern).
  fireEvent(window, new PointerEvent("pointerup", { bubbles: true }));
  document.body.classList.remove("is-panning");
});

describe("markdown preview zoom — real geometry (Chromium)", () => {
  it("zooms prose by RE-WRAPPING it: height grows with the zoom, width never overflows", () => {
    const { rerender } = render(view(1));
    const el = container();

    // Real-layout sanity: under jsdom these are 0 and every claim below would
    // be vacuously true — this line is what makes the tier honest.
    expect(el.clientWidth).toBeGreaterThan(500);
    expect(el.clientHeight).toBeGreaterThan(300);

    // zoom 1: the body fills the content box — no horizontal overflow.
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    const heightAt1 = el.scrollHeight;

    rerender(view(2));

    // Under `transform: scale` lines would overflow to the right; `zoom` re-flows them to the pane.
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    // Two-sided: the zoom must actually have done something. Re-wrapped prose
    // is taller than 2× (narrower column ⇒ more lines), never shorter.
    expect(el.scrollHeight).toBeGreaterThan(heightAt1 * 1.8);
    expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
  });

  it("a wide diagram FITS the pane at 100% and is exactly 2x that at 200%", () => {
    // Two-sided: natural size everywhere passes half 2, `max-width: 100%` passes half 1.
    const { rerender } = render(view(1, WIDE_DOC));
    const el = container();
    const diagram = () => document.getElementById(WIDE_ID)!.getBoundingClientRect();

    // Half 1 — "normal size": the 2400px schema is capped to the pane, and it
    // is genuinely capped (its natural width is 4x what it is allowed here).
    const widthAt1 = diagram().width;
    // It fills the body's width exactly — measured against the body, not the
    // container, whose 26px side padding is not part of the available width.
    expect(widthAt1).toBeCloseTo(body().getBoundingClientRect().width, 0);
    expect(NATURAL_W).toBeGreaterThan(widthAt1 * 3); // the cap is really doing work
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth); // no overflow at 100%

    rerender(view(2, WIDE_DOC));

    // A plain `max-width: 100%` fails here: the cap shrinks with the zoomed CSS width.
    expect(diagram().width).toBeCloseTo(widthAt1 * 2, -1);
    expect(el.scrollWidth).toBeGreaterThan(el.clientWidth);
  });

  /** Under `zoom: Z` a `max-width: 100%` image stays W device px at every Z while prose grows. */
  it("a wide README IMAGE fits the pane at 100% and is exactly 2x that at 200%", () => {
    const { rerender } = render(view(1, WIDE_IMG_DOC));
    const el = container();

    const widthAt1 = rectOf(WIDE_IMG_ID).width;
    expect(widthAt1).toBeCloseTo(body().getBoundingClientRect().width, 0);
    expect(NATURAL_W).toBeGreaterThan(widthAt1 * 3); // the cap is really doing work
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);

    rerender(view(2, WIDE_IMG_DOC));

    // The line that reds under the old `max-width: 100%`.
    expect(rectOf(WIDE_IMG_ID).width).toBeCloseTo(widthAt1 * 2, -1);
  });

  it("ctrl+drag pans by real pixels, clamps to the real bound, and dies on pointerup", () => {
    // WIDE fixture: under `zoom` prose re-wraps, so a prose-only document has
    // no horizontal overflow to pan and scrollLeft would clamp to 0 — the test
    // would pass vacuously on the x axis. The wide box makes both axes real.
    render(view(2, WIDE_DOC));
    const el = container();
    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);

    const rect = el.getBoundingClientRect();
    const x = rect.left + 300;
    const y = rect.top + 200;

    fireEvent.pointerDown(el, { ctrlKey: true, button: 0, clientX: x, clientY: y });
    expect(document.body.classList.contains("is-panning")).toBe(true);

    // Cursor moves 40 left / 25 up → grab semantics → scroll grows by 40/25.
    fireEvent(window, new PointerEvent("pointermove", { bubbles: true, clientX: x - 40, clientY: y - 25 }));
    expect(el.scrollLeft).toBeCloseTo(40, 0);
    expect(el.scrollTop).toBeCloseTo(25, 0);

    // A drag far past the content pins at the box's ACTUAL scroll bounds —
    // Chromium clamps the assignment, which is only possible if the scaled
    // overflow is real (10 000 would "stick" on an unclamped stub).
    fireEvent(window, new PointerEvent("pointermove", { bubbles: true, clientX: x - 10_000, clientY: y - 10_000 }));
    expect(Math.abs(el.scrollLeft - (el.scrollWidth - el.clientWidth))).toBeLessThanOrEqual(1);
    expect(Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight))).toBeLessThanOrEqual(1);

    fireEvent(window, new PointerEvent("pointerup", { bubbles: true }));
    expect(document.body.classList.contains("is-panning")).toBe(false);

    // The drag is over: further moves change nothing (listeners removed).
    const left = el.scrollLeft;
    const top = el.scrollTop;
    fireEvent(window, new PointerEvent("pointermove", { bubbles: true, clientX: x - 500, clientY: y - 500 }));
    expect(el.scrollLeft).toBe(left);
    expect(el.scrollTop).toBe(top);
  });

  it("ctrl+wheel keeps the content under the cursor: scroll moves by anchorScrollDelta of the real rects", () => {
    render(<ZoomHarness />);
    const el = container();

    // Start scrolled in both axes so the adjustment is visible and unclamped;
    // read back what Chromium actually accepted rather than trusting the set.
    el.scrollLeft = 100;
    el.scrollTop = 150;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    expect(startLeft).toBeGreaterThan(0);
    expect(startTop).toBeGreaterThan(0);

    const rect = el.getBoundingClientRect();
    const clientX = rect.left + 300;
    const clientY = rect.top + 200;
    // The body rect must be measured BEFORE the wheel: the new scale moves it.
    const bodyRect = body().getBoundingClientRect();

    const oldZoom = 2;
    const newZoom = wheelPreviewZoom(oldZoom, -100, 0);
    const expectedLeft =
      startLeft + anchorScrollDelta((clientX - bodyRect.left) / oldZoom, oldZoom, newZoom);
    const expectedTop =
      startTop + anchorScrollDelta((clientY - bodyRect.top) / oldZoom, oldZoom, newZoom);
    // Two-sided guard: the anchor demands a real move, or the asserts below
    // could pass on a component that never adjusts scroll at all.
    expect(expectedLeft).toBeGreaterThan(startLeft + 10);
    expect(expectedTop).toBeGreaterThan(startTop + 10);

    act(() => {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
          clientX,
          clientY,
        }),
      );
    });

    // The controlled round trip landed (state → prop → inline `zoom`). Numeric,
    // not string equality: Chromium's CSSOM serialises the value to 6
    // significant digits ("2.49215"), unlike jsdom's raw string.
    expect(Number(body().style.zoom)).toBeCloseTo(newZoom, 4);
    // …and the deferred anchor scroll matches the math against the REAL rects.
    // Integer tolerance: Chromium may round scroll positions to device pixels.
    expect(el.scrollLeft).toBeCloseTo(expectedLeft, 0);
    expect(el.scrollTop).toBeCloseTo(expectedTop, 0);
  });

  it("Fit ZOOMS OUT a diagram taller than the pane until it fits whole", () => {
    // The 50% case, measured. At 200%
    // the 400x600 schema is 1200 device px tall in a 400px pane — three screens
    // of diagram, and the only way to see the shape of it is to zoom out.
    render(<FitHarness text={TALL_DOC} initial={2} />);

    const before = paneBox();
    // Real-layout sanity, and the vacuity guard in one: under jsdom the rect is
    // 0x0 and "taller than the pane" would be trivially false, so the click
    // below would be asserting nothing at all.
    expect(before.height).toBeGreaterThan(300);
    expect(rectOf(TALL_ID).height).toBeGreaterThan(before.height * 2);
    expect(zoomNow()).toBeCloseTo(2, 4);

    fireEvent.click(screen.getByTestId("diagram-fit"));

    // Two-sided: the zoom must actually have MOVED, and downward. A component
    // that ignores the click, or one that only ever zooms in, reds here.
    expect(zoomNow()).toBeLessThan(2);
    // The fixture fits at ~67%: a zoom on the 25% floor would mean the clamp, not the fit, decided.
    expect(zoomNow()).toBeGreaterThan(PREVIEW_ZOOM_MIN);

    // THE claim: the whole diagram is on screen. Measured against the pane as it
    // is NOW, not as it was at click time — see `paneBox`.
    const pane = paneBox();
    const fitted = rectOf(TALL_ID);
    expect(fitted.height).toBeLessThanOrEqual(pane.height + 1);
    expect(fitted.width).toBeLessThanOrEqual(pane.width + 1);
    // Any small zoom "fits"; the constraining axis must also fill the pane.
    expect(fitted.height).toBeGreaterThan(pane.height * 0.9);
  });

  it("Fit ZOOMS IN a diagram smaller than the pane until it fills the constraining axis", () => {
    // The 200% case — the same rule, read the other way. A `Math.min(1, ratio)`
    // "fit" (the obvious one, and the one that only ever shrinks) passes every
    // assertion in the test above and reds every assertion in this one.
    render(<FitHarness text={SMALL_DOC} initial={1} />);

    const before = paneBox();
    const small = rectOf(SMALL_ID);
    // Vacuity guard: it starts with room to spare on BOTH axes, so growing is
    // the only correct answer and the width is the tighter of the two.
    expect(small.width).toBeLessThan(before.width / 2);
    expect(small.height).toBeLessThan(before.height / 2);
    expect(before.width / small.width).toBeLessThan(before.height / small.height);

    fireEvent.click(screen.getByTestId("diagram-fit"));

    // Two-sided: changed, and UP.
    expect(zoomNow()).toBeGreaterThan(1);

    const pane = paneBox();
    const fitted = rectOf(SMALL_ID);
    // The constraining axis is now the pane, to the pixel — not just "bigger".
    // A pixel of tolerance because the fit ratio is a float and Chromium lays
    // out on device pixels.
    expect(Math.abs(fitted.width - pane.width)).toBeLessThanOrEqual(1);
    // …and the free axis grew with it without spilling out of the pane.
    expect(fitted.height).toBeGreaterThan(small.height * 2);
    expect(fitted.height).toBeLessThanOrEqual(pane.height + 1);
  });

  it("keeps the Fit control the SAME SIZE ON SCREEN at 100% and at 400%", () => {
    // `.markdown-preview__fit` cancels the body zoom (`zoom: calc(1 / var(--mdp-zoom, 1))`; nested
    // zoom multiplies). jsdom applies no CSS, so only this tier can see it.
    const { rerender } = render(controlled(1, SMALL_DOC));
    const button = () => screen.getByTestId("diagram-fit").getBoundingClientRect();

    const at1 = button();
    // Sanity: a real, laid-out control (0x0 would make the comparison vacuous).
    expect(at1.width).toBeGreaterThan(20);
    expect(at1.height).toBeGreaterThan(10);
    const diagramAt1 = rectOf(SMALL_ID).width;

    rerender(controlled(4, SMALL_DOC));

    // The zoom really is at 4x — otherwise "unchanged" would be the trivially
    // true statement that nothing happened. Numeric read-back.
    expect(zoomNow()).toBeCloseTo(4, 4);
    // …and 4x is doing visible work to the button's own neighbour, which is the
    // control group for the assertion below.
    expect(rectOf(SMALL_ID).width).toBeCloseTo(diagramAt1 * 4, -1);

    const at4 = button();
    expect(Math.abs(at4.width - at1.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(at4.height - at1.height)).toBeLessThanOrEqual(1);
  });

  it("scrolls the fitted diagram into view when it was below the fold", () => {
    // The scroll is deferred to the layout effect: before the new zoom is laid out it would clamp
    // against the old bounds.
    render(<FitHarness text={TALL_DOC} initial={2} />);
    const el = container();
    const block = () => document.getElementById(TALL_ID)!.parentElement!.getBoundingClientRect();

    el.scrollTop = 0;
    el.scrollLeft = 0;
    expect(el.scrollTop).toBe(0);
    // Vacuity guard: at 200% the prose above it is several screens tall, so the
    // diagram starts well below the bottom edge of the scrollport.
    expect(block().top).toBeGreaterThan(scrollportBox().bottom);

    fireEvent.click(screen.getByTestId("diagram-fit"));

    // It scrolled — two-sided, because "inside the box" is also what you get
    // from a component that never scrolled and a diagram that happened to be
    // visible already, which the guard above has just ruled out.
    expect(el.scrollTop).toBeGreaterThan(0);

    const port = scrollportBox();
    const fitted = block();
    expect(fitted.top).toBeGreaterThanOrEqual(port.top - 1);
    expect(fitted.bottom).toBeLessThanOrEqual(port.bottom + 1);
    expect(fitted.left).toBeGreaterThanOrEqual(port.left - 1);
    expect(fitted.right).toBeLessThanOrEqual(port.right + 1);
  });
});
