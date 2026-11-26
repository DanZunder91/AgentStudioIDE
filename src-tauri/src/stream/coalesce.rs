//! Coalesces PTY bytes on time + size so one flush = one `term.write`; sent raw, never JSON
//! (ARCHITECTURE §1). After a webview reload the pump keeps filling a scrollback ring, and
//! `terminal_reattach` swaps in a fresh `Channel` to replay it; the hot path stays lock-free.

use std::collections::VecDeque;

use bytes::Bytes;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc;
use tokio::time::{interval, Duration, MissedTickBehavior};

/// Flush when the pending buffer reaches this size…
const MAX_BATCH: usize = 32 * 1024;

/// …or when this much time has elapsed, whichever comes first.
/// ~125 flushes/sec max per terminal; xterm.js batches internally anyway.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Per-terminal scrollback kept for re-attach. Bytes, **not lines** (agent output is
/// pathologically long-lined). Bounded, so it can never grow the
/// process's memory without limit.
const RING_CAP: usize = 256 * 1024;

/// Control messages to a running pump. Low-frequency (re-attach only).
pub enum PumpControl {
    /// Swap the output sink to `new` and replay the scrollback into it. Sent by
    /// `terminal_reattach` after the webview reloaded and captured a fresh Channel.
    Reattach(Channel<InvokeResponseBody>),
}

/// A bounded ring of raw terminal bytes for re-attach replay.
struct ScrollbackRing {
    buf: VecDeque<u8>,
    cap: usize,
}

impl ScrollbackRing {
    fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
        }
    }

    /// Append a flushed batch, evicting the oldest bytes past the cap.
    fn append(&mut self, bytes: &[u8]) {
        // A single batch larger than the cap keeps only its tail (the newest part).
        let bytes = if bytes.len() > self.cap {
            &bytes[bytes.len() - self.cap..]
        } else {
            bytes
        };
        self.buf.extend(bytes.iter().copied());
        while self.buf.len() > self.cap {
            self.buf.pop_front();
        }
    }

    /// The current scrollback as a contiguous copy, for one replay `send`.
    fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
}

/// Pump coalesced PTY bytes into one terminal's channel until the PTY closes or `ctrl` drops.
/// A failed send does NOT end it: the pump keeps filling the ring so a `Reattach` can replay.
pub async fn pump_to_ui(
    rx: mpsc::Receiver<Bytes>,
    ctrl: mpsc::Receiver<PumpControl>,
    channel: Channel<InvokeResponseBody>,
) {
    pump_to_ui_tapped(rx, ctrl, channel, None).await
}

/// [`pump_to_ui`] with the Agent Logs tap: a non-blocking `try_send` of each raw chunk; a full
/// log queue drops it for the log only, never for the terminal.
pub async fn pump_to_ui_tapped(
    mut rx: mpsc::Receiver<Bytes>,
    mut ctrl: mpsc::Receiver<PumpControl>,
    mut channel: Channel<InvokeResponseBody>,
    mut tap: Option<crate::logstream::LogTap>,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(MAX_BATCH);
    let mut ring = ScrollbackRing::new(RING_CAP);
    let mut tick = interval(FLUSH_INTERVAL);
    // Under a firehose we want the next tick to be a fresh 8ms, not a burst of
    // catch-up ticks.
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            maybe = rx.recv() => match maybe {
                Some(chunk) => {
                    if let Some(tap) = tap.as_mut() {
                        tap.feed(&chunk);
                    }
                    buf.extend_from_slice(&chunk);
                    if buf.len() >= MAX_BATCH {
                        // Size trigger: flush now, don't wait for the tick.
                        flush(&channel, &mut buf, &mut ring);
                    }
                }
                None => {
                    // PTY closed (child exited): final flush, then stop.
                    flush(&channel, &mut buf, &mut ring);
                    if let Some(tap) = tap.as_mut() {
                        tap.eof();
                    }
                    break;
                }
            },
            _ = tick.tick() => {
                // Time trigger: keeps latency bounded for a trickle of output.
                flush(&channel, &mut buf, &mut ring);
            }
            msg = ctrl.recv() => match msg {
                Some(PumpControl::Reattach(new_channel)) => {
                    // Flush anything pending into the ring (and the old sink, which
                    // may already be dead — that's fine), then swap and replay so
                    // the reloaded pane is not blank.
                    flush(&channel, &mut buf, &mut ring);
                    channel = new_channel;
                    let scrollback = ring.snapshot();
                    if !scrollback.is_empty() {
                        let _ = channel.send(InvokeResponseBody::Raw(scrollback));
                    }
                }
                // Control channel closed => the terminal is being torn down.
                None => break,
            }
        }
    }
}

/// Send the pending buffer and record it in the ring regardless, so a re-attach can replay what
/// a dead sink missed; the send result is ignored.
fn flush(channel: &Channel<InvokeResponseBody>, buf: &mut Vec<u8>, ring: &mut ScrollbackRing) {
    if buf.is_empty() {
        return;
    }
    let batch = std::mem::take(buf);
    buf.reserve(MAX_BATCH);
    ring.append(&batch);
    let _ = channel.send(InvokeResponseBody::Raw(batch));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_is_bounded_and_keeps_the_newest_bytes() {
        let mut ring = ScrollbackRing::new(8);
        ring.append(b"abcdef"); // within cap
        assert_eq!(ring.snapshot(), b"abcdef");
        ring.append(b"ghij"); // overflows: total 10 -> keep last 8
        assert_eq!(ring.snapshot(), b"cdefghij");
        // A single oversized batch keeps only its tail.
        ring.append(b"0123456789");
        assert_eq!(ring.snapshot(), b"23456789");
    }
}
