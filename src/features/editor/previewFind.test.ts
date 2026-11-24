/**
 * previewFind — the pure/DOM half of "search inside the rendered .md".
 * jsdom, no React.
 *
 * jsdom is a genuinely good host for most of this: it has `TreeWalker`,
 * `NodeFilter`, real text nodes and real `Range`s. What it does NOT have is
 * `CSS.highlights`, `Highlight`, or `Element.scrollIntoView` — so the
 * "unavailable engine" arm of `paintHighlights` is not an exotic branch here,
 * it is the DEFAULT path, and the tests treat it as the first-class state it is.
 * Where the API's presence matters the registry is stubbed, and the stub's
 * absence is asserted two-sidedly so a test can never pass by measuring nothing.
 *
 * The claims that would be easy to get wrong, and each has its own case:
 *   - a match that SPANS text nodes (`**find** me`) — the case a naive
 *     "one node per match" implementation silently truncates;
 *   - the skipped regions are really skipped, and a normal paragraph really is
 *     indexed (two-sided, or it proves nothing);
 *   - SVG tag names are LOWER-case, so a `tagName === "SVG"` test would index
 *     every hydrated diagram while looking correct.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { listMatches } from "./find/findModel";
import {
  FIND_HIGHLIGHT,
  PREVIEW_CHROME_ATTR,
  clearHighlights,
  currentHighlightName,
  isEditableTarget,
  isPreviewFindShortcut,
  ownsGlobalFind,
  paintHighlights,
  rangeFor,
  rangesForMatches,
  scrollRangeIntoView,
  textIndex,
} from "./previewFind";

/** Build a detached-but-parsed subtree, the way the preview's body arrives. */
function root(html: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

/** A minimal stand-in for `Highlight`: Setlike enough for what we assert. */
class FakeHighlight {
  priority = 0;
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

/**
 * Install a fake `CSS.highlights` + `Highlight` for the duration of one test,
 * restoring jsdom's real (absent) state afterwards. Returns the registry map so
 * assertions can read what was painted.
 */
function withHighlightApi(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  const g = globalThis as unknown as Record<string, unknown>;
  const savedCss = g.CSS;
  const savedHighlight = g.Highlight;
  g.CSS = { ...(savedCss as object), highlights: registry };
  g.Highlight = FakeHighlight;
  restores.push(() => {
    g.CSS = savedCss;
    g.Highlight = savedHighlight;
  });
  return registry;
}

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  document.body.innerHTML = "";
});

describe("textIndex", () => {
  it("concatenates the visible text of nested markup and maps each node back", () => {
    const el = root("<p>Hello <strong>bold</strong> world</p>");

    const index = textIndex(el);

    expect(index.text).toBe("Hello bold world");
    expect(index.nodes.map((s) => [s.node.data, s.start, s.end])).toEqual([
      ["Hello ", 0, 6],
      ["bold", 6, 10],
      [" world", 10, 16],
    ]);
    // Every slice is a real live node in the tree — not a copy of its text.
    for (const slice of index.nodes) expect(el.contains(slice.node)).toBe(true);
  });

  it("walks a nested list in document order", () => {
    const index = textIndex(
      root("<ul><li>one<ul><li>one a</li></ul></li><li>two</li></ul>"),
    );
    expect(index.text).toBe("oneone atwo");
    expect(index.nodes).toHaveLength(3);
    expect(index.nodes[1].start).toBe(3);
  });

  it("drops empty text nodes rather than emitting zero-width slices", () => {
    const el = root("<p>a</p>");
    el.append(document.createTextNode(""));
    el.append(document.createTextNode("b"));

    const index = textIndex(el);

    expect(index.text).toBe("ab");
    expect(index.nodes).toHaveLength(2);
    expect(index.nodes.every((s) => s.end > s.start)).toBe(true);
  });

  it("skips a hydrated diagram's <svg>, <style> and the preview's own chrome — but not prose", () => {
    const el = root(
      "<p>real prose</p>" +
        '<pre class="markdown-preview__mermaid markdown-preview__mermaid--rendered">' +
        "<svg><text>Node label</text></svg>" +
        `<button ${PREVIEW_CHROME_ATTR} type="button">Fit</button>` +
        "</pre>" +
        "<style>.x { color: red }</style>" +
        "<p>more prose</p>",
    );
    // Two-sided part 1: the things we claim to skip really are in the DOM.
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.querySelector("style")).not.toBeNull();
    expect(el.querySelector(`[${PREVIEW_CHROME_ATTR}]`)).not.toBeNull();

    const index = textIndex(el);

    // Two-sided part 2: the paragraphs around them ARE indexed, so this is a
    // test about skipping and not about an empty subtree.
    expect(index.text).toBe("real prosemore prose");
    expect(index.text).not.toContain("Node label");
    expect(index.text).not.toContain("color: red");
    expect(index.text).not.toContain("Fit");
  });

  it("skips a <script> even though DOMPurify should already have removed it", () => {
    // Belt-and-braces, and cheap: the index is a general DOM walker, and a
    // caller other than MarkdownPreview would not have DOMPurify in front of it.
    const el = root("<p>kept</p>");
    const script = document.createElement("script");
    script.textContent = "window.pwned = 1";
    el.append(script);

    const index = textIndex(el);

    expect(el.querySelector("script")).not.toBeNull(); // it really is there
    expect(index.text).toBe("kept");
  });

  it("matches an SVG tag whose name is LOWER-case (the XML-namespace trap)", () => {
    const el = root("<svg><text>diagram</text></svg><p>prose</p>");
    // The reason `isSkippedSubtree` upper-cases: HTML elements report an
    // upper-case tagName, SVG elements report the source case. A skip list
    // written as `tagName === "SVG"` passes review and indexes every diagram.
    expect(el.querySelector("svg")!.tagName).toBe("svg");

    expect(textIndex(el).text).toBe("prose");
  });

  it("indexes a ```mermaid block that has NOT hydrated yet — what you see, you can find", () => {
    // Pre-hydration the block is a <pre> of source text on screen. Only the
    // rendered <svg> is skipped, which is a statement about what is READABLE,
    // not about which element the diagram happens to live in.
    const el = root(
      '<pre class="markdown-preview__mermaid">graph TD; A--&gt;B;</pre>',
    );
    expect(textIndex(el).text).toContain("graph TD");
  });
});

describe("rangeFor", () => {
  it("addresses a match inside a single text node", () => {
    const el = root("<p>Hello world</p>");
    const index = textIndex(el);

    const range = rangeFor(index, 6, 11)!;

    expect(range).not.toBeNull();
    expect(range.toString()).toBe("world");
    expect(range.startContainer).toBe(index.nodes[0].node);
  });

  it("addresses a match that SPANS two text nodes", () => {
    // The case a naive implementation gets wrong: markdown bolding splits the
    // run, so "find me" starts inside <strong> and ends in the sibling text.
    const el = root("<p><strong>find</strong> me now</p>");
    const index = textIndex(el);
    expect(index.nodes).toHaveLength(2); // it really is split

    const range = rangeFor(index, 0, 7)!;

    expect(range.toString()).toBe("find me");
    expect(range.startContainer).toBe(index.nodes[0].node);
    expect(range.endContainer).toBe(index.nodes[1].node);
    expect(range.endOffset).toBe(3); // " me" — three chars into " me now"
  });

  it("addresses a match that ends exactly at the end of the text", () => {
    const index = textIndex(root("<p>abc</p>"));
    expect(rangeFor(index, 1, 3)!.toString()).toBe("bc");
  });

  it("returns null for offsets past the end of the index", () => {
    const index = textIndex(root("<p>abc</p>"));
    expect(rangeFor(index, 3, 4)).toBeNull(); // `from` past the last character
    expect(rangeFor(index, 1, 9)).toBeNull(); // `to` past the last character
  });

  it("returns null for an empty span", () => {
    const index = textIndex(root("<p>abc</p>"));
    expect(rangeFor(index, 0, 0)).toBeNull();
  });

  it("returns null when there is no text at all", () => {
    expect(rangeFor(textIndex(root("<p></p>")), 0, 1)).toBeNull();
  });
});

describe("rangesForMatches", () => {
  it("turns findModel's offsets into Ranges over the rendered text", () => {
    const el = root("<p>one <em>two</em> two three</p>");
    const index = textIndex(el);
    const matches = listMatches(
      { search: "two", caseSensitive: false, wholeWord: false, regexp: false },
      index.text,
    );
    expect(matches).toHaveLength(2); // the engine, not us, decides the count

    const ranges = rangesForMatches(index, matches);

    expect(ranges.map((r) => r.toString())).toEqual(["two", "two"]);
    // The first one lives in the <em>, the second in the following text node.
    expect(ranges[0].startContainer.parentElement!.tagName).toBe("EM");
    expect(ranges[1].startContainer.parentElement!.tagName).toBe("P");
  });

  it("drops a match it cannot address rather than throwing", () => {
    // A count that includes a match the navigation could not reach would be a
    // lie in the bar; the ranges ARE the count.
    const index = textIndex(root("<p>abc</p>"));

    const ranges = rangesForMatches(index, [
      { from: 0, to: 1 },
      { from: 99, to: 100 },
    ]);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("a");
  });
});

describe("paintHighlights / clearHighlights", () => {
  it("is a NO-OP where CSS.highlights is unavailable, and does not throw", () => {
    // jsdom's own state, and therefore the default path in this whole tier.
    const g = globalThis as unknown as { CSS?: { highlights?: unknown } };
    expect(g.CSS?.highlights).toBeUndefined();

    const index = textIndex(root("<p>abc</p>"));
    const range = rangeFor(index, 0, 1)!;

    expect(() => paintHighlights(FIND_HIGHLIGHT, [range], range)).not.toThrow();
    expect(() => clearHighlights(FIND_HIGHLIGHT)).not.toThrow();
  });

  it("does not throw where there is no CSS object at all", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = g.CSS;
    delete g.CSS;
    restores.push(() => {
      g.CSS = saved;
    });

    expect(() => paintHighlights(FIND_HIGHLIGHT, [], null)).not.toThrow();
    expect(() => clearHighlights(FIND_HIGHLIGHT)).not.toThrow();
  });

  it("does not paint when the registry exists but the Highlight constructor does not", () => {
    // A partial implementation is a real shape (a polyfilled registry, an engine
    // mid-rollout), and constructing `undefined` would be a hard crash.
    const registry = withHighlightApi();
    (globalThis as unknown as Record<string, unknown>).Highlight = undefined;

    expect(() => paintHighlights(FIND_HIGHLIGHT, [], null)).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it("registers every match, and the current one on top under its own name", () => {
    const registry = withHighlightApi();
    const index = textIndex(root("<p>aXbXc</p>"));
    const first = rangeFor(index, 1, 2)!;
    const second = rangeFor(index, 3, 4)!;

    paintHighlights(FIND_HIGHLIGHT, [first, second], second);

    expect(registry.get(FIND_HIGHLIGHT)!.ranges).toEqual([first, second]);
    const current = registry.get(currentHighlightName(FIND_HIGHLIGHT))!;
    expect(current.ranges).toEqual([second]);
    // Priority, not registration order — the current match must win wherever
    // the two highlights overlap, which they always do.
    expect(current.priority).toBe(1);
    expect(registry.get(FIND_HIGHLIGHT)!.priority).toBe(0);
  });

  it("registers an EMPTY current highlight when there is no current match", () => {
    const registry = withHighlightApi();

    paintHighlights(FIND_HIGHLIGHT, [], null);

    expect(registry.get(FIND_HIGHLIGHT)!.ranges).toEqual([]);
    expect(registry.get(currentHighlightName(FIND_HIGHLIGHT))!.ranges).toEqual([]);
  });

  it("clearHighlights retires both names", () => {
    const registry = withHighlightApi();
    paintHighlights(FIND_HIGHLIGHT, [], null);
    expect(registry.size).toBe(2);

    clearHighlights(FIND_HIGHLIGHT);

    expect(registry.size).toBe(0);
  });

  it("names the current highlight predictably (the CSS rule is written by hand)", () => {
    // `previewFind.css` spells `::highlight(markdown-preview-find-current)` as a
    // literal — highlight names cannot be interpolated into a stylesheet — so
    // this pair has to stay in agreement by test, not by construction.
    expect(FIND_HIGHLIGHT).toBe("markdown-preview-find");
    expect(currentHighlightName(FIND_HIGHLIGHT)).toBe("markdown-preview-find-current");
  });
});

describe("scrollRangeIntoView", () => {
  it("scrolls the element holding the match", () => {
    const el = root("<p>hello</p>");
    document.body.append(el);
    const index = textIndex(el);
    const spy = vi.fn();
    // jsdom implements no scrollIntoView at all, which is exactly why the call
    // site is optional — install one so the "it exists" arm is exercised too.
    const target = el.querySelector("p") as HTMLElement & { scrollIntoView?: unknown };
    target.scrollIntoView = spy;

    scrollRangeIntoView(rangeFor(index, 0, 2));

    expect(spy).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("does nothing for no current match", () => {
    expect(() => scrollRangeIntoView(null)).not.toThrow();
  });

  it("does nothing for a Range whose nodes were detached by a re-render", () => {
    // The re-render shape: a re-assigned innerHTML detaches the nodes an old
    // Range points into, leaving it with no parent element to scroll.
    const orphan = document.createTextNode("gone");
    const range = document.createRange();
    range.setStart(orphan, 0);
    range.setEnd(orphan, 4);
    expect(orphan.parentElement).toBeNull(); // the state under test really holds

    expect(() => scrollRangeIntoView(range)).not.toThrow();
  });
});

describe("isPreviewFindShortcut", () => {
  const key = (over: Partial<Parameters<typeof isPreviewFindShortcut>[0]>) => ({
    key: "f",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("accepts Cmd+F and Ctrl+F", () => {
    expect(isPreviewFindShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPreviewFindShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPreviewFindShortcut(key({ key: "F", metaKey: true }))).toBe(true);
  });

  it("rejects a bare F, and every modifier that belongs to someone else", () => {
    expect(isPreviewFindShortcut(key({}))).toBe(false);
    // Mod+Shift+F is Find-in-Files.
    expect(isPreviewFindShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPreviewFindShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPreviewFindShortcut(key({ key: "g", metaKey: true }))).toBe(false);
  });
});

describe("ownsGlobalFind", () => {
  /** Mount a preview-shaped container, optionally inside a pane. */
  function mount({ pane, focused }: { pane: boolean; focused?: boolean }): HTMLElement {
    const host = document.createElement("div");
    if (pane) {
      host.className = focused ? "pane pane--focused" : "pane";
      document.body.append(host);
    } else {
      document.body.append(host);
    }
    const preview = document.createElement("div");
    preview.className = "markdown-preview";
    preview.tabIndex = -1;
    host.append(preview);
    return preview;
  }

  it("claims the key when focus is already inside the preview", () => {
    const preview = mount({ pane: true, focused: false });
    const input = document.createElement("input");
    preview.append(input);
    input.focus();
    expect(preview.contains(document.activeElement)).toBe(true);

    // Two-sided: the pane is NOT focused, so this can only be the focus rule.
    expect(ownsGlobalFind(preview)).toBe(true);
  });

  it("defers to the FOCUSED pane when focus is elsewhere", () => {
    const inFocusedPane = mount({ pane: true, focused: true });
    const inBackgroundSplit = mount({ pane: true, focused: false });

    expect(ownsGlobalFind(inFocusedPane)).toBe(true);
    expect(ownsGlobalFind(inBackgroundSplit)).toBe(false);
  });

  it("a lone preview outside the pane layout owns the key; two of them own nothing", () => {
    const only = mount({ pane: false });
    expect(ownsGlobalFind(only)).toBe(true);

    const second = mount({ pane: false });
    expect(ownsGlobalFind(only)).toBe(false);
    expect(ownsGlobalFind(second)).toBe(false);
  });
});

describe("isEditableTarget", () => {
  function preview(): HTMLElement {
    const el = document.createElement("div");
    el.className = "markdown-preview";
    document.body.append(el);
    return el;
  }

  it("is true for a text field outside the preview", () => {
    const el = preview();
    const outside = document.createElement("input");
    document.body.append(outside);

    expect(isEditableTarget(outside, el)).toBe(true);
  });

  it("is true for a contenteditable outside the preview (CodeMirror's shape)", () => {
    const el = preview();
    const cm = document.createElement("div");
    cm.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    cm.append(inner);
    document.body.append(cm);

    // Walks UP from the real target, which is a child of the editable host.
    expect(isEditableTarget(inner, el)).toBe(true);
  });

  it("is false for contenteditable=false — that is ordinary content", () => {
    const el = preview();
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "false");
    document.body.append(div);

    expect(isEditableTarget(div, el)).toBe(false);
  });

  it("is false for our OWN find input — inside the preview is ours by definition", () => {
    const el = preview();
    const input = document.createElement("input");
    el.append(input);

    expect(isEditableTarget(input, el)).toBe(false);
  });

  it("is false for a plain element and for a non-Element target", () => {
    const el = preview();
    const p = document.createElement("p");
    document.body.append(p);

    expect(isEditableTarget(p, el)).toBe(false);
    expect(isEditableTarget(null, el)).toBe(false);
    // `window` is a real EventTarget that is not an Element.
    expect(isEditableTarget(window, el)).toBe(false);
  });
});
