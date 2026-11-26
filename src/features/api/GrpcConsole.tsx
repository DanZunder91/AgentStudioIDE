/** Native in-process tonic call, so no "install X" path. Send goes through executeGrpcRequest
 * (substitution + history in one place); endpoint/message/metadata reuse url/body/headers, and the
 * gRPC-only state lives in `req.grpc`. */

import { useState } from "react";

import { useAppStore } from "../../app/store";
import type { GrpcState } from "../../app/store";
import { errorMessage, executeGrpcRequest } from "./execute";
import { grpcReflect } from "./grpcIpc";
import { activeVars, substituteVars } from "./substitute";
import "./api.css";

/** The status-pill colour class: OK (0) reads as success, anything else as error. */
function statusClass(statusCode: number): string {
  return statusCode === 0 ? "api-status--ok" : "api-status--grpcerr";
}

/** Rust always sends JSON; the parse guard mirrors formatBody. */
function formatMessage(message: string): string {
  try {
    return JSON.stringify(JSON.parse(message), null, 2);
  } catch {
    return message;
  }
}

export function GrpcConsole({
  requestId,
}: {
  requestId: string;
}): React.JSX.Element | null {
  const req = useAppStore((s) => s.apiRequests[requestId]);
  const apiEnvironments = useAppStore((s) => s.apiEnvironments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);
  const patchApiRequest = useAppStore((s) => s.apiActions.patchApiRequest);
  const addHeader = useAppStore((s) => s.apiActions.addHeader);
  const updateHeader = useAppStore((s) => s.apiActions.updateHeader);
  const removeHeader = useAppStore((s) => s.apiActions.removeHeader);
  const setActiveEnvironment = useAppStore(
    (s) => s.apiActions.setActiveEnvironment,
  );
  const setGrpcPlaintext = useAppStore((s) => s.apiActions.setGrpcPlaintext);
  const grpcListing = useAppStore((s) => s.apiActions.grpcListing);
  const grpcListed = useAppStore((s) => s.apiActions.grpcListed);
  const grpcListError = useAppStore((s) => s.apiActions.grpcListError);
  const setGrpcService = useAppStore((s) => s.apiActions.setGrpcService);
  const setGrpcMethod = useAppStore((s) => s.apiActions.setGrpcMethod);

  const [manual, setManual] = useState(false);

  // Defensive, like ApiRequestView: the tab keys a live request, so this is
  // unreachable through the UI — but keeps the view total on a stale id.
  if (!req) return null;

  const grpc = req.grpc;
  const endpoint = req.url;
  const services = grpc.schema?.services ?? [];
  const hasSchema = services.length > 0;
  // Use the reflected picker unless the user opted into manual entry, or there is
  // no schema to pick from yet.
  const showManual = manual || !hasSchema;
  const selectedService = services.find((sv) => sv.name === grpc.service);
  const methodOptions = selectedService?.methods ?? [];

  const canReflect = endpoint.trim() !== "" && !grpc.listing;
  const canSend =
    endpoint.trim() !== "" &&
    grpc.service !== "" &&
    grpc.method !== "" &&
    !grpc.sending;

  // No internal guards: the button gates reflect (disabled while endpoint-empty /
  // listing), so this only fires from a valid resting state. The endpoint is
  // substituted the same way the send path resolves it.
  const reflect = () => {
    const st = useAppStore.getState();
    const vars = activeVars({
      apiEnvironments: st.apiEnvironments,
      activeEnvironmentId: st.activeEnvironmentId,
    });
    const resolved = substituteVars(endpoint, vars);
    grpcListing(requestId);
    grpcReflect(resolved, grpc.plaintext).then(
      (schema) => grpcListed(requestId, schema),
      (err) => grpcListError(requestId, errorMessage(err)),
    );
  };

  // The whole send path — substitution, network, record-to-history — lives in the
  // shared `executeGrpcRequest` (also used by the History re-run). It re-checks the
  // send guard, so `canSend` here only drives the button's disabled state.
  const send = () => executeGrpcRequest(requestId);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="grpc-console" data-testid="grpc-console">
      <div className="api-bar">
        <input
          className="api-url"
          type="text"
          aria-label="gRPC endpoint"
          placeholder="localhost:50051"
          value={endpoint}
          onChange={(e) => patchApiRequest(requestId, { url: e.target.value })}
          onKeyDown={onKeyDown}
        />
        <label className="grpc-plaintext">
          <input
            type="checkbox"
            aria-label="Use plaintext (no TLS)"
            checked={grpc.plaintext}
            onChange={(e) => setGrpcPlaintext(requestId, e.target.checked)}
          />
          Plaintext
        </label>
        <select
          className="api-env-select"
          aria-label="Environment"
          value={activeEnvironmentId ?? ""}
          onChange={(e) =>
            setActiveEnvironment(e.target.value === "" ? null : e.target.value)
          }
        >
          <option value="">No environment</option>
          {apiEnvironments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="api-add-header"
          data-testid="grpc-reflect"
          disabled={!canReflect}
          onClick={reflect}
        >
          {grpc.listing ? "Reflecting…" : "Reflect"}
        </button>
        <button
          type="button"
          className="api-send"
          data-testid="grpc-send"
          aria-label="Send request"
          disabled={!canSend}
          onClick={send}
        >
          {grpc.sending ? "Sending…" : "Send"}
        </button>
      </div>

      {grpc.listError && (
        <div className="api-error" data-testid="grpc-list-error" role="alert">
          {grpc.listError}
        </div>
      )}

      <section className="api-section">
        <div className="api-section__head">
          <span className="api-section__label">Service &amp; method</span>
          {hasSchema && (
            <button
              type="button"
              className="api-add-header"
              data-testid="grpc-toggle-manual"
              onClick={() => setManual((v) => !v)}
            >
              {showManual ? "Use reflected list" : "Enter manually"}
            </button>
          )}
        </div>
        {showManual ? (
          <div className="api-header-row">
            <input
              type="text"
              className="api-header-row__name"
              aria-label="gRPC service"
              placeholder="package.Service"
              value={grpc.service}
              onChange={(e) => setGrpcService(requestId, e.target.value)}
            />
            <input
              type="text"
              className="api-header-row__value"
              aria-label="gRPC method"
              placeholder="Method"
              value={grpc.method}
              onChange={(e) => setGrpcMethod(requestId, e.target.value)}
            />
          </div>
        ) : (
          <div className="api-header-row">
            <select
              className="api-method"
              aria-label="gRPC service"
              value={grpc.service}
              onChange={(e) => setGrpcService(requestId, e.target.value)}
            >
              <option value="">Select a service…</option>
              {services.map((sv) => (
                <option key={sv.name} value={sv.name}>
                  {sv.name}
                </option>
              ))}
            </select>
            <select
              className="api-method"
              aria-label="gRPC method"
              value={grpc.method}
              disabled={grpc.service === ""}
              onChange={(e) => setGrpcMethod(requestId, e.target.value)}
            >
              <option value="">Select a method…</option>
              {methodOptions.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section className="api-section">
        <div className="api-section__head">
          <span className="api-section__label">Metadata</span>
          <button
            type="button"
            className="api-add-header"
            data-testid="grpc-add-metadata"
            onClick={() => addHeader(requestId)}
          >
            + Add metadata
          </button>
        </div>
        {req.headers.length === 0 ? (
          <div className="api-section__empty">No metadata</div>
        ) : (
          <div className="api-headers">
            {req.headers.map((h) => (
              <div
                className="api-header-row"
                data-testid="grpc-metadata-row"
                key={h.id}
              >
                <input
                  type="checkbox"
                  className="api-header-row__enabled"
                  aria-label="Metadata enabled"
                  checked={h.enabled}
                  onChange={(e) =>
                    updateHeader(requestId, h.id, { enabled: e.target.checked })
                  }
                />
                <input
                  type="text"
                  className="api-header-row__name"
                  aria-label="Metadata name"
                  placeholder="Metadata name"
                  value={h.name}
                  onChange={(e) =>
                    updateHeader(requestId, h.id, { name: e.target.value })
                  }
                />
                <input
                  type="text"
                  className="api-header-row__value"
                  aria-label="Metadata value"
                  placeholder="Value"
                  value={h.value}
                  onChange={(e) =>
                    updateHeader(requestId, h.id, { value: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="api-header-row__remove"
                  aria-label="Remove metadata"
                  title="Remove metadata"
                  onClick={() => removeHeader(requestId, h.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="api-section">
        <span className="api-section__label">Request message (JSON)</span>
        <textarea
          className="api-body"
          aria-label="Request message (JSON)"
          placeholder="{ }"
          value={req.body}
          onChange={(e) => patchApiRequest(requestId, { body: e.target.value })}
          onKeyDown={onKeyDown}
        />
      </section>

      <GrpcResponsePanel grpc={grpc} />
    </div>
  );
}

/** One `if` per state, so `response` narrows non-null (like ResponsePanel). */
function GrpcResponsePanel({
  grpc,
}: {
  grpc: GrpcState;
}): React.JSX.Element | null {
  if (grpc.error) {
    return (
      <section className="api-response-panel">
        <div className="api-error" data-testid="grpc-error" role="alert">
          {grpc.error}
        </div>
      </section>
    );
  }
  if (!grpc.response) return null;

  const response = grpc.response;
  return (
    <section className="api-response-panel">
      <div className="api-response" data-testid="grpc-response">
        <div className="api-response__meta">
          <span
            className={`api-status ${statusClass(response.statusCode)}`}
            data-testid="grpc-status"
          >
            {response.statusCode} {response.statusName}
          </span>
          {response.error && (
            <span className="api-response__statustext">{response.error}</span>
          )}
        </div>
        <pre className="api-response__body" data-testid="grpc-response-body">
          {formatMessage(response.message)}
        </pre>
      </div>
    </section>
  );
}
