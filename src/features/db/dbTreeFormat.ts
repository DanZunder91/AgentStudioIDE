/** The connection tree's decisions as pure functions. The browse query is the frontend's own (no
 * `browseTemplate` on `EngineSpec` yet): it always carries the connection's `rowLimit`, quotes and
 * qualifies identifiers, and is `null` where no defensible query exists (Redis). */

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

/** JSON of a tag-first tuple: a joined string is ambiguous once a name contains `/`. Only for
 * expandable nodes; columns share their table's ref, so React keys use `rowKey`. */
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

/** Not `nodeKey` (columns share their table's ref). The label changes the key when a level
 * reloads into a different shape, so a stale row's DOM is not reused. */
export function rowKey(parentKey: string, index: number, node: DbTreeNode): string {
  return `${parentKey}#${index}#${node.label}`;
}

/* ─────────────────────────── the cached tree state ─────────────────────────── */

/** In the store, not component state: the DB rail tab unmounts on a tab switch, which would drop
 * every expanded level and re-query production. `Record`, not `Set`, since immer's `enableMapSet`
 * is off. */
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

/** Saved-query refs are answered locally; `db_children` needs a live session for them, and the
 * saved-query list must work without one. */
export function isServerAnswered(ref: DbNodeRefWire): boolean {
  return ref.kind !== "savedQueries" && ref.kind !== "savedQuery";
}

/** No `refForKey` by design: `<DbTree/>` threads the ref down as it recurses, because a reverse
 * lookup's "not cached" branch was unreachable (a failure renders inside its cached parent). */

/** One function so two notes never render at once; a level reloading after a failure shows the
 * spinner, not the stale failure, or Retry looks like it did nothing. */
export function levelStatus(
  tree: DbTreeState,
  key: string,
): "loading" | "failed" | "loaded" | "idle" {
  if (tree.loading[key] === true) return "loading";
  if (tree.failed[key] !== undefined) return "failed";
  return key in tree.children ? "loaded" : "idle";
}

/* ───────────────────────────── the saved queries ───────────────────────────── */

/** Like Rust's `tree::count_label`, except zero: "none yet", since "empty" reads as failure. */
export function savedQueryCountLabel(n: number): string {
  if (n === 0) return "none yet";
  return n === 1 ? "1 query" : `${n} queries`;
}

/** Mirrors Rust's `first_line_preview` (`db/mod.rs`) exactly (60 chars, 57 + `…`): the same node
 * is also built in Rust by `db_children`. */
export function savedQueryPreview(sql: string): string {
  const line = (sql.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (line.length === 0) return "";
  const chars = [...line];
  return chars.length <= 60 ? line : `${chars.slice(0, 57).join("")}…`;
}

/** Keeps Rust's order (newest-updated first) rather than re-sorting; all-whitespace SQL gets
 * `subLabel: null`, as in Rust. */
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

/** Doubles the quote char so a server-side name like `he"llo` cannot splice SQL. MySQL uses
 * backticks (`ANSI_QUOTES` is off by default); PostgreSQL and ClickHouse use double quotes. */
export function quoteIdent(family: DbFamily, name: string): string {
  if (family === "mysql") return `\`${name.replaceAll("`", "``")}\``;
  return `"${name.replaceAll('"', '""')}"`;
}

/** `db.table` where `schema` is null (MySQL, ClickHouse); `schema.table` on PostgreSQL, whose
 * connection is already bound to one database. */
export function qualifiedTableName(
  family: DbFamily,
  ref: { database: string; schema: string | null; name: string },
): string {
  const qualifier = ref.schema ?? ref.database;
  return `${quoteIdent(family, qualifier)}.${quoteIdent(family, ref.name)}`;
}

/** What a double-click on a table/view/collection runs, or `null`; invented, see the header. */
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
      // PartiQL: the name must be double-quoted, and there is no LIMIT clause (paging caps
      // rows), so emitting one would be rejected.
      return `SELECT * FROM "${ref.name}";`;
    case "mongodb":
      // The `queryLanguage: "json"` command Mongo runs. No driver ships in this build, so this has
      // never met a server.
      return JSON.stringify({ find: ref.name, limit: rowLimit }, null, 2);
    case "redis":
      // No query. A key is not a relation, `engine_for` refuses Redis outright, and a
      // plausible-looking `SCAN` this build has never executed is worse than nothing.
      return null;
  }
}
