/** Browser config for README media capture only, not a test gate: `*.media.tsx` is matched by no
 * other vitest config. Renders the real <App/> in Playwright Chromium against a mocked backend. */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["scripts/readme-media/**/*.media.tsx"],
    setupFiles: ["./src/test/setup.browser.ts"],
    globals: true,
    testTimeout: 60_000,
    browser: {
      enabled: true,
      // A browser window larger than the 1600x1000 iframe, so the runner never scales the
      // app down (the screenshot is taken of the iframe at its rendered size).
      provider: playwright({ contextOptions: { viewport: { width: 1920, height: 1300 } } }),
      headless: true,
      instances: [{ browser: "chromium" }],
      viewport: { width: 1600, height: 1000 },
      screenshotFailures: false,
    },
  },
});
