/** API-client tool events (Rust `agent_ctl::commands::http`). */
import { useAppStore } from "../../../app/store";
import { loadApiHistory } from "../../api/historyIpc";
import type { AgentCtlEvent } from "../agentCtlIpc";
import type { AgentCtlHandler } from "../dispatch";

/** The `{name, value}` rows of an event's `headers`; anything else in it is dropped. */
function headerRows(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((h: unknown) => {
    const row = h as { name?: unknown; value?: unknown } | null;
    return row !== null &&
      typeof row === "object" &&
      typeof row.name === "string" &&
      typeof row.value === "string"
      ? [{ name: row.name, value: row.value }]
      : [];
  });
}

/**
 * Does any text field of an `httpOpen` event name a Vault variable? Rust refuses such a request
 * before it gets here; this is the second lock on the same door, because the tab this event opens
 * substitutes `{{VAR}}`s from the user's environment the moment the user presses Send — which
 * would hand a saved secret to a host the agent chose.
 */
function namesVaultVariable(e: AgentCtlEvent): boolean {
  const texts = [e.method, e.url, e.body, JSON.stringify(e.headers ?? null)];
  return texts.some((t) => typeof t === "string" && t.includes("{{"));
}

export const HTTP_HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {
  /** `http_open`: a request the agent wrote, opened in a new tab for the user to review and send. */
  httpOpen: (e) => {
    if (namesVaultVariable(e)) return;
    const s = useAppStore.getState();
    const requestId = s.apiActions.createApiRequest();
    s.apiActions.importCurl(requestId, {
      method: typeof e.method === "string" && e.method !== "" ? e.method : "GET",
      url: typeof e.url === "string" ? e.url : "",
      headers: headerRows(e.headers),
      body: typeof e.body === "string" ? e.body : null,
    });
    const tabId = s.layoutActions.openApiRequestTab(requestId);
    if (typeof e.title === "string" && e.title !== "") {
      s.layoutActions.renameTab(tabId, e.title);
    }
  },

  /**
   * `http_send` / `api_run` / `api_compare`: Rust appended the exchange to the history file.
   * Bring the History rail into view and re-read the file, so the mirror the webview saves from
   * holds the agent's entries too (a later save from a stale mirror would drop them).
   */
  apiHistory: () => {
    const s = useAppStore.getState();
    if (s.rightRailCollapsed) s.uiActions.toggleRightRail();
    s.uiActions.setRightRailTab("history");
    void loadApiHistory().then((store) => {
      useAppStore.getState().apiActions.hydrateApiHistory(store);
    });
  },
};
