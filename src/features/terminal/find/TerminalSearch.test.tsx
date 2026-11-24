/**
 * TerminalSearch — the overlay's full behavior against a mocked
 * SearchAddon + registry, jsdom tier.
 *
 * Mock altitude: the registry module boundary, same as the pane suite mocks
 * `features/terminal` (`vitest.config.ts` note) — the terminal feature's
 * rendering is browser-tier, so jsdom asserts the LOGIC: which addon calls a
 * given interaction produces, and where focus lands (keyboard bugs in this
 * app are usually focus).
 *
 * Fake timers + `fireEvent` (as in `FindInFiles.test.tsx`) make the 100 ms
 * debounce deterministic.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asTerminalId } from "../../../app/types";
import { SEARCH_DECORATIONS } from "./searchModel";
import { TerminalSearch } from "./TerminalSearch";

const TERMINAL_ID = asTerminalId("01J0TERM00000000000000000");

/* ── mocks ── */

type ResultsListener = (e: { resultIndex: number; resultCount: number }) => void;

class MockSearchAddon {
  findNext = vi.fn(() => true);
  findPrevious = vi.fn(() => true);
  clearDecorations = vi.fn();
  listeners: ResultsListener[] = [];
  listenerDisposals = 0;
  onDidChangeResults = (cb: ResultsListener): { dispose: () => void } => {
    this.listeners.push(cb);
    return {
      dispose: () => {
        this.listenerDisposals += 1;
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
    };
  };
  emit(e: { resultIndex: number; resultCount: number }): void {
    for (const l of [...this.listeners]) l(e);
  }
}

const registryMock = vi.hoisted(() => ({
  getSearchAddon: vi.fn(),
  getTerminal: vi.fn(),
  getTerminalSearchUi: vi.fn(),
  setTerminalSearchUi: vi.fn(),
}));

vi.mock("../TerminalRegistry", () => registryMock);

let addon: MockSearchAddon;
let term: { focus: ReturnType<typeof vi.fn> };
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  addon = new MockSearchAddon();
  term = { focus: vi.fn() };
  onClose = vi.fn<() => void>();
  registryMock.getSearchAddon.mockReset().mockReturnValue(addon);
  registryMock.getTerminal.mockReset().mockReturnValue(term);
  registryMock.getTerminalSearchUi.mockReset().mockReturnValue(null);
  registryMock.setTerminalSearchUi.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderSearch(focusSignal = 0): ReturnType<typeof render> {
  return render(<TerminalSearch terminalId={TERMINAL_ID} onClose={onClose} focusSignal={focusSignal} />);
}

const input = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>("Find in terminal");
const type = (value: string): void => {
  fireEvent.change(input(), { target: { value } });
};
const advance = (ms = 100): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/* ── open / focus ── */

describe("TerminalSearch — focus", () => {
  it("focuses its input on mount (the Cmd/Ctrl+F contract)", () => {
    renderSearch();
    expect(document.activeElement).toBe(input());
  });

  it("re-focuses and selects the query when focusSignal bumps (Cmd/Ctrl+F while open)", () => {
    const view = renderSearch(0);
    type("warn");
    input().blur();
    expect(document.activeElement).not.toBe(input());

    view.rerender(<TerminalSearch terminalId={TERMINAL_ID} onClose={onClose} focusSignal={1} />);
    expect(document.activeElement).toBe(input());
    // Selected, so typing replaces the old query — the IntelliJ reopen feel.
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("warn".length);
  });
});

/* ── live search ── */

describe("TerminalSearch — live search", () => {
  it("runs findNext ~100ms after typing, with decorations enabled and the toggles off", () => {
    renderSearch();
    type("error");
    expect(addon.findNext).not.toHaveBeenCalled(); // debouncing

    advance(100);
    expect(addon.findNext).toHaveBeenCalledTimes(1);
    expect(addon.findNext).toHaveBeenCalledWith("error", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      decorations: SEARCH_DECORATIONS,
    });
  });

  it("debounces: rapid keystrokes produce ONE search, for the final query", () => {
    renderSearch();
    type("e");
    advance(50);
    type("er");
    advance(50);
    type("err");
    advance(100);

    expect(addon.findNext).toHaveBeenCalledTimes(1);
    expect(addon.findNext).toHaveBeenCalledWith("err", expect.anything());
  });

  it("clearing the query clears the decorations and the counter", () => {
    renderSearch();
    type("err");
    advance(100);
    act(() => addon.emit({ resultIndex: 0, resultCount: 3 }));
    expect(screen.getByText("1/3")).toBeInTheDocument();

    addon.clearDecorations.mockClear();
    type("");
    advance(100);
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(screen.queryByText("1/3")).not.toBeInTheDocument();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });

  it("survives an addon that throws (half-typed regex) without crashing the overlay", () => {
    addon.findNext.mockImplementation(() => {
      throw new SyntaxError("Invalid regular expression");
    });
    renderSearch();
    type("foo(");
    expect(() => advance(100)).not.toThrow();
    expect(input()).toBeInTheDocument();
  });
});

/* ── k/N counter ── */

describe("TerminalSearch — match counter", () => {
  it("renders k/N from onDidChangeResults (1-based)", () => {
    renderSearch();
    type("err");
    advance(100);

    act(() => addon.emit({ resultIndex: 1, resultCount: 5 }));
    expect(screen.getByText("2/5")).toBeInTheDocument();

    act(() => addon.emit({ resultIndex: 4, resultCount: 5 }));
    expect(screen.getByText("5/5")).toBeInTheDocument();
  });

  it('shows "No results" and a red-ish input for zero matches', () => {
    renderSearch();
    type("nope");
    advance(100);
    act(() => addon.emit({ resultIndex: -1, resultCount: 0 }));

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByText("No results")).toHaveClass("is-no-results");
    expect(input()).toHaveClass("is-no-results");
  });

  it("drops the no-results styling once matches appear again", () => {
    renderSearch();
    type("nope");
    advance(100);
    act(() => addon.emit({ resultIndex: -1, resultCount: 0 }));
    expect(input()).toHaveClass("is-no-results");

    act(() => addon.emit({ resultIndex: 0, resultCount: 2 }));
    expect(input()).not.toHaveClass("is-no-results");
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });
});

/* ── navigation ── */

describe("TerminalSearch — navigation", () => {
  function primed(): void {
    renderSearch();
    type("err");
    advance(100);
    addon.findNext.mockClear();
    addon.findPrevious.mockClear();
  }

  it("Enter = next, Shift+Enter = previous (wrapping is the addon's native default — we pass no option that disables it)", () => {
    primed();

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(addon.findNext).toHaveBeenCalledTimes(1);
    expect(addon.findPrevious).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(addon.findPrevious).toHaveBeenCalledTimes(1);
    // The same options every time — repeated findNext with unchanged options is
    // exactly how the addon advances through (and wraps around) its results.
    expect(addon.findPrevious).toHaveBeenCalledWith("err", expect.objectContaining({ decorations: SEARCH_DECORATIONS }));
  });

  it("↓ = next, ↑ = previous", () => {
    primed();

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(addon.findNext).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(addon.findPrevious).toHaveBeenCalledTimes(1);
  });

  it("the ↑ / ↓ buttons navigate too", () => {
    primed();

    fireEvent.click(screen.getByLabelText("Next match"));
    expect(addon.findNext).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Previous match"));
    expect(addon.findPrevious).toHaveBeenCalledTimes(1);
  });

  it("Enter right after typing cancels the pending debounce — one search, never two", () => {
    renderSearch();
    type("err");
    fireEvent.keyDown(input(), { key: "Enter" }); // debounce still pending
    expect(addon.findNext).toHaveBeenCalledTimes(1);

    advance(300); // the cancelled debounce must NOT fire a second search
    expect(addon.findNext).toHaveBeenCalledTimes(1);
  });
});

/* ── toggles ── */

describe("TerminalSearch — toggles", () => {
  it("case toggle re-runs the search with caseSensitive: true", () => {
    renderSearch();
    type("err");
    advance(100);
    addon.findNext.mockClear();

    fireEvent.click(screen.getByLabelText("Case sensitive"));
    expect(screen.getByLabelText("Case sensitive")).toHaveAttribute("aria-pressed", "true");

    advance(100);
    expect(addon.findNext).toHaveBeenCalledTimes(1);
    expect(addon.findNext).toHaveBeenCalledWith("err", expect.objectContaining({ caseSensitive: true }));
  });

  it("whole-word and regex toggles flow into the search options", () => {
    renderSearch();
    type("err");
    fireEvent.click(screen.getByLabelText("Whole word"));
    fireEvent.click(screen.getByLabelText("Regular expression"));
    advance(100);

    expect(addon.findNext).toHaveBeenLastCalledWith(
      "err",
      expect.objectContaining({ wholeWord: true, regex: true }),
    );
  });
});

/* ── close / persistence / lifecycle ── */

describe("TerminalSearch — close and lifecycle", () => {
  it("Esc hands focus back to the terminal and closes", () => {
    renderSearch();
    fireEvent.keyDown(input(), { key: "Escape" });

    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("✕ does the same", () => {
    renderSearch();
    fireEvent.click(screen.getByLabelText("Close find"));

    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmount clears decorations and disposes the results listener — nothing leaks into the registry", () => {
    const view = renderSearch();
    type("err");
    advance(100);
    expect(addon.listeners).toHaveLength(1);

    view.unmount();
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(addon.listenerDisposals).toBe(1);
    expect(addon.listeners).toHaveLength(0);
  });

  it("recalls the persisted query + toggles and re-highlights on reopen", () => {
    registryMock.getTerminalSearchUi.mockReturnValue({
      query: "warn",
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
    renderSearch();

    expect(input().value).toBe("warn");
    expect(screen.getByLabelText("Case sensitive")).toHaveAttribute("aria-pressed", "true");

    advance(100); // the mount-time search re-highlights the recalled query
    expect(addon.findNext).toHaveBeenCalledWith("warn", expect.objectContaining({ caseSensitive: true }));
  });

  it("persists the query and toggles as they change", () => {
    renderSearch();
    type("boom");
    fireEvent.click(screen.getByLabelText("Case sensitive"));

    expect(registryMock.setTerminalSearchUi).toHaveBeenLastCalledWith(TERMINAL_ID, {
      query: "boom",
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
  });

  it("is inert, not crashing, when the terminal was disposed while open", () => {
    registryMock.getSearchAddon.mockReturnValue(undefined);
    registryMock.getTerminal.mockReturnValue(undefined);

    const view = renderSearch();
    type("err");
    expect(() => advance(100)).not.toThrow();
    expect(() => fireEvent.keyDown(input(), { key: "Enter" })).not.toThrow();

    // Esc still closes even with the terminal gone.
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    expect(() => view.unmount()).not.toThrow();
  });
});
