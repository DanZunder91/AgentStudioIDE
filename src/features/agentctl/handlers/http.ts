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

/** Decode JSON string escapes (`\u007b` → `{`) leniently, leaving non-escapes as written: what
 * the tab's Format button (`JSON.parse` + `JSON.stringify`) would write. */
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

/** Does `text` spell `{{` as written or after a few layers of JSON/percent decoding, in either
 * order (`\u007b\u007b`, `%7B%7B`, `%257B%257B`)? Same rule as Rust's `spells_vault_ref`. */
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

/** Does any tab text name a Vault variable? A second lock after Rust's: Send would substitute
 * the user's `{{VAR}}`s, handing a secret to a host the agent chose. Encoded spellings count. */
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

  /** `http_send` / `api_run` / `api_compare`: Rust appended to the history file; show History and
   * re-read it, so a save from a stale mirror cannot drop the agent's entries. */
  apiHistory: () => {
    const s = useAppStore.getState();
    if (s.rightRailCollapsed) s.uiActions.toggleRightRail();
    s.uiActions.setRightRailTab("history");
    void loadApiHistory().then((store) => {
      useAppStore.getState().apiActions.hydrateApiHistory(store);
    });
  },
};
