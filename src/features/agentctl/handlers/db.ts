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

/** Open a console for a connection the store may not have loaded yet (it names the tab). */
async function openAgentConsole(connectionId: string, query: string | null): Promise<void> {
  await useAppStore.getState().dbActions.loadDbStore();
  const { dbActions, layoutActions } = useAppStore.getState();
  if (query === null) layoutActions.openDbConsoleTab(connectionId);
  else dbActions.openDbQueryInConsole(connectionId, query);
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
    void openAgentConsole(String(e.connectionId), typeof e.query === "string" ? e.query : null),

  /**
   * `db_query`: every run, refused ones included, lands in the connection's console — opened in
   * the background, so the terminal the user is watching keeps the focus.
   */
  dbQueryRun: (e) => {
    const results = Array.isArray(e.results) ? (e.results as DbResultSet[]) : [];
    void useAppStore.getState().dbActions.showAgentDbQuery({
      connectionId: String(e.connectionId),
      query: typeof e.query === "string" ? e.query : "",
      results: [agentRunNote(e, results), ...results],
    });
  },

  /** `db_save_query`: the connection's saved-query list changed on disk; read it again. */
  dbSavedQuery: (e) =>
    void useAppStore.getState().dbActions.loadDbSavedQueries(String(e.connectionId)),
};
