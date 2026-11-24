/**
 * ImageViewer tests — layer 3, jsdom + @testing-library/react.
 *
 * This tier owns the *wiring and the arithmetic*: which sink the bytes land in,
 * how the `data:` URL is built, which IPC is (and is not) called, how a rejected
 * read is surfaced, how a stale read is dropped, and what each gesture reports
 * through `onZoomChange`. It owns NONE of the geometry — jsdom has no layout
 * engine, so every `getBoundingClientRect()` is 0×0, every `clientWidth` is 0,
 * scroll boxes are inert and no image is ever decoded. Everything measured is
 * therefore stubbed and says so; the pixels are asserted in
 * `imageViewer.browser.test.tsx` under real Chromium.
 *
 * `../workspace/workspaceIpc` is mocked at the module boundary so the raster
 * path can be driven through success, rejection, path-change and unmount races
 * without touching Tauri. The factory is a frozen copy of that module's surface
 * (a `vi.mock` factory does not grow new exports): if this component grows a second import from it,
 * this factory has to grow the export in the SAME change or the break arrives as
 * an "Unhandled Error" beside a green run.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspaceIpc = vi.hoisted(() => ({ readImageDataUrl: vi.fn() }));
vi.mock("../workspace/workspaceIpc", () => workspaceIpc);

import { ImageViewer } from "./ImageViewer";
import { anchorScrollDelta, fitPreviewZoom, wheelPreviewZoom } from "./previewZoom";

const noop = (): void => undefined;

/** The component in its usual shape; every test overrides what it cares about. */
function view(props: {
  path?: string;
  svgText?: string | null;
  zoom?: number;
  onZoomChange?: (z: number) => void;
}): React.JSX.Element {
  return (
    <ImageViewer
      path={props.path ?? "/w/pic.svg"}
      svgText={props.svgText ?? null}
      zoom={props.zoom ?? 1}
      onZoomChange={props.onZoomChange ?? noop}
    />
  );
}

const container = (): HTMLElement => screen.getByTestId("image-viewer");
const img = (): HTMLImageElement => screen.getByTestId("image-img") as HTMLImageElement;

/**
 * Dispatch a NATIVE wheel event and return it. `fireEvent.wheel` does not set
 * `cancelable`, and `defaultPrevented` is only observable on a cancelable event
 * — which several assertions below are entirely about (the component eats the
 * webview's own pinch-zoom).
 */
function wheel(el: HTMLElement, init: WheelEventInit): WheelEvent {
  const evt = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(evt);
  return evt;
}

/**
 * jsdom's scrollLeft/scrollTop are inert (no layout → no scrolling box), so
 * replace them with plain writable values. Stubbed, and honest about it: this
 * pins the component's scroll ARITHMETIC; real clamping against real bounds is
 * the browser tier's claim.
 */
function stubScroll(el: HTMLElement): void {
  Object.defineProperty(el, "scrollLeft", { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
}

/**
 * Feed `onFit` the two measurements it takes at click time. Everything jsdom
 * would report is 0, so an unstubbed Fit click measures a collapsed pane and
 * (correctly) does nothing — which would make the assertion vacuous.
 *
 * The padding is applied as a REAL inline style, so the handler reads it back
 * through `getComputedStyle` exactly as it would in the app.
 */
function stubFitGeometry(opts: {
  client: { width: number; height: number };
  padding: number;
  picture: { width: number; height: number };
}): void {
  const el = container();
  Object.defineProperty(el, "clientWidth", { value: opts.client.width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: opts.client.height, configurable: true });
  el.style.padding = `${opts.padding}px`;
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: opts.picture.width,
    height: opts.picture.height,
    right: opts.picture.width,
    bottom: opts.picture.height,
    toJSON: () => ({}),
  } as DOMRect;
  img().getBoundingClientRect = () => rect;
}

/** Fire `load` with an intrinsic width jsdom would otherwise always report as 0. */
function fireLoad(naturalWidth: number): void {
  const el = img();
  Object.defineProperty(el, "naturalWidth", { value: naturalWidth, configurable: true });
  fireEvent.load(el);
}

/** A promise whose settlement this test controls. */
function deferred(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  workspaceIpc.readImageDataUrl.mockReset().mockResolvedValue("data:image/png;base64,AAAA");
});

afterEach(() => {
  // Defensive: end any drag a failed assertion left open so the window-level
  // listeners and the body class never leak into the next test (house pattern).
  fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
  document.body.classList.remove("is-panning");
});

describe("ImageViewer — SVG (drawn from the live buffer, no IPC)", () => {
  it("draws the buffer as an <img> data URL and never asks Rust for the bytes", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
    render(view({ path: "/w/logo.svg", svgText: svg }));

    const el = img();
    expect(el.tagName).toBe("IMG");
    expect(el.getAttribute("src")).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );
    // The whole point of the SVG path: the picture comes from the CodeMirror
    // buffer, so there is no read to make and nothing to wait for.
    expect(workspaceIpc.readImageDataUrl).not.toHaveBeenCalled();
    expect(el).toHaveAttribute("alt", "logo.svg");
  });

  it("routes the bytes through <img> ONLY — no inline <svg>, <object>, <embed> or <iframe>", () => {
    // 🔴 Load-bearing security, not style (see the component header). An SVG in
    // IMAGE context runs in the secure processing mode — no scripts, no event
    // handlers, no external fetches. The same bytes inlined into the document
    // execute with Tauri IPC in scope, which reaches `terminal_write` and
    // therefore the user's shell. This test is the tripwire on that sink.
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.__pwned = true">' +
      '<script>globalThis.__pwned = true;</script><rect width="9" height="9"/></svg>';
    const { container: root } = render(view({ path: "/w/evil.svg", svgText: hostile }));

    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("svg")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelectorAll("object, embed, iframe")).toHaveLength(0);
    // The markup never existed AS MARKUP: percent-encoding put it in an
    // attribute value, so there is no `<script` anywhere in the tree.
    expect(root.innerHTML).not.toContain("<script");
    expect(root.innerHTML).not.toContain("onload=");
    // …and it is all still there, inert, inside the src.
    expect(decodeURIComponent(img().getAttribute("src") as string)).toContain("<script>");
  });

  it("percent-encodes non-ASCII source (a btoa sink would throw on it)", () => {
    // 🔴 `btoa` throws `InvalidCharacterError` on any codepoint > 255, so one
    // accented or CJK <text> element would crash the viewer instead of drawing.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>café 漢字 ✓</text></svg>';
    render(view({ svgText: svg }));

    const src = img().getAttribute("src") as string;
    expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(src.slice("data:image/svg+xml;charset=utf-8,".length))).toBe(svg);
  });

  it("follows the buffer as it is edited — the live preview", () => {
    const { rerender } = render(view({ svgText: "<svg><rect/></svg>" }));
    const before = img().getAttribute("src");

    rerender(view({ svgText: "<svg><circle/></svg>" }));

    expect(img().getAttribute("src")).not.toBe(before);
    expect(decodeURIComponent(img().getAttribute("src") as string)).toContain("<circle/>");
  });

  it("shows a calm note for an empty or whitespace-only buffer, not a broken image", () => {
    // A newly created `.svg` is an empty buffer, and `data:image/svg+xml,` with
    // nothing after it renders as the browser's broken-image glyph.
    const { rerender } = render(view({ svgText: "" }));
    expect(screen.getByTestId("image-placeholder")).toHaveTextContent("Nothing to preview.");
    expect(screen.queryByTestId("image-img")).toBeNull();

    rerender(view({ svgText: "  \n  " }));
    expect(screen.getByTestId("image-placeholder")).toHaveTextContent("Nothing to preview.");
  });
});

describe("ImageViewer — raster (scope-guarded IPC read)", () => {
  it("reads the bytes through read_image_data_url and shows them", async () => {
    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,ZZZ");
    render(view({ path: "/w/shot.png", svgText: null }));

    // Nothing to show until the read lands — never the previous tab's picture.
    expect(screen.getByTestId("image-placeholder")).toHaveTextContent("Loading");

    await waitFor(() => expect(img()).toHaveAttribute("src", "data:image/png;base64,ZZZ"));
    expect(workspaceIpc.readImageDataUrl).toHaveBeenCalledWith("/w/shot.png");
    expect(img()).toHaveAttribute("alt", "shot.png");
  });

  it("renders a rejection as a calm inline note — never a crash", async () => {
    // Rust's own words: `image too large`, `unsupported image type`, `path is
    // outside the allowed workspace roots`. They are already user-facing prose,
    // so the message IS the note.
    workspaceIpc.readImageDataUrl.mockRejectedValue("image too large");
    render(view({ path: "/w/huge.png", svgText: null }));

    const note = await screen.findByTestId("image-error");
    expect(note).toHaveTextContent("image too large");
    expect(note).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("image-img")).toBeNull();
  });

  it("unwraps an Error, and stringifies anything else", async () => {
    workspaceIpc.readImageDataUrl.mockRejectedValue(new Error("unsupported image type"));
    const first = render(view({ path: "/w/a.png", svgText: null }));
    expect(await screen.findByTestId("image-error")).toHaveTextContent("unsupported image type");
    first.unmount();

    // Neither a string nor an Error — a bare rejection value still has to read
    // as one calm line rather than as nothing at all.
    workspaceIpc.readImageDataUrl.mockRejectedValue({ toString: () => "odd rejection" });
    render(view({ path: "/w/b.png", svgText: null }));
    expect(await screen.findByTestId("image-error")).toHaveTextContent("odd rejection");
  });

  it("drops the previous file's picture the moment the path moves on", async () => {
    // The result is TAGGED with the path it was read for. Without that tag the
    // settled state for `a.png` would still be on screen — under `b.png`'s name
    // — for the length of the next read, which on a 10 MiB file is visible.
    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,AAA");
    const { rerender } = render(view({ path: "/w/a.png", svgText: null }));
    await waitFor(() => expect(img()).toHaveAttribute("src", "data:image/png;base64,AAA"));

    const slow = deferred();
    workspaceIpc.readImageDataUrl.mockReturnValue(slow.promise);
    rerender(view({ path: "/w/b.png", svgText: null }));

    expect(screen.queryByTestId("image-img")).toBeNull();
    expect(screen.getByTestId("image-placeholder")).toHaveTextContent("Loading");

    slow.resolve("data:image/png;base64,BBB");
    await waitFor(() => expect(img()).toHaveAttribute("src", "data:image/png;base64,BBB"));
  });

  it("a slow read for a file you have already left cannot blank the picture you are on", async () => {
    // The `stale` guard, and the one ordering where it is load-bearing: the read
    // for `a.png` is still in flight when the tab moves to `b.png` and `b.png`
    // finishes first. Without the guard the late result overwrites the settled
    // state with a record tagged `a.png`, the path tag then rejects it, and the
    // picture the user is looking at is replaced by "Loading…" out of nowhere.
    const slowA = deferred();
    workspaceIpc.readImageDataUrl.mockReturnValue(slowA.promise);
    const { rerender } = render(view({ path: "/w/a.png", svgText: null }));

    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,BBB");
    rerender(view({ path: "/w/b.png", svgText: null }));
    await waitFor(() => expect(img()).toHaveAttribute("src", "data:image/png;base64,BBB"));

    // `act` is load-bearing, not decoration: a bare `await Promise.resolve()`
    // lets the promise settle but does NOT flush the re-render React would
    // schedule if the guard were missing — which made the first draft of this
    // test pass against the mutant. Verified by mutation.
    await act(async () => {
      slowA.resolve("data:image/png;base64,AAA");
    });

    expect(img()).toHaveAttribute("src", "data:image/png;base64,BBB");
  });

  it("…and a late REJECTION for that file cannot put an error note over it either", async () => {
    // The same guard on the other arm of the `then`. This is the likelier of the
    // two in the field: the reads that take long enough to be overtaken are the
    // ones that end in "image too large".
    const slowA = deferred();
    workspaceIpc.readImageDataUrl.mockReturnValue(slowA.promise);
    const { rerender } = render(view({ path: "/w/a.png", svgText: null }));

    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,BBB");
    rerender(view({ path: "/w/b.png", svgText: null }));
    await waitFor(() => expect(img()).toHaveAttribute("src", "data:image/png;base64,BBB"));

    await act(async () => {
      slowA.reject("image too large");
    });

    expect(screen.queryByTestId("image-error")).toBeNull();
    expect(img()).toHaveAttribute("src", "data:image/png;base64,BBB");
  });

  it("a read that lands after unmount touches nothing", async () => {
    // Weaker than the case above ON PURPOSE, and honest about why: React 19
    // silently ignores a setState on an unmounted component, so the only claim
    // available here is that the late settlement is inert — no throw, no
    // resurrection. The falsifiable half of the guard is the test above.
    const slow = deferred();
    workspaceIpc.readImageDataUrl.mockReturnValue(slow.promise);
    const { unmount } = render(view({ path: "/w/a.png", svgText: null }));

    unmount();
    await act(async () => {
      slow.resolve("data:image/png;base64,LATE");
    });

    expect(screen.queryByTestId("image-img")).toBeNull();
  });
});

describe("ImageViewer — natural size (the second half of the zoom contract)", () => {
  it("pins the decoded intrinsic width, in a unit the zoom can move", () => {
    render(view({ svgText: "<svg/>" }));
    // Before the first load there is nothing to pin and nothing to fall back to.
    expect(img().style.width).toBe("");
    expect(img().className).toBe("image-viewer__img");

    fireLoad(320);

    expect(img().style.width).toBe("320px");
    expect(img().className).toBe("image-viewer__img");
  });

  it("falls back to fit-to-the-pane when the image reports NO intrinsic size", () => {
    // An `<img>` whose source has no intrinsic size is stretched to its
    // containing block by the engine — a percentage-shaped width, and therefore
    // inert under `zoom`. `0` must never be pinned either, or the
    // picture collapses to nothing; the fallback is the `--scalable` rule, whose
    // width is `calc(100% * var(--img-zoom))` and does magnify.
    render(view({ svgText: "<svg/>" }));
    fireLoad(0);

    expect(img().className).toContain("image-viewer__img--scalable");
    expect(img().style.width).toBe("");
  });
});

describe("ImageViewer — zoom (ctrl/cmd+wheel)", () => {
  it("renders the zoom prop as CSS zoom and publishes it to CSS", () => {
    const { rerender } = render(view({ svgText: "<svg/>", zoom: 2 }));
    const stage = screen.getByTestId("image-stage");

    // 🔴 CSS `zoom`, never `transform: scale`: a layout property, so
    // the picture is re-painted at size instead of stretched from a 1× raster.
    expect(stage.style.zoom).toBe("2");
    // …and the same number published to CSS, because the fit-the-pane ceiling
    // has to be written `calc(100% * var(--img-zoom))` to survive the zoom at
    // all. Without this the buttons move the % label and nothing else.
    expect(stage.style.getPropertyValue("--img-zoom")).toBe("2");
    expect(stage.style.transform).toBe("");

    rerender(view({ svgText: "<svg/>", zoom: 1 }));
    expect(screen.getByTestId("image-stage").style.zoom).toBe("1");
  });

  it("ctrl+wheel reports the next zoom, eats the event, and anchors the scroll", () => {
    const onZoomChange = vi.fn();
    const { rerender } = render(view({ svgText: "<svg/>", zoom: 1, onZoomChange }));
    const el = container();
    stubScroll(el);

    const evt = wheel(el, { ctrlKey: true, deltaY: -100, clientX: 120, clientY: 80 });
    const next = wheelPreviewZoom(1, -100, 0);

    expect(onZoomChange).toHaveBeenCalledWith(next);
    expect(evt.defaultPrevented).toBe(true); // or the webview pinch-zooms the UI
    // Fully controlled: nothing moves until the parent commits the new zoom.
    expect(el.scrollLeft).toBe(0);

    rerender(view({ svgText: "<svg/>", zoom: next, onZoomChange }));

    // jsdom rects are 0×0, so the unscaled cursor offset is clientX/zoom — the
    // stubScroll caveat applies: this pins the arithmetic, not real geometry.
    expect(el.scrollLeft).toBe(anchorScrollDelta(120 / 1, 1, next));
    expect(el.scrollTop).toBe(anchorScrollDelta(80 / 1, 1, next));
  });

  it("meta+wheel zooms too (the house ctrl-or-meta idiom)", () => {
    const onZoomChange = vi.fn();
    render(view({ svgText: "<svg/>", zoom: 1, onZoomChange }));

    wheel(container(), { metaKey: true, deltaY: 100 });

    expect(onZoomChange).toHaveBeenCalledWith(wheelPreviewZoom(1, 100, 0));
  });

  it("a plain wheel is left entirely alone (ordinary scrolling)", () => {
    const onZoomChange = vi.fn();
    render(view({ svgText: "<svg/>", zoom: 1, onZoomChange }));

    const evt = wheel(container(), { deltaY: -100 });

    expect(onZoomChange).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  it("at the clamp rail it stays silent but STILL eats the event", () => {
    const onZoomChange = vi.fn();
    render(view({ svgText: "<svg/>", zoom: 4, onZoomChange })); // 4 = PREVIEW_ZOOM_MAX

    const evt = wheel(container(), { ctrlKey: true, deltaY: -100 });

    expect(onZoomChange).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(true);
  });

  it("zooming the placeholder state changes the zoom but has no picture to anchor", () => {
    const onZoomChange = vi.fn();
    const { rerender } = render(view({ svgText: "", zoom: 1, onZoomChange }));
    const el = container();
    stubScroll(el);

    const next = wheelPreviewZoom(1, -100, 0);
    wheel(el, { ctrlKey: true, deltaY: -100, clientX: 120, clientY: 80 });
    expect(onZoomChange).toHaveBeenCalledWith(next);

    // No stage exists → no anchor was queued → the scroll is untouched.
    rerender(view({ svgText: "", zoom: next, onZoomChange }));
    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
  });

  it("a zoom change with no gesture behind it (the −/+ buttons) leaves scroll alone", () => {
    const { rerender } = render(view({ svgText: "<svg/>", zoom: 1 }));
    const el = container();
    stubScroll(el);

    rerender(view({ svgText: "<svg/>", zoom: 2 }));

    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
  });
});

describe("ImageViewer — Fit", () => {
  it("measures the picture and the pane's CONTENT box and reports fitPreviewZoom", () => {
    const onZoomChange = vi.fn();
    render(view({ svgText: "<svg/>", zoom: 2, onZoomChange }));
    stubFitGeometry({
      client: { width: 600, height: 400 },
      padding: 16,
      picture: { width: 1200, height: 900 },
    });

    fireEvent.click(screen.getByTestId("image-fit"));

    // The padding has to come off the client box by hand, or the picture is
    // fitted to a pane 32px bigger than the space it can actually occupy.
    const expected = fitPreviewZoom(
      2,
      { width: 1200, height: 900 },
      { width: 568, height: 368 },
    );
    expect(onZoomChange).toHaveBeenCalledWith(expected);
    expect(expected).toBeLessThan(2); // a picture larger than the pane zooms OUT
  });

  it("does not churn the store when the picture is already fitted", () => {
    const onZoomChange = vi.fn();
    render(view({ svgText: "<svg/>", zoom: 1, onZoomChange }));
    // Exactly the pane's content box on both axes → ratio 1 → the same zoom.
    stubFitGeometry({
      client: { width: 600, height: 400 },
      padding: 16,
      picture: { width: 568, height: 368 },
    });

    fireEvent.click(screen.getByTestId("image-fit"));

    expect(onZoomChange).not.toHaveBeenCalled();
  });
});

describe("ImageViewer — pan (ctrl/cmd+drag)", () => {
  it("ctrl+drag scrolls against the cursor (grab semantics) and ends on pointerup", () => {
    render(view({ svgText: "<svg/>" }));
    const el = container();
    stubScroll(el);

    fireEvent.pointerDown(el, { ctrlKey: true, button: 0, clientX: 100, clientY: 100 });
    expect(document.body.classList.contains("is-panning")).toBe(true);

    // Cursor moves 40 left / 20 up → content follows → scroll grows by 40/20.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, clientY: 80, bubbles: true }));
    expect(el.scrollLeft).toBe(40);
    expect(el.scrollTop).toBe(20);

    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(document.body.classList.contains("is-panning")).toBe(false);
    // The listeners went with the class — further moves change nothing.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0, clientY: 0, bubbles: true }));
    expect(el.scrollLeft).toBe(40);
    expect(el.scrollTop).toBe(20);
  });

  it("meta+drag pans too", () => {
    render(view({ svgText: "<svg/>" }));
    const el = container();
    stubScroll(el);

    fireEvent.pointerDown(el, { metaKey: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0, clientY: 5, bubbles: true }));

    expect(el.scrollLeft).toBe(10);
    expect(el.scrollTop).toBe(5);
  });

  it("a plain drag does not pan (a bare drag still selects / does nothing)", () => {
    render(view({ svgText: "<svg/>" }));
    const el = container();
    stubScroll(el);

    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });

    expect(document.body.classList.contains("is-panning")).toBe(false);
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, clientY: 80, bubbles: true }));
    expect(el.scrollLeft).toBe(0);
  });

  it("a non-primary button does not pan even with the modifier held", () => {
    render(view({ svgText: "<svg/>" }));
    const el = container();
    stubScroll(el);

    fireEvent.pointerDown(el, { ctrlKey: true, button: 1, clientX: 100, clientY: 100 });

    expect(document.body.classList.contains("is-panning")).toBe(false);
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, clientY: 80, bubbles: true }));
    expect(el.scrollLeft).toBe(0);
  });
});
