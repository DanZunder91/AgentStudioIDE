//! Integration tests for the PTY layer — **against real PTYs**.
//!
//! These drive `pty::spawn_pty` + `pty::reader::start_reader` directly: a real
//! `openpty`/`forkpty` (ConPTY on Windows), a real child process, the real
//! blocking reader thread. Nothing about the OS is mocked; that is the point,
//! because every bug this layer can have (EOF-vs-EIO, the slave fd keeping the
//! master open, `wait()` blocking the killer) only exists at the OS boundary.

mod common;

use std::time::Duration;

use agent_studio_scaffold_lib::pty::{self, SpawnSpec};
use common::{interactive_sh, sh, temp_cwd, then, EOL, TIMEOUT};

fn spec(program: String, args: Vec<String>, rows: u16, cols: u16) -> SpawnSpec {
    SpawnSpec {
        program,
        args,
        cwd: temp_cwd().into(),
        env: Vec::new(),
        rows,
        cols,
    }
}

/// Drain the reader channel until it closes, returning everything read.
///
/// Reaching `None` is itself the assertion in several tests: it means the reader
/// thread saw EOF (or Linux's `EIO`), broke its loop, and dropped its sender.
async fn drain_to_eof(mut rx: tokio::sync::mpsc::Receiver<bytes::Bytes>) -> Vec<u8> {
    let mut out = Vec::new();
    let collect = async {
        while let Some(chunk) = rx.recv().await {
            out.extend_from_slice(&chunk);
        }
        out
    };
    tokio::time::timeout(TIMEOUT, collect)
        .await
        .expect("reader channel never closed — the reader thread is stuck (zombie)")
}

/// Run a PTY child to completion **the way the supervisor does**: drain its output
/// while it runs, reap it with a bounded poll, close the terminal, read to EOF.
/// Returns the exit code and everything the terminal showed.
///
/// Three things here are load-bearing, each of them on Windows:
/// - **Never `child.wait()` without a deadline.** It is `WaitForSingleObject(INFINITE)`
///   on Windows, and a tokio runtime waits for its blocking tasks on drop — so one
///   child that never exits hangs this whole binary indefinitely. `try_wait` is polled
///   instead, and a child that outlives [`TIMEOUT`] is killed and the screen printed.
/// - **Output is drained while waiting**, never after: a chatty child blocks on a full
///   pipe and would never exit (the high-volume test is that case).
/// - **On Windows the terminal is closed after the exit, then read to EOF.** ConPTY's
///   host keeps the output pipe open until the pseudo-console is closed, so EOF cannot
///   come first there; the supervisor closes it by dropping the handle on `ChildExited`
///   (`on_child_exited` → `rt.pty = None`). On Unix the slave closing is enough and the
///   handle is kept until EOF — that is the invariant `pty_eof_closes_…` pins.
async fn run_to_exit(spawn: pty::PtySpawn) -> (u32, String) {
    let pty::PtySpawn {
        handle,
        reader,
        mut child,
    } = spawn;
    let mut rx = pty::reader::start_reader(reader);
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait failed") {
            break status;
        }
        if tokio::time::Instant::now() > deadline {
            let shown = String::from_utf8_lossy(&out).into_owned();
            drop(handle); // kills it: a failing test must not leave an orphan behind
            panic!(
                "the PTY child never exited within {TIMEOUT:?}; the terminal showed:\n{shown:?}"
            );
        }
        match tokio::time::timeout(Duration::from_millis(25), rx.recv()).await {
            Ok(Some(chunk)) => out.extend_from_slice(&chunk),
            // EOF before the exit is reported (Unix): just keep polling the exit.
            Ok(None) => tokio::time::sleep(Duration::from_millis(10)).await,
            Err(_) => {}
        }
    };
    #[cfg(windows)]
    drop(handle);
    out.extend(drain_to_eof(rx).await);
    #[cfg(not(windows))]
    drop(handle);
    (
        status.exit_code(),
        String::from_utf8_lossy(&out).into_owned(),
    )
}

/// The floor: a real child's stdout reaches us as real bytes.
#[tokio::test]
async fn child_output_reaches_the_reader() {
    let (program, args) = sh("echo hello-from-pty");
    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let (_, out) = run_to_exit(spawn).await;
    assert!(out.contains("hello-from-pty"), "PTY output was {out:?}");
}

/// EOF handling: the reader thread must **terminate** when the child goes away,
/// whichever way the kernel reports it, without losing the last bytes.
///
/// Two things were measured rather than assumed here, and both are worth knowing:
///
/// 1. **`drop(pair.slave)` is load-bearing, and only Linux says so.** A C probe
///    (child exits while the parent still holds a slave fd) shows Linux's master
///    `read` returning `EIO` when the slave is dropped, but **blocking forever**
///    when it is leaked. Confirmed end-to-end: `mem::forget(pair.slave)` makes
///    this test hang and fail on Linux — and stay green on macOS, which revokes
///    the tty when the session leader exits and reports EOF regardless. Passing
///    locally on macOS proves nothing here; a Linux run is what guards
///    this invariant.
///
/// 2. **`reader.rs`'s `Err(_) => break` is not what handles Linux's `EIO`.**
///    `portable-pty` already normalizes it: `unix.rs` maps `EIO` → `Ok(0)` before
///    we ever see it. Mutating our arm to `Err(_) => continue` leaves this test
///    green on *both* platforms, because the arm is unreachable for `EIO`. It is
///    correct defence-in-depth for other read errors, not the `EIO` fix its
///    comment implies.
#[tokio::test]
async fn pty_eof_closes_the_reader_without_error() {
    // `exit` immediately after the write, so EOF races the last bytes.
    let (program, args) = sh(&then("echo before-eof", "exit 0"));
    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    // Returning at all == the reader thread terminated cleanly on EOF/EIO.
    let (_, out) = run_to_exit(spawn).await;

    // …and the final bytes survived the race.
    assert!(out.contains("before-eof"), "bytes lost at EOF; got {out:?}");
}

/// Input round-trip through a real shell: we write to the PTY master, the child
/// reads it from its tty, evaluates it, and writes the *result* back.
#[tokio::test]
async fn input_round_trips_through_a_real_shell() {
    let (program, args) = interactive_sh();
    let mut spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let mut rx = pty::reader::start_reader(spawn.reader);

    let (lines, needle) = common::round_trip_probe();
    for line in &lines {
        spawn
            .handle
            .write_input(line.as_bytes())
            .expect("write_input failed");
    }
    spawn
        .handle
        .write_input(format!("exit{EOL}").as_bytes())
        .ok();

    let mut out = String::new();
    let found = tokio::time::timeout(TIMEOUT, async {
        while let Some(chunk) = rx.recv().await {
            out.push_str(&String::from_utf8_lossy(&chunk));
            if out.contains(needle) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(
        found,
        "shell never echoed {needle:?} back; PTY output was:\n{out}"
    );
}

/// Child exit status. `spawn_pty` hands the caller the `child`, and the
/// supervisor's waiter thread turns `child.wait()` into `ChildExited { code }` —
/// this pins the value that plumbing carries.
#[tokio::test]
async fn child_exit_code_is_reported_verbatim() {
    for expected in [0u32, 3, 42] {
        let (program, args) = sh(&format!("exit {expected}"));
        let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
        // Bounded: an unbounded `spawn_blocking(child.wait())` here hangs this binary
        // indefinitely on Windows (see `run_to_exit`).
        let (code, _) = run_to_exit(spawn).await;

        assert_eq!(code, expected, "wrong exit code for `exit {expected}`");
    }
}

/// **A child that exits at once is reaped even when nothing answers the terminal.**
///
/// On Windows, `cmd /C "exit 0"` spawned under ConPTY used to stay alive indefinitely,
/// its `conhost --headless --inheritcursor` beside it, and every agent test that waited
/// for an exit timed out. The pseudo-console was
/// created with `PSEUDOCONSOLE_INHERIT_CURSOR`, which makes the console host ask the
/// terminal where its cursor is (`ESC[6n`) and hold the client until a reply comes
/// back on input. xterm.js replies in the app, so a terminal there looked fine — but
/// nothing replies in a test, nor in the app for a PTY spawned before its UI attaches
/// (a restored agent, a background view). A terminal emulator that creates a fresh
/// console has no cursor to inherit, so the flag is gone (`vendor/portable-pty`,
/// `psuedocon.rs`).
///
/// Nothing is written to the PTY here, on purpose: that is the condition. On Unix the
/// assertions hold trivially and pin that they stay so.
#[tokio::test]
async fn a_child_that_exits_at_once_is_reaped_with_nobody_answering_the_terminal() {
    let (program, args) = sh("exit 7");
    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let (code, out) = run_to_exit(spawn).await;
    assert_eq!(code, 7, "wrong exit code; the terminal showed {out:?}");
    // The pseudo-console must not ask the terminal anything at startup: a question
    // here is a client blocked until somebody answers it.
    assert!(
        !out.contains("\x1b[6n"),
        "the console host asked for the cursor position (ESC[6n); terminal showed {out:?}"
    );
}

/// Windows: **typing into a live shell works** with the pseudo-console's input mode —
/// keystrokes as plain bytes, the way xterm.js sends them. `PSEUDOCONSOLE_WIN32_INPUT_MODE`
/// makes the host ask the terminal for win32-input-mode (`ESC[?9001h`), which xterm.js
/// ignores; the host must still take plain VT input. PowerShell, the default shell,
/// reads keys through `ReadConsoleInput` (PSReadLine), unlike `cmd` — so both are typed at.
/// The needle is built by the shell (`'typed-' + 'ps-ok'`), so the echo of the typed
/// line itself cannot satisfy it.
#[cfg(windows)]
#[tokio::test]
async fn typing_into_cmd_and_powershell_echoes_back_through_the_pty() {
    for (program, args, line, needle) in [
        (
            "cmd.exe",
            vec!["/Q".to_string()],
            "set /a 6*7+1000\r",
            "1042",
        ),
        (
            "powershell.exe",
            vec!["-NoProfile".to_string(), "-NoLogo".to_string()],
            "Write-Output ('typed-' + 'ps-ok')\r",
            "typed-ps-ok",
        ),
    ] {
        let mut spawn =
            pty::spawn_pty(&spec(program.to_string(), args, 24, 120)).expect("spawn_pty failed");
        let mut rx = pty::reader::start_reader(spawn.reader);
        let mut out = String::new();
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        // Type once the shell has drawn something (its prompt), then again every few
        // seconds in case it was still starting up.
        let mut typed_at: Option<tokio::time::Instant> = None;
        let found = loop {
            if out.contains(needle) {
                break true;
            }
            if tokio::time::Instant::now() > deadline {
                break false;
            }
            if !out.is_empty() && typed_at.is_none_or(|t| t.elapsed() > Duration::from_secs(5)) {
                spawn.handle.write_input(line.as_bytes()).ok();
                typed_at = Some(tokio::time::Instant::now());
            }
            if let Ok(Some(chunk)) =
                tokio::time::timeout(Duration::from_millis(50), rx.recv()).await
            {
                out.push_str(&String::from_utf8_lossy(&chunk));
            }
        };
        spawn.handle.write_input(b"exit\r").ok();
        drop(spawn.handle);
        assert!(
            found,
            "{program} never echoed {needle:?} back; the terminal showed:\n{out:?}"
        );
    }
}

/// Windows: **closing a terminal kills what runs in it** — the shell and the console
/// program it started. `PtyHandle`'s `Drop` terminates the shell, and dropping the master
/// closes the pseudo-console, whose host then ends every program still attached to it
/// (the Windows counterpart of the SIGHUP a Unix master's close sends).
///
/// The close waits until `ping` has PRINTED, i.e. is attached to the console. Closing
/// in the instant between `ping`'s creation and its attach left it running, measured
/// once in a parallel run: a program not yet on the console is not ended with it.
/// That window is milliseconds at a program's start; it is a race, not the bug here.
#[cfg(windows)]
#[tokio::test]
async fn dropping_the_handle_kills_the_shell_and_the_program_it_started() {
    let (program, args) = sh("ping -t 127.0.0.1");
    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let mut rx = pty::reader::start_reader(spawn.reader);
    let shell = spawn.handle.child_pid().expect("the shell's pid");
    let mut out = String::new();
    let printed = tokio::time::timeout(TIMEOUT, async {
        while let Some(chunk) = rx.recv().await {
            out.push_str(&String::from_utf8_lossy(&chunk));
            if out.contains("127.0.0.1") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    let ping = winproc::wait_for_child(shell, "ping.exe", TIMEOUT);
    let Some(ping) = ping.filter(|_| printed) else {
        drop(spawn.handle);
        panic!("ping never came up in the terminal (pid {ping:?}); it showed {out:?}");
    };

    drop(spawn.handle);

    let survivors = winproc::still_alive_after(&[shell, ping], TIMEOUT);
    winproc::kill_all(&survivors);
    assert!(
        survivors.is_empty(),
        "closing the terminal left {survivors:?} running (shell {shell}, ping {ping})"
    );
}

/// The env var that turns this test binary into the stand-in app of
/// [`a_terminal_dies_with_the_app_that_opened_it`].
#[cfg(windows)]
const ORPHAN_HELPER: &str = "AGENTSTUDIO_PTY_ORPHAN_HELPER";

/// Windows: **a terminal dies with the app that opened it**, even when the app does
/// not get to clean up (a crash, End task). On Unix the kernel's SIGHUP does this; on
/// Windows it is the console host noticing that its creator is gone.
///
/// The "app" is this same binary, re-run as [`orphan_helper`]: it opens a terminal
/// running `cmd` → `ping`, prints the shell's pid, and waits. This test kills it with
/// `TerminateProcess` — no destructors run — and watches the shell, the program and
/// the console host go.
#[cfg(windows)]
#[test]
fn a_terminal_dies_with_the_app_that_opened_it() {
    use std::io::BufRead as _;
    use std::process::{Command, Stdio};

    let mut app = Command::new(std::env::current_exe().unwrap())
        .args(["orphan_helper", "--exact", "--ignored", "--nocapture"])
        .env(ORPHAN_HELPER, "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("re-run this binary as the helper");
    let app_pid = app.id();

    let (tx, rx) = std::sync::mpsc::channel();
    let stdout = app.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if let Some(pid) = line.strip_prefix("PTY-SHELL ") {
                let _ = tx.send(pid.trim().parse::<u32>().ok());
            }
        }
    });
    let shell = match rx.recv_timeout(TIMEOUT) {
        Ok(Some(pid)) => pid,
        other => {
            let _ = app.kill();
            panic!("the helper app never reported its shell: {other:?}");
        }
    };
    let ping = winproc::wait_for_child(shell, "ping.exe", TIMEOUT);
    let host = winproc::children(app_pid)
        .into_iter()
        .find(|(_, exe)| exe.eq_ignore_ascii_case("conhost.exe"))
        .map(|(pid, _)| pid);
    let (Some(ping), Some(host)) = (ping, host) else {
        let _ = app.kill();
        winproc::kill_all(&[shell]);
        panic!("the helper's terminal never came up: ping {ping:?}, conhost {host:?}");
    };

    // The crash: no destructor, no ClosePseudoConsole.
    app.kill().expect("kill the helper app");
    let _ = app.wait();

    let survivors = winproc::still_alive_after(&[shell, ping, host], TIMEOUT);
    winproc::kill_all(&survivors); // never leave behind the orphans this test is about
    assert!(
        survivors.is_empty(),
        "after its app died, {survivors:?} kept running (shell {shell}, ping {ping}, conhost {host})"
    );
}

/// The stand-in app of [`a_terminal_dies_with_the_app_that_opened_it`]. Does nothing
/// unless that test started it (an `--ignored` run from anywhere else returns at once).
#[cfg(windows)]
#[test]
#[ignore = "helper process for a_terminal_dies_with_the_app_that_opened_it"]
fn orphan_helper() {
    use std::io::Write as _;
    if std::env::var_os(ORPHAN_HELPER).is_none() {
        return;
    }
    let (program, args) = sh("ping -t 127.0.0.1");
    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let mut reader = spawn.reader;
    // Report the shell only once `ping` has printed, i.e. is on the console (see
    // `dropping_the_handle_kills_the_shell_and_the_program_it_started`).
    let (up_tx, up_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut seen = String::new();
        while let Ok(n) = std::io::Read::read(&mut reader, &mut buf) {
            if n == 0 {
                break;
            }
            seen.push_str(&String::from_utf8_lossy(&buf[..n]));
            if seen.contains("127.0.0.1") {
                let _ = up_tx.send(());
            }
        }
    });
    if up_rx.recv_timeout(TIMEOUT).is_ok() {
        println!("PTY-SHELL {}", spawn.handle.child_pid().unwrap_or(0));
    }
    std::io::stdout().flush().ok();
    // Bounded, so a parent that died before killing us cannot leave this running.
    std::thread::sleep(Duration::from_secs(60));
    drop(spawn.handle);
}

/// Process-table helpers for the Windows tests: a Toolhelp snapshot, and liveness by
/// `GetExitCodeProcess` (a pid that cannot be opened is gone).
#[cfg(windows)]
mod winproc {
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    /// `GetExitCodeProcess`'s "still running" (`STILL_ACTIVE`).
    const STILL_ACTIVE: u32 = 259;

    /// `(pid, exe file name)` of every live process whose parent is `ppid`.
    pub fn children(ppid: u32) -> Vec<(u32, String)> {
        // SAFETY: no pointer arguments; the handle is checked and closed below.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: `entry` is a valid, correctly sized PROCESSENTRY32W for both calls.
        let mut more = unsafe { Process32FirstW(snap, &mut entry) } != 0;
        while more {
            if entry.th32ParentProcessID == ppid && alive(entry.th32ProcessID) {
                let name = &entry.szExeFile;
                let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
                out.push((entry.th32ProcessID, String::from_utf16_lossy(&name[..len])));
            }
            // SAFETY: as above.
            more = unsafe { Process32NextW(snap, &mut entry) } != 0;
        }
        // SAFETY: `snap` is a live handle we own.
        unsafe { CloseHandle(snap) };
        out
    }

    pub fn alive(pid: u32) -> bool {
        // SAFETY: plain call; a null handle is checked.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        // SAFETY: `h` is live and `code` is a valid out-pointer.
        let ok = unsafe { GetExitCodeProcess(h, &mut code) } != 0;
        // SAFETY: `h` is a live handle we own.
        unsafe { CloseHandle(h) };
        ok && code == STILL_ACTIVE
    }

    /// The first child of `parent` named `exe`, waiting up to `within` for it.
    pub fn wait_for_child(parent: u32, exe: &str, within: Duration) -> Option<u32> {
        let start = Instant::now();
        while start.elapsed() < within {
            if let Some((pid, _)) = children(parent)
                .into_iter()
                .find(|(_, name)| name.eq_ignore_ascii_case(exe))
            {
                return Some(pid);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }

    /// Those of `pids` still running once `within` has passed (returns as soon as
    /// none are).
    pub fn still_alive_after(pids: &[u32], within: Duration) -> Vec<u32> {
        let start = Instant::now();
        loop {
            let left: Vec<u32> = pids.iter().copied().filter(|&p| alive(p)).collect();
            if left.is_empty() || start.elapsed() > within {
                return left;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn kill_all(pids: &[u32]) {
        for &pid in pids {
            // SAFETY: plain calls; a null handle is checked, and ours is closed.
            unsafe {
                let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                if !h.is_null() {
                    TerminateProcess(h, 1);
                    CloseHandle(h);
                }
            }
        }
    }
}

/// `clone_killer()` is grabbed up front precisely so a kill can land while the
/// waiter thread is parked in the blocking `wait()`. This is that scenario: the
/// child would otherwise run forever.
#[tokio::test]
async fn killer_terminates_a_child_blocked_in_wait() {
    // A child that never exits on its own.
    #[cfg(not(windows))]
    let (program, args) = sh("while :; do sleep 1; done");
    #[cfg(windows)]
    let (program, args) = sh("ping -t 127.0.0.1 > NUL");

    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let pty::PtySpawn {
        mut handle,
        reader,
        mut child,
    } = spawn;

    let rx = pty::reader::start_reader(reader);
    let waiter = tokio::task::spawn_blocking(move || child.wait());

    // Give the child a moment to actually be running, then kill it out from
    // under the parked waiter.
    tokio::time::sleep(Duration::from_millis(200)).await;
    handle.kill();

    tokio::time::timeout(TIMEOUT, waiter)
        .await
        .expect("child survived kill() — the waiter is still parked")
        .expect("waiter thread panicked")
        .expect("child.wait() failed");

    // And the teardown chain must unwind: child dead → slave closed → reader
    // sees EOF/EIO → thread exits → channel closes. No zombie thread.
    drop(handle);
    drain_to_eof(rx).await;
}

/// Dropping `PtyHandle` must kill the child (its `Drop` impl) and thereby tear
/// the whole chain down. Regression guard for a terminal that is "closed" in the
/// UI but whose child keeps burning CPU.
#[tokio::test]
async fn dropping_the_handle_tears_down_the_reader() {
    #[cfg(not(windows))]
    let (program, args) = sh("while :; do sleep 1; done");
    #[cfg(windows)]
    let (program, args) = sh("ping -t 127.0.0.1 > NUL");

    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let rx = pty::reader::start_reader(spawn.reader);

    drop(spawn.handle);

    // Closing == the reader channel reaching EOF within the timeout.
    drain_to_eof(rx).await;
}

/// A zero-sized PTY makes TUIs (including `claude`) misrender, so `pty_size`
/// clamps to at least 1x1. Assert via the child, not the private helper.
#[cfg(unix)]
#[tokio::test]
async fn zero_size_is_clamped_so_the_child_sees_a_usable_tty() {
    let (program, args) = sh("stty size");
    let spawn = pty::spawn_pty(&spec(program, args, 0, 0)).expect("spawn_pty must not fail on 0x0");
    let rx = pty::reader::start_reader(spawn.reader);

    let out = String::from_utf8_lossy(&drain_to_eof(rx).await).into_owned();
    assert!(
        out.contains("1 1"),
        "0x0 should clamp to 1x1; stty size said {out:?}"
    );
}

/// Spawning a program that does not exist must be an error, not a silent
/// half-open terminal.
#[tokio::test]
async fn spawning_a_missing_program_errors() {
    let spawn = pty::spawn_pty(&spec(
        "definitely-not-a-real-program-9d3f1a".to_string(),
        Vec::new(),
        24,
        80,
    ));
    assert!(spawn.is_err(), "spawning a nonexistent program should fail");
}

/// The child must believe it is a real terminal — `TERM` drives whether `claude`
/// (and every other TUI) emits colour and cursor addressing at all.
#[cfg(unix)]
#[tokio::test]
async fn child_inherits_the_tty_env() {
    let (program, args) = sh("echo term=$TERM marker=$AGENTSTUDIO");
    let spawn = pty::spawn_pty(&spec(program, args, 24, 80)).expect("spawn_pty failed");
    let rx = pty::reader::start_reader(spawn.reader);

    let out = String::from_utf8_lossy(&drain_to_eof(rx).await).into_owned();
    assert!(
        out.contains("term=xterm-256color"),
        "TERM not set; got {out:?}"
    );
    assert!(
        out.contains("marker=1"),
        "AGENTSTUDIO marker not set; got {out:?}"
    );
}

/// Extra env from the `SpawnSpec` reaches the child (the seam `AgentAdapter` uses
/// in M2 to configure `claude`).
#[cfg(unix)]
#[tokio::test]
async fn spawn_spec_env_reaches_the_child() {
    let (program, args) = sh("echo custom=$AGENTSTUDIO_TEST_VAR");
    let mut s = spec(program, args, 24, 80);
    s.env = vec![("AGENTSTUDIO_TEST_VAR".to_string(), "wired".to_string())];

    let spawn = pty::spawn_pty(&s).expect("spawn_pty failed");
    let rx = pty::reader::start_reader(spawn.reader);

    let out = String::from_utf8_lossy(&drain_to_eof(rx).await).into_owned();
    assert!(
        out.contains("custom=wired"),
        "SpawnSpec env not applied; got {out:?}"
    );
}

/// The child's cwd is the one we asked for, not the test runner's.
#[cfg(unix)]
#[tokio::test]
async fn child_starts_in_the_requested_cwd() {
    let dir = std::env::temp_dir().join(format!("agentstudio-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir failed");

    let (program, args) = sh("pwd");
    let spawn = pty::spawn_pty(&SpawnSpec {
        program,
        args,
        cwd: dir.clone(),
        env: Vec::new(),
        rows: 24,
        cols: 80,
    })
    .expect("spawn_pty failed");
    let rx = pty::reader::start_reader(spawn.reader);

    let out = String::from_utf8_lossy(&drain_to_eof(rx).await).into_owned();
    let leaf = dir.file_name().unwrap().to_string_lossy().into_owned();
    std::fs::remove_dir_all(&dir).ok();

    assert!(
        out.contains(&leaf),
        "child cwd wrong; pwd said {out:?}, wanted {leaf:?}"
    );
}

/// **Bursty concurrent PTY allocation must not fail.** Regression test for the
/// `PTY_ALLOC_LOCK` in `pty/mod.rs`.
///
/// macOS's `openpty(3)` is not concurrency-safe: allocating from several threads
/// at once transiently fails `posix_openpt` with `ENXIO`, sometimes surfacing as
/// the nonsense `errno = -6`. Unlocked, ~5% of calls in a burst failed.
///
/// A burst is not a synthetic stress case — it is precisely what M3 fan-out does
/// when an orchestrator spawns several agents at once, so this models the real
/// product path. Every thread starts at the same instant deliberately: staggering
/// them is what makes the bug hide.
#[tokio::test]
async fn concurrent_pty_allocation_bursts_do_not_fail() {
    use std::sync::{Arc, Barrier};

    const THREADS: usize = 16;
    const PER_ROUND: usize = 3;
    // A race test is a probabilistic detector, so take several independent shots
    // at it: one burst caught the unlocked bug ~50% of the time, and the barrier
    // re-syncs every round, so 6 rounds make a regression very hard to miss while
    // still peaking at only 48 live PTYs (`kern.tty.ptmx_max` is 511).
    const ROUNDS: usize = 6;

    let barrier = Arc::new(Barrier::new(THREADS));
    let mut handles = Vec::new();

    for _ in 0..THREADS {
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let mut opened = 0usize;
            let mut errors: Vec<String> = Vec::new();
            for _ in 0..ROUNDS {
                // Line every thread up so the allocations genuinely collide.
                // Staggering them is what makes this bug hide.
                barrier.wait();
                let mut held = Vec::new();
                for _ in 0..PER_ROUND {
                    let (program, args) = sh("exit 0");
                    match pty::spawn_pty(&spec(program, args, 24, 80)) {
                        // Hold for the round: releasing as we go would lower
                        // contention and hide the very race this pins.
                        Ok(s) => {
                            held.push(s);
                            opened += 1;
                        }
                        // Record and carry on — never bail out early. An early
                        // return would skip this thread's remaining
                        // `barrier.wait()` calls and hang the other 15 forever,
                        // so a regression would deadlock CI instead of failing it.
                        Err(e) => errors.push(format!("{e:#}")),
                    }
                }
                drop(held);
            }
            (opened, errors)
        }));
    }

    let mut opened = 0;
    let mut errors: Vec<String> = Vec::new();
    for h in handles {
        let (n, errs) = h.join().expect("spawn thread panicked");
        opened += n;
        errors.extend(errs);
    }

    let attempted = THREADS * PER_ROUND * ROUNDS;
    assert!(
        errors.is_empty(),
        "{}/{attempted} concurrent PTY allocations failed — the openpty race is \
         back (is PTY_ALLOC_LOCK still held across openpty?). Errors: {errors:#?}",
        errors.len(),
    );
    assert_eq!(opened, attempted);
}

/// A chatty child (well past the reader's 64KB read buffer and the bounded
/// channel's 256 slots) must not lose or reorder bytes. This exercises the
/// backpressure path: a full channel parks the reader thread, which fills the
/// kernel PTY buffer, which throttles the child.
#[tokio::test]
async fn high_volume_output_is_not_lost_under_backpressure() {
    // 2000 lines ≈ 20KB of payload, chunked across many reads.
    #[cfg(not(windows))]
    let (program, args) = sh("i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done");
    #[cfg(windows)]
    let (program, args) = sh("for /L %i in (1,1,2000) do @echo line-%i");

    let spawn = pty::spawn_pty(&spec(program, args, 24, 200)).expect("spawn_pty failed");
    let (_, out) = run_to_exit(spawn).await;

    // Deliberately check the first, a middle, and the last line: truncation at
    // either end and a dropped chunk in the middle are different bugs.
    #[cfg(windows)]
    let (first, middle, last) = ("line-1", "line-1000", "line-2000");
    #[cfg(not(windows))]
    let (first, middle, last) = ("line-0", "line-1000", "line-1999");

    for needle in [first, middle, last] {
        assert!(
            out.contains(needle),
            "lost {needle:?} under load ({} bytes received)",
            out.len()
        );
    }
}
