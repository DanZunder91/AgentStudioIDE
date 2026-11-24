/**
 * The `db` store slice — load, upsert, delete, connect, disconnect, and the tab.
 *
 * `dbIpc` is mocked at the module boundary, the way `collections.store.test.ts` mocks
 * `apiStoreIpc`: every one of these actions IS an IPC call plus a reduction, and the point
 * of the tests is the pairing — that the effect happens in the WRAPPER and only the result
 * lands in state.
 *
 * The invariant these tests exist to defend, over and above the reducers: **the DB store is
 * written by Rust, not mirrored here.** There is no `persistDbStore` counterpart to
 * `persistApiStore`, and there must not be: `db_connection_upsert` is the only writer
 * because it is the thing that validates, splits credentials out of a raw URL server-side,
 * and mints the Vault variable. A store that could write the file could write a
 * password into it. So "persistence fires in the wrapper" is asserted as *the upsert IPC
 * fires in the wrapper and its returned record is what state adopts*.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbIpc = vi.hoisted(() => ({
  connectionInput: vi.fn((draft: unknown, id: unknown) => ({
    ...(draft as object),
    id,
  })),
  connectionAsInput: vi.fn((c: { id: string }) => ({ ...c, caPath: null })),
  dbEngines: vi.fn(),
  dbConnectionsLoad: vi.fn(),
  dbConnectionUpsert: vi.fn(),
  dbConnectionDelete: vi.fn(),
  dbTestConnection: vi.fn(),
  dbOpen: vi.fn(),
  dbClose: vi.fn(),
  dbTreeOrder: vi.fn(),
  dbTreeOrderSet: vi.fn(),
}));
vi.mock("./dbIpc", () => dbIpc);

import { DB_ALREADY_GONE_NOTE, useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { describeDbError } from "./dbErrors";
import { POSTGRES_ENGINE, REDIS_ENGINE } from "./dbFixtures";
import type { DbConnection, DbConnectionDraft } from "./types";

const db = () => useAppStore.getState().dbActions;
const state = () => useAppStore.getState();

const DRAFT: DbConnectionDraft = {
  name: "Prod Postgres",
  engine: "postgres",
  family: "postgres",
  host: "db.internal",
  port: 5432,
  database: "maestro",
  user: "ro",
  passwordRef: "",
  savePassword: "forever",
  url: null,
  srv: false,
  passwordParam: null,
  sslMode: "prefer",
  caSummary: null,
  options: {},
  readOnly: true,
  rowLimit: 500,
  timeoutMs: 30_000,
  allowMultiStatement: false,
};

const conn = (over: Partial<DbConnection> = {}): DbConnection => ({
  ...DRAFT,
  id: "c1",
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

/** What `db_open` returns: the session AND what answered, in one dial. */
const OPENED = {
  sessionId: "sess-a",
  serverVersion: "PostgreSQL 17.2",
  latencyMs: 34,
};

beforeEach(() => {
  resetStore();
  for (const fn of Object.values(dbIpc)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  dbIpc.connectionInput.mockImplementation((draft, id) => ({
    ...(draft as object),
    id,
  }));
  dbIpc.connectionAsInput.mockImplementation((c) => ({ ...c, caPath: null }));
  dbIpc.dbEngines.mockResolvedValue([POSTGRES_ENGINE]);
  dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [], version: 1 });
  dbIpc.dbClose.mockResolvedValue(undefined);
  // The whole module is replaced, so an un-mocked export is `undefined` and any action that
  // reaches it dies with a TypeError rather than a readable assertion. These two are called
  // fire-and-forget by the ordering actions.
  dbIpc.dbTreeOrder.mockResolvedValue([]);
  dbIpc.dbTreeOrderSet.mockResolvedValue(undefined);
});

/* ─────────────────────────────── loading ─────────────────────────────────── */

describe("loadDbStore", () => {
  it("reads the registry and the connections together, and marks the slice loaded", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });

    await db().loadDbStore();

    expect(state().dbEngines).toEqual([POSTGRES_ENGINE]);
    expect(state().dbConnections).toEqual([conn()]);
    expect(state().dbLoaded).toBe(true);
    expect(state().dbError).toBeNull();
  });

  it("is a one-shot: a second call does not refetch", async () => {
    await db().loadDbStore();
    await db().loadDbStore();
    expect(dbIpc.dbEngines).toHaveBeenCalledTimes(1);
    expect(dbIpc.dbConnectionsLoad).toHaveBeenCalledTimes(1);
  });

  it("maps a failure to one sentence and does NOT latch loaded, so the next mount retries", async () => {
    dbIpc.dbConnectionsLoad.mockRejectedValue("unknown: could not read the store file");

    await db().loadDbStore();

    // Mapped, never Rust's string — a driver/IO detail can carry a path or a DSN.
    expect(state().dbError).toBe(describeDbError("unknown"));
    // Retry, never a sticky failure: a transient read must not become a dead end.
    expect(state().dbLoaded).toBe(false);
    expect(state().dbConnections).toEqual([]);

    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
    await db().loadDbStore();
    expect(state().dbLoaded).toBe(true);
    expect(state().dbError).toBeNull();
  });

  it("never rejects — a panel that throws on mount takes the rail down with it", async () => {
    dbIpc.dbEngines.mockRejectedValue(new Error("no backend"));
    await expect(db().loadDbStore()).resolves.toBeUndefined();
  });
});

describe("hydrateDbStore", () => {
  it("is the READ side: it applies and clears the error, and calls no IPC", () => {
    useAppStore.setState((s) => {
      s.dbError = "stale";
    });

    db().hydrateDbStore([POSTGRES_ENGINE, REDIS_ENGINE], {
      connections: [conn()],
      version: 3,
    });

    expect(state().dbEngines).toHaveLength(2);
    expect(state().dbConnections).toEqual([conn()]);
    expect(state().dbLoaded).toBe(true);
    expect(state().dbError).toBeNull();
    // Nothing is written back: this IS what Rust just handed us.
    expect(dbIpc.dbConnectionUpsert).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────── upsert ──────────────────────────────────── */

describe("upsertDbConnection", () => {
  it("sends the draft and the password as SEPARATE arguments and adopts Rust's record", async () => {
    const saved = conn({ id: "minted-by-rust", createdAt: 111, updatedAt: 222 });
    dbIpc.dbConnectionUpsert.mockResolvedValue(saved);

    await expect(db().upsertDbConnection(DRAFT, "hunter2", null)).resolves.toEqual(saved);

    // The IPC is the persistence effect, and it ran in the WRAPPER — the record only
    // reaches state after Rust has validated, split and written it.
    expect(dbIpc.dbConnectionUpsert).toHaveBeenCalledTimes(1);
    const [input, password] = dbIpc.dbConnectionUpsert.mock.calls[0];
    expect(password).toBe("hunter2");
    // The secret is not inside the record — asserted on the serialised input, because a
    // type cannot fail at runtime.
    expect(JSON.stringify(input)).not.toContain("hunter2");
    expect(state().dbConnections).toEqual([saved]);
    // …and the id/timestamps are RUST's, not sentinels the dialog invented.
    expect(state().dbConnections[0].id).toBe("minted-by-rust");
    expect(state().dbConnections[0].createdAt).toBe(111);
  });

  it("stores no password anywhere in the slice", async () => {
    dbIpc.dbConnectionUpsert.mockResolvedValue(conn());
    await db().upsertDbConnection(DRAFT, "hunter2", null);
    const {
      dbEngines: _e,
      dbConnections,
      dbSessions,
      dbDialog,
      dbError,
    } = state();
    expect(JSON.stringify({ dbConnections, dbSessions, dbDialog, dbError })).not.toContain(
      "hunter2",
    );
  });

  it("replaces an edited connection IN PLACE rather than appending a second", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], {
      connections: [conn({ id: "a", name: "A" }), conn({ id: "b", name: "B" })],
      version: 1,
    });
    dbIpc.dbConnectionUpsert.mockResolvedValue(conn({ id: "a", name: "A renamed" }));

    await db().upsertDbConnection(DRAFT, "", "a");

    // Order preserved: an edit that jumped to the bottom of the list is a UI that loses
    // the user's place every time they fix a typo.
    expect(state().dbConnections.map((c) => c.name)).toEqual(["A renamed", "B"]);
    expect(dbIpc.dbConnectionUpsert.mock.calls[0][0]).toMatchObject({ id: "a" });
  });

  it("rejects with a MAPPED sentence, keeps the list untouched, and carries the cause", async () => {
    dbIpc.dbConnectionUpsert.mockRejectedValue(
      "invalid-config: Port must be a whole number from 1 to 65535.",
    );

    await expect(db().upsertDbConnection(DRAFT, "", null)).rejects.toThrow(
      describeDbError("invalid-config"),
    );
    // A failed save must not half-apply.
    expect(state().dbConnections).toEqual([]);

    // The original is on `cause` for diagnostics — Rust redacts before it rejects — but the
    // MESSAGE, which is the only thing the dialog renders, is ours.
    const err: Error = await db()
      .upsertDbConnection(DRAFT, "", null)
      .then(() => new Error("the upsert should have rejected"))
      .catch((e: unknown) => e as Error);
    expect(err.message).toBe(describeDbError("invalid-config"));
    expect(err.cause).toBe("invalid-config: Port must be a whole number from 1 to 65535.");
  });
});

/* ─────────────────────────────── delete ──────────────────────────────────── */

describe("upsertDbConnection — an edit invalidates the live session", () => {
  /**
   * THE bug: after the database URL was edited, a query console
   * opened afterwards still used the old URL. The record was updated and the SESSION was not, and
   * `DbConsoleTab` reads the session — so the console kept every query on the socket dialled
   * from the old host while the row displayed the new one.
   */
  it("drops the session mirror and the cached subtree, so the console reconnects on the NEW record", async () => {
    const before = conn({ id: "a", host: "old-host" });
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [before], version: 1 });
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    await db().openDbSession("a");
    useAppStore.setState((s) => ({
      dbTrees: { ...s.dbTrees, a: { nodes: [], loading: false, error: null } },
    }));
    expect(state().dbSessions.a.status).toBe("open");

    const after = { ...before, host: "new-host" };
    dbIpc.dbConnectionUpsert.mockResolvedValue(after);
    await db().upsertDbConnection(DRAFT, "", "a");

    expect(state().dbConnections).toEqual([after]);
    // The two that MUST go: the console asks the mirror whether it is connected, and every
    // ref in the cached subtree addresses a session id that is now invalid.
    expect(state().dbSessions.a).toBeUndefined();
    expect(state().dbTrees.a).toBeUndefined();
  });

  it("keeps the console text and the saved queries — an edit is not a delete", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    useAppStore.getState().layoutActions.openDbConsoleTab("a");
    db().setDbConsoleText("a", "select 1");
    useAppStore.setState((s) => ({
      dbSavedQueries: { ...s.dbSavedQueries, a: { queries: [], loading: false, error: null } },
    }));

    dbIpc.dbConnectionUpsert.mockResolvedValue(conn({ id: "a", host: "new-host" }));
    await db().upsertDbConnection(DRAFT, "", "a");

    // Two-sided: dropping the session must not take the user's unsaved work
    // with it. `deleteDbConnection` drops both of these; an edit must not.
    expect(state().dbConsoles.a?.text).toBe("select 1");
    expect(state().dbSavedQueries.a).toBeDefined();
  });

  it("keeps the hand-arranged table order — it is a preference, not server state", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    useAppStore.setState((s) => ({
      dbTreeOrders: { ...s.dbTreeOrders, a: { '["group","g","public","tables"]': ["z", "a"] } },
    }));

    dbIpc.dbConnectionUpsert.mockResolvedValue(conn({ id: "a", host: "new-host" }));
    await db().upsertDbConnection(DRAFT, "", "a");

    // A decision, not an oversight. Correcting a typo in a URL must not
    // silently discard an arrangement the user built by hand; stale table names are skipped
    // by `applyOrder`, so a genuinely different host costs nothing either.
    expect(state().dbTreeOrders.a).toEqual({ '["group","g","public","tables"]': ["z", "a"] });
  });

  it("leaves a NEW connection's state alone — there is no session to invalidate", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    await db().openDbSession("a");

    dbIpc.dbConnectionUpsert.mockResolvedValue(conn({ id: "b" }));
    await db().upsertDbConnection(DRAFT, "", null);

    // Creating `b` must not disconnect `a`: the invalidation is keyed on the saved id, and a
    // blanket "any save drops every session" would be a different, worse bug.
    expect(state().dbSessions.a.status).toBe("open");
    expect(state().dbConnections.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("the hand-arranged table order", () => {
  const CID = "a";
  const LVL = '["group","g","public","tables"]';
  const node = (label: string) => ({ label, nodeRef: { kind: "table" }, kind: "table" });

  /** Seed a loaded level of three tables in the engines' alphabetical order. */
  const seedLevel = () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: CID })], version: 1 });
    useAppStore.setState((s) => ({
      dbTrees: {
        ...s.dbTrees,
        [CID]: {
          children: { [LVL]: [node("a"), node("b"), node("c")] },
          loading: {},
          failed: {},
          expanded: {},
        },
      },
    }));
  };

  it("hydrates the saved levels, keyed by parent", async () => {
    dbIpc.dbTreeOrder.mockResolvedValue([
      { connectionId: CID, parentKey: LVL, keys: ["c", "b", "a"] },
    ]);
    await db().loadDbTreeOrder(CID);
    expect(state().dbTreeOrders[CID]).toEqual({ [LVL]: ["c", "b", "a"] });
  });

  it("leaves the orders empty when the file cannot be read, rather than surfacing an error", async () => {
    dbIpc.dbTreeOrder.mockRejectedValue("unknown: no such file");
    await db().loadDbTreeOrder(CID);
    // A preference file that will not read means "nobody has dragged anything", which renders
    // alphabetically — the behaviour that existed before the feature. An error banner about it
    // would be noise the user cannot act on.
    expect(state().dbTreeOrders[CID]).toBeUndefined();
    expect(state().dbError).toBeNull();
  });

  it("A,B,C → C,B,A in two drags, and persists the result", async () => {
    seedLevel();
    // The reference example. Drop C before A, then B before A.
    db().moveDbTreeNode(CID, LVL, "c", "a");
    db().moveDbTreeNode(CID, LVL, "b", "a");
    expect(state().dbTreeOrders[CID][LVL]).toEqual(["c", "b", "a"]);
    expect(dbIpc.dbTreeOrderSet).toHaveBeenLastCalledWith(CID, LVL, ["c", "b", "a"]);
  });

  it("writes nothing when the drag put the row back where it started", () => {
    seedLevel();
    // "b" dropped before "c" is exactly where b already is.
    db().moveDbTreeNode(CID, LVL, "b", "c");
    expect(dbIpc.dbTreeOrderSet).not.toHaveBeenCalled();
    expect(state().dbTreeOrders[CID]?.[LVL]).toBeUndefined();
  });

  it("moves to the end when there is no row to land before", () => {
    seedLevel();
    db().moveDbTreeNode(CID, LVL, "a", null);
    expect(state().dbTreeOrders[CID][LVL]).toEqual(["b", "c", "a"]);
  });

  it("is inert for a level whose children are not cached", () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: CID })], version: 1 });
    db().moveDbTreeNode(CID, LVL, "a", "b");
    // Nothing is displayed, so there is no order to derive — and inventing one from a label
    // the tree has never seen would write an arrangement the user never made.
    expect(dbIpc.dbTreeOrderSet).not.toHaveBeenCalled();
  });

  it("keeps the arrangement on screen when the write fails", async () => {
    seedLevel();
    dbIpc.dbTreeOrderSet.mockRejectedValue("unknown: disk full");
    db().moveDbTreeNode(CID, LVL, "c", "a");
    await Promise.resolve();
    await Promise.resolve();
    // Optimistic and deliberately quiet: the row is already where the user dropped it, and a
    // failed write to a preference file is not something they can act on mid-drag. It comes
    // back alphabetical next launch, which is honest about what was actually saved.
    expect(state().dbTreeOrders[CID][LVL]).toEqual(["c", "a", "b"]);
    expect(state().dbError).toBeNull();
  });

  it("reset forgets the level and persists the empty order", () => {
    seedLevel();
    db().moveDbTreeNode(CID, LVL, "c", "a");
    db().resetDbTreeOrder(CID, LVL);
    expect(state().dbTreeOrders[CID][LVL]).toBeUndefined();
    // An empty `keys` IS the clear — one command for both gestures, so "no custom order" has
    // exactly one representation on disk.
    expect(dbIpc.dbTreeOrderSet).toHaveBeenLastCalledWith(CID, LVL, []);
  });

  it("reset on a level that was never arranged still clears the file", async () => {
    seedLevel();
    dbIpc.dbTreeOrderSet.mockRejectedValue("unknown: disk full");
    db().resetDbTreeOrder(CID, LVL);
    await Promise.resolve();
    await Promise.resolve();
    // Reaches Rust even with nothing in memory: our mirror can be the stale one (another
    // window, a previous run), and the reset the user pressed must still land.
    expect(dbIpc.dbTreeOrderSet).toHaveBeenCalledWith(CID, LVL, []);
    expect(state().dbError).toBeNull();
  });
});

describe("deleteDbConnection", () => {
  it("removes the connection and its session mirror when Rust reports it removed", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], {
      connections: [conn({ id: "a" }), conn({ id: "b" })],
      version: 1,
    });
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    await db().openDbSession("a");
    expect(state().dbSessions.a.status).toBe("open");

    dbIpc.dbConnectionDelete.mockResolvedValue({ removed: true, savedQueriesRemoved: 2 });
    await db().deleteDbConnection("a");

    expect(dbIpc.dbConnectionDelete).toHaveBeenCalledWith("a");
    expect(state().dbConnections.map((c) => c.id)).toEqual(["b"]);
    // Rust cascades the close, so the mirror must go with the record or the row would
    // claim a live session for a connection that no longer exists.
    expect(state().dbSessions.a).toBeUndefined();
    expect(state().dbError).toBeNull();
  });

  it("drops the hand-arranged table order too — Rust cascades it on disk", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], {
      connections: [conn({ id: "a" }), conn({ id: "b" })],
      version: 1,
    });
    useAppStore.setState((s) => ({
      dbTreeOrders: { ...s.dbTreeOrders, a: { lvl: ["z", "a"] }, b: { lvl: ["q"] } },
    }));
    dbIpc.dbConnectionDelete.mockResolvedValue({ removed: true, savedQueriesRemoved: 0 });

    await db().deleteDbConnection("a");

    // Two-sided: the deleted connection's arrangement goes, the survivor's
    // stays. A cascade that took every connection's order with it would be the worse bug.
    expect(state().dbTreeOrders.a).toBeUndefined();
    expect(state().dbTreeOrders.b).toEqual({ lvl: ["q"] });
  });

  it("says so when there was nothing to delete, instead of a silent disappearance", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbConnectionDelete.mockResolvedValue({ removed: false, savedQueriesRemoved: 0 });

    await db().deleteDbConnection("a");

    // The row goes either way (our list was stale — the filter IS the repair), so without
    // the note a stale list is indistinguishable from a successful delete.
    expect(state().dbConnections).toEqual([]);
    expect(state().dbError).toBe(DB_ALREADY_GONE_NOTE);
  });

  it("maps a failure and keeps the connection, because it was not deleted", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbConnectionDelete.mockRejectedValue("unknown: could not save the connection list");

    await db().deleteDbConnection("a");

    expect(state().dbConnections.map((c) => c.id)).toEqual(["a"]);
    expect(state().dbError).toBe(describeDbError("unknown"));
  });
});

/* ────────────────────────── connect / disconnect ─────────────────────────── */

describe("openDbSession", () => {
  it("🔴 opens in ONE dial and records the version and latency it returned", async () => {
    // This used to assert a PROBE followed by an OPEN — two complete dials, two TLS handshakes,
    // two authentications, the first connection discarded, purely to learn the server version.
    // Against a remote Atlas cluster that roughly doubled the time to open. `db_open` now returns
    // what answered.
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbOpen.mockResolvedValue(OPENED);

    await db().openDbSession("a");

    // ONE call, and `password: null` — a saved `{{VAR}}` is resolved from the Vault inside Rust,
    // so no secret crosses the boundary.
    expect(dbIpc.dbOpen).toHaveBeenCalledTimes(1);
    expect(dbIpc.dbOpen).toHaveBeenCalledWith("a", null);
    // 🔴 The second dial is GONE, not merely reordered.
    expect(dbIpc.dbTestConnection).not.toHaveBeenCalled();
    expect(state().dbSessions.a).toEqual({
      status: "open",
      sessionId: "sess-a",
      // The version AND the latency: anything less does not distinguish "connected" from
      // "a socket opened".
      serverVersion: "PostgreSQL 17.2",
      latencyMs: 34,
      error: null,
    });
  });

  it("marks the row `opening` before it awaits anything", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    let release!: (v: typeof OPENED) => void;
    dbIpc.dbOpen.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const pending = db().openDbSession("a");
    expect(state().dbSessions.a).toEqual({
      status: "opening",
      sessionId: null,
      serverVersion: null,
      latencyMs: null,
      error: null,
    });
    release(OPENED);
    await pending;
    expect(state().dbSessions.a.status).toBe("open");
  });

  it("shows Rust's OWN prose for a failed open, not a sentence mapped from the code", async () => {
    // Rewritten with the one-dial change. It used to be "does NOT open a session it
    // already knows will fail" — a property of the probe-then-open shape, which no longer exists:
    // there is only the open, so there is nothing to skip. What had to be PRESERVED is the message
    // quality, because the probe path rendered `DbTestResult.error` verbatim while a rejection is
    // ordinarily reduced to its code. `db_open` rejects with the same `DbError.message` that
    // `test_connection` copies into that field, so the detail is exactly as safe and strictly more
    // specific.
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbOpen.mockRejectedValue("network: Could not reach db.internal on port 5432.");

    await db().openDbSession("a");

    expect(state().dbSessions.a).toEqual({
      status: "error",
      sessionId: null,
      // No stale version or latency next to a failure — that is the cheapest kind of lie.
      serverVersion: null,
      latencyMs: null,
      error: "Could not reach db.internal on port 5432.",
    });
    // …and specifically NOT the generic sentence the code alone would produce.
    expect(state().dbSessions.a.error).not.toBe(describeDbError("network"));
  });

  it("falls back to a sentence of its own when the rejection carried no reason", async () => {
    // The same property the old "a failed probe reported no reason" case protected — never a blank
    // error pane — reached through the shape that exists now: a bare code with no detail. The
    // fallback text changed with the mechanism (it is `dbErrors`' sentence for the code rather than
    // `TEST_FAILED_FALLBACK`), and that is the point of asserting it rather than deleting the case.
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbOpen.mockRejectedValue("network");

    await db().openDbSession("a");

    expect(state().dbSessions.a.error).toBe(describeDbError("network"));
    expect(state().dbSessions.a.error).not.toBe("");
  });

  it("maps a rejection from either call, and never rejects itself", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });

    // 🔴 A failed open now renders **Rust's own sentence**, not our code→sentence mapping. That is
    // what keeps the one-dial change from costing diagnosis quality: the probe path used to show
    // `DbTestResult.error` verbatim, and a `db_open` rejection carries the SAME `DbError.message`.
    dbIpc.dbOpen.mockRejectedValue(
      "network: Nothing is listening there — check the host and the port.",
    );
    await expect(db().openDbSession("a")).resolves.toBeUndefined();
    expect(state().dbSessions.a.error).toBe(
      "Nothing is listening there — check the host and the port.",
    );

    // A rejection with no detail falls back to our sentence for the code, so the pane is never blank.
    dbIpc.dbOpen.mockRejectedValue("network");
    await db().openDbSession("a");
    expect(state().dbSessions.a.error).toBe(describeDbError("network"));

    dbIpc.dbOpen.mockRejectedValue("secret-missing: {{PG_PASSWORD}}");
    await db().openDbSession("a");
    expect(state().dbSessions.a).toEqual({
      status: "error",
      sessionId: null,
      serverVersion: null,
      latencyMs: null,
      error: "{{PG_PASSWORD}}",
    });
  });

  it("reports an unknown connection id rather than dialling anything", async () => {
    await db().openDbSession("nope");
    expect(dbIpc.dbTestConnection).not.toHaveBeenCalled();
    expect(state().dbSessions.nope.error).toBe(describeDbError("not-found"));
  });

  it("records the version and latency the OPEN reported, whatever engine answered", async () => {
    // Was "keeps a null latency out of the record rather than inventing one" — a `DbTestResult`
    // property (its latency is null when the server was never reached). `DbOpened` only exists on
    // success and always carries a measured number, so the null case it guarded cannot arise; what
    // is worth keeping is that both values come from the wire rather than being invented here.
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbOpen.mockResolvedValue({
      sessionId: "sess-a",
      serverVersion: "Redis 7.4",
      latencyMs: 5000,
    });

    await db().openDbSession("a");
    expect(state().dbSessions.a.serverVersion).toBe("Redis 7.4");
    // A measured Atlas number, as it happens — and the reason this change exists.
    expect(state().dbSessions.a.latencyMs).toBe(5000);
  });
});

describe("closeDbSession", () => {
  it("drops the mirror immediately, then closes Rust's session by its id", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    await db().openDbSession("a");

    const pending = db().closeDbSession("a");
    // Dropped BEFORE the round trip: a row that stays "open" while a close is in flight
    // invites a second click on a session that is already going away.
    expect(state().dbSessions.a).toBeUndefined();
    await pending;
    expect(dbIpc.dbClose).toHaveBeenCalledWith("sess-a");
  });

  it("calls nothing for a connection that was never connected", async () => {
    await db().closeDbSession("a");
    expect(dbIpc.dbClose).not.toHaveBeenCalled();
    expect(state().dbSessions.a).toBeUndefined();
  });

  it("calls nothing when the session never got an id (the connect failed)", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbTestConnection.mockResolvedValue({
      ok: false,
      serverVersion: null,
      latencyMs: null,
      error: "nope",
    });
    await db().openDbSession("a");

    await db().closeDbSession("a");
    expect(dbIpc.dbClose).not.toHaveBeenCalled();
  });

  it("swallows a failed close — the only swallow in the slice, and it has nothing to say", async () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    await db().openDbSession("a");
    dbIpc.dbClose.mockRejectedValue("unknown: transport gone");

    // `db_close` is idempotent and returns no error of its own, so a rejection means the
    // transport died — at which point the session is unreachable anyway, our state already
    // says closed, and there is no action for the user to take.
    await expect(db().closeDbSession("a")).resolves.toBeUndefined();
    expect(state().dbError).toBeNull();
    expect(state().dbSessions.a).toBeUndefined();
  });
});

/* ─────────────────────────────── the dialog ──────────────────────────────── */

describe("openDbDialog / closeDbDialog", () => {
  it("opens for a NEW connection with a null id", () => {
    db().openDbDialog(null);
    expect(state().dbDialog).toEqual({ connectionId: null });
  });

  it("opens for an existing connection by id, and closes back to null", () => {
    db().openDbDialog("c1");
    expect(state().dbDialog).toEqual({ connectionId: "c1" });
    db().closeDbDialog();
    expect(state().dbDialog).toBeNull();
  });
});

/* ───────────────────────────── the console tab ───────────────────────────── */

describe("openDbConsoleTab", () => {
  const layout = () => useAppStore.getState().layoutActions;

  it("opens a db-console tab titled with the connection's name", () => {
    db().hydrateDbStore([POSTGRES_ENGINE], {
      connections: [conn({ id: "a", name: "Prod Postgres" })],
      version: 1,
    });

    const tabId = layout().openDbConsoleTab("a");
    const tab = useAppStore.getState().tabs[tabId];

    expect(tab.kind).toBe("db-console");
    expect(tab.ref).toEqual({ kind: "db-console", connectionId: "a" });
    expect(tab.title).toBe("Prod Postgres");
    // Activated in the focused leaf, like every other tab-opening action.
    const leaf = useAppStore.getState().layout;
    expect(leaf.type === "leaf" && leaf.activeTabId).toBe(tabId);
  });

  it("dedupes by connectionId — one console per connection, so one session", () => {
    db().hydrateDbStore([POSTGRES_ENGINE], { connections: [conn({ id: "a" })], version: 1 });

    const first = layout().openDbConsoleTab("a");
    const second = layout().openDbConsoleTab("a");

    // A second console on the same connection would be two views of ONE session, which is
    // how a read-only badge and a running query end up disagreeing.
    expect(second).toBe(first);
    expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(1);
  });

  it("opens a separate console for a different connection", () => {
    db().hydrateDbStore([POSTGRES_ENGINE], {
      connections: [conn({ id: "a", name: "A" }), conn({ id: "b", name: "B" })],
      version: 1,
    });
    const a = layout().openDbConsoleTab("a");
    const b = layout().openDbConsoleTab("b");
    expect(b).not.toBe(a);
    expect(useAppStore.getState().tabs[b].title).toBe("B");
  });

  it("titles a console for an unloaded connection honestly rather than blank", () => {
    // Reachable: the tab is openable before `loadDbStore` has resolved (the console runs
    // `openDbSession` itself on mount), and an empty tab title is unclickable chrome.
    const tabId = layout().openDbConsoleTab("not-loaded-yet");
    expect(useAppStore.getState().tabs[tabId].title).toBe("Database");
  });
});
