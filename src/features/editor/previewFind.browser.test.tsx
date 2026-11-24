/**
 * Find-in-preview — layer 5, the real-browser tier (testing-strategy §1).
 *
 * The jsdom suites (`previewFind.test.ts`, `PreviewFindBar.test.tsx`, the seam
 * block in `MarkdownPreview.test.tsx`) pin the index, the arithmetic and the
 * wiring. They cannot pin the one thing the whole design rests on, because
 * jsdom ships neither `CSS.highlights` nor `Highlight` nor a layout engine:
 *
 *   1. **The CSS Custom Highlight API is really there, and really takes our
 *      Ranges.** This is the claim that justified choosing Ranges over `<mark>`
 *      injection in the first place (previewFind.ts's header: an injected node
 *      is erased by the next `innerHTML` assignment — and, inside
 *      an un-hydrated ```mermaid block, is read back as diagram SOURCE and
 *      rendered as "Diagram error"). In jsdom `paintHighlights` is a documented
 *      no-op, so *every* jsdom assertion about painting is vacuous by
 *      construction. Here the registry is real: the ranges are read back out of
 *      it, the current match is a separate highlight, and its priority is what
 *      puts it on top.
 *   2. **The `::highlight()` rules survived the bundler and the parser.** A
 *      pseudo-element the engine does not understand is dropped from
 *      `cssRules` silently, which would leave the search working and invisible
 *      — the exact failure nobody would notice in a test suite.
 *   3. **The highlight survives the preview's CSS `zoom`.** The rule for this
 *      component is to MEASURE the zoom's effect rather than reason about it
 *      (only a layout property magnifies a document). A `Range`
 *      is a live position, so a zoomed match must report a proportionally
 *      larger rect in the same place — under `transform: scale` this would be a
 *      raster claim; under `zoom` it is a layout one, and only a layout engine
 *      can settle it.
 *   4. **The bar itself does NOT zoom.** It is a sibling of
 *      `.markdown-preview__body`, not a child, precisely so the body's `zoom`
 *      cannot reach it — the same hazard the Fit control needed
 *      `zoom: calc(1 / var(--mdp-zoom))` for. No CSS runs under jsdom, so this
 *      claim can only live here.
 *   5. **The current match is scrolled into view.** `scrollIntoView` does not
 *      exist in jsdom (the call site is optional for exactly that reason), and
 *      "below the fold" is a property only a real scroll box has.
 *
 * What this tier still CANNOT prove is the pixels' COLOUR: a painted highlight
 * has no DOM observable, and `getComputedStyle` has no ::highlight surface.
 * Claims 1-3 pin the mechanism that produces it — the registry holds the right
 * live Ranges, the rules parsed, and the geometry follows the zoom — and that
 * is stated plainly rather than dressed up as a paint assertion.
 *
 * The fixture is plain markdown ON PURPOSE, following
 * `markdownPreviewZoom.browser.test.tsx`: mermaid renders async and
 * nondeterministically, and images would reach for the un-stubbed image-read
 * IPC.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts \
 *        src/features/editor/previewFind.browser.test.tsx`
 */

import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { MarkdownPreview } from "./MarkdownPreview";
import { FIND_HIGHLIGHT, currentHighlightName } from "./previewFind";

/** Tall, deliberately narrow content. "needle" appears once per paragraph, and
 *  the last one is 40 paragraphs down — far below the fold at any zoom. */
const DOC = [
  "# Find fixture",
  "",
  "A needle in the first paragraph.",
  "",
  ...Array.from({ length: 40 }, (_, i) => [`Paragraph ${i} — short line.`, ""]).flat(),
  "Another **needle**, right at the bottom.",
].join("\n");

/** The preview in a definite 600×400 box (`.markdown-preview` is height:100%). */
const view = (zoom: number): React.JSX.Element => (
  <div style={{ width: 600, height: 400 }}>
    <MarkdownPreview text={DOC} zoom={zoom} />
  </div>
);

/** The real usage shape for claim 5 — a parent owning the zoom, as CodeEditor
 *  does through the store. */
function Harness({ initial }: { initial: number }): React.JSX.Element {
  const [zoom, setZoom] = useState(initial);
  return (
    <div style={{ width: 600, height: 400 }}>
      <MarkdownPreview text={DOC} zoom={zoom} onZoomChange={setZoom} />
    </div>
  );
}

const container = (): HTMLElement => screen.getByTestId("markdown-preview");
const body = (): HTMLElement =>
  container().querySelector<HTMLElement>(".markdown-preview__body")!;

/** Open the bar and type a query, the way a user does. */
function search(query: string): void {
  fireEvent.keyDown(container(), { key: "f", metaKey: true });
  fireEvent.change(screen.getByTestId("preview-find-input"), { target: { value: query } });
}

/**
 * The live Ranges a highlight holds. `CSS.highlights` is Maplike and `Highlight`
 * is Setlike at runtime; TypeScript's lib.dom exposes only `forEach` on both, so
 * the read goes through a structural cast rather than a `Map` assumption.
 */
function highlightRanges(name: string): AbstractRange[] {
  const registry = CSS.highlights as unknown as { get(n: string): Highlight | undefined };
  const out: AbstractRange[] = [];
  registry.get(name)?.forEach((range) => out.push(range));
  return out;
}

function highlightPriority(name: string): number | undefined {
  const registry = CSS.highlights as unknown as { get(n: string): Highlight | undefined };
  return registry.get(name)?.priority;
}

/** Every selector this document's stylesheets successfully PARSED. A rule the
 *  engine cannot understand is dropped from `cssRules`, so its absence here is
 *  the failure mode claim 2 is about. */
function parsedSelectors(): string[] {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    // Same-origin only; a cross-origin sheet throws on `cssRules`. Vite serves
    // ours from the test origin, so this never fires for the rules we care about.
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) out.push(rule.selectorText);
    }
  }
  return out;
}

describe("find in the rendered preview — real Chromium", () => {
  it("registers every match with the REAL CSS Custom Highlight API", () => {
    // The vacuity guard, and the whole reason this file exists: in jsdom the
    // next line is false and `paintHighlights` is a no-op, so every painting
    // assertion in that tier is true of nothing.
    expect(typeof CSS.highlights).toBe("object");
    expect(typeof Highlight).toBe("function");

    render(view(1));
    search("needle");

    expect(screen.getByTestId("preview-find-count")).toHaveTextContent("1/2");

    const all = highlightRanges(FIND_HIGHLIGHT);
    const current = highlightRanges(currentHighlightName(FIND_HIGHLIGHT));
    expect(all).toHaveLength(2);
    expect(current).toHaveLength(1);
    // They are LIVE ranges over the preview's own text, not copies of it.
    expect(all.map((r) => (r as Range).toString())).toEqual(["needle", "needle"]);
    expect(current[0]).toBe(all[0]);
    expect(body().contains((all[0] as Range).startContainer)).toBe(true);
    // Priority, not registration order, is what keeps the current match on top
    // where the two highlights overlap — and they always overlap.
    expect(highlightPriority(currentHighlightName(FIND_HIGHLIGHT))).toBe(1);
    expect(highlightPriority(FIND_HIGHLIGHT)).toBe(0);

    // Walking the matches moves the current highlight, in the real registry.
    fireEvent.click(screen.getByTestId("preview-find-next"));
    expect(highlightRanges(currentHighlightName(FIND_HIGHLIGHT))[0]).toBe(all[1]);

    // …and closing retires both, so a shut bar leaves no colour behind.
    fireEvent.click(screen.getByTestId("preview-find-close"));
    expect(highlightRanges(FIND_HIGHLIGHT)).toHaveLength(0);
    expect(highlightRanges(currentHighlightName(FIND_HIGHLIGHT))).toHaveLength(0);
  });

  it("ships ::highlight() rules the engine actually parsed", () => {
    render(view(1));
    const selectors = parsedSelectors();

    // Two-sided: a control selector from the same stylesheet proves the sheet
    // loaded at all, so a missing ::highlight rule means the RULE was dropped
    // (unsupported pseudo-element, or a bundler that mangled it) rather than
    // the file never having been imported.
    expect(selectors).toContain(".preview-find__count");
    expect(selectors.some((s) => s.includes(`::highlight(${FIND_HIGHLIGHT})`))).toBe(true);
    expect(
      selectors.some((s) => s.includes(`::highlight(${currentHighlightName(FIND_HIGHLIGHT)})`)),
    ).toBe(true);
  });

  it("keeps the highlight on the text through a CSS zoom — measured, not reasoned", () => {
    // The rule for this component. A `Range` is a live position, so a
    // zoomed match must report a proportionally bigger rect in the same place.
    const { rerender } = render(view(1));
    search("needle");

    const at1 = (highlightRanges(FIND_HIGHLIGHT)[0] as Range).getBoundingClientRect();
    // Real layout: under jsdom every rect is 0×0 and every claim below is
    // vacuously true.
    expect(at1.width).toBeGreaterThan(10);
    expect(at1.height).toBeGreaterThan(5);

    rerender(view(2));

    // The same Range object, still attached, still describing the same text.
    const ranges = highlightRanges(FIND_HIGHLIGHT);
    expect(ranges).toHaveLength(2);
    expect((ranges[0] as Range).toString()).toBe("needle");
    const at2 = (ranges[0] as Range).getBoundingClientRect();

    // Twice as big on screen, which is what "the highlight follows the text"
    // means for a layout zoom. -1 precision = within ~5px, which absorbs
    // Chromium's device-pixel rounding.
    expect(at2.width).toBeCloseTo(at1.width * 2, -1);
    expect(at2.height).toBeCloseTo(at1.height * 2, -1);
    // …and it is still inside the body it belongs to, not floating off it.
    const bodyRect = body().getBoundingClientRect();
    expect(at2.left).toBeGreaterThanOrEqual(bodyRect.left - 1);
    expect(at2.right).toBeLessThanOrEqual(bodyRect.right + 1);
  });

  it("keeps the find bar the SAME SIZE ON SCREEN at 100% and at 400%", () => {
    // The bar is a SIBLING of `.markdown-preview__body`, never a child, because
    // the body carries the inline `zoom` and nested zoom multiplies — the exact
    // hazard the Fit control needs `zoom: calc(1 / var(--mdp-zoom))` for. Move
    // the bar inside the body and this goes red at 4x.
    const { rerender } = render(view(1));
    search("needle");

    const at1 = screen.getByTestId("preview-find").getBoundingClientRect();
    expect(at1.width).toBeGreaterThan(100); // a real, laid-out bar
    expect(at1.height).toBeGreaterThan(10);
    const textAt1 = (highlightRanges(FIND_HIGHLIGHT)[0] as Range).getBoundingClientRect().width;

    rerender(view(4));

    // The zoom really is doing visible work to the bar's neighbours — the
    // control group for the assertion below.
    expect(Number(body().style.zoom)).toBeCloseTo(4, 4);
    expect(
      (highlightRanges(FIND_HIGHLIGHT)[0] as Range).getBoundingClientRect().width,
    ).toBeCloseTo(textAt1 * 4, -1);

    const at4 = screen.getByTestId("preview-find").getBoundingClientRect();
    expect(Math.abs(at4.width - at1.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(at4.height - at1.height)).toBeLessThanOrEqual(1);
  });

  it("takes focus from a REAL click, so the container-scoped shortcut is reachable", async () => {
    // `tabIndex={-1}` makes a scroll container focusable-but-not-tabbable, and
    // real browsers focus the nearest focusable ANCESTOR on mousedown. jsdom
    // implements none of that — it never moves focus on a click — so this is the
    // only tier that can say whether clicking the preview and pressing Cmd+F
    // works without the window fallback carrying it.
    render(view(1));
    const el = container();
    expect(el.tabIndex).toBe(-1);
    document.body.focus();
    expect(el.contains(document.activeElement)).toBe(false);

    // A REAL click, driven through the browser's own input pipeline. A
    // synthetic `fireEvent.mouseDown` is not enough and the difference matters:
    // focusing the nearest focusable ancestor is a USER-AGENT action on real
    // input, not a side effect any dispatched event carries. Measured, not
    // assumed — a dispatched mousedown leaves focus on <body>, which is exactly
    // what makes the window-level fallback load-bearing rather than belt-and-
    // braces for the tests.
    const paragraph = el.querySelector("p") as HTMLElement;
    await userEvent.click(paragraph);

    expect(document.activeElement).toBe(el);
  });

  it("scrolls a match that was below the fold into view", () => {
    // `scrollIntoView` does not exist in jsdom — the call site is optional-
    // chained for exactly that reason — so this behaviour has no detector
    // anywhere else. The second "needle" is 40 paragraphs down.
    render(<Harness initial={1} />);
    const el = container();
    el.scrollTop = 0;
    expect(el.scrollTop).toBe(0);

    search("needle");
    const second = highlightRanges(FIND_HIGHLIGHT)[1] as Range;
    // Vacuity guard: it really does start below the bottom edge of the pane.
    const port = el.getBoundingClientRect();
    expect(second.getBoundingClientRect().top).toBeGreaterThan(port.bottom);

    fireEvent.click(screen.getByTestId("preview-find-next"));

    // Two-sided: it scrolled, AND it landed inside the scrollport.
    expect(el.scrollTop).toBeGreaterThan(0);
    const now = second.getBoundingClientRect();
    const after = el.getBoundingClientRect();
    expect(now.top).toBeGreaterThanOrEqual(after.top - 1);
    expect(now.bottom).toBeLessThanOrEqual(after.bottom + 1);
  });
});
