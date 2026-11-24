/**
 * `.github/workflows/build.yml` — the two facts that keep release builds from filling the
 * account's Actions artifact storage (at 7 days for every build it filled, and every bundle upload
 * then failed), and the facts that keep a macOS build macOS refuses to open from being published
 * (an unsigned bundle is reported as "damaged", with no way to open it).
 *
 * Read as text: the repo has no YAML parser, and these are one-line facts. Literal expectations,
 * never read back from the file under test.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const yml = readFileSync(path.join(here, "../.github/workflows/build.yml"), "utf8");

/** The condition under which a run publishes a release. */
const RELEASE = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

/** The text of one top-level job (`  name:` … up to the next top-level job or the end). */
function job(name) {
  const start = yml.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job "${name}" in build.yml`);
  const next = yml.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
}

describe("build.yml — bundle retention", () => {
  it("the release job runs exactly when a push lands on main", () => {
    expect(job("release")).toContain(`    if: ${RELEASE}\n`);
  });

  it("the release job publishes from THIS run's bundles, so they are needed only for minutes", () => {
    expect(job("release")).toContain('gh run download "${{ github.run_id }}" --dir bundles');
  });

  it("bundles are kept 1 day when the run publishes a release, 7 days for a tag or manual run", () => {
    const retention = job("bundle")
      .split("\n")
      .filter((l) => l.trim().startsWith("retention-days:"));
    expect(retention).toEqual([`          retention-days: \${{ (${RELEASE}) && 1 || 7 }}`]);
  });
});

describe("build.yml — the macOS app opens", () => {
  it("tauri.conf.json ad-hoc signs the bundle, so it is never published unsigned", () => {
    const conf = JSON.parse(readFileSync(path.join(here, "../src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.bundle.macOS.signingIdentity).toBe("-");
  });

  it("the bundle job verifies the signature of the built app and of the app inside the .dmg", () => {
    const bundle = job("bundle");
    expect(bundle).toContain('codesign --verify --deep --strict --verbose=2 "$app"');
    expect(bundle).toContain('codesign --verify --deep --strict --verbose=2 "$mnt/Agent Studio.app"');
  });

  it("a failed check publishes nothing: the release job needs the bundle job", () => {
    expect(job("release")).toContain("    needs: bundle\n");
  });

  it("Apple secrets reach `tauri build` only when set: an empty identity would replace the ad-hoc one", () => {
    expect(job("bundle")).toContain('if [ -n "${!name}" ]; then');
  });

  it.each(["install-macos.sh", "install-linux.sh"])("the one-command installer %s is valid bash", (script) => {
    const res = spawnSync("bash", ["-n", path.join(here, script)], { encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });
});
