/** Find in the rendered Markdown preview via CSS Highlight ranges, never injected `<mark>`s:
 * React re-renders erase innerHTML edits and mermaid hydration reads textContent as its source.
 * Offsets come from `findModel` (as in the editor find bar); this only maps them to DOM Ranges. */

import type { MatchRange } from "./find/findModel";

/** Marks preview-injected chrome (the Fit control) so `textIndex` skips it. Defined here so the
 * index need not import `MarkdownPreview`. */
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

/** Hydrated `<svg>` diagrams, `<style>`/`<script>` and our Fit button are not searchable text.
 * SVG tag names are lower-case, hence `toUpperCase()`. */
function isSkippedSubtree(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === "SVG" || tag === "STYLE" || tag === "SCRIPT") return true;
  return el.hasAttribute(PREVIEW_CHROME_ATTR);
}

/** Visible text of `root` plus each text node's position. Raw node data, never normalised, so an
 * offset maps back to an exact (node, offset). Empty nodes are dropped. */
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

/** A Range over `[from, to)`, or null for an out-of-range or empty span. Start and end resolve
 * independently because a match can span text nodes (`**find** me`). */
export function rangeFor(index: TextIndex, from: number, to: number): Range | null {
  const start = index.nodes.find((s) => from >= s.start && from < s.end);
  const end = index.nodes.find((s) => to > s.start && to <= s.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, from - start.start);
  range.setEnd(end.node, to - end.start);
  return range;
}

/** Ranges for every match in order; unaddressable ones are dropped so the count stays reachable. */
export function rangesForMatches(index: TextIndex, matches: MatchRange[]): Range[] {
  const out: Range[] = [];
  for (const match of matches) {
    const range = rangeFor(index, match.from, match.to);
    if (range !== null) out.push(range);
  }
  return out;
}

/** Structural: lib.dom's `HighlightRegistry` types only `forEach`, and reading it off `globalThis`
 * makes an absent engine a testable state rather than a crash. */
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

/** Paint `ranges` under `name`, `current` on top under a companion name (explicit priority).
 * No-op without `CSS.highlights` (jsdom). The registry is document-global: the last paint wins. */
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

/** Scroll the element holding the range's first text node into view. Optional calls: jsdom lacks
 * `scrollIntoView`, and a range detached by a re-render has no parentElement. */
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

/** Cmd or Ctrl+F, like `ResponseBody`: unlike the terminal, a preview has no readline to leave
 * macOS Ctrl+F to. Shift is Find-in-Files'. */
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

/** May this preview claim a window-level Cmd/Ctrl+F? Yes if focus is inside it, else if it is in
 * the `pane--focused` pane; with no pane at all, only when it is the lone preview. */
export function ownsGlobalFind(container: HTMLElement): boolean {
  if (container.contains(document.activeElement)) return true;
  const pane = container.closest(".pane");
  if (pane !== null) return pane.classList.contains("pane--focused");
  return document.querySelectorAll(".markdown-preview").length === 1;
}

/** Typing into an editable element outside this preview? Then the window fallback must not open a
 * find bar. Editable targets inside the preview (the find input) are ours. */
export function isEditableTarget(target: EventTarget | null, container: HTMLElement): boolean {
  const el = target instanceof Element ? target : null;
  if (el === null || container.contains(el)) return false;
  return el.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}
