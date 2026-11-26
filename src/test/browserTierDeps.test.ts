/** Fails fast when an app `@tauri-apps/*` import is missing from `TAURI_DEPS`: Vite would find it
 * mid-run, re-bundle and reload, failing unrelated browser tests. The config is read as text:
 * importing it would load Playwright and the React plugin into jsdom. */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONFIG = readFileSync(resolve(ROOT, "vitest.browser.config.ts"), "utf8");

/** The string literals inside `export const TAURI_DEPS = [ … ];`. */
function listedDeps(config: string): string[] {
  const block = /export const TAURI_DEPS = \[([^\]]*)\]/.exec(config);
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Source files that run in the browser tier: app code and browser tests, not jsdom tests. */
function browserTierSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...browserTierSources(path));
    else if (
      /\.tsx?$/.test(entry.name) &&
      (!/\.test\.tsx?$/.test(entry.name) ||
        /\.browser\.test\.tsx?$/.test(entry.name))
    )
      out.push(path);
  }
  return out;
}

/** Every `@tauri-apps/*` module named by a static or dynamic import in `source`. */
function tauriImports(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(
    /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)"(@tauri-apps\/[^"]+)"/gm,
  ))
    found.add(m[1]);
  return [...found];
}

const imported = new Set(
  browserTierSources(resolve(ROOT, "src")).flatMap((f) =>
    tauriImports(readFileSync(f, "utf8")),
  ),
);

describe("the browser tier pre-bundles every @tauri-apps module", () => {
  it("the scan finds the imports it is meant to find", () => {
    // Without this, a broken regex or walk would pass both tests below vacuously.
    expect(imported).toContain("@tauri-apps/api/core");
    expect(imported).toContain("@tauri-apps/api/path");
    expect(
      tauriImports(
        `import { a } from "@tauri-apps/api/x";\nconst m = await import("@tauri-apps/plugin-y");\nimport "@tauri-apps/z";`,
      ),
    ).toEqual(["@tauri-apps/api/x", "@tauri-apps/plugin-y", "@tauri-apps/z"]);
    expect(
      tauriImports(`vi.mock("@tauri-apps/api/path", () => ({}));`),
    ).toEqual([]);
  });

  it("is wired into Vite's optimizeDeps", () => {
    expect(CONFIG).toMatch(/optimizeDeps:\s*\{\s*include:\s*TAURI_DEPS\s*\}/);
  });

  it("lists every module the app imports", () => {
    const missing = [...imported]
      .filter((dep) => !listedDeps(CONFIG).includes(dep))
      .sort();
    expect(
      missing,
      "add these to TAURI_DEPS in vitest.browser.config.ts",
    ).toEqual([]);
  });

  it("lists nothing the app no longer imports", () => {
    const stale = listedDeps(CONFIG).filter((dep) => !imported.has(dep));
    expect(
      stale,
      "remove these from TAURI_DEPS in vitest.browser.config.ts",
    ).toEqual([]);
  });
});
