//! Whole-computer goldens (`syslog-*.json`, `netmachine-*.json`) from the production parsers
//! over checked-in fixtures; nothing reads this machine, and `cfg` constants are restated and
//! asserted on their own OS. Normalised: the hub's drop-line stamp and a sample's `tsMs`.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::logstream::{
    LineDraft, LogHub, LogKind, LogLevel, LogLine, NullLogSink,
};
use agent_studio_scaffold_lib::netmachine::{
    self, nettop, procnet, rates::RateTracker, rdns, wintable, MachineSample, MachineStatus,
    NetMachine, Platform, RawSample, SampleSink, Source, SourceFactory,
};
use agent_studio_scaffold_lib::syslog::{
    self, child, journal, macos, procs, Backend, BackendKind, RunningApp, SyslogFilter,
    SyslogLevel, SyslogStatus,
};

use super::{check_golden, T0};

fn fixture(rel: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

// ── System-app logs ──────────────────────────────────────────────────────────

/// How many flood lines are pushed after the fixture lines: enough to fill the 500/s window
/// and have the cap drop exactly `DROPPED`.
const DROPPED: u32 = 7;

/// The fixture lines through the real parsers, then through the real hub and its cap.
/// Returns the ring (flood lines left out — they are asserted, not goldened) and the hub's
/// `(linesPerSec, droppedPerSec)` once the capped second is complete.
fn machine_lines_through_the_hub() -> (Vec<LogLine>, (u32, u32)) {
    let mut drafts: Vec<LineDraft> = Vec::new();
    let ndjson = fixture("syslog/macos-log-stream.ndjson");
    drafts.extend(ndjson.lines().filter_map(|l| macos::parse_ndjson(l, false)));
    // The simulator child runs the same parser with the source label on
    // (`Syslog::apply`: `macos::parse_ndjson(l, true)`); one fixture line stands for it.
    let first_event = ndjson
        .lines()
        .find(|l| l.contains("\"logEvent\"") && l.contains("ExampleApp"))
        .expect("the fixture has an ExampleApp event");
    drafts.push(macos::parse_ndjson(first_event, true).expect("parses"));
    drafts.extend(
        fixture("syslog/journal.json")
            .lines()
            .filter_map(journal::parse_journal),
    );
    let real = drafts.len();
    assert_eq!(
        real, 12,
        "5 log events + 1 simulator + 6 journal entries: {drafts:#?}"
    );

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap();
    rt.block_on(async move {
        let (hub, task) = LogHub::new(Arc::new(NullLogSink));
        tokio::spawn(task);
        settle().await;
        for d in drafts {
            hub.push(d);
        }
        settle().await;
        let flood = 500 - real as u32 + DROPPED;
        for i in 0..flood {
            hub.push(LineDraft {
                terminal_id: None,
                agent_id: None,
                source: "flood".into(),
                kind: LogKind::Machine,
                level: LogLevel::Info,
                text: format!("flood {i}"),
                detail: None,
                ts_ms: Some(T0 as i64),
                tool_use_id: None,
            });
            if i % 100 == 0 {
                settle().await;
            }
        }
        settle().await;
        tokio::time::advance(Duration::from_millis(60)).await;
        settle().await;
        let snap = hub.snapshot();
        let flooded = snap.iter().filter(|l| l.source == "flood").count();
        assert_eq!(
            flooded,
            500 - real,
            "the cap admitted exactly 500 in the second"
        );
        tokio::time::advance(Duration::from_millis(1_000)).await;
        let rates = hub.machine_rates();
        let lines = snap
            .into_iter()
            .filter(|l| l.source != "flood")
            .map(|mut l| {
                if l.kind == LogKind::System {
                    // The hub stamps its own lines with the wall clock.
                    l.ts_ms = T0 as i64 + 1_000;
                }
                l
            })
            .collect();
        (lines, rates)
    })
}

async fn settle() {
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }
}

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

/// A real supervised child: the same `child::spawn` `Syslog` uses, on a script that either
/// keeps streaming (`sleep`) or dies the way `log stream` does when it is refused.
fn spawn_child(
    rt: &tokio::runtime::Runtime,
    hub: &LogHub,
    program: PathBuf,
    label: &'static str,
) -> child::Running {
    let parser: syslog::Parser = Arc::new(|l: &str| macos::parse_ndjson(l, false));
    child::spawn(
        rt.handle(),
        child::ChildSpec {
            program,
            args: macos::log_args(&SyslogFilter::default()),
            label,
        },
        parser,
        hub.clone(),
    )
}

fn wait_dead(r: &child::Running) {
    let start = std::time::Instant::now();
    while r.exit_reason().is_none() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "child never exited"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!r.is_alive());
}

/// What `detect_backend` builds on macOS (private and `cfg`-gated; restated here).
fn macos_backend() -> Backend {
    Backend {
        available: true,
        name: Some("macos-unified-log"),
        reason: None,
        program: Some(PathBuf::from(macos::LOG_BIN)),
        kind: BackendKind::MacosUnifiedLog,
    }
}

const PROC_STATUS_USER: &str = "Name:\tagent-studio\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t4 27 1000\n";
/// `systemd-journal` exists, but uid 1000 is not in it (gids 4/27/1000 are adm-less here).
const ETC_GROUP: &str =
    "root:x:0:\nsudo:x:27:sam\nsystemd-journal:x:101:\nadm:x:5:syslog\nsam:x:1000:\n";

#[test]
fn syslog_wire_values_match_the_goldens() {
    // ── LogLine[] ──
    let (lines, rates) = machine_lines_through_the_hub();
    assert_eq!(
        rates,
        (500, DROPPED),
        "the capped second, as syslog_status reports it"
    );
    check_golden("syslog-lines.json", &lines);

    // ── SyslogStatus ──
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let hub = {
        let _g = rt.enter();
        let (hub, task) = LogHub::new(Arc::new(NullLogSink));
        rt.spawn(task);
        hub
    };
    let dir = std::env::temp_dir().join(format!("syslog-golden-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let streaming = script(&dir, "stream.sh", "exec sleep 60");
    let refused = script(
        &dir,
        "refused.sh",
        "echo 'log: Cannot open the log store: Operation not permitted' >&2\nexit 64",
    );

    let no_sim = (false, Some(syslog::NO_SIMULATOR_REASON.to_string()));
    let mac_only = (false, Some(syslog::SIMULATOR_MACOS_ONLY.to_string()));
    // Passive detection over a process list that has `launchd_sim`.
    let booted = procs::simulator_booted(&[
        procs::ProcInfo {
            pid: 1,
            name: "launchd".into(),
            path: Some("/sbin/launchd".into()),
        },
        procs::ProcInfo {
            pid: 9001,
            name: procs::SIMULATOR_MARKER.into(),
            path: None,
        },
    ]);
    assert!(booted);
    let sim_up = (booted, None);

    let main_live = spawn_child(&rt, &hub, streaming.clone(), "System apps");
    let main_dead = spawn_child(&rt, &hub, refused.clone(), "System apps");
    let sim_live = spawn_child(&rt, &hub, streaming.clone(), "iOS Simulator");
    let sim_dead = spawn_child(&rt, &hub, refused.clone(), "iOS Simulator");
    wait_dead(&main_dead);
    wait_dead(&sim_dead);
    assert!(main_live.is_alive() && sim_live.is_alive());

    let picked = SyslogFilter {
        enabled: true,
        apps: Some(vec![" Safari ".into(), "Mail".into(), "Safari".into()]),
        subsystem: Some(" com.example.app ".into()),
        min_level: SyslogLevel::Info,
        simulator: false,
        simulator_apps: None,
    }
    .normalized();
    assert_eq!(picked.apps, Some(vec!["Safari".into(), "Mail".into()]));
    let all_apps = SyslogFilter {
        enabled: true,
        ..Default::default()
    };
    let linux = journal::linux_backend(
        Some(PathBuf::from(journal::JOURNALCTL_PATHS[0])),
        true,
        PROC_STATUS_USER,
        ETC_GROUP,
    );
    assert_eq!(linux.reason.as_deref(), Some(journal::PARTIAL_JOURNAL));
    let linux_filter = SyslogFilter {
        enabled: true,
        apps: Some(vec!["nginx".into()]),
        subsystem: Some("nginx.service".into()),
        min_level: SyslogLevel::Error,
        simulator: false,
        simulator_apps: None,
    };
    let sim_filter = SyslogFilter {
        enabled: false,
        simulator: true,
        simulator_apps: Some(vec!["SpringBoard".into(), "ExampleApp".into()]),
        ..Default::default()
    };
    let other_os = syslog::unavailable(syslog::UNSUPPORTED_REASON);
    // The real Windows backend (platform-neutral constructor — what `detect_backend` returns
    // there), its filter semantics: providers, one extra channel, the error floor.
    let windows = syslog::eventlog::backend();
    assert_eq!(windows.name, Some("windows-eventlog"));
    let windows_filter = SyslogFilter {
        enabled: true,
        apps: Some(vec![" MsiInstaller ".into(), "Application Error".into()]),
        subsystem: Some(" Microsoft-Windows-PowerShell/Operational ".into()),
        min_level: SyslogLevel::Error,
        simulator: false,
        simulator_apps: None,
    }
    .normalized();

    let mut status: BTreeMap<&str, SyslogStatus> = BTreeMap::new();
    let mac = macos_backend();
    status.insert(
        "macos-running-picked",
        syslog::status_of(&mac, &picked, Some(&main_live), no_sim.clone(), None, rates),
    );
    status.insert(
        "macos-all-apps",
        syslog::status_of(
            &mac,
            &all_apps,
            Some(&main_live),
            no_sim.clone(),
            None,
            (212, 0),
        ),
    );
    status.insert(
        "macos-child-exited",
        syslog::status_of(
            &mac,
            &all_apps,
            Some(&main_dead),
            no_sim.clone(),
            None,
            (0, 0),
        ),
    );
    status.insert(
        "macos-simulator-streaming",
        syslog::status_of(
            &mac,
            &sim_filter,
            None,
            sim_up.clone(),
            Some(&sim_live),
            (0, 0),
        ),
    );
    status.insert(
        "macos-simulator-exited",
        syslog::status_of(&mac, &sim_filter, None, sim_up, Some(&sim_dead), (0, 0)),
    );
    status.insert(
        "linux-partial",
        syslog::status_of(
            &linux,
            &linux_filter,
            Some(&main_live),
            mac_only.clone(),
            None,
            (3, 0),
        ),
    );
    status.insert(
        "linux-no-journald",
        syslog::status_of(
            &journal::linux_backend(
                Some(PathBuf::from(journal::JOURNALCTL_PATHS[0])),
                false,
                PROC_STATUS_USER,
                ETC_GROUP,
            ),
            &SyslogFilter::default(),
            None,
            mac_only.clone(),
            None,
            (0, 0),
        ),
    );
    let other = syslog::status_of(
        &other_os,
        &SyslogFilter::default(),
        None,
        mac_only.clone(),
        None,
        (0, 0),
    );
    // The real manager over the same backend answers `syslog_set` identically, apart from the
    // simulator block it reads from THIS machine (why the golden uses `status_of`).
    {
        let _g = rt.enter();
        let s = syslog::Syslog::with_backend(hub.clone(), rt.handle().clone(), None, other_os);
        let mut via_manager = s.set(SyslogFilter::default());
        via_manager.simulator = other.simulator.clone();
        assert_eq!(via_manager, other);
    }
    status.insert("other-os-unavailable", other);
    // A running Event Log stream. `status_of` reads only a stream's alive/exit state, the same
    // for every source (`syslog::stream::Running`), so the live child stands in for the
    // subscription — which only exists on Windows, and this golden is built on unix.
    status.insert(
        "windows-eventlog",
        syslog::status_of(
            &windows,
            &windows_filter,
            Some(&main_live),
            mac_only.clone(),
            None,
            (2, 0),
        ),
    );
    drop((main_live, main_dead, sim_live, sim_dead));
    let _ = std::fs::remove_dir_all(&dir);

    // The child-exit reasons embed nothing machine-specific (checked, not normalised).
    for key in ["macos-child-exited", "macos-simulator-exited"] {
        let st = &status[key];
        let r = st.reason.as_deref().or(st.simulator.reason.as_deref());
        assert!(!r.unwrap_or("").contains(&*dir.to_string_lossy()), "{r:?}");
    }
    check_golden("syslog-status.json", &status);

    // ── RunningApp[] ──
    let p = |pid: u32, name: &str, path: Option<&str>| procs::ProcInfo {
        pid,
        name: name.into(),
        path: path.map(str::to_string),
    };
    let apps: Vec<RunningApp> = procs::group_apps(vec![
        p(812, "zsh", Some("/bin/zsh")),
        p(
            501,
            "Safari",
            Some("/Applications/Safari.app/Contents/MacOS/Safari"),
        ),
        p(407, "exampled", Some("/usr/libexec/exampled")),
        p(
            733,
            "Xcode",
            Some("/Applications/Xcode.app/Contents/MacOS/Xcode"),
        ),
        p(
            640,
            "Mail",
            Some("/System/Applications/Mail.app/Contents/MacOS/Mail"),
        ),
        p(9001, procs::SIMULATOR_MARKER, None),
        p(
            502,
            "Safari",
            Some("/Applications/Safari.app/Contents/MacOS/Safari"),
        ),
        p(77, "", None),
        p(811, "zsh", Some("/bin/zsh")),
        p(15, "bash", Some("/bin/bash")),
    ]);
    check_golden("syslog-apps.json", &apps);
}

// ── Whole-computer network ───────────────────────────────────────────────────

#[derive(Default)]
struct SampleRec(Mutex<Vec<MachineSample>>);
impl SampleSink for SampleRec {
    fn emit(&self, s: &MachineSample) {
        self.0.lock().unwrap().push(s.clone());
    }
}

/// Yields pre-cut raw samples like `NettopSource::next`, then dies like a nettop child does.
struct ReplaySource(std::vec::IntoIter<RawSample>);

/// `NettopSource::next`'s own message for an EOF (the source is `cfg(macos)`; restated).
const NETTOP_DIED: &str = "nettop stopped unexpectedly (exit status: 1).";

#[async_trait::async_trait]
impl Source for ReplaySource {
    async fn next(&mut self) -> Result<RawSample, String> {
        tokio::time::sleep(Duration::from_millis(20)).await;
        self.0.next().ok_or_else(|| NETTOP_DIED.to_string())
    }
}

/// The nettop fixture cut exactly as `NettopSource` cuts the live stream.
fn nettop_raw_samples() -> Vec<RawSample> {
    let mut split = nettop::NettopSplitter::default();
    let text = fixture("netmachine/nettop_stream2.csv");
    let header = text.lines().next().unwrap().to_string();
    // In the live stream the header that opens sample 3 is what completes sample 2.
    let texts: Vec<String> = text
        .lines()
        .chain(std::iter::once(header.as_str()))
        .filter_map(|l| split.push(l))
        .collect();
    assert_eq!(texts.len(), 2);
    texts
        .iter()
        .map(|t| RawSample {
            apps: nettop::parse_sample(t),
            interval_ms: Some(1000),
        })
        .collect()
}

/// What `netmachine::macos::platform()` answers with nettop present (`cfg(macos)`; restated
/// and checked against the real one on macOS below).
fn macos_platform() -> Platform {
    Platform {
        available: true,
        backend: Some("macos-nettop"),
        reason: None,
        has_bytes: true,
    }
}

const LINUX_PARTIAL: &str =
    "Other users' connections are listed without a process — naming them needs root.";
const LINUX_NO_SS: &str = "Other users' connections are listed without a process, and byte counts need `ss` (iproute2), which isn't installed.";

fn linux_platform(ss: bool) -> Platform {
    Platform {
        available: true,
        backend: Some("linux-proc"),
        reason: Some(if ss { LINUX_PARTIAL } else { LINUX_NO_SS }.to_string()),
        has_bytes: ss,
    }
}

#[test]
fn the_restated_platform_constants_are_the_real_ones_on_their_os() {
    #[cfg(target_os = "macos")]
    {
        let (p, f) = netmachine::macos::platform();
        let want = macos_platform();
        assert_eq!(
            (p.available, p.backend, p.reason, p.has_bytes, f.is_some()),
            (
                want.available,
                want.backend,
                want.reason,
                want.has_bytes,
                true
            )
        );
    }
    #[cfg(target_os = "linux")]
    {
        assert_eq!(netmachine::linux::PARTIAL_REASON, LINUX_PARTIAL);
        assert_eq!(netmachine::linux::NO_SS_REASON, LINUX_NO_SS);
        let (p, _) = netmachine::linux::platform();
        let want = linux_platform(netmachine::linux::ss_path().is_some());
        assert_eq!(
            (p.backend, p.reason, p.has_bytes),
            (want.backend, want.reason, want.has_bytes)
        );
    }
    let _ = (macos_platform(), linux_platform(true));
}

// `/proc/net/*` rows as the kernel prints them on a little-endian host (addresses are host-order
// words — see procnet.rs). uid 1000 is "us"; inodes 10xx belong to our `node` (pid 4242).
const PROC_TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1001 1 0000000000000000 100 0 0 10 0
   1: 0500000A:CB20 22D8B85D:01BB 01 00000000:00000000 02:000A7D8B 00000000  1000        0 1002 2 0000000000000000 20 4 30 10 -1
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2001 1 0000000000000000 100 0 0 10 0
   3: 0500000A:0016 0900000A:EA60 01 00000000:00000000 02:000A7D8B 00000000     0        0 2002 2 0000000000000000 20 4 30 10 -1
   4: 0500000A:CB21 22D8B85D:01BB 06 00000000:00000000 03:00001773 00000000  1000        0 0 3 0000000000000000
";
const PROC_TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:240D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1003 1 0000000000000000 100 0 0 10 0
   1: B80D0120000000000000000005000000:9C40 00470626000000000000000011110000:01BB 01 00000000:00000000 02:000A7D8B 00000000  1000        0 1004 2 0000000000000000 20 4 30 10 -1
";
const PROC_UDP: &str = "   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  100: 00000000:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 1005 2 0000000000000000 0
  101: 3500007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   101        0 3001 2 0000000000000000 0
";
const PROC_UDP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  200: 000080FE000000000000000001000000:0222 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 1006 2 0000000000000000 0
";

fn ss_text(tick: u64) -> String {
    let k = tick * 1_000;
    format!(
        "ESTAB 0      0      10.0.0.5:52000 93.184.216.34:443\n\t cubic wscale:7,7 rto:204 rtt:1.5/0.75 bytes_sent:{s} bytes_acked:{a} bytes_received:{r} segs_out:10\n\
         ESTAB 0      0      10.0.0.5:22 10.0.0.9:60000\n\t cubic rto:204 bytes_acked:{a2} bytes_received:{r2}\n\
         ESTAB 0      0      [2001:db8::5]:40000 [2606:4700::1111]:443\n\t cubic rto:204 bytes_acked:{a3} bytes_received:{r3}\n",
        s = 1_300 + k,
        a = 1_201 + k,
        r = 5_400 + 4 * k,
        a2 = 880 + k / 2,
        r2 = 2_048,
        a3 = 612,
        r3 = 90_000 + 16 * k,
    )
}

fn linux_sockets() -> Vec<procnet::ProcSocket> {
    use netmachine::MachineProto::*;
    let mut s = procnet::parse_proc_net(PROC_TCP, Tcp4);
    s.extend(procnet::parse_proc_net(PROC_TCP6, Tcp6));
    s.extend(procnet::parse_proc_net(PROC_UDP, Udp4));
    s.extend(procnet::parse_proc_net(PROC_UDP6, Udp6));
    assert_eq!(s.len(), 10, "every synthetic row parses: {s:#?}");
    s
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn netmachine_wire_values_match_the_goldens() {
    let mut samples: BTreeMap<&str, MachineSample> = BTreeMap::new();
    let mut status: BTreeMap<&str, MachineStatus> = BTreeMap::new();

    // ── macOS: the real sampler over the nettop fixture ──
    let rec = Arc::new(SampleRec::default());
    let raw = Arc::new(Mutex::new(Some(nettop_raw_samples())));
    let factory: SourceFactory = Arc::new(move || {
        let s = raw.lock().unwrap().take().ok_or("only one run")?;
        Ok(Box::new(ReplaySource(s.into_iter())) as Box<dyn Source>)
    });
    // Names come from each pid's executable when readable: a truncated helper
    // name gets its full bundle name, Claude Code's versioned binary reads `claude <ver>`,
    // and every other pid keeps nettop's name (the lookup answers `None`).
    let nm = NetMachine::new(
        macos_platform(),
        Some(factory),
        rec.clone(),
        Arc::new(|_: IpAddr| None),
    )
    .with_exe_lookup(Arc::new(|pid| match pid {
        100 => Some(
            "/Applications/Browser.app/Contents/Frameworks/Browser Helper (Renderer).app/Contents/MacOS/Browser Helper (Renderer)"
                .to_string(),
        ),
        130 => Some("/Users/dev/.local/share/claude/versions/2.1.0".to_string()),
        _ => None,
    }));
    status.insert("macos-idle", nm.status());
    let started = nm.start();
    assert!(started.running);
    status.insert("macos-running", started);
    let start = std::time::Instant::now();
    while nm.status().running {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "the replay never ended"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    status.insert("macos-died", nm.status());
    let got = rec.0.lock().unwrap().clone();
    assert_eq!(got.len(), 2);
    for (i, (name, mut s)) in ["macos-first", "macos-second"]
        .into_iter()
        .zip(got)
        .enumerate()
    {
        s.ts_ms = T0 + i as u64 * 1_000;
        samples.insert(name, s);
    }

    // ── Linux: /proc/net + ss through the real parsers, rated, with reverse DNS ──
    let sockets = linux_sockets();
    let owners: std::collections::HashMap<u64, (u32, String)> = (1001..=1006)
        .map(|inode| (inode, (4242, "node".to_string())))
        .collect();
    let resolver: rdns::Resolver = Arc::new(|ip: IpAddr| match ip.to_string().as_str() {
        "93.184.216.34" => Some("api.example.com".to_string()),
        "2606:4700::1111" => Some("one.one.one.one".to_string()),
        _ => None,
    });
    let dns = rdns::Rdns::new(resolver);
    // Warm the cache the way a running sampler does: the first sample schedules the lookup,
    // a later one reads the answer.
    for ip in ["93.184.216.34", "2606:4700::1111"] {
        let ip: IpAddr = ip.parse().unwrap();
        let start = std::time::Instant::now();
        while dns.host_of(ip).is_none() {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "rdns never answered {ip}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    let mut tracker = RateTracker::default();
    for (tick, name) in [(0u64, "linux-first"), (1, "linux-second")] {
        let ss = procnet::parse_ss(&ss_text(tick));
        let apps = procnet::assemble(&sockets, &owners, 1000, Some(&ss));
        let s = tracker.apply(apps, T0 + tick * 1_000, None, &mut |ip| dns.host_of(ip));
        samples.insert(name, s);
    }
    // No `ss`: sockets without byte counts (every byte field null).
    let apps = procnet::assemble(&sockets, &owners, 1000, None);
    let s = RateTracker::default().apply(apps, T0, None, &mut |ip| dns.host_of(ip));
    samples.insert("linux-no-ss", s);

    // ── statuses of the other platforms ──
    let never: SourceFactory =
        Arc::new(|| Ok(Box::new(ReplaySource(Vec::new().into_iter())) as Box<dyn Source>));
    let linux = NetMachine::new(
        linux_platform(true),
        Some(never.clone()),
        Arc::new(SampleRec::default()),
        Arc::new(|_: IpAddr| None),
    );
    let st = linux.start();
    assert!(st.running);
    status.insert("linux-partial-running", st);
    linux.stop();
    let no_ss = NetMachine::new(
        linux_platform(false),
        None,
        Arc::new(SampleRec::default()),
        Arc::new(|_: IpAddr| None),
    );
    status.insert("linux-no-ss", no_ss.status());
    // ── Windows: the kernel tables through the real parser and assembler ──
    // Every app is named, nothing has a byte count, and there is no "whose is it".
    let win_names: std::collections::HashMap<u32, String> = [
        (4, "System".to_string()),
        (5120, "node.exe".to_string()),
        (9044, "chrome.exe".to_string()),
    ]
    .into();
    let wt = |local: &str, remote: &str, state: u32, pid: u32| wintable::TcpRow {
        local: local.parse().unwrap(),
        remote: remote.parse().unwrap(),
        state,
        pid,
    };
    let win_tcp = [
        wt("10.0.0.5:52001", "93.184.216.34:443", 5, 5120),
        wt("0.0.0.0:3000", "0.0.0.0:0", 2, 5120),
        wt("[::1]:52002", "[::1]:3000", 5, 9044),
        wt("[2001:db8::5]:52003", "[2606:4700::1111]:443", 11, 9044),
        wt("0.0.0.0:445", "0.0.0.0:0", 2, 4),
    ];
    let win_udp = [wintable::UdpRow {
        local: "0.0.0.0:5353".parse().unwrap(),
        pid: 9044,
    }];
    let apps = wintable::assemble(&win_tcp, &win_udp, &win_names);
    let s = RateTracker::default().apply(apps, T0, None, &mut |ip| dns.host_of(ip));
    samples.insert("windows-first", s);
    let windows = NetMachine::new(
        Platform {
            available: true,
            backend: Some(wintable::BACKEND),
            reason: Some(wintable::NO_BYTES_REASON.to_string()),
            has_bytes: false,
        },
        Some(never.clone()),
        Arc::new(SampleRec::default()),
        Arc::new(|_: IpAddr| None),
    );
    status.insert("windows-idle", windows.status());
    let st = windows.start();
    assert!(st.running && st.available && !st.has_bytes);
    status.insert("windows-running", st);
    windows.stop();
    // An OS with no backend at all (none of the three we ship for).
    let other = NetMachine::new(
        Platform {
            available: false,
            backend: None,
            reason: Some(netmachine::OTHER_OS_REASON.to_string()),
            has_bytes: false,
        },
        None,
        Arc::new(SampleRec::default()),
        Arc::new(|_: IpAddr| None),
    );
    let st = other.start();
    assert_eq!(st, netmachine::unavailable(netmachine::OTHER_OS_REASON));
    status.insert("other-os-unavailable", st);
    let missing = NetMachine::new(
        Platform {
            available: false,
            backend: Some("macos-nettop"),
            reason: Some("/usr/bin/nettop is missing, so connections can't be listed.".into()),
            has_bytes: false,
        },
        None,
        Arc::new(SampleRec::default()),
        Arc::new(|_: IpAddr| None),
    );
    status.insert("macos-nettop-missing", missing.status());

    check_golden("netmachine-samples.json", &samples);
    check_golden("netmachine-status.json", &status);
}
