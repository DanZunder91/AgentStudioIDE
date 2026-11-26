/** Logs columns in real Chromium layout: a column holds its width on every row, and a block's
 * nested rows keep the raw row's grid. jsdom has no layout. */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../App.css";

const ipc = vi.hoisted(() => ({
  snapshot: [] as unknown[],
}));
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

const L = (id: number, source: string, text: string, p: Partial<LogLine> = {}): LogLine => ({
  id, tsMs: new Date(2026, 8, 24, 20, 58, 58, 123).getTime(), terminalId: null, agentId: null,
  source, kind: "output", level: "info", text, detail: null, toolUseId: null, ...p,
});

const SOURCES = ["c", "claude · gazelle", "claude · gazelle-service-with-a-really-long-name"];

async function mount(width = 1200): Promise<void> {
  ipc.snapshot = [
    L(1, SOURCES[0], "short"),
    L(2, SOURCES[1], "x".repeat(600)),
    L(3, SOURCES[2], "a medium line of text"),
    L(4, SOURCES[0], "y".repeat(2000)),
    // A command block: a call and its result, with more output than the fold shows.
    L(5, SOURCES[1], "Bash: cargo test --lib", { kind: "tool", agentId: "a1", toolUseId: "tu5", detail: "Run the unit tests" }),
    L(6, SOURCES[1], "Bash → running 3 tests", {
      kind: "tool-result", agentId: "a1", toolUseId: "tu5",
      detail: "$ cargo test --lib\n\nrunning 3 tests\ntest a ... ok\ntest b ... ok\ntest c ... ok\ntest result: ok",
    }),
    // A lifecycle divider.
    L(7, SOURCES[0], "terminal exited (code 0)", { kind: "system", level: "warn" }),
  ];
  render(
    <div style={{ width, height: 600, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <AgentLogsPanel />
    </div>,
  );
  await screen.findAllByTestId("alog-row");
}

const srcCells = () => [...document.querySelectorAll<HTMLElement>('[data-testid="alog-row"] .alog-src')];
const widthOf = (el: Element) => el.getBoundingClientRect().width;
const leftOf = (el: Element) => el.getBoundingClientRect().left;
const headCell = (col: string) => document.querySelector<HTMLElement>(`.alog-head__cell[data-col="${col}"]`);
const ROW_H = 18;

beforeEach(() => {
  resetAgentLogsForTests();
  useColumnLayoutStore.setState({ layouts: {} });
});
afterEach(() => {
  cleanup();
  resetAgentLogsForTests();
});

describe("Agent Logs columns (real layout)", () => {
  it("the Source column is the same width on every row, whatever the source or text length", async () => {
    await mount();
    const cells = srcCells();
    expect(cells).toHaveLength(4);
    for (const c of cells) expect(widthOf(c), c.textContent ?? "").toBe(140);
    // …and lines up with its header cell.
    expect(widthOf(headCell("source")!)).toBe(140);
    const left = headCell("source")!.getBoundingClientRect().left;
    for (const c of cells) expect(c.getBoundingClientRect().left).toBe(left);
    // `claude · gazelle` fits the default width; a longer label ellipsizes (title carries it).
    const [, gazelle, long] = cells;
    expect(gazelle.scrollWidth, "claude · gazelle must not be clipped").toBeLessThanOrEqual(gazelle.clientWidth);
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    expect(long.title).toContain(SOURCES[2]);
    // The Text column takes the rest of the row (the sidebar has its default 280 px beside the list).
    const text = document.querySelector<HTMLElement>('[data-testid="alog-row"] .alog-text')!;
    expect(widthOf(text)).toBeGreaterThan(600);
    expect(widthOf(screen.getByTestId("alog-sidebar"))).toBe(280);
  });

  it("a command block keeps the column grid: its header's Source cell and its output rows' text line up with a raw row's", async () => {
    await mount();
    const rawText = document.querySelector<HTMLElement>('[data-testid="alog-row"] .alog-text')!;
    const head = screen.getByTestId("alog-block-head");
    const headSrc = head.querySelector<HTMLElement>(".alog-src")!;
    const headText = head.querySelector<HTMLElement>(".alog-text")!;
    // The header row is on the same grid as a raw row: same Source width and left edge, same Text left edge.
    expect(widthOf(headSrc)).toBe(140);
    expect(leftOf(headSrc)).toBe(leftOf(headCell("source")!));
    expect(leftOf(headText)).toBe(leftOf(rawText));
    expect(widthOf(headText)).toBe(widthOf(rawText));
    // The nested output rows: DIM time/level/source cells hold the grid — same
    // left edges and widths as the header's — and the text cell starts where every Text cell does.
    const outs = [...document.querySelectorAll<HTMLElement>('[data-testid="alog-block-out"]')];
    expect(outs).toHaveLength(3); // folded to 3 of 5 lines
    const headTime = head.querySelector<HTMLElement>(".alog-time")!;
    for (const o of outs) {
      const t = o.querySelector<HTMLElement>(".alog-text")!;
      expect(leftOf(t), o.textContent ?? "").toBe(leftOf(rawText));
      expect(widthOf(t)).toBe(widthOf(rawText));
      expect(o.getBoundingClientRect().height).toBe(ROW_H);
      const src = o.querySelector<HTMLElement>(".alog-src")!;
      expect(src.textContent).toBe(SOURCES[1]);
      expect(widthOf(src)).toBe(140);
      expect(leftOf(src)).toBe(leftOf(headSrc));
      expect(leftOf(o.querySelector<HTMLElement>(".alog-time")!)).toBe(leftOf(headTime));
      // Really dimmed, not just classed.
      expect(Number(getComputedStyle(src).opacity)).toBeLessThan(0.6);
      expect(Number(getComputedStyle(headSrc).opacity)).toBe(1);
    }
    // Every row of the block — header, 3 output rows, the fold row — is exactly one row tall,
    // so the windowing's `rows × ROW_H` arithmetic is the truth on screen.
    const more = screen.getByTestId("alog-block-more");
    expect(head.getBoundingClientRect().height).toBe(ROW_H);
    expect(more.getBoundingClientRect().height).toBe(ROW_H);
    expect(more.getBoundingClientRect().top - head.getBoundingClientRect().top).toBe(4 * ROW_H);
    // The divider spans the full grid width on one row, its text centred between the rules.
    const divider = screen.getByTestId("alog-divider");
    expect(divider.getBoundingClientRect().height).toBe(ROW_H);
    const inner = divider.querySelector<HTMLElement>(".alog-divider__inner")!;
    expect(widthOf(inner)).toBe(widthOf(divider) - 20); // the row's 10 px side padding
    const [ruleL, ruleR] = [...divider.querySelectorAll<HTMLElement>(".alog-divider__rule")];
    expect(Math.abs(widthOf(ruleL) - widthOf(ruleR))).toBeLessThanOrEqual(1);
    // Expanding the block adds two rows and moves the divider down by exactly 2 × ROW_H.
    const before = divider.getBoundingClientRect().top;
    fireEvent.click(screen.getByRole("button", { name: "show 2 more" }));
    await screen.findByRole("button", { name: "show less" });
    expect(document.querySelectorAll('[data-testid="alog-block-out"]')).toHaveLength(5);
    expect(screen.getByTestId("alog-divider").getBoundingClientRect().top - before).toBe(2 * ROW_H);
  });

  it("one source selected: the Source column stays exactly where it was; a one-row stream header sits above the list", async () => {
    await mount();
    const textBefore = widthOf(document.querySelector<HTMLElement>('[data-testid="alog-row"] .alog-text')!);
    const listTop = screen.getByTestId("alog-list").getBoundingClientRect().top;
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="alog-src-row"]')].find((r) => r.dataset.source === "c")!;
    fireEvent.click(row.querySelector("button")!);
    await screen.findByText("c ▾");
    expect(widthOf(headCell("source")!)).toBe(140);
    expect(srcCells().length).toBeGreaterThan(0);
    for (const c of srcCells()) expect(widthOf(c)).toBe(140);
    const textAfter = widthOf(document.querySelector<HTMLElement>('[data-testid="alog-row"] .alog-text')!);
    expect(textAfter).toBe(textBefore);
    const header = screen.getByTestId("alog-stream-head");
    const h = header.getBoundingClientRect();
    // One line, never wrapped: the 16 px line + the link's 2 px border + 2 × 3 px padding + 1 px rule.
    expect(h.height).toBe(25);
    // The header takes its row from the list's flex share, above it.
    const list = screen.getByTestId("alog-list").getBoundingClientRect();
    expect(list.top).toBe(h.bottom);
    expect(list.top - listTop).toBe(h.height);
  });

  it("a block header with a 200-char command: the description shows whole, the command really clips with an ellipsis, the stream link stays in view", async () => {
    const OUT = "/private/tmp/claude-501/-work-gazelle/sess/tasks/bgen1a2b3.output";
    const LONG = `S=${OUT}; cp $S /work/gazelle/logs/${"x".repeat(180)}.log`;
    ipc.snapshot = [
      L(1, "gazelle · bg", "INFO up", { kind: "task", detail: `./gazelle serve\n${OUT}` }),
      L(2, "claude · gazelle", `Bash: ${LONG}`, { kind: "tool", agentId: "a1", toolUseId: "tuL", detail: "Copy the service log aside" }),
      L(3, "claude · gazelle", `Bash: ${LONG}`, { kind: "tool", agentId: "a1", toolUseId: "tuN" }),
    ];
    render(
      <div style={{ width: 1000, height: 600, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <AgentLogsPanel />
      </div>,
    );
    const [described, bare] = await screen.findAllByTestId("alog-block-head");
    for (const head of [described, bare]) {
      expect(head.getBoundingClientRect().height).toBe(ROW_H);
      const cell = head.querySelector<HTMLElement>(".alog-block__cmd")!;
      const label = head.querySelector<HTMLElement>(".alog-block__label")!;
      // Clipped for real: the label's content is wider than its box, and the box ends inside the cell.
      expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
      expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
      expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(cell.getBoundingClientRect().right);
      // The link sits inside the cell, at its right edge, not pushed out.
      const link = head.querySelector<HTMLElement>('[data-testid="alog-block-stream"]')!;
      expect(link.textContent).toBe("→ open gazelle stream");
      expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(cell.getBoundingClientRect().right + 0.5);
      expect(link.getBoundingClientRect().left).toBeGreaterThanOrEqual(label.getBoundingClientRect().right);
    }
    // The description is first and whole.
    const desc = described.querySelector<HTMLElement>(".alog-block__desc")!;
    expect(desc.scrollWidth).toBeLessThanOrEqual(desc.clientWidth);
    expect(desc.getBoundingClientRect().left).toBeLessThan(described.querySelector<HTMLElement>(".alog-block__label")!.getBoundingClientRect().left);
    expect(getComputedStyle(desc).fontWeight).toBe("600");
    expect(getComputedStyle(described.querySelector<HTMLElement>(".alog-block__label")!).fontWeight).toBe("400");
    expect(getComputedStyle(bare.querySelector<HTMLElement>(".alog-block__label")!).fontWeight).toBe("600");
  });

  it("dragging the Source resizer widens the column on the header and every row", async () => {
    await mount();
    const handle = screen.getByRole("separator", { name: "Resize Source column" });
    const x0 = handle.getBoundingClientRect().left;
    act(() => {
      fireEvent.pointerDown(handle, { clientX: x0, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: x0 + 60, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: x0 + 60, pointerId: 1 });
    });
    expect(widthOf(headCell("source")!)).toBe(200);
    for (const c of srcCells()) expect(widthOf(c)).toBe(200);
    // The long label now has more room than before, and still no row's text moved it.
    expect(handle.getBoundingClientRect().left).toBeGreaterThan(x0 + 50);
  });

  it("hiding Level removes its cells and its header, and the Source column moves left", async () => {
    await mount();
    const before = srcCells()[0].getBoundingClientRect().left;
    fireEvent.click(screen.getByRole("button", { name: "Columns ▾" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Level" }));
    expect(document.querySelectorAll('[data-testid="alog-row"] .alog-badge')).toHaveLength(0);
    expect(headCell("level")).toBeNull();
    // Level (40px) + one 8px gap are gone.
    expect(srcCells()[0].getBoundingClientRect().left).toBe(before - 48);
  });

  it("a narrow pane scrolls sideways rather than squeezing a column to nothing", async () => {
    await mount(600);
    for (const c of srcCells()) expect(widthOf(c)).toBe(140);
    const text = document.querySelector<HTMLElement>('[data-testid="alog-row"] .alog-text')!;
    expect(widthOf(text)).toBeGreaterThanOrEqual(160);
    const list = screen.getByTestId("alog-list");
    expect(list.scrollWidth).toBeGreaterThan(list.clientWidth);
  });
});
