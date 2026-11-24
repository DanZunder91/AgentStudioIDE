//! Reverse DNS for `MachineConn.remoteHost`: asynchronous, cached, bounded — it never blocks the
//! sampler. A sample asks [`Rdns::host_of`], which answers from the cache immediately and, on a
//! miss, schedules a lookup whose answer appears in a LATER sample.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Both positive and negative answers are kept this long.
pub const TTL: Duration = Duration::from_secs(600);
/// At most this many lookups are queued or running at once; further misses wait for a later
/// sample. `getnameinfo` on an address with no PTR can take seconds, so this bound is what stops
/// a machine with hundreds of peers from piling up hundreds of blocking threads.
pub const MAX_INFLIGHT: usize = 32;
/// Lookups actually running on blocking threads at once.
pub const CONCURRENCY: usize = 4;
const MAX_ENTRIES: usize = 4096;

/// Addresses that never have a public PTR worth asking about: loopback, RFC 1918, CGNAT
/// (100.64/10 — Tailscale lives here), link-local, ULA, multicast, unspecified, broadcast,
/// documentation. Asking would leak the query to the resolver for nothing.
pub fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || (o[0] == 100 && (o[1] & 0xC0) == 64)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(&IpAddr::V4(v4));
            }
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] == 0x2001 && s[1] == 0x0db8)
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Lookup {
    /// Answered from the cache (`None` = cached negative).
    Cached(Option<String>),
    /// The caller must resolve it and call [`RdnsCache::complete`].
    Resolve,
    /// Already being resolved, or the in-flight budget is spent — try again next sample.
    Pending,
    /// Never looked up (private range).
    Skip,
}

/// The pure half: what to do for an address at an instant. Time is a parameter so TTL expiry is
/// tested without sleeping.
#[derive(Default)]
pub struct RdnsCache {
    entries: HashMap<IpAddr, (Option<String>, Instant)>,
    inflight: HashSet<IpAddr>,
}

impl RdnsCache {
    pub fn lookup(&mut self, ip: IpAddr, now: Instant) -> Lookup {
        if is_private(&ip) {
            return Lookup::Skip;
        }
        if let Some((host, at)) = self.entries.get(&ip) {
            if now.saturating_duration_since(*at) < TTL {
                return Lookup::Cached(host.clone());
            }
        }
        if self.inflight.contains(&ip) || self.inflight.len() >= MAX_INFLIGHT {
            return Lookup::Pending;
        }
        self.inflight.insert(ip);
        Lookup::Resolve
    }

    pub fn complete(&mut self, ip: IpAddr, host: Option<String>, now: Instant) {
        self.inflight.remove(&ip);
        if self.entries.len() >= MAX_ENTRIES {
            self.entries
                .retain(|_, (_, at)| now.saturating_duration_since(*at) < TTL);
            if self.entries.len() >= MAX_ENTRIES {
                self.entries.clear();
            }
        }
        self.entries.insert(ip, (host, now));
    }
}

pub type Resolver = Arc<dyn Fn(IpAddr) -> Option<String> + Send + Sync>;

/// The async half: schedules [`Resolver`] calls on tokio's blocking pool.
pub struct Rdns {
    cache: Arc<Mutex<RdnsCache>>,
    permits: Arc<tokio::sync::Semaphore>,
    resolver: Resolver,
}

impl Rdns {
    pub fn new(resolver: Resolver) -> Rdns {
        Rdns {
            cache: Arc::default(),
            permits: Arc::new(tokio::sync::Semaphore::new(CONCURRENCY)),
            resolver,
        }
    }

    /// Must be called inside a tokio runtime (the sampler task). Never waits.
    pub fn host_of(&self, ip: IpAddr) -> Option<String> {
        let decision = self
            .cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .lookup(ip, Instant::now());
        match decision {
            Lookup::Cached(h) => h,
            Lookup::Pending | Lookup::Skip => None,
            Lookup::Resolve => {
                let (cache, permits, resolver) = (
                    self.cache.clone(),
                    self.permits.clone(),
                    self.resolver.clone(),
                );
                tokio::spawn(async move {
                    let host = match permits.acquire_owned().await {
                        Ok(_permit) => tokio::task::spawn_blocking(move || resolver(ip))
                            .await
                            .ok()
                            .flatten(),
                        Err(_) => None,
                    };
                    cache.lock().unwrap_or_else(|e| e.into_inner()).complete(
                        ip,
                        host,
                        Instant::now(),
                    );
                });
                None
            }
        }
    }
}

/// The OS resolver: `getnameinfo(NI_NAMEREQD)` (a PTR lookup; blocking — run it off the sampler).
#[cfg(unix)]
pub fn system_resolver(ip: IpAddr) -> Option<String> {
    use std::ffi::CStr;
    // SAFETY: zeroed sockaddr_* are valid initial values; we fill family/port/address and pass
    // the exact struct size. `host` is a NUL-terminated buffer owned for the call's duration.
    unsafe {
        let mut storage: libc::sockaddr_storage = std::mem::zeroed();
        let len = match ip {
            IpAddr::V4(v4) => {
                let sa = &mut *(&mut storage as *mut _ as *mut libc::sockaddr_in);
                sa.sin_family = libc::AF_INET as libc::sa_family_t;
                sa.sin_addr = libc::in_addr {
                    s_addr: u32::from_ne_bytes(v4.octets()),
                };
                #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
                {
                    sa.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
                }
                std::mem::size_of::<libc::sockaddr_in>()
            }
            IpAddr::V6(v6) => {
                let sa = &mut *(&mut storage as *mut _ as *mut libc::sockaddr_in6);
                sa.sin6_family = libc::AF_INET6 as libc::sa_family_t;
                sa.sin6_addr = libc::in6_addr {
                    s6_addr: v6.octets(),
                };
                #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
                {
                    sa.sin6_len = std::mem::size_of::<libc::sockaddr_in6>() as u8;
                }
                std::mem::size_of::<libc::sockaddr_in6>()
            }
        };
        let mut host = [0 as libc::c_char; 1025];
        let rc = libc::getnameinfo(
            &storage as *const _ as *const libc::sockaddr,
            len as libc::socklen_t,
            host.as_mut_ptr(),
            host.len() as libc::socklen_t,
            std::ptr::null_mut(),
            0,
            libc::NI_NAMEREQD,
        );
        if rc != 0 {
            return None;
        }
        let name = CStr::from_ptr(host.as_ptr())
            .to_string_lossy()
            .trim_end_matches('.')
            .to_string();
        // A PTR that is just the address again is no answer.
        (!name.is_empty() && name.parse::<IpAddr>().is_err()).then_some(name)
    }
}

/// Windows: the same `getnameinfo(NI_NAMEREQD)`, through Winsock.
#[cfg(windows)]
pub fn system_resolver(ip: IpAddr) -> Option<String> {
    super::windows::reverse_dns(ip)
}

#[cfg(not(any(unix, windows)))]
pub fn system_resolver(_ip: IpAddr) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn private_table() {
        for p in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "224.0.0.251",
            "255.255.255.255",
            "192.0.2.1",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "ff02::fb",
            "::ffff:10.0.0.1",
            "2001:db8::1",
        ] {
            assert!(is_private(&ip(p)), "{p} should be private");
        }
        for p in [
            "8.8.8.8",
            "17.57.145.136",
            "100.63.0.1",
            "100.128.0.1",
            "172.32.0.1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_private(&ip(p)), "{p} should be public");
        }
    }

    #[test]
    fn cache_positive_negative_ttl_and_inflight() {
        let mut c = RdnsCache::default();
        let t0 = Instant::now();
        let a = ip("8.8.8.8");
        assert_eq!(c.lookup(ip("10.0.0.1"), t0), Lookup::Skip);
        assert_eq!(c.lookup(a, t0), Lookup::Resolve);
        assert_eq!(
            c.lookup(a, t0),
            Lookup::Pending,
            "no second lookup while one is in flight"
        );
        c.complete(a, Some("dns.google".into()), t0);
        assert_eq!(
            c.lookup(a, t0 + Duration::from_secs(599)),
            Lookup::Cached(Some("dns.google".into()))
        );
        assert_eq!(c.lookup(a, t0 + TTL), Lookup::Resolve, "expired");
        let b = ip("1.1.1.1");
        assert_eq!(c.lookup(b, t0), Lookup::Resolve);
        c.complete(b, None, t0);
        assert_eq!(
            c.lookup(b, t0),
            Lookup::Cached(None),
            "negative answers are cached too"
        );
    }

    #[test]
    fn inflight_budget_is_bounded() {
        let mut c = RdnsCache::default();
        let t0 = Instant::now();
        for i in 0..MAX_INFLIGHT {
            assert_eq!(
                c.lookup(ip(&format!("8.8.{}.{}", i / 250, i % 250 + 1)), t0),
                Lookup::Resolve
            );
        }
        assert_eq!(c.lookup(ip("9.9.9.9"), t0), Lookup::Pending);
    }

    #[tokio::test]
    async fn host_of_never_waits_and_fills_the_cache_later() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let rdns = Rdns::new(Arc::new(move |ip: IpAddr| {
            counted.fetch_add(1, Ordering::SeqCst);
            (ip == "8.8.8.8".parse::<IpAddr>().unwrap()).then(|| "dns.google".to_string())
        }));
        assert_eq!(
            rdns.host_of(ip("8.8.8.8")),
            None,
            "a miss answers None at once"
        );
        assert_eq!(rdns.host_of(ip("192.168.0.1")), None);
        for _ in 0..200 {
            if rdns.host_of(ip("8.8.8.8")).is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(rdns.host_of(ip("8.8.8.8")).as_deref(), Some("dns.google"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "resolved once, private never asked"
        );
    }
}
