/**
 * `splitWireCode` — the unified reader for the `"<code>[: detail]"` rejection shape.
 *
 * Written when three per-feature copies were collapsed into one. The three had already
 * diverged, so the tests that matter most here are the ones pinning **which** behaviour survived:
 * duck-typed `.message` (from `usage`) rather than `instanceof Error` (from `db` and `portability`).
 *
 * Every expectation is literal, and the code lists are written out rather than imported from the
 * features — a shared parser tested through one caller's constant proves nothing about the others.
 */

import { describe, expect, it } from "vitest";

import { parseWireCode, splitWireCode } from "./wireCode";

const CODES = ["not-found", "network", "timeout", "unknown"] as const;
type Code = (typeof CODES)[number];

const split = (raw: unknown) => splitWireCode<Code>(raw, CODES, "unknown");

describe("splitWireCode — the code", () => {
  it("reads a bare code and a code with a detail", () => {
    expect(split("timeout")).toEqual({ code: "timeout", detail: null });
    expect(split("network: refused")).toEqual({ code: "network", detail: "refused" });
  });

  it("trims and lower-cases the head, so wire whitespace and case do not matter", () => {
    expect(split("  TIMEOUT  ").code).toBe("timeout");
    expect(split("Network: refused").code).toBe("network");
  });

  it("🔴 requires an EXACT match, so a detail cannot promote itself into a code", () => {
    // The head is taken from position 0, which is what stops `"the network is down"` — a plausible
    // driver sentence — from being classified as `network`.
    expect(split("the network is down").code).toBe("unknown");
    expect(split("networking: refused").code).toBe("unknown");
    // …and a recognised word appearing in the DETAIL changes nothing.
    expect(split("timeout: the network was fine").code).toBe("timeout");
  });

  it("falls back for anything it cannot read at all", () => {
    for (const raw of [null, undefined, 42, [], {}, { message: 7 }]) {
      expect(split(raw)).toEqual({ code: "unknown", detail: null });
    }
  });

  it("uses the caller's fallback rather than assuming `unknown` exists", () => {
    // Another feature's vocabulary may not contain the word. The parameter is what keeps this
    // module from deciding anything about wording.
    expect(splitWireCode("nonsense", ["a", "b"] as const, "b").code).toBe("b");
  });
});

describe("splitWireCode — the detail", () => {
  it("splits on the FIRST colon only, so a detail may contain more", () => {
    expect(split("network: port 5432: connection refused").detail).toBe(
      "port 5432: connection refused",
    );
  });

  it("is null when empty, so a trailing colon cannot render as a blank line", () => {
    expect(split("timeout:").detail).toBeNull();
    expect(split("timeout:    ").detail).toBeNull();
  });

  it("🔴 is dropped along with an unrecognised code", () => {
    // An unclassified string is exactly the raw driver text these features exist to keep off the
    // screen — a DSN, a password, a stack trace. Losing the code must lose the prose with it.
    expect(split("kaboom: postgresql://u:hunter2@h/db")).toEqual({
      code: "unknown",
      detail: null,
    });
  });
});

describe("what an object may be", () => {
  it("🔴 duck-types `.message` instead of requiring `instanceof Error`", () => {
    // THE behaviour that survived the unification. An `Error` that crossed a realm boundary (a
    // worker, the webview bridge) fails `instanceof` while carrying a perfectly good message, and
    // two of the three old copies threw that away as `unknown`.
    const realError = new Error("network: refused");
    expect(split(realError).code).toBe("network");

    const crossRealm = { name: "Error", message: "network: refused" };
    expect(split(crossRealm)).toEqual({ code: "network", detail: "refused" });

    // The old `instanceof`-gated readers returned `unknown` for exactly this value, which is what
    // made the same wire string mean different things in different features.
    expect(crossRealm instanceof Error).toBe(false);
  });

  it("ignores a non-string `message`", () => {
    expect(split({ message: { nested: "network" } }).code).toBe("unknown");
  });
});

describe("parseWireCode", () => {
  it("is the code half of `splitWireCode`, for callers that want no prose", () => {
    expect(parseWireCode("network: refused", CODES, "unknown")).toBe("network");
    expect(parseWireCode(null, CODES, "unknown")).toBe("unknown");
  });
});
