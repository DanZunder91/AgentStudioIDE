#!/usr/bin/env node
/** Dependency-vulnerability gate (`npm run audit`, in verify). Prod tree: zero high/critical, no
 * waivers. Full tree: every high/critical GHSA id must be waived (dated; overdue warns). Rust:
 * `cargo audit` verbatim. Vendored C: must match a reviewed entry. Zero dependencies. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { spawnSpec } from "./platform.mjs";

/** Moderate/low are reported, not blocking (`--audit-level=high`); raising this is policy. */
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/** Overdue warns, never fails: a calendar date can't make the tree worse, and a gate no code
 * change can turn green gets waved through. OVERDUE prints on every run. */
export const EXPIRY_POLICY = "warn";

/** Dated exceptions, ONE per advisory id; adding one is a security decision with its four fields
 * answered, `reviewBy` ≤ ~3 months out and a reviewer who read it. Stale entries must be deleted.
 * Empty is the goal state; a returning advisory needs a full entry, not a quiet re-add. */
export const WAIVERS = [];

/** `via` strings name other packages; objects are advisories. Prefers the GHSA id from `url`,
 * else npm's numeric `source`. */
export function advisoryFromVia(via) {
  if (!via || typeof via !== "object") return null;
  const url = typeof via.url === "string" ? via.url : "";
  const ghsa = url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  const id = ghsa
    ? ghsa[0]
    : via.source !== undefined && via.source !== null
      ? `npm-advisory-${via.source}`
      : null;
  if (!id) return null;
  return {
    id,
    severity: typeof via.severity === "string" ? via.severity : "unknown",
    name: typeof via.name === "string" ? via.name : String(via.dependency ?? "unknown"),
    title: typeof via.title === "string" ? via.title : "(no title)",
    url,
  };
}

/** Deduplicated by id (22 paths to one advisory is one problem). `unattributedBlocking` counts
 * blocking packages whose `via` explains nothing: no id to waive, so `classify` fails on them. */
export function collectAdvisories(report) {
  const advisories = new Map();
  const entries = Object.entries(report.vulnerabilities ?? {});
  const known = new Set(entries.map(([name]) => name));
  let unattributedBlocking = 0;

  for (const [name, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    const vias = Array.isArray(entry.via) ? entry.via : [];

    let explained = false;
    for (const via of vias) {
      const advisory = advisoryFromVia(via);
      if (advisory) {
        explained = true;
        if (!advisories.has(advisory.id)) advisories.set(advisory.id, { ...advisory, packages: [] });
        advisories.get(advisory.id).packages.push(name);
      } else if (typeof via === "string" && known.has(via)) {
        // A transitive path: this package is affected because another package in
        // this same report is. The advisory itself is recorded at the far end of
        // the chain, so nothing is lost by not re-recording it here.
        explained = true;
      }
    }

    // A blocking severity we cannot trace to any advisory is a finding the
    // waiver logic could not even name. Never swallow it (see `classify`).
    if (BLOCKING_SEVERITIES.has(entry.severity) && !explained) unattributedBlocking += 1;
  }

  return { advisories, unattributedBlocking };
}

/** Shape check for an `npm audit --json` payload. Missing/garbled => loud fail. */
function payloadProblem(report, label) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return `${label}: audit payload is not a JSON object (got ${report === null ? "null" : Array.isArray(report) ? "array" : typeof report})`;
  }
  if (report.vulnerabilities === undefined || report.vulnerabilities === null) {
    return `${label}: audit payload has no "vulnerabilities" field — refusing to interpret silence as safety`;
  }
  if (typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)) {
    return `${label}: audit payload's "vulnerabilities" is not an object`;
  }
  const counts = report.metadata?.vulnerabilities;
  if (counts === undefined || counts === null || typeof counts !== "object") {
    return `${label}: audit payload has no "metadata.vulnerabilities" counts`;
  }
  return null;
}

/** Pure, so it is tested on literal fixtures, not the live advisory DB. `reasons` = `prodReasons`
 * then `devReasons`; the split lets the summary name the tier that failed. */
export function classify({ prodAudit, devAudit, waivers = WAIVERS, now = new Date() } = {}) {
  // Split by tier so the summary can say honestly WHICH tier failed, rather
  // than one flat list that would mislabel a prod failure as a dev one.
  const prodReasons = [];
  const devReasons = [];
  const notes = [];
  const waived = [];
  const overdue = [];

  // --- Malformed input fails loudly and stops. Never pass on unparseable data.
  const prodProblem = payloadProblem(prodAudit, "production audit");
  const devProblem = payloadProblem(devAudit, "full (dev-inclusive) audit");
  if (prodProblem || devProblem) {
    if (prodProblem) prodReasons.push(prodProblem);
    if (devProblem) devReasons.push(devProblem);
    return {
      fail: true,
      reasons: [...prodReasons, ...devReasons],
      prodReasons,
      devReasons,
      waived,
      overdue,
      stale: [],
      notes,
      prodBlocking: [],
      devBlocking: [],
    };
  }

  const prod = collectAdvisories(prodAudit);
  const dev = collectAdvisories(devAudit);

  // --- 1. Production tree: zero tolerance, waivers deliberately NOT consulted.
  const prodBlocking = [...prod.advisories.values()].filter((a) =>
    BLOCKING_SEVERITIES.has(a.severity),
  );
  for (const a of prodBlocking) {
    const isWaived = waivers.some((w) => w.id === a.id);
    prodReasons.push(
      `PRODUCTION dependency ${a.name} has a ${a.severity} advisory ${a.id} (${a.title})` +
        (isWaived
          ? ` — this id IS waived for the dev tree, but a waiver never applies to code that ships. Fix or remove the dependency.`
          : ""),
    );
  }
  if (prod.unattributedBlocking > 0) {
    prodReasons.push(
      `PRODUCTION audit reported ${prod.unattributedBlocking} package(s) at high/critical severity but no advisory could be identified — the report shape changed; fix this script rather than trusting it`,
    );
  }

  // --- 2. Full tree: every blocking advisory must be explicitly waived.
  const devBlocking = [...dev.advisories.values()].filter((a) =>
    BLOCKING_SEVERITIES.has(a.severity),
  );
  for (const a of devBlocking) {
    // A retired waiver does not waive: if its advisory returns, the tree changed and a human must
    // look again.
    const waiver = waivers.find((w) => w.id === a.id && w.retired !== true);
    if (!waiver) {
      devReasons.push(
        `Unwaived ${a.severity} advisory ${a.id} in ${a.name} (${a.title}) — affects: ${a.packages.join(", ")}. Fix it, or add a dated waiver to scripts/audit.mjs with a written justification.`,
      );
      continue;
    }
    waived.push({ waiver, advisory: a });
    if (isOverdue(waiver, now)) overdue.push(waiver);
  }
  if (dev.unattributedBlocking > 0) {
    devReasons.push(
      `Full audit reported ${dev.unattributedBlocking} package(s) at high/critical severity but no advisory could be identified — the report shape changed; fix this script rather than trusting it`,
    );
  }

  // --- Housekeeping (reported, never blocking).
  const stale = waivers.filter((w) => !devBlocking.some((a) => a.id === w.id));
  const nonBlocking = [...dev.advisories.values()].filter(
    (a) => !BLOCKING_SEVERITIES.has(a.severity),
  );
  if (nonBlocking.length > 0) {
    notes.push(
      `${nonBlocking.length} advisory/advisories below high severity (not blocking): ` +
        nonBlocking.map((a) => `${a.id} ${a.name} (${a.severity})`).join(", "),
    );
  }

  const reasons = [...prodReasons, ...devReasons];
  return {
    fail: reasons.length > 0,
    reasons,
    prodReasons,
    devReasons,
    waived,
    overdue,
    stale,
    notes,
    prodBlocking,
    devBlocking,
  };
}

/** True when `waiver.reviewBy` is in the past (or unparseable — that is overdue too). */
export function isOverdue(waiver, now) {
  const due = Date.parse(`${waiver.reviewBy}T23:59:59Z`);
  if (Number.isNaN(due)) return true;
  return now.getTime() > due;
}

// ===== PART 4 — THE C WE VENDOR (the blind spot `cargo audit` cannot see) =====
/** Lockfile version is the authority (crates.io is immutable); offline, no CVE DB. Every cc/cmake
 * dependent needs a reviewed entry. libz-sys links host zlib on macOS/Linux (printed only). */

/** A dependency on these means the crate invokes a C/C++ compiler (`cmake` itself uses `cc`). */
export const NATIVE_BUILD_MARKERS = ["cc", "cmake"];

/** ONE reviewed entry per native-code crate; any drift or unlisted crate fails. `cVersion` null:
 * the crate version is the identity. `probe` reads a C `#define`; `checked` is what the next
 * reviewer diffs against. */
export const REVIEWED_VENDORED_C = [
  {
    crate: "libgit2-sys",
    crateVersion: "0.18.7+1.9.6",
    library: "libgit2 (C)",
    cVersion: "1.9.6",
    probe: { file: "libgit2/include/git2/version.h", macro: "LIBGIT2_VERSION" },
    // Attribution: the C's OWN notice, which the crate's declared `MIT OR
    // Apache-2.0` understates. Consumed by scripts/attribution.mjs.
    noticeFiles: [
      {
        file: "libgit2/COPYING",
        label: "libgit2 1.9.6 — GPL-2.0 WITH a linking exception (see the LINKING EXCEPTION paragraph)",
      },
    ],
    ships: true,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "OSV.dev and the GitHub Advisory DB were queried for libgit2 1.9.6 on 2026-07-29: zero entries. This is the highest-risk C we compile — `git_blame` runs libgit2's revision walk and diff machinery over whatever repository the user opens, so the input is attacker-influenced by design. We build it because `git2` is declared with `features = [\"vendored-libgit2\"]`, which makes the build self-contained instead of depending on whatever system libgit2 happens to be present. `default-features = false` drops the https/ssh features, so libgit2's own network stack (its bundled `llhttp` and `ntlmclient`) should not be compiled; that was NOT verified against a real build (this audit does not build anything) and remains an open item. The bundled `deps/zlib` inside this crate reads ZLIB_VERSION 1.3.1 but is NOT what gets compiled: libgit2-sys depends on `libz-sys` for zlib, so read the zlib row below rather than that header.",
  },
  {
    crate: "libz-sys",
    crateVersion: "1.1.33",
    library: "zlib (C) — bundled fallback, compiled only on MSVC/mingw or static builds",
    cVersion: "1.4",
    probe: { file: "src/zlib/zlib.h", macro: "ZLIB_VERSION" },
    noticeFiles: [
      {
        file: "src/zlib/zlib.h",
        label: "zlib 1.4 — Zlib licence (reproduced from the header's leading comment block)",
        extract: "leading-block-comment",
      },
    ],
    ships: "conditional",
    reviewedOn: "2026-11-19",
    reviewedBy: "re-review on the bump 1.1.31 → 1.1.33 for RUSTSEC-2026-0544; before it, the bump 1.1.29 → 1.1.31 for RUSTSEC-2026-0418; first review: dependency security audit",
    checked:
      "Re-reviewed 2026-11-19 on the bump 1.1.31 → 1.1.33, made for RUSTSEC-2026-0544 / CVE-2026-85091 (zlib 1.3.1.2–1.3.2: heap buffer overflow in gz_vacate() on a non-blocking gzwrite()/gzprintf() after a write stall; patched in libz-sys >= 1.1.33). THE C LIBRARY CHANGED: the bundled `src/zlib/zlib.h` now reads ZLIB_VERSION 1.4 (was 1.3.2), so everything below about 1.3.2 is history, not the current review. Checked on 2026-11-19: OSV.dev returns zero entries for crates.io libz-sys 1.1.33 (and returns RUSTSEC-2026-0544 for 1.1.31, so the query does see this crate); the GitHub Advisory DB returns none for libz-sys@1.1.33; OSV has no entry for zlib 1.4 under the OSS-Fuzz or Alpine ecosystems (weak evidence: those are keyed on their own version schemes). `build.rs` is byte-identical to 1.1.31, so the link decision is unchanged: the SYSTEM zlib on macOS/Linux, the bundled copy on MSVC/mingw or static builds — which means the Windows installer is the build this advisory applied to. Exposure: libgit2 inflates objects through zlib's in-memory API, not gzwrite()/gzprintf(), so the vulnerable path was not reached by our use either way. " +
      "Re-reviewed 2026-11-04 on the bump 1.1.29 → 1.1.31, made for RUSTSEC-2026-0418 (the build script leaked environment variables into the build directory; fixed in 1.1.31): the bundled `src/zlib/zlib.h` still reads ZLIB_VERSION 1.3.2 — the same C library reviewed below — and build.rs's link decision is unchanged (it still compiles `src/smoke.c` against `-lz` and links the SYSTEM zlib unless `LIBZ_SYS_STATIC` / the `static` feature or an MSVC/mingw target forces the bundled copy). OSV was NOT re-queried for zlib 1.3.2 on this bump (its Debian-ecosystem answer is keyed on Debian versions and did not settle it); the 2026-07-29 query below stands for this C. " +
      "OSV.dev returns zero entries for zlib 1.3.2 (queried 2026-07-29). IMPORTANT, found by reading `libz-sys-1.1.29/build.rs` line by line: on macOS and Linux this crate does NOT compile the bundled 1.3.2 at all. Unless the target is `msvc`/`pc-windows-gnu` or `LIBZ_SYS_STATIC`/the `static` feature forces it, build.rs compiles `src/smoke.c` against `-lz` and, when that succeeds, emits `cargo:rustc-link-lib=z` and returns — i.e. it dynamically links the SYSTEM zlib. libgit2-sys pulls libz-sys with `default-features = false, features = [\"libc\"]`, so `static` is off. Consequence: what actually ships on macOS is the host/OS zlib (SDK header on the 2026-07-29 review machine: 1.2.12), which our lockfile cannot pin and this gate can therefore only REPORT, not enforce. The 1.3.2 pinned here is the fallback that Windows builds do compile, and it is the version to re-check when this crate is bumped.",
  },
  {
    crate: "aws-lc-sys",
    crateVersion: "0.43.0",
    library: "aws-lc (C + assembly, a BoringSSL fork)",
    cVersion: "5.2.0",
    probe: { file: "aws-lc/include/openssl/base.h", macro: "AWSLC_VERSION_NUMBER_STRING" },
    noticeFiles: [{ file: "aws-lc/LICENSE", label: "aws-lc 5.2.0 — Apache-2.0 and ISC/OpenSSL notices" }],
    ships: true,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "OSV.dev returns zero entries for aws-lc-sys 0.43.0 (queried 2026-07-29). It entered the macOS graph because `reqwest 0.13`'s `rustls` feature is an alias for `__rustls-aws-lc-rs` — i.e. we compiled a whole BoringSSL fork for the HTTP client's TLS, alongside `ring` (previous row), which is TWO independent C crypto stacks in one binary. It handles remote network input on the `http_send` path, so it was second only to libgit2 in exposure. Audit action #9 (collapse onto one provider via reqwest's `rustls-no-provider`) was in progress on 2026-07-29 and this crate had already left `src-tauri/Cargo.lock` by the time this manifest was written — so the gate reports it as ABSENT, not as a match. The entry is KEPT deliberately: if the provider choice is ever reverted, or a Windows/Linux build resolves it back in, the version it comes back at is the one to re-check against OSV. Delete this row once #9 is confirmed landed and permanent.",
  },
  {
    crate: "ring",
    crateVersion: "0.17.14",
    library: "ring (C + assembly, BoringSSL-derived)",
    cVersion: null,
    probe: null,
    ships: true,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "OSV.dev returns zero entries for ring 0.17.14 (queried 2026-07-29). `cVersion` is deliberately null: ring vendors a curated BoringSSL snapshot with no upstream version string to read, so the crate version IS the identity of the C — which is sound, because a crates.io release is immutable. Reached via `tokio-tungstenite` and `tonic`'s `tls-ring`. Historically the crate with the most RustSec traffic of the four (RUSTSEC-2025-0009 / -0010 affected 0.17.x before 0.17.12), so a bump here deserves a real re-read of the advisory list, not a rubber stamp.",
  },
  {
    crate: "objc2-exception-helper",
    crateVersion: "0.1.1",
    library: "objc2-exception-helper (a few lines of first-party Objective-C)",
    cVersion: null,
    probe: null,
    ships: true,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "In the watch list because it invokes `cc`, but it vendors no third-party C: it is the objc2 project's own ~40-line `@try/@catch` trampoline (`extern.m`), needed because Rust cannot catch Objective-C exceptions. No upstream project, so no CVE feed to watch and no `cVersion` to pin; the crate version is the identity. Compiled on Apple targets, reached through Tauri's `wry` webview. Listed rather than excluded so the derived watch list stays a CLOSED set — an entry that says 'checked, nothing to watch' is what keeps a new arrival visible.",
  },
  {
    crate: "cmake",
    crateVersion: "0.1.58",
    library: "cmake crate (no C of its own — a build-script driver)",
    cVersion: null,
    probe: null,
    ships: false,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "Appears in the derived watch list only because it depends on `cc`. It ships no C source: it shells out to the host `cmake` binary from a build script. Nothing is linked into the artifact. Present in the lockfile for `aws-lc-sys`'s optional CMake build path and `libz-sys`'s zlib-ng path, neither of which we enable.",
  },
  {
    crate: "embed-resource",
    crateVersion: "3.0.11",
    library: "embed-resource (Windows .rc resource compiler driver)",
    cVersion: null,
    probe: null,
    ships: false,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "Windows-only, build-host-only: `tauri-build` uses it to compile the app manifest/icon `.rc` into the executable. It vendors no C library — it drives `rc.exe`/`windres`. Nothing to watch for CVEs; re-read this row only if we ever ship Windows and the crate starts bundling source.",
  },
  {
    crate: "vswhom-sys",
    crateVersion: "0.1.3",
    library: "vswhom-sys (small vendored C++ MSVC-locator, Windows only)",
    cVersion: null,
    probe: null,
    ships: false,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "Windows-only and build-host-only, reached through `embed-resource`. It compiles a single small vendored C++ file (Jonathan Blow's `microsoft_craziness.h` derivative) whose job is to locate a Visual Studio installation at build time. Not in the macOS graph (`cargo tree --target aarch64-apple-darwin` prints nothing for it) and never linked into a shipped artifact. No upstream release stream to monitor.",
  },
  {
    crate: "iana-time-zone-haiku",
    crateVersion: "0.1.2",
    library: "iana-time-zone-haiku (tiny C++ shim, Haiku OS only)",
    cVersion: null,
    probe: null,
    ships: false,
    reviewedOn: "2026-07-29",
    reviewedBy: "dependency security audit",
    checked:
      "Compiled only when the target OS is Haiku, which we do not ship. It is a ~20-line C++ wrapper around Haiku's own timezone API, with no vendored third-party source. Reached transitively through `chrono`/`iana-time-zone`. Listed so the derived watch list stays closed.",
  },
];

/** A narrow reader, no TOML dependency: it must run before anything is installed, and Cargo.lock's
 * shape is fixed. */
export function parseCargoLockPackages(text) {
  if (typeof text !== "string") return [];
  const blocks = text.split(/(?:^|\n)\[\[package\]\]\n/).slice(1);
  const packages = [];
  for (const block of blocks) {
    // Stop at the next top-level table so a trailing `[metadata]`/`[[patch...]]`
    // section cannot bleed into the last package's fields.
    const body = block.split(/\n\[(?!\[)/)[0];
    const name = body.match(/^name = "([^"]*)"$/m)?.[1];
    const version = body.match(/^version = "([^"]*)"$/m)?.[1];
    if (!name || !version) continue;
    const depsBlock = body.match(/^dependencies = \[\n([\s\S]*?)^\]$/m)?.[1] ?? "";
    const deps = depsBlock
      .split("\n")
      .map((line) => line.trim().match(/^"([^"]*)",?$/)?.[1])
      .filter((entry) => typeof entry === "string")
      // A dependency entry is `"name"` or `"name version"` (or `"name version (source)"`).
      .map((entry) => entry.split(" ")[0]);
    packages.push({ name, version, deps });
  }
  return packages;
}

/** Derived from the lockfile so new native code shows up unasked. Over-approximates on purpose:
 * one reviewed line per crate beats a missed CVE feed. Sorted by name. */
export function nativeCodeCrates(packages, markers = NATIVE_BUILD_MARKERS) {
  const marker = new Set(markers);
  return (Array.isArray(packages) ? packages : [])
    .filter((pkg) => pkg && Array.isArray(pkg.deps) && pkg.deps.some((d) => marker.has(d)))
    .map((pkg) => ({ name: pkg.name, version: pkg.version }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** null when absent or not a string literal: a wrong version is worse than an honest unknown. */
export function parseCMacroString(source, macro) {
  if (typeof source !== "string" || typeof macro !== "string" || macro === "") return null;
  const escaped = macro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+${escaped}[ \\t]+"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

/** `-sys` crates version as `<semver>+<C version>`: a header-independent reading of the fact. */
export function versionFromBuildMetadata(crateVersion) {
  if (typeof crateVersion !== "string") return null;
  const plus = crateVersion.indexOf("+");
  if (plus === -1 || plus === crateVersion.length - 1) return null;
  return crateVersion.slice(plus + 1);
}

/** Pure (tested on literals). `unverified`: crate matches, C version unreadable (passes, noted).
 * `absent`: reviewed but not in the lockfile (passes, reported so stale entries get removed). */
export function classifyVendoredC({ detected, reviewed } = {}) {
  const reasons = [];
  const notes = [];
  const matched = [];
  const unverified = [];
  const absent = [];

  // An empty or malformed review list must FAIL, never pass vacuously: "we
  // watch no C libraries" and "no C libraries were found" would otherwise look
  // identical, and the first one is a broken gate.
  if (!Array.isArray(reviewed) || reviewed.length === 0) {
    reasons.push(
      "the reviewed vendored-C manifest (REVIEWED_VENDORED_C) is empty or not a list — refusing to pass a check that watches nothing. Restore the manifest in scripts/audit.mjs.",
    );
    return { fail: true, reasons, matched, unverified, absent, notes };
  }
  if (!Array.isArray(detected)) {
    reasons.push(
      `could not enumerate the native-code crates (expected a list, got ${detected === null ? "null" : typeof detected}) — refusing to report a green gate on data it could not read.`,
    );
    return { fail: true, reasons, matched, unverified, absent, notes };
  }

  const byCrate = new Map(reviewed.map((entry) => [entry.crate, entry]));

  for (const found of detected) {
    const entry = byCrate.get(found.crate);
    if (!entry) {
      // The case that makes this a control instead of a comment.
      reasons.push(
        `UNREVIEWED native-code crate ${found.crate} ${found.crateVersion} compiles C/C++/assembly (it depends on ${NATIVE_BUILD_MARKERS.join(" or ")}) and has no entry in REVIEWED_VENDORED_C. Nobody has checked it for CVEs. Read what it vendors, query OSV for that version, and add a dated entry to scripts/audit.mjs.`,
      );
      continue;
    }
    if (found.crateVersion !== entry.crateVersion) {
      reasons.push(
        `VENDORED C DRIFT: ${entry.library} — crate ${found.crate} is now ${found.crateVersion}, but the reviewed version is ${entry.crateVersion} (reviewed ${entry.reviewedOn}). That is a different C library, and nobody has checked it for CVEs. Query OSV/GHSA for the new version and update the entry in scripts/audit.mjs.`,
      );
      continue;
    }
    if (entry.cVersion === null || entry.cVersion === undefined) {
      // No upstream version string exists; the immutable crate version is the
      // identity, and it just matched.
      matched.push({ entry, found });
      continue;
    }
    if (found.cVersion === null || found.cVersion === undefined) {
      unverified.push({ entry, found });
      notes.push(
        `${entry.library}: crate ${found.crate} ${found.crateVersion} matches the review, but the C version could not be read (${found.cVersionSource ?? "no source given"}). The crate version still pins the exact C source bytes — a crates.io release is immutable — so this PASSES; the reviewed C version is ${entry.cVersion}.`,
      );
      continue;
    }
    if (found.cVersion !== entry.cVersion) {
      reasons.push(
        `VENDORED C DRIFT: ${entry.library} — the vendored source reports ${found.cVersion}, but the reviewed version is ${entry.cVersion} (crate ${found.crate} ${found.crateVersion}, reviewed ${entry.reviewedOn}, read from ${found.cVersionSource ?? "unknown source"}). Either the crate re-bundled different C under the same crate version, or this script is reading the wrong file. Both need a human.`,
      );
      continue;
    }
    matched.push({ entry, found });
  }

  const detectedCrates = new Set(detected.map((found) => found.crate));
  for (const entry of reviewed) {
    if (!detectedCrates.has(entry.crate)) absent.push(entry);
  }
  for (const entry of absent) {
    notes.push(
      `${entry.library}: crate ${entry.crate} is not in src-tauri/Cargo.lock — not vendored in this configuration, so there is nothing to check. If the dependency was removed for good, delete this entry from REVIEWED_VENDORED_C.`,
    );
  }

  return { fail: reasons.length > 0, reasons, matched, unverified, absent, notes };
}

// ---- Runner: everything below is I/O; the judgement is in `classify` and `classifyVendoredC`.

/** Every `registry/src/<index>` directory cargo might have unpacked crates into. */
function registrySourceRoots() {
  const home = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
  const src = path.join(home, "registry", "src");
  try {
    return fs
      .readdirSync(src, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(src, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** Exact `<name>-<version>` dir, never a glob: several versions can be unpacked side by side. */
function unpackedCrateDir(name, version, roots) {
  for (const root of roots) {
    const dir = path.join(root, `${name}-${version}`);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** Lockfile (authority) plus unpacked crate sources (corroboration, when present). */
function detectVendoredC(lockPath, reviewed) {
  let lockText;
  try {
    lockText = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    return { error: `could not read ${lockPath}: ${err.message}`, detected: null, lockPackages: 0 };
  }
  const packages = parseCargoLockPackages(lockText);
  if (packages.length === 0) {
    return {
      error: `parsed 0 [[package]] records out of ${lockPath} — the lockfile format changed; fix this script rather than trusting it`,
      detected: null,
      lockPackages: 0,
    };
  }

  const roots = registrySourceRoots();
  const byCrate = new Map(reviewed.map((entry) => [entry.crate, entry]));
  const detected = nativeCodeCrates(packages).map(({ name, version }) => {
    const entry = byCrate.get(name);
    const probe = entry?.probe ?? null;
    // Reading #1: the `+build.metadata` half of the crate version, when present.
    // Independent of the filesystem, so it works on a fresh CI checkout.
    const fromMetadata = versionFromBuildMetadata(version);

    if (!probe) {
      return {
        crate: name,
        crateVersion: version,
        cVersion: entry && entry.cVersion === null ? null : fromMetadata,
        cVersionSource: fromMetadata ? "crate version build metadata" : "no probe configured",
      };
    }

    const dir = unpackedCrateDir(name, version, roots);
    if (!dir) {
      return {
        crate: name,
        crateVersion: version,
        cVersion: fromMetadata,
        cVersionSource: fromMetadata
          ? "crate version build metadata (crate source not unpacked in the local cargo registry)"
          : `crate source not unpacked in the local cargo registry (looked for ${name}-${version} under ${roots.length} registry root(s))`,
      };
    }
    const file = path.join(dir, probe.file);
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (err) {
      return {
        crate: name,
        crateVersion: version,
        cVersion: fromMetadata,
        cVersionSource: `could not read ${probe.file}: ${err.message}`,
      };
    }
    const fromHeader = parseCMacroString(source, probe.macro);
    return {
      crate: name,
      crateVersion: version,
      cVersion: fromHeader ?? fromMetadata,
      cVersionSource: fromHeader
        ? `${probe.macro} in ${probe.file}`
        : `${probe.macro} not found in ${probe.file}`,
    };
  });

  return { error: null, detected, lockPackages: packages.length };
}

/** Informational only: it depends on the build host's SDK, so gating on it would be red on any
 * machine with a different Xcode. */
function detectSystemZlib() {
  const candidates = ["/usr/include/zlib.h"];
  const sdk = spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  if (!sdk.error && sdk.status === 0) {
    const root = (sdk.stdout ?? "").trim();
    if (root) candidates.unshift(path.join(root, "usr", "include", "zlib.h"));
  }
  for (const file of candidates) {
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const version = parseCMacroString(source, "ZLIB_VERSION");
    if (version) return { version, file };
  }
  return { version: null, file: candidates.join(", ") };
}


// npm is `npm.cmd` on Windows, and Node refuses to spawn a .cmd without a shell (EINVAL since
// 18.20.2 / 20.12.2, the CVE-2024-27980 fix) — spelling it `npm.cmd` alone fails exactly that
// way. `spawnSpec` owns the spelling; see scripts/platform.mjs.
const NPM = "npm";
// `npm audit --json` on a large tree easily exceeds Node's 1MB default buffer,
// and a truncated payload would parse as garbage (i.e. a fail, but for the
// wrong reason). 128MB is free unless it is actually needed.
const MAX_BUFFER = 128 * 1024 * 1024;

/** npm exits non-zero whenever it finds anything, so only an unparseable payload is a crash. */
function runNpmAudit(extraArgs, label) {
  const args = ["audit", "--json", ...extraArgs];
  const spec = spawnSpec(NPM, args);
  const res = spawnSync(spec.cmd, spec.args, { encoding: "utf8", maxBuffer: MAX_BUFFER, ...spec.options });
  if (res.error) {
    fatal(`could not run \`${NPM} ${args.join(" ")}\`: ${res.error.message}`);
  }
  const raw = (res.stdout ?? "").trim();
  if (!raw) {
    fatal(
      `\`${NPM} ${args.join(" ")}\` produced no JSON on stdout (exit ${res.status}).\n${(res.stderr ?? "").trim()}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fatal(
      `could not parse the JSON from \`${NPM} ${args.join(" ")}\` (${label}): ${err.message}\n` +
        `first 400 chars: ${raw.slice(0, 400)}`,
    );
  }
  return undefined; // unreachable; `fatal` exits.
}

function fatal(message) {
  console.error(`\n[FAIL] dependency audit could not be evaluated: ${message}`);
  console.error("[FAIL] refusing to report a green gate on data it could not read.\n");
  process.exit(1);
}

function main() {
  console.log("Dependency audit (waiver-aware; policy in scripts/audit.mjs)\n");

  const prodAudit = runNpmAudit(["--omit=dev"], "production tree");
  const devAudit = runNpmAudit([], "full tree (dev included)");
  const result = classify({ prodAudit, devAudit });

  const prodCounts = prodAudit.metadata.vulnerabilities;
  const devCounts = devAudit.metadata.vulnerabilities;

  console.log(
    `  npm, production tree  : ${result.prodReasons.length === 0 ? "[PASS]" : "[FAIL]"} ` +
      `${prodCounts.high ?? 0} high, ${prodCounts.critical ?? 0} critical  (zero tolerance — waivers never apply here)`,
  );
  console.log(
    `  npm, full tree (+dev) : ${result.devReasons.length === 0 ? "[PASS]" : "[FAIL]"} ` +
      `${devCounts.high ?? 0} high / ${devCounts.critical ?? 0} critical findings across ` +
      `${result.devBlocking.length} distinct advisory/advisories, ${result.waived.length} waived`,
  );

  for (const { waiver, advisory } of result.waived) {
    console.log(`\n  [WAIVED] ${waiver.id} — ${waiver.package} (${waiver.severity})`);
    console.log(`     title       : ${waiver.title}`);
    console.log(`     scope       : ${waiver.scope}`);
    console.log(`     unfixable   : ${waiver.whyUnfixable}`);
    console.log(`     acceptable  : ${waiver.whyAcceptable}`);
    console.log(`     reviewed    : ${waiver.reviewedOn} by ${waiver.reviewedBy}`);
    console.log(`     review by   : ${waiver.reviewBy}`);
    console.log(`     paths       : ${advisory.packages.join(", ")}`);
  }
  for (const waiver of result.overdue) {
    console.log(
      `\n  [OVERDUE] waiver ${waiver.id} passed its review date (${waiver.reviewBy}). ` +
        `Re-read the advisory and either fix it or re-date the waiver. ` +
        `(EXPIRY_POLICY = "${EXPIRY_POLICY}": an overdue waiver warns, it does not fail — see scripts/audit.mjs.)`,
    );
  }
  for (const waiver of result.stale) {
    console.log(
      `\n  [STALE WAIVER] ${waiver.id} no longer matches anything in the tree — delete it from scripts/audit.mjs.`,
    );
  }
  for (const note of result.notes) console.log(`\n  [note] ${note}`);
  for (const reason of result.reasons) console.log(`\n  [FAIL] ${reason}`);

  // --- 3. Rust: cargo audit already implements this policy, so its verdict is propagated verbatim.
  // Its warnings are not counted: that number moves with every Tauri/git2 bump.
  console.log("\n  cargo audit (RustSec)  : running `cargo audit --file src-tauri/Cargo.lock` ...\n");
  const cargo = spawnSync("cargo", ["audit", "--file", "src-tauri/Cargo.lock"], {
    stdio: "inherit",
  });
  const cargoOk = !cargo.error && cargo.status === 0;
  if (cargo.error) {
    console.log(`\n  cargo audit (RustSec)  : [FAIL] could not run cargo audit: ${cargo.error.message}`);
    console.log("     install it with: cargo install cargo-audit --locked");
  }

  // --- 4. The C we vendor. `cargo audit` cannot see it (see the block above
  // REVIEWED_VENDORED_C); this compares what the lockfile pins against a dated
  // human review and fails on any drift.
  console.log("\n  vendored C libraries   : checking src-tauri/Cargo.lock against REVIEWED_VENDORED_C ...\n");
  const probe = detectVendoredC(path.join("src-tauri", "Cargo.lock"), REVIEWED_VENDORED_C);
  const vendored = probe.error
    ? { fail: true, reasons: [probe.error], matched: [], unverified: [], absent: [], notes: [] }
    : classifyVendoredC({ detected: probe.detected, reviewed: REVIEWED_VENDORED_C });

  if (!probe.error) {
    console.log(
      `     ${probe.detected.length} of ${probe.lockPackages} locked crates compile C/C++/assembly ` +
        `(they depend on ${NATIVE_BUILD_MARKERS.join(" or ")}); ${REVIEWED_VENDORED_C.length} reviewed entries.`,
    );
    for (const { entry, found } of vendored.matched) {
      const shipped = entry.ships === true ? "ships" : entry.ships === false ? "not shipped" : String(entry.ships);
      console.log(
        `     [OK] ${found.crate} ${found.crateVersion} -> ${entry.library}` +
          `${entry.cVersion ? ` ${found.cVersion}` : ""} — reviewed ${entry.reviewedOn}, ${shipped}` +
          `${entry.cVersion ? ` (read from ${found.cVersionSource})` : " (crate version is the identity)"}`,
      );
    }
    for (const { entry, found } of vendored.unverified) {
      console.log(
        `     [UNVERIFIED] ${found.crate} ${found.crateVersion} -> ${entry.library}: crate version matches ` +
          `the review; C version not read (${found.cVersionSource}). Reviewed C version: ${entry.cVersion}.`,
      );
    }
  }
  const hostZlib = detectSystemZlib();
  console.log(
    `\n     [host, informational] libz-sys links the SYSTEM zlib on macOS/Linux (its build.rs only compiles ` +
      `the bundled ${REVIEWED_VENDORED_C.find((e) => e.crate === "libz-sys")?.cVersion ?? "?"} on MSVC/mingw/static builds), so the zlib in a macOS ` +
      `build is the host's: ${hostZlib.version ?? "could not be read"} (${hostZlib.file}). ` +
      `This is NOT enforced — the version belongs to the build machine's SDK, not to our lockfile, and failing ` +
      `on it would make the gate red on any machine with a different Xcode.`,
  );
  for (const entry of vendored.absent) {
    console.log(`\n     [ABSENT] ${entry.crate} (${entry.library}) — reviewed, but not in the lockfile. Not blocking.`);
  }
  for (const note of vendored.notes) console.log(`\n     [note] ${note}`);
  for (const reason of vendored.reasons) console.log(`\n     [FAIL] ${reason}`);

  const failed = result.fail || !cargoOk || vendored.fail;
  console.log("\n" + "-".repeat(78));
  console.log(`  npm production : ${result.prodReasons.length === 0 ? "PASS" : "FAIL"}`);
  console.log(
    `  npm full tree  : ${
      result.devReasons.length > 0
        ? "FAIL"
        : result.waived.length > 0
          ? `PASS (with ${result.waived.length} waived)`
          : "PASS"
    }`,
  );
  console.log(`  cargo audit    : ${cargoOk ? "PASS" : "FAIL"}`);
  console.log(
    `  vendored C     : ${
      vendored.fail
        ? "FAIL"
        : vendored.unverified.length > 0
          ? `PASS (${vendored.matched.length} verified, ${vendored.unverified.length} crate-version-only)`
          : `PASS (${vendored.matched.length} verified)`
    }`,
  );
  console.log(`  overall        : ${failed ? "FAIL" : "PASS"}`);
  console.log("-".repeat(78) + "\n");

  process.exit(failed ? 1 : 0);
}

// Only run when executed directly — importing this module (the tests do) must
// never shell out to npm.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
