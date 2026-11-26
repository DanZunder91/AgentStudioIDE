/** SEAM TEST: flows came from the real Rust capture proxy (`src-tauri/tests/contract_goldens.rs`).
 * Only `invoke` / `listen` are mocked; IPC, store, panels and formatters are real. Expected strings
 * are written by hand, never derived from the golden or the code under test. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  const answers = new Map<string, (args?: Record<string, unknown>) => unknown>();
  const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const answer = answers.get(cmd);
    if (!answer) return Promise.reject(new Error(`not part of this contract test: ${cmd}`));
    return Promise.resolve().then(() => answer(args));
  });
  const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  });
  return { handlers, answers, invoke, listen };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { useAppStore } from "../../app/store";
import type { AgentId, AgentNode, Tab, TabId } from "../../app/types";
import { NetworkPanel } from "../../features/network/NetworkPanel";
import { resetMachineStore, setCaptureGuide } from "../../features/network/machineStore";
import { openDetail, resetNetworkStore, useNetworkStore } from "../../features/network/networkStore";
import type { FlowDetail, FlowSummary, MachineSample, NetcapStatus } from "../../features/network/networkTypes";
import { resetStore } from "../store-harness";
import { apiClientScenario, FLOWS, flowById, MACHINE_STATUS, snapshotOfFlows, STATUS, SUMMARIES } from "./goldens";

function answer(snapshot: FlowSummary[], status: NetcapStatus): void {
  tauri.answers.set("netcap_snapshot", () => snapshot);
  tauri.answers.set("netcap_status", () => status);
  tauri.answers.set("netcap_flow", (args) => flowById((args as { id: number }).id));
}

/** Rust's `netcap://flow` emit, delivered through the real `listen` subscription. */
function emitFlows(batch: FlowSummary[]): void {
  const h = tauri.handlers.get("netcap://flow");
  if (!h) throw new Error("the store never subscribed to netcap://flow");
  act(() => h({ payload: batch }));
}

async function mount(): Promise<void> {
  render(<NetworkPanel />);
  await screen.findByText(/^proxy /);
  // Let the snapshot, both status reads and the (batch-2, unanswered) machine probe settle.
  for (let i = 0; i < 5; i++) await act(async () => {});
}

const rowOf = (id: number) => document.querySelector(`[data-flow-id="${id}"]`) as HTMLElement;
const cells = (id: number) => Array.from(rowOf(id).querySelectorAll("td")).map((td) => td.textContent);
const cellClass = (id: number, col: number) => (rowOf(id).querySelectorAll("td")[col] as HTMLElement).className;

/** Local `HH:MM:SS` of a unix-ms instant — the Time column is local time. */
function hms(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
/** The goldens' normalised clock: flow N started at 2026-09-24T12:00:00Z + (N-1) s. */
const startOf = (id: number) => hms(Date.UTC(2026, 8, 24, 12, 0, id - 1));

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  tauri.handlers.clear();
  tauri.answers.clear();
  vi.clearAllMocks();
  // One open agent terminal: the flows attributed to `term-agent` resolve to its agent's
  // title; `term-shell` has no tab (closed), and a null terminalId is unattributed.
  useAppStore.setState((s) => {
    s.tabs = {
      t1: {
        id: "t1",
        kind: "agent-terminal",
        title: "tab",
        ref: { kind: "agent-terminal", terminalId: "term-agent", agentId: "a1" },
      },
    } as unknown as Record<TabId, Tab>;
    s.agents = { a1: { id: "a1", title: "claude · proj", customTitle: null } } as unknown as Record<AgentId, AgentNode>;
  });
});
afterEach(() => resetNetworkStore());

describe("the flow table renders what the real proxy captured", () => {
  it("every golden flow as its row: time, proto, method, host, path, status, type, size, duration, source, process", async () => {
    answer(snapshotOfFlows(), STATUS["decrypt-passthrough"]);
    await mount();
    expect(screen.getByTestId("net-title")).toHaveTextContent("Network — 11 flows");
    const rows = screen.getAllByTestId("net-row").map((r) => Number(r.dataset.flowId));
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const want: Record<number, string[]> = {
      1: ["HTTP", "POST", "127.0.0.1", "/api/v1/items?x=1", "201", "application/json", "45B", "120ms", "claude · proj", "claude"],
      2: ["HTTP", "POST", "127.0.0.1", "/binary", "200", "application/octet-stream", "6B", "45ms", "claude · proj", "claude"],
      3: ["HTTP", "POST", "127.0.0.1", "/upload", "413", "text/plain", "33B", "980ms", "closed terminal term-she", "curl"],
      4: ["WS", "GET", "127.0.0.1", "/chat", "101", "[no content]", "14B", "5.2s", "claude · proj", "claude"],
      // A tunnel: its connection state, and what it saw instead of a path.
      5: ["TUNNEL", "CONNECT", "localhost:8443", "encrypted · 2.0KB ↑ 6.0KB ↓", "closed", "[encrypted]", "↑2.0K ↓6.0K", "1.5s", "closed terminal term-she", "gazelle"],
      6: ["TUNNEL", "CONNECT", "127.0.0.1:9", "—", "failed", "upstream: Connection refused (os error N)", "↑0B ↓0B", "3ms", "unattributed", "—"],
      7: ["HTTPS", "POST", "localhost", "/v1/messages", "200", "application/json", "97B", "640ms", "claude · proj", "claude"],
      8: ["gRPC", "POST", "localhost", "/pkg.Greeter/SayHello", "200 g3", "application/grpc", "7B", "88ms", "claude · proj", "claude"],
      9: ["HTTPS", "CONNECT", "localhost", "—", "—", "tls rejected → passthrough", "0B", "12ms", "closed terminal term-she", "curl"],
      10: [
        "TUNNEL", "CONNECT", "localhost:8443", "encrypted · 2.0KB ↑ 6.0KB ↓", "closed", "not decrypted: gazelle doesn't read the IDE's CA", "↑2.0K ↓6.0K", "1.1s",
        "closed terminal term-she", "gazelle",
      ],
      // The IDE's own API client, recorded straight into the ring.
      11: ["HTTP", "POST", "127.0.0.1", "/v1/messages", "200", "application/json", "97B", "310ms", "API client", "Agent Studio"],
    };
    for (const [id, row] of Object.entries(want)) {
      expect(cells(Number(id)), `flow ${id}`).toEqual([startOf(Number(id)), ...row]);
    }
  });

  it("status buckets, duration tones and error/dim type cells come out of the real values", async () => {
    answer(snapshotOfFlows(), STATUS["decrypt-passthrough"]);
    await mount();
    const STATUS_COL = 5;
    const TYPE_COL = 6;
    const DUR_COL = 8;
    expect(cellClass(1, STATUS_COL)).toContain("net-status--2xx");
    expect(cellClass(3, STATUS_COL)).toContain("net-status--4xx");
    expect(cellClass(4, STATUS_COL)).toContain("net-status--1xx");
    expect(cellClass(5, STATUS_COL)).toContain("net-status--closed");
    expect(cellClass(6, STATUS_COL)).toContain("net-status--none"); // a tunnel that failed to connect
    // grpc-status 3 under an HTTP 200 is a failed call.
    expect(cellClass(8, STATUS_COL)).toContain("net-status--5xx");
    expect(cellClass(6, TYPE_COL)).toContain("net-type--error");
    expect(cellClass(9, TYPE_COL)).toContain("net-type--error");
    expect(cellClass(4, TYPE_COL)).toContain("net-type--dim");
    expect(cellClass(5, TYPE_COL)).toContain("net-type--dim");
    expect(cellClass(1, DUR_COL)).toContain("net-dur--fast");
    expect(cellClass(3, DUR_COL)).toContain("net-dur--mid");
    expect(cellClass(4, DUR_COL)).toContain("net-dur--slow");
    expect(cellClass(6, 9)).toContain("net-source--unattributed");
    expect(cellClass(3, 9)).toContain("net-source--gone");
    expect(cellClass(1, 9)).toContain("net-source--named");
    // The Process column: the note is dimmed in Type; an unresolved client is dim.
    expect(cellClass(10, TYPE_COL)).toContain("net-type--note");
    expect(cellClass(6, 10)).toContain("net-process--unknown");
    expect(cellClass(1, 10)).not.toContain("net-process--unknown");
    expect(rowOf(1).querySelectorAll("td")[10]).toHaveAttribute(
      "title",
      "/Users/dev/.local/share/claude/versions/2.1.0 · pid 4242",
    );
  });

  it("the filter understands the real values: proto:grpc, status:4xx, and a host substring", async () => {
    answer(snapshotOfFlows(), STATUS["decrypt-passthrough"]);
    await mount();
    const ids = () => screen.queryAllByTestId("net-row").map((r) => Number(r.dataset.flowId));
    const filter = screen.getByRole("searchbox", { name: "Filter flows" });
    fireEvent.change(filter, { target: { value: "proto:grpc" } });
    expect(ids()).toEqual([8]);
    fireEvent.change(filter, { target: { value: "status:4xx" } });
    expect(ids()).toEqual([3]);
    fireEvent.change(filter, { target: { value: "localhost" } });
    expect(ids()).toEqual([5, 7, 8, 9, 10]);
  });
});

describe("netcap://flow upserts from the real emit path", () => {
  it("a pending row (as the proxy first emits it) becomes the finished row in place", async () => {
    answer([], STATUS.default);
    await mount();
    emitFlows([SUMMARIES["http-pending"]]);
    expect(screen.getAllByTestId("net-row")).toHaveLength(1);
    expect(cells(1)).toEqual([startOf(1), "HTTP", "POST", "127.0.0.1", "/api/v1/items?x=1", "…", "…", "0B", "…", "claude · proj", "claude"]);
    expect(cellClass(1, 5)).toContain("net-status--pending");

    emitFlows([FLOWS["http-json-gzip-credentials"].summary]);
    expect(screen.getAllByTestId("net-row")).toHaveLength(1);
    expect(cells(1).slice(5, 9)).toEqual(["201", "application/json", "45B", "120ms"]);

    // A late replay of the pending emit never regresses the finished row.
    emitFlows([SUMMARIES["http-pending"]]);
    expect(cells(1)[5]).toBe("201");
  });

  it("a live WebSocket shows its message counts while still open", async () => {
    answer([], STATUS.default);
    await mount();
    emitFlows([SUMMARIES["ws-live"]]);
    expect(cells(4).slice(1, 6)).toEqual(["WS", "GET", "127.0.0.1", "/chat", "101"]);
    expect(cells(4)[8]).toBe("…");
    fireEvent.click(rowOf(4));
    await act(async () => {});
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 101 · messages ↑3 ↓3");
  });
});

describe("the header shows each real NetcapStatus", () => {
  it.each([
    ["default", "proxy 127.0.0.1:51234", "false", null],
    ["decrypt-passthrough", "proxy 127.0.0.1:51234", "true", null],
    ["skipped-with-ca", "proxy 127.0.0.1:51234", "false", "Not injected: HTTPS_PROXY already set in your environment"],
    ["stopped", "proxy not running", "false", null],
    ["port-changed-app-decrypt", "proxy 127.0.0.1:51234", "true", null],
  ] as const)("%s", async (name, port, decrypt, skipped) => {
    answer([], STATUS[name]);
    await mount();
    expect(screen.getByTestId("net-port")).toHaveTextContent(port);
    const decryptSwitch = screen.getByRole("switch", { name: "Decrypt HTTPS" });
    expect(decryptSwitch).toHaveAttribute("aria-checked", decrypt);
    expect(screen.getByRole("switch", { name: "Capture" })).toHaveAttribute("aria-checked", "true");
    if (skipped === null) expect(screen.queryByTestId("net-skipped")).toBeNull();
    else expect(screen.getByTestId("net-skipped")).toHaveTextContent(skipped);
    if (name === "decrypt-passthrough") expect(screen.getByText("passthrough: 1")).toHaveAttribute("title", "localhost");
    // Only the moved-port scenario warns, with Rust's own from/to.
    if (name === "port-changed-app-decrypt") {
      expect(screen.getByTestId("net-port-changed")).toHaveTextContent(
        "The proxy moved from :8877 to :51234 (port 8877 was busy) — update the port in apps you configured by hand.",
      );
    } else {
      expect(screen.queryByTestId("net-port-changed")).toBeNull();
    }
  });
});

describe("the capture guide over real NetcapStatus", () => {
  // A hand-built Whole Mac sample (the machine goldens have no Postman); everything else is real.
  const SAMPLE: MachineSample = {
    tsMs: 1,
    apps: [
      {
        key: "Postman:8080", name: "Postman", pid: 8080, user: "self", bytesIn: 1, bytesOut: 1, rateIn: 1, rateOut: 1,
        connections: [{ proto: "tcp4", local: "10.0.0.5:50000", remote: "18.1.2.3:443", remoteHost: null, state: "Established", bytesIn: 1, bytesOut: 1, rateIn: 1, rateOut: 1 }],
      },
    ],
  };
  afterEach(() => resetMachineStore());

  async function mountGuide(status: NetcapStatus): Promise<void> {
    answer([], status);
    tauri.answers.set("netmachine_status", () => MACHINE_STATUS["macos-running"]);
    tauri.answers.set("netmachine_start", () => MACHINE_STATUS["macos-running"]);
    tauri.answers.set("netmachine_stop", () => MACHINE_STATUS["macos-idle"]);
    await mount();
    fireEvent.click(within(screen.getByRole("group", { name: "Network mode" })).getByRole("button", { name: /Whole/ }));
    for (let i = 0; i < 5; i++) await act(async () => {});
    act(() => tauri.handlers.get("netmachine://sample")?.({ payload: SAMPLE }));
    act(() => setCaptureGuide("Postman:8080"));
  }
  const SWITCH = "I added the IDE's certificate in Postman — decrypt its HTTPS";

  it("the switch sends { app, on } over invoke and reflects Rust's decryptApps; the guide repeats the moved port", async () => {
    await mountGuide(STATUS.default);
    const sw = screen.getByRole("switch", { name: SWITCH });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("net-port-changed")).toBeNull();
    tauri.answers.set("netcap_set_app_decrypt", () => STATUS["port-changed-app-decrypt"]);
    fireEvent.click(sw);
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(tauri.invoke).toHaveBeenCalledWith("netcap_set_app_decrypt", { app: "Postman", on: true });
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByTestId("netm-guide")).getByTestId("net-port-changed")).toHaveTextContent(
      "The proxy moved from :8877 to :51234 (port 8877 was busy)",
    );
    expect(screen.getByTestId("netm-guide-proxy")).toHaveTextContent("127.0.0.1:51234 This port stays the same across restarts.");
  });
});

describe("the detail pane over real FlowDetails (netcap_flow)", () => {
  async function open(id: number): Promise<void> {
    answer(snapshotOfFlows(), STATUS["decrypt-passthrough"]);
    await mount();
    fireEvent.click(rowOf(id));
    await act(async () => {});
    expect(tauri.invoke).toHaveBeenCalledWith("netcap_flow", { id });
  }
  const tab = (name: "Request" | "Response") => fireEvent.click(screen.getByRole("tab", { name }));
  const curlWrap = () => screen.getByTestId("net-curl-wrap");
  const curlButton = () => screen.getByRole("button", { name: "Copy as cURL" });

  it("decrypted HTTPS: the x-api-key arrives verbatim, is shown and exported as-is; JSON body pretty-printed", async () => {
    const user = userEvent.setup();
    await open(7);
    expect(screen.getByTestId("net-detail")).toHaveTextContent("https://localhost:8443/v1/messages");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("HTTPS · HTTP/1.1 · 640ms · claude · proj");
    // Response tab (default): status line, JSON tree rather than the raw string.
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 200");
    const json = screen.getByTestId("json-view");
    expect(json).toHaveTextContent("msg_01");
    expect(json).toHaveTextContent("end_turn");
    expect(screen.queryByText(/^\{"id":"msg_01"/)).toBeNull();

    tab("Request");
    const reqHeaders = within(screen.getByRole("table", { name: "Headers" }));
    // Nothing is redacted: Rust capture → store → screen, byte-exact.
    expect(reqHeaders.getByRole("rowheader", { name: "x-api-key" }).nextSibling).toHaveTextContent("sk-ant-SECRET-KEY");
    expect(within(screen.getByRole("tabpanel")).getByTestId("json-view")).toHaveTextContent("claude-x");

    const write = vi.spyOn(navigator.clipboard, "writeText");
    expect(curlWrap().getAttribute("title")).toBe("Copy this request as a cURL command.");
    await user.click(curlButton());
    expect(write).toHaveBeenCalledWith(
      `curl -X POST 'https://localhost:8443/v1/messages' -H 'x-api-key: sk-ant-SECRET-KEY' ` +
        `-H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -H 'accept: */*' ` +
        `-H 'accept-encoding: gzip,deflate,br' ` +
        `--data '{"model":"claude-x","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'`,
    );
  });

  it("plain HTTP: the gzip body arrives decoded; set-cookie and authorization are shown and replayed verbatim", async () => {
    const user = userEvent.setup();
    await open(1);
    expect(screen.getByTestId("json-view")).toHaveTextContent("items");
    const resHeaders = within(screen.getByRole("table", { name: "Headers" }));
    expect(resHeaders.getByRole("rowheader", { name: "set-cookie" }).nextSibling).toHaveTextContent("session=COOKIE-SECRET");
    tab("Request");
    expect(screen.getByText("ping")).toBeInTheDocument();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(curlButton());
    expect(write).toHaveBeenCalledWith(
      `curl -X POST 'http://127.0.0.1:8080/api/v1/items?x=1' -H 'authorization: Bearer sk-live-SECRET' ` +
        `-H 'content-type: text/plain' -H 'accept: */*' -H 'accept-encoding: gzip,deflate,br' --data 'ping'`,
    );
  });

  it("the proxy's own attribution header (hop-by-hop, never seen by the origin) is not replayed", async () => {
    const user = userEvent.setup();
    await open(1);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(curlButton());
    expect(write.mock.calls[0][0]).not.toContain("proxy-authorization");
  });

  it("Mask secrets hides credential values on screen only — the export keeps them", async () => {
    const user = userEvent.setup();
    await open(1);
    tab("Request");
    fireEvent.click(screen.getByRole("button", { name: "Mask secrets" }));
    const reqHeaders = within(screen.getByRole("table", { name: "Headers" }));
    expect(reqHeaders.getByRole("rowheader", { name: "authorization" }).nextSibling).toHaveTextContent("••••••••");
    expect(reqHeaders.getByRole("rowheader", { name: "content-type" }).nextSibling).toHaveTextContent("text/plain");
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(curlButton());
    expect(write.mock.calls[0][0]).toContain("-H 'authorization: Bearer sk-live-SECRET'");
  });

  it("gRPC: status line carries grpc-status, trailers are listed, replay is refused with the reason", async () => {
    await open(8);
    expect(screen.getByTestId("net-detail")).toHaveTextContent("gRPC · HTTP/2");
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 200 · grpc-status 3");
    const trailers = within(screen.getByRole("table", { name: "Trailers" }));
    expect(trailers.getByRole("rowheader", { name: "grpc-status" }).nextSibling).toHaveTextContent("3");
    expect(trailers.getByRole("rowheader", { name: "grpc-message" }).nextSibling).toHaveTextContent("bad name");
    expect(curlButton()).toBeDisabled();
    expect(curlWrap().getAttribute("title")).toMatch(/gRPC bodies are binary protobuf/);
  });

  it("a request body past the 1 MiB cap: the truncation notice, and a refused replay", async () => {
    await open(3);
    tab("Request");
    expect(screen.getByTestId("net-truncated")).toHaveTextContent(
      "Truncated at the 1 MiB capture limit (1048586 bytes on the wire).",
    );
    expect(curlButton()).toBeDisabled();
    expect(curlWrap().getAttribute("title")).toMatch(/truncated at the 1 MiB capture limit/);
  });

  it("base64 bodies render as binary, never as text, and cannot be pasted as cURL", async () => {
    await open(2);
    expect(within(screen.getByRole("tabpanel")).getByText("binary, 6 bytes")).toBeInTheDocument();
    expect(curlButton()).toBeDisabled();
    expect(curlWrap().getAttribute("title")).toBe("The request body is binary (6 bytes) — it can't be pasted as text.");
  });

  it("a tunnel: host:port, the byte counts, no tabs, no replay", async () => {
    await open(5);
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("Encrypted tunnel: 2048 B up, 6144 B down.");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(curlButton()).toBeDisabled();
  });

  it("error rows explain themselves: upstream refused (unattributed) and tls rejected → passthrough", async () => {
    await open(6);
    expect(screen.getByTestId("net-detail")).toHaveTextContent("unattributed");
    expect(within(screen.getByTestId("net-detail")).getAllByRole("alert")[0]).toHaveTextContent(
      "upstream: Connection refused (os error N)",
    );
    fireEvent.click(rowOf(9));
    await act(async () => {});
    expect(within(screen.getByTestId("net-detail")).getAllByRole("alert")[0]).toHaveTextContent("tls rejected → passthrough");
  });

  /* A rejected TLS handshake is recorded as an `https` CONNECT with no request: no replay. */
  it("SEAM: a tls-rejected CONNECT row does not offer a meaningless `curl -X CONNECT` replay", async () => {
    await open(9);
    expect(curlButton()).toBeDisabled();
    expect(curlWrap().getAttribute("title")).toBe(
      "Nothing to replay — curl refused the IDE's certificate before sending a request.",
    );
  });

  it("tls rejected is explained in plain words, naming the real client", async () => {
    await open(9);
    expect(screen.getByTestId("net-explain")).toHaveTextContent(
      "curl doesn't trust the IDE's certificate, so this one connection failed. " +
        "Later connections from curl to localhost are passed through without decrypting.",
    );
    expect(screen.getByTestId("net-detail")).toHaveTextContent("curl (pid 5151)");
  });

  it("a connection the proxy chose not to decrypt says why, and does not advise Decrypt", async () => {
    await open(10);
    expect(screen.getByTestId("net-explain")).toHaveTextContent("not decrypted: gazelle doesn't read the IDE's CA");
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent(
      "Encrypted tunnel: 2048 B up, 6144 B down. The proxy relays the bytes without decrypting them, so it can't break the client.",
    );
    expect(screen.getByTestId("net-tunnel-note")).not.toHaveTextContent("turn on Decrypt HTTPS");
    expect(curlButton()).toBeDisabled();
    expect(curlWrap().getAttribute("title")).toBe(
      "Encrypted tunnel — the proxy never saw the request (not decrypted: gazelle doesn't read the IDE's CA).",
    );
    // A plain tunnel (no note) keeps the Decrypt advice.
    fireEvent.click(rowOf(5));
    await act(async () => {});
    expect(screen.queryByTestId("net-explain")).toBeNull();
    expect(screen.getByTestId("net-tunnel-note")).toHaveTextContent("turn on Decrypt HTTPS");
  });

  it("a gazelle tunnel: a card that says it is encrypted, why, what is known, and how to see more", async () => {
    await open(10);
    const card = screen.getByTestId("net-tunnel-card");
    expect(within(card).getByRole("heading", { level: 4 })).toHaveTextContent("Encrypted tunnel — contents not visible");
    // The golden's client runs from `…/gazelle/target/debug/gazelle`: the Rust reason, named.
    expect(screen.getByTestId("net-tunnel-why")).toHaveTextContent(
      "gazelle isn't on the decrypt list: it doesn't read the IDE's certificate, so the proxy passes its HTTPS through untouched instead of breaking it. " +
        "Rust apps using rustls + webpki-roots ignore the IDE's certificate, so decrypting would make every call fail with UnknownIssuer.",
    );
    const facts = Object.fromEntries(
      [...screen.getByTestId("net-facts").querySelectorAll(".net-facts__row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]),
    );
    expect(facts).toMatchObject({ Host: "localhost", Port: "8443", Duration: "1.1s", Sent: "2.0KB (2048 B)", Received: "6.0KB (6144 B)" });
    expect(facts.Process).toBe("gazelle (pid 6161) · /Users/dev/gazelle/target/debug/gazelle");
    expect(facts.Closed).not.toBe("still open");
    expect(screen.getByTestId("net-tunnel-rust")).toHaveTextContent("It is a Rust app:");
    expect(screen.getByTestId("net-tunnel-cargo")).toHaveTextContent('features = ["rustls-tls-native-roots"]');
    expect(screen.getByRole("switch", { name: "Decrypt gazelle's HTTPS" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("net-detail")).toHaveTextContent("connection closed");
  });

  it("the real detector's bypass rows (the bypass goldens): BYPASS rows, and each card tells neutralised from not captured", async () => {
    // Ids 1 and 2 in the golden collide with nothing here: only these two rows are mounted.
    const curl = SUMMARIES["bypass-curl-neutralized"];
    const py = SUMMARIES["bypass-python"];
    answer([curl, py], STATUS.default);
    await mount();
    const STATUS_COL = 5;
    // A neutralised bypass is not a table row: its request is its own captured row (one row per
    // call, networkFilter.tableFlows). It stays in the ring, so its detail still opens.
    expect(rowOf(curl.id)).toBeNull();
    expect(cells(py.id).slice(1, 6)).toEqual(["BYPASS", "—", "—", "cd /Users/dev/gazelle && NO_PROXY='*' python3 scripts/probe.py --port 3000", "not captured"]);
    expect(cellClass(py.id, STATUS_COL)).toContain("net-status--bypass");
    // The golden's status reports the pref: the header switch reflects it.
    expect(screen.getAllByRole("switch", { name: "Capture agent curls even with --noproxy" })[0]).toHaveAttribute(
      "aria-checked",
      String(STATUS.default.strictAgentCapture === true),
    );

    act(() => openDetail(curl.id));
    await act(async () => {});
    expect(screen.getByTestId("net-bypass-card")).toHaveTextContent("Captured anyway — this command tried to skip the IDE proxy");
    expect(screen.getByTestId("net-bypass-command")).toHaveTextContent(curl.bypass!.command);
    expect(screen.getByTestId("net-bypass-why")).toHaveTextContent("(--noproxy)");

    fireEvent.click(rowOf(py.id));
    await act(async () => {});
    expect(screen.getByTestId("net-bypass-card")).toHaveTextContent("Not captured — this command skipped the IDE proxy");
    expect(screen.getByTestId("net-bypass-why")).toHaveTextContent(
      "This command skipped the IDE proxy, so its request is not in this table. With 'Capture agent curls even with --noproxy' on, an agent's curl is captured anyway.",
    );
    expect(screen.getByTestId("net-bypass-notcurl")).toBeInTheDocument();
    expect(within(screen.getByTestId("net-bypass-card")).getByText("NO_PROXY=*")).toBeInTheDocument();
  });

  it("a WebSocket: status 101 with the final message counts; replay refused", async () => {
    await open(4);
    expect(screen.getByTestId("net-status-line")).toHaveTextContent("Status 101 · messages ↑3 ↓3");
    expect(curlButton()).toBeDisabled();
    expect(curlWrap().getAttribute("title")).toBe("WebSocket flows can't be replayed as a single request yet.");
  });

  it("the store holds the detail exactly as Rust sent it (no field lost on the way in)", async () => {
    await open(8);
    expect(useNetworkStore.getState().detail?.detail).toEqual(FLOWS["grpc-trailers"]);
  });
});

describe("the IDE's own API client, recorded straight into the ring (netcap::record)", () => {
  // Found by its reserved terminalId; skipped BY NAME if the golden lacks the scenario —
  // a silent skip would read as a pass.
  const golden = apiClientScenario();

  it.skipIf(golden === undefined)(
    "WAITING FOR THE RUST GOLDEN (skips until netcap-flows.json carries a terminalId `ide-api-client` scenario) — " +
      "the row reads Source `API client` / Process `Agent Studio`; the detail shows the request and the response; Copy as cURL is enabled",
    async () => {
      const g = golden as FlowDetail;
      const id = g.summary.id;
      answer(snapshotOfFlows(), STATUS.default);
      await mount();
      const SOURCE_COL = 9;
      const PROCESS_COL = 10;
      expect(cells(id)[SOURCE_COL]).toBe("API client");
      expect(cellClass(id, SOURCE_COL)).toContain("net-source--api-client");
      expect(cells(id)[PROCESS_COL]).toBe("Agent Studio");

      // The Source picker offers it as the reserved row, with its sublabel.
      fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
      const row = screen.getAllByRole("option").find((o) => o.querySelector(".app-picker__label")?.textContent === "API client");
      expect(row?.querySelector(".app-picker__sub")).toHaveTextContent("the IDE's built-in API client");
      fireEvent.keyDown(window, { key: "Escape" });

      fireEvent.click(rowOf(id));
      await act(async () => {});
      expect(tauri.invoke).toHaveBeenCalledWith("netcap_flow", { id });
      expect(screen.getByTestId("net-detail")).toHaveTextContent("API client · Agent Studio (pid ");
      // Response (default tab): a status line and the captured headers.
      expect(screen.getByTestId("net-status-line")).toHaveTextContent(/^Status \d{3}/);
      expect(within(screen.getByRole("tabpanel")).getByRole("table", { name: "Headers" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "Request" }));
      expect(screen.getByTestId("net-request-line")).toHaveTextContent(/^[A-Z]+ \/\S* HTTP\/\d/);
      expect(within(screen.getByRole("tabpanel")).getByRole("table", { name: "Headers" })).toBeInTheDocument();
      // Nothing about it is a tunnel: the replay is offered.
      expect(screen.getByRole("button", { name: "Copy as cURL" })).toBeEnabled();
      expect(screen.getByTestId("net-curl-wrap").getAttribute("title")).toBe("Copy this request as a cURL command.");
    },
  );
});
