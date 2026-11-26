//! Production order: spawn → tailer starts → `<session>.jsonl` appears seconds later. The
//! tailer must be selected by the spawned runtime, not by the transcript existing; the
//! `StubAdapter` (id ≠ the Claude constant) fails against selection by existence.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::model::AgentEvent;
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor, AgentSpawnSpec, SupervisorHandle};
use common::{ChannelSink, RecordingSink, StubAdapter};

fn copy_subagents(fixture: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for e in std::fs::read_dir(fixture.join("subagents"))
        .unwrap()
        .flatten()
    {
        std::fs::copy(e.path(), dst.join(e.file_name())).unwrap();
    }
}

async fn wait_for_agents(sup: &SupervisorHandle, n: usize) {
    let start = Instant::now();
    loop {
        let count = sup.snapshot().await.unwrap().agents.len();
        if count >= n {
            return;
        }
        if start.elapsed() > Duration::from_secs(10) {
            panic!(
                "timed out: {count} agents, want {n} — the tailer never delivered the sub-agents"
            );
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// **The regression: a spawned agent whose transcript appears AFTER spawn still
/// gets its sub-agents.** Fails against the old `locate`-based selection; passes
/// with runtime-id selection.
#[tokio::test]
async fn a_spawned_agent_gets_subagents_when_the_transcript_appears_later() {
    let home = std::env::temp_dir().join(format!("agentstudio-prodorder-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    let adapter = Arc::new(StubAdapter::interactive());
    let sink = RecordingSink::new();
    let sup = spawn_supervisor(Arc::new(sink.clone()), vec![adapter.clone()], None);

    // ── Spawn FIRST. The transcript does NOT exist yet — production order. ──
    let agent_id = format!("root-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: agent_id.clone(),
            runtime: "stub-runtime".into(),
            cwd: home.to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
            prompt: None,
            resume_session_id: None,
        },
        channel,
    )
    .await
    .expect("agent_spawn failed");

    let session = adapter
        .minted_keys()
        .first()
        .cloned()
        .expect("session key minted");
    assert_eq!(
        sup.snapshot().await.unwrap().agents.len(),
        1,
        "just the root before the transcript"
    );

    // ── The runtime writes its transcript + sub-agents a moment later. ──
    tokio::time::sleep(Duration::from_millis(120)).await;
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/transcripts/recursive-fanout");
    let project = home.join(".claude/projects/-work-proj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::copy(
        fixture.join("session.jsonl"),
        project.join(format!("{session}.jsonl")),
    )
    .unwrap();
    copy_subagents(&fixture, &project.join(&session).join("subagents"));

    // ── The tailer must pick it up. (Old code: never — no tailer was started.) ──
    wait_for_agents(&sup, 25).await;

    let snap = sup.snapshot().await.unwrap();
    let spawned = sink
        .events()
        .iter()
        .filter(|e| matches!(e, AgentEvent::SubagentSpawned { .. }))
        .count();
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(snap.agents.len(), 25, "root + 24 sub-agents");
    assert_eq!(
        spawned, 24,
        "every sub-agent must reach the sink as subagent_spawned"
    );
}
