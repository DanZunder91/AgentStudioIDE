/** The exact wire contract of Rust's http_send (its serde structs). Nothing here writes to disk. */

import { invoke } from "@tauri-apps/api/core";

/** One request/response header. Order-preserving; duplicates are allowed. */
export interface HttpHeader {
  name: string;
  value: string;
}

/** body is null when there is none; a present body is sent verbatim, never re-encoded. */
export interface HttpRequest {
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string | null;
}

/** body is decoded text; truncated means Rust capped an oversized body; sizeBytes is on-wire. */
export interface HttpResponse {
  status: number;
  statusText: string;
  headers: HttpHeader[];
  body: string;
  durationMs: number;
  sizeBytes: number;
  truncated: boolean;
}

/** Rejects with a string on a DNS/TLS/timeout failure, which the panel shows inline. */
export async function sendHttp(request: HttpRequest): Promise<HttpResponse> {
  return invoke<HttpResponse>("http_send", { request });
}
