/** Languages the LSP client attaches for. Mirrors `spec_for` in `src-tauri/src/lsp/registry.rs`:
 * change both in one commit. Listed means worth trying, not installed. */

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
