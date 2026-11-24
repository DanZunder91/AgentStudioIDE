/**
 * A small, dependency-free CSV parser.
 *
 * Exported separately from the view so the risky logic is unit-testable in
 * isolation. RFC-4180-ish:
 *   - comma-separated fields;
 *   - a field may be wrapped in double quotes, in which case it can contain
 *     commas, newlines, and escaped quotes (`""` collapses to a single `"`);
 *   - both `\n` and `\r\n` line endings are accepted;
 *   - a single trailing newline does NOT yield a spurious empty final row;
 *   - empty input yields `[]`.
 *
 * It is a straight character-by-character state machine — no regex, no lookahead
 * beyond the single next character needed to disambiguate `""` and `\r\n`.
 */
export function parseCsv(text: string): string[][] {
  if (text === "") return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // True while a record is being built that has not yet been pushed. Reset to
  // false the instant a row terminator flushes a row, so a trailing newline
  // leaves nothing pending — this is what stops the spurious final empty row.
  let pending = false;

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field: `""` -> `"`.
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      pending = true;
      i += 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
      pending = true;
      i += 1;
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      pending = false;
      // Treat a `\r\n` pair as a single terminator.
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      pending = true;
      i += 1;
    }
  }

  // Flush the final record only if one is actually in progress. If the text
  // ended exactly on a row terminator, `pending` is false and we add nothing.
  if (pending) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
