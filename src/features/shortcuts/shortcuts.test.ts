/**
 * The shortcuts data module — the platform modifier + the grouped list that the
 * cheat sheet renders. Pure data, so a plain unit test pins it.
 */

import { afterEach, describe, expect, it } from "vitest";

import { isMac, isWindows, modChord, modKey, shortcutGroups } from "./shortcuts";

/** Override a read-only navigator field for one assertion, restoring after. */
function withNavigator(fields: Partial<Record<"userAgent" | "platform", string>>, run: () => void) {
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  for (const [k, v] of Object.entries(fields)) {
    saved[k] = Object.getOwnPropertyDescriptor(navigator, k);
    Object.defineProperty(navigator, k, { value: v, configurable: true });
  }
  try {
    run();
  } finally {
    for (const [k, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(navigator, k, desc);
    }
  }
}

describe("isMac", () => {
  it("is true on macOS", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel" }, () => {
      expect(isMac()).toBe(true);
    });
  });

  it("is false off macOS", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" }, () => {
      expect(isMac()).toBe(false);
    });
  });
});

describe("isWindows", () => {
  it("is true in WebView2 on Windows", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0", platform: "Win32" }, () => {
      expect(isWindows()).toBe(true);
    });
  });

  it("is false on macOS and Linux", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel" }, () => {
      expect(isWindows()).toBe(false);
    });
    withNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" }, () => {
      expect(isWindows()).toBe(false);
    });
  });

  it("is false under jsdom's own user agent even on a Windows dev box (`win32`)", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (win32) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.1.0" }, () => {
      expect(isWindows()).toBe(false);
    });
  });
});

describe("modKey", () => {
  it("is ⌘ on macOS", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel" }, () => {
      expect(modKey()).toBe("⌘");
    });
  });

  it("is Ctrl off macOS", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" }, () => {
      expect(modKey()).toBe("Ctrl");
    });
  });
});

describe("modChord", () => {
  it("is ⌘S on macOS", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel" }, () => {
      expect(modChord("S")).toBe("⌘S");
      expect(modChord("Shift+F")).toBe("⌘Shift+F");
    });
  });

  it("is Ctrl+S on Windows and Linux", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" }, () => {
      expect(modChord("S")).toBe("Ctrl+S");
    });
    withNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" }, () => {
      expect(modChord("Shift+F")).toBe("Ctrl+Shift+F");
    });
  });
});

describe("shortcutGroups", () => {
  afterEach(() => undefined);

  it("returns non-empty groups, each with at least one shortcut", () => {
    const groups = shortcutGroups();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.title).toBeTruthy();
      expect(g.shortcuts.length).toBeGreaterThan(0);
      for (const s of g.shortcuts) {
        expect(s.keys.length).toBeGreaterThan(0);
        expect(s.description).toBeTruthy();
      }
    }
  });

  it("resolves the platform modifier into the key chips", () => {
    withNavigator({ userAgent: "Macintosh", platform: "MacIntel" }, () => {
      const all = shortcutGroups().flatMap((g) => g.shortcuts);
      // Find in files is Mod+Shift+F — its first chip is the resolved modifier.
      const find = all.find((s) => s.description.startsWith("Find in files"))!;
      expect(find.keys).toEqual(["⌘", "Shift", "F"]);
      // Local find is plain Mod+F — one binding for editor AND terminal.
      const local = all.find((s) => s.description.startsWith("Find in the current"))!;
      expect(local.keys).toEqual(["⌘", "F"]);
    });
  });

  it("documents BOTH find overlays — project-wide and by name", () => {
    const search = shortcutGroups().find((g) => g.title === "Search")!;
    const rows = search.shortcuts;
    // Two-sided: the project-wide one was always here, the by-name one is
    // the row that was once absent — assert both, so deleting either
    // is a failure rather than a silently shorter list.
    expect(rows.find((s) => /project-wide/.test(s.description))!.keys).toEqual([
      modKey(),
      "Shift",
      "F",
    ]);
    expect(rows.find((s) => /by name/.test(s.description))!.keys).toEqual([
      modKey(),
      "Shift",
      "O",
    ]);
  });

  it("documents its own toggle (Mod+/) and the LSP navigation keys", () => {
    const descs = shortcutGroups()
      .flatMap((g) => g.shortcuts)
      .map((s) => s.description);
    expect(descs.some((d) => /shortcuts reference/i.test(d))).toBe(true);
    expect(descs.some((d) => /find usages/i.test(d))).toBe(true);
    expect(descs.some((d) => /go to definition/i.test(d))).toBe(true);
  });

  it("documents undo and redo, with the platform's own redo chord (same-commit rule)", () => {
    const editing = () => shortcutGroups().find((g) => g.title === "Editing")!;

    withNavigator({ userAgent: "Macintosh", platform: "MacIntel" }, () => {
      const rows = editing().shortcuts;
      expect(rows.find((s) => /^Undo/.test(s.description))!.keys).toEqual(["⌘", "Z"]);
      // macOS redo is ⇧⌘Z — `historyKeymap`'s `{ key: "Mod-y", mac: "Mod-Shift-z" }`.
      expect(rows.find((s) => /^Redo/.test(s.description))!.keys).toEqual(["⌘", "Shift", "Z"]);
    });

    // Two-sided: the redo chord is genuinely platform-dependent, not a constant
    // that happens to read correctly on the machine running the suite.
    withNavigator({ userAgent: "X11; Linux x86_64", platform: "Linux x86_64" }, () => {
      const rows = editing().shortcuts;
      expect(rows.find((s) => /^Undo/.test(s.description))!.keys).toEqual(["Ctrl", "Z"]);
      expect(rows.find((s) => /^Redo/.test(s.description))!.keys).toEqual(["Ctrl", "Y"]);
    });
  });

  it("says out loud that undo survives a save and a tab close (the undo bug)", () => {
    const undo = shortcutGroups()
      .flatMap((g) => g.shortcuts)
      .find((s) => /^Undo/.test(s.description))!;
    expect(undo.description).toMatch(/surviv/i);
    expect(undo.description).toMatch(/sav/i);
  });

  it("documents the markdown-preview zoom and pan gestures (same-commit rule)", () => {
    const preview = shortcutGroups().find((g) => g.title === "Markdown preview");
    expect(preview).toBeDefined();
    const descs = preview!.shortcuts.map((s) => s.description);
    expect(descs.some((d) => /zoom/i.test(d))).toBe(true);
    expect(descs.some((d) => /pan/i.test(d))).toBe(true);
    // Every row here is a modifier gesture: the platform chip leads each one.
    for (const s of preview!.shortcuts) expect(s.keys[0]).toBe(modKey());
  });

  /**
   * The local-find row used to LIE, and that is why it gets two tests rather
   * than a tweak. It read *"Find in the current file or terminal"* while a
   * rendered Markdown preview answered Cmd/Ctrl+F with nothing at all
   * (`bufferSearch`'s keymap is a listener on CodeMirror's `contentDOM`, and in
   * rendered mode that host is `display: none` and can hold no focus). Pressing
   * the key showed it. This file's header makes a binding and
   * its row a same-commit contract — in both directions: a row that promises
   * something must have a handler behind it.
   */
  it("no longer claims Mod+F is only for the file or the terminal", () => {
    const local = shortcutGroups()
      .flatMap((g) => g.shortcuts)
      .find((s) => s.keys.length === 2 && s.keys[1] === "F" && /^Find in the current/.test(s.description))!;

    expect(local.keys).toEqual([modKey(), "F"]);
    expect(local.description).toMatch(/preview/i);
    // Two-sided: the two surfaces it always covered are still
    // named, so "mention the preview" cannot be satisfied by dropping them.
    expect(local.description).toMatch(/file/i);
    expect(local.description).toMatch(/terminal/i);
  });

  it("documents searching the rendered preview under Markdown preview too", () => {
    const preview = shortcutGroups().find((g) => g.title === "Markdown preview")!;
    const search = preview.shortcuts.find((s) => /search/i.test(s.description))!;

    expect(search).toBeDefined();
    expect(search.keys).toEqual([modKey(), "F"]);
    // It is a highlight-every-match bar with next/previous, not a jump-to-first.
    expect(search.description).toMatch(/highlight/i);
  });
});
