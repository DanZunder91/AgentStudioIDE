/** Real EditorView under jsdom (cmTestKit stubs geometry); scroll and layout are browser-tier. */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { searchPanelOpen } from "@codemirror/search";

import { bufferSearch, openFindPanel } from "./bufferSearch";
import { listMatches } from "./findModel";
import {
  barOf,
  closeBtnOf,
  countOf,
  inputOf,
  makeView,
  navOf,
  pressKey,
  stubGeometry,
  toggleOf,
  typeQuery,
} from "./cmTestKit";
import type { Harness } from "./cmTestKit";

beforeAll(() => stubGeometry());

let h: Harness | null = null;
afterEach(() => {
  h?.destroy();
  h = null;
});

const open = (doc: string, selection?: { anchor: number; head?: number }) => {
  h = makeView(doc, bufferSearch(), selection);
  openFindPanel(h.view);
  return h.view;
};

describe("open + seeding", () => {
  it("seeds the input from a non-empty single-line selection, text selected", () => {
    const view = open("hello world hello", { anchor: 0, head: 5 });
    const input = inputOf(view)!;
    expect(input.value).toBe("hello");
    // select-all so the next keystroke replaces the seed, IntelliJ-style
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("hello".length);
    // the selection (0,5) IS match 1 of 2 → k/N
    expect(countOf(view)!.textContent).toBe("1/2");
  });

  it("does NOT seed from a multi-line selection — keeps the last query", () => {
    const view = open("aaa\nbbb");
    typeQuery(view, "bbb");
    pressKey(inputOf(view)!, "Escape");
    expect(searchPanelOpen(view.state)).toBe(false);

    view.dispatch({ selection: { anchor: 1, head: 5 } }); // spans the newline
    openFindPanel(view);
    expect(inputOf(view)!.value).toBe("bbb"); // previous query survived
  });

  it("reopening with no selection keeps the previous query", () => {
    const view = open("foo bar foo");
    typeQuery(view, "bar");
    closeBtnOf(view)!.click();
    expect(barOf(view)).toBeNull();

    openFindPanel(view);
    expect(inputOf(view)!.value).toBe("bar");
    expect(countOf(view)!.textContent).toBe("1 result");
  });
});

describe("live count", () => {
  it("shows 0 results for an empty query, then counts as you type", () => {
    const view = open("abc abc abc");
    expect(countOf(view)!.textContent).toBe("0 results");
    typeQuery(view, "abc");
    expect(countOf(view)!.textContent).toBe("3 results");
  });

  it("a same-value input event (e.g. pasting identical text) refreshes without a redundant dispatch", () => {
    const view = open("abc abc");
    typeQuery(view, "abc");
    expect(countOf(view)!.textContent).toBe("2 results");

    // Browsers fire `input` events that leave the committed query identical
    // (select-all + paste of the same text, IME composition). The commit must
    // take the no-dispatch path and still leave the readout correct.
    typeQuery(view, "abc");
    expect(countOf(view)!.textContent).toBe("2 results");
    expect(inputOf(view)!.classList.contains("find-bar__input--error")).toBe(false);
  });

  it("a transaction that changes neither doc, selection, nor query leaves the bar untouched", () => {
    const view = open("abc abc");
    typeQuery(view, "abc");
    const before = countOf(view)!.textContent;

    view.dispatch({}); // effect-less, change-less transaction (e.g. annotations)
    expect(countOf(view)!.textContent).toBe(before);
    expect(barOf(view)).not.toBeNull();
  });

  it("updates the count when the document changes", () => {
    const view = open("foo foo");
    typeQuery(view, "foo");
    expect(countOf(view)!.textContent).toBe("2 results");

    view.dispatch({ changes: { from: view.state.doc.length, insert: " foo" } });
    expect(countOf(view)!.textContent).toBe("3 results");

    view.dispatch({ changes: { from: 0, to: 4, insert: "" } }); // delete "foo "
    expect(countOf(view)!.textContent).toBe("2 results");
  });

  it("flags a non-empty query with no matches as an error on the input", () => {
    const view = open("abc");
    const input = inputOf(view)!;
    typeQuery(view, "zzz");
    expect(countOf(view)!.textContent).toBe("0 results");
    expect(input.classList.contains("find-bar__input--error")).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    typeQuery(view, "abc"); // recovers
    expect(input.classList.contains("find-bar__input--error")).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});

describe("toggles", () => {
  it("Cc flips aria-pressed and re-runs the query immediately", () => {
    const view = open("Foo foo");
    typeQuery(view, "foo");
    expect(countOf(view)!.textContent).toBe("2 results");

    const cc = toggleOf(view, "Match case")!;
    expect(cc.getAttribute("aria-pressed")).toBe("false");
    cc.click();
    expect(cc.getAttribute("aria-pressed")).toBe("true");
    expect(countOf(view)!.textContent).toBe("1 result");

    cc.click(); // and back
    expect(cc.getAttribute("aria-pressed")).toBe("false");
    expect(countOf(view)!.textContent).toBe("2 results");
  });

  it("W (whole word) drops embedded matches", () => {
    const view = open("cat catalog");
    typeQuery(view, "cat");
    expect(countOf(view)!.textContent).toBe("2 results");
    toggleOf(view, "Words")!.click();
    expect(countOf(view)!.textContent).toBe("1 result");
  });

  it("a recreated panel is born with active toggles already pressed", () => {
    const view = open("Foo foo");
    typeQuery(view, "foo");
    toggleOf(view, "Match case")!.click();
    expect(countOf(view)!.textContent).toBe("1 result");

    pressKey(inputOf(view)!, "Escape"); // destroys the panel DOM…
    expect(barOf(view)).toBeNull();

    openFindPanel(view); // …and a fresh one is BUILT from the persisted query
    expect(toggleOf(view, "Match case")!.getAttribute("aria-pressed")).toBe("true");
    expect(toggleOf(view, "Words")!.getAttribute("aria-pressed")).toBe("false");
    expect(inputOf(view)!.value).toBe("foo");
    expect(countOf(view)!.textContent).toBe("1 result");
  });

  it(".* turns the query into a regexp; an invalid one goes red, no crash", () => {
    const view = open("f fo foo");
    typeQuery(view, "fo+");
    expect(countOf(view)!.textContent).toBe("0 results"); // literal "fo+" absent

    const re = toggleOf(view, "Regex")!;
    re.click();
    expect(re.getAttribute("aria-pressed")).toBe("true");
    expect(countOf(view)!.textContent).toBe("2 results"); // fo, foo

    expect(() => typeQuery(view, "(unclosed")).not.toThrow();
    expect(countOf(view)!.textContent).toBe("0 results");
    expect(inputOf(view)!.classList.contains("find-bar__input--error")).toBe(true);
    expect(inputOf(view)!.title).toBe("Invalid regular expression");
  });
});

describe("navigation", () => {
  const doc = "a b a b a";
  const specOf = () => ({
    search: "a",
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
  });

  it("↓ walks the matches in order, lands the selection on each, and wraps", () => {
    const view = open(doc);
    typeQuery(view, "a");
    const matches = listMatches(specOf(), doc);
    expect(matches).toHaveLength(3);

    const next = navOf(view, "Next match")!;
    for (const [i, m] of matches.entries()) {
      next.click();
      const sel = view.state.selection.main;
      expect([sel.from, sel.to]).toEqual([m.from, m.to]); // selection ON match k
      expect(countOf(view)!.textContent).toBe(`${i + 1}/3`);
    }
    next.click(); // past the last → wraps to the first
    const sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[0].from, matches[0].to]);
    expect(countOf(view)!.textContent).toBe("1/3");
  });

  it("↑ wraps backwards past the start of the document", () => {
    const view = open(doc);
    typeQuery(view, "a");
    const matches = listMatches(specOf(), doc);

    navOf(view, "Previous match")!.click(); // from (0,0) → wraps to the LAST match
    const sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[2].from, matches[2].to]);
    expect(countOf(view)!.textContent).toBe("3/3");
  });

  it("Enter / Shift+Enter in the input = next / previous", () => {
    const view = open(doc);
    typeQuery(view, "a");
    const input = inputOf(view)!;
    const matches = listMatches(specOf(), doc);

    pressKey(input, "Enter");
    pressKey(input, "Enter");
    let sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[1].from, matches[1].to]);
    expect(countOf(view)!.textContent).toBe("2/3");

    pressKey(input, "Enter", { shift: true });
    sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[0].from, matches[0].to]);
    expect(countOf(view)!.textContent).toBe("1/3");
  });

  it("Enter on a bar element other than the input does not navigate", () => {
    const view = open(doc);
    typeQuery(view, "a");
    const before = view.state.selection.main;

    pressKey(navOf(view, "Next match")!, "Enter"); // keydown on the ↓ button
    const after = view.state.selection.main;
    expect([after.from, after.to]).toEqual([before.from, before.to]);
  });

  it("arrows and Enter are no-ops on an empty query", () => {
    const view = open(doc);
    const before = view.state.selection.main;
    navOf(view, "Next match")!.click();
    navOf(view, "Previous match")!.click();
    pressKey(inputOf(view)!, "Enter");
    const after = view.state.selection.main;
    expect([after.from, after.to]).toEqual([before.from, before.to]);
    expect(countOf(view)!.textContent).toBe("0 results");
  });
});

describe("closing", () => {
  it("✕ closes the panel", () => {
    const view = open("abc");
    expect(barOf(view)).not.toBeNull();
    closeBtnOf(view)!.click();
    expect(barOf(view)).toBeNull();
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it("Escape inside the input closes the panel", () => {
    const view = open("abc");
    const input = inputOf(view)!;
    expect(document.activeElement).toBe(input); // bar owns focus while open
    pressKey(input, "Escape");
    expect(barOf(view)).toBeNull();
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(document.activeElement).not.toBe(input); // focus handed back
  });
});
