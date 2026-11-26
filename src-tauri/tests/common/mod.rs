//! Shared integration-test helpers. No mocking the OS: real PTYs and shells; only the webview
//! is stubbed ([`ChannelSink`] records). Poll with [`wait_until`], never a fixed `sleep`.

// Each `tests/*.rs` is its own crate and uses a different subset of this module;
// the unused remainder is not dead code, it is another binary's helper.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::agent::adapter::{
    AgentAdapter, AgentSpawn, SessionKey, SpawnRequest,
};
use agent_studio_scaffold_lib::events::EventSink;
use agent_studio_scaffold_lib::model::AgentEvent;
use agent_studio_scaffold_lib::pty::SpawnSpec;
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor, SupervisorHandle};
use tauri::ipc::{Channel, InvokeResponseBody};

/// Generous on purpose: these tests spawn real shells, and a cold CI runner is
/// slow. Correct tests do not get faster by being given less time — they only get
/// flakier. Nothing waits the full budget on success.
pub const TIMEOUT: Duration = Duration::from_secs(20);

/// How often [`wait_until`] re-checks.
const POLL: Duration = Duration::from_millis(10);

/// Stands in for the webview end of the hot plane: a real `Channel` that records
/// every batch the coalescer sends, in order.
#[derive(Clone, Default)]
pub struct ChannelSink {
    batches: Arc<Mutex<Vec<InvokeResponseBody>>>,
}

impl ChannelSink {
    /// A sink and the `Channel` that feeds it. Hand the `Channel` to the code
    /// under test; keep the sink to assert on.
    pub fn new() -> (Self, Channel<InvokeResponseBody>) {
        let sink = Self::default();
        let recorder = sink.clone();
        let channel = Channel::new(move |body| {
            recorder.batches.lock().unwrap().push(body);
            Ok(())
        });
        (sink, channel)
    }

    /// A `Channel` that fails every send, i.e. the webview hung up.
    pub fn broken() -> Channel<InvokeResponseBody> {
        Channel::new(|_| Err(tauri::Error::Io(std::io::Error::other("webview is gone"))))
    }

    /// One `Vec<u8>` per flush, in send order. Panics if the hot plane ever sent JSON: terminal
    /// bytes must cross as `Raw` (ARCHITECTURE §1).
    pub fn batches(&self) -> Vec<Vec<u8>> {
        self.batches
            .lock()
            .unwrap()
            .iter()
            .map(|body| match body {
                InvokeResponseBody::Raw(bytes) => bytes.clone(),
                InvokeResponseBody::Json(json) => {
                    panic!("hot plane sent JSON, must always be Raw: {json}")
                }
            })
            .collect()
    }

    /// Number of flushes so far.
    pub fn batch_count(&self) -> usize {
        self.batches.lock().unwrap().len()
    }

    /// Every byte received so far, batch boundaries removed — this is what
    /// `xterm.write` would have seen.
    pub fn bytes(&self) -> Vec<u8> {
        self.batches().concat()
    }

    /// [`ChannelSink::bytes`] as lossy text, for `contains` assertions.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes()).into_owned()
    }
}

// ── Agent test doubles ──
// A stub `AgentAdapter`, never a real `claude` (auth, network, flakiness): tests the lifecycle.

/// Records every `AgentEvent` the supervisor emits, standing in for the webview's
/// `agent://event` listener.
#[derive(Clone, Default)]
pub struct RecordingSink {
    events: Arc<Mutex<Vec<AgentEvent>>>,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every event emitted so far, in order.
    pub fn events(&self) -> Vec<AgentEvent> {
        self.events.lock().unwrap().clone()
    }

    /// The `t` tag of each event, in order — handy for asserting sequence.
    pub fn tags(&self) -> Vec<String> {
        self.events()
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["t"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &AgentEvent) {
        self.events.lock().unwrap().push(event.clone());
    }
}

/// An `AgentAdapter` running a plain shell; it still mints a session identity and imposes it
/// as an env var the child echoes back, proving the binding is real.
pub struct StubAdapter {
    /// What the "agent" runs: `(program, args)`. Default: sit and read, like a REPL.
    argv: (String, Vec<String>),
    minted: Arc<Mutex<Vec<String>>>,
}

impl StubAdapter {
    /// Stays alive reading its tty like a REPL. Windows: interactive `cmd /Q`, since `cmd /C`
    /// has no `while read` and would exit at once.
    pub fn interactive() -> Self {
        #[cfg(windows)]
        let argv = ("cmd.exe".to_string(), vec!["/Q".to_string()]);
        #[cfg(not(windows))]
        let argv = sh("while read -r _; do :; done");
        Self {
            argv,
            minted: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// An agent whose process runs `script` and then exits.
    pub fn running(script: &str) -> Self {
        Self {
            argv: sh(script),
            minted: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Every session key this adapter minted, in spawn order.
    pub fn minted_keys(&self) -> Vec<String> {
        self.minted.lock().unwrap().clone()
    }
}

impl AgentAdapter for StubAdapter {
    fn id(&self) -> &'static str {
        "stub-runtime"
    }

    fn default_title(&self) -> &'static str {
        "stub"
    }

    fn spawn(&self, req: &SpawnRequest<'_>) -> anyhow::Result<AgentSpawn> {
        // Mimic the real adapter: dictate an identity rather than infer one.
        let key = SessionKey(format!("stub-session-{}", ulid::Ulid::new()));
        self.minted.lock().unwrap().push(key.0.clone());

        let (program, args) = self.argv.clone();
        Ok(AgentSpawn {
            spec: SpawnSpec {
                program,
                args,
                cwd: req.cwd.to_path_buf(),
                env: vec![("STUB_SESSION_ID".into(), key.0.clone())],
                rows: req.rows,
                cols: req.cols,
            },
            session_key: key,
        })
    }

    // The stub parses the SAME payload shape as the real adapter (see
    // `hook_payload`), so the whole binding pipeline can be driven without a real
    // `claude`. The real schema is unit-tested separately in `agent/claude.rs`.
    fn parse_session_event(
        &self,
        body: &[u8],
    ) -> Option<agent_studio_scaffold_lib::agent::hook::SessionEvent> {
        use agent_studio_scaffold_lib::agent::hook::{SessionEvent, SessionEventKind};
        let v: serde_json::Value = serde_json::from_slice(body).ok()?;
        let kind = match v.get("hook_event_name")?.as_str()? {
            "SessionStart" => SessionEventKind::Start,
            "SessionEnd" => SessionEventKind::End,
            _ => return None,
        };
        Some(SessionEvent {
            kind,
            session_id: v.get("session_id")?.as_str()?.to_string(),
            transcript_path: v
                .get("transcript_path")
                .and_then(|t| t.as_str())
                .map(str::to_string),
            // Parse `cwd` exactly like the real adapter, so the payload-cwd path
            // can be driven through the stub.
            cwd: v
                .get("cwd")
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        })
    }

    fn ad_hoc_hook_settings(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "echo stub # stub-hook-marker"}]}],
            }
        }))
    }

    fn hook_marker(&self) -> Option<&'static str> {
        Some("stub-hook-marker")
    }

    // Tail via the REAL Claude fan-out logic (both functions are pure/public), so
    // the tailer loop can be exercised end to end without a real `claude`: the stub
    // spawns a shell but reconstructs the tree exactly as the Claude adapter does.
    fn locate_transcript(
        &self,
        session_id: &str,
    ) -> Option<agent_studio_scaffold_lib::agent::fanout::TranscriptLocation> {
        agent_studio_scaffold_lib::agent::claude::locate_transcript(session_id)
    }

    fn parse_fanout(
        &self,
        loc: &agent_studio_scaffold_lib::agent::fanout::TranscriptLocation,
        root_id: &agent_studio_scaffold_lib::model::AgentId,
    ) -> agent_studio_scaffold_lib::agent::fanout::FanoutResult {
        agent_studio_scaffold_lib::agent::claude::parse_fanout(
            &loc.root_transcript,
            &loc.subagents_dir,
            root_id,
        )
    }
}

/// Build a `claude`-shaped `SessionStart`/`SessionEnd` payload for driving the
/// binding pipeline in tests — the JSON the hook would POST.
pub fn hook_payload(event: &str, session_id: &str, transcript_path: Option<&str>) -> Vec<u8> {
    let mut obj = serde_json::json!({
        "hook_event_name": event,
        "session_id": session_id,
    });
    if let Some(tp) = transcript_path {
        obj["transcript_path"] = serde_json::json!(tp);
    }
    serde_json::to_vec(&obj).unwrap()
}

/// Like [`hook_payload`], but also carries the session's `cwd` — the field that
/// lets an ad-hoc root anchor to where `claude` is actually running rather than to
/// the terminal's spawn cwd.
pub fn hook_payload_cwd(
    event: &str,
    session_id: &str,
    cwd: &str,
    transcript_path: Option<&str>,
) -> Vec<u8> {
    let mut obj = serde_json::json!({
        "hook_event_name": event,
        "session_id": session_id,
        "cwd": cwd,
    });
    if let Some(tp) = transcript_path {
        obj["transcript_path"] = serde_json::json!(tp);
    }
    serde_json::to_vec(&obj).unwrap()
}

/// Production-faithful fan-out adapter: `id() == "claude-code"` (the real selection path),
/// records minted keys so tests place the transcript AFTER spawn, tails with the real parser.
/// Runs a plain shell; reproduces spawn → tailer → transcript appearing later.
pub struct ClaudeishAdapter {
    minted: Arc<Mutex<Vec<String>>>,
}

impl ClaudeishAdapter {
    pub fn new() -> Self {
        Self {
            minted: Arc::new(Mutex::new(Vec::new())),
        }
    }
    pub fn minted_keys(&self) -> Vec<String> {
        self.minted.lock().unwrap().clone()
    }
}

impl Default for ClaudeishAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentAdapter for ClaudeishAdapter {
    fn id(&self) -> &'static str {
        // The production runtime id — this is what makes the selection path faithful.
        "claude-code"
    }
    fn default_title(&self) -> &'static str {
        "claude"
    }
    fn spawn(&self, req: &SpawnRequest<'_>) -> anyhow::Result<AgentSpawn> {
        // A valid UUID so it looks like a real session id, recorded so the test can
        // place the transcript for it after spawn.
        let key = SessionKey(format!(
            "cafe0000-0000-4000-8000-{:012x}",
            ulid::Ulid::new().0 & 0xffffffffffff
        ));
        self.minted.lock().unwrap().push(key.0.clone());
        let (program, args) = interactive_sh();
        Ok(AgentSpawn {
            spec: SpawnSpec {
                program,
                args,
                cwd: req.cwd.to_path_buf(),
                env: vec![],
                rows: req.rows,
                cols: req.cols,
            },
            session_key: key,
        })
    }
    fn locate_transcript(
        &self,
        session_id: &str,
    ) -> Option<agent_studio_scaffold_lib::agent::fanout::TranscriptLocation> {
        agent_studio_scaffold_lib::agent::claude::locate_transcript(session_id)
    }
    fn parse_fanout(
        &self,
        loc: &agent_studio_scaffold_lib::agent::fanout::TranscriptLocation,
        root_id: &agent_studio_scaffold_lib::model::AgentId,
    ) -> agent_studio_scaffold_lib::agent::fanout::FanoutResult {
        agent_studio_scaffold_lib::agent::claude::parse_fanout(
            &loc.root_transcript,
            &loc.subagents_dir,
            root_id,
        )
    }
}

/// An adapter whose `spawn` always fails — models "the runtime isn't installed",
/// a normal condition users hit.
pub struct FailingAdapter;

impl AgentAdapter for FailingAdapter {
    fn id(&self) -> &'static str {
        "broken-runtime"
    }
    fn default_title(&self) -> &'static str {
        "broken"
    }
    fn spawn(&self, _req: &SpawnRequest<'_>) -> anyhow::Result<AgentSpawn> {
        anyhow::bail!("could not find the `broken` executable")
    }
}

/// A supervisor wired to `adapter`, plus the sink recording its telemetry.
pub fn supervisor_with(adapter: Arc<dyn AgentAdapter>) -> (SupervisorHandle, RecordingSink) {
    let sink = RecordingSink::new();
    let sup = spawn_supervisor(Arc::new(sink.clone()), vec![adapter], None);
    (sup, sink)
}

/// A supervisor with the ad-hoc hook pipeline on; `hook` points at a URL nothing listens on,
/// since tests drive bindings via `deliver_hook`.
pub fn supervisor_with_hook(
    adapter: Arc<dyn AgentAdapter>,
    hook: agent_studio_scaffold_lib::hook_listener::HookConfig,
) -> (SupervisorHandle, RecordingSink) {
    let sink = RecordingSink::new();
    let sup = spawn_supervisor(Arc::new(sink.clone()), vec![adapter], Some(hook));
    (sup, sink)
}

/// A throwaway hook config for tests (a port nothing listens on).
pub fn test_hook_config() -> agent_studio_scaffold_lib::hook_listener::HookConfig {
    agent_studio_scaffold_lib::hook_listener::HookConfig {
        base_url: "http://127.0.0.1:1".to_string(),
        token: format!("test-token-{}", ulid::Ulid::new()),
    }
}

/// Poll `cond` until it holds, or panic at [`TIMEOUT`] with `what` in the message.
pub async fn wait_until(mut cond: impl FnMut() -> bool, what: &str) {
    let start = Instant::now();
    loop {
        if cond() {
            return;
        }
        if start.elapsed() >= TIMEOUT {
            panic!("timed out after {TIMEOUT:?} waiting for {what}");
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Wait until the terminal's output contains `needle`; panic with everything that
/// *did* arrive, which is the only thing that makes a PTY failure debuggable.
pub async fn wait_for_output(sink: &ChannelSink, needle: &str) {
    let start = Instant::now();
    loop {
        if sink.text().contains(needle) {
            return;
        }
        if start.elapsed() >= TIMEOUT {
            panic!(
                "timed out after {TIMEOUT:?} waiting for {needle:?} in PTY output.\n\
                 --- got {} bytes in {} batches ---\n{}\n--- end ---",
                sink.bytes().len(),
                sink.batch_count(),
                sink.text()
            );
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Wait until no bytes arrive for `quiet_for`; panics at [`TIMEOUT`]. Unlike `sleep` +
/// compare, it can't pass on a machine too slow to have produced anything yet.
pub async fn wait_for_quiet(sink: &ChannelSink, quiet_for: Duration) {
    let start = Instant::now();
    let mut last_len = sink.bytes().len();
    let mut last_change = Instant::now();
    loop {
        tokio::time::sleep(POLL).await;
        let len = sink.bytes().len();
        if len != last_len {
            last_len = len;
            last_change = Instant::now();
        } else if last_change.elapsed() >= quiet_for {
            return;
        }
        if start.elapsed() >= TIMEOUT {
            panic!(
                "PTY stream never went quiet for {quiet_for:?} within {TIMEOUT:?} \
                 — the child is still writing ({len} bytes so far)"
            );
        }
    }
}

/// `(program, args)` running `script` via the platform shell; Windows uses `cmd.exe`, which
/// starts in milliseconds where PowerShell takes seconds.
pub fn sh(script: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), script.to_string()],
        )
    }
    #[cfg(not(windows))]
    {
        (
            "/bin/sh".to_string(),
            vec!["-c".to_string(), script.to_string()],
        )
    }
}

/// `first`, then `second`, in [`sh`]'s shell: `a; b` for `/bin/sh`, `a & b` for `cmd.exe`.
/// cmd has no `;` separator — `cmd /C "echo bye; exit 5"` prints `bye; exit 5` and exits 0,
/// which makes tests that only look at the echo pass by accident on Windows.
pub fn then(first: &str, second: &str) -> String {
    if cfg!(windows) {
        format!("{first} & {second}")
    } else {
        format!("{first}; {second}")
    }
}

/// Sleep `secs` seconds in [`sh`]'s shell. cmd has no `sleep`, and `timeout` refuses to
/// run without a console input it can read; `ping -n` waits about a second per echo.
pub fn sleep_secs(secs: u32) -> String {
    if cfg!(windows) {
        format!("ping -n {} 127.0.0.1 > NUL", secs + 1)
    } else {
        format!("sleep {secs}")
    }
}

/// How [`sh`]'s shell expands the environment variable `name`: `$NAME` for `/bin/sh`,
/// `%NAME%` for `cmd.exe` (which prints a `$NAME` verbatim).
pub fn env_ref(name: &str) -> String {
    if cfg!(windows) {
        format!("%{name}%")
    } else {
        format!("${name}")
    }
}

/// `(program, args)` for an interactive shell that stays up reading its tty.
pub fn interactive_sh() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("cmd.exe".to_string(), Vec::new())
    }
    #[cfg(not(windows))]
    {
        ("/bin/sh".to_string(), Vec::new())
    }
}

/// A directory that certainly exists, as a PTY cwd.
pub fn temp_cwd() -> String {
    let dir = std::env::temp_dir();
    // Windows: a cwd enters the supervisor as its canonical spelling (`workspace::resolve_cwd`)
    // — `temp_dir()` ends in `\`, the canonical form does not. Hand tests the form the
    // app records. macOS/Linux keep the path as chosen, so theirs is unchanged.
    if cfg!(windows) {
        if let Ok(c) = agent_studio_scaffold_lib::paths::canonicalize(&dir) {
            return c.to_string_lossy().into_owned();
        }
    }
    dir.to_string_lossy().into_owned()
}

/// The platform's line terminator for input typed at a tty.
pub const EOL: &str = if cfg!(windows) { "\r\n" } else { "\n" };

/// Lines to type at a shell, and a needle only the child's evaluation produces (`6*7` →
/// `rt-42-ok`): the tty echoes input, so a literal we sent would prove nothing.
pub fn round_trip_probe() -> (Vec<String>, &'static str) {
    #[cfg(windows)]
    {
        (
            vec![
                format!("set /a RT=6*7{EOL}"),
                format!("echo rt-%RT%-ok{EOL}"),
            ],
            "rt-42-ok",
        )
    }
    #[cfg(not(windows))]
    {
        (vec![format!("echo rt-$((6*7))-ok{EOL}")], "rt-42-ok")
    }
}

/// Open file descriptors for this process. Unix only — used to prove terminal
/// teardown does not leak the master/reader fds.
#[cfg(unix)]
pub fn open_fd_count() -> usize {
    // Linux: /proc/self/fd. macOS: /dev/fd. Both list one entry per open fd.
    let dir = if std::path::Path::new("/proc/self/fd").exists() {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    };
    std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
}
