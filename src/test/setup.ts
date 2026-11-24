/**
 * Global test setup. Loaded via `setupFiles` in `vitest.config.ts`
 * before every test file.
 *
 * Two jobs:
 *   1. Wire up `@testing-library/jest-dom` matchers + RTL teardown.
 *   2. Shim the browser APIs jsdom does not implement. jsdom has **no layout
 *      engine**: every element measures 0x0, and `ResizeObserver` /
 *      `matchMedia` / `IntersectionObserver` simply do not exist. Our pane
 *      chrome (allotment) and the terminal registry (xterm's fit addon) both
 *      observe size, so without these shims a component test throws
 *      `ResizeObserver is not defined` at mount.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL does auto-cleanup when `globals: true`, but we register it explicitly so
// the suite does not silently start leaking DOM between tests if that config
// ever changes.
afterEach(() => {
  cleanup();
});

/* ───────────────────────── jsdom shims ───────────────────────── */

/**
 * jsdom ships no ResizeObserver. A no-op class is the right stub for unit
 * tests: the callback only ever fires on a real layout change, and jsdom never
 * has one. Anything that depends on an actual resize firing belongs in the
 * real-app / E2E tier, not here.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub;
}

/** Same story for IntersectionObserver — cheap insurance for future rails. */
if (!("IntersectionObserver" in globalThis)) {
  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    writable: true,
    configurable: true,
    value: IntersectionObserverStub,
  });
}

/**
 * `matchMedia` is missing in jsdom. allotment (VS Code's Split View) queries it
 * for pointer/coarse-input behaviour; returning a never-matching, listener-less
 * stub keeps it on its mouse path.
 */
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

/**
 * The store mints every PaneId/TabId/TerminalId with `crypto.randomUUID()`.
 * jsdom's `crypto` implements `getRandomValues` but historically not
 * `randomUUID`, and a store that cannot mint an id fails in a maximally
 * confusing way. Shim only if absent so we prefer the real implementation.
 */
if (typeof globalThis.crypto?.randomUUID !== "function") {
  let seq = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    writable: true,
    configurable: true,
    value: (): `${string}-${string}-${string}-${string}-${string}` => {
      const n = (seq++).toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${n}` as const;
    },
  });
}
