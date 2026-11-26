/** The picture is ALWAYS an `<img>`, never inline SVG/object/iframe: an SVG in image context is
 * inert, but inlined it runs with Tauri IPC in scope (`terminal_write`, the shell). Zoom is CSS
 * `zoom`, not `transform`; `--img-zoom` feeds the size ceiling in `imageViewer.css`. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { readImageDataUrl } from "../workspace/workspaceIpc";
import { anchorScrollDelta, fitPreviewZoom, wheelPreviewZoom } from "./previewZoom";
import "./imageViewer.css";

/** null for an empty buffer (an empty data URL renders as broken). `encodeURIComponent`, NEVER
 * `btoa`, which throws on any codepoint > 255. */
function svgDataUrl(svg: string): string | null {
  if (svg.trim() === "") return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The file's basename — the `<img>`'s alt text. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** Rust already returns short human strings, so the message is the note. */
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
  /** Intrinsic width in CSS px: `null` until the first `load`, `0` when the image reports none. */
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

  // Filter by path tag rather than clearing state on re-run: no stale picture under the new tab's
  // name during a slow read, and no synchronous setState in an effect body (lint rejects it).
  const settled = raster !== null && raster.path === path ? raster : null;
  const error = settled?.error ?? null;

  const src = svgText === null ? (settled?.url ?? null) : svgDataUrl(svgText);

  /** Pins the width to the intrinsic width: an SVG with only a `viewBox` is otherwise stretched to
   * its container, which `zoom` cannot magnify. `0` (WebKit may report it) is never pinned; that
   * case falls back to the `--scalable` fit-to-pane rule. */
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

  /** Fits from the RENDERED rect, not natural size: the stylesheet already caps a big image at the
   * pane, and on-screen size is linear in zoom, so scaling the current zoom lands exactly. Padding
   * comes off the content box by hand (`clientWidth` excludes only the scrollbar). */
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

  // Ctrl/cmd+drag pans by scrolling. Window-level move/up listeners (not pointer capture) track
  // the drag outside the element; a body class kills text selection and holds the cursor.
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
