/** Detail-pane cards for rows with no request: {@link TunnelCard} (an encrypted tunnel: what was
 * and was not seen, and the ways to see requests) and {@link BypassCard} (an agent command that
 * skipped the proxy, with the switch that captures agent curls anyway). */

import { useState } from "react";

import { useAppStore } from "../../app/store";
import { appOfClient } from "./captureSteps";
import { formatDuration, formatSize, formatTime, tunnelBytes } from "./networkFormat";
import { sourceText, type SourceLabel } from "./networkSource";
import { decryptAppFromTunnel, setNetcap, useNetworkStore } from "./networkStore";
import type { FlowSummary, NetcapStatus } from "./networkTypes";
import {
  BYPASS_EXPLAINER,
  BYPASS_NEUTRALIZED_TITLE,
  bypassNeutralizedText,
  bypassReasonText,
  DECRYPT_APP_WARNING,
  isCurlCommand,
  NOT_CURL_NOTE,
  looksLikeRust,
  RUSTLS_NATIVE_ROOTS_LINE,
  STRICT_CAPTURE_LABEL,
  STRICT_CAPTURE_TITLE,
  STRICT_CAPTURE_UNAVAILABLE,
  tunnelGroup,
  tunnelWhy,
} from "./tunnelExplain";

export const TUNNEL_TITLE = "Encrypted tunnel — contents not visible";
export const BYPASS_TITLE = "Not captured — this command skipped the IDE proxy";

/** What IS known about a connection with no request to show — the pane is never empty. */
export function ConnectionFacts({ summary: f, source }: { summary: FlowSummary; source: SourceLabel }): React.JSX.Element {
  const closedAt = f.durationMs === null ? null : f.startedMs + f.durationMs;
  const facts: [string, string][] = [
    ["Host", f.host],
    ["Port", String(f.port)],
    ["Opened", formatTime(f.startedMs)],
    ["Closed", closedAt === null ? "still open" : formatTime(closedAt)],
    ["Duration", f.durationMs === null ? "still open" : formatDuration(f.durationMs)],
    ["Sent", `${formatSize(f.reqBytes)} (${f.reqBytes} B)`],
    ["Received", `${formatSize(f.resBytes)} (${f.resBytes} B)`],
    [
      "Process",
      f.client === null
        ? "unknown — the proxy could not tell which process opened it"
        : `${f.client.name} (pid ${f.client.pid})${f.client.path === null ? "" : ` · ${f.client.path}`}`,
    ],
    ["Source", sourceText(source)],
  ];
  return (
    <dl className="net-facts" data-testid="net-facts" aria-label="What is known about this connection">
      {facts.map(([k, v]) => (
        <div key={k} className="net-facts__row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A read-only snippet with its own Copy button (and a "Copied" that belongs to this snippet). */
function Copyable({ text, label, testId }: { text: string; label: string; testId: string }): React.JSX.Element {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="net-card__code">
      <pre data-testid={testId}>{text}</pre>
      <button
        type="button"
        className="net-btn"
        onClick={() => {
          if (!navigator.clipboard) return;
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {label}
      </button>
      {copied === null ? null : (
        <span className={copied ? "net-actions__ok" : "net-actions__err"} role="status">
          {copied ? "Copied" : "Copy failed"}
        </span>
      )}
    </div>
  );
}

export function TunnelCard({
  summary: f,
  source,
  lead,
}: {
  summary: FlowSummary;
  source: SourceLabel;
  /** The pane's one-line account (bytes + what the proxy does), kept as the card's first line. */
  lead: string;
}): React.JSX.Element {
  const status = useNetworkStore((s) => s.status);
  const flows = useNetworkStore((s) => s.flows);
  const group = tunnelGroup(flows, f);
  const who = f.client === null ? "This client" : `${f.client.name} (pid ${f.client.pid})`;
  const rust = looksLikeRust(f.client);
  return (
    <div className="net-card" data-testid="net-tunnel-card">
      <h4 className="net-card__title">{TUNNEL_TITLE}</h4>
      <p className="net-detail__dim" data-testid="net-tunnel-note">
        {lead}
      </p>
      <h5 className="net-card__h">Why</h5>
      <p data-testid="net-tunnel-why">{tunnelWhy(f, status)}</p>
      <h5 className="net-card__h">What you can see</h5>
      <ConnectionFacts summary={f} source={source} />
      {group.count > 1 ? (
        <p data-testid="net-tunnel-group">
          {group.count} connections from {who} to {f.host}:{f.port} — {tunnelBytes(group)} in total
          {group.open > 0 ? `, ${group.open} still open` : ", all closed"}.
        </p>
      ) : null}
      <h5 className="net-card__h">How to see the requests</h5>
      <ol className="net-card__ways" data-testid="net-tunnel-how">
        <li data-testid="net-tunnel-decrypt">
          <DecryptAppWay summary={f} status={status} />
        </li>
        <li data-testid="net-tunnel-rust">
          {rust ? "It is a Rust app: " : "If it is a Rust app using reqwest: "}build it with native roots, so it reads the
          IDE's certificate from SSL_CERT_FILE (every IDE terminal sets it) — in Cargo.toml, use{" "}
          <code>rustls-tls-native-roots</code> in place of <code>rustls-tls</code>, then turn on decrypting it (above):
          <Copyable text={RUSTLS_NATIVE_ROOTS_LINE} label="Copy line" testId="net-tunnel-cargo" />
        </li>
        <li data-testid="net-tunnel-logs">
          Requests other programs make <em>to</em> it (its own API) don&apos;t pass through this tunnel — its own
          console shows them in Logs.{" "}
          <button type="button" className="net-btn" onClick={() => useAppStore.getState().layoutActions.openAgentLogsTab()}>
            Open Logs
          </button>
        </li>
      </ol>
    </div>
  );
}

/** Way (a): the per-app decrypt opt-in (`decryptApps`), with its warning. */
function DecryptAppWay({ summary: f, status }: { summary: FlowSummary; status: NetcapStatus | null }): React.JSX.Element {
  const setting = useNetworkStore((s) => s.setting);
  if (f.client === null) {
    return <>Decrypt this app: not possible here — the proxy couldn&apos;t identify the process to opt it in.</>;
  }
  const app = appOfClient(f.client);
  const on = status?.decryptApps.includes(app) ?? false;
  return (
    <>
      <span className="net-switch-wrap" title={status === null ? "Waiting for the capture proxy's status…" : DECRYPT_APP_WARNING}>
        <button
          type="button"
          role="switch"
          className="net-switch"
          aria-checked={on}
          disabled={status === null || setting}
          data-testid="net-tunnel-decrypt-app"
          onClick={() => void decryptAppFromTunnel(app, !on)}
        >
          Decrypt {app}&apos;s HTTPS
        </button>
      </span>
      <p className="net-card__warn">
        {on && status?.decrypt === true
          ? `On — ${app}'s new connections are decrypted. If its calls start failing, turn this off.`
          : `${DECRYPT_APP_WARNING}${status?.decrypt === true ? "" : " Also turns on Decrypt HTTPS."}`}
      </p>
    </>
  );
}

/** "Capture agent curls even with --noproxy" — here and in the Network header. */
export function StrictCaptureSwitch(): React.JSX.Element {
  const status = useNetworkStore((s) => s.status);
  const setting = useNetworkStore((s) => s.setting);
  const value = status?.strictAgentCapture;
  const known = typeof value === "boolean";
  const title = status === null ? "Waiting for the capture proxy's status…" : known ? STRICT_CAPTURE_TITLE : STRICT_CAPTURE_UNAVAILABLE;
  return (
    <span className="net-switch-wrap" title={title} data-testid="net-strict-wrap">
      <button
        type="button"
        role="switch"
        className="net-switch"
        aria-checked={value === true}
        disabled={!known || setting}
        onClick={() => void setNetcap({ strictAgentCapture: !value })}
      >
        {STRICT_CAPTURE_LABEL}
      </button>
    </span>
  );
}

export function BypassCard({ summary: f, source }: { summary: FlowSummary; source: SourceLabel }): React.JSX.Element {
  const b = f.bypass;
  const agentId = b?.agentId ?? null;
  const agent = useAppStore((s) => (agentId === null ? undefined : s.agents[agentId as keyof typeof s.agents]));
  const reasons = b?.reasons ?? [];
  const neutralized = b?.neutralized === true;
  const command = b?.command ?? null;
  const facts: [string, string][] = [
    ["When", formatTime(f.startedMs)],
    ["Method", b?.method ?? "not parsed"],
    ["URL", b?.url ?? "not parsed"],
    ["Bypassed with", reasons.length > 0 ? reasons.join(", ") : "not recorded"],
    ...(agentId === null ? [] : ([["Agent", agent ? (agent.customTitle ?? agent.title) : agentId]] as [string, string][])),
    ["Source", sourceText(source)],
  ];
  return (
    <div className="net-card" data-testid="net-bypass-card">
      <h4 className="net-card__title">{neutralized ? BYPASS_NEUTRALIZED_TITLE : BYPASS_TITLE}</h4>
      <Copyable text={command ?? "(the command was not recorded)"} label="Copy command" testId="net-bypass-command" />
      <p data-testid="net-bypass-why">{neutralized ? bypassNeutralizedText(reasons) : BYPASS_EXPLAINER}</p>
      {reasons.length > 0 ? (
        <ul className="net-card__reasons" data-testid="net-bypass-reasons" aria-label="Why the proxy did not see it">
          {reasons.map((r) => (
            <li key={r}>{bypassReasonText(r)}</li>
          ))}
        </ul>
      ) : null}
      {!neutralized && command !== null && !isCurlCommand(command) ? (
        <p className="net-card__warn" data-testid="net-bypass-notcurl">
          {NOT_CURL_NOTE}
        </p>
      ) : null}
      <StrictCaptureSwitch />
      <dl className="net-facts" aria-label="What is known about this command">
        {facts.map(([k, v]) => (
          <div key={k} className="net-facts__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
