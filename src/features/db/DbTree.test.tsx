/**
 * The TREE seam: store ⇄ `<DbTree/>` ⇄ `db_children` / the saved-query commands, driven for
 * real, with only the IPC edge mocked.
 *
 * 🔴 This file exists because the thing it tests had already happened. `db_children`,
 * `db_saved_queries`, `db_saved_query_upsert` and `db_saved_query_delete` were registered in
 * `src-tauri/src/lib.rs`, covered by Rust tests, and live-tested against a real PostgreSQL —
 * and the rail rendered a paragraph apologising for not having a tree, while `dbIpc.ts`'s
 * header still asserted the commands did not exist. Two 100%-covered halves, no feature. So the
 * assertions below are deliberately about the JOIN: which command was called, with which arguments, how many times, and what the user can
 * then read on screen.
 *
 * Not a unit test, and it does not pretend to be. The real store, the real reducers, the real
 * component, the real pure logic — one mock, at the wire.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The one mocked boundary, and only the invoking half of it: `dbTreeFormat` and the record
// shapers stay real, because the whole question is whether the app builds the right wire call.
const ipc = vi.hoisted(() => ({
  dbChildren: vi.fn(),
  dbSavedQueries: vi.fn(),
  dbSavedQueryUpsert: vi.fn(),
  dbSavedQueryDelete: vi.fn(),
  dbTreeOrder: vi.fn(),
  dbTreeOrderSet: vi.fn(),
  dbEngines: vi.fn(),
  dbConnectionsLoad: vi.fn(),
  dbConnectionUpsert: vi.fn(),
  dbConnectionDelete: vi.fn(),
  dbTestConnection: vi.fn(),
  dbOpen: vi.fn(),
  dbClose: vi.fn(),
  dbQuery: vi.fn(),
  dbUrlBuild: vi.fn(),
  dbUrlParse: vi.fn(),
}));
vi.mock("./dbIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dbIpc")>()),
  ...ipc,
}));

import { useAppStore, DB_SAVED_QUERY_ALREADY_GONE_NOTE } from "../../app/store";
// 🔴 The DnD helpers, and using them is not optional: `fireEvent.dragOver(el, { clientX })`
// silently drops coordinates and `relatedTarget` in jsdom (no `DragEvent` implementation), so a
// hand-rolled version of these tests goes green without ever exercising the guard it names.
import { fireDragAt, fireDragLeave, makeDataTransfer } from "../../test/dnd";
import { resetStore } from "../../test/store-harness";
// The console's fixtures, imported rather than re-typed: `MESSAGE_RESULT` and `TRACKS_RESULT`
// are the canonical spellings of "a database error" and "a row set", and a second hand-rolled
// copy of a `DbResultSet` here could drift from the one the console's tests use.
import { MESSAGE_RESULT, TRACKS_RESULT } from "./console/consoleFixtures";
import { DB_NODE_DND_MIME, dbLabelType, dbParentType, DbTree } from "./DbTree";
import type { DbTreeNode, SavedQueryRecord } from "./dbIpc";
import { nodeKey, ROOT_KEY, SAVED_QUERIES_KEY } from "./dbTreeFormat";
import type { DbConnection, DbResultSet } from "./types";

const state = () => useAppStore.getState();
const CID = "c1";
const SID = "sess-1";

/* ─────────────────────────────── the fixtures ─────────────────────────────── */

const DATABASE: DbTreeNode = {
  nodeRef: { kind: "database", name: "maestro" },
  label: "maestro",
  subLabel: "the connected database",
  kind: "database",
  expandable: true,
};

const SCHEMA: DbTreeNode = {
  nodeRef: { kind: "schema", database: "maestro", name: "public" },
  label: "public",
  subLabel: "3 objects",
  kind: "schema",
  expandable: true,
};

const TABLES_GROUP: DbTreeNode = {
  nodeRef: { kind: "group", database: "maestro", schema: "public", group: "tables" },
  label: "Tables",
  subLabel: "1 table",
  kind: "group",
  expandable: true,
};

const TRACKS: DbTreeNode = {
  nodeRef: { kind: "table", database: "maestro", schema: "public", name: "tracks" },
  label: "tracks",
  subLabel: null,
  kind: "table",
  expandable: true,
};

/**
 * A schema a `CREATE SCHEMA` has just added. It exists only in the SECOND round of answers,
 * so a row that says `legacy` on screen is proof the level was read again — not proof that a
 * call was counted.
 */
const LEGACY_SCHEMA: DbTreeNode = {
  nodeRef: { kind: "schema", database: "maestro", name: "legacy" },
  label: "legacy",
  subLabel: "1 object",
  kind: "schema",
  expandable: true,
};

/**
 * What a `CREATE TABLE` actually comes back as — **`affected`, with ZERO rows affected**.
 *
 * Not invented, and not read off the frontend's own types: `src-tauri/src/db/engine.rs`
 * classifies any statement that returned no rows and is not row-returning as `Affected`, and
 * `db_live.rs`'s `ddl_on_postgres_is_an_affected_result_with_zero_rows` pins it against a real
 * PostgreSQL. This shape is the reason the trigger keys on the KIND and never on
 * `rowsAffected > 0` — DDL is exactly the statement that affects no rows, and DDL is what
 * exposed the bug.
 */
const CREATE_TABLE_RESULT: DbResultSet = {
  kind: "affected",
  statement: "CREATE SCHEMA legacy",
  columns: [],
  rows: [],
  rowsAffected: 0,
  truncated: false,
  rowLimit: 500,
  durationMs: 7,
  notice: null,
};

/** Two columns of `tracks` — and note they share `TRACKS`'s ref, exactly as Rust sends them. */
const COLUMNS: DbTreeNode[] = [
  {
    nodeRef: TRACKS.nodeRef,
    label: "id",
    subLabel: "int · not null",
    kind: "column",
    expandable: false,
  },
  {
    nodeRef: TRACKS.nodeRef,
    label: "tag",
    subLabel: "varchar(64)",
    kind: "column",
    expandable: false,
  },
];

const query = (over: Partial<SavedQueryRecord> = {}): SavedQueryRecord => ({
  id: "Q1",
  connectionId: CID,
  name: "Recent tracks",
  sql: "SELECT * FROM tracks ORDER BY at DESC",
  createdAtMs: 1,
  updatedAtMs: 2,
  ...over,
});

/** The tree, connected, with the given engine family. */
function mount(sessionId: string | null = SID, family = "postgres" as const) {
  return render(
    <DbTree connectionId={CID} family={family} rowLimit={500} sessionId={sessionId} />,
  );
}

/**
 * The store state `runDbQuery` needs before it will send anything: the connection record (for
 * its row limit) and an OPEN session. Spelled out here rather than driven through
 * `<DbPanel/>` — the subject of these tests is what a completed run does to the TREE, and
 * mounting a panel to get there would put a second component between the write and the claim.
 */
function connected(): void {
  useAppStore.setState((s) => {
    s.dbConnections = [
      {
        id: CID,
        name: "maestro (local)",
        engine: "postgres",
        family: "postgres",
        host: "127.0.0.1",
        port: 55432,
        database: "maestro",
        readOnly: false,
        rowLimit: 500,
        timeoutMs: 30_000,
      } as unknown as DbConnection,
    ];
    s.dbSessions[CID] = {
      status: "open",
      sessionId: SID,
      serverVersion: "PostgreSQL 17.2",
      latencyMs: 3,
      error: null,
    };
  });
}

/** The row whose `data-label` is `label`. */
const row = (label: string): HTMLElement =>
  screen
    .getAllByTestId("db-tree-row")
    .find((el) => el.getAttribute("data-label") === label) as HTMLElement;

beforeEach(() => {
  resetStore();
  // ⚠️ `resetStore` does NOT clear `dbTreeOrders` (the shared harness is generic), and
  // a leaked arrangement is the nastiest kind of cross-test state: it changes the ORDER rows
  // render in, so the failure surfaces three tests later as "the wrong table was clicked".
  useAppStore.setState((s) => {
    s.dbTreeOrders = {};
  });
  for (const fn of Object.values(ipc)) fn.mockReset();
  ipc.dbSavedQueries.mockResolvedValue([]);
  ipc.dbChildren.mockResolvedValue([]);
  // The mount reads the saved arrangement exactly like the saved queries. Default: none, i.e.
  // whatever the engine returned, which is what every test written before this feature assumes.
  ipc.dbTreeOrder.mockResolvedValue([]);
  ipc.dbTreeOrderSet.mockResolvedValue(undefined);
});
afterEach(cleanup);

/* ──────────────────────────── lazy expand + cache ──────────────────────────── */

describe("the lazy expand", () => {
  it("🔴 asks db_children ONCE per level, with the session id and the ref verbatim", async () => {
    ipc.dbChildren.mockResolvedValueOnce([DATABASE]).mockResolvedValueOnce([SCHEMA]);
    mount();

    // The root level loads on mount: the disclosure in `<DbPanel/>` IS the first expand.
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    expect(ipc.dbChildren).toHaveBeenCalledTimes(1);
    expect(ipc.dbChildren).toHaveBeenNthCalledWith(1, SID, { kind: "root" });

    fireEvent.click(row("maestro"));
    await waitFor(() => expect(row("public")).toBeInTheDocument());
    expect(ipc.dbChildren).toHaveBeenCalledTimes(2);
    // The ref is sent back EXACTLY as it arrived — `tree.rs` asserts the round trip on its
    // side, and this is the other half of that claim.
    expect(ipc.dbChildren).toHaveBeenNthCalledWith(2, SID, {
      kind: "database",
      name: "maestro",
    });
  });

  it("🔴 re-expanding is FREE — a collapse and re-open issues no second call", async () => {
    // `mockResolvedValue` (not `…Once`) for the second level ON PURPOSE: if the cache check
    // were removed, a `…Once` chain would run dry and this test would fail with a crash inside
    // the render instead of with the call COUNT — which is the thing being claimed. Verified by
    // deleting the check: it now reports `expected "dbChildren" to be called 2 times, but got
    // 3 times`.
    ipc.dbChildren.mockResolvedValueOnce([DATABASE]).mockResolvedValue([SCHEMA]);
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());

    fireEvent.click(row("maestro"));
    await waitFor(() => expect(row("public")).toBeInTheDocument());
    expect(ipc.dbChildren).toHaveBeenCalledTimes(2);

    fireEvent.click(row("maestro")); // collapse
    expect(screen.queryByText("public")).toBeNull();
    fireEvent.click(row("maestro")); // and open again
    await waitFor(() => expect(row("public")).toBeInTheDocument());

    // Still two. This is the whole point of the cache: a rail-tab toggle or a stray
    // double-click must not fire catalogue queries at a production server.
    expect(ipc.dbChildren).toHaveBeenCalledTimes(2);
  });

  it("shows a spinner note while a level is in flight, and nothing else", async () => {
    let release!: (n: DbTreeNode[]) => void;
    ipc.dbChildren.mockReturnValue(new Promise<DbTreeNode[]>((r) => (release = r)));
    mount();

    await waitFor(() =>
      expect(
        screen.getAllByTestId("db-tree-note").some((n) => n.dataset.note === "loading"),
      ).toBe(true),
    );
    release([DATABASE]);
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    expect(screen.queryByTestId("db-tree-error")).toBeNull();
  });

  it("says `Nothing here.` for a level that really is empty", async () => {
    ipc.dbChildren.mockResolvedValue([]);
    mount();
    await waitFor(() =>
      expect(
        screen.getAllByTestId("db-tree-note").some((n) => n.dataset.note === "empty"),
      ).toBe(true),
    );
  });

  it("does not dial at all without a session, and says which half is missing", async () => {
    mount(null);
    await waitFor(() => expect(ipc.dbSavedQueries).toHaveBeenCalledTimes(1));
    expect(ipc.dbChildren).not.toHaveBeenCalled();
    expect(screen.getByTestId("db-tree-no-session")).toBeInTheDocument();
  });

  it("renders the hierarchy the SERVER sent, four levels deep, with no shape hardcoded", async () => {
    // PostgreSQL's shape (database → schema → group → table → columns). Nothing in the
    // component knows this order — swap the fixtures for MySQL's flatter one and it renders
    // that instead, which is why `tree.rs` has no `hierarchy` table.
    ipc.dbChildren
      .mockResolvedValueOnce([DATABASE])
      .mockResolvedValueOnce([SCHEMA])
      .mockResolvedValueOnce([TABLES_GROUP])
      .mockResolvedValueOnce([TRACKS])
      .mockResolvedValueOnce(COLUMNS);
    mount();

    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.click(row("maestro"));
    await waitFor(() => expect(row("public")).toBeInTheDocument());
    fireEvent.click(row("public"));
    await waitFor(() => expect(row("Tables")).toBeInTheDocument());
    fireEvent.click(row("Tables"));
    await waitFor(() => expect(row("tracks")).toBeInTheDocument());
    fireEvent.click(row("tracks"));

    // 🔴 Both columns render. They share one `nodeRef` (Rust's `DbNode::column` borrows the
    // table's), so a tree keyed by the ref would show one of them.
    await waitFor(() => expect(row("id")).toBeInTheDocument());
    expect(row("tag")).toBeInTheDocument();
    // The sub-label is rendered dim beside the label — the field a `ref`-vs-`nodeRef` slip in
    // the wire types would have left `undefined`.
    expect(screen.getByText("int · not null")).toBeInTheDocument();
    expect(screen.getByText("varchar(64)")).toBeInTheDocument();
  });

  it("gives a leaf no chevron, and an expandable node one", async () => {
    ipc.dbChildren.mockResolvedValueOnce([DATABASE]).mockResolvedValueOnce(COLUMNS);
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.click(row("maestro"));
    await waitFor(() => expect(row("id")).toBeInTheDocument());

    expect(row("maestro").querySelector(".db-tree__caret--none")).toBeNull();
    expect(row("id").querySelector(".db-tree__caret--none")).not.toBeNull();
    // And a leaf's click does nothing at all — no expand, no extra call.
    const before = ipc.dbChildren.mock.calls.length;
    fireEvent.click(row("id"));
    expect(ipc.dbChildren.mock.calls.length).toBe(before);
  });

  it("renders an icon for every kind the wire can send, including the unwired ones", async () => {
    // `key` and `collection` come from engines with no driver yet (`engine_for` refuses Redis
    // and Mongo). They are still on the wire contract, so the icon map must answer them
    // rather than crash the rail the day a driver lands.
    ipc.dbChildren.mockResolvedValueOnce([
      DATABASE,
      SCHEMA,
      TABLES_GROUP,
      { ...TRACKS, label: "top_artists", kind: "view" },
      { ...TRACKS, label: "books", kind: "collection" },
      { ...TRACKS, label: "user:1", kind: "key", expandable: false },
      COLUMNS[0],
    ]);
    mount();
    await waitFor(() => expect(row("user:1")).toBeInTheDocument());
    for (const label of ["maestro", "public", "Tables", "top_artists", "books", "user:1", "id"]) {
      expect(row(label).querySelector(".db-tree__icon svg")).not.toBeNull();
    }
  });
});

/* ──────────────────────── a failed expand is an INLINE note ──────────────────────── */

describe("a failed expand", () => {
  it("🔴 is a calm inline note on the node with a Retry — never a panel-level error", async () => {
    ipc.dbChildren.mockResolvedValueOnce([DATABASE]).mockRejectedValueOnce("network: reset");
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());

    fireEvent.click(row("maestro"));

    // The mapped sentence, on the node, and never Rust's raw string (a driver message can
    // carry the DSN it dialled).
    await waitFor(() =>
      expect(screen.getByTestId("db-tree-error")).toHaveTextContent(
        "The server could not be reached — check the host, the port, and whether a VPN or firewall is in the way.",
      ),
    );
    // The rest of the tree is untouched: the parent row is still there, and nothing wrote to
    // the PANEL-level error slot. A dropped VPN must not take the rail down.
    expect(row("maestro")).toBeInTheDocument();
    expect(state().dbError).toBeNull();
    expect(screen.getByTestId("db-tree-retry")).toBeInTheDocument();
  });

  it("🔴 Retry gets PAST the cached failure and succeeds", async () => {
    ipc.dbChildren
      .mockResolvedValueOnce([DATABASE])
      .mockRejectedValueOnce("network: reset")
      .mockResolvedValueOnce([SCHEMA]);
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.click(row("maestro"));
    await waitFor(() => expect(screen.getByTestId("db-tree-retry")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("db-tree-retry"));

    await waitFor(() => expect(row("public")).toBeInTheDocument());
    expect(screen.queryByTestId("db-tree-error")).toBeNull();
    // Three calls: root, the failure, the retry. Without `force` the cached failure would
    // short-circuit the third and Retry would be a button that cannot succeed.
    expect(ipc.dbChildren).toHaveBeenCalledTimes(3);
    expect(ipc.dbChildren).toHaveBeenNthCalledWith(3, SID, { kind: "database", name: "maestro" });
  });

  it("keeps the failure across a collapse, so re-opening still explains itself", async () => {
    ipc.dbChildren.mockResolvedValueOnce([DATABASE]).mockRejectedValueOnce("timeout: slow");
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.click(row("maestro"));
    await waitFor(() => expect(screen.getByTestId("db-tree-error")).toBeInTheDocument());

    fireEvent.click(row("maestro")); // collapse
    fireEvent.click(row("maestro")); // re-open
    expect(screen.getByTestId("db-tree-error")).toBeInTheDocument();
    // And no new attempt: a cached failure is still a cached answer.
    expect(ipc.dbChildren).toHaveBeenCalledTimes(2);
  });

  it("🔴 Retry sends the SAME ref, not the root's — the failed level, not the tree", async () => {
    // The version of this that shipped first looked the ref up from the cache key, and its
    // "not found" branch was unreachable through any click (a failure note only renders inside
    // its parent's expanded subtree, so the parent is cached by construction). The ref is now
    // threaded down as the render recurses, and this is the assertion that it is the RIGHT one:
    // a lookup that fell back to `{kind:"root"}` would reload the top of the tree and leave the
    // broken level exactly as broken, with the button looking like it worked.
    ipc.dbChildren
      .mockResolvedValueOnce([DATABASE])
      .mockResolvedValueOnce([SCHEMA])
      .mockRejectedValueOnce("network: reset")
      .mockResolvedValueOnce([TABLES_GROUP]);
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.click(row("maestro"));
    await waitFor(() => expect(row("public")).toBeInTheDocument());
    fireEvent.click(row("public"));
    await waitFor(() => expect(screen.getByTestId("db-tree-retry")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("db-tree-retry"));

    await waitFor(() => expect(row("Tables")).toBeInTheDocument());
    expect(ipc.dbChildren).toHaveBeenNthCalledWith(4, SID, {
      kind: "schema",
      database: "maestro",
      name: "public",
    });
  });
});

/* ────────────────────── double-click a table → a browse query ────────────────────── */

describe("double-clicking a table", () => {
  it("🔴 opens the console with the quoted, limited browse statement", async () => {
    ipc.dbChildren.mockResolvedValueOnce([TRACKS]);
    mount();
    await waitFor(() => expect(row("tracks")).toBeInTheDocument());

    fireEvent.doubleClick(row("tracks"));

    // The tab exists AND the buffer holds the exact statement — the seam, not just the action.
    const tabs = Object.values(state().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].ref).toEqual({ kind: "db-console", connectionId: CID });
    expect(state().dbConsoles[CID]?.text).toBe(
      'SELECT * FROM "public"."tracks" LIMIT 500;',
    );
  });

  it("🔴 does NOT inherit the previously-opened saved query's id", async () => {
    // The worst outcome available here: browse after opening a saved query, press ⌘S, and
    // someone's saved SQL is silently replaced by a `SELECT *`.
    ipc.dbChildren.mockResolvedValueOnce([TRACKS]);
    ipc.dbSavedQueries.mockResolvedValue([query()]);
    mount();
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("db-saved-query-row"));
    expect(state().dbConsoles[CID]?.savedQuery).toEqual({ id: "Q1", name: "Recent tracks" });

    fireEvent.doubleClick(row("tracks"));
    expect(state().dbConsoles[CID]?.savedQuery).toBeNull();
  });

  it("does nothing on a COLUMN, whose ref is its table's", async () => {
    ipc.dbChildren.mockResolvedValueOnce(COLUMNS);
    mount();
    await waitFor(() => expect(row("id")).toBeInTheDocument());

    fireEvent.doubleClick(row("id"));
    // No tab, no buffer. Without `isBrowsable` this would have browsed `tracks` — plausible
    // enough to go unnoticed.
    expect(Object.values(state().tabs)).toHaveLength(0);
    expect(state().dbConsoles[CID]).toBeUndefined();
  });

  it("does nothing on a database or a group", async () => {
    ipc.dbChildren.mockResolvedValueOnce([DATABASE, TABLES_GROUP]);
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.doubleClick(row("maestro"));
    fireEvent.doubleClick(row("Tables"));
    expect(Object.values(state().tabs)).toHaveLength(0);
  });

  it("does nothing on a browsable kind arriving on a non-table ref (a malformed node)", async () => {
    // `kind` and `nodeRef` are independent by design (`tree.rs` says so), so this shape is
    // expressible on the wire. Building `SELECT * FROM …` from a database ref would produce
    // nonsense SQL rather than an error.
    ipc.dbChildren.mockResolvedValueOnce([
      { ...DATABASE, label: "weird", kind: "collection" as const },
    ]);
    mount();
    await waitFor(() => expect(row("weird")).toBeInTheDocument());
    fireEvent.doubleClick(row("weird"));
    expect(Object.values(state().tabs)).toHaveLength(0);
  });

  it("🔴 opens NO console on Redis, where there is no browse query to invent", async () => {
    ipc.dbChildren.mockResolvedValueOnce([{ ...TRACKS, label: "user:1", kind: "collection" }]);
    render(<DbTree connectionId={CID} family="redis" rowLimit={500} sessionId={SID} />);
    await waitFor(() => expect(row("user:1")).toBeInTheDocument());

    fireEvent.doubleClick(row("user:1"));
    expect(Object.values(state().tabs)).toHaveLength(0);
  });
});

/* ──────────────────────────────── saved queries ──────────────────────────────── */

describe("the Saved queries node", () => {
  it("🔴 lists what db_saved_queries returns, keyed by CONNECTION and with no session", async () => {
    ipc.dbSavedQueries.mockResolvedValue([
      query({ id: "Q2", name: "Plays by title", sql: "SELECT title, count(*)\nFROM tracks" }),
      query({ id: "Q1", name: "Recent tracks" }),
    ]);
    // No session at all — which is the requirement's actual shape: "close the app, reopen it,
    // double-click the connection and see the list" must not need a reachable database.
    mount(null);

    await waitFor(() => expect(screen.getAllByTestId("db-saved-query-row")).toHaveLength(2));
    expect(ipc.dbSavedQueries).toHaveBeenCalledWith(CID);
    expect(screen.getByTestId("db-saved-queries-count")).toHaveTextContent("2 queries");
    // Rust's order is preserved (newest-updated first), and the sub-label is the first
    // non-blank line of the SQL.
    const rows = screen.getAllByTestId("db-saved-query-row");
    expect(rows[0].getAttribute("data-label")).toBe("Plays by title");
    expect(rows[0]).toHaveTextContent("SELECT title, count(*)");
    expect(rows[1].getAttribute("data-label")).toBe("Recent tracks");
  });

  it("is OPEN by default — the requirement is 'see the list', not 'find the list'", async () => {
    ipc.dbSavedQueries.mockResolvedValue([query()]);
    mount();
    // Visible with no extra click.
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());

    // And it collapses, without asking `db_children` for anything: the node is answered
    // locally, so a toggle is free.
    const before = ipc.dbChildren.mock.calls.length;
    fireEvent.click(screen.getByTestId("db-saved-queries-node"));
    expect(screen.queryByTestId("db-saved-query-row")).toBeNull();
    expect(state().dbTrees[CID]?.expanded[SAVED_QUERIES_KEY]).toBe(true);
    expect(ipc.dbChildren.mock.calls.length).toBe(before);

    fireEvent.click(screen.getByTestId("db-saved-queries-node"));
    expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument();
  });

  it("🔴 clicking one opens it in the console, buffer AND identity", async () => {
    ipc.dbSavedQueries.mockResolvedValue([query({ sql: "SELECT 1 -- mine" })]);
    mount();
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("db-saved-query-row"));

    const tabs = Object.values(state().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].ref).toEqual({ kind: "db-console", connectionId: CID });
    expect(state().dbConsoles[CID]?.text).toBe("SELECT 1 -- mine");
    // Adopted, so the NEXT ⌘S updates this query rather than asking for a name — the half
    // that makes an opened query editable instead of a one-way copy.
    expect(state().dbConsoles[CID]?.savedQuery).toEqual({ id: "Q1", name: "Recent tracks" });
  });

  it("says what an empty list means, and how to leave it", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("db-saved-queries-empty")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("db-saved-queries-count")).toHaveTextContent("none yet");
    // …with the chord this keyboard has (jsdom is not macOS), never a hardcoded ⌘S.
    expect(screen.getByTestId("db-saved-queries-empty")).toHaveTextContent(
      "Nothing saved yet. Ctrl+S in a console names and saves the query in it.",
    );
  });

  it("shows `loading…` while the read is in flight, and no empty note under it", async () => {
    let release!: (q: SavedQueryRecord[]) => void;
    ipc.dbSavedQueries.mockReturnValue(new Promise<SavedQueryRecord[]>((r) => (release = r)));
    mount();

    await waitFor(() =>
      expect(screen.getByTestId("db-saved-queries-count")).toHaveTextContent("loading…"),
    );
    expect(screen.queryByTestId("db-saved-queries-empty")).toBeNull();
    release([query()]);
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());
  });

  it("a failed read is an inline note, not a panel error", async () => {
    ipc.dbSavedQueries.mockRejectedValue("unknown: disk");
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("db-saved-queries-error")).toHaveTextContent(
        "The database call failed for an unrecognized reason — retrying may help.",
      ),
    );
    expect(state().dbError).toBeNull();
  });

  it("renders a query with blank SQL without an empty dim line", async () => {
    ipc.dbSavedQueries.mockResolvedValue([query({ name: "Scratch", sql: "   \n " })]);
    mount();
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());
    expect(screen.getByTestId("db-saved-query-row").querySelector(".db-tree__sub")).toBeNull();
  });

  it("🔴 deleting one removes it WITHOUT also opening it into a console", async () => {
    ipc.dbSavedQueries.mockResolvedValue([query()]);
    ipc.dbSavedQueryDelete.mockResolvedValue(true);
    mount();
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete saved query Recent tracks" }));

    await waitFor(() => expect(screen.queryByTestId("db-saved-query-row")).toBeNull());
    expect(ipc.dbSavedQueryDelete).toHaveBeenCalledWith("Q1");
    // The `stopPropagation` claim, as an assertion: without it the row's own click handler
    // also fires and the last thing the user sees is the SQL they just deleted.
    expect(Object.values(state().tabs)).toHaveLength(0);
    expect(state().dbConsoles[CID]).toBeUndefined();
  });

  it("reports a stale delete rather than letting it look like a successful one", async () => {
    ipc.dbSavedQueries.mockResolvedValue([query()]);
    ipc.dbSavedQueryDelete.mockResolvedValue(false);
    mount();
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete saved query Recent tracks" }));

    await waitFor(() =>
      expect(screen.getByTestId("db-saved-queries-error")).toHaveTextContent(
        DB_SAVED_QUERY_ALREADY_GONE_NOTE,
      ),
    );
  });

  it("a failed delete says so and keeps the row", async () => {
    ipc.dbSavedQueries.mockResolvedValue([query()]);
    ipc.dbSavedQueryDelete.mockRejectedValue("unknown: read-only volume");
    mount();
    await waitFor(() => expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete saved query Recent tracks" }));

    await waitFor(() =>
      expect(screen.getByTestId("db-saved-queries-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("db-saved-query-row")).toBeInTheDocument();
  });
});

/* ───────────── 🔴 the tree after a WRITE — the stale-cache bug ───────────── */

/**
 * **The bug:** an edit to the database was not reflected in the tree until the
 * view was changed. `dbTrees` cached every level it had ever read, three places deleted the whole
 * record (delete-connection, disconnect, `clearDbTree`) and **running a statement was not one
 * of them** — so a `CREATE`/`DROP`/`ALTER` left the rail showing the shape it first loaded.
 *
 * Every test here drives the real store, the real component and the real reducers, with only
 * `dbIpc` mocked. The claims are deliberately about the SCREEN (`legacy` appears; `public` is
 * still there) and not only about call counts: a count can be satisfied by a tree that threw
 * the user's expansion away and rebuilt it, which is the fix that would have been worse than
 * the bug.
 */
describe("a run that WROTE refreshes the tree", () => {
  /** Root and `maestro` both read and both open — two levels on screen. */
  async function twoLevelsOpen(): Promise<void> {
    ipc.dbChildren.mockResolvedValueOnce([DATABASE]).mockResolvedValueOnce([SCHEMA]);
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.click(row("maestro"));
    await waitFor(() => expect(row("public")).toBeInTheDocument());
    expect(ipc.dbChildren).toHaveBeenCalledTimes(2);
  }

  it("🔴 re-reads every level ON SCREEN, and the user's expanded shape survives it", async () => {
    connected();
    await twoLevelsOpen();

    // The second round of answers. `maestro` now has a schema it did not have before — the
    // thing the write created, and the only evidence that distinguishes a re-read from a
    // re-render of the cache.
    ipc.dbChildren
      .mockResolvedValueOnce([DATABASE])
      .mockResolvedValueOnce([SCHEMA, LEGACY_SCHEMA]);
    ipc.dbQuery.mockResolvedValue([CREATE_TABLE_RESULT]);

    await state().dbActions.runDbQuery(CID, "statement", "CREATE SCHEMA legacy");

    // 1. The new object is on screen with no gesture from the user — the failure this guards
    //    against, inverted.
    await waitFor(() => expect(row("legacy")).toBeInTheDocument());
    // 2. 🔴 And the shape SURVIVED: `public` is a child of `maestro`, so it can only be here
    //    if `maestro` is still expanded. A `clearDbTree`-and-reload would have collapsed it
    //    and this row would be gone — which is why the assertion is on the CHILD row.
    expect(row("public")).toBeInTheDocument();
    // 3. Two more calls, one per level that was on screen — not one per level ever loaded,
    //    and not one per level in the catalogue.
    expect(ipc.dbChildren).toHaveBeenCalledTimes(4);
    expect(ipc.dbChildren).toHaveBeenNthCalledWith(3, SID, { kind: "root" });
    expect(ipc.dbChildren).toHaveBeenNthCalledWith(4, SID, {
      kind: "database",
      name: "maestro",
    });
  });

  it("🔴 and a run of pure ROWS re-reads nothing — the two-sided half", async () => {
    connected();
    await twoLevelsOpen();

    // Armed with the same second round. If the trigger fired on everything, `legacy` would
    // appear here too and the test above would prove nothing about `kind`.
    ipc.dbChildren
      .mockResolvedValueOnce([DATABASE])
      .mockResolvedValueOnce([SCHEMA, LEGACY_SCHEMA]);
    ipc.dbQuery.mockResolvedValue([TRACKS_RESULT]);

    await state().dbActions.runDbQuery(CID, "statement", "SELECT * FROM tracks");

    // The results landed, so the run really completed — otherwise "nothing was re-read" would
    // be true for the wrong reason.
    expect(state().dbConsoles[CID]?.results).toEqual([TRACKS_RESULT]);
    expect(ipc.dbChildren).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("legacy")).toBeNull();
  });

  it("does not resurrect a level the user COLLAPSED, and does not pay for it either", async () => {
    connected();
    await twoLevelsOpen();
    fireEvent.click(row("maestro")); // collapse it
    expect(screen.queryByText("public")).toBeNull();

    ipc.dbChildren.mockResolvedValue([DATABASE]);
    ipc.dbQuery.mockResolvedValue([CREATE_TABLE_RESULT]);
    await state().dbActions.runDbQuery(CID, "statement", "DROP TABLE tracks");

    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    // Collapsed stays collapsed: the refresh drops the cached CHILDREN, never `expanded`.
    expect(screen.queryByText("public")).toBeNull();
    // And exactly ONE more call — the root. The collapsed level's cache was dropped too (it
    // was just as stale) but nothing renders it, so nothing pays for it until it is opened.
    expect(ipc.dbChildren).toHaveBeenCalledTimes(3);
    expect(ipc.dbChildren).toHaveBeenNthCalledWith(3, SID, { kind: "root" });
  });

  it("clears a level's cached FAILURE too, so the retry the user is owed is automatic", async () => {
    connected();
    ipc.dbChildren.mockRejectedValueOnce("network: reset");
    mount();
    await waitFor(() => expect(screen.getByTestId("db-tree-error")).toBeInTheDocument());
    expect(ipc.dbChildren).toHaveBeenCalledTimes(1);

    ipc.dbChildren.mockResolvedValueOnce([DATABASE]);
    ipc.dbQuery.mockResolvedValue([CREATE_TABLE_RESULT]);
    await state().dbActions.runDbQuery(CID, "statement", "CREATE SCHEMA legacy");

    // A cached failure is stale for exactly the reason a cached level is. Keeping it would
    // leave the sentence and its Retry button sitting under a tree that has just changed —
    // making the user click Retry to be told something the app could have found out itself.
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    expect(screen.queryByTestId("db-tree-error")).toBeNull();
    expect(ipc.dbChildren).toHaveBeenCalledTimes(2);
  });

  /**
   * Which result mixes count as "the database changed".
   *
   * The expectation column is written by hand, never derived from the results —
   * a table that computed `invalidates` from `kind` would be the implementation twice.
   */
  const TRIGGER_CASES: Array<{ what: string; results: DbResultSet[]; invalidates: boolean }> = [
    { what: "a CREATE, which affects zero rows", results: [CREATE_TABLE_RESULT], invalidates: true },
    {
      what: "a script whose LAST statement wrote",
      results: [TRACKS_RESULT, CREATE_TABLE_RESULT],
      invalidates: true,
    },
    {
      what: "a script whose FIRST statement wrote",
      results: [CREATE_TABLE_RESULT, TRACKS_RESULT],
      invalidates: true,
    },
    { what: "a SELECT", results: [TRACKS_RESULT], invalidates: false },
    // A `message` is a notice or a **database error**. Re-reading the catalogue after a
    // statement the server refused is noise: nothing changed.
    { what: "a database error", results: [MESSAGE_RESULT], invalidates: false },
    {
      what: "a script of reads and errors only",
      results: [TRACKS_RESULT, MESSAGE_RESULT],
      invalidates: false,
    },
  ];

  for (const { what, results, invalidates } of TRIGGER_CASES) {
    it(`${invalidates ? "invalidates" : "leaves the cache alone"} after ${what}`, async () => {
      connected();
      ipc.dbChildren.mockResolvedValue([DATABASE]);
      await state().dbActions.loadDbChildren(CID, SID, { kind: "root" });
      expect(state().dbTrees[CID]?.children[ROOT_KEY]).toBeDefined();

      ipc.dbQuery.mockResolvedValue(results);
      await state().dbActions.runDbQuery(CID, "statement", "…");

      // Presence in `children` IS the loaded marker, so its absence is exactly "read again".
      expect(ROOT_KEY in (state().dbTrees[CID]?.children ?? {})).toBe(!invalidates);
    });
  }
});

/* ─────────────────────── the store actions, at the edges ─────────────────────── */

describe("the tree store slice, on the paths a gesture cannot reach", () => {
  it("drops the cached subtree on DISCONNECT but keeps the saved queries", async () => {
    ipc.dbChildren.mockResolvedValue([DATABASE]);
    ipc.dbSavedQueries.mockResolvedValue([query()]);
    ipc.dbClose.mockResolvedValue(undefined);
    mount();
    await waitFor(() => expect(state().dbTrees[CID]?.children[ROOT_KEY]).toBeDefined());
    useAppStore.setState((s) => {
      s.dbSessions[CID] = {
        status: "open",
        sessionId: SID,
        serverVersion: "PostgreSQL 17.2",
        latencyMs: 1,
        error: null,
      };
    });

    // The tree goes off screen with the row: `<DbPanel/>` renders `<DbTree/>` only for a
    // connection that HAS a session record, and `closeDbSession` deletes that record in its
    // first `set`. Unmounting here is not test convenience — a MOUNTED tree
    // re-reads any level that is `idle` (`<IdleLevel/>`, the half of the stale-cache fix that
    // makes a refresh possible), so leaving it up with a now-dead session id in its props
    // would have it correctly re-fetch a level the disconnect had just dropped. That is a
    // state the panel cannot produce.
    cleanup();
    await state().dbActions.closeDbSession(CID);

    // Every ref in the cache addressed a session that is now invalid, so replaying it would
    // hand the user a tree whose clicks answer `not-found`.
    expect(state().dbTrees[CID]).toBeUndefined();
    // The saved queries survive: keyed by connection, read with no session.
    expect(state().dbSavedQueries[CID]?.queries).toHaveLength(1);
  });

  it("drops BOTH when the connection is deleted, because Rust cascades the queries", async () => {
    ipc.dbConnectionDelete.mockResolvedValue({ removed: true, savedQueriesRemoved: 1 });
    ipc.dbSavedQueries.mockResolvedValue([query()]);
    mount();
    await waitFor(() => expect(state().dbSavedQueries[CID]?.queries).toHaveLength(1));

    // Unmounted first, for the reason spelled out in the disconnect test above: the deleted
    // connection's ROW goes with it in `<DbPanel/>`, so no live tree is left to re-read a
    // level that no longer has a connection behind it.
    cleanup();
    await state().dbActions.deleteDbConnection(CID);

    expect(state().dbTrees[CID]).toBeUndefined();
    // Keeping our copy would leave a list of queries that no longer exist anywhere on disk.
    expect(state().dbSavedQueries[CID]).toBeUndefined();
  });

  it("refreshDbTree does NOT create a record for a connection nobody has expanded", () => {
    state().dbActions.refreshDbTree("never-expanded");
    // Not merely "did not crash": a blank record here would be indistinguishable from
    // "expanded but unread", and `<DbTree/>` would go and read a level nobody opened —
    // a catalogue query bought by a button press on an unrelated connection.
    expect(state().dbTrees["never-expanded"]).toBeUndefined();
  });

  it("refreshDbTree keeps a level that is already in FLIGHT in flight", async () => {
    let release!: (n: DbTreeNode[]) => void;
    ipc.dbChildren.mockReturnValue(new Promise<DbTreeNode[]>((r) => (release = r)));
    const inFlight = state().dbActions.loadDbChildren(CID, SID, { kind: "root" });
    expect(state().dbTrees[CID]?.loading[ROOT_KEY]).toBe(true);

    state().dbActions.refreshDbTree(CID);

    // `loading` is deliberately untouched. Clearing it would let a second call start beside
    // the first — two catalogue queries for one refresh, and a last-writer-wins race between
    // them. ⚠️ The known cost of that choice, recorded rather than hidden: the call already on
    // the wire lands with its PRE-write answer, which the manual Refresh is the escape from.
    expect(state().dbTrees[CID]?.loading[ROOT_KEY]).toBe(true);
    release([DATABASE]);
    await inFlight;
    expect(ipc.dbChildren).toHaveBeenCalledTimes(1);
  });

  it("clearDbTree is idempotent — clearing a connection that has no tree is not a crash", () => {
    expect(() => state().dbActions.clearDbTree("never-expanded")).not.toThrow();
    expect(state().dbTrees["never-expanded"]).toBeUndefined();
    state().dbActions.clearDbTree("never-expanded");
  });

  it("ignores a second load of a level already in flight", async () => {
    let release!: (n: DbTreeNode[]) => void;
    ipc.dbChildren.mockReturnValue(new Promise<DbTreeNode[]>((r) => (release = r)));

    const first = state().dbActions.loadDbChildren(CID, SID, { kind: "root" });
    const second = state().dbActions.loadDbChildren(CID, SID, { kind: "root" });
    release([DATABASE]);
    await Promise.all([first, second]);

    // One call, not two. A double-click on a chevron is a real gesture and must not double
    // the catalogue queries.
    expect(ipc.dbChildren).toHaveBeenCalledTimes(1);
  });

  it("does not fetch for the saved-query refs, even asked directly", () => {
    state().dbActions.toggleDbNode(CID, SID, { kind: "savedQueries" });
    state().dbActions.toggleDbNode(CID, SID, { kind: "savedQuery", id: "Q1" });
    expect(ipc.dbChildren).not.toHaveBeenCalled();
  });

  it("does not fetch a server level with no session", () => {
    state().dbActions.toggleDbNode(CID, null, { kind: "database", name: "maestro" });
    expect(state().dbTrees[CID]?.expanded[nodeKey({ kind: "database", name: "maestro" })]).toBe(
      true,
    );
    expect(ipc.dbChildren).not.toHaveBeenCalled();
  });
});

/* ─────────────── drag a table to sort it ─────────────── */

/**
 * Tables can be moved into any order the user chooses, for example turning A,B,C into C,B,A.
 *
 * The suite is jsdom, like the five DnD suites that came before it, and it therefore leans on
 * `src/test/dnd.ts` for every event: jsdom implements no `DragEvent`, so RTL falls back to a
 * plain `Event` and silently drops `relatedTarget` — which would make the `dragleave` guard's
 * test pass without the guard existing. The real-pixel half (does the cursor actually pick the
 * row up) belongs to the browser tier and to a look in the running app.
 *
 * Everything below drives the REAL store: the component's job is to call `moveDbTreeNode` with
 * the right level and the right two labels, and the assertions are on what that produced — the
 * arrangement in the store, the write on the wire, and the order of the rows on screen. A spy
 * on the action would prove the first of those three and none of the others.
 */

/** The centre-pane tab drag — a table row must ignore it (distinct MIMEs). */
const TAB_DND_MIME = "application/x-agentstudio-tab";

/** The level whose children are sortable: `public`'s Tables group. */
const TABLES_KEY = nodeKey(TABLES_GROUP.nodeRef);
/** A DIFFERENT level in the same tree — the same schema's Views group. */
const VIEWS_KEY = nodeKey({
  kind: "group",
  database: "maestro",
  schema: "public",
  group: "views",
});

/** Redis's `keys` group: expandable like any other, and deliberately NOT sortable. */
const KEYS_GROUP: DbTreeNode = {
  nodeRef: { kind: "group", database: "0", schema: null, group: "keys" },
  label: "Keys",
  subLabel: "200 keys (truncated)",
  kind: "group",
  expandable: true,
};

const table = (name: string): DbTreeNode => ({
  nodeRef: { kind: "table", database: "maestro", schema: "public", name },
  label: name,
  subLabel: null,
  kind: "table",
  expandable: true,
});

/** Every rendered row's label, top to bottom — the order the user actually sees. */
const labels = (): (string | null)[] =>
  screen.getAllByTestId("db-tree-row").map((el) => el.getAttribute("data-label"));

/**
 * Mount with the Tables group at the ROOT level and open it.
 *
 * The group is answered as a root child rather than reached through database → schema, and
 * that is not a shortcut around the hierarchy: this component hardcodes no shape (its own
 * header, and `tree.rs`'s), so the four levels of clicking would exercise the same one
 * `renderLevel` these tests are about while costing four more `mockResolvedValueOnce`s.
 */
async function openTables(tables: DbTreeNode[] = ["alpha", "beta", "gamma"].map(table)) {
  ipc.dbChildren.mockResolvedValueOnce([TABLES_GROUP]).mockResolvedValueOnce(tables);
  mount();
  await waitFor(() => expect(row("Tables")).toBeInTheDocument());
  fireEvent.click(row("Tables"));
  await waitFor(() => expect(row(tables[0].label)).toBeInTheDocument());
}

/** A drag already in flight from `parentKey`'s level, carrying `label` — the source markers. */
const dragFrom = (parentKey: string, label: string) =>
  makeDataTransfer({
    [DB_NODE_DND_MIME]: label,
    [dbParentType(parentKey)]: "",
    [dbLabelType(label)]: "",
  });

describe("drag-to-reorder: the drag source", () => {
  it("🔴 a table row is a handle, and dragStart writes the label + BOTH markers", async () => {
    await openTables();
    expect(row("alpha")).toHaveAttribute("draggable", "true");

    // A hand-rolled capture object, not `makeDataTransfer`: the claim is about what the
    // HANDLER wrote, so the assertions must read back exactly the calls it made.
    const data = new Map<string, string>();
    const dataTransfer = { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" };
    fireEvent.dragStart(row("alpha"), { dataTransfer });

    // The payload (readable only at drop time) …
    expect(data.get(DB_NODE_DND_MIME)).toBe("alpha");
    // … and the two markers the `dragover` gate reads, because protected mode hides values.
    expect(data.has(dbParentType(TABLES_KEY))).toBe(true);
    expect(data.has(dbLabelType("alpha"))).toBe(true);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(row("alpha")).toHaveClass("db-tree__row--dragging");

    fireEvent.dragEnd(row("alpha"));
    expect(row("alpha")).not.toHaveClass("db-tree__row--dragging");
  });
});

describe("drag-to-reorder: what a row accepts", () => {
  it("🔴 shows the insertion cue and asks for a MOVE for a drag from the same level", async () => {
    await openTables();
    const dt = dragFrom(TABLES_KEY, "gamma");

    fireDragAt(row("alpha"), "dragOver", [40, 60], dt);

    expect(dt.dropEffect).toBe("move");
    expect(row("alpha")).toHaveClass("db-tree__row--drop-target");
  });

  it("🔴 is INERT for a drag from another level — the same-parent gate, both sides", async () => {
    await openTables();

    // Same drag shape, different level marker (this schema's Views). Nothing happens: no
    // `preventDefault` is what tells the browser this row does not take the drop, and the
    // missing `dropEffect` is the readable trace of that.
    const foreign = dragFrom(VIEWS_KEY, "top_artists");
    fireDragAt(row("alpha"), "dragOver", [40, 60], foreign);
    expect(foreign.dropEffect).toBe("");
    expect(row("alpha")).not.toHaveClass("db-tree__row--drop-target");

    // …and the OTHER side, on the same row in the same render: a drag from home is accepted.
    // Without this half the test would pass just as well against a row that accepts nothing.
    const home = dragFrom(TABLES_KEY, "gamma");
    fireDragAt(row("alpha"), "dragOver", [40, 60], home);
    expect(home.dropEffect).toBe("move");
    expect(row("alpha")).toHaveClass("db-tree__row--drop-target");
  });

  it("shows no cue when a row is dragged over ITSELF (a self-drop is a click)", async () => {
    await openTables();
    const dt = dragFrom(TABLES_KEY, "alpha");

    fireDragAt(row("alpha"), "dragOver", [40, 60], dt);

    expect(dt.dropEffect).toBe("");
    expect(row("alpha")).not.toHaveClass("db-tree__row--drop-target");
  });

  it("ignores a foreign drag (a centre-pane tab)", async () => {
    await openTables();
    const dt = makeDataTransfer({ [TAB_DND_MIME]: "t1" });

    fireDragAt(row("alpha"), "dragOver", [40, 60], dt);

    expect(dt.dropEffect).toBe("");
    expect(row("alpha")).not.toHaveClass("db-tree__row--drop-target");
  });

  it("🔴 keeps the cue while the pointer crosses the row's OWN children, drops it on leave", async () => {
    await openTables();
    fireDragAt(row("alpha"), "dragOver", [40, 60], dragFrom(TABLES_KEY, "gamma"));
    expect(row("alpha")).toHaveClass("db-tree__row--drop-target");

    // A `dragleave` whose `relatedTarget` is still inside the row — moving the cursor from the
    // row onto its own label. Without the `contains` guard the cue strobes on every such move.
    fireDragLeave(row("alpha"), row("alpha").querySelector(".db-tree__label") as Node);
    expect(row("alpha")).toHaveClass("db-tree__row--drop-target");

    fireDragLeave(row("alpha"), null);
    expect(row("alpha")).not.toHaveClass("db-tree__row--drop-target");
  });
});

describe("drag-to-reorder: the drop", () => {
  it("🔴 dropping A on B puts A immediately BEFORE B, and persists that level's order", async () => {
    await openTables();

    fireDragAt(row("alpha"), "drop", [40, 60], dragFrom(TABLES_KEY, "gamma"));

    // On screen, in the store, and on the wire — the three places this has to agree.
    expect(labels()).toEqual(["Tables", "gamma", "alpha", "beta"]);
    expect(state().dbTreeOrders[CID]?.[TABLES_KEY]).toEqual(["gamma", "alpha", "beta"]);
    // The connection id and the LEVEL's key are the two arguments a wrong `parentKey` would
    // corrupt silently (it would arrange a level nobody dragged), so both are asserted here.
    expect(ipc.dbTreeOrderSet).toHaveBeenCalledWith(CID, TABLES_KEY, ["gamma", "alpha", "beta"]);
    expect(row("alpha")).not.toHaveClass("db-tree__row--drop-target");
  });

  it("🔴 the reference case, literally: A,B,C → C,B,A in two drags", async () => {
    await openTables();
    expect(labels()).toEqual(["Tables", "alpha", "beta", "gamma"]);

    fireDragAt(row("alpha"), "drop", [40, 60], dragFrom(TABLES_KEY, "gamma"));
    fireDragAt(row("alpha"), "drop", [40, 60], dragFrom(TABLES_KEY, "beta"));

    expect(labels()).toEqual(["Tables", "gamma", "beta", "alpha"]);
  });

  it("refuses a drop from another level even if one arrives without a dragover", async () => {
    await openTables();

    // The belt-and-braces re-check: a fast drag can land a `drop` on a row that never saw a
    // `dragover`, so the parent marker is verified again here rather than trusted.
    fireDragAt(row("alpha"), "drop", [40, 60], dragFrom(VIEWS_KEY, "top_artists"));

    expect(state().dbTreeOrders[CID]?.[TABLES_KEY]).toBeUndefined();
    expect(ipc.dbTreeOrderSet).not.toHaveBeenCalled();
    expect(labels()).toEqual(["Tables", "alpha", "beta", "gamma"]);
  });

  it("a self-drop and an empty payload both reorder nothing", async () => {
    await openTables();

    fireDragAt(row("alpha"), "drop", [40, 60], dragFrom(TABLES_KEY, "alpha"));
    fireDragAt(row("alpha"), "drop", [40, 60], makeDataTransfer({ [DB_NODE_DND_MIME]: "" }));

    expect(ipc.dbTreeOrderSet).not.toHaveBeenCalled();
    expect(labels()).toEqual(["Tables", "alpha", "beta", "gamma"]);
  });

  it("ignores a drop that is not a DB-node drag at all", async () => {
    await openTables();

    fireDragAt(row("alpha"), "drop", [40, 60], makeDataTransfer({ [TAB_DND_MIME]: "t1" }));

    expect(ipc.dbTreeOrderSet).not.toHaveBeenCalled();
    expect(labels()).toEqual(["Tables", "alpha", "beta", "gamma"]);
  });
});

describe("drag-to-reorder: what is NOT sortable", () => {
  it("🔴 a COLUMN row is neither a handle nor a target — its order is the real one", async () => {
    // Columns arrive under their TABLE's ref, and their sequence is the ordinal position the
    // server reports: what `SELECT *` returns and what an `INSERT … VALUES` lines up with.
    // A UI that let someone "sort" it would be showing a lie about the table.
    ipc.dbChildren.mockResolvedValueOnce([TRACKS]).mockResolvedValueOnce(COLUMNS);
    mount();
    await waitFor(() => expect(row("tracks")).toBeInTheDocument());
    fireEvent.click(row("tracks"));
    await waitFor(() => expect(row("id")).toBeInTheDocument());

    expect(row("id")).toHaveAttribute("draggable", "false");
    // Source side: dragStart writes nothing at all, so no drop anywhere can be built from it.
    const data = new Map<string, string>();
    fireEvent.dragStart(row("id"), {
      dataTransfer: { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" },
    });
    expect(data.size).toBe(0);
    // Target side: it refuses a drag from its own level too — the gate is two-sided, and the
    // half nobody notices is the one that reorders the wrong level.
    const dt = dragFrom(nodeKey(TRACKS.nodeRef), "tag");
    fireDragAt(row("id"), "dragOver", [40, 60], dt);
    expect(dt.dropEffect).toBe("");
    expect(row("id")).not.toHaveClass("db-tree__row--drop-target");
    // …including a drop that arrives anyway (a synthetic event, or a drag whose `dragover` the
    // browser never delivered): an ineligible row writes no arrangement for its level.
    fireDragAt(row("id"), "drop", [40, 60], dt);
    expect(ipc.dbTreeOrderSet).not.toHaveBeenCalled();
    expect(state().dbTreeOrders[CID]?.[nodeKey(TRACKS.nodeRef)]).toBeUndefined();
  });

  it("🔴 a Redis KEY row is not sortable — the keyspace is dynamic and truncated", async () => {
    ipc.dbChildren
      .mockResolvedValueOnce([KEYS_GROUP])
      .mockResolvedValueOnce([
        { ...TRACKS, nodeRef: KEYS_GROUP.nodeRef, label: "user:1", kind: "key", expandable: false },
      ]);
    render(<DbTree connectionId={CID} family="redis" rowLimit={500} sessionId={SID} />);
    await waitFor(() => expect(row("Keys")).toBeInTheDocument());
    fireEvent.click(row("Keys"));
    await waitFor(() => expect(row("user:1")).toBeInTheDocument());

    expect(row("user:1")).toHaveAttribute("draggable", "false");
    const dt = dragFrom(nodeKey(KEYS_GROUP.nodeRef), "user:2");
    fireDragAt(row("user:1"), "dragOver", [40, 60], dt);
    expect(dt.dropEffect).toBe("");
    expect(row("user:1")).not.toHaveClass("db-tree__row--drop-target");
    // And the group row itself offers no reset, because the level below it can never be
    // arranged in the first place.
    expect(screen.queryByTestId("db-tree-reset-order")).toBeNull();
  });

  it("a SCHEMA row is not a handle either — a level of containers, not a wall of names", async () => {
    ipc.dbChildren.mockResolvedValueOnce([DATABASE]).mockResolvedValueOnce([SCHEMA]);
    mount();
    await waitFor(() => expect(row("maestro")).toBeInTheDocument());
    fireEvent.click(row("maestro"));
    await waitFor(() => expect(row("public")).toBeInTheDocument());

    expect(row("maestro")).toHaveAttribute("draggable", "false");
    expect(row("public")).toHaveAttribute("draggable", "false");
  });
});

describe("the saved arrangement", () => {
  it("🔴 is READ on mount, so the order survives a restart", async () => {
    // The whole feature's difference between "works all afternoon" and "works": without this
    // read `dbTreeOrders` only ever holds what this session's own drags put there, and the
    // tree comes back alphabetical after a relaunch.
    ipc.dbTreeOrder.mockResolvedValue([
      { connectionId: CID, parentKey: TABLES_KEY, keys: ["gamma", "beta", "alpha"] },
    ]);
    await openTables();

    expect(ipc.dbTreeOrder).toHaveBeenCalledTimes(1);
    expect(ipc.dbTreeOrder).toHaveBeenCalledWith(CID);
    expect(labels()).toEqual(["Tables", "gamma", "beta", "alpha"]);
  });

  it("is read even with NO session — an arrangement is the user's, not the server's", async () => {
    mount(null);
    await waitFor(() => expect(ipc.dbTreeOrder).toHaveBeenCalledWith(CID));
    expect(ipc.dbChildren).not.toHaveBeenCalled();
  });

  it("renders the engine's own order when nobody has arranged the level", async () => {
    await openTables();
    expect(labels()).toEqual(["Tables", "alpha", "beta", "gamma"]);
  });

  it("🔴 puts a table the order does not name at the BOTTOM — never drops it", async () => {
    // The "the IDE lost my table" case: a `CREATE TABLE` between two launches leaves a saved
    // order that names only some of the level. `applyOrder` appends the rest.
    ipc.dbTreeOrder.mockResolvedValue([
      { connectionId: CID, parentKey: TABLES_KEY, keys: ["gamma", "alpha"] },
    ]);
    await openTables();

    expect(labels()).toEqual(["Tables", "gamma", "alpha", "beta"]);
  });
});

describe("the reset affordance", () => {
  it("is absent until the level has actually been arranged", async () => {
    await openTables();
    expect(screen.queryByTestId("db-tree-reset-order")).toBeNull();
  });

  it("🔴 appears on the GROUP row once arranged, and puts the level back to alphabetical", async () => {
    await openTables();
    fireDragAt(row("alpha"), "drop", [40, 60], dragFrom(TABLES_KEY, "gamma"));
    expect(labels()).toEqual(["Tables", "gamma", "alpha", "beta"]);

    // A button, not a right-click item — this panel's house style (`DbPanel.tsx`), and the DB
    // tree has no context menu to hang one on.
    const reset = screen.getByRole("button", { name: "Reset order of Tables" });
    expect(reset).toBe(screen.getByTestId("db-tree-reset-order"));
    ipc.dbTreeOrderSet.mockClear();
    fireEvent.click(reset);

    // Back to the engine's order — and note that this same assertion is what proves the level
    // is still OPEN: the group row's click is its disclosure, so a reset that forgot
    // `stopPropagation` would collapse the thing the user was looking at and leave one row.
    expect(labels()).toEqual(["Tables", "alpha", "beta", "gamma"]);
    expect(state().dbTreeOrders[CID]?.[TABLES_KEY]).toBeUndefined();
    // An empty `keys` IS the clear on disk — one command for both gestures.
    expect(ipc.dbTreeOrderSet).toHaveBeenCalledWith(CID, TABLES_KEY, []);
    // The affordance goes with the arrangement it undoes.
    expect(screen.queryByTestId("db-tree-reset-order")).toBeNull();
  });
});
