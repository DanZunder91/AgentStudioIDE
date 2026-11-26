//! The blocking PTY reader on its own OS thread (not tokio's pool) → bounded `mpsc<Bytes>`.
//! The bounded channel IS the backpressure (ARCHITECTURE §3): a slow UI parks this thread and
//! the full kernel PTY buffer throttles the child.

use bytes::Bytes;
use std::io::Read;
use tokio::sync::mpsc;

/// Bounded channel capacity (chunks, not bytes). Per ARCHITECTURE §3.
const CHANNEL_CAPACITY: usize = 256;

/// Read buffer per `read()` syscall.
const READ_BUF: usize = 64 * 1024;

/// Start the reader pump for `master.try_clone_reader()`; returns the bounded receiver.
/// Exits on EOF, on a read error (Linux reports PTY EOF as `EIO`), or when the receiver drops.
pub fn start_reader(master_reader: Box<dyn Read + Send>) -> mpsc::Receiver<Bytes> {
    let (tx, rx) = mpsc::channel::<Bytes>(CHANNEL_CAPACITY);

    std::thread::spawn(move || {
        let mut reader = master_reader;
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                // EOF: the child closed the PTY.
                Ok(0) => break,
                Ok(n) => {
                    // Copy out; ownership crosses the thread boundary.
                    if tx.blocking_send(Bytes::copy_from_slice(&buf[..n])).is_err() {
                        // Receiver dropped → terminal is gone.
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                // On Linux, PTY EOF often surfaces as EIO. Treat any other error
                // as EOF rather than an error — the child is gone either way.
                Err(_) => break,
            }
        }
    });

    rx
}
