//! The 8ms/32KB coalescer (`stream/coalesce.rs`) on tokio's paused clock, never real sleeps:
//! time moves only when we move it, so the time and size triggers are told apart. The literals
//! are restated on purpose (the consts are private; ARCHITECTURE §3).

mod common;

use std::time::Duration;

use agent_studio_scaffold_lib::stream::coalesce::{pump_to_ui, PumpControl};
use bytes::Bytes;
use common::ChannelSink;
use tokio::sync::mpsc;
use tokio::time::{advance, Instant};

/// The contract from ARCHITECTURE §3 / `coalesce.rs`.
const MAX_BATCH: usize = 32 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Run every ready task to its next await without moving the paused clock. Also after `pump()`:
/// `interval()` ticks at once, and settling first keeps a chunk from racing that tick.
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

/// Spawn the pump on the test's paused runtime; return its data input, its control
/// input (kept alive by the caller — dropping it ends the pump), and its output.
fn pump() -> (mpsc::Sender<Bytes>, mpsc::Sender<PumpControl>, ChannelSink) {
    let (tx, rx) = mpsc::channel::<Bytes>(256);
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<PumpControl>(1);
    let (sink, channel) = ChannelSink::new();
    tokio::spawn(pump_to_ui(rx, ctrl_rx, channel));
    (tx, ctrl_tx, sink)
}

/// **Small writes batch together.** Three tiny chunks must reach the UI as *one*
/// `term.write`, not three — that ratio is the entire point of the coalescer.
#[tokio::test(start_paused = true)]
async fn small_writes_are_batched_into_one_flush() {
    let (tx, _ctrl, sink) = pump();
    settle().await;

    for chunk in ["hello ", "coalesced ", "world"] {
        tx.send(Bytes::from_static(chunk.as_bytes())).await.unwrap();
    }
    settle().await;

    assert_eq!(sink.batch_count(), 0, "flushed before any trigger fired");

    advance(FLUSH_INTERVAL).await;
    settle().await;

    assert_eq!(
        sink.batch_count(),
        1,
        "3 small writes must coalesce into 1 flush"
    );
    assert_eq!(sink.text(), "hello coalesced world");
}

/// A trickle flushes within 8ms; stepping to 7ms then 8ms pins the bound from both sides.
#[tokio::test(start_paused = true)]
async fn a_partial_batch_is_flushed_by_the_time_bound() {
    let (tx, _ctrl, sink) = pump();
    settle().await;

    tx.send(Bytes::from_static(b"trickle")).await.unwrap();
    settle().await;

    // Just short of the bound: still buffered.
    advance(FLUSH_INTERVAL - Duration::from_millis(1)).await;
    settle().await;
    assert_eq!(
        sink.batch_count(),
        0,
        "flushed before the {FLUSH_INTERVAL:?} bound"
    );

    // Crossing it flushes the partial batch.
    advance(Duration::from_millis(1)).await;
    settle().await;
    assert_eq!(
        sink.batch_count(),
        1,
        "the time bound did not flush a partial batch"
    );
    assert_eq!(sink.text(), "trickle");
}

/// The size trigger pre-empts the timer; `elapsed == 0` proves it (the paused timer can't fire).
#[tokio::test(start_paused = true)]
async fn a_burst_over_32kb_flushes_early_on_the_size_trigger() {
    let (tx, _ctrl, sink) = pump();
    settle().await;

    let start = Instant::now();

    // 4KB at a time: the 8th chunk is the one that crosses 32KB.
    const CHUNK: usize = 4 * 1024;
    for _ in 0..(MAX_BATCH / CHUNK) {
        tx.send(Bytes::from(vec![b'x'; CHUNK])).await.unwrap();
    }
    settle().await;

    assert_eq!(
        sink.batch_count(),
        1,
        "a 32KB burst must flush on size, before the timer"
    );
    assert_eq!(
        sink.bytes().len(),
        MAX_BATCH,
        "the size trigger flushes at exactly MAX_BATCH"
    );
    assert_eq!(
        start.elapsed(),
        Duration::ZERO,
        "the flush consumed virtual time, so it came from the timer, not the size trigger"
    );
}

/// A single chunk bigger than the batch limit flushes whole, in one send — the
/// coalescer batches; it must never split or truncate.
#[tokio::test(start_paused = true)]
async fn an_oversized_single_chunk_flushes_whole_and_immediately() {
    let (tx, _ctrl, sink) = pump();
    settle().await;

    let start = Instant::now();
    let big = MAX_BATCH * 3 + 17;
    tx.send(Bytes::from(vec![b'z'; big])).await.unwrap();
    settle().await;

    assert_eq!(sink.batch_count(), 1);
    assert_eq!(
        sink.bytes().len(),
        big,
        "an oversized chunk must not be split or truncated"
    );
    assert_eq!(
        start.elapsed(),
        Duration::ZERO,
        "an oversized chunk waited for the timer"
    );
}

/// Bytes must arrive complete and in order across many flushes. Terminal output
/// is a stream of control sequences: a reordered or dropped batch is a corrupted
/// screen, not a cosmetic glitch.
#[tokio::test(start_paused = true)]
async fn bytes_are_never_reordered_or_dropped_across_many_flushes() {
    let (tx, _ctrl, sink) = pump();
    settle().await;

    // Enough to cross the size trigger repeatedly *and* span several ticks.
    let mut expected = Vec::new();
    for i in 0..2000u32 {
        let chunk = format!("[{i}]");
        expected.extend_from_slice(chunk.as_bytes());
        tx.send(Bytes::from(chunk)).await.unwrap();
        if i % 250 == 0 {
            advance(FLUSH_INTERVAL).await;
            settle().await;
        }
    }
    // Sender gone → final flush → the pump returns.
    drop(tx);
    settle().await;

    assert_eq!(
        sink.bytes(),
        expected,
        "the byte stream was reordered or lost"
    );
    assert!(
        sink.batch_count() > 1,
        "the test never exercised multiple flushes"
    );
}

/// When the reader's channel closes, a final flush keeps the child's last bytes (`echo x; exit`).
#[tokio::test(start_paused = true)]
async fn closing_the_reader_channel_triggers_a_final_flush() {
    let (tx, _ctrl, sink) = pump();
    settle().await;

    let start = Instant::now();
    tx.send(Bytes::from_static(b"last words")).await.unwrap();
    // Close immediately: those bytes are pending, well inside the 8ms window.
    drop(tx);
    settle().await;

    assert_eq!(
        sink.text(),
        "last words",
        "pending bytes were dropped on close"
    );
    assert_eq!(
        start.elapsed(),
        Duration::ZERO,
        "the final flush waited for the timer"
    );
}

/// An empty tick must not send an empty batch — 125 no-op IPC hops/sec/terminal
/// across a fleet is exactly the overhead this design exists to avoid.
#[tokio::test(start_paused = true)]
async fn idle_ticks_do_not_send_empty_batches() {
    let (_tx, _ctrl, sink) = pump();
    settle().await;

    for _ in 0..25 {
        advance(FLUSH_INTERVAL).await;
        settle().await;
    }

    assert_eq!(
        sink.batch_count(),
        0,
        "the coalescer sent empty batches while idle"
    );
}

/// A dead webview Channel must not end the pump (nothing left to re-bind); it keeps filling the
/// ring and ends only when the PTY closes.
#[tokio::test(start_paused = true)]
async fn the_pump_survives_a_dead_channel_and_ends_only_on_pty_close() {
    let (tx, rx) = mpsc::channel::<Bytes>(256);
    let (_ctrl, ctrl_rx) = mpsc::channel::<PumpControl>(1);
    let pump = tokio::spawn(pump_to_ui(rx, ctrl_rx, ChannelSink::broken()));

    // Send into a dead sink; the pump keeps running (does not finish).
    tx.send(Bytes::from_static(b"into the void")).await.unwrap();
    advance(FLUSH_INTERVAL).await;
    settle().await;
    assert!(
        !pump.is_finished(),
        "the pump must survive a dead Channel so a re-attach can replay"
    );

    // Only the PTY closing (data rx gone) ends it.
    drop(tx);
    settle().await;
    assert!(pump.is_finished(), "the pump must end when the PTY closes");
    pump.await.expect("the pump panicked instead of returning");
}

/// The pump also ends when its **control** channel closes (terminal teardown), so a
/// removed terminal never leaks a task even if its PTY is somehow still open.
#[tokio::test(start_paused = true)]
async fn the_pump_ends_when_the_control_channel_closes() {
    let (_tx, rx) = mpsc::channel::<Bytes>(256);
    let (ctrl, ctrl_rx) = mpsc::channel::<PumpControl>(1);
    let (_sink, channel) = ChannelSink::new();
    let pump = tokio::spawn(pump_to_ui(rx, ctrl_rx, channel));

    drop(ctrl); // terminal torn down
    settle().await;
    assert!(
        pump.is_finished(),
        "closing the control channel must end the pump"
    );
}

/// **The re-attach path itself**: after the Channel dies, `Reattach(new)` swaps the
/// sink and replays the scrollback ring into it, so the reloaded pane is not blank.
#[tokio::test(start_paused = true)]
async fn reattach_swaps_the_sink_and_replays_the_scrollback() {
    let (tx, rx) = mpsc::channel::<Bytes>(256);
    let (ctrl, ctrl_rx) = mpsc::channel::<PumpControl>(1);
    // Start on a dead sink (webview already reloaded).
    let pump = tokio::spawn(pump_to_ui(rx, ctrl_rx, ChannelSink::broken()));

    // Output produced while the sink was dead — it must still be in the ring.
    tx.send(Bytes::from_static(b"before reload "))
        .await
        .unwrap();
    advance(FLUSH_INTERVAL).await;
    settle().await;

    // The webview comes back with a fresh Channel.
    let (fresh, fresh_channel) = ChannelSink::new();
    ctrl.send(PumpControl::Reattach(fresh_channel))
        .await
        .unwrap();
    settle().await;

    // The scrollback was replayed into the new sink.
    assert_eq!(
        fresh.text(),
        "before reload ",
        "ring was not replayed on re-attach"
    );

    // …and new output now flows to the fresh sink.
    tx.send(Bytes::from_static(b"after reload")).await.unwrap();
    advance(FLUSH_INTERVAL).await;
    settle().await;
    assert_eq!(fresh.text(), "before reload after reload");

    drop(tx);
    settle().await;
    pump.await.ok();
}
