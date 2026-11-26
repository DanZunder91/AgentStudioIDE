/** Pure half of the Windows smoke, tested in verify.test.mjs. Hermetic by identifier: the smoke
 * builds its own exe (`com.agentstudio.app.smoke`), so all app data lands in folders it owns and
 * wipes; the APPDATA env var does not move Tauri's config dir. */

import path from "node:path";

/** The identifier the shipped app uses (`src-tauri/tauri.conf.json`). */
export const REAL_IDENTIFIER = "com.agentstudio.app";
/** The smoke exe's own identifier, so its app data never touches the real app's. */
export const SMOKE_IDENTIFIER = "com.agentstudio.app.smoke";
/** The CDP port baked into the smoke exe (and the smoke's `--port` default). */
export const SMOKE_CDP_PORT = 9333;

/** Passed as `additionalBrowserArgs`: wry sets its own, so the WebView2 args env var does not work.
 * Edge OOBE/PDF/SmartScreen are off: they open their own UI or call home. */
export function smokeBrowserArgs(port = SMOKE_CDP_PORT) {
  return `--remote-debugging-port=${port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`;
}

/** `tauri build --config` override with a fresh frontend build. A merge patch replaces arrays, so
 * the real window is copied whole (else no `dragDropEnabled: false`, which breaks tab drag). */
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

/** The Tauri CLI script under `node`, never `npx`: a batch file needs cmd.exe, which refuses the
 * temp path's `\` and `:` (platform.mjs) and re-parses spaces. */
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

/** `win32` joins, so a Mac computes the same strings a Windows host does. */
export function appDataDirs(identifier, env = process.env, home = "C:\\Users\\user") {
  const roaming = env.APPDATA ?? path.win32.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local");
  return { config: path.win32.join(roaming, identifier), webview: path.win32.join(local, identifier) };
}

/** Not hermetic (hand-built exe, real identifier): the smoke moves files aside and back instead. */
export function isHermetic(identifier) {
  return identifier !== REAL_IDENTIFIER && identifier.startsWith(`${REAL_IDENTIFIER}.`);
}
