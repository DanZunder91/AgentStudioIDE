/** One string in, one classified reading out (shown, so a wrong guess is visible). Numeric
 * first: every digit string is an epoch, so `dateParse` takes the compact form only with a `T`. */

import { parseDateString, type DateParse } from "./dateParse";
import { parseNumericEpoch, type NumericEpoch } from "./instant";

/** What the input box was understood to hold. */
export type ParseResult =
  /** Nothing typed yet — not an error, and the panel must not shout about it. */
  | { kind: "empty" }
  | ({ kind: "epoch" } & NumericEpoch)
  | ({ kind: "date" } & DateParse)
  /** Unreadable — `message` says why, or what shapes ARE understood. */
  | { kind: "unknown"; message: string };

/** Names real examples: the useful half of a rejection is what would have worked. */
export const UNKNOWN_MESSAGE =
  "Not a number, and not a date shape I know. Try an epoch (1700000000), an ISO timestamp (2023-11-14T22:13:20Z), a plain date (2024/01/25 or 25 Jan 2024), or “now”.";

/** Classify and read one input. `nowMs` resolves `now` / `today` and the relative line. */
export function parseToolInput(raw: string, nowMs: number): ParseResult {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };

  // Numeric first — see the header. `null` means "not numeric at all", not "bad number".
  const numeric = parseNumericEpoch(text);
  if (numeric !== null) return { kind: "epoch", ...numeric };

  const date = parseDateString(text, nowMs);
  if (date === null) return { kind: "unknown", message: UNKNOWN_MESSAGE };
  // Date-SHAPED but not a real date (2010-02-30): its own reason is far more useful
  // than the generic list of accepted shapes.
  if (!date.ok) return { kind: "unknown", message: date.reason };
  return { kind: "date", ...date.parse };
}
