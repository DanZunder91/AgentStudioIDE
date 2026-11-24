//! System-app log source for the Agent Logs view — macOS unified log / Linux journald /
//! Windows Event Log
//! (with many apps running, the view must filter by app or show them all).
//!
//! # Shape
//!
//! ```text
//!  syslog_set(filter) ──► Syslog: persist prefs, stop old stream(s), start new
//!                              │
//!        /usr/bin/log stream --style ndjson [--level] [--predicate]   (macOS)
//!        journalctl --follow --output=json --lines=0 [_COMM=…]        (Linux)
//!        xcrun simctl spawn booted log stream …   (macOS, ONLY when the user ticks it)
//!                              │ stdout lines
//!                              ▼ parse (pure: macos.rs / journal.rs)
//!        EvtSubscribe(QueryList: Application + System [+ one channel])   (Windows,
//!                              │ rendered event XML        no child process: winevt.rs)
//!                              ▼ parse (pure: eventlog.rs) + EvtFormatMessage
//!                        LogHub::push(LineDraft{kind: Machine})  ← rate cap 500/s lives there
//! ```
//!
//! Everything that decides something — argv/predicate/XPath building, line and event-XML
//! parsing, level mapping, process/provider grouping, journal-access reasoning — is a pure
//! function compiled and tested on **every** OS (the Linux parser is tested on the Mac, the
//! Windows one on both). Only the thin "which binary exists / list processes / call the
//! Event Log" glue is `cfg`-gated. Every stream — child or subscription — shares one
//! lifecycle (`stream.rs`): drop = stop, a death says why.
//!
//! # Rules this module keeps
//!
//! - **Zero-install, no OS permission**: only built-in tools at
//!   absolute paths, spawned directly — never a shell, never a login shell.
//!   On Windows, the Event Log API in-process: no child, and only channels a standard user
//!   can read (`Application`, `System`) unless the user names another.
//!   A missing tool is `available: false` with a reason, never a crash.
//! - **Never `simctl` to detect** (a vendor-tool probe can install things): a simulator
//!   is "booted" iff a `launchd_sim` process exists. `xcrun simctl` runs only after the
//!   user enables it.
//! - **Never block the hub**: lines go in through `LogHub::push` (a `try_send`).

pub mod child;
pub mod eventlog;
pub mod journal;
pub mod macos;
pub mod prefs;
pub mod procs;
pub mod stream;
#[cfg(windows)]
pub mod winevt;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Deserializer, Serialize};

use crate::logstream::{LineDraft, LogHub};

pub use procs::RunningApp;
pub use stream::Running;

/// Shown on an OS with none of the three backends, in place of the control.
pub const UNSUPPORTED_REASON: &str = "System app logs aren't supported on this operating system.";
/// Simulator reason when no `launchd_sim` process exists.
pub const NO_SIMULATOR_REASON: &str = "No iOS Simulator is booted.";
/// Simulator reason off macOS.
pub const SIMULATOR_MACOS_ONLY: &str = "The iOS Simulator is only available on macOS.";

/// The OS level floor. `default` is macOS's own default level (hides debug/info noise).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyslogLevel {
    Debug,
    Info,
    #[default]
    Default,
    Error,
}

/// Wire contract `SyslogFilter` (serde camelCase). Also the on-disk prefs. Every field
/// defaults independently (`#[serde(default)]`): an old or hand-edited file loses nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyslogFilter {
    /// The "System apps" source. Default off — high volume, opt-in.
    pub enabled: bool,
    /// Process names (Windows: Event Log provider names — the "Source" column); `None` = ALL
    /// apps. `Some([])` = none selected (nothing streams).
    pub apps: Option<Vec<String>>,
    /// macOS subsystem prefix (`com.example.demo`); Linux: a systemd unit; Windows: one extra
    /// channel to read besides Application and System.
    pub subsystem: Option<String>,
    #[serde(deserialize_with = "lenient_level")]
    pub min_level: SyslogLevel,
    /// macOS only: also stream the booted iOS Simulator.
    pub simulator: bool,
    /// `None` = all simulator processes.
    pub simulator_apps: Option<Vec<String>>,
}

/// An unknown level string (a future build's) degrades to the default, not the whole file.
fn lenient_level<'de, D: Deserializer<'de>>(d: D) -> Result<SyslogLevel, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

impl SyslogFilter {
    /// Trim names, drop empties and duplicates, blank subsystem → `None`.
    pub fn normalized(mut self) -> Self {
        fn clean(list: Option<Vec<String>>) -> Option<Vec<String>> {
            list.map(|v| {
                let mut out: Vec<String> = Vec::new();
                for s in v {
                    let s = s.trim().to_string();
                    if !s.is_empty() && !out.contains(&s) {
                        out.push(s);
                    }
                }
                out
            })
        }
        self.apps = clean(self.apps);
        self.simulator_apps = clean(self.simulator_apps);
        self.subsystem = self
            .subsystem
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorStatus {
    pub available: bool,
    pub reason: Option<String>,
    pub running: bool,
}

/// Wire contract `SyslogStatus` (serde camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyslogStatus {
    pub available: bool,
    /// `"macos-unified-log"` | `"linux-journald"` | `"windows-eventlog"` | `null`.
    pub backend: Option<String>,
    /// Why unavailable, why partial, or why the stream last stopped.
    pub reason: Option<String>,
    pub running: bool,
    pub filter: SyslogFilter,
    pub simulator: SimulatorStatus,
    pub lines_per_sec: u32,
    pub dropped_per_sec: u32,
}

/// What this OS can do. Built by the `cfg`-gated [`detect_backend`]; everything
/// downstream of it is platform-neutral.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backend {
    pub available: bool,
    pub name: Option<&'static str>,
    /// Unavailable, or partial (e.g. "only your own journal").
    pub reason: Option<String>,
    pub program: Option<PathBuf>,
    pub kind: BackendKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    MacosUnifiedLog,
    LinuxJournald,
    /// In-process `EvtSubscribe` — no `program`.
    WindowsEventLog,
    None,
}

/// The one constructor for "this feature does not work here". Platform-neutral so it is
/// tested on every OS; the non-macOS/non-Linux build calls nothing else.
pub fn unavailable(reason: &str) -> Backend {
    Backend {
        available: false,
        name: None,
        reason: Some(reason.to_string()),
        program: None,
        kind: BackendKind::None,
    }
}

#[cfg(target_os = "macos")]
fn detect_backend() -> Backend {
    let p = PathBuf::from(macos::LOG_BIN);
    if p.exists() {
        Backend {
            available: true,
            name: Some("macos-unified-log"),
            reason: None,
            program: Some(p),
            kind: BackendKind::MacosUnifiedLog,
        }
    } else {
        unavailable("/usr/bin/log was not found, so system app logs can't be read.")
    }
}

#[cfg(target_os = "linux")]
fn detect_backend() -> Backend {
    let program = journal::JOURNALCTL_PATHS
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists());
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let groups = std::fs::read_to_string("/etc/group").unwrap_or_default();
    journal::linux_backend(
        program,
        std::path::Path::new(journal::JOURNALD_RUNTIME_DIR).is_dir(),
        &status,
        &groups,
    )
}

/// The Event Log service and `wevtapi.dll` ship with every supported Windows; a failure to
/// subscribe surfaces as the stream's exit reason, never as a crash.
#[cfg(windows)]
fn detect_backend() -> Backend {
    eventlog::backend()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn detect_backend() -> Backend {
    unavailable(UNSUPPORTED_REASON)
}

/// Passive simulator detection: a `launchd_sim` process ⇒ booted. Never
/// runs `simctl`/`xcrun`.
#[cfg(target_os = "macos")]
fn detect_simulator() -> (bool, Option<String>) {
    if procs::simulator_booted(&procs::list_processes()) {
        (true, None)
    } else {
        (false, Some(NO_SIMULATOR_REASON.to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_simulator() -> (bool, Option<String>) {
    (false, Some(SIMULATOR_MACOS_ONLY.to_string()))
}

struct State {
    filter: SyslogFilter,
    main: Option<Running>,
    sim: Option<Running>,
}

/// How the main stream starts for a filter on a backend — decided purely, so every OS tests
/// every backend's plan.
pub enum Plan {
    /// A supervised child and the parser its stdout goes through (macOS, Linux).
    Child(child::ChildSpec, Parser),
    /// An Event Log subscription over this structured query (Windows).
    EventLog(String),
}

impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Plan::Child(spec, _) => f
                .debug_tuple("Child")
                .field(&spec.program)
                .field(&spec.args)
                .finish(),
            Plan::EventLog(q) => f.debug_tuple("EventLog").field(q).finish(),
        }
    }
}

/// The main stream's plan; `None` = nothing streams (off, no backend, none selected).
pub fn main_plan(backend: &Backend, f: &SyslogFilter) -> Option<Plan> {
    if !f.enabled || !backend.available {
        return None;
    }
    if f.apps.as_ref().is_some_and(|a| a.is_empty()) {
        return None; // "none selected" — nothing to stream
    }
    match backend.kind {
        BackendKind::MacosUnifiedLog => Some(Plan::Child(
            child::ChildSpec {
                program: backend.program.clone()?,
                args: macos::log_args(f),
                label: "System apps",
            },
            Arc::new(|l: &str| macos::parse_ndjson(l, false)),
        )),
        BackendKind::LinuxJournald => Some(Plan::Child(
            child::ChildSpec {
                program: backend.program.clone()?,
                args: journal::journal_args(f),
                label: "System apps",
            },
            Arc::new(journal::parse_journal),
        )),
        BackendKind::WindowsEventLog => eventlog::query_list(f).map(Plan::EventLog),
        BackendKind::None => None,
    }
}

/// The system-app log source. Register as Tauri managed state.
pub struct Syslog {
    hub: LogHub,
    rt: tokio::runtime::Handle,
    prefs_path: Option<PathBuf>,
    backend: Backend,
    state: Mutex<State>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The `LineDraft` parser a child's stdout goes through.
pub type Parser = Arc<dyn Fn(&str) -> Option<LineDraft> + Send + Sync>;

impl Syslog {
    /// Build with an explicit backend (tests inject one) and load the prefs. Starts
    /// nothing: call [`Syslog::start_from_prefs`].
    pub fn with_backend(
        hub: LogHub,
        rt: tokio::runtime::Handle,
        prefs_path: Option<PathBuf>,
        backend: Backend,
    ) -> Self {
        let filter = prefs_path
            .as_deref()
            .map(prefs::load)
            .unwrap_or_default()
            .normalized();
        Self {
            hub,
            rt,
            prefs_path,
            backend,
            state: Mutex::new(State {
                filter,
                main: None,
                sim: None,
            }),
        }
    }

    /// The real OS backend.
    pub fn new(hub: LogHub, rt: tokio::runtime::Handle, prefs_path: Option<PathBuf>) -> Self {
        Self::with_backend(hub, rt, prefs_path, detect_backend())
    }

    /// On app start: resume what the prefs say (nothing, by default).
    pub fn start_from_prefs(&self) {
        let filter = lock(&self.state).filter.clone();
        if filter.enabled || filter.simulator {
            self.apply(filter, false);
        }
    }

    /// `syslog_set`: persist, then atomically replace the running child(ren).
    pub fn set(&self, filter: SyslogFilter) -> SyslogStatus {
        self.apply(filter.normalized(), true);
        self.status()
    }

    fn apply(&self, filter: SyslogFilter, persist: bool) {
        if persist {
            if let Some(p) = &self.prefs_path {
                if let Err(e) = prefs::save(p, &filter) {
                    eprintln!("syslog: could not save prefs: {e}");
                }
            }
        }
        let main_plan = main_plan(&self.backend, &filter);
        let sim_spec = if filter.simulator && detect_simulator().0 {
            Some(child::ChildSpec {
                program: PathBuf::from(macos::XCRUN_BIN),
                args: macos::sim_args(&filter),
                label: "iOS Simulator",
            })
        } else {
            None
        };
        let mut st = lock(&self.state);
        // Dropping a `Running` stops its source: kills the child (kill_on_drop), or signals
        // and joins the Event Log thread.
        st.main = None;
        st.sim = None;
        let channels = eventlog::channels(filter.subsystem.as_deref());
        st.filter = filter;
        st.main = main_plan.map(|plan| match plan {
            Plan::Child(spec, parser) => self.spawn(spec, parser),
            Plan::EventLog(query) => self.subscribe(query, &channels),
        });
        if let Some(spec) = sim_spec {
            let parser: Parser = Arc::new(|l: &str| macos::parse_ndjson(l, true));
            st.sim = Some(self.spawn(spec, parser));
        }
    }

    fn spawn(&self, spec: child::ChildSpec, parser: Parser) -> Running {
        child::spawn(&self.rt, spec, parser, self.hub.clone())
    }

    #[cfg(windows)]
    fn subscribe(&self, query: String, channels: &[String]) -> Running {
        winevt::subscribe(query, channels, self.hub.clone())
    }

    /// Only an injected Windows backend gets here off Windows: a dead stream that says so.
    #[cfg(not(windows))]
    fn subscribe(&self, _query: String, _channels: &[String]) -> Running {
        Running::failed(&self.hub, eventlog::OFF_WINDOWS.to_string())
    }

    /// The Event Log channels `syslog_apps` lists providers from: `Application`, `System` and
    /// the extra channel the user typed in the subsystem box — the same channels the stream
    /// reads ([`eventlog::channels`]), so the picker offers what the stream can show. (Off
    /// Windows the subsystem is not a channel and [`list_apps`] ignores this.)
    pub fn apps_channels(&self) -> Vec<String> {
        eventlog::channels(lock(&self.state).filter.subsystem.as_deref())
    }

    /// `syslog_status`.
    pub fn status(&self) -> SyslogStatus {
        let (sim_available, sim_reason) = detect_simulator();
        let st = lock(&self.state);
        let (lines, dropped) = self.hub.machine_rates();
        status_of(
            &self.backend,
            &st.filter,
            st.main.as_ref(),
            (sim_available, sim_reason),
            st.sim.as_ref(),
            (lines, dropped),
        )
    }
}

/// Assemble a status (pure over its inputs). Public so the contract goldens
/// (`tests/contract_goldens/machine.rs`) can build every wire state OS-independently:
/// [`Syslog::status`] reads the simulator passively from THIS machine's process list,
/// which a golden must not depend on.
pub fn status_of(
    backend: &Backend,
    filter: &SyslogFilter,
    main: Option<&Running>,
    sim: (bool, Option<String>),
    sim_run: Option<&Running>,
    rates: (u32, u32),
) -> SyslogStatus {
    let running = main.is_some_and(|r| r.is_alive());
    // A stream that died says why, ahead of a standing "partial" reason.
    let reason = main
        .filter(|r| !r.is_alive())
        .and_then(|r| r.exit_reason())
        .or_else(|| backend.reason.clone());
    let sim_running = sim_run.is_some_and(|r| r.is_alive());
    let sim_reason = sim_run
        .filter(|r| !r.is_alive())
        .and_then(|r| r.exit_reason())
        .or(sim.1);
    SyslogStatus {
        available: backend.available,
        backend: backend.name.map(str::to_string),
        reason,
        running,
        filter: filter.clone(),
        simulator: SimulatorStatus {
            available: sim.0,
            reason: sim_reason,
            running: sim_running,
        },
        lines_per_sec: rates.0,
        dropped_per_sec: rates.1,
    }
}

/// Build, manage, and resume from prefs — the whole of `lib.rs`'s setup for this module.
pub fn setup(app: &tauri::AppHandle, hub: LogHub) {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("syslog").join(prefs::FILE_NAME));
    let rt = tauri::async_runtime::handle().inner().clone();
    let syslog = Syslog::new(hub, rt, dir);
    syslog.start_from_prefs();
    app.manage(syslog);
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/// `syslog_status` → [`SyslogStatus`].
#[tauri::command]
pub fn syslog_status(syslog: tauri::State<'_, Syslog>) -> SyslogStatus {
    syslog.status()
}

/// `syslog_set { filter }` → [`SyslogStatus`] after (re)starting/stopping the stream.
#[tauri::command]
pub fn syslog_set(syslog: tauri::State<'_, Syslog>, filter: SyslogFilter) -> SyslogStatus {
    syslog.set(filter)
}

/// `syslog_apps` → running processes grouped by name, apps first (Windows: the Event Log
/// providers that recently wrote to Application, System and the extra channel in the filter —
/// [`Syslog::apps_channels`]). Off the main thread. The wire is unchanged: the channel comes
/// from the managed state, never from the webview.
#[tauri::command]
pub async fn syslog_apps(syslog: tauri::State<'_, Syslog>) -> Result<Vec<RunningApp>, String> {
    let channels = syslog.apps_channels();
    Ok(
        tauri::async_runtime::spawn_blocking(move || list_apps(&channels))
            .await
            .unwrap_or_default(),
    )
}

#[cfg(windows)]
fn list_apps(channels: &[String]) -> Vec<RunningApp> {
    winevt::recent_providers(channels)
}

#[cfg(not(windows))]
fn list_apps(_channels: &[String]) -> Vec<RunningApp> {
    procs::group_apps(procs::list_processes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_is_a_dead_backend_with_its_reason_on_every_os() {
        let b = unavailable(UNSUPPORTED_REASON);
        assert!(!b.available);
        assert_eq!(b.name, None);
        assert_eq!(b.program, None);
        let s = status_of(
            &b,
            &SyslogFilter::default(),
            None,
            (false, Some(SIMULATOR_MACOS_ONLY.into())),
            None,
            (0, 0),
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["available"], false);
        assert_eq!(v["backend"], serde_json::Value::Null);
        assert_eq!(
            v["reason"],
            "System app logs aren't supported on this operating system."
        );
        assert_eq!(v["running"], false);
        assert_eq!(v["simulator"]["available"], false);
        assert_eq!(v["linesPerSec"], 0);
        assert_eq!(v["droppedPerSec"], 0);
    }

    #[test]
    fn this_os_backend_matches_the_platform_matrix() {
        let b = detect_backend();
        if cfg!(target_os = "macos") {
            assert!(b.available, "/usr/bin/log ships with macOS: {b:?}");
            assert_eq!(b.name, Some("macos-unified-log"));
        } else if cfg!(target_os = "linux") {
            // Either journald works here, or it says why not — never a silent false.
            assert!(b.available || b.reason.is_some(), "{b:?}");
        } else if cfg!(windows) {
            assert_eq!(b, eventlog::backend());
            assert_eq!(b.name, Some("windows-eventlog"));
        } else {
            assert_eq!(b, unavailable(UNSUPPORTED_REASON));
        }
    }

    fn picked(apps: Option<&[&str]>) -> SyslogFilter {
        SyslogFilter {
            enabled: true,
            apps: apps.map(|a| a.iter().map(|s| s.to_string()).collect()),
            subsystem: Some("Microsoft-Windows-PowerShell/Operational".into()),
            min_level: SyslogLevel::Error,
            ..Default::default()
        }
    }

    #[test]
    fn an_event_log_backend_plans_a_subscription_never_a_child() {
        let b = eventlog::backend();
        let f = picked(Some(&["MsiInstaller"]));
        match main_plan(&b, &f) {
            Some(Plan::EventLog(q)) => {
                assert_eq!(Some(q.clone()), eventlog::query_list(&f));
                assert!(q.contains("<Select Path=\"Microsoft-Windows-PowerShell/Operational\">"));
                assert!(q.contains("@Name=&apos;MsiInstaller&apos;"), "{q}");
            }
            other => panic!("expected an Event Log plan, got {other:?}"),
        }
        // Off, none selected, only unrepresentable names, or no backend: nothing streams.
        let off = SyslogFilter {
            enabled: false,
            ..picked(None)
        };
        assert!(main_plan(&b, &off).is_none());
        assert!(main_plan(&b, &picked(Some(&[]))).is_none());
        assert!(main_plan(&b, &picked(Some(&["both ' \""]))).is_none());
        assert!(main_plan(&unavailable(UNSUPPORTED_REASON), &picked(None)).is_none());
    }

    #[test]
    fn the_unix_backends_still_plan_their_children() {
        let mac = Backend {
            available: true,
            name: Some("macos-unified-log"),
            reason: None,
            program: Some(PathBuf::from(macos::LOG_BIN)),
            kind: BackendKind::MacosUnifiedLog,
        };
        let f = picked(Some(&["Safari"]));
        match main_plan(&mac, &f) {
            Some(Plan::Child(spec, _)) => {
                assert_eq!(spec.program, PathBuf::from(macos::LOG_BIN));
                assert_eq!(spec.args, macos::log_args(&f));
            }
            other => panic!("expected a child, got {other:?}"),
        }
        let linux = journal::linux_backend(
            Some(PathBuf::from(journal::JOURNALCTL_PATHS[0])),
            true,
            "Uid:\t0\t0\t0\t0\n",
            "",
        );
        match main_plan(&linux, &f) {
            Some(Plan::Child(spec, _)) => assert_eq!(spec.args, journal::journal_args(&f)),
            other => panic!("expected a child, got {other:?}"),
        }
        // A child backend without a program cannot start one.
        let no_program = Backend {
            program: None,
            ..mac
        };
        assert!(main_plan(&no_program, &f).is_none());
    }

    /// The manager over the Event Log backend: off Windows the injected backend yields a dead
    /// stream that says why; on Windows it really subscribes (read-only — nothing is written).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_manager_starts_an_event_log_stream_through_its_plan() {
        let (hub, task) = LogHub::new(Arc::new(crate::logstream::NullLogSink));
        tokio::spawn(task);
        let s = Syslog::with_backend(
            hub,
            tokio::runtime::Handle::current(),
            None,
            eventlog::backend(),
        );
        let st = s.set(picked(Some(&["AgentStudio-never-writes"])));
        assert!(st.available);
        assert_eq!(st.backend.as_deref(), Some("windows-eventlog"));
        if cfg!(windows) {
            assert!(st.running, "{:?}", st.reason);
            assert_eq!(st.reason, None);
        } else {
            assert!(!st.running);
            assert_eq!(st.reason.as_deref(), Some(eventlog::OFF_WINDOWS));
        }
        let st = s.set(SyslogFilter::default());
        assert!(!st.running);
        assert_eq!(st.reason, None, "a deliberate stop is quiet");
    }

    /// `syslog_apps` reads the channels the FILTER names — the extra one the user typed in the
    /// subsystem box included (it used to read Application + System only, so a provider of
    /// that channel could be streamed but never picked). Off on purpose: nothing subscribes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_apps_picker_reads_the_extra_channel_of_the_filter() {
        let (hub, task) = LogHub::new(Arc::new(crate::logstream::NullLogSink));
        tokio::spawn(task);
        let s = Syslog::with_backend(
            hub,
            tokio::runtime::Handle::current(),
            None,
            eventlog::backend(),
        );
        assert_eq!(s.apps_channels(), vec!["Application", "System"]);
        let off_with_channel = SyslogFilter {
            enabled: false,
            ..picked(None)
        };
        let st = s.set(off_with_channel);
        assert!(!st.running);
        assert_eq!(
            s.apps_channels(),
            vec![
                "Application",
                "System",
                "Microsoft-Windows-PowerShell/Operational"
            ]
        );
        // A channel that repeats one of the two (any case) is not read twice.
        s.set(SyslogFilter {
            subsystem: Some("system".into()),
            ..SyslogFilter::default()
        });
        assert_eq!(s.apps_channels(), vec!["Application", "System"]);
        s.set(SyslogFilter::default());
        assert_eq!(s.apps_channels(), vec!["Application", "System"]);
    }

    #[test]
    fn the_filter_wire_shape_is_camel_case() {
        let f = SyslogFilter {
            enabled: true,
            apps: Some(vec!["Safari".into()]),
            subsystem: None,
            min_level: SyslogLevel::Info,
            simulator: false,
            simulator_apps: None,
        };
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({
                "enabled": true, "apps": ["Safari"], "subsystem": null,
                "minLevel": "info", "simulator": false, "simulatorApps": null
            })
        );
    }

    #[test]
    fn normalizing_trims_dedupes_and_blanks() {
        let f = SyslogFilter {
            apps: Some(vec![
                " Safari ".into(),
                "".into(),
                "Safari".into(),
                "Mail".into(),
            ]),
            subsystem: Some("  ".into()),
            simulator_apps: Some(vec!["  ".into()]),
            ..Default::default()
        }
        .normalized();
        assert_eq!(f.apps, Some(vec!["Safari".to_string(), "Mail".to_string()]));
        assert_eq!(f.subsystem, None);
        assert_eq!(f.simulator_apps, Some(vec![]));
    }
}
