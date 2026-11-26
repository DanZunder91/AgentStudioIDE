/** The one place a DB failure becomes readable. Drivers (sqlx, libpq) echo the DSN, password
 * included, so the UI shows its own sentence per code ("<code>[: <detail>]") and drops the detail
 * except for DETAIL_IS_THE_ANSWER. DbTestResult.error is a result, not a rejection: never here. */

import { splitWireCode } from "../../lib/wireCode";
import type { DbErrorCode } from "./types";

/** Literal: DbErrorCode erases at runtime, and this list lets parseDbError refuse an unknown head.
 * Mirrors types.ts's union order; the test spells both out. */
export const DB_ERROR_CODES: readonly DbErrorCode[] = [
  "not-found",
  "invalid-config",
  "invalid-statement",
  "network",
  "tls",
  "auth",
  "secret-missing",
  "blocked",
  "timeout",
  "cancelled",
  "unknown",
];

/** Accepts a string (Tauri) or an Error-like value; anything else is unknown. Only the head before
 * the first ":" counts, matched exactly after trim/lowercase, so a detail can't promote itself. */
export function parseDbError(raw: unknown): DbErrorCode {
  return splitDbError(raw).code;
}

/** Most callers want only parseDbError. detail is everything after the FIRST ":" ("port: 5432:
 * refused" keeps "5432: refused"), trimmed, and null when empty. */
export function splitDbError(raw: unknown): { code: DbErrorCode; detail: string | null } {
  // Delegated to lib/wireCode: one wire format, one reader.
  return splitWireCode(raw, DB_ERROR_CODES, "unknown");
}

/** Codes whose every message is prose we wrote, so the detail is shown. blocked qualifies as Rust
 * builds it only via DbError::blocked (a Rust test enforces it); auth does not (it appends the
 * server's message). The test pins this list, so widening it is a deliberate decision. */
export const DETAIL_IS_THE_ANSWER: readonly DbErrorCode[] = ["invalid-statement", "blocked"];

/** One short, TRUE sentence per code: never invent an unobserved cause, never blame the user,
 * never imply a retry that cannot work, never name the driver or echo its words. */
export function describeDbError(code: DbErrorCode): string {
  switch (code) {
    case "not-found":
      return "That connection or session no longer exists — reload the panel and open it again.";
    case "invalid-config":
      return "These connection settings cannot be used as they stand — check the host, the port, and the settings this engine requires.";
    case "invalid-statement":
      // The fallback only. A rejection with this code normally carries Rust's own sentence, which
      // names the shape the engine wanted; this is what renders when it arrived bare. It says
      // nothing about the connection, because the connection is not what failed.
      return "That statement could not be run as written — check it against what this engine expects.";
    case "network":
      return "The server could not be reached — check the host, the port, and whether a VPN or firewall is in the way.";
    case "tls":
      return "The TLS connection failed — the certificate did not verify, or the server does not speak TLS on that port.";
    case "auth":
      return "The server rejected these credentials — check the user and the password.";
    case "secret-missing":
      return "The saved password reference has nothing behind it in the Vault — type the password again and save the connection.";
    case "blocked":
      // Fallback only: a real refusal arrives with Rust's sentence naming the guard and setting.
      return "That statement was blocked by this connection's safety settings before it ran.";
    case "timeout":
      return "The database did not answer within this connection's timeout.";
    case "cancelled":
      return "That request was cancelled before it finished.";
    case "unknown":
      return "The database call failed for an unrecognized reason — retrying may help.";
  }
}

/** Code to branch on plus sentence to show, so a kept Rust detail has somewhere to live. */
export interface DbFailure {
  code: DbErrorCode;
  /** Already chosen — render it. Never a raw driver string; see this file's header. */
  message: string;
}

/** Reads the code, then shows Rust's detail (DETAIL_IS_THE_ANSWER) or our sentence for it. */
export function describeDbFailure(raw: unknown): DbFailure {
  const { code, detail } = splitDbError(raw);
  const useDetail = detail !== null && DETAIL_IS_THE_ANSWER.includes(code);
  return { code, message: useDetail ? detail : describeDbError(code) };
}

/** A failure this app decided on its own, with no wire string behind it (a missing session). */
export function dbFailure(code: DbErrorCode): DbFailure {
  return { code, message: describeDbError(code) };
}

/** {@link describeDbFailure}'s sentence alone, for the callers that render nothing else. */
export function dbErrorMessage(raw: unknown): string {
  return describeDbFailure(raw).message;
}
