//! Log stream — the fleet-wide log hub behind the Agent Logs tab
//! (the logs of everything the agents inside the IDE are running, visible in one view).
//!
//! # Shape
//!
//! ```text
//!  pump_to_ui ──LogTap::feed (try_send, never waits)──┐
//!  supervisor ──LogHub::push (tool / system lines)────┤ bounded mpsc
//!                                                     ▼
//!                               hub task: split lines per terminal, level, id
//!                                   │                    │
//!                          ring (20 000, snapshot)   batched emit ≤ 1 / 100 ms,
//!                                                    ≤ 2 000 lines → `logstream://lines`
//! ```
//!
//! # The hot byte plane never waits on the log
//!
//! The tap runs **inside** the coalescer loop. It does exactly one thing there: a
//! `try_send` of a refcounted `Bytes` clone. A full queue drops the chunk and counts it;
//! the count rides along with the next chunk that does get through, and the hub turns it
//! into a `system` line ("… N output chunks dropped"). Splitting, ANSI stripping and
//! level guessing all happen on the hub task.
//!
//! # Suppression
//!
//! While a runtime session is bound to a terminal (the supervisor's binding table), the
//! tap does not even send: Claude's TUI redraws are noise, and its transcript (source 2,
//! [`crate::agent::tools`]) carries the real signal. When the session ends, the next
//! chunk carries `reset` so the splitter forgets any half-parsed state the TUI left.
//!
//! # Testability
//!
//! Like the supervisor's [`crate::events::EventSink`], emission goes through a trait
//! ([`LogSink`]) so the hub is constructible without a Tauri app; tests pass a
//! recorder, and [`LogHub::new`] hands back the task future so a test can run it on a
//! paused tokio clock.

pub mod apps;
pub mod bypass;
pub mod level;
pub mod screen;
pub mod splitter;
pub mod tasks;

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant, MissedTickBehavior};

pub use level::classify_level;
use screen::ScreenSplitter;
use splitter::LineSplitter;

/// What turns one terminal's PTY bytes into lines is per OS (platform-native): a Unix PTY
/// carries the program's own text, which the stream splitter reads; on Windows ConPTY repaints a
/// screen, which only a screen model reads (`screen.rs` says why, with recordings). Both compile
/// and are tested everywhere; only this choice is per OS. They share `new`/`feed`/
/// `flush_partial`/`has_partial`/`reset`; the PTY size matters to the screen model alone.
trait TermResize {
    fn term_resize(&mut self, rows: u16, cols: u16);
}

impl TermResize for LineSplitter {
    fn term_resize(&mut self, _rows: u16, _cols: u16) {}
}

impl TermResize for ScreenSplitter {
    fn term_resize(&mut self, rows: u16, cols: u16) {
        self.resize(rows, cols);
    }
}

#[cfg(windows)]
type TermSplitter = ScreenSplitter;
#[cfg(not(windows))]
type TermSplitter = LineSplitter;

/// The event name.
pub const LINES_EVENT: &str = "logstream://lines";
/// Ring capacity, in lines.
pub const RING_CAP: usize = 20_000;
/// At most one emit per this interval…
pub const EMIT_INTERVAL: Duration = Duration::from_millis(100);
/// …of at most this many lines.
pub const EMIT_MAX_LINES: usize = 2_000;
/// An unterminated line is flushed after this much silence on its terminal.
pub const PARTIAL_FLUSH_AFTER: Duration = Duration::from_millis(250);
/// Depth of the tap → hub queue, in messages (a message is one coalesced PTY read, up
/// to the reader's chunk size). Deep enough to absorb a burst; bounded so a stalled
/// hub costs memory we chose, not memory a firehose chose.
pub const HUB_QUEUE: usize = 2_048;
/// Cap on a `detail` payload (a tool result's first 40 lines can still be huge).
pub const MAX_DETAIL_BYTES: usize = 16 * 1024;
/// Housekeeping cadence of the hub task (partial-line flush + emit check).
const TICK: Duration = Duration::from_millis(50);
/// Cap on `machine` lines (other apps' logs) admitted per second. The whole
/// Mac logs ~150–500 lines/s idle and far more in a burst; uncapped it would push the IDE's
/// own lines out of the 20 000-line ring in well under a minute.
pub const MACHINE_LINES_PER_SEC: u32 = 500;
/// How often (at most) the hub reports machine lines the cap dropped.
pub const MACHINE_DROP_REPORT_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogKind {
    Output,
    Tool,
    ToolResult,
    System,
    /// A line from another app on the computer (macOS unified log / Linux journald),
    /// rate-capped at [`MACHINE_LINES_PER_SEC`] — see [`RateLimiter`].
    Machine,
    /// A line of a background task's output file (Claude's `run_in_background` Bash or
    /// `Monitor`) — see [`tasks`]. Rate-capped per file.
    Task,
    /// A line of a dev app's log running on this machine outside the IDE (a file its
    /// process has open, or `docker logs`) — see [`apps`]. Rate-capped per
    /// tail like [`LogKind::Task`].
    App,
}

/// One line of the Agent Logs view. Wire contract: `LogLine` in
/// `src/features/agentlogs/agentLogsTypes.ts` (serde camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Monotonic per app run — survives `logstream_clear`.
    pub id: u64,
    /// Unix ms when the line completed (a tool line: when the transcript says the call
    /// happened).
    pub ts_ms: i64,
    pub terminal_id: Option<String>,
    pub agent_id: Option<String>,
    pub source: String,
    pub kind: LogKind,
    pub level: LogLevel,
    /// ANSI-stripped, ≤ 4 KiB.
    pub text: String,
    pub detail: Option<String>,
    /// The transcript's `tool_use.id` on a `tool` line and the matching `tool_use_id` on
    /// its `tool-result` line, so the UI pairs a call with its output by id and never by
    /// guessing. `null` on every other kind.
    /// `#[serde(default)]` so a line written before the field existed still reads.
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// A line before the hub gives it an id (and, if absent, a timestamp).
#[derive(Debug, Clone)]
pub struct LineDraft {
    pub terminal_id: Option<String>,
    pub agent_id: Option<String>,
    pub source: String,
    pub kind: LogKind,
    pub level: LogLevel,
    pub text: String,
    pub detail: Option<String>,
    /// `None` → stamped "now" by the hub.
    pub ts_ms: Option<i64>,
    /// See [`LogLine::tool_use_id`]; only a tool call / result sets it.
    pub tool_use_id: Option<String>,
}

impl LineDraft {
    /// A lifecycle line (terminal opened/exited, agent started/exited).
    pub fn system(
        terminal_id: Option<&str>,
        agent_id: Option<&str>,
        source: &str,
        level: LogLevel,
        text: impl Into<String>,
    ) -> Self {
        Self {
            terminal_id: terminal_id.map(str::to_string),
            agent_id: agent_id.map(str::to_string),
            source: source.to_string(),
            kind: LogKind::System,
            level,
            text: text.into(),
            detail: None,
            ts_ms: None,
            tool_use_id: None,
        }
    }
}

/// Where batches of lines go. Production: [`TauriLogSink`]; tests: a recorder.
pub trait LogSink: Send + Sync + 'static {
    fn emit(&self, lines: &[LogLine]);
}

/// Drops everything.
pub struct NullLogSink;

impl LogSink for NullLogSink {
    fn emit(&self, _lines: &[LogLine]) {}
}

/// `app.emit("logstream://lines", batch)`.
pub struct TauriLogSink<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> LogSink for TauriLogSink<R> {
    fn emit(&self, lines: &[LogLine]) {
        use tauri::Emitter;
        // A failed emit = the webview is gone. The ring still has the lines for the
        // next `logstream_snapshot`; nothing to recover here.
        let _ = self.0.emit(LINES_EVENT, lines);
    }
}

enum HubMsg {
    Output {
        terminal_id: Arc<str>,
        bytes: Bytes,
        /// Chunks this tap dropped (queue full) since its last successful send.
        dropped: u64,
        /// The terminal is coming back from suppression: reset its splitter first.
        reset: bool,
    },
    /// The PTY was resized (and, once, its size at spawn) — the Windows screen model's size.
    Resize {
        terminal_id: Arc<str>,
        rows: u16,
        cols: u16,
    },
    /// The PTY closed: flush the terminal's partial line.
    Eof {
        terminal_id: Arc<str>,
    },
    /// The terminal is gone for good: drop its splitter state.
    Forget {
        terminal_id: String,
    },
    Line(LineDraft),
    /// Several lines in one queue slot (a background task's backfill can be 2 000).
    Lines(Vec<LineDraft>),
}

struct Ring {
    lines: VecDeque<LogLine>,
    next_id: u64,
    /// Lines with an id below this were cleared; a pending emit must not resurrect them.
    cleared_below: u64,
}

struct TermEntry {
    label: String,
    suppressed: Arc<AtomicBool>,
}

struct Shared {
    ring: Mutex<Ring>,
    terminals: Mutex<HashMap<String, TermEntry>>,
    /// `push` calls that found the queue full (tool/system lines), reported by the hub.
    dropped_lines: AtomicU64,
    /// The machine-line cap. Applied in [`LogHub::push`], BEFORE the queue, so a firehose
    /// of other apps' logs cannot fill the queue the IDE's own lines travel through.
    machine: Mutex<RateLimiter>,
    /// The app-wide budget of background-task tails ([`tasks::MAX_TASK_TAILS`]).
    task_slots: tasks::TaskSlots,
}

impl Shared {
    /// Stamp ids and store in the ring. Returns the stored lines (for the emit queue).
    fn commit(&self, drafts: Vec<LineDraft>) -> Vec<LogLine> {
        if drafts.is_empty() {
            return Vec::new();
        }
        let now = now_ms();
        let mut ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = Vec::with_capacity(drafts.len());
        for d in drafts {
            let line = LogLine {
                id: ring.next_id,
                ts_ms: d.ts_ms.unwrap_or(now),
                terminal_id: d.terminal_id,
                agent_id: d.agent_id,
                source: d.source,
                kind: d.kind,
                level: d.level,
                text: d.text,
                detail: d.detail,
                tool_use_id: d.tool_use_id,
            };
            ring.next_id += 1;
            ring.lines.push_back(line.clone());
            while ring.lines.len() > RING_CAP {
                ring.lines.pop_front();
            }
            out.push(line);
        }
        out
    }

    fn label_of(&self, terminal_id: &str) -> String {
        self.terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(terminal_id)
            .map(|t| t.label.clone())
            .unwrap_or_else(|| terminal_id.to_string())
    }
}

/// The hub. Cheap to clone; register as Tauri managed state.
#[derive(Clone)]
pub struct LogHub {
    tx: mpsc::Sender<HubMsg>,
    shared: Arc<Shared>,
}

/// The hub's task, to be spawned by the caller (see [`LogHub::new`]).
pub type HubTask = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

impl LogHub {
    /// Build a hub and the task that drives it. The caller spawns the task — a test on
    /// a paused tokio runtime, production via [`LogHub::spawn`].
    pub fn new(sink: Arc<dyn LogSink>) -> (Self, HubTask) {
        let (tx, rx) = mpsc::channel(HUB_QUEUE);
        let shared = Arc::new(Shared {
            ring: Mutex::new(Ring {
                lines: VecDeque::new(),
                next_id: 1,
                cleared_below: 0,
            }),
            terminals: Mutex::new(HashMap::new()),
            dropped_lines: AtomicU64::new(0),
            machine: Mutex::new(RateLimiter::new(MACHINE_LINES_PER_SEC)),
            task_slots: tasks::TaskSlots::new(tasks::MAX_TASK_TAILS),
        });
        let task = Box::pin(run_hub(rx, shared.clone(), sink));
        (Self { tx, shared }, task)
    }

    /// Build a hub and spawn its task on Tauri's runtime.
    pub fn spawn(sink: Arc<dyn LogSink>) -> Self {
        let (hub, task) = Self::new(sink);
        tauri::async_runtime::spawn(task);
        hub
    }

    /// Register a terminal and hand back the tap its pump will feed. `suppressed` is the
    /// initial state (a spawned agent's terminal is bound from birth).
    ///
    /// Each terminal is its own log source: when another open terminal already has `label`
    /// (two `powershell` terminals in one folder — every Windows terminal is titled
    /// `powershell`), this one becomes `label (2)`, `(3)`, … The label is the source KEY in the
    /// Logs view, so two terminals sharing one merged into one row and borrowed each other's
    /// names. [`LogHub::source_of`] says which label a terminal got.
    pub fn tap(&self, terminal_id: &str, label: &str, suppressed: bool) -> LogTap {
        let flag = Arc::new(AtomicBool::new(suppressed));
        let mut terminals = self
            .shared
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let taken = |l: &str| {
            terminals
                .iter()
                .any(|(id, t)| id != terminal_id && t.label == l)
        };
        let mut unique = label.to_string();
        let mut n = 2;
        while taken(&unique) {
            unique = format!("{label} ({n})");
            n += 1;
        }
        terminals.insert(
            terminal_id.to_string(),
            TermEntry {
                label: unique,
                suppressed: flag.clone(),
            },
        );
        drop(terminals);
        LogTap {
            tx: self.tx.clone(),
            terminal_id: Arc::from(terminal_id),
            suppressed: flag,
            was_suppressed: false,
            dropped: 0,
        }
    }

    /// The source label `terminal_id`'s lines carry (what [`LogHub::tap`] gave it), or `None`
    /// for a terminal the hub does not know.
    pub fn source_of(&self, terminal_id: &str) -> Option<String> {
        self.shared
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(terminal_id)
            .map(|t| t.label.clone())
    }

    /// The terminal's PTY size: at spawn and on every resize. Never waits (a full queue drops
    /// it; the Windows screen model then keeps its last size until the next one).
    pub fn resize(&self, terminal_id: &str, rows: u16, cols: u16) {
        let _ = self.tx.try_send(HubMsg::Resize {
            terminal_id: Arc::from(terminal_id),
            rows,
            cols,
        });
    }

    /// Suppress (a session is bound) or resume a terminal's output lines.
    pub fn set_suppressed(&self, terminal_id: &str, suppressed: bool) {
        if let Some(t) = self
            .shared
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(terminal_id)
        {
            t.suppressed.store(suppressed, Ordering::Relaxed);
        }
    }

    /// Is `terminal_id`'s output currently suppressed? (`None` = unknown terminal.)
    pub fn is_suppressed(&self, terminal_id: &str) -> Option<bool> {
        self.shared
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(terminal_id)
            .map(|t| t.suppressed.load(Ordering::Relaxed))
    }

    /// The terminal was closed: drop its registration and splitter state.
    pub fn forget(&self, terminal_id: &str) {
        self.shared
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(terminal_id);
        let _ = self.tx.try_send(HubMsg::Forget {
            terminal_id: terminal_id.to_string(),
        });
    }

    /// Queue a tool/system/machine line. Never waits: a full queue drops it and counts it.
    /// A [`LogKind::Machine`] line must first get past the rate cap; one the
    /// cap refuses is counted and reported by the hub once a second, never queued.
    pub fn push(&self, draft: LineDraft) {
        if draft.kind == LogKind::Machine {
            let admitted = self
                .shared
                .machine
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .admit(Instant::now());
            if !admitted {
                return;
            }
        }
        if self.tx.try_send(HubMsg::Line(draft)).is_err() {
            self.shared.dropped_lines.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Queue several lines as one message (never waits; a full queue drops them all and
    /// counts each). Not for machine lines — those go through [`LogHub::push`]'s cap.
    pub fn push_batch(&self, drafts: Vec<LineDraft>) {
        if drafts.is_empty() {
            return;
        }
        let n = drafts.len() as u64;
        if self.tx.try_send(HubMsg::Lines(drafts)).is_err() {
            self.shared.dropped_lines.fetch_add(n, Ordering::Relaxed);
        }
    }

    /// The app-wide background-task tail budget, shared by every root's tailer.
    pub fn task_slots(&self) -> tasks::TaskSlots {
        self.shared.task_slots.clone()
    }

    /// Machine lines `(admitted, dropped)` in the last complete one-second window — the
    /// `linesPerSec` / `droppedPerSec` of `syslog_status`.
    pub fn machine_rates(&self) -> (u32, u32) {
        self.shared
            .machine
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .rates(Instant::now())
    }

    /// The whole ring, oldest first (`logstream_snapshot`).
    pub fn snapshot(&self) -> Vec<LogLine> {
        let ring = self.shared.ring.lock().unwrap_or_else(|p| p.into_inner());
        ring.lines.iter().cloned().collect()
    }

    /// Empty the ring (`logstream_clear`). Ids keep increasing.
    pub fn clear(&self) {
        let mut ring = self.shared.ring.lock().unwrap_or_else(|p| p.into_inner());
        ring.lines.clear();
        ring.cleared_below = ring.next_id;
    }
}

/// One terminal's tap, owned by its pump. `feed` is the only thing on the hot path.
pub struct LogTap {
    tx: mpsc::Sender<HubMsg>,
    terminal_id: Arc<str>,
    suppressed: Arc<AtomicBool>,
    was_suppressed: bool,
    dropped: u64,
}

impl LogTap {
    /// Hand one PTY chunk to the hub. **Never waits**: `try_send` or drop-and-count.
    pub fn feed(&mut self, bytes: &Bytes) {
        if self.suppressed.load(Ordering::Relaxed) {
            self.was_suppressed = true;
            return;
        }
        let reset = self.was_suppressed;
        let msg = HubMsg::Output {
            terminal_id: self.terminal_id.clone(),
            bytes: bytes.clone(),
            dropped: self.dropped,
            reset,
        };
        match self.tx.try_send(msg) {
            Ok(()) => {
                self.dropped = 0;
                self.was_suppressed = false;
            }
            Err(_) => self.dropped += 1,
        }
    }

    /// The PTY closed; let the hub flush the partial line.
    pub fn eof(&mut self) {
        let _ = self.tx.try_send(HubMsg::Eof {
            terminal_id: self.terminal_id.clone(),
        });
    }

    /// Chunks dropped since the last successful send.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

struct TermState {
    splitter: TermSplitter,
    last_bytes: Instant,
}

impl TermState {
    fn new() -> Self {
        Self {
            splitter: TermSplitter::new(),
            last_bytes: Instant::now(),
        }
    }
}

async fn run_hub(mut rx: mpsc::Receiver<HubMsg>, shared: Arc<Shared>, sink: Arc<dyn LogSink>) {
    let mut terms: HashMap<Arc<str>, TermState> = HashMap::new();
    let mut pending: VecDeque<LogLine> = VecDeque::new();
    let mut last_emit: Option<Instant> = None;
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                let drafts = handle(msg, &mut terms, &shared);
                pending.extend(shared.commit(drafts));
                // Bound the backlog: the ring already holds everything, and a UI that
                // fell this far behind will re-snapshot anyway.
                while pending.len() > RING_CAP {
                    pending.pop_front();
                }
            }
            _ = tick.tick() => {
                let now = Instant::now();
                let mut drafts = Vec::new();
                for (id, t) in terms.iter_mut() {
                    if t.splitter.has_partial() && now.duration_since(t.last_bytes) >= PARTIAL_FLUSH_AFTER {
                        if let Some(text) = t.splitter.flush_partial() {
                            drafts.push(output_draft(id, &shared, text));
                        }
                    }
                }
                let lost = shared.dropped_lines.swap(0, Ordering::Relaxed);
                if lost > 0 {
                    drafts.push(LineDraft::system(
                        None,
                        None,
                        "logs",
                        LogLevel::Warn,
                        format!("… {lost} log lines dropped (log queue full)"),
                    ));
                }
                let capped = shared
                    .machine
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take_drop_report(now);
                if let Some(n) = capped {
                    drafts.push(LineDraft::system(
                        None,
                        None,
                        "logs",
                        LogLevel::Warn,
                        format!("… {n} system-app lines dropped (rate limit)"),
                    ));
                }
                pending.extend(shared.commit(drafts));

                let due = last_emit.is_none_or(|t| now.duration_since(t) >= EMIT_INTERVAL);
                if due && !pending.is_empty() {
                    let cleared_below = shared
                        .ring
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .cleared_below;
                    pending.retain(|l| l.id >= cleared_below);
                    let n = pending.len().min(EMIT_MAX_LINES);
                    if n > 0 {
                        let batch: Vec<LogLine> = pending.drain(..n).collect();
                        sink.emit(&batch);
                        last_emit = Some(now);
                    }
                }
            }
        }
    }
}

fn handle(
    msg: HubMsg,
    terms: &mut HashMap<Arc<str>, TermState>,
    shared: &Shared,
) -> Vec<LineDraft> {
    match msg {
        HubMsg::Output {
            terminal_id,
            bytes,
            dropped,
            reset,
        } => {
            let mut drafts = Vec::new();
            if dropped > 0 {
                let source = shared.label_of(&terminal_id);
                drafts.push(LineDraft::system(
                    Some(&terminal_id),
                    None,
                    &source,
                    LogLevel::Warn,
                    format!("… {dropped} output chunks dropped (log queue full)"),
                ));
            }
            let t = terms
                .entry(terminal_id.clone())
                .or_insert_with(TermState::new);
            if reset {
                t.splitter.reset();
            }
            t.last_bytes = Instant::now();
            for text in t.splitter.feed(&bytes) {
                drafts.push(output_draft(&terminal_id, shared, text));
            }
            drafts
        }
        HubMsg::Resize {
            terminal_id,
            rows,
            cols,
        } => {
            terms
                .entry(terminal_id)
                .or_insert_with(TermState::new)
                .splitter
                .term_resize(rows, cols);
            Vec::new()
        }
        HubMsg::Eof { terminal_id } => {
            let mut drafts = Vec::new();
            if let Some(t) = terms.get_mut(&terminal_id) {
                if let Some(text) = t.splitter.flush_partial() {
                    drafts.push(output_draft(&terminal_id, shared, text));
                }
            }
            drafts
        }
        HubMsg::Forget { terminal_id } => {
            terms.remove(terminal_id.as_str());
            Vec::new()
        }
        HubMsg::Line(d) => vec![d],
        HubMsg::Lines(ds) => ds,
    }
}

fn output_draft(terminal_id: &str, shared: &Shared, text: String) -> LineDraft {
    LineDraft {
        terminal_id: Some(terminal_id.to_string()),
        agent_id: None,
        source: shared.label_of(terminal_id),
        kind: LogKind::Output,
        level: classify_level(&text),
        text,
        detail: None,
        ts_ms: None,
        tool_use_id: None,
    }
}

/// A fixed-window rate cap: at most `per_sec` admissions per one-second window, the rest
/// counted as dropped. The clock is a parameter (`now`), so the policy is testable with
/// made-up instants and the hub drives it from tokio's (pausable) clock.
///
/// Fixed windows, not a token bucket, on purpose: the numbers it reports (`rates`) are
/// the same windows the user reads as "lines per second", and a burst straddling a
/// boundary admitting up to 2× for an instant is harmless here — the point is only that
/// the machine can never out-shout the IDE for longer than that.
#[derive(Debug)]
pub struct RateLimiter {
    per_sec: u32,
    window_start: Option<Instant>,
    admitted: u32,
    dropped: u32,
    /// The last COMPLETE window's counts, and when it ended.
    last: (u32, u32),
    last_end: Option<Instant>,
    /// Dropped since the last report.
    unreported: u64,
    last_report: Option<Instant>,
}

impl RateLimiter {
    pub fn new(per_sec: u32) -> Self {
        Self {
            per_sec,
            window_start: None,
            admitted: 0,
            dropped: 0,
            last: (0, 0),
            last_end: None,
            unreported: 0,
            last_report: None,
        }
    }

    fn roll(&mut self, now: Instant) {
        const W: Duration = Duration::from_secs(1);
        match self.window_start {
            None => self.window_start = Some(now),
            Some(start) if now.duration_since(start) >= W => {
                let end = start + W;
                // A gap of more than one window means the window just before `now` was empty.
                self.last = if now.duration_since(end) >= W {
                    (0, 0)
                } else {
                    (self.admitted, self.dropped)
                };
                self.last_end = Some(end);
                self.admitted = 0;
                self.dropped = 0;
                // Re-anchor on whole windows so the rhythm does not drift with arrivals.
                let whole = now.duration_since(start).as_secs();
                self.window_start = Some(start + Duration::from_secs(whole));
            }
            Some(_) => {}
        }
    }

    /// May one more line through at `now`?
    pub fn admit(&mut self, now: Instant) -> bool {
        self.roll(now);
        if self.admitted < self.per_sec {
            self.admitted += 1;
            true
        } else {
            self.dropped += 1;
            self.unreported += 1;
            false
        }
    }

    /// `(admitted, dropped)` in the last complete window; `(0, 0)` when that window is stale
    /// (nothing arrived for over a second).
    pub fn rates(&mut self, now: Instant) -> (u32, u32) {
        self.roll(now);
        match self.last_end {
            Some(end) if now.duration_since(end) < Duration::from_secs(1) => self.last,
            _ => (0, 0),
        }
    }

    /// The drop count to report now, if any — at most once per
    /// [`MACHINE_DROP_REPORT_EVERY`]. Resets the count it returns.
    pub fn take_drop_report(&mut self, now: Instant) -> Option<u64> {
        if self.unreported == 0 {
            return None;
        }
        if self
            .last_report
            .is_some_and(|t| now.duration_since(t) < MACHINE_DROP_REPORT_EVERY)
        {
            return None;
        }
        self.last_report = Some(now);
        Some(std::mem::take(&mut self.unreported))
    }
}

/// `"<title> · <cwd basename>"` — how a terminal or root agent is labelled in the view
/// (e.g. `"claude · gazelle"`). The title alone when the cwd has no name.
pub fn source_label(title: &str, cwd: &str) -> String {
    let base = std::path::Path::new(cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if base.is_empty() {
        title.to_string()
    } else {
        format!("{title} · {base}")
    }
}

/// Cap `s` at `max` bytes on a char boundary, marking the cut with `…`.
pub fn cap_text(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/// `logstream_snapshot` → the whole ring, oldest first.
#[tauri::command]
pub fn logstream_snapshot(hub: tauri::State<'_, LogHub>) -> Vec<LogLine> {
    hub.snapshot()
}

/// `logstream_clear` → empties the ring; ids keep increasing.
#[tauri::command]
pub fn logstream_clear(hub: tauri::State<'_, LogHub>) {
    hub.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_label_joins_title_and_cwd_basename() {
        assert_eq!(source_label("claude", "/work/gazelle"), "claude · gazelle");
        assert_eq!(source_label("zsh", "/work/gazelle/"), "zsh · gazelle");
        assert_eq!(source_label("zsh", "/"), "zsh");
        assert_eq!(source_label("zsh", ""), "zsh");
    }

    #[test]
    fn cap_text_cuts_on_a_char_boundary() {
        assert_eq!(cap_text("abc", 3), "abc");
        assert_eq!(cap_text("abcd", 3), "abc…");
        assert_eq!(cap_text("aé", 2), "a…");
    }

    #[test]
    fn machine_is_its_own_kind_on_the_wire() {
        assert_eq!(
            serde_json::to_value(LogKind::Machine).unwrap(),
            serde_json::json!("machine")
        );
    }

    #[test]
    fn app_is_its_own_kind_on_the_wire() {
        assert_eq!(
            serde_json::to_value(LogKind::App).unwrap(),
            serde_json::json!("app")
        );
    }

    #[test]
    fn task_is_its_own_kind_on_the_wire() {
        assert_eq!(
            serde_json::to_value(LogKind::Task).unwrap(),
            serde_json::json!("task")
        );
    }

    /// The documented limits restated as literals, never read off the constants.
    #[test]
    fn the_machine_cap_is_500_a_second_reported_once_a_second() {
        assert_eq!(MACHINE_LINES_PER_SEC, 500);
        assert_eq!(MACHINE_DROP_REPORT_EVERY, Duration::from_secs(1));
    }

    #[test]
    fn the_limiter_admits_per_sec_then_drops_until_the_next_window() {
        let t0 = Instant::now();
        let mut r = RateLimiter::new(3);
        let got: Vec<bool> = (0..5).map(|_| r.admit(t0)).collect();
        assert_eq!(got, [true, true, true, false, false]);
        // Still the same window at 999 ms.
        assert!(!r.admit(t0 + Duration::from_millis(999)));
        // A new window at 1 s.
        assert!(r.admit(t0 + Duration::from_millis(1000)));
        assert_eq!(r.rates(t0 + Duration::from_millis(1000)), (3, 3));
    }

    #[test]
    fn the_limiter_rates_go_stale_after_a_silent_second() {
        let t0 = Instant::now();
        let mut r = RateLimiter::new(2);
        for _ in 0..4 {
            r.admit(t0);
        }
        assert_eq!(
            r.rates(t0 + Duration::from_millis(500)),
            (0, 0),
            "window not complete yet"
        );
        assert_eq!(r.rates(t0 + Duration::from_millis(1500)), (2, 2));
        assert_eq!(r.rates(t0 + Duration::from_millis(2500)), (0, 0), "stale");
        // A burst after a long gap: the previous window was empty.
        r.admit(t0 + Duration::from_millis(9_000));
        assert_eq!(r.rates(t0 + Duration::from_millis(10_100)), (1, 0));
    }

    #[test]
    fn the_drop_report_is_at_most_once_a_second_and_resets() {
        let t0 = Instant::now();
        let mut r = RateLimiter::new(1);
        assert_eq!(r.take_drop_report(t0), None, "nothing dropped");
        r.admit(t0);
        r.admit(t0);
        r.admit(t0);
        assert_eq!(r.take_drop_report(t0), Some(2));
        r.admit(t0 + Duration::from_millis(100));
        r.admit(t0 + Duration::from_millis(100));
        assert_eq!(
            r.take_drop_report(t0 + Duration::from_millis(200)),
            None,
            "too soon"
        );
        assert_eq!(
            r.take_drop_report(t0 + Duration::from_millis(1000)),
            Some(2)
        );
        assert_eq!(r.take_drop_report(t0 + Duration::from_millis(3000)), None);
    }

    #[test]
    fn the_wire_shape_is_camel_case_with_kebab_kinds() {
        let line = LogLine {
            id: 7,
            ts_ms: 1,
            terminal_id: Some("t".into()),
            agent_id: None,
            source: "zsh · w".into(),
            kind: LogKind::ToolResult,
            level: LogLevel::Warn,
            text: "x".into(),
            detail: None,
            tool_use_id: Some("toolu_01".into()),
        };
        let v = serde_json::to_value(&line).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "id": 7, "tsMs": 1, "terminalId": "t", "agentId": null,
                "source": "zsh · w", "kind": "tool-result", "level": "warn",
                "text": "x", "detail": null, "toolUseId": "toolu_01"
            })
        );
        // A line serialised before `toolUseId` existed still reads (serde default).
        let old = serde_json::json!({
            "id": 8, "tsMs": 1, "terminalId": null, "agentId": null,
            "source": "s", "kind": "output", "level": "info", "text": "y", "detail": null
        });
        let back: LogLine = serde_json::from_value(old).unwrap();
        assert_eq!(back.tool_use_id, None);
    }
}
