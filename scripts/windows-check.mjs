#!/usr/bin/env node
/** Cross-compiles and lints the Rust core for Windows (GNU ABI) in Docker; extra args go to
 * `cargo`. It runs and links nothing and skips `target_env = "msvc"` code. WINDOWS_TARGET_VOLUME:
 * own target volume per parallel run; WINDOWS_JOBS: rustc cap (8). */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WINDOWS_HOST_CHECK_SKIP } from "./platform.mjs";

// On a Windows host this cross-compile is redundant: the native `cargo clippy --all-targets` and
// `cargo test` compile, lint AND run the cfg(windows) code. Said out loud, with exit 0 — `verify`
// reports the same line as SKIP, never a PASS.
if (process.platform === "win32") {
  console.log(`windows-check: skipped — ${WINDOWS_HOST_CHECK_SKIP}.`);
  process.exit(0);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = "agent-studio-windows-check";
const target = "x86_64-pc-windows-gnu";
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error?.code === "ENOENT" && cmd === "docker") {
    console.error("windows-check: FAILED — Docker is not available on this machine (`docker` is not on PATH).");
  } else if (r.error) {
    console.error(`windows-check: could not run ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("docker", ["build", "-q", "-t", image, path.join(repo, "docker/windows-check")]);
const cargo = process.argv.slice(2);
const steps = cargo.length
  ? [cargo]
  : [
      ["clippy", "--manifest-path", "src-tauri/Cargo.toml", "--target", target, "--all-targets", "--", "-D", "warnings"],
    ];
// A release-shaped build embeds ../dist and panics at compile time without it, so a fresh clone
// points Tauri at the image's empty placeholder rather than creating a dir in the repo.
const dist = existsSync(path.join(repo, "dist"))
  ? []
  : ["-e", `TAURI_CONFIG=${JSON.stringify({ build: { frontendDist: "/opt/empty-dist" } })}`];
for (const step of steps) {
  run("docker", [
    "run", "--rm",
    "-v", `${repo}:/repo`,
    "-v", `${process.env.WINDOWS_TARGET_VOLUME ?? "agent-studio-windows-target"}:/target`,
    // Its own registry volume rather than the Linux check's: the two gates are meant to run
    // side by side, and a shared registry would serialise them on cargo's package-cache lock.
    "-v", "agent-studio-windows-cargo:/root/.cargo/registry",
    "-e", "CARGO_TARGET_DIR=/target",
    // The default step passes `--target` explicitly; this makes pass-through commands
    // (`check`, `clippy --keep-going`) target Windows too, instead of silently checking Linux.
    "-e", `CARGO_BUILD_TARGET=${target}`,
    // No debuginfo: nothing built here is ever debugged or run, and it keeps `-g` out of the
    // vendored C (libgit2, ring, zlib), so the target volume stays small. Lints are unaffected.
    "-e", "CARGO_PROFILE_DEV_DEBUG=0",
    "-e", "CARGO_PROFILE_TEST_DEBUG=0",
    // clippy never links, so the Linux check's GNU-ld OOM cap doesn't apply. 8 keeps the memory
    // peak inside a small Docker VM; 16 saved only seconds cold.
    "-e", `CARGO_BUILD_JOBS=${process.env.WINDOWS_JOBS ?? "8"}`,
    ...dist,
    image, "cargo", ...step,
  ]);
}
if (!cargo.length) {
  console.log(
    `windows-check: green — the Rust core compiles and passes clippy for ${target}. ` +
      "Nothing was executed: no test ran and no app was linked.",
  );
}
