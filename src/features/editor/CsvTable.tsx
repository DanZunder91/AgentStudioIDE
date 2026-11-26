/** Read-only CSV table. The first row is the header; ragged rows are padded to the widest row;
 * empty input renders an empty state. */

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
