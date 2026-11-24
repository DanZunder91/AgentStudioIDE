/**
 * dbTreeFormat — every interesting decision the connection tree makes, as pure functions.
 *
 * The tree itself is a recursive React component over data the server owns, so almost nothing
 * about it is worth asserting through a DOM. What IS worth asserting is in here: how a node is
 * addressed in the cache, how a React row is keyed, what the `Saved queries` node says, and —
 * the one with a real cost attached — what SQL a double-click on a table runs.
 *
 * ── 🔴 The browse query is INVENTED, and this is the paragraph that says so ───
 * There is no `browse_template: &'static str` on `EngineSpec`
 * ("SELECT * FROM {qualified} LIMIT {limit}") for a double-click to run. `EngineSpec` in
 * `src-tauri/src/db/engines.rs` has no such field, nothing in `src-tauri/**` mentions one, and
 * `db_engines()`'s golden snapshot therefore does not carry one either. So the text below is
 * the frontend's, not the backend's, and it is written defensively because a wrong browse query on a
 * 50M-row table is a real bill:
 *
 * * **The row limit is always in the statement**, and it is the *connection's* `rowLimit` —
 *   the number that connection promises. `db_query` also caps server-side (it reads cap+1 to
 *   measure truncation), so the clause is not the safety mechanism; it is there so the server
 *   does not materialise 50M rows before our cap discards them.
 * * **The identifier is fully qualified and quoted**, per family. An unquoted `SELECT * FROM
 *   Tracks` silently reads `tracks` on some servers and fails on others, and a table someone
 *   named `select` cannot be referenced at all without quotes.
 * * **An engine we cannot write a defensible query for returns `null`**, and a double-click
 *   then just expands the node. Redis is that engine: a "key" is not a relation and there is
 *   no SELECT to write. Inventing `SCAN 0 MATCH …` would put a command in someone's editor
 *   that this build has never run against a Redis server (`engine_for` refuses Redis outright),
 *   which is the kind of plausible-looking guess the tree never makes for its nodes and which is no
 *   more acceptable in an editor buffer.
 *
 * The proper fix is a `browseTemplate` on the descriptor, so the engine that knows its own
 * dialect owns its own query — recorded here rather than papered over.
 */

import type {
  DbNodeKindWire,
  DbNodeRefWire,
  DbTreeNode,
  SavedQueryRecord,
} from "./dbIpc";
import type { DbFamily } from "./types";

/* ──────────────────────────────── addressing ──────────────────────────────── */

/** The cache/expansion key of the connection's own level — what a first expand asks for. */
export const ROOT_KEY = '["root"]';

/** The cache/expansion key of the synthetic `Saved queries` node. */
export const SAVED_QUERIES_KEY = '["savedQueries"]';

/**
 * A node's key in the children cache / the expanded set.
 *
 * `JSON.stringify` of a **tag-first tuple**, rather than a joined string, for one measured
 * reason: a joined `"schema:maestro/public"` is ambiguous the moment a database is called
 * `maestro/public`, and a database and a schema can legitimately share a name. The tuple's
 * first element is always the tag, so two kinds can never collide either.
 *
 * ⚠️ Only ever called for a node whose `expandable` is true (and for the two synthetic keys
 * above). A **column** node borrows its table's `nodeRef` (`tree.rs` `DbNode::column`), so
 * every column of one table has the same key — see `rowKey`, which is what React uses.
 */
export function nodeKey(ref: DbNodeRefWire): string {
  switch (ref.kind) {
    case "root":
      return JSON.stringify(["root"]);
    case "savedQueries":
      return JSON.stringify(["savedQueries"]);
    case "savedQuery":
      return JSON.stringify(["savedQuery", ref.id]);
    case "database":
      return JSON.stringify(["database", ref.name]);
    case "schema":
      return JSON.stringify(["schema", ref.database, ref.name]);
    case "group":
      return JSON.stringify(["group", ref.database, ref.schema, ref.group]);
    case "table":
      return JSON.stringify(["table", ref.database, ref.schema, ref.name]);
  }
}

/**
 * A React `key` for one rendered row.
 *
 * Parent key + position + label, **not** `nodeKey(node.nodeRef)`, because the ref is not an
 * identity: 40 columns of `tracks` all carry the table's ref, and keying by it would render
 * one row and log a duplicate-key warning for the other 39. Position alone would be enough
 * for React, and the label is included so the key changes when a level is reloaded into a
 * different shape — which is what stops a stale row's DOM being reused for a different object.
 */
export function rowKey(parentKey: string, index: number, node: DbTreeNode): string {
  return `${parentKey}#${index}#${node.label}`;
}

/* ─────────────────────────── the cached tree state ─────────────────────────── */

/**
 * One connection's subtree, as it lives in the store.
 *
 * The obvious choice is "cached in component state, not the store — the buffer of a tree
 * is not app state", and this deliberately does the opposite. The reason is the same one that moved
 * `dbConsoles` into the store: the DB rail tab is unmounted whenever the user switches to
 * Files, so a tree in component state loses every expanded level on a rail-tab click, and
 * would re-issue a `db_children` call per level on the way back. That is a round trip to a
 * production database paid for a UI toggle. A tree buffer is not *interesting* app state,
 * but it cannot live somewhere this app unmounts.
 *
 * `Record<string, true>` rather than `Set` for `loading`/`expanded`: immer's draft handling of
 * a `Set` requires `enableMapSet`, which this store does not enable, and `collapsedRoots` is
 * the one `Set` in the store precisely because it is replaced wholesale rather than mutated.
 */
export interface DbTreeState {
  /** nodeKey → that level's children. **Present (even `[]`) means loaded** — the marker. */
  children: Record<string, DbTreeNode[]>;
  /** nodeKey → a `db_children` call is in flight for it. Drives the inline spinner. */
  loading: Record<string, true>;
  /** nodeKey → ONE mapped sentence. Rendered on the node, never as a panel error. */
  failed: Record<string, string>;
  /** nodeKey → expanded. Absence is collapsed, so a fresh level opens closed. */
  expanded: Record<string, true>;
}

/** A connection's tree before anything has been expanded. */
export function blankDbTree(): DbTreeState {
  return { children: {}, loading: {}, failed: {}, expanded: {} };
}

/** One connection's saved-query list, and the two states a list can be in besides "here". */
export interface DbSavedQueryListState {
  queries: SavedQueryRecord[];
  loading: boolean;
  /** A failed READ of `db-queries.json`, as one mapped sentence. Inline, like the tree's. */
  error: string | null;
}

/** A saved-query list before it has been read. */
export function blankSavedQueryList(): DbSavedQueryListState {
  return { queries: [], loading: false, error: null };
}

/**
 * Does `db_children` answer this ref, or does the store?
 *
 * The two saved-query refs are answered locally — `db_saved_queries` for the list, and a
 * `savedQuery` is a leaf with nothing below it. Rust intercepts both before an engine is asked
 * (`db_children`'s first two arms), so calling `db_children` for them would be a round trip
 * whose answer we already have; worse, `db_children`'s `savedQueries` arm requires a live
 * SESSION, which is the one thing the saved-query list must not need.
 */
export function isServerAnswered(ref: DbNodeRefWire): boolean {
  return ref.kind !== "savedQueries" && ref.kind !== "savedQuery";
}

/**
 * ⚠️ There is deliberately **no `refForKey(key) → DbNodeRef`**, and the absence is the design.
 *
 * The Retry button needs the ref of the level that failed. A reverse lookup — parse the key
 * back, or scan the cache for the node whose `nodeKey` matches — was written first, and every
 * version of it had a `null` case for "the node is no longer cached" that **no click could
 * reach**: a failure note only renders inside its parent node's expanded subtree, so the parent
 * is in the cache by construction. An unreachable branch is an untestable one, which the
 * coverage ratchet exists to catch (and did).
 *
 * So `<DbTree/>` threads the ref down as it recurses — `renderNode` already holds the node it
 * is rendering the children of — and there is nothing to look up, nothing to keep in step with
 * `nodeKey`, and no dead guard.
 */

/**
 * Is this level loaded, loading, failed, or untouched?
 *
 * One function so the component cannot ask the four questions in an order that renders two
 * notes at once (a spinner under an error was the first version's bug). Order matters and is
 * the point: a level that is loading again after a failure shows the spinner, not the stale
 * failure — otherwise Retry looks like it did nothing.
 */
export function levelStatus(
  tree: DbTreeState,
  key: string,
): "loading" | "failed" | "loaded" | "idle" {
  if (tree.loading[key] === true) return "loading";
  if (tree.failed[key] !== undefined) return "failed";
  return key in tree.children ? "loaded" : "idle";
}

/* ───────────────────────────── the saved queries ───────────────────────────── */

/**
 * `"12 queries"` / `"1 query"` / `"none yet"`.
 *
 * Mirrors Rust's `tree::count_label` in its handling of the singular ("1 querys" is the kind
 * of thing that ships) but NOT in its zero case: `count_label` says `"empty"`, which reads
 * fine on a schema and reads like a failure on a list the user has simply never added to.
 */
export function savedQueryCountLabel(n: number): string {
  if (n === 0) return "none yet";
  return n === 1 ? "1 query" : `${n} queries`;
}

/**
 * The dim line under a saved query's name: its first non-blank line, capped.
 *
 * A deliberate mirror of Rust's `first_line_preview` (`db/mod.rs`), because the SAME node can
 * arrive from two places — `db_children({kind:"savedQueries"})` builds it in Rust, and this
 * builds it here from `db_saved_queries`. Two spellings of one sub-label sit on either side of
 * the Rust/TS seam, so the cap (60 chars, 57 + `…`) is copied exactly and the
 * test asserts the boundary rather than "something short".
 */
export function savedQueryPreview(sql: string): string {
  const line = (sql.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (line.length === 0) return "";
  const chars = [...line];
  return chars.length <= 60 ? line : `${chars.slice(0, 57).join("")}…`;
}

/**
 * Saved-query records → tree nodes, in the order Rust handed them over.
 *
 * The order is NOT re-sorted here: `queries::for_connection` already sorts newest-updated
 * first with an id tiebreak, and re-sorting in the UI is how two surfaces end up disagreeing
 * about which query is at the top. A record whose SQL is all whitespace gets `subLabel: null`
 * rather than an empty dim line, matching what Rust does with the same input.
 */
export function savedQueryNodes(queries: SavedQueryRecord[]): DbTreeNode[] {
  return queries.map((q) => {
    const preview = savedQueryPreview(q.sql);
    return {
      nodeRef: { kind: "savedQuery", id: q.id },
      label: q.name,
      subLabel: preview === "" ? null : preview,
      kind: "savedQuery",
      // A leaf: there is nothing below a query, and `db_children` answers a `savedQuery`
      // ref with `[]` for exactly this reason.
      expandable: false,
    };
  });
}

/* ───────────────────────────── the browse query ───────────────────────────── */

/** Which node kinds a double-click can browse. A column, a group and a schema cannot. */
export function isBrowsable(kind: DbNodeKindWire): boolean {
  return kind === "table" || kind === "view" || kind === "collection";
}

/**
 * Quote one identifier for `family`, escaping the quote character by doubling it.
 *
 * The doubling is not decoration: table names come from the server, and a table created as
 * `he"llo` would otherwise close our quote and splice the rest into the statement. This is the
 * one place in the frontend that builds SQL text, so it is the one place that has to care.
 *
 * MySQL uses backticks (its `ANSI_QUOTES` mode is off by default, so `"x"` is a *string*
 * there); PostgreSQL and ClickHouse take double quotes.
 */
export function quoteIdent(family: DbFamily, name: string): string {
  if (family === "mysql") return `\`${name.replaceAll("`", "``")}\``;
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A table ref → the qualified name for `family`.
 *
 * `schema` is `null` on the engines that have no schema level (MySQL, ClickHouse), where the
 * database IS the qualifier — so `db.table` there and `schema.table` on PostgreSQL, whose
 * connection is already bound to one database and cannot cross-reference another anyway
 * (`tree.rs`'s header comment). Qualifying with the *database* on PostgreSQL would produce
 * `maestro.public.tracks`, which only parses as a three-part name if the database matches the
 * current one — true here, and still needless.
 */
export function qualifiedTableName(
  family: DbFamily,
  ref: { database: string; schema: string | null; name: string },
): string {
  const qualifier = ref.schema ?? ref.database;
  return `${quoteIdent(family, qualifier)}.${quoteIdent(family, ref.name)}`;
}

/**
 * The statement a double-click on a table/view/collection puts in the console, or `null` when
 * this engine has none we can defend. **Invented — see this file's header.**
 */
export function browseQuery(
  family: DbFamily,
  ref: { database: string; schema: string | null; name: string },
  rowLimit: number,
): string | null {
  switch (family) {
    case "postgres":
    case "mysql":
    case "clickhouse":
      // One line, ending in a semicolon so ⌘⏎ (statement-under-cursor) and ⇧⌘⏎ (script) do
      // the same thing on it — a browse query that behaves differently under the two Run
      // modes would be a confusing first thing to see in the editor.
      return `SELECT * FROM ${qualifiedTableName(family, ref)} LIMIT ${rowLimit};`;
    case "dynamodb":
      // PartiQL, and the table name is double-quoted because that is what DynamoDB requires — a
      // bare identifier is a syntax error there. `LIMIT` is deliberately absent: PartiQL has no
      // LIMIT clause (the row cap is applied by the request's `Limit`/paging), so
      // emitting one would put a statement in the editor that the service rejects.
      return `SELECT * FROM "${ref.name}";`;
    case "mongodb":
      // The `queryLanguage: "json"` command document, which is what Run means on
      // Mongo. `find` + `limit` is the shape `db.runCommand` takes; no driver ships in this
      // build, so this has never been run against a server and is a best guess at a
      // *document*, not at a dialect.
      return JSON.stringify({ find: ref.name, limit: rowLimit }, null, 2);
    case "redis":
      // No query. A key is not a relation, `engine_for` refuses Redis outright, and a
      // plausible-looking `SCAN` this build has never executed is worse than nothing.
      return null;
  }
}
