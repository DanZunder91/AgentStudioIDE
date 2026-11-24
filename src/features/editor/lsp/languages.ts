/**
 * Which languages have a code-intelligence server (M5 breadth).
 *
 * This set MIRRORS the Rust `spec_for` table (`src-tauri/src/lsp/registry.rs`): a
 * language listed here is one the relay knows how to launch + detect. The editor
 * only attaches the LSP client for these — for anything else, code intelligence is
 * simply off (no wasted `lsp_start` round-trip). A server that isn't installed
 * still degrades calmly to that language's install hint; being in this set only
 * means "worth trying", not "guaranteed present".
 *
 * Keep the two in sync: add a `spec_for` row and its id(s) here in one commit.
 */

/** Friendly server name per language, for the editor's status indicator. */
export const LSP_SERVER_NAMES: Readonly<Record<string, string>> = {
  rust: "rust-analyzer",
  typescript: "typescript-language-server",
  typescriptreact: "typescript-language-server",
  javascript: "typescript-language-server",
  javascriptreact: "typescript-language-server",
  python: "pyright",
  go: "gopls",
  c: "clangd",
  cpp: "clangd",
  "objective-c": "clangd",
  "objective-cpp": "clangd",
  // JVM family (.java/.kt, incl. Spring) — see `spec_for` in registry.rs.
  java: "jdtls",
  kotlin: "kotlin-language-server",
};

/** The language ids with a server (the keys of {@link LSP_SERVER_NAMES}). */
export const LSP_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(LSP_SERVER_NAMES));

/** True when `languageId` has a code-intelligence server worth starting. */
export function hasLspServer(languageId: string): boolean {
  return LSP_LANGUAGES.has(languageId);
}
