/**
 * `<DbPanel/>` — the DB rail tab.
 *
 * This is the file that proves the feature is WIRED: the dialog was props-only, and every
 * assertion below about `db_test_connection` / `db_connection_upsert` / `db_url_build` /
 * `db_url_parse` being called is an assertion that the panel supplied a real promise where
 * a prop used to be.
 *
 * `dbIpc` is mocked at the module boundary rather than through `installTauriMock`, because
 * the store slice imports it too — one mock covers both halves of the path (the panel's
 * direct calls for the dialog, and the store's for load/upsert/connect), and the argument
 * NAMES are already pinned exhaustively by `dbIpc.test.ts` against the real `invoke`.
 *
 * The claim this file is most careful about is the honest one: expanding a connection
 * connects and shows the server version, and says **in words** that the object tree is not
 * here yet. A test that only checked "something rendered" would be equally happy with a
 * fake tree, which is exactly the outcome to rule out.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbIpc = vi.hoisted(() => ({
  connectionInput: vi.fn((draft: unknown, id: unknown) => ({ ...(draft as object), id })),
  connectionAsInput: vi.fn((c: object) => ({ ...c, caPath: null })),
  dbEngines: vi.fn(),
  dbConnectionsLoad: vi.fn(),
  dbConnectionUpsert: vi.fn(),
  dbConnectionDelete: vi.fn(),
  dbTestConnection: vi.fn(),
  dbOpen: vi.fn(),
  dbClose: vi.fn(),
  dbUrlBuild: vi.fn(),
  dbUrlParse: vi.fn(),
  dbQuery: vi.fn(),
  // The tree's and the saved queries' edge. Present in this mock because `<DbTree/>` now
  // mounts inside every expanded row, so a panel test that did not stub these would hit an
  // undefined function on the first expand (a component that fetches on mount adds a mock
  // requirement to every tier that renders its host).
  dbChildren: vi.fn(),
  dbSavedQueries: vi.fn(),
  dbSavedQueryUpsert: vi.fn(),
  dbSavedQueryDelete: vi.fn(),
}));
vi.mock("./dbIpc", () => dbIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { DbPanel, agentNoticeText, connectionSubtitle, sessionLine, sessionTitle } from "./DbPanel";
import { POSTGRES_ENGINE, REDIS_ENGINE } from "./dbFixtures";
import { describeDbError } from "./dbErrors";
import type { DbConnection } from "./types";

const conn = (over: Partial<DbConnection> = {}): DbConnection => ({
  id: "c1",
  name: "Prod Postgres",
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
  ...over,
});

const OK_PROBE = { ok: true, serverVersion: "PostgreSQL 17.2", latencyMs: 34, error: null };

/**
 * What `db_open` returns — the session AND what answered, in **one** dial.
 *
 * Expanding a row used to cost a probe *and* an open: two TLS handshakes, two authentications, the
 * first connection discarded purely to learn the version string. `OK_PROBE` stays for the dialog's
 * Test Connection button, which asks about an unsaved draft and genuinely has no session to open.
 */
const OPENED = { sessionId: "sess-1", serverVersion: "PostgreSQL 17.2", latencyMs: 34 };

/** Render and wait for the one-shot hydrate to land. */
async function mount(): Promise<void> {
  render(<DbPanel />);
  await waitFor(() => expect(useAppStore.getState().dbLoaded).toBe(true));
}

beforeEach(() => {
  resetStore();
  for (const fn of Object.values(dbIpc)) {
    if ("mockReset" in fn) fn.mockReset();
  }
  dbIpc.connectionInput.mockImplementation((draft, id) => ({ ...(draft as object), id }));
  dbIpc.connectionAsInput.mockImplementation((c) => ({ ...c, caPath: null }));
  dbIpc.dbEngines.mockResolvedValue([POSTGRES_ENGINE, REDIS_ENGINE]);
  dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [], version: 1 });
  dbIpc.dbUrlBuild.mockResolvedValue("postgresql://ro@db.internal:5432/maestro");
  dbIpc.dbClose.mockResolvedValue(undefined);
  dbIpc.dbChildren.mockResolvedValue([]);
  dbIpc.dbSavedQueries.mockResolvedValue([]);
});
afterEach(cleanup);

/* ───────────────────────────── the list ──────────────────────────────────── */

describe("DbPanel — the saved-connection list", () => {
  it("hydrates the store once on mount", async () => {
    await mount();
    expect(dbIpc.dbEngines).toHaveBeenCalledTimes(1);
    expect(dbIpc.dbConnectionsLoad).toHaveBeenCalledTimes(1);
  });

  it("says what an empty panel means, and how to leave it", async () => {
    await mount();
    expect(screen.getByTestId("db-panel-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("db-connection-list")).toBeNull();
  });

  it("renders a row with the engine's LABEL and where it points", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
    await mount();

    const row = screen.getByTestId("db-connection-row");
    expect(row).toHaveTextContent("Prod Postgres");
    // The descriptor's label, not the raw engine id — `postgres` is a wire value.
    expect(row).toHaveTextContent("PostgreSQL");
    expect(row).toHaveTextContent("db.internal:5432/maestro");
  });

  it("falls back to the raw engine id for an engine this build does not offer", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({
      connections: [conn({ engine: "clickhouse" })],
      version: 1,
    });
    await mount();
    // Naming the unknown engine beats rendering a blank cell: the user needs to know
    // WHICH driver is missing.
    expect(screen.getByTestId("db-connection-row")).toHaveTextContent("clickhouse");
  });

  it("badges a read-only connection, and says what the flag is WORTH on that engine", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({
      connections: [conn({ id: "pg" }), conn({ id: "rd", engine: "redis", name: "Cache" })],
      version: 1,
    });
    await mount();

    // The guardrail must be visible where you CHOOSE the connection.
    expect(screen.getByTestId("db-row-readonly-pg")).toHaveTextContent("read-only");
    expect(screen.getByTestId("db-row-readonly-pg")).toHaveAttribute(
      "title",
      "Read-only. PostgreSQL enforces this at the server for the whole session.",
    );
    // Redis has no server-side read-only mode, so the badge must NOT imply a boundary the
    // engine cannot keep — literal, so a reassuring rewrite fails here.
    expect(screen.getByTestId("db-row-readonly-rd")).toHaveAttribute(
      "title",
      "Read-only. Redis has no server-side read-only mode, so this is a client-side speed bump, not a guarantee — for a real boundary, connect as a read-only database user.",
    );
  });

  it("shows no badge when read-only is OFF — the badge is a claim, not decoration", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({
      connections: [conn({ readOnly: false })],
      version: 1,
    });
    await mount();
    expect(screen.queryByTestId("db-row-readonly-c1")).toBeNull();
  });

  it("surfaces a panel-level failure as one mapped sentence", async () => {
    dbIpc.dbConnectionsLoad.mockRejectedValue("unknown: could not read the store");
    render(<DbPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("db-panel-error")).toHaveTextContent(
        describeDbError("unknown"),
      ),
    );
    // Still usable: a failed load must not hide the "New connection" affordance.
    expect(screen.getByTestId("db-new-connection")).toBeInTheDocument();
  });
});

/* ─────────────────────── connect and mount the tree ─────────────────────── */

describe("DbPanel — expanding a connection", () => {
  beforeEach(() => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
  });

  it("🔴 connects, shows version AND latency, and mounts the REAL tree over db_children", async () => {
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    dbIpc.dbChildren.mockResolvedValue([
      {
        nodeRef: { kind: "database", name: "maestro" },
        label: "maestro",
        subLabel: "the connected database",
        kind: "database",
        expandable: true,
      },
    ]);
    await mount();

    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));

    await waitFor(() =>
      expect(screen.getByTestId("db-row-session-c1")).toHaveTextContent(
        "PostgreSQL 17.2 · 34 ms",
      ),
    );
    // `db_open` really ran — the session is live, not just probed.
    expect(dbIpc.dbOpen).toHaveBeenCalledWith("c1", null);
    expect(useAppStore.getState().dbSessions.c1.sessionId).toBe("sess-1");

    // 🔴 The claim this panel used to make in prose ("the object tree needs a command this
    // build does not have") is now a claim about the DOM: the tree is here, it asked the real
    // command with the real session id, and it rendered what came back — including the
    // sub-label, which is the field a `ref`-vs-`nodeRef` contract slip would have blanked.
    await waitFor(() => expect(screen.getByTestId("db-tree-c1")).toBeInTheDocument());
    expect(dbIpc.dbChildren).toHaveBeenCalledWith("sess-1", { kind: "root" });
    await waitFor(() => expect(screen.getByText("maestro")).toBeInTheDocument());
    expect(screen.getByText("the connected database")).toBeInTheDocument();
  });

  it("offers the query console only once a session is actually open", async () => {
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    await mount();
    expect(screen.queryByRole("button", { name: "Open query console" })).toBeNull();

    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open query console" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open query console" }));
    const tabs = Object.values(useAppStore.getState().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].ref).toEqual({ kind: "db-console", connectionId: "c1" });
  });

  it("shows a failed connect as a calm inline note, with no console offered", async () => {
    // Rust's own mapped + redacted sentence, which the store now renders from the rejection's
    // detail rather than from a separate probe result.
    dbIpc.dbOpen.mockRejectedValue("network: Could not reach db.internal on port 5432.");
    await mount();

    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));

    await waitFor(() =>
      expect(screen.getByTestId("db-row-session-c1")).toHaveTextContent(
        "Could not reach db.internal on port 5432.",
      ),
    );
    // A failed expand is an inline note, never a panel-level error — a dropped VPN
    // must not take the rail down.
    expect(screen.queryByTestId("db-panel-error")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open query console" })).toBeNull();
    expect(
      screen.getByTestId("db-row-session-c1").querySelector('[data-tone="bad"]'),
    ).not.toBeNull();
    // No session, so no catalogue query was attempted — and the tree says which half is
    // unavailable rather than rendering as empty. The saved queries are still listed, which
    // is the whole point: they do not need a reachable database.
    expect(dbIpc.dbChildren).not.toHaveBeenCalled();
    expect(screen.getByTestId("db-tree-no-session")).toBeInTheDocument();
    expect(dbIpc.dbSavedQueries).toHaveBeenCalledWith("c1");
  });

  it("shows a pending state while the connect is in flight", async () => {
    let release!: (v: typeof OPENED) => void;
    dbIpc.dbOpen.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await mount();

    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));
    await waitFor(() =>
      expect(screen.getByTestId("db-row-session-c1")).toHaveTextContent("Connecting…"),
    );
    // No tone while pending: neither "ok" nor "bad" is true yet.
    expect(
      screen.getByTestId("db-row-session-c1").querySelector("[data-tone]"),
    ).toBeNull();

    release(OPENED);
    await waitFor(() =>
      expect(screen.getByTestId("db-row-session-c1")).toHaveTextContent("17.2"),
    );
  });

  /* ── the manual Refresh (the stale-tree escape hatch) ─────────────────────── */

  it("🔴 Refresh re-reads the tree — the only way to see an edit made OUTSIDE this app", async () => {
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    dbIpc.dbChildren.mockResolvedValueOnce([
      {
        nodeRef: { kind: "database", name: "maestro" },
        label: "maestro",
        subLabel: "the connected database",
        kind: "database",
        expandable: true,
      },
    ]);
    await mount();
    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));
    await waitFor(() => expect(screen.getByText("maestro")).toBeInTheDocument());
    expect(dbIpc.dbChildren).toHaveBeenCalledTimes(1);

    // Somebody else created a database while we were looking at the rail — from psql, from
    // another session, from a colleague's machine. The app cannot know, which is the entire
    // reason this button exists and why the automatic post-write refresh is not enough.
    dbIpc.dbChildren.mockResolvedValueOnce([
      {
        nodeRef: { kind: "database", name: "maestro" },
        label: "maestro",
        subLabel: "the connected database",
        kind: "database",
        expandable: true,
      },
      {
        nodeRef: { kind: "database", name: "legacy" },
        label: "legacy",
        subLabel: null,
        kind: "database",
        expandable: true,
      },
    ]);

    fireEvent.click(screen.getByTestId("db-row-refresh-c1"));

    await waitFor(() => expect(screen.getByText("legacy")).toBeInTheDocument());
    expect(dbIpc.dbChildren).toHaveBeenCalledTimes(2);
    expect(dbIpc.dbChildren).toHaveBeenNthCalledWith(2, "sess-1", { kind: "root" });
    // Reachable by name, not only by test id: the button has to be findable by a screen
    // reader and by a keyboard user, and "Refresh" alone would not say refresh WHAT.
    expect(screen.getByRole("button", { name: "Refresh Prod Postgres" })).toBeEnabled();
  });

  it("Refresh is present but DISABLED while the connect is still in flight", async () => {
    dbIpc.dbOpen.mockReturnValue(new Promise(() => {}));
    await mount();

    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));

    await waitFor(() =>
      expect(screen.getByTestId("db-row-session-c1")).toHaveTextContent("Connecting…"),
    );
    // Present, so its place in the chrome is learnable, and disabled, because every level it
    // would re-read is answered by `db_children` — which takes a session id we do not have.
    expect(screen.getByTestId("db-row-refresh-c1")).toBeDisabled();
    fireEvent.click(screen.getByTestId("db-row-refresh-c1"));
    expect(dbIpc.dbChildren).not.toHaveBeenCalled();
  });

  it("Refresh is DISABLED after a failed connect, where the tree has no session either", async () => {
    dbIpc.dbOpen.mockRejectedValue("network: Could not reach db.internal on port 5432.");
    await mount();

    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));

    await waitFor(() => expect(screen.getByTestId("db-tree-no-session")).toBeInTheDocument());
    expect(screen.getByTestId("db-row-refresh-c1")).toBeDisabled();
  });

  it("the disclosure IS the connect gesture: clicking it again disconnects", async () => {
    dbIpc.dbOpen.mockResolvedValue(OPENED);
    await mount();

    const toggle = () => screen.getByTestId("db-row-toggle-c1");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveAttribute("aria-label", "Connect Prod Postgres");

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-expanded", "true"));
    expect(toggle()).toHaveAttribute("aria-label", "Disconnect Prod Postgres");

    fireEvent.click(toggle());
    await waitFor(() => expect(dbIpc.dbClose).toHaveBeenCalledWith("sess-1"));
    expect(screen.queryByTestId("db-row-session-c1")).toBeNull();
  });
});

/* ─────────────────────────── delete ─────────────────────────────────────── */

describe("DbPanel — delete", () => {
  it("deletes through Rust and drops the row", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
    dbIpc.dbConnectionDelete.mockResolvedValue({ removed: true, savedQueriesRemoved: 0 });
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Delete Prod Postgres" }));

    await waitFor(() => expect(screen.queryByTestId("db-connection-row")).toBeNull());
    expect(dbIpc.dbConnectionDelete).toHaveBeenCalledWith("c1");
  });
});

/* ──────────────────────── the dialog, really wired ───────────────────────── */

describe("DbPanel — the connection dialog's four callbacks", () => {
  it("opens a NEW-connection dialog, and builds its URL preview through db_url_build", async () => {
    await mount();

    fireEvent.click(screen.getByTestId("db-new-connection"));

    expect(screen.getByTestId("db-connection-dialog")).toBeInTheDocument();
    // By ROLE: "New connection" is also the panel's own button, so a bare text lookup is
    // ambiguous — and the dialog's accessible name is what `aria-labelledby` points at.
    expect(screen.getByRole("heading", { name: "New connection" })).toBeInTheDocument();
    // The preview is a real IPC round trip now, not a prop a test supplied.
    await waitFor(() => expect(dbIpc.dbUrlBuild).toHaveBeenCalled());
    // A NEW connection sends `port: null` — the descriptor's default is a placeholder in the
    // box, never a value (a port nobody entered must not appear).
    expect(dbIpc.dbUrlBuild.mock.calls[0][0]).toMatchObject({
      engine: "postgres",
      id: null,
      port: null,
    });
    await waitFor(() =>
      expect(screen.getByTestId("db-url")).toHaveValue("postgresql://ro@db.internal:5432/maestro"),
    );
  });

  it("opens an EDIT dialog seeded from the saved record, carrying its id", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Edit Prod Postgres" }));

    expect(screen.getByText("Edit connection")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("db.internal");
    // The id travels, so Rust updates in place instead of minting a second record.
    await waitFor(() =>
      expect(dbIpc.dbUrlBuild.mock.calls[0][0]).toMatchObject({ id: "c1" }),
    );
  });

  it("tests the connection through db_test_connection, with the password OUT OF BAND", async () => {
    dbIpc.dbTestConnection.mockResolvedValue(OK_PROBE);
    await mount();
    fireEvent.click(screen.getByTestId("db-new-connection"));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Local" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "127.0.0.1" } });
    fireEvent.change(screen.getByTestId("db-password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByTestId("db-test"));

    await waitFor(() =>
      expect(screen.getByTestId("db-test-result")).toHaveTextContent(
        "PostgreSQL 17.2 · 34 ms",
      ),
    );
    const [input, password] = dbIpc.dbTestConnection.mock.calls[0];
    expect(password).toBe("hunter2");
    // The secret is a separate argument and is NOT in the record — asserted on the
    // serialised object, because a type cannot fail at runtime.
    expect(JSON.stringify(input)).not.toContain("hunter2");
  });

  it("saves through db_connection_upsert, adopts Rust's record, and closes", async () => {
    dbIpc.dbConnectionUpsert.mockResolvedValue(conn({ id: "minted", name: "Local" }));
    await mount();
    fireEvent.click(screen.getByTestId("db-new-connection"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Local" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "127.0.0.1" } });
    fireEvent.change(screen.getByTestId("db-password"), { target: { value: "hunter2" } });

    fireEvent.click(screen.getByTestId("db-save"));

    await waitFor(() => expect(screen.queryByTestId("db-connection-dialog")).toBeNull());
    const [input, password] = dbIpc.dbConnectionUpsert.mock.calls[0];
    expect(password).toBe("hunter2");
    expect(JSON.stringify(input)).not.toContain("hunter2");
    // The row now shows the record RUST returned, ids and timestamps included.
    expect(screen.getByTestId("db-connection-row")).toHaveAttribute("data-id", "minted");
  });

  it("keeps the dialog OPEN on a failed save and shows one mapped sentence", async () => {
    dbIpc.dbConnectionUpsert.mockRejectedValue("invalid-config: Host is required.");
    await mount();
    fireEvent.click(screen.getByTestId("db-new-connection"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Local" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "127.0.0.1" } });

    fireEvent.click(screen.getByTestId("db-save"));

    await waitFor(() =>
      expect(screen.getByTestId("db-save-error")).toHaveTextContent(
        describeDbError("invalid-config"),
      ),
    );
    // Closing on failure is how a form loses ten minutes of typing.
    expect(screen.getByTestId("db-connection-dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("127.0.0.1");
    // And Rust's own words are NOT on screen (a driver string can carry a DSN).
    expect(screen.queryByText(/Host is required/)).toBeNull();
  });

  it("parses a pasted string through db_url_parse and keeps `?password=` under its own name", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
    dbIpc.dbUrlParse.mockResolvedValue({
      engine: "postgres",
      family: "postgres",
      host: "new.internal",
      port: 6543,
      database: "maestro",
      user: "ro",
      hadPassword: true,
      passwordParam: "password",
      sslMode: null,
      url: "postgresql://ro@new.internal:6543/maestro",
      options: {},
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit Prod Postgres" }));

    fireEvent.paste(screen.getByTestId("db-url"), {
      clipboardData: {
        getData: () => "postgresql://ro@new.internal:6543/maestro?password=hunter2",
      },
    });

    await waitFor(() => expect(screen.getByLabelText("Host")).toHaveValue("new.internal"));
    expect(dbIpc.dbUrlParse).toHaveBeenCalledWith(
      "postgresql://ro@new.internal:6543/maestro?password=hunter2",
    );
    // The end-to-end version of the `engineFields` unit test: the reference is back in the
    // `password` PARAMETER in the rendered box, not in the userinfo.
    await waitFor(() =>
      expect(screen.getByTestId("db-url")).toHaveValue(
        "postgresql://ro@new.internal:6543/maestro?password={{PG_PASSWORD}}",
      ),
    );
    // The pasted string went STRAIGHT to `db_url_parse` — the `preventDefault` in the paste
    // handler is what keeps the literal out of the box, out of React state and out of the DOM.
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("warns about a `?pwd=` that will round-trip and still not authenticate", async () => {
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
    dbIpc.dbUrlParse.mockResolvedValue({
      engine: "postgres",
      family: "postgres",
      host: "db.internal",
      port: 5432,
      database: "maestro",
      user: "ro",
      hadPassword: true,
      passwordParam: "pwd",
      sslMode: null,
      url: "postgresql://ro@db.internal:5432/maestro",
      options: {},
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit Prod Postgres" }));

    fireEvent.paste(screen.getByTestId("db-url"), {
      clipboardData: { getData: () => "postgresql://ro@db.internal:5432/maestro?pwd=x" },
    });

    // Surfaced in the UI, not hidden in a comment: the caveat is measured
    // (sqlx-postgres 0.9 logs `ignoring unrecognized connect parameter`), and the failure
    // it predicts is otherwise an auth error with no visible cause.
    await waitFor(() =>
      expect(screen.getByTestId("db-notices")).toHaveTextContent(
        /will still not authenticate/,
      ),
    );
    expect(screen.getByTestId("db-notices")).toHaveTextContent(/`pwd=`/);
  });

  it("cancels without saving", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("db-new-connection"));
    fireEvent.click(screen.getByTestId("db-cancel"));
    expect(screen.queryByTestId("db-connection-dialog")).toBeNull();
    expect(dbIpc.dbConnectionUpsert).not.toHaveBeenCalled();
  });
});

/* ───────────────────────── the pure row helpers ──────────────────────────── */

describe("connectionSubtitle", () => {
  it("reads host:port/database", () => {
    expect(connectionSubtitle(conn())).toBe("db.internal:5432/maestro");
  });

  it("omits the database rather than leaving a trailing slash", () => {
    // `databaseLabel: null` engines genuinely have no database, and `host:port/` would
    // read as an empty one.
    expect(connectionSubtitle(conn({ database: "" }))).toBe("db.internal:5432");
  });
});

describe("sessionLine", () => {
  const line = (over: Partial<Parameters<typeof sessionLine>[0]>) =>
    sessionLine({
      status: "open",
      serverVersion: null,
      latencyMs: null,
      error: null,
      ...over,
    });

  it("shows the version AND the latency on success", () => {
    expect(line({ serverVersion: "PostgreSQL 17.2", latencyMs: 34 })).toBe(
      "PostgreSQL 17.2 · 34 ms",
    );
  });

  it("degrades to the version alone rather than printing a null latency", () => {
    expect(line({ serverVersion: "Redis 7.4", latencyMs: null })).toBe("Redis 7.4");
  });

  it("says only `Connected` when the server gave no version — never invents one", () => {
    expect(line({ serverVersion: null, latencyMs: 12 })).toBe("Connected · 12 ms");
  });

  it("is a pending sentence while opening", () => {
    expect(line({ status: "opening" })).toBe("Connecting…");
  });

  it("shows the failure, and admits when there was no reason to show", () => {
    expect(line({ status: "error", error: "Could not reach db.internal." })).toBe(
      "Could not reach db.internal.",
    );
    expect(line({ status: "error", error: null })).toBe(
      "The connection failed, and no reason was reported.",
    );
  });
});

/**
 * What the number beside the version measures — and why it needs saying.
 *
 * `DbOpened.latencyMs` is the **whole open** (DNS, TLS, auth, version query), not a round trip. On
 * a remote cluster those differ by an order of magnitude: a remote connect can take 5000 ms
 * with almost none of it time on the wire. A bare `· 5000 ms` reads as latency and would be
 * badly misread, so the meaning is in the tooltip.
 */
describe("sessionTitle — the latency number explains itself", () => {
  it("explains the number only when there is one", () => {
    expect(sessionTitle({ status: "open", latencyMs: 5000 })).toContain("took to open");
    expect(sessionTitle({ status: "open", latencyMs: 5000 })).toContain("authentication");
    // Nothing to explain: no number.
    expect(sessionTitle({ status: "open", latencyMs: null })).toBeUndefined();
    // …and no explanation over a state that is already a sentence.
    expect(sessionTitle({ status: "opening", latencyMs: null })).toBeUndefined();
    expect(sessionTitle({ status: "error", latencyMs: null })).toBeUndefined();
  });

  it("reaches the DOM on the connected row", async () => {
    // This block sits outside the "expanding a connection" describe, so it does its own hydrate —
    // the row does not exist otherwise.
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn()], version: 1 });
    dbIpc.dbOpen.mockResolvedValue({ ...OPENED, latencyMs: 5000 });
    await mount();

    fireEvent.click(screen.getByTestId("db-row-toggle-c1"));
    await waitFor(() =>
      expect(screen.getByTestId("db-row-session-c1")).toHaveTextContent("5000 ms"),
    );
    expect(
      screen.getByTestId("db-row-session-c1").querySelector("[title]"),
    ).toHaveAttribute("title", expect.stringContaining("took to open"));
  });
});

/* ─────────────────── a connection an agent added (agent-studio db connect) ─────────────────── */

describe("DbPanel — a connection an agent added", () => {
  const agentNamed = (title: string, customTitle: string | null = null): void =>
    useAppStore.setState((s) => {
      (s.agents as Record<string, unknown>)["t1"] = { id: "t1", title, customTitle };
    });

  it("says who added which connection, and that it is read-only", () => {
    expect(agentNoticeText({ created: true, agent: "claude · shop" }, conn())).toBe(
      'The agent "claude · shop" added "Prod Postgres". It is read-only: use Edit to allow writes.',
    );
    expect(agentNoticeText({ created: true, agent: null }, conn({ readOnly: false }))).toBe(
      'An agent added "Prod Postgres".',
    );
    expect(agentNoticeText({ created: false, agent: null }, conn())).toBe(
      'An agent opened "Prod Postgres", which was already saved. Nothing changed.',
    );
    // Before the reload lands the record is not in the list yet.
    expect(agentNoticeText({ created: true, agent: null }, null)).toBe(
      "An agent added a connection. It is read-only: use Edit to allow writes.",
    );
  });

  it("brings the DB tab into view, re-arms both stores Rust wrote, and reloads the list", async () => {
    await mount();
    useAppStore.setState((s) => {
      s.rightRailTab = "files";
      s.rightRailCollapsed = true;
      s.apiStoreLoaded = true;
    });
    agentNamed("claude · shop");
    dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [conn({ id: "c9" })], version: 1 });

    useAppStore
      .getState()
      .dbActions.showAgentDbConnection({ connectionId: "c9", terminalId: "t1", created: true });

    const s = useAppStore.getState();
    expect(s.rightRailTab).toBe("db");
    expect(s.rightRailCollapsed).toBe(false);
    // The Vault (api-store.json) was written under the API slice: its gate must not say current.
    expect(s.apiStoreLoaded).toBe(false);
    expect(s.dbAgentNotice).toEqual({ connectionId: "c9", created: true, agent: "claude · shop" });
    await waitFor(() => expect(dbIpc.dbConnectionsLoad).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(
        'The agent "claude · shop" added "Prod Postgres". It is read-only: use Edit to allow writes.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("db-agent-notice-dismiss"));
    expect(useAppStore.getState().dbAgentNotice).toBeNull();
    expect(screen.queryByTestId("db-agent-notice")).toBeNull();
  });

  it("prefers the agent's custom name, and says 'an agent' for a terminal it does not know", () => {
    agentNamed("claude · shop", "Data helper");
    const { showAgentDbConnection } = useAppStore.getState().dbActions;
    showAgentDbConnection({ connectionId: "c9", terminalId: "t1", created: false });
    expect(useAppStore.getState().dbAgentNotice?.agent).toBe("Data helper");
    showAgentDbConnection({ connectionId: "c9", terminalId: "unknown", created: true });
    expect(useAppStore.getState().dbAgentNotice?.agent).toBeNull();
  });
});
