#!/usr/bin/env node
/**
 * Windows smoke — drives the REAL app (the real WebView2 + the real Rust core + real PTYs) on a
 * Windows machine and prints PASS / FAIL / SKIP per check. It is the local, re-runnable form of
 * "verify the real thing in the running app" for Windows, where the WebDriver
 * tier (e2e/, Linux-only via tauri-driver + WebKitWebDriver) cannot run.
 *
 *   node scripts/windows-smoke.mjs --build [--port 9333] [--shots <dir>]
 *   node scripts/windows-smoke.mjs <path\to\AgentStudio-cdp.exe> [--app-id <identifier>] [--port 9333] [--shots <dir>] [--keep-state]
 *
 * ── The exe it needs ────────────────────────────────────────────────────────────────────────────
 * `--build` (what `npm run verify` runs on a Windows host) builds it: a `tauri build --debug
 * --no-bundle` with a `--config` override written to the OS temp dir (`windows-smoke-config.mjs`:
 * the real main window + a WebView2 remote-debugging port, a fresh `npm run build` of the frontend,
 * and the smoke's own identifier), then copies the exe out of `target` (a running exe locks the
 * next link) and runs against the copy. The WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var does
 * NOT work: wry passes its own arguments. A hand-built exe can be passed instead; `--port` must
 * match the port baked into it, and `--app-id` the identifier it was built with.
 *
 * ── What it does to the machine, and how it leaves it ───────────────────────────────────────────
 * - Starts ONE app instance (fails up front if something already answers on the CDP port — the app
 *   binds fixed ports, so two instances would fight) and ALWAYS kills its whole process tree.
 * - Starts its own HTTP server on 127.0.0.1 (ephemeral port) in this process — the only server any
 *   check talks to. Nothing leaves the machine.
 * - Makes a throwaway git repo under %TEMP% (the folder the app opens, edits and saves into) and
 *   deletes it at the end. The real repo is never opened or written.
 * - **App data — hermetic** with `--build` (or `--app-id com.agentstudio.app.<anything>`): the exe
 *   keeps its state in `%APPDATA%\com.agentstudio.app.smoke` and its WebView2 profile in
 *   `%LOCALAPPDATA%\com.agentstudio.app.smoke`, both wiped before and after the run. The user's real
 *   `%APPDATA%\com.agentstudio.app` (layout, recent projects, the Vault) is never read or written.
 * - **App data — fallback**, for an exe built with the real identifier: the layout and agent lists
 *   are moved aside, capture is forced on / decrypt off / system logs off, and every file listed in
 *   STATE_FILES is put back byte-for-byte when the run ends (`--keep-state` leaves what the run
 *   did). The API-client check is SKIPPED there — it would write the real Vault (`api-store.json`),
 *   so it never runs against real state. Never touched in either mode: nothing under ~/.claude.
 * - Writes one Application Event Log record (source `AgentStudioSmoke`, via `eventcreate`, which needs
 *   an elevated shell to register that source the first time; without it that check is SKIPPED).
 *
 * Selectors are the app's own aria-labels / roles / data-testids (the same hooks e2e/ uses). The
 * native folder picker cannot be driven over CDP, so the ONE stub is Playwright answering the
 * `plugin:dialog|open` IPC request with the fixture's path; everything after the dialog is the
 * real UI path (the button, the store, `read_dir`, git status).
 *
 * Checks marked `knownBug` point at a bug this run is expected to expose on builds that predate the
 * fix; they are never skipped or softened — a FAIL there is a real failure.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import {
  appDataDirs,
  builtExePath,
  isHermetic,
  REAL_IDENTIFIER,
  SMOKE_CDP_PORT,
  SMOKE_IDENTIFIER,
  smokeTauriConfig,
  tauriBuildArgs,
} from "./windows-smoke-config.mjs";

/* ───────────────────────────── arguments ───────────────────────────── */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const BUILD = flag("--build");
let exe = argv.find((a, i) => !a.startsWith("--") && !["--port", "--shots", "--app-id"].includes(argv[i - 1]));
const CDP_PORT = Number(opt("--port", String(SMOKE_CDP_PORT)));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "agentstudio-windows-smoke")));
const KEEP_STATE = flag("--keep-state");
// `--build` bakes the smoke identifier in; a hand-built exe is assumed to be the real app's unless
// told otherwise — the safe assumption (its data is then put back, not wiped).
const APP_ID = opt("--app-id", BUILD ? SMOKE_IDENTIFIER : REAL_IDENTIFIER);
const HERMETIC = isHermetic(APP_ID);
const APP_DIRS = appDataDirs(APP_ID, process.env, os.homedir());

if (process.platform !== "win32") {
  console.error("[windows-smoke] this smoke drives the Windows build; run it on Windows.");
  process.exit(2);
}
if (!BUILD && (!exe || !existsSync(exe))) {
  console.error("usage: node scripts/windows-smoke.mjs --build | <path\\to\\AgentStudio-cdp.exe> [--app-id <id>] [--port 9333] [--shots <dir>] [--keep-state]");
  console.error(exe ? `[windows-smoke] no such file: ${exe}` : "[windows-smoke] pass --build, or the exe path (see the header for how to build it)");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

/**
 * `--build`: the smoke exe from the current tree (header). Bounded: a build that hangs fails the
 * run after an hour instead of blocking it forever. Returns the copy's path and
 * the folder to delete afterwards.
 */
function buildSmokeExe() {
  const conf = JSON.parse(readFileSync(path.join(REPO, "src-tauri", "tauri.conf.json"), "utf8"));
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentstudio-smoke-build-"));
  const cfg = path.join(dir, "tauri-smoke.json");
  writeFileSync(cfg, JSON.stringify(smokeTauriConfig(conf, { port: CDP_PORT, identifier: APP_ID }), null, 2));
  log(`building the smoke exe (config ${cfg}) — the frontend, then a debug Rust build`);
  const r = spawnSync(process.execPath, tauriBuildArgs(REPO, cfg), {
    cwd: REPO,
    stdio: "inherit",
    windowsHide: true,
    timeout: 60 * 60 * 1000,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`the smoke build failed (${r.error ? r.error.message : `exit ${r.status}`})`);
  }
  const built = builtExePath(REPO, { targetDir: process.env.CARGO_TARGET_DIR ?? null });
  const copy = path.join(dir, "AgentStudio-smoke.exe");
  copyFileSync(built, copy);
  return { exe: copy, dir };
}

/** Remove a folder the smoke owns, retrying while a just-killed process still holds a file. */
async function wipe(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(1000);
    }
  }
  console.error(`[windows-smoke] could not remove ${dir}`);
  return false;
}

/* ───────────────────────────── helpers ───────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BS = "\\";
/** A Windows path inside a CSS attribute selector: backslashes are escapes there. */
const cssPath = (p) => p.split(BS).join(BS + BS);
const rand = String(Math.floor(1000 + Math.random() * 8999));
const log = (...a) => console.log("[windows-smoke]", ...a);

/** Poll `fn` until it returns a truthy value; throw `what` (+ the last value) on timeout. */
async function waitFor(fn, what, timeout = 30_000, interval = 400) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = `threw: ${e.message}`;
    }
    if (Date.now() > end) {
      const shown = typeof last === "string" ? last : JSON.stringify(last);
      throw new Error(`${what} (waited ${timeout} ms; last: ${shown?.slice(0, 400)})`);
    }
    await sleep(interval);
  }
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
}

/* ───────────────────────────── app state (put back at the end) ───────────────────────────── */

const APP_DIR = APP_DIRS.config;
/** Every app file the run can change. Restored byte-for-byte (or deleted if it did not exist). */
const STATE_FILES = [
  "layout-prefs.json",
  "recent-projects.json",
  "open-agents.json",
  "pinned-agents.json",
  "api-history.json",
  "syslog/prefs.json",
  "netcap/prefs.json",
];
/** Moved aside for the run: an empty layout (an empty pane, no folders) and no restored agents. */
const START_FRESH = ["layout-prefs.json", "open-agents.json", "pinned-agents.json"];

function snapshotState(dir) {
  const saved = new Map();
  for (const rel of STATE_FILES) {
    const p = path.join(APP_DIR, rel);
    if (existsSync(p)) {
      const keep = path.join(dir, rel.replace(/[\\/]/g, "__"));
      copyFileSync(p, keep);
      saved.set(rel, keep);
    } else {
      saved.set(rel, null);
    }
  }
  return saved;
}

/** Put every saved file back. Returns how many could NOT be restored (their copies must be kept). */
function restoreState(saved) {
  let failed = 0;
  for (const [rel, keep] of saved) {
    const p = path.join(APP_DIR, rel);
    try {
      if (keep === null) {
        if (existsSync(p)) unlinkSync(p);
      } else {
        mkdirSync(path.dirname(p), { recursive: true });
        copyFileSync(keep, p);
      }
    } catch (e) {
      failed += 1;
      console.error(`[windows-smoke] could not restore ${p}: ${e.message} (the original is at ${keep}, kept)`);
    }
  }
  return failed;
}

function patchJson(rel, patch) {
  const p = path.join(APP_DIR, rel);
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* absent or unreadable: start from the defaults the app fills in */
  }
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...cur, ...patch }, null, 2));
}

/* ───────────────────────────── fixture repo ───────────────────────────── */

function makeFixture(root) {
  const ws = path.join(root, "smoke-ws");
  mkdirSync(path.join(ws, "src", "nested"), { recursive: true });
  writeFileSync(path.join(ws, "README.md"), "# Smoke fixture\n");
  writeFileSync(path.join(ws, "src", "app.js"), 'const x = 1;\nconsole.log("app", x);\n');
  // A long file with the needle far down: Find-in-files must SCROLL to it (CodeMirror only renders
  // the lines near the viewport, so "the needle's line is in the DOM" means "we jumped to it").
  const lines = [];
  for (let i = 1; i <= 400; i++) lines.push(i === 350 ? `// smoke-needle-${rand} on line 350` : `// filler line ${i}`);
  writeFileSync(path.join(ws, "src", "nested", "util.js"), lines.join("\n") + "\n");
  const git = (...a) => sh("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "core.autocrlf=false", ...a], { cwd: ws });
  const init = git("init", "-q", "-b", "main");
  let hasGit = init.status === 0;
  if (hasGit) {
    hasGit = git("add", "-A").status === 0 && git("commit", "-qm", "init").status === 0;
    // One tracked change (nested two deep) and one untracked file, for the git colour checks.
    writeFileSync(path.join(ws, "src", "nested", "util.js"), lines.join("\n") + "\n// changed\n");
    writeFileSync(path.join(ws, "src", "untracked.txt"), "new\n");
  }
  return { ws, hasGit };
}

/* ───────────────────────────── local HTTP server ───────────────────────────── */

function startServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json", "X-Smoke-Server": "yes" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, marker: `server-marker-${rand}` }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, port: server.address().port }));
  });
}

/* ───────────────────────────── app process ───────────────────────────── */

async function cdpUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start the exe minimized via Start-Process (as a user's double-click would, detached) → its pid. */
function launchApp(cwd) {
  const ps = `$p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -WorkingDirectory '${cwd.replace(/'/g, "''")}' -WindowStyle Minimized -PassThru; $p.Id`;
  const r = sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  const pid = Number(String(r.stdout).trim().split(/\s+/).pop());
  if (r.status !== 0 || !Number.isInteger(pid) || pid <= 0) throw new Error(`could not start the app: ${r.stderr || r.stdout}`);
  return pid;
}

function killTree(pid) {
  if (!pid) return;
  sh("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
}

/* ───────────────────────────── the run ───────────────────────────── */

const results = [];
let page = null;

async function check(name, fn, { knownBug = null, skipIf = null } = {}) {
  if (skipIf) {
    results.push({ name, status: "SKIP", detail: skipIf });
    log(`SKIP  ${name} — ${skipIf}`);
    return false;
  }
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, status: "PASS", detail: typeof note === "string" ? note : "" });
    log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${typeof note === "string" ? ` — ${note}` : ""}`);
    return true;
  } catch (e) {
    let shot = "";
    if (page) {
      shot = path.join(SHOTS, `FAIL-${results.length + 1}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png`);
      await page.screenshot({ path: shot }).catch(() => (shot = ""));
    }
    results.push({ name, status: "FAIL", detail: e.message, knownBug, shot });
    log(`FAIL  ${name} — ${e.message}${knownBug ? `\n        known bug: ${knownBug}` : ""}${shot ? `\n        screenshot: ${shot}` : ""}`);
    return false;
  } finally {
    // A check that failed half-way may leave a popover or overlay open over the next one.
    if (page) await page.keyboard.press("Escape").catch(() => {});
  }
}

/** Focus the terminal by id and type one line + Enter, the way a user types (xterm onData → pty_write). */
async function typeLine(termId, line) {
  await page.click(`.terminal-view[data-terminal-id="${termId}"]`);
  await page.keyboard.type(line, { delay: 12 });
  await page.keyboard.press("Enter");
}

/** Use the terminal's own Ctrl+F bar to ask "is `needle` in this terminal's buffer?" → total matches. */
async function terminalMatches(termId, needle) {
  await page.click(`.terminal-view[data-terminal-id="${termId}"]`);
  await page.keyboard.press("Control+f");
  const input = page.locator('input[aria-label="Find in terminal"]');
  await input.waitFor({ timeout: 10_000 });
  await input.fill(needle);
  await sleep(600);
  const text = (await page.locator(".terminal-search__count").textContent().catch(() => "")) ?? "";
  await page.keyboard.press("Escape");
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  return m ? Number(m[2]) : 0;
}

/** Wait until the terminal buffer holds `needle` (retyping `line` once if the shell ate the first try). */
async function waitTerminalOutput(termId, line, needle, timeout = 45_000) {
  await typeLine(termId, line);
  const end = Date.now() + timeout;
  let retyped = false;
  while (Date.now() < end) {
    await sleep(2500);
    if ((await terminalMatches(termId, needle)) > 0) return;
    if (!retyped && Date.now() > end - timeout / 2) {
      // PowerShell's first prompt can take a while on a cold VM; typed-ahead keys are normally
      // buffered, but one retry keeps a slow start from reading as a broken terminal.
      retyped = true;
      await typeLine(termId, line);
    }
  }
  throw new Error(`"${needle}" never appeared in the terminal after typing: ${line}`);
}

/** Expand a tree folder if its children are not showing (switching rail tabs can collapse it). */
async function expandDir(dir) {
  const row = page.locator(`[data-testid="ws-dir"][data-path="${cssPath(dir)}" i]`);
  await row.waitFor({ timeout: 20_000 });
  const expanded = await row.evaluate((el) => el.closest('[role="treeitem"]')?.getAttribute("aria-expanded"));
  if (expanded !== "true") await row.click();
}

async function openAgentLogs() {
  await page.click('[data-testid="titlebar-agent-logs"]');
  await page.locator('[data-testid="agent-logs-panel"]').waitFor({ state: "visible", timeout: 20_000 });
}

/** The Agent logs rows (virtualised list — call after narrowing with the Filter box). */
async function logRows() {
  return page.$$eval('[data-testid="agent-logs-panel"] [data-testid="alog-row"]', (rows) =>
    rows.map((r) => ({
      text: r.querySelector(".alog-text")?.textContent?.trim() ?? "",
      source: r.getAttribute("data-source") ?? "",
      cls: r.className,
    })),
  );
}

async function setLogFilter(text) {
  const f = page.locator('input[aria-label="Filter log lines"]');
  await f.fill(text);
  await sleep(500);
}

async function main() {
  if (await cdpUp()) {
    console.error(`[windows-smoke] something already answers on 127.0.0.1:${CDP_PORT} — another app instance? Stop it first (the app binds fixed ports).`);
    process.exit(2);
  }

  let build = null;
  if (BUILD) {
    try {
      build = buildSmokeExe();
    } catch (e) {
      console.error(`[windows-smoke] ${e.message}`);
      process.exit(1);
    }
    exe = build.exe;
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentstudio-smoke-"));
  // Hermetic: the smoke's own app data, wiped (a previous run's leftovers would make the start
  // nondeterministic). Fallback: the real app's files, saved to be put back.
  let saved = null;
  let backup = null;
  if (HERMETIC) {
    await wipe(APP_DIRS.config);
    await wipe(APP_DIRS.webview);
  } else {
    backup = mkdtempSync(path.join(os.tmpdir(), "agentstudio-smoke-state-"));
    saved = snapshotState(backup);
  }
  const { ws, hasGit } = makeFixture(tmp);
  const srv = await startServer();
  const consoleErrors = [];
  let pid = 0;
  let browser = null;

  try {
    // Deterministic start: an empty layout, capture on (the network checks need the proxy env in
    // the PTY), decrypt off (plain env), system logs off (the check turns them on through the UI).
    for (const rel of START_FRESH) rmSync(path.join(APP_DIR, rel), { force: true });
    patchJson("netcap/prefs.json", { enabled: true, decrypt: false });
    patchJson("syslog/prefs.json", { enabled: false });

    log(
      HERMETIC
        ? `app data: ${APP_DIRS.config} (the smoke's own, wiped before and after)`
        : `app data: ${APP_DIR} — the REAL app's (exe built with ${APP_ID}); files are put back at the end`,
    );
    log(`exe ${exe}`);
    log(`fixture ${ws}  ·  local server http://127.0.0.1:${srv.port}  ·  screenshots ${SHOTS}`);
    pid = launchApp(tmp);
    log(`app pid ${pid}; waiting for the webview on :${CDP_PORT}`);
    await waitFor(cdpUp, `the webview never opened its debugging port ${CDP_PORT} (is this a CDP build? see the header)`, 120_000, 1000);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 60_000 });
    page = await waitFor(
      () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("tauri.localhost")),
      "no tauri.localhost page over CDP",
      60_000,
    );
    page.setDefaultTimeout(30_000);
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`);
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    let term = null; // { id, title }

    await check("boot: the 3-pane shell renders", async () => {
      await page.locator('[data-testid="app-shell"]').waitFor({ timeout: 90_000 });
      for (const sel of ['[data-testid="left-rail"]', '[data-testid="workspace-tree"]', '[data-testid="empty-pane-new-terminal"]']) {
        await page.locator(sel).first().waitFor({ timeout: 30_000 });
      }
      return await page.evaluate(() => navigator.userAgent.match(/Edg\/[\d.]+/)?.[0] ?? "");
    });

    await check("terminal: PowerShell echo round-trip", async () => {
      await page.click('[data-testid="empty-pane-new-terminal"]');
      const view = page.locator(".terminal-view[data-terminal-id]").first();
      await view.locator(".xterm-helper-textarea").waitFor({ state: "attached", timeout: 30_000 });
      const id = await view.getAttribute("data-terminal-id");
      const title = (await page.locator('[role="tab"][aria-selected="true"] .pane-tab__title').first().textContent())?.trim() ?? "";
      term = { id, title };
      const a = Number(rand);
      // The typed line holds "smk" but never the sum — only the shell's OUTPUT can produce the needle.
      await waitTerminalOutput(id, `Write-Output ("smk" + "-" + (${a} + 7) + "-ok")`, `smk-${a + 7}-ok`);
      return `tab "${title}"`;
    });

    await check("terminal: `curl` is curl.exe, not the Invoke-WebRequest alias", async () => {
      if (!term) throw new Error("no terminal (the echo check failed)");
      // "Applic" + "ation" so the typed text cannot match the needle itself.
      await waitTerminalOutput(term.id, `Write-Output ("cmdtype=" + (Get-Command curl).CommandType)`, "cmdtype=Application", 30_000);
    });

    await check("files: Open a folder shows the tree (real Windows paths, no \\\\?\\)", async () => {
      await page.click('[data-testid="rail-tab-files"]');
      await page.route(/ipc\.localhost\/plugin%3Adialog%7Copen/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Tauri-Response", "Tauri-Response": "ok" },
          body: JSON.stringify(ws),
        }),
      );
      try {
        await page.click('[aria-label="Open a folder"]');
        const root = page.locator(`[data-testid="workspace-root"][data-path="${cssPath(ws)}" i]`);
        await root.waitFor({ timeout: 30_000 });
      } finally {
        await page.unroute(/ipc\.localhost\/plugin%3Adialog%7Copen/);
      }
      const name = (await page.locator('[data-testid="workspace-root"] .workspace-root__name').first().textContent())?.trim();
      if (name?.toLowerCase() !== path.basename(ws).toLowerCase()) throw new Error(`root shows "${name}", expected "${path.basename(ws)}"`);
      await page.locator(`[data-testid="ws-dir"][data-path="${cssPath(path.join(ws, "src"))}" i]`).waitFor({ timeout: 20_000 });
      await page.locator(`[data-testid="ws-file"][data-path="${cssPath(path.join(ws, "README.md"))}" i]`).waitFor({ timeout: 20_000 });
      const verbatim = await page.$$eval("[data-testid=workspace-tree] [data-path]", (els) =>
        els.map((e) => e.getAttribute("data-path")).filter((p) => p.startsWith("\\\\?\\")),
      );
      if (verbatim.length) throw new Error(`verbatim paths in the tree: ${verbatim.join(", ")}`);
    });

    await check(
      "files: git status colours a modified and an untracked file",
      async () => {
        await expandDir(path.join(ws, "src"));
        await expandDir(path.join(ws, "src", "nested"));
        const mod = page.locator(`[data-testid="ws-file"][data-path="${cssPath(path.join(ws, "src", "nested", "util.js"))}" i]`);
        await waitFor(async () => (await mod.getAttribute("class"))?.includes("workspace-node--git-modified"), "util.js never got the modified colour");
        const unt = page.locator(`[data-testid="ws-file"][data-path="${cssPath(path.join(ws, "src", "untracked.txt"))}" i]`);
        await waitFor(async () => (await unt.getAttribute("class"))?.includes("workspace-node--git-untracked"), "untracked.txt never got the untracked colour");
      },
      { skipIf: hasGit ? null : "git is not on PATH (the fixture is not a repo)" },
    );

    await check(
      "files: a folder holding a change shows the change dot",
      async () => {
        await expandDir(path.join(ws, "src"));
        const dot = page.locator(`[data-testid="ws-dir"][data-path="${cssPath(path.join(ws, "src", "nested"))}" i] .workspace-node__vcs-dot`);
        await dot.waitFor({ state: "attached", timeout: 15_000 });
      },
      {
        skipIf: hasGit ? null : "git is not on PATH",
        knownBug: "dirsWithChanges/parentDir cut paths at '/' only (src/features/git/gitStore.ts parentDir) — no dot on Windows",
      },
    );

    await check(
      "git panel: a change row shows the file name and its folder",
      async () => {
        await page.click('[data-testid="rail-tab-git"]');
        const row = page.locator('[data-testid="git-change"]', { hasText: "util.js" }).first();
        await row.waitFor({ timeout: 20_000 });
        const name = (await row.locator(".git-change__name").textContent())?.trim();
        const dir = (await row.locator(".git-change__dir").textContent().catch(() => ""))?.trim();
        await page.click('[data-testid="rail-tab-files"]');
        if (name !== "util.js" || dir !== `src${BS}nested`) throw new Error(`row reads name="${name}" dir="${dir}", expected "util.js" / "src${BS}nested"`);
      },
      {
        skipIf: hasGit ? null : "git is not on PATH",
        knownBug: "GitPanel split change paths at '/' only — the whole C:\\… path showed as the name and the folder lost its last char",
      },
    );

    await check("editor: open a file, edit, Ctrl+S writes it to disk", async () => {
      const file = path.join(ws, "src", "app.js");
      await expandDir(path.join(ws, "src"));
      await page.click(`[data-testid="ws-file"][data-path="${cssPath(file)}" i]`);
      const content = page.locator(".cm-content").last();
      await content.waitFor({ timeout: 20_000 });
      await content.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(`\n// smoke-saved-${rand}`, { delay: 15 });
      await page.keyboard.press("Control+s");
      await waitFor(() => readFileSync(file, "utf8").includes(`smoke-saved-${rand}`), "the edit never reached the file on disk", 15_000);
    });

    await check("find in files: Ctrl+Shift+F, click a result → the file opens at that line", async () => {
      await page.keyboard.press("Control+Shift+F");
      const input = page.locator('input[aria-label="Search in files"]');
      await input.waitFor({ timeout: 10_000 });
      // The scope follows the focused tab (contextScope.ts); a terminal spawned in the home folder
      // would make that the scope, so pick the opened folder explicitly — as a user would.
      await page.selectOption('select[aria-label="Search workspace"]', ws);
      await input.fill(`smoke-needle-${rand}`);
      const match = page.locator('[data-testid="find-match"]', { hasText: `smoke-needle-${rand}` }).first();
      await match.waitFor({ timeout: 30_000 });
      await match.click();
      await waitFor(
        async () => (await page.locator('[role="tab"][aria-selected="true"] .pane-tab__title').allTextContents()).some((t) => t.trim() === "util.js"),
        "util.js never became the active tab",
        15_000,
      );
      // CodeMirror renders only the lines near the viewport: line 350 in the DOM = we scrolled to it.
      await waitFor(
        () => page.$$eval(".cm-line", (ls, n) => ls.some((l) => l.textContent.includes(n)), `smoke-needle-${rand}`),
        "line 350 (the match) is not on screen",
        15_000,
      );
    });

    await check("logs: a terminal's output reaches Agent logs as a line", async () => {
      if (!term) throw new Error("no terminal (the echo check failed)");
      await openAgentLogs();
      const needle = `smk-${Number(rand) + 7}-ok`;
      await setLogFilter(needle);
      const row = await waitFor(async () => (await logRows()).find((r) => r.text === needle), `no Agent logs row reading exactly "${needle}"`, 30_000);
      if (!row.source.toLowerCase().startsWith("powershell")) throw new Error(`row source is "${row.source}"`);
    });

    await check(
      "logs: a typed command is logged once, not as its keystroke-by-keystroke redraws",
      async () => {
        await setLogFilter("Write-Output");
        await sleep(800);
        const rows = await logRows();
        const garbled = rows.filter((r) => r.text.includes("WrWri") || (r.text.match(/Write-Output/g) ?? []).length > 1);
        await setLogFilter("");
        if (garbled.length) throw new Error(`${garbled.length} garbled row(s), e.g. "${garbled[0].text.slice(0, 120)}…"`);
      },
      { knownBug: "ConPTY/PSReadLine redraw the input line with cursor moves, not \\r; the splitter strips them and concatenates every redraw (src-tauri/src/logstream/splitter.rs)" },
    );

    const evtMarker = `agentstudio-smoke-evt-${rand}`;
    const evt = sh("eventcreate.exe", ["/T", "ERROR", "/ID", "101", "/L", "APPLICATION", "/SO", "AgentStudioSmoke", "/D", "probe-before-enable"]);
    await check(
      "logs: an Event Log record reaches Logs ▸ System apps (level + source)",
      async () => {
        await openAgentLogs();
        await page.click('button[aria-label="Log sources"]');
        const group = page.locator('[role="dialog"][aria-label="Log sources"] [role="group"][aria-label="System apps"]');
        await group.waitFor({ timeout: 20_000 });
        const box = group.locator('label input[type="checkbox"]').first();
        if (!(await box.isChecked())) await box.click();
        await waitFor(() => box.isChecked(), "the System apps toggle did not stay on", 10_000);
        await page.keyboard.press("Escape");
        await sleep(2500); // the Event Log subscription starts at "now": write after it is up
        const w = sh("eventcreate.exe", ["/T", "ERROR", "/ID", "101", "/L", "APPLICATION", "/SO", "AgentStudioSmoke", "/D", evtMarker]);
        if (w.status !== 0) throw new Error(`eventcreate failed: ${w.stderr || w.stdout}`);
        await setLogFilter(evtMarker);
        const row = await waitFor(async () => (await logRows()).find((r) => r.text.includes(evtMarker)), "the Event Log record never showed up", 45_000);
        await setLogFilter("");
        if (row.source !== "AgentStudioSmoke") throw new Error(`source is "${row.source}", expected AgentStudioSmoke`);
        if (!row.cls.includes("alog-row--error")) throw new Error(`level class is "${row.cls}", expected alog-row--error`);
      },
      { skipIf: evt.status === 0 ? null : `eventcreate cannot write here (needs an elevated shell the first time): ${(evt.stderr || evt.stdout).trim()}` },
    );

    await check("network: a curl from an IDE terminal is captured (method, path, status, source)", async () => {
      if (!term) throw new Error("no terminal (the echo check failed)");
      await page.click(`[role="tab"][title="${term.title}"]`);
      await page.locator(`.terminal-view[data-terminal-id="${term.id}"]`).waitFor({ state: "visible", timeout: 15_000 });
      const p = `/smoke-net-${rand}`;
      await typeLine(term.id, `curl.exe -s -o NUL -w "net:%{http_code}" http://127.0.0.1:${srv.port}${p}`);
      await waitFor(() => srv.hits.some((h) => h.url === p), `the local server never got GET ${p}`, 30_000);
      await page.click('[data-testid="titlebar-network"]');
      await page.locator('[data-testid="network-panel"]').waitFor({ state: "visible", timeout: 20_000 });
      const row = await waitFor(
        () =>
          page.$$eval('[data-testid="network-panel"] [data-testid="net-row"]', (rs, want) =>
            rs
              .map((r) => {
                const c = (k) => r.querySelector(`.net-c--${k}`)?.textContent?.trim() ?? "";
                return { method: c("method"), path: c("path"), status: c("status"), source: c("source") };
              })
              .find((r) => r.path === want && r.status.startsWith("200")),
          p),
        `no completed ${p} row in Network`,
        30_000,
      );
      if (row.method !== "GET") throw new Error(`method ${row.method}`);
      if (row.source !== term.title) throw new Error(`source "${row.source}", expected the tab title "${term.title}"`);
      // The proxy really carried it: curl was told to use it by the PTY's http_proxy.
      const hit = srv.hits.find((h) => h.url === p);
      if (!/curl/i.test(hit.headers["user-agent"] ?? "")) throw new Error(`unexpected user-agent ${hit.headers["user-agent"]}`);
    });

    // Agent CLIs' own calls to AI providers are hidden by default. The smoke sends nothing off the
    // machine, so there is no real CLI→provider flow here: this proves the control is in the real
    // header, on by default, and never hides a curl — the hiding itself is unit-tested
    // (networkFilter.test.ts, NetworkHideAiProviders.test.tsx).
    await check("network: 'Hide AI providers' is on by default and leaves a curl row visible", async () => {
      const panel = page.locator('[data-testid="network-panel"]');
      const box = panel.locator('.net-head [data-testid="net-hide-ai"]');
      await box.waitFor({ timeout: 15_000 });
      if (!(await box.isChecked())) throw new Error("the checkbox is not checked by default");
      const p = `/smoke-net-${rand}`;
      const visible = () => panel.locator('[data-testid="net-row"] .net-c--path', { hasText: p }).count();
      if ((await visible()) === 0) throw new Error(`the curl row ${p} is hidden while the box is checked`);
      await box.click();
      await waitFor(async () => !(await box.isChecked()), "the checkbox did not turn off", 5_000);
      if ((await visible()) === 0) throw new Error(`the curl row ${p} vanished with the box off`);
      await box.click();
      await waitFor(() => box.isChecked(), "the checkbox did not turn back on", 5_000);
    });

    const vaultSkip = HERMETIC
      ? null
      : `this exe keeps its data in the REAL ${APP_DIR}, and a request it sends is saved into the real Vault (api-store.json) — run with --build`;
    await check("api client: GET and a POST with a header + JSON body round-trip to a local server", async () => {
      await page.click('[aria-label="New API request"]');
      await page.locator('[data-testid="api-request"]').last().waitFor({ timeout: 20_000 });
      await page.fill('[aria-label="Request URL"]', `http://127.0.0.1:${srv.port}/api-get-${rand}?a=1&b=2`);
      await page.click('[data-testid="api-send"]');
      await waitFor(async () => (await page.locator('[data-testid="api-status"]').textContent().catch(() => ""))?.trim() === "200", "GET never showed status 200", 20_000);
      await waitFor(
        async () => (await page.locator('[data-testid="api-response-body"]').textContent().catch(() => ""))?.includes(`server-marker-${rand}`),
        "the GET response body never showed the server's marker",
        15_000,
      );
      if (!srv.hits.some((h) => h.method === "GET" && h.url === `/api-get-${rand}?a=1&b=2`)) throw new Error("the server saw no GET with the query intact");

      await page.selectOption('[aria-label="HTTP method"]', "POST");
      await page.fill('[aria-label="Request URL"]', `http://127.0.0.1:${srv.port}/api-post-${rand}`);
      await page.click('[data-testid="api-add-header"]');
      await page.locator('[aria-label="Header name"]').last().fill("X-Smoke");
      await page.locator('[aria-label="Header value"]').last().fill(`hdr-${rand}`);
      const body = page.locator('[aria-label="Request body"]');
      await body.click();
      await body.fill(`{"smoke": ${rand}}`);
      await page.click('[data-testid="api-send"]');
      const hit = await waitFor(() => srv.hits.find((h) => h.method === "POST" && h.url === `/api-post-${rand}`), "the server never got the POST", 20_000);
      if (hit.headers["x-smoke"] !== `hdr-${rand}`) throw new Error(`X-Smoke header arrived as ${JSON.stringify(hit.headers["x-smoke"])}`);
      if (hit.body.replace(/\s/g, "") !== `{"smoke":${rand}}`) throw new Error(`body arrived as ${JSON.stringify(hit.body)}`);
      await waitFor(
        async () => (await page.locator('[data-testid="api-response-body"]').textContent().catch(() => ""))?.includes(`api-post-${rand}`),
        "the POST response never rendered",
        15_000,
      );
    }, { skipIf: vaultSkip });

    await check("shortcuts: the cheat sheet (Ctrl+/) says Ctrl, never ⌘", async () => {
      await page.locator('[data-testid="app-shell"]').click({ position: { x: 640, y: 16 } }).catch(() => {});
      await page.keyboard.press("Control+/");
      const dlg = page.locator('[role="dialog"]', { hasText: "Keyboard Shortcuts" }).first();
      await dlg.waitFor({ timeout: 10_000 });
      const text = (await dlg.innerText()) ?? "";
      if (text.includes("⌘")) throw new Error("the cheat sheet shows ⌘ on Windows");
      if (!text.includes("Ctrl")) throw new Error("the cheat sheet shows no Ctrl at all");
    });

    // Last on purpose: a build without the fix reloads the whole IDE here.
    await check("shortcuts: F5 / Ctrl+R do not reload the IDE (WebView2 browser keys are off)", async () => {
      await page.evaluate(() => {
        window.__smokeNotReloaded = true;
      });
      await page.locator('[data-testid="app-shell"]').click({ position: { x: 640, y: 16 } }).catch(() => {});
      await page.keyboard.press("F5");
      await page.keyboard.press("Control+r");
      await sleep(3000);
      const survived = await page.evaluate(() => window.__smokeNotReloaded === true).catch(() => false);
      if (!survived) throw new Error("the page reloaded — the in-page marker is gone (src-tauri/src/webview_keys.rs)");
      // Ctrl+P is not pressed: with the keys on it opens a modal print dialog that would hang the run.
    });

    await page.screenshot({ path: path.join(SHOTS, "final.png") }).catch(() => {});
  } catch (e) {
    results.push({ name: "harness", status: "FAIL", detail: e.stack ?? e.message });
    log(`FAIL  harness — ${e.message}`);
  } finally {
    await browser?.close().catch(() => {});
    killTree(pid);
    await new Promise((r) => srv.server.close(() => r()));
    await sleep(1500); // let the killed tree release the fixture's files
    if (HERMETIC) {
      if (!KEEP_STATE) {
        await wipe(APP_DIRS.config);
        await wipe(APP_DIRS.webview);
      }
    } else if (!KEEP_STATE) {
      // A copy that could not be put back is the user's only copy: never delete it.
      if (restoreState(saved) === 0) await wipe(backup);
    } else {
      log(`--keep-state: the real app's files were left as the run changed them; originals in ${backup}`);
    }
    await wipe(tmp);
    if (build) await wipe(build.dir);
  }

  /* ── report ── */
  console.log("\n──────── windows-smoke results ────────");
  for (const r of results) {
    console.log(`${r.status.padEnd(4)}  ${r.name}${r.status === "FAIL" && r.knownBug ? "   [known bug]" : ""}`);
    if (r.status !== "PASS" && r.detail) console.log(`      ${r.detail.split("\n")[0]}`);
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${n("PASS")} passed · ${n("FAIL")} failed · ${n("SKIP")} skipped   (screenshots: ${SHOTS})`);
  if (consoleErrors.length) {
    console.log(`\nwebview console errors (${consoleErrors.length}, reported, not a check):`);
    for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.log(`  ${e.slice(0, 300)}`);
  }
  process.exitCode = n("FAIL") > 0 ? 1 : 0;
}

await main();
