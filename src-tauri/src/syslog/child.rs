//! One supervised log child: spawn at an absolute path (no shell), read stdout lines on
//! tokio, parse, `LogHub::push`. Dropping the [`Running`] handle stops the reader and
//! kills the child (`kill_on_drop`). A child that exits on its own flips `alive` off,
//! records why (exit status + stderr tail) for `syslog_status`, and posts one `system`
//! line — the lifecycle every stream shares (`stream.rs`). Platform-neutral — the unix
//! tests drive it with `/bin/sh`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use super::stream::Life;
use super::Parser;
use crate::logstream::LogHub;
use crate::spawn::NoWindow as _;

/// The handle `spawn` returns — the same type for every stream (re-exported here so callers
/// that name `child::Running` keep working).
pub use super::stream::Running;

/// How much of stderr is kept for the exit reason.
pub const STDERR_TAIL: usize = 2048;
/// A stdout line longer than this is cut (a runaway line must not grow memory unbounded).
pub const MAX_LINE: usize = 256 * 1024;

pub struct ChildSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// "System apps" / "iOS Simulator" — used in the system line and reason.
    pub label: &'static str,
}

/// A child's stop guard: dropped with its [`Running`].
struct ChildStop {
    _stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ChildStop {
    fn drop(&mut self) {
        // The oneshot sender dropping wakes the task; abort as a backstop. Either way the
        // `Child` is dropped with `kill_on_drop(true)`.
        self.task.abort();
    }
}

async fn read_tail<R: AsyncRead + Unpin>(mut r: R) -> String {
    let mut tail: VecDeque<u8> = VecDeque::with_capacity(STDERR_TAIL);
    let mut buf = [0u8; 1024];
    while let Ok(n) = r.read(&mut buf).await {
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if tail.len() == STDERR_TAIL {
                tail.pop_front();
            }
            tail.push_back(b);
        }
    }
    let v: Vec<u8> = tail.into_iter().collect();
    String::from_utf8_lossy(&v).trim().to_string()
}

/// One line (≤ [`MAX_LINE`] bytes kept; the rest of an over-long line is discarded).
async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> std::io::Result<usize> {
    let n = reader.take(MAX_LINE as u64).read_until(b'\n', buf).await?;
    if buf.len() >= MAX_LINE && buf.last() != Some(&b'\n') {
        let mut sink = Vec::new();
        reader.read_until(b'\n', &mut sink).await?;
    }
    Ok(n)
}

/// Spawn and supervise. Never fails: a spawn error yields a dead `Running` carrying it.
pub fn spawn(rt: &tokio::runtime::Handle, spec: ChildSpec, parser: Parser, hub: LogHub) -> Running {
    let life = Life::new();
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let life2 = life.clone();
    let label = spec.label;

    let task = rt.spawn(async move {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_window();
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let why = format!(
                    "{label} log stream could not start ({}): {e}",
                    spec.program.display()
                );
                life2.die(&hub, why);
                return;
            }
        };
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            life2.die(&hub, format!("{label} log stream has no pipes"));
            return;
        };
        let stderr_task = tokio::spawn(read_tail(stderr));
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        loop {
            buf.clear();
            tokio::select! {
                _ = &mut stop_rx => {
                    // Deliberate stop (replaced or disabled): quiet. `child` drops → killed.
                    let _ = child.start_kill();
                    return;
                }
                r = read_line(&mut reader, &mut buf) => {
                    match r {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buf);
                            if let Some(draft) = parser(&line) {
                                hub.push(draft);
                            }
                        }
                    }
                }
            }
        }
        let status = child.wait().await;
        let tail = stderr_task.await.unwrap_or_default();
        let status = match status {
            Ok(s) => match s.code() {
                Some(c) => format!("exit code {c}"),
                None => "killed by a signal".to_string(),
            },
            Err(e) => e.to_string(),
        };
        let why = if tail.is_empty() {
            format!("{label} log stream stopped ({status}).")
        } else {
            format!("{label} log stream stopped ({status}): {tail}")
        };
        life2.die(&hub, why);
    });
    Running::new(
        life,
        ChildStop {
            _stop: stop_tx,
            task,
        },
    )
}
