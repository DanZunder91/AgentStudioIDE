#!/usr/bin/env node
/** `npm run verify`: everything runnable here; local is the authority. Blocking: hermetic and local
 * integration (#[ignore]d by design); reported only: public internet. The fixture is left as found;
 * no Docker means fail with a reason, never skip. `--plan` prints the plan and runs nothing. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnSpec, WINDOWS_HOST_CHECK_SKIP } from "./platform.mjs";

// fileURLToPath, not `new URL(…).pathname` (`/C:/…` on Windows), and no module-level `new URL`:
// under vitest's jsdom the global URL resolves against http://localhost, breaking test imports.
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

/** `blocking: false`: reported only (third-party breakable). `needsDocker`/`needsFixture`: fail
 * with the reason without Docker; `--no-docker` drops fixture steps. `skipOn`: named SKIP per OS;
 * `onlyOn`: SKIP saying "0 tests" elsewhere (cargo would compile them away and print ok). */
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
    // Real `claude mcp add|get|remove` in throwaway CLAUDE_CONFIG_DIR/HOME/XDG dirs; asserts the
    // user's config stays byte-identical. Catches Claude Code wording changes. No model call.
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
    // Reads this machine's installed apps (no network, so not EXTERNAL); never launches a browser.
    name: "browser enumeration on the real machine",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact",
      "browser_open::tests::live_enumerates_the_browsers_installed_on_this_machine",
    ],
  },
  {
    // System curl honours the injected proxy env against a loopback upstream. Windows curl uses
    // Schannel, so it is tunnelled, and proven never broken.
    name: "real curl through the capture proxy",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "netcap_e2e", "--",
      "--ignored", "--exact", "real_curl_through_the_proxy_is_captured",
    ],
  },
  {
    // A real PTY resolves `curl` to the netcap shim, which drops `--noproxy` and goes through the
    // proxy; with strict off, the same command bypasses again.
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
    // ReportEventW events through the production path into the hub. Leaves
    // `AgentStudio-test-<ulid>` records in the Application log, hence ignored.
    // Windows only (cfg(windows)).
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
    // Cross-compiles and lints cfg(windows) code; runs nothing (see the script's header). Needs
    // Docker. Skipped by name on a Windows host, whose native cargo steps already cover it.
    name: "Windows: the Rust core compiles and lints for Windows (Docker)",
    cmd: "node",
    args: ["scripts/windows-check.mjs"],
    needsDocker: true,
    skipOn: { win32: WINDOWS_HOST_CHECK_SKIP },
  },
  {
    // Layer-6 E2E on Ubuntu in Docker: Tauri's WebDriver can't drive macOS, and macOS UI
    // automation would need an OS permission. Catches what unit tests can't (a 0px column).
    name: "E2E: the real app on Ubuntu (Docker)",
    cmd: "node",
    args: ["scripts/e2e-linux.mjs", "--all"],
    needsDocker: true,
  },
  {
    // The real app on Windows over CDP (WebDriver can't drive WebView2 here). `--build` makes a
    // hermetic debug exe first (own identifier); slow, and nothing leaves the machine.
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
    // The real `village_weather` against Open-Meteo for Asia/Tokyo, then from the in-process cache.
    name: "live weather: Open-Meteo for Asia/Tokyo",
    cmd: "cargo",
    args: [
      "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--",
      "--ignored", "--exact", "weather::tests::live_open_meteo_reports_london",
    ],
    blocking: false,
  },
  {
    // Only https://example.com/: curl via the proxy is decrypted; a client not trusting the IDE's
    // CA is tunnelled and still succeeds (never-break, on the real internet).
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

/** Pure; decides whether the Docker steps run or fail. */
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

/** Pure. `skip` only when redundant on this OS (`skipOn`); a Docker step without Docker fails in
 * its own class, so a blocking one still fails the run, with the cause printed. */
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

/** Pure. Only `--no-network` (external group) and `--no-docker` (fixture step) drop steps; every
 * other step runs, skips with a reason, or fails with a reason. */
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

/** Engines the DB tier dials: only these can block it (an unhealthy driverless engine must not
 * refuse the tier). Add one in the same commit as its driver, or its live tests can be skipped. */
const TIER_ENGINES = ["postgres", "mysql", "clickhouse", "mongo", "redis", "dynamodb"];

/** Pure: "is the fixture usable" is a decision and must be testable. `states`: service → docker
 * health (`healthy`, `unhealthy`, `starting`, `""` with no healthcheck). */
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

/** Pure. Splits on `\r?\n`: Windows Docker may emit CRLF, and `healthy\r` would read unhealthy. */
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

/** Pure; which failures matter is pinned in verify.test.mjs, not left to reading a runner. */
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
