/** Decision logic only, on hand-written `npm audit --json`-shaped fixtures: a live-count assertion
 * would go red whenever an advisory is published. Literal expectations only. */

import { describe, it, expect } from "vitest";

import {
  classify,
  collectAdvisories,
  advisoryFromVia,
  isOverdue,
  WAIVERS,
  EXPIRY_POLICY,
  classifyVendoredC,
  nativeCodeCrates,
  parseCargoLockPackages,
  parseCMacroString,
  versionFromBuildMetadata,
  NATIVE_BUILD_MARKERS,
  REVIEWED_VENDORED_C,
} from "./audit.mjs";

// ---------------------------------------------------------------------------
// Fixture builders — the minimum of npm's report shape that `classify` reads.
// ---------------------------------------------------------------------------

/** An `npm audit --json` payload with no findings. */
function cleanReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 205, dev: 755, optional: 71, peer: 6, peerOptional: 0, total: 960 },
    },
  };
}

/** The gate reads the GHSA id from the advisory url. */
function advisoryEntry({ name, severity, ghsa, title, source = 1124334 }) {
  return {
    name,
    severity,
    isDirect: false,
    via: [
      {
        source,
        name,
        dependency: name,
        title,
        url: `https://github.com/advisories/${ghsa}`,
        severity,
        cwe: ["CWE-400"],
        cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" },
        range: "<=5.0.7",
      },
    ],
    effects: [],
    range: "<=5.0.7",
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
}

/** A purely transitive entry: `via` is package names, no advisory of its own. */
function transitiveEntry({ name, severity, via }) {
  return {
    name,
    severity,
    isDirect: false,
    via,
    effects: [],
    range: "*",
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
}

function reportWith(entries) {
  const report = cleanReport();
  let high = 0;
  let critical = 0;
  let moderate = 0;
  for (const entry of entries) {
    report.vulnerabilities[entry.name] = entry;
    if (entry.severity === "high") high += 1;
    if (entry.severity === "critical") critical += 1;
    if (entry.severity === "moderate") moderate += 1;
  }
  report.metadata.vulnerabilities = {
    info: 0,
    low: 0,
    moderate,
    high,
    critical,
    total: high + critical + moderate,
  };
  return report;
}

const BRACE_EXPANSION = () =>
  advisoryEntry({
    name: "brace-expansion",
    severity: "high",
    ghsa: "GHSA-mh99-v99m-4gvg",
    title: "brace-expansion: DoS via unbounded expansion length",
  });

/** The single seeded waiver, restated literally so the tests don't read it from the module. */
const WAIVER_FIXTURE = [
  {
    id: "GHSA-mh99-v99m-4gvg",
    package: "brace-expansion",
    severity: "high",
    title: "brace-expansion: DoS via unbounded expansion",
    scope: "dev-only",
    whyUnfixable: "no clean version with a compatible API",
    whyAcceptable: "glob patterns come only from our own committed config",
    reviewBy: "2026-10-29",
    reviewedOn: "2026-07-29",
    reviewedBy: "test fixture",
  },
];

const NOW = new Date("2026-07-29T12:00:00Z");

// ---------------------------------------------------------------------------

describe("advisoryFromVia", () => {
  it("reads the GHSA id out of the advisory url", () => {
    const advisory = advisoryFromVia({
      source: 1124334,
      name: "brace-expansion",
      title: "DoS via unbounded expansion",
      url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
      severity: "high",
    });
    expect(advisory).toEqual({
      id: "GHSA-mh99-v99m-4gvg",
      severity: "high",
      name: "brace-expansion",
      title: "DoS via unbounded expansion",
      url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
    });
  });

  it("falls back to npm's numeric source when there is no GHSA url", () => {
    const advisory = advisoryFromVia({ source: 987654, name: "left-pad", severity: "critical" });
    expect(advisory.id).toBe("npm-advisory-987654");
    expect(advisory.severity).toBe("critical");
    expect(advisory.title).toBe("(no title)");
  });

  it("returns null for a transitive string entry (a package name, not an advisory)", () => {
    expect(advisoryFromVia("minimatch")).toBe(null);
    expect(advisoryFromVia(undefined)).toBe(null);
    expect(advisoryFromVia({ name: "no-id-here" })).toBe(null);
  });
});

describe("collectAdvisories", () => {
  it("collapses many transitive paths onto ONE advisory id", () => {
    // The real shape of this repo's finding: one root advisory, many packages
    // reported at high severity because they merely depend on it.
    const report = reportWith([
      BRACE_EXPANSION(),
      transitiveEntry({ name: "minimatch", severity: "high", via: ["brace-expansion"] }),
      transitiveEntry({ name: "glob", severity: "high", via: ["minimatch"] }),
      transitiveEntry({ name: "mocha", severity: "high", via: ["glob", "minimatch"] }),
      transitiveEntry({ name: "@wdio/mocha-framework", severity: "high", via: ["mocha"] }),
    ]);
    const { advisories, unattributedBlocking } = collectAdvisories(report);
    expect([...advisories.keys()]).toEqual(["GHSA-mh99-v99m-4gvg"]);
    expect(advisories.get("GHSA-mh99-v99m-4gvg").packages).toEqual(["brace-expansion"]);
    expect(unattributedBlocking).toBe(0);
  });

  it("flags high-severity packages whose advisory cannot be identified", () => {
    // npm says "high" but no `via` object explains it, and the package it points
    // at is not in the report either — the report shape moved under us.
    const report = reportWith([
      transitiveEntry({ name: "mystery", severity: "high", via: ["something-else"] }),
    ]);
    expect(collectAdvisories(report).unattributedBlocking).toBe(1);
  });

  it("does not let one IDENTIFIED advisory mask an unidentifiable one", () => {
    // Counted per package: brace-expansion is fully attributed, `mystery` is not,
    // so the report still carries one unattributed blocking finding.
    const report = reportWith([
      BRACE_EXPANSION(),
      transitiveEntry({ name: "mystery", severity: "high", via: ["not-in-this-report"] }),
    ]);
    const { advisories, unattributedBlocking } = collectAdvisories(report);
    expect([...advisories.keys()]).toEqual(["GHSA-mh99-v99m-4gvg"]);
    expect(unattributedBlocking).toBe(1);
  });

  it("counts a transitive chain as explained, not as unattributed", () => {
    const report = reportWith([
      BRACE_EXPANSION(),
      transitiveEntry({ name: "minimatch", severity: "high", via: ["brace-expansion"] }),
    ]);
    expect(collectAdvisories(report).unattributedBlocking).toBe(0);
  });
});

describe("classify — production tree (zero tolerance)", () => {
  it("FAILS on a production high/critical even when that exact id is waived", () => {
    const result = classify({
      prodAudit: reportWith([BRACE_EXPANSION()]),
      devAudit: reportWith([BRACE_EXPANSION()]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("PRODUCTION dependency brace-expansion");
    expect(result.reasons[0]).toContain("GHSA-mh99-v99m-4gvg");
    expect(result.reasons[0]).toContain("a waiver never applies to code that ships");
    // The dev side still recognises it as waived — the prod failure is separate.
    expect(result.waived.length).toBe(1);
  });

  it("FAILS on an unwaived production critical", () => {
    const evil = advisoryEntry({
      name: "markdown-it",
      severity: "critical",
      ghsa: "GHSA-aaaa-bbbb-cccc",
      title: "RCE in the markdown renderer",
    });
    const result = classify({
      prodAudit: reportWith([evil]),
      devAudit: reportWith([evil]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.prodBlocking.map((a) => a.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(result.reasons.some((r) => r.includes("PRODUCTION dependency markdown-it"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("Unwaived critical advisory GHSA-aaaa-bbbb-cccc"))).toBe(
      true,
    );
  });

  it("attributes each failure to its own tier (prod vs dev), never to both", () => {
    // A prod-only finding must not make the dev row read FAIL, and vice versa —
    // the summary is the part a human actually reads.
    const prodOnly = classify({
      prodAudit: reportWith([
        advisoryEntry({
          name: "dompurify",
          severity: "high",
          ghsa: "GHSA-2222-3333-4444",
          title: "mXSS bypass",
        }),
      ]),
      devAudit: cleanReport(),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(prodOnly.prodReasons.length).toBe(1);
    expect(prodOnly.devReasons).toEqual([]);
    expect(prodOnly.reasons).toEqual(prodOnly.prodReasons);

    const devOnly = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([
        advisoryEntry({
          name: "esbuild",
          severity: "high",
          ghsa: "GHSA-1111-2222-3333",
          title: "dev server responds to any request",
        }),
      ]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(devOnly.prodReasons).toEqual([]);
    expect(devOnly.devReasons.length).toBe(1);
  });

  it("FAILS when the production report has unattributable high severity", () => {
    const result = classify({
      prodAudit: reportWith([
        transitiveEntry({ name: "mystery", severity: "high", via: ["gone"] }),
      ]),
      devAudit: cleanReport(),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.reasons[0]).toContain("PRODUCTION audit reported 1 package(s)");
  });
});

describe("classify — full tree (waiver-aware)", () => {
  it("PASSES a dev-only advisory that is on the waiver list, and reports it as waived", () => {
    const result = classify({
      prodAudit: cleanReport(),
      // A complete chain, as npm actually emits it: every string in a `via`
      // names another entry of the same report (verified against this repo's
      // real `npm audit --json` output — 0 dangling via-strings).
      devAudit: reportWith([
        BRACE_EXPANSION(),
        transitiveEntry({ name: "minimatch", severity: "high", via: ["brace-expansion"] }),
        transitiveEntry({ name: "glob", severity: "high", via: ["minimatch"] }),
        transitiveEntry({ name: "mocha", severity: "high", via: ["glob"] }),
      ]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.waived.length).toBe(1);
    expect(result.waived[0].waiver.id).toBe("GHSA-mh99-v99m-4gvg");
    expect(result.waived[0].advisory.name).toBe("brace-expansion");
    expect(result.overdue).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("FAILS on a dev advisory that is NOT on the waiver list", () => {
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([
        advisoryEntry({
          name: "esbuild",
          severity: "high",
          ghsa: "GHSA-1111-2222-3333",
          title: "dev server responds to any request",
        }),
      ]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.waived).toEqual([]);
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("Unwaived high advisory GHSA-1111-2222-3333 in esbuild");
  });

  it("FAILS when only ONE of two dev advisories is waived (a waiver is per-id, not per-run)", () => {
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([
        BRACE_EXPANSION(),
        advisoryEntry({
          name: "tar-fs",
          severity: "high",
          ghsa: "GHSA-4444-5555-6666",
          title: "path traversal on extract",
        }),
      ]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.waived.length).toBe(1);
    expect(result.waived[0].waiver.id).toBe("GHSA-mh99-v99m-4gvg");
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("GHSA-4444-5555-6666");
  });

  it("FAILS on a SECOND advisory in the very package a waiver covers", () => {
    // This is the point of keying on the advisory id rather than the package
    // name: `brace-expansion` being waived must not blanket-cover a new,
    // possibly exploitable finding in `brace-expansion`.
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([
        BRACE_EXPANSION(),
        advisoryEntry({
          name: "brace-expansion-second",
          severity: "critical",
          ghsa: "GHSA-9999-8888-7777",
          title: "brace-expansion: arbitrary code execution",
          source: 2000001,
        }),
      ]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.reasons[0]).toContain("Unwaived critical advisory GHSA-9999-8888-7777");
  });

  it("FAILS when the full-tree report has unattributable high severity, even next to a waived one", () => {
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([
        BRACE_EXPANSION(),
        transitiveEntry({ name: "mystery", severity: "critical", via: ["vanished"] }),
      ]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.waived.length).toBe(1);
    expect(result.devReasons.length).toBe(1);
    expect(result.devReasons[0]).toContain("Full audit reported 1 package(s)");
  });

  it("does not block on findings below high severity, but reports them", () => {
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([
        advisoryEntry({
          name: "cookie",
          severity: "moderate",
          ghsa: "GHSA-7777-6666-5555",
          title: "accepts out-of-bounds characters",
        }),
      ]),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(false);
    expect(result.notes.length).toBe(1);
    expect(result.notes[0]).toContain("1 advisory/advisories below high severity");
    expect(result.notes[0]).toContain("GHSA-7777-6666-5555 cookie (moderate)");
  });
});

describe("classify — waiver hygiene", () => {
  it("warns but PASSES when a waiver is past its reviewBy date", () => {
    // Documented decision (EXPIRY_POLICY = "warn"): an overdue waiver is
    // documentation debt, not a change in the dependency tree. Failing on a
    // calendar date would recreate the permanently-red gate this replaced.
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([BRACE_EXPANSION()]),
      waivers: WAIVER_FIXTURE,
      now: new Date("2026-12-25T00:00:00Z"),
    });
    expect(result.fail).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.overdue.length).toBe(1);
    expect(result.overdue[0].id).toBe("GHSA-mh99-v99m-4gvg");
  });

  it("declares the expiry policy explicitly, so the choice is auditable", () => {
    expect(EXPIRY_POLICY).toBe("warn");
  });

  it("reports a waiver that no longer matches anything as stale", () => {
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: cleanReport(),
      waivers: WAIVER_FIXTURE,
      now: NOW,
    });
    expect(result.fail).toBe(false);
    expect(result.stale.length).toBe(1);
    expect(result.stale[0].id).toBe("GHSA-mh99-v99m-4gvg");
  });

  it("treats an unparseable reviewBy date as overdue", () => {
    expect(isOverdue({ reviewBy: "not-a-date" }, NOW)).toBe(true);
    expect(isOverdue({ reviewBy: "2026-10-29" }, NOW)).toBe(false);
    expect(isOverdue({ reviewBy: "2026-10-29" }, new Date("2026-10-30T00:00:00Z"))).toBe(true);
    // The boundary: the review date itself is still in time.
    expect(isOverdue({ reviewBy: "2026-10-29" }, new Date("2026-10-29T23:00:00Z"))).toBe(false);
  });
});

describe("classify — clean and malformed inputs", () => {
  it("PASSES when both trees are empty", () => {
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: cleanReport(),
      waivers: [],
      now: NOW,
    });
    expect(result).toMatchObject({
      fail: false,
      reasons: [],
      waived: [],
      overdue: [],
      stale: [],
      notes: [],
      prodBlocking: [],
      devBlocking: [],
    });
  });

  it("FAILS LOUDLY on a missing payload rather than reading silence as safety", () => {
    const result = classify({ prodAudit: undefined, devAudit: undefined, waivers: [], now: NOW });
    expect(result.fail).toBe(true);
    expect(result.reasons.length).toBe(2);
    expect(result.reasons[0]).toContain("production audit: audit payload is not a JSON object");
    expect(result.reasons[1]).toContain("full (dev-inclusive) audit: audit payload is not a JSON object");
  });

  it("FAILS on a payload with no vulnerabilities field", () => {
    const result = classify({
      prodAudit: { metadata: { vulnerabilities: {} } },
      devAudit: cleanReport(),
      waivers: [],
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.reasons[0]).toContain('has no "vulnerabilities" field');
  });

  it("FAILS on a payload with no metadata counts", () => {
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: { vulnerabilities: {} },
      waivers: [],
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.reasons[0]).toContain('has no "metadata.vulnerabilities" counts');
  });

  it("FAILS on wrongly-typed payloads (array, string, wrong vulnerabilities type)", () => {
    expect(classify({ prodAudit: [], devAudit: cleanReport() }).reasons[0]).toContain("got array");
    expect(classify({ prodAudit: "boom", devAudit: cleanReport() }).reasons[0]).toContain(
      "got string",
    );
    expect(classify({ prodAudit: null, devAudit: cleanReport() }).reasons[0]).toContain("got null");
    expect(
      classify({ prodAudit: { vulnerabilities: [], metadata: {} }, devAudit: cleanReport() })
        .reasons[0],
    ).toContain('"vulnerabilities" is not an object');
  });

  it("FAILS when called with no arguments at all", () => {
    expect(classify().fail).toBe(true);
  });
});

describe("the shipped waiver list", () => {
  it("holds NO entries", () => {
    // Pinned so a new waiver, which is a decision, must show in this test's diff.
    expect(WAIVERS.map((w) => w.id)).toEqual([]);
  });

  it("never waives two DIFFERENT advisories under one id, nor one id twice", () => {
    // The list is keyed on the advisory id, so a duplicate id would silently make
    // one entry's justification unreachable — and with two extract-zip entries now
    // sitting side by side, a copy-paste is the likely way that happens.
    const ids = WAIVERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry is fully justified and dated, retired or not", () => {
    for (const w of WAIVERS) {
      expect(w.severity).toBe("high");
      expect(w.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(w.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Every justification field must be present and substantive — an empty
      // "why" is how a waiver list turns into an ignore list.
      for (const field of ["title", "scope", "whyUnfixable", "whyAcceptable", "reviewedBy"]) {
        expect(typeof w[field]).toBe("string");
        expect(w[field].length).toBeGreaterThan(20);
      }
      // The waiver must be dev-scoped: the prod tree never gets one.
      expect(w.scope).toContain("dev-only");
    }
  });

  it("is keyed by GHSA id, never by bare package name or severity", () => {
    for (const w of WAIVERS) {
      expect(w.id).toMatch(/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    }
  });
});

// ===========================================================================
// PART 4 — the vendored-C check (literals only: the cargo registry can change mid-test)
// ===========================================================================

/** A reviewed entry whose C version can be read from a header. */
const REVIEWED_LIBGIT2 = {
  crate: "libgit2-sys",
  crateVersion: "0.18.7+1.9.6",
  library: "libgit2 (C)",
  cVersion: "1.9.6",
  probe: { file: "libgit2/include/git2/version.h", macro: "LIBGIT2_VERSION" },
  ships: true,
  reviewedOn: "2026-07-29",
  reviewedBy: "test fixture",
  checked: "OSV queried for libgit2 1.9.6 on 2026-07-29: zero entries.",
};

/** A reviewed entry with no upstream version string — the crate version IS the identity. */
const REVIEWED_RING = {
  crate: "ring",
  crateVersion: "0.17.14",
  library: "ring (C + assembly)",
  cVersion: null,
  probe: null,
  ships: true,
  reviewedOn: "2026-07-29",
  reviewedBy: "test fixture",
  checked: "OSV queried for ring 0.17.14 on 2026-07-29: zero entries.",
};

describe("parseCargoLockPackages", () => {
  // Real Cargo.lock shape with both naive-reader traps: a versioned `dependencies` entry and a
  // trailing top-level table that must not bleed into the last package.
  const LOCK = `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "cc"
version = "1.2.49"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaa"
dependencies = [
 "shlex",
]

[[package]]
name = "libgit2-sys"
version = "0.18.7+1.9.6"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "bbbb"
dependencies = [
 "cc",
 "libc 0.2.180",
 "libz-sys",
]

[[package]]
name = "serde"
version = "1.0.228"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "cccc"

[metadata]
"checksum something" = "dddd"
`;

  it("reads name, version and flattened dependency names", () => {
    expect(parseCargoLockPackages(LOCK)).toEqual([
      { name: "cc", version: "1.2.49", deps: ["shlex"] },
      { name: "libgit2-sys", version: "0.18.7+1.9.6", deps: ["cc", "libc", "libz-sys"] },
      { name: "serde", version: "1.0.228", deps: [] },
    ]);
  });

  it("returns an empty list for non-string or empty input, so the runner can fail loudly", () => {
    expect(parseCargoLockPackages(undefined)).toEqual([]);
    expect(parseCargoLockPackages("")).toEqual([]);
    expect(parseCargoLockPackages("version = 4\n")).toEqual([]);
  });

  it("skips a malformed block rather than inventing a package", () => {
    expect(parseCargoLockPackages('[[package]]\nversion = "1.0.0"\n')).toEqual([]);
    expect(parseCargoLockPackages('[[package]]\nname = "no-version"\n')).toEqual([]);
  });
});

describe("nativeCodeCrates", () => {
  it("selects exactly the crates that depend on cc or cmake", () => {
    const packages = [
      { name: "serde", version: "1.0.228", deps: ["serde_derive"] },
      { name: "libgit2-sys", version: "0.18.7+1.9.6", deps: ["cc", "libc"] },
      { name: "aws-lc-sys", version: "0.43.0", deps: ["cmake", "dunce"] },
      { name: "cc", version: "1.2.49", deps: ["shlex"] },
    ];
    expect(nativeCodeCrates(packages)).toEqual([
      { name: "aws-lc-sys", version: "0.43.0" },
      { name: "libgit2-sys", version: "0.18.7+1.9.6" },
    ]);
  });

  it("sorts by name so the gate's output is stable across runs", () => {
    const packages = [
      { name: "zzz-sys", version: "1.0.0", deps: ["cc"] },
      { name: "aaa-sys", version: "2.0.0", deps: ["cc"] },
      { name: "mmm-sys", version: "3.0.0", deps: ["cc"] },
    ];
    expect(nativeCodeCrates(packages).map((c) => c.name)).toEqual(["aaa-sys", "mmm-sys", "zzz-sys"]);
  });

  it("tolerates garbage entries instead of throwing mid-gate", () => {
    expect(nativeCodeCrates(undefined)).toEqual([]);
    expect(nativeCodeCrates([null, { name: "x", version: "1" }, { name: "y", version: "1", deps: "cc" }])).toEqual(
      [],
    );
  });

  it("declares cc and cmake as the markers, so the derivation is auditable", () => {
    expect(NATIVE_BUILD_MARKERS).toEqual(["cc", "cmake"]);
  });
});

describe("parseCMacroString", () => {
  const VERSION_H = `/* libgit2 version */
#ifndef INCLUDE_git_version_h__
#define INCLUDE_git_version_h__

#define LIBGIT2_VERSION           "1.9.6"
#define LIBGIT2_VERSION_MAJOR      1
#define LIBGIT2_VERSION_MINOR      9
#endif
`;

  it("reads a string #define, ignoring surrounding whitespace", () => {
    expect(parseCMacroString(VERSION_H, "LIBGIT2_VERSION")).toBe("1.9.6");
    expect(parseCMacroString('#  define ZLIB_VERSION "1.3.2"\n', "ZLIB_VERSION")).toBe("1.3.2");
    expect(parseCMacroString('\t#define AWSLC_VERSION_NUMBER_STRING "5.2.0"\n', "AWSLC_VERSION_NUMBER_STRING")).toBe(
      "5.2.0",
    );
  });

  it("returns null rather than guessing when the macro is absent or not a string", () => {
    expect(parseCMacroString(VERSION_H, "LIBGIT2_VERSION_MAJOR")).toBe(null);
    expect(parseCMacroString(VERSION_H, "ZLIB_VERSION")).toBe(null);
    expect(parseCMacroString(undefined, "LIBGIT2_VERSION")).toBe(null);
    expect(parseCMacroString(VERSION_H, "")).toBe(null);
  });

  it("does not match a macro whose name merely starts with the requested one", () => {
    // Guards against `LIBGIT2_VERSION` accidentally reading a
    // `LIBGIT2_VERSION_SUFFIX "-rc1"` line and reporting "-rc1" as the version.
    expect(parseCMacroString('#define LIBGIT2_VERSION_SUFFIX "-rc1"\n', "LIBGIT2_VERSION")).toBe(null);
  });

  it("does not treat a commented-out define as a definition", () => {
    expect(parseCMacroString('// #define ZLIB_VERSION "9.9.9"\n', "ZLIB_VERSION")).toBe(null);
  });
});

describe("versionFromBuildMetadata", () => {
  it("reads the vendored C version out of a -sys crate's +build metadata", () => {
    expect(versionFromBuildMetadata("0.18.7+1.9.6")).toBe("1.9.6");
    expect(versionFromBuildMetadata("1.1.29+zlib1.3.2")).toBe("zlib1.3.2");
  });

  it("returns null when there is no build metadata to read", () => {
    expect(versionFromBuildMetadata("0.17.14")).toBe(null);
    expect(versionFromBuildMetadata("0.18.7+")).toBe(null);
    expect(versionFromBuildMetadata(undefined)).toBe(null);
  });
});

describe("classifyVendoredC", () => {
  it("PASSES when every detected native crate matches its reviewed version", () => {
    const result = classifyVendoredC({
      detected: [
        {
          crate: "libgit2-sys",
          crateVersion: "0.18.7+1.9.6",
          cVersion: "1.9.6",
          cVersionSource: "LIBGIT2_VERSION in libgit2/include/git2/version.h",
        },
        { crate: "ring", crateVersion: "0.17.14", cVersion: null, cVersionSource: "no probe configured" },
      ],
      reviewed: [REVIEWED_LIBGIT2, REVIEWED_RING],
    });
    expect(result.fail).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.matched.map((m) => m.entry.crate)).toEqual(["libgit2-sys", "ring"]);
    expect(result.unverified).toEqual([]);
    expect(result.absent).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("FAILS on a C-version drift, naming BOTH the detected and the reviewed version", () => {
    const result = classifyVendoredC({
      detected: [
        {
          crate: "libgit2-sys",
          crateVersion: "0.18.7+1.9.6",
          cVersion: "1.10.0",
          cVersionSource: "LIBGIT2_VERSION in libgit2/include/git2/version.h",
        },
      ],
      reviewed: [REVIEWED_LIBGIT2],
    });
    expect(result.fail).toBe(true);
    expect(result.matched).toEqual([]);
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("VENDORED C DRIFT");
    expect(result.reasons[0]).toContain("libgit2 (C)");
    expect(result.reasons[0]).toContain("reports 1.10.0");
    expect(result.reasons[0]).toContain("the reviewed version is 1.9.6");
    expect(result.reasons[0]).toContain("reviewed 2026-07-29");
  });

  it("FAILS on a crate-version drift, naming BOTH versions", () => {
    const result = classifyVendoredC({
      detected: [
        {
          crate: "libgit2-sys",
          crateVersion: "0.19.0+1.10.1",
          cVersion: "1.10.1",
          cVersionSource: "LIBGIT2_VERSION in libgit2/include/git2/version.h",
        },
      ],
      reviewed: [REVIEWED_LIBGIT2],
    });
    expect(result.fail).toBe(true);
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("crate libgit2-sys is now 0.19.0+1.10.1");
    expect(result.reasons[0]).toContain("the reviewed version is 0.18.7+1.9.6");
    expect(result.reasons[0]).toContain("nobody has checked it for CVEs");
  });

  it("FAILS on a crate-version drift even when the C version still matches", () => {
    // A re-release of the same C under a new crate version is still new code
    // (new build.rs, new patches) that nobody has read.
    const result = classifyVendoredC({
      detected: [
        {
          crate: "libgit2-sys",
          crateVersion: "0.18.8+1.9.6",
          cVersion: "1.9.6",
          cVersionSource: "LIBGIT2_VERSION in libgit2/include/git2/version.h",
        },
      ],
      reviewed: [REVIEWED_LIBGIT2],
    });
    expect(result.fail).toBe(true);
    expect(result.reasons[0]).toContain("crate libgit2-sys is now 0.18.8+1.9.6");
  });

  it("FAILS on a native-code crate that has no reviewed entry at all", () => {
    // The case that makes this a control rather than a comment: a NEW C library
    // arriving in the graph must turn the gate red.
    const result = classifyVendoredC({
      detected: [
        {
          crate: "libgit2-sys",
          crateVersion: "0.18.7+1.9.6",
          cVersion: "1.9.6",
          cVersionSource: "LIBGIT2_VERSION in libgit2/include/git2/version.h",
        },
        { crate: "openssl-sys", crateVersion: "0.9.109", cVersion: null, cVersionSource: "no probe configured" },
      ],
      reviewed: [REVIEWED_LIBGIT2],
    });
    expect(result.fail).toBe(true);
    expect(result.matched.map((m) => m.entry.crate)).toEqual(["libgit2-sys"]);
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("UNREVIEWED native-code crate openssl-sys 0.9.109");
    expect(result.reasons[0]).toContain("depends on cc or cmake");
    expect(result.reasons[0]).toContain("REVIEWED_VENDORED_C");
  });

  it("PASSES but reports UNVERIFIED when the C version cannot be read and the crate version matches", () => {
    // A fresh CI checkout has no unpacked cargo registry. Failing there would be
    // a permanently-red gate; the crate version still pins the
    // exact C source bytes because a crates.io release is immutable.
    const result = classifyVendoredC({
      detected: [
        {
          crate: "libgit2-sys",
          crateVersion: "0.18.7+1.9.6",
          cVersion: null,
          cVersionSource: "crate source not unpacked in the local cargo registry",
        },
      ],
      reviewed: [REVIEWED_LIBGIT2],
    });
    expect(result.fail).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.matched).toEqual([]);
    expect(result.unverified.length).toBe(1);
    expect(result.unverified[0].entry.crate).toBe("libgit2-sys");
    expect(result.notes.length).toBe(1);
    expect(result.notes[0]).toContain("could not be read");
    expect(result.notes[0]).toContain("crate source not unpacked in the local cargo registry");
    expect(result.notes[0]).toContain("the reviewed C version is 1.9.6");
  });

  it("PASSES a reviewed crate that is absent from the lockfile, and says so", () => {
    // Documented behaviour for "not vendored / not found": report, never fail.
    // libgit2-sys is not vendored on every platform/config, and aws-lc-sys left
    // the lockfile the same day this check was written.
    const result = classifyVendoredC({
      detected: [],
      reviewed: [REVIEWED_LIBGIT2, REVIEWED_RING],
    });
    expect(result.fail).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.matched).toEqual([]);
    expect(result.absent.map((e) => e.crate)).toEqual(["libgit2-sys", "ring"]);
    expect(result.notes.length).toBe(2);
    expect(result.notes[0]).toContain("crate libgit2-sys is not in src-tauri/Cargo.lock");
    expect(result.notes[0]).toContain("not vendored in this configuration");
    expect(result.notes[1]).toContain("crate ring is not in src-tauri/Cargo.lock");
  });

  it("FAILS LOUDLY on an empty reviewed manifest rather than passing vacuously", () => {
    // "we watch no C libraries" and "no C libraries were found" must never look
    // the same from the outside.
    const empty = classifyVendoredC({ detected: [], reviewed: [] });
    expect(empty.fail).toBe(true);
    expect(empty.reasons.length).toBe(1);
    expect(empty.reasons[0]).toContain("REVIEWED_VENDORED_C) is empty or not a list");
    expect(empty.reasons[0]).toContain("refusing to pass a check that watches nothing");

    expect(classifyVendoredC({ detected: [], reviewed: undefined }).fail).toBe(true);
    expect(classifyVendoredC({ detected: [], reviewed: "MIT" }).fail).toBe(true);
    expect(classifyVendoredC().fail).toBe(true);
  });

  it("FAILS LOUDLY when the detected list could not be built", () => {
    const result = classifyVendoredC({ detected: null, reviewed: [REVIEWED_LIBGIT2] });
    expect(result.fail).toBe(true);
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("could not enumerate the native-code crates");
    expect(result.reasons[0]).toContain("got null");
    expect(classifyVendoredC({ detected: {}, reviewed: [REVIEWED_LIBGIT2] }).reasons[0]).toContain("got object");
  });

  it("matches a null-cVersion entry on the crate version alone", () => {
    // `ring` vendors a BoringSSL snapshot with no version string; the immutable
    // crate version is the identity. A drift there must still fail.
    const ok = classifyVendoredC({
      detected: [{ crate: "ring", crateVersion: "0.17.14", cVersion: null, cVersionSource: "no probe configured" }],
      reviewed: [REVIEWED_RING],
    });
    expect(ok.fail).toBe(false);
    expect(ok.matched.length).toBe(1);
    expect(ok.notes).toEqual([]);

    const drifted = classifyVendoredC({
      detected: [{ crate: "ring", crateVersion: "0.17.15", cVersion: null, cVersionSource: "no probe configured" }],
      reviewed: [REVIEWED_RING],
    });
    expect(drifted.fail).toBe(true);
    expect(drifted.reasons[0]).toContain("crate ring is now 0.17.15");
  });

  it("reports every problem, so one drift cannot hide behind another", () => {
    const result = classifyVendoredC({
      detected: [
        {
          crate: "libgit2-sys",
          crateVersion: "0.18.7+1.9.6",
          cVersion: "1.10.0",
          cVersionSource: "LIBGIT2_VERSION in libgit2/include/git2/version.h",
        },
        { crate: "ring", crateVersion: "0.17.15", cVersion: null, cVersionSource: "no probe configured" },
        { crate: "brotli-sys", crateVersion: "0.3.2", cVersion: null, cVersionSource: "no probe configured" },
      ],
      reviewed: [REVIEWED_LIBGIT2, REVIEWED_RING],
    });
    expect(result.fail).toBe(true);
    expect(result.reasons.length).toBe(3);
    expect(result.reasons[0]).toContain("reports 1.10.0");
    expect(result.reasons[1]).toContain("crate ring is now 0.17.15");
    expect(result.reasons[2]).toContain("UNREVIEWED native-code crate brotli-sys 0.3.2");
  });
});

describe("the shipped vendored-C manifest", () => {
  it("covers the four C libraries the dependency audit named, at the versions it reviewed", () => {
    const byCrate = new Map(REVIEWED_VENDORED_C.map((e) => [e.crate, e]));
    // Literal expectations, written by hand from the audit's measurements —
    // not read back from the manifest.
    expect(byCrate.get("libgit2-sys").crateVersion).toBe("0.18.7+1.9.6");
    expect(byCrate.get("libgit2-sys").cVersion).toBe("1.9.6");
    expect(byCrate.get("libgit2-sys").probe).toEqual({
      file: "libgit2/include/git2/version.h",
      macro: "LIBGIT2_VERSION",
    });
    // 1.1.31 → 1.1.33 (RUSTSEC-2026-0544: the bundled zlib 1.3.2 was affected; 1.4 is the fix).
    expect(byCrate.get("libz-sys").crateVersion).toBe("1.1.33");
    expect(byCrate.get("libz-sys").cVersion).toBe("1.4");
    expect(byCrate.get("libz-sys").probe).toEqual({ file: "src/zlib/zlib.h", macro: "ZLIB_VERSION" });
    expect(byCrate.get("aws-lc-sys").crateVersion).toBe("0.43.0");
    expect(byCrate.get("aws-lc-sys").cVersion).toBe("5.2.0");
    expect(byCrate.get("ring").crateVersion).toBe("0.17.14");
    // `ring` and the shim/tooling crates have no upstream version string to pin.
    expect(byCrate.get("ring").cVersion).toBe(null);
    expect(byCrate.get("ring").probe).toBe(null);
  });

  it("has one entry per crate, with no duplicates to disagree with each other", () => {
    const crates = REVIEWED_VENDORED_C.map((e) => e.crate);
    expect(crates.length).toBe(new Set(crates).size);
    expect([...crates].sort()).toEqual([
      "aws-lc-sys",
      "cmake",
      "embed-resource",
      "iana-time-zone-haiku",
      "libgit2-sys",
      "libz-sys",
      "objc2-exception-helper",
      "ring",
      "vswhom-sys",
    ]);
  });

  it("gives every entry a substantive, dated review note — the same bar the waivers meet", () => {
    // An entry with an empty `checked` is a rubber stamp, and a manifest of
    // rubber stamps is an ignore list wearing a lab coat.
    for (const entry of REVIEWED_VENDORED_C) {
      expect(typeof entry.library).toBe("string");
      expect(entry.library.length).toBeGreaterThan(5);
      expect(entry.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.reviewedBy).toBe("string");
      expect(entry.reviewedBy.length).toBeGreaterThan(20);
      expect(typeof entry.checked).toBe("string");
      expect(entry.checked.length).toBeGreaterThan(120);
      expect([true, false, "conditional"]).toContain(entry.ships);
      // A probe is only meaningful alongside a C version to compare it with.
      if (entry.probe === null) expect(entry.cVersion).toBe(null);
      else expect(typeof entry.cVersion).toBe("string");
    }
  });

  it("records for every shipped C library that a CVE database was actually queried", () => {
    // The whole point of the manifest: the gate cannot query OSV (it must work
    // offline), so the human must have, and must have written down that they did.
    for (const entry of REVIEWED_VENDORED_C) {
      if (entry.ships === false) continue;
      expect(entry.checked).toMatch(/OSV|GHSA|CVE/);
    }
  });
});

describe("classify — a retired waiver", () => {
  it("🔴 does NOT waive: the advisory came back, so a human must look again", () => {
    // A retired waiver must not silently re-apply when its advisory reappears: that would make a
    // waiver a permanent exemption.
    const retired = [{ ...WAIVER_FIXTURE[0], retired: true }];
    const result = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([BRACE_EXPANSION()]),
      waivers: retired,
      now: NOW,
    });
    expect(result.fail).toBe(true);
    expect(result.reasons.join(" ")).toContain("Unwaived high advisory GHSA-mh99-v99m-4gvg");
    expect(result.waived.length).toBe(0);
  });

  it("and the SAME waiver without the flag still waives — so the test pins `retired`, not a typo", () => {
    const live = classify({
      prodAudit: cleanReport(),
      devAudit: reportWith([BRACE_EXPANSION()]),
      waivers: [{ ...WAIVER_FIXTURE[0], retired: false }],
      now: NOW,
    });
    expect(live.fail).toBe(false);
    expect(live.waived.length).toBe(1);
  });
});
