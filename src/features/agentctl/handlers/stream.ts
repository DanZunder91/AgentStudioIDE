/**
 * WebSocket and gRPC tool events (Rust `agent_ctl::commands::stream`).
 *
 * A WebSocket exchange needs no handler: the engine records it in the Network view. A gRPC call
 * is recorded there too, and `grpcCall` also adds it to the API client's History in the shape the
 * gRPC console records, so the user sees what an agent sent and can open it again.
 */
import { useAppStore } from "../../../app/store";
import { loadApiHistory, type HistoryEntry } from "../../api/historyIpc";
import type { AgentCtlEvent } from "../agentCtlIpc";
import type { AgentCtlHandler } from "../dispatch";

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The `{name, value}` rows of `v`; anything else is dropped. */
function headerRows(v: unknown): HistoryEntry["headers"] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null) return [];
    const { name, value } = row as Record<string, unknown>;
    return typeof name === "string" && typeof value === "string" ? [{ name, value }] : [];
  });
}

/**
 * The History entry for an agent's gRPC call, as the gRPC console records its own: the endpoint
 * in `url`, the method name in `method`, the service in `grpcService`, the gRPC status in
 * `status` / `statusText` (a non-OK status is an answer), and a failure to get one in `error`.
 */
export function grpcHistoryEntry(e: AgentCtlEvent, at: number): Omit<HistoryEntry, "id"> {
  const transportError = typeof e.transportError === "string" ? e.transportError : null;
  const status = transportError === null && typeof e.statusCode === "number" ? e.statusCode : null;
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
    statusText: status === null ? null : detail ? `${statusName}: ${detail}` : statusName,
    durationMs: typeof e.durationMs === "number" ? e.durationMs : null,
    sizeBytes: null,
    error: transportError,
  };
}

/**
 * Append the call to History, loading History first if nothing has yet: `recordApiHistory`
 * saves the whole in-memory log, so appending to a log that was never loaded would save this one
 * entry over the user's history.
 */
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

export const STREAM_HANDLERS: Readonly<Record<string, AgentCtlHandler>> = {
  /** `grpc_call`: every call an agent made, answered or not, goes in History. */
  grpcCall: (e) => {
    void recordGrpcCall(e);
  },
};
