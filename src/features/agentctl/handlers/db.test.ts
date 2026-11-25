import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { agentRunNote, agentWho, withAgentQuery } from "./db";

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
}) => ({ terminalId: "t1", error: null, results: [], ...event });

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

  it("never overwrites what the user typed or replaces a run they are waiting on", async () => {
    const { showAgentDbQuery, setDbConsoleText } = useAppStore.getState().dbActions;
    setDbConsoleText("c1", "SELECT my_own_work");
    await showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 1", results: [rows()] }));
    expect(useAppStore.getState().dbConsoles.c1.text).toBe("SELECT my_own_work");
    expect(useAppStore.getState().dbConsoles.c1.results).toHaveLength(1);

    useAppStore.setState((s) => {
      s.dbConsoles.c1.running = true;
      s.dbConsoles.c1.results = [];
    });
    await showAgentDbQuery(agentRun({ connectionId: "c1", query: "SELECT 1", results: [rows()] }));
    expect(useAppStore.getState().dbConsoles.c1.results).toEqual([]);
  });

  it("tells the user in the DB panel about a run the busy console could not show", async () => {
    agentNamed("t1", "claude · shop");
    useAppStore.setState((s) => {
      s.rightRailTab = "files";
      s.rightRailCollapsed = true;
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
      ran: { query: "INSERT INTO t VALUES (1)", error: "This connection is read-only." },
    });
    expect(s.rightRailTab).toBe("db");
    expect(s.rightRailCollapsed).toBe(false);
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
      ran: { query: "SELECT 2", error: null },
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
    expect(useAppStore.getState().dbAgentNotice).toBeNull();
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
  });

  it("keeps what the user typed, and its saved-query link, and adds the query below it", async () => {
    await useAppStore.getState().dbActions.loadDbStore();
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
      expect(useAppStore.getState().dbConsoles.c1.text).toBe(
        "SELECT my_unsaved_work\n\nSELECT * FROM orders",
      ),
    );
    expect(activeTitle()).toBe("Orders");
    expect(useAppStore.getState().dbConsoles.c1.savedQuery).toEqual({ id: "Q1", name: "Mine" });

    // The same query again is already there: nothing is added twice.
    show("SELECT * FROM orders");
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() =>
      expect(useAppStore.getState().dbConsoles.c1.text).toBe(
        "SELECT my_unsaved_work\n\nSELECT * FROM orders",
      ),
    );

    // An empty buffer linked to a saved query takes the query as a NEW buffer: ⌘S must not
    // write the agent's text over the user's saved query.
    useAppStore.setState((s) => {
      s.dbConsoles.c2 = { ...blankDbConsole(), text: "", savedQuery: { id: "Q2", name: "Other" } };
    });
    dispatchAgentCtl({
      kind: "dbConsole",
      terminalId: "t1",
      connectionId: "c2",
      query: "SELECT 2",
    });
    await vi.waitFor(() => expect(useAppStore.getState().dbConsoles.c2.text).toBe("SELECT 2"));
    expect(useAppStore.getState().dbConsoles.c2.savedQuery).toBeNull();
  });

  it("adds a query below the user's text after exactly one blank line", () => {
    expect(withAgentQuery("SELECT 1", "SELECT 2")).toBe("SELECT 1\n\nSELECT 2");
    expect(withAgentQuery("SELECT 1\n", "SELECT 2")).toBe("SELECT 1\n\nSELECT 2");
    expect(withAgentQuery("SELECT 1\n\n", "SELECT 2")).toBe("SELECT 1\n\nSELECT 2");
    expect(withAgentQuery("SELECT 2", " SELECT 2 ")).toBeNull();
    expect(withAgentQuery("SELECT 1\n\nSELECT 2\n", "SELECT 2")).toBeNull();
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
