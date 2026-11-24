/**
 * The LSP language set — which languages have a code-intelligence server. Must
 * stay in step with the Rust `spec_for` table (`src-tauri/src/lsp/registry.rs`).
 */

import { describe, expect, it } from "vitest";

import { hasLspServer, LSP_LANGUAGES, LSP_SERVER_NAMES } from "./languages";

describe("hasLspServer", () => {
  it("is true for every language with a registry spec", () => {
    for (const id of ["rust", "typescript", "javascript", "python", "go", "c", "cpp", "java", "kotlin"]) {
      expect(hasLspServer(id), id).toBe(true);
    }
  });

  it("is false for languages with no server (highlight-only)", () => {
    for (const id of ["markdown", "json", "toml", "plaintext", "sql", "html"]) {
      expect(hasLspServer(id), id).toBe(false);
    }
  });
});

describe("LSP_SERVER_NAMES", () => {
  it("names the server for the indicator", () => {
    expect(LSP_SERVER_NAMES.rust).toBe("rust-analyzer");
    expect(LSP_SERVER_NAMES.python).toBe("pyright");
    expect(LSP_SERVER_NAMES.cpp).toBe("clangd");
    expect(LSP_SERVER_NAMES.typescript).toBe("typescript-language-server");
    expect(LSP_SERVER_NAMES.java).toBe("jdtls");
    expect(LSP_SERVER_NAMES.kotlin).toBe("kotlin-language-server");
  });

  it("the set is exactly the named languages", () => {
    expect([...LSP_LANGUAGES].sort()).toEqual(Object.keys(LSP_SERVER_NAMES).sort());
  });
});
