/**
 * The Tools panel's ONE input seam: a single string in, one understood reading out.
 *
 * The requirement is explicitly bidirectional and typeless — an epoch typed in
 * converts to a human-readable time, any date converts back to an epoch, and the tool
 * identifies which it was given from one string. So there is no direction toggle to get wrong: the input
 * is classified, and the classification is shown so a wrong guess is visible rather
 * than silent.
 *
 * The order matters and is the one seam worth stating (test the seam
 * explicitly): **numeric first**. Every string of digits is a valid epoch, so
 * `20260615` is 1970-08-23 in seconds, not 15 June 2026 — `dateParse` deliberately
 * declines the bare compact form for exactly this reason, and accepts it only with the
 * `T` that makes it a date (`20260615T0000Z`).
 */

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

/**
 * Said when the input is not date-shaped at all. Names real examples rather than
 * "invalid input": the useful half of a rejection is what WOULD have worked.
 */
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
