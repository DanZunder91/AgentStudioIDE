/** Layer 5, real Chromium (testing-strategy.md §1, §7.5), separate so the jsdom suite never needs a
 * browser. jsdom has no layout (allotment and FitAddon never size), so sizing is tested only here.
 * Run `npm run test:browser` (needs `npx playwright install chromium`). */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

/** Every `@tauri-apps/*` module the app imports, pre-bundled: Vite's cache ignores a new import
 * from an installed package, then re-bundles and reloads mid-run, failing unrelated imports.
 * `browserTierDeps.test.ts` fails when an app import is missing here. */
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
      // Chromium only (testing-strategy §7.5): Playwright's `webkit` is neither WKWebView nor
      // WebKitGTK, so more engines buy false confidence; the smoke checklist covers real WebViews.
      instances: [{ browser: "chromium" }],
      // A definite, known viewport: these tests assert on real pixel geometry,
      // so the container size has to be a constant of the suite, not of
      // whatever the CI runner's default window happens to be.
      viewport: { width: 1280, height: 800 },
    },
  },
});
