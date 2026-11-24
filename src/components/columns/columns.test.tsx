/** Resizable + hideable columns: the store rules, the resizer, and the Columns menu. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_HIDDEN_TITLE,
  ColumnResizer,
  ColumnsMenu,
  DEFAULT_MIN_WIDTH,
  gridTemplate,
  resetColumnWidth,
  resetColumns,
  setColumnHidden,
  setColumnWidth,
  useColumnLayoutStore,
  visibleColumns,
  widthOf,
  type ColumnDef,
} from ".";

const DEFS: ColumnDef[] = [
  { id: "time", label: "Time", width: 80, required: true },
  { id: "host", label: "Host", width: 200, minWidth: 60 },
  { id: "path", label: "Path", width: 300, flex: true, minWidth: 120 },
];
const K = "test.view";
const layout = () => useColumnLayoutStore.getState().layouts[K] ?? { widths: {}, hidden: [] };

beforeEach(() => useColumnLayoutStore.setState({ layouts: {} }));
afterEach(cleanup);

describe("store rules", () => {
  it("widths default, are set, clamp to the column minimum (or the global one), and reset", () => {
    expect(widthOf(DEFS[1], layout())).toBe(200);
    setColumnWidth(K, DEFS[1], 333.6);
    expect(widthOf(DEFS[1], layout())).toBe(334);
    setColumnWidth(K, DEFS[1], 10);
    expect(widthOf(DEFS[1], layout())).toBe(60);
    setColumnWidth(K, { id: "x", label: "X", width: 50 }, 1);
    expect(layout().widths.x).toBe(DEFAULT_MIN_WIDTH);
    resetColumnWidth(K, "host");
    expect(widthOf(DEFS[1], layout())).toBe(200);
  });

  it("hides and shows; never a required column, never the last visible one, never twice", () => {
    setColumnHidden(K, DEFS, "time", true);
    expect(layout().hidden).toEqual([]);
    setColumnHidden(K, DEFS, "host", true);
    setColumnHidden(K, DEFS, "host", true);
    expect(layout().hidden).toEqual(["host"]);
    setColumnHidden(K, DEFS, "nope", true);
    expect(layout().hidden).toEqual(["host"]);
    const two: ColumnDef[] = [DEFS[1], DEFS[2]];
    setColumnHidden("k2", two, "host", true);
    setColumnHidden("k2", two, "path", true);
    expect(useColumnLayoutStore.getState().layouts.k2.hidden).toEqual(["host"]);
    setColumnHidden(K, DEFS, "host", false);
    expect(layout().hidden).toEqual([]);
  });

  it("visibleColumns + gridTemplate: order kept, hidden dropped, flex takes the rest", () => {
    setColumnHidden(K, DEFS, "host", true);
    const cols = visibleColumns(DEFS, layout());
    expect(cols.map((c) => [c.id, c.px])).toEqual([["time", 80], ["path", 300]]);
    expect(gridTemplate(cols)).toBe("80px minmax(120px, 1fr)");
    expect(gridTemplate([{ id: "a", label: "A", width: 10, flex: true, px: 40 }])).toBe(`minmax(${DEFAULT_MIN_WIDTH}px, 1fr)`);
    resetColumns(K);
    expect(layout()).toEqual({ widths: {}, hidden: [] });
  });
});

describe("ColumnResizer", () => {
  it("pointer drag resizes from the width at drag start; release stops it", () => {
    render(<ColumnResizer viewKey={K} def={DEFS[1]} width={200} />);
    const h = screen.getByRole("separator", { name: "Resize Host column" });
    fireEvent.pointerMove(h, { clientX: 500 });
    expect(layout().widths.host).toBeUndefined();
    fireEvent.pointerDown(h, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 150 });
    expect(layout().widths.host).toBe(250);
    fireEvent.pointerUp(h);
    fireEvent.pointerMove(h, { clientX: 400 });
    expect(layout().widths.host).toBe(250);
  });

  it("no key pressed on a focused handle reaches the table's own shortcuts", () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <ColumnResizer viewKey={K} def={DEFS[1]} width={200} />
      </div>,
    );
    const h = screen.getByRole("separator", { name: "Resize Host column" });
    fireEvent.keyDown(h, { key: "c" });
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("keyboard: ←/→ by 10, Shift by 40; other keys ignored; double-click resets", () => {
    render(<ColumnResizer viewKey={K} def={DEFS[1]} width={200} />);
    const h = screen.getByRole("separator", { name: "Resize Host column" });
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(layout().widths.host).toBe(210);
    fireEvent.keyDown(h, { key: "ArrowLeft", shiftKey: true });
    expect(layout().widths.host).toBe(160);
    fireEvent.keyDown(h, { key: "a" });
    expect(layout().widths.host).toBe(160);
    fireEvent.click(h);
    fireEvent.doubleClick(h);
    expect(layout().widths.host).toBeUndefined();
  });
});

describe("ColumnsMenu", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Columns ▾" }));
  const box = (name: string) => screen.getByRole("menuitemcheckbox", { name });

  it("ticks hide/show columns; required and last-visible are locked; Reset restores", () => {
    render(<ColumnsMenu viewKey={K} defs={DEFS} />);
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    expect(box("Time")).toBeDisabled();
    fireEvent.click(box("Host"));
    expect(layout().hidden).toEqual(["host"]);
    expect(box("Host")).not.toBeChecked();
    fireEvent.click(box("Host"));
    expect(layout().hidden).toEqual([]);
    fireEvent.click(box("Host"));
    fireEvent.click(screen.getByRole("button", { name: "Reset columns" }));
    expect(layout().hidden).toEqual([]);
  });

  it("a column the table hid to fit is listed unticked with why; ticking it records it as shown", () => {
    render(<ColumnsMenu viewKey={K} defs={DEFS} autoHidden={["host"]} />);
    open();
    expect(box("Host")).not.toBeChecked();
    expect(box("Host").closest("label")).toHaveAttribute("title", AUTO_HIDDEN_TITLE);
    expect(box("Path").closest("label")).not.toHaveAttribute("title");
    fireEvent.click(box("Host"));
    expect(layout().shown).toEqual(["host"]);
    // Hiding it again forgets the explicit show; showing twice records it once.
    act(() => setColumnHidden(K, DEFS, "host", true));
    expect(layout()).toMatchObject({ hidden: ["host"], shown: [] });
    act(() => setColumnHidden(K, DEFS, "host", false));
    act(() => setColumnHidden(K, DEFS, "host", false));
    expect(layout().shown).toEqual(["host"]);
  });

  it("the last visible column is locked", () => {
    const two: ColumnDef[] = [DEFS[1], DEFS[2]];
    render(<ColumnsMenu viewKey="k3" defs={two} />);
    act(() => setColumnHidden("k3", two, "host", true));
    open();
    expect(box("Path")).toBeDisabled();
  });

  it("Escape and an outside click close it; other keys and inside clicks do not", () => {
    render(<ColumnsMenu viewKey={K} defs={DEFS} />);
    open();
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.mouseDown(box("Host"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
