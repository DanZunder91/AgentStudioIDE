/** The one place a bundle failure becomes readable text. Rust's detail is dropped: it can quote
 * the untrusted file, letting a hostile bundle write into our UI. No numbers in the prose: limits
 * live in `types.ts` and Rust, and the dialog states them from the constants. */

import { parseWireCode } from "../../lib/wireCode";
import { PORTABILITY_ERROR_CODES, type PortabilityErrorCode } from "./types";

/** The code in a rejection (Tauri string or JS `Error`), else `"unknown"`. Only the head before
 * the first `:` counts and must match a known code exactly, so a detail cannot promote itself.
 * Reads {@link PORTABILITY_ERROR_CODES} (runtime `as const`), so there is one list. */
export function parsePortabilityError(raw: unknown): PortabilityErrorCode {
  // The sentence table stays per feature: the code unions are disjoint.
  return parseWireCode(raw, PORTABILITY_ERROR_CODES, "unknown");
}

/** One short, true sentence per code: say whether anything was written, never blame the user,
 * never claim which of two causes it was (`tampered`), never imply a futile retry could work. */
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

/** Parse then describe: what the store's wrappers use, so no raw wire string lands in state. */
export function portabilityErrorMessage(raw: unknown): string {
  return describePortabilityError(parsePortabilityError(raw));
}
