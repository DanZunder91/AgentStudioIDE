/**
 * execute — the shared HTTP send path for the built-in API client (M6).
 *
 * Both the request view's Send button and the History panel's "re-run" go through
 * `executeHttpRequest`, so the substitution + record-to-history behaviour lives in
 * exactly one place. It is imperative plumbing (like `app/bridge.ts`): it reads and
 * mutates via `useAppStore.getState()` and runs the network EFFECT — never inside a
 * store producer.
 *
 * Secret-safety: `{{VAR}}` is resolved from the active environment ONLY
 * to build the wire request, so a secret exists only on the wire; the history entry
 * we record keeps the LITERAL, pre-substitution request.
 */

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

/**
 * Execute the request identified by `requestId`: resolve `{{VAR}}` from the active
 * environment, send it, set the response/error on the request, and RECORD it in the
 * history log (the literal request + outcome + a timestamp). A no-op when the
 * request is unknown, has an empty url, or is already sending — the same guard the
 * Send button applied inline.
 */
export function executeHttpRequest(
  requestId: string,
  /**
   * Extra `{{VAR}}` values for THIS send only — a request sequence's captured
   * values (`sequenceExecute.ts`). Optional, so every existing caller is
   * unchanged.
   */
  extraVars?: Record<string, string>,
): void {
  const s = useAppStore.getState();
  const req = s.apiRequests[requestId];
  if (!req || req.url.trim() === "" || req.sending) return;

  // Resolve `{{VAR}}` FIRST, so the secret is spliced in only on the wire.
  // `extraVars` is spread LAST and therefore shadows the environment: a value a
  // sequence captured a second ago is more current than a saved env var of the
  // same name, and that precedence is the whole point of a chained run.
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

  // The LITERAL snapshot recorded in history — placeholders kept, never a resolved
  // secret. Header values are the typed template, not substituted.
  //
  // 🔴 Built from `req.*`, and it must STAY that way: because it never reads
  // `vars`, a bearer token a sequence captured a moment ago is kept out of the
  // history file for free. "Improving" this to log what was actually sent would
  // write live credentials to disk.
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

/**
 * Execute the gRPC unary call for `requestId`: resolve
 * `{{VAR}}` in the endpoint (`req.url`), every enabled metadata value (`req.headers`),
 * and the message (`req.body`) from the active environment, send it, set the
 * response/error on the request's `grpc` sub-state, and RECORD it in history (the
 * LITERAL, pre-substitution request). A no-op when the request is unknown, a call
 * is already in flight, or the endpoint/service/method are incomplete.
 *
 * Secret-safety: `{{VAR}}` is resolved ONLY to build the wire request,
 * so a secret exists only on the wire; the history entry keeps the LITERAL request.
 * A non-OK gRPC status RESOLVES (recorded as the outcome), like HTTP's non-2xx.
 */
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
