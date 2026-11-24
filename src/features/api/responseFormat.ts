/**
 * responseFormat — the HTTP response display helpers, shared between the single
 * `ResponsePanel` (ApiRequestView) and the A/B `ComparePanel`.
 * Extracted verbatim from ApiRequestView so the two surfaces cannot drift on
 * what "is JSON" or how a status buckets (a shared seam gets one owner, not two copies).
 * Pure functions over the wire `HttpResponse` — no store, no React.
 */

import type { HttpHeader, HttpResponse } from "./httpIpc";

/** The status-pill colour class, bucketed by HTTP class (2xx/3xx/4xx/other). */
export function statusClass(status: number): string {
  if (status >= 200 && status < 300) return "api-status--2xx";
  if (status >= 300 && status < 400) return "api-status--3xx";
  if (status >= 400 && status < 500) return "api-status--4xx";
  return "api-status--5xx";
}

/** The response's content-type (lowercased), or "" when it sent none. */
export function responseContentType(headers: HttpHeader[]): string {
  for (const h of headers) {
    if (h.name.toLowerCase() === "content-type") return h.value.toLowerCase();
  }
  return "";
}

/**
 * The body to display: pretty-printed (2-space) JSON when the content-type says
 * JSON and the body parses, else the raw text unchanged (a malformed JSON body
 * is shown as-is rather than swallowed).
 */
export function formatBody(response: HttpResponse): string {
  if (responseContentType(response.headers).includes("json")) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }
  return response.body;
}

/**
 * The response body parsed for the collapsible tree view. `isJson` is true only when
 * the content-type says JSON AND the body actually parses; `value` is the parsed JSON
 * then (any JS value, incl. `null`). A non-JSON or malformed body → `{isJson:false}`,
 * and the panel falls back to the raw/pretty `<pre>`.
 */
export function parseJsonBody(response: HttpResponse): {
  isJson: boolean;
  value: unknown;
} {
  if (!responseContentType(response.headers).includes("json")) {
    return { isJson: false, value: null };
  }
  try {
    return { isJson: true, value: JSON.parse(response.body) as unknown };
  } catch {
    return { isJson: false, value: null };
  }
}

/** "512 B" / "1.2 KB" / "3.4 MB" — a humane on-wire size. */
export function humanizeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
