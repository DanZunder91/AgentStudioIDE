# Windows cross-check image (so cfg(windows) code is compiled and linted on a Mac before it
# ships).
# Cross-compiles the Rust core to x86_64-pc-windows-gnu so `cargo check/clippy` type-checks and
# lints every cfg(windows) item. Used by scripts/windows-check.mjs.
#
# It is a LINUX image that targets Windows — not a Windows machine. Nothing built here is ever
# run: Docker on an Apple-Silicon Mac has no KVM, so a real Windows VM is not available, and the
# MSVC route (xwin) needs a Microsoft licence acceptance this image does not make for you.
# Native arch on purpose (arm64 on an Apple-Silicon Mac): a forced linux/amd64 image would run rustc under
# emulation for no gain, since the *target* is what makes the code Windows code, not the host.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# Two toolchains, each needed by something specific:
#   * gcc + libc6-dev — the HOST linker. Build scripts and proc-macros are compiled and linked
#     for the container's own arch even in a cross build.
#   * mingw-w64 — the TARGET C toolchain. `ring`, `libgit2-sys` and `libz-sys` compile vendored C
#     with `x86_64-w64-mingw32-gcc` (the `cc` crate picks that name for this target by itself),
#     and `tauri-build` runs `x86_64-w64-mingw32-windres` (binutils) to compile the app's
#     icon/manifest resource — which in turn shells out to the mingw gcc as its preprocessor.
#     The `-posix` threading flavour is the one Rust's windows-gnu target is built against;
#     installing only that flavour makes it the unsuffixed `x86_64-w64-mingw32-gcc`.
# Deliberately absent: the WebKitGTK/GTK dev packages of the Linux image (those are the Linux
# target's system libraries; Windows uses WebView2 through pure-Rust bindings), and nasm, cmake,
# pkg-config and perl — no build script in this tree asks for them on this target (`ring` ships
# its Windows assembly pre-assembled). Add one only when a build script actually fails for it.
# `git` is absent too: build.rs stamps the commit SHA and degrades to an empty stamp without
# git, which is irrelevant to a lint — and no git means no rerun-on-every-commit trigger.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gcc libc6-dev \
      gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64 \
    && rm -rf /var/lib/apt/lists/*
# Same toolchain version as docker/linux-check/Dockerfile — bump the two together.
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.97.1 \
      --component clippy --target x86_64-pc-windows-gnu
ENV PATH=/root/.cargo/bin:$PATH
# Stand-in for the frontend bundle. `generate_context!` only reads `frontendDist` in a
# release-shaped build (`--features tauri/custom-protocol`); scripts/windows-check.mjs points
# Tauri here when the checkout has no `dist/`, so nothing has to be created in the repo tree.
RUN mkdir -p /opt/empty-dist
WORKDIR /repo
