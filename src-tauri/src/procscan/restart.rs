//! **Restart in the IDE**: a dev app whose console is a
//! terminal or pipe the IDE cannot read is stopped and started again in an IDE terminal —
//! same cwd, same argv, same environment — so its output and its HTTP land in the IDE.
//!
//! Two steps, so the confirm the user sees names exactly what will be killed:
//! 1. [`super::Procs::prepare_restart`] reads the pid's argv, cwd, start time and
//!    **environment** into Rust memory under a random token ([`RestartTokens`], single use,
//!    [`TOKEN_TTL`]) and returns only `{ token, summary: { name, cwd, argv (masked) } }`.
//!    An environment the OS hides (macOS, Apple's own binaries) refuses the restart.
//! 2. [`RestartTokens::take`] redeems it; [`stop`] sends **SIGTERM** (same uid only, the
//!    same process — its start time must match, so a reused pid is never signalled) and
//!    waits up to [`STOP_WAIT`]. **Never SIGKILL**: a process that ignores SIGTERM is
//!    reported and left alone — a second, harsher kill is a decision for the user, made
//!    outside the IDE. Then the caller opens the terminal via the supervisor with the
//!    captured env (the supervisor adds the usual IDE env on top: hook + capture proxy).
//!    **Windows has no SIGTERM**: there the stop is `TerminateProcess`
//!    (`super::winproc::terminate`) — immediate, no chance to clean up, the closest Windows
//!    has to a polite stop for a console program the IDE does not share a console with. The
//!    same guards run first (same user, same start time, the explicit confirm), and pid 0,
//!    pid 4 and the IDE itself are refused.
//!
//! **Restart with capture**: the same two steps serve an
//! `origin: "ide"` app whose `captured` is false (its proxy vars were stripped). Its captured
//! env goes into the new terminal FIRST and the supervisor's hook + capture-proxy env is
//! applied on top, so the relaunch points at the live proxy again whatever the old env said.
//!
//! 🔴 **The env never leaves Rust.** It is held in [`SecretEnv`], whose `Debug` prints only
//! a count and which has no `Serialize`; nothing here logs it; the only place it goes is the
//! child's environment. (In the spirit of never testing with real user credentials: an env
//! is where credentials live.)

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// A prepared restart is redeemable for this long.
pub const TOKEN_TTL: Duration = Duration::from_secs(60);
/// How long [`stop`] waits for the process to exit after SIGTERM.
pub const STOP_WAIT: Duration = Duration::from_secs(3);

/// Variables of the old console that must not follow the app into the IDE's terminal
/// (they describe *that* terminal, or are the IDE's own and are re-injected).
const DROP_VARS: &[&str] = &[
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "WINDOWID",
    "TMUX",
    "TMUX_PANE",
    "STY",
    "SHLVL",
    "_",
    "OLDPWD",
    "LINES",
    "COLUMNS",
    // Windows Terminal's session markers (the old console's, like `TERM_SESSION_ID`): a CLI
    // that sees them assumes Windows Terminal's features in what is now the IDE's terminal.
    "WT_SESSION",
    "WT_PROFILE_ID",
];

/// A captured environment. `Debug` shows only how many variables; no `Serialize`.
#[derive(Clone, Default)]
pub struct SecretEnv(Vec<(String, String)>);

impl std::fmt::Debug for SecretEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretEnv({} vars)", self.0.len())
    }
}

impl SecretEnv {
    /// The env to hand the new terminal: the captured one minus [`DROP_VARS`] and the IDE's
    /// own `AGENTSTUDIO_*` (re-injected by the supervisor), with `PWD` set to the cwd. On
    /// Windows ([`SecretEnv::for_terminal_with`]) names match without case (`Path` is
    /// `PATH`), and there is no `PWD` to set: it is a POSIX shell's variable, the terminal's
    /// cwd is given to `CreateProcess`, and a captured one (from a Git Bash parent) names the
    /// OLD directory in MSYS spelling — it is dropped, not replaced.
    pub fn for_terminal(&self, cwd: &str) -> Vec<(String, String)> {
        self.for_terminal_with(cwd, cfg!(windows))
    }

    /// [`SecretEnv::for_terminal`] with the platform explicit (`windows`). A parameter so every
    /// OS tests both answers.
    pub fn for_terminal_with(&self, cwd: &str, windows: bool) -> Vec<(String, String)> {
        let same = |a: &str, b: &str| {
            if windows {
                a.eq_ignore_ascii_case(b)
            } else {
                a == b
            }
        };
        let prefix = "AGENTSTUDIO_";
        let mut out: Vec<(String, String)> = self
            .0
            .iter()
            .filter(|(k, _)| !DROP_VARS.iter().any(|d| same(d, k)))
            .filter(|(k, _)| !k.get(..prefix.len()).is_some_and(|p| same(p, prefix)))
            .filter(|(k, _)| !same(k, "PWD"))
            .cloned()
            .collect();
        if !windows {
            out.push(("PWD".into(), cwd.to_string()));
        }
        out
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<Vec<(String, String)>> for SecretEnv {
    fn from(v: Vec<(String, String)>) -> Self {
        Self(v)
    }
}

/// What the confirm shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartSummary {
    /// The same name `procs_list` gives this pid (the UI compares them).
    pub name: String,
    pub cwd: String,
    /// Masked for display ([`super::mask`]).
    pub argv: Vec<String>,
}

/// `procs_restart_prepare` → the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartPrepared {
    pub token: String,
    pub summary: RestartSummary,
}

/// `procs_restart_in_ide` → the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartDone {
    pub terminal_id: String,
}

/// Everything a restart needs, held in Rust only.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub pid: u32,
    /// The process's start time when prepared (pid-reuse guard).
    pub started_ms: Option<i64>,
    pub name: String,
    pub cwd: String,
    /// The real, unmasked argv.
    pub argv: Vec<String>,
    pub exe: Option<String>,
    pub env: SecretEnv,
    created: Instant,
}

impl Prepared {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pid: u32,
        started_ms: Option<i64>,
        name: String,
        cwd: String,
        argv: Vec<String>,
        exe: Option<String>,
        env: SecretEnv,
        now: Instant,
    ) -> Self {
        Self {
            pid,
            started_ms,
            name,
            cwd,
            argv,
            exe,
            env,
            created: now,
        }
    }

    /// `(program, args)` for the new terminal: argv[0] when it is an absolute path that
    /// exists (what the user ran — a `python3` symlink, not the framework binary behind
    /// it), else the resolved executable, else argv[0] as written (PATH lookup). "Absolute"
    /// is the host's rule (`C:\Program Files\nodejs\node.exe` on Windows, not only `/…`).
    ///
    /// **On Windows a batch file is never the program** (`.cmd`/`.bat`): Windows
    /// runs one through `cmd.exe`, which expands `%VAR%` inside the arguments — the captured
    /// argv would be re-read as a command. A process's image is always an `.exe`, so a batch
    /// name can only come from what argv[0] says; then the image wins, and with neither usable
    /// there is no program (`None`).
    pub fn program(&self) -> Option<(String, Vec<String>)> {
        self.program_for(cfg!(windows))
    }

    /// [`Prepared::program`] with the platform explicit (`windows`), so every OS tests both
    /// rules. The unix rule and the Windows rule are separate code paths (platform-native).
    pub fn program_for(&self, windows: bool) -> Option<(String, Vec<String>)> {
        let first = self.argv.first()?;
        let args = self.argv[1..].to_vec();
        let program = if windows {
            windows_program(first, self.exe.as_deref())?
        } else {
            let path = std::path::Path::new(first);
            if path.is_absolute() && path.exists() {
                first.clone()
            } else if let Some(exe) = &self.exe {
                exe.clone()
            } else {
                first.clone()
            }
        };
        Some((program, args))
    }
}

/// The program a Windows restart runs: argv\[0\] when it is an absolute path to an existing
/// `.exe`/`.com` (what the user ran), else the process's image (`QueryFullProcessImageNameW`,
/// always a PE file). **Never a bare name, and never a batch file:** the terminal hands the
/// program to `CreateProcess` through portable-pty, whose PATH search tries `PATHEXT` — which
/// lists `.BAT` and `.CMD` — so `npm` could resolve to `npm.cmd`, and a batch file runs through
/// `cmd.exe`, which re-reads the arguments (`%VAR%` expands even inside quotes).
/// The arguments themselves are quoted by the Windows argv rules (`CommandLineToArgvW`), with
/// no shell in between: no PowerShell or cmd syntax is involved at all.
fn windows_program(argv0: &str, exe: Option<&str>) -> Option<String> {
    let path = std::path::Path::new(argv0);
    let lower = argv0.to_ascii_lowercase();
    let image = lower.ends_with(".exe") || lower.ends_with(".com");
    if path.is_absolute() && path.exists() && image {
        return Some(argv0.to_string());
    }
    exe.filter(|e| !is_batch(e)).map(str::to_string)
}

/// A Windows batch script (`x.cmd`, `X.BAT`) — run only through `cmd.exe`.
pub fn is_batch(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

impl Prepared {
    /// Test seam: the same restart with another argv[0] / exe.
    #[cfg(test)]
    fn with_program(mut self, argv0: &str, exe: Option<&str>) -> Self {
        self.argv[0] = argv0.to_string();
        self.exe = exe.map(str::to_string);
        self
    }
}

/// The prepared restarts, by token.
#[derive(Default)]
pub struct RestartTokens(Mutex<HashMap<String, Prepared>>);

impl RestartTokens {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Prepared>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Store `p`; returns its token. Expired entries are purged on the way.
    pub fn insert(&self, mut p: Prepared, now: Instant) -> String {
        // The TTL runs from when the token is handed out.
        p.created = now;
        let token = format!("rs-{}", ulid::Ulid::new());
        let mut map = self.lock();
        map.retain(|_, v| now.duration_since(v.created) < TOKEN_TTL);
        map.insert(token.clone(), p);
        token
    }

    /// Redeem `token` (single use).
    pub fn take(&self, token: &str, now: Instant) -> Result<Prepared, String> {
        let p = self
            .lock()
            .remove(token)
            .ok_or_else(|| "this restart was already used or never prepared".to_string())?;
        if now.duration_since(p.created) >= TOKEN_TTL {
            return Err(format!(
                "this restart expired ({} s) — prepare it again",
                TOKEN_TTL.as_secs()
            ));
        }
        Ok(p)
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }
}

/// How the process ended up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stopped {
    /// It exited after SIGTERM.
    Terminated,
    /// It was already gone (or its pid now belongs to another process): nothing signalled.
    AlreadyGone,
}

/// SIGTERM `p` if it is still the same process, and wait for it to exit (module doc).
/// `start_of(pid)` = the live process's start time (`None` = gone or a zombie); `uid_of`
/// = its owner. Blocking (polls every 25 ms, up to [`STOP_WAIT`]).
pub fn stop(
    p: &Prepared,
    my_uid: Option<u32>,
    start_of: impl Fn(u32) -> Option<i64>,
    uid_of: impl Fn(u32) -> Option<u32>,
    sigterm: impl Fn(u32) -> Result<(), String>,
) -> Result<Stopped, String> {
    let same = |s: Option<i64>| s.is_some() && s == p.started_ms;
    if !same(start_of(p.pid)) {
        return Ok(Stopped::AlreadyGone);
    }
    if uid_of(p.pid) != my_uid || my_uid.is_none() {
        return Err(format!(
            "pid {} belongs to another user — not stopping it",
            p.pid
        ));
    }
    sigterm(p.pid).map_err(|e| format!("could not stop pid {}: {e}", p.pid))?;
    let deadline = Instant::now() + STOP_WAIT;
    while Instant::now() < deadline {
        if !same(start_of(p.pid)) {
            return Ok(Stopped::Terminated);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if !same(start_of(p.pid)) {
        return Ok(Stopped::Terminated);
    }
    Err(format!(
        "{} (pid {}) did not exit within {} s of SIGTERM. It was not force-killed — stop it \
         yourself, then restart it in the IDE again.",
        p.name,
        p.pid,
        STOP_WAIT.as_secs()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn prepared(env: Vec<(&str, &str)>) -> Prepared {
        Prepared::new(
            42,
            Some(1000),
            "svc".into(),
            "/w/svc".into(),
            vec!["/bin/sh".into(), "run.sh".into()],
            Some("/bin/sh".into()),
            SecretEnv::from(
                env.into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect::<Vec<_>>(),
            ),
            Instant::now(),
        )
    }

    #[test]
    fn the_env_debug_prints_no_value() {
        let p = prepared(vec![("API_TOKEN", "hunter2-value")]);
        let dbg = format!("{p:?}");
        assert!(!dbg.contains("hunter2"), "{dbg}");
        assert!(dbg.contains("SecretEnv(1 vars)"), "{dbg}");
    }

    #[test]
    fn the_terminal_env_drops_the_old_console_and_sets_pwd() {
        let p = prepared(vec![
            ("TERM_PROGRAM", "iTerm.app"),
            ("TMUX", "/tmp/x"),
            ("PWD", "/elsewhere"),
            ("AGENTSTUDIO_TERMINAL_ID", "t-old"),
            ("DATABASE_URL", "postgres://x"),
        ]);
        assert_eq!(
            p.env.for_terminal_with("/w/svc", false),
            vec![
                ("DATABASE_URL".to_string(), "postgres://x".to_string()),
                ("PWD".to_string(), "/w/svc".to_string()),
            ],
            "the unix rule"
        );
        assert_eq!(
            p.env.for_terminal("/w/svc"),
            p.env.for_terminal_with("/w/svc", cfg!(windows)),
            "this OS's rule"
        );
    }

    /// "Absolute" is the host's rule: `C:\…\node.exe` on Windows (it was `starts_with('/')`,
    /// so a Windows argv[0] never won over the image).
    #[test]
    fn the_program_is_an_absolute_argv0_that_exists_else_the_image() {
        let here = std::env::current_exe().unwrap();
        assert!(here.is_absolute() && here.exists());
        let here_s = here.to_string_lossy().into_owned();
        let image = Some("image-of-the-process");
        // Both rules, judged by this host's idea of "absolute" (the test binary's own path).
        for windows in [false, true] {
            let program = |argv0: &str, exe: Option<&str>| {
                prepared(vec![])
                    .with_program(argv0, exe)
                    .program_for(windows)
                    .map(|(p, _)| p)
            };
            let here_is_exe = here_s.to_ascii_lowercase().ends_with(".exe");
            if !windows || here_is_exe {
                assert_eq!(program(&here_s, image), Some(here_s.clone()), "{windows}");
            }
            let missing = here.with_file_name("no-such-program-here.exe");
            assert_eq!(
                program(&missing.to_string_lossy(), image).as_deref(),
                image,
                "an absolute argv[0] that does not exist ({windows})"
            );
            assert_eq!(
                program("node", image).as_deref(),
                image,
                "a bare name ({windows})"
            );
        }
        let unix = prepared(vec![])
            .with_program("node", None)
            .program_for(false);
        assert_eq!(unix.map(|(p, _)| p).as_deref(), Some("node"), "PATH lookup");
        assert_eq!(
            prepared(vec![]).program().unwrap().1,
            vec!["run.sh".to_string()],
            "the arguments are argv[1..]"
        );
    }

    #[test]
    fn a_batch_file_is_never_the_program_on_windows() {
        let dir =
            std::env::temp_dir().join(format!("agentstudio-restart-bat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("npm.cmd");
        std::fs::write(&shim, "@echo off\r\n").unwrap();
        let shim_s = shim.to_string_lossy().into_owned();
        let node = r"C:\Program Files\nodejs\node.exe";
        let program = |argv0: &str, exe: Option<&str>, windows: bool| {
            prepared(vec![])
                .with_program(argv0, exe)
                .program_for(windows)
                .map(|(p, _)| p)
        };
        // argv[0] names an existing shim: the image runs instead, on Windows.
        assert_eq!(program(&shim_s, Some(node), true).as_deref(), Some(node));
        assert_eq!(
            program(&shim_s, Some(node), false),
            Some(shim_s.clone()),
            "elsewhere a `.cmd` is just a file name"
        );
        // Nothing runnable at all: no program, rather than a trip through cmd.exe.
        assert_eq!(program("npm.cmd", None, true), None);
        assert_eq!(program("NPM.BAT", None, true), None);
        assert_eq!(program("npm.cmd", None, false).as_deref(), Some("npm.cmd"));
        // A bare name is never run on Windows: the PATH search behind CreateProcess tries
        // PATHEXT, which lists .BAT and .CMD (`npm` → `npm.cmd`). Unix looks it up on PATH.
        assert_eq!(program("node", None, true), None);
        assert_eq!(program("node", None, false).as_deref(), Some("node"));
        // A batch image (never real, but never trusted either) is not a fallback.
        assert_eq!(program("node", Some(r"C:\x\run.BAT"), true), None);
        // An absolute argv[0] that exists but is not a PE file (npm's extensionless `sh`
        // script beside npm.cmd) is not what CreateProcess can run: the image instead.
        let sh_script = dir.join("npm");
        std::fs::write(&sh_script, "#!/bin/sh\n").unwrap();
        assert_eq!(
            program(&sh_script.to_string_lossy(), Some(node), true).as_deref(),
            Some(node)
        );
        let tool = dir.join("tool.EXE");
        std::fs::write(&tool, b"MZ").unwrap();
        let tool_s = tool.to_string_lossy().into_owned();
        assert_eq!(
            program(&tool_s, Some(node), true),
            Some(tool_s.clone()),
            "an absolute .exe that exists is what the user ran"
        );
        for (p, want) in [
            ("x.cmd", true),
            (r"C:\a\B.CMD", true),
            ("run.bat", true),
            ("node.exe", false),
            ("cmd", false),
            ("x.cmdx", false),
        ] {
            assert_eq!(is_batch(p), want, "{p}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Windows env rules: names match without case, and there is no `PWD` (a captured one
    /// is dropped and none is added — the cwd is the spawn's, and `PWD` is a POSIX shell's).
    #[test]
    fn on_windows_env_names_are_matched_without_case() {
        let p = prepared(vec![
            ("Pwd", "C:\\elsewhere"),
            ("wt_session", "{a}"),
            ("WT_PROFILE_ID", "{b}"),
            ("AgentStudio_TERMINAL_ID", "t-old"),
            ("Term", "xterm"),
            ("Path", "C:\\bin"),
        ]);
        let pairs = |v: &[(&str, &str)]| -> Vec<(String, String)> {
            v.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            p.env.for_terminal_with("C:\\w\\svc", true),
            pairs(&[("Path", "C:\\bin")])
        );
        assert_eq!(
            p.env.for_terminal_with("/w/svc", false),
            pairs(&[
                ("Pwd", "C:\\elsewhere"),
                ("wt_session", "{a}"),
                ("AgentStudio_TERMINAL_ID", "t-old"),
                ("Term", "xterm"),
                ("Path", "C:\\bin"),
                ("PWD", "/w/svc"),
            ]),
            "unix names are case-sensitive: only the exact spellings go"
        );
    }

    #[test]
    fn a_token_is_single_use_and_expires() {
        let t = RestartTokens::default();
        let now = Instant::now();
        let tok = t.insert(prepared(vec![]), now);
        assert!(t.take(&tok, now).is_ok());
        assert!(t.take(&tok, now).is_err(), "single use");
        let tok = t.insert(prepared(vec![]), now);
        let err = t.take(&tok, now + TOKEN_TTL).unwrap_err();
        assert!(err.contains("expired"), "{err}");
        // Expired entries are purged by the next insert.
        let _ = t.insert(prepared(vec![]), now);
        let _ = t.insert(prepared(vec![]), now + TOKEN_TTL + Duration::from_secs(1));
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn a_reused_pid_is_never_signalled() {
        let p = prepared(vec![]);
        let signalled = Cell::new(false);
        let got = stop(
            &p,
            Some(501),
            |_| Some(2000), // same pid, a different start time: another process
            |_| Some(501),
            |_| {
                signalled.set(true);
                Ok(())
            },
        );
        assert_eq!(got, Ok(Stopped::AlreadyGone));
        assert!(!signalled.get());
    }

    #[test]
    fn another_users_process_is_refused() {
        let p = prepared(vec![]);
        let got = stop(&p, Some(501), |_| Some(1000), |_| Some(0), |_| Ok(()));
        assert!(got.unwrap_err().contains("another user"));
    }

    #[test]
    fn a_process_that_ignores_sigterm_is_reported_not_killed() {
        let p = prepared(vec![]);
        let signals = Cell::new(0);
        let t0 = Instant::now();
        let got = stop(
            &p,
            Some(501),
            |_| Some(1000), // never exits
            |_| Some(501),
            |_| {
                signals.set(signals.get() + 1);
                Ok(())
            },
        );
        let err = got.unwrap_err();
        assert!(err.contains("not force-killed"), "{err}");
        assert_eq!(signals.get(), 1, "one SIGTERM, nothing harsher");
        // Two-sided: it really waited.
        assert!(t0.elapsed() >= STOP_WAIT, "{:?}", t0.elapsed());
    }

    #[test]
    fn the_numbers() {
        assert_eq!(TOKEN_TTL, Duration::from_secs(60));
        assert_eq!(STOP_WAIT, Duration::from_secs(3));
    }
}
