/**
 * LogsPanel — the diagnostics-log overlay.
 *
 * Covers: closed-by-default, the empty state, newest-first rendering, the level +
 * text filters, Clear, Copy (mocked clipboard + the missing-clipboard guard), and
 * every close path (Esc, the ✕, the backdrop) plus that an inside click does NOT.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { filterEntries, formatEntry, useLogStore } from "./logStore";
import { LogsPanel } from "./LogsPanel";

const panel = () => screen.queryByTestId("logs-panel");
const rowMessages = (): string[] =>
  Array.from(document.querySelectorAll(".logs-row__msg")).map((n) => n.textContent ?? "");

function resetLogStore(): void {
  useLogStore.setState({ entries: [], visible: false, levelFilter: "all", textFilter: "", nextId: 0 });
}

const seed = (): void => {
  const s = useLogStore.getState();
  s.append({ level: "info", source: "agent", message: "a1 started" });
  s.append({ level: "event", source: "agent", message: "a1 → waiting_input" });
  s.append({ level: "error", source: "bridge", message: "snapshot failed", detail: "boom" });
};

beforeEach(() => resetLogStore());
afterEach(cleanup);

describe("LogsPanel", () => {
  it("is closed by default", () => {
    render(<LogsPanel />);
    expect(panel()).toBeNull();
  });

  it("renders the calm empty state when visible with no entries", () => {
    useLogStore.getState().show();
    render(<LogsPanel />);
    expect(panel()).toBeInTheDocument();
    expect(screen.getByText("No log entries yet.")).toBeInTheDocument();
  });

  it("renders entries newest-first", () => {
    seed();
    useLogStore.getState().show();
    render(<LogsPanel />);
    expect(rowMessages()).toEqual(["snapshot failed", "a1 → waiting_input", "a1 started"]);
  });

  it("narrows by the level filter", () => {
    seed();
    useLogStore.getState().show();
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "error" }));
    expect(rowMessages()).toEqual(["snapshot failed"]);
  });

  it("narrows by the text filter", () => {
    seed();
    useLogStore.getState().show();
    render(<LogsPanel />);
    fireEvent.change(screen.getByLabelText("Filter log text"), { target: { value: "waiting" } });
    expect(rowMessages()).toEqual(["a1 → waiting_input"]);
  });

  it("Clear empties the feed", () => {
    seed();
    useLogStore.getState().show();
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(rowMessages()).toEqual([]);
    expect(screen.getByText("No log entries yet.")).toBeInTheDocument();
  });

  it("Copy writes the visible entries as text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    seed();
    useLogStore.getState().show();
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    const { entries, levelFilter, textFilter } = useLogStore.getState();
    const expected = filterEntries(entries, levelFilter, textFilter).slice().reverse().map(formatEntry).join("\n");
    expect(writeText).toHaveBeenCalledWith(expected);
    // Sanity: the copied text carries the status transition line.
    expect(writeText.mock.calls[0][0]).toContain("a1 → waiting_input");
  });

  it("swallows a clipboard rejection (Copy never throws out of the click)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    seed();
    useLogStore.getState().show();
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    // The rejection is caught by the noop — no unhandled rejection escapes.
    await expect(writeText.mock.results[0].value).rejects.toThrow("denied");
  });

  it("Copy is a no-op when navigator.clipboard is unavailable (no throw)", () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    seed();
    useLogStore.getState().show();
    render(<LogsPanel />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Copy" }))).not.toThrow();
  });

  it("closes on Escape, the ✕, and the backdrop — but not an inside click", () => {
    render(<LogsPanel />);
    const open = () => act(() => useLogStore.setState({ visible: true }));

    open();
    // An inside click does not close.
    fireEvent.click(screen.getByTestId("logs-panel"));
    expect(panel()).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel()).toBeNull();

    open();
    fireEvent.click(screen.getByLabelText("Close logs"));
    expect(panel()).toBeNull();

    open();
    fireEvent.click(screen.getByTestId("logs-backdrop"));
    expect(panel()).toBeNull();
  });

  it("ignores Escape while closed (no throw, stays closed)", () => {
    render(<LogsPanel />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel()).toBeNull();
    expect(useLogStore.getState().visible).toBe(false);
  });
});
