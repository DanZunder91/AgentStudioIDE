/** Database-tool events (Rust `agent_ctl::commands::db`). */
import { useAppStore } from "../../../app/store";
import type { AgentId } from "../../../app/types";
import type { DbResultSet } from "../../db/types";
import type { AgentCtlEvent } from "../agentCtlIpc";
import type { AgentCtlHandler } from "../dispatch";

/** `The agent "claude · shop"` for a terminal whose agent we know, else `An agent`. */
export function agentWho(terminalId: string): string {
  const agent = useAppStore.getState().agents[terminalId as AgentId];
  return agent === undefined ? "An agent" : `The agent "${agent.customTitle ?? agent.title}"`;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The result an agent's run opens the console's results with: who ran it from a terminal, and
 * either what came back (with every cut Rust made, so a cut table is not read as the whole
 * answer) or why it did not run.
 */
export function agentRunNote(event: AgentCtlEvent, results: DbResultSet[]): DbResultSet {
  const who = agentWho(event.terminalId);
  const error = typeof event.error === "string" ? event.error : null;
  const notes = strings(event.notes);
  const text =
    error === null
      ? [`${who} ran this query from its terminal. Below is what it received.`, ...notes].join(" ")
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

/**
 * What a run brought back, in a few words for the DB panel's notice: the rows read (and whether
 * Rust cut them), the rows a write changed, and whether the database answered with an error.
 */
export function runOutcome(results: DbResultSet[]): string {
  const parts: string[] = [];
  const read = results.filter((r) => r.kind === "rows");
  if (read.length > 0) {
    const n = read.reduce((sum, r) => sum + r.rows.length, 0);
    parts.push(`${rowCount(n)}${read.some((r) => r.truncated) ? " (cut)" : ""}`);
  }
  const wrote = results.filter((r) => r.kind === "affected");
  if (wrote.length > 0) {
    parts.push(`${rowCount(wrote.reduce((sum, r) => sum + (r.rowsAffected ?? 0), 0))} affected`);
  }
  if (results.some((r) => r.kind === "message")) parts.push("an error from the database");
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

/**
 * Open a console for a connection the store may not have loaded yet (it names the tab), with the
 * agent's query typed in when the console is empty (which also unlinks a saved query, so ⌘S
 * cannot write the agent's text over it). A console holding the user's own text is never
 * modified: it is brought to the front as it is, and the DB panel offers the query instead.
 */
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

export const DB_HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {
  /** `db_connect`: a connection was added (or an already-saved one re-opened). */
  dbConnection: (e) =>
    useAppStore.getState().dbActions.showAgentDbConnection({
      connectionId: String(e.connectionId),
      terminalId: e.terminalId,
      created: e.created === true,
    }),

  /** `db_console`: open the connection's console with the agent's query typed in, not run. */
  dbConsole: (e) =>
    void openAgentConsole(
      String(e.connectionId),
      e.terminalId,
      typeof e.query === "string" ? e.query : null,
    ),

  /**
   * `db_query`: every run, refused ones included, is told in the DB panel's notice and lands in
   * the connection's console — opened in the background, so the terminal the user is watching
   * keeps the focus.
   */
  dbQueryRun: (e) => {
    const results = Array.isArray(e.results) ? (e.results as DbResultSet[]) : [];
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
    void useAppStore.getState().dbActions.loadDbSavedQueries(String(e.connectionId)),
};
