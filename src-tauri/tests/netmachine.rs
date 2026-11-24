//! Whole-computer network connections.
//!
//! * Hermetic on every OS: a two-sample nettop stream (nettop's exact CSV shape, invented values)
//!   through the splitter → parser → rate tracker, and the start/stop lifecycle against a fake source.
//! * Linux, NOT ignored (loopback only, so hermetic): the real `/proc` backend sees both ends of
//!   a connection this test process opens, attributed to our own pid.
//! * macOS, `#[ignore]`d local integration (`npm run verify`):
//!   `macos_real_nettop_sampler_emits_apps_with_bytes`.

use agent_studio_scaffold_lib::netmachine::{
    nettop, rates::RateTracker, MachineProto, MachineSample, NetMachine, Platform, RawApp, RawConn,
    RawSample, SampleSink, Source, SourceFactory,
};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Recorder(Mutex<Vec<MachineSample>>);

impl SampleSink for Recorder {
    fn emit(&self, s: &MachineSample) {
        self.0.lock().unwrap().push(s.clone());
    }
}

impl Recorder {
    fn samples(&self) -> Vec<MachineSample> {
        self.0.lock().unwrap().clone()
    }
}

fn no_dns() -> agent_studio_scaffold_lib::netmachine::rdns::Resolver {
    Arc::new(|_: IpAddr| None)
}

#[test]
fn a_nettop_stream_splits_parses_and_rates() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/netmachine/nettop_stream2.csv"
    ))
    .unwrap();
    let mut splitter = nettop::NettopSplitter::default();
    let mut samples: Vec<String> = text.lines().filter_map(|l| splitter.push(l)).collect();
    // The last sample of a capture is only complete when the next header would arrive; feed one.
    samples.extend(splitter.push(",state,bytes_in,bytes_out,"));
    assert_eq!(samples.len(), 2);

    let mut tracker = RateTracker::default();
    let mut none = |_: IpAddr| None;
    let s1 = tracker.apply(nettop::parse_sample(&samples[0]), 0, Some(1000), &mut none);
    let s2 = tracker.apply(
        nettop::parse_sample(&samples[1]),
        1000,
        Some(1000),
        &mut none,
    );
    assert_eq!(s1.apps.len(), s2.apps.len());
    assert!(s1.apps.len() >= 15, "{}", s1.apps.len());

    let pushd = s2.apps.iter().find(|a| a.name == "pushd").unwrap();
    assert_eq!(pushd.key, "pushd:180");
    assert_eq!(pushd.bytes_in, Some(70_003_000));
    assert_eq!(pushd.rate_in, Some((70_003_000 - 70_000_000) as f64));
    assert_eq!(pushd.rate_out, Some((21_400_800 - 21_400_000) as f64));

    let helper = s2.apps.iter().find(|a| a.name == "Browser Helper").unwrap();
    assert_eq!(helper.pid, 100);
    let v6 = s2
        .apps
        .iter()
        .flat_map(|a| &a.connections)
        .find(|c| c.local.starts_with("[fe80::1%en0]:50400"))
        .unwrap();
    assert_eq!(v6.proto, MachineProto::Tcp6);
    assert_eq!(v6.state, "Established");
    // Unbound `udp4 *:*<->*:*` rows never reach the wire.
    assert!(s2
        .apps
        .iter()
        .flat_map(|a| &a.connections)
        .all(|c| c.local != "*:*"));
    // An idle connection has a 0 rate, not a missing one.
    let idle = s2
        .apps
        .iter()
        .flat_map(|a| &a.connections)
        .find(|c| c.remote.as_deref() == Some("192.0.2.2:443"))
        .unwrap();
    assert_eq!(idle.rate_in, Some(0.0));
}

// ---- lifecycle against a fake source -------------------------------------------------------

struct FakeSource {
    left: usize,
    dropped: Arc<AtomicBool>,
}

impl Drop for FakeSource {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl Source for FakeSource {
    async fn next(&mut self) -> Result<RawSample, String> {
        tokio::time::sleep(Duration::from_millis(10)).await;
        if self.left == 0 {
            return Err("fake child exited (status 1)".into());
        }
        self.left -= 1;
        Ok(RawSample {
            apps: vec![RawApp {
                name: "fake".into(),
                pid: 9,
                user: None,
                totals: Some((1, 1)),
                conns: vec![RawConn {
                    proto: MachineProto::Tcp4,
                    local: "192.0.2.1:1".into(),
                    remote: Some("198.51.100.1:443".into()),
                    remote_ip: Some("198.51.100.1".parse().unwrap()),
                    state: "Established".into(),
                    bytes_in: Some(1),
                    bytes_out: Some(1),
                }],
            }],
            interval_ms: Some(1000),
        })
    }
}

fn platform() -> Platform {
    Platform {
        available: true,
        backend: Some("fake"),
        reason: None,
        has_bytes: true,
    }
}

struct Fake {
    calls: Arc<AtomicUsize>,
    dropped: Arc<AtomicBool>,
    factory: SourceFactory,
}

fn fake(samples: usize) -> Fake {
    let calls = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let (c, d) = (calls.clone(), dropped.clone());
    let factory: SourceFactory = Arc::new(move || {
        c.fetch_add(1, Ordering::SeqCst);
        d.store(false, Ordering::SeqCst);
        Ok(Box::new(FakeSource {
            left: samples,
            dropped: d.clone(),
        }) as Box<dyn Source>)
    });
    Fake {
        calls,
        dropped,
        factory,
    }
}

async fn until(mut f: impl FnMut() -> bool) -> bool {
    for _ in 0..300 {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn start_and_stop_are_idempotent_and_stop_drops_the_source() {
    let f = fake(usize::MAX);
    let rec = Arc::new(Recorder::default());
    let nm = NetMachine::new(platform(), Some(f.factory.clone()), rec.clone(), no_dns());
    assert!(!nm.status().running);
    assert!(nm.start().running);
    assert!(nm.start().running);
    assert_eq!(
        f.calls.load(Ordering::SeqCst),
        1,
        "a second start does not spawn a second source"
    );
    assert!(
        until(|| rec.samples().len() >= 2).await,
        "samples flow to the sink"
    );
    assert_eq!(rec.samples()[0].apps[0].key, "fake:9");

    let st = nm.stop();
    assert!(!st.running && st.available);
    assert!(
        until(|| f.dropped.load(Ordering::SeqCst)).await,
        "stop drops the source (kill_on_drop)"
    );
    assert!(!nm.stop().running, "stop twice is fine");
    let n = rec.samples().len();
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(rec.samples().len(), n, "nothing is emitted after stop");

    assert!(nm.start().running);
    assert_eq!(
        f.calls.load(Ordering::SeqCst),
        2,
        "start after stop starts again"
    );
    nm.stop();
}

#[tokio::test]
async fn a_source_that_dies_reports_the_reason_and_stops() {
    let f = fake(2);
    let rec = Arc::new(Recorder::default());
    let nm = NetMachine::new(platform(), Some(f.factory.clone()), rec.clone(), no_dns());
    nm.start();
    assert!(until(|| !nm.status().running).await);
    let st = nm.status();
    assert_eq!(st.reason.as_deref(), Some("fake child exited (status 1)"));
    assert!(st.available);
    assert_eq!(rec.samples().len(), 2);
    // A restart clears the stale reason.
    let st = nm.start();
    assert!(st.running && st.reason.is_none());
    nm.stop();
}

#[tokio::test]
async fn a_factory_error_is_a_reason_not_a_panic() {
    let factory: SourceFactory = Arc::new(|| Err("Couldn't start nettop: gone".to_string()));
    let nm = NetMachine::new(
        platform(),
        Some(factory),
        Arc::new(Recorder::default()),
        no_dns(),
    );
    let st = nm.start();
    assert!(!st.running);
    assert_eq!(st.reason.as_deref(), Some("Couldn't start nettop: gone"));
}

#[tokio::test]
async fn an_unavailable_platform_never_starts() {
    let f = fake(1);
    let p = Platform {
        available: false,
        backend: None,
        reason: Some(agent_studio_scaffold_lib::netmachine::OTHER_OS_REASON.into()),
        has_bytes: false,
    };
    let nm = NetMachine::new(
        p,
        Some(f.factory.clone()),
        Arc::new(Recorder::default()),
        no_dns(),
    );
    let st = nm.start();
    assert!(!st.available && !st.running);
    assert_eq!(
        st.reason.as_deref(),
        Some(agent_studio_scaffold_lib::netmachine::OTHER_OS_REASON)
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
}

// ---- macOS: the real nettop (local integration) --------------------------------------------

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "local integration: spawns the real /usr/bin/nettop (no root, no prompt)"]
async fn macos_real_nettop_sampler_emits_apps_with_bytes() {
    let rec = Arc::new(Recorder::default());
    let nm = NetMachine::for_this_os(rec.clone());
    let st = nm.start();
    assert!(st.available && st.running, "{st:?}");
    assert_eq!(st.backend, Some("macos-nettop"));
    let got = until(|| !rec.samples().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    // Non-vacuous: the child we are about to kill must be visible first.
    assert!(live_nettop_children(), "no nettop child while running");
    nm.stop();
    assert!(got, "no sample within 3 s");
    let samples = rec.samples();
    let s = samples.last().unwrap();
    assert!(!s.apps.is_empty());
    assert!(
        s.apps
            .iter()
            .flat_map(|a| &a.connections)
            .any(|c| c.bytes_in.is_some_and(|b| b > 0)),
        "no connection with bytes"
    );
    eprintln!(
        "samples={} apps={} conns={}",
        samples.len(),
        s.apps.len(),
        s.apps.iter().map(|a| a.connections.len()).sum::<usize>()
    );
    // stop killed the child. SIGKILL is immediate; without kill_on_drop nettop would only die of
    // SIGPIPE on its next write (up to 1 s later), so the window stays well under that.
    let mut alive = true;
    for _ in 0..6 {
        alive = live_nettop_children();
        if !alive {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive, "nettop survived stop");
}

/// A non-zombie `nettop` whose parent is this test process.
#[cfg(target_os = "macos")]
fn live_nettop_children() -> bool {
    let me = std::process::id().to_string();
    let out = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "ppid=,stat=,comm="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).lines().any(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        f.len() >= 3 && f[0] == me && !f[1].starts_with('Z') && f[2].ends_with("nettop")
    })
}

// ---- Linux: the real /proc (hermetic — loopback only) --------------------------------------

#[cfg(target_os = "linux")]
#[test]
fn linux_real_proc_sees_both_ends_of_our_own_connection() {
    use agent_studio_scaffold_lib::netmachine::{linux, MachineUser};
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let server_addr = listener.local_addr().unwrap();
    let mut client = std::net::TcpStream::connect(server_addr).unwrap();
    let (mut accepted, _) = listener.accept().unwrap();
    client.write_all(&[7u8; 1500]).unwrap();
    let mut buf = [0u8; 1500];
    accepted.read_exact(&mut buf).unwrap();
    let client_addr = client.local_addr().unwrap();

    let apps = linux::read_sample(linux::ss_path()).unwrap();
    let me = std::process::id();
    let ours: Vec<&RawApp> = apps.iter().filter(|a| a.pid == me).collect();
    assert_eq!(ours.len(), 1, "our sockets group under one app: {apps:#?}");
    let app = ours[0];
    assert_eq!(app.user, Some(MachineUser::SelfUser));
    let comm = std::fs::read_to_string("/proc/self/comm").unwrap();
    assert_eq!(app.name, comm.trim_end());

    let s = server_addr.to_string();
    let c = client_addr.to_string();
    let listen = app
        .conns
        .iter()
        .find(|x| x.local == s && x.remote.is_none())
        .expect("listener");
    assert_eq!(listen.state, "Listen");
    let client_end = app
        .conns
        .iter()
        .find(|x| x.local == c && x.remote.as_deref() == Some(s.as_str()))
        .expect("client end");
    let server_end = app
        .conns
        .iter()
        .find(|x| x.local == s && x.remote.as_deref() == Some(c.as_str()))
        .expect("server end");
    assert_eq!(client_end.state, "Established");
    assert_eq!(server_end.proto, MachineProto::Tcp4);
    if linux::ss_path().is_some() {
        assert!(server_end.bytes_in.unwrap() >= 1500, "{server_end:?}");
        assert!(client_end.bytes_out.unwrap() >= 1500, "{client_end:?}");
    } else {
        assert_eq!(server_end.bytes_in, None);
    }
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn linux_sampler_emits_samples_containing_this_process() {
    let _listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let rec = Arc::new(Recorder::default());
    let nm = NetMachine::for_this_os(rec.clone());
    let st = nm.start();
    assert!(st.running && st.available, "{st:?}");
    assert_eq!(st.backend, Some("linux-proc"));
    assert!(
        st.reason.is_some(),
        "partial visibility is always explained"
    );
    let me = std::process::id();
    let got = until(|| {
        rec.samples()
            .iter()
            .any(|s| s.apps.iter().any(|a| a.pid == me))
    })
    .await;
    nm.stop();
    assert!(got, "no sample with our pid");
}

// ---- names from the executable ---------------------------------------------------------------

#[tokio::test]
async fn the_sampler_names_apps_from_their_executable_and_keys_by_that_name() {
    let f = fake(usize::MAX);
    let rec = Arc::new(Recorder::default());
    // nettop called pid 9 `fake`; its executable is Claude Code's versioned binary.
    let nm = NetMachine::new(platform(), Some(f.factory.clone()), rec.clone(), no_dns())
        .with_exe_lookup(Arc::new(|pid| {
            (pid == 9).then(|| "/Users/me/.local/share/claude/versions/2.1.0".to_string())
        }));
    nm.start();
    assert!(until(|| rec.samples().len() >= 2).await);
    nm.stop();
    let s = rec.samples();
    let app = &s[1].apps[0];
    assert_eq!(app.name, "claude 2.1.0");
    assert_eq!(
        app.key, "claude 2.1.0:9",
        "the key follows the resolved name"
    );
    assert!(
        app.rate_in.is_some(),
        "the rate history is keyed by the same name, so the second sample has a rate"
    );
}

#[tokio::test]
async fn an_unreadable_executable_keeps_the_backend_name() {
    let f = fake(usize::MAX);
    let rec = Arc::new(Recorder::default());
    let nm = NetMachine::new(platform(), Some(f.factory.clone()), rec.clone(), no_dns())
        .with_exe_lookup(Arc::new(|_| None));
    nm.start();
    assert!(until(|| !rec.samples().is_empty()).await);
    nm.stop();
    assert_eq!(rec.samples()[0].apps[0].key, "fake:9");
}

/// The real lookup names this very test process from its executable, untruncated.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn the_system_lookup_resolves_our_own_executable() {
    use agent_studio_scaffold_lib::netmachine::names::{display_name, system_lookup};
    let me = std::process::id();
    let path = system_lookup()(me).expect("our own executable is readable");
    let exe = std::env::current_exe().unwrap();
    assert_eq!(
        std::fs::canonicalize(&path).unwrap(),
        std::fs::canonicalize(&exe).unwrap()
    );
    assert_eq!(
        display_name(&path).as_deref(),
        exe.file_name().and_then(|n| n.to_str())
    );
}
