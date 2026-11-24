/**
 * LanguageId → Shiki grammar id map (M4). The DoD's discriminating cases must
 * resolve to a real Shiki grammar; the few aliases and no-grammar ids are the
 * only exceptions, and everything else passes straight through.
 */

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

  /**
   * `.svg` used to render with NO highlighting at all, and nothing went red.
   *
   * `detectLanguage` maps `.svg` to the LanguageId `'svg'`, this map passed it
   * through unchanged, and Shiki ships no `svg` grammar — so `ensureLang`'s
   * `bundledLanguages['svg']` lookup missed, its `if (!loadGrammar) return false`
   * fired, and `applyShikiHighlight` silently fell back to plaintext. A *silent*
   * degrade is the whole problem: every existing test here asserts against
   * hand-written expectations, so none of them could notice that the id on the
   * right-hand side does not exist in Shiki.
   *
   * `.svg` is load-bearing (the image preview gives it a Source ↔ Image toggle, so
   * SVG source is something you actually look at), and SVG *is* XML — Shiki's
   * `xml` grammar has scope `text.xml`.
   */
  it("maps svg onto Shiki's xml grammar rather than a nonexistent svg one", () => {
    expect(languageToShiki("svg")).toBe("xml");
    expect(bundledLanguages).not.toHaveProperty("svg");
    expect(bundledLanguages).toHaveProperty("xml");
  });

  /**
   * The class-level guard: EVERY LanguageId must resolve to a grammar Shiki
   * actually ships, or to `null` (an honest "render plaintext").
   *
   * This is the test that would have caught `svg` on day one, and it catches the
   * next one for free — a new id added to `LanguageId` whose name happens not to
   * be a Shiki id fails here instead of quietly rendering grey. It reads the REAL
   * `bundledLanguages` (a map of lazy loaders — importing it costs no grammar
   * chunk and no engine), so it cannot go vacuously green against a fake.
   *
   * `KNOWN_GAPS` is the honest remainder: ids for which no unambiguous Shiki
   * grammar exists. They behave correctly today (`ensureLang` misses → plaintext);
   * they are listed rather than aliased because every candidate is a judgement
   * call, not a rename. Deleting a row here after adding its alias is the fix.
   */
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

  /**
   * The other half of the guard above: every KNOWN_GAPS entry must
   * still BE a gap. Without this, the allowlist is a place bugs go to hide — an
   * id could be fixed upstream (or aliased here) and the exemption would linger,
   * quietly excusing a future regression on the same id.
   */
  it("keeps no stale exemptions: each known gap really has no Shiki grammar", () => {
    for (const id of ["fortran", "mathematica", "mercury", "org", "rebol"] as const) {
      expect(bundledLanguages, `${id} is no longer a gap`).not.toHaveProperty(id);
    }
  });
});
