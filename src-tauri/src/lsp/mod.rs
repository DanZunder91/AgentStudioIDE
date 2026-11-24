//! `LspSupervisor` — the actor that owns every spawned language server.
//!
//! A thin **transport relay**, mirroring `SessionSupervisor`: one task
//! owns `Map<ServerId, LspServer>`, driven by an mpsc command loop; a cheap-clone
//! [`LspHandle`] is what the `#[tauri::command]`s talk to. It spawns servers over
//! piped stdio, frames bytes both ways, and reaps them — and **never parses a single
//! LSP message**. The JSON-RPC protocol lives in the JS `@codemirror/lsp-client`.
//!
//! Server→client is a per-server `Channel<String>` captured at start (deframed bodies
//! as JSON strings); client→server is the low-frequency `lsp_send` command — the same
//! "Channel out, command in" shape as `terminal_open`.

pub mod commands;
mod framing;
pub mod project_root;
mod registry;
mod server;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};

use crate::model::{LspStartInfo, LspStatus};
use registry::{Detection, Prober, SystemProber};
use server::LspServer;

/// Command-queue depth. The LSP control plane is low-frequency; this is slack.
const LSP_QUEUE: usize = 256;

/// Everything the actor is sent by commands or by a server's wait task.
pub enum LspMsg {
    Start {
        language_id: String,
        root_uri: String,
        channel: Channel<String>,
        reply: oneshot::Sender<Result<LspStartInfo, String>>,
    },
    Send {
        server_id: String,
        message: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Stop {
        server_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// From a server's wait task when the child ends (naturally or via stop).
    ServerExited {
        server_id: String,
        code: Option<i32>,
    },
}

/// Cheap to clone into Tauri's managed state.
#[derive(Clone)]
pub struct LspHandle(mpsc::Sender<LspMsg>);

impl LspHandle {
    async fn send_msg(&self, msg: LspMsg) -> Result<(), String> {
        self.0
            .send(msg)
            .await
            .map_err(|_| "lsp supervisor is not running".to_string())
    }

    /// Resolve + spawn the server for `language_id`, streaming its output to
    /// `channel`. An absent server is a calm `Ok` with `status: not_installed` (never
    /// an `Err`); a genuine spawn failure is an `Err`.
    pub async fn start(
        &self,
        language_id: String,
        root_uri: String,
        channel: Channel<String>,
    ) -> Result<LspStartInfo, String> {
        let (reply, rx) = oneshot::channel();
        self.send_msg(LspMsg::Start {
            language_id,
            root_uri,
            channel,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "lsp supervisor dropped the reply".to_string())?
    }

    /// One client→server JSON-RPC body. Unknown/dead server → `Err`.
    pub async fn send(&self, server_id: String, message: String) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send_msg(LspMsg::Send {
            server_id,
            message,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "lsp supervisor dropped the reply".to_string())?
    }

    /// Terminate a server. Stopping an unknown/already-dead server is a no-op `Ok`.
    pub async fn stop(&self, server_id: String) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send_msg(LspMsg::Stop { server_id, reply }).await?;
        rx.await
            .map_err(|_| "lsp supervisor dropped the reply".to_string())?
    }
}

/// Everything the actor owns.
struct Lsp {
    servers: HashMap<String, LspServer>,
    /// How server binaries are resolved — real in prod, stubbed in tests.
    prober: Arc<dyn Prober>,
}

/// Spawn the supervisor with the real system prober.
pub fn spawn_lsp_supervisor() -> LspHandle {
    spawn_lsp_supervisor_with(Arc::new(SystemProber))
}

/// Spawn the supervisor with an injected [`Prober`] (tests point detection at a fake
/// binary without needing rust-analyzer on the machine).
pub fn spawn_lsp_supervisor_with(prober: Arc<dyn Prober>) -> LspHandle {
    let (tx, mut rx) = mpsc::channel::<LspMsg>(LSP_QUEUE);
    let handle = LspHandle(tx.clone());

    tauri::async_runtime::spawn(async move {
        let mut lsp = Lsp {
            servers: HashMap::new(),
            prober,
        };

        while let Some(msg) = rx.recv().await {
            match msg {
                LspMsg::Start {
                    language_id,
                    root_uri,
                    channel,
                    reply,
                } => {
                    let res = start_server(&mut lsp, &tx, language_id, root_uri, channel);
                    let _ = reply.send(res);
                }
                LspMsg::Send {
                    server_id,
                    message,
                    reply,
                } => {
                    let res = match lsp.servers.get(&server_id) {
                        Some(server) => server.send(message),
                        None => Err(format!("unknown lsp server: {server_id}")),
                    };
                    let _ = reply.send(res);
                }
                LspMsg::Stop { server_id, reply } => {
                    // Removing the handle + shutting it down; unknown/dead is a no-op.
                    if let Some(server) = lsp.servers.remove(&server_id) {
                        server.shutdown();
                    }
                    let _ = reply.send(Ok(()));
                }
                LspMsg::ServerExited { server_id, code } => {
                    if lsp.servers.remove(&server_id).is_some() {
                        eprintln!("[lsp] server {server_id} exited (code {code:?})");
                    }
                }
            }
        }
    });

    handle
}

/// Resolve + spawn the server for a start request. Pure control-plane logic split out
/// so the actor loop stays readable.
fn start_server(
    lsp: &mut Lsp,
    tx: &mpsc::Sender<LspMsg>,
    language_id: String,
    root_uri: String,
    channel: Channel<String>,
) -> Result<LspStartInfo, String> {
    let server_id = mint_server_id();

    // Unmapped language: feature simply off, with no hint (nothing to install toward).
    let Some(spec) = registry::spec_for(&language_id) else {
        return Ok(LspStartInfo {
            server_id,
            language_id,
            status: LspStatus::NotInstalled,
            install_hint: None,
            server_name: None,
        });
    };

    // NOTE: `SystemProber` may run a blocking `rustup which` here. It is rare
    // (once per start) and fast, and the Tauri runtime is multi-threaded, so it does
    // not stall other work — the same blocking-in-the-actor pattern the supervisor
    // uses for hook-settings IO.
    match registry::detect_with(&spec, &*lsp.prober) {
        Detection::NotInstalled => Ok(LspStartInfo {
            server_id,
            language_id,
            status: LspStatus::NotInstalled,
            install_hint: Some(spec.install_hint.to_string()),
            server_name: Some(spec.server_name.to_string()),
        }),
        Detection::Found(bin) => {
            let cwd = path_from_root_uri(&root_uri);
            // A Windows npm `.cmd` becomes `node <script>`; a `.bat` runs with fixed args
            // only (`registry::launch_for`).
            let launch =
                registry::launch_for(&bin, spec.args, cfg!(windows), crate::winshim::find_node)
                    .map_err(|e| format!("failed to start {}: {e}", spec.server_name))?;
            match server::spawn(
                &launch.program,
                &launch.args,
                &cwd,
                server_id.clone(),
                language_id.clone(),
                channel,
                tx.clone(),
            ) {
                Ok(server) => {
                    lsp.servers.insert(server_id.clone(), server);
                    Ok(LspStartInfo {
                        server_id,
                        language_id,
                        status: LspStatus::Running,
                        install_hint: None,
                        server_name: Some(spec.server_name.to_string()),
                    })
                }
                // A resolved binary that won't spawn is a genuine error, not "absent".
                Err(e) => Err(format!("failed to spawn {}: {e}", spec.server_name)),
            }
        }
    }
}

/// A fresh server id (ULID). Minted Rust-side so `serverId → process` ownership is
/// unambiguous.
fn mint_server_id() -> String {
    ulid::Ulid::new().to_string()
}

/// The cwd to spawn the server in, from the request's `rootUri`.
///
/// The relay only needs a *directory to run in*; full `file://` ↔ path handling
/// (percent-encoding, symlinks) lives in the JS workspace layer. We accept a
/// plain path or a simple `file://` URI so either is safe to pass.
fn path_from_root_uri(root_uri: &str) -> PathBuf {
    let Some(rest) = root_uri.strip_prefix("file://") else {
        return PathBuf::from(root_uri);
    };
    // Drop an (empty) authority: `file:///a/b` → `/a/b`.
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    #[cfg(windows)]
    {
        // `file:///C:/x` → `/C:/x` → `C:/x`.
        PathBuf::from(path.strip_prefix('/').unwrap_or(path))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(path)
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Test helpers shared by the `lsp` submodules' unit tests.

    use super::registry::Prober;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tauri::ipc::{Channel, InvokeResponseBody};

    /// Records the strings a `Channel<String>` was sent (the deframed bodies).
    pub struct Recorder(Arc<Mutex<Vec<String>>>);
    impl Recorder {
        // Only the (unix-only) process round-trip tests poll a snapshot; `take` is
        // used cross-platform by the in-memory-pipe tests.
        #[allow(dead_code)]
        pub fn snapshot(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
        pub fn take(&self) -> Vec<String> {
            let mut g = self.0.lock().unwrap();
            std::mem::take(&mut g)
        }
    }

    /// A real `Channel<String>` whose handler records instead of hitting a webview.
    pub fn string_channel() -> (Channel<String>, Recorder) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let rec = store.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            // `Channel<String>::send(s)` JSON-encodes `s`; recover the raw string.
            let s = match body {
                InvokeResponseBody::Json(j) => serde_json::from_str::<String>(&j).unwrap_or(j),
                InvokeResponseBody::Raw(b) => String::from_utf8_lossy(&b).into_owned(),
            };
            rec.lock().unwrap().push(s);
            Ok(())
        });
        (channel, Recorder(store))
    }

    /// First of `candidates` that exists on disk (portable tool lookup). Only the
    /// unix subprocess tests use it (`/bin/cat`, `/usr/bin/false`).
    #[cfg(unix)]
    pub fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
        candidates.iter().map(PathBuf::from).find(|p| p.exists())
    }

    /// A prober returning fixed answers — points detection at a chosen binary.
    pub struct FixedProber {
        pub rustup: Option<PathBuf>,
        pub which: Option<PathBuf>,
    }
    impl Prober for FixedProber {
        fn rustup_which(&self, _component: &str) -> Option<PathBuf> {
            self.rustup.clone()
        }
        fn which(&self, _command: &str) -> Option<PathBuf> {
            self.which.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{string_channel, FixedProber};
    use super::*;

    #[tokio::test]
    async fn absent_server_reports_not_installed_with_a_hint() {
        let handle = spawn_lsp_supervisor_with(Arc::new(FixedProber {
            rustup: None,
            which: None,
        }));
        let (channel, _rec) = string_channel();

        let info = handle
            .start("rust".to_string(), "/".to_string(), channel)
            .await
            .unwrap();

        assert_eq!(info.status, LspStatus::NotInstalled);
        assert_eq!(
            info.install_hint.as_deref(),
            Some("rustup component add rust-analyzer")
        );
        assert_eq!(info.server_name.as_deref(), Some("rust-analyzer"));
    }

    #[tokio::test]
    async fn an_unmapped_language_is_off_with_no_hint() {
        let handle = spawn_lsp_supervisor_with(Arc::new(FixedProber {
            rustup: None,
            which: None,
        }));
        let (channel, _rec) = string_channel();

        let info = handle
            .start("cobol".to_string(), "/".to_string(), channel)
            .await
            .unwrap();

        assert_eq!(info.status, LspStatus::NotInstalled);
        assert!(
            info.install_hint.is_none(),
            "no hint for an unmapped language"
        );
    }

    #[tokio::test]
    async fn sending_to_an_unknown_server_errors_cleanly() {
        let handle = spawn_lsp_supervisor_with(Arc::new(FixedProber {
            rustup: None,
            which: None,
        }));
        let err = handle
            .send("nope".to_string(), "{}".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("unknown lsp server"), "got: {err}");
    }

    #[tokio::test]
    async fn stopping_an_unknown_server_is_a_noop() {
        let handle = spawn_lsp_supervisor_with(Arc::new(FixedProber {
            rustup: None,
            which: None,
        }));
        assert!(handle.stop("nope".to_string()).await.is_ok());
    }

    /// Full actor pipe (unix): start → spawn `cat` (a framed echo) → send → the body
    /// comes back on the Channel → stop reaps it. Detection is pointed at `cat` via
    /// the rustup probe (rust is a rustup-managed spec).
    #[cfg(unix)]
    #[tokio::test]
    async fn start_send_receive_stop_round_trips_through_the_actor() {
        use super::test_support::first_existing;
        use std::time::Duration;
        let cat = first_existing(&["/bin/cat", "/usr/bin/cat"]).expect("cat");
        let handle = spawn_lsp_supervisor_with(Arc::new(FixedProber {
            rustup: Some(cat),
            which: None,
        }));
        let (channel, recorder) = string_channel();

        let info = handle
            .start("rust".to_string(), "/".to_string(), channel)
            .await
            .unwrap();
        assert_eq!(info.status, LspStatus::Running);
        let server_id = info.server_id.clone();

        let body = r#"{"jsonrpc":"2.0","id":7}"#;
        handle
            .send(server_id.clone(), body.to_string())
            .await
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if recorder.snapshot().iter().any(|m| m == body) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "echo never arrived");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        handle.stop(server_id.clone()).await.unwrap();

        // After stop the server is gone → a send errors cleanly (poll: stop → the
        // ServerExited removal may land just after).
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if handle
                .send(server_id.clone(), "{}".to_string())
                .await
                .is_err()
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "server never went away"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// A server that dies mid-session is surfaced cleanly: the child is reaped and the
    /// server removed, so subsequent sends error rather than hang — no panic, no
    /// zombie. `false` exits immediately, standing in for a crash.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_that_dies_is_reaped_and_surfaced() {
        use super::test_support::first_existing;
        use std::time::Duration;
        let false_bin =
            first_existing(&["/usr/bin/false", "/bin/false"]).expect("false must exist on unix");
        let handle = spawn_lsp_supervisor_with(Arc::new(FixedProber {
            rustup: Some(false_bin),
            which: None,
        }));
        let (channel, _rec) = string_channel();

        let info = handle
            .start("rust".to_string(), "/".to_string(), channel)
            .await
            .unwrap();
        // Spawn succeeded even though the process exits at once.
        assert_eq!(info.status, LspStatus::Running);
        let server_id = info.server_id;

        // The actor reaps it and drops it from the map; a send then errors.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if handle
                .send(server_id.clone(), "{}".to_string())
                .await
                .is_err()
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "a dead server was never reaped/removed"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn path_from_root_uri_accepts_a_plain_path_or_a_file_uri() {
        assert_eq!(
            path_from_root_uri("/work/proj"),
            PathBuf::from("/work/proj")
        );
        #[cfg(not(windows))]
        assert_eq!(
            path_from_root_uri("file:///work/proj"),
            PathBuf::from("/work/proj")
        );
    }
}
