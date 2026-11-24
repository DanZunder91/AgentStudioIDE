/**
 * `dbTreeFormat` — the tree's decisions, tested without a DOM.
 *
 * Every expectation here is written LITERALLY: not one of them is computed from
 * the function under test, or from the same table the function reads. That matters most for
 * `browseQuery`, where the value IS the risk — a wrong `LIMIT` or an unquoted identifier is a
 * bill on someone's production server, and a test that asserted
 * `browseQuery(...) === \`SELECT * FROM ${qualifiedTableName(...)} LIMIT ${limit}\`` would pass
 * for any of them.
 */

import { describe, expect, it } from "vitest";

import type { DbNodeRefWire, DbTreeNode, SavedQueryRecord } from "./dbIpc";
import {
  blankDbTree,
  blankSavedQueryList,
  browseQuery,
  isBrowsable,
  isServerAnswered,
  levelStatus,
  nodeKey,
  qualifiedTableName,
  quoteIdent,
  ROOT_KEY,
  rowKey,
  SAVED_QUERIES_KEY,
  savedQueryCountLabel,
  savedQueryNodes,
  savedQueryPreview,
} from "./dbTreeFormat";

/** A node, with the fields a test does not care about filled in. */
const node = (over: Partial<DbTreeNode> & Pick<DbTreeNode, "nodeRef">): DbTreeNode => ({
  label: "x",
  subLabel: null,
  kind: "table",
  expandable: true,
  ...over,
});

const query = (over: Partial<SavedQueryRecord> = {}): SavedQueryRecord => ({
  id: "Q1",
  connectionId: "c1",
  name: "Recent tracks",
  sql: "SELECT * FROM tracks",
  createdAtMs: 1,
  updatedAtMs: 2,
  ...over,
});

/* ──────────────────────────────── addressing ──────────────────────────────── */

describe("nodeKey — how a level is addressed in the cache", () => {
  it("is the literal string the two exported constants promise", () => {
    // The constants are what the store and the component both key the root and the saved
    // queries by. If `nodeKey` and the constants disagreed, the root level would load into a
    // slot nothing renders — a level that fetches and vanishes.
    expect(ROOT_KEY).toBe('["root"]');
    expect(SAVED_QUERIES_KEY).toBe('["savedQueries"]');
    expect(nodeKey({ kind: "root" })).toBe('["root"]');
    expect(nodeKey({ kind: "savedQueries" })).toBe('["savedQueries"]');
  });

  it("writes every ref variant out, tag first", () => {
    expect(nodeKey({ kind: "database", name: "maestro" })).toBe('["database","maestro"]');
    expect(nodeKey({ kind: "schema", database: "maestro", name: "public" })).toBe(
      '["schema","maestro","public"]',
    );
    expect(
      nodeKey({ kind: "group", database: "maestro", schema: "public", group: "tables" }),
    ).toBe('["group","maestro","public","tables"]');
    // MySQL/ClickHouse have no schema level, so `schema: null` is a real shape, not an absence.
    expect(nodeKey({ kind: "group", database: "shop", schema: null, group: "views" })).toBe(
      '["group","shop",null,"views"]',
    );
    expect(
      nodeKey({ kind: "table", database: "maestro", schema: "public", name: "tracks" }),
    ).toBe('["table","maestro","public","tracks"]');
    expect(nodeKey({ kind: "savedQuery", id: "Q1" })).toBe('["savedQuery","Q1"]');
  });

  it("🔴 cannot collide across KINDS that share a name", () => {
    // A database and a schema legitimately share a name (`maestro.maestro` is ordinary), and
    // a joined `"maestro"` key would have made expanding one open the other.
    expect(nodeKey({ kind: "database", name: "maestro" })).not.toBe(
      nodeKey({ kind: "schema", database: "maestro", name: "maestro" }),
    );
  });

  it("🔴 cannot collide when a name CONTAINS the separator a joined key would use", () => {
    // The reason this is JSON and not `"schema:" + db + "/" + name`. Both of these are legal
    // PostgreSQL identifiers (quoted), and under a joined encoding they are the same string.
    const a = nodeKey({ kind: "schema", database: "a/b", name: "c" });
    const b = nodeKey({ kind: "schema", database: "a", name: "b/c" });
    expect(a).toBe('["schema","a/b","c"]');
    expect(b).toBe('["schema","a","b/c"]');
    expect(a).not.toBe(b);
  });
});

describe("rowKey — the React key", () => {
  it("🔴 distinguishes two COLUMNS of the same table, which share a nodeRef", () => {
    // `DbNode::column` borrows its table's ref, so `nodeKey` is identical for every column of
    // `tracks`. Keying rows by it would render one column and warn about the rest.
    const ref: DbNodeRefWire = {
      kind: "table",
      database: "maestro",
      schema: "public",
      name: "tracks",
    };
    const parent = nodeKey(ref);
    const id = node({ nodeRef: ref, label: "id", kind: "column", expandable: false });
    const tag = node({ nodeRef: ref, label: "tag", kind: "column", expandable: false });

    expect(nodeKey(id.nodeRef)).toBe(nodeKey(tag.nodeRef)); // the trap, stated
    expect(rowKey(parent, 0, id)).toBe('["table","maestro","public","tracks"]#0#id');
    expect(rowKey(parent, 1, tag)).toBe('["table","maestro","public","tracks"]#1#tag');
    expect(rowKey(parent, 0, id)).not.toBe(rowKey(parent, 1, tag));
  });

  it("changes when a reloaded level puts a different object at the same position", () => {
    expect(rowKey(ROOT_KEY, 0, node({ nodeRef: { kind: "root" }, label: "old" }))).not.toBe(
      rowKey(ROOT_KEY, 0, node({ nodeRef: { kind: "root" }, label: "new" })),
    );
  });
});

/* ─────────────────────────────── the state model ─────────────────────────────── */

describe("the blank states", () => {
  it("start empty and are FRESH objects, never a shared one", () => {
    expect(blankDbTree()).toEqual({ children: {}, loading: {}, failed: {}, expanded: {} });
    expect(blankSavedQueryList()).toEqual({ queries: [], loading: false, error: null });
    // A shared literal would make one connection's expand open another's node — the same
    // class of bug as a module-level cache that never re-arms between tests.
    expect(blankDbTree()).not.toBe(blankDbTree());
    expect(blankSavedQueryList()).not.toBe(blankSavedQueryList());
  });
});

describe("levelStatus — one answer, so two notes can never render at once", () => {
  it("reads loaded from the PRESENCE of the children entry, empty array included", () => {
    // `[]` is "expand it and find nothing"; absence is "not read yet". Collapsing the two is
    // how a tree re-fetches an empty schema on every expand.
    expect(levelStatus({ ...blankDbTree(), children: { k: [] } }, "k")).toBe("loaded");
    expect(levelStatus(blankDbTree(), "k")).toBe("idle");
  });

  it("🔴 prefers loading over a stale failure, so Retry does not look like it did nothing", () => {
    const tree = { ...blankDbTree(), loading: { k: true as const }, failed: { k: "nope" } };
    expect(levelStatus(tree, "k")).toBe("loading");
  });

  it("reports a failure once the retry has settled", () => {
    expect(levelStatus({ ...blankDbTree(), failed: { k: "nope" } }, "k")).toBe("failed");
  });

  it("prefers loading over stale CHILDREN too, on a forced reload", () => {
    const tree = { ...blankDbTree(), loading: { k: true as const }, children: { k: [] } };
    expect(levelStatus(tree, "k")).toBe("loading");
  });
});

describe("isServerAnswered — which refs `db_children` is for", () => {
  it("excludes exactly the two saved-query refs", () => {
    expect(isServerAnswered({ kind: "root" })).toBe(true);
    expect(isServerAnswered({ kind: "database", name: "maestro" })).toBe(true);
    expect(
      isServerAnswered({ kind: "table", database: "m", schema: null, name: "tracks" }),
    ).toBe(true);
    // `db_children`'s `savedQueries` arm needs a live SESSION, which the saved-query
    // list must not need — so the frontend reads it with `db_saved_queries` instead.
    expect(isServerAnswered({ kind: "savedQueries" })).toBe(false);
    expect(isServerAnswered({ kind: "savedQuery", id: "Q1" })).toBe(false);
  });
});

/* ─────────────────────────────── saved queries ─────────────────────────────── */

describe("savedQueryCountLabel", () => {
  it("says none yet / 1 query / n queries, and never `1 querys`", () => {
    expect(savedQueryCountLabel(0)).toBe("none yet");
    expect(savedQueryCountLabel(1)).toBe("1 query");
    expect(savedQueryCountLabel(2)).toBe("2 queries");
    expect(savedQueryCountLabel(12)).toBe("12 queries");
  });

  it("does NOT copy Rust's `empty`, which reads like a failure on a user's own list", () => {
    // Deliberate divergence from `tree::count_label`, recorded so the next reader does not
    // "fix" it into agreement.
    expect(savedQueryCountLabel(0)).not.toBe("empty");
  });
});

describe("savedQueryPreview — the dim line, and Rust's exact cap", () => {
  it("takes the first NON-BLANK line, trimmed", () => {
    expect(savedQueryPreview("\n\n   SELECT 1  \nFROM t")).toBe("SELECT 1");
  });

  it("is empty for whitespace-only SQL", () => {
    expect(savedQueryPreview("   \n \n")).toBe("");
  });

  it("🔴 matches `first_line_preview`'s boundary exactly: 60 keeps, 61 becomes 57 + …", () => {
    const sixty = "a".repeat(60);
    expect(savedQueryPreview(sixty)).toBe(sixty);
    expect(savedQueryPreview(sixty).length).toBe(60);

    const sixtyOne = "b".repeat(61);
    expect(savedQueryPreview(sixtyOne)).toBe(`${"b".repeat(57)}…`);
    // 57 chars + one ellipsis. Written out because "shorter than the input" would pass for a
    // cap of 10, and the point is that the two implementations agree.
    expect([...savedQueryPreview(sixtyOne)]).toHaveLength(58);
  });

  it("counts CHARACTERS, not UTF-16 units, so an emoji name is not cut mid-pair", () => {
    // 61 astral code points: 61 chars, 122 UTF-16 units. A `.slice(0, 57)` on the string would
    // cut inside a surrogate pair and produce a replacement character.
    const emoji = "🙂".repeat(61);
    const out = savedQueryPreview(emoji);
    expect(out).toBe(`${"🙂".repeat(57)}…`);
    expect(out).not.toContain("�");
  });
});

describe("savedQueryNodes", () => {
  it("maps a record to the node the tree renders, preserving Rust's ORDER", () => {
    const nodes = savedQueryNodes([
      query({ id: "Q2", name: "newest", sql: "SELECT 2" }),
      query({ id: "Q1", name: "older", sql: "SELECT 1" }),
    ]);
    expect(nodes).toEqual([
      {
        nodeRef: { kind: "savedQuery", id: "Q2" },
        label: "newest",
        subLabel: "SELECT 2",
        kind: "savedQuery",
        expandable: false,
      },
      {
        nodeRef: { kind: "savedQuery", id: "Q1" },
        label: "older",
        subLabel: "SELECT 1",
        kind: "savedQuery",
        expandable: false,
      },
    ]);
  });

  it("gives blank SQL no sub-label at all, rather than an empty dim line", () => {
    expect(savedQueryNodes([query({ sql: "  \n " })])[0].subLabel).toBeNull();
  });

  it("is an empty list for an empty list", () => {
    expect(savedQueryNodes([])).toEqual([]);
  });
});

/* ────────────────────── the browse query (INVENTED — see the module header) ────────────────────── */

describe("quoteIdent", () => {
  it("uses backticks on MySQL and double quotes elsewhere", () => {
    // MySQL's ANSI_QUOTES is off by default, so `"tracks"` there is a STRING literal, and
    // `SELECT * FROM "tracks"` selects the word "tracks" once. Not a style choice.
    expect(quoteIdent("mysql", "tracks")).toBe("`tracks`");
    expect(quoteIdent("postgres", "tracks")).toBe('"tracks"');
    expect(quoteIdent("clickhouse", "tracks")).toBe('"tracks"');
    expect(quoteIdent("mongodb", "tracks")).toBe('"tracks"');
    expect(quoteIdent("redis", "tracks")).toBe('"tracks"');
  });

  it("🔴 doubles an embedded quote, so a hostile table name cannot close the quote", () => {
    // Table names come from the server. A table created as `he"llo` would otherwise terminate
    // our quote and splice whatever follows into the statement.
    expect(quoteIdent("postgres", 'he"llo')).toBe('"he""llo"');
    expect(quoteIdent("mysql", "he`llo")).toBe("`he``llo`");
    // And every occurrence, not just the first.
    expect(quoteIdent("postgres", 'a"b"c')).toBe('"a""b""c"');
  });
});

describe("qualifiedTableName", () => {
  it("qualifies with the SCHEMA when there is one", () => {
    expect(
      qualifiedTableName("postgres", { database: "maestro", schema: "public", name: "tracks" }),
    ).toBe('"public"."tracks"');
  });

  it("qualifies with the DATABASE on the engines with no schema level", () => {
    // MySQL's schemata ARE its databases (`engine.rs`'s own comment), so `db.table` is the
    // two-part name there; ClickHouse is the same shape.
    expect(
      qualifiedTableName("mysql", { database: "shop", schema: null, name: "orders" }),
    ).toBe("`shop`.`orders`");
    expect(
      qualifiedTableName("clickhouse", { database: "logs", schema: null, name: "events" }),
    ).toBe('"logs"."events"');
  });
});

describe("browseQuery — the statement a double-click runs", () => {
  it("🔴 is a quoted, qualified SELECT with the connection's row limit, spelled out", () => {
    expect(
      browseQuery(
        "postgres",
        { database: "maestro", schema: "public", name: "tracks" },
        500,
      ),
    ).toBe('SELECT * FROM "public"."tracks" LIMIT 500;');
  });

  it("uses the connection's OWN limit, not a constant", () => {
    // The number a connection promises. A hardcoded 500 against a connection configured for
    // 50 would silently read ten times what the user allowed.
    expect(
      browseQuery("postgres", { database: "m", schema: "public", name: "t" }, 50),
    ).toBe('SELECT * FROM "public"."t" LIMIT 50;');
  });

  it("uses MySQL's backticks and ClickHouse's double quotes, with the database as qualifier", () => {
    expect(browseQuery("mysql", { database: "shop", schema: null, name: "orders" }, 200)).toBe(
      "SELECT * FROM `shop`.`orders` LIMIT 200;",
    );
    expect(
      browseQuery("clickhouse", { database: "logs", schema: null, name: "events" }, 1000),
    ).toBe('SELECT * FROM "logs"."events" LIMIT 1000;');
  });

  it("is PartiQL for DynamoDB — a double-quoted table, no qualifier, and no LIMIT", () => {
    // Three differences from the SQL engines, and each one is a real property of PartiQL rather
    // than a style choice:
    //   • the table name MUST be double-quoted (a bare identifier is a syntax error there),
    //   • there is no database or schema to qualify it with (a region contains tables),
    //   • **PartiQL has no LIMIT clause** — the row cap is applied by the request's paging, so
    //     emitting one would put a statement in the editor that the service rejects outright.
    expect(
      browseQuery("dynamodb", { database: "", schema: null, name: "tracks" }, 500),
    ).toBe('SELECT * FROM "tracks";');
    // The row limit is genuinely ignored here, so the two calls agree — asserted rather than
    // assumed, because "the limit is ignored" is exactly the kind of claim that rots.
    expect(browseQuery("dynamodb", { database: "", schema: null, name: "t" }, 50)).toBe(
      browseQuery("dynamodb", { database: "", schema: null, name: "t" }, 5000),
    );
  });

  it("ends in a semicolon, so ⌘⏎ and ⇧⌘⏎ do the same thing to it", () => {
    const sql = browseQuery("postgres", { database: "m", schema: "public", name: "t" }, 1);
    expect(sql?.endsWith(";")).toBe(true);
  });

  it("is a Mongo command DOCUMENT, not SQL, because Run means something else there", () => {
    expect(
      browseQuery("mongodb", { database: "master-api", schema: null, name: "tracks" }, 500),
    ).toBe('{\n  "find": "tracks",\n  "limit": 500\n}');
  });

  it("🔴 is NULL for Redis rather than a plausible SCAN this build has never run", () => {
    // A key is not a relation, `engine_for` refuses Redis outright, and a command in someone's
    // editor that has never been executed against a server is the invented-node failure the
    // tree forbids — moved into an editor buffer.
    expect(browseQuery("redis", { database: "0", schema: null, name: "user:1" }, 500)).toBeNull();
  });
});

describe("isBrowsable", () => {
  it("is the relation-shaped kinds only", () => {
    expect(isBrowsable("table")).toBe(true);
    expect(isBrowsable("view")).toBe(true);
    expect(isBrowsable("collection")).toBe(true);
    // 🔴 A column is NOT browsable, and this is the assertion that matters: a column carries
    // its TABLE's ref, so without this check a double-click on `tracks.id` would open a
    // browse of `tracks` — plausible enough that nobody would report it, and wrong.
    expect(isBrowsable("column")).toBe(false);
    expect(isBrowsable("database")).toBe(false);
    expect(isBrowsable("schema")).toBe(false);
    expect(isBrowsable("group")).toBe(false);
    expect(isBrowsable("key")).toBe(false);
    expect(isBrowsable("savedQuery")).toBe(false);
  });
});
