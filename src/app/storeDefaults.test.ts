/** Pins the store's BOOT DEFAULTS from a pristine module registry (its own file: `store.test.ts`
 * has already written the singleton). Expectations are literals, never `resetStore()` copies;
 * `boot` is captured at import time; matchers resist mutants (`toBe(false)`, not `toBeFalsy()`). */

import { describe, expect, it, vi } from "vitest";

/** The only mock: the real terminal module builds xterm and opens PTYs (absent in jsdom); it also
 * lets the last test verify no PTY opens at module load. Hoisted, it never writes to the store. */
const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

import { useAppStore } from "./store";

/** Boot state captured at MODULE LOAD, before any test body, so later tests can't disturb it. */
const boot = useAppStore.getState();

describe("store boot defaults (pristine module registry)", () => {
  it("layout: one empty leaf, focused, with no tab records", () => {
    // `makeLeaf()` mints a random UUID, so the id itself is unassertable — the
    // real invariant is that focus points AT the boot leaf.
    const leaf = boot.layout;
    if (leaf.type !== "leaf") {
      throw new Error(`boot layout must be a leaf, got ${String(leaf.type)}`);
    }

    expect(leaf.tabIds).toEqual([]);
    expect(leaf.activeTabId).toBeNull();
    // Exact key set: the boot leaf carries nothing beyond these four fields.
    expect(Object.keys(leaf).sort()).toEqual([
      "activeTabId",
      "id",
      "tabIds",
      "type",
    ]);

    expect(boot.focusedPaneId).toBe(leaf.id);
    expect(boot.tabs).toEqual({});
  });

  it("fleet: empty forest, nothing selected, right rail on Files", () => {
    expect(boot.agents).toEqual({});
    expect(boot.rootAgentIds).toEqual([]);
    expect(boot.dismissedAgentIds).toEqual([]);

    // `collapsedFolders` is a Set (immer's enableMapSet). Assert the type AND the
    // emptiness: an `ObjectLiteral`→`{}` mutant is empty-ish but has no `.size`.
    expect(boot.collapsedFolders).toBeInstanceOf(Set);
    expect(boot.collapsedFolders.size).toBe(0);

    // Whole-object `toEqual`: a mutant that drops or adds a key must fail, not
    // just one that changes a value.
    expect(boot.selection).toEqual({
      selectedAgentId: null,
      activeSessionId: null,
      rightRailTab: "files",
    });
  });

  it("workspace: no root, no recents, focus-follows-agent OFF", () => {
    expect(boot.workspaceRoot).toBeNull();
    expect(boot.recentProjects).toEqual([]);
    expect(boot.browseRoots).toEqual([]);
    expect(boot.folderOrder).toEqual([]);
    expect(boot.collapsedRoots).toBeInstanceOf(Set);
    expect(boot.collapsedRoots.size).toBe(0);

    // A shipped behaviour choice, not bookkeeping: booting with this true would
    // make the Files tree jump whenever the agent selection changes.
    expect(boot.focusFollowsAgent).toBe(false);
    // Framed card until the user picks another style in Settings → Interface.
    expect(boot.railGroupStyle).toBe("card");
  });

  it("editors + LSP: nothing open, nothing hinted, no references panel", () => {
    expect(boot.editors).toEqual({});
    expect(boot.confirmCloseTab).toBeNull();

    expect(boot.lspInstallHints).toEqual({});
    expect(boot.lspDismissedHints).toEqual([]);
    expect(boot.lspIndexing).toEqual([]);
    expect(boot.lspReferences).toBeNull();
  });

  it("ui: overlays closed, both rails expanded at 260/300px, Files tab", () => {
    expect(boot.shortcutsOpen).toBe(false);
    expect(boot.findInFilesOpen).toBe(false);

    // The UI slice's own tab, distinct from `selection.rightRailTab` above —
    // both boot to Files, and both are separate literals in separate factories.
    expect(boot.rightRailTab).toBe("files");

    expect(boot.leftRailCollapsed).toBe(false);
    expect(boot.rightRailCollapsed).toBe(false);

    // The literal boot widths (px). Both sit inside [RAIL_MIN_W, RAIL_MAX_W] =
    // [180, 560], but the constants are NOT the expectation — a default of 180
    // or 560 would be a different product, so the numbers are typed out here.
    expect(boot.leftRailWidth).toBe(260);
    expect(boot.rightRailWidth).toBe(300);

    expect(boot.fileReveal).toBeNull();
  });

  it("api: no requests, collections, environments or history; nothing loaded", () => {
    expect(boot.apiRequests).toEqual({});
    expect(boot.apiCollections).toEqual([]);
    expect(boot.apiEnvironments).toEqual([]);
    expect(boot.apiHistory).toEqual([]);

    expect(boot.activeEnvironmentId).toBeNull();

    // The two hydration latches: `false` at boot is what gates the one-time
    // load from Rust. `true` here would skip hydration entirely.
    expect(boot.apiStoreLoaded).toBe(false);
    expect(boot.apiHistoryLoaded).toBe(false);

    expect(boot.saveRequestPrompt).toBeNull();
  });

  it("importing the store opens no terminal — boot is pure state", () => {
    // `initialLayoutState()`: "Boot to a single empty pane… Opening a PTY is a
    // side effect and must not happen at module load." Nothing in this file has
    // called an action, so every terminal effect must still be untouched.
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(terminal.setDefaultTerminalCwd).not.toHaveBeenCalled();
  });

  it("the boot state satisfies the repo's own store invariants", async () => {
    // Imported lazily so nothing in the harness (`resetStore`) can run before `boot` is captured.
    const { assertStoreInvariants } = await import("../test/store-harness");

    assertStoreInvariants(boot, "boot state");
  });
});
