/**
 * Claude metrics — the wire contract between Rust's `claude_metrics` command and the
 * metrics dashboard tab.
 *
 * Mirror of `src-tauri/src/metrics.rs`. Structs are camelCase on the wire, enums
 * snake_case (ARCHITECTURE §2.5). If a shape changes, change it in BOTH files — the
 * Rust side is the source of truth and its unit tests pin the serialized strings.
 *
 * ── 🔴 There is deliberately NO `total` on {@link TokenClasses} ───────────────
 *
 * Not "we don't display it": it does not exist, so no future UI can render it by
 * accident. In a typical 24 h window of agent work, fresh input is well under 1% of
 * all tokens, output under 1%, cache writes about 2% and **cache reads about 98%**. A
 * summed headline would be ~98% cache reads, which cost ~0.1× fresh input — so one
 * summed number is not a simplification, it is a wrong answer. The honest headline that replaces it is
 * {@link MetricsTotals.avgContextPerRequest}, which averages a quantity that
 * genuinely *is* the context size and is the one the CLI itself thresholds at >150k.
 *
 * `MetricsPanel.test.tsx` asserts no rendered element contains a summed total — the
 * trap encoded as a gate, so a future "helpful" simplification fails CI.
 *
 * ── Everything here is derived from LOCAL transcripts ────────────────────────
 *
 * This machine only. It is not the account's usage (that is `features/usage`, which
 * asks the CLI and is account-wide across devices). The panel renders BOTH, in two
 * visually separate blocks with two mandatory labels — **"All devices · from your Claude
 * account"** for `features/usage`, **"This machine"** for everything on this contract —
 * because this is a truth condition, not styling: *a number may never be labelled "all
 * my usage" unless it came from the account*.
 *
 * ── What this contract does NOT carry, and why the fields are absent rather than 0 ──
 *
 * Fan-out attribution (a turn's sub-agents, their tokens and requests), the S1–S7
 * efficiency signals, and compaction rows are not implemented. They are **not** on this
 * contract yet, deliberately: `subagents: 0` on a turn that really spawned 17 children is
 * a false statement, and the same reasoning that removes `total` removes a placeholder
 * zero. A field appears here when it becomes true — which is also why the multi-root
 * bookkeeping an earlier version reserved (`duplicateSessionIds`, `conflictingSessionIds`) is
 * now **gone**: additional transcript roots are out of scope (`~/.claude` is not synced
 * between machines), so those lists would be permanently empty.
 */

/** Which window the report covers. Defaults to 24 h; both are supported. */
export type MetricsWindowKind = "last_24h" | "last_7d";

/**
 * Which sessions the report covers.
 *
 * **`"all"` is the default** — every project directory on this machine. The
 * dashboard is about total usage on the machine or account,
 * with everything that can be collected, not about one project. `"project"` is the
 * narrowing you opt into, and it is only meaningful with a cwd: **a `"project"` request with a `null` cwd resolves to
 * `"all"`** and sets {@link MetricsCoverage.scopeFellBackToAll}, rather than failing the
 * way an earlier version did.
 *
 * The privacy rules that `"all"` costs, implemented Rust-side and asserted on the
 * serialized report:
 *   - **no prompt text** — {@link TurnRow.label} is `null` by rule, and the UI identifies
 *     a turn by {@link TurnRow.projectLabel} plus its time. Rendering another project's
 *     prompt beside this project's numbers would be a cross-workspace leak;
 *   - **no absolute paths** — basenames only, and `scope.cwd` is `null` in `"all"` scope
 *     even when one was passed;
 *   - **no `toolUseResult` content**, in any scope — tool results are counted, never
 *     quoted.
 */
export type MetricsScopeKind = "all" | "project";

/**
 * Where a turn's duration came from. Rendered as a visible marker, because "the CLI
 * measured this" and "we subtracted two timestamps" are different claims.
 */
export type DurationSource = "cli" | "derived";

/**
 * Tokens in the four classes the API reports — and no fifth. See the docblock above
 * before considering a `total`.
 */
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
  /**
   * The **basename** of the transcript's cwd — never the mangled dir name (PII), never a
   * path. In `"all"` scope this is the only thing identifying where a turn came from,
   * which is why it is genuinely useful there and not just bookkeeping.
   */
  projectLabel: string;
  /**
   * The turn's first line, collapsed and capped at 120 chars — **`null` always in
   * `"all"` scope** (the no-prompt-text rule), and `null` in `"project"` scope for a turn
   * with no user text. `turnLabel()` composes `projectLabel` + the turn's clock time when
   * it is absent, so a row is still identifiable without quoting anybody's prompt.
   */
  label: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  /**
   * `null` — **never 0** — when the turn has no terminal assistant message
   * (interrupted, or still running), and such turns are excluded from
   * {@link MetricsTotals.timeInTurnsMs}. A zero standing in for an unknown states a
   * fact nobody observed, and the panel must render "—", never 0.
   */
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
  /**
   * `(freshInput + cacheWrite + cacheRead) / requests`. **`null` when there were no
   * requests** — an average of nothing is not 0, and the panel renders "—".
   */
  avgContextPerRequest: number | null;
  /** Fraction 0..1 of requests at ≥150 k context — the CLI's own threshold. */
  highContextRequestShare: number | null;
  toolCalls: number;
  toolErrors: number;
  /**
   * **Distinct** paths edited across the window — a union, not the sum of the
   * per-turn counts (a file edited in three turns is one file changed).
   */
  filesChanged: number;
  /**
   * Σ of the turns whose duration is KNOWN. Not wall-clock: concurrent agents make
   * turns overlap, so this can exceed elapsed time — hence the label "time in turns".
   */
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
  /**
   * `"project"` scope was requested with a `null` cwd, so the report covers **everything**
   * instead. This field replaced an earlier `Err("scan-failed: project scope requires a
   * cwd")` — an error users saw. Reported rather than silent because the report's
   * scope then differs from the request, and the panel says so. **Not** `partial`:
   * nothing was missed, more was seen.
   */
  scopeFellBackToAll: boolean;
  /** True when a byte ceiling was hit or a root was unavailable — the numbers are a floor. */
  partial: boolean;
}

export interface MetricsReport {
  window: { kind: MetricsWindowKind; fromMs: number; toMs: number };
  /**
   * The **effective** scope, which is not always the one requested — see
   * {@link MetricsCoverage.scopeFellBackToAll}. `cwd` is non-null only for
   * `kind: "project"`.
   */
  scope: { kind: MetricsScopeKind; cwd: string | null };
  totals: MetricsTotals;
  perRoot: RootTotals[];
  hourly: HourBucket[];
  /** Ranked by cache read desc (context volume), capped — read `totals` for truth. */
  topTurns: TurnRow[];
  coverage: MetricsCoverage;
  scannedAtMs: number;
}

/**
 * Stable error codes from `claude_metrics`. Rust returns `Err(String)` shaped as
 * `"<code>"` or `"<code>: <detail>"`, and the detail never carries file contents.
 *
 * Two codes are in the union and **never returned**, and both absences are decisions
 * rather than oversights:
 *   - `"no-transcripts"` — no Claude sessions in the window is a normal case that returns
 *     an empty report, and the panel says so in words;
 *   - `"scan-failed"` — this was an earlier answer to "project scope with no cwd", i.e. the
 *     no-selection bug. Rust now widens to `"all"` instead, so **nothing returns it**.
 *     It stays in the union because a frontend union must tolerate a code the backend
 *     could reintroduce, and because naming it here records that its removal was
 *     deliberate.
 */
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
