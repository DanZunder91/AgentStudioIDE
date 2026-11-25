import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbIpc = vi.hoisted(() => ({
  connectionInput: vi.fn(),
  connectionAsInput: vi.fn(),
  dbEngines: vi.fn(),
  dbConnectionsLoad: vi.fn(),
  dbConnectionUpsert: vi.fn(),
  dbConnectionDelete: vi.fn(),
  dbTestConnection: vi.fn(),
  dbOpen: vi.fn(),
  dbClose: vi.fn(),
  dbCancel: vi.fn(),
  dbUrlBuild: vi.fn(),
  dbUrlParse: vi.fn(),
  dbQuery: vi.fn(),
  dbChildren: vi.fn(),
  dbSavedQueries: vi.fn(),
  dbSavedQueryUpsert: vi.fn(),
  dbSavedQueryDelete: vi.fn(),
  dbTreeOrder: vi.fn(),
  dbTreeOrderSet: vi.fn(),
}));
vi.mock("../../db/dbIpc", () => dbIpc);

import { blankDbConsole, useAppStore } from "../../../app/store";
import { resetStore } from "../../../test/store-harness";
import { POSTGRES_ENGINE } from "../../db/dbFixtures";
import type { DbConnection, DbResultSet } from "../../db/types";
import { dispatchAgentCtl } from "../dispatch";
import { agentRunNote, agentWho, runOutcome } from "./db";

const conn = (id: string, name: string): DbConnection => ({
  id,
  name,
  engine: "postgres",
  family: "postgres",
  host: "db.internal",
  port: 5432,
  database: "maestro",
  user: "ro",
  passwordRef: "{{PG_PASSWORD}}",
  savePassword: "forever",
  url: null,
  srv: false,
  sslMode: "prefer",
  caSummary: null,
  options: {},
  readOnly: true,
  rowLimit: 500,
  timeoutMs: 30_000,
  allowMultiStatement: false,
  createdAt: 1,
  updatedAt: 2,
});

const rows = (over: Partial<DbResultSet> = {}): DbResultSet => ({
  kind: "rows",
  statement: "SELECT id FROM tracks",
  columns: [{ name: "id", typeName: "int4", kind: "number" }],
  rows: [["1"], ["2"]],
  rowsAffected: null,
  truncated: false,
  rowLimit: 100,
  durationMs: 4,
  notice: null,
  ...over,
});

const agentNamed = (id: string, title: string, customTitle: string | null = null): void =>
  useAppStore.setState((s) => {
    (s.agents as Record<string, unknown>)[id] = { id, title, customTitle };
  });

/** A `showAgentDbQuery` event from terminal t1 that was not refused. */
const agentRun = (event: {
  connectionId: string;
  query: string;
  results?: DbResultSet[];
  error?: string | null;
  terminalId?: string;
  outcome?: string | null;
}) => ({ terminalId: "t1", error: null, outcome: null, results: [], ...event });

/** Mark a connection's console as connected, the way `openDbSession` leaves it. */
const connected = (id: string): void =>
  useAppStore.setState((s) => {
    s.dbSessions[id] = {
      status: "open",
      sessionId: "s1" as never,
      serverVersion: "PostgreSQL 16",
      latencyMs: 3,
      error: null,
    };
  });

/** The db-console tabs, as `[connectionId, title]`, in creation order. */
const consoleTabs = (): Array<[string, string]> =>
  Object.values(useAppStore.getState().tabs).flatMap((t) =>
    t.ref.kind === "db-console" ? [[t.ref.connectionId, t.title] as [string, string]] : [],
  );

/** The tab the focused pane shows. */
const activeTitle = (): string | null => {
  const s = useAppStore.getState();
  const leaf = s.layout.type === "leaf" ? s.layout : null;
  const id = leaf?.activeTabId ?? null;
  return id === null ? null : s.tabs[id].title;
};

beforeEach(() => {
  resetStore();
  // The store harness leaves agents and the DB panel's notice alone; neither may leak from one
  // test into the next.
  useAppStore.setState((s) => {
    s.agents = {};
    s.dbAgentNotice = null;
  });
  vi.clearAllMocks();
  dbIpc.dbEngines.mockResolvedValue([POSTGRES_ENGINE]);
  dbIpc.dbConnectionsLoad.mockResolvedValue({
    version: 1,
    connections: [conn("c1", "Orders"), conn("c2", "Analytics")],
  });
  dbIpc.dbSavedQueries.mockResolvedValue([]);
});

describe("agentWho / agentRunNote", () => {
  it("names the agent by its custom title, its title, or not at all", () => {
    agentNamed("t1", "claude · shop", "Data helper");
    agentNamed("t2", "claude · shop");
    expect(agentWho("t1")).toBe('The agent "Data helper"');
    expect(agentWho("t2")).toBe('The agent "claude · shop"');
    expect(agentWho("nobody")).toBe("An agent");
  });

  it("says who ran it and every cut Rust made, or why it did not run", () => {
    const ran = agentRunNote(
      {
        kind: "dbQueryRun",
        terminalId: "t9",
        query: "SELECT 1",
        notes: ["Only the first 100 rows were read.", 7, "1 long value was cut."],
        error: null,
      },
      [rows({ rowLimit: 250 })],
    );
    expect(ran).toEqual({
      kind: "message",
      statement: "SELECT 1",
      columns: [],
      rows: [],
      rowsAffected: null,
      truncated: false,
      rowLimit: 250,
      durationMs: 0,
      notice:
        "An agent ran this query from its terminal. Below is what it received. " +
        "Only the first 100 rows were read. 1 long value was cut.",
    });
    const refused = agentRunNote(
      { kind: "dbQueryRun", terminalId: "t9", error: "This connection is read-only." },
      [],
    );
    expect(refused.statement).toBe("");
    expect(refused.rowLimit).toBe(0);
    expect(refused.notice).toBe(
      "An agent tried to run this query from its terminal, and it did not run: " +
        "This connection is read-only.",
    );
  });
});

describe("runOutcome", () => {
  it("says the rows read, the rows changed and a database error, in a few words", () => {
    expect(runOutcome([rows()])).toBe("2 rows");
    expect(runOutcome([rows({ rows: [["1"]] })])).toBe("1 row");
    expect(runOutcome([rows({ rows: [] })])).toBe("0 rows");
    expect(runOutcome([rows(), rows({ truncated: true })])).toBe("4 rows (cut)");
    expect(runOutcome([rows({ kind: "affected", rows: [], rowsAffected: 3 })])).toBe(
      "3 rows affected",
    );
    expect(runOutcome([rows({ kind: "affected", rows: [], rowsAffected: null })])).toBe(
      "0 rows affected",
    );
    expect(
      runOutcome([rows(), rows({ kind: "message", rows: [], notice: "The database said: no" })]),
    ).toBe("2 rows, an error from the database");
    expect(runOutcome([])).toBe("nothing");
  });
});

describe("dbQueryRun", () => {
  it("opens the console in the background, puts the query in an empty buffer, shows the results", async () => {
    // The user is looking at another console; the agent's run must not take the pane from it.
    await useAppStore.getState().dbActions.loadDbStore();
    useAppStore.getState().layoutActions.openDbConsoleTab("c2");
    expect(activeTitle()).toBe("Analytics");

    dispatchAgentCtl({
      kind: "dbQueryRun",
      terminalId: "t1",
      connectionId: "c1",
      query: "SELECT id FROM tracks",
      results: [rows()],
      error: null,
      notes: [],
    });
    await vi.waitFor(() => expect(consoleTabs()).toHaveLength(2));
    expect(consoleTabs()[1]).toEqual(["c1", "Orders"]);
    expect(activeTitle()).toBe("Analytics");
    const c = useAppStore.getState().dbConsoles.c1;
    expect(c.text).toBe("SELECT id FROM tracks");
    expect(c.results.map((r) => r.kind)).toEqual(["message", "rows"]);
    expect(c.results[0].notice).toContain("An agent ran this query from its terminal.");
    expect(c.results[1].rows).toEqual([["1"], ["2"]]);
    expect(c.error).toBeNull();
    // Told in the DB panel too: the console is not connected, so it cannot show the results yet.
    expect(useAppStore.getState().dbAgentNotice).toEqual({
      connectionId: "c1",
      created: false,
      agent: null,
      ran: { query: "SELECT id FROM tracks", error: null, outcome: "2 rows", console: "closed" },
    });
  });

  it("activates the tab only in a pane that shows nothing, and reuses an open one", async () => {
    const { showAgentDbQuery } = useAppStore.getState().dbActions;
    await showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 1", results: [] }));
    expect(activeTitle()).toBe("Orders");
    await showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 2", results: [] }));
    expect(consoleTabs()).toEqual([["c1", "Orders"]]);
    // A connection the store does not know (deleted meanwhile) still gets a tab, honestly named.
    await showAgentDbQuery(agentRun({ connectionId: "gone", query: "SELECT 3", results: [] }));
    expect(consoleTabs()[1]).toEqual(["gone", "Database"]);
  });

  it("tells every run in the DB panel, and where its results are", async () => {
    agentNamed("t1", "claude · shop");
    useAppStore.setState((s) => {
      s.rightRailTab = "files";
      s.rightRailCollapsed = true;
    });
    const { showAgentDbQuery } = useAppStore.getState().dbActions;
    connected("c1");
    await showAgentDbQuery(
      agentRun({ connectionId: "c1", query: "SELECT 1", outcome: "1 row", results: [rows()] }),
    );
    const s = useAppStore.getState();
    expect(s.dbAgentNotice).toEqual({
      connectionId: "c1",
      created: false,
      agent: "claude · shop",
      ran: { query: "SELECT 1", error: null, outcome: "1 row", console: "shown" },
    });
    expect(s.rightRailTab).toBe("db");
    expect(s.rightRailCollapsed).toBe(false);

    // A refused run on a console that is not connected is told as well.
    await showAgentDbQuery(
      agentRun({ connectionId: "c2", query: "DROP TABLE t", error: "It is read-only." }),
    );
    expect(useAppStore.getState().dbAgentNotice?.ran).toEqual({
      query: "DROP TABLE t",
      error: "It is read-only.",
      outcome: null,
      console: "closed",
    });
  });

  it("never modifies what the user typed: it offers the query instead, saved-query link kept", async () => {
    const { showAgentDbQuery, setDbConsoleText } = useAppStore.getState().dbActions;
    setDbConsoleText("c1", "SELECT my_own_work");
    useAppStore.setState((s) => {
      s.dbConsoles.c1.savedQuery = { id: "Q1", name: "Mine" };
    });
    await showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 1", results: [rows()] }));
    let c = useAppStore.getState().dbConsoles.c1;
    expect(c.text).toBe("SELECT my_own_work");
    expect(c.savedQuery).toEqual({ id: "Q1", name: "Mine" });
    expect(c.results).toHaveLength(1);
    expect(useAppStore.getState().dbAgentNotice?.offer).toBe("SELECT 1");

    // The same query as the buffer holds: nothing to offer.
    await showAgentDbQuery(
      agentRun({ connectionId: "c1", query: " SELECT my_own_work ", results: [] }),
    );
    expect(useAppStore.getState().dbAgentNotice?.offer).toBeUndefined();

    // A run the user is waiting on is never replaced.
    useAppStore.setState((s) => {
      s.dbConsoles.c1.running = true;
      s.dbConsoles.c1.results = [];
    });
    await showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 1", results: [rows()] }));
    c = useAppStore.getState().dbConsoles.c1;
    expect(c.results).toEqual([]);
    expect(c.text).toBe("SELECT my_own_work");
  });

  it("tells the user in the DB panel about a run the busy console could not show", async () => {
    agentNamed("t1", "claude · shop");
    useAppStore.setState((s) => {
      s.dbConsoles.c1 = { ...blankDbConsole(), text: "SELECT mine", running: true };
    });
    dispatchAgentCtl({
      kind: "dbQueryRun",
      terminalId: "t1",
      connectionId: "c1",
      query: "INSERT INTO t VALUES (1)",
      results: [],
      error: "This connection is read-only.",
    });
    await vi.waitFor(() => expect(useAppStore.getState().dbAgentNotice).not.toBeNull());
    const s = useAppStore.getState();
    expect(s.dbAgentNotice).toEqual({
      connectionId: "c1",
      created: false,
      agent: "claude · shop",
      ran: {
        query: "INSERT INTO t VALUES (1)",
        error: "This connection is read-only.",
        outcome: null,
        console: "busy",
      },
      offer: "INSERT INTO t VALUES (1)",
    });
    // The user's run and buffer are untouched.
    expect(s.dbConsoles.c1.text).toBe("SELECT mine");
    expect(s.dbConsoles.c1.results).toEqual([]);

    // A run that was not refused, from a terminal that is not a known agent.
    await useAppStore
      .getState()
      .dbActions.showAgentDbQuery(
        agentRun({ connectionId: "c1", query: "SELECT 2", terminalId: "unknown" }),
      );
    expect(useAppStore.getState().dbAgentNotice).toEqual({
      connectionId: "c1",
      created: false,
      agent: null,
      ran: { query: "SELECT 2", error: null, outcome: null, console: "busy" },
      offer: "SELECT 2",
    });
  });

  it("puts the query in an empty buffer as a new one, unlinked from a saved query", async () => {
    useAppStore.setState((s) => {
      s.dbConsoles.c1 = {
        ...blankDbConsole(),
        text: "  ",
        savedQuery: { id: "Q1", name: "Mine" },
      };
    });
    await useAppStore
      .getState()
      .dbActions.showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 1" }));
    const c = useAppStore.getState().dbConsoles.c1;
    expect(c.text).toBe("SELECT 1");
    expect(c.savedQuery).toBeNull();
    expect(useAppStore.getState().dbAgentNotice?.offer).toBeUndefined();
  });

  it("refreshes the object tree after a write, and only then", async () => {
    const refresh = vi.fn();
    useAppStore.setState((s) => {
      s.dbActions.refreshDbTree = refresh;
    });
    const { showAgentDbQuery } = useAppStore.getState().dbActions;
    await showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 1", results: [rows()] }));
    expect(refresh).not.toHaveBeenCalled();
    await showAgentDbQuery(
      agentRun({
        connectionId: "c1",
        query: "UPDATE t SET a = 1",
        results: [rows({ kind: "affected", rowsAffected: 3 })],
      }),
    );
    expect(refresh).toHaveBeenCalledWith("c1");
  });

  it("shows a refused run with its reason, and tolerates a payload without results", async () => {
    agentNamed("t1", "claude · shop");
    dispatchAgentCtl({
      kind: "dbQueryRun",
      terminalId: "t1",
      connectionId: "c1",
      error: "This connection is read-only.",
    });
    await vi.waitFor(() => expect(useAppStore.getState().dbConsoles.c1).toBeDefined());
    const c = useAppStore.getState().dbConsoles.c1;
    expect(c.text).toBe("");
    expect(c.results).toHaveLength(1);
    expect(c.results[0].notice).toBe(
      'The agent "claude · shop" tried to run this query from its terminal, and it did not ' +
        "run: This connection is read-only.",
    );
    expect(useAppStore.getState().dbAgentNotice?.ran?.error).toBe("This connection is read-only.");
  });

  it("sends what came back as the notice's outcome, from the results before the agent's note", async () => {
    dispatchAgentCtl({
      kind: "dbQueryRun",
      terminalId: "t1",
      connectionId: "c1",
      query: "SELECT id FROM tracks",
      results: [rows()],
      error: null,
    });
    await vi.waitFor(() =>
      expect(useAppStore.getState().dbAgentNotice?.ran?.outcome).toBe("2 rows"),
    );
  });
});

describe("dbConsole / dbSavedQuery", () => {
  it("opens the console with the agent's query typed in, and focuses it", async () => {
    dispatchAgentCtl({
      kind: "dbConsole",
      terminalId: "t1",
      connectionId: "c1",
      query: "SELECT * FROM orders",
    });
    await vi.waitFor(() => expect(consoleTabs()).toEqual([["c1", "Orders"]]));
    expect(activeTitle()).toBe("Orders");
    expect(useAppStore.getState().dbConsoles.c1.text).toBe("SELECT * FROM orders");
    expect(useAppStore.getState().dbConsoles.c1.results).toEqual([]);
    expect(useAppStore.getState().dbAgentNotice).toBeNull();
  });

  it("leaves what the user typed, and its saved-query link, and offers the query instead", async () => {
    await useAppStore.getState().dbActions.loadDbStore();
    agentNamed("t1", "claude · shop");
    useAppStore.setState((s) => {
      s.dbConsoles.c1 = {
        ...blankDbConsole(),
        text: "SELECT my_unsaved_work",
        savedQuery: { id: "Q1", name: "Mine" },
      };
    });
    const show = (query: string) =>
      dispatchAgentCtl({ kind: "dbConsole", terminalId: "t1", connectionId: "c1", query });
    show("SELECT * FROM orders");
    await vi.waitFor(() => expect(consoleTabs()).toEqual([["c1", "Orders"]]));
    await vi.waitFor(() =>
      expect(useAppStore.getState().dbAgentNotice).toEqual({
        connectionId: "c1",
        created: false,
        agent: "claude · shop",
        offer: "SELECT * FROM orders",
      }),
    );
    expect(activeTitle()).toBe("Orders");
    const c = useAppStore.getState().dbConsoles.c1;
    expect(c.text).toBe("SELECT my_unsaved_work");
    expect(c.savedQuery).toEqual({ id: "Q1", name: "Mine" });
    expect(useAppStore.getState().rightRailTab).toBe("db");

    // Only the user's click puts it in: the text is replaced and the saved query unlinked, so
    // ⌘S cannot write the agent's text into the user's saved query.
    useAppStore.getState().dbActions.putAgentDbQueryInConsole();
    const after = useAppStore.getState();
    expect(after.dbConsoles.c1.text).toBe("SELECT * FROM orders");
    expect(after.dbConsoles.c1.savedQuery).toBeNull();
    expect(after.dbAgentNotice).toBeNull();
    // With nothing offered, the button's action does nothing.
    after.dbActions.putAgentDbQueryInConsole();
    expect(useAppStore.getState().dbConsoles.c1.text).toBe("SELECT * FROM orders");
  });

  it("offers nothing when the console already holds the query, and opens a console it puts it in", async () => {
    useAppStore.setState((s) => {
      s.dbConsoles.c1 = { ...blankDbConsole(), text: "SELECT 1\n" };
    });
    dispatchAgentCtl({ kind: "dbConsole", terminalId: "t1", connectionId: "c1", query: "SELECT 1" });
    await vi.waitFor(() => expect(consoleTabs()).toEqual([["c1", "Orders"]]));
    expect(useAppStore.getState().dbAgentNotice).toBeNull();

    // An offer for a console whose state was dropped meanwhile still lands in a fresh one.
    useAppStore.setState((s) => {
      s.dbAgentNotice = { connectionId: "c2", created: false, agent: null, offer: "SELECT 2" };
    });
    useAppStore.getState().dbActions.putAgentDbQueryInConsole();
    expect(useAppStore.getState().dbConsoles.c2.text).toBe("SELECT 2");
    expect(consoleTabs()).toContainEqual(["c2", "Analytics"]);

    // An empty buffer linked to a saved query takes the query as a NEW buffer.
    useAppStore.setState((s) => {
      s.dbConsoles.c2 = { ...blankDbConsole(), text: "", savedQuery: { id: "Q2", name: "Other" } };
    });
    dispatchAgentCtl({ kind: "dbConsole", terminalId: "t1", connectionId: "c2", query: "SELECT 3" });
    await vi.waitFor(() => expect(useAppStore.getState().dbConsoles.c2.text).toBe("SELECT 3"));
    expect(useAppStore.getState().dbConsoles.c2.savedQuery).toBeNull();
  });

  it("opens an empty console when no query came with it", async () => {
    dispatchAgentCtl({ kind: "dbConsole", terminalId: "t1", connectionId: "c2", query: null });
    await vi.waitFor(() => expect(consoleTabs()).toEqual([["c2", "Analytics"]]));
    expect(useAppStore.getState().dbConsoles.c2).toBeUndefined();
  });

  it("reads a connection's saved queries again after an agent saved one", async () => {
    dispatchAgentCtl({ kind: "dbSavedQuery", terminalId: "t1", connectionId: "c1", queryId: "Q1" });
    await vi.waitFor(() => expect(dbIpc.dbSavedQueries).toHaveBeenCalledWith("c1"));
  });
});

describe("dbConnection / dbOpen: shown connected", () => {
  // Two tests stub `openDbSession`, and `resetStore` resets state, not actions: put it back.
  const realOpen = useAppStore.getState().dbActions.openDbSession;
  afterEach(() =>
    useAppStore.setState((s) => {
      s.dbActions.openDbSession = realOpen;
    }),
  );

  it("connects a new connection whose test passed, and not a forced dead one", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState((s) => {
      s.dbActions.openDbSession = open;
    });
    dispatchAgentCtl({ kind: "dbConnection", terminalId: "t1", connectionId: "c1", created: true, open: true });
    dispatchAgentCtl({ kind: "dbConnection", terminalId: "t1", connectionId: "c2", created: true, open: false });
    expect(useAppStore.getState().dbAgentNotice?.connectionId).toBe("c2");
    await vi.waitFor(() => expect(open.mock.calls).toEqual([["c1"]]));
    await new Promise((r) => setTimeout(r, 20));
    expect(open.mock.calls).toEqual([["c1"]]);
  });

  it("db open shows the connection in the DB panel and connects it", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState((s) => {
      s.dbActions.openDbSession = open;
    });
    dispatchAgentCtl({ kind: "dbOpen", terminalId: "t1", connectionId: "c2" });
    const s = useAppStore.getState();
    expect(s.rightRailTab).toBe("db");
    expect(s.dbAgentNotice).toMatchObject({ connectionId: "c2", created: false });
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("c2"));
  });

  it("connects a connection the agent just added, once the panel's list holds it", async () => {
    // The panel loaded its list before the agent's `db connect` wrote "Cache" (c3).
    await useAppStore.getState().dbActions.loadDbStore();
    expect(useAppStore.getState().dbConnections.map((c) => c.id)).toEqual(["c1", "c2"]);
    dbIpc.dbConnectionsLoad.mockResolvedValue({
      version: 1,
      connections: [conn("c1", "Orders"), conn("c2", "Analytics"), conn("c3", "Cache")],
    });
    dbIpc.dbOpen.mockResolvedValue({ sessionId: "s3", serverVersion: "Redis 8.10", latencyMs: 2 });

    dispatchAgentCtl({ kind: "dbConnection", terminalId: "t1", connectionId: "c3", created: true, open: true });

    // Not "That connection or session no longer exists": the connect waited for the list.
    await vi.waitFor(() => expect(useAppStore.getState().dbSessions.c3?.status).toBe("open"));
    expect(useAppStore.getState().dbSessions.c3).toMatchObject({ sessionId: "s3", error: null });
    expect(dbIpc.dbOpen.mock.calls).toEqual([["c3", null]]);
  });

  it("leaves a connection the panel already has open on its session", async () => {
    connected("c1");
    dispatchAgentCtl({ kind: "dbOpen", terminalId: "t1", connectionId: "c1" });
    dispatchAgentCtl({ kind: "dbConnection", terminalId: "t1", connectionId: "c1", created: false, open: true });
    await vi.waitFor(() => expect(dbIpc.dbConnectionsLoad).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(dbIpc.dbOpen).not.toHaveBeenCalled();
    expect(useAppStore.getState().dbSessions.c1).toMatchObject({ status: "open", sessionId: "s1" });
    expect(useAppStore.getState().dbAgentNotice).toMatchObject({ connectionId: "c1" });
  });
});
