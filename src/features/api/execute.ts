/** Shared HTTP send path (Send and History re-run). Imperative: uses getState() and runs the
 * network effect, never inside a producer. {{VAR}} is resolved only for the wire request; history
 * keeps the LITERAL, pre-substitution request. */

import { useAppStore } from "../../app/store";
import { activeVars, substituteVars } from "./substitute";
import { sendHttp, type HttpHeader, type HttpRequest } from "./httpIpc";
import { grpcSend, type GrpcMetadata, type GrpcRequest } from "./grpcIpc";

/** The methods the pickers offer (A bar and the compare B bar), in the usual order. */
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/** Methods that carry a request body — the body editor shows only for these. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const methodHasBody = (method: string): boolean => BODY_METHODS.has(method);

/** A send failure may arrive as an Error or a bare string (Rust rejects with one). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve, send, set the response/error, record in history. A no-op when the request is unknown,
 * has an empty url, or is already sending. */
export function executeHttpRequest(
  requestId: string,
  /** Extra {{VAR}} values for this send only: a sequence's captures (sequenceExecute.ts). */
  extraVars?: Record<string, string>,
): void {
  const s = useAppStore.getState();
  const req = s.apiRequests[requestId];
  if (!req || req.url.trim() === "" || req.sending) return;

  // extraVars spread LAST: a value a sequence just captured beats a saved env var of that name.
  const vars = {
    ...activeVars({
      apiEnvironments: s.apiEnvironments,
      activeEnvironmentId: s.activeEnvironmentId,
    }),
    ...extraVars,
  };
  // Only enabled, named headers travel; an empty-named row is scaffolding.
  const wireHeaders = req.headers.filter((h) => h.enabled && h.name.trim() !== "");
  const headers: HttpHeader[] = wireHeaders.map((h) => ({
    name: h.name,
    value: substituteVars(h.value, vars),
  }));
  // Send the body whenever one is present — NOT gated on the method: an imported
  // curl can be a GET (or DELETE) that carries a body (pasted requests can look like
  // `--request GET --data '{…}'`), and curl sends it. An empty body is null, not "".
  const body = req.body !== "" ? substituteVars(req.body, vars) : null;
  const request: HttpRequest = {
    method: req.method,
    url: substituteVars(req.url, vars),
    headers,
    body,
  };

  // LITERAL snapshot built from req.*, never from vars: logging what was actually sent would write
  // live credentials (sequence captures included) to the history file.
  const literal = {
    method: req.method,
    url: req.url,
    headers: wireHeaders.map((h) => ({ name: h.name, value: h.value })),
    body: req.body,
    at: Date.now(),
  };

  s.apiActions.setApiSending(requestId, true);
  sendHttp(request).then(
    (response) => {
      const a = useAppStore.getState().apiActions;
      a.setApiResponse(requestId, response);
      a.recordApiHistory({
        ...literal,
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        sizeBytes: response.sizeBytes,
        error: null,
      });
    },
    (err) => {
      const a = useAppStore.getState().apiActions;
      const message = errorMessage(err);
      a.setApiError(requestId, message);
      a.recordApiHistory({
        ...literal,
        status: null,
        statusText: null,
        durationMs: null,
        sizeBytes: null,
        error: message,
      });
    },
  );
}

/** gRPC twin of executeHttpRequest: {{VAR}} in url, enabled metadata and body is resolved for the
 * wire only; history keeps the LITERAL request. A no-op when unknown, in flight, or the
 * endpoint/service/method is incomplete. A non-OK status resolves and is recorded. */
export function executeGrpcRequest(requestId: string): void {
  const s = useAppStore.getState();
  const req = s.apiRequests[requestId];
  if (!req || req.grpc.sending) return;
  const { service, method } = req.grpc;
  if (req.url.trim() === "" || service === "" || method === "") return;

  // Resolve `{{VAR}}` FIRST, so the secret is spliced in only on the wire.
  const vars = activeVars({
    apiEnvironments: s.apiEnvironments,
    activeEnvironmentId: s.activeEnvironmentId,
  });
  // Only enabled, named metadata rows travel (same rule as HTTP headers).
  const wireMeta = req.headers.filter((h) => h.enabled && h.name.trim() !== "");
  const metadata: GrpcMetadata[] = wireMeta.map((h) => ({
    name: h.name,
    value: substituteVars(h.value, vars),
  }));
  const request: GrpcRequest = {
    endpoint: substituteVars(req.url, vars),
    service,
    method,
    message: substituteVars(req.body, vars),
    metadata,
    plaintext: req.grpc.plaintext,
  };

  // The LITERAL snapshot recorded in history — placeholders kept, never a resolved
  // secret. Metadata values are the typed template, not substituted.
  const literal = {
    protocol: "grpc" as const,
    grpcService: service,
    method,
    url: req.url,
    headers: wireMeta.map((h) => ({ name: h.name, value: h.value })),
    body: req.body,
    at: Date.now(),
  };

  s.apiActions.setGrpcSending(requestId, true);
  grpcSend(request).then(
    (response) => {
      const a = useAppStore.getState().apiActions;
      a.setGrpcResponse(requestId, response);
      a.recordApiHistory({
        ...literal,
        // gRPC re-uses HTTP's outcome columns: statusCode → status, statusName
        // (+ grpc-message) → statusText, no duration/size, error → null (a non-OK
        // status is NOT a transport error).
        status: response.statusCode,
        statusText: response.error
          ? `${response.statusName}: ${response.error}`
          : response.statusName,
        durationMs: null,
        sizeBytes: null,
        error: null,
      });
    },
    (err) => {
      const a = useAppStore.getState().apiActions;
      const message = errorMessage(err);
      a.setGrpcError(requestId, message);
      a.recordApiHistory({
        ...literal,
        status: null,
        statusText: null,
        durationMs: null,
        sizeBytes: null,
        error: message,
      });
    },
  );
}
