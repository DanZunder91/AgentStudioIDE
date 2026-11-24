//! **The rootless bug, end to end**: a spawned agent whose runtime writes only
//! `<session>/subagents/*.meta.json` (no root `<session>.jsonl`, no sub-agent
//! `.jsonl`) — exactly what a real `--session-id` `claude` leaves on disk while
//! running — must still deliver its sub-agents to the rail.
//!
//! Before the locate-by-directory fix, `locate_transcript` returned `None` for this
//! shape, so the tailer spun forever and emitted nothing. In its own binary (sets
//! `HOME`).

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::model::{AgentEvent, AgentStatus};
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor, AgentSpawnSpec};
use common::{ChannelSink, RecordingSink, StubAdapter};

#[tokio::test]
async fn a_spawned_agent_with_only_meta_sidecars_still_delivers_subagents() {
    let home = std::env::temp_dir().join(format!("agentstudio-rootless-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    let adapter = Arc::new(StubAdapter::interactive());
    let sink = RecordingSink::new();
    let sup = spawn_supervisor(Arc::new(sink.clone()), vec![adapter.clone()], None);

    // Spawn a root with a real cwd/branch so we can check inheritance.
    let agent_id = format!("root-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: agent_id.clone(),
            runtime: "stub-runtime".into(),
            cwd: "/work/proj".into(),
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

    // The runtime writes ONLY `.meta.json` sidecars — no root, no sub-agent .jsonl.
    let subagents = home
        .join(".claude/projects/-work-proj")
        .join(&session)
        .join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    for (n, a) in ["a0b1", "a227", "aef2"].iter().enumerate() {
        std::fs::write(
            subagents.join(format!("agent-{a}.meta.json")),
            format!(r#"{{"agentType":"Explore","description":"d{n}","toolUseId":"t{a}","spawnDepth":1}}"#),
        )
        .unwrap();
    }

    // The tailer must locate by directory and deliver the 3 sub-agents.
    let start = Instant::now();
    while sup.snapshot().await.unwrap().agents.len() < 4 {
        if start.elapsed() > Duration::from_secs(10) {
            std::fs::remove_dir_all(&home).ok();
            panic!("the tailer never delivered the sub-agents (root .jsonl absent)");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let snap = sup.snapshot().await.unwrap();
    std::fs::remove_dir_all(&home).ok();

    let subs: Vec<_> = snap
        .agents
        .iter()
        .filter(|a| a.parent_id.as_deref() == Some(agent_id.as_str()))
        .collect();
    assert_eq!(
        subs.len(),
        3,
        "all 3 sidecar sub-agents must appear under the root"
    );
    for s in &subs {
        assert_eq!(
            s.status,
            AgentStatus::Running,
            "running (no completion on disk)"
        );
        // cwd/branch were empty on disk (no sub-agent .jsonl); inherited from root.
        assert_eq!(
            s.cwd, "/work/proj",
            "empty cwd must be inherited from the parent"
        );
    }
    let spawned = sink
        .events()
        .iter()
        .filter(|e| matches!(e, AgentEvent::SubagentSpawned { .. }))
        .count();
    assert_eq!(spawned, 3, "each must reach the sink as subagent_spawned");
}
