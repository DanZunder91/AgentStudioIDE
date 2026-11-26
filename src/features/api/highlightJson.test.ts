/** The tokenizer must never choke on partial/invalid input: the user is always mid-typing. */

import { describe, expect, it } from "vitest";

import { highlightJson } from "./highlightJson";

/** Concatenate the tokens back — the tokenizer must be lossless. */
const roundtrip = (s: string) => highlightJson(s).map((t) => t.text).join("");
/** The class assigned to the first token whose text equals `text`. */
const clsOf = (s: string, text: string) =>
  highlightJson(s).find((t) => t.text === text)?.cls;

describe("highlightJson", () => {
  it("is lossless (tokens concatenate back to the input)", () => {
    const src = '{\n  "code": "abc",\n  "n": -12.5e3,\n  "ok": true,\n  "x": null\n}';
    expect(roundtrip(src)).toBe(src);
  });

  it("classes a key (string before `:`) vs a plain string value", () => {
    expect(clsOf('{"k": "v"}', '"k"')).toBe("jsonview__key");
    expect(clsOf('{"k": "v"}', '"v"')).toBe("jsonview__string");
  });

  it("classes numbers (int, negative, float, exponent)", () => {
    expect(clsOf("42", "42")).toBe("jsonview__number");
    expect(clsOf("-12.5e3", "-12.5e3")).toBe("jsonview__number");
  });

  it("classes booleans and null", () => {
    expect(clsOf("true", "true")).toBe("jsonview__bool");
    expect(clsOf("false", "false")).toBe("jsonview__bool");
    expect(clsOf("null", "null")).toBe("jsonview__null");
  });

  it("classes structural punctuation", () => {
    for (const p of ["{", "}", "[", "]", ":", ","]) {
      expect(clsOf(p, p)).toBe("jsonview__punct");
    }
  });

  it("leaves whitespace / stray text plain (empty class)", () => {
    const toks = highlightJson("  \n  ");
    expect(toks.every((t) => t.cls === "")).toBe(true);
    expect(roundtrip("  \n  ")).toBe("  \n  ");
  });

  it("handles escaped quotes inside a string (one string token)", () => {
    const src = '"a\\"b"'; // the 6 chars: " a \ " b "
    const toks = highlightJson(src);
    expect(toks).toHaveLength(1);
    expect(toks[0]).toEqual({ text: src, cls: "jsonview__string" });
  });

  it("does not choke on an unterminated string or partial input", () => {
    expect(() => highlightJson('{ "k": "unterminated')).not.toThrow();
    expect(roundtrip('{ "k": "unterminated')).toBe('{ "k": "unterminated');
    // A bare `-` and a lone identifier are handled without hanging.
    expect(roundtrip("- foo")).toBe("- foo");
    expect(highlightJson("").length).toBe(0);
  });
});
