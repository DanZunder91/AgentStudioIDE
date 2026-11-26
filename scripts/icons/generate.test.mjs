/** Drift: the committed *.generated.ts must match the generator byte for byte. Sanitization: the
 * sprite is injected as raw HTML, so hostile SVG (scripts, handlers, external refs) must fail. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { MAPPING, UPSTREAM } from "./mapping.mjs";
import {
  ICON_MAP_FILE,
  OUT_DIR,
  SPRITE_FILE,
  SVG_DIR,
  cleanSvg,
  generateArtifacts,
  readSvgSources,
  validateMapping,
} from "./generate.mjs";
import { ICON_MAP } from "../../src/lib/fileIcons/iconMap.generated.ts";
import { FILE_ICON_SPRITE, SPRITE_ICON_IDS } from "../../src/lib/fileIcons/sprite.generated.ts";
import { LANGUAGE_LABELS } from "../../src/lib/language/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENERATOR = path.join(REPO_ROOT, "scripts", "icons", "generate.mjs");

const realSvgSources = () => readSvgSources(path.join(REPO_ROOT, SVG_DIR));

/** A minimal, benign icon set + mapping for the validation/hostility tests. */
const tinySvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#123456" d="M2 2h12v12H2z"/></svg>';
const tinyMapping = (overrides = {}) => ({
  fileNames: {},
  fileExtensions: {},
  languageIds: {},
  defaultFile: "file",
  ...overrides,
});

describe("drift — committed artifacts vs regeneration", () => {
  it("the pure generator reproduces both committed files byte-for-byte", () => {
    const { files } = generateArtifacts({ svgSources: realSvgSources() });
    for (const name of [ICON_MAP_FILE, SPRITE_FILE]) {
      const committed = fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, name), "utf8");
      expect(files[name], `${name} drifted — run \`node scripts/icons/generate.mjs\` and commit`).toBe(committed);
    }
  });

  it("the CLI writing into a temp dir produces byte-identical output too", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-icons-"));
    try {
      const res = spawnSync(process.execPath, [GENERATOR, "--out", tmp], { encoding: "utf8" });
      expect(res.status, res.stderr).toBe(0);
      for (const name of [ICON_MAP_FILE, SPRITE_FILE]) {
        const committed = fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, name), "utf8");
        expect(fs.readFileSync(path.join(tmp, name), "utf8")).toBe(committed);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("generation is deterministic — two runs emit identical bytes", () => {
    const a = generateArtifacts({ svgSources: realSvgSources() });
    const b = generateArtifacts({ svgSources: realSvgSources() });
    expect(a.files[ICON_MAP_FILE]).toBe(b.files[ICON_MAP_FILE]);
    expect(a.files[SPRITE_FILE]).toBe(b.files[SPRITE_FILE]);
  });
});

describe("mapping ↔ vendored SVGs", () => {
  it("every mapping value (all three tables + defaultFile) has a vendored SVG", () => {
    const values = [
      ...Object.values(MAPPING.fileNames),
      ...Object.values(MAPPING.fileExtensions),
      ...Object.values(MAPPING.languageIds),
      MAPPING.defaultFile,
    ];
    for (const id of values) {
      const file = path.join(REPO_ROOT, SVG_DIR, `${id}.svg`);
      expect(fs.existsSync(file), `mapping references "${id}" but ${file} is missing`).toBe(true);
    }
  });

  it("a mapping value pointing at a nonexistent icon id fails validation", () => {
    expect(() =>
      validateMapping(tinyMapping({ fileExtensions: { rs: "no-such-icon" } }), new Set(["file"])),
    ).toThrow(/no-such-icon/);
  });

  it("a vendored SVG referenced by nothing fails validation (no dead assets)", () => {
    expect(() => validateMapping(tinyMapping(), new Set(["file", "orphan"]))).toThrow(/orphan.*referenced by nothing/);
  });

  it("non-lowercase keys and leading-dot extensions fail validation", () => {
    expect(() =>
      validateMapping(tinyMapping({ fileNames: { "Cargo.toml": "file" } }), new Set(["file"])),
    ).toThrow(/not lowercase/);
    expect(() =>
      validateMapping(tinyMapping({ fileExtensions: { ".rs": "file" } }), new Set(["file"])),
    ).toThrow(/leading dot/);
  });
});

describe("the committed sprite", () => {
  it("symbol ids are unique, mi-prefixed, and each symbol carries a viewBox", () => {
    const symbols = [...FILE_ICON_SPRITE.matchAll(/<symbol ([^>]*)>/g)].map((m) => m[1]);
    expect(symbols.length).toBe(SPRITE_ICON_IDS.length);
    const ids = symbols.map((attrs) => {
      const id = attrs.match(/^id="([^"]+)"/)?.[1];
      expect(id, `symbol has no leading id attribute: <symbol ${attrs}>`).toMatch(/^mi-[a-z0-9][a-z0-9_-]*$/);
      expect(attrs, `symbol ${id} has no viewBox`).toMatch(/ viewBox="[^"]+"/);
      return id;
    });
    expect(new Set(ids).size).toBe(ids.length);
    // SPRITE_ICON_IDS is exactly the symbol list, without the prefix, sorted.
    expect(ids).toEqual(SPRITE_ICON_IDS.map((id) => `mi-${id}`));
    expect([...SPRITE_ICON_IDS].sort()).toEqual([...SPRITE_ICON_IDS]);
  });

  it("has the fixed sprite root and nothing outside it", () => {
    expect(FILE_ICON_SPRITE.startsWith('<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">')).toBe(true);
    expect(FILE_ICON_SPRITE.endsWith("</svg>")).toBe(true);
  });

  it("contains no script/event-handler/external-reference content", () => {
    for (const pattern of [/<script\b/i, /\son[a-z]+\s*=/i, /javascript:/i, /<foreignobject\b/i]) {
      expect(FILE_ICON_SPRITE).not.toMatch(pattern);
    }
  });
});

describe("the committed icon map", () => {
  it("defaultFile is a sprite symbol", () => {
    expect(SPRITE_ICON_IDS).toContain(ICON_MAP.defaultFile);
  });

  it("every icon id in the map is a sprite symbol", () => {
    const ids = new Set(SPRITE_ICON_IDS);
    for (const table of ["fileNames", "fileExtensions", "languageIds"]) {
      for (const [key, id] of Object.entries(ICON_MAP[table])) {
        expect(ids.has(id), `ICON_MAP.${table}["${key}"] -> "${id}" is not in the sprite`).toBe(true);
      }
    }
  });

  it("every languageIds key is a member of the real LanguageId union", () => {
    // LANGUAGE_LABELS is the runtime image of the LanguageId union — a key per
    // member, enforced by its Record<LanguageId, string> type.
    const union = new Set(Object.keys(LANGUAGE_LABELS));
    for (const key of Object.keys(ICON_MAP.languageIds)) {
      expect(union.has(key), `languageIds key "${key}" is not a LanguageId`).toBe(true);
    }
  });

  it("all keys are pre-lowercased and extensions carry no leading dot", () => {
    for (const table of ["fileNames", "fileExtensions", "languageIds"]) {
      for (const key of Object.keys(ICON_MAP[table])) {
        expect(key).toBe(key.toLowerCase());
      }
    }
    for (const key of Object.keys(ICON_MAP.fileExtensions)) {
      expect(key.startsWith(".")).toBe(false);
    }
  });

  it("both generated files carry the pinned upstream tag in their header", () => {
    for (const name of [ICON_MAP_FILE, SPRITE_FILE]) {
      const committed = fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, name), "utf8");
      expect(committed).toContain("GENERATED — do not edit");
      expect(committed).toContain(`upstream ${UPSTREAM.tag}`);
    }
  });
});

describe("the sanitization gate — hostile SVG fixtures fail generation", () => {
  const attempt = (svg) => () =>
    generateArtifacts({ mapping: tinyMapping(), svgSources: { file: svg } });

  it("accepts the benign control fixture", () => {
    expect(attempt(tinySvg)).not.toThrow();
  });

  it("rejects a <script> element", () => {
    expect(attempt('<svg viewBox="0 0 16 16"><script>alert(1)</script><path d="M0 0h1"/></svg>')).toThrow(
      /script/i,
    );
  });

  it("rejects an inline event handler (onload=)", () => {
    expect(attempt('<svg viewBox="0 0 16 16"><path onload="alert(1)" d="M0 0h1"/></svg>')).toThrow(
      /event handler/i,
    );
  });

  it("rejects a <script> reassembled across a stripped comment", () => {
    expect(attempt('<svg viewBox="0 0 16 16"><scr<!-- x -->ipt>alert(1)</script></svg>')).toThrow(/script/i);
  });

  it("rejects a javascript: URL", () => {
    expect(attempt('<svg viewBox="0 0 16 16"><a href="javascript:alert(1)"><path d="M0 0h1"/></a></svg>')).toThrow(
      /javascript:/i,
    );
  });

  it("rejects non-fragment href references (network / file / data:)", () => {
    expect(attempt('<svg viewBox="0 0 16 16"><image href="https://evil.example/x.png"/></svg>')).toThrow(
      /href/i,
    );
  });

  it("rejects a foreignObject", () => {
    expect(attempt('<svg viewBox="0 0 16 16"><foreignObject><div>x</div></foreignObject></svg>')).toThrow(
      /foreignObject/i,
    );
  });

  it("rejects a DOCTYPE with an internal subset (ENTITY smuggling)", () => {
    expect(
      attempt('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 16 16"><path d="M0 0h1"/></svg>'),
    ).toThrow(/markup declaration/i);
  });

  it("rejects an SVG without a viewBox", () => {
    expect(attempt('<svg width="16" height="16"><path d="M0 0h1"/></svg>')).toThrow(/viewBox/);
  });
});

describe("cleanSvg", () => {
  it("strips xml declaration, comments and simple DOCTYPEs, keeps root attrs", () => {
    const { attrs, inner } = cleanSvg(
      '<?xml version="1.0"?><!DOCTYPE svg><!-- note --><svg xmlns="http://www.w3.org/2000/svg" fill="none" width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h1"/></svg>',
      "x.svg",
    );
    expect(attrs.get("viewBox")).toBe("0 0 24 24");
    expect(attrs.get("fill")).toBe("none");
    // width/height/xmlns are the consuming element's business, not the symbol's.
    expect(attrs.has("width")).toBe(false);
    expect(attrs.has("height")).toBe(false);
    expect(attrs.has("xmlns")).toBe(false);
    expect(inner).toBe('<path d="M0 0h1"/>');
  });
});
