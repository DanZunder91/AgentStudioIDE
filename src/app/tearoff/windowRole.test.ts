/**
 * Which window is this realm? The answer decides what boots (the whole app, or a detached
 * window's shell) and who may write `layout-prefs.json` — so the edges are pinned here.
 */

import { afterEach, describe, expect, it } from "vitest";

import { currentWindowLabel, isMainWindow, isTearoffLabel } from "./windowRole";

type Internals = { __TAURI_INTERNALS__?: unknown };

function setLabel(label: unknown): void {
  (window as unknown as Internals).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
}

afterEach(() => {
  delete (window as unknown as Internals).__TAURI_INTERNALS__;
});

describe("windowRole", () => {
  it("is the main window outside Tauri (every jsdom test, the browser tier)", () => {
    expect(currentWindowLabel()).toBe("main");
    expect(isMainWindow()).toBe(true);
  });

  it("reads the label Tauri injected into this webview", () => {
    setLabel("tearoff-7");
    expect(currentWindowLabel()).toBe("tearoff-7");
    expect(isMainWindow()).toBe(false);
    setLabel("main");
    expect(isMainWindow()).toBe(true);
  });

  it("treats metadata without a usable label as the main window", () => {
    (window as unknown as Internals).__TAURI_INTERNALS__ = {};
    expect(currentWindowLabel()).toBe("main");
    setLabel("");
    expect(currentWindowLabel()).toBe("main");
    setLabel(42);
    expect(currentWindowLabel()).toBe("main");
  });

  it("recognises exactly the labels Rust mints for detached windows", () => {
    expect(isTearoffLabel("tearoff-1")).toBe(true);
    expect(isTearoffLabel("tearoff-123")).toBe(true);
    // The bare prefix, a look-alike, and the main window are not detached windows.
    expect(isTearoffLabel("tearoff-")).toBe(false);
    expect(isTearoffLabel("xtearoff-1")).toBe(false);
    expect(isTearoffLabel("main")).toBe(false);
  });
});
