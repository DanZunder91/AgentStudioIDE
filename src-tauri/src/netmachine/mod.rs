//! Whole-computer network connections for the Network view with no OS permission: macOS
//! `nettop`, Linux `/proc/net/*` (own processes named), Windows TCP/UDP tables (no byte counts).
//! Parsers are pure and tested on every OS; only the spawn/read glue is `cfg`-gated.

pub mod names;
pub mod nettop;
pub mod procnet;
pub mod rates;
pub mod rdns;
pub mod wintable;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(windows)]
pub mod windows;

use serde::Serialize;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock};

/// The event carrying one [`MachineSample`] per second while running.
pub const SAMPLE_EVENT: &str = "netmachine://sample";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum MachineProto {
    Tcp4,
    Tcp6,
    Udp4,
    Udp6,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MachineUser {
    #[serde(rename = "self")]
    SelfUser,
    #[serde(rename = "other")]
    Other,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineConn {
    pub proto: MachineProto,
    pub local: String,
    pub remote: Option<String>,
    pub remote_host: Option<String>,
    pub state: String,
    pub bytes_in: Option<u64>,
    pub bytes_out: Option<u64>,
    pub rate_in: Option<f64>,
    pub rate_out: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineApp {
    pub key: String,
    pub name: String,
    pub pid: u32,
    pub user: Option<MachineUser>,
    pub bytes_in: Option<u64>,
    pub bytes_out: Option<u64>,
    pub rate_in: Option<f64>,
    pub rate_out: Option<f64>,
    pub connections: Vec<MachineConn>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineSample {
    pub ts_ms: u64,
    pub apps: Vec<MachineApp>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineStatus {
    pub available: bool,
    pub backend: Option<&'static str>,
    pub reason: Option<String>,
    pub running: bool,
    pub has_bytes: bool,
}

/// A backend's socket before rates and reverse DNS.
#[derive(Clone, Debug, PartialEq)]
pub struct RawConn {
    pub proto: MachineProto,
    pub local: String,
    pub remote: Option<String>,
    /// The remote address to reverse-resolve (`None` for listeners / wildcards).
    pub remote_ip: Option<IpAddr>,
    pub state: String,
    pub bytes_in: Option<u64>,
    pub bytes_out: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawApp {
    pub name: String,
    pub pid: u32,
    pub user: Option<MachineUser>,
    /// Process-lifetime byte totals when the backend has them (nettop's process row).
    pub totals: Option<(u64, u64)>,
    pub conns: Vec<RawConn>,
}

/// One backend sample.
pub struct RawSample {
    pub apps: Vec<RawApp>,
    /// The backend's own sampling interval, when arrival time is not a trustworthy clock.
    pub interval_ms: Option<u64>,
}

/// Where the sampler's output goes (production: the Tauri event; tests: a recorder).
pub trait SampleSink: Send + Sync + 'static {
    fn emit(&self, sample: &MachineSample);
}

/// A running backend: yields the next sample, or an error that ends the run (child exited…).
#[allow(clippy::double_must_use)] // async_trait's #[must_use] futures (clippy ≥ 1.99)
#[async_trait::async_trait]
pub trait Source: Send {
    async fn next(&mut self) -> Result<RawSample, String>;
}

pub type SourceFactory = Arc<dyn Fn() -> Result<Box<dyn Source>, String> + Send + Sync>;

/// What this OS can do, decided once.
#[derive(Clone)]
pub struct Platform {
    pub available: bool,
    pub backend: Option<&'static str>,
    pub reason: Option<String>,
    pub has_bytes: bool,
}

/// The status of a backend that can't run here. Platform-neutral so every OS tests it.
pub fn unavailable(reason: &str) -> MachineStatus {
    MachineStatus {
        available: false,
        backend: None,
        reason: Some(reason.to_string()),
        running: false,
        has_bytes: false,
    }
}

pub const OTHER_OS_REASON: &str = "Whole-computer connections aren't supported on this system yet.";

#[derive(Default)]
struct Inner {
    /// Bumped on every start/stop so a finished task never clobbers a newer run's state.
    generation: u64,
    task: Option<tokio::task::JoinHandle<()>>,
    running: bool,
    error: Option<String>,
}

pub struct NetMachine {
    platform: Platform,
    factory: Option<SourceFactory>,
    sink: Arc<dyn SampleSink>,
    rdns: Arc<rdns::Rdns>,
    /// `pid → executable` for app names ([`names`]). [`NetMachine::new`] keeps the
    /// backend's names; [`NetMachine::for_this_os`] resolves real executables.
    exe_lookup: names::ExeLookup,
    inner: Arc<Mutex<Inner>>,
}

impl NetMachine {
    pub fn new(
        platform: Platform,
        factory: Option<SourceFactory>,
        sink: Arc<dyn SampleSink>,
        resolver: rdns::Resolver,
    ) -> NetMachine {
        NetMachine {
            platform,
            factory,
            sink,
            rdns: Arc::new(rdns::Rdns::new(resolver)),
            exe_lookup: names::no_lookup(),
            inner: Arc::default(),
        }
    }

    /// Name apps from their executables via `lookup` (see [`names`]).
    pub fn with_exe_lookup(mut self, lookup: names::ExeLookup) -> NetMachine {
        self.exe_lookup = lookup;
        self
    }

    /// The real backend for this OS.
    pub fn for_this_os(sink: Arc<dyn SampleSink>) -> NetMachine {
        let (platform, factory) = this_os();
        NetMachine::new(platform, factory, sink, Arc::new(rdns::system_resolver))
            .with_exe_lookup(names::system_lookup())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> MachineStatus {
        let g = self.lock();
        self.status_of(&g)
    }

    fn status_of(&self, g: &Inner) -> MachineStatus {
        if !self.platform.available {
            return MachineStatus {
                backend: self.platform.backend,
                ..unavailable(self.platform.reason.as_deref().unwrap_or(OTHER_OS_REASON))
            };
        }
        MachineStatus {
            available: true,
            backend: self.platform.backend,
            reason: g.error.clone().or_else(|| self.platform.reason.clone()),
            running: g.running,
            has_bytes: self.platform.has_bytes,
        }
    }

    /// Idempotent. Must be called inside a tokio runtime.
    pub fn start(&self) -> MachineStatus {
        let mut g = self.lock();
        if g.running || !self.platform.available {
            return self.status_of(&g);
        }
        let Some(factory) = self.factory.clone() else {
            return self.status_of(&g);
        };
        g.generation += 1;
        let generation = g.generation;
        let mut source = match factory() {
            Ok(s) => s,
            Err(e) => {
                g.error = Some(e);
                return self.status_of(&g);
            }
        };
        g.error = None;
        g.running = true;
        let (sink, rdns, inner) = (self.sink.clone(), self.rdns.clone(), self.inner.clone());
        let mut names = names::NameCache::new(self.exe_lookup.clone());
        g.task = Some(tokio::spawn(async move {
            let mut tracker = rates::RateTracker::default();
            loop {
                match source.next().await {
                    Ok(mut raw) => {
                        // Before the rates: the app key is `name:pid`, so the renamed
                        // name keys the rate history too.
                        names.rename(&mut raw.apps);
                        let sample =
                            tracker.apply(raw.apps, now_ms(), raw.interval_ms, &mut |ip| {
                                rdns.host_of(ip)
                            });
                        sink.emit(&sample);
                    }
                    Err(e) => {
                        let mut g = inner.lock().unwrap_or_else(|p| p.into_inner());
                        if g.generation == generation {
                            g.running = false;
                            g.task = None;
                            g.error = Some(e);
                        }
                        return;
                    }
                }
            }
        }));
        self.status_of(&g)
    }

    /// Idempotent. Aborting the task drops the source, which kills the nettop child
    /// (`kill_on_drop`).
    pub fn stop(&self) -> MachineStatus {
        let mut g = self.lock();
        g.generation += 1;
        if let Some(t) = g.task.take() {
            t.abort();
        }
        g.running = false;
        self.status_of(&g)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(target_os = "macos")]
fn this_os() -> (Platform, Option<SourceFactory>) {
    macos::platform()
}

#[cfg(target_os = "linux")]
fn this_os() -> (Platform, Option<SourceFactory>) {
    linux::platform()
}

#[cfg(windows)]
fn this_os() -> (Platform, Option<SourceFactory>) {
    windows::platform()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn this_os() -> (Platform, Option<SourceFactory>) {
    (
        Platform {
            available: false,
            backend: None,
            reason: Some(OTHER_OS_REASON.to_string()),
            has_bytes: false,
        },
        None,
    )
}

// ---- Tauri glue -------------------------------------------------------------------------------

struct TauriSampleSink(tauri::AppHandle);

impl SampleSink for TauriSampleSink {
    fn emit(&self, sample: &MachineSample) {
        use tauri::Emitter;
        // A failed emit means the webview is gone; the UI stops us when it goes away.
        let _ = self.0.emit(SAMPLE_EVENT, sample);
    }
}

static GLOBAL: OnceLock<NetMachine> = OnceLock::new();

fn global(app: &tauri::AppHandle) -> &'static NetMachine {
    GLOBAL.get_or_init(|| NetMachine::for_this_os(Arc::new(TauriSampleSink(app.clone()))))
}

#[tauri::command]
pub fn netmachine_status(app: tauri::AppHandle) -> MachineStatus {
    global(&app).status()
}

/// `async` so it runs on the Tauri tokio runtime, which the sampler task is spawned onto.
#[tauri::command]
pub async fn netmachine_start(app: tauri::AppHandle) -> MachineStatus {
    global(&app).start()
}

#[tauri::command]
pub fn netmachine_stop(app: tauri::AppHandle) -> MachineStatus {
    global(&app).stop()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_is_a_status_with_the_reason() {
        let s = unavailable(OTHER_OS_REASON);
        assert!(!s.available && !s.running && !s.has_bytes);
        assert_eq!(s.backend, None);
        assert_eq!(s.reason.as_deref(), Some(OTHER_OS_REASON));
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["hasBytes"], false);
        assert_eq!(json["reason"], OTHER_OS_REASON);
    }

    #[test]
    fn this_os_matches_the_platform_matrix() {
        let (p, f) = this_os();
        if cfg!(target_os = "macos") {
            assert_eq!(p.backend, Some("macos-nettop"));
            assert!(p.has_bytes);
        } else if cfg!(target_os = "linux") {
            assert_eq!(p.backend, Some("linux-proc"));
            assert!(p.available && f.is_some());
        } else if cfg!(windows) {
            assert_eq!(p.backend, Some(wintable::BACKEND));
            assert!(p.available && f.is_some());
            // Named, but without byte counts — and it says so.
            assert!(!p.has_bytes);
            assert_eq!(p.reason.as_deref(), Some(wintable::NO_BYTES_REASON));
        } else {
            assert!(!p.available && f.is_none());
            assert_eq!(p.reason.as_deref(), Some(OTHER_OS_REASON));
        }
    }

    #[test]
    fn wire_shape_is_camel_case_with_lowercase_enums() {
        let s = MachineSample {
            ts_ms: 5,
            apps: vec![MachineApp {
                key: "a:1".into(),
                name: "a".into(),
                pid: 1,
                user: Some(MachineUser::SelfUser),
                bytes_in: None,
                bytes_out: Some(2),
                rate_in: None,
                rate_out: Some(1.5),
                connections: vec![MachineConn {
                    proto: MachineProto::Udp6,
                    local: "*:53".into(),
                    remote: None,
                    remote_host: None,
                    state: String::new(),
                    bytes_in: None,
                    bytes_out: None,
                    rate_in: None,
                    rate_out: None,
                }],
            }],
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["tsMs"], 5);
        assert_eq!(v["apps"][0]["user"], "self");
        assert_eq!(v["apps"][0]["rateOut"], 1.5);
        assert!(v["apps"][0]["bytesIn"].is_null());
        assert_eq!(v["apps"][0]["connections"][0]["proto"], "udp6");
        assert!(v["apps"][0]["connections"][0]["remoteHost"].is_null());
        assert_eq!(serde_json::to_value(MachineUser::Other).unwrap(), "other");
    }
}
