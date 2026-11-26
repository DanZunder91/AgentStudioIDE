//! The whole live fan-out tailer loop: locate by session id → poll → parse → diff → emit. Own
//! binary: it sets the process-global `HOME` and `AGENTSTUDIO_FANOUT_POLL_MS` (50 ms); stub
//! adapter, real Claude parser, committed fixture.

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::supervisor::{OpenSpec, SupervisorHandle};
use common::{
    hook_payload, interactive_sh, supervisor_with_hook, test_hook_config, ChannelSink, StubAdapter,
};

fn copy_dir(src: &PathBuf, dst: &PathBuf) {
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

async fn wait_until(sup: &SupervisorHandle, what: &str, cond: impl Fn(usize) -> bool) {
    let start = Instant::now();
    loop {
        let n = sup.snapshot().await.unwrap().agents.len();
        if cond(n) {
            return;
        }
        if start.elapsed() > Duration::from_secs(15) {
            panic!("timed out waiting for {what}; agent count = {n}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn the_tailer_loop_reconstructs_the_real_tree_from_disk() {
    // A private home so the tailer's `~/.claude/projects` glob hits our fixture,
    // never the developer's real transcripts. Set both vars — the locator reads
    // `HOME` on unix, `USERPROFILE` on Windows — so this runs on every OS.
    let home = std::env::temp_dir().join(format!("agentstudio-tailer-{}", ulid::Ulid::new()));
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    // Place the committed recursive-fanout fixture as if it were a live session.
    let session = "cafe0000-0000-4000-8000-000000000001";
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/transcripts/recursive-fanout");
    let project = home.join(".claude/projects/-work-proj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::copy(
        fixture.join("session.jsonl"),
        project.join(format!("{session}.jsonl")),
    )
    .unwrap();
    copy_dir(
        &fixture.join("subagents"),
        &project.join(session).join("subagents"),
    );

    // Drive the ad-hoc path so we control the session id the tailer locates.
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let term = format!("term-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: term.clone(),
            program: Some(program),
            args,
            cwd: home.to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");

    // SessionStart -> ad-hoc root created -> its fan-out tailer starts polling.
    sup.deliver_hook(term.clone(), hook_payload("SessionStart", session, None));

    // The root appears first (1 agent), then the tailer discovers the 24 sub-agents.
    wait_until(&sup, "the root", |n| n >= 1).await;
    wait_until(&sup, "all 24 sub-agents to be tailed in", |n| n >= 25).await;

    let snap = sup.snapshot().await.unwrap();

    // 1 root + 24 sub-agents.
    assert_eq!(snap.agents.len(), 25, "root + 24 sub-agents");

    // Depth-2 recursion survived the live loop: a grandchild parents to a sub-agent.
    let grandchild = snap
        .agents
        .iter()
        .find(|a| a.id == "agent06")
        .expect("agent06 missing");
    assert_eq!(
        grandchild.parent_id.as_deref(),
        Some("agent07"),
        "depth-2 edge wrong via the live loop"
    );
    assert_eq!(grandchild.runtime, "claude-code");

    // A depth-1 sub-agent parents to the ad-hoc root (== the terminal id).
    let child = snap
        .agents
        .iter()
        .find(|a| a.id == "agent00")
        .expect("agent00 missing");
    assert_eq!(child.parent_id.as_deref(), Some(term.as_str()));

    // Close cascades the tree; then a new sub-agent appears on disk, which only an un-aborted
    // tailer would pick up (resurrecting an orphan).
    sup.close(term.clone()).await.expect("close failed");
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(
        sup.snapshot().await.unwrap().agents.len(),
        0,
        "close must clear the tree"
    );

    // Append a brand-new sub-agent to the on-disk session.
    let sub = project.join(session).join("subagents");
    std::fs::write(
        sub.join("agent-zombie.meta.json"),
        r#"{"agentType":"general-purpose","description":"resurrected","toolUseId":"tz","spawnDepth":1}"#,
    )
    .unwrap();
    std::fs::write(
        sub.join("agent-zombie.jsonl"),
        "{\"agentId\":\"zombie\",\"cwd\":\"/work/proj\",\"gitBranch\":\"main\"}\n",
    )
    .unwrap();

    // Several poll intervals: the aborted tailer must never pick this up.
    for _ in 0..6 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let n = sup.snapshot().await.unwrap().agents.len();
        assert_eq!(
            n, 0,
            "a still-running tailer resurrected the closed tree ({n} agents)"
        );
    }

    std::fs::remove_dir_all(&home).ok();
}
