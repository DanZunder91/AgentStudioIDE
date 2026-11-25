/**
 * DbPanel — the right rail's **DB** tab.
 *
 * The saved-connection list, and the one place the connection dialog is opened from. This
 * is the component that turns the props-only `<ConnectionDialog/>` into a working feature:
 * it hands it the four real callbacks (`db_test_connection`, `db_connection_upsert`,
 * `db_url_build`, `db_url_parse`) and the engine registry from `db_engines`.
 *
 * ── What expanding a connection does ─────────────────────────────────────────
 * It **connects**, and shows what connecting proves: the server's own version string and the
 * round-trip latency — and then it renders `<DbTree/>`, the real object tree over
 * `db_children`, plus that connection's saved queries.
 *
 * An older build rendered a paragraph here saying the tree needed a command this build
 * did not have. That had stopped being true: `db_children` and the saved-query trio were
 * registered in `src-tauri/src/lib.rs`, tested in Rust, and unreachable from the UI. A note
 * explaining why a feature is missing has an expiry date, and nothing was watching this one.
 *
 * ── Where the guardrail is visible ───────────────────────────────────────────
 * Read-only must be visible **where you choose the connection**, not
 * buried in a dialog, so every read-only row carries a `[read-only]` badge whose tooltip
 * says what the flag is *worth* on that engine (`readOnlyBadgeTitle`). On Mongo/Redis it is
 * an in-process filter and the badge says so — a control that implies a boundary the engine
 * cannot keep is worse than no control.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * Nothing here has a password. The dialog keeps the typed one in its own local state and
 * hands it to `onTest`/`onSave` as a separate argument; this component passes that argument
 * straight to the IPC wrapper and never stores, logs, or renders it. `db_open` takes a
 * connection **id** — the Vault lookup happens in Rust, so a resolved secret never reaches
 * this file even in transit (secrets are resolved in Rust and never cross IPC).
 */

import { useCallback, useEffect } from "react";

import { useAppStore, type DbAgentNotice } from "../../app/store";
import { ChevronIcon } from "../../components/icons";
import { ConnectionDialog } from "./ConnectionDialog";
import { DbTree } from "./DbTree";
import { connectionInput, dbTestConnection, dbUrlBuild, dbUrlParse } from "./dbIpc";
import { readOnlyBadgeTitle } from "./engineFields";
import type { DbConnection, DbConnectionDraft, EngineSpec } from "./types";
import "./db.css";

/**
 * The secondary line on a row: where it points, in the form a DBA reads.
 *
 * The database is omitted rather than rendered as a trailing `/` — `databaseLabel: null`
 * engines (the ClickHouse-shaped ones) genuinely have no database, and `host:port/` would
 * read as an empty one. The port always shows: `validateDraft` guarantees 1..65535, so
 * there is no "no port" state to special-case.
 */
export function connectionSubtitle(c: DbConnection): string {
  const where = `${c.host}:${c.port}`;
  return c.database === "" ? where : `${where}/${c.database}`;
}

/**
 * One row's status line. Pure, so the four states are pinned as data rather than by
 * driving a component through four async paths.
 *
 * The success case shows the version **and** the latency, for the reason
 * `describeTestResult` gives: anything less does not distinguish "connected" from "a socket
 * opened". `latencyMs: null` is a real shape (the contract allows it), so it degrades to
 * the version alone rather than printing "null ms".
 *
 * ⚠️ **What that number MEANS changed, so the UI has to say so.** It used to be a
 * probe's round trip; `DbOpened.latencyMs` measures the **whole open** — DNS, TLS handshake,
 * authentication and the version query — because that is what the user waited for. A bare `· 34 ms`
 * would be read as round-trip latency, which on a remote cluster is off by an order of magnitude
 * (a remote connect can take several seconds, almost none of it a round trip). Hence
 * {@link sessionTitle}: a number whose meaning is not on screen is a number that will be
 * misinterpreted.
 */
export function sessionLine(session: {
  status: "opening" | "open" | "error";
  serverVersion: string | null;
  latencyMs: number | null;
  error: string | null;
}): string {
  if (session.status === "opening") return "Connecting…";
  if (session.status === "error") {
    return session.error ?? "The connection failed, and no reason was reported.";
  }
  const who = session.serverVersion ?? "Connected";
  return session.latencyMs === null ? who : `${who} · ${session.latencyMs} ms`;
}

/**
 * The tooltip for the status line — what the number beside the version actually measures.
 *
 * Only for the connected state: there is no time to explain while connecting, and a failure's line
 * is already a sentence.
 */
export function sessionTitle(session: {
  status: "opening" | "open" | "error";
  latencyMs: number | null;
}): string | undefined {
  if (session.status !== "open" || session.latencyMs === null) return undefined;
  return "How long this connection took to open — DNS, TLS, authentication and the version query.";
}

/** A query's first non-blank line, capped, for a one-line notice. */
function queryLine(query: string): string {
  const line = query.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

/**
 * What an agent just did, in words: which agent, which connection, and —
 * * for a connection it added, that it is read-only, so a connection never appears in the list
 *   unexplained;
 * * for a query it ran (`ran`, every run), the query, Agent Studio's refusal or what came back,
 *   and where the results are (in the console, or not yet: a busy or unconnected console);
 * * for a query it wrote while the user had text in that console (`offer`), that their text was
 *   left as it is — the notice's "Put in console" is the only way the query goes in.
 */
export function agentNoticeText(
  notice: Omit<DbAgentNotice, "connectionId">,
  connection: DbConnection | null,
): string {
  const who = notice.agent === null ? "An agent" : `The agent "${notice.agent}"`;
  const what = connection === null ? "a connection" : `"${connection.name}"`;
  const kept = notice.offer === undefined ? "" : " Your text in the console was left as it is.";
  if (notice.ran !== undefined) {
    const { error, outcome, console: shown } = notice.ran;
    const line = queryLine(notice.ran.query);
    if (error !== null) {
      return (
        `${who} tried to run a query on ${what}, and Agent Studio refused it: ${error}` +
        `${line === "" ? "" : ` (${line})`}${kept}`
      );
    }
    const where =
      shown === "busy"
        ? " Your own query was running, so the console did not show its results."
        : shown === "closed"
          ? " Connect the console to see its results."
          : " Its results are in the console.";
    return (
      `${who} ran a query on ${what}${line === "" ? "." : `: ${line}`} ` +
      `Result: ${outcome ?? "nothing"}.${where}${kept}`
    );
  }
  if (notice.offer !== undefined) {
    const line = queryLine(notice.offer);
    return `${who} wrote a query for ${what}${line === "" ? "." : `: ${line}`}${kept}`;
  }
  if (!notice.created) return `${who} opened ${what}, which was already saved. Nothing changed.`;
  const access =
    connection === null || connection.readOnly
      ? " It is read-only: use Edit to allow writes."
      : "";
  return `${who} added ${what}.${access}`;
}

function AgentNotice({
  notice,
  connection,
  onPut,
  onDismiss,
}: {
  notice: Omit<DbAgentNotice, "connectionId">;
  connection: DbConnection | null;
  onPut: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="db-panel__agent-notice" role="status" data-testid="db-agent-notice">
      <span title={notice.offer ?? notice.ran?.query}>{agentNoticeText(notice, connection)}</span>
      {notice.offer !== undefined && (
        <button
          type="button"
          className="db-dialog__btn"
          data-testid="db-agent-notice-put"
          onClick={onPut}
        >
          Put in console
        </button>
      )}
      <button
        type="button"
        className="db-dialog__btn"
        data-testid="db-agent-notice-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

export function DbPanel(): React.JSX.Element {
  const engines = useAppStore((s) => s.dbEngines);
  const connections = useAppStore((s) => s.dbConnections);
  const sessions = useAppStore((s) => s.dbSessions);
  const dbError = useAppStore((s) => s.dbError);
  const dialog = useAppStore((s) => s.dbDialog);
  const agentNotice = useAppStore((s) => s.dbAgentNotice);
  const {
    loadDbStore,
    openDbDialog,
    closeDbDialog,
    upsertDbConnection,
    deleteDbConnection,
    openDbSession,
    closeDbSession,
    refreshDbTree,
    dismissDbAgentNotice,
    putAgentDbQueryInConsole,
  } = useAppStore((s) => s.dbActions);
  const openDbConsoleTab = useAppStore((s) => s.layoutActions.openDbConsoleTab);

  // Hydrate once on mount if the store has not been read yet — the same one-shot shape
  // `<CollectionsPanel/>` uses, with the guard in STATE (not a module latch) so it re-arms
  // between tests. `loadDbStore` never rejects, so there is nothing to catch.
  useEffect(() => {
    void loadDbStore();
  }, [loadDbStore]);

  // The dialog's `onBuildUrl` sits in a `useEffect` dependency list, so an inline arrow
  // would re-run that effect — and re-issue the IPC call — on every render of this panel.
  // `useCallback` is load-bearing here, not hygiene.
  const editingId = dialog === null ? null : dialog.connectionId;
  const onTest = useCallback(
    (draft: DbConnectionDraft, password: string) =>
      dbTestConnection(connectionInput(draft, editingId), password),
    [editingId],
  );
  const onBuildUrl = useCallback(
    (draft: DbConnectionDraft) => dbUrlBuild(connectionInput(draft, editingId)),
    [editingId],
  );
  const onSave = useCallback(
    async (draft: DbConnectionDraft, password: string): Promise<void> => {
      // A rejection propagates: the dialog catches it and renders the (already mapped)
      // sentence, and the modal stays open with the user's input intact. Closing on
      // failure is how a form loses ten minutes of typing.
      await upsertDbConnection(draft, password, editingId);
      closeDbDialog();
    },
    [upsertDbConnection, closeDbDialog, editingId],
  );

  return (
    <div className="db-panel" data-testid="db-panel">
      <div className="db-panel__head">
        <p className="db-panel__note">
          Saved database connections. New connections are <strong>read-only</strong> and
          stored in the app data dir — never the repo. Passwords live in the Vault; a
          connection record keeps only a {"{{VAR}}"} reference.
        </p>
        <button
          type="button"
          className="db-dialog__btn"
          data-testid="db-new-connection"
          onClick={() => openDbDialog(null)}
        >
          New connection
        </button>
      </div>

      {agentNotice !== null && (
        <AgentNotice
          notice={agentNotice}
          connection={connections.find((c) => c.id === agentNotice.connectionId) ?? null}
          onPut={putAgentDbQueryInConsole}
          onDismiss={dismissDbAgentNotice}
        />
      )}

      {dbError !== null && (
        <p className="db-dialog__error" role="alert" data-testid="db-panel-error">
          {dbError}
        </p>
      )}

      {connections.length === 0 ? (
        <p className="db-panel__note" data-testid="db-panel-empty">
          No connections yet. Add one to browse a database and run queries from a console
          tab.
        </p>
      ) : (
        <ul className="db-panel__list" data-testid="db-connection-list">
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              spec={engines.find((e) => e.id === c.engine) ?? null}
              session={sessions[c.id]}
              onExpand={() => void openDbSession(c.id)}
              onCollapse={() => void closeDbSession(c.id)}
              onEdit={() => openDbDialog(c.id)}
              onDelete={() => void deleteDbConnection(c.id)}
              onConsole={() => openDbConsoleTab(c.id)}
              onRefresh={() => refreshDbTree(c.id)}
            />
          ))}
        </ul>
      )}

      {dialog !== null && (
        <ConnectionDialog
          engines={engines}
          initial={connections.find((c) => c.id === dialog.connectionId) ?? null}
          onTest={onTest}
          onSave={onSave}
          onBuildUrl={onBuildUrl}
          onParseUrl={dbUrlParse}
          onCancel={closeDbDialog}
        />
      )}
    </div>
  );
}

/**
 * One saved connection.
 *
 * The disclosure control IS the connect gesture: expanding
 * opens a session, collapsing closes it. That is why the button is a disclosure rather than
 * a "Connect" button — there is one affordance for one act, and the row cannot end up
 * showing an expanded-but-disconnected state that means nothing.
 */
function ConnectionRow({
  connection: c,
  spec,
  session,
  onExpand,
  onCollapse,
  onEdit,
  onDelete,
  onConsole,
  onRefresh,
}: {
  connection: DbConnection;
  spec: EngineSpec | null;
  // `DbSessionState`, spelled out rather than imported: this component takes only what it
  // renders, and the store's type is the store's. `sessionId` joined the list when the tree
  // landed — the tree needs the handle `db_children` is addressed by, and `status === "open"`
  // is not the same claim as "we hold its id".
  session:
    | {
        status: "opening" | "open" | "error";
        sessionId: string | null;
        serverVersion: string | null;
        latencyMs: number | null;
        error: string | null;
      }
    | undefined;
  onExpand: () => void;
  onCollapse: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConsole: () => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const open = session !== undefined;
  return (
    <li className="db-panel__row" data-testid="db-connection-row" data-id={c.id}>
      <div className="db-panel__rowhead">
        <button
          type="button"
          className={`db-panel__disclose${open ? " db-panel__disclose--open" : ""}`}
          aria-expanded={open}
          aria-label={open ? `Disconnect ${c.name}` : `Connect ${c.name}`}
          title={open ? "Disconnect" : "Connect"}
          data-testid={`db-row-toggle-${c.id}`}
          onClick={open ? onCollapse : onExpand}
        >
          <ChevronIcon />
        </button>
        <span className="db-panel__name">{c.name}</span>
        <span className="db-panel__engine">{spec === null ? c.engine : spec.label}</span>
        <span className="db-panel__where" title={connectionSubtitle(c)}>
          {connectionSubtitle(c)}
        </span>
        {/* The badge and the buttons wrap onto their own line when the rail is too narrow
            for one: on one line at the default 300px rail they squeezed the name, engine and
            host to 0px and pushed Delete out of view. */}
        <div className="db-panel__actions">
          {c.readOnly && (
            <span
              className="db-panel__badge"
              title={readOnlyBadgeTitle(spec)}
              data-testid={`db-row-readonly-${c.id}`}
            >
              read-only
            </span>
          )}
          {/* The connection offers a way to refresh its tables and database model,
              next to Edit and Delete.
              It used to live in the session block, which only appears once connected — and
              a control that appears only sometimes teaches nobody where it lives.
              Always rendered here, DISABLED without an open session, because the
              levels it re-reads are answered by `db_children`, which needs one. */}
          <button
            type="button"
            className="db-dialog__btn db-dialog__btn--small"
            data-testid={`db-row-refresh-${c.id}`}
            aria-label={`Refresh ${c.name}`}
            title={
              session?.status === "open"
                ? "Re-read this connection's databases and tables. Levels you have opened stay open."
                : "Connect first — refreshing re-reads the server's catalogue."
            }
            disabled={session?.status !== "open"}
            onClick={onRefresh}
          >
            Refresh
          </button>
          <button
            type="button"
            className="db-dialog__btn db-dialog__btn--small"
            aria-label={`Edit ${c.name}`}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="db-dialog__btn db-dialog__btn--small"
            aria-label={`Delete ${c.name}`}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>

      {session !== undefined && (
        <div className="db-panel__session" data-testid={`db-row-session-${c.id}`}>
          <p
            className="db-panel__status"
            role="status"
            data-tone={session.status === "error" ? "bad" : session.status === "open" ? "ok" : undefined}
            title={sessionTitle(session)}
          >
            {sessionLine(session)}
          </p>
          {/* The tree renders for ANY expanded row, not only an open one. Server-answered
              levels need the session and say so when there is none; the saved queries do not
              need one at all, and a failed connect is precisely when someone wants to look at
              the SQL they saved. */}
          <DbTree
            connectionId={c.id}
            family={c.family}
            rowLimit={c.rowLimit}
            sessionId={session.sessionId}
          />
          <div className="db-panel__actions">
            {/* The honest escape hatch. The automatic refresh after a write can only ever
                know about writes made *here*: an edit from psql, from another session, or by
                a colleague is invisible to this app by construction, and every serious
                database client therefore ships a manual refresh. A button rather than a
                context menu because that is this panel's house style (Edit, Delete, Open
                query console) and because a control that needs a right-click is a control
                half this rail's users will never find.

                Disabled without an OPEN session rather than hidden: the row is still
                expanded while it is connecting or after a failed connect, and a button that
                appears only sometimes teaches nobody where it lives. There is also nothing
                for it to do — every level it would re-read is answered by `db_children`,
                which needs a session id. */}
            {session.status === "open" && (
              <button
                type="button"
                className="db-dialog__btn db-dialog__btn--small"
                onClick={onConsole}
              >
                Open query console
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
