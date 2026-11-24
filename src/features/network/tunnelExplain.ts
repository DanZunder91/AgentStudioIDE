/**
 * The words of the tunnel and bypass cards (FlowDetailPane) — pure, so each sentence is pinned
 * by a test one case at a time.
 *
 * The bug: `CONNECT geo.api.example.net:443 TUNNEL · 30.0s` with an empty pane read
 * as a call that never finished and showed nothing about what it was doing.
 * The row was right — a Rust app on reqwest + rustls with bundled webpki roots cannot trust the IDE's
 * CA, so the proxy tunnels it and can only see host, port, timing and bytes — but
 * the pane must say so, say why, show what IS known, and give the ways to see more.
 */

import type { FlowClient, FlowSummary, NetcapStatus } from "./networkTypes";

/**
 * Whether a client looks like a Rust binary: it runs from a Cargo `target/<profile>/` directory
 * or `~/.cargo/bin`. DECIDED: the executable path is all the proxy knows about a client, and
 * these two locations are where `cargo run` / `cargo install` put binaries; anything else is
 * not guessed at (the card then speaks about "apps that ship their own trust roots" in general).
 */
export function looksLikeRust(client: Pick<FlowClient, "path"> | null): boolean {
  const p = client?.path;
  if (p === null || p === undefined) return false;
  return /\/target\/(debug|release|[^/]+\/(debug|release))\/[^/]+$/.test(p) || p.includes("/.cargo/bin/");
}

export const RUSTLS_WHY =
  "Rust apps using rustls + webpki-roots ignore the IDE's certificate, so decrypting would make every call fail with UnknownIssuer.";

export const OWN_ROOTS_WHY =
  "Apps that ship their own trust roots (Rust with webpki-roots, Go, Java) ignore the IDE's certificate, so decrypting them would make their calls fail.";

/** The note Rust puts on a decrypt-mode tunnel (`netcap::client`), read back into its reason. */
type NoteKind = "not-on-list" | "unknown-client" | "refused-earlier" | "other" | "none";

export function noteKind(note: string | null): NoteKind {
  if (note === null || note === "") return "none";
  if (note.endsWith("doesn't read the IDE's CA")) return "not-on-list";
  if (note.startsWith("not decrypted: couldn't identify")) return "unknown-client";
  if (note.includes("refused the IDE's certificate")) return "refused-earlier";
  return "other";
}

/**
 * Why this tunnel's contents are not visible — the card's "Why" paragraph. `status` is the
 * proxy's status (null while it loads: a tunnel with no note is then explained without
 * claiming Decrypt is off).
 */
export function tunnelWhy(f: Pick<FlowSummary, "client" | "note">, status: Pick<NetcapStatus, "decrypt"> | null): string {
  const app = f.client?.name ?? "The client";
  const roots = looksLikeRust(f.client) ? RUSTLS_WHY : OWN_ROOTS_WHY;
  switch (noteKind(f.note)) {
    case "not-on-list":
      return `${app} isn't on the decrypt list: it doesn't read the IDE's certificate, so the proxy passes its HTTPS through untouched instead of breaking it. ${roots}`;
    case "unknown-client":
      return "The proxy couldn't tell which process opened this connection, so it didn't risk decrypting it — a client that doesn't trust the IDE's certificate would fail.";
    case "refused-earlier":
      return `${app} refused the IDE's certificate for this host earlier, so its later connections here are passed through untouched. ${roots}`;
    case "other":
      return `${(f.note as string).replace(/^not decrypted: /, "Not decrypted: ")}.`;
    case "none":
      if (status !== null && !status.decrypt) {
        return "Decrypt HTTPS is off, so every HTTPS connection is passed through as an encrypted tunnel.";
      }
      return "The proxy relayed this connection as-is, without decrypting it.";
  }
}

/** Every tunnel from the same process to the same host:port — the card's "N connections". */
export interface TunnelGroup {
  count: number;
  open: number;
  reqBytes: number;
  resBytes: number;
}

/**
 * Group repeated tunnels: same host and port, and the same client pid (or, when the client is
 * unknown, the same terminal). A keep-alive HTTP client opens several over a minute; one row
 * each is correct, but the card says they are one app talking to one host.
 */
export function tunnelGroup(
  flows: readonly FlowSummary[],
  f: Pick<FlowSummary, "host" | "port" | "client" | "terminalId">,
): TunnelGroup {
  const out: TunnelGroup = { count: 0, open: 0, reqBytes: 0, resBytes: 0 };
  for (const g of flows) {
    if (g.proto !== "tunnel" || g.host !== f.host || g.port !== f.port) continue;
    const same = f.client !== null ? g.client?.pid === f.client.pid : g.client === null && g.terminalId === f.terminalId;
    if (!same) continue;
    out.count += 1;
    if (g.state === "pending") out.open += 1;
    out.reqBytes += g.reqBytes;
    out.resBytes += g.resBytes;
  }
  return out;
}

/**
 * The one-line Cargo change that makes a reqwest app read `SSL_CERT_FILE` (which every IDE
 * terminal sets to the IDE's CA bundle): native roots instead of the bundled webpki set.
 * reqwest 0.12's feature name (the `rustls-tls` default it replaces is that line's too).
 */
export const RUSTLS_NATIVE_ROOTS_LINE =
  'reqwest = { version = "0.12", default-features = false, features = ["rustls-tls-native-roots"] }';

export const DECRYPT_APP_WARNING =
  "Only if it trusts the IDE's certificate: an app that pins its own roots (rustls + webpki-roots) will then fail every HTTPS call until you turn this off. Applies to its new connections.";

export const BYPASS_EXPLAINER =
  "This command skipped the IDE proxy, so its request is not in this table. With 'Capture agent curls even with --noproxy' on, an agent's curl is captured anyway.";

/**
 * What each bypass reason Rust reports means, in words (`logstream::bypass::R_*`). The card lists
 * one sentence per reason: "Bypassed with: PowerShell 5.1 web cmdlet" alone told nobody that
 * nothing in the command had asked to skip the proxy — Windows PowerShell 5.1's web stack simply
 * never reads the proxy variables.
 */
export const BYPASS_REASON_TEXT: Readonly<Record<string, string>> = {
  "--noproxy": "curl was told to use no proxy (--noproxy).",
  "-x ''": "curl was given an empty proxy (-x '').",
  "NO_PROXY=*": "NO_PROXY=* tells programs to skip the proxy for every host.",
  "NO_PROXY=": "NO_PROXY was set for this command, so the hosts it lists skip the proxy.",
  "*_PROXY=''": "The proxy variables were emptied for this command (HTTP_PROXY='' and friends).",
  "unset *_proxy": "The proxy variables were unset before the command ran.",
  "env -u *_proxy": "env -u removed the proxy variables for this command.",
  "env -i": "env -i started the command with an empty environment, so it had no proxy variables.",
  "--no-proxy": "wget was told to use no proxy (--no-proxy).",
  "PowerShell 5.1 web cmdlet":
    "Windows PowerShell 5.1's web cmdlets (Invoke-WebRequest, Invoke-RestMethod, iwr, irm) and .NET's WebClient ignore the proxy variables — use curl.exe or PowerShell 7 (pwsh) to see the request here.",
  "-NoProxy": "The PowerShell web cmdlet was told to use no proxy (-NoProxy).",
};

/** One reason in words; a reason this build does not know yet is still shown, as Rust spelled it. */
export function bypassReasonText(reason: string): string {
  return BYPASS_REASON_TEXT[reason] ?? `It skipped the IDE proxy (${reason}).`;
}

export const BYPASS_NEUTRALIZED_TITLE = "Captured anyway — this command tried to skip the IDE proxy";

/**
 * A neutralised bypass (strict agent capture on, every reason a curl's own): the shim
 * ran the curl through the proxy, so its request is a normal row of this table.
 */
export function bypassNeutralizedText(reasons: readonly string[]): string {
  const how = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
  return `This command tried to skip the IDE proxy${how}. With 'Capture agent curls even with --noproxy' on, curl was run through the proxy anyway — its request is its own row in this table.`;
}

/** The toggle only reaches curl: a bypass by anything else stays uncaptured, and the card says so. */
export function isCurlCommand(command: string): boolean {
  return /(^|[\s;&|(/])curl(\s|$)/.test(command);
}

export const NOT_CURL_NOTE = "This command is not a curl, so it is not captured even with that switch on — run it without the bypass to see its requests.";

export const STRICT_CAPTURE_LABEL = "Capture agent curls even with --noproxy";

export const STRICT_CAPTURE_TITLE =
  "Agents' curl commands go through the IDE proxy even when they pass --noproxy or set NO_PROXY, so their requests show here. Other programs are not affected.";

export const STRICT_CAPTURE_UNAVAILABLE = "This build of the IDE does not report this setting yet.";
