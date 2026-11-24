/**
 * LspStatus — the editor header's code-intelligence indicator (M5). Calm and
 * quiet: an indexing indicator, a dismissible install hint, or nothing.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { LspStatus } from "./LspStatus";

const lsp = () => useAppStore.getState().lspActions;

beforeEach(() => resetStore());
afterEach(() => cleanup());

describe("LspStatus", () => {
  it("renders nothing when the language server is quiet", () => {
    const { container } = render(<LspStatus path="/w/main.rs" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows 'rust-analyzer: indexing…' while a Rust query is retrying", () => {
    act(() => lsp().setLspIndexing("rust", true));
    render(<LspStatus path="/w/main.rs" />);
    expect(screen.getByText(/rust-analyzer: indexing/i)).toBeInTheDocument();
  });

  it("does not show a .rs file's indexing on a non-Rust file", () => {
    act(() => lsp().setLspIndexing("rust", true));
    const { container } = render(<LspStatus path="/w/notes.md" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the install hint, and hides it once dismissed", async () => {
    act(() => lsp().setLspInstallHint("rust", "rustup component add rust-analyzer"));
    render(<LspStatus path="/w/main.rs" />);
    expect(screen.getByText(/rustup component add rust-analyzer/)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/rustup component add rust-analyzer/)).toBeNull();
    expect(useAppStore.getState().lspDismissedHints).toContain("rust");
  });

  it("prefers the indexing indicator over the install hint", () => {
    act(() => {
      lsp().setLspInstallHint("rust", "install it");
      lsp().setLspIndexing("rust", true);
    });
    render(<LspStatus path="/w/main.rs" />);
    expect(screen.getByText(/indexing/i)).toBeInTheDocument();
    expect(screen.queryByText("install it")).toBeNull();
  });
});
