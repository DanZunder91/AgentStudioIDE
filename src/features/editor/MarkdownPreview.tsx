/** Markdown preview. Raw HTML (`html: true`) goes through DOMPurify and mermaid runs `strict`:
 * Tauri IPC is in scope. Hydration mutates the injected subtree, so `htmlProp` must keep a stable
 * identity. Zoom is CSS `zoom` (sharp re-layout); find state lives in the store (`findBars`). */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";
import DOMPurify from "dompurify";
import mermaid from "mermaid";

import { useAppStore, type FindBarState } from "../../app/store";
import { isAbsolutePath, isWindowsPath, joinPath } from "../../lib/paths";
import { readImageDataUrl } from "../workspace/workspaceIpc";
import { urlOpen } from "../git/gitIpc";
import { listMatches } from "./find/findModel";
import { domSelectionSeed } from "./find/selectionSeed";
import { PreviewFindBar } from "./PreviewFindBar";
import {
  FIND_HIGHLIGHT,
  PREVIEW_CHROME_ATTR,
  clearHighlights,
  isEditableTarget,
  isPreviewFindShortcut,
  ownsGlobalFind,
  paintHighlights,
  rangesForMatches,
  scrollRangeIntoView,
  textIndex,
} from "./previewFind";
import { anchorScrollDelta, fitPreviewZoom, wheelPreviewZoom } from "./previewZoom";
import "./markdownPreview.css";
import "./previewFind.css";

/** Class marking a mermaid block in the rendered HTML (queried after mount). */
const MERMAID_CLASS = "markdown-preview__mermaid";
/** Added once a block holds real SVG — also half the "already hydrated" guard. */
const RENDERED_CLASS = "markdown-preview__mermaid--rendered";
/** Marks a block replaced by the error note, so hydration never feeds the note's text back to
 * mermaid. Not `RENDERED_CLASS`, which is also a style hook that would strip the note's frame. */
const ERROR_CLASS = "markdown-preview__mermaid--error";
/** Fit control marker; clicks are delegated from the container. Defined in previewFind.ts so the
 * text index can skip it without importing this component. */
const FIT_ATTR = PREVIEW_CHROME_ATTR;

/** Shared instance; the only per-render input, `basePath`, goes through the render `env`. */
const md = createMarkdownIt();

function createMarkdownIt(): MarkdownIt {
  const instance = new MarkdownIt({
    html: true, // render raw HTML (READMEs use it) — sanitised by DOMPurify downstream
    linkify: true, // autolink bare URLs
    breaks: false, // GitHub-style: a lone newline is not a <br>
  });

  // ── mermaid fence: turn ```mermaid blocks into a container we hydrate later ──
  const defaultFence = instance.renderer.rules.fence as RenderRule;
  instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0];
    if (lang === "mermaid") {
      // The raw diagram source is escaped into the element's text content; the
      // effect reads it back via `textContent` and swaps in the rendered SVG.
      return `<pre class="${MERMAID_CLASS}" data-testid="mermaid-block">${instance.utils.escapeHtml(
        token.content,
      )}</pre>`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  // Images: resolve a relative `src` against `basePath`; local ones are inlined after mount.
  // Skipped under a Windows base: DOMPurify drops a `C:` src as an unknown scheme.
  const defaultImage = instance.renderer.rules.image as RenderRule;
  instance.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const base = (env as { basePath?: string } | undefined)?.basePath;
    if (base && !isWindowsPath(base)) {
      const src = token.attrGet("src") as string;
      if (isRelativePath(src)) {
        token.attrSet("src", joinPath(base, src));
      }
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  return instance;
}

/** DOMPurify defaults keep `data-*` and `class`, so the mermaid placeholder `<pre>` survives. */
function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty);
}

/** No scheme (including a drive's `C:`) and not absolute on either platform. */
function isRelativePath(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src) && !isAbsolutePath(src);
}

/* ─────────────────────────── mermaid hydration ─────────────────────────── */

/** Monotonic, deterministic id source for mermaid render targets (no Math.random). */
let mermaidSeq = 0;

/** Init is idempotent + global: mermaid holds one config, so we set it once. */
let mermaidInitialized = false;
function initMermaid(): void {
  if (mermaidInitialized) return;
  mermaidInitialized = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    // Without it a failed parse strands mermaid's error graphic in a temp div on document.body (its
    // cleanup sits after the throw). With it, cleanup runs on both failure branches; it is in
    // mermaid's `secure` list, so a `%%{init}%%` directive cannot switch it off.
    suppressErrorRendering: true,
  });
}

/** Sweeps the temp `d${id}` div mermaid may strand: ~20 lines of its `render()` are outside any
 * try/catch. Keyed on our id, never a broad selector that could stomp other DOM. */
async function renderDiagramSvg(id: string, source: string): Promise<string> {
  try {
    return (await mermaid.render(id, source)).svg;
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

/** mermaid's `useMaxWidth` (width 100%) can't scale under `zoom`, so pin the natural width, drop
 * its inline `max-width`, and let markdownPreview.css cap at `calc(100% * var(--mdp-zoom))`. */
function sizeDiagramForZoom(svg: SVGElement): void {
  // Prefer mermaid's own number, then the viewBox; if neither parses, leave the
  // element exactly as mermaid built it (fit-to-pane) rather than guessing.
  const fromStyle = /max-width:\s*([\d.]+)px/.exec(svg.getAttribute("style") ?? "")?.[1];
  const fromViewBox = svg.getAttribute("viewBox")?.trim().split(/\s+/)[2];
  const width = Number(fromStyle ?? fromViewBox);
  if (!Number.isFinite(width) || width <= 0) return;
  svg.style.maxWidth = ""; // drop mermaid's inline clamp; the stylesheet owns it
  svg.style.width = `${width}px`;
  svg.style.height = "auto";
}

/** Built imperatively (the diagram is `innerHTML`, not React) and with no click handler: the
 * container's delegated listener finds it, so no closure can capture a stale `zoom`. */
function addFitControl(el: HTMLElement): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "markdown-preview__fit";
  btn.setAttribute(FIT_ATTR, "");
  btn.setAttribute("data-testid", "diagram-fit");
  btn.textContent = "Fit";
  btn.title = "Zoom the preview so this diagram fits the pane";
  btn.setAttribute("aria-label", "Fit diagram to pane");
  el.append(btn);
}

/* Mermaid parse failures: jison's `hash` is not a contract (a lexical error lacks `loc` and
 * `expected`, a draw error has no `hash`), so every field is read defensively. */

/** How many `expected` tokens to name before summarising the rest. */
const MAX_EXPECTED = 3;

interface MermaidErrorHash {
  token?: string | null;
  loc?: { first_line?: number };
  expected?: string[];
}

function errorHash(error: unknown): MermaidErrorHash | null {
  const hash = (error as { hash?: unknown } | null | undefined)?.hash;
  return typeof hash === "object" && hash !== null ? (hash as MermaidErrorHash) : null;
}

/** 1-based, relative to the fence body. Trust `hash.loc.first_line`, not `hash.line` (0-based in
 * some grammars, measured on 11.16.1); lexical errors have no `loc`, so parse the message. */
function diagramErrorLine(error: unknown): number | null {
  const first = errorHash(error)?.loc?.first_line;
  if (typeof first === "number" && Number.isFinite(first)) return first;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const matched = /error on line (\d+)/i.exec(message);
  return matched ? Number(matched[1]) : null;
}

/** The token the parser got and the ones it wanted, which a bare "Diagram error" never says. */
function diagramErrorDetail(error: unknown): string | null {
  const hash = errorHash(error);
  const token = hash?.token;
  if (typeof token !== "string" || token === "") return null;
  // jison quotes every entry ("'SOLID_ARROW'"); the quotes are noise here.
  const expected = (hash?.expected ?? []).map((name) => name.replace(/^'|'$/g, ""));
  if (expected.length === 0) return `Unexpected ${token}.`;
  const rest = expected.length - MAX_EXPECTED;
  const named = expected.slice(0, MAX_EXPECTED).join(", ");
  return `Unexpected ${token} — expected ${named}${rest > 0 ? ` (and ${rest} more)` : ""}.`;
}

/** `ERROR_CLASS` goes on FIRST so hydration never re-reads the note as source; the source stays
 * below so the line number has something to point at. */
function renderDiagramError(el: HTMLElement, source: string, error: unknown): void {
  el.classList.add(ERROR_CLASS);
  el.textContent = "";
  const line = diagramErrorLine(error);
  const note = document.createElement("div");
  note.className = "markdown-preview__diagram-error";
  note.textContent =
    line === null ? "Diagram error" : `Diagram error — line ${line} of the diagram`;
  el.append(note);
  const detail = diagramErrorDetail(error);
  if (detail !== null) {
    const why = document.createElement("div");
    // Styled by `.markdown-preview__diagram-detail` in markdownPreview.css.
    why.className = "markdown-preview__diagram-detail";
    why.textContent = detail;
    el.append(why);
  }
  const pre = document.createElement("pre");
  pre.className = "markdown-preview__diagram-source";
  pre.textContent = source;
  el.append(pre);
}

/* ──────────────────────────────── component ────────────────────────────── */

/** What an ABSENT `findBars` record means (see store.ts): closed, empty. */
const CLOSED_BAR: FindBarState = { open: false, query: "", cursor: 0 };

/** Links never navigate the app window, or a README could replace the IDE. `https:` opens via
 * `url_open`, `#anchors` scroll, the rest is dropped; Rust's `nav_guard` is the backstop.
 * Returns true when the click was a link. */
export function interceptLink(e: React.MouseEvent<HTMLElement>): boolean {
  const target = e.target as Element | null;
  const a = target?.closest?.("a");
  if (!a) return false;
  e.preventDefault();
  const href = (
    a.getAttribute("href") ??
    a.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
    ""
  ).trim();
  if (href.startsWith("#")) {
    const id = decodeURIComponent(href.slice(1));
    const root = e.currentTarget as HTMLElement;
    const dest = id ? root.querySelector(`[id="${CSS.escape(id)}"]`) : null;
    dest?.scrollIntoView?.({ block: "start" });
  } else if (/^https:\/\//i.test(href)) {
    void urlOpen(href).catch(() => undefined);
  }
  return true;
}

export function MarkdownPreview({
  text,
  path,
  basePath,
  zoom = 1,
  onZoomChange,
}: {
  text: string;
  /** Keys the find bar's store record so it survives tab moves; without it the bar is local. */
  path?: string;
  basePath?: string;
  /** Scale factor for the preview body (1 = 100%); callers clamp via clampPreviewZoom. */
  zoom?: number;
  /** Called with the next zoom when the user ctrl/cmd+scrolls the preview. */
  onZoomChange?: (zoom: number) => void;
}): React.JSX.Element {
  // Pure: the HTML is a function of (text, basePath); "" drives the empty state.
  const html = useMemo(
    () => (text.trim() ? sanitizeHtml(md.render(text, { basePath })) : ""),
    [text, basePath],
  );

  // Memoised on purpose: React 19 re-assigns `innerHTML` whenever this object is new, which would
  // wipe the post-mount hydration on any unrelated re-render.
  const htmlProp = useMemo(() => ({ __html: html }), [html]);

  // A stable boolean: `onZoomChange` is a fresh arrow each render and would re-run hydration.
  const isControlled = Boolean(onZoomChange);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Anchor adjustment computed by the wheel handler, applied by the layout
  // effect below once the new zoom has been laid out.
  const pendingScrollRef = useRef<{ dx: number; dy: number } | null>(null);
  // Diagram to bring into view once a Fit has been laid out (same deferral as
  // the anchor above: scrolling before the new zoom renders clamps against the
  // OLD bounds, so the diagram you just fitted lands off-screen).
  const pendingFitRef = useRef<HTMLElement | null>(null);

  /* ───────────────────────── find in the preview ─────────────────────────── */

  // In the store, keyed per file: `Pane` unmounts inactive tabs and a drag re-parents. An absent
  // record IS the closed state.
  const findKey = path === undefined ? null : `preview:${path}`;
  const storeBar = useAppStore((s) => (findKey === null ? undefined : s.findBars[findKey]));
  const patchFindBar = useAppStore((s) => s.uiActions.patchFindBar);
  const dropFindBar = useAppStore((s) => s.uiActions.dropFindBar);
  // Without `path` there is no key to survive under, so the bar stays instance-local.
  const [localBar, setLocalBar] = useState<FindBarState>(CLOSED_BAR);
  const bar = (findKey === null ? localBar : storeBar) ?? CLOSED_BAR;
  const { open: findOpen, query, cursor } = bar;

  const patchBar = useCallback(
    (patch: Partial<FindBarState>) => {
      if (findKey === null) setLocalBar((b) => ({ ...b, ...patch }));
      else patchFindBar(findKey, patch);
    },
    [findKey, patchFindBar],
  );
  // Esc/✕. DROPS the record rather than patching `{open:false}`: absence is
  // the closed state, so closing leaves no per-tab tombstone behind — and
  // reopening starts clean rather than restoring a stale query.
  const dropBar = useCallback(() => {
    if (findKey === null) setLocalBar(CLOSED_BAR);
    else dropFindBar(findKey);
  }, [findKey, dropFindBar]);

  /** State, not a ref: two queries can share a match count, so painting must key on the ranges.
   * Local on purpose: a Range dies with its fragment and is recomputed on every mount. */
  const [ranges, setRanges] = useState<Range[]>([]);
  /** Bumped on every Cmd/Ctrl+F so an already-open bar re-focuses its input.
   *  A transient, so local. */
  const [focusSignal, setFocusSignal] = useState(0);

  /** Seeds through the same `patchBar({ query })` as typing, so there is one query path; the
   * recompute effect derives the cursor, so re-seeding the same query keeps the user's place. */
  const openFind = useCallback(
    (seed: string | null) => {
      patchBar(seed === null ? { open: true } : { open: true, query: seed });
      setFocusSignal((n) => n + 1);
    },
    [patchBar],
  );

  /** The query `ranges` came from: a new query restarts the cursor, the same one re-indexed
   * (remount, source change) keeps it, clamped. Seeded with the mount-time query. */
  const rangesForQueryRef = useRef<string | null>(query);
  /** Lets the recompute effect and step handler read the cursor without depending on it. Declared
   * before the recompute effect so the mirror is fresh when both run in one commit. */
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // Keyed on `html` too, since re-injected HTML detaches old Ranges. Also the remount path: it
  // rebuilds the ranges from the stored query.
  useEffect(() => {
    const root = bodyRef.current;
    if (!findOpen || query === "" || root === null) {
      rangesForQueryRef.current = null;
      setRanges([]);
      // Guarded on `findOpen`: patching a DROPPED bar would recreate its store
      // record, and a closed bar's cursor is meaningless anyway.
      if (findOpen && cursorRef.current !== 0) patchBar({ cursor: 0 });
      return;
    }
    const index = textIndex(root);
    // The engine the editor's find bar and the API response search use, so the
    // three surfaces can never disagree about what "3/17" means.
    const matches = listMatches(
      { search: query, caseSensitive: false, wholeWord: false, regexp: false },
      index.text,
    );
    const next = rangesForMatches(index, matches);
    const queryChanged = rangesForQueryRef.current !== query;
    rangesForQueryRef.current = query;
    setRanges(next);
    // A NEW query restarts at the first match; the SAME query re-indexed keeps
    // the user's place, clamped so a document that shrank while the tab was
    // away cannot strand the cursor past the last match.
    const target = queryChanged
      ? 0
      : Math.min(cursorRef.current, Math.max(0, next.length - 1));
    if (target !== cursorRef.current) patchBar({ cursor: target });
  }, [html, query, findOpen, patchBar]);

  // Gated on `findOpen`: the highlight registry is document-global, so an empty paint would wipe
  // another split's matches. Cleanup touches only the registry; unmount is not Esc.
  useLayoutEffect(() => {
    if (!findOpen) return undefined;
    const current = ranges[cursor] ?? null;
    paintHighlights(FIND_HIGHLIGHT, ranges, current);
    scrollRangeIntoView(current);
    return () => clearHighlights(FIND_HIGHLIGHT);
  }, [ranges, cursor, findOpen]);

  const step = useCallback(
    (delta: number) => {
      if (ranges.length === 0) return; // nothing to walk — hold still
      patchBar({ cursor: (cursorRef.current + delta + ranges.length) % ranges.length });
    },
    [ranges.length, patchBar],
  );

  /** Cmd/Ctrl+F no focused surface claimed (focus is usually on a tree row or tab). Bubble phase
   * and skips handled events, so the terminal, CodeMirror and ResponseBody get first refusal. */
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return; // someone with focus already answered
      if (!isPreviewFindShortcut(e)) return;
      const el = containerRef.current;
      if (el === null || !ownsGlobalFind(el)) return;
      if (isEditableTarget(e.target, el)) return;
      e.preventDefault(); // never reaches WebKit's own window-wide find
      // Read the selection before focusing the input collapses it; `domSelectionSeed` ignores a
      // selection in another split.
      openFind(domSelectionSeed(el));
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [openFind]);

  /** Cmd/Ctrl+F opens the bar; Escape closes it. Scoped to this preview. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (isPreviewFindShortcut(e)) {
      // preventDefault so the key never escapes to WebKit's own find, which
      // would search the whole window instead of this document.
      e.preventDefault();
      // Synchronous, before the bar's focus effect collapses the selection.
      // The container always renders, so the ref is live inside its own keydown.
      openFind(domSelectionSeed(containerRef.current as HTMLDivElement));
      return;
    }
    if (e.key === "Escape" && findOpen) {
      e.preventDefault();
      dropBar();
    }
  };

  // Ctrl/cmd+wheel zooms, anchored at the cursor. React's onWheel cannot
  // preventDefault (the root listener is passive), so a native non-passive
  // listener is attached here; resubscribing per zoom change keeps `zoom` fresh.
  useEffect(() => {
    const el = containerRef.current as HTMLDivElement; // the outer div always renders
    const onWheel = (e: WheelEvent): void => {
      if (!onZoomChange) return; // uncontrolled: gestures fully inert
      // macOS trackpad pinch arrives as wheel+ctrlKey; meta is accepted too.
      if (!(e.ctrlKey || e.metaKey)) return; // normal scrolling untouched
      e.preventDefault(); // eat the webview's own pinch-zoom even at the clamp rail
      const next = wheelPreviewZoom(zoom, e.deltaY, e.deltaMode);
      if (next === zoom) return;
      // Keep the content point under the cursor stationary across the change.
      const body = bodyRef.current; // null in the empty state — nothing to anchor
      if (body) {
        const rect = body.getBoundingClientRect();
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
  // it would clamp against the old scrollable bounds. Button-driven zoom changes
  // arrive with no pending anchor and leave the scroll untouched.
  useLayoutEffect(() => {
    const fitted = pendingFitRef.current;
    if (fitted) {
      pendingFitRef.current = null;
      // `nearest` avoids yanking a visible diagram to the top. Optional call: jsdom has no
      // scrollIntoView.
      fitted.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    const el = containerRef.current as HTMLDivElement; // rendered whenever this runs
    el.scrollLeft += pending.dx;
    el.scrollTop += pending.dy;
  }, [zoom]);

  /** Delegated, reading this render's `zoom`, so it can never act on a stale one. Measured at click
   * time; the pane padding comes off by hand, and a zero size leaves the zoom unchanged. */
  const onFitClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (interceptLink(e)) return;
    if (!onZoomChange) return; // uncontrolled: no control was rendered either
    const target = e.target as HTMLElement;
    const button = target.closest(`[${FIT_ATTR}]`);
    if (!button) return; // an ordinary click in the preview
    const block = button.closest<HTMLElement>(`.${MERMAID_CLASS}`);
    const svg = block?.querySelector("svg");
    const el = containerRef.current;
    if (!block || !svg || !el) return;

    const style = getComputedStyle(el);
    const pane = {
      width:
        el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height:
        el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
    const next = fitPreviewZoom(zoom, svg.getBoundingClientRect(), pane);
    if (next === zoom) return; // already fitted — do not churn the store
    pendingFitRef.current = block;
    onZoomChange(next);
  };

  // Ctrl/cmd+drag pans. Window-level move/up listeners (not pointer capture) track the drag
  // outside the element; a body class kills text selection and holds the cursor.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const startScrollLeft = el.scrollLeft;
    const startScrollTop = el.scrollTop;

    document.body.classList.add("is-panning");

    const onMove = (ev: PointerEvent | MouseEvent) => {
      // Content follows the cursor (grab semantics): drag left → scroll right.
      el.scrollLeft = startScrollLeft - (ev.clientX - startX);
      el.scrollTop = startScrollTop - (ev.clientY - startY);
    };
    const onUp = () => {
      document.body.classList.remove("is-panning");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Post-mount: hydrate any mermaid blocks to SVG. Async + race-guarded.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return; // empty state renders no body div
    const blocks = root.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}`);
    if (blocks.length === 0) return; // nothing to hydrate

    let cancelled = false;
    initMermaid();

    const run = async (): Promise<void> => {
      for (const el of Array.from(blocks)) {
        // Skip rendered or failed blocks: their `textContent` is the SVG or error note, not source.
        if (el.classList.contains(RENDERED_CLASS) || el.classList.contains(ERROR_CLASS)) {
          continue;
        }
        const source = el.textContent as string;
        const id = `mdp-mermaid-${mermaidSeq++}`;
        let svg: string | null;
        let failure: unknown;
        try {
          svg = await renderDiagramSvg(id, source);
        } catch (error) {
          svg = null;
          failure = error;
        }
        if (cancelled) return; // unmounted or source changed mid-flight
        if (svg === null) {
          renderDiagramError(el, source, failure);
        } else {
          el.innerHTML = svg;
          const rendered = el.querySelector("svg");
          if (rendered) sizeDiagramForZoom(rendered);
          el.classList.add(RENDERED_CLASS);
          if (isControlled) addFitControl(el); // uncontrolled: no zoom to set
        }
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [html, isControlled]);

  // Inline local images as data URLs via the scoped read; remote and inline srcs are untouched,
  // and a failed read leaves a broken image, never a crash.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return; // empty state renders no body div
    const imgs = root.querySelectorAll<HTMLImageElement>("img");
    if (imgs.length === 0) return; // nothing to inline

    let cancelled = false;
    const run = async (): Promise<void> => {
      for (const img of Array.from(imgs)) {
        let src = img.getAttribute("src");
        // Skip remote + already-inline srcs; only a local path needs the read.
        if (!src || /^(?:https?|data|blob|asset|file):/i.test(src)) continue;
        // A raw-HTML `<img>` (e.g. a `<p align><img src="./banner.gif">` README
        // banner) never passes through the markdown-it image rule, so its `src` is
        // still relative here — resolve it against the document dir before reading.
        if (basePath && isRelativePath(src)) src = joinPath(basePath, src);
        let url: string | null;
        try {
          url = await readImageDataUrl(src);
        } catch {
          url = null;
        }
        if (cancelled) return; // unmounted or source changed mid-flight
        if (url !== null) img.setAttribute("src", url);
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [html, basePath]);

  return (
    <div
      ref={containerRef}
      className="markdown-preview"
      data-testid="markdown-preview"
      // Focusable but not tabbable, so a click lands focus here and Cmd/Ctrl+F reaches onKeyDown.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onClick={onFitClick}
    >
      {findOpen && (
        <PreviewFindBar
          query={query}
          total={ranges.length}
          current={cursor + 1}
          focusSignal={focusSignal}
          onQueryChange={(q) => patchBar({ query: q })}
          onStep={step}
          onClose={dropBar}
        />
      )}
      {html === "" ? (
        <div className="markdown-preview__empty">Nothing to preview.</div>
      ) : (
        <div
          ref={bodyRef}
          className="markdown-preview__body"
          // Real layout, so it paints sharp. `--mdp-zoom` feeds the diagram ceiling's
          // `calc(100% * zoom)` (see sizeDiagramForZoom).
          style={{ zoom, "--mdp-zoom": zoom } as React.CSSProperties}
          // Safe: markdown-it runs with html:true, but everything is passed
          // through DOMPurify before landing here and markdown-it's
          // default validateLink blocks dangerous hrefs. See the file header.
          dangerouslySetInnerHTML={htmlProp}
        />
      )}
    </div>
  );
}
