//! Ad-hoc fan-out end to end: `deliver_hook` → `create_adhoc_root` → tailer, over a running
//! session's shape (no root `.jsonl`, sub-agent `.meta.json` only), whose sub-agents must
//! reach the sink. Own binary (sets `HOME`).

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::model::{AgentEvent, TerminalKind};
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor, OpenSpec, SupervisorHandle};
use common::{hook_payload, interactive_sh, ChannelSink, RecordingSink, StubAdapter};

async fn agents_len(sup: &SupervisorHandle) -> usize {
    sup.snapshot().await.unwrap().agents.len()
}

#[tokio::test]
async fn an_adhoc_claude_delivers_its_subagents_to_the_rail() {
    let home = std::env::temp_dir().join(format!("agentstudio-adhoclive-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    let sink = RecordingSink::new();
    // A hook config so env injection is on; the binding logic is driven directly.
    let hook = agent_studio_scaffold_lib::hook_listener::HookConfig {
        base_url: "http://127.0.0.1:1".into(),
        token: "t".into(),
    };
    let sup = spawn_supervisor(
        Arc::new(sink.clone()),
        vec![Arc::new(StubAdapter::interactive())],
        Some(hook),
    );

    // The user opens a plain terminal in a project dir and types `claude`.
    let cwd = home.join("proj");
    std::fs::create_dir_all(&cwd).unwrap();
    let term = format!("term-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: term.clone(),
            program: Some(program),
            args,
            cwd: cwd.to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");

    // claude's OWN session id (a real UUID it generates — not minted by us).
    let session = "c0ffee00-0000-4000-8000-000000000007";

    // As a running claude leaves it (measured): sub-agent `.meta.json` present, root
    // `<session>.jsonl` not yet written; `locate_transcript` anchors on the `<session>/` dir.
    let project = home.join(".claude/projects/-proj");
    let subagents = project.join(session).join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    assert!(
        !project.join(format!("{session}.jsonl")).exists(),
        "root .jsonl must be absent"
    );
    for (n, a) in ["a11a", "a22b"].iter().enumerate() {
        std::fs::write(
            subagents.join(format!("agent-{a}.meta.json")),
            format!(r#"{{"agentType":"Explore","description":"d{n}","toolUseId":"t{a}","spawnDepth":1}}"#),
        )
        .unwrap();
    }

    // The SessionStart hook fires → ad-hoc root created → its tailer starts.
    sup.deliver_hook(term.clone(), hook_payload("SessionStart", session, None));

    // Root appears (1), then the tailer discovers the 2 sub-agents (3 total).
    let start = Instant::now();
    while agents_len(&sup).await < 3 {
        if start.elapsed() > Duration::from_secs(10) {
            let n = agents_len(&sup).await;
            std::fs::remove_dir_all(&home).ok();
            panic!("ad-hoc fan-out failed: {n} agents (root .jsonl absent, sub-agents never delivered)");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let snap = sup.snapshot().await.unwrap();
    std::fs::remove_dir_all(&home).ok();

    // The promoted ad-hoc root.
    let root = snap
        .agents
        .iter()
        .find(|a| a.id == term)
        .expect("ad-hoc root missing");
    assert_eq!(root.parent_id, None);
    // Its two sub-agents, parented to it.
    let subs: Vec<_> = snap
        .agents
        .iter()
        .filter(|a| a.parent_id.as_deref() == Some(term.as_str()))
        .collect();
    assert_eq!(
        subs.len(),
        2,
        "both ad-hoc sub-agents must appear under the root"
    );

    let term_kind = snap.terminals.iter().find(|t| t.id == term).unwrap().kind;
    assert_eq!(
        term_kind,
        TerminalKind::AgentTerminal,
        "the ad-hoc terminal was promoted"
    );

    let spawned = sink
        .events()
        .iter()
        .filter(|e| matches!(e, AgentEvent::SubagentSpawned { .. }))
        .count();
    assert_eq!(
        spawned, 2,
        "sub-agents must reach the sink as subagent_spawned"
    );
}
