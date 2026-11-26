/** Real registry and real `@xterm/addon-search` in jsdom (`ensureTerminal` never calls
 * `term.open()`). `dispose()` must free the addon and its UI state: the closed-while-open leak. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchAddon } from "@xterm/addon-search";

import { asTerminalId } from "../../../app/types";
import { installTauriMock, type TauriMock } from "../../../test/tauri-mock";
import {
  dispose,
  disposeAll,
  ensureTerminal,
  getSearchAddon,
  getTerminal,
  getTerminalSearchUi,
  getTerminalSelection,
  setTerminalSearchUi,
} from "../TerminalRegistry";

const TERM_A = asTerminalId("01J0TERMA0000000000000000");
const TERM_B = asTerminalId("01J0TERMB0000000000000000");
const CWD = "/projects/proj";

/** `openPty` is deferred one task (`scheduleOpen`); let it and its await land. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("TerminalRegistry — per-terminal SearchAddon", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
    ipc
      .handle("terminal_open", (args) => ({
        id: args.terminalId,
        kind: "terminal",
        title: "sh",
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
        status: "live",
      }))
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  it("loads a SearchAddon with every terminal, one per terminal", async () => {
    ensureTerminal(TERM_A, CWD);
    ensureTerminal(TERM_B, CWD);
    await flush();

    const a = getSearchAddon(TERM_A);
    const b = getSearchAddon(TERM_B);
    expect(a).toBeInstanceOf(SearchAddon);
    expect(b).toBeInstanceOf(SearchAddon);
    expect(a).not.toBe(b);

    // The overlay's contract: the addon is live and subscribable.
    const sub = a!.onDidChangeResults(() => undefined);
    expect(() => sub.dispose()).not.toThrow();
  });

  it("round-trips the find overlay's UI state, per terminal", async () => {
    ensureTerminal(TERM_A, CWD);
    ensureTerminal(TERM_B, CWD);
    await flush();

    expect(getTerminalSearchUi(TERM_A)).toBeNull();

    const ui = { query: "error", caseSensitive: true, wholeWord: false, regex: false };
    setTerminalSearchUi(TERM_A, ui);
    expect(getTerminalSearchUi(TERM_A)).toEqual(ui);
    // Strictly per terminal — B never sees A's query.
    expect(getTerminalSearchUi(TERM_B)).toBeNull();
  });

  it("dispose() disposes the addon with the terminal and forgets addon + UI state", async () => {
    ensureTerminal(TERM_A, CWD);
    await flush();

    const addon = getSearchAddon(TERM_A)!;
    const addonDispose = vi.spyOn(addon, "dispose");
    setTerminalSearchUi(TERM_A, { query: "x", caseSensitive: false, wholeWord: false, regex: false });

    dispose(TERM_A);

    // term.dispose() owns loaded addons — the SearchAddon's own dispose (which
    // clears decorations and its buffer listeners) must have run.
    expect(addonDispose).toHaveBeenCalledTimes(1);
    expect(getSearchAddon(TERM_A)).toBeUndefined();
    expect(getTerminalSearchUi(TERM_A)).toBeNull();
  });

  it("setTerminalSearchUi after dispose is a no-op, not a resurrection", async () => {
    ensureTerminal(TERM_A, CWD);
    await flush();
    dispose(TERM_A);

    setTerminalSearchUi(TERM_A, { query: "ghost", caseSensitive: false, wholeWord: false, regex: false });
    expect(getTerminalSearchUi(TERM_A)).toBeNull();
  });

  /* ── the selection the find overlay seeds from ── */

  it("getTerminalSelection reports the terminal's selection, and null when there is none", async () => {
    ensureTerminal(TERM_A, CWD);
    await flush();

    // A live terminal with nothing selected: null, never "".
    expect(getTerminalSelection(TERM_A)).toBeNull();

    // xterm's own selection, against the REAL Terminal the registry owns. The
    // registry must read it through `hasSelection()`, which is the only thing
    // that tells "nothing selected" from "the empty string was selected".
    const term = getTerminal(TERM_A)!;
    vi.spyOn(term, "hasSelection").mockReturnValue(true);
    vi.spyOn(term, "getSelection").mockReturnValue("ECONNREFUSED");
    expect(getTerminalSelection(TERM_A)).toBe("ECONNREFUSED");
  });

  it("getTerminalSelection is null for a terminal that does not exist, and after dispose", async () => {
    // The overlay can outlive its terminal by a frame (a tab closed while the
    // bar is up); asking a ghost must be inert, not a crash.
    expect(getTerminalSelection(TERM_B)).toBeNull();

    ensureTerminal(TERM_A, CWD);
    await flush();
    dispose(TERM_A);
    expect(getTerminalSelection(TERM_A)).toBeNull();
  });
});
