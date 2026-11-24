/** The Logs list's column set and its horizontal floor — values written by hand. */
import { describe, expect, it } from "vitest";

import { visibleColumns } from "../../components/columns";
import { LOG_COLUMNS, rowsMinWidth } from "./agentLogsColumns";

describe("LOG_COLUMNS", () => {
  it("Time · Level · Source · Text; only Text is required, and it is the one flex column", () => {
    expect(LOG_COLUMNS.map((c) => [c.id, c.width, c.required === true, c.flex === true])).toEqual([
      ["time", 92, false, false],
      ["level", 40, false, false],
      ["source", 140, false, false],
      ["text", 400, true, true],
    ]);
  });
});

describe("rowsMinWidth", () => {
  it("fixed widths + the flex floor + gaps + side padding", () => {
    const all = visibleColumns(LOG_COLUMNS, { widths: {}, hidden: [] });
    expect(rowsMinWidth(all)).toBe(92 + 40 + 140 + 160 + 3 * 8 + 20);
    const some = visibleColumns(LOG_COLUMNS, { widths: { source: 300 }, hidden: ["level"] });
    expect(rowsMinWidth(some)).toBe(92 + 300 + 160 + 2 * 8 + 20);
  });

  it("a flex column without its own floor uses the shared default; no columns is just the padding", () => {
    expect(rowsMinWidth([{ id: "x", label: "X", width: 10, flex: true, px: 10 }])).toBe(40 + 20);
    expect(rowsMinWidth([])).toBe(20);
  });
});
