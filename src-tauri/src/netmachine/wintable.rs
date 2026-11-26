//! Pure Windows connection-table parsing (bytes → rows → apps), tested on every OS. Rows are the
//! `*_OWNER_PID` structs (all `DWORD`s, no padding, right after a `u32` count). Addresses are in
//! network order; a port's first two bytes are big-endian; its `DWORD`'s upper half is unread.

use super::procnet::display_addr;
use super::{MachineProto, RawApp, RawConn};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// The backend name on the wire (`MachineStatus.backend`). Here, not in the `cfg(windows)`
/// glue, so the contract goldens and the frontend's types are pinned from any OS.
pub const BACKEND: &str = "windows-iphlpapi";

/// Why the byte columns are empty on Windows. Shown under the table, like Linux's notes.
pub const NO_BYTES_REASON: &str =
    "Byte counts aren't shown on Windows: the system only keeps them per connection after an administrator turns them on.";

/// `MIB_TCP_STATE_LISTEN` — a listener's remote endpoint is meaningless (zeroes).
pub const STATE_LISTEN: u32 = 2;

const TCP4_ROW: usize = 24;
const TCP6_ROW: usize = 56;
const UDP4_ROW: usize = 12;
const UDP6_ROW: usize = 28;

/// One TCP row of either family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcpRow {
    pub local: SocketAddr,
    pub remote: SocketAddr,
    /// `MIB_TCP_STATE_*`.
    pub state: u32,
    pub pid: u32,
}

/// One UDP row of either family (UDP has no remote endpoint and no state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UdpRow {
    pub local: SocketAddr,
    pub pid: u32,
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_ne_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn port_at(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}

fn v4_at(b: &[u8], at: usize) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(b[at], b[at + 1], b[at + 2], b[at + 3]))
}

fn v6_at(b: &[u8], at: usize) -> IpAddr {
    let mut a = [0u8; 16];
    a.copy_from_slice(&b[at..at + 16]);
    IpAddr::V6(Ipv6Addr::from(a))
}

/// The complete rows of a table buffer. A count larger than the buffer holds (a table that
/// grew between the size probe and the read, or a truncated buffer) yields the rows that are
/// really there — never a read past the end.
fn rows(buf: &[u8], row: usize) -> impl Iterator<Item = &[u8]> {
    let count = if buf.len() >= 4 {
        u32_at(buf, 0) as usize
    } else {
        0
    };
    buf.get(4..)
        .unwrap_or_default()
        .chunks_exact(row)
        .take(count)
}

/// `MIB_TCPTABLE_OWNER_PID`.
pub fn parse_tcp4(buf: &[u8]) -> Vec<TcpRow> {
    rows(buf, TCP4_ROW)
        .map(|r| TcpRow {
            state: u32_at(r, 0),
            local: SocketAddr::new(v4_at(r, 4), port_at(r, 8)),
            remote: SocketAddr::new(v4_at(r, 12), port_at(r, 16)),
            pid: u32_at(r, 20),
        })
        .collect()
}

/// `MIB_TCP6TABLE_OWNER_PID`.
pub fn parse_tcp6(buf: &[u8]) -> Vec<TcpRow> {
    rows(buf, TCP6_ROW)
        .map(|r| TcpRow {
            local: SocketAddr::new(v6_at(r, 0), port_at(r, 20)),
            remote: SocketAddr::new(v6_at(r, 24), port_at(r, 44)),
            state: u32_at(r, 48),
            pid: u32_at(r, 52),
        })
        .collect()
}

/// `MIB_UDPTABLE_OWNER_PID`.
pub fn parse_udp4(buf: &[u8]) -> Vec<UdpRow> {
    rows(buf, UDP4_ROW)
        .map(|r| UdpRow {
            local: SocketAddr::new(v4_at(r, 0), port_at(r, 4)),
            pid: u32_at(r, 8),
        })
        .collect()
}

/// `MIB_UDP6TABLE_OWNER_PID`.
pub fn parse_udp6(buf: &[u8]) -> Vec<UdpRow> {
    rows(buf, UDP6_ROW)
        .map(|r| UdpRow {
            local: SocketAddr::new(v6_at(r, 0), port_at(r, 20)),
            pid: u32_at(r, 24),
        })
        .collect()
}

/// `MIB_TCP_STATE_*` in the words the macOS and Linux backends use.
pub fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "Closed",
        2 => "Listen",
        3 => "SynSent",
        4 => "SynReceived",
        5 => "Established",
        6 => "FinWait1",
        7 => "FinWait2",
        8 => "CloseWait",
        9 => "Closing",
        10 => "LastAck",
        11 => "TimeWait",
        // DELETE_TCB: the connection is being torn down.
        12 => "Closed",
        _ => "Unknown",
    }
}

/// Pid 4 is the kernel ("System"). Pid 0 is no process (TIME_WAIT/teardown under Idle), named
/// like Linux's inode-0 sockets ([`super::procnet::NO_PROCESS`]), not "System Idle Process".
fn fixed_name(pid: u32) -> Option<&'static str> {
    match pid {
        0 => Some(super::procnet::NO_PROCESS),
        4 => Some("System"),
        _ => None,
    }
}

/// Group rows by owning pid, first-seen order (TCP then UDP). A pid gone before the snapshot is
/// `pid <n>`, still listed. No byte counters (they need admin-enabled EStats).
pub fn assemble(tcp: &[TcpRow], udp: &[UdpRow], names: &HashMap<u32, String>) -> Vec<RawApp> {
    let mut apps: Vec<RawApp> = Vec::new();
    let mut index: HashMap<u32, usize> = HashMap::new();
    let mut app_of = |pid: u32, apps: &mut Vec<RawApp>| -> usize {
        *index.entry(pid).or_insert_with(|| {
            let name = fixed_name(pid)
                .map(str::to_string)
                .or_else(|| names.get(&pid).map(|n| strip_exe(n).to_string()))
                .unwrap_or_else(|| format!("pid {pid}"));
            apps.push(RawApp {
                name,
                pid,
                // Windows names every owner, whoever it runs as; "whose is it" would need
                // each process's token, which another user's process does not give us.
                user: None,
                totals: None,
                conns: Vec::new(),
            });
            apps.len() - 1
        })
    };
    for r in tcp {
        let v6 = r.local.is_ipv6();
        // A listener has no peer; neither does a row whose remote is all zeroes.
        let remote = (r.state != STATE_LISTEN
            && !(r.remote.ip().is_unspecified() && r.remote.port() == 0))
            .then_some(r.remote);
        let i = app_of(r.pid, &mut apps);
        apps[i].conns.push(RawConn {
            proto: if v6 {
                MachineProto::Tcp6
            } else {
                MachineProto::Tcp4
            },
            local: display_addr(&r.local),
            remote: remote.map(|a| display_addr(&a)),
            remote_ip: remote.map(|a| a.ip()),
            state: tcp_state_name(r.state).to_string(),
            bytes_in: None,
            bytes_out: None,
        });
    }
    for r in udp {
        let i = app_of(r.pid, &mut apps);
        apps[i].conns.push(RawConn {
            proto: if r.local.is_ipv6() {
                MachineProto::Udp6
            } else {
                MachineProto::Udp4
            },
            local: display_addr(&r.local),
            remote: None,
            remote_ip: None,
            state: String::new(),
            bytes_in: None,
            bytes_out: None,
        });
    }
    apps
}

/// `chrome.exe` → `chrome` (any case); a name that is only `.exe` is kept.
pub fn strip_exe(name: &str) -> &str {
    let cut = name.len().saturating_sub(4);
    match name.get(cut..) {
        Some(ext) if cut > 0 && ext.eq_ignore_ascii_case(".exe") => &name[..cut],
        _ => name,
    }
}

/// The proxy client's pid: the row whose LOCAL endpoint is `peer` and REMOTE port is ours (our
/// own row has them reversed). IPv4-mapped IPv6 compares equal to IPv4.
pub fn owner_pid(tcp: &[TcpRow], peer: SocketAddr, listen_port: u16) -> Option<u32> {
    let canon = |ip: IpAddr| match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    };
    tcp.iter()
        .find(|r| {
            r.local.port() == peer.port()
                && r.remote.port() == listen_port
                && r.state != STATE_LISTEN
                && canon(r.local.ip()) == canon(peer.ip())
        })
        .map(|r| r.pid)
        // Pid 0 is "no owner" (a socket in teardown) — never a client we can name.
        .filter(|pid| *pid != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- hand-built tables: every byte below is written out, never produced by the parser's
    // own inverse (an encoder written from the decoder proves nothing). ----------

    fn table(count: u32, rows: &[&[u8]]) -> Vec<u8> {
        let mut b = count.to_ne_bytes().to_vec();
        for r in rows {
            b.extend_from_slice(r);
        }
        b
    }

    /// state=5 (ESTAB), 127.0.0.1:51234 → 127.0.0.1:8877, pid 4660.
    /// 51234 = 0xC822, 8877 = 0x22AD — big-endian in the first two bytes of each port DWORD;
    /// the upper two bytes are deliberately garbage (documented as possibly uninitialised).
    #[rustfmt::skip]
    const TCP4_LOOPBACK: [u8; 24] = [
        5, 0, 0, 0,
        127, 0, 0, 1,
        0xC8, 0x22, 0xEE, 0xEE,
        127, 0, 0, 1,
        0x22, 0xAD, 0xEE, 0xEE,
        0x34, 0x12, 0, 0,
    ];

    /// state=2 (LISTEN), 0.0.0.0:445, remote zeroes, pid 4 (System).
    #[rustfmt::skip]
    const TCP4_LISTENER: [u8; 24] = [
        2, 0, 0, 0,
        0, 0, 0, 0,
        0x01, 0xBD, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0,
        4, 0, 0, 0,
    ];

    #[cfg(target_endian = "little")]
    #[test]
    fn a_tcp4_table_is_read_field_by_field() {
        let rows = parse_tcp4(&table(2, &[&TCP4_LOOPBACK, &TCP4_LISTENER]));
        assert_eq!(
            rows,
            vec![
                TcpRow {
                    local: "127.0.0.1:51234".parse().unwrap(),
                    remote: "127.0.0.1:8877".parse().unwrap(),
                    state: 5,
                    pid: 0x1234,
                },
                TcpRow {
                    local: "0.0.0.0:445".parse().unwrap(),
                    remote: "0.0.0.0:0".parse().unwrap(),
                    state: 2,
                    pid: 4,
                },
            ]
        );
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn a_tcp6_table_is_read_field_by_field() {
        // [::1]:50000 → [2606:4700::1111]:443, state 5, pid 900. 50000 = 0xC350, 443 = 0x01BB.
        let mut r = Vec::new();
        r.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]); // local addr
        r.extend_from_slice(&[7, 0, 0, 0]); // local scope id (ignored)
        r.extend_from_slice(&[0xC3, 0x50, 0, 0]); // local port
        r.extend_from_slice(&[
            0x26, 0x06, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11,
        ]);
        r.extend_from_slice(&[0, 0, 0, 0]); // remote scope id
        r.extend_from_slice(&[0x01, 0xBB, 0, 0]); // remote port
        r.extend_from_slice(&[5, 0, 0, 0]); // state
        r.extend_from_slice(&[0x84, 0x03, 0, 0]); // pid 900
        assert_eq!(r.len(), 56);
        assert_eq!(
            parse_tcp6(&table(1, &[&r])),
            vec![TcpRow {
                local: "[::1]:50000".parse().unwrap(),
                remote: "[2606:4700::1111]:443".parse().unwrap(),
                state: 5,
                pid: 900,
            }]
        );
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn udp_tables_of_both_families_are_read() {
        // 0.0.0.0:5353, pid 2000 (0x07D0). 5353 = 0x14E9.
        let v4: [u8; 12] = [0, 0, 0, 0, 0x14, 0xE9, 0, 0, 0xD0, 0x07, 0, 0];
        assert_eq!(
            parse_udp4(&table(1, &[&v4])),
            vec![UdpRow {
                local: "0.0.0.0:5353".parse().unwrap(),
                pid: 2000,
            }]
        );
        // [::]:5353, scope 0, pid 2000.
        let mut v6 = vec![0u8; 16];
        v6.extend_from_slice(&[0, 0, 0, 0]);
        v6.extend_from_slice(&[0x14, 0xE9, 0, 0]);
        v6.extend_from_slice(&[0xD0, 0x07, 0, 0]);
        assert_eq!(v6.len(), 28);
        assert_eq!(
            parse_udp6(&table(1, &[&v6])),
            vec![UdpRow {
                local: "[::]:5353".parse().unwrap(),
                pid: 2000,
            }]
        );
    }

    #[test]
    fn a_short_or_lying_table_never_reads_past_its_end() {
        assert!(parse_tcp4(&[]).is_empty());
        assert!(parse_tcp4(&[1, 0]).is_empty(), "no room for a count");
        // The count says 3; one complete row and 5 stray bytes are there.
        let mut b = table(3, &[&TCP4_LOOPBACK]);
        b.extend_from_slice(&[9, 9, 9, 9, 9]);
        assert_eq!(parse_tcp4(&b).len(), 1);
        // The count says 1; two rows are there — only the counted one is a row.
        assert_eq!(
            parse_tcp4(&table(1, &[&TCP4_LOOPBACK, &TCP4_LISTENER])).len(),
            1
        );
        assert!(parse_tcp6(&table(1, &[&TCP4_LOOPBACK])).is_empty());
        assert!(parse_udp4(&table(0, &[])).is_empty());
        assert!(parse_udp6(&[0, 0, 0]).is_empty());
    }

    #[test]
    fn the_state_table() {
        let table: &[(u32, &str)] = &[
            (1, "Closed"),
            (2, "Listen"),
            (3, "SynSent"),
            (4, "SynReceived"),
            (5, "Established"),
            (6, "FinWait1"),
            (7, "FinWait2"),
            (8, "CloseWait"),
            (9, "Closing"),
            (10, "LastAck"),
            (11, "TimeWait"),
            (12, "Closed"),
            (0, "Unknown"),
            (13, "Unknown"),
        ];
        for (code, name) in table {
            assert_eq!(tcp_state_name(*code), *name, "state {code}");
        }
    }

    fn tcp(local: &str, remote: &str, state: u32, pid: u32) -> TcpRow {
        TcpRow {
            local: local.parse().unwrap(),
            remote: remote.parse().unwrap(),
            state,
            pid,
        }
    }

    #[test]
    fn rows_are_grouped_by_process_and_named_from_the_snapshot() {
        let names: HashMap<u32, String> = [
            (900, "chrome.exe".to_string()),
            (901, "node.EXE".to_string()),
        ]
        .into();
        let apps = assemble(
            &[
                tcp("192.168.1.5:50001", "142.250.72.14:443", 5, 900),
                tcp("0.0.0.0:445", "0.0.0.0:0", 2, 4),
                tcp("[::1]:50002", "[::1]:3000", 5, 901),
                tcp("192.168.1.5:50003", "142.250.72.14:443", 11, 900),
                tcp("127.0.0.1:50004", "127.0.0.1:9", 5, 7777),
            ],
            &[UdpRow {
                local: "0.0.0.0:5353".parse().unwrap(),
                pid: 900,
            }],
            &names,
        );
        let summary: Vec<(&str, u32, usize)> = apps
            .iter()
            .map(|a| (a.name.as_str(), a.pid, a.conns.len()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("chrome", 900, 3),
                ("System", 4, 1),
                ("node", 901, 1),
                ("pid 7777", 7777, 1)
            ]
        );
        for a in &apps {
            assert_eq!(a.user, None);
            assert_eq!(a.totals, None);
        }

        let chrome = &apps[0];
        assert_eq!(chrome.conns[0].proto, MachineProto::Tcp4);
        assert_eq!(chrome.conns[0].local, "192.168.1.5:50001");
        assert_eq!(chrome.conns[0].remote.as_deref(), Some("142.250.72.14:443"));
        assert_eq!(
            chrome.conns[0].remote_ip,
            Some("142.250.72.14".parse().unwrap())
        );
        assert_eq!(chrome.conns[0].state, "Established");
        assert_eq!(
            (chrome.conns[0].bytes_in, chrome.conns[0].bytes_out),
            (None, None)
        );
        assert_eq!(chrome.conns[1].state, "TimeWait");
        // The UDP socket: no peer, no state.
        assert_eq!(chrome.conns[2].proto, MachineProto::Udp4);
        assert_eq!(chrome.conns[2].local, "*:5353");
        assert_eq!(chrome.conns[2].remote, None);
        assert_eq!(chrome.conns[2].state, "");

        // A listener: wildcard local, no remote, nothing to reverse-resolve.
        let system = &apps[1];
        assert_eq!(system.conns[0].local, "*:445");
        assert_eq!(system.conns[0].remote, None);
        assert_eq!(system.conns[0].remote_ip, None);
        assert_eq!(system.conns[0].state, "Listen");

        assert_eq!(apps[2].conns[0].proto, MachineProto::Tcp6);
        assert_eq!(apps[2].conns[0].remote.as_deref(), Some("[::1]:3000"));
    }

    /// Pid 0's rows are connections their program already closed (`TIME_WAIT`, teardown):
    /// one "no process" app — Linux's name for the same sockets — never "System Idle Process",
    /// whatever the snapshot calls pid 0.
    #[test]
    fn pid_zero_rows_are_closed_connections_of_no_process() {
        let names: HashMap<u32, String> = [
            (0, "[System Process]".to_string()),
            (900, "chrome.exe".to_string()),
        ]
        .into();
        let apps = assemble(
            &[
                tcp("192.168.1.5:50001", "142.250.72.14:443", 11, 0),
                tcp("192.168.1.5:50002", "142.250.72.14:443", 5, 900),
                tcp("127.0.0.1:50003", "127.0.0.1:8877", 11, 0),
                tcp("[::1]:50004", "[::1]:3000", 12, 0),
            ],
            &[],
            &names,
        );
        let summary: Vec<(&str, u32, usize)> = apps
            .iter()
            .map(|a| (a.name.as_str(), a.pid, a.conns.len()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (super::super::procnet::NO_PROCESS, 0, 3),
                ("chrome", 900, 1)
            ]
        );
        assert_eq!(super::super::procnet::NO_PROCESS, "no process");
        let closed: Vec<&str> = apps[0].conns.iter().map(|c| c.state.as_str()).collect();
        assert_eq!(closed, ["TimeWait", "TimeWait", "Closed"]);
        assert!(apps.iter().all(|a| !a.name.contains("Idle")));
    }

    #[test]
    fn the_exe_suffix_table() {
        let table: &[(&str, &str)] = &[
            ("chrome.exe", "chrome"),
            ("Node.EXE", "Node"),
            ("claude", "claude"),
            (".exe", ".exe"),
            ("a.exe.bak", "a.exe.bak"),
            ("", ""),
            ("ünï.exe", "ünï"),
        ];
        for (name, want) in table {
            assert_eq!(strip_exe(name), *want, "{name:?}");
        }
    }

    #[test]
    fn the_owner_is_the_row_whose_local_end_is_the_client() {
        let rows = [
            // Our own side of the same connection: ports the other way round.
            tcp("127.0.0.1:8877", "127.0.0.1:51234", 5, 100),
            // Our listener.
            tcp("127.0.0.1:8877", "0.0.0.0:0", 2, 100),
            // An unrelated connection to something else's port 8877 on another address.
            tcp("192.168.1.5:51234", "10.0.0.9:8877", 5, 300),
            // The client.
            tcp("127.0.0.1:51234", "127.0.0.1:8877", 5, 200),
        ];
        let peer: SocketAddr = "127.0.0.1:51234".parse().unwrap();
        assert_eq!(owner_pid(&rows, peer, 8877), Some(200));
        // A different listen port, or a different client port: nobody.
        assert_eq!(owner_pid(&rows, peer, 8878), None);
        assert_eq!(
            owner_pid(&rows, "127.0.0.1:51235".parse().unwrap(), 8877),
            None
        );
        assert_eq!(owner_pid(&[], peer, 8877), None);
    }

    #[test]
    fn a_mapped_address_is_the_same_client_and_pid_zero_is_nobody() {
        let mapped = [tcp(
            "[::ffff:127.0.0.1]:51234",
            "[::ffff:127.0.0.1]:8877",
            5,
            200,
        )];
        let peer: SocketAddr = "127.0.0.1:51234".parse().unwrap();
        assert_eq!(owner_pid(&mapped, peer, 8877), Some(200));
        let v4 = [tcp("127.0.0.1:51234", "127.0.0.1:8877", 5, 200)];
        let mapped_peer: SocketAddr = "[::ffff:127.0.0.1]:51234".parse().unwrap();
        assert_eq!(owner_pid(&v4, mapped_peer, 8877), Some(200));

        let dying = [tcp("127.0.0.1:51234", "127.0.0.1:8877", 5, 0)];
        assert_eq!(owner_pid(&dying, peer, 8877), None);
        // A LISTEN row that happens to carry matching numbers is not a client.
        let listener = [tcp("127.0.0.1:51234", "127.0.0.1:8877", 2, 200)];
        assert_eq!(owner_pid(&listener, peer, 8877), None);
    }
}
