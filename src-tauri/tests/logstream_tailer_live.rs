//! Tool calls reach the Agent Logs **through the live fan-out tailer loop**: locate the
//! transcript by session id → poll → tail new tool blocks → `SupervisorMsg::ToolEvents`
//! → labelled `tool` / `tool-result` lines in the hub. The real `ClaudeAdapter` does
//! the parsing; no real `claude` runs.
//!
//! Its own binary because it points the locator at a private temp `HOME` (process
//! global) and speeds the poll to 50 ms — the same pattern as `fanout_tailer_live.rs`.
//! The developer's real `~/.claude` is never read, let alone written.

#![cfg(unix)]

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::agent::claude::ClaudeAdapter;
use agent_studio_scaffold_lib::events::NullSink;
use agent_studio_scaffold_lib::logstream::{LogHub, LogKind, LogLevel, LogLine, NullLogSink};
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor_with_logs, OpenSpec};
use common::{hook_payload, interactive_sh, ChannelSink, TIMEOUT};

fn copy_dir(src: &Path, dst: &Path) {
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
                    .map(|l| (&l.kind, &l.source, &l.text))
                    .collect::<Vec<_>>()
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn iso_now() -> String {
    // Seconds precision is enough; the tail only compares against its start time.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn append(path: &PathBuf, line: String) {
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(f, "{line}").unwrap();
}

#[tokio::test]
async fn live_tool_calls_of_a_root_and_its_subagent_reach_the_log_labelled() {
    let home = std::env::temp_dir().join(format!("agentstudio-logtail-{}", ulid::Ulid::new()));
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    // The committed fixture, placed as a live session. Its timestamps are days old,
    // i.e. history: none of its calls may be replayed.
    let session = "cafe0000-0000-4000-8000-00000000106a";
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/logstream/tool-calls");
    let project = home.join(".claude/projects/-work-proj");
    std::fs::create_dir_all(&project).unwrap();
    let root_tx = project.join(format!("{session}.jsonl"));
    std::fs::copy(fixture.join("session.jsonl"), &root_tx).unwrap();
    let subagents = project.join(session).join("subagents");
    copy_dir(&fixture.join("subagents"), &subagents);
    let sub_tx = subagents.join("agent-sublog01.jsonl");

    let hub = LogHub::spawn(Arc::new(NullLogSink));
    let sup = spawn_supervisor_with_logs(
        Arc::new(NullSink),
        vec![Arc::new(ClaudeAdapter::new())],
        None,
        Some(hub.clone()),
    );
    let term = format!("term-{}", ulid::Ulid::new());
    let cwd = home.join("gazelle");
    std::fs::create_dir_all(&cwd).unwrap();
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
    .unwrap();
    // A claude-shaped SessionStart binds the terminal and starts the tailer.
    sup.deliver_hook(term.clone(), hook_payload("SessionStart", session, None));

    // The fan-out still works (the sub-agent node appears) — and says so in the log.
    let started = wait_for_line(&hub, "the sub-agent started line", |l| {
        l.agent_id.as_deref() == Some("sublog01") && l.kind == LogKind::System
    })
    .await;
    assert_eq!(started.text, "sub-agent started (Explore)");
    assert_eq!(started.source, "Explore the parser");
    assert_eq!(started.terminal_id.as_deref(), Some(term.as_str()));

    // Give the tailer several polls over the history, then prove none of it leaked.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let replayed: Vec<String> = hub
        .snapshot()
        .into_iter()
        .filter(|l| matches!(l.kind, LogKind::Tool | LogKind::ToolResult))
        .map(|l| l.text)
        .collect();
    assert!(replayed.is_empty(), "history was replayed: {replayed:?}");

    // Now the session does new work, in the root and in the sub-agent.
    let now = iso_now();
    append(
        &root_tx,
        format!(
            r#"{{"type":"assistant","timestamp":"{now}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_live_01","name":"Bash","input":{{"command":"npm test","description":"Run the suite"}}}}]}}}}"#
        ),
    );
    append(
        &sub_tx,
        format!(
            r#"{{"type":"assistant","isSidechain":true,"agentId":"sublog01","timestamp":"{now}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_live_02","name":"Read","input":{{"file_path":"/work/proj/README.md"}}}}]}}}}"#
        ),
    );
    append(
        &sub_tx,
        format!(
            r#"{{"type":"user","isSidechain":true,"agentId":"sublog01","timestamp":"{now}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_live_02","content":"File does not exist.","is_error":true}}]}}}}"#
        ),
    );

    let bash = wait_for_line(&hub, "the root's Bash call", |l| l.text == "Bash: npm test").await;
    assert_eq!(bash.kind, LogKind::Tool);
    assert_eq!(bash.detail.as_deref(), Some("Run the suite"));
    assert_eq!(
        bash.agent_id.as_deref(),
        Some(term.as_str()),
        "a root's call is the root's"
    );
    assert_eq!(bash.source, "claude · gazelle");
    assert_eq!(bash.terminal_id.as_deref(), Some(term.as_str()));

    let read = wait_for_line(&hub, "the sub-agent's Read call", |l| {
        l.text == "Read: /work/proj/README.md"
    })
    .await;
    assert_eq!(
        read.agent_id.as_deref(),
        Some("sublog01"),
        "the sub-agent made it"
    );
    assert_eq!(read.source, "Explore the parser");
    assert_eq!(
        read.terminal_id.as_deref(),
        Some(term.as_str()),
        "a sub-agent's work lands in its root's terminal"
    );

    let failed = wait_for_line(&hub, "the failed result", |l| l.kind == LogKind::ToolResult).await;
    assert_eq!(failed.text, "Read → File does not exist.");
    assert_eq!(failed.level, LogLevel::Error);
    assert_eq!(failed.agent_id.as_deref(), Some("sublog01"));

    // Deduped across polls: each id exactly once.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let n = |t: &str| hub.snapshot().iter().filter(|l| l.text == t).count();
    assert_eq!(n("Bash: npm test"), 1);
    assert_eq!(n("Read: /work/proj/README.md"), 1);

    sup.close(term).await.unwrap();
    let _ = std::fs::remove_dir_all(&home);
}
