/** Multi-line fixtures use text nodes containing `\n`, never two blocks: jsdom's
 * `Selection.toString()` adds no line breaks between blocks, so such a test would pass against
 * nothing. The surfaces that use this rule are tested where they live. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { SEED_MAX, domSelectionSeed, seedFromSelectionText } from "./selectionSeed";

afterEach(() => {
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("seedFromSelectionText — the rule", () => {
  it("seeds a non-empty single-line selection verbatim", () => {
    expect(seedFromSelectionText("beta")).toBe("beta");
  });

  it("does not trim: two spaces is a legitimate search for two spaces", () => {
    // The editor's find bar seeds whitespace; trimming here would make the
    // other five surfaces disagree with it.
    expect(seedFromSelectionText("  ")).toBe("  ");
  });

  it("declines nothing-selected in all three shapes a caller can hand over", () => {
    // `null` is a DOM surface with no range, `undefined` is a registry lookup
    // that found no terminal, `""` is a collapsed caret.
    expect(seedFromSelectionText(null)).toBeNull();
    expect(seedFromSelectionText(undefined)).toBeNull();
    expect(seedFromSelectionText("")).toBeNull();
  });

  it("declines a MULTI-LINE selection — the bar keeps whatever query it had", () => {
    // VS Code's `getSelectionSearchString` does exactly this. Scoping a search
    // *to* a selection is a different feature (`autoFindInSelection`, off by
    // default); Chrome seeds multi-line, and we deliberately do not follow it.
    expect(seedFromSelectionText("alpha\nbeta")).toBeNull();
    expect(seedFromSelectionText("alpha\r\nbeta")).toBeNull();
    expect(seedFromSelectionText("alpha\rbeta")).toBeNull();
    // A trailing break still spans lines, even with nothing after it.
    expect(seedFromSelectionText("alpha\n")).toBeNull();
  });

  it("declines a selection longer than SEED_MAX — that is a paragraph, not a query", () => {
    expect(seedFromSelectionText("x".repeat(SEED_MAX))).toBe("x".repeat(SEED_MAX));
    expect(seedFromSelectionText("x".repeat(SEED_MAX + 1))).toBeNull();
  });
});

describe("domSelectionSeed — reading the document selection", () => {
  /** A container with `text` in ONE text node, mounted so ranges are live. */
  function mount(text: string): HTMLElement {
    const host = document.createElement("div");
    host.append(document.createTextNode(text));
    document.body.append(host);
    return host;
  }

  /** Select `[from, to)` of `node`'s text. */
  function select(node: Node, from: number, to: number): void {
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it("seeds from a selection inside the container", () => {
    const host = mount("alpha beta gamma");
    select(host.firstChild as Node, 6, 10);
    expect(domSelectionSeed(host)).toBe("beta");
  });

  it("returns null when nothing is selected", () => {
    // The default state of every surface, and the behaviour that must not
    // regress: no selection means the bar opens exactly as it always has.
    const host = mount("alpha beta");
    expect(domSelectionSeed(host)).toBeNull();
  });

  it("returns null for a collapsed caret inside the container", () => {
    const host = mount("alpha beta");
    select(host.firstChild as Node, 3, 3);
    expect(domSelectionSeed(host)).toBeNull();
  });

  it("returns null when the selection lives in ANOTHER surface", () => {
    // The A/B compare case: two response bodies side by side. Selecting in one
    // and pressing Cmd/Ctrl+F over the other must not cross-seed.
    const mine = mount("alpha beta");
    const theirs = mount("gamma delta");
    select(theirs.firstChild as Node, 0, 5);
    expect(domSelectionSeed(mine)).toBeNull();
    expect(domSelectionSeed(theirs)).toBe("gamma");
  });

  it("counts a selection whose common ancestor IS the container", () => {
    // `commonAncestorContainer` is the container itself and `Node.contains` is true for its own
    // node, which is why the check uses `contains` rather than a strict descendant test.
    const host = document.createElement("div");
    host.innerHTML = "<span>alpha</span><span>beta</span>";
    document.body.append(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(domSelectionSeed(host)).toBe("alphabeta");
  });

  it("returns null when the selection spans a line break", () => {
    const host = mount("alpha\nbeta");
    select(host.firstChild as Node, 0, 10);
    expect(domSelectionSeed(host)).toBeNull();
  });

  it("returns null where the document has no selection API at all", () => {
    // `Document.getSelection()` is specified to return null for a document with
    // no browsing context. Never seen in the app; the typed contract says it can
    // happen, so the reader answers it rather than throwing.
    const host = mount("alpha beta");
    select(host.firstChild as Node, 0, 5);
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    expect(domSelectionSeed(host)).toBeNull();
  });
});
