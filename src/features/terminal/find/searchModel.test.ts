/**
 * The pure logic of find-in-terminal: platform shortcut matching,
 * the k/N counter, and the exact ISearchOptions handed to @xterm/addon-search.
 * These are the parts a regression would silently corrupt — tested hard.
 */

import { describe, expect, it } from "vitest";

import {
  buildSearchOptions,
  DEFAULT_SEARCH_UI,
  formatMatchCount,
  isFindShortcut,
  SEARCH_DECORATIONS,
  type FindShortcutKey,
} from "./searchModel";

function key(over: Partial<FindShortcutKey>): FindShortcutKey {
  return { key: "f", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over };
}

describe("isFindShortcut", () => {
  it("matches Cmd+F on macOS", () => {
    expect(isFindShortcut(key({ metaKey: true }), true)).toBe(true);
  });

  it("matches Ctrl+F elsewhere", () => {
    expect(isFindShortcut(key({ ctrlKey: true }), false)).toBe(true);
  });

  it("is case-insensitive on the key (Shift is excluded separately)", () => {
    expect(isFindShortcut(key({ key: "F", metaKey: true }), true)).toBe(true);
  });

  it("does NOT steal Ctrl+F on macOS — that is forward-char in the shell", () => {
    expect(isFindShortcut(key({ ctrlKey: true }), true)).toBe(false);
  });

  it("does not match Cmd+F on non-mac (no meta binding there)", () => {
    expect(isFindShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it("leaves Cmd/Ctrl+Shift+F to Find-in-Files", () => {
    expect(isFindShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isFindShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("ignores Alt combinations and bare F", () => {
    expect(isFindShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isFindShortcut(key({}), true)).toBe(false);
    expect(isFindShortcut(key({}), false)).toBe(false);
  });

  it("ignores other keys with the modifier held", () => {
    expect(isFindShortcut(key({ key: "g", metaKey: true }), true)).toBe(false);
    expect(isFindShortcut(key({ key: "Escape", ctrlKey: true }), false)).toBe(false);
  });
});

describe("formatMatchCount", () => {
  it("is empty with no query (an empty search is not an error)", () => {
    expect(formatMatchCount(null, false)).toBe("");
    expect(formatMatchCount({ resultIndex: 0, resultCount: 3 }, false)).toBe("");
  });

  it("is empty while the first search is still debouncing (no event yet)", () => {
    expect(formatMatchCount(null, true)).toBe("");
  });

  it('says "No results" for zero matches', () => {
    expect(formatMatchCount({ resultIndex: -1, resultCount: 0 }, true)).toBe("No results");
  });

  it("renders k/N 1-based", () => {
    expect(formatMatchCount({ resultIndex: 0, resultCount: 5 }, true)).toBe("1/5");
    expect(formatMatchCount({ resultIndex: 4, resultCount: 5 }, true)).toBe("5/5");
  });

  it("renders N+ when the addon exceeded its highlight limit (resultIndex -1)", () => {
    expect(formatMatchCount({ resultIndex: -1, resultCount: 1000 }, true)).toBe("1000+");
  });
});

describe("buildSearchOptions", () => {
  it("always enables decorations — they highlight all matches AND drive onDidChangeResults", () => {
    const opts = buildSearchOptions(DEFAULT_SEARCH_UI);
    expect(opts.decorations).toBe(SEARCH_DECORATIONS);
  });

  it("passes the three toggles through", () => {
    expect(buildSearchOptions({ caseSensitive: true, wholeWord: false, regex: false })).toMatchObject({
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
    expect(buildSearchOptions({ caseSensitive: false, wholeWord: true, regex: true })).toMatchObject({
      caseSensitive: false,
      wholeWord: true,
      regex: true,
    });
  });

  it("never sets `incremental` — the addon's default find WRAPS around the buffer, and incremental would pin the selection instead of advancing it", () => {
    const opts = buildSearchOptions(DEFAULT_SEARCH_UI);
    expect(opts).not.toHaveProperty("incremental");
    // Pin the exact option surface: anything extra here changes addon behavior.
    expect(Object.keys(opts).sort()).toEqual(["caseSensitive", "decorations", "regex", "wholeWord"]);
  });

  it("uses literal #RRGGBB colors (xterm decorations cannot resolve CSS vars)", () => {
    for (const color of Object.values(SEARCH_DECORATIONS)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
