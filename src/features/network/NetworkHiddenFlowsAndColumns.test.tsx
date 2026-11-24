/**
 * Hidden flows, the Process column and resizable columns — what a busy capture needs:
 *
 * 1. "No flows match the filter." over a busy capture, with a tunnel flow open in the detail pane.
 *    The table was right (the HTTP chip was on and every flow was a Tunnel) but it said so
 *    in a way that read as a broken view: no reason, no way back, and the detail pane kept
 *    showing a flow the table was hiding.
 * 2. The Process column (`FlowSummary.client`) and the "not decrypted" note.
 * 3. Resizable + hideable columns (shared `components/columns`), wired into both tables.
 *
 * Only `./netcapIpc` / `./netmachineIpc` are mocked; the store, formatters and columns are real.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import type { FlowDetail, FlowSummary, MachineSample, MachineStatus, NetcapStatus } from "./networkTypes";

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

import { resetMachineStore, toggleExpanded } from "./machineStore";
import { tableMinWidth } from "./networkColumns";
import { NetworkPanel } from "./NetworkPanel";
import { openDetail, resetNetworkStore, useNetworkStore } from "./networkStore";

const T0 = new Date(2026, 8, 24, 20, 15, 46).getTime();

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: T0, proto: "https", method: "GET", host: "api.example.com", port: 443,
    path: `/r/${id}`, status: 200, grpcStatus: null, contentType: "application/json",
    reqBytes: 0, resBytes: 93, durationMs: 120, state: "done", error: null, terminalId: null,
    httpVersion: "HTTP/1.1", wsMessages: null, client: null, note: null, ...o,
  };
}

const tunnel = (id: number, o: Partial<FlowSummary> = {}): FlowSummary =>
  flow(id, {
    proto: "tunnel", method: "CONNECT", host: "intake.logs.eu1.apm-vendor.example", path: "",
    status: null, contentType: null, httpVersion: "", reqBytes: 900, resBytes: 1200, ...o,
  });

const STATUS: NetcapStatus = {
  running: true, port: 51234, enabled: true, decrypt: true, caPath: "/cfg/netcap/ca.pem",
  skippedReason: null, passthroughHosts: [], flowCount: 0, decryptApps: [], portChanged: null,
};

function detailOf(f: FlowSummary): FlowDetail {
  return {
    summary: f, requestHeaders: [], responseHeaders: [], responseTrailers: [],
    requestBody: null, responseBody: null,
  };
}

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  useColumnLayoutStore.setState({ layouts: {} });
  vi.clearAllMocks();
  ipc.listenFlows.mockResolvedValue(() => {});
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([]);
  ipc.netcapFlow.mockImplementation(async (id: number) => detailOf(flow(id)));
  mach.netmachineStatus.mockReturnValue(new Promise(() => {}));
  mach.netmachineStart.mockReturnValue(new Promise(() => {}));
  mach.netmachineStop.mockResolvedValue(undefined);
  mach.listenSamples.mockReturnValue(new Promise(() => {}));
});
afterEach(() => resetNetworkStore());

async function mount(snapshot: FlowSummary[] = []) {
  ipc.netcapSnapshot.mockResolvedValue(snapshot);
  const view = render(<NetworkPanel />);
  await screen.findByText(/^proxy /);
  await act(async () => {});
  return view;
}

const rows = () => screen.queryAllByTestId("net-row");
const rowOf = (id: number) => document.querySelector(`[data-flow-id="${id}"]`) as HTMLElement;
const cellOf = (id: number, col: string) => rowOf(id).querySelector(`td.net-c--${col}`) as HTMLElement;
const heads = () =>
  within(screen.getByRole("table", { name: "Network flows" }))
    .getAllByRole("columnheader")
    .map((th) => th.textContent);

describe('"No flows match the filter." with 158 flows', () => {
  // The state under test: Decrypt on, every connection a passthrough tunnel, the HTTP chip on,
  // and a tunnel open in the detail pane (it was opened before the chip was pressed).
  const FLOWS = Array.from({ length: 158 }, (_, i) => tunnel(i + 1));

  it("says WHICH control hides the flows, and how many, instead of a bare 'no match'", async () => {
    await mount(FLOWS);
    act(() => openDetail(158));
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(rows()).toHaveLength(0);
    const empty = screen.getByTestId("net-empty");
    expect(empty).toHaveTextContent("All 158 flows are hidden by the current filters.");
    expect(within(empty).getByTestId("net-hidden-by-chips")).toHaveTextContent(
      "Protocol chips (showing HTTP only) hide 158 — 158 Tunnel",
    );
    expect(within(empty).queryByTestId("net-hidden-by-text")).toBeNull();
    expect(within(empty).queryByTestId("net-hidden-by-source")).toBeNull();
  });

  it("the detail pane says its flow is hidden, rather than contradicting the table", async () => {
    await mount(FLOWS);
    act(() => openDetail(158));
    expect(screen.queryByTestId("net-detail-hidden")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(screen.getByTestId("net-detail-hidden")).toHaveTextContent(
      "This flow is hidden by the current filters — it is not in the table above.",
    );
  });

  it("'Show all flows' clears the filter, the chips and the source pick — and the rows come back", async () => {
    await mount(FLOWS);
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "health" } });
    act(() => useNetworkStore.setState({ sourceSelection: [] }));
    const empty = screen.getByTestId("net-empty");
    expect(within(empty).getByTestId("net-hidden-by-text")).toHaveTextContent('Filter "health" hides 158');
    expect(within(empty).getByTestId("net-hidden-by-source")).toHaveTextContent("Source picker (No sources) hides 158");
    fireEvent.click(within(empty).getByRole("button", { name: "Show all flows" }));
    const s = useNetworkStore.getState();
    expect([s.filter, s.chips, s.sourceSelection]).toEqual(["", [], null]);
    expect(rows().length).toBeGreaterThan(0);
    expect(screen.queryByTestId("net-empty")).toBeNull();
  });

  it("one flow, hidden by the text alone: singular wording, and a chip that hides nothing says 0", async () => {
    await mount([flow(1)]);
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    fireEvent.click(screen.getByRole("button", { name: "gRPC" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "zzz" } });
    expect(screen.getByTestId("net-empty")).toHaveTextContent("The only flow is hidden by the current filters.");
    expect(screen.getByTestId("net-hidden-by-chips").textContent).toBe("Protocol chips (showing HTTP + gRPC only) hide 0");
  });

  it("each chip shows how many flows it holds, so an empty family is visible before you press it", async () => {
    await mount([...FLOWS.slice(0, 3), flow(200), flow(201, { proto: "grpc" })]);
    const chip = (name: string) => screen.getByRole("button", { name });
    expect(chip("HTTP")).toHaveTextContent("HTTP1");
    expect(chip("Tunnel")).toHaveTextContent("Tunnel3");
    expect(chip("WS")).toHaveTextContent("WS0");
    expect(chip("gRPC")).toHaveTextContent("gRPC1");
    expect(chip("Tunnel")).toHaveAttribute("title", "3 flows");
    expect(chip("gRPC")).toHaveAttribute("title", "1 flow");
  });
});

describe("Process column (FlowSummary.client)", () => {
  const GAZELLE = { pid: 4242, name: "gazelle", path: "/Users/sam/gazelle/target/debug/gazelle" };

  it("sits right after Source, visible by default: name in the cell, path · pid in the title", async () => {
    await mount([flow(1, { client: GAZELLE }), flow(2, { client: { pid: 7, name: "node", path: null } }), flow(3)]);
    expect(heads().slice(-2)).toEqual(["Source", "Process"]);
    expect(cellOf(1, "process")).toHaveTextContent("gazelle");
    expect(cellOf(1, "process")).toHaveAttribute("title", "/Users/sam/gazelle/target/debug/gazelle · pid 4242");
    expect(cellOf(2, "process")).toHaveAttribute("title", "node · pid 7");
    expect(cellOf(1, "process")).not.toHaveClass("net-process--unknown");
    expect(cellOf(3, "process")).toHaveTextContent("—");
    expect(cellOf(3, "process")).toHaveClass("net-process--unknown");
    expect(cellOf(3, "process").getAttribute("title")).toMatch(/could not tell which process/);
  });

  it("the detail header names the process and its pid", async () => {
    await mount([flow(1, { client: GAZELLE })]);
    act(() => openDetail(1));
    // No userinfo + a resolved process is an EXTERNAL source (it used to read
    // "unattributed · gazelle (pid 4242)" before); the pid suffix still follows.
    expect(screen.getByTestId("net-detail")).toHaveTextContent("external · gazelle · gazelle (pid 4242)");
  });
});

describe("the proxy's note, and tls rejected in plain words", () => {
  const NOTE = "not decrypted: gazelle doesn't read the IDE's CA";
  const GAZELLE = { pid: 4242, name: "gazelle", path: null };

  it("a note shows dimmed in the Type column and as the explanation in the detail pane", async () => {
    await mount([tunnel(1, { client: GAZELLE, note: NOTE }), tunnel(2)]);
    expect(cellOf(1, "type")).toHaveTextContent(NOTE);
    expect(cellOf(1, "type")).toHaveClass("net-type--note");
    expect(cellOf(2, "type")).toHaveTextContent("[encrypted]");
    act(() => openDetail(1));
    expect(screen.getByTestId("net-explain")).toHaveTextContent(NOTE);
    // Decrypt is already on: the pane must not tell the user to turn it on.
    expect(screen.getByTestId("net-tunnel-note")).not.toHaveTextContent("turn on Decrypt HTTPS");
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("without decrypting them, so it can't break the client");
    expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toBe(
      `Encrypted tunnel — the proxy never saw the request (${NOTE}).`,
    );
  });

  it("a tunnel with no note keeps the Decrypt advice and no explanation", async () => {
    await mount([tunnel(2)]);
    act(() => openDetail(2));
    expect(screen.queryByTestId("net-explain")).toBeNull();
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("turn on Decrypt HTTPS");
  });

  it("tls rejected → passthrough explains who refused what, and why Copy as cURL is off", async () => {
    const rejected = (id: number, o: Partial<FlowSummary> = {}) =>
      flow(id, {
        method: "CONNECT", host: "api.stripe.com", path: "", status: null, contentType: null,
        state: "error", error: "tls rejected → passthrough", ...o,
      });
    await mount([rejected(1, { client: GAZELLE }), rejected(2)]);
    act(() => openDetail(1));
    expect(screen.getByTestId("net-explain")).toHaveTextContent(
      "gazelle doesn't trust the IDE's certificate, so this one connection failed. " +
        "Later connections from gazelle to api.stripe.com are passed through without decrypting.",
    );
    expect(screen.getByRole("button", { name: "Copy as cURL" })).toBeDisabled();
    expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toBe(
      "Nothing to replay — gazelle refused the IDE's certificate before sending a request.",
    );
    act(() => openDetail(2));
    expect(screen.getByTestId("net-explain")).toHaveTextContent(
      "The client doesn't trust the IDE's certificate, so this one connection failed. " +
        "Later connections to api.stripe.com are passed through without decrypting.",
    );
    expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toBe(
      "Nothing to replay — The client refused the IDE's certificate before sending a request.",
    );
  });
});

describe("IDE traffic table: resizable + hideable columns (view key network.ide)", () => {
  it("every column but the flex Path has a resizer; dragging Host's widens its <col>", async () => {
    await mount([flow(1)]);
    // The column resizers only — the Apps sidebar's own edge is a separator too.
    const resizers = screen
      .getAllByRole("separator")
      .map((h) => h.getAttribute("aria-label"))
      .filter((l) => l !== "Resize the apps sidebar");
    expect(resizers).toHaveLength(10);
    expect(resizers).not.toContain("Resize Path column");
    const hostCol = () => document.querySelector<HTMLElement>("col.net-col--host")!;
    expect(hostCol().style.width).toBe("220px");
    const h = screen.getByRole("separator", { name: "Resize Host column" });
    fireEvent.pointerDown(h, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 180 });
    fireEvent.pointerUp(h);
    expect(hostCol().style.width).toBe("300px");
    expect(useColumnLayoutStore.getState().layouts["network.ide"].widths.host).toBe(300);
    // The Path column has no fixed width — it takes the rest.
    expect(document.querySelector<HTMLElement>("col.net-col--path")!.style.width).toBe("");
  });

  it("the table's floor follows the layout: sum of fixed widths + Path's 160px minimum", async () => {
    await mount([flow(1)]);
    const table = () => screen.getByRole("table", { name: "Network flows" });
    // Status 100 + Size 108 for the tunnel/bypass cells: `not captured`, `↑1023K ↓1023K`.
    expect(table().style.minWidth).toBe("1258px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Host column" }), { key: "ArrowRight" });
    expect(table().style.minWidth).toBe("1268px");
  });

  it("Columns ▾ hides Type: header, <col> and every cell go; showing it brings them back", async () => {
    await mount([flow(1), flow(2)]);
    fireEvent.click(within(screen.getByTestId("columns-menu-network.ide").parentElement!).getByRole("button", { name: "Columns ▾" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Type" }));
    expect(heads()).not.toContain("Type");
    expect(document.querySelector("col.net-col--type")).toBeNull();
    expect(document.querySelectorAll("td.net-c--type")).toHaveLength(0);
    expect(rowOf(1).querySelectorAll("td")).toHaveLength(10);
    expect(screen.getByRole("table", { name: "Network flows" }).style.minWidth).toBe(`${1258 - 150}px`);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Type" }));
    expect(heads()).toContain("Type");
    expect(rowOf(1).querySelectorAll("td")).toHaveLength(11);
  });

  it("Time cannot be hidden; the layout survives a remount (tab switch)", async () => {
    const view = await mount([flow(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Columns ▾" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Time" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Process" }));
    view.unmount();
    await mount([flow(1)]);
    expect(heads()).not.toContain("Process");
  });
});

describe("Whole Mac table: resizable + hideable columns (view key network.machine)", () => {
  const MAC: MachineStatus = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };
  const SAMPLE: MachineSample = {
    tsMs: 1,
    apps: [
      {
        key: "Slack:777", name: "Slack", pid: 777, user: "self", bytesIn: 1024, bytesOut: 4096, rateIn: 1024, rateOut: 2048,
        connections: [{
          proto: "tcp4", local: "10.0.0.5:5000", remote: "1.2.3.4:443", remoteHost: null, state: "Established",
          bytesIn: 1, bytesOut: 2, rateIn: 0, rateOut: 0,
        }],
      },
    ],
  };

  async function mountMachine() {
    mach.netmachineStatus.mockResolvedValue(MAC);
    mach.netmachineStart.mockResolvedValue(MAC);
    mach.listenSamples.mockImplementation(async (h: (s: MachineSample) => void) => {
      h(SAMPLE);
      return () => {};
    });
    useNetworkStore.setState({ mode: "machine" });
    render(<NetworkPanel />);
    await screen.findByText("Slack");
  }
  const mheads = () =>
    within(screen.getByRole("table", { name: "Apps and connections" }))
      .getAllByRole("columnheader")
      .filter((th) => th.closest("table")!.getAttribute("aria-label") === "Apps and connections")
      .map((th) => th.textContent!.replace(/ [▲▼]$/, ""));

  it("App is flex (no resizer, no width); the numeric columns resize, the sort buttons still sort", async () => {
    await mountMachine();
    expect(screen.queryByRole("separator", { name: "Resize App column" })).toBeNull();
    expect(document.querySelector<HTMLElement>("col.netm-col--app")!.style.width).toBe("");
    const rate = () => document.querySelector<HTMLElement>("col.netm-col--rateIn")!;
    expect(rate().style.width).toBe("88px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize ↓/s column" }), { key: "ArrowRight", shiftKey: true });
    expect(rate().style.width).toBe("128px");
    // The resizer inside a sortable header does not sort.
    const th = screen.getByRole("button", { name: /↓\/s/ }).closest("th")!;
    const before = th.getAttribute("aria-sort");
    fireEvent.click(screen.getByRole("separator", { name: "Resize ↓/s column" }));
    expect(th.getAttribute("aria-sort")).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Conns" }));
    expect(screen.getByRole("button", { name: /Conns/ }).closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("separator", { name: "Resize PID column" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Apps and connections" }).style.minWidth).toBe(`${140 + 68 + 68 + 128 + 88 + 80 + 80}px`);
  });

  it("hiding PID drops its column, and an expanded app's connections span what is left", async () => {
    await mountMachine();
    act(() => toggleExpanded("Slack:777"));
    expect(screen.getByTestId("netm-conns").querySelector("td")).toHaveAttribute("colspan", "7");
    fireEvent.click(screen.getByRole("button", { name: "Columns ▾" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "App" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "PID" }));
    expect(mheads()).toEqual(["App", "Conns", "↓/s", "↑/s", "↓ total", "↑ total"]);
    expect(document.querySelector("td.netm-c--pid")).toBeNull();
    expect(screen.getByTestId("netm-conns").querySelector("td")).toHaveAttribute("colspan", "6");
  });
});

describe("tableMinWidth", () => {
  it("fixed columns at their width, the flex column at its minimum (or the global one)", () => {
    expect(tableMinWidth([
      { id: "a", label: "A", width: 50, px: 70 },
      { id: "b", label: "B", width: 300, px: 300, flex: true, minWidth: 120 },
    ])).toBe(190);
    expect(tableMinWidth([{ id: "b", label: "B", width: 300, px: 300, flex: true }])).toBe(40);
  });
});
