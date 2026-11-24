/**
 * HTTP IPC — typed wrapper for the built-in API client's send command.
 *
 * Kept feature-local so the wire types live next to their feature. These types are
 * the EXACT wire contract the Rust `http_send` command implements — mirrored by its
 * serde structs. They live here (not in `app/types.ts`), exactly as `findIpc`
 * keeps `FindResult` local.
 *
 * Secret-safety: this crosses the boundary in memory only — nothing
 * here writes a request/response/header to disk.
 */

import { invoke } from "@tauri-apps/api/core";

/** One request/response header. Order-preserving; duplicates are allowed. */
export interface HttpHeader {
  name: string;
  value: string;
}

/**
 * A request to send. `body` is `null` for methods that carry none (GET/HEAD) or
 * an empty body; a present body is sent verbatim (the UI never re-encodes it).
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string | null;
}

/**
 * The response Rust returns. `body` is already decoded text; `truncated` is true
 * when Rust capped an oversized body (so the UI can say so rather than imply the
 * text is complete). `durationMs`/`sizeBytes` are the wall-clock time and the
 * on-wire byte count.
 */
export interface HttpResponse {
  status: number;
  statusText: string;
  headers: HttpHeader[];
  body: string;
  durationMs: number;
  sizeBytes: number;
  truncated: boolean;
}

/**
 * `http_send` — perform `request` and resolve its `HttpResponse`, or REJECT with
 * a string (a DNS/TLS/timeout failure the panel surfaces inline rather than
 * crashing). Rust owns the actual client; this is the whole marshalling contract.
 */
export async function sendHttp(request: HttpRequest): Promise<HttpResponse> {
  return invoke<HttpResponse>("http_send", { request });
}
