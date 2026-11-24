//! Supervisor ↔ fan-out wiring (M3): a `FanoutDelta` from the tailer becomes an
//! `AgentEvent` and a forest node, sub-agents cascade-remove with their root, and a
//! child's status change never touches its parent (the trap).
//!
//! Deltas are injected via `deliver_fanout_delta`, so the wiring is tested without
//! the real transcript-polling loop (which needs `~/.claude` + timing). The parse
//! that *produces* deltas is fixture-tested in `fanout_parser.rs`; the diff that
//! decides them is unit-tested in `agent::fanout`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use agent_studio_scaffold_lib::agent::fanout::{FanoutAgent, FanoutDelta, FanoutStatus};
use agent_studio_scaffold_lib::model::{AgentEvent, AgentKind, AgentStatus};
use agent_studio_scaffold_lib::supervisor::{AgentSpawnSpec, SupervisorHandle};
use common::{supervisor_with_hook, temp_cwd, test_hook_config, ChannelSink, StubAdapter};

fn tid(label: &str) -> String {
    format!("{label}-{}", ulid::Ulid::new())
}

async fn spawn_root(sup: &SupervisorHandle, id: &str) {
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: id.to_string(),
            runtime: "stub-runtime".into(),
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
            prompt: None,
            resume_session_id: None,
        },
        channel,
    )
    .await
    .expect("agent_spawn failed");
}

fn child(agent_id: &str, parent_id: &str, status: FanoutStatus) -> FanoutAgent {
    FanoutAgent {
        agent_id: agent_id.into(),
        parent_id: parent_id.into(),
        title: "Explore the code".into(),
        kind: "Explore".into(),
        spawn_depth: Some(1),
        status,
        cwd: "/work/proj".into(),
        branch: "main".into(),
    }
}

async fn node(
    sup: &SupervisorHandle,
    id: &str,
) -> Option<agent_studio_scaffold_lib::model::AgentNode> {
    sup.snapshot()
        .await
        .unwrap()
        .agents
        .into_iter()
        .find(|n| n.id == id)
}

/// **The headline: a detected sub-agent becomes a live forest node + a
/// `subagent_spawned` event** — the frontend's cue to draw a new child row.
#[tokio::test]
async fn a_spawned_delta_creates_a_subagent_node_and_emits_the_event() {
    let (sup, sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let root = tid("root");
    spawn_root(&sup, &root).await;

    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "kid1",
        &root,
        FanoutStatus::Running,
    )))
    .await
    .unwrap();

    let n = node(&sup, "kid1").await.expect("sub-agent node missing");
    assert_eq!(
        n.parent_id.as_deref(),
        Some(root.as_str()),
        "child must point at its root"
    );
    assert_eq!(n.kind, AgentKind::Subagent);
    assert_eq!(n.status, AgentStatus::Running);
    assert_eq!(n.runtime, "claude-code");
    assert_eq!(n.title, "Explore the code");

    assert!(
        sink.events().iter().any(|e| matches!(
            e,
            AgentEvent::SubagentSpawned { parent_id, child_agent_id, .. }
                if parent_id == &root && child_agent_id == "kid1"
        )),
        "no subagent_spawned event; got {:?}",
        sink.tags()
    );
}

/// Recursion: a depth-2 sub-agent parents to a depth-1 sub-agent, not the root.
#[tokio::test]
async fn a_depth_two_delta_nests_under_its_sub_agent_parent() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let root = tid("root");
    spawn_root(&sup, &root).await;

    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "kid1",
        &root,
        FanoutStatus::Running,
    )))
    .await
    .unwrap();
    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "grandkid",
        "kid1",
        FanoutStatus::Running,
    )))
    .await
    .unwrap();

    assert_eq!(
        node(&sup, "grandkid").await.unwrap().parent_id.as_deref(),
        Some("kid1")
    );
}

/// **The trap, end to end: a child finishing must NOT flip its parent to done**
/// A `StatusChanged` is scoped to one agent id.
#[tokio::test]
async fn a_child_status_change_never_touches_its_parent() {
    let (sup, sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let root = tid("root");
    spawn_root(&sup, &root).await;
    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "kid1",
        &root,
        FanoutStatus::Running,
    )))
    .await
    .unwrap();

    // The child finishes.
    sup.deliver_fanout_delta(FanoutDelta::StatusChanged {
        agent_id: "kid1".into(),
        status: FanoutStatus::Done,
    })
    .await
    .unwrap();

    assert_eq!(
        node(&sup, "kid1").await.unwrap().status,
        AgentStatus::Done,
        "child is done"
    );
    // The ROOT's status is untouched — the whole point. It was spawned with no
    // prompt, so it is born idle; a child finishing must never mutate it (to Done
    // or anything else).
    assert_eq!(
        node(&sup, &root).await.unwrap().status,
        AgentStatus::Idle,
        "a child finishing changed the trunk's status"
    );
    // And no Status event was emitted for the root.
    assert!(
        !sink.events().iter().any(|e| matches!(
            e,
            AgentEvent::Status { agent_id, status }
                if agent_id == &root && *status == AgentStatus::Done
        )),
        "a child's completion emitted a done status for the root"
    );
}

/// A child dying with an error surfaces as an `error` node — the badge the user
/// must be able to trust.
#[tokio::test]
async fn a_child_error_status_surfaces_as_error() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let root = tid("root");
    spawn_root(&sup, &root).await;
    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "kid1",
        &root,
        FanoutStatus::Running,
    )))
    .await
    .unwrap();
    sup.deliver_fanout_delta(FanoutDelta::StatusChanged {
        agent_id: "kid1".into(),
        status: FanoutStatus::Error,
    })
    .await
    .unwrap();

    assert_eq!(node(&sup, "kid1").await.unwrap().status, AgentStatus::Error);
}

/// **Cascade removal: dismissing the root drops its whole sub-tree** (an M2
/// requirement). The sub-agents the client never opened must
/// go with the root.
#[tokio::test]
async fn closing_the_root_cascades_to_all_descendants() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let root = tid("root");
    spawn_root(&sup, &root).await;
    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "kid1",
        &root,
        FanoutStatus::Running,
    )))
    .await
    .unwrap();
    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "kid2",
        &root,
        FanoutStatus::Running,
    )))
    .await
    .unwrap();
    sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
        "grandkid",
        "kid1",
        FanoutStatus::Running,
    )))
    .await
    .unwrap();
    assert_eq!(
        sup.snapshot().await.unwrap().agents.len(),
        4,
        "root + 3 descendants"
    );

    // Close the root's terminal (AgentId == TerminalId for the root).
    sup.close(root.clone()).await.expect("close failed");

    let snap = sup.snapshot().await.unwrap();
    assert!(
        snap.agents.is_empty(),
        "the whole tree must be gone, got {:?}",
        snap.agents
    );
    for id in [root.as_str(), "kid1", "kid2", "grandkid"] {
        assert!(node(&sup, id).await.is_none(), "{id} survived the cascade");
    }
}

/// A duplicate `Spawned` for an already-known sub-agent is a no-op (a tailer can
/// re-report after a restart) — no duplicate node, no second event.
#[tokio::test]
async fn a_duplicate_spawned_delta_is_idempotent() {
    let (sup, sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let root = tid("root");
    spawn_root(&sup, &root).await;
    for _ in 0..3 {
        sup.deliver_fanout_delta(FanoutDelta::Spawned(child(
            "kid1",
            &root,
            FanoutStatus::Running,
        )))
        .await
        .unwrap();
    }
    // Barrier: a snapshot reply is processed after the queued deltas (FIFO), so by
    // the time it returns all three have been handled.
    let _ = sup.snapshot().await.unwrap();
    assert_eq!(
        sink.tags()
            .iter()
            .filter(|t| *t == "subagent_spawned")
            .count(),
        1,
        "a re-reported sub-agent must not emit a second spawn"
    );
    assert_eq!(
        sup.snapshot()
            .await
            .unwrap()
            .agents
            .iter()
            .filter(|n| n.id == "kid1")
            .count(),
        1
    );
}

/// A `StatusChanged` for an agent we never saw spawned is ignored (ordering safety).
#[tokio::test]
async fn a_status_delta_for_an_unknown_agent_is_ignored() {
    let (sup, sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let root = tid("root");
    spawn_root(&sup, &root).await;

    sup.deliver_fanout_delta(FanoutDelta::StatusChanged {
        agent_id: "never-spawned".into(),
        status: FanoutStatus::Done,
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(node(&sup, "never-spawned").await.is_none());
    // Only the root's own agent_started; no phantom status.
    assert!(!sink.tags().iter().any(|t| t == "status"));
}
