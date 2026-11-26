//! Integration tests of the PTY layer against real PTYs, children and reader threads. Nothing is
//! mocked: its bugs (EOF vs EIO, the slave fd keeping the master open, `wait()` blocking the
//! killer) only exist at the OS boundary.

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

/// Reaching `None` is itself an assertion: the reader thread saw EOF (or Linux's `EIO`), broke its
/// loop, and dropped its sender.
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

/// Runs a child as the supervisor does. Poll `try_wait` (Windows `wait()` is INFINITE and hangs the
/// runtime's drop); drain while waiting (a full pipe blocks the child); on Windows close the PTY
/// before reading to EOF, as ConPTY keeps the pipe open until then (Unix keeps it until EOF).
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

/// `drop(pair.slave)` is load-bearing only on Linux: a leaked slave makes the master read block
/// forever, while macOS reports EOF regardless, so only a Linux run guards it. Linux's `EIO` never
/// reaches `reader.rs`'s error arm: `portable-pty` maps it to `Ok(0)`.
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

/// With `PSEUDOCONSOLE_INHERIT_CURSOR` ConPTY asks for the cursor (`ESC[6n`) and holds the child
/// until a reply; nothing replies in a test or before the UI attaches, so the vendored portable-pty
/// drops the flag (`psuedocon.rs`). Nothing is written to the PTY: that is the condition.
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

/// `PSEUDOCONSOLE_WIN32_INPUT_MODE` asks for win32-input-mode, which xterm.js ignores, so the host
/// must take plain VT bytes. PowerShell reads via `ReadConsoleInput`, unlike `cmd`, so both are
/// typed at. The needle is built by the shell so the echoed input cannot satisfy it.
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

/// `PtyHandle`'s Drop ends the shell; closing the pseudo-console ends programs attached to it
/// (Windows' SIGHUP). The close waits until `ping` has printed: a program not yet attached is not
/// ended with it, a startup race that is not the bug here.
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

/// With no cleanup (a crash, End task) the console host ends once its creator is gone. The app is
/// this binary re-run as [`orphan_helper`] (opens `cmd` then `ping`, prints the shell's pid),
/// killed with `TerminateProcess` so no destructors run.
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

/// Guards `PTY_ALLOC_LOCK` (`pty/mod.rs`): macOS's `openpty(3)` is not concurrency-safe and a
/// burst fails `posix_openpt` with `ENXIO` (or `errno = -6`). Fan-out allocates in bursts; all
/// threads start at once on purpose, because staggering them hides the bug.
#[tokio::test]
async fn concurrent_pty_allocation_bursts_do_not_fail() {
    use std::sync::{Arc, Barrier};

    const THREADS: usize = 16;
    const PER_ROUND: usize = 3;
    // One burst caught the unlocked race ~50% of the time, so 6 rounds make a regression hard to
    // miss while peaking at 48 live PTYs (`kern.tty.ptmx_max` is 511).
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
                        // Never bail early: skipping this thread's remaining
                        // `barrier.wait()` calls would hang the others, not fail.
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

/// Past the reader's 64KB buffer and the channel's 256 slots: a full channel parks the reader,
/// which fills the kernel PTY buffer, which throttles the child.
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
