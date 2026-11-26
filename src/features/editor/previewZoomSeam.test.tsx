/** Seam: the real CodeEditor mounts the real MarkdownPreview over the real store; each half's
 * own suite mocks the other. Only outer boundaries are mocked (CM6, blame IPC, mermaid, image-read
 * IPC). */

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

/** A native cancelable wheel: fireEvent.wheel is not cancelable and the listener is native and
 * non-passive. Wrapped in act because the handler writes to the store synchronously. */
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

/** A zoom re-renders the whole stack; React 19 re-assigns innerHTML on a new
 * `dangerouslySetInnerHTML` object, which would erase hydrated SVGs. Assertions re-query the DOM:
 * a detached `<pre>` keeps its SVG. */
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

/** Fit is an injected `<button>` caught by a delegated onClick and routed through the store back
 * to the zoom prop. jsdom has no layout, so `stubFitGeometry` fakes measurements: wiring only;
 * geometry is in markdownPreviewZoom.browser.test.tsx. Helpers re-query after every click. */
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

  /** Supplies the pane box and diagram rect jsdom lacks. Both nodes survive the re-renders, so one
   * stub holds for every click in a test. */
  function stubFitGeometry(path: string, diagram: Size, paneBox: Size): void {
    const el = pane(path);
    Object.defineProperty(el, "clientWidth", { value: paneBox.width, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: paneBox.height, configurable: true });
    const svg = block(path)!.querySelector("svg")!;
    // `fromRect`, not a literal or spread: DOMRect's width/height are prototype accessors.
    const rect = DOMRect.fromRect({ width: diagram.width, height: diagram.height });
    svg.getBoundingClientRect = () => rect;
  }

  beforeEach(() => {
    registry.currentText.mockReturnValue(DIAGRAM_DOC);
    mermaidMock.render
      .mockReset()
      .mockResolvedValue({ svg: '<svg data-testid="seam-mermaid-svg"></svg>' });
    // jsdom lacks `scrollIntoView` and the post-Fit layout effect calls it; removed again below.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

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

    // Fit scales the current zoom: from 1.25 it must land on 1.25 × 0.5, not 1 × 0.5.
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
