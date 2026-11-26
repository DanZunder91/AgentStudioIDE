/** Append-only, uncapped request log, persisted only in the OS app-data dir (out of git's reach).
 * Entries keep {{VAR}} LITERAL, so no resolved secret is written. loadApiHistory never throws;
 * saveApiHistory swallows its failure. */

import { invoke } from "@tauri-apps/api/core";
import type { HttpHeader } from "./httpIpc";

/** Request fields are the LITERAL template; exactly one outcome side is set (status or error).
 * gRPC adds optional fields (no protocol = HTTP, so old logs load): url = endpoint, method = gRPC
 * method, headers = metadata, status = gRPC code; durationMs/sizeBytes are null. */
export interface HistoryEntry {
  id: string;
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  error: string | null;
  /** When the request was executed — epoch milliseconds (stamped by the caller). */
  at: number;
  /** Which protocol executed this entry. Absent/`"http"` for pre-slice-4 entries
   *  (back-compat: a missing field reads as HTTP); `"grpc"` for gRPC calls. */
  protocol?: "http" | "grpc";
  /** gRPC only: the service FQN (`method` holds the gRPC method, `url` the
   *  endpoint). Absent for HTTP. */
  grpcService?: string;
}

/** The whole persisted log: every executed request, oldest first. */
export interface HistoryStore {
  entries: HistoryEntry[];
}

/** Never throws: any failure (no backend, a corrupt file) yields a fresh empty log. */
export async function loadApiHistory(): Promise<HistoryStore> {
  try {
    return await invoke<HistoryStore>("api_history_load");
  } catch {
    return { entries: [] };
  }
}

/** Persists the whole log, best-effort; Rust writes it to app-data, never the workspace. */
export async function saveApiHistory(store: HistoryStore): Promise<void> {
  try {
    await invoke("api_history_save", { store });
  } catch {
    // Intentionally ignored — the Rust store is the source of truth; a dropped
    // save is re-issued by the next executed request.
  }
}
