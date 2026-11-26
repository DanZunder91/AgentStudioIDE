/** Ladder tests use a hand-written fixture map whose tier-named entries disagree with the tiers
 * below, so a reordering turns red. Tier 5 uses the REAL `detectLanguage`: the detector is
 * authoritative for ambiguous and extensionless files. */

import { describe, expect, it } from "vitest";

import type { IconMap } from "./iconMap.generated";
import { resolveFileIconId } from "./resolveIconId";

const FIXTURE: IconMap = {
  fileNames: {
    "cargo.toml": "name-cargo",
    ".gitignore": "name-gitignore",
    "a.d.ts": "name-exact-dts",
  },
  fileExtensions: {
    // compound (tier 4) — both lengths present so longest-first is observable
    "test.d.ts": "ext-test-dts",
    "d.ts": "ext-dts",
    // singles (tier 6) — each shadowed by a HIGHER tier somewhere above
    toml: "ext-toml",
    ts: "ext-ts",
    mk: "ext-mk",
    md: "ext-md",
    zzz: "ext-zzz",
  },
  languageIds: {
    // real LanguageIds (tier 5 keys come from detectLanguage)
    makefile: "lang-makefile",
    typescript: "lang-typescript",
  },
  defaultFile: "fixture-default",
};

const resolve = (name: string) => resolveFileIconId(name, FIXTURE);

describe("resolveFileIconId — precedence (each tier beats every tier below it)", () => {
  it("tier 3: exact basename beats compound ext, languageId and single ext", () => {
    // "a.d.ts" is ALSO a "d.ts" compound hit, a typescript languageId hit and
    // a "ts" single-ext hit — the exact-name entry must win over all three.
    expect(resolve("a.d.ts")).toBe("name-exact-dts");
    expect(resolve("cargo.toml")).toBe("name-cargo");
  });

  it("tier 4: compound extension beats the languageId tier (role over language)", () => {
    // detectLanguage("x.d.ts") → "typescript", mapped in the fixture — but the
    // compound "d.ts" encodes the DECLARATION role and must win (§3 tie-break).
    expect(resolve("x.d.ts")).toBe("ext-dts");
  });

  it("tier 5: languageId beats the bare single extension", () => {
    // detectLanguage("build.mk") → "makefile"; the fixture maps BOTH the
    // languageId and the "mk" single ext, disagreeing — the detector wins.
    expect(resolve("build.mk")).toBe("lang-makefile");
  });

  it("tier 5: the detector is authoritative for extensionless files", () => {
    // "makefile" is NOT in the fixture's fileNames and has no extension at
    // all — only detectLanguage("makefile") → "makefile" can place it.
    expect(resolve("makefile")).toBe("lang-makefile");
  });

  it("tier 6: single extension resolves when every higher tier misses", () => {
    // detectLanguage("notes.zzz") → "plaintext", unmapped in languageIds.
    expect(resolve("notes.zzz")).toBe("ext-zzz");
  });
});

describe("resolveFileIconId — compound-suffix probing (longest dotted suffix first)", () => {
  it('probes "test.d.ts" before "d.ts" for "a.test.d.ts"', () => {
    expect(resolve("a.test.d.ts")).toBe("ext-test-dts");
  });

  it("walks past a missing longer suffix to a shorter compound hit", () => {
    // "spec.d.ts" is not in the fixture → the walk continues to "d.ts".
    expect(resolve("b.spec.d.ts")).toBe("ext-dts");
  });
});

describe("resolveFileIconId — dotfile basenames", () => {
  it('".gitignore" resolves by exact name at tier 3', () => {
    expect(resolve(".gitignore")).toBe("name-gitignore");
  });

  it('".unknownrc" falls to the default without any empty-suffix probe', () => {
    // Its only dot is leading: no compound suffix exists, "unknownrc" is an
    // unknown single ext, and detectLanguage says plaintext (unmapped).
    expect(resolve(".unknownrc")).toBe("fixture-default");
  });
});

describe("resolveFileIconId — case-insensitivity", () => {
  it("lowercases the basename before the exact-name lookup", () => {
    expect(resolve("Cargo.TOML")).toBe("name-cargo");
  });

  it("lowercases extensions (compound and single)", () => {
    expect(resolve("X.D.TS")).toBe("ext-dts");
    // "readme.md" is not a fixture fileName and markdown is not a fixture
    // languageId → this exercises the SINGLE-ext lookup's lowercasing.
    expect(resolve("README.MD")).toBe("ext-md");
  });
});

describe("resolveFileIconId — total function (every input lands on defaultFile)", () => {
  it("extensionless unknown name", () => {
    expect(resolve("weird")).toBe("fixture-default");
  });

  it("empty string", () => {
    expect(resolve("")).toBe("fixture-default");
  });

  it('trailing-dot name ("foo.") never probes the empty extension', () => {
    expect(resolve("foo.")).toBe("fixture-default");
  });
});

// ── REAL ICON_MAP: an empty or placeholder map resolves these to defaultFile, so they prove the
// generated table is wired in. Ids follow the vendored Material Icon Theme's vocabulary.
describe("REAL ICON_MAP integration expectations", () => {
  it('"cargo.toml" → "rust"', () => {
    expect(resolveFileIconId("cargo.toml")).toBe("rust");
  });

  it('"pom.xml" → "maven"', () => {
    expect(resolveFileIconId("pom.xml")).toBe("maven");
  });

  it('"dockerfile" → "docker"', () => {
    expect(resolveFileIconId("dockerfile")).toBe("docker");
  });

  it('"x.kt" → "kotlin"', () => {
    expect(resolveFileIconId("x.kt")).toBe("kotlin");
  });
});
