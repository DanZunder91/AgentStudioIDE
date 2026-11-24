//! End-to-end tests of the capture proxy (`src/netcap/`), in process and hermetic:
//! every upstream is a loopback server started here, every client is a real
//! client pointed at a real `Netcap` on 127.0.0.1, the trust anchors are test CAs — no
//! internet, no OS trust store, no `~/.claude`, no login shell. Each test starts its own
//! proxy instance, so they run in parallel with no shared state.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::netcap::ca::Ca;
use agent_studio_scaffold_lib::netcap::client::{client_name, not_decrypted_note};
use agent_studio_scaffold_lib::netcap::proxy::TLS_REJECTED;
use agent_studio_scaffold_lib::netcap::{
    FlowProto, FlowSink, FlowState, FlowSummary, Netcap, NetcapConfig, WsCounts,
};
use base64::Engine as _;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::{protocol::Role, Message};

type UBody = UnsyncBoxBody<Bytes, Infallible>;

#[derive(Default)]
struct Recorder(Mutex<Vec<Vec<FlowSummary>>>);
impl FlowSink for Recorder {
    fn emit(&self, flows: &[FlowSummary]) {
        self.0.lock().unwrap().push(flows.to_vec());
    }
}

/// A proxy whose upstream trust is exactly `anchors` (hermetic: no OS store read).
fn proxy(anchors: Vec<rustls::pki_types::CertificateDer<'static>>) -> (Netcap, Arc<Recorder>) {
    let rec = Arc::new(Recorder::default());
    let nc = Netcap::start(
        NetcapConfig {
            dir: None,
            trust_anchors: Some(anchors),
            user_env: Vec::new(),
            preferred_port: None,
        },
        rec.clone(),
    )
    .expect("proxy starts");
    (nc, rec)
}

/// The name the proxy resolves THIS test process to (the test binary, e.g.
/// `netcap_e2e-3f2a…`) — deliberately not on the decrypt allowlist.
fn me() -> String {
    client_name(&std::env::current_exe().unwrap().to_string_lossy())
}

/// Assert a flow was attributed to this very process (the contract: `client` on every flow).
fn assert_client_is_me(f: &FlowSummary) {
    let c = f
        .client
        .as_ref()
        .unwrap_or_else(|| panic!("client unresolved: {f:?}"));
    assert_eq!(c.pid, std::process::id(), "{f:?}");
    assert_eq!(c.name, me(), "{f:?}");
}

/// Decrypt on, with this test binary treated as a CA-reading runtime (the in-process
/// equivalent of `curl`/`node` — see `Netcap::also_decrypt_for`).
fn decrypt_for_me(nc: &Netcap) {
    nc.set(None, Some(true)).unwrap();
    let name = me();
    nc.also_decrypt_for(&[name.as_str()]);
}

async fn wait_for(nc: &Netcap, what: &str, pred: impl Fn(&FlowSummary) -> bool) -> FlowSummary {
    for _ in 0..500 {
        if let Some(f) = nc.snapshot().into_iter().find(|f| pred(f)) {
            return f;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no flow matching {what}; flows: {:#?}", nc.snapshot());
}

fn full(b: impl Into<Bytes>) -> UBody {
    Full::new(b.into()).boxed_unsync()
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// One upstream behaviour for every test, switched on the path.
async fn upstream(req: Request<Incoming>) -> Result<Response<UBody>, Infallible> {
    let path = req.uri().path().to_string();
    let body = req
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let resp = match path.as_str() {
        "/api/v1/items" => Response::builder()
            .status(201)
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .header("set-cookie", "session=COOKIE-SECRET")
            .body(full(gzip(br#"{"ok":true}"#))),
        "/pkg.Greeter/SayHello" => {
            let mut trailers = hyper::HeaderMap::new();
            trailers.insert("grpc-status", "3".parse().unwrap());
            trailers.insert("grpc-message", "bad name".parse().unwrap());
            let frames = vec![
                Ok::<_, Infallible>(Frame::data(Bytes::from_static(&[0, 0, 0, 0, 2, 8, 1]))),
                Ok(Frame::trailers(trailers)),
            ];
            Response::builder()
                .status(200)
                .header("content-type", "application/grpc")
                .body(StreamBody::new(futures_util::stream::iter(frames)).boxed_unsync())
        }
        _ => Response::builder()
            .status(200)
            .header("content-type", "text/plain")
            .body(full(format!("hello {path} ({} bytes in)", body.len()))),
    };
    Ok(resp.unwrap())
}

async fn spawn_plain_upstream() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(s), service_fn(upstream))
                    .await;
            });
        }
    });
    port
}

/// A TLS upstream presenting a leaf for `localhost` from `ca`, offering `alpn`.
async fn spawn_tls_upstream(ca: &Ca, alpn: &[&[u8]]) -> u16 {
    let leaf = ca.leaf_for("localhost").unwrap();
    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(leaf.chain.clone(), leaf.key())
        .unwrap();
    cfg.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(s).await else {
                    return;
                };
                let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
                if h2 {
                    let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                        .serve_connection(TokioIo::new(tls), service_fn(upstream))
                        .await;
                } else {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service_fn(upstream))
                        .await;
                }
            });
        }
    });
    port
}

fn reqwest_via(nc: &Netcap, terminal: &str, trust_pem: Option<&str>) -> reqwest::Client {
    agent_studio_scaffold_lib::tls::install_crypto_provider();
    let proxy =
        reqwest::Proxy::all(format!("http://t-{terminal}:x@127.0.0.1:{}", nc.port())).unwrap();
    let mut b = reqwest::Client::builder().proxy(proxy);
    if let Some(pem) = trust_pem {
        b = b.tls_certs_only([reqwest::Certificate::from_pem(pem.as_bytes()).unwrap()]);
    }
    b.build().unwrap()
}

fn basic(terminal: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("t-{terminal}:x"))
}

/// Open a CONNECT tunnel through the proxy by hand (for clients reqwest cannot be: h2).
async fn connect_through(nc: &Netcap, host: &str, port: u16, terminal: &str) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    let req = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: Basic {}\r\n\r\n",
        basic(terminal)
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let head = read_head(&mut s).await;
    assert!(
        head.starts_with("HTTP/1.1 200"),
        "CONNECT answered {head:?}"
    );
    s
}

/// Read a response head byte by byte (never past the blank line).
async fn read_head(s: &mut TcpStream) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut b = [0u8; 1];
        if s.read(&mut b).await.unwrap() == 0 {
            break;
        }
        head.push(b[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plain_http_is_captured_with_attribution_bytes_and_verbatim_headers() {
    let up = spawn_plain_upstream().await;
    let (nc, rec) = proxy(Vec::new());
    let client = reqwest_via(&nc, "term-1", None);
    let res = client
        .post(format!("http://127.0.0.1:{up}/api/v1/items?x=1"))
        .header("authorization", "Bearer sk-live-SECRET")
        .body("ping")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    assert_eq!(
        res.text().await.unwrap(),
        r#"{"ok":true}"#,
        "client gets the real body"
    );

    let f = wait_for(&nc, "done POST", |f| f.state == FlowState::Done).await;
    assert_eq!(f.proto, FlowProto::Http);
    assert_eq!(f.method, "POST");
    assert_eq!((f.host.as_str(), f.port), ("127.0.0.1", up));
    assert_eq!(f.path, "/api/v1/items?x=1");
    assert_eq!(f.status, Some(201));
    assert_eq!(f.req_bytes, 4);
    assert_eq!(
        f.res_bytes,
        gzip(br#"{"ok":true}"#).len() as u64,
        "wire (compressed) size"
    );
    assert_eq!(f.terminal_id.as_deref(), Some("term-1"));
    assert_client_is_me(&f);
    assert_eq!(f.note, None);
    assert_eq!(f.http_version, "HTTP/1.1");
    assert_eq!(f.content_type.as_deref(), Some("application/json"));
    assert!(f.duration_ms.is_some());

    let d = nc.flow(f.id).unwrap();
    assert_eq!(
        d.request_body.as_ref().unwrap().text.as_deref(),
        Some("ping")
    );
    assert_eq!(
        d.response_body.as_ref().unwrap().text.as_deref(),
        Some(r#"{"ok":true}"#),
        "the detail view decodes gzip"
    );
    // Nothing is redacted: credentials are stored
    // exactly as they crossed the proxy, request and response alike.
    assert!(d
        .request_headers
        .contains(&("authorization".into(), "Bearer sk-live-SECRET".into())));
    let json = serde_json::to_string(&d).unwrap();
    assert!(
        json.contains("COOKIE-SECRET"),
        "the upstream's set-cookie is kept verbatim: {json}"
    );

    // The batched event carried the same row (upsert by id).
    tokio::time::sleep(Duration::from_millis(250)).await;
    let emitted: Vec<FlowSummary> = rec.0.lock().unwrap().iter().flatten().cloned().collect();
    assert!(emitted
        .iter()
        .any(|e| e.id == f.id && e.state == FlowState::Pending));
    assert!(emitted
        .iter()
        .any(|e| e.id == f.id && e.state == FlowState::Done));
    assert_eq!(nc.flow(9_999).unwrap_err(), "not-found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connect_in_tunnel_mode_is_one_tunnel_flow_and_never_decrypts() {
    let upstream_ca = Ca::generate().unwrap();
    let up = spawn_tls_upstream(&upstream_ca, &[b"http/1.1"]).await;
    let (nc, _) = proxy(vec![upstream_ca.ca_der().clone()]);
    assert!(!nc.status().decrypt, "decrypt is off by default");
    let client = reqwest_via(&nc, "term-2", Some(upstream_ca.ca_pem()));
    let body = client
        .get(format!("https://localhost:{up}/secret-path"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "hello /secret-path (0 bytes in)");
    drop(client); // closes the pooled tunnel

    let f = wait_for(&nc, "done tunnel", |f| {
        f.proto == FlowProto::Tunnel && f.state == FlowState::Done
    })
    .await;
    assert_eq!(f.method, "CONNECT");
    assert_eq!((f.host.as_str(), f.port), ("localhost", up));
    assert_eq!(f.path, "");
    assert_eq!(f.status, None);
    assert_eq!(f.http_version, "");
    assert_eq!(f.terminal_id.as_deref(), Some("term-2"));
    assert_client_is_me(&f);
    assert_eq!(f.note, None, "decrypt is off: nothing to explain");
    assert!(f.req_bytes > 0 && f.res_bytes > 0, "{f:?}");
    let all = nc.snapshot();
    assert_eq!(all.len(), 1, "exactly one flow: {all:#?}");
    assert!(
        !format!("{all:?}").contains("secret-path"),
        "tunnel mode saw the path"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn decrypt_mode_sees_the_https_path_status_and_body() {
    let upstream_ca = Ca::generate().unwrap();
    let up = spawn_tls_upstream(&upstream_ca, &[b"h2", b"http/1.1"]).await;
    let (nc, _) = proxy(vec![upstream_ca.ca_der().clone()]);
    decrypt_for_me(&nc);
    let ours = nc.ca_pem().unwrap();
    let client = reqwest_via(&nc, "term-3", Some(&ours));
    let res = client
        .post(format!("https://localhost:{up}/v1/messages"))
        .body("{\"model\":\"x\"}")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.text().await.unwrap(),
        "hello /v1/messages (13 bytes in)"
    );

    let f = wait_for(&nc, "done https", |f| f.state == FlowState::Done).await;
    assert_eq!(f.proto, FlowProto::Https);
    assert_eq!(f.path, "/v1/messages");
    assert_eq!(f.status, Some(200));
    assert_eq!(
        f.http_version, "HTTP/1.1",
        "reqwest offers only http/1.1, so we mirror it"
    );
    assert_eq!(f.req_bytes, 13);
    assert_eq!(f.terminal_id.as_deref(), Some("term-3"));
    assert_client_is_me(&f);
    assert!(nc.snapshot().iter().all(|f| f.proto != FlowProto::Tunnel));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_rejects_our_leaf_is_explained_then_passed_through() {
    let upstream_ca = Ca::generate().unwrap();
    let up = spawn_tls_upstream(&upstream_ca, &[b"http/1.1"]).await;
    let (nc, _) = proxy(vec![upstream_ca.ca_der().clone()]);
    decrypt_for_me(&nc);
    let url = format!("https://localhost:{up}/pinned");

    // Trusts ONLY the real upstream CA — like a pinned client or one that ignores SSL_CERT_FILE.
    let pinned = reqwest_via(&nc, "term-4", Some(upstream_ca.ca_pem()));
    assert!(
        pinned.get(&url).send().await.is_err(),
        "our leaf must be rejected"
    );
    let f = wait_for(&nc, "tls rejected", |f| f.state == FlowState::Error).await;
    assert_eq!(f.error.as_deref(), Some(TLS_REJECTED));
    assert_eq!(f.error.as_deref(), Some("tls rejected → passthrough"));
    assert_client_is_me(&f);
    assert_eq!(nc.status().passthrough_hosts, ["localhost"]);

    // The next connection to that host tunnels, so the client works.
    let again = reqwest_via(&nc, "term-4", Some(upstream_ca.ca_pem()));
    let body = again.get(&url).send().await.unwrap().text().await.unwrap();
    assert_eq!(body, "hello /pinned (0 bytes in)");
    drop(again);
    let t = wait_for(&nc, "passthrough tunnel", |f| f.proto == FlowProto::Tunnel).await;
    assert_eq!(
        t.note,
        Some(format!(
            "not decrypted: {} refused the IDE's certificate for this host earlier",
            me()
        )),
        "the learned passthrough is keyed by (executable, host) and explained"
    );
}

/// **Never break a client.** Decrypt is ON and the client (this test
/// binary's reqwest — a compiled Rust client like `gazelle`, trusting only its
/// own roots) is NOT on the allowlist: the proxy must tunnel it, so the request succeeds end to
/// end, and the row explains why it was not decrypted — without calling it an error.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn decrypt_on_never_breaks_a_client_that_is_not_on_the_allowlist() {
    let upstream_ca = Ca::generate().unwrap();
    let up = spawn_tls_upstream(&upstream_ca, &[b"h2", b"http/1.1"]).await;
    let (nc, _) = proxy(vec![upstream_ca.ca_der().clone()]);
    nc.set(None, Some(true)).unwrap();
    assert!(nc.status().decrypt);
    for i in 0..2 {
        let client = reqwest_via(&nc, "gazelle", Some(upstream_ca.ca_pem()));
        let res = client
            .post(format!("https://localhost:{up}/v1/upstream-call"))
            .body("hi")
            .send()
            .await
            .unwrap_or_else(|e| panic!("request {i} broke under decrypt: {e:?}"));
        assert_eq!(res.status(), 200);
        assert_eq!(
            res.text().await.unwrap(),
            "hello /v1/upstream-call (2 bytes in)"
        );
    }
    let f = wait_for(&nc, "tunnel", |f| {
        f.proto == FlowProto::Tunnel && f.state == FlowState::Done
    })
    .await;
    assert_eq!(f.error, None, "not an error state: {f:?}");
    assert_eq!(f.note, Some(not_decrypted_note(&me())));
    assert_eq!(
        f.note.as_deref(),
        Some(format!("not decrypted: {} doesn't read the IDE's CA", me()).as_str())
    );
    assert_eq!(f.terminal_id.as_deref(), Some("gazelle"));
    assert_client_is_me(&f);
    let all = nc.snapshot();
    assert!(
        all.iter()
            .all(|f| f.proto == FlowProto::Tunnel && f.error.is_none()),
        "no MITM attempt, no failure: {all:#?}"
    );
    assert!(
        nc.status().passthrough_hosts.is_empty(),
        "nothing had to be learned"
    );
}

/// **Per-app decrypt opt-in**, end to end through the real proxy. An external client
/// (this test binary — like Postman, not on the allowlist) that trusts the IDE's CA is
/// tunnelled until the user opts it in with `set_app_decrypt`; then its HTTPS is decrypted
/// (path + status visible). Opting out tunnels it again. No `also_decrypt_for` seam here.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_app_the_user_opted_in_is_decrypted_and_opting_out_tunnels_it_again() {
    let upstream_ca = Ca::generate().unwrap();
    let up = spawn_tls_upstream(&upstream_ca, &[b"http/1.1"]).await;
    let (nc, _) = proxy(vec![upstream_ca.ca_der().clone()]);
    nc.set(None, Some(true)).unwrap();
    // Trusts both: the IDE's CA (the user added it in the app) and the real upstream's.
    let ours = nc.ca_pem().unwrap();
    let both = format!("{ours}\n{}", upstream_ca.ca_pem());
    let call = |path: &'static str| {
        let pem = both.clone();
        let port = nc.port();
        async move {
            agent_studio_scaffold_lib::tls::install_crypto_provider();
            let proxy = reqwest::Proxy::all(format!("http://t-ext:x@127.0.0.1:{port}")).unwrap();
            let certs = reqwest::Certificate::from_pem_bundle(pem.as_bytes()).unwrap();
            let c = reqwest::Client::builder()
                .proxy(proxy)
                .tls_certs_only(certs)
                .build()
                .unwrap();
            let r = c
                .get(format!("https://localhost:{up}{path}"))
                .send()
                .await
                .unwrap_or_else(|e| panic!("{path}: {e:?}"));
            assert_eq!(r.status(), 200, "{path}");
        }
    };

    call("/before").await;
    let t = wait_for(&nc, "tunnel before opt-in", |f| {
        f.proto == FlowProto::Tunnel
    })
    .await;
    assert_eq!(t.note, Some(not_decrypted_note(&me())));

    let st = nc.set_app_decrypt(&me(), true).unwrap();
    assert_eq!(st.decrypt_apps, [me()]);
    call("/opted-in").await;
    let f = wait_for(&nc, "decrypted", |f| f.path == "/opted-in").await;
    assert_eq!((f.proto, f.status), (FlowProto::Https, Some(200)));
    assert_client_is_me(&f);

    nc.clear();
    nc.set_app_decrypt(&me(), false).unwrap();
    call("/opted-out").await;
    wait_for(&nc, "tunnel after opt-out", |f| {
        f.proto == FlowProto::Tunnel
    })
    .await;
    assert!(
        nc.snapshot().iter().all(|f| f.path != "/opted-out"),
        "opted out ⇒ not decrypted"
    );
}

/// **Capture localhost.** A plain-HTTP call to a local service by
/// name (`localhost`, a typical `/health` check) goes through the proxy and is captured with
/// method, path, status and the calling process.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_localhost_plain_http_call_is_captured_with_its_client() {
    let up = spawn_plain_upstream().await;
    let (nc, _) = proxy(Vec::new());
    let client = reqwest_via(&nc, "term-h", None);
    let res = client
        .get(format!("http://localhost:{up}/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "hello /health (0 bytes in)");
    let f = wait_for(&nc, "health", |f| f.state == FlowState::Done).await;
    assert_eq!(f.proto, FlowProto::Http);
    assert_eq!((f.method.as_str(), f.path.as_str()), ("GET", "/health"));
    assert_eq!((f.host.as_str(), f.port), ("localhost", up));
    assert_eq!(f.status, Some(200));
    assert_eq!(f.terminal_id.as_deref(), Some("term-h"));
    assert_client_is_me(&f);
}

/// An HTTP/1.1 server bound to exactly `addr` (one address family) that answers every
/// request with `tag`, so a response proves WHICH listener the proxy reached.
async fn spawn_tagged(addr: std::net::SocketAddr, tag: &'static str) -> std::io::Result<u16> {
    let l = TcpListener::bind(addr).await?;
    let port = l.local_addr()?.port();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            tokio::spawn(async move {
                let svc = service_fn(move |_req: Request<Incoming>| async move {
                    Ok::<_, Infallible>(Response::new(full(tag)))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(s), svc)
                    .await;
            });
        }
    });
    Ok(port)
}

/// `localhost` resolves to both `::1` and `127.0.0.1` (in an order the OS picks). A direct
/// client falls back across the addresses until one answers; the proxy must too, or a dev
/// server that listens on only one family (Vite on `::1`, a Rust service on `127.0.0.1`) is
/// unreachable through it. Proved on both upstream paths: the pooled plain-HTTP client and the
/// raw `TcpStream::connect` of a `CONNECT` tunnel.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn localhost_reaches_a_server_on_either_address_family_only() {
    let resolved: Vec<std::net::SocketAddr> = tokio::net::lookup_host(("localhost", 1))
        .await
        .map(|a| a.collect())
        .unwrap_or_default();
    eprintln!("localhost resolves to {resolved:?} (in this order)");
    let v4 = spawn_tagged("127.0.0.1:0".parse().unwrap(), "v4-only")
        .await
        .unwrap();
    let v6 = match spawn_tagged("[::1]:0".parse().unwrap(), "v6-only").await {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!("SKIPPED (v6 half): no IPv6 loopback here ({e})");
            None
        }
    };
    let (nc, _) = proxy(Vec::new());
    let client = reqwest_via(&nc, "term-fam", None);
    let mut cases = vec![(v4, "v4-only")];
    if let Some(p) = v6 {
        assert!(
            resolved.iter().any(|a| a.is_ipv6()),
            "::1 binds but localhost does not resolve to it: {resolved:?}"
        );
        cases.push((p, "v6-only"));
    }
    for (port, tag) in cases {
        // Plain HTTP — the proxy's pooled client dials.
        let res = client
            .get(format!("http://localhost:{port}/fam"))
            .send()
            .await
            .unwrap_or_else(|e| panic!("{tag}: plain request failed: {e}"));
        assert_eq!(res.status(), 200, "{tag}");
        assert_eq!(res.text().await.unwrap(), tag, "reached the {tag} server");
        let f = wait_for(&nc, tag, |f| {
            f.port == port && f.state == FlowState::Done && f.proto == FlowProto::Http
        })
        .await;
        assert_eq!((f.host.as_str(), f.status), ("localhost", Some(200)));

        // CONNECT tunnel — the proxy's own TcpStream::connect dials.
        let mut s = connect_through(&nc, "localhost", port, "term-fam").await;
        s.write_all(b"GET /t HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut got = Vec::new();
        s.read_to_end(&mut got).await.unwrap();
        let got = String::from_utf8_lossy(&got);
        assert!(got.starts_with("HTTP/1.1 200"), "{tag} tunnel: {got}");
        assert!(
            got.ends_with(tag),
            "{tag} tunnel reached the right server: {got}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn h2_grpc_is_classified_with_its_status_and_trailers_pass_through() {
    let upstream_ca = Ca::generate().unwrap();
    let up = spawn_tls_upstream(&upstream_ca, &[b"h2"]).await;
    let (nc, _) = proxy(vec![upstream_ca.ca_der().clone()]);
    decrypt_for_me(&nc);

    let tcp = connect_through(&nc, "localhost", up, "term-5").await;
    let mut roots = rustls::RootCertStore::empty();
    for c in pem_certs(&nc.ca_pem().unwrap()) {
        roots.add(c).unwrap();
    }
    let mut cfg = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect("localhost".try_into().unwrap(), tcp)
        .await
        .expect("client trusts our leaf");
    assert_eq!(
        tls.get_ref().1.alpn_protocol(),
        Some(&b"h2"[..]),
        "h2 mirrored to the client"
    );

    let (mut send, conn) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(tls))
            .await
            .unwrap();
    tokio::spawn(conn);
    let req = Request::post(format!("https://localhost:{up}/pkg.Greeter/SayHello"))
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .body(Full::new(Bytes::from_static(&[0, 0, 0, 0, 3, 10, 1, 120])))
        .unwrap();
    let res = send.send_request(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let collected = res.into_body().collect().await.unwrap();
    let trailers = collected
        .trailers()
        .cloned()
        .expect("trailers reach the client");
    assert_eq!(trailers["grpc-status"], "3");

    let f = wait_for(&nc, "done grpc", |f| f.state == FlowState::Done).await;
    assert_eq!(f.proto, FlowProto::Grpc);
    assert_eq!(f.path, "/pkg.Greeter/SayHello");
    assert_eq!(f.http_version, "HTTP/2");
    assert_eq!(f.grpc_status, Some(3));
    assert_eq!(f.status, Some(200));
    assert_eq!((f.req_bytes, f.res_bytes), (8, 7));
    assert_eq!(f.terminal_id.as_deref(), Some("term-5"));
    assert_client_is_me(&f);
    let d = nc.flow(f.id).unwrap();
    assert!(d
        .response_trailers
        .contains(&("grpc-status".into(), "3".into())));
    assert!(d
        .response_trailers
        .contains(&("grpc-message".into(), "bad name".into())));
}

/// PEM → DER certs, tiny and test-local (no extra crate for one call site).
fn pem_certs(pem: &str) -> Vec<rustls::pki_types::CertificateDer<'static>> {
    pem.split("-----END CERTIFICATE-----")
        .filter(|b| b.contains("BEGIN CERTIFICATE"))
        .map(|b| {
            let body: String = b.lines().filter(|l| !l.starts_with("-----")).collect();
            base64::engine::general_purpose::STANDARD
                .decode(body.trim())
                .unwrap()
                .into()
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_websocket_upgrade_is_a_ws_flow_with_live_message_counts() {
    // Upstream: an echo server.
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (s, _) = l.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        while let Some(Ok(m)) = ws.next().await {
            if m.is_text() || m.is_binary() {
                ws.send(m).await.unwrap();
            }
        }
    });
    let (nc, _) = proxy(Vec::new());

    let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    let handshake = format!(
        "GET http://127.0.0.1:{up}/chat HTTP/1.1\r\nHost: 127.0.0.1:{up}\r\n\
         Upgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
         Proxy-Authorization: Basic {}\r\n\r\n",
        basic("term-6")
    );
    s.write_all(handshake.as_bytes()).await.unwrap();
    let head = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    let mut ws = tokio_tungstenite::WebSocketStream::from_raw_socket(s, Role::Client, None).await;
    for i in 0..3 {
        ws.send(Message::text(format!("m{i}"))).await.unwrap();
        let echo = ws.next().await.unwrap().unwrap();
        assert_eq!(echo.into_text().unwrap().as_str(), format!("m{i}"));
    }
    // Live: counts are visible while the socket is still open.
    let live = wait_for(&nc, "live ws counts", |f| {
        f.ws_messages == Some(WsCounts { up: 3, down: 3 })
    })
    .await;
    assert_eq!(live.state, FlowState::Pending, "still open");
    ws.close(None).await.unwrap();
    drop(ws);

    let f = wait_for(&nc, "closed ws", |f| f.state == FlowState::Done).await;
    assert_eq!(f.proto, FlowProto::Ws);
    assert_eq!(f.status, Some(101));
    assert_eq!(f.path, "/chat");
    assert_eq!(f.terminal_id.as_deref(), Some("term-6"));
    assert_client_is_me(&f);
    assert_eq!(
        f.ws_messages,
        Some(WsCounts { up: 3, down: 3 }),
        "close/ping frames are not messages"
    );
    assert!(f.req_bytes > 0 && f.res_bytes > 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_origin_form_request_is_refused_with_400() {
    let (nc, _) = proxy(Vec::new());
    let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    s.write_all(b"GET /index.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        .await
        .unwrap();
    let head = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 400"), "{head}");
    assert!(nc.snapshot().is_empty(), "a refused request is not a flow");
}

/// We never originate TLS for a client: absolute-form `https://` (and any non-http scheme) is
/// refused outright rather than turned into a 502 from a connector that cannot speak it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_absolute_form_https_or_ftp_request_is_refused_with_400() {
    let (nc, _) = proxy(Vec::new());
    for target in ["https://127.0.0.1:1/x", "ftp://127.0.0.1:1/x"] {
        let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let head = read_head(&mut s).await;
        assert!(head.starts_with("HTTP/1.1 400"), "{target}: {head}");
    }
    assert!(nc.snapshot().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connect_to_a_dead_port_is_502_and_an_error_flow() {
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (nc, _) = proxy(Vec::new());
    let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    s.write_all(format!("CONNECT 127.0.0.1:{dead} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let head = read_head(&mut s).await;
    assert!(head.starts_with("HTTP/1.1 502"), "{head}");
    let f = wait_for(&nc, "error", |f| f.state == FlowState::Error).await;
    assert_eq!(f.proto, FlowProto::Tunnel);
    assert!(
        f.error.as_deref().unwrap().starts_with("upstream: "),
        "{f:?}"
    );
    assert_eq!(
        f.terminal_id, None,
        "no Proxy-Authorization ⇒ unattributed, still served"
    );
    assert_client_is_me(&f);
}

/// Seen from a client: a refused plain-HTTP upstream used to come back as
/// `502 "Agent Studio capture proxy: upstream: Connection refused"` — an HTTP response where the
/// client expects a transport error, so every "unreachable host → error" test (a service's
/// `http://127.0.0.1:1`) failed inside an IDE terminal. Now the proxy ends the client's connection
/// without writing a single byte, and still records the refusal as an error flow.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plain_request_to_a_refused_port_ends_the_connection_never_a_502() {
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (nc, _) = proxy(Vec::new());
    let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    s.write_all(
        format!("GET http://127.0.0.1:{dead}/health HTTP/1.1\r\nHost: 127.0.0.1:{dead}\r\n\r\n")
            .as_bytes(),
    )
    .await
    .unwrap();
    // Not one byte of HTTP: the connection just ends (EOF, or a reset), promptly.
    let mut got = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut got))
        .await
        .expect("the proxy ends the connection instead of leaving the client hanging");
    assert!(
        read.is_err() || got.is_empty(),
        "no HTTP response may be made up: {:?}",
        String::from_utf8_lossy(&got)
    );
    // The Network view still shows what happened.
    let f = wait_for(&nc, "error", |f| f.state == FlowState::Error).await;
    assert_eq!(f.host, "127.0.0.1");
    assert_eq!(f.port, dead);
    let err = f.error.as_deref().unwrap();
    assert!(
        err.starts_with("upstream: ") && err.to_lowercase().contains("refused"),
        "{f:?}"
    );
    assert_client_is_me(&f);
}

/// The regression check, with a real client: `GET http://127.0.0.1:1` through the
/// proxy is a client-side ERROR (no status, no body) — never a 502 the client can read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reqwest_through_the_proxy_to_port_1_is_an_error_never_a_502() {
    let (nc, _) = proxy(Vec::new());
    agent_studio_scaffold_lib::tls::install_crypto_provider();
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{}", nc.port())).unwrap())
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let res = client.get("http://127.0.0.1:1/").send().await;
    match res {
        Ok(r) => panic!(
            "a refused upstream must be a transport error, got HTTP {}",
            r.status()
        ),
        Err(e) => {
            assert!(e.status().is_none(), "{e:?}");
            assert!(
                !e.is_timeout(),
                "the client must not wait out its timeout: {e:?}"
            );
        }
    }
    // …and the proxy is still serving: the next request to a live upstream goes through.
    let live = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = live.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (tcp, _) = live.accept().await.unwrap();
        let svc = service_fn(|_req: Request<Incoming>| async {
            Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"alive"))))
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(tcp), svc)
            .await;
    });
    let ok = client
        .get(format!("http://127.0.0.1:{port}/"))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    assert_eq!(ok.text().await.unwrap(), "alive");
}

// ── Real tools (not hermetic — they run system binaries) ───────────────────────────

/// The env a real tool gets: exactly what `pty_env` hands a terminal, plus a minimal PATH/HOME.
/// On Windows the minimum is different: `PATH` is System32, and a process started
/// with a cleared environment also needs `SystemRoot` (Winsock and the crypto providers fail
/// to load without it) and a temp dir.
fn tool_env(env: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = env.to_vec();
    let temp: String = std::env::temp_dir().to_string_lossy().into();
    if cfg!(windows) {
        let root = system_root();
        out.push(("SystemRoot".into(), root.to_string_lossy().into()));
        out.push((
            "PATH".into(),
            root.join("System32").to_string_lossy().into(),
        ));
        out.push(("TEMP".into(), temp.clone()));
        out.push(("TMP".into(), temp.clone()));
        out.push(("USERPROFILE".into(), temp.clone()));
    } else {
        out.push(("PATH".into(), "/usr/bin:/bin".into()));
    }
    out.push(("HOME".into(), temp));
    out
}

/// `%SystemRoot%` (`C:\Windows`). Windows only in meaning; harmless elsewhere.
fn system_root() -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
}

/// The curl the OS ships: `/usr/bin/curl` on macOS/Linux, `System32\curl.exe` on Windows
/// (Schannel — which is why Windows tunnels it instead of decrypting, `reads_injected_ca_on`).
fn system_curl() -> std::path::PathBuf {
    if cfg!(windows) {
        system_root().join("System32").join("curl.exe")
    } else {
        std::path::PathBuf::from("/usr/bin/curl")
    }
}

/// Is `client_path` (as the proxy resolved it) the system curl? Windows paths compare without
/// case (`C:\WINDOWS\system32` vs `C:\Windows\System32`).
fn is_system_curl(client_path: &str) -> bool {
    let want = system_curl().to_string_lossy().into_owned();
    if cfg!(windows) {
        client_path.eq_ignore_ascii_case(&want)
    } else {
        client_path == want
    }
}

fn env_get(env: &[(String, String)], k: &str) -> String {
    env.iter()
        .find(|(n, _)| n == k)
        .unwrap_or_else(|| panic!("{k} not in pty_env: {env:?}"))
        .1
        .clone()
}

/// `<system curl> -sS -m 20 <args>` with `env` only (no login shell, no user rc).
async fn curl(env: &[(String, String)], args: &[&str]) -> std::process::Output {
    let env = tool_env(env);
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        std::process::Command::new(system_curl())
            .args(["-sS", "-m", "20"])
            .args(&args)
            .env_clear()
            .envs(env)
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

/// Whether this Node honours `NODE_USE_ENV_PROXY` (added in 24.5.0, backported to 22.21.0).
fn node_supports_env_proxy(version: &str) -> bool {
    let v: Vec<u32> = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect();
    match (v.first(), v.get(1)) {
        (Some(&maj), _) if maj >= 25 => true,
        (Some(&24), Some(&min)) => min >= 5,
        (Some(&22), Some(&min)) => min >= 21,
        _ => false,
    }
}

/// `node -e "fetch(url)…"` with `env` (+ PATH/HOME), when node is installed. `None` (with the
/// reason printed) when it is not. Found by `Command::new("node")` on this process's PATH — no
/// login shell. Returns (version, output).
async fn node_fetch(env: &[(String, String)], url: &str) -> Option<(String, std::process::Output)> {
    let probe = std::process::Command::new("node")
        .args(["-p", "process.execPath + ' ' + process.version"])
        .output();
    let Ok(probe) = probe.map_err(|e| eprintln!("SKIP node part: node not on PATH ({e})")) else {
        return None;
    };
    let line = String::from_utf8_lossy(&probe.stdout).trim().to_string();
    let Some((exe, version)) = line.rsplit_once(' ') else {
        eprintln!("SKIP node part: unexpected `node -p` output {line:?}");
        return None;
    };
    let (exe, version) = (exe.to_string(), version.to_string());
    let script = format!(
        "fetch({url:?}).then(r => r.text().then(t => {{ console.log(r.status + ' ' + t); }}))\
         .catch(e => {{ console.error(String(e && e.cause || e)); process.exit(3); }})"
    );
    let env = tool_env(env);
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new(exe)
            .args(["-e", &script])
            .env_clear()
            .envs(env)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    Some((version, out))
}

/// Without the shim, an agent in an IDE terminal running
/// `curl -s --noproxy '*' http://127.0.0.1:3000/…` bypassed Network entirely. Now the IDE
/// terminal's `PATH` starts with the curl shim (`netcap::shim`), so the SAME command — typed
/// into a REAL PTY spawned with the injected env, resolved through `PATH` like any shell
/// does — runs the real `/usr/bin/curl` through the proxy, attributed to the terminal. Plain
/// `http://127.0.0.1:<port>` through the proxy is served correctly (the body comes back).
///
/// Falsified in the same run: with `strictAgentCapture` off the identical command bypasses
/// the proxy again (still succeeds, no flow) — so it is the shim, not luck, that captures it.
/// No env value is ever printed.
///
/// Run: `cargo test --test netcap_e2e -- --ignored --exact real_curl_noproxy_in_a_pty_is_captured_by_the_shim`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "local integration: a real PTY running the system /usr/bin/curl through the shim"]
async fn real_curl_noproxy_in_a_pty_is_captured_by_the_shim() {
    use agent_studio_scaffold_lib::pty;
    assert!(
        std::path::Path::new("/usr/bin/curl").exists(),
        "needs /usr/bin/curl"
    );
    let plain = spawn_plain_upstream().await;
    let dir = std::env::temp_dir().join(format!("netcap-shim-{}", ulid::Ulid::new()));
    let nc = Netcap::start(
        NetcapConfig {
            dir: Some(dir.clone()),
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        },
        Arc::new(Recorder::default()),
    )
    .unwrap();
    let shim = nc
        .shim_dir()
        .expect("the shim is written into the config dir");
    let base = [(
        "PATH".to_string(),
        "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
    )];

    // Run `cmd` in a real PTY with `pty_env` for `terminal`, exactly as the supervisor does
    // (inherited env + TTY vars + `spec.env`). Returns the terminal's output.
    let run_in_pty = |env: Vec<(String, String)>, cmd: String| async move {
        let spec = pty::SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), cmd],
            cwd: std::env::temp_dir(),
            env,
            rows: 24,
            cols: 200,
        };
        let spawn = pty::spawn_pty(&spec).expect("spawn_pty");
        let mut rx = pty::reader::start_reader(spawn.reader);
        let mut child = spawn.child;
        let mut out = Vec::new();
        let collect = async {
            while let Some(chunk) = rx.recv().await {
                out.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&out).contains("EXIT=") {
                    break;
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(30), collect)
            .await
            .expect("the PTY command finished");
        let _ = tokio::task::spawn_blocking(move || child.wait()).await;
        String::from_utf8_lossy(&out).into_owned()
    };
    let noproxy_curl = |path: &str| {
        format!(
            "command -v curl; curl -s --noproxy '*' http://127.0.0.1:{plain}{path}; echo \" EXIT=$?\""
        )
    };

    // Strict (the default): the shim drops --noproxy → the flow is in the proxy.
    let env = nc.pty_env_with("shim-term", &base);
    assert!(
        env.iter()
            .any(|(k, v)| k == "PATH" && v.starts_with(&*shim.to_string_lossy())),
        "the shim dir leads PATH"
    );
    let out = run_in_pty(env, noproxy_curl("/shim-bypass")).await;
    assert!(out.contains(" EXIT=0"), "curl failed in the PTY: {out}");
    assert!(
        out.contains(&format!("{}/curl", shim.display())),
        "`curl` resolves to the shim: {out}"
    );
    assert!(
        out.contains("hello /shim-bypass (0 bytes in)"),
        "plain loopback HTTP served through the proxy: {out}"
    );
    let f = wait_for(&nc, "the shimmed curl", |f| {
        f.path == "/shim-bypass" && f.state == FlowState::Done
    })
    .await;
    assert_eq!((f.proto, f.status), (FlowProto::Http, Some(200)));
    assert_eq!(f.terminal_id.as_deref(), Some("shim-term"));
    assert_eq!(f.host, "127.0.0.1");
    let c = f.client.as_ref().expect("client resolved");
    assert_eq!(
        (c.name.as_str(), c.path.as_deref()),
        ("curl", Some("/usr/bin/curl")),
        "the REAL curl made the request (the shim exec'd it)"
    );

    // Falsify: strict off → the identical command bypasses the proxy again.
    nc.set_strict(false);
    let env = nc.pty_env_with("shim-term", &base);
    let out = run_in_pty(env, noproxy_curl("/shim-off")).await;
    assert!(out.contains(" EXIT=0"), "curl failed in the PTY: {out}");
    assert!(out.contains("hello /shim-off (0 bytes in)"), "{out}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !nc.snapshot().iter().any(|f| f.path == "/shim-off"),
        "strict off must leave --noproxy alone (it bypassed)"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Local integration (`#[ignore]`d — it drives system binaries; `npm run verify` runs it as a
/// blocking local step). Decrypt ON, env exactly as `pty_env` hands a terminal:
/// 1. `/usr/bin/curl` (allowlisted) `http://localhost/…` — loopback is captured;
/// 2. `/usr/bin/curl` with the injected `CURL_CA_BUNDLE` → `https://localhost/…` DECRYPTED
///    (path, status, `client.name == "curl"`);
/// 3. `node` `fetch` with `NODE_USE_ENV_PROXY=1` + `NODE_EXTRA_CA_CERTS` → decrypted (skipped
///    with a printed reason when node is absent or too old to honour the variable);
/// 4. **the documented limitation**: an allowlisted client that explicitly distrusts us
///    (`curl --cacert <the upstream's own CA>`) fails ONCE (`tls rejected → passthrough`),
///    then that (executable, host) is tunnelled and works.
///
///
/// **On Windows** (the same test, the Windows contract): the system curl
/// is `System32\curl.exe`, a Schannel build that is deliberately NOT decrypted
/// (`reads_injected_ca_on`). So step 2 there proves the other half of the promise: curl,
/// trusting only the upstream's OWN CA (`--cacert`, `--ssl-no-revoke` because Schannel checks
/// revocation and a test CA has no CRL), succeeds through the proxy — which it could not if the
/// IDE had put its leaf in the way — and the row is a tunnel with the "doesn't read the IDE's
/// CA" note. Step 4 does not apply (a client that is never decrypted has nothing to reject) and
/// says so. Steps 1 and 3 are identical.
///
/// Run: `cargo test --test netcap_e2e -- --ignored --exact real_curl_through_the_proxy_is_captured`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "local integration: drives the system curl (and node, if installed)"]
async fn real_curl_through_the_proxy_is_captured() {
    assert!(
        system_curl().exists(),
        "needs the system curl at {}",
        system_curl().display()
    );
    let upstream_ca = Ca::generate().unwrap();
    let plain = spawn_plain_upstream().await;
    let tls = spawn_tls_upstream(&upstream_ca, &[b"h2", b"http/1.1"]).await;
    let dir = std::env::temp_dir().join(format!("netcap-curl-{}", ulid::Ulid::new()));
    let nc = Netcap::start(
        NetcapConfig {
            dir: Some(dir.clone()),
            trust_anchors: Some(vec![upstream_ca.ca_der().clone()]),
            user_env: Vec::new(),
            preferred_port: None,
        },
        Arc::new(Recorder::default()),
    )
    .unwrap();
    // No `ready()`: the bundle exists as soon as `start` returns.
    nc.set(None, Some(true)).unwrap();
    let env = nc.pty_env_with("curl-term", &[]);
    assert!(std::path::Path::new(&env_get(&env, "CURL_CA_BUNDLE")).is_file());
    assert_eq!(env_get(&env, "NO_PROXY"), "", "loopback is captured");
    let is_curl = |f: &FlowSummary| {
        let c = f.client.as_ref().expect("client resolved");
        c.name == "curl" && c.path.as_deref().is_some_and(is_system_curl)
    };
    // The upstream's own CA, for a client that must verify the REAL upstream (Windows step 2,
    // and step 4 everywhere).
    let theirs = dir.join("upstream-only.pem");
    std::fs::write(&theirs, upstream_ca.ca_pem()).unwrap();
    let theirs = theirs.to_string_lossy().into_owned();

    // 1 — localhost, plain HTTP.
    let out = curl(&env, &[&format!("http://localhost:{plain}/curl-plain")]).await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let p = wait_for(&nc, "curl plain", |f| {
        f.path == "/curl-plain" && f.state == FlowState::Done
    })
    .await;
    assert_eq!((p.proto, p.status), (FlowProto::Http, Some(200)));
    assert_eq!(p.terminal_id.as_deref(), Some("curl-term"));
    assert!(is_curl(&p), "{p:?}");

    if cfg!(windows) {
        // 2 (Windows) — Schannel curl is tunnelled, never broken: verifying the upstream's own
        // certificate succeeds through the proxy, and the row says why it was not decrypted.
        let url = format!("https://localhost:{tls}/curl-tls");
        let out = curl(&env, &["--cacert", &theirs, "--ssl-no-revoke", &url]).await;
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "hello /curl-tls (0 bytes in)"
        );
        let t = wait_for(&nc, "curl tunnel", |f| {
            f.proto == FlowProto::Tunnel && f.port == tls && f.state == FlowState::Done
        })
        .await;
        assert_eq!(t.terminal_id.as_deref(), Some("curl-term"));
        assert!(is_curl(&t), "{t:?}");
        assert_eq!(
            t.note.as_deref(),
            Some("not decrypted: curl doesn't read the IDE's CA")
        );
    } else {
        // 2 — HTTPS, trusting only what pty_env injected → decrypted.
        let out = curl(&env, &[&format!("https://localhost:{tls}/curl-tls")]).await;
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "hello /curl-tls (0 bytes in)"
        );
        let t = wait_for(&nc, "curl tls", |f| {
            f.path == "/curl-tls" && f.state == FlowState::Done
        })
        .await;
        assert_eq!((t.proto, t.status), (FlowProto::Https, Some(200)));
        assert_eq!(t.terminal_id.as_deref(), Some("curl-term"));
        assert!(is_curl(&t), "{t:?}");
    }

    // 3 — node fetch (built-in fetch honours the proxy only with NODE_USE_ENV_PROXY=1).
    assert_eq!(env_get(&env, "NODE_USE_ENV_PROXY"), "1");
    let url = format!("https://localhost:{tls}/node-fetch");
    if let Some((version, out)) = node_fetch(&env, &url).await {
        if node_supports_env_proxy(&version) {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&out.stdout).trim(),
                "200 hello /node-fetch (0 bytes in)"
            );
            let n = wait_for(&nc, "node fetch", |f| {
                f.path == "/node-fetch" && f.state == FlowState::Done
            })
            .await;
            assert_eq!((n.proto, n.status), (FlowProto::Https, Some(200)));
            assert_eq!(n.client.as_ref().map(|c| c.name.as_str()), Some("node"));
        } else {
            eprintln!(
                "SKIP node part: node {version} ignores NODE_USE_ENV_PROXY (needs ≥ 22.21 / ≥ 24.5)"
            );
        }
    }

    // 4 — allowlisted but explicitly distrusting our CA: one explained failure, then a tunnel.
    if cfg!(windows) {
        eprintln!(
            "NOT APPLICABLE on Windows: step 4 — curl.exe is never decrypted there, so it has \
             no leaf to reject; step 2 proved the tunnel"
        );
        let _ = std::fs::remove_dir_all(dir);
        return;
    }
    let url = format!("https://localhost:{tls}/curl-distrust");
    let out = curl(&env, &["--cacert", &theirs, &url]).await;
    assert!(
        !out.status.success(),
        "curl must reject our leaf the first time"
    );
    let rejected = wait_for(&nc, "tls rejected", |f| {
        f.error.as_deref() == Some(TLS_REJECTED)
    })
    .await;
    assert!(is_curl(&rejected), "{rejected:?}");
    let out = curl(&env, &["--cacert", &theirs, &url]).await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "hello /curl-distrust (0 bytes in)"
    );
    let tun = wait_for(&nc, "learned tunnel", |f| {
        f.proto == FlowProto::Tunnel && f.state == FlowState::Done && f.note.is_some()
    })
    .await;
    assert!(is_curl(&tun), "{tun:?}");
    assert_eq!(
        tun.note.as_deref(),
        Some("not decrypted: curl refused the IDE's certificate for this host earlier")
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// Terminal output with VT escape sequences removed (ConPTY repaints with cursor moves).
#[cfg(windows)]
fn strip_vt(raw: &str) -> String {
    let mut s = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            s.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                for c in chars.by_ref() {
                    if c == '\x07' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    s
}

/// A real terminal for the Windows test: what it printed, and a typist. Every wait is bounded,
/// and a cursor-position query is answered as xterm.js answers it.
#[cfg(windows)]
struct WinTerm {
    handle: agent_studio_scaffold_lib::pty::PtyHandle,
    rx: tokio::sync::mpsc::Receiver<Bytes>,
    raw: String,
    answered: usize,
}

#[cfg(windows)]
impl WinTerm {
    fn text(&self) -> String {
        strip_vt(&self.raw)
    }

    fn type_line(&mut self, line: &str) {
        self.handle
            .write_input(format!("{line}\r").as_bytes())
            .expect("type into the PTY");
    }

    /// Read until `needle` shows (VT stripped, any case), at most 60 s.
    async fn until(&mut self, needle: &str) -> bool {
        let needle = needle.to_lowercase();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            if self.text().to_lowercase().contains(&needle) {
                return true;
            }
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(left, self.rx.recv()).await {
                Ok(Some(chunk)) => {
                    self.raw.push_str(&String::from_utf8_lossy(&chunk));
                    let asked = self.raw.matches("\x1b[6n").count();
                    while self.answered < asked {
                        let _ = self.handle.write_input(b"\x1b[1;1R");
                        self.answered += 1;
                    }
                }
                _ => return false,
            }
        }
    }
}

/// **Windows, end to end** (local integration, `#[ignore]`d like the other real-tool tests).
/// A REAL Windows PowerShell terminal — ConPTY, the IDE's startup command
/// (`pty::shell_startup_args`), the env `pty_env` hands a terminal (config dir, so the curl
/// shim and the Node preload exist) — runs what a user types:
/// 1. `(Get-Command curl).Source` is `System32\curl.exe`: the shim is NOT on a Windows
///    terminal's `PATH` (PowerShell would try to open the extensionless file as a document);
/// 2. `curl.exe http://127.0.0.1:<port>/…` → captured, `client.name == "curl"` (no `.exe`);
/// 3. `node -e "fetch(…)"` → captured, `client.name == "node"`, and no `[UNDICI-EHPA]`
///    warning printed (skipped with the reason when node is absent or too old to proxy);
/// 4. `Invoke-WebRequest http://<a .invalid host>/…` → reaches the proxy (the startup
///    command's `DefaultWebProxy`) and is attributed to the TERMINAL from the client's own
///    environment, though Windows PowerShell sends no proxy credentials.
///
/// Run: `cargo test --test netcap_e2e -- --ignored --exact on_windows_a_powershell_terminal_is_captured`.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "local integration: a real PowerShell terminal running curl.exe, node and Invoke-WebRequest"]
async fn on_windows_a_powershell_terminal_is_captured() {
    use agent_studio_scaffold_lib::pty;
    let plain = spawn_plain_upstream().await;
    let dir = std::env::temp_dir().join(format!("netcap-win {}", ulid::Ulid::new()));
    let nc = Netcap::start(
        NetcapConfig {
            dir: Some(dir.clone()),
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        },
        Arc::new(Recorder::default()),
    )
    .unwrap();
    assert!(
        nc.shim_dir().is_some(),
        "the shim is written on Windows too"
    );
    let env = nc.pty_env_with("ps-term", &[]);
    assert!(
        !env.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH")),
        "a Windows terminal's PATH is left alone"
    );
    assert!(env.iter().any(|(k, _)| k == "AGENTSTUDIO_SHIM_DIR"));
    assert!(env.iter().any(|(k, _)| k == "NODE_OPTIONS"));

    let startup = pty::shell_startup_args("powershell", vec![], true);
    let mut args = vec!["-NoProfile".to_string(), "-NoLogo".to_string()];
    args.extend(startup);
    let spawn = pty::spawn_pty(&pty::SpawnSpec {
        program: "powershell".into(),
        args,
        cwd: std::env::temp_dir(),
        env,
        rows: 40,
        cols: 220,
    })
    .expect("spawn powershell in a PTY");
    let mut child = spawn.child;
    let mut t = WinTerm {
        handle: spawn.handle,
        rx: pty::reader::start_reader(spawn.reader),
        raw: String::new(),
        answered: 0,
    };
    assert!(t.until("PS ").await, "no prompt: {}", t.text());

    // 1 — `curl` is curl.exe. (Each marker is built from two strings, so the echo of the
    // typed line never matches it.)
    t.type_line("'CURL-' + 'IS=' + (Get-Command curl).Source");
    assert!(
        t.until(r"CURL-IS=C:\WINDOWS\system32\curl.exe").await,
        "{}",
        t.text()
    );

    // 2 — curl.exe to loopback, through the proxy.
    t.type_line(&format!(
        "curl.exe -sS -m 20 http://127.0.0.1:{plain}/ps-curl; 'CURL-' + 'RC=' + $LASTEXITCODE"
    ));
    assert!(t.until("CURL-RC=0").await, "{}", t.text());
    let f = wait_for(&nc, "curl.exe", |f| {
        f.path == "/ps-curl" && f.state == FlowState::Done
    })
    .await;
    assert_eq!((f.proto, f.status), (FlowProto::Http, Some(200)));
    assert_eq!(f.terminal_id.as_deref(), Some("ps-term"));
    assert_eq!(f.client.as_ref().map(|c| c.name.as_str()), Some("curl"));

    // 3 — node's built-in fetch, through the proxy, without the experimental warning.
    let node = std::process::Command::new("node").arg("--version").output();
    match node {
        Ok(o) if node_supports_env_proxy(&String::from_utf8_lossy(&o.stdout)) => {
            t.type_line(&format!(
                "node -e \"fetch('http://127.0.0.1:{plain}/ps-node').then(r => r.text())\
                 .then(b => console.log('NODE-' + 'GOT=' + b))\"; 'NODE-' + 'RC=' + $LASTEXITCODE"
            ));
            assert!(t.until("NODE-RC=0").await, "{}", t.text());
            assert!(
                t.text().contains("NODE-GOT=hello /ps-node (0 bytes in)"),
                "{}",
                t.text()
            );
            assert!(
                !t.raw.contains("UNDICI-EHPA"),
                "the preload hides the warning: {}",
                t.text()
            );
            // undici's proxy agent CONNECTs even for an `http://` target (measured here, Node
            // 22.23.5), so this is a tunnel to the upstream's port, not an HTTP row with a path.
            let n = wait_for(&nc, "node fetch", |f| {
                f.client.as_ref().is_some_and(|c| c.name == "node")
                    && f.port == plain
                    && f.state == FlowState::Done
            })
            .await;
            assert_eq!(n.proto, FlowProto::Tunnel);
            assert_eq!(n.terminal_id.as_deref(), Some("ps-term"));
            assert_eq!(n.client.as_ref().map(|c| c.name.as_str()), Some("node"));
        }
        Ok(o) => eprintln!(
            "SKIP node part: node {} ignores NODE_USE_ENV_PROXY (needs ≥ 22.21 / ≥ 24.5)",
            String::from_utf8_lossy(&o.stdout).trim()
        ),
        Err(e) => eprintln!("SKIP node part: node not on PATH ({e})"),
    }

    // 4 — Windows PowerShell's own web cmdlet, through the startup command's DefaultWebProxy.
    t.type_line(
        "try { Invoke-WebRequest http://agentstudio-e2e.invalid/ps-iwr -UseBasicParsing -TimeoutSec 20 \
         | Out-Null } catch {}; 'IWR-' + 'DONE'",
    );
    assert!(t.until("IWR-DONE").await, "{}", t.text());
    let w = wait_for(&nc, "Invoke-WebRequest", |f| {
        f.host == "agentstudio-e2e.invalid" && f.path == "/ps-iwr"
    })
    .await;
    assert_eq!(
        w.terminal_id.as_deref(),
        Some("ps-term"),
        "attributed from the client's environment: {w:?}"
    );
    assert_eq!(
        w.client.as_ref().map(|c| c.name.as_str()),
        Some("powershell")
    );

    t.handle.kill();
    let _ = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || child.wait()),
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// **External, non-blocking** (`#[ignore]`d — public internet; `npm run verify` reports it but
/// a third party's outage is not our regression). ONE reputable host only: `example.com`
/// (IANA's reserved documentation domain). Decrypt ON, the proxy's upstream trust = the app's
/// real policy (OS anchors ∪ Mozilla set), env exactly as `pty_env` hands a terminal:
/// (a) `/usr/bin/curl` (allowlisted) → DECRYPTED: 200, path `/`, body "Example Domain". On
///     Windows `curl.exe` is a Schannel client, not allowlisted → a working tunnel with the note;
/// (b) this test binary's reqwest (NOT allowlisted, platform verifier) → the request SUCCEEDS
///     and the flow is a tunnel with the "not decrypted" note — never-break against a real site;
/// (c) `node` fetch with `NODE_USE_ENV_PROXY=1` → decrypted (skipped, with the reason printed,
///     when node is absent or too old). No credentials; finite timeouts.
///
/// Run: `cargo test --test netcap_e2e -- --ignored --exact live_example_com_through_the_proxy`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "external: reaches https://example.com/ over the public internet"]
async fn live_example_com_through_the_proxy() {
    const URL: &str = "https://example.com/";
    let dir = std::env::temp_dir().join(format!("netcap-live-{}", ulid::Ulid::new()));
    let nc = Netcap::start(
        NetcapConfig {
            dir: Some(dir.clone()),
            trust_anchors: None,
            user_env: Vec::new(),
            preferred_port: None,
        },
        Arc::new(Recorder::default()),
    )
    .unwrap();
    nc.set(None, Some(true)).unwrap();
    let env = nc.pty_env_with("live-term", &[]);

    // (a) curl, decrypted.
    let out = curl(&env, &[URL]).await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("Example Domain"));
    let a = wait_for(&nc, "curl example.com", |f| {
        f.host == "example.com"
            && f.state == FlowState::Done
            && f.client.as_ref().is_some_and(|c| c.name == "curl")
    })
    .await;
    if cfg!(windows) {
        // Windows' curl.exe is a Schannel client: it trusts the Windows store, not the CA file we
        // inject, so it is tunnelled, never broken, and the row says why (the macOS/Linux
        // decrypt does not apply here, as in `real_curl_through_the_proxy_is_captured`).
        assert_eq!(a.proto, FlowProto::Tunnel, "{a:?}");
        assert_eq!(
            a.note.as_deref(),
            Some("not decrypted: curl doesn't read the IDE's CA")
        );
    } else {
        assert_eq!(a.proto, FlowProto::Https, "{a:?}");
        assert_eq!((a.path.as_str(), a.status), ("/", Some(200)));
        let body = nc.flow(a.id).unwrap().response_body.unwrap();
        assert!(
            body.text
                .as_deref()
                .unwrap_or("")
                .contains("Example Domain"),
            "{body:?}"
        );
    }

    // (b) a client that does not read our CA: tunnelled, and it works.
    agent_studio_scaffold_lib::tls::install_crypto_provider();
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(env_get(&env, "HTTPS_PROXY")).unwrap())
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let res = client.get(URL).send().await.expect("never break a client");
    assert_eq!(res.status(), 200);
    assert!(res.text().await.unwrap().contains("Example Domain"));
    drop(client);
    // A later flow than (a)'s: on Windows (a) is a finished example.com tunnel too.
    let b = wait_for(&nc, "reqwest tunnel", |f| {
        f.id > a.id
            && f.host == "example.com"
            && f.proto == FlowProto::Tunnel
            && f.state == FlowState::Done
    })
    .await;
    assert_eq!(b.note, Some(not_decrypted_note(&me())));
    assert_eq!(b.error, None);
    assert_client_is_me(&b);

    // (c) node, if it can use the proxy.
    if let Some((version, out)) = node_fetch(&env, URL).await {
        if node_supports_env_proxy(&version) {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(stdout.starts_with("200 ") && stdout.contains("Example Domain"));
            let c = wait_for(&nc, "node example.com", |f| {
                f.host == "example.com"
                    && f.state == FlowState::Done
                    && f.client.as_ref().is_some_and(|c| c.name == "node")
            })
            .await;
            assert_eq!(
                (c.proto, c.path.as_str(), c.status),
                (FlowProto::Https, "/", Some(200))
            );
        } else {
            eprintln!(
                "SKIP node part: node {version} ignores NODE_USE_ENV_PROXY (needs ≥ 22.21 / ≥ 24.5)"
            );
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn node_env_proxy_support_is_decided_by_version() {
    for (v, want) in [
        ("v22.20.0", false),
        ("v22.21.0", true),
        ("v23.9.0", false),
        ("v24.4.1", false),
        ("v24.5.0", true),
        ("v25.0.0", true),
        ("v18.20.4", false),
        ("garbage", false),
    ] {
        assert_eq!(node_supports_env_proxy(v), want, "{v}");
    }
}
