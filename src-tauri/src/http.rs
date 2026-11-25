//! The built-in API client's HTTP engine.
//!
//! A single async `http_send` command runs an arbitrary outbound request in the Rust
//! core (not the webview's `fetch`, which CORS/CSP would hobble and which can't set
//! headers like `Host`). Requests are **not** URL-scoped — reaching arbitrary hosts is
//! the whole feature — so the safeguards are the ones that keep a runaway request from
//! hurting *us*, mirroring `find_in_files`' guardrails:
//!
//! * a **30s timeout** ([`REQUEST_TIMEOUT`]) bounds a stuck endpoint,
//! * an **8 MiB response-body cap** ([`MAX_BODY_BYTES`]) on the *decoded* body, applied while
//!   reading: the body is read chunk by chunk and reading **stops** as soon as more than the
//!   cap has arrived, so an endless stream or a small gzip body that inflates to gigabytes
//!   costs at most the cap in memory and cannot flood the IPC channel / UI (`truncated` flags
//!   the cut; `size_bytes` is then what was read, a lower bound of the real length),
//! * no engine error carries the request URL: reqwest appends ` for url (…)` with the URL
//!   **as sent**, i.e. with every `{{VAR}}` already substituted, and the API history keeps
//!   the error text ([`map_send_error`]),
//! * bodies are returned as lossy UTF-8 text (binary responses are not corrupted on the
//!   wire, just rendered as text for v1).
//!
//! HTTP is via `reqwest` with **rustls** and no default TLS, keeping us off the system
//! OpenSSL (dependency hygiene). `gzip`/`brotli`/`deflate` are decoded
//! automatically, so the returned body is the decompressed payload.
//!
//! **TLS** follows the app-wide policy in [`crate::tls`]: the single `ring`
//! crypto provider, and certificate verification delegated to the **operating system's
//! trust store** via `rustls-platform-verifier` — so an internal HTTPS host signed by a
//! corporate CA, or a laptop behind a TLS-inspecting proxy, works here exactly as it does
//! in the user's browser. `reqwest` is built with `rustls-no-provider`, which means
//! [`Client::builder`] **panics** unless a provider was installed first; that is why
//! [`CLIENT`]'s initializer calls [`crate::tls::install_crypto_provider`] before touching
//! the builder — and `CLIENT` is the only place a builder is touched (see its doc for the
//! measured cost of building one per request).
//!
//! Only transport failures are `Err` (timeout, connect/DNS, malformed request); an HTTP
//! error *status* (404, 500, …) is a perfectly normal [`HttpResponse`].
//!
//! **Network view.** Every send is recorded into the netcap store
//! through [`crate::netcap::record`] — a tap, not a proxy round-trip, because this client runs
//! inside the IDE process and its traffic never crosses the capture proxy. The pending row
//! shows the request **as sent**: what reqwest and hyper add on top of the user's headers is
//! reconstructed by [`headers_as_sent`], whose every rule names its source and is proven by
//! `tests/netcap_record.rs` against a loopback server that echoes what it received.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::header::{self, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method, Url, Version};
use serde::{Deserialize, Serialize};

use crate::netcap::record::{self, Flow, Tap};
use crate::netcap::FlowProto;

/// The ONE `reqwest::Client` every request goes through, built on first use.
///
/// 🔴 **A `Client` owns the connection pool, so building one per request throws the pool
/// away**: every send would pay a DNS lookup, a TCP connect and a TLS handshake and then drop
/// the connection, where a shared client re-uses a warm keep-alive connection. On a remote
/// HTTPS endpoint that is the difference between well over a second and a few hundred
/// milliseconds per request. Building a client is not free either — it constructs the TLS
/// stack, and with the platform verifier that touches the OS trust store — so the cost would
/// be paid even for plain-HTTP requests to localhost.
///
/// A `Result`, not a panic: `build()` realistically fails only when no crypto provider is
/// installed, and this module's contract has always been a mapped error string, never a
/// crash. The provider install lives INSIDE the closure so no path — `run()`, a test, a
/// future non-Tauri caller — can reach the builder before it (idempotent; `src/tls.rs`).
/// A failed first build stays failed on purpose: the closure already did the one thing a
/// retry could do.
static CLIENT: LazyLock<Result<Client, String>> = LazyLock::new(|| {
    crate::tls::install_crypto_provider();
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // Follow redirects (reqwest's default, up to 10) — an API client is expected to.
        .redirect(reqwest::redirect::Policy::default())
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
});

/// Response bodies larger than this (decoded) are truncated to it (`truncated = true`), and
/// reading stops there, so a multi-gigabyte download — or a decompression bomb — can't flood
/// memory, the IPC channel or the UI.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Whole-request deadline. A stuck or slow endpoint is bounded to this rather than
/// hanging the UI on a request that never completes. A caller may ask for less
/// ([`send_bounded`]), never more: it is also the shared client's own timeout.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// One request/response header. Duplicates are kept as separate rows (HTTP allows a
/// header name to repeat), so this is a flat list, not a map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

/// The request to send. `method` is any HTTP verb (validated on send); `body` is sent
/// as-is for any method when `Some`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: Option<String>,
}

/// The response handed back to the frontend. See the module doc for the caps.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    /// Numeric status, e.g. `200`.
    pub status: u16,
    /// Canonical reason phrase for the status, e.g. `"OK"` (empty for an unknown code).
    pub status_text: String,
    /// Response headers, in the order reqwest yields them; duplicates stay separate.
    pub headers: Vec<HttpHeader>,
    /// The (possibly capped) body, decoded lossily as UTF-8.
    pub body: String,
    /// Wall time of the round-trip (send → full body read), in milliseconds.
    pub duration_ms: u64,
    /// Decoded body length in bytes. When `truncated`, the bytes read before reading stopped —
    /// more than the cap, and a lower bound of the real length (the rest was never read).
    pub size_bytes: usize,
    /// `true` iff the body was longer than the cap ([`MAX_BODY_BYTES`]) and was cut there.
    pub truncated: bool,
}

/// A response body read under a cap: keeps at most `cap` bytes and says when to stop reading.
/// Factored out so the truncation boundary is unit-testable with a tiny limit — no need to move
/// 8 MiB to prove the flag flips.
#[derive(Debug)]
struct CappedBody {
    cap: usize,
    kept: Vec<u8>,
    /// Every byte seen so far, kept or not.
    seen: usize,
}

impl CappedBody {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            kept: Vec::new(),
            seen: 0,
        }
    }

    /// Take one decoded chunk. `false` once more than the cap has arrived: the caller stops
    /// reading there, so whatever is still to come — an endless stream, the rest of a
    /// decompression bomb — is never read, inflated or held.
    fn push(&mut self, chunk: &[u8]) -> bool {
        self.seen = self.seen.saturating_add(chunk.len());
        let room = self.cap.saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
        !self.truncated()
    }

    fn truncated(&self) -> bool {
        self.seen > self.cap
    }
}

/// Read `resp`'s (decoded) body chunk by chunk into a [`CappedBody`], stopping at the cap.
async fn read_capped(resp: &mut reqwest::Response, cap: usize) -> reqwest::Result<CappedBody> {
    let mut body = CappedBody::new(cap);
    while let Some(chunk) = resp.chunk().await? {
        if !body.push(&chunk) {
            break;
        }
    }
    Ok(body)
}

/// Turn a reqwest error into a short, human-readable string. Distinguishes the causes a
/// user can act on (timeout, unreachable host) from the catch-all. `timeout` is the
/// deadline the request ran under, so the sentence names the one that fired.
///
/// 🔴 The URL is dropped from the error before it is formatted: reqwest's `Display` appends
/// ` for url (<the URL as sent>)`, which is the URL **after** `{{VAR}}` substitution — the
/// user's Vault values. The console shows this text, the API history file keeps it, and agents
/// read the history; the request's own URL is shown next to the error everywhere anyway.
fn map_send_error(e: reqwest::Error, timeout: Duration) -> String {
    let host = e.url().and_then(|u| u.host_str()).map(str::to_string);
    let e = e.without_url();
    if e.is_timeout() {
        if timeout.subsec_millis() == 0 {
            format!("request timed out after {}s", timeout.as_secs())
        } else {
            format!("request timed out after {} ms", timeout.as_millis())
        }
    } else if e.is_connect() {
        match host {
            Some(host) => format!("could not connect: {host}"),
            None => "could not connect".to_string(),
        }
    } else if e.is_redirect() {
        format!("too many redirects: {e}")
    } else if e.is_request() {
        format!("invalid request: {e}")
    } else {
        e.to_string()
    }
}

/// What tower-http's `Decompression` layer (behind reqwest's `gzip`/`brotli`/`deflate`
/// features) puts in `accept-encoding` when the user set none — its
/// `AcceptEncoding::to_header_value`, in its order.
const ACCEPT_ENCODING_SENT: &str = "gzip,deflate,br";

/// Headers hyper refuses to carry on HTTP/2 (`proto::h2::strip_connection_headers`).
const H2_STRIPPED: [&str; 5] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
];

/// hyper's `method_has_defined_payload_semantics`: an empty HTTP/2 body still gets
/// `content-length: 0` for these methods' complement.
fn payload_method(method: &Method) -> bool {
    !matches!(
        *method,
        Method::GET | Method::HEAD | Method::DELETE | Method::CONNECT
    )
}

/// The request headers **as sent** — what the Network view's row shows, so it is the request
/// that reached the server rather than the one that was typed. reqwest exposes no hook on the
/// bytes, so this is reconstructed; each rule names its source, and `tests/netcap_record.rs`
/// compares the result with what a loopback server actually received — a wrong rule is a
/// red test, never a wrong row. `version` is `None` before the response arrives (HTTP/1.1
/// assumed; `http://` is always 1.1 here) and the real negotiated version after it.
///
/// 1. URL userinfo (`http://user:pw@host/`) becomes `authorization: Basic …` — reqwest's
///    `RequestBuilder::new` inserts it first, and a user `authorization` replaces it in place.
/// 2. The user's headers, in order (`append`, so duplicates stay); on HTTP/2 hyper drops the
///    connection-specific ones ([`H2_STRIPPED`], and `te` unless it is `trailers`).
/// 3. `accept: */*` — reqwest's default header, merged only when no `accept` was set.
/// 4. `accept-encoding` — tower-http, only when none was set ([`ACCEPT_ENCODING_SENT`]).
/// 5. `host` — hyper-util's legacy client, **HTTP/1 only**, `host[:port]` with the port omitted
///    when it is the scheme's default (on HTTP/2 the authority is a pseudo-header).
/// 6. `content-length` — hyper: on HTTP/1 only when a non-empty body is sent (an empty body is
///    "no body"); on HTTP/2 also `0` for a method with payload semantics (POST, PUT, PATCH…).
fn headers_as_sent(
    map: &HeaderMap,
    method: &Method,
    url: &Url,
    body: Option<&str>,
    version: Option<Version>,
) -> Vec<(String, String)> {
    let h2 = version == Some(Version::HTTP_2);
    let mut out: Vec<(String, String)> = Vec::with_capacity(map.len() + 5);
    let userinfo = !url.username().is_empty() || url.password().is_some();
    if userinfo {
        // reqwest inserted it first; a user `authorization` then replaces it IN PLACE.
        let own: Vec<String> = map
            .get_all(header::AUTHORIZATION)
            .iter()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect();
        if own.is_empty() {
            let user = percent_encoding::percent_decode_str(url.username()).decode_utf8_lossy();
            let pass = url
                .password()
                .map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy())
                .unwrap_or_default();
            let b64 = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
            out.push(("authorization".into(), format!("Basic {b64}")));
        } else {
            out.extend(own.into_iter().map(|v| ("authorization".to_string(), v)));
        }
    }
    for (k, v) in map {
        let name = k.as_str();
        if userinfo && name == "authorization" {
            continue;
        }
        let value = String::from_utf8_lossy(v.as_bytes()).into_owned();
        if h2 && (H2_STRIPPED.contains(&name) || (name == "te" && value != "trailers")) {
            continue;
        }
        out.push((name.to_string(), value));
    }
    if !map.contains_key(header::ACCEPT) {
        out.push(("accept".into(), "*/*".into()));
    }
    if !map.contains_key(header::ACCEPT_ENCODING) {
        out.push(("accept-encoding".into(), ACCEPT_ENCODING_SENT.into()));
    }
    if !h2 && !map.contains_key(header::HOST) {
        if let Some(host) = url.host_str() {
            let host = match url.port() {
                Some(p) => format!("{host}:{p}"),
                None => host.to_string(),
            };
            out.push(("host".into(), host));
        }
    }
    if !map.contains_key(header::CONTENT_LENGTH) {
        let len = body.map_or(0, str::len);
        let sent = if h2 {
            len != 0 || payload_method(method)
        } else {
            len != 0
        };
        if sent {
            out.push(("content-length".into(), len.to_string()));
        }
    }
    out
}

/// The pending Network row for a request about to go out — nothing for a URL reqwest would
/// refuse anyway (a scheme other than http/https has no row to show).
fn start_flow(tap: &Tap, method: &Method, url: &Url, map: &HeaderMap, body: Option<&str>) -> Flow {
    let proto = match url.scheme() {
        "http" => FlowProto::Http,
        "https" => FlowProto::Https,
        _ => return Flow::none(),
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return Flow::none();
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let mut path = url.path().to_string();
    if let Some(q) = url.query() {
        path.push('?');
        path.push_str(q);
    }
    let flow = tap.start(
        proto,
        method.as_str(),
        host,
        port,
        &path,
        "",
        headers_as_sent(map, method, url, body, None),
    );
    if let Some(b) = body {
        flow.request_body(b.as_bytes(), b.len() as u64);
    }
    flow
}

/// Testable core: send `request`, capping the response body at `body_cap` and the whole
/// exchange at `timeout`, recording the flow into `tap`. The `#[tauri::command]` wrapper
/// passes the production [`MAX_BODY_BYTES`], [`REQUEST_TIMEOUT`] and the app's tap; tests
/// inject a tiny cap to exercise truncation without a huge payload.
///
/// The deadline is reqwest's per-request timeout rather than a future dropped from outside,
/// so a timed-out request still ends its Network row as an error instead of leaving it
/// pending forever.
async fn send_with(
    request: HttpRequest,
    body_cap: usize,
    timeout: Duration,
    tap: &Tap,
) -> Result<HttpResponse, String> {
    let timeout = timeout.min(REQUEST_TIMEOUT);
    // Validate the verb up front (uppercased, so `get` → `GET`). An internal space or
    // other non-token byte — e.g. `"BOGUS METHOD"` — is rejected here, before any I/O.
    let method = Method::from_bytes(request.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("invalid HTTP method: {}", request.method))?;

    // Parse the URL explicitly for a friendly early error instead of a builder error
    // surfacing later at send time.
    let url = reqwest::Url::parse(request.url.trim()).map_err(|e| format!("invalid URL: {e}"))?;

    // The shared client (see `CLIENT`): cloning is an `Arc` bump, and the clone SHARES the
    // pool — which is the whole point. The crypto provider was installed by its closure.
    let client = CLIENT.as_ref().map_err(String::clone)?.clone();

    // Build the header map. A malformed name/value is surfaced as an error rather than
    // silently dropped, so the user learns why a header didn't take. `append` (not
    // `insert`) preserves duplicates the caller sent.
    let mut header_map = HeaderMap::new();
    for h in &request.headers {
        let name = HeaderName::from_bytes(h.name.as_bytes())
            .map_err(|_| format!("invalid header name: {:?}", h.name))?;
        let value = HeaderValue::from_str(&h.value)
            .map_err(|_| format!("invalid header value for {:?}", h.name))?;
        header_map.append(name, value);
    }

    // Everything above is validation with no I/O — a request that never leaves has no row.
    // From here on the flow is pending in the Network view.
    let body_text = request.body;
    let body = body_text.as_deref();
    let flow = start_flow(tap, &method, &url, &header_map, body);

    let mut req = client
        .request(method.clone(), url.clone())
        .headers(header_map.clone())
        .timeout(timeout);
    if let Some(b) = body {
        req = req.body(b.to_string());
    }

    let start = Instant::now();
    let mut resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let e = map_send_error(e, timeout);
            flow.fail(e.clone());
            return Err(e);
        }
    };

    // Read status + headers before reading the body.
    let status = resp.status();
    let status_code = status.as_u16();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers: Vec<HttpHeader> = resp
        .headers()
        .iter()
        .map(|(name, value)| HttpHeader {
            name: name.as_str().to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        })
        .collect();

    // Now the negotiated version is known: an HTTP/2 request carried no `host` header.
    let version = resp.version();
    if version == Version::HTTP_2 {
        flow.request_headers(headers_as_sent(
            &header_map,
            &method,
            &url,
            body,
            Some(version),
        ));
    }
    flow.response_head(
        status_code,
        &record::http_version(version),
        headers
            .iter()
            .map(|h| (h.name.clone(), h.value.clone()))
            .collect(),
    );

    // At most `body_cap` decoded bytes are ever held: reading stops once the cap is passed,
    // and dropping `resp` then closes the connection instead of draining the rest.
    let read = match read_capped(&mut resp, body_cap).await {
        Ok(b) => b,
        Err(e) => {
            let e = map_send_error(e, timeout);
            flow.fail(e.clone());
            return Err(e);
        }
    };
    drop(resp);
    let duration_ms = start.elapsed().as_millis() as u64;
    // The store applies its own 1 MiB cap. The console and the Network row report the SAME
    // duration and size.
    flow.response_body(&read.kept, read.seen as u64);
    flow.done(Some(duration_ms));

    let (size_bytes, truncated) = (read.seen, read.truncated());
    let body = String::from_utf8_lossy(&read.kept).into_owned();

    Ok(HttpResponse {
        status: status_code,
        status_text,
        headers,
        body,
        duration_ms,
        size_bytes,
        truncated,
    })
}

/// [`send_with`] with the app's tap — which records nothing under `cargo test`, where the
/// proxy never starts. The unit tests' entry point (they inject a tiny body cap).
#[cfg(test)]
async fn send(request: HttpRequest, body_cap: usize) -> Result<HttpResponse, String> {
    send_with(request, body_cap, REQUEST_TIMEOUT, &Tap::global()).await
}

/// [`http_send`] with the Network tap injected instead of taken from the app — the seam
/// `tests/netcap_record.rs` drives: the real send, recorded into a test's own `Netcap`.
pub async fn send_via(request: HttpRequest, tap: &Tap) -> Result<HttpResponse, String> {
    send_with(request, MAX_BODY_BYTES, REQUEST_TIMEOUT, tap).await
}

/// The same send under a caller's deadline: `timeout` is clamped to [`REQUEST_TIMEOUT`].
/// Recorded in the Network view like every API-client send. The agent tools
/// (`agent_ctl::commands::http`) send through here, so an agent's request takes exactly the
/// path the user's Send button takes.
pub async fn send_bounded(request: HttpRequest, timeout: Duration) -> Result<HttpResponse, String> {
    send_with(request, MAX_BODY_BYTES, timeout, &Tap::global()).await
}

/// Send an HTTP request and return its response.
///
/// Frontend contract: `invoke<HttpResponse>('http_send', { request })`. The promise
/// rejects with a plain `String` only on a transport failure (timeout, connect/DNS,
/// malformed request/URL/method/header); an HTTP error *status* resolves normally as an
/// [`HttpResponse`]. Bodies are capped at 8 MiB (`truncated` flags it). The flow is
/// recorded in the Network view as source `API client`.
#[tauri::command]
pub async fn http_send(request: HttpRequest) -> Result<HttpResponse, String> {
    send_via(request, &Tap::global()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::sync::oneshot;

    /// First index of `needle` in `haystack` (the header terminator locator).
    fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        if needle.is_empty() || haystack.len() < needle.len() {
            return None;
        }
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    /// Build a canned HTTP/1.1 response: status line, extra headers, and a body (a
    /// correct `Content-Length` is added; `Connection: close` marks the end).
    fn canned(status_line: &str, extra_headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head = format!(
            "HTTP/1.1 {status_line}\r\nContent-Length: {}\r\n",
            body.len()
        );
        for (k, v) in extra_headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("Connection: close\r\n\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    /// Read one full HTTP request (headers + `Content-Length` body) from `stream`.
    async fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            if let Some(end) = find_sub(&buf, b"\r\n\r\n") {
                // Read the declared body, if any, so a POST payload is captured.
                let head = String::from_utf8_lossy(&buf[..end]);
                let content_length = head
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                let want = end + 4 + content_length;
                while buf.len() < want {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                break;
            }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        buf
    }

    /// Bind an ephemeral `127.0.0.1` port and serve `response` verbatim to the single
    /// client that connects, handing the received request bytes back over a oneshot.
    /// One exchange, then the task ends — nothing leaks between tests.
    fn spawn_server(response: Vec<u8>) -> (u16, oneshot::Receiver<Vec<u8>>) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            if let Ok((mut stream, _)) = listener.accept().await {
                let received = read_request(&mut stream).await;
                let _ = stream.write_all(&response).await;
                let _ = stream.flush().await;
                let _ = tx.send(received);
            }
        });
        (port, rx)
    }

    fn req(method: &str, url: String) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            url,
            headers: Vec::new(),
            body: None,
        }
    }

    /// A keep-alive server that serves any number of requests per connection and counts
    /// how many CONNECTIONS it accepted — the observable that distinguishes a shared pool
    /// from a per-request client. `canned()` is not reusable here on purpose: it says
    /// `Connection: close`, which orders the client NOT to pool.
    fn spawn_keepalive_server() -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = connections.clone();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tauri::async_runtime::spawn(async move {
                    // Serve request after request on THIS connection until the peer goes away.
                    loop {
                        if read_request(&mut stream).await.is_empty() {
                            return;
                        }
                        let body = b"pooled";
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                            body.len()
                        );
                        if stream.write_all(head.as_bytes()).await.is_err()
                            || stream.write_all(body).await.is_err()
                        {
                            return;
                        }
                        let _ = stream.flush().await;
                    }
                });
            }
        });
        (port, connections)
    }

    /// 🔴 A per-request `Client` is a new connection pool for every request: each send pays
    /// DNS + TCP + TLS handshake and then drops the warm connection on the floor. Two
    /// sequential sends must arrive on ONE connection; a second accepted connection means the
    /// pool died with a per-request client again. (The timing itself is not asserted — a
    /// wall-clock threshold in a shared-runner test is flake, and connection reuse is the
    /// cause of the slowdown.)
    #[tokio::test]
    async fn sequential_requests_reuse_one_connection_rather_than_redialling() {
        let (port, connections) = spawn_keepalive_server();
        let url = format!("http://127.0.0.1:{port}/");

        // A VERB MIX on purpose (the fix must cover every method, POST and GET alike,
        // and the A/B compare too). The pool keys connections by scheme+host+port, never
        // by method — and every frontend path (a plain send, each half of an A/B compare, a
        // sequence step) funnels into this same `send` — so GET and POST sharing one
        // connection here is what proves the fix covers all of them.
        for method in ["GET", "POST", "GET"] {
            let mut request = req(method, url.clone());
            if method == "POST" {
                request.body = Some("{\"probe\":true}".to_string());
            }
            let r = send(request, MAX_BODY_BYTES).await.unwrap();
            assert_eq!(r.status, 200);
            assert_eq!(r.body, "pooled");
        }

        assert_eq!(
            connections.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "three sends must share one pooled connection — a fresh dial per request pays \
             DNS + TCP + TLS on every send"
        );
    }

    #[tokio::test]
    async fn returns_status_text_headers_and_body_on_200() {
        let (port, _rx) = spawn_server(canned(
            "200 OK",
            &[("Content-Type", "text/plain"), ("X-Custom", "hi")],
            b"hello body",
        ));
        let r = send(
            req("GET", format!("http://127.0.0.1:{port}/thing")),
            MAX_BODY_BYTES,
        )
        .await
        .unwrap();

        assert_eq!(r.status, 200);
        assert_eq!(r.status_text, "OK");
        assert_eq!(r.body, "hello body");
        assert_eq!(r.size_bytes, "hello body".len());
        assert!(!r.truncated);
        assert!(
            r.duration_ms < 30_000,
            "duration should be well under the timeout"
        );
        assert!(
            r.headers
                .iter()
                .any(|h| h.name.eq_ignore_ascii_case("x-custom") && h.value == "hi"),
            "custom response header row missing: {:?}",
            r.headers
        );
    }

    #[tokio::test]
    async fn a_non_2xx_status_is_a_normal_response_not_an_error() {
        let (port, _rx) = spawn_server(canned("404 Not Found", &[], b"nope"));
        // A 404 is a response, not a transport failure → `Ok`, not `Err`.
        let r = send(
            req("GET", format!("http://127.0.0.1:{port}/")),
            MAX_BODY_BYTES,
        )
        .await
        .unwrap();
        assert_eq!(r.status, 404);
        assert_eq!(r.status_text, "Not Found");
        assert_eq!(r.body, "nope");
    }

    #[tokio::test]
    async fn post_sends_the_request_body() {
        let (port, rx) = spawn_server(canned("200 OK", &[], b"ok"));
        let request = HttpRequest {
            method: "POST".to_string(),
            url: format!("http://127.0.0.1:{port}/submit"),
            headers: vec![HttpHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            body: Some("{\"k\":\"v\"}".to_string()),
        };
        let r = send(request, MAX_BODY_BYTES).await.unwrap();
        assert_eq!(r.status, 200);

        let received = rx.await.unwrap();
        let received = String::from_utf8_lossy(&received);
        assert!(
            received.starts_with("POST /submit "),
            "request line: {received}"
        );
        assert!(
            received.contains("{\"k\":\"v\"}"),
            "body not received: {received}"
        );
    }

    #[test]
    fn a_capped_body_keeps_the_cap_and_says_stop_once_it_is_passed() {
        let mut b = CappedBody::new(3);
        assert!(b.push(&[1, 2]), "under the cap: keep reading");
        assert!(b.push(&[3]), "exactly at the cap is not truncated");
        assert!(!b.truncated());
        assert!(!b.push(&[4, 5]), "past the cap: stop reading");
        assert_eq!(b.kept, vec![1, 2, 3]);
        assert_eq!(b.seen, 5);
        assert!(b.truncated());

        let mut one = CappedBody::new(3);
        assert!(!one.push(&[9; 10]), "one chunk larger than the cap");
        assert_eq!((one.kept.len(), one.seen), (3, 10));
        let mut empty = CappedBody::new(0);
        assert!(empty.push(&[]));
        assert!(!empty.push(&[1]));
        assert!(empty.kept.is_empty());
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_truncated_and_flagged() {
        let big = vec![b'a'; 100]; // ASCII, so lossy UTF-8 keeps byte length == char length
        let (port, _rx) = spawn_server(canned("200 OK", &[], &big));
        let cap = 16;
        let r = send(req("GET", format!("http://127.0.0.1:{port}/")), cap)
            .await
            .unwrap();
        assert!(r.truncated);
        assert_eq!(r.body.len(), cap, "body capped to the limit");
        assert!(
            r.size_bytes > cap && r.size_bytes <= 100,
            "size_bytes is what was read before stopping: {}",
            r.size_bytes
        );
    }

    /// A server that answers 200 with a chunked body of zeros and writes `limit` bytes of it in
    /// 64 KiB chunks, then holds the connection open without ever ending the body. Returns the
    /// port and, once the client has hung up (a write failed) or the limit was written, how
    /// many body bytes the server managed to write.
    fn spawn_streaming_server(limit: usize) -> (u16, oneshot::Receiver<usize>) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            read_request(&mut stream).await;
            let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
                        Transfer-Encoding: chunked\r\n\r\n";
            if stream.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            let data = vec![0u8; 64 * 1024];
            let mut chunk = format!("{:x}\r\n", data.len()).into_bytes();
            chunk.extend_from_slice(&data);
            chunk.extend_from_slice(b"\r\n");
            let mut written = 0usize;
            while written < limit {
                if stream.write_all(&chunk).await.is_err() {
                    break;
                }
                written += data.len();
            }
            let _ = tx.send(written);
            // Never end the body: a client that waits for the end waits for its deadline.
            let mut sink = [0u8; 1];
            let _ = stream.read(&mut sink).await;
        });
        (port, rx)
    }

    /// 🔴 An endless response cannot fill memory: reading stops once the 8 MiB cap is passed,
    /// and the call returns at once with the cap and the flag instead of reading until the
    /// deadline. Measured, not assumed: the client read at most one chunk past the cap, and the
    /// server — which would write 256 MiB to a client that kept reading — was cut off long
    /// before. Falsify: read with `resp.bytes()` again — the call waits for the end of a body
    /// that never ends and fails with the timeout.
    #[tokio::test]
    async fn an_endless_body_is_cut_at_the_cap_and_reading_stops_there() {
        let limit = 256 * 1024 * 1024;
        let (port, written) = spawn_streaming_server(limit);
        let started = Instant::now();
        let r = send_bounded(
            req("GET", format!("http://127.0.0.1:{port}/stream")),
            Duration::from_secs(10),
        )
        .await
        .expect("a truncated body is a response, not an error");
        let took = started.elapsed();
        assert!(r.truncated);
        assert_eq!(r.body.len(), MAX_BODY_BYTES, "the body is the cap");
        assert!(
            r.size_bytes > MAX_BODY_BYTES && r.size_bytes <= MAX_BODY_BYTES + 1024 * 1024,
            "read at most a chunk past the cap: {}",
            r.size_bytes
        );
        assert!(took < Duration::from_secs(5), "returned after {took:?}");
        let written = tokio::time::timeout(Duration::from_secs(5), written)
            .await
            .expect("the server noticed the client hung up")
            .unwrap();
        assert!(
            written < limit / 4,
            "the client stopped reading, yet the server wrote {written} bytes"
        );
    }

    /// 🔴 A decompression bomb is inflated only up to the cap: a 256 KiB gzip body that inflates
    /// to 256 MiB comes back as the 8 MiB cap, flagged, having decoded at most a chunk more.
    /// Falsify: read with `resp.bytes()` again — `size_bytes` is the whole 256 MiB.
    #[tokio::test]
    async fn a_small_gzip_body_that_inflates_past_the_cap_is_inflated_only_to_the_cap() {
        use std::io::Write as _;
        let inflated = 256 * 1024 * 1024;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        let zeros = vec![0u8; 1024 * 1024];
        for _ in 0..inflated / zeros.len() {
            gz.write_all(&zeros).unwrap();
        }
        let gz = gz.finish().unwrap();
        assert!(
            gz.len() < 512 * 1024,
            "the body on the wire is small: {}",
            gz.len()
        );
        let (port, _rx) = spawn_server(canned(
            "200 OK",
            &[("Content-Encoding", "gzip"), ("Content-Type", "text/plain")],
            &gz,
        ));
        let started = Instant::now();
        let r = send_bounded(
            req("GET", format!("http://127.0.0.1:{port}/bomb")),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        let took = started.elapsed();
        assert!(r.truncated);
        assert_eq!(r.body.len(), MAX_BODY_BYTES);
        assert!(
            r.size_bytes > MAX_BODY_BYTES && r.size_bytes <= MAX_BODY_BYTES + 1024 * 1024,
            "inflated at most a chunk past the cap, not all {inflated}: {}",
            r.size_bytes
        );
        assert!(took < Duration::from_secs(5), "returned after {took:?}");
    }

    /// 🔴 No engine error carries the URL: reqwest's text adds ` for url (…)` with the URL as
    /// sent — `{{VAR}}`s substituted — and the API history keeps the error. A failure while
    /// sending and one while reading the body, both on a URL holding a credential. Falsify:
    /// drop `without_url()` in `map_send_error` — both errors end in `for url (…secret…)`.
    #[tokio::test]
    async fn an_engine_error_never_carries_the_url_it_was_sent_to() {
        const SECRET: &str = "sk_live_engine_0123456789";
        // Closes the connection without answering: an error while sending.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            if let Ok((mut stream, _)) = listener.accept().await {
                read_request(&mut stream).await;
            }
        });
        let url = format!("http://u:{SECRET}@127.0.0.1:{port}/x?api_key={SECRET}");
        let sending = send(req("GET", url), MAX_BODY_BYTES).await.unwrap_err();

        // Promises 100 bytes, sends 5 and hangs up: an error while reading the body.
        let (port, _rx) = spawn_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".to_vec(),
        );
        let url = format!("http://127.0.0.1:{port}/x?api_key={SECRET}");
        let reading = send(req("GET", url), MAX_BODY_BYTES).await.unwrap_err();

        for err in [&sending, &reading] {
            assert!(!err.contains(SECRET), "the URL leaked into: {err}");
            assert!(!err.contains("for url"), "{err}");
            assert!(!err.contains("127.0.0.1"), "{err}");
        }
        assert!(sending.starts_with("invalid request: "), "{sending}");
    }

    #[tokio::test]
    async fn a_bad_method_is_an_error() {
        // Internal space → not a valid HTTP method token. Fails before any I/O.
        let err = send(
            req("BOGUS METHOD", "http://127.0.0.1:1/".to_string()),
            MAX_BODY_BYTES,
        )
        .await
        .unwrap_err();
        assert!(err.contains("method"), "got: {err}");
    }

    #[tokio::test]
    async fn an_unparseable_url_is_an_error() {
        let err = send(req("GET", "not a url".to_string()), MAX_BODY_BYTES)
            .await
            .unwrap_err();
        assert!(err.contains("URL"), "got: {err}");
    }

    #[tokio::test]
    async fn an_invalid_header_name_is_an_error() {
        let request = HttpRequest {
            method: "GET".to_string(),
            url: "http://127.0.0.1:1/".to_string(),
            headers: vec![HttpHeader {
                name: "Bad Header".to_string(), // space in the name is not allowed
                value: "x".to_string(),
            }],
            body: None,
        };
        let err = send(request, MAX_BODY_BYTES).await.unwrap_err();
        assert!(err.contains("header"), "got: {err}");
    }

    // ── live TLS smoke: the ONE http test that leaves the machine ─────────────
    //
    // Every test above serves plaintext HTTP/1.1 on 127.0.0.1, which means **the TLS path
    // would be entirely untested** — and dangerously so: the crypto provider (`ring`,
    // installed in `crate::tls`) and the trust roots (the OS store, via
    // `rustls-platform-verifier`) are deliberate choices for this client, and not one
    // hermetic test could notice either breaking.
    //
    // `#[ignore]`d so `cargo test` and CI stay hermetic, exactly like
    // `usage.rs`'s `live_smoke_reads_real_usage_from_the_cli`. Run it deliberately after
    // touching any `rustls`/`reqwest`/`tonic`/`tokio-tungstenite` feature:
    //
    //     cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_smoke
    #[tokio::test]
    #[ignore = "reaches the public internet over TLS — run with --ignored"]
    async fn live_smoke_https_completes_a_real_tls_handshake() {
        // `example.com` is IANA-reserved and about as stable an HTTPS endpoint as exists.
        // A 200 proves the whole chain: provider installed (no panic in `Client::builder`),
        // handshake negotiated, and the server's chain validated against the OS trust
        // store. A cert failure surfaces as an `Err` here, never as a status code.
        let r = send(
            req("GET", "https://example.com/".to_string()),
            MAX_BODY_BYTES,
        )
        .await
        .expect(
            "HTTPS must work: if this is a certificate/handshake error, the TLS provider or \
             trust roots regressed (see src/tls.rs). If it is a connect error, check \
             the network first.",
        );
        assert_eq!(r.status, 200, "unexpected status from example.com");
        assert!(!r.body.is_empty(), "an HTTPS body must come back decoded");
    }

    /// A caller's shorter deadline fires, and the sentence names it — not the 30 s default.
    #[tokio::test]
    async fn a_caller_deadline_bounds_a_silent_server_and_is_named_in_the_error() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            // Accept and hold the connection open without ever answering.
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });
        let started = Instant::now();
        let err = send_bounded(
            req("GET", format!("http://127.0.0.1:{port}/slow")),
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "request timed out after 300 ms");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the deadline did not fire"
        );
    }

    #[tokio::test]
    async fn a_refused_connection_is_a_connect_error() {
        // Grab a port, then drop the listener so nothing is accepting on it.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let err = send(
            req("GET", format!("http://127.0.0.1:{port}/")),
            MAX_BODY_BYTES,
        )
        .await
        .unwrap_err();
        assert!(err.contains("connect"), "got: {err}");
    }
}
