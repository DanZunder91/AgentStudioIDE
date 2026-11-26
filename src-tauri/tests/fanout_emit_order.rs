//! Parent-before-child emit order: the UI attaches children by `parentId` and drops orphans,
//! so deltas go shallowest-first; checked through the real tailer over the depth-2 fixture.
//! Own binary: it sets the process-global `HOME`.

mod common;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::model::AgentEvent;
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor, AgentSpawnSpec};
use common::{ChannelSink, RecordingSink, StubAdapter};

#[tokio::test]
async fn subagent_spawned_events_arrive_parent_before_child() {
    let home = std::env::temp_dir().join(format!("agentstudio-emitorder-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    let adapter = Arc::new(StubAdapter::interactive());
    let sink = RecordingSink::new();
    let sup = spawn_supervisor(Arc::new(sink.clone()), vec![adapter.clone()], None);

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
    .unwrap();
    let session = adapter.minted_keys()[0].clone();

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/transcripts/recursive-fanout");
    let project = home.join(".claude/projects/-work-proj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::copy(
        fixture.join("session.jsonl"),
        project.join(format!("{session}.jsonl")),
    )
    .unwrap();
    let sub_dst = project.join(&session).join("subagents");
    std::fs::create_dir_all(&sub_dst).unwrap();
    for e in std::fs::read_dir(fixture.join("subagents"))
        .unwrap()
        .flatten()
    {
        std::fs::copy(e.path(), sub_dst.join(e.file_name())).unwrap();
    }

    // Wait for the full tree (root + 24).
    let start = Instant::now();
    while sup.snapshot().await.unwrap().agents.len() < 25 {
        if start.elapsed() > Duration::from_secs(10) {
            std::fs::remove_dir_all(&home).ok();
            panic!("timed out reconstructing the tree");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Replay emit order: every child must appear after its parent.
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(agent_id.clone()); // the root exists from the start
    for e in sink.events() {
        if let AgentEvent::SubagentSpawned {
            parent_id,
            child_agent_id,
            ..
        } = e
        {
            assert!(
                seen.contains(&parent_id),
                "child {child_agent_id} was emitted before its parent {parent_id}"
            );
            seen.insert(child_agent_id);
        }
    }
    std::fs::remove_dir_all(&home).ok();
}
