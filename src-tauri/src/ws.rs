//! The built-in API client's WebSocket engine.
//!
//! Three `#[tauri::command]`s run a live WS/WSS session in the Rust core (not the
//! webview's `WebSocket`, which CSP would hobble and which can't send arbitrary
//! headers), mirroring `http.rs`. The wire contract the frontend builds against:
//!
//! ```text
//! invoke("ws_connect", { url, headers?, onEvent }) -> string  // connectionId; onEvent is a Channel<string>
//! invoke("ws_send",    { connectionId, message })             // send one text frame
//! invoke("ws_close",   { connectionId })                      // close the connection
//! ```
//!
//! `headers` is an optional `[{ name, value }]` (the same row shape as gRPC's `metadata`)
//! applied to the **opening handshake**. It exists because a WebSocket handshake *is* an
//! HTTP request: a server that authenticates it — a real `ws://…/ws?room=…`
//! did — answers `HTTP error: 401 Unauthorized` to every connection made without one, and
//! until now this engine connected from a bare URL and could not send any. See
//! [`build_request`] for what it refuses and why.
//!
//! Server→client is the per-connection `Channel<String>` captured at connect; every
//! event is a **JSON string** pushed on it — the same "Channel out, command in" shape
//! as `terminal_open` / `lsp_start`. Event shapes (all keys lowercase):
//!
//! ```json
//! {"kind":"open"}
//! {"kind":"message","data":"<text>"}
//! {"kind":"closed","code":<number|null>,"reason":"<string>"}
//! {"kind":"error","message":"<string>"}
//! ```
//!
//! **Structure (mirrors `lsp/server.rs`).** Each connection is one spawned task that
//! owns the socket; a module-level [`CONNECTIONS`] registry keyed by id holds only the
//! **send half** of an mpsc queue (the writer task drains it to the socket). A registry
//! entry existing *is* the connection being live: dropping the sender (via [`ws_close`],
//! or clearing the registry) makes the task's `recv()` return `None`, which closes the
//! socket — the `kill_on_drop` equivalent. The task removes its own id on exit, so the
//! registry never leaks a dead connection.
//!
//! **Guardrails** (same spirit as `http.rs` / the LSP `send`): the outgoing queue is
//! bounded ([`SEND_QUEUE`]) so a wedged endpoint can't make `ws_send` block — a full
//! queue is a plain `Err` (backpressure surfaced, never a stall); and incoming messages
//! are capped at [`MAX_MESSAGE_BYTES`] so a malicious peer can't balloon our memory.
//!
//! Only a *failure to establish or run* the socket is surfaced as an `error` event; a
//! normal server-initiated close is a `closed` event, never an error — the same "an
//! error status is still a response" spirit as `http_send`.
//!
//! **TLS** follows the app-wide policy in [`crate::tls`]: the single `ring`
//! crypto provider, and a `wss://` root store that is the **union of the operating
//! system's trust anchors and the bundled Mozilla set** (tungstenite's
//! `rustls-tls-native-roots` + `rustls-tls-webpki-roots`). So an internal `wss://` behind
//! a corporate CA verifies, and a machine with an empty/broken system store still reaches
//! public hosts. No native-tls, no OpenSSL.
//!
//! **Secrets.** A header value may hold `{{VAR}}` placeholders; they are resolved
//! against the Vault **here, in Rust**, so the token never crosses IPC and is never what the
//! frontend saved. The lookup is [`crate::db::secret`]'s — the one Vault resolver this crate
//! has — not a second one; only the sentence for a missing variable is written for the API
//! client rather than the DB client. Every resolved value is then carried alongside the
//! connection and scrubbed out of **every** `error` event via [`emit_error`], because the one
//! thing a 401 must never do is echo the `Authorization` header back into the UI.
//!
//! **Network view.** Each connection is one `ws`/`wss` flow in the
//! netcap store, recorded through [`crate::netcap::record`]: pending at connect with the
//! handshake request's headers (exactly the map tungstenite writes — `Host`, `Connection`,
//! `Upgrade`, `Sec-WebSocket-Version`, `Sec-WebSocket-Key`, then the custom ones), status 101
//! and the server's headers on success (a rejected handshake records its status, headers and
//! body, then the error), live `wsMessages` counts and payload bytes as frames go by, `done` on
//! close. The flow's `error` text is the transport's, unredacted — the store already holds the
//! header the server disliked, verbatim, by design; only the UI *event* is
//! scrubbed.
//!
//! **One-shot exchanges.** [`exchange`] is the same engine without a live console: connect, send
//! a list of messages in order, collect what the server sends for a bounded time and count, close,
//! and return the transcript. It is what an agent's `ws_exchange` tool runs
//! (`agent_ctl::commands::stream`). It shares [`handshake`] (request → socket + Network row) with
//! [`ws_connect`], so both are recorded alike, and it never reads the Vault: header values go out
//! exactly as given.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::api_store::ApiStore;
use crate::netcap::headers::capture_headers;
use crate::netcap::record::{self, Flow, Tap};
use crate::netcap::FlowProto;

/// Outgoing text-frame queue depth per connection. `ws_send` enqueues onto this; a full
/// queue is backpressure surfaced as an `Err` (never a block), like the LSP `send`.
const SEND_QUEUE: usize = 256;

/// Largest incoming message we accept, in bytes. Bounds memory against a malicious peer;
/// mirrors `http.rs`'s 8 MiB body cap. A frame over this closes the socket with a
/// protocol error (surfaced as an `error` event).
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

/// The live connections' send halves, keyed by `connectionId`. A module-level registry
/// (a `once`/`Lazy` static) keeps the three commands free of Tauri state,
/// so `lib.rs` only gains the module decl + `use` + handler rows. `std::sync::Mutex` is
/// enough: every critical section is a lock-free `insert`/`get`/`remove` with no `.await`
/// held across it.
static CONNECTIONS: LazyLock<Mutex<HashMap<String, mpsc::Sender<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The five headers `tungstenite::handshake::client::generate_request` writes into the
/// opening handshake itself, lower-cased (an `http::HeaderName` always is).
///
/// They are **not ours to set**. `generate_request` `remove`s exactly these five from the map,
/// writes them first, and then returns `Error::Protocol(InvalidHeader)` if it meets any of them
/// again — so a caller-supplied copy either replaces a value tungstenite computed (`Host` from
/// the URL, a fresh `Sec-WebSocket-Key`) or kills the handshake outright, and the second failure
/// reads like a server bug rather than a typo. Hence [`build_request`] refuses them by name.
const HANDSHAKE_HEADERS: [&str; 5] = [
    "host",
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
];

/// One handshake header row. The same `{name, value}` shape as [`crate::grpc::GrpcHeader`],
/// deliberately: the console's header editor is the same widget, and `value` may hold a
/// `{{VAR}}` reference whose real value only [`substitute`] ever sees.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsHeader {
    pub name: String,
    pub value: String,
}

/// One event pushed to the frontend on the connection's `Channel<String>`. Serialized to
/// a JSON string (the channel then JSON-encodes that string for the webview). `kind` is
/// the tag; single-word variant/field names make camelCase == the lowercase wire form.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WsEvent {
    /// Handshake completed — the socket is open.
    Open,
    /// A text (or lossily-decoded binary) frame arrived from the peer.
    Message { data: String },
    /// The socket closed. `code`/`reason` come from the peer's Close frame when it sent
    /// one; a bare stream-end or a client-initiated close reports `code: null`.
    Closed { code: Option<u16>, reason: String },
    /// The connection failed to establish or errored mid-session.
    Error { message: String },
}

/// Serialize `event` and push it on `channel`. A webview that has gone away makes
/// `send` error; ignore it (the task is ending anyway), like the LSP read loop.
fn emit(channel: &Channel<String>, event: WsEvent) {
    if let Ok(json) = serde_json::to_string(&event) {
        let _ = channel.send(json);
    }
}

/// Emit an `error` event with every `secret` masked out of `message` first.
///
/// 🔴 **Every error that leaves a connection goes through here, never through [`emit`]
/// directly.** A rejected handshake is the exact moment a server is most likely to quote the
/// credential it disliked — and `tungstenite`'s own `Error::Utf8` variant formats a header's
/// *value* into its text. Masking at the single exit is the [`crate::db::error`] discipline:
/// a per-call-site scrub is one forgotten call site away from shipping the token.
fn emit_error(channel: &Channel<String>, message: String, secrets: &[String]) {
    let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
    emit(
        channel,
        WsEvent::Error {
            message: crate::db::secret::redact(&message, &refs),
        },
    );
}

/// Replace every `{{VAR}}` in `text` with its Vault value, pushing each resolved value onto
/// `secrets` so [`emit_error`] can scrub it later.
///
/// Matching mirrors `src/features/api/substitute.ts` exactly — two braces, a run of non-brace
/// characters, two braces, the name trimmed — so what the console previews and what goes on the
/// wire cannot disagree. A `{{` with no closing `}}`, and an empty `{{}}`/`{{ }}`, are left
/// **literal**: they name no variable, and rewriting them to nothing would silently blank a
/// header the user meant to send.
///
/// The lookup itself is [`crate::db::secret::resolve`] — the crate's one Vault resolver, with
/// its active-environment-first-then-the-rest search. Only the missing-variable *sentence* is
/// rewritten here, because that resolver's own wording talks about database connections.
///
/// A missing variable is an **error**, not the empty string the TypeScript preview falls back
/// to. An empty `Authorization` header is a bare 401 with no explanation attached, which
/// is precisely the outcome this whole change exists to remove.
fn substitute(text: &str, vault: &ApiStore, secrets: &mut Vec<String>) -> Result<String, String> {
    if !text.contains("{{") {
        return Ok(text.to_string());
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        // The inner run may not contain a brace (the `[^{}]*` of the TS pattern), so a
        // `{{{A}}}` re-scans from the second `{` and resolves `{{A}}`, exactly as the regex
        // engine's backtracking does.
        let close = after.find("}}");
        let key = close
            .map(|c| after[..c].trim())
            .filter(|k| !k.is_empty() && !k.contains('{') && !k.contains('}'));
        match (close, key) {
            (Some(c), Some(k)) => {
                let reference = crate::db::secret::wrap_ref(k);
                let value = crate::db::secret::resolve(&reference, vault).map_err(|_| {
                    format!("the Vault has no value for {reference} — add it in the Vault panel")
                })?;
                if !value.is_empty() {
                    secrets.push(value.clone());
                }
                out.push_str(&value);
                rest = &after[c + 2..];
            }
            _ => {
                out.push('{');
                rest = &rest[open + 1..];
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// Build the opening-handshake HTTP request for `url` with `headers` applied, returning it
/// alongside every Vault value that was spliced in (the redaction set for [`emit_error`]).
///
/// `into_client_request` is what produces a *complete* handshake — `Host`, `Connection`,
/// `Upgrade`, `Sec-WebSocket-Version` and a freshly generated `Sec-WebSocket-Key`. We only ever
/// `append` to what it built, so those five survive untouched.
///
/// Three refusals, each an `Err` naming the offending header rather than a silent drop — a
/// dropped `Authorization` is indistinguishable from the 401 that started all this:
///
/// 1. a name that is not a valid HTTP token,
/// 2. a value that is not a valid HTTP field value (a newline, a control byte) — the message
///    names the header and **never quotes the value**, which may be the resolved secret,
/// 3. any of [`HANDSHAKE_HEADERS`].
///
/// A **duplicate custom header** is kept, not collapsed: two `X-Scope` rows send two
/// `X-Scope` lines, matching `http.rs`'s `append` and gRPC's `build_metadata`. HTTP says
/// repeated fields are a list, and picking a winner for the user would be a value they never
/// typed.
fn build_request(
    url: &str,
    headers: &[WsHeader],
    vault: &ApiStore,
) -> Result<(Request, Vec<String>), String> {
    let mut request = url
        .trim()
        .into_client_request()
        .map_err(|e| format!("invalid WebSocket URL: {e}"))?;
    let mut secrets = Vec::new();
    for h in headers {
        let name = HeaderName::from_bytes(h.name.trim().as_bytes())
            .map_err(|_| format!("invalid header name: {:?}", h.name))?;
        if HANDSHAKE_HEADERS.contains(&name.as_str()) {
            return Err(format!(
                "the {} header is written by the WebSocket handshake itself and cannot be set \
                 here — a second copy makes the server reject the connection. Change the URL \
                 instead if you meant to reach a different host.",
                name.as_str()
            ));
        }
        let text = substitute(&h.value, vault, &mut secrets)
            .map_err(|e| format!("{e} (header {:?})", h.name))?;
        let value = HeaderValue::from_str(&text)
            .map_err(|_| format!("invalid header value for {:?}", h.name))?;
        request.headers_mut().append(name, value);
    }
    Ok((request, secrets))
}

/// [`build_request`] against the Vault file at `vault_path`.
///
/// The file is read **only** when some header actually mentions `{{`, so the ordinary
/// no-placeholder connect touches no secret store at all.
fn build_request_from_vault(
    url: &str,
    headers: &[WsHeader],
    vault_path: &Path,
) -> Result<(Request, Vec<String>), String> {
    let vault = if headers.iter().any(|h| h.value.contains("{{")) {
        crate::api_store::load(vault_path)
    } else {
        ApiStore::default()
    };
    build_request(url, headers, &vault)
}

/// Open a WebSocket to `url` (`ws://` or `wss://`), streaming its lifecycle to `on_event`.
///
/// `headers` (optional — omitting it is the pre-header behaviour, byte for byte) are applied
/// to the opening handshake; values may hold `{{VAR}}` references resolved against the Vault
/// **in Rust**, so the frontend sends the literal template and never the token.
///
/// Returns a fresh `connectionId` (ULID) **immediately**; the actual connect happens on a
/// spawned task, so the first event on the channel (`open` or `error`) is what tells the
/// UI whether it succeeded — including a rejected header, which is a failure to *establish*
/// the socket and so takes the same `error` path as a refused TCP connect rather than
/// inventing a second way for this command to fail. `wss://` uses rustls with the `ring`
/// provider and the OS ∪ Mozilla root store (no native-tls; see [`crate::tls`] and
/// `Cargo.toml`).
#[tauri::command]
pub fn ws_connect(
    app: tauri::AppHandle,
    url: String,
    headers: Option<Vec<WsHeader>>,
    on_event: Channel<String>,
) -> String {
    connect_via(
        url,
        headers.unwrap_or_default(),
        crate::api_store::store_path_for(&app),
        on_event,
        Tap::global(),
    )
}

/// [`ws_connect`] with the Vault path and the Network tap injected instead of derived from
/// an `AppHandle` / taken from the app.
///
/// The split is `db::Paths`': only the `#[tauri::command]` above knows the
/// real config-dir location, so no test can reach it, and the whole connect path — header
/// resolution included — is still drivable end to end against a temp directory. The tap is
/// the seam `tests/netcap_record.rs` drives: a real session, recorded into a test's own `Netcap`.
pub fn connect_via(
    url: String,
    headers: Vec<WsHeader>,
    vault_path: PathBuf,
    on_event: Channel<String>,
    tap: Tap,
) -> String {
    let connection_id = ulid::Ulid::new().to_string();
    let (out_tx, out_rx) = mpsc::channel::<String>(SEND_QUEUE);
    CONNECTIONS
        .lock()
        .expect("connections mutex poisoned")
        .insert(connection_id.clone(), out_tx);
    tauri::async_runtime::spawn(run_connection(
        connection_id.clone(),
        url,
        headers,
        vault_path,
        on_event,
        out_rx,
        tap,
    ));
    connection_id
}

/// A connected client socket.
type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The client settings every socket uses: incoming messages capped at [`MAX_MESSAGE_BYTES`],
/// frame size left at tungstenite's default (16 MiB ≤ cap).
fn client_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES))
}

/// Open the socket `request` describes and record it as a Network row: pending with the
/// handshake as it goes out, then status 101 and the server's headers on success. A rejected
/// handshake IS a response (a 401, say): its status, headers and body go on the row before the
/// error that ends it. On `Err` the row is already settled (`error`); the text is the
/// transport's, unredacted, for the caller to scrub if it resolved secrets.
///
/// `limit` bounds the TCP connect, TLS and HTTP upgrade together; `None` waits as long as the OS
/// does (the console's behaviour).
async fn handshake(
    request: Request,
    tap: &Tap,
    limit: Option<Duration>,
) -> Result<(WsStream, Flow), String> {
    // One provider for the whole process. tungstenite builds its default
    // `ClientConfig` with `ClientConfig::builder()`, which prefers the installed process
    // default over its own crate-feature fallback — installing here is what keeps `wss://`
    // on the same `ring` backend as `http_send` and gRPC. Idempotent; `run()` also does it
    // at startup, but tests never go through `run()`.
    crate::tls::install_crypto_provider();

    // The Network row: pending from here, with the handshake exactly as it goes out.
    let flow = start_flow(tap, &request);
    let connecting = connect_async_with_config(request, Some(client_config()), false);
    let outcome = match limit {
        None => connecting.await,
        Some(limit) => match tokio::time::timeout(limit, connecting).await {
            Ok(outcome) => outcome,
            Err(_) => {
                let message = format!(
                    "the WebSocket handshake did not finish within {} ms",
                    limit.as_millis()
                );
                flow.fail(message.clone());
                return Err(message);
            }
        },
    };
    match outcome {
        Ok((stream, response)) => {
            flow.response_head(
                response.status().as_u16(),
                &record::http_version(response.version()),
                capture_headers(response.headers()),
            );
            flow.ws_open();
            Ok((stream, flow))
        }
        Err(e) => {
            if let tokio_tungstenite::tungstenite::Error::Http(resp) = &e {
                flow.response_head(
                    resp.status().as_u16(),
                    &record::http_version(resp.version()),
                    capture_headers(resp.headers()),
                );
                if let Some(body) = resp.body() {
                    flow.response_body(body, body.len() as u64);
                }
            }
            flow.fail(e.to_string());
            Err(e.to_string())
        }
    }
}

/// The pending Network row for a handshake about to go out: a `ws`/`wss` flow with the
/// request exactly as tungstenite will write it. Nothing for a scheme tungstenite refuses.
fn start_flow(tap: &Tap, request: &Request) -> Flow {
    let uri = request.uri();
    let proto = match uri.scheme_str() {
        Some("ws") => FlowProto::Ws,
        Some("wss") => FlowProto::Wss,
        _ => return Flow::none(),
    };
    let Some(host) = uri.host() else {
        return Flow::none();
    };
    let port = uri
        .port_u16()
        .unwrap_or(if proto == FlowProto::Wss { 443 } else { 80 });
    let path = uri.path_and_query().map_or("/", |p| p.as_str());
    tap.start(
        proto,
        "GET",
        host.trim_start_matches('[').trim_end_matches(']'),
        port,
        path,
        "HTTP/1.1",
        capture_headers(request.headers()),
    )
}

/// Enqueue one text frame on an open connection. Unknown id, or a queue that is full or
/// already closing, is an `Err` (never a block) — the same backpressure contract as the
/// LSP `send`.
#[tauri::command]
pub fn ws_send(connection_id: String, message: String) -> Result<(), String> {
    let guard = CONNECTIONS.lock().expect("connections mutex poisoned");
    let Some(sender) = guard.get(&connection_id) else {
        return Err(format!("unknown websocket connection: {connection_id}"));
    };
    sender.try_send(message).map_err(|e| match e {
        TrySendError::Full(_) => "websocket send queue is full".to_string(),
        TrySendError::Closed(_) => "websocket connection is closing".to_string(),
    })
}

/// Close a connection: remove its registry entry, which drops the send half and makes the
/// connection task send a Close frame and stop. Unknown id is an `Err` (the connection is
/// already gone — the frontend has, or will, receive its `closed` event either way).
#[tauri::command]
pub fn ws_close(connection_id: String) -> Result<(), String> {
    match CONNECTIONS
        .lock()
        .expect("connections mutex poisoned")
        .remove(&connection_id)
    {
        // Dropping the returned sender ends the task's `recv()` → it closes the socket.
        Some(_sender) => Ok(()),
        None => Err(format!("unknown websocket connection: {connection_id}")),
    }
}

/// The per-connection task: connect, then pump frames both ways until the socket or the
/// send half closes. Owns the socket for its whole life, so its return (any exit path)
/// drops the socket — the `kill_on_drop` equivalent.
async fn run_connection(
    connection_id: String,
    url: String,
    headers: Vec<WsHeader>,
    vault_path: PathBuf,
    on_event: Channel<String>,
    mut out_rx: mpsc::Receiver<String>,
    tap: Tap,
) {
    // Build the handshake request (headers applied, `{{VAR}}`s resolved) before any I/O. These
    // messages are secret-free by construction — they name headers and variables, never values
    // — so there is nothing to redact with yet.
    let (request, secrets) = match build_request_from_vault(&url, &headers, &vault_path) {
        Ok(built) => built,
        Err(message) => {
            emit(&on_event, WsEvent::Error { message });
            CONNECTIONS
                .lock()
                .expect("connections mutex poisoned")
                .remove(&connection_id);
            return;
        }
    };

    let (stream, flow) = match handshake(request, &tap, None).await {
        Ok(opened) => opened,
        Err(message) => {
            emit_error(&on_event, message, &secrets);
            CONNECTIONS
                .lock()
                .expect("connections mutex poisoned")
                .remove(&connection_id);
            return;
        }
    };
    emit(&on_event, WsEvent::Open);

    // Split so a select can await an incoming frame and an outgoing item concurrently.
    // Every exit below settles the row exactly once: `done` on a close, `fail` on an error.
    let (mut write, mut read) = stream.split();
    loop {
        tokio::select! {
            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    flow.ws_received(text.len());
                    emit(&on_event, WsEvent::Message {
                        data: text.as_str().to_string(),
                    });
                }
                // Binary frames are surfaced as text, decoded lossily (the `http.rs`
                // precedent) — the API-client UI renders text, and this keeps a valid-UTF-8
                // binary payload readable rather than dropping it.
                Some(Ok(Message::Binary(bytes))) => {
                    flow.ws_received(bytes.len());
                    emit(&on_event, WsEvent::Message {
                        data: String::from_utf8_lossy(&bytes).into_owned(),
                    });
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame {
                        Some(f) => (Some(u16::from(f.code)), f.reason.as_str().to_string()),
                        None => (None, String::new()),
                    };
                    flow.done(None);
                    emit(&on_event, WsEvent::Closed { code, reason });
                    break;
                }
                // Control frames: tungstenite answers Pings with Pongs itself; `Frame` is
                // never yielded to a reader. Nothing to surface.
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Err(e)) => {
                    flow.fail(e.to_string());
                    emit_error(&on_event, e.to_string(), &secrets);
                    break;
                }
                // Stream ended with no Close frame (the peer vanished): report a close.
                None => {
                    flow.done(None);
                    emit(&on_event, WsEvent::Closed { code: None, reason: String::new() });
                    break;
                }
            },
            outgoing = out_rx.recv() => match outgoing {
                Some(text) => {
                    let payload = text.len();
                    match write.send(Message::Text(text.into())).await {
                        Ok(()) => flow.ws_sent(payload),
                        Err(e) => {
                            flow.fail(e.to_string());
                            emit_error(&on_event, e.to_string(), &secrets);
                            break;
                        }
                    }
                }
                // Send half dropped (ws_close, or a cleared registry): initiate the close.
                None => {
                    let _ = write.send(Message::Close(None)).await;
                    flow.done(None);
                    emit(&on_event, WsEvent::Closed { code: None, reason: String::new() });
                    break;
                }
            },
        }
    }

    // Idempotent with ws_close; guarantees no dead entry lingers. Dropping `write`/`read`
    // on return closes the underlying socket.
    CONNECTIONS
        .lock()
        .expect("connections mutex poisoned")
        .remove(&connection_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// One-shot exchange: connect, send, listen (bounded), close, transcript.
// ─────────────────────────────────────────────────────────────────────────────

/// The usual [`ExchangeSpec::send_budget`]: how long the messages to send may take to go out, all
/// together. A server that stops reading fills the socket buffer and stalls the writer; past this
/// the exchange stops.
pub const SEND_BUDGET: Duration = Duration::from_secs(10);

/// How long each step of the close may take: our Close frame going out, then the server's.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// The most of one message's text a transcript keeps.
pub const PREVIEW_BYTES: usize = 4 * 1024;

/// The most text one transcript keeps; once spent, messages are listed by size only.
pub const TRANSCRIPT_TEXT_BYTES: usize = 256 * 1024;

/// What [`exchange`] does.
#[derive(Debug, Clone)]
pub struct ExchangeSpec {
    pub url: String,
    /// Handshake headers, sent exactly as given: an exchange never reads the Vault.
    pub headers: Vec<WsHeader>,
    /// Text messages, sent in order as soon as the socket opens.
    pub send: Vec<String>,
    /// How long to keep listening after the last message went out (after the open, with none).
    pub wait: Duration,
    /// Stop listening once this many messages arrived (at least one).
    pub max_messages: usize,
    /// The handshake's deadline (TCP, TLS and the HTTP upgrade together).
    pub connect_timeout: Duration,
    /// How long the sends may take, all together ([`SEND_BUDGET`] unless a test needs less).
    pub send_budget: Duration,
}

/// Which way a message went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Sent,
    Received,
}

/// A data message's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PayloadKind {
    Text,
    Binary,
}

/// One data message of an exchange.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeEntry {
    pub direction: Direction,
    /// Milliseconds since the socket opened.
    pub at_ms: u64,
    pub kind: PayloadKind,
    /// The payload's size in bytes.
    pub bytes: usize,
    /// A text message's content, cut at [`PREVIEW_BYTES`]; `None` for a binary message, or once
    /// the transcript's [`TRANSCRIPT_TEXT_BYTES`] are spent.
    pub text: Option<String>,
    /// `text` is not the whole message.
    pub truncated: bool,
}

/// Why an exchange stopped listening.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExchangeEnd {
    /// The wait after the last send ran out.
    Waited,
    /// `max_messages` arrived.
    MaxMessages,
    /// The server closed the socket: the code and reason of its Close frame, when it sent one.
    ServerClosed { code: Option<u16>, reason: String },
    /// The messages could not all be sent within the send budget.
    SendStalled,
    /// The socket failed after it opened (a send, a read, an oversized message).
    Error { message: String },
}

/// The transcript of an exchange.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    /// How long the handshake took.
    pub handshake_ms: u64,
    /// Every data message both ways, in the order they went out or arrived.
    pub entries: Vec<ExchangeEntry>,
    pub sent: usize,
    /// Messages that never went out (the server closed first, the socket failed, the send stalled).
    pub unsent: usize,
    pub received: usize,
    pub end: ExchangeEnd,
}

/// `text` cut to at most `max` bytes on a character boundary, and whether anything was cut.
pub fn cut_text(text: &str, max: usize) -> (&str, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// The transcript as it is written: entries, counts, and the text budget left.
#[derive(Debug)]
struct Log {
    opened: Instant,
    entries: Vec<ExchangeEntry>,
    text_left: usize,
    sent: usize,
}

impl Log {
    fn new(opened: Instant) -> Self {
        Self {
            opened,
            entries: Vec::new(),
            text_left: TRANSCRIPT_TEXT_BYTES,
            sent: 0,
        }
    }

    /// Note one message, keeping as much of `text` as the per-message cut and the budget allow.
    fn push(&mut self, direction: Direction, kind: PayloadKind, bytes: usize, text: Option<&str>) {
        let shown = text.and_then(|t| {
            let room = PREVIEW_BYTES.min(self.text_left);
            if room == 0 && !t.is_empty() {
                return None;
            }
            let (cut, _) = cut_text(t, room);
            self.text_left -= cut.len();
            Some(cut.to_string())
        });
        let truncated = text.is_some() && shown.as_ref().map_or(0, String::len) < bytes;
        if direction == Direction::Sent {
            self.sent += 1;
        }
        self.entries.push(ExchangeEntry {
            direction,
            at_ms: millis(self.opened.elapsed()),
            kind,
            bytes,
            text: shown,
            truncated,
        });
    }
}

fn note(
    log: &Mutex<Log>,
    direction: Direction,
    kind: PayloadKind,
    bytes: usize,
    text: Option<&str>,
) {
    log.lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(direction, kind, bytes, text);
}

/// Connect to `spec.url`, send `spec.send` in order, collect what the server sends until
/// `spec.wait` after the last send or `spec.max_messages`, close, and return the transcript.
///
/// Recorded in the Network view like a console session (one `ws`/`wss` row, live counts, `done`
/// on close). Bounded everywhere: the handshake by `connect_timeout`, the sends by
/// `send_budget`, the listening by `wait` and `max_messages`, each incoming message by
/// [`MAX_MESSAGE_BYTES`], the close by two short graces, and the kept text by [`PREVIEW_BYTES`]
/// per message and [`TRANSCRIPT_TEXT_BYTES`] in all.
///
/// `Err` only when the socket never opened (a bad URL or header, a refused or timed-out
/// connect, a rejected handshake). A failure after the open ends the transcript instead
/// ([`ExchangeEnd::Error`]), so what was exchanged before it is not lost.
pub async fn exchange(spec: ExchangeSpec, tap: &Tap) -> Result<Exchange, String> {
    let (request, _) = build_request(&spec.url, &spec.headers, &ApiStore::default())?;
    let started = Instant::now();
    let (stream, flow) = handshake(request, tap, Some(spec.connect_timeout)).await?;
    let opened = Instant::now();
    let log = Mutex::new(Log::new(opened));
    let (sink, mut read) = stream.split();
    let max_messages = spec.max_messages.max(1);
    let to_send = spec.send;
    let total = to_send.len();

    // The sends run beside the reads (a server may answer each message before it reads the
    // next), as one future polled by the loop below until it hands the write half back.
    let mut sending = Box::pin(async {
        let mut sink = sink;
        for text in to_send {
            let bytes = text.len();
            let preview = cut_text(&text, PREVIEW_BYTES).0.to_string();
            sink.send(Message::Text(text.into()))
                .await
                .map_err(|e| e.to_string())?;
            flow.ws_sent(bytes);
            note(
                &log,
                Direction::Sent,
                PayloadKind::Text,
                bytes,
                Some(&preview),
            );
        }
        Ok::<_, String>(sink)
    });

    let hard_stop = opened + spec.send_budget + spec.wait;
    let mut listen_until = hard_stop;
    let mut write = None;
    let mut sending_done = false;
    let mut received = 0usize;
    let end = loop {
        tokio::select! {
            done = &mut sending, if !sending_done => {
                sending_done = true;
                match done {
                    Ok(sink) => {
                        write = Some(sink);
                        listen_until = hard_stop.min(Instant::now() + spec.wait);
                    }
                    Err(message) => break ExchangeEnd::Error { message },
                }
            }
            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    flow.ws_received(text.len());
                    note(&log, Direction::Received, PayloadKind::Text, text.len(), Some(text.as_str()));
                    received += 1;
                    if received >= max_messages {
                        break ExchangeEnd::MaxMessages;
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    flow.ws_received(bytes.len());
                    note(&log, Direction::Received, PayloadKind::Binary, bytes.len(), None);
                    received += 1;
                    if received >= max_messages {
                        break ExchangeEnd::MaxMessages;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame {
                        Some(f) => (Some(u16::from(f.code)), f.reason.as_str().to_string()),
                        None => (None, String::new()),
                    };
                    break ExchangeEnd::ServerClosed { code, reason };
                }
                // tungstenite answers Pings itself; `Frame` is never yielded to a reader.
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Err(e)) => break ExchangeEnd::Error { message: e.to_string() },
                None => break ExchangeEnd::ServerClosed { code: None, reason: String::new() },
            },
            () = tokio::time::sleep_until(listen_until.into()) => {
                break if sending_done { ExchangeEnd::Waited } else { ExchangeEnd::SendStalled };
            }
        }
    };
    // A stalled writer still holds the write half; dropping it lets the socket close.
    drop(sending);

    match &end {
        ExchangeEnd::Error { message } => flow.fail(message.clone()),
        ExchangeEnd::ServerClosed { .. } => {
            // tungstenite queued its answer to the server's Close; flush it out.
            if let Some(mut w) = write {
                let _ = tokio::time::timeout(CLOSE_GRACE, w.close()).await;
            }
            flow.done(None);
        }
        ExchangeEnd::Waited | ExchangeEnd::MaxMessages | ExchangeEnd::SendStalled => {
            if let Some(mut w) = write {
                let frame = CloseFrame {
                    code: CloseCode::Normal,
                    reason: "".into(),
                };
                let sent = tokio::time::timeout(CLOSE_GRACE, w.send(Message::Close(Some(frame))));
                if matches!(sent.await, Ok(Ok(()))) {
                    // Wait for the server's Close so both sides see a clean close. What still
                    // arrives is counted on the Network row, not added to the transcript.
                    let _ = tokio::time::timeout(CLOSE_GRACE, async {
                        while let Some(Ok(m)) = read.next().await {
                            match m {
                                Message::Text(t) => flow.ws_received(t.len()),
                                Message::Binary(b) => flow.ws_received(b.len()),
                                Message::Close(_) => break,
                                _ => {}
                            }
                        }
                    })
                    .await;
                }
            }
            flow.done(None);
        }
    }

    let log = log.into_inner().unwrap_or_else(|p| p.into_inner());
    Ok(Exchange {
        handshake_ms: millis(opened - started),
        sent: log.sent,
        unsent: total - log.sent,
        received,
        entries: log.entries,
        end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde_json::Value;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{
        ErrorResponse, Request as ServerRequest, Response as ServerResponse,
    };
    use tokio_tungstenite::tungstenite::http::StatusCode;

    use crate::api_store::{EnvVar, Environment};

    /// A header row.
    fn header(name: &str, value: &str) -> WsHeader {
        WsHeader {
            name: name.into(),
            value: value.into(),
        }
    }

    /// A Vault holding `vars` in its single, active environment.
    fn vault_with(vars: &[(&str, &str)]) -> ApiStore {
        ApiStore {
            environments: vec![Environment {
                id: "env-1".into(),
                name: "prod".into(),
                variables: vars
                    .iter()
                    .map(|(k, v)| EnvVar {
                        key: (*k).into(),
                        value: (*v).into(),
                    })
                    .collect(),
            }],
            active_environment_id: Some("env-1".into()),
            ..ApiStore::default()
        }
    }

    /// A temp directory holding a real `api-store.json`, removed on drop. Needed by the live
    /// tests, which drive the whole `connect` path — Vault file read included — and so must
    /// never point at the user's config dir.
    struct VaultFile {
        dir: PathBuf,
        path: PathBuf,
    }

    impl VaultFile {
        fn new(vars: &[(&str, &str)]) -> Self {
            let dir = std::env::temp_dir().join(format!("agentstudio-ws-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("api-store.json");
            crate::api_store::save(&path, &vault_with(vars)).unwrap();
            Self { dir, path }
        }
    }

    impl Drop for VaultFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// `connect_via` with no headers, so no Vault path is ever read (the pre-header
    /// behaviour), and no Network tap (the recording seam is `tests/netcap_record.rs`').
    fn connect_plain(url: String, on_event: Channel<String>) -> String {
        connect_via(
            url,
            Vec::new(),
            PathBuf::from("no-such-vault-and-none-is-read.json"),
            on_event,
            Tap::none(),
        )
    }

    /// Records the JSON event strings a `Channel<String>` is sent (a `string_channel`-style
    /// recorder, like the LSP tests). `Channel<String>::send` JSON-encodes the string, so we
    /// recover the raw JSON before storing it.
    fn recording_channel() -> (Channel<String>, Arc<Mutex<Vec<String>>>) {
        let store = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = store.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            let s = match body {
                InvokeResponseBody::Json(j) => serde_json::from_str::<String>(&j).unwrap_or(j),
                InvokeResponseBody::Raw(b) => String::from_utf8_lossy(&b).into_owned(),
            };
            sink.lock().unwrap().push(s);
            Ok(())
        });
        (channel, store)
    }

    /// Poll the recorder until an event with `kind` appears (or the deadline passes),
    /// returning it parsed. Deterministic via a bounded deadline + short sleeps — no reliance
    /// on ordering races.
    async fn wait_for_kind(store: &Arc<Mutex<Vec<String>>>, kind: &str) -> Option<Value> {
        wait_for_kind_within(store, kind, Duration::from_secs(5)).await
    }

    /// As [`wait_for_kind`], with an explicit budget — the live TLS smoke below needs more
    /// than the loopback tests' 5s (DNS + TCP + a real TLS handshake over the internet).
    async fn wait_for_kind_within(
        store: &Arc<Mutex<Vec<String>>>,
        kind: &str,
        budget: Duration,
    ) -> Option<Value> {
        let deadline = Instant::now() + budget;
        loop {
            let hit = store
                .lock()
                .unwrap()
                .iter()
                .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                .find(|v| v["kind"] == kind);
            if hit.is_some() {
                return hit;
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    /// A hermetic echo server on `127.0.0.1:0` (NO network): accept one client, then echo
    /// every Text/Binary frame back verbatim until it sees a Close (or the socket ends).
    /// Returns the bound address and a handle that completes when the peer has closed — so a
    /// test can assert "the server saw the close".
    async fn spawn_echo_server() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                match msg {
                    Message::Text(_) | Message::Binary(_) => {
                        if ws.send(msg).await.is_err() {
                            break;
                        }
                    }
                    // The client closed: the loop ends, so awaiting the handle observes it.
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        (addr, handle)
    }

    /// A hermetic **authenticating** server on `127.0.0.1:0`: it accepts the handshake only when
    /// the request carries `Authorization: <expected>`, and answers `401 Unauthorized`
    /// otherwise — a real server, reduced to the one behaviour that matters.
    ///
    /// This is the negative control. A test that only proves "a connection
    /// with a header opens" passes identically against a server that never looked at the header;
    /// the same fixture must be able to say **no**. `seen` records the value the server actually
    /// read off the wire, so the assertion is about the bytes that arrived, not about our own
    /// request struct.
    ///
    /// Loopback only, and started by this test — never a real endpoint or real credentials.
    async fn spawn_auth_server(expected: &'static str) -> (SocketAddr, Arc<Mutex<Option<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let recorder = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let recorder = recorder.clone();
                // `ErrorResponse` is `http::Response<Option<String>>` — tungstenite's own
                // rejection type, so its size is not ours to box away.
                #[allow(clippy::result_large_err)]
                let callback = move |req: &ServerRequest,
                                     resp: ServerResponse|
                      -> Result<ServerResponse, ErrorResponse> {
                    let got = req
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    *recorder.lock().unwrap() = got.clone();
                    if got.as_deref() == Some(expected) {
                        Ok(resp)
                    } else {
                        // A hostile server: it quotes the credential it disliked straight back
                        // into the rejection. Nothing in the client may repeat that to the UI.
                        let mut err = ErrorResponse::new(Some(format!(
                            "unauthorized — token {} is not valid",
                            got.unwrap_or_default()
                        )));
                        *err.status_mut() = StatusCode::UNAUTHORIZED;
                        Err(err)
                    }
                };
                if let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(socket, callback).await {
                    // Hold the accepted socket open until the client closes it.
                    while let Some(Ok(msg)) = ws.next().await {
                        if matches!(msg, Message::Close(_)) {
                            break;
                        }
                    }
                }
            }
        });
        (addr, seen)
    }

    // ── request building (hermetic, no socket at all) ──────────────────────────

    #[test]
    fn build_request_keeps_every_handshake_header_and_adds_the_custom_one() {
        let (request, secrets) = build_request(
            "ws://127.0.0.1:8064/ws?room=1",
            &[header("Authorization", "Bearer abc123")],
            &ApiStore::default(),
        )
        .expect("a valid URL and a valid header");

        let headers = request.headers();
        // Hand-written expectations: these are the five tungstenite's
        // `generate_request` *requires*, and dropping any one of them is a handshake that
        // fails looking like a server fault.
        assert_eq!(headers.get("host").unwrap(), "127.0.0.1:8064");
        assert_eq!(headers.get("connection").unwrap(), "Upgrade");
        assert_eq!(headers.get("upgrade").unwrap(), "websocket");
        assert_eq!(headers.get("sec-websocket-version").unwrap(), "13");
        assert!(
            headers
                .get("sec-websocket-key")
                .is_some_and(|k| !k.is_empty()),
            "a Sec-WebSocket-Key must be generated"
        );
        assert_eq!(headers.get("authorization").unwrap(), "Bearer abc123");
        assert_eq!(request.uri().to_string(), "ws://127.0.0.1:8064/ws?room=1");
        assert!(
            secrets.is_empty(),
            "a literal value resolves no Vault variable"
        );
    }

    #[test]
    fn build_request_refuses_each_handshake_header_by_name() {
        // Every spelling the user could type, including the wrong case — `HeaderName`
        // lower-cases, so the guard must match after normalisation, not before.
        for name in [
            "Host",
            "CONNECTION",
            "Upgrade",
            "Sec-WebSocket-Key",
            "sec-websocket-version",
        ] {
            let err = build_request(
                "ws://127.0.0.1:9/",
                &[header(name, "whatever")],
                &ApiStore::default(),
            )
            .expect_err("a handshake header must be refused");
            assert!(
                err.contains(&name.to_ascii_lowercase()),
                "the refusal must name {name}: {err}"
            );
        }
    }

    #[test]
    fn build_request_appends_a_duplicate_custom_header() {
        // The documented choice: repeated rows are a list, both go on the wire (as in
        // `http.rs` and gRPC's `build_metadata`), rather than one silently winning.
        let (request, _) = build_request(
            "ws://127.0.0.1:9/",
            &[header("X-Scope", "a"), header("X-Scope", "b")],
            &ApiStore::default(),
        )
        .expect("duplicates are legal");
        let values: Vec<_> = request
            .headers()
            .get_all("x-scope")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(values, vec!["a", "b"]);
    }

    #[test]
    fn build_request_refuses_an_invalid_name_or_value_naming_the_header() {
        let bad_name = build_request(
            "ws://127.0.0.1:9/",
            &[header("bad header", "x")],
            &ApiStore::default(),
        )
        .expect_err("a space is not a legal header name");
        assert!(
            bad_name.contains("invalid header name") && bad_name.contains("bad header"),
            "got: {bad_name}"
        );

        let bad_value = build_request(
            "ws://127.0.0.1:9/",
            &[header("X-Thing", "line one\nline two")],
            &ApiStore::default(),
        )
        .expect_err("a newline is not a legal header value");
        assert!(
            bad_value.contains("invalid header value") && bad_value.contains("X-Thing"),
            "got: {bad_value}"
        );
        assert!(
            !bad_value.contains("line one"),
            "the value must never be quoted back — it may be the token: {bad_value}"
        );
    }

    // ── {{VAR}} resolution + secret hygiene ───────────────────────────────────

    #[test]
    fn build_request_resolves_a_vault_reference_into_the_header_value() {
        let vault = vault_with(&[("WS_TOKEN", "s3cr3t-value")]);
        let (request, secrets) = build_request(
            "ws://127.0.0.1:9/",
            &[header("Authorization", "Bearer {{WS_TOKEN}}")],
            &vault,
        )
        .expect("the variable exists");

        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer s3cr3t-value",
            "the resolved token goes on the wire, and only there"
        );
        assert_eq!(
            secrets,
            vec!["s3cr3t-value".to_string()],
            "the resolved value must be handed to the redactor"
        );
    }

    #[test]
    fn build_request_reports_a_missing_variable_by_name_and_never_a_value() {
        let vault = vault_with(&[("WS_TOKEN", "s3cr3t-value")]);
        let err = build_request(
            "ws://127.0.0.1:9/",
            &[
                header("Authorization", "Bearer {{WS_TOKEN}}"),
                header("X-Other", "{{NOPE}}"),
            ],
            &vault,
        )
        .expect_err("an unset variable is an error, not an empty header");

        assert!(err.contains("{{NOPE}}"), "name the variable: {err}");
        assert!(err.contains("X-Other"), "name the header: {err}");
        assert!(
            !err.contains("s3cr3t-value"),
            "a value resolved by an EARLIER header must not ride along: {err}"
        );
    }

    #[test]
    fn substitution_leaves_a_malformed_or_empty_placeholder_literal() {
        // Matches `substitute.ts` exactly. Rewriting these to "" would blank a header the
        // user meant to send and hand them back the unexplained 401.
        let vault = vault_with(&[("A", "resolved")]);
        let cases: &[(&str, &str)] = &[
            ("{{", "{{"),
            ("no braces", "no braces"),
            ("{{}}", "{{}}"),
            ("{{ }}", "{{ }}"),
            ("{{ A }}", "resolved"),
            ("{{{A}}}", "{resolved}"),
            ("x {{A}} y {{A}} z", "x resolved y resolved z"),
        ];
        for (input, want) in cases {
            let mut secrets = Vec::new();
            assert_eq!(
                substitute(input, &vault, &mut secrets).as_deref(),
                Ok(*want),
                "input {input:?}"
            );
        }
    }

    #[test]
    fn an_invalid_resolved_value_is_refused_without_echoing_the_secret() {
        // A Vault entry with a stray newline: legal in the Vault, illegal in a header. The
        // refusal must name the header and stop there.
        let vault = vault_with(&[("WS_TOKEN", "top\nsecret")]);
        let err = build_request(
            "ws://127.0.0.1:9/",
            &[header("Authorization", "Bearer {{WS_TOKEN}}")],
            &vault,
        )
        .expect_err("a newline cannot go in a header value");
        assert!(err.contains("Authorization"), "name the header: {err}");
        assert!(
            !err.contains("top") && !err.contains("secret"),
            "the resolved value must not appear: {err}"
        );
    }

    #[tokio::test]
    async fn an_error_event_masks_every_resolved_secret_including_its_encoded_form() {
        let (channel, store) = recording_channel();
        // Hostile on purpose: punctuation a naive `format!`-and-hope would mangle, and a
        // percent-encodable space so the encoded-form branch of `redact` is exercised too.
        let secret = "p@ss w#rd/+&=?".to_string();
        let encoded = crate::db::url::encode_userinfo(&secret);

        emit_error(
            &channel,
            format!("HTTP error: 401 Unauthorized (sent {secret}, encoded {encoded})"),
            std::slice::from_ref(&secret),
        );

        let event: Value = serde_json::from_str(&store.lock().unwrap()[0]).unwrap();
        let message = event["message"].as_str().unwrap();
        assert!(
            !message.contains(&secret) && !message.contains(&encoded),
            "neither the raw nor the encoded secret may survive: {message}"
        );
        assert!(
            message.contains(crate::db::error::MASK),
            "and it must be visibly masked, not deleted: {message}"
        );
        assert!(
            message.contains("401 Unauthorized"),
            "the diagnosis itself must survive redaction: {message}"
        );
    }

    // ── live: a local server that actually enforces the header ────────────────

    #[tokio::test]
    async fn a_custom_header_reaches_the_server_and_opens_the_socket() {
        let (addr, seen) = spawn_auth_server("Bearer live-token").await;
        let (channel, store) = recording_channel();

        let id = connect_via(
            format!("ws://{addr}/ws?room=1"),
            vec![header("Authorization", "Bearer live-token")],
            PathBuf::from("unused-no-placeholder.json"),
            channel,
            Tap::none(),
        );

        assert!(
            wait_for_kind(&store, "open").await.is_some(),
            "the handshake must succeed WITH the header; events: {:?}",
            store.lock().unwrap()
        );
        assert_eq!(
            seen.lock().unwrap().as_deref(),
            Some("Bearer live-token"),
            "the server must have read our header off the wire"
        );
        let _ = ws_close(id);
    }

    #[tokio::test]
    async fn without_the_header_the_same_server_answers_401() {
        // The negative control. Without it the test above passes just as well
        // against a server that never inspected a header — i.e. it would measure nothing.
        let (addr, seen) = spawn_auth_server("Bearer live-token").await;
        let (channel, store) = recording_channel();

        let _id = connect_plain(format!("ws://{addr}/ws?room=1"), channel);

        let err = wait_for_kind(&store, "error")
            .await
            .expect("a rejected handshake must push an `error` event");
        let message = err["message"].as_str().unwrap();
        assert!(
            message.contains(StatusCode::UNAUTHORIZED.as_str()),
            "the exact symptom, reproduced: {message}"
        );
        assert!(
            seen.lock().unwrap().is_none(),
            "no Authorization was sent, which is why it was refused"
        );
        assert!(
            wait_for_kind_within(&store, "open", Duration::from_millis(200))
                .await
                .is_none(),
            "and the socket must NOT open"
        );
    }

    #[tokio::test]
    async fn a_vault_resolved_header_authenticates_and_a_wrong_one_never_leaks_it() {
        let secret = "live-vault-token";
        let vault = VaultFile::new(&[("WS_TOKEN", secret)]);
        let (addr, seen) = spawn_auth_server("Bearer live-vault-token").await;

        // (a) the `{{VAR}}` is resolved in Rust and the server sees the real token.
        let (channel, store) = recording_channel();
        let id = connect_via(
            format!("ws://{addr}/ws"),
            vec![header("Authorization", "Bearer {{WS_TOKEN}}")],
            vault.path.clone(),
            channel,
            Tap::none(),
        );
        assert!(
            wait_for_kind(&store, "open").await.is_some(),
            "a Vault-resolved header must authenticate; events: {:?}",
            store.lock().unwrap()
        );
        assert_eq!(
            seen.lock().unwrap().as_deref(),
            Some("Bearer live-vault-token"),
            "the SUBSTITUTED value is what reached the wire"
        );
        let _ = ws_close(id);

        // (b) the same value against a server that now refuses it: the rejection quotes the
        // token back at us, and the UI must still never see it.
        let (addr2, _seen2) = spawn_auth_server("Bearer something-else").await;
        let (channel2, store2) = recording_channel();
        let _id2 = connect_via(
            format!("ws://{addr2}/ws"),
            vec![header("Authorization", "Bearer {{WS_TOKEN}}")],
            vault.path.clone(),
            channel2,
            Tap::none(),
        );
        let err = wait_for_kind(&store2, "error")
            .await
            .expect("a rejected handshake must push an `error` event");
        let message = err["message"].as_str().unwrap();
        assert!(
            !message.contains(secret),
            "🔴 the resolved token leaked into an error event: {message}"
        );
    }

    #[tokio::test]
    async fn connect_emits_open_then_echoes_a_text_message() {
        let (addr, _server) = spawn_echo_server().await;
        let (channel, store) = recording_channel();

        let id = connect_plain(format!("ws://{addr}/"), channel);
        assert!(
            wait_for_kind(&store, "open").await.is_some(),
            "an `open` event must arrive after the handshake"
        );

        ws_send(id.clone(), "hello ws".to_string()).unwrap();
        let msg = wait_for_kind(&store, "message")
            .await
            .expect("the echoed frame must arrive as a `message` event");
        assert_eq!(msg["data"], "hello ws");

        ws_close(id).unwrap();
    }

    #[tokio::test]
    async fn close_emits_closed_and_the_server_sees_the_close() {
        let (addr, server) = spawn_echo_server().await;
        let (channel, store) = recording_channel();

        let id = connect_plain(format!("ws://{addr}/"), channel);
        assert!(wait_for_kind(&store, "open").await.is_some(), "opened");

        ws_close(id).unwrap();

        assert!(
            wait_for_kind(&store, "closed").await.is_some(),
            "closing must push a `closed` event"
        );
        // The server's read loop ended → it observed our Close frame.
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("the echo server must observe the close")
            .unwrap();
    }

    #[tokio::test]
    async fn connecting_to_a_dead_port_emits_an_error() {
        // Bind then drop, so nothing is accepting on the port.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let (channel, store) = recording_channel();
        let _id = connect_plain(format!("ws://{addr}/"), channel);

        let err = wait_for_kind(&store, "error")
            .await
            .expect("a refused connection must push an `error` event");
        assert!(
            err["message"].as_str().is_some_and(|m| !m.is_empty()),
            "the error event carries a message: {err}"
        );
    }

    // ── live TLS smoke: the ONE ws test that leaves the machine ────────────────
    //
    // Every test above talks plaintext `ws://` to a loopback echo server, so **the `wss://`
    // path had no test at all** — and the TLS policy changed both the crypto provider (`ring`,
    // installed in `crate::tls`) and the root store (OS anchors ∪ Mozilla) underneath it.
    // `#[ignore]`d so `cargo test`/CI stay hermetic (no network needed), matching
    // `usage.rs`'s `live_smoke_reads_real_usage_from_the_cli`. Run after touching any
    // `rustls`/`tokio-tungstenite` feature:
    //
    //     cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_smoke
    #[tokio::test]
    #[ignore = "reaches the public internet over TLS — run with --ignored"]
    async fn live_smoke_wss_completes_a_real_tls_handshake() {
        let (channel, store) = recording_channel();
        // The long-running public echo service. What is under test is the handshake, not
        // the echo: an `open` event means the TLS session was established AND the peer's
        // chain validated against our root store. A provider or trust-root regression
        // shows up as an `error` event instead, with the rustls reason in it.
        let id = connect_plain("wss://echo.websocket.org/".to_string(), channel);

        let opened = wait_for_kind_within(&store, "open", Duration::from_secs(30)).await;
        if opened.is_none() {
            let err = wait_for_kind_within(&store, "error", Duration::from_secs(1)).await;
            panic!(
                "no `open` over wss://. If the message below mentions a certificate, \
                 UnknownIssuer or InvalidCertificate, the TLS provider or root store \
                 regressed (src/tls.rs); if it mentions dns/connect, check the \
                 network, and if the host itself is gone, retarget this test. error: {err:?}"
            );
        }

        let _ = ws_close(id);
    }

    #[tokio::test]
    async fn sending_to_an_unknown_connection_errors() {
        let err = ws_send("no-such-id".to_string(), "x".to_string()).unwrap_err();
        assert!(err.contains("unknown websocket connection"), "got: {err}");
    }

    #[tokio::test]
    async fn closing_an_unknown_connection_errors() {
        let err = ws_close("no-such-id".to_string()).unwrap_err();
        assert!(err.contains("unknown websocket connection"), "got: {err}");
    }

    // ── exchange transcript bounds (hermetic; the live exchange is in
    //    tests/agent_stream_tools.rs) ───────────────────────────────────────────

    #[test]
    fn text_is_cut_on_a_character_boundary_and_says_so() {
        assert_eq!(cut_text("hello", 10), ("hello", false));
        assert_eq!(cut_text("hello", 5), ("hello", false));
        assert_eq!(cut_text("hello", 3), ("hel", true));
        // "é" is two bytes: a cut inside it backs off to before it, never splits it.
        assert_eq!(cut_text("aé", 2), ("a", true));
        assert_eq!(cut_text("", 0), ("", false));
    }

    #[test]
    fn a_transcript_keeps_a_preview_per_message_and_stops_keeping_text_at_its_budget() {
        let mut log = Log::new(Instant::now());
        let big = "x".repeat(PREVIEW_BYTES + 10);
        log.push(
            Direction::Received,
            PayloadKind::Text,
            big.len(),
            Some(&big),
        );
        let first = &log.entries[0];
        assert_eq!(first.text.as_deref().map(str::len), Some(PREVIEW_BYTES));
        assert!(first.truncated, "a cut message is marked");
        assert_eq!(first.bytes, PREVIEW_BYTES + 10, "its real size is kept");

        log.push(Direction::Sent, PayloadKind::Text, 2, Some("hi"));
        assert_eq!(log.entries[1].text.as_deref(), Some("hi"));
        assert!(!log.entries[1].truncated);
        assert_eq!(log.sent, 1);

        log.push(Direction::Received, PayloadKind::Binary, 12, None);
        assert_eq!(log.entries[2].text, None);
        assert!(
            !log.entries[2].truncated,
            "binary is listed by size, not cut"
        );

        // Spend the rest of the budget, then one more: listed by size only, marked.
        while log.text_left >= PREVIEW_BYTES {
            log.push(
                Direction::Received,
                PayloadKind::Text,
                big.len(),
                Some(&big),
            );
        }
        let rest = "y".repeat(log.text_left + 1);
        log.push(
            Direction::Received,
            PayloadKind::Text,
            rest.len(),
            Some(&rest),
        );
        assert_eq!(log.text_left, 0);
        log.push(Direction::Received, PayloadKind::Text, 3, Some("abc"));
        let last = log.entries.last().unwrap();
        assert_eq!(last.text, None);
        assert!(last.truncated);
        let kept: usize = log
            .entries
            .iter()
            .filter_map(|e| e.text.as_ref().map(String::len))
            .sum();
        assert_eq!(
            kept, TRANSCRIPT_TEXT_BYTES,
            "never more text than the budget"
        );
        // An empty message costs nothing and is whole even with no budget left.
        log.push(Direction::Received, PayloadKind::Text, 0, Some(""));
        assert_eq!(log.entries.last().unwrap().text.as_deref(), Some(""));
        assert!(!log.entries.last().unwrap().truncated);
    }
}
