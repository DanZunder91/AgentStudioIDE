/**
 * The tunnel row and its detail card, in real Chromium — an encrypted tunnel must READ: the row's Status/Size/Path cells show their text whole, and the card
 * (why · what you can see · how to see the requests, with the long Cargo line) fits the pane
 * without being cut off or pushing the pane sideways, at a wide and at a narrow width.
 *
 * Browser tier because the claim is layout: jsdom has no text metrics.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/network/networkTunnel.browser.test.tsx`
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../App.css";
import { useColumnLayoutStore } from "../../components/columns";
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
import { NetworkPanel } from "./NetworkPanel";
import { openDetail, resetNetworkStore } from "./networkStore";

const STATUS: NetcapStatus = {
  running: true, port: 51234, enabled: true, decrypt: true, caPath: null,
  skippedReason: null, passthroughHosts: [], flowCount: 3, decryptApps: [], portChanged: null,
};

const BIG = 1023 * 1024;
const GAZELLE = { pid: 4242, name: "gazelle", path: "/Users/dev/workspace/apps/gazelle/target/debug/gazelle" };
const tunnel = (id: number, o: Partial<FlowSummary> = {}): FlowSummary => ({
  id, startedMs: new Date(2026, 0, 1, 12, 0, 0).getTime(), proto: "tunnel", method: "CONNECT",
  host: "geo.api.example.net", port: 443, path: "", status: null, grpcStatus: null, contentType: null,
  reqBytes: BIG, resBytes: BIG, durationMs: 30_000, state: "done", error: null, terminalId: "0000eeee-1",
  httpVersion: "", wsMessages: null, client: GAZELLE, note: "not decrypted: gazelle doesn't read the IDE's CA", ...o,
});
const BYPASS: FlowSummary = {
  ...tunnel(3), proto: "bypass", method: "POST", host: "api.example.com", path: "/v1/items", reqBytes: 0, resBytes: 0,
  durationMs: null, note: null, bypass: { command: "curl --noproxy '*' -X POST https://api.example.com/v1/items", method: "POST", url: "https://api.example.com/v1/items" },
};

beforeEach(() => {
  useColumnLayoutStore.setState({ layouts: {} });
  resetNetworkStore();
  resetMachineStore();
  mach.netmachineStatus.mockReturnValue(new Promise(() => {}));
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([tunnel(1), tunnel(2, { state: "pending", durationMs: null }), BYPASS]);
  ipc.netcapFlow.mockImplementation(async (id: number) => ({
    summary: tunnel(id), requestHeaders: [], responseHeaders: [], responseTrailers: [], requestBody: null, responseBody: null,
  }));
  ipc.listenFlows.mockResolvedValue(() => {});
});
afterEach(cleanup);

/** Every element inside `root` whose own text is cut off horizontally. */
function clipped(root: Element): string[] {
  const out: string[] = [];
  for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")] as HTMLElement[]) {
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
  }
  return out;
}

async function mount(width: number) {
  render(
    <div style={{ width, height: 900, display: "flex", flexDirection: "column" }}>
      <NetworkPanel />
    </div>,
  );
  await screen.findAllByText("geo.api.example.net:443");
  await act(async () => {});
}

describe("the tunnel row and its card, laid out for real", () => {
  it("the row's Status / Size / Path cells show their text whole (closed, open, not captured, ↑1023K ↓1023K)", async () => {
    await mount(1400);
    for (const id of [1, 2, 3]) {
      for (const col of ["status", "size"]) {
        const cell = document.querySelector<HTMLElement>(`[data-flow-id="${id}"] td.net-c--${col}`)!;
        expect(cell.scrollWidth, `${id}/${col}: "${cell.textContent}"`).toBeLessThanOrEqual(cell.clientWidth);
      }
    }
    const path = document.querySelector<HTMLElement>('[data-flow-id="1"] td.net-c--path')!;
    expect(path.textContent).toBe("encrypted · 1023.0KB ↑ 1023.0KB ↓");
    // Path is the flex column: squeezed to its 160px floor here, it ellipsizes like any long
    // path — and its hover carries the whole text.
    expect(path.getAttribute("title")).toBe("encrypted · 1023.0KB ↑ 1023.0KB ↓");
  });

  it("with room, the Path cell shows the whole `encrypted · n ↑ m ↓`", async () => {
    await mount(1900);
    const path = document.querySelector<HTMLElement>('[data-flow-id="1"] td.net-c--path')!;
    expect(path.scrollWidth, `${path.clientWidth}px`).toBeLessThanOrEqual(path.clientWidth);
  });

  for (const width of [1400, 720]) {
    it(`the card fits the detail pane at ${width}px: nothing cut off, no sideways scroll`, async () => {
      await mount(width);
      act(() => openDetail(1));
      await act(async () => {});
      const pane = screen.getByTestId("net-detail");
      const card = screen.getByTestId("net-tunnel-card");
      expect(card.getBoundingClientRect().height).toBeGreaterThan(100);
      expect(clipped(card)).toEqual([]);
      expect(pane.scrollWidth, "the pane scrolls sideways").toBeLessThanOrEqual(pane.clientWidth);
      const cr = card.getBoundingClientRect();
      const pr = pane.getBoundingClientRect();
      expect(cr.left).toBeGreaterThanOrEqual(pr.left);
      expect(cr.right).toBeLessThanOrEqual(pr.right + 0.5);
      // The Cargo line wraps inside the card rather than running out of it.
      const pre = screen.getByTestId("net-tunnel-cargo");
      expect(pre.getBoundingClientRect().right).toBeLessThanOrEqual(cr.right);
    });
  }

  it("the bypass card fits too, its command wrapped", async () => {
    await mount(720);
    act(() => openDetail(3));
    await act(async () => {});
    const card = screen.getByTestId("net-bypass-card");
    expect(clipped(card)).toEqual([]);
    expect(screen.getByTestId("net-detail").scrollWidth).toBeLessThanOrEqual(screen.getByTestId("net-detail").clientWidth);
  });
});
