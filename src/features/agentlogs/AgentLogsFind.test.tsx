/** ⌘F in Logs over the real panel and stores (`AgentLogsPanel.test.tsx` harness). jsdom's
 * `focus()` collapses the selection, so tests focus, THEN select, THEN key; reveal is asserted on
 * the REAL `alog-list` box's `scrollTop`. Pixels: `agentLogsFind.browser.test.tsx`. */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    snapshot: [] as unknown[],
    handler: null as null | ((e: { payload: unknown[] }) => void),
  };
  const invoke = vi.fn((cmd: string) => {
    if (cmd === "logstream_snapshot") return Promise.resolve(state.snapshot);
    return Promise.resolve(null);
  });
  const listen = vi.fn((_name: string, cb: (e: { payload: unknown[] }) => void) => {
    state.handler = cb;
    return Promise.resolve(() => {});
  });
  return { state, invoke, listen };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));

import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import { AgentLogsPanel, ROW_H } from "./AgentLogsPanel";
import { resetAgentLogsForTests, useAgentLogsStore } from "./agentLogsStore";
import type { LogLine } from "./agentLogsTypes";

const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id, tsMs: 0, terminalId: null, agentId: null, source: "zsh", kind: "output", level: "info",
  text: `line ${id}`, detail: null, toolUseId: null, ...p,
});
const call = (id: number, text: string, p: Partial<LogLine> = {}) =>
  L(id, { kind: "tool", source: "claude · gazelle", agentId: "a1", toolUseId: `tu${id}`, text, ...p });
const answer = (id: number, ofId: number, detail: string, p: Partial<LogLine> = {}) =>
  L(id, { kind: "tool-result", source: "claude · gazelle", agentId: "a1", toolUseId: `tu${ofId}`, text: "Bash → x", detail, ...p });

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
/** Let the bar's deferred focus run (it focuses a tick after it renders). */
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const emit = (lines: LogLine[]) =>
  act(() => (tauri.state.handler as (e: { payload: unknown[] }) => void)({ payload: lines }));

async function mount(snapshot: LogLine[]) {
  tauri.state.snapshot = snapshot;
  const r = render(
    <div>
      <button type="button" data-testid="outside">
        outside
      </button>
      <AgentLogsPanel />
    </div>,
  );
  await settle();
  return r;
}

const panel = () => screen.getByTestId("agent-logs-panel");
const list = () => screen.getByTestId("alog-list");
const bar = () => screen.queryByTestId("alog-find");
const input = () => screen.getByTestId("alog-find-input") as HTMLInputElement;
const count = () => screen.getByTestId("alog-find-count").textContent;
const rowById = (id: number) =>
  document.querySelector(`[data-testid="alog-row"][data-id="${id}"], [data-testid="alog-divider"][data-id="${id}"]`) as HTMLElement;
const outs = () => screen.queryAllByTestId("alog-block-out");
const current = () => screen.getByTestId("alog-find-current");
const hits = () => document.querySelectorAll(".alog-find-hit");

/** ⌘F (or Ctrl+F) pressed with focus on `el`; returns whether the app claimed it. */
function pressFind(el: Element, mod: "meta" | "ctrl" = "meta", extra: Partial<KeyboardEventInit> = {}): boolean {
  return !fireEvent.keyDown(el, { key: "f", metaKey: mod === "meta", ctrlKey: mod === "ctrl", ...extra });
}
async function openFind(el: Element = rowById(1)): Promise<void> {
  (el as HTMLElement).focus();
  pressFind(el);
  await tick();
}
function type(q: string) {
  fireEvent.change(input(), { target: { value: q } });
}
function selectIn(node: Node, from: number, to: number) {
  const r = document.createRange();
  r.setStart(node, from);
  r.setEnd(node, to);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(r);
}
/** The text node of a raw row's text cell. */
const textNode = (id: number) => (rowById(id).querySelector(".alog-text") as HTMLElement).firstChild as Node;

function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.clientHeight });
}

beforeEach(() => {
  resetAgentLogsForTests();
  resetStore();
  useColumnLayoutStore.setState({ layouts: {} });
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  resetAgentLogsForTests();
});

/* A stream with every row shape: raw rows, a folded block with hits behind the fold, a divider. */
const MIXED = [
  L(1, { text: "gazelle booting" }),
  L(2, { text: "nothing here" }),
  call(3, "Bash: tail -n 20 gazelle.log", { detail: "Tail the service log" }),
  answer(4, 3, "o0\no1\no2\no3 gazelle ready\no4\no5 gazelle GAZELLE"),
  L(5, { kind: "system", text: "gazelle exited (code 0)" }),
];

describe("⌘F routing: inside the Logs panel → the Logs bar; outside → not", () => {
  it("⌘F on a row opens the bar above the list with the input focused, and claims the key", async () => {
    await mount(MIXED);
    rowById(1).focus();
    expect(pressFind(rowById(1))).toBe(true);
    await tick();
    expect(bar()).toBeInTheDocument();
    expect(bar()?.dataset.scope).toBe("list");
    expect(document.activeElement).toBe(input());
    // Docked in the stream column, right above the list.
    expect(bar()?.nextElementSibling).toBe(list());
    expect(input()).toHaveAttribute("aria-label", "Find in logs");
  });

  it("Ctrl+F works the same (Linux / Windows)", async () => {
    await mount(MIXED);
    expect(pressFind(rowById(2), "ctrl")).toBe(true);
    expect(bar()).toBeInTheDocument();
  });

  it("anywhere inside the panel counts — the toolbar's filter box, the root itself (a click on a gap focuses it)", async () => {
    await mount(MIXED);
    expect(pressFind(screen.getByLabelText("Filter log lines"))).toBe(true);
    expect(bar()).toBeInTheDocument();
    act(() => useAgentLogsStore.getState().closeFind());
    expect(panel()).toHaveAttribute("tabindex", "-1");
    expect(pressFind(panel())).toBe(true);
    expect(bar()).toBeInTheDocument();
  });

  it("outside the panel: nothing opens and the key is left alone", async () => {
    await mount(MIXED);
    expect(pressFind(screen.getByTestId("outside"))).toBe(false);
    expect(bar()).toBeNull();
  });

  it("⌘⇧F (find in files) and ⌥⌘F are not ours; plain f is not ours", async () => {
    await mount(MIXED);
    expect(pressFind(rowById(1), "meta", { shiftKey: true })).toBe(false);
    expect(pressFind(rowById(1), "meta", { altKey: true })).toBe(false);
    expect(!fireEvent.keyDown(rowById(1), { key: "f" })).toBe(false);
    expect(!fireEvent.keyDown(rowById(1), { key: "g", metaKey: true })).toBe(false);
    expect(bar()).toBeNull();
    // An uppercase F (Caps Lock) with the modifier is still ⌘F.
    expect(!fireEvent.keyDown(rowById(1), { key: "F", metaKey: true })).toBe(true);
  });
});

describe("matching: counts across folded output, marks every hit", () => {
  it("counts raw rows, the header, EVERY output line (folded too) and dividers — occurrences, case-insensitive", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    // raw 1 · header label (gazelle.log) · o3 · o5 ×2 · divider = 6
    expect(count()).toBe("1/6");
    expect(hits()).toHaveLength(6);
    // The hit behind the fold expanded its block while the bar is open: all 6 output lines.
    expect(outs()).toHaveLength(6);
    expect(screen.getByTestId("alog-block-more")).toHaveTextContent("show less");
  });

  it("the current match is hot and its row carries the you-are-here rule; the rest are subtle", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    expect(current()).toHaveClass("alog-find-hit", "alog-find-hit--current");
    expect(current()).toHaveTextContent("gazelle");
    expect(rowById(1)).toHaveClass("alog-row--find-current");
    expect(document.querySelectorAll(".alog-row--find-current")).toHaveLength(1);
    expect(screen.getAllByTestId("alog-find-hit")).toHaveLength(5);
    // os_log highlighting survives inside and around a mark.
    expect(rowById(1).querySelector(".alog-text")).toHaveTextContent("gazelle booting");
  });

  it("a header's description is searched and marked too", async () => {
    await mount(MIXED);
    await openFind();
    type("service log");
    expect(count()).toBe("1/1");
    const head = screen.getByTestId("alog-block-head");
    expect(head.querySelector(".alog-block__desc .alog-find-hit--current")).toHaveTextContent("service log");
    expect(head).toHaveClass("alog-row--find-current");
  });

  it("no match: `0 results`, ▲▼ disabled, no marks", async () => {
    await mount(MIXED);
    await openFind();
    type("zzz");
    expect(count()).toBe("0 results");
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled();
    expect(hits()).toHaveLength(0);
    // Enter with nothing to step to is harmless.
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toBe("0 results");
  });

  it("an empty bar finds nothing and changes nothing", async () => {
    await mount(MIXED);
    await openFind();
    expect(count()).toBe("0 results");
    expect(outs()).toHaveLength(3);
  });

  it("find searches what the toolbar filter left — the filter filters, find navigates", async () => {
    await mount(MIXED);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "booting" } });
    await openFind(screen.getByLabelText("Filter log lines"));
    type("gazelle");
    expect(count()).toBe("1/1");
  });
});

describe("stepping", () => {
  it("Enter / Shift+Enter and ▼ / ▲ step, wrapping at both ends", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toBe("2/6");
    expect(screen.getByTestId("alog-block-head")).toHaveClass("alog-row--find-current");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(count()).toBe("3/6");
    expect(outs()[3]).toHaveClass("alog-row--find-current");
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(count()).toBe("1/6");
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(count()).toBe("6/6");
    expect(rowById(5)).toHaveClass("alog-row--find-current");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toBe("1/6");
    // Another key in the input is just typing.
    fireEvent.keyDown(input(), { key: "a" });
    expect(count()).toBe("1/6");
  });

  it("a new query restarts at the first match", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    fireEvent.keyDown(input(), { key: "Enter" });
    type("gazelle ");
    expect(count()).toBe("1/4");
  });

  it("the stored ordinal is clamped when the matches shrink under it (a cleared log, the ring's cap)", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    act(() => useAgentLogsStore.setState((s) => ({ find: { ...s.find!, cursor: 5 } })));
    expect(count()).toBe("6/6");
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "booting" } });
    expect(count()).toBe("1/1");
  });
});

describe("fold auto-expand while open, and restore on close", () => {
  it("closing gives back the user's folds exactly — find never wrote them", async () => {
    await mount(MIXED);
    await openFind();
    type("o5");
    expect(outs()).toHaveLength(6);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(bar()).toBeNull();
    expect(outs()).toHaveLength(3);
    expect(useAgentLogsStore.getState().expandedBlocks).toEqual({});
  });

  it("a block the user had expanded stays expanded after the bar closes", async () => {
    await mount(MIXED);
    fireEvent.click(screen.getByRole("button", { name: "show 3 more" }));
    await openFind();
    type("o5");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(outs()).toHaveLength(6);
  });

  it("a hand fold while the bar is open wins (show less is not dead); the hidden hit lands on the more row", async () => {
    await mount(MIXED);
    await openFind();
    type("o5");
    fireEvent.click(screen.getByRole("button", { name: "show less" }));
    expect(outs()).toHaveLength(3);
    // Still counted — it is still a match; nothing on screen is marked because it is folded away.
    expect(count()).toBe("1/1");
    expect(hits()).toHaveLength(0);
    // Closing keeps what the user chose.
    fireEvent.click(screen.getByRole("button", { name: "Close find" }));
    expect(useAgentLogsStore.getState().expandedBlocks).toEqual({ tu3: false });
  });

  it("a fold click with no bar open leaves no find state behind", async () => {
    await mount(MIXED);
    fireEvent.click(screen.getByRole("button", { name: "show 3 more" }));
    expect(useAgentLogsStore.getState().find).toBeNull();
  });
});

describe("Aa and .* toggles; an invalid regex", () => {
  it("Aa makes it case-sensitive; toggling back restores the count", async () => {
    await mount(MIXED);
    await openFind();
    type("GAZELLE");
    expect(count()).toBe("1/6");
    const aa = screen.getByRole("button", { name: "Match case" });
    fireEvent.click(aa);
    expect(aa).toHaveAttribute("aria-pressed", "true");
    expect(count()).toBe("1/1");
    fireEvent.click(aa);
    expect(count()).toBe("1/6");
  });

  it(".* makes it a regex (literal by default: `o\\d` finds nothing until .* is on)", async () => {
    await mount(MIXED);
    await openFind();
    type("o\\d");
    expect(count()).toBe("0 results");
    const rx = screen.getByRole("button", { name: "Regular expression" });
    fireEvent.click(rx);
    expect(rx).toHaveAttribute("aria-pressed", "true");
    expect(count()).toBe("1/6");
  });

  it("an invalid regex shows inline, marks the input invalid, never throws, and the list stays", async () => {
    await mount(MIXED);
    await openFind();
    fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
    expect(() => type("(gazelle")).not.toThrow();
    expect(screen.getByTestId("alog-find-error")).toHaveTextContent(/^Invalid regex: .+/);
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(input()).toHaveClass("find-bar__input--error");
    expect(screen.queryByTestId("alog-find-count")).toBeNull();
    expect(rowById(1)).toBeInTheDocument();
    expect(hits()).toHaveLength(0);
    type("(gazelle)");
    expect(count()).toBe("1/6");
    expect(input()).toHaveAttribute("aria-invalid", "false");
  });
});

describe("seeding from the selection (selectionSeed.ts rules)", () => {
  it("a single-line selection in a row seeds the bar, SELECTED so the next keystroke replaces it", async () => {
    await mount(MIXED);
    rowById(2).focus(); // focus first: jsdom's focus() collapses the selection
    selectIn(textNode(2), 0, 7);
    pressFind(rowById(2));
    await tick();
    expect(input().value).toBe("nothing");
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 7]);
    expect(count()).toBe("1/1");
  });

  it("an open bar is overwritten by a new selection, and restarts at match 1", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    fireEvent.keyDown(input(), { key: "Enter" });
    rowById(2).focus();
    selectIn(textNode(2), 8, 12);
    pressFind(rowById(2));
    await tick();
    expect(input().value).toBe("here");
    expect(count()).toBe("1/1");
  });

  it("an UNCHANGED seed is a refocus, not a new search: the place is kept", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toBe("2/6");
    rowById(1).focus();
    // "gazelle" — the query as it stands; row 1's text node is now inside its <mark>.
    selectIn((rowById(1).querySelector("mark") as HTMLElement).firstChild as Node, 0, 7);
    pressFind(rowById(1));
    await tick();
    expect(count()).toBe("2/6");
    expect(document.activeElement).toBe(input());
  });

  it("no selection leaves the query alone; ⌘F again inside the bar refocuses and selects it", async () => {
    await mount(MIXED);
    await openFind();
    type("gazelle");
    screen.getByRole("button", { name: "Match case" }).focus();
    pressFind(screen.getByRole("button", { name: "Match case" }));
    await tick();
    expect(input().value).toBe("gazelle");
    expect(document.activeElement).toBe(input());
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 7]);
  });

  it("over 200 characters is a paragraph, not a query: the bar opens with its query untouched", async () => {
    const long = "x".repeat(201);
    await mount([L(1, { text: long })]);
    rowById(1).focus();
    selectIn(textNode(1), 0, 201);
    pressFind(rowById(1));
    expect(input().value).toBe("");
    act(() => useAgentLogsStore.getState().closeFind());
    rowById(1).focus();
    selectIn(textNode(1), 0, 200);
    pressFind(rowById(1));
    expect(input().value).toBe("x".repeat(200));
  });

  it("a MULTI-line selection (in the drawer's pre — stream rows are one line by construction) leaves the query untouched", async () => {
    await mount([L(1, { text: "alpha", detail: "first line\nsecond line" })]);
    fireEvent.click(rowById(1));
    const drawer = screen.getByTestId("alog-detail");
    const more = (drawer.querySelector(".alog-detail__more") as HTMLElement).firstChild as Node;
    drawer.focus();
    selectIn(more, 0, 11); // "first line\n" — spans the break
    pressFind(drawer);
    expect(input().value).toBe("");
    // …whereas a single line of it seeds.
    drawer.focus();
    selectIn(more, 0, 5);
    pressFind(drawer);
    expect(input().value).toBe("first");
  });

  it("a selection OUTSIDE the searched text does not seed: a drawer selection never seeds a stream search", async () => {
    await mount([L(1, { text: "alpha", detail: "beta gamma" })]);
    fireEvent.click(rowById(1));
    const more = (screen.getByTestId("alog-detail").querySelector(".alog-detail__more") as HTMLElement).firstChild as Node;
    rowById(1).focus();
    selectIn(more, 0, 4);
    pressFind(rowById(1));
    expect(bar()?.dataset.scope).toBe("list");
    expect(input().value).toBe("");
  });
});

describe("Esc closes and returns focus", () => {
  it("Esc: the bar closes, focus goes back to the row ⌘F was pressed on, and the query is forgotten", async () => {
    await mount(MIXED);
    await openFind(rowById(2));
    type("gazelle");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(rowById(2));
    expect(useAgentLogsStore.getState().find).toBeNull();
    await openFind(rowById(2));
    expect(input().value).toBe("");
  });

  it("✕ does the same", async () => {
    await mount(MIXED);
    await openFind(screen.getByLabelText("Filter log lines"));
    fireEvent.click(screen.getByRole("button", { name: "Close find" }));
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Filter log lines"));
  });

  it("when the element focus came from is gone (the row scrolled out of the window, the log cleared), focus lands on the panel", async () => {
    await mount(MIXED);
    await openFind(rowById(2));
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "gazelle" } });
    expect(rowById(2)).toBeNull();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(document.activeElement).toBe(panel());
  });

  it("one Esc, one layer: with the drawer open the first Esc closes find, the second the drawer", async () => {
    await mount(MIXED);
    fireEvent.click(rowById(1));
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
    await openFind(rowById(1));
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(bar()).toBeNull();
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
    fireEvent.keyDown(rowById(1), { key: "Escape" });
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });

  it("the bar survives a remount (tab switch / pane move) — its state is the Logs store's, not the component's", async () => {
    const r = await mount(MIXED);
    await openFind();
    type("gazelle");
    fireEvent.keyDown(input(), { key: "Enter" });
    r.unmount();
    await mount(MIXED);
    expect(input().value).toBe("gazelle");
    expect(count()).toBe("2/6");
  });
});

describe("the detail drawer's scope", () => {
  const DRAWER = [
    L(1, { text: "outer gazelle" }),
    call(2, "Bash: grep gazelle x.log", { detail: "look for gazelle" }),
    answer(3, 2, "gazelle 1\ngazelle 2"),
  ];

  it("⌘F with the drawer focused searches the drawer's text: `in detail`, its own count, marks in the drawer only", async () => {
    await mount(DRAWER);
    fireEvent.click(screen.getByTestId("alog-block-head"));
    const drawer = screen.getByTestId("alog-detail");
    expect(drawer).toHaveAttribute("tabindex", "-1");
    drawer.focus();
    pressFind(drawer);
    await tick();
    expect(bar()?.dataset.scope).toBe("detail");
    expect(screen.getByTestId("alog-find-scope")).toHaveTextContent("in detail");
    // jsdom is not macOS, so the tooltip names Ctrl+F — never a ⌘ a PC keyboard lacks.
    expect(screen.getByTestId("alog-find-scope")).toHaveAttribute(
      "title",
      "Ctrl+F was pressed in the detail drawer: its text is searched, not the stream",
    );
    expect(input()).toHaveAttribute("aria-label", "Find in detail");
    type("gazelle");
    // The call's text, its detail, and the result's two lines = 4 — the stream's rows are not counted.
    expect(count()).toBe("1/4");
    expect(drawer.querySelectorAll(".alog-find-hit")).toHaveLength(4);
    expect(drawer.querySelector(".alog-detail__text .alog-find-hit--current")).toHaveTextContent("gazelle");
    expect(document.querySelectorAll(".alog-list .alog-find-hit")).toHaveLength(0);
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(drawer.querySelector(".alog-detail__result .alog-find-hit--current")).toHaveTextContent("gazelle");
  });

  it("⌘F on a row with the drawer open searches the stream; pressing it in the drawer switches the same bar's scope", async () => {
    await mount(DRAWER);
    fireEvent.click(rowById(1));
    await openFind(rowById(1));
    type("gazelle");
    expect(bar()?.dataset.scope).toBe("list");
    // Stream: raw 1 · the header's description (the call's detail) and label · the result's 2 lines = 5.
    expect(count()).toBe("1/5");
    const drawer = screen.getByTestId("alog-detail");
    drawer.focus();
    pressFind(drawer);
    expect(bar()?.dataset.scope).toBe("detail");
    // A raw row's drawer holds its text only.
    expect(count()).toBe("1/1");
  });

  it("a detail-scoped bar whose drawer closes searches the stream again", async () => {
    await mount(DRAWER);
    fireEvent.click(rowById(1));
    const drawer = screen.getByTestId("alog-detail");
    drawer.focus();
    pressFind(drawer);
    type("gazelle");
    expect(count()).toBe("1/1");
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(bar()?.dataset.scope).toBe("list");
    expect(count()).toBe("1/5");
  });

  it("no match in the drawer reveals nothing and throws nothing", async () => {
    await mount(DRAWER);
    fireEvent.click(rowById(1));
    const drawer = screen.getByTestId("alog-detail");
    drawer.focus();
    pressFind(drawer);
    expect(() => type("zzz")).not.toThrow();
    expect(count()).toBe("0 results");
  });

  it("the current drawer match is scrolled into view (the drawer is not windowed)", async () => {
    const spy = vi.fn();
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (o?: unknown) => void };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = spy;
    try {
      await mount(DRAWER);
      fireEvent.click(screen.getByTestId("alog-block-head"));
      const drawer = screen.getByTestId("alog-detail");
      drawer.focus();
      pressFind(drawer);
      type("gazelle 2");
      expect(spy).toHaveBeenCalledWith({ block: "nearest" });
      expect(spy.mock.contexts.at(-1)).toHaveClass("alog-find-hit--current");
    } finally {
      proto.scrollIntoView = before;
    }
  });
});

describe("reveal: the current match is scrolled into view by index", () => {
  const MANY = Array.from({ length: 2000 }, (_, i) => L(i + 1, { text: i + 1 === 1500 ? "NEEDLE here" : `filler ${i + 1}` }));

  async function mountMany(lines = MANY) {
    await mount(lines);
    geometry(list(), { scrollHeight: (lines.length + 1) * ROW_H, clientHeight: 600 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  it("a match far from the view scrolls the REAL list box so its row is centred — and it is rendered", async () => {
    await mountMany();
    act(() => useAgentLogsStore.getState().setFollow(false));
    list().scrollTop = 0;
    fireEvent.scroll(list());
    expect(rowById(1500)).toBeNull(); // windowed out: scrollIntoView could never have reached it
    await openFind();
    type("needle");
    // Row 1499 (0-based) tops at 1500 · 18 = 27000; 600px holds 32 rows under the header,
    // so 16 go above it: 27000 − 18 − 16 · 18 = 26694.
    expect(list().scrollTop).toBe(26694);
    expect(rowById(1500)).toBeInTheDocument();
    expect(rowById(1500)).toHaveClass("alog-row--find-current");
  });

  it("revealing stops follow (or the next line would snap the list back to the tail)", async () => {
    await mountMany();
    expect(useAgentLogsStore.getState().follow).toBe(true);
    await openFind();
    type("needle");
    expect(useAgentLogsStore.getState().follow).toBe(false);
    expect(list().scrollTop).toBe(26694);
  });

  it("a match already in view does not move the list", async () => {
    await mountMany();
    act(() => useAgentLogsStore.getState().setFollow(false));
    list().scrollTop = 26694;
    fireEvent.scroll(list());
    await openFind(list());
    type("filler 1499");
    expect(count()).toBe("1/1");
    expect(list().scrollTop).toBe(26694);
  });

  it("new lines arriving never re-reveal; a step does — even with one match, where the cursor cannot move", async () => {
    await mountMany();
    await openFind();
    type("needle");
    list().scrollTop = 0;
    fireEvent.scroll(list());
    emit([L(3001, { text: "later" })]);
    expect(list().scrollTop).toBe(0);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toBe("1/1");
    expect(list().scrollTop).toBe(26694);
  });

  it("a hit behind a fold: the block expands AND the list scrolls to the output row", async () => {
    const lines = [
      ...Array.from({ length: 300 }, (_, i) => L(i + 1)),
      call(301, "Bash: run"),
      answer(302, 301, "a\nb\nc\nd\nNEEDLE deep"),
      ...Array.from({ length: 300 }, (_, i) => L(i + 400)),
    ];
    await mountMany(lines);
    await openFind();
    type("needle");
    // Block at row 300: head 300, a..NEEDLE at 301..305 → row 305 tops at 306 · 18 = 5508;
    // 5508 − 18 − 288 = 5202.
    expect(list().scrollTop).toBe(5202);
    const deep = outs().find((o) => o.dataset.index === "4") as HTMLElement;
    expect(deep).toHaveClass("alog-row--find-current");
  });
});

describe("store actions are inert with the bar closed", () => {
  it("query / toggles / step do nothing and create no find state", () => {
    const st = useAgentLogsStore.getState();
    st.setFindQuery("x");
    st.toggleFindCase();
    st.toggleFindRegex();
    st.stepFind(1, 5);
    expect(useAgentLogsStore.getState().find).toBeNull();
  });

  it("a step over zero matches does not bump the reveal", () => {
    const st = useAgentLogsStore.getState();
    st.openFind("list", null);
    const seq = useAgentLogsStore.getState().find?.seq;
    st.stepFind(1, 0);
    expect(useAgentLogsStore.getState().find?.seq).toBe(seq);
    st.stepFind(1, 3);
    expect(useAgentLogsStore.getState().find?.cursor).toBe(1);
  });
});
