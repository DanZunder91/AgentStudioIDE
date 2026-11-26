/** Go-to-definition end to end in Chromium, against a fake rust-analyzer over the mocked relay. */

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorView } from "@codemirror/view";

import { useAppStore } from "../../../app/store";
import { installTauriMock, type TauriMock } from "../../../test/tauri-mock";
import { resetStore } from "../../../test/store-harness";
import { CodeEditor } from "../CodeEditor";
import { disposeAll, getView } from "../EditorRegistry";
import { revealInEditor } from "../reveal";
import { resetClients } from "./client";
import { uriFromPath } from "./uri";

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface Location {
  uri: string;
  range: Range;
}

/** A canned rust-analyzer wired to the mocked relay. */
function fakeRustAnalyzer(ipc: TauriMock) {
  const server = ipc.channel();
  const openedUris: string[] = [];
  let definition: Range | null = null;
  let references: Location[] | null = null;
  let contentModifiedOnce = false;

  const reply = (id: number, result: unknown) =>
    server.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const replyError = (id: number, code: number, message: string) =>
    server.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));

  ipc.handle("lsp_start", (args) => {
    server.capture(args.onMessage);
    return { serverId: "srv-1", languageId: "rust", status: "running" };
  });
  ipc.handle("lsp_send", (args) => {
    const msg = JSON.parse(args.message as string) as {
      id?: number;
      method: string;
      params?: { textDocument?: { uri: string } };
    };
    if (msg.method === "initialize" && msg.id != null) {
      reply(msg.id, { capabilities: { definitionProvider: true, referencesProvider: true } });
    } else if (msg.method === "textDocument/didOpen" && msg.params?.textDocument) {
      openedUris.push(msg.params.textDocument.uri);
    } else if (msg.method === "textDocument/definition" && msg.id != null) {
      if (contentModifiedOnce) {
        contentModifiedOnce = false;
        replyError(msg.id, -32801, "content modified");
      } else {
        reply(msg.id, definition ? { uri: msg.params!.textDocument!.uri, range: definition } : null);
      }
    } else if (msg.method === "textDocument/references" && msg.id != null) {
      reply(msg.id, references);
    }
    return null;
  });

  return {
    openedUris,
    setDefinition: (range: Range) => {
      definition = range;
    },
    setReferences: (locs: Location[]) => {
      references = locs;
    },
    stallOnceWhileIndexing: () => {
      contentModifiedOnce = true;
    },
  };
}

describe("go-to-definition (real CM6 + fake rust-analyzer)", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    disposeAll();
    resetClients();
    resetStore();
    ipc = installTauriMock();
    useAppStore.setState((s) => {
      s.workspaceRoot = "/w";
    });
  });
  afterEach(() => {
    ipc.reset();
    disposeAll();
    resetClients();
  });

  const DOC = "fn foo() {}\nfn main() { foo(); }\n";
  const PATH = "/w/src/main.rs";

  const openEditor = () => {
    ipc.handle("read_file", () => DOC);
    return render(<CodeEditor path={PATH} />);
  };

  it("opening a .rs file starts the server and sends didOpen", async () => {
    const server = fakeRustAnalyzer(ipc);
    const { container } = openEditor();

    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    await vi.waitFor(() => expect(server.openedUris).toContain(uriFromPath(PATH)));
    expect(ipc.calls("lsp_start")).toHaveLength(1);
    expect(ipc.lastCall("lsp_start")!.languageId).toBe("rust");
  });

  it("attaches for a non-Rust language too (TypeScript), starting its server", async () => {
    const server = fakeRustAnalyzer(ipc); // the fake stands in for any stdio server
    ipc.handle("read_file", () => "export const foo = 1;\nconst bar = foo;\n");
    const tsPath = "/w/src/app.ts";
    render(<CodeEditor path={tsPath} />);

    await vi.waitFor(() => expect(server.openedUris).toContain(uriFromPath(tsPath)));
    expect(ipc.lastCall("lsp_start")!.languageId).toBe("typescript");
  });

  it("F12 sends textDocument/definition and jumps to the returned location", async () => {
    const server = fakeRustAnalyzer(ipc);
    server.setDefinition({ start: { line: 0, character: 3 }, end: { line: 0, character: 6 } });
    const { container } = openEditor();
    await vi.waitFor(() => expect(server.openedUris.length).toBeGreaterThan(0));

    const view = getView(PATH)!;
    // Put the cursor on `foo` in `fn main() { foo(); }` (line 1).
    view.dispatch({ selection: { anchor: DOC.indexOf("foo();") } });

    const user = userEvent.setup();
    await user.click(container.querySelector(".cm-content")!);
    await user.keyboard("{F12}");

    // Jumped to `foo` on line 0 (offset 3) — the definition site.
    await vi.waitFor(() => expect(getView(PATH)!.state.selection.main.head).toBe(3));
  });

  it("retries on -32801 (indexing), showing the indicator, then navigates", async () => {
    const server = fakeRustAnalyzer(ipc);
    server.setDefinition({ start: { line: 0, character: 3 }, end: { line: 0, character: 6 } });
    server.stallOnceWhileIndexing(); // first definition → -32801
    const { container } = openEditor();
    await vi.waitFor(() => expect(server.openedUris.length).toBeGreaterThan(0));

    const view = getView(PATH)!;
    view.dispatch({ selection: { anchor: DOC.indexOf("foo();") } });
    await userEvent.setup().click(container.querySelector(".cm-content")!);
    await userEvent.setup().keyboard("{F12}");

    // The indexing indicator appears while the query retries.
    await vi.waitFor(() => expect(useAppStore.getState().lspIndexing).toContain("rust"));
    // Then the retry (after ~1s) lands the jump and clears the indicator.
    await vi.waitFor(() => expect(getView(PATH)!.state.selection.main.head).toBe(3), {
      timeout: 4000,
    });
    expect(useAppStore.getState().lspIndexing).not.toContain("rust");
  });

  it("shows a calm install hint when rust-analyzer is not installed", async () => {
    ipc.handle("lsp_start", () => ({
      serverId: "",
      languageId: "rust",
      status: "unavailable",
      installHint: "rustup component add rust-analyzer",
    }));
    const { findByText } = openEditor();

    expect(await findByText(/rustup component add rust-analyzer/)).toBeInTheDocument();
  });

  /* ── Cmd/Ctrl-hover underline ── */

  /** Dispatch a mousemove at a document offset, with/without the platform mod. */
  const hover = (view: EditorView, offset: number, meta: boolean) => {
    const c = view.coordsAtPos(offset)!;
    view.contentDOM.dispatchEvent(
      new MouseEvent("mousemove", {
        clientX: c.left + 1,
        clientY: (c.top + c.bottom) / 2,
        metaKey: meta,
        bubbles: true,
      }),
    );
  };

  const definitionRequests = () =>
    ipc.calls("lsp_send").filter((call) =>
      String(call.args.message ?? "").includes("textDocument/definition"),
    );

  const CALL_SITE = DOC.indexOf("foo();") + 1; // inside `foo` in `fn main() { foo(); }`
  const DEF_RANGE = { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } };

  it("Cmd/Ctrl-hover over a navigable symbol underlines it; release removes it", async () => {
    const server = fakeRustAnalyzer(ipc);
    server.setDefinition(DEF_RANGE);
    const { container } = openEditor();
    await vi.waitFor(() => expect(server.openedUris.length).toBeGreaterThan(0));
    const view = getView(PATH)!;

    hover(view, CALL_SITE, true); // modifier held → query → underline
    await vi.waitFor(() => expect(container.querySelector(".cm-lsp-underline")).toBeTruthy());
    expect(container.querySelector(".cm-lsp-underline")!.textContent).toBe("foo");

    hover(view, CALL_SITE, false); // release → gone
    await vi.waitFor(() => expect(container.querySelector(".cm-lsp-underline")).toBeNull());
  });

  it("with NO modifier held, hovering never underlines and never queries", async () => {
    const server = fakeRustAnalyzer(ipc);
    server.setDefinition(DEF_RANGE);
    const { container } = openEditor();
    await vi.waitFor(() => expect(server.openedUris.length).toBeGreaterThan(0));

    hover(getView(PATH)!, CALL_SITE, false);
    await new Promise((r) => setTimeout(r, 250)); // past the debounce
    expect(container.querySelector(".cm-lsp-underline")).toBeNull();
    expect(definitionRequests()).toHaveLength(0); // no hover query fired
  });

  it("a symbol with NO definition does not underline (readiness signal)", async () => {
    fakeRustAnalyzer(ipc); // definition left unset → server returns null
    const { container } = openEditor();
    await vi.waitFor(() => expect(getView(PATH)).toBeTruthy());

    hover(getView(PATH)!, CALL_SITE, true);
    await new Promise((r) => setTimeout(r, 300)); // debounce + query round-trip
    expect(container.querySelector(".cm-lsp-underline")).toBeNull();
  });

  it("Cmd/Ctrl+Click an underlined symbol navigates to its definition", async () => {
    const server = fakeRustAnalyzer(ipc);
    server.setDefinition(DEF_RANGE);
    const { container } = openEditor();
    await vi.waitFor(() => expect(server.openedUris.length).toBeGreaterThan(0));
    const view = getView(PATH)!;

    hover(view, CALL_SITE, true);
    await vi.waitFor(() => expect(container.querySelector(".cm-lsp-underline")).toBeTruthy());

    const c = view.coordsAtPos(CALL_SITE)!;
    view.contentDOM.dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: c.left + 1,
        clientY: (c.top + c.bottom) / 2,
        metaKey: true,
        button: 0,
        bubbles: true,
      }),
    );
    await vi.waitFor(() => expect(getView(PATH)!.state.selection.main.head).toBe(3));
  });

  /* ── Find usages (M5) ── */

  const fooUri = () => uriFromPath(PATH);
  // `foo`'s declaration on line 0 and its call on line 1.
  const DECL_RANGE = { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } };
  const CALL_RANGE = { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } };

  it("Shift+F12 lists every usage in the references panel", async () => {
    const server = fakeRustAnalyzer(ipc);
    server.setReferences([
      { uri: fooUri(), range: DECL_RANGE },
      { uri: fooUri(), range: CALL_RANGE },
    ]);
    const { container } = openEditor();
    await vi.waitFor(() => expect(server.openedUris.length).toBeGreaterThan(0));

    const view = getView(PATH)!;
    await userEvent.setup().click(container.querySelector(".cm-content")!); // focus first…
    view.dispatch({ selection: { anchor: DOC.indexOf("foo()") + 1 } }); // …then place the caret in `foo`
    await userEvent.setup().keyboard("{Shift>}{F12}{/Shift}");

    await vi.waitFor(() => expect(useAppStore.getState().lspReferences?.hits.length).toBe(2));
    const refs = useAppStore.getState().lspReferences!;
    expect(refs.symbol).toBe("foo");
    expect(refs.loading).toBe(false);
    expect(refs.hits[0]).toMatchObject({ display: "src/main.rs", line: 1, col: 4 });
    expect(refs.hits[1]).toMatchObject({ display: "src/main.rs", line: 2, col: 13 });
    // The marked span is the symbol itself.
    const h = refs.hits[1];
    expect(h.lineText.slice(h.matchStart, h.matchEnd)).toBe("foo");
  });

  it("Cmd/Ctrl+Click on a DECLARATION shows its usages (the IntelliJ gesture)", async () => {
    const server = fakeRustAnalyzer(ipc);
    server.setDefinition(DECL_RANGE); // definition of `foo` at the decl = the decl itself
    server.setReferences([
      { uri: fooUri(), range: DECL_RANGE },
      { uri: fooUri(), range: CALL_RANGE },
    ]);
    openEditor();
    await vi.waitFor(() => expect(server.openedUris.length).toBeGreaterThan(0));
    const view = getView(PATH)!;

    const declSite = DOC.indexOf("foo()") + 1; // inside `foo` in `fn foo()`
    const c = view.coordsAtPos(declSite)!;
    view.contentDOM.dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: c.left + 1,
        clientY: (c.top + c.bottom) / 2,
        metaKey: true,
        button: 0,
        bubbles: true,
      }),
    );

    // Clicking the declaration lists usages rather than sitting still on itself.
    await vi.waitFor(() => expect(useAppStore.getState().lspReferences?.hits.length).toBe(2));
    // And it did NOT move the caret (no self-jump).
    expect(getView(PATH)!.state.selection.main.head).not.toBe(3);
  });

  it("revealInEditor opens the file and places the cursor at a 1-based line/col", async () => {
    fakeRustAnalyzer(ipc);
    openEditor();
    await vi.waitFor(() => expect(getView(PATH)).toBeTruthy());

    await revealInEditor(PATH, 2, 5); // line 2, column 5
    const view = getView(PATH)!;
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 4);
  });
});
