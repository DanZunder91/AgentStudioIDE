/**
 * portabilityErrors — the ONE place a bundle failure becomes something a person can read.
 *
 * Modelled on `db/dbErrors.ts`'s `parse…` + `describe…` + `…Message` trio, and deliberately
 * NOT importing from it: the two unions are disjoint (`not-a-bundle` is not a database code,
 * `auth` is not a bundle code), so there is no row the two files could drift on. What they
 * *do* share is the parser's logic, which lives once in `lib/wireCode` — see
 * {@link parsePortabilityError}.
 *
 * ── Why the detail is DROPPED, and why that matters more here than for the DB ─
 * The wire shape is the app-wide one: Rust rejects with `"<code>"` or `"<code>: <detail>"`. We
 * read the code and render a sentence of our own.
 *
 * For the database the reason was that a driver echoes the DSN it dialled, so a detail can
 * carry a password. Here the reason is sharper: **the detail can quote the file.** A bundle
 * is untrusted input that arrived by Slack or email (`types.ts`: "a bundle claiming to come
 * from a colleague proves nothing at all"), so a `not-a-bundle` detail naming the `kind`
 * string it found, or an `io` detail carrying the path, is attacker- or accident-authored
 * text. Rendering it would let a hostile file write its own message into our UI. One
 * sentence we wrote beats two we did not.
 *
 * ── Numbers are deliberately absent from the prose ───────────────────────────
 * No sentence names `MIN_PASSPHRASE_LENGTH` or `MAX_BUNDLE_BYTES`. Both are enforced in Rust
 * and declared in `types.ts`; a number copied into prose here is a number that can disagree
 * with the one that decided. The dialog states the minimum from the constant, next to the
 * field where it applies.
 */

import { parseWireCode } from "../../lib/wireCode";
import { PORTABILITY_ERROR_CODES, type PortabilityErrorCode } from "./types";

/**
 * The {@link PortabilityErrorCode} inside a rejection, or `"unknown"`.
 *
 * Accepts both shapes a rejection really takes, because both happen: Tauri rejects with a
 * plain **string**, and anything thrown on the JS side of the boundary is an `Error`.
 * Anything else (a `null`, a number, an object with no message) is `"unknown"` — the code
 * that exists precisely so the UI never has to render something it cannot classify.
 *
 * Only the head before the first `:` is consulted, and it must match a known code exactly
 * (after trimming and lowercasing), so a detail that happens to begin with a word we
 * recognise cannot promote itself into a code.
 *
 * Unlike `dbErrors.ts` this reads its list from {@link PORTABILITY_ERROR_CODES} rather than
 * re-spelling it: that array is a runtime `as const` in the contract file, not an erased
 * type union, so there is exactly one list and nothing to keep in step. The *test* spells
 * every code out literally instead (an expectation read from the table under test proves
 * only plumbing), which is where that guarantee belongs.
 */
export function parsePortabilityError(raw: unknown): PortabilityErrorCode {
  // Delegated to `lib/wireCode` — this was one of three copies of this reader, and one
  // of the two that required `instanceof Error` and so misclassified a cross-realm error as
  // `unknown`. The sentence table below stays here: the code unions are disjoint, so they cannot
  // drift, and each feature's wording is genuinely its own.
  return parseWireCode(raw, PORTABILITY_ERROR_CODES, "unknown");
}

/**
 * One short, TRUE sentence per code — what happened, and the next move.
 *
 * The rules each sentence follows:
 *
 * * **Say whether anything was written.** `weak-passphrase` and `too-large` both refuse
 *   before touching data, and a person's first question after a failed export or import is
 *   "did it half-do it?".
 * * **Never blame the user.** A passphrase that did not open a bundle is a fact about two
 *   strings, not a mistake — and the sharer may simply have sent the wrong one.
 * * **Never claim to know which of two causes it was.** `tampered` is the AEAD tag failing
 *   in a way that implicates the header binding; "changed after it was sealed, or damaged in
 *   transit" is the honest pair, and picking one would be a fabrication in the one place a
 *   person is deciding whether to trust a file.
 * * **Never imply a retry could work when it cannot.** `not-a-bundle` and
 *   `unsupported-version` name the thing that would have to change instead.
 */
export function describePortabilityError(code: PortabilityErrorCode): string {
  switch (code) {
    case "not-a-bundle":
      return "That file is not an Agent Studio config bundle — pick the JSON file an export produced.";
    case "unsupported-version":
      return "That bundle was written in a format this version cannot read — update Agent Studio and try again.";
    case "too-large":
      return "That file is larger than a config bundle is allowed to be, so nothing was read from it.";
    case "bad-passphrase":
      return "That passphrase did not open the bundle — check it with whoever sent the file, then try again.";
    case "tampered":
      return "The bundle's contents do not match its own description, so nothing was imported — it was changed after it was sealed, or damaged in transit.";
    case "weak-passphrase":
      return "That passphrase is too short to seal a bundle with, so no file was written — choose a longer one.";
    case "io":
      return "The file could not be read or written — check the path, and whether this app is allowed to reach it.";
    case "unknown":
      return "The bundle could not be processed for an unrecognized reason — retrying may help.";
  }
}

/**
 * {@link parsePortabilityError} then {@link describePortabilityError} — the whole rejection
 * path, one call. What the store's action wrappers use, so no raw wire string ever lands in
 * state.
 */
export function portabilityErrorMessage(raw: unknown): string {
  return describePortabilityError(parsePortabilityError(raw));
}
