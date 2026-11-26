/** "→ open <service> stream": every expectation, including each path-match verdict, is written by
 * hand, independent of the function under test. */

import { describe, expect, it } from "vitest";

import { namesPath, pathTokens, servicePaths, streamLinkFor } from "./agentLogsLinks";
import type { LogLine } from "./agentLogsTypes";

const T = new Date(2026, 8, 25, 10, 0, 0, 0).getTime();
const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id,
  tsMs: T + id * 1000,
  terminalId: null,
  agentId: "a1",
  source: "claude · gazelle",
  kind: "output",
  level: "info",
  text: `line ${id}`,
  detail: null,
  toolUseId: null,
  ...p,
});
const OUT = "/private/tmp/claude-501/-work-gazelle/sess/tasks/bgen1a2b3.output";
const MON = "/private/tmp/claude-501/-work-gazelle/sess/tasks/bmon4c5d6.output";
const GAZELLE_DETAIL = `cd /work/gazelle && RUST_LOG=info ./target/debug/gazelle serve\n${OUT}`;

describe("servicePaths — the files every service tails, from the task lines' detail", () => {
  it("task lines and task announces: every line of the detail after the first, per source", () => {
    const paths = servicePaths([
      L(1, { kind: "system", source: "gazelle · bg", text: "background task started · gazelle (bgen1a2b3)", detail: GAZELLE_DETAIL }),
      L(2, { kind: "task", source: "gazelle · bg", text: "INFO up", detail: GAZELLE_DETAIL }),
      // A service that redirects to a file as well: two paths.
      L(3, { kind: "task", source: "api · bg", text: "listening", detail: `./api serve > api.log\n/tmp/t/b2.output\n/work/api/api.log` }),
      // The announce alone is enough (no output yet).
      L(4, { kind: "system", source: "tail · bg", text: "background task started · tail (bmon4c5d6)", detail: `tail -f /work/gazelle/server.log\n${MON}` }),
    ]);
    expect([...paths]).toEqual([
      [OUT, "gazelle · bg"],
      ["/tmp/t/b2.output", "api · bg"],
      ["/work/api/api.log", "api · bg"],
      [MON, "tail · bg"],
    ]);
  });

  it("ignores everything else: lines without detail, a one-line detail, other kinds, a stopped announce, blank path lines", () => {
    const paths = servicePaths([
      L(1, { kind: "task", source: "g · bg", text: "x" }), // no detail
      L(2, { kind: "task", source: "g · bg", text: "x", detail: "just the command" }),
      L(3, { kind: "tool", text: "Bash: cat /a/b", detail: "desc\n/a/b" }), // an agent's call is not a service
      L(4, { kind: "output", source: "zsh", text: "x", detail: "cmd\n/a/b" }),
      L(5, { kind: "system", source: "g · bg", text: "background task stopped · g (b1) — exited", detail: "cmd\n/tmp/b1.output" }),
      L(6, { kind: "task", source: "g · bg", text: "x", detail: "cmd\n\n   \n" }),
    ]);
    expect(paths.size).toBe(0);
  });
});

describe("pathTokens — what in a command or its output could be a file", () => {
  it.each<[string, string[]]>([
    ["grep ERROR /tmp/t/b1.output | tail -5", ["/tmp/t/b1.output"]],
    // `S=/tmp/x; cp …` — a real header: the path after `=` is a token of its own.
    ["S=/private/tmp/x/tasks/b1.output; cp $S /work/logs/", ["/private/tmp/x/tasks/b1.output", "/work/logs/"]],
    ['tail -f "/work/gazelle/logs/gazelle.log"', ["/work/gazelle/logs/gazelle.log"]],
    ["cat 'logs/gazelle.log' && echo done", ["logs/gazelle.log"]],
    // Trailing sentence / grep punctuation comes off; a mid-token colon stays.
    ["see /tmp/b1.output.", ["/tmp/b1.output"]],
    ["hit at src/a.rs:1:fn parse()", ["src/a.rs:1:fn"]],
    ["(in /work/x)", ["/work/x"]],
    ["path: [/a/b]", ["[/a/b"]],
    // Tokens with neither `/` nor `.` are never files.
    ["cargo test --lib", []],
    ["", []],
    // Redirects and pipes split too; the bare fd numbers are not files.
    ["./gazelle serve >gazelle.log 2>&1", ["./gazelle", "gazelle.log"]],
    // Windows: a backslash makes a token a path even with no `.` in it.
    ["type C:\\work\\logs\\gazelle", ["C:\\work\\logs\\gazelle"]],
    ['Get-Content "C:\\Users\\me\\tasks\\b1.output" -Tail 5', ["C:\\Users\\me\\tasks\\b1.output"]],
  ])("%j → %j", (text, want) => expect(pathTokens(text)).toEqual(want));
});

describe("namesPath — Windows streamed paths (Rust sends `C:\\…`)", () => {
  const WIN = "C:\\Users\\me\\AppData\\Local\\Temp\\claude\\0a1b\\sess\\tasks\\b1.output";
  // Each pair carries its own verdict.
  it.each<[string, string, boolean]>([
    [WIN, WIN, true],
    // The same file, spelled every way an agent spells it on Windows.
    ["C:/Users/me/AppData/Local/Temp/claude/0a1b/sess/tasks/b1.output", WIN, true],
    ["c:\\users\\me\\appdata\\local\\temp\\claude\\0a1b\\sess\\tasks\\B1.OUTPUT", WIN, true],
    ["/c/Users/me/AppData/Local/Temp/claude/0a1b/sess/tasks/b1.output", WIN, true],
    // Relative tails, either separator.
    ["b1.output", WIN, true],
    ["tasks\\b1.output", WIN, true],
    ["tasks/b1.output", WIN, true],
    // Still never a partial component, never another file.
    ["1.output", WIN, false],
    ["D:\\Users\\me\\AppData\\Local\\Temp\\claude\\0a1b\\sess\\tasks\\b1.output", WIN, false],
    ["/d/Users/me/AppData/Local/Temp/claude/0a1b/sess/tasks/b1.output", WIN, false],
    ["\\tasks\\b1.output", WIN, false],
    // A Windows-looking token never names a POSIX path, and POSIX stays case-sensitive.
    ["C:/work/gazelle.log", "/work/gazelle.log", false],
    ["Gazelle.log", "/work/gazelle.log", false],
  ])("%j names %j → %s", (token, path, want) => expect(namesPath(token, path)).toBe(want));

  it("a Windows block header links to the service that tails the file", () => {
    const paths = new Map([[WIN, "gazelle · bg"]]);
    const tool = L(1, { kind: "tool", text: "Bash: tail -5 /c/Users/me/AppData/Local/Temp/claude/0a1b/sess/tasks/b1.output" });
    expect(streamLinkFor({ tool, result: null }, paths)).toBe("gazelle · bg");
  });
});

describe("namesPath — a token names a streamed path", () => {
  // Each pair carries its own verdict.
  it.each<[string, string, boolean]>([
    ["/work/gazelle/logs/gazelle.log", "/work/gazelle/logs/gazelle.log", true],
    ["gazelle.log", "/work/gazelle/logs/gazelle.log", true],
    ["logs/gazelle.log", "/work/gazelle/logs/gazelle.log", true],
    ["gazelle/logs/gazelle.log", "/work/gazelle/logs/gazelle.log", true],
    // A partial component is not the file.
    ["zelle.log", "/work/gazelle/logs/gazelle.log", false],
    ["ogs/gazelle.log", "/work/gazelle/logs/gazelle.log", false],
    // A different file with the same tail is a different file.
    ["x/gazelle.log", "/work/gazelle/logs/gazelle.log", false],
    // An absolute token must be the path exactly.
    ["/logs/gazelle.log", "/work/gazelle/logs/gazelle.log", false],
    ["/work/gazelle/logs/gazelle.log/", "/work/gazelle/logs/gazelle.log", false],
    // The path must not be shorter than the token.
    ["/work/gazelle/logs/gazelle.log", "gazelle.log", false],
    ["", "/a", false],
    ["a", "/a", true],
  ])("%j names %j → %s", (token, path, want) => expect(namesPath(token, path)).toBe(want));
});

describe("streamLinkFor — which block headers link to a service's stream", () => {
  const paths = new Map([
    [OUT, "gazelle · bg"],
    ["/work/gazelle/logs/gazelle.log", "gazelle · bg"],
    [MON, "tail · bg"],
  ]);
  const block = (tool: LogLine | null, result: LogLine | null) => ({ tool, result });

  it.each<[string, LogLine | null, LogLine | null, string | null]>([
    ["the reference block: grep over the service's output file", L(1, { kind: "tool", text: `Bash: grep ERROR ${OUT} | tail -5` }), null, "gazelle · bg"],
    ["a relative spelling of a redirected log", L(1, { kind: "tool", text: "Bash: tail -20 logs/gazelle.log", detail: "Show the last errors" }), null, "gazelle · bg"],
    ["the path only in the call's detail (a multi-line command)", L(1, { kind: "tool", text: "Bash: sleep 1 …", detail: `sleep 1\ncat ${OUT}` }), null, "gazelle · bg"],
    [
      "the path only in the result's detail: the Bash that STARTED the service names its output file",
      L(1, { kind: "tool", text: "Bash: cd /work/gazelle && ./gazelle serve" }),
      L(2, { kind: "tool-result", text: "Bash → Command running in background", detail: `$ cd /work/gazelle && ./gazelle serve\n\nCommand running in background with ID: bgen1a2b3\nOutput: ${OUT}` }),
      "gazelle · bg",
    ],
    ["an orphan result naming the tail service's file", null, L(2, { kind: "tool-result", text: "Bash → x", detail: `$ wc -l ${MON}\n\n12 ${MON}` }), "tail · bg"],
    ["a Read of the log file", L(1, { kind: "tool", text: "Read: /work/gazelle/logs/gazelle.log" }), null, "gazelle · bg"],
    // No link:
    ["a command over another file", L(1, { kind: "tool", text: "Bash: cat /work/gazelle/logs/other.log" }), null, null],
    ["a partial name", L(1, { kind: "tool", text: "Bash: grep x ezelle.log" }), null, null],
    ["the service's directory, not its file", L(1, { kind: "tool", text: "Bash: ls /work/gazelle/logs" }), null, null],
    ["a result whose text (not detail) names the file — only detail is scanned for results", L(1, { kind: "tool", text: "Bash: true" }), L(2, { kind: "tool-result", text: `Bash → ${OUT}` }), null],
    ["nothing at all", null, null, null],
  ])("%s", (_n, tool, result, want) => {
    expect(streamLinkFor(block(tool, result), paths)).toBe(want);
  });

  it("no services streaming: never a link, whatever the command", () => {
    expect(streamLinkFor(block(L(1, { kind: "tool", text: `Bash: cat ${OUT}` }), null), new Map())).toBeNull();
  });

  it("the first match wins, in call-text, call-detail, result-detail order", () => {
    const b = block(
      L(1, { kind: "tool", text: `Bash: cat ${MON}`, detail: `desc\n\ncat ${MON}\ncat ${OUT}` }),
      L(2, { kind: "tool-result", text: "Bash → x", detail: `$ cat\n\n${OUT}` }),
    );
    expect(streamLinkFor(b, paths)).toBe("tail · bg");
  });
});
