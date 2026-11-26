/** Response display helpers shared by ResponsePanel and ComparePanel, so they agree on "is JSON"
 * and status buckets. */

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

/** Pretty JSON when the content-type says JSON and it parses; else the raw text as-is. */
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

/** `isJson` only when the content-type says JSON AND the body parses (`value` may be `null`). */
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
