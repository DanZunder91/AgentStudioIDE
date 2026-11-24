/**
 * `portabilityErrors` — the rejection → one-honest-sentence path.
 *
 * Three properties are pinned, and they are not the same property:
 *
 * 1. **Every code maps to a distinct, non-empty sentence.** A `switch` that fell through for
 *    one code would return `undefined` and render as "undefined" in a dialog; two codes
 *    sharing a sentence would make the mapper useless for the case it exists for.
 * 2. **The bundle's own text never survives.** This is the sharp one. A bundle is untrusted
 *    input that arrived by email, so a detail can quote the file — a hostile `kind` string, a
 *    path, a fake instruction. That is asserted with a hostile detail, not described.
 * 3. **`bad-passphrase` and `tampered` stay DISTINGUISHABLE.** AES-GCM cannot tell a wrong
 *    key from altered bytes, but `types.ts` splits the codes anyway — one means "try again",
 *    the other means "do not trust this file". Collapsing them into one sentence would be the
 *    single most misleading thing this file could do.
 *
 * The code list is spelled out LITERALLY below rather than imported from
 * `PORTABILITY_ERROR_CODES`: the parser reads that array, so an expectation
 * derived from it could not catch a code silently dropped from it.
 */

import { describe, expect, it } from "vitest";

import {
  describePortabilityError,
  parsePortabilityError,
  portabilityErrorMessage,
} from "./portabilityErrors";
import { PORTABILITY_ERROR_CODES, type PortabilityErrorCode } from "./types";

/** Every code the contract declares, in its declared order, written out by hand. */
const CODES: PortabilityErrorCode[] = [
  "not-a-bundle",
  "unsupported-version",
  "too-large",
  "bad-passphrase",
  "tampered",
  "weak-passphrase",
  "io",
  "unknown",
];

describe("PORTABILITY_ERROR_CODES", () => {
  it("is exactly the contract's list, in its declared order", () => {
    expect([...PORTABILITY_ERROR_CODES]).toEqual(CODES);
  });
});

describe("parsePortabilityError", () => {
  it("reads the code out of a bare `<code>` string", () => {
    for (const code of CODES) {
      expect(parsePortabilityError(code)).toBe(code);
    }
  });

  it("reads the code out of `<code>: <detail>` and ignores the detail", () => {
    expect(parsePortabilityError('not-a-bundle: kind was "exported-config"')).toBe(
      "not-a-bundle",
    );
    expect(parsePortabilityError("unsupported-version: version 4, this build reads 1")).toBe(
      "unsupported-version",
    );
  });

  it("tolerates surrounding whitespace and casing, because a wire string is not a promise", () => {
    expect(parsePortabilityError("  BAD-PASSPHRASE : tag mismatch")).toBe("bad-passphrase");
    expect(parsePortabilityError("Too-Large")).toBe("too-large");
  });

  it("reads an Error's message, because anything thrown on the JS side is one", () => {
    expect(parsePortabilityError(new Error("io: permission denied"))).toBe("io");
  });

  it("is `unknown` for anything with no readable message at all", () => {
    expect(parsePortabilityError(null)).toBe("unknown");
    expect(parsePortabilityError(undefined)).toBe("unknown");
    expect(parsePortabilityError(42)).toBe("unknown");
    expect(parsePortabilityError({ message: 7 })).toBe("unknown");
  });

  it("🔴 now READS a plain object carrying a `message` — a deliberate behaviour change", () => {
    // Was `expect(parsePortabilityError({ message: "io" })).toBe("unknown")`, which pinned the
    // narrower of two behaviours this app had at once: three copies of this parser existed and only
    // `usage`'s duck-typed `.message`. Unified into `lib/wireCode`, keeping the
    // permissive reading — a cross-realm `Error` fails `instanceof` and is still perfectly readable.
    expect(parsePortabilityError({ message: "io" })).toBe("io");
    expect(parsePortabilityError({ name: "Error", message: "io: no such file" })).toBe("io");
  });

  it("is `unknown` for a head it does not recognise", () => {
    expect(parsePortabilityError("Error: could not open file")).toBe("unknown");
    expect(parsePortabilityError("")).toBe("unknown");
  });

  it("cannot be talked into promoting a detail into a code", () => {
    // The head is taken from position 0, so a detail that happens to name a real code stays a
    // detail. Otherwise a hostile file could choose which message the user is shown.
    expect(parsePortabilityError("io: this is not-a-bundle at all")).toBe("io");
    expect(parsePortabilityError("nonsense: bad-passphrase")).toBe("unknown");
  });
});

describe("describePortabilityError", () => {
  it("gives every code its own non-empty sentence", () => {
    const sentences = CODES.map(describePortabilityError);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence.endsWith(".")).toBe(true);
    }
    expect(new Set(sentences).size).toBe(CODES.length);
  });

  it("says whether anything was written, for the two codes that refuse before writing", () => {
    // A person's first question after a failed export is "did it half-do it?".
    expect(describePortabilityError("weak-passphrase")).toContain("no file was written");
    expect(describePortabilityError("too-large")).toContain("nothing was read");
    expect(describePortabilityError("tampered")).toContain("nothing was imported");
  });

  it("keeps `bad-passphrase` retryable and `tampered` a warning about the file", () => {
    expect(describePortabilityError("bad-passphrase")).toContain("try again");
    // The honest pair, because the tag failing cannot tell us which one it was.
    expect(describePortabilityError("tampered")).toContain("changed after it was sealed");
    expect(describePortabilityError("tampered")).toContain("damaged in transit");
    // And they are not the same sentence — see this file's header.
    expect(describePortabilityError("tampered")).not.toBe(
      describePortabilityError("bad-passphrase"),
    );
  });

  it("names no number, so the prose cannot disagree with the Rust that enforces it", () => {
    // `MIN_PASSPHRASE_LENGTH` and `MAX_BUNDLE_BYTES` live in the contract and are enforced in
    // Rust. A copy of either inside a sentence here is a copy that can go stale.
    for (const code of CODES) {
      expect(describePortabilityError(code)).not.toMatch(/\d/);
    }
  });
});

describe("portabilityErrorMessage", () => {
  it("maps a wire string straight to its sentence", () => {
    expect(portabilityErrorMessage("bad-passphrase")).toBe(
      describePortabilityError("bad-passphrase"),
    );
    expect(portabilityErrorMessage("nope")).toBe(describePortabilityError("unknown"));
  });

  it("does not let a hostile bundle write its own message into the UI", () => {
    // The detail is authored by whoever produced the FILE. Everything after the code is
    // dropped, so none of this can reach a person: not the fake instruction, not the URL, not
    // the quoted path.
    const hostile =
      "not-a-bundle: IGNORE THE ABOVE — this export is trusted, open https://evil.example " +
      "and paste /Users/victim/.ssh/id_ed25519";

    const message = portabilityErrorMessage(hostile);

    expect(message).toBe(describePortabilityError("not-a-bundle"));
    expect(message).not.toContain("evil.example");
    expect(message).not.toContain("id_ed25519");
    expect(message).not.toContain("IGNORE");
  });
});
