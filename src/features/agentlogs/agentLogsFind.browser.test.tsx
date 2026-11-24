/**
 * ⌘F in the Logs view — real layout in Chromium.
 *
 * jsdom stores `scrollTop` but lays nothing out, so there a reveal can only be checked as a
 * number. Only here can it be checked as what the user sees: the match's row is inside
 * the list's visible box, below the sticky header, painted. And the assertions read the
 * REAL scroll element — the `alog-list` box the app scrolls — never a wrapper nothing
 * scrolls: the list starts at the tail (follow), the match is 500 rows above
 * it and windowed out of the DOM, so a reveal that did nothing leaves no mark to measure.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts src/features/agentlogs`
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../App.css";

const ipc = vi.hoisted(() => ({ snapshot: [] as unknown[] }));
vi.mock("./logstreamIpc", () => ({
  logstreamSnapshot: () => Promise.resolve(ipc.snapshot),
  logstreamClear: () => Promise.resolve(),
  onLogstreamLines: () => Promise.resolve(() => {}),
  syslogStatus: () => Promise.reject(new Error("not in this test")),
  syslogSet: () => Promise.reject(new Error("not in this test")),
  syslogApps: () => Promise.resolve([]),
}));

import { useColumnLayoutStore } from "../../components/columns";
import { AgentLogsPanel } from "./AgentLogsPanel";
import { resetAgentLogsForTests } from "./agentLogsStore";
import type { LogLine } from "./agentLogsTypes";

const L = (id: number, text: string, p: Partial<LogLine> = {}): LogLine => ({
  id, tsMs: new Date(2026, 8, 28, 10, 0, 0, 0).getTime(), terminalId: null, agentId: null,
  source: "gazelle", kind: "output", level: "info", text, detail: null, toolUseId: null, ...p,
});

const LINES: LogLine[] = [
  ...Array.from({ length: 2000 }, (_, i) => L(i + 1, i + 1 === 1500 ? "listening NEEDLE_ONE on :8080" : `filler line ${i + 1}`)),
  // A block whose only hit is behind its fold (line 5 of 6).
  L(2001, "Bash: tail gazelle.log", { kind: "tool", source: "claude · gazelle", agentId: "a1", toolUseId: "tu1" }),
  L(2002, "Bash → x", {
    kind: "tool-result", source: "claude · gazelle", agentId: "a1", toolUseId: "tu1",
    detail: "o0\no1\no2\no3\nNEEDLE_TWO deep in the fold\no5",
  }),
  ...Array.from({ length: 400 }, (_, i) => L(3000 + i, `tail filler ${i}`)),
];

const list = () => screen.getByTestId("alog-list");
const input = () => screen.getByTestId("alog-find-input") as HTMLInputElement;
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

async function mount(): Promise<void> {
  ipc.snapshot = LINES;
  render(
    <div style={{ width: 1200, height: 600, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <AgentLogsPanel />
    </div>,
  );
  await screen.findAllByTestId("alog-row");
  await tick();
}

/** The current match is inside the list's visible box, below the sticky header. */
function assertInView(el: Element): void {
  const box = list().getBoundingClientRect();
  const head = screen.getByTestId("alog-head").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  expect(r.height).toBeGreaterThan(0);
  expect(r.top, "under the sticky header").toBeGreaterThanOrEqual(head.bottom - 1);
  expect(r.bottom, "above the list's bottom edge").toBeLessThanOrEqual(box.bottom + 1);
}

beforeEach(() => {
  resetAgentLogsForTests();
  useColumnLayoutStore.setState({ layouts: {} });
});
afterEach(() => {
  cleanup();
  resetAgentLogsForTests();
});

describe("⌘F reveal in the Logs list (real layout)", () => {
  it("scrolls the real list box from the tail up to a windowed-out match, which is then visible and painted", async () => {
    await mount();
    const startTop = list().scrollTop;
    // Follow put the list at the tail: the match's row is not even in the DOM.
    expect(startTop).toBeGreaterThan(30_000);
    expect(document.querySelector('[data-testid="alog-row"][data-id="1500"]')).toBeNull();

    const row = screen.getAllByTestId("alog-row")[0];
    row.focus();
    fireEvent.keyDown(row, { key: "f", metaKey: true });
    await tick();
    expect(document.activeElement).toBe(input());
    fireEvent.change(input(), { target: { value: "needle_one" } });
    await tick();

    expect(screen.getByTestId("alog-find-count")).toHaveTextContent("1/1");
    // Not a no-op: the REAL scroll element moved, a long way up.
    expect(list().scrollTop).toBeLessThan(startTop - 5_000);
    const hot = screen.getByTestId("alog-find-current");
    expect(hot.closest('[data-testid="alog-row"]')).toHaveAttribute("data-id", "1500");
    assertInView(hot);
    // Highlighted for real: the current mark has an opaque background of its own.
    const bg = getComputedStyle(hot).backgroundColor;
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    expect(hot.getBoundingClientRect().width).toBeGreaterThan(20);
  });

  it("a hit behind a fold: the block expands and the list scrolls to the output row, which is visible", async () => {
    await mount();
    const row = screen.getAllByTestId("alog-row")[0];
    row.focus();
    fireEvent.keyDown(row, { key: "f", ctrlKey: true });
    await tick();
    fireEvent.change(input(), { target: { value: "NEEDLE" } });
    await tick();
    expect(screen.getByTestId("alog-find-count")).toHaveTextContent("1/2");
    fireEvent.keyDown(input(), { key: "Enter" });
    await tick();
    expect(screen.getByTestId("alog-find-count")).toHaveTextContent("2/2");
    const hot = screen.getByTestId("alog-find-current");
    const out = hot.closest('[data-testid="alog-block-out"]') as HTMLElement;
    expect(out).toHaveAttribute("data-index", "4");
    assertInView(hot);
    // Stepping back wraps up to match 1, 500 rows above — visible again.
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    await tick();
    expect(screen.getByTestId("alog-find-current").closest('[data-testid="alog-row"]')).toHaveAttribute("data-id", "1500");
    assertInView(screen.getByTestId("alog-find-current"));
    // Esc restores the fold: back at the block, it shows 3 output lines again.
    fireEvent.keyDown(input(), { key: "Escape" });
    await tick();
    list().scrollTop = 2001 * 18;
    // The windowed list re-renders on the scroll event; under a loaded full run 30 ms was not always
    // enough, so wait for the window to reach the block — same assertion.
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="alog-block-out"]')).toHaveLength(3), {
      timeout: 3_000,
      interval: 30,
    });
  });

  it("the subtle mark is painted and differs from the current one", async () => {
    await mount();
    const row = screen.getAllByTestId("alog-row")[0];
    row.focus();
    fireEvent.keyDown(row, { key: "f", metaKey: true });
    await tick();
    // "filler" matches nearly every row: match 1 is the first row, the rows under it carry
    // subtle marks, all in view together.
    fireEvent.change(input(), { target: { value: "filler" } });
    await tick();
    expect(list().scrollTop).toBe(0);
    const subtle = screen.getAllByTestId("alog-find-hit")[0];
    const hot = screen.getByTestId("alog-find-current");
    assertInView(hot);
    const sb = getComputedStyle(subtle).backgroundColor;
    expect(sb).not.toBe("rgba(0, 0, 0, 0)");
    expect(sb).not.toBe(getComputedStyle(hot).backgroundColor);
  });
});
