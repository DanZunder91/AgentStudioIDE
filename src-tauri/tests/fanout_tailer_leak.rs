//! **Security regression: a finished root must not leave a
//! forever-polling fan-out tailer behind.**
//!
//! Dropping a `tauri::async_runtime::JoinHandle` (tokio) *detaches* the task — it
//! does **not** cancel it. So when a root finishes, its tailer has to be explicitly
//! `.abort()`ed, or it keeps re-parsing the now-static transcript from `~/.claude`
//! every poll interval, forever, for every ad-hoc `claude` the user ever ran.
//!
//! The sibling test `fanout_tailer_live.rs` already proves the **close/cascade**
//! abort (there the whole tree is *removed*). This binary covers the two paths where
//! the node is **retained** (as `done`, for inspection) but the tailer must still
//! die:
//!   1. a natural PTY child exit  → `on_child_exited` → `finish_agent_for_terminal`
//!   2. a clean `SessionEnd`      → `on_session_end`
//!
//! The proof in both cases is the same observable: after the root finishes, a brand
//! new sub-agent appears on disk. A live (leaked) tailer would pick it up and grow
//! the tree; an aborted tailer never sees it, so the count holds.
//!
//! Own binary because it points the tailer at a temporary `~/.claude` via `HOME`
//! (process-global) and speeds the poll via `AGENTSTUDIO_FANOUT_POLL_MS`.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::model::AgentStatus;
use agent_studio_scaffold_lib::supervisor::{OpenSpec, SupervisorHandle};
use common::{
    hook_payload, interactive_sh, supervisor_with_hook, test_hook_config, ChannelSink, StubAdapter,
    EOL,
};

const POLL_MS: u64 = 50;

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

async fn agent_count(sup: &SupervisorHandle) -> usize {
    sup.snapshot().await.unwrap().agents.len()
}

async fn wait_agent_count(sup: &SupervisorHandle, at_least: usize, what: &str) {
    let start = Instant::now();
    loop {
        let n = agent_count(sup).await;
        if n >= at_least {
            return;
        }
        if start.elapsed() > Duration::from_secs(15) {
            panic!("timed out waiting for {what}; agent count = {n}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Wait until the root agent (id == `term`) has reached `done`.
async fn wait_root_done(sup: &SupervisorHandle, term: &str) {
    let start = Instant::now();
    loop {
        let snap = sup.snapshot().await.unwrap();
        if let Some(root) = snap.agents.iter().find(|a| a.id == term) {
            if root.status == AgentStatus::Done && root.finished_at.is_some() {
                return;
            }
        }
        if start.elapsed() > Duration::from_secs(15) {
            panic!("timed out waiting for the root to finish");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Drop the committed recursive-fanout fixture on disk as if `session` were a live
/// `claude` under `~/.claude/projects/<project>/`. Returns the `subagents/` dir, so
/// the caller can drop a *new* sub-agent into it after the root has finished.
fn place_fixture(home: &Path, project: &str, session: &str) -> PathBuf {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/transcripts/recursive-fanout");
    let project_dir = home.join(".claude/projects").join(project);
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::copy(
        fixture.join("session.jsonl"),
        project_dir.join(format!("{session}.jsonl")),
    )
    .unwrap();
    let subagents = project_dir.join(session).join("subagents");
    copy_dir(&fixture.join("subagents"), &subagents);
    subagents
}

/// A brand-new sub-agent on disk. A *live* tailer would detect this and grow the
/// tree; an aborted one never does. Named uniquely so it is definitely a new edge.
fn drop_new_subagent(subagents: &Path, name: &str) {
    std::fs::write(
        subagents.join(format!("{name}.meta.json")),
        format!(
            r#"{{"agentType":"general-purpose","description":"{name}","toolUseId":"{name}","spawnDepth":1}}"#
        ),
    )
    .unwrap();
    std::fs::write(
        subagents.join(format!("{name}.jsonl")),
        "{\"agentId\":\"".to_string()
            + name
            + "\",\"cwd\":\"/work/proj\",\"gitBranch\":\"main\"}\n",
    )
    .unwrap();
}

/// Open a plain shell terminal we can later make exit on command.
async fn open_shell(sup: &SupervisorHandle, home: &Path, term: &str) {
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: term.to_string(),
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
}

/// After the root has finished, `subagents` gains a new entry. Assert the tree does
/// not grow across several poll intervals — proof the tailer was aborted, not merely
/// idle. The finished node itself is *retained*, so the count holds at `retained`.
async fn assert_no_resurrection(sup: &SupervisorHandle, retained: usize) {
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        let n = agent_count(sup).await;
        assert_eq!(
            n, retained,
            "a leaked tailer picked up a post-finish sub-agent ({n} agents, expected {retained})"
        );
    }
}

/// Both finish paths, run **sequentially in one test** on purpose: each points the
/// tailer at a private `~/.claude` via the process-global `HOME`, so two parallel
/// `#[tokio::test]`s in one binary would race (tokio runs tailers on a shared global
/// runtime). Scenario A's tailer is aborted before scenario B sets a new `HOME`, so
/// only ever one live tailer reads only ever its own home.
#[tokio::test]
async fn a_finished_root_leaves_no_polling_tailer_behind() {
    // ── Path 1 — a natural PTY child exit aborts the tailer. ──────────────────
    // The ad-hoc root's shell exits on its own → `on_child_exited` →
    // `finish_agent_for_terminal`. The node is kept as `done` (retained for
    // inspection), but its tailer must die, so a sub-agent that appears afterwards
    // is never tailed in.
    {
        let home =
            std::env::temp_dir().join(format!("agentstudio-leak-exit-{}", ulid::Ulid::new()));
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", POLL_MS.to_string());

        let session = "cafe0000-0000-4000-8000-0000000000a1";
        let subagents = place_fixture(&home, "-work-exit", session);

        let (sup, _sink) =
            supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
        let term = format!("term-{}", ulid::Ulid::new());
        open_shell(&sup, &home, &term).await;

        // SessionStart → ad-hoc root + fan-out tailer → all 24 sub-agents tailed in.
        sup.deliver_hook(term.clone(), hook_payload("SessionStart", session, None));
        wait_agent_count(&sup, 25, "root + 24 sub-agents (exit path)").await;

        // Make the shell exit on its own terms → ChildExited → finish (retain done).
        // `EOL`: cmd under ConPTY ends a line on `\r`, so a bare `\n` never runs the
        // `exit`.
        sup.write(term.clone(), format!("exit 0{EOL}").into_bytes())
            .await
            .expect("write failed");
        wait_root_done(&sup, &term).await;

        // The node is retained (a natural exit keeps it for inspection), so the tree
        // is still there — only the tailer must not be.
        let retained = agent_count(&sup).await;
        assert_eq!(retained, 25, "a natural exit must retain the tree");

        drop_new_subagent(&subagents, "zombie-after-exit");
        assert_no_resurrection(&sup, retained).await;

        // Close the terminal so no part of this scenario reads HOME again before B
        // repoints it. (The tailer is already aborted; this is belt-and-braces.)
        sup.close(term).await.ok();
        std::fs::remove_dir_all(&home).ok();
    }

    // ── Path 2 — a clean `SessionEnd` aborts the tailer. ──────────────────────
    // The shell lives on, so `SessionEnd` is the *only* signal the `claude` is over.
    // `on_session_end` marks the ad-hoc root `done` and must abort its tailer, or it
    // re-parses the static transcript forever.
    {
        let home = std::env::temp_dir().join(format!("agentstudio-leak-end-{}", ulid::Ulid::new()));
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", POLL_MS.to_string());

        let session = "cafe0000-0000-4000-8000-0000000000b2";
        let subagents = place_fixture(&home, "-work-end", session);

        let (sup, _sink) =
            supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
        let term = format!("term-{}", ulid::Ulid::new());
        open_shell(&sup, &home, &term).await;

        sup.deliver_hook(term.clone(), hook_payload("SessionStart", session, None));
        wait_agent_count(&sup, 25, "root + 24 sub-agents (end path)").await;

        // The claude session ends (shell survives) → root goes `done`, tailer dies.
        sup.deliver_hook(term.clone(), hook_payload("SessionEnd", session, None));
        wait_root_done(&sup, &term).await;

        let retained = agent_count(&sup).await;
        assert_eq!(
            retained, 25,
            "SessionEnd must retain the tree for inspection"
        );

        drop_new_subagent(&subagents, "zombie-after-end");
        assert_no_resurrection(&sup, retained).await;

        sup.close(term).await.ok();
        std::fs::remove_dir_all(&home).ok();
    }
}
