/** The one parser for the `"<code>"` / `"<code>: <detail>"` rejection shape of Rust commands.
 * `.message` is duck-typed (a cross-realm Error fails `instanceof`); the head must match a known
 * code exactly; the detail is all after the FIRST colon, `null` when empty. */

/** A parsed rejection: the code the caller recognised, and Rust's detail if there was one. */
export interface WireCode<T extends string> {
  code: T;
  detail: string | null;
}

/** A rejection as `{ code, detail }`; `codes` is the caller's list, `fallback` the unrecognised
 * value. An unrecognised head loses its detail too: raw driver text must stay off the screen. */
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
