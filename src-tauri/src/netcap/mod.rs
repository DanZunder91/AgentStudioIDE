//! The in-process capture proxy behind the Network tab, on a stable `127.0.0.1` port. Every PTY
//! gets [`pty_env`] (proxy vars with the terminal id as userinfo, `NO_PROXY`, CA vars); no system
//! proxy or keychain is touched. [`record`] is the tap for the IDE's own in-process API client.

pub mod body;
pub mod ca;
pub mod client;
pub mod env;
pub mod headers;
pub mod nodewarn;
pub mod prefs;
pub mod proxy;
pub mod record;
pub mod shim;
pub mod store;
pub mod types;
pub mod wsframe;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use rustls::pki_types::CertificateDer;
use tokio::sync::Notify;

pub use types::{
    BypassInfo, ClientProcess, FlowBody, FlowDetail, FlowProto, FlowState, FlowSummary,
    NetcapStatus, PortChange, WsCounts,
};

use ca::Ca;
use prefs::Prefs;
use store::{FlowRecord, Store};

/// The upsert event (payload `FlowSummary[]`).
pub const FLOW_EVENT: &str = "netcap://flow";
/// At most one emit per interval.
pub const EMIT_INTERVAL: Duration = Duration::from_millis(100);
/// The port a first launch tries: memorable, so a hand-configured app (Postman →
/// proxy `127.0.0.1:8877`) is easy to set up. Only the app asks for it
/// ([`NetcapConfig::preferred_port`]); tests never assume a global port is free.
pub const PREFERRED_PORT: u16 = 8877;

/// Where flow batches go: the webview in the app, a recorder in tests.
pub trait FlowSink: Send + Sync + 'static {
    fn emit(&self, flows: &[FlowSummary]);
}

/// The real outlet: `app.emit("netcap://flow", batch)`.
pub struct TauriFlowSink(pub tauri::AppHandle);

impl FlowSink for TauriFlowSink {
    fn emit(&self, flows: &[FlowSummary]) {
        use tauri::Emitter as _;
        if let Err(e) = self.0.emit(FLOW_EVENT, flows) {
            eprintln!("{FLOW_EVENT} emit failed (webview gone?): {e}");
        }
    }
}

pub struct NetcapConfig {
    /// `<app config dir>/netcap` — prefs, CA, bundle. `None` = in-memory CA, no files.
    pub dir: Option<PathBuf>,
    /// Trust anchors for upstream TLS and the bundle. `None` = the app's policy (OS anchors ∪
    /// bundled Mozilla set). Tests pass their own CA — hermetic, no OS store read.
    pub trust_anchors: Option<Vec<CertificateDer<'static>>>,
    /// The app's own environment, for the "a proxy is already set" skip reason.
    pub user_env: Vec<(String, String)>,
    /// The port to try when `prefs.json` has none (or its port is taken) — the app passes
    /// `Some(PREFERRED_PORT)`. `None` = straight to an ephemeral port, which is what every
    /// test wants: parallel proxies must not fight over one well-known port.
    pub preferred_port: Option<u16>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) struct Inner {
    port: u16,
    /// The saved port was taken at startup and this launch moved to `port`.
    port_changed: Option<PortChange>,
    store: Mutex<Store>,
    wake: Notify,
    prefs: Mutex<Prefs>,
    prefs_path: Option<PathBuf>,
    dir: Option<PathBuf>,
    pub(crate) ca: Option<Arc<Ca>>,
    ca_error: Option<String>,
    /// Learned passthrough, keyed by (client executable, host). The executable
    /// is [`passthrough_key`]; `"*"` = every client (our own upstream trust failed).
    passthrough: Mutex<BTreeSet<(String, String)>>,
    pub(crate) resolver: client::Resolver,
    /// Extra executable names treated as allowlisted ([`Netcap::also_decrypt_for`]).
    decrypt_also: Mutex<Vec<String>>,
    trust_override: Option<Vec<CertificateDer<'static>>>,
    anchors: OnceLock<Vec<CertificateDer<'static>>>,
    upstream_tls: OnceLock<Arc<rustls::ClientConfig>>,
    bundle: OnceLock<PathBuf>,
    /// Set when the background [`Inner::prepare_trust`] has finished (bundle refreshed).
    refreshed: OnceLock<()>,
    pub(crate) plain: proxy::PlainClient,
    skipped_reason: Option<String>,
    /// Only the proxy-related vars of `config.user_env` (`*_proxy`, `no_proxy`, `NODE_OPTIONS`,
    /// any case), so [`pty_env`] and [`Netcap::injecting_port`] judge against this start env.
    proxy_env: Vec<(String, String)>,
    /// `<dir>/bin` holding the `curl` shim ([`shim`]); `None` = no shim (no dir, or it could
    /// not be written). On Windows it is for agents' Git Bash only, never a terminal's `PATH`.
    shim_dir: Option<PathBuf>,
    /// The Node warning preload ([`nodewarn`]); `None` = no dir, or it could not be written.
    node_preload: Option<PathBuf>,
}

impl Inner {
    /// Insert a flow (store assigns the id), let `f` fill the rest, wake the emitter.
    pub(crate) fn insert(&self, s: FlowSummary, f: impl FnOnce(&mut FlowRecord)) -> u64 {
        let id = {
            let mut st = lock(&self.store);
            let id = st.insert(s);
            st.update(id, f);
            id
        };
        self.wake.notify_one();
        id
    }

    pub(crate) fn update(&self, id: u64, f: impl FnOnce(&mut FlowRecord)) {
        if lock(&self.store).update(id, f) {
            self.wake.notify_one();
        }
    }

    /// Decrypt is on AND possible (a CA exists).
    pub(crate) fn decrypt_active(&self) -> bool {
        self.ca.is_some() && lock(&self.prefs).decrypt
    }

    pub(crate) fn is_passthrough(&self, client: Option<&ClientProcess>, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        let set = lock(&self.passthrough);
        set.contains(&(passthrough_key(client), host.clone()))
            || set.contains(&("*".to_string(), host))
    }

    /// Stop decrypting `host` for this client (`None` client key = unknown), or for every
    /// client with `all`.
    pub(crate) fn add_passthrough(&self, client: Option<&ClientProcess>, host: &str, all: bool) {
        let key = if all {
            "*".to_string()
        } else {
            passthrough_key(client)
        };
        lock(&self.passthrough).insert((key, host.to_ascii_lowercase()));
    }

    /// Decrypt or tunnel this `CONNECT` (never break a client).
    pub(crate) fn decide(&self, client: Option<&ClientProcess>, host: &str) -> client::Decision {
        if !self.decrypt_active() {
            return client::Decision::Tunnel(None);
        }
        let learned = self.is_passthrough(client, host);
        let extra = lock(&self.decrypt_also).clone();
        let apps = lock(&self.prefs).decrypt_apps.clone();
        client::decide(client, client::RESOLVER_AVAILABLE, learned, &extra, &apps)
    }

    fn anchors(&self) -> &[CertificateDer<'static>] {
        self.anchors.get_or_init(|| {
            self.trust_override
                .clone()
                .unwrap_or_else(ca::system_anchors)
        })
    }

    fn upstream_tls_blocking(&self) -> Arc<rustls::ClientConfig> {
        self.upstream_tls
            .get_or_init(|| {
                let mut roots = rustls::RootCertStore::empty();
                roots.add_parsable_certificates(self.anchors().iter().cloned());
                Arc::new(
                    rustls::ClientConfig::builder()
                        .with_root_certificates(roots)
                        .with_no_client_auth(),
                )
            })
            .clone()
    }

    /// The upstream TLS client config — the app's trust policy. Built once, off the reactor
    /// (loading the OS anchors is blocking I/O).
    pub(crate) async fn upstream_tls(
        self: &Arc<Self>,
    ) -> Result<Arc<rustls::ClientConfig>, String> {
        if let Some(c) = self.upstream_tls.get() {
            return Ok(c.clone());
        }
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.upstream_tls_blocking())
            .await
            .map_err(|e| format!("trust store: {e}"))
    }

    /// Synchronously, from `start`: reuse `ca-bundle.pem` when it is on disk and ends with our
    /// CA (every launch but the first — a file read), else write it now (first launch: loads
    /// the OS anchors, blocking, once). The background [`Self::prepare_trust`] refreshes it.
    fn ensure_bundle_now(&self) {
        let (Some(dir), Some(ca)) = (&self.dir, &self.ca) else {
            return;
        };
        let path = dir.join(ca::BUNDLE_FILE);
        let reusable = std::fs::read_to_string(&path)
            .map(|t| t.ends_with(ca.ca_pem()))
            .unwrap_or(false);
        if reusable {
            let _ = self.bundle.set(path);
            return;
        }
        match ca::write_bundle(dir, self.anchors(), ca) {
            Ok(p) => {
                let _ = self.bundle.set(p);
            }
            Err(e) => eprintln!("netcap: CA bundle not written: {e}"),
        }
    }

    /// Background, once per start: anchors → upstream config → `ca-bundle.pem` (refreshed
    /// atomically in place, so the path handed to PTYs never dangles).
    fn prepare_trust(&self) {
        self.upstream_tls_blocking();
        if let (Some(dir), Some(ca)) = (&self.dir, &self.ca) {
            match ca::write_bundle(dir, self.anchors(), ca) {
                Ok(p) => {
                    let _ = self.bundle.set(p);
                }
                Err(e) => eprintln!("netcap: CA bundle not written: {e}"),
            }
        }
        let _ = self.refreshed.set(());
    }
}

/// The executable half of a passthrough key: the path when known, else the name, else `""`.
fn passthrough_key(client: Option<&ClientProcess>) -> String {
    client
        .map(|c| c.path.clone().unwrap_or_else(|| c.name.clone()))
        .unwrap_or_default()
}

async fn emit_loop(inner: Arc<Inner>, sink: Arc<dyn FlowSink>) {
    loop {
        inner.wake.notified().await;
        let batch = lock(&inner.store).take_dirty();
        if !batch.is_empty() {
            sink.emit(&batch);
        }
        // Updates during the sleep leave a Notify permit, so nothing is lost — they go out
        // in the next batch, ≤ 1 emit per interval.
        tokio::time::sleep(EMIT_INTERVAL).await;
    }
}

fn bind_loopback(port: u16) -> std::io::Result<std::net::TcpListener> {
    std::net::TcpListener::bind(("127.0.0.1", port))
}

/// Probe before binding a fixed port: on macOS `SO_REUSEADDR` lets a `127.0.0.1` bind succeed
/// over another process's wildcard listener, silently stealing its loopback traffic.
fn someone_listens_on(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// This launch's listener: saved port, else `preferred`, else ephemeral. Any bind error counts
/// as "taken" (the proxy must start). Moving off a saved port returns a `PortChange` for the UI;
/// a first launch is not a change.
pub fn bind_listener(
    saved: Option<u16>,
    preferred: Option<u16>,
) -> std::io::Result<(std::net::TcpListener, Option<PortChange>)> {
    let mut tried = Vec::new();
    for p in [saved, preferred].into_iter().flatten() {
        // Port 0 in the file is not a port anyone configured; never treat it as one.
        if p == 0 || tried.contains(&p) {
            continue;
        }
        tried.push(p);
        if someone_listens_on(p) {
            continue;
        }
        if let Ok(l) = bind_loopback(p) {
            let changed = saved
                .filter(|s| *s != 0 && *s != p)
                .map(|from| PortChange { from, to: p });
            return Ok((l, changed));
        }
    }
    let l = bind_loopback(0)?;
    let to = l.local_addr()?.port();
    let changed = saved
        .filter(|s| *s != 0)
        .map(|from| PortChange { from, to });
    Ok((l, changed))
}

/// A running capture proxy. Cheap to clone.
#[derive(Clone)]
pub struct Netcap {
    inner: Arc<Inner>,
}

impl Netcap {
    /// Bind the loopback port ([`bind_listener`]) and start serving. Must be called
    /// inside a tokio runtime context. The port is known when this returns, so PTYs spawned
    /// right after get the env.
    pub fn start(config: NetcapConfig, sink: Arc<dyn FlowSink>) -> std::io::Result<Netcap> {
        crate::tls::install_crypto_provider();
        let prefs_path = config.dir.as_ref().map(|d| d.join(prefs::FILE_NAME));
        let mut prefs = prefs_path.as_deref().map(prefs::load).unwrap_or_default();

        let (std_listener, port_changed) = bind_listener(prefs.port, config.preferred_port)?;
        std_listener.set_nonblocking(true)?;
        let port = std_listener.local_addr()?.port();
        let listener = tokio::net::TcpListener::from_std(std_listener)?;
        if prefs.port != Some(port) {
            prefs.port = Some(port);
            if let Some(path) = &prefs_path {
                if let Err(e) = prefs::save(path, &prefs) {
                    // Capture works; only the next launch's port stability is lost.
                    eprintln!("netcap: proxy port not saved: {e}");
                }
            }
        }
        let ca = match &config.dir {
            Some(d) => Ca::load_or_create(d),
            None => Ca::generate(),
        };
        let (ca, ca_error) = match ca {
            Ok(c) => (Some(Arc::new(c)), None),
            Err(e) => {
                eprintln!("netcap: decrypt unavailable: {e}");
                (None, Some(e))
            }
        };
        let shim_dir = config.dir.as_deref().and_then(shim::ensure);
        let node_preload = config.dir.as_deref().and_then(nodewarn::ensure);
        let inner = Arc::new(Inner {
            port,
            port_changed,
            store: Mutex::new(Store::default()),
            wake: Notify::new(),
            prefs: Mutex::new(prefs),
            prefs_path,
            dir: config.dir,
            ca,
            ca_error,
            passthrough: Mutex::new(BTreeSet::new()),
            resolver: client::Resolver::default(),
            decrypt_also: Mutex::new(Vec::new()),
            trust_override: config.trust_anchors,
            anchors: OnceLock::new(),
            upstream_tls: OnceLock::new(),
            bundle: OnceLock::new(),
            refreshed: OnceLock::new(),
            plain: proxy::plain_client(),
            skipped_reason: env::skipped_reason(&config.user_env),
            proxy_env: env::proxy_related(&config.user_env),
            shim_dir,
            node_preload,
        });
        // The CA bundle exists BEFORE this returns, so no PTY — not
        // even a terminal restored at boot — is spawned without the CA variables.
        inner.ensure_bundle_now();
        tokio::spawn(proxy::serve(inner.clone(), listener));
        tokio::spawn(emit_loop(inner.clone(), sink));
        let bg = inner.clone();
        tokio::task::spawn_blocking(move || bg.prepare_trust());
        Ok(Netcap { inner })
    }

    pub fn port(&self) -> u16 {
        self.inner.port
    }

    /// The port this proxy is injecting into new PTYs right now — `None` when [`pty_env`]
    /// would hand out nothing (capture off, or the user's own proxy wins). What
    /// `DevApp.captured` is judged against (`procscan::capture`).
    pub fn injecting_port(&self) -> Option<u16> {
        let enabled = lock(&self.inner.prefs).enabled;
        (enabled && env::user_proxy_var(&self.inner.proxy_env).is_none()).then_some(self.inner.port)
    }

    pub fn ca_pem(&self) -> Option<String> {
        self.inner.ca.as_ref().map(|c| c.ca_pem().to_string())
    }

    /// `ca-bundle.pem` — written (or reused) before [`Netcap::start`] returns when there is a
    /// config dir.
    pub fn ca_bundle_path(&self) -> Option<PathBuf> {
        self.inner.bundle.get().cloned()
    }

    /// Resolves once the background trust preparation has finished: upstream config built
    /// and (with a dir) the bundle refreshed. (The bundle itself exists from `start` on.)
    pub async fn ready(&self) {
        let _ = self.inner.upstream_tls().await;
        for _ in 0..500 {
            if self.inner.refreshed.get().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub fn status(&self) -> NetcapStatus {
        let prefs = lock(&self.inner.prefs).clone();
        NetcapStatus {
            running: true,
            port: Some(self.inner.port),
            enabled: prefs.enabled,
            decrypt: prefs.decrypt && self.inner.ca.is_some(),
            ca_path: match (&self.inner.dir, &self.inner.ca) {
                (Some(d), Some(_)) => Some(d.join(ca::CA_FILE).to_string_lossy().into_owned()),
                _ => None,
            },
            skipped_reason: self.inner.skipped_reason.clone(),
            passthrough_hosts: lock(&self.inner.passthrough)
                .iter()
                .map(|(_, h)| h.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            flow_count: lock(&self.inner.store).len(),
            decrypt_apps: prefs.decrypt_apps,
            port_changed: self.inner.port_changed,
            strict_agent_capture: prefs.strict_agent_capture,
        }
    }

    /// `strictAgentCapture` on/off (persisted). NEW terminals get `AGENTSTUDIO_PROXY_STRICT`
    /// accordingly; a running terminal keeps the value it was spawned with.
    pub fn set_strict(&self, on: bool) -> NetcapStatus {
        let snapshot = {
            let mut p = lock(&self.inner.prefs);
            p.strict_agent_capture = on;
            p.clone()
        };
        self.save_prefs(&snapshot);
        self.status()
    }

    /// The `curl` shim's directory, when one was written ([`shim::ensure`]).
    pub fn shim_dir(&self) -> Option<PathBuf> {
        self.inner.shim_dir.clone()
    }

    /// Record a bypass row. `neutralized` is decided here: the detector knows if the shim could
    /// undo it (`shim_covers`), this proxy whether the shim is installed and strict is on.
    pub fn record_bypass(&self, b: BypassInput) -> u64 {
        let strict = lock(&self.inner.prefs).strict_agent_capture;
        let neutralized = b.shim_covers && strict && self.inner.shim_dir.is_some();
        let method = b.curl.as_ref().map(|c| c.method.as_str());
        let url = b.curl.as_ref().map(|c| c.url.as_str());
        let mut s = FlowSummary::bypassed(&b.command, method, url);
        if let Some(ts) = b.ts_ms.filter(|t| *t > 0) {
            s.started_ms = ts as u64;
        }
        s.terminal_id = b.terminal_id;
        let what = b.reasons.join(", ");
        s.note = Some(if neutralized {
            format!(
                "bypass neutralised ({what}): strict agent capture ran this curl through the \
                 proxy — the request is its own row"
            )
        } else {
            format!("not captured: this agent command bypassed the proxy ({what})")
        });
        if let Some(info) = s.bypass.as_mut() {
            info.agent_id = b.agent_id;
            info.tool_use_id = b.tool_use_id;
            info.reasons = b.reasons;
            info.neutralized = neutralized;
        }
        self.inner.insert(s, |_| {})
    }

    /// Per-app decrypt opt-in (`on` = `app` trusts our CA); persisted, live from the next
    /// `CONNECT`. `app` is trimmed; empty or `/`-containing names are refused.
    pub fn set_app_decrypt(&self, app: &str, on: bool) -> Result<NetcapStatus, String> {
        let app = app.trim();
        if !client::valid_app_entry(app) {
            return Err(format!("not an app name: {app:?}"));
        }
        let snapshot = {
            let mut p = lock(&self.inner.prefs);
            let had = p.decrypt_apps.iter().any(|a| a == app);
            if on && !had {
                p.decrypt_apps.push(app.to_string());
            } else if !on {
                p.decrypt_apps.retain(|a| a != app);
            }
            p.clone()
        };
        self.save_prefs(&snapshot);
        Ok(self.status())
    }

    fn save_prefs(&self, snapshot: &Prefs) {
        if let Some(path) = &self.inner.prefs_path {
            if let Err(e) = prefs::save(path, snapshot) {
                // The change is live either way; only its survival across a restart failed.
                eprintln!("netcap: prefs not saved: {e}");
            }
        }
    }

    /// Flip the live toggles and persist them. `enabled` affects NEW terminals only.
    pub fn set(
        &self,
        enabled: Option<bool>,
        decrypt: Option<bool>,
    ) -> Result<NetcapStatus, String> {
        if decrypt == Some(true) && self.inner.ca.is_none() {
            return Err(format!(
                "decrypt unavailable: {}",
                self.inner.ca_error.as_deref().unwrap_or("no CA")
            ));
        }
        let snapshot = {
            let mut p = lock(&self.inner.prefs);
            if let Some(e) = enabled {
                p.enabled = e;
            }
            if let Some(d) = decrypt {
                p.decrypt = d;
            }
            p.clone()
        };
        self.save_prefs(&snapshot);
        Ok(self.status())
    }

    pub fn snapshot(&self) -> Vec<FlowSummary> {
        lock(&self.inner.store).snapshot()
    }

    pub fn flow(&self, id: u64) -> Result<FlowDetail, String> {
        let st = lock(&self.inner.store);
        let r = st.get(id).ok_or_else(|| "not-found".to_string())?;
        Ok(FlowDetail {
            summary: r.summary.clone(),
            request_headers: r.request_headers.clone(),
            response_headers: r.response_headers.clone(),
            response_trailers: r.response_trailers.clone(),
            request_body: r.request_body.as_ref().map(|c| body::to_flow_body(c, None)),
            response_body: r
                .response_body
                .as_ref()
                .map(|c| body::to_flow_body(c, r.response_encoding.as_deref())),
        })
    }

    pub fn clear(&self) {
        lock(&self.inner.store).clear();
    }

    /// Treat these executable names as if they were on the decrypt allowlist
    /// ([`client::reads_injected_ca`]). The test seam: an in-process test client is the test
    /// binary, which is (correctly) not on the list. The app never calls it.
    pub fn also_decrypt_for(&self, names: &[&str]) {
        *lock(&self.inner.decrypt_also) = names.iter().map(|n| n.to_string()).collect();
    }

    /// [`pty_env`] for this instance with an explicit user environment (tests).
    pub fn pty_env_with(
        &self,
        terminal_id: &str,
        user_env: &[(String, String)],
    ) -> Vec<(String, String)> {
        let enabled = lock(&self.inner.prefs).enabled;
        // Never hand out a CA path whose file is missing: a client
        // told to trust a nonexistent bundle fails EVERY TLS connection, decrypted or not.
        let bundle = self.inner.bundle.get().filter(|p| p.is_file());
        let strict = lock(&self.inner.prefs).strict_agent_capture;
        // The PATH the PTY inherits (the supervisor never clears the env) — the shim goes in
        // front of it. A read, never a write (a global env write races parallel tests).
        let base_path = user_env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
            .or_else(|| std::env::var("PATH").ok());
        // Never name a preload whose file is missing: `--require` of a missing file stops Node.
        let node_preload = self.inner.node_preload.as_deref().filter(|p| p.is_file());
        env::compute(
            env::EnvInputs {
                port: Some(self.inner.port),
                enabled,
                ca_bundle: bundle.map(PathBuf::as_path),
                shim_dir: self.inner.shim_dir.as_deref(),
                base_path: base_path.as_deref(),
                strict,
                node_preload,
                windows: cfg!(windows),
            },
            terminal_id,
            user_env,
        )
    }
}

/// A detected bypass, as the supervisor hands it to [`Netcap::record_bypass`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BypassInput {
    pub terminal_id: Option<String>,
    pub agent_id: Option<String>,
    pub tool_use_id: Option<String>,
    /// The transcript's timestamp of the call; `None` = now.
    pub ts_ms: Option<i64>,
    pub command: String,
    pub reasons: Vec<String>,
    /// The detector's verdict that the curl shim undoes every reason.
    pub shim_covers: bool,
    pub curl: Option<crate::logstream::bypass::CurlTarget>,
}

/// [`Netcap::record_bypass`] on the app's proxy; a no-op when it is not running.
pub fn record_bypass(b: BypassInput) {
    if let Some(nc) = GLOBAL.get() {
        nc.record_bypass(b);
    }
}

/// The app's one proxy.
static GLOBAL: OnceLock<Netcap> = OnceLock::new();
/// Why it is not running, when it failed to start.
static START_ERROR: OnceLock<String> = OnceLock::new();

/// The process environment, lossily (a non-UTF-8 variable must not panic a PTY spawn).
fn process_env() -> Vec<(String, String)> {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// Start the app's proxy. Called once from `setup`, before any PTY is spawned. A failure is
/// logged and reported by `netcap_status`; the app runs on without capture.
pub fn start(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let dir = match app.path().app_config_dir() {
        Ok(d) => d.join("netcap"),
        Err(_) => crate::agent::claude::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("agent-studio")
            .join("netcap"),
    };
    let config = NetcapConfig {
        dir: Some(dir),
        trust_anchors: None,
        user_env: process_env(),
        preferred_port: Some(PREFERRED_PORT),
    };
    let sink = Arc::new(TauriFlowSink(app.clone()));
    let rt = tauri::async_runtime::handle();
    let _guard = rt.inner().enter();
    match Netcap::start(config, sink) {
        Ok(nc) => {
            let _ = install(nc);
        }
        Err(e) => {
            eprintln!("netcap: capture proxy could not start: {e}");
            let _ = START_ERROR.set(format!("capture proxy could not start: {e}"));
        }
    }
}

/// The env every IDE PTY gets so its traffic flows through the proxy. Empty when the proxy is
/// down, capture is off, or the user's own environment already names a proxy.
pub fn pty_env(terminal_id: &str) -> Vec<(String, String)> {
    match GLOBAL.get() {
        // The instance's start-time env (`start` passes the process env), not a fresh read:
        // the same answer in the app, and a test that installs its own proxy is hermetic.
        Some(nc) => nc.pty_env_with(terminal_id, &nc.inner.proxy_env),
        None => Vec::new(),
    }
}

/// [`Netcap::injecting_port`] of the app's proxy; `None` when it is not running.
pub fn injecting_port() -> Option<u16> {
    GLOBAL.get().and_then(Netcap::injecting_port)
}

/// Make `nc` the app's one proxy (what [`start`] does). Integration tests that need the
/// supervisor's PTYs to get the capture env install their own (`user_env: vec![]`, an
/// ephemeral port). Returns it back when one is already installed.
pub fn install(nc: Netcap) -> Result<(), Netcap> {
    GLOBAL.set(nc)
}

fn stopped_status() -> NetcapStatus {
    let p = Prefs::default();
    NetcapStatus {
        running: false,
        port: None,
        enabled: p.enabled,
        decrypt: false,
        ca_path: None,
        skipped_reason: START_ERROR.get().cloned(),
        passthrough_hosts: Vec::new(),
        flow_count: 0,
        decrypt_apps: Vec::new(),
        port_changed: None,
        strict_agent_capture: p.strict_agent_capture,
    }
}

#[tauri::command]
pub fn netcap_status() -> NetcapStatus {
    GLOBAL.get().map_or_else(stopped_status, Netcap::status)
}

/// `invoke('netcap_set', { enabled?, decrypt?, strictAgentCapture? })` — only the keys given
/// change (`netcapIpc.ts` `netcapSet`).
#[tauri::command]
pub fn netcap_set(
    enabled: Option<bool>,
    decrypt: Option<bool>,
    strict_agent_capture: Option<bool>,
) -> Result<NetcapStatus, String> {
    match GLOBAL.get() {
        Some(nc) => {
            let st = nc.set(enabled, decrypt)?;
            Ok(match strict_agent_capture {
                Some(on) => nc.set_strict(on),
                None => st,
            })
        }
        None => Ok(stopped_status()),
    }
}

/// The per-app decrypt opt-in — `invoke('netcap_set_app_decrypt', { app, on })`.
#[tauri::command]
pub fn netcap_set_app_decrypt(app: String, on: bool) -> Result<NetcapStatus, String> {
    match GLOBAL.get() {
        Some(nc) => nc.set_app_decrypt(&app, on),
        // Same answer as `netcap_set`: the "not running" status (its `skippedReason` says why).
        None => Ok(stopped_status()),
    }
}

/// `invoke('netcap_set_strict', { on })` — the `strictAgentCapture` toggle (NEW terminals).
#[tauri::command]
pub fn netcap_set_strict(on: bool) -> NetcapStatus {
    match GLOBAL.get() {
        Some(nc) => nc.set_strict(on),
        None => stopped_status(),
    }
}

#[tauri::command]
pub fn netcap_snapshot() -> Vec<FlowSummary> {
    GLOBAL.get().map(Netcap::snapshot).unwrap_or_default()
}

#[tauri::command]
pub fn netcap_flow(id: u64) -> Result<FlowDetail, String> {
    GLOBAL
        .get()
        .ok_or_else(|| "not-found".to_string())?
        .flow(id)
}

#[tauri::command]
pub fn netcap_clear() {
    if let Some(nc) = GLOBAL.get() {
        nc.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(Instant, Vec<FlowSummary>)>>);
    impl FlowSink for Recorder {
        fn emit(&self, flows: &[FlowSummary]) {
            lock(&self.0).push((Instant::now(), flows.to_vec()));
        }
    }

    fn start(rec: Arc<Recorder>) -> Netcap {
        Netcap::start(
            NetcapConfig {
                dir: None,
                trust_anchors: Some(Vec::new()),
                user_env: Vec::new(),
                preferred_port: None,
            },
            rec,
        )
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn emits_are_batched_to_one_per_interval_and_lose_nothing() {
        let rec = Arc::new(Recorder::default());
        let nc = start(rec.clone());
        let t0 = Instant::now();
        let mut ids = Vec::new();
        while t0.elapsed() < Duration::from_millis(450) {
            ids.push(nc.inner.insert(
                FlowSummary::pending(FlowProto::Http, "GET", "h", 80, "/"),
                |_| {},
            ));
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        let got = lock(&rec.0).clone();
        assert!(
            got.len() >= 3,
            "expected several batches, got {}",
            got.len()
        );
        assert!(
            got.len() <= 7,
            "{} emits in ~0.7 s — batching is broken",
            got.len()
        );
        for w in got.windows(2) {
            let gap = w[1].0 - w[0].0;
            assert!(gap >= Duration::from_millis(95), "two emits {gap:?} apart");
        }
        let mut seen: Vec<u64> = got
            .iter()
            .flat_map(|(_, b)| b.iter().map(|f| f.id))
            .collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen, ids, "every inserted flow must be emitted");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_update_re_emits_the_same_id_as_an_upsert() {
        let rec = Arc::new(Recorder::default());
        let nc = start(rec.clone());
        let id = nc.inner.insert(
            FlowSummary::pending(FlowProto::Http, "GET", "h", 80, "/"),
            |_| {},
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        nc.inner.update(id, |r| r.summary.state = FlowState::Done);
        tokio::time::sleep(Duration::from_millis(250)).await;
        let got = lock(&rec.0).clone();
        let states: Vec<FlowState> = got
            .iter()
            .flat_map(|(_, b)| b.iter().filter(|f| f.id == id).map(|f| f.state))
            .collect();
        assert_eq!(states, [FlowState::Pending, FlowState::Done]);
    }

    /// The shim lands in the config dir and first on new PTYs' `PATH`, the toggle persists, and a
    /// bypass row is neutralised only when strict is on and the shim could undo it.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn strict_capture_shim_env_toggle_and_bypass_rows() {
        let dir = std::env::temp_dir().join(format!("netcap-strict-{}", ulid::Ulid::new()));
        let cfg = || NetcapConfig {
            dir: Some(dir.clone()),
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        };
        let rec = Arc::new(Recorder::default());
        let nc = Netcap::start(cfg(), rec.clone()).unwrap();
        let shim = nc.shim_dir().expect("a config dir gets the shim");
        assert_eq!(shim, dir.join("bin"));
        assert!(shim.join("curl").is_file());
        assert!(nc.status().strict_agent_capture, "default on");

        let user = [("PATH".to_string(), "/usr/bin:/bin".to_string())];
        let env = nc.pty_env_with("t1", &user);
        let get = |env: &[(String, String)], k: &str| {
            env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone())
        };
        assert_eq!(
            get(&env, "PATH"),
            Some(format!("{}:/usr/bin:/bin", shim.display()))
        );
        assert_eq!(get(&env, env::STRICT_VAR).as_deref(), Some("1"));
        assert_eq!(get(&env, env::PROXY_URL_VAR), get(&env, "HTTP_PROXY"));

        let covered = |ts| BypassInput {
            terminal_id: Some("t1".into()),
            agent_id: Some("agent-1".into()),
            tool_use_id: Some("toolu_1".into()),
            ts_ms: ts,
            command: "curl -s --noproxy '*' http://127.0.0.1:3000/x".into(),
            reasons: vec!["--noproxy".into()],
            shim_covers: true,
            curl: crate::logstream::bypass::detect("curl -s --noproxy '*' http://127.0.0.1:3000/x")
                .unwrap()
                .curl,
        };
        let id = nc.record_bypass(covered(Some(1_790_589_660_000)));
        let row = nc.flow(id).unwrap().summary;
        assert_eq!(row.proto, FlowProto::Bypass);
        assert_eq!(row.started_ms, 1_790_589_660_000, "the call's own time");
        assert_eq!(row.terminal_id.as_deref(), Some("t1"));
        assert_eq!(
            (
                row.method.as_str(),
                row.host.as_str(),
                row.port,
                row.path.as_str()
            ),
            ("GET", "127.0.0.1", 3000, "/x")
        );
        let info = row.bypass.clone().unwrap();
        assert!(info.neutralized);
        assert_eq!(info.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(info.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(info.url.as_deref(), Some("http://127.0.0.1:3000/x"));
        assert_eq!(
            info.command,
            "curl -s --noproxy '*' http://127.0.0.1:3000/x"
        );

        // Strict off: persisted, new PTYs get 0, and the same bypass is NOT neutralised.
        let st = nc.set_strict(false);
        assert!(!st.strict_agent_capture);
        assert_eq!(
            get(&nc.pty_env_with("t1", &user), env::STRICT_VAR).as_deref(),
            Some("0")
        );
        let id = nc.record_bypass(covered(None));
        let row = nc.flow(id).unwrap().summary;
        assert!(!row.bypass.unwrap().neutralized);
        assert!(row.note.unwrap().starts_with("not captured"));
        let again = Netcap::start(cfg(), Arc::new(Recorder::default())).unwrap();
        assert!(!again.status().strict_agent_capture, "survives a restart");
        nc.set_strict(true);
        // A python bypass is never neutralised, strict or not.
        let id = nc.record_bypass(BypassInput {
            shim_covers: false,
            curl: None,
            command: "NO_PROXY='*' python3 x.py".into(),
            reasons: vec!["NO_PROXY=*".into()],
            ..covered(None)
        });
        let row = nc.flow(id).unwrap().summary;
        assert_eq!((row.host.as_str(), row.port), ("", 0));
        assert!(!row.bypass.unwrap().neutralized);
        // And it is emitted like any flow (the UI's netcap://flow upsert).
        tokio::time::sleep(Duration::from_millis(250)).await;
        let emitted: Vec<u64> = lock(&rec.0)
            .iter()
            .flat_map(|(_, b)| b.iter().map(|f| f.id))
            .collect();
        assert!(emitted.contains(&id), "{emitted:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn prefs_persist_and_disable_injection() {
        let dir = std::env::temp_dir().join(format!("netcap-mod-{}", ulid::Ulid::new()));
        let cfg = || NetcapConfig {
            dir: Some(dir.clone()),
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        };
        let nc = Netcap::start(cfg(), Arc::new(Recorder::default())).unwrap();
        nc.ready().await;
        let env = nc.pty_env_with("t1", &[]);
        let url = format!("http://t-t1:x@127.0.0.1:{}", nc.port());
        assert!(env.contains(&("HTTPS_PROXY".into(), url)));
        let bundle = nc.ca_bundle_path().expect("bundle written");
        assert!(env.contains(&(
            "NODE_EXTRA_CA_CERTS".into(),
            bundle.to_string_lossy().into()
        )));
        assert_eq!(nc.injecting_port(), Some(nc.port()));

        let st = nc.set(Some(false), Some(true)).unwrap();
        assert!(!st.enabled && st.decrypt);
        assert!(
            nc.pty_env_with("t1", &[]).is_empty(),
            "disabled ⇒ nothing injected"
        );
        assert_eq!(
            nc.injecting_port(),
            None,
            "disabled ⇒ no app can be captured"
        );

        let again = Netcap::start(cfg(), Arc::new(Recorder::default())).unwrap();
        let st = again.status();
        assert!(!st.enabled && st.decrypt, "prefs must survive a restart");
        assert_eq!(
            st.ca_path,
            Some(dir.join("ca.pem").to_string_lossy().into_owned())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Right after `start` (no `ready()`), the CA vars name an existing file, so boot-restored
    /// terminals get them; if the file vanishes, `pty_env` stops naming it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_ca_bundle_exists_before_start_returns_and_pty_env_never_names_a_missing_file() {
        let dir = std::env::temp_dir().join(format!("netcap-ca-first-{}", ulid::Ulid::new()));
        let cfg = || NetcapConfig {
            dir: Some(dir.clone()),
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        };
        let ca_values = |env: &[(String, String)]| -> Vec<String> {
            env::CA_VARS
                .iter()
                .filter_map(|k| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
                .collect()
        };

        for launch in ["first launch (generated)", "relaunch (loaded)"] {
            let nc = Netcap::start(cfg(), Arc::new(Recorder::default())).unwrap();
            let env = nc.pty_env_with("t1", &[]);
            let vals = ca_values(&env);
            assert_eq!(vals.len(), env::CA_VARS.len(), "{launch}: {env:?}");
            for v in &vals {
                let text = std::fs::read_to_string(v)
                    .unwrap_or_else(|e| panic!("{launch}: {v} must exist: {e}"));
                assert!(text.ends_with(&nc.ca_pem().unwrap()), "{launch}: our CA");
            }
            // Its background refresh must not race the deletion below.
            nc.ready().await;
        }

        let nc = Netcap::start(cfg(), Arc::new(Recorder::default())).unwrap();
        nc.ready().await; // let the background refresh finish before deleting under it
        std::fs::remove_file(dir.join(ca::BUNDLE_FILE)).unwrap();
        let env = nc.pty_env_with("t1", &[]);
        assert!(
            ca_values(&env).is_empty(),
            "a missing bundle must not be handed out: {env:?}"
        );
        assert!(
            env.iter().any(|(k, _)| k == "HTTPS_PROXY"),
            "capture itself still works"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_user_proxy_is_reported_and_never_overridden() {
        let nc = Netcap::start(
            NetcapConfig {
                dir: None,
                trust_anchors: Some(Vec::new()),
                user_env: vec![("HTTPS_PROXY".into(), "http://corp:3128".into())],
                preferred_port: None,
            },
            Arc::new(Recorder::default()),
        )
        .unwrap();
        assert_eq!(
            nc.status().skipped_reason.as_deref(),
            Some("HTTPS_PROXY already set in your environment")
        );
        let user = [("HTTPS_PROXY".to_string(), "http://corp:3128".to_string())];
        assert!(nc.pty_env_with("t", &user).is_empty());
        assert_eq!(
            nc.injecting_port(),
            None,
            "the user's proxy wins ⇒ nothing injected"
        );
        assert!(nc.pty_env_with("t", &nc.inner.proxy_env).is_empty());
    }

    fn dir_cfg(dir: &std::path::Path, preferred_port: Option<u16>) -> NetcapConfig {
        NetcapConfig {
            dir: Some(dir.to_path_buf()),
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port,
        }
    }

    fn saved_port(dir: &std::path::Path) -> Option<u16> {
        prefs::load(&dir.join(prefs::FILE_NAME)).port
    }

    /// One app launch: a runtime of its own, so dropping it stops the accept loop and frees
    /// the port exactly as quitting the app does (a `Netcap` has no stop — the app's lives as
    /// long as the process).
    fn launch<T>(cfg: NetcapConfig, f: impl FnOnce(&Netcap) -> T) -> T {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let _g = rt.enter();
        let nc = Netcap::start(cfg, Arc::new(Recorder::default())).unwrap();
        let out = f(&nc);
        rt.block_on(nc.ready());
        out
    }

    /// The port a launch bound is saved, and the next launch binds the same one — so an
    /// app configured by hand keeps working across restarts. `pty_env` names the live port.
    #[test]
    fn a_second_start_reuses_the_saved_port() {
        let dir = std::env::temp_dir().join(format!("netcap-port-{}", ulid::Ulid::new()));
        let first = launch(dir_cfg(&dir, None), |nc| {
            assert_eq!(
                nc.status().port_changed,
                None,
                "a first launch is not a change"
            );
            nc.port()
        });
        assert_eq!(saved_port(&dir), Some(first), "the bound port is saved");
        let (second, changed, env) = launch(dir_cfg(&dir, None), |nc| {
            (
                nc.port(),
                nc.status().port_changed,
                nc.pty_env_with("t1", &[]),
            )
        });
        assert_eq!(second, first, "the relaunch binds the saved port again");
        assert_eq!(changed, None);
        let url = format!("http://t-t1:x@127.0.0.1:{first}");
        assert!(env.contains(&("HTTP_PROXY".into(), url)), "{env:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The saved port is taken (another process has it) → the proxy still starts, on a
    /// new port it saves, and says so with `portChanged`; `pty_env` hands out the NEW port.
    #[test]
    fn a_busy_saved_port_moves_saves_and_reports_the_change() {
        let dir = std::env::temp_dir().join(format!("netcap-busy-{}", ulid::Ulid::new()));
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = squatter.local_addr().unwrap().port();
        std::fs::create_dir_all(&dir).unwrap();
        // Hand-written, as a previous launch would have left it.
        std::fs::write(
            dir.join(prefs::FILE_NAME),
            format!(r#"{{"enabled":true,"decrypt":false,"port":{taken}}}"#),
        )
        .unwrap();
        let (port, st, env) = launch(dir_cfg(&dir, None), |nc| {
            (nc.port(), nc.status(), nc.pty_env_with("t1", &[]))
        });
        assert_ne!(port, taken);
        assert_eq!(st.port, Some(port));
        assert_eq!(
            st.port_changed,
            Some(PortChange {
                from: taken,
                to: port
            })
        );
        assert_eq!(saved_port(&dir), Some(port), "the new port is saved");
        let url = format!("http://t-t1:x@127.0.0.1:{port}");
        assert!(env.contains(&("HTTPS_PROXY".into(), url)), "{env:?}");
        // The next launch gets the new port back and reports nothing.
        let (again, changed) = launch(dir_cfg(&dir, None), |nc| {
            (nc.port(), nc.status().port_changed)
        });
        assert_eq!((again, changed), (port, None));
        drop(squatter);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The macOS `SO_REUSEADDR` hole: another process listening on the WILDCARD address holds
    /// the saved port. Our specific `127.0.0.1` bind would succeed and steal its loopback
    /// traffic — it must count as taken instead.
    #[test]
    fn a_saved_port_held_on_the_wildcard_address_is_taken_too() {
        let squatter = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let taken = squatter.local_addr().unwrap().port();
        let (l, ch) = bind_listener(Some(taken), None).unwrap();
        let port = l.local_addr().unwrap().port();
        assert_ne!(
            port, taken,
            "must not bind over another process's wildcard listener"
        );
        assert_eq!(
            ch,
            Some(PortChange {
                from: taken,
                to: port
            })
        );
    }

    /// A first launch takes the preferred port when it is free. Never assumes 8877 is
    /// free on this machine (the installed app may hold it): skip-with-reason otherwise.
    #[test]
    fn a_first_launch_prefers_8877_when_it_is_free() {
        if let Err(e) = std::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
            eprintln!("SKIPPED: 127.0.0.1:{PREFERRED_PORT} is not free here ({e}) — cannot test the preference");
            return;
        } // the probe listener is dropped here: free again
        let dir = std::env::temp_dir().join(format!("netcap-8877-{}", ulid::Ulid::new()));
        let port = launch(dir_cfg(&dir, Some(PREFERRED_PORT)), |nc| nc.port());
        if port != PREFERRED_PORT
            && std::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_err()
        {
            eprintln!("SKIPPED: something took {PREFERRED_PORT} between the probe and the start");
            let _ = std::fs::remove_dir_all(dir);
            return;
        }
        assert_eq!(port, PREFERRED_PORT);
        assert_eq!(saved_port(&dir), Some(PREFERRED_PORT));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The pure fallback order, without depending on any particular global port.
    #[test]
    fn bind_listener_fallback_order() {
        let a = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = a.local_addr().unwrap().port();
        let free = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        // saved busy → preferred (free) — a change from the saved one.
        let (l, ch) = bind_listener(Some(busy), Some(free)).unwrap();
        assert_eq!(l.local_addr().unwrap().port(), free);
        assert_eq!(
            ch,
            Some(PortChange {
                from: busy,
                to: free
            })
        );
        drop(l);
        // no saved port, preferred busy → ephemeral, not a change.
        let (l, ch) = bind_listener(None, Some(busy)).unwrap();
        assert_ne!(l.local_addr().unwrap().port(), busy);
        assert_eq!(ch, None);
        // a saved `0` is not a configured port.
        let (_l, ch) = bind_listener(Some(0), None).unwrap();
        assert_eq!(ch, None);
    }

    /// The per-app decrypt opt-in is persisted, idempotent, removable, and refuses unmatchable
    /// names.
    #[test]
    fn app_decrypt_opt_ins_persist_and_are_reported() {
        let dir = std::env::temp_dir().join(format!("netcap-apps-{}", ulid::Ulid::new()));
        launch(dir_cfg(&dir, None), |nc| {
            assert!(nc.status().decrypt_apps.is_empty());
            nc.set_app_decrypt("Postman", true).unwrap();
            nc.set_app_decrypt(" Postman ", true).unwrap();
            let st = nc.set_app_decrypt("Insomnia", true).unwrap();
            assert_eq!(
                st.decrypt_apps,
                ["Postman", "Insomnia"],
                "trimmed, deduped, ordered"
            );
            assert!(nc.set_app_decrypt("", true).is_err());
            assert!(nc.set_app_decrypt("a/b", true).is_err());
        });
        let apps = launch(dir_cfg(&dir, None), |nc| {
            let before = nc.status().decrypt_apps;
            let after = nc.set_app_decrypt("Postman", false).unwrap().decrypt_apps;
            (before, after)
        });
        assert_eq!(apps.0, ["Postman", "Insomnia"], "survives a restart");
        assert_eq!(apps.1, ["Insomnia"]);
        assert_eq!(
            prefs::load(&dir.join(prefs::FILE_NAME)).decrypt_apps,
            ["Insomnia"]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pty_env_is_empty_when_the_app_proxy_never_started() {
        // `cargo test` never runs `setup`, so GLOBAL is unset — the supervisor's call in
        // every PTY test must be a no-op.
        assert!(pty_env("any").is_empty());
        assert!(!netcap_status().running);
    }
}
