/** Only `./netcapIpc` / `./netmachineIpc` are mocked; stores, formatters, AppPicker are real.
 * The Source picker is keyed by terminal id because agent terminals retitle themselves. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import type { AgentId, AgentNode, Tab, TabId } from "../../app/types";
import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import type { FlowDetail, FlowSummary, NetcapStatus } from "./networkTypes";

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

import { resetMachineStore } from "./machineStore";
import { formatTime } from "./networkFormat";
import { NetworkPanel } from "./NetworkPanel";
import { openDetail, resetNetworkStore, setDetailTab, useNetworkStore } from "./networkStore";

const T0 = new Date(2026, 0, 1, 12, 0, 0).getTime();
const GAZELLE = { pid: 4242, name: "gazelle", path: "/work/gazelle/target/debug/gazelle" };
const NODE = { pid: 777, name: "node", path: "/usr/local/bin/node" };

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: T0, proto: "http", method: "GET", host: "localhost", port: 8080,
    path: `/r/${id}`, status: 200, grpcStatus: null, contentType: "application/json",
    reqBytes: 0, resBytes: 11, durationMs: 12, state: "done", error: null, terminalId: null,
    httpVersion: "HTTP/1.1", wsMessages: null, client: null, note: null, ...o,
  };
}

const STATUS: NetcapStatus = {
  running: true, port: 51234, enabled: true, decrypt: true, caPath: "/cfg/netcap/ca.pem",
  skippedReason: null, passthroughHosts: [], flowCount: 0, decryptApps: [], portChanged: null,
};

const emptyDetail = (f: FlowSummary): FlowDetail => ({
  summary: f, requestHeaders: [], responseHeaders: [], responseTrailers: [], requestBody: null, responseBody: null,
});

let details: Record<number, FlowDetail> = {};

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  useColumnLayoutStore.setState({ layouts: {} });
  vi.clearAllMocks();
  details = {};
  ipc.listenFlows.mockResolvedValue(() => {});
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([]);
  ipc.netcapFlow.mockImplementation(async (id: number) => details[id] ?? emptyDetail(flow(id)));
  mach.netmachineStatus.mockReturnValue(new Promise(() => {}));
  mach.netmachineStart.mockReturnValue(new Promise(() => {}));
  mach.netmachineStop.mockResolvedValue(undefined);
  mach.listenSamples.mockReturnValue(new Promise(() => {}));
});
afterEach(() => resetNetworkStore());

async function mount(snapshot: FlowSummary[]) {
  ipc.netcapSnapshot.mockResolvedValue(snapshot);
  const view = render(<NetworkPanel />);
  await screen.findByText(/^proxy /);
  await act(async () => {});
  return view;
}

const ids = () => screen.queryAllByTestId("net-row").map((r) => Number(r.getAttribute("data-flow-id")));
const option = (label: string) =>
  screen.getAllByRole("option").find((o) => o.querySelector(".app-picker__label")?.textContent === label) as HTMLElement;
const optionTexts = () =>
  screen.getAllByRole("option").slice(1).map((o) =>
    [".app-picker__label", ".app-picker__sub", ".app-picker__count"]
      .map((sel) => o.querySelector(sel)?.textContent ?? "")
      .filter(Boolean)
      .join(" | "),
  );

/* ───────────────────────────── 1. the Process picker ───────────────────────────── */

describe("IDE traffic: the Process picker (client.name)", () => {
  const FLOWS = [
    flow(1, { client: GAZELLE, path: "/health" }),
    flow(2, { client: NODE, host: "api.example.com", proto: "https", port: 443 }),
    flow(3, { client: null }),
    flow(4, { client: { ...GAZELLE, pid: 4243 }, path: "/ready" }),
  ];

  it("offers every process name with its count (pids merge, 'unknown' for null) beside the Source picker", async () => {
    await mount(FLOWS);
    const trigger = screen.getByRole("button", { name: "Filter by process" });
    expect(trigger).toHaveTextContent("All processes ▾");
    // Next to the Source picker, in the toolbar (the Host picker comes after it).
    const pickers = [...document.querySelectorAll(".net-bar .app-picker__trigger")].map((b) => b.getAttribute("aria-label"));
    expect(pickers).toEqual(["Filter by source", "Filter by process", "Filter by host"]);
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("All processes");
    expect(optionTexts()).toEqual([
      "gazelle | /work/gazelle/target/debug/gazelle | 2",
      "node | /usr/local/bin/node | 1",
      "unknown | 1",
    ]);
  });

  it("'only gazelle' is one click, and it composes with the text filter", async () => {
    await mount(FLOWS);
    fireEvent.click(screen.getByRole("button", { name: "Filter by process" }));
    fireEvent.click(within(option("gazelle")).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([1, 4]);
    expect(screen.getByRole("button", { name: "Filter by process" })).toHaveTextContent("gazelle ▾");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "health" } });
    expect(ids()).toEqual([1]);
    // unknown alone: the null-client flow only.
    fireEvent.click(within(option("unknown")).getByRole("button", { name: "Only" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "" } });
    expect(ids()).toEqual([3]);
  });

  it("the empty state names the Process picker and how many it hides; Show all brings every flow back", async () => {
    await mount(FLOWS);
    fireEvent.click(screen.getByRole("button", { name: "Filter by process" }));
    fireEvent.click(within(option("node")).getByRole("button", { name: "Only" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "health" } });
    expect(ids()).toEqual([]);
    const empty = screen.getByTestId("net-empty");
    expect(empty).toHaveTextContent("All 4 flows are hidden by the current filters.");
    expect(within(empty).getByTestId("net-hidden-by-process")).toHaveTextContent("Process picker (node) hides 3");
    expect(within(empty).getByTestId("net-hidden-by-text")).toHaveTextContent('Filter "health" hides 3');
    expect(within(empty).queryByTestId("net-hidden-by-source")).toBeNull();
    fireEvent.click(within(empty).getByRole("button", { name: "Show all flows" }));
    expect(ids()).toEqual([1, 2, 3, 4]);
    expect(useNetworkStore.getState().processSelection).toBeNull();
    expect(screen.getByRole("button", { name: "Filter by process" })).toHaveTextContent("All processes ▾");
  });

  it("no process picked from the list at all: the explanation says 'No processes'", async () => {
    await mount(FLOWS);
    act(() => useNetworkStore.setState({ processSelection: [] }));
    expect(screen.getByTestId("net-hidden-by-process")).toHaveTextContent("Process picker (No processes) hides 4");
  });
});

/* ───────────────────────── 2. Source picker keyed by terminal id ───────────────────────── */

describe("IDE traffic: the Source picker is keyed by terminal id, not title", () => {
  const setFleet = (title: string, second = "zsh") =>
    act(() =>
      useAppStore.setState((s) => {
        s.tabs = {
          t1: { id: "t1", kind: "agent-terminal", title: "tab", ref: { kind: "agent-terminal", terminalId: "01JAGENTTERM1", agentId: "a1" } },
          t2: { id: "t2", kind: "terminal", title: second, ref: { kind: "terminal", terminalId: "01JSHELLTERM2" } },
          t3: { id: "t3", kind: "terminal", title: second, ref: { kind: "terminal", terminalId: "01JSHELLTERM3" } },
        } as unknown as Record<TabId, Tab>;
        s.agents = { a1: { id: "a1", title, customTitle: null } } as unknown as Record<AgentId, AgentNode>;
      }),
    );
  const FLOWS = [
    flow(1, { terminalId: "01JAGENTTERM1" }),
    flow(2, { terminalId: "01JSHELLTERM2" }),
    flow(3, { terminalId: "01JSHELLTERM3" }),
    flow(4, { terminalId: "01JAGENTTERM1" }),
  ];

  it("an 'Only' pick keeps matching after the agent's title changes (it used to hide everything)", async () => {
    setFleet("claude");
    await mount(FLOWS);
    fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
    fireEvent.click(within(option("claude")).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([1, 4]);
    setFleet("claude · fixing the build");
    expect(ids()).toEqual([1, 4]);
    // The trigger and the row follow the NEW title.
    expect(screen.getByRole("button", { name: "Filter by source" })).toHaveTextContent("claude · fixing the build ▾");
    expect(useNetworkStore.getState().sourceSelection).toEqual(["t:01JAGENTTERM1"]);
  });

  it("two terminals with the same title are two rows, told apart by a short id", async () => {
    setFleet("claude");
    await mount(FLOWS);
    fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
    expect(optionTexts()).toEqual(["claude | 2", "zsh | #01JSHELL | 1", "zsh | #01JSHELL | 1"]);
    const zshRows = screen.getAllByRole("option").filter((o) => o.textContent?.startsWith("zsh"));
    fireEvent.click(within(zshRows[1]).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([3]);
  });

  it("the unattributed row is its own key, whatever a terminal is titled", async () => {
    setFleet("claude", "unattributed");
    await mount([...FLOWS, flow(5, { terminalId: null })]);
    fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
    const un = screen.getAllByRole("option").filter((o) => o.textContent?.startsWith("unattributed"));
    // two same-titled terminals + the real unattributed row
    expect(un).toHaveLength(3);
    const real = un.find((o) => o.querySelector(".app-picker__sub") === null) as HTMLElement;
    fireEvent.click(within(real).getByRole("button", { name: "Only" }));
    expect(ids()).toEqual([5]);
  });
});

/* ──────────────────────────── 3. see and copy the request ──────────────────────────── */

const LOCAL = flow(9, { method: "POST", path: "/health", client: GAZELLE, reqBytes: 12, resBytes: 11 });
const LOCAL_DETAIL: FlowDetail = {
  summary: LOCAL,
  requestHeaders: [
    ["host", "localhost:8080"],
    ["content-type", "application/json"],
    ["authorization", "Bearer sk-test-51"],
    ["proxy-authorization", "Basic dC0xOng="],
  ],
  responseHeaders: [["content-type", "application/json"], ["x-req-id", "r-1"]],
  responseTrailers: [],
  requestBody: { size: 12, truncated: false, text: '{"deep":true}', base64: null },
  responseBody: { size: 11, truncated: false, text: '{"ok":true}', base64: null },
};

async function openOn(f: FlowSummary, d?: FlowDetail, others: FlowSummary[] = []) {
  if (d) details[f.id] = d;
  await mount([...others, f]);
  act(() => openDetail(f.id));
  await act(async () => {});
}

describe("the detail shows the whole request and response, and copies them", () => {
  it("Request tab: request line, headers and body; Response tab: status, headers, body", async () => {
    await openOn(LOCAL, LOCAL_DETAIL);
    act(() => setDetailTab("request"));
    const panel = () => screen.getByRole("tabpanel");
    expect(screen.getByTestId("net-request-line")).toHaveTextContent("POST /health HTTP/1.1");
    const req = within(screen.getByRole("table", { name: "Headers" }));
    expect(req.getByRole("rowheader", { name: "authorization" }).nextSibling).toHaveTextContent("Bearer sk-test-51");
    expect(panel()).toHaveTextContent("deep");
    act(() => setDetailTab("response"));
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 200");
    expect(within(screen.getByRole("table", { name: "Headers" })).getByRole("rowheader", { name: "x-req-id" })).toBeInTheDocument();
    expect(panel()).toHaveTextContent("ok");
  });

  it("a localhost call offers Copy as cURL (it is enabled and exact)", async () => {
    const user = userEvent.setup();
    await openOn(LOCAL, LOCAL_DETAIL);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    const curl = screen.getByRole("button", { name: "Copy as cURL" });
    expect(curl).toBeEnabled();
    await user.click(curl);
    expect(write).toHaveBeenCalledWith(
      `curl -X POST 'http://localhost:8080/health' -H 'content-type: application/json' -H 'authorization: Bearer sk-test-51' --data '{"deep":true}'`,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Copied cURL");
  });

  it("Copy request writes the raw HTTP request, exactly", async () => {
    const user = userEvent.setup();
    await openOn(LOCAL, LOCAL_DETAIL);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    expect(screen.getByTestId("net-copyreq-wrap").getAttribute("title")).toBe(
      "Copy the request as raw HTTP: request line, headers and body, exactly as captured.",
    );
    await user.click(screen.getByRole("button", { name: "Copy request" }));
    expect(write).toHaveBeenCalledWith(
      'POST /health HTTP/1.1\nhost: localhost:8080\ncontent-type: application/json\nauthorization: Bearer sk-test-51\n\n{"deep":true}',
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Copied request");
  });

  it("Copy response writes status line + headers + body; Copy body writes the body alone", async () => {
    const user = userEvent.setup();
    await openOn(LOCAL, LOCAL_DETAIL);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy response" }));
    expect(write).toHaveBeenLastCalledWith('HTTP/1.1 200\ncontent-type: application/json\nx-req-id: r-1\n\n{"ok":true}');
    expect(await screen.findByRole("status")).toHaveTextContent("Copied response");
    expect(screen.getByTestId("net-copybody-wrap").getAttribute("title")).toBe("Copy only the response body.");
    await user.click(screen.getByRole("button", { name: "Copy body" }));
    expect(write).toHaveBeenLastCalledWith('{"ok":true}');
    expect(await screen.findByRole("status")).toHaveTextContent("Copied body");
  });

  it("a gRPC call (binary bodies): cURL refused, but request and response still copy", async () => {
    const g = flow(12, { proto: "grpc", method: "POST", path: "/pkg.Svc/Get", httpVersion: "HTTP/2", grpcStatus: 0 });
    await openOn(g, {
      ...emptyDetail(g),
      requestHeaders: [[":authority", "localhost:50051"], ["content-type", "application/grpc"]],
      responseHeaders: [["content-type", "application/grpc"]],
      responseTrailers: [["grpc-status", "0"]],
      requestBody: { size: 7, truncated: false, text: null, base64: "AAAAAAIKAA==" },
      responseBody: { size: 5, truncated: false, text: null, base64: "AAAAAAA=" },
    });
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    expect(screen.getByRole("button", { name: "Copy as cURL" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Copy request" }));
    expect(write).toHaveBeenLastCalledWith(
      "POST /pkg.Svc/Get HTTP/2\nHost: localhost:8080\ncontent-type: application/grpc\n\n[binary body, 7 bytes]",
    );
    // No text body → Copy body is disabled and says why.
    expect(screen.getByRole("button", { name: "Copy body" })).toBeDisabled();
    expect(screen.getByTestId("net-copybody-wrap").getAttribute("title")).toBe("The response has no text body to copy.");
  });

  it("a pending flow: the request copies, the response waits — and says so", async () => {
    const p = flow(13, { state: "pending", status: null, durationMs: null });
    await openOn(p, { ...emptyDetail(p), requestHeaders: [["host", "localhost:8080"]] });
    expect(screen.getByRole("button", { name: "Copy request" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy response" })).toBeDisabled();
    expect(screen.getByTestId("net-copyres-wrap").getAttribute("title")).toBe("Waiting for the response…");
    expect(screen.getByTestId("net-copybody-wrap").getAttribute("title")).toBe("Waiting for the response…");
  });

  it("an error before any response: 'No response was captured.'", async () => {
    const e = flow(14, { state: "error", status: null, error: "upstream: connection refused" });
    await openOn(e);
    expect(screen.getByRole("button", { name: "Copy response" })).toBeDisabled();
    expect(screen.getByTestId("net-copyres-wrap").getAttribute("title")).toBe("No response was captured.");
  });

  it("while the detail loads, every copy says it is loading", async () => {
    ipc.netcapFlow.mockReturnValue(new Promise(() => {}));
    await openOn(LOCAL);
    for (const id of ["net-copyreq-wrap", "net-copyres-wrap", "net-copybody-wrap"]) {
      expect(screen.getByTestId(id).getAttribute("title")).toBe("Loading the captured request…");
    }
    expect(screen.getByRole("button", { name: "Copy request" })).toBeDisabled();
  });

  it("a refused clipboard on Copy request says Copy failed; no clipboard is inert", async () => {
    const user = userEvent.setup();
    await openOn(LOCAL, LOCAL_DETAIL);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy request" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Copy failed");
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
      await act(async () => {});
      expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
    }
  });
});

describe("a flow with no request to show is never an empty pane", () => {
  it("a not-decrypted tunnel: the note, and host, port, bytes, duration, process", async () => {
    const t = flow(20, {
      proto: "tunnel", method: "CONNECT", host: "api.example.org", port: 443, path: "", status: null,
      contentType: null, httpVersion: "", reqBytes: 2048, resBytes: 6144, durationMs: 1300,
      client: GAZELLE, note: "not decrypted: gazelle doesn't read the IDE's CA",
    });
    await openOn(t);
    expect(screen.getByTestId("net-explain")).toHaveTextContent("not decrypted: gazelle doesn't read the IDE's CA");
    const facts = screen.getByTestId("net-facts");
    expect([...facts.querySelectorAll(".net-facts__row")].map((r) => r.textContent)).toEqual([
      "Hostapi.example.org",
      "Port443",
      `Opened${formatTime(T0)}`,
      `Closed${formatTime(T0 + 1300)}`,
      "Duration1.3s",
      "Sent2.0KB (2048 B)",
      "Received6.0KB (6144 B)",
      "Processgazelle (pid 4242) · /work/gazelle/target/debug/gazelle",
      expect.stringMatching(/^Source/),
    ]);
    // No tabs, and every copy says why it cannot.
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy request" })).toBeDisabled();
    expect(screen.getByTestId("net-copyreq-wrap").getAttribute("title")).toBe(
      "Encrypted tunnel — the proxy never saw the request (not decrypted: gazelle doesn't read the IDE's CA).",
    );
  });

  it("a tunnel still open with an unknown process says so", async () => {
    const t = flow(21, {
      proto: "tunnel", method: "CONNECT", host: "x.test", port: 8443, path: "", status: null, contentType: null,
      httpVersion: "", durationMs: null, state: "pending", client: null,
    });
    await openOn(t);
    const text = screen.getByTestId("net-facts").textContent;
    expect(text).toContain("Durationstill open");
    expect(text).toContain("Processunknown — the proxy could not tell which process opened it");
  });

  it("a process with no readable path shows name and pid only", async () => {
    const t = flow(22, {
      proto: "tunnel", method: "CONNECT", host: "x.test", port: 443, path: "", status: null, contentType: null,
      httpVersion: "", client: { pid: 9, name: "svc", path: null },
    });
    await openOn(t);
    expect(screen.getByTestId("net-facts")).toHaveTextContent("Processsvc (pid 9)");
  });

  it("a handshake that never became a request: says so, plus what is known — no empty Request/Response tabs", async () => {
    const c = flow(23, {
      proto: "https", method: "CONNECT", host: "localhost", port: 8443, path: "", status: null, contentType: null,
      state: "error", error: "tls rejected → passthrough", client: { pid: 5151, name: "curl", path: "/usr/bin/curl" },
    });
    await openOn(c);
    expect(screen.getByTestId("net-no-request")).toHaveTextContent("No request was sent on this connection");
    expect(screen.getByTestId("net-facts")).toHaveTextContent("Processcurl (pid 5151) · /usr/bin/curl");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByTestId("net-copyres-wrap").getAttribute("title")).toBe(
      "Nothing to replay — curl refused the IDE's certificate before sending a request.",
    );
  });
});
