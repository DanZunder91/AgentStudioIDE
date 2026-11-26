/** Geometry claims only a real layout engine can check; arithmetic and wiring are in
 * `ImageViewer.test.tsx`. Fixtures are SVG data URLs from `svgText`, so no image IPC is mocked. */

import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ImageViewer } from "./ImageViewer";

/** An SVG whose attributes — and therefore whose intrinsic size — are the test
 *  parameter. The `<rect>` gives it something to paint, so a zero-size render
 *  would be visible in the screenshot a failure captures. */
const svg = (attrs: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>` +
  `<rect width="100%" height="100%" fill="#4488ff"/></svg>`;

/** 2400×900 — four times wider than the pane, so the ceiling really does work. */
const WIDE = svg('width="2400" height="900" viewBox="0 0 2400 900"');
/** 96×72 — smaller than the pane on both axes: the "do not blow up my icon" case. */
const SMALL = svg('width="96" height="72" viewBox="0 0 96 72"');
/** A `viewBox` and NOTHING else: no intrinsic size (claim 3). */
const NO_INTRINSIC_SIZE = svg('viewBox="0 0 400 300"');
/** 400×1200 — three times the pane's height, so HEIGHT constrains the fit and
 *  the answer (~0.31) is comfortably above the 25% clamp floor: a fit that
 *  bottomed out on the rail would be testing `clampPreviewZoom`, not the fit. */
const TALL = svg('width="400" height="1200" viewBox="0 0 400 1200"');
/** 200×150 — smaller than the pane on both axes, with HEIGHT the tighter of the
 *  two (368/150 ≈ 2.45 vs 568/200 = 2.84), so a correct fit-in lands under the
 *  4× clamp ceiling and can be checked against the height. */
const MEDIUM = svg('width="200" height="150" viewBox="0 0 200 150"');

const noop = (): void => undefined;

/** The viewer in a definite 600×400 box (`.image-viewer` is height:100%). */
const view = (text: string, zoom: number): React.JSX.Element => (
  <div style={{ width: 600, height: 400 }}>
    <ImageViewer path="/w/pic.svg" svgText={text} zoom={zoom} onZoomChange={noop} />
  </div>
);

/** The real usage shape: a parent owns the zoom and round-trips `onZoomChange`
 *  (CodeEditor does exactly this via the store). Fit needs the round trip — the
 *  new zoom has to be laid out before anything about it can be measured. */
function Harness({ text, initial }: { text: string; initial: number }): React.JSX.Element {
  const [zoom, setZoom] = useState(initial);
  return (
    <div style={{ width: 600, height: 400 }}>
      <ImageViewer path="/w/pic.svg" svgText={text} zoom={zoom} onZoomChange={setZoom} />
    </div>
  );
}

const container = (): HTMLElement => screen.getByTestId("image-viewer");
const image = (): HTMLImageElement => screen.getByTestId("image-img") as HTMLImageElement;
const fitButton = (): HTMLElement => screen.getByTestId("image-fit");
/** The live zoom, read off the stage. Numeric, never string (Chromium rounds to 6 digits). */
const zoomNow = (): number => Number(screen.getByTestId("image-stage").style.zoom);

/** `complete` means the bytes are in; the inline `width` means `onLoad`'s state was committed. */
async function ready(): Promise<HTMLImageElement> {
  const img = image();
  await waitFor(() => {
    expect(img.complete).toBe(true);
    expect(img.style.width).not.toBe("");
  });
  return img;
}

/** Measured like `onFit`: `clientWidth` excludes the scrollbar, the padding comes off by hand.
 * Re-measure every time, since a fit can retire a scrollbar. */
function paneBox(): { width: number; height: number } {
  const el = container();
  const style = getComputedStyle(el);
  return {
    width: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    height: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
  };
}

/** The first length in a computed `background-size`, in CSS px. */
const tilePx = (el: HTMLElement): number => parseFloat(getComputedStyle(el).backgroundSize);

afterEach(() => {
  // Defensive: end any drag a failed assertion left open, so the window-level
  // listeners and the body class never leak into the next test (house pattern).
  fireEvent(window, new PointerEvent("pointerup", { bubbles: true }));
  document.body.classList.remove("is-panning");
});

describe("ImageViewer — real geometry (Chromium)", () => {
  it("a wide image FITS the pane at 100% and is exactly 2x that at 200%", async () => {
    const { rerender } = render(view(WIDE, 1));
    const el = container();

    // Real-layout sanity: under jsdom these are 0 and every claim below would be
    // vacuously true — this line is what makes the tier honest.
    expect(el.clientWidth).toBeGreaterThan(500);
    expect(el.clientHeight).toBeGreaterThan(300);

    const img = await ready();
    // Half 1 — "normal size": the 2400px image is capped to the pane, and it is
    // genuinely capped (its natural width is 4x what it is allowed here).
    const widthAt1 = img.getBoundingClientRect().width;
    expect(widthAt1).toBeCloseTo(paneBox().width, 0);
    expect(img.naturalWidth).toBeGreaterThan(widthAt1 * 3);
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth); // no overflow at 100%

    rerender(view(WIDE, 2));

    // A plain `max-width: 100%` fails here: the cap would shrink with the zoom and pin the picture.
    expect(img.getBoundingClientRect().width).toBeCloseTo(widthAt1 * 2, -1);
    expect(el.scrollWidth).toBeGreaterThan(el.clientWidth);
  });

  it("a small icon keeps its natural size at 100% — and still zooms", async () => {
    const { rerender } = render(view(SMALL, 1));
    const img = await ready();

    // NOT blown up to fill the pane: 96 natural px stay 96 device px…
    expect(img.getBoundingClientRect().width).toBeCloseTo(96, 0);
    expect(paneBox().width).toBeGreaterThan(400); // …on a pane 5x wider than that

    rerender(view(SMALL, 4));
    // …and the zoom still moves it: 4x, sharp, laid out — not a stretched raster.
    expect(img.getBoundingClientRect().width).toBeCloseTo(384, 0);
  });

  it("an SVG with only a viewBox is pinned to its decoded size, not stretched inert", async () => {
    // An <img> with no intrinsic size is stretched to its containing block, which `zoom` can't
    // move; without the pin this measured 568px at both zooms.
    const { rerender } = render(view(NO_INTRINSIC_SIZE, 1));
    const img = await ready();

    const widthAt1 = img.getBoundingClientRect().width;
    expect(widthAt1).toBeGreaterThan(0);
    expect(widthAt1).toBeLessThan(paneBox().width); // it did NOT stretch to the pane

    rerender(view(NO_INTRINSIC_SIZE, 2));
    expect(img.getBoundingClientRect().width).toBeCloseTo(widthAt1 * 2, 0);
  });

  it("Fit zooms a too-tall image OUT until it fits the pane", async () => {
    render(<Harness text={TALL} initial={1} />);
    const img = await ready();

    // 400x1200 in a 568x368 content box: three times too tall to be seen whole.
    expect(img.getBoundingClientRect().height).toBeGreaterThan(paneBox().height * 2.5);

    fireEvent.click(fitButton());
    await waitFor(() => expect(zoomNow()).toBeLessThan(1));

    const pane = paneBox();
    const rect = img.getBoundingClientRect();
    // Two-sided: it has to FIT…
    expect(rect.height).toBeLessThanOrEqual(pane.height + 1);
    expect(rect.width).toBeLessThanOrEqual(pane.width + 1);
    // …and it has to FILL the constraining axis, or "fit" would be satisfied by
    // any zoom small enough — 25% included.
    expect(rect.height).toBeCloseTo(pane.height, 0);
  });

  it("Fit zooms a small image IN until it fills the pane", async () => {
    // The same rule read in the other direction. `Math.min(1, ratio)` — the
    // obvious "shrink to fit" — passes the previous test and reds this one.
    render(<Harness text={MEDIUM} initial={1} />);
    const img = await ready();
    expect(img.getBoundingClientRect().height).toBeCloseTo(150, 0);

    fireEvent.click(fitButton());
    await waitFor(() => expect(zoomNow()).toBeGreaterThan(1));

    const pane = paneBox();
    const rect = img.getBoundingClientRect();
    expect(rect.height).toBeCloseTo(pane.height, 0); // height is the tighter axis
    expect(rect.width).toBeLessThanOrEqual(pane.width + 1);
  });

  it("the Fit control is the same size on screen at every zoom", async () => {
    const { rerender } = render(view(SMALL, 1));
    await ready();
    const at1 = fitButton().getBoundingClientRect();
    expect(at1.width).toBeGreaterThan(0); // the stylesheet really applied

    rerender(view(SMALL, 4));
    const at4 = fitButton().getBoundingClientRect();
    // Nested `zoom` MULTIPLIES: without `zoom: calc(1 / var(--img-zoom))` this
    // button is 4x its design size at 400%.
    expect(at4.width).toBeCloseTo(at1.width, 0);
    expect(at4.height).toBeCloseTo(at1.height, 0);
  });

  it("the transparency checkerboard holds its tile size on screen at every zoom", async () => {
    const { rerender } = render(view(SMALL, 1));
    const img = await ready();
    // Computed styles are in the element's own CSS px, so on screen is `tile * zoom`, compared
    // numerically.
    const onScreenAt1 = tilePx(img) * 1;
    expect(onScreenAt1).toBeGreaterThan(0);

    rerender(view(SMALL, 4));
    expect(tilePx(img) * 4).toBeCloseTo(onScreenAt1, 1);
  });

  it("the zoomed picture really overflows, and ctrl+drag pans it by real pixels", async () => {
    render(view(WIDE, 2));
    await ready();
    const el = container();
    expect(el.scrollLeft).toBe(0);

    const rect = el.getBoundingClientRect();
    const x = rect.left + 300;
    const y = rect.top + 200;
    fireEvent.pointerDown(el, { ctrlKey: true, button: 0, clientX: x, clientY: y });
    expect(document.body.classList.contains("is-panning")).toBe(true);

    // Cursor moves 40 left → grab semantics → the content scrolls 40 right.
    fireEvent(window, new PointerEvent("pointermove", { bubbles: true, clientX: x - 40, clientY: y }));
    expect(el.scrollLeft).toBeCloseTo(40, 0);

    // A drag far past the content pins at the box's ACTUAL scroll bound —
    // Chromium clamps the assignment, which is only possible if the zoomed
    // overflow is real (10 000 would "stick" on an unclamped stub).
    fireEvent(window, new PointerEvent("pointermove", { bubbles: true, clientX: x - 10_000, clientY: y }));
    expect(Math.abs(el.scrollLeft - (el.scrollWidth - el.clientWidth))).toBeLessThanOrEqual(1);

    fireEvent(window, new PointerEvent("pointerup", { bubbles: true }));
    expect(document.body.classList.contains("is-panning")).toBe(false);
  });
});
