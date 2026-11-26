#!/usr/bin/env node
/** Generates the file-icon *.generated.ts from mapping.mjs and the vendored SVGs (file-icons.md).
 * THE SANITIZATION GATE: the sprite is injected as raw HTML, so hostile SVG must fail here. Output
 * is deterministic for the drift test; `--out <dir>` writes elsewhere. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAPPING, UPSTREAM } from "./mapping.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the vendored SVGs live, relative to the repo root. */
export const SVG_DIR = path.join("src", "assets", "file-icons", "svg");
/** Where the generated TS goes, relative to the repo root. */
export const OUT_DIR = path.join("src", "lib", "fileIcons");

export const ICON_MAP_FILE = "iconMap.generated.ts";
export const SPRITE_FILE = "sprite.generated.ts";

/** Symbol ids become DOM ids (`mi-<id>`); keep them boring and collision-free. */
const ICON_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Matched case-insensitively AFTER comment stripping, so `<scr<!-- -->ipt>` cannot reassemble;
 * `href`/`src` may only point at a local fragment. */
const HOSTILE = [
  ["a <script> element", /<script\b/i],
  ["an inline event handler (on*=)", /\son[a-z]+\s*=/i],
  ["a javascript: URL", /javascript:/i],
  ["a <foreignObject> element", /<foreignobject\b/i],
  ["an <iframe>/<embed>/<object> element", /<(?:iframe|embed|object)\b/i],
  ["a non-fragment href/src reference", /\b(?:href|src)\s*=\s*(?:"(?!#)|'(?!#))/i],
  ["an external or data: url() reference", /url\s*\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)/i],
];

class GenerateError extends Error {}

const fail = (message) => {
  throw new GenerateError(`icons generator: ${message}`);
};

/** Throws on anything that cannot be safely inlined into the sprite. */
export function cleanSvg(source, name) {
  let s = String(source).replace(/^\uFEFF/, "");
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // A simple DOCTYPE is stripped; one with an internal subset (`[` — where
  // ENTITY declarations live) is refused outright.
  s = s.replace(/<!DOCTYPE\s[^>[]*>/gi, "");
  if (/<!/.test(s)) fail(`${name}: contains a markup declaration ("<!...") after cleanup — refusing to inline it`);
  for (const [what, pattern] of HOSTILE) {
    if (pattern.test(s)) fail(`${name}: contains ${what} — the sprite is injected as raw HTML, refusing to inline it`);
  }
  s = s.trim();

  const open = s.match(/^<svg\b([^>]*)>/i);
  if (!open || !/<\/svg>\s*$/i.test(s)) fail(`${name}: does not parse as a single <svg>...</svg> document`);
  const inner = s
    .slice(open[0].length, s.lastIndexOf("</"))
    .replace(/>\s+</g, "><")
    .trim();
  if (inner === "") fail(`${name}: has no drawable content`);

  const attrs = new Map();
  for (const match of open[1].matchAll(/([:a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.set(match[1], match[2] ?? match[3] ?? "");
  }
  if (!attrs.has("viewBox")) fail(`${name}: root <svg> has no viewBox — <use> scaling would break`);
  // Sizing and namespace live on the sprite root / the consuming <svg>, not on
  // the symbol; everything else (fill="none", etc.) is semantic and kept.
  for (const key of [...attrs.keys()]) {
    if (key === "width" || key === "height" || key === "id" || key.startsWith("xmlns")) attrs.delete(key);
  }
  return { attrs, inner };
}

/** One `<symbol>` element, attributes in deterministic order (viewBox first). */
export function toSymbol(id, { attrs, inner }) {
  const rest = [...attrs.keys()]
    .filter((key) => key !== "viewBox")
    .sort()
    .map((key) => ` ${key}="${attrs.get(key)}"`)
    .join("");
  return `<symbol id="mi-${id}" viewBox="${attrs.get("viewBox")}"${rest}>${inner}</symbol>`;
}

/** Both directions: a mapped id without an SVG breaks a lookup; an unreferenced SVG ships dead. */
export function validateMapping(mapping, availableIds) {
  const referenced = new Set();
  const tables = ["fileNames", "fileExtensions", "languageIds"];
  for (const table of tables) {
    const record = mapping[table];
    if (record === null || typeof record !== "object") fail(`mapping.${table} is missing or not an object`);
    for (const [key, value] of Object.entries(record)) {
      if (key !== key.toLowerCase()) fail(`mapping.${table} key "${key}" is not lowercase — lookups are pre-lowercased`);
      if (table === "fileExtensions" && key.startsWith(".")) fail(`mapping.fileExtensions key "${key}" carries a leading dot`);
      if (typeof value !== "string" || !availableIds.has(value)) {
        fail(`mapping.${table}["${key}"] -> "${value}" has no vendored ${path.join(SVG_DIR, `${value}.svg`)}`);
      }
      referenced.add(value);
    }
  }
  if (typeof mapping.defaultFile !== "string" || !availableIds.has(mapping.defaultFile)) {
    fail(`mapping.defaultFile "${mapping.defaultFile}" has no vendored SVG`);
  }
  referenced.add(mapping.defaultFile);
  for (const id of [...availableIds].sort()) {
    if (!ICON_ID.test(id)) fail(`vendored svg id "${id}" is not a safe symbol id (${ICON_ID})`);
    if (!referenced.has(id)) fail(`vendored ${path.join(SVG_DIR, `${id}.svg`)} is referenced by nothing in the mapping — remove it or map it`);
  }
}

const sortRecord = (record) =>
  Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));

/** A single-quoted TS string literal (the SVG markup is full of `"`). */
const sq = (text) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const recordTs = (record, indent) => {
  const entries = Object.entries(record).map(
    ([key, value]) => `${indent}  ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
  );
  return `{\n${entries.join("\n")}\n${indent}}`;
};

const header = (what) =>
  `/** GENERATED — do not edit: \`node scripts/icons/generate.mjs\` from scripts/icons/mapping.mjs
 * and the SVGs in ${SVG_DIR.split(path.sep).join("/")} (upstream ${UPSTREAM.tag}).
 * ${what} */`;

/** Pure and deterministic: every collection is sorted before emission. */
export function generateArtifacts({ mapping = MAPPING, svgSources }) {
  const availableIds = new Set(Object.keys(svgSources));
  validateMapping(mapping, availableIds);

  const ids = [...availableIds].sort();
  const symbols = ids.map((id) => toSymbol(id, cleanSvg(svgSources[id], `${id}.svg`)));
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(`mi-${id}`)) fail(`duplicate sprite symbol id "mi-${id}"`);
    seen.add(`mi-${id}`);
  }

  const spriteTs = `${header(
    "One inline SVG sprite (file-icons.md §4): each icon is a `<symbol id=\"mi-<id>\">` for `<use>`.",
  )}

export const FILE_ICON_SPRITE: string =
  ${sq('<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">')} +
${symbols.map((symbol) => `  ${sq(symbol)} +`).join("\n")}
  "</svg>";

/** Every symbol id in the sprite, WITHOUT the "mi-" prefix — for validation tests. */
export const SPRITE_ICON_IDS: readonly string[] = [
${ids.map((id) => `  ${JSON.stringify(id)},`).join("\n")}
];
`;

  const iconMapTs = `${header("The `<FileIcon>` lookup tables (file-icons.md §3 ladder).")}

export interface IconMap {
  /** exact lowercased basename → icon id, e.g. "cargo.toml" → "rust" */
  fileNames: Record<string, string>;
  /** lowercased extension WITHOUT leading dot; compound allowed ("d.ts", "test.ts") */
  fileExtensions: Record<string, string>;
  /** LanguageId (src/lib/language) → icon id; partial — unmapped ids fall through */
  languageIds: Record<string, string>;
  /** the total-function fallback symbol id */
  defaultFile: string;
}

export const ICON_MAP: IconMap = {
  fileNames: ${recordTs(sortRecord(mapping.fileNames), "  ")},
  fileExtensions: ${recordTs(sortRecord(mapping.fileExtensions), "  ")},
  languageIds: ${recordTs(sortRecord(mapping.languageIds), "  ")},
  defaultFile: ${JSON.stringify(mapping.defaultFile)},
};
`;

  return {
    files: { [ICON_MAP_FILE]: iconMapTs, [SPRITE_FILE]: spriteTs },
    ids,
    spriteBytes: Buffer.byteLength(spriteTs, "utf8"),
  };
}

/** Read every `<id>.svg` in a directory into `{id: source}`. */
export function readSvgSources(svgDir) {
  let names;
  try {
    names = fs.readdirSync(svgDir);
  } catch (err) {
    fail(`cannot read ${svgDir}: ${err.message}`);
  }
  const sources = {};
  for (const name of names.sort()) {
    if (!name.endsWith(".svg")) fail(`${path.join(svgDir, name)}: only .svg files belong in the vendored icon directory`);
    sources[name.slice(0, -".svg".length)] = fs.readFileSync(path.join(svgDir, name), "utf8");
  }
  return sources;
}

function main(argv = process.argv.slice(2)) {
  const outFlag = argv.indexOf("--out");
  const outDir =
    outFlag !== -1 && argv[outFlag + 1] ? path.resolve(argv[outFlag + 1]) : path.join(REPO_ROOT, OUT_DIR);

  const svgSources = readSvgSources(path.join(REPO_ROOT, SVG_DIR));
  const { files, ids } = generateArtifacts({ svgSources });

  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), body, "utf8");
    console.log(`  wrote ${path.join(outDir, name)} (${Buffer.byteLength(body, "utf8").toLocaleString("en-US")} bytes)`);
  }
  console.log(`  ${ids.length} icons from ${UPSTREAM.tag} (${UPSTREAM.commit.slice(0, 7)})`);
}

// Importing this module (the tests do) must never write files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    if (err instanceof GenerateError) {
      console.error(`\n[FAIL] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
