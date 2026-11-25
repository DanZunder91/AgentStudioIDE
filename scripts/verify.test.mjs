/**
 * The verdict logic of `npm run verify`.
 *
 * Only `classify` is tested, and that is the point: the interesting decision in a runner is
 * **which failures matter**, and that must be pinned rather than discovered by reading the
 * script. Whether `spawnSync` shells out correctly is not a claim worth a test; whether a
 * third party's outage can turn the whole verification red is (a suite that fails for
 * reasons nobody can fix teaches people to ignore failures).
 *
 * Literal expectations throughout, never read back from the module under test.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { spawnSpec, WINDOWS_HOST_CHECK_SKIP } from "./platform.mjs";
import {
  appDataDirs,
  builtExePath,
  isHermetic,
  REAL_IDENTIFIER,
  SMOKE_IDENTIFIER,
  smokeTauriConfig,
  tauriBuildArgs,
} from "./windows-smoke-config.mjs";
import {
  classify,
  decideStep,
  dockerVerdict,
  fixtureVerdict,
  GROUPS,
  parseFixtureStates,
  planSteps,
} from "./verify.mjs";

const pass = (name, blocking = true) => ({ name, ok: true, ms: 1, blocking });
const fail = (name, blocking = true) => ({ name, ok: false, ms: 1, blocking });

describe("classify", () => {
  it("passes when everything passed", () => {
    const v = classify([pass("typecheck"), pass("cargo test"), pass("live TLS", false)]);
    expect(v.ok).toBe(true);
    expect(v.failedBlocking).toEqual([]);
    expect(v.failedExternal).toEqual([]);
    expect(v.ran).toBe(3);
  });

  it("FAILS on a blocking failure", () => {
    const v = classify([pass("typecheck"), fail("cargo test")]);
    expect(v.ok).toBe(false);
    expect(v.failedBlocking).toEqual(["cargo test"]);
  });

  it("does NOT fail on an external failure — someone else's outage is not our regression", () => {
    // The whole reason the tiers are separated. If this ever flips, a flaky third-party host
    // can make a fully green local run impossible to achieve, and the local-authority rule
    // becomes unsatisfiable through no fault of the code.
    const v = classify([pass("cargo test"), fail("live TLS: https / wss / grpcs", false)]);
    expect(v.ok).toBe(true);
    expect(v.failedExternal).toEqual(["live TLS: https / wss / grpcs"]);
    expect(v.failedBlocking).toEqual([]);
  });

  it("still fails when a blocking step fails ALONGSIDE an external one", () => {
    // The external failure must not mask or excuse the real one.
    const v = classify([fail("databases (Docker): db_live"), fail("live TLS", false)]);
    expect(v.ok).toBe(false);
    expect(v.failedBlocking).toEqual(["databases (Docker): db_live"]);
    expect(v.failedExternal).toEqual(["live TLS"]);
  });

  it("treats the local INTEGRATION tier as blocking", () => {
    // Every test must pass locally, the integration tests included. The Docker database
    // tier and the real-CLI tiers are fully under our control, so a failure there is a
    // broken product, not an environment problem.
    for (const name of [
      "databases (Docker): db_live",
      "usage via the real claude CLI",
      "metrics over the real ~/.claude",
    ]) {
      expect(classify([fail(name)]).ok).toBe(false);
    }
  });

  it("reports every failure, not just the first", () => {
    const v = classify([fail("lint"), fail("cargo clippy"), pass("typecheck")]);
    expect(v.failedBlocking).toEqual(["lint", "cargo clippy"]);
  });

  it("passes vacuously on an empty run, and says how many steps ran", () => {
    // A zero-step run must not read as success in the summary; `ran` is what makes that
    // visible, which matters when --no-docker/--no-network narrow the plan.
    const v = classify([]);
    expect(v.ok).toBe(true);
    expect(v.ran).toBe(0);
    expect(v.skipped).toEqual([]);
  });

  it("names a host SKIP in the verdict and does not count it as a step that ran", () => {
    // A skip is not a failure (the Windows cross-compile is redundant on a Windows host), but it
    // must never be folded into the passes either: a silent skip reads as a pass.
    const v = classify([
      pass("cargo test"),
      { name: "Windows: the Rust core compiles and lints for Windows (Docker)", ok: true, skipped: true, ms: 0, blocking: true },
    ]);
    expect(v.ok).toBe(true);
    expect(v.skipped).toEqual(["Windows: the Rust core compiles and lints for Windows (Docker)"]);
    expect(v.ran).toBe(1);
    expect(v.failedBlocking).toEqual([]);
  });
});

describe("spawnSpec — how each host spells a command", () => {
  it("is the identity on macOS and Linux — their behaviour must not change", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(spawnSpec("npm", ["run", "typecheck"], platform)).toEqual({
        cmd: "npm",
        args: ["run", "typecheck"],
        options: {},
      });
      expect(spawnSpec("cargo", ["test"], platform)).toEqual({ cmd: "cargo", args: ["test"], options: {} });
    }
  });

  it("on Windows spawns npm/npx as their .cmd batch files THROUGH a shell", () => {
    // Bare `npm` is ENOENT on Windows (there is no npm.exe), and `npm.cmd` without a shell is
    // EINVAL since Node 18.20.2 / 20.12.2 (CVE-2024-27980) — audit.mjs failed exactly that way.
    expect(spawnSpec("npm", ["run", "test:coverage"], "win32")).toEqual({
      cmd: "npm.cmd",
      args: ["run", "test:coverage"],
      options: { shell: true },
    });
    expect(spawnSpec("npx", ["vitest", "run"], "win32")).toEqual({
      cmd: "npx.cmd",
      args: ["vitest", "run"],
      options: { shell: true },
    });
  });

  it("on Windows leaves real executables alone — no shell for cargo, node, docker, git", () => {
    for (const cmd of ["cargo", "node", "docker", "git"]) {
      expect(spawnSpec(cmd, ["--version"], "win32")).toEqual({ cmd, args: ["--version"], options: {} });
    }
  });

  it("REFUSES an argument cmd.exe would re-interpret, rather than quoting it", () => {
    for (const bad of ["a&b", "two words", "%PATH%", "x|y", 'q"uote', "a^b", "<in", "!x!"]) {
      expect(() => spawnSpec("npm", ["run", bad], "win32")).toThrow(
        `refusing to run \`npm\` through cmd.exe with argument(s) it would re-interpret: ${JSON.stringify(bad)}`,
      );
    }
    // The same argument is fine where no shell is involved.
    expect(spawnSpec("npm", ["run", "a&b"], "darwin").args).toEqual(["run", "a&b"]);
  });

  it("accepts every npm invocation the gates actually make, on Windows", () => {
    // If a step's arguments ever needed quoting, `verify` would fail that step on Windows only —
    // so check the real list, plus the audit's and the fixture lifecycle's calls.
    const npmCalls = GROUPS.flatMap((g) => g.steps)
      .filter((s) => s.cmd === "npm")
      .map((s) => s.args);
    expect(npmCalls).toEqual([
      ["run", "typecheck"],
      ["run", "lint"],
      ["run", "test:coverage"],
      ["run", "test:browser"],
      ["run", "audit"],
    ]);
    for (const args of [
      ...npmCalls,
      ["audit", "--json", "--omit=dev"],
      ["audit", "--json"],
      ["run", "db:fixtures:up"],
      ["run", "db:fixtures:down"],
    ]) {
      expect(spawnSpec("npm", args, "win32").cmd).toBe("npm.cmd");
    }
  });
});

describe("dockerVerdict — is there a Docker daemon on this machine", () => {
  it("is available when `docker info` exits 0", () => {
    expect(dockerVerdict({ status: 0, stdout: "27.3.1\n", stderr: "" })).toEqual({ available: true, reason: null });
  });

  it("says the command is not installed when docker is not on PATH (ENOENT)", () => {
    const err = Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" });
    expect(dockerVerdict({ error: err, status: null })).toEqual({
      available: false,
      reason: "the `docker` command is not installed (not found on PATH)",
    });
  });

  it("says the daemon is unreachable, with docker's own first line, when the CLI exists", () => {
    const v = dockerVerdict({
      status: 1,
      stdout: "",
      stderr:
        "\r\nerror during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.\r\n",
    });
    expect(v).toEqual({
      available: false,
      reason:
        "the Docker daemon is not reachable (`docker info` exited 1: error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.)",
    });
  });

  it("names a timeout and any other spawn error rather than crashing", () => {
    const timeout = Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(dockerVerdict({ error: timeout, status: null }).reason).toBe("`docker info` did not answer within 60 s");
    const other = Object.assign(new Error("spawnSync docker EACCES"), { code: "EACCES" });
    expect(dockerVerdict({ error: other, status: null })).toEqual({
      available: false,
      reason: "`docker info` could not be run: spawnSync docker EACCES",
    });
  });

  it("does not invent a detail when the failing daemon printed nothing", () => {
    expect(dockerVerdict({ status: 1, stdout: "", stderr: "" }).reason).toBe(
      "the Docker daemon is not reachable (`docker info` exited 1)",
    );
  });
});

describe("planSteps — what runs, what is skipped, what fails without running", () => {
  const DOCKER = { available: true, reason: null };
  const NO_DOCKER = { available: false, reason: "the `docker` command is not installed (not found on PATH)" };
  const DB = "databases (Docker): db_live";
  const WINCHECK = "Windows: the Rust core compiles and lints for Windows (Docker)";
  const E2E = "E2E: the real app on Ubuntu (Docker)";
  const E2E_EXT = "E2E (external): example.com in the real app on Ubuntu (Docker)";
  const LINUX_INSTALL = "Linux installer: .deb / .rpm / AppImage installs (Docker)";
  // The cfg-gated steps (`onlyOn`): on any other OS cargo would run 0 tests and print `ok`.
  const SHIM = "real curl --noproxy in a PTY captured by the curl shim";
  const WIN_PS = "Windows: a real PowerShell terminal captured by Network";
  const MAC_LOG = "real macOS log stream into the log hub";
  const WIN_LOG = "real Windows Event Log into the log hub";
  const NETTOP = "real nettop whole-computer sampler";
  const WIN_SMOKE = "Windows: the real app (WebView2) smoke";
  const TASKS = "real background task tailed into the log hub";
  const MCP = "MCP install via the real claude CLI (throwaway config)";
  const GATED_OFF = {
    darwin: [WIN_PS, WIN_LOG, WIN_SMOKE],
    linux: [WIN_PS, MAC_LOG, WIN_LOG, NETTOP, WIN_SMOKE],
    win32: [MCP, SHIM, MAC_LOG, NETTOP, TASKS],
  };
  const everyStep = GROUPS.flatMap((g) => g.steps.map((s) => s.name));
  const flat = (plan) => plan.flatMap((g) => g.entries);
  const byAction = (plan, action) => flat(plan).filter((e) => e.action === action).map((e) => e.step.name);

  it("on macOS and Linux with Docker, runs every step except the other OSes' cfg-gated ones — named, not silent", () => {
    for (const platform of ["darwin", "linux"]) {
      const plan = planSteps({ groups: GROUPS, platform, docker: DOCKER });
      expect(plan.map((g) => g.group)).toEqual(["hermetic", "local integration", "external (non-blocking)"]);
      expect(byAction(plan, "run")).toEqual(everyStep.filter((n) => !GATED_OFF[platform].includes(n)));
      expect(byAction(plan, "skip")).toEqual(GATED_OFF[platform]);
      expect(byAction(plan, "fail")).toEqual([]);
    }
  });

  it("🔴 a cfg-gated step on another OS is a SKIP that says '0 tests' — never a silent 0-test pass", () => {
    // Without `onlyOn`, the curl-shim step would run on Windows, compile its cfg(unix) test away,
    // run nothing and print ok — indistinguishable from a pass.
    const plan = planSteps({ groups: GROUPS, platform: "win32", docker: DOCKER });
    const shim = flat(plan).find((e) => e.step.name === SHIM);
    expect(shim.action).toBe("skip");
    expect(shim.reason).toBe(
      "macOS/Linux only (cfg(unix)): a Windows terminal's PATH carries no curl shim — PowerShell would open " +
        "the extensionless file — and its curl.exe is covered by the next step — on this host it would run 0 tests and print a pass",
    );
    const onLinux = flat(planSteps({ groups: GROUPS, platform: "linux", docker: DOCKER }));
    expect(onLinux.find((e) => e.step.name === MAC_LOG).reason).toContain("would run 0 tests");
    // The background-task step's test file is `#![cfg(unix)]` too. On Windows it would run an
    // empty binary and print ok; it is a named SKIP there, pointing at the native lib tests.
    const tasks = flat(plan).find((e) => e.step.name === TASKS);
    expect(tasks.action).toBe("skip");
    expect(tasks.reason).toContain("logstream::tasks");
    expect(tasks.reason).toContain("would run 0 tests");
    expect(onLinux.find((e) => e.step.name === TASKS).action).toBe("run");
    const step = { name: "x", onlyOn: { platforms: ["win32"], reason: "Windows only" } };
    expect(decideStep(step, "win32", DOCKER)).toEqual({ step, action: "run", reason: null });
    expect(decideStep(step, "darwin", DOCKER)).toEqual({
      step,
      action: "skip",
      reason: "Windows only — on this host it would run 0 tests and print a pass",
    });
  });

  it("on a Windows host, SKIPS the Docker cross-compile by name — with the reason — and runs the rest", () => {
    const plan = planSteps({ groups: GROUPS, platform: "win32", docker: DOCKER });
    expect(byAction(plan, "skip")).toEqual([MCP, SHIM, MAC_LOG, NETTOP, TASKS, WINCHECK]);
    expect(flat(plan).find((e) => e.step.name === WINCHECK).reason).toBe(WINDOWS_HOST_CHECK_SKIP);
    expect(WINDOWS_HOST_CHECK_SKIP).toContain("the native cargo clippy --all-targets and cargo test steps are the Windows check");
    expect(byAction(plan, "run")).toEqual(everyStep.filter((n) => ![...GATED_OFF.win32, WINCHECK].includes(n)));
    // The native cargo steps it relies on are in the same plan, running — and the Windows-only
    // local-integration steps with them.
    expect(byAction(plan, "run")).toEqual(
      expect.arrayContaining(["cargo clippy", "cargo test", WIN_PS, WIN_LOG, WIN_SMOKE, "real curl through the capture proxy"]),
    );
  });

  it("the real-claude MCP install check is blocking local integration on macOS and Linux, runs only that test, and is a named SKIP on Windows", () => {
    const step = GROUPS.find((g) => g.name === "local integration").steps.find((s) => s.name === MCP);
    expect(step).toMatchObject({
      cmd: "cargo",
      args: [
        "test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "agent_mcp", "--",
        "--ignored", "--exact", "real_claude_adds_checks_and_removes_the_server_in_a_throwaway_config",
      ],
    });
    expect(step.blocking).not.toBe(false);
    expect(step.needsDocker).toBeFalsy();
    for (const platform of ["darwin", "linux"]) {
      expect(byAction(planSteps({ groups: GROUPS, platform, docker: NO_DOCKER }), "run")).toContain(MCP);
    }
    // On Windows the install would read verify's own stdin, which is no console when a program
    // runs verify: it would refuse, and the blocking step would fail every time.
    const onWindows = flat(planSteps({ groups: GROUPS, platform: "win32", docker: NO_DOCKER })).find(
      (e) => e.step.name === MCP,
    );
    expect(onWindows.action).toBe("skip");
    expect(onWindows.reason).toBe(
      "macOS/Linux only (cfg(unix)): the test types `agent-studio mcp install` into a pty of its own, and " +
        "moves HOME to keep Claude Code's config untouched; Windows has neither here — on this host it would " +
        "run 0 tests and print a pass",
    );
    expect(classify([fail(MCP)]).ok).toBe(false);
  });

  it("the Windows real-app smoke builds its own exe, is blocking local integration, and needs no Docker", () => {
    const smoke = GROUPS.find((g) => g.name === "local integration").steps.find((s) => s.name === WIN_SMOKE);
    expect(smoke).toMatchObject({ cmd: "node", args: ["scripts/windows-smoke.mjs", "--build"] });
    expect(smoke.blocking).not.toBe(false);
    expect(smoke.needsDocker).toBeFalsy();
    const ps = GROUPS.flatMap((g) => g.steps).find((s) => s.name === WIN_PS);
    expect(ps.args.slice(-4)).toEqual(["--", "--ignored", "--exact", "on_windows_a_powershell_terminal_is_captured"]);
    expect(ps.args).toEqual(expect.arrayContaining(["--test", "netcap_e2e"]));
  });

  it("🔴 without Docker, every Docker step FAILS with the reason — it is never skipped", () => {
    // The class semantics: a missing tool must not turn a blocking gate green.
    const plan = planSteps({ groups: GROUPS, platform: "win32", docker: NO_DOCKER });
    expect(byAction(plan, "fail")).toEqual([DB, E2E, E2E_EXT, LINUX_INSTALL]);
    for (const e of flat(plan).filter((x) => x.action === "fail")) {
      expect(e.reason).toBe(
        "Docker is not available on this machine — the `docker` command is not installed (not found on PATH)",
      );
    }
    // The redundant step is still a SKIP, not a Docker failure: it would not run even with Docker.
    expect(byAction(plan, "skip")).toEqual([MCP, SHIM, MAC_LOG, NETTOP, TASKS, WINCHECK]);
    // Everything that does not need Docker still runs.
    expect(byAction(plan, "run")).toEqual(
      everyStep.filter((n) => ![DB, WINCHECK, E2E, E2E_EXT, LINUX_INSTALL, ...GATED_OFF.win32].includes(n)),
    );
  });

  it("without Docker on a Mac, the cross-compile FAILS too — it is only redundant on Windows", () => {
    const plan = planSteps({ groups: GROUPS, platform: "darwin", docker: NO_DOCKER });
    expect(byAction(plan, "fail")).toEqual([DB, WINCHECK, E2E, E2E_EXT, LINUX_INSTALL]);
    expect(byAction(plan, "skip")).toEqual(GATED_OFF.darwin);
  });

  it("the overall verdict without Docker is FAIL, naming the blocking Docker steps; the external one is reported", () => {
    const plan = planSteps({ groups: GROUPS, platform: "win32", docker: NO_DOCKER });
    const results = flat(plan).map(({ step, action }) => ({
      name: step.name,
      ok: action !== "fail",
      skipped: action === "skip",
      ms: 0,
      blocking: step.blocking !== false,
    }));
    const v = classify(results);
    expect(v.ok).toBe(false);
    expect(v.failedBlocking).toEqual([DB, E2E]);
    expect(v.failedExternal).toEqual([E2E_EXT, LINUX_INSTALL]);
    expect(v.skipped).toEqual([MCP, SHIM, MAC_LOG, NETTOP, TASKS, WINCHECK]);
  });

  it("--no-docker leaves out ONLY the database-fixture step, as before; the other Docker steps stay", () => {
    const plan = planSteps({ groups: GROUPS, platform: "darwin", docker: DOCKER, skipDocker: true });
    expect(byAction(plan, "run")).toEqual(everyStep.filter((n) => n !== DB && !GATED_OFF.darwin.includes(n)));
  });

  it("--no-network leaves out the external group, as before", () => {
    const plan = planSteps({ groups: GROUPS, platform: "darwin", docker: DOCKER, skipExternal: true });
    expect(plan.map((g) => g.group)).toEqual(["hermetic", "local integration"]);
  });

  it("decideStep: a host skip outranks a Docker failure, and a step with neither runs", () => {
    const step = { name: "x", needsDocker: true, skipOn: { win32: "redundant here" } };
    expect(decideStep(step, "win32", NO_DOCKER)).toEqual({ step, action: "skip", reason: "redundant here" });
    expect(decideStep(step, "linux", NO_DOCKER).action).toBe("fail");
    expect(decideStep(step, "linux", DOCKER)).toEqual({ step, action: "run", reason: null });
    const plain = { name: "typecheck" };
    expect(decideStep(plain, "win32", NO_DOCKER)).toEqual({ step: plain, action: "run", reason: null });
  });
});

describe("windows-smoke-config — the smoke exe and the app data it may touch", () => {
  // Not `new URL(rel, import.meta.url)`: under vitest's jsdom the global URL resolves against
  // http://localhost:3000.
  const confPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.conf.json");
  const REAL_CONF = JSON.parse(readFileSync(confPath, "utf8"));

  it("overrides the identifier, rebuilds the frontend, and keeps the WHOLE main window + a debugging port", () => {
    const cfg = smokeTauriConfig(REAL_CONF);
    expect(cfg.identifier).toBe("com.agentstudio.app.smoke");
    expect(cfg.identifier).not.toBe(REAL_CONF.identifier);
    expect(cfg.build).toEqual({ beforeBuildCommand: "npm run build" });
    // A --config override is a JSON merge patch: arrays are REPLACED, so every field of the real
    // window must be carried (dragDropEnabled: false is load-bearing on Windows).
    expect(cfg.app.windows).toEqual([
      {
        ...REAL_CONF.app.windows[0],
        additionalBrowserArgs:
          "--remote-debugging-port=9333 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
      },
    ]);
    expect(cfg.app.windows[0].dragDropEnabled).toBe(false);
    expect(Object.keys(cfg)).toEqual(["identifier", "build", "app"]);
    expect(smokeTauriConfig(REAL_CONF, { port: 9444 }).app.windows[0].additionalBrowserArgs).toContain(
      "--remote-debugging-port=9444 ",
    );
    expect(() => smokeTauriConfig({ app: {} })).toThrow("tauri.conf.json has no app.windows[0]");
  });

  it("builds with node + the Tauri CLI script, never npx (a .cmd would push the temp path through cmd.exe)", () => {
    const repo = path.join("C:", "repo");
    const cfgPath = path.join("C:", "Users", "A B", "AppData", "Local", "Temp", "x", "tauri-smoke.json");
    const args = tauriBuildArgs(repo, cfgPath);
    expect(args).toEqual([
      path.join(repo, "node_modules", "@tauri-apps", "cli", "tauri.js"),
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      cfgPath,
    ]);
    // The same path through the npx route is refused by the cmd.exe guard — which is why.
    expect(() => spawnSpec("npx", ["tauri", "build", "--config", cfgPath], "win32")).toThrow("refusing to run `npx`");
  });

  it("finds the built exe in the target dir, honouring CARGO_TARGET_DIR", () => {
    const repo = path.join("C:", "repo");
    expect(builtExePath(repo)).toBe(path.join(repo, "src-tauri", "target", "debug", "agent-studio-scaffold.exe"));
    expect(builtExePath(repo, { targetDir: path.join("D:", "t") })).toBe(
      path.join(path.resolve(repo, path.join("D:", "t")), "debug", "agent-studio-scaffold.exe"),
    );
  });

  it("is hermetic only for a smoke identifier — the real app's data is never wiped", () => {
    expect(isHermetic(SMOKE_IDENTIFIER)).toBe(true);
    expect(isHermetic(REAL_IDENTIFIER)).toBe(false);
    expect(isHermetic("com.other.app")).toBe(false);
    expect(appDataDirs(SMOKE_IDENTIFIER, { APPDATA: "C:\\U\\AppData\\Roaming", LOCALAPPDATA: "C:\\U\\AppData\\Local" })).toEqual({
      config: "C:\\U\\AppData\\Roaming\\com.agentstudio.app.smoke",
      webview: "C:\\U\\AppData\\Local\\com.agentstudio.app.smoke",
    });
    expect(appDataDirs(REAL_IDENTIFIER, {}, "C:\\Users\\me").config).toBe("C:\\Users\\me\\AppData\\Roaming\\com.agentstudio.app");
  });
});

describe("parseFixtureStates — docker compose ps, on any OS's line endings", () => {
  it("reads LF output", () => {
    expect(parseFixtureStates("postgres\thealthy\nmysql\tstarting\n")).toEqual({ postgres: "healthy", mysql: "starting" });
  });

  it("reads CRLF output without leaving a \\r on the health — `healthy\\r` would block the tier", () => {
    const states = parseFixtureStates("postgres\thealthy\r\nmysql\thealthy\r\n");
    expect(states).toEqual({ postgres: "healthy", mysql: "healthy" });
    expect(fixtureVerdict(states, ["postgres", "mysql"]).usable).toBe(true);
  });

  it("treats a service with no healthcheck as an empty health string, and empty output as nothing running", () => {
    expect(parseFixtureStates("redis\t\npostgres\thealthy")).toEqual({ redis: "", postgres: "healthy" });
    expect(parseFixtureStates("")).toEqual({});
  });
});

describe("fixtureVerdict — which fixture containers may block the database tier", () => {
  const ALL = ["postgres", "mysql", "clickhouse", "mongo", "redis", "dynamodb"];
  const allHealthy = Object.fromEntries(ALL.map((n) => [n, "healthy"]));

  it("is usable when every container is healthy, with nothing to report", () => {
    const v = fixtureVerdict(allHealthy);
    expect(v.usable).toBe(true);
    expect(v.blocking).toEqual([]);
    expect(v.reported).toEqual([]);
  });

  it("🔴 stays usable when an engine NO TEST USES is unhealthy — it only gets reported", () => {
    // NB: this case has run out of real examples, and that is the interesting part. ClickHouse was
    // the original, then Mongo, then Redis, then DynamoDB — **now every container in
    // `docker/db-fixtures` has a driver and is required**, so there is no unwired engine left to
    // point at. The behaviour is still worth pinning (the next engine added to compose will land in
    // exactly this state before its driver does), so the name is deliberately hypothetical.
    //
    // The bug this case exists for: ClickHouse drifted past its own memory cap, went unhealthy, and
    // `verify` refused to run the entire database tier — so the only tests that prove the database
    // client works were skipped because of an engine with no driver. A gate that fails for reasons
    // unrelated to the code is a gate people bypass.
    const v = fixtureVerdict({ ...allHealthy, "some-future-engine": "unhealthy" });
    expect(v.usable).toBe(true);
    expect(v.blocking).toEqual([]);
    expect(v.reported).toEqual(["some-future-engine"]);
  });

  it("is NOT usable when a WIRED engine is unhealthy — those really are the product", () => {
    // All SIX fixture engines have drivers (Redis, then DynamoDB were the last), so all block. The list in `verify.mjs` has to grow with the drivers, and this is the assertion that
    // notices: adding an engine to `engine_for` without adding it here would leave its live tests
    // silently skippable.
    for (const engine of ["postgres", "mysql", "clickhouse", "mongo", "redis", "dynamodb"]) {
      const v = fixtureVerdict({ ...allHealthy, [engine]: "unhealthy" });
      expect(v.usable).toBe(false);
      expect(v.blocking).toEqual([engine]);
    }
  });

  it("treats a still-starting required engine as not usable, not as healthy", () => {
    // `starting` is the state during first boot. Running the tier against it produces
    // connection refusals that read like product failures.
    expect(fixtureVerdict({ ...allHealthy, postgres: "starting" }).usable).toBe(false);
  });

  it("is NOT usable when nothing is running at all", () => {
    // An empty listing must not read as "all required engines are fine" — the fixture has
    // to be started, and `every()` over an empty list would have said yes.
    const v = fixtureVerdict({});
    expect(v.usable).toBe(false);
    expect(v.blocking).toEqual(["postgres", "mysql", "clickhouse", "mongo", "redis", "dynamodb"]);
  });

  it("names a required engine that is missing from the listing entirely", () => {
    const v = fixtureVerdict({ mysql: "healthy" });
    expect(v.blocking).toEqual(["postgres", "clickhouse", "mongo", "redis", "dynamodb"]);
    // A container absent from the listing is not "unhealthy other" — it is the required
    // engine failing to exist, and conflating the two would hide it in a yellow note.
    expect(v.reported).toEqual([]);
  });

  it("grows with the drivers: a listed engine blocks once it is required", () => {
    // The contract for the NEXT engine, whatever it turns out to be. ClickHouse, Mongo, Redis and
    // DynamoDB each made this transition in turn — out of the "reported" case above and into the
    // required list — and all four have landed, so the name here is hypothetical on purpose.
    // Adding a driver without adding it to `TIER_ENGINES` leaves its live tests silently skippable,
    // and this is the assertion that notices.
    const v = fixtureVerdict({ ...allHealthy, "some-future-engine": "unhealthy" }, [
      "postgres",
      "some-future-engine",
    ]);
    expect(v.usable).toBe(false);
    expect(v.blocking).toEqual(["some-future-engine"]);
    expect(v.reported).toEqual([]);
  });
});
