/**
 * Layer 5 (testing-strategy §1, §7.5) — the PTY never learns a bogus size.
 *
 * ## The bug this pins
 *
 * `attach()` fits synchronously, and inside `allotment` the host has **no size
 * yet** at that moment (allotment learns its geometry from ResizeObserver, which
 * has not delivered). The obvious guard — "skip if proposeDimensions() came back
 * empty" — does not work, and the reason is worth stating because it is not
 * guessable:
 *
 *   FitAddon does NOT return undefined for a zero-size host. It clamps:
 *     cols: Math.max(MINIMUM_COLS /* 2 *\/, Math.floor(availableWidth  / cellW))
 *     rows: Math.max(MINIMUM_ROWS /* 1 *\/, Math.floor(availableHeight / cellH))
 *   With no layout, availableWidth is negative (0 minus padding minus the 14px
 *   scrollbar), so it hands back exactly `{cols: 2, rows: 1}` — which sails past
 *   any `>= 1` sanity check.
 *
 * So we pushed `terminal_resize(rows: 1, cols: 2)` down the PTY on every
 * structural change (each split/drag/reorder remounts the allotment subtree and
 * every xterm host with it). With a shell that is invisible — a prompt reflows.
 * With `claude` in the terminal (M2) it is not: a TUI told it has 2 columns
 * redraws its whole interface — boxes, tables, status lines — 2 characters wide.
 *
 * ## Why this file asserts the journey, not the destination
 *
 * The settled state is *correct* — the ResizeObserver lands ~50ms later and
 * fits properly. The bug lives entirely in the transient, so a test that only
 * samples the end state passes while the child is being wrecked. Every command
 * is therefore recorded and the **whole timeline** is asserted, per phase.
 */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../../App";
import { useAppStore } from "../../app/store";
import { disposeAll } from "../../features/terminal";
import type { PaneId, TabId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  bodyOf,
  dragTabToEdge,
  leafPaneIds,
  paneOfTab,
  panes,
  tabElement,
} from "../../test/layout-browser";
import { resetStore } from "../../test/store-harness";

const FIT_DEBOUNCE_MS = 50;

/** FitAddon's clamp floor — the fingerprint of "could not measure". */
const FIT_MIN_COLS = 2;
const FIT_MIN_ROWS = 1;

async function settle(ms = FIT_DEBOUNCE_MS * 6): Promise<void> {
  await act(async () => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

function openTab(paneId?: PaneId): TabId {
  let id!: TabId;
  act(() => {
    id = useAppStore.getState().layoutActions.openTerminalTab(paneId ? { paneId } : undefined);
  });
  return id;
}

function splitPane(paneId: PaneId, orientation: "row" | "column"): PaneId {
  let id!: PaneId;
  act(() => {
    id = useAppStore.getState().layoutActions.splitPane(paneId, orientation);
  });
  return id;
}

/** One sizing command as Rust would have received it. */
interface SizingCall {
  cmd: "terminal_open" | "terminal_resize";
  terminalId: string;
  rows: number;
  cols: number;
  /** Which phase of the lifecycle it landed in — makes a failure legible. */
  phase: string;
}

describe("terminal fit — the PTY never sees a degenerate size", () => {
  let ipc: TauriMock;
  let sizing: SizingCall[];
  let phase: string;

  const record = (cmd: SizingCall["cmd"], args: Record<string, unknown>): void => {
    sizing.push({
      cmd,
      terminalId: String(args.terminalId),
      rows: Number(args.rows),
      cols: Number(args.cols),
      phase,
    });
  };

  /** Every sizing command ever dispatched that carried a degenerate size. */
  const degenerate = (): SizingCall[] =>
    sizing.filter((c) => c.cols <= FIT_MIN_COLS || c.rows <= FIT_MIN_ROWS);

  const report = (): string =>
    sizing.map((c) => `${c.phase}: ${c.cmd} ${c.cols}x${c.rows}`).join("\n") || "(none)";

  beforeEach(() => {
    resetStore();
    sizing = [];
    phase = "init";
    ipc = installTauriMock();
    ipc
      .handle("terminal_open", (args) => {
        record("terminal_open", args);
        return {
          id: args.terminalId,
          kind: "terminal",
          title: "sh",
          cwd: args.cwd,
          cols: args.cols,
          rows: args.rows,
          status: "live",
        };
      })
      .handle("terminal_resize", (args) => {
        record("terminal_resize", args);
        return null;
      })
      .handle("terminal_write", () => null)
      .handle("terminal_close", () => null);
  });

  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  it("never sends a degenerate size across mount → attach → split → settle", async () => {
    // ── phase 1: first mount + attach (host is 0x0 at attach time) ──
    phase = "mount";
    render(<App />);
    await settle();

    phase = "open-first-tab";
    const rootLeaf = leafPaneIds()[0];
    openTab(rootLeaf);
    await settle();

    expect(
      degenerate(),
      `degenerate sizing during initial mount:\n${report()}`,
    ).toEqual([]);

    // ── phase 2: a split — remounts the allotment subtree and every xterm host ──
    phase = "split-row";
    const paneB = splitPane(rootLeaf, "row");
    openTab(paneB);
    await settle();

    expect(
      degenerate(),
      `degenerate sizing during split:\n${report()}`,
    ).toEqual([]);

    // ── phase 3: a nested split — remounts again, deeper ──
    phase = "split-column";
    const paneC = splitPane(paneB, "column");
    openTab(paneC);
    await settle();

    // ── the whole journey, not just where it ended up ──
    expect(
      degenerate(),
      `degenerate sizing somewhere in the lifecycle:\n${report()}`,
    ).toEqual([]);

    // Guard against the assertion passing vacuously: if nothing was ever
    // dispatched, the filter above is trivially empty and proves nothing.
    expect(sizing.length, "no sizing commands were recorded at all").toBeGreaterThan(0);
    expect(panes().length).toBe(3);
  });

  /**
   * NOT the regression test — be clear about this.
   *
   * Measured: with both guards removed, this case still passes. The drag lands
   * a tab into a pane that is already laid out, so the host is never 0-width at
   * attach and the bug does not manifest on this path. Only the split cases
   * above fail before the fix.
   *
   * It is kept anyway: it asserts the same invariant across the gesture the
   * user actually performs, and would catch a *future* regression that broke
   * the drag path specifically. It just must not be mistaken for proof.
   */
  it("holds the invariant while dragging a tab between panes", async () => {
    phase = "mount";
    render(<App />);
    await settle();

    const rootLeaf = leafPaneIds()[0];
    phase = "setup";
    const tabA = openTab(rootLeaf);
    const paneB = splitPane(rootLeaf, "row");
    const tabB = openTab(paneB);
    await settle();

    expect(degenerate(), `degenerate sizing during setup:\n${report()}`).toEqual([]);

    phase = "drag";
    await dragTabToEdge(tabElement(tabA), bodyOf(paneOfTab(tabB)), "bottom");
    await settle();

    expect(
      degenerate(),
      `degenerate sizing during a tab drag:\n${report()}`,
    ).toEqual([]);
    expect(sizing.length).toBeGreaterThan(0);
  });

  it("opens every PTY at a real size, never FitAddon's 2x1 clamp floor", async () => {
    // Distinct from the resize path: attach() fits synchronously *before*
    // scheduleOpen's setTimeout(0) fires, so a bogus fit corrupts term.rows/cols
    // and the PTY is *created* at 2x1 — worse than being resized to it.
    phase = "mount";
    render(<App />);
    await settle();

    phase = "open";
    const rootLeaf = leafPaneIds()[0];
    openTab(rootLeaf);
    splitPane(rootLeaf, "row");
    await settle();

    const opens = sizing.filter((c) => c.cmd === "terminal_open");
    expect(opens.length, "expected at least one terminal_open").toBeGreaterThan(0);
    for (const o of opens) {
      expect(
        o.cols > FIT_MIN_COLS && o.rows > FIT_MIN_ROWS,
        `terminal_open created a PTY at ${o.cols}x${o.rows}:\n${report()}`,
      ).toBe(true);
    }
  });

  it("settles every terminal at the size its pane actually has", async () => {
    // The destination still has to be right — a fix that simply never resizes
    // would pass the two tests above while breaking sizing entirely.
    phase = "mount";
    render(<App />);
    await settle();

    const rootLeaf = leafPaneIds()[0];
    openTab(rootLeaf);
    const paneB = splitPane(rootLeaf, "row");
    openTab(paneB);
    await settle();

    const live = sizing.filter((c) => c.cmd === "terminal_resize" || c.cmd === "terminal_open");
    const lastPerTerminal = new Map<string, SizingCall>();
    for (const c of live) lastPerTerminal.set(c.terminalId, c);

    expect(lastPerTerminal.size).toBeGreaterThan(0);
    for (const [id, c] of lastPerTerminal) {
      // Two panes in a 1280px viewport ≈ 600px each ≈ 70+ cols. Anything near
      // the clamp floor means we never really fitted.
      expect(c.cols, `terminal ${id} settled at only ${c.cols} cols:\n${report()}`).toBeGreaterThan(20);
      expect(c.rows, `terminal ${id} settled at only ${c.rows} rows:\n${report()}`).toBeGreaterThan(5);
    }
  });
});
