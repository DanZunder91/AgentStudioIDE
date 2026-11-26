/**
 * Fictional data for the "agents drive Agent Studio" database shot (09-agent-db-tools).
 *
 * A Claude Code agent in an Agent Studio terminal answers "which API keys hit the rate limit
 * most today?" with the `agent-studio db …` command. Two halves, kept consistent:
 * - what the agent reads in its terminal: each reply copied from the Rust formats
 *   (`agent_ctl/commands/db.rs` `DbConnectReport::message`, `db_browse.rs` `schema`,
 *   `db_run.rs` `QueryReport::message` and `table`);
 * - what Rust emits to the webview for the same calls (`dbConnection`, `dbQueryRun`), which the
 *   shot feeds to the app's own agent-ctl dispatcher.
 *
 * Same made-up `todo_api` Postgres as the other shots (panelFixtures.ts `DB_CONN`). No real
 * hosts, people or secrets; the URL has no password.
 */
import type { DbConnection, DbNode, DbResultSet } from "../../src/features/db/types";
import { c } from "./fixtures";
import { DB_CONN } from "./panelFixtures";

/** The URL the agent passes to `db connect` (read from the project's .env.example). */
export const AGENT_DB_URL = "postgres://dev@localhost:5432/todo_api";

/**
 * The connection `db connect` saves: the todo-api database as the URL describes it. Read-only
 * (every agent-added connection is), no Vault reference (the URL carried no password), and the
 * credential-free URL kept, as Rust's `input_from_parsed` does.
 */
export const AGENT_DB_CONN: DbConnection = {
  ...DB_CONN,
  passwordRef: "",
  savePassword: "forever",
  url: AGENT_DB_URL,
  readOnly: true,
};

/** `target::describe` for that connection. */
const DESCRIBE = `"${AGENT_DB_CONN.name}" (PostgreSQL at localhost:5432/todo_api, read-only)`;

/** The agent's query, exactly as it passes it (and as the console then holds it). */
export const AGENT_SQL = `SELECT k.name AS api_key, count(*) AS hits_429,
       max(e.created_at) AS last_hit
FROM rate_limit_events e
JOIN api_keys k ON k.id = e.api_key_id
WHERE e.created_at >= current_date
GROUP BY k.name ORDER BY hits_429 DESC LIMIT 5;`;

const ROWS: Array<Array<string | null>> = [
  ["nightly-export", "1284", "2026-10-05 02:09:57+00"],
  ["ios-app", "412", "2026-10-05 09:28:41+00"],
  ["web-dashboard", "97", "2026-10-05 09:14:03+00"],
  ["partner-sandbox", "31", "2026-10-05 08:52:19+00"],
  ["cli-dev", "6", "2026-10-05 07:40:12+00"],
];

/** The result set Rust sends with `dbQueryRun` (the console's wire shape; `--limit` default 100). */
export const AGENT_RESULT: DbResultSet = {
  kind: "rows",
  statement: AGENT_SQL,
  columns: [
    { name: "api_key", typeName: "text", kind: "text" },
    { name: "hits_429", typeName: "int8", kind: "number" },
    { name: "last_hit", typeName: "timestamptz", kind: "datetime" },
  ],
  rows: ROWS,
  rowsAffected: null,
  truncated: false,
  rowLimit: 100,
  durationMs: 6,
  notice: null,
};

/**
 * The columns of `rate_limit_events`, as Rust's Postgres tree lists them (`DbNode::column`: the
 * server's `format_type` spelling, `· not null` when it is). The DB panel's tree and the agent's
 * `db schema` reply are both read from this one level.
 */
const eventsRef = { kind: "table", database: "todo_api", schema: "public", name: "rate_limit_events" } as DbNode["nodeRef"];
export const RATE_LIMIT_EVENTS_COLUMNS: DbNode[] = [
  ["id", "bigint · not null"],
  ["api_key_id", "integer · not null"],
  ["route", "text · not null"],
  ["created_at", "timestamp with time zone · not null"],
].map(([label, subLabel]): DbNode => ({ nodeRef: eventsRef, label, subLabel, kind: "column", expandable: false }));

/** Rust's `db_run::table`: `|`-separated, each column as wide as its widest cell, a `-+-` rule. */
function table(set: DbResultSet): string[] {
  const header = set.columns.map((col) => col.name);
  const body = set.rows.map((r) => r.map((cell) => cell ?? "NULL"));
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join(" | ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("-+-"), ...body.map(line)];
}

/* ───────────── what the agent reads (the CLI prints each reply as-is) ───────────── */

const CONNECT_REPLY = [
  "Connected to PostgreSQL at localhost:5432/todo_api (PostgreSQL 17.2) in 4 ms.",
  `Saved in Agent Studio as "${AGENT_DB_CONN.name}" (read-only) and opened in the DB panel.`,
  "The user can make it writable in the DB panel (Edit connection).",
].join("\n");

/** `db_browse::schema` for a table: the place, one `kind  name  — detail` line per item, a count. */
const SCHEMA_REPLY = [
  `${DESCRIBE} › todo_api/public/Tables/rate_limit_events:`,
  ...RATE_LIMIT_EVENTS_COLUMNS.map((n) => `  column  ${n.label}  — ${n.subLabel}`),
  `${RATE_LIMIT_EVENTS_COLUMNS.length} items.`,
].join("\n");

const QUERY_REPLY = [
  `Ran on ${DESCRIBE} in 21 ms.`,
  "",
  ...table(AGENT_RESULT),
  `(${ROWS.length} rows)`,
].join("\n");

/* ───────────── the transcript, drawn like AGENT_SESSION (fixtures.ts) ───────────── */

const ASK =
  "Connect to the local todo-api database and show me which API keys hit the rate limit most today.";

const SUMMARY =
  "nightly-export hit the limit most today: 1,284 rejected requests, all before 02:10, " +
  "when the export job bursts past 100 req/min. ios-app (412) and web-dashboard (97) are " +
  "still being limited this morning. The query and its results are in the todo-api (local) " +
  "console tab.";
/** Inline-code spans in SUMMARY (Claude Code renders them in color). */
const CODE = ["nightly-export", "ios-app", "web-dashboard"];

/** Word-wrap one line at spaces the way Ink (Claude Code's renderer) does; an over-long word is cut. */
function wrap(src: string, width: number): string[] {
  if (src.length <= width) return [src];
  const out: string[] = [];
  let line: string | null = null;
  for (let w of src.split(" ")) {
    const next: string = line === null ? w : `${line} ${w}`;
    if (next.length <= width) {
      line = next;
      continue;
    }
    if (line !== null) out.push(line.trimEnd());
    while (w.length > width) {
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    line = w;
  }
  if (line !== null && line !== "") out.push(line);
  return out;
}

/**
 * One transcript item: `marker` on its first line (its visible width is the indent every other
 * line takes), each of the text's own lines wrapped to the terminal, `paint` coloring a line.
 */
function item(
  marker: string,
  indent: number,
  text: string,
  cols: number,
  paint: (line: string, first: boolean) => string = (l) => l,
): string[] {
  const lines = text.split("\n").flatMap((l) => wrap(l, cols - indent));
  return lines.map((l, i) => (i === 0 ? marker : " ".repeat(indent)) + paint(l, i === 0));
}

/** `⏺ Bash(<command>)`, then the reply under `⎿` (the first `show` lines, then a fold). */
function bash(command: string, reply: string, cols: number, show = Infinity): string[] {
  const head = item(c.green("⏺") + " ", 2, `Bash(${command})`, cols, (l, first) =>
    first ? c.bold("Bash") + c.gray(l.slice(4)) : c.gray(l),
  );
  const all = reply.split("\n");
  const kept = all.slice(0, show).join("\n");
  const body = item(c.gray("  ⎿  "), 5, kept, cols);
  const hidden = all.length - Math.min(show, all.length);
  if (hidden > 0) body.push(c.gray(`     … +${hidden} line${hidden === 1 ? "" : "s"} (ctrl+o to expand)`));
  return [...head, ...body, ""];
}

/** The agent's session for a terminal `cols` wide and `rows` high (the banner only if it fits). */
export function agentDbSession(cols: number, rows: number): string {
  const conn = `'${AGENT_DB_CONN.name}'`;
  const turn = [
    ...item(c.gray("> "), 2, ASK, cols),
    "",
    ...bash(`agent-studio db connect '${AGENT_DB_URL}' --name ${conn}`, CONNECT_REPLY, cols),
    ...bash(
      `agent-studio db schema ${conn} --path todo_api/public/rate_limit_events`,
      SCHEMA_REPLY,
      cols,
      3,
    ),
    ...bash(`agent-studio db query ${conn} "${AGENT_SQL}"`, QUERY_REPLY, cols),
    ...item(c.green("⏺") + " ", 2, SUMMARY, cols, (l) =>
      CODE.reduce((s, w) => s.replace(new RegExp(`(?<![\\w-])${w}(?![\\w-])`), c.cyan(w)), l),
    ),
  ];
  const banner = [
    c.orange("╭" + "─".repeat(50) + "╮"),
    c.orange("│ ") + c.bold("✻ Claude Code".padEnd(49)) + c.orange("│"),
    c.orange("│ ") + c.gray("  cwd: ~/projects/todo-api".padEnd(49)) + c.orange("│"),
    c.orange("╰" + "─".repeat(50) + "╯"),
    "",
  ];
  const lines = turn.length + banner.length <= rows ? [...banner, ...turn] : turn;
  // Claude Code draws its own UI and hides the terminal's cursor. No newline after the last
  // line, so a transcript as tall as the terminal does not scroll its first line away.
  return "\x1b[?25l" + lines.join("\r\n");
}
