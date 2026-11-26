//! Which process owns a proxy connection, and whether decrypting it is safe (never break a
//! client): only runtimes reading our injected CA vars are MITM'd. The pid comes from libproc,
//! `/proc/net/tcp` or `GetExtendedTcpTable`, off the accept loop, bounded by [`SCAN_BUDGET`].

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// The client process of a flow. Wire type (`FlowSummary.client`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientProcess {
    pub pid: u32,
    /// [`client_name`] of the executable: `curl`, `claude`, `gazelle`.
    pub name: String,
    /// The executable's absolute path, when readable.
    pub path: Option<String>,
}

/// Whether this build can name a connection's process at all. Where it cannot (none of the
/// three OSes we ship for), an unknown client keeps the behaviour from before per-client
/// resolution: MITM, with the learned passthrough as fallback.
pub const RESOLVER_AVAILABLE: bool = cfg!(any(target_os = "macos", target_os = "linux", windows));

/// A cold scan gives up after this long ("unknown client", tunnelled — never a failure).
/// Measured ~5 ms on an idle Mac; the headroom is for a loaded machine (a parallel Docker
/// build made 250 ms miss once), and only a client's FIRST connection can pay it.
pub const SCAN_BUDGET: Duration = Duration::from_millis(1_000);
/// Hard cap on processes examined in one cold scan.
pub const SCAN_MAX_PIDS: usize = 20_000;
const RECENT: usize = 16;

/// The display name for an executable path. The native `claude` installer puts the binary at
/// `…/claude/versions/<semver>`, whose basename (`2.1.281`) names nothing — that is `claude`.
/// Otherwise the basename, without a Windows `.exe`.
pub fn client_name(path: &str) -> String {
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let base = parts.last().copied().unwrap_or(path);
    if parts.len() >= 3 {
        let (dir, parent) = (parts[parts.len() - 2], parts[parts.len() - 3]);
        let semverish = !base.is_empty()
            && base.chars().next().is_some_and(|c| c.is_ascii_digit())
            && base
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
        if dir == "versions" && parent.eq_ignore_ascii_case("claude") && semverish {
            return "claude".to_string();
        }
    }
    let lower = base.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(stem) if !stem.is_empty() => base[..stem.len()].to_string(),
        _ => base.to_string(),
    }
}

/// `name` followed by an optional version: `python3`, `python3.12`, `python3.13t`, `ruby3.2`.
fn versioned(name: &str, stem: &str) -> bool {
    let Some(rest) = name.strip_prefix(stem) else {
        return false;
    };
    let rest = rest.strip_suffix('t').unwrap_or(rest);
    rest.is_empty()
        || (rest.starts_with(|c: char| c.is_ascii_digit())
            && rest.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// The decrypt allowlist: runtimes that read a CA var `pty_env` injects (node/bun/claude, deno,
/// python, curl, git, cargo, ruby, php). Small on purpose: a wrong "yes" breaks a client, a
/// wrong "no" only hides a path. Windows is narrower ([`reads_injected_ca_on`]).
pub fn reads_injected_ca(name: &str) -> bool {
    reads_injected_ca_on(name, cfg!(windows))
}

/// [`reads_injected_ca`] per platform (both tested everywhere). On Windows `curl`, `git` and
/// `cargo` may use Schannel (Windows store + revocation), so they are tunnelled unless opted in.
/// Reasoned, not measured on Windows: the choice that cannot break a client.
pub fn reads_injected_ca_on(name: &str, windows: bool) -> bool {
    let n = name.to_ascii_lowercase();
    const EVERYWHERE: [&str; 6] = ["node", "nodejs", "bun", "deno", "claude", "php"];
    const NOT_ON_WINDOWS: [&str; 5] = [
        "curl",
        "git",
        "git-remote-https",
        "git-remote-http",
        "cargo",
    ];
    EVERYWHERE.contains(&n.as_str())
        || (!windows && NOT_ON_WINDOWS.contains(&n.as_str()))
        || versioned(&n, "python")
        || versioned(&n, "ruby")
        || versioned(&n, "php")
}

/// What to do with a `CONNECT` in decrypt mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Decrypt,
    /// Tunnel; the note (if any) explains why it was not decrypted.
    Tunnel(Option<String>),
}

/// The note when a client is tunnelled because it would not trust our leaf.
pub fn not_decrypted_note(name: &str) -> String {
    format!("not decrypted: {name} doesn't read the IDE's CA")
}

pub const UNKNOWN_CLIENT_NOTE: &str = "not decrypted: couldn't identify the client process";

/// The note on a connection tunnelled because this (client, host) refused our leaf before.
pub fn learned_note(name: Option<&str>) -> String {
    format!(
        "not decrypted: {} refused the IDE's certificate for this host earlier",
        name.unwrap_or("the client")
    )
}

/// User opt-in (`decryptApps`): an entry equal to the executable name, or `/<entry>.app/` in its
/// path (bundle helpers count). Case-sensitive on purpose (a wrong yes breaks the client); empty
/// or `/`-containing entries never match.
pub fn user_opted_in(client: &ClientProcess, apps: &[String]) -> bool {
    apps.iter().filter(|a| valid_app_entry(a)).any(|a| {
        client.name == *a
            || client
                .path
                .as_deref()
                .is_some_and(|p| p.contains(&format!("/{a}.app/")))
    })
}

/// A `decryptApps` entry we can match safely: non-empty, no `/`, not all whitespace.
pub fn valid_app_entry(app: &str) -> bool {
    !app.trim().is_empty() && !app.contains('/')
}

/// Per-connection decision, decrypt already on: `extra` (test seam) extends the allowlist and
/// `apps` are the user's opt-ins, applied alike to IDE terminals and external clients.
pub fn decide(
    client: Option<&ClientProcess>,
    resolver_available: bool,
    learned_passthrough: bool,
    extra: &[String],
    apps: &[String],
) -> Decision {
    let allowed = |c: &ClientProcess| {
        reads_injected_ca(&c.name) || extra.contains(&c.name) || user_opted_in(c, apps)
    };
    match client {
        // Never MITM'd whatever was learned, so say the real reason.
        Some(c) if !allowed(c) => Decision::Tunnel(Some(not_decrypted_note(&c.name))),
        None if resolver_available => Decision::Tunnel(Some(UNKNOWN_CLIENT_NOTE.to_string())),
        _ if learned_passthrough => {
            Decision::Tunnel(Some(learned_note(client.map(|c| c.name.as_str()))))
        }
        _ => Decision::Decrypt,
    }
}

/// Resolves connections to processes, remembering which pids answered recently.
#[derive(Default)]
pub struct Resolver {
    recent: Mutex<VecDeque<u32>>,
}

impl Resolver {
    /// `peer` = the client's end of the accepted socket, `local` = ours (the listen address).
    /// Blocking: call from `spawn_blocking`.
    pub fn resolve(&self, peer: SocketAddr, local: SocketAddr) -> Option<ClientProcess> {
        let recent: Vec<u32> = self
            .recent
            .lock()
            .map(|r| r.iter().copied().collect())
            .unwrap_or_default();
        let pid = os::find_pid(peer, local, &recent)?;
        if let Ok(mut r) = self.recent.lock() {
            r.retain(|p| *p != pid);
            r.push_front(pid);
            r.truncate(RECENT);
        }
        let path = os::exe_path(pid);
        let name = match &path {
            Some(p) => client_name(p),
            None => os::short_name(pid)?,
        };
        Some(ClientProcess { pid, name, path })
    }
}

/// Candidate order: recent pids first, then the rest (newest first), each once.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ordered(recent: &[u32], all: impl IntoIterator<Item = u32>) -> Vec<u32> {
    let mut out: Vec<u32> = recent.to_vec();
    out.extend(all.into_iter().filter(|p| !recent.contains(p)));
    out
}

/// A `/proc/net/tcp{,6}` row's inode when its local endpoint is `peer` (port match, loopback
/// address) and its remote port is `listen_port`. Pure; tested on every OS.
pub fn proc_net_inode(text: &str, peer_port: u16, listen_port: u16) -> Option<u64> {
    text.lines().skip(1).find_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 {
            return None;
        }
        let port_of = |ep: &str| {
            ep.rsplit_once(':')
                .and_then(|(_, p)| u16::from_str_radix(p, 16).ok())
        };
        let loopback = |ep: &str| {
            let a = ep
                .split_once(':')
                .map_or("", |(a, _)| a)
                .to_ascii_uppercase();
            // 127.x.x.x printed host-order on little-endian (`..00007F`), big-endian
            // (`7F......`), `::1`, or `::ffff:127.x` (v6-mapped).
            a.ends_with("7F")
                || a.starts_with("7F")
                || a == "00000000000000000000000001000000"
                || (a.len() == 32 && a.starts_with("0000000000000000FFFF0000"))
        };
        let inode: u64 = f[9].parse().ok()?;
        (port_of(f[1])? == peer_port
            && port_of(f[2])? == listen_port
            && loopback(f[1])
            && inode != 0)
            .then_some(inode)
    })
}

#[cfg(target_os = "linux")]
mod os {
    use super::*;

    pub fn find_pid(peer: SocketAddr, local: SocketAddr, recent: &[u32]) -> Option<u32> {
        let inode = ["/proc/net/tcp", "/proc/net/tcp6"].iter().find_map(|f| {
            std::fs::read_to_string(f)
                .ok()
                .and_then(|t| proc_net_inode(&t, peer.port(), local.port()))
        })?;
        let needle = format!("socket:[{inode}]");
        let mut all: Vec<u32> = std::fs::read_dir("/proc")
            .ok()?
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
            .collect();
        // Newest first: the client is usually a process that just started.
        all.sort_unstable_by(|a, b| b.cmp(a));
        let started = Instant::now();
        for pid in ordered(recent, all).into_iter().take(SCAN_MAX_PIDS) {
            if started.elapsed() > SCAN_BUDGET {
                return None;
            }
            let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
                continue; // another user's process, or gone
            };
            for fd in fds.flatten() {
                if std::fs::read_link(fd.path())
                    .map(|l| l.as_os_str() == needle.as_str())
                    .unwrap_or(false)
                {
                    return Some(pid);
                }
            }
        }
        None
    }

    pub fn exe_path(pid: u32) -> Option<String> {
        let p = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        let s = p.to_string_lossy();
        Some(s.strip_suffix(" (deleted)").unwrap_or(&s).to_string())
    }

    pub fn short_name(pid: u32) -> Option<String> {
        let s = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::*;
    use std::ffi::c_void;

    // `struct socket_fdinfo` (sys/proc_info.h), offsets measured with `offsetof` against the
    // macOS SDK (arm64; identical on x86_64 — both LP64, no arch-dependent members). libc has
    // the calls but not this struct, so we read the few fields we need from a byte buffer.
    const SOCKET_FDINFO_SIZE: usize = 792;
    const OFF_SOI_KIND: usize = 256;
    const OFF_INSI_FPORT: usize = 264;
    const OFF_INSI_LPORT: usize = 268;
    const SOCKINFO_IN: i32 = 1;
    const SOCKINFO_TCP: i32 = 2;
    const PROC_UID_ONLY: u32 = 4;
    const PROC_PIDFDSOCKETINFO: i32 = 3;

    fn user_pids() -> Vec<u32> {
        // SAFETY: getuid never fails.
        let uid = unsafe { libc::getuid() };
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
            if got < cap || cap >= SCAN_MAX_PIDS {
                buf.truncate(got.min(cap));
                let mut pids: Vec<u32> = buf
                    .into_iter()
                    .filter(|p| *p > 0)
                    .map(|p| p as u32)
                    .collect();
                // Newest first: the client is usually a process that just started.
                pids.sort_unstable_by(|a, b| b.cmp(a));
                return pids;
            }
            cap *= 2;
        }
    }

    fn read_i32(buf: &[u8], off: usize) -> i32 {
        i32::from_ne_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
    }

    fn pid_owns(pid: u32, peer_port: u16, listen_port: u16) -> bool {
        let pid = pid as i32;
        // SAFETY: a null buffer with size 0 asks for the size needed.
        let need =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if need <= 0 {
            return false;
        }
        let slots = need as usize / std::mem::size_of::<libc::proc_fdinfo>() + 16;
        let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(slots);
        let bytes = (slots * std::mem::size_of::<libc::proc_fdinfo>()) as i32;
        // SAFETY: `fds` has capacity for `bytes` bytes; we set the length to what was written.
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
            return false;
        }
        // SAFETY: the kernel initialised `got` bytes of whole `proc_fdinfo` records.
        unsafe {
            fds.set_len((got as usize / std::mem::size_of::<libc::proc_fdinfo>()).min(slots))
        };
        let mut info = [0u64; SOCKET_FDINFO_SIZE / 8]; // 8-aligned, like the C struct
        for fd in fds
            .iter()
            .filter(|f| f.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32)
        {
            // SAFETY: `info` is writable for SOCKET_FDINFO_SIZE bytes, which we pass.
            let n = unsafe {
                libc::proc_pidfdinfo(
                    pid,
                    fd.proc_fd,
                    PROC_PIDFDSOCKETINFO,
                    info.as_mut_ptr() as *mut c_void,
                    SOCKET_FDINFO_SIZE as i32,
                )
            };
            if n as usize != SOCKET_FDINFO_SIZE {
                continue;
            }
            // SAFETY: a plain byte view of an initialised u64 array.
            let b: &[u8] = unsafe {
                std::slice::from_raw_parts(info.as_ptr() as *const u8, SOCKET_FDINFO_SIZE)
            };
            let kind = read_i32(b, OFF_SOI_KIND);
            if kind != SOCKINFO_TCP && kind != SOCKINFO_IN {
                continue;
            }
            // `insi_lport`/`insi_fport` hold the port in network byte order (lsof: ntohs).
            let lport = u16::from_be(read_i32(b, OFF_INSI_LPORT) as u16);
            let fport = u16::from_be(read_i32(b, OFF_INSI_FPORT) as u16);
            if lport == peer_port && fport == listen_port {
                return true;
            }
        }
        false
    }

    pub fn find_pid(peer: SocketAddr, local: SocketAddr, recent: &[u32]) -> Option<u32> {
        let started = Instant::now();
        let owns = |pid: u32| pid_owns(pid, peer.port(), local.port());
        // Recent pids first; only list the user's processes if they all miss.
        if let Some(pid) = recent.iter().copied().find(|p| owns(*p)) {
            return Some(pid);
        }
        for pid in user_pids()
            .into_iter()
            .filter(|p| !recent.contains(p))
            .take(SCAN_MAX_PIDS)
        {
            if started.elapsed() > SCAN_BUDGET {
                return None;
            }
            if owns(pid) {
                return Some(pid);
            }
        }
        None
    }

    pub fn exe_path(pid: u32) -> Option<String> {
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

    pub fn short_name(pid: u32) -> Option<String> {
        let mut nb = [0u8; 256];
        // SAFETY: `nb` is writable for its full length, which we pass.
        let n =
            unsafe { libc::proc_name(pid as i32, nb.as_mut_ptr() as *mut c_void, nb.len() as u32) };
        (n > 0).then(|| String::from_utf8_lossy(&nb[..n as usize]).into_owned())
    }
}

#[cfg(windows)]
mod os {
    use super::*;
    use crate::netmachine::{windows as win, wintable};

    /// One read of the TCP table per accepted connection (tens of kilobytes, on a blocking
    /// thread). `recent` is not needed: the table already names the pid.
    pub fn find_pid(peer: SocketAddr, local: SocketAddr, _recent: &[u32]) -> Option<u32> {
        let rows = win::tcp_rows().ok()?;
        wintable::owner_pid(&rows, peer, local.port())
    }
    pub fn exe_path(pid: u32) -> Option<String> {
        win::exe_path(pid)
    }
    pub fn short_name(pid: u32) -> Option<String> {
        win::process_name(pid)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod os {
    use super::*;

    pub fn find_pid(_: SocketAddr, _: SocketAddr, _: &[u32]) -> Option<u32> {
        None
    }
    pub fn exe_path(_: u32) -> Option<String> {
        None
    }
    pub fn short_name(_: u32) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(name: &str) -> ClientProcess {
        ClientProcess {
            pid: 7,
            name: name.into(),
            path: None,
        }
    }

    #[test]
    fn names_come_from_the_executable_and_claude_versions_is_claude() {
        let cases = [
            ("/Users/me/.local/share/claude/versions/2.1.281", "claude"),
            (
                "/home/me/.local/share/claude/versions/2.1.212-beta.1",
                "claude",
            ),
            ("/usr/bin/curl", "curl"),
            ("/opt/homebrew/Cellar/node/24.1.0/bin/node", "node"),
            ("C:\\Program Files\\nodejs\\node.exe", "node"),
            ("C:\\tools\\Gazelle.EXE", "Gazelle"),
            ("/Users/me/gazelle/target/debug/gazelle", "gazelle"),
            // `versions/` under something that is not claude stays the basename.
            ("/Users/me/.nvm/versions/22.1.0", "22.1.0"),
            ("/Users/me/claude/versions/latest", "latest"),
            ("curl", "curl"),
        ];
        for (path, want) in cases {
            assert_eq!(client_name(path), want, "{path}");
        }
    }

    /// The allowlist, written out independently of the implementation: every expectation is
    /// a literal, so a regex change that widens or narrows it goes red here.
    #[test]
    fn the_allowlist_decision_table() {
        let yes = [
            "node",
            "nodejs",
            "bun",
            "deno",
            "claude",
            "curl",
            "git",
            "git-remote-https",
            "git-remote-http",
            "cargo",
            "ruby",
            "ruby3.2",
            "php",
            "php8.3",
            "python",
            "Python",
            "python3",
            "python3.12",
            "python3.13t",
            "NODE",
        ];
        let no = [
            "gazelle",
            "java",
            "go",
            "rustc",
            "reqwest",
            "chrome",
            "Google Chrome",
            "pythonista",
            "python-config",
            "nodemon",
            "curl-config",
            "git-lfs",
            "cargo-watch",
            "rubyx",
            "php-fpm",
            "claude-helper",
            "",
            "netcap_e2e-3f2a9c",
        ];
        for n in yes {
            assert!(reads_injected_ca_on(n, false), "{n} should be decrypted");
        }
        for n in no {
            assert!(!reads_injected_ca_on(n, false), "{n} must be tunnelled");
            assert!(
                !reads_injected_ca_on(n, true),
                "{n} must be tunnelled on Windows too"
            );
        }
        // This OS's list is one of the two.
        for n in yes.iter().chain(no.iter()) {
            assert_eq!(
                reads_injected_ca(n),
                reads_injected_ca_on(n, cfg!(windows)),
                "{n}"
            );
        }
    }

    /// Windows: the Schannel clients are tunnelled (never broken); the runtimes that read a
    /// CA variable through their own TLS stack are still decrypted.
    #[test]
    fn the_windows_allowlist_leaves_out_the_schannel_clients() {
        for n in [
            "curl",
            "CURL",
            "git",
            "git-remote-https",
            "git-remote-http",
            "cargo",
        ] {
            assert!(
                !reads_injected_ca_on(n, true),
                "{n} must be tunnelled on Windows"
            );
        }
        for n in [
            "node",
            "Node",
            "nodejs",
            "bun",
            "deno",
            "claude",
            "php",
            "php8.3",
            "python",
            "python3.12",
            "ruby",
            "ruby3.2",
        ] {
            assert!(
                reads_injected_ca_on(n, true),
                "{n} should be decrypted on Windows"
            );
        }
        // And a Windows client that is tunnelled says why — it is known, not "unknown".
        let curl = ClientProcess {
            pid: 1,
            name: "curl".into(),
            path: Some(r"C:\Windows\System32\curl.exe".into()),
        };
        assert_eq!(client_name(curl.path.as_deref().unwrap()), "curl");
    }

    /// Per-app opt-in matching, every expectation a literal.
    #[test]
    fn the_app_opt_in_matching_table() {
        let at = |name: &str, path: Option<&str>| ClientProcess {
            pid: 1,
            name: name.into(),
            path: path.map(str::to_string),
        };
        let postman = ["Postman".to_string()];
        let cases: &[(ClientProcess, &[String], bool, &str)] = &[
            (
                at(
                    "Postman Helper",
                    Some("/Applications/Postman.app/Contents/Frameworks/Postman Helper.app/Contents/MacOS/Postman Helper"),
                ),
                &postman,
                true,
                "a helper inside the bundle is the bundle",
            ),
            (
                at("Postman", Some("/Applications/Postman.app/Contents/MacOS/Postman")),
                &postman,
                true,
                "the bundle's main executable",
            ),
            (
                at(
                    "PostmanCanary",
                    Some("/Applications/PostmanCanary.app/Contents/MacOS/PostmanCanary"),
                ),
                &postman,
                false,
                "a different bundle that starts with the entry",
            ),
            (
                at("Postman", None),
                &postman,
                true,
                "exe name equal, path unknown",
            ),
            (
                at("postman", Some("/opt/postman/postman")),
                &postman,
                false,
                "case-sensitive: `postman` is not `Postman`",
            ),
            (
                at("Postman", Some("/Applications/postman.app/Contents/MacOS/Postman")),
                &["postman".to_string()],
                true,
                "the bundle segment is matched with the entry's exact case",
            ),
            (
                at("PostmanX", Some("/opt/bin/PostmanX")),
                &postman,
                false,
                "exe name must be equal, not a prefix",
            ),
            (
                at("Postman", Some("/Users/me/Postman.app.bak/Postman")),
                &["Other".to_string()],
                false,
                "no entry matches",
            ),
            (
                at("insomnia", Some("/Applications/Insomnia.app/Contents/MacOS/Insomnia")),
                &["Insomnia".to_string()],
                true,
                "bundle name differs from the exe name's case",
            ),
            (
                at("x", Some("/Applications/.app/Contents/MacOS/x")),
                &[String::new()],
                false,
                "an empty entry never matches",
            ),
            (
                at("x", Some("/a/b.app/c")),
                &["a/b".to_string()],
                false,
                "an entry with `/` never matches",
            ),
            (at("gazelle", None), &[], false, "no opt-ins"),
        ];
        for (c, apps, want, why) in cases {
            assert_eq!(user_opted_in(c, apps), *want, "{why}: {c:?} vs {apps:?}");
        }
    }

    #[test]
    fn an_opted_in_app_is_decrypted_and_the_learned_passthrough_still_wins() {
        let none: &[String] = &[];
        let apps = ["Postman".to_string()];
        let helper = ClientProcess {
            pid: 3,
            name: "Postman Helper".into(),
            path: Some(
                "/Applications/Postman.app/Contents/Frameworks/Postman Helper.app/Contents/MacOS/Postman Helper"
                    .into(),
            ),
        };
        assert_eq!(
            decide(Some(&helper), true, false, none, none),
            Decision::Tunnel(Some(
                "not decrypted: Postman Helper doesn't read the IDE's CA".into()
            ))
        );
        assert_eq!(
            decide(Some(&helper), true, false, none, &apps),
            Decision::Decrypt
        );
        assert_eq!(
            decide(Some(&helper), true, true, none, &apps),
            Decision::Tunnel(Some(
                "not decrypted: Postman Helper refused the IDE's certificate for this host earlier"
                    .into()
            )),
            "an opt-in that was wrong fails once, then is learned"
        );
    }

    #[test]
    fn the_per_connection_decision() {
        let none: &[String] = &[];
        // `node` reads the IDE's CA on every OS, so these assertions hold on any host.
        // `curl` is platform-dependent (Schannel on Windows) and asserted per platform
        // next (a bare `curl` here would fail on Windows).
        assert_eq!(
            decide(Some(&proc("node")), true, false, none, none),
            Decision::Decrypt
        );
        assert_eq!(
            decide(Some(&proc("curl")), true, false, none, none),
            if cfg!(windows) {
                Decision::Tunnel(Some("not decrypted: curl doesn't read the IDE's CA".into()))
            } else {
                Decision::Decrypt
            },
            "curl: decrypted where it reads CURL_CA_BUNDLE, tunnelled on Windows (Schannel)"
        );
        assert_eq!(
            decide(Some(&proc("gazelle")), true, false, none, none),
            Decision::Tunnel(Some(
                "not decrypted: gazelle doesn't read the IDE's CA".into()
            ))
        );
        assert_eq!(
            decide(
                Some(&proc("gazelle")),
                true,
                false,
                &["gazelle".to_string()],
                none
            ),
            Decision::Decrypt,
            "the test seam widens the list"
        );
        assert_eq!(
            decide(Some(&proc("node")), true, true, none, none),
            Decision::Tunnel(Some(
                "not decrypted: node refused the IDE's certificate for this host earlier".into()
            )),
            "a learned passthrough wins over the allowlist"
        );
        assert_eq!(
            decide(Some(&proc("gazelle")), true, true, none, none),
            Decision::Tunnel(Some(
                "not decrypted: gazelle doesn't read the IDE's CA".into()
            )),
            "a client never decrypted is explained by the real reason, learned or not"
        );
        assert_eq!(
            decide(None, false, true, none, none),
            Decision::Tunnel(Some(
                "not decrypted: the client refused the IDE's certificate for this host earlier"
                    .into()
            )),
            "no resolver: the older learned passthrough still applies"
        );
        assert_eq!(
            decide(None, true, false, none, none),
            Decision::Tunnel(Some(UNKNOWN_CLIENT_NOTE.into())),
            "unknown client where we can resolve ⇒ do not risk it"
        );
        assert_eq!(
            decide(None, false, false, none, none),
            Decision::Decrypt,
            "no resolver ⇒ the older MITM + learned passthrough"
        );
    }

    #[test]
    fn proc_net_rows_are_matched_by_ports_on_loopback() {
        // 127.0.0.1:56227 → 127.0.0.1:46480 (B590), inode 27895644; plus decoys.
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:B590 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1\n\
   1: 0100007F:DBA3 0100007F:B590 01 00000000:00000000 00:00000000 00000000  1000        0 27895644 2\n\
   2: 0A00020F:DBA3 5DB8D822:B590 01 00000000:00000000 00:00000000 00000000  1000        0 999 2\n\
   3: 0100007F:B590 0100007F:DBA3 01 00000000:00000000 00:00000000 00000000  1000        0 222 2\n";
        assert_eq!(proc_net_inode(tcp, 0xDBA3, 0xB590), Some(27_895_644));
        assert_eq!(proc_net_inode(tcp, 0xDBA4, 0xB590), None);
        let tcp6 = "  sl  local_address                         remote_address                        st\n\
   0: 0000000000000000FFFF00000100007F:DBA3 0000000000000000FFFF00000100007F:B590 01 00000000:00000000 00:00000000 00000000  1000        0 42 1\n";
        assert_eq!(proc_net_inode(tcp6, 0xDBA3, 0xB590), Some(42));
        assert_eq!(proc_net_inode("", 1, 2), None);
    }

    #[test]
    fn candidates_try_recent_pids_first_once() {
        assert_eq!(ordered(&[5, 9], [1, 5, 7, 9]), [5, 9, 1, 7]);
    }

    /// Our own client socket, connected to our own listener, resolves to THIS process — the
    /// real OS path (libproc on macOS, /proc on Linux), no fixture.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_connection_from_this_process_resolves_to_this_process() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, peer) = listener.accept().unwrap();
        assert_eq!(peer, client.local_addr().unwrap());
        let r = Resolver::default();
        let t = Instant::now();
        let got = r
            .resolve(peer, server.local_addr().unwrap())
            .expect("our own socket must resolve");
        let cold = t.elapsed();
        assert_eq!(got.pid, std::process::id());
        let exe = std::env::current_exe().unwrap();
        let exe = exe.canonicalize().unwrap_or(exe);
        let path = got.path.clone().expect("our own exe is readable");
        let path = std::path::PathBuf::from(&path);
        assert_eq!(path.canonicalize().unwrap_or(path), exe);
        assert_eq!(
            got.name,
            exe.file_name().unwrap().to_string_lossy(),
            "named after the test binary"
        );
        // Warm: the pid is remembered, so a second connection costs one fd table.
        let c2 = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (s2, p2) = listener.accept().unwrap();
        let t = Instant::now();
        let again = r.resolve(p2, s2.local_addr().unwrap()).unwrap();
        let warm = t.elapsed();
        assert_eq!(again.pid, std::process::id());
        eprintln!("resolve: cold {cold:?}, warm {warm:?}");
        assert!(
            warm < Duration::from_millis(100),
            "warm resolve took {warm:?}"
        );
        drop((client, c2));
    }

    /// Another process's connection resolves to THAT process — not to us, although we hold
    /// the other end of the same connection (the accepted socket, ports mirrored). A child
    /// `bash` opens the socket with `/dev/tcp` and `exec`s `sleep`, keeping the fd and the pid.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_connection_from_a_child_process_resolves_to_the_child() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut child = std::process::Command::new("/bin/bash")
            .args([
                "-c",
                &format!("exec 3<>/dev/tcp/127.0.0.1/{port}; exec sleep 20"),
            ])
            .env_clear()
            .spawn()
            .unwrap();
        let (server, peer) = listener.accept().unwrap();
        let got = Resolver::default().resolve(peer, server.local_addr().unwrap());
        let _ = child.kill();
        let _ = child.wait();
        let got = got.expect("the child's socket must resolve");
        assert_eq!(got.pid, child.id(), "{got:?}");
        assert_ne!(got.pid, std::process::id());
        assert!(
            got.name == "sleep" || got.name == "bash",
            "named after its executable: {got:?}"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_port_nobody_owns_resolves_to_none_not_a_panic() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let local = listener.local_addr().unwrap();
        let fake_peer: SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert_eq!(Resolver::default().resolve(fake_peer, local), None);
    }
}
