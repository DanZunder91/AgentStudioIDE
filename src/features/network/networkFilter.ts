/**
 * The filter box's language: free words (substring over host / path / method / status,
 * all of them ANDed) plus `key:value` tokens — `status:5xx`, `status:404`, `proto:grpc`,
 * `method:post`, `host:foo`. And the proto chips, which are families.
 */

import type { FlowProto, FlowSummary } from "./networkTypes";

export type StatusMatch = { kind: "class"; digit: number } | { kind: "exact"; code: number };

export interface FlowFilter {
  text: string[];
  status: StatusMatch[];
  /** Prefix match on the proto name: `proto:http` is HTTP + HTTPS, `proto:ws` is WS + WSS. */
  proto: string[];
  method: string[];
  host: string[];
  /** Tokens that looked like a filter but could not be read — ignored, and shown as such. */
  invalid: string[];
}

const KEYED = new Set(["status", "proto", "method", "host"]);

export function parseFilter(query: string): FlowFilter {
  const out: FlowFilter = { text: [], status: [], proto: [], method: [], host: [], invalid: [] };
  for (const raw of query.trim().split(/\s+/)) {
    if (raw === "") continue;
    const colon = raw.indexOf(":");
    const key = colon > 0 ? raw.slice(0, colon).toLowerCase() : "";
    // `api.example.com:443` is a word, not a key — only the four known keys are keys.
    if (!KEYED.has(key)) {
      out.text.push(raw.toLowerCase());
      continue;
    }
    const value = raw.slice(colon + 1).toLowerCase();
    if (value === "") {
      out.invalid.push(raw);
      continue;
    }
    if (key === "status") {
      const cls = /^([1-5])xx$/.exec(value);
      if (cls) out.status.push({ kind: "class", digit: Number(cls[1]) });
      else if (/^[1-5]\d\d$/.test(value)) out.status.push({ kind: "exact", code: Number(value) });
      else out.invalid.push(raw);
    } else if (key === "proto") out.proto.push(value);
    else if (key === "method") out.method.push(value.toUpperCase());
    else out.host.push(value);
  }
  return out;
}

function statusMatches(status: number | null, m: StatusMatch): boolean {
  if (status === null) return false;
  return m.kind === "exact" ? status === m.code : Math.floor(status / 100) === m.digit;
}

/**
 * Does `f` pass? Tokens of different kinds AND together; several tokens of the SAME
 * keyed kind OR together (`status:4xx status:5xx` = any failure), because a flow has
 * exactly one status and ANDing two would always be empty.
 */
export function matchesFilter(f: FlowSummary, filter: FlowFilter): boolean {
  const host = f.host.toLowerCase();
  if (filter.status.length && !filter.status.some((m) => statusMatches(f.status, m))) return false;
  if (filter.proto.length && !filter.proto.some((p) => f.proto.startsWith(p))) return false;
  if (filter.method.length && !filter.method.includes(f.method.toUpperCase())) return false;
  if (filter.host.length && !filter.host.some((h) => host.includes(h))) return false;
  if (filter.text.length) {
    const hay = [host, f.path.toLowerCase(), f.method.toLowerCase(), f.status === null ? "" : String(f.status)];
    if (!filter.text.every((t) => hay.some((h) => h.includes(t)))) return false;
  }
  return true;
}

export type ProtoChip = "http" | "ws" | "grpc" | "tunnel";

export const PROTO_CHIPS: readonly { chip: ProtoChip; label: string }[] = [
  { chip: "http", label: "HTTP" },
  { chip: "ws", label: "WS" },
  { chip: "grpc", label: "gRPC" },
  { chip: "tunnel", label: "Tunnel" },
];

const CHIP_OF: Record<FlowProto, ProtoChip> = {
  http: "http",
  https: "http",
  ws: "ws",
  wss: "ws",
  grpc: "grpc",
  tunnel: "tunnel",
  // DECIDED: a bypassed command is an HTTP(S) call the proxy did not see — it belongs to the
  // HTTP family, so "HTTP only" still shows the calls an agent made around the proxy.
  bypass: "http",
};

/** No chip on = every proto; any chip on = only those families. */
export function matchesChips(f: FlowSummary, chips: readonly ProtoChip[]): boolean {
  return chips.length === 0 || chips.includes(CHIP_OF[f.proto]);
}

const noChips = (): Record<ProtoChip, number> => ({ http: 0, ws: 0, grpc: 0, tunnel: 0 });

/** How many flows each chip family holds — shown on the chip, so an empty family is visible. */
export function chipCounts(flows: readonly Pick<FlowSummary, "proto">[]): Record<ProtoChip, number> {
  const out = noChips();
  for (const f of flows) out[CHIP_OF[f.proto]] += 1;
  return out;
}

/**
 * Why the table is empty ("No flows match the filter." with 158 flows read as a
 * broken view). Each ACTIVE control is reported with how many flows it alone excludes;
 * an inactive control is `null`. The chips also say which families they excluded — the
 * case seen in practice was the HTTP chip over a table of Tunnels.
 */
export interface HiddenBy {
  chips: { count: number; families: Record<ProtoChip, number> } | null;
  text: number | null;
  source: number | null;
  process: number | null;
  /** The Host picker. */
  host: number | null;
  /** The Apps sidebar's picks (`networkApps`). */
  app: number | null;
  /** "Hide AI providers" ({@link isAiProviderCall}). */
  ai: number | null;
}

/* ── Agent CLIs' own calls to AI providers ───────────────────────────────────────────── */

/**
 * AI model providers, by the domains their APIs and apps answer on — a domain or any subdomain.
 * Adding a provider is one row here.
 */
export const AI_PROVIDERS: readonly { name: string; domains: readonly string[] }[] = [
  { name: "Anthropic (Claude)", domains: ["anthropic.com", "claude.ai", "claude.com"] },
  { name: "OpenAI (GPT)", domains: ["openai.com", "chatgpt.com", "openai.azure.com"] },
  { name: "Google (Gemini)", domains: ["generativelanguage.googleapis.com", "gemini.google.com"] },
  { name: "Mistral", domains: ["mistral.ai"] },
  { name: "Cohere", domains: ["cohere.com", "cohere.ai"] },
  { name: "xAI (Grok)", domains: ["x.ai"] },
  { name: "DeepSeek", domains: ["deepseek.com"] },
  { name: "Groq", domains: ["groq.com"] },
  { name: "Perplexity", domains: ["perplexity.ai"] },
  { name: "OpenRouter", domains: ["openrouter.ai"] },
  { name: "GitHub Copilot", domains: ["githubcopilot.com"] },
];

const AI_DOMAINS: readonly string[] = AI_PROVIDERS.flatMap((p) => p.domains);

/**
 * Agent CLIs, by the client name Rust gives them (`netcap::client::client_name` strips `.exe` and
 * names Claude Code's versioned native install `claude`). A CLI that runs as `node` (an npm
 * install, Gemini CLI) is not recognised, by design: a node app under test calling a provider must
 * stay visible, and the two cannot be told apart by name.
 */
export const AGENT_CLIS: readonly string[] = ["claude", "codex"];

/** The providers' GitHub orgs: an agent CLI checks its changelog at `raw.githubusercontent.com/<org>/…`. */
const AI_GITHUB_ORGS: readonly string[] = ["anthropics", "openai", "google-gemini"];

/** `host` is `domain` or a subdomain of it — never `notopenai.com` or `openai.com.example.dev`. */
const underDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** An AI provider's domain, or a subdomain of one (`api.openai.com`, `statsig.anthropic.com`). */
export function isAiProviderHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return AI_DOMAINS.some((d) => underDomain(h, d));
}

/**
 * A request an agent CLI itself made to an AI provider: the agent's conversation with the model,
 * which repeats on every turn of every agent and buries everything else, plus
 * the CLI's own housekeeping — its telemetry (`*.datadoghq.com`) and its changelog check on GitHub.
 * The client must BE an agent CLI ({@link AGENT_CLIS}), so a `curl`, a script or an app an agent
 * runs against a provider still shows, and so does anything else the CLI fetches for the agent. A
 * bypass row is an agent's own command, never the CLI's traffic.
 */
export function isAiProviderCall(f: Pick<FlowSummary, "proto" | "host" | "path" | "client">): boolean {
  if (f.proto === "bypass" || f.client === null || !AGENT_CLIS.includes(f.client.name.toLowerCase())) return false;
  const host = f.host.toLowerCase().replace(/\.$/, "");
  if (isAiProviderHost(host) || underDomain(host, "datadoghq.com")) return true;
  return host === "raw.githubusercontent.com" && AI_GITHUB_ORGS.some((o) => f.path.startsWith(`/${o}/`));
}

/** A picker's predicate; null = the picker is on "All" (inactive). */
export type FlowPredicate = ((f: FlowSummary) => boolean) | null;

export type PickerPredicates = { source: FlowPredicate; process: FlowPredicate; host: FlowPredicate; app?: FlowPredicate };

export function hiddenBy(
  flows: readonly FlowSummary[],
  chips: readonly ProtoChip[],
  filter: string,
  pickers: PickerPredicates,
  hideAiProviders = false,
): HiddenBy {
  const parsed = parseFilter(filter);
  const { source: sourceOk, process: processOk, host: hostOk } = pickers;
  const appOk = pickers.app ?? null;
  const out: HiddenBy = {
    chips: chips.length > 0 ? { count: 0, families: noChips() } : null,
    text: filter.trim() !== "" ? 0 : null,
    source: sourceOk ? 0 : null,
    process: processOk ? 0 : null,
    host: hostOk ? 0 : null,
    app: appOk ? 0 : null,
    ai: hideAiProviders ? 0 : null,
  };
  for (const f of flows) {
    if (out.chips && !matchesChips(f, chips)) {
      out.chips.count += 1;
      out.chips.families[CHIP_OF[f.proto]] += 1;
    }
    if (out.text !== null && !matchesFilter(f, parsed)) out.text += 1;
    if (out.source !== null && !(sourceOk as (f: FlowSummary) => boolean)(f)) out.source += 1;
    if (out.process !== null && !(processOk as (f: FlowSummary) => boolean)(f)) out.process += 1;
    if (out.host !== null && !(hostOk as (f: FlowSummary) => boolean)(f)) out.host += 1;
    if (out.app !== null && !(appOk as (f: FlowSummary) => boolean)(f)) out.app += 1;
    if (out.ai !== null && isAiProviderCall(f)) out.ai += 1;
  }
  return out;
}

/* ── one row per call ──────────────────────────────────────────────────────────── */

/**
 * A bypass the IDE's curl shim NEUTRALISED (`bypass.neutralized`): the agent asked for
 * `--noproxy`, the shim dropped it, and the request went through the proxy.
 */
export function isNeutralizedBypass(f: Pick<FlowSummary, "proto" | "bypass">): boolean {
  return f.proto === "bypass" && f.bypass?.neutralized === true;
}

/** How long (ms) after the transcript's call its request may start and still be that call. */
export const PAIR_WINDOW_MS = 60_000;
/**
 * How long (ms) BEFORE the transcript's timestamp a request may start and still pair: the
 * transcript is written before the command runs, but its clock and the proxy's are read in
 * different processes.
 */
export const PAIR_SKEW_MS = 1_000;

/** How a bypass turned out to be captured anyway — what its captured row's note says. */
export interface CapturedAnyway {
  /** The bypass record (its command, its reasons). */
  bypass: FlowSummary;
  /** `shim` = the curl shim undid it; `proxy` = the bypass never took effect (e.g. Python reads `no_proxy` first). */
  how: "shim" | "proxy";
}

export interface BypassPairing {
  /** Bypass ids the table hides: they are captured rows of their own. */
  hidden: ReadonlySet<number>;
  /** Captured flow id → the bypass it IS. */
  byCaptured: ReadonlyMap<number, CapturedAnyway>;
}

const pairKey = (terminal: string, f: Pick<FlowSummary, "host" | "port" | "path">): string =>
  `${terminal}|${f.host}|${f.port}|${f.path}`;

const pairings = new WeakMap<readonly FlowSummary[], BypassPairing>();

/**
 * Which bypass rows were captured anyway, and by which request (the user must never read
 * "not captured" for a request that IS in the table). A bypass is captured anyway when
 * it is neutralised, OR a captured request (not a bypass, not a tunnel) matches it: same terminal
 * — the bypass's row terminal or its agent's id (an agent's terminal id is its agent id) — same
 * host, port and path, starting in [bypass − {@link PAIR_SKEW_MS}, bypass + {@link PAIR_WINDOW_MS}].
 * That second case is real: the IDE's PTY env sets lowercase `no_proxy=""`, and Python's urllib
 * reads the lowercase spelling first, so an agent's `NO_PROXY='*' python3 …` still used the proxy.
 *
 * One-to-one: bypasses in time order each claim the EARLIEST unclaimed matching request, so a
 * curl's row is never also claimed by a later python call to the same URL. A neutralised bypass
 * is hidden even when its request is not (yet) in the ring. Captured flows are bucketed by
 * terminal|host|port|path once; cached per ring array (the table and the detail pane share it).
 */
export function bypassPairing(flows: readonly FlowSummary[]): BypassPairing {
  const cached = pairings.get(flows);
  if (cached) return cached;
  const buckets = new Map<string, FlowSummary[]>();
  const bypasses: FlowSummary[] = [];
  for (const f of flows) {
    if (f.proto === "bypass") bypasses.push(f);
    else if (f.proto !== "tunnel" && f.terminalId !== null) {
      const k = pairKey(f.terminalId, f);
      const list = buckets.get(k);
      if (list) list.push(f);
      else buckets.set(k, [f]);
    }
  }
  const hidden = new Set<number>();
  const byCaptured = new Map<number, CapturedAnyway>();
  bypasses.sort((a, b) => a.startedMs - b.startedMs);
  for (const b of bypasses) {
    const how = isNeutralizedBypass(b) ? "shim" : "proxy";
    if (how === "shim") hidden.add(b.id);
    const terminals = [b.terminalId, b.bypass?.agentId ?? null].filter((t, i, a): t is string => t !== null && a.indexOf(t) === i);
    let best: FlowSummary | null = null;
    for (const t of terminals) {
      for (const c of buckets.get(pairKey(t, b)) ?? []) {
        if (byCaptured.has(c.id)) continue;
        if (c.startedMs < b.startedMs - PAIR_SKEW_MS || c.startedMs > b.startedMs + PAIR_WINDOW_MS) continue;
        if (best === null || c.startedMs < best.startedMs) best = c;
      }
    }
    if (best === null) continue;
    hidden.add(b.id);
    byCaptured.set(best.id, { bypass: b, how });
  }
  const out = { hidden, byCaptured };
  pairings.set(flows, out);
  return out;
}

/**
 * The flows the table (and its counts, pickers and chips) is made of: the ring minus every
 * bypass that was captured anyway ({@link bypassPairing}) — one row per call. The records stay in
 * the ring (export, the captured row's note). A bypass that really was not captured stays a row.
 */
export function tableFlows(flows: FlowSummary[]): FlowSummary[] {
  const { hidden } = bypassPairing(flows);
  // The same array when there is nothing to drop, so memoised consumers do not re-run.
  return hidden.size === 0 ? flows : flows.filter((f) => !hidden.has(f.id));
}

/** The bypass a captured request IS, and how it was captured anyway — null when it is none's. */
export function capturedAnywayOf(f: FlowSummary, flows: readonly FlowSummary[]): CapturedAnyway | null {
  return bypassPairing(flows).byCaptured.get(f.id) ?? null;
}

/** What a bypass had asked for, as the captured row's note says it: `--noproxy`, `NO_PROXY=*`. */
export function shimmedAsk(b: Pick<FlowSummary, "bypass">): string {
  const reasons = b.bypass?.reasons ?? [];
  return reasons.length === 0 ? "a proxy bypass" : reasons.join(" and ");
}

/**
 * The captured row's note. Shim: "…the IDE's curl shim captured it anyway". Otherwise the bypass
 * never took effect: "…but python3 still used the IDE proxy" (the flow's client, else "it").
 */
export function capturedAnywayText(f: Pick<FlowSummary, "client">, c: CapturedAnyway): string {
  const ask = shimmedAsk(c.bypass);
  return c.how === "shim"
    ? `The agent asked for ${ask}; the IDE's curl shim captured it anyway.`
    : `The agent asked for ${ask} but ${f.client?.name ?? "it"} still used the IDE proxy.`;
}
