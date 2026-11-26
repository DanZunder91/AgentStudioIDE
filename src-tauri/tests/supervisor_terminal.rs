//! Integration tests of the hot plane through the public supervisor API (the `#[tauri::command]`
//! path): actor, real PTY, child, reader thread, mpsc, coalescer, real `ipc::Channel`. Only the
//! Channel's handler is swapped, to record bytes (`common::ChannelSink`).

mod common;

use std::time::Duration;

use agent_studio_scaffold_lib::events::NullSink;
use agent_studio_scaffold_lib::pty::default_shell;
#[cfg(unix)]
use agent_studio_scaffold_lib::supervisor::TerminalBusy;
use agent_studio_scaffold_lib::supervisor::{
    spawn_supervisor, AgentSpawnSpec, BusyReason, OpenSpec, SupervisorHandle,
};
use common::{
    interactive_sh, sh, sleep_secs, supervisor_with, temp_cwd, then, wait_for_output,
    wait_for_quiet, ChannelSink, StubAdapter,
};

// Used only by the `#[cfg(unix)]` tests below (the marker-file kill check and the
// fd-leak check). Gated to match, or the Windows build warns about unused imports
// — which `clippy --all-targets -- -D warnings` turns into a failed Windows CI leg.
#[cfg(unix)]
use common::{wait_until, EOL};

/// Unique per terminal so tests never collide in the registry.
fn tid(label: &str) -> String {
    format!("{label}-{}", ulid::Ulid::new())
}

fn open_spec(id: &str, program: String, args: Vec<String>, rows: u16, cols: u16) -> OpenSpec {
    OpenSpec {
        terminal_id: id.to_string(),
        program: Some(program),
        args,
        cwd: temp_cwd(),
        rows,
        cols,
    }
}

/// Supervisor + an opened terminal + its output sink.
async fn open_terminal(
    program: String,
    args: Vec<String>,
    rows: u16,
    cols: u16,
) -> (SupervisorHandle, String, ChannelSink) {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let id = tid("term");
    let (sink, channel) = ChannelSink::new();
    let meta = sup
        .open_terminal(open_spec(&id, program, args, rows, cols), channel)
        .await
        .expect("terminal_open failed");
    assert_eq!(meta.id, id);
    (sup, id, sink)
}

/// End to end: open a terminal, and the child's bytes actually arrive on the
/// channel the UI handed us.
#[tokio::test]
async fn open_streams_real_child_output_to_the_channel() {
    let (program, args) = sh("echo hello");
    let (_sup, _id, sink) = open_terminal(program, args, 24, 80).await;

    wait_for_output(&sink, "hello").await;
}

/// `TerminalMeta` is the UI's whole record of the terminal — pin what `open`
/// returns, including the `/bin/zsh` → `zsh` title derivation.
#[tokio::test]
async fn open_returns_meta_describing_the_terminal() {
    use agent_studio_scaffold_lib::model::{TerminalKind, TerminalStatus};

    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let id = tid("meta");
    let (_sink, channel) = ChannelSink::new();
    let (program, args) = sh("echo hi");
    let expected_title = std::path::Path::new(&program)
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let meta = sup
        .open_terminal(open_spec(&id, program, args, 30, 100), channel)
        .await
        .expect("terminal_open failed");

    assert_eq!(meta.id, id);
    assert_eq!(meta.kind, TerminalKind::Terminal);
    assert_eq!(meta.status, TerminalStatus::Live);
    assert_eq!(meta.rows, 30);
    assert_eq!(meta.cols, 100);
    assert_eq!(meta.cwd, temp_cwd());
    assert_eq!(meta.exit_code, None);
    assert_eq!(meta.agent_id, None);
    // Title is the program's file stem, not its full path.
    assert_eq!(meta.title, expected_title);
}

/// Asserts the resolution (the tab title is the default shell's name), not typed input: a real
/// login zsh's rc files can mangle typed bytes. `$SHELL` is not pinned because tests run in
/// parallel threads and a global `set_var` races.
#[tokio::test]
async fn open_without_a_program_uses_the_default_shell() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let id = tid("default-shell");
    let (_sink, channel) = ChannelSink::new();

    let meta = sup
        .open_terminal(
            OpenSpec {
                terminal_id: id,
                program: None,
                args: Vec::new(),
                cwd: temp_cwd(),
                rows: 24,
                cols: 80,
            },
            channel,
        )
        .await
        .expect("terminal_open with the default shell failed");

    // `None` resolves to `pty::default_shell()`; the tab title is that program's
    // file stem (`/bin/zsh` → `zsh`), mirroring supervisor's private `program_title`.
    let shell = default_shell();
    let expected = std::path::Path::new(&shell)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| shell.clone());
    assert_eq!(
        meta.title, expected,
        "program: None should open the default shell ({shell})"
    );
}

/// Keystrokes reach the child and its output comes back — the round trip a user
/// makes on every line they type.
#[tokio::test]
async fn write_round_trips_through_a_real_shell() {
    let (program, args) = interactive_sh();
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;

    let (lines, needle) = common::round_trip_probe();
    for line in lines {
        sup.write(id.clone(), line.into_bytes())
            .await
            .expect("write failed");
    }

    wait_for_output(&sink, needle).await;
}

/// `stty size` asks the tty driver, so this proves the resize reached the child, not just `Ok`.
/// Unix-only (no stable ConPTY equivalent); `resize_is_accepted_on_a_live_terminal` covers ConPTY.
#[cfg(unix)]
#[tokio::test]
async fn resize_is_observed_by_the_child() {
    // Prints its tty size every time we press Enter.
    let (program, args) = sh("while read -r _; do stty size; done");
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;

    // The size the PTY was allocated with is the size the child was born into —
    // this is why `openpty` takes the size up front (Claude's first paint).
    sup.write(id.clone(), b"\n".to_vec())
        .await
        .expect("write failed");
    wait_for_output(&sink, "24 80").await;

    sup.resize(id.clone(), 40, 120)
        .await
        .expect("resize failed");

    // Poke the child until it reports the new size. Polling (rather than one
    // write + a sleep) is what keeps this non-flaky on a loaded runner: SIGWINCH
    // delivery and the child's next read are not synchronised with each other.
    let poke = id.clone();
    let poke_sup = sup.clone();
    let poker = tokio::spawn(async move {
        loop {
            if poke_sup.write(poke.clone(), b"\n".to_vec()).await.is_err() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    wait_for_output(&sink, "40 120").await;
    poker.abort();
}

/// ConPTY has no `stty`, so on Windows we can only assert the control path:
/// resize is accepted and the terminal keeps streaming afterwards.
#[cfg(windows)]
#[tokio::test]
async fn resize_is_accepted_on_a_live_terminal() {
    let (program, args) = interactive_sh();
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;

    sup.resize(id.clone(), 40, 120)
        .await
        .expect("resize failed");

    // Still alive and streaming after the resize.
    let (lines, needle) = common::round_trip_probe();
    for line in lines {
        sup.write(id.clone(), line.into_bytes())
            .await
            .expect("write failed");
    }
    wait_for_output(&sink, needle).await;
}

/// Resizing must not disturb a live child: it keeps running and keeps streaming.
#[cfg(unix)]
#[tokio::test]
async fn resize_does_not_kill_the_child() {
    let (program, args) = interactive_sh();
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;

    for (rows, cols) in [(40u16, 120u16), (10, 40), (60, 200), (24, 80)] {
        sup.resize(id.clone(), rows, cols)
            .await
            .expect("resize failed");
    }

    let (lines, needle) = common::round_trip_probe();
    for line in lines {
        sup.write(id.clone(), line.into_bytes())
            .await
            .expect("write failed");
    }
    wait_for_output(&sink, needle).await;
}

/// The final flush is load-bearing: `echo` writes and exits at once, so its bytes are still pending
/// in the coalescer when the channel closes; losing them hides a terminal's last line.
#[tokio::test]
async fn child_exit_flushes_pending_output_and_closes_the_stream() {
    let (program, args) = sh(&then("echo last-line-before-exit", "exit 0"));
    let (_sup, _id, sink) = open_terminal(program, args, 24, 80).await;

    wait_for_output(&sink, "last-line-before-exit").await;

    // The stream stops rather than idling: the coalescer returned after its
    // final flush instead of ticking forever on a dead PTY.
    wait_for_quiet(&sink, Duration::from_millis(300)).await;
}

/// The exited terminal's meta is kept for the UI, so a keystroke racing the exit is a no-op. The
/// only public proof `ChildExited` was processed: an unknown terminal errors, an exited one does
/// not (`status`/`exitCode` cannot be read back).
#[tokio::test]
async fn writes_to_an_exited_terminal_are_no_ops_not_errors() {
    let (program, args) = sh(&then("echo done-now", "exit 7"));
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;

    wait_for_output(&sink, "done-now").await;

    // Once the stream has gone quiet the child is provably gone, so the waiter
    // thread has sent `ChildExited` and the actor has processed it (it is the
    // same mpsc our next call queues behind).
    wait_for_quiet(&sink, Duration::from_millis(300)).await;

    // Had `ChildExited` not cleared the PTY, this write would hit a dead master and fail with EIO.
    sup.write(id.clone(), b"ignored\n".to_vec())
        .await
        .expect("write to an exited terminal should be a no-op, not an error");
    sup.resize(id.clone(), 30, 100)
        .await
        .expect("resize of an exited terminal should be a no-op, not an error");

    // …and closing it still succeeds.
    sup.close(id.clone())
        .await
        .expect("closing an exited terminal should succeed");

    // After close it is genuinely gone: the id now errors like any unknown one.
    let err = sup
        .write(id, b"x".to_vec())
        .await
        .expect_err("a closed terminal must become unknown");
    assert!(err.contains("unknown terminal"), "unhelpful error: {err}");
}

/// Pins only the stream: `close` also aborts the pump, so a quiet stream is consistent with a live
/// child (mutating `drop(rt.pty)` to `mem::forget` stays green). `close_actually_kills_the_child`
/// pins the kill.
#[tokio::test]
async fn close_stops_the_stream_to_the_ui() {
    #[cfg(not(windows))]
    let (program, args) = sh("while :; do echo tick; sleep 0.05; done");
    #[cfg(windows)]
    let (program, args) = sh("for /L %i in (1,0,2) do @echo tick");

    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;
    wait_for_output(&sink, "tick").await;

    sup.close(id).await.expect("close failed");

    wait_for_quiet(&sink, Duration::from_millis(500)).await;
}

/// A closed tab whose process lives on is an invisible leak (an orphaned `claude`). Liveness is
/// read from the filesystem because `close` aborts the pump, so the stream goes quiet either way.
/// Unix-only: needs a sub-second sleep loop; `cmd.exe` has no `sleep`.
#[cfg(unix)]
#[tokio::test]
async fn close_actually_kills_the_child() {
    let marker = std::env::temp_dir().join(format!("agentstudio-close-{}", ulid::Ulid::new()));
    let _ = std::fs::remove_file(&marker);

    let ticks = || std::fs::metadata(&marker).map(|m| m.len()).unwrap_or(0);

    let (program, args) = sh(&format!(
        "while :; do echo tick >> {}; sleep 0.05; done",
        marker.display()
    ));
    let (sup, id, _sink) = open_terminal(program, args, 24, 80).await;

    // The child is definitely alive and looping.
    wait_until(|| ticks() > 0, "the child to start writing its marker file").await;

    sup.close(id).await.expect("close failed");

    // Let the kill land, then require the file to stop growing. ~10 tick
    // intervals of silence: a surviving child would have appended long before.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let after_close = ticks();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let settled = ticks();
    let _ = std::fs::remove_file(&marker);

    assert_eq!(
        settled,
        after_close,
        "the child kept writing {} bytes after close — it was not killed",
        settled - after_close
    );
}

// ── Rejecting bad input: an unknown id must ERROR, never silently succeed ──

#[tokio::test]
async fn write_to_an_unknown_terminal_errors() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let err = sup
        .write("no-such-terminal".to_string(), b"x".to_vec())
        .await
        .expect_err("writing to an unknown terminal must not silently succeed");
    assert!(err.contains("unknown terminal"), "unhelpful error: {err}");
}

#[tokio::test]
async fn resize_of_an_unknown_terminal_errors() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let err = sup
        .resize("no-such-terminal".to_string(), 24, 80)
        .await
        .expect_err("resizing an unknown terminal must not silently succeed");
    assert!(err.contains("unknown terminal"), "unhelpful error: {err}");
}

#[tokio::test]
async fn close_of_an_unknown_terminal_errors() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let err = sup
        .close("no-such-terminal".to_string())
        .await
        .expect_err("closing an unknown terminal must not silently succeed");
    assert!(err.contains("unknown terminal"), "unhelpful error: {err}");
}

/// Reusing a live terminal's id would orphan the first PTY — reject it.
#[tokio::test]
async fn opening_a_duplicate_terminal_id_errors() {
    let (program, args) = interactive_sh();
    let (sup, id, _sink) = open_terminal(program.clone(), args.clone(), 24, 80).await;

    let (_sink2, channel2) = ChannelSink::new();
    let err = sup
        .open_terminal(open_spec(&id, program, args, 24, 80), channel2)
        .await
        .expect_err("reopening a live terminal id must fail");
    assert!(err.contains("already open"), "unhelpful error: {err}");
}

/// A bad program is a failed open, not a registered-but-broken terminal — and the
/// id must be free afterwards.
#[tokio::test]
async fn opening_a_nonexistent_program_errors_and_frees_the_id() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let id = tid("bad-program");
    let (_sink, channel) = ChannelSink::new();

    let err = sup
        .open_terminal(
            open_spec(
                &id,
                "definitely-not-a-real-program-9d3f1a".to_string(),
                vec![],
                24,
                80,
            ),
            channel,
        )
        .await
        .expect_err("spawning a nonexistent program must fail");
    assert!(!err.is_empty());

    // The failed open must not have reserved the id.
    let (program, args) = sh("echo recovered");
    let (sink2, channel2) = ChannelSink::new();
    sup.open_terminal(open_spec(&id, program, args, 24, 80), channel2)
        .await
        .expect("the id must be free after a failed open");
    wait_for_output(&sink2, "recovered").await;
}

/// The supervisor is one actor for the whole fleet: terminals must stay isolated,
/// each child's bytes going only to its own channel. A crossed wire here would
/// paint one agent's output into another's pane.
#[tokio::test]
async fn terminals_are_isolated_from_each_other() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let mut sinks = Vec::new();

    for n in 0..4 {
        let id = tid(&format!("iso-{n}"));
        let (sink, channel) = ChannelSink::new();
        let (program, args) = sh(&format!("echo marker-{n}"));
        sup.open_terminal(open_spec(&id, program, args, 24, 80), channel)
            .await
            .expect("terminal_open failed");
        sinks.push((n, sink));
    }

    for (n, sink) in &sinks {
        wait_for_output(sink, &format!("marker-{n}")).await;
    }

    // Each sink saw only its own child.
    for (n, sink) in &sinks {
        let text = sink.text();
        for (other, _) in &sinks {
            if other != n {
                assert!(
                    !text.contains(&format!("marker-{other}")),
                    "terminal {n} received terminal {other}'s bytes"
                );
            }
        }
    }
}

/// Terminal teardown must release the PTY master and the reader's cloned fd. A
/// leak here is invisible until a long-lived session hits the process fd limit
/// and every subsequent `openpty` fails.
#[cfg(unix)]
#[tokio::test]
async fn opening_and_closing_terminals_does_not_leak_fds() {
    use common::open_fd_count;

    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);

    let cycle = |sup: SupervisorHandle| async move {
        let id = tid("fd");
        let (sink, channel) = ChannelSink::new();
        let (program, args) = interactive_sh();
        sup.open_terminal(open_spec(&id, program, args, 24, 80), channel)
            .await
            .expect("terminal_open failed");
        sup.write(id.clone(), format!("echo fd-probe{EOL}").into_bytes())
            .await
            .expect("write failed");
        wait_for_output(&sink, "fd-probe").await;
        sup.close(id).await.expect("close failed");
    };

    // Warm up: the tokio runtime and the PTY subsystem allocate some fds once.
    // Measuring from cold would attribute those one-off fds to the first cycle.
    for _ in 0..2 {
        cycle(sup.clone()).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let baseline = open_fd_count();
    const CYCLES: usize = 10;
    for _ in 0..CYCLES {
        cycle(sup.clone()).await;
    }

    // Teardown is asynchronous (kill → child dies → reader thread returns from
    // its blocking read → drops its fd), so converge rather than sample once.
    // A real leak is ~2 fds/terminal = ~20 here; the slack only absorbs jitter.
    let slack = 8;
    wait_until(
        || open_fd_count() <= baseline + slack,
        &format!(
            "fds to be released after {CYCLES} open/close cycles \
             (baseline {baseline}, now {}, allowed {})",
            open_fd_count(),
            baseline + slack
        ),
    )
    .await;
}

// ── Re-attach after a webview reload ─────────────────────────────────────────

/// **A live terminal re-binds to a fresh Channel and replays its scrollback.**
/// This is the webview-reload path: the old Channel is dead, the PTY is still
/// running, and `reattach` must stream to the new sink.
#[tokio::test]
async fn reattach_swaps_the_channel_and_replays_scrollback() {
    let (program, args) = sh(&then("echo scrollback-line", &sleep_secs(30)));
    let (sup, id, first) = open_terminal(program, args, 24, 80).await;

    // Produce some output on the original Channel.
    wait_for_output(&first, "scrollback-line").await;

    // The webview reloads: hand the live terminal a brand-new Channel.
    let (second, channel2) = ChannelSink::new();
    let meta = sup
        .reattach(id.clone(), channel2)
        .await
        .expect("reattach of a live terminal should succeed");
    assert_eq!(
        meta.status,
        agent_studio_scaffold_lib::model::TerminalStatus::Live,
        "a live terminal must reattach with status live"
    );

    // The scrollback ring is replayed into the fresh sink.
    wait_for_output(&second, "scrollback-line").await;
}

/// After reattach, **new** output flows to the new Channel, and typing still works
/// end-to-end through the re-bound terminal.
#[tokio::test]
async fn a_reattached_terminal_streams_new_output_and_accepts_input() {
    let (program, args) = interactive_sh();
    let (sup, id, _first) = open_terminal(program, args, 24, 80).await;

    let (second, channel2) = ChannelSink::new();
    sup.reattach(id.clone(), channel2)
        .await
        .expect("reattach failed");

    // Type a probe; its result must appear on the NEW channel.
    let (lines, needle) = common::round_trip_probe();
    for line in lines {
        sup.write(id.clone(), line.into_bytes())
            .await
            .expect("write failed");
    }
    wait_for_output(&second, needle).await;
}

/// **Reattaching an EXITED terminal returns its meta with status `exited`** (no
/// pump to attach) — the frontend shows "session ended", not a blank pane.
#[tokio::test]
async fn reattach_to_an_exited_terminal_reports_exited_not_error() {
    let (program, args) = sh(&then("echo bye", "exit 5"));
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;
    wait_for_output(&sink, "bye").await;
    wait_for_quiet(&sink, Duration::from_millis(300)).await;

    let (_s2, channel2) = ChannelSink::new();
    let meta = sup
        .reattach(id.clone(), channel2)
        .await
        .expect("reattach of an exited terminal returns meta, not an error");
    assert_eq!(
        meta.status,
        agent_studio_scaffold_lib::model::TerminalStatus::Exited,
        "an exited terminal must reattach as exited"
    );
    assert_eq!(
        meta.exit_code,
        Some(5),
        "the exit code survives for the frontend"
    );
}

/// Reattaching a terminal that was never opened is a distinct error (not a silent
/// success, not an exited meta).
#[tokio::test]
async fn reattach_to_an_unknown_terminal_errors() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let (_s, channel) = ChannelSink::new();
    let err = sup
        .reattach("never-opened".to_string(), channel)
        .await
        .expect_err("an unknown terminal must not reattach");
    assert!(err.contains("unknown terminal"), "unhelpful error: {err}");
}

/// Re-attach must not disturb the genuine double-open guard: `open_terminal` still
/// errors on a live duplicate id.
#[tokio::test]
async fn open_still_rejects_a_duplicate_id_after_reattach_exists() {
    let (program, args) = interactive_sh();
    let (sup, id, _sink) = open_terminal(program.clone(), args.clone(), 24, 80).await;

    let (_s2, channel2) = ChannelSink::new();
    let err = sup
        .open_terminal(open_spec(&id, program, args, 24, 80), channel2)
        .await
        .expect_err("a genuine double-open must still fail");
    assert!(err.contains("already open"), "unhelpful error: {err}");
}

// ── cwd hygiene: a stray "." must never reach the PTY ─────────────────────────

/// Opening a terminal with `cwd = "."` substitutes the default workspace (an
/// absolute dir), so the PTY never lands in the app binary's dir (the wrong-project
/// / no-history bug). Verified through the real open path.
#[tokio::test]
async fn opening_with_a_dot_cwd_substitutes_the_default_workspace() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    let id = tid("dot");
    let (_sink, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    let meta = sup
        .open_terminal(
            OpenSpec {
                terminal_id: id.clone(),
                program: Some(program),
                args,
                cwd: ".".to_string(),
                rows: 24,
                cols: 80,
            },
            channel,
        )
        .await
        .expect("terminal_open failed");

    let expected = agent_studio_scaffold_lib::workspace::default_workspace_dir()
        .to_string_lossy()
        .into_owned();
    assert_ne!(meta.cwd, ".", "a '.' cwd must not survive to the terminal");
    assert_eq!(
        meta.cwd, expected,
        "cwd must be the absolute default workspace"
    );
    assert!(std::path::Path::new(&meta.cwd).is_absolute());
}

// ── The close confirmation: `terminals_busy` ─────────────────────────────────
// Two tiers, each blind where the other sees (`supervisor::TerminalBusy`): a bound session (exact,
// all platforms) and a foreground command (Unix), on real PTYs since the mechanism is the OS's.

/// This terminal's entry in a `terminals_busy` answer, or `None` if it is absent.
#[cfg(unix)]
async fn busy_of(sup: &SupervisorHandle, id: &str) -> Option<TerminalBusy> {
    sup.terminals_busy(vec![id.to_string()])
        .await
        .expect("terminals_busy must never error")
        .into_iter()
        .find(|b| b.id == id)
}

/// Polled, not slept on: fork + `tcsetpgrp` takes microseconds idle and longer under load.
#[cfg(unix)]
async fn wait_for_busy(
    sup: &SupervisorHandle,
    id: &str,
    want: bool,
    what: &str,
) -> Option<TerminalBusy> {
    let start = std::time::Instant::now();
    loop {
        let got = busy_of(sup, id).await;
        if got.is_some() == want {
            return got;
        }
        assert!(
            start.elapsed() < common::TIMEOUT,
            "timed out after {:?} waiting for {what} (busy = {:?})",
            common::TIMEOUT,
            got
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Prompt idle, foreground `sleep` busy, idle again: each half alone passes a build that is always
/// or never busy, and the third proves the answer is live. The child leads its own session, so
/// `tcgetpgrp(master) != child pid` means a job is in front. Unix-only: ConPTY has no groups.
#[cfg(unix)]
#[tokio::test]
async fn a_foreground_command_makes_a_shell_busy_and_finishing_it_makes_it_idle() {
    let (program, args) = interactive_sh();
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;

    // Wait for the prompt first (`echo` is a builtin, so no job is forked), or the idle half could
    // pass only because the shell had not finished starting.
    sup.write(id.clone(), format!("echo prompt-ready{EOL}").into_bytes())
        .await
        .expect("write failed");
    wait_for_output(&sink, "prompt-ready").await;

    assert_eq!(
        busy_of(&sup, &id).await,
        None,
        "a shell sitting at its prompt must not be reported busy"
    );

    // Hand the tty to a real foreground job.
    sup.write(id.clone(), format!("sleep 3{EOL}").into_bytes())
        .await
        .expect("write failed");

    let busy = wait_for_busy(&sup, &id, true, "the foreground `sleep` to be seen")
        .await
        .expect("wait_for_busy(true) returns the entry");
    assert_eq!(busy.reason, BusyReason::Command);
    assert_eq!(
        busy.label, "sh",
        "the label is the terminal's title, never scraped from its output"
    );

    // …and it clears by itself when the job finishes. A latch would hang here.
    wait_for_busy(
        &sup,
        &id,
        false,
        "the `sleep` to finish and the terminal to go idle",
    )
    .await;
}

/// One call answers for both because `closePane` kills a whole pane. The agent is `Idle` at its
/// prompt (no `Stop` ever fires), the session most likely lost; a `Running` gate would miss it.
/// This tier reads the binding table, so it is exact everywhere and sees `claude` as the PTY child.
#[tokio::test]
async fn an_agent_session_is_busy_and_a_bare_shell_is_not() {
    let (sup, _events) = supervisor_with(std::sync::Arc::new(StubAdapter::interactive()));

    let agent_id = tid("busy-agent");
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: agent_id.clone(),
            runtime: "stub-runtime".to_string(),
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

    let plain_id = tid("busy-plain");
    let (_out2, channel2) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(open_spec(&plain_id, program, args, 24, 80), channel2)
        .await
        .expect("terminal_open failed");

    let busy = sup
        .terminals_busy(vec![agent_id.clone(), plain_id.clone()])
        .await
        .expect("terminals_busy must never error");

    assert_eq!(
        busy.len(),
        1,
        "exactly one of the two terminals is busy, got {busy:?}"
    );
    assert_eq!(busy[0].id, agent_id, "the bound agent is the busy one");
    assert_eq!(busy[0].reason, BusyReason::Agent);
    assert_eq!(
        busy[0].label, "stub",
        "the label is the agent's title (the adapter's default here)"
    );
}

/// This guards a close the user asked for, so an `Err` would strand them in an unclosable tab. The
/// `write` proves the exited terminal is still known, so its absence is the exited branch.
#[tokio::test]
async fn an_exited_or_unknown_terminal_is_absent_rather_than_an_error() {
    let (program, args) = sh(&then("echo bye-now", "exit 0"));
    let (sup, id, sink) = open_terminal(program, args, 24, 80).await;

    wait_for_output(&sink, "bye-now").await;
    // Once the stream is quiet the child is provably gone, so the waiter thread has
    // sent `ChildExited` and the actor has processed it — the same mpsc our next
    // call queues behind.
    wait_for_quiet(&sink, Duration::from_millis(300)).await;
    sup.write(id.clone(), b"ignored\n".to_vec())
        .await
        .expect("the exited terminal must still be known to the supervisor");

    let busy = sup
        .terminals_busy(vec![id.clone(), "no-such-terminal".to_string()])
        .await
        .expect("an unknown id must not turn the whole call into an error");
    assert!(
        busy.is_empty(),
        "neither an exited nor an unknown terminal is busy, got {busy:?}"
    );
}

/// The empty batch: no ids in, no ids out, no error. `closePane` can be asked
/// about a pane whose terminals have all already gone.
#[tokio::test]
async fn no_ids_is_an_empty_answer() {
    let sup = spawn_supervisor(std::sync::Arc::new(NullSink), Vec::new(), None);
    assert!(sup
        .terminals_busy(Vec::new())
        .await
        .expect("an empty batch must not error")
        .is_empty());
}
