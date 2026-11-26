/** Only the IPC modules are mocked; every store, formatter and component is the real one.
 * Expected strings are written by hand, never derived from the code under test. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import type { AgentId, AgentNode, Tab, TabId } from "../../app/types";
import type { DevApp, ProcsList } from "../procs/procsTypes";
import type { FlowSummary, MachineApp, MachineConn, MachineSample, MachineStatus, NetcapStatus } from "./networkTypes";

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
const procs = vi.hoisted(() => ({
  procsList: vi.fn(),
  tailApp: vi.fn(),
  tailDocker: vi.fn(),
  untail: vi.fn(),
  pickLogFile: vi.fn(),
  restartPrepare: vi.fn(),
  restartInIde: vi.fn(),
}));
vi.mock("../procs/procsIpc", () => procs);

import { resetAgentLogsForTests } from "../agentlogs/agentLogsStore";
import { resetProcsStore, useProcsStore } from "../procs/procsStore";
import { CAPTURE_RESTART_QUESTION } from "../procs/RestartDialog";
import { LIVE_CONNS_MAX } from "./IdeAppCapture";
import { resetMachineStore, setCaptureGuide, useMachineStore } from "./machineStore";
import { pickOf } from "./networkApps";
import { NetworkPanel } from "./NetworkPanel";
import { resetNetworkStore, showAllFlows, toggleAppPick, useNetworkStore } from "./networkStore";

const STATUS: NetcapStatus = {
  running: true, port: 8877, enabled: true, decrypt: true, caPath: "/cfg/netcap/ca.pem",
  skippedReason: null, passthroughHosts: [], flowCount: 0, decryptApps: [], portChanged: null,
};
const MAC: MachineStatus = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };

const dev = (o: Partial<DevApp>): DevApp => ({
  key: "pid:0", pid: 0, runtime: "node", name: "x", exe: "/usr/local/bin/node", argv: ["node"], cwd: "/w/x",
  startedMs: 1, ports: [], console: "ide-terminal", logFiles: [], containerId: null, origin: "ide",
  terminalId: "T1", agentId: null, launchedBy: "zsh", captured: true, ...o,
});
/** The canonical case: IDE app, proxy vars stripped. */
const GAZELLE = dev({ key: "pid:10", pid: 10, runtime: "rust", name: "gazelle", exe: "/w/gazelle/target/debug/gazelle", argv: ["target/debug/gazelle"], cwd: "/w/gazelle", captured: false });
const WEB = dev({ key: "pid:20", pid: 20, name: "web", captured: true, ports: [3000] });
const API = dev({ key: "pid:21", pid: 21, name: "api", captured: null, terminalId: "T2", launchedBy: "bash" });
const EXT = dev({ key: "pid:30", pid: 30, runtime: "go", name: "gateway", exe: "/opt/gateway", argv: ["/opt/gateway"], origin: "external", terminalId: null, launchedBy: null, captured: null, console: "terminal" });
const LIST: ProcsList = { available: true, reason: null, apps: [GAZELLE, WEB, API, EXT] };

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: 1_700_000_000_000 + id, proto: "http", method: "GET", host: "localhost", port: 3000,
    path: `/r/${id}`, status: 200, grpcStatus: null, contentType: "application/json",
    reqBytes: 0, resBytes: 11, durationMs: 12, state: "done", error: null, terminalId: "T1",
    httpVersion: "HTTP/1.1", wsMessages: null, client: null, note: null, ...o,
  };
}
const node = (pid: number) => ({ pid, name: "node", path: "/usr/local/bin/node" });
const FLOWS = [
  flow(1, { client: node(20) }), // web
  flow(2, { client: node(20) }), // web
  flow(3, { client: node(21), terminalId: "T2" }), // api
  flow(4, { client: { pid: 30, name: "gateway", path: "/opt/gateway" }, terminalId: null }), // gateway, by hand
];

function conn(o: Partial<MachineConn> = {}): MachineConn {
  return { proto: "tcp4", local: "10.0.0.5:50000", remote: "151.101.1.69:443", remoteHost: null, state: "Established", bytesIn: 2048, bytesOut: 512, rateIn: 100, rateOut: 10, ...o };
}
function mapp(name: string, pid: number, connections: MachineConn[]): MachineApp {
  return { key: `${name}:${pid}`, name, pid, user: "self", bytesIn: 1, bytesOut: 1, rateIn: 1, rateOut: 1, connections };
}

let emitSample: (s: MachineSample) => void = () => {};
let emitFlows: (b: FlowSummary[]) => void = () => {};

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  resetProcsStore();
  resetAgentLogsForTests();
  useColumnLayoutStore.setState({ layouts: {} });
  vi.clearAllMocks();
  ipc.listenFlows.mockImplementation(async (h: (b: FlowSummary[]) => void) => {
    emitFlows = h;
    return () => {};
  });
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue(FLOWS);
  mach.listenSamples.mockImplementation(async (h: (s: MachineSample) => void) => {
    emitSample = h;
    return () => {};
  });
  mach.netmachineStatus.mockResolvedValue({ ...MAC, running: false });
  mach.netmachineStart.mockResolvedValue(MAC);
  mach.netmachineStop.mockResolvedValue({ ...MAC, running: false });
  procs.procsList.mockResolvedValue(LIST);
  procs.restartPrepare.mockResolvedValue({ token: "rs-1", summary: { name: "gazelle", cwd: "/w/gazelle", argv: [] } });
  procs.restartInIde.mockResolvedValue({ terminalId: "T9" });
});
afterEach(() => {
  resetNetworkStore();
  resetMachineStore();
  resetProcsStore();
});

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 5)));

async function mount(): Promise<void> {
  render(<NetworkPanel />);
  await settle();
  await settle();
}

const rowIds = () => screen.getAllByTestId("net-row").map((r) => Number(r.dataset.flowId));
const line = (key: string) => within(screen.getByTestId("net-apps")).getAllByTestId("procs-line").find((l) => l.dataset.key === key) as HTMLElement;
const check = (key: string) => within(line(key)).getByTestId("net-app-check") as HTMLInputElement;
const capture = (key: string) => within(line(key)).getByTestId("net-app-capture");

describe("the Apps sidebar in IDE traffic", () => {
  it("lists the Logs sidebar's by-language apps, All apps pressed, every flow shown", async () => {
    await mount();
    const side = screen.getByTestId("net-apps");
    expect(within(side).getAllByTestId("procs-runtime-head").map((h) => h.textContent)).toEqual([
      "▾Rust · Cargo1", "▸JVM0", "▾Node · JS2", "▸Python0", "▾Go1", "▸Docker0", "▸Shell0",
    ]);
    expect(within(side).getByTestId("net-apps-all")).toHaveAttribute("aria-pressed", "true");
    expect(rowIds()).toEqual([1, 2, 3, 4]);
    expect(within(line("pid:20")).getByTestId("procs-ports").textContent).toBe(":3000");
    // The row's own ⚠ gives way to the capture column here.
    expect(within(side).queryByTestId("procs-uncaptured-mark")).toBeNull();
  });

  it("the three capture states (and unknown) on the rows", async () => {
    await mount();
    expect(capture("pid:20")).toHaveAttribute("data-state", "captured");
    expect(capture("pid:20")).toHaveTextContent("✓");
    expect(capture("pid:20")).toHaveAttribute("title", "2 requests captured");
    expect(capture("pid:10")).toHaveAttribute("data-state", "uncaptured");
    expect(capture("pid:10")).toHaveAttribute("title", "gazelle was started without the IDE's proxy — its HTTP calls can't show in Network.");
    expect(within(capture("pid:10")).getByTestId("net-app-restart-capture").textContent).toBe("Restart with capture");
    // api: env unknown, but its flow arrived → ✓.
    expect(capture("pid:21")).toHaveAttribute("data-state", "captured");
    // gateway: external, but pointed at the proxy by hand → ✓.
    expect(capture("pid:30")).toHaveAttribute("data-state", "captured");
  });

  it("external with nothing arrived: “capture →” opens Whole Mac's guide on its pid", async () => {
    ipc.netcapSnapshot.mockResolvedValue([]);
    await mount();
    expect(capture("pid:30")).toHaveAttribute("data-state", "external");
    expect(capture("pid:21")).toHaveAttribute("data-state", "unknown");
    expect(capture("pid:20")).toHaveAttribute("title", "Captured — its requests show here");
    // The hover names the view the way the toggle does — on Windows, "Whole computer".
    act(() => useMachineStore.setState({ status: { ...MAC, backend: "windows-iphlpapi" } }));
    expect(within(capture("pid:30")).getByTestId("net-app-guide")).toHaveAttribute(
      "title",
      "How to point gateway at the IDE's capture proxy (Whole computer › Capture this app)",
    );
    act(() => useMachineStore.setState({ status: MAC }));
    expect(within(capture("pid:30")).getByTestId("net-app-guide").getAttribute("title")).toMatch(/\(Whole Mac › Capture this app\)$/);
    fireEvent.click(within(capture("pid:30")).getByTestId("net-app-guide"));
    expect(useNetworkStore.getState().mode).toBe("machine");
    await settle();
    act(() => emitSample({ tsMs: 1, apps: [mapp("gateway", 30, [conn()])] }));
    expect(useMachineStore.getState().guideKey).toBe("gateway:30");
    const guide = screen.getByTestId("netm-guide");
    expect(guide.dataset.guide).toBeUndefined();
    // A Go app: the decrypt caveat, next to the Decrypt row.
    expect(within(guide).getByTestId("netm-guide-caveat")).toHaveTextContent(
      "Most Rust and Go apps use a built-in certificate list and ignore the IDE's CA — their HTTPS shows as host, timing and size, not contents.",
    );
    expect(within(guide).getByTestId("netm-guide-outcome").textContent).toBe(
      "Its requests then appear under IDE traffic, Source external · gateway, Process gateway.",
    );
  });

  it("checkboxes add apps one by one (by pid); unchecking the last is All apps", async () => {
    await mount();
    fireEvent.click(check("pid:20"));
    expect(check("pid:20").checked).toBe(true);
    expect(rowIds()).toEqual([1, 2]);
    expect(screen.getByTestId("net-apps-all")).toHaveAttribute("aria-pressed", "false");
    // Only-one pick presses its row.
    expect(within(line("pid:20")).getByTestId("procs-row")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(check("pid:21"));
    expect(rowIds()).toEqual([1, 2, 3]);
    expect(within(line("pid:20")).getByTestId("procs-row")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(check("pid:20"));
    fireEvent.click(check("pid:21"));
    expect(useNetworkStore.getState().appSelection).toBeNull();
    expect(rowIds()).toEqual([1, 2, 3, 4]);
  });

  it("a row click (not the checkbox) is Only that app; All apps undoes every pick", async () => {
    await mount();
    fireEvent.click(check("pid:20"));
    fireEvent.click(within(line("pid:30")).getByTestId("procs-row"));
    expect(rowIds()).toEqual([4]);
    expect(check("pid:20").checked).toBe(false);
    // The Logs selection is not touched from here.
    expect(useProcsStore.getState().selectedKey).toBeNull();
    fireEvent.click(screen.getByTestId("net-apps-all"));
    expect(rowIds()).toEqual([1, 2, 3, 4]);
  });

  it("falls back to the executable name for a client pid no listed app owns (it restarted)", async () => {
    await mount();
    fireEvent.click(within(line("pid:20")).getByTestId("procs-row"));
    act(() => emitFlows([flow(5, { client: node(777) }), flow(6, { client: node(21) })]));
    expect(rowIds()).toEqual([1, 2, 5]);
  });

  it("an app picked for which nothing arrived: the empty table names the Apps sidebar", async () => {
    await mount();
    fireEvent.click(within(line("pid:10")).getByTestId("procs-row"));
    expect(screen.queryAllByTestId("net-row")).toEqual([]);
    expect(screen.getByTestId("net-hidden-by-app").textContent).toBe("Apps sidebar (gazelle) hides 4");
    act(() => showAllFlows());
    expect(useNetworkStore.getState().appSelection).toBeNull();
  });

  it("a picked app that exits stays as a checked row, still filtering; unchecking it is All apps", async () => {
    await mount();
    fireEvent.click(check("pid:20"));
    act(() => useProcsStore.setState({ list: { ...LIST, apps: [GAZELLE, API, EXT] } }));
    const gone = screen.getByTestId("net-app-gone");
    expect(gone).toHaveTextContent("web (exited)");
    expect(rowIds()).toEqual([1, 2]);
    fireEvent.click(within(gone).getByRole("checkbox", { name: "Show web's requests" }));
    expect(screen.queryByTestId("net-app-gone")).toBeNull();
    expect(rowIds()).toEqual([1, 2, 3, 4]);
  });

  it("Restart with capture from the row: the banner's confirm, worded for capture, then prepare → restart → a focused tab", async () => {
    await mount();
    fireEvent.click(within(capture("pid:10")).getByTestId("net-app-restart-capture"));
    const dialog = screen.getByTestId("procs-restart-dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Restart gazelle with capture?");
    expect(dialog).toHaveTextContent(CAPTURE_RESTART_QUESTION);
    expect(CAPTURE_RESTART_QUESTION).toBe(
      "Stop it and run the same command in an IDE terminal with capture on? Its HTTP calls will then show in Network.",
    );
    fireEvent.click(within(dialog).getByTestId("procs-restart-confirm"));
    await settle();
    expect(procs.restartPrepare).toHaveBeenCalledWith(10);
    expect(procs.restartInIde).toHaveBeenCalledWith("rs-1");
    const s = useAppStore.getState();
    expect(Object.values(s.tabs).some((t) => t.ref.kind === "terminal" && t.ref.terminalId === "T9")).toBe(true);
    expect(screen.queryByTestId("procs-restart-dialog")).toBeNull();
  });
});

describe("the not-captured banner", () => {
  it("names every IDE app whose calls cannot reach this view", async () => {
    await mount();
    const rows = screen.getAllByTestId("net-uncaptured-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "⚠ Not captured: gazelle (pid 10) — started without the IDE's proxy.Restart with captureShow app",
    ]);
  });

  it("is absent while every IDE app is captured", async () => {
    procs.procsList.mockResolvedValue({ ...LIST, apps: [WEB, API, EXT] });
    await mount();
    expect(screen.queryByTestId("net-uncaptured")).toBeNull();
  });

  it("Show app opens Logs with that app selected", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("net-uncaptured-show"));
    expect(useProcsStore.getState().selectedKey).toBe("pid:10");
    expect(Object.values(useAppStore.getState().tabs).some((t) => t.ref.kind === "agent-logs")).toBe(true);
  });

  it("a restart that fails says why in the banner, and can be dismissed", async () => {
    procs.restartPrepare.mockRejectedValue(new Error("pid 10 is not running"));
    await mount();
    fireEvent.click(screen.getByTestId("net-uncaptured-restart"));
    fireEvent.click(screen.getByTestId("procs-restart-cancel"));
    expect(screen.queryByTestId("procs-restart-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("net-uncaptured-restart"));
    fireEvent.click(screen.getByTestId("procs-restart-confirm"));
    await settle();
    expect(screen.getByTestId("net-uncaptured-error")).toHaveTextContent("Could not restart: pid 10 is not running");
    fireEvent.click(within(screen.getByTestId("net-uncaptured-error")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("net-uncaptured-error")).toBeNull();
    // A refused confirm (nothing requested) opens nothing and reports nothing.
    expect(procs.restartInIde).not.toHaveBeenCalled();
  });
});

describe("Whole Mac's guide for an IDE app — no manual steps", () => {
  async function guideFor(key: string, sample: MachineSample): Promise<HTMLElement> {
    await mount();
    fireEvent.click(within(screen.getByRole("group", { name: "Network mode" })).getByRole("button", { name: /Whole/ }));
    await settle();
    act(() => emitSample(sample));
    act(() => setCaptureGuide(key));
    return screen.getByTestId("netm-guide");
  }

  it("not captured: why, Restart with capture, its live connections now, and a link to all of them", async () => {
    const conns = [
      conn({ remote: "140.82.112.3:443", remoteHost: "github.com" }),
      conn({ remote: null, state: "Listen", local: "0.0.0.0:3000" }),
      ...Array.from({ length: LIVE_CONNS_MAX + 1 }, (_, i) => conn({ local: `10.0.0.5:${6000 + i}` })),
    ];
    const guide = await guideFor("gazelle:10", { tsMs: 1, apps: [mapp("gazelle", 10, conns)] });
    expect(guide.dataset.guide).toBe("ide");
    expect(within(guide).getByTestId("netm-guide-ide").textContent).toBe(
      "gazelle was started in the IDE (zsh) — the IDE sets its proxy, so there is nothing to configure by hand.",
    );
    expect(within(guide).queryAllByTestId("netm-guide-section")).toEqual([]);
    expect(within(guide).queryByText(/I added the IDE's certificate/)).toBeNull();
    expect(within(guide).getByTestId("procs-uncaptured").textContent).toBe(
      "⚠ gazelle was started without the IDE's proxy — its launcher removed the proxy variables, so its HTTP calls can't reach Network.",
    );
    const cs = within(guide).getByTestId("net-idecap-conns");
    expect(cs).toHaveTextContent("Right now — its live connections");
    const rows = within(cs).getAllByTestId("net-idecap-conn");
    expect(rows).toHaveLength(LIVE_CONNS_MAX);
    expect(rows[0].textContent).toBe("github.com (140.82.112.3:443)Established↓2.0KB ↑512B↓100B/s ↑10B/s");
    expect(within(cs).getByTestId("net-idecap-more").textContent).toBe("…and 2 more");

    // Restart with capture: the guide owns the confirm here.
    fireEvent.click(within(guide).getByTestId("procs-restart-capture"));
    expect(within(guide).getByTestId("procs-restart-dialog")).toHaveTextContent("Restart gazelle with capture?");
    fireEvent.click(within(guide).getByTestId("procs-restart-cancel"));

    // The link names the view as the toggle does: Whole Mac on the nettop backend, and on
    // Windows' "Whole computer" — a Windows user has no "Whole Mac" to look for.
    expect(within(guide).getByTestId("net-idecap-all-conns")).toHaveTextContent("all connections in Whole Mac →");
    act(() => useMachineStore.setState({ status: { ...MAC, backend: "windows-iphlpapi" } }));
    expect(within(guide).getByTestId("net-idecap-all-conns")).toHaveTextContent("all connections in Whole computer →");
    fireEvent.click(within(guide).getByTestId("net-idecap-all-conns"));
    expect(useMachineStore.getState().selectedKey).toBe("gazelle:10");
    fireEvent.click(within(guide).getByRole("button", { name: "Close the capture guide" }));
    expect(useMachineStore.getState().guideKey).toBeNull();
  });

  it("an IDE app Rust could not name the launcher of: “its terminal”", async () => {
    procs.procsList.mockResolvedValue({ ...LIST, apps: [{ ...GAZELLE, launchedBy: null }] });
    const guide = await guideFor("gazelle:10", { tsMs: 1, apps: [mapp("gazelle", 10, [])] });
    expect(within(guide).getByTestId("netm-guide-ide").textContent).toBe(
      "gazelle was started in the IDE (its terminal) — the IDE sets its proxy, so there is nothing to configure by hand.",
    );
  });

  it("not captured, nothing sampled for it: says so", async () => {
    const guide = await guideFor("gazelle:10", { tsMs: 1, apps: [mapp("gazelle", 10, [])] });
    expect(within(guide).getByTestId("net-idecap-conns")).toHaveTextContent("No open connections right now.");
  });

  it("captured: ✓ Receiving … N so far, Show them lands on its rows, and where they appear exactly", async () => {
    const guide = await guideFor("node:20", { tsMs: 1, apps: [mapp("node", 20, [conn()])] });
    expect(within(guide).getByTestId("net-idecap-receiving").textContent).toBe("✓ Receiving web's requests — 2 so far Show them");
    expect(within(guide).getByTestId("net-idecap-where").textContent).toBe("They appear under IDE traffic, Source zsh, Process node.");
    expect(within(guide).queryByTestId("net-idecap-caveat")).toBeNull();
    fireEvent.click(within(guide).getByTestId("net-idecap-show"));
    expect(useNetworkStore.getState().mode).toBe("ide");
    expect(useNetworkStore.getState().processSelection).toEqual(["node"]);
    await settle();
    expect(rowIds()).toEqual([1, 2, 3]);
  });
});

describe("IdeAppCapture's remaining states", () => {
  it("a captured Rust app with nothing yet: “Captured — none yet”, where, and the decrypt caveat; the Source is its tab's title", async () => {
    const rusty = dev({ key: "pid:40", pid: 40, runtime: "rust", name: "svc", exe: "/w/svc/target/debug/svc", argv: ["svc"], terminalId: "T40" });
    procs.procsList.mockResolvedValue({ ...LIST, apps: [rusty] });
    useAppStore.getState().layoutActions.rebuildTerminalTabs([
      { id: "T40" as never, kind: "terminal", title: "zsh · svc", cwd: "/w/svc", cols: 80, rows: 24, status: "live" },
    ]);
    await mount();
    fireEvent.click(within(screen.getByRole("group", { name: "Network mode" })).getByRole("button", { name: /Whole/ }));
    await settle();
    act(() => emitSample({ tsMs: 1, apps: [mapp("svc", 40, [])] }));
    act(() => setCaptureGuide("svc:40"));
    const guide = screen.getByTestId("netm-guide");
    expect(within(guide).getByTestId("net-idecap-receiving").textContent).toBe("✓ Captured — no requests from svc yet Show them");
    expect(within(guide).getByTestId("net-idecap-where").textContent).toBe("They appear under IDE traffic, Source zsh · svc, Process svc.");
    expect(within(guide).getByTestId("net-idecap-caveat")).toBeTruthy();
  });

  it("no executable to name: no Show them; env unknown: nothing to say; the live list waits for the sampler", async () => {
    const { IdeAppCapture, LiveConnections } = await import("./IdeAppCapture");
    const noExe = dev({ key: "pid:50", pid: 50, name: "blob", exe: null, argv: [] });
    const unknown = dev({ key: "pid:51", pid: 51, name: "hidden", captured: null });
    const noop = () => {};
    const { container } = render(
      <>
        <IdeAppCapture app={noExe} source="zsh" onShowRequests={noop} onShowConnections={noop} />
        <IdeAppCapture app={unknown} source="zsh" onShowRequests={noop} onShowConnections={noop} />
        <LiveConnections pid={50} />
      </>,
    );
    // No status yet and jsdom is not macOS: the sampler is the "Whole computer" one.
    expect(screen.getByTestId("net-idecap-conns")).toHaveTextContent("Waiting for the Whole computer sampler…");
    // With the macOS backend's status loaded, it is the Whole Mac sampler.
    act(() => useMachineStore.setState({ status: MAC }));
    expect(screen.getByTestId("net-idecap-conns")).toHaveTextContent("Waiting for the Whole Mac sampler…");
    // A sample without this pid: nothing open for it.
    act(() => useMachineStore.setState({ latest: { tsMs: 1, apps: [] } }));
    expect(screen.getByTestId("net-idecap-receiving").textContent).toBe("✓ Captured — no requests from blob yet");
    expect(screen.queryByTestId("net-idecap-show")).toBeNull();
    expect(screen.getByTestId("net-idecap-where").textContent).toBe("They appear under IDE traffic, Source zsh, Process unknown.");
    expect(container.querySelectorAll('[data-testid="net-idecap"]')).toHaveLength(1);
    expect(screen.getByTestId("net-idecap-conns")).toHaveTextContent("No open connections right now.");
  });

  it("the store's app picks: toggling a pick in twice is add then remove", () => {
    toggleAppPick(pickOf(WEB));
    expect(useNetworkStore.getState().appSelection).toEqual([pickOf(WEB)]);
    toggleAppPick(pickOf(WEB));
    expect(useNetworkStore.getState().appSelection).toBeNull();
  });
});

/** T1 is a plain terminal titled `gazelle`, T2 an agent's; flow 4 has no terminal and a resolved
 * client (`external · gateway`). The rows are the toolbar Source picker's state. */
describe("the sidebar's Terminals / Agents / Other groups", () => {
  beforeEach(() => {
    useAppStore.setState((s) => {
      s.tabs = {
        t1: { id: "t1", kind: "terminal", title: "gazelle", ref: { kind: "terminal", terminalId: "T1" } },
        t2: { id: "t2", kind: "agent-terminal", title: "tab", ref: { kind: "agent-terminal", terminalId: "T2", agentId: "a1" } },
      } as unknown as Record<TabId, Tab>;
      s.agents = { a1: { id: "a1", title: "claude · api", customTitle: null } } as unknown as Record<AgentId, AgentNode>;
    });
  });

  const group = (g: string) => document.querySelector<HTMLElement>(`[data-testid="net-src-group"][data-group="${g}"]`)!;
  const srcRow = (key: string) => document.querySelector<HTMLElement>(`[data-testid="net-src-row"][data-source="${key}"]`)!;
  const srcCheck = (key: string) => within(srcRow(key)).getByTestId("net-src-check") as HTMLInputElement;
  const srcButton = (key: string) => within(srcRow(key)).getByRole("button");
  const sourcePicker = () => screen.getByRole("button", { name: "Filter by source" });

  it("lists each group under its heading, rows = the flows' sources with their flow counts", async () => {
    await mount();
    const rowsOf = (g: string) =>
      within(group(g)).getAllByTestId("net-src-row").map((r) => [r.querySelector(".net-side__name")!.textContent, within(r).getByTestId("net-src-count").textContent]);
    expect(within(group("terminals")).getByText("Terminals")).toBeInTheDocument();
    expect(rowsOf("terminals")).toEqual([["gazelle", "2"]]);
    expect(within(group("agents")).getByText("Agents")).toBeInTheDocument();
    expect(rowsOf("agents")).toEqual([["claude · api", "1"]]);
    expect(rowsOf("other")).toEqual([["external · gateway", "1"]]);
    // The external row says which executable, as its sublabel.
    expect(within(srcRow("ext:gateway")).getByText("/opt/gateway")).toBeInTheDocument();
    expect(srcButton("ext:gateway")).toHaveAttribute("title", "Only external · gateway — /opt/gateway");
    expect(srcButton("t:T1")).toHaveAttribute("title", "Only gazelle");
    // All, at the very top, is pressed and counts every flow.
    const all = screen.getByTestId("net-side-all");
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveTextContent("All4");
    expect(screen.getByTestId("net-apps").firstElementChild!.nextElementSibling!.firstElementChild).toBe(all);
  });

  it("a group with no sources is not drawn", async () => {
    ipc.netcapSnapshot.mockResolvedValue(FLOWS.slice(0, 2));
    await mount();
    expect(screen.getAllByTestId("net-src-group").map((g) => g.dataset.group)).toEqual(["terminals"]);
  });

  it("row click = Only that terminal: only its flows, the row pressed, the toolbar picker names it", async () => {
    await mount();
    fireEvent.click(srcButton("t:T1"));
    expect(rowIds()).toEqual([1, 2]);
    expect(srcButton("t:T1")).toHaveAttribute("aria-pressed", "true");
    expect(srcCheck("t:T1").checked).toBe(true);
    expect(sourcePicker()).toHaveTextContent("gazelle ▾");
    expect(screen.getByTestId("net-side-all")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(srcButton("t:T2"));
    expect(rowIds()).toEqual([3]);
    expect(srcCheck("t:T1").checked).toBe(false);
  });

  it("checkboxes add sources one by one; unchecking the last is every source again", async () => {
    await mount();
    fireEvent.click(srcCheck("t:T1"));
    fireEvent.click(srcCheck("ext:gateway"));
    expect(rowIds()).toEqual([1, 2, 4]);
    expect(sourcePicker()).toHaveTextContent("2 sources ▾");
    // Two picked: no single row reads as "Only".
    expect(srcButton("t:T1")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(srcCheck("t:T1"));
    fireEvent.click(srcCheck("ext:gateway"));
    expect(useNetworkStore.getState().sourceSelection).toBeNull();
    expect(sourcePicker()).toHaveTextContent("All sources ▾");
    expect(rowIds()).toEqual([1, 2, 3, 4]);
  });

  it("a pick made in the toolbar's Source picker shows in the sidebar", async () => {
    await mount();
    fireEvent.click(sourcePicker());
    fireEvent.click(within(screen.getByRole("listbox")).getAllByRole("button", { name: "Only" })[0]);
    // The picker's rows are sorted by label: `claude · api` first.
    expect(srcCheck("t:T2").checked).toBe(true);
    expect(srcButton("t:T2")).toHaveAttribute("aria-pressed", "true");
    expect(srcCheck("t:T1").checked).toBe(false);
  });

  it("All clears the app pick and the source pick together", async () => {
    await mount();
    fireEvent.click(check("pid:20"));
    fireEvent.click(srcCheck("t:T1"));
    expect(rowIds()).toEqual([1, 2]);
    fireEvent.click(screen.getByTestId("net-side-all"));
    const s = useNetworkStore.getState();
    expect([s.appSelection, s.sourceSelection]).toEqual([null, null]);
    expect(rowIds()).toEqual([1, 2, 3, 4]);
    expect(screen.getByTestId("net-side-all")).toHaveAttribute("aria-pressed", "true");
  });

  it("the Apps rows' origin tag carries its full text as a title", async () => {
    await mount();
    const tag = within(line("pid:21")).getByTestId("procs-origin");
    expect(tag.textContent).not.toBe("");
    expect(tag).toHaveAttribute("title", tag.textContent);
  });

  it("a renamed launcher terminal names the tag by its live title (`by gazelle`), else Rust's spawn title", async () => {
    // The tag used to read `by bash` for the terminal the user named `gazelle`.
    // Falsified: dropping the sidebar's `launcherLabel` → `by bash` again.
    useAppStore.setState((s) => {
      s.tabs = {
        g: { id: "g", kind: "terminal", title: "bash", customTitle: "gazelle", ref: { kind: "terminal", terminalId: "T2" } },
      } as unknown as Record<TabId, Tab>;
    });
    await mount();
    expect(within(line("pid:21")).getByTestId("procs-origin")).toHaveTextContent("by gazelle");
    expect(within(line("pid:20")).getByTestId("procs-origin")).toHaveTextContent("by zsh");
    expect(within(line("pid:30")).getByTestId("procs-origin")).toHaveTextContent("external");
  });
});

describe("the sidebar's width", () => {
  const side = () => screen.getByTestId("net-apps");
  const handle = () => screen.getByRole("separator", { name: "Resize the apps sidebar" });

  it("is 280 by default and follows the store (it survives a remount)", async () => {
    await mount();
    expect(side().style.width).toBe("280px");
    expect(handle()).toHaveAttribute("aria-valuenow", "280");
  });

  it("←/→ step by 10 (Shift: 40), other keys do nothing; drag follows the pointer; double-click resets", async () => {
    await mount();
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(side().style.width).toBe("290px");
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(side().style.width).toBe("250px");
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(side().style.width).toBe("250px");
    fireEvent.pointerDown(handle(), { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 160 });
    fireEvent.pointerUp(handle());
    expect(useNetworkStore.getState().sidebarWidth).toBe(310);
    // After the release a move no longer drags.
    fireEvent.pointerMove(handle(), { clientX: 400 });
    expect(useNetworkStore.getState().sidebarWidth).toBe(310);
    fireEvent.pointerDown(handle(), { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: -900 });
    expect(side().style.width).toBe("180px");
    fireEvent.doubleClick(handle());
    expect(side().style.width).toBe("280px");
  });
});

describe("fit to the pane (jsdom half — the pixels are networkColumns.browser.test.tsx)", () => {
  // jsdom lays nothing out: give the scroll box the client width a 1280 px window has.
  let restore: () => void = () => {};
  beforeEach(() => {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth") as PropertyDescriptor;
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.classList.contains("net-scroll") ? 438 : 0;
      },
    });
    restore = () => Object.defineProperty(Element.prototype, "clientWidth", d);
  });
  afterEach(() => restore());

  it("hides Process / Size / Duration / Type, squeezes the rest (tight), and Columns ▾ lists the hidden ones unticked", async () => {
    await mount();
    const heads = [...document.querySelectorAll("th.net-th")].map((h) => h.firstChild?.textContent);
    expect(heads).toEqual(["Time", "Proto", "Method", "Host", "Path", "Status", "Source"]);
    expect(document.querySelector("table.net-table")).toHaveClass("net-table--tight");
    fireEvent.click(screen.getByTestId("columns-menu-network.ide"));
    for (const name of ["Process", "Size", "Duration", "Type"]) {
      expect(screen.getByRole("menuitemcheckbox", { name }), name).not.toBeChecked();
    }
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Type" }));
    expect([...document.querySelectorAll("th.net-th")].map((h) => h.firstChild?.textContent)).toContain("Type");
  });
});
