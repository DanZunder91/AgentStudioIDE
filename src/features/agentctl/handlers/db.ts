/** Database-tool events (Rust `agent_ctl::commands::db`). */
import { useAppStore } from "../../../app/store";
import type { AgentCtlHandler } from "../dispatch";

export const DB_HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {
  /** `db_connect`: a connection was added (or an already-saved one re-opened). */
  dbConnection: (e) =>
    useAppStore.getState().dbActions.showAgentDbConnection({
      connectionId: String(e.connectionId),
      terminalId: e.terminalId,
      created: e.created === true,
    }),
};
