/** The Linux webview shows a WebGL canvas one draw late (settleRepaint.ts). Chromium does not lag,
 * so the first test passes with or without the fix; the second models the lag (on screen = the
 * frame before the last) and fails without the settle repaint. Docker E2E checks WebKitGTK. */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import App from "../../App";
import { EMPTY_LAYOUT_PREFS } from "../../app/layoutPrefsIpc";
import { useAppStore } from "../../app/store";
import { asAgentId, asTerminalId, type AgentId, type AgentNode, type TerminalMeta } from "../../app/types";
import { installTauriMock, type ChannelDriver, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { disposeAll, getRendererKind, getTerminal } from "./index";
import { SETTLE_REPAINT_MS } from "./settleRepaint";

const A = asAgentId("01J0RESTOREPAINT000000000A");
const B = asAgentId("01J0RESTOREPAINT000000000B");
const CWD = "/repo/e2e/fixtures/workspace";
/** What Rust's scrollback ring replays into each re-attached terminal: the E2E stub's banner. */
const BANNER = "AGENTSTUDIO-E2E fake agent ready\r\n";

async function settle(ms: number): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
}

const restoredAgent = (id: AgentId): AgentNode => ({
  id,
  parentId: null,
  kind: "orchestrator",
  title: "claude",
  status: "idle",
  branch: "",
  cwd: CWD,
  runtime: "claude-code",
  startedAt: 1,
  finishedAt: null,
  lastActivityAt: 1,
  childIds: [],
  sessionId: null,
  expanded: true,
  unread: 0,
});

/** How Rust describes a restored agent's live terminal in `fleet_snapshot`. */
const liveTerminal = (id: AgentId): TerminalMeta => ({
  id: asTerminalId(id),
  kind: "agent-terminal",
  title: "claude",
  cwd: CWD,
  cols: 80,
  rows: 24,
  status: "live",
  agentId: id,
});

/** Light grey text pixels of `row`, so the accent-blue cursor outline does not count. The
 * threshold is low on purpose: stroke brightness varies with the rasteriser and load. */
function textPixels(data: ImageData, rows: number, row: number): number {
  const rowPx = data.height / rows;
  let n = 0;
  for (let y = Math.floor(row * rowPx); y < Math.floor((row + 1) * rowPx); y++) {
    for (let x = 0; x < data.width; x++) {
      const i = (y * data.width + x) * 4;
      const [r, g, b] = [data.data[i], data.data[i + 1], data.data[i + 2]];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > 90 && Math.max(r, g, b) - Math.min(r, g, b) < 50) n++;
    }
  }
  return n;
}

/** The text-coloured pixel count of rows 0 and 3 — the banner's row, and one that stays empty. */
function rows0and3(data: ImageData, rows: number): { row0: number; row3: number } {
  return { row0: textPixels(data, rows, 0), row3: textPixels(data, rows, 3) };
}

/** A's WebGL canvas: the one in its screen that holds a WebGL2 context (the link layer's is 2D). */
function webglCanvasOf(id: AgentId): HTMLCanvasElement {
  const canvases = Array.from(
    document.querySelectorAll<HTMLCanvasElement>(`.terminal-view[data-terminal-id="${id}"] .xterm-screen canvas`),
  );
  const gl = canvases.find((c) => c.getContext("webgl2") !== null);
  if (!gl) throw new Error(`terminal ${id} has no WebGL canvas`);
  return gl;
}

describe("a restored agent in a pane that is not focused paints its replay", () => {
  let ipc: TauriMock;
  const ring = new Map<string, ChannelDriver>();

  beforeEach(() => {
    resetStore();
    ring.clear();
    ipc = installTauriMock();
    ipc
      // Re-attach: swap in the new Channel, replay the ring. The replay is sent by the TEST, at
      // the moment a recording shows it landing — after the panes have settled and focus has
      // gone to B — so that it is A's last draw, as it is on the real screen.
      .handle("terminal_reattach", (args) => {
        const pty = ipc.channel().capture(args.onOutput);
        ring.set(String(args.terminalId), pty);
        return liveTerminal(asAgentId(String(args.terminalId)));
      })
      .handle("terminal_write", () => null)
      .handle("terminal_resize", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  /** The boot after a restart, in `bridge.ts`'s order: arrangement, agents, their tabs, markers. */
  async function restoreSideBySide(): Promise<void> {
    render(<App />);
    await settle(50);
    act(() => {
      useAppStore.getState().layoutActions.applyCenterLayout({
        ...EMPTY_LAYOUT_PREFS,
        views: [
          {
            id: "view-restart",
            name: "View 1",
            layout: {
              type: "split",
              orientation: "row",
              sizes: [0.5, 0.5],
              children: [
                { type: "leaf", terminals: [{ terminalId: A, customTitle: null }], activeTerminalId: A },
                { type: "leaf", terminals: [{ terminalId: B, customTitle: "release-checker" }], activeTerminalId: B },
              ],
            },
          },
        ],
        activeViewId: "view-restart",
      });
    });
    await settle(50);
    act(() => {
      const fleet = useAppStore.getState().agentActions;
      fleet.applyFleetSnapshot([restoredAgent(A), restoredAgent(B)]);
      useAppStore.getState().layoutActions.rebuildTerminalTabs([liveTerminal(A), liveTerminal(B)]);
      fleet.applyRestoredAgents([
        { agentId: A, outcome: "resumed", wasWorking: true },
        { agentId: B, outcome: "fresh", wasWorking: false },
      ]);
    });
    await settle(500);

    // The scene is the E2E's: two panes, A on the left NOT focused, both on WebGL, both re-attached.
    const left = document.querySelector<HTMLElement>(`.terminal-view[data-terminal-id="${A}"]`)!;
    const right = document.querySelector<HTMLElement>(`.terminal-view[data-terminal-id="${B}"]`)!;
    expect(left.getBoundingClientRect().right).toBeLessThanOrEqual(right.getBoundingClientRect().left + 1);
    expect(left.contains(document.activeElement), "A must not be the focused terminal").toBe(false);
    expect([getRendererKind(asTerminalId(A)), getRendererKind(asTerminalId(B))]).toEqual(["webgl", "webgl"]);
    expect([...ring.keys()].sort()).toEqual([A, B].sort());
  }

  it("on screen: A's pixels show the replayed banner on its first row, and nothing below", async () => {
    await restoreSideBySide();
    ring.get(B)!.send(BANNER);
    ring.get(A)!.send(BANNER);
    await settle(SETTLE_REPAINT_MS * 4);

    // The screen as the browser composited it — a screenshot of A's terminal, not a buffer read.
    const screen = document.querySelector<HTMLElement>(`.terminal-view[data-terminal-id="${A}"] .xterm-screen`)!;
    const rows = getTerminal(asTerminalId(A))!.rows;
    const onScreen = async (): Promise<{ row0: number; row3: number; size: string }> => {
      const png = await page.screenshot({ element: screen, save: false });
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return { ...rows0and3(ctx.getImageData(0, 0, c.width, c.height), rows), size: `${c.width}x${c.height}` };
    };

    // Polled: under a loaded run (the whole browser tier at once) the compositor can trail the
    // draw by a frame or two; what must hold is that the banner ARRIVES on A's screen.
    await expect
      .poll(async () => (await onScreen()).row0, { timeout: 3_000, interval: 150 })
      .toBeGreaterThan(50);
    const shot = await onScreen();
    expect(shot.row3, `a row the replay never reached stays empty (${shot.size})`).toBe(0);
  });

  it("on a canvas shown one draw late (WebKitGTK), A's screen still ends on the replay — and then A is quiet", async () => {
    await restoreSideBySide();
    const term = getTerminal(asTerminalId(A))!;
    const gl = webglCanvasOf(A);
    // Every frame A draws, copied off its real WebGL canvas in the same task it was drawn in.
    const frames: { row0: number; row3: number }[] = [];
    const copy = document.createElement("canvas");
    const watch = term.onRender(() => {
      copy.width = gl.width;
      copy.height = gl.height;
      const ctx = copy.getContext("2d")!;
      ctx.drawImage(gl, 0, 0);
      frames.push(rows0and3(ctx.getImageData(0, 0, copy.width, copy.height), term.rows));
    });

    ring.get(A)!.send(BANNER);
    await settle(SETTLE_REPAINT_MS * 4);
    const settled = frames.length;

    // The replay was drawn: the newest frame shows the banner, on its row only…
    expect(frames[settled - 1]).toEqual({ row0: expect.any(Number), row3: 0 });
    expect(frames[settled - 1].row0).toBeGreaterThan(50);
    // …and the frame a one-draw-late screen shows — the one before the newest — shows it too,
    // not the empty frame from before the replay.
    expect(frames[settled - 2]?.row0 ?? 0, "the banner on the lagging screen's frame").toBeGreaterThan(50);

    // The budget: ONE extra frame, then nothing — an unfocused terminal that is
    // done drawing stays done, however long it sits there.
    await settle(SETTLE_REPAINT_MS * 6);
    watch.dispose();
    expect(frames.length, "frames drawn after A settled").toBe(settled);
  });
});
