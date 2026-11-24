//! M2 integration tests: the agent lifecycle through the supervisor.
//!
//! **No real `claude` is ever spawned here.** It needs auth and a network, and the
//! suite would become slow, flaky and dependent on somebody's login. That is the
//! point of the `AgentAdapter` seam: the supervisor is driven by a stub that
//! spawns a real shell in a real PTY, so everything under test — the forest, the
//! terminal binding, exit handling, telemetry — is exercised for real. The
//! Claude-specific logic is pure and unit-tested in `agent/claude.rs`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use agent_studio_scaffold_lib::agent::adapter::AgentAdapter;
use agent_studio_scaffold_lib::model::{AgentEvent, AgentStatus, TerminalKind, TerminalStatus};
use agent_studio_scaffold_lib::supervisor::AgentSpawnSpec;
use common::{
    env_ref, supervisor_with, temp_cwd, then, wait_for_output, wait_for_quiet, ChannelSink,
    FailingAdapter, StubAdapter,
};

fn aid(label: &str) -> String {
    format!("{label}-{}", ulid::Ulid::new())
}

fn spec(agent_id: &str, runtime: &str) -> AgentSpawnSpec {
    AgentSpawnSpec {
        agent_id: agent_id.to_string(),
        runtime: runtime.to_string(),
        cwd: temp_cwd(),
        rows: 24,
        cols: 80,
        prompt: None,
        resume_session_id: None,
    }
}

/// The floor: spawning an agent gives back an **agent** terminal bound to the
/// agent, and the child's bytes stream on the channel the UI handed us — the same
/// hot path a plain terminal uses (not a second implementation).
#[tokio::test]
async fn agent_spawn_returns_an_agent_terminal_and_streams_output() {
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::running("echo agent-is-alive")));
    let id = aid("agent");
    let (out, channel) = ChannelSink::new();

    let meta = sup
        .spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");

    assert_eq!(meta.id, id);
    assert_eq!(
        meta.kind,
        TerminalKind::AgentTerminal,
        "must not be a plain terminal"
    );
    assert_eq!(
        meta.agent_id.as_deref(),
        Some(id.as_str()),
        "terminal must name its agent"
    );
    assert_eq!(meta.status, TerminalStatus::Live);
    assert_eq!(meta.title, "stub");

    wait_for_output(&out, "agent-is-alive").await;
}

/// **Deterministic session binding** — the crux of M2.
///
/// The adapter *imposes* an identity on the process rather than inferring one
/// afterwards. Asserting the child can read it back proves the binding actually
/// reached the process: it is a fact, not a claim. For the real adapter the same
/// mechanism is `claude --session-id <uuid>`.
#[tokio::test]
async fn the_session_identity_is_imposed_on_the_child_process() {
    let adapter = Arc::new(StubAdapter::running(&format!(
        "echo session={}",
        env_ref("STUB_SESSION_ID")
    )));
    let (sup, _sink) = supervisor_with(adapter.clone());
    let (out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&aid("agent"), "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");

    let minted = adapter.minted_keys();
    assert_eq!(minted.len(), 1, "exactly one session key per spawn");
    // The child echoes the identity we gave it.
    wait_for_output(&out, &format!("session={}", minted[0])).await;
}

/// **Two agents in the same cwd** — the exact case that broke the cwd-mangling
/// heuristic cmux deleted, and the reason we dictate identity instead.
///
/// Both agents share a directory; their identities must still be distinct and each
/// bound to the right terminal.
#[tokio::test]
async fn two_agents_in_one_cwd_get_distinct_identities() {
    let adapter = Arc::new(StubAdapter::running(&format!(
        "echo session={}",
        env_ref("STUB_SESSION_ID")
    )));
    let (sup, _sink) = supervisor_with(adapter.clone());

    let a = aid("agent-a");
    let b = aid("agent-b");
    let (out_a, ch_a) = ChannelSink::new();
    let (out_b, ch_b) = ChannelSink::new();

    // Identical cwd — a completely normal thing for a user to do.
    let mut spec_a = spec(&a, "stub-runtime");
    let mut spec_b = spec(&b, "stub-runtime");
    spec_a.cwd = temp_cwd();
    spec_b.cwd = temp_cwd();
    assert_eq!(
        spec_a.cwd, spec_b.cwd,
        "the test is meaningless unless the cwds match"
    );

    sup.spawn_agent(spec_a, ch_a).await.expect("spawn a failed");
    sup.spawn_agent(spec_b, ch_b).await.expect("spawn b failed");

    let minted = adapter.minted_keys();
    assert_eq!(minted.len(), 2);
    assert_ne!(
        minted[0], minted[1],
        "two agents in one cwd must not share an identity"
    );

    // And each identity reached *its own* process, not the other's.
    wait_for_output(&out_a, &format!("session={}", minted[0])).await;
    wait_for_output(&out_b, &format!("session={}", minted[1])).await;
    assert!(
        !out_a.text().contains(&minted[1]),
        "agent a saw b's identity"
    );
    assert!(
        !out_b.text().contains(&minted[0]),
        "agent b saw a's identity"
    );

    // The snapshot keeps them apart too.
    let snap = sup.snapshot().await.expect("snapshot failed");
    assert_eq!(snap.agents.len(), 2);
    assert_eq!(snap.agents.iter().filter(|n| n.id == a).count(), 1);
    assert_eq!(snap.agents.iter().filter(|n| n.id == b).count(), 1);
}

/// The fleet snapshot is the initial paint and the re-attach path.
#[tokio::test]
async fn fleet_snapshot_reports_the_agent_node() {
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");

    let snap = sup.snapshot().await.expect("snapshot failed");
    assert_eq!(snap.agents.len(), 1);
    assert_eq!(snap.terminals.len(), 1);

    let node = &snap.agents[0];
    assert_eq!(node.id, id);
    assert_eq!(node.parent_id, None, "M2 only creates root orchestrators");
    // Born idle: a freshly spawned `claude` is parked at its prompt, not yet
    // processing a turn (the turn/activity hooks drive it from here).
    assert_eq!(node.status, AgentStatus::Idle);
    assert_eq!(node.runtime, "stub-runtime");
    assert_eq!(node.cwd, temp_cwd());
    assert!(node.started_at.is_some());
    assert_eq!(node.finished_at, None);
    assert_eq!(node.error, None);

    // The agent's terminal is in the same snapshot, cross-linked.
    let term = &snap.terminals[0];
    assert_eq!(term.id, id);
    assert_eq!(term.agent_id.as_deref(), Some(id.as_str()));
    assert_eq!(term.kind, TerminalKind::AgentTerminal);
}

/// **The gap this closes.** `TerminalMeta.status`/`exitCode` were written on child
/// exit but no caller could read them — a terminal's death was invisible to the UI.
#[tokio::test]
async fn fleet_snapshot_makes_a_dead_terminal_visible() {
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::running("exit 3")));
    let id = aid("agent");
    let (out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");

    // Wait for the process to actually be gone.
    wait_for_quiet(&out, Duration::from_millis(300)).await;
    wait_until_agent_finished(&sup, &id).await;

    let snap = sup.snapshot().await.expect("snapshot failed");
    let term = snap
        .terminals
        .iter()
        .find(|t| t.id == id)
        .expect("terminal missing");
    assert_eq!(
        term.status,
        TerminalStatus::Exited,
        "the UI must be able to see the death"
    );
    assert_eq!(term.exit_code, Some(3), "and the exit code that caused it");
}

/// A clean exit is `done`; the node keeps its metadata for inspection.
#[tokio::test]
async fn a_clean_exit_marks_the_agent_done() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::running("exit 0")));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    wait_until_agent_finished(&sup, &id).await;

    let node = agent_node(&sup, &id).await;
    assert_eq!(node.status, AgentStatus::Done);
    assert_eq!(node.error, None, "a clean exit has no error detail");
    assert!(node.finished_at.is_some());

    // …and the telemetry says so.
    assert!(
        sink.events().iter().any(|e| matches!(
            e,
            AgentEvent::Exited { agent_id, code } if agent_id == &id && *code == 0
        )),
        "no `exited` event with code 0; got {:?}",
        sink.tags()
    );
}

/// A non-zero exit is `error`, with the code in the detail field. `AgentStatus` has
/// no "crashed", and reporting `done` would hide a failure.
#[tokio::test]
async fn a_failed_exit_marks_the_agent_error_with_the_code() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::running("exit 9")));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    wait_until_agent_finished(&sup, &id).await;

    let node = agent_node(&sup, &id).await;
    assert_eq!(node.status, AgentStatus::Error);
    assert_eq!(
        node.error.as_deref(),
        Some("exited with code 9"),
        "the error detail must carry the code, not just a red dot"
    );

    assert!(
        sink.events()
            .iter()
            .any(|e| matches!(e, AgentEvent::Exited { code, .. } if *code == 9)),
        "exit code lost from telemetry"
    );
}

/// `agent://event` order on a healthy spawn→exit: started, then exited, then the
/// status transition. The UI's reducer depends on `agent_started` arriving first —
/// a `status` for an unknown agent has nothing to update.
#[tokio::test]
async fn telemetry_reports_started_then_exited_then_status() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::running("exit 0")));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    wait_until_agent_finished(&sup, &id).await;

    assert_eq!(
        sink.tags(),
        vec!["agent_started", "exited", "status"],
        "wrong telemetry sequence"
    );

    match &sink.events()[0] {
        AgentEvent::AgentStarted {
            agent_id,
            parent_id,
            runtime,
            cwd,
            ..
        } => {
            assert_eq!(agent_id, &id);
            assert_eq!(parent_id, &None, "M2 agents are roots");
            assert_eq!(runtime, "stub-runtime");
            assert_eq!(cwd, &temp_cwd());
        }
        other => panic!("first event must be agent_started, got {other:?}"),
    }
    match &sink.events()[2] {
        AgentEvent::Status { status, .. } => assert_eq!(*status, AgentStatus::Done),
        other => panic!("expected a status event, got {other:?}"),
    }
}

/// **M3 must not be pre-empted.** `subagent_spawned` is the fan-out headline and
/// requires the transcript tailer; M2 must never invent one.
#[tokio::test]
async fn m2_never_emits_subagent_spawned() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::running(&then("echo hi", "exit 0"))));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    wait_until_agent_finished(&sup, &id).await;

    assert!(
        !sink.tags().iter().any(|t| t == "subagent_spawned"),
        "M2 has no telemetry to derive sub-agents from; emitting one would be a guess"
    );
    // Nor should the forest sprout children.
    let snap = sup.snapshot().await.unwrap();
    assert!(snap.agents.iter().all(|n| n.parent_id.is_none()));
}

/// **Closing a tab removes the agent** (the revised model): a closed agent
/// will not be opened again, so a later `fleet_snapshot` must not resurrect it. A
/// graveyard of dead nodes in the rail is clutter.
///
/// This supersedes the earlier "keep it as a greyed `done` node" behaviour.
#[tokio::test]
async fn closing_an_agent_removes_it_from_the_fleet() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    assert!(
        agent_present(&sup, &id).await,
        "agent should exist after spawn"
    );

    sup.close(id.clone()).await.expect("close failed");

    assert!(
        !agent_present(&sup, &id).await,
        "a closed agent must be gone from the fleet"
    );
    assert!(
        !terminal_present(&sup, &id).await,
        "its terminal must be gone too"
    );

    // A close is not a failure, so it must not paint anything red on the way out.
    // (No `removed` event in M2: the frontend issued the close and drops the node
    // itself, so the server just has to forget it.)
    assert!(
        !sink.events().iter().any(
            |e| matches!(e, AgentEvent::Status { status, .. } if *status == AgentStatus::Error)
        ),
        "close emitted an error status; got {:?}",
        sink.tags()
    );
}

/// Removal must survive a re-query: the rule that a closed agent must not
/// return is specifically about the *next* snapshot, and a stale entry that only clears
/// later would still flash a ghost in the rail.
#[tokio::test]
async fn a_closed_agent_stays_gone_across_repeated_snapshots() {
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    sup.close(id.clone()).await.expect("close failed");

    for _ in 0..5 {
        assert!(
            !agent_present(&sup, &id).await,
            "closed agent reappeared in a later snapshot"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// **Race safety: a close kills the child, and the resulting `ChildExited` must not
/// resurrect the removed agent.** The waiter thread reports the kill *after* the
/// close has already removed the node — if that late message re-inserted anything,
/// the agent would flicker back to life.
#[tokio::test]
async fn a_late_child_exit_after_close_does_not_resurrect_the_agent() {
    // A living agent, so closing it genuinely triggers a kill → a real ChildExited.
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    sup.close(id.clone()).await.expect("close failed");

    // Give the waiter thread ample time to deliver ChildExited to the actor.
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        !agent_present(&sup, &id).await,
        "a late ChildExited resurrected a closed agent"
    );
    // And the ghost must not have emitted a death event for a node the UI already
    // dropped.
    assert!(
        !sink.tags().iter().any(|t| t == "exited"),
        "the late ChildExited emitted telemetry for a removed agent: {:?}",
        sink.tags()
    );
}

/// The close path must never fabricate an exit code, and — now that close removes
/// the node — must not emit a death event for it at all. "exited with code -1" was
/// the original bug's symptom; the signal codes a kill produces (143/137) describe
/// *our kill*, not the agent, and are equally meaningless to the user.
#[tokio::test]
async fn closing_never_reports_a_made_up_exit_code() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    sup.close(id.clone()).await.expect("close failed");
    tokio::time::sleep(Duration::from_millis(300)).await;

    // The agent never exited on its own, so *any* exited event here is fabricated.
    for e in sink.events() {
        if let AgentEvent::Exited { code, .. } = e {
            panic!("close fabricated an exited event with code {code}");
        }
    }
}

/// **The other direction — the test that stops a future "fix" from swallowing real
/// failures.** An agent that dies on its own with a non-zero code must still be an
/// error: that is the signal the user has to be able to trust in an M3 tree.
#[tokio::test]
async fn a_genuine_crash_is_still_an_error_after_the_close_fix() {
    for code in [1, 9, 127] {
        let (sup, sink) = supervisor_with(Arc::new(StubAdapter::running(&format!("exit {code}"))));
        let id = aid("agent");
        let (_out, channel) = ChannelSink::new();

        sup.spawn_agent(spec(&id, "stub-runtime"), channel)
            .await
            .expect("agent_spawn failed");
        wait_until_agent_finished(&sup, &id).await;

        let node = agent_node(&sup, &id).await;
        assert_eq!(
            node.status,
            AgentStatus::Error,
            "a child that died on its own with code {code} must still be an error"
        );
        assert_eq!(
            node.error.as_deref(),
            Some(&*format!("exited with code {code}"))
        );
        assert!(
            sink.events()
                .iter()
                .any(|e| matches!(e, AgentEvent::Exited { code: c, .. } if *c == code)),
            "the real exit code must survive to the UI"
        );
    }
}

/// A self-inflicted interrupt (Ctrl-C → 130) is *not* something we asked for, so it
/// stays an error. The exemption is about **intent**, not about which codes look
/// alarming — only a close *we* issued is exempt.
#[tokio::test]
async fn a_child_that_kills_itself_is_still_an_error() {
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::running("kill -INT $$")));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    wait_until_agent_finished(&sup, &id).await;

    assert_eq!(
        agent_node(&sup, &id).await.status,
        AgentStatus::Error,
        "we did not ask for this death, so it is not exempt"
    );
}

/// **The collision of crash, then close.**
///
/// An agent crashes on its own (recorded as `error`, one `exited` event), and the
/// user *then* closes the tab. Close wins — the node is removed. Rationale: the
/// crash was retained *until the user dismissed it*, and closing the tab is that
/// dismissal, an explicit action that supersedes the retained record.
///
/// Crucially, the crash's own `exited` telemetry (with the real code) still fired
/// while the node existed — the failure was reported, then the user cleared it.
/// The close must not *add* a second, laundered event.
#[tokio::test]
async fn a_close_after_a_crash_removes_the_node_but_keeps_the_crash_report() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::running("exit 9")));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    wait_until_agent_finished(&sup, &id).await;

    // The crash was reported as a real failure, once, before the close.
    assert_eq!(agent_node(&sup, &id).await.status, AgentStatus::Error);
    assert!(
        sink.events()
            .iter()
            .any(|e| matches!(e, AgentEvent::Exited { code, .. } if *code == 9)),
        "the crash's real exit code must have reached the UI"
    );

    sup.close(id.clone()).await.expect("close failed");

    // Close wins: the node is gone.
    assert!(
        !agent_present(&sup, &id).await,
        "close after a crash must still remove the node — the user dismissed it"
    );
    // But the close must not have laundered the crash into a second event.
    assert_eq!(
        sink.tags().iter().filter(|t| *t == "exited").count(),
        1,
        "close re-reported an already-finished agent"
    );
}

/// A clean natural exit, then a close: also removed. Covers the done-then-close
/// arm (distinct retained state from the crash case) and pins that the close does
/// not emit a second `exited` for the already-finished agent.
#[tokio::test]
async fn a_close_after_a_clean_exit_removes_the_node() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::running("exit 0")));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), channel)
        .await
        .expect("agent_spawn failed");
    wait_until_agent_finished(&sup, &id).await;
    assert_eq!(agent_node(&sup, &id).await.status, AgentStatus::Done);

    sup.close(id.clone()).await.expect("close failed");

    assert!(
        !agent_present(&sup, &id).await,
        "a closed done-agent must be removed"
    );
    assert_eq!(
        sink.tags().iter().filter(|t| *t == "exited").count(),
        1,
        "close double-reported an already-finished agent",
    );
}

/// **The retain direction, explicit: an agent that exits on its OWN stays in the
/// fleet** — inspectable until the user dismisses it. This is the test that fails
/// if a future change starts removing agents on natural exit (the mistake in the
/// opposite direction from the original bug).
#[tokio::test]
async fn an_agent_that_exits_on_its_own_is_retained() {
    for (script, want) in [
        ("exit 0", AgentStatus::Done),
        ("exit 7", AgentStatus::Error),
    ] {
        let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::running(script)));
        let id = aid("agent");
        let (_out, channel) = ChannelSink::new();

        sup.spawn_agent(spec(&id, "stub-runtime"), channel)
            .await
            .expect("agent_spawn failed");
        wait_until_agent_finished(&sup, &id).await;

        assert!(
            agent_present(&sup, &id).await,
            "an agent that exited on its own ({script}) must be retained, not removed"
        );
        assert_eq!(agent_node(&sup, &id).await.status, want);
        // Its terminal is retained too, so its scrollback stays inspectable.
        assert!(
            terminal_present(&sup, &id).await,
            "the exited terminal must stay for inspection"
        );
    }
}

/// **A plain terminal close removes no agent.** `TerminalId == AgentId` holds for
/// agent terminals only, so closing a shell must not reach into the forest and
/// delete an unrelated agent.
#[tokio::test]
async fn a_plain_terminal_close_removes_no_agent() {
    use agent_studio_scaffold_lib::supervisor::OpenSpec;

    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::interactive()));

    // A live agent we must not disturb.
    let agent_id = aid("agent");
    let (_o1, ch1) = ChannelSink::new();
    sup.spawn_agent(spec(&agent_id, "stub-runtime"), ch1)
        .await
        .expect("agent_spawn failed");

    // A plain terminal alongside it.
    let term_id = aid("plain");
    let (_o2, ch2) = ChannelSink::new();
    let (program, args) = common::interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: term_id.clone(),
            program: Some(program),
            args,
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
        },
        ch2,
    )
    .await
    .expect("terminal_open failed");

    sup.close(term_id.clone()).await.expect("close failed");

    assert!(
        !terminal_present(&sup, &term_id).await,
        "the plain terminal should be gone"
    );
    assert!(
        agent_present(&sup, &agent_id).await,
        "closing a plain terminal must not remove an agent"
    );
    assert_eq!(
        agent_node(&sup, &agent_id).await.status,
        AgentStatus::Idle,
        "the untouched agent should still be at its born-idle status"
    );
}

/// An unknown runtime is an error that names what *is* available — never a silent
/// success or a half-created agent.
#[tokio::test]
async fn an_unknown_runtime_errors_and_creates_nothing() {
    let (sup, sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let (_out, channel) = ChannelSink::new();

    let err = sup
        .spawn_agent(spec(&aid("agent"), "no-such-runtime"), channel)
        .await
        .expect_err("an unknown runtime must fail");
    assert!(err.contains("unknown runtime"), "unhelpful error: {err}");
    assert!(
        err.contains("stub-runtime"),
        "the error should name what is available: {err}"
    );

    let snap = sup.snapshot().await.unwrap();
    assert!(
        snap.agents.is_empty() && snap.terminals.is_empty(),
        "a failed spawn left state"
    );
    assert!(sink.events().is_empty(), "a failed spawn emitted telemetry");
}

/// The runtime not being installed is a normal, actionable condition (the user may
/// simply not have `claude`). It must fail cleanly and leave nothing behind.
#[tokio::test]
async fn an_adapter_that_cannot_spawn_errors_and_creates_nothing() {
    let (sup, sink) = supervisor_with(Arc::new(FailingAdapter));
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    let err = sup
        .spawn_agent(spec(&id, "broken-runtime"), channel)
        .await
        .expect_err("a failing adapter must surface its error");
    assert!(
        err.contains("could not find"),
        "the adapter's message must reach the UI: {err}"
    );

    let snap = sup.snapshot().await.unwrap();
    assert!(
        snap.agents.is_empty(),
        "a failed spawn registered an agent anyway"
    );
    assert!(
        snap.terminals.is_empty(),
        "a failed spawn left a terminal behind"
    );
    assert!(sink.events().is_empty(), "a failed spawn emitted telemetry");

    // The id must still be usable afterwards.
    let (_out2, ch2) = ChannelSink::new();
    let (sup2, _) = supervisor_with(Arc::new(StubAdapter::interactive()));
    sup2.spawn_agent(spec(&id, "stub-runtime"), ch2)
        .await
        .expect("the id must be free after a failed spawn");
}

/// Reusing a live agent id would orphan the first agent's PTY.
#[tokio::test]
async fn a_duplicate_agent_id_errors() {
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let id = aid("agent");
    let (_o1, ch1) = ChannelSink::new();
    let (_o2, ch2) = ChannelSink::new();

    sup.spawn_agent(spec(&id, "stub-runtime"), ch1)
        .await
        .expect("first spawn failed");
    let err = sup
        .spawn_agent(spec(&id, "stub-runtime"), ch2)
        .await
        .expect_err("a duplicate agent id must fail");
    assert!(err.contains("already exists"), "unhelpful error: {err}");
}

/// Agents and plain terminals coexist in one registry and one snapshot: the UI
/// holds a single terminal map, and `fleet_snapshot` is its single source.
#[tokio::test]
async fn agents_and_plain_terminals_share_one_registry() {
    use agent_studio_scaffold_lib::supervisor::OpenSpec;

    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::interactive()));

    let agent_id = aid("agent");
    let (_o1, ch1) = ChannelSink::new();
    sup.spawn_agent(spec(&agent_id, "stub-runtime"), ch1)
        .await
        .expect("agent_spawn failed");

    let term_id = aid("plain");
    let (_o2, ch2) = ChannelSink::new();
    let (program, args) = common::interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: term_id.clone(),
            program: Some(program),
            args,
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
        },
        ch2,
    )
    .await
    .expect("terminal_open failed");

    let snap = sup.snapshot().await.unwrap();
    assert_eq!(
        snap.terminals.len(),
        2,
        "both terminals must be in the snapshot"
    );
    assert_eq!(
        snap.agents.len(),
        1,
        "the plain terminal must not create an agent node"
    );

    let plain = snap.terminals.iter().find(|t| t.id == term_id).unwrap();
    assert_eq!(plain.kind, TerminalKind::Terminal);
    assert_eq!(plain.agent_id, None, "a plain terminal has no agent");
}

/// An empty fleet is an empty snapshot, not an error — the first thing the UI does
/// on boot is ask.
#[tokio::test]
async fn an_empty_fleet_snapshots_cleanly() {
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::interactive()));
    let snap = sup
        .snapshot()
        .await
        .expect("snapshot of an empty fleet must succeed");
    assert!(snap.agents.is_empty());
    assert!(snap.terminals.is_empty());
}

/// The adapter's declared id is what reaches the wire as `AgentNode.runtime` —
/// the UI groups and routes on it.
#[tokio::test]
async fn the_adapters_id_is_what_lands_on_the_wire() {
    let adapter = Arc::new(StubAdapter::interactive());
    let declared = adapter.id().to_string();
    let (sup, sink) = supervisor_with(adapter);
    let id = aid("agent");
    let (_out, channel) = ChannelSink::new();

    sup.spawn_agent(spec(&id, &declared), channel)
        .await
        .expect("spawn failed");

    assert_eq!(agent_node(&sup, &id).await.runtime, declared);
    match &sink.events()[0] {
        AgentEvent::AgentStarted { runtime, .. } => assert_eq!(runtime, &declared),
        other => panic!("expected agent_started, got {other:?}"),
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async fn agent_node(
    sup: &agent_studio_scaffold_lib::supervisor::SupervisorHandle,
    id: &str,
) -> agent_studio_scaffold_lib::model::AgentNode {
    sup.snapshot()
        .await
        .expect("snapshot failed")
        .agents
        .into_iter()
        .find(|n| n.id == id)
        .unwrap_or_else(|| panic!("agent {id} missing from snapshot"))
}

/// Whether the fleet snapshot still knows this agent. The whole point of "remove
/// on close" is that a *later* snapshot must not resurrect it.
async fn agent_present(
    sup: &agent_studio_scaffold_lib::supervisor::SupervisorHandle,
    id: &str,
) -> bool {
    sup.snapshot()
        .await
        .expect("snapshot failed")
        .agents
        .iter()
        .any(|n| n.id == id)
}

async fn terminal_present(
    sup: &agent_studio_scaffold_lib::supervisor::SupervisorHandle,
    id: &str,
) -> bool {
    sup.snapshot()
        .await
        .expect("snapshot failed")
        .terminals
        .iter()
        .any(|t| t.id == id)
}

/// `ChildExited` is delivered asynchronously by the waiter thread, so poll for it
/// rather than sleeping and hoping.
async fn wait_until_agent_finished(
    sup: &agent_studio_scaffold_lib::supervisor::SupervisorHandle,
    id: &str,
) {
    let start = std::time::Instant::now();
    loop {
        if agent_node(sup, id).await.finished_at.is_some() {
            return;
        }
        if start.elapsed() >= common::TIMEOUT {
            panic!("agent {id} never finished within {:?}", common::TIMEOUT);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
