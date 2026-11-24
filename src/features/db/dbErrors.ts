/**
 * dbErrors — the ONE place a database failure becomes something a person can read.
 *
 * Modelled on `usage/usageFormat.ts`'s `parseUsageError` + `describeUsageError` pair, and
 * for a sharper reason than tidiness: **a driver string can contain a connection string,
 * and therefore a password.** `sqlx` and libpq echo the DSN they dialled into their error
 * text, so rendering Rust's raw message anywhere in the UI is both a usability
 * failure and a leak risk. Rust redacts before it rejects; this file makes sure the UI
 * never has to trust that it did, because it renders a sentence of its own instead.
 *
 * The wire shape: Rust rejects with the string `"<code>"` or
 * `"<code>: <detail>"`, where `<code>` is a {@link DbErrorCode}. We read the code and, **for
 * almost every code, drop the detail**. The detail is prose and is already redacted, but it is
 * written for a developer reading a log, and one sentence the user can act on beats two they cannot.
 *
 * ── The exception, and why it had to become one ──────────────────────────────
 * "Drop the detail" is wrong for exactly one class: the failures where **the server knew more than
 * the code does**. When `select * from temp_playlists limit 10;` was typed into a MongoDB console,
 * Rust rejected it with a genuinely helpful sentence — *"That is not a MongoDB command document. A
 * command is one JSON object whose FIRST key is the command name, e.g. `{"find": "tracks", "limit":
 * 10}`"* — and this file used to replace it with `invalid-config`'s *"check the host, the port, and the
 * settings this engine requires"*, about a connection that had just succeeded. The app was holding
 * the one message that would have solved it and rendered a wrong diagnosis instead.
 *
 * So {@link DETAIL_IS_THE_ANSWER} lists the codes whose detail is the actionable part, and it is a
 * short allow-list rather than a default: a driver's prose is what this file exists to keep off the
 * screen, and only messages Rust writes *for the person who typed the statement* qualify.
 *
 * The one exception, and it is in the contract rather than here: `DbTestResult.error` is
 * documented as "mapped + redacted" prose meant to be rendered verbatim, and the dialog
 * already does exactly that (`describeTestResult`). That field is a *result*, not a
 * rejection — Test Connection resolves on failure — so it never reaches this file.
 */

import { splitWireCode } from "../../lib/wireCode";
import type { DbErrorCode } from "./types";

/**
 * Every code the db commands can send, written out literally.
 *
 * A list rather than a derived key set because there is nothing to derive it from —
 * `DbErrorCode` is a type union and erases at runtime — and because a literal list is what
 * makes {@link parseDbError} refuse an unrecognised head instead of trusting it. Mirrors
 * `types.ts`'s union in its declared order; the test asserts the two agree by spelling both
 * out (an expectation read from the table under test proves only plumbing).
 */
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

/**
 * The {@link DbErrorCode} inside a rejection, or `"unknown"`.
 *
 * Accepts both shapes a rejection really takes, because both happen: Tauri rejects with a
 * plain **string**, and anything thrown on the JS side of the boundary is an `Error`. A
 * value that is neither (a `null`, a number, an object with no message) is `"unknown"` —
 * the code that exists precisely so the UI never has to render something it cannot classify.
 *
 * Only the head before the first `:` is consulted, and it must match a known code exactly
 * (after trimming and lowercasing). A detail that happens to start with a word we recognise
 * cannot promote itself into a code, because the head is taken from position 0.
 */
export function parseDbError(raw: unknown): DbErrorCode {
  return splitDbError(raw).code;
}

/**
 * The code AND the detail Rust sent with it — `{ code: "unknown", detail: null }` for anything
 * unrecognised.
 *
 * Split from {@link parseDbError} rather than replacing it, because most callers genuinely only
 * want the code and a two-field return would invite them to render prose this file spent its whole
 * doc comment arguing against. The detail is everything after the FIRST `:` (a message may contain
 * more of them — `port: 5432: refused` keeps `5432: refused`), trimmed, and `null` when empty, so
 * `"timeout: "` cannot render as a blank line.
 */
export function splitDbError(raw: unknown): { code: DbErrorCode; detail: string | null } {
  // Delegated to `lib/wireCode`. This function used to hold its own copy of the
  // reader — one of THREE in the app, which had already diverged: this one required
  // `instanceof Error`, so an `Error` from another realm (a worker, the webview bridge) classified
  // as `unknown` here and correctly in `usage`. One wire format, one reader.
  return splitWireCode(raw, DB_ERROR_CODES, "unknown");
}

/**
 * The codes whose **detail is the answer**, so it is rendered instead of our own sentence.
 *
 * A code earns a place here only when **every** message carrying it is prose we wrote. That is a
 * property of the *message*, and this list is keyed on the *code* — so a code qualifies only once
 * its provenance is uniform.
 *
 * * `invalid-statement` — the detail names the shape the engine wanted.
 * * `blocked` — and the work that made it safe is the point. An attempt to add `auth` as well
 *   was **reverted**: `map_sqlx_error`'s auth arm appends the *server's* message, and the
 *   driver-error redaction test caught the DSN going through. `blocked` had the same hazard in **four**
 *   places (Postgres SQLSTATE 25006, ClickHouse 164, DynamoDB's two throughput/conflict errors,
 *   redis's replica refusal), all of which now carry our own sentence instead — enforced in Rust by
 *   a single `DbError::blocked` constructor and a test that fails on any raw construction. Until
 *   that landed, this line would have leaked; after it, it cannot.
 *
 * The test asserts the list is exactly these, so widening it stays a decision someone makes on
 * purpose rather than a line that drifts in.
 */
export const DETAIL_IS_THE_ANSWER: readonly DbErrorCode[] = ["invalid-statement", "blocked"];

/**
 * One short, TRUE sentence per code — what happened, and the next move.
 *
 * The rules each sentence follows, and why:
 *
 * * **Never invent a cause we did not observe.** `network` says the server could not be
 *   reached and lists the three things that are actually in the path; it does not say "the
 *   database is down", which we did not measure.
 * * **Never blame the user.** A rejected password is not a mistake they made — it is a
 *   fact about the server's answer.
 * * **Never imply a retry could work when it cannot.** `invalid-config` and
 *   `secret-missing` name the edit that would fix them, because retrying an unchanged
 *   config is a button that cannot succeed.
 * * **Never name the driver or echo its words.** That is the whole point of this file.
 *
 * `blocked` names both guards it can mean (read-only and multi-statement) rather than
 * guessing which one fired: the codes do not distinguish them, and picking one would be a
 * fabrication in the one place the user is deciding whether to weaken a safety setting.
 */
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
      // The FALLBACK only, like `invalid-statement`'s. A real refusal now arrives with Rust's own
      // sentence, which names *which* guard fired and which setting lifts it — this one cannot,
      // which is exactly why a plain two-statement buffer used to show "read-only, or …
      // multiple statements" and nobody could tell which.
      return "That statement was blocked by this connection's safety settings before it ran.";
    case "timeout":
      return "The database did not answer within this connection's timeout.";
    case "cancelled":
      return "That request was cancelled before it finished.";
    case "unknown":
      return "The database call failed for an unrecognized reason — retrying may help.";
  }
}

/**
 * A failed *call*, as the code to branch on and the one sentence to show.
 *
 * Both, because they are two different jobs and keeping them together is what stopped the detail
 * being dropped a second time: the store used to hold only the code, so even a Rust message that
 * survived the mapper had nowhere to live between the rejection and the results pane.
 */
export interface DbFailure {
  code: DbErrorCode;
  /** Already chosen — render it. Never a raw driver string; see this file's header. */
  message: string;
}

/**
 * The whole rejection path in one call: read the code, then show either Rust's detail (for
 * {@link DETAIL_IS_THE_ANSWER}) or our sentence for that code.
 */
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
