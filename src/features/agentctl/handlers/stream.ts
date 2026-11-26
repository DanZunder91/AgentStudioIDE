/** WebSocket and gRPC tool events (Rust `agent_ctl::commands::stream`). WS needs no handler (the
 * engine records it in Network); `grpcCall` also adds the call to API History, console-shaped. */
import { useAppStore } from "../../../app/store";
import { loadApiHistory, type HistoryEntry } from "../../api/historyIpc";
import type { AgentCtlEvent } from "../agentCtlIpc";
import type { AgentCtlHandler } from "../dispatch";
import { spellsVaultRef } from "./http";

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The `{name, value}` rows of `v`; anything else is dropped. */
function headerRows(v: unknown): HistoryEntry["headers"] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null) return [];
    const { name, value } = row as Record<string, unknown>;
    return typeof name === "string" && typeof value === "string"
      ? [{ name, value }]
      : [];
  });
}

/** History entry for an agent's gRPC call, shaped like the console's: endpoint in `url`, method,
 * `grpcService`, gRPC status in `status`/`statusText` (non-OK is an answer), failure in `error`. */
export function grpcHistoryEntry(
  e: AgentCtlEvent,
  at: number,
): Omit<HistoryEntry, "id"> {
  const transportError =
    typeof e.transportError === "string" ? e.transportError : null;
  const status =
    transportError === null && typeof e.statusCode === "number"
      ? e.statusCode
      : null;
  const statusName = text(e.statusName);
  const detail = text(e.error);
  return {
    protocol: "grpc",
    grpcService: text(e.service),
    method: text(e.method),
    url: text(e.target),
    headers: headerRows(e.headers),
    body: text(e.body),
    at,
    status,
    statusText:
      status === null ? null : detail ? `${statusName}: ${detail}` : statusName,
    durationMs: typeof e.durationMs === "number" ? e.durationMs : null,
    sizeBytes: null,
    error: transportError,
  };
}

/** Append to History, loading it first if needed: `recordApiHistory` saves the whole in-memory
 * log, so an unloaded log would overwrite the user's history with this one entry. */
export async function recordGrpcCall(e: AgentCtlEvent): Promise<void> {
  const entry = grpcHistoryEntry(e, Date.now());
  if (!useAppStore.getState().apiHistoryLoaded) {
    const saved = await loadApiHistory();
    // The History panel may have loaded it meanwhile; then that copy stands.
    if (!useAppStore.getState().apiHistoryLoaded) {
      useAppStore.getState().apiActions.hydrateApiHistory(saved);
    }
  }
  useAppStore.getState().apiActions.recordApiHistory(entry);
}

/** Does any WS/gRPC tab text name a Vault variable? A second lock after Rust's: the consoles
 * substitute the user's `{{VAR}}`s on Connect or Send. */
function namesVaultVariable(
  e: AgentCtlEvent,
  fields: readonly string[],
): boolean {
  const rows = headerRows(e.headers).flatMap((h) => [h.name, h.value]);
  const texts = [...fields.map((f) => e[f]), ...rows];
  return texts.some((t) => typeof t === "string" && spellsVaultRef(t));
}

/** Open a new API client tab for `protocol`, filled by `fill`, titled `e.title`. */
function openTab(
  e: AgentCtlEvent,
  protocol: "ws" | "grpc",
  fill: (requestId: string) => void,
): void {
  const s = useAppStore.getState();
  const requestId = s.apiActions.createApiRequest();
  s.apiActions.importCurl(requestId, {
    method: "GET",
    url: text(protocol === "ws" ? e.url : e.target),
    headers: headerRows(e.headers),
    body: protocol === "grpc" ? text(e.body) : null,
  });
  s.apiActions.setApiProtocol(requestId, protocol);
  fill(requestId);
  const tabId = s.layoutActions.openApiRequestTab(requestId);
  if (text(e.title) !== "") s.layoutActions.renameTab(tabId, text(e.title));
}

export const STREAM_HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {
  /** `ws_open`: a WebSocket console tab, filled in, not connected. */
  wsOpen: (e) => {
    if (namesVaultVariable(e, ["url", "message"])) return;
    openTab(e, "ws", (id) => {
      if (text(e.message) !== "")
        useAppStore.getState().apiActions.setWsDraft(id, text(e.message));
    });
  },

  /** `grpc_open`: a gRPC console tab with target, method, body and metadata, not sent. */
  grpcOpen: (e) => {
    if (namesVaultVariable(e, ["target", "service", "method", "body"])) return;
    openTab(e, "grpc", (id) => {
      const api = useAppStore.getState().apiActions;
      api.setGrpcPlaintext(id, e.plaintext === true);
      if (text(e.service) !== "") api.setGrpcService(id, text(e.service));
      if (text(e.method) !== "") api.setGrpcMethod(id, text(e.method));
    });
  },

  /** `grpc_call`: every call an agent made, answered or not, goes in History. */
  grpcCall: (e) => {
    void recordGrpcCall(e);
  },
};
