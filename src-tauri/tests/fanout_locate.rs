//! `locate_transcript` must find a session by its `<id>/` directory, not only `<id>.jsonl`:
//! a running `claude` writes sidecars before any root `.jsonl` (measured), so the depth-1 tree
//! comes from the sidecars. Own binary: it sets the process-global `HOME`.

mod common;

use std::sync::Mutex;

use agent_studio_scaffold_lib::agent::claude::{locate_transcript, parse_fanout};

// These tests mutate the process-global `HOME`; serialize them (they're synchronous,
// so holding the guard for the whole body is fine — no await points) so parallel
// runs in this binary don't clobber each other's `HOME`.
static HOME_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn locate_finds_a_session_by_its_directory_when_the_root_jsonl_is_absent() {
    let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = std::env::temp_dir().join(format!("agentstudio-locate-{}", ulid::Ulid::new()));
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let session = "019f0000-0000-7000-8000-000000000abc";
    // Create ONLY `<project>/<session>/subagents/*.meta.json` — NO `<session>.jsonl`.
    let project = home.join(".claude/projects/-work-proj");
    let subagents = project.join(session).join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    for (n, agent) in ["aaaa", "bbbb"].iter().enumerate() {
        std::fs::write(
            subagents.join(format!("agent-{agent}.meta.json")),
            format!(
                r#"{{"agentType":"Explore","description":"d{n}","toolUseId":"t{agent}","spawnDepth":1}}"#
            ),
        )
        .unwrap();
    }
    let root_jsonl = project.join(format!("{session}.jsonl"));
    assert!(
        !root_jsonl.exists(),
        "the test must have NO root transcript"
    );

    // locate must still succeed, anchored on the `<session>/` directory.
    let loc = locate_transcript(session).expect("locate must find the session by its directory");
    assert_eq!(
        loc.subagents_dir, subagents,
        "subagents_dir must point at the real dir"
    );
    assert!(
        !loc.root_transcript.exists(),
        "the root path is returned but does not exist"
    );

    // …and parse reconstructs the two depth-1 agents from the sidecars alone.
    let result = parse_fanout(&loc.root_transcript, &loc.subagents_dir, "root-agent");
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(
        result.agents.len(),
        2,
        "both sub-agents must be reconstructed"
    );
    for a in &result.agents {
        assert_eq!(
            a.parent_id, "root-agent",
            "depth-1 ⇒ parent is the passed root id"
        );
        assert_eq!(a.spawn_depth, Some(1));
    }
}

/// A session that exists **only** as a root `<id>.jsonl` (no `subagents/` dir yet)
/// also locates — the other partial-state ordering. `parse` yields no sub-agents,
/// which is correct (none spawned yet).
#[test]
fn locate_finds_a_session_with_only_the_root_jsonl_and_no_subagents_dir() {
    let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = std::env::temp_dir().join(format!("agentstudio-locate2-{}", ulid::Ulid::new()));
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let session = "019f0000-0000-7000-8000-000000000def";
    let project = home.join(".claude/projects/-work-proj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join(format!("{session}.jsonl")), "{}\n").unwrap();

    let loc = locate_transcript(session).expect("locate must find a root-only session");
    assert!(loc.root_transcript.is_file());
    let result = parse_fanout(&loc.root_transcript, &loc.subagents_dir, "root");
    std::fs::remove_dir_all(&home).ok();
    assert!(
        result.agents.is_empty(),
        "no subagents dir ⇒ no sub-agents (correct)"
    );
}

/// A session id present in no project dir still returns `None` (no false locate).
#[test]
fn locate_returns_none_for_an_unknown_session() {
    let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = std::env::temp_dir().join(format!("agentstudio-locate3-{}", ulid::Ulid::new()));
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::fs::create_dir_all(home.join(".claude/projects")).unwrap();

    let got = locate_transcript("019f0000-0000-7000-8000-nonexistent0");
    std::fs::remove_dir_all(&home).ok();
    assert!(got.is_none(), "an unknown session must not locate");
}
