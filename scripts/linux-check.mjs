#!/usr/bin/env node
/** Compile, lint and test the Rust core on Linux in Docker; extra args go to `cargo`.
 * LINUX_TARGET_VOLUME=<name> gives a parallel run its own target volume (one cargo lock each). */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = "agent-studio-linux-check";
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  // Without Docker this used to exit 1 with no output at all.
  if (r.error?.code === "ENOENT" && cmd === "docker") {
    console.error("linux-check: FAILED — Docker is not available on this machine (`docker` is not on PATH).");
  } else if (r.error) {
    console.error(`linux-check: could not run ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("docker", ["build", "-q", "-t", image, path.join(repo, "docker/linux-check")]);
const cargo = process.argv.slice(2);
const steps = cargo.length
  ? [cargo]
  : [
      ["clippy", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--", "-D", "warnings"],
      ["test", "--manifest-path", "src-tauri/Cargo.toml"],
    ];
for (const step of steps) {
  run("docker", [
    "run", "--rm",
    "-v", `${repo}:/repo`,
    "-v", `${process.env.LINUX_TARGET_VOLUME ?? "agent-studio-linux-target"}:/target`,
    "-v", "agent-studio-linux-cargo:/root/.cargo/registry",
    "-e", "CARGO_TARGET_DIR=/target",
    // Without these, GNU ld was OOM-killed (signal 9) linking five debug test binaries at
    // once inside Docker's VM. No debuginfo shrinks each link ~5x; the job cap
    // bounds how many run together. Compile errors and test results are unaffected.
    "-e", "CARGO_PROFILE_DEV_DEBUG=0",
    "-e", "CARGO_PROFILE_TEST_DEBUG=0",
    "-e", `CARGO_BUILD_JOBS=${process.env.LINUX_JOBS ?? "2"}`,
    image, "cargo", ...step,
  ]);
}
