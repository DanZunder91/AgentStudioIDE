/** The API client's request/response tab (M6), keyed by `requestId` (state: the store's `api`
 * slice). Secrets live only in Rust-persisted environments; `{{VAR}}` is resolved on Send over
 * url, enabled header values and body, so the real secret exists only on the wire. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import type { ApiRequestState } from "../../app/store";
import { loadApiStore, type Environment } from "./apiStoreIpc";
import { CompareBar, ComparePanel } from "./ComparePanel";
import { executeCompareRequest } from "./compareExecute";
import { buildCurl, type CurlShell } from "./curlExport";
import {
  isCurlCommand,
  isPowerShellWebRequest,
  parseCurl,
  POWERSHELL_PASTE_HINT,
} from "./curlParse";
import { isWindowsPlatform } from "./platform";
import { executeHttpRequest, methodHasBody, HTTP_METHODS } from "./execute";
import { JsonBodyEditor } from "./JsonBodyEditor";
import { ResponseBody } from "./ResponseBody";
import {
  formatBody,
  humanizeSize,
  parseJsonBody,
  statusClass,
} from "./responseFormat";
import { activeVars, substituteVars } from "./substitute";
import { WsConsole } from "./WsConsole";
import { GrpcConsole } from "./GrpcConsole";
import "./api.css";

export function ApiRequestView({
  requestId,
}: {
  requestId: string;
}): React.JSX.Element | null {
  const req = useAppStore((s) => s.apiRequests[requestId]);
  const apiEnvironments = useAppStore((s) => s.apiEnvironments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);
  const patchApiRequest = useAppStore((s) => s.apiActions.patchApiRequest);
  const undoApiBody = useAppStore((s) => s.apiActions.undoApiBody);
  const duplicateApiRequest = useAppStore((s) => s.apiActions.duplicateApiRequest);
  const openApiRequestTab = useAppStore((s) => s.layoutActions.openApiRequestTab);
  const redoApiBody = useAppStore((s) => s.apiActions.redoApiBody);
  const importCurl = useAppStore((s) => s.apiActions.importCurl);
  const addHeader = useAppStore((s) => s.apiActions.addHeader);
  const updateHeader = useAppStore((s) => s.apiActions.updateHeader);
  const removeHeader = useAppStore((s) => s.apiActions.removeHeader);
  const setActiveEnvironment = useAppStore(
    (s) => s.apiActions.setActiveEnvironment,
  );
  const setApiProtocol = useAppStore((s) => s.apiActions.setApiProtocol);
  const hydrateApiStore = useAppStore((s) => s.apiActions.hydrateApiStore);
  const setCompareEnabled = useAppStore((s) => s.apiActions.setCompareEnabled);
  const patchCompare = useAppStore((s) => s.apiActions.patchCompare);

  // Hydrate the durable store once, on first mount of an API view. Gated on the
  // store flag (not a module-level latch) so `resetStore` re-arms it between
  // tests; the `cancelled` guard drops a late resolve after unmount.
  useEffect(() => {
    if (useAppStore.getState().apiStoreLoaded) return;
    let cancelled = false;
    void loadApiStore().then((store) => {
      if (!cancelled) hydrateApiStore(store);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrateApiStore]);

  // "Copied" (Copy-as-cURL) is keyed to the `req`/`apiEnvironments` identities (immer replaces
  // them per patch), so it retires when any input changes. Declared BEFORE the early return.
  const [curlCopiedFor, setCurlCopiedFor] = useState<{
    req: ApiRequestState;
    envs: Environment[];
    envId: string | null;
    shell: CurlShell;
  } | null>(null);
  // Windows: which shell "Copy as cURL" writes for. PowerShell first — it is what
  // the IDE's own terminals run there; macOS and Linux only ever get bash.
  const onWindows = isWindowsPlatform();
  const [curlShell, setCurlShell] = useState<CurlShell>(onWindows ? "powershell" : "bash");
  // Set when a paste was recognisably not something the URL field can read (an
  // Invoke-WebRequest); cleared by the next edit or a real import.
  const [pasteHint, setPasteHint] = useState<string | null>(null);

  /** Keep the `.api-view` scroll across a tab move (`Pane` destroys inactive DOM): saved on
   * unmount, restored in a layout effect before paint. Declared ABOVE `if (!req) return null;` for
   * hook order; the ref is null on that path, so the effect is a no-op. */
  const viewRef = useRef<HTMLDivElement>(null);
  const setScrollOffset = useAppStore((s) => s.uiActions.setScrollOffset);
  useLayoutEffect(() => {
    const box = viewRef.current;
    if (box === null) return;
    // Read non-reactively: subscribing would re-render this view every time
    // ANY surface scrolled.
    const saved = useAppStore.getState().scrollOffsets[`api:${requestId}`];
    if (saved !== undefined) box.scrollTop = saved;
    return () => setScrollOffset(`api:${requestId}`, box.scrollTop);
  }, [requestId, setScrollOffset]);

  if (!req) return null;

  // In A/B compare mode one Send drives two wires, so both the disabled state
  // and the "Sending…" label read the compare flag instead of the single one.
  const sending = req.compare.enabled ? req.compare.sending : req.sending;
  const canSend =
    req.url.trim() !== "" &&
    (!req.compare.enabled || req.compare.url.trim() !== "") &&
    !sending;
  // Show the body editor for methods that carry one, OR whenever a body is present
  // — an imported curl can be a GET/DELETE that carries a body (curl allows it), and
  // the send path sends any non-empty body regardless of method.
  const showBody = methodHasBody(req.method) || req.body.trim() !== "";

  // Sending lives in `executeHttpRequest` / `executeCompareRequest` (also History's re-run); both
  // re-check the send guard, so `canSend` only drives the button.
  const send = () =>
    req.compare.enabled
      ? executeCompareRequest(requestId)
      : executeHttpRequest(requestId);

  // Entering compare with an empty B starts B from A — the common case compares
  // the same path against a second host or a tweaked param, so a copy beats a
  // blank (and a B the user already typed is never clobbered).
  const toggleCompare = () => {
    const enabling = !req.compare.enabled;
    if (enabling && req.compare.url.trim() === "") {
      patchCompare(requestId, { url: req.url, method: req.method });
    }
    setCompareEnabled(requestId, enabling);
  };

  // A pasted `curl …` expands into the request; returns true when imported so the caller drops
  // the plain paste. DevTools' "Copy as PowerShell" is refused with a hint, the field kept.
  const tryImportCurl = (text: string): boolean => {
    if (isPowerShellWebRequest(text)) {
      setPasteHint(POWERSHELL_PASTE_HINT);
      return true;
    }
    if (!isCurlCommand(text)) return false;
    const parsed = parseCurl(text);
    if (!parsed) return false;
    setPasteHint(null);
    importCurl(requestId, parsed);
    return true;
  };

  const onUrlChange = (value: string) => {
    if (tryImportCurl(value)) return;
    setPasteHint(null);
    patchApiRequest(requestId, { url: value });
  };

  // Read a multi-line curl from the raw clipboard: the single-line <input> would drop every
  // `\`-continued line before `onChange` runs.
  const onUrlPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (tryImportCurl(e.clipboardData.getData("text"))) e.preventDefault();
  };

  // Cmd/Ctrl+Enter sends from the URL or body field, matching a browser dev-tools.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  // "Format" pretty-prints the body when it holds valid JSON; the button is
  // disabled otherwise (empty or unparseable), so `formatBodyJson` only ever runs
  // with a body that parses.
  const canFormat = (() => {
    if (req.body.trim() === "") return false;
    try {
      JSON.parse(req.body);
      return true;
    } catch {
      return false;
    }
  })();
  const formatBodyJson = () =>
    patchApiRequest(requestId, {
      body: JSON.stringify(JSON.parse(req.body), null, 2),
    });

  const curlCopied =
    curlCopiedFor !== null &&
    curlCopiedFor.req === req &&
    curlCopiedFor.envs === apiEnvironments &&
    curlCopiedFor.envId === activeEnvironmentId &&
    curlCopiedFor.shell === curlShell;

  // Resolves through the send path's own seam (`activeVars` + `substituteVars`), so it matches
  // the wire exactly; the resolved secret goes to the CLIPBOARD only, never store or file.
  const curlCommand = (): string => {
    const vars = activeVars({ apiEnvironments, activeEnvironmentId });
    return buildCurl(
      {
        method: req.method,
        url: req.url,
        headers: req.headers,
        // Same rule as the send path: any non-empty body travels, method or no
        // (an imported curl can be a GET carrying a body). Empty means null.
        body: req.body !== "" ? req.body : null,
      },
      (t) => substituteVars(t, vars),
      curlShell,
    );
  };
  // Measured on Windows 11: System32's curl.exe reads its arguments in the ANSI
  // code page, so `é` arrives as one invalid byte and `世` as `?` — from
  // PowerShell and cmd alike. A copy that will silently mangle text says so.
  const curlLosesText = curlShell !== "bash" && /\P{ASCII}/u.test(curlCommand());

  const copyCurl = (): void => {
    if (!navigator.clipboard) return;
    const command = curlCommand();
    const claim = { req, envs: apiEnvironments, envId: activeEnvironmentId, shell: curlShell };
    void navigator.clipboard
      .writeText(command)
      .then(() => setCurlCopiedFor(claim))
      // A refused clipboard must not claim success (ResponseBody's rule): the
      // catch is observable — it clears the claim rather than swallowing.
      .catch(() => setCurlCopiedFor(null));
  };

  return (
    <div className="api-view" data-testid="api-request" ref={viewRef}>
      <div
        className="api-protocol"
        role="group"
        aria-label="Protocol"
        data-testid="api-protocol"
      >
        <button
          type="button"
          className={`api-protocol__opt${req.protocol === "http" ? " is-active" : ""}`}
          aria-pressed={req.protocol === "http"}
          onClick={() => setApiProtocol(requestId, "http")}
        >
          HTTP
        </button>
        <button
          type="button"
          className={`api-protocol__opt${req.protocol === "ws" ? " is-active" : ""}`}
          aria-pressed={req.protocol === "ws"}
          onClick={() => setApiProtocol(requestId, "ws")}
        >
          WebSocket
        </button>
        <button
          type="button"
          className={`api-protocol__opt${req.protocol === "grpc" ? " is-active" : ""}`}
          aria-pressed={req.protocol === "grpc"}
          onClick={() => setApiProtocol(requestId, "grpc")}
        >
          gRPC
        </button>
      </div>

      {req.protocol === "ws" ? (
        <WsConsole requestId={requestId} />
      ) : req.protocol === "grpc" ? (
        <GrpcConsole requestId={requestId} />
      ) : (
        <>
          <div className="api-bar">
            <select
              className="api-method"
              aria-label="HTTP method"
              value={req.method}
              onChange={(e) =>
                patchApiRequest(requestId, { method: e.target.value })
              }
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className="api-url"
              type="text"
              aria-label="Request URL"
              placeholder="https://api.example.com/…  (or paste a curl command)"
              value={req.url}
              onChange={(e) => onUrlChange(e.target.value)}
              onPaste={onUrlPaste}
              onKeyDown={onKeyDown}
            />
            <select
              className="api-env-select"
              aria-label="Environment"
              value={activeEnvironmentId ?? ""}
              onChange={(e) =>
                setActiveEnvironment(
                  e.target.value === "" ? null : e.target.value,
                )
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
              className="api-compare-toggle"
              data-testid="api-compare-toggle"
              aria-pressed={req.compare.enabled}
              title="Compare two requests side by side — one Send fires both; headers and body apply to both"
              onClick={toggleCompare}
            >
              A/B
            </button>
            {/* Postman's Duplicate: a new tab with the same
                params, so a variant can be tried without losing the original. */}
            <button
              type="button"
              className="api-add-header"
              data-testid="api-duplicate"
              aria-label="Duplicate this request"
              title="Open a copy of this request in a new tab"
              onClick={() => {
                // Non-null: this view returns null for an unknown request, so by
                // the time the button is on screen the source certainly exists.
                openApiRequestTab(duplicateApiRequest(requestId)!);
              }}
            >
              Duplicate
            </button>
            {/* Windows only: the quoting differs per shell, and a bash command
                pasted into PowerShell or cmd is simply broken (curlExport.ts). */}
            {onWindows && (
              <select
                className="api-curl-shell"
                data-testid="api-curl-shell"
                aria-label="Shell for Copy as cURL"
                title="Which shell the copied curl command is written for"
                value={curlShell}
                onChange={(e) => setCurlShell(e.target.value as CurlShell)}
              >
                <option value="powershell">PowerShell</option>
                <option value="cmd">cmd</option>
                <option value="bash">bash</option>
              </select>
            )}
            <button
              type="button"
              className="api-add-header"
              data-testid="api-copy-curl"
              aria-label="Copy as cURL"
              title="Copy this request as a curl command — {{VAR}} resolved from the active environment, exactly as Send would"
              onClick={copyCurl}
            >
              {curlCopied ? "Copied" : "Copy as cURL"}
            </button>
            <button
              type="button"
              className="api-send"
              data-testid="api-send"
              disabled={!canSend}
              onClick={send}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>

          {pasteHint !== null && (
            <p className="api-notice" role="status" data-testid="api-paste-hint">
              {pasteHint}
            </p>
          )}
          {curlLosesText && (
            <p className="api-notice" role="note" data-testid="api-curl-ascii-note">
              This request has non-ASCII text, and Windows&apos; built-in curl.exe reads its
              arguments in the system code page — from {curlShell === "cmd" ? "cmd" : "PowerShell"}{" "}
              that text will not arrive intact. Pick bash (Git Bash or WSL curl) for it.
            </p>
          )}

          {req.compare.enabled && (
            <CompareBar requestId={requestId} onSend={send} />
          )}

          <EnvManager />

          <section className="api-section">
            <div className="api-section__head">
              <span className="api-section__label">Headers</span>
              <button
                type="button"
                className="api-add-header"
                data-testid="api-add-header"
                onClick={() => addHeader(requestId)}
              >
                + Add header
              </button>
            </div>
            {req.headers.length === 0 ? (
              <div className="api-section__empty">No headers</div>
            ) : (
              <div className="api-headers">
                {req.headers.map((h) => (
                  <div
                    className="api-header-row"
                    data-testid="api-header-row"
                    key={h.id}
                  >
                    <input
                      type="checkbox"
                      className="api-header-row__enabled"
                      aria-label="Header enabled"
                      checked={h.enabled}
                      onChange={(e) =>
                        updateHeader(requestId, h.id, {
                          enabled: e.target.checked,
                        })
                      }
                    />
                    <input
                      type="text"
                      className="api-header-row__name"
                      aria-label="Header name"
                      placeholder="Header name"
                      value={h.name}
                      onChange={(e) =>
                        updateHeader(requestId, h.id, { name: e.target.value })
                      }
                    />
                    <input
                      type="text"
                      className="api-header-row__value"
                      aria-label="Header value"
                      placeholder="Value"
                      value={h.value}
                      onChange={(e) =>
                        updateHeader(requestId, h.id, { value: e.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="api-header-row__remove"
                      aria-label="Remove header"
                      title="Remove header"
                      onClick={() => removeHeader(requestId, h.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {showBody && (
            <section className="api-section">
              <div className="api-section__head">
                <span className="api-section__label">Body</span>
                <button
                  type="button"
                  className="api-add-header"
                  data-testid="format-json"
                  disabled={!canFormat}
                  onClick={formatBodyJson}
                >
                  Format
                </button>
              </div>
              <JsonBodyEditor
                value={req.body}
                ariaLabel="Request body"
                placeholder="Request body"
                onChange={(v) => patchApiRequest(requestId, { body: v })}
                onKeyDown={onKeyDown}
                onUndo={() => undoApiBody(requestId)}
                onRedo={() => redoApiBody(requestId)}
              />
            </section>
          )}

          {req.compare.enabled ? (
            <ComparePanel requestId={requestId} />
          ) : (
            <ResponsePanel requestId={requestId} req={req} />
          )}
        </>
      )}
    </div>
  );
}

/** Environments editor: the ONE place a secret is entered; variables hold live tokens and
 * persist only through the Rust store. */
function EnvManager(): React.JSX.Element {
  const environments = useAppStore((s) => s.apiEnvironments);
  const addEnvironment = useAppStore((s) => s.apiActions.addEnvironment);
  const [open, setOpen] = useState(false);

  return (
    <section className="api-section">
      <button
        type="button"
        className="api-add-header"
        data-testid="api-manage-envs"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Manage environments
      </button>
      {open && (
        <div className="api-env-manager" data-testid="api-env-manager">
          <button
            type="button"
            className="api-add-header"
            data-testid="api-add-env"
            onClick={() => addEnvironment("New environment")}
          >
            + Add environment
          </button>
          {environments.length === 0 ? (
            <div className="api-section__empty">No environments</div>
          ) : (
            environments.map((env) => <EnvEditor key={env.id} env={env} />)
          )}
        </div>
      )}
    </section>
  );
}

/** One environment: name, variable rows, add form. Variables are keyed by `key` (wire model),
 * so values edit in place and changing a key is delete-then-add. */
function EnvEditor({ env }: { env: Environment }): React.JSX.Element {
  const renameEnvironment = useAppStore((s) => s.apiActions.renameEnvironment);
  const deleteEnvironment = useAppStore((s) => s.apiActions.deleteEnvironment);
  const setEnvVar = useAppStore((s) => s.apiActions.setEnvVar);
  const removeEnvVar = useAppStore((s) => s.apiActions.removeEnvVar);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const addKey = newKey.trim();
  // The "+ Add" button is disabled while `addKey` is empty, so this only runs
  // with a real key.
  const addVar = () => {
    setEnvVar(env.id, addKey, newValue);
    setNewKey("");
    setNewValue("");
  };

  return (
    <div className="api-env" data-testid="api-env">
      <div className="api-env__head">
        <input
          type="text"
          className="api-header-row__name"
          aria-label="Environment name"
          value={env.name}
          onChange={(e) => renameEnvironment(env.id, e.target.value)}
        />
        <button
          type="button"
          className="api-header-row__remove"
          aria-label={`Delete environment ${env.name}`}
          title="Delete environment"
          onClick={() => deleteEnvironment(env.id)}
        >
          ✕
        </button>
      </div>
      {env.variables.map((v) => (
        <div className="api-header-row" data-testid="api-env-var" key={v.key}>
          <span className="api-env-var__key">{v.key}</span>
          <input
            type="text"
            className="api-header-row__value"
            aria-label={`Value of ${v.key}`}
            value={v.value}
            onChange={(e) => setEnvVar(env.id, v.key, e.target.value)}
          />
          <button
            type="button"
            className="api-header-row__remove"
            aria-label={`Remove ${v.key}`}
            title="Remove variable"
            onClick={() => removeEnvVar(env.id, v.key)}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="api-header-row">
        <input
          type="text"
          className="api-header-row__name"
          aria-label="New variable key"
          placeholder="KEY"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <input
          type="text"
          className="api-header-row__value"
          aria-label="New variable value"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button
          type="button"
          className="api-add-header"
          aria-label="Add variable"
          disabled={addKey === ""}
          onClick={addVar}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

/** Response surface: error block, nothing yet, or the response; one `if` per state so
 * `response` narrows non-null. */
function ResponsePanel({
  requestId,
  req,
}: {
  /** The tab's stable identity — it keys the find bar's surviving state. */
  requestId: string;
  req: ApiRequestState;
}): React.JSX.Element | null {
  // Response headers are noise most of the time (they are not read on every request),
  // so the list is collapsed by default behind a `Headers (N)` toggle.
  const [headersOpen, setHeadersOpen] = useState(false);

  if (req.error) {
    return (
      <section className="api-response-panel">
        <div className="api-error" data-testid="api-error" role="alert">
          {req.error}
        </div>
      </section>
    );
  }
  if (!req.response) return null;

  const response = req.response;
  const parsed = parseJsonBody(response);
  return (
    <section className="api-response-panel">
      <div className="api-response" data-testid="api-response">
        <div className="api-response__meta">
          <span
            className={`api-status ${statusClass(response.status)}`}
            data-testid="api-status"
          >
            {response.status}
          </span>
          <span className="api-response__statustext">
            {response.statusText}
          </span>
          <span className="api-response__stat">{response.durationMs} ms</span>
          <span className="api-response__stat">
            {humanizeSize(response.sizeBytes)}
          </span>
          {response.truncated && (
            <span
              className="api-response__truncated"
              data-testid="api-truncated"
            >
              truncated
            </span>
          )}
        </div>

        {response.headers.length > 0 && (
          <div className="api-response__headers-section">
            <button
              type="button"
              className="api-response__headers-toggle"
              data-testid="response-headers-toggle"
              aria-expanded={headersOpen}
              onClick={() => setHeadersOpen((v) => !v)}
            >
              <span className="api-response__caret" aria-hidden="true">
                {headersOpen ? "▾" : "▸"}
              </span>
              Headers ({response.headers.length})
            </button>
            {headersOpen && (
              <ul
                className="api-response__headers"
                data-testid="response-headers"
              >
                {response.headers.map((h, i) => (
                  <li key={i} className="api-response__header">
                    <span className="api-response__hname">{h.name}</span>:{" "}
                    {h.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* One component owns BOTH views and the tools above them: the
            Raw/Formatted switch, Find and Copy sit in the same place, and Copy
            writes the same string, whichever view is on screen. */}
        <ResponseBody
          text={formatBody(response)}
          testId="api-response-body"
          copyLabel="the response"
          // The requestId (not the tab id) is the identity that survives a
          // cross-pane tab move — the tab is re-created, the request is not.
          findKey={`api:${requestId}`}
          formatted={parsed.isJson ? { value: parsed.value } : null}
        />
      </div>
    </section>
  );
}
