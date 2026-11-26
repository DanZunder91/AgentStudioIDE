import { bundledLanguages } from "shiki";
import { describe, expect, it } from "vitest";

import { LANGUAGE_LABELS, type LanguageId } from "../../lib/language";
import { languageToShiki } from "./grammar";

describe("languageToShiki", () => {
  it("passes the core / DoD languages straight through to their Shiki id", () => {
    const passthrough: LanguageId[] = [
      "rust",
      "kotlin",
      "sql",
      "cpp",
      "java",
      "json",
      "markdown",
      "html",
      "css",
      "javascript",
      "typescript",
      "python",
    ];
    for (const id of passthrough) {
      expect(languageToShiki(id)).toBe(id);
    }
  });

  it("remaps the ids whose Shiki grammar name differs", () => {
    expect(languageToShiki("shell")).toBe("bash");
    expect(languageToShiki("dockerfile")).toBe("docker");
    expect(languageToShiki("makefile")).toBe("make");
    expect(languageToShiki("properties")).toBe("ini");
    // Same language under a different Shiki id — each verified against the real
    // grammar's scope, not guessed: source.rst, source.v, source.asm.*, source.wat.
    expect(languageToShiki("restructuredtext")).toBe("rst");
    expect(languageToShiki("vlang")).toBe("v");
    expect(languageToShiki("assembly")).toBe("asm");
    expect(languageToShiki("wat")).toBe("wasm");
  });

  it("returns null for ids Shiki cannot highlight (→ plaintext)", () => {
    expect(languageToShiki("plaintext")).toBeNull();
    expect(languageToShiki("gitignore")).toBeNull();
    expect(languageToShiki("dotenv")).toBeNull();
    expect(languageToShiki("git-config")).toBeNull();
    expect(languageToShiki("go-module")).toBeNull();
  });

  /** Shiki ships no `svg` grammar, so a pass-through id silently rendered plaintext; SVG is XML. */
  it("maps svg onto Shiki's xml grammar rather than a nonexistent svg one", () => {
    expect(languageToShiki("svg")).toBe("xml");
    expect(bundledLanguages).not.toHaveProperty("svg");
    expect(bundledLanguages).toHaveProperty("xml");
  });

  /** Reads the real `bundledLanguages` (lazy loaders, no grammar cost) so it can't pass vacuously.
   * KNOWN_GAPS: ids with no unambiguous Shiki grammar; delete a row once its alias is added. */
  it("resolves every LanguageId to a real Shiki grammar or to null", () => {
    const KNOWN_GAPS: Partial<Record<LanguageId, string>> = {
      // Shiki splits Fortran into `fortran-free-form` and `fortran-fixed-form`;
      // our single `fortran` id covers BOTH (.f/.for are fixed, .f90/.f95/.f03
      // are free), so no one alias is right. Needs a detection-level split.
      fortran: "no single grammar: fortran-free-form vs fortran-fixed-form",
      // Shiki has `wolfram` (aliases: `wl`). Wolfram Language is Mathematica's
      // language, but the ids are not the same word and nothing here has been
      // verified against a real .nb/.wl file — a deliberate judgement call.
      mathematica: "candidate: wolfram — same language, different name",
      // Mercury is NOT Prolog (Shiki's nearest grammar). Aliasing them would
      // mis-highlight rather than not highlight.
      mercury: "no grammar; prolog is a different language",
      // Shiki ships nothing for these at all.
      org: "no grammar in Shiki",
      rebol: "no grammar in Shiki",
    };

    // LANGUAGE_LABELS is `Record<LanguageId, string>`, so its keys are the
    // exhaustive id list — tsc fails if a new id is ever added without one.
    const missing: string[] = [];
    for (const id of Object.keys(LANGUAGE_LABELS) as LanguageId[]) {
      if (id in KNOWN_GAPS) continue;
      const shikiId = languageToShiki(id);
      if (shikiId === null) continue;
      if (!(shikiId in bundledLanguages)) missing.push(`${id} -> ${shikiId}`);
    }
    expect(missing, "these ids silently degrade to plaintext").toEqual([]);
  });

  /** Without this, a gap fixed upstream leaves a stale exemption hiding a future regression. */
  it("keeps no stale exemptions: each known gap really has no Shiki grammar", () => {
    for (const id of ["fortran", "mathematica", "mercury", "org", "rebol"] as const) {
      expect(bundledLanguages, `${id} is no longer a gap`).not.toHaveProperty(id);
    }
  });
});
