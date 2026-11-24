#!/usr/bin/env node
/**
 * WebDriver E2E on real Ubuntu, in Docker — the local way to run e2e/ (verify the real thing
 * in the running app).
 *
 * Why Docker: `tauri-driver` cannot drive a WKWebView, so the WebDriver suite can never run
 * on the macOS dev host, and the gate runs locally, not in CI. The image
 * (docker/linux-check/Dockerfile.e2e) carries the Tauri build deps, WebKitWebDriver, xvfb,
 * Node 22 and tauri-driver — dev-image dependencies, never a user install.
 *
 *   node scripts/e2e-linux.mjs              # the Agent logs + Network specs
 *   node scripts/e2e-linux.mjs --all        # every LOCAL spec in e2e/specs (no public internet)
 *   node scripts/e2e-linux.mjs --external   # only the specs that reach the public internet
 *                                           # (EXTERNAL_SPECS: example.com) — verify reports
 *                                           # them without blocking on a third party's outage
 *   node scripts/e2e-linux.mjs e2e/specs/boot.e2e.ts [...]   # just these
 *   node scripts/e2e-linux.mjs --record [...]  # + VIDEO: an mp4 + GIF of the whole virtual display per
 *                                           # spec, and whole-display PNG stills at each spec's named
 *                                           # moments, in E2E_ARTIFACTS/media (also: E2E_RECORD=1).
 *                                           # Opt-in; off, the run is exactly the plain one.
 *
 * The build happens inside the container: wdio's onPrepare runs `tauri build --debug
 * --no-bundle` (the `npm run e2e:build` equivalent) and fails loudly if the binary is missing.
 *
 * Host isolation — the repo is bind-mounted, so everything the container writes that the
 * host also owns is shadowed by a named volume instead:
 *   src-tauri/target → agent-studio-linux-e2e        (Linux build, never the host's target)
 *   node_modules     → agent-studio-linux-e2e-node   (Linux-native deps, never the host's)
 *   dist             → agent-studio-linux-e2e-dist   (the frontend bundle the build writes)
 * The only repo write is wdio.conf's throwaway fixture repo (e2e/fixtures/workspace/.git,
 * git-ignored). Failure screenshots land in E2E_ARTIFACTS (default: <tmpdir>/agent-studio-e2e).
 *
 * Nothing leaves the container during the local specs: the servers, the IDE's proxy and curl
 * are all inside it. Only EXTERNAL_SPECS reach out, and only to https://example.com/. (Building the image and `npm ci` do download, as any build does.)
 * BLOCKED_HOSTS resolve to 127.0.0.1 inside the container, so an app feature that would call out on
 * its own fails fast instead: the village-city spec runs its app in Asia/Tokyo (e2e/support/app-zone.ts),
 * and the Village's live weather would otherwise send Tokyo's coordinates to Open-Meteo (weather.rs).
 * The list is passed in as E2E_BLOCKED_HOSTS, and that spec asserts the block held.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = "agent-studio-linux-e2e";
const artifacts = process.env.E2E_ARTIFACTS ?? path.join(os.tmpdir(), "agent-studio-e2e");
mkdirSync(artifacts, { recursive: true });

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  // Without Docker this used to exit 1 with no output at all.
  if (r.error?.code === "ENOENT" && cmd === "docker") {
    console.error("[e2e-linux] FAILED — Docker is not available on this machine (`docker` is not on PATH).");
  } else if (r.error) {
    console.error(`[e2e-linux] could not run ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Hosts the app must never reach from the E2E container (see the header): each is mapped to 127.0.0.1. */
// api.openai.com: the network spec's "Hide AI providers" check calls a provider host, and it must land
// on the spec's own loopback server, never on OpenAI.
const BLOCKED_HOSTS = ["api.open-meteo.com", "api.openai.com"];

/** Specs that touch the public internet — never in `--all` (a third party's outage is not ours). */
const EXTERNAL_SPECS = ["e2e/specs/real-service-external.e2e.ts", "e2e/specs/gazelle-like-external.e2e.ts"];

const argv = process.argv.slice(2);
// --record (or E2E_RECORD=1): ffmpeg x11grab of the xvfb screen + openbox, so a second OS window
// is placed beside the main one and has a title bar (e2e/support/record.ts). Never needed by verify.
const record = argv.includes("--record") || process.env.E2E_RECORD === "1";
// The xvfb screen — one constant for xvfb, ffmpeg and the stills, so they always agree.
const SCREEN = "1440x900";
const named = argv.filter((a) => !a.startsWith("--"));
const localSpecs = () =>
  readdirSync(path.join(repo, "e2e/specs"))
    .filter((f) => f.endsWith(".e2e.ts"))
    .map((f) => `e2e/specs/${f}`)
    .filter((s) => !EXTERNAL_SPECS.includes(s))
    .sort();
const specs = [
  ...(argv.includes("--all") ? localSpecs() : []),
  ...(argv.includes("--external") ? EXTERNAL_SPECS : []),
  ...named,
];
if (specs.length === 0) specs.push("e2e/specs/agent-logs.e2e.ts", "e2e/specs/network.e2e.ts");
const buildGazelle = specs.some((s) => s.includes("gazelle-like"));
const specArgs = specs.flatMap((s) => ["--spec", s]).map((a) => `'${a}'`).join(" ");

run("docker", [
  "build", "-q", "-t", image,
  "-f", path.join(repo, "docker/linux-check/Dockerfile.e2e"),
  path.join(repo, "docker/linux-check"),
]);

// npm ci only when package-lock.json changed since the volume was last filled.
const inner = `set -euo pipefail
lock_sha=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat node_modules/.e2e-lock-sha 2>/dev/null)" != "$lock_sha" ]; then
  echo "[e2e-linux] npm ci (package-lock changed or first run)"
  npm ci --no-audit --no-fund
  echo "$lock_sha" > node_modules/.e2e-lock-sha
fi
echo "[e2e-linux] specs: ${specs.join(" ")}"
# The gazelle-like scenario (e2e/fixtures/gazelle-like, docs/design/testing-strategy.md): a real Rust
# server, built here into the E2E target volume (never the host's target, never the repo tree), with
# no debuginfo (CARGO_PROFILE_DEV_DEBUG=0 below + the fixture's own profile).
if [ "${buildGazelle ? 1 : 0}" = 1 ]; then
  echo "[e2e-linux] building the gazelle-like fixture"
  CARGO_TARGET_DIR=/repo/src-tauri/target/fixtures cargo build --locked --manifest-path e2e/fixtures/gazelle-like/Cargo.toml
fi
# A hang is a failure: hard wall-clock cap (the first, cold Rust build dominates it).
# Recording: a tiny window manager inside the same display, started before the app (openbox places a
# new window beside the main one and draws title bars — only for the video; the plain run has none).
exec timeout --kill-after=30 "$E2E_TIMEOUT_S" xvfb-run -a -s "-screen 0 ${SCREEN}x24" ${
  record
    ? `bash -c '(openbox >/dev/null 2>&1 &) && sleep 1 && exec npx wdio run e2e/wdio.conf.ts ${specArgs.replace(/'/g, "")}'`
    : `npx wdio run e2e/wdio.conf.ts ${specArgs}`
}`;

const started = Date.now();
const r = spawnSync("docker", [
  "run", "--rm", "--init", "--shm-size=1g",
  "-v", `${repo}:/repo`,
  "-v", "agent-studio-linux-e2e:/repo/src-tauri/target",
  "-v", "agent-studio-linux-e2e-node:/repo/node_modules",
  "-v", "agent-studio-linux-e2e-dist:/repo/dist",
  "-v", "agent-studio-linux-cargo:/root/.cargo/registry",
  "-v", `${artifacts}:/artifacts`,
  ...BLOCKED_HOSTS.flatMap((h) => ["--add-host", `${h}:127.0.0.1`]),
  "-e", `E2E_BLOCKED_HOSTS=${BLOCKED_HOSTS.join(",")}`,
  "-e", "E2E_SCREENSHOT_DIR=/artifacts",
  // Where the gazelle-like fixture binary lands (the build step above); the spec runs it.
  "-e", "GAZELLE_LIKE_BIN=/repo/src-tauri/target/fixtures/debug/gazelle-like",
  "-e", `E2E_CHECKPOINTS=${process.env.E2E_CHECKPOINTS ?? "0"}`,
  "-e", `E2E_RECORD=${record ? "1" : "0"}`,
  "-e", `E2E_SCREEN=${SCREEN}`,
  "-e", `E2E_EXTERNAL=${specs.some((s) => EXTERNAL_SPECS.includes(s)) ? "1" : "0"}`,
  "-e", `E2E_TIMEOUT_S=${process.env.E2E_TIMEOUT_S ?? "3600"}`,
  // Same caps as scripts/linux-check.mjs: GNU ld was OOM-killed linking debug binaries in
  // Docker's VM without them. No debuginfo shrinks each link ~5x.
  "-e", "CARGO_PROFILE_DEV_DEBUG=0",
  "-e", `CARGO_BUILD_JOBS=${process.env.LINUX_JOBS ?? "6"}`,
  // WebKitGTK under xvfb has no GPU: software GL, no DMA-BUF renderer, no compositing.
  "-e", "LIBGL_ALWAYS_SOFTWARE=1",
  "-e", "WEBKIT_DISABLE_DMABUF_RENDERER=1",
  "-e", "WEBKIT_DISABLE_COMPOSITING_MODE=1",
  image, "bash", "-c", inner,
], { stdio: "inherit" });
const secs = Math.round((Date.now() - started) / 1000);
console.log(`[e2e-linux] ${r.status === 0 ? "PASS" : "FAIL"} in ${secs}s (artifacts: ${artifacts}${record ? `, video + stills: ${path.join(artifacts, "media")}` : ""})`);
process.exit(r.status ?? 1);
