/**
 * The case, on `12:00:00 TUNNEL CONNECT geo.api.example.net:443 —`: the call was listed but looked
 * unfinished and showed nothing about what it was doing.
 *
 * A Rust app on reqwest + rustls with bundled webpki roots cannot trust the IDE's CA, so the proxy
 * tunnels it (a MITM that guesses wrong breaks the program) — correct, but the row and the pane
 * must SAY so:
 *   1. the row: Status `open` (pulsing) / `closed`, never `—`; Size ↑/↓; Path `encrypted · n ↑ m ↓`;
 *   2. the pane: a card — why, what is known, repeated connections grouped, three ways to see more
 *      (Decrypt this app, the Rust native-roots line, Logs);
 *   3. a closed terminal is named by its last title (`gazelle (closed)`), not `closed terminal 0000eeee`;
 *   4. a `bypass` row (an agent command that skipped the proxy) and the strict-capture switch.
 *
 * Only `./netcapIpc` / `./netmachineIpc` are mocked; stores, formatters and cards are real.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import type { Tab, TabId } from "../../app/types";
import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import type { FlowSummary, NetcapStatus } from "./networkTypes";

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

import { resetMachineStore } from "./machineStore";
import { formatTime } from "./networkFormat";
import { NetworkButton } from "./NetworkButton";
import { NetworkPanel } from "./NetworkPanel";
import { openDetail, resetNetworkStore, useNetworkStore } from "./networkStore";
import { rememberTitles, watchTerminalTitles } from "./terminalTitles";
import { BYPASS_EXPLAINER, RUSTLS_NATIVE_ROOTS_LINE, STRICT_CAPTURE_LABEL, STRICT_CAPTURE_UNAVAILABLE } from "./tunnelExplain";

const T0 = new Date(2026, 0, 1, 12, 0, 0).getTime();
const TERM = "0000eeee-0000-4000-8000-000000000001";
const GAZELLE = { pid: 4242, name: "gazelle", path: "/Users/dev/gazelle/target/debug/gazelle" };
const NOTE = "not decrypted: gazelle doesn't read the IDE's CA";

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: T0, proto: "tunnel", method: "CONNECT", host: "geo.api.example.net", port: 443, path: "",
    status: null, grpcStatus: null, contentType: null, reqBytes: 2048, resBytes: 5120, durationMs: 30_000,
    state: "done", error: null, terminalId: TERM, httpVersion: "", wsMessages: null, client: GAZELLE, note: NOTE, ...o,
  };
}

const STATUS: NetcapStatus = {
  running: true, port: 51234, enabled: true, decrypt: true, caPath: "/cfg/netcap/ca.pem",
  skippedReason: null, passthroughHosts: [], flowCount: 0, decryptApps: [], portChanged: null,
};

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  useColumnLayoutStore.setState({ layouts: {} });
  vi.clearAllMocks();
  ipc.listenFlows.mockResolvedValue(() => {});
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([]);
  ipc.netcapFlow.mockImplementation(async (id: number) => ({
    summary: flow(id), requestHeaders: [], responseHeaders: [], responseTrailers: [], requestBody: null, responseBody: null,
  }));
  mach.netmachineStatus.mockReturnValue(new Promise(() => {}));
  mach.netmachineStart.mockReturnValue(new Promise(() => {}));
  mach.netmachineStop.mockResolvedValue(undefined);
  mach.listenSamples.mockReturnValue(new Promise(() => {}));
});
afterEach(() => resetNetworkStore());

async function mount(snapshot: FlowSummary[], status: NetcapStatus = STATUS) {
  ipc.netcapStatus.mockResolvedValue(status);
  ipc.netcapSnapshot.mockResolvedValue(snapshot);
  const view = render(<NetworkPanel />);
  await screen.findByText(/^proxy /);
  await act(async () => {});
  return view;
}

async function openOn(snapshot: FlowSummary[], id: number, status: NetcapStatus = STATUS) {
  await mount(snapshot, status);
  act(() => openDetail(id));
  await act(async () => {});
}

const rowOf = (id: number) => document.querySelector(`[data-flow-id="${id}"]`) as HTMLElement;
const cell = (id: number, col: string) => rowOf(id).querySelector(`.net-c--${col}`) as HTMLElement;
const facts = () =>
  Object.fromEntries(
    [...screen.getByTestId("net-facts").querySelectorAll(".net-facts__row")].map((r) => [
      r.querySelector("dt")!.textContent,
      r.querySelector("dd")!.textContent,
    ]),
  );

const openTerminal = (title: string) =>
  act(() =>
    useAppStore.setState((s) => {
      s.tabs = { t1: { id: "t1", kind: "terminal", title, ref: { kind: "terminal", terminalId: TERM } } } as unknown as Record<TabId, Tab>;
    }),
  );
const closeTerminal = () => act(() => useAppStore.setState((s) => void (s.tabs = {} as Record<TabId, Tab>)));

describe("a tunnel row says what it is — never a bare —", () => {
  it("closed: Status closed, Size ↑/↓, Path encrypted · n ↑ m ↓", async () => {
    await mount([flow(1)]);
    expect(cell(1, "status")).toHaveTextContent(/^closed$/);
    expect(cell(1, "status")).toHaveClass("net-status--closed");
    expect(cell(1, "size")).toHaveTextContent("↑2.0K ↓5.0K");
    expect(cell(1, "path")).toHaveTextContent("encrypted · 2.0KB ↑ 5.0KB ↓");
    expect(cell(1, "path")).toHaveAttribute("title", "encrypted · 2.0KB ↑ 5.0KB ↓");
  });

  it("open (still pending): Status open, with the pulse class", async () => {
    await mount([flow(1, { state: "pending", durationMs: null })]);
    expect(cell(1, "status")).toHaveTextContent(/^open$/);
    expect(cell(1, "status")).toHaveClass("net-status--open");
  });
});

describe("the tunnel card", () => {
  it("gazelle → geo.api.example.net: the title, why (rustls), what is known, and the head says closed", async () => {
    await openOn([flow(1)], 1);
    const card = screen.getByTestId("net-tunnel-card");
    expect(within(card).getByRole("heading", { level: 4 })).toHaveTextContent("Encrypted tunnel — contents not visible");
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("Encrypted tunnel: 2048 B up, 5120 B down.");
    expect(screen.getByTestId("net-tunnel-why")).toHaveTextContent("gazelle isn't on the decrypt list");
    expect(screen.getByTestId("net-tunnel-why")).toHaveTextContent("fail with UnknownIssuer");
    expect(facts()).toEqual({
      Host: "geo.api.example.net",
      Port: "443",
      Opened: formatTime(T0),
      Closed: formatTime(T0 + 30_000),
      Duration: "30.0s",
      Sent: "2.0KB (2048 B)",
      Received: "5.0KB (5120 B)",
      Process: "gazelle (pid 4242) · /Users/dev/gazelle/target/debug/gazelle",
      Source: "closed terminal 0000eeee",
    });
    expect(screen.getByTestId("net-detail")).toHaveTextContent("TUNNEL · 30.0s · connection closed");
    // One connection: nothing to group.
    expect(screen.queryByTestId("net-tunnel-group")).toBeNull();
    // The three ways, in order.
    const ways = [...screen.getByTestId("net-tunnel-how").children].map((li) => li.getAttribute("data-testid"));
    expect(ways).toEqual(["net-tunnel-decrypt", "net-tunnel-rust", "net-tunnel-logs"]);
    expect(screen.getByTestId("net-tunnel-rust")).toHaveTextContent(/^It is a Rust app: build it with native roots/);
    expect(screen.getByTestId("net-tunnel-cargo")).toHaveTextContent(RUSTLS_NATIVE_ROOTS_LINE);
  });

  it("an open tunnel: still open, and the head says so", async () => {
    await openOn([flow(1, { state: "pending", durationMs: null })], 1);
    expect(facts().Closed).toBe("still open");
    expect(facts().Duration).toBe("still open");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("TUNNEL · connection open");
  });

  it("a failed tunnel says connection failed in the head", async () => {
    await openOn([flow(1, { state: "error", error: "upstream: refused", reqBytes: 0, resBytes: 0, durationMs: 3 })], 1);
    expect(screen.getByTestId("net-detail")).toHaveTextContent("TUNNEL · 3ms · connection failed");
  });

  it("a finished tunnel without a duration (never sent by Rust today) says — rather than a made-up time", async () => {
    await openOn([flow(1, { state: "error", error: "x", durationMs: null })], 1);
    expect(screen.getByTestId("net-detail")).toHaveTextContent("TUNNEL · — · connection failed");
  });

  it("repeated tunnels from one pid to one host: N connections, bytes in total, how many open", async () => {
    await openOn([flow(1), flow(2, { state: "pending", durationMs: null, reqBytes: 100, resBytes: 0 }), flow(3), flow(4, { host: "other.io" })], 1);
    expect(screen.getByTestId("net-tunnel-group")).toHaveTextContent(
      "3 connections from gazelle (pid 4242) to geo.api.example.net:443 — 4.1KB ↑ 10.0KB ↓ in total, 1 still open.",
    );
    act(() => useNetworkStore.setState((s) => ({ flows: s.flows.map((f) => ({ ...f, state: "done" as const })) })));
    expect(screen.getByTestId("net-tunnel-group")).toHaveTextContent(/, all closed\.$/);
  });

  it("an unknown client: the group names 'This client', and it cannot be opted in", async () => {
    await openOn([flow(1, { client: null, note: null }), flow(2, { client: null, note: null })], 1);
    expect(screen.getByTestId("net-tunnel-group")).toHaveTextContent(/^2 connections from This client to/);
    expect(screen.getByTestId("net-tunnel-decrypt")).toHaveTextContent("not possible here");
    expect(screen.getByTestId("net-tunnel-rust")).toHaveTextContent(/^If it is a Rust app using reqwest:/);
  });

  it("Decrypt this app: with Decrypt HTTPS off, one click turns it on AND opts gazelle in; the switch shows what Rust returned", async () => {
    const off = { ...STATUS, decrypt: false };
    await openOn([flow(1, { note: null })], 1, off);
    const sw = screen.getByRole("switch", { name: "Decrypt gazelle's HTTPS" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("net-tunnel-decrypt")).toHaveTextContent("Also turns on Decrypt HTTPS.");
    expect(screen.getByTestId("net-tunnel-why")).toHaveTextContent("Decrypt HTTPS is off");
    ipc.netcapSet.mockResolvedValueOnce({ ...STATUS, decrypt: true });
    ipc.netcapSetAppDecrypt.mockResolvedValueOnce({ ...STATUS, decrypt: true, decryptApps: ["gazelle"] });
    fireEvent.click(sw);
    await act(async () => {});
    expect(ipc.netcapSet).toHaveBeenCalledWith({ decrypt: true });
    expect(ipc.netcapSetAppDecrypt).toHaveBeenCalledWith("gazelle", true);
    expect(ipc.netcapSet.mock.invocationCallOrder[0]).toBeLessThan(ipc.netcapSetAppDecrypt.mock.invocationCallOrder[0]);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("net-tunnel-decrypt")).toHaveTextContent("On — gazelle's new connections are decrypted.");

    // Off again: only the app is opted out; Decrypt HTTPS stays as it is.
    ipc.netcapSetAppDecrypt.mockResolvedValueOnce({ ...STATUS, decrypt: true, decryptApps: [] });
    fireEvent.click(sw);
    await act(async () => {});
    expect(ipc.netcapSetAppDecrypt).toHaveBeenLastCalledWith("gazelle", false);
    expect(ipc.netcapSet).toHaveBeenCalledTimes(1);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("Decrypt this app: when turning Decrypt HTTPS on fails, the app is NOT opted in behind the error", async () => {
    await openOn([flow(1, { note: null })], 1, { ...STATUS, decrypt: false });
    ipc.netcapSet.mockRejectedValueOnce(new Error("no CA"));
    fireEvent.click(screen.getByRole("switch", { name: "Decrypt gazelle's HTTPS" }));
    await act(async () => {});
    expect(ipc.netcapSetAppDecrypt).not.toHaveBeenCalled();
    expect(useNetworkStore.getState().statusError).toBe("no CA");
  });

  it("Decrypt this app waits for the status (disabled, and says why)", async () => {
    await openOn([flow(1)], 1);
    act(() => useNetworkStore.setState({ status: null }));
    expect(screen.getByRole("switch", { name: "Decrypt gazelle's HTTPS" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Decrypt gazelle's HTTPS" }).parentElement).toHaveAttribute(
      "title",
      "Waiting for the capture proxy's status…",
    );
  });

  it("the Cargo line copies (Copied / Copy failed / inert without a clipboard)", async () => {
    const user = userEvent.setup();
    await openOn([flow(1)], 1);
    const way = screen.getByTestId("net-tunnel-rust");
    await user.click(within(way).getByRole("button", { name: "Copy line" }));
    expect(await navigator.clipboard.readText()).toBe(RUSTLS_NATIVE_ROOTS_LINE);
    expect(within(way).getByRole("status")).toHaveTextContent("Copied");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    await user.click(within(way).getByRole("button", { name: "Copy line" }));
    expect(within(way).getByRole("status")).toHaveTextContent("Copy failed");
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      fireEvent.click(within(way).getByRole("button", { name: "Copy line" }));
      expect(within(way).getByRole("status")).toHaveTextContent("Copy failed");
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
    }
  });

  it("Open Logs opens the Logs tab (the app's own inbound calls)", async () => {
    await openOn([flow(1)], 1);
    fireEvent.click(within(screen.getByTestId("net-tunnel-logs")).getByRole("button", { name: "Open Logs" }));
    expect(Object.values(useAppStore.getState().tabs).some((t) => t.ref.kind === "agent-logs")).toBe(true);
  });
});

describe("a closed terminal keeps its last title", () => {
  it("gazelle (closed), in the row, the detail and the Source picker — the short id only for a never-seen one", async () => {
    openTerminal("gazelle");
    await openOn([flow(1), flow(2, { terminalId: "9f9f9f9f-never-seen" })], 1);
    expect(cell(1, "source")).toHaveTextContent("gazelle");
    closeTerminal();
    expect(cell(1, "source")).toHaveTextContent("gazelle (closed)");
    expect(cell(2, "source")).toHaveTextContent("closed terminal 9f9f9f9f");
    expect(facts().Source).toBe("gazelle (closed)");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("gazelle (closed) · gazelle (pid 4242)");
    fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
    const labels = screen.getAllByRole("option").map((o) => o.querySelector(".app-picker__label")?.textContent);
    expect(labels).toContain("gazelle (closed)");
  });

  it("the newest title wins; an unchanged index writes nothing", () => {
    rememberTitles(new Map([["a", "zsh"]]));
    const first = useNetworkStore.getState().terminalTitles;
    rememberTitles(new Map([["a", "zsh"]]));
    expect(useNetworkStore.getState().terminalTitles).toBe(first);
    rememberTitles(new Map([["a", "gazelle"], ["b", "web"]]));
    expect([...useNetworkStore.getState().terminalTitles]).toEqual([["a", "gazelle"], ["b", "web"]]);
  });

  it("the watcher is reference-counted: the titlebar button keeps recording after the panel unmounts", () => {
    const button = render(<NetworkButton />);
    const stopPanel = watchTerminalTitles();
    stopPanel();
    stopPanel(); // idempotent
    openTerminal("still recorded");
    expect(useNetworkStore.getState().terminalTitles.get(TERM)).toBe("still recorded");
    // An unrelated app-store change does not rebuild the index.
    const before = useNetworkStore.getState().terminalTitles;
    act(() => useAppStore.setState({ focusedPaneId: useAppStore.getState().focusedPaneId }));
    expect(useNetworkStore.getState().terminalTitles).toBe(before);
    button.unmount();
    openTerminal("not recorded");
    expect(useNetworkStore.getState().terminalTitles.get(TERM)).toBe("still recorded");
  });
});

describe("bypass rows — agent commands that skipped the proxy", () => {
  const CMD = "curl --noproxy '*' -X POST https://api.example.com/v1/items";
  const bypass = (id: number, o: Partial<FlowSummary> = {}): FlowSummary =>
    flow(id, {
      proto: "bypass", method: "POST", host: "api.example.com", port: 443, path: "/v1/items", reqBytes: 0, resBytes: 0,
      durationMs: null, note: null, client: null,
      bypass: { command: CMD, method: "POST", url: "https://api.example.com/v1/items" }, ...o,
    });

  it("the row: BYPASS, the parsed method and URL, not captured", async () => {
    await mount([bypass(1), bypass(2, { method: "", host: "", port: 0, path: "", bypass: { command: "NO_PROXY='*' ./sync", method: null, url: null } })]);
    const texts = (id: number) => ["proto", "method", "host", "path", "status", "type", "size", "dur"].map((c) => cell(id, c).textContent);
    expect(texts(1)).toEqual(["BYPASS", "POST", "api.example.com", "/v1/items", "not captured", "skipped the IDE proxy", "—", "…"]);
    expect(cell(1, "status")).toHaveClass("net-status--bypass");
    expect(texts(2).slice(0, 5)).toEqual(["BYPASS", "—", "—", "NO_PROXY='*' ./sync", "not captured"]);
  });

  it("the card: the command verbatim, the explainer, the strict-capture switch, what was parsed", async () => {
    await openOn([bypass(1)], 1, { ...STATUS, strictAgentCapture: false });
    const card = screen.getByTestId("net-bypass-card");
    expect(within(card).getByRole("heading", { level: 4 })).toHaveTextContent("Not captured — this command skipped the IDE proxy");
    expect(screen.getByTestId("net-bypass-command")).toHaveTextContent(CMD);
    expect(screen.getByTestId("net-bypass-why")).toHaveTextContent(BYPASS_EXPLAINER);
    expect(screen.getByTestId("net-detail")).toHaveTextContent("POST https://api.example.com/v1/items");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("BYPASS · not captured");
    expect(within(card).getByText("https://api.example.com/v1/items")).toBeInTheDocument();
    // Nothing to replay, and it says so.
    expect(screen.getByRole("button", { name: "Copy as cURL" })).toBeDisabled();
    expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toMatch(/^Not captured — this command skipped the IDE proxy/);
    expect(screen.getByTestId("net-copyreq-wrap").getAttribute("title")).toMatch(/^Not captured/);

    const sw = within(card).getByRole("switch", { name: STRICT_CAPTURE_LABEL });
    expect(sw).toHaveAttribute("aria-checked", "false");
    ipc.netcapSet.mockResolvedValueOnce({ ...STATUS, strictAgentCapture: true });
    fireEvent.click(sw);
    await act(async () => {});
    expect(ipc.netcapSet).toHaveBeenCalledWith({ strictAgentCapture: true });
    expect(sw).toHaveAttribute("aria-checked", "true");
    // The header's switch is the same setting.
    const all = screen.getAllByRole("switch", { name: STRICT_CAPTURE_LABEL });
    expect(all).toHaveLength(2);
    expect(all.every((s) => s.getAttribute("aria-checked") === "true")).toBe(true);
  });

  it("an unparsed / unrecorded bypass says so instead of inventing a URL", async () => {
    await openOn([bypass(1, { method: "", host: "", port: 0, path: "", bypass: { command: "x", method: null, url: null } }), bypass(2, { bypass: null })], 1);
    const card = screen.getByTestId("net-bypass-card");
    expect(within(card).getAllByText("not parsed")).toHaveLength(2);
    expect(screen.getByTestId("net-detail")).toHaveTextContent("— x");
    act(() => openDetail(2));
    await act(async () => {});
    expect(screen.getByTestId("net-bypass-command")).toHaveTextContent("(the command was not recorded)");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("(command not recorded)");
  });

  it("reasons, the agent (by its title), and a non-curl command says the switch cannot help", async () => {
    act(() =>
      useAppStore.setState((s) => {
        s.agents = { "agent-gazelle": { id: "agent-gazelle", title: "claude · gazelle", customTitle: null } } as unknown as typeof s.agents;
      }),
    );
    const py = bypass(1, {
      method: "", host: "", port: 0, path: "",
      bypass: { command: "NO_PROXY='*' python3 probe.py", method: null, url: null, agentId: "agent-gazelle", toolUseId: "toolu_1", reasons: ["NO_PROXY=*"], neutralized: false },
    });
    const gone = bypass(2, { bypass: { command: CMD, method: "POST", url: null, agentId: "agent-gone", toolUseId: null, reasons: [], neutralized: false } });
    await openOn([py, gone], 1);
    const card = within(screen.getByTestId("net-bypass-card"));
    expect(card.getByText("NO_PROXY=*")).toBeInTheDocument();
    expect(card.getByText("claude · gazelle")).toBeInTheDocument();
    expect(screen.getByTestId("net-bypass-notcurl")).toHaveTextContent("is not a curl");
    act(() => openDetail(2));
    await act(async () => {});
    expect(within(screen.getByTestId("net-bypass-card")).getByText("agent-gone")).toBeInTheDocument();
    expect(within(screen.getByTestId("net-bypass-card")).getByText("not recorded")).toBeInTheDocument();
    expect(screen.queryByTestId("net-bypass-notcurl")).toBeNull();
  });

  it("each reason is explained in words — Windows PowerShell 5.1's web cmdlets, -NoProxy", async () => {
    const ps = bypass(1, {
      method: "", host: "", port: 0, path: "",
      bypass: {
        command: "Invoke-WebRequest http://127.0.0.1:3000/health -NoProxy", method: null, url: null,
        agentId: null, toolUseId: null, reasons: ["PowerShell 5.1 web cmdlet", "-NoProxy"], neutralized: false,
      },
    });
    await openOn([ps, bypass(2)], 1);
    const items = within(screen.getByTestId("net-bypass-reasons")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Windows PowerShell 5.1's web cmdlets (Invoke-WebRequest, Invoke-RestMethod, iwr, irm) and .NET's WebClient ignore the proxy variables — use curl.exe or PowerShell 7 (pwsh) to see the request here.",
      "The PowerShell web cmdlet was told to use no proxy (-NoProxy).",
    ]);
    // The facts still carry the reasons as Rust spelled them.
    expect(within(screen.getByTestId("net-bypass-card")).getByText("PowerShell 5.1 web cmdlet, -NoProxy")).toBeInTheDocument();
    // No reasons recorded → no list.
    act(() => openDetail(2));
    await act(async () => {});
    expect(screen.queryByTestId("net-bypass-reasons")).toBeNull();
  });

  it("a neutralised bypass is NOT a table row (one row per call), and its card says it WAS captured, as its own row", async () => {
    // Every shimmed `curl --noproxy` used to show twice — its captured
    // HTTP row and this "via proxy" BYPASS row. Falsified: dropping `tableFlows` from FlowArea
    // puts row 1 back in the table and the header back at "2 flows".
    const shimmed = bypass(1, { bypass: { command: CMD, method: "POST", url: "https://api.example.com/v1/items", agentId: null, toolUseId: null, reasons: ["--noproxy"], neutralized: true } });
    const uncovered = bypass(2);
    await openOn([shimmed, uncovered], 1);
    expect(rowOf(1)).toBeNull();
    expect(cell(2, "status")).toHaveTextContent("not captured");
    expect(screen.getByTestId("net-title")).toHaveTextContent("Network — 1 flow");
    // Still in the ring: selected (e.g. from an export or a link), its detail opens.
    expect(screen.getByTestId("net-detail-hidden")).toBeInTheDocument();
    expect(within(screen.getByTestId("net-bypass-card")).getByRole("heading", { level: 4 })).toHaveTextContent(
      "Captured anyway — this command tried to skip the IDE proxy",
    );
    expect(screen.getByTestId("net-bypass-why")).toHaveTextContent("(--noproxy)");
    expect(screen.getByTestId("net-bypass-why")).toHaveTextContent("its request is its own row in this table");
    expect(screen.queryByTestId("net-bypass-notcurl")).toBeNull();
  });

  it("the captured request of a neutralised bypass says what the agent asked for (same terminal, URL, within a minute)", async () => {
    const info = { command: CMD, method: "POST", url: "https://api.example.com/v1/items", agentId: null, toolUseId: null, reasons: ["--noproxy"], neutralized: true };
    const shimmed = bypass(1, { startedMs: T0, bypass: info });
    const captured = flow(2, { proto: "https", method: "POST", host: "api.example.com", port: 443, path: "/v1/items", status: 200, startedMs: T0 + 900, note: null });
    await openOn([shimmed, captured], 2);
    expect(screen.getByTestId("net-shimmed")).toHaveTextContent(
      "The agent asked for --noproxy; the IDE's curl shim captured it anyway.",
    );
  });

  it("no note for a request that is not the shimmed call: another terminal, URL, port or time — or a bypass itself", async () => {
    const info = { command: CMD, method: "POST", url: "https://api.example.com/v1/items", agentId: null, toolUseId: null, reasons: [], neutralized: true };
    const shimmed = bypass(1, { bypass: info });
    const req = (id: number, o: Partial<FlowSummary>) =>
      flow(id, { proto: "https", method: "POST", host: "api.example.com", port: 443, path: "/v1/items", status: 200, note: null, ...o });
    const others = [
      req(2, { terminalId: "other-terminal" }),
      req(3, { path: "/v1/other" }),
      req(4, { startedMs: T0 + 61_000 }),
      req(5, { terminalId: null }),
      req(6, { port: 8443 }),
      req(7, { host: "api.example.org" }),
    ];
    await mount([shimmed, ...others]);
    for (const f of others) {
      act(() => openDetail(f.id));
      await act(async () => {});
      expect(screen.queryByTestId("net-shimmed"), `flow ${f.id}`).toBeNull();
    }
    // The bypass row's own detail has its card, not the note.
    act(() => openDetail(1));
    await act(async () => {});
    expect(screen.queryByTestId("net-shimmed")).toBeNull();
  });

  it("the header's switch: disabled and explained when Rust does not report the setting, or while status loads", async () => {
    await mount([]);
    const sw = screen.getByRole("switch", { name: STRICT_CAPTURE_LABEL });
    expect(sw).toBeDisabled();
    expect(screen.getByTestId("net-strict-wrap")).toHaveAttribute("title", STRICT_CAPTURE_UNAVAILABLE);
    act(() => useNetworkStore.setState({ status: null }));
    expect(screen.getByTestId("net-strict-wrap")).toHaveAttribute("title", "Waiting for the capture proxy's status…");
  });
});
