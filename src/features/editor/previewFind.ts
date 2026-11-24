/**
 * previewFind — searching the RENDERED Markdown preview (search must work
 * inside the rendered .md file, not only in its source).
 *
 * Everything here is deliberately headless-ish: plain functions over a DOM
 * subtree, no React, no component state — so the jsdom tier can measure almost
 * all of it and the browser tier only has to prove the one thing jsdom cannot
 * (that `CSS.highlights` really paints).
 *
 * ## Why Ranges, and NOT `<mark>` injection
 *
 * The preview body is `innerHTML`-owned (`dangerouslySetInnerHTML`), and this
 * repo already carries two scars from mutating it:
 *
 *   1. **Re-renders erase DOM work** — React 19 re-assigns `innerHTML` whenever the prop
 *      OBJECT changes identity, which erases every post-mount mutation. Injected
 *      `<mark>`s would vanish on an unrelated re-render, silently.
 *   2. **Worse, and easy to miss:** `MarkdownPreview`'s mermaid hydration pass
 *      reads `el.textContent` as diagram SOURCE. A `<mark>` inside a not-yet
 *      hydrated ```mermaid block would be fed to `mermaid.render` and produce a
 *      *"Diagram error"* — **because the user searched**.
 *
 * The CSS Custom Highlight API paints a `Range` without inserting a node, so
 * both hazards disappear: the DOM the search decorates is byte-identical to the
 * DOM it found. Availability is fine for our targets — Safari 17.2+ (macOS runs
 * the system WebKit) and Ubuntu 26.04's WebKitGTK — and `paintHighlights` is a
 * documented no-op anywhere the API is absent (jsdom, notably), so a missing
 * engine costs the highlight and nothing else: the count, the navigation and the
 * scrolling all still work.
 *
 * ## Match semantics come from `findModel`
 *
 * The caller runs `listMatches` from `./find/findModel` — the same engine the
 * editor's find bar and the API client's response search use — so "3/17" can
 * never mean three different things in three places. This module only turns the
 * offsets that engine produces into DOM Ranges.
 */

import type { MatchRange } from "./find/findModel";

/**
 * Marks DOM that the PREVIEW injected rather than the document — today, the
 * per-diagram Fit control.
 *
 * It lives here rather than in `MarkdownPreview.tsx` because `textIndex` has to
 * skip it (searching "fit" must not light up our own button) and the index must
 * not import the component it is used by. `MarkdownPreview` imports it back.
 */
export const PREVIEW_CHROME_ATTR = "data-mdp-fit";

/** The highlight-registry name the preview paints its matches under. */
export const FIND_HIGHLIGHT = "markdown-preview-find";

/** The name of the companion highlight holding just the CURRENT match. */
export function currentHighlightName(name: string): string {
  return `${name}-current`;
}

/** Where one text node's data sits inside the concatenated visible text. */
export interface TextSlice {
  node: Text;
  /** Inclusive offset of this node's first character in `TextIndex.text`. */
  start: number;
  /** Exclusive offset of this node's last character in `TextIndex.text`. */
  end: number;
}

/** The concatenated visible text of a subtree, plus the map back to its nodes. */
export interface TextIndex {
  text: string;
  nodes: TextSlice[];
}

/**
 * Is this element's whole subtree invisible to a text search?
 *
 * Three cases, and each is a deliberate decision rather than a tidy-up:
 *
 *   - **`<svg>`** — a hydrated mermaid diagram. Its text is laid out by the
 *     diagram, not by the document: a `Range` over it would be paintable but
 *     meaningless to navigate to, and "3/17" would count labels the user does
 *     not read as prose. (A ```mermaid block that has NOT hydrated yet is still
 *     a `<pre>` of source text on screen, so it IS indexed — what you can see,
 *     you can find.)
 *   - **`<style>` / `<script>`** — never rendered as text. DOMPurify strips
 *     `<script>` before the HTML is injected, so that arm is belt-and-braces;
 *     `<style>` survives sanitisation and would otherwise pour CSS into the
 *     haystack.
 *   - **`[data-mdp-fit]`** — the preview's own Fit button. It is our chrome, not
 *     the document, and matching it would put a highlight on a control.
 *
 * SVG tag names are lower-case (XML namespace) while HTML's are upper-case,
 * hence the explicit `toUpperCase()` — `tagName === "SVG"` alone silently
 * indexes every diagram.
 */
function isSkippedSubtree(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === "SVG" || tag === "STYLE" || tag === "SCRIPT") return true;
  return el.hasAttribute(PREVIEW_CHROME_ATTR);
}

/**
 * The concatenated visible text of `root`, plus where each text node sits in it.
 *
 * The text is the nodes' data verbatim — no whitespace collapsing, no
 * normalisation — because the whole point of the index is that an offset in
 * `text` maps back to an exact `(node, offset)` pair. Collapsing would make the
 * highlight land somewhere other than the match.
 *
 * Empty text nodes are dropped: they contribute nothing to `text` and a
 * zero-width slice would be a range nothing can be found in.
 */
export function textIndex(root: Node): TextIndex {
  const nodes: TextSlice[] = [];
  let text = "";
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // REJECT prunes the whole subtree; SKIP keeps walking into it.
          return isSkippedSubtree(node as Element)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        }
        return (node as Text).data.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const textNode = node as Text;
    const start = text.length;
    text += textNode.data;
    nodes.push({ node: textNode, start, end: text.length });
  }
  return { text, nodes };
}

/**
 * A DOM Range covering `[from, to)` of the index's text, or null when the span
 * is not addressable.
 *
 * The interesting case — and the one a naive implementation gets wrong — is a
 * match that SPANS text nodes: `**find** me` renders as `<strong>find</strong>`
 * plus ` me`, so searching "find me" starts in one node and ends in another.
 * Start and end are therefore resolved independently.
 *
 * Null is returned for an out-of-range offset and for an empty span (`to <=
 * from` can address no node, which falls out of the two predicates rather than
 * needing a guard of its own).
 */
export function rangeFor(index: TextIndex, from: number, to: number): Range | null {
  const start = index.nodes.find((s) => from >= s.start && from < s.end);
  const end = index.nodes.find((s) => to > s.start && to <= s.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, from - start.start);
  range.setEnd(end.node, to - end.start);
  return range;
}

/**
 * Ranges for every match, in order. A match that cannot be addressed is dropped
 * rather than throwing — the count the bar shows is the count of ranges, so it
 * can never claim a match the navigation cannot reach.
 */
export function rangesForMatches(index: TextIndex, matches: MatchRange[]): Range[] {
  const out: Range[] = [];
  for (const match of matches) {
    const range = rangeFor(index, match.from, match.to);
    if (range !== null) out.push(range);
  }
  return out;
}

/**
 * The Maplike surface of `CSS.highlights`.
 *
 * Declared structurally because TypeScript's `lib.dom` `HighlightRegistry`
 * exposes only `forEach` — the Maplike members are real at runtime but absent
 * from the type — and because reading the API off `globalThis` is what makes
 * "absent engine" a first-class, testable state rather than a crash.
 */
interface HighlightRegistryLike {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

interface HighlightGlobals {
  CSS?: { highlights?: HighlightRegistryLike };
  Highlight?: new (...ranges: AbstractRange[]) => Highlight;
}

/** The registry + constructor, or null where the engine does not ship them. */
function highlightApi(): {
  registry: HighlightRegistryLike;
  make: (ranges: Range[]) => Highlight;
} | null {
  const globals = globalThis as unknown as HighlightGlobals;
  const registry = globals.CSS?.highlights;
  const Ctor = globals.Highlight;
  if (!registry || !Ctor) return null;
  return { registry, make: (ranges) => new Ctor(...ranges) };
}

/**
 * Paint `ranges` under `name`, with `current` painted on top under a companion
 * name so the active match can be styled differently.
 *
 * **A no-op where `CSS.highlights` is unavailable** — which is jsdom's state,
 * and therefore the DEFAULT path in the unit tier. Nothing else in the feature
 * depends on it: the count, next/previous and the scroll-into-view all work
 * from the Ranges directly, so an engine without the API loses the colour and
 * keeps the search.
 *
 * The registry is document-global, so two previews with an open find bar share
 * these two names and the last paint wins. In the app only one pane holds focus
 * at a time, so only one bar is ever being typed into.
 *
 * `priority` is set explicitly rather than relying on registration order, so the
 * current match stays on top no matter which name was registered first.
 */
export function paintHighlights(
  name: string,
  ranges: Range[],
  current: Range | null,
): void {
  const api = highlightApi();
  if (api === null) return;
  api.registry.set(name, api.make(ranges));
  const active = api.make(current === null ? [] : [current]);
  active.priority = 1;
  api.registry.set(currentHighlightName(name), active);
}

/**
 * Bring a match on screen. An offset is not something you can scroll to, but
 * the ELEMENT holding its first text node is.
 *
 * `scrollIntoView` is optional-called because jsdom does not implement it — the
 * same shape `MarkdownPreview`'s Fit scroll uses, and without the `?.` every
 * jsdom test that lands a match throws inside a layout effect. `parentElement`
 * is optional for a subtler reason: a Range whose nodes were detached by a
 * re-render has none, and a stale cursor must scroll nowhere
 * rather than crash the preview.
 */
export function scrollRangeIntoView(range: Range | null): void {
  const host = range?.startContainer.parentElement;
  host?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** Drop both highlights. Also a no-op where the API is unavailable. */
export function clearHighlights(name: string): void {
  const api = highlightApi();
  if (api === null) return;
  api.registry.delete(name);
  api.registry.delete(currentHighlightName(name));
}

/**
 * Is this keydown the "find in this preview" shortcut?
 *
 * Cmd **or** Ctrl + F, matching `ResponseBody`'s bar rather than the terminal's
 * stricter platform rule: the terminal has to leave macOS Ctrl+F to readline
 * (it is forward-char in every shell), and a rendered preview has no such
 * tenant. Shift is Find-in-Files' and Alt is nobody's.
 */
export function isPreviewFindShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (e.key.toLowerCase() !== "f") return false;
  if (e.altKey || e.shiftKey) return false;
  return e.metaKey || e.ctrlKey;
}

/**
 * May this preview claim a Cmd/Ctrl+F that reached the WINDOW — i.e. one nobody
 * with focus wanted?
 *
 * This is the difference between a feature and a demo. The usual flow is
 * *open a README, press Cmd+F* — at which point focus is on the file they
 * clicked in the tree or on the tab they opened, never inside the preview, so a
 * strictly container-scoped handler would do exactly what today's build does:
 * nothing. Three rules, cheapest first:
 *
 *   1. **Focus is already inside this preview** — unambiguous, it is ours.
 *   2. **Otherwise, the pane arbitrates.** `Pane.tsx` puts `pane--focused` on
 *      the focused pane, and a newly opened tab always lands in that pane, so
 *      the preview the user is looking at is the one that answers and a preview
 *      in a background split stays quiet. A CSS class is a thin coupling, but it
 *      is the app's own published mark of "the pane the user is in" and it costs
 *      no store subscription in a component whose whole contract is being
 *      self-contained.
 *   3. **No pane at all** (a standalone render, or a test harness) — a lone
 *      preview owns the key; two of them arbitrate to neither, because guessing
 *      would be worse than doing nothing.
 */
export function ownsGlobalFind(container: HTMLElement): boolean {
  if (container.contains(document.activeElement)) return true;
  const pane = container.closest(".pane");
  if (pane !== null) return pane.classList.contains("pane--focused");
  return document.querySelectorAll(".markdown-preview").length === 1;
}

/**
 * Is the key being typed into an editable element OUTSIDE this preview?
 *
 * The window-level fallback above must never reach over a text field the user
 * is actually typing in — the right rail's filter box, a request-header input —
 * because in those the browser's own find (or nothing at all) is the honest
 * answer, and a find bar opening in a different pane is a jump-scare. Editable
 * targets INSIDE the preview are ours by definition: that is the find input.
 */
export function isEditableTarget(target: EventTarget | null, container: HTMLElement): boolean {
  const el = target instanceof Element ? target : null;
  if (el === null || container.contains(el)) return false;
  return el.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}
