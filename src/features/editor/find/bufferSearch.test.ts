/** jsdom's navigator is non-Mac, so Mod == Ctrl here. */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getSearchQuery, search, searchPanelOpen } from "@codemirror/search";

import { bufferSearch, openFindPanel } from "./bufferSearch";
import { listMatches } from "./findModel";
import {
  barOf,
  inputOf,
  makeView,
  pressKey,
  stubGeometry,
  typeQuery,
} from "./cmTestKit";
import type { Harness } from "./cmTestKit";

beforeAll(() => stubGeometry());

let h: Harness | null = null;
afterEach(() => {
  h?.destroy();
  h = null;
});

const make = (doc: string, selection?: { anchor: number; head?: number }) => {
  h = makeView(doc, bufferSearch(), selection);
  return h.view;
};

describe("Mod-f", () => {
  it("opens the panel exactly once and focuses the input", () => {
    const view = make("hello world");
    expect(barOf(view)).toBeNull();

    const event = pressKey(view.contentDOM, "f", { ctrl: true });
    expect(event.defaultPrevented).toBe(true); // nothing above CM sees it
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(view.dom.querySelectorAll(".find-bar")).toHaveLength(1);
    expect(document.activeElement).toBe(inputOf(view));
  });

  it("a second Mod-f does not open a second panel — it refocuses + selects the input", () => {
    const view = make("hello world");
    pressKey(view.contentDOM, "f", { ctrl: true });
    typeQuery(view, "world");
    const input = inputOf(view)!;
    input.setSelectionRange(2, 2); // caret parked mid-query
    input.blur();

    // Focus is wherever the user left it; the second Mod-f goes through the
    // panel's search-panel scope when the input has focus, or the editor
    // scope otherwise. Exercise the editor-scope path first…
    pressKey(view.contentDOM, "f", { ctrl: true });
    expect(view.dom.querySelectorAll(".find-bar")).toHaveLength(1); // exactly once
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("world"); // query kept
    expect(input.selectionStart).toBe(0); // …and select-all'd
    expect(input.selectionEnd).toBe("world".length);

    // …then the in-panel path (keydown lands on the focused input).
    input.setSelectionRange(1, 1);
    const event = pressKey(input, "f", { ctrl: true });
    expect(event.defaultPrevented).toBe(true);
    expect(view.dom.querySelectorAll(".find-bar")).toHaveLength(1);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("world".length);
  });

  it("seeds from a single-line selection when opened via the keyboard", () => {
    const view = make("alpha beta alpha", { anchor: 6, head: 10 }); // "beta"
    pressKey(view.contentDOM, "f", { ctrl: true });
    expect(inputOf(view)!.value).toBe("beta");
    expect(getSearchQuery(view.state).search).toBe("beta");
  });

  it("re-seeds an already-open panel when Mod-f fires with a new selection", () => {
    const view = make("alpha beta alpha");
    pressKey(view.contentDOM, "f", { ctrl: true });
    typeQuery(view, "alpha");

    view.dispatch({ selection: { anchor: 6, head: 10 } }); // select "beta"
    pressKey(view.contentDOM, "f", { ctrl: true });
    expect(inputOf(view)!.value).toBe("beta");
  });

  it("openFindPanel degrades gracefully on a view running a foreign search panel", () => {
    // With the stock CM search() panel there is no `.find-bar` input, so the focus step is skipped.
    h = makeView("abc", search());
    expect(openFindPanel(h.view)).toBe(true);
    expect(searchPanelOpen(h.view.state)).toBe(true);
    expect(barOf(h.view)).toBeNull(); // stock panel, not ours
  });

  /* The shared rule (`selectionSeed.ts`): pin the two rejections so sharing it cannot widen it. */

  it("a MULTI-LINE selection leaves the query UNTOUCHED — not cleared", () => {
    const view = make("alpha\nbeta");
    pressKey(view.contentDOM, "f", { ctrl: true });
    typeQuery(view, "gamma");

    view.dispatch({ selection: { anchor: 0, head: 8 } }); // spans the line break
    pressKey(view.contentDOM, "f", { ctrl: true });

    expect(inputOf(view)!.value).toBe("gamma");
    expect(getSearchQuery(view.state).search).toBe("gamma");
  });

  it("a selection longer than the cap leaves the query UNTOUCHED", () => {
    const view = make("x".repeat(300));
    pressKey(view.contentDOM, "f", { ctrl: true });
    typeQuery(view, "gamma");

    view.dispatch({ selection: { anchor: 0, head: 201 } });
    pressKey(view.contentDOM, "f", { ctrl: true });

    expect(inputOf(view)!.value).toBe("gamma");
  });

  it("keeps the toggles across a selection re-seed", () => {
    const view = make("Beta beta", { anchor: 0, head: 4 });
    pressKey(view.contentDOM, "f", { ctrl: true });
    view.dom
      .querySelector<HTMLButtonElement>('.find-bar__toggle[aria-label="Match case"]')!
      .click();
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);

    view.dispatch({ selection: { anchor: 5, head: 9 } }); // "beta"
    pressKey(view.contentDOM, "f", { ctrl: true });
    const q = getSearchQuery(view.state);
    expect(q.search).toBe("beta");
    expect(q.caseSensitive).toBe(true); // flag survived the re-seed
  });
});

describe("Escape", () => {
  it("closes an open panel", () => {
    const view = make("abc");
    pressKey(view.contentDOM, "f", { ctrl: true });
    expect(searchPanelOpen(view.state)).toBe(true);

    const event = pressKey(view.contentDOM, "Escape");
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(barOf(view)).toBeNull();
    expect(event.defaultPrevented).toBe(true); // the binding handled it
  });

  it("falls through when the panel is closed (other Escape handlers keep working)", () => {
    const view = make("abc");
    const event = pressKey(view.contentDOM, "Escape");
    expect(event.defaultPrevented).toBe(false); // closeFindPanel returned false
  });
});

describe("F3 / Mod-g", () => {
  const doc = "x a x a x a";
  const spec = { search: "a", caseSensitive: false, wholeWord: false, regexp: false };

  it("F3 advances to the next match (with wrap), Shift-F3 goes back", () => {
    const view = make(doc);
    pressKey(view.contentDOM, "f", { ctrl: true });
    typeQuery(view, "a");
    const matches = listMatches(spec, doc);
    expect(matches).toHaveLength(3);

    pressKey(view.contentDOM, "F3");
    let sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[0].from, matches[0].to]);

    pressKey(view.contentDOM, "F3");
    sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[1].from, matches[1].to]);

    pressKey(view.contentDOM, "F3", { shift: true });
    sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[0].from, matches[0].to]);
  });

  it("Mod-g advances too, including from inside the input", () => {
    const view = make(doc);
    pressKey(view.contentDOM, "f", { ctrl: true });
    typeQuery(view, "a");
    const matches = listMatches(spec, doc);

    pressKey(inputOf(view)!, "g", { ctrl: true }); // panel scope → findNext
    const sel = view.state.selection.main;
    expect([sel.from, sel.to]).toEqual([matches[0].from, matches[0].to]);
  });
});
