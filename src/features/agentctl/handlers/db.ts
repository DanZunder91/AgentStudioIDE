/** Database-tool events (Rust `agent_ctl::commands::db`). */
import { useAppStore } from "../../../app/store";
import type { AgentId } from "../../../app/types";
import type { DbResultSet } from "../../db/types";
import type { AgentCtlEvent } from "../agentCtlIpc";
import type { AgentCtlHandler } from "../dispatch";

/** `The agent "claude · shop"` for a terminal whose agent we know, else `An agent`. */
export function agentWho(terminalId: string): string {
  const agent = useAppStore.getState().agents[terminalId as AgentId];
  return agent === undefined
    ? "An agent"
    : `The agent "${agent.customTitle ?? agent.title}"`;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Console result note for an agent's run: who ran it (from a terminal), and what came back (with
 * every cut Rust made, so a cut table isn't read as whole) or why it did not run. */
export function agentRunNote(
  event: AgentCtlEvent,
  results: DbResultSet[],
): DbResultSet {
  const who = agentWho(event.terminalId);
  const error = typeof event.error === "string" ? event.error : null;
  const notes = strings(event.notes);
  const text =
    error === null
      ? [
          `${who} ran this query from its terminal. Below is what it received.`,
          ...notes,
        ].join(" ")
      : `${who} tried to run this query from its terminal, and it did not run: ${error}`;
  return {
    kind: "message",
    statement: typeof event.query === "string" ? event.query : "",
    columns: [],
    rows: [],
    rowsAffected: null,
    truncated: false,
    rowLimit: results[0]?.rowLimit ?? 0,
    durationMs: 0,
    notice: text,
  };
}

const rowCount = (n: number): string => (n === 1 ? "1 row" : `${n} rows`);

/** A run's outcome in a few words: rows read (and if Rust cut them), rows changed, DB error. */
export function runOutcome(results: DbResultSet[]): string {
  const parts: string[] = [];
  const read = results.filter((r) => r.kind === "rows");
  if (read.length > 0) {
    const n = read.reduce((sum, r) => sum + r.rows.length, 0);
    parts.push(
      `${rowCount(n)}${read.some((r) => r.truncated) ? " (cut)" : ""}`,
    );
  }
  const wrote = results.filter((r) => r.kind === "affected");
  if (wrote.length > 0) {
    parts.push(
      `${rowCount(wrote.reduce((sum, r) => sum + (r.rowsAffected ?? 0), 0))} affected`,
    );
  }
  if (results.some((r) => r.kind === "message"))
    parts.push("an error from the database");
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

/** Open a console (the connection may not be loaded yet), typing the agent's query only if it
 * is empty, which unlinks a saved query so ⌘S can't overwrite it. A console with the user's own
 * text is only brought to front; the DB panel offers the query instead. */
async function openAgentConsole(
  connectionId: string,
  terminalId: string,
  query: string | null,
): Promise<void> {
  await useAppStore.getState().dbActions.loadDbStore();
  const { dbActions, layoutActions, dbConsoles } = useAppStore.getState();
  const text = dbConsoles[connectionId]?.text ?? "";
  if (query !== null && text.trim() === "") {
    dbActions.openDbQueryInConsole(connectionId, query);
    return;
  }
  layoutActions.openDbConsoleTab(connectionId);
  if (query !== null && text.trim() !== query.trim()) {
    dbActions.offerAgentDbQuery({ connectionId, terminalId, query });
  }
}

/** Show an agent-named connection; connect when `open` says so, after the panel list re-reads
 * (a just-added id fails `openDbSession`). An open/opening session is kept: re-dialling would
 * orphan it and any transaction the user has open. */
async function showAgentConnection(
  connectionId: string,
  terminalId: string,
  created: boolean,
  open: boolean,
): Promise<void> {
  await useAppStore
    .getState()
    .dbActions.showAgentDbConnection({ connectionId, terminalId, created });
  if (!open) return;
  const { dbSessions, dbActions } = useAppStore.getState();
  const status = dbSessions[connectionId]?.status;
  if (status === "open" || status === "opening") return;
  await dbActions.openDbSession(connectionId);
}

export const DB_HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {
  /** `db_connect`: a connection added or re-opened; connected and expanded when Rust knows it
   * connects (a passing test, or already saved). */
  dbConnection: (e) =>
    void showAgentConnection(
      String(e.connectionId),
      e.terminalId,
      e.created === true,
      e.open === true,
    ),

  /** `db_open`: show a saved connection, connected, with its tables. */
  dbOpen: (e) =>
    void showAgentConnection(String(e.connectionId), e.terminalId, false, true),

  /** `db_console`: open the connection's console with the agent's query typed in, not run. */
  dbConsole: (e) =>
    void openAgentConsole(
      String(e.connectionId),
      e.terminalId,
      typeof e.query === "string" ? e.query : null,
    ),

  /** `db_query`: every run, refused too, goes to the DB notice and the connection's console,
   * opened in the background so the watched terminal keeps focus. */
  dbQueryRun: (e) => {
    const results = Array.isArray(e.results)
      ? (e.results as DbResultSet[])
      : [];
    const error = typeof e.error === "string" ? e.error : null;
    void useAppStore.getState().dbActions.showAgentDbQuery({
      connectionId: String(e.connectionId),
      terminalId: e.terminalId,
      query: typeof e.query === "string" ? e.query : "",
      error,
      outcome: error === null ? runOutcome(results) : null,
      results: [agentRunNote(e, results), ...results],
    });
  },

  /** `db_save_query`: the connection's saved-query list changed on disk; read it again. */
  dbSavedQuery: (e) =>
    void useAppStore
      .getState()
      .dbActions.loadDbSavedQueries(String(e.connectionId)),
};
