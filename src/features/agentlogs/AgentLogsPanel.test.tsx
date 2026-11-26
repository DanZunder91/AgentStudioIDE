/** AgentLogsPanel over the real stores; only the Tauri seam and terminal module are mocked, and
 * events go through the captured `listen` handler. `shown()` reads every entry's line id in
 * order (raw rows, dividers, blocks); `rows()` reads raw rows only. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    snapshot: [] as unknown[] | (() => Promise<unknown[]>),
    clear: () => Promise.resolve(undefined as unknown),
    handler: null as null | ((e: { payload: unknown[] }) => void),
    syslog: null as unknown,
  };
  const invoke = vi.fn((cmd: string) => {
    if (cmd === "syslog_status") return Promise.resolve(state.syslog);
    if (cmd === "logstream_snapshot") {
      const s = state.snapshot;
      return typeof s === "function" ? s() : Promise.resolve(s);
    }
    if (cmd === "logstream_clear") return state.clear();
    return Promise.resolve(undefined);
  });
  const unlisten = vi.fn();
  const listen = vi.fn((_name: string, cb: (e: { payload: unknown[] }) => void) => {
    state.handler = cb;
    return Promise.resolve(unlisten);
  });
  return { state, invoke, listen, unlisten };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));

import { leafOfTab, useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import { AgentLogsPanel, ROW_H } from "./AgentLogsPanel";
import { resetAgentLogsForTests, useAgentLogsStore } from "./agentLogsStore";
import type { LogLine, SyslogStatus } from "./agentLogsTypes";

const SYSLOG = (p: Partial<SyslogStatus> = {}): SyslogStatus => ({
  available: true,
  backend: "macos-unified-log",
  reason: null,
  running: false,
  filter: { enabled: false, apps: null, subsystem: null, minLevel: "default", simulator: false, simulatorApps: null },
  simulator: { available: false, reason: null, running: false },
  linesPerSec: 0,
  droppedPerSec: 0,
  ...p,
});

const at = (h: number, m: number, s: number, ms: number) => new Date(2026, 0, 1, h, m, s, ms).getTime();
const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id,
  tsMs: at(12, 0, 0, 250),
  terminalId: null,
  agentId: null,
  source: "zsh",
  kind: "output",
  level: "info",
  text: `line ${id}`,
  detail: null,
  toolUseId: null,
  ...p,
});
/** A tool call and its result, paired by id, from one agent. */
const call = (id: number, text: string, p: Partial<LogLine> = {}) =>
  L(id, { kind: "tool", source: "claude · gazelle", agentId: "a1", toolUseId: `tu${id}`, text, ...p });
const answer = (id: number, ofId: number, text: string, p: Partial<LogLine> = {}) =>
  L(id, { kind: "tool-result", source: "claude · gazelle", agentId: "a1", toolUseId: `tu${ofId}`, text, ...p });

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const emit = (lines: LogLine[]) =>
  act(() => (tauri.state.handler as (e: { payload: unknown[] }) => void)({ payload: lines }));
const rows = () => screen.queryAllByTestId("alog-row");
const heads = () => screen.queryAllByTestId("alog-block-head");
const outs = () => screen.queryAllByTestId("alog-block-out");
/** The output text of each nested row — its leading cells repeat the block's time/level/source. */
const outTexts = () => outs().map((o) => (o.querySelector(".alog-block__outtext") as HTMLElement).textContent);
const streamHead = () => screen.queryByTestId("alog-stream-head");
const dividers = () => screen.queryAllByTestId("alog-divider");
/** Every stream entry's line id, in order (raw rows, dividers, block headers). */
const shown = () =>
  [...document.querySelectorAll('[data-testid="alog-row"], [data-testid="alog-divider"], [data-testid="alog-block-head"]')].map(
    (r) => (r as HTMLElement).dataset.id,
  );
const list = () => screen.getByTestId("alog-list");
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const sideRow = (source: string) =>
  screen.getAllByTestId("alog-src-row").find((r) => r.dataset.source === source) as HTMLElement;
const headLabels = () => [...screen.getByTestId("alog-head").querySelectorAll(".alog-head__cell")].map((c) => c.textContent);

async function mount(snapshot: LogLine[] = []) {
  tauri.state.snapshot = snapshot;
  const r = render(<AgentLogsPanel />);
  await settle();
  return r;
}

/** jsdom has no layout: give the list the geometry a real scroll box would report. */
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.clientHeight });
}

beforeEach(() => {
  resetAgentLogsForTests();
  resetStore();
  useColumnLayoutStore.setState({ layouts: {} });
  tauri.state.snapshot = [];
  tauri.state.clear = () => Promise.resolve(undefined);
  tauri.state.handler = null;
  tauri.state.syslog = SYSLOG();
  tauri.invoke.mockClear();
  tauri.listen.mockClear();
  tauri.unlisten.mockClear();
});
afterEach(() => resetAgentLogsForTests());

describe("empty + loading + error", () => {
  it("explains what appears here, including the hidden Claude TUI repaint", async () => {
    await mount();
    const empty = screen.getByTestId("alog-empty");
    expect(empty).toHaveTextContent(/output of every terminal/);
    expect(empty).toHaveTextContent(/services your agents start in the background/);
    expect(empty).toHaveTextContent(/every command and tool/);
    expect(empty).toHaveTextContent(/with its result shown under it/);
    expect(empty).toHaveTextContent(/lifecycle events/);
    expect(empty).toHaveTextContent(/screen repaints are hidden in favour of its tool calls/);
    expect(rows()).toHaveLength(0);
    // The sidebar is there, saying what will show up.
    expect(screen.getByTestId("alog-src-empty")).toBeInTheDocument();
  });

  it("shows loading until the snapshot lands", async () => {
    let resolve!: (v: unknown[]) => void;
    tauri.state.snapshot = () => new Promise((r) => (resolve = r));
    render(<AgentLogsPanel />);
    await settle();
    expect(screen.getByText("Loading the log stream…")).toBeInTheDocument();
    await act(async () => resolve([L(1)]));
    await settle();
    expect(rows()).toHaveLength(1);
  });

  it("a failed snapshot shows an error banner whose Retry reconnects", async () => {
    let fail = true;
    tauri.state.snapshot = () => (fail ? Promise.reject("ring gone") : Promise.resolve([L(1)]));
    render(<AgentLogsPanel />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read the log stream: ring gone");
    fail = false;
    fireEvent.click(btn("Retry"));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = await mount();
    unmount();
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("raw rows: time · badge · source · text, no marker", () => {
  it("renders with level and kind classes; a task line and a machine line carry no prefix glyph", async () => {
    await mount([
      L(1, { level: "error", text: "npm ERR! fatal" }),
      L(2, { level: "warn", text: "deprecated" }),
      L(3, { level: "debug", text: "trace" }),
      L(4, { kind: "task", source: "gazelle · bg", text: "INFO gazelle: up" }),
      L(5, { kind: "machine", source: "Safari", text: "[com.apple.Safari] loaded" }),
    ]);
    const r = rows();
    expect(r).toHaveLength(5);
    expect(r[0]).toHaveTextContent("12:00:00.250Ezshnpm ERR! fatal");
    expect(r[0]).toHaveClass("alog-row--error");
    expect(r[1]).toHaveClass("alog-row--warn");
    expect(r[2]).toHaveClass("alog-row--debug");
    expect(r[0]).not.toHaveClass("alog-row--warn");
    expect(within(r[0]).getByText("E")).toHaveClass("alog-badge--error");
    expect(r[3]).toHaveClass("alog-row--kind-task");
    expect((r[3].querySelector(".alog-text") as HTMLElement).textContent).toBe("INFO gazelle: up");
    expect(r[4]).toHaveClass("alog-row--kind-machine");
    expect((r[4].querySelector(".alog-text") as HTMLElement).textContent).toBe("[com.apple.Safari] loaded");
    for (const el of r) expect(el.textContent).not.toMatch(/[⚙◆▸]/);
    // Every row names its source in a data attribute (the E2E specs read it when the column is
    // hidden).
    expect(r[3].dataset.source).toBe("gazelle · bg");
  });

  it("highlights os_log process and subsystem as text spans (never HTML)", async () => {
    await mount([
      L(1, { text: "Demo[1234:5678] [com.example.demo:net] <img src=x onerror=alert(1)>" }),
    ]);
    const r = rows()[0];
    expect(within(r).getByText("Demo[1234:5678]")).toHaveClass("alog-hl--process");
    expect(within(r).getByText("[com.example.demo:net]")).toHaveClass("alog-hl--subsystem");
    expect(r.querySelector("img")).toBeNull();
    expect(r).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("a machine row's dot-less prefix (journald unit / bare subsystem) is green too — a terminal line's is not", async () => {
    await mount([
      L(1, { kind: "machine", source: "sshd", text: "[sshd:auth] accepted key" }),
      L(2, { text: "[sshd:auth] accepted key" }),
    ]);
    expect(within(rows()[0]).getByText("[sshd:auth]")).toHaveClass("alog-hl--subsystem");
    expect(rows()[1].querySelector(".alog-hl--subsystem")).toBeNull();
  });

  it("colours the source by its stable hash slot", async () => {
    await mount([L(1, { source: "a" })]);
    // FNV-1a("a") % 8 = 4 (hand-computed in agentLogsFormat.test.ts).
    expect(within(rows()[0]).getByText("a")).toHaveClass("alog-src--4");
  });

  it("appends event batches, deduping ids already shown", async () => {
    await mount([L(1), L(2)]);
    emit([L(2), L(3)]);
    expect(rows().map((r) => r.dataset.id)).toEqual(["1", "2", "3"]);
  });

  it("windows 20 000 lines to a bounded slice", async () => {
    await mount(Array.from({ length: 20_000 }, (_, i) => L(i + 1)));
    expect(screen.getByText("20000 lines")).toBeInTheDocument();
    const n = rows().length;
    expect(n).toBeGreaterThan(20);
    expect(n).toBeLessThan(100);
  });

  it("windows 20 000 lines of command blocks to a bounded slice too (blocks are rows, not measured)", async () => {
    const many: LogLine[] = [];
    for (let i = 0; i < 10_000; i++) {
      many.push(call(2 * i + 1, `Bash: step ${i}`), answer(2 * i + 2, 2 * i + 1, "Bash → l1", { detail: "l1\nl2\nl3\nl4\nl5" }));
    }
    await mount(many);
    const total = heads().length + outs().length + screen.queryAllByTestId("alog-block-more").length;
    expect(total).toBeGreaterThan(20);
    expect(total).toBeLessThan(100);
    // The scroll box is sized by the row count: 10 000 blocks × 5 rows, plus the header.
    const rowsBox = screen.getByTestId("alog-head").parentElement as HTMLElement;
    const pads = [...rowsBox.children].filter((c) => (c as HTMLElement).style.height !== "" && !c.className);
    const padTotal = pads.reduce((sum, c) => sum + parseInt((c as HTMLElement).style.height, 10), 0);
    expect(padTotal + total * ROW_H).toBe(10_000 * 5 * ROW_H);
  });

  it("windows on the MEASURED viewport, and re-measures on resize", async () => {
    const spy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(ROW_H * 5);
    try {
      await mount(Array.from({ length: 500 }, (_, i) => L(i + 1)));
      const small = rows().length;
      // 5 rows + 1 partial + 10 overscan each side (clamped at the top/bottom).
      expect(small).toBeLessThanOrEqual(5 + 1 + 20);
      spy.mockReturnValue(ROW_H * 20);
      act(() => void window.dispatchEvent(new Event("resize")));
      const big = rows().length;
      expect(big).toBeGreaterThan(small);
      // A pane that measures 0 (collapsed / not laid out) windows as the fallback
      // height rather than rendering nothing.
      spy.mockReturnValue(0);
      act(() => void window.dispatchEvent(new Event("resize")));
      expect(rows().length).toBeGreaterThan(big);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("command blocks", () => {
  const OUT5 = "l1\nl2\nl3\nl4\nl5";

  it("a call + its result (paired by toolUseId) is ONE block: `$ command — description` header, output nested, no result row", async () => {
    await mount([
      call(1, "Bash: npm test", { detail: "Run the unit tests" }),
      answer(2, 1, "Bash → 12 passed", { detail: "12 passed\n0 failed" }),
      L(3, { source: "zsh", text: "after" }),
    ]);
    expect(shown()).toEqual(["1", "3"]);
    const head = heads()[0];
    expect(head).toHaveAttribute("data-key", "tu1");
    expect(head.querySelector(".alog-block__label")).toHaveTextContent("$ npm test");
    // Description first (bold), the command after it, dimmed.
    expect(head.querySelector(".alog-block__desc")).toHaveTextContent("Run the unit tests");
    expect(head.querySelector(".alog-block__label")).toHaveClass("alog-block__label--after");
    expect(head).not.toHaveClass("alog-block__head--error");
    expect(head).toHaveAttribute("data-error", "false");
    expect(within(head).getByText("I")).toHaveClass("alog-badge--info");
    expect(outTexts()).toEqual(["12 passed", "0 failed"]);
    expect(outs()[0].dataset.key).toBe("tu1");
    // The result's own text is never a row: no row anywhere reads `Bash → 12 passed`.
    expect(document.body.textContent).not.toContain("Bash → 12 passed");
    // Two lines: no fold row.
    expect(screen.queryByTestId("alog-block-more")).toBeNull();
  });

  it("an error result colours the header red and its output rows; a pending call shows … and no output", async () => {
    await mount([
      call(1, "Bash: cargo build"),
      answer(2, 1, "Bash → error[E0308]: mismatched types", { level: "error" }),
      call(3, "Read: /work/src/lib.rs"),
    ]);
    const [failed, pending] = heads();
    expect(failed).toHaveClass("alog-block__head--error");
    expect(failed).toHaveClass("alog-row--error");
    expect(failed).toHaveAttribute("data-error", "true");
    expect(within(failed).getByText("E")).toHaveClass("alog-badge--error");
    expect(outs()[0]).toHaveClass("alog-block__out--error");
    expect(outs()[0]).toHaveTextContent("error[E0308]: mismatched types");
    expect(pending).toHaveClass("alog-block__head--pending");
    expect(pending.querySelector(".alog-block__label")).toHaveTextContent("Read /work/src/lib.rs");
    expect(pending.querySelector(".alog-block__pending")).toHaveAttribute("title", "No result yet — still running");
    expect(outs()).toHaveLength(1);
  });

  it("headers per tool: Grep quotes, a bare tool is its name, a prefix-less line is verbatim", async () => {
    await mount([
      call(1, "Grep: fn parse"),
      call(2, "TodoWrite"),
      call(3, "some prose: here"),
      call(4, "Agent: Explore the parser"),
    ]);
    expect(heads().map((h) => (h.querySelector(".alog-block__label") as HTMLElement).textContent)).toEqual([
      'Grep "fn parse"',
      "TodoWrite",
      "some prose: here",
      "Agent Explore the parser",
    ]);
  });

  it("the tolerant fallback: a result with no id pairs with the oldest preceding unanswered call of its agent", async () => {
    await mount([
      call(1, "Bash: a", { toolUseId: null }),
      call(2, "Grep: x", { toolUseId: null, source: "sub", agentId: "sub" }),
      answer(3, 0, "Grep → hit", { toolUseId: null, source: "sub", agentId: "sub" }),
      answer(4, 0, "Bash → a out", { toolUseId: null }),
    ]);
    expect(shown()).toEqual(["1", "2"]);
    const [bash, grep] = heads();
    expect(bash.dataset.key).toBe("t1");
    expect(grep.dataset.key).toBe("t2");
    expect(outs().map((o) => `${o.dataset.key}: ${(o.querySelector(".alog-block__outtext") as HTMLElement).textContent}`)).toEqual(["t1: a out", "t2: hit"]);
  });

  it("an orphan result (its call not in the ring) is a block headed by its tool name, marked `(result only)`", async () => {
    await mount([answer(9, 0, "WebFetch → Request failed with status 404", { level: "error" })]);
    const head = heads()[0];
    expect(head.dataset.key).toBe("tu0");
    expect(head.querySelector(".alog-block__label")).toHaveTextContent("WebFetch");
    expect(head.querySelector(".alog-block__orphan")).toHaveTextContent("(result only)");
    expect(head).toHaveClass("alog-block__head--error");
    expect(outs()[0]).toHaveTextContent("Request failed with status 404");
  });

  it("the invocation line Rust puts first in a result's detail is not shown twice (the gazelle case)", async () => {
    await mount([
      call(1, "Bash: curl -s localhost:8080/health && tail gazelle.log"),
      answer(2, 1, 'Bash → {"status":"ok"}', {
        detail: '$ curl -s localhost:8080/health && tail gazelle.log\n\n{"status":"ok"}\nconnected to the database',
      }),
      call(3, "Read: /work/x.rs"),
      answer(4, 3, "Read → fn main() {}", { detail: "Read: /work/x.rs\n\nfn main() {}" }),
    ]);
    expect(heads()[0].querySelector(".alog-block__label")).toHaveTextContent("$ curl -s localhost:8080/health && tail gazelle.log");
    expect(outTexts()).toEqual(['{"status":"ok"}', "connected to the database", "fn main() {}"]);
  });

  it("collapses to 3 lines with `show N more`; the toggle expands to all + `show less`; the choice survives a remount", async () => {
    const view = await mount([call(1, "Bash: x"), answer(2, 1, "Bash → l1", { detail: OUT5 })]);
    expect(outTexts()).toEqual(["l1", "l2", "l3"]);
    const more = within(screen.getByTestId("alog-block-more")).getByRole("button", { name: "show 2 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(outTexts()).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    expect(useAgentLogsStore.getState().expandedBlocks).toEqual({ tu1: true });
    const less = within(screen.getByTestId("alog-block-more")).getByRole("button", { name: "show less" });
    expect(less).toHaveAttribute("aria-expanded", "true");
    // Clicking the fold control never opens the drawer.
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    view.unmount();
    await mount([call(1, "Bash: x"), answer(2, 1, "Bash → l1", { detail: OUT5 })]);
    expect(outs()).toHaveLength(5);
    fireEvent.click(within(screen.getByTestId("alog-block-more")).getByRole("button", { name: "show less" }));
    expect(outs()).toHaveLength(3);
    expect(useAgentLogsStore.getState().expandedBlocks).toEqual({ tu1: false });
  });

  it("a query that hits output beyond the fold auto-expands the block and marks the hit rows; an explicit fold wins", async () => {
    await mount([call(1, "Bash: x"), answer(2, 1, "Bash → l1", { detail: OUT5 }), L(3, { source: "zsh", text: "l5 elsewhere" })]);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "l5" } });
    // The result matched only via its detail → the block is in, expanded, with l5 marked.
    expect(shown()).toEqual(["1", "3"]);
    expect(outs()).toHaveLength(5);
    expect(outs().filter((o) => o.classList.contains("alog-block__out--hit")).map((o) => (o.querySelector(".alog-block__outtext") as HTMLElement).textContent)).toEqual(["l5"]);
    expect(within(screen.getByTestId("alog-block-more")).getByRole("button", { name: "show less" })).toBeInTheDocument();
    fireEvent.click(btn("show less"));
    expect(outs()).toHaveLength(3);
  });

  it("Error only keeps the failed result — and its block still shows the pulled-in command header", async () => {
    await mount([
      call(1, "Bash: good"),
      answer(2, 1, "Bash → fine"),
      call(3, "Bash: bad"),
      answer(4, 3, "Bash → boom", { level: "error" }),
    ]);
    for (const name of ["Warn", "Info", "Debug"]) fireEvent.click(within(screen.getByRole("group", { name: "Levels" })).getByRole("button", { name }));
    expect(shown()).toEqual(["3"]);
    expect(heads()[0].querySelector(".alog-block__label")).toHaveTextContent("$ bad");
    expect(heads()[0]).toHaveClass("alog-block__head--error");
  });

  it("clicking a header opens the drawer with the call AND its result; an output row does the same", async () => {
    await mount([
      call(1, "Bash: npm test", { detail: "Run the unit tests" }),
      answer(2, 1, "Bash → 12 passed", { detail: "12 passed\n0 failed", tsMs: at(12, 0, 6, 0) }),
    ]);
    fireEvent.click(heads()[0]);
    const d = screen.getByTestId("alog-detail");
    expect(d.querySelector(".alog-detail__text")).toHaveTextContent("Bash: npm test");
    expect(d.querySelector(".alog-detail__more")).toHaveTextContent("Run the unit tests");
    const res = screen.getByTestId("alog-detail-result");
    expect(res).toHaveTextContent("12:00:06.000");
    expect(res).toHaveTextContent("tool-result");
    expect((d.querySelector(".alog-detail__result") as HTMLElement).textContent).toBe("12 passed\n0 failed");
    expect(heads()[0]).toHaveAttribute("aria-expanded", "true");
    expect(heads()[0]).toHaveClass("alog-row--expanded");
    fireEvent.click(heads()[0]);
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    fireEvent.click(outs()[1]);
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
    // Enter on the header toggles too.
    fireEvent.keyDown(heads()[0], { key: "Enter" });
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });

  it("the drawer for a result-only block shows the result's text; a pending call's drawer has no result section", async () => {
    await mount([call(1, "Bash: pending"), answer(9, 0, "Read → contents")]);
    fireEvent.click(heads()[1]);
    expect(screen.getByTestId("alog-detail").querySelector(".alog-detail__text")).toHaveTextContent("Read → contents");
    expect(screen.queryByTestId("alog-detail-result")).toBeNull();
    fireEvent.click(heads()[0]);
    expect(screen.getByTestId("alog-detail").querySelector(".alog-detail__text")).toHaveTextContent("Bash: pending");
    expect(screen.queryByTestId("alog-detail-result")).toBeNull();
  });

  it("the drawer stays open on a block whose CALL the filter hid but whose result is shown (the block is on screen)", async () => {
    await mount([call(1, "Bash: bad"), answer(2, 1, "Bash → boom", { level: "error" })]);
    fireEvent.click(heads()[0]);
    for (const name of ["Warn", "Info", "Debug"]) fireEvent.click(within(screen.getByRole("group", { name: "Levels" })).getByRole("button", { name }));
    expect(shown()).toEqual(["1"]);
    expect(screen.getByTestId("alog-detail")).toHaveTextContent("Bash: bad");
  });
});

describe("lifecycle dividers", () => {
  it("a system line is a centred divider with its time and text, named by source while the Source column is shown", async () => {
    await mount([
      L(1, { kind: "system", source: "sh · proj", text: "terminal opened · sh in /work/proj" }),
      L(2, { source: "sh · proj", text: "hello" }),
      L(3, { kind: "system", source: "sh · proj", level: "warn", text: "terminal exited (code 3)" }),
    ]);
    expect(rows()).toHaveLength(1);
    const [opened, exited] = dividers();
    expect(opened).toHaveTextContent("12:00:00.250");
    expect(opened).toHaveTextContent("terminal opened · sh in /work/proj");
    expect(opened.querySelector(".alog-divider__src")).toHaveTextContent("sh · proj");
    expect(opened.querySelectorAll(".alog-divider__rule")).toHaveLength(2);
    expect(opened.dataset.source).toBe("sh · proj");
    expect(exited).toHaveClass("alog-divider--warn");
    // No level badge, no source cell: it is not a log row.
    expect(opened.querySelector(".alog-badge")).toBeNull();
    expect(opened.querySelector(".alog-src--link")).toBeNull();
    // A solo does not touch the column: the divider still names its source…
    fireEvent.click(within(sideRow("sh · proj")).getAllByRole("button")[0]);
    expect(dividers()[0].querySelector(".alog-divider__src")).toHaveTextContent("sh · proj");
    // …until the USER hides the Source column.
    fireEvent.click(btn("Columns ▾"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    expect(dividers()[0].querySelector(".alog-divider__src")).toBeNull();
    expect(dividers()[0]).toHaveTextContent("terminal opened · sh in /work/proj");
  });

  it("a divider opens its detail (a task announce carries the command + output path); Enter and Space work", async () => {
    await mount([
      L(1, {
        kind: "system",
        source: "gazelle · bg",
        text: "background task started · gazelle (b1)",
        detail: "cargo run --bin gazelle\n/tmp/claude-501/x/tasks/b1.output",
      }),
    ]);
    const d = dividers()[0];
    expect(d).toHaveAttribute("title", "Open for the details");
    fireEvent.click(d);
    expect((screen.getByTestId("alog-detail").querySelector(".alog-detail__more") as HTMLElement).textContent).toBe(
      "cargo run --bin gazelle\n/tmp/claude-501/x/tasks/b1.output",
    );
    expect(d).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(d, { key: "Enter" });
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    fireEvent.keyDown(d, { key: " " });
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
    fireEvent.keyDown(d, { key: "x" });
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
  });
});

describe("toolbar filters", () => {
  const seed = [
    L(1, { level: "error", source: "zsh", text: "npm ERR! fatal" }),
    L(2, { level: "warn", kind: "tool", source: "claude · a", agentId: "a", text: "Bash: rm -rf build" }),
    L(3, { level: "info", kind: "system", source: "vite", text: "terminal opened" }),
  ];

  it("substring filter, and the N of M count", async () => {
    await mount(seed);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "rm -rf" } });
    expect(shown()).toEqual(["2"]);
    expect(screen.getByText("1 of 3 lines")).toBeInTheDocument();
  });

  it("regex filter; an invalid regex shows an inline error and does not blank the view", async () => {
    await mount(seed);
    const box = screen.getByLabelText("Filter log lines");
    fireEvent.change(box, { target: { value: "/^(npm|terminal)/" } });
    expect(shown()).toEqual(["1", "3"]);
    expect(box).toHaveAttribute("aria-invalid", "false");
    fireEvent.change(box, { target: { value: "/(/" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/^Invalid regex: /);
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(shown()).toEqual(["1", "2", "3"]);
  });

  it("level chips toggle", async () => {
    await mount(seed);
    const levels = screen.getByRole("group", { name: "Levels" });
    const err = within(levels).getByRole("button", { name: "Error" });
    expect(err).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(err);
    expect(err).toHaveAttribute("aria-pressed", "false");
    expect(shown()).toEqual(["2", "3"]);
    expect(levels).toHaveAttribute("title", expect.stringMatching(/heuristic/));
  });

  it("there are no kind chips any more: the toolbar is filter · levels · sources · columns · follow/pause/clear/copy", async () => {
    await mount(seed);
    expect(screen.queryByRole("group", { name: "Kinds" })).toBeNull();
    for (const name of ["Output", "Tools", "System", "Tasks", "Mac apps"]) expect(screen.queryByRole("button", { name })).toBeNull();
    const bar = screen.getByRole("toolbar", { name: "Agent logs controls" });
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Error",
      "Warn",
      "Info",
      "Debug",
      "All sources ▾",
      "Sources ▾",
      "Columns ▾",
      "Follow",
      "Pause",
      "Clear",
      "Copy visible",
    ]);
  });

  it("the source filter is the shared AppPicker over sources seen so far; unticking hides; All restores", async () => {
    await mount(seed);
    const trigger = btn("Filter by source");
    expect(trigger).toHaveTextContent("All sources");
    fireEvent.click(trigger);
    // Grouped like the sidebar: Terminals (zsh, vite — first seen first), then Agents.
    const opts = screen.getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual(["All sources", "zshTerminalsOnly", "viteTerminalsOnly", "claude · aAgentsOnly"]);
    // The row's checkbox is named "zshTerminals": the sublabel joins the accessible name with
    // no separator (an AppPicker gap — its `label` wraps both spans; a known issue in that
    // component). Matched on the leading name so either resolution keeps this green.
    fireEvent.click(screen.getByRole("checkbox", { name: /^zsh/ }));
    expect(shown()).toEqual(["2", "3"]);
    expect(trigger).toHaveTextContent("2 sources");
    expect(screen.getByRole("checkbox", { name: /^zsh/ })).not.toBeChecked();
    // Unticking is an exclusion: a source that appears later still shows.
    emit([L(4, { source: "new-one" })]);
    expect(shown()).toEqual(["2", "3", "4"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "All sources" }));
    expect(shown()).toEqual(["1", "2", "3", "4"]);
    expect(trigger).toHaveTextContent("All sources");
  });

  it("Only picks one source — and a source that appears later stays hidden", async () => {
    await mount(seed);
    fireEvent.click(btn("Filter by source"));
    const vite = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("vite")) as HTMLElement;
    fireEvent.click(within(vite).getByRole("button", { name: "Only" }));
    expect(shown()).toEqual(["3"]);
    expect(btn("Filter by source")).toHaveTextContent("vite");
    emit([L(4, { source: "new-one" })]);
    expect(shown()).toEqual(["3"]);
  });

  it("the source picker says so when nothing has been seen yet", async () => {
    await mount();
    fireEvent.click(btn("Filter by source"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["All sources"]);
  });
});

describe("a solo never touches the Source column — it is the user's Columns ▾ choice alone", () => {
  const two = [L(1, { source: "zsh", text: "a" }), L(2, { source: "vite", text: "b" })];
  const DEFAULT = "92px 40px 140px minmax(160px, 1fr)";

  it("a sidebar row solos: the header keeps Source, the rows keep the cell, the template is unchanged; a stream header appears instead", async () => {
    await mount(two);
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(streamHead()).toBeNull();
    fireEvent.click(within(sideRow("vite")).getByRole("button", { name: /vite/ }));
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector(".alog-src")).toHaveTextContent("vite");
    expect(rows()[0].style.gridTemplateColumns).toBe(DEFAULT);
    expect(screen.getByTestId("alog-head").style.gridTemplateColumns).toBe(DEFAULT);
    expect(streamHead()).toHaveAttribute("data-source", "vite");
    // The toolbar picker shows the same pick.
    expect(btn("Filter by source")).toHaveTextContent("vite ▾");
    fireEvent.click(screen.getByTestId("alog-src-all"));
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(streamHead()).toBeNull();
  });

  it("the picker's Only, or unticking down to one, keeps it too — and shows the stream header", async () => {
    await mount([...two, L(3, { source: "npm", text: "c" })]);
    fireEvent.click(btn("Filter by source"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^zsh/ }));
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]); // two left: no header
    expect(streamHead()).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /^npm/ }));
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]); // one left, by exclusion
    expect(streamHead()).toHaveAttribute("data-source", "vite");
    fireEvent.click(screen.getByRole("checkbox", { name: "All sources" }));
    expect(streamHead()).toBeNull();
    const vite = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("vite")) as HTMLElement;
    fireEvent.click(within(vite).getByRole("button", { name: "Only" }));
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(streamHead()).toHaveAttribute("data-source", "vite");
  });

  it("a Source column the user hid stays hidden through a solo and back to All; showing it again shows it under a solo", async () => {
    await mount(two);
    fireEvent.click(btn("Columns ▾"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    expect(headLabels()).toEqual(["Time", "Level", "Text"]);
    fireEvent.click(within(sideRow("vite")).getByRole("button", { name: /vite/ }));
    expect(headLabels()).toEqual(["Time", "Level", "Text"]);
    expect(rows()[0].querySelector(".alog-src")).toBeNull();
    fireEvent.click(screen.getByTestId("alog-src-all"));
    expect(headLabels()).toEqual(["Time", "Level", "Text"]);
    fireEvent.click(within(sideRow("vite")).getByRole("button", { name: /vite/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(useColumnLayoutStore.getState().layouts.logs?.hidden ?? []).toEqual([]);
  });

  it("the user's column layout is never written by a solo", async () => {
    await mount(two);
    fireEvent.click(within(sideRow("vite")).getByRole("button", { name: /vite/ }));
    expect(useColumnLayoutStore.getState().layouts.logs).toBeUndefined();
    fireEvent.click(btn("Columns ▾"));
    expect(screen.getByRole("menuitemcheckbox", { name: "Source" })).toBeChecked();
  });
});

describe("the stream header above a solo stream", () => {
  const lines = [
    L(1, { kind: "system", source: "gazelle · bg", text: "background task started · gazelle (b1)", detail: "./gazelle serve\n/tmp/t/b1.output" }),
    L(2, { kind: "task", source: "gazelle · bg", text: "INFO up" }),
    L(3, { kind: "task", source: "gazelle · bg", level: "error", text: "ERROR one" }),
    L(4, { kind: "system", source: "zsh · repo", text: "terminal opened · zsh in /repo" }),
    L(5, { source: "zsh · repo", text: "$ ls" }),
    L(6, { kind: "system", source: "zsh · repo", level: "warn", text: "terminal exited (code 3)" }),
    call(7, "Bash: ls"),
    L(8, { kind: "machine", source: "Safari", text: "[com.apple.Safari] hi" }),
  ];
  const headText = () => (streamHead()?.querySelector(".alog-stream-head__text") as HTMLElement).textContent;

  it("reads `<name> · <group singular> · ●/○ state · N lines · E errors`, with the display name in bold", async () => {
    await mount(lines);
    fireEvent.click(within(sideRow("gazelle · bg")).getAllByRole("button")[0]);
    expect(headText()).toBe("gazelle · service · ● running · 3 lines · 1 error");
    expect(streamHead()?.querySelector(".alog-stream-head__name")).toHaveTextContent("gazelle");
    expect(streamHead()?.querySelector(".alog-stream-head__name")?.tagName).toBe("STRONG");
    fireEvent.click(within(sideRow("zsh · repo")).getAllByRole("button")[0]);
    expect(headText()).toBe("zsh · repo · terminal · ○ stopped · 3 lines");
    fireEvent.click(within(sideRow("claude · gazelle")).getAllByRole("button")[0]);
    expect(headText()).toBe("claude · gazelle · agent · ● running · 1 line");
  });

  it("a Mac app picked through the toolbar (the stream is off, so no sidebar row) still gets its header, with the backend's word", async () => {
    await mount(lines);
    fireEvent.click(btn("Filter by source"));
    const safari = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("Safari")) as HTMLElement;
    fireEvent.click(within(safari).getByRole("button", { name: "Only" }));
    expect(headText()).toBe("Safari · Mac app · ● running · 1 line");
  });

  it("its `All sources` goes back to every source; it follows the lines as they arrive", async () => {
    await mount(lines);
    fireEvent.click(within(sideRow("gazelle · bg")).getAllByRole("button")[0]);
    emit([L(9, { kind: "system", source: "gazelle · bg", text: "background task stopped · gazelle (b1) — stopped by the agent" })]);
    expect(headText()).toBe("gazelle · service · ○ stopped · 4 lines · 1 error");
    fireEvent.click(within(streamHead() as HTMLElement).getByRole("button", { name: "All sources" }));
    expect(streamHead()).toBeNull();
    expect(useAgentLogsStore.getState().filter).toMatchObject({ onlySources: null, hiddenSources: [] });
    // Eight entries from the seed (7 + the tool call's block) and the stopped divider.
    expect(shown()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("stays while a filter empties the solo stream (it says what is selected), and is absent with two sources picked", async () => {
    await mount(lines);
    fireEvent.click(within(sideRow("gazelle · bg")).getAllByRole("button")[0]);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "nothing-matches" } });
    expect(screen.getByText(/No lines match the current filters\./)).toHaveTextContent(
      "No lines match the current filters. The text filter nothing-matches hides them. Clear filter",
    );
    expect(headText()).toBe("gazelle · service · ● running · 3 lines · 1 error");
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(useAgentLogsStore.getState().filter.query).toBe("");
    expect(screen.queryByText(/No lines match/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "nothing-matches" } });
    act(() => useAgentLogsStore.setState((s) => ({ filter: { ...s.filter, query: "", onlySources: ["gazelle · bg", "zsh · repo"] } })));
    expect(streamHead()).toBeNull();
  });
});

describe("a block's output rows carry the block's time and source, dimmed, and each line's OWN level", () => {
  const cellsOf = (row: HTMLElement) => ({
    time: row.querySelector(".alog-time")?.textContent ?? null,
    level: row.querySelector(".alog-badge")?.textContent ?? null,
    source: row.querySelector(".alog-src")?.textContent ?? null,
    dim: [...row.querySelectorAll(".alog-cell--dim")].length,
    blank: [...row.querySelectorAll(".alog-cell--blank")].length,
  });

  it("no output cell is ever blank: the call's time and the source dim, the LINE's level undimmed; the fold row stays blank", async () => {
    await mount([
      call(1, "Bash: cargo build", { tsMs: at(12, 0, 0, 250) }),
      answer(2, 1, "Bash → e1", { level: "error", tsMs: at(12, 0, 6, 0), detail: "error: e1\nerror: e2\nerror: e3\ne4" }),
    ]);
    // The header row: the block's own cells, not dimmed; red because the result failed.
    expect(cellsOf(heads()[0])).toEqual({ time: "12:00:00.250", level: "E", source: "claude · gazelle", dim: 0, blank: 0 });
    expect(outs()).toHaveLength(3);
    for (const o of outs()) {
      expect(cellsOf(o), o.dataset.index).toEqual({ time: "12:00:00.250", level: "E", source: "claude · gazelle", dim: 2, blank: 0 });
      expect(o.querySelector(".alog-badge")).toHaveClass("alog-badge--error");
      expect(o.querySelector(".alog-badge")).not.toHaveClass("alog-cell--dim");
      expect(o).toHaveClass("alog-block__out--lvl-error");
      // Never a link on an output row: the header above carries the link and the full title.
      expect(o.querySelector("button.alog-src--link")).toBeNull();
      expect(o.querySelector(".alog-src")).toHaveAttribute("title", "claude · gazelle");
    }
    expect(cellsOf(screen.getByTestId("alog-block-more"))).toEqual({ time: null, level: null, source: null, dim: 0, blank: 3 });
  });

  it("a plain line is I whatever the call's level (info under a warn-level call); an orphan result's rows use the result's own stamp", async () => {
    await mount([
      call(1, "Bash: x", { level: "warn", tsMs: at(1, 2, 3, 4) }),
      answer(2, 1, "Bash → fine", { level: "info", tsMs: at(5, 6, 7, 8) }),
      answer(9, 0, "Read → contents", { source: "sub", agentId: "sub", tsMs: at(9, 9, 9, 9) }),
    ]);
    expect(cellsOf(outs()[0])).toEqual({ time: "01:02:03.004", level: "I", source: "claude · gazelle", dim: 2, blank: 0 });
    expect(cellsOf(outs()[1])).toEqual({ time: "09:09:09.009", level: "I", source: "sub", dim: 2, blank: 0 });
  });

  it("the canonical case: `WARN gazelle::db…` inside an info result reads W in the warn colour; a failed result's plain line is not painted red", async () => {
    await mount([
      call(1, "Bash: tail gazelle.log"),
      answer(2, 1, "Bash → x", {
        level: "info",
        detail: "2026-01-01T12:00:00Z  WARN gazelle::db: pool at 90%\nlistening on :8080\nERROR: db down",
      }),
      call(3, "Bash: cargo build"),
      answer(4, 3, "Bash → y", { level: "error", detail: "Compiling foo v0.1.0" }),
    ]);
    const [warn, plain, err, compiling] = outs();
    expect(cellsOf(warn).level).toBe("W");
    expect(warn.querySelector(".alog-badge")).toHaveClass("alog-badge--warn");
    expect(warn).toHaveClass("alog-block__out--lvl-warn");
    expect(cellsOf(plain).level).toBe("I");
    expect(plain).toHaveClass("alog-block__out--lvl-info");
    expect(cellsOf(err).level).toBe("E");
    expect(err).toHaveClass("alog-block__out--lvl-error");
    // Under a FAILED result the plain line keeps its own I; the failure is the red rule
    // (`--error`) and the red header, not a red badge on every line.
    expect(cellsOf(compiling).level).toBe("I");
    expect(compiling).toHaveClass("alog-block__out--error");
    expect(compiling).not.toHaveClass("alog-block__out--lvl-error");
    expect(heads()[1]).toHaveAttribute("data-error", "true");
  });

  it("the dim cells follow the user's columns: hide Level and every output row loses its badge — and nothing else", async () => {
    await mount([call(1, "Bash: x"), answer(2, 1, "Bash → a\nb", { detail: "a\nb" })]);
    fireEvent.click(btn("Columns ▾"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Level" }));
    for (const o of outs()) expect(cellsOf(o)).toEqual({ time: "12:00:00.250", level: null, source: "claude · gazelle", dim: 2, blank: 0 });
    // …and hiding Source too leaves only the dim Time.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    for (const o of outs()) expect(cellsOf(o)).toEqual({ time: "12:00:00.250", level: null, source: null, dim: 1, blank: 0 });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    // A dimmed source still shows the service tag when it has one.
    emit([call(3, "Bash: y", { source: "svc · bg" }), answer(4, 3, "Bash → z", { source: "svc · bg" })]);
    const last = outs()[outs().length - 1];
    expect(last.querySelector(".alog-src")).toHaveTextContent("svcservice");
    expect(last.querySelector(".alog-src .alog-tag")).toHaveTextContent("service");
  });
});

describe("a block header reads description first, then the command", () => {
  const LONG = `S=/private/tmp/claude-501/-work-gazelle/sess/tasks/bgen1a2b3.output; cp $S /work/gazelle/logs/gazelle-${"x".repeat(160)}.log`;

  it("with a description: `<desc>` bold first, the command after with the `--after` modifier; the full command is in its title and in the drawer", async () => {
    await mount([call(1, `Bash: ${LONG}`, { detail: "Copy the service log aside" })]);
    const head = heads()[0];
    const cmd = head.querySelector(".alog-block__cmd") as HTMLElement;
    expect([...cmd.children].map((c) => c.className)).toEqual(["alog-block__desc", "alog-block__label alog-block__label--after", "alog-block__pending"]);
    expect(cmd.children[0]).toHaveTextContent("Copy the service log aside");
    expect(cmd.children[1]).toHaveTextContent(`$ ${LONG}`);
    expect(cmd.children[1]).toHaveAttribute("title", `$ ${LONG}`);
    fireEvent.click(head);
    expect((screen.getByTestId("alog-detail").querySelector(".alog-detail__text") as HTMLElement).textContent).toBe(`Bash: ${LONG}`);
  });

  it("without a description: the command alone, bold (no `--after`), no title", async () => {
    await mount([call(1, `Bash: ${LONG}`)]);
    const cmd = heads()[0].querySelector(".alog-block__cmd") as HTMLElement;
    expect([...cmd.children].map((c) => c.className)).toEqual(["alog-block__label", "alog-block__pending"]);
    expect(cmd.children[0]).toHaveTextContent(`$ ${LONG}`);
    expect(cmd.children[0]).not.toHaveAttribute("title");
  });

  it("a multi-line description reads on one line; a failed block colours the description too", async () => {
    await mount([
      call(1, "Bash: make", { detail: "Build it\n\nthen ship" }),
      answer(2, 1, "Bash → error", { level: "error" }),
    ]);
    expect(heads()[0].querySelector(".alog-block__desc")).toHaveTextContent("Build it ⏎ ⏎ then ship");
    expect(heads()[0]).toHaveClass("alog-block__head--error");
  });
});

describe("→ open <service> stream: a block whose output came from a file the IDE streams", () => {
  const OUT = "/private/tmp/claude-501/-work-gazelle/sess/tasks/bgen1a2b3.output";
  const service = [
    L(1, { kind: "system", source: "gazelle · bg", text: "background task started · gazelle (bgen1a2b3)", detail: `./gazelle serve\n${OUT}` }),
    L(2, { kind: "task", source: "gazelle · bg", text: "INFO up", detail: `./gazelle serve\n${OUT}` }),
  ];
  const link = (head: HTMLElement) => within(head).queryByTestId("alog-block-stream");

  it("a `grep … | tail -5` block links; a block over another file does not; the link's text names the DISPLAY name", async () => {
    await mount([
      ...service,
      call(3, `Bash: grep ERROR ${OUT} | tail -5`, { detail: "Show the last errors" }),
      answer(4, 3, "Bash → ERROR one", { detail: `$ grep ERROR ${OUT} | tail -5\n\nERROR one` }),
      call(5, "Bash: cat /work/other.log"),
    ]);
    const [grep, cat] = heads();
    expect(link(grep)).toHaveTextContent("→ open gazelle stream");
    expect(link(grep)).toHaveAttribute("data-source", "gazelle · bg");
    expect(link(grep)).toHaveAttribute("title", expect.stringMatching(/tails as the gazelle service/));
    expect(link(cat)).toBeNull();
  });

  it("clicking it solos that service (the sidebar row presses, the stream header names it) and does not open the drawer", async () => {
    await mount([...service, call(3, `Bash: tail -20 ${OUT}`)]);
    fireEvent.click(link(heads()[0]) as HTMLElement);
    expect(useAgentLogsStore.getState().filter).toMatchObject({ hiddenSources: [], onlySources: ["gazelle · bg"] });
    expect(shown()).toEqual(["1", "2"]);
    expect(within(sideRow("gazelle · bg")).getAllByRole("button")[0]).toHaveAttribute("aria-pressed", "true");
    expect(streamHead()).toHaveAttribute("data-source", "gazelle · bg");
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });

  it("the link appears once the service's paths are known — a block that names the file before its service announced is bare, then links", async () => {
    await mount([call(3, `Bash: cat ${OUT}`)]);
    expect(link(heads()[0])).toBeNull();
    // Newer ids than the call (the store ingests only ids above the last one seen).
    emit(service.map((l) => ({ ...l, id: l.id + 10 })));
    expect(link(heads()[0])).toHaveTextContent("→ open gazelle stream");
  });

  it("the result's detail counts: the Bash that started the service names its output file, so the block that started it links", async () => {
    await mount([
      call(3, "Bash: cd /work/gazelle && ./gazelle serve"),
      answer(4, 3, "Bash → Command running in background", { detail: `$ cd /work/gazelle && ./gazelle serve\n\nCommand running in background with ID: bgen1a2b3\nOutput: ${OUT}` }),
      ...service,
    ]);
    expect(link(heads()[0])).toHaveTextContent("→ open gazelle stream");
  });
});

describe("follow + the N-new pill", () => {
  it("follow keeps the newest line in view; scrolling up unfollows and counts new lines; the pill resumes", async () => {
    await mount(Array.from({ length: 50 }, (_, i) => L(i + 1)));
    const box = list();
    geometry(box, { scrollHeight: 5000, clientHeight: 300 });
    emit([L(51)]);
    expect(box.scrollTop).toBe(5000);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "true");

    // The user scrolls up.
    box.scrollTop = 1000;
    fireEvent.scroll(box);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/new$/)).toBeNull(); // nothing new yet

    emit([L(52), L(53)]);
    expect(box.scrollTop).toBe(1000); // NOT yanked to the bottom
    const pill = btn("↓ 2 new");

    fireEvent.click(pill);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "true");
    expect(box.scrollTop).toBe(5000);
    expect(screen.queryByText(/new$/)).toBeNull();
  });

  it("the pill counts only lines the filters show", async () => {
    await mount([L(1)]);
    const box = list();
    geometry(box, { scrollHeight: 5000, clientHeight: 300 });
    fireEvent.click(btn("Follow"));
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "keep" } });
    emit([L(2, { text: "keep" }), L(3, { text: "drop" })]);
    expect(btn("↓ 1 new")).toBeInTheDocument();
  });

  it("scrolling back to the bottom resumes follow", async () => {
    await mount([L(1)]);
    const box = list();
    geometry(box, { scrollHeight: 5000, clientHeight: 300 });
    box.scrollTop = 0;
    fireEvent.scroll(box);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "false");
    box.scrollTop = 4700;
    fireEvent.scroll(box);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "true");
    // A scroll that stays at the bottom leaves follow on (and the mark untouched).
    const mark = useAgentLogsStore.getState().followMark;
    box.scrollTop = 4690;
    fireEvent.scroll(box);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "true");
    expect(useAgentLogsStore.getState().followMark).toBe(mark);
  });

  it("an unfollowed reader keeps their scroll position across a remount (tab switch)", async () => {
    const { unmount } = await mount(Array.from({ length: 200 }, (_, i) => L(i + 1)));
    const box = list();
    geometry(box, { scrollHeight: 3600, clientHeight: 300 });
    box.scrollTop = 900;
    fireEvent.scroll(box);
    unmount();
    render(<AgentLogsPanel />);
    await settle();
    expect(list().scrollTop).toBe(900);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "false");
  });

  it("expanding a block under follow keeps the tail in view", async () => {
    await mount([call(1, "Bash: x"), answer(2, 1, "Bash → l1", { detail: "l1\nl2\nl3\nl4\nl5" })]);
    const box = list();
    geometry(box, { scrollHeight: 400, clientHeight: 300 });
    box.scrollTop = 0;
    fireEvent.click(btn("show 2 more"));
    expect(box.scrollTop).toBe(400);
  });
});

describe("error navigation: the sidebar's error badge", () => {
  const lines = [
    L(1, { source: "zsh", text: "zsh ok" }),
    L(2, { source: "gazelle · bg", kind: "task", text: "INFO up" }),
    L(3, { source: "gazelle · bg", kind: "task", level: "error", text: "ERROR one" }),
    L(4, { source: "zsh", level: "error", text: "zsh fails" }),
    L(5, { source: "gazelle · bg", kind: "task", text: "INFO mid" }),
    L(6, { source: "gazelle · bg", kind: "task", level: "error", text: "ERROR two" }),
    L(7, { source: "gazelle · bg", kind: "task", text: "INFO tail" }),
    L(8, { source: "gazelle · bg", kind: "task", level: "error", text: "ERROR three" }),
  ];
  const badge = (source: string) => within(sideRow(source)).getByTestId("alog-src-errors");
  const target = () => document.querySelector(".alog-row--target") as HTMLElement | null;

  it("click: solos the source, stops follow, scrolls to its first error row (index × ROW_H) and highlights it", async () => {
    await mount(lines);
    expect(badge("gazelle · bg")).toHaveTextContent("3");
    expect(badge("gazelle · bg")).toHaveAttribute("aria-label", "3 errors in gazelle — jump to the first");
    fireEvent.click(badge("gazelle · bg"));
    // Solo → the stream is [2, 3, 5, 6, 7, 8]; the first error (3) is row 1.
    expect(shown()).toEqual(["2", "3", "5", "6", "7", "8"]);
    expect(list().scrollTop).toBe(1 * ROW_H);
    expect(btn("Follow")).toHaveAttribute("aria-pressed", "false");
    expect(target()?.dataset.id).toBe("3");
    expect(useAgentLogsStore.getState().errorCursor).toEqual({ source: "gazelle · bg", lineId: 3 });
    expect(useAgentLogsStore.getState().jumpRequest).toBeNull();
  });

  it("↓ / ↑ on the focused badge step through that source's errors, wrapping at both ends", async () => {
    await mount(lines);
    // Three errors (rows 1, 3, 5) — with two, next and prev would be indistinguishable.
    expect(badge("gazelle · bg")).toHaveTextContent("3");
    fireEvent.click(badge("gazelle · bg"));
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowDown" });
    expect(target()?.dataset.id).toBe("6");
    expect(list().scrollTop).toBe(3 * ROW_H);
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowDown" });
    expect(target()?.dataset.id).toBe("8");
    expect(list().scrollTop).toBe(5 * ROW_H);
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowDown" }); // wraps to the first
    expect(target()?.dataset.id).toBe("3");
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowUp" }); // wraps to the last
    expect(target()?.dataset.id).toBe("8");
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowUp" });
    expect(target()?.dataset.id).toBe("6");
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowUp" });
    expect(target()?.dataset.id).toBe("3");
    // Other keys are not stepping keys.
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowLeft" });
    expect(target()?.dataset.id).toBe("3");
  });

  it("a click turns the Error level back on when it was off (you asked for errors); another source's badge re-solos", async () => {
    await mount(lines);
    fireEvent.click(within(screen.getByRole("group", { name: "Levels" })).getByRole("button", { name: "Error" }));
    expect(shown()).toEqual(["1", "2", "5", "7"]);
    fireEvent.click(badge("zsh"));
    expect(within(screen.getByRole("group", { name: "Levels" })).getByRole("button", { name: "Error" })).toHaveAttribute("aria-pressed", "true");
    expect(shown()).toEqual(["1", "4"]);
    expect(target()?.dataset.id).toBe("4");
    expect(list().scrollTop).toBe(1 * ROW_H);
    fireEvent.click(badge("gazelle · bg"));
    expect(target()?.dataset.id).toBe("3");
  });

  it("a failed command block counts as an error row: the jump lands on its header", async () => {
    await mount([call(1, "Bash: ok"), answer(2, 1, "Bash → fine"), call(3, "Bash: bad"), answer(4, 3, "Bash → boom", { level: "error" })]);
    fireEvent.click(badge("claude · gazelle"));
    // Stream: block 1 (2 rows), block 3 → its header is row 2.
    expect(list().scrollTop).toBe(2 * ROW_H);
    expect(target()).toBe(heads()[1]);
  });

  it("an error-level lifecycle line is a target too: the jump lands on the divider", async () => {
    await mount([
      L(1, { source: "gazelle · bg", kind: "task", text: "INFO up" }),
      L(2, { source: "gazelle · bg", kind: "system", level: "error", text: "background task stopped · gazelle (b1) — exited (code 1)" }),
    ]);
    fireEvent.click(badge("gazelle · bg"));
    expect(list().scrollTop).toBe(1 * ROW_H);
    expect(target()).toBe(dividers()[0]);
    expect(dividers()[0]).toHaveClass("alog-divider--error");
  });

  it("stepping from a cursor whose row the filter has since hidden starts over at the first error", async () => {
    await mount(lines);
    fireEvent.click(badge("gazelle · bg"));
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowDown" });
    expect(target()?.dataset.id).toBe("6");
    // Hide `ERROR two` (id 6) by query; the cursor still names it.
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "/one|three|INFO/" } });
    expect(shown()).toEqual(["2", "3", "5", "7", "8"]);
    fireEvent.keyDown(badge("gazelle · bg"), { key: "ArrowDown" });
    expect(target()?.dataset.id).toBe("3");
    expect(list().scrollTop).toBe(1 * ROW_H);
  });

  it("a jump whose target the query hides lands nowhere: the cursor clears, nothing scrolls", async () => {
    await mount(lines);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "INFO" } });
    const box = list();
    box.scrollTop = 77;
    fireEvent.click(badge("gazelle · bg"));
    expect(box.scrollTop).toBe(77);
    expect(useAgentLogsStore.getState()).toMatchObject({ jumpRequest: null, errorCursor: null });
    expect(target()).toBeNull();
  });
});

describe("pause, clear, copy", () => {
  it("Pause freezes the view and buffers; Resume shows what arrived", async () => {
    await mount([L(1)]);
    fireEvent.click(btn("Pause"));
    emit([L(2), L(3)]);
    expect(rows()).toHaveLength(1);
    const resume = btn("Resume (2 buffered)");
    expect(resume).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(resume);
    expect(rows()).toHaveLength(3);
    expect(btn("Pause")).toHaveAttribute("aria-pressed", "false");
  });

  it("Clear calls logstream_clear and empties the view", async () => {
    await mount([L(1), L(2)]);
    fireEvent.click(btn("Clear"));
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith("logstream_clear");
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId("alog-empty")).toBeInTheDocument();
  });

  it("a failed Clear keeps the lines and shows why", async () => {
    tauri.state.clear = () => Promise.reject("nope");
    await mount([L(1)]);
    fireEvent.click(btn("Clear"));
    await settle();
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not clear the log: nope");
  });

  it("Copy visible writes exactly the filtered rows, one per line", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount([
      L(1, { level: "error", source: "zsh", text: "boom\nsecond" }),
      L(2, { source: "vite", text: "ready" }),
      L(3, { source: "zsh", text: "ok" }),
    ]);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "/^(boom|ok)/" } });
    fireEvent.click(btn("Copy visible"));
    expect(writeText).toHaveBeenCalledWith(
      "12:00:00.250 E zsh  boom ⏎ second\n12:00:00.250 I zsh  ok",
    );
  });

  it("Copy visible copies a block as its header and indented output, and a divider between rules", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount([
      L(1, { kind: "system", source: "sh", text: "terminal opened · sh in /w" }),
      call(2, "Bash: npm test", { detail: "Run the unit tests" }),
      answer(3, 2, "Bash → l1", { detail: "l1\nl2\nl3\nl4" }),
    ]);
    fireEvent.click(btn("Copy visible"));
    expect(writeText).toHaveBeenCalledWith(
      [
        "12:00:00.250 I sh  ── terminal opened · sh in /w ──",
        "12:00:00.250 I claude · gazelle  $ npm test  # Run the unit tests",
        "    l1",
        "    l2",
        "    l3",
        "    … 1 more line",
      ].join("\n"),
    );
  });

  it("Copy visible swallows a clipboard rejection and is a no-op without a clipboard", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount([L(1)]);
    fireEvent.click(btn("Copy visible"));
    await expect(writeText.mock.results[0].value).rejects.toThrow("denied");
    await settle();

    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const errors: unknown[] = [];
    const onErr = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onErr);
    fireEvent.click(btn("Copy visible"));
    window.removeEventListener("error", onErr);
    expect(errors).toEqual([]);
  });
});

describe("expand detail", () => {
  it("clicking a raw row opens its detail below the list; clicking again closes it", async () => {
    await mount([L(1, { kind: "task", source: "gazelle · bg", text: "INFO up", detail: "cargo run\n/tmp/x.output" }), L(2)]);
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    fireEvent.click(rows()[0]);
    const d = screen.getByTestId("alog-detail");
    expect(d).toHaveTextContent("INFO up");
    expect(within(d).getByText("task")).toBeInTheDocument();
    expect((d.querySelector(".alog-detail__more") as HTMLElement).textContent).toBe("cargo run\n/tmp/x.output");
    expect(rows()[0]).toHaveAttribute("aria-expanded", "true");
    expect(rows()[0]).toHaveClass("alog-row--expanded");
    fireEvent.click(rows()[0]);
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });

  it("a row without detail shows its full text only; Enter toggles; the ✕ closes", async () => {
    await mount([L(1, { text: "just text" })]);
    fireEvent.keyDown(rows()[0], { key: "Enter" });
    const d = screen.getByTestId("alog-detail");
    expect(d.querySelector(".alog-detail__text")).toHaveTextContent("just text");
    expect(d.querySelector(".alog-detail__more")).toBeNull();
    fireEvent.click(btn("Close detail"));
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    fireEvent.keyDown(rows()[0], { key: " " });
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
    fireEvent.keyDown(rows()[0], { key: "a" });
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
  });

  it("the detail closes when Clear removes its line", async () => {
    await mount([L(1)]);
    fireEvent.click(rows()[0]);
    fireEvent.click(btn("Clear"));
    await settle();
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });
});

describe("source label → focus", () => {
  it("a live terminal's label is a button that focuses its tab (and does not expand the row)", async () => {
    const term = useAppStore.getState().layoutActions.openTerminalTab({ title: "zsh" });
    const ref = useAppStore.getState().tabs[term].ref as { terminalId: string };
    const other = useAppStore.getState().layoutActions.openMetricsTab(null);
    await mount([L(1, { terminalId: ref.terminalId, source: "zsh · repo" })]);
    const leaf = () => leafOfTab(useAppStore.getState().layout, term as TabId);
    expect(leaf()?.activeTabId).toBe(other);

    const label = within(rows()[0]).getByRole("button", { name: "zsh · repo" });
    expect(label).toHaveAttribute("title", "Focus zsh · repo");
    fireEvent.click(label);
    expect(leaf()?.activeTabId).toBe(term);
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    // Enter on the label is the label's own gesture — it must not also toggle the row.
    fireEvent.keyDown(label, { key: "Enter" });
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });

  it("a block header's source label links too", async () => {
    const term = useAppStore.getState().layoutActions.openTerminalTab({ title: "claude" });
    const ref = useAppStore.getState().tabs[term].ref as { terminalId: string };
    await mount([call(1, "Bash: ls", { terminalId: ref.terminalId })]);
    expect(within(heads()[0]).getByRole("button", { name: "claude · gazelle" })).toHaveAttribute("title", "Focus claude · gazelle");
  });

  it("a closed terminal's label is plain text whose title says why", async () => {
    await mount([L(1, { terminalId: "gone", source: "zsh · old" })]);
    expect(within(rows()[0]).queryByRole("button", { name: "zsh · old" })).toBeNull();
    expect(within(rows()[0]).getByText("zsh · old")).toHaveAttribute(
      "title",
      "zsh · old — That terminal is closed — there is no tab to focus",
    );
  });

  it("the label becomes plain text the moment its tab closes", async () => {
    const term = useAppStore.getState().layoutActions.openTerminalTab({ title: "zsh" });
    const ref = useAppStore.getState().tabs[term].ref as { terminalId: string };
    await mount([L(1, { terminalId: ref.terminalId, source: "zsh · repo" })]);
    expect(within(rows()[0]).getByRole("button", { name: "zsh · repo" })).toBeInTheDocument();
    act(() => {
      useAppStore.setState((s) => {
        const leaf = leafOfTab(s.layout, term);
        leaf!.tabIds = leaf!.tabIds.filter((t) => t !== term);
        delete s.tabs[term];
      });
    });
    expect(within(rows()[0]).queryByRole("button", { name: "zsh · repo" })).toBeNull();
  });
});

describe("store survives remount", () => {
  it("filters persist across unmount/mount (tab switch)", async () => {
    const { unmount } = await mount([L(1, { text: "alpha" }), L(2, { text: "beta" })]);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "beta" } });
    unmount();
    render(<AgentLogsPanel />);
    await settle();
    expect(screen.getByLabelText("Filter log lines")).toHaveValue("beta");
    expect(rows().map((r) => r.dataset.id)).toEqual(["2"]);
    expect(useAgentLogsStore.getState().lines).toHaveLength(2);
  });
});

describe("system-app (machine) rows", () => {
  const M = (id: number, p: Partial<LogLine> = {}) =>
    L(id, {
      kind: "machine",
      source: "Demo",
      text: "[com.example.demo:net] uploader: request rejected <b>x</b>",
      detail: "/Applications/Demo.app/Contents/MacOS/Demo · pid 1234",
      ...p,
    });

  it("renders the process as a hashed-colour plain label and the [subsystem:category] in green — no ◆", async () => {
    await mount([M(1), L(2, { text: "[com.x.y:z] from a terminal" })]);
    const r = rows()[0];
    expect(r).toHaveClass("alog-row--kind-machine");
    expect((r.querySelector(".alog-text") as HTMLElement).textContent).toBe(
      "[com.example.demo:net] uploader: request rejected <b>x</b>",
    );
    expect(within(r).getByText("[com.example.demo:net]")).toHaveClass("alog-hl--subsystem");
    expect(r.querySelector("b")).toBeNull(); // data, never HTML
    // The process label: plain text (no IDE tab to focus), coloured by the stable hash,
    // and its title names the binary + pid instead of "closed terminal".
    expect(within(r).queryByRole("button", { name: "Demo" })).toBeNull();
    const label = within(r).getByText("Demo");
    expect(label.className).toMatch(/^alog-src alog-src--[0-7]$/);
    expect(label).toHaveAttribute(
      "title",
      "Demo — /Applications/Demo.app/Contents/MacOS/Demo · pid 1234",
    );
  });

  it("a machine row without detail says it is an app on this computer; its detail drawer shows detail", async () => {
    await mount([M(1, { detail: null, source: "kernel" }), M(2)]);
    expect(within(rows()[0]).getByText("kernel")).toHaveAttribute("title", "kernel — an app on this computer");
    fireEvent.click(rows()[1]);
    const d = screen.getByTestId("alog-detail");
    expect(d).toHaveTextContent("machine");
    expect(d.querySelector(".alog-detail__more")).toHaveTextContent(
      "/Applications/Demo.app/Contents/MacOS/Demo · pid 1234",
    );
  });

  it("the Sources popover's IDE switch hides every IDE line and keeps machine lines", async () => {
    await mount([
      L(1),
      L(2, { kind: "tool", text: "Bash: ls" }),
      L(3, { kind: "tool-result", text: "Bash → a" }),
      L(4, { kind: "system", text: "terminal closed" }),
      M(5),
      // A background task an agent started is IDE content too (it came from an agent).
      L(6, { kind: "task", source: "gazelle · bg" }),
    ]);
    fireEvent.click(btn("Log sources"));
    const ide = screen.getByRole("checkbox", { name: "IDE terminals & agents" });
    expect(ide).toBeChecked();
    fireEvent.click(ide);
    expect(shown()).toEqual(["5"]);
    fireEvent.click(ide);
    // 2 + 3 are one block (fallback pairing, same source), 4 a divider.
    expect(shown()).toEqual(["1", "2", "4", "5", "6"]);
  });

  it("the empty state tells you where to turn on other apps", async () => {
    await mount();
    expect(screen.getByTestId("alog-empty")).toHaveTextContent(/turn on Mac apps under\s+Sources/);
  });
});

describe("the syslog status poll (from the panel)", () => {
  afterEach(() => vi.useRealTimers());

  it("polls syslog_status while mounted and stops on unmount", async () => {
    vi.useFakeTimers();
    const polls = () => tauri.invoke.mock.calls.filter((c) => c[0] === "syslog_status").length;
    const { unmount } = await mount();
    expect(polls()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(polls()).toBe(2);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(polls()).toBe(2);
  });
});

/* ───────────────── columns, detail search, and the error badge ───────────────── */

describe("columns: one grid template on the header and every row", () => {
  const head = () => screen.getByTestId("alog-head");
  const DEFAULT = "92px 40px 140px minmax(160px, 1fr)";

  it("header Time · Level · Source · Text; the header and every row — block rows included — carry the SAME template", async () => {
    await mount([L(1, { source: "claude · gazelle" }), L(2, { source: "c" }), call(3, "Bash: x"), answer(4, 3, "Bash → l1", { detail: "l1\nl2\nl3\nl4" })]);
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(head().style.gridTemplateColumns).toBe(DEFAULT);
    for (const r of document.querySelectorAll<HTMLElement>(".alog-row")) expect(r.style.gridTemplateColumns).toBe(DEFAULT);
    // A block's output rows keep the grid with a cell per non-text column: Time and Source DIM,
    // Level the line's own and not dimmed; the fold row, a control, keeps blank ones.
    for (const o of outs()) {
      expect(o.querySelectorAll(".alog-cell--dim")).toHaveLength(2);
      expect(o.querySelectorAll(".alog-badge")).toHaveLength(1);
      expect(o.querySelectorAll(".alog-cell--blank")).toHaveLength(0);
    }
    expect(screen.getByTestId("alog-block-more").querySelectorAll(".alog-cell--blank")).toHaveLength(3);
    // Fixed columns + the flex floor + 3 gaps + side padding: below it the list scrolls sideways.
    expect((head().parentElement as HTMLElement).style.minWidth).toBe(`${92 + 40 + 140 + 160 + 3 * 8 + 2 * 10}px`);
    // A resize handle on every fixed column; none on the flex Text column.
    expect(within(head()).getAllByRole("separator").map((h) => h.getAttribute("aria-label"))).toEqual([
      "Resize Time column",
      "Resize Level column",
      "Resize Source column",
    ]);
  });

  it("a long source is one cell with its full name in the title — never squeezed by the text", async () => {
    await mount([L(1, { source: "claude · gazelle-service-with-a-very-long-name", text: "x".repeat(400) })]);
    const src = rows()[0].querySelector(".alog-src") as HTMLElement;
    expect(src).toHaveTextContent("claude · gazelle-service-with-a-very-long-name");
    expect(src).toHaveAttribute("title", "claude · gazelle-service-with-a-very-long-name — Not tied to a terminal or agent");
  });

  it("dragging / nudging the Source resizer re-templates the header and the rows together", async () => {
    await mount([L(1), L(2)]);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Source column" }), { key: "ArrowRight", shiftKey: true });
    const want = "92px 40px 180px minmax(160px, 1fr)";
    expect(head().style.gridTemplateColumns).toBe(want);
    for (const r of rows()) expect(r.style.gridTemplateColumns).toBe(want);
  });

  it("Columns ▾ hides Level (cells and header gone) and Time; Text cannot be hidden; Reset restores", async () => {
    await mount([L(1, { level: "error", text: "boom" })]);
    fireEvent.click(btn("Columns ▾"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Level" }));
    expect(headLabels()).toEqual(["Time", "Source", "Text"]);
    expect(rows()[0].querySelector(".alog-badge")).toBeNull();
    expect(rows()[0].style.gridTemplateColumns).toBe("92px 140px minmax(160px, 1fr)");
    expect(rows()[0]).toHaveTextContent("12:00:00.250zshboom");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Time" }));
    expect(rows()[0].querySelector(".alog-time")).toBeNull();
    expect(rows()[0].style.gridTemplateColumns).toBe("140px minmax(160px, 1fr)");
    expect(screen.getByRole("menuitemcheckbox", { name: "Text" })).toBeDisabled();
    fireEvent.click(btn("Reset columns"));
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
  });

  it("the layout survives a remount (tab switch) — it lives in the shared store", async () => {
    const { unmount } = await mount([L(1)]);
    fireEvent.click(btn("Columns ▾"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    unmount();
    await mount([L(1)]);
    expect(headLabels()).toEqual(["Time", "Level", "Text"]);
  });

  it("no header while there is nothing to list", async () => {
    await mount();
    expect(screen.queryByTestId("alog-head")).toBeNull();
  });
});

describe("the filter searches detail too", () => {
  // The case: Claude ran a multi-line Bash command; the header shows its first line
  // and the `/health` probe lives only in the detail.
  const probe = call(1, "Bash: sleep 2 …", {
    detail: "Wait for gazelle to boot, then probe it\n\nsleep 2\ncurl -s http://localhost:8080/health | jq .",
  });
  const box = () => screen.getByLabelText("Filter log lines");

  it("`/health` finds the block whose call detail holds it, and marks the header as a detail hit", async () => {
    await mount([probe, L(2, { text: "unrelated" })]);
    fireEvent.change(box(), { target: { value: "/health" } });
    expect(shown()).toEqual(["1"]);
    const mark = within(heads()[0]).getByTestId("alog-via-detail");
    expect(mark).toHaveTextContent("detail");
    expect(mark).toHaveAttribute("title", expect.stringMatching(/matched this line's detail/));
    // The header shows the description FIRST, the command after it.
    expect(heads()[0].querySelector(".alog-block__desc")).toHaveTextContent("Wait for gazelle to boot, then probe it");
    expect(heads()[0].querySelector(".alog-block__label")).toHaveClass("alog-block__label--after");
    // A regex over the detail works the same way.
    fireEvent.change(box(), { target: { value: "/localhost:\\d+\\/health/" } });
    expect(shown()).toEqual(["1"]);
  });

  it("a hit on the row's own text carries no detail marker; no query, no marker", async () => {
    await mount([probe]);
    expect(screen.queryByTestId("alog-via-detail")).toBeNull();
    fireEvent.change(box(), { target: { value: "sleep" } });
    expect(shown()).toEqual(["1"]);
    expect(screen.queryByTestId("alog-via-detail")).toBeNull();
  });

  it("the marker shows on raw rows and dividers too", async () => {
    await mount([
      L(1, { kind: "machine", source: "app", text: "[a.b:c] hi", detail: "needle" }),
      L(2, { kind: "task", source: "g · bg", text: "INFO up", detail: "needle" }),
      L(3, { kind: "system", source: "g · bg", text: "background task started · g (b1)", detail: "needle" }),
    ]);
    fireEvent.change(box(), { target: { value: "needle" } });
    expect(screen.getAllByTestId("alog-via-detail")).toHaveLength(3);
    expect(within(dividers()[0]).getByTestId("alog-via-detail")).toBeInTheDocument();
  });
});

describe("the detail drawer closes deliberately", () => {
  it("Esc anywhere in the panel closes it; Esc with no drawer, or another key, does nothing", async () => {
    await mount([L(1, { text: "plain" })]);
    const panel = screen.getByTestId("agent-logs-panel");
    fireEvent.keyDown(panel, { key: "Escape" });
    fireEvent.click(rows()[0]);
    fireEvent.keyDown(rows()[0], { key: "x" });
    expect(screen.getByTestId("alog-detail")).toBeInTheDocument();
    fireEvent.keyDown(rows()[0], { key: "Escape" });
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    expect(useAgentLogsStore.getState().expandedId).toBeNull();
  });

  it("its ✕ is labelled and says Close (Esc)", async () => {
    await mount([L(1)]);
    fireEvent.click(rows()[0]);
    const x = btn("Close detail");
    expect(x).toHaveTextContent("✕ Close");
    expect(x).toHaveAttribute("title", "Close the detail (Esc)");
    fireEvent.click(x);
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });

  it("a filter that hides its row closes it — and clearing the filter does NOT bring it back", async () => {
    await mount([L(1, { kind: "system", text: "agent started" }), L(2, { text: "work" })]);
    fireEvent.click(dividers()[0]);
    expect(screen.getByTestId("alog-detail")).toHaveTextContent("agent started");
    const box = screen.getByLabelText("Filter log lines");
    fireEvent.change(box, { target: { value: "work" } });
    expect(screen.queryByTestId("alog-detail")).toBeNull();
    expect(useAgentLogsStore.getState().expandedId).toBeNull();
    fireEvent.change(box, { target: { value: "" } });
    expect(shown()).toEqual(["1", "2"]);
    expect(screen.queryByTestId("alog-detail")).toBeNull();
  });

  it("a filter that keeps its row keeps it open", async () => {
    await mount([L(1, { text: "work a" }), L(2, { text: "other" })]);
    fireEvent.click(rows()[0]);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "work" } });
    expect(screen.getByTestId("alog-detail")).toHaveTextContent("work a");
  });
});

describe("a renamed terminal reads by its live title everywhere Logs names it", () => {
  // The sidebar used to say `gazelle` while the Source column, the stream header and the source
  // picker still said the spawn label `bash · workspace`. Falsified: `SourceName` back on
  // `displayName` → the Source cell reads `bash · workspace` again and this goes red.
  const SPAWN = "bash · workspace";
  const lines = [
    L(1, { source: SPAWN, terminalId: "t-gen", text: "gazelle_like::main: listening" }),
    L(2, { source: "zsh", terminalId: "t-other", text: "other" }),
  ];
  const renameTo = (title: string) =>
    act(() =>
      useAppStore.setState((s) => {
        s.tabs = {
          g: { id: "g", kind: "terminal", title: "bash", customTitle: title, ref: { kind: "terminal", terminalId: "t-gen" } },
        } as unknown as typeof s.tabs;
      }),
    );

  it("Source cell, its hover, the source picker and the stream header", async () => {
    await mount(lines);
    renameTo("gazelle");
    const cellOf = (id: string) =>
      (document.querySelector(`[data-testid="alog-row"][data-id="${id}"] .alog-src`) as HTMLElement);
    expect(cellOf("1")).toHaveTextContent(/^gazelle$/);
    expect(cellOf("1").getAttribute("title")).toMatch(/^(Focus )?gazelle/);
    expect(cellOf("2")).toHaveTextContent(/^zsh$/);

    fireEvent.click(btn("Filter by source"));
    const opts = screen.getAllByRole("option").map((o) => o.textContent);
    expect(opts.some((t) => t?.startsWith("gazelle"))).toBe(true);
    expect(opts.some((t) => t?.startsWith(SPAWN))).toBe(false);
    const gen = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("gazelle")) as HTMLElement;
    fireEvent.click(within(gen).getByRole("button", { name: "Only" }));

    const head = streamHead() as HTMLElement;
    expect(head).toHaveAttribute("data-source", SPAWN); // the key is unchanged
    expect(head.querySelector(".alog-stream-head__name")).toHaveTextContent(/^gazelle$/);
    expect(head.textContent).not.toContain(SPAWN);
    expect(btn("Filter by source")).toHaveTextContent("gazelle");
  });
});
