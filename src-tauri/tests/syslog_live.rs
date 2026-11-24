//! LOCAL INTEGRATION (`#[ignore]`): the real macOS unified log, end to end.
//!
//! Runs `/usr/bin/log stream` through the production `Syslog` manager with a filter for the
//! `logger` process, emits a unique marker with `/usr/bin/logger` (a built-in, writes to the
//! unified log, needs no permission), and asserts the marker lands in the `LogHub` ring as a
//! `machine` line. Never touches `simctl`. Registered in `npm run verify`.
//!
//!   cargo test --test syslog_live -- --ignored

#![cfg(target_os = "macos")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::logstream::{LogHub, LogKind, NullLogSink};
use agent_studio_scaffold_lib::syslog::{Syslog, SyslogFilter};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "local integration: runs the real /usr/bin/log stream"]
async fn real_log_stream_delivers_a_logger_line_into_the_hub() {
    let (hub, task) = LogHub::new(Arc::new(NullLogSink));
    tokio::spawn(task);
    let s = Syslog::new(hub.clone(), tokio::runtime::Handle::current(), None);
    let st = s.set(SyslogFilter {
        enabled: true,
        apps: Some(vec!["logger".into()]),
        ..Default::default()
    });
    assert!(st.available, "{st:?}");
    assert_eq!(st.backend.as_deref(), Some("macos-unified-log"));
    assert!(st.running, "{st:?}");

    let marker = format!("agent-studio-syslog-probe-{}", ulid::Ulid::new());
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut found = None;
    while Instant::now() < deadline && found.is_none() {
        // `log stream` needs a moment to attach; keep emitting until one arrives.
        let _ = std::process::Command::new("/usr/bin/logger")
            .arg(&marker)
            .status();
        tokio::time::sleep(Duration::from_millis(250)).await;
        found = hub
            .snapshot()
            .into_iter()
            .find(|l| l.kind == LogKind::Machine && l.text.contains(&marker));
    }
    let line = found.unwrap_or_else(|| {
        panic!(
            "no parsed machine line with the marker; status {:?}; ring {:?}",
            s.status(),
            hub.snapshot()
        )
    });
    assert_eq!(line.source, "logger");
    assert!(
        line.detail.as_deref().is_some_and(|d| d.contains("pid ")),
        "{line:?}"
    );
    assert!(s.status().running, "still streaming");
    // Every level floor builds a predicate/flag set the real `log` accepts (a grammar
    // error would exit it within milliseconds, with the reason in `status.reason`).
    use agent_studio_scaffold_lib::syslog::SyslogLevel;
    for min_level in [
        SyslogLevel::Error,
        SyslogLevel::Debug,
        SyslogLevel::Info,
        SyslogLevel::Default,
    ] {
        s.set(SyslogFilter {
            enabled: true,
            apps: Some(vec!["logger".into(), r#"we"ird\name"#.into()]),
            subsystem: Some("com.example".into()),
            min_level,
            ..Default::default()
        });
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        let st = s.status();
        assert!(st.running, "{min_level:?} was rejected: {:?}", st.reason);
    }
    // Disabling stops it.
    let st = s.set(SyslogFilter::default());
    assert!(!st.running);
}
