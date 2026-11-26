/** Dev apps mounted in Logs (Apps group, app card, `kind: "app"` lines) over the real stores;
 * only the Tauri seam and terminal module are mocked. Callbacks are asserted by the STORE change
 * they make, since a store-level test cannot see which action a button calls. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    handler: null as null | ((e: { payload: unknown[] }) => void),
    handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  };
  const invoke = vi.fn((cmd: string, args: Record<string, unknown> = {}) => {
    const h = state.handlers[cmd];
    if (h !== undefined) return Promise.resolve(h(args));
    if (cmd === "logstream_snapshot") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  const listen = vi.fn((name: string, cb: (e: { payload: unknown[] }) => void) => {
    if (name === "logstream://lines") state.handler = cb;
    return Promise.resolve(() => {});
  });
  return { state, invoke, listen };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));

import { leafOfTab, useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import { receiveSample, resetMachineStore, useMachineStore } from "../network/machineStore";
import { resetNetworkStore, useNetworkStore } from "../network/networkStore";
import { pollProcsOnce, useProcsStore } from "../procs/procsStore";
import type { DevApp, ProcsList } from "../procs/procsTypes";
import { configureTerminal } from "../terminal";
import { AgentLogsPanel } from "./AgentLogsPanel";
import { resetAgentLogsForTests, useAgentLogsStore } from "./agentLogsStore";
import type { LogLine } from "./agentLogsTypes";

const T = new Date(2026, 8, 28, 11, 0, 0).getTime();
const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id,
  tsMs: T + id * 1000,
  terminalId: null,
  agentId: null,
  source: "zsh · repo",
  kind: "output",
  level: "info",
  text: `line ${id}`,
  detail: null,
  toolUseId: null,
  ...p,
});
/** An `app` line as `logstream/apps.rs` sends it. */
const A = (id: number, source: string, text: string, p: Partial<LogLine> = {}) =>
  L(id, { source, kind: "app", text, detail: `/w/web/logs/${source.split(" · ")[1]}`, ...p });

const WEB: DevApp = {
  key: "web:42",
  pid: 42,
  runtime: "node",
  name: "web",
  exe: "/usr/local/bin/node",
  argv: ["node", "server.js"],
  cwd: "/w/web",
  startedMs: T - 60_000,
  ports: [3000],
  console: "terminal",
  logFiles: [{ path: "/w/web/logs/server.log", kind: "log" }],
  containerId: null,
  origin: "external",
  terminalId: null,
  agentId: null,
  launchedBy: null,
  captured: null,
};
const API: DevApp = { ...WEB, key: "api:7", pid: 7, name: "api", ports: [], cwd: "/w/api", logFiles: [] };
let list: ProcsList;

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
const emit = (lines: LogLine[]) => act(() => (tauri.state.handler as (e: { payload: unknown[] }) => void)({ payload: lines }));
const section = () => screen.getByTestId("procs-section");
const appRow = (key: string) => within(section()).getAllByTestId("procs-row").find((r) => r.dataset.key === key) as HTMLElement;
const srcRow = (source: string) =>
  screen.getAllByTestId("alog-src-row").find((r) => r.dataset.source === source) as HTMLElement | undefined;
const rowSources = () => screen.queryAllByTestId("alog-row").map((r) => r.dataset.source);
const only = () => useAgentLogsStore.getState().filter.onlySources;
const card = () => screen.queryByTestId("procs-card");

async function mount(lines: LogLine[] = []) {
  render(<AgentLogsPanel />);
  await settle();
  if (lines.length > 0) emit(lines);
  await screen.findAllByTestId("procs-row");
}

beforeEach(() => {
  resetAgentLogsForTests();
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  useColumnLayoutStore.setState({ layouts: {} });
  list = { available: true, reason: null, apps: [WEB, API] };
  tauri.state.handlers = { procs_list: () => list, syslog_status: () => null };
  tauri.invoke.mockClear();
});
afterEach(() => {
  resetAgentLogsForTests();
});

const STREAMING: LogLine[] = [
  L(1, { kind: "system", text: "terminal opened · zsh in /repo" }),
  L(2, { text: "$ ls" }),
  L(3, { source: "web · server.log", kind: "system", text: "app log started · web · server.log" }),
  A(4, "web · server.log", "INFO GET / 200 in 3ms"),
  A(5, "web · server.log", "ERROR upstream refused", { level: "error" }),
  A(6, "web · access.log", "GET /health 200"),
];

describe("`app` lines in the stream", () => {
  it("render RAW, like a service line — one row each, no command block, the app kind on the row", async () => {
    await mount(STREAMING);
    const rows = screen.getAllByTestId("alog-row").filter((r) => r.dataset.source?.startsWith("web · "));
    expect(rows.map((r) => r.dataset.id)).toEqual(["4", "5", "6"]);
    expect(rows.every((r) => r.className.includes("alog-row--kind-app"))).toBe(true);
    expect(rows[1].className).toContain("alog-row--error");
    expect(screen.queryAllByTestId("alog-block-head")).toEqual([]);
    // Its source is not a link (no tab produced it); the title says where it comes from.
    const cell = rows[0].querySelector(".alog-src") as HTMLElement;
    expect(cell.tagName).toBe("SPAN");
    expect(cell.title).toBe("web · server.log — /w/web/logs/server.log");
  });

  it("a line without a detail still says what it is", async () => {
    await mount([A(1, "web · server.log", "x", { detail: null })]);
    expect((screen.getAllByTestId("alog-row")[0].querySelector(".alog-src") as HTMLElement).title).toBe(
      "web · server.log — a dev app's log",
    );
  });

  it("the IDE switch off hides the terminal but keeps the app's stream (the user started it on this machine)", async () => {
    await mount(STREAMING);
    act(() => useAgentLogsStore.getState().setIde(false));
    expect(rowSources()).toEqual(["web · server.log", "web · server.log", "web · access.log"]);
  });

  it("the text filter searches `app` lines like any raw line", async () => {
    await mount(STREAMING);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "upstream" } });
    expect(screen.getAllByTestId("alog-row").map((r) => r.dataset.id)).toEqual(["5"]);
    // …and the sidebar's nested row shows its match count.
    expect(within(srcRow("web · server.log") as HTMLElement).getByTestId("alog-src-matches").textContent).toBe("1");
  });

  it("⌘F finds matches inside `app` lines and marks them", async () => {
    await mount(STREAMING);
    const row = screen.getAllByTestId("alog-row").find((r) => r.dataset.id === "4") as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: "f", metaKey: true });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    fireEvent.change(screen.getByTestId("alog-find-input"), { target: { value: "200" } });
    expect(screen.getByTestId("alog-find-count").textContent).toBe("1/2");
    const marked = [...document.querySelectorAll(".alog-find-hit")].map((m) => m.closest("[data-testid=alog-row]")?.getAttribute("data-id"));
    expect(marked).toEqual(["4", "6"]);
  });
});

describe("the sidebar's Apps group (it absorbed the older “On this Mac” group)", () => {
  it("sits at the TOP of the list, right under All and above every other group", async () => {
    await mount(STREAMING);
    const listEl = screen.getByTestId("alog-sidebar").querySelector(".alog-side__list") as HTMLElement;
    expect(listEl.firstElementChild).toBe(screen.getByTestId("alog-src-all"));
    expect(listEl.children[1]).toBe(section());
    expect(section().getAttribute("role")).toBe("group");
    expect(section().getAttribute("aria-label")).toBe("Apps");
    // Its first row is All apps, then every runtime section.
    expect(section().children[1].contains(screen.getByTestId("alog-src-all-apps"))).toBe(true);
    // The `app` sources are NOT a group of their own up top.
    expect(screen.getAllByTestId("alog-src-group").map((g) => g.getAttribute("aria-label"))).toEqual(["Terminals"]);
  });

  it("places each `app` source under its app's row, labelled by file", async () => {
    await mount(STREAMING);
    const server = srcRow("web · server.log") as HTMLElement;
    const access = srcRow("web · access.log") as HTMLElement;
    expect(section().contains(server)).toBe(true);
    expect(server.dataset.group).toBe("app");
    expect(server.className).toContain("alog-side__row--nested");
    expect(server.querySelector(".alog-side__name")?.textContent).toBe("server.log");
    expect(access.querySelector(".alog-side__name")?.textContent).toBe("access.log");
    // Directly under the web row, in the ring's order; the api row comes after them.
    expect(appRow("web:42").nextElementSibling).toBe(server);
    expect(server.nextElementSibling).toBe(access);
    expect(access.nextElementSibling).toBe(appRow("api:7"));
    expect(within(server).getByTestId("alog-src-count").textContent).toBe("3");
  });

  it("a stream whose app has exited is its own row at the end of the group, with its full name", async () => {
    await mount([...STREAMING, A(7, "gone · worker.log", "still here")]);
    const orphan = srcRow("gone · worker.log") as HTMLElement;
    expect(section().lastElementChild).toBe(orphan);
    expect(orphan.className).not.toContain("alog-side__row--nested");
    expect(orphan.querySelector(".alog-side__name")?.textContent).toBe("gone · worker.log");
    // Stopped, it can be dismissed like any stopped source.
    emit([L(8, { source: "gone · worker.log", kind: "system", text: "app log stopped · gone · worker.log — the process exited" })]);
    fireEvent.click(within(srcRow("gone · worker.log") as HTMLElement).getByLabelText("Dismiss gone · worker.log"));
    expect(srcRow("gone · worker.log")).toBeUndefined();
  });

  it("a nested stream row solos that stream and keeps the app selected; clicked again it goes back to All and lets the app go", async () => {
    await mount(STREAMING);
    fireEvent.click(appRow("web:42"));
    fireEvent.click(within(srcRow("web · access.log") as HTMLElement).getByRole("button", { pressed: false }));
    expect(only()).toEqual(["web · access.log"]);
    expect(useProcsStore.getState().selectedKey).toBe("web:42");
    fireEvent.click(within(srcRow("web · access.log") as HTMLElement).getByRole("button", { pressed: true }));
    expect(only()).toBeNull();
    expect(useProcsStore.getState().selectedKey).toBeNull();
    expect(card()).toBeNull();
  });
});

describe("selecting an app", () => {
  it("solos its running streams and shows its card between the stream header and the list", async () => {
    await mount(STREAMING);
    fireEvent.click(appRow("web:42"));
    expect(only()).toEqual(["web · server.log", "web · access.log"]);
    expect(rowSources()).toEqual(["web · server.log", "web · server.log", "web · access.log"]);
    const c = card() as HTMLElement;
    expect(c.dataset.key).toBe("web:42");
    const main = c.parentElement as HTMLElement;
    const order = [...main.children].map((e) => e.getAttribute("data-testid"));
    expect(order.indexOf("procs-card")).toBeLessThan(order.indexOf("alog-list"));
    expect(screen.queryByTestId("alog-app-hint")).toBeNull();
  });

  it("with one stream, the stream header names it and the card sits right under it", async () => {
    await mount(STREAMING.filter((l) => l.source !== "web · access.log"));
    fireEvent.click(appRow("web:42"));
    expect(only()).toEqual(["web · server.log"]);
    const head = screen.getByTestId("alog-stream-head");
    expect(head.textContent).toMatch(/^web · server\.log · app log · ● running · 3 lines · 1 error/);
    expect(head.nextElementSibling).toBe(card());
  });

  it("with no stream yet: the card, and “Pick a log to stream” where the rows would be", async () => {
    await mount(STREAMING);
    fireEvent.click(appRow("api:7"));
    expect(only()).toEqual([]);
    expect((card() as HTMLElement).dataset.key).toBe("api:7");
    expect(screen.getByTestId("alog-app-hint").textContent).toMatch(/^Pick a log to stream/);
    expect(rowSources()).toEqual([]);
  });

  it("the hint wins over the empty ring's welcome text", async () => {
    await mount();
    fireEvent.click(appRow("api:7"));
    expect(screen.getByTestId("alog-app-hint")).toBeTruthy();
    expect(screen.queryByTestId("alog-empty")).toBeNull();
  });

  it("clicking the app again deselects it: no card, back to All", async () => {
    await mount(STREAMING);
    fireEvent.click(appRow("api:7"));
    fireEvent.click(appRow("api:7"));
    expect(card()).toBeNull();
    expect(only()).toBeNull();
  });

  it.each([
    ["All", () => fireEvent.click(screen.getByTestId("alog-src-all"))],
    ["another source", () => fireEvent.click(within(srcRow("zsh · repo") as HTMLElement).getAllByRole("button")[0])],
    ["the stream header's All sources", () => fireEvent.click(screen.getByRole("button", { name: "All sources" }))],
  ])("picking %s clears the app selection and its card", async (_name, pick) => {
    await mount(STREAMING.filter((l) => l.source !== "web · access.log"));
    fireEvent.click(appRow("web:42"));
    expect(card()).not.toBeNull();
    pick();
    expect(useProcsStore.getState().selectedKey).toBeNull();
    expect(card()).toBeNull();
  });

  it("the app exiting while its empty pick is shown: the card goes and the stream is back to All", async () => {
    await mount(STREAMING);
    fireEvent.click(appRow("api:7"));
    list = { available: true, reason: null, apps: [WEB] };
    await act(() => pollProcsOnce());
    expect(card()).toBeNull();
    expect(only()).toBeNull();
    expect(screen.queryByTestId("alog-app-hint")).toBeNull();
  });
});

describe("the card's callbacks", () => {
  it("Stream: the new stream is soloed, and the app stays selected", async () => {
    tauri.state.handlers.logstream_tail_app = () => ({ key: "tail-1", source: "web · server.log" });
    await mount([L(1, { text: "$ ls" })]);
    fireEvent.click(appRow("web:42"));
    expect(only()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Stream server.log" }));
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith("logstream_tail_app", { pid: 42, path: "/w/web/logs/server.log" });
    expect(only()).toEqual(["web · server.log"]);
    expect(useProcsStore.getState().selectedKey).toBe("web:42");
    expect(screen.queryByTestId("alog-app-hint")).toBeNull();
  });

  it("Restart in the IDE: the terminal Rust opened gets a tab, and that tab is focused", async () => {
    tauri.state.handlers.procs_restart_prepare = () => ({ token: "tok", summary: { name: "web", cwd: "/w/web", argv: ["node", "server.js"] } });
    tauri.state.handlers.procs_restart_in_ide = () => ({ terminalId: "01JRESTART0000000000000000" });
    await mount(STREAMING);
    const other = useAppStore.getState().layoutActions.openMetricsTab(null);
    fireEvent.click(appRow("web:42"));
    fireEvent.click(screen.getByTestId("procs-restart"));
    fireEvent.click(screen.getByTestId("procs-restart-confirm"));
    await settle();
    const s = useAppStore.getState();
    const tab = Object.values(s.tabs).find((t) => t.ref.kind === "terminal" && t.ref.terminalId === "01JRESTART0000000000000000");
    expect(tab?.title).toBe("web");
    // Adopted through the REATTACH path (TerminalRegistry → `terminal_reattach`, which replays
    // the scrollback of the PTY Rust opened) — never a second spawn.
    expect(configureTerminal).toHaveBeenCalledWith("01JRESTART0000000000000000", { reattach: true, cwd: "/w/web" });
    expect(leafOfTab(s.layout, tab!.id as TabId)?.activeTabId).toBe(tab!.id);
    expect(leafOfTab(s.layout, other)?.activeTabId).not.toBe(other);
  });

  it("connections →: Network opens in Whole Mac mode with that pid's row selected", async () => {
    await mount(STREAMING);
    fireEvent.click(appRow("web:42"));
    fireEvent.click(screen.getByTestId("procs-connections"));
    expect(useNetworkStore.getState().mode).toBe("machine");
    const s = useAppStore.getState();
    const net = Object.values(s.tabs).find((t) => t.ref.kind === "network");
    expect(leafOfTab(s.layout, net!.id)?.activeTabId).toBe(net!.id);
    // No sample yet (Whole Mac was not sampling): the pid waits for the first one that has it.
    expect(useMachineStore.getState().pendingPid).toBe(42);
    receiveSample({ tsMs: 1, apps: [{ key: "node:42", name: "node", pid: 42 } as never] });
    expect(useMachineStore.getState().selectedKey).toBe("node:42");
    expect(useMachineStore.getState().expanded).toEqual(["node:42"]);
  });
});

/* ── apps the IDE's own terminals and agents started ── */

const GAZELLE: DevApp = {
  ...WEB,
  key: "gazelle:77",
  pid: 77,
  runtime: "rust",
  name: "gazelle",
  exe: "/work/gazelle/target/debug/gazelle",
  argv: ["target/debug/gazelle"],
  cwd: "/work/gazelle",
  ports: [3000],
  console: "ide-terminal",
  logFiles: [],
  origin: "ide",
  terminalId: "t-9",
  agentId: "a-1",
  launchedBy: "claude · gazelle",
};
const VITE: DevApp = { ...GAZELLE, key: "vite:78", pid: 78, runtime: "node", name: "vite", exe: "/usr/local/bin/node", ports: [5173] };
/** The root agent `a-1`, running in the terminal `t-9` — their lines share the label. */
const AGENT: LogLine[] = [
  L(1, { source: "claude · gazelle", terminalId: "t-9", agentId: "a-1", kind: "system", text: "agent started · claude" }),
  L(2, { source: "claude · gazelle", terminalId: "t-9", agentId: "a-1", kind: "tool", text: "Bash cargo run", toolUseId: "u1" }),
  L(3, { source: "claude · other", agentId: "a-2", kind: "tool", text: "Read x", toolUseId: "u2" }),
];

describe("apps the IDE started", () => {
  it("sit first in their runtime's section, tagged by who started them; external ones after, tagged `external`", async () => {
    list = { available: true, reason: null, apps: [WEB, { ...VITE, key: "vite:ext", origin: "external", terminalId: null, agentId: null, launchedBy: null, name: "site" }, VITE, GAZELLE] };
    await mount(AGENT);
    const rows = within(section()).getAllByTestId("procs-row");
    expect(rows.map((r) => `${r.dataset.runtime} ${r.dataset.key} ${within(r).getByTestId("procs-origin").textContent}`)).toEqual([
      "rust gazelle:77 by claude · gazelle",
      "node vite:78 by claude · gazelle",
      "node web:42 external",
      "node vite:ext external",
    ]);
  });

  it("an agent row counts its running apps; another agent, none", async () => {
    list = { available: true, reason: null, apps: [GAZELLE, VITE, { ...WEB, origin: "external", agentId: "a-1" }] };
    await mount(AGENT);
    const row = srcRow("claude · gazelle") as HTMLElement;
    expect(row.dataset.group).toBe("agent");
    const badge = within(row).getByTestId("alog-src-apps");
    expect(badge.textContent).toBe("2 apps");
    expect(badge.getAttribute("title")).toBe("Running apps this agent started: gazelle, vite");
    expect(within(srcRow("claude · other") as HTMLElement).queryByTestId("alog-src-apps")).toBeNull();
    list = { available: true, reason: null, apps: [GAZELLE] };
    await act(() => pollProcsOnce());
    expect(within(srcRow("claude · gazelle") as HTMLElement).getByTestId("alog-src-apps").textContent).toBe("1 app");
  });

  it("a soloed agent's stream header lists its apps as links; one selects the app and shows its card", async () => {
    list = { available: true, reason: null, apps: [GAZELLE, VITE] };
    await mount(AGENT);
    fireEvent.click(within(srcRow("claude · gazelle") as HTMLElement).getAllByRole("button")[0]);
    const links = within(screen.getByTestId("alog-stream-head-apps")).getAllByTestId("alog-stream-head-app");
    expect(links.map((l) => l.textContent)).toEqual(["gazelle", "vite"]);
    expect(screen.getByTestId("alog-stream-head-apps").textContent).toBe("runninggazellevite");
    fireEvent.click(links[1]);
    expect(useProcsStore.getState().selectedKey).toBe("vite:78");
    expect((card() as HTMLElement).dataset.key).toBe("vite:78");
    // The app's (empty) pick replaced the agent's: no header, so no links.
    expect(only()).toEqual([]);
    expect(screen.queryByTestId("alog-stream-head-apps")).toBeNull();
    // Another agent's header lists nothing.
    fireEvent.click(within(srcRow("claude · other") as HTMLElement).getAllByRole("button")[0]);
    expect(screen.getByTestId("alog-stream-head").dataset.source).toBe("claude · other");
    expect(screen.queryByTestId("alog-stream-head-apps")).toBeNull();
  });

  it("a soloed terminal (not an agent) lists no apps even when the label is shared", async () => {
    list = { available: true, reason: null, apps: [GAZELLE] };
    await mount([L(1, { source: "bash · w", terminalId: "t-9", agentId: null, kind: "output", text: "$ cargo run" })]);
    fireEvent.click(within(srcRow("bash · w") as HTMLElement).getAllByRole("button")[0]);
    expect(screen.getByTestId("alog-stream-head")).toBeTruthy();
    expect(screen.queryByTestId("alog-stream-head-apps")).toBeNull();
  });

  it("the card: console is the terminal named by its TAB, Open terminal focuses that tab; no Restart; the hint says so", async () => {
    list = { available: true, reason: null, apps: [GAZELLE] };
    await mount(AGENT);
    useAppStore.getState().layoutActions.rebuildTerminalTabs([
      { id: "t-9" as never, kind: "terminal", title: "bash · gazelle", cwd: "/work/gazelle", cols: 80, rows: 24, status: "live" },
    ]);
    const other = useAppStore.getState().layoutActions.openMetricsTab(null);
    fireEvent.click(appRow("gazelle:77"));
    const c = card() as HTMLElement;
    expect(within(c).getByTestId("procs-console-terminal").textContent).toBe("bash · gazelle");
    expect(within(c).queryByTestId("procs-restart")).toBeNull();
    expect(screen.getByTestId("alog-app-hint").textContent).toBe(
      "Its console is an IDE terminalgazelle prints to the terminal bash · gazelle — press Open terminal in the card above, or pick that terminal in Sources.",
    );
    fireEvent.click(within(c).getByTestId("procs-open-terminal"));
    const s = useAppStore.getState();
    const tab = Object.values(s.tabs).find((t) => t.ref.kind === "terminal" && t.ref.terminalId === "t-9");
    expect(leafOfTab(s.layout, tab!.id as TabId)?.activeTabId).toBe(tab!.id);
    expect(leafOfTab(s.layout, other)?.activeTabId).not.toBe(other);
  });

  it("the hint without a tab names the launcher, then says “it runs in”", async () => {
    list = { available: true, reason: null, apps: [GAZELLE, { ...VITE, launchedBy: null, terminalId: null }] };
    await mount();
    fireEvent.click(appRow("gazelle:77"));
    expect(screen.getByTestId("alog-app-hint").textContent).toContain("prints to the terminal claude · gazelle —");
    fireEvent.click(appRow("vite:78"));
    expect(screen.getByTestId("alog-app-hint").textContent).toContain("prints to the terminal it runs in —");
  });

  it("requests →: Network opens in IDE traffic with the Process picker on the app's executable name", async () => {
    list = { available: true, reason: null, apps: [GAZELLE] };
    useNetworkStore.setState({ mode: "machine", processSelection: ["curl"], filter: "leftover" });
    await mount();
    fireEvent.click(appRow("gazelle:77"));
    fireEvent.click(screen.getByTestId("procs-requests"));
    const n = useNetworkStore.getState();
    expect(n.mode).toBe("ide");
    expect(n.processSelection).toEqual(["gazelle"]);
    expect(n.filter).toBe("");
    const s = useAppStore.getState();
    const net = Object.values(s.tabs).find((t) => t.ref.kind === "network");
    expect(leafOfTab(s.layout, net!.id)?.activeTabId).toBe(net!.id);
  });

  it("a file a Service already tails: “Already streaming as gazelle” solos the service — nothing is tailed", async () => {
    list = {
      available: true,
      reason: null,
      apps: [{ ...GAZELLE, console: "file", logFiles: [{ path: "/work/gazelle/gazelle.log", kind: "stdout" }] }],
    };
    await mount([
      L(1, {
        source: "gazelle · bg",
        kind: "system",
        text: "background task started · gazelle (b1)",
        detail: "cargo run > gazelle.log\n/work/gazelle/gazelle.log",
      }),
      L(2, { source: "gazelle · bg", kind: "task", text: "listening on :3000" }),
    ]);
    fireEvent.click(appRow("gazelle:77"));
    const already = screen.getByTestId("procs-already");
    expect(already.textContent).toBe("Already streaming as gazelle");
    fireEvent.click(screen.getByTestId("procs-already-link"));
    expect(only()).toEqual(["gazelle · bg"]);
    expect(tauri.invoke.mock.calls.some((c) => c[0] === "logstream_tail_app")).toBe(false);
  });
});

/* ── the app row IS its log stream ── */

describe("an app whose console a Service tails (matched by file path, never by name)", () => {
  const OUT = "/tmp/claude-501/p/s/tasks/bz9.output";
  const G: DevApp = { ...GAZELLE, console: "file", logFiles: [{ path: OUT, kind: "stdout" }] };
  // The service was named after its LAUNCHER — `python3 run_server.py …` execve'd gazelle.
  const SERVICE: LogLine[] = [
    L(1, { source: "python3 · bg", kind: "system", text: "background task started · python3 (bz9)", detail: `python3 run_server.py --run\n${OUT}` }),
    L(2, { source: "python3 · bg", kind: "task", text: "INFO gazelle::http: listening on 0.0.0.0:3000", detail: `python3 run_server.py --run\n${OUT}` }),
    L(3, { source: "python3 · bg", kind: "task", text: "WARN gazelle::db: slow query", level: "warn", detail: `python3 run_server.py --run\n${OUT}` }),
    ...AGENT,
  ];

  it("gazelle sits under Rust · Cargo, named gazelle, ● live; the Service row keeps its place, NAMED gazelle", async () => {
    list = { available: true, reason: null, apps: [WEB, G] };
    await mount(SERVICE);
    const rust = within(section()).getAllByTestId("procs-runtime").find((x) => x.dataset.runtime === "rust") as HTMLElement;
    const row = within(rust).getByTestId("procs-row");
    expect(row.querySelector(".procs-side__name")?.textContent).toBe("gazelle");
    expect(within(row).getByTestId("procs-live")).toBeTruthy();
    expect(within(rust).getByTestId("procs-runtime-count").textContent).toBe("1");
    const svc = srcRow("python3 · bg") as HTMLElement;
    expect(svc.dataset.group).toBe("task");
    expect(svc.querySelector(".alog-side__name")?.textContent).toBe("gazelle");
    expect(within(svc).getByTestId("alog-src-tag").textContent).toBe("service");
    // Nowhere does the sidebar say `python3`.
    expect(screen.getByTestId("alog-sidebar").textContent).not.toContain("python3");
  });

  it("clicking the app solos exactly the service's stream — raw gazelle lines, no agent blocks; the header names gazelle; both rows selected", async () => {
    list = { available: true, reason: null, apps: [G] };
    await mount(SERVICE);
    fireEvent.click(appRow("gazelle:77"));
    expect(only()).toEqual(["python3 · bg"]);
    expect(rowSources()).toEqual(["python3 · bg", "python3 · bg"]);
    expect(screen.queryAllByTestId("alog-block-head")).toEqual([]);
    const head = screen.getByTestId("alog-stream-head");
    expect(head.querySelector(".alog-stream-head__name")?.textContent).toBe("gazelle");
    expect(head.querySelector(".alog-stream-head__name")?.getAttribute("title")).toBe("python3 — the stream of gazelle");
    expect(appRow("gazelle:77").getAttribute("aria-pressed")).toBe("true");
    expect(within(srcRow("python3 · bg") as HTMLElement).getAllByRole("button")[0].getAttribute("aria-pressed")).toBe("true");
    expect((card() as HTMLElement).dataset.key).toBe("gazelle:77");
    // The card does not offer a second tail of that file: it links to the stream.
    expect(screen.getByTestId("procs-already").textContent).toBe("Already streaming as python3");
  });

  it("clicking the Service row selects the app too; clicked again, back to All and the app is let go", async () => {
    list = { available: true, reason: null, apps: [G] };
    await mount(SERVICE);
    const main = () => within(srcRow("python3 · bg") as HTMLElement).getAllByRole("button")[0];
    fireEvent.click(main());
    expect(only()).toEqual(["python3 · bg"]);
    expect(useProcsStore.getState().selectedKey).toBe("gazelle:77");
    expect(appRow("gazelle:77").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(main());
    expect(only()).toBeNull();
    expect(useProcsStore.getState().selectedKey).toBeNull();
    expect(card()).toBeNull();
  });

  it("a Service tailing some OTHER file is left alone: its own name, its own click", async () => {
    list = { available: true, reason: null, apps: [{ ...G, logFiles: [{ path: "/elsewhere.log", kind: "stdout" }] }] };
    await mount(SERVICE);
    const svc = srcRow("python3 · bg") as HTMLElement;
    expect(svc.querySelector(".alog-side__name")?.textContent).toBe("python3");
    fireEvent.click(within(svc).getAllByRole("button")[0]);
    expect(only()).toEqual(["python3 · bg"]);
    expect(useProcsStore.getState().selectedKey).toBeNull();
    expect(screen.getByTestId("alog-stream-head").querySelector(".alog-stream-head__name")?.textContent).toBe("python3");
    expect(within(appRow("gazelle:77")).queryByTestId("procs-live")).toBeNull();
  });
});

describe("All apps (the Apps group's first row)", () => {
  const OUT = "/tmp/claude-501/p/s/tasks/bz9.output";
  const G: DevApp = { ...GAZELLE, console: "file", logFiles: [{ path: OUT, kind: "stdout" }] };
  const LINES: LogLine[] = [
    ...STREAMING,
    L(10, { source: "python3 · bg", kind: "task", text: "INFO up", detail: `python3 x\n${OUT}` }),
    A(11, "gone · worker.log", "orphan line"),
  ];

  it("solos every app stream at once — each app's, then the orphans; its count is their lines; clicked again, All", async () => {
    list = { available: true, reason: null, apps: [WEB, G] };
    await mount(LINES);
    const btn = screen.getByTestId("alog-src-all-apps");
    expect(btn.textContent).toBe("All apps6"); // server.log 3 (its open line too) + access.log 1 + the service 1 + the orphan 1
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(only()).toEqual(["web · server.log", "web · access.log", "python3 · bg", "gone · worker.log"]);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    // Several sources: no single-stream header; the terminal's lines are gone.
    expect(screen.queryByTestId("alog-stream-head")).toBeNull();
    expect(rowSources()).not.toContain("zsh · repo");
    fireEvent.click(btn);
    expect(only()).toBeNull();
  });

  it("a stream that STOPPED still counts and solos — its row under the app still shows its lines", async () => {
    list = { available: true, reason: null, apps: [WEB] };
    await mount([
      L(3, { source: "web · server.log", kind: "system", text: "app log started · web · server.log" }),
      A(4, "web · server.log", "INFO GET / 200 in 3ms"),
      A(5, "web · server.log", "INFO GET /x 200 in 1ms"),
      L(6, { source: "web · server.log", kind: "system", text: "app log stopped · web · server.log — process exited" }),
    ]);
    const btn = screen.getByTestId("alog-src-all-apps") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).not.toBe("All apps0");
    fireEvent.click(btn);
    expect(only()).toEqual(["web · server.log"]);
  });

  it("counts matches while a filter is on", async () => {
    list = { available: true, reason: null, apps: [WEB, G] };
    await mount(LINES);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "GET" } });
    expect(screen.getByTestId("alog-src-all-apps").textContent).toBe("All apps2");
  });

  it("with nothing streaming it is disabled, and its wrapper says why", async () => {
    await mount([L(1, { text: "$ ls" })]);
    const btn = screen.getByTestId("alog-src-all-apps") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.parentElement?.getAttribute("title")).toBe("No app streams anything yet — Stream a log from an app's card");
    expect(btn.textContent).toBe("All apps0");
  });

  it("a tail started from a card counts before any of its lines arrive", async () => {
    tauri.state.handlers.logstream_tail_app = () => ({ key: "tail-1", source: "web · server.log" });
    await mount([L(1, { text: "$ ls" })]);
    fireEvent.click(appRow("web:42"));
    fireEvent.click(screen.getByRole("button", { name: "Stream server.log" }));
    await settle();
    const btn = screen.getByTestId("alog-src-all-apps") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.parentElement?.getAttribute("title")).toBe("Every app's log streams, together");
    expect(btn.textContent).toBe("All apps0");
  });
});
