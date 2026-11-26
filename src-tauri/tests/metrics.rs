//! `claude_metrics` aggregation against committed fixtures, in `All` and `Project` scope
//! (narrowing excludes, widening includes, never prompt text). Hermetic: tempdir root, injected
//! clock, fixtures copied with set mtimes. Goldens are literals: redo the arithmetic by hand.

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use agent_studio_scaffold_lib::metrics::{
    self, DurationSource, Limits, MetricsReport, MetricsScopeKind, MetricsWindowKind, ScanRoot,
    TokenClasses, TOP_TURNS_CAP,
};

/// The cwd every fixture session ran in. Deliberately not a real home path — that is
/// what keeps the fixtures inside `fixtures_no_secrets.rs`'s denylist (`/Users/…` is
/// a hard-fail pattern there).
const CWD: &str = "/work/proj";

/// Injected "now": every fixture line sits on 2026-07-29 08:00–11:01, well inside a 24 h window.
const NOW_MS: i64 = 1_785_326_400_000; // 2026-07-29T12:00:00.000Z

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/transcripts")
}

fn temp_root(label: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("agentstudio-metrics-{label}-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&p).expect("tempdir");
    p
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("mkdir");
    for entry in std::fs::read_dir(from).expect("read_dir").flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_tree(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).expect("copy");
            set_mtime(&dst, NOW_MS);
        }
    }
}

/// Force a file's mtime to an exact epoch-ms instant, so the `mtime < from` bound is
/// under the test's control and not the filesystem's.
fn set_mtime(path: &Path, ms: i64) {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open for mtime");
    file.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64))
        .expect("set_modified");
}

/// Copy one committed fixture root into a tempdir and return its `projects` dir.
fn stage(fixture: &str) -> PathBuf {
    let dest = temp_root(fixture);
    copy_tree(&fixtures_root().join(fixture), &dest);
    dest.join("projects")
}

fn root_at(projects: PathBuf) -> ScanRoot {
    ScanRoot {
        id: "local".to_string(),
        label: "This machine".to_string(),
        projects_dir: projects,
    }
}

/// Scan one staged fixture in project scope over the last 24 h.
fn report_for(fixture: &str) -> MetricsReport {
    let root = root_at(stage(fixture));
    metrics::scan(
        &[root],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    )
}

/// Scan one staged fixture in **`All`** scope — the default — over the last 24 h.
fn all_report_for(fixture: &str) -> MetricsReport {
    let root = root_at(stage(fixture));
    metrics::scan(
        &[root],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::All,
        None,
        NOW_MS,
    )
}

/// Write an ad-hoc transcript into a fresh root — for the shapes that do not warrant
/// a committed fixture (a 26-turn file, an out-of-order file, a `promptId`-less one).
fn write_transcript(projects: &Path, project: &str, session: &str, lines: &[String]) -> PathBuf {
    let dir = projects.join(project);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join(format!("{session}.jsonl"));
    let mut body = lines.join("\n");
    body.push('\n');
    std::fs::write(&path, body).expect("write");
    set_mtime(&path, NOW_MS);
    path
}

/// A `promptId`-carrying human prompt line.
fn user_line(session: &str, prompt_id: &str, ts: &str, text: &str) -> String {
    serde_json::json!({
        "type": "user", "cwd": CWD, "sessionId": session,
        "promptId": prompt_id, "promptSource": "typed", "timestamp": ts,
        "message": { "role": "user", "content": text }
    })
    .to_string()
}

/// An assistant line with one `usage` object and an optional terminal stop.
fn assistant_line(session: &str, request: &str, ts: &str, output: u64, end: bool) -> String {
    serde_json::json!({
        "type": "assistant", "cwd": CWD, "sessionId": session, "requestId": request,
        "timestamp": ts,
        "message": {
            "id": format!("m-{request}"), "role": "assistant", "model": "claude-opus-5",
            "stop_reason": if end { "end_turn" } else { "tool_use" },
            "content": [{ "type": "text", "text": "ok" }],
            "usage": {
                "input_tokens": 1, "output_tokens": output,
                "cache_creation_input_tokens": 0, "cache_read_input_tokens": 10
            }
        }
    })
    .to_string()
}

// ===========================================================================
// (a) Hand-computed goldens
// ===========================================================================

/// Fixture 1 by hand: 3 requestIds over 4 assistant lines (`req-1` twice, same usage); in
/// 10+5+1=16, out 100+250+40=390, cw 200, cr 3000+4000+5000=12000, avgCtx 12216/3=4072;
/// tools Read+Edit=2, 1 error, 1 file changed (Edit only), 20500 ms from the CLI, 1 model.
#[test]
fn fixture_1_normal_turn_matches_the_hand_computed_golden() {
    let report = report_for("metrics-normal-turn");
    let t = &report.totals;

    assert_eq!(t.sessions, 1);
    assert_eq!(t.turns, 1);
    assert_eq!(t.human_turns, 1);
    assert_eq!(t.requests, 3, "3 requestIds across 4 assistant lines");
    assert_eq!(
        t.tokens,
        TokenClasses {
            fresh_input: 16,
            output: 390,
            cache_write: 200,
            cache_read: 12_000,
        }
    );
    assert_eq!(t.avg_context_per_request, Some(4072.0));
    assert_eq!(t.high_context_request_share, Some(0.0));
    assert_eq!(t.tool_calls, 2);
    assert_eq!(t.tool_errors, 1);
    assert_eq!(t.files_changed, 1);
    assert_eq!(t.time_in_turns_ms, 20_500);
    assert_eq!(t.turns_with_duration, 1);

    assert_eq!(report.top_turns.len(), 1);
    let turn = &report.top_turns[0];
    assert_eq!(turn.turn_id, "turn-n1");
    assert_eq!(turn.session_id, "sess-normal");
    assert_eq!(turn.root_id, "local");
    assert_eq!(
        turn.project_label, "proj",
        "basename of the cwd, never the path"
    );
    assert_eq!(turn.label.as_deref(), Some("add a metrics tab"));
    assert_eq!(turn.duration_ms, Some(20_500));
    assert_eq!(turn.duration_source, Some(DurationSource::Cli));
    assert_eq!(turn.requests, 3);
    assert_eq!(turn.tool_calls, 2);
    assert_eq!(turn.tool_errors, 1);
    assert_eq!(turn.files_changed, 1);
    assert!(!turn.interrupted);
    assert!(turn.human_prompt);
    assert_eq!(
        turn.models,
        vec!["claude-opus-5".to_string()],
        "claude-opus-5 and claude-opus-5[1m] are ONE model"
    );

    let c = &report.coverage;
    assert_eq!(c.roots_scanned, 1);
    assert!(c.roots_unavailable.is_empty());
    assert_eq!(c.files_considered, 1);
    assert_eq!(c.files_read, 1);
    assert_eq!(c.lines_unparseable, 0);
    assert_eq!(c.files_truncated, 0);
    assert_eq!(c.turns_without_cli_duration, 0);
    assert_eq!(c.turns_without_prompt_id, 0);
    assert!(!c.partial);
    assert!(c.bytes_read > 0, "the file really was streamed");
}

/// Fixture 3 by hand: 3 lines, 1 request; in 2, out 268, cw 14002, cr 21098, avgCtx 35102.
/// Disjoint blocks per line, so `toolCalls == 1` (dedupe must not eat line 2's `tool_use`).
/// No `turn_duration`: derived 11:00:03 − 11:00:00 = 3000 ms.
#[test]
fn fixture_3_cache_heavy_matches_the_hand_computed_golden() {
    let report = report_for("metrics-cache-heavy");
    let t = &report.totals;

    assert_eq!(t.requests, 1, "three lines, ONE request");
    assert_eq!(
        t.tokens,
        TokenClasses {
            fresh_input: 2,
            output: 268,
            cache_write: 14_002,
            cache_read: 21_098,
        }
    );
    assert_eq!(t.avg_context_per_request, Some(35_102.0));
    assert_eq!(
        t.tool_calls, 1,
        "the tool_use on the SECOND line of the request must survive the dedupe"
    );
    assert_eq!(t.files_changed, 0, "a Read is not a change");

    let turn = &report.top_turns[0];
    assert_eq!(turn.duration_ms, Some(3_000));
    assert_eq!(turn.duration_source, Some(DurationSource::Derived));
    assert_eq!(report.coverage.turns_without_cli_duration, 1);
    assert_eq!(t.time_in_turns_ms, 3_000);
}

// ===========================================================================
// (b) The differential test
// ===========================================================================

/// Fixture 1's naive per-line output sum (490, from an independent reader) exceeds the deduped
/// 390: every line of a request repeats its `usage`. Verified by mutating the dedupe guard.
#[test]
fn naive_per_line_sum_overcounts_because_one_request_writes_many_lines() {
    let deduped = report_for("metrics-normal-turn").totals.tokens.output;

    // An independent per-line sum, read straight off the committed fixture.
    let path = fixtures_root().join("metrics-normal-turn/projects/-work-proj/sess-normal.jsonl");
    let text = std::fs::read_to_string(&path).expect("fixture");
    let mut naive: u64 = 0;
    let mut assistant_lines = 0;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        assistant_lines += 1;
        naive += v["message"]["usage"]["output_tokens"].as_u64().unwrap_or(0);
    }

    assert_eq!(assistant_lines, 4, "4 assistant lines in the fixture");
    assert_eq!(naive, 490, "hand-computed: 100 + 100 + 250 + 40");
    assert_eq!(deduped, 390, "hand-computed: 100 + 250 + 40");
    assert!(
        deduped < naive,
        "the deduped sum MUST be strictly smaller — {deduped} vs {naive}"
    );
}

/// A request's lines carry disjoint content blocks, so dedupe must not drop lines; fixture 3's
/// only `tool_use` sits on the SECOND line.
#[test]
fn tool_use_blocks_are_counted_on_every_line_of_a_request() {
    let report = report_for("metrics-cache-heavy");
    assert_eq!(report.totals.requests, 1, "usage counted once");
    assert_eq!(
        report.totals.tool_calls, 1,
        "the tool_use on a later line of the same request is NOT a duplicate"
    );

    // …and a genuinely repeated block is still counted once: same tool_use.id on two
    // lines of two different requests.
    let projects = temp_root("dup-tooluse").join("projects");
    let dup = |request: &str, ts: &str| {
        serde_json::json!({
            "type": "assistant", "cwd": CWD, "sessionId": "s", "requestId": request,
            "timestamp": ts,
            "message": {
                "id": format!("m-{request}"), "role": "assistant", "model": "claude-opus-5",
                "stop_reason": "tool_use",
                "content": [{ "type": "tool_use", "id": "tu-same", "name": "Edit",
                              "input": { "file_path": "/work/proj/x.ts" } }],
                "usage": { "input_tokens": 1, "output_tokens": 1,
                           "cache_creation_input_tokens": 0, "cache_read_input_tokens": 1 }
            }
        })
        .to_string()
    };
    write_transcript(
        &projects,
        "-work-proj",
        "s",
        &[
            user_line("s", "p1", "2026-07-29T10:00:00.000Z", "go"),
            dup("r1", "2026-07-29T10:00:01.000Z"),
            dup("r2", "2026-07-29T10:00:02.000Z"),
        ],
    );
    let report = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(report.totals.requests, 2, "two distinct requests");
    assert_eq!(
        report.totals.tool_calls, 1,
        "one tool_use.id is one tool call, however many lines mention it"
    );
    assert_eq!(report.totals.files_changed, 1);
}

// ===========================================================================
// (c) Conservation properties
// ===========================================================================

#[test]
fn the_report_conserves_output_requests_and_per_root_totals() {
    // Every fixture, so a shape-specific accident cannot hide behind one that works.
    for fixture in [
        "metrics-normal-turn",
        "metrics-cache-heavy",
        "metrics-malformed",
        "metrics-interrupted",
        "metrics-rate-limit-event",
    ] {
        let r = report_for(fixture);
        assert!(
            r.totals.turns as usize <= TOP_TURNS_CAP,
            "{fixture}: the Σ topTurns identity only holds while every turn fits in \
             the table — this fixture must stay small"
        );

        let turn_output: u64 = r.top_turns.iter().map(|t| t.tokens.output).sum();
        assert_eq!(
            turn_output, r.totals.tokens.output,
            "{fixture}: Σ topTurns[].output must equal totals.output"
        );
        let hourly_requests: u64 = r.hourly.iter().map(|h| h.requests).sum();
        assert_eq!(
            hourly_requests, r.totals.requests,
            "{fixture}: Σ hourly[].requests must equal totals.requests"
        );
        let hourly_output: u64 = r.hourly.iter().map(|h| h.output).sum();
        assert_eq!(
            hourly_output, r.totals.tokens.output,
            "{fixture}: Σ hourly[].output"
        );
        let root_requests: u64 = r.per_root.iter().map(|p| p.requests).sum();
        assert_eq!(
            root_requests, r.totals.requests,
            "{fixture}: Σ perRoot[].requests must equal totals.requests"
        );
        let turn_requests: u64 = r.top_turns.iter().map(|t| t.requests).sum();
        assert_eq!(
            turn_requests, r.totals.requests,
            "{fixture}: Σ topTurns[].requests"
        );

        // files_changed is a UNION, not a sum — a file edited in three turns is one
        // file changed. So it is deliberately NOT conserved, only bounded.
        let turn_files: u64 = r.top_turns.iter().map(|t| t.files_changed).sum();
        assert!(
            r.totals.files_changed <= turn_files,
            "{fixture}: totals.filesChanged is a distinct-path union, so it can never \
             exceed the sum of the per-turn counts"
        );
        assert_eq!(
            r.hourly.len(),
            24,
            "{fixture}: a 24 h window has 24 buckets"
        );
    }
}

/// The union rule, with a witness: the SAME file edited in two turns is one file
/// changed overall, and one per turn.
#[test]
fn files_changed_is_a_union_of_paths_not_a_sum_of_turns() {
    let projects = temp_root("union").join("projects");
    let edit = |request: &str, ts: &str, tu: &str| {
        serde_json::json!({
            "type": "assistant", "cwd": CWD, "sessionId": "s", "requestId": request,
            "timestamp": ts,
            "message": {
                "id": format!("m-{request}"), "role": "assistant", "model": "claude-opus-5",
                "stop_reason": "end_turn",
                "content": [{ "type": "tool_use", "id": tu, "name": "Write",
                              "input": { "file_path": "/work/proj/same.ts" } }],
                "usage": { "input_tokens": 1, "output_tokens": 1,
                           "cache_creation_input_tokens": 0, "cache_read_input_tokens": 1 }
            }
        })
        .to_string()
    };
    write_transcript(
        &projects,
        "-work-proj",
        "s",
        &[
            user_line("s", "p1", "2026-07-29T10:00:00.000Z", "edit it"),
            edit("r1", "2026-07-29T10:00:01.000Z", "tu-1"),
            user_line("s", "p2", "2026-07-29T10:10:00.000Z", "edit it again"),
            edit("r2", "2026-07-29T10:10:01.000Z", "tu-2"),
        ],
    );
    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.totals.turns, 2);
    assert_eq!(
        r.top_turns.iter().map(|t| t.files_changed).sum::<u64>(),
        2,
        "each turn changed one file"
    );
    assert_eq!(r.totals.files_changed, 1, "…but it was the same file");
}

// ===========================================================================
// Fixture-specific behaviour
// ===========================================================================

/// Fixture 4: garbage line, string `toolUseResult`, no `timestamp`, truncated tail; none fatal.
/// unparseable 2, requests 2, in 3+1=4, out 7+2=9, cr 100+50=150, toolCalls 1 (Bash).
#[test]
fn fixture_4_malformed_lines_are_counted_and_never_fatal() {
    // The fixture's whole point is a final line with no terminator — assert that
    // before trusting anything the scan says about it.
    let raw = std::fs::read(
        fixtures_root().join("metrics-malformed/projects/-work-proj/sess-malformed.jsonl"),
    )
    .expect("fixture");
    assert_ne!(
        raw.last(),
        Some(&b'\n'),
        "fixture 4 must END mid-line; something normalized it"
    );

    let r = report_for("metrics-malformed");
    assert_eq!(r.coverage.lines_unparseable, 2);
    assert_eq!(r.totals.turns, 1);
    assert_eq!(r.totals.requests, 2);
    assert_eq!(
        r.totals.tokens,
        TokenClasses {
            fresh_input: 4,
            output: 9,
            cache_write: 0,
            cache_read: 150,
        }
    );
    assert_eq!(r.totals.tool_calls, 1);
    assert_eq!(r.totals.tool_errors, 0);
    assert!(
        !r.coverage.partial,
        "unparseable lines are not a partial scan"
    );

    // A `toolUseResult` — object or string — is COUNTED, NEVER QUOTED. The one
    // in this fixture reads "a bare string, not an object"; no field of the report
    // may contain any of it.
    let json = serde_json::to_string(&r).expect("serializable");
    assert!(
        !json.contains("a bare string"),
        "a toolUseResult must never reach the wire"
    );

    // The request on the line with NO timestamp still lands in a bucket, or the
    // hourly chart would not add up to its own headline.
    assert_eq!(r.hourly.iter().map(|h| h.requests).sum::<u64>(), 2);
}

/// Fixture 5: `turn-i1` interrupted → duration null (never 0), excluded; `turn-i2` 4000 ms.
/// timeInTurnsMs 4000, turnsWithDuration 1 of 2, output 60+30=90.
#[test]
fn fixture_5_an_interrupted_turn_has_a_null_duration_and_is_excluded_from_the_sum() {
    let r = report_for("metrics-interrupted");
    assert_eq!(r.totals.turns, 2);
    assert_eq!(r.totals.tokens.output, 90);

    let i1 = r
        .top_turns
        .iter()
        .find(|t| t.turn_id == "turn-i1")
        .expect("turn-i1");
    assert_eq!(i1.duration_ms, None, "null, NEVER 0 — unknown is not zero");
    assert_eq!(i1.duration_source, None);
    assert!(i1.interrupted);

    let i2 = r
        .top_turns
        .iter()
        .find(|t| t.turn_id == "turn-i2")
        .expect("turn-i2");
    assert_eq!(i2.duration_ms, Some(4_000));
    assert_eq!(i2.duration_source, Some(DurationSource::Derived));
    assert!(!i2.interrupted);

    assert_eq!(
        r.totals.time_in_turns_ms, 4_000,
        "the unknown duration contributes nothing, not zero-as-a-number"
    );
    assert_eq!(r.totals.turns_with_duration, 1);
    assert_eq!(r.coverage.turns_without_cli_duration, 2);
}

/// Fixture 6: a rate-limit line has no `timestamp`, so it is ignored without a panic or a
/// phantom turn.
#[test]
fn fixture_6_a_rate_limit_event_is_ignored_and_makes_no_phantom_turn() {
    let r = report_for("metrics-rate-limit-event");
    assert_eq!(r.totals.turns, 1, "one real turn, no phantom");
    assert_eq!(r.top_turns.len(), 1);
    assert_eq!(r.top_turns[0].turn_id, "turn-r1");
    assert_eq!(r.totals.requests, 1);
    assert_eq!(r.totals.tokens.output, 5);
    assert_eq!(r.top_turns[0].duration_ms, Some(2_000));
    assert_eq!(
        r.coverage.lines_unparseable, 0,
        "it is valid JSON, just unusable"
    );
}

// ===========================================================================
// The bounds (rule 3)
// ===========================================================================

/// `mtime < window.from ⇒ skip the file entirely` — the whole performance bound.
/// Sound because transcripts are append-only.
#[test]
fn a_file_untouched_since_before_the_window_is_skipped_entirely() {
    let projects = stage("metrics-normal-turn");
    let path = projects.join("-work-proj/sess-normal.jsonl");
    // Two days old: outside a 24 h window by a clear margin.
    set_mtime(&path, NOW_MS - 2 * 86_400_000);

    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.coverage.files_considered, 1, "we did stat it");
    assert_eq!(r.coverage.files_read, 0, "…and did not open it");
    assert_eq!(r.coverage.bytes_read, 0);
    assert_eq!(r.totals.turns, 0);
    assert!(!r.coverage.partial, "an out-of-window file is not a gap");

    // The same file IS read for a 7 d window — proving the skip is the window's
    // doing and not a broken path.
    let projects = stage("metrics-normal-turn");
    set_mtime(
        &projects.join("-work-proj/sess-normal.jsonl"),
        NOW_MS - 2 * 86_400_000,
    );
    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last7d,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.coverage.files_read, 1);
    assert_eq!(r.hourly.len(), 168, "a 7 d window has 168 hour buckets");
}

/// A per-file ceiling must set `partial` and count the file as truncated — never
/// report the smaller number as if it were the answer.
#[test]
fn the_per_file_ceiling_marks_the_report_partial_and_never_lies_about_it() {
    let projects = stage("metrics-normal-turn");
    let r = metrics::scan_with_limits(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
        // Enough for the prompt line and the first assistant line, not for the rest.
        Limits {
            per_file_bytes: 700,
            total_bytes: u64::MAX,
        },
    );
    assert_eq!(r.coverage.files_truncated, 1);
    assert!(r.coverage.partial, "a truncated scan MUST announce itself");
    assert!(
        r.totals.requests < 3,
        "the truncated scan really did see less — {} requests",
        r.totals.requests
    );
    assert!(r.coverage.bytes_read <= 700);
}

/// The global ceiling is global: once it is spent, later files are reported as
/// truncated rather than silently dropped.
#[test]
fn the_total_ceiling_is_global_across_files_and_reports_every_skip() {
    let projects = temp_root("global-cap").join("projects");
    for session in ["s1", "s2"] {
        write_transcript(
            &projects,
            "-work-proj",
            session,
            &[
                user_line(session, "p1", "2026-07-29T10:00:00.000Z", "go"),
                assistant_line(session, "r1", "2026-07-29T10:00:01.000Z", 5, true),
            ],
        );
    }
    let r = metrics::scan_with_limits(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
        Limits {
            per_file_bytes: u64::MAX,
            total_bytes: 1,
        },
    );
    assert_eq!(r.coverage.files_considered, 2);
    assert_eq!(
        r.coverage.files_truncated, 2,
        "both files hit the global budget — one truncated, one skipped outright"
    );
    assert!(r.coverage.partial);
}

/// Timestamps are **not** monotonic (a real file can hold dozens of lines out of order).
/// A forward scan is immune; a backward scan with a timestamp early-exit would
/// silently truncate. Totals must match the sorted equivalent exactly.
#[test]
fn out_of_order_timestamps_do_not_truncate_or_change_the_totals() {
    let ordered = [
        user_line("s", "p1", "2026-07-29T10:00:00.000Z", "go"),
        assistant_line("s", "r1", "2026-07-29T10:00:01.000Z", 10, false),
        assistant_line("s", "r2", "2026-07-29T10:00:02.000Z", 20, false),
        assistant_line("s", "r3", "2026-07-29T10:00:03.000Z", 30, true),
    ];
    // r2's timestamp goes BACKWARDS past r1's — the real corpus does this.
    let jumbled = [
        ordered[0].clone(),
        assistant_line("s", "r1", "2026-07-29T10:00:02.000Z", 10, false),
        assistant_line("s", "r2", "2026-07-29T10:00:01.000Z", 20, false),
        ordered[3].clone(),
    ];

    let run = |lines: &[String], label: &str| {
        let projects = temp_root(label).join("projects");
        write_transcript(&projects, "-work-proj", "s", lines);
        metrics::scan(
            &[root_at(projects)],
            MetricsWindowKind::Last24h,
            MetricsScopeKind::Project,
            Some(CWD),
            NOW_MS,
        )
    };
    let a = run(&ordered, "ordered");
    let b = run(&jumbled, "jumbled");

    assert_eq!(a.totals.requests, 3);
    assert_eq!(
        a.totals.tokens, b.totals.tokens,
        "totals must be order-blind"
    );
    assert_eq!(a.totals.requests, b.totals.requests);
    // The turn ends at its LATEST activity, not its last line — which is why
    // `touch` takes a max instead of overwriting.
    assert_eq!(a.top_turns[0].ended_at_ms, b.top_turns[0].ended_at_ms);
    assert_eq!(a.top_turns[0].duration_ms, b.top_turns[0].duration_ms);
}

// ===========================================================================
// `All` scope — the default, and the privacy rules that earn it
// ===========================================================================

/// Fixture 7, `All` scope: alpha (in 5, out 100, cw 0, cr 1000) + beta (7, 200, 50, 3000) →
/// sessions 2, turns 2, requests 2, in 12, out 300, cw 50, cr 4000, avgCtx 4062/2=2031,
/// toolCalls 1, files 1, durations 2000+5000=7000.
#[test]
fn all_scope_aggregates_every_project_directory_under_the_root() {
    let r = all_report_for("metrics-all-scope");
    let t = &r.totals;

    assert_eq!(t.sessions, 2, "both projects' sessions");
    assert_eq!(t.turns, 2);
    assert_eq!(t.human_turns, 2);
    assert_eq!(t.requests, 2);
    assert_eq!(
        t.tokens,
        TokenClasses {
            fresh_input: 12,
            output: 300,
            cache_write: 50,
            cache_read: 4_000,
        }
    );
    assert_eq!(t.avg_context_per_request, Some(2_031.0));
    assert_eq!(t.tool_calls, 1);
    assert_eq!(t.files_changed, 1);
    assert_eq!(t.time_in_turns_ms, 7_000);
    assert_eq!(t.turns_with_duration, 2);

    // Both files were opened: in `All` scope nothing bails on the cwd line, which is
    // exactly where the extra cost of the wider scope lives.
    assert_eq!(r.coverage.files_considered, 2);
    assert_eq!(r.coverage.files_read, 2);
    assert!(!r.coverage.partial);
    assert!(
        !r.coverage.scope_fell_back_to_all,
        "`All` was asked for directly — the report must not claim it answered a \
         different question than the one it was asked"
    );

    // The scope echo carries no cwd: there was none, and none narrowed anything.
    assert_eq!(r.scope.cwd, None);

    // Conservation still holds across projects, which is the property a merged total
    // most plausibly breaks.
    assert_eq!(
        r.top_turns.iter().map(|x| x.tokens.output).sum::<u64>(),
        t.tokens.output
    );
    assert_eq!(r.hourly.iter().map(|h| h.requests).sum::<u64>(), t.requests);
    assert_eq!(
        r.per_root.iter().map(|p| p.requests).sum::<u64>(),
        t.requests
    );

    // Each turn says WHICH project it came from — the only identification `All` scope
    // has, now that there is no prompt text.
    let mut labels: Vec<&str> = r
        .top_turns
        .iter()
        .map(|x| x.project_label.as_str())
        .collect();
    labels.sort_unstable();
    assert_eq!(labels, ["alpha", "beta"]);
}

/// Privacy rule 1, on the serialized JSON (the wire is what leaks): the fixture's prompt
/// strings appear in `Project` scope (so the sweep can see them) and never in `All`.
#[test]
fn no_prompt_text_reaches_the_wire_in_all_scope() {
    const ALPHA: &str = "ALPHA-PRIVATE-PROMPT";
    const BETA: &str = "BETA-PRIVATE-PROMPT";

    // Sanity first: in `Project` scope the label IS rendered, so a false green is
    // impossible — an empty-fixture sweep would pass the `All` assertions trivially.
    let root = root_at(stage("metrics-all-scope"));
    let scoped = metrics::scan(
        &[root],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some("/work/alpha"),
        NOW_MS,
    );
    let scoped_json = serde_json::to_string(&scoped).expect("serializable");
    assert!(
        scoped_json.contains(ALPHA),
        "the fixture must really carry the prompt text, or this test proves nothing"
    );
    assert!(
        !scoped_json.contains(BETA),
        "…and the other project's text must not be there even in project scope"
    );
    assert_eq!(
        scoped.top_turns[0].label.as_deref(),
        Some("ALPHA-PRIVATE-PROMPT summarize the parser")
    );

    // Now `All` scope: the numbers are all there, the text is not.
    let all = all_report_for("metrics-all-scope");
    assert_eq!(all.totals.turns, 2, "both turns counted");
    let json = serde_json::to_string(&all).expect("serializable");
    assert!(
        !json.contains(ALPHA),
        "one client's prompt beside another's numbers is a cross-workspace leak"
    );
    assert!(!json.contains(BETA));
    assert!(
        all.top_turns.iter().all(|t| t.label.is_none()),
        "every label is None BY RULE in All scope, not merely when text was absent"
    );
    // …and no absolute path either — basenames only (privacy rule 2).
    assert!(!json.contains("/work/alpha"));
    assert!(!json.contains("/work/beta"));
    assert!(json.contains("\"projectLabel\":\"alpha\""));
    assert!(json.contains("\"projectLabel\":\"beta\""));
}

/// `project_label` is a **basename**, never a path — in either scope, and even when the
/// cwd is deep. Asserted on the wire for the same reason as the rule above.
#[test]
fn project_label_is_a_basename_and_never_a_path() {
    let projects = temp_root("basename").join("projects");
    let deep = "/work/clients/acme-holdings/orders-api";
    let user = serde_json::json!({
        "type": "user", "cwd": deep, "sessionId": "s-deep", "promptId": "p1",
        "promptSource": "typed", "timestamp": "2026-07-29T10:00:00.000Z",
        "message": { "role": "user", "content": "go" }
    })
    .to_string();
    let asst = serde_json::json!({
        "type": "assistant", "cwd": deep, "sessionId": "s-deep", "requestId": "r1",
        "timestamp": "2026-07-29T10:00:01.000Z",
        "message": {
            "id": "m-r1", "role": "assistant", "model": "claude-opus-5",
            "stop_reason": "end_turn", "content": [{ "type": "text", "text": "ok" }],
            "usage": { "input_tokens": 1, "output_tokens": 1,
                       "cache_creation_input_tokens": 0, "cache_read_input_tokens": 1 }
        }
    })
    .to_string();
    write_transcript(
        &projects,
        "-work-clients-acme-holdings-orders-api",
        "s-deep",
        &[user, asst],
    );

    for (scope, cwd) in [
        (MetricsScopeKind::All, None),
        (MetricsScopeKind::Project, Some(deep)),
    ] {
        let r = metrics::scan(
            &[root_at(projects.clone())],
            MetricsWindowKind::Last24h,
            scope,
            cwd,
            NOW_MS,
        );
        assert_eq!(
            r.top_turns[0].project_label, "orders-api",
            "the last segment only"
        );
        // Assert on the turn rows' JSON: `scope.cwd` is different (echoes the caller's cwd in
        // `Project`, `None` in `All`).
        let turns_json = serde_json::to_string(&r.top_turns).expect("serializable");
        assert!(
            !turns_json.contains("/work/clients"),
            "no absolute path reaches a turn row, in any scope"
        );
        assert!(
            !turns_json.contains("acme-holdings"),
            "…and no intermediate segment either"
        );
    }

    // The echo rule itself, stated once: the caller's cwd comes back in `Project` scope
    // and is withheld in `All`.
    let scoped = metrics::scan(
        &[root_at(projects.clone())],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(deep),
        NOW_MS,
    );
    assert_eq!(scoped.scope.cwd.as_deref(), Some(deep));
    let all = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::All,
        None,
        NOW_MS,
    );
    assert_eq!(all.scope.cwd, None);
    assert!(!serde_json::to_string(&all)
        .expect("serializable")
        .contains("/work/clients"));
}

/// `MetricsButton` passes `null` when no agent is selected; `Project` with no cwd widens to
/// `All` and says so, rather than failing the scan.
#[test]
fn a_project_request_with_no_cwd_falls_back_to_all_instead_of_failing() {
    let root = root_at(stage("metrics-all-scope"));
    let r = metrics::scan(
        &[root],
        MetricsWindowKind::Last24h,
        // The exact argument pair the button produces with nothing selected.
        MetricsScopeKind::Project,
        None,
        NOW_MS,
    );

    // NUMBERS, not an error — and they are `All`'s numbers, over both projects.
    assert_eq!(r.totals.turns, 2);
    assert_eq!(r.totals.requests, 2);
    assert_eq!(r.totals.tokens.output, 300);

    // The report is honest about having answered a wider question than it was asked.
    assert!(r.coverage.scope_fell_back_to_all);
    assert!(
        !r.coverage.partial,
        "a fallback is not a gap — nothing was missed, MORE was seen"
    );
    assert_eq!(r.scope.cwd, None);

    // …and the fallback inherits `All`'s privacy rules, not `Project`'s.
    let json = serde_json::to_string(&r).expect("serializable");
    assert!(!json.contains("ALPHA-PRIVATE-PROMPT"));
    assert!(r.top_turns.iter().all(|t| t.label.is_none()));
}

/// A cwd handed to `All` scope narrows nothing and is not echoed — otherwise the panel
/// could label a machine-wide number with one project's name, which is the same class of
/// false claim as a summed token total.
#[test]
fn a_cwd_passed_in_all_scope_neither_filters_nor_appears() {
    let root = root_at(stage("metrics-all-scope"));
    let r = metrics::scan(
        &[root],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::All,
        Some("/work/alpha"),
        NOW_MS,
    );
    assert_eq!(r.totals.turns, 2, "beta is still counted");
    assert_eq!(r.scope.cwd, None, "…and alpha is not echoed as the scope");
    assert!(!r.coverage.scope_fell_back_to_all, "nothing fell back");
    assert!(!serde_json::to_string(&r)
        .expect("serializable")
        .contains("/work/alpha"));
}

// ===========================================================================
// Scope, empty states and degraded transcripts
// ===========================================================================

#[test]
fn another_projects_transcript_contributes_nothing_in_project_scope() {
    let projects = temp_root("scope").join("projects");
    // Same fixture shape, a different `cwd` — the transcript's OWN cwd is identity,
    // the mangled directory name is only a hint.
    let other = serde_json::json!({
        "type": "user", "cwd": "/work/other", "sessionId": "s-other",
        "promptId": "p-other", "promptSource": "typed",
        "timestamp": "2026-07-29T10:00:00.000Z",
        "message": { "role": "user", "content": "another client" }
    })
    .to_string();
    let other_asst = serde_json::json!({
        "type": "assistant", "cwd": "/work/other", "sessionId": "s-other",
        "requestId": "r-other", "timestamp": "2026-07-29T10:00:01.000Z",
        "message": {
            "id": "m-other", "role": "assistant", "model": "claude-opus-5",
            "stop_reason": "end_turn", "content": [{ "type": "text", "text": "x" }],
            "usage": { "input_tokens": 9, "output_tokens": 999,
                       "cache_creation_input_tokens": 0, "cache_read_input_tokens": 9 }
        }
    })
    .to_string();
    write_transcript(&projects, "-work-other", "s-other", &[other, other_asst]);
    write_transcript(
        &projects,
        "-work-proj",
        "s-mine",
        &[
            user_line("s-mine", "p-mine", "2026-07-29T10:00:00.000Z", "mine"),
            assistant_line("s-mine", "r-mine", "2026-07-29T10:00:01.000Z", 7, true),
        ],
    );

    let r = metrics::scan(
        &[root_at(projects.clone())],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.coverage.files_considered, 2, "both were stat'ed");
    assert_eq!(r.coverage.files_read, 1, "only ours was aggregated");
    assert_eq!(r.totals.tokens.output, 7, "999 belongs to another project");
    assert_eq!(r.totals.sessions, 1);
    // The other project's prompt text must not be anywhere on the wire.
    let json = serde_json::to_string(&r).expect("serializable");
    assert!(!json.contains("another client"));
    assert!(!json.contains("/work/other"));

    // In `All` scope both count, so the out-of-scope file is readable and the filter is the
    // scope's doing: narrowing excludes, widening includes.
    let all = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::All,
        None,
        NOW_MS,
    );
    assert_eq!(all.totals.tokens.output, 1006);
    assert_eq!(all.coverage.files_read, 2);
    // …but the widening does NOT carry the text with it (privacy rule 1).
    let all_json = serde_json::to_string(&all).expect("serializable");
    assert!(!all_json.contains("another client"));
    assert!(!all_json.contains("/work/other"));
    assert!(all.top_turns.iter().all(|t| t.label.is_none()));
}

#[test]
fn no_transcripts_is_a_normal_case_returning_an_empty_report() {
    // A machine that has never run `claude`: no `projects` dir at all.
    let root = root_at(temp_root("empty").join("projects"));
    let r = metrics::scan(
        &[root],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.totals.turns, 0);
    assert_eq!(r.totals.requests, 0);
    assert_eq!(r.totals.sessions, 0);
    assert_eq!(r.totals.tokens, TokenClasses::default());
    assert!(
        r.totals.avg_context_per_request.is_none(),
        "an average of nothing is null, not 0 — the panel must not print 0 k context"
    );
    assert!(r.totals.high_context_request_share.is_none());
    assert!(r.top_turns.is_empty());
    assert_eq!(
        r.hourly.len(),
        24,
        "the chart's axis exists even when empty"
    );
    assert_eq!(r.hourly.iter().map(|h| h.requests).sum::<u64>(), 0);
    // An unreadable root SAYS SO rather than silently shrinking the total.
    assert_eq!(
        r.coverage.roots_unavailable,
        vec!["This machine".to_string()]
    );
    assert!(r.coverage.partial);
    assert_eq!(r.per_root.len(), 1);
    assert!(!r.per_root[0].available);
    assert_eq!(r.window.to_ms - r.window.from_ms, 86_400_000);
}

/// Transcripts written before `promptId` existed: a qualifying user line
/// starts a turn, running to the next. Degraded — and counted as such, so the UI can
/// say the boundaries are inferred rather than read.
#[test]
fn a_transcript_with_no_prompt_id_falls_back_to_user_line_boundaries() {
    let projects = temp_root("nopromptid").join("projects");
    let bare_user = |ts: &str, text: &str| {
        serde_json::json!({
            "type": "user", "cwd": CWD, "sessionId": "s-old", "timestamp": ts,
            "message": { "role": "user", "content": text }
        })
        .to_string()
    };
    write_transcript(
        &projects,
        "-work-proj",
        "s-old",
        &[
            bare_user("2026-07-29T10:00:00.000Z", "first task"),
            assistant_line("s-old", "r1", "2026-07-29T10:00:01.000Z", 10, true),
            bare_user("2026-07-29T10:05:00.000Z", "second task"),
            assistant_line("s-old", "r2", "2026-07-29T10:05:01.000Z", 20, true),
        ],
    );
    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.totals.turns, 2, "two inferred boundaries");
    assert_eq!(r.totals.human_turns, 2);
    assert_eq!(r.totals.tokens.output, 30, "no tokens lost to the fallback");
    assert_eq!(
        r.coverage.turns_without_prompt_id, 2,
        "the degradation is reported, not hidden"
    );
    assert!(r.top_turns.iter().all(|t| t.turn_id.starts_with("s-old#")));
}

/// A sub-agent sidecar lives in `<session-id>/subagents/`. The scan counts ROOT
/// transcripts only — depth-1 files — which is what keeps a child's tokens from
/// being silently merged into a parent total instead of being labelled as the child's.
#[test]
fn subagent_sidecars_are_not_counted_as_root_sessions() {
    let projects = temp_root("sidecar").join("projects");
    write_transcript(
        &projects,
        "-work-proj",
        "s-parent",
        &[
            user_line("s-parent", "p1", "2026-07-29T10:00:00.000Z", "fan out"),
            assistant_line("s-parent", "r1", "2026-07-29T10:00:01.000Z", 11, true),
        ],
    );
    let sidecar_dir = projects.join("-work-proj/s-parent/subagents");
    std::fs::create_dir_all(&sidecar_dir).expect("mkdir");
    std::fs::write(
        sidecar_dir.join("agent-abc.jsonl"),
        format!(
            "{}\n",
            assistant_line(
                "agent-abc",
                "r-child",
                "2026-07-29T10:00:02.000Z",
                5000,
                true
            )
        ),
    )
    .expect("write");

    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(
        r.coverage.files_read, 1,
        "the sidecar is not a root transcript"
    );
    assert_eq!(
        r.totals.tokens.output, 11,
        "the child's 5000 output is the child's to attribute, not the parent's to merge"
    );
}

/// An assistant line before any prompt (resumed transcript) keeps its tokens via a fallback
/// turn counted in `turnsWithoutPromptId`.
#[test]
fn an_assistant_line_with_no_open_turn_gets_a_fallback_turn_rather_than_vanishing() {
    let projects = temp_root("headless").join("projects");
    write_transcript(
        &projects,
        "-work-proj",
        "s-head",
        &[assistant_line(
            "s-head",
            "r1",
            "2026-07-29T10:00:01.000Z",
            42,
            true,
        )],
    );
    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.totals.turns, 1);
    assert_eq!(r.totals.human_turns, 0, "nobody typed it");
    assert_eq!(r.totals.tokens.output, 42);
    assert_eq!(r.top_turns[0].turn_id, "s-head#0");
    assert_eq!(r.top_turns[0].label, None, "no user text, so no label");
    assert_eq!(r.coverage.turns_without_prompt_id, 1);
}

/// The table is a "which turns dominated" list, not a log. It is capped, ranked by
/// context volume, and `totals.turns` still reports the true count so the UI can say
/// "top N of M" instead of implying the list is complete.
#[test]
fn top_turns_is_capped_and_ranked_by_cache_read_while_totals_stay_complete() {
    let projects = temp_root("cap").join("projects");
    let mut lines = Vec::new();
    let n = TOP_TURNS_CAP + 5;
    for i in 0..n {
        let ts = format!("2026-07-29T10:{:02}:00.000Z", i);
        let ats = format!("2026-07-29T10:{:02}:01.000Z", i);
        lines.push(user_line("s", &format!("p{i}"), &ts, "go"));
        // cache_read climbs with i, so the ranking is knowable in advance.
        lines.push(
            serde_json::json!({
                "type": "assistant", "cwd": CWD, "sessionId": "s",
                "requestId": format!("r{i}"), "timestamp": ats,
                "message": {
                    "id": format!("m{i}"), "role": "assistant", "model": "claude-opus-5",
                    "stop_reason": "end_turn", "content": [{ "type": "text", "text": "ok" }],
                    "usage": { "input_tokens": 1, "output_tokens": 1,
                               "cache_creation_input_tokens": 0,
                               "cache_read_input_tokens": 100 + i }
                }
            })
            .to_string(),
        );
    }
    write_transcript(&projects, "-work-proj", "s", &lines);

    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.totals.turns as usize, n, "every turn is in the totals");
    assert_eq!(
        r.top_turns.len(),
        TOP_TURNS_CAP,
        "only the top N are listed"
    );
    // Ranked cache-read descending, so the biggest turn is the last one written.
    assert_eq!(r.top_turns[0].turn_id, format!("p{}", n - 1));
    let reads: Vec<u64> = r.top_turns.iter().map(|t| t.tokens.cache_read).collect();
    let mut sorted = reads.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(reads, sorted, "the table must be sorted, deterministically");
    // …and the Σ identity is knowingly NOT available once the cap bites — the UI
    // must read totals, never the sum of the table.
    let listed: u64 = r.top_turns.iter().map(|t| t.requests).sum();
    assert!(listed < r.totals.requests);
}

/// The CLI's own `>150k` threshold, adopted and attributed.
#[test]
fn the_high_context_share_uses_the_clis_own_150k_threshold() {
    let projects = temp_root("highctx").join("projects");
    let req = |request: &str, ts: &str, cache_read: u64| {
        serde_json::json!({
            "type": "assistant", "cwd": CWD, "sessionId": "s", "requestId": request,
            "timestamp": ts,
            "message": {
                "id": format!("m-{request}"), "role": "assistant", "model": "claude-opus-5",
                "stop_reason": "end_turn", "content": [{ "type": "text", "text": "ok" }],
                "usage": { "input_tokens": 0, "output_tokens": 1,
                           "cache_creation_input_tokens": 0,
                           "cache_read_input_tokens": cache_read }
            }
        })
        .to_string()
    };
    write_transcript(
        &projects,
        "-work-proj",
        "s",
        &[
            user_line("s", "p1", "2026-07-29T10:00:00.000Z", "go"),
            req("r1", "2026-07-29T10:00:01.000Z", 149_999),
            req("r2", "2026-07-29T10:00:02.000Z", 150_000),
            req("r3", "2026-07-29T10:00:03.000Z", 400_000),
            req("r4", "2026-07-29T10:00:04.000Z", 10),
        ],
    );
    let r = metrics::scan(
        &[root_at(projects)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        NOW_MS,
    );
    assert_eq!(r.totals.requests, 4);
    // 150,000 is already "at 150k" — inclusive, because these are "you have crossed
    // this line" readings.
    assert_eq!(r.totals.high_context_request_share, Some(0.5));
}

// ===========================================================================
// The live smoke — #[ignore]d so `cargo test` stays hermetic
// ===========================================================================

/// Real scanner over the real `~/.claude` in `All` scope, invariants only; run by hand with
/// `cargo test --test metrics -- --ignored --nocapture`. Assistant lines are counted by an
/// independent reader, so `requests <= assistant lines` is not self-agreement.
#[test]
#[ignore = "reads the developer's real ~/.claude; run by hand"]
fn live_smoke_over_the_real_home() {
    let home = agent_studio_scaffold_lib::agent::claude::home_dir().expect("a home directory");
    let root = ScanRoot::local(&home);
    if !root.projects_dir.is_dir() {
        eprintln!("no ~/.claude/projects on this machine — nothing to smoke");
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;

    // 7 d first and 24 h second is deliberate: it means the 24 h timing printed below
    // cannot be flattered by the page cache the 7 d sweep just warmed.
    let week = metrics::scan(
        std::slice::from_ref(&root),
        MetricsWindowKind::Last7d,
        MetricsScopeKind::All,
        None,
        now,
    );
    eprintln!(
        "live 7d  ALL: {} files considered / {} read / {} bytes / {} ms | {} turns, \
         {} requests, {} sessions, avg context {:?}, partial {}",
        week.coverage.files_considered,
        week.coverage.files_read,
        week.coverage.bytes_read,
        week.coverage.scan_ms,
        week.totals.turns,
        week.totals.requests,
        week.totals.sessions,
        week.totals.avg_context_per_request,
        week.coverage.partial,
    );
    assert_eq!(week.hourly.len(), 168);
    assert_eq!(
        week.hourly.iter().map(|h| h.requests).sum::<u64>(),
        week.totals.requests
    );

    let r = metrics::scan(
        std::slice::from_ref(&root),
        MetricsWindowKind::Last24h,
        MetricsScopeKind::All,
        None,
        now,
    );

    eprintln!(
        "live 24h ALL: {} files considered / {} read / {} bytes / {} ms | {} turns, \
         {} requests, {} sessions, avg context {:?}, partial {}",
        r.coverage.files_considered,
        r.coverage.files_read,
        r.coverage.bytes_read,
        r.coverage.scan_ms,
        r.totals.turns,
        r.totals.requests,
        r.totals.sessions,
        r.totals.avg_context_per_request,
        r.coverage.partial,
    );

    // The wider window can only see MORE — a monotonicity that would catch a scope or
    // window filter accidentally inverted.
    assert!(week.totals.requests >= r.totals.requests);
    assert!(week.coverage.files_read >= r.coverage.files_read);

    // 🔴 The privacy rule, on the developer's REAL corpus: not one prompt from any repo
    // on this machine may be on the wire in `All` scope. This is the assertion that would
    // catch the rule holding on a fixture and failing on a shape only real data has.
    for report in [&week, &r] {
        assert!(
            report.top_turns.iter().all(|t| t.label.is_none()),
            "a real prompt reached the wire in All scope"
        );
        let json = serde_json::to_string(report).expect("serializable");
        assert!(
            !json.contains("/Users/"),
            "an absolute home path reached the wire — basenames only"
        );
    }

    // Non-negativity is structural (u64), so the real invariants are relational.
    assert_eq!(r.hourly.len(), 24);
    assert_eq!(
        r.hourly.iter().map(|h| h.requests).sum::<u64>(),
        r.totals.requests,
        "conservation must hold on real data too"
    );
    assert!(r.coverage.files_read <= r.coverage.files_considered);
    assert!(r.totals.human_turns <= r.totals.turns);
    assert!(r.totals.turns_with_duration <= r.totals.turns);
    assert!(r.top_turns.len() <= TOP_TURNS_CAP);
    if r.totals.requests > 0 {
        assert!(r.totals.avg_context_per_request.unwrap_or(0.0) > 0.0);
        assert!(r.totals.high_context_request_share.unwrap_or(-1.0) >= 0.0);
        assert!(r.totals.high_context_request_share.unwrap_or(2.0) <= 1.0);
    }

    // requests <= assistant lines, counted independently of the code under test.
    let mut assistant_lines: u64 = 0;
    for project in std::fs::read_dir(&root.projects_dir)
        .expect("projects")
        .flatten()
    {
        if !project.path().is_dir() {
            continue;
        }
        for f in std::fs::read_dir(project.path())
            .expect("project")
            .flatten()
        {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") || !p.is_file() {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if mtime < now - 86_400_000 {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            assistant_lines += text
                .lines()
                .filter(|l| l.contains("\"type\":\"assistant\""))
                .count() as u64;
        }
    }
    assert!(
        r.totals.requests <= assistant_lines,
        "requests ({}) must never exceed assistant lines ({assistant_lines}) — a \
         per-line sum is exactly what that would mean",
        r.totals.requests
    );
}
