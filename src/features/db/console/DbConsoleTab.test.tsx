/**
 * The console SEAM: store ⇄ `<DbConsole/>`, driven for real.
 *
 * This file exists for the reason `metricsNoSelectionSeam.test.tsx` exists. The halves of this
 * feature were built separately and each half is at 100% coverage — and neither suite could
 * have caught the defect that once shipped in the metrics feature, which was that a
 * fully-tested caller met a fully-tested command across a join nobody exercised. The join
 * here is `DbConsoleTab`. So: the real store, the real console component, the real reducers,
 * with **only the IPC edge mocked**.
 *
 * Every expectation is literal.
 */

import { EditorView } from "@codemirror/view";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The one mocked boundary — and only the INVOKING half of it. `connectionInput` /
// `connectionAsInput` are pure record-shaping functions in the same module, and the store
// calls them on the connect path; replacing them with `undefined` (which a whole-module
// factory does) made `openDbSession` fail with "an unrecognized reason" before it ever
// reached the wire. A partial mock keeps the real ones, which is also the more honest test:
// the shape that goes over the wire is then the shape the app really builds.
const ipc = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  dbOpen: vi.fn(),
  dbClose: vi.fn(),
  dbEngines: vi.fn(),
  dbConnectionsLoad: vi.fn(),
  dbConnectionUpsert: vi.fn(),
  dbConnectionDelete: vi.fn(),
  dbTestConnection: vi.fn(),
  dbUrlBuild: vi.fn(),
  dbUrlParse: vi.fn(),
  dbChildren: vi.fn(),
  dbSavedQueries: vi.fn(),
  dbSavedQueryUpsert: vi.fn(),
  dbSavedQueryDelete: vi.fn(),
  dbCancel: vi.fn(),
}));
vi.mock("../dbIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dbIpc")>()),
  ...ipc,
}));

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../../terminal", () => terminal);

import {
  blankDbConsole,
  useAppStore,
  type DbConnection,
  type DbResultSet,
  type EngineSpec,
} from "../../../app/store";
import { stubGeometry } from "../../editor/find/cmTestKit";
import { resetStore } from "../../../test/store-harness";
import { TRACKS_RESULT } from "./consoleFixtures";
import { DbConsoleTab } from "./DbConsoleTab";

const state = () => useAppStore.getState();
const CID = "conn-1";
const SID = "sess-9";

/** A Postgres connection as `db_connections_load` would hand it back. */
const CONNECTION = {
  id: CID,
  name: "maestro (local)",
  engine: "postgres",
  host: "127.0.0.1",
  port: 55432,
  database: "maestro",
  user: "agentstudio",
  passwordRef: "{{PG_PASSWORD}}",
  passwordScope: "vault",
  sslMode: "prefer",
  readOnly: true,
  rowLimit: 500,
  timeoutMs: 30_000,
  allowMultiStatement: false,
  url: null,
  extras: {},
  createdAtMs: 1,
  updatedAtMs: 1,
} as unknown as DbConnection;

const ENGINE = {
  id: "postgres",
  label: "PostgreSQL",
  queryLanguage: "sql",
  serverEnforcedReadOnly: true,
  defaultPort: 5432,
  supportsDatabase: true,
  supportsUser: true,
  sslModes: ["prefer"],
  extraFields: [],
  defaults: { rowLimit: 500, timeoutMs: 30_000, allowMultiStatement: false, sslMode: "prefer" },
} as unknown as EngineSpec;

/** The console's own fixture, reused rather than re-invented: a hand-rolled copy of
 *  it once omitted `typeName`, and the grid crashed on the missing field. */
const ROWS: DbResultSet[] = [TRACKS_RESULT];

/** Put the store in "connected, ready to type" — the state a user reaches by expanding a row. */
function connected(): void {
  useAppStore.setState((s) => {
    s.dbConnections = [CONNECTION];
    s.dbEngines = [ENGINE];
    s.dbSessions[CID] = {
      status: "open",
      sessionId: SID,
      serverVersion: "PostgreSQL 17.2",
      latencyMs: 12,
      error: null,
    };
  });
}

// FOCUSING the real CM6 surface (which the ⌘S tests below do) starts its async measure
// cycle, and jsdom implements none of the geometry it calls — the failure lands in a
// `requestAnimationFrame` where no assertion can see it, as an UNHANDLED error that makes
// the tier exit 1 with every test reported green (a green test count is not a green
// tier). Measured: without this the file printed `Tests 37 passed` and `exit=1`. The
// repo already owns the stubs — `cmTestKit.stubGeometry` — so this reuses them rather than
// inventing a second set.
beforeAll(stubGeometry);

beforeEach(() => {
  resetStore();
  cleanup();
  for (const fn of Object.values(ipc)) fn.mockReset();
  // Stop now ASKS THE SERVER as well as stopping the wait, so every test that presses Stop
  // touches this. A bare `mockReset()` returns `undefined`, and the store awaits the result —
  // so without a resolving default, four unrelated Stop tests fail on `.catch of undefined`.
  ipc.dbCancel.mockResolvedValue(undefined);
});

describe("DbConsoleTab — the store↔console seam", () => {
  it("🔴 types a query, runs it, and shows the ROWS — the whole feature in one test", async () => {
    const user = userEvent.setup();
    connected();
    ipc.dbQuery.mockResolvedValue(ROWS);

    render(<DbConsoleTab connectionId={CID} />);
    // The editor is a real CM6 surface; driving it through the store is what a keystroke
    // does anyway (the editor is controlled), and it keeps this test about the seam rather
    // than about CodeMirror's event plumbing — which QueryEditor.test.tsx already covers.
    state().dbActions.setDbConsoleText(CID, "select code, tag from tracks");
    await user.click(screen.getByTestId("db-run"));

    // The exact wire call: the session id from the store, the buffer, the mode, and the
    // CONNECTION's row limit — not the engine default, and not null.
    await waitFor(() => expect(ipc.dbQuery).toHaveBeenCalledTimes(1));
    expect(ipc.dbQuery).toHaveBeenCalledWith(SID, "select code, tag from tracks", "statement", 500);

    // And the user can read the result — the store's rows reaching the grid, which is the
    // join neither half's suite touched. (That `Pane` mounts this container at all is a
    // different claim and is NOT tested here; it is pinned in `Pane.test.tsx`, which was
    // verified to go red with the `db-console` case removed.)
    await waitFor(() => expect(screen.getByText("BLU")).toBeInTheDocument());
  });

  it("🔴 renders rows as a TABLE and keeps prose for errors", async () => {
    // Query output must be a table, not console text. Only the error path had ever been seen,
    // so this asks the question that had not been: what does a SUCCESSFUL query look like?
    //
    // The existing test above proves a cell's text reaches the screen; it would also pass if that
    // text were printed as a paragraph. This one pins the SHAPE: a real `<table>` with headers, and
    // no prose element anywhere near it.
    const user = userEvent.setup();
    connected();
    ipc.dbQuery.mockResolvedValue(ROWS);

    render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleText(CID, "select code, tag from tracks");
    await user.click(screen.getByTestId("db-run"));

    const grid = await screen.findByTestId("db-grid");
    // A grid, not a paragraph: `getByRole("table")` fails on a `<div>` however it is styled.
    expect(within(grid).getByRole("table")).toBeInTheDocument();
    // Column headers come from the result's own columns, so the table is the DATA's shape — name
    // AND the server's own type name, which is what makes a header more than a label.
    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((h) => h.textContent ?? "");
    expect(headers).toEqual(["codevarchar(8)", "secsnumeric", "notetext"]);
    // And nothing rendered the rows as prose or as an error.
    expect(screen.queryByTestId("db-result-message")).toBeNull();
    expect(screen.queryByTestId("db-console-error")).toBeNull();
    expect(screen.queryByTestId("db-console-idle")).toBeNull();
  });

  it("keeps the buffer across an UNMOUNT, because Pane unmounts the inactive tab", async () => {
    connected();
    const { unmount } = render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleText(CID, "select 1 -- half-typed");

    // Exactly what clicking another tab does. If the draft lived in component state, this
    // is where the user's query would be destroyed — silently, and with no way back.
    unmount();
    render(<DbConsoleTab connectionId={CID} />);

    expect(state().dbConsoles[CID]?.text).toBe("select 1 -- half-typed");
  });

  it("does NOT dial on mount — connecting stays a gesture", () => {
    useAppStore.setState((s) => {
      s.dbConnections = [CONNECTION];
      s.dbEngines = [ENGINE];
    });
    render(<DbConsoleTab connectionId={CID} />);

    expect(screen.getByTestId("db-console-closed")).toBeInTheDocument();
    // A mount that silently opened a session would read a credential from the Vault and
    // make a network round trip because a tab was restored. Both IPC calls a connect needs:
    expect(ipc.dbTestConnection).not.toHaveBeenCalled();
    expect(ipc.dbOpen).not.toHaveBeenCalled();
  });

  it("offers Connect when closed, and reaching it really opens a session", async () => {
    const user = userEvent.setup();
    useAppStore.setState((s) => {
      s.dbConnections = [CONNECTION];
      s.dbEngines = [ENGINE];
    });
    ipc.dbTestConnection.mockResolvedValue({ ok: true, serverVersion: "PostgreSQL 17.2", latencyMs: 12, error: null });
    ipc.dbOpen.mockResolvedValue(SID);

    render(<DbConsoleTab connectionId={CID} />);
    await user.click(screen.getByTestId("db-console-connect"));

    // Probe then open — the ordering the store's own tests pin, asserted here through the UI.
    await waitFor(() => expect(ipc.dbOpen).toHaveBeenCalledTimes(1));
    expect(state().dbSessions[CID]?.status).toBe("open");
  });

  it("says a deleted connection is gone rather than rendering a console wired to nothing", () => {
    // The tab outlives `deleteDbConnection`, which drops both the record and the session.
    render(<DbConsoleTab connectionId="never-existed" />);
    expect(screen.getByTestId("db-console-unavailable")).toBeInTheDocument();
  });

  it("surfaces a failed CALL as an error, and asks for no session it does not have", async () => {
    const user = userEvent.setup();
    connected();
    ipc.dbQuery.mockRejectedValue("timeout: statement took longer than 30s");

    render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleText(CID, "select pg_sleep(60)");
    await user.click(screen.getByTestId("db-run"));

    await waitFor(() => expect(state().dbConsoles[CID]?.error?.code).toBe("timeout"));
    // Mapped to a sentence with no driver vocabulary and no DSN — and `running` released,
    // because a spinner that never stops is how a failed query looks like a hung app.
    expect(state().dbConsoles[CID]?.running).toBe(false);
  });

  it("🔴 blames the STATEMENT, not the connection, and shows the sentence Rust wrote", async () => {
    // The original bug, driven through the whole seam. SQL typed into a MongoDB console on a
    // connection that had just connected to Atlas successfully made the screen say *"check the
    // host, the port, and the settings this engine requires"* — because Rust's message was
    // reduced to `invalid-config` and re-described from the code.
    //
    // This test is the reason the fix is two-sided: the code is now `invalid-statement`, and the
    // detail survives the store. Reverting either half turns it red.
    const user = userEvent.setup();
    connected();
    ipc.dbQuery.mockRejectedValue(
      'invalid-statement: That is not a MongoDB command document. A command is one JSON object ' +
        'whose FIRST key is the command name, e.g. {"find": "tracks", "limit": 10}.',
    );

    render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleText(CID, "select * from temp_playlists limit 10;");
    await user.click(screen.getByTestId("db-run"));

    const alert = await screen.findByTestId("db-console-error");
    expect(alert).toHaveTextContent('e.g. {"find": "tracks", "limit": 10}');
    // The specific wrong answer this whole change exists to remove.
    expect(alert.textContent).not.toContain("check the host");
    expect(alert.textContent).not.toContain("VPN");
  });
});

describe("stopping a query — honest about what it can and cannot do", () => {
  it("🔴 DISCARDS the reply of a stopped run instead of overwriting the screen later", async () => {
    connected();
    let resolveQuery: (r: DbResultSet[]) => void = () => {};
    ipc.dbQuery.mockReturnValue(new Promise<DbResultSet[]>((res) => (resolveQuery = res)));

    render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleText(CID, "select * from huge");
    void state().dbActions.runDbQuery(CID, "statement");
    await waitFor(() => expect(state().dbConsoles[CID]?.running).toBe(true));

    state().dbActions.stopWaitingForDbQuery(CID);
    expect(state().dbConsoles[CID]?.running).toBe(false);

    // The server does not know we stopped — there is no `db_cancel` — so the reply STILL
    // ARRIVES. It must not repaint a console the user has moved on from.
    resolveQuery(ROWS);
    await Promise.resolve();
    expect(state().dbConsoles[CID]?.results).toEqual([]);
  });

  it("a superseded run cannot overwrite the newer run's results", async () => {
    connected();
    let resolveFirst: (r: DbResultSet[]) => void = () => {};
    ipc.dbQuery
      .mockReturnValueOnce(new Promise<DbResultSet[]>((res) => (resolveFirst = res)))
      .mockResolvedValueOnce(ROWS);

    useAppStore.setState((s) => {
      // `blankDbConsole()` + the buffer, rather than a hand-written record: the literal
      // version went stale the moment `savedQuery`/`saveError` were added, and typecheck
      // caught it — which is the good outcome, but the factory means there is nothing to
      // catch next time.
      s.dbConsoles[CID] = { ...blankDbConsole(), text: "select 1" };
    });
    const slow = state().dbActions.runDbQuery(CID, "statement");
    const fast = state().dbActions.runDbQuery(CID, "statement");
    await fast;
    expect(state().dbConsoles[CID]?.results).toEqual(ROWS);

    // The first, slower query lands afterwards. Without the token it would clobber the
    // second's rows with stale ones and leave no trace of having done so.
    resolveFirst([]);
    await slow;
    expect(state().dbConsoles[CID]?.results).toEqual(ROWS);
  });

  it("refuses to run with no open session, and says so instead of doing nothing", async () => {
    useAppStore.setState((s) => {
      s.dbConnections = [CONNECTION];
      s.dbEngines = [ENGINE];
    });
    state().dbActions.setDbConsoleText(CID, "select 1");
    await state().dbActions.runDbQuery(CID, "statement");

    expect(ipc.dbQuery).not.toHaveBeenCalled();
    expect(state().dbConsoles[CID]?.error?.code).toBe("not-found");
  });

  it("a blank buffer is not a round trip — the shortcut agrees with the disabled button", async () => {
    connected();
    state().dbActions.setDbConsoleText(CID, "   \n  ");
    await state().dbActions.runDbQuery(CID, "statement");

    expect(ipc.dbQuery).not.toHaveBeenCalled();
    // And it is not an error either: the user simply has not typed anything yet.
    expect(state().dbConsoles[CID]?.error).toBeNull();
  });
});

/* ═══════ 🔴 what reaches the wire: the selection / the statement ═══════ */

describe("DbConsoleTab — the text that reaches db_query", () => {
  /**
   * A sample buffer. Lines 3 and 4 are commented out, and they are the two selected when
   * Run is pressed.
   */
  const BUFFER = [
    "SELECT * FROM widgets;",
    "SELECT * FRom booking;",
    "--SELECT * from op_history;",
    "--select * from staff_accounts;",
  ].join("\n");

  /** The live CM6 view behind the rendered console. */
  function view(): EditorView {
    const found = EditorView.findFromDOM(screen.getByTestId("db-query-editor"));
    if (found === null) throw new Error("the editor did not mount a CodeMirror view");
    return found;
  }

  /**
   * THE seam test. Four modules have to agree for this to pass — `statements.ts`
   * decides, `QueryEditor` reads the CM6 selection, `DbConsole`'s button asks it, `DbConsoleTab`
   * forwards, and `runDbQuery` sends — and every one of them is separately at 100% coverage.
   * The shipped bug was precisely that they did not agree: ⌘⏎ said `"statement"` and the store
   * sent all four lines, so Rust's `multi_statement_refusal` answered *"That statement was
   * blocked before it ran…"*.
   *
   * **Falsified before being trusted.** Reverting `runDbQuery`'s `text ?? console_.text` to
   * `console_.text` — the exact shape of the original defect — makes this fail with:
   *
   * ```
   * AssertionError: expected "spy" to be called with arguments:
   *   [ 'sess-9', '--SELECT * from op_history;…', 'statement', 500 ]
   * Received: 'SELECT * FROM widgets;\nSELECT * FRom booking;\n--SELECT…'
   * ```
   */
  it("🔴 sends EXACTLY the selection — the two highlighted lines", async () => {
    const user = userEvent.setup();
    connected();
    ipc.dbQuery.mockResolvedValue([]);

    render(<DbConsoleTab connectionId={CID} />);
    // Typed AND selected in one transaction, through CodeMirror itself: the store's text and
    // the view's selection have to come from one consistent state, and driving the buffer in
    // through the store instead would leave the selection pointing outside a document React
    // has not re-rendered yet. (Synthetic typing is avoided for the measure-cycle reason the
    // editor test below explains.)
    view().dispatch({
      changes: { from: 0, insert: BUFFER },
      // Lines 3–4, the highlighted pair.
      selection: { anchor: BUFFER.indexOf("--SELECT"), head: BUFFER.length },
    });
    await user.click(screen.getByTestId("db-run"));

    await waitFor(() => expect(ipc.dbQuery).toHaveBeenCalledTimes(1));
    expect(ipc.dbQuery).toHaveBeenCalledWith(
      SID,
      "--SELECT * from op_history;\n--select * from staff_accounts;",
      "statement",
      500,
    );
  });

  it("🔴 sends ONLY the statement under the cursor when nothing is selected", async () => {
    // The other half of the same report: it should be possible to select one statement and run
    // it with Command+Enter. With the caret on line 1, line 1 is what runs — not the buffer,
    // which is two statements and would come back blocked on a connection that (like this
    // one) has `allowMultiStatement: false`.
    const user = userEvent.setup();
    connected();
    ipc.dbQuery.mockResolvedValue([]);

    render(<DbConsoleTab connectionId={CID} />);
    view().dispatch({ changes: { from: 0, insert: BUFFER }, selection: { anchor: 5 } });
    await user.click(screen.getByTestId("db-run"));

    await waitFor(() => expect(ipc.dbQuery).toHaveBeenCalledTimes(1));
    expect(ipc.dbQuery).toHaveBeenCalledWith(SID, "SELECT * FROM widgets", "statement", 500);
  });

  it("Script still sends the WHOLE buffer, selection or not", async () => {
    const user = userEvent.setup();
    useAppStore.setState((s) => {
      s.dbConnections = [{ ...CONNECTION, allowMultiStatement: true }];
      s.dbEngines = [ENGINE];
      s.dbSessions[CID] = {
        status: "open",
        sessionId: SID,
        serverVersion: "PostgreSQL 17.2",
        latencyMs: 12,
        error: null,
      };
    });
    ipc.dbQuery.mockResolvedValue([]);

    render(<DbConsoleTab connectionId={CID} />);
    view().dispatch({ changes: { from: 0, insert: BUFFER }, selection: { anchor: 0, head: 5 } });
    await user.click(screen.getByTestId("db-run-script"));

    await waitFor(() => expect(ipc.dbQuery).toHaveBeenCalledTimes(1));
    // A selection does NOT narrow Script: the user asked for the script.
    expect(ipc.dbQuery).toHaveBeenCalledWith(SID, BUFFER, "script", 500);
  });
});

describe("the callbacks the component actually invokes", () => {
  it("🔴 an edit in the EDITOR reaches the store — the props are wired, not just present", () => {
    connected();
    render(<DbConsoleTab connectionId={CID} />);

    // Driven through CodeMirror's own `dispatch`, the way `QueryEditor.test.tsx` does it:
    // synthetic typing makes CM6 measure, and jsdom has no layout, so it throws
    // `textRange(...).getClientRects is not a function` out of a requestAnimationFrame
    // where no assertion can see it. A dispatch is the same code path minus the measure.
    const host = screen.getByTestId("db-query-editor");
    const view = EditorView.findFromDOM(host);
    if (view === null) throw new Error("the editor did not mount a CodeMirror view");
    view.dispatch({ changes: { from: 0, insert: "select 1" } });

    // The distinction this test exists for: a container can hold a perfectly correct store
    // action and pass the WRONG callback down, and every store-level test still passes.
    expect(state().dbConsoles[CID]?.text).toBe("select 1");
  });

  it("dragging the DIVIDER reaches the store, so the position survives the tab switch", async () => {
    const user = userEvent.setup();
    connected();
    render(<DbConsoleTab connectionId={CID} />);

    // Arrow keys resize in 2% steps and need no layout, which is why they are the
    // assertable half of the divider under jsdom (the pointer drag has a browser-tier test).
    // Up/Down, not Left/Right: the editor sits ABOVE the output, so this is a horizontal
    // separator moved vertically (pressing ArrowRight moves nothing).
    const divider = screen.getByTestId("db-console-divider");
    divider.focus();
    await user.keyboard("{ArrowDown}");

    expect(state().dbConsoles[CID]?.splitFraction).toBeGreaterThan(0.5);
  });

  it("the Stop BUTTON reaches the store, not just the action behind it", async () => {
    const user = userEvent.setup();
    connected();
    // Never resolves: the console has to be genuinely mid-flight for Stop to be live.
    ipc.dbQuery.mockReturnValue(new Promise<DbResultSet[]>(() => {}));

    render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleText(CID, "select pg_sleep(60)");
    await user.click(screen.getByTestId("db-run"));
    await waitFor(() => expect(state().dbConsoles[CID]?.running).toBe(true));

    await user.click(screen.getByTestId("db-cancel"));
    expect(state().dbConsoles[CID]?.running).toBe(false);
  });

  it("shows a failed session's reason on the closed screen, verbatim from Rust", () => {
    useAppStore.setState((s) => {
      s.dbConnections = [CONNECTION];
      s.dbEngines = [ENGINE];
      // What `openDbSession` writes when the probe fails: Rust's already-mapped and
      // already-redacted sentence, which is the one db string rendered as Rust wrote it.
      s.dbSessions[CID] = {
        status: "error",
        sessionId: null,
        serverVersion: null,
        latencyMs: null,
        error: "The server could not be reached — check the host and the port.",
      };
    });
    render(<DbConsoleTab connectionId={CID} />);

    expect(screen.getByTestId("db-console-closed-error")).toHaveTextContent(
      "The server could not be reached — check the host and the port.",
    );
  });
});

describe("the guards on paths a user can reach but a happy path never does", () => {
  it("discards a stopped run's REJECTION too, not only its success", async () => {
    connected();
    let rejectQuery: (e: unknown) => void = () => {};
    ipc.dbQuery.mockReturnValue(new Promise<DbResultSet[]>((_, rej) => (rejectQuery = rej)));

    const run = state().dbActions.runDbQuery(CID, "statement");
    state().dbActions.setDbConsoleText(CID, "select 1");
    // Re-run so there IS a buffer (the first call returned early on a blank one), then stop.
    const real = state().dbActions.runDbQuery(CID, "statement");
    state().dbActions.stopWaitingForDbQuery(CID);

    // A failure arriving after the user stopped waiting must be as silent as a success:
    // an error banner for a query they abandoned is a lie about the current state.
    rejectQuery("network: connection reset");
    await Promise.all([run, real]);
    expect(state().dbConsoles[CID]?.error).toBeNull();
  });

  /* ── Stop is now two halves: the local one, and the request ── */

  it("🔴 asks the SERVER to cancel, not just the UI to stop waiting", () => {
    // Stop used to only orphan the reply — the statement kept running, sometimes for
    // minutes, on a production database. `db_cancel` could not exist then because the
    // cancel path went through the session mutex the running query holds; the handle now lives
    // beside it. This is the frontend half of that.
    connected();
    ipc.dbCancel.mockResolvedValue(undefined);
    ipc.dbQuery.mockReturnValue(new Promise<DbResultSet[]>(() => {}));
    state().dbActions.setDbConsoleText(CID, "select pg_sleep(30)");
    void state().dbActions.runDbQuery(CID, "statement");

    state().dbActions.stopWaitingForDbQuery(CID);

    expect(ipc.dbCancel).toHaveBeenCalledWith(SID);
    // …and the local half still happens immediately, because it is the part that cannot fail.
    expect(state().dbConsoles[CID]?.running).toBe(false);
  });

  it("stops waiting even when the cancel is refused, and says why", async () => {
    // MongoDB, Redis and DynamoDB have no server-side cancel. The gesture must still work — the
    // spinner stops — and the reason surfaces instead of the button appearing to have done
    // something it did not.
    connected();
    ipc.dbCancel.mockRejectedValue("unknown: This engine has no server-side cancel.");
    ipc.dbQuery.mockReturnValue(new Promise<DbResultSet[]>(() => {}));
    state().dbActions.setDbConsoleText(CID, "select 1");
    void state().dbActions.runDbQuery(CID, "statement");

    state().dbActions.stopWaitingForDbQuery(CID);
    expect(state().dbConsoles[CID]?.running).toBe(false);

    await vi.waitFor(() =>
      expect(state().dbConsoles[CID]?.cancelError).toContain("no server-side cancel"),
    );
    // 🔴 It must NOT land in `error`, which means "the query failed". The query did not fail; it
    // is very likely still running, and the results the user already has must survive.
    expect(state().dbConsoles[CID]?.error).toBeNull();
  });

  it("clears a previous cancel notice when Stop is pressed again", () => {
    // A sentence about a cancel that is two queries old is worse than none.
    connected();
    // `setDbConsoleText` is what mints the console record — `connected()` only opens the session.
    state().dbActions.setDbConsoleText(CID, "select 1");
    useAppStore.setState((s) => {
      const c = s.dbConsoles[CID];
      if (c) c.cancelError = "stale";
    });
    expect(state().dbConsoles[CID]?.cancelError).toBe("stale");
    state().dbActions.stopWaitingForDbQuery(CID);
    expect(state().dbConsoles[CID]?.cancelError).toBeNull();
  });

  it("a refusal with no detail still says something", async () => {
    // Rust sends `"<code>"` alone for a transport failure — no sentence to pass through. The
    // canned per-code prose is the fallback, and it must not be an empty banner.
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    ipc.dbCancel.mockRejectedValue("network");
    state().dbActions.stopWaitingForDbQuery(CID);
    await vi.waitFor(() => {
      const note = state().dbConsoles[CID]?.cancelError;
      expect(note).toBeTruthy();
      expect(note).not.toBe("network");
    });
  });

  it("a refusal arriving after the console is gone is dropped, not a crash", async () => {
    // Reachable: the cancel is a round trip, and closing the console tab deletes its record. A
    // rejection landing afterwards must not resurrect state for a console nobody is looking at.
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    let rejectCancel: (e: unknown) => void = () => {};
    ipc.dbCancel.mockReturnValue(new Promise<void>((_, rej) => (rejectCancel = rej)));

    state().dbActions.stopWaitingForDbQuery(CID);
    useAppStore.setState((s) => {
      delete s.dbConsoles[CID];
    });
    rejectCancel("unknown: too late");

    await vi.waitFor(() => expect(state().dbConsoles[CID]).toBeUndefined());
  });

  it("does not call db_cancel when there is no open session to cancel on", () => {
    // Stop on a console whose connection was never opened: the local half is all there is, and
    // an invoke with a null session id would be a rejection dressed up as a gesture.
    ipc.dbCancel.mockClear();
    state().dbActions.stopWaitingForDbQuery("never-ran");
    expect(ipc.dbCancel).not.toHaveBeenCalled();
  });

  it("stopping a console that was never opened is a no-op, not a crash", () => {
    // Reachable: `⌘.`-style bindings and a Stop button both fire against whatever console
    // id is active, and a tab restored before the store loaded has no record yet.
    expect(() => state().dbActions.stopWaitingForDbQuery("never-ran")).not.toThrow();
    expect(state().dbConsoles["never-ran"]).toBeUndefined();
  });

  it("running with no console record at all does nothing — there is no buffer to run", async () => {
    connected();
    await state().dbActions.runDbQuery(CID, "statement");
    expect(ipc.dbQuery).not.toHaveBeenCalled();
  });

  it("refuses to run when the CONNECTION is gone, rather than guessing a row limit", async () => {
    // A session can outlive its record for one tick (delete drops the record, then Rust
    // closes the sessions). The row limit is the connection's promise about how much data
    // this query may return, and the engine default is a DIFFERENT number — so there is no
    // safe guess, and the honest move is to refuse.
    useAppStore.setState((s) => {
      s.dbEngines = [ENGINE];
      s.dbSessions[CID] = {
        status: "open",
        sessionId: SID,
        serverVersion: "PostgreSQL 17.2",
        latencyMs: 1,
        error: null,
      };
    });
    state().dbActions.setDbConsoleText(CID, "select 1");
    await state().dbActions.runDbQuery(CID, "statement");

    expect(ipc.dbQuery).not.toHaveBeenCalled();
    expect(state().dbConsoles[CID]?.error?.code).toBe("not-found");
  });
});

describe("the split position", () => {
  it("survives a tab switch and is clamped by the console's own function", () => {
    connected();
    const { unmount } = render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleSplit(CID, 0.72);
    unmount();
    expect(state().dbConsoles[CID]?.splitFraction).toBe(0.72);

    // A NaN flex-grow collapses a pane silently rather than throwing, which is why the
    // store clamps with `clampSplit` rather than storing what it was handed.
    state().dbActions.setDbConsoleSplit(CID, Number.NaN);
    expect(Number.isFinite(state().dbConsoles[CID]?.splitFraction)).toBe(true);
  });
});

/* ───────────────── ⌘/Ctrl+S — save the query ───────────────── */

/** A saved-query record as `db_saved_query_upsert` returns one. */
const SAVED = {
  id: "Q1",
  connectionId: CID,
  name: "Recent tracks",
  sql: "select 1",
  createdAtMs: 1,
  updatedAtMs: 2,
};


/**
 * Focus the real CodeMirror surface, then press the chord.
 *
 * Not `click the wrapper` — a `<div>` is not focusable, so `user.keyboard` would dispatch at
 * `document.body`, OUTSIDE the tab's subtree, and the handler would never see it (an earlier
 * version did exactly that and five tests failed with "Unable to find … db-save-query-dialog").
 * Focusing the editor's `contenteditable` is also the honest scenario: it is where the user's
 * cursor is when they press ⌘S, and it is the element known to swallow a native chord —
 * so this is the assertion that it does not swallow this one.
 */
async function pressChord(
  user: ReturnType<typeof userEvent.setup>,
  chord = "{Meta>}s{/Meta}",
): Promise<void> {
  const content = screen
    .getByTestId("db-query-editor")
    .querySelector(".cm-content") as HTMLElement;
  content.focus();
  await user.keyboard(chord);
}

describe("⌘S in a console", () => {
  it("🔴 with NO saved query yet: opens the name dialog and CREATES on confirm", async () => {
    const user = userEvent.setup();
    connected();
    ipc.dbSavedQueryUpsert.mockResolvedValue(SAVED);

    render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.setDbConsoleText(CID, "select code from tracks");

    await pressChord(user);

    // "Without one, it opens a name dialog and creates" — deliberately the same shape as
    // `saveRequestPrompt`, so ⌘S means the same thing in both surfaces.
    expect(screen.getByTestId("db-save-query-dialog")).toBeInTheDocument();
    // Nothing has been written yet: a keystroke must not create a query called "".
    expect(ipc.dbSavedQueryUpsert).not.toHaveBeenCalled();

    await user.type(screen.getByTestId("db-save-query-name"), "Recent tracks");
    await user.click(screen.getByTestId("db-save-query-confirm"));

    await waitFor(() => expect(ipc.dbSavedQueryUpsert).toHaveBeenCalledTimes(1));
    // 🔴 The exact wire record: `id: null` is what makes this a CREATE, and the SQL is the
    // buffer's — not a stale copy taken when the dialog opened.
    expect(ipc.dbSavedQueryUpsert).toHaveBeenCalledWith({
      id: null,
      connectionId: CID,
      name: "Recent tracks",
      sql: "select code from tracks",
    });
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
    // Adopted, so the next ⌘S updates rather than asking again.
    expect(state().dbConsoles[CID]?.savedQuery).toEqual({ id: "Q1", name: "Recent tracks" });
  });

  it("🔴 with a saved query: UPDATES in place, with no dialog at all", async () => {
    const user = userEvent.setup();
    connected();
    ipc.dbSavedQueryUpsert.mockResolvedValue({ ...SAVED, sql: "select 2", updatedAtMs: 9 });
    useAppStore.setState((s) => {
      s.dbConsoles[CID] = {
        ...blankDbConsole(),
        text: "select 2",
        savedQuery: { id: "Q1", name: "Recent tracks" },
      };
    });

    render(<DbConsoleTab connectionId={CID} />);
    await pressChord(user, "{Control>}s{/Control}");

    await waitFor(() => expect(ipc.dbSavedQueryUpsert).toHaveBeenCalledTimes(1));
    // The id is what distinguishes an update from a create. `queries.rs` refuses a stale id
    // rather than creating a second copy, so getting this wrong is loud — but getting it
    // *omitted* would silently pile up duplicates.
    expect(ipc.dbSavedQueryUpsert).toHaveBeenCalledWith({
      id: "Q1",
      connectionId: CID,
      name: "Recent tracks",
      sql: "select 2",
    });
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
  });

  it("names the adopted query on screen, so ⌘S's meaning is legible", () => {
    connected();
    useAppStore.setState((s) => {
      s.dbConsoles[CID] = {
        ...blankDbConsole(),
        text: "select 1",
        savedQuery: { id: "Q1", name: "Recent tracks" },
      };
    });
    render(<DbConsoleTab connectionId={CID} />);
    expect(screen.getByTestId("db-console-saved-name")).toHaveTextContent("Recent tracks");
    // jsdom is not macOS: the key named is the one this keyboard has.
    expect(screen.getByTestId("db-console-saved-name")).toHaveTextContent(/— Ctrl\+S updates it\.$/);
  });

  it("does nothing on an EMPTY buffer — no dialog, no round trip", async () => {
    const user = userEvent.setup();
    connected();
    state().dbActions.setDbConsoleText(CID, "   \n ");

    render(<DbConsoleTab connectionId={CID} />);
    await pressChord(user);

    // `db_saved_query_upsert` would refuse it anyway ("There is nothing to save"), and a round
    // trip to be told what we already know would surface as an error on a keystroke nobody
    // really meant.
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
    expect(ipc.dbSavedQueryUpsert).not.toHaveBeenCalled();
    expect(await state().dbActions.saveDbConsoleQuery(CID)).toBe("empty");
  });

  it("ignores ⇧⌘S and ⌥⌘S rather than claiming a chord it does not own", async () => {
    const user = userEvent.setup();
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    render(<DbConsoleTab connectionId={CID} />);
    await pressChord(user, "{Meta>}{Shift>}s{/Shift}{/Meta}");
    await pressChord(user, "{Meta>}{Alt>}s{/Alt}{/Meta}");
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
  });

  it("ignores a plain `s` — the modifier is the binding", async () => {
    const user = userEvent.setup();
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    render(<DbConsoleTab connectionId={CID} />);
    await pressChord(user, "s");
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
  });

  it("yields to an already-handled keystroke (defaultPrevented)", () => {
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    render(<DbConsoleTab connectionId={CID} />);

    // The `<SaveRequestShortcut/>` convention, in the other direction: something nearer the
    // event already claimed this keystroke, so the console must not also act on it.
    const handled = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    screen.getByTestId("db-console-tab").dispatchEvent(handled);
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
  });

  it("Escape cancels the dialog; Enter confirms it", async () => {
    const user = userEvent.setup();
    connected();
    ipc.dbSavedQueryUpsert.mockResolvedValue(SAVED);
    state().dbActions.setDbConsoleText(CID, "select 1");
    render(<DbConsoleTab connectionId={CID} />);

    await pressChord(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
    expect(ipc.dbSavedQueryUpsert).not.toHaveBeenCalled();

    await pressChord(user);
    // Enter with a blank name does nothing — the same condition that disables Save, rather
    // than letting the user press it and be refused by Rust.
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("db-save-query-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("db-save-query-confirm")).toBeDisabled();

    await user.type(screen.getByTestId("db-save-query-name"), "Recent tracks{Enter}");
    await waitFor(() => expect(ipc.dbSavedQueryUpsert).toHaveBeenCalledTimes(1));
  });

  it("the Cancel button closes it too", async () => {
    const user = userEvent.setup();
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    render(<DbConsoleTab connectionId={CID} />);
    await pressChord(user);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
    expect(state().dbSaveQueryPrompt).toBeNull();
  });

  it("🔴 a REFUSED save is one honest sentence, and the buffer is untouched", async () => {
    const user = userEvent.setup();
    connected();
    // What `queries.rs` does with a stale id: refuse, rather than create a second copy.
    ipc.dbSavedQueryUpsert.mockRejectedValue(
      "invalid-config: That saved query no longer exists (`Q1`).",
    );
    useAppStore.setState((s) => {
      s.dbConsoles[CID] = {
        ...blankDbConsole(),
        text: "select 2",
        savedQuery: { id: "Q1", name: "Recent tracks" },
      };
    });

    render(<DbConsoleTab connectionId={CID} />);
    await pressChord(user);

    await waitFor(() =>
      expect(screen.getByTestId("db-console-save-error")).toHaveTextContent(
        "These connection settings cannot be used as they stand — check the host, the port, and the settings this engine requires.",
      ),
    );
    // Rust's raw string never reaches the screen, and the user's SQL is still there —
    // a failed save that cleared the editor would be the worst outcome available.
    expect(screen.getByTestId("db-console-save-error")).not.toHaveTextContent("Q1");
    expect(state().dbConsoles[CID]?.text).toBe("select 2");
  });

  it("🔴 SHOWS why a cancel was refused, above the console", async () => {
    // The store half is tested elsewhere; this is the half the user sees. It sits above the
    // console, not inside it, for the same reason a save error does: it must not clear or cover
    // the results — the query did not fail, and may well still be running.
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    ipc.dbCancel.mockRejectedValue("unknown: This engine has no server-side cancel.");

    render(<DbConsoleTab connectionId={CID} />);
    state().dbActions.stopWaitingForDbQuery(CID);

    await waitFor(() =>
      expect(screen.getByTestId("db-console-cancel-error")).toHaveTextContent(
        "This engine has no server-side cancel.",
      ),
    );
    // `role="status"`, not `alert`: it is information about a gesture, not an error condition.
    expect(screen.getByTestId("db-console-cancel-error")).toHaveAttribute("role", "status");
    // The buffer survives — a Stop that cleared the editor would be unforgivable.
    expect(state().dbConsoles[CID]?.text).toBe("select 1");
  });

  it("shows no cancel notice when there is nothing to say", () => {
    connected();
    state().dbActions.setDbConsoleText(CID, "select 1");
    render(<DbConsoleTab connectionId={CID} />);
    expect(screen.queryByTestId("db-console-cancel-error")).not.toBeInTheDocument();
  });

  it("shows no dialog for ANOTHER connection's prompt", () => {
    connected();
    useAppStore.setState((s) => {
      s.dbSaveQueryPrompt = { connectionId: "someone-else", sql: "select 9" };
    });
    render(<DbConsoleTab connectionId={CID} />);
    // Two consoles in a split both read the one prompt; without the id check the same modal
    // would render twice, over the wrong console.
    expect(screen.queryByTestId("db-save-query-dialog")).toBeNull();
  });

  it("confirming with no prompt open is a no-op, not a query against a guessed connection", async () => {
    connected();
    await state().dbActions.confirmDbSaveQueryName("Whatever");
    expect(ipc.dbSavedQueryUpsert).not.toHaveBeenCalled();
  });

  it("saving a console that has no record yet does nothing", async () => {
    connected();
    expect(await state().dbActions.saveDbConsoleQuery(CID)).toBe("empty");
    expect(ipc.dbSavedQueryUpsert).not.toHaveBeenCalled();
  });

  it("a create lands at the FRONT of the list, where a reload would put it", async () => {
    connected();
    useAppStore.setState((s) => {
      s.dbSavedQueries[CID] = {
        queries: [{ ...SAVED, id: "Q0", name: "older", updatedAtMs: 1 }],
        loading: false,
        error: null,
      };
    });
    ipc.dbSavedQueryUpsert.mockResolvedValue({ ...SAVED, id: "Q9", name: "newest" });

    await state().dbActions.upsertDbSavedQuery(CID, null, "newest", "select 1");

    // Newest-updated first is `queries::for_connection`'s order, so the optimistic insert and
    // the next real read agree — otherwise the row would jump on the next load.
    expect(state().dbSavedQueries[CID]?.queries.map((q) => q.id)).toEqual(["Q9", "Q0"]);
  });

  it("an update replaces in place, so the row does not jump", async () => {
    connected();
    useAppStore.setState((s) => {
      s.dbSavedQueries[CID] = {
        queries: [
          { ...SAVED, id: "Q1", name: "first" },
          { ...SAVED, id: "Q2", name: "second" },
        ],
        loading: false,
        error: null,
      };
    });
    ipc.dbSavedQueryUpsert.mockResolvedValue({ ...SAVED, id: "Q2", name: "renamed" });

    await state().dbActions.upsertDbSavedQuery(CID, "Q2", "renamed", "select 3");

    expect(state().dbSavedQueries[CID]?.queries.map((q) => q.name)).toEqual([
      "first",
      "renamed",
    ]);
  });

  it("🔴 deleting the query a console is editing makes the console FORGET its id", async () => {
    connected();
    ipc.dbSavedQueryDelete.mockResolvedValue(true);
    useAppStore.setState((s) => {
      s.dbConsoles[CID] = {
        ...blankDbConsole(),
        text: "select 1",
        savedQuery: { id: "Q1", name: "Recent tracks" },
      };
    });

    await state().dbActions.deleteDbSavedQuery(CID, "Q1");

    // Otherwise the next ⌘S hits `queries.rs`'s stale-id refusal and reports a save failure
    // for a query the user deliberately deleted.
    expect(state().dbConsoles[CID]?.savedQuery).toBeNull();
  });

  it("deleting a DIFFERENT query leaves the console's identity alone", async () => {
    connected();
    ipc.dbSavedQueryDelete.mockResolvedValue(true);
    useAppStore.setState((s) => {
      s.dbConsoles[CID] = {
        ...blankDbConsole(),
        savedQuery: { id: "Q1", name: "Recent tracks" },
      };
    });

    await state().dbActions.deleteDbSavedQuery(CID, "Q2");

    expect(state().dbConsoles[CID]?.savedQuery).toEqual({ id: "Q1", name: "Recent tracks" });
  });

  it("deleting from a connection with no console record at all is not a crash", async () => {
    ipc.dbSavedQueryDelete.mockResolvedValue(true);
    await state().dbActions.deleteDbSavedQuery("never-opened", "Q1");
    expect(state().dbSavedQueries["never-opened"]?.queries).toEqual([]);
  });
});

describe("deleting the connection while its save dialog is open", () => {
  it("🔴 closes the dialog, because a saved query for a deleted connection is born an orphan", async () => {
    connected();
    ipc.dbConnectionDelete.mockResolvedValue({ removed: true, savedQueriesRemoved: 0 });
    state().dbActions.setDbConsoleText(CID, "select 1");
    expect(await state().dbActions.saveDbConsoleQuery(CID)).toBe("prompted");

    await state().dbActions.deleteDbConnection(CID);

    // `db_saved_query_upsert` does not check that `connectionId` names a live connection, so
    // confirming this dialog would have written a query nothing can ever list or run.
    expect(state().dbSaveQueryPrompt).toBeNull();
    expect(state().dbConsoles[CID]).toBeUndefined();
  });

  it("leaves ANOTHER connection's dialog open", async () => {
    connected();
    ipc.dbConnectionDelete.mockResolvedValue({ removed: true, savedQueriesRemoved: 0 });
    useAppStore.setState((s) => {
      s.dbSaveQueryPrompt = { connectionId: "other", sql: "select 9" };
    });

    await state().dbActions.deleteDbConnection(CID);

    expect(state().dbSaveQueryPrompt).toEqual({ connectionId: "other", sql: "select 9" });
  });

  it("🔴 saves the SQL the keystroke was about, not a later read of the console", async () => {
    connected();
    ipc.dbSavedQueryUpsert.mockResolvedValue(SAVED);
    state().dbActions.setDbConsoleText(CID, "select 1 -- what I pressed save on");
    await state().dbActions.saveDbConsoleQuery(CID);

    // Something changes the buffer while the modal is up (a `openDbQueryInConsole` from the
    // tree, say). The dialog must still save what the user asked to save.
    state().dbActions.setDbConsoleText(CID, "DROP TABLE tracks");
    await state().dbActions.confirmDbSaveQueryName("Mine");

    expect(ipc.dbSavedQueryUpsert).toHaveBeenCalledWith({
      id: null,
      connectionId: CID,
      name: "Mine",
      sql: "select 1 -- what I pressed save on",
    });
  });
});
