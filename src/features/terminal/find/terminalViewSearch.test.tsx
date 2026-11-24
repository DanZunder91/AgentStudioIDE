/**
 * TerminalView × find-in-terminal — the interception seam.
 *
 * What is pinned here: the CAPTURE-phase keydown on the terminal host is the
 * ONLY key the view touches. Cmd+F (mac) / Ctrl+F (elsewhere) opens the
 * overlay, preventDefault()s and stops the event before xterm's textarea can
 * swallow it; EVERY other key — including Ctrl+F on macOS, which is
 * forward-char in the shell — passes through untouched, open or closed.
 *
 * The registry is mocked at the module boundary (the established altitude —
 * see `vitest.config.ts`'s note on `features/terminal` in jsdom): `useTerminal`
 * then runs for real but ensure/attach/detach are inert, so no xterm instance
 * is needed. `isMac` is mocked per-test to pin both platforms hermetically
 * (jsdom's UA depends on the host OS).
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../../app/store";
import { asTerminalId } from "../../../app/types";
import { TerminalView } from "../TerminalView";

const TERMINAL_ID = asTerminalId("01J0TERM00000000000000000");

const registryMock = vi.hoisted(() => ({
  ensureTerminal: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  focusTerminal: vi.fn(),
  getTerminal: vi.fn(),
  getSearchAddon: vi.fn(),
  // The selection the overlay seeds from. Mocked here
  // rather than on the `term` stub: `TerminalView` asks the REGISTRY, not an
  // xterm instance, so the view never has to know an xterm exists.
  getTerminalSelection: vi.fn(),
  getTerminalSearchUi: vi.fn(),
  setTerminalSearchUi: vi.fn(),
  // Unused by these tests, but `TerminalView` now imports the app store, and
  // the store's `features/terminal` import re-exports THIS mocked module — so
  // every registry export the feature index names must exist on the mock.
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  disposeAll: vi.fn(),
  getRendererKind: vi.fn(),
  getTerminalMeta: vi.fn(),
  hasTerminal: vi.fn(),
  serializeTerminal: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../TerminalRegistry", () => registryMock);

const isMacMock = vi.hoisted(() => vi.fn(() => true));
// `modKey` rides along for the same reason the registry mock grew above: the
// store's import graph reaches this module too, and a mock factory must cover
// every export an importer can touch.
vi.mock("../../shortcuts/shortcuts", () => ({ isMac: isMacMock, modKey: () => "⌘" }));

class MockSearchAddon {
  findNext = vi.fn(() => true);
  findPrevious = vi.fn(() => true);
  clearDecorations = vi.fn();
  onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
}

let term: { focus: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  isMacMock.mockReturnValue(true);
  term = { focus: vi.fn() };
  registryMock.getTerminal.mockReturnValue(term);
  registryMock.getSearchAddon.mockReturnValue(new MockSearchAddon());
  registryMock.getTerminalSearchUi.mockReturnValue(null);
  // Default: nothing selected in the terminal, so Cmd/Ctrl+F opens an EMPTY bar
  // — the original behaviour, which every test below still pins.
  registryMock.getTerminalSelection.mockReturnValue(null);
  // The overlay's open state lives in the module-singleton store now — that
  // survival IS the feature, and between tests it is a leak that would start
  // the next render with the overlay already open.
  useAppStore.setState((s) => {
    s.findBars = {};
  });
});

function renderView(): HTMLElement {
  const { container } = render(<TerminalView terminalId={TERMINAL_ID} />);
  const host = container.querySelector<HTMLElement>(".terminal-view");
  if (!host) throw new Error("terminal host did not render");
  return host;
}

const overlayInput = (): HTMLInputElement | null =>
  screen.queryByLabelText<HTMLInputElement>("Find in terminal");

describe("TerminalView — Cmd/Ctrl+F interception", () => {
  it("Cmd+F on macOS opens the overlay, consumes the key, and focuses the input", () => {
    const host = renderView();
    expect(overlayInput()).toBeNull();

    // fireEvent returns false when the event was preventDefault()ed — i.e.
    // consumed before xterm's textarea (a bubble-phase target) could see it.
    const passedThrough = fireEvent.keyDown(host, { key: "f", metaKey: true });
    expect(passedThrough).toBe(false);

    expect(overlayInput()).not.toBeNull();
    expect(document.activeElement).toBe(overlayInput());
  });

  it("Ctrl+F opens on non-mac", () => {
    isMacMock.mockReturnValue(false);
    const host = renderView();

    const passedThrough = fireEvent.keyDown(host, { key: "f", ctrlKey: true });
    expect(passedThrough).toBe(false);
    expect(overlayInput()).not.toBeNull();
  });

  it("Ctrl+F on macOS is NOT stolen — it is forward-char in the shell", () => {
    const host = renderView();

    const passedThrough = fireEvent.keyDown(host, { key: "f", ctrlKey: true });
    expect(passedThrough).toBe(true); // reaches xterm → the PTY
    expect(overlayInput()).toBeNull();
  });

  it("a closed overlay intercepts NOTHING else — plain keys and other chords pass to the terminal", () => {
    const host = renderView();

    expect(fireEvent.keyDown(host, { key: "f" })).toBe(true);
    expect(fireEvent.keyDown(host, { key: "a", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(host, { key: "F", metaKey: true, shiftKey: true })).toBe(true); // Find-in-Files' chord
    expect(fireEvent.keyDown(host, { key: "Escape" })).toBe(true);
    expect(overlayInput()).toBeNull();
  });

  it("Cmd+F while already open re-focuses the query instead of stacking overlays", () => {
    const host = renderView();
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    const input = overlayInput()!;

    input.blur();
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(host, { key: "f", metaKey: true });
    expect(screen.getAllByLabelText("Find in terminal")).toHaveLength(1);
    expect(document.activeElement).toBe(input);
  });

  it("Esc closes the overlay AND returns focus to the terminal (term.focus)", () => {
    const host = renderView();
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    const input = overlayInput()!;

    fireEvent.keyDown(input, { key: "Escape" });

    expect(overlayInput()).toBeNull();
    expect(registryMock.getTerminal).toHaveBeenCalledWith(TERMINAL_ID);
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("after closing, keys pass through again (no lingering interception)", () => {
    const host = renderView();
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    fireEvent.keyDown(overlayInput()!, { key: "Escape" });

    expect(fireEvent.keyDown(host, { key: "g", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(host, { key: "f" })).toBe(true);
    expect(overlayInput()).toBeNull();
  });
});

/* ════════════════ Cmd/Ctrl+F seeds from the selection ════════════════ */

/**
 * Pressing Cmd+F with text selected must search for that selection.
 *
 * The editor's bar has done this since #67a; these pin that the terminal's now
 * does too, by the SAME rule (`editor/find/selectionSeed`). The selection is
 * read from the REGISTRY, not from an xterm instance the view holds — so the
 * mock below is `getTerminalSelection`, and the terminal stub stays the
 * `{ focus }` it has always been.
 *
 * The assertion that matters is `addon.findNext`: the bar must SEARCH for the
 * selection, not merely display it. Fake timers make the overlay's 100 ms
 * debounce deterministic, as in the remount suite below.
 */
describe("TerminalView — Cmd/Ctrl+F seeds the overlay from the terminal selection", () => {
  let addon: MockSearchAddon;

  beforeEach(() => {
    vi.useFakeTimers();
    addon = new MockSearchAddon();
    registryMock.getSearchAddon.mockReturnValue(addon);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the overlay's debounce fire. */
  function settle(): void {
    act(() => {
      vi.advanceTimersByTime(100);
    });
  }

  it("seeds a single-line selection AND runs the search", () => {
    registryMock.getTerminalSelection.mockReturnValue("ECONNREFUSED");
    const host = renderView();

    fireEvent.keyDown(host, { key: "f", metaKey: true });
    settle();

    const input = overlayInput()!;
    expect(input.value).toBe("ECONNREFUSED");
    // The point of the feature: it SEARCHED. Not "the box has text in it".
    expect(addon.findNext).toHaveBeenCalledWith("ECONNREFUSED", expect.anything());
  });

  it("selects the seeded text, so the next keystroke replaces it", () => {
    registryMock.getTerminalSelection.mockReturnValue("ECONNREFUSED");
    const host = renderView();

    fireEvent.keyDown(host, { key: "f", metaKey: true });

    const input = overlayInput()!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("ECONNREFUSED".length);
  });

  it("the user can TYPE OVER a seeded query — the seed is one press, not a rule", () => {
    // The seed rides along with the press counter for exactly this reason: a
    // seed re-applied on every render would revert the user's next keystroke,
    // which is the opposite of the affordance selecting the text provides.
    registryMock.getTerminalSelection.mockReturnValue("panic");
    const host = renderView();
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    expect(overlayInput()!.value).toBe("panic");

    fireEvent.change(overlayInput()!, { target: { value: "warn" } });
    settle();

    expect(overlayInput()!.value).toBe("warn");
    expect(addon.findNext).toHaveBeenCalledWith("warn", expect.anything());
  });

  it("OVERWRITES the query of an already-open bar", () => {
    registryMock.getTerminalSelection.mockReturnValue(null);
    const host = renderView();
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    fireEvent.change(overlayInput()!, { target: { value: "warn" } });
    settle();
    addon.findNext.mockClear();

    registryMock.getTerminalSelection.mockReturnValue("panic");
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    settle();

    expect(overlayInput()!.value).toBe("panic");
    expect(addon.findNext).toHaveBeenCalledWith("panic", expect.anything());
  });

  it("leaves the query UNTOUCHED for a MULTI-LINE selection — it does not clear it", () => {
    // xterm joins selected rows with "\n", so a block selection over two rows
    // arrives exactly like this. VS Code declines to seed it; so do we.
    registryMock.getTerminalSelection.mockReturnValue(null);
    const host = renderView();
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    fireEvent.change(overlayInput()!, { target: { value: "warn" } });
    settle();
    addon.findNext.mockClear();

    registryMock.getTerminalSelection.mockReturnValue("line one\nline two");
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    settle();

    expect(overlayInput()!.value).toBe("warn");
    expect(addon.findNext).not.toHaveBeenCalledWith("line one\nline two", expect.anything());
  });

  it("with NO selection the bar opens exactly as it always has — empty, focused", () => {
    registryMock.getTerminalSelection.mockReturnValue(null);
    const host = renderView();

    fireEvent.keyDown(host, { key: "f", metaKey: true });
    settle();

    const input = overlayInput()!;
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(addon.findNext).not.toHaveBeenCalled(); // an empty query searches nothing
  });

  it("a tab move does NOT re-seed — the remounted bar keeps the query it had", () => {
    // The seed is a keypress, not state: `TerminalView`'s request resets on
    // remount, so coming back to the tab restores the registry's query and asks
    // the selection nothing. (The unmount/remount suite below owns the rest.)
    registryMock.getTerminalSearchUi.mockReturnValue({
      query: "warn",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    registryMock.getTerminalSelection.mockReturnValue("panic");

    const first = render(<TerminalView terminalId={TERMINAL_ID} />);
    const host = first.container.querySelector<HTMLElement>(".terminal-view") as HTMLElement;
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    settle();
    first.unmount();

    render(<TerminalView terminalId={TERMINAL_ID} />);
    settle();
    expect(overlayInput()!.value).toBe("warn");
  });
});

/* ════════════════ the overlay survives a tab move ════════════════ */

/**
 * `Pane` renders only the active tab and a cross-pane drag re-parents the
 * subtree — both unmount `<TerminalView>`. The bar's OPEN state lives in
 * `findBars["terminal:<id>"]` so it comes back on the remount; the QUERY and
 * toggles come back from the registry (`searchUi`), exactly as before — these
 * tests drive the unmount/remount cycle the way `Pane` does and pin both
 * halves meeting again: bar open, query restored, highlights re-run.
 */
describe("TerminalView — the overlay survives unmount/remount", () => {
  const KEY = `terminal:${TERMINAL_ID}`;

  afterEach(() => {
    vi.useRealTimers();
  });

  function hostOf(view: ReturnType<typeof render>): HTMLElement {
    const host = view.container.querySelector<HTMLElement>(".terminal-view");
    if (!host) throw new Error("terminal host did not render");
    return host;
  }

  it("remounts with the bar open, and the registry-restored query re-highlights", () => {
    vi.useFakeTimers(); // TerminalSearch debounces its live search by 100ms
    // The query + toggles survive in the REGISTRY (`searchUi`), never in the
    // store — TerminalSearch's lazy initializers read them back on mount.
    registryMock.getTerminalSearchUi.mockReturnValue({
      query: "warn",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    // ONE addon across both mounts, as the registry owns it in production.
    const addon = new MockSearchAddon();
    registryMock.getSearchAddon.mockReturnValue(addon);

    const first = render(<TerminalView terminalId={TERMINAL_ID} />);
    fireEvent.keyDown(hostOf(first), { key: "f", metaKey: true });
    expect(overlayInput()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    addon.findNext.mockClear();
    addon.clearDecorations.mockClear();

    // A tab switch/move IS this unmount: the overlay clears its decorations on
    // the way out (its documented cleanup) — but the record must NOT drop.
    first.unmount();
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(useAppStore.getState().findBars[KEY]).toEqual({ open: true, query: "", cursor: 0 });

    const second = render(<TerminalView terminalId={TERMINAL_ID} />);
    // Open again with NO fresh Cmd/Ctrl+F, the query restored…
    const input = overlayInput();
    expect(input).not.toBeNull();
    expect(input!.value).toBe("warn");
    // …and the mount-time search re-runs it, so the highlights come back.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(addon.findNext).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ decorations: expect.anything() }),
    );
    second.unmount();
  });

  it("two-sided: a DIFFERENT terminal's view starts with the overlay closed", () => {
    const first = render(<TerminalView terminalId={TERMINAL_ID} />);
    fireEvent.keyDown(hostOf(first), { key: "f", metaKey: true });
    expect(overlayInput()).not.toBeNull();
    first.unmount();

    render(<TerminalView terminalId={asTerminalId("01J0TERM11111111111111111")} />);
    expect(overlayInput()).toBeNull();
    // …while the first terminal's record is still waiting for its remount.
    expect(useAppStore.getState().findBars[KEY]?.open).toBe(true);
  });

  it("Esc DROPS the record — closing is forgetting; unmounting is not", () => {
    const view = render(<TerminalView terminalId={TERMINAL_ID} />);
    const host = hostOf(view);
    fireEvent.keyDown(host, { key: "f", metaKey: true });
    fireEvent.keyDown(overlayInput()!, { key: "Escape" });
    expect(useAppStore.getState().findBars[KEY]).toBeUndefined();

    fireEvent.keyDown(host, { key: "f", metaKey: true });
    expect(useAppStore.getState().findBars[KEY]?.open).toBe(true);
    view.unmount();
    expect(useAppStore.getState().findBars[KEY]?.open).toBe(true);
  });
});
