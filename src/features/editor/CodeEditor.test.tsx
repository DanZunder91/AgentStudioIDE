/**
 * CodeEditor — the editor's React header + host wiring (M4).
 *
 * The EditorRegistry (which owns CodeMirror 6) is mocked at the module boundary:
 * CM6 needs a real DOM, and its editability/keymap live in the browser tier. What
 * is under test here is the header (the Save affordance and save feedback), the
 * attach/detach lifecycle, and the right-click "Editor tools" menu (which
 * also hosts the blame toggle), all driven off the reactive `editors` store
 * slice. One test mounts a REAL CM6 view (cmTestKit) to prove "Find in file…"
 * opens the actual find bar.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  ensureEditor: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  // closeTab/closePane tear buffers down through this seam.
  dispose: vi.fn(),
  save: vi.fn().mockResolvedValue(true),
  // The preview reads the live buffer text through this (real return is
  // `string | null`, so the mock must allow null for the not-ready-buffer tests).
  currentText: vi.fn((): string | null => "# Hello"),
  // The blame toggle and the context-menu items resolve the CM6 view
  // through this seam. Tests swap in a FakeView (or a real cmTestKit view).
  getView: vi.fn((): object | null => null),
}));
vi.mock("./EditorRegistry", () => registry);

// The blame boundary — the IPC fetch and the CM6 gutter glue are mocked
// (no Rust, no CodeMirror under jsdom); what's under test is the menu toggle,
// the fetch/refetch wiring, and the calm error note. `blame.ts` stays REAL
// (pure functions with their own suite).
const blameIpc = vi.hoisted(() => ({
  gitBlame: vi.fn(),
}));
vi.mock("./blame/blameIpc", () => blameIpc);
const blameGutter = vi.hoisted(() => ({
  showBlame: vi.fn(),
  hideBlame: vi.fn(),
}));
vi.mock("./blame/blameGutter", () => blameGutter);

// The two rendered-preview surfaces are mocked to keep this a focused unit test of
// the header/toggle wiring (the real ones pull markdown-it + mermaid and are tested
// on their own). Each echoes the text it was handed so we can assert what flowed in.
// The Markdown mock also RECORDS every props object it receives — the zoom tests
// assert the CodeEditor↔preview seam (zoom in, onZoomChange back) through it.
interface MdPreviewProps {
  text: string;
  basePath: string;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
}
const mdPreviewCalls = vi.hoisted((): MdPreviewProps[] => []);
vi.mock("./MarkdownPreview", () => ({
  MarkdownPreview: (props: MdPreviewProps) => {
    mdPreviewCalls.push(props);
    return <div data-testid="md-preview">{props.text}</div>;
  },
}));
vi.mock("./CsvTable", () => ({
  CsvTable: ({ text }: { text: string }) => <div data-testid="csv-preview">{text}</div>,
}));
// The image and HTML surfaces. Mocked for the same reason as the two above —
// one pulls an IPC fetch and real layout, the other an iframe neither jsdom nor a
// Chromium test can meaningfully load. Both RECORD their props so the tests below
// can assert what CodeEditor actually handed them, which is the whole seam.
interface ImageViewerProps {
  path: string;
  svgText: string | null;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
}
const imageViewerCalls = vi.hoisted((): ImageViewerProps[] => []);
vi.mock("./ImageViewer", () => ({
  ImageViewer: (props: ImageViewerProps) => {
    imageViewerCalls.push(props);
    return <div data-testid="image-preview">{props.svgText ?? "(raster)"}</div>;
  },
}));
interface HtmlPreviewProps {
  path: string;
  reloadKey: number;
}
const htmlPreviewCalls = vi.hoisted((): HtmlPreviewProps[] => []);
vi.mock("./HtmlPreview", () => ({
  HtmlPreview: (props: HtmlPreviewProps) => {
    htmlPreviewCalls.push(props);
    return <div data-testid="html-preview-stub">{props.path}</div>;
  },
}));

import { useAppStore, type EditorUiState } from "../../app/store";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { modKey } from "../shortcuts/shortcuts";
import { CodeEditor } from "./CodeEditor";
import { bufferSearch } from "./find/bufferSearch";
import { barOf, makeView, stubGeometry } from "./find/cmTestKit";
import { PREVIEW_ZOOM_DEFAULT, stepPreviewZoom } from "./previewZoom";

const layout = () => useAppStore.getState().layoutActions;
const editors = () => useAppStore.getState().editorActions;

/**
 * A minimal CM6-view stand-in: exactly the surface the menu items read
 * (selection + sliceDoc + dispatch + focus), plus an identity marker the blame
 * assertions pin (showBlame/hideBlame must receive THIS view).
 */
interface FakeView {
  marker: string;
  state: {
    selection: { main: { empty: boolean; from: number; to: number } };
    sliceDoc(from: number, to: number): string;
  };
  dispatch: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}
const makeFakeView = (doc = "hello world", sel = { from: 0, to: 0 }): FakeView => ({
  marker: "cm-view",
  state: {
    selection: { main: { empty: sel.from === sel.to, from: sel.from, to: sel.to } },
    sliceDoc: (from, to) => doc.slice(from, to),
  },
  dispatch: vi.fn(),
  focus: vi.fn(),
});
let fakeView: FakeView;

/** The mocked async clipboard behind the menu's Copy/Cut/Paste. */
let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };

/* The editor's right-click menu — drive it exactly like a user would.
   fireEvent (not userEvent) throughout, so the fake-timer suites can share
   these helpers without deadlocking on userEvent's inter-event delays. */
const host = () => screen.getByTestId("editor-host");
const openMenu = () => fireEvent.contextMenu(host(), { clientX: 40, clientY: 30 });
const menuItem = (name: string | RegExp) => screen.getByRole("menuitem", { name });
const clickItem = (name: string | RegExp) => fireEvent.click(menuItem(name));
/** Open the menu and click the blame toggle (whatever its current label). */
const toggleBlame = () => {
  openMenu();
  clickItem(/Git Blame/);
};

/** A small blame payload — its content is opaque to CodeEditor (passthrough). */
const FILE_BLAME = {
  relPath: "src/a.ts",
  commits: [
    {
      id: "8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49",
      author: "Max Turing",
      email: "max@example.com",
      timeMs: 1_780_000_000_000,
      summary: "feat: blame",
      message: "feat: blame\n",
    },
  ],
  lines: [0],
};

/** Open an editor tab and drive it to a ready state. */
const openReady = (path: string, editable = true) =>
  act(() => {
    layout().openEditorTab(path);
    editors().initEditor(path);
    editors().editorReady(path, editable);
  });

beforeAll(() => stubGeometry()); // for the one real-CM6 view (the find test)

beforeEach(() => {
  resetStore();
  resetFleetStore();
  registry.ensureEditor.mockClear();
  registry.attach.mockClear();
  registry.detach.mockClear();
  registry.save.mockClear().mockResolvedValue(true);
  registry.currentText.mockClear().mockReturnValue("# Hello");
  mdPreviewCalls.length = 0;
  imageViewerCalls.length = 0;
  htmlPreviewCalls.length = 0;
  fakeView = makeFakeView();
  registry.getView.mockClear().mockReturnValue(fakeView);
  blameIpc.gitBlame.mockReset().mockResolvedValue(FILE_BLAME);
  blameGutter.showBlame.mockClear();
  blameGutter.hideBlame.mockClear();
  // jsdom has no navigator.clipboard — install a fresh, well-behaved mock.
  clipboard = {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
});
afterEach(() => cleanup());

describe("CodeEditor", () => {
  it("ensures + attaches the registry view on mount, detaches on unmount", () => {
    openReady("/w/a.ts");
    const { unmount } = render(<CodeEditor path="/w/a.ts" />);

    expect(registry.ensureEditor).toHaveBeenCalledWith("/w/a.ts");
    expect(registry.attach).toHaveBeenCalledWith("/w/a.ts", expect.any(HTMLElement));

    unmount();
    expect(registry.detach).toHaveBeenCalledWith("/w/a.ts");
  });

  it("shows the loading state, then the calm error state", () => {
    act(() => layout().openEditorTab("/w/a.ts"));
    const { rerender } = render(<CodeEditor path="/w/a.ts" />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();

    act(() => {
      editors().initEditor("/w/a.ts");
      editors().editorFailed("/w/a.ts");
    });
    rerender(<CodeEditor path="/w/a.ts" />);
    expect(screen.getByText(/Can.t preview this file/)).toBeInTheDocument();
  });

  it("has no Edit/Done toggle — editing is the default, not an opt-in", () => {
    openReady("/w/a.ts");
    render(<CodeEditor path="/w/a.ts" />);

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(); // clean → no Save yet
  });

  it("shows Save once the buffer is dirty, and saves on click", async () => {
    openReady("/w/a.ts");
    render(<CodeEditor path="/w/a.ts" />);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(); // clean

    act(() => editors().setEditorDirty("/w/a.ts", true));
    const saveBtn = await screen.findByRole("button", { name: "Save" });
    await userEvent.setup().click(saveBtn);
    expect(registry.save).toHaveBeenCalledWith("/w/a.ts");
  });

  it("flashes 'Saved' after a save and surfaces a save error inline", () => {
    openReady("/w/a.ts");
    act(() => editors().editorSaved("/w/a.ts")); // savedAt=1, clean
    const { rerender } = render(<CodeEditor path="/w/a.ts" />);
    expect(screen.getByText("Saved")).toBeInTheDocument();

    act(() => editors().editorSaveFailed("/w/a.ts", "permission denied"));
    rerender(<CodeEditor path="/w/a.ts" />);
    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.queryByText("Saved")).toBeNull(); // error takes precedence
  });

  // ── images, SVG and HTML join the preview family ───────────────────────────
  describe("image / SVG / HTML previews", () => {
    /**
     * 🔴 The actual bug. `read_file` rejects a PNG as "binary file", so
     * routing one through `ensureEditor` is what produced *"Can't preview this
     * file."* on every image tab. A raster path must never reach the registry at
     * all — and this is the assertion that keeps it that way.
     */
    it("never asks the registry for a buffer on a raster image", () => {
      act(() => layout().openEditorTab("/w/logo.png"));
      render(<CodeEditor path="/w/logo.png" />);

      expect(registry.ensureEditor).not.toHaveBeenCalled();
      expect(registry.attach).not.toHaveBeenCalled();
      expect(screen.getByTestId("image-preview")).toBeInTheDocument();
      // No CM6 host is even mounted, so the editor-tools menu is unreachable
      // rather than reachable-over-nothing.
      expect(screen.queryByTestId("editor-host")).toBeNull();
      expect(screen.queryByText("Can’t preview this file.")).toBeNull();
    });

    /**
     * The slice has to exist even without a buffer: `setPreviewZoom` no-ops on a
     * path it does not know, so without this the −/%/+ buttons would be inert.
     */
    it("seeds the editor UI slice for a raster so its zoom controls work", () => {
      act(() => layout().openEditorTab("/w/logo.png"));
      render(<CodeEditor path="/w/logo.png" />);

      expect(useAppStore.getState().editors["/w/logo.png"]).toMatchObject({
        status: "ready",
        editable: false,
      });
      expect(screen.getByTestId("preview-zoom-in")).toBeInTheDocument();
      expect(screen.getByTestId("preview-zoom-reset")).toBeInTheDocument();
    });

    it("offers a raster no Source view — there is no text behind it", () => {
      act(() => layout().openEditorTab("/w/logo.png"));
      render(<CodeEditor path="/w/logo.png" />);
      expect(screen.queryByTestId("view-source")).toBeNull();
      expect(screen.queryByTestId("view-rendered")).toBeNull();
      expect(imageViewerCalls.at(-1)?.svgText).toBeNull();
    });

    /**
     * An SVG is the one image that is also text: it keeps its buffer, so the
     * picture is built from `currentText` and follows the user's typing. Fetching
     * it from disk instead would have shown the last-SAVED file.
     */
    it("builds an SVG's picture from the LIVE buffer, behind an Image/Source toggle", () => {
      registry.currentText.mockReturnValue("<svg><rect /></svg>");
      openReady("/w/icon.svg");
      render(<CodeEditor path="/w/icon.svg" />);

      expect(registry.ensureEditor).toHaveBeenCalledWith("/w/icon.svg");
      expect(screen.getByTestId("view-rendered")).toHaveTextContent("Image");
      expect(imageViewerCalls.at(-1)?.svgText).toBe("<svg><rect /></svg>");
      expect(screen.getByTestId("preview-zoom-in")).toBeInTheDocument();
    });

    it("falls back to an empty SVG source when the buffer is not ready yet", () => {
      registry.currentText.mockReturnValue(null);
      openReady("/w/icon.svg");
      render(<CodeEditor path="/w/icon.svg" />);
      expect(imageViewerCalls.at(-1)?.svgText).toBe("");
    });

    it("shows an SVG's raw source when toggled, and the picture again on the way back", async () => {
      openReady("/w/icon.svg");
      render(<CodeEditor path="/w/icon.svg" />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId("view-source"));
      expect(screen.queryByTestId("image-preview")).toBeNull();
      expect(screen.getByTestId("editor-host")).toBeInTheDocument();

      await user.click(screen.getByTestId("view-rendered"));
      expect(screen.getByTestId("image-preview")).toBeInTheDocument();
    });

    /**
     * The zoom round-trip, the other half of the seam: the header's −/%/+ buttons
     * write through `zoom`, and ctrl/cmd+wheel and Fit inside the picture report
     * back through `onZoomChange`. Both land on the same store slice, so the
     * header's % label can never disagree with the picture.
     */
    it("round-trips zoom to and from the image viewer", () => {
      openReady("/w/icon.svg");
      render(<CodeEditor path="/w/icon.svg" />);
      expect(imageViewerCalls.at(-1)?.zoom).toBe(PREVIEW_ZOOM_DEFAULT);

      const next = stepPreviewZoom(PREVIEW_ZOOM_DEFAULT, 1);
      act(() => imageViewerCalls.at(-1)!.onZoomChange!(next));
      expect(useAppStore.getState().editors["/w/icon.svg"].previewZoom).toBe(next);
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("125%");
    });

    /**
     * HTML renders from DISK through the `preview://` handler, not from the buffer
     * — the page's own <link>/<script> are real requests for real files. `savedAt`
     * is therefore the reload signal, and it is passed through as `reloadKey`.
     */
    it("mounts the HTML preview with savedAt as its reload key", () => {
      openReady("/w/page.html");
      render(<CodeEditor path="/w/page.html" />);

      expect(screen.getByTestId("html-preview-stub")).toHaveTextContent("/w/page.html");
      expect(htmlPreviewCalls.at(-1)?.reloadKey).toBe(0);
      expect(screen.getByTestId("view-rendered")).toHaveTextContent("Preview");
    });

    it("bumps the HTML preview's reload key on every successful save", () => {
      openReady("/w/page.html");
      const { rerender } = render(<CodeEditor path="/w/page.html" />);
      act(() => editors().editorSaved("/w/page.html"));
      rerender(<CodeEditor path="/w/page.html" />);
      expect(htmlPreviewCalls.at(-1)?.reloadKey).toBe(1);
    });

    /**
     * Deliberate absence, pinned so it cannot be added by reflex: preview zoom
     * is CSS `zoom`, which on an iframe element scales the frame box
     * rather than the inner document's layout — a control that moves the % label
     * without moving the page.
     */
    it("gives the HTML preview NO zoom cluster", () => {
      openReady("/w/page.html");
      render(<CodeEditor path="/w/page.html" />);
      expect(screen.queryByTestId("preview-zoom-in")).toBeNull();
      expect(screen.queryByTestId("preview-zoom-reset")).toBeNull();
    });

    /**
     * 🔴 `Pane` renders only the active tab and a cross-pane drag
     * re-parents the subtree, so React remounts on both. A `useState` toggle
     * snapped back to Preview every time; the store-backed one survives.
     */
    it("keeps the Source choice across a full remount", async () => {
      openReady("/w/README.md");
      const first = render(<CodeEditor path="/w/README.md" />);
      await userEvent.setup().click(screen.getByTestId("view-source"));
      expect(screen.getByTestId("view-source")).toHaveAttribute("aria-pressed", "true");

      first.unmount(); // what a tab switch or a cross-pane drag does
      render(<CodeEditor path="/w/README.md" />);
      expect(screen.getByTestId("view-source")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByTestId("md-preview")).toBeNull();
    });
  });

  // ── the Markdown/CSV rendered-preview toggle ───────────────────────────────
  describe("rendered preview", () => {
    it("has no view toggle for a non-previewable file", () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);
      expect(screen.queryByTestId("view-rendered")).toBeNull();
      expect(screen.queryByTestId("md-preview")).toBeNull();
    });

    it("renders a Markdown file's preview by default, with a Preview/Source toggle", () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);

      // Toggle present, Preview pressed by default; the preview is showing the buffer.
      expect(screen.getByTestId("view-rendered")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("view-source")).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTestId("md-preview")).toHaveTextContent("# Hello");
      expect(registry.currentText).toHaveBeenCalledWith("/w/README.md");
    });

    it("switches to raw source and back", async () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId("view-source"));
      expect(screen.queryByTestId("md-preview")).toBeNull(); // preview hidden
      expect(screen.getByTestId("view-source")).toHaveAttribute("aria-pressed", "true");

      await user.click(screen.getByTestId("view-rendered"));
      expect(screen.getByTestId("md-preview")).toBeInTheDocument();
    });

    it("renders a CSV file as a table, with a Table/Source toggle", () => {
      registry.currentText.mockReturnValue("a,b\n1,2");
      openReady("/w/data.csv");
      render(<CodeEditor path="/w/data.csv" />);
      expect(screen.getByTestId("view-rendered")).toHaveTextContent("Table");
      expect(screen.getByTestId("csv-preview")).toHaveTextContent("a,b");
    });

    it("passes an empty string to the preview when the buffer is not ready yet", () => {
      registry.currentText.mockReturnValue(null); // view not created yet
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);
      expect(screen.getByTestId("md-preview")).toHaveTextContent("");
    });

    it("shows no preview until the file has loaded (loading state)", () => {
      act(() => layout().openEditorTab("/w/README.md")); // opened, not ready
      render(<CodeEditor path="/w/README.md" />);
      expect(screen.queryByTestId("md-preview")).toBeNull();
      expect(screen.queryByTestId("view-rendered")).toBeNull(); // toggle waits for ready
    });

    it("treats an extension-less file as non-previewable", () => {
      openReady("/w/Makefile"); // no dot → previewKindOf returns null
      render(<CodeEditor path="/w/Makefile" />);
      expect(screen.queryByTestId("view-rendered")).toBeNull();
    });

    it("resolves an empty base path for a Markdown file with no directory", () => {
      openReady("README.md"); // no slash → dirOf returns ""
      render(<CodeEditor path="README.md" />);
      expect(screen.getByTestId("md-preview")).toBeInTheDocument();
    });

    it("passes an empty string to the CSV table when the buffer is not ready", () => {
      registry.currentText.mockReturnValue(null);
      openReady("/w/data.csv");
      render(<CodeEditor path="/w/data.csv" />);
      expect(screen.getByTestId("csv-preview")).toHaveTextContent("");
    });
  });

  // ── Markdown-preview zoom: the − / % / + header controls, wired to the
  //    per-file `previewZoom` store slice (math lives in previewZoom.ts).
  describe("preview zoom controls", () => {
    const ZOOM_IDS = ["preview-zoom-out", "preview-zoom-reset", "preview-zoom-in"];
    /** The store's zoom for a path, read directly (the other side of the label). */
    const storeZoom = (path: string) =>
      useAppStore.getState().editors[path]?.previewZoom;
    /** The props the mocked MarkdownPreview received on its LATEST render. */
    const lastPreviewProps = () => mdPreviewCalls[mdPreviewCalls.length - 1];

    it("shows − / % / + only for a markdown file's RENDERED preview", async () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);
      for (const id of ZOOM_IDS) expect(screen.getByTestId(id)).toBeInTheDocument();
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("100%");

      // Dropping to Source hides the controls (the preview unmounts with them).
      await userEvent.setup().click(screen.getByTestId("view-source"));
      for (const id of ZOOM_IDS) expect(screen.queryByTestId(id)).toBeNull();
    });

    it("shows no zoom controls for a CSV preview", () => {
      registry.currentText.mockReturnValue("a,b\n1,2");
      openReady("/w/data.csv");
      render(<CodeEditor path="/w/data.csv" />);
      expect(screen.getByTestId("csv-preview")).toBeInTheDocument(); // rendered, but…
      for (const id of ZOOM_IDS) expect(screen.queryByTestId(id)).toBeNull();
    });

    it("shows no zoom controls for a non-previewable file", () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);
      for (const id of ZOOM_IDS) expect(screen.queryByTestId(id)).toBeNull();
    });

    it("+ steps the store zoom up and the % label follows", async () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("100%");

      await userEvent.setup().click(screen.getByTestId("preview-zoom-in"));
      expect(storeZoom("/w/README.md")).toBe(stepPreviewZoom(1, 1));
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("125%");
    });

    it("− steps the store zoom down and the % label follows", async () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);

      await userEvent.setup().click(screen.getByTestId("preview-zoom-out"));
      expect(storeZoom("/w/README.md")).toBe(0.8); // stepPreviewZoom(1, -1)
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("80%");
    });

    it("the % button resets to exactly the default after zooming", async () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId("preview-zoom-in"));
      await user.click(screen.getByTestId("preview-zoom-in"));
      expect(storeZoom("/w/README.md")).not.toBe(PREVIEW_ZOOM_DEFAULT);

      await user.click(screen.getByTestId("preview-zoom-reset"));
      expect(storeZoom("/w/README.md")).toBe(PREVIEW_ZOOM_DEFAULT);
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("100%");
    });

    it("wires the preview seam BOTH ways: zoom flows in, onZoomChange writes back", async () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);

      // In: the preview receives the store's zoom, and re-receives it on change.
      expect(lastPreviewProps().zoom).toBe(PREVIEW_ZOOM_DEFAULT);
      await userEvent.setup().click(screen.getByTestId("preview-zoom-in"));
      expect(lastPreviewProps().zoom).toBe(storeZoom("/w/README.md"));

      // Out: the preview's own gesture (ctrl/cmd+scroll) reports through
      // onZoomChange — invoking the captured callback must land in the store.
      const props = lastPreviewProps();
      expect(props.onZoomChange).toBeTypeOf("function");
      act(() => props.onZoomChange?.(2));
      expect(storeZoom("/w/README.md")).toBe(2);
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("200%");
    });

    it("the −/+ titles name the platform scroll gesture (modKey)", () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);
      expect(screen.getByTestId("preview-zoom-in")).toHaveAttribute(
        "title",
        `Zoom in (${modKey()}+scroll)`,
      );
      expect(screen.getByTestId("preview-zoom-out")).toHaveAttribute(
        "title",
        `Zoom out (${modKey()}+scroll)`,
      );
    });

    it("the label falls back to 100% when the slice carries no zoom (?? default)", () => {
      openReady("/w/README.md");
      // No store action can produce a ready slice without `previewZoom`
      // (initEditor seeds it), so forge the shape the `??` guards via the
      // harness's setState idiom — the observable side of the fallback.
      act(() =>
        useAppStore.setState((s) => {
          delete (s.editors["/w/README.md"] as Partial<EditorUiState>).previewZoom;
        }),
      );
      render(<CodeEditor path="/w/README.md" />);
      expect(screen.getByTestId("preview-zoom-reset")).toHaveTextContent("100%");
    });
  });

  // ── the git-blame annotate toggle — driven from the right-click menu
  //    (Blame is a right-click tool, not a header button).
  describe("git blame", () => {
    it("offers 'Annotate with Git Blame' in the menu — no header button, OFF costs nothing", () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);
      expect(screen.queryByTestId("blame-toggle")).toBeNull(); // the header button is GONE

      openMenu();
      expect(menuItem("Annotate with Git Blame")).toBeEnabled();
      expect(blameIpc.gitBlame).not.toHaveBeenCalled(); // OFF costs nothing
    });

    it("toggling ON fetches blame for the tab's path, shows the gutter, flips the label", async () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      toggleBlame();

      expect(blameIpc.gitBlame).toHaveBeenCalledExactlyOnceWith("/w/a.ts");
      await vi.waitFor(() =>
        expect(blameGutter.showBlame).toHaveBeenCalledWith(fakeView, FILE_BLAME),
      );
      openMenu(); // the toggle now reads as the OFF switch
      expect(menuItem("Hide Git Blame")).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Annotate with Git Blame" })).toBeNull();
    });

    it("toggling OFF hides the gutter, does not refetch, and flips the label back", async () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      toggleBlame(); // ON
      await vi.waitFor(() => expect(blameGutter.showBlame).toHaveBeenCalled());
      blameGutter.hideBlame.mockClear();
      blameIpc.gitBlame.mockClear();

      toggleBlame(); // OFF (clicks "Hide Git Blame")
      expect(blameGutter.hideBlame).toHaveBeenCalledWith(fakeView);
      expect(blameIpc.gitBlame).not.toHaveBeenCalled();
      openMenu();
      expect(menuItem("Annotate with Git Blame")).toBeInTheDocument();
    });

    it("refetches after every save (blame is computed against the file on disk)", async () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      toggleBlame();
      await vi.waitFor(() => expect(blameGutter.showBlame).toHaveBeenCalledTimes(1));

      act(() => editors().editorSaved("/w/a.ts")); // savedAt bumps → refetch
      await vi.waitFor(() => expect(blameGutter.showBlame).toHaveBeenCalledTimes(2));
      expect(blameIpc.gitBlame).toHaveBeenCalledTimes(2);

      act(() => editors().editorSaved("/w/a.ts"));
      await vi.waitFor(() => expect(blameIpc.gitBlame).toHaveBeenCalledTimes(3));
    });

    it("does NOT refetch on save while the toggle is off", async () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);
      act(() => editors().editorSaved("/w/a.ts"));
      await act(async () => {}); // flush effects
      expect(blameIpc.gitBlame).not.toHaveBeenCalled();
    });

    it("shows the '(out of date)' hint while blame is on and the buffer is dirty", async () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);
      expect(screen.queryByTestId("blame-stale")).toBeNull();

      toggleBlame();
      act(() => editors().setEditorDirty("/w/a.ts", true));
      expect(screen.getByTestId("blame-stale")).toHaveTextContent("(out of date)");

      act(() => editors().setEditorDirty("/w/a.ts", false));
      expect(screen.queryByTestId("blame-stale")).toBeNull();
    });

    it("does not show the stale hint for a dirty buffer while blame is OFF", () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);
      act(() => editors().setEditorDirty("/w/a.ts", true));
      expect(screen.queryByTestId("blame-stale")).toBeNull();
    });

    it("a not-a-repo rejection shows the calm transient note and re-arms the toggle — no crash", async () => {
      blameIpc.gitBlame.mockRejectedValue("/tmp/x.ts is not in a git repository");
      openReady("/tmp/x.ts");
      render(<CodeEditor path="/tmp/x.ts" />);

      toggleBlame();

      const note = await screen.findByTestId("blame-note");
      expect(note).toHaveTextContent("No git history");
      expect(blameGutter.showBlame).not.toHaveBeenCalled();
      openMenu(); // blame turned itself back OFF → the item reads Annotate again
      expect(menuItem("Annotate with Git Blame")).toBeInTheDocument();
    });

    it("any other rejection (scope / IPC failure) shows the generic note", async () => {
      blameIpc.gitBlame.mockRejectedValue("path is outside the workspace scope");
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      toggleBlame();
      expect(await screen.findByTestId("blame-note")).toHaveTextContent("Blame unavailable");
    });

    it("the error note is transient — it clears itself after ~3 s", async () => {
      vi.useFakeTimers(); // BEFORE the click, so the 3 s timer runs on this clock
      try {
        blameIpc.gitBlame.mockRejectedValue("nope");
        openReady("/w/a.ts");
        render(<CodeEditor path="/w/a.ts" />);
        // The menu helpers are fireEvent-based on purpose: userEvent's
        // inter-event delays sit on the (now fake) clock and deadlock.
        toggleBlame();
        await act(async () => {}); // flush the rejection microtask
        expect(screen.getByTestId("blame-note")).toHaveTextContent("Blame unavailable");

        act(() => void vi.advanceTimersByTime(3000));
        expect(screen.queryByTestId("blame-note")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("unmounting while blame is on removes the gutter from the surviving view", async () => {
      openReady("/w/a.ts");
      const { unmount } = render(<CodeEditor path="/w/a.ts" />);
      toggleBlame();
      await vi.waitFor(() => expect(blameGutter.showBlame).toHaveBeenCalled());
      blameGutter.hideBlame.mockClear();

      unmount();
      expect(blameGutter.hideBlame).toHaveBeenCalledWith(fakeView);
    });

    it("a fetch resolving AFTER unmount does not render a gutter (stale guard)", async () => {
      let resolve!: (b: typeof FILE_BLAME) => void;
      blameIpc.gitBlame.mockReturnValue(
        new Promise<typeof FILE_BLAME>((r) => {
          resolve = r;
        }),
      );
      openReady("/w/a.ts");
      const { unmount } = render(<CodeEditor path="/w/a.ts" />);
      toggleBlame();

      unmount();
      resolve(FILE_BLAME);
      await act(async () => {}); // let the resolution settle
      expect(blameGutter.showBlame).not.toHaveBeenCalled();
    });

    it("a fetch REJECTING after unmount shows no note and flips nothing (stale guard)", async () => {
      let reject!: (e: unknown) => void;
      blameIpc.gitBlame.mockReturnValue(
        new Promise<typeof FILE_BLAME>((_r, rej) => {
          reject = rej;
        }),
      );
      openReady("/w/a.ts");
      const { unmount } = render(<CodeEditor path="/w/a.ts" />);
      toggleBlame();

      unmount();
      reject("gone");
      await act(async () => {}); // settle: the stale guard must swallow it
      // No note appeared anywhere (the component is gone), and — critically —
      // no unhandled-rejection/setState-on-unmounted crash escaped.
      expect(screen.queryByTestId("blame-note")).toBeNull();
    });

    it("a second failure while a note is pending replaces it — the old 3 s timer is cleared", async () => {
      vi.useFakeTimers();
      try {
        blameIpc.gitBlame.mockRejectedValue("nope");
        openReady("/w/a.ts");
        render(<CodeEditor path="/w/a.ts" />);
        toggleBlame(); // failure #1 → note + 3 s timer armed at t=0
        await act(async () => {});
        expect(screen.getByTestId("blame-note")).toHaveTextContent("Blame unavailable");

        act(() => void vi.advanceTimersByTime(1000)); // t=1 s
        toggleBlame(); // failure #2 → must CLEAR the pending timer, arm a new one
        await act(async () => {});

        // t=3.5 s: past failure #1's deadline. If the old timer had survived,
        // the note would already be gone — proving the clearTimeout matters.
        act(() => void vi.advanceTimersByTime(2500));
        expect(screen.getByTestId("blame-note")).toHaveTextContent("Blame unavailable");

        // t=4.1 s: failure #2's own 3 s elapses — now it clears.
        act(() => void vi.advanceTimersByTime(600));
        expect(screen.queryByTestId("blame-note")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── the right-click "Editor tools" menu ─────────────────────────────────────
  describe("editor context menu", () => {
    it("suppresses the native menu and opens 'Editor tools' instead", () => {
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      // fireEvent returns false iff preventDefault() ran — the native WebKit
      // menu (Look Up / Translate / Services…) never opens.
      const notPrevented = fireEvent.contextMenu(host(), { clientX: 40, clientY: 30 });
      expect(notPrevented).toBe(false);
      expect(screen.getByRole("menu", { name: "Editor tools" })).toBeInTheDocument();
    });

    it("keeps the native menu on the rendered Markdown preview (text-selection niceties)", () => {
      openReady("/w/README.md");
      render(<CodeEditor path="/w/README.md" />);

      const notPrevented = fireEvent.contextMenu(screen.getByTestId("md-preview"));
      expect(notPrevented).toBe(true); // NOT prevented → the native menu shows
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("disables Copy and Cut while the selection is empty", () => {
      openReady("/w/a.ts"); // fakeView's default selection is empty
      render(<CodeEditor path="/w/a.ts" />);
      openMenu();

      expect(menuItem("Copy")).toBeDisabled();
      expect(menuItem("Cut")).toBeDisabled();
      expect(menuItem("Paste")).toBeEnabled(); // editable, view present
      expect(menuItem("Find in file…")).toBeEnabled();
    });

    it("Copy writes the selection to the clipboard, closes the menu, refocuses the editor", async () => {
      fakeView = makeFakeView("hello world", { from: 0, to: 5 });
      registry.getView.mockReturnValue(fakeView);
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      openMenu();
      clickItem("Copy");
      await act(async () => {});

      expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("hello");
      expect(screen.queryByRole("menu")).toBeNull(); // closed on selection
      expect(fakeView.focus).toHaveBeenCalled();
    });

    it("a Copy clipboard rejection is calm — no crash, focus still returns", async () => {
      clipboard.writeText.mockRejectedValue(new Error("denied"));
      fakeView = makeFakeView("hello world", { from: 0, to: 5 });
      registry.getView.mockReturnValue(fakeView);
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      openMenu();
      clickItem("Copy");
      await act(async () => {}); // the rejection must be swallowed here

      expect(fakeView.focus).toHaveBeenCalled();
    });

    it("Cut copies, then deletes the selection once the write has resolved", async () => {
      fakeView = makeFakeView("hello world", { from: 0, to: 5 });
      registry.getView.mockReturnValue(fakeView);
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      openMenu();
      clickItem("Cut");
      await act(async () => {});

      expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("hello");
      expect(fakeView.dispatch).toHaveBeenCalledExactlyOnceWith({
        changes: { from: 0, to: 5, insert: "" },
        selection: { anchor: 0 },
      });
      expect(fakeView.focus).toHaveBeenCalled();
    });

    it("Cut does NOT delete when the clipboard write fails (never lose the selection)", async () => {
      clipboard.writeText.mockRejectedValue(new Error("denied"));
      fakeView = makeFakeView("hello world", { from: 0, to: 5 });
      registry.getView.mockReturnValue(fakeView);
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      openMenu();
      clickItem("Cut");
      await act(async () => {});

      expect(fakeView.dispatch).not.toHaveBeenCalled();
    });

    it("disables Cut and Paste for a read-only buffer (Copy stays available)", () => {
      fakeView = makeFakeView("hello world", { from: 0, to: 5 });
      registry.getView.mockReturnValue(fakeView);
      openReady("/w/big.ts", false); // oversized → read-only
      render(<CodeEditor path="/w/big.ts" />);
      openMenu();

      expect(menuItem("Copy")).toBeEnabled();
      expect(menuItem("Cut")).toBeDisabled();
      expect(menuItem("Paste")).toBeDisabled();
    });

    it("Paste replaces the selection with the clipboard text", async () => {
      clipboard.readText.mockResolvedValue("PASTED");
      fakeView = makeFakeView("hello world", { from: 2, to: 4 });
      registry.getView.mockReturnValue(fakeView);
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      openMenu();
      clickItem("Paste");
      await act(async () => {});

      expect(fakeView.dispatch).toHaveBeenCalledExactlyOnceWith({
        changes: { from: 2, to: 4, insert: "PASTED" },
        selection: { anchor: 8 }, // caret lands after the inserted text
      });
      expect(fakeView.focus).toHaveBeenCalled();
    });

    it("a Paste readText rejection is calm — nothing dispatched, no crash", async () => {
      clipboard.readText.mockRejectedValue(new Error("clipboard unavailable"));
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      openMenu();
      clickItem("Paste");
      await act(async () => {});

      expect(fakeView.dispatch).not.toHaveBeenCalled();
      expect(fakeView.focus).toHaveBeenCalled();
    });

    it("without navigator.clipboard, Copy/Cut/Paste are calm no-ops", async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      fakeView = makeFakeView("hello world", { from: 0, to: 5 });
      registry.getView.mockReturnValue(fakeView);
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);

      openMenu();
      clickItem("Copy"); // each click closes the menu — reopen for the next
      openMenu();
      clickItem("Cut");
      openMenu();
      clickItem("Paste");
      await act(async () => {});

      expect(fakeView.dispatch).not.toHaveBeenCalled(); // nothing deleted/inserted
      expect(fakeView.focus).toHaveBeenCalledTimes(3); // still calm + refocused
    });

    it("disables every view-driven item until the CM6 view exists", () => {
      registry.getView.mockReturnValue(null); // buffer not created yet
      openReady("/w/a.ts");
      render(<CodeEditor path="/w/a.ts" />);
      openMenu();

      expect(menuItem("Copy")).toBeDisabled();
      expect(menuItem("Cut")).toBeDisabled();
      expect(menuItem("Paste")).toBeDisabled();
      expect(menuItem("Find in file…")).toBeDisabled();
      expect(menuItem("Annotate with Git Blame")).toBeEnabled(); // state-only, no view needed
    });

    it("treats a still-loading file (no editors entry) as read-only", () => {
      act(() => layout().openEditorTab("/w/a.ts")); // opened, never initEditor'd
      fakeView = makeFakeView("hello world", { from: 0, to: 5 });
      registry.getView.mockReturnValue(fakeView);
      render(<CodeEditor path="/w/a.ts" />);
      openMenu();

      expect(menuItem("Copy")).toBeEnabled(); // selection exists
      expect(menuItem("Cut")).toBeDisabled(); // unknown editability → read-only
      expect(menuItem("Paste")).toBeDisabled();
    });

    it("'Find in file…' opens the find panel on the real view (real CM6 + bufferSearch)", () => {
      const harness = makeView("alpha beta alpha", bufferSearch());
      try {
        registry.getView.mockReturnValue(harness.view);
        openReady("/w/a.ts");
        render(<CodeEditor path="/w/a.ts" />);

        expect(barOf(harness.view)).toBeNull(); // no bar yet
        openMenu();
        clickItem("Find in file…");
        expect(barOf(harness.view)).not.toBeNull(); // the find bar is up
      } finally {
        harness.destroy();
      }
    });
  });
});
