/** Browser tier: only real layout says where a control is. The flex-row host (default
 * `min-width: auto`) reproduces the clip and fails without `contain: inline-size` on
 * `.net-ide__main`; the pane host does not, which is why both hosts are here. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../App.css";

const ipc = vi.hoisted(() => ({
  netcapStatus: vi.fn(), netcapSet: vi.fn(), netcapSetAppDecrypt: vi.fn(), netcapSnapshot: vi.fn(),
  netcapFlow: vi.fn(), netcapClear: vi.fn(), listenFlows: vi.fn(), NETCAP_FLOW_EVENT: "netcap://flow",
  apps: [] as unknown[],
}));
vi.mock("./netcapIpc", () => ipc);
vi.mock("./netmachineIpc", () => ({
  netmachineStatus: () => Promise.resolve({ available: true, backend: "macos-nettop", reason: null, running: false, hasBytes: true }),
  netmachineStart: vi.fn(), netmachineStop: vi.fn(), listenSamples: () => Promise.resolve(() => {}),
  NETMACHINE_SAMPLE_EVENT: "netmachine://sample",
}));
vi.mock("../procs/procsIpc", () => ({
  procsList: () => Promise.resolve({ available: true, reason: null, apps: ipc.apps }),
  tailApp: vi.fn(), tailDocker: vi.fn(), untail: vi.fn(), pickLogFile: vi.fn(), restartPrepare: vi.fn(), restartInIde: vi.fn(),
}));

import { useColumnLayoutStore } from "../../components/columns";
import { resetProcsStore } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import { NetworkPanel } from "./NetworkPanel";
import { resetNetworkStore } from "./networkStore";
import type { FlowSummary } from "./networkTypes";

const dev = (o: Partial<DevApp>): DevApp => ({
  key: "pid:0", pid: 0, runtime: "node", name: "x", exe: "/usr/local/bin/node", argv: ["node"], cwd: "/w/x",
  startedMs: 1, ports: [], console: "ide-terminal", logFiles: [], containerId: null, origin: "ide",
  terminalId: "T1", agentId: null, launchedBy: "claude · gazelle", captured: true, ...o,
});
const flow = (id: number, o: Partial<FlowSummary> = {}): FlowSummary => ({
  id, startedMs: 1_700_000_000_000 + id, proto: "https", method: "GET", host: "api.example.com", port: 443,
  path: `/r/${id}`, status: 200, grpcStatus: null, contentType: "application/json", reqBytes: 0, resBytes: 11,
  durationMs: 12, state: "done", error: null, terminalId: "T1", httpVersion: "HTTP/1.1", wsMessages: null,
  client: { pid: 10, name: "gazelle", path: null }, note: null, ...o,
});

beforeEach(() => {
  resetNetworkStore();
  resetProcsStore();
  useColumnLayoutStore.setState({ layouts: {} });
  ipc.apps = [dev({ key: "pid:10", pid: 10, runtime: "rust", name: "gazelle" }), dev({ key: "pid:30", pid: 30, name: "gateway", origin: "external", terminalId: null, launchedBy: null, captured: null })];
  ipc.netcapStatus.mockResolvedValue({ running: true, port: 1, enabled: true, decrypt: true, caPath: null, skippedReason: null, passthroughHosts: [], flowCount: 1, decryptApps: [], portChanged: null });
  ipc.netcapSnapshot.mockResolvedValue([flow(1), flow(2, { terminalId: null, client: { pid: 30, name: "gateway", path: null } })]);
  ipc.listenFlows.mockResolvedValue(() => {});
});
afterEach(cleanup);

const CONTROLS = [
  ["filter", () => screen.getByRole("searchbox", { name: "Filter flows" })],
  ["source", () => screen.getByRole("button", { name: /Filter by source/ })],
  ["process", () => screen.getByRole("button", { name: /Filter by process/ })],
  ["host", () => screen.getByRole("button", { name: /Filter by host/ })],
  ["protocols", () => screen.getByRole("group", { name: "Protocols" })],
  ["pause", () => screen.getByRole("button", { name: "Pause" })],
  ["clear", () => screen.getByRole("button", { name: "Clear" })],
  ["columns", () => screen.getByRole("button", { name: /Columns/ })],
] as const;

type Host = "pane" | "row";
function mount(w: number, host: Host): void {
  const panel = <NetworkPanel />;
  render(
    host === "pane" ? (
      <div style={{ width: w, height: 700, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>{panel}</div>
      </div>
    ) : (
      <div style={{ width: w, height: 700, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column" }}>{panel}</div>
      </div>
    ),
  );
}

describe("the IDE-traffic toolbar never clips a control", () => {
  for (const w of [1450, 900]) {
    for (const host of ["pane", "row"] as const) {
      it(`${w} px, ${host} host: every control is inside the panel, the sidebar is 280 px`, async () => {
        mount(w, host);
        await screen.findAllByTestId("procs-row");
        const panel = screen.getByTestId("network-panel").getBoundingClientRect();
        expect(panel.width, "the panel is its box's width").toBeLessThanOrEqual(w);
        expect(screen.getByTestId("net-apps").getBoundingClientRect().width).toBe(280);
        for (const [name, get] of CONTROLS) {
          const r = get().getBoundingClientRect();
          expect(r.width, `${name} has a width`).toBeGreaterThan(0);
          expect(r.left, `${name} left`).toBeGreaterThanOrEqual(panel.left);
          expect(r.right, `${name} right`).toBeLessThanOrEqual(panel.right + 0.5);
        }
        const filter = CONTROLS[0][1]().getBoundingClientRect();
        expect(filter.width, "the filter box keeps its min width").toBeGreaterThanOrEqual(160);
      });
    }
  }

  it("at 900 px the bar wraps onto a second line instead of clipping", async () => {
    mount(900, "pane");
    await screen.findAllByTestId("procs-row");
    const filter = CONTROLS[0][1]().getBoundingClientRect();
    const columns = CONTROLS[7][1]().getBoundingClientRect();
    expect(columns.top, "Columns ▾ sits on a line below the filter box").toBeGreaterThanOrEqual(filter.bottom);
  });
});

describe("the Network sidebar", () => {
  it("at 280 px the Apps rows' origin tag reads in full, and carries it as its title", async () => {
    mount(1450, "pane");
    await screen.findAllByTestId("procs-row");
    const tag = document.querySelector<HTMLElement>('[data-testid="procs-line"][data-key="pid:10"] [data-testid="procs-origin"]')!;
    expect(tag.title).toBe(tag.textContent);
    expect(tag.textContent).toContain("claude · gazelle");
    expect(tag.scrollWidth, `"${tag.textContent}" is not truncated`).toBeLessThanOrEqual(tag.clientWidth);
  });

  it("dragging its edge resizes it in real pixels, clamped to 180–560; double-click resets", async () => {
    mount(1450, "pane");
    await screen.findAllByTestId("procs-row");
    const side = () => screen.getByTestId("net-apps").getBoundingClientRect().width;
    const handle = screen.getByTestId("net-side-resizer");
    const x = handle.getBoundingClientRect().x;
    fireEvent.pointerDown(handle, { clientX: x, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: x + 100 });
    fireEvent.pointerUp(handle);
    expect(side()).toBe(380);
    fireEvent.pointerDown(handle, { clientX: x, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: x + 1000 });
    fireEvent.pointerUp(handle);
    expect(side()).toBe(560);
    fireEvent.doubleClick(handle);
    expect(side()).toBe(280);
  });
});
