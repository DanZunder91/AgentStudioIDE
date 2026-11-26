//! System-app logs (`syslog/`). Hermetic: no `log stream`, `journalctl` or `simctl`. Both
//! platforms' parsers run on every OS against synthetic fixtures; supervision is driven with
//! `/bin/sh` (unix) and a missing program path (everywhere). Contract numbers are literals.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::logstream::{
    LineDraft, LogHub, LogKind, LogLevel, LogLine, LogSink,
};
#[cfg(unix)]
use agent_studio_scaffold_lib::syslog::child;
use agent_studio_scaffold_lib::syslog::{
    journal, macos, prefs, unavailable, Backend, BackendKind, Syslog, SyslogFilter, SyslogLevel,
};
use tokio::time::advance;

fn fixture(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/syslog")
        .join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

#[derive(Clone, Default)]
struct Rec(Arc<Mutex<Vec<LogLine>>>);
impl LogSink for Rec {
    fn emit(&self, lines: &[LogLine]) {
        self.0.lock().unwrap().extend_from_slice(lines);
    }
}

fn hub() -> LogHub {
    let (hub, task) = LogHub::new(Arc::new(Rec::default()));
    tokio::spawn(task);
    hub
}

async fn settle() {
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }
}

/// Real-time poll (for tests that wait on a real child process).
async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn tmp_prefs() -> PathBuf {
    std::env::temp_dir()
        .join(format!("syslog-test-{}", ulid::Ulid::new()))
        .join("syslog")
        .join(prefs::FILE_NAME)
}

// ── macOS ndjson fixture ─────────────────────────────────────────────────────

#[test]
fn the_macos_fixture_parses_into_machine_lines() {
    let text = fixture("macos-log-stream.ndjson");
    let got: Vec<LineDraft> = text
        .lines()
        .filter_map(|l| macos::parse_ndjson(l, false))
        .collect();
    // Header, activity event, truncated JSON and garbage are skipped.
    assert_eq!(got.len(), 5, "{got:#?}");
    for d in &got {
        assert_eq!(d.kind, LogKind::Machine);
        assert_eq!(d.terminal_id, None);
        assert_eq!(d.agent_id, None);
    }

    let a = &got[0];
    assert_eq!(a.source, "ExampleApp");
    assert_eq!(a.level, LogLevel::Info, "Default → info");
    assert_eq!(
        a.text,
        "[com.example.app:Network] request finished; calling completion handler"
    );
    assert_eq!(
        a.detail.as_deref(),
        Some("/Applications/ExampleApp.app/Contents/MacOS/ExampleApp · pid 1234 · com.example.app:Network")
    );
    assert_eq!(a.ts_ms, Some(1_767_268_800_250));

    let b = &got[1];
    assert_eq!(b.source, "exampled");
    assert_eq!(b.level, LogLevel::Info);
    assert_eq!(b.text, "idle tick: count=0", "bare message with neither");
    assert_eq!(
        b.detail.as_deref(),
        Some("/usr/libexec/exampled · pid 4321")
    );

    assert_eq!(got[2].level, LogLevel::Error);
    assert_eq!(
        got[2].text,
        "[com.example.app] could not open the example database"
    );
    assert_eq!(got[3].level, LogLevel::Error, "Fault → error");
    assert_eq!(got[3].text, "[lifecycle] assertion failed: state == ready");

    let e = &got[4];
    assert_eq!(e.level, LogLevel::Debug);
    assert_eq!(
        e.text, "[com.example.app:UI] layout pass 1",
        "first line only"
    );
    assert!(
        e.detail
            .as_deref()
            .unwrap()
            .ends_with("\nlayout pass 1\nlayout pass 2"),
        "the whole message rides in detail: {:?}",
        e.detail
    );
}

#[test]
fn simulator_lines_are_labelled_as_such() {
    let text = fixture("macos-log-stream.ndjson");
    let first = text
        .lines()
        .find_map(|l| macos::parse_ndjson(l, true))
        .unwrap();
    assert_eq!(first.source, "Simulator · ExampleApp");
}

#[test]
fn an_oversized_message_is_capped_at_4_kib() {
    let msg = "x".repeat(10_000);
    let line = serde_json::json!({
        "messageType": "Default", "eventType": "logEvent",
        "processImagePath": "/usr/bin/big", "processID": 1, "eventMessage": msg,
        "subsystem": "", "category": "", "timestamp": "2026-09-24 00:00:00.0+0000"
    })
    .to_string();
    let d = macos::parse_ndjson(&line, false).unwrap();
    assert!(
        d.text.len() <= 4 * 1024 + '…'.len_utf8(),
        "{}",
        d.text.len()
    );
    assert!(d.text.ends_with('…'));
}

// ── journald fixture ─────────────────────────────────────────────────────────

#[test]
fn the_journal_fixture_parses_into_machine_lines() {
    let text = fixture("journal.json");
    let got: Vec<LineDraft> = text.lines().filter_map(journal::parse_journal).collect();
    // "-- No entries --", MESSAGE:null and the truncated line are skipped.
    assert_eq!(got.len(), 6, "{got:#?}");
    assert!(got.iter().all(|d| d.kind == LogKind::Machine));

    let a = &got[0];
    assert_eq!(a.source, "example-daemon");
    assert_eq!(a.level, LogLevel::Info);
    assert_eq!(a.text, "listening on port 8080");
    assert_eq!(
        a.detail.as_deref(),
        Some("/usr/bin/example-daemon · pid 4242 · example.service")
    );
    assert_eq!(a.ts_ms, Some(1_767_268_800_250), "µs → ms");

    assert_eq!(got[1].level, LogLevel::Error, "PRIORITY 3");
    assert_eq!(got[2].level, LogLevel::Warn, "PRIORITY 4");
    assert_eq!(
        got[2].source, "example-cron",
        "SYSLOG_IDENTIFIER when no _COMM"
    );

    let bytes = &got[3];
    assert_eq!(bytes.level, LogLevel::Debug, "PRIORITY 7");
    assert_eq!(bytes.text, "bytes ✓", "MESSAGE as a byte array, first line");
    assert!(bytes
        .detail
        .as_deref()
        .unwrap()
        .ends_with("bytes ✓\nsecond line"));

    assert_eq!(got[4].level, LogLevel::Error, "PRIORITY 0");
    assert_eq!(
        got[5].source, "journal",
        "neither _COMM nor SYSLOG_IDENTIFIER"
    );
    assert_eq!(got[5].level, LogLevel::Info, "no PRIORITY → info");
}

// ── hub integration ──────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn machine_lines_land_in_the_ring_with_their_source_and_level() {
    let hub = hub();
    settle().await;
    for d in fixture("macos-log-stream.ndjson")
        .lines()
        .filter_map(|l| macos::parse_ndjson(l, false))
        .chain(
            fixture("journal.json")
                .lines()
                .filter_map(journal::parse_journal),
        )
    {
        hub.push(d);
    }
    settle().await;
    let snap = hub.snapshot();
    assert_eq!(snap.len(), 11);
    assert!(snap.iter().all(|l| l.kind == LogKind::Machine));
    assert_eq!(snap[0].source, "ExampleApp");
    assert_eq!(snap[2].level, LogLevel::Error);
    assert_eq!(snap[5].source, "example-daemon");
    let wire = serde_json::to_value(&snap[0]).unwrap();
    assert_eq!(wire["kind"], "machine");
    assert_eq!(wire["terminalId"], serde_json::Value::Null);
    assert_eq!(wire["agentId"], serde_json::Value::Null);
}

fn machine(i: usize) -> LineDraft {
    LineDraft {
        terminal_id: None,
        agent_id: None,
        source: "exampled".into(),
        kind: LogKind::Machine,
        level: LogLevel::Info,
        text: format!("m{i}"),
        detail: None,
        ts_ms: None,
        tool_use_id: None,
    }
}

#[tokio::test(start_paused = true)]
async fn the_machine_cap_is_500_a_second_and_says_how_many_it_dropped() {
    let hub = hub();
    settle().await;
    // Interleave so the queue never fills (the cap, not the queue, must do the dropping).
    for i in 0..1_200 {
        hub.push(machine(i));
        if i % 100 == 0 {
            settle().await;
        }
    }
    // The IDE's own line still gets through after the flood.
    hub.push(LineDraft::system(
        None,
        None,
        "zsh",
        LogLevel::Info,
        "ide line",
    ));
    settle().await;
    advance(Duration::from_millis(60)).await;
    settle().await;

    let snap = hub.snapshot();
    let machine_n = snap.iter().filter(|l| l.kind == LogKind::Machine).count();
    assert_eq!(machine_n, 500, "exactly the cap in one second");
    assert!(
        snap.iter().any(|l| l.text == "ide line"),
        "the IDE is never starved"
    );
    let reports: Vec<&LogLine> = snap
        .iter()
        .filter(|l| l.text.contains("system-app lines dropped"))
        .collect();
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!(
        reports[0].text,
        "… 700 system-app lines dropped (rate limit)"
    );
    assert_eq!(reports[0].kind, LogKind::System);
    assert_eq!(reports[0].level, LogLevel::Warn);

    // More drops within the same second are not reported again yet…
    for i in 0..10 {
        hub.push(machine(i));
    }
    settle().await;
    advance(Duration::from_millis(200)).await;
    settle().await;
    let n = |h: &LogHub| {
        h.snapshot()
            .iter()
            .filter(|l| l.text.contains("system-app lines dropped"))
            .count()
    };
    assert_eq!(n(&hub), 1, "at most one report per second");
    // …and once the window rolls, a fresh 500 are admitted and the backlog is reported.
    advance(Duration::from_millis(800)).await;
    settle().await;
    assert_eq!(n(&hub), 2);
    assert!(hub
        .snapshot()
        .iter()
        .any(|l| l.text == "… 10 system-app lines dropped (rate limit)"));
    for i in 0..500 {
        hub.push(machine(i));
        if i % 100 == 0 {
            settle().await;
        }
    }
    settle().await;
    let machine_n = hub
        .snapshot()
        .iter()
        .filter(|l| l.kind == LogKind::Machine)
        .count();
    assert_eq!(machine_n, 1_000, "a new second, a new 500");
    // The rates the status reports: the last complete window.
    advance(Duration::from_millis(1_000)).await;
    assert_eq!(hub.machine_rates(), (500, 0));
}

#[tokio::test(start_paused = true)]
async fn non_machine_lines_are_never_rate_capped() {
    let hub = hub();
    settle().await;
    for i in 0..1_000 {
        hub.push(LineDraft::system(
            None,
            None,
            "t",
            LogLevel::Info,
            format!("s{i}"),
        ));
        if i % 100 == 0 {
            settle().await;
        }
    }
    settle().await;
    assert_eq!(hub.snapshot().len(), 1_000);
}

// ── the manager, with an injected backend (hermetic on every OS) ─────────────

fn missing_program_backend() -> Backend {
    Backend {
        available: true,
        name: Some("macos-unified-log"),
        reason: None,
        program: Some(PathBuf::from("/nonexistent/agent-studio/log")),
        kind: BackendKind::MacosUnifiedLog,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unavailable_backend_persists_the_filter_but_runs_nothing() {
    let hub = hub();
    let path = tmp_prefs();
    let s = Syslog::with_backend(
        hub,
        tokio::runtime::Handle::current(),
        Some(path.clone()),
        unavailable(agent_studio_scaffold_lib::syslog::UNSUPPORTED_REASON),
    );
    let st = s.set(SyslogFilter {
        enabled: true,
        apps: Some(vec![" Safari ".into()]),
        ..Default::default()
    });
    assert!(!st.available && !st.running);
    assert_eq!(st.backend, None);
    assert_eq!(
        st.reason.as_deref(),
        Some("System app logs aren't supported on this operating system.")
    );
    assert_eq!(
        st.filter.apps,
        Some(vec!["Safari".to_string()]),
        "normalized"
    );
    assert_eq!(prefs::load(&path), st.filter, "persisted");
    let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_child_that_cannot_start_reports_why_and_is_not_running() {
    let hub = hub();
    let s = Syslog::with_backend(
        hub.clone(),
        tokio::runtime::Handle::current(),
        None,
        missing_program_backend(),
    );
    let st = s.set(SyslogFilter {
        enabled: true,
        ..Default::default()
    });
    assert!(st.available);
    assert_eq!(st.backend.as_deref(), Some("macos-unified-log"));
    wait_for("the spawn failure to surface", || !s.status().running).await;
    let st = s.status();
    let reason = st.reason.unwrap_or_default();
    assert!(
        reason.contains("could not start") && reason.contains("/nonexistent/agent-studio/log"),
        "{reason}"
    );
    wait_for("a system line about it", || {
        hub.snapshot()
            .iter()
            .any(|l| l.kind == LogKind::System && l.text.contains("could not start"))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_or_no_apps_selected_spawns_nothing() {
    let hub = hub();
    let s = Syslog::with_backend(
        hub.clone(),
        tokio::runtime::Handle::current(),
        None,
        missing_program_backend(),
    );
    for f in [
        SyslogFilter::default(),
        SyslogFilter {
            enabled: true,
            apps: Some(vec![]),
            ..Default::default()
        },
    ] {
        let st = s.set(f);
        assert!(!st.running);
        assert_eq!(st.reason, None, "nothing was spawned, so nothing failed");
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(hub.snapshot().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_resumes_only_what_the_prefs_enable() {
    // Off by default → nothing.
    let s = Syslog::with_backend(
        hub(),
        tokio::runtime::Handle::current(),
        Some(tmp_prefs()),
        missing_program_backend(),
    );
    s.start_from_prefs();
    assert_eq!(s.status().reason, None);
    // Enabled in prefs → it tries (and here, fails loudly).
    let path = tmp_prefs();
    prefs::save(
        &path,
        &SyslogFilter {
            enabled: true,
            min_level: SyslogLevel::Error,
            ..Default::default()
        },
    )
    .unwrap();
    let s = Syslog::with_backend(
        hub(),
        tokio::runtime::Handle::current(),
        Some(path.clone()),
        missing_program_backend(),
    );
    assert_eq!(s.status().filter.min_level, SyslogLevel::Error, "loaded");
    s.start_from_prefs();
    wait_for("the resumed child's failure", || {
        s.status()
            .reason
            .is_some_and(|r| r.contains("could not start"))
    })
    .await;
    let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
}

// ── child supervision with a real process (unix) ─────────────────────────────

#[cfg(unix)]
mod unix {
    use super::*;

    fn sh(script: String) -> child::ChildSpec {
        child::ChildSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script],
            label: "System apps",
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_lines_are_parsed_into_the_hub_and_an_exit_reports_the_stderr_tail() {
        let hub = hub();
        let fx = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/syslog/macos-log-stream.ndjson");
        let script = format!(
            "cat '{}'; echo 'log: predicate is invalid' >&2; exit 64",
            fx.display()
        );
        let run = child::spawn(
            &tokio::runtime::Handle::current(),
            sh(script),
            Arc::new(|l: &str| macos::parse_ndjson(l, false)),
            hub.clone(),
        );
        wait_for("the child to exit", || !run.is_alive()).await;
        let why = run.exit_reason().unwrap();
        assert_eq!(
            why,
            "System apps log stream stopped (exit code 64): log: predicate is invalid"
        );
        wait_for("5 machine lines + the system line", || {
            hub.snapshot().len() >= 6
        })
        .await;
        let snap = hub.snapshot();
        assert_eq!(
            snap.iter().filter(|l| l.kind == LogKind::Machine).count(),
            5
        );
        let sys = snap.iter().find(|l| l.kind == LogKind::System).unwrap();
        assert_eq!(sys.text, why);
        assert_eq!(sys.level, LogLevel::Error);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_the_handle_kills_the_child_quietly() {
        let hub = hub();
        let pidfile = std::env::temp_dir().join(format!("syslog-pid-{}", ulid::Ulid::new()));
        let script = format!("echo $$ > '{}'; exec sleep 30", pidfile.display());
        let run = child::spawn(
            &tokio::runtime::Handle::current(),
            sh(script),
            Arc::new(|_: &str| None),
            hub.clone(),
        );
        wait_for("the pid file", || {
            std::fs::read_to_string(&pidfile).is_ok_and(|s| s.trim().parse::<u32>().is_ok())
        })
        .await;
        let pid = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .to_string();
        let alive = |pid: &str| {
            std::process::Command::new("/bin/kill")
                .args(["-0", pid])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        assert!(alive(&pid), "sleep should be running");
        drop(run);
        wait_for("the child to be killed", || !alive(&pid)).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            hub.snapshot().is_empty(),
            "a deliberate stop posts nothing: {:?}",
            hub.snapshot()
        );
        let _ = std::fs::remove_file(pidfile);
    }
}

// ── the platform glue, for real ──────────────────────────────────────────────

/// In the Ubuntu verification container journald is NOT running: the Linux glue must say
/// so (`available: false` + reason), never crash or pretend.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linux_without_journald_is_unavailable_with_a_reason() {
    if std::path::Path::new(journal::JOURNALD_RUNTIME_DIR).is_dir() {
        eprintln!("journald is running here; this test is about a machine without it");
        return;
    }
    let s = Syslog::new(hub(), tokio::runtime::Handle::current(), None);
    let st = s.set(SyslogFilter {
        enabled: true,
        ..Default::default()
    });
    assert!(!st.available, "{st:?}");
    assert!(!st.running);
    assert_eq!(st.backend, None);
    let r = st.reason.unwrap();
    assert!(
        r == journal::NO_JOURNALD || r == journal::NO_JOURNALCTL,
        "unexpected reason: {r}"
    );
    assert!(!st.simulator.available);
    assert_eq!(
        st.simulator.reason.as_deref(),
        Some("The iOS Simulator is only available on macOS.")
    );
}

/// `syslog_apps`'s listing on this OS finds this very test process, grouped by the key the
/// filter uses (macOS: executable basename; Linux: `comm`).
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn the_process_list_groups_this_test_binary() {
    use agent_studio_scaffold_lib::syslog::procs;
    let me = std::process::id();
    let apps = procs::group_apps(procs::list_processes());
    let mine = apps
        .iter()
        .find(|a| a.pids.contains(&me))
        .expect("own process listed");
    let exe = std::env::current_exe().unwrap();
    let base = exe.file_name().unwrap().to_string_lossy().to_string();
    if cfg!(target_os = "linux") {
        assert_eq!(mine.name, journal::comm_of(&base));
    } else {
        assert_eq!(mine.name, base);
    }
    assert!(!mine.is_app);
}
