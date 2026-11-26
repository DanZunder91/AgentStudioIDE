//! Reads a live process's cwd for terminal cwd tracking; writes nothing (never `~/.claude`).
//! Linux `/proc/<pid>/cwd`; macOS `proc_pidinfo(PROC_PIDVNODEPATHINFO)` with `libc`'s layout;
//! Windows [`crate::procscan::winproc::process_cwd`] (WOW64 → `None`); other OSes `None`.

use std::path::PathBuf;

/// `pid`'s cwd, or `None` when unreadable (dead pid, permission, WOW64, unsupported OS).
/// The poller treats `None` as "no reading this tick", not an error, and keeps the last good cwd.
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

    // SAFETY: `proc_pidinfo` fills the zeroed `libc`-layout buffer of exactly `size` bytes and
    // returns the bytes written (`size` on success, `<= 0` on failure); we read only within it.
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

    /// Reads only this test's own pid. Both sides canonicalized: the OS reports the resolved
    /// path (macOS `/tmp` → `/private/tmp`), which `current_dir` may not.
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
