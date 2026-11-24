/**
 * Vitest config — layer 5, the real-browser tier (testing-strategy.md §1, §7.5).
 *
 * A SEPARATE config from `vitest.config.ts` on purpose. The jsdom suite is the
 * per-push workhorse (fast, no browser download); this one boots real Chromium
 * via Playwright and is the only place a claim about **layout** can be made.
 * Keeping them apart means `npx vitest run` stays exactly what it was, and a
 * broken browser binary can never take the unit suite down with it.
 *
 * Why this tier is not optional (testing-strategy §1, "Layer 5 is not optional,
 * and it is the one people will try to skip"): jsdom has no layout engine, so
 * every `getBoundingClientRect()` is 0x0 and its `ResizeObserver` is a no-op
 * stub (`src/test/setup.ts`). `allotment` learns its size from **nothing but**
 * `ResizeObserver` — it never reads `clientWidth`/`getBoundingClientRect` — so
 * under jsdom it never lays out at all, and xterm's `FitAddon` computes a
 * degenerate size. Every sizing assertion there is vacuously green. This file
 * is where sizing is actually tested.
 *
 * Run: `npm run test:browser` (requires `npx playwright install chromium`).
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

/**
 * Every `@tauri-apps/*` module the app imports, pre-bundled up front.
 *
 * Vite caches its pre-bundled deps keyed on the lockfile and this config. A new
 * import of a module from a package that is already installed (e.g.
 * `@tauri-apps/api/path`, for `src/lib/homeDir.ts`) changes neither, so the
 * cached set is reused without a rescan, and the module is only found when a
 * test asks for it. Vite then re-bundles and reloads the page mid-run, and
 * whatever was being imported at that moment (xterm's WebGL addon, mermaid)
 * fails as "Failed to fetch dynamically imported module": unrelated failures
 * on the first run on any machine whose cache predates the import.
 * `browserTierDeps.test.ts` fails when an app import is missing from this list.
 */
export const TAURI_DEPS = [
  "@tauri-apps/api/core",
  "@tauri-apps/api/event",
  "@tauri-apps/api/mocks",
  "@tauri-apps/api/path",
  "@tauri-apps/api/window",
  "@tauri-apps/plugin-dialog",
];

export default defineConfig({
  plugins: [react()],

  optimizeDeps: { include: TAURI_DEPS },

  test: {
    // Only `*.browser.test.tsx`. `vitest.config.ts` excludes the same glob, so
    // a file belongs to exactly one tier and neither suite can shadow the other.
    include: ["src/**/*.browser.test.{ts,tsx}"],

    setupFiles: ["./src/test/setup.browser.ts"],
    globals: true,

    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // Chromium only, deliberately (testing-strategy §7.5): Playwright's
      // `webkit` is neither WKWebView nor WebKitGTK, so extra engines here buy
      // false confidence, not coverage. Real-WebView risk is covered by the
      // manual smoke checklist and the Linux benchmark gate.
      instances: [{ browser: "chromium" }],
      // A definite, known viewport: these tests assert on real pixel geometry,
      // so the container size has to be a constant of the suite, not of
      // whatever the CI runner's default window happens to be.
      viewport: { width: 1280, height: 800 },
    },
  },
});
