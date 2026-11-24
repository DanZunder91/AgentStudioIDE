/**
 * WebdriverIO config — the E2E driver harness (layer 6).
 *
 * Drives the REAL built app over WebDriver via a self-managed `tauri-driver`
 * proxy (no `@wdio/tauri-service`), on Linux + Windows only. macOS cannot drive
 * a WKWebView over `tauri-driver` (Apple limitation), so this suite is NOT run on
 * the dev host — see e2e/README.md.
 *
 * Determinism (all via seams that ALREADY exist in the app — no Rust change):
 *   - `AGENTSTUDIO_CLAUDE_BIN` → e2e/fixtures/claude-stub.sh, so `agent_spawn`
 *     drives a stub instead of the real `claude` (agent/claude.rs resolve_binary).
 *   - `AGENTSTUDIO_FANOUT_POLL_MS=50` → the transcript tailer polls fast
 *     (supervisor/mod.rs fanout_poll).
 *   - launch **cwd = the fixture workspace**, so `default_workspace`
 *     (git-root-of-launch, workspace.rs) roots the tree/find/quick-launch there.
 *     tauri-driver launches the app inheriting this process's cwd + env.
 *
 * tauri-driver is spawned ONCE in onPrepare (after the build) and reaped in
 * onComplete — robust across the multiple spec files (each spec file is a fresh
 * WebDriver session = a fresh app launch against the one proxy).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir, platform } from "node:os";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { APP_ZONES, zonedLauncher } from "./support/app-zone";
import { specName, startRecording, stopRecording } from "./support/record";

const IS_WIN = platform() === "win32";
// package.json is "type": "module", so wdio loads this file as ESM where `__dirname`
// does not exist (with `__dirname` the config never loads).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The real debug binary produced by `tauri build --debug --no-bundle`.
// Binary name = Cargo package name `agent-studio-scaffold` (src-tauri/Cargo.toml).
const APP_BINARY = path.join(
  ROOT,
  "src-tauri",
  "target",
  "debug",
  IS_WIN ? "agent-studio-scaffold.exe" : "agent-studio-scaffold",
);

// The committed launch-cwd fixture workspace (seam S8). Seeded into a throwaway
// git repo below so `find_repo_root` resolves it (not the outer Agent Studio repo).
const E2E_WORKSPACE = path.join(ROOT, "e2e", "fixtures", "workspace");

// The canned "claude" the PTY runs instead of the real CLI (seam S1). Windows
// E2E is nightly-only + best-effort — see the .cmd's TODO.
const E2E_AGENT_CMD = path.join(
  ROOT,
  "e2e",
  "fixtures",
  IS_WIN ? "claude-stub.cmd" : "claude-stub.sh",
);

// Env the app inherits from tauri-driver. Only seams that already exist in the
// app are set here (no AGENTSTUDIO_E2E master gate — that would need a Rust change).
const E2E_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AGENTSTUDIO_CLAUDE_BIN: E2E_AGENT_CMD, // seam S1 (agent/claude.rs — EXISTS)
  AGENTSTUDIO_FANOUT_POLL_MS: "50", // seam S2 (supervisor/mod.rs — EXISTS)
};

const DRIVER_PORT = 4444; // tauri-driver's default proxy port
let driver: ChildProcess | undefined;

/** Wait until something is listening on 127.0.0.1:port, or time out. */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`tauri-driver did not bind :${port} in ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 150);
        }
      });
    };
    tryOnce();
  });
}

/**
 * Make the fixture workspace its own git repo (idempotent). `find_repo_root`
 * walks up to the nearest `.git`; without one here the app would root in the
 * outer Agent Studio repo. The `.git` is not committed (a nested repo cannot be) —
 * it is created here and git-ignored via e2e/.gitignore.
 */
function seedFixtureRepo(): void {
  if (fs.existsSync(path.join(E2E_WORKSPACE, ".git"))) return;
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: E2E_WORKSPACE, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  };
  const id = ["-c", "user.name=e2e", "-c", "user.email=e2e@agentstudio.test"];
  git("init", "-q");
  git(...id, "add", "-A");
  git(...id, "commit", "-q", "-m", "e2e fixture workspace");
}

/**
 * The agent registries a launch RESTORES from (docs/design/agent-restart-restore.md): every
 * open root agent (`open-agents.json`) and every pinned one (`pinned-agents.json`) comes back when the
 * app starts. Every spec file of a run shares one container — so one app-config dir — and an agent a
 * spec left open (e.g. find-scope's quick-launched agent in /tmp/e2e-roots/gazelle) would be
 * restored into the next spec's app: no empty pane to open a terminal from, an extra row in the rail,
 * an extra floor in the City. So each spec FILE starts with neither (`beforeSession`, before its app
 * launches; a spec's own `browser.reloadSession()` does not re-run it, so the restart spec keeps its
 * registry across its own restarts). The app-config dir is Tauri's for this app's identifier, under
 * the CONTAINER's `$XDG_CONFIG_HOME` / `~/.config`; Docker only — on any other machine that dir is a
 * real person's, and this deletes nothing there.
 */
function clearAgentRegistries(spec: string): void {
  if (IS_WIN || !fs.existsSync("/.dockerenv")) return;
  const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as { identifier: string };
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), tauriConf.identifier);
  const removed: string[] = [];
  for (const file of ["open-agents.json", "pinned-agents.json"]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      removed.push(file);
    }
  }
  console.log(`[wdio] ${spec}: starts with no agent to restore (${removed.length > 0 ? `removed ${removed.join(", ")} from` : "nothing to remove in"} ${dir})`);
}

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: DRIVER_PORT,

  specs: ["./specs/**/*.e2e.ts"],
  // The one spec that reaches the public internet (https://example.com/) runs only when asked
  // for (`node scripts/e2e-linux.mjs --external` sets E2E_EXTERNAL=1): a third party's outage
  // must not turn a default run red.
  exclude:
    process.env.E2E_EXTERNAL === "1"
      ? []
      : ["./specs/real-service-external.e2e.ts", "./specs/gazelle-like-external.e2e.ts"],
  // One app window at a time: the Rust core owns real PTYs/processes, and the
  // fixture http server binds a single port per api spec.
  maxInstances: 1,

  capabilities: [
    {
      // tauri-driver reads this vendor capability to know which binary to launch.
      "tauri:options": { application: APP_BINARY, args: [] },
    } as WebdriverIO.Capabilities,
  ],

  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  // Auto-wait budget for `$` commands and expect-webdriverio matcher retries.
  // Generous because the app boots a real webview + a real Rust core.
  waitforTimeout: 15_000,
  // Real PTYs / a real Rust link / a real build need generous waits.
  mochaOpts: { ui: "bdd", timeout: 120_000 },

  /**
   * Build the app once, seed the fixture repo, and start tauri-driver — before
   * any worker. Fails loudly if the binary is missing (a broken build must not
   * silently "pass" zero specs).
   */
  onPrepare: async () => {
    seedFixtureRepo();

    const build = spawnSync(
      "npm",
      ["run", "tauri", "build", "--", "--debug", "--no-bundle"],
      { cwd: ROOT, stdio: "inherit", shell: IS_WIN },
    );
    if (build.status !== 0) throw new Error("tauri build --debug --no-bundle failed");
    if (!fs.existsSync(APP_BINARY)) {
      throw new Error(`built binary not found: ${APP_BINARY}`);
    }

    // On Windows, point tauri-driver at the version-matched Edge WebDriver.
    const args =
      IS_WIN && process.env.MSEDGEDRIVER
        ? ["--native-driver", process.env.MSEDGEDRIVER]
        : [];
    // cwd = the fixture workspace so the launched app roots default_workspace
    // there; env carries the S1/S2 seams. The app inherits both from the proxy.
    driver = spawn("tauri-driver", args, {
      cwd: E2E_WORKSPACE,
      env: E2E_ENV,
      stdio: "inherit",
    });
    driver.on("error", (e) => {
      throw e;
    });
    await waitForPort(DRIVER_PORT, 15_000);
  },

  onComplete: () => {
    driver?.kill();
  },

  // A spec that photographs a time-zone theme (support/app-zone.ts APP_ZONES: village-city → Asia/Tokyo)
  // gets its OWN app launched through a `TZ=… exec <binary>` launcher: wdio creates the session from these
  // same capabilities right after this hook (@wdio/runner), and tauri-driver — one process for the whole
  // run — is untouched, so no other spec's app (and not this worker) changes zone.
  //
  // Opt-in video (`node scripts/e2e-linux.mjs --record` → E2E_RECORD=1, support/record.ts): the whole
  // xvfb display, one mp4 + GIF per spec file. Starts before the session so the app's launch is in it.
  // Both are no-ops when not recording — the default, and what `npm run verify` runs.
  beforeSession: (_config, caps, specs) => {
    const name = specName(specs);
    clearAgentRegistries(name);
    const zone = APP_ZONES[name];
    const tauri = (caps as { "tauri:options"?: { application: string } })["tauri:options"];
    if (zone && tauri && !IS_WIN) {
      tauri.application = zonedLauncher(APP_BINARY, zone);
      console.log(`[wdio] ${name}: the app runs in ${zone} (${tauri.application})`);
    }
    startRecording(name);
  },
  afterSession: async () => {
    await stopRecording();
  },

  // Evidence (added for scripts/e2e-linux.mjs): when E2E_SCREENSHOT_DIR is set, a failing test
  // saves a screenshot of the real app window there; with E2E_CHECKPOINTS=1 EVERY test does
  // (prefixed `ok__`), so a human can look at what each passing test actually saw — the visuals
  // are checked, not only the assertions. No-op otherwise.
  afterTest: async (test, _context, { passed }) => {
    const dir = process.env.E2E_SCREENSHOT_DIR;
    if (!dir || (passed && process.env.E2E_CHECKPOINTS !== "1")) return;
    const name = `${passed ? "ok__" : ""}${test.parent} -- ${test.title}`.replace(/[^\w.-]+/g, "_").slice(0, 150);
    await browser.saveScreenshot(path.join(dir, `${name}.png`)).catch(() => undefined);
  },
};
