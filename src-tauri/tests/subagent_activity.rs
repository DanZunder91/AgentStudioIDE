//! The sub-agent activity parser (a sub-agent has no PTY; selecting it shows this feed) against a
//! hand-built structural fixture: synthetic, no prose or secrets, covered by `fixtures_no_secrets`.
//! Parsing takes an explicit path, so no `~/.claude` or real `claude` is involved.

use std::path::PathBuf;

use agent_studio_scaffold_lib::agent::claude::parse_subagent_activity;
use agent_studio_scaffold_lib::model::ActivityEntry;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/transcripts/subagent-activity/agent-fixture.jsonl")
}

/// **The feed reconstructs roles in chronological order**, surfacing a `tool_use`
/// with its name, and dropping `thinking`/`attachment` noise.
#[test]
fn parses_roles_in_order_and_surfaces_tool_use() {
    let feed = parse_subagent_activity(&fixture());

    // The expected sequence of (role, tool) — noise (thinking, attachment) skipped.
    let shape: Vec<(&str, Option<&str>)> = feed
        .iter()
        .map(|e| (e.role.as_str(), e.tool.as_deref()))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("user", None),              // 1. the prompt
            ("assistant", None),         // 2a. assistant text
            ("tool", Some("Read")),      // 2b. tool_use, name surfaced
            ("tool_result", None),       // 3. tool_result
            ("assistant", None),         // 4. final text (thinking skipped)
            ("assistant", None),         // 6. the long text (attachment @5 skipped)
            ("tool", Some("TodoWrite")), // 7. tool_use with no salient field
        ],
        "wrong role/tool sequence"
    );

    // The prompt text is preserved.
    assert_eq!(feed[0].text, "Explore the layout module");
    // The Read tool_use surfaces its salient input (the file path), not raw JSON.
    assert_eq!(feed[2].text, "/work/proj/a.ts");
    // The tool_result surfaces its content.
    assert!(feed[3].text.contains("file body"));
    // A tool_use with no salient field falls back to compact JSON of the input.
    assert!(
        feed[6].text.contains("count"),
        "fallback summary should include the input"
    );

    // The `attachment` line (which HAS a text block) is dropped whole — its content
    // must not appear anywhere in the feed.
    assert!(
        feed.iter().all(|e| !e.text.contains("ATTACHMENT-NOISE")),
        "attachment noise must be skipped, not surfaced"
    );
}

/// **Timestamps parse to epoch milliseconds, chronologically increasing.** The feed
/// order is file order; the timestamps are for display/sorting.
#[test]
fn timestamps_are_epoch_millis_in_order() {
    let feed = parse_subagent_activity(&fixture());
    // 2026-07-17T05:51:45.100Z — a sane, positive epoch-ms value.
    assert!(
        feed[0].timestamp > 1_700_000_000_000,
        "timestamp not epoch-ms: {}",
        feed[0].timestamp
    );
    for pair in feed.windows(2) {
        assert!(
            pair[1].timestamp >= pair[0].timestamp,
            "timestamps must be non-decreasing: {} then {}",
            pair[0].timestamp,
            pair[1].timestamp
        );
    }
    // The first entry's exact ms (2026-07-17T05:51:45.100Z).
    assert_eq!(feed[0].timestamp, 1_784_267_505_100);
}

/// **Long text is truncated (~2 KB).** The fixture's 3000-char entry must be capped.
#[test]
fn long_text_is_truncated() {
    let feed = parse_subagent_activity(&fixture());
    let long = &feed[5]; // the 3000-'X' assistant text
    assert!(
        long.text.len() <= 2048 + 4,
        "text must be capped ~2KB, got {}",
        long.text.len()
    );
    assert!(
        long.text.ends_with('…'),
        "a truncated entry should be marked with …"
    );
    assert!(long.text.starts_with("XXX"));
}

/// A missing / not-yet-written transcript is an **empty feed, never an error** (the
/// sub-agent may have just spawned).
#[test]
fn a_missing_transcript_reads_as_empty() {
    let feed = parse_subagent_activity(&PathBuf::from("/definitely/not/here/agent-x.jsonl"));
    assert!(feed.is_empty());
}

/// A transcript with a truncated final line (a live file mid-write) still parses the
/// complete lines before it.
#[test]
fn a_truncated_final_line_does_not_break_the_feed() {
    let dir = std::env::temp_dir().join(format!("agentstudio-activity-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("agent-x.jsonl");
    std::fs::write(
        &path,
        "{\"type\":\"user\",\"timestamp\":\"2026-07-17T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n\
         {\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tex",
    )
    .unwrap();

    let feed = parse_subagent_activity(&path);
    std::fs::remove_dir_all(&dir).ok();

    assert_eq!(
        feed.len(),
        1,
        "the one complete line survives the truncated tail"
    );
    assert_eq!(feed[0].role, "user");
}

/// The wire shape matches `types.ts`: camelCase, `tool` omitted when absent.
#[test]
fn activity_entry_serializes_to_the_ts_shape() {
    let with_tool = ActivityEntry {
        role: "tool".into(),
        text: "ls".into(),
        tool: Some("Bash".into()),
        timestamp: 1_784_267_505_100,
    };
    let v = serde_json::to_value(&with_tool).unwrap();
    assert_eq!(v["role"], "tool");
    assert_eq!(v["tool"], "Bash");
    assert_eq!(v["timestamp"], 1_784_267_505_100i64);

    let no_tool = ActivityEntry {
        role: "user".into(),
        text: "hi".into(),
        tool: None,
        timestamp: 0,
    };
    let v = serde_json::to_value(&no_tool).unwrap();
    assert!(
        v.get("tool").is_none(),
        "tool must be omitted when None (TS `tool?`)"
    );
}
