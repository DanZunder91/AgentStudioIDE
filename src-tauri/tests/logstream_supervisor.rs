//! Agent Logs through the **real supervisor and real PTYs**: terminal output becomes
//! lines, lifecycle becomes `system` lines, and a terminal with a bound runtime session
//! is not line-logged — then is again once the session ends.
//!
//! Hermetic: every shell is the config-free `/bin/sh`, never the
//! developer's login shell. The binding is driven by `deliver_hook` with the stub
//! adapter's payload shape (as `adhoc_detection.rs` does) — no real `claude`, no hook
//! listener, no settings file written anywhere.

#![cfg(unix)]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::events::NullSink;
use agent_studio_scaffold_lib::logstream::{LogHub, LogKind, LogLevel, LogLine, NullLogSink};
use agent_studio_scaffold_lib::model::AgentStatus;
use agent_studio_scaffold_lib::supervisor::{
    spawn_supervisor_with_logs, AgentSpawnSpec, OpenSpec, SupervisorHandle,
};
use common::{
    hook_payload, interactive_sh, sh, temp_cwd, wait_for_output, ChannelSink, StubAdapter, TIMEOUT,
};

/// Longer than the hub's 250 ms partial flush + 100 ms emit, so "nothing arrived" means
/// nothing was going to.
const QUIET: Duration = Duration::from_millis(800);

fn tid(label: &str) -> String {
    format!("{label}-{}", ulid::Ulid::new())
}

fn fleet(adapter: StubAdapter) -> (SupervisorHandle, LogHub) {
    let hub = LogHub::spawn(Arc::new(NullLogSink));
    let sup = spawn_supervisor_with_logs(
        Arc::new(NullSink),
        vec![Arc::new(adapter)],
        None,
        Some(hub.clone()),
    );
    (sup, hub)
}

fn lines_for(hub: &LogHub, terminal: &str) -> Vec<LogLine> {
    hub.snapshot()
        .into_iter()
        .filter(|l| l.terminal_id.as_deref() == Some(terminal))
        .collect()
}

async fn wait_for_line(hub: &LogHub, what: &str, pred: impl Fn(&LogLine) -> bool) -> LogLine {
    let start = Instant::now();
    loop {
        if let Some(l) = hub.snapshot().into_iter().find(|l| pred(l)) {
            return l;
        }
        if start.elapsed() >= TIMEOUT {
            panic!(
                "timed out waiting for {what}; ring = {:#?}",
                hub.snapshot()
                    .iter()
                    .map(|l| (&l.kind, &l.text))
                    .collect::<Vec<_>>()
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_status(sup: &SupervisorHandle, id: &str, status: AgentStatus) {
    let start = Instant::now();
    loop {
        let node = sup
            .snapshot()
            .await
            .unwrap()
            .agents
            .into_iter()
            .find(|n| n.id == id);
        if node.as_ref().map(|n| n.status) == Some(status) {
            return;
        }
        if start.elapsed() >= TIMEOUT {
            panic!("timed out waiting for {id} to be {status:?}; node = {node:?}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn terminal_output_and_lifecycle_become_lines() {
    let (sup, hub) = fleet(StubAdapter::interactive());
    let id = tid("term");
    let cwd = temp_cwd();
    let (_out, channel) = ChannelSink::new();
    let (program, args) =
        sh("printf 'hello-%s\\n' 42; printf '\\033[31merror: red\\033[0m\\n'; exit 3");
    sup.open_terminal(
        OpenSpec {
            terminal_id: id.clone(),
            program: Some(program),
            args,
            cwd: cwd.clone(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .unwrap();

    let exited = wait_for_line(&hub, "the exit line", |l| {
        l.terminal_id.as_deref() == Some(id.as_str()) && l.text.starts_with("terminal exited")
    })
    .await;
    assert_eq!(exited.text, "terminal exited (code 3)");
    assert_eq!(exited.level, LogLevel::Warn, "a non-zero exit is a warning");
    assert_eq!(exited.kind, LogKind::System);

    // Let the final output flush through the hub.
    wait_for_line(&hub, "the red line", |l| l.text == "error: red").await;
    let lines = lines_for(&hub, &id);
    let base = std::path::Path::new(&cwd)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let label = format!("sh · {base}");

    let opened = &lines[0];
    assert_eq!(opened.kind, LogKind::System);
    assert!(
        opened.text.starts_with("terminal opened · sh in "),
        "{}",
        opened.text
    );
    assert_eq!(opened.source, label);

    let hello = lines
        .iter()
        .find(|l| l.text == "hello-42")
        .expect("output line");
    assert_eq!(hello.kind, LogKind::Output);
    assert_eq!(hello.source, label);
    assert_eq!(hello.level, LogLevel::Info);
    let red = lines.iter().find(|l| l.text == "error: red").unwrap();
    assert_eq!(
        red.level,
        LogLevel::Error,
        "ANSI stripped, then the heuristic"
    );

    let ids: Vec<u64> = hub.snapshot().iter().map(|l| l.id).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "ids are monotonic");
}

/// **The user-facing rule**: while a `claude` session is bound to a terminal its
/// TUI is not logged (the transcript carries the signal); before it and after it, the
/// shell is logged as usual.
#[tokio::test]
async fn a_bound_session_suppresses_its_terminal_until_it_ends() {
    let (sup, hub) = fleet(StubAdapter::interactive());
    let id = tid("term");
    let (out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: id.clone(),
            program: Some(program),
            args,
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .unwrap();

    // `$((…))` so the command's own echo can never satisfy the needle.
    sup.write(id.clone(), b"echo pre-$((6*7))\n".to_vec())
        .await
        .unwrap();
    wait_for_line(&hub, "pre-42 logged", |l| l.text == "pre-42").await;
    assert_eq!(hub.is_suppressed(&id), Some(false));

    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-log-1", None));
    wait_for_status(&sup, &id, AgentStatus::Idle).await;
    assert_eq!(hub.is_suppressed(&id), Some(true), "bound ⇒ suppressed");
    wait_for_line(&hub, "the agent-started line", |l| {
        l.kind == LogKind::System
            && l.agent_id.as_deref() == Some(id.as_str())
            && l.text.starts_with("agent started · stub-runtime in ")
    })
    .await;

    sup.write(id.clone(), b"echo mid-$((6*7))\n".to_vec())
        .await
        .unwrap();
    wait_for_output(&out, "mid-42").await; // the terminal itself saw it…
    tokio::time::sleep(QUIET).await;
    let leaked: Vec<String> = lines_for(&hub, &id)
        .into_iter()
        .filter(|l| l.kind == LogKind::Output && l.text.contains("mid-"))
        .map(|l| l.text)
        .collect();
    assert!(leaked.is_empty(), "…the log must not: {leaked:?}");

    sup.deliver_hook(id.clone(), hook_payload("SessionEnd", "sess-log-1", None));
    wait_for_status(&sup, &id, AgentStatus::Done).await;
    assert_eq!(
        hub.is_suppressed(&id),
        Some(false),
        "unbound ⇒ logged again"
    );
    wait_for_line(&hub, "the session-ended line", |l| {
        l.agent_id.as_deref() == Some(id.as_str()) && l.text == "agent session ended"
    })
    .await;

    sup.write(id.clone(), b"echo post-$((6*7))\n".to_vec())
        .await
        .unwrap();
    wait_for_line(&hub, "post-42 logged", |l| l.text == "post-42").await;

    sup.close(id.clone()).await.unwrap();
    wait_for_line(&hub, "the closed line", |l| {
        l.terminal_id.as_deref() == Some(id.as_str()) && l.text == "terminal closed"
    })
    .await;
    assert_eq!(
        hub.is_suppressed(&id),
        None,
        "a closed terminal is forgotten"
    );
}

/// A **spawned** agent's terminal is bound from birth, so even its very first output
/// (before the supervisor records the binding) is never line-logged.
#[tokio::test]
async fn a_spawned_agents_terminal_is_suppressed_from_its_first_byte() {
    let (sup, hub) = fleet(StubAdapter::running(
        "printf 'first-paint-%s\\n' 42; while read -r _; do :; done",
    ));
    let id = tid("agent");
    let (out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: id.clone(),
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
    .unwrap();

    wait_for_output(&out, "first-paint-42").await;
    tokio::time::sleep(QUIET).await;
    let lines = lines_for(&hub, &id);
    assert!(
        lines.iter().all(|l| l.kind != LogKind::Output),
        "a bound agent terminal leaked output lines: {:?}",
        lines.iter().map(|l| &l.text).collect::<Vec<_>>()
    );
    assert!(
        lines
            .iter()
            .any(|l| l.text.starts_with("agent started · stub-runtime")),
        "lifecycle lines are still logged: {:?}",
        lines.iter().map(|l| &l.text).collect::<Vec<_>>()
    );
}
