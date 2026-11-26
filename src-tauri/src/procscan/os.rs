//! Reads this user's processes only, with no OS permission (macOS libproc/sysctl, Linux `/proc`,
//! Windows via [`super::winproc`]); byte parsers are pure. The env is read only by [`read_env`]
//! and never leaves it; the one write is [`sigterm`] (Windows: `TerminateProcess`) for Restart.

use super::logfiles::Fd;

/// One process, before classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawProc {
    pub pid: u32,
    pub ppid: u32,
    pub exe: Option<String>,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub started_ms: Option<i64>,
    /// Empty until [`inspect`] fills it (only dev-app candidates are inspected).
    pub fds: Vec<Fd>,
}

/// `KERN_PROCARGS2`: `int argc`, the exec path, NUL padding, `argc` NUL-terminated argv
/// strings, then the environment's `K=V` strings until an empty one. Returns
/// `(exec path, argv, env)`; `None` for a buffer too short to hold `argc`.
pub fn parse_procargs2(buf: &[u8]) -> Option<(String, Vec<String>, Vec<String>)> {
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?);
    let argc = usize::try_from(argc).ok()?;
    let rest = &buf[4..];
    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    let exec = String::from_utf8_lossy(&rest[..end]).into_owned();
    let mut i = end;
    while i < rest.len() && rest[i] == 0 {
        i += 1;
    }
    let mut strings = rest[i..].split(|&b| b == 0);
    let mut argv = Vec::with_capacity(argc);
    for _ in 0..argc {
        match strings.next() {
            Some(s) => argv.push(String::from_utf8_lossy(s).into_owned()),
            None => break,
        }
    }
    let env = strings
        .take_while(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    Some((exec, argv, env))
}

/// NUL-separated strings (`/proc/<pid>/cmdline`, `environ`); a trailing NUL ends the list.
pub fn nul_split(buf: &[u8]) -> Vec<String> {
    let mut out: Vec<String> = buf
        .split(|&b| b == 0)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    if out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    out
}

/// `/proc/<pid>/stat` → `(state, ppid, starttime in clock ticks since boot)`. The command
/// name is in parentheses and may itself contain spaces and `)`, so fields are counted
/// from the LAST `)`.
pub fn parse_stat(text: &str) -> Option<(char, u32, u64)> {
    let after = &text[text.rfind(')')? + 1..];
    let f: Vec<&str> = after.split_whitespace().collect();
    // f[0] = field 3 (state), f[1] = field 4 (ppid), f[19] = field 22 (starttime).
    let state = f.first()?.chars().next()?;
    let ppid = f.get(1)?.parse().ok()?;
    let start = f.get(19)?.parse().ok()?;
    Some((state, ppid, start))
}

/// `(K, V)` pairs from `K=V` strings (a string without `=` is dropped).
pub fn env_pairs(strings: Vec<String>) -> Vec<(String, String)> {
    strings
        .into_iter()
        .filter_map(|s| {
            let (k, v) = s.split_once('=')?;
            (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

pub use imp::{
    inspect, list, open_paths, parent_and_exe, proc_start, read_env, sigterm, uid_of, AVAILABLE,
};

/// This process's real uid. On Windows, which has no uids, a stable number derived from this
/// process's user SID ([`super::winparse::uid_of_sid`]) — the same one [`uid_of`] gives every
/// process of that user. `None` on any other OS.
pub fn my_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions and cannot fail.
        Some(unsafe { libc::getuid() })
    }
    #[cfg(windows)]
    {
        super::winproc::my_uid()
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::super::logfiles::{Fd, FdKind};
    use super::{env_pairs, parse_procargs2, RawProc};
    use std::ffi::c_void;

    pub const AVAILABLE: bool = true;

    // libc lacks `vnode_fdinfowithpath`/`socket_fdinfo`, so fields are read at
    // `offsetof`-measured SDK offsets (identical on arm64 and x86_64).
    const VNODE_FDINFOWITHPATH_SIZE: usize = 1200;
    const OFF_FI_OPENFLAGS: usize = 0;
    const OFF_VST_MODE: usize = 28;
    const OFF_VIP_PATH: usize = 176;
    const MAXPATHLEN: usize = 1024;
    const PROC_PIDFDVNODEPATHINFO: i32 = 2;
    const FWRITE: u32 = 0x2;
    const S_IFMT: u16 = 0o170000;
    const S_IFREG: u16 = 0o100000;

    const SOCKET_FDINFO_SIZE: usize = 792;
    const OFF_SOI_KIND: usize = 256;
    const OFF_INSI_LPORT: usize = 268;
    const OFF_TCPSI_STATE: usize = 344;
    const SOCKINFO_TCP: i32 = 2;
    const TSI_S_LISTEN: i32 = 1;
    const PROC_PIDFDSOCKETINFO: i32 = 3;
    const PROC_UID_ONLY: u32 = 4;

    fn read_i32(b: &[u8], off: usize) -> i32 {
        i32::from_ne_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
    }

    fn bsdinfo(pid: u32) -> Option<libc::proc_bsdinfo> {
        // SAFETY: zero-initialised, exact size passed; the kernel writes at most that.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut c_void,
                size,
            )
        };
        (n == size).then_some(info)
    }

    fn user_pids(uid: u32) -> Vec<u32> {
        let mut cap = 1024usize;
        loop {
            let mut buf = vec![0i32; cap];
            let bytes = (cap * std::mem::size_of::<i32>()) as i32;
            // SAFETY: `buf` is writable for `bytes` bytes.
            let n = unsafe {
                libc::proc_listpids(PROC_UID_ONLY, uid, buf.as_mut_ptr() as *mut c_void, bytes)
            };
            if n <= 0 {
                return Vec::new();
            }
            let got = n as usize / std::mem::size_of::<i32>();
            if got < cap || cap >= 1 << 18 {
                buf.truncate(got.min(cap));
                return buf
                    .into_iter()
                    .filter(|p| *p > 0)
                    .map(|p| p as u32)
                    .collect();
            }
            cap *= 2;
        }
    }

    fn exe_path(pid: u32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: `buf` is writable for its full length, which we pass.
        let n = unsafe {
            libc::proc_pidpath(
                pid as i32,
                buf.as_mut_ptr() as *mut c_void,
                buf.len() as u32,
            )
        };
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
    }

    fn procargs(pid: u32) -> Option<(String, Vec<String>, Vec<String>)> {
        let mut argmax: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        // SAFETY: `argmax` is a valid c_int out-parameter of `size` bytes.
        let r = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                &mut argmax as *mut _ as *mut c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if r != 0 || argmax <= 0 {
            return None;
        }
        let mut buf = vec![0u8; argmax as usize];
        let mut size = buf.len();
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        // SAFETY: `buf` is writable for `size` bytes; the kernel sets `size` to what it wrote.
        let r = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buf.as_mut_ptr() as *mut c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if r != 0 {
            return None;
        }
        buf.truncate(size);
        parse_procargs2(&buf)
    }

    /// Every process of `uid`, with pid/ppid/exe/argv/start (no fds, no cwd yet).
    pub fn list(uid: u32) -> Vec<RawProc> {
        user_pids(uid)
            .into_iter()
            .filter_map(|pid| {
                let info = bsdinfo(pid)?;
                if info.pbi_uid != uid || info.pbi_status == libc::SZOMB {
                    return None;
                }
                let exe = exe_path(pid);
                let argv = procargs(pid).map(|(_, a, _)| a).unwrap_or_default();
                Some(RawProc {
                    pid,
                    ppid: info.pbi_ppid,
                    exe,
                    argv,
                    cwd: None,
                    started_ms: Some(
                        (info.pbi_start_tvsec as i64) * 1000
                            + (info.pbi_start_tvusec as i64) / 1000,
                    ),
                    fds: Vec::new(),
                })
            })
            .collect()
    }

    fn fd_list(pid: u32) -> Vec<libc::proc_fdinfo> {
        let pid = pid as i32;
        // SAFETY: a null buffer with size 0 asks for the size needed.
        let need =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if need <= 0 {
            return Vec::new();
        }
        let slots = need as usize / std::mem::size_of::<libc::proc_fdinfo>() + 16;
        let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(slots);
        let bytes = (slots * std::mem::size_of::<libc::proc_fdinfo>()) as i32;
        // SAFETY: `fds` has capacity for `bytes` bytes; the length is set to what was written.
        let got = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr() as *mut c_void,
                bytes,
            )
        };
        if got <= 0 {
            return Vec::new();
        }
        // SAFETY: the kernel initialised `got` bytes of whole `proc_fdinfo` records.
        unsafe {
            fds.set_len((got as usize / std::mem::size_of::<libc::proc_fdinfo>()).min(slots))
        };
        fds
    }

    fn vnode(pid: u32, fd: i32) -> FdKind {
        let mut info = [0u64; VNODE_FDINFOWITHPATH_SIZE / 8];
        // SAFETY: `info` is writable for VNODE_FDINFOWITHPATH_SIZE bytes, which we pass.
        let n = unsafe {
            libc::proc_pidfdinfo(
                pid as i32,
                fd,
                PROC_PIDFDVNODEPATHINFO,
                info.as_mut_ptr() as *mut c_void,
                VNODE_FDINFOWITHPATH_SIZE as i32,
            )
        };
        if n as usize != VNODE_FDINFOWITHPATH_SIZE {
            return FdKind::Other;
        }
        // SAFETY: a plain byte view of an initialised u64 array.
        let b: &[u8] = unsafe {
            std::slice::from_raw_parts(info.as_ptr() as *const u8, VNODE_FDINFOWITHPATH_SIZE)
        };
        let raw = &b[OFF_VIP_PATH..OFF_VIP_PATH + MAXPATHLEN];
        let len = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        let path = String::from_utf8_lossy(&raw[..len]).into_owned();
        let mode = u16::from_ne_bytes([b[OFF_VST_MODE], b[OFF_VST_MODE + 1]]);
        let flags = read_i32(b, OFF_FI_OPENFLAGS) as u32;
        if mode & S_IFMT == S_IFREG {
            return FdKind::File {
                path,
                writable: flags & FWRITE != 0,
            };
        }
        if path == "/dev/null" {
            FdKind::Null
        } else if path.starts_with("/dev/tty") || path.starts_with("/dev/pts") {
            FdKind::Tty(path)
        } else {
            FdKind::Other
        }
    }

    fn socket(pid: u32, fd: i32) -> FdKind {
        let mut info = [0u64; SOCKET_FDINFO_SIZE / 8];
        // SAFETY: `info` is writable for SOCKET_FDINFO_SIZE bytes, which we pass.
        let n = unsafe {
            libc::proc_pidfdinfo(
                pid as i32,
                fd,
                PROC_PIDFDSOCKETINFO,
                info.as_mut_ptr() as *mut c_void,
                SOCKET_FDINFO_SIZE as i32,
            )
        };
        if n as usize != SOCKET_FDINFO_SIZE {
            return FdKind::Socket;
        }
        // SAFETY: a plain byte view of an initialised u64 array.
        let b: &[u8] =
            unsafe { std::slice::from_raw_parts(info.as_ptr() as *const u8, SOCKET_FDINFO_SIZE) };
        if read_i32(b, OFF_SOI_KIND) == SOCKINFO_TCP && read_i32(b, OFF_TCPSI_STATE) == TSI_S_LISTEN
        {
            // `insi_lport` holds the port in network byte order (lsof: ntohs).
            FdKind::Listen(u16::from_be(read_i32(b, OFF_INSI_LPORT) as u16))
        } else {
            FdKind::Socket
        }
    }

    fn fds(pid: u32) -> Vec<Fd> {
        fd_list(pid)
            .into_iter()
            .map(|f| {
                let kind = match f.proc_fdtype as i32 {
                    libc::PROX_FDTYPE_VNODE => vnode(pid, f.proc_fd),
                    libc::PROX_FDTYPE_SOCKET => socket(pid, f.proc_fd),
                    libc::PROX_FDTYPE_PIPE => FdKind::Pipe,
                    _ => FdKind::Other,
                };
                Fd {
                    fd: f.proc_fd,
                    kind,
                }
            })
            .collect()
    }

    /// Fill `cwd` and `fds` for one candidate.
    pub fn inspect(p: &mut RawProc) {
        p.cwd = crate::pty::cwd::process_cwd(p.pid).map(|c| c.to_string_lossy().into_owned());
        p.fds = fds(p.pid);
    }

    /// Regular files `pid` has open (the tail guard).
    pub fn open_paths(pid: u32) -> Vec<String> {
        fds(pid)
            .into_iter()
            .filter_map(|f| match f.kind {
                FdKind::File { path, .. } => Some(path),
                _ => None,
            })
            .collect()
    }

    /// `(start ms, uid)` of a live, non-zombie `pid`.
    pub fn proc_start(pid: u32) -> Option<i64> {
        let info = bsdinfo(pid)?;
        (info.pbi_status != libc::SZOMB)
            .then(|| (info.pbi_start_tvsec as i64) * 1000 + (info.pbi_start_tvusec as i64) / 1000)
    }

    pub fn uid_of(pid: u32) -> Option<u32> {
        bsdinfo(pid).map(|i| i.pbi_uid)
    }

    /// `(ppid, exe)` of ANY live process, to walk chains through ones [`list`] omits (setuid
    /// `login`). `PROC_PIDT_SHORTBSDINFO` answers for any pid; read from bytes (libc lacks it).
    pub fn parent_and_exe(pid: u32) -> Option<(u32, Option<String>)> {
        const PROC_PIDT_SHORTBSDINFO: i32 = 13;
        const SHORT_SIZE: i32 = 64;
        let mut buf = [0u8; SHORT_SIZE as usize];
        // SAFETY: `buf` is writable for SHORT_SIZE bytes, which is what we pass.
        let n = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                PROC_PIDT_SHORTBSDINFO,
                0,
                buf.as_mut_ptr() as *mut c_void,
                SHORT_SIZE,
            )
        };
        if n != SHORT_SIZE || read_i32(&buf, 0) as u32 != pid {
            return None;
        }
        Some((read_i32(&buf, 4) as u32, exe_path(pid)))
    }

    /// The environment of `pid` (Restart only).
    pub fn read_env(pid: u32) -> Option<Vec<(String, String)>> {
        procargs(pid).map(|(_, _, env)| env_pairs(env))
    }

    pub fn sigterm(pid: u32) -> Result<(), String> {
        super::unix_sigterm(pid)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::super::logfiles::{Fd, FdKind};
    use super::{env_pairs, nul_split, parse_stat, RawProc};
    use crate::netmachine::{procnet, MachineProto};
    use std::collections::HashMap;
    use std::os::unix::fs::MetadataExt;

    pub const AVAILABLE: bool = true;

    fn boot_ms() -> Option<i64> {
        let text = std::fs::read_to_string("/proc/stat").ok()?;
        let secs: i64 = text
            .lines()
            .find_map(|l| l.strip_prefix("btime "))?
            .trim()
            .parse()
            .ok()?;
        Some(secs * 1000)
    }

    fn clk_tck() -> i64 {
        // SAFETY: sysconf has no preconditions.
        let t = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if t > 0 {
            t as i64
        } else {
            100
        }
    }

    fn stat(pid: u32) -> Option<(char, u32, u64)> {
        parse_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
    }

    fn start_ms(ticks: u64, boot: Option<i64>, tck: i64) -> Option<i64> {
        Some(boot? + (ticks as i64) * 1000 / tck)
    }

    fn exe_path(pid: u32) -> Option<String> {
        let p = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        let s = p.to_string_lossy();
        Some(s.strip_suffix(" (deleted)").unwrap_or(&s).to_string())
    }

    pub fn list(uid: u32) -> Vec<RawProc> {
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let boot = boot_ms();
        let tck = clk_tck();
        dir.flatten()
            .filter_map(|e| {
                let pid: u32 = e.file_name().to_str()?.parse().ok()?;
                if e.metadata().ok()?.uid() != uid {
                    return None;
                }
                let (state, ppid, ticks) = stat(pid)?;
                if state == 'Z' {
                    return None;
                }
                let argv = nul_split(&std::fs::read(format!("/proc/{pid}/cmdline")).ok()?);
                if argv.is_empty() {
                    return None; // a kernel thread
                }
                Some(RawProc {
                    pid,
                    ppid,
                    exe: exe_path(pid),
                    argv,
                    cwd: None,
                    started_ms: start_ms(ticks, boot, tck),
                    fds: Vec::new(),
                })
            })
            .collect()
    }

    /// Listening TCP sockets: inode → port.
    fn listeners() -> HashMap<u64, u16> {
        let mut out = HashMap::new();
        for (file, proto) in [
            ("/proc/net/tcp", MachineProto::Tcp4),
            ("/proc/net/tcp6", MachineProto::Tcp6),
        ] {
            if let Ok(text) = std::fs::read_to_string(file) {
                for s in procnet::parse_proc_net(&text, proto) {
                    if s.state == 0x0A && s.inode != 0 {
                        out.insert(s.inode, s.local.port());
                    }
                }
            }
        }
        out
    }

    fn writable(pid: u32, fd: i32) -> bool {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/fdinfo/{fd}")) else {
            return false;
        };
        text.lines()
            .find_map(|l| l.strip_prefix("flags:"))
            .and_then(|v| u32::from_str_radix(v.trim(), 8).ok())
            .is_some_and(|flags| flags & 0o3 != 0) // O_WRONLY | O_RDWR
    }

    fn fds(pid: u32, listen: Option<&HashMap<u64, u16>>) -> Vec<Fd> {
        let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            return Vec::new();
        };
        dir.flatten()
            .filter_map(|e| {
                let fd: i32 = e.file_name().to_str()?.parse().ok()?;
                let target = std::fs::read_link(e.path()).ok()?;
                let t = target.to_string_lossy().into_owned();
                let kind = if let Some(inode) =
                    t.strip_prefix("socket:[").and_then(|r| r.strip_suffix(']'))
                {
                    match inode.parse::<u64>().ok().and_then(|i| listen?.get(&i)) {
                        Some(port) => FdKind::Listen(*port),
                        None => FdKind::Socket,
                    }
                } else if t.starts_with("pipe:[") {
                    FdKind::Pipe
                } else if t == "/dev/null" {
                    FdKind::Null
                } else if t.starts_with("/dev/pts/") || t.starts_with("/dev/tty") {
                    FdKind::Tty(t)
                } else if std::fs::metadata(e.path()).is_ok_and(|m| m.is_file()) {
                    FdKind::File {
                        path: t.strip_suffix(" (deleted)").unwrap_or(&t).to_string(),
                        writable: writable(pid, fd),
                    }
                } else {
                    FdKind::Other
                };
                Some(Fd { fd, kind })
            })
            .collect()
    }

    pub fn inspect(p: &mut RawProc) {
        p.cwd = crate::pty::cwd::process_cwd(p.pid).map(|c| c.to_string_lossy().into_owned());
        p.fds = fds(p.pid, Some(&listeners()));
    }

    pub fn open_paths(pid: u32) -> Vec<String> {
        fds(pid, None)
            .into_iter()
            .filter_map(|f| match f.kind {
                FdKind::File { path, .. } => Some(path),
                _ => None,
            })
            .collect()
    }

    pub fn proc_start(pid: u32) -> Option<i64> {
        let (state, _, ticks) = stat(pid)?;
        if state == 'Z' {
            return None;
        }
        start_ms(ticks, boot_ms(), clk_tck())
    }

    pub fn uid_of(pid: u32) -> Option<u32> {
        std::fs::metadata(format!("/proc/{pid}"))
            .ok()
            .map(|m| m.uid())
    }

    /// `(ppid, exe)` of any live process (the macOS twin's note).
    pub fn parent_and_exe(pid: u32) -> Option<(u32, Option<String>)> {
        let (_, ppid, _) = stat(pid)?;
        Some((ppid, exe_path(pid)))
    }

    pub fn read_env(pid: u32) -> Option<Vec<(String, String)>> {
        let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
        Some(env_pairs(nul_split(&raw)))
    }

    pub fn sigterm(pid: u32) -> Result<(), String> {
        super::unix_sigterm(pid)
    }
}

/// Windows: the calls are in [`super::winproc`], the decisions in [`super::winparse`].
#[cfg(windows)]
mod imp {
    use super::super::winproc;
    use super::RawProc;

    pub const AVAILABLE: bool = true;

    /// Every live process of `uid` (the user SID's hash — [`super::my_uid`]).
    pub fn list(uid: u32) -> Vec<RawProc> {
        winproc::list(uid)
    }

    /// Fill `cwd` (the PEB) and `fds`: what fds 1/2 point at (a file, a pipe, the console,
    /// `NUL`), the files it holds open for writing (its handle table — [`winproc`]'s module doc
    /// says how that is done without ever hanging), and its listening TCP ports.
    pub fn inspect(p: &mut RawProc) {
        winproc::inspect(p)
    }

    /// Its stdout/stderr file and the files it holds open for writing — what the tail guard
    /// may admit ([`winproc::open_paths`]).
    pub fn open_paths(pid: u32) -> Vec<String> {
        winproc::open_paths(pid)
    }

    pub fn proc_start(pid: u32) -> Option<i64> {
        winproc::proc_start(pid)
    }

    /// `None` when the pid's token cannot be opened (another user, a service, a protected or —
    /// for a non-elevated IDE — an elevated process).
    pub fn uid_of(pid: u32) -> Option<u32> {
        winproc::uid_of(pid)
    }

    pub fn parent_and_exe(pid: u32) -> Option<(u32, Option<String>)> {
        winproc::parent_and_exe(pid)
    }

    pub fn read_env(pid: u32) -> Option<Vec<(String, String)>> {
        winproc::read_env(pid)
    }

    /// `TerminateProcess` — Windows has no SIGTERM ([`winproc::terminate`] says why and what is
    /// refused).
    pub fn sigterm(pid: u32) -> Result<(), String> {
        winproc::terminate(pid)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    use super::RawProc;

    pub const AVAILABLE: bool = false;

    pub fn list(_uid: u32) -> Vec<RawProc> {
        Vec::new()
    }
    pub fn inspect(_p: &mut RawProc) {}
    pub fn open_paths(_pid: u32) -> Vec<String> {
        Vec::new()
    }
    pub fn proc_start(_pid: u32) -> Option<i64> {
        None
    }
    pub fn uid_of(_pid: u32) -> Option<u32> {
        None
    }
    pub fn parent_and_exe(_pid: u32) -> Option<(u32, Option<String>)> {
        None
    }
    pub fn read_env(_pid: u32) -> Option<Vec<(String, String)>> {
        None
    }
    pub fn sigterm(_pid: u32) -> Result<(), String> {
        Err("not supported on this OS".into())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_sigterm(pid: u32) -> Result<(), String> {
    let pid = i32::try_from(pid).map_err(|_| format!("bad pid {pid}"))?;
    if pid <= 1 {
        return Err(format!("refusing to signal pid {pid}"));
    }
    // SAFETY: kill has no memory preconditions; the pid was checked to be a single process.
    let r = unsafe { libc::kill(pid, libc::SIGTERM) };
    if r == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn procargs2_is_argc_exec_padding_argv_env() {
        let mut buf = 3i32.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"/usr/bin/java\0\0\0\0");
        buf.extend_from_slice(b"java\0-jar\0app.jar\0");
        buf.extend_from_slice(b"HOME=/Users/me\0SECRET=x\0\0junk\0");
        let (exec, argv, env) = parse_procargs2(&buf).unwrap();
        assert_eq!(exec, "/usr/bin/java");
        assert_eq!(argv, ["java", "-jar", "app.jar"]);
        assert_eq!(env, ["HOME=/Users/me", "SECRET=x"]);
        assert!(parse_procargs2(&[1, 0]).is_none(), "too short");
        // argc larger than what is there: what is there.
        let mut short = 5i32.to_ne_bytes().to_vec();
        short.extend_from_slice(b"/x\0a\0b");
        let (_, argv, env) = parse_procargs2(&short).unwrap();
        assert_eq!(argv, ["a", "b"]);
        assert!(env.is_empty());
    }

    #[test]
    fn stat_counts_fields_from_the_last_paren() {
        let line = "4242 (my (odd) prog) S 17 4242 4242 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 987654 1 2 3";
        assert_eq!(parse_stat(line), Some(('S', 17, 987_654)));
        assert_eq!(parse_stat("1 (x) Z 0"), None, "too few fields");
        assert_eq!(parse_stat("garbage"), None);
    }

    #[test]
    fn nul_split_and_env_pairs() {
        assert_eq!(nul_split(b"node\0server.js\0"), ["node", "server.js"]);
        assert_eq!(nul_split(b""), Vec::<String>::new());
        assert_eq!(
            env_pairs(vec![
                "A=1".into(),
                "B==2".into(),
                "junk".into(),
                "=x".into()
            ]),
            vec![("A".into(), "1".into()), ("B".into(), "=2".into())]
        );
    }

    #[test]
    fn parent_and_exe_answers_for_a_live_process() {
        let me = std::process::id();
        let got = parent_and_exe(me);
        assert_eq!(
            got.is_some(),
            AVAILABLE,
            "a live pid answers iff the OS has a table"
        );
        if let Some((ppid, exe)) = got {
            #[cfg(unix)]
            // SAFETY: getppid has no preconditions and cannot fail.
            assert_eq!(ppid, unsafe { libc::getppid() } as u32);
            #[cfg(windows)]
            assert_eq!(Some(ppid), super::super::winproc::ppid_of(me));
            #[cfg(not(any(unix, windows)))]
            let _ = ppid;
            assert!(exe.is_some_and(|e| !e.is_empty()));
        }
        assert_eq!(parent_and_exe(u32::MAX / 2), None, "no such process");
    }
}
