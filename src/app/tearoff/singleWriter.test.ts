/** `layout-prefs.json` keeps ONE writer (tab-tearoff.md §4.2): saves are wholesale and
 * non-atomic, so a detached window's save would clobber the main layout. The page-side guard is
 * in `saveLayoutPrefs`; Rust refuses other windows too (`layout_prefs.rs`). */

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
