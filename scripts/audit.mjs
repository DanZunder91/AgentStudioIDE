#!/usr/bin/env node
/**
 * The dependency-vulnerability gate (part of `npm run verify`, run on its own as `npm run audit`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The gate used to be `npm audit --audit-level=high && cargo audit`. That
 * command has been RED continuously since the WebDriver/E2E tier landed,
 * because of one unfixable dev-only advisory (see WAIVERS below). A gate that
 * is permanently red is not a gate: it gets waived by hand every push, and the
 * hand that waives the known-unfixable finding also waives the NEW one sitting
 * next to it. That is a worse security posture than having no gate at all — so
 * the fix is not to lower the bar, it is to make the bar precise.
 *
 * THE POLICY (mirrors what `cargo audit` already does on the Rust side, where
 * ~19 unmaintained/unsound *warnings* are allowed while any true vulnerability
 * fails the run):
 *
 *   1. PRODUCTION TREE (`npm audit --omit=dev`) — zero tolerance. Any
 *      high/critical here fails, **even if the advisory id is waived below**.
 *      Waivers are scoped to the dev tree by construction; code that ships to
 *      users never gets one. (Enforced in `classify`: the prod scan does not
 *      consult the waiver list at all.)
 *   2. FULL TREE (`npm audit`, dev included) — every high/critical advisory id
 *      must appear in the WAIVERS list. An id that is not waived fails. A
 *      waived id prints as a loud, dated WAIVED line with its justification.
 *   3. RUST (`cargo audit --file src-tauri/Cargo.lock`) — run as-is and its
 *      exit code propagated. It already fails on vulnerabilities and merely
 *      warns on the allowed unmaintained/unsound set, so no counting or
 *      pattern-matching of its output happens here (the warning count moves
 *      whenever a Tauri/git2 dependency is bumped; asserting on it would be a
 *      second permanently-red gate).
 *   4. VENDORED C (`REVIEWED_VENDORED_C` + `classifyVendoredC`) — `cargo audit`
 *      reads `Cargo.lock` and knows only about *crates*. It has no idea that on
 *      macOS we also compile **libgit2 1.9.6** and **aws-lc 5.2.0** from bundled
 *      C source, so a libgit2 CVE would pass every gate in the Definition of
 *      Done — and libgit2 parses attacker-influenced data by design (`git_blame`
 *      runs against whatever repository the user opens). This part detects the
 *      vendored C versions and fails if any of them differs from a reviewed,
 *      dated entry. See the block above `REVIEWED_VENDORED_C` for the design.
 *
 * WHY KEY ON THE ADVISORY ID, NOT THE PACKAGE OR THE SEVERITY
 * -----------------------------------------------------------
 * A waiver is a statement about ONE known finding that a human read and
 * reasoned about. `"ignore brace-expansion"` would also silently swallow a
 * future *second* brace-expansion advisory — including a genuinely exploitable
 * one — and `"ignore high in dev"` would swallow everything. Keying on the
 * GHSA id means the gate goes red the moment anything new appears anywhere,
 * which is exactly the signal we want to keep alive.
 *
 * A WAIVER IS A DATED DECISION, NOT A PERMANENT EXEMPTION. Each entry carries a
 * `reviewBy`; past that date the gate prints an OVERDUE warning on every run
 * until someone re-reads it (see `EXPIRY_POLICY` for why overdue warns rather
 * than fails).
 *
 * Zero new dependencies on purpose: `child_process` plus the tools' own `--json`
 * output. This script has to run in CI before anything is built.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { spawnSpec } from "./platform.mjs";

/**
 * Severities that fail a gate. Matches the historical `--audit-level=high`
 * contract: moderate/low findings are reported for information but do not
 * block. Raising this is a policy change, not a tweak.
 */
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/**
 * What happens when a waiver's `reviewBy` date has passed.
 *
 * DECISION: "warn". An overdue waiver is a documentation debt, not
 * a change in the security posture — nothing about the dependency tree got
 * worse on the stroke of midnight. Failing on a calendar date would recreate
 * the exact failure this script exists to remove: a red gate that no code
 * change can turn green, which trains everyone to wave it through. So an
 * overdue waiver prints OVERDUE on every single run (and appears in the
 * summary), and the run still passes on the merits of the dependency tree.
 */
export const EXPIRY_POLICY = "warn";

/**
 * Accepted, dated exceptions. ONE entry per advisory id. Adding an entry here
 * is a security decision: it needs the four fields below answered honestly, a
 * `reviewBy` no more than ~3 months out, and a reviewer who actually read the
 * advisory. Deleting an entry that no longer matches anything is mandatory
 * housekeeping — the gate reports stale entries so they don't accumulate.
 */
// EMPTY. The five entries that used to live here (extract-zip x2, deepmerge-ts,
// basic-ftp, braces) all came in through WebdriverIO 9; the move to WebdriverIO 10 (mocha 12,
// @puppeteer/browsers 3) removed every one of those packages or moved it to a patched major,
// so there was nothing left to waive. Their full text is in git history. An empty list is
// the goal state: `npm audit` reports 0 findings of any severity in the full tree.
// (npm once reported picomatch's GHSA-fc5q-39xc-vjpf — dev-only paths, no patched release — for
// about a day, then stopped reporting it; it was never waived. If it comes back, it needs a full
// entry here, not a quiet re-add.)
export const WAIVERS = [];

/**
 * Pull the advisory id out of one `via` entry of an `npm audit --json` report.
 *
 * `via` is a mixed array: strings name another affected package (a transitive
 * path, carrying no advisory of its own) and objects are the actual advisory.
 * Prefer the GHSA id from `url` — it is the stable, human-checkable identity;
 * fall back to npm's numeric `source` when a report has no url.
 *
 * @returns {{id: string, severity: string, name: string, title: string, url: string} | null}
 */
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

/**
 * Collect the distinct advisories of an `npm audit --json` report.
 *
 * Deduplicates by id: the 22 high entries in the full tree are 22 paths to one
 * advisory, and a gate that says "22 problems" when there is one problem is a
 * gate nobody reads.
 *
 * @returns {{advisories: Map<string, object>, unattributedBlocking: number}}
 *   `unattributedBlocking` counts packages reported at a blocking severity whose
 *   `via` chain explains nothing — neither an advisory object of their own nor a
 *   named package that is itself in the report. That must never be silently
 *   ignored: it would be a finding the waiver logic cannot even name (it has no
 *   id to key on), so `classify` treats it as a hard failure. Counted per
 *   package, so one identifiable advisory can never mask an unidentifiable one.
 */
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

/**
 * THE DECISION FUNCTION — pure, so it can be tested against literal fixtures
 * instead of against today's live advisory database (which changes under us).
 *
 * @param {object} args
 * @param {object} args.prodAudit  parsed `npm audit --json --omit=dev`
 * @param {object} args.devAudit   parsed `npm audit --json` (dev included)
 * @param {Array}  args.waivers    waiver records (defaults to WAIVERS)
 * @param {Date}   args.now        clock, injectable for tests
 * @returns {{fail: boolean, reasons: string[], prodReasons: string[], devReasons: string[],
 *            waived: object[], overdue: object[], stale: object[], notes: string[],
 *            prodBlocking: object[], devBlocking: object[]}}
 *   `reasons` is `prodReasons` followed by `devReasons`; the split exists so the
 *   summary can name the tier that failed instead of blaming the wrong one.
 */
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
    // 🔴 A **retired** waiver does not waive. It is a record of a decision about a tree that no
    // longer exists — the advisory was gone when it was retired — so if the advisory comes back,
    // the tree changed and a human has to look again. Silently re-applying a justification nobody
    // has re-read is exactly the "waiver as permanent exemption" this gate was rebuilt to prevent.
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

// ===========================================================================
// PART 4 — THE C WE VENDOR (the blind spot `cargo audit` cannot see)
// ===========================================================================
/**
 * WHY THIS EXISTS
 * ---------------
 * `cargo audit` matches RustSec advisories against *crate* versions in
 * `Cargo.lock`. Four crates in our graph compile C/C++/assembly from bundled
 * source, and a CVE in any of that C is invisible to every gate we have:
 *
 *   libgit2-sys 0.18.7+1.9.6  -> libgit2 1.9.6      (C)      ships on macOS
 *   aws-lc-sys  0.43.0        -> aws-lc  5.2.0      (C + asm) ships on macOS
 *   ring        0.17.14       -> BoringSSL-derived  (C + asm) ships on macOS
 *   libz-sys    1.1.29        -> zlib    1.3.2      (C)      *fallback only* — see below
 *
 * That is uncomfortable specifically for libgit2, which parses
 * attacker-influenced data by design: `git_blame` walks history in whatever
 * repository the user opens, and "open a repo someone sent me" is a normal user
 * action. At the last review there was no known CVE for any of these versions
 * (OSV/GHSA queried — see each entry's `checked` field), so this check is about
 * the MECHANISM, not a live finding: it makes a silent version drift impossible.
 *
 * WHAT IS THE SOURCE OF TRUTH, AND WHY
 * ------------------------------------
 * `src-tauri/Cargo.lock` — the crate name + exact version — is the authority,
 * and the unpacked crate source is only corroboration. The reason is that
 * **crates.io releases are immutable**: `libgit2-sys 0.18.7+1.9.6` is one fixed
 * set of bytes forever, so pinning the crate version pins the exact C source we
 * compile, byte for byte. The lockfile is also committed, offline-readable, and
 * shows up in the diff of any change — the same properties that make a waiver's
 * `reviewBy` work. Nothing here queries a CVE database: the gate must run
 * offline and must not phone home. It forces a HUMAN re-check on change.
 *
 * On top of that we read the C version string out of the vendored headers when
 * the crate happens to be unpacked in the local cargo registry
 * (`LIBGIT2_VERSION`, `ZLIB_VERSION`, `AWSLC_VERSION_NUMBER_STRING`). That is
 * the human-readable label a reviewer needs in order to search OSV, and it
 * catches the one thing the crate version alone cannot: a `-sys` crate whose
 * `+build.metadata` lies about the C it carries. It is corroboration, never the
 * authority — a fresh CI checkout has no unpacked registry, and failing there
 * would be a permanently-red gate.
 *
 * WHY THE WATCH LIST IS DERIVED, NOT HAND-WRITTEN
 * ----------------------------------------------
 * A hand-written list of "the C we know about" cannot notice a *new* C library
 * arriving. So the set under review is computed from the lockfile: every crate
 * that depends on `cc` or `cmake` is a crate that runs a compiler at build time.
 * At the last review exactly 9 of 538 crates qualified, and any crate that
 * appears in that set without a reviewed entry FAILS the gate. That is the part
 * which makes this a control rather than a comment.
 *
 * KNOWN HOLE, STATED RATHER THAN PAPERED OVER
 * -------------------------------------------
 * `libz-sys 1.1.29` does NOT compile its bundled zlib 1.3.2 on macOS or Linux.
 * Read its `build.rs`: unless the target is MSVC/mingw or static linking is
 * forced, it runs a `-lz` smoke-compile and, if that succeeds, links the
 * **system** zlib instead. On a macOS build host that is the SDK's zlib (**1.2.12** at review) —
 * an older library than the bundled one, whose version is a property of the
 * build host and cannot be pinned by our lockfile at all. The runner therefore
 * PRINTS the host zlib version (informational, never blocking: failing on it
 * would turn the gate red on any machine with a different Xcode) while the
 * enforced check covers the bundled fallback that MSVC/mingw builds do compile.
 */

/**
 * Build-time crates whose presence in another crate's dependency list means
 * "this crate invokes a C/C++ compiler". `cc` is the compiler driver; `cmake`
 * drives an out-of-tree build (and itself depends on `cc`).
 */
export const NATIVE_BUILD_MARKERS = ["cc", "cmake"];

/**
 * Reviewed, dated inventory of every crate in the lockfile that compiles native
 * code. ONE entry per crate. The gate fails on any drift from these versions,
 * and on any native-code crate that has no entry here.
 *
 * Fields:
 *   crate/crateVersion — the lockfile identity; the authority (immutable on crates.io).
 *   library            — human label for the C actually being compiled.
 *   cVersion           — the upstream C version, or `null` when the crate carries
 *                        no separate upstream version string (then the crate
 *                        version IS the identity and only it is compared).
 *   probe              — where to corroborate `cVersion` inside the unpacked
 *                        crate: `{ file, macro }`, read as a C `#define`.
 *   ships              — is this C in the shipped macOS binary?
 *   reviewedOn/By      — when a human last looked, and in which review.
 *   checked            — what was actually checked. Not decoration: this is the
 *                        text the next reviewer diffs their own findings against.
 */
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

/**
 * Split a `Cargo.lock` into its `[[package]]` records.
 *
 * A narrow reader rather than a TOML dependency on purpose: this script must run
 * in CI before anything is installed or built, and Cargo.lock is a
 * machine-generated file with a fixed shape (`name`, `version`, `source`,
 * `checksum`, and an optional `dependencies` array of `"name"` or
 * `"name version"` strings).
 *
 * @returns {{name: string, version: string, deps: string[]}[]}
 */
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

/**
 * The crates that run a C/C++ compiler at build time: those depending on `cc`
 * or `cmake`. Derived from the lockfile so a NEW native-code dependency shows up
 * without anyone remembering to add it.
 *
 * Deliberately an over-approximation (it does not ask whether the crate is in
 * the macOS runtime graph, nor whether the dependency is a build-dependency).
 * Over-approximating costs one reviewed line per crate; under-approximating
 * costs a missed CVE feed.
 *
 * @returns {{name: string, version: string}[]} sorted by name, for stable output
 */
export function nativeCodeCrates(packages, markers = NATIVE_BUILD_MARKERS) {
  const marker = new Set(markers);
  return (Array.isArray(packages) ? packages : [])
    .filter((pkg) => pkg && Array.isArray(pkg.deps) && pkg.deps.some((d) => marker.has(d)))
    .map((pkg) => ({ name: pkg.name, version: pkg.version }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Read a C string `#define` (`#define NAME "value"`) out of header source.
 * Returns null when the macro is absent or is not a string literal — never a
 * guess, because a wrong version here is worse than an honest "unknown".
 */
export function parseCMacroString(source, macro) {
  if (typeof source !== "string" || typeof macro !== "string" || macro === "") return null;
  const escaped = macro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+${escaped}[ \\t]+"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

/**
 * The libgit2 version encoded in `libgit2-sys`'s own version string. The `-sys`
 * convention is `<crate semver>+<vendored C version>`, so `0.18.7+1.9.6` means
 * libgit2 1.9.6. Used as a second, header-independent reading of the same fact.
 */
export function versionFromBuildMetadata(crateVersion) {
  if (typeof crateVersion !== "string") return null;
  const plus = crateVersion.indexOf("+");
  if (plus === -1 || plus === crateVersion.length - 1) return null;
  return crateVersion.slice(plus + 1);
}

/**
 * THE DECISION FUNCTION for part 4 — pure, so it is tested against literal
 * fixtures instead of against whatever happens to be unpacked in the local
 * cargo registry today.
 *
 * @param {object} args
 * @param {Array}  args.detected  `{crate, crateVersion, cVersion, cVersionSource}` per
 *                                native-code crate found in the lockfile.
 * @param {Array}  args.reviewed  entries from `REVIEWED_VENDORED_C`.
 * @returns {{fail: boolean, reasons: string[], matched: object[], unverified: object[],
 *            absent: object[], notes: string[]}}
 *   `matched`    — crate version and C version both agree with the review.
 *   `unverified` — crate version agrees; the C version could not be read (no
 *                  unpacked crate source). Passes, loudly noted.
 *   `absent`     — a reviewed crate that is not in the lockfile at all: not
 *                  vendored in this configuration. Passes, reported, so a
 *                  removed dependency's stale entry gets cleaned up rather than
 *                  sitting there pretending to guard something.
 */
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

// ---------------------------------------------------------------------------
// Runner. Everything below is I/O; the judgement lives in `classify` and
// `classifyVendoredC` above.
// ---------------------------------------------------------------------------

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

/**
 * Locate an unpacked crate. Resolved from the EXACT `<name>-<version>` directory
 * name, never a glob: a local registry can hold aws-lc-sys 0.40.0, 0.41.0 and 0.43.0
 * unpacked side by side, and a glob would happily read the version we are not
 * building.
 */
function unpackedCrateDir(name, version, roots) {
  for (const root of roots) {
    const dir = path.join(root, `${name}-${version}`);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Build the `detected` list for `classifyVendoredC` from what is actually on
 * disk: the committed lockfile (authority) plus the unpacked crate sources
 * (corroboration, when present).
 */
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

/**
 * The zlib the linker will actually pick on macOS/Linux (see the long comment
 * above `REVIEWED_VENDORED_C`). Informational ONLY: its version is a property of
 * the build host's SDK, so making the gate depend on it would turn it red on any
 * machine with a different Xcode — a permanently-red gate.
 */
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

/**
 * Run one `npm audit --json` variant. npm exits NON-ZERO whenever it finds
 * anything, so the exit code carries no information we want — the JSON does.
 * A non-zero exit is therefore normal, and only an unparseable payload is a
 * crash.
 */
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

  // --- 3. Rust. cargo audit already implements this exact policy (fails on
  // vulnerabilities, warns on the allowed unmaintained/unsound set), so it is
  // run verbatim and its verdict propagated. Nothing here counts its warnings:
  // that number moves with every Tauri/git2 bump.
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
