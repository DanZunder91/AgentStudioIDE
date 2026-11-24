/**
 * Markdown-preview zoom — the SEAM test. Two halves meet here: the store slice +
 * header controls (CodeEditor) and the controlled preview (MarkdownPreview). Each half is covered
 * in its own file — and each mocks the other out: `CodeEditor.test.tsx` replaces MarkdownPreview
 * with a props-recording stub, `MarkdownPreview.test.tsx` never mounts
 * CodeEditor. Neither can see a broken join (`zoom` not passed, `onZoomChange`
 * wired to the wrong action). This file owns that join: the REAL CodeEditor
 * mounting the REAL MarkdownPreview over the real store, with only the outer
 * boundaries mocked (EditorRegistry/CM6, blame IPC, mermaid, the image-read
 * IPC). Not a unit test and not pretending to be.
 *
 * Falsified: pinning `zoom={1}` on the <MarkdownPreview/> element
 * in CodeEditor.tsx reds all three tests. The header label still reads "125%"
 * while the real body stays `scale(1)` — exactly the broken-join failure class:
 *   AssertionError: expected 'scale(1)' to be 'scale(1.25)'
 * and the wheel test reds in the STORE, because the pinned prop corrupts the
 * gesture's input too (the handler stepped from 1, not the store's 1.25):
 *   AssertionError: expected 1.2460767305873808 to be 1.557595913234226
 * The inverse edit restores green.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CM6 needs a real DOM and is not what this seam is about — same boundary mock
// as CodeEditor.test.tsx (dispose included: store's closeTab paths import it).
const registry = vi.hoisted(() => ({
  ensureEditor: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  dispose: vi.fn(),
  save: vi.fn().mockResolvedValue(true),
  currentText: vi.fn((): string | null => "# Hello\n\nzoom me"),
  getView: vi.fn((): object | null => null),
}));
vi.mock("./EditorRegistry", () => registry);
const blameIpc = vi.hoisted(() => ({ gitBlame: vi.fn() }));
vi.mock("./blame/blameIpc", () => blameIpc);
const blameGutter = vi.hoisted(() => ({ showBlame: vi.fn(), hideBlame: vi.fn() }));
vi.mock("./blame/blameGutter", () => blameGutter);

// MarkdownPreview's own outer boundaries (per MarkdownPreview.test.tsx): the
// real mermaid needs a live SVG layout engine, and the image inliner is IPC.
const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaidMock }));
const workspaceIpc = vi.hoisted(() => ({ readImageDataUrl: vi.fn() }));
vi.mock("../workspace/workspaceIpc", () => workspaceIpc);

import { useAppStore } from "../../app/store";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { CodeEditor } from "./CodeEditor";
import { wheelPreviewZoom } from "./previewZoom";

const MD = "/w/README.md";

const layout = () => useAppStore.getState().layoutActions;
const editors = () => useAppStore.getState().editorActions;
const storeZoom = () => useAppStore.getState().editors[MD]?.previewZoom;

/** Open the markdown tab and drive it to ready — the rendered preview mounts. */
const openReady = () =>
  act(() => {
    layout().openEditorTab(MD);
    editors().initEditor(MD);
    editors().editorReady(MD, true);
  });

/** The REAL preview body — the element whose inline `zoom` is the claim. */
const body = () =>
  screen.getByTestId("markdown-preview").querySelector<HTMLElement>(".markdown-preview__body")!;

/**
 * Dispatch a NATIVE cancelable wheel (fireEvent.wheel is not cancelable, and
 * the component's listener is a native non-passive one — React's onWheel never
 * sees it). Wrapped in act: the handler writes to the store synchronously.
 */
function wheel(el: HTMLElement, init: WheelEventInit): WheelEvent {
  const evt = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  act(() => void el.dispatchEvent(evt));
  return evt;
}

beforeEach(() => {
  resetStore();
  resetFleetStore();
  registry.currentText.mockClear().mockReturnValue("# Hello\n\nzoom me");
  workspaceIpc.readImageDataUrl.mockReset().mockResolvedValue("data:image/png;base64,AAAA");
});
afterEach(() => cleanup());

describe("preview zoom through the real CodeEditor + real MarkdownPreview (seam)", () => {
  it("clicking + scales the REAL preview body, not just the header label", () => {
    openReady();
    render(<CodeEditor path={MD} />);

    // Before: the default zoom renders as an inert zoom:1.
    expect(body().style.zoom).toBe("1");
    expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("100%");

    fireEvent.click(screen.getByTestId("preview-zoom-in"));

    // After: store → prop → inline `zoom`. A label-only change fails here.
    expect(body().style.zoom).toBe("1.25");
    expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("125%");
  });

  it("a native ctrl+wheel on the real container round-trips: gesture → store → prop → DOM", () => {
    openReady();
    render(<CodeEditor path={MD} />);
    fireEvent.click(screen.getByTestId("preview-zoom-in")); // start off-default, at 1.25

    const evt = wheel(screen.getByTestId("markdown-preview"), { ctrlKey: true, deltaY: -100 });

    // The gesture landed in the STORE (onZoomChange → setPreviewZoom)…
    const next = wheelPreviewZoom(1.25, -100, 0);
    expect(storeZoom()).toBe(next);
    // …and flowed back down as the rendered `zoom` — the full round trip.
    expect(body().style.zoom).toBe(String(next));
    // The non-passive listener ate the webview's own pinch-zoom.
    expect(evt.defaultPrevented).toBe(true);
  });

  it("the % button resets the store AND the rendered zoom to 100%", () => {
    openReady();
    render(<CodeEditor path={MD} />);
    fireEvent.click(screen.getByTestId("preview-zoom-in"));
    expect(body().style.zoom).toBe("1.25"); // genuinely off-default first

    fireEvent.click(screen.getByTestId("preview-zoom-reset"));

    expect(storeZoom()).toBe(1);
    expect(body().style.zoom).toBe("1");
    expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("100%");
  });
});

/**
 * The un-hydration bug, at the seam that owns it: clicking the
 * diagram broke it and showed its source, and the source was still showing
 * after the zoom was reset. A zoom step is a real store write → a real CodeEditor
 * re-render → a real MarkdownPreview re-render, and React 19 re-assigns
 * `innerHTML` on a NEW `dangerouslySetInnerHTML` object regardless of whether
 * the HTML changed — which erased the mermaid SVG the post-mount effect had put
 * there, permanently (the effect is keyed on the unchanged HTML).
 *
 * Neither half's own suite can see this: `CodeEditor.test.tsx` stubs the preview
 * out, and `MarkdownPreview.test.tsx` drives re-renders by hand rather than
 * through the store. This is the join.
 *
 * NOTE: every assertion RE-QUERIES the block from the DOM. A re-assigned
 * `innerHTML` detaches the old `<pre>`, and the detached node keeps its SVG —
 * a reference captured before the click would pass while the screen is broken.
 */
describe("hydrated diagrams survive a zoom through the real stack (seam)", () => {
  const DIAGRAM_DOC = "# Schema\n\n```mermaid\nerDiagram\n  A ||--o{ B : id\n```\n";
  const renderedBlock = () =>
    screen
      .getByTestId("markdown-preview")
      .querySelector<HTMLElement>(".markdown-preview__mermaid");

  beforeEach(() => {
    registry.currentText.mockReturnValue(DIAGRAM_DOC);
    mermaidMock.render
      .mockReset()
      .mockResolvedValue({ svg: '<svg data-testid="seam-mermaid-svg"></svg>' });
  });

  it("keeps the SVG across a zoom step and the reset back to 100%", async () => {
    openReady();
    render(<CodeEditor path={MD} />);

    await waitFor(() =>
      expect(renderedBlock()).toHaveClass("markdown-preview__mermaid--rendered"),
    );

    fireEvent.click(screen.getByTestId("preview-zoom-in")); // zoom out and…
    fireEvent.click(screen.getByTestId("preview-zoom-reset")); // …back to 100%

    expect(body().style.zoom).toBe("1"); // the zoom really round-tripped
    const block = renderedBlock()!;
    expect(block.querySelector("svg")).not.toBeNull();
    expect(block).toHaveClass("markdown-preview__mermaid--rendered");
    expect(block.textContent).not.toContain("erDiagram"); // never back to the source
    // Nothing was re-injected, so no second hydration pass was needed.
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });
});

/**
 * The per-diagram **Fit** control, at the seam that owns it (a button over the
 * diagram that zooms it automatically, to 50% in some cases and 200% in others).
 *
 * This join is longer than the header buttons' and crosses more owners. The
 * button does not exist in any JSX: `addFitControl` builds a `<button>` and
 * `append`s it into a subtree React injected via `innerHTML` — a subtree React
 * does not own, inside a diagram that only exists after an async mermaid
 * hydration. The click is then caught by ONE delegated `onClick` on the
 * container, which measures, calls `fitPreviewZoom`, and reports through
 * `onZoomChange` → `setPreviewZoom(path, …)` → the store → back down as the
 * `zoom` prop → the body's inline `zoom` and the header's `%` label.
 *
 * Every link in that chain is invisible to the two unit suites.
 * `MarkdownPreview.test.tsx` supplies its own `onZoomChange` spy, so it can
 * prove the control REPORTS a zoom and nothing more — a reported zoom that no
 * one stores looks identical from there. `CodeEditor.test.tsx` stubs the
 * preview out entirely, so for it the Fit button does not exist at all: not the
 * control, not the delegation, not the `isControlled` gate that decides whether
 * `addFitControl` is even called. Only here does a click on that injected
 * button have to come back out as a rendered zoom.
 *
 * **The measurements are stubbed, and that is stated plainly** (the `stubScroll`
 * / ResultsGrid measurement-stub precedent). jsdom has no layout engine:
 * `clientWidth`/`clientHeight` are hard `0` and every `getBoundingClientRect()`
 * is an all-zero rect, so `fitPreviewZoom` does exactly the right thing with
 * them — it returns the current zoom unchanged rather than a garbage one — and
 * a Fit click here is inert until the two measurements are supplied by hand.
 * So `stubFitGeometry` supplies them. What that buys is the WIRING: that the
 * click reaches the handler, that the handler reads the CURRENT zoom, that the
 * result is written to the store under this file's path, and that it is
 * rendered. It buys nothing at all about geometry — whether the numbers a real
 * browser measures put a real diagram inside the pane is proved one tier up, in
 * `markdownPreviewZoom.browser.test.tsx`, which has a layout engine.
 *
 * Falsified — see the falsification note above the assertions.
 *
 * NOTE: every helper below RE-QUERIES from the document, and the
 * tests hold no element across a click. A zoom step re-renders the whole editor;
 * a node captured before it can be a detached one that still reads correct.
 */
describe("the per-diagram Fit control, end to end through the real stack (seam)", () => {
  const OTHER = "/w/CHANGELOG.md";
  const DIAGRAM_DOC = "# Schema\n\n```mermaid\nflowchart TD\n  A --> B\n```\n";

  type Size = { width: number; height: number };

  /* ── re-querying accessors, scoped by path (two editors mount below) ── */
  const editorEl = (path: string) =>
    document.querySelector<HTMLElement>(
      `[data-testid="code-editor"][data-path="${path}"]`,
    )!;
  const pane = (path: string) =>
    editorEl(path).querySelector<HTMLElement>('[data-testid="markdown-preview"]')!;
  const bodyOf = (path: string) =>
    pane(path).querySelector<HTMLElement>(".markdown-preview__body")!;
  const block = (path: string) =>
    pane(path).querySelector<HTMLElement>(".markdown-preview__mermaid");
  const fitButton = (path: string) =>
    pane(path).querySelector<HTMLElement>('[data-testid="diagram-fit"]');
  const label = (path: string) =>
    editorEl(path).querySelector<HTMLElement>('[data-testid="preview-zoom-reset"]')!;
  const zoomIn = (path: string) =>
    editorEl(path).querySelector<HTMLElement>('[data-testid="preview-zoom-in"]')!;
  const zoomOf = (path: string) => useAppStore.getState().editors[path]?.previewZoom;

  /** The mermaid block is hydrated and carries its Fit control. */
  const awaitHydrated = async (path: string) => {
    await waitFor(() => expect(block(path)).toHaveClass("markdown-preview__mermaid--rendered"));
    expect(fitButton(path)).not.toBeNull(); // the control only exists when controlled
  };

  /**
   * Supply the two measurements jsdom cannot: the pane's box (the container's
   * `clientWidth`/`clientHeight`; its computed padding is already a real `0`
   * here, so these ARE the content box) and the diagram's on-screen rect.
   * Honest stub — see this block's header. Both nodes survive the re-renders
   * these tests drive (React reuses the container element, and the memoised
   * `dangerouslySetInnerHTML` value keeps the injected `<svg>` in place), so a
   * stub applied once holds for every click in a test.
   */
  function stubFitGeometry(path: string, diagram: Size, paneBox: Size): void {
    const el = pane(path);
    Object.defineProperty(el, "clientWidth", { value: paneBox.width, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: paneBox.height, configurable: true });
    const svg = block(path)!.querySelector("svg")!;
    // A real DOMRect via `fromRect` — NOT an object literal and not a spread of
    // one: DOMRect's `width`/`height` are prototype accessors, so `{...rect}` is
    // an empty object and the handler would read `undefined` and (correctly)
    // decline to fit. That mistake makes every test in this block red at once.
    const rect = DOMRect.fromRect({ width: diagram.width, height: diagram.height });
    svg.getBoundingClientRect = () => rect;
  }

  beforeEach(() => {
    registry.currentText.mockReturnValue(DIAGRAM_DOC);
    mermaidMock.render
      .mockReset()
      .mockResolvedValue({ svg: '<svg data-testid="seam-mermaid-svg"></svg>' });
    // jsdom ships no `scrollIntoView`, and the post-Fit layout effect calls it
    // unconditionally to bring the fitted diagram into view. Define it as a spy
    // for this block only (the ComparePanel.test.tsx precedent) — and remove it
    // again below, so no other file inherits a global jsdom does not have.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  /*
   * Falsification (a seam test never seen red is a guess), each mutation reverted by its inverse
   * edit:
   *
   *  1. `onFitClick` reports LOCALLY instead of to the store — `onZoomChange(next)`
   *     replaced by `block.dataset.mdpFit = String(next)`. All five tests red,
   *     each at its store assertion first:
   *       AssertionError: expected 1 to be 0.5
   *       AssertionError: expected 1 to be 2
   *       AssertionError: expected 1.25 to be 0.625
   *     which is the exact shape of the bug this block exists for: the click
   *     lands, the math is right, and the zoom goes nowhere.
   *
   *  2. `<MarkdownPreview zoom={1} …/>` pinned in CodeEditor.tsx (the same
   *     mutation as the file header's, re-run against these tests) — the store
   *     write survives, the render does not. The store-only test above PASSES
   *     and the round-trip ones red on the BODY, never on the label:
   *       AssertionError: expected '1' to be '0.5'
   *     i.e. the header reads "50%" the whole time. A label-only feature.
   *
   *  3. The stale-closure mutant: `fitPreviewZoom(1, …)` instead of
   *     `fitPreviewZoom(zoom, …)` in `onFitClick`, i.e. fitting from the
   *     default rather than from what is on screen. Only "fits from the zoom
   *     that is on screen NOW" reds — for exactly the right reason:
   *       AssertionError: expected 0.5 to be 0.625
   */

  it("a Fit click on an oversized diagram writes the fitted zoom to the STORE", async () => {
    openReady();
    render(<CodeEditor path={MD} />);
    await awaitHydrated(MD);
    expect(zoomOf(MD)).toBe(1); // genuinely at the default before the click

    // A 1200×400 diagram in a 600×400 pane: half as wide as it needs to be, and
    // already short enough — so the fit is 50%.
    stubFitGeometry(MD, { width: 1200, height: 400 }, { width: 600, height: 400 });
    fireEvent.click(fitButton(MD)!);

    // The STORE, not a local variable and not the DOM: this is the value that
    // survives a tab switch, and the only one the header and body both read.
    expect(zoomOf(MD)).toBe(0.5);
  });

  it("the fitted zoom flows back down onto the real body AND the header's % label", async () => {
    openReady();
    render(<CodeEditor path={MD} />);
    await awaitHydrated(MD);
    expect(bodyOf(MD).style.zoom).toBe("1");
    expect(label(MD).textContent).toBe("100%");

    stubFitGeometry(MD, { width: 1200, height: 400 }, { width: 600, height: 400 });
    fireEvent.click(fitButton(MD)!);

    // All three, re-queried after the re-render. A transform-only or label-only
    // change fails one of them and passes the others.
    expect(zoomOf(MD)).toBe(0.5);
    expect(bodyOf(MD).style.zoom).toBe("0.5");
    expect(label(MD).textContent).toBe("50%");
    // The diagram is also brought into view, once the new zoom has been laid
    // out — the deferral that stops it landing off-screen.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("a diagram SMALLER than the pane fits by zooming in — the other number", async () => {
    openReady();
    render(<CodeEditor path={MD} />);
    await awaitHydrated(MD);

    // 300×200 in a 600×400 pane: room to double on both axes.
    stubFitGeometry(MD, { width: 300, height: 200 }, { width: 600, height: 400 });
    fireEvent.click(fitButton(MD)!);

    expect(zoomOf(MD)).toBe(2);
    expect(bodyOf(MD).style.zoom).toBe("2");
    expect(label(MD).textContent).toBe("200%");
  });

  it("fits from the zoom that is on screen NOW, not from a value baked in at hydration", async () => {
    openReady();
    render(<CodeEditor path={MD} />);
    await awaitHydrated(MD);

    fireEvent.click(zoomIn(MD)); // 1 → 1.25, through the store and back
    expect(bodyOf(MD).style.zoom).toBe("1.25");

    // Same 2:1 overflow as the first test. `fitPreviewZoom` scales the CURRENT
    // zoom by the ratio the diagram is off by, so fitting from 1.25 must land
    // on 1.25 × 0.5 — a control that captured `zoom` when the diagram hydrated
    // would compute 1 × 0.5 and put back 0.5.
    stubFitGeometry(MD, { width: 1200, height: 400 }, { width: 600, height: 400 });
    fireEvent.click(fitButton(MD)!);

    expect(zoomOf(MD)).toBe(0.625);
    expect(bodyOf(MD).style.zoom).toBe("0.625");
    expect(label(MD).textContent).toBe("63%");
  });

  it("Fit is per FILE: fitting one editor's diagram leaves the other file's zoom alone", async () => {
    act(() => {
      layout().openEditorTab(MD);
      editors().initEditor(MD);
      editors().editorReady(MD, true);
      layout().openEditorTab(OTHER);
      editors().initEditor(OTHER);
      editors().editorReady(OTHER, true);
    });
    render(
      <>
        <CodeEditor path={MD} />
        <CodeEditor path={OTHER} />
      </>,
    );
    await awaitHydrated(MD);
    await awaitHydrated(OTHER);

    stubFitGeometry(MD, { width: 1200, height: 400 }, { width: 600, height: 400 });
    fireEvent.click(fitButton(MD)!);

    // `setPreviewZoom` is keyed on the path CodeEditor closed over. A Fit wired
    // to a global (or to the active tab) would move both.
    expect(zoomOf(MD)).toBe(0.5);
    expect(zoomOf(OTHER)).toBe(1);
    expect(bodyOf(MD).style.zoom).toBe("0.5");
    expect(bodyOf(OTHER).style.zoom).toBe("1");
    expect(label(OTHER).textContent).toBe("100%");
  });
});
