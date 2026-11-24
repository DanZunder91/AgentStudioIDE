/**
 * Setup for the real-browser tier (`vitest.browser.config.ts`).
 *
 * Deliberately NOT `setup.ts`. That file's whole job is shimming the browser
 * APIs jsdom lacks — `ResizeObserver`, `matchMedia`, `IntersectionObserver`,
 * `crypto.randomUUID`. Chromium has all of them, for real, and a stub here
 * would defeat the entire point of the tier: the no-op `ResizeObserver` stub is
 * *precisely* what hides the layout bugs this suite exists to catch.
 *
 * So the only thing shared with jsdom is RTL teardown.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The browser tier renders the full <App/>, which mounts <CloseTabShortcut> and
// its `listen("menu://close-tab")` subscription. None of these
// tests drive Tauri events, but a *real* `listen()` invokes `plugin:event|listen`
// (a loud "unmocked command" throw) and its unmount `unlisten()` reaches into
// `window.__TAURI_EVENT_PLUGIN_INTERNALS__` — both fire-and-forget across test
// teardown, so they land after the IPC mock is torn down and redden the whole
// tier with unhandled rejections (exit 1). Stub the event module to inert no-ops
// so subscribe/unsubscribe is decoupled from the IPC mock's lifecycle. A test
// that actually needs to drive events can `vi.mock` it itself (as
// CloseTabShortcut's own jsdom unit test does).
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  once: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
  TauriEvent: {},
}));

afterEach(() => {
  cleanup();
});
