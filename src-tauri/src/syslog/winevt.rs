//! Windows Event Log API glue only; every decision is in `eventlog.rs`. One pull thread per
//! subscription (no child, no shell, no elevation); dropping [`Running`] signals and JOINS it,
//! so every handle is closed on return. The hub is only `try_send`-ed.

use std::collections::HashMap;
use std::ptr::null;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_EVT_MAX_INSERTS_REACHED,
    ERROR_EVT_UNRESOLVED_PARAMETER_INSERT, ERROR_EVT_UNRESOLVED_VALUE_INSERT,
    ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_OPERATION, ERROR_NO_MORE_ITEMS, ERROR_TIMEOUT, HANDLE,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::EventLog::{
    EvtClose, EvtFormatMessage, EvtFormatMessageEvent, EvtNext, EvtOpenPublisherMetadata, EvtQuery,
    EvtQueryChannelPath, EvtQueryReverseDirection, EvtQueryTolerateQueryErrors, EvtRender,
    EvtRenderEventXml, EvtSubscribe, EvtSubscribeToFutureEvents, EVT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, SetEvent, WaitForMultipleObjects, WaitForSingleObject,
};

use super::eventlog;
use super::stream::{Life, Running};
use super::RunningApp;
use crate::logstream::{LineDraft, LogHub};

/// Events taken per `EvtNext`.
const BATCH: usize = 32;
/// The thread also drains on this timeout — a safety net should a signal ever be missed.
const POLL_MS: u32 = 2_000;
/// Publisher metadata handles kept open at most; past it the cache starts over.
const MAX_PUBLISHERS: usize = 256;
/// `syslog_apps`' wall-time budget across all its channels (each gets an equal share).
const RECENT_BUDGET: Duration = Duration::from_secs(2);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn last_error() -> u32 {
    // SAFETY: reads this thread's last-error value; no preconditions.
    unsafe { GetLastError() }
}

/// The system's text for a Win32 / Event Log error code (`std` asks `FormatMessageW`).
fn os_error(code: u32) -> String {
    std::io::Error::from_raw_os_error(code as i32).to_string()
}

/// An owned Event Log handle: `EvtClose` on drop.
struct Evt(EVT_HANDLE);

impl Drop for Evt {
    fn drop(&mut self) {
        if self.0 != 0 {
            // SAFETY: we own this handle and close it exactly once.
            unsafe { EvtClose(self.0) };
        }
    }
}

/// An owned kernel event object: `CloseHandle` on drop.
struct Kernel(HANDLE);

// SAFETY: a kernel handle is a process-wide value; `SetEvent` / `WaitFor*` on it are
// thread-safe, and only `Drop` (once, after every user is gone) closes it.
unsafe impl Send for Kernel {}
// SAFETY: as above — shared use is limited to thread-safe kernel calls.
unsafe impl Sync for Kernel {}

impl Drop for Kernel {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: we own this handle and close it exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn new_event(manual_reset: bool) -> Option<Kernel> {
    // SAFETY: no security attributes, no name; returns null on failure.
    let h = unsafe { CreateEventW(null(), i32::from(manual_reset), 0, null()) };
    (!h.is_null()).then_some(Kernel(h))
}

/// The subscription's stop guard: dropped with its [`Running`].
struct SubStop {
    stop: Arc<Kernel>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for SubStop {
    fn drop(&mut self) {
        // SAFETY: `stop` is a live event handle (we hold an `Arc` to it).
        unsafe { SetEvent(self.stop.0) };
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Subscribe to future events matching `query` (an `eventlog::query_list`), pushing each to
/// `hub`. The subscription exists when this returns, so an event written right after is
/// delivered. Never fails: a refusal yields a dead `Running` carrying why.
pub fn subscribe(query: String, channels: &[String], hub: LogHub) -> Running {
    let (Some(stop), Some(signal)) = (new_event(true), new_event(false)) else {
        let why = eventlog::start_failed(channels, &os_error(last_error()));
        return Running::failed(&hub, why);
    };
    let q = wide(&query);
    // SAFETY: `q` is NUL-terminated and outlives the call; `signal` is a live event; no
    // bookmark, no callback (pull model), local session.
    let sub = unsafe {
        EvtSubscribe(
            0,
            signal.0,
            null(),
            q.as_ptr(),
            0,
            null(),
            None,
            EvtSubscribeToFutureEvents,
        )
    };
    if sub == 0 {
        let why = eventlog::start_failed(channels, &os_error(last_error()));
        return Running::failed(&hub, why);
    }
    let sub = Evt(sub);
    let life = Life::new();
    let stop = Arc::new(stop);
    let (life2, stop2, hub2) = (life.clone(), stop.clone(), hub.clone());
    let spawned = std::thread::Builder::new()
        .name("syslog-eventlog".into())
        .spawn(move || pump(sub, signal, stop2, life2, hub2));
    match spawned {
        Ok(t) => Running::new(
            life,
            SubStop {
                stop,
                thread: Some(t),
            },
        ),
        Err(e) => Running::failed(&hub, eventlog::start_failed(channels, &e.to_string())),
    }
}

enum Drain {
    Idle,
    Stopped,
    Failed(u32),
}

fn stopped(stop: &Kernel) -> bool {
    // SAFETY: `stop` is a live event handle; a zero timeout only polls it.
    unsafe { WaitForSingleObject(stop.0, 0) == WAIT_OBJECT_0 }
}

/// The subscription thread: wait, drain, repeat — until stopped (quiet) or the Event Log
/// fails (one `system` line via [`Life::die`]).
fn pump(sub: Evt, signal: Kernel, stop: Arc<Kernel>, life: Arc<Life>, hub: LogHub) {
    let mut cx = Render::new();
    let waits = [stop.0, signal.0];
    loop {
        // SAFETY: both handles stay open for the whole loop (`signal` is owned here, `stop` by
        // the `Arc` this thread holds).
        let w = unsafe { WaitForMultipleObjects(2, waits.as_ptr(), 0, POLL_MS) };
        if w == WAIT_OBJECT_0 {
            return; // deliberate stop: quiet
        }
        if w != WAIT_OBJECT_0 + 1 && w != WAIT_TIMEOUT {
            life.die(&hub, eventlog::stream_failed(&os_error(last_error())));
            return;
        }
        match drain(&sub, &stop, &mut cx, &hub) {
            Drain::Idle => {}
            Drain::Stopped => return,
            Drain::Failed(code) => {
                life.die(&hub, eventlog::stream_failed(&os_error(code)));
                return;
            }
        }
    }
}

/// Take every pending event; each handle is closed as soon as it is rendered.
fn drain(sub: &Evt, stop: &Kernel, cx: &mut Render, hub: &LogHub) -> Drain {
    loop {
        let mut raw = [0 as EVT_HANDLE; BATCH];
        let mut n = 0u32;
        // SAFETY: `raw` has BATCH writable slots and `n` receives how many were filled.
        let ok = unsafe { EvtNext(sub.0, BATCH as u32, raw.as_mut_ptr(), 0, 0, &mut n) };
        if ok == 0 {
            let code = last_error();
            return match code {
                ERROR_NO_MORE_ITEMS | ERROR_TIMEOUT => Drain::Idle,
                // A pull subscription with nothing pending answers THIS, not NO_MORE_ITEMS
                // (on Windows 11 an idle stream otherwise dies on its first poll with
                // "The operation identifier is not valid").
                ERROR_INVALID_OPERATION if n == 0 => Drain::Idle,
                _ => Drain::Failed(code),
            };
        }
        // Own them all first, so an early return still closes the rest.
        let events: Vec<Evt> = raw[..(n as usize).min(BATCH)]
            .iter()
            .map(|&h| Evt(h))
            .collect();
        for ev in &events {
            if stopped(stop) {
                return Drain::Stopped;
            }
            if let Some(draft) = cx.draft(ev.0) {
                hub.push(draft);
            }
        }
    }
}

/// `EvtRender(EvtRenderEventXml)` into a reusable buffer.
fn render_xml(event: EVT_HANDLE, buf: &mut Vec<u16>) -> Option<String> {
    for _ in 0..2 {
        let (mut used, mut props) = (0u32, 0u32);
        let bytes = (buf.len() * 2) as u32;
        // SAFETY: `buf` is writable for `bytes` bytes; `event` is a live event handle.
        let ok = unsafe {
            EvtRender(
                0,
                event,
                EvtRenderEventXml,
                bytes,
                buf.as_mut_ptr().cast(),
                &mut used,
                &mut props,
            )
        };
        if ok != 0 {
            let chars = (used as usize / 2).min(buf.len());
            let s = String::from_utf16_lossy(&buf[..chars]);
            return Some(s.trim_end_matches('\0').to_string());
        }
        if last_error() != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
        buf.resize((used as usize).div_ceil(2), 0);
    }
    None
}

/// `EvtFormatMessage(EvtFormatMessageEvent)`. An unresolved insert still yields the message
/// (with the placeholder) — the rest of it is worth more than the fallback.
fn format_message(publisher: EVT_HANDLE, event: EVT_HANDLE, buf: &mut Vec<u16>) -> Option<String> {
    for _ in 0..2 {
        let mut used = 0u32;
        // SAFETY: `buf` is writable for `buf.len()` UTF-16 units; both handles are live.
        let ok = unsafe {
            EvtFormatMessage(
                publisher,
                event,
                0,
                0,
                null(),
                EvtFormatMessageEvent,
                buf.len() as u32,
                buf.as_mut_ptr(),
                &mut used,
            )
        };
        let code = if ok != 0 { 0 } else { last_error() };
        match code {
            0
            | ERROR_EVT_UNRESOLVED_VALUE_INSERT
            | ERROR_EVT_UNRESOLVED_PARAMETER_INSERT
            | ERROR_EVT_MAX_INSERTS_REACHED => {
                let chars = (used as usize).min(buf.len());
                return Some(String::from_utf16_lossy(&buf[..chars]));
            }
            ERROR_INSUFFICIENT_BUFFER => buf.resize(used as usize, 0),
            _ => return None,
        }
    }
    None
}

fn open_publisher(name: &str) -> Option<Evt> {
    let w = wide(name);
    // SAFETY: `w` is NUL-terminated and outlives the call; local session, no log file,
    // the thread's locale.
    let h = unsafe { EvtOpenPublisherMetadata(0, w.as_ptr(), null(), 0, 0) };
    (h != 0).then_some(Evt(h))
}

/// Per-thread rendering state: two reusable buffers and the publisher-metadata cache (a
/// provider with no metadata is cached as `None` so it is not re-opened per event).
struct Render {
    xml: Vec<u16>,
    msg: Vec<u16>,
    publishers: HashMap<String, Option<Evt>>,
}

impl Render {
    fn new() -> Render {
        Render {
            xml: vec![0; 8 * 1024],
            msg: vec![0; 4 * 1024],
            publishers: HashMap::new(),
        }
    }

    fn publisher(&mut self, name: &str) -> EVT_HANDLE {
        if name.is_empty() {
            return 0;
        }
        if !self.publishers.contains_key(name) && self.publishers.len() >= MAX_PUBLISHERS {
            self.publishers.clear(); // closes every cached handle
        }
        self.publishers
            .entry(name.to_string())
            .or_insert_with(|| open_publisher(name))
            .as_ref()
            .map_or(0, |e| e.0)
    }

    fn draft(&mut self, event: EVT_HANDLE) -> Option<LineDraft> {
        let xml = render_xml(event, &mut self.xml)?;
        let fields = eventlog::parse_event_xml(&xml)?;
        let publisher = self.publisher(&fields.provider);
        let message = if publisher == 0 {
            None
        } else {
            format_message(publisher, event, &mut self.msg)
        };
        Some(eventlog::draft(&fields, message.as_deref()))
    }
}

/// `syslog_apps` on Windows: providers that wrote to `channels` recently, bounded by
/// [`eventlog::RECENT_MAX_AGE_MS`], [`eventlog::RECENT_MAX_EVENTS`] and [`RECENT_BUDGET`]
/// (split per [`eventlog::channel_share_end`]). An unreadable channel is skipped.
pub fn recent_providers(channels: &[String]) -> Vec<RunningApp> {
    let start = Instant::now();
    let mut names: Vec<String> = Vec::new();
    let mut xml: Vec<u16> = vec![0; 8 * 1024];
    for (i, channel) in channels.iter().enumerate() {
        let deadline = start + eventlog::channel_share_end(RECENT_BUDGET, i, channels.len());
        let q = wide(&eventlog::recent_query(
            channel,
            eventlog::RECENT_MAX_AGE_MS,
        ));
        // SAFETY: `q` is NUL-terminated and outlives the call; a structured query takes no path.
        let h = unsafe {
            EvtQuery(
                0,
                null(),
                q.as_ptr(),
                EvtQueryChannelPath | EvtQueryReverseDirection | EvtQueryTolerateQueryErrors,
            )
        };
        if h == 0 {
            continue;
        }
        let results = Evt(h);
        let mut seen = 0usize;
        while seen < eventlog::RECENT_MAX_EVENTS && Instant::now() < deadline {
            let mut raw = [0 as EVT_HANDLE; 64];
            let mut n = 0u32;
            // SAFETY: `raw` has 64 writable slots and `n` receives how many were filled.
            let ok = unsafe { EvtNext(results.0, 64, raw.as_mut_ptr(), 1_000, 0, &mut n) };
            if ok == 0 {
                break; // ERROR_NO_MORE_ITEMS, or a read error: what we have is the answer
            }
            let events: Vec<Evt> = raw[..(n as usize).min(64)]
                .iter()
                .map(|&e| Evt(e))
                .collect();
            seen += events.len();
            for ev in &events {
                if let Some(f) = render_xml(ev.0, &mut xml)
                    .as_deref()
                    .and_then(eventlog::parse_event_xml)
                {
                    names.push(f.provider);
                }
            }
        }
    }
    eventlog::group_providers(names)
}

/// Test-only: write one event to Application as `source`. An unregistered source is accepted
/// for a standard user, with no message table, so its text is the inserted string.
#[cfg(test)]
pub(crate) fn write_test_event(source: &str, kind: u16, event_id: u32, text: &str) -> bool {
    use std::ptr::null_mut;
    use windows_sys::Win32::System::EventLog::{
        DeregisterEventSource, RegisterEventSourceW, ReportEventW,
    };
    let src = wide(source);
    // SAFETY: local machine (null server); `src` is NUL-terminated.
    let h = unsafe { RegisterEventSourceW(null(), src.as_ptr()) };
    if h.is_null() {
        return false;
    }
    let msg = wide(text);
    let strings = [msg.as_ptr()];
    // SAFETY: `h` is a live event source; one NUL-terminated string; no SID, no raw data.
    let ok = unsafe {
        ReportEventW(
            h,
            kind,
            0,
            event_id,
            null_mut(),
            1,
            0,
            strings.as_ptr(),
            null(),
        )
    };
    // SAFETY: `h` came from RegisterEventSourceW and is released once.
    unsafe { DeregisterEventSource(h) };
    ok != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logstream::{LogKind, LogLevel, NullLogSink};
    use crate::syslog::{Syslog, SyslogFilter, SyslogLevel};
    use windows_sys::Win32::System::EventLog::{EVENTLOG_ERROR_TYPE, EVENTLOG_WARNING_TYPE};

    fn hub() -> LogHub {
        let (hub, task) = LogHub::new(Arc::new(NullLogSink));
        tokio::spawn(task);
        hub
    }

    fn query_for(apps: &[&str], extra: Option<&str>) -> (String, Vec<String>) {
        let f = SyslogFilter {
            enabled: true,
            apps: Some(apps.iter().map(|s| s.to_string()).collect()),
            subsystem: extra.map(str::to_string),
            min_level: SyslogLevel::Debug,
            ..Default::default()
        };
        (
            eventlog::query_list(&f).unwrap(),
            eventlog::channels(f.subsystem.as_deref()),
        )
    }

    /// Read-only (nothing is written): a live subscription, then its drop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_a_subscription_stops_and_joins_its_thread_promptly() {
        let (q, ch) = query_for(&["AgentStudio-never-writes"], None);
        let run = subscribe(q, &ch, hub());
        assert!(run.is_alive(), "{:?}", run.exit_reason());
        // Let the thread reach its wait.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let life = Arc::downgrade(run.life());
        assert_eq!(life.strong_count(), 2, "the handle and the thread");
        let t = Instant::now();
        drop(run);
        let took = t.elapsed();
        assert_eq!(
            life.strong_count(),
            0,
            "the thread is gone (joined), not just signalled"
        );
        assert!(took < Duration::from_millis(500), "stop took {took:?}");
    }

    /// Read-only. Regression: an idle stream must survive its safety-net poll (`EvtNext` with
    /// nothing pending) — before the fix it died at the first poll, ~2 s in, with
    /// "The operation identifier is not valid", and the live test never idled that long.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_idle_subscription_survives_its_poll() {
        let (q, ch) = query_for(&["AgentStudio-never-writes"], None);
        let run = subscribe(q, &ch, hub());
        tokio::time::sleep(Duration::from_millis(u64::from(POLL_MS) * 2 + 500)).await;
        assert!(run.is_alive(), "died idle: {:?}", run.exit_reason());
        assert_eq!(run.exit_reason(), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unknown_extra_channel_is_a_dead_stream_that_says_why() {
        let (q, ch) = query_for(
            &["AgentStudio-never-writes"],
            Some("AgentStudio-No-Such-Channel/Operational"),
        );
        let hub = hub();
        let run = subscribe(q, &ch, hub.clone());
        assert!(!run.is_alive());
        let why = run.exit_reason().unwrap_or_default();
        assert!(
            why.starts_with("System apps log stream could not start")
                && why.contains("AgentStudio-No-Such-Channel/Operational"),
            "{why}"
        );
        eprintln!("reason: {why}");
        for _ in 0..50 {
            if hub
                .snapshot()
                .iter()
                .any(|l| l.kind == LogKind::System && l.text == why)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("no system line for the failure");
    }

    /// Read-only: this machine's recent providers, as `syslog_apps` returns them.
    #[test]
    fn recent_providers_lists_this_machines_event_log_sources() {
        let t = Instant::now();
        let apps = recent_providers(&eventlog::channels(None));
        let took = t.elapsed();
        eprintln!(
            "{} providers in {took:?}: {:?}",
            apps.len(),
            apps.iter()
                .map(|a| (a.name.as_str(), a.is_app))
                .collect::<Vec<_>>()
        );
        assert!(!apps.is_empty(), "Application + System are never empty");
        assert!(apps.iter().all(|a| a.pids.is_empty() && a.path.is_none()));
        let mut sorted = apps.clone();
        crate::syslog::procs::sort_apps(&mut sorted);
        assert_eq!(apps, sorted);
        assert!(took < RECENT_BUDGET + Duration::from_secs(2), "{took:?}");
    }

    /// PowerShell 5.1 writes provider `PowerShell` to the `Windows PowerShell` log (never
    /// Application or System) on every start, so starting one makes the answer known.
    #[test]
    fn the_extra_channels_providers_are_offered_only_when_it_is_named() {
        use crate::spawn::NoWindow;
        let mut ps = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .no_window()
            .spawn()
            .expect("powershell starts");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if ps.try_wait().expect("try_wait").is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = ps.kill();
                let _ = ps.wait();
                panic!("powershell did not exit");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let names = |channels: Vec<String>| -> Vec<String> {
            recent_providers(&channels)
                .into_iter()
                .map(|a| a.name)
                .collect()
        };
        let base = names(eventlog::channels(None));
        assert!(
            !base.iter().any(|n| n == "PowerShell"),
            "Application + System hold no `PowerShell` events here: {base:?}"
        );
        let t = Instant::now();
        let with = names(eventlog::channels(Some("Windows PowerShell")));
        assert!(
            with.iter().any(|n| n == "PowerShell"),
            "the extra channel's provider is offered: {with:?}"
        );
        assert!(
            base.iter().any(|n| with.contains(n)),
            "the two standard channels are still read: {base:?} vs {with:?}"
        );
        assert!(
            t.elapsed() < RECENT_BUDGET + Duration::from_secs(2),
            "{:?}",
            t.elapsed()
        );
        // A channel that does not exist is skipped, not an error.
        let unknown = names(eventlog::channels(Some("Agent Studio/NoSuchChannel")));
        assert!(!unknown.is_empty());
    }

    /// Read-only: this machine's newest events through the SAME rendering the stream uses —
    /// so the `EvtFormatMessage` + publisher-metadata path runs against real message tables
    /// (the live test's unregistered source only ever takes the fallback).
    #[test]
    fn real_events_format_through_their_publishers_message_tables() {
        let mut cx = Render::new();
        let mut formatted = 0usize;
        let mut total = 0usize;
        for channel in eventlog::CHANNELS {
            let q = wide(&eventlog::recent_query(
                channel,
                eventlog::RECENT_MAX_AGE_MS,
            ));
            // SAFETY: as in `recent_providers`.
            let h = unsafe {
                EvtQuery(
                    0,
                    null(),
                    q.as_ptr(),
                    EvtQueryChannelPath | EvtQueryReverseDirection,
                )
            };
            assert_ne!(h, 0, "{channel}: {}", os_error(last_error()));
            let results = Evt(h);
            let mut raw = [0 as EVT_HANDLE; 20];
            let mut n = 0u32;
            // SAFETY: `raw` has 20 writable slots.
            let ok = unsafe { EvtNext(results.0, 20, raw.as_mut_ptr(), 1_000, 0, &mut n) };
            assert_ne!(ok, 0, "{channel}: {}", os_error(last_error()));
            for ev in raw[..n as usize].iter().map(|&e| Evt(e)) {
                let xml = render_xml(ev.0, &mut cx.xml).expect("renders");
                let fields = eventlog::parse_event_xml(&xml).expect("parses");
                let p = cx.publisher(&fields.provider);
                let msg = (p != 0)
                    .then(|| format_message(p, ev.0, &mut cx.msg))
                    .flatten()
                    .map(|m| eventlog::clean_message(&m))
                    .filter(|m| !m.is_empty());
                let d = cx.draft(ev.0).expect("drafts");
                total += 1;
                if let Some(m) = &msg {
                    formatted += 1;
                    let first = m.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                    assert_eq!(d.text, first.trim_end(), "{}", fields.provider);
                }
                assert_eq!(d.source, fields.provider);
                assert_eq!(d.level, eventlog::level_of(fields.level.unwrap_or(4)));
                eprintln!(
                    "{:<45} {:<5?} {}{}",
                    d.source,
                    d.level,
                    d.text.chars().take(80).collect::<String>(),
                    if msg.is_some() { "" } else { "   [fallback]" }
                );
            }
        }
        eprintln!("{formatted}/{total} formatted by their publisher");
        assert!(total > 0);
        assert!(formatted > 0, "no event resolved through a message table");
    }

    async fn wait_line(hub: &LogHub, token: &str) -> crate::logstream::LogLine {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Some(l) = hub.snapshot().into_iter().find(|l| l.text.contains(token)) {
                return l;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no line with {token} arrived");
    }

    /// Writes real records (source `AgentStudio-test-<ulid>`) to this machine's Application log,
    /// leaving a trace in Event Viewer; run it explicitly with `-- --ignored`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "writes records to the real Windows Application event log; run explicitly"]
    async fn a_real_event_arrives_through_the_whole_pipeline() {
        let source = format!("AgentStudio-test-{}", ulid::Ulid::new());
        let (hub, task) = LogHub::new(Arc::new(NullLogSink));
        tokio::spawn(task);
        let syslog = Syslog::with_backend(
            hub.clone(),
            tokio::runtime::Handle::current(),
            None,
            eventlog::backend(),
        );
        let filter = |min_level| SyslogFilter {
            enabled: true,
            apps: Some(vec![source.clone()]),
            min_level,
            ..Default::default()
        };

        // 1. A warning, picked by provider, at the default floor.
        let st = syslog.set(filter(SyslogLevel::Default));
        assert!(st.running, "{:?}", st.reason);
        let a = format!("warn-{}", ulid::Ulid::new());
        assert!(write_test_event(&source, EVENTLOG_WARNING_TYPE, 1000, &a));
        let line = wait_line(&hub, &a).await;
        eprintln!("arrived: {line:?}");
        assert_eq!(line.kind, LogKind::Machine);
        assert_eq!(line.source, source);
        assert_eq!(line.level, LogLevel::Warn);
        assert_eq!(line.text, a);
        let detail = line.detail.unwrap_or_default();
        assert!(
            detail.starts_with("Application · event 1000 · pid "),
            "{detail}"
        );
        assert!(
            detail.ends_with(&std::process::id().to_string()),
            "the writer's pid: {detail}"
        );
        assert!((line.ts_ms - now_ms()).abs() < 60_000, "{}", line.ts_ms);

        // 2. The error floor: the warning written first must not arrive, the error after it does.
        let st = syslog.set(filter(SyslogLevel::Error));
        assert!(st.running, "{:?}", st.reason);
        let b = format!("warn-{}", ulid::Ulid::new());
        let c = format!("error-{}", ulid::Ulid::new());
        assert!(write_test_event(&source, EVENTLOG_WARNING_TYPE, 1001, &b));
        assert!(write_test_event(&source, EVENTLOG_ERROR_TYPE, 1002, &c));
        let line = wait_line(&hub, &c).await;
        assert_eq!(line.level, LogLevel::Error);
        assert!(
            !hub.snapshot().iter().any(|l| l.text.contains(&b)),
            "a warning passed the error floor"
        );

        // 3. Stopped: nothing more arrives.
        let st = syslog.set(SyslogFilter {
            enabled: false,
            ..filter(SyslogLevel::Debug)
        });
        assert!(!st.running);
        assert_eq!(st.reason, None, "a deliberate stop is quiet");
        let d = format!("after-{}", ulid::Ulid::new());
        assert!(write_test_event(&source, EVENTLOG_ERROR_TYPE, 1003, &d));
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert!(
            !hub.snapshot().iter().any(|l| l.text.contains(&d)),
            "a line arrived after the stream was stopped"
        );

        // 4. `syslog_apps` now names the source that just wrote.
        let apps = recent_providers(&eventlog::channels(None));
        let me = apps
            .iter()
            .find(|a| a.name == source)
            .expect("source listed");
        assert!(me.is_app);
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}
