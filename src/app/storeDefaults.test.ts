/**
 * The store's BOOT DEFAULTS — every literal the `initial*State()` factories ship
 * (`store.ts` L2098–2184), pinned exactly once, from a pristine module registry.
 *
 * ── Why this is its own file (the whole reason it exists) ────────────────────
 * `useAppStore` is a **module singleton**. By the time any test in
 * `store.test.ts` runs, that suite's own `resetStore()` (and every action under
 * test) has already written to it, so the *pristine* boot state is simply not
 * observable there — the values the user actually sees on first launch are gone
 * before the first `expect`. Vitest gives each test **file** its own module
 * registry, so a fresh file that imports `./store` and reads `getState()`
 * immediately sees the untouched boot state. That is not a stylistic choice; it
 * is the only place these defaults can be asserted.
 *
 * These are shipping defaults, not bookkeeping: which panel the right rail opens
 * on, how wide the rails are, and whether focus follows the selected agent are
 * the first things a user sees. Mutation testing found them as
 * `ObjectLiteral` / `ArrayDeclaration` / `BooleanLiteral` / `StringLiteral`
 * mutation **survivors** — every factory runs at import time, so they were
 * covered but never *asserted*: `rightRailTab: "files"` → `"vault"`, or
 * `leftRailWidth: 260` → `0`, and the whole suite stayed green.
 *
 * ── The two traps this file deliberately avoids ─────────────────────────────
 *  1. **Never assert against `resetStore()`.** `src/test/store-harness.ts`
 *     re-states the defaults by hand; checking one copy against the other proves
 *     only that two copies agree (whenever a test's expected value is computed
 *     from the same source as the actual value, the test can only catch
 *     plumbing, never content). Every
 *     expectation below is a **literal typed into this file**. The one value read
 *     from the store is the boot leaf's `PaneId`, which is a random UUID: for it
 *     we pin the *relationship* (`focusedPaneId === layout.id`), never a value.
 *  2. **Nothing may touch the store before we read it.** The pristine state is
 *     captured into the module-level `boot` const below, at import time, before
 *     any test body — and immer's producer returns a *new* root object on every
 *     `setState`, so even a later write could not retro-mutate this snapshot.
 *     No harness, no bridge, no `resetStore()` is imported at the top level; the
 *     invariant check at the end pulls the harness in via `await import(...)`,
 *     inside the test, long after `boot` is frozen in place.
 *
 * Matchers are chosen for mutation resistance, not brevity: `toBe(false)` never
 * `toBeFalsy()` (which cannot tell `false` from `0`, `""` or `undefined` — i.e.
 * from exactly what a dropped-key mutant produces), `toEqual` on whole objects
 * so a `ObjectLiteral`→`{}` mutant fails, and `instanceof Set` + `.size` for the
 * Sets (a `{}` mutant has no `.size`, but would sail through a truthiness test).
 */

import { describe, expect, it, vi } from "vitest";

/**
 * The only mock here, and for the same reason `store.test.ts` uses it: the real
 * module builds xterm instances and opens PTYs over Tauri IPC, neither of which
 * exists in jsdom (the real import even probes a `<canvas>` at load). Mocking it
 * is also what lets the last test below verify `initialLayoutState()`'s stated
 * contract — "opening a PTY is a side effect and must not happen at module load".
 * A `vi.mock` factory is hoisted above the imports, so it cannot disturb the
 * `boot` snapshot taken below: it swaps a module, it never writes to the store.
 */
const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../features/terminal", () => terminal);

import { useAppStore } from "./store";

/**
 * The boot state, captured at MODULE LOAD — the first thing this file does after
 * importing the store, before any `describe`/`it` body runs. Ordering therefore
 * cannot be invalidated by tests added later in this file (or by their order).
 */
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
    // Imported HERE, dynamically, rather than at the top of the file: the
    // harness also imports the store singleton, and importing it lazily makes it
    // impossible for anything in it (`resetStore`) to run before `boot` was
    // captured. `boot` is already a fixed snapshot at this point either way.
    const { assertStoreInvariants } = await import("../test/store-harness");

    assertStoreInvariants(boot, "boot state");
  });
});
