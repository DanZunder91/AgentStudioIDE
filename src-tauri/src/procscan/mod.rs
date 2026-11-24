//! **Dev apps on this machine** (a way to
//! find the running JVM, Node (or other JS) and Cargo/Rust apps, and to open each one's log
//! files or console directly).
//!
//! # Pieces
//!
//! | module | does | tested |
//! |---|---|---|
//! | [`classify`] | which process is a dev app, its runtime, entry and name | pure table |
//! | [`mask`] | secrets in argv, masked for display | pure table |
//! | [`logfiles`] | console kind, offered log files, listening ports from an fd table | pure table |
//! | [`os`] | reading this user's processes (macOS libproc/sysctl, Linux `/proc`, Windows below) | live |
//! | [`winparse`] | the Windows table's bytes → facts (argv rules, PEB walk, SID → uid, fd shapes) | pure, every OS |
//! | `winproc` | the Windows API calls behind [`os`] (`cfg(windows)`) | live, Windows only |
//! | [`docker`] | containers via an already-installed `docker` CLI | parser table |
//! | [`restart`] | Restart in the IDE: token store, SIGTERM-only stop | pure + live |
//! | [`capture`] | `DevApp.captured`: does an IDE app's env still point at the IDE's proxy | pure table + live |
//! | [`ide`] | which IDE terminal / agent started a process; claude's helpers | pure table + live |
//! | [`assemble`] (here) | raw processes → `DevApp[]` (placed by [`ide::place`], launchers collapsed) | pure, golden |
//!
//! Tails live in [`crate::logstream::apps`]; this module decides what may be tailed.
//!
//! # The tail guard
//!
//! `logstream_tail_app({ pid, path })` opens a file only when, **at that moment**, the pid
//! has that very file open (both sides canonicalised), or the path came back from
//! `logstream_pick_file` — a native dialog the user drove. Never an arbitrary path from the
//! webview. The file is then opened `O_NOFOLLOW` (Windows: `FILE_FLAG_OPEN_REPARSE_POINT`, and a
//! reparse point is refused) and must be a regular file.
//!
//! # Windows
//!
//! Discovery works ([`os`] → `winproc`): this user's processes (owner = the token's user SID,
//! hashed to a stable "uid"), exe, argv, start time, cwd, ports — and what
//! fds 1/2 point at and the files a process holds open for writing, from its own handle table
//! (no administrator rights; `winproc`'s module doc says how it never hangs). So
//! `npm run dev > dev.log 2>&1` reads as `console: "file"` with `dev.log` offered as stdout, a
//! log the app opened itself is offered as `log`, and the tail guard admits exactly those (plus
//! a file picked in the dialog). Paths are never verbatim (`\\?\`) on the wire
//! ([`crate::paths::canonicalize`]). Restart's stop is `TerminateProcess` (Windows
//! has no SIGTERM — `winproc::terminate`).

pub mod capture;
pub mod classify;
pub mod docker;
pub mod ide;
pub mod logfiles;
pub mod mask;
pub mod os;
pub mod restart;
pub mod winparse;
#[cfg(windows)]
pub mod winproc;

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::logstream::apps::{AppTailInfo, AppTails, DockerTailSpec, FileTailSpec};
use crate::logstream::LogHub;
use classify::{app_name, basename, classify, Facts, Runtime};
use ide::{IdeSnapshot, IdeTerminals, Origin, Placement};
use logfiles::{console_of, listen_ports, log_files, stdout_tty, Console, LogVia};
use os::RawProc;
use restart::{Prepared, RestartDone, RestartPrepared, RestartSummary, RestartTokens};

/// Wire `LogFile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub path: String,
    pub kind: LogVia,
}

/// Wire `DevApp` (serde camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevApp {
    /// `pid:<n>` / `docker:<container id>`.
    pub key: String,
    /// `null` for a container.
    pub pid: Option<u32>,
    pub runtime: Runtime,
    pub name: String,
    pub exe: Option<String>,
    /// Secrets masked ([`mask`]). Empty for a container.
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub started_ms: Option<i64>,
    pub ports: Vec<u16>,
    /// `none` for a container (its log source is `docker logs`); `ide-terminal` when fd 1
    /// is the pty slave of the IDE terminal in `terminal_id`.
    pub console: Console,
    pub log_files: Vec<LogFile>,
    pub container_id: Option<String>,
    /// `ide` — it descends from an IDE terminal's shell (or agent runtime); else `external`
    /// (a container is always `external`).
    pub origin: Origin,
    /// The IDE terminal whose PTY child is its ancestor (`origin: "ide"` only).
    pub terminal_id: Option<String>,
    /// The root agent bound to that terminal, when the app descends from its `claude` —
    /// something the agent ran, not something typed in the same terminal before it.
    pub agent_id: Option<String>,
    /// Display label: the agent's title when `agent_id` is set, else the terminal's.
    pub launched_by: Option<String>,
    /// `origin: "ide"` only: does its environment still point at the IDE's capture proxy
    /// ([`capture`])? `false` = its HTTP cannot show in Network (someone stripped the proxy
    /// vars); `null` = unknown (env hidden by the OS, the IDE injecting no proxy) or external.
    pub captured: Option<bool>,
}

/// `procs_list` → the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcsList {
    pub available: bool,
    /// Why not available, or what is partial (`"Docker is not running"`).
    pub reason: Option<String>,
    pub apps: Vec<DevApp>,
}

/// What [`assemble`] needs besides the processes.
#[derive(Debug, Clone, Default)]
pub struct AssembleOpts {
    /// The IDE's own pid: never listed, and a descendant of it that is **not** under one of
    /// `terminals` is the IDE's tooling (LSP servers, `docker logs`, …) and dropped
    /// ([`ide::place`]). `None` in tests that spawn their own children.
    pub ide_pid: Option<u32>,
    pub home: Option<String>,
    /// The IDE's live terminals by PTY child pid ([`IdeTerminals::snapshot`]). Empty: no
    /// process is `origin: "ide"`.
    pub terminals: IdeSnapshot,
    /// The port the IDE's capture proxy is injecting into its terminals right now
    /// ([`crate::netcap::injecting_port`]); `None` = it injects nothing, so no app's
    /// `captured` is known. Read by [`scan`] (not [`assemble`], which never reads an env).
    pub proxy_port: Option<u16>,
}

/// `pid:<n>` / `docker:<id>`.
pub fn app_key(pid: u32) -> String {
    format!("pid:{pid}")
}

/// Classify one raw process against its parent.
fn classify_raw(p: &RawProc, parent: Option<&RawProc>) -> Option<classify::Classified> {
    let exe = p
        .exe
        .as_deref()
        .or_else(|| p.argv.first().map(String::as_str))?;
    classify(&Facts {
        exe,
        argv: &p.argv,
        parent_exe: parent.and_then(|q| q.exe.as_deref()),
        parent_argv: parent.map(|q| q.argv.as_slice()).unwrap_or(&[]),
        console: console_of(&p.fds),
    })
}

/// Would this process be a dev app if its console were a file? The scan inspects (fds,
/// cwd) only these — the cheap pre-filter.
pub fn candidate(p: &RawProc, parent: Option<&RawProc>) -> bool {
    let exe = match p
        .exe
        .as_deref()
        .or_else(|| p.argv.first().map(String::as_str))
    {
        Some(e) => e,
        None => return false,
    };
    classify(&Facts {
        exe,
        argv: &p.argv,
        parent_exe: parent.and_then(|q| q.exe.as_deref()),
        parent_argv: parent.map(|q| q.argv.as_slice()).unwrap_or(&[]),
        console: Console::File,
    })
    .is_some()
}

/// Raw processes → dev apps (module doc): each classified against its parent, then placed
/// ([`ide::place`] — the IDE pid, its tooling, the `claude` CLI and claude's own helpers
/// dropped; the rest `ide` or `external`), a launcher dropped when a kept descendant is a
/// dev app (`cargo run` → its `target/debug/gazelle`), sorted by name then pid. Pure.
pub fn assemble(procs: &[RawProc], opts: &AssembleOpts) -> Vec<DevApp> {
    let by_pid: HashMap<u32, &RawProc> = procs.iter().map(|p| (p.pid, p)).collect();
    let classified: Vec<(&RawProc, classify::Classified, Placement)> = procs
        .iter()
        .filter(|p| Some(p.pid) != opts.ide_pid)
        .filter_map(|p| {
            let parent = by_pid.get(&p.ppid).copied();
            let c = classify_raw(p, parent)?;
            match ide::place(p.pid, &by_pid, opts.ide_pid, &opts.terminals) {
                Placement::Internal | Placement::ClaudeHelper => None,
                placed => Some((p, c, placed)),
            }
        })
        .collect();
    let dev: HashSet<u32> = classified.iter().map(|(p, _, _)| p.pid).collect();
    // Every ancestor of a dev app "has a dev-app descendant".
    let mut has_dev_descendant: HashSet<u32> = HashSet::new();
    for &pid in &dev {
        let mut cur = by_pid.get(&pid).map(|p| p.ppid);
        for _ in 0..512 {
            let Some(pp) = cur.filter(|pp| *pp != 0) else {
                break;
            };
            if !has_dev_descendant.insert(pp) {
                break;
            }
            cur = by_pid.get(&pp).map(|p| p.ppid).filter(|next| *next != pp);
        }
    }
    let home = opts.home.as_deref();
    let mut apps: Vec<DevApp> = classified
        .into_iter()
        .filter(|(p, c, _)| !(c.launcher && has_dev_descendant.contains(&p.pid)))
        .map(|(p, c, placed)| {
            let console = console_of(&p.fds);
            let (origin, attribution) = match placed {
                Placement::Ide(a) => (Origin::Ide, Some(a)),
                _ => (Origin::External, None),
            };
            let on_its_terminal = attribution.as_ref().is_some_and(|a| {
                console == Console::Terminal
                    && a.tty.is_some()
                    && stdout_tty(&p.fds) == a.tty.as_deref()
            });
            DevApp {
                key: app_key(p.pid),
                pid: Some(p.pid),
                runtime: c.runtime,
                name: app_name(&c, p.cwd.as_deref(), home),
                exe: p.exe.clone(),
                argv: mask::mask_argv(&p.argv),
                cwd: p.cwd.clone(),
                started_ms: p.started_ms,
                ports: listen_ports(&p.fds),
                console: if on_its_terminal {
                    Console::IdeTerminal
                } else {
                    console
                },
                log_files: log_files(&p.fds, home)
                    .into_iter()
                    .map(|(path, kind)| LogFile { path, kind })
                    .collect(),
                container_id: None,
                origin,
                terminal_id: attribution.as_ref().map(|a| a.terminal_id.clone()),
                agent_id: attribution.as_ref().and_then(|a| a.agent_id.clone()),
                launched_by: attribution.map(|a| a.launched_by),
                captured: None,
            }
        })
        .collect();
    sort_apps(&mut apps);
    apps
}

fn sort_apps(apps: &mut [DevApp]) {
    apps.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.pid.cmp(&b.pid))
            .then_with(|| a.key.cmp(&b.key))
    });
}

/// A container as a dev app.
pub fn docker_app(c: &docker::Container) -> DevApp {
    DevApp {
        key: format!("docker:{}", c.id),
        pid: None,
        runtime: Runtime::Docker,
        name: c.name.clone(),
        exe: None,
        argv: Vec::new(),
        cwd: c.working_dir.clone(),
        started_ms: None,
        ports: c.ports.clone(),
        console: Console::None,
        log_files: Vec::new(),
        container_id: Some(c.id.clone()),
        origin: Origin::External,
        terminal_id: None,
        agent_id: None,
        launched_by: None,
        captured: None,
    }
}

/// `procs_list` on an OS without discovery (neither macOS, Linux nor Windows).
pub fn unavailable_list() -> ProcsList {
    ProcsList {
        available: false,
        reason: Some("Dev-app discovery is not available on this OS yet".into()),
        apps: Vec::new(),
    }
}

/// `procs_list` from the processes' apps and the `docker ps` outcome (`None` = no docker
/// CLI installed; `Err(reason)` = it failed — a partial list, never an error). Sorted.
pub fn procs_list_of(
    mut apps: Vec<DevApp>,
    docker: Option<&Result<Vec<docker::Container>, String>>,
) -> ProcsList {
    let mut reason = None;
    match docker {
        None => {}
        Some(Ok(cs)) => apps.extend(cs.iter().map(docker_app)),
        Some(Err(r)) => reason = Some(r.clone()),
    }
    sort_apps(&mut apps);
    ProcsList {
        available: true,
        reason,
        apps,
    }
}

/// The processes of this user, the dev-app candidates inspected. Blocking.
pub fn scan_raw() -> Vec<RawProc> {
    let Some(uid) = os::my_uid() else {
        return Vec::new();
    };
    let mut procs = os::list(uid);
    let parents: HashMap<u32, usize> = procs.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();
    let want: Vec<usize> = (0..procs.len())
        .filter(|&i| {
            let parent = parents.get(&procs[i].ppid).map(|&j| &procs[j]);
            candidate(&procs[i], parent)
        })
        .collect();
    for i in want {
        os::inspect(&mut procs[i]);
    }
    procs
}

/// The dev apps on this machine right now (processes only), with `captured` set. Blocking.
pub fn scan(opts: &AssembleOpts) -> Vec<DevApp> {
    let mut apps = assemble(&scan_raw(), opts);
    mark_captured(&mut apps, opts.proxy_port, os::read_env);
    apps
}

/// Set `captured` on every `origin: "ide"` app ([`capture::captured`]); external apps and
/// containers stay `None`. `env_of(pid)` is read for IDE apps only, and only when the IDE is
/// injecting a proxy — each env is reduced to the boolean and dropped here (an environment
/// holds secrets, so no value or key list leaves this function).
pub fn mark_captured(
    apps: &mut [DevApp],
    proxy_port: Option<u16>,
    env_of: impl Fn(u32) -> Option<Vec<(String, String)>>,
) {
    for app in apps.iter_mut() {
        app.captured = match (app.origin, app.pid, proxy_port) {
            (Origin::Ide, Some(pid), Some(_)) => {
                capture::captured(env_of(pid).as_deref(), proxy_port)
            }
            _ => None,
        };
    }
}

/// `$HOME`, for the name and log-file rules (Windows: `%USERPROFILE%` when `HOME` is unset —
/// a GUI app there has no `HOME` unless something like Git Bash exported one).
fn home_dir() -> Option<String> {
    let var = |k: &str| std::env::var(k).ok().filter(|h| !h.is_empty());
    var("HOME").or_else(|| {
        if cfg!(windows) {
            var("USERPROFILE")
        } else {
            None
        }
    })
}

// ── the tail guard ──────────────────────────────────────────────────────────

/// Why a tail was refused (a plain sentence for the UI).
pub type Refusal = String;

/// The canonical path of a file `pid` may be tailed for, or why not (module doc).
/// `open_of(pid)` lists the regular files the pid has open (canonicalised here). Canonical =
/// [`crate::paths::canonicalize`] on both sides: never `\\?\` (it reaches the tail's key and
/// `detail`), and the dialog's `picked` set is spelled the same way.
pub fn authorize(
    path: &Path,
    pid: Option<u32>,
    picked: &HashSet<PathBuf>,
    open_of: impl Fn(u32) -> Vec<String>,
) -> Result<PathBuf, Refusal> {
    if !path.is_absolute() {
        return Err("the path is not absolute".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("the path contains `..`".into());
    }
    let canon = crate::paths::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if picked.contains(&canon) {
        return Ok(canon);
    }
    let Some(pid) = pid else {
        return Err(format!(
            "{} was not chosen in the file dialog and no process was named",
            path.display()
        ));
    };
    let has_it = open_of(pid).iter().any(|p| {
        crate::paths::canonicalize(p)
            .map(|c| c == canon)
            .unwrap_or(false)
    });
    if has_it {
        Ok(canon)
    } else {
        Err(format!(
            "pid {pid} does not have {} open — only a file a listed process has open, or one \
             you pick, can be streamed",
            path.display()
        ))
    }
}

/// Open a guarded file for reading without following a link — `O_NOFOLLOW` on unix;
/// on Windows `FILE_FLAG_OPEN_REPARSE_POINT` opens a symlink/junction ITSELF, which is then
/// refused — and only a regular file. Windows: std's share mode is read | write | delete, so
/// the app keeps writing, and can still rotate (rename) or delete the file, while it is tailed
/// (`logstream::apps`' Windows test holds that against a real writer).
pub(crate) fn open_regular(canon: &Path) -> Result<std::fs::File, Refusal> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let f = opts
        .open(canon)
        .map_err(|e| format!("{}: {e}", canon.display()))?;
    let meta = f.metadata().ok();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let reparse = windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta
            .as_ref()
            .is_some_and(|m| m.file_attributes() & reparse != 0)
        {
            return Err(format!("{} is a link, not a regular file", canon.display()));
        }
    }
    if !meta.is_some_and(|m| m.is_file()) {
        return Err(format!("{} is not a regular file", canon.display()));
    }
    Ok(f)
}

/// `file:<pid>:<canonical path>` / `file:<canonical path>`.
pub fn file_tail_key(pid: Option<u32>, canon: &Path) -> String {
    match pid {
        Some(pid) => format!("file:{pid}:{}", canon.display()),
        None => format!("file:{}", canon.display()),
    }
}

/// `<name> · <file basename>`.
pub fn file_source(name: &str, canon: &Path) -> String {
    let base = canon
        .file_name()
        .map(|b| b.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{name} · {base}")
}

// ── state ───────────────────────────────────────────────────────────────────

/// The dev-apps feature's state (Tauri managed).
pub struct Procs {
    opts: AssembleOpts,
    /// The supervisor's live terminal table, read into `opts.terminals` per scan.
    terminals: IdeTerminals,
    /// The `docker` CLI found at startup (a `stat`, never a run).
    docker: Option<PathBuf>,
    pub tails: AppTails,
    picked: Mutex<HashSet<PathBuf>>,
    restarts: RestartTokens,
    /// The last `docker ps` result — `logstream_tail_docker` only follows a listed one.
    containers: Mutex<Vec<docker::Container>>,
    /// Read `proxy_port` from the app's proxy on every scan ([`Procs::with_live_proxy`]);
    /// otherwise `opts.proxy_port` as given.
    live_proxy: bool,
}

impl Procs {
    /// Explicit options (tests: `ide_pid: None`, no docker). No IDE terminals until
    /// [`Procs::with_terminals`].
    pub fn new(hub: LogHub, opts: AssembleOpts, docker: Option<PathBuf>) -> Self {
        Self {
            opts,
            terminals: IdeTerminals::default(),
            docker,
            tails: AppTails::new(hub),
            picked: Mutex::new(HashSet::new()),
            restarts: RestartTokens::default(),
            containers: Mutex::new(Vec::new()),
            live_proxy: false,
        }
    }

    /// The app's: our own pid, the supervisor's terminal table
    /// ([`crate::supervisor::SupervisorHandle::ide_terminals`]), `$HOME`, the docker CLI if
    /// installed.
    pub fn for_app(hub: LogHub, terminals: IdeTerminals) -> Self {
        let home = home_dir();
        let docker = docker::find_docker(home.as_deref().map(Path::new), |p| p.is_file());
        Self::new(
            hub,
            AssembleOpts {
                ide_pid: Some(std::process::id()),
                home,
                terminals: IdeSnapshot::default(),
                proxy_port: None,
            },
            docker,
        )
        .with_terminals(terminals)
        .with_live_proxy()
    }

    /// Judge `captured` against the app's live capture proxy ([`crate::netcap::injecting_port`],
    /// read per scan — capture can be switched off while the view is open).
    pub fn with_live_proxy(mut self) -> Self {
        self.live_proxy = true;
        self
    }

    /// Read IDE terminals from `terminals` (the supervisor's table) on every scan.
    pub fn with_terminals(mut self, terminals: IdeTerminals) -> Self {
        self.terminals = terminals;
        self
    }

    pub fn opts(&self) -> &AssembleOpts {
        &self.opts
    }

    /// `opts` with the terminal table as it is right now.
    fn current_opts(&self) -> AssembleOpts {
        AssembleOpts {
            terminals: self.terminals.snapshot(),
            proxy_port: if self.live_proxy {
                crate::netcap::injecting_port()
            } else {
                self.opts.proxy_port
            },
            ..self.opts.clone()
        }
    }

    /// `procs_list`.
    pub async fn list(&self) -> ProcsList {
        if !os::AVAILABLE {
            return unavailable_list();
        }
        let opts = self.current_opts();
        let apps = tokio::task::spawn_blocking(move || scan(&opts))
            .await
            .unwrap_or_default();
        let docker = match &self.docker {
            None => None,
            Some(bin) => Some(docker::list(bin).await),
        };
        // Remember what was listed: only a listed container may be followed.
        *self.containers.lock().unwrap_or_else(|p| p.into_inner()) = match &docker {
            Some(Ok(cs)) => cs.clone(),
            _ => Vec::new(),
        };
        procs_list_of(apps, docker.as_ref())
    }

    /// Remember a file the user chose in the dialog (canonical), so it may be tailed.
    pub fn allow_picked(&self, path: &Path) -> Result<PathBuf, Refusal> {
        let canon =
            crate::paths::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !std::fs::metadata(&canon)
            .map(|m| m.is_file())
            .unwrap_or(false)
        {
            return Err(format!("{} is not a regular file", canon.display()));
        }
        self.picked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(canon.clone());
        Ok(canon)
    }

    /// The name `procs_list` gives `pid` (else its executable's basename). Blocking.
    fn name_of(&self, pid: u32) -> String {
        let procs = scan_raw();
        if let Some(app) = assemble(&procs, &self.current_opts())
            .into_iter()
            .find(|a| a.pid == Some(pid))
        {
            return app.name;
        }
        procs
            .iter()
            .find(|p| p.pid == pid)
            .and_then(|p| p.exe.as_deref().or(p.argv.first().map(String::as_str)))
            .map(|e| basename(e).to_string())
            .unwrap_or_else(|| format!("pid {pid}"))
    }

    /// `logstream_tail_app`. Needs a tokio runtime.
    pub fn tail_file(&self, pid: Option<u32>, path: &str) -> Result<AppTailInfo, Refusal> {
        let picked = self
            .picked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let canon = authorize(Path::new(path), pid, &picked, os::open_paths)?;
        let key = file_tail_key(pid, &canon);
        let name = match pid {
            Some(pid) => self.name_of(pid),
            None => canon
                .parent()
                .and_then(|d| d.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into()),
        };
        let file = open_regular(&canon)?;
        let detail = match pid {
            Some(pid) => format!("{} · pid {pid}", canon.display()),
            None => canon.display().to_string(),
        };
        let alive: Option<crate::logstream::apps::Alive> = match pid {
            Some(pid) => {
                let start = os::proc_start(pid);
                Some(Box::new(move || {
                    start.is_some() && os::proc_start(pid) == start
                }))
            }
            None => None,
        };
        self.tails.start_file(FileTailSpec {
            key,
            source: file_source(&name, &canon),
            detail,
            path: PathBuf::from(path),
            canon,
            file,
            alive,
        })
    }

    /// `logstream_tail_docker`. Needs a tokio runtime.
    pub fn tail_docker(&self, id: &str) -> Result<AppTailInfo, Refusal> {
        let Some(bin) = self.docker.clone() else {
            return Err("Docker is not installed".into());
        };
        if !docker::valid_container_ref(id) {
            return Err(format!("not a container id: {id}"));
        }
        let c = self
            .containers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("container {id} is not in the current list — refresh"))?;
        self.tails.start_docker(DockerTailSpec {
            key: format!("docker:{}", c.id),
            source: format!("{} · docker", c.name),
            detail: format!("docker logs -f {} · {}", short_id(&c.id), c.image),
            program: bin,
            container: c.id,
        })
    }

    /// Test seam: make `containers` what a `docker ps` would have listed.
    pub fn set_containers_for_test(&self, cs: Vec<docker::Container>) {
        *self.containers.lock().unwrap_or_else(|p| p.into_inner()) = cs;
    }

    /// `procs_restart_prepare`. Blocking.
    pub fn prepare_restart(&self, pid: u32) -> Result<RestartPrepared, Refusal> {
        if !os::AVAILABLE {
            return Err("not available on this OS".into());
        }
        let me = os::my_uid();
        if os::uid_of(pid).is_none() || os::uid_of(pid) != me {
            return Err(format!("pid {pid} is not one of your running processes"));
        }
        let procs = scan_raw();
        let raw = procs
            .iter()
            .find(|p| p.pid == pid)
            .ok_or_else(|| format!("pid {pid} is not running"))?;
        let cwd = crate::pty::cwd::process_cwd(pid)
            .map(|c| c.to_string_lossy().into_owned())
            .ok_or_else(|| format!("the working directory of pid {pid} could not be read"))?;
        if raw.argv.is_empty() {
            return Err(format!("the command line of pid {pid} could not be read"));
        }
        // An empty environment means the OS hid it — macOS does for Apple's own binaries
        // (`/bin/sh`, `/bin/bash`, `/usr/bin/*`), however the process was started. Restarting
        // without it could break the app (a lost `DATABASE_URL`), so refuse and say why.
        let env = os::read_env(pid).filter(|e| !e.is_empty()).ok_or_else(|| {
            let exe = raw.exe.as_deref().unwrap_or("this program");
            format!(
                "the environment of pid {pid} cannot be read ({exe} is a system binary whose \
                     environment the OS hides), so it cannot be restarted with the same settings"
            )
        })?;
        let name = assemble(&procs, &self.current_opts())
            .into_iter()
            .find(|a| a.pid == Some(pid))
            .map(|a| a.name)
            .unwrap_or_else(|| {
                raw.exe
                    .as_deref()
                    .map(|e| basename(e).to_string())
                    .unwrap_or_else(|| format!("pid {pid}"))
            });
        let summary = RestartSummary {
            name: name.clone(),
            cwd: cwd.clone(),
            argv: mask::mask_argv(&raw.argv),
        };
        let token = self.restarts.insert(
            Prepared::new(
                pid,
                raw.started_ms,
                name,
                cwd,
                raw.argv.clone(),
                raw.exe.clone(),
                env.into(),
                Instant::now(),
            ),
            Instant::now(),
        );
        Ok(RestartPrepared { token, summary })
    }

    /// `procs_restart_in_ide`: SIGTERM the process (never SIGKILL), then open an IDE
    /// terminal in its cwd running its argv with its env. The terminal's output channel is
    /// a placeholder until the UI calls `terminal_reattach` (which replays scrollback).
    pub async fn restart_in_ide(
        &self,
        supervisor: &crate::supervisor::SupervisorHandle,
        token: &str,
        terminal_id: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
    ) -> Result<RestartDone, Refusal> {
        let p = self.restarts.take(token, Instant::now())?;
        let (program, args) = p.program().ok_or_else(|| {
            "the command line is empty, or names only a batch file (which Windows would run \
             through cmd.exe, re-reading its arguments)"
                .to_string()
        })?;
        let stopper = p.clone();
        tokio::task::spawn_blocking(move || {
            restart::stop(
                &stopper,
                os::my_uid(),
                os::proc_start,
                os::uid_of,
                os::sigterm,
            )
        })
        .await
        .map_err(|e| format!("stop failed: {e}"))??;
        let terminal_id = terminal_id.unwrap_or_else(|| ulid::Ulid::new().to_string());
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let meta = supervisor
            .open_terminal_with_env(
                crate::supervisor::OpenSpec {
                    terminal_id,
                    program: Some(program),
                    args,
                    cwd: p.cwd.clone(),
                    rows: rows.unwrap_or(24),
                    cols: cols.unwrap_or(80),
                },
                p.env.for_terminal(&p.cwd),
                channel,
            )
            .await?;
        Ok(RestartDone {
            terminal_id: meta.id,
        })
    }
}

fn short_id(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}

// ── IPC ─────────────────────────────────────────────────────────────────────

/// `procs_list` → `ProcsList`. Polled every 3 s while the view is open.
#[tauri::command]
pub async fn procs_list(procs: tauri::State<'_, Procs>) -> Result<ProcsList, String> {
    Ok(procs.list().await)
}

/// `logstream_tail_app({ pid, path })` → `{ key, source }`.
#[tauri::command]
pub async fn logstream_tail_app(
    procs: tauri::State<'_, Procs>,
    pid: Option<u32>,
    path: String,
) -> Result<AppTailInfo, String> {
    let procs = procs.inner();
    // `name_of` scans; keep it off the async worker.
    tokio::task::block_in_place(|| procs.tail_file(pid, &path))
}

/// `logstream_tail_docker({ id })` → `{ key, source }`.
#[tauri::command]
pub async fn logstream_tail_docker(
    procs: tauri::State<'_, Procs>,
    id: String,
) -> Result<AppTailInfo, String> {
    procs.tail_docker(&id)
}

/// `logstream_untail({ key })` → whether it was streaming.
#[tauri::command]
pub async fn logstream_untail(procs: tauri::State<'_, Procs>, key: String) -> Result<bool, String> {
    Ok(procs.tails.stop(&key))
}

/// `logstream_pick_file()` → the chosen path, or `null` when the user cancelled. The one
/// way a path the webview names can be tailed without a process having it open.
#[tauri::command]
pub async fn logstream_pick_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    procs: tauri::State<'_, Procs>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Stream a log file")
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(picked) = rx.await.map_err(|_| "the dialog closed".to_string())? else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("not a local file: {e}"))?;
    let canon = procs.allow_picked(&path)?;
    Ok(Some(canon.to_string_lossy().into_owned()))
}

/// `procs_restart_prepare({ pid })` → `{ token, summary }`. The env is read here and kept
/// in Rust.
#[tauri::command]
pub async fn procs_restart_prepare(
    procs: tauri::State<'_, Procs>,
    pid: u32,
) -> Result<RestartPrepared, String> {
    let procs = procs.inner();
    tokio::task::block_in_place(|| procs.prepare_restart(pid))
}

/// `procs_restart_in_ide({ token })` → `{ terminalId }`. `terminalId`/`rows`/`cols` are
/// optional (the UI may mint the id; defaults: a ULID, 24×80).
#[tauri::command]
pub async fn procs_restart_in_ide(
    procs: tauri::State<'_, Procs>,
    supervisor: tauri::State<'_, crate::supervisor::SupervisorHandle>,
    token: String,
    terminal_id: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<RestartDone, String> {
    procs
        .restart_in_ide(supervisor.inner(), &token, terminal_id, rows, cols)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(pid: u32, ppid: u32, exe: &str, argv: &[&str]) -> RawProc {
        RawProc {
            pid,
            ppid,
            exe: Some(exe.into()),
            argv: argv.iter().map(|s| s.to_string()).collect(),
            cwd: Some("/w/web".into()),
            started_ms: Some(1),
            fds: Vec::new(),
        }
    }

    #[test]
    fn an_ide_tooling_child_is_skipped_and_a_launcher_with_a_dev_child_is_collapsed() {
        let procs = vec![
            raw(1, 0, "/sbin/launchd", &["launchd"]),
            raw(
                10,
                1,
                "/Applications/Agent Studio.app/Contents/MacOS/agentstudio",
                &["agentstudio"],
            ),
            raw(11, 10, "/bin/zsh", &["-zsh"]),
            raw(
                12,
                11,
                "/opt/homebrew/bin/node",
                &["node", "/w/web/node_modules/.bin/vite"],
            ),
            raw(
                20,
                1,
                "/opt/homebrew/bin/node",
                &["node", "/opt/homebrew/bin/npm", "run", "dev"],
            ),
            raw(21, 20, "/bin/sh", &["sh", "-c", "vite"]),
            raw(
                22,
                21,
                "/opt/homebrew/bin/node",
                &["node", "/w/web/node_modules/.bin/vite"],
            ),
            raw(
                30,
                1,
                "/opt/homebrew/bin/node",
                &["node", "/opt/homebrew/bin/npm", "run", "lonely"],
            ),
        ];
        // No terminal table: 11 is not an IDE terminal, so 12 is IDE tooling.
        let apps = assemble(
            &procs,
            &AssembleOpts {
                ide_pid: Some(10),
                ..AssembleOpts::default()
            },
        );
        let pids: Vec<Option<u32>> = apps.iter().map(|a| a.pid).collect();
        assert_eq!(
            pids,
            vec![Some(30), Some(22)],
            "12 is the IDE's tooling; 20 (npm) is collapsed into 22 (vite); 30 has no dev child \
             (sorted by name: `npm run lonely · web` < `vite · web`)"
        );
        assert!(apps.iter().all(|a| a.origin == Origin::External));
    }

    #[test]
    fn a_ppid_cycle_terminates() {
        let procs = vec![
            raw(5, 6, "/opt/homebrew/bin/node", &["node", "a.js"]),
            raw(6, 5, "/opt/homebrew/bin/node", &["node", "b.js"]),
        ];
        let apps = assemble(
            &procs,
            &AssembleOpts {
                ide_pid: Some(99),
                ..AssembleOpts::default()
            },
        );
        assert_eq!(apps.len(), 2);
    }

    #[test]
    fn captured_is_judged_for_ide_apps_only_and_only_while_a_proxy_is_injected() {
        let app = |pid: Option<u32>, origin: Origin| DevApp {
            pid,
            origin,
            ..docker_app(&docker::Container {
                id: "c".into(),
                name: "n".into(),
                image: "i".into(),
                ports: Vec::new(),
                working_dir: None,
                status: String::new(),
            })
        };
        let ours = "http://t-a:x@127.0.0.1:9".to_string();
        let env_of = |pid: u32| match pid {
            1 => Some(vec![
                ("HTTP_PROXY".to_string(), ours.clone()),
                ("HTTPS_PROXY".to_string(), ours.clone()),
            ]),
            2 => Some(vec![("PATH".to_string(), "/bin".to_string())]),
            _ => None,
        };
        let mut apps = vec![
            app(Some(1), Origin::Ide),
            app(Some(2), Origin::Ide),
            app(Some(3), Origin::Ide),
            app(Some(1), Origin::External),
            app(None, Origin::Ide),
        ];
        mark_captured(&mut apps, Some(9), env_of);
        let got: Vec<Option<bool>> = apps.iter().map(|a| a.captured).collect();
        assert_eq!(got, vec![Some(true), Some(false), None, None, None]);
        let read = std::cell::Cell::new(0);
        mark_captured(&mut apps, None, |pid| {
            read.set(read.get() + 1);
            env_of(pid)
        });
        assert!(apps.iter().all(|a| a.captured.is_none()));
        assert_eq!(read.get(), 0, "no proxy ⇒ no env is read at all");
    }

    /// The tail guard's last step opens without following a link: a regular file opens, a
    /// symlink to it is refused (unix: `O_NOFOLLOW` fails the open; Windows:
    /// `FILE_FLAG_OPEN_REPARSE_POINT` opens the link itself, and a reparse point is refused).
    #[test]
    fn open_regular_refuses_a_link_to_a_regular_file() {
        let dir = std::env::temp_dir().join(format!("agentstudio-openreg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("svc.log");
        std::fs::write(&file, "x\n").unwrap();
        let link = dir.join("link.log");
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&file, &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&file, &link);
        assert!(open_regular(&file).is_ok(), "a regular file opens");
        match made {
            Ok(()) => {
                let err = open_regular(&link).expect_err("a symlink is refused");
                assert!(err.contains("link.log"), "{err}");
            }
            // Windows without Developer Mode or elevation cannot make a symlink at all.
            Err(e) => eprintln!("could not create a symlink here ({e}); refusal not exercised"),
        }
        assert!(
            open_regular(&dir).is_err(),
            "a directory is not a regular file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh Windows temp dir, spelled long and non-verbatim (the form a process's cwd and a
    /// handle's final path take).
    #[cfg(windows)]
    fn windows_temp_dir(tag: &str) -> PathBuf {
        let raw = std::env::temp_dir().join(format!("agentstudio-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&raw).unwrap();
        crate::paths::canonicalize(&raw).unwrap()
    }

    /// Windows, the whole pipeline on a real process: a node server listening on a port is
    /// listed (snapshot → candidate → PEB cwd + std handles → TCP listener → assemble) with its
    /// runtime, port, cwd and — its stdout a pipe — a `pipe` console, and Restart's stop — with
    /// the real same-user / same-start-time guards — ends it. Skipped, and said so, without
    /// node.
    #[cfg(windows)]
    #[test]
    fn windows_a_real_node_server_is_discovered_and_stopped() {
        use crate::spawn::NoWindow;
        let node = Path::new(r"C:\Program Files\nodejs\node.exe");
        if !node.exists() {
            eprintln!("no node.exe here — the Windows discovery pipeline is not exercised");
            return;
        }
        let dir = windows_temp_dir("scan");
        std::fs::write(
            dir.join("server.js"),
            "const s = require('net').createServer().listen(0, '127.0.0.1', () => \
             require('fs').writeFileSync('port.txt', String(s.address().port)));\n\
             setTimeout(() => process.exit(0), 30000);\n",
        )
        .unwrap();
        let mut child = std::process::Command::new(node)
            .arg("server.js")
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .no_window()
            .spawn()
            .expect("node starts");
        let pid = child.id();
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        let port: u16 = loop {
            if let Some(p) = std::fs::read_to_string(dir.join("port.txt"))
                .ok()
                .and_then(|s| s.trim().parse().ok())
            {
                break p;
            }
            assert!(Instant::now() < deadline, "the server never listened");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        let opts = AssembleOpts {
            ide_pid: None,
            home: home_dir(),
            ..AssembleOpts::default()
        };
        let t0 = Instant::now();
        let apps = scan(&opts);
        // The view polls this every 3 s: say what a whole scan (handle walks included) costs.
        eprintln!(
            "scan: {} dev apps in {:?} ({} name helpers waiting)",
            apps.len(),
            t0.elapsed(),
            winproc::stuck_helpers()
        );
        let app = apps.into_iter().find(|a| a.pid == Some(pid));
        let result = std::panic::catch_unwind(|| {
            let app = app.expect("the node server is listed");
            assert_eq!(app.runtime, Runtime::Node);
            assert_eq!(app.ports, vec![port]);
            assert_eq!(
                app.console,
                Console::Pipe,
                "stdout is the pipe it was given (older builds said `terminal`, from the \
                 console handle alone)"
            );
            assert_eq!(app.origin, Origin::External);
            assert!(
                app.cwd
                    .as_deref()
                    .is_some_and(|c| c.eq_ignore_ascii_case(&dir.to_string_lossy())),
                "{:?} vs {}",
                app.cwd,
                dir.display()
            );
            assert!(app.name.starts_with("server.js"), "{}", app.name);
            let dir_lower = dir.to_string_lossy().to_ascii_lowercase();
            assert!(
                !app.log_files
                    .iter()
                    .any(|f| f.path.to_ascii_lowercase().starts_with(&dir_lower)),
                "it holds no file of ours open: {:?}",
                app.log_files
            );
            let p = restart::Prepared::new(
                pid,
                app.started_ms,
                app.name.clone(),
                app.cwd.clone().unwrap(),
                app.argv.clone(),
                app.exe.clone(),
                restart::SecretEnv::default(),
                Instant::now(),
            );
            let stopped = restart::stop(&p, os::my_uid(), os::proc_start, os::uid_of, os::sigterm);
            assert_eq!(stopped, Ok(restart::Stopped::Terminated));
        });
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    /// Windows, logs end to end — a Windows user must see all their dev apps' logs: node
    /// run as `node app.js > dev.log 2>&1` that also appends to a `held.log` it keeps open
    /// is listed with `console: "file"`, `dev.log` as stdout and `held.log` as a log; the
    /// tail guard admits both (the handle walk is its `open_of`); both stream live lines
    /// into the hub while node writes; the key is not verbatim; and the streams end with
    /// "process exited" when node is killed. Skipped, and said so, without node.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn windows_a_redirected_node_apps_logs_are_offered_and_streamed() {
        use crate::logstream::apps::{APP_STARTED_PREFIX, APP_STOPPED_PREFIX};
        use crate::logstream::{LogKind, LogLevel, NullLogSink};
        use crate::spawn::NoWindow;
        let node = Path::new(r"C:\Program Files\nodejs\node.exe");
        if !node.exists() {
            eprintln!("no node.exe here — Windows log discovery + tailing is not exercised");
            return;
        }
        let dir = windows_temp_dir("applogs");
        std::fs::write(
            dir.join("app.js"),
            "const fs = require('fs');\n\
             const held = fs.openSync('held.log', 'a');\n\
             let n = 0;\n\
             setInterval(() => { n++; console.log(`INFO app: tick ${n}`); \
             fs.writeSync(held, `WARN held: tick ${n}\\n`); }, 100);\n\
             setTimeout(() => process.exit(0), 30000);\n",
        )
        .unwrap();
        let (dev_log, held_log) = (dir.join("dev.log"), dir.join("held.log"));
        let out = std::fs::File::create(&dev_log).unwrap();
        let err = out.try_clone().unwrap();
        /// Kills and reaps node, and removes the dir, however the test ends.
        struct Cleanup(std::process::Child, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let child = std::process::Command::new(node)
            .arg("app.js")
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .stdout(out)
            .stderr(err)
            .no_window()
            .spawn()
            .expect("node starts");
        let mut child = Cleanup(child, dir.clone());
        let pid = child.0.id();
        let (hub, task) = LogHub::new(std::sync::Arc::new(NullLogSink));
        tokio::spawn(task);
        let opts = AssembleOpts {
            ide_pid: None,
            home: home_dir(),
            ..AssembleOpts::default()
        };
        let procs = Procs::new(hub.clone(), opts.clone(), None);
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        {
            while !(std::fs::metadata(&dev_log).is_ok_and(|m| m.len() > 0)
                && std::fs::metadata(&held_log).is_ok_and(|m| m.len() > 0))
            {
                assert!(Instant::now() < deadline, "node never wrote its logs");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let o = opts.clone();
            let app = tokio::task::spawn_blocking(move || scan(&o))
                .await
                .unwrap()
                .into_iter()
                .find(|a| a.pid == Some(pid))
                .expect("node is listed");
            assert_eq!(app.runtime, Runtime::Node);
            assert_eq!(app.console, Console::File, "fd 1/2 → dev.log");
            let same = |a: &str, b: &Path| a.eq_ignore_ascii_case(&b.to_string_lossy());
            let ours: Vec<&LogFile> = app
                .log_files
                .iter()
                .filter(|f| same(&f.path, &dev_log) || same(&f.path, &held_log))
                .collect();
            assert_eq!(ours.len(), 2, "logFiles: {:?}", app.log_files);
            assert!(same(&ours[0].path, &dev_log) && ours[0].kind == LogVia::Stdout);
            assert!(same(&ours[1].path, &held_log) && ours[1].kind == LogVia::Log);
            assert!(
                app.log_files.iter().all(|f| !f.path.starts_with(r"\\?\")),
                "{:?}",
                app.log_files
            );
            // Both stream, through the real guard.
            let mut keys = Vec::new();
            for (f, want_text, want_level) in [
                (&dev_log, "INFO app: tick", LogLevel::Info),
                (&held_log, "WARN held: tick", LogLevel::Warn),
            ] {
                let info = tokio::task::block_in_place(|| {
                    procs.tail_file(Some(pid), &f.to_string_lossy())
                })
                .expect("the guard admits a file node has open");
                assert!(!info.key.contains(r"\\?\"), "{}", info.key);
                assert_eq!(info.key, format!("file:{pid}:{}", f.display()));
                let base = f.file_name().unwrap().to_string_lossy().into_owned();
                assert!(
                    info.source.ends_with(&format!(" · {base}")),
                    "{}",
                    info.source
                );
                let seen = |count_after: usize| {
                    hub.snapshot()
                        .iter()
                        .filter(|l| {
                            l.kind == LogKind::App
                                && l.source == info.source
                                && l.text.starts_with(want_text)
                                && l.level == want_level
                        })
                        .count()
                        > count_after
                };
                while !seen(0) {
                    assert!(Instant::now() < deadline, "no {want_text} line");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                // Live, not only the backfill.
                let n = hub
                    .snapshot()
                    .iter()
                    .filter(|l| l.kind == LogKind::App && l.source == info.source)
                    .count();
                while !seen(n) {
                    assert!(Instant::now() < deadline, "no live {want_text} line");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                assert!(hub.snapshot().iter().any(|l| l.kind == LogKind::System
                    && l.text == format!("{APP_STARTED_PREFIX}{}", info.source)));
                keys.push(info);
            }
            // A file of the same dir that node does not hold is refused.
            std::fs::write(dir.join("other.log"), "x\n").unwrap();
            let refused = tokio::task::block_in_place(|| {
                procs.tail_file(Some(pid), &dir.join("other.log").to_string_lossy())
            });
            assert!(
                refused.as_ref().is_err_and(|e| e.contains("does not have")),
                "{refused:?}"
            );
            let _ = child.0.kill();
            for info in &keys {
                let stopped = format!("{APP_STOPPED_PREFIX}{} — process exited", info.source);
                while !hub.snapshot().iter().any(|l| l.text == stopped) {
                    assert!(
                        Instant::now() < deadline,
                        "no stop line for {}",
                        info.source
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
        drop(child);
    }

    #[test]
    fn keys_and_sources() {
        let p = Path::new("/w/svc/svc.log");
        assert_eq!(file_tail_key(Some(7), p), "file:7:/w/svc/svc.log");
        assert_eq!(file_tail_key(None, p), "file:/w/svc/svc.log");
        assert_eq!(file_source("svc", p), "svc · svc.log");
        assert_eq!(app_key(7), "pid:7");
    }
}
