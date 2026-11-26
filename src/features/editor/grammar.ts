/** LanguageId → Shiki grammar id: only ids that differ or can't be highlighted (`null`). Anything
 * else passes through; `ensureLang` degrades a miss to plaintext, never a throw. */

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
  // Same language under Shiki's id (checked against `bundledLanguages`); without these rows the
  // file silently renders as plaintext. `v` is V, not Verilog; Shiki's `wasm` is the text format.
  svg: "xml",
  restructuredtext: "rst",
  vlang: "v",
  assembly: "asm",
  wat: "wasm",
};

/** The Shiki grammar to lazy-load for a language, or `null` to render plaintext. */
export function languageToShiki(id: LanguageId): string | null {
  return id in SHIKI_ID ? (SHIKI_ID[id] ?? null) : id;
}
