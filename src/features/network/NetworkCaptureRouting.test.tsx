/** Only `./netcapIpc` / `./netmachineIpc` are mocked; stores, formatters and AppPicker are real. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import type { FlowDetail, FlowSummary, MachineApp, MachineConn, MachineSample, MachineStatus, NetcapStatus } from "./networkTypes";

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

import { STATUS_PENDING } from "./CaptureGuide";
import { resetMachineStore, setCaptureGuide } from "./machineStore";
import { NetworkPanel } from "./NetworkPanel";
import { openDetail, resetNetworkStore, setAppDecrypt, setFilter, setSourceSelection, useNetworkStore } from "./networkStore";

const STATUS: NetcapStatus = {
  running: true, port: 8877, enabled: true, decrypt: true, caPath: "/cfg/netcap/ca.pem",
  skippedReason: null, passthroughHosts: [], flowCount: 0, decryptApps: [], portChanged: null,
};
const MAC: MachineStatus = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };

const POSTMAN_HELPER = {
  pid: 9001,
  name: "Postman Helper",
  path: "/Applications/Postman.app/Contents/Frameworks/Postman Helper.app/Contents/MacOS/Postman Helper",
};
const CURL = { pid: 5151, name: "curl", path: "/usr/bin/curl" };

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: 1_700_000_000_000 + id, proto: "http", method: "GET", host: "localhost", port: 3000,
    path: `/r/${id}`, status: 200, grpcStatus: null, contentType: "application/json",
    reqBytes: 0, resBytes: 11, durationMs: 12, state: "done", error: null, terminalId: null,
    httpVersion: "HTTP/1.1", wsMessages: null, client: null, note: null, ...o,
  };
}
const emptyDetail = (f: FlowSummary): FlowDetail => ({
  summary: f, requestHeaders: [], responseHeaders: [], responseTrailers: [], requestBody: null, responseBody: null,
});
function conn(o: Partial<MachineConn> = {}): MachineConn {
  return {
    proto: "tcp4", local: "10.0.0.5:50000", remote: "151.101.1.69:443", remoteHost: null,
    state: "Established", bytesIn: 2048, bytesOut: 512, rateIn: 100, rateOut: 10, ...o,
  };
}
function app(name: string, pid: number, o: Partial<MachineApp> = {}): MachineApp {
  return {
    key: `${name}:${pid}`, name, pid, user: "self", bytesIn: 4096, bytesOut: 1024,
    rateIn: 2048, rateOut: 512, connections: [conn()], ...o,
  };
}
const SAMPLE: MachineSample = {
  tsMs: 1,
  apps: [
    app("Postman", 8080, {
      rateIn: 4000,
      // Two direct sockets, one to the proxy itself (not "direct"), one listener.
      connections: [conn(), conn({ remote: "18.1.2.3:443" }), conn({ remote: "127.0.0.1:8877" }), conn({ remote: null, state: "Listen" })],
    }),
    app("Google Chrome", 8082, { rateIn: 2000 }),
  ],
};

let emitSample: (s: MachineSample) => void = () => {};
let emitFlows: (b: FlowSummary[]) => void = () => {};

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  useColumnLayoutStore.setState({ layouts: {} });
  vi.clearAllMocks();
  ipc.listenFlows.mockImplementation(async (h: (b: FlowSummary[]) => void) => {
    emitFlows = h;
    return () => {};
  });
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([]);
  ipc.netcapFlow.mockImplementation(async (id: number) => emptyDetail(flow(id)));
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

async function mountGuide(snapshot: FlowSummary[] = [], key = "Postman:8080") {
  ipc.netcapSnapshot.mockResolvedValue(snapshot);
  const view = render(<NetworkPanel />);
  await settle();
  fireEvent.click(within(screen.getByRole("group", { name: "Network mode" })).getByRole("button", { name: /Whole/ }));
  await settle();
  act(() => emitSample(SAMPLE));
  act(() => setCaptureGuide(key));
  return view;
}

const routing = () => screen.getByTestId("netm-guide-routing");
const SWITCH = "I added the IDE's certificate in Postman — decrypt its HTTPS";

describe("the guide's live routing state", () => {
  it("not routed: says Postman connects directly, counting only sockets to someone other than the proxy; the steps follow", async () => {
    await mountGuide([flow(1, { client: CURL, terminalId: "t-1" })]);
    expect(routing()).toHaveAttribute("data-routing", "direct");
    expect(routing()).toHaveTextContent(
      "Not routed yet — Postman is connecting directly (2 connections). Follow the steps below; its requests show here as soon as they reach the proxy.",
    );
    expect(within(routing()).queryByRole("button")).toBeNull();
    expect(screen.getAllByTestId("netm-guide-section")).toHaveLength(2);
  });

  it("one direct socket is singular", async () => {
    await mountGuide([], "Google Chrome:8082");
    expect(routing()).toHaveTextContent("Not routed yet — Google Chrome is connecting directly (1 connection).");
  });

  it("flips to receiving live, the moment a flow from inside Postman.app arrives (Postman Helper counts)", async () => {
    await mountGuide();
    expect(routing()).toHaveAttribute("data-routing", "direct");
    act(() => emitFlows([flow(7, { client: POSTMAN_HELPER }), flow(8, { client: POSTMAN_HELPER })]));
    expect(routing()).toHaveAttribute("data-routing", "receiving");
    expect(routing()).toHaveTextContent("✓ Receiving Postman's requests — 2 so far. show them");
  });

  it("“show them” switches to IDE traffic with the Process picker on Postman's processes — undoing a leftover pick", async () => {
    await mountGuide([flow(1, { client: CURL, terminalId: "t-1" }), flow(2, { client: POSTMAN_HELPER }), flow(3, { client: POSTMAN_HELPER })]);
    // Leftovers that would hide Postman's rows if the link did not clear them.
    act(() => {
      setSourceSelection(["t:t-1"]);
      setFilter("host:nowhere");
    });
    const link = within(routing()).getByRole("button", { name: "show them" });
    expect(link).toHaveAttribute("title", "IDE traffic, filtered to Postman Helper");
    fireEvent.click(link);
    const s = useNetworkStore.getState();
    expect(s.mode).toBe("ide");
    expect(s.processSelection).toEqual(["Postman Helper"]);
    expect([s.sourceSelection, s.filter]).toEqual([null, ""]);
    await settle();
    expect(screen.getAllByTestId("net-row").map((r) => r.getAttribute("data-flow-id"))).toEqual(["2", "3"]);
    for (const r of screen.getAllByTestId("net-row")) expect(r.querySelector("td.net-c--source")).toHaveTextContent("external · Postman Helper");
  });
});

describe("the per-app decrypt switch", () => {
  const sw = () => screen.getByRole("switch", { name: SWITCH });

  it("sits in the Certificate section, off by default, with a hover that says HTTPS fails without the certificate step", async () => {
    await mountGuide();
    const cert = screen.getAllByTestId("netm-guide-section")[1];
    expect(within(cert).getByRole("switch", { name: SWITCH })).toBe(sw());
    expect(sw()).toHaveAttribute("aria-checked", "false");
    expect(sw()).toBeEnabled();
    expect(sw().parentElement?.getAttribute("title")).toMatch(/without it, Postman's HTTPS requests will fail/);
  });

  it("calls netcap_set_app_decrypt with the exact args and shows what Rust RETURNS", async () => {
    await mountGuide();
    ipc.netcapSetAppDecrypt.mockResolvedValueOnce({ ...STATUS, decryptApps: ["Postman"] });
    fireEvent.click(sw());
    expect(ipc.netcapSetAppDecrypt).toHaveBeenCalledWith("Postman", true);
    expect(sw()).toBeDisabled(); // in flight
    await settle();
    expect(sw()).toHaveAttribute("aria-checked", "true");
    expect(sw()).toBeEnabled();

    ipc.netcapSetAppDecrypt.mockResolvedValueOnce({ ...STATUS, decryptApps: [] });
    fireEvent.click(sw());
    expect(ipc.netcapSetAppDecrypt).toHaveBeenLastCalledWith("Postman", false);
    await settle();
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });

  it("a status Rust answers WITHOUT the app keeps the switch off (the click is not the truth)", async () => {
    await mountGuide();
    ipc.netcapSetAppDecrypt.mockResolvedValueOnce({ ...STATUS, decryptApps: ["Insomnia"] });
    fireEvent.click(sw());
    await settle();
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });

  it("an app already opted in reads as on; a Helper row writes the bundle once a flow names it", async () => {
    ipc.netcapStatus.mockResolvedValue({ ...STATUS, decryptApps: ["Postman"] });
    await mountGuide();
    expect(sw()).toHaveAttribute("aria-checked", "true");
    act(() => emitSample({ tsMs: 2, apps: [...SAMPLE.apps, app("Postman Helper", 9001)] }));
    act(() => setCaptureGuide("Postman Helper:9001"));
    expect(screen.getByRole("switch", { name: "I added the IDE's certificate in Postman Helper — decrypt its HTTPS" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    act(() => emitFlows([flow(3, { client: POSTMAN_HELPER })]));
    expect(sw()).toHaveAttribute("aria-checked", "true");
  });

  it("Chrome's guide has no such switch (it cannot trust a CA file)", async () => {
    await mountGuide([], "Google Chrome:8082");
    expect(screen.queryAllByRole("switch", { name: /decrypt its HTTPS/ })).toEqual([]);
  });

  it("before the status arrives it is disabled and its wrapper says why", async () => {
    ipc.netcapStatus.mockReturnValue(new Promise(() => {}));
    await mountGuide();
    expect(sw()).toBeDisabled();
    expect(sw().parentElement).toHaveAttribute("title", STATUS_PENDING);
  });

  it("a rejected call is an error in the store, and the switch comes back", async () => {
    ipc.netcapSetAppDecrypt.mockRejectedValueOnce(new Error("invalid app"));
    await setAppDecrypt("Postman", true);
    expect(useNetworkStore.getState()).toMatchObject({ statusError: "invalid app", setting: false });
  });
});

describe("the proxy's port", () => {
  const MOVED = "The proxy moved from :8877 to :60123 (port 8877 was busy) — update the port in apps you configured by hand.";

  it("the guide says the port is stable across restarts", async () => {
    await mountGuide();
    expect(screen.getByTestId("netm-guide-proxy")).toHaveTextContent("127.0.0.1:8877 This port stays the same across restarts.");
    expect(screen.queryByTestId("net-port-changed")).toBeNull();
  });

  it("a moved port is a warning in the open guide", async () => {
    ipc.netcapStatus.mockResolvedValue({ ...STATUS, port: 60123, portChanged: { from: 8877, to: 60123 } });
    await mountGuide();
    const banner = within(screen.getByTestId("netm-guide")).getByTestId("net-port-changed");
    expect(banner).toHaveTextContent(MOVED);
    expect(banner).toHaveAttribute("role", "alert");
  });

  it("…and in the IDE traffic header; absent when the port did not move", async () => {
    ipc.netcapStatus.mockResolvedValue({ ...STATUS, port: 60123, portChanged: { from: 8877, to: 60123 } });
    const view = render(<NetworkPanel />);
    await settle();
    expect(screen.getByTestId("net-port")).toHaveTextContent("proxy 127.0.0.1:60123");
    expect(screen.getByTestId("net-port-changed")).toHaveTextContent(MOVED);
    view.unmount();
    ipc.netcapStatus.mockResolvedValue(STATUS);
    render(<NetworkPanel />);
    await settle();
    expect(screen.getByTestId("net-port")).toHaveTextContent("proxy 127.0.0.1:8877");
    expect(screen.queryByTestId("net-port-changed")).toBeNull();
  });
});

describe("a routed-but-tunnelled app points at the switch, by its bundle name", () => {
  it("a Postman Helper tunnel names Postman — the entry the switch writes — not the helper", async () => {
    ipc.netcapSnapshot.mockResolvedValue([
      flow(1, { proto: "tunnel", method: "CONNECT", host: "api.getpostman.com", port: 443, path: "", status: null, client: POSTMAN_HELPER, note: "not decrypted: Postman Helper doesn't read the IDE's CA" }),
    ]);
    render(<NetworkPanel />);
    await settle();
    act(() => openDetail(1));
    await settle();
    expect(screen.getByTestId("net-explain")).toHaveTextContent(
      "not decrypted: Postman Helper doesn't read the IDE's CA. To see Postman's HTTPS contents: turn on Decrypt HTTPS, " +
        `add the IDE's CA in Postman, then switch on “${SWITCH}” in the Certificate step`,
    );
  });
});
