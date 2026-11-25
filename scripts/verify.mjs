#!/usr/bin/env node
/**
 * `npm run verify` — the ONE command that runs everything that can run on this machine.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * CI state on GitHub is not tracked. The one requirement is that every test passes locally —
 * the integration tests included, with no exceptions.
 *
 * So **local is the authority**, and that demands one command rather than a checklist a
 * human assembles from memory. The gap it closes is specific: the usual gate commands
 * cover the hermetic tiers, but every integration test in this repo is `#[ignore]`d — by
 * design (`cargo test` must never need Docker, a network, or a signed-in CLI). The
 * consequence is that the tests which prove the product actually WORKS are
 * exactly the ones a default run silently skips. This runs them too.
 *
 * ── The three classes, and why they are not treated alike ────────────────────
 * Lumping them together would recreate a permanently-red gate: a suite that fails because
 * someone's Wi-Fi is down teaches people to ignore failures.
 *
 *  1. **BLOCKING — hermetic.** typecheck, lint, vitest, coverage, browser tier, cargo
 *     fmt/clippy/test, and the dependency audit. No excuses available.
 *  2. **BLOCKING — local integration.** Real work against things fully under our control:
 *     the Dockerised databases, the installed `claude` CLI, the real `~/.claude`. If these
 *     fail, the product is broken. This is the class that matters most, and the class a
 *     default `cargo test` skips entirely.
 *  3. **REPORTED, non-blocking — public internet.** The live TLS smokes against
 *     example.com / echo.websocket.org / grpcb.in. They prove our TLS stack against the
 *     real world (they are how a change of crypto provider was verified), but a third party's
 *     outage is not our regression. Run, printed, never fatal.
 *
 * Deliberately EXCLUDED, by name and with the reason — because a silent skip is
 * indistinguishable from a pass:
 *   `grpc::tests::reflect_lists_services_from_a_live_server`
 *   `grpc::tests::unary_call_against_a_live_server`
 * Both want a gRPC server on `localhost:50051` that this repo does not ship. They are
 * tests for a fixture that does not exist, not failing tests.
 *
 * ── Docker ───────────────────────────────────────────────────────────────────
 * The database tier needs `docker/db-fixtures`. This script brings it up if it is not
 * already healthy and leaves it **as it found it**: if you had it running, it stays up; if
 * this script started it, it stops it. Nobody should have to remember a teardown.
 *
 * Without Docker at all (a Windows VM with no nested virtualisation, a Mac whose Docker Desktop
 * is stopped), every step that needs it is still in the plan and still FAILS — with the reason
 * printed ("Docker is not available on this machine — …") instead of a stack trace — and every
 * other step still runs. A missing Docker never turns a blocking step into a skip.
 *
 * ── Windows hosts ────────────────────────────────────────────────────────────
 * Command spelling goes through `spawnSpec` (scripts/platform.mjs): npm is `npm.cmd` there and
 * must be spawned through a shell (CVE-2024-27980). The Docker cross-compile
 * (`scripts/windows-check.mjs`) is replaced by a printed SKIP: on Windows the native cargo
 * clippy/test steps compile, lint AND run the `cfg(windows)` code, which is strictly more than
 * the cross-compile proves. The decisions are pure functions (`planSteps`, `decideStep`,
 * `dockerVerdict`), unit-tested in `verify.test.mjs` with the platform passed in.
 * `node scripts/verify.mjs --plan` prints this host's plan (run / skip / fail + reason) and runs
 * nothing.
 *
 * A step whose tests are `cfg`-gated to other OSes (`onlyOn`) is a named SKIP saying
 * "0 tests" rather than a cargo run that compiles them away and prints ok; and a Windows host runs
 * its own local integration — a real PowerShell terminal captured by Network, the Event Log, and
 * the real app over CDP (`scripts/windows-smoke.mjs --build`, hermetic: its own app identifier).
 *
 * Zero dependencies, like `audit.mjs` and `attribution.mjs`.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnSpec, WINDOWS_HOST_CHECK_SKIP } from "./platform.mjs";

// Not `new URL("..", import.meta.url).pathname`: on Windows that is `/C:/Users/…`, which no API
// accepts as a cwd. And not `new URL(…)` at all at module level: under vitest's jsdom environment
// the global `URL` resolves `..` against `http://localhost:3000/@fs/…`, so importing this file in
// a test threw. `fileURLToPath` on the string gives `C:\Users\…` on Windows and the same POSIX
// path as before elsewhere — the form scripts/windows-check.mjs and friends already use.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = "docker/db-fixtures/compose.yaml";

/** ANSI, but only when stdout is a TTY — piped output should stay greppable. */
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `[${code}m${s}[0m` : s);
const bold = (s) => c(1, s);
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const dim = (s) => c(2, s);

/**
 * One step. `blocking: false` means a failure is reported and does not change the exit
 * code — reserved for things a third party can break.
 *
 * `needsDocker: true` — the step cannot run without a Docker daemon; without one it FAILS with
 * that reason (blocking or not, per its class) rather than crashing.
 * `needsFixture: true` — it also needs `docker/db-fixtures` up (the lifecycle in `main`), and it
 * is the step `--no-docker` leaves out.
 * `skipOn: { <platform>: reason }` — the step is redundant on that host OS; it is reported as
 * SKIP with the reason, every run.
 * `onlyOn: { platforms, reason }` — the step's tests exist only on those OSes (they are
 * `cfg`-gated). Elsewhere cargo would compile them away, run ZERO tests and print `ok` — a silent
 * 0-test pass, indistinguishable from a pass — so the step is a SKIP there, with the
 * reason and the words "0 tests".
 */
const HERMETIC = [
  { name: "typecheck", cmd: "npm", args: ["run", "typecheck"] },
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
  { name: "vitest + coverage", cmd: "npm", args: ["run", "test:coverage"] },
  { name: "browser tier", cmd: "npm", args: ["run", "test:browser"] },
  { name: "cargo fmt", cmd: "cargo", args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"] },
  {
    name: "cargo clippy",
    cmd: "cargo",
    args: ["clippy", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--", "-D", "warnings"],
  },
  { name: "cargo test", cmd: "cargo", args: ["test", "--manifest-path", "src-tauri/Cargo.toml"] },
  { name: "dependency audit", cmd: "npm", args: ["run", "audit"] },
];

/** Integration against things WE control. A failure here means the product is broken. */
const LOCAL_INTEGRATION = [
  {
    name: "databases (Docker): db_live",
    cmd: "cargo",
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "db_live", "--", "--ignored"],
    needsDocker: true,
    needsFixture: true,
  },
  {
    name: "usage via the real claude CLI",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact", "usage::tests::live_smoke_reads_real_usage_from_the_cli",
    ],
  },
  {
    name: "context window via the real claude CLI",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact",
      "context_usage::tests::live_context_reads_a_real_session_without_writing_it",
    ],
  },
  {
    // Agent tools over MCP: the real `claude mcp add|get|remove` behind `agent-studio mcp
    // install|status|uninstall`, so a change in the wording Claude Code prints is caught here.
    // In a throwaway CLAUDE_CONFIG_DIR, HOME and XDG dirs: the user's Claude Code config is never
    // written, and the test asserts it comes out byte-identical. No model call. Claude's own
    // health check starts the built binary as the MCP server.
    name: "MCP install via the real claude CLI (throwaway config)",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "agent_mcp", "--",
      "--ignored", "--exact", "real_claude_adds_checks_and_removes_the_server_in_a_throwaway_config",
    ],
    // `install` runs only for input typed at a terminal, so the test gives the binary a pty of
    // its own; Windows has no such pty to hand a child here, and verify's own stdin is not a
    // console when a program runs it.
    onlyOn: {
      platforms: ["darwin", "linux"],
      reason:
        "macOS/Linux only (cfg(unix)): the test types `agent-studio mcp install` into a pty of its " +
        "own, and moves HOME to keep Claude Code's config untouched; Windows has neither here",
    },
  },
  {
    name: "metrics over the real ~/.claude",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact", "metrics::tests::live_metrics_scans_all_projects_with_no_cwd",
    ],
  },
  {
    // Agent Village: the `claude` sessions running OUTSIDE the IDE, through the
    // command's own path (home_dir, spawn_blocking, the live process probe). Reads
    // ~/.claude/projects and the process table; writes nothing.
    name: "external agents over the real ~/.claude",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact", "external_agents::tests::live_external_agents_scan_the_real_home",
    ],
  },
  {
    // "Open in Browser": enumeration reads this machine's real installed
    // apps, so it belongs here rather than in EXTERNAL — no network, nothing a
    // third party can break. It asserts a browser was FOUND and that the argv
    // built for it is the `open -b <bundle-id>` form; it never launches one.
    name: "browser enumeration on the real machine",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact",
      "browser_open::tests::live_enumerates_the_browsers_installed_on_this_machine",
    ],
  },
  {
    // Network capture: the system curl, driven through the proxy with the env
    // `pty_env` injects, against a loopback upstream. Proves a real client honours the
    // variables — nothing leaves the host. macOS/Linux: `/usr/bin/curl`, decrypted. Windows:
    // `System32\curl.exe` — Schannel, so tunnelled, and proven never broken.
    name: "real curl through the capture proxy",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "netcap_e2e", "--",
      "--ignored", "--exact", "real_curl_through_the_proxy_is_captured",
    ],
  },
  {
    // An agent's `curl --noproxy '*' http://127.0.0.1:…` in an IDE terminal used to
    // never reach Network. A REAL PTY with the injected env resolves `curl`
    // to the netcap curl shim, which drops the bypass and execs the real /usr/bin/curl through
    // the proxy (attributed to the terminal); strict off, the same command bypasses again.
    name: "real curl --noproxy in a PTY captured by the curl shim",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "netcap_e2e", "--",
      "--ignored", "--exact", "real_curl_noproxy_in_a_pty_is_captured_by_the_shim",
    ],
    onlyOn: {
      platforms: ["darwin", "linux"],
      reason:
        "macOS/Linux only (cfg(unix)): a Windows terminal's PATH carries no curl shim — PowerShell " +
        "would open the extensionless file — and its curl.exe is covered by the next step",
    },
  },
  {
    // Network capture on WINDOWS: a REAL PowerShell terminal — ConPTY, the IDE's
    // startup command, the env `pty_env` hands it — runs curl.exe, node fetch and
    // Invoke-WebRequest; each is captured and attributed to the terminal (netcap_e2e.rs).
    name: "Windows: a real PowerShell terminal captured by Network",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "netcap_e2e", "--",
      "--ignored", "--exact", "on_windows_a_powershell_terminal_is_captured",
    ],
    onlyOn: { platforms: ["win32"], reason: "Windows only (cfg(windows)): a real PowerShell terminal under ConPTY" },
  },
  {
    // Agent Logs · system apps: a unique line sent with
    // /usr/bin/logger travels the production path — real `log stream` → parser → hub. macOS
    // only (the test is cfg-gated, so on Linux this step runs zero tests and passes).
    name: "real macOS log stream into the log hub",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "syslog_live", "--",
      "--ignored", "--exact", "real_log_stream_delivers_a_logger_line_into_the_hub",
    ],
    onlyOn: { platforms: ["darwin"], reason: "macOS only: the real /usr/bin/log stream (Windows' Event Log is its own step)" },
  },
  {
    // Agent Logs · system apps on WINDOWS: an event written with ReportEventW
    // under a fresh source travels the production path — `Syslog::set` → EvtSubscribe →
    // EvtRender/EvtFormatMessage → hub — and the level floor, the provider filter and disable are
    // checked on real events. Leaves `AgentStudio-test-<ulid>` records in the Application log,
    // hence ignored. Windows only (the module is cfg(windows); zero tests elsewhere).
    name: "real Windows Event Log into the log hub",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact", "syslog::winevt::tests::a_real_event_arrives_through_the_whole_pipeline",
    ],
    onlyOn: { platforms: ["win32"], reason: "Windows only (cfg(windows)): the real Event Log" },
  },
  {
    // Network · whole computer: the real /usr/bin/nettop sampler emits apps with bytes,
    // and its child is gone within 300 ms of stop. macOS only (cfg-gated; zero tests on Linux,
    // where the non-ignored /proc tests in the same file already run under `cargo test`).
    name: "real nettop whole-computer sampler",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "netmachine", "--",
      "--ignored", "--exact", "macos_real_nettop_sampler_emits_apps_with_bytes",
    ],
    onlyOn: { platforms: ["darwin"], reason: "macOS only: the real /usr/bin/nettop sampler" },
  },
  {
    // Logs · background tasks: a real /bin/sh loop writing under a temp
    // claude root is tailed into `task` lines — the path a real background service takes.
    name: "real background task tailed into the log hub",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "logstream_tasks", "--",
      "--ignored", "--exact", "a_real_background_process_is_tailed_as_task_lines",
    ],
    // `tests/logstream_tasks.rs` is `#![cfg(unix)]`, so on Windows this step would run an
    // empty binary and print ok — the silent pass the `onlyOn` SKIP exists to name.
    onlyOn: {
      platforms: ["darwin", "linux"],
      reason:
        "macOS/Linux only (cfg(unix)): it runs a real /bin/sh background process; Windows' task " +
        "tails (%TEMP%\\claude roots, Git Bash /c/ paths) are tested natively by the lib's logstream::tasks tests",
    },
  },
  {
    // The Rust core compiled and linted FOR Windows (scripts/windows-check.mjs): a Linux
    // container cross-compiling to x86_64-pc-windows-gnu, since a Mac cannot run Windows.
    // Proves every `cfg(windows)` item and Windows-only test type-checks and passes clippy;
    // RUNS nothing (the script's header lists what a green does not prove). Without it, no
    // local gate looks at Windows-only code at all. Needs Docker, like
    // db_live. ~45 s cold, ~10 s warm. On a Windows HOST it is skipped by name: the
    // native cargo steps above already compile, lint and run the cfg(windows) code.
    name: "Windows: the Rust core compiles and lints for Windows (Docker)",
    cmd: "node",
    args: ["scripts/windows-check.mjs"],
    needsDocker: true,
    skipOn: { win32: WINDOWS_HOST_CHECK_SKIP },
  },
  {
    // Layer-6 E2E against the REAL app, on Ubuntu in Docker — Tauri's WebDriver
    // cannot drive macOS, and macOS UI automation needs a permission (no OS permission may
    // be required). Needs Docker, like db_live. It catches what unit tests cannot: a column
    // rendering at 0px, or a wdio.conf that never loads (`__dirname` in ESM).
    name: "E2E: the real app on Ubuntu (Docker)",
    cmd: "node",
    args: ["scripts/e2e-linux.mjs", "--all"],
    needsDocker: true,
  },
  {
    // The REAL app on WINDOWS: WebView2 + the Rust core + real PTYs, driven over CDP
    // by Playwright (scripts/windows-smoke.mjs) — Tauri's WebDriver tier cannot drive WebView2 here.
    // `--build` builds the exe it needs first: `tauri build --debug --no-bundle` with a config
    // override in the OS temp dir (a remote-debugging port, a fresh `npm run build`, and the smoke's
    // OWN identifier, so the run never reads or writes the user's real app data), copied out of
    // `target` before it runs. Slow (a debug build of the whole app); nothing leaves the machine.
    name: "Windows: the real app (WebView2) smoke",
    cmd: "node",
    args: ["scripts/windows-smoke.mjs", "--build"],
    onlyOn: { platforms: ["win32"], reason: "Windows only: drives the real WebView2 app over CDP" },
  },
];

/** Real TLS against the public internet. Someone else's outage is not our regression. */
const EXTERNAL = [
  {
    name: "live TLS: https / wss / grpcs",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "live_smoke_https", "live_smoke_wss", "live_smoke_grpcs",
    ],
    blocking: false,
  },
  {
    // The PR view's `gh` shell-out. External, not local-integration,
    // on purpose: the installed CLI is ours to require, but the smoke's answer
    // crosses the network to GitHub — their outage is not our regression.
    name: "open PRs via the real gh CLI",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact", "gh_prs::tests::live_smoke_lists_prs_via_gh",
    ],
    blocking: false,
  },
  {
    // Agent Village ambience (the Village shows the real weather): the
    // real `village_weather` command against Open-Meteo for Asia/Tokyo — zone → city coordinates,
    // the live forecast parsed, then served again from the in-process cache. Open-Meteo's
    // outage is not our regression.
    name: "live weather: Open-Meteo for Asia/Tokyo",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact", "weather::tests::live_open_meteo_reports_london",
    ],
    blocking: false,
  },
  {
    // Network capture against a REAL site (a service that makes a real outbound HTTP call, to a
    // safe target). Only https://example.com/ (IANA). curl through
    // the proxy is decrypted (200, "Example Domain"); a client that doesn't read the IDE's CA is
    // tunnelled and its request still succeeds — the never-break guarantee on the real internet.
    name: "live: example.com through the capture proxy",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "netcap_e2e", "--",
      "--ignored", "--exact", "live_example_com_through_the_proxy",
    ],
    blocking: false,
  },
  {
    // The same promise seen in the REAL app (e2e/specs/real-service-external.e2e.ts): Decrypt
    // HTTPS on, curl to example.com decrypted with the page in the detail pane, wget tunnelled
    // with its note and still succeeding, and the fixture service's own upstream call logged.
    name: "E2E (external): example.com in the real app on Ubuntu (Docker)",
    cmd: "node",
    args: ["scripts/e2e-linux.mjs", "--external"],
    blocking: false,
    needsDocker: true,
  },
  {
    // The one-command Linux installer piped into bash in Ubuntu and Fedora containers: the .deb,
    // the .rpm and the AppImage routes, each run twice. External: it installs the latest
    // published release, from GitHub and the distributions' mirrors.
    name: "Linux installer: .deb / .rpm / AppImage installs (Docker)",
    cmd: "node",
    args: ["scripts/install-linux-check.mjs"],
    blocking: false,
    needsDocker: true,
  },
];

/** `spawnSync`, spelled for this host (`npm` → `npm.cmd` through a shell on Windows). */
function spawnHere(cmd, args, options) {
  const spec = spawnSpec(cmd, args);
  return spawnSync(spec.cmd, spec.args, { ...options, ...spec.options });
}

function run(step) {
  const started = Date.now();
  const result = (ok, reason = null) => ({
    name: step.name,
    ok,
    ms: Date.now() - started,
    blocking: step.blocking !== false,
    reason,
  });
  let r;
  try {
    r = spawnHere(step.cmd, step.args, { cwd: REPO, stdio: "inherit" });
  } catch (err) {
    return result(false, err.message);
  }
  // A command that could not even start (not on PATH, EINVAL) used to read as a bare FAIL with
  // no output at all; say what happened.
  if (r.error) return result(false, `could not start \`${step.cmd}\`: ${r.error.message}`);
  return result(r.status === 0);
}

/**
 * What `docker info` said about this machine. Pure: takes the `spawnSync` result.
 * Exported and unit-tested — "is Docker here" decides whether four steps run or fail.
 */
export function dockerVerdict(probe) {
  if (probe.error) {
    if (probe.error.code === "ENOENT") {
      return { available: false, reason: "the `docker` command is not installed (not found on PATH)" };
    }
    if (probe.error.code === "ETIMEDOUT") {
      return { available: false, reason: "`docker info` did not answer within 60 s" };
    }
    return { available: false, reason: `\`docker info\` could not be run: ${probe.error.message}` };
  }
  if (probe.status !== 0) {
    const detail = String(probe.stderr ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return {
      available: false,
      reason: `the Docker daemon is not reachable (\`docker info\` exited ${probe.status}${detail ? `: ${detail}` : ""})`,
    };
  }
  return { available: true, reason: null };
}

function probeDocker() {
  return dockerVerdict(
    spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 60_000 }),
  );
}

/**
 * Run, skip, or fail-without-running — for one step on this host. Pure.
 *  - `skip` only for a step that is REDUNDANT on this OS (`skipOn`), with the reason printed.
 *  - `fail` for a step that needs Docker on a machine without it: it keeps its class (blocking
 *    or external), so a blocking Docker step still fails the run (never a silent skip), with
 *    the cause printed rather than a stack trace.
 */
export function decideStep(step, platform, docker) {
  const hostSkip = step.skipOn?.[platform];
  if (hostSkip) return { step, action: "skip", reason: hostSkip };
  if (step.onlyOn && !step.onlyOn.platforms.includes(platform)) {
    return { step, action: "skip", reason: `${step.onlyOn.reason} — on this host it would run 0 tests and print a pass` };
  }
  if (step.needsDocker && !docker.available) {
    return { step, action: "fail", reason: `Docker is not available on this machine — ${docker.reason}` };
  }
  return { step, action: "run", reason: null };
}

/**
 * The whole plan, per group. Pure. `--no-network` drops the external group; `--no-docker` drops
 * the database-fixture step (and `main` says so in the summary) — exactly as before. Nothing else
 * is ever dropped: every other step is run, skipped with a reason, or failed with a reason.
 */
export function planSteps({ groups, platform, docker, skipDocker = false, skipExternal = false }) {
  return groups
    .filter((g) => !(g.external && skipExternal))
    .map((g) => ({
      group: g.name,
      entries: g.steps.filter((s) => !(s.needsFixture && skipDocker)).map((s) => decideStep(s, platform, docker)),
    }));
}

/** The groups `main` runs, in order. Exported so the tests plan against the real step list. */
export const GROUPS = [
  { name: "hermetic", steps: HERMETIC },
  { name: "local integration", steps: LOCAL_INTEGRATION },
  { name: "external (non-blocking)", steps: EXTERNAL, external: true },
];

/**
 * The engines the database tier actually dials. **Postgres, MySQL, ClickHouse and MongoDB** have
 * drivers (six of the eight presets, counting the two Aurora rows), so those four can break the
 * product; the rest exist for the drivers still to come.
 *
 * 🔴 Why this list exists at all: `fixtureHealthy` used to require **every** container to be
 * healthy, so an unhealthy ClickHouse — an engine no test touches — refused to run the whole
 * tier, and with it the only tests that prove the database client works. A gate that fails
 * for a reason unrelated to the code teaches people to skip it. Add an engine here in the same commit that adds its driver:
 * a driver whose container cannot block the tier is a driver whose live tests can be silently
 * skipped, which is the same defect from the other side.
 */
const TIER_ENGINES = ["postgres", "mysql", "clickhouse", "mongo", "redis", "dynamodb"];

/**
 * Which fixture containers matter, and what to say about the rest. Pure and unit-tested:
 * "is the fixture usable" is a decision, and a decision inside a runner that nobody can test
 * is how a permanently-red gate gets built in the first place.
 *
 * `states` maps service name → docker health string (`healthy`, `unhealthy`, `starting`, `""`
 * for a container with no healthcheck).
 */
export function fixtureVerdict(states, required = TIER_ENGINES) {
  const names = Object.keys(states);
  const missing = required.filter((n) => !names.includes(n));
  const unhealthyRequired = required.filter((n) => names.includes(n) && states[n] !== "healthy");
  const unhealthyOther = names
    .filter((n) => !required.includes(n))
    .filter((n) => states[n] !== "healthy");
  return {
    // Nothing running at all is not "usable" — it means the fixture has to be started.
    usable: names.length > 0 && missing.length === 0 && unhealthyRequired.length === 0,
    blocking: [...missing, ...unhealthyRequired],
    // Reported, never fatal: an engine with no driver cannot break the product today.
    reported: unhealthyOther,
  };
}

/**
 * Parse `docker compose ps --format "{{.Service}}\t{{.Health}}"`. Pure. Splits on `\r?\n`: the
 * Docker CLI on Windows may end lines with CRLF, and a `\r` left on the health string would make
 * `healthy\r` read as unhealthy — the whole tier refused for a line ending.
 */
export function parseFixtureStates(stdout) {
  const states = {};
  for (const line of String(stdout).trim().split(/\r?\n/).filter(Boolean)) {
    const [service, health = ""] = line.split("\t");
    states[service] = health;
  }
  return states;
}

/** Read each fixture service's health from docker. */
function fixtureStates() {
  const r = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE, "ps", "--format", "{{.Service}}\t{{.Health}}"],
    { cwd: REPO, encoding: "utf8" },
  );
  if (r.status !== 0) return {};
  return parseFixtureStates(r.stdout);
}

/**
 * The pure verdict. Exported and unit-tested (`verify.test.mjs`) because the interesting
 * logic is *which* failures matter, and that must not be discovered by reading a runner.
 */
export function classify(results) {
  const failedBlocking = results.filter((r) => !r.ok && r.blocking);
  const failedExternal = results.filter((r) => !r.ok && !r.blocking);
  const skipped = results.filter((r) => r.skipped);
  return {
    ok: failedBlocking.length === 0,
    failedBlocking: failedBlocking.map((r) => r.name),
    failedExternal: failedExternal.map((r) => r.name),
    // Named in the verdict so the summary can never fold a skip into the passes.
    skipped: skipped.map((r) => r.name),
    ran: results.length - skipped.length,
  };
}

function main() {
  const args = process.argv.slice(2);
  const skipExternal = args.includes("--no-network");
  const skipDocker = args.includes("--no-docker");

  console.log(bold("\nverify — everything this machine can run\n"));

  const docker = probeDocker();
  if (!docker.available) {
    console.log(yellow(`  Docker is not available on this machine — ${docker.reason}.`));
    console.log(dim("  Every step that needs it will be reported as FAILED (not skipped); the rest still run.\n"));
  }
  const plan = planSteps({ groups: GROUPS, platform: process.platform, docker, skipDocker, skipExternal });

  if (args.includes("--plan")) {
    // Print what this host WOULD do — run / skip / fail, with each reason — and run nothing.
    // Exit 0: a plan is not a verdict.
    for (const { group, entries } of plan) {
      console.log(bold(`──── ${group} ────`));
      for (const { step, action, reason } of entries) {
        const mark = action === "run" ? "RUN " : action === "skip" ? yellow("SKIP") : red("FAIL");
        const cls = step.blocking === false ? dim(" (non-blocking)") : "";
        console.log(`  ${mark}  ${step.name}${cls}${reason ? dim(` — ${reason}`) : ""}`);
      }
    }
    console.log(dim("\n  --plan: nothing was run.\n"));
    process.exit(0);
  }

  let startedDocker = false;
  const wantDocker =
    docker.available && plan.some((g) => g.entries.some((e) => e.step.needsFixture && e.action === "run"));
  if (wantDocker) {
    let verdict = fixtureVerdict(fixtureStates());
    if (verdict.usable) {
      console.log(dim("  database fixture already usable — leaving it as found\n"));
    } else {
      console.log(dim("  starting the database fixture…\n"));
      // `--wait` fails the command when ANY service is unhealthy, including one the tier does
      // not dial, so its exit code is not the verdict — the verdict is re-read below.
      spawnHere("npm", ["run", "db:fixtures:up"], { cwd: REPO, stdio: "inherit" });
      startedDocker = true;
      verdict = fixtureVerdict(fixtureStates());
      if (!verdict.usable) {
        console.log(
          red(`\n  the database tier cannot run — unusable: ${verdict.blocking.join(", ")}\n`),
        );
        console.log("  Start Docker, or re-run with --no-docker to skip that tier honestly.\n");
        process.exit(1);
      }
    }
    if (verdict.reported.length > 0) {
      // Said out loud, every run: these engines have no driver yet, so they cannot fail the
      // gate — but a silently-unhealthy container is how a fixture rots unnoticed.
      console.log(
        yellow(`  fixture engines unhealthy but NOT used by any test: ${verdict.reported.join(", ")}`) +
          dim("\n  (no driver for them yet — they will block this tier once they have one)\n"),
      );
    }
  }

  const results = [];
  for (const { group, entries } of plan) {
    if (entries.length === 0) continue;
    console.log(bold(`\n──── ${group} ────\n`));
    for (const { step, action, reason } of entries) {
      console.log(bold(`\n▶ ${step.name}`));
      const blocking = step.blocking !== false;
      if (action === "skip") {
        console.log(yellow(`  SKIPPED — ${reason}`));
        results.push({ name: step.name, ok: true, skipped: true, ms: 0, blocking, reason });
      } else if (action === "fail") {
        console.log((blocking ? red : yellow)(`  NOT RUN, counted as FAILED — ${reason}`));
        results.push({ name: step.name, ok: false, ms: 0, blocking, reason });
      } else {
        const r = run(step);
        if (r.reason) console.log(red(`  ${r.reason}`));
        results.push(r);
      }
    }
  }

  if (startedDocker) {
    console.log(dim("\n  stopping the database fixture (this run started it)…"));
    spawnHere("npm", ["run", "db:fixtures:down"], { cwd: REPO, stdio: "ignore" });
  }

  const verdict = classify(results);

  console.log(bold("\n\n──── summary ────\n"));
  for (const r of results) {
    const mark = r.skipped
      ? yellow("SKIP")
      : r.ok
        ? green("PASS")
        : r.blocking
          ? red("FAIL")
          : yellow("FAIL (external)");
    const why = r.reason ? dim(` — ${r.reason}`) : "";
    console.log(`  ${mark}  ${r.name} ${dim(`${(r.ms / 1000).toFixed(1)}s`)}${why}`);
  }
  if (!docker.available) {
    console.log(
      yellow(`\n  Docker is not available on this machine — ${docker.reason}.`) +
        dim(
          "\n  The steps that need it FAILED by class (blocking ones fail the run). Start Docker to run them;" +
            "\n  --no-docker leaves out only the database tier, and says so.",
        ),
    );
  }
  if (skipDocker) console.log(yellow("\n  SKIPPED the database tier (--no-docker) — this run did not prove it."));
  if (skipExternal) console.log(dim("\n  skipped the external TLS tier (--no-network)."));
  console.log(
    dim(
      "\n  Not run, deliberately: grpc reflect/unary live tests — they need a gRPC server on\n" +
        "  localhost:50051 that this repo does not ship.",
    ),
  );

  if (verdict.failedExternal.length > 0) {
    console.log(
      yellow(`\n  ${verdict.failedExternal.length} external step(s) failed — reported, not fatal: `) +
        verdict.failedExternal.join(", "),
    );
  }
  if (verdict.skipped.length > 0) {
    console.log(
      yellow(`\n  ${verdict.skipped.length} step(s) SKIPPED on this host, each for the reason above: `) +
        verdict.skipped.join(", "),
    );
  }
  console.log(verdict.ok ? green("\n  overall: PASS\n") : red(`\n  overall: FAIL — ${verdict.failedBlocking.join(", ")}\n`));
  process.exit(verdict.ok ? 0 : 1);
}

// Only run when invoked directly, so the tests can import `classify` cleanly.
if (process.argv[1] && process.argv[1].endsWith("verify.mjs")) main();
