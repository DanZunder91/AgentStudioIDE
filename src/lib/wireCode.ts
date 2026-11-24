/**
 * `splitWireCode` — the ONE parser for the `"<code>"` / `"<code>: <detail>"` rejection shape.
 *
 * Every Rust command in this app rejects in one style: a stable, greppable code, optionally
 * followed by a colon and a redacted human detail. Three features read that shape, and each
 * used to have **its own copy** of the reader:
 *
 * | Where | Accepted | Consequence |
 * |---|---|---|
 * | `db/dbErrors.ts` | `string` \| `instanceof Error` | an `Error` from another realm fell through to `unknown` |
 * | `usage/usageFormat.ts` | `string` \| anything with a `.message` string | correct |
 * | `portability/portabilityErrors.ts` | `string` \| `instanceof Error` | same gap as `db` |
 *
 * They had **already diverged behaviourally**, which is the point: the *same* wire string classified
 * differently depending on which feature received it. Nothing was wrong with three sentence tables —
 * the code unions are disjoint, so they cannot drift into disagreeing — but three readers of one wire
 * format is one format with three definitions.
 *
 * The behaviour kept here is the most permissive of the three, deliberately:
 *
 * * **`.message` is duck-typed, not gated on `instanceof Error`.** An `Error` that crossed a realm
 *   boundary (a worker, the webview bridge) fails `instanceof` while carrying a perfectly good
 *   message, and treating that as `unknown` throws away the one useful thing it had.
 * * **The head must match a known code EXACTLY** (trimmed, lower-cased). A detail that happens to
 *   begin with a recognised word cannot promote itself into a code, because the head is taken from
 *   position 0.
 * * **The detail is everything after the FIRST colon**, trimmed, and `null` when empty — so
 *   `"network: port 5432: refused"` keeps `"port 5432: refused"`, and `"timeout: "` cannot render as
 *   a blank line.
 *
 * Callers keep their own code list and their own sentences. This file decides nothing about wording.
 */

/** A parsed rejection: the code the caller recognised, and Rust's detail if there was one. */
export interface WireCode<T extends string> {
  code: T;
  detail: string | null;
}

/**
 * Read a rejection as `{ code, detail }`.
 *
 * `codes` is the caller's literal list of every code it accepts, and `fallback` is what an
 * unrecognised or unreadable value becomes (`"unknown"` for all three callers today, but the
 * parameter keeps this module from assuming another feature's vocabulary).
 *
 * An unrecognised head loses its detail as well as its code, and that is deliberate: an unclassified
 * string is exactly the raw driver text these features exist to keep off the screen.
 */
export function splitWireCode<T extends string>(
  raw: unknown,
  codes: readonly T[],
  fallback: T,
): WireCode<T> {
  let message: string | null = null;
  if (typeof raw === "string") {
    message = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const maybe = (raw as { message?: unknown }).message;
    if (typeof maybe === "string") message = maybe;
  }
  if (message === null) return { code: fallback, detail: null };

  const cut = message.indexOf(":");
  const head = (cut === -1 ? message : message.slice(0, cut)).trim().toLowerCase();
  if (!codes.includes(head as T)) return { code: fallback, detail: null };

  const rest = cut === -1 ? "" : message.slice(cut + 1).trim();
  return { code: head as T, detail: rest === "" ? null : rest };
}

/** {@link splitWireCode}'s code alone, for the callers that do not want the detail. */
export function parseWireCode<T extends string>(
  raw: unknown,
  codes: readonly T[],
  fallback: T,
): T {
  return splitWireCode(raw, codes, fallback).code;
}
