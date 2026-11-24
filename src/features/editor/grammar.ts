/**
 * LanguageId → Shiki grammar id (M4).
 *
 * Our canonical `LanguageId` (docs/design/language-detection.md §7) is the source
 * of truth; Shiki's grammar ids mostly coincide with it, so this records only the
 * handful that differ or that Shiki cannot highlight (→ `null`, plaintext render).
 * Anything else passes through, and `ensureLang`'s try/catch degrades a genuine
 * miss to plaintext — so an id we forget here never throws, it just isn't colored.
 */

import type { LanguageId } from "../../lib/language";

/** Only the exceptions: aliases where the Shiki id differs, and no-grammar ids. */
const SHIKI_ID: Partial<Record<LanguageId, string | null>> = {
  // No Shiki grammar → plaintext.
  plaintext: null,
  dotenv: null,
  editorconfig: null,
  gitignore: null,
  "git-config": null,
  "git-attributes": null,
  "go-module": null,
  "go-checksums": null,
  // Shiki grammar id differs from our LanguageId.
  shell: "bash",
  dockerfile: "docker",
  makefile: "make",
  properties: "ini",
  // Same language, different id — verified against `bundledLanguages` (Shiki ships
  // no grammar under OUR id, so without these rows `ensureLang` misses and the file
  // silently renders as plaintext). Each is the SAME language, not an approximation:
  //   svg  → `xml`  — an SVG document *is* XML (scope `text.xml`); Shiki has no `svg`.
  //   restructuredtext → `rst` — Shiki's display name for `rst` is literally
  //                     "reStructuredText" (scope `source.rst`).
  //   vlang → `v`   — Shiki's `v` is the V language (scope `source.v`); Verilog is a
  //                   separate `verilog` grammar, so there is no collision.
  //   assembly → `asm` — display name "Assembly", fileTypes `asm/nasm/yasm/inc/s`,
  //                   which is exactly the extension set `assembly` is detected from.
  //   wat  → `wasm` — Shiki's `wasm` grammar has scope `source.wat`: it is the
  //                   WebAssembly *text* format, which is all `.wat`/`.wast` are.
  svg: "xml",
  restructuredtext: "rst",
  vlang: "v",
  assembly: "asm",
  wat: "wasm",
};

/**
 * The Shiki grammar to lazy-load for a language, or `null` to render plaintext.
 * The DoD ids (`rust`, `kotlin`, `sql`, `cpp`, `java`, `json`, `markdown`,
 * `html`, `css`, `javascript`, `typescript`, `python`) are all valid Shiki ids
 * and pass straight through.
 */
export function languageToShiki(id: LanguageId): string | null {
  return id in SHIKI_ID ? (SHIKI_ID[id] ?? null) : id;
}
