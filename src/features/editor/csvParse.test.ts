import { describe, expect, it } from "vitest";

import { parseCsv } from "./csvParse";

describe("parseCsv", () => {
  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("parses a single row without a trailing newline", () => {
    expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("parses multiple simple rows", () => {
    expect(parseCsv("a,b\nc,d\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("does not produce a spurious empty row for a single trailing newline", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a genuinely empty final field before a trailing newline", () => {
    expect(parseCsv("a,\n")).toEqual([["a", ""]]);
  });

  it("handles \\r\\n (CRLF) line endings", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles a bare \\r as a line terminator", () => {
    expect(parseCsv("a,b\rc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses a quoted field containing a comma", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("parses a quoted field containing a newline", () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([["a", "line1\nline2", "c"]]);
  });

  it("parses a quoted field containing a CRLF newline", () => {
    expect(parseCsv('"x\r\ny"')).toEqual([["x\r\ny"]]);
  });

  it("collapses escaped quotes (\"\" -> \") inside a quoted field", () => {
    expect(parseCsv('"she said ""hi"""')).toEqual([['she said "hi"']]);
  });

  it("parses an empty quoted field to a single empty-string cell", () => {
    expect(parseCsv('""')).toEqual([[""]]);
  });

  it("parses empty quoted fields among others", () => {
    expect(parseCsv('"",a,""')).toEqual([["", "a", ""]]);
  });

  it("treats a lone newline as one row with a single empty field", () => {
    expect(parseCsv("\n")).toEqual([[""]]);
  });

  it("preserves surrounding text after a closed quote (quote then plain)", () => {
    // A closing quote followed by more characters continues the same field.
    expect(parseCsv('"ab"cd')).toEqual([["abcd"]]);
  });

  it("does not crash on input that ends inside an unterminated quote", () => {
    expect(parseCsv('"unterminated')).toEqual([["unterminated"]]);
  });

  it("keeps a trailing empty field on a line without a terminator", () => {
    expect(parseCsv("a,b,")).toEqual([["a", "b", ""]]);
  });
});
