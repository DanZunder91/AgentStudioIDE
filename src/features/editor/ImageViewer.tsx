/**
 * ImageViewer — the rendered view for an image tab (a view for .jpg, .png and
 * .svg files).
 *
 * Two sources, one picture:
 *   - **SVG** — the one image format that is also text. `CodeEditor` hands the
 *     LIVE CodeMirror buffer in `svgText`, so the drawing follows the source as
 *     the user types in the Source view. No IPC at all on this path.
 *   - **raster** (`.png`/`.jpg`/`.gif`/…) — there is no buffer (`read_file`
 *     rejects binary), so the bytes come from the scope-guarded
 *     `read_image_data_url` command, which caps at 10 MiB and returns a `data:`
 *     URL. A rejection renders a calm inline note, never a crash.
 *
 * 🔴 **The picture is ALWAYS an `<img>`.** Never `dangerouslySetInnerHTML`,
 * never a real inline `<svg>`, never `<object>`/`<embed>`/`<iframe>`. This is
 * load-bearing security, not style: an SVG rendered in *image context* runs in
 * the secure processing mode — no scripts, no event handlers, no external
 * fetches — while the same bytes inlined into the document execute their
 * `<script>` / `onload=` with **Tauri IPC in scope**, which in this app reaches
 * `terminal_write` and therefore the user's shell. `fs_tree.rs`'s `image_mime`
 * doc comment states that contract ("an SVG served here is inert"); it is true
 * only because of this sink. Any change that stops routing through `<img>`
 * turns an untrusted repo file into code execution.
 *
 * Zoom is fully controlled (the −/%/+ cluster lives in `CodeEditor`'s header)
 * and all of its math is `previewZoom.ts`, shared verbatim with the markdown
 * preview — one implementation, so the two surfaces cannot disagree.
 *
 * 🔴 The magnification is CSS **`zoom`**, never `transform: scale`:
 * `transform` blows up a raster painted at 1×, `zoom` re-lays-out
 * and re-paints, so an SVG stays vector-sharp and a photo uses every device
 * pixel it has. The consequence lives in `imageViewer.css`: under `zoom: Z` the
 * stage measures `W/Z` CSS px, so a plain `max-width: 100%` resolves back to
 * exactly `W` device px at EVERY zoom — the buttons would move the number and
 * not the picture. The ceiling is written `calc(100% * var(--img-zoom))`, which
 * is why this component publishes `--img-zoom` beside the inline `zoom`.
 *
 * Not handled on purpose: an `<img>` `error` (half-typed SVG markup mid-edit).
 * The browser's own broken-image state is self-explanatory and transient — it
 * repairs itself on the next keystroke that parses — and an overlay note would
 * flash on nearly every character.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { readImageDataUrl } from "../workspace/workspaceIpc";
import { anchorScrollDelta, fitPreviewZoom, wheelPreviewZoom } from "./previewZoom";
import "./imageViewer.css";

/**
 * The `data:` URL for SVG source, or null when there is nothing to draw yet (a
 * newly created `.svg` is an empty buffer, and an empty data URL renders as a
 * broken image rather than as "empty").
 *
 * 🔴 `encodeURIComponent`, NEVER `btoa`: `btoa` throws on any codepoint > 255,
 * so one accented or CJK `<text>` element in a diagram would crash the viewer.
 */
function svgDataUrl(svg: string): string | null {
  if (svg.trim() === "") return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The file's basename — the `<img>`'s alt text. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * A rejected `read_image_data_url` as one calm line. Rust already returns short
 * human strings ("image too large", "unsupported image type", "path is outside
 * the allowed workspace roots"), so the message IS the note — same shape as
 * `blameErrorNote`, which maps because git's stderr is not user-facing prose.
 */
function imageErrorNote(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

export function ImageViewer({
  path,
  svgText,
  zoom,
  onZoomChange,
}: {
  path: string;
  /** The live SVG source, or null for a raster image (fetched over IPC). */
  svgText: string | null;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}): React.JSX.Element {
  const isSvg = svgText !== null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** A cursor-anchored scroll adjustment, applied after the new zoom lays out. */
  const pendingScrollRef = useRef<{ dx: number; dy: number } | null>(null);

  /** The settled raster read, TAGGED with the path it was made for — see below. */
  const [raster, setRaster] = useState<{
    path: string;
    url: string | null;
    error: string | null;
  } | null>(null);
  /**
   * The decoded image's intrinsic width in CSS px: `null` until the first
   * `load`, `0` for an image that reports none. See `onLoad`.
   */
  const [natural, setNatural] = useState<number | null>(null);

  // The raster fetch. Race-guarded with the `stale` idiom used by CodeEditor's
  // blame effect: the tab can be closed — or re-pointed at another file — while
  // a 10 MiB read is in flight, and the loser of that race must not paint.
  useEffect(() => {
    if (isSvg) return; // SVG draws from the buffer; no IPC exists on that path
    let stale = false;
    readImageDataUrl(path).then(
      (url) => {
        if (!stale) setRaster({ path, url, error: null });
      },
      (err: unknown) => {
        if (!stale) setRaster({ path, url: null, error: imageErrorNote(err) });
      },
    );
    return () => {
      stale = true;
    };
  }, [path, isSvg]);

  // Only THIS path's result counts. Tagging the result and filtering here — as
  // opposed to clearing the state when the effect re-runs — is what keeps the
  // previous file's picture from being shown under the new tab's name for the
  // length of a 10 MiB read, without a synchronous setState in an effect body
  // (which is a cascading render, and which the lint rule rejects outright).
  const settled = raster !== null && raster.path === path ? raster : null;
  const error = settled?.error ?? null;

  const src = svgText === null ? (settled?.url ?? null) : svgDataUrl(svgText);

  /**
   * Intrinsic size, read off the decoded image — no Rust round-trip and no
   * image-decoding dependency; the browser already parsed the bytes.
   *
   * 🔴 This is not bookkeeping, it is the second half of the zoom contract. An
   * `<img>` whose source has NO intrinsic size — an SVG carrying only a
   * `viewBox`, which is most icon-set SVGs — is not laid out at some natural
   * size: the engine **stretches it to the containing block**. That width is a
   * percentage-shaped answer, so it is inert under `zoom` (only a layout
   * property magnifies a document): measured in Chromium, such an SVG rendered 568px wide
   * in a 568px pane at 100% *and 568px at 200%*. The picture would not move
   * while the % label did.
   *
   * So the width is PINNED to the intrinsic width in CSS px (the
   * `sizeDiagramForZoom` precedent), which the `calc(100% * var(--img-zoom))`
   * ceiling then caps — both units the zoom can move.
   *
   * `naturalWidth` reports 0 when the engine has no answer at all (the two
   * dimensions are 0 together — an image cannot have one intrinsic dimension and
   * not the other, so reading the width reads both). Chromium answers with the
   * CSS default-sizing box instead (200×150 for a 4:3 viewBox, i.e. 300×150
   * fitted to the ratio); WebKit — which is what the app actually runs on — is
   * entitled to answer 0, and 0 must never be pinned or the picture would
   * collapse to nothing. That case takes the documented fallback: FIT TO THE
   * PANE (`--scalable` below), which is the one answer that is right at every
   * pane width, written in the same zoom-movable unit so it still magnifies.
   */
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    setNatural(e.currentTarget.naturalWidth);
  };

  // Ctrl/cmd+wheel zooms, anchored at the cursor. React's onWheel cannot
  // preventDefault (its root listener is passive), so this is a native
  // non-passive listener; resubscribing per zoom change keeps `zoom` fresh.
  useEffect(() => {
    const el = containerRef.current as HTMLDivElement; // the outer div always renders
    const onWheel = (e: WheelEvent): void => {
      // macOS trackpad pinch arrives as wheel+ctrlKey; meta is accepted too.
      if (!(e.ctrlKey || e.metaKey)) return; // normal scrolling untouched
      e.preventDefault(); // eat the webview's own pinch-zoom even at the clamp rail
      const next = wheelPreviewZoom(zoom, e.deltaY, e.deltaMode);
      if (next === zoom) return;
      // Keep the point under the cursor stationary across the change.
      const stage = stageRef.current; // null while loading / on an error note
      if (stage) {
        const rect = stage.getBoundingClientRect();
        pendingScrollRef.current = {
          dx: anchorScrollDelta((e.clientX - rect.left) / zoom, zoom, next),
          dy: anchorScrollDelta((e.clientY - rect.top) / zoom, zoom, next),
        };
      }
      onZoomChange(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, onZoomChange]);

  // Apply the anchor scroll AFTER the new zoom has been laid out — earlier and
  // it would clamp against the old scrollable bounds. A button-driven zoom
  // change arrives with no pending anchor and leaves the scroll untouched.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    const el = containerRef.current as HTMLDivElement; // rendered whenever this runs
    el.scrollLeft += pending.dx;
    el.scrollTop += pending.dy;
  }, [zoom]);

  /**
   * Fit — 50% at some times and 200% at others, for a picture.
   *
   * Measured at click time in device pixels: the image's own rect, and the
   * pane's CONTENT box (`clientWidth` already excludes a scrollbar; the padding
   * has to come off by hand or the image is fitted to a box wider than the space
   * it can occupy). `fitPreviewZoom` turns the two into the next zoom, and
   * returns the current one unchanged if anything measures zero.
   *
   * 🔴 The input is the RENDERED RECT, not `naturalWidth`/`naturalHeight`, and
   * that is not an accident: the stylesheet caps a big image at the pane
   * (`max-width: calc(100% * var(--img-zoom))`), so a 2400px photo is already
   * drawn at 600px at 100%. An absolute `pane / natural` fit would compute 25%
   * and land the picture at 150px — a quarter of the size it started. What
   * `fitPreviewZoom` documents, and what is true here, is that the on-screen
   * size is exactly LINEAR in the zoom, so scaling the CURRENT zoom by the ratio
   * the picture is currently off by lands on the fit precisely, capped or not.
   */
  const onFit = (): void => {
    const el = containerRef.current as HTMLDivElement; // both render together
    const img = imgRef.current as HTMLImageElement; // (the button lives beside it)
    const style = getComputedStyle(el);
    const pane = {
      width: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
    const next = fitPreviewZoom(zoom, img.getBoundingClientRect(), pane);
    if (next === zoom) return; // already fitted — do not churn the store
    onZoomChange(next);
  };

  // Ctrl/cmd+drag pans by scrolling the container — works at any zoom. Same
  // globalized-drag pattern as MarkdownPreview and RailResizer: window-level
  // move/up listeners (not pointer capture) so the drag tracks outside the
  // element, and a body class so the CSS can kill text selection and hold the
  // grabbing cursor everywhere.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const startScrollLeft = el.scrollLeft;
    const startScrollTop = el.scrollTop;

    document.body.classList.add("is-panning");

    const onMove = (ev: PointerEvent | MouseEvent): void => {
      // Content follows the cursor (grab semantics): drag left → scroll right.
      el.scrollLeft = startScrollLeft - (ev.clientX - startX);
      el.scrollTop = startScrollTop - (ev.clientY - startY);
    };
    const onUp = (): void => {
      document.body.classList.remove("is-panning");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={containerRef}
      className="image-viewer"
      data-testid="image-viewer"
      onPointerDown={onPointerDown}
    >
      {error !== null ? (
        <div className="image-viewer__note image-viewer__note--error" role="alert" data-testid="image-error">
          {error}
        </div>
      ) : src === null ? (
        <div className="image-viewer__note" data-testid="image-placeholder">
          {svgText === null ? "Loading…" : "Nothing to preview."}
        </div>
      ) : (
        <div
          ref={stageRef}
          className="image-viewer__stage"
          data-testid="image-stage"
          // `zoom` is the magnification (a LAYOUT property — see the header);
          // `--img-zoom` publishes the same number to CSS so the image's
          // fit-the-pane ceiling can be written in a unit the zoom can move.
          style={{ zoom, "--img-zoom": zoom } as React.CSSProperties}
        >
          {/* 🔴 The one and only sink for image bytes. See the header. */}
          <img
            ref={imgRef}
            className={`image-viewer__img${natural === 0 ? " image-viewer__img--scalable" : ""}`}
            data-testid="image-img"
            src={src}
            alt={fileName(path)}
            // Natural size at 100%, in a unit the zoom can move. `undefined`
            // before the first load (and for the no-intrinsic-size fallback,
            // which the class above sizes instead) — see `onLoad`.
            style={natural ? { width: natural } : undefined}
            onLoad={onLoad}
          />
          <button
            type="button"
            className="image-viewer__fit"
            data-testid="image-fit"
            title="Fit the image to the pane"
            onClick={onFit}
          >
            Fit
          </button>
        </div>
      )}
    </div>
  );
}
