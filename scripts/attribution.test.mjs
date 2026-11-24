/**
 * Tests for the third-party attribution generator (`scripts/attribution.mjs`).
 *
 * Same discipline as `audit.test.mjs`: the DECISIONS are pure functions and are
 * tested against literal, hand-written fixtures. Asserting on "the repo
 * currently has 202 production packages" would be a test that goes red the next
 * time anyone runs `npm install`, tells you nothing about whether the generator
 * is correct, and would train people to update the number instead of reading
 * the failure. Every expectation below is written out by hand — never read back
 * from the module under test.
 *
 * Runs under `npm test`: `vitest.config.ts`'s `test.include` covers
 * `scripts/**\/*.{test,spec}.mjs`. (A test outside that glob would silently
 * never run, which is worse than no test.)
 */

import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import {
  normalizeLicense,
  sniffLicenseFromText,
  pickLicenseFiles,
  resolveLicense,
  requiresTextReproduction,
  compareIds,
  groupByLicense,
  extractLeadingBlockComment,
  packageNameFromLockKey,
  jsProdEntriesFromLock,
  rustRuntimeClosure,
  normalizeRepository,
  buildModel,
  renderNotices,
  fenceFor,
  NO_ATTRIBUTION_REQUIRED,
  OUTPUT_FILE,
  DEFAULT_RUST_TARGET,
  VENDORED_ASSETS,
} from "./attribution.mjs";

// ---------------------------------------------------------------------------
// Literal licence texts, trimmed to the sentence each classifier keys on.
// ---------------------------------------------------------------------------

const MIT_TEXT = `The MIT License (MIT)

Copyright (c) 2019-present Fabio Spampinato, Andrew Maney

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction.`;

const APACHE_TEXT = `                              Apache License
                        Version 2.0, January 2004
                     http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION`;

const ISC_TEXT = `ISC License

Copyright (c) Isaac Z. Schlueter

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.`;

const BSD3_TEXT = `Copyright (c) 2013, Someone
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products.`;

const BSD2_TEXT = `Copyright (c) 2013, Someone
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.`;

const UNLICENSE_TEXT = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute
this software, either in source code form or as a compiled binary.`;

// ---------------------------------------------------------------------------

describe("normalizeLicense", () => {
  it("passes a plain SPDX id through unchanged", () => {
    expect(normalizeLicense("MIT")).toBe("MIT");
    expect(normalizeLicense("Apache-2.0")).toBe("Apache-2.0");
    expect(normalizeLicense("Unicode-3.0")).toBe("Unicode-3.0");
    expect(normalizeLicense("  ISC  ")).toBe("ISC");
  });

  it("collapses the three spellings of dual MIT/Apache into ONE group", () => {
    // All three occur in this repo's graph. Three groups for one
    // licence is how a notice file becomes unreadable.
    expect(normalizeLicense("MIT OR Apache-2.0")).toBe("Apache-2.0 OR MIT");
    expect(normalizeLicense("Apache-2.0 OR MIT")).toBe("Apache-2.0 OR MIT");
    expect(normalizeLicense("MIT/Apache-2.0")).toBe("Apache-2.0 OR MIT");
  });

  it("sorts a three-term OR set and strips wrapping parentheses", () => {
    expect(normalizeLicense("Zlib OR Apache-2.0 OR MIT")).toBe("Apache-2.0 OR MIT OR Zlib");
    expect(normalizeLicense("(MPL-2.0 OR Apache-2.0)")).toBe("Apache-2.0 OR MPL-2.0");
    expect(normalizeLicense("Unlicense OR MIT")).toBe("MIT OR Unlicense");
  });

  it("keeps AND and WITH expressions verbatim — reordering them changes the meaning", () => {
    expect(normalizeLicense("(MIT OR Apache-2.0) AND Unicode-3.0")).toBe("(MIT OR Apache-2.0) AND Unicode-3.0");
    expect(normalizeLicense("Apache-2.0 WITH LLVM-exception")).toBe("Apache-2.0 WITH LLVM-exception");
    expect(normalizeLicense("Apache-2.0 AND ISC")).toBe("Apache-2.0 AND ISC");
  });

  it("reads npm's two legacy shapes", () => {
    expect(normalizeLicense({ type: "MIT", url: "http://example.com/mit" })).toBe("MIT");
    expect(normalizeLicense([{ type: "MIT" }, { type: "Apache-2.0" }])).toBe("Apache-2.0 OR MIT");
    expect(normalizeLicense([{ type: "MIT" }, { type: "MIT" }])).toBe("MIT");
  });

  it("returns null for every way of saying nothing — never a fabricated licence", () => {
    expect(normalizeLicense(undefined)).toBe(null);
    expect(normalizeLicense(null)).toBe(null);
    expect(normalizeLicense("")).toBe(null);
    expect(normalizeLicense("   ")).toBe(null);
    expect(normalizeLicense("UNKNOWN")).toBe(null);
    expect(normalizeLicense("unknown")).toBe(null);
    expect(normalizeLicense("SEE LICENSE IN LICENSE.md")).toBe(null);
    expect(normalizeLicense([])).toBe(null);
    expect(normalizeLicense({})).toBe(null);
    expect(normalizeLicense(42)).toBe(null);
  });

  it("distinguishes UNLICENSED (no licence granted) from Unlicense (public domain)", () => {
    // One letter apart, opposite meanings. Getting this wrong would attribute a
    // proprietary package as public domain.
    expect(normalizeLicense("UNLICENSED")).toBe(null);
    expect(normalizeLicense("Unlicense")).toBe("Unlicense");
  });
});

describe("sniffLicenseFromText", () => {
  it("classifies the licence texts we actually encounter", () => {
    expect(sniffLicenseFromText(MIT_TEXT)).toBe("MIT");
    expect(sniffLicenseFromText(APACHE_TEXT)).toBe("Apache-2.0");
    expect(sniffLicenseFromText(ISC_TEXT)).toBe("ISC");
    expect(sniffLicenseFromText(BSD3_TEXT)).toBe("BSD-3-Clause");
    expect(sniffLicenseFromText(BSD2_TEXT)).toBe("BSD-2-Clause");
    expect(sniffLicenseFromText(UNLICENSE_TEXT)).toBe("Unlicense");
  });

  it("matches across a hard line break — the exact khroma case", () => {
    // khroma@2.1.0 wraps after "obtaining a", one word earlier than most MIT
    // files. Measured: before whitespace normalisation this returned null and
    // khroma landed in "needs manual review" for no good reason.
    expect(MIT_TEXT).toContain("obtaining a\ncopy");
    expect(sniffLicenseFromText(MIT_TEXT)).toBe("MIT");
    expect(
      sniffLicenseFromText("Permission is hereby granted, free of charge, to any person obtaining a copy"),
    ).toBe("MIT");
  });

  it("returns null when a file matches TWO licences — a human must pick the arm", () => {
    expect(sniffLicenseFromText(`${MIT_TEXT}\n\n---\n\n${APACHE_TEXT}`)).toBe(null);
  });

  it("returns null for text it does not recognise, instead of guessing", () => {
    expect(sniffLicenseFromText("All rights reserved. Contact legal@example.com.")).toBe(null);
    expect(sniffLicenseFromText("")).toBe(null);
    expect(sniffLicenseFromText("   ")).toBe(null);
    expect(sniffLicenseFromText(undefined)).toBe(null);
  });
});

describe("pickLicenseFiles", () => {
  it("finds licence texts under every spelling, in stable order", () => {
    expect(
      pickLicenseFiles([
        "README.md",
        "LICENSE-MIT",
        "package.json",
        "LICENSE-APACHE",
        "COPYING",
        "NOTICE",
        "licence.txt",
        "UNLICENSE",
        "COPYRIGHT",
      ]),
    ).toEqual(["COPYING", "COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT", "NOTICE", "UNLICENSE", "licence.txt"]);
  });

  it("finds a lowercase `license` file (how khroma ships its MIT text)", () => {
    expect(pickLicenseFiles(["dist", "license", "package.json", "readme.md"])).toEqual(["license"]);
  });

  it("rejects code that merely starts with the word", () => {
    expect(
      pickLicenseFiles(["license-check.js", "licenserc.json", "licenses.ts", "copying.sh", "notice.yml"]),
    ).toEqual([]);
  });

  it("accepts the .md/.txt spellings and a dotted licence name", () => {
    expect(pickLicenseFiles(["LICENSE.md", "LICENSE.txt", "LICENSE.APACHE-2.0"])).toEqual([
      "LICENSE.APACHE-2.0",
      "LICENSE.md",
      "LICENSE.txt",
    ]);
  });

  it("tolerates garbage input instead of throwing mid-generation", () => {
    expect(pickLicenseFiles(undefined)).toEqual([]);
    expect(pickLicenseFiles([null, "", 7, "LICENSE"])).toEqual(["LICENSE"]);
  });
});

describe("resolveLicense", () => {
  it("prefers metadata and says so", () => {
    expect(
      resolveLicense({ metadataLicense: "MIT", licenseFiles: [{ file: "LICENSE", text: APACHE_TEXT }] }),
    ).toEqual({ license: "MIT", source: "metadata", candidates: [] });
  });

  it("resolves the UNKNOWN-with-a-licence-file case by READING the file", () => {
    // The audit's named oddity: khroma@2.1.0 has no `license` field but ships an
    // MIT `license` file. Resolved from the file, and the provenance recorded so
    // the output does not pass it off as declared metadata.
    expect(resolveLicense({ metadataLicense: undefined, licenseFiles: [{ file: "license", text: MIT_TEXT }] })).toEqual(
      { license: "MIT", source: "licence file: license", candidates: [] },
    );
    expect(resolveLicense({ metadataLicense: "UNKNOWN", licenseFiles: [{ file: "LICENSE", text: ISC_TEXT }] })).toEqual(
      { license: "ISC", source: "licence file: LICENSE", candidates: [] },
    );
  });

  it("puts a package with no metadata and no readable licence into the manual-review bucket", () => {
    expect(resolveLicense({ metadataLicense: undefined, licenseFiles: [] })).toEqual({
      license: null,
      source: "unresolved",
      candidates: [],
    });
    expect(
      resolveLicense({
        metadataLicense: null,
        licenseFiles: [{ file: "LICENSE", text: "All rights reserved." }],
      }),
    ).toEqual({ license: null, source: "unresolved", candidates: [] });
  });

  it("refuses to guess when two licence files disagree, and reports the candidates", () => {
    expect(
      resolveLicense({
        metadataLicense: undefined,
        licenseFiles: [
          { file: "LICENSE-MIT", text: MIT_TEXT },
          { file: "LICENSE-APACHE", text: APACHE_TEXT },
        ],
      }),
    ).toEqual({ license: null, source: "unresolved", candidates: ["Apache-2.0", "MIT"] });
  });

  it("survives being called with nothing", () => {
    expect(resolveLicense()).toEqual({ license: null, source: "unresolved", candidates: [] });
  });
});

describe("requiresTextReproduction", () => {
  it("requires reproduction for every notice-retention licence", () => {
    for (const licence of ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "Zlib", "MPL-2.0"]) {
      expect(requiresTextReproduction(licence)).toBe(true);
    }
  });

  it("does not require reproduction for public-domain dedications", () => {
    expect(requiresTextReproduction("Unlicense")).toBe(false);
    expect(requiresTextReproduction("CC0-1.0")).toBe(false);
    expect(requiresTextReproduction("0BSD")).toBe(false);
    expect(NO_ATTRIBUTION_REQUIRED.has("Unlicense")).toBe(true);
  });

  it("errs toward reproducing when an OR set mixes the two", () => {
    // Over-attribution is never a violation; omission is.
    expect(requiresTextReproduction("MIT OR Unlicense")).toBe(true);
    expect(requiresTextReproduction("0BSD OR Apache-2.0 OR MIT")).toBe(true);
  });

  it("treats an unknown or empty licence as requiring reproduction", () => {
    expect(requiresTextReproduction("Weird-1.0")).toBe(true);
    expect(requiresTextReproduction("")).toBe(true);
    expect(requiresTextReproduction(undefined)).toBe(true);
  });
});

describe("compareIds", () => {
  it("orders versions numerically, not lexicographically", () => {
    expect(compareIds("foo@9.0.0", "foo@10.0.0")).toBeLessThan(0);
    expect(compareIds("foo@10.0.0", "foo@9.0.0")).toBeGreaterThan(0);
    expect(compareIds("foo@1.2.3", "foo@1.2.3")).toBe(0);
  });

  it("orders names before versions and is total", () => {
    const ids = ["b@1.0.0", "a@10.0.0", "a@2.0.0", "@scope/a@1.0.0"];
    expect([...ids].sort(compareIds)).toEqual(["@scope/a@1.0.0", "a@2.0.0", "a@10.0.0", "b@1.0.0"]);
  });

  it("sorts a prefix before its extension", () => {
    expect(compareIds("foo", "foobar")).toBeLessThan(0);
    expect(compareIds("foobar", "foo")).toBeGreaterThan(0);
  });
});

describe("groupByLicense", () => {
  const entry = (id, license) => ({ id, license, ecosystem: "npm", texts: [], source: "metadata" });

  it("groups by licence, sorting groups by name and members by id", () => {
    const groups = groupByLicense([
      entry("zeta@1.0.0", "MIT"),
      entry("alpha@2.0.0", "ISC"),
      entry("beta@10.0.0", "MIT"),
      entry("beta@9.0.0", "MIT"),
    ]);
    expect(groups).toEqual([
      { license: "ISC", entries: [entry("alpha@2.0.0", "ISC")] },
      {
        license: "MIT",
        entries: [entry("beta@9.0.0", "MIT"), entry("beta@10.0.0", "MIT"), entry("zeta@1.0.0", "MIT")],
      },
    ]);
  });

  it("sorts groups by NAME, not by size — so adding one package cannot reshuffle the file", () => {
    const groups = groupByLicense([
      entry("a@1.0.0", "MIT"),
      entry("b@1.0.0", "MIT"),
      entry("c@1.0.0", "MIT"),
      entry("d@1.0.0", "ISC"),
    ]);
    expect(groups.map((group) => group.license)).toEqual(["ISC", "MIT"]);
  });

  it("drops unresolved entries (they belong in the manual-review bucket, not a group)", () => {
    expect(groupByLicense([entry("a@1.0.0", null), entry("b@1.0.0", "MIT")]).map((g) => g.license)).toEqual(["MIT"]);
    expect(groupByLicense(undefined)).toEqual([]);
  });
});

describe("extractLeadingBlockComment", () => {
  it("reads zlib's licence out of its header comment, de-indented", () => {
    const zlibH = `/* zlib.h -- interface of the 'zlib' library
  version 1.3.2

  Copyright (C) 1995-2026 Jean-loup Gailly and Mark Adler

  This software is provided 'as-is'.
*/

#define ZLIB_VERSION "1.3.2"`;
    expect(extractLeadingBlockComment(zlibH)).toBe(
      `zlib.h -- interface of the 'zlib' library
 version 1.3.2

 Copyright (C) 1995-2026 Jean-loup Gailly and Mark Adler

 This software is provided 'as-is'.`,
    );
  });

  it("strips a per-line asterisk gutter", () => {
    expect(extractLeadingBlockComment("/*\n * Copyright (c) 2026 Someone\n * MIT licensed.\n */\nint x;")).toBe(
      "Copyright (c) 2026 Someone\nMIT licensed.",
    );
  });

  it("returns null when there is no complete comment to read", () => {
    expect(extractLeadingBlockComment("int x;")).toBe(null);
    expect(extractLeadingBlockComment("/* never closed")).toBe(null);
    expect(extractLeadingBlockComment("/**/")).toBe(null);
    expect(extractLeadingBlockComment(undefined)).toBe(null);
  });
});

describe("packageNameFromLockKey", () => {
  it("reads the name of a nested copy from the LAST node_modules segment", () => {
    expect(packageNameFromLockKey("node_modules/glob/node_modules/minimatch", {})).toBe("minimatch");
    expect(packageNameFromLockKey("node_modules/mermaid", {})).toBe("mermaid");
  });

  it("keeps a scope intact", () => {
    expect(packageNameFromLockKey("node_modules/@xterm/addon-fit", {})).toBe("@xterm/addon-fit");
    expect(packageNameFromLockKey("node_modules/foo/node_modules/@scope/bar", {})).toBe("@scope/bar");
  });

  it("prefers an explicit name field (npm writes one for aliased installs)", () => {
    expect(packageNameFromLockKey("node_modules/my-alias", { name: "real-package" })).toBe("real-package");
  });

  it("returns null for a key that is not a node_modules path", () => {
    expect(packageNameFromLockKey("", {})).toBe(null);
    expect(packageNameFromLockKey("src/app", {})).toBe(null);
    expect(packageNameFromLockKey(undefined, {})).toBe(null);
  });
});

describe("jsProdEntriesFromLock", () => {
  const LOCK = {
    lockfileVersion: 3,
    packages: {
      "": { name: "agent-studio", version: "0.1.0" },
      "node_modules/react": { version: "19.1.0", license: "MIT" },
      "node_modules/vitest": { version: "4.1.10", license: "MIT", dev: true },
      "node_modules/@vitest/pretty-format": { version: "4.1.10", license: "MIT", devOptional: true },
      "node_modules/fsevents": { version: "2.3.3", license: "MIT", dev: true, optional: true },
      "node_modules/khroma": { version: "2.1.0" },
      "node_modules/@xterm/xterm": { version: "6.0.0", license: "MIT" },
      // The same version reachable by two paths: one entry, both paths recorded.
      "node_modules/mermaid/node_modules/react": { version: "19.1.0", license: "MIT" },
      // A production-tree optional dependency: installed means distributed.
      "node_modules/optional-native": { version: "1.0.0", license: "ISC", optional: true },
    },
  };

  it("keeps production packages and drops dev, devOptional and the root project", () => {
    expect(jsProdEntriesFromLock(LOCK).map((entry) => entry.id)).toEqual([
      "@xterm/xterm@6.0.0",
      "khroma@2.1.0",
      "optional-native@1.0.0",
      "react@19.1.0",
    ]);
  });

  it("deduplicates a version reachable by several paths, recording each path", () => {
    const react = jsProdEntriesFromLock(LOCK).find((entry) => entry.name === "react");
    expect(react.paths).toEqual(["node_modules/mermaid/node_modules/react", "node_modules/react"]);
  });

  it("carries the lockfile's license field through untouched, including its absence", () => {
    const byId = new Map(jsProdEntriesFromLock(LOCK).map((entry) => [entry.id, entry]));
    expect(byId.get("react@19.1.0").license).toBe("MIT");
    expect(byId.get("khroma@2.1.0").license).toBe(undefined);
  });

  it("returns an empty list rather than throwing on a garbled lockfile", () => {
    expect(jsProdEntriesFromLock(undefined)).toEqual([]);
    expect(jsProdEntriesFromLock({})).toEqual([]);
    expect(jsProdEntriesFromLock({ packages: { "node_modules/x": { license: "MIT" } } })).toEqual([]);
  });
});

describe("rustRuntimeClosure", () => {
  // `cargo metadata`'s shape, trimmed to the fields the walk reads. `kind: null`
  // is cargo's encoding of a NORMAL dependency; "build" and "dev" are the others.
  const META = {
    packages: [
      { id: "root", name: "agent-studio-scaffold", version: "0.1.0", license: null, manifest_path: "/a/Cargo.toml" },
      { id: "serde", name: "serde", version: "1.0.228", license: "MIT OR Apache-2.0", manifest_path: "/b/Cargo.toml" },
      { id: "libc", name: "libc", version: "0.2.180", license: "MIT OR Apache-2.0", manifest_path: "/c/Cargo.toml" },
      { id: "cc", name: "cc", version: "1.2.49", license: "MIT OR Apache-2.0", manifest_path: "/d/Cargo.toml" },
      { id: "wdio", name: "test-only", version: "1.0.0", license: "MIT", manifest_path: "/e/Cargo.toml" },
    ],
    resolve: {
      root: "root",
      nodes: [
        {
          id: "root",
          deps: [
            { pkg: "serde", dep_kinds: [{ kind: null }] },
            { pkg: "cc", dep_kinds: [{ kind: "build" }] },
            { pkg: "wdio", dep_kinds: [{ kind: "dev" }] },
          ],
        },
        { id: "serde", deps: [{ pkg: "libc", dep_kinds: [{ kind: null }] }] },
        { id: "libc", deps: [] },
        { id: "cc", deps: [] },
        { id: "wdio", deps: [] },
      ],
    },
  };

  it("walks only NORMAL edges — build and dev dependencies do not ship", () => {
    expect(rustRuntimeClosure(META).map((pkg) => pkg.name)).toEqual(["libc", "serde"]);
  });

  it("excludes our own crate — we owe no attribution to ourselves", () => {
    expect(rustRuntimeClosure(META).map((pkg) => pkg.id)).not.toContain("root");
  });

  it("returns an empty list on a payload it cannot walk", () => {
    expect(rustRuntimeClosure(undefined)).toEqual([]);
    expect(rustRuntimeClosure({ packages: [] })).toEqual([]);
    expect(rustRuntimeClosure({ resolve: { root: "root" } })).toEqual([]);
  });
});

describe("normalizeRepository", () => {
  it("turns every git spelling into a browsable https URL", () => {
    expect(normalizeRepository("git+https://github.com/facebook/react.git")).toBe("https://github.com/facebook/react");
    expect(normalizeRepository({ type: "git", url: "git://github.com/foo/bar.git" })).toBe("https://github.com/foo/bar");
    expect(normalizeRepository("git@github.com:foo/bar.git")).toBe("https://github.com/foo/bar");
    expect(normalizeRepository("foo/bar")).toBe("https://github.com/foo/bar");
    expect(normalizeRepository("https://github.com/serde-rs/serde")).toBe("https://github.com/serde-rs/serde");
  });

  it("returns null when there is nothing to link to", () => {
    expect(normalizeRepository(undefined)).toBe(null);
    expect(normalizeRepository("")).toBe(null);
    expect(normalizeRepository({})).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The document: bucketing, dedup, and determinism.
// ---------------------------------------------------------------------------

const jsEntry = (over) => ({
  ecosystem: "npm",
  name: "pkg",
  version: "1.0.0",
  id: "pkg@1.0.0",
  license: "MIT",
  source: "metadata",
  candidates: [],
  repository: null,
  texts: [],
  ...over,
});

function sampleInput() {
  return {
    js: [
      jsEntry({
        name: "react",
        id: "react@19.1.0",
        version: "19.1.0",
        repository: "https://github.com/facebook/react",
        texts: [{ file: "LICENSE", text: MIT_TEXT }],
      }),
      jsEntry({
        name: "khroma",
        id: "khroma@2.1.0",
        version: "2.1.0",
        source: "licence file: license",
        texts: [{ file: "license", text: MIT_TEXT }],
      }),
      jsEntry({ name: "argparse", id: "argparse@2.0.1", version: "2.0.1", license: "Python-2.0" }),
      jsEntry({ name: "mystery", id: "mystery@0.1.0", version: "0.1.0", license: null, source: "unresolved" }),
      jsEntry({
        name: "robust-predicates",
        id: "robust-predicates@3.0.2",
        version: "3.0.2",
        license: "Unlicense",
      }),
    ],
    rust: [
      jsEntry({
        ecosystem: "cargo",
        name: "serde",
        id: "serde@1.0.228",
        version: "1.0.228",
        license: "Apache-2.0 OR MIT",
        texts: [{ file: "LICENSE-APACHE", text: APACHE_TEXT }],
      }),
    ],
    rustMeta: { target: "aarch64-apple-darwin", totalResolved: 528 },
    vendoredC: [
      {
        crate: "libgit2-sys",
        crateVersion: "0.18.7+1.9.6",
        library: "libgit2 (C)",
        cVersion: "1.9.6",
        ships: true,
        notices: [{ file: "libgit2/COPYING", label: "libgit2 1.9.6 — GPL-2.0 WITH a linking exception", text: "LINKING EXCEPTION ...", problem: null }],
      },
    ],
    sources: { notes: [] },
  };
}

describe("buildModel", () => {
  it("buckets resolved licences, unresolved packages and missing texts separately", () => {
    const model = buildModel(sampleInput());
    expect(model.js.total).toBe(5);
    expect(model.js.groups.map((group) => `${group.license}:${group.entries.length}`)).toEqual([
      "MIT:2",
      "Python-2.0:1",
      "Unlicense:1",
    ]);
    expect(model.js.manualReview.map((entry) => entry.id)).toEqual(["mystery@0.1.0"]);
    // argparse declares Python-2.0 (which requires reproduction) and ships no
    // text -> missing. robust-predicates is Unlicense -> nothing owed, so it is
    // NOT listed as missing.
    expect(model.js.missingText.map((entry) => entry.id)).toEqual(["argparse@2.0.1"]);
    expect(model.js.fromLicenceFile.map((entry) => entry.id)).toEqual(["khroma@2.1.0"]);
  });

  it("deduplicates identical licence texts across BOTH ecosystems and names every sharer", () => {
    const model = buildModel(sampleInput());
    expect(model.texts.length).toBe(2);
    const mit = model.texts.find((block) => block.licenses.includes("MIT"));
    expect(mit.packages).toEqual(["khroma@2.1.0", "react@19.1.0"]);
    expect(mit.files).toEqual(["LICENSE", "license"]);
    const apache = model.texts.find((block) => block.licenses.includes("Apache-2.0 OR MIT"));
    expect(apache.packages).toEqual(["serde@1.0.228"]);
  });

  it("carries the Rust target and the honest total through to the model", () => {
    const model = buildModel(sampleInput());
    expect(model.rust.target).toBe("aarch64-apple-darwin");
    expect(model.rust.totalResolved).toBe(528);
    expect(model.rust.total).toBe(1);
  });

  it("survives an empty input", () => {
    const model = buildModel();
    expect(model.js.total).toBe(0);
    expect(model.rust.total).toBe(0);
    expect(model.texts).toEqual([]);
    expect(model.vendoredC).toEqual([]);
  });
});

describe("renderNotices", () => {
  it("is DETERMINISTIC: two runs over the same input are byte-identical", () => {
    // The property that makes a 900 KB generated file reviewable in a diff. If
    // this ever fails, the file will churn on every run and stop being read.
    const first = renderNotices(buildModel(sampleInput()));
    const second = renderNotices(buildModel(sampleInput()));
    expect(second).toBe(first);
    expect(first).not.toBe("");
  });

  it("is DETERMINISTIC under a reordered input — the sort, not the input order, fixes the output", () => {
    const forward = sampleInput();
    const shuffled = sampleInput();
    shuffled.js.reverse();
    expect(renderNotices(buildModel(shuffled))).toBe(renderNotices(buildModel(forward)));
  });

  it("contains no date, time or other churning value", () => {
    const markdown = renderNotices(buildModel(sampleInput()));
    // A generated-on timestamp is the classic way an attribution file becomes
    // noise: every regeneration is a diff, so nobody reads any of them.
    expect(markdown).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T/);
    expect(markdown).not.toMatch(/[Gg]enerated (on|at)\b/);
  });

  it("names the licence, every package, and the manual-review bucket", () => {
    const markdown = renderNotices(buildModel(sampleInput()));
    expect(markdown).toContain("# Third-party notices");
    expect(markdown).toContain("### MIT — 2 packages");
    expect(markdown).toContain("`react@19.1.0` — https://github.com/facebook/react");
    expect(markdown).toContain("## Needs manual review");
    expect(markdown).toContain("`mystery@0.1.0` (npm)");
    expect(markdown).toContain("no licence file found in the package either");
    expect(markdown).toContain("`khroma@2.1.0` (npm) → **MIT** (licence file: license)");
    expect(markdown).toContain("`argparse@2.0.1` (npm) — declared **Python-2.0**, no licence file");
  });

  it("reproduces the vendored C notice verbatim, under its own heading", () => {
    const markdown = renderNotices(buildModel(sampleInput()));
    expect(markdown).toContain("## Vendored C/C++ libraries compiled into the binary");
    expect(markdown).toContain("- Compiled by: `libgit2-sys 0.18.7+1.9.6`");
    expect(markdown).toContain("- Upstream C version: **1.9.6**");
    expect(markdown).toContain("LINKING EXCEPTION ...");
  });

  it("says NONE explicitly when a bucket is empty, rather than silently omitting the section", () => {
    const clean = renderNotices(
      buildModel({
        js: [jsEntry({ texts: [{ file: "LICENSE", text: MIT_TEXT }] })],
        rust: [],
        rustMeta: { target: "aarch64-apple-darwin", totalResolved: 528 },
      }),
    );
    expect(clean).toContain("## Needs manual review");
    expect(clean).toContain("None. Every package and crate listed below has a licence");
    expect(clean).toContain("None — a licence text was found for every package");
  });

  it("does not rewrite the inside of a licence text", () => {
    // A blanket `\n{3,}` collapse over the finished document would silently edit
    // legally-required text. The blank-line run below must survive intact.
    const spaced = "Copyright (c) 2026 Someone\n\n\n\nPermission is hereby granted, free of charge, to any person obtaining a copy";
    const markdown = renderNotices(
      buildModel({ js: [jsEntry({ texts: [{ file: "LICENSE", text: spaced }] })], rust: [] }),
    );
    expect(markdown).toContain(spaced);
  });

  it("reports the correct total in every heading", () => {
    const markdown = renderNotices(buildModel(sampleInput()));
    expect(markdown).toContain("## JavaScript production dependencies (5 packages)");
    expect(markdown).toContain("## Rust crates (1 crates, aarch64-apple-darwin runtime graph)");
    expect(markdown).toContain("| **total** | **5** | **1** |");
    expect(markdown).toContain("## Full licence texts (2 distinct texts)");
  });
});

describe("fenceFor", () => {
  it("uses a plain three-backtick fence for ordinary text", () => {
    expect(fenceFor("Copyright (c) 2026 Someone")).toBe("```");
    expect(fenceFor("")).toBe("```");
    expect(fenceFor(undefined)).toBe("```");
  });

  it("grows the fence past any fence inside the text", () => {
    // A licence file containing its own ``` block would otherwise close the
    // enclosing fence early and corrupt every section after it.
    expect(fenceFor("before\n```\ncode\n```\nafter")).toBe("````");
    expect(fenceFor("````\nnested\n````")).toBe("`````");
  });

  it("ignores backticks that are not at the start of a line", () => {
    expect(fenceFor("use `npm run attribution` to regenerate")).toBe("```");
  });

  it("keeps the rendered document's fences balanced when a text contains one", () => {
    const tricky = "Copyright (c) 2026 Someone\n```\nnot a real fence\n```\nMIT licensed.";
    const markdown = renderNotices(
      buildModel({ js: [jsEntry({ texts: [{ file: "LICENSE", text: tricky }] })], rust: [] }),
    );
    expect(markdown).toContain("````text");
    expect(markdown).toContain(tricky);
    // One `bash` block in the header plus one licence block: two open, two close.
    const fences = markdown.match(/^`{3,}/gm) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});

describe("the generator's declared constants", () => {
  it("writes to THIRD-PARTY-NOTICES.txt at the repo root (plain text: README.md is the only Markdown file)", () => {
    expect(OUTPUT_FILE).toBe("THIRD-PARTY-NOTICES.txt");
  });

  it("defaults to the macOS target the audit reviewed", () => {
    expect(DEFAULT_RUST_TARGET).toBe("aarch64-apple-darwin");
  });
});

describe("vendored design assets (the icon sprite's credit survives regeneration)", () => {
  // The section exists because the first Material credit was hand-APPENDED to
  // the generated file — where the very next regeneration would have deleted
  // it. The durable home is the VENDORED_ASSETS declaration; these tests pin
  // that the declaration renders, and that its licence file really exists.

  const sampleAsset = {
    name: "Sample Icons",
    version: "v1.2.3",
    commit: "abc123",
    source: "https://example.com/sample-icons (MIT)",
    dir: "src/assets/sample-icons",
    licenseFile: "src/assets/sample-icons/LICENSE",
    note: "one glyph modified",
    licenseText: "MIT sample licence text",
    problem: null,
  };

  it("renders the section with version, commit, dir, note and the licence text fenced", () => {
    const markdown = renderNotices(buildModel({ vendoredAssets: [sampleAsset] }));
    expect(markdown).toContain("## Vendored design assets");
    expect(markdown).toContain("### Sample Icons");
    expect(markdown).toContain("**v1.2.3** (commit `abc123`)");
    expect(markdown).toContain("`src/assets/sample-icons`");
    expect(markdown).toContain("one glyph modified");
    expect(markdown).toContain("MIT sample licence text");
  });

  it("renders an unreadable licence file as a LOUD warning, never a silent drop", () => {
    const markdown = renderNotices(
      buildModel({ vendoredAssets: [{ ...sampleAsset, licenseText: null, problem: "ENOENT" }] }),
    );
    expect(markdown).toContain("could not be read (ENOENT)");
    expect(markdown).toContain("must be");
    expect(markdown).not.toContain("MIT sample licence text");
  });

  it("omits the section entirely when no assets are declared (older-model inputs stay valid)", () => {
    const markdown = renderNotices(buildModel(sampleInput()));
    expect(markdown).not.toContain("## Vendored design assets");
    expect(buildModel().vendoredAssets).toEqual([]);
  });

  it("the REAL declaration names the Material set and its licence file exists in this repo", () => {
    const material = VENDORED_ASSETS.find((a) => a.name.startsWith("Material Icon Theme"));
    expect(material).toBeDefined();
    expect(material.commit).toMatch(/^[0-9a-f]{40}$/);
    // The file the generator will read must really be vendored — a declaration
    // pointing at nothing would render the loud warning on every regeneration.
    expect(fs.existsSync(path.join(process.cwd(), material.licenseFile))).toBe(true);
    const text = fs.readFileSync(path.join(process.cwd(), material.licenseFile), "utf8");
    expect(text).toContain("MIT");
  });

  it("the REAL declaration names the Pixel Agents art, credits JIK-A-4, and its licence file exists", () => {
    const pixel = VENDORED_ASSETS.find((a) => a.name.startsWith("Pixel Agents"));
    expect(pixel).toBeDefined();
    expect(pixel.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pixel.dir).toBe("src/assets/pixel-agents");
    // The characters derive from a third-party CC0 pack: the credit lives in the declaration.
    expect(pixel.note).toContain("JIK-A-4");
    const licence = path.join(process.cwd(), pixel.licenseFile);
    expect(fs.existsSync(licence)).toBe(true);
    const text = fs.readFileSync(licence, "utf8");
    expect(text).toContain("MIT License");
    expect(text).toContain("Pablo De Lucca");
  });
});
