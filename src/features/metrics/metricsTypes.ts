/** Mirrors `src-tauri/src/metrics.rs` (source of truth; change both): camelCase structs, snake_case
 * enums. This machine's transcripts only. No token `total` on purpose (~98% is cheap cache reads);
 * unimplemented fields are absent, never a fake 0. */

/** Which window the report covers. Defaults to 24 h; both are supported. */
export type MetricsWindowKind = "last_24h" | "last_7d";

/** `"all"` (default) is every project on this machine; `"project"` with a null cwd falls back to
 * `"all"`. `"all"` privacy, enforced in Rust: no prompt text, basenames only; tool results never
 * quoted. */
export type MetricsScopeKind = "all" | "project";

/** Shown as a marker: "the CLI measured this" and "we subtracted timestamps" differ. */
export type DurationSource = "cli" | "derived";

/** The four token classes the API reports, and no fifth (see the module doc before adding one). */
export interface TokenClasses {
  /** `usage.input_tokens` — context that was neither cached nor read from cache. */
  freshInput: number;
  /** `usage.output_tokens`. */
  output: number;
  /** `usage.cache_creation_input_tokens` (5 m and 1 h TTLs folded together). */
  cacheWrite: number;
  /** `usage.cache_read_input_tokens` — 97.9% of a real 24 h window. */
  cacheRead: number;
}

/** One turn — one distinct `promptId` — as the top-turns table renders it. */
export interface TurnRow {
  /** The `promptId`, or `<sessionId>#<n>` for a transcript too old to carry one. */
  turnId: string;
  sessionId: string;
  /** Always `"local"`: additional transcript roots are out of scope (see the docblock). */
  rootId: string;
  /** Basename of the transcript's cwd: never the mangled dir name (PII), never a path. */
  projectLabel: string;
  /** First line, collapsed, capped at 120 chars. `null` in `"all"` scope (no prompt text) and
   * for a turn with no user text; `turnLabel()` then composes a label. */
  label: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  /** `null`, never 0, for a turn with no terminal assistant message (interrupted or running);
   * such turns are excluded from {@link MetricsTotals.timeInTurnsMs}. */
  durationMs: number | null;
  durationSource: DurationSource | null;
  /** Distinct `requestId`s — deduped Rust-side before any counter was touched. */
  requests: number;
  tokens: TokenClasses;
  toolCalls: number;
  toolErrors: number;
  /** Distinct edited paths. The paths themselves never cross the wire. */
  filesChanged: number;
  interrupted: boolean;
  /** A person typed this, as opposed to the CLI initiating the turn. */
  humanPrompt: boolean;
  /** Normalized model ids (a trailing `[1m]` stripped), sorted. */
  models: string[];
}

/** One hour of the window. Single series ⇒ the chart needs no legend. */
export interface HourBucket {
  startMs: number;
  requests: number;
  output: number;
}

/** Per-root totals, shown alongside the merged total so it is never the only number. */
export interface RootTotals {
  rootId: string;
  label: string;
  available: boolean;
  sessions: number;
  turns: number;
  requests: number;
  tokens: TokenClasses;
}

export interface MetricsTotals {
  /** Distinct sessions with ≥1 turn ending in the window — not a file count. */
  sessions: number;
  turns: number;
  /** Turns a person typed; `turns - humanTurns` were CLI-initiated. */
  humanTurns: number;
  requests: number;
  tokens: TokenClasses;
  /** `(freshInput + cacheWrite + cacheRead) / requests`; `null` with no requests, never 0. */
  avgContextPerRequest: number | null;
  /** Fraction 0..1 of requests at ≥150 k context — the CLI's own threshold. */
  highContextRequestShare: number | null;
  toolCalls: number;
  toolErrors: number;
  /** Distinct paths edited across the window (a union, not a sum of per-turn counts). */
  filesChanged: number;
  /** Sum of known turn durations. Concurrent turns overlap, so it can exceed elapsed time. */
  timeInTurnsMs: number;
  /** How many turns contributed to {@link timeInTurnsMs}, of {@link turns}. */
  turnsWithDuration: number;
}

/** What the scan did and did not manage to see. */
export interface MetricsCoverage {
  rootsScanned: number;
  rootsUnavailable: string[];
  filesConsidered: number;
  filesRead: number;
  bytesRead: number;
  scanMs: number;
  filesTruncated: number;
  linesUnparseable: number;
  turnsWithoutCliDuration: number;
  turnsWithoutPromptId: number;
  /** `"project"` was requested with a null cwd, so the report covers everything; stated because the
   * scope differs from the request. Not `partial`: nothing was missed. */
  scopeFellBackToAll: boolean;
  /** True when a byte ceiling was hit or a root was unavailable — the numbers are a floor. */
  partial: boolean;
}

export interface MetricsReport {
  window: { kind: MetricsWindowKind; fromMs: number; toMs: number };
  /** Effective scope (see {@link MetricsCoverage.scopeFellBackToAll}); `cwd` only for project. */
  scope: { kind: MetricsScopeKind; cwd: string | null };
  totals: MetricsTotals;
  perRoot: RootTotals[];
  hourly: HourBucket[];
  /** Ranked by cache read desc (context volume), capped — read `totals` for truth. */
  topTurns: TurnRow[];
  coverage: MetricsCoverage;
  scannedAtMs: number;
}

/** Codes from `claude_metrics`, as `"<code>"` or `"<code>: <detail>"` (no file contents).
 * `no-transcripts` and `scan-failed` are never returned (empty window = empty report; null-cwd
 * project widens to all) but stay so the union tolerates the backend reintroducing them. */
export type MetricsErrorCode =
  /** No home directory could be resolved, so there is nowhere to read from. */
  | "home-unresolved"
  /** Reserved; see above. */
  | "no-transcripts"
  /** Reserved; no longer returned — see above. */
  | "scan-failed"
  /** A transcript root was unreachable. */
  | "root-unavailable"
  /** Anything unclassified — kept so the UI never renders a raw Rust string. */
  | "unknown";
