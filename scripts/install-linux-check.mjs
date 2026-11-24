#!/usr/bin/env node
/**
 * The one-command Linux installer (scripts/install-linux.sh), run for real in Docker.
 *
 * Why: the installer is only ever run as `curl … | bash` on someone else's machine, so a mistake
 * in it is found by a user. Each case pipes the script into bash exactly that way (stdin IS the
 * script, so a command that reads stdin would swallow the rest of it), installs the LATEST
 * published release and checks the result. Each case runs the installer twice, because a second
 * run must reinstall the same-version build rather than stop at "already the newest version".
 *
 *   node scripts/install-linux-check.mjs
 *
 * Cases (all linux/amd64, the only Linux arch that is published):
 *   - shellcheck on both installers
 *   - Ubuntu 24.04, a user with sudo      -> the .deb through apt-get
 *   - Fedora 41, root (dnf5)              -> the .rpm through dnf
 *   - Ubuntu 24.04, a user without sudo   -> the AppImage into ~/.local/bin, with a menu entry
 *
 * Nothing is launched: there is no display in a container, and the installer says so instead.
 * Needs Docker and the network (GitHub and the distributions' mirrors).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const SHELLCHECK = "koalaman/shellcheck:v0.10.0";

// Run as `bash -c`; a non-zero exit is the failure. `install` pipes the mounted script into bash.
const install = "cat /src/install-linux.sh | bash";
const installAs = (user) => `su - ${user} -c '${install}'`;
const expectInstalled = (out) => `grep -q 'Agent Studio is installed: ${out}' "$log"`;

const CASES = [
  {
    name: "Ubuntu 24.04: the .deb through apt-get, as a user with sudo",
    image: "ubuntu:24.04",
    script: `
      apt-get update -q >/dev/null && apt-get install -y -q curl ca-certificates sudo >/dev/null
      useradd -m dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev
      log=/tmp/first.log; ${installAs("dev")} 2>&1 | tee "$log"
      ${expectInstalled("/usr/bin/agent-studio-scaffold")}
      grep -q 'start it later with: agent-studio-scaffold' "$log"
      dpkg -s agent-studio | grep -q '^Status: install ok installed'
      log=/tmp/second.log; ${installAs("dev")} 2>&1 | tee "$log"
      ${expectInstalled("/usr/bin/agent-studio-scaffold")}
      grep -Eq 'Unpacking agent-studio \\(([^)]+)\\) over \\(\\1\\)' "$log"
    `,
  },
  {
    name: "Fedora 41: the .rpm through dnf, as root",
    image: "fedora:41",
    script: `
      log=/tmp/first.log; ${install} 2>&1 | tee "$log"
      ${expectInstalled("/usr/bin/agent-studio-scaffold")}
      grep -q 'Start it as your own user' "$log"
      rpm -q agent-studio
      log=/tmp/second.log; ${install} 2>&1 | tee "$log"
      ${expectInstalled("/usr/bin/agent-studio-scaffold")}
      grep -qi 'reinstall' "$log"
    `,
  },
  {
    name: "Ubuntu 24.04: the AppImage into ~/.local/bin, as a user without sudo",
    image: "ubuntu:24.04",
    script: `
      apt-get update -q >/dev/null && apt-get install -y -q curl ca-certificates >/dev/null
      useradd -m dev
      for log in /tmp/first.log /tmp/second.log; do
        ${installAs("dev")} 2>&1 | tee "$log"
        ${expectInstalled("/home/dev/.local/bin/agent-studio-scaffold")}
      done
      grep -q 'sudo is not available' "$log"
      grep -q 'needs FUSE to start' "$log"
      # The first run, before ~/.local/bin existed, could not be on PATH: it names the full path.
      grep -q 'start it later with: /home/dev/.local/bin/agent-studio-scaffold' /tmp/first.log
      test -x /home/dev/.local/bin/agent-studio-scaffold
      grep -q '^Exec="/home/dev/.local/bin/agent-studio-scaffold"$' \\
        /home/dev/.local/share/applications/agent-studio-scaffold.desktop
      test -s /home/dev/.local/share/icons/hicolor/256x256/apps/agent-studio-scaffold.png
      test "$(stat -c %U /home/dev/.local/bin/agent-studio-scaffold)" = dev
      # AGENT_STUDIO_PKG installs a local file and downloads nothing.
      cp /home/dev/.local/bin/agent-studio-scaffold /tmp/local.AppImage && chmod 644 /tmp/local.AppImage
      log=/tmp/local.log
      su - dev -c 'cat /src/install-linux.sh | AGENT_STUDIO_PKG=/tmp/local.AppImage bash' 2>&1 | tee "$log"
      ${expectInstalled("/home/dev/.local/bin/agent-studio-scaffold")}
      ! grep -q Downloading "$log"
    `,
  },
];

function docker(args) {
  const r = spawnSync("docker", args, { stdio: "inherit" });
  if (r.error?.code === "ENOENT") {
    console.error("install-linux-check: FAILED — Docker is not available (`docker` is not on PATH).");
    process.exit(1);
  }
  return r.status === 0;
}

const results = [];
console.log("\n── shellcheck: install-linux.sh, install-macos.sh");
results.push({
  name: "shellcheck",
  ok: docker([
    "run", "--rm", "-v", `${scripts}:/mnt:ro`, "-w", "/mnt", SHELLCHECK,
    "install-linux.sh", "install-macos.sh",
  ]),
});
for (const c of CASES) {
  console.log(`\n── ${c.name}`);
  results.push({
    name: c.name,
    ok: docker([
      "run", "--rm", "--platform", "linux/amd64", "-v", `${scripts}:/src:ro`, c.image,
      "bash", "-c", `set -euo pipefail\n${c.script}`,
    ]),
  });
}

console.log("\n── install-linux-check");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
