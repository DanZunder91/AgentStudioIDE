/**
 * dbIpc — the ONE `invoke` seam for the database client.
 *
 * Feature-local (not `app/ipc.ts`) so the wire wrappers live next to their feature — the
 * same choice `usageIpc.ts` and `fleetIpc.ts` make.
 *
 * ── The rule these wrappers follow: they do not swallow ──────────────────────
 * Unlike the best-effort persistence wrappers (`saveApiStore`, `pinAgent`), **every
 * rejection here is passed through untouched**, exactly as `claudeUsage` does. A failed
 * connect is information the user needs, and the caller turns the raw string into a code
 * via `parseDbError` — which only works if the string arrives unmodified. Rust rejects
 * with the stable `"<code>"` / `"<code>: <detail>"` wire string (see
 * `DbErrorCode` in `types.ts`), never with an `Error`.
 *
 * ── Every command Rust registers is wrapped here ─────────────────────────────
 * **Fifteen commands exist; fifteen are wrapped.** This note used to name what was missing —
 * first `db_children` and the saved-query trio, then `db_cancel` — and each time it went
 * stale behind the Rust side: the backend was finished and the frontend never heard. Keeping
 * the count here is what makes that visible on the next read.
 *
 * ── The secret rule, restated where it is enforced ───────────────────────────
 * The password is **never** part of an input record. It travels as the separate
 * `password` argument to `db_connection_upsert` / `db_test_connection` (the only two
 * exceptions to "secrets are resolved in Rust", because the user just typed it into a draft
 * that is saved nowhere yet) and is resolved from the Vault inside Rust everywhere else.
 * `db_open` takes a *connection id* and returns a *session id*: no resolved secret ever
 * crosses this boundary.
 */

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

/**
 * What the three draft-taking commands accept: the contract's `DbConnectionDraft` plus
 * the one field Rust adds — an optional `id` that selects create-vs-update.
 *
 * Declared HERE rather than in `types.ts` on purpose. `types.ts` is the shared wire
 * *contract*, and `id` is not part of a draft: it is an argument to a command, mirroring
 * Rust's `DbConnectionInput` (`= DbConnectionDraft` + `Option<String>` id). Keeping it
 * local is the same call `apiStoreIpc.ts` makes for its own wire types.
 *
 * `id` is `string | null` and always **present**, never omitted: serde reads the NAME, so
 * a missing field fails as silence rather than as an error.
 */
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

/**
 * A **saved** connection as a command input.
 *
 * Written field-by-field rather than spread: `DbConnection` also carries `createdAt` /
 * `updatedAt`, which Rust owns and ignores, and a spread would put the store's whole
 * record on the wire and invite the next field to travel by accident.
 *
 * There is no `caPath`: private-CA pinning is unimplemented on both sides, and the field
 * that briefly existed here only made the gap invisible (see `types.ts`).
 */
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

/**
 * The typed password as the wire wants it: `null` when there is none.
 *
 * The normalisation is here, once, rather than at each call site, because Rust already
 * treats the two identically — `upsert` runs `typed_password.filter(|s| !s.is_empty())`
 * — so `""` and `null` mean the same thing to the only reader. Two shapes on the wire
 * for one meaning is how a caller ends up branching on the difference.
 */
function passwordArg(password: string | null): string | null {
  return password === null || password === "" ? null : password;
}

/* ────────────────────────────── the registry ──────────────────────────────── */

/**
 * `db_engines` — every engine descriptor, in the order the driver picker shows them.
 *
 * Served over IPC rather than duplicated in TypeScript: the whole form spec (labels,
 * kinds, defaults, requiredness, hints) has to agree with the Rust validator, and a
 * second copy of it would drift from the one that decides.
 */
export function dbEngines(): Promise<EngineSpec[]> {
  return invoke<EngineSpec[]>("db_engines", {});
}

/* ────────────────────────────── persistence ───────────────────────────────── */

/**
 * `db_connections_load` — the persisted connections.
 *
 * Does **not** reject on a missing or corrupt file: Rust loads that as an empty store, so
 * a rejection here means the IPC itself failed. Deliberately not wrapped in a `catch` that
 * returns an empty store (`loadApiStore`'s shape): an empty list rendered after a failure
 * says "you have no connections", which is a different and false statement.
 */
export function dbConnectionsLoad(): Promise<DbConnectionStore> {
  return invoke<DbConnectionStore>("db_connections_load", {});
}

/**
 * `db_connection_upsert` — validate, split credentials out of any raw URL, write the Vault
 * variable, and persist atomically. Returns the saved record, with `id`/`createdAt`/
 * `updatedAt` as Rust minted them.
 *
 * `password` is the plaintext the user just typed (one of the two
 * exceptions to "secrets are resolved in Rust"). It is written to the
 * **Vault** and nowhere else, and only when `savePassword` is `"forever"`.
 */
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

/**
 * `db_url_build` — form → canonical connection string.
 *
 * Has no `password` parameter at all: its output is meant for a clipboard, so it carries a
 * `{{VAR}}` reference or nothing, and Rust refuses a literal password outright.
 */
export function dbUrlBuild(input: DbConnectionInput): Promise<string> {
  return invoke<string>("db_url_build", { input });
}

/**
 * `db_url_parse` — connection string → form.
 *
 * The password **value is never returned**: `hadPassword` says one was there and
 * `passwordParam` says which parameter carried it, so the dialog can put the reference
 * back where the user typed it. On a malformed string this rejects and the caller leaves
 * the form untouched — a half-filled form is worse than a refusal.
 */
export function dbUrlParse(text: string): Promise<ParsedUrl> {
  return invoke<ParsedUrl>("db_url_parse", { text });
}

/* ───────────────────────────── connecting ─────────────────────────────────── */

/**
 * `db_test_connection` — test an unsaved draft (or a saved connection, by handing it its
 * own record; a `{{VAR}}` is then resolved against the Vault).
 *
 * **Resolves on failure.** An unreachable server is a result, not an exception — the
 * `http_send` contract — so `ok: false` with a mapped, redacted `error` is the normal
 * shape. A rejection from here means the IPC call itself failed.
 */
export function dbTestConnection(
  input: DbConnectionInput,
  password: string | null,
): Promise<DbTestResult> {
  return invoke<DbTestResult>("db_test_connection", {
    input,
    password: passwordArg(password),
  });
}

/**
 * `db_open` — open a session on a SAVED connection and get the session **and what answered**.
 *
 * 🔴 It returns the server version and the latency, so opening costs **one** dial
 * instead of two — see {@link DbOpened}. The store used to spend a whole extra dial on
 * `db_test_connection` just to learn that string.
 *
 * The webview names a connection; the password is read from the Vault inside Rust and
 * never crosses this boundary. `password` is only for `savePassword: "never"` /
 * `"session"`, where by construction there is nothing stored to read.
 */
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

/**
 * `db_query` — run SQL on an open session.
 *
 * A **database** error resolves as a `message` result next to whatever succeeded (a syntax
 * error is a normal outcome of a console, not an exception). Only a stale session id, a
 * blocked script, or a transport failure rejects.
 *
 * `mode` and `rowLimit` are sent explicitly rather than omitted — Rust's `Option`s have
 * safe defaults (`statement`, the connection's limit), and a caller that means "the
 * default" should say so on the wire rather than by absence.
 */
export function dbQuery(
  sessionId: DbSessionId,
  sql: string,
  mode: DbRunMode | null,
  rowLimit: number | null,
): Promise<DbResultSet[]> {
  return invoke<DbResultSet[]>("db_query", { sessionId, sql, mode, rowLimit });
}

/**
 * `db_cancel` — ask the server to stop the statement this session is running.
 *
 * 🔴 **What resolving means, exactly: the request was DELIVERED, not that the query stopped.**
 * Every engine's cancel is advisory — PostgreSQL's `pg_cancel_backend` sends SIGINT and the backend
 * stops at its next interruptible point. So the caller must not report more than happened, and the
 * console's wording stays "the server may still be running it".
 *
 * **Rejects for MongoDB, Redis and DynamoDB**, which have no server-side cancel. That refusal is
 * structural (Rust answers without a round trip) and is surfaced rather than swallowed: a Stop
 * button that quietly did nothing would be worse than one that says it cannot.
 */
export function dbCancel(sessionId: DbSessionId): Promise<void> {
  return invoke<void>("db_cancel", { sessionId });
}

/* ─────────────────── the object tree and the saved queries ─────────────────── */

/**
 * ⚠️ The tree's and the saved queries' wire shapes are declared **here**, not in `types.ts`,
 * and that is a deliberate correction rather than a shortcut.
 *
 * `types.ts` is the shared wire contract, and it was once **wrong about both** — it predated
 * the Rust implementation and nothing ever forced the two to meet:
 *
 * | `types.ts` said | `src-tauri/src/db/tree.rs` / `queries.rs` actually send |
 * |---|---|
 * | `DbNode.ref` | `nodeRef` |
 * | no `savedQuery` ref variant | `{ kind: "savedQuery", id }` — the leaf a saved query IS |
 * | `SavedQuery.text` | `sql` |
 * | `SavedQuery.createdAt` / `updatedAt` | `createdAtMs` / `updatedAtMs` |
 *
 * ✅ **`types.ts` has since been corrected**, so the names below are now
 * **aliases of the contract**, not second definitions. That distinction is the whole point —
 * two *names* for one type is harmless indirection, whereas two *definitions* drift, and
 * drifting silently is exactly what the table above records. (Two independently written
 * sentence tables for one error union once disagreed on two codes by the time they were
 * merged.)
 *
 * The aliases stay rather than being renamed at 27 call sites: that churn buys nothing now that
 * there is one definition. A later pass can collapse the names.
 */
export type DbGroupId = "tables" | "views" | "collections" | "keys";

/**
 * Which node in the tree — `serde(tag = "kind")` over Rust's `DbNodeRef`.
 *
 * The frontend holds one of these verbatim and hands it straight back to `db_children`, which
 * is the whole reason `tree.rs` asserts the ref round-trips: any asymmetry would break the
 * SECOND level of the tree and break it as an unreadable deserialisation error.
 */
export type DbNodeRefWire = DbNodeRef;

/** What a node *is* — drives its icon. Distinct from the ref: a `table` ref may be a view. */
export type DbNodeKindWire = DbNode["kind"];

/**
 * One row in the tree.
 *
 * 🔴 `nodeRef` is **not a unique node identity**, and the tree must not treat it as one:
 * `DbNode::column` deliberately borrows its *table's* ref (`tree.rs` lines 155–162), so every
 * column of `tracks` arrives carrying the same `{ kind: "table", …, name: "tracks" }`. Keying
 * React rows or an expansion map by the ref alone would collapse a 40-column table into one
 * row. `dbTreeFormat.ts` keys the cache by ref (only ever for `expandable` nodes, which are
 * unique among their siblings) and React rows by parent+index.
 */
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

/**
 * `db_children` — ONE level of the tree.
 *
 * `node` is a ref this function was previously handed, sent back untouched. The connection is
 * identified by the **session**, never by a connection id the caller supplies: that is what
 * stops a webview asking for another connection's objects (or saved queries) by guessing an
 * id — see the comment on `db_children` in `src-tauri/src/db/mod.rs`.
 *
 * Rejects when the session is stale or the catalogue query fails, and the rejection is
 * passed through untouched so the caller can map it. The caller must
 * render that as a calm inline note on the node, never a panel-level error: a dropped VPN
 * must not take the rail down.
 */
export function dbChildren(
  sessionId: DbSessionId,
  node: DbNodeRefWire,
): Promise<DbTreeNode[]> {
  return invoke<DbTreeNode[]>("db_children", { sessionId, node });
}

/**
 * `db_saved_queries` — every saved query for a connection, newest-updated first.
 *
 * Takes a **connection id, not a session id**, and that is what makes the saved-query
 * list survive a restart: seeing the list after closing the app, reopening it and
 * double-clicking the connection must not depend on a database being reachable. Rust reads
 * `db-queries.json` and answers with no session at all.
 */
export function dbSavedQueries(connectionId: string): Promise<SavedQueryRecord[]> {
  return invoke<SavedQueryRecord[]>("db_saved_queries", { connectionId });
}

/**
 * `db_saved_query_upsert` — create (`id: null`) or update. Returns the stored record.
 *
 * Rejects on a blank name, empty SQL, or a stale id — all three deliberately, per
 * `queries.rs`: a create under a stale id would produce duplicates nobody can explain, and
 * "Untitled" four times over is indistinguishable from a bug. The rejection is passed through
 * so the caller can show the refusal instead of reporting a save that did not happen.
 */
export function dbSavedQueryUpsert(
  input: SavedQueryInputWire,
): Promise<SavedQueryRecord> {
  return invoke<SavedQueryRecord>("db_saved_query_upsert", { input });
}

/**
 * `db_saved_query_delete` — remove one. Resolves `false` when nothing was removed.
 *
 * `false` is not an error: it means our list was stale (someone deleted it in another
 * window). Reported rather than hidden, for the same reason `db_connection_delete`'s
 * `removed: false` is — a stale list would otherwise look identical to a successful delete.
 */
export function dbSavedQueryDelete(id: string): Promise<boolean> {
  return invoke<boolean>("db_saved_query_delete", { id });
}

/**
 * `db_tree_order` — every level of this connection's tree the user has hand-arranged.
 *
 * Takes a connection id and **no session**, like `dbSavedQueries` and for the same reason: the
 * arrangement belongs to the user, not to the server, so it is readable while the database is
 * unreachable. Never rejects — a missing or corrupt file reads as "no custom order", which
 * renders as the engines' own alphabetical order.
 */
export function dbTreeOrder(connectionId: string): Promise<DbLevelOrder[]> {
  return invoke<DbLevelOrder[]>("db_tree_order", { connectionId });
}

/**
 * `db_tree_order_set` — record one level's order.
 *
 * An EMPTY `keys` clears the level (back to alphabetical), so the UI's "reset" gesture and its
 * "drag" gesture are the same command. Two commands would be two chances to disagree about what
 * "no custom order" means on disk.
 */
export function dbTreeOrderSet(
  connectionId: string,
  parentKey: string,
  keys: string[],
): Promise<void> {
  return invoke<void>("db_tree_order_set", { connectionId, parentKey, keys });
}
