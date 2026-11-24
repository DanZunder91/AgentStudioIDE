//! **Agents running OUTSIDE the IDE** — the Agent Village's view of every `claude` on
//! this machine that the IDE did not start (a `claude` in iTerm, in VS Code's terminal,
//! in a tmux pane). The IDE's own agents come from the supervisor's forest; this
//! module finds the rest.
//!
//! ## How (passive, read-only)
//!
//! There is no hook to listen to: an external `claude` never has the IDE's env, so
//! the IDE's ad-hoc hook detection is inert for it, and global hooks (a write under
//! `~/.claude`) are ruled out. So
//! the only sources are the ones `claude` already writes for itself:
//!
//! 1. **Transcripts.** Walk `~/.claude/projects/*/<session>.jsonl` (plus the
//!    `<session>/subagents/**/agent-*.jsonl` sidecars) and keep the sessions whose
//!    newest file was touched inside the window (default [`DEFAULT_WINDOW_MINS`]).
//!    The mtime gate comes first — the `metrics::scan_root` discipline — so the cost is
//!    one `stat` per file outside the window. Inside it, only a **bounded tail** is read
//!    ([`TAIL_BOUND`]; transcripts reach 40 MB and are append-only, so the tail is
//!    where "now" is). Nothing is ever written, cached or created under `~/.claude`.
//! 2. **Processes.** The `claude` processes of this user, by
//!    `procscan::os::list` + `procscan::ide::is_claude_cli` — libproc / `/proc` / Toolhelp
//!    and the process's own command line on Windows, no permission prompt. Liveness is
//!    **per session** ([`assign_claims`]):
//!    a process started with `--session-id <id>` / `--resume <id>` / `-r <id>` claims
//!    exactly that session; every other ("bare") `claude` claims the newest unclaimed
//!    session in its cwd's project dir written no earlier than the process started
//!    (minus [`CLAIM_SLACK_MS`]). A session no live process claims is **not reported at
//!    all**, however fresh its mtime (a `claude` killed by a restart leaves a transcript
//!    that looks busy for the whole window). Where the
//!    process table is not available (`procscan::os::AVAILABLE` false) nothing is hidden
//!    and `alive` is `null`. On Windows the project dir is matched ignoring case and the
//!    cwd without its `\\?\` prefix ([`canonical`], [`same_project_dir`]).
//! 3. **The host app.** macOS: the claiming process's parent chain is walked to the
//!    first ancestor inside an app bundle (`…/iTerm.app/Contents/MacOS/…`), or iTerm2's
//!    `iTermServer` (its shells hang off that helper, not the app): its display name goes
//!    on the wire as `host`, the bundle stays in Rust ([`HostCache`]) so
//!    [`focus_external_agent`] can bring that app to the front with `open` — no
//!    AppleScript, no Automation / Accessibility prompt. Windows
//!    ([`winhost`]): the chain is walked to the first known GUI host (Windows Terminal,
//!    VS Code, Cursor, JetBrains…) or else the first ancestor owning a visible top-level
//!    window; the host's pid and image path stay in Rust and the focus restores and
//!    raises its main window with `SetForegroundWindow` — allowed because the IDE is the
//!    foreground app at click time; no privilege, no UI Automation.
//!
//! ## What a transcript tail says (the status machine, from pixel-agents' notes)
//!
//! | last thing in the tail | activity |
//! |---|---|
//! | `assistant` with a `tool_use` not yet answered by a `tool_result` | `running`, tool = its name |
//! | …and silent ≥ [`PERMISSION_SILENCE_MS`] after a tool that is neither read-only nor a sub-agent launch | `waiting` (probably a permission prompt — a heuristic: a long `Bash` looks the same) |
//! | a pending `AskUserQuestion` / `ExitPlanMode` | `waiting` (it IS asking the user) |
//! | a user prompt, a `tool_result`, a thinking block | `running`, no tool (thinking) |
//! | assistant text with `stop_reason: end_turn`, `system` `turn_duration` / `stop_hook_summary`, an interrupt | `idle` |
//! | assistant text with no stop reason, silent ≥ [`TEXT_IDLE_MS`] | `idle` |
//! | an API error message (`isApiErrorMessage`, `system` `api_error`) | `error` |
//!
//! A sub-agent is `done` when a FOREGROUND launch's `tool_result` came back in the
//! parent (a background launch answers at once, so that result means nothing there),
//! when its parent's queue holds its `<task-notification>` (`completed`/`killed` →
//! done, `failed` → error) and it has not written past it (a resumed agent notifies
//! again), when its sidecar says `"finished": true`, when its transcript says the turn
//! ended, or when it has been silent for [`SUBAGENT_STALE_MS`] — the CLI does not
//! always write a final line. The notification and `finished` rules are the IDE
//! fan-out's own ([`crate::agent::claude`]'s `background_end`), so both views agree.
//!
//! ## Privacy (the metrics.rs rules)
//!
//! This is an every-repo, machine-wide view — the metrics "All" scope — so it carries
//! **no prompt text, no tool arguments, no tool results, no absolute paths**:
//! - the title is the transcript's `slug` (a random three-word handle the CLI mints),
//!   else the git branch, else `"claude"`; a sub-agent's is its `.meta.json`
//!   `agentType` — never its `description`, which is prompt text;
//! - the folder is the cwd's basename (one folder = one house);
//! - the tool is the bare tool NAME;
//! - the `key` is an opaque per-process SipHash of the id ([`opaque_key`]): Claude's
//!   session id never crosses the wire, and a key is meaningless after a restart;
//! - the `language` is a language id (`"rust"`) voted by the extensions of the files the
//!   session's tool calls named ([`language`]) — the paths themselves stay in Rust.
//!
//! The IDE's own sessions are excluded by id, in-process: the command asks the
//! supervisor ([`SupervisorHandle::owned_session_ids`]) and the ids stay in Rust.

use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::State;

use crate::agent::fanout::TranscriptLocation;
use crate::agent::tools::ToolBlock;
use crate::spawn::NoWindow as _;
use crate::supervisor::SupervisorHandle;

pub mod language;
pub mod winhost;
pub use language::LanguageCache;

/// The window when the UI does not pass one: sessions touched in the last 10 minutes.
pub const DEFAULT_WINDOW_MINS: u32 = 10;
/// The widest window a caller may ask for (a day). Clamped, never an error.
pub const MAX_WINDOW_MINS: u32 = 24 * 60;
/// Bytes read off the END of a root transcript. 256 KiB holds hundreds of records —
/// far more than the last turn — and bounds a poll over 40 MB transcripts.
pub const TAIL_BOUND: u64 = 256 * 1024;
/// A sub-agent's tail bound: its state is in its last few records.
pub const SUBAGENT_TAIL_BOUND: u64 = 64 * 1024;
/// Silence after a non-exempt `tool_use` that reads as "blocked on a permission
/// prompt" (pixel-agents' 7 s).
pub const PERMISSION_SILENCE_MS: u64 = 7_000;
/// Silence after a text-only reply with no stop reason that reads as "turn over"
/// (pixel-agents' 5 s — `turn_duration` is not written for every turn).
pub const TEXT_IDLE_MS: u64 = 5_000;
/// A sub-agent silent this long with no end marker is taken as finished — one knob for
/// both views, owned by the fan-out.
pub use crate::agent::claude::SUBAGENT_STALE_MS;
/// How much earlier than its process's start a session may have been written and still
/// be claimed by that bare process: the process start (kernel) and the mtime (file
/// system) are separate clocks, and `--continue`-like flows touch the file at once.
pub const CLAIM_SLACK_MS: u64 = 5_000;
/// A session whose root transcript is older than this is not even opened for its
/// sub-agents: it bounds the `stat`s spent on a project's thousands of old sidecars.
const SESSION_HORIZON_MS: u64 = 24 * 3_600_000;

/// What an external agent is doing, as the wire spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalActivity {
    Running,
    Waiting,
    Idle,
    Done,
    Error,
}

/// One agent outside the IDE — `ExternalAgentWire` in `src/features/village/villageTypes.ts`.
/// Field order = the TS interface's, so the contract golden reads like it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentWire {
    /// Opaque, stable for this process ([`opaque_key`]).
    pub key: String,
    /// The parent's `key` for a sub-agent, else `None`.
    pub parent_key: Option<String>,
    /// Slug / branch / `"claude"`; a sub-agent's `agentType`. Never prompt text.
    pub title: String,
    /// Basename of the session's cwd.
    pub folder: String,
    pub activity: ExternalActivity,
    /// The current/last tool NAME, never its arguments.
    pub tool: Option<String>,
    /// Epoch ms of the newest write to the agent's transcript(s).
    pub last_activity_ms: u64,
    /// A live `claude` process claims this session ([`assign_claims`]); `None` = cannot
    /// tell on this OS. Never `Some(false)` in a report: unclaimed sessions are dropped.
    pub alive: Option<bool>,
    /// Display name of the GUI app the session's `claude` runs in (`"iTerm2"`,
    /// `"Terminal"`, `"Visual Studio Code"`), or `None` when unknown. A name, never a
    /// path — the bundle stays in Rust ([`HostCache`]). Sub-agents carry their session's.
    pub host: Option<String>,
    /// The session's language id (`"rust"`, `"typescript"`…) — its tool calls' files, voted by
    /// extension ([`language`]) — or `None` when no file it touched says. Sub-agents carry their
    /// session's. An id, never a path (the City's neon sign).
    pub language: Option<String>,
}

/// The `list_external_agents` result — `ExternalAgentsReport` in `villageTypes.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentsReport {
    pub agents: Vec<ExternalAgentWire>,
    pub scanned_at_ms: u64,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every Claude Code agent active on this machine OUTSIDE the IDE, in the last
/// `activeWithinMins` (default [`DEFAULT_WINDOW_MINS`], clamped to 1..=[`MAX_WINDOW_MINS`]).
///
/// Frontend contract: `invoke<ExternalAgentsReport>('list_external_agents',
/// { activeWithinMins })`. The scan runs on `spawn_blocking`.
#[tauri::command]
pub async fn list_external_agents(
    supervisor: State<'_, SupervisorHandle>,
    active_within_mins: Option<u32>,
) -> Result<ExternalAgentsReport, String> {
    let exclude = supervisor.owned_session_ids().await?;
    external_agents_report(exclude, active_within_mins).await
}

/// Bring the GUI app an external agent runs in to the front (the village's click on an
/// outside character). `key` is a `key` from the LAST `list_external_agents` reply; the
/// app's bundle was cached Rust-side by that scan ([`HostCache`]) — no path ever came
/// from the frontend, so this cannot be pointed at an arbitrary app.
///
/// Frontend contract: `invoke<void>('focus_external_agent', { key })`. Errors are coded:
/// `no-host` (unknown key, no app found for it, or — Windows — the app has
/// exited or shows no window), `unsupported` (neither macOS nor Windows), `open-failed`.
/// macOS: `open` on the cached bundle. Windows: the cached host pid's main window is
/// restored and brought to the front ([`winhost::focus_window`]).
#[tauri::command]
pub async fn focus_external_agent(key: String) -> Result<(), String> {
    if !cfg!(any(target_os = "macos", windows)) {
        return Err("unsupported: focusing another app works on macOS and Windows".to_string());
    }
    let host = HostCache::global()
        .get(&key)
        .ok_or_else(|| "no-host: no app is known for that agent".to_string())?;
    tokio::task::spawn_blocking(move || focus_host(&host, run_open))
        .await
        .map_err(|_| "unknown: the focus did not finish".to_string())?
}

/// The `open` arguments that activate `host`: `-a <bundle>` or `-b <bundle id>`.
/// LaunchServices only — no AppleScript, no Automation prompt. A Windows
/// host is not opened but focused ([`focus_host_with`]): no arguments.
pub fn open_args(host: &HostApp) -> Vec<std::ffi::OsString> {
    match &host.target {
        HostTarget::Bundle(path) => vec!["-a".into(), path.clone().into_os_string()],
        HostTarget::BundleId(id) => vec!["-b".into(), id.into()],
        HostTarget::Window { .. } => Vec::new(),
    }
}

/// Activate `host` through `run` (the `open` seam — [`run_open`] in the app, a recorder
/// in tests); a Windows host through [`winhost::focus_window`].
pub fn focus_host(
    host: &HostApp,
    run: impl FnOnce(&[std::ffi::OsString]) -> Result<(), String>,
) -> Result<(), String> {
    focus_host_with(host, run, winhost::focus_window)
}

/// [`focus_host`] with the window seam injected too: a macOS bundle goes to `run` (as
/// `open` arguments), a Windows host window to `window(pid, exe)`. Never both.
pub fn focus_host_with(
    host: &HostApp,
    run: impl FnOnce(&[std::ffi::OsString]) -> Result<(), String>,
    window: impl FnOnce(u32, Option<&Path>) -> Result<(), String>,
) -> Result<(), String> {
    match &host.target {
        HostTarget::Window { pid, exe } => window(*pid, exe.as_deref()),
        HostTarget::Bundle(_) | HostTarget::BundleId(_) => run(&open_args(host)),
    }
}

/// `/usr/bin/open <args>`, waited for (it returns as soon as LaunchServices has it).
fn run_open(args: &[std::ffi::OsString]) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .args(args)
        .no_window()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("open-failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open-failed: exit {:?}", status.code()))
    }
}

/// The command minus the Tauri `State`: resolves `home_dir()` itself and runs the real
/// scan + process probe on `spawn_blocking` — the exact path the app takes, drivable
/// from a test (`tests/external_agents_no_home_writes.rs`).
pub async fn external_agents_report(
    exclude: HashSet<String>,
    active_within_mins: Option<u32>,
) -> Result<ExternalAgentsReport, String> {
    external_agents_report_with(exclude, active_within_mins, live_claudes).await
}

/// [`external_agents_report`] with the process probe injected (a test's fake table in
/// place of [`live_claudes`]). Every other step — `home_dir()`, the scan, the host
/// cache refresh — is the production one.
pub async fn external_agents_report_with(
    exclude: HashSet<String>,
    active_within_mins: Option<u32>,
    probe: impl FnOnce() -> Option<Vec<LiveClaude>> + Send + 'static,
) -> Result<ExternalAgentsReport, String> {
    let home = crate::agent::claude::home_dir()
        .ok_or_else(|| "home-unresolved: no home directory".to_string())?;
    let projects = home.join(".claude").join("projects");
    let window = window_ms(active_within_mins);
    tokio::task::spawn_blocking(move || {
        let now = now_ms();
        let live = probe();
        // The languages' read offsets live across scans (`language` module doc: the cost).
        let mut langs = LanguageCache::global()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let (agents, hosts) = scan_external_cached(
            &projects,
            now,
            window,
            &exclude,
            live.as_deref(),
            &mut langs,
        );
        drop(langs);
        HostCache::global().replace(hosts);
        ExternalAgentsReport {
            agents,
            scanned_at_ms: now,
        }
    })
    .await
    .map_err(|_| "unknown: the external-agents scan did not finish".to_string())
}

/// The window in ms for an optional minutes argument (default, clamped).
pub fn window_ms(active_within_mins: Option<u32>) -> u64 {
    let mins = active_within_mins
        .unwrap_or(DEFAULT_WINDOW_MINS)
        .clamp(1, MAX_WINDOW_MINS);
    u64::from(mins) * 60_000
}

// ---------------------------------------------------------------------------
// Processes: who is alive, and in which app
// ---------------------------------------------------------------------------

/// One live `claude` process, as the scan needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveClaude {
    pub pid: u32,
    /// Its working directory, symlinks resolved.
    pub cwd: PathBuf,
    pub argv: Vec<String>,
    /// Epoch ms the process started, when the OS says.
    pub started_ms: Option<u64>,
    /// The GUI app it runs in ([`host_of`]), when one was found.
    pub host: Option<HostApp>,
}

/// The GUI app a `claude` runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostApp {
    /// Display name — the only part that crosses the wire.
    pub name: String,
    pub target: HostTarget,
}

/// How the focus finds the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostTarget {
    /// The `.app` bundle's path (`open -a`).
    Bundle(PathBuf),
    /// A bundle identifier (`open -b`) — for a host reached through a helper that lives
    /// outside its bundle (iTerm2's `iTermServer`).
    BundleId(String),
    /// Windows: the host process whose main window is brought forward, and its image path
    /// as the scan saw it (checked again before focusing, so a reused pid is never
    /// focused) — [`winhost`].
    Window { pid: u32, exe: Option<PathBuf> },
}

/// This user's live `claude` processes, or `None` where the OS gives no process table
/// (`procscan::os::AVAILABLE` false) — "unknown", not "nobody". Reads the process table
/// only (never `~/.claude`); a process whose cwd cannot be read is skipped. The host app
/// is found per OS: the `.app` walk ([`host_of`]) on macOS/Linux, the window walk
/// ([`winhost::host_of_windows`]) on Windows.
pub fn live_claudes() -> Option<Vec<LiveClaude>> {
    if !crate::procscan::os::AVAILABLE {
        return None;
    }
    let uid = crate::procscan::os::my_uid()?;
    let table = crate::procscan::os::list(uid);
    let cwd_of = |pid| crate::pty::cwd::process_cwd(pid).map(|cwd| canonical(&cwd));
    if cfg!(windows) {
        let windowed = winhost::windowed_now();
        return Some(live_claudes_with(&table, cwd_of, |pid, by_pid| {
            winhost::host_of_windows(pid, by_pid, &windowed)
        }));
    }
    Some(live_claudes_from(
        &table,
        cwd_of,
        crate::procscan::os::parent_and_exe,
    ))
}

/// The `claude` CLI processes in `table`, with their cwd (`cwd_of`) and host app
/// ([`host_of`]; `outside` answers for an ancestor the user's table lacks). A `claude`
/// whose parent is itself a `claude` is one of its helpers, not a session.
pub fn live_claudes_from(
    table: &[crate::procscan::os::RawProc],
    cwd_of: impl Fn(u32) -> Option<PathBuf>,
    outside: impl Fn(u32) -> Option<(u32, Option<String>)>,
) -> Vec<LiveClaude> {
    live_claudes_with(table, cwd_of, |pid, by_pid| host_of(pid, by_pid, &outside))
}

/// [`live_claudes_from`] with the host lookup injected (`host(pid, table by pid)`).
pub fn live_claudes_with(
    table: &[crate::procscan::os::RawProc],
    cwd_of: impl Fn(u32) -> Option<PathBuf>,
    host: impl Fn(u32, &HashMap<u32, &crate::procscan::os::RawProc>) -> Option<HostApp>,
) -> Vec<LiveClaude> {
    let by_pid: HashMap<u32, &crate::procscan::os::RawProc> =
        table.iter().map(|p| (p.pid, p)).collect();
    let is_claude = |p: &crate::procscan::os::RawProc| {
        crate::procscan::ide::is_claude_cli(p.exe.as_deref(), &p.argv)
    };
    table
        .iter()
        .filter(|p| is_claude(p))
        .filter(|p| !by_pid.get(&p.ppid).is_some_and(|parent| is_claude(parent)))
        .filter_map(|p| {
            Some(LiveClaude {
                pid: p.pid,
                cwd: cwd_of(p.pid)?,
                argv: p.argv.clone(),
                started_ms: p.started_ms.map(|m| m.max(0) as u64),
                host: host(p.pid, &by_pid),
            })
        })
        .collect()
}

/// The host app of `pid`: the first process on its parent chain (itself included) whose
/// executable names one ([`host_from_exe`]). A pid missing from `by_pid` (this user's
/// processes) is asked of `outside` — iTerm2 puts a setuid-root `login` between its
/// helper and the shell, and the user's table never lists it. Bounded, and a ppid cycle
/// in a malformed table ends the walk.
pub fn host_of(
    pid: u32,
    by_pid: &HashMap<u32, &crate::procscan::os::RawProc>,
    outside: impl Fn(u32) -> Option<(u32, Option<String>)>,
) -> Option<HostApp> {
    let mut seen = HashSet::new();
    let mut at = pid;
    while seen.insert(at) && seen.len() <= 64 {
        let (ppid, exe) = match by_pid.get(&at) {
            Some(p) => (p.ppid, p.exe.clone().or_else(|| p.argv.first().cloned())),
            None => outside(at)?,
        };
        if let Some(host) = exe.as_deref().and_then(host_from_exe) {
            return Some(host);
        }
        if ppid == 0 || ppid == at {
            return None;
        }
        at = ppid;
    }
    None
}

/// The app an executable path belongs to: the OUTERMOST `X.app` followed by `Contents`
/// (`/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/…` is VS
/// Code, not its helper), or iTerm2 for its `iTermServer-*` helper, which lives in
/// Application Support and is the parent of every iTerm2 shell.
pub fn host_from_exe(exe: &str) -> Option<HostApp> {
    let path = Path::new(exe);
    let parts: Vec<_> = path.components().collect();
    for (i, part) in parts.iter().enumerate() {
        let name = part.as_os_str().to_str()?;
        let Some(stem) = name.strip_suffix(".app") else {
            continue;
        };
        let inside = parts
            .get(i + 1)
            .is_some_and(|c| c.as_os_str() == "Contents");
        if !stem.is_empty() && inside {
            let bundle: PathBuf = parts[..=i].iter().collect();
            return Some(HostApp {
                name: display_name(stem),
                target: HostTarget::Bundle(bundle),
            });
        }
    }
    let file = path.file_name()?.to_str()?;
    file.starts_with("iTermServer").then(|| HostApp {
        name: "iTerm2".to_string(),
        target: HostTarget::BundleId("com.googlecode.iterm2".to_string()),
    })
}

/// A bundle's display name: its stem, except where the product's name differs from its
/// bundle's (`iTerm.app` is iTerm2).
fn display_name(stem: &str) -> String {
    match stem {
        "iTerm" => "iTerm2".to_string(),
        other => other.to_string(),
    }
}

/// What a `claude` process's argv says about the session it writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// `--session-id <id>`, or `--resume <id>` / `-r <id>` without `--fork-session`.
    Id(String),
    /// Any other session in its cwd — the newest unclaimed one written at or after
    /// `since` (minus [`CLAIM_SLACK_MS`]); `since: None` = no age bound (`--continue`,
    /// a bare `--resume` picker: an existing session, of any age).
    Bare { since: Option<u64> },
    /// Not a session at all (`claude mcp serve`, the Chrome native host, `doctor`…).
    Nothing,
}

/// Subcommands that run no agent session.
const NON_SESSION_SUBCOMMANDS: &[&str] = &[
    "mcp",
    "doctor",
    "update",
    "upgrade",
    "install",
    "config",
    "plugin",
    "setup-token",
    "migrate-installer",
];

/// Does `v` look like a session id (a UUID-ish token)? `--resume` also takes a search
/// term, which names no session.
fn looks_like_id(v: &str) -> bool {
    v.len() >= 8
        && v.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && v.chars().any(|c| c == '-')
}

/// Read a process's [`Claim`] off its argv (`argv[0]` is the program; a node install's
/// `cli.js` path is skipped too).
pub fn claim_of(argv: &[String], started_ms: Option<u64>) -> Claim {
    let skip = match argv.get(1) {
        // A node install's script, either separator (Windows: `…\@anthropic-ai\claude-code\…`).
        Some(a) if a.replace('\\', "/").contains("/@anthropic-ai/claude-code/") => 2,
        _ => 1,
    };
    let args = argv.get(skip..).unwrap_or_default();
    if args
        .first()
        .is_some_and(|a| NON_SESSION_SUBCOMMANDS.contains(&a.as_str()))
        || args.iter().any(|a| a == "--chrome-native-host")
    {
        return Claim::Nothing;
    }
    let mut session_id: Option<String> = None;
    let mut resume: Option<Option<String>> = None; // Some(None) = a bare `--resume`
    let mut cont = false;
    let mut fork = false;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let next = args.get(i + 1).filter(|n| !n.starts_with('-'));
        match a {
            "--session-id" => {
                if let Some(n) = next {
                    session_id = Some(n.clone());
                    i += 1;
                }
            }
            "--resume" | "-r" => {
                let id = next.filter(|n| looks_like_id(n)).cloned();
                if id.is_some() {
                    i += 1;
                }
                resume = Some(id);
            }
            "--continue" | "-c" => cont = true,
            "--fork-session" => fork = true,
            _ => {
                if let Some(v) = a.strip_prefix("--session-id=") {
                    session_id = Some(v.to_string());
                } else if let Some(v) = a.strip_prefix("--resume=") {
                    resume = Some(looks_like_id(v).then(|| v.to_string()));
                }
            }
        }
        i += 1;
    }
    if let Some(id) = session_id.filter(|s| !s.is_empty()) {
        return Claim::Id(id);
    }
    match (resume, fork) {
        (Some(Some(id)), false) => Claim::Id(id),
        // A fork writes a NEW session, from now on.
        _ if fork => Claim::Bare { since: started_ms },
        (Some(None), _) => Claim::Bare { since: None },
        _ if cont => Claim::Bare { since: None },
        _ => Claim::Bare { since: started_ms },
    }
}

/// `/Users/me/work/app` → `-Users-me-work-app`: the CLI's project-dir name for a cwd
/// (every character that is not ASCII alphanumeric becomes `-`).
pub fn project_dir_name(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// A session a bare process may claim: its id and newest write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub session_id: String,
    pub mtime_ms: u64,
}

/// Which process owns which session: `session id → index into procs`.
///
/// 1. Every explicit id ([`Claim::Id`]) is claimed by its process (the first one, if
///    two name the same id).
/// 2. The bare processes then claim, **most constrained first**: newest `since` first
///    (ties by pid), the unbounded ones (`since: None`) last. Each takes the newest
///    unclaimed candidate in its cwd's project dir (`candidates(dir name)`, any order)
///    written at or after `since - CLAIM_SLACK_MS`; none qualifies → it claims nothing.
///
/// Why newest-first: a process can only own sessions written after it started, so the
/// sets a process may claim are NESTED — the newest process's set is inside every older
/// one's. Serving the narrowest set first never takes a session an older process
/// needed more (whatever is left still qualifies for the older ones), so this greedy
/// matches as many processes as any order can. Oldest-first would let a long-lived
/// `claude` grab the only session a just-started one could own, leaving the new one
/// claiming nothing and a dead session looking alive in its place. Within that rule,
/// "newest session" is the guess: one folder's bare sessions are indistinguishable by
/// any read-only fact, so liveness is exact per id and a best match per folder.
pub fn assign_claims(
    procs: &[LiveClaude],
    mut candidates: impl FnMut(&str) -> Vec<Candidate>,
) -> HashMap<String, usize> {
    let mut claimed: HashMap<String, usize> = HashMap::new();
    let mut bare: Vec<(usize, Option<u64>)> = Vec::new();
    for (i, p) in procs.iter().enumerate() {
        match claim_of(&p.argv, p.started_ms) {
            Claim::Id(id) => {
                claimed.entry(id).or_insert(i);
            }
            Claim::Bare { since } => bare.push((i, since)),
            Claim::Nothing => {}
        }
    }
    // `Option` orders None < Some, so descending puts the unbounded ones last.
    bare.sort_by(|a, b| b.1.cmp(&a.1).then(procs[a.0].pid.cmp(&procs[b.0].pid)));
    let mut by_dir: HashMap<String, Vec<Candidate>> = HashMap::new();
    for (i, since) in bare {
        let dir = project_dir_name(&procs[i].cwd);
        let list = by_dir.entry(dir).or_insert_with_key(|d| {
            let mut v = candidates(d);
            v.sort_by(|a, b| {
                b.mtime_ms
                    .cmp(&a.mtime_ms)
                    .then_with(|| a.session_id.cmp(&b.session_id))
            });
            v
        });
        let floor = since.map(|s| s.saturating_sub(CLAIM_SLACK_MS));
        if let Some(c) = list
            .iter()
            .find(|c| !claimed.contains_key(&c.session_id) && floor.is_none_or(|f| c.mtime_ms >= f))
        {
            claimed.insert(c.session_id.clone(), i);
        }
    }
    claimed
}

/// The key → host table of the last scan, so [`focus_external_agent`] can act on an
/// opaque key without a path ever coming from the frontend. Replaced wholesale per scan.
#[derive(Debug, Default)]
pub struct HostCache(std::sync::Mutex<HashMap<String, HostApp>>);

impl HostCache {
    /// The app's one cache.
    pub fn global() -> &'static HostCache {
        static CACHE: OnceLock<HostCache> = OnceLock::new();
        CACHE.get_or_init(HostCache::default)
    }

    pub fn replace(&self, next: HashMap<String, HostApp>) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = next;
    }

    pub fn get(&self, key: &str) -> Option<HostApp> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
            .cloned()
    }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/// Every external agent under `projects_dir` (shaped like `~/.claude/projects`) active
/// in `[now_ms - window_ms, now_ms]`: each session, then its sub-agents in the window.
///
/// Pure given its inputs — the projects dir, the clock and the process table are all
/// injected, so every test drives it against a tempdir. Sessions in
/// `exclude_session_ids` (the IDE's own) are skipped. `live` = this user's `claude`
/// processes, `None` when unknown: with a list, only sessions a process claims
/// ([`assign_claims`]) are reported; without one, every session in the window is, with
/// `alive: null`. Roots are ordered most recent first.
pub fn scan_external(
    projects_dir: &Path,
    now_ms: u64,
    window_ms: u64,
    exclude_session_ids: &HashSet<String>,
    live: Option<&[LiveClaude]>,
) -> Vec<ExternalAgentWire> {
    scan_external_with_hosts(projects_dir, now_ms, window_ms, exclude_session_ids, live).0
}

/// [`scan_external`] plus the key → host table for [`HostCache`] (every listed agent
/// whose session's process has a host app; sub-agents included).
pub fn scan_external_with_hosts(
    projects_dir: &Path,
    now_ms: u64,
    window_ms: u64,
    exclude_session_ids: &HashSet<String>,
    live: Option<&[LiveClaude]>,
) -> (Vec<ExternalAgentWire>, HashMap<String, HostApp>) {
    scan_external_cached(
        projects_dir,
        now_ms,
        window_ms,
        exclude_session_ids,
        live,
        &mut LanguageCache::default(),
    )
}

/// [`scan_external_with_hosts`] with the languages' read offsets carried in `langs` from one
/// scan to the next (the app's: [`LanguageCache::global`]). Afterwards `langs` holds exactly
/// the sessions this scan reported.
pub fn scan_external_cached(
    projects_dir: &Path,
    now_ms: u64,
    window_ms: u64,
    exclude_session_ids: &HashSet<String>,
    live: Option<&[LiveClaude]>,
    langs: &mut LanguageCache,
) -> (Vec<ExternalAgentWire>, HashMap<String, HostApp>) {
    let from_ms = now_ms.saturating_sub(window_ms);
    let Ok(projects) = std::fs::read_dir(projects_dir) else {
        return (Vec::new(), HashMap::new()); // no projects dir — a machine that never ran `claude`
    };
    let mut dirs: Vec<(String, Vec<(String, SessionFiles)>)> = projects
        .flatten()
        .filter_map(|p| {
            let name = p.file_name().to_str()?.to_string();
            Some((name, sessions_in(&p.path())))
        })
        .collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    // Claims run over EVERY session, the IDE's own included: an IDE `claude` started
    // bare must claim the IDE's session, not steal an external one.
    let claims = live.map(|procs| {
        assign_claims(procs, |dir| {
            dirs.iter()
                .find(|(name, _)| same_project_dir(name, dir, cfg!(windows)))
                .map(|(_, sessions)| sessions.iter().filter_map(candidate).collect())
                .unwrap_or_default()
        })
    });

    let mut sessions: Vec<Vec<ExternalAgentWire>> = Vec::new();
    let mut hosts: HashMap<String, HostApp> = HashMap::new();
    let mut reported: HashSet<String> = HashSet::new();
    for (_, found) in &dirs {
        for (session_id, files) in found {
            if exclude_session_ids.contains(session_id) {
                continue;
            }
            let owner = claims.as_ref().map(|c| c.get(session_id).copied());
            let alive = owner.map(|o| o.is_some());
            if alive == Some(false) {
                continue; // no live `claude` owns it — gone, however fresh its files
            }
            let host = owner
                .flatten()
                .and_then(|i| live.and_then(|procs| procs[i].host.clone()));
            let name = host.as_ref().map(|h| h.name.as_str());
            let found = scan_session(session_id, files, now_ms, from_ms, alive, name, langs);
            if let Some(agents) = found {
                reported.insert(session_id.clone());
                if let Some(h) = &host {
                    for a in &agents {
                        hosts.insert(a.key.clone(), h.clone());
                    }
                }
                sessions.push(agents);
            }
        }
    }
    langs.retain(&reported);
    // Most recent first; ties broken on the visible fields so the order is stable.
    sessions.sort_by(|a, b| {
        b[0].last_activity_ms
            .cmp(&a[0].last_activity_ms)
            .then_with(|| a[0].folder.cmp(&b[0].folder))
            .then_with(|| a[0].title.cmp(&b[0].title))
    });
    (sessions.into_iter().flatten().collect(), hosts)
}

/// A session as a claim candidate: its root transcript's mtime, else (a session whose
/// root is not flushed yet) its newest sidecar's. Stats only.
fn candidate((session_id, files): &(String, SessionFiles)) -> Option<Candidate> {
    let mtime_ms = match files.root.as_deref() {
        Some(root) => file_mtime_ms(root)?,
        None => files
            .subagents_dir
            .as_deref()
            .map(|dir| sub_files(session_id, dir))
            .unwrap_or_default()
            .iter()
            .map(|s| s.mtime_ms)
            .max()?,
    };
    Some(Candidate {
        session_id: session_id.clone(),
        mtime_ms,
    })
}

/// What one project dir holds for a session: its root transcript and/or its
/// `<session>/subagents` dir (either can exist without the other — a session whose
/// root has not been flushed yet is only its sidecars, `locate_transcript`'s note).
#[derive(Default)]
struct SessionFiles {
    root: Option<PathBuf>,
    subagents_dir: Option<PathBuf>,
}

/// The sessions in one project dir, sorted by id (so the scan is deterministic).
fn sessions_in(dir: &Path) -> Vec<(String, SessionFiles)> {
    let mut found: HashMap<String, SessionFiles> = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new(); // not a directory, or unreadable — skip calmly
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(id) = crate::metrics::session_id_of(&path) {
            if path.is_file() {
                found.entry(id).or_default().root = Some(path);
            }
        } else if path.join("subagents").is_dir() {
            if let Some(id) = path.file_name().and_then(|n| n.to_str()) {
                found.entry(id.to_string()).or_default().subagents_dir =
                    Some(path.join("subagents"));
            }
        }
    }
    let mut out: Vec<(String, SessionFiles)> = found.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// One sub-agent transcript found under a session.
struct SubFile {
    agent_id: String,
    path: PathBuf,
    mtime_ms: u64,
}

/// The session and its in-window sub-agents, or `None` when it is outside the window
/// or carries no cwd at all (nothing to place it with). Its language is caught up in
/// `langs` from its root transcript and those sub-agents' sidecars — only for a session
/// that is reported, so a dead or stale one costs no read.
fn scan_session(
    session_id: &str,
    files: &SessionFiles,
    now_ms: u64,
    from_ms: u64,
    alive: Option<bool>,
    host: Option<&str>,
    langs: &mut LanguageCache,
) -> Option<Vec<ExternalAgentWire>> {
    let root_mtime = files.root.as_deref().and_then(file_mtime_ms);
    if root_mtime.is_some_and(|m| m.saturating_add(SESSION_HORIZON_MS) < now_ms) {
        return None; // long dead — not worth a stat per sidecar
    }
    let subs = files
        .subagents_dir
        .as_deref()
        .map(|dir| sub_files(session_id, dir))
        .unwrap_or_default();
    let last_activity = subs.iter().map(|s| s.mtime_ms).chain(root_mtime).max()?;
    if last_activity < from_ms {
        return None;
    }

    let facts = files
        .root
        .as_deref()
        .map(|p| tail_facts(p, TAIL_BOUND))
        .unwrap_or_default();
    let cwd = facts
        .cwd
        .clone()
        .or_else(|| files.root.as_deref().and_then(head_cwd))
        .or_else(|| subs.iter().find_map(|s| head_cwd(&s.path)))?;
    let folder = basename(&cwd);
    let session_key = opaque_key(&format!("s:{session_id}"));

    // Sub-agents first: a root with no transcript of its own is as busy as they are.
    let windowed: Vec<&SubFile> = subs.iter().filter(|s| s.mtime_ms >= from_ms).collect();
    let listed: HashSet<&str> = windowed.iter().map(|s| s.agent_id.as_str()).collect();
    let language = langs.session_language(
        session_id,
        files
            .root
            .as_deref()
            .into_iter()
            .chain(windowed.iter().map(|s| s.path.as_path())),
    );
    let mut children = Vec::with_capacity(windowed.len());
    for sub in &windowed {
        let meta = SubMeta::read(&sub.path);
        let (activity, tool) = sub_activity(sub, &meta, &facts, now_ms);
        let parent_key = match meta.parent_agent_id.as_deref() {
            Some(p) if listed.contains(p) => opaque_key(&format!("a:{session_id}:{p}")),
            _ => session_key.clone(),
        };
        children.push(ExternalAgentWire {
            key: opaque_key(&format!("a:{session_id}:{}", sub.agent_id)),
            parent_key: Some(parent_key),
            title: meta.agent_type.unwrap_or_else(|| "agent".to_string()),
            folder: folder.clone(),
            activity,
            tool,
            last_activity_ms: sub.mtime_ms,
            alive,
            host: host.map(str::to_string),
            language: language.clone(),
        });
    }

    let (activity, tool) = if files.root.is_some() {
        derive(&facts, now_ms.saturating_sub(last_activity))
    } else if children.iter().any(|c| is_busy(c.activity)) {
        (ExternalActivity::Running, None)
    } else {
        (ExternalActivity::Idle, None)
    };
    let title = facts
        .slug
        .clone()
        .or_else(|| facts.branch.clone())
        .unwrap_or_else(|| "claude".to_string());

    let mut out = Vec::with_capacity(children.len() + 1);
    out.push(ExternalAgentWire {
        key: session_key,
        parent_key: None,
        title,
        folder,
        activity,
        tool,
        last_activity_ms: last_activity,
        alive,
        host: host.map(str::to_string),
        language,
    });
    out.extend(children);
    Some(out)
}

/// `running` or `waiting` — a sidecar-only root is as busy as its busiest child.
fn is_busy(activity: ExternalActivity) -> bool {
    matches!(
        activity,
        ExternalActivity::Running | ExternalActivity::Waiting
    )
}

/// Every sub-agent transcript under a `<session>/subagents` dir (both sidecar shapes —
/// `agent-<id>.jsonl` and `workflows/wf_<run>/agent-<id>.jsonl`, via
/// [`crate::agent::claude::tool_transcripts`]) with its mtime. Lists and stats only.
fn sub_files(session_id: &str, subagents_dir: &Path) -> Vec<SubFile> {
    let loc = TranscriptLocation {
        // Unused by the listing beyond echoing it as entry 0, which is skipped.
        root_transcript: PathBuf::new(),
        subagents_dir: subagents_dir.to_path_buf(),
    };
    crate::agent::claude::tool_transcripts(&loc, session_id)
        .into_iter()
        .skip(1)
        .filter_map(|(agent_id, path)| {
            let mtime_ms = file_mtime_ms(&path)?;
            Some(SubFile {
                agent_id,
                path,
                mtime_ms,
            })
        })
        .collect()
}

/// The `.meta.json` facts a sub-agent's state and label need. `description` is
/// deliberately NOT read — it is prompt text.
#[derive(Default)]
struct SubMeta {
    agent_type: Option<String>,
    tool_use_id: Option<String>,
    parent_agent_id: Option<String>,
    background: bool,
    /// `"finished": true` — the CLI's own "this run is over", dropped again on a resume.
    finished: bool,
}

impl SubMeta {
    fn read(transcript: &Path) -> Self {
        let Some(stem) = transcript
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".jsonl"))
        else {
            return Self::default();
        };
        let meta_path = transcript.with_file_name(format!("{stem}.meta.json"));
        let Some(v) = std::fs::read_to_string(meta_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        else {
            return Self::default();
        };
        let text = |k: &str| nonblank(v.get(k));
        SubMeta {
            agent_type: text("agentType"),
            tool_use_id: text("toolUseId"),
            parent_agent_id: text("parentAgentId"),
            background: text("requestShape").as_deref() == Some("background"),
            finished: v.get("finished").and_then(|f| f.as_bool()) == Some(true),
        }
    }
}

/// A sub-agent's activity: a foreground launch's result in the parent first, then the
/// end evidence the IDE fan-out uses too (the parent's task notification unless the
/// sub-agent wrote past it, the sidecar's `finished`), then its own tail, then
/// staleness.
fn sub_activity(
    sub: &SubFile,
    meta: &SubMeta,
    parent: &TailFacts,
    now_ms: u64,
) -> (ExternalActivity, Option<String>) {
    if !meta.background {
        if let Some(is_error) = meta
            .tool_use_id
            .as_ref()
            .and_then(|id| parent.tool_results.get(id))
        {
            return (finished(*is_error), None);
        }
    }
    let own = tail_facts(&sub.path, SUBAGENT_TAIL_BOUND);
    if let Some(failed) = crate::agent::claude::background_end(
        parent.task_ends.latest(&sub.agent_id),
        own.last_write,
        meta.finished,
    ) {
        return (finished(failed), None);
    }
    let silent = now_ms.saturating_sub(sub.mtime_ms);
    match derive(&own, silent) {
        (ExternalActivity::Idle, _) => (ExternalActivity::Done, None),
        (ExternalActivity::Error, _) => (ExternalActivity::Error, None),
        _ if silent >= SUBAGENT_STALE_MS => (ExternalActivity::Done, None),
        live => live,
    }
}

fn finished(failed: bool) -> ExternalActivity {
    if failed {
        ExternalActivity::Error
    } else {
        ExternalActivity::Done
    }
}

// ---------------------------------------------------------------------------
// The tail: one pass over the last records
// ---------------------------------------------------------------------------

/// Where the turn stands after the last record that says anything about it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Turn {
    /// Nothing in the tail says — reads as idle.
    #[default]
    Unknown,
    Running,
    /// A text reply with no stop reason (still streaming, or a text-only turn).
    TextReply,
    Idle,
    Error,
}

/// Everything the status machine and the labels need from a transcript's tail.
#[derive(Debug, Default)]
struct TailFacts {
    /// Last non-blank `cwd` / `gitBranch` / `slug` seen.
    cwd: Option<String>,
    branch: Option<String>,
    slug: Option<String>,
    turn: Turn,
    /// `tool_use`s not yet answered, in call order: `(id, name)`.
    pending: Vec<(String, String)>,
    /// Every `tool_result` seen: `tool_use_id → is_error` (a foreground sub-agent's
    /// launch is answered when it finishes).
    tool_results: HashMap<String, bool>,
    /// `<task-notification>`s seen: how each background sub-agent last stopped.
    task_ends: crate::agent::claude::TaskEnds,
    /// The newest record `timestamp` in the tail (epoch ms) — for a sub-agent's own
    /// tail, whether it wrote past its parent's notification (a resume).
    last_write: Option<i64>,
}

/// Read at most `bound` bytes off the end of `path` and fold every whole line.
/// Unreadable → empty facts (a file can vanish between the listing and the read).
fn tail_facts(path: &Path, bound: u64) -> TailFacts {
    let mut facts = TailFacts::default();
    for line in tail_lines(path, bound) {
        absorb(&mut facts, &line);
    }
    facts
}

/// The whole lines in the last `bound` bytes. A line cut by the bound at the front is
/// dropped; a torn last line (mid-write) is kept and fails to parse harmlessly.
fn tail_lines(path: &Path, bound: u64) -> Vec<String> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(bound);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.take(bound).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let body: &[u8] = if start > 0 {
        match buf.iter().position(|&b| b == b'\n') {
            Some(i) => &buf[i + 1..],
            None => &[], // one line longer than the bound — nothing whole
        }
    } else {
        &buf
    };
    body.split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| String::from_utf8_lossy(l).into_owned())
        .collect()
}

/// Fold one transcript line into the facts.
fn absorb(facts: &mut TailFacts, line: &str) {
    let v = serde_json::from_str::<serde_json::Value>(line).ok();
    let at = v.as_ref().and_then(crate::agent::claude::line_timestamp);
    // Even from a line that is not JSON (a torn write keeps its tags): unstamped, it
    // then counts as the newest stop.
    if line.contains("<task-notification>") {
        facts.task_ends.absorb(line, at);
    }
    let Some(v) = v else {
        return; // torn / garbage line
    };
    facts.last_write = facts.last_write.max(at);
    if let Some(c) = nonblank(v.get("cwd")) {
        facts.cwd = Some(c);
    }
    if let Some(b) = nonblank(v.get("gitBranch")) {
        facts.branch = Some(b);
    }
    if let Some(s) = nonblank(v.get("slug")) {
        facts.slug = Some(s);
    }
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => absorb_assistant(facts, &v, line),
        Some("user") => absorb_user(facts, &v, line),
        Some("system") => match v.get("subtype").and_then(|s| s.as_str()) {
            Some("turn_duration" | "stop_hook_summary") => end_turn(facts),
            Some("api_error") => facts.turn = Turn::Error,
            _ => {}
        },
        _ => {}
    }
}

fn absorb_assistant(facts: &mut TailFacts, v: &serde_json::Value, line: &str) {
    if v.get("isApiErrorMessage").and_then(|e| e.as_bool()) == Some(true) {
        facts.pending.clear();
        facts.turn = Turn::Error;
        return;
    }
    let mut called = false;
    for block in crate::agent::claude::parse_tool_line(line) {
        if let ToolBlock::Use { id, name, .. } = block {
            facts.pending.push((id, name));
            called = true;
        }
    }
    let message = v.get("message");
    let has_text = match message.and_then(|m| m.get("content")) {
        Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")),
        _ => false,
    };
    let stop = message
        .and_then(|m| m.get("stop_reason"))
        .and_then(|s| s.as_str());
    facts.turn = if called {
        Turn::Running
    } else if has_text && matches!(stop, Some("end_turn" | "stop_sequence")) {
        facts.pending.clear();
        Turn::Idle
    } else if has_text {
        Turn::TextReply
    } else {
        Turn::Running // a thinking block: mid-turn
    };
}

fn absorb_user(facts: &mut TailFacts, v: &serde_json::Value, line: &str) {
    if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
        return; // local-command echoes and caveats, not the user's words
    }
    let mut answered = false;
    for block in crate::agent::claude::parse_tool_line(line) {
        if let ToolBlock::Result {
            tool_use_id,
            is_error,
            ..
        } = block
        {
            facts.pending.retain(|(id, _)| *id != tool_use_id);
            facts.tool_results.insert(tool_use_id, is_error);
            answered = true;
        }
    }
    let content = v.get("message").and_then(|m| m.get("content"));
    let texts: Vec<&str> = match content {
        Some(serde_json::Value::String(s)) => vec![s.as_str()],
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect(),
        _ => Vec::new(),
    };
    if texts
        .iter()
        .any(|t| t.trim_start().starts_with("[Request interrupted"))
    {
        end_turn(facts);
    } else if !texts.is_empty() {
        // A new prompt: a new turn, so nothing from the last one is still pending.
        facts.pending.clear();
        facts.turn = Turn::Running;
    } else if answered {
        facts.turn = Turn::Running; // a result came back: the model is thinking again
    }
}

fn end_turn(facts: &mut TailFacts) {
    facts.pending.clear();
    facts.turn = Turn::Idle;
}

/// Tools that never wait on the user: read-only ones, and the sub-agent launches that
/// legitimately run for minutes without a byte in the parent (pixel-agents' exemptions).
fn never_blocks(tool: &str) -> bool {
    matches!(
        tool,
        "Read"
            | "Grep"
            | "Glob"
            | "LS"
            | "WebFetch"
            | "WebSearch"
            | "NotebookRead"
            | "TodoRead"
            | "TodoWrite"
            | "ToolSearch"
            | "Agent"
            | "Task"
            | "Workflow"
    )
}

/// Tools that ARE a question to the user.
fn asks_user(tool: &str) -> bool {
    matches!(tool, "AskUserQuestion" | "ExitPlanMode")
}

/// The activity a tail implies after `silent_ms` without a write.
fn derive(facts: &TailFacts, silent_ms: u64) -> (ExternalActivity, Option<String>) {
    match facts.turn {
        Turn::Error => (ExternalActivity::Error, None),
        Turn::Idle | Turn::Unknown => (ExternalActivity::Idle, None),
        Turn::TextReply if silent_ms >= TEXT_IDLE_MS => (ExternalActivity::Idle, None),
        Turn::TextReply => (ExternalActivity::Running, None),
        Turn::Running => match facts.pending.last() {
            None => (ExternalActivity::Running, None),
            Some((_, name)) => {
                let waiting =
                    asks_user(name) || (!never_blocks(name) && silent_ms >= PERMISSION_SILENCE_MS);
                let activity = if waiting {
                    ExternalActivity::Waiting
                } else {
                    ExternalActivity::Running
                };
                (activity, Some(name.clone()))
            }
        },
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// An opaque, process-stable key for an id: SipHash under a per-process random key,
/// hex. The id itself never leaves Rust, and a key from one run means
/// nothing in the next.
pub fn opaque_key(id: &str) -> String {
    static STATE: OnceLock<RandomState> = OnceLock::new();
    let mut h = STATE.get_or_init(RandomState::new).build_hasher();
    h.write(id.as_bytes());
    format!("{:016x}", h.finish())
}

/// The first `cwd` in a transcript's bounded head (`session_index`'s scan) — for a
/// tail that held none (one giant record, a sidecar-only session).
fn head_cwd(path: &Path) -> Option<String> {
    let len = std::fs::metadata(path).ok()?.len();
    crate::session_index::scan_head(path, len)?.cwd
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    meta.is_file()
        .then(|| crate::metrics::mtime_ms(&meta).max(0) as u64)
}

/// `/work/alpha` → `alpha`; a path with no final component (`/`) is itself.
fn basename(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| cwd.to_string())
}

/// Symlinks resolved (claude reports `/private/tmp`, a shell may say `/tmp`); a path
/// that no longer exists is compared as written. Windows' `canonicalize` answers with a
/// verbatim `\\?\C:\…` path, which the CLI never writes — its project dir for
/// `C:\Users\me\app` is `C--Users-me-app`, not `----C--…` — so the prefix is dropped
/// ([`strip_verbatim`]).
fn canonical(path: &Path) -> PathBuf {
    strip_verbatim(&std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share\x` → `\\srv\share\x` — the crate-wide helper
/// (it started here, and moved to [`crate::paths`] when the file tree and the Git tab turned
/// out to need it too).
pub use crate::paths::strip_verbatim;

/// Is the project dir `name` the one for `dir` ([`project_dir_name`])? On Windows the file
/// system ignores case, and a shell's cwd keeps whatever case the user typed
/// (`cd c:\users\me\app`), so the CLI's dir name and ours may differ in case only.
pub fn same_project_dir(name: &str, dir: &str, windows: bool) -> bool {
    if windows {
        name.eq_ignore_ascii_case(dir)
    } else {
        name == dir
    }
}

fn nonblank(v: Option<&serde_json::Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    //! Hermetic: every scan runs over a tempdir copy of `tests/fixtures/external_agents`
    //! (or a tree built inline), with the clock and the process facts injected. Nothing
    //! here reads or writes the real `~/.claude` — except the one `#[ignore]`d live test,
    //! which only reads it (registered in `scripts/verify.mjs` LOCAL_INTEGRATION).

    use super::*;
    use serde_json::json;
    use std::time::{Duration, UNIX_EPOCH};

    /// A fixed "now" (2027-01-15) — far from any real file's mtime.
    const NOW: u64 = 1_800_000_000_000;
    const TEN_MIN: u64 = 10 * 60_000;

    const ALPHA: &str = "11111111-1111-4111-8111-111111111111";
    const BETA: &str = "22222222-2222-4222-8222-222222222222";
    const GAMMA: &str = "33333333-3333-4333-8333-333333333333";
    const DELTA: &str = "44444444-4444-4444-8444-444444444444";
    const ZETA: &str = "66666666-6666-4666-8666-666666666666";
    const HOUR: u64 = 3_600_000;

    /// A live `claude` with `args` after the program name.
    fn proc_(
        pid: u32,
        cwd: &str,
        args: &[&str],
        started_ms: Option<u64>,
        host: Option<HostApp>,
    ) -> LiveClaude {
        let mut argv = vec!["claude".to_string()];
        argv.extend(args.iter().map(|a| a.to_string()));
        LiveClaude {
            pid,
            cwd: PathBuf::from(cwd),
            argv,
            started_ms,
            host,
        }
    }

    fn app(name: &str, bundle: &str) -> HostApp {
        HostApp {
            name: name.to_string(),
            target: HostTarget::Bundle(PathBuf::from(bundle)),
        }
    }

    /// The fixture's processes: the IDE's own `claude` for delta (by id), a bare one in
    /// alpha and in beta, a `--resume <gamma>` in iTerm2. Nothing owns zeta or epsilon.
    fn fixture_live() -> Vec<LiveClaude> {
        vec![
            proc_(
                10,
                "/work/alpha",
                &["--session-id", DELTA],
                Some(NOW - HOUR),
                Some(app("Agent Studio", "/Applications/Agent Studio.app")),
            ),
            proc_(11, "/work/alpha", &[], Some(NOW - HOUR), None),
            proc_(12, "/work/beta", &[], Some(NOW - HOUR), None),
            proc_(
                13,
                "/work/gamma",
                &["--resume", GAMMA],
                Some(NOW - HOUR),
                Some(app("iTerm2", "/Applications/iTerm.app")),
            ),
        ]
    }

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/external_agents")
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentstudio-ext-{tag}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn copy_tree(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).expect("mkdir");
        for e in std::fs::read_dir(src).expect("read fixture dir").flatten() {
            let to = dst.join(e.file_name());
            if e.path().is_dir() {
                copy_tree(&e.path(), &to);
            } else {
                std::fs::copy(e.path(), &to).expect("copy");
            }
        }
    }

    fn set_mtime(path: &Path, ms: u64) {
        let f = std::fs::File::options()
            .write(true)
            .open(path)
            .expect("open for mtime");
        f.set_modified(UNIX_EPOCH + Duration::from_millis(ms))
            .expect("set mtime");
    }

    /// The fixture tree, copied to a tempdir with every mtime stamped `NOW - secs`
    /// per `mtimes.json`. Returns the copied `projects` dir.
    fn stage() -> PathBuf {
        let dst = temp_dir("fixture").join("projects");
        copy_tree(&fixture_root().join("projects"), &dst);
        let table: HashMap<String, u64> = serde_json::from_str(
            &std::fs::read_to_string(fixture_root().join("mtimes.json")).expect("mtimes"),
        )
        .expect("mtimes json");
        for (rel, secs) in table {
            set_mtime(&dst.join(rel), NOW - secs * 1000);
        }
        dst
    }

    fn exclude_ide() -> HashSet<String> {
        HashSet::from([DELTA.to_string()])
    }

    fn by_title<'a>(agents: &'a [ExternalAgentWire], title: &str) -> &'a ExternalAgentWire {
        agents
            .iter()
            .find(|a| a.title == title)
            .unwrap_or_else(|| panic!("no agent titled {title} in {agents:#?}"))
    }

    /// Write a session transcript `lines` at `projects/<proj>/<sid>.jsonl`, mtime `ms`.
    fn write_jsonl(path: &Path, lines: &[serde_json::Value], ms: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(path, body).expect("write");
        set_mtime(path, ms);
    }

    fn user(text: &str) -> serde_json::Value {
        json!({"type":"user","cwd":"/work/inline","gitBranch":"main",
               "message":{"role":"user","content":text}})
    }

    fn tool_use(id: &str, name: &str) -> serde_json::Value {
        json!({"type":"assistant","cwd":"/work/inline","message":{"role":"assistant",
               "stop_reason":"tool_use","content":[{"type":"tool_use","id":id,"name":name,"input":{}}]}})
    }

    fn tool_result(id: &str, is_error: bool) -> serde_json::Value {
        json!({"type":"user","cwd":"/work/inline","message":{"role":"user",
               "content":[{"type":"tool_result","tool_use_id":id,"content":"x","is_error":is_error}]}})
    }

    fn facts_of(lines: &[serde_json::Value]) -> TailFacts {
        let mut f = TailFacts::default();
        for l in lines {
            absorb(&mut f, &l.to_string());
        }
        f
    }

    // ── the fixture scenario, end to end ─────────────────────────────────────

    #[test]
    fn the_fixture_scenario_yields_every_external_agent_with_its_state() {
        let projects = stage();
        let live = fixture_live();
        let (agents, hosts) =
            scan_external_with_hosts(&projects, NOW, TEN_MIN, &exclude_ide(), Some(&live));

        // Roots most-recent first, each followed by its in-window sub-agents. Zeta has
        // no process: it is not reported at all, though its transcript is 40 s old.
        let shape: Vec<(&str, &str, ExternalActivity, Option<&str>)> = agents
            .iter()
            .map(|a| {
                (
                    a.title.as_str(),
                    a.folder.as_str(),
                    a.activity,
                    a.tool.as_deref(),
                )
            })
            .collect();
        use ExternalActivity::*;
        assert_eq!(
            shape,
            vec![
                ("quiet-running-otter", "alpha", Running, Some("Agent")),
                ("Explore", "alpha", Done, None),
                ("general-purpose", "alpha", Running, Some("Grep")),
                ("code-reviewer", "alpha", Done, None),
                ("feat/x", "gamma", Waiting, Some("AskUserQuestion")),
                ("calm-idle-heron", "beta", Idle, None),
            ]
        );

        let root = by_title(&agents, "quiet-running-otter");
        assert_eq!(root.parent_key, None);
        // The root's activity is its newest file, a sub-agent's write 2 s ago.
        assert_eq!(root.last_activity_ms, NOW - 2_000);
        let bg = by_title(&agents, "Explore");
        let fg = by_title(&agents, "general-purpose");
        let nested = by_title(&agents, "code-reviewer");
        assert_eq!(bg.parent_key.as_deref(), Some(root.key.as_str()));
        assert_eq!(fg.parent_key.as_deref(), Some(root.key.as_str()));
        assert_eq!(
            nested.parent_key.as_deref(),
            Some(fg.key.as_str()),
            "a nested sub-agent hangs off its parent sub-agent"
        );
        assert_eq!(bg.last_activity_ms, NOW - 120_000);

        // Everything reported is claimed; the host is the claiming process's app.
        assert!(agents.iter().all(|a| a.alive == Some(true)));
        let gamma = by_title(&agents, "feat/x");
        assert_eq!(gamma.host.as_deref(), Some("iTerm2"));
        assert!(agents
            .iter()
            .filter(|a| a.folder != "gamma")
            .all(|a| a.host.is_none()));
        assert_eq!(hosts.len(), 1, "only gamma's app is known: {hosts:?}");
        assert_eq!(
            hosts.get(&gamma.key),
            Some(&app("iTerm2", "/Applications/iTerm.app"))
        );
        // The bare alpha `claude` claimed alpha's session — not delta, the IDE's, which
        // is newer but owned by id by the IDE's own process.
        assert_eq!(agents.iter().filter(|a| a.parent_key.is_none()).count(), 3);
    }

    // ── the project's language (the City's neon sign) ──────────────────────────

    #[test]
    fn a_session_and_its_subagents_carry_the_language_its_files_vote_for() {
        let projects = stage();
        let agents = scan_external(
            &projects,
            NOW,
            TEN_MIN,
            &exclude_ide(),
            Some(&fixture_live()),
        );
        let lang = |title: &str| by_title(&agents, title).language.clone();
        // Alpha's background sub-agent Read `/work/alpha/a.rs`: one vote, and the whole
        // session — root and every sub-agent, the nested one too — is a Rust house.
        for title in [
            "quiet-running-otter",
            "Explore",
            "general-purpose",
            "code-reviewer",
        ] {
            assert_eq!(lang(title).as_deref(), Some("rust"), "{title}");
        }
        // Beta only ran `ls`, gamma only asked a question: nothing says.
        assert_eq!(lang("calm-idle-heron"), None);
        assert_eq!(lang("feat/x"), None);
    }

    #[test]
    fn languages_are_caught_up_across_scans_and_only_live_sessions_are_kept() {
        let projects = temp_dir("lang").join("projects");
        let sid = "77777777-7777-4777-8777-777777777777";
        let path = projects.join("-work-inline").join(format!("{sid}.jsonl"));
        let read = |file: &str| {
            json!({"type":"assistant","cwd":"/work/inline","message":{"role":"assistant",
                   "stop_reason":"tool_use","content":[{"type":"tool_use","id":file,"name":"Read",
                   "input":{"file_path":format!("/work/inline/{file}")}}]}})
        };
        write_jsonl(&path, &[user("go"), read("a.py")], NOW - 1_000);
        let live = [proc_(1, "/work/inline", &[], Some(NOW - HOUR), None)];
        let mut langs = LanguageCache::default();
        let scan = |langs: &mut LanguageCache, live: &[LiveClaude]| {
            scan_external_cached(&projects, NOW, TEN_MIN, &HashSet::new(), Some(live), langs).0
        };
        assert_eq!(
            scan(&mut langs, &live)[0].language.as_deref(),
            Some("python")
        );
        assert_eq!(langs.sessions(), HashSet::from([sid]));
        // Two Go files later, the next scan reads only what was appended — and Go wins.
        let mut body = std::fs::read_to_string(&path).unwrap();
        for f in ["b.go", "c.go"] {
            body.push_str(&format!("{}\n", read(f)));
        }
        std::fs::write(&path, body).unwrap();
        set_mtime(&path, NOW - 500);
        assert_eq!(scan(&mut langs, &live)[0].language.as_deref(), Some("go"));
        // Its `claude` is gone: not reported, and its votes are dropped with it.
        assert!(scan(&mut langs, &[]).is_empty());
        assert!(langs.sessions().is_empty());
        // A fresh cache (the one-shot `scan_external`) counts the whole file at once.
        let once = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), Some(&live));
        assert_eq!(once[0].language.as_deref(), Some("go"));
    }

    /// Regression: the app restarted, its old `claude` died with it,
    /// and the transcript (written < 10 min ago, tail mid-turn, a sub-agent busy) kept
    /// it on screen as "Thinking" — because the IDE's two NEW `claude`s in the same
    /// folder made the folder look alive. Per-session liveness: they claim their own ids
    /// (the IDE's, excluded), nobody claims the old one, so it is not reported.
    #[test]
    fn a_dead_session_in_a_folder_with_live_ide_agents_is_not_reported() {
        let base = temp_dir("restart");
        let dir = base.join("-Users-me-projects-gazelle");
        let old = "01a1392d-0000-7000-8000-000000000001";
        let new1 = "01a13944-0000-7000-8000-000000000002";
        let new2 = "01a13945-0000-7000-8000-000000000003";
        let cwd = "/Users/me/projects/gazelle";
        let line = |t: &str| json!({"type":"user","cwd":cwd,"message":{"role":"user","content":t}});
        write_jsonl(
            &dir.join(format!("{old}.jsonl")),
            &[line("go")],
            NOW - 60_000,
        );
        write_jsonl(
            &dir.join(old).join("subagents/agent-a1.jsonl"),
            &[line("x"), tool_use("t1", "Grep")],
            NOW - 30_000,
        );
        write_jsonl(
            &dir.join(format!("{new1}.jsonl")),
            &[line("a")],
            NOW - 2_000,
        );
        write_jsonl(
            &dir.join(format!("{new2}.jsonl")),
            &[line("b")],
            NOW - 3_000,
        );
        let ide = Some(app("Agent Studio", "/Applications/Agent Studio.app"));
        let live = vec![
            proc_(
                1,
                cwd,
                &["--session-id", new1],
                Some(NOW - 9_000),
                ide.clone(),
            ),
            proc_(2, cwd, &["--session-id", new2], Some(NOW - 8_000), ide),
        ];
        let exclude = HashSet::from([new1.to_string(), new2.to_string()]);
        let agents = scan_external(&base, NOW, TEN_MIN, &exclude, Some(&live));
        assert!(agents.is_empty(), "the dead session came back: {agents:#?}");

        // Where the OS has no process table (Windows) nothing can be called dead: the
        // old behaviour stands — listed, liveness unknown.
        let agents = scan_external(&base, NOW, TEN_MIN, &exclude, None);
        assert_eq!(agents.len(), 2, "{agents:#?}");
        assert!(agents.iter().all(|a| a.alive.is_none() && a.host.is_none()));

        // And a bare `claude` started after the old session's last write never owns it.
        let late = vec![proc_(3, cwd, &[], Some(NOW - 1_000), None)];
        assert!(scan_external(
            &base,
            NOW,
            TEN_MIN,
            &HashSet::from([new1.into(), new2.into()]),
            Some(&late)
        )
        .is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Three bare `claude`s in one folder (three iTerm tabs in one project),
    /// plus one started after every write there. Most constrained first: the newest
    /// process takes the newest session it can own, and so on down; the just-started one
    /// claims nothing, and the one session left over is hidden.
    #[test]
    fn bare_processes_in_one_folder_claim_newest_first() {
        let cands = vec![
            Candidate {
                session_id: "c-3h".into(),
                mtime_ms: NOW - 3 * HOUR,
            },
            Candidate {
                session_id: "a-10s".into(),
                mtime_ms: NOW - 10_000,
            },
            Candidate {
                session_id: "d-3d".into(),
                mtime_ms: NOW - 72 * HOUR,
            },
            Candidate {
                session_id: "b-2m".into(),
                mtime_ms: NOW - 120_000,
            },
        ];
        let cwd = "/work/many";
        let procs = vec![
            proc_(40, cwd, &[], Some(NOW - 48 * HOUR), None), // oldest
            proc_(41, cwd, &[], Some(NOW), None),             // after every write
            proc_(42, cwd, &[], Some(NOW - 60_000), None),    // newest that can own one
            proc_(43, cwd, &[], Some(NOW - HOUR), None),
        ];
        let mut asked = Vec::new();
        let claims = assign_claims(&procs, |dir| {
            asked.push(dir.to_string());
            cands.clone()
        });
        assert_eq!(asked, vec!["-work-many"], "one listing per folder");
        let owner = |sid: &str| claims.get(sid).map(|&i| procs[i].pid);
        assert_eq!(owner("a-10s"), Some(42));
        assert_eq!(owner("b-2m"), Some(43));
        assert_eq!(owner("c-3h"), Some(40));
        assert_eq!(owner("d-3d"), None);
        assert_eq!(claims.len(), 3, "the just-started process claims nothing");

        // Why newest-first: with a fresh session and an old one, oldest-first would let
        // pid 40 take a-10s, and 42 (started a minute ago) could own nothing else —
        // c-3h would be hidden although a live process is on it. Newest-first matches both.
        let two = vec![cands[0].clone(), cands[1].clone()];
        let claims = assign_claims(&procs[..3], |_| two.clone());
        assert_eq!(claims.get("a-10s").map(|&i| procs[i].pid), Some(42));
        assert_eq!(claims.get("c-3h").map(|&i| procs[i].pid), Some(40));

        // The same thing end to end, through the scan.
        let base = temp_dir("three");
        let dir = base.join("-work-many");
        for c in &cands {
            let l = json!({"type":"user","cwd":cwd,"slug":c.session_id,"message":{"role":"user","content":"x"}});
            write_jsonl(
                &dir.join(format!("{}.jsonl", c.session_id)),
                &[l],
                c.mtime_ms,
            );
        }
        let agents = scan_external(&base, NOW, 4 * HOUR, &HashSet::new(), Some(&procs));
        let titles: Vec<&str> = agents.iter().map(|a| a.title.as_str()).collect();
        assert_eq!(titles, vec!["a-10s", "b-2m", "c-3h"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn explicit_ids_win_and_unbounded_bare_processes_go_last() {
        let cands = vec![
            Candidate {
                session_id: "s-new".into(),
                mtime_ms: NOW - 1_000,
            },
            Candidate {
                session_id: "s-old".into(),
                mtime_ms: NOW - 5 * HOUR,
            },
        ];
        let procs = vec![
            // `--continue` may own an old session: unbounded, served after the bounded.
            proc_(1, "/w", &["--continue"], Some(NOW - 1_000), None),
            proc_(2, "/w", &[], Some(NOW - 60_000), None),
            // An explicit id is claimed even with no transcript yet, and twice → first.
            proc_(3, "/w", &["--session-id", "s-fresh"], None, None),
            proc_(4, "/w", &["--session-id", "s-fresh"], None, None),
            proc_(5, "/w", &["mcp", "serve"], None, None),
            // No start time known: unbounded too.
            proc_(6, "/elsewhere", &[], None, None),
        ];
        let claims = assign_claims(&procs, |dir| match dir {
            "-w" => cands.clone(),
            _ => Vec::new(),
        });
        let owner = |sid: &str| claims.get(sid).map(|&i| procs[i].pid);
        assert_eq!(owner("s-fresh"), Some(3));
        assert_eq!(owner("s-new"), Some(2));
        assert_eq!(owner("s-old"), Some(1));
        assert_eq!(claims.len(), 3);
        // An id claimed by argv is never handed to a bare process.
        let procs = vec![
            proc_(1, "/w", &[], Some(NOW - HOUR), None),
            proc_(2, "/w", &["-r", "aaaa-0001"], None, None),
        ];
        let claims = assign_claims(&procs, |_| {
            vec![
                Candidate {
                    session_id: "aaaa-0001".into(),
                    mtime_ms: NOW,
                },
                Candidate {
                    session_id: "bbbb-0002".into(),
                    mtime_ms: NOW - 10,
                },
            ]
        });
        assert_eq!(claims.get("aaaa-0001"), Some(&1));
        assert_eq!(claims.get("bbbb-0002"), Some(&0));
    }

    #[test]
    fn claims_read_off_argv() {
        let c = |args: &[&str]| {
            let mut argv = vec!["claude".to_string()];
            argv.extend(args.iter().map(|a| a.to_string()));
            claim_of(&argv, Some(77))
        };
        let id = |s: &str| Claim::Id(s.to_string());
        let uuid = "01a13944-0000-7000-8000-00000000aaaa";
        assert_eq!(c(&[]), Claim::Bare { since: Some(77) });
        assert_eq!(
            c(&["--permission-mode", "bypassPermissions"]),
            Claim::Bare { since: Some(77) }
        );
        assert_eq!(c(&["--session-id", uuid]), id(uuid));
        assert_eq!(c(&[format!("--session-id={uuid}").as_str()]), id(uuid));
        assert_eq!(c(&["--resume", uuid]), id(uuid));
        assert_eq!(c(&["-r", uuid, "--model", "opus"]), id(uuid));
        assert_eq!(c(&[format!("--resume={uuid}").as_str()]), id(uuid));
        // `--session-id` beats `--resume` (it names the session being written).
        assert_eq!(
            c(&["--resume", "aaaa-bbbb", "--session-id", uuid]),
            id(uuid)
        );
        // A fork writes a new session from now on.
        assert_eq!(
            c(&["--resume", uuid, "--fork-session"]),
            Claim::Bare { since: Some(77) }
        );
        assert_eq!(
            c(&["--continue", "--fork-session"]),
            Claim::Bare { since: Some(77) }
        );
        // An existing session of any age.
        assert_eq!(c(&["--continue"]), Claim::Bare { since: None });
        assert_eq!(c(&["-c"]), Claim::Bare { since: None });
        assert_eq!(c(&["--resume"]), Claim::Bare { since: None });
        assert_eq!(c(&["-r", "--verbose"]), Claim::Bare { since: None });
        assert_eq!(
            c(&["--resume", "auth bug"]),
            Claim::Bare { since: None },
            "a search term"
        );
        assert_eq!(
            c(&["--resume=deadbeef"]),
            Claim::Bare { since: None },
            "no dash: not an id"
        );
        // A missing / empty / flag-shaped id value names nothing.
        assert_eq!(c(&["--session-id"]), Claim::Bare { since: Some(77) });
        assert_eq!(
            c(&["--session-id", "--verbose"]),
            Claim::Bare { since: Some(77) }
        );
        assert_eq!(c(&["--session-id="]), Claim::Bare { since: Some(77) });
        // Not sessions.
        assert_eq!(c(&["mcp", "serve"]), Claim::Nothing);
        assert_eq!(c(&["doctor"]), Claim::Nothing);
        assert_eq!(c(&["--chrome-native-host"]), Claim::Nothing);
        // A node install: argv[1] is the CLI script.
        let node: Vec<String> = [
            "node",
            "/x/node_modules/@anthropic-ai/claude-code/cli.js",
            "-r",
            uuid,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(claim_of(&node, None), id(uuid));
        assert_eq!(claim_of(&[], None), Claim::Bare { since: None });
        assert_eq!(
            project_dir_name(Path::new("/Users/me/.claude/x_y")),
            "-Users-me--claude-x-y"
        );
    }

    // ── the host app ─────────────────────────────────────────────────────────

    fn raw(pid: u32, ppid: u32, exe: Option<&str>, argv: &[&str]) -> crate::procscan::os::RawProc {
        crate::procscan::os::RawProc {
            pid,
            ppid,
            exe: exe.map(str::to_string),
            argv: argv.iter().map(|a| a.to_string()).collect(),
            cwd: None,
            started_ms: Some(1_000),
            fds: Vec::new(),
        }
    }

    #[test]
    fn the_host_is_the_outermost_app_bundle_or_itermserver() {
        let bundle = |exe: &str| host_from_exe(exe);
        assert_eq!(
            bundle("/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            Some(app("iTerm2", "/Applications/iTerm.app"))
        );
        assert_eq!(
            bundle("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
            Some(app(
                "Terminal",
                "/System/Applications/Utilities/Terminal.app"
            ))
        );
        assert_eq!(
            bundle("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"),
            Some(app("Visual Studio Code", "/Applications/Visual Studio Code.app"))
        );
        assert_eq!(
            bundle("/Users/me/Applications/RustRover.app/Contents/MacOS/rustrover"),
            Some(app("RustRover", "/Users/me/Applications/RustRover.app"))
        );
        assert_eq!(
            bundle("/Users/me/Library/Application Support/iTerm2/iTermServer-3.0.0"),
            Some(HostApp {
                name: "iTerm2".into(),
                target: HostTarget::BundleId("com.googlecode.iterm2".into()),
            })
        );
        for none in [
            "/bin/zsh",
            "/usr/bin/login",
            "/sbin/launchd",
            "/x/Foo.app",
            "/x/.app/Contents/y",
            "",
            "tmux",
        ] {
            assert_eq!(bundle(none), None, "{none}");
        }
    }

    #[test]
    fn the_host_walk_climbs_the_parent_chain() {
        let table = vec![
            // iTerm2: claude → -zsh → login → iTermServer → launchd
            raw(100, 99, Some("/Users/me/.local/share/claude/versions/2.1"), &["claude"]),
            raw(99, 98, Some("/bin/zsh"), &["-zsh"]),
            raw(98, 97, Some("/usr/bin/login"), &["login"]),
            raw(97, 1, Some("/Users/me/Library/Application Support/iTerm2/iTermServer-3.0.0"), &[]),
            raw(1, 0, Some("/sbin/launchd"), &[]),
            // VS Code: claude → zsh → Code Helper (exe unknown → argv[0]) → Code
            raw(200, 199, None, &["claude"]),
            raw(199, 198, Some("/bin/zsh"), &["zsh"]),
            raw(198, 197, None, &["/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"]),
            // tmux: claude → zsh → tmux → launchd — no app
            raw(300, 299, None, &["claude"]),
            raw(299, 298, Some("/bin/zsh"), &["zsh"]),
            raw(298, 1, Some("/opt/homebrew/bin/tmux"), &["tmux"]),
            // a ppid cycle, and a dangling parent
            raw(400, 401, None, &["claude"]),
            raw(401, 400, None, &["zsh"]),
            raw(500, 4242, None, &["claude"]),
            raw(600, 600, None, &["claude"]),
            raw(700, 0, None, &[]),
        ];
        let by_pid: HashMap<u32, &crate::procscan::os::RawProc> =
            table.iter().map(|p| (p.pid, p)).collect();
        let nobody = |_: u32| None;
        assert_eq!(
            host_of(100, &by_pid, nobody).map(|h| h.name),
            Some("iTerm2".into())
        );
        assert_eq!(
            host_of(200, &by_pid, nobody),
            Some(app(
                "Visual Studio Code",
                "/Applications/Visual Studio Code.app"
            ))
        );
        assert_eq!(host_of(300, &by_pid, nobody), None);
        assert_eq!(host_of(400, &by_pid, nobody), None, "a cycle ends the walk");
        assert_eq!(host_of(500, &by_pid, nobody), None);
        assert_eq!(host_of(600, &by_pid, nobody), None, "its own parent");
        assert_eq!(
            host_of(700, &by_pid, nobody),
            None,
            "no exe, no argv, ppid 0"
        );
        assert_eq!(host_of(9, &by_pid, nobody), None);

        // iTerm2 as it really is: the shell's parent is a ROOT `login`, absent from the
        // user's table — the walk asks the OS for it and carries on to iTermServer.
        let real = [
            raw(800, 799, None, &["claude"]),
            raw(799, 798, Some("/bin/zsh"), &["-zsh"]),
            raw(
                797,
                1,
                Some("/Users/me/Library/Application Support/iTerm2/iTermServer-3.0.0"),
                &[],
            ),
        ];
        let by_pid: HashMap<u32, &crate::procscan::os::RawProc> =
            real.iter().map(|p| (p.pid, p)).collect();
        let asked = std::cell::RefCell::new(Vec::new());
        let os = |pid: u32| {
            asked.borrow_mut().push(pid);
            (pid == 798).then(|| (797, Some("/usr/bin/login".to_string())))
        };
        assert_eq!(
            host_of(800, &by_pid, os).map(|h| h.name),
            Some("iTerm2".into())
        );
        assert_eq!(
            *asked.borrow(),
            vec![798],
            "only the missing ancestor is asked"
        );
        assert_eq!(
            host_of(800, &by_pid, nobody),
            None,
            "without the OS answer, no host"
        );
    }

    #[test]
    fn live_claudes_are_the_cli_processes_with_a_cwd() {
        let table = vec![
            raw(
                10,
                9,
                Some("/Users/me/.local/share/claude/versions/2.1"),
                &["claude", "--session-id", "x"],
            ),
            raw(
                9,
                1,
                Some("/Applications/Ghostty.app/Contents/MacOS/ghostty"),
                &["ghostty"],
            ),
            // claude's own claude child: a helper, not a session.
            raw(11, 10, None, &["claude", "mcp", "serve"]),
            raw(12, 1, None, &["claude"]), // no cwd readable
            raw(13, 1, None, &["node", "server.js"]),
            {
                let mut p = raw(14, 1, None, &["claude"]);
                p.started_ms = Some(-5);
                p
            },
        ];
        let live = live_claudes_from(
            &table,
            |pid| (pid != 12).then(|| PathBuf::from(format!("/w/{pid}"))),
            |_| None,
        );
        assert_eq!(live.iter().map(|l| l.pid).collect::<Vec<_>>(), vec![10, 14]);
        assert_eq!(live[0].cwd, PathBuf::from("/w/10"));
        assert_eq!(live[0].started_ms, Some(1_000));
        assert_eq!(
            live[0].host.as_ref().map(|h| h.name.as_str()),
            Some("Ghostty")
        );
        assert_eq!(live[1].started_ms, Some(0), "a bogus start clamps");
        assert_eq!(live[1].host, None);
    }

    #[test]
    fn subagents_carry_their_sessions_host_into_the_cache() {
        let projects = stage();
        let live = vec![
            proc_(10, "/work/alpha", &["--session-id", DELTA], None, None),
            proc_(
                11,
                "/work/alpha",
                &[],
                None,
                Some(app("Ghostty", "/Applications/Ghostty.app")),
            ),
        ];
        let (agents, hosts) =
            scan_external_with_hosts(&projects, NOW, TEN_MIN, &exclude_ide(), Some(&live));
        assert_eq!(
            agents.len(),
            4,
            "alpha and its three in-window sub-agents: {agents:#?}"
        );
        assert!(agents.iter().all(|a| a.host.as_deref() == Some("Ghostty")));
        assert_eq!(hosts.len(), 4);
        assert!(agents.iter().all(|a| hosts.contains_key(&a.key)));
    }

    #[test]
    fn the_host_cache_answers_by_key_and_is_replaced_per_scan() {
        let cache = HostCache::default();
        assert_eq!(cache.get("k"), None);
        cache.replace(HashMap::from([(
            "k".to_string(),
            app("Terminal", "/T.app"),
        )]));
        assert_eq!(cache.get("k"), Some(app("Terminal", "/T.app")));
        cache.replace(HashMap::new());
        assert_eq!(cache.get("k"), None);
        // The global one is a single instance.
        assert!(std::ptr::eq(HostCache::global(), HostCache::global()));
    }

    #[test]
    fn focusing_runs_open_with_the_cached_app_only() {
        assert_eq!(
            open_args(&app("iTerm2", "/Applications/iTerm.app")),
            vec![
                std::ffi::OsString::from("-a"),
                "/Applications/iTerm.app".into()
            ]
        );
        let by_id = HostApp {
            name: "iTerm2".into(),
            target: HostTarget::BundleId("com.googlecode.iterm2".into()),
        };
        assert_eq!(
            open_args(&by_id),
            vec![
                std::ffi::OsString::from("-b"),
                "com.googlecode.iterm2".into()
            ]
        );
        let mut seen = Vec::new();
        assert_eq!(
            focus_host(&by_id, |a| {
                seen = a.to_vec();
                Ok(())
            }),
            Ok(())
        );
        assert_eq!(seen, open_args(&by_id));
        assert_eq!(
            focus_host(&by_id, |_| Err("open-failed: exit Some(1)".into())),
            Err("open-failed: exit Some(1)".into())
        );

        // A Windows host goes to the window seam with its pid and image — never to `open`;
        // a bundle never to the window seam.
        let win = HostApp {
            name: "Windows Terminal".into(),
            target: HostTarget::Window {
                pid: 4242,
                exe: Some(PathBuf::from(r"C:\WT\WindowsTerminal.exe")),
            },
        };
        assert!(open_args(&win).is_empty());
        let mut asked = None;
        assert_eq!(
            focus_host_with(
                &win,
                |_| panic!("a window host is not opened"),
                |pid, exe| {
                    asked = Some((pid, exe.map(Path::to_path_buf)));
                    Ok(())
                }
            ),
            Ok(())
        );
        assert_eq!(
            asked,
            Some((4242, Some(PathBuf::from(r"C:\WT\WindowsTerminal.exe"))))
        );
        assert_eq!(
            focus_host_with(&win, |_| Ok(()), |_, _| Err("no-host: gone".into())),
            Err("no-host: gone".into())
        );
        assert_eq!(
            focus_host_with(&by_id, |_| Ok(()), |_, _| panic!("a bundle is opened")),
            Ok(())
        );

        // The command: a key no scan produced is `no-host` on macOS and Windows (and
        // `unsupported` elsewhere) — it never reaches `open` or a window.
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let err = rt
            .block_on(focus_external_agent(format!("never-{}", ulid::Ulid::new())))
            .expect_err("unknown key");
        let want = if cfg!(any(target_os = "macos", windows)) {
            "no-host:"
        } else {
            "unsupported:"
        };
        assert!(err.starts_with(want), "{err}");
    }

    #[test]
    fn windows_paths_reach_the_project_dir_the_cli_wrote() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(
            strip_verbatim(&p(r"\\?\C:\Users\me\app")),
            p(r"C:\Users\me\app")
        );
        assert_eq!(
            strip_verbatim(&p(r"\\?\UNC\srv\share\app")),
            p(r"\\srv\share\app")
        );
        for same in [r"C:\Users\me\app", "/work/app", r"\\?\Volume{x}\app", ""] {
            assert_eq!(strip_verbatim(&p(same)), p(same), "{same}");
        }
        // The CLI's dir name for the stripped path; the verbatim one would not match.
        assert_eq!(
            project_dir_name(&strip_verbatim(&p(r"\\?\C:\Users\me\app"))),
            "C--Users-me-app"
        );
        assert_eq!(
            project_dir_name(&p(r"\\?\C:\Users\me\app")),
            "----C--Users-me-app"
        );
        assert!(same_project_dir("C--Users-me-app", "c--users-ME-app", true));
        assert!(!same_project_dir(
            "C--Users-me-app",
            "c--users-ME-app",
            false
        ));
        assert!(same_project_dir("-work-app", "-work-app", false));
    }

    #[test]
    fn a_windows_npm_claude_is_claimed_past_its_script_path() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let id = "5e550000-0000-4000-8000-000000000002";
        assert_eq!(
            claim_of(
                &argv(&[
                    r"C:\Program Files\nodejs\node.exe",
                    r"C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js",
                    "mcp",
                ]),
                None
            ),
            Claim::Nothing,
            "the script path is skipped, so `mcp` is the subcommand"
        );
        assert_eq!(
            claim_of(
                &argv(&[
                    "node",
                    r"C:\npm\node_modules\@anthropic-ai\claude-code\cli.js",
                    "--resume",
                    id
                ]),
                Some(5)
            ),
            Claim::Id(id.to_string())
        );
    }

    #[test]
    fn the_host_lookup_is_injectable_per_os() {
        let table = vec![raw(
            10,
            9,
            Some(r"C:\Users\me\.local\bin\claude.exe"),
            &["claude"],
        )];
        let live = live_claudes_with(
            &table,
            |pid| Some(PathBuf::from(format!("/w/{pid}"))),
            |pid, by_pid| {
                assert!(by_pid.contains_key(&pid));
                Some(app("Probe", "/P.app"))
            },
        );
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].host, Some(app("Probe", "/P.app")));
    }

    /// No process table → nothing hidden; with one, a fresh, busy-looking session no
    /// process claims is gone, and a claimed one keeps the transcript's word.
    #[test]
    fn an_unclaimed_session_is_hidden_however_fresh() {
        let projects = stage();
        let none: Vec<LiveClaude> = Vec::new();
        assert!(scan_external(&projects, NOW, TEN_MIN, &exclude_ide(), Some(&none)).is_empty());
        let only_zeta = vec![proc_(1, "/work/zeta", &["--session-id", ZETA], None, None)];
        let agents = scan_external(&projects, NOW, TEN_MIN, &exclude_ide(), Some(&only_zeta));
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].folder, "zeta");
        assert_eq!(agents[0].activity, ExternalActivity::Error);
        // A claimed session outside the window is still not listed.
        let beta = vec![proc_(1, "/work/beta", &["-r", BETA], None, None)];
        assert!(scan_external(&projects, NOW, 60_000, &exclude_ide(), Some(&beta)).is_empty());
        // Every session listed with no process table.
        let all = scan_external(&projects, NOW, TEN_MIN, &exclude_ide(), None);
        assert_eq!(all.iter().filter(|a| a.parent_key.is_none()).count(), 4);
    }

    #[test]
    fn a_sidecar_only_session_is_a_claim_candidate_by_its_newest_sidecar() {
        let projects = temp_dir("sidecar-claim");
        let subs = projects.join("-work-inline/sid-only/subagents");
        write_jsonl(&subs.join("agent-x1.jsonl"), &[user("go")], NOW - 1_000);
        write_jsonl(&subs.join("agent-x2.jsonl"), &[user("go")], NOW - 9_000);
        let found = sessions_in(&projects.join("-work-inline"));
        assert_eq!(
            candidate(&found[0]),
            Some(Candidate {
                session_id: "sid-only".into(),
                mtime_ms: NOW - 1_000
            })
        );
        let live = vec![proc_(1, "/work/inline", &[], Some(NOW - 5_000), None)];
        assert_eq!(
            scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), Some(&live)).len(),
            3
        );
        // A session dir with neither a root nor a sidecar transcript is no candidate.
        assert_eq!(candidate(&("e".into(), SessionFiles::default())), None);
    }

    #[test]
    fn keys_are_opaque_stable_and_unique() {
        let projects = stage();
        let a = scan_external(&projects, NOW, TEN_MIN, &exclude_ide(), None);
        let b = scan_external(&projects, NOW, TEN_MIN, &exclude_ide(), None);
        assert_eq!(
            a, b,
            "the same tree scans to the same keys within a process"
        );
        let keys: HashSet<&str> = a.iter().map(|x| x.key.as_str()).collect();
        assert_eq!(keys.len(), a.len());
        for k in keys {
            assert_eq!(k.len(), 16);
            assert!(k.chars().all(|c| c.is_ascii_hexdigit()), "{k}");
        }
        assert_ne!(opaque_key("s:x"), opaque_key("s:y"));
    }

    #[test]
    fn nothing_private_crosses_the_wire() {
        let projects = stage();
        let live = fixture_live();
        let mut agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        agents.extend(scan_external(
            &projects,
            NOW,
            TEN_MIN,
            &HashSet::new(),
            Some(&live),
        ));
        assert!(
            agents.iter().any(|a| a.host.is_some()),
            "a host is on the wire"
        );
        assert!(
            agents.iter().any(|a| a.language.as_deref() == Some("rust")),
            "a language is on the wire — and below, the file that voted for it is not"
        );
        let wire = serde_json::to_string(&ExternalAgentsReport {
            agents,
            scanned_at_ms: NOW,
        })
        .unwrap();
        for leak in [
            ALPHA,                        // a Claude session id
            "abg1",                       // a sub-agent id
            "never shown",                // .meta.json description / ai-title (prompt text)
            "please do the fixture task", // the prompt
            "/work/",                     // an absolute path
            "/Applications",              // a host app's bundle path
            "com.googlecode",             // …or a bundle id
            "a.rs",                       // a tool argument (the file that voted "rust")
            ".rs",                        // …or its extension
            "fn main",                    // a tool result
        ] {
            assert!(
                !wire.contains(leak),
                "{leak:?} leaked onto the wire: {wire}"
            );
        }
    }

    #[test]
    fn the_wire_is_camel_case_with_lowercase_activities() {
        let w = ExternalAgentWire {
            key: "k".into(),
            parent_key: None,
            title: "t".into(),
            folder: "f".into(),
            activity: ExternalActivity::Waiting,
            tool: None,
            last_activity_ms: 1,
            alive: None,
            host: Some("iTerm2".into()),
            language: Some("rust".into()),
        };
        assert_eq!(
            serde_json::to_string(&w).unwrap(),
            r#"{"key":"k","parentKey":null,"title":"t","folder":"f","activity":"waiting","tool":null,"lastActivityMs":1,"alive":null,"host":"iTerm2","language":"rust"}"#
        );
        let r = ExternalAgentsReport {
            agents: vec![],
            scanned_at_ms: 2,
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"agents":[],"scannedAtMs":2}"#
        );
    }

    #[test]
    fn the_ides_own_sessions_are_excluded_by_id() {
        let projects = stage();
        let with = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        let without = scan_external(&projects, NOW, TEN_MIN, &exclude_ide(), None);
        assert_eq!(with.len(), without.len() + 1);
        // Delta has no slug, so its branch is its title; it lives in alpha's house.
        let delta = with.iter().find(|a| a.title == "main").expect("delta");
        assert_eq!(delta.folder, "alpha");
        assert_eq!(delta.activity, ExternalActivity::Idle);
        assert!(!without.iter().any(|a| a.title == "main"));
    }

    #[test]
    fn a_wider_window_admits_older_sessions_and_stale_subagents() {
        let projects = stage();
        let agents = scan_external(&projects, NOW, 3 * 3_600_000, &exclude_ide(), None);
        let eps = agents
            .iter()
            .find(|a| a.folder == "epsilon")
            .expect("epsilon");
        // Its tail ends on a prompt (running), but nothing has been written for an hour…
        // a root keeps the transcript's word; only `alive` can say the process is gone.
        assert_eq!(eps.activity, ExternalActivity::Running);
        // aold4's tail also ends mid-turn; silent for 2 h, a sub-agent is taken as done.
        let old = by_title(&agents, "Plan");
        assert_eq!(old.activity, ExternalActivity::Done);
        assert!(agents.iter().all(|a| a.alive.is_none()));
    }

    #[test]
    fn an_empty_or_missing_projects_dir_is_an_empty_list() {
        let missing = temp_dir("missing").join("nope");
        assert!(scan_external(&missing, NOW, TEN_MIN, &HashSet::new(), None).is_empty());
        let empty = temp_dir("empty");
        // A stray file at the top level is not a project dir.
        std::fs::write(empty.join("stray.jsonl"), "{}\n").unwrap();
        assert!(scan_external(&empty, NOW, TEN_MIN, &HashSet::new(), None).is_empty());
    }

    // ── session assembly edge cases ──────────────────────────────────────────

    #[test]
    fn a_sidecar_only_session_takes_its_cwd_and_business_from_the_subagents() {
        let projects = temp_dir("sidecar");
        let subs = projects.join("-work-inline/sid-only/subagents");
        write_jsonl(
            &subs.join("agent-x1.jsonl"),
            &[user("go"), tool_use("t1", "Edit")],
            NOW - 1_000,
        );
        let agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].folder, "inline");
        assert_eq!(
            agents[0].title, "claude",
            "no root tail → no slug or branch"
        );
        assert_eq!(agents[0].activity, ExternalActivity::Running);
        assert_eq!(
            agents[1].title, "agent",
            "no .meta.json → the generic title"
        );
        assert_eq!(agents[1].tool.as_deref(), Some("Edit"));

        // The same sidecar finished → the root is idle.
        write_jsonl(
            &subs.join("agent-x1.jsonl"),
            &[
                user("go"),
                json!({"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn",
                       "content":[{"type":"text","text":"done"}]}}),
            ],
            NOW - 1_000,
        );
        let agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        assert_eq!(agents[0].activity, ExternalActivity::Idle);
        assert_eq!(agents[1].activity, ExternalActivity::Done);
    }

    #[test]
    fn a_session_with_no_cwd_anywhere_is_skipped() {
        let projects = temp_dir("nocwd");
        write_jsonl(
            &projects.join("-x/s1.jsonl"),
            &[json!({"type":"permission-mode","permissionMode":"default"})],
            NOW - 1_000,
        );
        assert!(scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None).is_empty());
    }

    #[test]
    fn a_tail_with_no_cwd_falls_back_to_the_head() {
        let projects = temp_dir("headcwd");
        let path = projects.join("-x/s1.jsonl");
        // A cwd-carrying first line, then more than TAIL_BOUND of cwd-less records.
        let filler = json!({"type":"progress","data":"x".repeat(1024)});
        let mut lines = vec![user("hi")];
        lines.extend(std::iter::repeat_n(
            filler,
            (TAIL_BOUND / 1024 + 8) as usize,
        ));
        write_jsonl(&path, &lines, NOW - 1_000);
        let agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        assert_eq!(agents[0].folder, "inline");
    }

    #[test]
    fn a_root_older_than_the_horizon_is_not_opened_even_with_a_fresh_sidecar() {
        let projects = temp_dir("horizon");
        write_jsonl(
            &projects.join("-x/s1.jsonl"),
            &[user("old")],
            NOW - 2 * SESSION_HORIZON_MS,
        );
        write_jsonl(
            &projects.join("-x/s1/subagents/agent-a.jsonl"),
            &[user("new")],
            NOW - 1_000,
        );
        assert!(scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None).is_empty());
    }

    #[test]
    fn subagent_status_follows_the_parents_evidence() {
        let projects = temp_dir("evidence");
        let sid = "s1";
        let notif = |id: &str, status: &str| {
            json!({"type":"queue-operation","operation":"enqueue","content":format!(
                "<task-notification>\n<task-id>{id}</task-id>\n<status>{status}</status>\n</task-notification>")})
        };
        write_jsonl(
            &projects.join(format!("-x/{sid}.jsonl")),
            &[
                user("go"),
                tool_use("tu_fg", "Agent"),
                tool_result("tu_fg", true),
                tool_use("tu_bg", "Agent"),
                tool_result("tu_bg", false),
                notif("failed1", "failed"),
                notif("killed1", "killed"),
            ],
            NOW - 1_000,
        );
        let subs = projects.join(format!("-x/{sid}/subagents"));
        for (id, shape, tu) in [
            ("fgerr", "foreground", "tu_fg"),
            ("bgrun", "background", "tu_bg"),
            ("failed1", "background", "tu_x"),
            ("killed1", "background", "tu_y"),
        ] {
            write_jsonl(
                &subs.join(format!("agent-{id}.jsonl")),
                &[user("work"), tool_use("t9", "Bash")],
                NOW - 1_000,
            );
            std::fs::write(
                subs.join(format!("agent-{id}.meta.json")),
                json!({"agentType": id, "toolUseId": tu, "requestShape": shape}).to_string(),
            )
            .unwrap();
        }
        let agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        // A foreground launch whose result came back as an error failed.
        assert_eq!(by_title(&agents, "fgerr").activity, ExternalActivity::Error);
        // A background launch answers at once — that result says nothing about the end.
        assert_eq!(
            by_title(&agents, "bgrun").activity,
            ExternalActivity::Running
        );
        assert_eq!(by_title(&agents, "bgrun").tool.as_deref(), Some("Bash"));
        assert_eq!(
            by_title(&agents, "failed1").activity,
            ExternalActivity::Error
        );
        assert_eq!(
            by_title(&agents, "killed1").activity,
            ExternalActivity::Done
        );
    }

    /// One background sub-agent `a1` of session `s1`, mid-`Bash`, written NOW − 1 s:
    /// the parent's tail holds `parent`, the sidecar `meta`, and the sub-agent's own
    /// tail ends with a record stamped `last_at`.
    fn background_sub(
        tag: &str,
        parent: &[serde_json::Value],
        meta: serde_json::Value,
        last_at: &str,
    ) -> Vec<ExternalAgentWire> {
        let projects = temp_dir(tag);
        let mut root = vec![
            user("go"),
            tool_use("tu_a1", "Agent"),
            tool_result("tu_a1", false),
        ];
        root.extend_from_slice(parent);
        write_jsonl(&projects.join("-x/s1.jsonl"), &root, NOW - 1_000);
        let subs = projects.join("-x/s1/subagents");
        let mut working = tool_use("t9", "Bash");
        working["timestamp"] = json!(last_at);
        write_jsonl(
            &subs.join("agent-a1.jsonl"),
            &[user("work"), working],
            NOW - 1_000,
        );
        std::fs::write(subs.join("agent-a1.meta.json"), meta.to_string()).unwrap();
        scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None)
    }

    fn bg_meta(finished: Option<bool>) -> serde_json::Value {
        let mut m = json!({"agentType":"bg","toolUseId":"tu_a1","requestShape":"background"});
        if let Some(f) = finished {
            m["finished"] = json!(f);
        }
        m
    }

    /// The CLI's `"finished": true` ends a background sub-agent at once — before, its
    /// fresh mid-tool tail kept it `running` for the whole [`SUBAGENT_STALE_MS`].
    #[test]
    fn a_finished_background_subagent_is_done_before_the_stale_window() {
        let at = "2026-10-23T06:41:00.000Z";
        let done = background_sub("fin", &[], bg_meta(Some(true)), at);
        assert_eq!(by_title(&done, "bg").activity, ExternalActivity::Done);
        // Two-sided: the same sub-agent without the flag (or with it false) is working.
        for meta in [bg_meta(None), bg_meta(Some(false))] {
            let live = background_sub("unfin", &[], meta, at);
            assert_eq!(by_title(&live, "bg").activity, ExternalActivity::Running);
            assert_eq!(by_title(&live, "bg").tool.as_deref(), Some("Bash"));
        }
    }

    /// A notification ends the sub-agent only if it has not written past it: a
    /// `SendMessage` resumes a stopped agent, and the old notification stays in the
    /// parent's tail.
    #[test]
    fn a_background_subagent_resumed_after_its_notification_is_working_again() {
        let notified = json!({"type":"queue-operation","operation":"enqueue",
            "timestamp":"2026-10-23T06:41:01.892Z",
            "content":"<task-notification><task-id>a1</task-id><status>completed</status></task-notification>"});
        let parent = [notified];
        // Its last record 12 ms before the stop: ended.
        let ended = background_sub("stop", &parent, bg_meta(None), "2026-10-23T06:41:01.880Z");
        assert_eq!(by_title(&ended, "bg").activity, ExternalActivity::Done);
        // The same millisecond is not past it.
        let same = background_sub("same", &parent, bg_meta(None), "2026-10-23T06:41:01.892Z");
        assert_eq!(by_title(&same, "bg").activity, ExternalActivity::Done);
        // 8 ms after it — a measured real resume gap: working again.
        let resumed = background_sub("resume", &parent, bg_meta(None), "2026-10-23T06:41:01.900Z");
        assert_eq!(by_title(&resumed, "bg").activity, ExternalActivity::Running);
        assert_eq!(by_title(&resumed, "bg").tool.as_deref(), Some("Bash"));
    }

    #[test]
    fn a_subagent_whose_own_tail_errored_is_an_error() {
        let projects = temp_dir("suberr");
        write_jsonl(&projects.join("-x/s1.jsonl"), &[user("go")], NOW - 1_000);
        write_jsonl(
            &projects.join("-x/s1/subagents/agent-e.jsonl"),
            &[json!({"type":"system","subtype":"api_error"})],
            NOW - 1_000,
        );
        let agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        assert_eq!(agents[1].activity, ExternalActivity::Error);
    }

    #[test]
    fn a_meta_that_is_garbage_or_names_an_unlisted_parent_falls_back_to_the_session() {
        let projects = temp_dir("meta");
        write_jsonl(&projects.join("-x/s1.jsonl"), &[user("go")], NOW - 1_000);
        let subs = projects.join("-x/s1/subagents");
        write_jsonl(&subs.join("agent-g.jsonl"), &[user("w")], NOW - 1_000);
        std::fs::write(subs.join("agent-g.meta.json"), "not json").unwrap();
        write_jsonl(&subs.join("agent-o.jsonl"), &[user("w")], NOW - 1_000);
        std::fs::write(
            subs.join("agent-o.meta.json"),
            json!({"agentType":"orphan","parentAgentId":"gone"}).to_string(),
        )
        .unwrap();
        let agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        let root_key = agents[0].key.clone();
        assert_eq!(
            by_title(&agents, "agent").parent_key.as_ref(),
            Some(&root_key)
        );
        assert_eq!(
            by_title(&agents, "orphan").parent_key.as_ref(),
            Some(&root_key)
        );
        assert_eq!(SubMeta::read(Path::new("/")).agent_type, None);
    }

    #[test]
    fn workflow_sidecars_are_found_too() {
        let projects = temp_dir("wf");
        write_jsonl(&projects.join("-x/s1.jsonl"), &[user("go")], NOW - 1_000);
        write_jsonl(
            &projects.join("-x/s1/subagents/workflows/wf_run1/agent-w1.jsonl"),
            &[user("refactor"), tool_use("t", "Write")],
            NOW - 1_000,
        );
        let agents = scan_external(&projects, NOW, TEN_MIN, &HashSet::new(), None);
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[1].tool.as_deref(), Some("Write"));
    }

    // ── the status machine ───────────────────────────────────────────────────

    #[test]
    fn a_pending_writing_tool_reads_as_waiting_only_after_the_silence() {
        let f = facts_of(&[user("go"), tool_use("t1", "Edit")]);
        assert_eq!(
            derive(&f, PERMISSION_SILENCE_MS - 1),
            (ExternalActivity::Running, Some("Edit".into()))
        );
        assert_eq!(
            derive(&f, PERMISSION_SILENCE_MS),
            (ExternalActivity::Waiting, Some("Edit".into()))
        );
    }

    #[test]
    fn read_only_tools_and_subagent_launches_never_read_as_waiting() {
        for tool in ["Read", "Grep", "Agent", "Task", "Workflow", "WebSearch"] {
            let f = facts_of(&[user("go"), tool_use("t1", tool)]);
            assert_eq!(derive(&f, 3_600_000).0, ExternalActivity::Running, "{tool}");
        }
    }

    #[test]
    fn a_question_to_the_user_is_waiting_at_once() {
        let f = facts_of(&[user("go"), tool_use("t1", "ExitPlanMode")]);
        assert_eq!(derive(&f, 0).0, ExternalActivity::Waiting);
    }

    #[test]
    fn an_answered_tool_means_thinking_and_its_result_is_remembered() {
        let f = facts_of(&[user("go"), tool_use("t1", "Bash"), tool_result("t1", true)]);
        assert_eq!(derive(&f, 60_000), (ExternalActivity::Running, None));
        assert_eq!(f.tool_results.get("t1"), Some(&true));
    }

    #[test]
    fn turn_ends_read_as_idle() {
        let text = |stop: serde_json::Value| {
            json!({"type":"assistant","message":{"role":"assistant","stop_reason":stop,
                   "content":[{"type":"text","text":"ok"}]}})
        };
        let ended = facts_of(&[user("go"), text(json!("end_turn"))]);
        assert_eq!(derive(&ended, 0).0, ExternalActivity::Idle);
        // A text reply with no stop reason: running until TEXT_IDLE_MS of silence.
        let streaming = facts_of(&[user("go"), text(serde_json::Value::Null)]);
        assert_eq!(
            derive(&streaming, TEXT_IDLE_MS - 1).0,
            ExternalActivity::Running
        );
        assert_eq!(derive(&streaming, TEXT_IDLE_MS).0, ExternalActivity::Idle);
        // A string-content reply counts as text too.
        let s = facts_of(&[json!({"type":"assistant","message":{"content":"hi"}})]);
        assert_eq!(s.turn, Turn::TextReply);
        let blank = facts_of(&[json!({"type":"assistant","message":{"content":"  "}})]);
        assert_eq!(blank.turn, Turn::Running, "no text, no tool: thinking");
        let sys = facts_of(&[
            tool_use("t", "Edit"),
            json!({"type":"system","subtype":"turn_duration"}),
        ]);
        assert_eq!(derive(&sys, 0), (ExternalActivity::Idle, None));
        let interrupted = facts_of(&[
            tool_use("t", "Edit"),
            json!({"type":"user","message":{"role":"user","content":[
                {"type":"text","text":"[Request interrupted by user for tool use]"}]}}),
        ]);
        assert_eq!(derive(&interrupted, 0).0, ExternalActivity::Idle);
        assert_eq!(derive(&TailFacts::default(), 0).0, ExternalActivity::Idle);
    }

    #[test]
    fn api_errors_read_as_error() {
        let a = facts_of(&[json!({"type":"assistant","isApiErrorMessage":true,
                                  "message":{"content":[{"type":"text","text":"API Error"}]}})]);
        assert_eq!(derive(&a, 0).0, ExternalActivity::Error);
        let s = facts_of(&[json!({"type":"system","subtype":"api_error"})]);
        assert_eq!(derive(&s, 0).0, ExternalActivity::Error);
        let other = facts_of(&[json!({"type":"system","subtype":"informational"})]);
        assert_eq!(other.turn, Turn::Unknown);
    }

    #[test]
    fn meta_user_lines_and_garbage_change_nothing() {
        let f = facts_of(&[
            tool_use("t", "Edit"),
            json!({"type":"user","isMeta":true,"message":{"content":"caveat"}}),
            json!({"type":"user","message":{"content":42}}),
        ]);
        let mut g = f;
        absorb(&mut g, "{ torn");
        assert_eq!(g.turn, Turn::Running);
        assert_eq!(g.pending.len(), 1);
    }

    #[test]
    fn labels_take_the_last_nonblank_value() {
        let f = facts_of(&[
            json!({"type":"x","cwd":"/a","gitBranch":"b1","slug":"s1"}),
            json!({"type":"x","cwd":"","gitBranch":"  ","slug":null}),
            json!({"type":"x","cwd":"/c","gitBranch":"b2"}),
        ]);
        assert_eq!(f.cwd.as_deref(), Some("/c"));
        assert_eq!(f.branch.as_deref(), Some("b2"));
        assert_eq!(f.slug.as_deref(), Some("s1"));
    }

    /// The block parser itself is `claude.rs`'s (shared with the fan-out); this pins
    /// that the tail feeds it — even from a line that is not JSON, which then has no
    /// stamp — and that a stamped line stamps its notifications and the tail's clock.
    #[test]
    fn the_tail_folds_task_notifications_and_the_newest_stamp() {
        let line = "x<task-notification><task-id> a1 </task-id><status>completed</status>\
                    </task-notification><task-notification><task-id>a2</task-id>\
                    </task-notification><task-notification><task-id>a3</task-id>\
                    <status>failed</status></task-notification>";
        let mut f = TailFacts::default();
        absorb(&mut f, line);
        let end = |f: &TailFacts, id: &str| f.task_ends.latest(id);
        assert_eq!(end(&f, "a1").map(|e| (e.at, e.failed)), Some((None, false)));
        assert_eq!(end(&f, "a2"), None, "no status: not an end");
        assert_eq!(end(&f, "a3").map(|e| e.failed), Some(true));
        assert_eq!(f.last_write, None, "a non-JSON line stamps nothing");

        let stamped = json!({"type":"queue-operation","operation":"enqueue",
            "timestamp":"2026-10-23T06:41:01.892Z",
            "content":"<task-notification><task-id>b1</task-id><status>killed</status></task-notification>"});
        let later = json!({"type":"user","timestamp":"2026-10-23T06:41:07.577Z",
            "message":{"role":"user","content":"more"}});
        absorb(&mut f, &stamped.to_string());
        absorb(&mut f, &later.to_string());
        absorb(
            &mut f,
            &json!({"type":"user","message":{"content":"unstamped"}}).to_string(),
        );
        assert_eq!(end(&f, "b1").and_then(|e| e.at), Some(1_792_737_661_892));
        assert_eq!(
            f.last_write,
            Some(1_792_737_667_577),
            "the newest stamp, kept"
        );
    }

    // ── the bounded tail ─────────────────────────────────────────────────────

    #[test]
    fn the_tail_drops_a_line_cut_by_the_bound() {
        let dir = temp_dir("tail");
        let p = dir.join("t.jsonl");
        std::fs::write(&p, "first line\nsecond\nthird\n").unwrap();
        assert_eq!(tail_lines(&p, 1024), vec!["first line", "second", "third"]);
        // 13 bytes from the end = "econd\nthird\n" → the cut "econd" is dropped.
        assert_eq!(tail_lines(&p, 12), vec!["third"]);
        // A bound inside a single line: nothing whole.
        std::fs::write(&p, "a-very-long-line-with-no-newline").unwrap();
        assert!(tail_lines(&p, 4).is_empty());
        assert!(tail_lines(&dir.join("missing"), 4).is_empty());
        // A directory opens on unix but cannot be read.
        assert!(tail_lines(&dir, 4).is_empty());
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    #[test]
    fn the_window_defaults_and_clamps() {
        assert_eq!(window_ms(None), 10 * 60_000);
        assert_eq!(window_ms(Some(0)), 60_000);
        assert_eq!(window_ms(Some(30)), 30 * 60_000);
        assert_eq!(
            window_ms(Some(u32::MAX)),
            u64::from(MAX_WINDOW_MINS) * 60_000
        );
    }

    #[test]
    fn path_helpers() {
        assert_eq!(basename("/work/alpha"), "alpha");
        assert_eq!(basename("/"), "/");
        let gone = Path::new("/definitely/not/here");
        assert_eq!(canonical(gone), gone);
        assert_eq!(
            file_mtime_ms(&std::env::temp_dir()),
            None,
            "a dir is not a file"
        );
        assert_eq!(head_cwd(gone), None);
        assert_eq!(finished(false), ExternalActivity::Done);
        assert_eq!(finished(true), ExternalActivity::Error);
        assert!(now_ms() > 1_700_000_000_000);
    }

    #[test]
    fn the_process_probe_answers_exactly_where_the_os_can() {
        // Reads the process table only (never ~/.claude): `None` iff the OS has none.
        assert_eq!(live_claudes().is_some(), crate::procscan::os::AVAILABLE);
    }

    /// The real thing: this machine's `~/.claude`, read through the command's own path
    /// (`home_dir()`, `spawn_blocking`, the live process probe). Invariants only — the
    /// set of agents changes by the second. Registered in `scripts/verify.mjs`
    /// LOCAL_INTEGRATION.
    #[test]
    #[ignore = "reads the real ~/.claude — run with --ignored"]
    fn live_external_agents_scan_the_real_home() {
        const WINDOW: u64 = 60 * 60_000;
        let projects = crate::agent::claude::home_dir()
            .expect("a home")
            .join(".claude")
            .join("projects");
        // Independent expectations, taken BEFORE the scan from the process table and
        // `stat` alone (no claim logic): the live `claude`s, and those of them that are
        // bare and have a root transcript in their folder written in the window and
        // since they started — each of those must surface as SOME root. Without them
        // every check below is a `for` over a possibly empty list.
        let live = live_claudes();
        // The `due` check below only means something when a live cwd can reach the CLI's
        // project dir. On Windows a verbatim `\\?\C:\…` cwd maps to `----C--…`, matches
        // nothing, and every check below passes over an empty list. So:
        // no cwd is verbatim, and — on Windows — some live
        // `claude` (the one running this test, at least) has its project dir on disk.
        if let Some(live) = &live {
            for p in live {
                assert!(
                    !p.cwd.to_string_lossy().starts_with(r"\\?\"),
                    "a verbatim cwd never matches a project dir: {:?}",
                    p.cwd
                );
            }
            if cfg!(windows) && !live.is_empty() {
                let dirs: Vec<String> = std::fs::read_dir(&projects)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .collect();
                let wanted: Vec<String> = live.iter().map(|p| project_dir_name(&p.cwd)).collect();
                assert!(
                    wanted
                        .iter()
                        .any(|w| dirs.iter().any(|d| same_project_dir(d, w, true))),
                    "no live claude's cwd maps to a project dir under ~/.claude/projects \
                     ({} live, wanted {wanted:?})",
                    live.len()
                );
            }
        }
        let due: Vec<&LiveClaude> = live
            .iter()
            .flatten()
            .filter(|p| matches!(claim_of(&p.argv, p.started_ms), Claim::Bare { .. }))
            .filter(|p| {
                let floor = p.started_ms.unwrap_or(0).saturating_sub(CLAIM_SLACK_MS);
                let cutoff = now_ms().saturating_sub(WINDOW - 5 * 60_000);
                std::fs::read_dir(projects.join(project_dir_name(&p.cwd)))
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|f| f.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                    .filter_map(|p| file_mtime_ms(&p))
                    .any(|m| m >= floor && m >= cutoff)
            })
            .collect();

        let report = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(external_agents_report(HashSet::new(), Some(60)))
            .expect("the scan must succeed on a machine with a home");
        assert!(report.scanned_at_ms > 0);
        let keys: HashSet<&str> = report.agents.iter().map(|a| a.key.as_str()).collect();
        assert_eq!(keys.len(), report.agents.len(), "keys are unique");
        let roots: Vec<&ExternalAgentWire> = report
            .agents
            .iter()
            .filter(|a| a.parent_key.is_none())
            .collect();
        for a in &report.agents {
            assert_eq!(a.key.len(), 16, "an opaque hex key, never a session id");
            assert!(!a.folder.contains('/'), "a basename, got {}", a.folder);
            assert!(
                a.host.as_deref().is_none_or(|h| !h.contains('/')),
                "a name, not a path"
            );
            assert!(
                a.language
                    .as_deref()
                    .is_none_or(|l| language::table().values().any(|v| v == l)),
                "a language id from the shared table, got {:?}",
                a.language
            );
            assert!(a.last_activity_ms + WINDOW >= report.scanned_at_ms - 1_000);
            if let Some(p) = &a.parent_key {
                assert!(keys.contains(p.as_str()), "a parent that is listed");
            }
            // Per-session liveness: everything reported is claimed by a live process.
            let want = crate::procscan::os::AVAILABLE.then_some(true);
            assert_eq!(a.alive, want, "{} / {}", a.folder, a.title);
        }
        if let Some(live) = &live {
            // Each root is claimed by a DIFFERENT live `claude`.
            assert!(
                roots.len() <= live.len(),
                "{} sessions reported for {} live claude processes",
                roots.len(),
                live.len()
            );
            if !due.is_empty() {
                assert!(
                    !roots.is_empty(),
                    "{} bare claude(s) with a fresh session in their folder, no root reported",
                    due.len()
                );
            }
            // Every host the scan named was cached for focusing.
            for a in report.agents.iter().filter(|a| a.host.is_some()) {
                assert_eq!(
                    HostCache::global().get(&a.key).map(|h| h.name),
                    a.host.clone()
                );
            }
        }
        eprintln!(
            "external agents in the last hour: {} ({} sessions; {} live claude processes, {} bare with a fresh session); {:?}",
            report.agents.len(),
            roots.len(),
            live.as_ref().map_or(0, Vec::len),
            due.len(),
            report
                .agents
                .iter()
                .map(|a| (&a.folder, &a.title, a.activity, &a.tool, a.alive, &a.host, &a.language, a.parent_key.is_some()))
                .collect::<Vec<_>>()
        );
    }
}
