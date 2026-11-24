/**
 * CsvTable — a read-only table view of CSV text.
 *
 * Pure and self-contained: give it the raw file text, it renders a scrollable
 * table (the VS Code / GitHub CSV-preview shape). `CodeEditor` mounts it; this
 * component owns only the rendering + its parser.
 *
 * Conventions:
 *   - The FIRST row is the header (`<thead>`); the rest are the body (`<tbody>`).
 *     A single-row file therefore renders as a header with an empty body — the
 *     common case is a header-only CSV, and showing it as the header reads best.
 *   - Ragged rows never crash: the column count is the widest row, and every
 *     row is padded with empty cells to that width (missing cells render empty).
 *   - Empty or whitespace-only input renders a calm empty state, not a crash.
 */

import { parseCsv } from "./csvParse";
import "./csvTable.css";

export function CsvTable({ text }: { text: string }): React.JSX.Element {
  const rows = parseCsv(text);

  if (rows.length === 0 || text.trim() === "") {
    return (
      <div className="csv-table csv-table--empty" data-testid="csv-table">
        <p className="csv-table__empty">Nothing to preview.</p>
      </div>
    );
  }

  const cols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const header = rows[0];
  const body = rows.slice(1);

  const caption = `${body.length} ${body.length === 1 ? "row" : "rows"} × ${cols} ${cols === 1 ? "column" : "columns"}`;

  return (
    <div className="csv-table" data-testid="csv-table">
      <div className="csv-table__caption" data-testid="csv-table-caption">
        {caption}
      </div>
      <div className="csv-table__scroll">
        <table>
          <thead>
            <tr>
              {padTo(header, cols).map((cell, c) => (
                <th key={c} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                {padTo(r, cols).map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Pad a row out to `width` cells with empty strings (never truncates). */
function padTo(row: string[], width: number): string[] {
  if (row.length >= width) return row;
  return [...row, ...Array<string>(width - row.length).fill("")];
}
