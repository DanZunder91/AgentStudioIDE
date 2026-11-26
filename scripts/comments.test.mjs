// The comment rule (no block over 3 lines) and the checker that proves a cleanup changed no code.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  analyze,
  applyBlocks,
  commentBlocks,
  commentsOnlyProblems,
  longBlocks,
  MAX_COMMENT_LINES,
  trackedSources,
} from "./comments.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Files with uncommitted work elsewhere; clean them when that work lands, then empty this list.
const PENDING = ["src/features/network/networkFilter.test.ts", "src/features/network/networkFilter.ts"];

const texts = (file, src) => analyze(file, src).comments.map((c) => src.slice(c.start, c.end));

describe("comment lexers", () => {
  it("TS: a regex or string holding // or /* is code, not a comment", () => {
    const src = 'const re = /\\/\\/x/; const s = "a /* b */ c"; // real\n';
    expect(texts("a.ts", src)).toEqual(["// real"]);
  });

  it("TSX: {/* … */} is a comment, and its braces are not code", () => {
    const withNote = "const x = <div>\n  {/* note */}\n  <span />\n</div>;\n";
    const without = "const x = <div>\n  <span />\n</div>;\n";
    expect(texts("a.tsx", withNote)).toEqual(["/* note */"]);
    expect(commentsOnlyProblems("a.tsx", withNote, without)).toEqual([]);
  });

  it("Rust: raw strings, chars and lifetimes never hide or fake a comment", () => {
    const src = `fn f<'a>(x: &'a str) -> char { let _ = r#"// no"#; let _ = "/* no */"; '/' } /* a /* nested */ b */\n`;
    expect(texts("a.rs", src)).toEqual(["/* a /* nested */ b */"]);
  });

  it("CSS: a string holding /* is not a comment", () => {
    expect(texts("a.css", 'a::before { content: "/* x */"; } /* real */\n')).toEqual(["/* real */"]);
  });
});

describe("comment blocks", () => {
  it("adjacent own-line comments are one block; a blank line or code splits them", () => {
    const src = "// a\n// b\n// c\n// d\n\n// e\nconst x = 1; // f\n";
    expect(commentBlocks("a.ts", src)).toEqual([
      { line: 1, lines: 4 },
      { line: 6, lines: 1 },
      { line: 7, lines: 1 },
    ]);
    expect(longBlocks("a.ts", src)).toEqual([{ line: 1, lines: 4 }]);
  });

  it("a multi-line block comment counts its physical lines", () => {
    expect(commentBlocks("a.rs", "/// one\n/// two\nfn f() {}\n/*\n x\n*/\n")).toEqual([
      { line: 1, lines: 2 },
      { line: 4, lines: 3 },
    ]);
  });
});

describe("comments-only check", () => {
  const before = "// why\n// more\nexport const x = 1; // eslint-disable-line no-console\n";

  it("passes a comment rewrite", () => {
    expect(commentsOnlyProblems("a.ts", before, "// why\nexport const x = 1; // eslint-disable-line no-console\n")).toEqual([]);
  });

  it("catches a code change", () => {
    const after = before.replace("= 1", "= 2");
    expect(commentsOnlyProblems("a.ts", before, after)).toEqual([expect.stringMatching(/^code changed/)]);
  });

  it("catches a dropped tool directive, which is a comment that changes behaviour", () => {
    const after = before.replace(" // eslint-disable-line no-console", "");
    expect(commentsOnlyProblems("a.ts", before, after)).toEqual([expect.stringMatching(/directive/)]);
  });

  it("works for Rust and CSS too", () => {
    expect(commentsOnlyProblems("a.rs", "/// a\n/// b\nfn f() {}\n", "/// a\nfn f() {}\n")).toEqual([]);
    expect(commentsOnlyProblems("a.rs", "fn f() {}\n", "fn g() {}\n")).toHaveLength(1);
    expect(commentsOnlyProblems("a.css", "/* a */\na { b: 1px }\n", "a { b: 2px }\n")).toHaveLength(1);
  });
});

describe("applyBlocks", () => {
  it("replaces a block by its start line, keeping the indentation", () => {
    const src = "function f() {\n  // a\n  // b\n  // c\n  // d\n  return 1;\n}\n";
    const { text, errors } = applyBlocks("a.ts", src, [{ line: 2, text: "// short" }]);
    expect(errors).toEqual([]);
    expect(text).toBe("function f() {\n  // short\n  return 1;\n}\n");
  });

  it("lines a block comment's later lines up under its text", () => {
    const src = "  // a\n  // b\n  // c\n  // d\n  x();\n";
    const doc = applyBlocks("a.ts", src, [{ line: 1, text: "/** one\n* two */" }]).text;
    expect(doc).toBe("  /** one\n   * two */\n  x();\n");
    const css = applyBlocks("a.css", "/* a\n b\n c\n d */\na {}\n", [{ line: 1, text: "/* one\ntwo */" }]).text;
    expect(css).toBe("/* one\n   two */\na {}\n");
  });

  it("refuses a block that shares a line with code", () => {
    const src = "const x = 1; /* a\n b\n c\n d */\n";
    expect(applyBlocks("a.ts", src, [{ line: 1, text: "" }]).errors).toHaveLength(1);
  });
});

describe("the rule, on the whole repository", () => {
  it(`no tracked source file has a comment block over ${MAX_COMMENT_LINES} lines`, () => {
    const offenders = trackedSources()
      .filter((f) => !PENDING.includes(f))
      .flatMap((f) => longBlocks(f, readFileSync(path.join(root, f), "utf8")).map((b) => `${f}:${b.line} (${b.lines} lines)`));
    expect(offenders).toEqual([]);
  }, 60_000); // parses every tracked source file

  it("PENDING lists only files that still break the rule", () => {
    const stale = PENDING.filter((f) => longBlocks(f, readFileSync(path.join(root, f), "utf8")).length === 0);
    expect(stale).toEqual([]);
  });
});
