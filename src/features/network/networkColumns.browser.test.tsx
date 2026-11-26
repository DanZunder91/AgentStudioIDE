/** Browser tier: column fit is layout, and jsdom has no text metrics. A `ch` width counts glyphs,
 * not the cell's 6px + 6px padding, so widths are checked against real rendered values. */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../App.css";
import { setColumnHidden, setColumnWidth, useColumnLayoutStore } from "../../components/columns";
import { IDE_COLUMNS, IDE_VIEW_KEY, MACHINE_COLUMNS, MACHINE_VIEW_KEY } from "./networkColumns";
import type { FlowSummary, MachineSample, MachineStatus, NetcapStatus } from "./networkTypes";

const ipc = vi.hoisted(() => ({
  netcapStatus: vi.fn(),
  netcapSet: vi.fn(),
  netcapSetAppDecrypt: vi.fn(),
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

import { resetMachineStore, setHideListeners, toggleExpanded } from "./machineStore";
import { NetworkPanel } from "./NetworkPanel";
import { resetNetworkStore, useNetworkStore } from "./networkStore";

const STATUS: NetcapStatus = {
  running: true, port: 51234, enabled: true, decrypt: true, caPath: null,
  skippedReason: null, passthroughHosts: [], flowCount: 2, decryptApps: [], portChanged: null,
};

// The widest value each narrow column can realistically hold.
const WIDE: FlowSummary = {
  id: 1, startedMs: new Date(2026, 8, 24, 20, 58, 58).getTime(), proto: "tunnel",
  method: "CONNECT", host: "api.example.com", port: 443, path: "", status: 200,
  // A tunnel's Size is both directions (`↑1023K ↓1023K`) — the widest size cell.
  grpcStatus: 14, contentType: "application/grpc", reqBytes: 1023 * 1024, resBytes: 1023 * 1024,
  durationMs: 59_900, state: "done", error: null, terminalId: null, httpVersion: "HTTP/2",
  wsMessages: null,
  client: null,
  note: null,
};

const MAC: MachineStatus = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };
const BIG = 1023 * 1024; // `1023.0KB` — the widest formatSize value below 1 MB
// The widest value each numeric column can realistically hold.
const MACHINE_WIDE: MachineSample = {
  tsMs: 1,
  apps: [
    {
      key: "com.apple.WebKit.Networking:4294967", name: "com.apple.WebKit.Networking", pid: 4294967, user: "self",
      bytesIn: BIG, bytesOut: BIG, rateIn: BIG, rateOut: BIG,
      connections: Array.from({ length: 1234 }, (_, i) => ({
        proto: "tcp6" as const, local: `[fe80::1]:${50000 + i}`, remote: "[2606:4700::6810:84e5]:443",
        remoteHost: null, state: "Established", bytesIn: BIG, bytesOut: BIG, rateIn: BIG, rateOut: BIG,
      })).concat([{
        proto: "tcp6", local: "[fe80::1]:1", remote: "[2606:4700::1]:443", remoteHost: null,
        state: "CloseWait", bytesIn: BIG, bytesOut: BIG, rateIn: BIG, rateOut: BIG,
      }]),
    },
  ],
};

beforeEach(() => {
  useColumnLayoutStore.setState({ layouts: {} });
  resetNetworkStore();
  resetMachineStore();
  mach.netmachineStatus.mockResolvedValue(MAC);
  mach.netmachineStart.mockResolvedValue(MAC);
  mach.listenSamples.mockImplementation(async (h: (s: MachineSample) => void) => {
    h(MACHINE_WIDE);
    return () => {};
  });
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([WIDE]);
  ipc.listenFlows.mockResolvedValue(() => {});
});
afterEach(cleanup);

describe("network table column widths", () => {
  it("every fixed-width column fits its widest value without clipping", async () => {
    // 1900: wide enough for the DEFAULT widths (Apps sidebar included) — a narrower pane squeezes
    // them (fitColumns; the "fit to the pane" describe below covers that).
    render(
      <div style={{ width: 1900, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("api.example.com:443");
    for (const col of ["time", "proto", "method", "status", "size", "dur"]) {
      const cell = document.querySelector<HTMLElement>(`td.net-c--${col}`);
      expect(cell, col).not.toBeNull();
      expect(cell!.scrollWidth, `${col}: "${cell!.textContent}"`).toBeLessThanOrEqual(cell!.clientWidth);
    }
  });

  it("the whole-computer table's fixed-width columns fit their widest value", async () => {
    useNetworkStore.setState({ mode: "machine" });
    setHideListeners(false);
    toggleExpanded(MACHINE_WIDE.apps[0].key);
    render(
      <div style={{ width: 1000, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("4294967");
    for (const col of ["pid", "conns", "rate", "total"]) {
      const cell = document.querySelector<HTMLElement>(`td.netm-c--${col}`);
      expect(cell, col).not.toBeNull();
      expect(cell!.scrollWidth, `${col}: "${cell!.textContent}"`).toBeLessThanOrEqual(cell!.clientWidth);
    }
    for (const col of ["proto", "state", "bytes"]) {
      for (const cell of document.querySelectorAll<HTMLElement>(`td.netm-cc--${col}`)) {
        expect(cell.scrollWidth, `${col}: "${cell.textContent}"`).toBeLessThanOrEqual(cell.clientWidth);
      }
    }
  });

  it("in a narrow (720px) pane Path keeps a real share and nothing scrolls sideways (fitColumns)", async () => {
    // At 720px (default window, both rails open) the fit squeezes columns; Path never collapses.
    ipc.netcapSnapshot.mockResolvedValue([{ ...WIDE, proto: "https", method: "GET", path: "/widgets/wgt_0123456789abcdef01234567/bookings" }]);
    render(
      <div style={{ width: 720, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("/widgets/wgt_0123456789abcdef01234567/bookings");
    const path = document.querySelector<HTMLElement>("td.net-c--path")!;
    expect(path.getBoundingClientRect().width).toBeGreaterThanOrEqual(56);
    expect(path).toHaveAttribute("title", "/widgets/wgt_0123456789abcdef01234567/bookings");
    const scroller = document.querySelector<HTMLElement>(".net-scroll")!;
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
  });
});

const width = (sel: string) => document.querySelector<HTMLElement>(sel)!.getBoundingClientRect().width;

describe("resizable + hideable columns, in real pixels", () => {
  const PATHY: FlowSummary = {
    ...WIDE, proto: "https", method: "GET", host: "intake.logs.eu1.apm-vendor.example",
    path: "/api/v2/logs?key=abc", client: { pid: 4242, name: "gazelle", path: null },
  };

  it("dragging Host's edge really widens the Host cells, and the full host name fits", async () => {
    ipc.netcapSnapshot.mockResolvedValue([PATHY]);
    render(
      <div style={{ width: 1900, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("intake.logs.eu1.apm-vendor.example");
    const host = () => document.querySelector<HTMLElement>("td.net-c--host")!;
    const before = width("td.net-c--host");
    expect(host().scrollWidth, "truncated by default").toBeGreaterThan(host().clientWidth);
    const handle = screen.getByRole("separator", { name: "Resize Host column" });
    const r = handle.getBoundingClientRect();
    fireEvent.pointerDown(handle, { clientX: r.x, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: r.x + 120 });
    fireEvent.pointerUp(handle);
    expect(width("td.net-c--host")).toBeGreaterThanOrEqual(before + 119);
    expect(host().scrollWidth).toBeLessThanOrEqual(host().clientWidth);
  });

  it("hiding Type removes that column, and Path takes the freed space", async () => {
    ipc.netcapSnapshot.mockResolvedValue([PATHY]);
    render(
      <div style={{ width: 1700, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("/api/v2/logs?key=abc");
    // 1700, not 1400: the Network Apps sidebar takes its width, and Path must start
    // ABOVE its 160 px floor or hiding Type cannot show as growth.
    const pathBefore = width("td.net-c--path");
    expect(document.querySelector("td.net-c--type")).not.toBeNull();
    act(() => setColumnHidden(IDE_VIEW_KEY, IDE_COLUMNS, "type", true));
    expect(document.querySelector("td.net-c--type")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Type" })).toBeNull();
    expect(width("td.net-c--path")).toBeGreaterThanOrEqual(pathBefore + 140);
  });

  it("Path never collapses to 0 — not in a 720px pane, not with every other column widened", async () => {
    ipc.netcapSnapshot.mockResolvedValue([PATHY]);
    render(
      <div style={{ width: 720, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("/api/v2/logs?key=abc");
    act(() => {
      for (const c of IDE_COLUMNS) if (!c.flex) setColumnWidth(IDE_VIEW_KEY, c, 400);
    });
    expect(width("td.net-c--path")).toBeGreaterThanOrEqual(160);
    const scroller = document.querySelector<HTMLElement>(".net-scroll")!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
  });

  it("the Process column shows the client and fits a short name", async () => {
    ipc.netcapSnapshot.mockResolvedValue([PATHY]);
    render(
      <div style={{ width: 1900, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    const cell = await screen.findByText("gazelle");
    expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth);
  });

  it("Whole Mac at 880px: every numeric column is on screen by default, App takes the rest", async () => {
    // The bug: only App visible — the IDE table's `min-width: 160ch` floor
    // applied to `.netm-table` too and pushed every numeric column off the right edge.
    useNetworkStore.setState({ mode: "machine" });
    render(
      <div style={{ width: 880, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("4294967");
    const scroller = document.querySelector<HTMLElement>(".net-scroll")!;
    const box = scroller.getBoundingClientRect();
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    for (const col of ["pid", "conns", "rate", "total"]) {
      for (const cell of document.querySelectorAll<HTMLElement>(`td.netm-c--${col}`)) {
        const r = cell.getBoundingClientRect();
        expect(r.right, `${col} inside the pane`).toBeLessThanOrEqual(box.right + 0.5);
        expect(r.width, col).toBeGreaterThan(40);
      }
    }
    expect(width("td.netm-c--app")).toBeGreaterThanOrEqual(140);
    // …and hiding one really removes it (the menu wiring is in
    // NetworkHiddenFlowsAndColumns.test.tsx).
    act(() => setColumnHidden(MACHINE_VIEW_KEY, MACHINE_COLUMNS, "pid", true));
    expect(document.querySelector("td.netm-c--pid")).toBeNull();
  });
});

/* The Network tab is the window minus both rails (260 + 300 px); the Apps sidebar takes 280. */
describe("fit to the pane: the important columns are on screen at common window sizes", () => {
  const RAILS = 260 + 300;
  const CORE = ["time", "proto", "method", "status", "host", "path", "source"];
  const WIDEST_CORE: FlowSummary = {
    ...WIDE, id: 7, proto: "tunnel", method: "CONNECT", status: 200, state: "done", terminalId: "t-agent",
  };

  const mountAt = async (windowPx: number) => {
    ipc.netcapSnapshot.mockResolvedValue([WIDEST_CORE]);
    render(
      <div style={{ width: windowPx - RAILS, height: 600, display: "flex", flexDirection: "column" }}>
        <NetworkPanel />
      </div>,
    );
    await screen.findByText("api.example.com:443");
    // The ResizeObserver's first callback lands after the first paint.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await act(async () => {});
  };
  const inside = (col: string) => {
    const box = document.querySelector<HTMLElement>(".net-scroll")!.getBoundingClientRect();
    const label = IDE_COLUMNS.find((c) => c.id === col)!.label;
    // Its first child is the label's text node (the resizer follows it).
    const th = Array.from(document.querySelectorAll<HTMLElement>("th.net-th")).find((h) => h.firstChild?.textContent === label)!;
    expect(th, `${col} header`).toBeDefined();
    const td = document.querySelector<HTMLElement>(`td.net-c--${col}`)!;
    for (const [what, r] of [["header", th.getBoundingClientRect()], ["cell", td.getBoundingClientRect()]] as const) {
      expect(r.left, `${col} ${what} left`).toBeGreaterThanOrEqual(box.left - 0.5);
      expect(r.right, `${col} ${what} right`).toBeLessThanOrEqual(box.right + 0.5);
      expect(r.width, `${col} ${what} width`).toBeGreaterThanOrEqual(40);
    }
  };

  for (const windowPx of [1280, 1700]) {
    it(`${windowPx} px window: ${CORE.join(", ")} are inside the scroll viewport, no sideways scroll`, async () => {
      await mountAt(windowPx);
      for (const col of CORE) inside(col);
      const scroller = document.querySelector<HTMLElement>(".net-scroll")!;
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    });
  }

  it("1280: the squeezed Time / Proto / Method still show their widest values whole", async () => {
    await mountAt(1280);
    expect(document.querySelector(".net-table--tight")).not.toBeNull();
    for (const col of ["time", "proto", "method"]) {
      const cell = document.querySelector<HTMLElement>(`td.net-c--${col}`)!;
      expect(cell.scrollWidth, `${col}: "${cell.textContent}"`).toBeLessThanOrEqual(cell.clientWidth);
    }
  });

  it("1280: the columns hidden to fit are listed unticked; ticking Process shows it for good", async () => {
    await mountAt(1280);
    expect(document.querySelector("td.net-c--process")).toBeNull();
    fireEvent.click(screen.getByTestId(`columns-menu-${IDE_VIEW_KEY}`));
    const box = screen.getByRole("menuitemcheckbox", { name: "Process" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(document.querySelector("td.net-c--process")).not.toBeNull();
    // The user's choice wins over the fit: the table now scrolls sideways rather than drop it.
    const scroller = document.querySelector<HTMLElement>(".net-scroll")!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
  });

  it("1700: wider, so Type stays and Host is wider than at 1280", async () => {
    await mountAt(1280);
    const narrowHost = width("td.net-c--host");
    cleanup();
    useColumnLayoutStore.setState({ layouts: {} });
    await mountAt(1700);
    expect(document.querySelector("td.net-c--type")).not.toBeNull();
    expect(width("td.net-c--host")).toBeGreaterThan(narrowHost);
  });
});
