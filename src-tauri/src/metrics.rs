//! 24 h usage from local transcripts (wire: `metricsTypes.ts`); `~/.claude` is READ-ONLY. Usage
//! dedupes by `requestId`, tool blocks by `tool_use.id` (per line); no token total; forward scan,
//! capped. All scope (default): no prompt text, basenames only; `toolUseResult` never quoted.

use std::collections::{BTreeSet, HashSet};
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Bounds and caps
// ---------------------------------------------------------------------------

/// Max bytes read from ONE transcript (32 MiB): below the largest real files, whose tail is
/// reported as `partial` rather than parsed.
pub const PER_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// Most bytes one whole scan will read, across every root, 512 MiB. The unbounded
/// worst case is several seconds of parsing; this is what prevents it. Global
/// (not per-root) so N roots cannot multiply the worst case.
pub const TOTAL_BYTES: u64 = 512 * 1024 * 1024;

/// How many turn rows the report carries. The table is a "which turns dominated"
/// list, not a log; `MetricsTotals::turns` says how many there were in total, so the
/// UI can say "top 25 of 137" rather than implying the list is complete.
pub const TOP_TURNS_CAP: usize = 25;

/// Turn-label cap in chars; same rule as `session_index::single_line_label` (private there).
const LABEL_MAX_CHARS: usize = 120;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
const WEEK_MS: i64 = 7 * DAY_MS;

/// Error vocabulary mirroring `MetricsErrorCode` in `metricsTypes.ts` (`code[: detail]`, never
/// file contents). `no-transcripts` is never returned (no sessions = empty report) but stays.
pub const ERROR_CODES: [&str; 5] = [
    "home-unresolved",
    "no-transcripts",
    "scan-failed",
    "root-unavailable",
    "unknown",
];

// ---------------------------------------------------------------------------
// The wire contract — structs camelCase, enums snake_case
// ---------------------------------------------------------------------------

/// Which window the report covers. Renamed explicitly rather than via
/// `rename_all = "snake_case"`, which would emit `last24h` (a digit is not an
/// uppercase letter, so serde inserts no separator before it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetricsWindowKind {
    #[serde(rename = "last_24h")]
    Last24h,
    #[serde(rename = "last_7d")]
    Last7d,
}

impl MetricsWindowKind {
    /// Window length in ms. The window is `[now - span, now]` — deliberately a
    /// rolling span, not calendar-aligned: the question is about the last 24 hours,
    /// and an aligned window would answer a different question.
    fn span_ms(self) -> i64 {
        match self {
            MetricsWindowKind::Last24h => DAY_MS,
            MetricsWindowKind::Last7d => WEEK_MS,
        }
    }
}

/// Which sessions the report covers; `All` is the default (privacy rules in the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricsScopeKind {
    /// Every project directory under the root: this machine's whole usage, which is the
    /// question the dashboard answers. A `cwd` is meaningless here and is neither used nor
    /// echoed, and **no prompt text reaches the wire**.
    All,
    /// One project, matched by each transcript's own `cwd` field. Only meaningful WITH a
    /// cwd — without one it resolves to [`MetricsScopeKind::All`] rather than failing
    /// (see [`ResolvedScope::resolve`]).
    Project,
}

/// Where a turn's duration came from. Never inferred silently — the UI prints the
/// marker, because "we measured this" and "we subtracted two timestamps" are
/// different claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurationSource {
    /// The CLI's own `{"type":"system","subtype":"turn_duration","durationMs":N}`
    /// line. Present on newer CLIs only, so older transcripts never carry it.
    Cli,
    /// Last activity − prompt, computed by us.
    Derived,
}

/// Tokens in the four API classes, and no fifth: they span orders of magnitude and price ~10×
/// apart, so a sum means nothing. `ephemeral_5m`/`1h` fold into `cache_write` (unfold to price).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenClasses {
    /// `usage.input_tokens` — context that was neither cached nor read from cache.
    pub fresh_input: u64,
    /// `usage.output_tokens`.
    pub output: u64,
    /// `usage.cache_creation_input_tokens`.
    pub cache_write: u64,
    /// `usage.cache_read_input_tokens` — typically the vast majority of a 24 h window.
    pub cache_read: u64,
}

impl TokenClasses {
    fn add(&mut self, other: TokenClasses) {
        self.fresh_input += other.fresh_input;
        self.output += other.output;
        self.cache_write += other.cache_write;
        self.cache_read += other.cache_read;
    }

    /// The context the model actually had to look at: everything except what it
    /// wrote. This is the quantity behind `avg_context_per_request`, and the one the
    /// CLI itself thresholds at `>150k`.
    fn context(self) -> u64 {
        self.fresh_input + self.cache_write + self.cache_read
    }
}

/// One turn — one distinct `promptId` — as the top-turns table renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRow {
    /// The `promptId`, or `<session-id>#<n>` for a transcript too old to carry one
    /// (a minority of files). Counted in `coverage.turns_without_prompt_id` either way.
    pub turn_id: String,
    pub session_id: String,
    /// Which transcript root this came from. Always `local` — additional
    /// roots are explicitly out of scope, so this is one value today and stays
    /// on the wire only because the coverage block names the source it came from.
    pub root_id: String,
    /// The **basename** of the transcript's own `cwd`, and in `All` scope the only thing
    /// identifying a turn's origin. Never the mangled project directory name — that
    /// embeds the username, and never a path (privacy).
    pub project_label: String,
    /// The turn's first line, collapsed and capped. Always `None` in `All` scope (privacy) and for
    /// a turn with no user text; the UI then shows `project_label` + time.
    pub label: Option<String>,
    pub started_at_ms: i64,
    /// Last activity seen in the turn. `None` for a turn with no activity line.
    pub ended_at_ms: Option<i64>,
    /// `None`, never 0, for a turn with no terminal assistant message (interrupted or running);
    /// such turns are excluded from `totals.time_in_turns_ms`.
    pub duration_ms: Option<i64>,
    pub duration_source: Option<DurationSource>,
    /// Distinct `requestId`s (deduped).
    pub requests: u64,
    pub tokens: TokenClasses,
    pub tool_calls: u64,
    pub tool_errors: u64,
    /// Distinct `Edit`/`Write`/`MultiEdit`/`NotebookEdit` target paths. The paths
    /// themselves never reach the wire — only how many there were.
    pub files_changed: u64,
    /// The user hit Esc (`interruptedMessageId`) somewhere in this turn.
    pub interrupted: bool,
    /// A person typed this, as opposed to the CLI initiating it (`promptSource`
    /// `system`). Collapsing the two would inflate "you
    /// prompted N tasks".
    pub human_prompt: bool,
    /// Models used, normalized (a trailing `[...]` stripped, so `claude-opus-5[1m]`
    /// and `claude-opus-5` are one model), sorted for determinism.
    pub models: Vec<String>,
}

/// One hour of the window. Single series on purpose: requests is the only quantity
/// here with a fair linear scale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourBucket {
    /// Start of the bucket, unix ms. Buckets are hour-long slots measured from
    /// `window.from_ms`, not wall-clock hours — so the newest bucket is always
    /// "the last hour" rather than a partial calendar hour.
    pub start_ms: i64,
    pub requests: u64,
    pub output: u64,
}

/// Per-root totals, always shown *alongside* the merged total so a merged
/// number is never the only number on screen. Exactly one entry, always: there is one
/// root and additional roots are out of scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootTotals {
    pub root_id: String,
    pub label: String,
    pub available: bool,
    pub sessions: u64,
    pub turns: u64,
    pub requests: u64,
    pub tokens: TokenClasses,
}

/// The merged totals for the window.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsTotals {
    /// Distinct session ids with ≥1 turn ending in the window. Deliberately not
    /// "how many `.jsonl` files": empty and summary-only transcripts exist.
    pub sessions: u64,
    pub turns: u64,
    /// Turns a person typed. `turns - human_turns` are CLI-initiated.
    pub human_turns: u64,
    pub requests: u64,
    pub tokens: TokenClasses,
    /// `(freshInput + cacheWrite + cacheRead) / requests` — the headline that
    /// replaces a summed token total. `None` when there were no requests:
    /// an average of nothing is not 0.
    pub avg_context_per_request: Option<f64>,
    /// Share of requests whose context ≥ 150 k — **the CLI's own threshold**, so the
    /// UI can attribute it rather than invent one. `None` when there were no
    /// requests.
    pub high_context_request_share: Option<f64>,
    pub tool_calls: u64,
    pub tool_errors: u64,
    /// DISTINCT paths edited in the window (a union), so `files_changed <= Σ
    /// topTurns[].filesChanged`; pinned by a test.
    pub files_changed: u64,
    /// Σ of the turns whose duration is KNOWN. Not wall-clock: concurrent agents
    /// make turns overlap, so this can exceed elapsed time — which is why the UI
    /// calls it "time in turns".
    pub time_in_turns_ms: i64,
    /// How many turns contributed to `time_in_turns_ms`. Printed next to it, so a
    /// small sum over few known durations can never read as a small sum over all.
    pub turns_with_duration: u64,
}

/// What the scan did and did not manage to see. Rendered as a badge that expands —
/// a partial number must announce itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsCoverage {
    pub roots_scanned: u32,
    /// Labels of roots we could not read (unmounted volume, paused sync). The merged
    /// total **says a root is missing** rather than silently shrinking.
    pub roots_unavailable: Vec<String>,
    /// Transcripts the scan looked at the mtime of.
    pub files_considered: u64,
    /// Transcripts actually opened and streamed (i.e. `mtime >= window.from` and in
    /// scope). The gap to `files_considered` is the bound doing its job.
    pub files_read: u64,
    pub bytes_read: u64,
    pub scan_ms: u64,
    /// Files cut short by [`PER_FILE_BYTES`] or [`TOTAL_BYTES`].
    pub files_truncated: u64,
    /// Lines that were not valid JSON — garbage, or a final line still being
    /// written. Skipped calmly, never fatal.
    pub lines_unparseable: u64,
    pub turns_without_cli_duration: u64,
    pub turns_without_prompt_id: u64,
    /// `Project` was requested with no cwd, so the report covers `All`; reported because the scope
    /// differs from the request. Not `partial`: nothing was missed.
    pub scope_fell_back_to_all: bool,
    /// True when any ceiling was hit or any root was unavailable — i.e. when the
    /// numbers below are a floor, not the answer.
    pub partial: bool,
}

/// The window the report covers, echoed back so the UI never has to recompute it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsWindow {
    pub kind: MetricsWindowKind,
    pub from_ms: i64,
    pub to_ms: i64,
}

/// The scope the report covers — the **effective** one, which is not always the one that
/// was asked for (see [`MetricsCoverage::scope_fell_back_to_all`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsScope {
    pub kind: MetricsScopeKind,
    /// The narrowed project, `Some` only in `Project` scope. `None` in `All` even when the caller
    /// passed a cwd: it narrowed nothing (privacy: no absolute paths).
    pub cwd: Option<String>,
}

/// One whole reading. Kilobytes, by construction: the megabytes of transcript
/// bytes never cross IPC (ARCHITECTURE's high-volume-data invariant).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsReport {
    pub window: MetricsWindow,
    pub scope: MetricsScope,
    pub totals: MetricsTotals,
    pub per_root: Vec<RootTotals>,
    pub hourly: Vec<HourBucket>,
    /// Ranked by cache read desc (context volume — the UI says so), capped at
    /// [`TOP_TURNS_CAP`].
    pub top_turns: Vec<TurnRow>,
    pub coverage: MetricsCoverage,
    pub scanned_at_ms: i64,
}

/// The context size at which the CLI itself calls an operation high-context, quoted
/// from its own `/usage` output (`N% of your usage was at >150k context`). Adopted
/// and attributed rather than invented.
pub const HIGH_CONTEXT_TOKENS: u64 = 150_000;

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// Compute the report on `spawn_blocking` (no fs sweep on the supervisor or PTY path). `Err` is
/// an [`ERROR_CODES`] entry; no transcripts → empty report, no cwd → `All`. Only an unresolvable
/// home or an unfinished scan task fails.
#[tauri::command]
pub async fn claude_metrics(
    window: MetricsWindowKind,
    scope: MetricsScopeKind,
    cwd: Option<String>,
) -> Result<MetricsReport, String> {
    let home = crate::agent::claude::home_dir()
        .ok_or_else(|| "home-unresolved: no home directory".to_string())?;

    let roots = vec![ScanRoot::local(&home)];
    tokio::task::spawn_blocking(move || scan(&roots, window, scope, cwd.as_deref(), now_ms()))
        .await
        .map_err(|_| "unknown: the metrics scan did not finish".to_string())
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/// One transcript root shaped like `~/.claude/projects`. Injected, never derived in the scanner,
/// so tests run against a tempdir and never touch a real home.
#[derive(Debug, Clone)]
pub struct ScanRoot {
    pub id: String,
    pub label: String,
    pub projects_dir: PathBuf,
}

impl ScanRoot {
    /// The local root — always present, immutable, unremovable, and now the ONLY
    /// root: `~/.claude` is not synced between machines, so extra roots are out.
    pub fn local(home: &Path) -> Self {
        ScanRoot {
            id: "local".to_string(),
            label: "This machine".to_string(),
            projects_dir: home.join(".claude").join("projects"),
        }
    }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/// Aggregate every root into one report. `now_ms` is injected so the result is deterministic
/// (the hand-computed goldens in `tests/metrics.rs`).
pub fn scan(
    roots: &[ScanRoot],
    window_kind: MetricsWindowKind,
    scope_kind: MetricsScopeKind,
    cwd: Option<&str>,
    now_ms: i64,
) -> MetricsReport {
    scan_with_limits(
        roots,
        window_kind,
        scope_kind,
        cwd,
        now_ms,
        Limits::default(),
    )
}

/// [`scan`] with the byte ceilings injected — see [`Limits`].
pub fn scan_with_limits(
    roots: &[ScanRoot],
    window_kind: MetricsWindowKind,
    scope_kind: MetricsScopeKind,
    cwd: Option<&str>,
    now_ms: i64,
    limits: Limits,
) -> MetricsReport {
    let started = Instant::now();
    let to_ms = now_ms;
    let from_ms = now_ms - window_kind.span_ms();
    let window = MetricsWindow {
        kind: window_kind,
        from_ms,
        to_ms,
    };

    // One place decides what the scope MEANS: which transcripts qualify, whether prompt
    // text may be kept, what is echoed back, and whether a fallback happened.
    let scope = ResolvedScope::resolve(scope_kind, cwd);

    let mut coverage = MetricsCoverage {
        roots_scanned: 0,
        scope_fell_back_to_all: scope.fell_back,
        ..MetricsCoverage::default()
    };
    let mut budget = Budget {
        remaining: limits.total_bytes,
        per_file: limits.per_file_bytes,
    };
    let mut seen = Dedupe::default();
    let mut turns: Vec<ScannedTurn> = Vec::new();
    let mut per_root: Vec<RootTotals> = Vec::new();

    for root in roots {
        coverage.roots_scanned += 1;
        let before = turns.len();
        let available = scan_root(
            root,
            from_ms,
            &scope,
            &mut budget,
            &mut seen,
            &mut turns,
            &mut coverage,
        );
        if !available {
            coverage.roots_unavailable.push(root.label.clone());
            coverage.partial = true;
        }
        per_root.push(root_totals(root, available, &turns[before..], window));
    }

    finish(window, scope, turns, per_root, coverage, started)
}

/// The two byte ceilings, injected so a tiny fixture can prove a hit ceiling sets `partial`.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub per_file_bytes: u64,
    pub total_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            per_file_bytes: PER_FILE_BYTES,
            total_bytes: TOTAL_BYTES,
        }
    }
}

/// Remaining global byte budget, threaded through the scan so `total_bytes` is a cap
/// on the whole sweep rather than per root or per file.
struct Budget {
    remaining: u64,
    per_file: u64,
}

/// Scan-global identity sets: counting one request or tool use twice, in any file, is the error
/// this feature can't survive (a forked/resumed session may copy history into another file).
#[derive(Default)]
struct Dedupe {
    /// `<session>:<requestId>` — gates `usage` and the request count.
    requests: HashSet<String>,
    /// `<session>:<tool_use.id>` — gates tool calls and edited files. A *different*
    /// set on purpose: content blocks are spread across the lines of one request, so
    /// they must survive the request dedupe.
    tool_uses: HashSet<String>,
}

/// What a scope means to the scanner, resolved once in [`ResolvedScope::resolve`]: which
/// transcripts qualify ([`Self::targets`]) and whether prompt text may be read
/// ([`Self::keep_labels`]).
struct ResolvedScope {
    /// The scope actually computed — never the raw request. See [`Self::fell_back`].
    kind: MetricsScopeKind,
    /// The cwd echoed back on the wire. `Some` only in `Project` scope (privacy).
    cwd: Option<String>,
    /// The cwd spellings a transcript's own `cwd` must equal. Empty ⇒ everything, which
    /// is what [`in_scope`] reads as "no filter".
    targets: HashSet<String>,
    /// 🔴 May a turn's prompt text be extracted and put on the wire? **False in `All`
    /// scope** (privacy), and the gate sits at the point of *reading* rather than
    /// at serialization so another repo's prompt never becomes a value this process holds.
    keep_labels: bool,
    /// `Project` was requested with no cwd, so [`Self::kind`] is `All` instead. Surfaced
    /// as [`MetricsCoverage::scope_fell_back_to_all`].
    fell_back: bool,
}

impl ResolvedScope {
    /// `Project` needs a cwd; anything else is `All` (recorded). It only widens, never narrows.
    fn resolve(kind: MetricsScopeKind, cwd: Option<&str>) -> Self {
        match (kind, cwd) {
            (MetricsScopeKind::Project, Some(cwd)) => ResolvedScope {
                kind: MetricsScopeKind::Project,
                cwd: Some(cwd.to_string()),
                targets: scope_targets(cwd),
                keep_labels: true,
                fell_back: false,
            },
            (requested, _) => ResolvedScope {
                kind: MetricsScopeKind::All,
                cwd: None,
                targets: HashSet::new(),
                keep_labels: false,
                fell_back: matches!(requested, MetricsScopeKind::Project),
            },
        }
    }
}

/// The cwd spellings a transcript's `cwd` may equal: as given and symlink-resolved (`claude`
/// canonicalizes). The caller's cwd is only ever compared, never used to build a path, so it
/// cannot escape `~/.claude/projects`.
fn scope_targets(cwd: &str) -> HashSet<String> {
    let mut targets = HashSet::new();
    targets.insert(crate::paths::cwd_key(cwd));
    // `paths::canonicalize`: Windows' verbatim `\\?\C:\…` is never a transcript's spelling, and
    // `cwd_key` folds case there — `c:\repo` typed vs `C:\Repo` written by Claude Code.
    if let Ok(canon) = crate::paths::canonicalize(cwd) {
        targets.insert(crate::paths::cwd_key(&canon.to_string_lossy()));
    }
    targets
}

/// Empty targets (`All`) = no filter. A transcript with no `cwd` (empty or summary-only) is out
/// of `Project` scope rather than guessed from the directory name; in `All` it is in.
fn in_scope(targets: &HashSet<String>, file_cwd: Option<&str>) -> bool {
    if targets.is_empty() {
        return true;
    }
    file_cwd.is_some_and(|c| targets.contains(&crate::paths::cwd_key(c)))
}

/// Walk one root's project dirs; `false` if the root is unreadable (`roots_unavailable`, not an
/// error). Only `from_ms` filters (mtime is the LAST line). The per-file mtime skip runs before
/// any scope test and is the whole performance bound; `All` must not change that.
#[allow(clippy::too_many_arguments)]
fn scan_root(
    root: &ScanRoot,
    from_ms: i64,
    scope: &ResolvedScope,
    budget: &mut Budget,
    seen: &mut Dedupe,
    turns: &mut Vec<ScannedTurn>,
    coverage: &mut MetricsCoverage,
) -> bool {
    let Ok(entries) = std::fs::read_dir(&root.projects_dir) else {
        return false;
    };
    for project in entries.flatten() {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue; // one unreadable project dir must not fail the sweep
        };
        for entry in files.flatten() {
            let path = entry.path();
            let Some(session_id) = session_id_of(&path) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else {
                continue; // unstatable — skip the file entirely
            };
            if !meta.is_file() {
                // `<session-id>/` holds sub-agent sidecars; counting only depth-1 files
                // keeps their tokens out of parent totals.
                continue;
            }
            coverage.files_considered += 1;
            // THE WHOLE PERFORMANCE BOUND. Sound because transcripts are append-only
            // (even compaction appends), so an older file has no line in the window.
            if mtime_ms(&meta) < from_ms {
                continue;
            }
            scan_transcript(
                &path,
                &session_id,
                &root.id,
                meta.len(),
                scope,
                budget,
                seen,
                turns,
                coverage,
            );
        }
    }
    true
}

/// `<session-id>.jsonl` → `<session-id>`; anything else → `None`.
pub(crate) fn session_id_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    (!stem.is_empty()).then(|| stem.to_string())
}

// ---------------------------------------------------------------------------
// Per-file streaming
// ---------------------------------------------------------------------------

/// Stream one transcript FORWARD, never `read_to_string`: `read_until` so non-UTF-8 can't
/// abort the scan, `take` to cap bytes even for one gigantic line.
#[allow(clippy::too_many_arguments)]
fn scan_transcript(
    path: &Path,
    session_id: &str,
    root_id: &str,
    file_len: u64,
    scope: &ResolvedScope,
    budget: &mut Budget,
    seen: &mut Dedupe,
    turns: &mut Vec<ScannedTurn>,
    coverage: &mut MetricsCoverage,
) {
    let cap = budget.per_file.min(budget.remaining);
    if cap == 0 {
        // The global budget is spent. Report it as truncated rather than skipping
        // silently — a smaller number presented as the answer is the one failure
        // mode this feature cannot afford.
        coverage.files_truncated += 1;
        coverage.partial = true;
        return;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return; // unopenable — skip the file entirely
    };
    let truncated = file_len > cap;
    if truncated {
        coverage.files_truncated += 1;
        coverage.partial = true;
    }
    coverage.files_read += 1;

    let mut reader = std::io::BufReader::new(file).take(cap);
    let mut acc = Acc::new(session_id, root_id, scope.keep_labels);
    let mut buf: Vec<u8> = Vec::new();
    let mut consumed: u64 = 0;

    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break, // EOF, cap hit, or I/O error — keep what we have
            Ok(n) => n as u64,
        };
        consumed += n;
        // A line cut by the byte cap is incomplete JSON: drop it. An unterminated genuine
        // final line falls through and its parse failure is counted, not fatal.
        if truncated && !buf.ends_with(b"\n") {
            break;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buf) else {
            coverage.lines_unparseable += 1;
            continue;
        };
        // Scope is decided on the first line that names a cwd, and a mismatch bails
        // immediately — so an out-of-scope 6 MB transcript costs one line, not 6 MB.
        // (In `All` scope nothing mismatches, which is exactly why `All` costs more.)
        if acc.cwd.is_none() {
            if let Some(c) = nonblank_str(value.get("cwd")) {
                if !in_scope(&scope.targets, Some(&c)) {
                    budget.remaining = budget.remaining.saturating_sub(consumed);
                    coverage.bytes_read += consumed;
                    coverage.files_read -= 1;
                    return;
                }
                acc.cwd = Some(c);
            }
        }
        acc.absorb(&value, seen);
    }

    budget.remaining = budget.remaining.saturating_sub(consumed);
    coverage.bytes_read += consumed;

    if !in_scope(&scope.targets, acc.cwd.as_deref()) {
        // No `cwd` ever appeared (empty/summary-only transcript) while a scope was
        // requested. Nothing to attribute.
        coverage.files_read -= 1;
        return;
    }
    acc.flush(turns);
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/// A turn, as the scan built it — before window filtering and ranking.
#[derive(Debug, Clone)]
pub struct ScannedTurn {
    turn_id: String,
    session_id: String,
    root_id: String,
    project_label: String,
    label: Option<String>,
    started_at_ms: i64,
    ended_at_ms: Option<i64>,
    cli_duration_ms: Option<i64>,
    /// An assistant message with `stop_reason: "end_turn"` was seen — i.e. the turn
    /// actually finished. There is exactly one per completed turn (every other assistant
    /// message of the turn stops with `tool_use`).
    completed: bool,
    had_prompt_id: bool,
    requests: u64,
    tokens: TokenClasses,
    high_context_requests: u64,
    tool_calls: u64,
    tool_errors: u64,
    files: BTreeSet<String>,
    interrupted: bool,
    human_prompt: bool,
    models: BTreeSet<String>,
    /// Per-hour request/output counts keyed by the line's own timestamp, so the
    /// hourly chart and the totals are computed from the same lines and cannot
    /// disagree (the Σ hourly == totals conservation property).
    hourly: Vec<(i64, u64, u64)>,
}

/// One transcript's in-progress state.
struct Acc {
    session_id: String,
    root_id: String,
    cwd: Option<String>,
    /// 🔴 [`ResolvedScope::keep_labels`], carried down to the one line that reads prompt
    /// text. False in `All` scope, and it gates the *read*, not the write.
    keep_labels: bool,
    open: Option<ScannedTurn>,
    done: Vec<ScannedTurn>,
    /// Ordinal for synthesized turn ids in the no-`promptId` fallback.
    fallback_seq: usize,
}

impl Acc {
    fn new(session_id: &str, root_id: &str, keep_labels: bool) -> Self {
        Acc {
            session_id: session_id.to_string(),
            root_id: root_id.to_string(),
            cwd: None,
            keep_labels,
            open: None,
            done: Vec::new(),
            fallback_seq: 0,
        }
    }

    /// Fold one parsed line in.
    fn absorb(&mut self, v: &serde_json::Value, seen: &mut Dedupe) {
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_ts);

        match line_type {
            "user" => self.absorb_user(v, ts),
            "assistant" => self.absorb_assistant(v, ts, seen),
            "system" => self.absorb_system(v, ts),
            // Other types carry no metric used here; `rate_limit_event` has no `timestamp`
            // and must be ignored without panicking or inventing a turn.
            _ => {}
        }
    }

    fn absorb_user(&mut self, v: &serde_json::Value, ts: Option<i64>) {
        let prompt_id = nonblank_str(v.get("promptId"));

        // Turn boundary: a new `promptId`. Every user line of a turn shares it, so this
        // fires once per turn and tool_result lines fold in.
        if let Some(pid) = prompt_id {
            if self.open.as_ref().map(|t| t.turn_id.as_str()) != Some(pid.as_str()) {
                self.start_turn(pid, true, v, ts);
            }
        } else if is_human_prompt(v) && self.open.as_ref().is_none_or(|t| !t.had_prompt_id) {
            // Fallback for pre-`promptId` transcripts (counted in `turns_without_prompt_id`).
            // `!had_prompt_id`: a stray field-less line can never split a real turn.
            let id = format!("{}#{}", self.session_id, self.fallback_seq);
            self.fallback_seq += 1;
            self.start_turn(id, false, v, ts);
        }

        let Some(turn) = self.open.as_mut() else {
            return;
        };
        touch(turn, ts);
        if v.get("interruptedMessageId").is_some() {
            turn.interrupted = true;
        }
        // Tool RESULTS: counted, never quoted. `toolUseResult` may be an object or a
        // bare string, and either way its content is off limits — we read
        // only `is_error` off the content block, which lives on the message.
        if let Some(blocks) = v.get("message").and_then(|m| m.get("content")) {
            if let Some(blocks) = blocks.as_array() {
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) == Some("tool_result")
                        && b.get("is_error").and_then(|e| e.as_bool()) == Some(true)
                    {
                        turn.tool_errors += 1;
                    }
                }
            }
        }
    }

    fn absorb_assistant(&mut self, v: &serde_json::Value, ts: Option<i64>, seen: &mut Dedupe) {
        if self.open.is_none() {
            // An assistant line before any prompt line (a resumed transcript whose
            // head fell outside the read, or a `promptId`-less CLI). Its tokens are
            // real and must not vanish, so they get a fallback turn.
            let id = format!("{}#{}", self.session_id, self.fallback_seq);
            self.fallback_seq += 1;
            self.start_turn_bare(id, ts);
        }
        let session_id = self.session_id.clone();
        let Some(turn) = self.open.as_mut() else {
            return;
        };
        touch(turn, ts);

        let message = v.get("message");
        if message
            .and_then(|m| m.get("stop_reason"))
            .and_then(|s| s.as_str())
            == Some("end_turn")
        {
            turn.completed = true;
        }

        if let Some(model) = nonblank_str(message.and_then(|m| m.get("model"))) {
            turn.models.insert(normalize_model(&model));
        }

        // Content blocks are counted on EVERY line: one request spreads them across its
        // lines. Deduped by `tool_use.id` so this stays correct if a future CLI ever
        // repeats a block across the lines of one request.
        if let Some(blocks) = message
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                    continue;
                }
                // A block with no id cannot be deduped; counting it is the lesser
                // error (in practice every block has an id).
                if let Some(id) = nonblank_str(b.get("id")) {
                    if !seen.tool_uses.insert(format!("{session_id}:{id}")) {
                        continue;
                    }
                }
                turn.tool_calls += 1;
                let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                    if let Some(p) = nonblank_str(b.get("input").and_then(|i| i.get("file_path"))) {
                        turn.files.insert(p);
                    }
                }
            }
        }

        // Dedupe `usage` ONLY, by `requestId`, else `message.id` (1:1 with it). An unkeyable
        // line adds no tokens rather than one usage counted an unknown number of times.
        let key = nonblank_str(v.get("requestId"))
            .or_else(|| nonblank_str(message.and_then(|m| m.get("id"))))
            .map(|k| format!("{session_id}:{k}"));
        let Some(key) = key else {
            return;
        };
        if !seen.requests.insert(key) {
            return; // a later line of a request whose usage is already counted
        }

        turn.requests += 1;
        let tokens = read_usage(message.and_then(|m| m.get("usage")));
        turn.tokens.add(tokens);
        if tokens.context() >= HIGH_CONTEXT_TOKENS {
            turn.high_context_requests += 1;
        }
        // Bucket by the line's timestamp, else the turn's latest activity, so
        // `Σ hourly[].requests == totals.requests` holds even for timestamp-less lines.
        let bucket_ts = ts.or(turn.ended_at_ms).unwrap_or(turn.started_at_ms);
        turn.hourly.push((bucket_ts, 1, tokens.output));
    }

    fn absorb_system(&mut self, v: &serde_json::Value, ts: Option<i64>) {
        let Some(turn) = self.open.as_mut() else {
            return;
        };
        // The CLI's own measurement lands after the turn's last content and before the
        // next prompt, so the open turn owns it; a turn without one keeps `None`.
        if v.get("subtype").and_then(|s| s.as_str()) == Some("turn_duration") {
            if let Some(ms) = v.get("durationMs").and_then(|d| d.as_i64()) {
                if ms >= 0 {
                    turn.cli_duration_ms = Some(ms);
                }
            }
            touch(turn, ts);
        }
    }

    /// Close the open turn and open a new one from a user line.
    fn start_turn(
        &mut self,
        turn_id: String,
        had_prompt_id: bool,
        v: &serde_json::Value,
        ts: Option<i64>,
    ) {
        self.close_open();
        let mut turn = self.blank_turn(turn_id, ts);
        turn.had_prompt_id = had_prompt_id;
        turn.human_prompt = is_human_prompt(v);
        // Privacy: in `All` scope the text is never extracted (not extracted-then-dropped).
        // `is_human_prompt` may look at it but keeps only a bool.
        if self.keep_labels {
            turn.label = user_text(v).map(|t| single_line_label(&t));
        }
        self.open = Some(turn);
    }

    /// Open a turn with no user line behind it (assistant-first fallback).
    fn start_turn_bare(&mut self, turn_id: String, ts: Option<i64>) {
        self.close_open();
        self.open = Some(self.blank_turn(turn_id, ts));
    }

    fn blank_turn(&self, turn_id: String, ts: Option<i64>) -> ScannedTurn {
        ScannedTurn {
            turn_id,
            session_id: self.session_id.clone(),
            root_id: self.root_id.clone(),
            project_label: base_name(self.cwd.as_deref().unwrap_or_default()),
            label: None,
            started_at_ms: ts.unwrap_or(0),
            ended_at_ms: ts,
            cli_duration_ms: None,
            completed: false,
            had_prompt_id: false,
            requests: 0,
            tokens: TokenClasses::default(),
            high_context_requests: 0,
            tool_calls: 0,
            tool_errors: 0,
            files: BTreeSet::new(),
            interrupted: false,
            human_prompt: false,
            models: BTreeSet::new(),
            hourly: Vec::new(),
        }
    }

    fn close_open(&mut self) {
        if let Some(turn) = self.open.take() {
            self.done.push(turn);
        }
    }

    /// Hand this transcript's turns to the caller, back-filling the project label
    /// (the first turn may have started before the first `cwd` line was seen).
    fn flush(mut self, out: &mut Vec<ScannedTurn>) {
        self.close_open();
        let label = base_name(self.cwd.as_deref().unwrap_or_default());
        for mut turn in self.done {
            if turn.project_label.is_empty() {
                turn.project_label = label.clone();
            }
            out.push(turn);
        }
    }
}

/// Extend a turn's activity window. Uses `max` rather than "last line wins" because
/// timestamps are **not** monotonic (a long session routinely has a few lines out of
/// order), so the last line is not reliably the latest one.
fn touch(turn: &mut ScannedTurn, ts: Option<i64>) {
    let Some(t) = ts else { return };
    turn.ended_at_ms = Some(turn.ended_at_ms.map_or(t, |cur| cur.max(t)));
    if turn.started_at_ms == 0 {
        turn.started_at_ms = t;
    }
}

/// Did a person type this turn? `promptSource` decides when present (newer CLIs); otherwise
/// real text that is not a local-command echo or machine marker.
fn is_human_prompt(v: &serde_json::Value) -> bool {
    if let Some(source) = v.get("promptSource").and_then(|s| s.as_str()) {
        return matches!(source, "typed" | "queued");
    }
    if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
        return false;
    }
    let Some(text) = user_text(v) else {
        return false;
    };
    !starts_with_machine_marker(&text)
}

/// Markers Claude Code uses for text it generated itself. A turn opening with one of
/// these is the CLI talking to itself, not a person prompting.
const MACHINE_MARKERS: [&str; 5] = [
    "<command-",
    "<local-command",
    "<system-reminder",
    "<task",
    "Caveat:",
];

fn starts_with_machine_marker(text: &str) -> bool {
    let t = text.trim_start();
    MACHINE_MARKERS.iter().any(|m| t.starts_with(m))
}

/// A user line's text (string content or first `text` block): the ONLY text extracted. Never
/// `toolUseResult`, which routinely carries tokens, keys and connection strings.
fn user_text(v: &serde_json::Value) -> Option<String> {
    match v.get("message")?.get("content")? {
        serde_json::Value::String(s) => nonblank(s),
        serde_json::Value::Array(blocks) => blocks.iter().find_map(|b| {
            (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .then(|| b.get("text").and_then(|t| t.as_str()).and_then(nonblank))
                .flatten()
        }),
        _ => None,
    }
}

/// The four classes off a `usage` object. A missing field is 0 — the API omits a
/// class it did not use, which genuinely means zero of it (unlike a missing
/// *duration*, which means unknown; see [`TurnRow::duration_ms`]).
fn read_usage(usage: Option<&serde_json::Value>) -> TokenClasses {
    let Some(u) = usage else {
        return TokenClasses::default();
    };
    TokenClasses {
        fresh_input: u64_at(u, "input_tokens"),
        output: u64_at(u, "output_tokens"),
        cache_write: u64_at(u, "cache_creation_input_tokens"),
        cache_read: u64_at(u, "cache_read_input_tokens"),
    }
}

/// A non-negative integer field, or 0. Negative and non-integer values are read as
/// 0 rather than saturating: a token count cannot be negative, so a negative one is
/// a value we failed to read, and 0 is the only answer that cannot inflate a total.
fn u64_at(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|n| n.as_u64()).unwrap_or(0)
}

/// `claude-opus-5[1m]` → `claude-opus-5`. Two spellings of one model exist in the
/// corpus and must not become two rows in a model mix.
fn normalize_model(model: &str) -> String {
    match model.find('[') {
        Some(i) if model.ends_with(']') => model[..i].trim_end().to_string(),
        _ => model.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Finishing: window filter, totals, ranking
// ---------------------------------------------------------------------------

/// Build the report. A turn belongs to the window of its END and contributes all its work, so
/// refreshes agree. With [`bucket_index`]'s clamping, Σ topTurns output (within
/// [`TOP_TURNS_CAP`]), Σ hourly and Σ perRoot requests equal the totals exactly.
fn finish(
    window: MetricsWindow,
    scope: ResolvedScope,
    turns: Vec<ScannedTurn>,
    per_root: Vec<RootTotals>,
    mut coverage: MetricsCoverage,
    started: Instant,
) -> MetricsReport {
    let buckets = bucket_count(window);
    let mut hourly: Vec<HourBucket> = (0..buckets)
        .map(|i| HourBucket {
            start_ms: window.from_ms + (i as i64) * HOUR_MS,
            requests: 0,
            output: 0,
        })
        .collect();

    let mut totals = MetricsTotals {
        sessions: 0,
        turns: 0,
        human_turns: 0,
        requests: 0,
        tokens: TokenClasses::default(),
        avg_context_per_request: None,
        high_context_request_share: None,
        tool_calls: 0,
        tool_errors: 0,
        files_changed: 0,
        time_in_turns_ms: 0,
        turns_with_duration: 0,
    };
    let mut sessions: HashSet<String> = HashSet::new();
    let mut files: HashSet<String> = HashSet::new();
    let mut high_context: u64 = 0;
    let mut rows: Vec<TurnRow> = Vec::new();

    for turn in turns.into_iter().filter(|t| in_window(t, window)) {
        totals.turns += 1;
        if turn.human_prompt {
            totals.human_turns += 1;
        }
        sessions.insert(turn.session_id.clone());
        totals.requests += turn.requests;
        totals.tokens.add(turn.tokens);
        totals.tool_calls += turn.tool_calls;
        totals.tool_errors += turn.tool_errors;
        high_context += turn.high_context_requests;
        for f in &turn.files {
            files.insert(f.clone());
        }
        if !turn.had_prompt_id {
            coverage.turns_without_prompt_id += 1;
        }
        if turn.cli_duration_ms.is_none() {
            coverage.turns_without_cli_duration += 1;
        }
        for (ts, requests, output) in &turn.hourly {
            let idx = bucket_index(*ts, window, buckets);
            hourly[idx].requests += requests;
            hourly[idx].output += output;
        }
        let (duration_ms, duration_source) = duration_of(&turn);
        if let Some(ms) = duration_ms {
            totals.time_in_turns_ms += ms;
            totals.turns_with_duration += 1;
        }
        rows.push(TurnRow {
            turn_id: turn.turn_id,
            session_id: turn.session_id,
            root_id: turn.root_id,
            project_label: turn.project_label,
            label: turn.label,
            started_at_ms: turn.started_at_ms,
            ended_at_ms: turn.ended_at_ms,
            duration_ms,
            duration_source,
            requests: turn.requests,
            tokens: turn.tokens,
            tool_calls: turn.tool_calls,
            tool_errors: turn.tool_errors,
            files_changed: turn.files.len() as u64,
            interrupted: turn.interrupted,
            human_prompt: turn.human_prompt,
            models: turn.models.into_iter().collect(),
        });
    }

    totals.sessions = sessions.len() as u64;
    totals.files_changed = files.len() as u64;
    if totals.requests > 0 {
        let requests = totals.requests as f64;
        totals.avg_context_per_request = Some(totals.tokens.context() as f64 / requests);
        totals.high_context_request_share = Some(high_context as f64 / requests);
    }

    // Ranked by cache read desc — "most expensive" here means CONTEXT VOLUME, and
    // the UI says so. Tiebroken by end then id so the order is deterministic across
    // runs (a table that reshuffles on refresh reads as a bug).
    rows.sort_by(|a, b| {
        b.tokens
            .cache_read
            .cmp(&a.tokens.cache_read)
            .then_with(|| b.ended_at_ms.cmp(&a.ended_at_ms))
            .then_with(|| a.turn_id.cmp(&b.turn_id))
    });
    rows.truncate(TOP_TURNS_CAP);

    coverage.scan_ms = started.elapsed().as_millis() as u64;

    MetricsReport {
        window,
        scope: MetricsScope {
            kind: scope.kind,
            cwd: scope.cwd,
        },
        totals,
        per_root,
        hourly,
        top_turns: rows,
        coverage,
        scanned_at_ms: window.to_ms,
    }
}

/// How many hour buckets the window needs (24 for a day, 168 for a week).
fn bucket_count(window: MetricsWindow) -> usize {
    (((window.to_ms - window.from_ms) / HOUR_MS).max(1)) as usize
}

/// Bucket for a timestamp, clamped at both ends so a line on `to_ms` can't fall off and
/// `Σ hourly[].requests == totals.requests` always holds.
fn bucket_index(ts: i64, window: MetricsWindow, buckets: usize) -> usize {
    let offset = (ts - window.from_ms).max(0) / HOUR_MS;
    (offset as usize).min(buckets - 1)
}

/// A turn belongs to the window of its END. A turn with no activity at all
/// falls back to its start, so a prompt typed inside the window and never answered
/// is still counted as a turn — with `durationMs: null`.
fn in_window(turn: &ScannedTurn, window: MetricsWindow) -> bool {
    let at = turn.ended_at_ms.unwrap_or(turn.started_at_ms);
    at >= window.from_ms && at <= window.to_ms
}

/// Duration and source: the CLI's `turn_duration`, else derived only for a finished
/// (`end_turn`), uninterrupted turn, else `None`, never 0.
fn duration_of(turn: &ScannedTurn) -> (Option<i64>, Option<DurationSource>) {
    if let Some(ms) = turn.cli_duration_ms {
        return (Some(ms), Some(DurationSource::Cli));
    }
    if turn.interrupted || !turn.completed {
        return (None, None);
    }
    match turn.ended_at_ms {
        Some(end) if end >= turn.started_at_ms && turn.started_at_ms > 0 => (
            Some(end - turn.started_at_ms),
            Some(DurationSource::Derived),
        ),
        _ => (None, None),
    }
}

/// Per-root totals over the turns that root contributed.
fn root_totals(
    root: &ScanRoot,
    available: bool,
    turns: &[ScannedTurn],
    window: MetricsWindow,
) -> RootTotals {
    let mut out = RootTotals {
        root_id: root.id.clone(),
        label: root.label.clone(),
        available,
        sessions: 0,
        turns: 0,
        requests: 0,
        tokens: TokenClasses::default(),
    };
    let mut sessions: HashSet<&str> = HashSet::new();
    for turn in turns.iter().filter(|t| in_window(t, window)) {
        out.turns += 1;
        out.requests += turn.requests;
        out.tokens.add(turn.tokens);
        sessions.insert(turn.session_id.as_str());
    }
    out.sessions = sessions.len() as u64;
    out
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Collapse whitespace and cap at [`LABEL_MAX_CHARS`] chars (char-based), appending `…` if cut.
fn single_line_label(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= LABEL_MAX_CHARS {
        return collapsed;
    }
    let mut t: String = collapsed.chars().take(LABEL_MAX_CHARS).collect();
    t.push('…');
    t
}

/// Trailing-slash-insensitive comparison form (`/a/b/` ≡ `/a/b`; `/` stays `/`).
fn normalize_cwd(s: &str) -> String {
    // A Windows spelling (`C:\x\repo\`) ends in `\` — trimmed the same way (the
    // macOS path below is unchanged).
    let t = if crate::paths::is_windows_spelling(s) {
        s.trim_end_matches(['/', '\\'])
    } else {
        s.trim_end_matches('/')
    };
    if t.is_empty() {
        "/".to_string()
    } else {
        t.to_string()
    }
}

/// The last path segment — the ONLY part of a path this module puts on the wire.
fn base_name(path: &str) -> String {
    let n = normalize_cwd(path);
    let seps: &[char] = if crate::paths::is_windows_spelling(&n) {
        &['/', '\\']
    } else {
        &['/']
    };
    n.rsplit(seps).next().unwrap_or_default().to_string()
}

fn nonblank(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| s.to_string())
}

fn nonblank_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).and_then(nonblank)
}

/// mtime as ms epoch; anything odd yields 0, before any window, so an undatable file is skipped.
pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Wall clock as unix ms (0 if the clock is somehow before the epoch).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse `2026-01-01T12:30:15.250Z` (or a `±HH:MM` offset) to unix ms, else `None` (no usable
/// timestamp). Hand-rolled: this module adds no date-crate dependency.
fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut rest = s.get(19..)?;
    let mut millis: i64 = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        // Pad/truncate to exactly 3 digits so `.7`, `.743` and `.743210` all mean
        // what they say rather than what their digit count implies.
        let mut ms = digits.chars().take(3).collect::<String>();
        while ms.len() < 3 {
            ms.push('0');
        }
        millis = ms.parse().ok()?;
        rest = &frac[digits.len()..];
    }

    let offset_secs = match rest.as_bytes().first() {
        None => 0,
        Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh: i64 = rest.get(1..3)?.parse().ok()?;
            // `+01:00` and `+0100` are both legal RFC 3339-ish spellings.
            let om: i64 = match rest.len() {
                6 => rest.get(4..6)?.parse().ok()?,
                5 => rest.get(3..5)?.parse().ok()?,
                _ => return None,
            };
            let magnitude = oh * 3600 + om * 60;
            if *sign == b'+' {
                -magnitude
            } else {
                magnitude
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second + offset_secs) * 1000) + millis)
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Howard Hinnant's
/// `days_from_civil`). Pure integer arithmetic, no leap-year table, correct for
/// every year — and pinned against known dates in the tests below.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    /// Live All-scope scan of the real `~/.claude`, `#[ignore]`d; asserts invariants, that a null
    /// cwd doesn't error, and no prompt text. Run:
    /// `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored live_metrics`.
    #[test]
    #[ignore = "reads the real ~/.claude — run with --ignored"]
    fn live_metrics_scans_all_projects_with_no_cwd() {
        let report = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(claude_metrics(
                MetricsWindowKind::Last24h,
                MetricsScopeKind::All,
                None, // ← the exact argument that used to fail
            ))
            .expect("a null cwd in All scope must NOT be an error");

        // Invariants only.
        assert!(
            report.coverage.files_considered >= report.coverage.files_read,
            "cannot read more files than were considered"
        );
        assert!(
            report.totals.requests >= report.top_turns.len() as u64,
            "a turn needs at least one request"
        );
        assert_eq!(report.scope.kind, MetricsScopeKind::All);
        assert!(report.scope.cwd.is_none(), "All scope names no project");
        assert!(
            !report.coverage.scope_fell_back_to_all,
            "All was asked for directly"
        );

        // The privacy rule that gated All scope: no prompt text on the wire. Turn labels
        // must be derived (project · time, or a session handle) — never a prompt.
        for t in &report.top_turns {
            assert!(
                t.label.is_none(),
                "All scope must carry no prompt text, got a label"
            );
            assert!(
                !t.project_label.contains('/'),
                "project label must be a basename, got {}",
                t.project_label
            );
        }

        eprintln!(
            "live All-scope 24h: {} files considered / {} read / {} ms | {} turns, {} requests",
            report.coverage.files_considered,
            report.coverage.files_read,
            report.coverage.scan_ms,
            report.totals.turns,
            report.totals.requests,
        );
    }

    use super::*;

    #[test]
    fn timestamps_parse_to_the_epoch_millisecond() {
        // Pinned against values a human can check: 1970-01-01T00:00:00Z is 0, and
        // 2026-01-01T12:30:15.250Z is an arbitrary instant built from the calendar.
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts("1970-01-01T00:00:01.500Z"), Some(1500));
        // 20_454 days from the epoch to 2026-01-01 -> checked against the
        // days_from_civil test below, then + 12:30:15.250.
        let expect = (days_from_civil(2026, 1, 1) * 86_400 + 12 * 3600 + 30 * 60 + 15) * 1000 + 250;
        assert_eq!(expect, 1_767_270_615_250);
        assert_eq!(parse_ts("2026-01-01T12:30:15.250Z"), Some(expect));
        // Fractional digits are normalized to milliseconds, not counted.
        assert_eq!(parse_ts("1970-01-01T00:00:00.7Z"), Some(700));
        assert_eq!(parse_ts("1970-01-01T00:00:00.123456Z"), Some(123));
        // Offsets, both spellings, both signs.
        assert_eq!(parse_ts("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_ts("1970-01-01T01:00:00+0100"), Some(0));
        assert_eq!(parse_ts("1969-12-31T19:00:00-05:00"), Some(0));
        // Garbage is None, never a guess.
        assert_eq!(parse_ts(""), None);
        assert_eq!(parse_ts("not-a-timestamp-at-all"), None);
        assert_eq!(parse_ts("2026-13-01T00:00:00Z"), None, "month 13");
        assert_eq!(parse_ts("2026-01-32T00:00:00Z"), None, "day 32");
        assert_eq!(parse_ts("2026-01-01T24:00:00Z"), None, "hour 24");
        assert_eq!(parse_ts("2026-01-01T00:60:00Z"), None, "minute 60");
        assert_eq!(parse_ts("2026-01-01T00:00:00~"), None, "unknown suffix");
        assert_eq!(parse_ts("2026-01-01T00:00:00+9"), None, "short offset");
    }

    #[test]
    fn days_from_civil_matches_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(days_from_civil(2000, 3, 1), 11017, "day after a leap day");
        assert_eq!(days_from_civil(2000, 2, 29), 11016, "2000 IS a leap year");
        // 2100 is NOT a leap year (divisible by 100, not by 400) — the case a
        // hand-written leap-year check gets wrong.
        assert_eq!(
            days_from_civil(2100, 3, 1) - days_from_civil(2100, 2, 28),
            1
        );
        assert_eq!(
            days_from_civil(2024, 3, 1) - days_from_civil(2024, 2, 28),
            2
        );
    }

    #[test]
    fn model_spellings_collapse_to_one_id() {
        assert_eq!(normalize_model("claude-opus-5[1m]"), "claude-opus-5");
        assert_eq!(normalize_model("claude-opus-5"), "claude-opus-5");
        assert_eq!(normalize_model("claude-opus-5 [1m]"), "claude-opus-5");
        // A bracket that is not a trailing suffix is left alone — we strip a known
        // decoration, we do not sanitize arbitrary strings.
        assert_eq!(normalize_model("weird[model"), "weird[model");
    }

    #[test]
    fn labels_collapse_newlines_and_cap_at_120_chars() {
        assert_eq!(
            single_line_label("fix\nthe   build\t now"),
            "fix the build now"
        );
        let long = "word ".repeat(100);
        let l = single_line_label(&long);
        assert_eq!(l.chars().count(), LABEL_MAX_CHARS + 1, "cap + ellipsis");
        assert!(l.ends_with('…'));
        // Multibyte chars are counted as chars, never split mid-encoding.
        assert_eq!(
            single_line_label(&"é".repeat(200)).chars().count(),
            LABEL_MAX_CHARS + 1
        );
    }

    #[test]
    fn base_name_is_the_last_segment_and_never_a_full_path() {
        assert_eq!(base_name("/a/b/AgentStudioIDE"), "AgentStudioIDE");
        assert_eq!(base_name("/a/b/AgentStudioIDE/"), "AgentStudioIDE");
        assert_eq!(base_name(""), "");
        assert_eq!(base_name("/"), "");
        // A Windows cwd (as Claude Code writes it there) labels by its last folder too — an
        // older build put the whole path on the wire as the "name".
        assert_eq!(base_name(r"C:\Users\me\AgentStudioIDE"), "AgentStudioIDE");
        assert_eq!(base_name(r"C:\Users\me\AgentStudioIDE\"), "AgentStudioIDE");
        assert_eq!(base_name(r"C:/Users/me/AgentStudioIDE"), "AgentStudioIDE");
        // …and a Unix name holding a backslash keeps it.
        assert_eq!(base_name(r"/a/odd\name"), r"odd\name");
    }

    #[test]
    fn normalize_cwd_is_trailing_slash_insensitive() {
        assert_eq!(normalize_cwd("/a/b/"), "/a/b");
        assert_eq!(normalize_cwd("/a/b"), "/a/b");
        assert_eq!(normalize_cwd("/"), "/", "root must survive");
    }

    #[test]
    fn a_project_request_with_no_cwd_resolves_to_all_and_records_the_fallback() {
        let fell_back = ResolvedScope::resolve(MetricsScopeKind::Project, None);
        assert_eq!(
            fell_back.kind,
            MetricsScopeKind::All,
            "widened, not refused"
        );
        assert!(fell_back.fell_back, "…and it says so");
        assert!(fell_back.targets.is_empty(), "no filter");
        assert!(!fell_back.keep_labels, "All scope carries no prompt text");
        assert_eq!(fell_back.cwd, None);

        // `All` asked for directly is the same scope, and NOT a fallback — the report
        // must not claim it answered a different question than the one it was asked.
        let all = ResolvedScope::resolve(MetricsScopeKind::All, None);
        assert_eq!(all.kind, MetricsScopeKind::All);
        assert!(!all.fell_back);

        // A cwd handed to `All` narrows nothing, so it is neither used nor echoed.
        let all_with_cwd = ResolvedScope::resolve(MetricsScopeKind::All, Some("/work/proj"));
        assert_eq!(all_with_cwd.kind, MetricsScopeKind::All);
        assert_eq!(all_with_cwd.cwd, None, "echoing it would imply it narrowed");
        assert!(all_with_cwd.targets.is_empty());
        assert!(!all_with_cwd.keep_labels);
        assert!(!all_with_cwd.fell_back);

        // `Project` WITH a cwd is the only shape that filters and the only one that may
        // keep prompt text.
        let project = ResolvedScope::resolve(MetricsScopeKind::Project, Some("/work/proj"));
        assert_eq!(project.kind, MetricsScopeKind::Project);
        assert_eq!(project.cwd.as_deref(), Some("/work/proj"));
        assert!(project.targets.contains("/work/proj"));
        assert!(project.keep_labels);
        assert!(!project.fell_back);
    }

    #[test]
    fn scope_with_no_cwd_admits_everything_and_a_cwdless_file_is_out_of_scope() {
        let none: HashSet<String> = HashSet::new();
        assert!(in_scope(&none, None), "All scope -> no filter");
        assert!(in_scope(&none, Some("/anywhere")));

        let mut targets = HashSet::new();
        targets.insert("/work/proj".to_string());
        assert!(in_scope(&targets, Some("/work/proj")));
        assert!(in_scope(&targets, Some("/work/proj/")), "trailing slash");
        // Windows: the typed spelling, the canonical one and Claude Code's are one project.
        let win = scope_targets(r"c:\Work\Proj");
        assert!(
            in_scope(&win, Some(r"C:\work\proj\")),
            "case + trailing separator"
        );
        assert!(
            in_scope(&win, Some(r"\\?\C:\Work\Proj")),
            "verbatim spelling"
        );
        assert!(!in_scope(&win, Some(r"C:\Work\Other")));
        assert!(!in_scope(&targets, Some("/work/other")));
        assert!(
            !in_scope(&targets, None),
            "a transcript with no cwd carries no metrics, so it is not guessed into scope"
        );
    }

    #[test]
    fn a_missing_or_nonsense_usage_field_reads_as_zero_never_as_a_guess() {
        assert_eq!(read_usage(None), TokenClasses::default());
        let v: serde_json::Value = serde_json::json!({});
        assert_eq!(read_usage(Some(&v)), TokenClasses::default());
        let v = serde_json::json!({
            "input_tokens": 2, "output_tokens": 268,
            "cache_creation_input_tokens": 14002, "cache_read_input_tokens": 21098,
        });
        assert_eq!(
            read_usage(Some(&v)),
            TokenClasses {
                fresh_input: 2,
                output: 268,
                cache_write: 14002,
                cache_read: 21098
            }
        );
        // A negative or non-numeric count is unreadable, so it is 0 — the only
        // answer that cannot inflate a total.
        let v = serde_json::json!({ "output_tokens": -5, "input_tokens": "many" });
        assert_eq!(read_usage(Some(&v)), TokenClasses::default());
    }

    #[test]
    fn token_classes_have_exactly_four_fields_and_no_total() {
        // The trap, encoded: a `total` on the wire is forbidden, so the
        // serialized shape is asserted key-by-key. Adding a fifth counter fails here
        // before it can reach a UI.
        let json = serde_json::to_value(TokenClasses {
            fresh_input: 1,
            output: 2,
            cache_write: 3,
            cache_read: 4,
        })
        .expect("serializable");
        let obj = json.as_object().expect("object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["cacheRead", "cacheWrite", "freshInput", "output"]);
        assert!(!obj.contains_key("total"), "there is no total — rule 2");
    }

    #[test]
    fn human_prompt_prefers_prompt_source_then_falls_back_to_structure() {
        let typed = serde_json::json!({ "promptSource": "typed" });
        assert!(is_human_prompt(&typed));
        let queued = serde_json::json!({ "promptSource": "queued" });
        assert!(
            is_human_prompt(&queued),
            "a queued prompt is still the user's"
        );
        let system = serde_json::json!({ "promptSource": "system" });
        assert!(!is_human_prompt(&system));
        let sdk = serde_json::json!({ "promptSource": "sdk" });
        assert!(!is_human_prompt(&sdk));

        // No promptSource (older CLI) -> the structural test.
        let text = serde_json::json!({ "message": { "content": "do the thing" } });
        assert!(is_human_prompt(&text));
        let blocks =
            serde_json::json!({ "message": { "content": [{ "type": "text", "text": "hi" }] } });
        assert!(is_human_prompt(&blocks));
        let meta = serde_json::json!({ "isMeta": true, "message": { "content": "/clear" } });
        assert!(
            !is_human_prompt(&meta),
            "a local-command echo is not a prompt"
        );
        for marker in MACHINE_MARKERS {
            let v = serde_json::json!({
                "message": { "content": format!("{marker} something") }
            });
            assert!(!is_human_prompt(&v), "{marker} is a machine marker");
        }
        let tool_only = serde_json::json!({
            "message": { "content": [{ "type": "tool_result", "content": "x" }] }
        });
        assert!(
            !is_human_prompt(&tool_only),
            "a tool result is not a prompt"
        );
        let no_message = serde_json::json!({ "type": "user" });
        assert!(!is_human_prompt(&no_message));
        let odd_content = serde_json::json!({ "message": { "content": 7 } });
        assert!(!is_human_prompt(&odd_content));
        let blank = serde_json::json!({ "message": { "content": "   " } });
        assert!(!is_human_prompt(&blank));
    }

    #[test]
    fn user_text_never_reaches_for_a_tool_result() {
        // Privacy: a `toolUseResult` is counted, never quoted — in either of the two
        // shapes it takes (object here, string in fixture 4).
        let v = serde_json::json!({
            "toolUseResult": { "stdout": "AWS_SECRET=hunter2" },
            "message": { "content": [{ "type": "tool_result", "content": "hunter2" }] }
        });
        assert_eq!(user_text(&v), None);
        let v = serde_json::json!({
            "toolUseResult": "postgres://user:pw@host/db",
            "message": { "content": [] }
        });
        assert_eq!(user_text(&v), None);
    }

    #[test]
    fn a_duration_is_never_zero_standing_in_for_unknown() {
        let base = ScannedTurn {
            turn_id: "t".into(),
            session_id: "s".into(),
            root_id: "local".into(),
            project_label: "p".into(),
            label: None,
            started_at_ms: 1_000,
            ended_at_ms: Some(4_000),
            cli_duration_ms: None,
            completed: true,
            had_prompt_id: true,
            requests: 0,
            tokens: TokenClasses::default(),
            high_context_requests: 0,
            tool_calls: 0,
            tool_errors: 0,
            files: BTreeSet::new(),
            interrupted: false,
            human_prompt: true,
            models: BTreeSet::new(),
            hourly: Vec::new(),
        };

        // The CLI's own number wins, and is labelled as such.
        let cli = ScannedTurn {
            cli_duration_ms: Some(1_868_388),
            ..base.clone()
        };
        assert_eq!(
            duration_of(&cli),
            (Some(1_868_388), Some(DurationSource::Cli))
        );

        // No CLI line, but the turn finished -> derived, labelled derived.
        assert_eq!(
            duration_of(&base),
            (Some(3_000), Some(DurationSource::Derived))
        );

        // Interrupted -> None, NEVER 0, and no source to claim.
        let interrupted = ScannedTurn {
            interrupted: true,
            ..base.clone()
        };
        assert_eq!(duration_of(&interrupted), (None, None));

        // Still running (no `end_turn`) -> None. Subtracting here would measure
        // "how long ago it started", which is not a duration.
        let running = ScannedTurn {
            completed: false,
            ..base.clone()
        };
        assert_eq!(duration_of(&running), (None, None));

        // An interrupted turn WITH a CLI duration still reports it: the CLI measured
        // the wall time it actually took, which is a fact, not an inference.
        let both = ScannedTurn {
            interrupted: true,
            cli_duration_ms: Some(5),
            ..base.clone()
        };
        assert_eq!(duration_of(&both), (Some(5), Some(DurationSource::Cli)));

        // No activity, or an undateable start -> None.
        let no_end = ScannedTurn {
            ended_at_ms: None,
            ..base.clone()
        };
        assert_eq!(duration_of(&no_end), (None, None));
        let no_start = ScannedTurn {
            started_at_ms: 0,
            ..base.clone()
        };
        assert_eq!(duration_of(&no_start), (None, None));
        // A negative CLI duration is not trusted at absorb time; here we pin that a
        // zero one is reported as measured rather than silently dropped.
        let zero = ScannedTurn {
            cli_duration_ms: Some(0),
            ..base
        };
        assert_eq!(duration_of(&zero), (Some(0), Some(DurationSource::Cli)));
    }

    #[test]
    fn hour_buckets_cover_the_window_and_clamp_at_both_ends() {
        let w = MetricsWindow {
            kind: MetricsWindowKind::Last24h,
            from_ms: 1_000_000,
            to_ms: 1_000_000 + DAY_MS,
        };
        assert_eq!(bucket_count(w), 24);
        assert_eq!(bucket_index(w.from_ms, w, 24), 0);
        assert_eq!(bucket_index(w.from_ms + HOUR_MS, w, 24), 1);
        // Exactly on the upper edge must land IN the last bucket, or the
        // Σ hourly == totals conservation property would fail for that one line.
        assert_eq!(bucket_index(w.to_ms, w, 24), 23);
        assert_eq!(bucket_index(w.to_ms + HOUR_MS, w, 24), 23, "clamped high");
        assert_eq!(bucket_index(w.from_ms - HOUR_MS, w, 24), 0, "clamped low");

        let week = MetricsWindow {
            kind: MetricsWindowKind::Last7d,
            from_ms: 0,
            to_ms: WEEK_MS,
        };
        assert_eq!(bucket_count(week), 168);
        // A degenerate window still yields one bucket rather than dividing by zero.
        let degenerate = MetricsWindow {
            kind: MetricsWindowKind::Last24h,
            from_ms: 5,
            to_ms: 5,
        };
        assert_eq!(bucket_count(degenerate), 1);
        assert_eq!(bucket_index(5, degenerate, 1), 0);
    }

    #[test]
    fn a_turn_belongs_to_the_window_of_its_end() {
        let w = MetricsWindow {
            kind: MetricsWindowKind::Last24h,
            from_ms: 1_000,
            to_ms: 2_000,
        };
        let mut turn = ScannedTurn {
            turn_id: "t".into(),
            session_id: "s".into(),
            root_id: "local".into(),
            project_label: "p".into(),
            label: None,
            started_at_ms: 500,
            ended_at_ms: Some(1_500),
            cli_duration_ms: None,
            completed: true,
            had_prompt_id: true,
            requests: 0,
            tokens: TokenClasses::default(),
            high_context_requests: 0,
            tool_calls: 0,
            tool_errors: 0,
            files: BTreeSet::new(),
            interrupted: false,
            human_prompt: true,
            models: BTreeSet::new(),
            hourly: Vec::new(),
        };
        assert!(
            in_window(&turn, w),
            "started before the window but ENDED inside it"
        );
        turn.ended_at_ms = Some(999);
        assert!(!in_window(&turn, w));
        turn.ended_at_ms = Some(2_001);
        assert!(!in_window(&turn, w));
        // No activity -> fall back to the start, so an unanswered prompt still counts.
        turn.ended_at_ms = None;
        turn.started_at_ms = 1_200;
        assert!(in_window(&turn, w));
    }

    #[test]
    fn the_window_span_is_the_name_on_the_tin() {
        assert_eq!(MetricsWindowKind::Last24h.span_ms(), 86_400_000);
        assert_eq!(MetricsWindowKind::Last7d.span_ms(), 604_800_000);
    }

    #[test]
    fn wire_enums_serialize_to_the_strings_metricstypes_ts_declares() {
        assert_eq!(
            serde_json::to_string(&MetricsWindowKind::Last24h).unwrap(),
            "\"last_24h\""
        );
        assert_eq!(
            serde_json::to_string(&MetricsWindowKind::Last7d).unwrap(),
            "\"last_7d\""
        );
        assert_eq!(
            serde_json::to_string(&MetricsScopeKind::Project).unwrap(),
            "\"project\""
        );
        assert_eq!(
            serde_json::to_string(&MetricsScopeKind::All).unwrap(),
            "\"all\""
        );
        // Deserialization matters as much: these arrive FROM the frontend, and a scope
        // that fails to deserialize would surface as a Tauri argument error rather than
        // as the dashboard.
        assert_eq!(
            serde_json::from_str::<MetricsScopeKind>("\"all\"").unwrap(),
            MetricsScopeKind::All
        );
        assert_eq!(
            serde_json::from_str::<MetricsScopeKind>("\"project\"").unwrap(),
            MetricsScopeKind::Project
        );
        assert_eq!(
            serde_json::to_string(&DurationSource::Cli).unwrap(),
            "\"cli\""
        );
        assert_eq!(
            serde_json::to_string(&DurationSource::Derived).unwrap(),
            "\"derived\""
        );
    }
}
