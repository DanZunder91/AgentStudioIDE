/**
 * Markdown-preview zoom — layer 5, the real-browser tier (testing-strategy §1).
 *
 * Every claim here is a geometry claim, so this tier is the only place any of
 * them can live: under jsdom
 * `getBoundingClientRect()` is 0×0 and a scroll box is inert, so "scale turns
 * into scrollable overflow", "the pan clamps to real bounds" and "the cursor
 * anchor lands where the math says" would all be vacuously green there. The
 * jsdom suites pin the arithmetic and the wiring; this file is where the
 * pixels are.
 *
 *   1. **Prose RE-WRAPS, it does not run off the edge** — the discriminator
 *      between the CSS `zoom` the component uses and the `transform: scale` it
 *      used to use. `transform` leaves layout alone, so magnified
 *      prose overflows to the right and must be panned to be read; `zoom`
 *      shrinks the body's CSS width to `pane / zoom`, so lines re-flow to the
 *      pane and only the height grows. Asserted two-sided — height must grow
 *      roughly with the zoom, width must NOT overflow — which is a claim that
 *      goes red under `transform` and is therefore worth making.
 *   2. **A wide diagram fits the pane at 100% and is exactly 2x that at 200%**
 *      — the contract in one claim, and two-sided on purpose:
 *      natural-size-everywhere passes the second half, `max-width: 100%`
 *      passes the first, and only `calc(100% * var(--mdp-zoom))` passes both.
 *   3. **Real pan** — ctrl+drag scrolls by real pixels, a huge drag pins to
 *      the box's actual scroll bound (Chromium clamps the assignment — proof
 *      the overflow exists), and after pointerup further moves change nothing.
 *   4. **Anchored wheel zoom** — through a stateful controlled harness (the
 *      CodeEditor usage shape), a native ctrl+wheel at a known cursor point
 *      moves scrollLeft/scrollTop by exactly `anchorScrollDelta` of the
 *      pre-wheel body rect. Real rects, real scroll clamping, sub-pixel
 *      tolerance only.
 *   5. **Fit ZOOMS OUT a diagram taller than the pane** — the 50%
 *      case. A 400x600 schema at 200% is 1200px tall in a 400px
 *      pane; after one click it must be no taller than the pane and still fill
 *      it. Two-sided on both counts: the zoom has to have CHANGED and gone
 *      DOWN, and the diagram has to end up filling the constraining axis rather
 *      than merely being small. `fitPreviewZoom`'s whole claim is that the
 *      on-screen size is exactly linear in the zoom — a claim about used
 *      widths under `max-width: calc(100% * var(--mdp-zoom))`, which only a
 *      layout engine can settle.
 *   6. **Fit ZOOMS IN a diagram smaller than the pane** — the 200%
 *      case, the same rule read in the other direction. A 200x100 schema at
 *      100% grows until the CONSTRAINING axis (here the width) is the pane, and
 *      the zoom went UP. A one-directional implementation — `Math.min(1, ratio)`,
 *      the obvious "fit" — passes claim 5 and reds this one.
 *   7. **The Fit control is the SAME SIZE ON SCREEN at every zoom.** Nested
 *      `zoom` MULTIPLIES, so `.markdown-preview__fit` carries
 *      `zoom: calc(1 / var(--mdp-zoom, 1))` to cancel the body's exactly. This
 *      earns its own claim because the failure is not subtle and has no other
 *      detector: without that one line the button is 4x its design size at
 *      400%, a control the size of a table cell sitting on top of the diagram
 *      the user zoomed in to read. Measured at zoom 1 and zoom 4, matched to a
 *      pixel — and jsdom, which applies no CSS at all, cannot see it.
 *   8. **The fitted diagram is SCROLLED INTO VIEW.** Fitting a diagram that is
 *      40 paragraphs below the fold is only half a feature if the user is left
 *      looking at the top of the document. The component defers the
 *      `scrollIntoView` to the layout effect for the same reason the wheel
 *      anchor is deferred — scrolling before the new zoom is laid out clamps
 *      against the OLD bounds — and "the old bounds" is precisely the sort of
 *      thing a stubbed scroll box cannot have.
 *
 * What this tier CANNOT prove is the thing the change is for: that the pixels
 * are sharp. Blur has no DOM observable. What it can pin is the mechanism that
 * produces sharpness — that zooming changes LAYOUT (claim 1) rather than
 * scaling a finished raster — and that is exactly what claim 1 asserts.
 *
 * The fixture is plain markdown ON PURPOSE: mermaid renders async and
 * nondeterministically (its pipeline has its own suites), and images would
 * reach for the un-stubbed image-read IPC. Short lines keep the body narrower
 * than the 600px box at zoom 1. The wide element is a raw-HTML `<div>` with an
 * explicit width — DOMPurify keeps `style`, and it is a faithful stand-in for a
 * diagram pinned to its natural size (pinDiagramToNaturalSize), without dragging
 * mermaid's async pipeline into a geometry test.
 *
 * The Fit fixtures (claims 5-8) extend that precedent one step: they hand-write
 * the whole post-hydration block, `--rendered` class and Fit `<button>` and all,
 * i.e. byte-for-byte what `sizeDiagramForZoom` + `addFitControl` leave behind.
 * DOMPurify keeps every part of it — `<button>` and `type` are in the default
 * tag/attribute allow-lists and `data-*` is allowed by default — which was
 * checked against the real sanitiser before these fixtures were written, since
 * a silently-stripped button would make `getByTestId` the failing line and hide
 * the geometry entirely. The `--rendered` class is also what keeps the mermaid
 * effect off the block: it is that effect's "already hydrated" guard.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts \
 *        src/features/editor/markdownPreviewZoom.browser.test.tsx`
 */

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

/** A rendered diagram, post-hydration, written by hand: the exact markup
 *  `sizeDiagramForZoom` produces (natural `width`, NO inline `max-width`, the
 *  `--rendered` class) for a 2400px-wide schema — far past the 600px pane. Raw
 *  HTML, because markdown-it runs with html:true and DOMPurify keeps `class`,
 *  `style` and `<svg>`; mermaid's async pipeline has no business in a geometry
 *  test, and this is byte-for-byte what it hands us. */
const WIDE_ID = "wide-diagram";
const NATURAL_W = 2400;
const WIDE_DOC =
  `${DOC}\n\n<pre class="markdown-preview__mermaid markdown-preview__mermaid--rendered">` +
  `<svg id="${WIDE_ID}" style="width: ${NATURAL_W}px; height: auto;" ` +
  `viewBox="0 0 ${NATURAL_W} 900"></svg></pre>\n`;

/**
 * A wide README IMAGE — the same geometry claim as the diagram above, on the
 * other element that carries a fit-the-pane ceiling. The `src` is a `data:` URL
 * on purpose: `MarkdownPreview`'s inlining pass skips any src already carrying a
 * scheme, so this fixture never reaches the un-stubbed image-read IPC (the same
 * constraint this file's header records for the diagram fixture). The explicit
 * `width`/`height` attributes give it layout before any decode completes, so the
 * measurement is deterministic rather than load-order dependent.
 */
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

/** The real usage shape: a parent owns the zoom and round-trips onZoomChange
 *  (CodeEditor does exactly this via the store). Claim 3 needs the round trip,
 *  because the anchor scroll is applied only AFTER the new zoom has been laid
 *  out. It uses the WIDE fixture so horizontal scroll is real and unclamped. */
function ZoomHarness(): React.JSX.Element {
  const [zoom, setZoom] = useState(2);
  return (
    <div style={{ width: 600, height: 400 }}>
      <MarkdownPreview text={WIDE_DOC} zoom={zoom} onZoomChange={setZoom} />
    </div>
  );
}

/** A rendered diagram block WITH its Fit control — what the component leaves in
 *  the DOM after `sizeDiagramForZoom` + `addFitControl`, written by hand for the
 *  reason above. The natural `width` inline, no inline `max-width` (the
 *  stylesheet's `calc(100% * var(--mdp-zoom))` owns the ceiling) and `height:
 *  auto` + a viewBox, so the height follows the aspect ratio exactly as a real
 *  diagram's does — which is what makes a HEIGHT-constrained fit testable. */
const diagramBlock = (id: string, width: number, height: number): string =>
  `<pre class="markdown-preview__mermaid markdown-preview__mermaid--rendered">` +
  `<svg id="${id}" style="width: ${width}px; height: auto;" viewBox="0 0 ${width} ${height}"></svg>` +
  `<button class="markdown-preview__fit" data-mdp-fit data-testid="diagram-fit" type="button">Fit</button>` +
  `</pre>`;

/** Claim 5/8: 400x600 — at zoom 2 that is 1200 device px tall in a 400px-tall
 *  pane, so HEIGHT is the constraining axis and the fit lands at ~67%,
 *  comfortably above the 25% clamp floor. Dimensioned that way on purpose: a fit
 *  that bottomed out on the floor would be testing `clampPreviewZoom`, not the
 *  fit. It sits after the 40 paragraphs of DOC, which is also what puts it far
 *  below the fold for claim 8. */
const TALL_ID = "tall-diagram";
const TALL_DOC = `${DOC}\n\n${diagramBlock(TALL_ID, 400, 600)}\n`;

/** Claim 6/7: 200x100 — smaller than the pane on BOTH axes at zoom 1, with the
 *  width the tighter of the two, so a correct fit grows it until the width is
 *  the pane and the height still has room to spare. */
const SMALL_ID = "small-diagram";
const SMALL_DOC = `${DOC}\n\n${diagramBlock(SMALL_ID, 200, 100)}\n`;

/** The Fit usage shape, and the same stateful round trip ZoomHarness makes for
 *  the wheel — Fit needs it twice over: the control is only rendered/handled
 *  when the zoom is CONTROLLED, and the deferred `scrollIntoView` can only land
 *  on the right pixels once the new zoom has been laid out. */
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

/**
 * The pane's CONTENT box in device px, measured exactly the way `onFitClick`
 * measures it: `clientWidth`/`clientHeight` already exclude a scrollbar, and the
 * 20/26/40 padding has to come off by hand or the diagram is fitted to a box
 * 52px wider than the space it can actually occupy.
 *
 * Re-measured at every assertion rather than captured once, because the pane is
 * not a constant across a fit: zooming out retires the horizontal scrollbar the
 * un-fitted diagram was causing, and on a platform with classic (space-taking)
 * scrollbars that hands the pane back ~15px of height *after* the fit was
 * computed. Headless Chromium here uses overlay scrollbars and the box does not
 * move — re-measuring is what keeps the assertions true on both.
 */
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

    // THE claim, and the one that separates `zoom` from `transform: scale`.
    // Under `transform` the body keeps its 1× layout width and the magnified
    // lines run off the right edge, so this would be a horizontal overflow.
    // Under `zoom` the body's CSS width is pane/2, the lines re-flow, and only
    // the height grows — you read by scrolling DOWN, not by panning sideways.
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    // Two-sided: the zoom must actually have done something. Re-wrapped prose
    // is taller than 2× (narrower column ⇒ more lines), never shorter.
    expect(el.scrollHeight).toBeGreaterThan(heightAt1 * 1.8);
    expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
  });

  it("a wide diagram FITS the pane at 100% and is exactly 2x that at 200%", () => {
    // The contract, in one test: the diagram keeps its
    // normal size, and zooming it does not distort it. Both halves are claims,
    // and each one alone is satisfiable by a broken implementation — natural
    // size everywhere passes the second, `max-width: 100%` passes the first.
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

    // Half 2 — "i zoom": exactly twice as big on screen, and now overflowing,
    // which is what ctrl/cmd+drag is for. `getBoundingClientRect` reports
    // zoomed pixels. A plain `max-width: 100%` reds this line: the cap would
    // shrink with the pane's zoomed CSS width and pin the diagram at widthAt1.
    expect(diagram().width).toBeCloseTo(widthAt1 * 2, -1);
    expect(el.scrollWidth).toBeGreaterThan(el.clientWidth);
  });

  /**
   * 🔴 A REGRESSION test for a bug that was shipped, not a guard for a new one.
   * `.markdown-preview__body img` used to carry a plain `max-width: 100%` —
   * the same trap the image viewer has to avoid. Under `zoom: Z` the body measures `W / Z` CSS
   * px, so `100%` resolves back to exactly `W` device px at every Z: a wide README image stayed
   * the SAME on-screen size at 100% and at 400% while every paragraph around it grew.
   * Two-sided for the same reason as the diagram claim above — natural-size
   * everywhere passes half 2, `max-width: 100%` passes half 1.
   */
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
    // …and it must have landed on the fit, not on the rail. The fixture is
    // dimensioned to fit at ~67%, so a zoom sitting exactly on 25% would mean
    // the clamp floor produced this number and everything below is
    // `clampPreviewZoom`'s doing rather than `fitPreviewZoom`'s.
    expect(zoomNow()).toBeGreaterThan(PREVIEW_ZOOM_MIN);

    // THE claim: the whole diagram is on screen. Measured against the pane as it
    // is NOW, not as it was at click time — see `paneBox`.
    const pane = paneBox();
    const fitted = rectOf(TALL_ID);
    expect(fitted.height).toBeLessThanOrEqual(pane.height + 1);
    expect(fitted.width).toBeLessThanOrEqual(pane.width + 1);
    // Two-sided again, and this is the half that hurts: "fits" is satisfied by
    // any zoom small enough, including a useless one — `ratio * 0.5` passes
    // every line above it. The constraining axis has to FILL the pane, and
    // because `fitPreviewZoom` scales by the exact ratio it lands ON the pane
    // it was measured against, never at half of it.
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
    // `.markdown-preview__fit` carries `zoom: calc(1 / var(--mdp-zoom, 1))`, and
    // nested `zoom` MULTIPLIES, so that cancels the body's zoom exactly. Delete
    // that one line and the button is 4x its design size at 400% — a control the
    // size of a table cell, planted on top of the diagram the user zoomed in to
    // read. No CSS runs under jsdom, so this claim can only live here.
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
    // Fitting a diagram 40 paragraphs down is half a feature if the user is left
    // staring at the top of the document. The component defers the
    // `scrollIntoView` into the layout effect for the same reason the wheel
    // anchor is deferred: scroll before the new zoom is laid out and the browser
    // clamps against the OLD bounds, landing the diagram you just fitted
    // off-screen. Old bounds are a thing only a real scroll box has.
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
