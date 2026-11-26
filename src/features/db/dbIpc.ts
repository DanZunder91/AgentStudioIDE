/** The one `invoke` seam for the database client. Rejections pass through untouched (Rust sends
 * `"<code>"` / `"<code>: <detail>"`, mapped by `parseDbError`). The password travels only as
 * the separate arg to upsert/test; `db_open` takes an id, so no resolved secret crosses IPC. */

import { invoke } from "@tauri-apps/api/core";

import type {
  DbConnection,
  DbConnectionDraft,
  DbConnectionStore,
  DbNode,
  DbNodeRef,
  DbResultSet,
  DbRunMode,
  DbOpened,
  DbSessionId,
  DbTestResult,
  DeleteReport,
  EngineSpec,
  ParsedUrl,
  DbLevelOrder,
  SavedQuery,
} from "./types";

/* ────────────────────────────── the input shape ───────────────────────────── */

/** A draft plus the `id` arg of Rust's `DbConnectionInput` (kept out of the `types.ts` contract).
 * `id` is always present, `null` to create: a missing field fails silently, not as an error. */
export interface DbConnectionInput extends DbConnectionDraft {
  /** `null` → create a new record. A ULID → update that record in place. */
  id: string | null;
}

/** A draft plus the id it is (or is not) editing. The dialog's Save/Test/Build path. */
export function connectionInput(
  draft: DbConnectionDraft,
  id: string | null,
): DbConnectionInput {
  return { ...draft, id };
}

/** Field by field, not a spread, so Rust-owned fields (`createdAt`/`updatedAt`) and future ones
 * never ride along. No `caPath`: private-CA pinning is unimplemented on both sides. */
export function connectionAsInput(c: DbConnection): DbConnectionInput {
  return {
    id: c.id,
    name: c.name,
    engine: c.engine,
    family: c.family,
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    passwordRef: c.passwordRef,
    savePassword: c.savePassword,
    url: c.url,
    srv: c.srv,
    // No paste hint: this record's own `url` already carries the placement (that is why
    // `DbConnection` has no such field), and Rust prefers the string over the hint anyway.
    passwordParam: null,
    sslMode: c.sslMode,
    caSummary: c.caSummary,
    options: { ...c.options },
    readOnly: c.readOnly,
    rowLimit: c.rowLimit,
    timeoutMs: c.timeoutMs,
    allowMultiStatement: c.allowMultiStatement,
  };
}

/** Rust treats `""` like `null` (it filters out empty strings), so the wire gets one shape. */
function passwordArg(password: string | null): string | null {
  return password === null || password === "" ? null : password;
}

/* ────────────────────────────── the registry ──────────────────────────────── */

/** Served from Rust, not duplicated, so the form spec cannot drift from the validator. */
export function dbEngines(): Promise<EngineSpec[]> {
  return invoke<EngineSpec[]>("db_engines", {});
}

/* ────────────────────────────── persistence ───────────────────────────────── */

/** A missing or corrupt file loads as empty in Rust, so a rejection is an IPC failure; no catch,
 * since an empty list after a failure would falsely say "no connections". */
export function dbConnectionsLoad(): Promise<DbConnectionStore> {
  return invoke<DbConnectionStore>("db_connections_load", {});
}

/** Validates, splits credentials out of a raw URL, writes the Vault variable and persists. The
 * typed `password` goes to the Vault only, and only when `savePassword` is `"forever"`. */
export function dbConnectionUpsert(
  input: DbConnectionInput,
  password: string | null,
): Promise<DbConnection> {
  return invoke<DbConnection>("db_connection_upsert", {
    input,
    password: passwordArg(password),
  });
}

/** `db_connection_delete` — remove a connection, close its live sessions, report MEASURED counts. */
export function dbConnectionDelete(id: string): Promise<DeleteReport> {
  return invoke<DeleteReport>("db_connection_delete", { id });
}

/* ─────────────────────────── connection strings ───────────────────────────── */

/** No `password` param: the output is for a clipboard, so Rust refuses a literal password. */
export function dbUrlBuild(input: DbConnectionInput): Promise<string> {
  return invoke<string>("db_url_build", { input });
}

/** Never returns the password value: `hadPassword` and `passwordParam` let the dialog put the
 * reference back. Rejects on a malformed string; the caller leaves the form untouched. */
export function dbUrlParse(text: string): Promise<ParsedUrl> {
  return invoke<ParsedUrl>("db_url_parse", { text });
}

/* ───────────────────────────── connecting ─────────────────────────────────── */

/** Resolves on failure (`ok: false` with a redacted `error`); a rejection means IPC failed. A
 * saved connection's `{{VAR}}` is resolved against the Vault. */
export function dbTestConnection(
  input: DbConnectionInput,
  password: string | null,
): Promise<DbTestResult> {
  return invoke<DbTestResult>("db_test_connection", {
    input,
    password: passwordArg(password),
  });
}

/** Returns the server version and latency too, so opening costs one dial. The password is read
 * from the Vault in Rust; `password` is only for `savePassword: "never"`/`"session"`. */
export function dbOpen(connectionId: string, password: string | null): Promise<DbOpened> {
  return invoke<DbOpened>("db_open", {
    connectionId,
    password: passwordArg(password),
  });
}

/** `db_close` — drop a session's connection. Idempotent: closing an id twice is not an error. */
export function dbClose(sessionId: DbSessionId): Promise<void> {
  return invoke<void>("db_close", { sessionId });
}

/** A database error resolves as a `message` result; only a stale session, blocked script or
 * transport failure rejects. `mode` and `rowLimit` are always sent explicitly. */
export function dbQuery(
  sessionId: DbSessionId,
  sql: string,
  mode: DbRunMode | null,
  rowLimit: number | null,
): Promise<DbResultSet[]> {
  return invoke<DbResultSet[]>("db_query", { sessionId, sql, mode, rowLimit });
}

/** Resolving means the request was DELIVERED, not that the query stopped (cancel is advisory).
 * Rejects for MongoDB, Redis and DynamoDB, which have no server-side cancel. */
export function dbCancel(sessionId: DbSessionId): Promise<void> {
  return invoke<void>("db_cancel", { sessionId });
}

/* ─────────────────── the object tree and the saved queries ─────────────────── */

/** The tree and saved-query names below alias the `types.ts` contract; they are not second
 * definitions, so they cannot drift. */
export type DbGroupId = "tables" | "views" | "collections" | "keys";

/** Held verbatim and sent back to `db_children`; it must round-trip or the second level breaks. */
export type DbNodeRefWire = DbNodeRef;

/** What a node *is* — drives its icon. Distinct from the ref: a `table` ref may be a view. */
export type DbNodeKindWire = DbNode["kind"];

/** `nodeRef` is NOT a unique identity: every column borrows its table's ref, so key rows by
 * parent+index (see `dbTreeFormat.ts`). */
export type DbTreeNode = DbNode;

/** A saved query, exactly as `queries.rs` serialises one. */
export type SavedQueryRecord = SavedQuery;

/** What `db_saved_query_upsert` accepts. `id: null` creates; a ULID updates in place. */
export interface SavedQueryInputWire {
  id: string | null;
  connectionId: string;
  name: string;
  sql: string;
}

/** One level. Addressed by session, never a caller-supplied connection id, so the webview cannot
 * guess another connection's objects. Rejections pass through; show them inline on the node. */
export function dbChildren(
  sessionId: DbSessionId,
  node: DbNodeRefWire,
): Promise<DbTreeNode[]> {
  return invoke<DbTreeNode[]>("db_children", { sessionId, node });
}

/** By connection id, not session, so the list shows while the database is unreachable. */
export function dbSavedQueries(connectionId: string): Promise<SavedQueryRecord[]> {
  return invoke<SavedQueryRecord[]>("db_saved_queries", { connectionId });
}

/** Rejects on a blank name, empty SQL or a stale id (deliberately, per `queries.rs`); the caller
 * shows the refusal rather than a save that did not happen. */
export function dbSavedQueryUpsert(
  input: SavedQueryInputWire,
): Promise<SavedQueryRecord> {
  return invoke<SavedQueryRecord>("db_saved_query_upsert", { input });
}

/** `false` (nothing removed) means our list was stale, and is reported rather than hidden. */
export function dbSavedQueryDelete(id: string): Promise<boolean> {
  return invoke<boolean>("db_saved_query_delete", { id });
}

/** By connection id, no session: readable while the database is unreachable. Never rejects; a
 * missing or corrupt file means no custom order. */
export function dbTreeOrder(connectionId: string): Promise<DbLevelOrder[]> {
  return invoke<DbLevelOrder[]>("db_tree_order", { connectionId });
}

/** Empty `keys` clears the level, so reset and drag share one command and one meaning on disk. */
export function dbTreeOrderSet(
  connectionId: string,
  parentKey: string,
  keys: string[],
): Promise<void> {
  return invoke<void>("db_tree_order_set", { connectionId, parentKey, keys });
}
