//! Reading the current working directory of a live process (terminal cwd tracking).
//!
//! The terminal cwd-tracker (supervisor) polls the shell child's cwd so that, as
//! the user `cd`s around, each repo they land in gets the ad-hoc-detection hook
//! installed at its git root — so a `claude` typed there is recognised, all
//! **workspace-scoped** (never `~/.claude`).
//!
//! **This module only ever *reads* the OS's view of a process. It writes nothing.**
//! It is a thin, side-effect-free helper so the poller's logic (change detection +
//! the routed install) stays testable without a live process.
//!
//! Platform strategy:
//! - **Linux** — `readlink("/proc/<pid>/cwd")`, the canonical answer.
//! - **macOS** — `proc_pidinfo(PROC_PIDVNODEPATHINFO)`, reading
//!   `proc_vnodepathinfo.pvi_cdir.vip_path` (the same call `lsof` uses). We go
//!   through `libc` (already in the tree transitively; declaring it a direct,
//!   macOS-only dep adds no new build and no new `cargo audit` surface — same
//!   rationale as `rand`) rather than a new `libproc` crate or a hand-transcribed
//!   struct: `libc` ships the maintained, correct `proc_vnodepathinfo` layout, so
//!   there is zero FFI-layout risk.
//! - **Windows** — the process's PEB: `NtQueryInformationProcess(ProcessBasicInformation)`
//!   → `PEB.ProcessParameters` → `CurrentDirectory.DosPath`, copied out with
//!   `ReadProcessMemory` (`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` — rights a user
//!   holds on their own processes; no administrator, no prompt). ONE implementation,
//!   shared with dev-app discovery: [`crate::procscan::winproc::process_cwd`] (the walk is
//!   pure and tested on every OS in [`crate::procscan::winparse`]; the offsets of the
//!   non-public fields are proved by live Windows tests). A 32-bit (WOW64) process answers
//!   `None` — its 64-bit copy of the parameters may be stale, and a stale cwd is worse than
//!   none. **What it reads is the Win32 process cwd:** `cmd.exe`'s `cd` moves it, but
//!   Windows PowerShell's `Set-Location` moves only PowerShell's own location — the IDE's
//!   PowerShell prompt hook syncs `[Environment]::CurrentDirectory` so the two agree.
//! - **Other OSes** — `None` (best-effort, documented); ad-hoc detection there still works
//!   via the spawn-cwd install and folder-open. See `on_cwd_changed` in the supervisor.

use std::path::PathBuf;

/// The current working directory of process `pid`, or `None` when it cannot be
/// determined — a dead/unknown pid, a permission failure, a 32-bit process on Windows, or
/// a platform where we do not support it. Never panics; never writes anything.
///
/// A `None` here is deliberately *not* an error the caller reacts to: the poller
/// treats it as "no reading this tick" and simply tries again next interval (see
/// `cwd_moved` in the supervisor), so a transient failure never triggers a redundant
/// install nor loses the last-known-good cwd.
#[cfg(target_os = "linux")]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    // `/proc/<pid>/cwd` is a symlink to the process's cwd; readlink resolves it.
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

/// See the platform-agnostic doc on the Linux arm above.
#[cfg(target_os = "macos")]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    // SAFETY: `proc_pidinfo` fills the caller-provided `proc_vnodepathinfo` buffer
    // (whose layout `libc` mirrors from the SDK) and returns the number of bytes
    // written — `size` on success, `<= 0` on failure. We zero-init the buffer, hand
    // its exact size, and read only within it; nothing is written back to the OS.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    // A short/zero/negative return means the pid is gone or unreadable.
    if written < size {
        return None;
    }

    // `vip_path` is a `MAXPATHLEN` (1024) byte buffer holding a NUL-terminated cwd.
    // (`libc` types it `[[c_char; 32]; 32]` to support old rustc, so read it flat.)
    let raw = &info.pvi_cdir.vip_path as *const _ as *const u8;
    let bytes =
        unsafe { std::slice::from_raw_parts(raw, std::mem::size_of_val(&info.pvi_cdir.vip_path)) };
    let len = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    if len == 0 {
        return None; // empty path — treat as "no reading"
    }
    Some(PathBuf::from(OsStr::from_bytes(&bytes[..len])))
}

/// See the platform-agnostic doc on the Linux arm above, and the module doc's Windows
/// entry (the PEB, through the same reader dev-app discovery uses).
#[cfg(windows)]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    crate::procscan::winproc::process_cwd(pid).map(PathBuf::from)
}

/// See the platform-agnostic doc on the Linux arm above. Any other target returns
/// `None` — best-effort, documented (the workspace-scoped coverage is unaffected:
/// the spawn-cwd install and folder-open still run).
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On a platform we support, our OWN pid resolves to our OWN cwd. We read only
    /// this test process — never an arbitrary live pid — and compare against
    /// `current_dir`. Canonicalized on both sides: the OS reports the real,
    /// symlink-resolved path (macOS `/tmp` → `/private/tmp`), which `current_dir`
    /// may not.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn own_pid_reports_own_cwd() {
        let got = process_cwd(std::process::id()).expect("should read our own cwd");
        let expected = std::env::current_dir().unwrap();
        assert_eq!(
            got.canonicalize().unwrap(),
            expected.canonicalize().unwrap(),
            "process_cwd(self) must equal our current_dir"
        );
    }

    /// A pid that cannot be running resolves to `None` — never a panic, never a
    /// bogus path. (Positive and far above any real pid, so it is a valid `c_int`
    /// and not the special `-1`.)
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn a_bogus_pid_is_none() {
        assert!(
            process_cwd(999_999_999).is_none(),
            "a non-existent pid must not resolve to a path"
        );
    }

    /// Windows: a real child's cwd is the directory it was started in — read from ANOTHER
    /// process's PEB, not only our own — and it follows a `cd` made with `cmd.exe` (which,
    /// unlike PowerShell's `Set-Location`, moves the Win32 process cwd).
    #[cfg(windows)]
    #[test]
    fn a_childs_cwd_is_read_and_follows_a_cmd_cd() {
        use crate::spawn::NoWindow;
        use std::io::Write;
        let raw = std::env::temp_dir().join(format!("agentstudio-cwd-{}", std::process::id()));
        std::fs::create_dir_all(raw.join("sub")).unwrap();
        let plain = |p: &std::path::Path| {
            let s = p.to_string_lossy().into_owned();
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        };
        // The long, non-verbatim spelling (`temp_dir` may be an 8.3 short path).
        let base = std::path::PathBuf::from(plain(&raw.canonicalize().unwrap()));
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/q", "/k"])
            .current_dir(&base)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .no_window()
            .spawn()
            .expect("cmd starts");
        let pid = child.id();
        let until = |want: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                let got = process_cwd(pid).map(|p| p.to_string_lossy().into_owned());
                if got.as_deref().is_some_and(|g| g.eq_ignore_ascii_case(want)) {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "{got:?} never became {want}"
                );
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        until(&plain(&base));
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "cd sub").unwrap();
        stdin.flush().unwrap();
        until(&plain(&base.join("sub")));
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&base);
    }
}
