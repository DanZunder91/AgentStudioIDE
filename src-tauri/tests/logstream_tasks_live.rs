//! Background-task output reaches Agent Logs through the live tailer loop (`TaskLines` →
//! `task` lines on the root terminal); a `Monitor` is tailed at the adapter-derived path. Own
//! binary: `HOME` and `TMPDIR` (process globals) point at temp dirs; no real `claude` runs.

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

fn append(path: &Path, s: &str) {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(s.as_bytes()).unwrap();
}

fn transcript(name: &str, task_path: &Path) -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/logstream/tasks")
            .join(name),
    )
    .unwrap()
    .replace("@NOW@", &iso_now())
    .replace("@TASK_PATH@", &task_path.to_string_lossy())
}

#[tokio::test]
async fn a_background_task_logs_on_its_agents_terminal_until_task_stop() {
    let base = std::env::temp_dir().join(format!("agentstudio-tasklive-{}", ulid::Ulid::new()));
    let home = base.join("home");
    let tmp = base.join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("TMPDIR", &tmp);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    let session = "7a5c0000-0000-4000-8000-0000000074a5";
    let project = home.join(".claude/projects/-work-gazelle");
    std::fs::create_dir_all(&project).unwrap();
    let root_tx = project.join(format!("{session}.jsonl"));
    std::fs::write(&root_tx, "").unwrap();
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let tasks = tmp
        .join(format!("claude-{uid}"))
        .join("-work-gazelle")
        .join(session)
        .join("tasks");
    std::fs::create_dir_all(&tasks).unwrap();
    let gazelle_out = tasks.join("bgen1a2b3.output");
    std::fs::write(
        &gazelle_out,
        "2026-01-01T12:00:05.152Z  INFO gazelle: listening on 0.0.0.0:8080\n",
    )
    .unwrap();
    // The Monitor's file, at the path the adapter must derive (its result names none).
    std::fs::write(
        tasks.join("bmon4c5d6.output"),
        "2026-01-01T12:00:09.000Z ERROR gazelle: panicked at src/main.rs:1:1\n",
    )
    .unwrap();

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
    sup.deliver_hook(term.clone(), hook_payload("SessionStart", session, None));
    wait_for_line(&hub, "agent started", |l| {
        l.text.starts_with("agent started")
    })
    .await;

    // The agent launches gazelle in the background (and a Monitor).
    append(&root_tx, &transcript("start.jsonl", &gazelle_out));

    let startup = wait_for_line(&hub, "gazelle's startup line", |l| {
        l.kind == LogKind::Task && l.text.contains("listening on 0.0.0.0:8080")
    })
    .await;
    assert_eq!(startup.source, "gazelle · bg");
    assert_eq!(startup.level, LogLevel::Info);
    assert_eq!(startup.agent_id.as_deref(), Some(term.as_str()));
    assert_eq!(
        startup.terminal_id.as_deref(),
        Some(term.as_str()),
        "a task line lands on its agent's root terminal"
    );
    assert_eq!(
        startup.detail.as_deref(),
        Some(
            format!(
                "cd /work/gazelle && RUST_LOG=info ./target/debug/gazelle serve\n{}",
                gazelle_out.display()
            )
            .as_str()
        )
    );

    let monitor = wait_for_line(&hub, "the Monitor's line (derived path)", |l| {
        l.kind == LogKind::Task && l.text.contains("panicked")
    })
    .await;
    assert_eq!(monitor.source, "tail · bg");
    assert_eq!(monitor.level, LogLevel::Error);
    assert_eq!(monitor.terminal_id.as_deref(), Some(term.as_str()));

    // Output written after the start arrives live.
    append(
        &gazelle_out,
        "2026-01-01T12:00:06.002Z  INFO gazelle::api: GET /health 200\n",
    );
    wait_for_line(&hub, "the /health line", |l| {
        l.kind == LogKind::Task && l.text.ends_with("GET /health 200")
    })
    .await;

    // TaskStop ends the tail.
    append(&root_tx, &transcript("stop.jsonl", &gazelle_out));
    let started = wait_for_line(&hub, "the started line", |l| {
        l.text == "background task started · gazelle (bgen1a2b3)"
    })
    .await;
    assert_eq!(started.kind, LogKind::System);
    assert_eq!(started.source, "gazelle · bg");
    assert_eq!(started.terminal_id.as_deref(), Some(term.as_str()));
    let stopped = wait_for_line(&hub, "the stopped line", |l| {
        l.text == "background task stopped · gazelle (bgen1a2b3) — stopped by the agent"
    })
    .await;
    assert_eq!(stopped.source, "gazelle · bg");
    assert_eq!(stopped.kind, LogKind::System);
    assert_eq!(stopped.terminal_id.as_deref(), Some(term.as_str()));
    append(&gazelle_out, "after the stop\n");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !hub.snapshot().iter().any(|l| l.text == "after the stop"),
        "a stopped task is no longer read"
    );

    // The session ends: the Monitor's tail, still open, closes with it.
    sup.deliver_hook(term.clone(), hook_payload("SessionEnd", session, None));
    let ended = wait_for_line(&hub, "the session-ended line", |l| {
        l.text == "background task stopped · tail (bmon4c5d6) — session ended"
    })
    .await;
    assert_eq!(ended.terminal_id.as_deref(), Some(term.as_str()));
    assert_eq!(ended.source, "tail · bg");

    sup.close(term).await.unwrap();
    let _ = std::fs::remove_dir_all(&base);
}
