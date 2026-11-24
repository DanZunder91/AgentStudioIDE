//! Windows glue: every second, read the kernel's TCP and UDP tables with their owning pids
//! (`GetExtendedTcpTable` / `GetExtendedUdpTable`, iphlpapi) and name the pids from one process
//! snapshot (Toolhelp). No administrator rights, no prompt, nothing installed, no child process
//! (zero-install, no OS permission; and a child would be one more console window —
//! `crate::spawn`).
//!
//! Everything that can be decided without Windows is in [`super::wintable`] (pure, tested on
//! every OS). This file is only the API calls, kept as small as they can be. Its tests run on
//! Windows alone, against the real tables.
//!
//! **No byte counts.** Windows keeps per-connection counters only after an administrator
//! enables them (`SetPerTcpConnectionEStats`); we never ask. `has_bytes` is false and the
//! status carries [`NO_BYTES_REASON`](super::wintable::NO_BYTES_REASON), the same shape as
//! Linux without `ss`.

use super::wintable::{
    assemble, parse_tcp4, parse_tcp6, parse_udp4, parse_udp6, strip_exe, TcpRow, UdpRow, BACKEND,
    NO_BYTES_REASON,
};
use super::{Platform, RawApp, RawSample, Source, SourceFactory};
use std::collections::HashMap;
use std::ffi::c_void;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, INVALID_HANDLE_VALUE, NO_ERROR,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::Networking::WinSock::{getnameinfo, WSAStartup, SOCKADDR, WSADATA};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// `AF_INET` / `AF_INET6` (ws2def.h).
const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;
/// `NI_NAMEREQD` (ws2def.h): fail instead of answering with the address again.
const NI_NAMEREQD: i32 = 0x04;
/// `NI_MAXHOST`.
const HOST_LEN: usize = 1025;

pub fn platform() -> (Platform, Option<SourceFactory>) {
    (
        Platform {
            available: true,
            backend: Some(BACKEND),
            reason: Some(NO_BYTES_REASON.to_string()),
            has_bytes: false,
        },
        Some(Arc::new(|| {
            Ok(Box::new(TableSource::new()) as Box<dyn Source>)
        })),
    )
}

pub struct TableSource {
    tick: tokio::time::Interval,
}

impl TableSource {
    pub fn new() -> TableSource {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        TableSource { tick }
    }
}

impl Default for TableSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Source for TableSource {
    async fn next(&mut self) -> Result<RawSample, String> {
        self.tick.tick().await;
        let apps = tokio::task::spawn_blocking(read_sample)
            .await
            .map_err(|e| format!("Reading the connection tables failed: {e}"))??;
        Ok(RawSample {
            apps,
            interval_ms: None,
        })
    }
}

#[derive(Clone, Copy)]
enum Table {
    Tcp,
    Udp,
}

/// One table as bytes. The size is probed, then read; the table can grow in between, so the
/// read is retried with the size the API asked for (plus slack) a few times.
fn read_table(kind: Table, family: u32) -> Result<Vec<u8>, String> {
    let mut size: u32 = 0;
    for _ in 0..6 {
        // `u32` words, so the buffer is aligned for the `DWORD` rows the API writes.
        let mut words = vec![0u32; (size as usize).div_ceil(4)];
        let ptr: *mut c_void = if words.is_empty() {
            std::ptr::null_mut()
        } else {
            words.as_mut_ptr().cast()
        };
        let mut len = (words.len() * 4) as u32;
        // SAFETY: `ptr` is null with `len == 0` (a size probe) or points at `len` writable
        // bytes owned by `words` for the whole call. The API writes at most `len` bytes and
        // stores the size it needs in `len`.
        let rc = unsafe {
            match kind {
                Table::Tcp => {
                    GetExtendedTcpTable(ptr, &mut len, 0, family, TCP_TABLE_OWNER_PID_ALL, 0)
                }
                Table::Udp => GetExtendedUdpTable(ptr, &mut len, 0, family, UDP_TABLE_OWNER_PID, 0),
            }
        };
        if rc == NO_ERROR {
            return Ok(words.iter().flat_map(|w| w.to_ne_bytes()).collect());
        }
        if rc != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "The Windows connection table could not be read (error {rc})."
            ));
        }
        size = len.saturating_add(4096);
    }
    Err("The Windows connection table kept changing size and could not be read.".to_string())
}

/// Every TCP row, both families. IPv4 failing is an error; IPv6 can simply be switched off.
pub fn tcp_rows() -> Result<Vec<TcpRow>, String> {
    let mut rows = parse_tcp4(&read_table(Table::Tcp, AF_INET)?);
    if let Ok(b) = read_table(Table::Tcp, AF_INET6) {
        rows.extend(parse_tcp6(&b));
    }
    Ok(rows)
}

fn udp_rows() -> Vec<UdpRow> {
    let mut rows = read_table(Table::Udp, AF_INET)
        .map(|b| parse_udp4(&b))
        .unwrap_or_default();
    if let Ok(b) = read_table(Table::Udp, AF_INET6) {
        rows.extend(parse_udp6(&b));
    }
    rows
}

/// One full sample from the real tables (blocking).
pub fn read_sample() -> Result<Vec<RawApp>, String> {
    Ok(assemble(&tcp_rows()?, &udp_rows(), &process_names()))
}

/// `pid → image name` (`chrome.exe`) for every process on the machine. Toolhelp needs no
/// rights and names other users' and services' processes too. Empty on failure.
pub fn process_names() -> HashMap<u32, String> {
    let mut out = HashMap::new();
    // SAFETY: a plain call; the handle is checked before use and closed below.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE || snap.is_null() {
        return out;
    }
    // SAFETY: `PROCESSENTRY32W` is plain data, for which all-zero is a valid value.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: `snap` is a live snapshot handle and `entry` a writable struct whose `dwSize`
    // is set, as the API requires.
    let mut more = unsafe { Process32FirstW(snap, &mut entry) };
    while more != 0 {
        let name = &entry.szExeFile;
        let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        out.insert(entry.th32ProcessID, String::from_utf16_lossy(&name[..len]));
        // SAFETY: as above.
        more = unsafe { Process32NextW(snap, &mut entry) };
    }
    // SAFETY: `snap` is ours and is not used again.
    unsafe { CloseHandle(snap) };
    out
}

/// The image name of one pid without its `.exe` (`chrome`), from a fresh snapshot.
pub fn process_name(pid: u32) -> Option<String> {
    process_names()
        .get(&pid)
        .map(|n| strip_exe(n).to_string())
        .filter(|n| !n.is_empty())
}

/// The full path of a process's executable. `None` for a process we may not open (another
/// user's, a protected service) — the caller falls back to the image name.
pub fn exe_path(pid: u32) -> Option<String> {
    // SAFETY: a plain call; a null handle (no access, or the pid is gone) is handled.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    // The longest path Windows can return (`\\?\` form), in UTF-16 units.
    let mut buf = vec![0u16; 32_768];
    let mut len = buf.len() as u32;
    // SAFETY: `handle` is a live process handle; `buf` is writable for `len` units, and the
    // API stores the number of units written (without the NUL) back into `len`.
    let ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
    };
    // SAFETY: `handle` is ours and is not used again.
    unsafe { CloseHandle(handle) };
    (ok != 0 && len > 0 && (len as usize) <= buf.len())
        .then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

/// Winsock must be started once per process before `getnameinfo`. std starts it for its own
/// sockets, but nothing promises that happened first.
fn winsock_ready() -> bool {
    static READY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *READY.get_or_init(|| {
        // SAFETY: `WSADATA` is plain data (zero is valid) and is only written by the call.
        let mut data: WSADATA = unsafe { std::mem::zeroed() };
        // SAFETY: version 2.2, and a writable `WSADATA`.
        unsafe { WSAStartup(0x0202, &mut data) == 0 }
    })
}

/// The OS resolver: `getnameinfo(NI_NAMEREQD)` — a PTR lookup; blocking, run off the sampler
/// ([`super::rdns`] bounds how many run at once).
pub fn reverse_dns(ip: IpAddr) -> Option<String> {
    if !winsock_ready() {
        return None;
    }
    // `sockaddr_in` (16 bytes) / `sockaddr_in6` (28 bytes), written field by field. The family
    // is a native-endian `u16`; the port (0) and address are in network byte order. Built as
    // `u32` words so the pointer is aligned for either struct.
    let mut words = [0u32; 7];
    let len: i32 = {
        // SAFETY: `words` is 28 bytes of plain data; viewing it as bytes is always valid.
        let bytes: &mut [u8] =
            unsafe { std::slice::from_raw_parts_mut(words.as_mut_ptr().cast::<u8>(), 28) };
        match ip {
            IpAddr::V4(v4) => {
                bytes[..2].copy_from_slice(&(AF_INET as u16).to_ne_bytes());
                bytes[4..8].copy_from_slice(&v4.octets());
                16
            }
            IpAddr::V6(v6) => {
                bytes[..2].copy_from_slice(&(AF_INET6 as u16).to_ne_bytes());
                bytes[8..24].copy_from_slice(&v6.octets());
                28
            }
        }
    };
    let mut host = [0u8; HOST_LEN];
    // SAFETY: `words` holds a complete sockaddr of `len` bytes; `host` is writable for its
    // length; no service buffer is passed.
    let rc = unsafe {
        getnameinfo(
            words.as_ptr().cast::<SOCKADDR>(),
            len,
            host.as_mut_ptr(),
            host.len() as u32,
            std::ptr::null_mut(),
            0,
            NI_NAMEREQD,
        )
    };
    if rc != 0 {
        return None;
    }
    let end = host.iter().position(|c| *c == 0).unwrap_or(host.len());
    let name = String::from_utf8_lossy(&host[..end])
        .trim_end_matches('.')
        .to_string();
    // A PTR that is just the address again is no answer.
    (!name.is_empty() && name.parse::<IpAddr>().is_err()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::super::wintable::owner_pid;
    use super::*;

    /// The real tables: a loopback connection made by this test is found and attributed to
    /// this very process — the exact question the capture proxy asks about every client.
    #[test]
    fn the_real_tcp_table_names_this_process_for_its_own_connection() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let listen = listener.local_addr().unwrap();
        let client = std::net::TcpStream::connect(listen).unwrap();
        let (_server, _) = listener.accept().unwrap();
        let peer = client.local_addr().unwrap();

        let rows = tcp_rows().expect("the TCP table is readable without any rights");
        assert!(!rows.is_empty());
        assert_eq!(
            owner_pid(&rows, peer, listen.port()),
            Some(std::process::id()),
            "peer {peer} → listen {listen}"
        );

        let me = std::process::id();
        let path = exe_path(me).expect("a process can read its own image path");
        let this = std::env::current_exe().unwrap();
        assert_eq!(
            std::path::Path::new(&path).file_name(),
            this.file_name(),
            "{path}"
        );
        let name = process_name(me).expect("this process is in the snapshot");
        assert_eq!(
            Some(name.as_str()),
            this.file_stem().and_then(|s| s.to_str())
        );
    }

    #[test]
    fn a_real_sample_lists_this_process_with_its_listener() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let apps = read_sample().expect("a sample");
        let me = apps
            .iter()
            .find(|a| a.pid == std::process::id())
            .expect("this process owns a socket, so it is listed");
        assert!(
            me.conns
                .iter()
                .any(|c| c.local == format!("127.0.0.1:{port}") && c.state == "Listen"),
            "{:?}",
            me.conns
        );
        // Every app has a name, and none still carries `.exe`. Pid 0's closed connections are
        // "no process", never an app called "System Idle Process".
        for a in &apps {
            assert!(!a.name.is_empty());
            assert!(!a.name.to_ascii_lowercase().ends_with(".exe"), "{}", a.name);
            assert_ne!(a.name, "System Idle Process");
            if a.pid == 0 {
                assert_eq!(a.name, super::super::procnet::NO_PROCESS);
            }
        }
    }

    #[test]
    fn a_pid_that_does_not_exist_has_no_path_and_no_name() {
        // Pids are multiples of 4 on Windows; this one is not, so it can never exist.
        assert_eq!(exe_path(0xFFFF_FFF1), None);
        assert_eq!(process_name(0xFFFF_FFF1), None);
    }

    #[test]
    fn reverse_dns_of_a_private_address_never_panics() {
        // No promise about the answer (it depends on the machine's resolver) — only that the
        // call is well-formed for both families and returns.
        let _ = reverse_dns("127.0.0.1".parse().unwrap());
        let _ = reverse_dns("::1".parse().unwrap());
    }

    #[tokio::test]
    async fn the_source_yields_a_sample() {
        let (platform, factory) = platform();
        assert!(platform.available);
        assert_eq!(platform.backend, Some(BACKEND));
        assert!(!platform.has_bytes);
        let mut source = factory.expect("a factory")().expect("a source");
        let sample = source.next().await.expect("the first sample");
        assert!(!sample.apps.is_empty());
    }
}
