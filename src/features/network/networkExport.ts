/** A captured flow as a cURL command (the API client's `buildCurl`) or a new API-client request.
 * Nothing is redacted by design: headers export as captured, credentials included, so the replay
 * is the request that was sent. Only connection-level headers are left for curl to compute. */

import { useAppStore } from "../../app/store";
import { buildCurl, type CurlableRequest } from "../api/curlExport";
import { isWindows } from "../shortcuts/shortcuts";
import { appOfClient, caStepHint } from "./captureSteps";
import { isExternal } from "./networkSource";
import type { FlowDetail, FlowProto, FlowSummary } from "./networkTypes";

/** Headers of this connection, not the request: curl computes its own length, host and
 * connection, and HTTP/2 pseudo-headers are not headers. */
const CONNECTION_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  // The proxy's OWN attribution header (`t-<terminal>:x`) — hop-by-hop (RFC 9110
  // §7.6.1), never seen by the origin, so it is neither replayed nor reported as a secret the
  // user must re-add. Pinned by the contract seam test (src/test/contract).
  "proxy-authorization",
]);

const SCHEME: Record<FlowProto, string> = {
  http: "http",
  https: "https",
  ws: "ws",
  wss: "wss",
  // Decrypted h2 — gRPC only reaches us readable through the TLS terminator.
  grpc: "https",
  tunnel: "https",
  // Never replayed (see `exportable`); a parsed bypass URL is shown verbatim instead.
  bypass: "http",
};

const DEFAULT_PORT: Record<string, number> = { http: 80, ws: 80, https: 443, wss: 443 };

export function flowUrl(f: Pick<FlowSummary, "proto" | "host" | "port" | "path">): string {
  const scheme = SCHEME[f.proto];
  const port = f.port === DEFAULT_PORT[scheme] ? "" : `:${f.port}`;
  const host = f.host.includes(":") ? `[${f.host}]` : f.host;
  return `${scheme}://${host}${port}${f.path}`;
}

export type Exportable =
  | { ok: true; request: CurlableRequest }
  | { ok: false; reason: string };

/** The reason on `false` is the disabled button's text: it must say what it is waiting for. */
export function exportable(summary: FlowSummary, detail: FlowDetail | null): Exportable {
  if (summary.proto === "bypass") {
    return {
      ok: false,
      reason: "Not captured — this command skipped the IDE proxy, so there is no request to replay. Copy the command from the detail below.",
    };
  }
  // A CONNECT that is not a tunnel is a handshake that never became a request (e.g. the client
  // rejected our certificate): replaying it would be `curl -X CONNECT https://host` — nothing.
  if (summary.method === "CONNECT" && summary.proto !== "tunnel") {
    if (summary.error !== null && summary.error.startsWith("tls rejected")) {
      const who = summary.client?.name ?? "The client";
      return {
        ok: false,
        reason: `Nothing to replay — ${who} refused the IDE's certificate before sending a request.`,
      };
    }
    return { ok: false, reason: "No request was captured — the connection ended during the TLS handshake." };
  }
  if (summary.proto === "tunnel" && summary.note) {
    return { ok: false, reason: `Encrypted tunnel — the proxy never saw the request (${summary.note}).` };
  }
  if (summary.proto === "tunnel") {
    // An external app is not restarted from a terminal: its fix is the CA step.
    if (isExternal(summary)) {
      return { ok: false, reason: `Encrypted tunnel — the proxy never saw the request. ${caStepHint(appOfClient(summary.client))}` };
    }
    return {
      ok: false,
      reason:
        "Encrypted tunnel — the proxy never saw the request. Turn on Decrypt HTTPS, then re-run it from a terminal opened afterwards.",
    };
  }
  if (summary.proto === "ws" || summary.proto === "wss") {
    return { ok: false, reason: "WebSocket flows can't be replayed as a single request yet." };
  }
  if (summary.proto === "grpc") {
    return { ok: false, reason: "gRPC bodies are binary protobuf — cURL and the HTTP client can't replay them." };
  }
  if (detail === null) return { ok: false, reason: "Loading the captured request…" };
  const body = detail.requestBody;
  if (body && body.base64 !== null) {
    return { ok: false, reason: `The request body is binary (${body.size} bytes) — it can't be pasted as text.` };
  }
  if (body && body.truncated) {
    return { ok: false, reason: "The request body was truncated at the 1 MiB capture limit — a replay would send a different body." };
  }
  const headers: { name: string; value: string }[] = [];
  for (const [name, value] of detail.requestHeaders) {
    const lower = name.toLowerCase();
    if (lower.startsWith(":") || CONNECTION_HEADERS.has(lower)) continue;
    headers.push({ name, value });
  }
  const text = body?.text ?? null;
  return {
    ok: true,
    request: {
      method: summary.method,
      url: flowUrl(summary),
      headers,
      body: text === "" ? null : text,
    },
  };
}

/** The literal cURL command (a captured request has no `{{VAR}}`). Quoted for the paste target:
 * bash on macOS/Linux, PowerShell on Windows (the IDE's terminal shell there; bash's `'\''` and
 * cmd's lack of single quotes both break). One click, so no picker: the API client's default. */
export function flowCurl(request: CurlableRequest): string {
  return buildCurl(request, (t) => t, isWindows() ? "powershell" : "bash");
}

/** Seed a new API-client request from the flow and open its tab, unsent, as History's
 * `HistoryPanel.openRequest` does, composed from the public api actions. */
export function openInApiClient(request: CurlableRequest): string {
  const { apiActions, layoutActions } = useAppStore.getState();
  const id = apiActions.createApiRequest();
  apiActions.patchApiRequest(id, { method: request.method, url: request.url, body: request.body ?? "" });
  for (const h of request.headers) {
    apiActions.addHeader(id);
    const rows = useAppStore.getState().apiRequests[id].headers;
    apiActions.updateHeader(id, rows[rows.length - 1].id, { name: h.name, value: h.value });
  }
  layoutActions.openApiRequestTab(id);
  return id;
}

/* ── see and copy the request (a request must be viewable and copyable) ─────────── */

/** `GET /health HTTP/1.1` — what the request tab leads with. A tunnel has no request line. */
export function requestLine(f: Pick<FlowSummary, "method" | "path" | "httpVersion">): string {
  return `${f.method} ${f.path === "" ? "/" : f.path} ${f.httpVersion === "" ? "HTTP/1.1" : f.httpVersion}`;
}

/** `HTTP/1.1 200` — what the response tab leads with; null when no response arrived. */
export function statusLine(f: Pick<FlowSummary, "status" | "httpVersion">): string | null {
  if (f.status === null) return null;
  return `${f.httpVersion === "" ? "HTTP/1.1" : f.httpVersion} ${f.status}`;
}

/** A body as clipboard text: the text itself, or a bracketed note for what text cannot hold. */
function bodyText(body: FlowDetail["requestBody"]): string | null {
  if (body === null) return null;
  const main = body.text ?? (body.base64 !== null && body.base64 !== "" ? `[binary body, ${body.size} bytes]` : "");
  if (main === "") return null;
  return body.truncated ? `${main}\n[truncated at the 1 MiB capture limit — ${body.size} bytes on the wire]` : main;
}

/** `head` lines, a blank line, then the body — or just the head when there is no body. */
function message(head: string[], body: string | null): string {
  return body === null ? head.join("\n") : `${head.join("\n")}\n\n${body}`;
}

/** Raw HTTP: request line, headers as captured, blank line, body. HTTP/2 pseudo-headers fold into
 * the request line (`Host:` stands in for `:authority` if absent). The proxy's own
 * `proxy-authorization` is left out (the origin never saw it); nothing else is redacted. */
export function rawRequest(summary: FlowSummary, detail: FlowDetail): string {
  const headers = detail.requestHeaders.filter(
    ([n]) => !n.startsWith(":") && n.toLowerCase() !== "proxy-authorization",
  );
  const head = [requestLine(summary)];
  if (!headers.some(([n]) => n.toLowerCase() === "host")) {
    const scheme = SCHEME[summary.proto];
    const port = summary.port === DEFAULT_PORT[scheme] ? "" : `:${summary.port}`;
    head.push(`Host: ${summary.host}${port}`);
  }
  for (const [n, v] of headers) head.push(`${n}: ${v}`);
  return message(head, bodyText(detail.requestBody));
}

/** "Copy response": status line, headers as captured, blank line, body (+ trailers after it). */
export function rawResponse(summary: FlowSummary, detail: FlowDetail): string {
  const head = [statusLine(summary) ?? "(no response)"];
  for (const [n, v] of detail.responseHeaders) {
    if (!n.startsWith(":")) head.push(`${n}: ${v}`);
  }
  const body = bodyText(detail.responseBody);
  const trailers = detail.responseTrailers.map(([n, v]) => `${n}: ${v}`);
  const out = message(head, body);
  return trailers.length === 0 ? out : `${out}\n\n${trailers.join("\n")}`;
}

/** "Copy body": the response body alone, when it is text. */
export function responseBodyText(detail: FlowDetail): string | null {
  const b = detail.responseBody;
  return b === null || b.text === null || b.text === "" ? null : b.text;
}

export type Copyable = { ok: true } | { ok: false; reason: string };

/** Every flow the proxy read can be copied (http, decrypted https, localhost, ws upgrades, gRPC
 * headers); a tunnel or a handshake that never became a request cannot, and says why. */
export function rawCopyable(summary: FlowSummary, detail: FlowDetail | null): Copyable {
  if (summary.proto === "tunnel" || summary.proto === "bypass" || summary.method === "CONNECT") {
    const exp = exportable(summary, detail);
    return { ok: false, reason: (exp as { ok: false; reason: string }).reason };
  }
  if (detail === null) return { ok: false, reason: "Loading the captured request…" };
  return { ok: true };
}
