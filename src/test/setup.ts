/** Global jsdom setup (`setupFiles`): jest-dom matchers, RTL teardown, and shims for APIs jsdom
 * lacks; allotment and xterm's fit addon observe size and would throw at mount without them. */

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

/** A no-op stub suffices: jsdom never lays out, so a resize never fires. Real resizes belong in
 * the browser / E2E tier. */
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

/** allotment queries `matchMedia` for coarse input; a never-matching stub keeps it on its mouse
 * path. */
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

/** The store mints every id with `crypto.randomUUID()`, which jsdom may lack; shimmed only if
 * absent so the real one wins. */
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
