//! The capture proxy: an HTTP/1.1 forward proxy on 127.0.0.1 (hyper). `http://` → pooled client,
//! captured; websocket upgrades relayed; `CONNECT` tunnelled or, in decrypt mode, TLS-terminated
//! with ALPN mirrored (h2 gRPC passes frame for frame). Anything else → 400: not an open relay.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri, Version};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

use super::body::TeeBody;
use super::client::{ClientProcess, Decision};
use super::headers::capture_headers;
use super::store::BODY_CAP;
use super::types::{FlowProto, FlowState, FlowSummary, WsCounts};
use super::wsframe::FrameCounter;
use super::Inner;

pub type PBody = UnsyncBoxBody<Bytes, hyper::Error>;
pub type PlainClient = hyper_util::client::legacy::Client<HttpConnector, PBody>;

/// The row text when a client refuses our leaf (pinning, or a runtime that ignores
/// `SSL_CERT_FILE`). Part of the wire contract; the UI may match on it.
pub const TLS_REJECTED: &str = "tls rejected → passthrough";

/// Max time to send a request head. hyper enforces it only with a [`TokioTimer`]; without one a
/// slowloris client held a task and fd forever. Also bounds idle keep-alive connections.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// The one pooled client for plain-HTTP forwarding.
pub fn plain_client() -> PlainClient {
    hyper_util::client::legacy::Client::builder(TokioExecutor::new()).build_http()
}

fn empty() -> PBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// Upstream transport failure: hyper drops the client's connection/stream with no HTTP response,
/// so the client sees what it would without the proxy (a 502 breaks "unreachable → transport
/// error" tests). Still recorded. CONNECT keeps its standard 502.
#[derive(Debug)]
pub(crate) struct UpstreamFailed(pub(crate) String);

impl std::fmt::Display for UpstreamFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UpstreamFailed {}

fn text_response(status: StatusCode, msg: String) -> Response<PBody> {
    let mut r = Response::new(
        Full::new(Bytes::from(msg))
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r
}

/// The terminal id from `Proxy-Authorization: Basic base64("t-<id>:x")`. Attribution, not
/// auth: anything else (no header, another scheme, a user not starting `t-`) is `None` and
/// the request is still served — "unattributed", never refused.
pub fn attribution(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::PROXY_AUTHORIZATION)?.to_str().ok()?;
    let (scheme, b64) = v.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let creds = String::from_utf8(raw).ok()?;
    let user = creds.split_once(':').map_or(creds.as_str(), |(u, _)| u);
    let id = user.strip_prefix("t-")?;
    let id = percent_encoding::percent_decode_str(id)
        .decode_utf8()
        .ok()?
        .into_owned();
    (!id.is_empty()).then_some(id)
}

fn header_has_token(h: &HeaderMap, name: HeaderName, token: &str) -> bool {
    h.get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|t| t.trim().eq_ignore_ascii_case(token))
}

pub fn is_ws_upgrade(h: &HeaderMap) -> bool {
    header_has_token(h, header::UPGRADE, "websocket")
        && header_has_token(h, header::CONNECTION, "upgrade")
}

/// gRPC = `content-type: application/grpc` or any `application/grpc+…` / `;…` variant.
pub fn is_grpc(h: &HeaderMap) -> bool {
    h.get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| {
            let ct = ct.trim().to_ascii_lowercase();
            ct == "application/grpc"
                || ct.starts_with("application/grpc+")
                || ct.starts_with("application/grpc;")
        })
        .unwrap_or(false)
}

pub fn grpc_status(h: &HeaderMap) -> Option<i32> {
    h.get("grpc-status")?.to_str().ok()?.trim().parse().ok()
}

/// The row's `proto`, decided from the request alone.
pub fn classify(tls: bool, headers: &HeaderMap) -> FlowProto {
    match (is_ws_upgrade(headers), is_grpc(headers), tls) {
        (true, _, false) => FlowProto::Ws,
        (true, _, true) => FlowProto::Wss,
        (false, true, _) => FlowProto::Grpc,
        (false, false, false) => FlowProto::Http,
        (false, false, true) => FlowProto::Https,
    }
}

/// The `httpVersion` label of a flow. Shared with [`super::record`] so an API-client row reads
/// exactly like a proxied one.
pub(crate) fn version_label(v: Version) -> String {
    match v {
        Version::HTTP_09 => "HTTP/0.9",
        Version::HTTP_10 => "HTTP/1.0",
        Version::HTTP_11 => "HTTP/1.1",
        Version::HTTP_2 => "HTTP/2",
        Version::HTTP_3 => "HTTP/3",
        _ => "HTTP/?",
    }
    .to_string()
}

/// Drop hop-by-hop headers before forwarding (RFC 9110 §7.6.1) — including the
/// `Proxy-Authorization` attribution, which is ours and must never reach the origin.
/// `keep_upgrade` preserves `Connection: upgrade` + `Upgrade` for a WebSocket handshake.
fn strip_hop_by_hop(h: &mut HeaderMap, keep_upgrade: bool) {
    let listed: Vec<HeaderName> = h
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|t| HeaderName::from_bytes(t.trim().as_bytes()).ok())
        .collect();
    for n in listed {
        if !(keep_upgrade && n == header::UPGRADE) {
            h.remove(n);
        }
    }
    for n in [
        "proxy-connection",
        "keep-alive",
        "proxy-authorization",
        "proxy-authenticate",
        "transfer-encoding",
    ] {
        h.remove(n);
    }
    if keep_upgrade {
        h.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    } else {
        h.remove(header::CONNECTION);
        h.remove(header::UPGRADE);
    }
    // `te` is hop-by-hop except `trailers`, which gRPC over h2 requires.
    if let Some(te) = h.get(header::TE) {
        let trailers = te
            .to_str()
            .map(|s| {
                s.split(',')
                    .any(|t| t.trim().eq_ignore_ascii_case("trailers"))
            })
            .unwrap_or(false);
        if trailers {
            h.insert(header::TE, HeaderValue::from_static("trailers"));
        } else {
            h.remove(header::TE);
        }
    }
}

/// The deepest cause of an error — `Connection refused (os error 61)` rather than hyper's
/// `client error (Connect)`.
fn root_cause(e: &(dyn std::error::Error + 'static)) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

/// How long one connection waits for its client process to be named before going on as
/// "unknown" (a cold scan is bounded by `client::SCAN_BUDGET` anyway).
pub const RESOLVE_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Name the process behind an accepted connection — on a blocking thread, bounded, and never
/// an error (resolution must never fail or stall a connection).
async fn resolve_client(
    inner: &Arc<Inner>,
    peer: std::net::SocketAddr,
    local: Option<std::net::SocketAddr>,
) -> Option<ClientProcess> {
    let local = local?;
    let me = inner.clone();
    let job = tokio::task::spawn_blocking(move || me.resolver.resolve(peer, local));
    match tokio::time::timeout(RESOLVE_TIMEOUT, job).await {
        Ok(Ok(c)) => c,
        _ => None,
    }
}

/// Accept loop. One hyper HTTP/1.1 server per client connection, upgrades enabled (CONNECT
/// and WebSocket both need them). The client process is resolved once per connection, inside
/// the connection's own task — the accept loop never waits on it.
pub(crate) async fn serve(inner: Arc<Inner>, listener: TcpListener) {
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(_) => {
                // EMFILE and friends: back off instead of spinning.
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let _ = tcp.set_nodelay(true);
        let inner = inner.clone();
        tokio::spawn(async move {
            let client = resolve_client(&inner, peer, tcp.local_addr().ok()).await;
            let svc = service_fn(move |req| {
                let (inner, client) = (inner.clone(), client.clone());
                async move { handle(inner, req, client).await }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_READ_TIMEOUT)
                .serve_connection(TokioIo::new(tcp), svc)
                .with_upgrades()
                .await;
        });
    }
}

/// Who the flows on one client connection belong to and where they go.
#[derive(Clone)]
struct Ctx {
    inner: Arc<Inner>,
    host: String,
    port: u16,
    terminal: Option<String>,
    /// The process that opened the proxy connection.
    client: Option<ClientProcess>,
    /// Inside a decrypted CONNECT.
    tls: bool,
    /// Upstream TLS name (the client's SNI, else the CONNECT host) — for re-dials.
    server_name: Option<ServerName<'static>>,
}

fn host_port(uri: &Uri, default_port: u16) -> Option<(String, u16)> {
    let auth = uri.authority()?;
    let host = auth.host().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return None;
    }
    // `port_u16()` is `None` both for no port and an unparsable one (`:99999`, `:abc`);
    // only the first may default. An empty port (`host:`) is RFC 3986's default.
    let after_host = auth.as_str().rsplit('@').next().unwrap_or("");
    let after_host = after_host.rsplit(']').next().unwrap_or("");
    let port = match after_host.rsplit_once(':') {
        Some((_, p)) if !p.is_empty() => p.parse::<u16>().ok()?,
        _ => default_port,
    };
    Some((host.to_string(), port))
}

/// Windows only: a request without `Proxy-Authorization` is attributed via the client's env.
/// PS 5.1 web cmdlets send credentials only after a `407`, which we never send. Never errors.
async fn terminal_of_client(inner: &Arc<Inner>, client: Option<&ClientProcess>) -> Option<String> {
    #[cfg(windows)]
    {
        let pid = client?.pid;
        let port = inner.port;
        let job = tokio::task::spawn_blocking(move || {
            crate::procscan::winproc::read_env(pid)
                .and_then(|env| super::env::terminal_from_env(&env, port))
        });
        match tokio::time::timeout(RESOLVE_TIMEOUT, job).await {
            Ok(Ok(t)) => t,
            _ => None,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (inner, client);
        None
    }
}

async fn handle(
    inner: Arc<Inner>,
    req: Request<Incoming>,
    client: Option<ClientProcess>,
) -> Result<Response<PBody>, UpstreamFailed> {
    let terminal = match attribution(req.headers()) {
        Some(t) => Some(t),
        None => terminal_of_client(&inner, client.as_ref()).await,
    };
    if req.method() == Method::CONNECT {
        return Ok(connect(inner, req, terminal, client).await);
    }
    let scheme_ok = matches!(req.uri().scheme_str(), Some("http") | Some("ws"));
    let target = if scheme_ok {
        host_port(req.uri(), 80)
    } else {
        None
    };
    let Some((host, port)) = target else {
        return Ok(text_response(
            StatusCode::BAD_REQUEST,
            "Agent Studio capture proxy: only absolute-form http:// requests and CONNECT are \
             proxied here — this port is not a web server or an open relay.\n"
                .into(),
        ));
    };
    let ws = is_ws_upgrade(req.headers());
    let ctx = Ctx {
        inner,
        host,
        port,
        terminal,
        client,
        tls: false,
        server_name: None,
    };
    let up = if ws {
        Upstream::FreshH1
    } else {
        Upstream::Pooled
    };
    exchange(ctx, req, up).await
}

type H1Sender = hyper::client::conn::http1::SendRequest<PBody>;
type H2Sender = hyper::client::conn::http2::SendRequest<PBody>;

/// Where a request is sent.
#[derive(Clone)]
enum Upstream {
    /// Plain HTTP on the shared pooled client.
    Pooled,
    /// Plain HTTP on a connection of its own (a WebSocket handshake consumes it).
    FreshH1,
    /// The dedicated upstream TLS connection of a decrypted client connection.
    MitmH1(Arc<tokio::sync::Mutex<Option<H1Sender>>>),
    MitmH2(Arc<tokio::sync::Mutex<Option<H2Sender>>>),
}

async fn h1_handshake<T>(io: T) -> Result<H1Sender, String>
where
    T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .map_err(|e| format!("upstream: {}", root_cause(&e)))?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    Ok(sender)
}

async fn h2_handshake<T>(io: T) -> Result<H2Sender, String>
where
    T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (sender, conn) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(io))
            .await
            .map_err(|e| format!("upstream: {}", root_cause(&e)))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    Ok(sender)
}

type UpTls = tokio_rustls::client::TlsStream<TcpStream>;

async fn tls_connect(
    inner: &Arc<Inner>,
    name: ServerName<'static>,
    tcp: TcpStream,
    alpn: Vec<Vec<u8>>,
) -> Result<UpTls, String> {
    let base = inner.upstream_tls().await?;
    let mut cfg = (*base).clone();
    cfg.alpn_protocols = alpn;
    tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect(name, tcp)
        .await
        .map_err(|e| e.to_string())
}

impl Ctx {
    async fn dial_tls(&self, alpn: &[u8]) -> Result<UpTls, String> {
        let name = self
            .server_name
            .clone()
            .ok_or_else(|| "upstream: no TLS name".to_string())?;
        let tcp = TcpStream::connect((self.host.as_str(), self.port))
            .await
            .map_err(|e| format!("upstream: {e}"))?;
        let _ = tcp.set_nodelay(true);
        let tls = tls_connect(&self.inner, name, tcp, vec![alpn.to_vec()])
            .await
            .map_err(|e| format!("upstream tls: {e}"))?;
        if tls.get_ref().1.alpn_protocol() == Some(b"h2") || alpn != b"h2" {
            Ok(tls)
        } else {
            Err("upstream no longer negotiates h2".into())
        }
    }

    /// A one-row error flow for a connection that never got as far as a request.
    fn record_error(&self, proto: FlowProto, msg: String) {
        let mut s = FlowSummary::pending(proto, "CONNECT", &self.host, self.port, "");
        s.terminal_id = self.terminal.clone();
        s.client = self.client.clone();
        s.state = FlowState::Error;
        s.error = Some(msg);
        s.duration_ms = Some(0);
        self.inner.insert(s, |_| {});
    }
}

async fn send(ctx: &Ctx, up: &Upstream, req: Request<PBody>) -> Result<Response<Incoming>, String> {
    match up {
        Upstream::Pooled => ctx
            .inner
            .plain
            .request(req)
            .await
            .map_err(|e| format!("upstream: {}", root_cause(&e))),
        Upstream::FreshH1 => {
            let tcp = TcpStream::connect((ctx.host.as_str(), ctx.port))
                .await
                .map_err(|e| format!("upstream: {e}"))?;
            let mut s = h1_handshake(tcp).await?;
            s.send_request(req)
                .await
                .map_err(|e| format!("upstream: {}", root_cause(&e)))
        }
        Upstream::MitmH1(slot) => {
            let mut g = slot.lock().await;
            let live = match g.as_mut() {
                Some(s) if !s.is_closed() => s.ready().await.is_ok(),
                _ => false,
            };
            if !live {
                // Upstream closed its keep-alive: re-dial, same ALPN.
                *g = Some(h1_handshake(ctx.dial_tls(b"http/1.1").await?).await?);
            }
            let s = g.as_mut().ok_or("upstream: no connection")?;
            s.send_request(req)
                .await
                .map_err(|e| format!("upstream: {}", root_cause(&e)))
        }
        Upstream::MitmH2(slot) => {
            let mut sender = {
                let mut g = slot.lock().await;
                if g.as_ref().is_none_or(|s| s.is_closed()) {
                    *g = Some(h2_handshake(ctx.dial_tls(b"h2").await?).await?);
                }
                g.clone().ok_or("upstream: no connection")?
            };
            sender
                .send_request(req)
                .await
                .map_err(|e| format!("upstream: {}", root_cause(&e)))
        }
    }
}

/// One request/response through the proxy, captured as one flow. An upstream that fails at the
/// transport level is the service's error ([`UpstreamFailed`]): no HTTP response is made up.
async fn exchange(
    ctx: Ctx,
    mut req: Request<Incoming>,
    up: Upstream,
) -> Result<Response<PBody>, UpstreamFailed> {
    let started = Instant::now();
    let inner = ctx.inner.clone();
    let ws = is_ws_upgrade(req.headers());
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let mut s = FlowSummary::pending(
        classify(ctx.tls, req.headers()),
        req.method().as_str(),
        &ctx.host,
        ctx.port,
        &path,
    );
    s.terminal_id = ctx.terminal.clone();
    s.client = ctx.client.clone();
    s.http_version = version_label(req.version());
    let req_headers = capture_headers(req.headers());
    let id = inner.insert(s, |r| r.request_headers = req_headers);

    let client_upgrade = ws.then(|| hyper::upgrade::on(&mut req));
    let (mut parts, body) = req.into_parts();
    strip_hop_by_hop(&mut parts.headers, ws);
    match up {
        // A raw connection wants origin-form (the pooled client converts on its own).
        Upstream::FreshH1 | Upstream::MitmH1(_) => {
            if parts.uri.scheme().is_some() {
                let pq = parts
                    .uri
                    .path_and_query()
                    .map(|p| p.as_str())
                    .unwrap_or("/");
                if let Ok(u) = pq.parse() {
                    parts.uri = u;
                }
            }
        }
        // h2 derives :scheme/:authority from the URI, so it must be absolute.
        Upstream::MitmH2(_) => {
            if parts.uri.scheme().is_none() {
                let abs = format!("https://{}:{}{}", ctx.host, ctx.port, path);
                if let Ok(u) = abs.parse() {
                    parts.uri = u;
                }
            }
        }
        Upstream::Pooled => {}
    }
    let on_req = inner.clone();
    let req_body = TeeBody::new(body, BODY_CAP, move |o| {
        on_req.update(id, |r| {
            r.summary.req_bytes = o.captured.size;
            r.request_body = Some(o.captured);
        });
    });
    let up_req = Request::from_parts(parts, req_body.boxed_unsync());

    let mut resp = match send(&ctx, &up, up_req).await {
        Ok(r) => r,
        Err(e) => {
            inner.update(id, |r| {
                r.summary.state = FlowState::Error;
                r.summary.error = Some(e.clone());
                r.summary.duration_ms = Some(started.elapsed().as_millis() as u64);
            });
            return Err(UpstreamFailed(e));
        }
    };

    let status = resp.status();
    let res_headers = capture_headers(resp.headers());
    let str_of = |n: HeaderName| {
        resp.headers()
            .get(n)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let content_type = str_of(header::CONTENT_TYPE);
    let encoding = str_of(header::CONTENT_ENCODING);
    let head_grpc = grpc_status(resp.headers()); // a trailers-only gRPC response
    inner.update(id, |r| {
        r.summary.status = Some(status.as_u16());
        r.summary.content_type = content_type;
        r.response_headers = res_headers;
        r.response_encoding = encoding;
        if head_grpc.is_some() {
            r.summary.grpc_status = head_grpc;
        }
    });

    if let (Some(client_upgrade), StatusCode::SWITCHING_PROTOCOLS) = (client_upgrade, status) {
        let up_upgrade = hyper::upgrade::on(&mut resp);
        inner.update(id, |r| r.summary.ws_messages = Some(WsCounts::default()));
        tokio::spawn(ws_relay(inner, id, started, client_upgrade, up_upgrade));
        let (parts, _) = resp.into_parts();
        return Ok(Response::from_parts(parts, empty()));
    }

    let (mut parts, body) = resp.into_parts();
    strip_hop_by_hop(&mut parts.headers, false);
    let on_res = inner.clone();
    let res_body = TeeBody::new(body, BODY_CAP, move |o| {
        on_res.update(id, |r| {
            r.summary.res_bytes = o.captured.size;
            r.response_body = Some(o.captured);
            if let Some(t) = &o.trailers {
                r.response_trailers = capture_headers(t);
                if let Some(g) = grpc_status(t) {
                    r.summary.grpc_status = Some(g);
                }
            }
            r.summary.duration_ms = Some(started.elapsed().as_millis() as u64);
            match o.error {
                None => r.summary.state = FlowState::Done,
                Some(e) => {
                    r.summary.state = FlowState::Error;
                    r.summary.error = Some(format!("response: {e}"));
                }
            }
        });
    });
    Ok(Response::from_parts(parts, res_body.boxed_unsync()))
}

async fn ws_relay(
    inner: Arc<Inner>,
    id: u64,
    started: Instant,
    client: hyper::upgrade::OnUpgrade,
    upstream: hyper::upgrade::OnUpgrade,
) {
    let (c, u) = tokio::join!(client, upstream);
    let (Ok(c), Ok(u)) = (c, u) else {
        inner.update(id, |r| {
            r.summary.state = FlowState::Error;
            r.summary.error = Some("websocket upgrade failed".into());
        });
        return;
    };
    let (mut up_frames, mut down_frames) = (FrameCounter::default(), FrameCounter::default());
    let (iu, id_) = (inner.clone(), inner.clone());
    let r = relay(
        TokioIo::new(c),
        TokioIo::new(u),
        move |chunk| {
            let n = up_frames.feed(chunk);
            if n > 0 {
                iu.update(id, |r| {
                    if let Some(w) = r.summary.ws_messages.as_mut() {
                        w.up += n;
                    }
                });
            }
        },
        move |chunk| {
            let n = down_frames.feed(chunk);
            if n > 0 {
                id_.update(id, |r| {
                    if let Some(w) = r.summary.ws_messages.as_mut() {
                        w.down += n;
                    }
                });
            }
        },
    )
    .await;
    inner.update(id, |rec| {
        rec.summary.req_bytes += r.up;
        rec.summary.res_bytes += r.down;
        rec.summary.duration_ms = Some(started.elapsed().as_millis() as u64);
        rec.summary.state = FlowState::Done;
    });
}

async fn connect(
    inner: Arc<Inner>,
    req: Request<Incoming>,
    terminal: Option<String>,
    client: Option<ClientProcess>,
) -> Response<PBody> {
    let Some((host, port)) = host_port(req.uri(), 443) else {
        return text_response(StatusCode::BAD_REQUEST, "bad CONNECT target\n".into());
    };
    // Never break a client: MITM only a client known to trust our CA; tunnel the rest.
    let (decrypt, note) = match inner.decide(client.as_ref(), &host) {
        Decision::Decrypt => (true, None),
        Decision::Tunnel(note) => (false, note),
    };
    let ctx = Ctx {
        inner,
        host,
        port,
        terminal,
        client,
        tls: true,
        server_name: None,
    };
    let upstream = match TcpStream::connect((ctx.host.as_str(), ctx.port)).await {
        Ok(s) => s,
        Err(e) => {
            let proto = if decrypt {
                FlowProto::Https
            } else {
                FlowProto::Tunnel
            };
            ctx.record_error(proto, format!("upstream: {e}"));
            return text_response(
                StatusCode::BAD_GATEWAY,
                format!("Agent Studio capture proxy: upstream: {e}\n"),
            );
        }
    };
    let _ = upstream.set_nodelay(true);
    let on_upgrade = hyper::upgrade::on(req);
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let client = TokioIo::new(upgraded);
        if decrypt {
            mitm(ctx, client, upstream).await;
        } else {
            tunnel(&ctx, client, upstream, note).await;
        }
    });
    Response::new(empty())
}

/// Live byte counts for a tunnel, published at most every 250 ms (the emitter batches on top).
struct TunnelLive {
    inner: Arc<Inner>,
    id: u64,
    up: AtomicU64,
    down: AtomicU64,
    last: Mutex<Instant>,
}

impl TunnelLive {
    fn add(&self, up: usize, down: usize) {
        self.up.fetch_add(up as u64, Ordering::Relaxed);
        self.down.fetch_add(down as u64, Ordering::Relaxed);
        let due = match self.last.lock() {
            Ok(mut last) if last.elapsed() >= Duration::from_millis(250) => {
                *last = Instant::now();
                true
            }
            _ => false,
        };
        if due {
            let (u, d) = (
                self.up.load(Ordering::Relaxed),
                self.down.load(Ordering::Relaxed),
            );
            self.inner.update(self.id, |r| {
                r.summary.req_bytes = u;
                r.summary.res_bytes = d;
            });
        }
    }
}

/// A transparent tunnel: bytes are relayed, never read. It cannot break a client. `note`
/// says why a decrypt-mode connection was tunnelled.
async fn tunnel<C>(ctx: &Ctx, client: C, upstream: TcpStream, note: Option<String>)
where
    C: AsyncRead + AsyncWrite + Unpin + Send,
{
    let started = Instant::now();
    let mut s = FlowSummary::pending(FlowProto::Tunnel, "CONNECT", &ctx.host, ctx.port, "");
    s.terminal_id = ctx.terminal.clone();
    s.client = ctx.client.clone();
    s.note = note;
    let id = ctx.inner.insert(s, |_| {});
    let live = Arc::new(TunnelLive {
        inner: ctx.inner.clone(),
        id,
        up: AtomicU64::new(0),
        down: AtomicU64::new(0),
        last: Mutex::new(Instant::now()),
    });
    let (l1, l2) = (live.clone(), live);
    let r = relay(
        client,
        upstream,
        move |c| l1.add(c.len(), 0),
        move |c| l2.add(0, c.len()),
    )
    .await;
    ctx.inner.update(id, |rec| {
        rec.summary.req_bytes = r.up;
        rec.summary.res_bytes = r.down;
        rec.summary.duration_ms = Some(started.elapsed().as_millis() as u64);
        // A reset after data flowed is how many clients hang up; only a tunnel that moved
        // nothing and died is an error.
        match r.error {
            Some(e) if r.up + r.down == 0 => {
                rec.summary.state = FlowState::Error;
                rec.summary.error = Some(e);
            }
            _ => rec.summary.state = FlowState::Done,
        }
    });
}

/// Decrypt mode: terminate the client's TLS with our leaf, open our own TLS upstream.
async fn mitm<C>(mut ctx: Ctx, mut client: C, upstream: TcpStream)
where
    C: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut first = [0u8; 1];
    let n = match client.read(&mut first).await {
        Ok(n) => n,
        Err(_) => return,
    };
    if n == 0 {
        return;
    }
    let client = Rewind::new(first[..n].to_vec(), client);
    if first[0] != 0x16 {
        // Not a TLS handshake (e.g. ws:// over CONNECT): nothing to decrypt, tunnel it.
        return tunnel(&ctx, client, upstream, None).await;
    }
    let acceptor =
        tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), client);
    let start = match acceptor.await {
        Ok(s) => s,
        Err(e) => {
            ctx.record_error(FlowProto::Https, format!("client hello: {e}"));
            return;
        }
    };
    let (sni, alpn) = {
        let hello = start.client_hello();
        let alpn: Vec<Vec<u8>> = hello
            .alpn()
            .map(|ps| {
                ps.filter(|p| *p == b"h2" || *p == b"http/1.1")
                    .map(<[u8]>::to_vec)
                    .collect()
            })
            .unwrap_or_default();
        (hello.server_name().map(str::to_string), alpn)
    };
    let cert_name = sni.unwrap_or_else(|| ctx.host.clone());
    let Ok(server_name) = ServerName::try_from(cert_name.clone()) else {
        ctx.record_error(FlowProto::Https, format!("bad TLS name {cert_name:?}"));
        return;
    };
    ctx.server_name = Some(server_name.clone());

    // Upstream first: its ALPN choice is what we offer the client (mirror).
    let up_tls = match tls_connect(&ctx.inner, server_name, upstream, alpn).await {
        Ok(t) => t,
        Err(e) => {
            // Upstream is not verifiable by OUR trust policy (maybe it is by the client's
            // own): stop interfering with this host for the session.
            // Every client would hit the same wall, so this one is host-wide.
            ctx.inner.add_passthrough(None, &ctx.host, true);
            ctx.record_error(FlowProto::Https, format!("upstream tls: {e} → passthrough"));
            return;
        }
    };
    let negotiated = up_tls.get_ref().1.alpn_protocol().map(<[u8]>::to_vec);

    let Some(ca) = ctx.inner.ca.clone() else {
        return;
    };
    let server_cfg = ca.leaf_for(&cert_name).and_then(|leaf| {
        rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(leaf.chain.clone(), leaf.key())
            .map_err(|e| e.to_string())
    });
    let mut server_cfg = match server_cfg {
        Ok(c) => c,
        Err(e) => {
            ctx.record_error(FlowProto::Https, format!("leaf: {e}"));
            return;
        }
    };
    server_cfg.alpn_protocols = negotiated.iter().cloned().collect();
    let client_tls = match start.into_stream(Arc::new(server_cfg)).await {
        Ok(s) => s,
        Err(_) => {
            // An allowlisted client refused our certificate anyway (pinning, or an explicit
            // `--cacert`). One failure, explained; its later connections to this host tunnel.
            // Keyed by (executable, host): only THIS client distrusts us here.
            ctx.inner
                .add_passthrough(ctx.client.as_ref(), &ctx.host, false);
            ctx.record_error(FlowProto::Https, TLS_REJECTED.into());
            return;
        }
    };

    if negotiated.as_deref() == Some(b"h2") {
        let sender = match h2_handshake(up_tls).await {
            Ok(s) => s,
            Err(e) => return ctx.record_error(FlowProto::Https, e),
        };
        let slot = Arc::new(tokio::sync::Mutex::new(Some(sender)));
        let svc = service_fn(move |req| {
            let (ctx, up) = (ctx.clone(), Upstream::MitmH2(slot.clone()));
            async move { exchange(ctx, req, up).await }
        });
        let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
            .serve_connection(TokioIo::new(client_tls), svc)
            .await;
    } else {
        let sender = match h1_handshake(up_tls).await {
            Ok(s) => s,
            Err(e) => return ctx.record_error(FlowProto::Https, e),
        };
        let slot = Arc::new(tokio::sync::Mutex::new(Some(sender)));
        let svc = service_fn(move |req| {
            let (ctx, up) = (ctx.clone(), Upstream::MitmH1(slot.clone()));
            async move { exchange(ctx, req, up).await }
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(HEADER_READ_TIMEOUT)
            .serve_connection(TokioIo::new(client_tls), svc)
            .with_upgrades()
            .await;
    }
}

pub(crate) struct RelayResult {
    pub up: u64,
    pub down: u64,
    pub error: Option<String>,
}

async fn pump<R, W>(
    r: &mut R,
    w: &mut W,
    on: &mut (dyn FnMut(&[u8]) + Send),
) -> (u64, Option<String>)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 16 * 1024];
    let mut total = 0u64;
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0) => {
                let _ = w.shutdown().await;
                return (total, None);
            }
            Ok(n) => n,
            Err(e) => return (total, Some(e.to_string())),
        };
        if let Err(e) = w.write_all(&buf[..n]).await {
            return (total, Some(e.to_string()));
        }
        if let Err(e) = w.flush().await {
            return (total, Some(e.to_string()));
        }
        total += n as u64;
        on(&buf[..n]);
    }
}

/// Copy both directions until both reach EOF (half-close is propagated) or either fails.
pub(crate) async fn relay<A, B>(
    a: A,
    b: B,
    mut on_up: impl FnMut(&[u8]) + Send,
    mut on_down: impl FnMut(&[u8]) + Send,
) -> RelayResult
where
    A: AsyncRead + AsyncWrite + Unpin + Send,
    B: AsyncRead + AsyncWrite + Unpin + Send,
{
    let (mut ar, mut aw) = tokio::io::split(a);
    let (mut br, mut bw) = tokio::io::split(b);
    let up = pump(&mut ar, &mut bw, &mut on_up);
    let down = pump(&mut br, &mut aw, &mut on_down);
    tokio::pin!(up);
    tokio::pin!(down);
    let (mut up_res, mut down_res) = (None, None);
    while up_res.is_none() || down_res.is_none() {
        tokio::select! {
            r = &mut up, if up_res.is_none() => {
                let failed = r.1.is_some();
                up_res = Some(r);
                if failed { break; }
            }
            r = &mut down, if down_res.is_none() => {
                let failed = r.1.is_some();
                down_res = Some(r);
                if failed { break; }
            }
        }
    }
    let (up, e1) = up_res.unwrap_or((0, None));
    let (down, e2) = down_res.unwrap_or((0, None));
    RelayResult {
        up,
        down,
        error: e1.or(e2),
    }
}

/// Replays bytes already read (the TLS sniff) before reading from `inner` again.
pub(crate) struct Rewind<T> {
    pre: Vec<u8>,
    pos: usize,
    inner: T,
}

impl<T> Rewind<T> {
    pub(crate) fn new(pre: Vec<u8>, inner: T) -> Self {
        Rewind { pre, pos: 0, inner }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for Rewind<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = &mut *self;
        if this.pos < this.pre.len() {
            let n = (this.pre.len() - this.pos).min(buf.remaining());
            buf.put_slice(&this.pre[this.pos..this.pos + n]);
            this.pos += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Rewind<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    fn basic(creds: &str) -> String {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(creds)
        )
    }

    #[test]
    fn attribution_reads_the_terminal_id_from_basic_userinfo() {
        let h = headers(&[("proxy-authorization", &basic("t-term-1:x"))]);
        assert_eq!(attribution(&h).as_deref(), Some("term-1"));
        let h = headers(&[("proxy-authorization", &basic("t-a%3Ab:x"))]);
        assert_eq!(attribution(&h).as_deref(), Some("a:b"));
    }

    #[test]
    fn anything_else_is_unattributed_not_an_error() {
        assert_eq!(attribution(&HeaderMap::new()), None);
        for v in [
            basic("alice:pw"),
            basic("t-:x"),
            "Bearer t-x".to_string(),
            "Basic !!!".to_string(),
        ] {
            assert_eq!(
                attribution(&headers(&[("proxy-authorization", &v)])),
                None,
                "{v}"
            );
        }
    }

    #[test]
    fn grpc_is_classified_by_content_type() {
        for ct in [
            "application/grpc",
            "application/grpc+proto",
            "Application/GRPC; charset=x",
        ] {
            assert_eq!(
                classify(true, &headers(&[("content-type", ct)])),
                FlowProto::Grpc,
                "{ct}"
            );
        }
        for ct in ["application/grpc-web", "application/json", "text/grpc"] {
            assert_eq!(
                classify(true, &headers(&[("content-type", ct)])),
                FlowProto::Https,
                "{ct}"
            );
        }
        assert_eq!(classify(false, &HeaderMap::new()), FlowProto::Http);
    }

    #[test]
    fn websocket_needs_both_upgrade_and_connection_tokens() {
        let ws = headers(&[
            ("upgrade", "websocket"),
            ("connection", "keep-alive, Upgrade"),
        ]);
        assert_eq!(classify(false, &ws), FlowProto::Ws);
        assert_eq!(classify(true, &ws), FlowProto::Wss);
        let half = headers(&[("upgrade", "websocket")]);
        assert_eq!(classify(false, &half), FlowProto::Http);
    }

    #[test]
    fn hop_by_hop_headers_and_our_attribution_never_reach_the_origin() {
        let mut h = headers(&[
            ("proxy-authorization", "Basic abc"),
            ("proxy-connection", "keep-alive"),
            ("connection", "keep-alive, x-private"),
            ("x-private", "1"),
            ("keep-alive", "timeout=5"),
            ("te", "gzip"),
            ("authorization", "Bearer real"),
            ("accept", "*/*"),
        ]);
        strip_hop_by_hop(&mut h, false);
        let mut left: Vec<&str> = h.keys().map(|k| k.as_str()).collect();
        left.sort_unstable();
        assert_eq!(left, ["accept", "authorization"]);

        let mut ws = headers(&[
            ("connection", "Upgrade"),
            ("upgrade", "websocket"),
            ("te", "trailers, deflate"),
        ]);
        strip_hop_by_hop(&mut ws, true);
        assert_eq!(ws["connection"], "upgrade");
        assert_eq!(ws["upgrade"], "websocket");
        assert_eq!(ws["te"], "trailers");
    }

    #[test]
    fn grpc_status_parses_the_header() {
        assert_eq!(grpc_status(&headers(&[("grpc-status", "5")])), Some(5));
        assert_eq!(grpc_status(&headers(&[("grpc-status", "x")])), None);
        assert_eq!(grpc_status(&HeaderMap::new()), None);
    }

    /// A tunnel row's Size and `encrypted · n ↑ m ↓` come from these two counts: each
    /// direction is counted separately and completely, the per-chunk callbacks see every byte
    /// (the live 250 ms updates), and a clean close on both sides is not an error.
    #[tokio::test]
    async fn relay_counts_each_direction_and_ends_clean_when_both_sides_close() {
        let (client, mut client_far) = tokio::io::duplex(64);
        let (upstream, mut upstream_far) = tokio::io::duplex(64);
        let seen = Arc::new(Mutex::new((0usize, 0usize)));
        let (s1, s2) = (seen.clone(), seen.clone());
        let relayed = tokio::spawn(async move {
            relay(
                client,
                upstream,
                move |c| s1.lock().unwrap().0 += c.len(),
                move |c| s2.lock().unwrap().1 += c.len(),
            )
            .await
        });
        // 100 bytes up (more than one 64-byte duplex buffer), 7 down.
        client_far.write_all(&[b'u'; 100]).await.unwrap();
        let mut up = vec![0u8; 100];
        upstream_far.read_exact(&mut up).await.unwrap();
        upstream_far.write_all(b"pong!!!").await.unwrap();
        let mut down = [0u8; 7];
        client_far.read_exact(&mut down).await.unwrap();
        assert_eq!(&down, b"pong!!!");
        drop(client_far);
        drop(upstream_far);
        let r = relayed.await.unwrap();
        assert_eq!((r.up, r.down, r.error), (100, 7, None));
        assert_eq!(*seen.lock().unwrap(), (100, 7));
    }
}
