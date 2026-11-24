//! `locate_subagent_transcript` + the `subagent_activity` command end-to-end:
//! find `agent-<id>.jsonl` under `~/.claude/projects/*/*/subagents/` by
//! agent id, and return an empty feed for an unknown id.
//!
//! Own binary (sets `HOME`, process-global) to redirect the search at a temp tree.

mod common;

use std::sync::Mutex;

use agent_studio_scaffold_lib::agent::claude::{locate_subagent_transcript, subagent_activity};

// Serialize the HOME-mutating tests in this binary.
static HOME_LOCK: Mutex<()> = Mutex::new(());

fn set_home() -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("agentstudio-sublocate-{}", ulid::Ulid::new()));
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    home
}

/// A sub-agent transcript is found by its agent id, wherever its session dir is.
#[test]
fn locates_a_subagent_by_its_agent_id() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    // ~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl
    let agent = "a0b155767ba22b5f7";
    let subagents = home.join(".claude/projects/-work-proj/cafe-session/subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    let file = subagents.join(format!("agent-{agent}.jsonl"));
    std::fs::write(
        &file,
        "{\"type\":\"user\",\"timestamp\":\"2026-07-17T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n",
    )
    .unwrap();

    let located = locate_subagent_transcript(agent);
    // And the command reads it through to an activity feed.
    let feed = subagent_activity(agent.to_string());
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(
        located.as_deref(),
        Some(file.as_path()),
        "must locate by agent id"
    );
    assert_eq!(feed.len(), 1);
    assert_eq!(feed[0].role, "user");
    assert_eq!(feed[0].text, "go");
}

/// **A workflow sub-agent's transcript is one level deeper, and must be found too.**
///
/// `subagents/` is not flat: a `Workflow` run writes its sub-agents into
/// `subagents/workflows/wf_<runId>/` (on a machine that uses workflows, a large share
/// of all sidecars). The fan-out tree now shows those agents, so a lookup that searched
/// only the flat dir would put a row in the rail that opens to nothing — the same
/// bug one layer up.
#[test]
fn locates_a_workflow_subagent_nested_under_its_run_dir() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    // ~/.claude/projects/<project>/<session>/subagents/workflows/wf_<run>/agent-<id>.jsonl
    let agent = "a28391d13009f359a";
    let run =
        home.join(".claude/projects/-work-proj/cafe-session/subagents/workflows/wf_abc1234-def");
    std::fs::create_dir_all(&run).unwrap();
    // A decoy at the flat level, so "found something" can't pass by accident.
    std::fs::create_dir_all(home.join(".claude/projects/-work-proj/cafe-session/subagents"))
        .unwrap();
    let file = run.join(format!("agent-{agent}.jsonl"));
    std::fs::write(
        &file,
        "{\"type\":\"user\",\"timestamp\":\"2026-07-31T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"map the module\"}}\n",
    )
    .unwrap();

    let located = locate_subagent_transcript(agent);
    let feed = subagent_activity(agent.to_string());
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(
        located.as_deref(),
        Some(file.as_path()),
        "a workflow sub-agent must be located inside its run dir"
    );
    assert_eq!(feed.len(), 1, "and its activity feed must read through");
    assert_eq!(feed[0].text, "map the module");
}

/// **An unknown agent id returns an empty feed, never an error.**
#[test]
fn an_unknown_agent_id_returns_an_empty_feed() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();
    std::fs::create_dir_all(home.join(".claude/projects")).unwrap();

    let located = locate_subagent_transcript("a-nonexistent-agent-id");
    let feed = subagent_activity("a-nonexistent-agent-id".to_string());
    std::fs::remove_dir_all(&home).ok();

    assert!(located.is_none(), "an unknown id must not locate");
    assert!(
        feed.is_empty(),
        "an unknown id must return an empty feed, not error"
    );
}

/// A crafted id with path separators can't escape the projects tree.
#[test]
fn a_malicious_id_is_rejected() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();
    std::fs::create_dir_all(home.join(".claude/projects")).unwrap();

    for bad in ["../../etc/passwd", "a/b", "a.jsonl", ""] {
        assert!(
            locate_subagent_transcript(bad).is_none(),
            "a non-bare id {bad:?} must be rejected"
        );
    }
    std::fs::remove_dir_all(&home).ok();
}
