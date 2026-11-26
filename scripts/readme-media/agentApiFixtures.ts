/**
 * Fictional data for the "agents drive Agent Studio" README shots (10-agent-api-tools,
 * 11-claude-code-setting).
 *
 * A Claude Code session in the "Add rate limiting" agent's terminal runs three real
 * `agent-studio` commands against the todo-api on localhost:3000. Each command's output is built
 * here the way the Rust tools write it (`agent_ctl/commands/http.rs` and `http_report.rs`), then
 * cut down the way Claude Code shows a Bash result (the first rows, then `… +N lines`). The app
 * side is driven by the events those same commands emit (`apiHistory`, `httpOpen`), with the
 * history entries the tools would have written.
 *
 * Same made-up world as fixtures.ts / panelFixtures.ts: no real hosts, people or secrets. The
 * API key only ever appears as its `{{API_KEY}}` name.
 */
import type { ApiStore } from "../../src/features/api/apiStoreIpc";
import type { HistoryEntry } from "../../src/features/api/historyIpc";
import type { HttpResponse } from "../../src/features/api/httpIpc";
import type { ClaudeMcpReport } from "../../src/features/settings/claudeMcpIpc";
import { c } from "./fixtures";
import * as X from "./panelFixtures";

const BASE = "http://localhost:3000";
const KEY_HEADER = { name: "x-api-key", value: "{{API_KEY}}" };

/* ───────────── the user's saved requests ───────────── */

export const LIST_URL = `${BASE}/api/todos?status=open&limit=3`;
export const BURST_URL = `${BASE}/api/todos?burst=1`;

/**
 * panelFixtures' API store, with "List open todos" saved the way the API-client shot shows it
 * (`?status=open&limit=3`, `x-api-key: {{API_KEY}}`). "Burst (expect 429)" carries no key, so the
 * request the agent opens for it is the same request.
 */
export const AGENT_API_STORE: ApiStore = {
  ...X.API_STORE,
  collections: X.API_STORE.collections.map((r) =>
    r.id === "r1" ? { ...r, url: LIST_URL, headers: [KEY_HEADER] } : r,
  ),
};

/* ───────────── what the server answers ───────────── */

/** `GET /api/todos?status=open&limit=3`: the API-client shot's 200, rate-limit headers and all. */
export const LIST_RESPONSE: HttpResponse = X.HTTP_RESPONSE;

const limitedBody = JSON.stringify({ error: "rate_limited", retryAfter: 1 });

/** `GET /api/todos?burst=1`: the limiter's 429 (`rateLimit.ts` in fixtures.ts). */
export const BURST_RESPONSE: HttpResponse = {
  status: 429,
  statusText: "Too Many Requests",
  headers: [
    { name: "content-type", value: "application/json; charset=utf-8" },
    { name: "retry-after", value: "1" },
    { name: "x-ratelimit-limit", value: "100" },
    { name: "x-ratelimit-remaining", value: "0" },
    { name: "date", value: "Mon, 05 Oct 2026 09:31:40 GMT" },
  ],
  body: limitedBody,
  durationMs: 2,
  sizeBytes: limitedBody.length,
  truncated: false,
};

/* ───────────── what the commands print (Rust's format) ───────────── */

/** `human_size` in http_report.rs. */
function humanSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** `response_report` in http_report.rs: status line, request line, notes, headers, body. */
function responseReport(r: HttpResponse, requestLine: string, notes: string[]): string[] {
  const ct = r.headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
  return [
    `${r.status} ${r.statusText} in ${r.durationMs} ms, ${humanSize(r.sizeBytes)}${ct ? ` (${ct})` : ""}`,
    requestLine,
    ...notes,
    "",
    `Headers (${r.headers.length}):`,
    ...r.headers.map((h) => `  ${h.name}: ${h.value}`),
    "",
    "Body (JSON, re-indented):",
    ...JSON.stringify(JSON.parse(r.body), null, 2).split("\n"),
  ];
}

const RECORDED = "Recorded in Agent Studio's API history.";
/** `run_saved`'s note when the request substituted environment values. */
const REDACTION_NOTE =
  "Values substituted from the environment are shown as their {{NAME}}, and credentials " +
  "written into the request as ***, wherever the response repeats them.";

/** `agent-studio api run "List open todos"`. */
const LIST_OUTPUT = responseReport(
  LIST_RESPONSE,
  `Saved request "List open todos": GET ${LIST_URL} (environment "local")`,
  [REDACTION_NOTE, RECORDED],
);

/** `agent-studio api run "Burst (expect 429)"` (no {{VARS}}, so no redaction note). */
const BURST_OUTPUT = responseReport(
  BURST_RESPONSE,
  `Saved request "Burst (expect 429)": GET ${BURST_URL} (environment "local")`,
  [RECORDED],
);

/** `tab_title` in http.rs: method, then the URL without scheme, query or fragment. */
export const OPEN_TITLE = "GET localhost:3000/api/todos";

/** `agent-studio http open …` (`run_open`). */
const OPEN_OUTPUT = [
  `Opened GET ${BURST_URL} in a new API client tab ("${OPEN_TITLE}"). Nothing was sent; the ` +
    "user can review it and press Send.",
];

/* ───────────── the history entries those sends append (history_store.rs) ───────────── */

const entry = (
  id: string,
  at: number,
  method: string,
  url: string,
  status: number,
  statusText: string,
  durationMs: number,
  sizeBytes: number,
  headers = [KEY_HEADER],
  body = "",
): HistoryEntry => ({ id, at, method, url, headers, body, status, statusText, durationMs, sizeBytes, error: null });

/** The user's own sends from earlier in the day, listed below the agent's in the rail. */
export function earlierHistory(now: number): HistoryEntry[] {
  const min = 60_000;
  return [
    entry("01JBX0A1", now - 118 * min, "GET", `${BASE}/health`, 200, "OK", 2, 15, []),
    entry("01JBX0A2", now - 112 * min, "GET", LIST_URL, 200, "OK", 4, 936),
    entry("01JBX0A3", now - 104 * min, "POST", `${BASE}/api/todos`, 201, "Created", 6, 182, [KEY_HEADER, { name: "content-type", value: "application/json" }], '{"title":"Paginate GET /api/todos","priority":"medium"}'),
    entry("01JBX0A4", now - 97 * min, "PATCH", `${BASE}/api/todos/128`, 200, "OK", 3, 204, [KEY_HEADER, { name: "content-type", value: "application/json" }], '{"status":"in_progress"}'),
    entry("01JBX0A5", now - 91 * min, "GET", `${BASE}/api/todos/128`, 200, "OK", 2, 231),
    entry("01JBX0A6", now - 86 * min, "DELETE", `${BASE}/api/todos/112`, 204, "No Content", 3, 0),
  ];
}

/** `api run "List open todos"`: the literal saved request (its {{API_KEY}} kept) and its outcome. */
export const listEntry = (at: number): HistoryEntry =>
  entry("01JBX7QK", at, "GET", LIST_URL, LIST_RESPONSE.status, LIST_RESPONSE.statusText, LIST_RESPONSE.durationMs, LIST_RESPONSE.sizeBytes);

/** `api run "Burst (expect 429)"`. */
export const burstEntry = (at: number): HistoryEntry =>
  entry("01JBX7RZ", at, "GET", BURST_URL, BURST_RESPONSE.status, BURST_RESPONSE.statusText, BURST_RESPONSE.durationMs, BURST_RESPONSE.sizeBytes, []);

/** The `httpOpen` event `agent-studio http open` emits (`run_open`), minus the envelope. */
export const OPEN_EVENT = { method: "GET", url: BURST_URL, headers: [], body: null, title: OPEN_TITLE };

/* ───────────── the Claude Code session ───────────── */

const nl = (lines: string[]) => lines.join("\r\n") + "\r\n";

/** Word-wrap `text` to `width` columns (a word longer than a row is cut, as a terminal would). */
function wrap(text: string, width: number): string[] {
  if (text === "") return [""];
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    let w = word;
    while (w.length > width) {
      const room = width - (row === "" ? 0 : row.length + 1);
      if (room <= 0) {
        rows.push(row);
        row = "";
        continue;
      }
      row = row === "" ? w.slice(0, room) : `${row} ${w.slice(0, room)}`;
      rows.push(row);
      row = "";
      w = w.slice(room);
    }
    if (row === "") row = w;
    else if (row.length + 1 + w.length <= width) row = `${row} ${w}`;
    else {
      rows.push(row);
      row = w;
    }
  }
  rows.push(row);
  return rows;
}

/**
 * A Bash call as Claude Code draws it: `⏺ Bash(command)`, then the output under `⎿`, wrapped to
 * the terminal and cut to its first `shown` rows with `… +N lines (ctrl+o to expand)`.
 */
function bashCall(command: string, output: string[], cols: number, shown = 3): string[] {
  const rows = output.flatMap((l) => wrap(l, cols - 6));
  const cut = rows.length > shown + 1;
  const visible = cut ? rows.slice(0, shown) : rows;
  return [
    c.green("⏺") + " " + c.bold("Bash") + c.gray(`(${command})`),
    ...visible.map((r, i) => c.gray((i === 0 ? "  ⎿  " : "     ") + r)),
    ...(cut ? [c.gray(`     … +${rows.length - shown} lines (ctrl+o to expand)`)] : []),
  ];
}

/** Claude's own text: `⏺ ` on the first row, two spaces on the rest. */
function say(text: string, cols: number): string[] {
  return wrap(text, cols - 3).map((r, i) => (i === 0 ? c.green("⏺") + " " : "  ") + r);
}

/** A summary bullet: `  - ` then the text, continuation rows under the text. */
function bullet(text: string, cols: number): string[] {
  return wrap(text, cols - 5).map((r, i) => (i === 0 ? "  - " : "    ") + r);
}

/**
 * The session, in the order it happened: one chunk per step, so the shot can dispatch each
 * command's app event right after its output appears. Sized to the terminal (`cols` x `rows`):
 * the user's request must stay on screen, so the banner, then the input box, then Claude's
 * opening line are left out when they would push it off the top.
 */
export function agentApiSession(
  cols: number,
  rows: number,
): { prompt: string; list: string; burst: string; open: string; summary: string } {
  const width = Math.min(cols - 1, 120);
  const box = 50;
  const banner = [
    c.orange("╭" + "─".repeat(box) + "╮"),
    c.orange("│ ") + c.bold("✻ Claude Code".padEnd(box - 1)) + c.orange("│"),
    c.orange("│ ") + c.gray("  cwd: ~/projects/todo-api".padEnd(box - 1)) + c.orange("│"),
    c.orange("╰" + "─".repeat(box) + "╯"),
    "",
  ];
  const ask = [
    ...wrap(
      'Check the new rate limit on GET /api/todos: run my saved "List open todos" request, ' +
        "then open the 429 case in a tab.",
      width - 3,
    ).map((r, i) => (i === 0 ? c.gray("> ") : "  ") + r),
    "",
  ];
  const plan = [
    ...say(
      'I\'ll run your saved request, then your "Burst (expect 429)" one, through Agent ' +
        "Studio's API client.",
      width,
    ),
    "",
  ];
  const list = [...bashCall('agent-studio api run "List open todos"', LIST_OUTPUT, width), ""];
  const burst = [...bashCall('agent-studio api run "Burst (expect 429)"', BURST_OUTPUT, width), ""];
  const open = [...bashCall(`agent-studio http open '${BURST_URL}'`, OPEN_OUTPUT, width), ""];
  const answer = [
    ...say("The limiter works on GET /api/todos:", width),
    ...bullet("List open todos: 200 OK, x-ratelimit-limit: 100, x-ratelimit-remaining: 97", width),
    ...bullet(
      'Burst (expect 429): 429 Too Many Requests, retry-after: 1, body {"error":"rate_limited","retryAfter":1}',
      width,
    ),
    ...wrap(
      "Both runs are in the History rail, and the 429 case is open in a new tab, ready for you to Send.",
      width - 3,
    ).map((r) => "  " + r),
  ];
  const input = [
    "",
    c.gray("╭" + "─".repeat(width - 2) + "╮"),
    c.gray("│") + " > " + " ".repeat(width - 5) + c.gray("│"),
    c.gray("╰" + "─".repeat(width - 2) + "╯"),
  ];
  const fixed = ask.length + list.length + burst.length + open.length + answer.length;
  let room = rows - fixed;
  const take = (lines: string[]) => {
    if (lines.length > room) return [];
    room -= lines.length;
    return lines;
  };
  const withPlan = take(plan);
  const withInput = take(input);
  const withBanner = take(banner);
  // The cursor is hidden, as Claude Code's own UI hides it; the last row ends without a newline
  // so nothing scrolls.
  return {
    prompt: "\x1b[?25l" + nl([...withBanner, ...ask, ...withPlan]),
    list: nl(list),
    burst: nl(burst),
    open: nl(open),
    summary: [...answer, ...withInput].join("\r\n"),
  };
}

/* ───────────── Settings → Claude Code ───────────── */

/** `claude_mcp_status` when Claude Code already has Agent Studio's MCP server (`McpReport`). */
export const MCP_INSTALLED: ClaudeMcpReport = {
  ok: true,
  state: "installed",
  message: "Agent Studio is added to Claude Code (User config): it runs `/opt/agent-studio/agent-studio mcp`.",
  configured: "/opt/agent-studio/agent-studio mcp",
  scope: "User config",
  exe: "/opt/agent-studio/agent-studio",
};
