/** DB rail tab: saved connections, wiring the props-only `<ConnectionDialog/>` to real IPC. Each
 * read-only row's badge says what the flag is worth on that engine. A typed password goes straight
 * to IPC, never stored, logged or rendered; `db_open` takes an id and Rust resolves secrets. */

import { useCallback, useEffect } from "react";

import { useAppStore, type DbAgentNotice } from "../../app/store";
import { ChevronIcon } from "../../components/icons";
import { ConnectionDialog } from "./ConnectionDialog";
import { DbTree } from "./DbTree";
import { connectionInput, dbTestConnection, dbUrlBuild, dbUrlParse } from "./dbIpc";
import { readOnlyBadgeTitle } from "./engineFields";
import type { DbConnection, DbConnectionDraft, EngineSpec } from "./types";
import "./db.css";

/** No trailing `/` for engines with no database (`databaseLabel: null`); the port always shows
 * (`validateDraft` guarantees 1..65535). */
export function connectionSubtitle(c: DbConnection): string {
  const where = `${c.host}:${c.port}`;
  return c.database === "" ? where : `${where}/${c.database}`;
}

/** Pure, so the states are pinned as data. Success shows version and latency (`null` degrades to
 * the version alone). The number is the whole open, not a round trip; {@link sessionTitle} says
 * so. */
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

/** Says what the latency number measures; connected state only. */
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

/** Which agent, which connection, and what it did: an added connection is read-only; a run shows
 * the query, refusal or result and where results are; an `offer` left the user's console text as
 * is (only "Put in console" inserts it). */
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

/** Expanding the row opens a session and collapsing closes it, so it never shows expanded but
 * disconnected. */
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
  // Only what this row renders. `sessionId` is separate: `status === "open"` is not the same
  // claim as holding the handle `db_children` is addressed by.
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
          {/* Manual refresh: writes from psql or other sessions are invisible to this app. Always
              shown, disabled without an open session (`db_children` needs one). */}
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
          {/* For any expanded row: saved queries need no session, e.g. after a failed connect. */}
          <DbTree
            connectionId={c.id}
            family={c.family}
            rowLimit={c.rowLimit}
            sessionId={session.sessionId}
          />
          <div className="db-panel__actions">
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
