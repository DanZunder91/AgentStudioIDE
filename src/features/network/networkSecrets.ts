/**
 * The optional on-screen mask for credential headers (capture shows everything, and a button
 * that masks key values on screen is allowed). Display only: the
 * store holds the real value and Copy as cURL / Open in API client always use it.
 */

/** Exact (lower-case) header names that carry credentials. */
const SECRET_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

/** Name fragments that mark a credential under a vendor prefix (`x-goog-api-key`, `x-csrf-token`). */
const SECRET_PARTS = ["token", "secret", "api-key", "apikey", "authorization", "cookie", "password"];

/**
 * Is this header a credential worth masking? Deliberately NOT a bare `key` match — that
 * hid `sec-websocket-key` and idempotency keys, which are not secrets.
 */
export function isSecretHeader(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAMES.has(n) || SECRET_PARTS.some((p) => n.includes(p));
}

export const MASK = "••••••••";

/** The value to render: the mask for a secret header while masking is on, else the value. */
export function shownValue(name: string, value: string, masked: boolean): string {
  return masked && isSecretHeader(name) ? MASK : value;
}
