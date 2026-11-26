//! End to end through the real `ClaudeAdapter` (the `+`-spawn path): resolve, mint
//! `--session-id`, spawn, tail, parse, emit; only `claude` is faked, by a shell script writing
//! the fixture for its session id (hence Unix-only; `fanout_*` tests cover the rest).
#![cfg(unix)]

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::agent::claude::{ClaudeAdapter, CLAUDE_BIN_ENV};
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor, AgentSpawnSpec, SupervisorHandle};
use common::{ChannelSink, RecordingSink};

#[cfg(unix)]
fn write_fake_claude(dir: &std::path::Path, fixture: &std::path::Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("fake-claude");
    // Parse --session-id, copy the fixture into ~/.claude/projects/proj/<id>/, then
    // block forever (a live agent REPL). This is what real `claude` does re: files.
    let script = format!(
        r#"#!/bin/sh
sid=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
proj="$HOME/.claude/projects/-work-proj"
mkdir -p "$proj/$sid/subagents"
cp "{fixture}/session.jsonl" "$proj/$sid.jsonl"
cp "{fixture}/subagents/"* "$proj/$sid/subagents/"
# Stay alive like an interactive agent.
while true; do sleep 1; done
"#,
        fixture = fixture.display()
    );
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

async fn wait_for_agents(sup: &SupervisorHandle, n: usize) {
    let start = Instant::now();
    loop {
        let count = sup.snapshot().await.unwrap().agents.len();
        if count >= n {
            return;
        }
        if start.elapsed() > Duration::from_secs(20) {
            panic!("timed out: have {count} agents, want {n}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_real_claude_adapter_spawn_delivers_the_fanout_tree() {
    let home = std::env::temp_dir().join(format!("agentstudio-realadapter-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/transcripts/recursive-fanout");
    let fake = write_fake_claude(&home, &fixture);
    // Point the REAL ClaudeAdapter at our fake binary.
    std::env::set_var(CLAUDE_BIN_ENV, &fake);

    let sink = RecordingSink::new();
    let sup = spawn_supervisor(
        Arc::new(sink.clone()),
        vec![Arc::new(ClaudeAdapter::new())],
        None,
    );

    // Spawn a REAL claude-code agent (the `+` path). The tailer must start now,
    // before fake-claude has written anything, and keep polling.
    let agent_id = format!("root-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: agent_id.clone(),
            runtime: "claude-code".into(),
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

    // fake-claude writes the transcript ~instantly, then the tailer picks it up.
    wait_for_agents(&sup, 25).await;

    let snap = sup.snapshot().await.unwrap();
    std::env::remove_var(CLAUDE_BIN_ENV);
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(
        snap.agents.len(),
        25,
        "root + 24 sub-agents via the real adapter"
    );
    let root_children = snap
        .agents
        .iter()
        .filter(|a| a.parent_id.as_deref() == Some(agent_id.as_str()))
        .count();
    assert_eq!(
        root_children, 19,
        "19 depth-1 sub-agents must attach to the spawned root"
    );

    let spawned = sink
        .events()
        .iter()
        .filter(|e| {
            matches!(
                e,
                agent_studio_scaffold_lib::model::AgentEvent::SubagentSpawned { .. }
            )
        })
        .count();
    assert_eq!(
        spawned, 24,
        "all sub-agents must reach the sink as subagent_spawned"
    );
}
