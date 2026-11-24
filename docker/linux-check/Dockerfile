# Ubuntu verification image (the app is built for Windows and Ubuntu too).
# Runs `cargo check/clippy/test` for the Rust core on real Linux — so cfg(target_os = "linux")
# code is compiled and its tests executed, not merely written. Used by scripts/linux-check.mjs.
# Same system packages as .github/workflows/build.yml's ubuntu job.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
      libayatana-appindicator3-dev librsvg2-dev pkg-config ca-certificates iproute2 procps git \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.97.1 \
      --component clippy,rustfmt
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /repo
