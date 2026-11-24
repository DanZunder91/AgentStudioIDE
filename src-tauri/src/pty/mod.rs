//! PTY layer — `portable-pty` (openpty/forkpty on Unix, ConPTY on Windows).
//!
//! Key facts that shape this code (ARCHITECTURE §3 — do not
//! relearn the hard way):
//! - the reader/writer are **blocking `std::io`** → bridged in [`reader`].
//! - `master.try_clone_reader()` must be called **before** the pair is moved.
//! - grab `child.clone_killer()` up front so we can kill while `wait()` blocks.
//! - drop the **slave** after spawning so only the child holds it — otherwise the
//!   master never sees EOF when the child exits.

pub mod cwd;
pub mod reader;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

/// Serializes PTY allocation across the whole process.
///
/// **Do not remove this as a pointless lock.** `openpty(3)` is not safe to call
/// concurrently on macOS. Its first step, `posix_openpt()` (a clone-open of
/// `/dev/ptmx`), transiently fails when several threads allocate PTYs at once,
/// reporting `ENXIO` ("Device not configured") — and sometimes a *negated*
/// `ENXIO`, which surfaces as the nonsense `errno = -6` / "Unknown error: -6".
///
/// Measured, not guessed:
/// - 16 threads opening PTYs in a **burst**: ~5% of `openpty` calls fail, hitting
///   10 of 12 runs. With this lock: **0 failures in 576 calls.**
/// - It is a **platform defect, not ours**: it reproduces in a standalone C
///   program calling libutil's `openpty()` from threads — no Rust, no tokio, no
///   `portable-pty` involved.
/// - It is *not* fd exhaustion (`RLIMIT_NOFILE` is 1048576) and *not* PTY
///   exhaustion (it triggers at ~32 PTYs against `kern.tty.ptmx_max` = 511).
///
/// **This guards the product, not just the tests.** Bursty allocation is exactly
/// what M3 fan-out does — spawning several agents at once goes through here — so
/// without this lock, a user creating a handful of agents together would see
/// spurious "openpty failed" errors. The tests merely surfaced it first.
///
/// Held only across the allocation itself, never across `fork`/`exec`: `openpty`
/// takes microseconds and runs once per terminal, so this never contends in
/// practice. Kept unconditional rather than `cfg`-gated to macOS — the cost is
/// unmeasurable and the ordering guarantee is worth having everywhere.
static PTY_ALLOC_LOCK: Mutex<()> = Mutex::new(());

/// What to launch in a PTY. For plain terminals `program` is the resolved
/// `$SHELL`; for agent terminals (M2) it comes from the `AgentAdapter`.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Extra env on top of the inherited environment + the TTY defaults below.
    pub env: Vec<(String, String)>,
    pub rows: u16,
    pub cols: u16,
}

/// Everything we keep for one live PTY. Owned by the supervisor (control plane);
/// the byte path never touches it.
pub struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The pid `portable-pty` reported for the child at spawn (`None` when it could
    /// not report one).
    ///
    /// **Why the pid lives here and not on the supervisor's `TerminalRuntime`.**
    /// Everything it is ever compared against belongs to *this* PTY — the master's
    /// foreground process group ([`PtyHandle::foreground_command_running`]) and, via
    /// [`PtyHandle::child_pid`], the process whose cwd the poller reads. Keeping the
    /// pid beside the master fd means the two halves of that comparison cannot come
    /// from different terminals. It also expires at exactly the right moment: the
    /// supervisor sets `TerminalRuntime.pty = None` the instant the child exits, so
    /// the handle — and the pid with it — is dropped before the OS can recycle the
    /// number onto somebody else's process.
    child_pid: Option<u32>,
}

/// The pieces of a freshly spawned PTY, split by who owns what:
/// - `handle` → the supervisor (resize/write/kill),
/// - `reader` → the dedicated reader thread (hot path),
/// - `child`  → the waiter thread (blocking `wait()`).
pub struct PtySpawn {
    pub handle: PtyHandle,
    pub reader: Box<dyn Read + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

/// The user's login shell, so `$SHELL`/login config is honored for plain
/// terminals. Falls back per platform (ARCHITECTURE §2.4).
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/bin/zsh".to_string()
                } else {
                    "/bin/bash".to_string()
                }
            })
    }
}

/// What Windows PowerShell runs before its first prompt in an IDE terminal: drop its `curl`
/// alias, so `curl` is the real `curl.exe`.
///
/// Why: Windows PowerShell 5.1 aliases `curl` to `Invoke-WebRequest`,
/// which ignores `HTTP(S)_PROXY` — so a `curl https://…` typed in an IDE terminal never
/// reached the capture proxy and never showed in Network, and it does not take curl's
/// arguments either (`curl -s -X POST …` is an error there). `curl.exe` ships with Windows
/// (10 1803+) and honours the proxy variables. `-Force` because the built-in alias is
/// `AllScope`; silent where there is no such alias. `wget` is left alone: Windows has no
/// `wget.exe` to fall back to. `Invoke-WebRequest` and `iwr` still work by name.
pub const POWERSHELL_UNALIAS_CURL: &str =
    "Remove-Item Alias:curl -Force -ErrorAction SilentlyContinue";

/// What Windows PowerShell runs before its first prompt in an IDE terminal, after
/// [`POWERSHELL_UNALIAS_CURL`]: point .NET's `[System.Net.WebRequest]::DefaultWebProxy` at this
/// terminal's capture proxy, so `Invoke-WebRequest`, `Invoke-RestMethod`, `iwr`, `irm`, `wget`
/// and .NET's `WebClient` typed in the terminal show in Network.
///
/// Why: Windows PowerShell 5.1 (.NET Framework) ignores `HTTP(S)_PROXY`; its web cmdlets use
/// `DefaultWebProxy`, which is the system (WinINET) setting. The IDE never touches the system
/// setting (no OS permission may be required; it would capture every app on the machine),
/// so the terminal sets its own process's default instead — the Windows-native counterpart of
/// the proxy variables (platform-native). PowerShell 7 (`pwsh`, .NET) reads the variables
/// itself and is untouched, as is cmd.
///
/// How, and what it must not break:
/// - Only when the terminal has OUR proxy: `AGENTSTUDIO_PROXY_URL` set and `HTTP_PROXY` equal to
///   it. Capture off, or the user's own proxy in their environment → nothing changes.
/// - The proxy is `http://<host:port>` of that URL (userinfo is not part of a .NET proxy
///   address). Its credentials (`t-<terminal>`/`x`) are set too, but .NET sends them only to
///   a `407` challenge, which the capture proxy never sends; the proxy attributes the request
///   from the client process's own `AGENTSTUDIO_PROXY_URL` instead (`netcap::proxy`, Windows).
/// - `NO_PROXY` becomes the bypass list as far as `System.Net.WebProxy` allows: `*` = no proxy
///   at all; `host`, `.host`, `*.host` = that host and its subdomains, any port; `host:port`
///   = that port only; CIDR ranges (`10.0.0.0/8`) cannot be expressed and are skipped.
///   `BypassProxyOnLocal` is off, matching the variables' semantics (loopback captured).
/// - **The one thing it cannot do: loopback.** .NET Framework never sends a request for
///   `localhost` / `127.0.0.1` / `[::1]` through ANY proxy — not `WebProxy`, not a custom
///   `IWebProxy` (measured on 5.1: both go direct for loopback and through the proxy for any
///   other host). In an IDE terminal `curl` is `curl.exe`, which is captured for loopback too.
/// - A script block (`& { … }`), so its variables do not leak into the session; `try`, so a
///   malformed URL can never stop the terminal from starting. No double quotes anywhere (the
///   string crosses `CreateProcessW`'s command line and `-Command` parsing — see
///   [`POWERSHELL_CWD_SYNC`]).
pub const POWERSHELL_WEB_PROXY: &str = "if ($env:AGENTSTUDIO_PROXY_URL -and \
($env:HTTP_PROXY -eq $env:AGENTSTUDIO_PROXY_URL)) { & { try { $u = [Uri]$env:AGENTSTUDIO_PROXY_URL; \
$np = @(@($env:NO_PROXY -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }); \
if ($np -notcontains '*') { $b = @(foreach ($e in $np) { $h = $e.TrimStart('*').TrimStart('.'); \
$p = '(:\\d+)?'; if ($h -match '^([^:\\[\\]]+):(\\d+)$') { $h = $matches[1]; $p = ':' + $matches[2] }; \
if ($h -and $h -notmatch '/') { '^[a-z][a-z0-9+.-]*://([^/]*\\.)?' + [regex]::Escape($h) + $p + '$' } }); \
$w = [System.Net.WebProxy]::new('http://' + $u.Authority, $false, [string[]]$b); \
$c = $u.UserInfo -split ':', 2; \
$w.Credentials = [System.Net.NetworkCredential]::new([Uri]::UnescapeDataString($c[0]), 'x'); \
[System.Net.WebRequest]::DefaultWebProxy = $w } } catch {} } }";

/// What every PowerShell terminal (`powershell` and `pwsh`) runs before its first prompt:
/// wrap the `prompt` function so that, each time a prompt is drawn, the PROCESS working
/// directory follows the shell's location.
///
/// Why: `Set-Location` / `cd` in PowerShell moves
/// only PowerShell's own location (`$PWD`); the Win32 current directory of `powershell.exe`
/// stays where it started (PowerShell has runspaces, so it never ties the two). The
/// supervisor's cwd poller reads the process cwd ([`crate::pty::cwd::process_cwd`] — the
/// PEB on Windows), so without this a PowerShell terminal's folder would never change in
/// the UI. `[Environment]::CurrentDirectory = …` is `SetCurrentDirectoryW`, which is what
/// that read sees.
///
/// How, and what it must not break:
/// - It runs after the profile has loaded (`-Command` runs after profiles), so the `prompt`
///   it wraps is the user's own — oh-my-posh, posh-git, a hand-written one.
/// - The user's prompt runs FIRST, as the very first statement, so its `$?` and
///   `$LASTEXITCODE` are still those of the user's last command (oh-my-posh reads both); the
///   sync comes after and prints nothing. Measured on Windows PowerShell 5.1.
/// - Only the FileSystem provider has a process-cwd meaning: in `HKCU:` or `Env:` the last
///   folder stays. `try` because the folder may have been deleted under the shell.
/// - Wrapping twice must not recurse: the original is captured only once.
/// - No double quotes anywhere: the string travels through `CreateProcessW`'s command line
///   (portable-pty's quoting) and PowerShell's own `-Command` parsing; single quotes and
///   `$` mean nothing to either.
///
/// A prompt the user replaces later in the session (re-running `oh-my-posh init`) drops the
/// wrapper; the folder then stops following until the next terminal.
pub const POWERSHELL_CWD_SYNC: &str = "if (-not $global:__AgentStudioPrompt) { \
$global:__AgentStudioPrompt = $function:prompt }; function global:prompt { \
& $global:__AgentStudioPrompt; if ($PWD.Provider.Name -eq 'FileSystem') { \
try { [Environment]::CurrentDirectory = $PWD.ProviderPath } catch {} } }";

/// The arguments a plain terminal's shell starts with. Only PowerShell started with no
/// arguments of its own gets any — `-NoExit -Command <startup>`, so the profile still loads
/// first and the session stays interactive:
/// - Windows PowerShell (`powershell` / `powershell.exe`): drop the `curl` alias, point the
///   web cmdlets at the capture proxy, then the cwd sync ([`POWERSHELL_UNALIAS_CURL`];
///   [`POWERSHELL_WEB_PROXY`]; [`POWERSHELL_CWD_SYNC`]).
/// - PowerShell 7 (`pwsh` / `pwsh.exe`): the cwd sync only — it has no such alias.
///
/// Any case, with or without a path. A caller that passed arguments knows what it wants
/// and is returned untouched, as is every other shell. `windows` is a parameter so every OS
/// tests the Windows answer.
pub fn shell_startup_args(program: &str, args: Vec<String>, windows: bool) -> Vec<String> {
    if !windows || !args.is_empty() {
        return args;
    }
    let base = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let base = base.to_ascii_lowercase();
    let startup = match base.as_str() {
        "powershell" | "powershell.exe" => {
            format!("{POWERSHELL_UNALIAS_CURL}; {POWERSHELL_WEB_PROXY}; {POWERSHELL_CWD_SYNC}")
        }
        "pwsh" | "pwsh.exe" => POWERSHELL_CWD_SYNC.to_string(),
        _ => return args,
    };
    vec!["-NoExit".to_string(), "-Command".to_string(), startup]
}

fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        // A zero-sized PTY makes TUIs (including `claude`) misrender; clamp.
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Env vars Claude Code sets on its CHILD processes to mark "you are inside a Claude
/// session". If Agent Studio is itself launched from within a Claude session (e.g. the
/// dev `npm run tauri dev`), it inherits these — and so would every PTY we spawn,
/// making a `claude` inside that PTY treat itself as a NESTED child and **turn off
/// transcript saving** ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
/// marker"). That silently breaks two headline features that read the transcript: the
/// fan-out tailer (sub-agent tree) and pinned-agent resume. We strip them so
/// our agents are always TOP-LEVEL sessions.
const INHERITED_CLAUDE_CHILD_MARKERS: &[&str] = &["CLAUDE_CODE_CHILD_SESSION"];

/// The env Agent Studio imposes on a spawned PTY (on top of the inherited environment):
/// rich-TTY vars, our `AGENTSTUDIO` marker, a `LANG` passthrough, and the Claude-session
/// neutralizer — remove the inherited child markers AND force transcript persistence
/// (`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, `claude`'s own suggested remedy; belt to
/// the removal so an app-launched agent always writes its transcript). Pure so it is
/// unit-testable without a real PTY. Returns `(sets, removes)`.
fn pty_env_mutations(
    inherited_lang: Option<String>,
) -> (Vec<(&'static str, String)>, &'static [&'static str]) {
    let sets = vec![
        // A rich TTY: the child must believe it is a real terminal.
        ("TERM", "xterm-256color".to_string()),
        ("COLORTERM", "truecolor".to_string()),
        (
            "LANG",
            inherited_lang.unwrap_or_else(|| "en_US.UTF-8".to_string()),
        ),
        // Marker so an embedded agent can detect us (AgentAdapter, M2).
        ("AGENTSTUDIO", "1".to_string()),
        // Keep transcripts on even if some inherited marker slipped through.
        ("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE", "1".to_string()),
    ];
    (sets, INHERITED_CLAUDE_CHILD_MARKERS)
}

/// Windows: make sure the terminals this process starts can be interrupted with Ctrl+C.
///
/// Without this, a `^C` typed into an IDE terminal reaches ConPTY, yet `ping` keeps
/// running. Windows keeps an "ignore Ctrl+C" bit in each
/// process's parameters and copies it into every child, console or not — and a process
/// started by a parent that had it set (an agent's shell, a `CREATE_NEW_PROCESS_GROUP`
/// root, `npm run tauri dev` from such a shell) has it set too. The shell in the PTY then
/// inherits it from us, and so does everything typed there, so Ctrl+C does nothing in any
/// terminal. `SetConsoleCtrlHandler(NULL, FALSE)` clears the bit for this process, hence
/// for every child spawned after it; measured: with it, `^C` stops `ping` at once.
/// Once per process, before the first spawn. It does not attach us to any terminal's
/// console, so a Ctrl+C typed in one still reaches only the programs in that terminal.
#[cfg(windows)]
fn allow_ctrl_c() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: no pointer arguments; failing (no console at all) leaves the bit as it was.
        unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0) };
    });
}

/// Open a PTY at `spec`'s size and spawn `spec.program` into its slave.
///
/// The PTY is allocated at the correct initial size so the child's first paint
/// (Claude Code's boxes / status lines) is laid out correctly.
pub fn spawn_pty(spec: &SpawnSpec) -> Result<PtySpawn> {
    #[cfg(windows)]
    allow_ctrl_c();
    let pty_system = native_pty_system();
    let pair = {
        // See PTY_ALLOC_LOCK: concurrent openpty() is unsafe on macOS. The guard
        // is scoped to the allocation alone so the expensive part below
        // (fork/exec) still runs concurrently. Poisoning is recovered from — a
        // panic elsewhere must not make terminals permanently unopenable, and
        // there is no state behind this lock to corrupt.
        let _guard = PTY_ALLOC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        pty_system
            .openpty(pty_size(spec.rows, spec.cols))
            .context("openpty failed")?
    };

    // BEFORE the pair is moved/destructured: the reader and the writer must be
    // independent references to the master.
    let reader = pair
        .master
        .try_clone_reader()
        .context("pty: try_clone_reader failed")?;
    let writer = pair
        .master
        .take_writer()
        .context("pty: take_writer failed")?;

    let mut cmd = CommandBuilder::new(&spec.program);
    for a in &spec.args {
        cmd.arg(a);
    }
    cmd.cwd(&spec.cwd);

    // Rich-TTY vars + our marker + the Claude-session neutralizer (see
    // `pty_env_mutations`). Removals FIRST, then sets, then per-spawn `spec.env`.
    let (sets, removes) = pty_env_mutations(std::env::var("LANG").ok());
    for k in removes {
        cmd.env_remove(k);
    }
    for (k, v) in &sets {
        cmd.env(k, v);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).with_context(|| {
        format!(
            "failed to spawn `{}` in {}",
            spec.program,
            spec.cwd.display()
        )
    })?;

    // Grab the killer up front — lets us terminate the child while the waiter
    // thread is parked in the blocking `wait()`.
    let killer = child.clone_killer();
    // …and the pid, BEFORE `child` is moved into `PtySpawn` (and from there into
    // the supervisor's waiter thread). See `PtyHandle::child_pid` for why it is
    // stored on the handle rather than read again later.
    let child_pid = child.process_id();

    // Only the child may hold the slave, or the master never sees EOF on exit.
    drop(pair.slave);
    let master = pair.master;

    Ok(PtySpawn {
        handle: PtyHandle {
            master,
            writer,
            killer,
            child_pid,
        },
        reader,
        child,
    })
}

impl PtyHandle {
    /// The PTY child's pid as reported at spawn, or `None` when `portable-pty`
    /// could not report one. The supervisor hands it to the cwd poller.
    pub fn child_pid(&self) -> Option<u32> {
        self.child_pid
    }

    /// Is a **foreground command** running in this PTY right now? (Unix.)
    ///
    /// - `Some(true)`  — the terminal's foreground process group is *not* the child
    ///   we spawned, i.e. the shell has handed the tty to something it launched: a
    ///   `sleep`, a build, a dev server, a hand-typed `claude`.
    /// - `Some(false)` — the child itself owns the tty: a shell sitting at its
    ///   prompt with nothing running.
    /// - `None` — unknown (`tcgetpgrp` failed). Callers must treat this as *not*
    ///   busy. Windows answers from the process tree instead (the arm below).
    ///
    /// **Why the comparison is exact rather than a heuristic.** `portable-pty`
    /// calls `setsid()` in its `pre_exec`, so our child is a session leader and its
    /// process-group id equals its pid. `MasterPty::process_group_leader()` is
    /// `tcgetpgrp(master_fd)`, the pgid the kernel currently treats as the
    /// terminal's foreground group. So "leader == child pid" *is* "nothing is in
    /// front of the shell" — no process-table walking, no matching on command
    /// names, nothing that can drift.
    ///
    /// **It is deliberately blind to an agent terminal the app spawned.** There the
    /// runtime (`claude`) *is* the PTY child and there is no shell, so the
    /// foreground group is always the child itself and this always answers
    /// `Some(false)`. That case belongs to the supervisor's binding table; the two
    /// checks are disjoint on purpose and neither can cover the other's blind spot.
    #[cfg(unix)]
    pub fn foreground_command_running(&self) -> Option<bool> {
        let pid = self.child_pid?;
        // `None` here means `tcgetpgrp` failed (no controlling process group) —
        // unknown, not "idle".
        let leader = self.master.process_group_leader()?;
        // Widened rather than cast between `pid_t` (i32) and `u32`, so no value can
        // wrap into a false match. Deliberately no `libc::` name: `libc` is a
        // **macOS-only** direct dependency in `Cargo.toml`, so mentioning the type
        // here would not compile on Linux.
        Some(i64::from(leader) != i64::from(pid))
    }

    /// Windows: is the shell running something that would die with the terminal?
    ///
    /// ConPTY has no process groups and no `tcgetpgrp` — there is no "foreground" to ask
    /// for. What closing the terminal actually destroys is every console program attached
    /// to its pseudo-console, and a program the shell started inherits that console. So the
    /// honest Windows answer is the process tree ([`busy_descendant`]):
    ///
    /// - `Some(true)`  — the PTY child (the shell) has a live descendant that is a console
    ///   program: a `ping`, a `cargo build`, `npm run dev`, a hand-typed `claude`.
    /// - `Some(false)` — it has none: a shell at its prompt.
    /// - `None` — no pid, or the process snapshot failed (callers treat it as not busy).
    ///
    /// Not counted, because closing the terminal does not kill them: `conhost.exe` /
    /// `OpenConsole.exe` (console hosts), and GUI-subsystem programs (`notepad`, an editor
    /// the shell opened) and everything they start. One Toolhelp snapshot per call, plus
    /// one process handle per child of the shell — it runs at close time only.
    ///
    /// Unlike the Unix check this also sees a background job (`Start-Job` is a child
    /// `powershell.exe`) — which closing the terminal would kill too.
    #[cfg(windows)]
    pub fn foreground_command_running(&self) -> Option<bool> {
        let pid = self.child_pid?;
        let rows = winproc::child_rows(pid)?;
        let root_created = winproc::details(pid).0;
        Some(busy_descendant(pid, root_created, &rows).is_some())
    }

    /// Neither Unix nor Windows: nothing to ask, so "unknown".
    #[cfg(not(any(unix, windows)))]
    pub fn foreground_command_running(&self) -> Option<bool> {
        None
    }

    /// SIGWINCH / ConPTY resize on the master → the child re-flows.
    /// Debounced (~50 ms) on the UI side.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.master
            .resize(pty_size(rows, cols))
            .context("pty: resize failed")
    }

    /// Keystrokes from xterm.js → the child's stdin. Small and low-frequency.
    pub fn write_input(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    /// Kill the child if it is still running. Safe to call on an already-dead
    /// child (the error is ignored).
    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }

    /// The slave side's device path (`/dev/ttys003`, `/dev/pts/2`) — what a process
    /// running in this terminal has as its fd 1. Dev-app discovery compares the two to
    /// say "this app's console is that IDE terminal".
    /// `portable-pty` recorded it at `openpty`, so this is a clone, not a syscall.
    #[cfg(unix)]
    pub fn tty_name(&self) -> Option<String> {
        self.master
            .tty_name()
            .map(|p| p.to_string_lossy().into_owned())
    }

    /// ConPTY has no slave device path.
    #[cfg(not(unix))]
    pub fn tty_name(&self) -> Option<String> {
        None
    }
}

// ── Windows tier 2: the shell's process tree ─────────────────────────────────

/// One process, as the Windows busy check ([`busy_descendant`]) sees it. Plain data, so
/// the decision is tested on every OS with hand-written tables.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcRow {
    pub pid: u32,
    /// The pid it was created by — on Windows possibly a DEAD process whose number has
    /// since been reused (the OS does not re-parent orphans); see `created`.
    pub ppid: u32,
    /// The executable's file name (`ping.exe`).
    pub exe: String,
    /// Creation time (FILETIME ticks on Windows), when it could be read.
    pub created: Option<u64>,
    /// The executable is a GUI-subsystem program ([`pe_subsystem`] = 2).
    pub gui: bool,
}

/// Console hosts: the OS's, not the user's. ConPTY's own host is a child of the app that
/// created the pseudo-console, but a program that opens a console of its own gets one.
const CONSOLE_HOSTS: &[&str] = &["conhost.exe", "openconsole.exe"];

fn is_console_host(exe: &str) -> bool {
    let base = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    CONSOLE_HOSTS.iter().any(|h| base.eq_ignore_ascii_case(h))
}

/// A process in `rows` that would die with the terminal whose shell is `root`, if any: a
/// CHILD of `root` (its `ppid`, and — when both times are known — created no earlier than
/// `root`, since Windows does not re-parent orphans and an older process naming a reused
/// pid as its parent is not that pid's child) that is neither a console host nor a GUI
/// program. Only children are looked at, and that is the whole tree: a console program
/// inherits its parent's console, so a busy grandchild means a busy child — unless the
/// child is a GUI program or a console host, whose own children get consoles of their
/// own and so do not die with this one. (A grandchild orphaned by its parent's exit is
/// out of reach of any parent link; that miss is the price of not guessing.)
pub fn busy_descendant(root: u32, root_created: Option<u64>, rows: &[ProcRow]) -> Option<u32> {
    rows.iter()
        .filter(|r| r.ppid == root && r.pid != root)
        .filter(|r| match (root_created, r.created) {
            (Some(p), Some(c)) => c >= p,
            _ => true,
        })
        .find(|r| !is_console_host(&r.exe) && !r.gui)
        .map(|r| r.pid)
}

/// The PE optional header's `Subsystem` (2 = Windows GUI, 3 = console) from the first bytes
/// of an executable, or `None` when `head` is not a PE image (or too short to say).
pub fn pe_subsystem(head: &[u8]) -> Option<u16> {
    let u32_at = |at: usize| {
        head.get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    if head.get(0..2)? != b"MZ" {
        return None;
    }
    let pe = u32_at(0x3c)? as usize;
    if head.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    // Signature (4) + COFF file header (20), then the optional header; `Subsystem` sits at
    // offset 68 in both the PE32 and PE32+ layouts.
    let at = pe.checked_add(4 + 20 + 68)?;
    head.get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
}

/// `IMAGE_SUBSYSTEM_WINDOWS_GUI`.
pub const SUBSYSTEM_GUI: u16 = 2;

/// The Windows calls behind [`PtyHandle::foreground_command_running`]: a Toolhelp process
/// snapshot, then a `PROCESS_QUERY_LIMITED_INFORMATION` handle per candidate (its creation
/// time and image path, whose PE header says GUI or console). Same-user processes only;
/// no privilege, no prompt.
#[cfg(windows)]
pub(crate) mod winproc {
    use super::{pe_subsystem, ProcRow, SUBSYSTEM_GUI};
    use std::io::Read as _;
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// `(pid, ppid, exe file name)` of every process, or `None` when the snapshot failed.
    pub fn snapshot() -> Option<Vec<(u32, u32, String)>> {
        // SAFETY: no pointer arguments; the handle is checked and closed below.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return None;
        }
        let mut out = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: `entry` is a valid, correctly sized PROCESSENTRY32W for both calls.
        let mut more = unsafe { Process32FirstW(snap, &mut entry) } != 0;
        while more {
            let name = &entry.szExeFile;
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            out.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&name[..len]),
            ));
            // SAFETY: as above.
            more = unsafe { Process32NextW(snap, &mut entry) } != 0;
        }
        // SAFETY: `snap` is a live handle we own.
        unsafe { CloseHandle(snap) };
        Some(out)
    }

    /// Creation time and image path of `pid` (each `None` when it cannot be read — gone,
    /// or not ours).
    pub fn details(pid: u32) -> (Option<u64>, Option<PathBuf>) {
        // SAFETY: plain call; a null handle is checked.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return (None, None);
        }
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: `h` is live and the four out-pointers are valid FILETIMEs.
        let ok = unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) };
        let created = (ok != 0)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime));
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` holds `len` u16s; on success `len` is the length written.
        let ok = unsafe {
            QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        let image =
            (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])));
        // SAFETY: `h` is a live handle we own.
        unsafe { CloseHandle(h) };
        (created, image)
    }

    /// Is the executable at `image` a GUI-subsystem program? Unknown (unreadable, not PE)
    /// is `false`: counted as a console program, i.e. as busy — the safe side.
    fn is_gui(image: &std::path::Path) -> bool {
        let mut head = [0u8; 4096];
        let n = std::fs::File::open(image)
            .and_then(|mut f| f.read(&mut head))
            .unwrap_or(0);
        pe_subsystem(&head[..n]) == Some(SUBSYSTEM_GUI)
    }

    /// The rows [`super::busy_descendant`] needs for `root`: the processes the snapshot
    /// names `root` as the parent of, each with its creation time and subsystem. Nothing
    /// else is opened.
    pub fn child_rows(root: u32) -> Option<Vec<ProcRow>> {
        let all = snapshot()?;
        Some(
            all.into_iter()
                .filter(|(pid, ppid, _)| *ppid == root && *pid != root)
                .map(|(pid, ppid, exe)| {
                    let (created, image) = details(pid);
                    ProcRow {
                        pid,
                        ppid,
                        exe,
                        created,
                        gui: image.as_deref().is_some_and(is_gui),
                    }
                })
                .collect(),
        )
    }
}

impl Drop for PtyHandle {
    /// Cleanup order: kill the child, then drop the writer and
    /// the master → the PTY fds close → the reader thread sees EOF/EIO and exits
    /// → its mpsc closes → the coalescer flushes and stops. No zombie threads.
    fn drop(&mut self) {
        self.kill();
    }
}

/// A real ConPTY terminal for the Windows tests (this module's and the agent adapter's):
/// the module's own spawn path, output collected by a thread. Every wait is bounded and a
/// failure prints what the screen showed. It also answers a cursor-position query
/// `ESC[6n`, as xterm.js does in the app. ConPTY's host used to send one at the
/// start of every terminal and held the program until it was answered (`node` never ran its
/// script) — that was `PSEUDOCONSOLE_INHERIT_CURSOR`, now dropped in the vendored
/// portable-pty (local patch #2), so the host no longer asks. The answer stays because a
/// program may still ask for itself, and answering is what a real terminal does.
#[cfg(all(test, windows))]
pub(crate) mod testterm {
    use super::{spawn_pty, Child, PtyHandle, SpawnSpec};
    use std::io::Read as _;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    pub(crate) struct TestTerm {
        pub(crate) handle: PtyHandle,
        child: Box<dyn Child + Send + Sync>,
        out: Arc<Mutex<Vec<u8>>>,
        answered: usize,
    }

    impl TestTerm {
        pub(crate) fn spawn(spec: &SpawnSpec) -> TestTerm {
            let spawn = spawn_pty(spec).expect("spawn in a PTY");
            let out = Arc::new(Mutex::new(Vec::new()));
            let sink = out.clone();
            let mut reader = spawn.reader;
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    sink.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            });
            TestTerm {
                handle: spawn.handle,
                child: spawn.child,
                out,
                answered: 0,
            }
        }

        pub(crate) fn powershell(args: Vec<String>) -> TestTerm {
            TestTerm::spawn(&SpawnSpec {
                program: "powershell".to_string(),
                args,
                cwd: std::env::temp_dir(),
                env: Vec::new(),
                rows: 30,
                cols: 200,
            })
        }

        /// Answer every `ESC[6n` seen so far that has not been answered yet.
        pub(crate) fn pump(&mut self) {
            let asked = {
                let raw = self.out.lock().unwrap();
                raw.windows(4).filter(|w| w == b"\x1b[6n").count()
            };
            while self.answered < asked {
                let _ = self.handle.write_input(b"\x1b[1;1R");
                self.answered += 1;
            }
        }

        /// Output so far, VT escapes removed, lower-cased.
        pub(crate) fn text(&self) -> String {
            let raw = String::from_utf8_lossy(&self.out.lock().unwrap()).into_owned();
            let mut s = String::new();
            let mut chars = raw.chars();
            while let Some(c) = chars.next() {
                if c != '\x1b' {
                    s.push(c);
                    continue;
                }
                match chars.next() {
                    Some('[') => {
                        for c in chars.by_ref() {
                            if ('@'..='~').contains(&c) {
                                break;
                            }
                        }
                    }
                    Some(']') => {
                        for c in chars.by_ref() {
                            if c == '\x07' {
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
            s.to_lowercase()
        }

        /// Poll `check` (pumping the terminal) until it returns `Some`, or `secs` pass.
        pub(crate) fn until<T>(
            &mut self,
            secs: u64,
            mut check: impl FnMut(&mut TestTerm) -> Option<T>,
        ) -> Option<T> {
            let deadline = Instant::now() + Duration::from_secs(secs);
            loop {
                self.pump();
                if let Some(v) = check(self) {
                    return Some(v);
                }
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        pub(crate) fn wait_for(&mut self, needle: &str, secs: u64) -> bool {
            let needle = needle.to_lowercase();
            self.until(secs, |t| t.text().contains(&needle).then_some(()))
                .is_some()
        }

        /// The child's exit status, waiting at most `secs`.
        pub(crate) fn wait_exit(&mut self, secs: u64) -> Option<portable_pty::ExitStatus> {
            self.until(secs, |t| t.child.try_wait().ok().flatten())
        }

        pub(crate) fn busy_becomes(&mut self, want: bool, secs: u64) -> Option<bool> {
            let mut last = None;
            self.until(secs, |t| {
                last = t.handle.foreground_command_running();
                (last == Some(want)).then_some(())
            });
            last
        }

        pub(crate) fn type_line(&mut self, line: &str) {
            self.handle
                .write_input(format!("{line}\r").as_bytes())
                .expect("write to the PTY");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use testterm::TestTerm;

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// Every expectation written out, not read back from the table under test.
    #[test]
    fn powershell_terminals_start_with_their_startup_command_and_nothing_else_changes() {
        assert_eq!(
            POWERSHELL_UNALIAS_CURL,
            "Remove-Item Alias:curl -Force -ErrorAction SilentlyContinue"
        );
        assert_eq!(
            POWERSHELL_CWD_SYNC,
            "if (-not $global:__AgentStudioPrompt) { $global:__AgentStudioPrompt = \
             $function:prompt }; function global:prompt { & $global:__AgentStudioPrompt; \
             if ($PWD.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory \
             = $PWD.ProviderPath } catch {} } }"
        );
        assert_eq!(
            POWERSHELL_WEB_PROXY,
            r"if ($env:AGENTSTUDIO_PROXY_URL -and ($env:HTTP_PROXY -eq $env:AGENTSTUDIO_PROXY_URL)) { & { try { $u = [Uri]$env:AGENTSTUDIO_PROXY_URL; $np = @(@($env:NO_PROXY -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }); if ($np -notcontains '*') { $b = @(foreach ($e in $np) { $h = $e.TrimStart('*').TrimStart('.'); $p = '(:\d+)?'; if ($h -match '^([^:\[\]]+):(\d+)$') { $h = $matches[1]; $p = ':' + $matches[2] }; if ($h -and $h -notmatch '/') { '^[a-z][a-z0-9+.-]*://([^/]*\.)?' + [regex]::Escape($h) + $p + '$' } }); $w = [System.Net.WebProxy]::new('http://' + $u.Authority, $false, [string[]]$b); $c = $u.UserInfo -split ':', 2; $w.Credentials = [System.Net.NetworkCredential]::new([Uri]::UnescapeDataString($c[0]), 'x'); [System.Net.WebRequest]::DefaultWebProxy = $w } } catch {} } }"
        );
        // They cross CreateProcessW's command line and PowerShell's `-Command` parsing.
        assert!(!POWERSHELL_CWD_SYNC.contains('"'));
        assert!(!POWERSHELL_WEB_PROXY.contains('"'));
        let windows_ps = strings(&[
            "-NoExit",
            "-Command",
            &[
                "Remove-Item Alias:curl -Force -ErrorAction SilentlyContinue",
                POWERSHELL_WEB_PROXY,
                "if (-not $global:__AgentStudioPrompt) { $global:__AgentStudioPrompt = \
                 $function:prompt }; function global:prompt { & $global:__AgentStudioPrompt; \
                 if ($PWD.Provider.Name -eq 'FileSystem') { try { \
                 [Environment]::CurrentDirectory = $PWD.ProviderPath } catch {} } }",
            ]
            .join("; "),
        ]);
        for program in [
            "powershell",
            "powershell.exe",
            "PowerShell.EXE",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        ] {
            assert_eq!(
                shell_startup_args(program, vec![], true),
                windows_ps,
                "{program}"
            );
        }
        // PowerShell 7 has no curl alias: the cwd sync only.
        let pwsh = strings(&["-NoExit", "-Command", POWERSHELL_CWD_SYNC]);
        for program in [
            "pwsh",
            "pwsh.exe",
            "PWSH.EXE",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
        ] {
            assert_eq!(shell_startup_args(program, vec![], true), pwsh, "{program}");
        }
        // cmd and bash are not PowerShell.
        for program in [
            "cmd",
            "cmd.exe",
            "bash",
            "powershell_ise",
            "pwsh-preview",
            "",
        ] {
            assert!(
                shell_startup_args(program, vec![], true).is_empty(),
                "{program}"
            );
        }
        // A caller's own arguments are never touched.
        let own = strings(&["-NoProfile", "-File", "x.ps1"]);
        assert_eq!(shell_startup_args("powershell", own.clone(), true), own);
        assert_eq!(shell_startup_args("pwsh", own.clone(), true), own);
        // Not Windows: nothing, whatever the program is called.
        assert!(shell_startup_args("powershell", vec![], false).is_empty());
        assert!(shell_startup_args("pwsh", vec![], false).is_empty());
        assert_eq!(
            shell_startup_args("/bin/zsh", strings(&["-l"]), false),
            strings(&["-l"])
        );
    }

    fn row(pid: u32, ppid: u32, exe: &str, created: Option<u64>, gui: bool) -> ProcRow {
        ProcRow {
            pid,
            ppid,
            exe: exe.to_string(),
            created,
            gui,
        }
    }

    /// The Windows busy rule, on every OS.
    #[test]
    fn a_windows_shell_is_busy_only_with_a_console_child_born_after_it() {
        let shell = 100;
        let t0 = Some(1_000);
        // At the prompt: nothing, or only unrelated processes.
        assert_eq!(busy_descendant(shell, t0, &[]), None);
        let others = [
            row(7, 4, "svchost.exe", Some(1), false),
            row(8, 7, "ping.exe", Some(2_000), false),
        ];
        assert_eq!(busy_descendant(shell, t0, &others), None);
        // A console program it started.
        let ping = row(200, shell, "ping.exe", Some(2_000), false);
        assert_eq!(
            busy_descendant(shell, t0, std::slice::from_ref(&ping)),
            Some(200)
        );
        // Console hosts (any case, with a path) and GUI programs do not count…
        for host in [
            row(201, shell, "conhost.exe", Some(2_000), false),
            row(202, shell, "OpenConsole.exe", Some(2_000), false),
            row(
                203,
                shell,
                r"C:\Windows\System32\CONHOST.EXE",
                Some(2_000),
                false,
            ),
            row(204, shell, "notepad.exe", Some(2_000), true),
        ] {
            assert_eq!(
                busy_descendant(shell, t0, std::slice::from_ref(&host)),
                None,
                "{host:?}"
            );
        }
        // …nor what THEY start (a GUI program's console child has its own console).
        let gui = row(204, shell, "Code.exe", Some(2_000), true);
        let its_child = row(205, 204, "node.exe", Some(3_000), false);
        assert_eq!(
            busy_descendant(shell, t0, &[gui.clone(), its_child.clone()]),
            None
        );
        // A console child counts whatever else is around it.
        assert_eq!(
            busy_descendant(shell, t0, &[gui, its_child, ping.clone()]),
            Some(200)
        );
        // A process OLDER than the shell that names the shell's (reused) pid as its parent
        // is not its child; with a time missing on either side, the link is trusted.
        let stale = row(300, shell, "ping.exe", Some(500), false);
        assert_eq!(
            busy_descendant(shell, t0, std::slice::from_ref(&stale)),
            None
        );
        assert_eq!(busy_descendant(shell, None, &[stale]), Some(300));
        assert_eq!(
            busy_descendant(shell, t0, &[row(301, shell, "x.exe", None, false)]),
            Some(301)
        );
        // Born in the same tick as the shell still counts; a self-loop is not a child.
        assert_eq!(
            busy_descendant(shell, t0, &[row(302, shell, "x.exe", t0, false)]),
            Some(302)
        );
        assert_eq!(
            busy_descendant(shell, t0, &[row(shell, shell, "pwsh.exe", t0, false)]),
            None
        );
    }

    /// A minimal PE head: `MZ`, `e_lfanew`, `PE\0\0`, a COFF header, then `Subsystem` at
    /// optional-header offset 68.
    fn pe_head(e_lfanew: usize, subsystem: u16) -> Vec<u8> {
        let mut b = vec![0u8; e_lfanew + 4 + 20 + 96];
        b[0..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&(e_lfanew as u32).to_le_bytes());
        b[e_lfanew..e_lfanew + 4].copy_from_slice(b"PE\0\0");
        let at = e_lfanew + 4 + 20 + 68;
        b[at..at + 2].copy_from_slice(&subsystem.to_le_bytes());
        b
    }

    #[test]
    fn the_pe_subsystem_is_read_from_the_optional_header() {
        assert_eq!(pe_subsystem(&pe_head(0x80, 2)), Some(SUBSYSTEM_GUI));
        assert_eq!(pe_subsystem(&pe_head(0xf8, 3)), Some(3));
        // Not a PE image, or cut short: no answer (and no panic).
        let mut not_mz = pe_head(0x80, 2);
        not_mz[0] = b'X';
        assert_eq!(pe_subsystem(&not_mz), None);
        let mut not_pe = pe_head(0x80, 2);
        not_pe[0x80] = b'Q';
        assert_eq!(pe_subsystem(&not_pe), None);
        let full = pe_head(0x80, 2);
        assert_eq!(pe_subsystem(&full[..0x80 + 4 + 20 + 69]), None);
        assert_eq!(pe_subsystem(&full[..0x3e]), None);
        assert_eq!(pe_subsystem(b""), None);
        let mut far = pe_head(0x80, 2);
        far[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(pe_subsystem(&far), None);
    }

    /// The real files: Notepad is a GUI program, ping a console one.
    #[cfg(windows)]
    #[test]
    fn on_windows_notepad_reads_as_gui_and_ping_as_console() {
        let sys =
            PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32");
        let head = |exe: &str| {
            let mut f = std::fs::File::open(sys.join(exe)).expect(exe);
            let mut b = vec![0u8; 4096];
            let n = std::io::Read::read(&mut f, &mut b).unwrap();
            b.truncate(n);
            b
        };
        assert_eq!(pe_subsystem(&head("notepad.exe")), Some(SUBSYSTEM_GUI));
        assert_eq!(pe_subsystem(&head("PING.EXE")), Some(3));
    }

    /// Windows PowerShell after our startup command, then a `Set-Location` and one prompt:
    /// the PROCESS cwd is the new folder — and the user's own prompt (defined first, as a
    /// profile would) still draws, with the last command's `$?`.
    #[cfg(windows)]
    #[test]
    fn in_real_windows_powershell_the_prompt_moves_the_process_cwd() {
        use crate::spawn::NoWindow as _;
        let args = shell_startup_args("powershell", vec![], true);
        let startup = &args[2];
        let script = format!(
            "function global:prompt {{ if ($?) {{ 'ok> ' }} else {{ 'err> ' }} }}; {startup}; \
             Set-Location $env:windir; Get-Item C:\\no-such-thing -ErrorAction SilentlyContinue; \
             $p = prompt; Set-Location HKCU:\\; $null = prompt; \
             $p + '|' + [Environment]::CurrentDirectory"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .no_window()
            .output()
            .expect("powershell runs");
        let windir = std::env::var("windir").expect("windir");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim().to_lowercase(),
            format!("err> |{windir}").to_lowercase(),
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        // Without the startup command the process cwd never moves: the hook is the cause.
        let bare = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Set-Location $env:windir; $null = prompt; [Environment]::CurrentDirectory",
            ])
            .current_dir(std::env::temp_dir())
            .no_window()
            .output()
            .expect("powershell runs");
        assert_ne!(
            String::from_utf8_lossy(&bare.stdout).trim().to_lowercase(),
            windir.to_lowercase()
        );
    }

    /// Tier 2 on real Windows: a PowerShell terminal at its prompt is not busy; with an
    /// external program running (`ping` — `Start-Sleep` would start no process) it is; and
    /// once that program is interrupted it is idle again.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_terminal_is_busy_exactly_while_its_shell_runs_a_program() {
        let mut t = TestTerm::powershell(strings(&["-NoProfile", "-NoLogo"]));
        assert!(t.wait_for("PS ", 30), "no prompt: {:?}", t.text());
        assert_eq!(t.busy_becomes(false, 5), Some(false), "idle at the prompt");
        t.type_line("ping -n 30 127.0.0.1");
        assert_eq!(
            t.busy_becomes(true, 15),
            Some(true),
            "ping is running: {:?}",
            t.text()
        );
        // The ^C xterm.js sends. `ping -n 30` runs 29 s on its own, so idle within 10 s means
        // the interrupt reached it — which needs `spawn_pty`'s `allow_ctrl_c` (this test
        // process was itself started with Ctrl+C ignored, and children inherit that).
        t.handle.write_input(b"\x03").expect("^C");
        assert_eq!(
            t.busy_becomes(false, 10),
            Some(false),
            "^C stopped ping: {:?}",
            t.text()
        );
    }

    /// The cwd sync through the real ConPTY spawn path (portable-pty's own command-line
    /// quoting, then PowerShell's `-Command` parsing): after `Set-Location`, the shell
    /// process's own current directory is the new folder.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_powershell_terminal_moves_its_process_cwd_through_the_pty() {
        let mut args = strings(&["-NoProfile"]);
        args.extend(shell_startup_args("powershell", vec![], true));
        let mut t = TestTerm::powershell(args);
        assert!(t.wait_for("PS ", 30), "no prompt: {:?}", t.text());
        t.type_line("Set-Location $env:windir");
        t.type_line("'CWD=' + [Environment]::CurrentDirectory");
        let windir = std::env::var("windir").expect("windir");
        assert!(
            t.wait_for(&format!("CWD={windir}"), 20),
            "the process cwd did not follow: {:?}",
            t.text()
        );
        // …and that is what the supervisor's poller reads from outside: the shell's PEB.
        let pid = t.handle.child_pid().expect("a pid");
        let seen = t.until(10, |_| {
            crate::pty::cwd::process_cwd(pid).filter(|c| {
                let c = c.to_string_lossy().trim_end_matches('\\').to_lowercase();
                c == windir.to_lowercase()
            })
        });
        assert!(
            seen.is_some(),
            "process_cwd({pid}) = {:?}, not {windir}",
            crate::pty::cwd::process_cwd(pid)
        );
        // And `curl` is the program, as before.
        t.type_line("'CURL=' + (Get-Command curl).CommandType");
        assert!(t.wait_for("CURL=Application", 20), "{:?}", t.text());
    }

    /// A loopback HTTP responder that keeps every request head and answers `200 <tag>`.
    /// Polls with a deadline: nothing in a test blocks without one.
    #[cfg(windows)]
    fn responder(tag: &'static str) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read as _, Write as _};
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        l.set_nonblocking(true).unwrap();
        let heads = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = heads.clone();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
            while std::time::Instant::now() < deadline {
                let Ok((mut s, _)) = l.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    continue;
                };
                let _ = s.set_nonblocking(false);
                let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).into_owned();
                seen.lock().unwrap().push(head);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\
                     Connection: close\r\n\r\n{tag}",
                    tag.len()
                );
            }
        });
        (port, heads)
    }

    /// The real Windows PowerShell 5.1 with the IDE terminal's startup command and a terminal's
    /// capture env: `Invoke-WebRequest`, `Invoke-RestMethod`, `wget` and `WebClient` to a
    /// non-loopback host reach the terminal's proxy (a recorder here); a `NO_PROXY` host (and a
    /// `host:port` entry on its port only) goes direct; loopback goes direct whatever we do
    /// (.NET Framework's own rule — pinned here, so a change in it shows up). Falsified in the
    /// same run: the same commands without the startup command, or with a proxy that is not
    /// ours, never reach the recorder.
    #[cfg(windows)]
    #[test]
    fn in_real_windows_powershell_web_cmdlets_go_to_the_terminals_proxy() {
        use crate::spawn::NoWindow as _;
        let (proxy, heads) = responder("via-proxy");
        let (direct, direct_heads) = responder("direct");
        let url = format!("http://t-term-1:x@127.0.0.1:{proxy}");
        let probe = format!(
            "$ProgressPreference = 'SilentlyContinue'; \
             function T($n, $sb) {{ try {{ $n + '=' + (& $sb) }} catch {{ $n + '=ERR' }} }}; \
             T 'iwr' {{ (Invoke-WebRequest http://agent-studio-test.invalid/iwr -UseBasicParsing).Content }}; \
             T 'irm' {{ Invoke-RestMethod http://agent-studio-test.invalid/irm }}; \
             T 'wget' {{ (wget http://agent-studio-test.invalid/wget -UseBasicParsing).Content }}; \
             T 'webclient' {{ (New-Object System.Net.WebClient).DownloadString('http://agent-studio-test.invalid/wc') }}; \
             T 'noproxy' {{ (Invoke-WebRequest http://bypass.invalid/np -UseBasicParsing -TimeoutSec 10).Content }}; \
             T 'portonly' {{ (Invoke-WebRequest http://corp.invalid/p80 -UseBasicParsing).Content }}; \
             T 'loopback' {{ (Invoke-WebRequest http://127.0.0.1:{direct}/lo -UseBasicParsing).Content }}"
        );
        let run = |startup: bool, env: &[(&str, &str)]| {
            let script = if startup {
                format!("{POWERSHELL_WEB_PROXY}; {probe}")
            } else {
                probe.clone()
            };
            let mut c = std::process::Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            for k in [
                "AGENTSTUDIO_PROXY_URL",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "NO_PROXY",
            ] {
                c.env_remove(k);
            }
            for (k, v) in env {
                c.env(k, v);
            }
            let out = c.no_window().output().expect("powershell runs");
            String::from_utf8_lossy(&out.stdout).replace('\r', "")
                + &String::from_utf8_lossy(&out.stderr)
        };
        let ours = [
            ("AGENTSTUDIO_PROXY_URL", url.as_str()),
            ("HTTP_PROXY", url.as_str()),
            ("HTTPS_PROXY", url.as_str()),
            ("NO_PROXY", "bypass.invalid, corp.invalid:8443"),
        ];
        let out = run(true, &ours);
        for line in [
            "iwr=via-proxy",
            "irm=via-proxy",
            "wget=via-proxy",
            "webclient=via-proxy",
            "noproxy=ERR",
            "portonly=via-proxy",
            "loopback=direct",
        ] {
            assert!(out.lines().any(|l| l == line), "{line}: {out}");
        }
        let seen = heads.lock().unwrap().clone();
        let lines: Vec<&str> = seen.iter().filter_map(|h| h.lines().next()).collect();
        assert_eq!(
            lines,
            [
                "GET http://agent-studio-test.invalid/iwr HTTP/1.1",
                "GET http://agent-studio-test.invalid/irm HTTP/1.1",
                "GET http://agent-studio-test.invalid/wget HTTP/1.1",
                "GET http://agent-studio-test.invalid/wc HTTP/1.1",
                "GET http://corp.invalid/p80 HTTP/1.1",
            ],
            "{out}"
        );
        assert_eq!(
            direct_heads.lock().unwrap().len(),
            1,
            "only the loopback call"
        );

        // Falsify: no startup command, or a proxy that is not ours → the recorder sees nothing.
        let before = heads.lock().unwrap().len();
        let out = run(false, &ours);
        assert!(out.lines().any(|l| l == "iwr=ERR"), "{out}");
        let theirs = [
            ("AGENTSTUDIO_PROXY_URL", url.as_str()),
            ("HTTP_PROXY", "http://127.0.0.1:9"),
        ];
        let out = run(true, &theirs);
        assert!(out.lines().any(|l| l == "iwr=ERR"), "{out}");
        assert_eq!(heads.lock().unwrap().len(), before, "{out}");
    }

    /// The real Windows PowerShell: after our startup command, `curl` is the program, not the
    /// alias. Runs on Windows only.
    #[cfg(windows)]
    #[test]
    fn in_real_windows_powershell_curl_is_curl_exe_after_the_startup_command() {
        use crate::spawn::NoWindow as _;
        let script = format!("{POWERSHELL_UNALIAS_CURL}; (Get-Command curl).CommandType");
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .no_window()
            .output()
            .expect("powershell runs");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "Application",
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn pty_env_forces_transcript_persistence_and_strips_the_child_marker() {
        let (sets, removes) = pty_env_mutations(Some("en_GB.UTF-8".to_string()));
        // The inherited Claude child-session marker is removed so our agent is a
        // top-level session (transcripts on → fan-out + pinned resume work).
        assert!(removes.contains(&"CLAUDE_CODE_CHILD_SESSION"));
        // …and persistence is forced on regardless (belt).
        assert!(sets
            .iter()
            .any(|(k, v)| *k == "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE" && v == "1"));
        // Our marker + the LANG passthrough.
        assert!(sets.iter().any(|(k, v)| *k == "AGENTSTUDIO" && v == "1"));
        assert!(sets.iter().any(|(k, v)| *k == "LANG" && v == "en_GB.UTF-8"));
    }

    #[test]
    fn pty_env_defaults_lang_when_none_inherited() {
        let (sets, _) = pty_env_mutations(None);
        assert!(sets.iter().any(|(k, v)| *k == "LANG" && v == "en_US.UTF-8"));
    }
}
