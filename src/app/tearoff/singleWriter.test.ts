/**
 * `layout-prefs.json` keeps ONE writer when there are several windows (tab-tearoff.md §4.2).
 *
 * The file is saved wholesale and non-atomically, which is only sound because the main
 * window is its sole writer. A detached window runs a store holding a different, smaller
 * layout; one save from it would overwrite the main window's views (a lost update). Every
 * persisting store action funnels into `saveLayoutPrefs`, so the page-side guard lives
 * there — Rust refuses the command from any other window too (`layout_prefs.rs`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { EMPTY_LAYOUT_PREFS, saveLayoutPrefs } from "../layoutPrefsIpc";

let ipc: TauriMock;
beforeEach(() => {
  ipc = installTauriMock();
  ipc.handle("layout_prefs_save", () => null);
});
afterEach(() => ipc.reset());

function asWindow(label: string): void {
  (window as unknown as { __TAURI_INTERNALS__: { metadata?: unknown } }).__TAURI_INTERNALS__.metadata = {
    currentWindow: { label },
  };
}

describe("saveLayoutPrefs — the main window only", () => {
  it("writes from the main window", async () => {
    asWindow("main");
    await saveLayoutPrefs(EMPTY_LAYOUT_PREFS);
    expect(ipc.calls("layout_prefs_save")).toHaveLength(1);
  });

  it("never even asks from a detached window", async () => {
    asWindow("tearoff-1");
    await saveLayoutPrefs(EMPTY_LAYOUT_PREFS);
    expect(ipc.calls("layout_prefs_save")).toHaveLength(0);
  });
});
