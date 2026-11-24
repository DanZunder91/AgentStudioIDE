/**
 * The Network panel's two modes over mocked IPC seams (only `./netcapIpc` and
 * `./netmachineIpc` are replaced; stores, formatters and the shared AppPicker are real):
 * the mode switch, the Whole-computer table, and the Source picker in IDE traffic mode.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import type { Tab, TabId } from "../../app/types";
import { resetStore } from "../../test/store-harness";
import type { FlowSummary, MachineApp, MachineConn, MachineSample, MachineStatus, NetcapStatus } from "./networkTypes";

const ipc = vi.hoisted(() => ({
  netcapStatus: vi.fn(),
  netcapSet: vi.fn(),
  netcapSnapshot: vi.fn(),
  netcapFlow: vi.fn(),
  netcapClear: vi.fn(),
  listenFlows: vi.fn(),
  NETCAP_FLOW_EVENT: "netcap://flow",
}));
vi.mock("./netcapIpc", () => ipc);
const mach = vi.hoisted(() => ({
  netmachineStatus: vi.fn(),
  netmachineStart: vi.fn(),
  netmachineStop: vi.fn(),
  listenSamples: vi.fn(),
  NETMACHINE_SAMPLE_EVENT: "netmachine://sample",
}));
vi.mock("./netmachineIpc", () => mach);

import { NO_BYTES_TITLE, OTHER_USER_TITLE } from "./machineFormat";
import { resetMachineStore, useMachineStore } from "./machineStore";
import { NetworkPanel } from "./NetworkPanel";
import { resetNetworkStore, useNetworkStore } from "./networkStore";

const NETCAP: NetcapStatus = {
  running: true, port: 51234, enabled: true, decrypt: false, caPath: null,
  skippedReason: null, passthroughHosts: [], flowCount: 0, decryptApps: [], portChanged: null,
};
const MAC: MachineStatus = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };

function conn(o: Partial<MachineConn> = {}): MachineConn {
  return {
    proto: "tcp4", local: "10.0.0.5:50000", remote: "17.253.1.1:443", remoteHost: null,
    state: "Established", bytesIn: 2048, bytesOut: 512, rateIn: 100, rateOut: 10, ...o,
  };
}
function app(name: string, pid: number, o: Partial<MachineApp> = {}): MachineApp {
  return {
    key: `${name}:${pid}`, name, pid, user: "self", bytesIn: 4096, bytesOut: 1024,
    rateIn: 2048, rateOut: 512, connections: [conn()], ...o,
  };
}

const SAFARI = app("Safari", 501, {
  rateIn: 3 * 1024, rateOut: 1024, bytesIn: 5 * 1024 * 1024, bytesOut: 2048,
  connections: [
    conn({ remote: "17.253.1.1:443", remoteHost: "apple.com", bytesIn: 4096, bytesOut: 100 }),
    conn({ proto: "tcp6", local: "[::1]:8021", remote: null, state: "Listen", bytesIn: null, bytesOut: null }),
  ],
});
const SLACK = app("Slack", 777, { rateIn: 1024, rateOut: 2048, bytesIn: 1024, bytesOut: 4096 });
const MYSTERY = app("?", 0, { user: "other", rateIn: null, rateOut: null, bytesIn: null, bytesOut: null,
  connections: [conn({ bytesIn: null, bytesOut: null })] });
const SAMPLE: MachineSample = { tsMs: 1, apps: [SLACK, SAFARI, MYSTERY] };

let emitSample: (s: MachineSample) => void = () => {};

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  vi.clearAllMocks();
  ipc.listenFlows.mockResolvedValue(() => {});
  ipc.netcapStatus.mockResolvedValue(NETCAP);
  ipc.netcapSnapshot.mockResolvedValue([]);
  mach.listenSamples.mockImplementation(async (h: (s: MachineSample) => void) => {
    emitSample = h;
    return () => {};
  });
  mach.netmachineStatus.mockResolvedValue({ ...MAC, running: false });
  mach.netmachineStart.mockResolvedValue(MAC);
  mach.netmachineStop.mockResolvedValue({ ...MAC, running: false });
});
afterEach(() => {
  resetNetworkStore();
  resetMachineStore();
});

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 5)));
const modeBtn = (name: string | RegExp) => within(screen.getByRole("group", { name: "Network mode" })).getByRole("button", { name });

async function mountMachine(sample: MachineSample | null = SAMPLE) {
  const view = render(<NetworkPanel />);
  await settle();
  fireEvent.click(modeBtn("Whole Mac"));
  await settle();
  if (sample) act(() => emitSample(sample));
  return view;
}
const appRow = (key: string) => document.querySelector(`[data-app-key="${key}"]`) as HTMLElement;
const appCells = (key: string) => Array.from(appRow(key).children).map((td) => td.textContent);
const appKeys = () => screen.queryAllByTestId("netm-row").map((r) => r.getAttribute("data-app-key"));
const box = () => screen.getByTestId("netm-scroll");
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(box(), { key: k, ...init });

describe("mode switch", () => {
  it("starts in IDE traffic; the machine label reads Whole Mac on the nettop backend", async () => {
    render(<NetworkPanel />);
    await settle();
    expect(modeBtn("IDE traffic")).toHaveAttribute("aria-pressed", "true");
    expect(modeBtn("Whole Mac")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("net-title")).toBeInTheDocument();
    expect(mach.netmachineStart).not.toHaveBeenCalled();
  });

  it("reads Whole computer on Linux, and before the status is known", async () => {
    let resolve: (s: MachineStatus) => void = () => {};
    mach.netmachineStatus.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<NetworkPanel />);
    expect(modeBtn("Whole computer")).toBeInTheDocument();
    await act(async () => resolve({ ...MAC, backend: "linux-proc" }));
    expect(modeBtn("Whole computer")).toBeInTheDocument();
  });

  it("entering starts sampling once; leaving stops it once", async () => {
    await mountMachine();
    expect(mach.netmachineStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("net-title")).toBeNull();
    fireEvent.click(modeBtn("IDE traffic"));
    await settle();
    expect(mach.netmachineStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("net-title")).toBeInTheDocument();
  });

  it("the mode survives a remount (a tab switch), and unmounting stops sampling", async () => {
    const first = await mountMachine();
    first.unmount();
    await settle();
    expect(mach.netmachineStop).toHaveBeenCalledTimes(1);
    expect(useNetworkStore.getState().mode).toBe("machine");
    render(<NetworkPanel />);
    await settle();
    expect(modeBtn("Whole Mac")).toHaveAttribute("aria-pressed", "true");
    expect(mach.netmachineStart).toHaveBeenCalledTimes(2);
  });

  it("under StrictMode, entering the mode sends exactly one start and no stop", async () => {
    useNetworkStore.setState({ mode: "machine" });
    render(
      <StrictMode>
        <NetworkPanel />
      </StrictMode>,
    );
    await settle();
    expect(mach.netmachineStart).toHaveBeenCalledTimes(1);
    expect(mach.netmachineStop).not.toHaveBeenCalled();
  });
});

describe("whole-computer table", () => {
  it("groups by app with the contract's columns, sorted by ↓/s, and a summary header", async () => {
    await mountMachine();
    const heads = within(screen.getByRole("table", { name: "Apps and connections" }))
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(heads).toEqual(["App", "PID", "Conns", "↓/s ▼", "↑/s", "↓ total", "↑ total"]);
    // Safari's listener is hidden by default: 1 connection shown.
    expect(appKeys()).toEqual(["Safari:501", "Slack:777", "?:0"]);
    expect(appCells("Safari:501")).toEqual(["▸ Safari", "501", "1", "3.0KB/s", "1.0KB/s", "5.0MB", "2.0KB"]);
    expect(screen.getByTestId("netm-title")).toHaveTextContent(
      "Whole Mac — 3 apps · 3 connections · ↓ 4.0KB/s ↑ 3.0KB/s",
    );
  });

  it("null bytes read — with a title; another user's process dims and says why; pid 0 is —", async () => {
    await mountMachine();
    const cells = Array.from(appRow("?:0").children) as HTMLElement[];
    expect(cells.slice(3).map((c) => c.textContent)).toEqual(["—", "—", "—", "—"]);
    for (const c of cells.slice(3)) {
      expect(c).toHaveAttribute("title", NO_BYTES_TITLE);
      expect(c).toHaveClass("netm-na");
    }
    expect(cells[1]).toHaveTextContent("—");
    expect(cells[1]).toHaveAttribute("title", "Unknown process");
    expect(appRow("?:0")).toHaveClass("netm-row--other");
    expect(appRow("?:0")).toHaveAttribute("title", OTHER_USER_TITLE);
    // Known numbers have neither.
    const safari = Array.from(appRow("Safari:501").children) as HTMLElement[];
    expect(safari[3]).not.toHaveAttribute("title");
    expect(safari[3]).not.toHaveClass("netm-na");
    expect(appRow("Safari:501")).not.toHaveClass("netm-row--other");
    expect(appRow("Safari:501")).not.toHaveAttribute("title");
  });

  it("click expands an app into its connections; Hide listeners off shows the listener", async () => {
    await mountMachine();
    fireEvent.click(appRow("Safari:501"));
    expect(appRow("Safari:501")).toHaveAttribute("aria-expanded", "true");
    const t = screen.getByRole("table", { name: "Safari connections" });
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Proto", "Local", "Remote (host)", "State", "↓", "↑",
    ]);
    const connCells = () => screen.getAllByTestId("netm-conn").map((r) => Array.from(r.children).map((c) => c.textContent));
    expect(connCells()).toEqual([["tcp4", "10.0.0.5:50000", "apple.com (17.253.1.1:443)", "Established", "4.0KB", "100B"]]);
    fireEvent.click(screen.getByRole("switch", { name: "Hide listeners" }));
    expect(screen.getByRole("switch", { name: "Hide listeners" })).toHaveAttribute("aria-checked", "false");
    expect(connCells()[1]).toEqual(["tcp6", "[::1]:8021", "—", "Listen", "—", "—"]);
    expect(appCells("Safari:501")[2]).toBe("2");
    fireEvent.click(appRow("Safari:501"));
    expect(screen.queryByRole("table", { name: "Safari connections" })).toBeNull();
  });

  it("an app with no socket list says so when expanded; UDP's empty state reads —", async () => {
    await mountMachine({
      tsMs: 1,
      apps: [
        app("kernel_task", 1, { connections: [] }),
        app("dns", 2, { connections: [conn({ proto: "udp4", state: "", remote: "1.1.1.1:53" })] }),
      ],
    });
    fireEvent.click(appRow("kernel_task:1"));
    expect(screen.getByText("No sockets listed for this process.")).toBeInTheDocument();
    fireEvent.click(appRow("dns:2"));
    expect(Array.from(screen.getByTestId("netm-conn").children).map((c) => c.textContent)[3]).toBe("—");
  });

  it("a backend with no byte counts (Windows) hides the rate and total columns, their sort and the totals", async () => {
    // Windows' connection tables carry no bytes: four columns of — forever, before this.
    const WIN: MachineStatus = { available: true, backend: "windows-iphlpapi", reason: null, running: true, hasBytes: false };
    mach.netmachineStatus.mockResolvedValue({ ...WIN, running: false });
    mach.netmachineStart.mockResolvedValue(WIN);
    const blind = { rateIn: null, rateOut: null, bytesIn: null, bytesOut: null };
    const nb = (o: Partial<MachineConn> = {}) => conn({ bytesIn: null, bytesOut: null, rateIn: null, rateOut: null, ...o });
    render(<NetworkPanel />);
    await settle();
    fireEvent.click(modeBtn("Whole computer"));
    await settle();
    act(() =>
      emitSample({
        tsMs: 1,
        apps: [
          app("svchost", 900, { ...blind, connections: [nb()] }),
          app("chrome", 4242, { ...blind, connections: [nb(), nb({ remote: "1.1.1.1:443" }), nb({ remote: "8.8.8.8:443" })] }),
          // The pid-0 group (sockets whose owner is gone, TIME_WAIT) — Linux's name for it.
          app("no process", 0, { ...blind, connections: [nb({ state: "TimeWait" }), nb({ state: "TimeWait", remote: "9.9.9.9:80" })] }),
        ],
      }),
    );
    const heads = within(screen.getByRole("table", { name: "Apps and connections" }))
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    // The stored sort is ↓/s (hidden here): busiest first instead, by connection count.
    expect(heads).toEqual(["App", "PID", "Conns ▼"]);
    expect(appKeys()).toEqual(["chrome:4242", "no process:0", "svchost:900"]);
    expect(appCells("no process:0")).toEqual(["▸ no process", "—", "2"]);
    expect(appRow("no process:0").children[1]).toHaveAttribute("title", "Unknown process");
    expect(screen.getByTestId("netm-title")).toHaveTextContent(/^Whole computer — 3 apps · 6 connections$/);
    // The Columns menu does not offer them either.
    fireEvent.click(screen.getByRole("button", { name: /^Columns/ }));
    const menu = screen.getByRole("menu", { name: "Columns" });
    expect(within(menu).getAllByRole("menuitemcheckbox").map((b) => b.closest("label")!.textContent)).toEqual(["App", "PID", "Conns"]);
    fireEvent.keyDown(window, { key: "Escape" });
    // A socket list without ↓ / ↑.
    fireEvent.click(appRow("svchost:900"));
    const t = screen.getByRole("table", { name: "svchost connections" });
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Proto", "Local", "Remote (host)", "State"]);
    expect(Array.from(screen.getByTestId("netm-conn").children).map((c) => c.textContent)).toEqual([
      "tcp4", "10.0.0.5:50000", "17.253.1.1:443", "Established",
    ]);
    // The user's sort is kept: on a backend with bytes it applies again.
    expect(useMachineStore.getState().sort).toEqual({ key: "rateIn", dir: "desc" });
  });

  it("header click sorts; the same header flips; aria-sort follows", async () => {
    await mountMachine();
    const th = (name: RegExp) => screen.getByRole("button", { name }).closest("th")!;
    fireEvent.click(screen.getByRole("button", { name: /^↑\/s/ }));
    expect(appKeys()).toEqual(["Slack:777", "Safari:501", "?:0"]);
    expect(th(/^↑\/s/)).toHaveAttribute("aria-sort", "descending");
    expect(th(/^↓\/s/)).toHaveAttribute("aria-sort", "none");
    fireEvent.click(screen.getByRole("button", { name: /^App/ }));
    expect(appKeys()).toEqual(["?:0", "Safari:501", "Slack:777"]);
    expect(th(/^App/)).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("button", { name: /^App/ })).toHaveTextContent("App ▲");
    fireEvent.click(screen.getByRole("button", { name: /^App/ }));
    expect(appKeys()).toEqual(["Slack:777", "Safari:501", "?:0"]);
    fireEvent.click(screen.getByRole("button", { name: /^↓ total/ }));
    expect(appKeys()).toEqual(["Safari:501", "Slack:777", "?:0"]);
    fireEvent.click(screen.getByRole("button", { name: /^↑ total/ }));
    expect(appKeys()).toEqual(["Slack:777", "Safari:501", "?:0"]);
    fireEvent.click(screen.getByRole("button", { name: /^Conns/ }));
    expect(appKeys()).toEqual(["?:0", "Safari:501", "Slack:777"]);
  });

  it("the AppPicker filters rows by app, and the summary says N of T", async () => {
    await mountMachine();
    fireEvent.click(screen.getByRole("button", { name: "Filter by app" }));
    const opt = screen.getAllByRole("option").find((o) => o.textContent?.includes("Slack"))!;
    expect(opt).toHaveTextContent("Slack1");
    fireEvent.click(within(opt).getByRole("button", { name: "Only" }));
    expect(useMachineStore.getState().selection).toEqual(["Slack"]);
    expect(appKeys()).toEqual(["Slack:777"]);
    expect(screen.getByTestId("netm-title")).toHaveTextContent("1 of 3 apps · 1 connection");
    expect(screen.getByRole("button", { name: "Filter by app" })).toHaveTextContent("Slack ▾");
  });

  it("the text filter narrows rows; nothing left says so", async () => {
    await mountMachine();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter apps and connections" }), { target: { value: "apple.com" } });
    expect(appKeys()).toEqual(["Safari:501"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter apps and connections" }), { target: { value: "zzz" } });
    expect(screen.getByTestId("netm-empty")).toHaveTextContent("No apps match.");
  });

  it("before the first sample it says it is waiting; a single app reads singular", async () => {
    await mountMachine(null);
    expect(screen.getByTestId("netm-empty")).toHaveTextContent("Waiting for the first sample…");
    act(() => emitSample({ tsMs: 2, apps: [SLACK] }));
    expect(screen.getByTestId("netm-title")).toHaveTextContent("Whole Mac — 1 app · 1 connection");
  });

  it("Pause freezes the table while samples keep arriving", async () => {
    await mountMachine();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => emitSample({ tsMs: 2, apps: [SLACK] }));
    expect(appKeys()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(appKeys()).toEqual(["Slack:777"]);
  });

  it("a partial backend shows its reason as a subtle note", async () => {
    mach.netmachineStart.mockResolvedValue({ ...MAC, backend: "linux-proc", reason: "other users' sockets have no process" });
    render(<NetworkPanel />);
    await settle();
    fireEvent.click(modeBtn("Whole Mac"));
    await settle();
    expect(screen.getByTestId("netm-partial")).toHaveTextContent("other users' sockets have no process");
    expect(modeBtn("Whole computer")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("unavailable and failing backends", () => {
  it("unavailable: the reason replaces the table, and the mode switch stays live", async () => {
    const win: MachineStatus = { available: false, backend: null, reason: "Not on Windows yet — GetExtendedTcpTable is on the backlog.", running: false, hasBytes: false };
    mach.netmachineStatus.mockResolvedValue(win);
    mach.netmachineStart.mockResolvedValue(win);
    render(<NetworkPanel />);
    await settle();
    fireEvent.click(modeBtn("Whole computer"));
    await settle();
    expect(screen.getByTestId("netm-unavailable")).toHaveTextContent("Whole computer isn't available here.");
    expect(screen.getByTestId("netm-unavailable")).toHaveTextContent("GetExtendedTcpTable");
    expect(screen.queryByRole("table", { name: "Apps and connections" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Filter by app" })).toBeNull();
    expect(modeBtn("IDE traffic")).toBeEnabled();
    expect(modeBtn("Whole computer")).toBeEnabled();
  });

  it("unavailable with no reason still explains", async () => {
    const off: MachineStatus = { available: false, backend: null, reason: null, running: false, hasBytes: false };
    mach.netmachineStart.mockResolvedValue(off);
    mach.netmachineStatus.mockResolvedValue(off);
    useNetworkStore.setState({ mode: "machine" });
    render(<NetworkPanel />);
    await settle();
    expect(screen.getByTestId("netm-unavailable")).toHaveTextContent("This platform has no connection backend yet.");
  });

  it("while starting it says so; a failed start shows the error instead", async () => {
    let fail: (e: Error) => void = () => {};
    mach.netmachineStatus.mockRejectedValue(new Error("no status"));
    mach.netmachineStart.mockReturnValue(new Promise((_r, j) => (fail = j)));
    useNetworkStore.setState({ mode: "machine" });
    render(<NetworkPanel />);
    expect(screen.getByTestId("netm-waiting")).toHaveTextContent("Starting the connection sampler…");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("no status");
    expect(screen.getByTestId("netm-waiting").textContent).toBe("");
    await act(async () => fail(new Error("nettop missing")));
    expect(screen.getByRole("alert")).toHaveTextContent("nettop missing");
  });
});

describe("keyboard", () => {
  it("j/k/g/G move the cursor; Enter and Space toggle; → / ← expand and collapse", async () => {
    await mountMachine();
    const sel = () => useMachineStore.getState().selectedKey;
    key("k");
    expect(sel()).toBe("?:0");
    key("j");
    expect(sel()).toBe("?:0");
    key("g");
    expect(sel()).toBe("Safari:501");
    key("j");
    key("ArrowDown");
    expect(sel()).toBe("?:0");
    key("ArrowUp");
    expect(sel()).toBe("Slack:777");
    key("k");
    key("k");
    expect(sel()).toBe("Safari:501");
    key("G");
    expect(sel()).toBe("?:0");
    key("Enter");
    expect(appRow("?:0")).toHaveAttribute("aria-expanded", "true");
    key(" ");
    expect(appRow("?:0")).toHaveAttribute("aria-expanded", "false");
    key("ArrowRight");
    key("ArrowRight");
    expect(useMachineStore.getState().expanded).toEqual(["?:0"]);
    key("ArrowLeft");
    expect(useMachineStore.getState().expanded).toEqual([]);
    expect(appRow("?:0")).toHaveAttribute("aria-selected", "true");
    expect(appRow("?:0")).toHaveClass("is-selected");
  });

  it("j from no cursor picks the first row; Enter/→/← with no cursor do nothing", async () => {
    await mountMachine();
    key("Enter");
    key("ArrowRight");
    key("ArrowLeft");
    expect(useMachineStore.getState().expanded).toEqual([]);
    key("j");
    expect(useMachineStore.getState().selectedKey).toBe("Safari:501");
  });

  it("p pauses, / focuses the filter, Esc/Enter there return to the table; modifiers and other keys pass", async () => {
    await mountMachine();
    key("p");
    expect(useMachineStore.getState().paused).toBe(true);
    key("/");
    const filter = screen.getByRole("searchbox", { name: "Filter apps and connections" });
    expect(document.activeElement).toBe(filter);
    fireEvent.keyDown(filter, { key: "a" });
    expect(document.activeElement).toBe(filter);
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(document.activeElement).toBe(box());
    filter.focus();
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(document.activeElement).toBe(box());
    expect(fireEvent.keyDown(box(), { key: "j", metaKey: true })).toBe(true);
    expect(useMachineStore.getState().selectedKey).toBeNull();
    expect(fireEvent.keyDown(box(), { key: "x" })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: "j" })).toBe(false);
  });

  it("keys on an empty table do nothing", async () => {
    await mountMachine({ tsMs: 1, apps: [] });
    key("j");
    key("G");
    expect(useMachineStore.getState().selectedKey).toBeNull();
  });

  it("the cursor is revealed: scrolled up to under the header, or down to the box's bottom", async () => {
    await mountMachine();
    const b = box();
    Object.defineProperty(b, "clientHeight", { configurable: true, value: 60 });
    const place = (k: string, top: number) => {
      Object.defineProperty(appRow(k), "offsetTop", { configurable: true, value: top });
      Object.defineProperty(appRow(k), "offsetHeight", { configurable: true, value: 20 });
    };
    place("Safari:501", 22);
    place("Slack:777", 42);
    place("?:0", 62);
    b.scrollTop = 0;
    key("G"); // 62 + 20 > 0 + 60 → scroll to 22
    expect(b.scrollTop).toBe(22);
    key("k"); // Slack at 42: 42 - 22 = 20 < 22 → scroll up to 20
    expect(b.scrollTop).toBe(20);
    key("j"); // ? at 62: 62-22=40 ≥ 20, 82 ≤ 80? no → 82 - 60 = 22
    expect(b.scrollTop).toBe(22);
    b.scrollTop = 10;
    place("?:0", 40);
    key("G"); // fully visible (40-22=18 ≥ 10; 60 ≤ 70): unchanged
    expect(b.scrollTop).toBe(10);
  });
});

describe("IDE traffic: the Source picker", () => {
  const flow = (id: number, terminalId: string | null): FlowSummary => ({
    id, startedMs: 0, proto: "https", method: "GET", host: "api.example.com", port: 443, path: `/r/${id}`,
    status: 200, grpcStatus: null, contentType: null, reqBytes: 0, resBytes: 1, durationMs: 1, state: "done",
    error: null, terminalId, httpVersion: "HTTP/1.1", wsMessages: null, client: null, note: null,
  });

  it("lists sources with counts (unattributed included) and filters the flow table", async () => {
    useAppStore.setState((s) => {
      s.tabs = {
        t1: { id: "t1", kind: "terminal", title: "zsh", ref: { kind: "terminal", terminalId: "term-1" } },
      } as unknown as Record<TabId, Tab>;
    });
    ipc.netcapSnapshot.mockResolvedValue([flow(1, "term-1"), flow(2, null), flow(3, "term-1")]);
    render(<NetworkPanel />);
    await settle();
    const ids = () => screen.getAllByTestId("net-row").map((r) => r.getAttribute("data-flow-id"));
    expect(ids()).toEqual(["1", "2", "3"]);
    fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
    const opts = screen.getAllByRole("option").map((o) => o.textContent);
    expect(opts).toEqual(["All sources", "unattributed1Only", "zsh2Only"]);
    const un = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("unattributed"))!;
    fireEvent.click(within(un).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual(["2"]);
    expect(screen.getByRole("button", { name: "Filter by source" })).toHaveTextContent("unattributed ▾");
    const zsh = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("zsh"))!;
    fireEvent.click(within(zsh).getByRole("checkbox"));
    expect(ids()).toEqual(["1", "2", "3"]);
    expect(screen.getByRole("button", { name: "Filter by source" })).toHaveTextContent("2 sources ▾");
    fireEvent.click(within(un).getByRole("checkbox"));
    expect(ids()).toEqual(["1", "3"]);
  });
});
