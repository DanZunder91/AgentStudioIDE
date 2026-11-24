//! The blocking PTY reader thread → bounded `mpsc<Bytes>`.
//!
//! `portable-pty`'s reader is blocking `std::io::Read`, so it gets a dedicated OS
//! thread (NOT the tokio blocking pool — this is the throughput path and it lives
//! as long as the terminal does).
//!
//! **The bounded channel IS the backpressure** (ARCHITECTURE §3): when the UI is
//! slow to drain, `blocking_send` parks this thread → we stop draining the PTY →
//! the kernel PTY buffer fills → the OS throttles the child. No unbounded growth.

use bytes::Bytes;
use std::io::Read;
use tokio::sync::mpsc;

/// Bounded channel capacity (chunks, not bytes). Per ARCHITECTURE §3.
const CHANNEL_CAPACITY: usize = 256;

/// Read buffer per `read()` syscall.
const READ_BUF: usize = 64 * 1024;

/// Start the reader pump for one PTY.
///
/// Takes the reader obtained from `master.try_clone_reader()` and returns the
/// receiving half of the bounded channel. The thread exits on EOF, on a read
/// error (Linux surfaces PTY EOF as `EIO` — treated as EOF, not an error), or
/// when the receiver is dropped.
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
