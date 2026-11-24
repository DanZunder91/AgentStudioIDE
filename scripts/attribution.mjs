#!/usr/bin/env node
/**
 * Generates `THIRD-PARTY-NOTICES.txt` — the attribution file a binary
 * distribution of Agent Studio is legally required to carry.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The desktop binary contains hundreds of MIT, ISC, BSD-2/3-Clause and
 * Apache-2.0 dependencies, and a dependency audit found **no attribution file
 * anywhere in the repo**. All of those licences bind *binary* redistribution:
 *
 *   MIT          "The above copyright notice and this permission notice shall be
 *                 included in all copies or substantial portions of the Software."
 *   BSD-2/3      "Redistributions in binary form must reproduce the above
 *                 copyright notice, this list of conditions and the following
 *                 disclaimer in the documentation and/or other materials..."
 *   Apache-2.0   §4(d) — retain the NOTICE file's attribution notices.
 *   ISC / Zlib   equivalent notice-retention clauses.
 *
 * There is no copyleft problem to solve here: the audit established that
 * libgit2's GPL-2.0 comes with a linking exception broad enough that static
 * linking imposes nothing on our source, and the five MPL-2.0 crates are
 * file-level weak copyleft that we do not modify. This is purely the
 * attribution gap, and it must be closed **before the first public build**.
 *
 * WHAT IT COVERS, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * - **JS: production dependencies only.** Walked from the committed
 *   `package-lock.json`, skipping every `dev`/`devOptional` entry. Dev tooling
 *   is not distributed, so including it would triple the file with packages we
 *   owe nothing for — and a notice file nobody can read is a notice file nobody
 *   checks. The lockfile is used rather than `npm ls` because it is committed,
 *   deterministic, and immune to whatever is extraneous in `node_modules`
 *   (undeclared packages do accumulate there).
 * - **Rust: the crates that actually ship**, i.e. the normal (non-dev,
 *   non-build) dependency closure of the app crate for the shipped target, via
 *   `cargo metadata --filter-platform`. `cargo metadata` does NOT build, which
 *   matters: this script must be safe to run while another cargo process holds
 *   the build tree. The counts differ substantially from the full resolved
 *   set — roughly 540 resolved crates vs ~320 shipped on macOS —
 *   so the generated header states exactly which number it is reporting.
 * - **The vendored C**, whose own notices crate metadata does not describe:
 *   libgit2's COPYING and zlib's licence header. Read from
 *   `REVIEWED_VENDORED_C` in `scripts/audit.mjs`, so the list of C we compile
 *   lives in exactly one place (the same list the audit gate enforces).
 * - **Vendored design assets** (no lockfile knows them): the Material Icon
 *   Theme file-type SVGs under `src/assets/file-icons/`. Declared in
 *   `VENDORED_ASSETS` below; each set's licence file is read off disk and
 *   reproduced, so regeneration can never silently drop the credit.
 *
 * HONESTY RULES BAKED INTO THE OUTPUT
 * -----------------------------------
 * 1. A licence is never guessed. If the metadata says nothing and no licence
 *    file can be classified, the package lands in an explicit **needs manual
 *    review** section. (A known case: `khroma@2.1.0` reports no
 *    licence in metadata but ships an MIT `license` file — that is resolved by
 *    *reading the file*, and recorded as such, not by assuming MIT.)
 * 2. A licence text that could not be located is listed as missing, never
 *    silently dropped.
 * 3. The output is **deterministic**: stable sorts everywhere, no timestamps,
 *    no run counters. Two runs over the same inputs produce byte-identical
 *    files, which is what makes this reviewable in a diff instead of noise.
 *
 * Usage: `npm run attribution` (or `node scripts/attribution.mjs`).
 * Zero new dependencies, on purpose.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { REVIEWED_VENDORED_C, parseCargoLockPackages } from "./audit.mjs";

/** Where the notices are written, relative to the repo root. */
// Plain text, not Markdown: the only Markdown file in the repository is README.md.
export const OUTPUT_FILE = "THIRD-PARTY-NOTICES.txt";

/**
 * The target whose runtime graph is reported. macOS is the artifact the audit
 * reviewed and the only one we currently build. A Windows/Linux release must
 * regenerate with `--target <triple>` — the crate sets differ by ~200 crates.
 */
export const DEFAULT_RUST_TARGET = "aarch64-apple-darwin";

// ---------------------------------------------------------------------------
// Pure part 1 — licence identity
// ---------------------------------------------------------------------------

/**
 * Licences that grant rights without asking for a notice in return: public
 * domain dedications and 0BSD, which exists precisely to drop the retention
 * clause. Everything else is assumed to require reproduction — over-attribution
 * is never a violation, under-attribution is.
 */
export const NO_ATTRIBUTION_REQUIRED = new Set(["0BSD", "CC0-1.0", "Unlicense", "WTFPL"]);

/** Strings npm/cargo use to mean "no licence stated". Never a licence id. */
const NON_LICENCE_MARKERS = /^(unknown|unlicensed|none|n\/a|nolicense|see\s+licen[cs]e.*)$/i;

/** File extensions that mean "this is code named LICENSE-something", not a licence text. */
const CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".map",
  ".yml",
  ".yaml",
  ".lock",
  ".sh",
  ".toml",
]);

const LICENCE_FILE_STEMS = new Set([
  "license",
  "licence",
  "licenses",
  "licences",
  "copying",
  "copyright",
  "notice",
  "unlicense",
  "unlicence",
]);

/**
 * Canonicalise a licence declaration into one comparable string, or null when
 * nothing was declared.
 *
 * Accepts every shape the two ecosystems produce: an SPDX string, npm's legacy
 * `{type, url}` object, npm's even more legacy `licenses: [{type}, ...]` array,
 * and the `MIT/Apache-2.0` slash spelling. A pure-OR expression has its terms
 * sorted so that `MIT OR Apache-2.0`, `Apache-2.0 OR MIT` and `MIT/Apache-2.0`
 * all land in ONE group — the audit found all three spellings in our graph, and
 * three groups for one licence is how a notice file becomes unreadable.
 *
 * Anything containing `AND` or `WITH` is kept verbatim: reordering an `AND` set
 * or splitting an exception off its licence would change the meaning.
 */
export function normalizeLicense(raw) {
  let text = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    const parts = raw.map((item) => normalizeLicense(item)).filter((part) => part !== null);
    if (parts.length === 0) return null;
    return joinOr([...new Set(parts)]);
  } else if (raw && typeof raw === "object" && typeof raw.type === "string") {
    text = raw.type;
  }
  if (text === null) return null;

  text = text.trim();
  // Strip ONE layer of wrapping parentheses: `(MPL-2.0 OR Apache-2.0)`. Only
  // when there is exactly one pair, so `(MIT) OR (Apache-2.0)` is left alone
  // rather than mangled into `MIT) OR (Apache-2.0`.
  if (
    text.startsWith("(") &&
    text.endsWith(")") &&
    text.length > 2 &&
    (text.match(/\(/g) ?? []).length === 1 &&
    (text.match(/\)/g) ?? []).length === 1
  ) {
    text = text.slice(1, -1).trim();
  }
  if (text === "" || NON_LICENCE_MARKERS.test(text)) return null;

  if (/\b(AND|WITH)\b/i.test(text)) return text;

  const terms = text
    .split(/\s+OR\s+|\//i)
    .map((term) => term.trim())
    .filter((term) => term !== "");
  if (terms.length === 0) return null;
  if (terms.some((term) => NON_LICENCE_MARKERS.test(term))) return null;
  return joinOr([...new Set(terms)]);
}

function joinOr(terms) {
  return [...terms].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)).join(" OR ");
}

/**
 * Distinctive opening phrases of the licences we actually encounter. Used ONLY
 * when metadata declares nothing — the point is to read the file rather than
 * guess, which is how `khroma@2.1.0` (no `license` field, MIT `license` file)
 * gets resolved correctly.
 *
 * Each marker is a phrase that appears in that licence and in no other, so a
 * text matching two of them is a dual-licence file and is reported as
 * UNRESOLVED rather than arbitrarily assigned to the first match.
 */
const TEXT_MARKERS = [
  ["MIT", /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
  ["Apache-2.0", /Apache License,? Version 2\.0/i],
  ["ISC", /Permission to use, copy, modify,? and\/or distribute this software for any purpose with or without fee/i],
  ["MPL-2.0", /Mozilla Public License Version 2\.0/i],
  ["Unlicense", /This is free and unencumbered software released into the public domain/i],
  ["CC0-1.0", /CC0 1\.0 Universal/i],
  ["Python-2.0", /PYTHON SOFTWARE FOUNDATION LICENSE/i],
  ["Zlib", /This software is provided ['`]as-is['`], without any express or implied warranty/i],
];

/**
 * Classify a licence TEXT. Returns null when nothing matches, or when more than
 * one licence matches (a combined file — a human must say which arm applies).
 *
 * BSD is handled separately from the marker table because BSD-2-Clause and
 * BSD-3-Clause share their opening phrase and differ only by the third clause.
 */
export function sniffLicenseFromText(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  // Match against whitespace-normalised text: licence files hard-wrap at
  // whatever column their author preferred, so `obtaining a\ncopy` and
  // `obtaining a copy` are the same sentence and must match the same marker.
  // (Measured: without this, `khroma`'s MIT file goes unrecognised purely
  // because its line break falls one word earlier.)
  const flat = text.replace(/\s+/g, " ");
  const hits = new Set();
  for (const [id, marker] of TEXT_MARKERS) {
    if (marker.test(flat)) hits.add(id);
  }
  if (/Redistribution and use in source and binary forms/i.test(flat)) {
    hits.add(
      /Neither the name of|nor the names of (its|their)? ?contributors may be used to endorse/i.test(flat)
        ? "BSD-3-Clause"
        : "BSD-2-Clause",
    );
  }
  if (hits.size !== 1) return null;
  return [...hits][0];
}

/**
 * Pick the licence-text files out of a directory listing, in stable order.
 * Matches `LICENSE`, `license`, `LICENCE.md`, `LICENSE-MIT`, `LICENSE.APACHE`,
 * `COPYING`, `COPYRIGHT`, `NOTICE`, `UNLICENSE`; rejects code that merely
 * starts with the word (`license-check.js`, `licenserc.json`).
 */
export function pickLicenseFiles(names) {
  if (!Array.isArray(names)) return [];
  return names
    .filter((name) => typeof name === "string" && name !== "")
    .filter((name) => {
      const lower = name.toLowerCase();
      const dot = lower.lastIndexOf(".");
      const ext = dot > 0 ? lower.slice(dot) : "";
      if (CODE_EXTENSIONS.has(ext)) return false;
      const stem = ext ? lower.slice(0, dot) : lower;
      return LICENCE_FILE_STEMS.has(stem.split(/[-_.]/)[0]);
    })
    .sort();
}

/**
 * Decide one package's licence, recording WHERE the answer came from.
 *
 * @param {object} args
 * @param {*}      args.metadataLicense  the `license`/`licenses` field, any shape
 * @param {Array}  args.licenseFiles     `{file, text}` in the package directory
 * @returns {{license: string|null, source: string, candidates: string[]}}
 *   `source` is `"metadata"`, `"licence file: <name>"`, or `"unresolved"`.
 *   `candidates` lists what the texts looked like when they disagreed, so the
 *   manual-review section can say something useful instead of just "unknown".
 */
export function resolveLicense({ metadataLicense, licenseFiles = [] } = {}) {
  const declared = normalizeLicense(metadataLicense);
  if (declared !== null) return { license: declared, source: "metadata", candidates: [] };

  const files = Array.isArray(licenseFiles) ? licenseFiles : [];
  const sniffed = [];
  for (const entry of files) {
    const id = sniffLicenseFromText(entry?.text);
    if (id !== null) sniffed.push({ id, file: entry.file });
  }
  const distinct = [...new Set(sniffed.map((hit) => hit.id))].sort();
  if (distinct.length === 1) {
    return {
      license: distinct[0],
      source: `licence file: ${sniffed.find((hit) => hit.id === distinct[0]).file}`,
      candidates: [],
    };
  }
  return { license: null, source: "unresolved", candidates: distinct };
}

/**
 * Does this licence oblige us to reproduce its text in a binary distribution?
 * True unless EVERY term of the expression is a no-notice licence — an OR
 * expression is treated as requiring reproduction if any arm does, because
 * reproducing more than strictly necessary is never a violation.
 */
export function requiresTextReproduction(license) {
  if (typeof license !== "string" || license.trim() === "") return true;
  const terms = license.split(/\s+(?:OR|AND)\s+/i).map((term) => term.trim().replace(/^\(|\)$/g, ""));
  return terms.some((term) => !NO_ATTRIBUTION_REQUIRED.has(term));
}

/**
 * Compare `name@version` ids so `foo@9.0.0` sorts before `foo@10.0.0` (a plain
 * string compare would invert them). Numeric runs compare numerically, the rest
 * lexicographically. Total and deterministic — which is the property the
 * generated file depends on.
 */
export function compareIds(a, b) {
  const chunks = (value) => String(value).match(/\d+|\D+/g) ?? [];
  const left = chunks(a);
  const right = chunks(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const bothNumeric = /^\d+$/.test(l) && /^\d+$/.test(r);
    if (bothNumeric) {
      if (Number(l) !== Number(r)) return Number(l) - Number(r);
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Group resolved packages by licence. Groups are sorted by licence name and
 * packages by id — never by count, so that adding one package cannot reshuffle
 * the whole file and drown the real change in the diff.
 *
 * @returns {{license: string, entries: object[]}[]}
 */
export function groupByLicense(entries) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.license === null || entry.license === undefined) continue;
    if (!groups.has(entry.license)) groups.set(entry.license, []);
    groups.get(entry.license).push(entry);
  }
  return [...groups.entries()]
    .map(([license, group]) => ({
      license,
      entries: [...group].sort((a, b) => compareIds(a.id, b.id)),
    }))
    .sort((a, b) => compareIds(a.license, b.license));
}

/**
 * Pull the leading `/* ... *\/` comment out of C source. zlib ships its licence
 * as the header comment of `zlib.h` rather than as a separate file, so this is
 * how that notice gets reproduced verbatim instead of paraphrased.
 */
export function extractLeadingBlockComment(source) {
  if (typeof source !== "string") return null;
  const start = source.indexOf("/*");
  if (start === -1) return null;
  const end = source.indexOf("*/", start + 2);
  if (end === -1) return null;

  // Drop a per-line `*` gutter if the comment uses one, then de-indent by the
  // common leading whitespace so the notice reads as its authors wrote it.
  const lines = source
    .slice(start + 2, end)
    .split("\n")
    .map((line) => line.replace(/^[ \t]*\*[ \t]?/, "").replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return null;
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^[ \t]*/)[0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(common)).join("\n");
}

// ---------------------------------------------------------------------------
// Pure part 2 — the document model
// ---------------------------------------------------------------------------

/**
 * Turn raw package lists into everything the renderer needs, with the
 * bookkeeping the honesty rules demand.
 *
 * Licence texts are deduplicated by exact content and emitted once each, with
 * the packages that share them listed alongside. Without that, ~200 crates that
 * ship the identical 11 KB Apache-2.0 text would add 2 MB of byte-identical
 * boilerplate to a file meant to be reviewed by a person.
 */
export function buildModel({
  js = [],
  rust = [],
  rustMeta = {},
  vendoredC = [],
  vendoredAssets = [],
  sources = {},
} = {}) {
  const section = (entries, unit) => {
    const resolved = entries.filter((entry) => entry.license !== null);
    return {
      unit,
      total: entries.length,
      groups: groupByLicense(resolved),
      manualReview: entries
        .filter((entry) => entry.license === null)
        .sort((a, b) => compareIds(a.id, b.id)),
      missingText: resolved
        .filter((entry) => requiresTextReproduction(entry.license) && entry.texts.length === 0)
        .sort((a, b) => compareIds(a.id, b.id)),
      fromLicenceFile: resolved
        .filter((entry) => entry.source.startsWith("licence file"))
        .sort((a, b) => compareIds(a.id, b.id)),
    };
  };

  // Dedupe every licence text across BOTH ecosystems by exact content.
  const texts = new Map();
  for (const entry of [...js, ...rust]) {
    if (entry.license === null || !requiresTextReproduction(entry.license)) continue;
    for (const { file, text } of entry.texts) {
      const key = text;
      if (!texts.has(key)) texts.set(key, { text, licenses: new Set(), packages: [], files: new Set() });
      const record = texts.get(key);
      record.licenses.add(entry.license);
      record.files.add(file);
      record.packages.push(entry.id);
    }
  }
  const textBlocks = [...texts.values()]
    .map((record) => ({
      text: record.text,
      licenses: [...record.licenses].sort(compareIds),
      files: [...record.files].sort(),
      packages: [...new Set(record.packages)].sort(compareIds),
    }))
    // Sort by the first package that ships the text, then by the text itself:
    // total, content-derived, and independent of iteration order.
    .sort((a, b) => compareIds(a.packages[0], b.packages[0]) || compareText(a.text, b.text));

  return {
    js: section(js, "package"),
    rust: { ...section(rust, "crate"), ...rustMeta },
    vendoredC: [...vendoredC].sort((a, b) => compareIds(a.crate, b.crate)),
    vendoredAssets: [...vendoredAssets].sort((a, b) => compareIds(a.name, b.name)),
    texts: textBlocks,
    sources,
  };
}

const H = "\n";

/**
 * Render the model as Markdown. Deterministic by construction: every list is
 * pre-sorted by `buildModel`, and nothing here reads the clock, the process, or
 * the environment. That is what makes the file committable — a notice file that
 * churns on every run gets `-u`'d without being read.
 */
export function renderNotices(model) {
  const out = [];
  /**
   * Append lines, collapsing consecutive blank separators so an empty section
   * cannot leave a run of blank lines behind. Deliberately done HERE rather than
   * with a regex over the finished document: a blanket `\n{3,}` collapse would
   * silently rewrite the inside of a licence text, and a licence text must be
   * reproduced exactly.
   */
  const push = (...lines) => {
    for (const line of lines) {
      if (line === "" && out.length > 0 && out[out.length - 1] === "") continue;
      out.push(line);
    }
  };

  push("# Third-party notices");
  push("");
  push(
    "Agent Studio is distributed as a native desktop binary that statically links, bundles or embeds the",
    "third-party software listed below. MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 and Zlib all",
    "require their copyright notices to be reproduced in **binary** redistributions, so this file is part",
    "of the distribution, not documentation.",
  );
  push("");
  push("**Do not edit this file by hand — it is generated.** Regenerate it with:");
  push("");
  push("```bash");
  push("npm run attribution");
  push("```");
  push("");
  push("## How this list was produced, and what it does and does not cover");
  push("");
  push(
    `- **JavaScript — production dependencies only (${model.js.total} packages).** Walked from the committed`,
    "  `package-lock.json`, excluding every entry flagged `dev` or `devOptional`. Development tooling (test",
    "  runners, bundlers, linters, WebDriver) is not distributed, so nothing is owed for it and including it",
    "  would bury the packages that matter. The lockfile is the source rather than `npm ls` because it is",
    "  committed and deterministic, and because it ignores whatever happens to be extraneous in",
    "  `node_modules`.",
  );
  push(
    `- **Rust — the crates that actually ship (${model.rust.total} crates).** This is the *normal* (non-dev,`,
    `  non-build) dependency closure of the application crate for **${model.rust.target ?? "the shipped target"}**, taken from`,
    "  `cargo metadata --format-version 1 --filter-platform <triple>`. It is **not** the full resolved set:",
    `  \`src-tauri/Cargo.lock\` pins ${model.rust.totalResolved || "many"} crates across all platforms and dependency kinds. The difference is`,
    "  dev-only and build-only crates plus Tauri's Linux WebKitGTK/GTK backend, none of which is compiled",
    "  into a macOS build. `cargo metadata` performs no build, so this file can be generated without",
    "  touching the build tree.",
    "  **A Windows or Linux release must regenerate this file for that target** — the crate sets differ by",
    "  hundreds of entries.",
  );
  push(
    "- **Vendored C libraries** are listed separately, because crate metadata does not describe them: a",
    "  `-sys` crate declares its own Rust wrapper's licence, not the licence of the C it compiles.",
  );
  push(
    "- **Build-time-only code is excluded** where it can be identified (build scripts, proc-macro crates",
    "  reached only as build dependencies, dev dependencies). Anything reached as a normal dependency is",
    "  listed even if it turns out not to be linked — over-attribution is not a violation, omission is.",
  );
  push(
    "- **Nothing here is guessed.** A licence is taken from package metadata; when metadata declares none,",
    "  the package's own licence file is read and classified, and that is recorded. Anything still",
    "  unidentified is listed under *Needs manual review* rather than assigned a plausible licence.",
  );
  if (model.sources.notes?.length) {
    for (const note of model.sources.notes) push(`- ${note}`);
  }
  push("");

  // --- Summary table ------------------------------------------------------
  push("## Summary by licence");
  push("");
  const licences = [
    ...new Set([...model.js.groups.map((g) => g.license), ...model.rust.groups.map((g) => g.license)]),
  ].sort(compareIds);
  const jsCounts = new Map(model.js.groups.map((g) => [g.license, g.entries.length]));
  const rustCounts = new Map(model.rust.groups.map((g) => [g.license, g.entries.length]));
  push("| Licence | JS packages | Rust crates |");
  push("| --- | --- | --- |");
  for (const licence of licences) {
    push(`| ${licence} | ${jsCounts.get(licence) ?? 0} | ${rustCounts.get(licence) ?? 0} |`);
  }
  push(`| **total** | **${model.js.total}** | **${model.rust.total}** |`);
  push("");

  // --- Needs manual review ------------------------------------------------
  push("## Needs manual review");
  push("");
  const unresolved = [...model.js.manualReview, ...model.rust.manualReview];
  if (unresolved.length === 0) {
    push(
      "None. Every package and crate listed below has a licence taken either from its metadata or from its",
      "own licence file.",
    );
  } else {
    push(
      "The following declare no licence in metadata and their licence files could not be classified with",
      "certainty. **They are not attributed below.** Each needs a human to read the package and either",
      "record the licence or remove the dependency:",
    );
    push("");
    for (const entry of unresolved) {
      const hint = entry.candidates?.length
        ? ` — licence files matched more than one licence (${entry.candidates.join(", ")}); a human must say which applies`
        : entry.texts.length > 0
          ? ` — has licence file(s) (${entry.texts.map((t) => t.file).join(", ")}) that matched no known licence text`
          : " — no licence file found in the package either";
      push(`- \`${entry.id}\` (${entry.ecosystem})${hint}`);
    }
  }
  push("");

  // --- Resolved from a licence file --------------------------------------
  const fromFile = [...model.js.fromLicenceFile, ...model.rust.fromLicenceFile];
  if (fromFile.length > 0) {
    push("## Licences resolved by reading the licence file, not from metadata");
    push("");
    push(
      "These packages omit a `license` field but ship a licence text that identifies itself unambiguously.",
      "Recorded here so the resolution is visible rather than looking like declared metadata:",
    );
    push("");
    for (const entry of fromFile) {
      push(`- \`${entry.id}\` (${entry.ecosystem}) → **${entry.license}** (${entry.source})`);
    }
    push("");
  }

  // --- Missing texts ------------------------------------------------------
  const missing = [...model.js.missingText, ...model.rust.missingText];
  push("## Licence texts that could not be located");
  push("");
  if (missing.length === 0) {
    push("None — a licence text was found for every package whose licence requires reproduction.");
  } else {
    push(
      "These declare a licence that requires its text to be reproduced, but ship no licence file in the",
      "package/crate directory. Their declared licence is recorded below; the canonical text of that licence",
      "applies, with copyright held by the package's authors. Listed explicitly rather than omitted:",
    );
    push("");
    for (const entry of missing) {
      push(`- \`${entry.id}\` (${entry.ecosystem}) — declared **${entry.license}**, no licence file in the package`);
    }
  }
  push("");

  // --- Vendored C ---------------------------------------------------------
  if (model.vendoredC.length > 0) {
    push("## Vendored C/C++ libraries compiled into the binary");
    push("");
    push(
      "These are compiled from bundled source by their `-sys` crates. Crate metadata describes only the Rust",
      "wrapper's licence, so each library's own notice is reproduced here. (The same list drives the vendored-C",
      "version gate in `scripts/audit.mjs` — one source of truth for the C we compile.)",
    );
    push("");
    for (const lib of model.vendoredC) {
      push(`### ${lib.library}`);
      push("");
      push(`- Compiled by: \`${lib.crate} ${lib.crateVersion}\``);
      if (lib.cVersion) push(`- Upstream C version: **${lib.cVersion}**`);
      push(
        `- In the shipped macOS binary: ${
          lib.ships === true
            ? "yes"
            : lib.ships === false
              ? "no"
              : `${String(lib.ships)} — compiled only in some build configurations. See \`REVIEWED_VENDORED_C\` in ` +
                "`scripts/audit.mjs` for which ones, and for what is linked instead. The notice is reproduced " +
                "regardless, because reproducing more than strictly required is never a violation."
        }`,
      );
      for (const notice of lib.notices) {
        push("");
        push(`**${notice.label}**`);
        push("");
        if (notice.text === null) {
          push(
            `> The notice file \`${notice.file}\` could not be read (${notice.problem}). It must be reproduced`,
            "> before any public build — regenerate this file on a machine with the crate source unpacked.",
          );
        } else {
          const fence = fenceFor(notice.text);
          push(`${fence}text`);
          push(notice.text);
          push(fence);
        }
      }
      push("");
    }
  }

  // --- Vendored design assets --------------------------------------------
  if (model.vendoredAssets.length > 0) {
    push("## Vendored design assets");
    push("");
    push(
      "Artwork copied into the repository (not a package-manager dependency), so neither lockfile",
      "describes it. Each asset set's own licence is reproduced here. The list lives in",
      "`VENDORED_ASSETS` in `scripts/attribution.mjs`; the vendored copy of each licence also sits",
      "beside the assets themselves.",
    );
    push("");
    for (const asset of model.vendoredAssets) {
      push(`### ${asset.name}`);
      push("");
      push(`- Version: **${asset.version}** (commit \`${asset.commit}\`)`);
      push(`- Source: ${asset.source}`);
      push(`- Vendored under: \`${asset.dir}\``);
      if (asset.note) push(`- ${asset.note}`);
      push("");
      if (asset.licenseText === null) {
        push(
          `> The licence file \`${asset.licenseFile}\` could not be read (${asset.problem}). It must be`,
          "> reproduced before any public build — regenerate on a checkout that has the vendored assets.",
        );
      } else {
        const fence = fenceFor(asset.licenseText);
        push(`${fence}text`);
        push(asset.licenseText);
        push(fence);
      }
      push("");
    }
  }

  // --- Package listings ---------------------------------------------------
  push(`## JavaScript production dependencies (${model.js.total} packages)`);
  push("");
  renderGroups(push, model.js.groups, "package");

  push(`## Rust crates (${model.rust.total} crates, ${model.rust.target ?? "shipped target"} runtime graph)`);
  push("");
  renderGroups(push, model.rust.groups, "crate");

  // --- Licence texts ------------------------------------------------------
  push(`## Full licence texts (${model.texts.length} distinct texts)`);
  push("");
  push(
    "Identical texts are reproduced once and shared. Each block names every package that ships it, so no",
    "package's copyright notice is dropped — the deduplication is by content only.",
  );
  push("");
  model.texts.forEach((block, index) => {
    push(`### Text ${index + 1} — ${block.licenses.join(", ")}`);
    push("");
    push(`Shipped by ${block.packages.length} package(s): ${block.packages.map((id) => `\`${id}\``).join(", ")}`);
    push("");
    push(`Source file name(s): ${block.files.map((file) => `\`${file}\``).join(", ")}`);
    push("");
    const fence = fenceFor(block.text);
    push(`${fence}text`);
    push(block.text);
    push(fence);
    push("");
  });

  return `${out.join(H).trimEnd()}${H}`;
}

/** Cheap total order for long strings, used only as a sort tiebreak. */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A code fence long enough to contain `text` verbatim.
 *
 * Licence texts are reproduced inside fenced blocks, and a licence file that
 * happens to contain a ```-fence of its own would otherwise close the block
 * early and corrupt every section after it. No licence text in the tree does
 * that today — which is exactly why it must be handled here rather than
 * discovered later.
 */
export function fenceFor(text) {
  const longest = Math.max(0, ...(String(text ?? "").match(/^`{3,}/gm) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function renderGroups(push, groups, unit) {
  if (groups.length === 0) {
    push(`_No ${unit}s._`);
    push("");
    return;
  }
  for (const group of groups) {
    push(`### ${group.license} — ${group.entries.length} ${unit}${group.entries.length === 1 ? "" : "s"}`);
    push("");
    for (const entry of group.entries) {
      push(`- \`${entry.id}\`${entry.repository ? ` — ${entry.repository}` : ""}`);
    }
    push("");
  }
}

// ---------------------------------------------------------------------------
// Pure part 3 — reading the two dependency graphs
// ---------------------------------------------------------------------------

/**
 * The package name for a `package-lock.json` key. Keys are paths, so a nested
 * copy reads `node_modules/glob/node_modules/minimatch` — the name is whatever
 * follows the LAST `node_modules/`, which also keeps scopes (`@scope/pkg`)
 * intact. An explicit `name` field (npm writes one for aliased installs) wins.
 */
export function packageNameFromLockKey(key, entry = {}) {
  if (typeof entry.name === "string" && entry.name !== "") return entry.name;
  if (typeof key !== "string") return null;
  const marker = key.lastIndexOf("node_modules/");
  if (marker === -1) return null;
  const name = key.slice(marker + "node_modules/".length);
  return name === "" ? null : name;
}

/**
 * The production packages of a parsed `package-lock.json`, deduplicated by
 * `name@version`.
 *
 * `dev` and `devOptional` are both excluded: `devOptional` means "reachable
 * only from dev dependencies, and optional", so it does not ship either.
 * `optional` production entries ARE kept — an optional dependency that gets
 * installed is distributed.
 */
export function jsProdEntriesFromLock(lock) {
  const packages = lock && typeof lock === "object" ? (lock.packages ?? {}) : {};
  const byId = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || !entry || typeof entry !== "object") continue; // "" is the root project
    if (entry.dev === true || entry.devOptional === true) continue;
    if (entry.link === true) continue; // a symlink to another entry, counted there
    const name = packageNameFromLockKey(key, entry);
    if (name === null || typeof entry.version !== "string") continue;
    const id = `${name}@${entry.version}`;
    if (!byId.has(id)) {
      byId.set(id, { name, version: entry.version, id, license: entry.license, paths: [] });
    }
    byId.get(id).paths.push(key);
  }
  return [...byId.values()]
    .map((entry) => ({ ...entry, paths: [...entry.paths].sort() }))
    .sort((a, b) => compareIds(a.id, b.id));
}

/**
 * The normal (non-dev, non-build) dependency closure of the workspace root, out
 * of a `cargo metadata` payload. Build dependencies and dev dependencies are
 * dropped: build scripts run on the build host and never ship, and dev
 * dependencies are test-only.
 *
 * A `dep_kinds` entry with `kind: null` is cargo's encoding of "normal
 * dependency"; `"build"` and `"dev"` are the other two.
 */
export function rustRuntimeClosure(metadata) {
  const nodes = metadata?.resolve?.nodes;
  const root = metadata?.resolve?.root;
  if (!Array.isArray(nodes) || typeof root !== "string") return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const node = byId.get(queue.shift());
    if (!node || !Array.isArray(node.deps)) continue;
    for (const dep of node.deps) {
      const isNormal = (dep.dep_kinds ?? []).some((kind) => kind.kind === null || kind.kind === undefined);
      if (isNormal && !seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  seen.delete(root); // our own crate needs no attribution to ourselves
  const packages = Array.isArray(metadata.packages) ? metadata.packages : [];
  return packages.filter((pkg) => seen.has(pkg.id)).sort((a, b) => compareIds(`${a.name}@${a.version}`, `${b.name}@${b.version}`));
}

/** Normalise a repository declaration to a plain browsable https URL, or null. */
export function normalizeRepository(raw) {
  let url = null;
  if (typeof raw === "string") url = raw;
  else if (raw && typeof raw === "object" && typeof raw.url === "string") url = raw.url;
  if (url === null) return null;
  url = url.trim();
  if (url === "") return null;
  url = url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
  url = url.replace(/^git@([^:]+):/, "https://$1/");
  url = url.replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`; // npm shorthand
  return url;
}

// ---------------------------------------------------------------------------
// I/O + runner
// ---------------------------------------------------------------------------

/** Licence files in one directory, as `{file, text}`. Missing dir => []. */
function readLicenseFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
  const files = [];
  for (const file of pickLicenseFiles(names)) {
    const full = path.join(dir, file);
    try {
      // A licence text is never megabytes; a huge match is something else.
      if (fs.statSync(full).size > 512 * 1024) continue;
      files.push({ file, text: fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n").trimEnd() });
    } catch {
      /* unreadable: it simply does not contribute a text */
    }
  }
  return files;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function collectJs(repoRoot) {
  const lock = readJson(path.join(repoRoot, "package-lock.json"));
  if (lock === null) {
    fatal(`could not read or parse ${path.join(repoRoot, "package-lock.json")}`);
  }
  const notes = [];
  const entries = jsProdEntriesFromLock(lock).map((entry) => {
    const dir = path.join(repoRoot, entry.paths[0]);
    const manifest = readJson(path.join(dir, "package.json")) ?? {};
    const licenseFiles = readLicenseFiles(dir);
    const resolved = resolveLicense({
      metadataLicense: entry.license ?? manifest.license ?? manifest.licenses,
      licenseFiles,
    });
    return {
      ecosystem: "npm",
      name: entry.name,
      version: entry.version,
      id: entry.id,
      license: resolved.license,
      source: resolved.source,
      candidates: resolved.candidates,
      repository: normalizeRepository(manifest.repository),
      texts: licenseFiles,
    };
  });
  const installed = entries.filter((entry) => entry.texts.length > 0 || entry.repository !== null).length;
  if (installed < entries.length) {
    notes.push(
      `**${entries.length - installed} of ${entries.length} JS packages were not present in \`node_modules\`** when this file was ` +
        "generated, so no licence text could be read for them. Run `npm ci` and regenerate before shipping.",
    );
  }
  return { entries, notes };
}

function collectRust(repoRoot, target) {
  const manifestPath = path.join(repoRoot, "src-tauri", "Cargo.toml");
  const args = [
    "metadata",
    "--format-version",
    "1",
    "--manifest-path",
    manifestPath,
    "--filter-platform",
    target,
  ];
  // `cargo metadata` resolves and reads manifests. It does NOT compile, so this
  // is safe to run while another cargo process holds the build tree.
  const res = spawnSync("cargo", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    fatal(
      `\`cargo ${args.join(" ")}\` failed (${res.error ? res.error.message : `exit ${res.status}`}).\n` +
        (res.stderr ?? "").trim(),
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(res.stdout);
  } catch (err) {
    fatal(`could not parse cargo metadata output: ${err.message}`);
  }

  const entries = rustRuntimeClosure(metadata).map((pkg) => {
    const dir = path.dirname(pkg.manifest_path);
    const licenseFiles = readLicenseFiles(dir);
    const resolved = resolveLicense({ metadataLicense: pkg.license, licenseFiles });
    return {
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      id: `${pkg.name}@${pkg.version}`,
      license: resolved.license,
      source: resolved.source,
      candidates: resolved.candidates,
      repository: normalizeRepository(pkg.repository),
      texts: licenseFiles,
      dir,
    };
  });
  return {
    entries,
    // The honest denominator: how many crates the committed lockfile pins in
    // total, across every platform and dependency kind. `metadata.packages` here
    // is already platform-filtered, so using it would quietly compare a number
    // against itself.
    meta: {
      target,
      totalResolved: parseCargoLockPackages(
        (() => {
          try {
            return fs.readFileSync(path.join(repoRoot, "src-tauri", "Cargo.lock"), "utf8");
          } catch {
            return "";
          }
        })(),
      ).length,
    },
    // Crate directories, so the vendored-C notices can be located without
    // guessing at the cargo registry layout.
    dirs: new Map(entries.map((entry) => [entry.name, entry.dir])),
  };
}

/**
 * The bundled C libraries' own notices. Driven by `REVIEWED_VENDORED_C` in
 * `scripts/audit.mjs` — the same list the audit gate enforces versions against.
 * Entries whose crate is not in the graph are skipped: they are not compiled
 * into this artifact, so nothing is owed for them.
 */
function collectVendoredC(crateDirs) {
  const libs = [];
  for (const entry of REVIEWED_VENDORED_C) {
    if (!Array.isArray(entry.noticeFiles) || entry.noticeFiles.length === 0) continue;
    const dir = crateDirs.get(entry.crate);
    if (dir === undefined) continue; // not in the shipped graph
    const notices = entry.noticeFiles.map((notice) => {
      const file = path.join(dir, notice.file);
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      } catch (err) {
        return { ...notice, text: null, problem: err.message };
      }
      const text =
        notice.extract === "leading-block-comment" ? extractLeadingBlockComment(raw) : raw.trimEnd();
      return {
        ...notice,
        text: text === null ? null : text,
        problem: text === null ? `no leading comment block found in ${notice.file}` : null,
      };
    });
    libs.push({
      crate: entry.crate,
      crateVersion: entry.crateVersion,
      library: entry.library,
      cVersion: entry.cVersion,
      ships: entry.ships,
      notices,
    });
  }
  return libs;
}

/**
 * Design assets copied into the tree (no lockfile knows them). Declarative,
 * like `REVIEWED_VENDORED_C`: adding a vendored asset set means adding a row
 * here, and the generated notices then carry its licence durably — a section
 * hand-appended to the OUTPUT file would be deleted by the next regeneration,
 * which is exactly how the Material entry was first (and briefly) recorded.
 */
export const VENDORED_ASSETS = [
  {
    name: "Material Icon Theme (file-type icons)",
    version: "v5.37.0",
    commit: "850c06c7fb7ea73d873a0ce2f966bbd20850946d",
    source: "https://github.com/material-extensions/vscode-material-icon-theme (MIT, code and assets)",
    dir: "src/assets/file-icons",
    licenseFile: "src/assets/file-icons/LICENSE",
    note:
      "56 SVGs vendored unmodified; `file.svg` is authored by this repo (currentColor default glyph). " +
      "Language/tool logos may be trademarks of their owners; used nominatively to identify file types, " +
      "with no endorsement implied.",
  },
  {
    name: "Pixel Agents (pixel-art characters, floors, walls and furniture)",
    // One commit past the v1.4.1 tag (3537e14; #428 only bumps an e2e dependency, the art is
    // byte-identical) — the version names the commit actually vendored, `git describe` style.
    version: "v1.4.1-1-gd1e007a",
    commit: "d1e007a9fdf3003c252d2973abe1999ae59aec33",
    source: "https://github.com/pixel-agents-hq/pixel-agents (MIT)",
    dir: "src/assets/pixel-agents",
    licenseFile: "src/assets/pixel-agents/LICENSE",
    note:
      "32 PNGs vendored unmodified from `webview-ui/public/assets` (6 character sheets, 9 floors, 1 wall " +
      "auto-tile, 16 furniture sprites); recolouring happens at runtime. The character sheets derive from " +
      '"MetroCity – Free Topdown Character Pack" by JIK-A-4 (CC0 1.0, ' +
      "https://jik-a-4.itch.io/metrocity-free-topdown-character-pack), credited with thanks. Pets and " +
      "third-party tilesets are not vendored; outdoor art is this repo's own.",
  },
];

/** Read each declared asset set's licence off disk (the C-notices pattern: unreadable → text null + problem, rendered loudly). */
function collectVendoredAssets(repoRoot) {
  return VENDORED_ASSETS.map((asset) => {
    try {
      return {
        ...asset,
        licenseText: fs.readFileSync(path.join(repoRoot, asset.licenseFile), "utf8").replace(/\r\n/g, "\n").trimEnd(),
        problem: null,
      };
    } catch (err) {
      return { ...asset, licenseText: null, problem: err.message };
    }
  });
}

function fatal(message) {
  console.error(`\n[FAIL] could not generate ${OUTPUT_FILE}: ${message}`);
  console.error("[FAIL] refusing to write a partial attribution file.\n");
  process.exit(1);
}

function main(argv = process.argv.slice(2)) {
  const repoRoot = process.cwd();
  const targetArg = argv.indexOf("--target");
  const target = targetArg !== -1 && argv[targetArg + 1] ? argv[targetArg + 1] : DEFAULT_RUST_TARGET;

  console.log(`Generating ${OUTPUT_FILE}`);
  console.log(`  JS   : production tree from package-lock.json (dev/devOptional excluded)`);
  console.log(`  Rust : normal dependency closure for ${target} via \`cargo metadata\` (no build)`);

  const js = collectJs(repoRoot);
  const rust = collectRust(repoRoot, target);
  const vendoredC = collectVendoredC(rust.dirs);
  const vendoredAssets = collectVendoredAssets(repoRoot);

  const model = buildModel({
    js: js.entries,
    rust: rust.entries,
    rustMeta: rust.meta,
    vendoredC,
    vendoredAssets,
    sources: { notes: js.notes },
  });
  const markdown = renderNotices(model);
  const outPath = path.join(repoRoot, OUTPUT_FILE);
  fs.writeFileSync(outPath, markdown, "utf8");

  const bytes = Buffer.byteLength(markdown, "utf8");
  console.log(`\n  wrote ${outPath} (${bytes.toLocaleString("en-US")} bytes)`);
  console.log(`  JS packages        : ${model.js.total} in ${model.js.groups.length} licence group(s)`);
  console.log(
    `  Rust crates        : ${model.rust.total} in ${model.rust.groups.length} licence group(s) ` +
      `(of ${model.rust.totalResolved} pinned in Cargo.lock for all platforms/kinds)`,
  );
  console.log(`  vendored C         : ${model.vendoredC.length} librar(y/ies) with their own notice`);
  console.log(`  vendored assets    : ${model.vendoredAssets.length} set(s) with their own licence`);
  console.log(`  distinct texts     : ${model.texts.length}`);
  console.log(
    `  needs manual review: ${model.js.manualReview.length + model.rust.manualReview.length}` +
      (model.js.manualReview.length + model.rust.manualReview.length > 0
        ? ` -> ${[...model.js.manualReview, ...model.rust.manualReview].map((e) => e.id).join(", ")}`
        : ""),
  );
  console.log(
    `  texts not located  : ${model.js.missingText.length + model.rust.missingText.length} ` +
      "(declared licence recorded; listed in the file)",
  );
}

// Importing this module (the tests do) must never shell out or write files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
