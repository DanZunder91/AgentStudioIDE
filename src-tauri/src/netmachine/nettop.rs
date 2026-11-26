//! Pure parser for macOS `nettop -L … -J bytes_in,bytes_out,state` CSV. Columns are found by
//! header name (`-m udp` has no `state`), the pid follows the LAST dot of `name.pid`, and an
//! empty byte counter means 0. The header repeats before every sample in streaming mode.

use super::{MachineProto, RawApp, RawConn};
use std::net::IpAddr;

/// Cuts a `-L 0` stream into samples, complete only when the NEXT header arrives: piped stdout
/// is block-buffered and flushes mid-sample, so a quiet-gap heuristic would split samples.
#[derive(Default)]
pub struct NettopSplitter {
    current: Vec<String>,
}

impl NettopSplitter {
    /// Feed one line (without its newline). Returns a finished sample's text when `line` starts
    /// the next one.
    pub fn push(&mut self, line: &str) -> Option<String> {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            return None;
        }
        let mut done = None;
        if is_header(line) && self.current.len() > 1 {
            done = Some(std::mem::take(&mut self.current).join("\n"));
        }
        // Lines before the first header (should never happen) have no column map — skip them.
        if is_header(line) || !self.current.is_empty() {
            self.current.push(line.to_string());
        }
        done
    }
}

fn is_header(line: &str) -> bool {
    line.starts_with(',')
}

struct Columns {
    state: Option<usize>,
    bytes_in: Option<usize>,
    bytes_out: Option<usize>,
}

impl Columns {
    fn from_header(line: &str) -> Columns {
        let names: Vec<&str> = line.split(',').collect();
        let at = |n: &str| names.iter().position(|c| *c == n);
        Columns {
            state: at("state"),
            bytes_in: at("bytes_in"),
            bytes_out: at("bytes_out"),
        }
    }
}

/// Parse ONE sample (a header line followed by process and socket rows).
pub fn parse_sample(text: &str) -> Vec<RawApp> {
    let mut cols = Columns {
        state: None,
        bytes_in: None,
        bytes_out: None,
    };
    let mut apps: Vec<RawApp> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if is_header(line) {
            cols = Columns::from_header(line);
            continue;
        }
        // The first field is the only one that can contain spaces; it never contains a comma
        // (nettop has no quoting), so a plain split is exact.
        let fields: Vec<&str> = line.split(',').collect();
        let get = |i: Option<usize>| i.and_then(|i| fields.get(i)).copied().unwrap_or("");
        let counter = |i: Option<usize>| -> u64 { get(i).trim().parse().unwrap_or(0) };
        let first = fields[0];
        if let Some(conn) = parse_socket(first) {
            let Some(app) = apps.last_mut() else { continue };
            let Some(mut conn) = conn else { continue };
            if matches!(conn.proto, MachineProto::Tcp4 | MachineProto::Tcp6) {
                conn.state = get(cols.state).to_string();
            }
            conn.bytes_in = Some(counter(cols.bytes_in));
            conn.bytes_out = Some(counter(cols.bytes_out));
            app.conns.push(conn);
        } else if let Some((name, pid)) = split_name_pid(first) {
            apps.push(RawApp {
                name: name.to_string(),
                pid,
                user: None,
                totals: Some((counter(cols.bytes_in), counter(cols.bytes_out))),
                conns: Vec::new(),
            });
        }
    }
    apps
}

/// `Example Brows.900` → (`Example Brows`, 900). The pid follows the LAST dot.
pub fn split_name_pid(s: &str) -> Option<(&str, u32)> {
    let (name, pid) = s.rsplit_once('.')?;
    let pid = pid.parse().ok()?;
    (!name.is_empty()).then_some((name, pid))
}

/// `Some(None)` = a socket row that carries nothing worth showing (an unbound UDP socket);
/// `None` = not a socket row at all (a process row).
fn parse_socket(first: &str) -> Option<Option<RawConn>> {
    let (proto_s, rest) = first.split_once(' ')?;
    let proto = match proto_s {
        "tcp4" => MachineProto::Tcp4,
        "tcp6" => MachineProto::Tcp6,
        // QUIC rides on UDP; the contract's protocol set is the transport's.
        "udp4" | "quic4" => MachineProto::Udp4,
        "udp6" | "quic6" => MachineProto::Udp6,
        _ => return None,
    };
    let v6 = matches!(proto, MachineProto::Tcp6 | MachineProto::Udp6);
    let (local, remote) = rest.split_once("<->")?;
    let local = parse_endpoint(local, v6)?;
    let remote = parse_endpoint(remote, v6)?;
    if local.is_wildcard() && remote.is_wildcard() {
        return Some(None);
    }
    Some(Some(RawConn {
        proto,
        local: local.display(v6),
        remote: (!remote.is_wildcard()).then(|| remote.display(v6)),
        remote_ip: remote.ip,
        state: String::new(),
        bytes_in: None,
        bytes_out: None,
    }))
}

#[derive(Debug, PartialEq)]
pub struct Endpoint {
    /// `None` = wildcard (`*`). Kept as text so an IPv6 scope (`%en0`) survives.
    pub host: Option<String>,
    pub ip: Option<IpAddr>,
    pub port: Option<u16>,
}

impl Endpoint {
    fn is_wildcard(&self) -> bool {
        self.host.is_none() && self.port.is_none()
    }

    /// `10.0.0.5:443`, `[::1]:8000`, `[fe80::1%en0]:5000`, `*:5353`, `*:*`.
    pub fn display(&self, v6: bool) -> String {
        let host = match &self.host {
            None => "*".to_string(),
            Some(h) if v6 => format!("[{h}]"),
            Some(h) => h.clone(),
        };
        match self.port {
            Some(p) => format!("{host}:{p}"),
            None => format!("{host}:*"),
        }
    }
}

/// nettop endpoints: IPv4 `a.b.c.d:port`, IPv6 `addr.port` (the port after the LAST dot —
/// an IPv6 address has colons, so a colon split would cut the address itself).
pub fn parse_endpoint(s: &str, v6: bool) -> Option<Endpoint> {
    let (host, port) = if v6 {
        s.rsplit_once('.')?
    } else {
        s.rsplit_once(':')?
    };
    let port = match port {
        "*" => None,
        p => Some(p.parse().ok()?),
    };
    let ip: Option<IpAddr> = host.split('%').next().and_then(|h| h.parse().ok());
    let wildcard = host == "*" || ip.is_some_and(|ip| ip.is_unspecified());
    Some(Endpoint {
        host: (!wildcard).then(|| host.to_string()),
        ip: if wildcard { None } else { ip },
        port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: &str = "\
,state,bytes_in,bytes_out,
launchd.1,,0,0,
tcp6 ::1.8000<->*.*,Listen,,,
tcp4 127.0.0.1:8000<->*:*,Listen,,,
Browser Helper.900,,205010,110020,
tcp4 192.0.2.1:50000<->198.51.100.7:443,Established,200000,100000,
quic4 192.0.2.1:50001<->198.51.100.8:443,,5000,10000,
udp4 *:*<->*:*,,,,
tcp6 fe80::1%en0.50002<->2001:db8::2.443,Established,10,20,
";

    #[test]
    fn parses_process_rows_and_their_sockets() {
        let apps = parse_sample(ONE);
        assert_eq!(apps.len(), 2);
        assert_eq!((apps[0].name.as_str(), apps[0].pid), ("launchd", 1));
        assert_eq!(apps[0].conns.len(), 2);
        assert_eq!(apps[0].conns[0].local, "[::1]:8000");
        assert_eq!(apps[0].conns[0].remote, None);
        assert_eq!(apps[0].conns[0].state, "Listen");
        assert_eq!(apps[0].conns[0].bytes_in, Some(0));

        let b = &apps[1];
        assert_eq!((b.name.as_str(), b.pid), ("Browser Helper", 900));
        assert_eq!(b.totals, Some((205010, 110020)));
        // The unbound `udp4 *:*<->*:*` row is dropped.
        assert_eq!(b.conns.len(), 3);
        let t = &b.conns[0];
        assert_eq!(t.proto, MachineProto::Tcp4);
        assert_eq!(t.local, "192.0.2.1:50000");
        assert_eq!(t.remote.as_deref(), Some("198.51.100.7:443"));
        assert_eq!(t.remote_ip, Some("198.51.100.7".parse().unwrap()));
        assert_eq!((t.bytes_in, t.bytes_out), (Some(200000), Some(100000)));
        let q = &b.conns[1];
        assert_eq!(q.proto, MachineProto::Udp4);
        assert_eq!(q.state, "");
        let v6 = &b.conns[2];
        assert_eq!(v6.local, "[fe80::1%en0]:50002");
        assert_eq!(v6.remote.as_deref(), Some("[2001:db8::2]:443"));
        assert_eq!(v6.remote_ip, Some("2001:db8::2".parse().unwrap()));
    }

    #[test]
    fn columns_are_found_by_name_not_position() {
        // `-m udp` drops the state column entirely.
        let udp = ",bytes_in,bytes_out,\nexampled.400,0,4000,\nudp4 *:50003<->*:*,5,4000,\n";
        let apps = parse_sample(udp);
        assert_eq!(apps[0].totals, Some((0, 4000)));
        assert_eq!(apps[0].conns[0].bytes_in, Some(5));
        assert_eq!(apps[0].conns[0].local, "*:50003");
    }

    #[test]
    fn endpoint_table() {
        let cases: &[(&str, bool, &str)] = &[
            ("10.0.0.5:50000", false, "10.0.0.5:50000"),
            ("*:5353", false, "*:5353"),
            ("0.0.0.0:22", false, "*:22"),
            ("::1.8000", true, "[::1]:8000"),
            ("*.50500", true, "*:50500"),
            ("2001:db8::1.443", true, "[2001:db8::1]:443"),
            ("fe80::9%en1.1024", true, "[fe80::9%en1]:1024"),
        ];
        for (input, v6, want) in cases {
            let e = parse_endpoint(input, *v6).unwrap_or_else(|| panic!("{input}"));
            assert_eq!(e.display(*v6), *want, "{input}");
        }
        assert_eq!(
            parse_endpoint("fe80::9%en1.1024", true).unwrap().port,
            Some(1024)
        );
        assert_eq!(parse_endpoint("nonsense", false), None);
    }

    #[test]
    fn name_pid_takes_the_last_dot() {
        assert_eq!(split_name_pid("com.apple.x.12"), Some(("com.apple.x", 12)));
        assert_eq!(
            split_name_pid("Example Brows.900"),
            Some(("Example Brows", 900))
        );
        assert_eq!(split_name_pid("noPid"), None);
        assert_eq!(split_name_pid(".5"), None);
    }

    #[test]
    fn splitter_emits_a_sample_when_the_next_header_arrives() {
        let mut s = NettopSplitter::default();
        let mut out = Vec::new();
        for l in ",state,bytes_in,bytes_out,\na.1,,1,1,\n,state,bytes_in,bytes_out,\nb.2,,2,2,\n,state,bytes_in,bytes_out,\n".lines() {
            if let Some(done) = s.push(l) {
                out.push(done);
            }
        }
        assert_eq!(out.len(), 2);
        assert_eq!(parse_sample(&out[0])[0].name, "a");
        assert_eq!(parse_sample(&out[1])[0].name, "b");
        // Two back-to-back headers (an empty sample) do not emit an empty sample.
        let mut s = NettopSplitter::default();
        assert_eq!(s.push(",bytes_in,"), None);
        assert_eq!(s.push(",bytes_in,"), None);
    }
}
