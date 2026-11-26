/** One flow's request and response, fetched on demand via `netcap_flow` (bodies never ride the
 * event stream), plus Copy as cURL and Open in API client. */

import { useEffect, useState } from "react";

import { JsonView } from "../api/JsonView";
import { appOfClient, caStepHint } from "./captureSteps";
import {
  exportable,
  flowCurl,
  flowUrl,
  openInApiClient,
  rawCopyable,
  rawRequest,
  rawResponse,
  requestLine,
  responseBodyText,
} from "./networkExport";
import { capturedAnywayOf, capturedAnywayText } from "./networkFilter";
import { clientName, formatDuration, isTlsRejected, methodTone, protoLabel } from "./networkFormat";
import { shownValue } from "./networkSecrets";
import { isExternal, resolveSource, sourceText } from "./networkSource";
import { closeDetail, loadDetail, setDetailTab, setMaskSecrets, useNetworkStore } from "./networkStore";
import type { FlowBody, FlowDetail, FlowSummary } from "./networkTypes";
import { BypassCard, ConnectionFacts, TunnelCard } from "./TunnelCard";

/** Plain words for a flow the proxy did not decrypt, or null. For an external source the fix is
 * the capture guide's CA step, not a new terminal. */
export function flowExplanation(f: FlowSummary): string | null {
  const who = clientName(f);
  const hint = isExternal(f) ? ` ${caStepHint(appOfClient(f.client))}` : "";
  if (isTlsRejected(f)) {
    const later = f.client ? `from ${f.client.name} ` : "";
    return (
      `${who} doesn't trust the IDE's certificate, so this one connection failed. ` +
      `Later connections ${later}to ${f.host} are passed through without decrypting.${hint}`
    );
  }
  if (hint !== "" && f.note) return `${f.note}.${hint}`;
  return f.note;
}

/** The tunnel card's lead: exact bytes each way and what the proxy does; external apps get the
 * CA step. */
export function tunnelLead(f: FlowSummary): string {
  const bytes = `Encrypted tunnel: ${f.reqBytes} B up, ${f.resBytes} B down.`;
  if (f.note) return `${bytes} The proxy relays the bytes without decrypting them, so it can't break the client.`;
  if (isExternal(f)) return `${bytes} The proxy only relays bytes. ${caStepHint(appOfClient(f.client))}`;
  return `${bytes} The proxy only relays bytes — turn on Decrypt HTTPS to see paths, headers and bodies for terminals opened afterwards.`;
}

/** The head's target: `host:port` for a tunnel, the parsed URL (else the command) for a bypass. */
function headUrl(f: FlowSummary): string {
  if (f.proto === "tunnel") return `${f.host}:${f.port}`;
  if (f.proto === "bypass") return f.bypass?.url ?? f.bypass?.command ?? "(command not recorded)";
  return flowUrl(f);
}

/** ` · 1.3s` / ` · pending`; a tunnel says whether its connection is open, a bypass `not captured`. */
function headTiming(f: FlowSummary): string {
  if (f.proto === "bypass") return " · not captured";
  const dur = f.durationMs === null ? null : formatDuration(f.durationMs);
  if (f.proto === "tunnel") {
    return f.state === "pending" ? " · connection open" : ` · ${dur ?? "—"} · connection ${f.state === "done" ? "closed" : "failed"}`;
  }
  return dur === null ? " · pending" : ` · ${dur}`;
}

export function FlowDetailPane({
  sources,
  hidden = false,
}: {
  sources: ReadonlyMap<string, string>;
  /** The selected flow is filtered out of the table — say so. */
  hidden?: boolean;
}): React.JSX.Element {
  const selectedId = useNetworkStore((s) => s.selectedId);
  const summary = useNetworkStore((s) =>
    s.selectedId === null ? undefined : s.flows.find((f) => f.id === s.selectedId),
  );
  const detailState = useNetworkStore((s) => s.detail);
  const tab = useNetworkStore((s) => s.detailTab);
  const closedTitles = useNetworkStore((s) => s.terminalTitles);
  const flows = useNetworkStore((s) => s.flows);

  // A pending flow that completes has headers and a body it did not have — refetch.
  const flowState = summary?.state;
  useEffect(() => {
    if (selectedId !== null && flowState !== undefined) void loadDetail(selectedId);
  }, [selectedId, flowState]);

  if (!summary) {
    return (
      <section className="net-detail" aria-label="Flow detail">
        <p className="net-detail__dim">Select a flow.</p>
      </section>
    );
  }

  const detail = detailState?.id === summary.id ? detailState.detail : null;
  const loading = detailState?.id === summary.id && detailState.loading;
  const error = detailState?.id === summary.id ? detailState.error : null;
  const source = resolveSource(summary, sources, closedTitles);
  const explanation = flowExplanation(summary);
  // The table hides a bypass that was captured anyway (one row per call, networkFilter.tableFlows);
  // its captured request says instead what the agent had asked for, and why it is here anyway.
  const anyway = capturedAnywayOf(summary, flows);

  return (
    <section className="net-detail" aria-label="Flow detail" data-testid="net-detail">
      <div className="net-detail__head">
        {/* A visible way to close this pane: Esc alone was not discoverable. */}
        <button
          type="button"
          className="net-detail__close"
          aria-label="Close detail"
          title="Close the detail (Esc)"
          onClick={() => closeDetail()}
        >
          ✕ Close
        </button>
        <span className={`net-method--${methodTone(summary.method)}`}>
          {summary.method === "" ? "—" : summary.method}
        </span>{" "}
        <span className="net-detail__url">{headUrl(summary)}</span>
        <span className="net-detail__meta">
          {protoLabel(summary.proto)}
          {summary.httpVersion ? ` · ${summary.httpVersion}` : ""}
          {headTiming(summary)}
          {" · "}
          {sourceText(source)}
          {summary.client ? (
            <span title={`${summary.client.path ?? summary.client.name} · pid ${summary.client.pid}`}>
              {` · ${summary.client.name} (pid ${summary.client.pid})`}
            </span>
          ) : null}
        </span>
      </div>
      {hidden ? (
        <p className="net-detail__warn" data-testid="net-detail-hidden">
          This flow is hidden by the current filters — it is not in the table above.
        </p>
      ) : null}
      <Actions summary={summary} />
      {summary.error ? (
        <div className="net-detail__error" role="alert">
          {summary.error}
        </div>
      ) : null}
      {explanation ? (
        <p className="net-detail__explain" data-testid="net-explain">
          {explanation}
        </p>
      ) : null}
      {anyway ? (
        <p className="net-detail__explain" data-testid="net-shimmed" data-how={anyway.how}>
          {capturedAnywayText(summary, anyway)}
        </p>
      ) : null}
      {summary.proto === "bypass" ? (
        <BypassCard summary={summary} source={source} />
      ) : summary.proto === "tunnel" ? (
        <TunnelCard summary={summary} source={source} lead={tunnelLead(summary)} />
      ) : summary.method === "CONNECT" ? (
        <>
          <p className="net-detail__dim" data-testid="net-no-request">
            No request was sent on this connection — it ended during the TLS handshake, so there are no headers or
            body to show.
          </p>
          <ConnectionFacts summary={summary} source={source} />
        </>
      ) : (
        <>
          <div className="net-tabs-row">
          <div className="net-tabs" role="tablist" aria-label="Request or response">
            {(["request", "response"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                className="net-tab"
                aria-selected={tab === t}
                onClick={() => setDetailTab(t)}
              >
                {t === "request" ? "Request" : "Response"}
              </button>
            ))}
          </div>
          <MaskToggle />
          </div>
          <div className="net-detail__body" role="tabpanel" aria-label={tab === "request" ? "Request" : "Response"}>
            {error ? (
              <p className="net-detail__error" role="alert">
                Could not load this flow: {error}
              </p>
            ) : detail === null ? (
              <p className="net-detail__dim">{loading ? "Loading…" : "No detail."}</p>
            ) : tab === "request" ? (
              <>
                <p className="net-detail__status net-detail__reqline" data-testid="net-request-line">
                  {requestLine(summary)}
                </p>
                <Headers title="Headers" rows={detail.requestHeaders} />
                <Body body={detail.requestBody} />
              </>
            ) : (
              <>
                <p className="net-detail__status" data-testid="net-status-line">
                  {summary.status === null ? "No response" : `Status ${summary.status}`}
                  {summary.grpcStatus !== null ? ` · grpc-status ${summary.grpcStatus}` : ""}
                  {summary.wsMessages
                    ? ` · messages ↑${summary.wsMessages.up} ↓${summary.wsMessages.down}`
                    : ""}
                </p>
                <Headers title="Headers" rows={detail.responseHeaders} />
                <Body body={detail.responseBody} />
                {detail.responseTrailers.length > 0 ? <Headers title="Trailers" rows={detail.responseTrailers} /> : null}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Show `••••` for credential headers on screen. Copy as cURL always uses the real values. */
function MaskToggle(): React.JSX.Element {
  const masked = useNetworkStore((s) => s.maskSecrets);
  return (
    <button
      type="button"
      className="net-btn net-mask"
      aria-pressed={masked}
      title="Show •••• instead of credential header values (Authorization, cookies, API keys) on screen. Copy as cURL still uses the real values."
      onClick={() => setMaskSecrets(!masked)}
    >
      {masked ? "Show secrets" : "Mask secrets"}
    </button>
  );
}

type CopyWhat = "curl" | "request" | "response" | "body";
const COPIED: Record<CopyWhat, string> = {
  curl: "Copied cURL",
  request: "Copied request",
  response: "Copied response",
  body: "Copied body",
};

/** The response half is copyable once a response (a status, or any header) was captured. */
function responseCopy(summary: FlowSummary, detail: FlowDetail | null): { ok: true } | { ok: false; reason: string } {
  const raw = rawCopyable(summary, detail);
  if (!raw.ok) return raw;
  const d = detail as FlowDetail;
  if (summary.status === null && d.responseHeaders.length === 0) {
    return { ok: false, reason: summary.state === "pending" ? "Waiting for the response…" : "No response was captured." };
  }
  return raw;
}

function Actions({ summary }: { summary: FlowSummary }): React.JSX.Element {
  const detailState = useNetworkStore((s) => s.detail);
  const detail = detailState?.id === summary.id ? detailState.detail : null;
  const exp = exportable(summary, detail);
  const reqCopy = rawCopyable(summary, detail);
  const resCopy = responseCopy(summary, detail);
  const body = detail === null ? null : responseBodyText(detail);
  const [copied, setCopied] = useState<{ id: number; ok: boolean; what: CopyWhat } | null>(null);

  const curlTitle = exp.ok ? "Copy this request as a cURL command." : exp.reason;
  const apiTitle = exp.ok ? "Open this request in a new API client tab (not sent)." : exp.reason;
  const reqTitle = reqCopy.ok
    ? "Copy the request as raw HTTP: request line, headers and body, exactly as captured."
    : reqCopy.reason;
  const resTitle = resCopy.ok ? "Copy the response as raw HTTP: status line, headers and body." : resCopy.reason;
  const bodyTitle = !resCopy.ok
    ? resCopy.reason
    : body === null
      ? "The response has no text body to copy."
      : "Copy only the response body.";

  const copy = (what: CopyWhat, text: () => string): void => {
    if (!navigator.clipboard) return;
    const id = summary.id;
    void navigator.clipboard
      .writeText(text())
      .then(() => setCopied({ id, ok: true, what }))
      .catch(() => setCopied({ id, ok: false, what }));
  };
  const d = detail as FlowDetail;

  return (
    <div className="net-actions">
      {/* The title sits on a wrapper: a disabled button never shows its own. */}
      <span title={curlTitle} data-testid="net-curl-wrap">
        <button
          type="button"
          className="net-btn"
          disabled={!exp.ok}
          onClick={exp.ok ? () => copy("curl", () => flowCurl(exp.request)) : undefined}
        >
          Copy as cURL
        </button>
      </span>
      <span title={reqTitle} data-testid="net-copyreq-wrap">
        <button
          type="button"
          className="net-btn"
          disabled={!reqCopy.ok}
          onClick={() => copy("request", () => rawRequest(summary, d))}
        >
          Copy request
        </button>
      </span>
      <span title={resTitle} data-testid="net-copyres-wrap">
        <button
          type="button"
          className="net-btn"
          disabled={!resCopy.ok}
          onClick={() => copy("response", () => rawResponse(summary, d))}
        >
          Copy response
        </button>
      </span>
      <span title={bodyTitle} data-testid="net-copybody-wrap">
        <button
          type="button"
          className="net-btn"
          disabled={!resCopy.ok || body === null}
          onClick={() => copy("body", () => body as string)}
        >
          Copy body
        </button>
      </span>
      <span title={apiTitle} data-testid="net-api-wrap">
        <button
          type="button"
          className="net-btn"
          disabled={!exp.ok}
          onClick={exp.ok ? () => openInApiClient(exp.request) : undefined}
        >
          Open in API client
        </button>
      </span>
      {copied?.id === summary.id ? (
        <span className={copied.ok ? "net-actions__ok" : "net-actions__err"} role="status">
          {copied.ok ? COPIED[copied.what] : "Copy failed"}
        </span>
      ) : null}
    </div>
  );
}

function Headers({ title, rows }: { title: string; rows: readonly [string, string][] }): React.JSX.Element {
  const masked = useNetworkStore((s) => s.maskSecrets);
  return (
    <div className="net-headers">
      <h4 className="net-headers__title">{title}</h4>
      {rows.length === 0 ? (
        <p className="net-detail__dim">None</p>
      ) : (
        <table className="net-headers__table" aria-label={title}>
          <tbody>
            {rows.map(([name, value], i) => (
              <tr key={`${name}-${i}`}>
                <th scope="row">{name}</th>
                <td>{shownValue(name, value, masked)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** JSON if it parses as an object/array, text otherwise, and never a binary dump. */
export function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

function Body({ body }: { body: FlowBody | null }): React.JSX.Element {
  // Nothing captured, or an empty one: either way there is nothing to show.
  if (body === null || (body.text ?? body.base64 ?? "") === "") {
    return <p className="net-detail__dim">No body</p>;
  }
  const notice = body.truncated ? (
    <p className="net-detail__warn" data-testid="net-truncated">
      Truncated at the 1 MiB capture limit ({body.size} bytes on the wire).
    </p>
  ) : null;
  if (body.text === null) {
    return (
      <div className="net-bodyview">
        {notice}
        <p className="net-detail__dim">binary, {body.size} bytes</p>
      </div>
    );
  }
  const json = parseJsonBody(body.text);
  return (
    <div className="net-bodyview">
      {notice}
      {json.ok ? <JsonView value={json.value} /> : <pre className="net-bodyview__text">{body.text}</pre>}
    </div>
  );
}
