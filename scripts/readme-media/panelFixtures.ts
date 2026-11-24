/**
 * Fictional data for the panel screenshots (API, DB, Agent Logs, Network, Metrics).
 * Shapes mirror the wire types in src/features/*; values are invented for README media.
 */
import type { DbConnection, DbNode, DbResultSet } from "../../src/features/db/types";
import type { LogLine } from "../../src/features/agentlogs/agentLogsTypes";
import type { DevApp, ProcsList } from "../../src/features/procs/procsTypes";
import type { FlowDetail, FlowSummary, NetcapStatus } from "../../src/features/network/networkTypes";
import type { MetricsReport, TurnRow } from "../../src/features/metrics/metricsTypes";
import type { HttpResponse } from "../../src/features/api/httpIpc";
import type { ApiStore } from "../../src/features/api/apiStoreIpc";

const NOW = Date.now();
const TODO = "/home/dev/projects/todo-api";

/* ───────────── API client ───────────── */

const todosBody = {
  data: [
    { id: 128, title: "Add rate limiting to /api", status: "open", priority: "high", assignee: "agent:rate-limit", createdAt: "2026-10-04T09:12:44Z", tags: ["backend", "security"] },
    { id: 131, title: "Document the REST API (OpenAPI 3.1)", status: "open", priority: "medium", assignee: "agent:docs", createdAt: "2026-10-04T10:03:19Z", tags: ["docs"] },
    { id: 133, title: "Fix flaky payment retries", status: "open", priority: "high", assignee: null, createdAt: "2026-10-05T07:41:02Z", tags: ["payments", "flaky"] },
  ],
  page: { limit: 3, next: "/api/todos?status=open&limit=3&cursor=eyJpZCI6MTMzfQ" },
  meta: { total: 17, tookMs: 4 },
};
const todosJson = JSON.stringify(todosBody, null, 2);

export const HTTP_RESPONSE: HttpResponse = {
  status: 200,
  statusText: "OK",
  headers: [
    { name: "content-type", value: "application/json; charset=utf-8" },
    { name: "x-ratelimit-limit", value: "100" },
    { name: "x-ratelimit-remaining", value: "97" },
    { name: "etag", value: 'W/"2f1-8nQm0v5x"' },
    { name: "date", value: "Mon, 05 Oct 2026 09:30:12 GMT" },
  ],
  body: todosJson,
  durationMs: 23,
  sizeBytes: todosJson.length,
  truncated: false,
} as HttpResponse;

const saved = (id: string, name: string, method: string, url: string, folderId?: string) => ({
  id, name, method, url, headers: [], body: "", protocol: "http" as const, ...(folderId ? { folderId } : {}),
});

export const API_STORE: ApiStore = {
  collections: [
    saved("r1", "List open todos", "GET", "http://localhost:3000/api/todos?status=open", "f1"),
    saved("r2", "Create todo", "POST", "http://localhost:3000/api/todos", "f1"),
    saved("r3", "Complete todo", "PATCH", "http://localhost:3000/api/todos/128", "f1"),
    saved("r4", "Delete todo", "DELETE", "http://localhost:3000/api/todos/128", "f1"),
    saved("r5", "Health", "GET", "http://localhost:3000/health", "f2"),
    saved("r6", "Burst (expect 429)", "GET", "http://localhost:3000/api/todos?burst=1", "f2"),
    saved("r7", "Charge card", "POST", "http://localhost:8080/v1/charges", "f3"),
    saved("r8", "Refund", "POST", "http://localhost:8080/v1/refunds", "f3"),
  ],
  environments: [
    { id: "e1", name: "local", variables: [{ key: "API_KEY", value: "dev-key-not-a-secret" }] },
    { id: "e2", name: "staging", variables: [{ key: "API_KEY", value: "" }] },
  ],
  activeEnvironmentId: "e1",
  folders: [
    { id: "f1", name: "todo-api", order: 0 },
    { id: "f2", name: "rate limiting", order: 1 },
    { id: "f3", name: "payments-service", order: 2 },
  ],
} as ApiStore;

/* ───────────── DB client ───────────── */

export const DB_CONN: DbConnection = {
  id: "c-todo",
  name: "todo-api (local)",
  engine: "postgres",
  family: "postgres",
  host: "localhost",
  port: 5432,
  database: "todo_api",
  user: "dev",
  passwordRef: "{{PG_PASSWORD}}",
  savePassword: "session",
  url: null,
  srv: false,
  sslMode: "disable",
  caSummary: null,
  options: {},
  readOnly: true,
  rowLimit: 500,
  timeoutMs: 30_000,
  allowMultiStatement: false,
  createdAt: 1,
  updatedAt: 2,
};

export const DB_SQL = `SELECT t.id, t.title, t.status, t.priority, u.name AS owner,
       t.created_at, t.due_at
FROM todos t
LEFT JOIN users u ON u.id = t.owner_id
WHERE t.status <> 'archived'
ORDER BY t.priority DESC, t.created_at DESC
LIMIT 12;`;

const rows: Array<Array<string | null>> = [
  ["133", "Fix flaky payment retries", "open", "high", "Avery", "2026-10-05 07:41:02+00", "2026-10-07"],
  ["128", "Add rate limiting to /api", "in_progress", "high", "Agent: rate-limit", "2026-10-04 09:12:44+00", "2026-10-06"],
  ["125", "Rotate staging API keys", "open", "high", "Jordan", "2026-10-03 16:20:11+00", null],
  ["131", "Document the REST API", "in_progress", "medium", "Agent: docs", "2026-10-04 10:03:19+00", "2026-10-09"],
  ["129", "Paginate GET /api/todos", "done", "medium", "Sam", "2026-10-04 08:55:37+00", null],
  ["124", "Add ETag support", "open", "medium", "Riley", "2026-10-03 11:02:48+00", "2026-10-12"],
  ["121", "Upgrade to Express 5", "open", "medium", null, "2026-10-02 14:40:05+00", null],
  ["119", "Seed script for demo data", "done", "low", "Avery", "2026-10-01 09:18:26+00", null],
  ["117", "Dark-mode screenshots for docs", "open", "low", "Jordan", "2026-09-30 17:33:51+00", null],
  ["114", "Remove legacy /v0 routes", "open", "low", "Sam", "2026-09-29 12:07:14+00", "2026-10-31"],
  ["112", "Typo in README", "done", "low", "Riley", "2026-09-28 08:44:09+00", null],
  ["109", "Investigate slow /users query", "open", "low", null, "2026-09-27 15:21:30+00", null],
];

export const DB_RESULT: DbResultSet = {
  kind: "rows",
  statement: DB_SQL,
  columns: [
    { name: "id", typeName: "int4", kind: "number" },
    { name: "title", typeName: "text", kind: "text" },
    { name: "status", typeName: "todo_status", kind: "text" },
    { name: "priority", typeName: "text", kind: "text" },
    { name: "owner", typeName: "text", kind: "text" },
    { name: "created_at", typeName: "timestamptz", kind: "datetime" },
    { name: "due_at", typeName: "date", kind: "datetime" },
  ],
  rows,
  rowsAffected: null,
  truncated: false,
  rowLimit: 500,
  durationMs: 3,
  notice: null,
};

export const DB_SAVED = [
  { id: "q1", connectionId: "c-todo", name: "Overdue todos", sql: "SELECT * FROM todos WHERE due_at < now();", createdAtMs: NOW, updatedAtMs: NOW },
  { id: "q2", connectionId: "c-todo", name: "429s per key (24h)", sql: "SELECT api_key, count(*) FROM rate_limit_events GROUP BY 1;", createdAtMs: NOW, updatedAtMs: NOW },
];

const DB = "todo_api";
const tableRef = (name: string) => ({ kind: "table", database: DB, schema: "public", name });
const tbl = (name: string, sub: string): DbNode => ({ nodeRef: tableRef(name) as DbNode["nodeRef"], label: name, subLabel: sub, kind: "table", expandable: true });
const col = (table: string, name: string, sub: string): DbNode => ({ nodeRef: tableRef(table) as DbNode["nodeRef"], label: name, subLabel: sub, kind: "column", expandable: false });

export function dbChildren(node: { kind: string; name?: string }): DbNode[] {
  switch (node.kind) {
    case "root":
      return [{ nodeRef: { kind: "database", name: DB }, label: DB, subLabel: null, kind: "database", expandable: true }];
    case "database":
      return [{ nodeRef: { kind: "schema", database: DB, name: "public" }, label: "public", subLabel: null, kind: "schema", expandable: true }];
    case "schema":
      return [
        { nodeRef: { kind: "group", database: DB, schema: "public", group: "tables" }, label: "tables", subLabel: "4", kind: "group", expandable: true },
        { nodeRef: { kind: "group", database: DB, schema: "public", group: "views" }, label: "views", subLabel: "1", kind: "group", expandable: true },
      ];
    case "group":
      return [tbl("api_keys", "~40 rows"), tbl("rate_limit_events", "~18k rows"), tbl("todos", "~1.2k rows"), tbl("users", "~60 rows")];
    case "table":
      if (node.name !== "todos") return [];
      return [
        col("todos", "id", "int4 · pk"),
        col("todos", "title", "text · not null"),
        col("todos", "status", "todo_status"),
        col("todos", "priority", "text"),
        col("todos", "owner_id", "int4 → users.id"),
        col("todos", "created_at", "timestamptz"),
        col("todos", "due_at", "date"),
      ];
    default:
      return [];
  }
}

export const DB_EXPAND = [
  { kind: "root" },
  { kind: "database", name: DB },
  { kind: "schema", database: DB, name: "public" },
  { kind: "group", database: DB, schema: "public", group: "tables" },
  tableRef("todos"),
];

/* ───────────── Agent Logs ───────────── */

let lid = 0;
const L = (secAgo: number, source: string, kind: LogLine["kind"], text: string, p: Partial<LogLine> = {}): LogLine => ({
  id: ++lid,
  tsMs: NOW - secAgo * 1000,
  terminalId: null,
  agentId: null,
  source,
  kind,
  level: "info",
  text,
  detail: null,
  toolUseId: null,
  ...p,
});
const AG = "claude · todo-api";
const agentP = { agentId: "agent-rate", terminalId: "agent-rate" };
const call = (s: number, tu: string, text: string): LogLine => L(s, AG, "tool", text, { ...agentP, toolUseId: tu });
const res = (s: number, tu: string, text: string, p: Partial<LogLine> = {}): LogLine =>
  L(s, AG, "tool-result", text, { ...agentP, toolUseId: tu, ...p });
const WEB = "todo-api · server.log";

export const LOG_LINES: LogLine[] = [
  L(160, WEB, "app", "todo-api listening on :3000"),
  L(158, WEB, "app", "connected to postgres://localhost:5432/todo_api (pool=10)"),
  call(150, "tu1", "Bash  git status --short"),
  res(149, "tu1", " M src/server.ts\n?? src/middleware/rateLimit.ts"),
  call(140, "tu2", "Read  src/routes/todos.ts"),
  res(139, "tu2", "84 lines"),
  call(120, "tu3", "Write  src/middleware/rateLimit.ts"),
  res(119, "tu3", "Wrote 52 lines"),
  L(110, WEB, "app", "GET /api/todos?status=open 200 4ms key=dev-***"),
  L(109, WEB, "app", "GET /api/todos/128 200 2ms key=dev-***"),
  call(100, "tu4", "Bash  npm test -- rateLimit"),
  res(96, "tu4", "✓ tests/rateLimit.test.ts (6 tests) 41ms\nTest Files 1 passed (1)"),
  L(90, WEB, "app", "GET /api/todos?burst=1 429 1ms retry-after=1s key=dev-***", { level: "warn" }),
  L(89, WEB, "app", "GET /api/todos?burst=1 429 0ms retry-after=1s key=dev-***", { level: "warn" }),
  L(80, "payments-service · cargo run", "app", "INFO payments_service: listening on 0.0.0.0:8080"),
  L(70, "payments-service · cargo run", "app", "WARN retry: attempt 3/5 for charge ch_01J9 failed: upstream timeout", { level: "warn" }),
  L(69, "payments-service · cargo run", "app", "ERROR retry: giving up on ch_01J9 after 5 attempts (backoff 3.2s)", { level: "error" }),
  call(60, "tu5", "Bash  curl -s -i localhost:3000/api/todos -H 'x-api-key: dev-key'"),
  res(59, "tu5", "HTTP/1.1 200 OK\nX-RateLimit-Limit: 100\nX-RateLimit-Remaining: 99"),
  L(40, WEB, "app", "POST /api/todos 201 6ms key=dev-***"),
  call(30, "tu6", "Edit  src/server.ts"),
  res(29, "tu6", "Updated 1 line"),
  L(20, WEB, "app", "PATCH /api/todos/128 200 3ms key=dev-***"),
  L(12, "zsh · todo-api", "output", "dev@laptop:~/projects/todo-api$ npm run lint"),
  L(10, "zsh · todo-api", "output", "✔ no problems found"),
  L(5, WEB, "app", "GET /health 200 0ms"),
];

const app = (key: string, name: string, runtime: DevApp["runtime"], pid: number, ports: number[], logFile: string | null, argv: string[], cwd: string): DevApp => ({
  key, pid, runtime, name, exe: null, argv, cwd, startedMs: NOW - 600_000, ports,
  console: logFile ? "file" : "terminal",
  logFiles: logFile ? [{ path: logFile, kind: "log" }] : [],
  containerId: null, origin: "ide", terminalId: null, agentId: null, launchedBy: "Add rate limiting", captured: true,
});

export const PROCS: ProcsList = {
  available: true,
  reason: null,
  apps: [
    app("node-4211", "todo-api", "node", 4211, [3000], `${TODO}/server.log`, ["node", "dist/server.js"], TODO),
    app("rust-4380", "payments-service", "rust", 4380, [8080], null, ["target/debug/payments-service"], "/home/dev/projects/payments-service"),
    { ...app("docker-pg", "postgres", "docker", 3990, [5432], null, ["postgres"], TODO), containerId: "3f2a9c1b7d4e" },
  ],
};

export const SYSLOG_STATUS = {
  available: true,
  backend: "macos-unified-log",
  reason: null,
  running: false,
  filter: { enabled: false, apps: null, subsystem: null, minLevel: "default", simulator: false, simulatorApps: null },
  simulator: { available: false, reason: null, running: false },
  linesPerSec: 0,
  droppedPerSec: 0,
};

/* ───────────── Network ───────────── */

let fid = 0;
const F = (secAgo: number, method: string, proto: FlowSummary["proto"], host: string, port: number, path: string, status: number | null, ms: number | null, resBytes: number, p: Partial<FlowSummary> = {}): FlowSummary => ({
  id: ++fid,
  startedMs: NOW - secAgo * 1000,
  proto,
  method,
  host,
  port,
  path,
  status,
  grpcStatus: null,
  contentType: "application/json",
  reqBytes: method === "GET" ? 0 : 214,
  resBytes,
  durationMs: ms,
  state: status === null ? "pending" : "done",
  error: null,
  terminalId: "agent-rate",
  httpVersion: "HTTP/1.1",
  wsMessages: null,
  client: { pid: 5120, name: "curl", path: null },
  note: null,
  ...p,
});

export const FLOWS: FlowSummary[] = [
  F(170, "GET", "https", "registry.npmjs.org", 443, "/express-rate-limit", 200, 182, 48_211, { client: { pid: 5001, name: "npm", path: null }, httpVersion: "HTTP/2" }),
  F(150, "GET", "http", "localhost", 3000, "/health", 200, 2, 15),
  F(140, "GET", "http", "localhost", 3000, "/api/todos?status=open&limit=3", 200, 4, 761),
  F(130, "POST", "http", "localhost", 3000, "/api/todos", 201, 6, 182),
  F(120, "GET", "http", "localhost", 3000, "/api/todos?burst=1", 429, 1, 41),
  F(119, "GET", "http", "localhost", 3000, "/api/todos?burst=1", 429, 1, 41),
  F(110, "POST", "https", "api.stripe-sandbox.example", 443, "/v1/charges", 502, 3012, 96, { client: { pid: 4380, name: "payments-service", path: null }, httpVersion: "HTTP/2", terminalId: null }),
  F(100, "POST", "https", "api.stripe-sandbox.example", 443, "/v1/charges", 200, 341, 1_204, { client: { pid: 4380, name: "payments-service", path: null }, httpVersion: "HTTP/2", terminalId: null }),
  F(90, "GET", "https", "api.github.com", 443, "/repos/example/todo-api/pulls?state=open", 200, 228, 5_390, { client: { pid: 5233, name: "gh", path: null }, httpVersion: "HTTP/2" }),
  F(70, "PATCH", "http", "localhost", 3000, "/api/todos/128", 200, 3, 204),
  F(60, "GET", "https", "pypi.org", 443, "/simple/locust/", 200, 97, 12_877, { contentType: "text/html", client: { pid: 5310, name: "python3", path: null }, httpVersion: "HTTP/2" }),
  F(40, "GET", "wss", "localhost", 5173, "/__vite_hmr", 101, null, 0, { state: "pending", wsMessages: { up: 3, down: 41 }, contentType: null, client: { pid: 4100, name: "node", path: null } }),
  F(20, "DELETE", "http", "localhost", 3000, "/api/todos/112", 204, 3, 0, { contentType: null }),
  F(5, "GET", "http", "localhost", 3000, "/api/todos?status=open&limit=3", 200, 3, 761),
];

export const DETAIL_FLOW_ID = 3;

export function flowDetail(id: number): FlowDetail {
  const summary = FLOWS.find((f) => f.id === id) ?? FLOWS[0];
  return {
    summary,
    requestHeaders: [
      ["host", "localhost:3000"],
      ["user-agent", "curl/8.7.1"],
      ["accept", "application/json"],
      ["x-api-key", "dev-***"],
    ],
    responseHeaders: HTTP_RESPONSE.headers.map((h) => [h.name, h.value] as [string, string]),
    responseTrailers: [],
    requestBody: null,
    responseBody: { size: todosJson.length, truncated: false, text: todosJson, base64: null },
  };
}

export const NETCAP_STATUS: NetcapStatus = {
  running: true,
  port: 51234,
  enabled: true,
  decrypt: true,
  caPath: null,
  skippedReason: null,
  passthroughHosts: [],
  flowCount: FLOWS.length,
  decryptApps: [],
  portChanged: null,
  strictAgentCapture: false,
};

/* ───────────── Metrics ───────────── */

const HOUR = 3_600_000;
const FROM = NOW - 24 * HOUR;

const turn = (p: Partial<TurnRow>): TurnRow => ({
  turnId: "t1",
  sessionId: "00000000-0000-4000-8000-000000000001",
  rootId: "local",
  projectLabel: "todo-api",
  label: null,
  startedAtMs: NOW - 2 * HOUR,
  endedAtMs: NOW - 2 * HOUR + 221_000,
  durationMs: 221_000,
  durationSource: "cli",
  requests: 44,
  tokens: { freshInput: 253, output: 78_500, cacheWrite: 12_000, cacheRead: 9_500_000 },
  toolCalls: 47,
  toolErrors: 2,
  filesChanged: 4,
  interrupted: false,
  humanPrompt: true,
  models: ["claude-opus"],
  ...p,
});

const tokens = { freshInput: 18_204, output: 612_980, cacheWrite: 4_102_331, cacheRead: 187_445_120 };

export function metricsReport(): MetricsReport {
  const counts = [2, 0, 0, 0, 0, 0, 0, 4, 18, 41, 66, 52, 23, 30, 74, 95, 88, 61, 37, 12, 8, 26, 47, 31];
  return {
    window: { kind: "last_24h", fromMs: FROM, toMs: NOW },
    scope: { kind: "all", cwd: null },
    totals: {
      sessions: 9,
      turns: 37,
      humanTurns: 21,
      requests: counts.reduce((a, b) => a + b, 0),
      tokens,
      avgContextPerRequest: 118_000,
      highContextRequestShare: 0.31,
      toolCalls: 512,
      toolErrors: 14,
      filesChanged: 46,
      timeInTurnsMs: 5 * HOUR + 38 * 60_000,
      turnsWithDuration: 33,
    },
    perRoot: [{ rootId: "local", label: "This machine", available: true, sessions: 9, turns: 37, requests: 720, tokens }],
    hourly: counts.map((requests, i) => ({ startMs: FROM + i * HOUR, requests, output: requests * 850 })),
    topTurns: [
      turn({ turnId: "t1", projectLabel: "todo-api", requests: 61, toolCalls: 58, filesChanged: 6 }),
      turn({ turnId: "t2", projectLabel: "payments-service", requests: 44, startedAtMs: NOW - 5 * HOUR, endedAtMs: NOW - 5 * HOUR + 410_000, durationMs: 410_000, toolErrors: 5 }),
      turn({ turnId: "t3", projectLabel: "todo-api", requests: 29, startedAtMs: NOW - 9 * HOUR, endedAtMs: NOW - 9 * HOUR + 132_000, durationMs: 132_000, filesChanged: 2 }),
      turn({ turnId: "t4", projectLabel: "payments-service", requests: 18, startedAtMs: NOW - 14 * HOUR, endedAtMs: NOW - 14 * HOUR + 95_000, durationMs: 95_000, toolErrors: 0 }),
    ],
    coverage: {
      rootsScanned: 1,
      rootsUnavailable: [],
      filesConsidered: 212,
      filesRead: 14,
      bytesRead: 11_204_331,
      scanMs: 96,
      filesTruncated: 0,
      linesUnparseable: 0,
      turnsWithoutCliDuration: 4,
      turnsWithoutPromptId: 0,
      scopeFellBackToAll: false,
      partial: false,
    },
    scannedAtMs: NOW,
  };
}
