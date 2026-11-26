//! The Agent Logs hub (`logstream/mod.rs`) and its pump tap, on tokio's paused clock, so the
//! 250 ms rule is asserted, not raced. Contract numbers are restated literals on purpose.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::logstream::{
    LineDraft, LogHub, LogKind, LogLevel, LogLine, LogSink, HUB_QUEUE,
};
use agent_studio_scaffold_lib::stream::coalesce::{pump_to_ui_tapped, PumpControl};
use bytes::Bytes;
use tokio::sync::mpsc;
use tokio::time::{advance, Instant};

const RING_CAP: usize = 20_000;
const EMIT_MAX: usize = 2_000;
const EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// One emitted batch and the (virtual) instant it was emitted.
type Batch = (Instant, Vec<LogLine>);

/// Records every emitted batch.
#[derive(Clone, Default)]
struct Rec {
    batches: Arc<Mutex<Vec<Batch>>>,
}

impl Rec {
    fn lines(&self) -> Vec<LogLine> {
        self.batches
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, b)| b.clone())
            .collect()
    }
    fn texts(&self) -> Vec<String> {
        self.lines().into_iter().map(|l| l.text).collect()
    }
}

impl LogSink for Rec {
    fn emit(&self, lines: &[LogLine]) {
        self.batches
            .lock()
            .unwrap()
            .push((Instant::now(), lines.to_vec()));
    }
}

/// A hub whose task runs on the test's (paused) runtime.
fn hub() -> (LogHub, Rec) {
    let rec = Rec::default();
    let (hub, task) = LogHub::new(Arc::new(rec.clone()));
    tokio::spawn(task);
    (hub, rec)
}

/// Let ready tasks run without moving the clock.
async fn settle() {
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
}

/// Yield until the ring's newest id reaches `id` (the hub has committed everything
/// sent so far) — the hub can need many scheduler turns for a big burst.
async fn committed(hub: &LogHub, id: u64) {
    for _ in 0..100_000 {
        if hub.snapshot().last().map(|l| l.id).unwrap_or(0) >= id {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("hub never committed id {id}");
}

fn draft(text: String) -> LineDraft {
    LineDraft::system(None, None, "test", LogLevel::Info, text)
}

// ── partial-line flush timing ────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn an_unterminated_line_flushes_after_250ms_of_silence_not_before() {
    let (hub, rec) = hub();
    let mut tap = hub.tap("t1", "sh · w", false);
    settle().await;

    tap.feed(&Bytes::from_static(b"\x1b[1mPassword:\x1b[0m "));
    settle().await;

    advance(Duration::from_millis(200)).await;
    settle().await;
    assert!(
        hub.snapshot().is_empty(),
        "flushed a partial line before 250ms of silence: {:?}",
        hub.snapshot()
    );

    advance(Duration::from_millis(100)).await;
    settle().await;
    let snap = hub.snapshot();
    assert_eq!(snap.len(), 1, "the partial line must flush by 300ms");
    assert_eq!(snap[0].text, "Password:");
    assert_eq!(snap[0].kind, LogKind::Output);
    assert_eq!(snap[0].source, "sh · w");
    assert_eq!(snap[0].terminal_id.as_deref(), Some("t1"));
    assert_eq!(rec.texts(), ["Password:"], "…and be emitted");
}

#[tokio::test(start_paused = true)]
async fn more_bytes_restart_the_silence_window() {
    let (hub, _rec) = hub();
    let mut tap = hub.tap("t1", "sh", false);
    settle().await;
    tap.feed(&Bytes::from_static(b"compiling"));
    settle().await;
    advance(Duration::from_millis(200)).await;
    settle().await;
    tap.feed(&Bytes::from_static(b" crate"));
    settle().await;
    advance(Duration::from_millis(200)).await;
    settle().await;
    assert!(
        hub.snapshot().is_empty(),
        "the second write restarts the 250ms window"
    );
    advance(Duration::from_millis(100)).await;
    settle().await;
    assert_eq!(hub.snapshot()[0].text, "compiling crate");
}

#[tokio::test(start_paused = true)]
async fn a_complete_line_does_not_wait_for_the_silence_window() {
    let (hub, rec) = hub();
    let mut tap = hub.tap("t1", "sh", false);
    settle().await;
    tap.feed(&Bytes::from_static(b"error: boom\r\n"));
    settle().await;
    let snap = hub.snapshot();
    assert_eq!(snap.len(), 1, "committed on arrival, no timer involved");
    assert_eq!(snap[0].level, LogLevel::Error, "level heuristic applied");
    advance(Duration::from_millis(50)).await;
    settle().await;
    assert_eq!(rec.texts(), ["error: boom"]);
}

// ── batched emit ─────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn emits_are_batched_at_most_every_100ms_and_2000_lines() {
    let (hub, rec) = hub();
    settle().await;
    let total = 5_000u64;
    for chunk in 0..(total / 1000) {
        for i in 0..1000 {
            hub.push(draft(format!("line {}", chunk * 1000 + i)));
        }
        committed(&hub, (chunk + 1) * 1000).await;
    }
    for _ in 0..100 {
        advance(Duration::from_millis(10)).await;
        settle().await;
    }

    let batches = rec.batches.lock().unwrap().clone();
    assert!(batches.len() >= 3, "5000 lines need ≥ 3 batches of ≤ 2000");
    for (_, b) in &batches {
        assert!(b.len() <= EMIT_MAX, "a batch of {} lines", b.len());
    }
    for pair in batches.windows(2) {
        let gap = pair[1].0 - pair[0].0;
        assert!(gap >= EMIT_INTERVAL, "two emits {gap:?} apart");
    }
    let ids: Vec<u64> = batches
        .iter()
        .flat_map(|(_, b)| b.iter().map(|l| l.id))
        .collect();
    assert_eq!(ids.len() as u64, total, "every line emitted exactly once");
    assert!(
        ids.windows(2).all(|w| w[1] == w[0] + 1),
        "in id order, no gaps"
    );
}

// ── ring cap + clear ─────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn the_ring_is_capped_at_20000_and_clear_keeps_ids_monotonic() {
    let (hub, _rec) = hub();
    settle().await;
    let total = RING_CAP as u64 + 5;
    let mut sent = 0u64;
    while sent < total {
        let n = (total - sent).min(1000);
        for _ in 0..n {
            sent += 1;
            hub.push(draft(format!("l{sent}")));
        }
        committed(&hub, sent).await;
    }
    let snap = hub.snapshot();
    assert_eq!(snap.len(), RING_CAP);
    assert_eq!(snap.first().unwrap().id, 6, "the 5 oldest were evicted");
    assert_eq!(snap.last().unwrap().id, total);

    hub.clear();
    assert!(hub.snapshot().is_empty());
    hub.push(draft("after clear".into()));
    committed(&hub, total + 1).await;
    let snap = hub.snapshot();
    assert_eq!(snap.len(), 1);
    assert_eq!(snap[0].id, total + 1, "ids keep increasing across a clear");
}

#[tokio::test(start_paused = true)]
async fn a_clear_before_the_emit_is_not_resurrected_by_it() {
    let (hub, rec) = hub();
    settle().await;
    advance(Duration::from_millis(1)).await; // past the interval's immediate first tick
    settle().await;
    for i in 0..3 {
        hub.push(draft(format!("doomed {i}")));
    }
    committed(&hub, 3).await;
    hub.clear();
    hub.push(draft("kept".into()));
    committed(&hub, 4).await;
    advance(Duration::from_millis(200)).await;
    settle().await;
    assert_eq!(
        rec.texts(),
        ["kept"],
        "cleared lines must not be emitted afterwards"
    );
}

// ── the tap never blocks ─────────────────────────────────────────────────────

#[test]
fn a_full_queue_drops_and_counts_instead_of_waiting() {
    // The hub's task is deliberately NOT running, so nothing drains the queue.
    let (hub, task) = LogHub::new(Arc::new(Rec::default()));
    let mut tap = hub.tap("t1", "sh", false);
    let extra = 500;
    let chunk = Bytes::from_static(b"x\n");
    let started = std::time::Instant::now();
    for _ in 0..(HUB_QUEUE + extra) {
        tap.feed(&chunk);
    }
    // Plain `#[test]`, no runtime: a feed that awaited or blocked would hang here.
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "feeding a full queue took {:?}",
        started.elapsed()
    );
    assert_eq!(tap.dropped(), extra as u64);

    // Recovery: once the hub drains, the next chunk that gets through carries the count.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    rt.block_on(async {
        tokio::spawn(task);
        committed(&hub, HUB_QUEUE as u64).await;
        tap.feed(&Bytes::from_static(b"tail\n"));
        assert_eq!(tap.dropped(), 0, "a successful send resets the counter");
        let want = HUB_QUEUE as u64 + 2; // the queued lines + the notice + "tail"
        committed(&hub, want).await;
        let snap = hub.snapshot();
        let notice = snap
            .iter()
            .find(|l| l.kind == LogKind::System)
            .expect("notice");
        assert_eq!(
            notice.text,
            format!("… {extra} output chunks dropped (log queue full)")
        );
        assert_eq!(notice.level, LogLevel::Warn);
        assert_eq!(snap.last().unwrap().text, "tail");
    });
}

/// **The pump with a stalled log still delivers every byte to the terminal.** The
/// hub's task never runs, so the tap's queue fills after `HUB_QUEUE` chunks; the pump
/// must neither wait on it nor lose a byte of the terminal's own stream.
#[tokio::test]
async fn a_stalled_log_never_slows_or_starves_the_terminal_path() {
    let (hub, task) = LogHub::new(Arc::new(Rec::default()));
    let tap = hub.tap("t1", "sh", false);
    let (tx, rx) = mpsc::channel::<Bytes>(256);
    let (_ctrl_tx, ctrl_rx) = mpsc::channel::<PumpControl>(1);
    let (sink, channel) = common::ChannelSink::new();
    let pump = tokio::spawn(pump_to_ui_tapped(rx, ctrl_rx, channel, Some(tap)));

    let n = HUB_QUEUE + 1_000;
    let mut expected = Vec::new();
    for i in 0..n {
        let line = format!("chunk-{i}\n");
        expected.extend_from_slice(line.as_bytes());
        tx.send(Bytes::from(line)).await.unwrap();
    }
    drop(tx); // PTY closed → final flush → the pump ends
    tokio::time::timeout(Duration::from_secs(10), pump)
        .await
        .expect("the pump stalled behind a full log queue")
        .unwrap();
    assert_eq!(sink.bytes(), expected, "the terminal lost bytes");

    // Only what fit in the queue reached the log; the rest was dropped, not waited on.
    tokio::spawn(task);
    committed(&hub, HUB_QUEUE as u64).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let snap = hub.snapshot();
    assert_eq!(snap.len(), HUB_QUEUE);
    assert_eq!(snap.first().unwrap().text, "chunk-0");
    assert_eq!(
        snap.last().unwrap().text,
        format!("chunk-{}", HUB_QUEUE - 1)
    );
}

// ── suppression ──────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn suppressed_output_is_not_logged_and_resumes_clean() {
    let (hub, _rec) = hub();
    let mut tap = hub.tap("t1", "sh", false);
    settle().await;

    tap.feed(&Bytes::from_static(b"visible 1\n"));
    hub.set_suppressed("t1", true);
    assert_eq!(hub.is_suppressed("t1"), Some(true));
    tap.feed(&Bytes::from_static(b"hidden\n"));
    hub.set_suppressed("t1", false);
    tap.feed(&Bytes::from_static(b"visible 2\n"));
    settle().await;

    let texts: Vec<String> = hub.snapshot().into_iter().map(|l| l.text).collect();
    assert_eq!(texts, ["visible 1", "visible 2"]);
}

/// A bound TUI can enter the alternate screen and leave it while we are not looking
/// (its `?1049l` is among the suppressed bytes). Resuming must reset the splitter, or
/// the terminal would stay "in the alt screen" — silent — forever.
#[tokio::test(start_paused = true)]
async fn resuming_after_suppression_resets_a_stale_alt_screen() {
    let (hub, _rec) = hub();
    let mut tap = hub.tap("t1", "sh", false);
    settle().await;

    tap.feed(&Bytes::from_static(b"$ claude\n\x1b[?1049h"));
    hub.set_suppressed("t1", true);
    tap.feed(&Bytes::from_static(b"TUI paint\x1b[?1049l"));
    hub.set_suppressed("t1", false);
    tap.feed(&Bytes::from_static(b"back at the shell\n"));
    settle().await;

    let texts: Vec<String> = hub.snapshot().into_iter().map(|l| l.text).collect();
    assert_eq!(texts, ["$ claude", "back at the shell"]);
}

#[tokio::test(start_paused = true)]
async fn a_forgotten_terminal_is_no_longer_suppressible() {
    let (hub, _rec) = hub();
    let _tap = hub.tap("t1", "sh", true);
    assert_eq!(hub.is_suppressed("t1"), Some(true));
    hub.forget("t1");
    assert_eq!(hub.is_suppressed("t1"), None);
}

/// A tap can be born suppressed (the supervisor does this for a spawned agent's
/// terminal, whose session is bound from its first byte).
#[tokio::test(start_paused = true)]
async fn a_tap_born_suppressed_logs_nothing_until_released() {
    let (hub, _rec) = hub();
    let mut tap = hub.tap("t1", "claude · w", true);
    settle().await;
    tap.feed(&Bytes::from_static(b"first paint\n"));
    settle().await;
    assert!(hub.snapshot().is_empty(), "{:?}", hub.snapshot());
    hub.set_suppressed("t1", false);
    tap.feed(&Bytes::from_static(b"released\n"));
    settle().await;
    let texts: Vec<String> = hub.snapshot().into_iter().map(|l| l.text).collect();
    assert_eq!(texts, ["released"]);
}

// ── one source per terminal; one splitter per OS ─────────────────────────────

/// Two terminals in one folder were one source (`powershell · Agent Studio`): one Logs row, named
/// after whichever tab was renamed, and a server started in the other one labelled "by" it
/// (every Windows terminal is titled `powershell`, so Windows always hit it).
#[tokio::test(start_paused = true)]
async fn two_terminals_with_the_same_label_are_two_sources() {
    let (hub, _rec) = hub();
    let base = "powershell · Agent Studio";
    let mut a = hub.tap("t1", base, false);
    let mut b = hub.tap("t2", base, false);
    let _c = hub.tap("t3", base, false);
    assert_eq!(hub.source_of("t1").as_deref(), Some(base));
    assert_eq!(
        hub.source_of("t2").as_deref(),
        Some("powershell · Agent Studio (2)")
    );
    assert_eq!(
        hub.source_of("t3").as_deref(),
        Some("powershell · Agent Studio (3)")
    );
    assert_eq!(hub.source_of("nope"), None);
    settle().await;
    a.feed(&Bytes::from_static(b"one\r\n"));
    b.feed(&Bytes::from_static(b"two\r\n"));
    settle().await;
    let got: Vec<(String, String)> = hub
        .snapshot()
        .into_iter()
        .map(|l| (l.terminal_id.unwrap(), l.source))
        .collect();
    assert_eq!(
        got,
        [
            ("t1".to_string(), base.to_string()),
            (
                "t2".to_string(),
                "powershell · Agent Studio (2)".to_string()
            ),
        ]
    );
    // Re-registering a terminal keeps its own label (it does not collide with itself)…
    let _a2 = hub.tap("t1", base, false);
    assert_eq!(hub.source_of("t1").as_deref(), Some(base));
    // …and a closed terminal's label is free again.
    hub.forget("t2");
    let _d = hub.tap("t4", base, false);
    assert_eq!(
        hub.source_of("t4").as_deref(),
        Some("powershell · Agent Studio (2)")
    );
}

/// Each OS's PTY is read its own way: ConPTY repaints (PSReadLine backspaces, cursor jumps), so
/// the line is the screen; elsewhere a backspace erases and cursor moves aren't content.
#[tokio::test(start_paused = true)]
async fn each_os_reads_its_own_pty() {
    let (hub, _rec) = hub();
    let mut tap = hub.tap("t1", "sh", false);
    settle().await;
    tap.feed(&Bytes::from_static(b"PS> G\x08Ge\x1b[1;5HGet\r\n"));
    settle().await;
    let texts: Vec<String> = hub.snapshot().into_iter().map(|l| l.text).collect();
    #[cfg(windows)]
    assert_eq!(texts, ["PS> Get"]);
    #[cfg(not(windows))]
    assert_eq!(texts, ["PS> GeGet"]);
}

/// The PTY size reaches the Windows screen model before the first byte, as at spawn: with three
/// rows ConPTY's jump to row 3 is the prompt row (at 24 rows it would log `3 x`).
#[tokio::test(start_paused = true)]
async fn the_pty_size_reaches_the_terminal_model() {
    let (hub, _rec) = hub();
    let mut tap = hub.tap("t1", "sh", false);
    hub.resize("t1", 3, 10);
    settle().await;
    tap.feed(&Bytes::from_static(b"1\r\n2\r\n3\r\n> \x1b[3;3Hx\r\n"));
    settle().await;
    let texts: Vec<String> = hub.snapshot().into_iter().map(|l| l.text).collect();
    assert_eq!(texts, ["1", "2", "3", "> x"]);
}
