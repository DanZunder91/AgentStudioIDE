//! Tool calls → log events via the real `ClaudeAdapter` seam and `TranscriptToolTail`, over a
//! real-shaped fixture (`tests/fixtures/logstream/tool-calls/`, duplicated and torn lines too).
//! Hermetic: copied to a temp dir; nothing reads `~/.claude`.

use std::io::Write;
use std::path::{Path, PathBuf};

use agent_studio_scaffold_lib::agent::adapter::AgentAdapter;
use agent_studio_scaffold_lib::agent::claude::ClaudeAdapter;
use agent_studio_scaffold_lib::agent::fanout::TranscriptLocation;
use agent_studio_scaffold_lib::agent::tools::{ToolEvent, TranscriptToolTail};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/logstream/tool-calls")
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap().flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            std::fs::copy(&path, &target).unwrap();
        }
    }
}

/// The fixture laid out as `<project>/<session>.jsonl` + `<project>/<session>/subagents/`.
fn placed() -> TranscriptLocation {
    let dir = std::env::temp_dir().join(format!("logstream-tx-{}", ulid::Ulid::new()));
    let session = dir.join("sess");
    std::fs::create_dir_all(&session).unwrap();
    std::fs::copy(fixture().join("session.jsonl"), dir.join("sess.jsonl")).unwrap();
    copy_dir(&fixture().join("subagents"), &session.join("subagents"));
    TranscriptLocation {
        root_transcript: dir.join("sess.jsonl"),
        subagents_dir: session.join("subagents"),
    }
}

fn poll(
    adapter: &ClaudeAdapter,
    loc: &TranscriptLocation,
    tail: &mut TranscriptToolTail,
) -> Vec<ToolEvent> {
    let files = adapter.tool_transcripts(loc, &"root-1".to_string());
    tail.poll(&files, |l| adapter.parse_tool_line(l))
}

type Row<'a> = (&'a str, bool, bool, &'a str, Option<&'a str>);

fn rows(evs: &[ToolEvent]) -> Vec<Row<'_>> {
    evs.iter()
        .map(|e| {
            (
                e.agent_id.as_str(),
                e.is_result,
                e.is_error,
                e.text.as_str(),
                e.detail.as_deref(),
            )
        })
        .collect()
}

#[test]
fn the_fixture_yields_one_line_per_call_and_result_attributed_to_its_agent() {
    let adapter = ClaudeAdapter::new();
    let loc = placed();
    let files = adapter.tool_transcripts(&loc, &"root-1".to_string());
    assert_eq!(
        files.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>(),
        ["root-1", "sublog01"],
        "root first, then each sub-agent by its fan-out id"
    );

    let mut tail = TranscriptToolTail::new(0);
    let evs = poll(&adapter, &loc, &mut tail);
    let want: Vec<Row> = vec![
        (
            "root-1",
            false,
            false,
            "Bash: cargo test --lib",
            Some("Run the unit tests"),
        ),
        // A result's detail opens with the command that produced it: a bare output
        // read as a bash command returning 200 with the MongoDB log in it.
        (
            "root-1",
            true,
            false,
            "Bash → running 3 tests",
            Some("$ cargo test --lib\n\nrunning 3 tests\ntest a ... ok\ntest result: ok"),
        ),
        // Written twice by the CLI; logged once (dedupe by tool_use.id).
        ("root-1", false, false, "Read: /work/proj/src/lib.rs", None),
        // A non-shell result opens with its call's summary — even for one line of output.
        (
            "root-1",
            true,
            false,
            "Read → fn main() {}",
            Some("Read: /work/proj/src/lib.rs\n\nfn main() {}"),
        ),
        ("root-1", false, false, "Agent: Explore the parser", None),
        (
            "root-1",
            false,
            false,
            "WebFetch: https://example.test/doc",
            None,
        ),
        (
            "root-1",
            true,
            true,
            "WebFetch → Request failed with status 404",
            Some("WebFetch: https://example.test/doc\n\nRequest failed with status 404"),
        ),
        (
            "root-1",
            true,
            false,
            "Agent → done",
            Some("Agent: Explore the parser\n\ndone"),
        ),
        // Unknown-to-us tool: the bare name.
        ("root-1", false, false, "TodoWrite", None),
        // The sub-agent's own calls are ITS lines, not the root's.
        ("sublog01", false, false, "Grep: fn parse", None),
        (
            "sublog01",
            true,
            false,
            "Grep → src/a.rs:1:fn parse()",
            Some("Grep: fn parse\n\nsrc/a.rs:1:fn parse()"),
        ),
        ("sublog01", false, false, "Edit: /work/proj/src/a.rs", None),
        (
            "sublog01",
            true,
            false,
            "Edit → The file has been updated",
            Some("Edit: /work/proj/src/a.rs\n\nThe file has been updated"),
        ),
    ];
    assert_eq!(rows(&evs), want);
    // Transcript timestamps are carried (2026-09-20T10:00:01.000Z for the first call).
    assert_eq!(evs[0].ts_ms, Some(1_789_898_401_000));
    // Every line carries the transcript's tool-use id — a result the same as its call —
    // which is how the UI pairs them (`toolUseId`).
    assert_eq!(
        evs.iter()
            .map(|e| e.tool_use_id.as_str())
            .collect::<Vec<_>>(),
        [
            "toolu_log_01",
            "toolu_log_01",
            "toolu_log_02",
            "toolu_log_02",
            "toolu_log_03",
            "toolu_log_04",
            "toolu_log_04",
            "toolu_log_03",
            "toolu_log_05",
            "toolu_sub_01",
            "toolu_sub_01",
            "toolu_sub_02",
            "toolu_sub_02",
        ]
    );

    assert!(
        poll(&adapter, &loc, &mut tail).is_empty(),
        "a second poll with nothing appended emits nothing"
    );
}

#[test]
fn only_appended_lines_are_emitted_on_later_polls() {
    let adapter = ClaudeAdapter::new();
    let loc = placed();
    let mut tail = TranscriptToolTail::new(0);
    assert_eq!(poll(&adapter, &loc, &mut tail).len(), 13);

    let sub = loc.subagents_dir.join("agent-sublog01.jsonl");
    let mut f = std::fs::OpenOptions::new().append(true).open(&sub).unwrap();
    writeln!(
        f,
        r#"{{"type":"assistant","isSidechain":true,"agentId":"sublog01","timestamp":"2026-09-20T10:00:30.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_sub_03","name":"Bash","input":{{"command":"ls\nwc -l","description":"Count files"}}}}]}}}}"#
    )
    .unwrap();
    // A duplicate of an already-logged call, as a rewrite would produce.
    writeln!(
        f,
        r#"{{"type":"assistant","timestamp":"2026-09-20T10:00:31.000Z","message":{{"content":[{{"type":"tool_use","id":"toolu_sub_01","name":"Grep","input":{{"pattern":"fn parse"}}}}]}}}}"#
    )
    .unwrap();
    drop(f);

    let evs = poll(&adapter, &loc, &mut tail);
    assert_eq!(
        rows(&evs),
        vec![(
            "sublog01",
            false,
            false,
            "Bash: ls …",
            Some("Count files\n\nls\nwc -l")
        )],
        "a multi-line command shows its first line; the whole command is in detail"
    );

    // Its result opens with the WHOLE command, not the summary's first line.
    let mut f = std::fs::OpenOptions::new().append(true).open(&sub).unwrap();
    writeln!(
        f,
        r#"{{"type":"user","isSidechain":true,"agentId":"sublog01","timestamp":"2026-09-20T10:00:32.000Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_sub_03","content":"3"}}]}}}}"#
    )
    .unwrap();
    drop(f);
    let evs = poll(&adapter, &loc, &mut tail);
    assert_eq!(
        rows(&evs),
        vec![(
            "sublog01",
            true,
            false,
            "Bash → 3",
            Some("$ ls\nwc -l\n\n3")
        )]
    );
    assert_eq!(evs[0].tool_use_id, "toolu_sub_03");
}

#[test]
fn a_resumed_sessions_history_is_not_replayed() {
    let adapter = ClaudeAdapter::new();
    let loc = placed();
    // The tail started after every fixture timestamp (2026-09-20T10:00:xx).
    let mut tail = TranscriptToolTail::new(1_789_898_500_000);
    assert!(poll(&adapter, &loc, &mut tail).is_empty());
}

#[test]
fn lines_without_tool_blocks_or_that_are_torn_yield_nothing() {
    let adapter = ClaudeAdapter::new();
    assert!(adapter
        .parse_tool_line(r#"{"type":"user","message":{"content":"hi"}}"#)
        .is_empty());
    assert!(adapter
        .parse_tool_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"#)
        .is_empty());
    assert!(adapter.parse_tool_line("").is_empty());
}
