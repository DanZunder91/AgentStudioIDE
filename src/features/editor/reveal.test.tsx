/** Routing only (registry mocked; cursor/scroll is in the browser tier): which paths wait for a
 * buffer. Images must not: `whenViewReady` polls for 5 s before resolving null. */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  whenViewReady: vi.fn(async (): Promise<object | null> => null),
}));
vi.mock("./EditorRegistry", () => registry);

import { routeOpensElsewhere, useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { revealInEditor } from "./reveal";

const openTabs = () =>
  Object.values(useAppStore.getState().tabs).map((t) =>
    t.ref.kind === "editor" ? t.ref.path : t.ref.kind,
  );

describe("revealInEditor", () => {
  beforeEach(() => {
    resetStore();
    registry.whenViewReady.mockClear().mockResolvedValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  it("a file another OS window holds: that window is brought forward, and no buffer is built here", async () => {
    // Tab tear-off: waiting for a view would create this window's own copy of the buffer —
    // a second copy of a file the other window is the writer of.
    const off = routeOpensElsewhere(() => true);
    try {
      await act(async () => {
        await revealInEditor("/w/src/main.rs", 12, 3);
      });
    } finally {
      off();
    }
    expect(openTabs()).toEqual([]);
    expect(registry.whenViewReady).not.toHaveBeenCalled();
  });

  it("opens the tab and waits for the buffer on a text file", async () => {
    await act(async () => {
      await revealInEditor("/w/src/main.rs", 12, 3);
    });
    expect(openTabs()).toContain("/w/src/main.rs");
    expect(registry.whenViewReady).toHaveBeenCalledWith("/w/src/main.rs");
  });

  /** A raster has no buffer to wait for, but the tab must still open. */
  it("opens a raster image WITHOUT waiting five seconds for a buffer it will never get", async () => {
    await act(async () => {
      await revealInEditor("/w/assets/logo.png", 1);
    });
    expect(openTabs()).toContain("/w/assets/logo.png");
    expect(registry.whenViewReady).not.toHaveBeenCalled();
  });

  /** An SVG keeps its buffer (it is also text), so a Find-in-Files hit still lands on its line. */
  it("still waits for the buffer on an SVG, which does have text source", async () => {
    await act(async () => {
      await revealInEditor("/w/assets/icon.svg", 4);
    });
    expect(registry.whenViewReady).toHaveBeenCalledWith("/w/assets/icon.svg");
  });

  it("returns quietly when the buffer never loads", async () => {
    registry.whenViewReady.mockResolvedValue(null);
    await act(async () => {
      await expect(revealInEditor("/w/src/main.rs", 1)).resolves.toBeUndefined();
    });
  });
});
