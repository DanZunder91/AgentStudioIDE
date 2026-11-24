//! Raw backend samples → the wire `MachineSample`: per-connection and per-app rates from the
//! delta between consecutive samples. Pure and platform-neutral.

use super::{MachineApp, MachineConn, MachineProto, MachineSample, RawApp};
use std::collections::HashMap;
use std::net::IpAddr;

/// A connection's identity across samples: its 5-tuple (protocol + both endpoints), plus the pid
/// so two processes' identical wildcard UDP sockets never read each other's counters.
type ConnKey = (u32, MachineProto, String, Option<String>);

#[derive(Default)]
pub struct RateTracker {
    prev_ts: Option<u64>,
    conns: HashMap<ConnKey, (Option<u64>, Option<u64>)>,
    apps: HashMap<String, (u64, u64)>,
}

/// bytes/s between two cumulative counters. `None` when either side is unknown, the interval is
/// not positive, or the counter went BACKWARDS (a socket reused/reset) — a negative rate is a lie.
pub fn rate(prev: Option<u64>, cur: Option<u64>, dt_s: f64) -> Option<f64> {
    let (p, c) = (prev?, cur?);
    if c < p || dt_s <= 0.0 {
        return None;
    }
    Some((c - p) as f64 / dt_s)
}

fn sum(values: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    values.flatten().reduce(|a, b| a + b)
}

fn sum_f(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    values.flatten().reduce(|a, b| a + b)
}

impl RateTracker {
    /// `interval_ms` is the backend's own sampling interval when it has one (nettop: 1000 — its
    /// samples arrive in bursts on a buffered pipe, so arrival time is a bad clock); otherwise the
    /// measured gap between `ts_ms` values is used.
    pub fn apply(
        &mut self,
        raw: Vec<RawApp>,
        ts_ms: u64,
        interval_ms: Option<u64>,
        host_of: &mut dyn FnMut(IpAddr) -> Option<String>,
    ) -> MachineSample {
        let dt_s = match (interval_ms, self.prev_ts) {
            (Some(i), Some(_)) => i as f64 / 1000.0,
            (None, Some(p)) => ts_ms.saturating_sub(p) as f64 / 1000.0,
            (_, None) => 0.0,
        };
        let mut key_count: HashMap<ConnKey, usize> = HashMap::new();
        for a in &raw {
            for c in &a.conns {
                *key_count
                    .entry((a.pid, c.proto, c.local.clone(), c.remote.clone()))
                    .or_default() += 1;
            }
        }
        let mut next_conns = HashMap::new();
        let mut next_apps = HashMap::new();
        let mut apps: Vec<MachineApp> = raw
            .into_iter()
            .map(|a| {
                let key = format!("{}:{}", a.name, a.pid);
                let connections: Vec<MachineConn> = a
                    .conns
                    .into_iter()
                    .map(|c| {
                        let k: ConnKey = (a.pid, c.proto, c.local.clone(), c.remote.clone());
                        // A key that appears twice in one sample can't be matched to its
                        // predecessor — report no rate rather than a wrong one.
                        let unique = key_count.get(&k) == Some(&1);
                        let prev = if unique { self.conns.get(&k) } else { None };
                        let (rate_in, rate_out) = match prev {
                            Some((pi, po)) => {
                                (rate(*pi, c.bytes_in, dt_s), rate(*po, c.bytes_out, dt_s))
                            }
                            None => (None, None),
                        };
                        if unique {
                            next_conns.insert(k, (c.bytes_in, c.bytes_out));
                        }
                        MachineConn {
                            proto: c.proto,
                            local: c.local,
                            remote: c.remote,
                            remote_host: c.remote_ip.and_then(&mut *host_of),
                            state: c.state,
                            bytes_in: c.bytes_in,
                            bytes_out: c.bytes_out,
                            rate_in,
                            rate_out,
                        }
                    })
                    .collect();
                // Process-lifetime totals (nettop) include sockets that already closed, so the
                // app rate is their delta; without them it is the sum of the live sockets' rates.
                let (bytes_in, bytes_out, rate_in, rate_out) = match a.totals {
                    Some((ti, to)) => {
                        let prev = self.apps.get(&key);
                        next_apps.insert(key.clone(), (ti, to));
                        (
                            Some(ti),
                            Some(to),
                            prev.and_then(|p| rate(Some(p.0), Some(ti), dt_s)),
                            prev.and_then(|p| rate(Some(p.1), Some(to), dt_s)),
                        )
                    }
                    None => (
                        sum(connections.iter().map(|c| c.bytes_in)),
                        sum(connections.iter().map(|c| c.bytes_out)),
                        sum_f(connections.iter().map(|c| c.rate_in)),
                        sum_f(connections.iter().map(|c| c.rate_out)),
                    ),
                };
                MachineApp {
                    key,
                    name: a.name,
                    pid: a.pid,
                    user: a.user,
                    bytes_in,
                    bytes_out,
                    rate_in,
                    rate_out,
                    connections,
                }
            })
            .collect();
        apps.sort_by(|a, b| a.name.cmp(&b.name).then(a.pid.cmp(&b.pid)));
        self.conns = next_conns;
        self.apps = next_apps;
        self.prev_ts = Some(ts_ms);
        MachineSample { ts_ms, apps }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netmachine::{MachineUser, RawConn};

    fn conn(local: &str, remote: Option<&str>, bin: Option<u64>, bout: Option<u64>) -> RawConn {
        RawConn {
            proto: MachineProto::Tcp4,
            local: local.into(),
            remote: remote.map(Into::into),
            remote_ip: remote.map(|r| r.rsplit_once(':').unwrap().0.parse().unwrap()),
            state: "Established".into(),
            bytes_in: bin,
            bytes_out: bout,
        }
    }

    fn app(name: &str, pid: u32, totals: Option<(u64, u64)>, conns: Vec<RawConn>) -> RawApp {
        RawApp {
            name: name.into(),
            pid,
            user: Some(MachineUser::SelfUser),
            totals,
            conns,
        }
    }

    #[test]
    fn rate_table() {
        assert_eq!(rate(Some(100), Some(300), 2.0), Some(100.0));
        assert_eq!(
            rate(Some(300), Some(100), 1.0),
            None,
            "counter went backwards"
        );
        assert_eq!(rate(None, Some(1), 1.0), None);
        assert_eq!(rate(Some(1), None, 1.0), None);
        assert_eq!(rate(Some(1), Some(5), 0.0), None);
    }

    #[test]
    fn rates_come_from_the_delta_between_samples() {
        let mut t = RateTracker::default();
        let mut none = |_: IpAddr| None;
        let s1 = t.apply(
            vec![app(
                "a",
                1,
                Some((1000, 50)),
                vec![conn(
                    "192.0.2.1:5",
                    Some("198.51.100.1:443"),
                    Some(900),
                    Some(40),
                )],
            )],
            10_000,
            None,
            &mut none,
        );
        assert_eq!(s1.apps[0].rate_in, None, "first sample has no rate");
        assert_eq!(s1.apps[0].connections[0].rate_in, None);
        let s2 = t.apply(
            vec![app(
                "a",
                1,
                Some((3000, 150)),
                vec![conn(
                    "192.0.2.1:5",
                    Some("198.51.100.1:443"),
                    Some(1900),
                    Some(60),
                )],
            )],
            12_000,
            None,
            &mut none,
        );
        let a = &s2.apps[0];
        assert_eq!(a.key, "a:1");
        assert_eq!((a.bytes_in, a.bytes_out), (Some(3000), Some(150)));
        // measured dt = 2 s
        assert_eq!((a.rate_in, a.rate_out), (Some(1000.0), Some(50.0)));
        assert_eq!(a.connections[0].rate_in, Some(500.0));
        assert_eq!(a.connections[0].rate_out, Some(10.0));
        // a backend interval overrides the measured gap
        let s3 = t.apply(
            vec![app("a", 1, Some((4000, 150)), vec![])],
            12_010,
            Some(1000),
            &mut none,
        );
        assert_eq!(s3.apps[0].rate_in, Some(1000.0));
    }

    #[test]
    fn without_totals_the_app_sums_its_connections() {
        let mut t = RateTracker::default();
        let mut none = |_: IpAddr| None;
        let mk = |a: u64, b: u64| {
            vec![app(
                "x",
                7,
                None,
                vec![
                    conn("192.0.2.1:1", Some("198.51.100.1:443"), Some(a), Some(0)),
                    conn("192.0.2.1:2", Some("198.51.100.1:443"), Some(b), None),
                ],
            )]
        };
        t.apply(mk(10, 20), 0, None, &mut none);
        let s = t.apply(mk(30, 60), 1000, None, &mut none);
        assert_eq!(s.apps[0].bytes_in, Some(90));
        assert_eq!(
            s.apps[0].bytes_out,
            Some(0),
            "one known + one unknown sums the known"
        );
        assert_eq!(s.apps[0].rate_in, Some(60.0));
        let s = t.apply(
            vec![app("x", 7, None, vec![conn("*:1", None, None, None)])],
            2000,
            None,
            &mut none,
        );
        assert_eq!(
            (s.apps[0].bytes_in, s.apps[0].rate_in),
            (None, None),
            "all unknown stays null"
        );
    }

    #[test]
    fn duplicate_tuples_get_no_rate_and_pids_do_not_collide() {
        let mut t = RateTracker::default();
        let mut none = |_: IpAddr| None;
        let dup = || {
            vec![
                app(
                    "m",
                    1,
                    None,
                    vec![
                        conn("*:5353", None, Some(1), Some(1)),
                        conn("*:5353", None, Some(9), Some(9)),
                    ],
                ),
                app("n", 2, None, vec![conn("*:5353", None, Some(100), Some(0))]),
            ]
        };
        t.apply(dup(), 0, None, &mut none);
        let mut next = dup();
        next[1].conns[0].bytes_in = Some(150);
        let s = t.apply(next, 1000, None, &mut none);
        assert!(s.apps[0].connections.iter().all(|c| c.rate_in.is_none()));
        assert_eq!(s.apps[1].connections[0].rate_in, Some(50.0));
    }

    #[test]
    fn remote_host_is_asked_only_for_remote_ips() {
        let mut t = RateTracker::default();
        let mut asked = Vec::new();
        let mut host = |ip: IpAddr| {
            asked.push(ip);
            Some("example.net".to_string())
        };
        let s = t.apply(
            vec![app(
                "a",
                1,
                None,
                vec![
                    conn("192.0.2.1:5", Some("198.51.100.1:443"), None, None),
                    conn("*:80", None, None, None),
                ],
            )],
            0,
            None,
            &mut host,
        );
        assert_eq!(asked, vec!["198.51.100.1".parse::<IpAddr>().unwrap()]);
        assert_eq!(
            s.apps[0].connections[0].remote_host.as_deref(),
            Some("example.net")
        );
        assert_eq!(s.apps[0].connections[1].remote_host, None);
    }
}
