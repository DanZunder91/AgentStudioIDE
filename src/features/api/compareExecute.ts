/** A/B dual send: A is the request's own method+url, B is `compare.*` with A's headers and body,
 * so only method+url vary. Imperative like `execute.ts`; each side settles independently and
 * `compare.sending` clears once BOTH settle. History keeps both LITERAL `{{VAR}}` requests. */

import { useAppStore } from "../../app/store";
import { activeVars, substituteVars } from "./substitute";
import { errorMessage } from "./execute";
import { sendHttp, type HttpHeader, type HttpRequest } from "./httpIpc";

/** Send A and B simultaneously, recording BOTH in history. A silent no-op (like
 * `executeHttpRequest`) for an unknown request, compare off, an empty url, or a send in flight. */
export function executeCompareRequest(requestId: string): void {
  const s = useAppStore.getState();
  const req = s.apiRequests[requestId];
  if (!req || !req.compare.enabled || req.compare.sending) return;
  if (req.url.trim() === "" || req.compare.url.trim() === "") return;

  // Resolve `{{VAR}}` ONCE, up front — both wires splice in the same values, so
  // an environment edit mid-flight can never make A and B see different secrets.
  const vars = activeVars({
    apiEnvironments: s.apiEnvironments,
    activeEnvironmentId: s.activeEnvironmentId,
  });
  // Only enabled, named headers travel; an empty-named row is scaffolding.
  const wireHeaders = req.headers.filter((h) => h.enabled && h.name.trim() !== "");
  const headers: HttpHeader[] = wireHeaders.map((h) => ({
    name: h.name,
    value: substituteVars(h.value, vars),
  }));
  // Same not-gated-on-method rule as execute.ts: a body travels whenever one is
  // present (curl sends a GET body, so do we). An empty body is null, not "".
  const body = req.body !== "" ? substituteVars(req.body, vars) : null;
  const wireA: HttpRequest = {
    method: req.method,
    url: substituteVars(req.url, vars),
    headers,
    body,
  };
  // B: SAME substituted headers and body — only method+url differ.
  const wireB: HttpRequest = {
    method: req.compare.method,
    url: substituteVars(req.compare.url, vars),
    headers,
    body,
  };

  // The shared LITERAL parts of both history entries — placeholders kept, never
  // a resolved secret. One timestamp: it was one Send.
  const literalHeaders = wireHeaders.map((h) => ({ name: h.name, value: h.value }));
  const literalBody = req.body;
  const at = Date.now();

  // Setting sending=true also clears both previous outcomes (the store action
  // owns that), so the split view starts blank on every compare send.
  s.apiActions.setCompareSending(requestId, true);

  // Counted down by each side's settle handler — synchronously in the SAME
  // microtask as the second outcome landing, so `sending` can never be observed
  // false while an outcome is still missing.
  let pending = 2;
  const settled = () => {
    pending -= 1;
    if (pending === 0) {
      useAppStore.getState().apiActions.setCompareSending(requestId, false);
    }
  };

  const settle = (
    side: "a" | "b",
    literalMethod: string,
    literalUrl: string,
    promise: Promise<Awaited<ReturnType<typeof sendHttp>>>,
  ): void => {
    const literal = {
      method: literalMethod,
      url: literalUrl,
      headers: literalHeaders,
      body: literalBody,
      at,
    };
    promise.then(
      (response) => {
        const a = useAppStore.getState().apiActions;
        a.setCompareResponse(requestId, side, response);
        a.recordApiHistory({
          ...literal,
          status: response.status,
          statusText: response.statusText,
          durationMs: response.durationMs,
          sizeBytes: response.sizeBytes,
          error: null,
        });
        settled();
      },
      (err) => {
        const a = useAppStore.getState().apiActions;
        const message = errorMessage(err);
        a.setCompareError(requestId, side, message);
        a.recordApiHistory({
          ...literal,
          status: null,
          statusText: null,
          durationMs: null,
          sizeBytes: null,
          error: message,
        });
        settled();
      },
    );
  };

  // Fire BOTH sends before attaching any handler — truly simultaneous, never
  // sequential: B must not wait on A's network round-trip.
  const inFlightA = sendHttp(wireA);
  const inFlightB = sendHttp(wireB);
  settle("a", req.method, req.url, inFlightA);
  settle("b", req.compare.method, req.compare.url, inFlightB);
}
