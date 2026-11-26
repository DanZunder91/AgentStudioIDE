/** Pure half of Agent Logs; every expectation is written by hand, none computed by the code. */

import { describe, expect, it } from "vitest";

import {
  applySourcePick,
  appPickerItems,
  appsLabel,
  COLLAPSED_OUTPUT_LINES,
  compileQuery,
  contentFilterActive,
  displayName,
  filterLines,
  formatLineForCopy,
  formatNameList,
  formatTime,
  highlightMachine,
  highlightOsLog,
  levelBadge,
  oneLine,
  resultOutput,
  resultToolName,
  rowWindow,
  SERVICE_SUFFIX,
  SOURCE_PALETTE_SIZE,
  parseNameList,
  sourceColorIndex,
  sourceSelection,
  sourcesOf,
  sourceTag,
  syslogTexts,
  toolHeader,
  toolParts,
  type LogFilter,
} from "./agentLogsFormat";
import type { LogLine, RunningApp } from "./agentLogsTypes";

const at = (h: number, m: number, s: number, ms: number) => new Date(2026, 0, 1, h, m, s, ms).getTime();

let nextId = 1;
function line(p: Partial<LogLine> = {}): LogLine {
  return {
    id: nextId++,
    tsMs: at(12, 0, 0, 250),
    terminalId: null,
    agentId: null,
    source: "zsh · repo",
    kind: "output",
    level: "info",
    text: "hello",
    detail: null,
    toolUseId: null,
    ...p,
  };
}

describe("formatTime", () => {
  it.each([
    [at(12, 0, 0, 250), "12:00:00.250"],
    [at(0, 0, 0, 0), "00:00:00.000"],
    [at(7, 5, 3, 9), "07:05:03.009"],
    [at(23, 59, 59, 999), "23:59:59.999"],
    [at(12, 30, 1, 42), "12:30:01.042"],
  ])("%d → %s (zero-padded, local time)", (ts, want) => {
    expect(formatTime(ts)).toBe(want);
  });
});

describe("levelBadge / oneLine", () => {
  it.each([
    ["error", "E"],
    ["warn", "W"],
    ["info", "I"],
    ["debug", "D"],
  ] as const)("%s → %s", (level, want) => expect(levelBadge(level)).toBe(want));

  it("oneLine folds LF and CRLF into a visible marker", () => {
    expect(oneLine("a\nb\r\nc")).toBe("a ⏎ b ⏎ c");
    expect(oneLine("plain")).toBe("plain");
  });
});

describe("formatLineForCopy", () => {
  it("time · badge · source · text, on one line", () => {
    const l = line({ level: "error", source: "claude · gazelle", text: "Bash: npm test\nFAILED" });
    expect(formatLineForCopy(l)).toBe("12:00:00.250 E claude · gazelle  Bash: npm test ⏎ FAILED");
  });
});

describe("sourceColorIndex", () => {
  it("is stable, in range, and pinned for known labels (FNV-1a)", () => {
    // Hand-computed FNV-1a 32-bit: "" → 0x811c9dc5 = 2166136261, % 8 = 5.
    // "a" → 0xe40c292c = 3826002220, % 8 = 4.
    expect(sourceColorIndex("")).toBe(5);
    expect(sourceColorIndex("a")).toBe(4);
    expect(sourceColorIndex("claude · gazelle")).toBe(sourceColorIndex("claude · gazelle"));
    for (const s of ["zsh", "claude · gazelle", "npm run dev", "Explore agent", "x".repeat(300)]) {
      const i = sourceColorIndex(s);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(SOURCE_PALETTE_SIZE);
      expect(Number.isInteger(i)).toBe(true);
    }
  });

  it("spreads different labels over several slots (not a constant)", () => {
    const slots = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(sourceColorIndex));
    expect(slots.size).toBeGreaterThan(3);
  });
});

describe("toolParts", () => {
  it.each([
    ["Bash: ls -la", "Bash", ": ls -la"],
    ["Edit: /src/a.ts", "Edit", ": /src/a.ts"],
    ["TodoWrite", "TodoWrite", ""],
    ["mcp__github__create_pr: title", "mcp__github__create_pr", ": title"],
    ["WebFetch: https://x.dev/a:b", "WebFetch", ": https://x.dev/a:b"],
  ])("%j → name %j + rest %j", (text, name, rest) => {
    expect(toolParts(text)).toEqual({ name, rest });
  });

  it.each(["some prose: with a colon", "Bash:nospace", "", "1abc: x"])("%j has no tool prefix", (text) => {
    expect(toolParts(text)).toEqual({ name: null, rest: text });
  });
});

describe("toolHeader — a command block's header from Rust's `tool` line shapes", () => {
  // [text, detail] → [label, description, full]; the shapes are agent/claude.rs::summarize_tool_use's.
  it.each<[string, string | null, string, string | null, string | null]>([
    // Bash, one-line command, a description.
    ["Bash: cargo test --lib", "Run the unit tests", "$ cargo test --lib", "Run the unit tests", null],
    // Bash, one-line command, no description.
    ["Bash: ls -la", null, "$ ls -la", null, null],
    // Bash, multi-line command (row shows the first line + ` …`), no description: detail is the command.
    ["Bash: sleep 2 …", "sleep 2\ncurl -s http://localhost:8080/health", "$ sleep 2 …", null, "sleep 2\ncurl -s http://localhost:8080/health"],
    // Bash, multi-line command WITH a description: `description\n\ncommand`.
    ["Bash: sleep 2 …", "Probe gazelle\n\nsleep 2\ncurl -s http://localhost:8080/health", "$ sleep 2 …", "Probe gazelle", "sleep 2\ncurl -s http://localhost:8080/health"],
    // A description that itself holds a blank line is still a description when nothing after it is the command.
    ["Bash: make", "Build it\n\nthen ship", "$ make", "Build it\n\nthen ship", null],
    ["Read: /work/proj/src/lib.rs", null, "Read /work/proj/src/lib.rs", null, null],
    ["Edit: /work/proj/src/a.rs", null, "Edit /work/proj/src/a.rs", null, null],
    ["Grep: fn parse", null, 'Grep "fn parse"', null, null],
    ["Glob: **/*.rs", null, 'Glob "**/*.rs"', null, null],
    ["WebFetch: https://example.test/doc", null, "WebFetch https://example.test/doc", null, null],
    ["Agent: Explore the parser", null, "Agent Explore the parser", null, null],
    ["TodoWrite", null, "TodoWrite", null, null],
    // A non-Bash multi-line value: the detail is the whole value, never a description.
    ["Grep: a …", "a\nb", 'Grep "a …"', null, "a\nb"],
    // Only Bash has a description: a non-Bash detail is the full value even with a blank line in it.
    ["Write: /x …", "line one …\n\n/x\nmore", "Write /x …", null, "line one …\n\n/x\nmore"],
    // No tool prefix: rendered verbatim.
    ["some prose: with a colon", null, "some prose: with a colon", null, null],
  ])("%j + detail %j", (text, detail, label, description, full) => {
    const h = toolHeader({ text, detail });
    expect([h.label, h.description, h.full]).toEqual([label, description, full]);
  });

  it("names the tool, or null without a prefix", () => {
    expect(toolHeader({ text: "Bash: x", detail: null }).name).toBe("Bash");
    expect(toolHeader({ text: "prose here", detail: null }).name).toBeNull();
  });
});

describe("resultOutput / resultToolName — a block's nested output", () => {
  it.each<[string, string, string | null, string[]]>([
    ["one line, no detail: the text after the arrow", "Bash → running 3 tests", null, ["running 3 tests"]],
    ["multi-line: the detail, split", "Bash → running 3 tests", "running 3 tests\ntest a ... ok\ntest result: ok", ["running 3 tests", "test a ... ok", "test result: ok"]],
    ["the Bash invocation line `$ command` + blank is dropped — the header shows the command", "Bash → {\"status\":\"ok\"}", "$ curl -s localhost:8080/health && tail gazelle.log\n\n{\"status\":\"ok\"}\nconnected to the database", ['{"status":"ok"}', "connected to the database"]],
    ["another tool's invocation line `Tool: summary` + blank is dropped the same way", "Read → fn main() {}", "Read: /work/proj/src/lib.rs\n\nfn main() {}", ["fn main() {}"]],
    ["a bare tool name as the invocation line", "TodoWrite → ok", "TodoWrite\n\nok", ["ok"]],
    ["Rust's `(no output)` after the invocation line is the one output line", "Bash → (no output)", "$ true\n\n(no output)", ["(no output)"]],
    ["an invocation line with nothing after it falls back to the text", "Bash → (no output)", "$ true\n\n", ["(no output)"]],
    ["an invocation line with no blank line after it is output, not a preamble (an older build)", "Bash → x", "$ true\nx", ["$ true", "x"]],
    ["a lone invocation-shaped line with no newline at all falls back to the text", "Bash → x", "$ true", ["x"]],
    ["a first line that is not invocation-shaped is kept even when a blank line follows", "Bash → para", "para one\n\npara two", ["para one", "", "para two"]],
    ["a result with no arrow is one line of itself", "bare output", null, ["bare output"]],
    ["an empty text is no output", "Bash → ", null, []],
    ["the `… (N more lines)` note is a line like any other", "Read → l1", "l1\nl2\n… (5 more lines)", ["l1", "l2", "… (5 more lines)"]],
  ])("%s", (_n, text, detail, want) => {
    expect(resultOutput({ text, detail })).toEqual(want);
  });

  it.each<[string, string | null]>([
    ["Bash → running 3 tests", "Bash"],
    ["WebFetch → Request failed with status 404", "WebFetch"],
    ["mcp__github__create_pr → done", "mcp__github__create_pr"],
    ["no arrow here", null],
    [" → leading arrow", null],
    ["not a name → x", null],
  ])("resultToolName(%j) → %j", (text, want) => expect(resultToolName(text)).toBe(want));

  it("a collapsed block shows three lines", () => {
    expect(COLLAPSED_OUTPUT_LINES).toBe(3);
  });
});

describe("highlightOsLog", () => {
  it("splits a real os_log line into process and subsystem segments", () => {
    const text =
      "Demo[1234:5678] [com.example.demo:net] uploader: request rejected by server";
    expect(highlightOsLog(text)).toEqual([
      { kind: "process", text: "Demo[1234:5678]" },
      { kind: "plain", text: " " },
      { kind: "subsystem", text: "[com.example.demo:net]" },
      { kind: "plain", text: " uploader: request rejected by server" },
    ]);
  });

  it("finds tokens mid-line, a bare pid, and a subsystem without category", () => {
    expect(highlightOsLog("2026 E  launchd[1] [com.apple.xpc] spawned")).toEqual([
      { kind: "plain", text: "2026 E  " },
      { kind: "process", text: "launchd[1]" },
      { kind: "plain", text: " " },
      { kind: "subsystem", text: "[com.apple.xpc]" },
      { kind: "plain", text: " spawned" },
    ]);
  });

  it.each([
    "no brackets here",
    "array[i] and [x] and [42]",
    "[notdotted:cat] foo",
    "",
  ])("%j has no highlight", (text) => {
    expect(highlightOsLog(text)).toEqual(text === "" ? [] : [{ kind: "plain", text }]);
  });

  it("never produces markup — `<b>` stays literal text in a plain segment", () => {
    expect(highlightOsLog("<b>x</b>")).toEqual([{ kind: "plain", text: "<b>x</b>" }]);
  });
});

describe("compileQuery", () => {
  it("empty / whitespace is no filter", () => {
    expect(compileQuery("")).toEqual({ ok: true, test: null });
    expect(compileQuery("   ")).toEqual({ ok: true, test: null });
  });

  it("plain text is a case-insensitive substring", () => {
    const m = compileQuery("Rejected");
    if (!m.ok || !m.test) throw new Error("expected a matcher");
    expect(m.test("request rejected by server")).toBe(true);
    expect(m.test("request accepted")).toBe(false);
  });

  it("/re/flags is a regex; the i flag is honoured and not forced", () => {
    const cs = compileQuery("/^Bash/");
    const ci = compileQuery("/^bash/i");
    if (!cs.ok || !cs.test || !ci.ok || !ci.test) throw new Error("expected matchers");
    expect(cs.test("Bash: ls")).toBe(true);
    expect(cs.test("bash: ls")).toBe(false);
    expect(ci.test("BASH: ls")).toBe(true);
  });

  it("drops g/y so repeated tests are not stateful", () => {
    const m = compileQuery("/err/g");
    if (!m.ok || !m.test) throw new Error("expected a matcher");
    expect([m.test("err 1"), m.test("err 2"), m.test("err 3")]).toEqual([true, true, true]);
  });

  it.each(["/(/", "/a/zz", "/[/"])("%j is an invalid regex, reported not thrown", (q) => {
    const m = compileQuery(q);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error.length).toBeGreaterThan(0);
  });

  it("a lone slash or `//` is searched literally", () => {
    const m = compileQuery("//");
    if (!m.ok || !m.test) throw new Error("expected a matcher");
    expect(m.test("http://x")).toBe(true);
    expect(m.test("no slashes")).toBe(false);
  });
});

describe("filterLines", () => {
  const all: LogFilter = {
    query: "",
    levels: { error: true, warn: true, info: true, debug: true },
    ide: true,
    hiddenSources: [],
    onlySources: null,
  };
  const L = [
    line({ id: 1, level: "error", kind: "output", source: "zsh", text: "npm ERR! fatal" }),
    line({ id: 2, level: "warn", kind: "tool", source: "claude · a", text: "Bash: rm -rf build" }),
    line({ id: 3, level: "info", kind: "tool-result", source: "claude · a", text: "removed 3 files" }),
    line({ id: 4, level: "debug", kind: "system", source: "zsh", text: "terminal opened" }),
    line({ id: 5, level: "info", kind: "output", source: "vite", text: "ready in 300ms" }),
    line({ id: 6, level: "error", kind: "machine", source: "Demo", text: "[com.example.demo:net] rejected" }),
    // A background task's line: the service's own log line.
    line({
      id: 7, level: "info", kind: "task", source: "gazelle · bg",
      text: "2026-01-01T12:00:01Z INFO gazelle: listening on 0.0.0.0:8080",
      detail: "cargo run --bin gazelle\n/tmp/claude-501/-work-gazelle/s1/tasks/b1.output",
    }),
    // The canonical case: a multi-line Bash command — the row shows its first line, the
    // `/health` call lives only in the detail.
    line({
      id: 8, level: "info", kind: "tool", source: "claude · gazelle", text: "Bash: sleep 2",
      detail: "sleep 2\ncurl -s http://localhost:8080/health | jq .\nWait for gazelle to boot, then probe it",
    }),
  ];
  const ids = (f: Partial<LogFilter>) => filterLines(L, { ...all, ...f }).rows.map((l) => l.id);

  it.each<[string, Partial<LogFilter>, number[]]>([
    ["no filter", {}, [1, 2, 3, 4, 5, 6, 7, 8]],
    ["substring on text", { query: "rm -rf" }, [2]],
    ["substring is case-insensitive", { query: "READY" }, [5]],
    // 7 through its detail's `/tmp/claude-501/…` output path.
    ["substring on the source label (or the detail)", { query: "claude" }, [2, 3, 7, 8]],
    ["regex", { query: "/^(npm|ready)/" }, [1, 5]],
    ["regex anchored on source", { query: "/^vite$/" }, [5]],
    ["substring in the detail only (a multi-line command's 2nd line)", { query: "/health" }, [8]],
    ["regex over the detail", { query: "/localhost:\\d+\\/health/" }, [8]],
    ["a task's output path in its detail", { query: "tasks/b1.output" }, [7]],
    ["levels: errors only", { levels: { error: true, warn: false, info: false, debug: false } }, [1, 6]],
    ["levels: no debug", { levels: { error: true, warn: true, info: true, debug: false } }, [1, 2, 3, 5, 6, 7, 8]],
    // No kind toggles any more: every kind passes; the sidebar's grouping replaced them.
    ["every wire kind passes an all-on filter", { query: "/./" }, [1, 2, 3, 4, 5, 6, 7, 8]],
    ["IDE off hides every non-machine kind — a task line included", { ide: false }, [6]],
    ["IDE off + a machine source hidden shows nothing", { ide: false, hiddenSources: ["Demo"] }, []],
    ["hidden source", { hiddenSources: ["zsh"] }, [2, 3, 5, 6, 7, 8]],
    ["two hidden sources", { hiddenSources: ["zsh", "vite"] }, [2, 3, 6, 7, 8]],
    ["only: a pick shows just those sources", { onlySources: ["vite", "Demo"] }, [5, 6]],
    ["only wins over hidden", { onlySources: ["zsh"], hiddenSources: ["zsh"] }, [1, 4]],
    ["only: an empty pick shows nothing", { onlySources: [] }, []],
    // `a` hits 7 in its own text and in its detail (`cargo run`).
    ["combined: text + level + source", { query: "a", levels: { error: false, warn: true, info: true, debug: true }, hiddenSources: ["vite"] }, [2, 3, 4, 7, 8]],
    ["no match", { query: "nothing-like-this" }, []],
  ])("%s", (_name, f, want) => {
    expect(ids(f)).toEqual(want);
  });

  it("an invalid regex reports its error and still applies the other filters", () => {
    const r = filterLines(L, { ...all, query: "/(/", hiddenSources: ["zsh"] });
    expect(r.error).toMatch(/./);
    expect(r.rows.map((l) => l.id)).toEqual([2, 3, 5, 6, 7, 8]);
    expect(r.viaDetail.size).toBe(0);
  });

  it("viaDetail names exactly the rows the query hit ONLY in their detail", () => {
    const via = (query: string) => [...filterLines(L, { ...all, query }).viaDetail];
    expect(via("/health")).toEqual([8]);
    expect(via("/HEALTH/i")).toEqual([8]);
    // A hit on the row's own text or source is not a detail hit, even when the detail matches too.
    expect(via("sleep")).toEqual([]);
    expect(via("gazelle")).toEqual([]);
    expect(via("cargo")).toEqual([7]);
    expect(via("")).toEqual([]);
    // A row the other filters drop is never reported.
    expect([...filterLines(L, { ...all, query: "/health", hiddenSources: ["claude · gazelle"] }).viaDetail]).toEqual([]);
  });

  it("a valid query reports no error", () => {
    expect(filterLines(L, { ...all, query: "x" }).error).toBeNull();
  });

  it.each<[string, Partial<LogFilter>, boolean]>([
    ["nothing", {}, false],
    ["a substring query", { query: "health" }, true],
    ["a regex query", { query: "/^x/" }, true],
    ["whitespace only is no query", { query: "   " }, false],
    ["an INVALID regex does not count (the rows ignore it)", { query: "/(/" }, false],
    ["a level off", { levels: { ...all.levels, debug: false } }, true],
    ["a source pick is not a content filter", { onlySources: ["zsh"] }, false],
    ["a hidden source is not a content filter", { hiddenSources: ["zsh"] }, false],
    ["IDE off is not a content filter", { ide: false }, false],
  ])("contentFilterActive: %s", (_n, f, want) => {
    expect(contentFilterActive({ ...all, ...f })).toBe(want);
  });
});

describe("displayName / sourceTag — a background task's ` · bg` becomes a tag", () => {
  // [wire label → what the eye reads, the tag]. Written by hand, not from the function.
  it.each<[string, string, "service" | null]>([
    ["gazelle · bg", "gazelle", "service"],
    ["tail · bg", "tail", "service"],
    ["my service · bg", "my service", "service"],
    // Not the suffix: an agent, a terminal, a Mac app, a bare `bg`, a mid-label ` · bg `.
    ["claude · gazelle", "claude · gazelle", null],
    ["sh · proj", "sh · proj", null],
    ["Safari", "Safari", null],
    ["bg", "bg", null],
    ["x · bg · y", "x · bg · y", null],
    // The suffix without the separator's spaces is not the suffix.
    ["gazelle·bg", "gazelle·bg", null],
    ["gazelle ·bg", "gazelle ·bg", null],
    // Exactly one suffix comes off: Rust appends it once, so the rest is the program's own name.
    ["x · bg · bg", "x · bg", "service"],
    // Nothing but the suffix: shown as is rather than as an empty name.
    [" · bg", " · bg", null],
    ["", "", null],
  ])("%j → %j (%s)", (source, name, tag) => {
    expect(displayName(source)).toBe(name);
    expect(sourceTag(source)).toBe(tag);
  });

  it("the suffix is Rust's `<program> · bg` (logstream/tasks.rs)", () => {
    expect(SERVICE_SUFFIX).toBe(" · bg");
  });
});

describe("sourcesOf", () => {
  it("distinct, sorted case-insensitively", () => {
    const got = sourcesOf([
      line({ source: "zsh" }),
      line({ source: "Claude · b" }),
      line({ source: "zsh" }),
      line({ source: "alpha" }),
    ]);
    expect(got).toEqual(["alpha", "Claude · b", "zsh"]);
  });
});

describe("highlightMachine", () => {
  it("the leading [subsystem:category] is a subsystem segment; the rest gets the os_log pass", () => {
    expect(highlightMachine("[com.example.demo:net] uploader: helper[42] died")).toEqual([
      { kind: "subsystem", text: "[com.example.demo:net]" },
      { kind: "plain", text: " uploader: " },
      { kind: "process", text: "helper[42]" },
      { kind: "plain", text: " died" },
    ]);
  });

  it("a dot-less prefix (journald unit, bare subsystem) still counts — position, not shape", () => {
    expect(highlightMachine("[nginx.service] up")).toEqual([
      { kind: "subsystem", text: "[nginx.service]" },
      { kind: "plain", text: " up" },
    ]);
    expect(highlightMachine("[sdk:net] x")).toEqual([
      { kind: "subsystem", text: "[sdk:net]" },
      { kind: "plain", text: " x" },
    ]);
  });

  it("a prefix-only line is one segment", () => {
    expect(highlightMachine("[com.a:b]")).toEqual([{ kind: "subsystem", text: "[com.a:b]" }]);
  });

  it.each(["bare message", "mid [com.x.y] line", "[] empty", "[unclosed"])(
    "%j has no leading prefix — falls back to os_log highlighting",
    (text) => {
      expect(highlightMachine(text)).toEqual(highlightOsLog(text));
    },
  );

  it("mid-line tokens are still found when there is no prefix", () => {
    expect(highlightMachine("mid [com.x.y] line")).toEqual([
      { kind: "plain", text: "mid " },
      { kind: "subsystem", text: "[com.x.y]" },
      { kind: "plain", text: " line" },
    ]);
  });

  it("never produces markup", () => {
    expect(highlightMachine("[a:b] <img src=x>")).toEqual([
      { kind: "subsystem", text: "[a:b]" },
      { kind: "plain", text: " <img src=x>" },
    ]);
  });
});

describe("source picker", () => {
  const S = ["a", "b", "c"];
  const none = { hiddenSources: [] as string[], onlySources: null };

  it.each<[string, { hiddenSources: string[]; onlySources: string[] | null }, string[] | null]>([
    ["nothing hidden → all", none, null],
    ["hidden b → the rest", { hiddenSources: ["b"], onlySources: null }, ["a", "c"]],
    ["a pick → the pick", { hiddenSources: [], onlySources: ["c"] }, ["c"]],
    ["a pick wins over hidden", { hiddenSources: ["c"], onlySources: ["c"] }, ["c"]],
  ])("selection: %s", (_n, f, want) => {
    expect(sourceSelection(f, S)).toEqual(want);
  });

  it.each<[string, { hiddenSources: string[]; onlySources: string[] | null }, string[] | null, { hiddenSources: string[]; onlySources: string[] | null }]>([
    ["All resets everything", { hiddenSources: ["a"], onlySources: ["b"] }, null, none],
    ["untick one from all → exclusion (new sources still show)", none, ["a", "c"], { hiddenSources: ["b"], onlySources: null }],
    ["untick a second → exclusion grows", { hiddenSources: ["b"], onlySources: null }, ["c"], { hiddenSources: ["b", "a"], onlySources: null }],
    ["re-tick one → exclusion shrinks", { hiddenSources: ["b", "a"], onlySources: null }, ["c", "b"], { hiddenSources: ["a"], onlySources: null }],
    ["Only (drops two at once) → a pick", none, ["b"], { hiddenSources: [], onlySources: ["b"] }],
    ["untick the last shown → an empty pick", { hiddenSources: ["a", "b"], onlySources: null }, [], { hiddenSources: [], onlySources: [] }],
    ["All row off (null → []) → an empty pick", none, [], { hiddenSources: [], onlySources: [] }],
    ["tick two from nothing → a pick", { hiddenSources: [], onlySources: [] }, ["a", "c"], { hiddenSources: [], onlySources: ["a", "c"] }],
    ["a pick stays a pick when one is added", { hiddenSources: [], onlySources: ["a"] }, ["a", "b"], { hiddenSources: [], onlySources: ["a", "b"] }],
    ["swap one for another from all-except → a pick", { hiddenSources: ["c"], onlySources: null }, ["a", "c"], { hiddenSources: [], onlySources: ["a", "c"] }],
  ])("apply: %s", (_n, f, next, want) => {
    expect(applySourcePick(f, S, next)).toEqual(want);
  });

  it("apply copies the pick (the caller's array is not aliased into the store)", () => {
    const next = ["b"];
    const got = applySourcePick(none, S, next);
    next.push("zzz");
    expect(got.onlySources).toEqual(["b"]);
  });
});

describe("system apps helpers", () => {
  it.each([
    ["macos-unified-log", "Mac apps"],
    ["linux-journald", "System apps"],
    ["windows-eventlog", "System apps"],
    [null, "System apps"],
    [undefined, "System apps"],
  ] as const)("appsLabel(%s) → %s", (backend, want) => {
    expect(appsLabel(backend)).toBe(want);
  });

  it.each([
    ["macos-unified-log", "apps", "Choose mac apps", "Refresh the app list", "Subsystem", "Subsystem prefix, e.g. com.example.app", true],
    ["linux-journald", "apps", "Choose system apps", "Refresh the app list", "Systemd unit", "Systemd unit, e.g. nginx.service", true],
    [null, "apps", "Choose system apps", "Refresh the app list", "Systemd unit", "Systemd unit, e.g. nginx.service", true],
    [
      "windows-eventlog",
      "Event Log sources",
      "Choose event log sources",
      "Refresh the source list",
      "Extra channel",
      "Also read a channel, e.g. Microsoft-Windows-PowerShell/Operational",
      false,
    ],
  ] as const)("syslogTexts(%s): the picker, refresh and subsystem wording", (backend, noun, picker, refresh, label, placeholder, loud) => {
    const t = syslogTexts(backend);
    expect([t.noun, t.picker, t.refreshLabel, t.subsystemLabel, t.subsystemPlaceholder, t.highVolume]).toEqual([
      noun,
      picker,
      refresh,
      label,
      placeholder,
      loud,
    ]);
  });

  it("appPickerItems: a row without pids (a Windows Event Log provider) has no count", () => {
    const providers: RunningApp[] = [
      { name: "Microsoft-Windows-WindowsUpdateClient", pids: [], path: null, isApp: false },
      { name: "MsiInstaller", pids: [], path: null, isApp: true },
    ];
    expect(appPickerItems(providers)).toEqual([
      { id: "MsiInstaller", label: "MsiInstaller" },
      { id: "Microsoft-Windows-WindowsUpdateClient", label: "Microsoft-Windows-WindowsUpdateClient" },
    ]);
  });

  it("appPickerItems: .app bundles first (stable within each group), path sublabel, pid count", () => {
    const apps: RunningApp[] = [
      { name: "launchd", pids: [1], path: "/sbin/launchd", isApp: false },
      { name: "Xcode", pids: [10, 11], path: "/Applications/Xcode.app/Contents/MacOS/Xcode", isApp: true },
      { name: "kernel_task", pids: [0], path: null, isApp: false },
      { name: "Demo", pids: [5, 6, 7], path: "/Applications/Demo.app", isApp: true },
    ];
    expect(appPickerItems(apps)).toEqual([
      { id: "Xcode", label: "Xcode", sublabel: "/Applications/Xcode.app/Contents/MacOS/Xcode", count: 2 },
      { id: "Demo", label: "Demo", sublabel: "/Applications/Demo.app", count: 3 },
      { id: "launchd", label: "launchd", sublabel: "/sbin/launchd", count: 1 },
      { id: "kernel_task", label: "kernel_task", count: 1 },
    ]);
    expect("sublabel" in appPickerItems(apps)[3]).toBe(false);
  });

  it.each<[string, string[] | null]>([
    ["", null],
    ["   ,  , ", null],
    ["MyApp", ["MyApp"]],
    [" MyApp , SpringBoard,MyApp ", ["MyApp", "SpringBoard"]],
  ])("parseNameList(%j)", (text, want) => {
    expect(parseNameList(text)).toEqual(want);
  });

  it("formatNameList is blank for all and comma-joined otherwise", () => {
    expect(formatNameList(null)).toBe("");
    expect(formatNameList(["A", "B"])).toBe("A, B");
  });
});

describe("rowWindow", () => {
  it.each<[string, [number, number, number, number, number?], { start: number; end: number; padTop: number; padBottom: number }]>([
    ["empty", [0, 600, 18, 0], { start: 0, end: 0, padTop: 0, padBottom: 0 }],
    // 180/18 = 10 rows visible, +1 partial, +2 overscan each side.
    ["top", [0, 180, 18, 1000, 2], { start: 0, end: 13, padTop: 0, padBottom: 987 * 18 }],
    // first = 100; start 98; end 100+11+2 = 113.
    ["middle", [1800, 180, 18, 1000, 2], { start: 98, end: 113, padTop: 98 * 18, padBottom: 887 * 18 }],
    // scrollTop past the end clamps to maxScroll = 1000*18-180 = 17820 → first 990.
    ["clamped past end", [999999, 180, 18, 1000, 2], { start: 988, end: 1000, padTop: 988 * 18, padBottom: 0 }],
    ["negative scroll clamps to 0", [-50, 180, 18, 1000, 2], { start: 0, end: 13, padTop: 0, padBottom: 987 * 18 }],
    ["fewer rows than fit", [0, 600, 18, 5, 10], { start: 0, end: 5, padTop: 0, padBottom: 0 }],
  ])("%s", (_n, args, want) => {
    expect(rowWindow(...args)).toEqual(want);
  });

  it("20 000 rows render a bounded slice (default overscan)", () => {
    const w = rowWindow(180_000, 600, 18, 20_000);
    expect(w.end - w.start).toBeLessThanOrEqual(60);
    expect(w.end - w.start).toBeGreaterThan(30);
  });
});
