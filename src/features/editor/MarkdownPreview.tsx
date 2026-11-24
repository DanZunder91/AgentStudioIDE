/**
 * MarkdownPreview — a self-contained, pure React rendered-preview for Markdown.
 * Renders like GitHub / VS Code: headings, lists, GFM tables, blockquotes, inline + fenced code,
 * links, images — and ```mermaid fenced blocks as SVG diagrams.
 *
 * Safety posture (see the component contract):
 *   - markdown-it runs with `html: true` so real READMEs render like GitHub / VS
 *     Code — a raw `<p align="center"><img …></p>` banner shows the image, not the
 *     literal tag text. That raw HTML is then run through **DOMPurify** before it
 *     reaches `dangerouslySetInnerHTML`, which strips `<script>`, event handlers
 *     (`onerror`, `onclick`, …) and dangerous URIs. Rendering unsanitised HTML in
 *     an IDE that opens arbitrary repos — with Tauri IPC in scope — would be a real
 *     XSS hole; `html:false` (escape everything) closed it but broke every README
 *     that uses HTML. Sanitising is the standard middle path: render the safe
 *     subset, drop the dangerous parts. markdown-it's default `validateLink` also
 *     blocks `javascript:` / `vbscript:` / risky `data:` hrefs.
 *   - Mermaid is initialised with `securityLevel: "strict"`, so diagram SVG is
 *     sanitised before it lands in the DOM — and with `suppressErrorRendering`,
 *     without which a diagram that fails to parse leaves mermaid's red "Syntax
 *     error in text" graphic stranded on `document.body`, outside React, one
 *     per failed render, until the app is restarted. See `initMermaid`.
 *
 * Markdown rendering is pure + synchronous (a `useMemo` over the source). Only
 * mermaid is a post-mount concern: its `render()` is async, so it runs in a
 * `useEffect` after the HTML mounts, guarded by a `cancelled` flag against
 * unmount / source-change races. A mermaid parse error renders a calm inline
 * note beside the offending source — it NEVER throws or blanks the preview.
 * Because those effects MUTATE the injected subtree, the value handed to
 * `dangerouslySetInnerHTML` must keep a stable identity across re-renders — see
 * the comment on `htmlProp`; an inline object silently un-hydrates the preview.
 *
 * Zoom is fully controlled and uses CSS **`zoom`**, not `transform: scale`.
 * That is the whole difference between a magnified screenshot and a magnified
 * document: `transform` scales the RASTER (the compositor blows up a bitmap
 * painted at 1×, so text and diagram strokes go soft — a distorted
 * picture at 400%), while `zoom` is a layout property, so
 * the browser re-lays-out and re-paints at the target size and every glyph and
 * vector edge is sharp at any level. Prose also re-wraps to the pane instead of
 * running off the right edge. ctrl/cmd+wheel reports the next zoom through
 * `onZoomChange` (anchored at the cursor by a deferred scroll adjustment), and
 * ctrl/cmd+drag pans by scrolling the container. All math is in previewZoom.ts
 * and is unchanged by the switch: `getBoundingClientRect()` on a zoomed element
 * already reports zoomed pixels, so `(clientX - rect.left) / zoom` is still the
 * content coordinate under the cursor.
 *
 * Cmd/Ctrl+F searches the RENDERED text. The matches are
 * painted with the CSS Custom Highlight API over live `Range`s rather than by
 * injecting `<mark>`s — see previewFind.ts's header for the two reasons that is
 * not negotiable, one of which is that a `<mark>` inside an un-hydrated
 * ```mermaid block would be fed to `mermaid.render` as diagram source and turn
 * a search into a *"Diagram error"*. If text is selected when the shortcut
 * fires, the bar opens SEEDED with it and searching —
 * the rule is `find/selectionSeed`, shared with the editor's own bar.
 *
 * The bar's open/query/cursor live in the STORE (`findBars`, keyed
 * `preview:${path}`), not in component state (bug: the bar vanished on every
 * tab move). `Pane` unmounts inactive tabs and a cross-pane
 * drag re-parents the subtree, so nothing `useState`-owned can outlive either —
 * the same reason `previewZoom` is store-kept per path (see CodeEditor.tsx).
 * The `ranges` and `focusSignal` deliberately STAY local: a `Range` dies with
 * the document fragment it points into, so it cannot survive an unmount and is
 * recomputed from the stored query on every mount, and the focus signal is a
 * transient. Esc/✕ DROP the store record (absence is the closed state); a
 * plain unmount leaves it alone — unmount is not Esc.
 */

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
/**
 * Added once a block has been REPLACED by the inline parse-error note — the
 * other half of that guard, and it has to exist for the same reason
 * `RENDERED_CLASS` does: the hydration pass reads its input from
 * `el.textContent`, so a block it has already rewritten must never be fed back
 * in. Without it a failed block is re-rendered on every pass over the same DOM
 * (an `isControlled` flip, StrictMode's double-invoked effect) and each pass
 * hands mermaid the PREVIOUS note's prose as diagram source — "Diagram error"
 * stacking on itself, forever. It is deliberately NOT `RENDERED_CLASS`: that
 * class is also a style hook (`markdownPreview.css` drops the block's padding
 * and background once an SVG owns the box), so reusing it here would strip the
 * error note's own frame.
 */
const ERROR_CLASS = "markdown-preview__mermaid--error";
/** Marks the per-diagram Fit control. Clicks are handled by DELEGATION from the
 *  container, so the button carries no closure and cannot go stale. Defined in
 *  previewFind.ts because the text index has to skip it (a search must not match
 *  our own chrome) and that module must not import this component. */
const FIT_ATTR = PREVIEW_CHROME_ATTR;

/**
 * A single shared markdown-it instance. Config is static, so there is no reason
 * to rebuild it per render (or per component) — the only per-render input is the
 * `basePath`, which is threaded through the render `env` below.
 */
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

  // ── images: resolve a relative `src` against `basePath` to an absolute path.
  //    The post-mount effect then inlines local images via the scoped read;
  //    remote http(s) images are left to load directly. This rule only rewrites
  //    the attribute (no IPC).
  //
  //    🔴 Not under a Windows base. DOMPurify reads `C:` in `C:\docs\pics\a.png` as an
  //    unknown URL scheme and DROPS the attribute, so the inliner found an `<img>` with
  //    no `src` at all and every relative image on Windows rendered as nothing. Left
  //    relative, it survives the sanitiser and the inliner resolves it — the same path
  //    a raw-HTML `<img>` already takes. ─────────────────────────────────────────────
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

/**
 * Sanitise markdown-it's raw-HTML output before it is injected. DOMPurify's
 * defaults render the safe HTML a README uses (`<p align>`, `<img>`, `<details>`,
 * tables, …) while stripping `<script>`, inline event handlers and dangerous URIs.
 * `data-*` and `class` are kept (defaults), so the mermaid placeholder `<pre>` that
 * the fence rule emits survives to be hydrated after mount.
 */
function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty);
}

/**
 * True when `src` is a relative path: no scheme (`https:`, and a drive's `C:` too), and
 * not absolute on either platform (`/x`, `//cdn`, `\x`, `\\srv\share`). `joinPath` is the
 * shared one — it joins in the base's own separator (`C:\docs\pics\a.png` on Windows).
 */
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
    // 🔴 Load-bearing, and the whole fix for the leaked-graphic bug:
    // mermaid's red *"Syntax error in text / mermaid version
    // 11.16.1"* graphic piling up over the rails and the terminal, surviving
    // the source file being fixed, clearable only by restarting the app.
    //
    // `mermaid.render(id, text)` called with no container argument builds every
    // diagram in a temp `<div id="d{id}">` appended to **document.body** — a
    // sibling of `#root`, outside React entirely, which nothing in this app
    // would ever remove. On a parse failure mermaid paints its error graphic
    // into that div and then does, at `mermaid.core.mjs:1353-1356`:
    //
    //     if (parseEncounteredException) { throw parseEncounteredException; }
    //     removeTempElements();
    //
    // — the cleanup is one statement BELOW the throw and `render()` has no
    // `finally`, so it never runs. Our `catch` swallowed the rejection and drew
    // the calm note below, so the user got both: our note inside the pane and
    // mermaid's bomb stuck to the body. One per failed render, unbounded over a
    // session (`Pane` mounts only the active tab, so every switch away and back
    // re-runs the hydration with a fresh id, and mermaid's own
    // `removeExistingElements` only reclaims a node of the SAME id).
    //
    // With this flag mermaid skips drawing the error graphic and calls
    // `removeTempElements()` on BOTH failure branches before rethrowing
    // (`:1307-1311` parse, `:1326-1333` draw) — measured at 11.16.1: same
    // failing renders, zero leaked nodes, `render()` still rejects so the note
    // below is unchanged. It is also in mermaid's `secure` config list, so a
    // `%%{init:…}%%` directive inside an untrusted markdown file cannot switch
    // it back off. (`securityLevel: "sandbox"` would also avoid the body div,
    // by building a `data:` iframe our CSP's `frame-src` forbids.)
    suppressErrorRendering: true,
  });
}

/**
 * `mermaid.render`, with the temp node it may strand swept up afterwards.
 *
 * Belt and braces next to `suppressErrorRendering` above, and not redundant:
 * suppression covers the two failure branches mermaid guards, but the ~20 lines
 * between them (`getClasses` / `createUserStyles` / `insertBefore`, then
 * `addA11yInfo` / `cleanUpSvgCode` / `DOMPurify.sanitize` / `attachFunctions`)
 * sit in NO try/catch at all, so a throw there still strands the div — and a
 * stray node on `document.body` is the one failure mode this component cannot
 * apologise for, because it outlives the pane, the tab and the file.
 *
 * The sweep is keyed on the id WE passed (mermaid names the div `d${id}`),
 * never on a class or on `svg path.error-icon`: a broad selector here would be
 * a global DOM stomp reaching into whatever else the app has on the page.
 */
async function renderDiagramSvg(id: string, source: string): Promise<string> {
  try {
    return (await mermaid.render(id, source)).svg;
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

/**
 * Give a freshly rendered diagram its natural width and hand the fit-to-pane
 * ceiling over to CSS, so it can be expressed in a way `zoom` can act on.
 *
 * The contract is: **fit the pane at 100%, and grow exactly with the zoom.**
 * Getting there means undoing mermaid's sizing and re-expressing it, because
 * mermaid's version of "fit the pane" is the one thing `zoom` cannot scale.
 *
 * mermaid's default (`useMaxWidth: true`, every diagram type) emits
 * `width="100%" style="max-width: <natural>px"`. Under `zoom: Z` the pane's
 * width in CSS pixels is `W / Z`, so `width: 100%` resolves to `W / Z` CSS px —
 * which paints back to exactly `W` device px at EVERY Z. The prose would grow
 * and the diagram would sit there, unchanged, at every zoom level.
 *
 * So: the natural width goes on as an explicit `width`, mermaid's inline
 * `max-width` is REMOVED (an inline value would beat the stylesheet), and the
 * ceiling is re-imposed by markdownPreview.css as
 * `max-width: calc(100% * var(--mdp-zoom))` — `100%` is `W / Z`, so the product
 * is a constant `W` CSS px, i.e. a used width that is pinned in CSS pixels and
 * therefore scales in DEVICE pixels exactly with the zoom. A 2400px schema in a
 * 900px pane is 900 device px at 100% and 1800 at 200%.
 *
 * `height: auto` + the viewBox keep the aspect ratio.
 */
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

/**
 * Pin a "Fit" control to the top-left of a rendered diagram.
 *
 * Built imperatively rather than in JSX because the diagram itself arrives as
 * `innerHTML` — a React subtree here would have to be a portal into a node
 * React does not own, for one static button. It carries NO click handler: the
 * container has one delegated listener that finds this element by its
 * attribute, so there is no per-diagram closure to capture a stale `zoom`.
 */
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

/* ── reading a mermaid parse failure ──────────────────────────────────────────
 *
 * A jison parse error carries a `hash` alongside the caret-annotated `.message`:
 * `{ text, token, line, loc: { first_line, … }, expected: [ "'SOLID_ARROW'", … ] }`.
 * Everything below is defensive about every field, because the shape is not a
 * contract — a LEXICAL error carries `{ text: "", token: null, line }` and no
 * `loc`/`expected` at all, and a failure on the DRAW path is an ordinary Error
 * with no `hash` whatsoever.
 */

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

/**
 * The failing line, **1-based and relative to the fence body** — not to the
 * document, which is why the UI below says "of the diagram".
 *
 * `hash.loc.first_line` is the one to trust, NOT `hash.line`: measured at
 * 11.16.1, a flowchart failure reports `line: 2` / `first_line: 3` for a
 * mistake on the third line — `hash.line` is jison's 0-based `yylineno` there,
 * while the sequence grammar happens to report it 1-based. `loc` agrees with
 * mermaid's own `"Parse error on line 3:"` in both.
 *
 * A lexical error has no `loc`, so the number is read back out of the message
 * mermaid already formatted — the only place it exists on that path.
 */
function diagramErrorLine(error: unknown): number | null {
  const first = errorHash(error)?.loc?.first_line;
  if (typeof first === "number" && Number.isFinite(first)) return first;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const matched = /error on line (\d+)/i.exec(message);
  return matched ? Number(matched[1]) : null;
}

/**
 * What the parser tripped on, in its own vocabulary: the token it got and the
 * ones it wanted. That pair is the whole point of showing anything at all —
 * a diagram can fail on a `;` inside a `Note` line, which the
 * sequence grammar reads as a statement separator, and a bare "Diagram error"
 * says nothing about that while `Unexpected NEWLINE — expected …` plus the
 * line number does.
 */
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

/**
 * Render a calm inline error in place of a diagram that failed to parse.
 *
 * `ERROR_CLASS` is added FIRST and is not decoration: it is what stops the
 * hydration pass re-reading this note's own prose as diagram source (see the
 * constant). The source is kept beneath the note so the line number above has
 * something to point at.
 */
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

/**
 * Links in the rendered preview must never navigate the app window: a cloned repo's
 * README could otherwise replace the whole IDE with a look-alike page, or steer it to a
 * `preview://` URL that Tauri treats as a local origin. Every click on an `<a>` (including links
 * inside Mermaid SVG) is cancelled here; `https:`
 * links open in the OS browser via `url_open` (Rust re-checks https), `#anchors` scroll
 * within the preview, and anything else is dropped. The Rust `nav_guard` is the backstop.
 *
 * Returns true when the click was a link (handled), so callers stop there.
 */
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
  /**
   * Workspace path of the file being previewed. Keys the find bar's store
   * record (`preview:${path}`) so the bar survives the tab moving between
   * panes; a preview rendered without one keeps an instance-local bar.
   */
  path?: string;
  basePath?: string;
  /** Scale factor for the preview body (1 = 100%); callers clamp via clampPreviewZoom. */
  zoom?: number;
  /** Called with the next zoom when the user ctrl/cmd+scrolls the preview. */
  onZoomChange?: (zoom: number) => void;
}): React.JSX.Element {
  // Pure + synchronous: the rendered HTML is a function of (text, basePath).
  // An empty / whitespace-only source yields "", which drives the empty state.
  // markdown-it emits raw HTML (html:true); DOMPurify then strips anything unsafe
  // (scripts, event handlers, dangerous URIs) before it reaches the DOM below.
  const html = useMemo(
    () => (text.trim() ? sanitizeHtml(md.render(text, { basePath })) : ""),
    [text, basePath],
  );

  // The `dangerouslySetInnerHTML` VALUE is memoised, and that is load-bearing —
  // not a render-cost micro-optimisation. React 19 diffs that prop by reference
  // only: `updateProperties` calls `setProp` whenever `nextProp !== lastProp`,
  // and its `dangerouslySetInnerHTML` case assigns `domElement.innerHTML`
  // unconditionally — it never compares the `__html` strings. An inline
  // `{ __html: html }` is a fresh object on every render, so ANY unrelated
  // re-render (clicking the preview focuses the pane; a zoom step; a parent
  // store update) re-injected markdown-it's raw output and wiped the post-mount
  // hydration below: mermaid diagrams reverted to their source text and inlined
  // images lost their data URLs — permanently, because both effects are keyed on
  // `html`, which had not changed. A stable reference makes React touch the
  // subtree only when the HTML genuinely changes, which is exactly when the
  // hydration effects re-run too.
  const htmlProp = useMemo(() => ({ __html: html }), [html]);

  // Whether zoom is controlled, as a STABLE boolean. `onZoomChange` itself is a
  // fresh arrow on every parent render, so depending on it directly would
  // re-run the hydration effect constantly; the Fit control only needs to know
  // that *some* handler exists.
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

  // The bar's open/query/cursor live in the STORE, keyed per FILE, because this
  // component does not outlive the gestures the bar must survive: `Pane`
  // unmounts inactive tabs and a cross-pane drag re-parents the subtree (see
  // the file header). An absent record IS the closed state.
  const findKey = path === undefined ? null : `preview:${path}`;
  const storeBar = useAppStore((s) => (findKey === null ? undefined : s.findBars[findKey]));
  const patchFindBar = useAppStore((s) => s.uiActions.patchFindBar);
  const dropFindBar = useAppStore((s) => s.uiActions.dropFindBar);
  // A preview with no `path` has no identity for a bar to survive UNDER — no
  // tab, no store key — so its bar stays instance-local (the pre-store
  // behaviour: a fresh mount is a fresh, closed bar). The hook is called
  // unconditionally; only which VALUE is used depends on the key.
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

  /** Live DOM Ranges for the current query. State, NOT a ref, deliberately: the
   *  paint effect below has to re-run whenever the ranges change, and two
   *  different queries can produce the same match COUNT — keying the effect on a
   *  number would silently leave the old highlights painted. Local ON PURPOSE,
   *  unlike open/query/cursor: a Range dies with the document fragment it points
   *  into, so it cannot survive an unmount — the effect below recomputes it from
   *  the stored query on every mount. */
  const [ranges, setRanges] = useState<Range[]>([]);
  /** Bumped on every Cmd/Ctrl+F so an already-open bar re-focuses its input.
   *  A transient, so local. */
  const [focusSignal, setFocusSignal] = useState(0);

  /**
   * Open the bar, seeding it from `seed` when the caller found a usable
   * selection (pressing Cmd+F with text selected must search for that
   * selection).
   *
   * The seed is written with the SAME `patchBar({ query })` the input's onChange
   * makes, which is the whole design: the recompute effect below sees a changed
   * query, rebuilds the Ranges, resets the cursor to the first match and the
   * paint effect scrolls it into view — identical to typing it. There is no
   * second "apply the query" path that could drift from the first. A `null` seed
   * patches only `open`, so the no-selection behaviour is untouched.
   *
   * Unlike `ResponseBody` and `ResultsGrid`, this does NOT need a "skip an
   * unchanged query" guard: those two write `cursor: 0` in the patch itself, so
   * re-seeding the same text would move the user's place. Here the cursor is
   * derived by the recompute effect, which already tells "the user typed a new
   * query" from "the same query re-indexed" — so a same-query
   * re-seed keeps the place for free, and a guard would be a branch with no
   * observable behaviour behind it.
   */
  const openFind = useCallback(
    (seed: string | null) => {
      patchBar(seed === null ? { open: true } : { open: true, query: seed });
      setFocusSignal((n) => n + 1);
    },
    [patchBar],
  );

  /** The query the current `ranges` were computed for; `null` before the first
   *  computation OF THIS MOUNT. It is what lets the effect below tell "the user
   *  typed a different query" (the cursor restarts at the first match, as it
   *  always has) from "the same query was re-indexed" — a remount after a tab
   *  move, or the source changing under an open search — where the stored
   *  cursor is KEPT, clamped to the fresh count. Seeded with the mount-time
   *  query so a remounted bar lands in the second arm. */
  const rangesForQueryRef = useRef<string | null>(query);
  /** Mirror of `cursor` for the recompute effect + the step handler, so neither
   *  needs the cursor as a dependency: re-running the O(document) index walk on
   *  every ↑/↓ step would be waste the original state version never paid.
   *  Updated in an effect (never during render — react-hooks/refs), and
   *  DECLARED BEFORE the recompute effect so that in a commit where both run
   *  the mirror is fresh by the time the recompute reads it. */
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // Recompute the match Ranges. Keyed on `html` as well as the query because a
  // re-injected `innerHTML` detaches every node the old Ranges point into —
  // recoverable (a stale Range simply paints nothing) but wrong, and `[html]` is
  // the same signal the hydration effects use, so the three stay in step. This
  // is also the REMOUNT path: after a tab move the stored query arrives
  // non-empty on the first render, so this same effect rebuilds the index and
  // the ranges the unmount destroyed — nothing separate to run.
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

  // Paint, and bring the current match on screen. A layout effect for the same
  // reason the zoom anchor is one: it must run against the laid-out DOM.
  //
  // Gated on `findOpen`, and the gate matters: the highlight registry is
  // DOCUMENT-global, so a preview with no bar open painting an empty highlight
  // would wipe the matches of a preview in another split that does. The cleanup
  // is what retires them — on close, and on unmount, so a closed tab never
  // leaves colour behind. It touches ONLY the registry, never the store record:
  // unmount is not Esc, and the record surviving it is the whole fix — the
  // remounted preview reopens from it and repaints fresh Ranges.
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

  /**
   * Cmd/Ctrl+F that reached the WINDOW — i.e. one no focused surface claimed.
   *
   * The container-scoped handler below is not enough on its own, and that gap is
   * the whole bug: the usual flow is *open a README and press Cmd+F*, at
   * which point focus is on the tree row or the tab they just clicked, so a
   * keydown never enters the preview's subtree at all. Bubble phase, never
   * capture, so every focus-local owner gets first refusal: the terminal's
   * capture listener stops the event dead, and CodeMirror's keymap and
   * ResponseBody's bar both `preventDefault` — the first two lines below honour
   * all three (a fallback must be idempotent per keystroke, so it
   * skips an event that has already been handled).
   */
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return; // someone with focus already answered
      if (!isPreviewFindShortcut(e)) return;
      const el = containerRef.current;
      if (el === null || !ownsGlobalFind(el)) return;
      if (isEditableTarget(e.target, el)) return;
      e.preventDefault(); // never reaches WebKit's own window-wide find
      // Read the selection before anything focuses the bar's input — focusing
      // collapses it. On THIS path the selection is the only evidence the user
      // was reading the preview at all (focus is on a tree row or a tab), and
      // `domSelectionSeed` scopes it to this preview, so a selection in another
      // split never seeds ours.
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
      // `nearest` on both axes: bring it fully into view without yanking a
      // diagram that is already visible to the top of the pane.
      // Optional-call: jsdom ships no scrollIntoView; the browser does. Same
      // shape as WorkspaceTree and ComparePanel — without it, every jsdom test
      // that presses Fit throws inside a layout effect.
      fitted.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    const el = containerRef.current as HTMLDivElement; // rendered whenever this runs
    el.scrollLeft += pending.dx;
    el.scrollTop += pending.dy;
  }, [zoom]);

  /**
   * The Fit control, handled by DELEGATION from the container. One listener for
   * every diagram, and — because it reads `zoom` from this render's scope
   * rather than from a closure baked into a DOM node at hydration time — it can
   * never act on a stale zoom.
   *
   * Everything is measured at click time in device pixels: the diagram's own
   * rect, and the pane's CONTENT box (clientWidth already excludes a scrollbar;
   * the padding has to come off by hand, or the diagram would be fitted to a
   * box 52px wider than the space it can actually occupy). `fitPreviewZoom`
   * turns the two into the next zoom, and returns the current one unchanged if
   * anything measures zero — a collapsed pane must not produce a garbage zoom.
   */
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

  // Ctrl/cmd+drag pans by scrolling the container — works at any zoom. Same
  // globalized-drag pattern as RailResizer: window-level move/up listeners (not
  // pointer capture) so the drag tracks outside the element, and a body class so
  // the CSS can kill text selection + hold the grabbing cursor everywhere.
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
        // Skip anything this pass has already dealt with — rendered OR failed.
        // Cheap, and load-bearing in both cases: `source` is read from
        // `textContent`, which after hydration is the SVG's text plus the Fit
        // control's label, and after a failure is the error note's own prose.
        // Re-running over either feeds that garbage back to mermaid.
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

  // Post-mount: inline LOCAL images as data URLs via the scoped read. Remote
  // (http/https) and already-inline (data/blob/asset/file) srcs are left untouched.
  // Race-guarded like the mermaid effect; a failed read leaves the <img> as-is (a
  // broken image, never fatal) — e.g. an out-of-scope path or an unsupported type.
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
      // Focusable-but-not-tabbable, so a click anywhere in the preview lands
      // focus here and the keydown handler below sees Cmd/Ctrl+F. Without it a
      // scroll container holds no focus and the shortcut would depend entirely
      // on the window fallback (same idiom as ResponseBody's box).
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
          // zoom:1 is inert. Growth becomes scrollable overflow of the
          // container above — and it is REAL layout, so it paints sharp.
          // `--mdp-zoom` publishes the same number to CSS: a diagram's
          // fit-the-pane ceiling has to be written as `calc(100% * zoom)` to
          // survive the zoom at all (see sizeDiagramForZoom).
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
