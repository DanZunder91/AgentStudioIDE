/** Only `./netcapIpc` is mocked; the store, formatters, filter and export are the real ones. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import type { AgentId, AgentNode, Tab, TabId } from "../../app/types";
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
// The Whole-computer seam is inert here (IDE traffic mode); NetworkModes.test.tsx drives it.
vi.mock("./netmachineIpc", () => ({
  netmachineStatus: () => new Promise(() => {}),
  netmachineStart: () => new Promise(() => {}),
  netmachineStop: () => new Promise(() => {}),
  listenSamples: () => new Promise(() => {}),
  NETMACHINE_SAMPLE_EVENT: "netmachine://sample",
}));

import { DECRYPT_EXPLAINER, FALLBACK_VIEWPORT, HEAD_H, NetworkPanel, ROW_H } from "./NetworkPanel";
import { resetNetworkStore, useNetworkStore } from "./networkStore";

// 20:15:46 local — the reference row's clock.
const T0 = new Date(2026, 8, 24, 20, 15, 46).getTime();

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id,
    startedMs: T0,
    proto: "https",
    method: "GET",
    host: "api.example.com",
    port: 443,
    path: `/r/${id}`,
    status: 200,
    grpcStatus: null,
    contentType: "application/json",
    reqBytes: 0,
    resBytes: 93,
    durationMs: 120,
    state: "done",
    error: null,
    terminalId: null,
    httpVersion: "HTTP/1.1",
    wsMessages: null,
    client: null,
    note: null,
    ...o,
  };
}

const STATUS: NetcapStatus = {
  running: true,
  port: 51234,
  enabled: true,
  decrypt: false,
  caPath: "/cfg/netcap/ca.pem",
  skippedReason: null,
  passthroughHosts: [],
  flowCount: 0,
  decryptApps: [],
  portChanged: null,
};

function detailOf(f: FlowSummary, o: Partial<FlowDetail> = {}): FlowDetail {
  return {
    summary: f,
    requestHeaders: [
      ["content-type", "application/json"],
      ["authorization", "Bearer sk-test-51"],
    ],
    responseHeaders: [["content-type", "application/json"]],
    responseTrailers: [],
    requestBody: { size: 12, truncated: false, text: '{"q":"hi"}', base64: null },
    responseBody: { size: 15, truncated: false, text: '{"answer":42}', base64: null },
    ...o,
  };
}

let emit: (batch: FlowSummary[]) => void = () => {};

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  vi.clearAllMocks();
  ipc.listenFlows.mockImplementation(async (h: (b: FlowSummary[]) => void) => {
    emit = h;
    return () => {};
  });
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([]);
  ipc.netcapClear.mockResolvedValue(undefined);
  ipc.netcapFlow.mockImplementation(async (id: number) => detailOf(flow(id)));
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
const cells = (id: number) => Array.from(rowOf(id).querySelectorAll("td")).map((td) => td.textContent);
const scrollBox = () => screen.getByTestId("net-scroll");
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(scrollBox(), { key: k, ...init });

describe("layout", () => {
  it("keeps the root test id and the Proxelar columns, in order, plus Source and Process", async () => {
    await mount();
    expect(screen.getByTestId("network-panel")).toBeInTheDocument();
    const heads = within(screen.getByRole("table", { name: "Network flows" }))
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(heads).toEqual(["Time", "Proto", "Method", "Host", "Path", "Status", "Type", "Size", "Duration", "Source", "Process"]);
  });

  it("empty state explains where traffic comes from and that HTTPS tunnels until Decrypt", async () => {
    await mount();
    const empty = screen.getByTestId("net-empty");
    expect(empty).toHaveTextContent(/terminals opened in the IDE/);
    expect(empty).toHaveTextContent(/HTTPS shows as encrypted tunnels.*until Decrypt HTTPS is on/);
    expect(screen.getByTestId("net-title")).toHaveTextContent("Network — 0 flows");
  });

  it("the key-hint bar lists only keys that work", async () => {
    await mount();
    expect(screen.getByTestId("net-keys").textContent).toBe(
      "j/k:navg/G:top/botEnter:openTab:req/resEsc:close/:filterc:clearp:pause",
    );
  });
});

describe("rows", () => {
  it("renders the reference row exactly, with its colour classes", async () => {
    await mount([
      flow(1, {
        method: "POST",
        host: "staging.api.acme.test",
        path: "/bookings/widgets/wgt_1/accounts",
        status: 502,
        contentType: null,
        resBytes: 11,
        durationMs: 30000,
      }),
    ]);
    expect(cells(1)).toEqual([
      "20:15:46",
      "HTTPS",
      "POST",
      "staging.api.acme.test",
      "/bookings/widgets/wgt_1/accounts",
      "502",
      "[no content]",
      "11B",
      "30.0s",
      "unattributed",
      "—",
    ]);
    const td = rowOf(1).querySelectorAll("td");
    expect(td[2]).toHaveClass("net-method--post");
    expect(td[5]).toHaveClass("net-status--5xx");
    expect(td[6]).toHaveClass("net-type--dim");
    expect(td[8]).toHaveClass("net-dur--slow");
    expect(td[9]).toHaveClass("net-source--unattributed");
    expect(screen.getByTestId("net-title")).toHaveTextContent("Network — 1 flow");
  });

  it.each([
    [200, "net-status--2xx"],
    [301, "net-status--3xx"],
    [404, "net-status--4xx"],
    [503, "net-status--5xx"],
    [101, "net-status--1xx"],
  ])("status %d → %s", async (status, cls) => {
    await mount([flow(1, { status })]);
    expect(rowOf(1).querySelectorAll("td")[5]).toHaveClass(cls);
  });

  it("method, type and duration tones", async () => {
    await mount([
      flow(1, { method: "DELETE", durationMs: 499 }),
      flow(2, { method: "PUT", durationMs: 601 }),
      flow(3, { contentType: "text/html; charset=utf-8", durationMs: 1300 }),
    ]);
    expect(rowOf(1).querySelectorAll("td")[2]).toHaveClass("net-method--delete");
    expect(rowOf(2).querySelectorAll("td")[2]).toHaveClass("net-method--get");
    expect(cells(1)[8]).toBe("499ms");
    expect(rowOf(1).querySelectorAll("td")[8]).toHaveClass("net-dur--fast");
    expect(rowOf(2).querySelectorAll("td")[8]).toHaveClass("net-dur--mid");
    expect(cells(3)[6]).toBe("text/html");
    expect(rowOf(3).querySelectorAll("td")[6]).toHaveClass("net-type--type");
    expect(rowOf(3).querySelectorAll("td")[8]).toHaveClass("net-dur--slow");
  });

  it("pending, tunnel, error, gRPC failure and WS rows", async () => {
    await mount([
      flow(1, { state: "pending", status: null, durationMs: null }),
      flow(2, { proto: "tunnel", method: "CONNECT", host: "github.com", port: 443, path: "", status: null, contentType: null, reqBytes: 1000, resBytes: 3096 }),
      flow(3, { state: "error", status: null, error: "upstream: connection refused", contentType: null }),
      flow(4, { proto: "grpc", path: "/pkg.Svc/Get", status: 200, grpcStatus: 14 }),
      flow(5, { proto: "wss", status: 101 }),
    ]);
    expect(cells(1)[5]).toBe("…");
    expect(cells(1)[8]).toBe("…");
    expect(rowOf(1).querySelectorAll("td")[8]).toHaveClass("net-dur--pending");
    // A tunnel's Status is its connection state and its Path what it saw.
    expect(cells(2).slice(1, 8)).toEqual(["TUNNEL", "CONNECT", "github.com:443", "encrypted · 1000B ↑ 3.0KB ↓", "closed", "[encrypted]", "↑1000B ↓3.0K"]);
    expect(rowOf(2).querySelectorAll("td")[5]).toHaveClass("net-status--closed");
    expect(cells(3)[6]).toBe("upstream: connection refused");
    expect(rowOf(3).querySelectorAll("td")[6]).toHaveClass("net-type--error");
    expect(cells(4)[1]).toBe("gRPC");
    expect(cells(4)[5]).toBe("200 g14");
    expect(rowOf(4).querySelectorAll("td")[5]).toHaveClass("net-status--5xx");
    expect(cells(5)[1]).toBe("WSS");
  });

  it("resolves the source to the terminal or agent title", async () => {
    useAppStore.setState((s) => {
      s.tabs = {
        t1: { id: "t1", kind: "terminal", title: "zsh", ref: { kind: "terminal", terminalId: "term-1" } },
        t2: { id: "t2", kind: "agent-terminal", title: "tab", ref: { kind: "agent-terminal", terminalId: "term-2", agentId: "a1" } },
      } as unknown as Record<TabId, Tab>;
      s.agents = { a1: { id: "a1", title: "claude — refactor", customTitle: null } } as unknown as Record<AgentId, AgentNode>;
    });
    await mount([flow(1, { terminalId: "term-1" }), flow(2, { terminalId: "term-2" }), flow(3, { terminalId: "term-zzzzzzzzz" })]);
    expect(cells(1)[9]).toBe("zsh");
    expect(rowOf(1).querySelectorAll("td")[9]).toHaveClass("net-source--named");
    expect(cells(2)[9]).toBe("claude — refactor");
    expect(cells(3)[9]).toBe("closed terminal term-zzz");
    expect(rowOf(3).querySelectorAll("td")[9]).toHaveClass("net-source--gone");
  });

  it("a live upsert updates a pending row in place", async () => {
    await mount();
    act(() => emit([flow(7, { state: "pending", status: null, durationMs: null })]));
    expect(cells(7)[5]).toBe("…");
    act(() => emit([flow(7, { status: 201, durationMs: 601 })]));
    expect(rows()).toHaveLength(1);
    expect(cells(7)[5]).toBe("201");
    expect(cells(7)[8]).toBe("601ms");
  });

  it("a failed snapshot says so", async () => {
    ipc.netcapSnapshot.mockRejectedValue(new Error("gone"));
    render(<NetworkPanel />);
    expect(await screen.findByText("Could not load earlier flows: gone")).toBeInTheDocument();
  });
});

describe("header + toggles", () => {
  it("shows the port, the note, and toggles call netcap_set with the flipped value", async () => {
    ipc.netcapSet.mockResolvedValueOnce({ ...STATUS, enabled: false });
    ipc.netcapSet.mockResolvedValueOnce({ ...STATUS, enabled: false, decrypt: true });
    await mount();
    expect(screen.getByTestId("net-port")).toHaveTextContent("proxy 127.0.0.1:51234");
    expect(screen.getByText("Applies to terminals opened after enabling.")).toBeInTheDocument();
    const capture = screen.getByRole("switch", { name: "Capture" });
    const decrypt = screen.getByRole("switch", { name: "Decrypt HTTPS" });
    expect(capture).toHaveAttribute("aria-checked", "true");
    expect(decrypt).toHaveAttribute("aria-checked", "false");
    expect(decrypt.parentElement).toHaveAttribute("title", DECRYPT_EXPLAINER);
    expect(DECRYPT_EXPLAINER).toMatch(/Only processes started in IDE terminals/);
    expect(DECRYPT_EXPLAINER).toMatch(/fails once; that host then tunnels/);

    fireEvent.click(capture);
    expect(ipc.netcapSet).toHaveBeenLastCalledWith({ enabled: false });
    expect(capture).toBeDisabled(); // in flight
    await act(async () => {});
    expect(capture).toHaveAttribute("aria-checked", "false");

    fireEvent.click(decrypt);
    expect(ipc.netcapSet).toHaveBeenLastCalledWith({ decrypt: true });
    await act(async () => {});
    expect(decrypt).toHaveAttribute("aria-checked", "true");
  });

  it("reflects what Rust returned, not what was asked", async () => {
    ipc.netcapSet.mockResolvedValue({ ...STATUS, decrypt: false });
    await mount();
    const decrypt = screen.getByRole("switch", { name: "Decrypt HTTPS" });
    fireEvent.click(decrypt);
    await act(async () => {});
    expect(decrypt).toHaveAttribute("aria-checked", "false");
  });

  it("before the status arrives, both switches are disabled and say why", () => {
    ipc.netcapStatus.mockReturnValue(new Promise(() => {}));
    render(<NetworkPanel />);
    for (const name of ["Capture", "Decrypt HTTPS"]) {
      const sw = screen.getByRole("switch", { name });
      expect(sw).toBeDisabled();
      expect(sw.parentElement).toHaveAttribute("title", "Waiting for the capture proxy's status…");
    }
  });

  it("skipped reason, passthrough hosts, not running, and a status error", async () => {
    ipc.netcapStatus.mockResolvedValue({
      ...STATUS,
      running: false,
      port: null,
      skippedReason: "HTTPS_PROXY already set in your environment",
      passthroughHosts: ["pinned.example.com", "go.dev"],
    });
    await mount();
    expect(screen.getByTestId("net-port")).toHaveTextContent("proxy not running");
    expect(screen.getByTestId("net-skipped")).toHaveTextContent("Not injected: HTTPS_PROXY already set in your environment");
    expect(screen.getByText("passthrough: 2")).toHaveAttribute("title", "pinned.example.com\ngo.dev");
    ipc.netcapSet.mockRejectedValue(new Error("prefs unwritable"));
    fireEvent.click(screen.getByRole("switch", { name: "Capture" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("prefs unwritable");
  });
});

describe("toolbar", () => {
  const three = () => [
    flow(1, { status: 200 }),
    flow(2, { status: 502, host: "gazelle.api" }),
    flow(3, { proto: "grpc", path: "/pkg.Svc/Get" }),
  ];

  it("filter narrows rows; the count stays the total; no-match says so", async () => {
    await mount(three());
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "status:5xx" } });
    expect(rows().map((r) => r.dataset.flowId)).toEqual(["2"]);
    expect(screen.getByTestId("net-title")).toHaveTextContent("Network — 3 flows");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing-here status:abc" } });
    expect(screen.getByTestId("net-empty")).toHaveTextContent("All 3 flows are hidden by the current filters.");
    expect(screen.getByTestId("net-hidden-by-text")).toHaveTextContent('Filter "nothing-here status:abc" hides 3');
    expect(screen.getByTestId("net-invalid")).toHaveTextContent("ignored: status:abc");
  });

  it("proto chips", async () => {
    await mount(three());
    const chip = screen.getByRole("button", { name: "gRPC" });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(rows().map((r) => r.dataset.flowId)).toEqual(["3"]);
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(rows()).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: "Protocols" })).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "HTTP2",
      "WS0",
      "gRPC1",
      "Tunnel0",
    ]);
  });

  it("Pause buffers updates and shows how many wait; Resume applies them", async () => {
    await mount([flow(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => emit([flow(2), flow(3)]));
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("net-waiting")).toHaveTextContent("2 updates waiting");
    act(() => emit([flow(3, { status: 500 })]));
    expect(screen.getByTestId("net-waiting")).toHaveTextContent("2 updates waiting");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(rows()).toHaveLength(3);
    expect(cells(3)[5]).toBe("500");
  });

  it("one waiting update is singular", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => emit([flow(2)]));
    expect(screen.getByTestId("net-waiting")).toHaveTextContent("1 update waiting");
  });

  it("Clear calls netcap_clear and empties the table; a failure says so", async () => {
    await mount(three());
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => {});
    expect(ipc.netcapClear).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);
    act(() => emit([flow(4)]));
    ipc.netcapClear.mockRejectedValue(new Error("busy"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clear failed: busy");
    expect(rows()).toHaveLength(1);
  });

  it("Escape / Enter in the filter hand focus back to the table", async () => {
    await mount(three());
    const input = screen.getByRole("searchbox");
    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(scrollBox()).toHaveFocus();
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(scrollBox()).toHaveFocus();
    input.focus();
    fireEvent.keyDown(input, { key: "a" });
    expect(input).toHaveFocus();
  });
});

describe("keyboard", () => {
  const selected = () => rows().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.dataset.flowId);

  it("j/k/arrows, g/G, Enter, Tab, Esc, /, c, p", async () => {
    await mount([flow(1), flow(2), flow(3)]);
    key("j");
    expect(selected()).toEqual(["1"]);
    key("j");
    key("ArrowDown");
    key("j"); // clamps at the bottom
    expect(selected()).toEqual(["3"]);
    key("k");
    expect(selected()).toEqual(["2"]);
    key("ArrowUp");
    key("k"); // clamps at the top
    expect(selected()).toEqual(["1"]);
    key("G");
    expect(selected()).toEqual(["3"]);
    key("g");
    expect(selected()).toEqual(["1"]);

    expect(key("Tab")).toBe(true); // no detail: Tab is left alone (focus moves)
    expect(key("Escape")).toBe(true);
    expect(key("Enter")).toBe(false);
    expect(screen.getByTestId("net-detail")).toBeInTheDocument();
    expect(ipc.netcapFlow).toHaveBeenCalledWith(1);
    const tab = (name: string) => screen.getByRole("tab", { name });
    expect(tab("Response")).toHaveAttribute("aria-selected", "true");
    expect(key("Tab")).toBe(false);
    expect(tab("Request")).toHaveAttribute("aria-selected", "true");
    expect(key("Tab", { shiftKey: true })).toBe(true); // shift-Tab still moves focus
    key("Escape");
    expect(screen.queryByTestId("net-detail")).toBeNull();

    key("/");
    expect(screen.getByRole("searchbox")).toHaveFocus();

    key("p");
    expect(useNetworkStore.getState().paused).toBe(true);
    key("p");
    expect(useNetworkStore.getState().paused).toBe(false);

    expect(key("c", { metaKey: true })).toBe(true); // ⌘C is the OS's, not ours
    expect(key("x")).toBe(true);
    expect(ipc.netcapClear).not.toHaveBeenCalled();
    key("c");
    await act(async () => {});
    expect(ipc.netcapClear).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);
  });

  it("k with nothing selected picks the newest; nav on an empty table is a no-op", async () => {
    await mount([flow(1), flow(2)]);
    key("k");
    expect(selected()).toEqual(["2"]);
    key("Enter");
    expect(ipc.netcapFlow).toHaveBeenCalledWith(2);
    act(() => useNetworkStore.setState({ filter: "zzz" }));
    key("j");
    key("Enter");
    expect(ipc.netcapFlow).toHaveBeenCalledTimes(1);
  });

  it("clicking a row opens its detail and focuses the table", async () => {
    await mount([flow(1), flow(2)]);
    fireEvent.click(rowOf(2));
    expect(selected()).toEqual(["2"]);
    expect(screen.getByTestId("net-detail")).toBeInTheDocument();
    expect(scrollBox()).toHaveFocus();
  });
});

describe("virtualisation + follow", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => flow(i + 1));

  it("5 000 flows put only a window of rows in the DOM", async () => {
    await mount(many(5000));
    expect(screen.getByTestId("net-title")).toHaveTextContent("Network — 5000 flows");
    const n = rows().length;
    // Floor and ceiling (a two-sided assertion): some rows, not all of them.
    expect(n).toBeGreaterThan(Math.floor((FALLBACK_VIEWPORT - HEAD_H) / ROW_H));
    expect(n).toBeLessThan(60);
  });

  it("G reveals the last row by index arithmetic; g returns to the top", async () => {
    await mount(many(5000));
    key("g");
    expect(scrollBox().scrollTop).toBe(0);
    expect(rowOf(1)).not.toBeNull();
    key("G");
    const body = FALLBACK_VIEWPORT - HEAD_H;
    expect(scrollBox().scrollTop).toBe(5000 * ROW_H - body);
    expect(rowOf(5000)).toHaveAttribute("aria-selected", "true");
    expect(rowOf(1)).toBeNull();
    key("k");
    // Still visible: no scroll.
    expect(scrollBox().scrollTop).toBe(5000 * ROW_H - body);
    key("g");
    expect(scrollBox().scrollTop).toBe(0);
    expect(rowOf(5000)).toBeNull();
  });

  it("follows the newest row, and stops once the user scrolled up", async () => {
    await mount(many(10));
    const box = scrollBox();
    let height = 10 * ROW_H + HEAD_H;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 100 });
    height = 11 * ROW_H + HEAD_H;
    act(() => emit([flow(11)]));
    expect(box.scrollTop).toBe(height);

    // User scrolls to the top: follow is off.
    box.scrollTop = 0;
    fireEvent.scroll(box);
    height = 12 * ROW_H + HEAD_H;
    act(() => emit([flow(12)]));
    expect(box.scrollTop).toBe(0);

    // Back to the bottom: follow resumes.
    box.scrollTop = height - 100;
    fireEvent.scroll(box);
    height = 13 * ROW_H + HEAD_H;
    act(() => emit([flow(13)]));
    expect(box.scrollTop).toBe(height);
  });

  it("measures the real viewport on resize", async () => {
    await mount(many(5000));
    const box = scrollBox();
    const before = rows().length;
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 2000 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(rows().length).toBeGreaterThan(before + 50);
  });
});

describe("detail pane", () => {
  async function openOn(f: FlowSummary, d?: FlowDetail) {
    if (d) ipc.netcapFlow.mockResolvedValue(d);
    await mount([f]);
    fireEvent.click(rowOf(f.id));
    await act(async () => {});
    return screen.getByTestId("net-detail");
  }
  it("has a visible Close button that closes the pane (Esc alone is not discoverable)", async () => {
    await openOn(flow(1));
    expect(screen.getByTestId("net-detail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(screen.queryByTestId("net-detail")).toBeNull();
    expect(useNetworkStore.getState().detailOpen).toBe(false);
  });


  it("Mask secrets swaps credential values for •••• on screen only — Copy as cURL keeps the real value", async () => {
    const user = userEvent.setup();
    await openOn(flow(1, { method: "POST" }));
    const write = vi.spyOn(navigator.clipboard, "writeText");
    fireEvent.click(screen.getByRole("tab", { name: "Request" }));
    const value = () => within(screen.getByRole("table", { name: "Headers" })).getByText("authorization").nextSibling;
    const toggle = screen.getByRole("button", { name: "Mask secrets" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(value()).toHaveTextContent("Bearer sk-test-51");

    fireEvent.click(toggle);
    expect(value()).toHaveTextContent("••••••••");
    expect(within(screen.getByRole("table", { name: "Headers" })).getByText("content-type").nextSibling).toHaveTextContent(
      "application/json",
    );
    expect(screen.getByRole("button", { name: "Show secrets" })).toHaveAttribute("aria-pressed", "true");
    // The choice survives switching to the Response tab and back (store-held).
    fireEvent.click(screen.getByRole("tab", { name: "Response" }));
    fireEvent.click(screen.getByRole("tab", { name: "Request" }));
    expect(value()).toHaveTextContent("••••••••");

    await user.click(screen.getByRole("button", { name: "Copy as cURL" }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("-H 'authorization: Bearer sk-test-51'"));

    fireEvent.click(screen.getByRole("button", { name: "Show secrets" }));
    expect(value()).toHaveTextContent("Bearer sk-test-51");
  });

  it("request: headers (verbatim, credentials included) and a JSON body; response: status, headers, JSON", async () => {
    const pane = await openOn(flow(1, { method: "POST", terminalId: null }));
    expect(pane).toHaveTextContent("POST https://api.example.com/r/1");
    expect(pane).toHaveTextContent("HTTPS · HTTP/1.1 · 120ms · unattributed");
    fireEvent.click(screen.getByRole("tab", { name: "Request" }));
    const headers = screen.getByRole("table", { name: "Headers" });
    expect(within(headers).getByText("authorization").nextSibling).toHaveTextContent("Bearer sk-test-51");
    expect(within(pane).getByTestId("json-view")).toHaveTextContent('q: "hi"');
    fireEvent.click(screen.getByRole("tab", { name: "Response" }));
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 200");
    expect(within(pane).getByTestId("json-view")).toHaveTextContent("42");
  });

  it("text, binary, truncated and missing bodies", async () => {
    await openOn(
      flow(1),
      detailOf(flow(1), {
        requestBody: null,
        responseBody: { size: 2_500_000, truncated: true, text: "<html>hi", base64: null },
      }),
    );
    expect(screen.getByTestId("net-truncated")).toHaveTextContent("Truncated at the 1 MiB capture limit (2500000 bytes on the wire).");
    expect(screen.getByText("<html>hi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Request" }));
    expect(screen.getByText("No body")).toBeInTheDocument();

    // Drop the cache so the next open refetches the second shape.
    act(() => useNetworkStore.setState({ detail: null }));
    ipc.netcapFlow.mockResolvedValue(
      detailOf(flow(1), {
        requestBody: { size: 7, truncated: false, text: "{broken", base64: null },
        responseBody: { size: 1234, truncated: false, text: null, base64: "AAEC" },
        requestHeaders: [],
      }),
    );
    fireEvent.click(rowOf(1));
    await act(async () => {});
    expect(screen.getByText("{broken")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Response" }));
    expect(screen.getByText("binary, 1234 bytes")).toBeInTheDocument();
  });

  it("an empty or uncaptured body reads 'No body'; a named source shows in the header", async () => {
    useAppStore.setState((s) => {
      s.tabs = {
        t1: { id: "t1", kind: "terminal", title: "zsh", ref: { kind: "terminal", terminalId: "term-1" } },
      } as unknown as Record<TabId, Tab>;
    });
    await openOn(
      flow(1, { terminalId: "term-1" }),
      detailOf(flow(1), {
        requestBody: { size: 0, truncated: false, text: "", base64: null },
        responseBody: { size: 0, truncated: false, text: null, base64: null },
      }),
    );
    expect(screen.getByTestId("net-detail")).toHaveTextContent("120ms · zsh");
    expect(screen.getByText("No body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Request" }));
    expect(screen.getByText("No body")).toBeInTheDocument();
  });

  it("gRPC: grpc-status and trailers; WS: message counts", async () => {
    await openOn(
      flow(1, { proto: "grpc", path: "/pkg.Svc/Get", grpcStatus: 14, httpVersion: "HTTP/2" }),
      detailOf(flow(1), { responseTrailers: [["grpc-status", "14"], ["grpc-message", "unavailable"]], responseBody: null }),
    );
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 200 · grpc-status 14");
    expect(within(screen.getByRole("table", { name: "Trailers" })).getByText("unavailable")).toBeInTheDocument();
  });

  it("WS message counts", async () => {
    await openOn(flow(1, { proto: "wss", status: 101, wsMessages: { up: 3, down: 17 } }));
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 101 · messages ↑3 ↓17");
  });

  it("an error row shows its error; a pending one shows 'pending' and No response", async () => {
    await openOn(flow(1, { state: "error", status: null, durationMs: null, error: "tls rejected → passthrough" }));
    expect(within(screen.getByTestId("net-detail")).getByRole("alert")).toHaveTextContent("tls rejected → passthrough");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("· pending");
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("No response");
  });

  it("a tunnel explains itself and both exports are disabled with the reason on the wrapper", async () => {
    await openOn(flow(1, { proto: "tunnel", method: "CONNECT", host: "github.com", path: "", status: null, reqBytes: 10, resBytes: 20, httpVersion: "" }));
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("Encrypted tunnel: 10 B up, 20 B down.");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("CONNECT github.com:443");
    expect(screen.queryByRole("tab")).toBeNull();
    for (const [name, wrap] of [["Copy as cURL", "net-curl-wrap"], ["Open in API client", "net-api-wrap"]]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByTestId(wrap).getAttribute("title")).toMatch(/Encrypted tunnel.*Decrypt HTTPS/);
    }
  });

  it("loading and a failed fetch", async () => {
    let fail: (e: unknown) => void = () => {};
    ipc.netcapFlow.mockReturnValue(new Promise((_r, j) => (fail = j)));
    await mount([flow(1)]);
    fireEvent.click(rowOf(1));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as cURL" })).toBeDisabled();
    expect(screen.getByTestId("net-curl-wrap")).toHaveAttribute("title", "Loading the captured request…");
    await act(async () => fail(new Error("not-found")));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this flow: not-found");
  });

  it("refetches when the selected pending flow completes", async () => {
    await openOn(flow(1, { state: "pending", status: null, durationMs: null }));
    expect(ipc.netcapFlow).toHaveBeenCalledTimes(1);
    await act(async () => emit([flow(1)]));
    expect(ipc.netcapFlow).toHaveBeenCalledTimes(2);
  });

  it("a selection with no row says 'Select a flow.'", async () => {
    await openOn(flow(1));
    act(() => useNetworkStore.setState({ selectedId: 99 }));
    expect(screen.getByText("Select a flow.")).toBeInTheDocument();
  });

  it("Copy as cURL writes the exact command, credentials included", async () => {
    const user = userEvent.setup();
    await openOn(flow(1, { method: "POST" }));
    // After setup: `userEvent.setup()` installs its own `navigator.clipboard`.
    const write = vi.spyOn(navigator.clipboard, "writeText");
    const wrap = screen.getByTestId("net-curl-wrap");
    expect(wrap.getAttribute("title")).toBe("Copy this request as a cURL command.");
    await user.click(screen.getByRole("button", { name: "Copy as cURL" }));
    expect(write).toHaveBeenCalledWith(
      `curl -X POST 'https://api.example.com/r/1' -H 'content-type: application/json' -H 'authorization: Bearer sk-test-51' --data '{"q":"hi"}'`,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });

  it("a refused clipboard says Copy failed", async () => {
    const user = userEvent.setup();
    await openOn(flow(1));
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy as cURL" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Copy failed");
  });

  it("no clipboard at all: the click is inert", async () => {
    await openOn(flow(1));
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Copy as cURL" }));
      await act(async () => {});
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("Open in API client seeds a new request (method/url/headers/body, credentials included) and opens its tab", async () => {
    await openOn(flow(1, { method: "POST" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in API client" }));
    const s = useAppStore.getState();
    const tab = Object.values(s.tabs).find((t) => t.ref.kind === "api-request");
    expect(tab).toBeDefined();
    const rid = (tab?.ref as { requestId: string }).requestId;
    const req = s.apiRequests[rid];
    expect(req).toMatchObject({ method: "POST", url: "https://api.example.com/r/1", body: '{"q":"hi"}' });
    expect(req.headers.map((h) => [h.name, h.value])).toEqual([
      ["content-type", "application/json"],
      ["authorization", "Bearer sk-test-51"],
    ]);
    expect(screen.getByTestId("net-api-wrap").getAttribute("title")).toBe("Open this request in a new API client tab (not sent).");
  });
});
