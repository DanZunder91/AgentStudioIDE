/**
 * historyIpc — typed wrapper for the API client's request HISTORY store (M6
 * follow-on).
 *
 * A persisted, append-only log of every executed HTTP request, so the user can
 * review past calls and re-run them. Like `apiStoreIpc`, it persists ONLY under the
 * OS app-data dir via the Rust `api_history_load` / `api_history_save` commands —
 * reachable by no git operation (the hard secret-safety rule).
 *
 * Secret-safety: a recorded request keeps its `{{VAR}}` placeholders LITERAL (the
 * frontend snapshots the PRE-substitution request), so a resolved secret is never
 * written here — the token lives only in an `Environment`.
 *
 * No limit, no cache: every execution is appended; the log is
 * never capped or deduplicated. Both calls are best-effort: `loadApiHistory` NEVER
 * throws (a missing/failed backend yields an empty log), and `saveApiHistory`
 * swallows its failure (a dropped save must not break the request being composed).
 */

import { invoke } from "@tauri-apps/api/core";
import type { HttpHeader } from "./httpIpc";

/**
 * One executed request + its outcome. Request fields (`method`/`url`/`headers`/
 * `body`) are the LITERAL template as typed (`{{VAR}}` kept, never a resolved
 * secret). Exactly one outcome side is populated: on success `status` +
 * `statusText`/`durationMs`/`sizeBytes`; on a transport failure `error`.
 *
 * gRPC unary calls share this shape via ADDITIVE optional
 * fields — a missing `protocol` reads as HTTP, so an older HTTP-only log still loads
 * (the Rust serde struct uses `#[serde(default)]`). For a gRPC entry: `url` holds
 * the endpoint, `method` the gRPC method name, `grpcService` the service FQN,
 * `headers` the metadata rows, `status`/`statusText` the gRPC status code/name,
 * and `durationMs`/`sizeBytes` are null (grpcurl reports neither).
 */
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

/**
 * `api_history_load` — hydrate the history log. NEVER throws: any failure (no
 * backend, a corrupt file) yields a FRESH empty log, so opening the History panel
 * can never fail on persistence. A new object each call.
 */
export async function loadApiHistory(): Promise<HistoryStore> {
  try {
    return await invoke<HistoryStore>("api_history_load");
  } catch {
    return { entries: [] };
  }
}

/**
 * `api_history_save` — persist the whole log (wholesale). Best-effort: a transient
 * write failure is swallowed. The log crosses the boundary in memory only; the Rust
 * side writes it to the app-data dir, never the workspace/repo.
 */
export async function saveApiHistory(store: HistoryStore): Promise<void> {
  try {
    await invoke("api_history_save", { store });
  } catch {
    // Intentionally ignored — the Rust store is the source of truth; a dropped
    // save is re-issued by the next executed request.
  }
}
