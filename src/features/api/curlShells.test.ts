/**
 * curlShells — cmd.exe's caret pass, the C runtime's argv split, PowerShell's
 * argument split and 5.1's legacy re-quoting. The expected values marked
 * "measured" were observed on Windows 11 (cmd.exe, Windows PowerShell
 * 5.1.26100, System32 curl.exe 8.22, and node's MSVC-CRT argv) — they are the
 * shells' real behaviour, not a reading of documentation.
 */

import { describe, expect, it } from "vitest";

import {
  cmdCaretPass,
  crtSplit,
  legacyNativeArgv,
  tokenizeCmd,
  tokenizePowerShell,
  type ShellChar,
} from "./curlShells";

const text = (cs: ShellChar[]) => cs.map((x) => x.c).join("");
const plain = (s: string): ShellChar[] => Array.from(s, (c) => ({ c, caret: false }));

describe("cmdCaretPass — cmd.exe's own pass", () => {
  it("strips carets outside cmd's quotes and remembers what each one escaped", () => {
    expect(cmdCaretPass('a^&b ^"c^"')).toEqual([
      { c: "a", caret: false },
      { c: "&", caret: true },
      { c: "b", caret: false },
      { c: " ", caret: false },
      { c: '"', caret: true },
      { c: "c", caret: false },
      { c: '"', caret: true },
    ]);
  });

  it("keeps carets as text inside cmd's own quotes", () => {
    expect(text(cmdCaretPass('"a^&b" c'))).toBe('"a^&b" c');
  });

  it("joins a ^-continued line, escaping the next line's first character — ^ LF LF is a newline", () => {
    expect(text(cmdCaretPass("a ^\n  b"))).toBe("a   b");
    expect(cmdCaretPass("x^\n\ny")).toEqual([
      { c: "x", caret: false },
      { c: "\n", caret: true },
      { c: "y", caret: false },
    ]);
  });

  it("drops every CR first, so a CRLF paste continues its lines the same way", () => {
    expect(text(cmdCaretPass("a ^\r\n  b\r"))).toBe("a   b");
  });

  it("ends the command at an unescaped newline, &, |, < or > — but not at a quoted one", () => {
    for (const sep of ["\n", "&", "|", "<", ">"]) {
      expect(text(cmdCaretPass(`one${sep}two`))).toBe("one");
    }
    expect(text(cmdCaretPass('"a&b"&c'))).toBe('"a&b"');
  });

  it("lets a caret at the very end escape nothing", () => {
    expect(text(cmdCaretPass("a^"))).toBe("a");
  });
});

describe("crtSplit — the C runtime's argv rules", () => {
  it("splits on unquoted spaces and tabs, and a quoted run is one argument", () => {
    expect(crtSplit(plain('a "b c"  d\te'))).toEqual(["a", "b c", "d", "e"]);
    expect(crtSplit(plain("   "))).toEqual([]);
  });

  it("reads backslashes literally except right before a quote", () => {
    // a\b → a\b ; "c\\" → c\ (pair before the closing quote) ; d\"e → d"e ;
    // f\\\"g → f\"g (pair + escaped quote)
    expect(crtSplit(plain('a\\b "c\\\\" d\\"e f\\\\\\"g'))).toEqual(["a\\b", "c\\", 'd"e', 'f\\"g']);
  });

  it('reads "" inside quotes as a literal quote, a newline as text, and "" alone as an empty argument', () => {
    expect(crtSplit(plain('"say ""hi"""'))).toEqual(['say "hi"']);
    expect(crtSplit(plain('"x\ny" ""'))).toEqual(["x\ny", ""]);
  });
});

describe("tokenizeCmd — DevTools' doubled backslashes", () => {
  it("halves an even run of CARETED backslashes that is not before a quote", () => {
    // DevTools writes the browser's `a\nb` (a JSON escape) as ^"a^\^\nb^"; cmd +
    // curl.exe would send a\\nb (measured) — the paste wants the browser's.
    expect(tokenizeCmd('x ^"a^\\^\\nb^"')).toEqual(["x", "a\\nb"]);
  });

  it("leaves an odd careted run, a bare run and a mixed run as the C runtime reads them", () => {
    expect(tokenizeCmd('^"a^\\b^"')).toEqual(["a\\b"]);
    expect(tokenizeCmd('^"a\\\\b^"')).toEqual(["a\\\\b"]);
    expect(tokenizeCmd('^"a^\\\\b^"')).toEqual(["a\\\\b"]);
  });

  it("applies the C runtime's rule to a careted run that IS before a quote", () => {
    // `\"` in the value → DevTools \\\" → ^\^\^\^" → one backslash + a literal quote.
    expect(tokenizeCmd('^"a^\\^\\^\\^"b^"')).toEqual(['a\\"b']);
  });

  it("takes only the first command of a 'Copy all as cURL (cmd)' paste", () => {
    expect(tokenizeCmd('curl ^"https://a.test/1^" &\r\ncurl ^"https://a.test/2^"')).toEqual([
      "curl",
      "https://a.test/1",
    ]);
  });
});

describe("tokenizePowerShell — argument mode", () => {
  it("reads '…' literally, with '' as one quote", () => {
    expect(tokenizePowerShell("curl.exe 'it''s $HOME `n' ''")).toEqual(["curl.exe", "it's $HOME `n", ""]);
  });

  it('reads "…" with backtick escapes and "", and never expands a $variable', () => {
    expect(tokenizePowerShell('"a`"b`$c ""d"" $env:TOKEN"')).toEqual(['a"b$c "d" $env:TOKEN']);
    expect(tokenizePowerShell('"`0`a`b`f`n`r`t`v`q"')).toEqual(["\0\x07\b\f\n\r\t\vq"]);
  });

  it("keeps newlines inside a quoted string, and continues a line at a backtick", () => {
    expect(tokenizePowerShell("curl.exe `\n  -H 'X: y' `\r\n  --data-raw '{\n}'")).toEqual([
      "curl.exe",
      "-H",
      "X: y",
      "--data-raw",
      "{\n}",
    ]);
  });

  it("lets a backtick outside quotes escape the next character, and ignores a lone trailing one", () => {
    expect(tokenizePowerShell("a` b `")).toEqual(["a b"]);
  });

  it("joins adjacent pieces into one argument", () => {
    expect(tokenizePowerShell(`-H"X: y"'z'w`)).toEqual(["-HX: yzw"]);
  });

  it("ends the statement at an unquoted newline, ; or |", () => {
    expect(tokenizePowerShell("a b\nc")).toEqual(["a", "b"]);
    expect(tokenizePowerShell("a 'b;c'; d")).toEqual(["a", "b;c"]);
    expect(tokenizePowerShell('a "b|c" | d')).toEqual(["a", "b|c"]);
  });
});

describe("legacyNativeArgv — what Windows PowerShell 5.1 hands curl.exe", () => {
  it("matches 5.1 exactly: unescaped quotes are eaten and an empty argument vanishes (measured)", () => {
    // node argv.js '{"a": 1}' '{"a":1}' 'x y' '' 'tail'  →  ["{a: 1}","{a:1}","x y","tail"]
    expect(legacyNativeArgv(['{"a": 1}', '{"a":1}', "x y", "", "tail"])).toEqual([
      "{a: 1}",
      "{a:1}",
      "x y",
      "tail",
    ]);
  });

  it("counts escaped quotes too — the 5.1 idiom breaks at a space after an odd count (measured)", () => {
    // curl.exe --data-raw '{\"a\":\"x y\"}' sent {"a":"x  (measured)
    expect(legacyNativeArgv(['{\\"a\\":\\"x y\\"}'])).toEqual(['{"a":"x', 'y"}']);
    expect(legacyNativeArgv(['{\\"a\\":1}'])).toEqual(['{"a":1}']);
  });

  it("wraps a whitespace argument without doubling its trailing backslash (measured)", () => {
    expect(legacyNativeArgv(["a b\\\\", "ab\\"])).toEqual(["a b\\", "ab\\"]);
  });
});
