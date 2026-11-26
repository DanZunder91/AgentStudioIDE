import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CsvTable } from "./CsvTable";

afterEach(() => cleanup());

describe("CsvTable", () => {
  it("renders a header row and body rows with the right cell counts", () => {
    render(<CsvTable text={"name,age,city\nAda,36,London\nBrian,41,Dublin"} />);

    const table = screen.getByTestId("csv-table");
    expect(table).toBeInTheDocument();

    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["name", "age", "city"]);

    const bodyRows = (table.querySelector("tbody") as HTMLElement).querySelectorAll("tr");
    expect(bodyRows).toHaveLength(2);
    expect(within(bodyRows[0] as HTMLElement).getAllByRole("cell")).toHaveLength(3);
    expect(within(bodyRows[1] as HTMLElement).getAllByRole("cell")[0]).toHaveTextContent("Brian");
  });

  it("renders a single-row file as a header with an empty body", () => {
    render(<CsvTable text={"only,one,row"} />);
    const table = screen.getByTestId("csv-table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).queryAllByRole("cell")).toHaveLength(0);
  });

  it("does not crash on a ragged short row and pads missing cells", () => {
    // Second data row is short (2 of 3); it must render 3 cells, last empty.
    render(<CsvTable text={"a,b,c\n1,2,3\n4,5"} />);
    const table = screen.getByTestId("csv-table");
    const bodyRows = (table.querySelector("tbody") as HTMLElement).querySelectorAll("tr");
    const shortRowCells = within(bodyRows[1] as HTMLElement).getAllByRole("cell");
    expect(shortRowCells).toHaveLength(3);
    expect(shortRowCells[2]).toHaveTextContent("");
  });

  it("widens all rows to the widest row when a body row has extra fields", () => {
    // Header has 2 fields, a body row has 3 -> table is 3 columns wide and the
    // header is padded to match (exercises the header pad path).
    render(<CsvTable text={"a,b\n1,2,3"} />);
    const table = screen.getByTestId("csv-table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
  });

  it("shows a caption with pluralized row and column counts", () => {
    render(<CsvTable text={"a,b,c\n1,2,3\n4,5,6"} />);
    expect(screen.getByTestId("csv-table-caption")).toHaveTextContent("2 rows × 3 columns");
  });

  it("uses singular units for a one-row, one-column body", () => {
    render(<CsvTable text={"header\nvalue"} />);
    expect(screen.getByTestId("csv-table-caption")).toHaveTextContent("1 row × 1 column");
  });

  it("renders a calm empty state for empty text", () => {
    render(<CsvTable text={""} />);
    const table = screen.getByTestId("csv-table");
    expect(table).toHaveClass("csv-table--empty");
    expect(table).toHaveTextContent("Nothing to preview.");
    expect(within(table).queryByRole("table")).toBeNull();
  });

  it("renders the empty state for whitespace-only text", () => {
    render(<CsvTable text={"   \n  \n"} />);
    expect(screen.getByTestId("csv-table")).toHaveTextContent("Nothing to preview.");
  });
});
