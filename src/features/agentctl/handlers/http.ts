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

/** The character a JSON simple escape (`\n`, `\"`, `\/`…) stands for. */
const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * `text` with JSON string escapes decoded (`\u007b` → `{`), leniently: anything that is not an
 * escape stays as written. Over the whole text this reads every string and key of a JSON body in
 * place — what the request tab's Format button (`JSON.parse` then `JSON.stringify`) would write.
 */
function jsonUnescape(text: string): string {
  return text.replace(
    /\\(?:u([0-9a-fA-F]{4})|(.))/gs,
    (whole: string, hex: string | undefined, c: string) =>
      hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : (JSON_ESCAPES[c] ?? whole),
  );
}

/** `text` with every `%XX` decoded byte for byte (enough to read `%7B` as `{`, any case). */
function percentDecode(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Does `text` spell `{{` — as written, or once JSON escapes or percent-escapes are decoded, in
 * either order, a few layers deep (`\u007b\u007b`, `%7B%7B`, `%7b{`, `%257B%257B`)? The same rule
 * as Rust's `spells_vault_ref`.
 */
export function spellsVaultRef(text: string): boolean {
  let frontier = [text];
  for (let layer = 0; layer <= 3 && frontier.length > 0; layer++) {
    if (frontier.some((t) => t.includes("{{"))) return true;
    frontier = [
      ...new Set(
        frontier.flatMap((t) => [jsonUnescape(t), percentDecode(t)].filter((d) => d !== t)),
      ),
    ];
  }
  return false;
}

/**
 * Does any text the tab would hold name a Vault variable? Rust refuses such a request before it
 * gets here; this is the second lock on the same door, because the tab this event opens
 * substitutes `{{VAR}}`s from the user's environment the moment the user presses Send — which
 * would hand a saved secret to a host the agent chose. Encoded spellings count: Format turns
 * `"\u007b\u007bKEY}}"` into `"{{KEY}}"`.
 */
function namesVaultVariable(e: AgentCtlEvent): boolean {
  const rows = headerRows(e.headers).flatMap((h) => [h.name, h.value]);
  const texts = [e.method, e.url, e.body, ...rows];
  return texts.some((t) => typeof t === "string" && spellsVaultRef(t));
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
