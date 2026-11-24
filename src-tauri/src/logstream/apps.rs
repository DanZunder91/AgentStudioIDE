//! Dev-app logs as a log source: a file a process on this
//! machine writes, or a container's `docker logs -f`, tailed into the hub as
//! [`LogKind::App`] lines.
//!
//! This module is the **engine** only — it tails what it is handed. Deciding *whether* a
//! file may be tailed (the pid has it open, or the user picked it in a dialog) and naming
//! the stream is [`crate::procscan`]'s job; by the time a [`FileTailSpec`] exists the file
//! has been validated and opened (`O_NOFOLLOW`, a regular file).
//!
//! # Lines
//!
//! `kind: "app"`, `source` = `<name> · <file basename>` / `<container> · docker` (chosen by
//! the caller), `terminalId`/`agentId` null, `level` from [`super::classify_level`] (the
//! structured-logger level column wins over keywords), `detail` = where it comes from
//! (`<path> · pid <n>`, `docker logs -f <id> · <image>`). Raw, like a service stream.
//!
//! One `system` line opens a tail (`app log started · <source>`) and one closes it
//! (`app log stopped · <source> — <reason>`), both with the stream's `source` so they land
//! in it. **Wire text** — the UI may key off these prefixes; do not reword them.
//!
//! # Bounded, like background tasks
//!
//! The last [`APP_BACKFILL_LINES`] lines are backfilled (a file: from the file, through the
//! task tails' [`TailFile`] reader; docker: `--tail 500`), then lines are admitted at most
//! [`super::tasks::TASK_LINES_PER_SEC`] a second per tail with the drops reported. At most
//! [`MAX_APP_TAILS`] tails at once.
//!
//! # When a tail ends
//!
//! A file tail stops when its process exits (the caller's liveness check, polled every
//! [`APP_ALIVE_EVERY`] — a pid whose start time changed is a different process), when the
//! file is removed, or on `logstream_untail`. A docker tail stops when `docker logs -f`
//! exits — the container stopped — or on `logstream_untail` (the child is killed).

use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;
use tokio::time::{Duration, Instant, MissedTickBehavior};

use super::splitter::LineSplitter;
use super::tasks::{TailFile, TASK_LINES_PER_SEC};
use super::{
    classify_level, LineDraft, LogHub, LogKind, LogLevel, RateLimiter, PARTIAL_FLUSH_AFTER,
};
use crate::spawn::NoWindow as _;

/// Lines of what was there before the tail started.
pub const APP_BACKFILL_LINES: usize = 500;
/// How often a file tail reads.
pub const APP_POLL: Duration = Duration::from_millis(250);
/// How often a file tail asks whether its process is still alive.
pub const APP_ALIVE_EVERY: Duration = Duration::from_secs(1);
/// Tails at once, app-wide.
pub const MAX_APP_TAILS: usize = 16;
/// The opening `system` line: `app log started · <source>`. Wire text.
pub const APP_STARTED_PREFIX: &str = "app log started · ";
/// The closing `system` line: `app log stopped · <source> — <reason>`. Wire text.
pub const APP_STOPPED_PREFIX: &str = "app log stopped · ";

/// `logstream_tail_app` / `logstream_tail_docker` → the UI. `key` is what
/// `logstream_untail` takes; `source` is the exact `LogLine.source` of the stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTailInfo {
    pub key: String,
    pub source: String,
}

/// "Is the process still the one we started tailing?" — polled by a file tail.
pub type Alive = Box<dyn FnMut() -> bool + Send>;

/// A validated, opened file to tail.
pub struct FileTailSpec {
    pub key: String,
    pub source: String,
    pub detail: String,
    /// As requested / shown.
    pub path: PathBuf,
    /// What it resolved to (to notice the file being removed).
    pub canon: PathBuf,
    pub file: File,
    /// `None` = no process to watch (a file the user picked with no pid).
    pub alive: Option<Alive>,
}

/// A container to follow with `docker logs -f --tail 500 <container>`.
pub struct DockerTailSpec {
    pub key: String,
    pub source: String,
    pub detail: String,
    /// The `docker` CLI, absolute.
    pub program: PathBuf,
    /// A container id — already checked to be a listed container.
    pub container: String,
}

/// Why a tail ended — the ` — <reason>` of its closing line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppStop {
    ProcessExited,
    FileRemoved,
    ContainerStopped,
    ByUser,
    Failed(String),
}

impl std::fmt::Display for AppStop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppStop::ProcessExited => write!(f, "process exited"),
            AppStop::FileRemoved => write!(f, "log file removed"),
            AppStop::ContainerStopped => write!(f, "container stopped"),
            AppStop::ByUser => write!(f, "stopped"),
            AppStop::Failed(e) => write!(f, "{e}"),
        }
    }
}

struct Entry {
    gen: u64,
    source: String,
    stop: Option<oneshot::Sender<()>>,
}

/// The live app tails. Cheap to clone.
#[derive(Clone)]
pub struct AppTails {
    hub: LogHub,
    inner: Arc<Mutex<HashMap<String, Entry>>>,
    gen: Arc<AtomicU64>,
}

fn line(source: &str, detail: &str, kind: LogKind, level: LogLevel, text: String) -> LineDraft {
    LineDraft {
        terminal_id: None,
        agent_id: None,
        source: source.to_string(),
        kind,
        level,
        text,
        detail: Some(detail.to_string()),
        ts_ms: None,
        tool_use_id: None,
    }
}

impl AppTails {
    pub fn new(hub: LogHub) -> Self {
        Self {
            hub,
            inner: Arc::new(Mutex::new(HashMap::new())),
            gen: Arc::new(AtomicU64::new(1)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Keys of the live tails, sorted.
    pub fn keys(&self) -> Vec<String> {
        let mut k: Vec<String> = self.lock().keys().cloned().collect();
        k.sort();
        k
    }

    pub fn is_tailing(&self, key: &str) -> bool {
        self.lock().contains_key(key)
    }

    /// Reserve `key`: `Ok(Some((gen, stop)))` = newly reserved (the caller starts it),
    /// `Ok(None)` = already running (idempotent), `Err` = at the cap.
    fn reserve(
        &self,
        key: &str,
        source: &str,
    ) -> Result<Option<(u64, oneshot::Receiver<()>)>, String> {
        let mut map = self.lock();
        if map.contains_key(key) {
            return Ok(None);
        }
        if map.len() >= MAX_APP_TAILS {
            return Err(format!(
                "{MAX_APP_TAILS} app logs are already streaming — stop one first"
            ));
        }
        let gen = self.gen.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        map.insert(
            key.to_string(),
            Entry {
                gen,
                source: source.to_string(),
                stop: Some(tx),
            },
        );
        Ok(Some((gen, rx)))
    }

    fn info(&self, key: &str) -> AppTailInfo {
        let source = self
            .lock()
            .get(key)
            .map(|e| e.source.clone())
            .unwrap_or_default();
        AppTailInfo {
            key: key.to_string(),
            source,
        }
    }

    /// Forget `key` if it is still the tail `gen` (a new tail under the same key is not
    /// removed by the end of an old one).
    fn release(&self, key: &str, gen: u64) {
        let mut map = self.lock();
        if map.get(key).is_some_and(|e| e.gen == gen) {
            map.remove(key);
        }
    }

    /// Stop a tail (`logstream_untail`). `true` if it was running.
    pub fn stop(&self, key: &str) -> bool {
        let entry = self.lock().remove(key);
        match entry {
            Some(mut e) => {
                if let Some(tx) = e.stop.take() {
                    let _ = tx.send(());
                }
                true
            }
            None => false,
        }
    }

    /// Start tailing an opened file. Needs a tokio runtime.
    pub fn start_file(&self, spec: FileTailSpec) -> Result<AppTailInfo, String> {
        let key = spec.key.clone();
        let Some((gen, stop_rx)) = self.reserve(&key, &spec.source)? else {
            return Ok(self.info(&key));
        };
        let info = AppTailInfo {
            key: key.clone(),
            source: spec.source.clone(),
        };
        let me = self.clone();
        tokio::spawn(async move {
            me.run_file(spec, stop_rx).await;
            me.release(&key, gen);
        });
        Ok(info)
    }

    async fn run_file(&self, spec: FileTailSpec, mut stop_rx: oneshot::Receiver<()>) {
        let FileTailSpec {
            source,
            detail,
            path,
            canon,
            file,
            mut alive,
            ..
        } = spec;
        let emit = |lines: Vec<(LogLevel, String)>| {
            self.hub.push_batch(
                lines
                    .into_iter()
                    .map(|(lv, t)| line(&source, &detail, LogKind::App, lv, t))
                    .collect(),
            );
        };
        self.hub.push(line(
            &source,
            &detail,
            LogKind::System,
            LogLevel::Info,
            format!("{APP_STARTED_PREFIX}{source}"),
        ));
        let mut tf = TailFile::opened(path, file, canon, Instant::now(), APP_BACKFILL_LINES);
        let mut tick = tokio::time::interval(APP_POLL);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut last_alive = Instant::now();
        let why = loop {
            tokio::select! {
                _ = &mut stop_rx => break AppStop::ByUser,
                _ = tick.tick() => {}
            }
            let now = Instant::now();
            emit(tf.read_new(now, false));
            if tf.canon().is_some_and(|c| !c.exists()) {
                break AppStop::FileRemoved;
            }
            if now.duration_since(last_alive) >= APP_ALIVE_EVERY {
                last_alive = now;
                if let Some(a) = alive.as_mut() {
                    if !a() {
                        break AppStop::ProcessExited;
                    }
                }
            }
        };
        emit(tf.read_new(Instant::now(), true));
        self.hub.push(closing(&source, &detail, &why));
    }

    /// Start following a container's logs. Needs a tokio runtime.
    pub fn start_docker(&self, spec: DockerTailSpec) -> Result<AppTailInfo, String> {
        let key = spec.key.clone();
        let Some((gen, stop_rx)) = self.reserve(&key, &spec.source)? else {
            return Ok(self.info(&key));
        };
        let info = AppTailInfo {
            key: key.clone(),
            source: spec.source.clone(),
        };
        let me = self.clone();
        tokio::spawn(async move {
            me.run_docker(spec, stop_rx).await;
            me.release(&key, gen);
        });
        Ok(info)
    }

    async fn run_docker(&self, spec: DockerTailSpec, mut stop_rx: oneshot::Receiver<()>) {
        let DockerTailSpec {
            source,
            detail,
            program,
            container,
            ..
        } = spec;
        let tail = APP_BACKFILL_LINES.to_string();
        let child = tokio::process::Command::new(&program)
            .args(["logs", "-f", "--tail", tail.as_str(), container.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_window()
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                self.hub.push(closing(
                    &source,
                    &detail,
                    &AppStop::Failed(format!("docker logs could not start: {e}")),
                ));
                return;
            }
        };
        self.hub.push(line(
            &source,
            &detail,
            LogKind::System,
            LogLevel::Info,
            format!("{APP_STARTED_PREFIX}{source}"),
        ));
        let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) else {
            self.hub.push(closing(
                &source,
                &detail,
                &AppStop::Failed("docker logs has no output".into()),
            ));
            return;
        };
        let mut feed = DockerFeed::new();
        let (mut bo, mut be) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
        let (mut out_open, mut err_open) = (true, true);
        let mut tick = tokio::time::interval(PARTIAL_FLUSH_AFTER);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let emit = |lines: Vec<(LogLevel, String)>| {
            self.hub.push_batch(
                lines
                    .into_iter()
                    .map(|(lv, t)| line(&source, &detail, LogKind::App, lv, t))
                    .collect(),
            );
        };
        let stopped_by_user = loop {
            if !out_open && !err_open {
                break false;
            }
            tokio::select! {
                _ = &mut stop_rx => break true,
                n = out.read(&mut bo), if out_open => match n {
                    Ok(0) | Err(_) => out_open = false,
                    Ok(n) => emit(feed.feed(0, &bo[..n], Instant::now())),
                },
                n = err.read(&mut be), if err_open => match n {
                    Ok(0) | Err(_) => err_open = false,
                    Ok(n) => emit(feed.feed(1, &be[..n], Instant::now())),
                },
                _ = tick.tick() => emit(feed.flush_idle(Instant::now())),
            }
        };
        emit(feed.flush_all());
        let why = if stopped_by_user {
            let _ = child.kill().await;
            AppStop::ByUser
        } else {
            match child.wait().await {
                Ok(s) if s.success() => AppStop::ContainerStopped,
                Ok(s) => AppStop::Failed(format!("docker logs exited ({s})")),
                Err(e) => AppStop::Failed(format!("docker logs: {e}")),
            }
        };
        self.hub.push(closing(&source, &detail, &why));
    }
}

fn closing(source: &str, detail: &str, why: &AppStop) -> LineDraft {
    let level = match why {
        AppStop::Failed(_) => LogLevel::Warn,
        _ => LogLevel::Info,
    };
    line(
        source,
        detail,
        LogKind::System,
        level,
        format!("{APP_STOPPED_PREFIX}{source} — {why}"),
    )
}

/// `docker logs` output → lines: stdout and stderr split separately, the first
/// [`APP_BACKFILL_LINES`] lines (the `--tail` backfill) admitted as one burst, the rest
/// rate-capped with the drops reported.
struct DockerFeed {
    splitters: [LineSplitter; 2],
    last_bytes: [Instant; 2],
    backfill_left: usize,
    limiter: RateLimiter,
}

impl DockerFeed {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            splitters: [LineSplitter::new(), LineSplitter::new()],
            last_bytes: [now, now],
            backfill_left: APP_BACKFILL_LINES,
            limiter: RateLimiter::new(TASK_LINES_PER_SEC),
        }
    }

    fn admit(&mut self, texts: Vec<String>, now: Instant) -> Vec<(LogLevel, String)> {
        let mut out = Vec::new();
        for t in texts {
            if self.backfill_left > 0 {
                self.backfill_left -= 1;
                out.push((classify_level(&t), t));
            } else if self.limiter.admit(now) {
                out.push((classify_level(&t), t));
            }
        }
        if let Some(n) = self.limiter.take_drop_report(now) {
            out.push((LogLevel::Warn, format!("… {n} lines dropped (rate limit)")));
        }
        out
    }

    fn feed(&mut self, stream: usize, bytes: &[u8], now: Instant) -> Vec<(LogLevel, String)> {
        self.last_bytes[stream] = now;
        let texts = self.splitters[stream].feed(bytes);
        self.admit(texts, now)
    }

    fn flush_idle(&mut self, now: Instant) -> Vec<(LogLevel, String)> {
        let mut texts = Vec::new();
        for i in 0..2 {
            if self.splitters[i].has_partial()
                && now.duration_since(self.last_bytes[i]) >= PARTIAL_FLUSH_AFTER
            {
                texts.extend(self.splitters[i].flush_partial());
            }
        }
        self.admit(texts, now)
    }

    fn flush_all(&mut self) -> Vec<(LogLevel, String)> {
        let texts: Vec<String> = self
            .splitters
            .iter_mut()
            .filter_map(|s| s.flush_partial())
            .collect();
        self.admit(texts, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows, the file-tail path the app uses (`procscan::open_regular` → [`AppTails`]) against
    /// ANOTHER process that holds the file open for writing — with `FileShare.Read | Delete`,
    /// .NET's default writer sharing plus delete: its lines arrive live; a truncation is noticed
    /// (NTFS reports the size through our handle at once); our handle does not stop the file
    /// from being deleted, and the deletion ends the tail with "log file removed".
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn windows_a_file_another_process_appends_to_is_tailed_through_truncation_and_removal() {
        use crate::logstream::NullLogSink;
        use crate::spawn::NoWindow;
        let raw = std::env::temp_dir().join(format!("agentstudio-apptail-{}", std::process::id()));
        std::fs::create_dir_all(&raw).unwrap();
        let dir = crate::paths::canonicalize(&raw).unwrap();
        let path = dir.join("w.log");
        std::fs::write(&path, "").unwrap();
        let script = "$f = [System.IO.File]::Open('w.log', 'OpenOrCreate', 'Write', 'Read, Delete'); \
                      [void]$f.Seek(0, 'End'); \
                      $w = New-Object System.IO.StreamWriter($f); $w.AutoFlush = $true; \
                      1..15 | ForEach-Object { $w.WriteLine(\"INFO before $_\"); Start-Sleep -Milliseconds 100 }; \
                      Start-Sleep -Milliseconds 800; $f.SetLength(0); \
                      1..40 | ForEach-Object { $w.WriteLine(\"WARN after $_\"); Start-Sleep -Milliseconds 100 }; \
                      Start-Sleep 30";
        /// Kills and reaps the writer, removes the dir, however the test ends.
        struct Cleanup(std::process::Child, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let writer = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .no_window()
            .spawn()
            .expect("powershell starts");
        let _cleanup = Cleanup(writer, dir.clone());
        let deadline = Instant::now() + Duration::from_secs(30);
        while !std::fs::read_to_string(&path).is_ok_and(|t| t.contains("INFO before 1")) {
            assert!(Instant::now() < deadline, "the writer never wrote");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // The writer holds it open for writing right now; we open it the way the app does.
        let file = crate::procscan::open_regular(&path).expect("opens beside the writer");
        let (hub, task) = LogHub::new(Arc::new(NullLogSink));
        tokio::spawn(task);
        let tails = AppTails::new(hub.clone());
        let info = tails
            .start_file(FileTailSpec {
                key: "file:w".into(),
                source: "w · w.log".into(),
                detail: path.display().to_string(),
                path: path.clone(),
                canon: path.clone(),
                file,
                alive: None,
            })
            .unwrap();
        let texts = |prefix: &str| -> Vec<String> {
            hub.snapshot()
                .into_iter()
                .filter(|l| l.kind == LogKind::App && l.source == info.source)
                .map(|l| l.text)
                .filter(|t| t.starts_with(prefix))
                .collect()
        };
        while texts("INFO before 15").is_empty() {
            assert!(Instant::now() < deadline, "live lines: {:?}", texts(""));
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // The writer truncates, then writes again: the tail starts over and reads it.
        while texts("WARN after 3").is_empty() {
            assert!(
                Instant::now() < deadline,
                "after truncation: {:?}",
                texts("")
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let warn = hub
            .snapshot()
            .into_iter()
            .find(|l| l.text.starts_with("WARN after"))
            .unwrap();
        assert_eq!(warn.level, LogLevel::Warn);
        assert!(
            !texts("").iter().any(|t| t.contains('\0')),
            "no hole read as NULs across the truncation: {:?}",
            texts("")
        );
        // Neither our handle nor the writer's stops a delete; the tail notices.
        std::fs::remove_file(&path).expect("a tailed file can still be deleted");
        let stopped = format!("{APP_STOPPED_PREFIX}{} — log file removed", info.source);
        while !hub.snapshot().iter().any(|l| l.text == stopped) {
            assert!(Instant::now() < deadline, "no stop line");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        while tails.is_tailing(&info.key) {
            assert!(
                Instant::now() < deadline,
                "the ended tail was never released"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The documented limits restated as literals, never read off the constants.
    #[test]
    fn the_numbers() {
        assert_eq!(APP_BACKFILL_LINES, 500);
        assert_eq!(MAX_APP_TAILS, 16);
        assert_eq!(APP_STARTED_PREFIX, "app log started · ");
        assert_eq!(APP_STOPPED_PREFIX, "app log stopped · ");
    }

    #[test]
    fn the_docker_backfill_is_one_burst_then_the_cap_applies() {
        let t0 = Instant::now();
        let mut f = DockerFeed::new();
        let backfill: String = (0..APP_BACKFILL_LINES).map(|i| format!("b{i}\n")).collect();
        assert_eq!(f.feed(0, backfill.as_bytes(), t0).len(), APP_BACKFILL_LINES);
        let live: String = (0..TASK_LINES_PER_SEC + 3)
            .map(|i| format!("ERROR l{i}\n"))
            .collect();
        let got = f.feed(1, live.as_bytes(), t0);
        assert_eq!(
            got.len(),
            TASK_LINES_PER_SEC as usize + 1,
            "cap + one drop line"
        );
        assert_eq!(got[0].0, LogLevel::Error);
        assert_eq!(
            got.last().unwrap().1,
            "… 3 lines dropped (rate limit)".to_string()
        );
    }

    #[test]
    fn stop_reasons_read_as_the_ui_shows_them() {
        assert_eq!(AppStop::ProcessExited.to_string(), "process exited");
        assert_eq!(AppStop::ContainerStopped.to_string(), "container stopped");
        let l = closing("svc · svc.log", "d", &AppStop::ProcessExited);
        assert_eq!(l.text, "app log stopped · svc · svc.log — process exited");
        assert_eq!(l.kind, LogKind::System);
    }
}
