/**
 * Sources, hosts and the capture guide — requests from the IDE's own API client must
 * appear, and an app like Postman must be more than Whole-Mac connections (what those
 * connections are doing must be visible).
 *
 * 1. Source labels: `ide-api-client` → **API client**; no userinfo + a resolved process →
 *    **external · <name>**; only null/null is unattributed. Picker rows keyed accordingly.
 * 2. A Host picker in the IDE-traffic toolbar, composing with everything, named in the
 *    "hidden by" empty state, cleared by Show all flows, and kept in the store.
 * 3. "Capture this app's requests…" on every expanded Whole Mac row: proxy address, CA path
 *    (Copy path), the Decrypt state, per-app steps, and where the traffic then shows up.
 * 4. An external source's undecrypted tunnel points at the CA step, not at "open a terminal".
 *
 * Only `./netcapIpc` / `./netmachineIpc` are mocked; stores, formatters, AppPicker are real.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import type { Tab, TabId } from "../../app/types";
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

import { NO_CA_FILE, PROXY_DOWN, STATUS_PENDING } from "./CaptureGuide";
import { flowExplanation } from "./FlowDetailPane";
import { resetMachineStore, setCaptureGuide, toggleExpanded, useMachineStore } from "./machineStore";
import { NetworkPanel } from "./NetworkPanel";
import { openDetail, resetNetworkStore, useNetworkStore } from "./networkStore";

const T0 = new Date(2026, 8, 25, 10, 0, 0).getTime();
const IDE = { pid: 733, name: "Agent Studio", path: "/Applications/Agent Studio.app/Contents/MacOS/Agent Studio" };
const POSTMAN = { pid: 8080, name: "Postman", path: "/Applications/Postman.app/Contents/MacOS/Postman" };
const CURL = { pid: 5151, name: "curl", path: "/usr/bin/curl" };

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: T0, proto: "http", method: "GET", host: "localhost", port: 47819,
    path: `/r/${id}`, status: 200, grpcStatus: null, contentType: "application/json",
    reqBytes: 0, resBytes: 11, durationMs: 12, state: "done", error: null, terminalId: null,
    httpVersion: "HTTP/1.1", wsMessages: null, client: null, note: null, ...o,
  };
}
const tunnel = (id: number, o: Partial<FlowSummary> = {}): FlowSummary =>
  flow(id, {
    proto: "tunnel", method: "CONNECT", host: "api.stripe.com", port: 443, path: "", status: null,
    contentType: null, httpVersion: "", reqBytes: 900, resBytes: 1200, ...o,
  });

const STATUS: NetcapStatus = {
  running: true, port: 51234, enabled: true, decrypt: false, caPath: "/cfg/netcap/ca.pem",
  skippedReason: null, passthroughHosts: [], flowCount: 0, decryptApps: [], portChanged: null,
};
const MAC: MachineStatus = { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true };

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
    app("Postman", 8080, { rateIn: 4000 }),
    app("Insomnia", 8081, { rateIn: 3000 }),
    app("Google Chrome", 8082, { rateIn: 2000 }),
    app("gazelle", 8083, {
      rateIn: 1000,
      connections: [
        conn({ remote: "93.184.216.34:443", remoteHost: "example.com" }),
        conn({ remote: "151.101.1.69:443", remoteHost: null }),
        conn({ proto: "tcp6", local: "[::1]:8021", remote: null, state: "Listen" }),
      ],
    }),
  ],
};

let emitSample: (s: MachineSample) => void = () => {};

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  useColumnLayoutStore.setState({ layouts: {} });
  vi.clearAllMocks();
  ipc.listenFlows.mockResolvedValue(() => {});
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

async function mount(snapshot: FlowSummary[]) {
  ipc.netcapSnapshot.mockResolvedValue(snapshot);
  const view = render(<NetworkPanel />);
  await screen.findByText(/^proxy /);
  await act(async () => {});
  return view;
}

async function mountMachine(sample: MachineSample | null = SAMPLE) {
  const view = render(<NetworkPanel />);
  await settle();
  fireEvent.click(within(screen.getByRole("group", { name: "Network mode" })).getByRole("button", { name: /Whole/ }));
  await settle();
  if (sample) act(() => emitSample(sample));
  return view;
}

const ids = () => screen.queryAllByTestId("net-row").map((r) => Number(r.getAttribute("data-flow-id")));
const rowOf = (id: number) => document.querySelector(`[data-flow-id="${id}"]`) as HTMLElement;
const cellOf = (id: number, col: string) => rowOf(id).querySelector(`td.net-c--${col}`) as HTMLElement;
const option = (label: string) =>
  screen.getAllByRole("option").find((o) => o.querySelector(".app-picker__label")?.textContent === label) as HTMLElement;
const optionTexts = () =>
  screen.getAllByRole("option").slice(1).map((o) =>
    [".app-picker__label", ".app-picker__sub", ".app-picker__count"]
      .map((sel) => o.querySelector(sel)?.textContent ?? "")
      .filter(Boolean)
      .join(" | "),
  );
const picker = (name: string) => screen.getByRole("button", { name });
const only = (pickerName: string, label: string) => {
  fireEvent.click(picker(pickerName));
  fireEvent.click(within(option(label)).getByRole("button", { name: "Only" }));
};
const appRow = (key: string) => document.querySelector(`[data-app-key="${key}"]`) as HTMLElement;
const guideBtn = () => screen.getByRole("button", { name: "Capture this app's requests…" });
const guide = () => screen.getByTestId("netm-guide");

/* ───────────────────────────── 1. source labels ───────────────────────────── */

describe("Source labels: API client, external · <name>, unattributed", () => {
  const FLOWS = [
    flow(1, { terminalId: "ide-api-client", client: IDE, path: "/health" }),
    flow(2, { terminalId: null, client: POSTMAN, path: "/from-postman" }),
    flow(3, { terminalId: null, client: null }),
    flow(4, { terminalId: "01JSHELLTERM", client: CURL }),
    flow(5, { terminalId: null, client: { ...POSTMAN, pid: 8090 } }),
  ];
  const withShell = () =>
    act(() =>
      useAppStore.setState((s) => {
        s.tabs = {
          t1: { id: "t1", kind: "terminal", title: "zsh", ref: { kind: "terminal", terminalId: "01JSHELLTERM" } },
        } as unknown as Record<TabId, Tab>;
      }),
    );

  it("the table: `API client` (with Process Agent Studio), `external · Postman` with path · pid on hover, `unattributed` only for null/null", async () => {
    withShell();
    await mount(FLOWS);
    expect(cellOf(1, "source")).toHaveTextContent("API client");
    expect(cellOf(1, "source")).toHaveClass("net-source--api-client");
    // Its own text as the title: a squeezed Source (fitColumns) ellipsizes a long name.
    expect(cellOf(1, "source")).toHaveAttribute("title", "API client");
    expect(cellOf(1, "process")).toHaveTextContent("Agent Studio");
    expect(cellOf(2, "source")).toHaveTextContent("external · Postman");
    expect(cellOf(2, "source")).toHaveClass("net-source--external");
    expect(cellOf(2, "source")).toHaveAttribute("title", "/Applications/Postman.app/Contents/MacOS/Postman · pid 8080");
    expect(cellOf(3, "source")).toHaveTextContent("unattributed");
    expect(cellOf(3, "source")).toHaveClass("net-source--unattributed");
    // A terminal-attributed flow keeps its terminal's title whatever process made it.
    expect(cellOf(4, "source")).toHaveTextContent("zsh");
    expect(cellOf(4, "source")).toHaveClass("net-source--named");
  });

  it("the Source picker: one reserved API-client row (with its sublabel), one external row per NAME (pids merge), keyed apart from terminals", async () => {
    withShell();
    await mount(FLOWS);
    fireEvent.click(picker("Filter by source"));
    expect(optionTexts()).toEqual([
      "API client | the IDE's built-in API client | 1",
      "external · Postman | /Applications/Postman.app/Contents/MacOS/Postman | 2",
      "unattributed | 1",
      "zsh | 1",
    ]);
    fireEvent.click(within(option("API client")).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([1]);
    expect(useNetworkStore.getState().sourceSelection).toEqual(["\u0000api-client"]);
    expect(picker("Filter by source")).toHaveTextContent("API client ▾");
    fireEvent.click(within(option("external · Postman")).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([2, 5]);
    expect(useNetworkStore.getState().sourceSelection).toEqual(["ext:Postman"]);
    fireEvent.click(within(option("unattributed")).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([3]);
  });

  it("the detail header carries the label too: `API client · Agent Studio (pid 733)`", async () => {
    await mount(FLOWS);
    act(() => openDetail(1));
    expect(screen.getByTestId("net-detail")).toHaveTextContent("HTTP · HTTP/1.1 · 12ms · API client · Agent Studio (pid 733)");
    act(() => openDetail(2));
    expect(screen.getByTestId("net-detail")).toHaveTextContent("· external · Postman · Postman (pid 8080)");
  });
});

/* ───────────────────────────── 2. the Host picker ───────────────────────────── */

describe("Host picker", () => {
  const FLOWS = [
    flow(1, { host: "localhost", path: "/health", client: CURL }),
    flow(2, { host: "api.anthropic.com", proto: "https", port: 443, path: "/v1/messages", client: IDE, terminalId: "ide-api-client" }),
    tunnel(3, { host: "api.anthropic.com", client: POSTMAN }),
    flow(4, { host: "localhost", proto: "grpc", path: "/pkg.Svc/M", client: CURL }),
    flow(5, { host: "ws.example.com", proto: "wss", port: 443, path: "/socket", status: 101 }),
  ];

  it("sits after Process, lists every host with its count and the protocols seen, and `Only` narrows the table", async () => {
    await mount(FLOWS);
    const pickers = [...document.querySelectorAll(".net-bar .app-picker__trigger")].map((b) => b.getAttribute("aria-label"));
    expect(pickers).toEqual(["Filter by source", "Filter by process", "Filter by host"]);
    expect(picker("Filter by host")).toHaveTextContent("All hosts ▾");
    fireEvent.click(picker("Filter by host"));
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("All hosts");
    expect(optionTexts()).toEqual([
      "api.anthropic.com | HTTPS, TUNNEL | 2",
      "localhost | HTTP, gRPC | 2",
      "ws.example.com | WSS | 1",
    ]);
    fireEvent.click(within(option("localhost")).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([1, 4]);
    expect(useNetworkStore.getState().hostSelection).toEqual(["localhost"]);
    expect(picker("Filter by host")).toHaveTextContent("localhost ▾");
    // Ticking a second host widens the pick.
    fireEvent.click(within(option("ws.example.com")).getByRole("checkbox"));
    expect(ids()).toEqual([1, 4, 5]);
    expect(picker("Filter by host")).toHaveTextContent("2 hosts ▾");
  });

  it("composes with the chips, the text filter (its `host:` token included), the Source and the Process pickers", async () => {
    await mount(FLOWS);
    only("Filter by host", "api.anthropic.com");
    expect(ids()).toEqual([2, 3]);
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(ids()).toEqual([2]);
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "host:anthropic method:connect" } });
    expect(ids()).toEqual([3]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "" } });
    only("Filter by source", "API client");
    expect(ids()).toEqual([2]);
    only("Filter by process", "Postman");
    expect(ids()).toEqual([]);
  });

  it("the empty state names the Host picker and how many it hides; Show all flows clears it with the rest", async () => {
    await mount(FLOWS);
    only("Filter by host", "ws.example.com");
    fireEvent.click(screen.getByRole("button", { name: "gRPC" }));
    expect(ids()).toEqual([]);
    const empty = screen.getByTestId("net-empty");
    expect(empty).toHaveTextContent("All 5 flows are hidden by the current filters.");
    expect(within(empty).getByTestId("net-hidden-by-host")).toHaveTextContent("Host picker (ws.example.com) hides 4");
    expect(within(empty).getByTestId("net-hidden-by-chips")).toHaveTextContent("Protocol chips (showing gRPC only) hide 4");
    expect(within(empty).queryByTestId("net-hidden-by-source")).toBeNull();
    expect(within(empty).queryByTestId("net-hidden-by-process")).toBeNull();
    fireEvent.click(within(empty).getByRole("button", { name: "Show all flows" }));
    expect(ids()).toEqual([1, 2, 3, 4, 5]);
    const s = useNetworkStore.getState();
    expect([s.filter, s.chips, s.sourceSelection, s.processSelection, s.hostSelection]).toEqual(["", [], null, null, null]);
    expect(picker("Filter by host")).toHaveTextContent("All hosts ▾");
  });

  it("no host picked at all reads 'No hosts'", async () => {
    await mount(FLOWS);
    act(() => useNetworkStore.setState({ hostSelection: [] }));
    expect(screen.getByTestId("net-hidden-by-host")).toHaveTextContent("Host picker (No hosts) hides 5");
  });

  it("the pick lives in the store, so it survives the tab remounting", async () => {
    const view = await mount(FLOWS);
    only("Filter by host", "localhost");
    view.unmount();
    await mount(FLOWS);
    expect(ids()).toEqual([1, 4]);
    expect(picker("Filter by host")).toHaveTextContent("localhost ▾");
  });
});

/* ───────────────────── 4. an external source's undecrypted connection ───────────────────── */

describe("an external app's tunnel points at the CA step and the per-app decrypt switch of the capture guide", () => {
  // jsdom is not macOS, so the machine view is named "Whole computer" (captureSteps.test pins both).
  const HINT =
    "To see Postman's HTTPS contents: turn on Decrypt HTTPS, add the IDE's CA in Postman, then switch on " +
    "“I added the IDE's certificate in Postman — decrypt its HTTPS” in the Certificate step of " +
    "\"Capture this app's requests…\" on its row in Whole computer.";

  it("a plain tunnel from Postman: the tunnel note and the disabled cURL's reason both say the CA step, not 'open a terminal'", async () => {
    await mount([tunnel(1, { client: POSTMAN }), tunnel(2, { terminalId: "t-1", client: CURL })]);
    act(() => openDetail(1));
    expect(screen.queryByTestId("net-explain")).toBeNull();
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent(
      `Encrypted tunnel: 900 B up, 1200 B down. The proxy only relays bytes. ${HINT}`,
    );
    expect(screen.getByTestId("net-tunnel-note")).not.toHaveTextContent("terminal opened afterwards");
    expect(screen.getByRole("button", { name: "Copy as cURL" })).toBeDisabled();
    expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toBe(
      `Encrypted tunnel — the proxy never saw the request. ${HINT}`,
    );
    // A terminal's tunnel keeps the terminal advice.
    act(() => openDetail(2));
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("turn on Decrypt HTTPS to see paths, headers and bodies for terminals opened afterwards.");
    expect(screen.getByTestId("net-tunnel-note")).not.toHaveTextContent("Capture this app");
    expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toBe(
      "Encrypted tunnel — the proxy never saw the request. Turn on Decrypt HTTPS, then re-run it from a terminal opened afterwards.",
    );
  });

  it("a tunnel Rust chose not to decrypt (a note): the note, then the CA step; the note alone for a terminal's process", async () => {
    const NOTE = "not decrypted: Postman doesn't read the IDE's CA";
    await mount([tunnel(1, { client: POSTMAN, note: NOTE }), tunnel(2, { terminalId: "t-1", client: CURL, note: "not decrypted: curl refused the IDE's certificate for this host earlier" })]);
    act(() => openDetail(1));
    expect(screen.getByTestId("net-explain")).toHaveTextContent(`${NOTE}. ${HINT}`);
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("without decrypting them, so it can't break the client.");
    expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toBe(`Encrypted tunnel — the proxy never saw the request (${NOTE}).`);
    act(() => openDetail(2));
    expect(screen.getByTestId("net-explain")).toHaveTextContent("not decrypted: curl refused the IDE's certificate for this host earlier");
    expect(screen.getByTestId("net-explain")).not.toHaveTextContent("Capture this app");
  });

  it("tls rejected → passthrough from Postman ends with the CA step", async () => {
    await mount([
      flow(1, { method: "CONNECT", proto: "https", host: "api.stripe.com", path: "", status: null, state: "error", error: "tls rejected → passthrough", client: POSTMAN }),
    ]);
    act(() => openDetail(1));
    expect(screen.getByTestId("net-explain")).toHaveTextContent(
      "Postman doesn't trust the IDE's certificate, so this one connection failed. " +
        `Later connections from Postman to api.stripe.com are passed through without decrypting. ${HINT}`,
    );
  });

  it("flowExplanation: an empty note is not decorated, and a non-external note is returned as is", () => {
    expect(flowExplanation(tunnel(1, { client: POSTMAN, note: "" }))).toBe("");
    expect(flowExplanation(tunnel(1, { client: POSTMAN, note: null }))).toBeNull();
    expect(flowExplanation(tunnel(1, { terminalId: "t", client: POSTMAN, note: "n" }))).toBe("n");
  });
});

/* ───────────────────────── 3. "Capture this app's requests…" ───────────────────────── */

describe("Whole Mac: Capture this app's requests…", () => {
  it("every expanded app row has the button; it opens an inline guide with the proxy address, the CA path, the Decrypt state and the outcome", async () => {
    await mountMachine();
    expect(screen.queryByRole("button", { name: "Capture this app's requests…" })).toBeNull();
    fireEvent.click(appRow("Postman:8080"));
    expect(guideBtn()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("netm-guide")).toBeNull();
    fireEvent.click(guideBtn());
    expect(guideBtn()).toHaveAttribute("aria-expanded", "true");
    expect(useMachineStore.getState().guideKey).toBe("Postman:8080");
    const g = guide();
    expect(g).toHaveAttribute("aria-label", "Capture Postman's requests");
    expect(within(g).getByTestId("netm-guide-proxy")).toHaveTextContent("127.0.0.1:51234");
    expect(within(g).getByTestId("netm-guide-ca")).toHaveTextContent("/cfg/netcap/ca.pem");
    expect(within(g).getByRole("button", { name: "Copy path" })).toBeInTheDocument();
    expect(within(g).getByTestId("netm-guide-decrypt")).toHaveTextContent(
      "Decrypt HTTPS is off (IDE traffic header) — until it is on, HTTPS shows as encrypted tunnels (host and bytes only).",
    );
    expect(within(g).getByTestId("netm-guide-outcome")).toHaveTextContent(
      "Its requests then appear under IDE traffic, Source external · Postman, Process Postman.",
    );
    // The row stays expanded: the button is not the row's toggle.
    expect(appRow("Postman:8080")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("table", { name: "Postman connections" })).toBeInTheDocument();
  });

  it("Postman's steps: Settings → Proxy with the port, Settings → Certificates with the PEM", async () => {
    await mountMachine();
    act(() => setCaptureGuide("Postman:8080"));
    const sections = screen.getAllByTestId("netm-guide-section");
    expect(sections.map((s) => s.querySelector("h4")?.textContent)).toEqual(["Proxy", "Certificate (HTTPS contents)"]);
    expect(sections[0]).toHaveTextContent("Postman → Settings → Proxy → “Add a custom proxy configuration”.");
    expect(sections[0]).toHaveTextContent("Tick both HTTP and HTTPS. Proxy server: host 127.0.0.1, port:");
    expect(sections[0].querySelector("pre")).toHaveTextContent("51234");
    expect(sections[1]).toHaveTextContent("Settings → Certificates → CA certificates → select the PEM file:");
    expect(sections[1].querySelector("pre")).toHaveTextContent("/cfg/netcap/ca.pem");
  });

  it("Insomnia: Preferences → Network and Preferences → Certificates", async () => {
    await mountMachine();
    act(() => setCaptureGuide("Insomnia:8081"));
    const sections = screen.getAllByTestId("netm-guide-section");
    expect(sections[0]).toHaveTextContent("Insomnia → Preferences → Network → Proxy: enable it.");
    expect(sections[0].querySelector("pre")).toHaveTextContent("127.0.0.1:51234");
    expect(sections[1]).toHaveTextContent("Preferences → Certificates → CA certificates → add the PEM file:");
    expect(screen.getByTestId("netm-guide-outcome")).toHaveTextContent("Source external · Insomnia, Process Insomnia.");
  });

  it("Chrome on a Mac: the open -na command, and that HTTPS stays a tunnel because Chrome trusts the Keychain", async () => {
    await mountMachine();
    act(() => setCaptureGuide("Google Chrome:8082"));
    const sections = screen.getAllByTestId("netm-guide-section");
    expect(sections[0].querySelector("pre")).toHaveTextContent('open -na "Google Chrome" --args --proxy-server=127.0.0.1:51234');
    expect(sections[1]).toHaveTextContent("Chrome trusts the macOS Keychain, not a CA file — and the IDE never writes to the Keychain.");
    expect(sections[1]).toHaveTextContent("HTTPS from Chrome stays an encrypted tunnel here (host and bytes only)");
    expect(sections[1].querySelector("pre")).toBeNull();
  });

  it("Chrome on Linux (the linux-proc backend): google-chrome and the NSS store", async () => {
    mach.netmachineStart.mockResolvedValue({ ...MAC, backend: "linux-proc" });
    await mountMachine();
    act(() => setCaptureGuide("Google Chrome:8082"));
    const sections = screen.getAllByTestId("netm-guide-section");
    expect(sections[0].querySelector("pre")).toHaveTextContent("google-chrome --proxy-server=127.0.0.1:51234");
    expect(sections[1]).toHaveTextContent("Chrome trusts its own NSS store (~/.pki/nssdb), not a CA file");
  });

  it("anything else: HTTPS_PROXY in the environment, SSL_CERT_FILE + NODE_EXTRA_CA_CERTS for the CA", async () => {
    await mountMachine();
    act(() => setCaptureGuide("gazelle:8083"));
    const sections = screen.getAllByTestId("netm-guide-section");
    expect(sections[0]).toHaveTextContent("Start gazelle from a shell with the proxy in its environment");
    expect(sections[0].querySelector("pre")).toHaveTextContent("HTTPS_PROXY=http://127.0.0.1:51234 HTTP_PROXY=http://127.0.0.1:51234");
    expect(sections[1].querySelector("pre")).toHaveTextContent("SSL_CERT_FILE=/cfg/netcap/ca-bundle.pem NODE_EXTRA_CA_CERTS=/cfg/netcap/ca.pem");
    expect(screen.getByTestId("netm-guide-outcome")).toHaveTextContent("Source external · gazelle, Process gazelle.");
  });

  it("one guide at a time: opening another app's moves it (and expands that row); Close and the button both close it", async () => {
    await mountMachine();
    act(() => setCaptureGuide("Postman:8080"));
    expect(appRow("Postman:8080")).toHaveAttribute("aria-expanded", "true");
    expect(guide()).toHaveAttribute("aria-label", "Capture Postman's requests");
    act(() => setCaptureGuide("gazelle:8083"));
    expect(screen.getAllByTestId("netm-guide")).toHaveLength(1);
    expect(guide()).toHaveAttribute("aria-label", "Capture gazelle's requests");
    expect(useMachineStore.getState().expanded).toEqual(["Postman:8080", "gazelle:8083"]);
    fireEvent.click(screen.getByRole("button", { name: "Close the capture guide" }));
    expect(screen.queryByTestId("netm-guide")).toBeNull();
    expect(useMachineStore.getState().guideKey).toBeNull();
    // The rows stay expanded; the button toggles it back on and off.
    const buttons = () => screen.getAllByRole("button", { name: "Capture this app's requests…" });
    expect(buttons()).toHaveLength(2);
    fireEvent.click(buttons()[1]);
    expect(guide()).toHaveAttribute("aria-label", "Capture gazelle's requests");
    fireEvent.click(buttons()[1]);
    expect(screen.queryByTestId("netm-guide")).toBeNull();
    // Re-opening an already-expanded row's guide does not duplicate it in `expanded`.
    act(() => setCaptureGuide("gazelle:8083"));
    expect(useMachineStore.getState().expanded).toEqual(["Postman:8080", "gazelle:8083"]);
  });

  it("collapsing the row hides its guide; expanding it again brings the same guide back (the choice is in the store)", async () => {
    const view = await mountMachine();
    act(() => setCaptureGuide("Postman:8080"));
    act(() => toggleExpanded("Postman:8080"));
    expect(screen.queryByTestId("netm-guide")).toBeNull();
    act(() => toggleExpanded("Postman:8080"));
    expect(guide()).toHaveAttribute("aria-label", "Capture Postman's requests");
    // …and a remount (tab switch) too.
    view.unmount();
    await mountMachine();
    expect(guide()).toHaveAttribute("aria-label", "Capture Postman's requests");
  });

  it("the proxy not running: says so instead of an address, and the steps carry a <port> placeholder", async () => {
    ipc.netcapStatus.mockResolvedValue({ ...STATUS, running: false, port: null });
    const view = await mountMachine();
    act(() => setCaptureGuide("Postman:8080"));
    expect(screen.getByTestId("netm-guide-proxy")).toHaveTextContent(PROXY_DOWN);
    expect(PROXY_DOWN).toMatch(/isn't running/);
    expect(screen.getAllByTestId("netm-guide-section")[0].querySelector("pre")).toHaveTextContent("<port>");
    // A port reported while `running` is false is not trusted either (the panel re-reads the
    // status on every mount).
    ipc.netcapStatus.mockResolvedValue({ ...STATUS, running: false, port: 4 });
    view.unmount();
    await mountMachine();
    expect(screen.getByTestId("netm-guide-proxy")).toHaveTextContent(PROXY_DOWN);
  });

  it("no CA file: says so and offers no Copy path; Decrypt on reads as on", async () => {
    ipc.netcapStatus.mockResolvedValue({ ...STATUS, caPath: null, decrypt: true });
    await mountMachine();
    act(() => setCaptureGuide("Postman:8080"));
    expect(screen.getByTestId("netm-guide-ca")).toHaveTextContent(NO_CA_FILE);
    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
    expect(screen.getAllByTestId("netm-guide-section")[1].querySelector("pre")).toHaveTextContent("<the IDE's CA file>");
    expect(screen.getByTestId("netm-guide-decrypt")).toHaveTextContent(
      "Decrypt HTTPS is on — with the CA trusted in the app, HTTPS paths, headers and bodies show.",
    );
  });

  it("before the proxy's status arrives, every fact says it is waiting", async () => {
    ipc.netcapStatus.mockReturnValue(new Promise(() => {}));
    await mountMachine();
    act(() => setCaptureGuide("Postman:8080"));
    for (const id of ["netm-guide-proxy", "netm-guide-ca", "netm-guide-decrypt"]) {
      expect(screen.getByTestId(id)).toHaveTextContent(STATUS_PENDING);
    }
  });

  it("Copy path writes the CA path; a refused clipboard says Copy failed; no clipboard is inert", async () => {
    const user = userEvent.setup();
    await mountMachine();
    act(() => setCaptureGuide("Postman:8080"));
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(write).toHaveBeenCalledWith("/cfg/netcap/ca.pem");
    expect(await screen.findByRole("status")).toHaveTextContent("Copied path");
    write.mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    await screen.findByText("Copy failed");
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      act(() => setCaptureGuide(null));
      act(() => setCaptureGuide("Postman:8080"));
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
      await act(async () => {});
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
    }
  });

  it("Remote (host): a bare address's hover says why it has no name; a resolved one and a listener keep theirs", async () => {
    await mountMachine();
    fireEvent.click(appRow("gazelle:8083"));
    fireEvent.click(screen.getByRole("switch", { name: "Hide listeners" }));
    const remotes = screen.getAllByTestId("netm-conn").map((r) => r.querySelector("td.netm-cc--remote"));
    expect(remotes.map((td) => td?.textContent)).toEqual(["example.com (93.184.216.34:443)", "151.101.1.69:443", "—"]);
    expect(remotes[0]).toHaveAttribute("title", "example.com (93.184.216.34:443)");
    expect(remotes[1]).toHaveAttribute("title", "151.101.1.69:443 — no reverse DNS record — CDN addresses rarely have one");
    expect(remotes[2]).toHaveAttribute("title", "—");
  });
});
