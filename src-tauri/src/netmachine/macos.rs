//! macOS glue: ONE long-lived `/usr/bin/nettop -L 0 -s 1` child whose CSV stream is cut into
//! samples by [`NettopSplitter`] (never respawned per second). No root, no prompt.
//! Spawned directly — never through a shell.

use super::nettop::{parse_sample, NettopSplitter};
use super::{Platform, RawSample, Source, SourceFactory};
use crate::spawn::NoWindow as _;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};

pub const NETTOP: &str = "/usr/bin/nettop";

/// `-L 0` log forever, `-s 1` every second, `-n` no DNS (we do our own, cached), `-x` raw
/// numbers (no `KiB`), `-J` the columns. No `-m`: TCP and UDP both.
pub const ARGS: &[&str] = &[
    "-L",
    "0",
    "-s",
    "1",
    "-n",
    "-x",
    "-J",
    "bytes_in,bytes_out,state",
];

pub fn platform() -> (Platform, Option<SourceFactory>) {
    if !Path::new(NETTOP).exists() {
        return (
            Platform {
                available: false,
                backend: Some("macos-nettop"),
                reason: Some(format!(
                    "{NETTOP} is missing, so connections can't be listed."
                )),
                has_bytes: false,
            },
            None,
        );
    }
    (
        Platform {
            available: true,
            backend: Some("macos-nettop"),
            reason: None,
            has_bytes: true,
        },
        Some(Arc::new(|| {
            NettopSource::spawn().map(|s| Box::new(s) as Box<dyn Source>)
        })),
    )
}

pub struct NettopSource {
    // Held so the child dies with the source: `kill_on_drop`.
    child: Child,
    stdout: BufReader<ChildStdout>,
    splitter: NettopSplitter,
    line: Vec<u8>,
}

impl NettopSource {
    pub fn spawn() -> Result<NettopSource, String> {
        let mut child = Command::new(NETTOP)
            .args(ARGS)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .no_window()
            .spawn()
            .map_err(|e| format!("Couldn't start {NETTOP}: {e}"))?;
        let stdout = child.stdout.take().ok_or("nettop has no stdout")?;
        Ok(NettopSource {
            child,
            stdout: BufReader::new(stdout),
            splitter: NettopSplitter::default(),
            line: Vec::new(),
        })
    }
}

#[async_trait::async_trait]
impl Source for NettopSource {
    async fn next(&mut self) -> Result<RawSample, String> {
        loop {
            self.line.clear();
            let n = self
                .stdout
                .read_until(b'\n', &mut self.line)
                .await
                .map_err(|e| format!("Reading nettop failed: {e}"))?;
            if n == 0 {
                let status = self
                    .child
                    .wait()
                    .await
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                return Err(format!("nettop stopped unexpectedly ({status})."));
            }
            // Process names are not guaranteed UTF-8.
            let line = String::from_utf8_lossy(&self.line);
            if let Some(text) = self.splitter.push(&line) {
                return Ok(RawSample {
                    apps: parse_sample(&text),
                    interval_ms: Some(1000),
                });
            }
        }
    }
}
