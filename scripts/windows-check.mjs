#!/usr/bin/env node
/**
 * Windows check — compile and lint the Rust core FOR Windows, in Docker, from a Mac.
 *
 * Why: the app ships for macOS, Ubuntu and Windows, and `cfg(windows)` code written on a Mac
 * is otherwise never compiled on that machine — the first compiler to see it is the release
 * build, after the merge, and its test targets are never compiled at all. Windows-only bugs
 * would then reach an installed build. This is the Windows twin of
 * scripts/linux-check.mjs, with one honest difference: Linux can be *run* in Docker, Windows
 * cannot (no KVM on Apple Silicon, so no Windows VM). So this cross-compiles instead: a Linux
 * container with the `x86_64-pc-windows-gnu` Rust target and the mingw-w64 C toolchain.
 *
 * What a green run PROVES:
 *   - Every `cfg(windows)` / `cfg(not(unix))` item in the crate and in every test target
 *     type-checks, borrow-checks and passes clippy with `-D warnings` for Windows — the same
 *     bar as the macOS and Linux gates. A wrong signature, a missing import, a unix-only API
 *     on the Windows path, a helper that is dead code only on Windows: all caught here.
 *   - The vendored `portable-pty` (the `[patch.crates-io]` fork) and every dependency compile
 *     for Windows, including their build scripts: the vendored C (ring, libgit2, zlib) builds
 *     with mingw gcc and Tauri's icon/manifest resource script goes through `windres`.
 *
 * What it does NOT prove — read this before trusting a green:
 *   - It RUNS nothing. No test executes, so a Windows-only test that compiles and would fail
 *     is still green. `cargo test`/`cargo run` cannot work in this image: nothing in it can
 *     execute a .exe.
 *   - Nothing is linked into a runnable app. clippy stops after type-checking (the target dir
 *     holds .rmeta files, no .exe), so an unresolved symbol or a missing import library only
 *     surfaces in the real build (the `windows-latest` job of .github/workflows/build.yml).
 *   - The target is the GNU ABI; the installer we ship is built for MSVC. `cfg(windows)` is
 *     identical on both, but anything gated on `target_env = "msvc"` is not compiled here.
 *   - Warnings inside `vendor/portable-pty` are printed but do not fail the run: `-D warnings`
 *     reaches the workspace package only, exactly as on the other two gates. Errors there do.
 *   - No runtime behaviour at all: ConPTY, path and quoting rules, the registry, WebView2.
 *
 *   node scripts/windows-check.mjs      # clippy --all-targets -D warnings, for Windows
 *   node scripts/windows-check.mjs clippy --manifest-path src-tauri/Cargo.toml --all-targets --keep-going -- -D warnings
 *                                       # extra args are passed to `cargo`. This one lists EVERY
 *                                       # finding: the default stops at the first failing target.
 *
 * WINDOWS_TARGET_VOLUME=<name> gives a parallel run its own target dir (one cargo lock each).
 * WINDOWS_JOBS=<n> overrides the parallel rustc cap (default 8).
 *
 * Volume discipline, same as the Linux check: the target dir is a named volume — never the
 * host's `src-tauri/target` (a different OS and a different target triple; sharing it would
 * thrash both caches) and never the repo tree. The only thing the container writes into the
 * bind-mounted repo is what the build itself emits on every platform: Tauri's generated
 * `src-tauri/gen/schemas/` (gitignored).
 */
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
// `generate_context!` embeds `frontendDist` (../dist) only in a release-shaped build
// (`--features tauri/custom-protocol`); the default dev-shaped check skips it because the
// config has a `devUrl`. A fresh clone or worktree has no `dist/`, and that release-shaped
// build then panics at compile time ("this path doesn't exist") — so point Tauri at the empty
// placeholder baked into the image instead of creating a directory in the repo. A real
// `dist/` is used as it is.
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
    // clippy never links the target, so the GNU-ld OOM that pins the Linux check to 2 jobs
    // does not apply; the cap only bounds how many rustc run at once. Cold, on a many-core
    // host, 16 jobs saved only a few seconds over 8 at a much higher memory peak; 8 keeps the
    // peak inside a small Docker VM, and a warm run takes about the same time either way.
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
