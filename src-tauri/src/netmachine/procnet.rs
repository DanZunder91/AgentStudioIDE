//! Pure parsers for `/proc/net/{tcp,tcp6,udp,udp6}` and `ss -tinH`. Addresses are `__be32`
//! printed as host-order hex (`0100007F` = 127.0.0.1 on little-endian); ports are big-endian
//! hex; `uid` tells another user's socket from ours.

use super::{MachineProto, MachineUser, RawApp, RawConn};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

#[derive(Debug, Clone, PartialEq)]
pub struct ProcSocket {
    pub proto: MachineProto,
    pub local: SocketAddr,
    pub remote: SocketAddr,
    pub state: u8,
    pub uid: u32,
    pub inode: u64,
}

/// Parse one `/proc/net/<proto>` file. Malformed rows are skipped, never fatal.
pub fn parse_proc_net(text: &str, proto: MachineProto) -> Vec<ProcSocket> {
    let v6 = matches!(proto, MachineProto::Tcp6 | MachineProto::Udp6);
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 {
                return None;
            }
            Some(ProcSocket {
                proto,
                local: parse_hex_endpoint(f[1], v6)?,
                remote: parse_hex_endpoint(f[2], v6)?,
                state: u8::from_str_radix(f[3], 16).ok()?,
                uid: f[7].parse().ok()?,
                inode: f[9].parse().ok()?,
            })
        })
        .collect()
}

/// `0100007F:0035` → 127.0.0.1:53 (on the host that wrote it).
pub fn parse_hex_endpoint(s: &str, v6: bool) -> Option<SocketAddr> {
    let (addr, port) = s.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let ip: IpAddr = if v6 {
        if addr.len() != 32 {
            return None;
        }
        let mut bytes = [0u8; 16];
        for (i, chunk) in bytes.chunks_mut(4).enumerate() {
            chunk.copy_from_slice(&host_word(&addr[i * 8..i * 8 + 8])?);
        }
        IpAddr::V6(Ipv6Addr::from(bytes))
    } else {
        if addr.len() != 8 {
            return None;
        }
        IpAddr::V4(Ipv4Addr::from(host_word(addr)?))
    };
    Some(SocketAddr::new(ip, port))
}

/// One 32-bit word as the kernel printed it: an integer in HOST byte order. `to_ne_bytes`
/// recovers the in-memory (network-order) bytes on the machine that wrote the file.
fn host_word(hex: &str) -> Option<[u8; 4]> {
    Some(u32::from_str_radix(hex, 16).ok()?.to_ne_bytes())
}

/// Linux TCP state codes (`include/net/tcp_states.h`), named like nettop names them so the UI
/// sees one vocabulary on both platforms.
pub fn tcp_state_name(code: u8) -> &'static str {
    match code {
        0x01 => "Established",
        0x02 => "SynSent",
        0x03 => "SynReceived",
        0x04 => "FinWait1",
        0x05 => "FinWait2",
        0x06 => "TimeWait",
        0x07 => "Closed",
        0x08 => "CloseWait",
        0x09 => "LastAck",
        0x0A => "Listen",
        0x0B => "Closing",
        0x0C => "SynReceived",
        _ => "Unknown",
    }
}

/// Byte counters from `ss -tinH`, keyed by (local, remote). `(bytes_received, bytes_acked)`.
pub type SsBytes = HashMap<(SocketAddr, SocketAddr), (u64, u64)>;

/// `ss -tinH` prints one socket line (`ESTAB 0 0 127.0.0.1:56227 127.0.0.1:46480`) followed by
/// a whitespace-indented info line with `bytes_acked:N` / `bytes_received:N` (either is omitted
/// while it is 0).
pub fn parse_ss(text: &str) -> SsBytes {
    let mut out = SsBytes::new();
    let mut current: Option<(SocketAddr, SocketAddr)> = None;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            let f: Vec<&str> = line.split_whitespace().collect();
            current = match (f.get(3), f.get(4)) {
                (Some(l), Some(r)) => ss_addr(l).zip(ss_addr(r)),
                _ => None,
            };
            if let Some(k) = current {
                out.insert(k, (0, 0));
            }
            continue;
        }
        let Some(k) = current else { continue };
        let entry = out.entry(k).or_insert((0, 0));
        for tok in line.split_whitespace() {
            if let Some(v) = tok.strip_prefix("bytes_received:") {
                entry.0 = v.parse().unwrap_or(0);
            } else if let Some(v) = tok.strip_prefix("bytes_acked:") {
                entry.1 = v.parse().unwrap_or(0);
            }
        }
    }
    out
}

/// `127.0.0.1:80`, `[::1]:8021`, `[fe80::1%eth0]:22` (the scope is dropped — `/proc` has none).
fn ss_addr(s: &str) -> Option<SocketAddr> {
    if let Some(rest) = s.strip_prefix('[') {
        let (host, port) = rest.rsplit_once("]:")?;
        let host = host.split('%').next()?;
        return Some(SocketAddr::new(host.parse().ok()?, port.parse().ok()?));
    }
    let (host, port) = s.rsplit_once(':')?;
    let host = host.split('%').next()?;
    Some(SocketAddr::new(host.parse().ok()?, port.parse().ok()?))
}

/// Display form shared with the macOS backend: `10.0.0.5:443`, `[::1]:8021`, `*:22`.
pub fn display_addr(a: &SocketAddr) -> String {
    if a.ip().is_unspecified() {
        return format!("*:{}", a.port());
    }
    a.to_string()
}

/// Name given to sockets that belong to another user: without root, `/proc/<pid>/fd` of their
/// processes is unreadable, so the socket is visible but its process is not.
pub const OTHER_USER: &str = "other user";
/// Our own socket whose process we could not find (e.g. TIME_WAIT: inode 0, no fd left).
pub const NO_PROCESS: &str = "no process";

/// Group `/proc/net` sockets into apps. `owners` maps a socket inode to (pid, name) — built from
/// `/proc/<pid>/fd` — and `ss` supplies TCP byte counters when `ss` is installed.
pub fn assemble(
    sockets: &[ProcSocket],
    owners: &HashMap<u64, (u32, String)>,
    my_uid: u32,
    ss: Option<&SsBytes>,
) -> Vec<RawApp> {
    let mut apps: Vec<RawApp> = Vec::new();
    let mut index: HashMap<(String, u32), usize> = HashMap::new();
    for s in sockets {
        let owner = (s.inode != 0).then(|| owners.get(&s.inode)).flatten();
        let (name, pid, user) = match owner {
            Some((pid, name)) => (name.clone(), *pid, MachineUser::SelfUser),
            None if s.uid == my_uid => (NO_PROCESS.to_string(), 0, MachineUser::SelfUser),
            None => (OTHER_USER.to_string(), 0, MachineUser::Other),
        };
        let tcp = matches!(s.proto, MachineProto::Tcp4 | MachineProto::Tcp6);
        let remote = (!s.remote.ip().is_unspecified() || s.remote.port() != 0).then_some(s.remote);
        let (bytes_in, bytes_out) = match (tcp, ss) {
            (true, Some(ss)) => {
                let b = remote
                    .and_then(|r| ss.get(&(s.local, r)))
                    .copied()
                    .unwrap_or((0, 0));
                (Some(b.0), Some(b.1))
            }
            _ => (None, None),
        };
        let conn = RawConn {
            proto: s.proto,
            local: display_addr(&s.local),
            remote: remote.map(|r| display_addr(&r)),
            remote_ip: remote.map(|r| r.ip()),
            state: if tcp {
                tcp_state_name(s.state).to_string()
            } else {
                String::new()
            },
            bytes_in,
            bytes_out,
        };
        let i = *index.entry((name.clone(), pid)).or_insert_with(|| {
            apps.push(RawApp {
                name,
                pid,
                user: Some(user),
                totals: None,
                conns: Vec::new(),
            });
            apps.len() - 1
        });
        apps[i].conns.push(conn);
    }
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured in an Ubuntu 24.04 container (loopback only).
    const TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:DBA3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 27895642 1 00000000c311058f 100 0 0 10 0
   1: 0100007F:DBA3 0100007F:B590 01 00000000:00000000 00:00000000 00000000     0        0 27895644 2 0000000021ae35a5 20 4 31 10 -1
   2: 0100007F:B590 0100007F:DBA3 01 00000000:0000004D 00:00000000 00000000     0        0 27895643 2 000000009b473775 20 4 30 10 -1
   3: 010200C0:C350 076433C6:01BB 06 00000000:00000000 00:00000000 00000000  1001        0 0 2 0000000000000000 20 4 30 10 -1
";
    const TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:9565 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 27895645 1 00000000bd3cffa7 100 0 0 10 0
   1: 00000000000000000000000001000000:9565 00000000000000000000000001000000:DA7A 01 00000000:00000002 00:00000000 00000000     0        0 27895647 1 000000005e963425 20 4 30 10 -1
   2: B80D0120000000000000000001000000:DA7A 00000000000000000000000001000000:9565 01 00000000:00000000 00:00000000 00000000     0        0 27895646 2 0000000007d9a3d2 20 0 0 10 -1
";
    const SS: &str = "ESTAB 0      0      127.0.0.1:56227 127.0.0.1:46480
\t cubic wscale:7,7 rto:201 bytes_sent:77 bytes_acked:77 bytes_received:500 segs_out:2
ESTAB 77     0      127.0.0.1:46480 127.0.0.1:56227
\t cubic wscale:7,7 rto:201 bytes_sent:500 bytes_acked:501 bytes_received:77 segs_out:4
ESTAB 2      0          [::1]:38245     [::1]:55930
\t cubic wscale:7,7 rto:201 bytes_received:2 segs_out:1
ESTAB 0      0     [fe80::1%eth0]:22     [fe80::2%eth0]:5000
\t cubic bytes_acked:9
";

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn ipv4_is_host_order_and_port_is_big_endian() {
        let rows = parse_proc_net(TCP, MachineProto::Tcp4);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].local, sa("127.0.0.1:56227"));
        assert_eq!(rows[0].remote, sa("0.0.0.0:0"));
        assert_eq!(rows[0].state, 0x0A);
        assert_eq!(rows[1].remote, sa("127.0.0.1:46480"));
        assert_eq!(rows[1].inode, 27895644);
        // 010200C0 = 192.0.2.1 ; 076433C6 = 198.51.100.7 ; 01BB = 443
        assert_eq!(rows[3].local, sa("192.0.2.1:50000"));
        assert_eq!(rows[3].remote, sa("198.51.100.7:443"));
        assert_eq!((rows[3].uid, rows[3].inode), (1001, 0));
    }

    #[test]
    fn ipv6_is_four_host_order_words() {
        let rows = parse_proc_net(TCP6, MachineProto::Tcp6);
        assert_eq!(rows[0].local, sa("[::1]:38245"));
        assert_eq!(rows[1].remote, sa("[::1]:55930"));
        assert_eq!(rows[2].local, sa("[2001:db8::1]:55930"));
    }

    #[test]
    fn malformed_rows_are_skipped() {
        assert!(parse_proc_net("header\n 0: zz:zz 00:00\n", MachineProto::Tcp4).is_empty());
        assert_eq!(parse_hex_endpoint("0100007F", false), None);
        assert_eq!(parse_hex_endpoint("0100:0035", false), None);
        assert_eq!(parse_hex_endpoint("01000000:0035", true), None);
    }

    #[test]
    fn state_names() {
        assert_eq!(tcp_state_name(0x01), "Established");
        assert_eq!(tcp_state_name(0x0A), "Listen");
        assert_eq!(tcp_state_name(0x06), "TimeWait");
        assert_eq!(tcp_state_name(0xEE), "Unknown");
    }

    #[test]
    fn ss_bytes_by_socket_pair() {
        let m = parse_ss(SS);
        assert_eq!(
            m[&(sa("127.0.0.1:56227"), sa("127.0.0.1:46480"))],
            (500, 77)
        );
        assert_eq!(
            m[&(sa("127.0.0.1:46480"), sa("127.0.0.1:56227"))],
            (77, 501)
        );
        // bytes_acked absent → 0
        assert_eq!(m[&(sa("[::1]:38245"), sa("[::1]:55930"))], (2, 0));
        // the scope id is dropped so the key matches /proc's scopeless address
        assert_eq!(m[&(sa("[fe80::1]:22"), sa("[fe80::2]:5000"))], (0, 9));
        assert_eq!(m.len(), 4);
    }

    #[test]
    fn assemble_attributes_owned_sockets_and_labels_the_rest() {
        let mut sockets = parse_proc_net(TCP, MachineProto::Tcp4);
        sockets.extend(parse_proc_net(TCP6, MachineProto::Tcp6));
        let owners: HashMap<u64, (u32, String)> = [
            (27895642, (42, "server".to_string())),
            (27895644, (42, "server".to_string())),
            (27895643, (43, "client".to_string())),
        ]
        .into();
        let ss = parse_ss(SS);
        let apps = assemble(&sockets, &owners, 0, Some(&ss));
        let find = |n: &str| apps.iter().find(|a| a.name == n).unwrap();

        let server = find("server");
        assert_eq!((server.pid, server.user), (42, Some(MachineUser::SelfUser)));
        assert_eq!(server.conns.len(), 2);
        assert_eq!(server.conns[0].local, "127.0.0.1:56227");
        assert_eq!(server.conns[0].remote, None, "a listener has no remote");
        assert_eq!(server.conns[0].state, "Listen");
        assert_eq!(server.conns[0].bytes_in, Some(0));
        assert_eq!(server.conns[1].bytes_in, Some(500));
        assert_eq!(server.conns[1].bytes_out, Some(77));

        // uid 1001 ≠ ours (0) and inode 0 → another user's socket, no pid.
        let other = find(OTHER_USER);
        assert_eq!((other.pid, other.user), (0, Some(MachineUser::Other)));
        assert_eq!(
            other.conns[0].remote_ip,
            Some("198.51.100.7".parse().unwrap())
        );
        assert_eq!(other.conns[0].state, "TimeWait");

        // Our uid (0) but no fd found → ours, unattributed.
        let orphan = find(NO_PROCESS);
        assert_eq!((orphan.pid, orphan.user), (0, Some(MachineUser::SelfUser)));
        assert_eq!(orphan.conns.len(), 3);
    }

    #[test]
    fn without_ss_bytes_are_null_and_udp_never_has_bytes() {
        let udp = "   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
16158: 0100007F:AFB7 0100007F:0009 01 00000000:00000000 00:00000000 00000000     0        0 27895648 2 000000004253d447 0
";
        let mut sockets = parse_proc_net(TCP, MachineProto::Tcp4);
        sockets.extend(parse_proc_net(udp, MachineProto::Udp4));
        let apps = assemble(&sockets, &HashMap::new(), 0, None);
        assert!(apps
            .iter()
            .flat_map(|a| &a.conns)
            .all(|c| c.bytes_in.is_none() && c.bytes_out.is_none()));
        let ss = parse_ss(SS);
        let apps = assemble(&sockets, &HashMap::new(), 0, Some(&ss));
        let udp_conn = apps
            .iter()
            .flat_map(|a| &a.conns)
            .find(|c| c.proto == MachineProto::Udp4)
            .unwrap();
        assert_eq!((udp_conn.bytes_in, udp_conn.state.as_str()), (None, ""));
        assert_eq!(udp_conn.remote.as_deref(), Some("127.0.0.1:9"));
    }

    #[test]
    fn display_uses_star_for_unspecified() {
        assert_eq!(display_addr(&sa("0.0.0.0:22")), "*:22");
        assert_eq!(display_addr(&sa("[::]:22")), "*:22");
        assert_eq!(display_addr(&sa("[::1]:22")), "[::1]:22");
    }
}
