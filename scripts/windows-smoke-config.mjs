/**
 * The pure half of the Windows real-app smoke (`windows-smoke.mjs --build`, a `verify` step on a
 * Windows host): the exe it builds and the app data it may touch. Pure functions
 * only, unit-tested in `verify.test.mjs` on every OS — `windows-smoke.mjs` itself imports
 * playwright and drives a live app, so it cannot be imported by a test.
 *
 * ── Hermetic by identifier, not by a product feature ────────────────────────────────────────────
 * The app keeps its state under `%APPDATA%\<identifier>` (Tauri's `app_config_dir`, resolved with
 * the Known Folder API — the `APPDATA` environment variable does NOT move it) and WebView2's
 * profile under `%LOCALAPPDATA%\<identifier>`. The app has no switch that relocates either, and
 * none was added for a test. But the smoke builds its OWN exe, from a `--config` override — so
 * that override gives the exe its own identifier, `com.agentstudio.app.smoke`, and every file the
 * run writes (layout, recent projects, the Vault, API history, netcap prefs and CA) lands in a
 * folder that belongs to the smoke alone, wiped before and after. Before this the smoke used the
 * user's real folder, moved layout files aside and back, and still left test requests in the real
 * `api-store.json`.
 *
 * Zero dependencies.
 */

import path from "node:path";

/** The identifier the shipped app uses (`src-tauri/tauri.conf.json`). */
export const REAL_IDENTIFIER = "com.agentstudio.app";
/** The smoke exe's own identifier, so its app data never touches the real app's. */
export const SMOKE_IDENTIFIER = "com.agentstudio.app.smoke";
/** The CDP port baked into the smoke exe (and the smoke's `--port` default). */
export const SMOKE_CDP_PORT = 9333;

/**
 * WebView2 arguments for the smoke exe: a remote-debugging port for Playwright, and Edge's
 * out-of-box / PDF / SmartScreen features off (they open their own UI or call home). Passed as
 * `additionalBrowserArgs` — the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var does NOT work,
 * because wry passes its own arguments.
 */
export function smokeBrowserArgs(port = SMOKE_CDP_PORT) {
  return `--remote-debugging-port=${port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`;
}

/**
 * The `tauri build --config` override for the smoke exe, from the real `tauri.conf.json`.
 *  - `identifier` → [`SMOKE_IDENTIFIER`]: its own app data (module doc).
 *  - `build.beforeBuildCommand` → `npm run build`: the frontend embedded is today's, never a stale
 *    `dist/`.
 *  - `app.windows` → the real list with `additionalBrowserArgs` on the main window. A config
 *    override is a JSON merge patch, and a patch REPLACES arrays — so the whole window object is
 *    copied from the real config, or the smoke would run a window without `dragDropEnabled: false`
 *    (which breaks tab drag on Windows) and without its size limits.
 */
export function smokeTauriConfig(baseConf, { port = SMOKE_CDP_PORT, identifier = SMOKE_IDENTIFIER } = {}) {
  const windows = baseConf?.app?.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error("tauri.conf.json has no app.windows[0] to add the debugging port to");
  }
  const [main, ...rest] = windows;
  return {
    identifier,
    build: { beforeBuildCommand: "npm run build" },
    app: { windows: [{ ...main, additionalBrowserArgs: smokeBrowserArgs(port) }, ...rest] },
  };
}

/**
 * argv for the build, run with `node` itself: the Tauri CLI's own script, never `npx` — `npx` is a
 * batch file on Windows and must go through cmd.exe, which refuses (rightly, `platform.mjs`) the
 * temp path's `\` and `:` and would re-parse a space in a user name.
 */
export function tauriBuildArgs(repo, configPath) {
  return [
    path.join(repo, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    configPath,
  ];
}

/** Where `tauri build --debug` leaves the exe: `<target dir>\debug\<package>.exe`. */
export function builtExePath(repo, { targetDir = null, binName = "agent-studio-scaffold" } = {}) {
  const target = targetDir ? path.resolve(repo, targetDir) : path.join(repo, "src-tauri", "target");
  return path.join(target, "debug", `${binName}.exe`);
}

/**
 * The folders an exe with `identifier` keeps its state in, from the environment's
 * `APPDATA` / `LOCALAPPDATA` (with the profile defaults when unset). `win32` joins, so a Mac
 * computes the same strings a Windows host does.
 */
export function appDataDirs(identifier, env = process.env, home = "C:\\Users\\user") {
  const roaming = env.APPDATA ?? path.win32.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local");
  return { config: path.win32.join(roaming, identifier), webview: path.win32.join(local, identifier) };
}

/**
 * Whether a run against `identifier` is hermetic — its folders belong to the smoke and may be
 * wiped — or runs against the real app's data (an exe built by hand without the override), in which
 * case the smoke falls back to moving its files aside and putting them back.
 */
export function isHermetic(identifier) {
  return identifier !== REAL_IDENTIFIER && identifier.startsWith(`${REAL_IDENTIFIER}.`);
}
