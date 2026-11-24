/**
 * "Hide AI providers": with many agents, every turn of every agent is a request from its CLI to a
 * model provider, and they bury the traffic worth reading. The checkbox, in the header's right corner, hides only an agent CLI's OWN
 * calls; an agent's curl or script to the same host stays.
 *
 * Only `./netcapIpc` / `./netmachineIpc` are mocked; the store, filter and table are real.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useColumnLayoutStore } from "../../components/columns";
import { resetStore } from "../../test/store-harness";
import type { FlowSummary, NetcapStatus } from "./networkTypes";

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
import { NetworkPanel } from "./NetworkPanel";
import { resetNetworkStore, useNetworkStore } from "./networkStore";

const CLAUDE = { pid: 40, name: "claude", path: "/Users/dev/.local/share/claude/versions/2.1.212" };
const CURL = { pid: 41, name: "curl", path: "/usr/bin/curl" };
const CODEX = { pid: 42, name: "codex", path: "/Users/dev/.local/bin/codex" };

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: 1_790_000_000_000 + id, proto: "https", method: "POST", host: "api.anthropic.com", port: 443,
    path: "/v1/messages", status: 200, grpcStatus: null, contentType: "application/json",
    reqBytes: 0, resBytes: 93, durationMs: 120, state: "done", error: null, terminalId: "t1",
    httpVersion: "HTTP/1.1", wsMessages: null, client: CLAUDE, note: null, ...o,
  };
}

// Three of Claude Code's own calls (one a tunnel), an agent's curl to Anthropic, an app's call, Codex's
// call to OpenAI, Claude Code's Datadog telemetry, and Claude Code fetching a page for the agent.
const FLOWS = [
  flow(1),
  flow(2, { host: "statsig.anthropic.com", path: "/v1/rgstr" }),
  flow(3, { proto: "tunnel", method: "CONNECT", path: "", status: null, httpVersion: "" }),
  flow(4, { method: "GET", path: "/v1/models", client: CURL }),
  flow(5, { method: "GET", host: "localhost", port: 3000, path: "/health", client: CURL }),
  flow(6, { host: "api.openai.com", path: "/v1/responses", client: CODEX }),
  flow(7, { host: "http-intake.logs.us5.datadoghq.com", path: "/api/v2/logs" }),
  flow(8, { method: "GET", host: "docs.example.com", path: "/guide" }),
];

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
  mach.netmachineStatus.mockReturnValue(new Promise(() => {}));
  mach.netmachineStart.mockReturnValue(new Promise(() => {}));
  mach.netmachineStop.mockResolvedValue(undefined);
  mach.listenSamples.mockReturnValue(new Promise(() => {}));
});
afterEach(() => resetNetworkStore());

async function mount(snapshot: FlowSummary[]) {
  ipc.netcapSnapshot.mockResolvedValue(snapshot);
  render(<NetworkPanel />);
  await screen.findByText(/^proxy /);
  await act(async () => {});
}

const ids = () => screen.queryAllByTestId("net-row").map((r) => Number(r.dataset.flowId));
const box = () => screen.getByTestId("net-hide-ai") as HTMLInputElement;

describe("Hide AI providers", () => {
  it("is on by default: agent CLIs' own provider calls are hidden; an agent's curl, the app and a fetched page stay", async () => {
    await mount(FLOWS);
    expect(box().checked).toBe(true);
    expect(ids()).toEqual([4, 5, 8]);
    // The count is what the box hides, so the user sees there is something behind it.
    expect(screen.getByTestId("net-ai-count").textContent).toBe("5");
    expect(box().closest("label")).toHaveTextContent("Hide AI providers5");
  });

  it("sits in the header's right corner, not the toolbar, and its hover names the providers, not one vendor", async () => {
    await mount(FLOWS);
    const label = box().closest("label") as HTMLElement;
    expect(label.closest(".net-head")).not.toBeNull();
    expect(label.closest(".net-bar")).toBeNull();
    expect(label).toHaveClass("net-head__hide");
    expect(label.getAttribute("title")).toMatch(/Providers: Anthropic \(Claude\), OpenAI \(GPT\), Google \(Gemini\)/);
  });

  it("unchecking it brings the CLIs' calls back, and checking hides them again", async () => {
    await mount(FLOWS);
    fireEvent.click(box());
    expect(useNetworkStore.getState().hideAiProviders).toBe(false);
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    fireEvent.click(box());
    expect(ids()).toEqual([4, 5, 8]);
  });

  it("when it is what empties the table, the empty state says so — and Show all flows turns it off", async () => {
    await mount(FLOWS.slice(0, 3));
    expect(ids()).toEqual([]);
    const empty = screen.getByTestId("net-empty");
    expect(empty).toHaveTextContent("All 3 flows are hidden by the current filters.");
    expect(within(empty).getByTestId("net-hidden-by-ai").textContent).toBe("Hide AI providers hides 3");
    fireEvent.click(within(empty).getByRole("button", { name: "Show all flows" }));
    expect(box().checked).toBe(false);
    expect(ids()).toEqual([1, 2, 3]);
  });

  it("off, it is not listed among the controls hiding flows", async () => {
    await mount(FLOWS);
    fireEvent.click(box());
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter flows" }), { target: { value: "zzz" } });
    expect(screen.getByTestId("net-hidden-by-text")).toBeInTheDocument();
    expect(screen.queryByTestId("net-hidden-by-ai")).toBeNull();
  });
});
