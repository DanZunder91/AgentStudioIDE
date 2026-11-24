/**
 * The Sources sidebar, rendered inside the real AgentLogsPanel over the
 * real store; only the Tauri seam and the xterm-owning terminal module are mocked (the
 * AgentLogsPanel.test.tsx harness). Lines are driven through the captured `listen` handler,
 * exactly as Rust would. Successor of the Running strip's tests: derivation, click-to-solo,
 * dismiss, empty state — plus the grouping, the match counts and the error badge.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    snapshot: [] as unknown[],
    handler: null as null | ((e: { payload: unknown[] }) => void),
    syslog: null as unknown,
  };
  const invoke = vi.fn((cmd: string) => {
    if (cmd === "syslog_status") return Promise.resolve(state.syslog);
    if (cmd === "logstream_snapshot") return Promise.resolve(state.snapshot);
    return Promise.resolve(undefined);
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
import { AgentLogsPanel } from "./AgentLogsPanel";
import { resetAgentLogsForTests, useAgentLogsStore } from "./agentLogsStore";
import type { LogLine, SyslogStatus } from "./agentLogsTypes";
import { RUNNING_TICK_MS, sourcesEmpty } from "./SourcesSidebar";

const T = new Date(2026, 8, 24, 20, 0, 0).getTime();
const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id,
  tsMs: T + id * 1000,
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
const sys = (id: number, source: string, text: string) => L(id, { source, kind: "system", text });

/** A service an agent started, its terminal, the agent itself: the gazelle case. */
const GAZELLE: LogLine[] = [
  sys(1, "zsh · gazelle", "terminal opened · zsh in /work/gazelle"),
  L(2, { source: "zsh · gazelle", text: "$ ls" }),
  sys(3, "gazelle · bg", "background task started · gazelle (bgen1)"),
  L(4, { source: "gazelle · bg", kind: "task", text: "INFO listening on :8080" }),
  L(5, { source: "gazelle · bg", kind: "task", level: "error", text: "ERROR upstream closed" }),
  sys(6, "tail · bg", "background task started · tail (bmon2)"),
  sys(7, "tail · bg", "background task stopped · tail (bmon2) — no output for 10 min"),
  L(8, { source: "claude · gazelle", agentId: "a1", kind: "tool", toolUseId: "tu1", text: "Bash: cargo run" }),
  L(9, { source: "claude · gazelle", agentId: "a1", kind: "tool-result", toolUseId: "tu1", level: "error", text: "Bash → failed" }),
];

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

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const emit = (lines: LogLine[]) =>
  act(() => (tauri.state.handler as (e: { payload: unknown[] }) => void)({ payload: lines }));
const shownIds = () =>
  [...document.querySelectorAll('[data-testid="alog-row"], [data-testid="alog-divider"], [data-testid="alog-block-head"]')].map((r) =>
    Number((r as HTMLElement).dataset.id),
  );
const sidebar = () => screen.getByTestId("alog-sidebar");
const rowEls = () => screen.queryAllByTestId("alog-src-row");
const rowOf = (source: string) => rowEls().find((c) => c.dataset.source === source) as HTMLElement;
const mainOf = (source: string) => within(rowOf(source)).getAllByRole("button")[0];
const groups = () =>
  screen.queryAllByTestId("alog-src-group").map((g) => [
    g.getAttribute("aria-label"),
    within(g)
      .getAllByTestId("alog-src-row")
      .map((r) => r.dataset.source),
  ]);

async function mount(snapshot: LogLine[] = []) {
  tauri.state.snapshot = snapshot;
  const r = render(<AgentLogsPanel />);
  await settle();
  return r;
}

beforeEach(() => {
  resetAgentLogsForTests();
  resetStore();
  useColumnLayoutStore.setState({ layouts: {} });
  tauri.state.snapshot = [];
  tauri.state.handler = null;
  tauri.state.syslog = SYSLOG();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  resetAgentLogsForTests();
});

describe("the Sources sidebar", () => {
  it("empty: says what will show up here; All is pressed and counts 0", async () => {
    await mount();
    // The fixture's backend is macOS' unified log, so the machine group is "Mac apps".
    expect(screen.getByTestId("alog-src-empty")).toHaveTextContent(
      "Nothing yet — terminals, services your agents start, agents and Mac apps you stream show up here.",
    );
    expect(screen.getByTestId("alog-src-all")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("alog-src-all")).toHaveTextContent("All0");
    expect(sidebar()).toHaveTextContent("Sources 0 running");
    expect(rowEls()).toHaveLength(0);
  });

  it("empty on Windows: names the group the sidebar really has — System apps, never Mac apps", async () => {
    tauri.state.syslog = SYSLOG({ backend: "windows-eventlog" });
    await mount();
    expect(screen.getByTestId("alog-src-empty")).toHaveTextContent(
      "Nothing yet — terminals, services your agents start, agents and System apps you stream show up here.",
    );
    expect(sourcesEmpty("Mac apps")).toMatch(/agents and Mac apps you stream/);
  });

  it("groups Services · Terminals · Agents, running first in each, with line counts, an error badge, and ●/○", async () => {
    await mount(GAZELLE);
    expect(groups()).toEqual([
      ["Services", ["gazelle · bg", "tail · bg"]],
      ["Terminals", ["zsh · gazelle"]],
      ["Agents", ["claude · gazelle"]],
    ]);
    const read = rowEls().map((c) => [
      c.dataset.source,
      c.dataset.group,
      c.dataset.running,
      within(c).getByTestId("alog-src-count").textContent,
      within(c).queryByTestId("alog-src-errors")?.textContent ?? "-",
      c.className.includes("alog-side__row--stopped"),
    ]);
    expect(read).toEqual([
      ["gazelle · bg", "task", "true", "3", "1", false],
      ["tail · bg", "task", "false", "2", "-", true],
      ["zsh · gazelle", "terminal", "true", "2", "-", false],
      ["claude · gazelle", "agent", "true", "2", "1", false],
    ]);
    expect(sidebar()).toHaveTextContent("Sources 3 running");
    expect(screen.getByTestId("alog-src-all")).toHaveTextContent("All9");
    expect(rowOf("gazelle · bg").querySelector(".alog-side__dot--on")).toHaveTextContent("●");
    expect(rowOf("tail · bg").querySelector(".alog-side__dot")).toHaveTextContent("○");
    expect(mainOf("tail · bg").getAttribute("title")).toMatch(
      /^tail · Service, stopped (just now|.+ ago) — no output for 10 min\n2 lines\n/,
    );
  });

  it("display names: a service reads `gazelle` + a `service` tag, never ` · bg`; other groups have no tag; the key stays the wire label", async () => {
    await mount(GAZELLE);
    const read = rowEls().map((c) => [
      c.dataset.source,
      (c.querySelector(".alog-side__name") as HTMLElement).textContent,
      c.querySelector('[data-testid="alog-src-tag"]')?.textContent ?? null,
    ]);
    expect(read).toEqual([
      ["gazelle · bg", "gazelle", "service"],
      ["tail · bg", "tail", "service"],
      ["zsh · gazelle", "zsh · gazelle", null],
      ["claude · gazelle", "claude · gazelle", null],
    ]);
    // Nothing the eye reads in the sidebar ends in ` · bg`.
    for (const el of sidebar().querySelectorAll(".alog-side__name")) expect(el.textContent).not.toMatch(/ · bg$/);
    // The tag is decoration: the buttons' accessible names are the plain display names.
    expect(within(rowOf("gazelle · bg")).getByRole("button", { name: "1 error in gazelle — jump to the first" })).toBeInTheDocument();
    expect(within(rowOf("tail · bg")).getByRole("button", { name: "Dismiss tail" })).toBeInTheDocument();
  });

  it("Services is the FIRST group, and a running service is emphasised — a stopped one, a terminal, an agent are not", async () => {
    await mount(GAZELLE);
    expect(screen.getAllByTestId("alog-src-group")[0]).toHaveAttribute("aria-label", "Services");
    expect(rowOf("gazelle · bg")).toHaveClass("alog-side__row--emph");
    expect(rowOf("tail · bg")).not.toHaveClass("alog-side__row--emph");
    expect(rowOf("zsh · gazelle")).not.toHaveClass("alog-side__row--emph");
    expect(rowOf("claude · gazelle")).not.toHaveClass("alog-side__row--emph");
    // The emphasis follows the state: gazelle stops → plain; tail restarts → emphasised.
    emit([
      sys(20, "gazelle · bg", "background task stopped · gazelle (bgen1) — exited (code 1)"),
      sys(21, "tail · bg", "background task started · tail (bmon3)"),
    ]);
    expect(rowOf("gazelle · bg")).not.toHaveClass("alog-side__row--emph");
    expect(rowOf("tail · bg")).toHaveClass("alog-side__row--emph");
  });

  it("click a row = only that source (the toolbar picker agrees); click it again = every source", async () => {
    await mount(GAZELLE);
    fireEvent.click(mainOf("gazelle · bg"));
    expect(shownIds()).toEqual([3, 4, 5]);
    expect(mainOf("gazelle · bg")).toHaveAttribute("aria-pressed", "true");
    expect(rowOf("gazelle · bg")).toHaveClass("alog-side__row--solo");
    expect(mainOf("zsh · gazelle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("alog-src-all")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Filter by source" })).toHaveTextContent("gazelle ▾");
    fireEvent.click(mainOf("gazelle · bg"));
    expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(mainOf("gazelle · bg")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking another row switches the pick; All goes back to every source", async () => {
    await mount(GAZELLE);
    const all = screen.getByTestId("alog-src-all");
    expect(all).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mainOf("gazelle · bg"));
    fireEvent.click(mainOf("zsh · gazelle"));
    expect(shownIds()).toEqual([1, 2]);
    expect(all).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(all);
    expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(useAgentLogsStore.getState().filter.onlySources).toBeNull();
  });

  it("a source hidden through the picker also un-presses All; a row click replaces that exclusion", async () => {
    await mount(GAZELLE);
    act(() => useAgentLogsStore.setState((s) => ({ filter: { ...s.filter, hiddenSources: ["tail · bg"] } })));
    expect(screen.getByTestId("alog-src-all")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mainOf("tail · bg"));
    expect(shownIds()).toEqual([6, 7]);
    expect(useAgentLogsStore.getState().filter.hiddenSources).toEqual([]);
  });

  it("a two-source pick from the picker presses no row; a click on one narrows to exactly it", async () => {
    await mount(GAZELLE);
    act(() => useAgentLogsStore.setState((s) => ({ filter: { ...s.filter, onlySources: ["tail · bg", "gazelle · bg"] } })));
    expect(rowEls().map((c) => within(c).getAllByRole("button")[0].getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
      "false",
    ]);
    fireEvent.click(mainOf("tail · bg"));
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual(["tail · bg"]);
  });

  it("a stopped row can be dismissed; it comes back if it logs again. A running one has no ✕", async () => {
    await mount(GAZELLE);
    expect(within(rowOf("gazelle · bg")).queryByRole("button", { name: "Dismiss gazelle" })).toBeNull();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Dismiss tail" }));
    expect(rowOf("tail · bg")).toBeUndefined();
    expect(useAgentLogsStore.getState().runningDismissed).toEqual({ "tail · bg": 7 });
    emit([sys(10, "tail · bg", "background task started · tail (bmon3)")]);
    expect(rowOf("tail · bg").dataset.running).toBe("true");
  });

  it("collapses to a thin strip, and stays collapsed across a remount (a tab switch)", async () => {
    const view = await mount(GAZELLE);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Hide sources" }));
    expect(rowEls()).toHaveLength(0);
    expect(sidebar()).toHaveClass("alog-side--closed");
    const show = within(sidebar()).getByRole("button", { name: "Show sources" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(show).toHaveAttribute("title", "Show the sources sidebar (3 running)");
    expect(screen.queryByTestId("alog-src-empty")).toBeNull();
    // The stream itself is untouched.
    expect(shownIds()).toHaveLength(8);
    view.unmount();
    await mount();
    expect(within(sidebar()).getByRole("button", { name: "Show sources" })).toBeInTheDocument();
    expect(useAgentLogsStore.getState().sidebarOpen).toBe(false);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Show sources" }));
    expect(within(sidebar()).getByRole("button", { name: "Hide sources" })).toHaveAttribute("aria-expanded", "true");
    expect(rowEls()).toHaveLength(4);
  });

  it("Mac-app sources appear, under a `Mac apps` group, only while the system-apps stream runs", async () => {
    const mac = L(11, { source: "Safari", kind: "machine", text: "[com.apple.Safari] loaded" });
    await mount([...GAZELLE, mac]);
    expect(rowOf("Safari")).toBeUndefined();
    expect(groups().map((g) => g[0])).toEqual(["Services", "Terminals", "Agents"]);
    tauri.state.syslog = SYSLOG({ running: true, filter: { ...SYSLOG().filter, enabled: true } });
    await act(async () => {
      await useAgentLogsStore.getState().refreshSyslogStatus();
    });
    expect(rowOf("Safari").dataset.running).toBe("true");
    expect(groups().map((g) => g[0])).toEqual(["Services", "Terminals", "Agents", "Mac apps"]);
    expect(mainOf("Safari").getAttribute("title")).toMatch(/^Safari · Mac apps source, running/);
  });

  it("the machine group reads System apps off macOS", async () => {
    tauri.state.syslog = SYSLOG({ backend: "linux-journald", running: true, filter: { ...SYSLOG().filter, enabled: true } });
    await mount([L(1, { source: "nginx", kind: "machine", text: "[nginx.service] up" })]);
    expect(groups()).toEqual([["System apps", ["nginx"]]]);
  });

  it("the 'how long ago' in a title refreshes on its own", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T + 7000);
    await mount(GAZELLE);
    expect(mainOf("tail · bg").getAttribute("title")).toContain("stopped just now");
    act(() => {
      vi.setSystemTime(T + 7000 + 3 * 60_000);
      vi.advanceTimersByTime(RUNNING_TICK_MS);
    });
    expect(mainOf("tail · bg").getAttribute("title")).toContain("stopped 3 min ago");
  });
});

describe("search is global, results are per source", () => {
  it("with a query, every row shows its MATCH count instead of its line count — regardless of the pick — and All sums them", async () => {
    await mount(GAZELLE);
    fireEvent.click(mainOf("zsh · gazelle")); // looking at one source…
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "/opened|listening|cargo/" } });
    // …the counts still say what EVERY source would show for the query.
    const read = rowEls().map((c) => [
      c.dataset.source,
      within(c).queryByTestId("alog-src-count")?.textContent ?? "-",
      within(c).queryByTestId("alog-src-matches")?.textContent ?? "-",
    ]);
    expect(read).toEqual([
      ["gazelle · bg", "-", "1"], // `INFO listening on :8080`
      ["tail · bg", "-", "0"],
      ["zsh · gazelle", "-", "1"], // `terminal opened · zsh in /work/gazelle`
      ["claude · gazelle", "-", "1"], // `Bash: cargo run`
    ]);
    expect(within(rowOf("tail · bg")).getByTestId("alog-src-matches")).toHaveClass("alog-side__matches--none");
    expect(within(rowOf("zsh · gazelle")).getByTestId("alog-src-matches")).toHaveAttribute("title", "1 of 2 lines match the filter");
    expect(screen.getByTestId("alog-src-all")).toHaveTextContent("All3");
    // The stream shows the matches in place, within the picked source.
    expect(shownIds()).toEqual([1]);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "" } });
    expect(within(rowOf("zsh · gazelle")).getByTestId("alog-src-count")).toHaveTextContent("2");
  });

  it("a level switched off counts too; an invalid regex does not", async () => {
    await mount(GAZELLE);
    fireEvent.click(within(screen.getByRole("group", { name: "Levels" })).getByRole("button", { name: "Info" }));
    expect(rowEls().map((c) => within(c).getByTestId("alog-src-matches").textContent)).toEqual(["1", "0", "0", "1"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Levels" })).getByRole("button", { name: "Info" }));
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "/(/" } });
    expect(screen.queryAllByTestId("alog-src-matches")).toHaveLength(0);
  });
});

describe("the error badge is a button", () => {
  it("click posts a `first` jump for that source; ↓ / ↑ post next / prev; a source without errors has no badge", async () => {
    await mount(GAZELLE);
    expect(within(rowOf("zsh · gazelle")).queryByTestId("alog-src-errors")).toBeNull();
    const badge = within(rowOf("gazelle · bg")).getByTestId("alog-src-errors");
    expect(badge).toHaveAttribute("title", "1 error. Click: jump to the first. ↑/↓ while focused: step through them.");
    fireEvent.click(badge);
    expect(useAgentLogsStore.getState().errorCursor).toEqual({ source: "gazelle · bg", lineId: 5 });
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual(["gazelle · bg"]);
    // The badge click must not also toggle the row's solo off.
    expect(mainOf("gazelle · bg")).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(badge, { key: "ArrowDown" });
    expect(useAgentLogsStore.getState().errorCursor).toEqual({ source: "gazelle · bg", lineId: 5 }); // one error: stays
    // The agent's failed block is an error too: its badge jumps to the block.
    fireEvent.click(within(rowOf("claude · gazelle")).getByTestId("alog-src-errors"));
    expect(useAgentLogsStore.getState().errorCursor).toEqual({ source: "claude · gazelle", lineId: 8 });
    expect(screen.getByTestId("alog-block-head")).toHaveClass("alog-row--target");
  });
});

describe("the sidebar is resizable (long app names)", () => {
  const handle = () => screen.getByTestId("alog-side-resizer");
  const width = () => useAgentLogsStore.getState().sidebarWidth;

  it("defaults to 280px and renders that width", async () => {
    await mount();
    expect(width()).toBe(280);
    expect(screen.getByTestId("alog-sidebar").style.width).toBe("280px");
  });

  it("drag widens from the width at drag start; release stops; clamps to 180–560", async () => {
    await mount();
    fireEvent.pointerMove(handle(), { clientX: 900 });
    expect(width()).toBe(280);
    fireEvent.pointerDown(handle(), { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 160 });
    expect(width()).toBe(340);
    expect(screen.getByTestId("alog-sidebar").style.width).toBe("340px");
    fireEvent.pointerMove(handle(), { clientX: 2000 });
    expect(width()).toBe(560);
    fireEvent.pointerMove(handle(), { clientX: -2000 });
    expect(width()).toBe(180);
    fireEvent.pointerUp(handle());
    fireEvent.pointerMove(handle(), { clientX: 400 });
    expect(width()).toBe(180);
  });

  it("keyboard ←/→ by 10, Shift by 40, other keys ignored; double-click resets", async () => {
    await mount();
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(width()).toBe(290);
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(width()).toBe(250);
    fireEvent.keyDown(handle(), { key: "c" });
    expect(width()).toBe(250);
    fireEvent.doubleClick(handle());
    expect(width()).toBe(280);
  });
});
