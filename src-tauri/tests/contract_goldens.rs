//! Rust half of the Network/Agent Logs contract goldens: real production values serialised as
//! Tauri does, byte-compared with `src/test/contract/goldens/*.json`; volatile fields normalised.
//! Regenerate: `UPDATE_GOLDENS=1 cargo test --test contract_goldens`, then update the TS side.

#![cfg(unix)]

mod common;
/// System-app logs and whole-computer network.
#[path = "contract_goldens/machine.rs"]
mod machine;
/// Dev apps on this machine — `procs_list`, `app` lines, the tail/restart
/// command results.
#[path = "contract_goldens/procs.rs"]
mod procs;
/// Agent Village: `list_external_agents` — the `claude` sessions outside the IDE.
#[path = "contract_goldens/village.rs"]
mod village;
/// Agent Village ambience: `village_weather` — the live weather report.
#[path = "contract_goldens/weather.rs"]
mod weather;

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::agent::adapter::AgentAdapter;
use agent_studio_scaffold_lib::agent::claude::ClaudeAdapter;
use agent_studio_scaffold_lib::agent::fanout::TranscriptLocation;
use agent_studio_scaffold_lib::agent::tools::TranscriptToolTail;
use agent_studio_scaffold_lib::events::NullSink;
use agent_studio_scaffold_lib::http::{HttpHeader, HttpRequest};
use agent_studio_scaffold_lib::logstream::tasks::{TaskSlots, TaskTails, MAX_TASK_TAILS};
use agent_studio_scaffold_lib::logstream::{
    source_label, LineDraft, LogHub, LogKind, LogLevel, LogLine, NullLogSink,
};
use agent_studio_scaffold_lib::netcap::ca::Ca;
use agent_studio_scaffold_lib::netcap::client::client_name;
use agent_studio_scaffold_lib::netcap::record::{Tap, IDE_CLIENT_NAME, IDE_TERMINAL_ID};
use agent_studio_scaffold_lib::netcap::store::BODY_CAP;
use agent_studio_scaffold_lib::netcap::{
    ClientProcess, FlowDetail, FlowProto, FlowSink, FlowState, FlowSummary, Netcap, NetcapConfig,
    NetcapStatus, PortChange, WsCounts,
};
use agent_studio_scaffold_lib::supervisor::poll_task_tails;
use agent_studio_scaffold_lib::supervisor::{spawn_supervisor_with_logs, OpenSpec};
use base64::Engine as _;
use bytes::Bytes;
use common::{hook_payload, interactive_sh, sh, ChannelSink, StubAdapter, TIMEOUT};
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::{protocol::Role, Message};

// ── the golden files ─────────────────────────────────────────────────────────

const REGEN: &str =
    "UPDATE_GOLDENS=1 cargo test --manifest-path src-tauri/Cargo.toml --test contract_goldens";

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/test/contract/goldens")
        .join(name)
}

fn updating() -> bool {
    std::env::var("UPDATE_GOLDENS").is_ok_and(|v| v == "1")
}

/// Serialise like Tauri (the typed value, pretty for a reviewable diff) and compare.
fn check_golden<T: Serialize>(name: &str, value: &T) {
    let actual = serde_json::to_string_pretty(value).expect("serialises") + "\n";
    let path = golden_path(name);
    if updating() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &actual).unwrap();
        eprintln!("contract golden written: {}", path.display());
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| {
            panic!(
                "contract golden {} is missing ({e}).\nGenerate it with:\n  {REGEN}",
                path.display()
            )
        })
        .replace("\r\n", "\n");
    if expected != actual {
        panic!(
            "CONTRACT DRIFT: what Rust sends no longer matches the golden {name}.\n\
             The TypeScript side is tested against that golden, so this change reaches the UI.\n\
             If it is intended: regenerate, read the diff, and update the TS contract tests\n\
             (src/test/contract/) in the same change:\n  {REGEN}\n\n\
             --- golden (expected)\n+++ produced by Rust (actual)\n{}",
            line_diff(&expected, &actual)
        );
    }
}

/// A small LCS line diff with two lines of context — enough to name the drifted field.
fn line_diff(expected: &str, actual: &str) -> String {
    let a: Vec<&str> = expected.lines().collect();
    let b: Vec<&str> = actual.lines().collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    // (tag, line number — in the golden for ' '/'-', in the produced output for '+', text)
    let mut ops: Vec<(char, usize, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            ops.push((' ', i + 1, a[i]));
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1]) {
            ops.push(('-', i + 1, a[i]));
            i += 1;
        } else {
            ops.push(('+', j + 1, b[j]));
            j += 1;
        }
    }
    let changed: Vec<usize> = (0..ops.len()).filter(|&k| ops[k].0 != ' ').collect();
    let mut out = String::new();
    let mut last_printed: Option<usize> = None;
    for (shown, &k) in changed.iter().enumerate() {
        if shown >= 40 {
            out.push_str(&format!(
                "… and {} more changed lines\n",
                changed.len() - 40
            ));
            break;
        }
        let from = k.saturating_sub(2);
        let to = (k + 2).min(ops.len() - 1);
        for (idx, op) in ops.iter().enumerate().take(to + 1).skip(from) {
            if last_printed.is_some_and(|l| idx <= l) {
                continue;
            }
            if last_printed.is_some_and(|l| idx > l + 1) {
                out.push_str("  …\n");
            }
            out.push_str(&format!("{}{:>5} {}\n", op.0, op.1, op.2));
            last_printed = Some(idx);
        }
    }
    out
}

/// `line_diff` is what a failing run shows — it must name the drifted line.
#[test]
fn the_drift_message_names_the_changed_line() {
    let d = line_diff(
        "{\n  \"a\": 1,\n  \"b\": 2\n}",
        "{\n  \"a\": 1,\n  \"bee\": 2\n}",
    );
    assert!(d.contains("-    3   \"b\": 2"), "{d}");
    assert!(d.contains("+    3   \"bee\": 2"), "{d}");
    assert!(d.contains("     2   \"a\": 1,"), "context line: {d}");
    assert!(d.find("-    3").unwrap() < d.find("+    3").unwrap(), "{d}");
}

// ── Network: a real proxy, real clients, loopback upstreams ─────────────────

type UBody = UnsyncBoxBody<Bytes, Infallible>;

/// 2026-09-24T12:00:00Z — every normalised timestamp counts from here.
const T0: u64 = 1_790_251_200_000;
/// What the normalised ports read as.
const PORT_PLAIN: u16 = 8080;
const PORT_TLS: u16 = 8443;
const PORT_WS: u16 = 8081;
const PORT_DEAD: u16 = 9;
const PORT_PROXY: u16 = 51234;
/// A saved proxy port that was taken at startup (`portChanged.from`).
const PORT_PROXY_SAVED: u16 = 8877;
const FIXED_DATE: &str = "Thu, 24 Sep 2026 12:00:00 GMT";

/// The two terminals the flows are attributed to (proxy userinfo `t-<id>:x@`).
const TERM_AGENT: &str = "term-agent";
const TERM_SHELL: &str = "term-shell";

#[derive(Default)]
struct Recorder(Mutex<Vec<Vec<FlowSummary>>>);
impl FlowSink for Recorder {
    fn emit(&self, flows: &[FlowSummary]) {
        self.0.lock().unwrap().push(flows.to_vec());
    }
}

impl Recorder {
    fn all(&self) -> Vec<FlowSummary> {
        self.0.lock().unwrap().iter().flatten().cloned().collect()
    }
}

fn proxy(
    anchors: Vec<rustls::pki_types::CertificateDer<'static>>,
    dir: Option<PathBuf>,
    user_env: Vec<(String, String)>,
) -> (Netcap, Arc<Recorder>) {
    let rec = Arc::new(Recorder::default());
    let nc = Netcap::start(
        NetcapConfig {
            dir,
            trust_anchors: Some(anchors),
            user_env,
            preferred_port: None,
        },
        rec.clone(),
    )
    .expect("proxy starts");
    (nc, rec)
}

async fn wait_flow(nc: &Netcap, what: &str, pred: impl Fn(&FlowSummary) -> bool) -> FlowSummary {
    for _ in 0..1000 {
        if let Some(f) = nc.snapshot().into_iter().find(|f| pred(f)) {
            return f;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no flow matching {what}; flows: {:#?}", nc.snapshot());
}

async fn wait_emitted(
    rec: &Recorder,
    what: &str,
    pred: impl Fn(&FlowSummary) -> bool,
) -> FlowSummary {
    for _ in 0..1000 {
        if let Some(f) = rec.all().into_iter().find(|f| pred(f)) {
            return f;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("nothing emitted matching {what}; emitted: {:#?}", rec.all());
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

const MESSAGES_JSON: &str = r#"{"id":"msg_01","type":"message","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"}"#;
const BINARY: [u8; 6] = [0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f];

/// One upstream for every scenario, switched on the path.
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
            .body(full(gzip(br#"{"ok":true,"items":[1,2]}"#))),
        "/binary" => Response::builder()
            .status(200)
            .header("content-type", "application/octet-stream")
            .body(full(BINARY.to_vec())),
        "/upload" => Response::builder()
            .status(413)
            .header("content-type", "text/plain; charset=utf-8")
            .body(full(format!("payload too large ({} bytes)", body.len()))),
        "/v1/messages" => Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .body(full(MESSAGES_JSON)),
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
            .body(full(format!("hello {path}"))),
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

async fn spawn_tls_upstream(ca: &Ca) -> u16 {
    let leaf = ca.leaf_for("localhost").unwrap();
    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(leaf.chain.clone(), leaf.key())
        .unwrap();
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
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
                if tls.get_ref().1.alpn_protocol() == Some(b"h2") {
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

async fn spawn_ws_echo() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (s, _) = l.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        while let Some(Ok(m)) = ws.next().await {
            if m.is_text() || m.is_binary() {
                ws.send(m).await.unwrap();
            }
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

/// What the proxy resolves THIS test process to (the test binary's name).
fn me() -> String {
    client_name(&std::env::current_exe().unwrap().to_string_lossy())
}

fn fixed_client(name: &str, pid: u32, path: &str) -> Option<ClientProcess> {
    Some(ClientProcess {
        pid,
        name: name.into(),
        path: Some(path.into()),
    })
}

/// The representative client a scenario's row carries in the goldens (the real one — this
/// test process — is asserted before it is replaced). `null` shows the unresolved shape.
fn scenario_client(scenario: &str) -> Option<ClientProcess> {
    let claude = || {
        fixed_client(
            "claude",
            4242,
            "/Users/dev/.local/share/claude/versions/2.1.0",
        )
    };
    match scenario {
        "upstream-refused" => None,
        "http-truncated-request" | "tls-rejected" => fixed_client("curl", 5151, "/usr/bin/curl"),
        "tunnel" | "tunnel-not-decrypted" => {
            fixed_client("gazelle", 6161, "/Users/dev/gazelle/target/debug/gazelle")
        }
        "ide-api-client" => fixed_client(
            "Agent Studio",
            3131,
            "/Applications/Agent Studio.app/Contents/MacOS/agent-studio-scaffold",
        ),
        _ => claude(),
    }
}

/// Volatile values → fixed ones. Applied to the typed struct, so serde's field order stands.
struct Norm {
    ports: Vec<(u16, u16)>,
}

impl Norm {
    fn port(&self, p: u16) -> u16 {
        self.ports
            .iter()
            .find(|(real, _)| *real == p)
            .map_or(p, |(_, fixed)| *fixed)
    }

    fn text(&self, s: &str) -> String {
        let mut out = s.to_string();
        for (real, fixed) in &self.ports {
            out = out.replace(&format!(":{real}"), &format!(":{fixed}"));
        }
        // "Connection refused (os error 61)" on macOS, 111 on Linux.
        if let Some(at) = out.find("(os error ") {
            if let Some(end) = out[at..].find(')') {
                out.replace_range(at..at + end + 1, "(os error N)");
            }
        }
        out
    }

    /// Assert the real client is this process, then pin the scenario's representative one.
    fn client(&self, s: &mut FlowSummary, scenario: &str) {
        let real = s
            .client
            .as_ref()
            .unwrap_or_else(|| panic!("{scenario}: client unresolved: {s:?}"));
        assert_eq!(real.pid, std::process::id(), "{scenario}");
        // The API client's rows name the IDE itself; proxied rows name the
        // resolved executable — this test binary.
        let want = if scenario == "ide-api-client" {
            IDE_CLIENT_NAME.to_string()
        } else {
            me()
        };
        assert_eq!(real.name, want, "{scenario}");
        let fixed = scenario_client(scenario);
        let fixed_name = fixed.as_ref().map_or("the client", |c| c.name.as_str());
        s.note = s.note.as_deref().map(|n| n.replace(&me(), fixed_name));
        s.client = fixed;
    }

    fn summary(&self, s: &mut FlowSummary, duration_ms: u64) {
        s.started_ms = T0 + (s.id - 1) * 1000;
        s.port = self.port(s.port);
        if s.duration_ms.is_some() {
            s.duration_ms = Some(duration_ms);
        }
        s.error = s.error.as_deref().map(|e| self.text(e));
        if s.proto == FlowProto::Tunnel && s.state == FlowState::Done {
            // A TLS handshake's size varies run to run (ECDSA signatures are DER, variable
            // length). The real counts are asserted > 0 before this.
            s.req_bytes = 2_048;
            s.res_bytes = 6_144;
        }
    }

    fn headers(&self, h: &mut [(String, String)]) {
        for (name, value) in h.iter_mut() {
            if name == "date" {
                *value = FIXED_DATE.to_string();
            } else if name == "host" {
                *value = self.text(value);
            }
        }
    }

    fn detail(&self, d: &mut FlowDetail, duration_ms: u64) {
        self.summary(&mut d.summary, duration_ms);
        self.headers(&mut d.request_headers);
        self.headers(&mut d.response_headers);
        self.headers(&mut d.response_trailers);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn netcap_wire_values_match_the_goldens() {
    let upstream_ca = Ca::generate().unwrap();
    let plain = spawn_plain_upstream().await;
    let tls = spawn_tls_upstream(&upstream_ca).await;
    let ws_up = spawn_ws_echo().await;
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (nc, rec) = proxy(vec![upstream_ca.ca_der().clone()], None, Vec::new());
    let norm = Norm {
        ports: vec![
            (plain, PORT_PLAIN),
            (tls, PORT_TLS),
            (ws_up, PORT_WS),
            (dead, PORT_DEAD),
            (nc.port(), PORT_PROXY),
        ],
    };
    let mut status = BTreeMap::new();
    let mut st = nc.status();
    st.port = st.port.map(|p| norm.port(p));
    status.insert("default", st);

    // Each scenario waits for its flow to finish before the next starts, so the store's ids
    // are 1, 2, 3… in this order. `(scenario, id, normalised duration)`.
    let mut ids: Vec<(&str, u64, u64)> = Vec::new();

    // 1 — plain HTTP, gzip JSON response (decoded in the detail), two credential headers (verbatim).
    let client = reqwest_via(&nc, TERM_AGENT, None);
    let res = client
        .post(format!("http://127.0.0.1:{plain}/api/v1/items?x=1"))
        .header("authorization", "Bearer sk-live-SECRET")
        .header("content-type", "text/plain")
        .body("ping")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    res.text().await.unwrap();
    let f = wait_flow(&nc, "http done", |f| f.state == FlowState::Done).await;
    assert_eq!((f.id, f.proto), (1, FlowProto::Http));
    ids.push(("http-json-gzip-credentials", f.id, 120));
    // The emit path's first sight of it: the pending row the UI receives first.
    let pending = wait_emitted(&rec, "http pending", |e| {
        e.id == 1 && e.state == FlowState::Pending
    })
    .await;

    // 2 — binary bodies both ways → base64, never text.
    let res = client
        .post(format!("http://127.0.0.1:{plain}/binary"))
        .body(BINARY.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(res.bytes().await.unwrap().as_ref(), &BINARY);
    let f = wait_flow(&nc, "binary done", |f| {
        f.id == 2 && f.state == FlowState::Done
    })
    .await;
    ids.push(("http-binary-base64", f.id, 45));

    // 3 — a request body past the 1 MiB capture cap → truncated; 413 back.
    let big = vec![b'a'; BODY_CAP + 10];
    let shell = reqwest_via(&nc, TERM_SHELL, None);
    let res = shell
        .post(format!("http://127.0.0.1:{plain}/upload"))
        .header("content-type", "text/plain")
        .body(big)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 413);
    res.text().await.unwrap();
    let f = wait_flow(&nc, "upload done", |f| {
        f.id == 3 && f.state == FlowState::Done
    })
    .await;
    ids.push(("http-truncated-request", f.id, 980));

    // 4 — a WebSocket upgrade with live message counts.
    let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    let handshake = format!(
        "GET http://127.0.0.1:{ws_up}/chat HTTP/1.1\r\nHost: 127.0.0.1:{ws_up}\r\n\
         Upgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
         Proxy-Authorization: Basic {}\r\n\r\n",
        basic(TERM_AGENT)
    );
    s.write_all(handshake.as_bytes()).await.unwrap();
    assert!(read_head(&mut s).await.starts_with("HTTP/1.1 101"));
    let mut ws = tokio_tungstenite::WebSocketStream::from_raw_socket(s, Role::Client, None).await;
    for i in 0..3 {
        ws.send(Message::text(format!("m{i}"))).await.unwrap();
        ws.next().await.unwrap().unwrap();
    }
    let ws_live = wait_emitted(&rec, "live ws counts", |e| {
        e.id == 4 && e.ws_messages == Some(WsCounts { up: 3, down: 3 })
    })
    .await;
    assert_eq!(ws_live.state, FlowState::Pending);
    ws.close(None).await.unwrap();
    drop(ws);
    let f = wait_flow(&nc, "ws done", |f| f.id == 4 && f.state == FlowState::Done).await;
    assert_eq!(f.proto, FlowProto::Ws);
    ids.push(("ws-echo", f.id, 5_200));

    // 5 — HTTPS in the default (tunnel) mode: one tunnel flow, no path.
    let tunneled = reqwest_via(&nc, TERM_SHELL, Some(upstream_ca.ca_pem()));
    tunneled
        .get(format!("https://localhost:{tls}/secret-path"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    drop(tunneled);
    let f = wait_flow(&nc, "tunnel done", |f| {
        f.id == 5 && f.state == FlowState::Done
    })
    .await;
    assert_eq!(f.proto, FlowProto::Tunnel);
    assert!(f.req_bytes > 0 && f.res_bytes > 0, "{f:?}");
    ids.push(("tunnel", f.id, 1_500));

    // 6 — CONNECT to a dead port, no Proxy-Authorization → an unattributed error row.
    let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    s.write_all(format!("CONNECT 127.0.0.1:{dead} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
        .await
        .unwrap();
    assert!(read_head(&mut s).await.starts_with("HTTP/1.1 502"));
    let f = wait_flow(&nc, "refused", |f| f.id == 6 && f.state == FlowState::Error).await;
    ids.push(("upstream-refused", f.id, 3));

    // ── decrypt on ── (this test binary stands in for an allowlisted runtime for 7–9)
    nc.set(None, Some(true)).unwrap();
    nc.also_decrypt_for(&[me().as_str()]);
    let ours = nc.ca_pem().unwrap();

    // 7 — decrypted HTTPS: path, status, JSON bodies, an API key (verbatim).
    let client = reqwest_via(&nc, TERM_AGENT, Some(&ours));
    let res = client
        .post(format!("https://localhost:{tls}/v1/messages"))
        .header("x-api-key", "sk-ant-SECRET-KEY")
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(r#"{"model":"claude-x","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.text().await.unwrap();
    drop(client);
    let f = wait_flow(&nc, "https done", |f| {
        f.id == 7 && f.state == FlowState::Done
    })
    .await;
    assert_eq!(f.proto, FlowProto::Https);
    ids.push(("https-decrypted-json", f.id, 640));

    // 8 — gRPC over decrypted h2: trailers + grpcStatus.
    let mut tcp = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    tcp.write_all(
        format!(
            "CONNECT localhost:{tls} HTTP/1.1\r\nHost: localhost:{tls}\r\nProxy-Authorization: Basic {}\r\n\r\n",
            basic(TERM_AGENT)
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    assert!(read_head(&mut tcp).await.starts_with("HTTP/1.1 200"));
    let mut roots = rustls::RootCertStore::empty();
    for c in pem_certs(&ours) {
        roots.add(c).unwrap();
    }
    let mut cfg = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h2".to_vec()];
    let tls_stream = tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect("localhost".try_into().unwrap(), tcp)
        .await
        .unwrap();
    let (mut send, conn) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(tls_stream))
            .await
            .unwrap();
    tokio::spawn(conn);
    let req = Request::post(format!("https://localhost:{tls}/pkg.Greeter/SayHello"))
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .body(Full::new(Bytes::from_static(&[0, 0, 0, 0, 3, 10, 1, 120])))
        .unwrap();
    let res = send.send_request(req).await.unwrap();
    res.into_body().collect().await.unwrap();
    let f = wait_flow(&nc, "grpc done", |f| {
        f.id == 8 && f.state == FlowState::Done
    })
    .await;
    assert_eq!((f.proto, f.grpc_status), (FlowProto::Grpc, Some(3)));
    ids.push(("grpc-trailers", f.id, 88));

    // 9 — a client that rejects our leaf: the explained error row, then passthrough.
    let pinned = reqwest_via(&nc, TERM_SHELL, Some(upstream_ca.ca_pem()));
    assert!(pinned
        .get(format!("https://localhost:{tls}/pinned"))
        .send()
        .await
        .is_err());
    let f = wait_flow(&nc, "tls rejected", |f| {
        f.id == 9 && f.state == FlowState::Error
    })
    .await;
    ids.push(("tls-rejected", f.id, 12));

    // 10 — decrypt on, a client NOT on the allowlist (never break a client): tunnelled, it
    // works, and the row says why — a note, not an error.
    nc.also_decrypt_for(&[]);
    let gazelle = reqwest_via(&nc, TERM_SHELL, Some(upstream_ca.ca_pem()));
    let body = gazelle
        .get(format!("https://localhost:{tls}/health"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "hello /health");
    drop(gazelle);
    let f = wait_flow(&nc, "not decrypted", |f| {
        f.id == 10 && f.state == FlowState::Done
    })
    .await;
    assert_eq!((f.proto, f.error.as_deref()), (FlowProto::Tunnel, None));
    assert!(f.note.as_deref().unwrap().starts_with("not decrypted: "));
    assert!(f.req_bytes > 0 && f.res_bytes > 0, "{f:?}");
    ids.push(("tunnel-not-decrypted", f.id, 1_100));

    // 11 — the IDE's own API client: the real `http_send` path,
    // recorded straight into the store (no proxy): terminalId "ide-api-client", client = the IDE.
    let resp = agent_studio_scaffold_lib::http::send_via(
        HttpRequest {
            method: "POST".into(),
            url: format!("http://127.0.0.1:{plain}/v1/messages"),
            headers: vec![
                HttpHeader {
                    name: "x-api-key".into(),
                    value: "sk-ant-SECRET-KEY".into(),
                },
                HttpHeader {
                    name: "content-type".into(),
                    value: "application/json".into(),
                },
            ],
            body: Some(r#"{"model":"claude-x","max_tokens":16}"#.into()),
        },
        &Tap::of(&nc),
    )
    .await
    .unwrap();
    assert_eq!(resp.status, 200);
    let f = wait_flow(&nc, "api client done", |f| {
        f.id == 11 && f.state == FlowState::Done
    })
    .await;
    assert_eq!(
        (f.proto, f.terminal_id.as_deref()),
        (FlowProto::Http, Some(IDE_TERMINAL_ID))
    );
    ids.push(("ide-api-client", f.id, 310));

    // ── collect and normalise ──
    let mut flows: BTreeMap<&str, FlowDetail> = BTreeMap::new();
    for (name, id, dur) in &ids {
        let mut d = nc.flow(*id).unwrap();
        if let Some(b) = d.request_body.as_mut().filter(|b| b.truncated) {
            let text = b.text.as_mut().expect("the capped prefix is still text");
            assert_eq!(
                text.len(),
                BODY_CAP,
                "the capture keeps exactly the first MiB"
            );
            text.truncate(32);
        }
        norm.detail(&mut d, *dur);
        if *name == "upstream-refused" {
            // Unattributed (no Proxy-Authorization) but still resolved to its process.
            assert_eq!(d.summary.terminal_id, None);
        }
        norm.client(&mut d.summary, name);
        flows.insert(name, d);
    }
    let dur_of = |id: u64| ids.iter().find(|(_, i, _)| *i == id).unwrap().2;
    let mut summaries: BTreeMap<&str, FlowSummary> = BTreeMap::new();
    for (name, mut s) in [("http-pending", pending), ("ws-live", ws_live)] {
        let d = dur_of(s.id);
        norm.summary(&mut s, d);
        norm.client(&mut s, name);
        summaries.insert(name, s);
    }

    let mut st = nc.status();
    st.port = st.port.map(|p| norm.port(p));
    assert_eq!(st.passthrough_hosts, ["localhost"]);
    status.insert("decrypt-passthrough", st);

    // A proxy whose user already set a proxy variable, with a real CA dir.
    let dir = std::env::temp_dir().join(format!("netcap-golden-{}", ulid::Ulid::new()));
    let (skipped, _) = proxy(
        Vec::new(),
        Some(dir.clone()),
        vec![("HTTPS_PROXY".into(), "http://corp-proxy:3128".into())],
    );
    let mut st = skipped.status();
    st.port = Some(PORT_PROXY);
    let ca_path = st.ca_path.take().expect("a CA dir gives a caPath");
    assert!(ca_path.starts_with(&dir.to_string_lossy().into_owned()));
    st.ca_path = Some("/cfg/netcap/ca.pem".into());
    status.insert("skipped-with-ca", st);
    let _ = std::fs::remove_dir_all(&dir);

    // The saved port was taken at startup (the proxy moved), and the user has
    // opted Postman in to decryption.
    let dir = std::env::temp_dir().join(format!("netcap-golden-moved-{}", ulid::Ulid::new()));
    let squatter = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let taken = squatter.local_addr().unwrap().port();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("prefs.json"),
        format!(r#"{{"enabled":true,"decrypt":true,"port":{taken}}}"#),
    )
    .unwrap();
    let (moved, _) = proxy(Vec::new(), Some(dir.clone()), Vec::new());
    let mut st = moved.set_app_decrypt("Postman", true).unwrap();
    let change = st.port_changed.expect("the saved port was taken");
    assert_eq!((change.from, change.to), (taken, moved.port()));
    st.port = Some(PORT_PROXY);
    st.port_changed = Some(PortChange {
        from: PORT_PROXY_SAVED,
        to: PORT_PROXY,
    });
    assert!(st.ca_path.take().is_some());
    st.ca_path = Some("/cfg/netcap/ca.pem".into());
    status.insert("port-changed-app-decrypt", st);
    drop(squatter);
    let _ = std::fs::remove_dir_all(&dir);

    // The real command with no proxy started in this process: the "not running" answer.
    let stopped: NetcapStatus = agent_studio_scaffold_lib::netcap::netcap_status();
    assert!(!stopped.running);
    status.insert("stopped", stopped);

    // Bypass rows: the REAL detector → `bypass_input` → `Netcap::record_bypass`, on a separate
    // proxy (with a config dir, so the curl shim exists) so the counts above are untouched.
    let dir = std::env::temp_dir().join(format!("netcap-golden-bypass-{}", ulid::Ulid::new()));
    let (bp, _) = proxy(Vec::new(), Some(dir.clone()), Vec::new());
    assert!(bp.shim_dir().is_some(), "a config dir gets the curl shim");
    for (tool_use_id, ts, command) in [
        (
            "toolu_01GazelleHealth",
            T0 + 60_000,
            "curl -s --noproxy '*' http://127.0.0.1:3000/api/v1/health | head -c 300",
        ),
        (
            "toolu_02GazelleProbe",
            T0 + 120_000,
            "cd /Users/dev/gazelle && NO_PROXY='*' python3 scripts/probe.py --port 3000",
        ),
    ] {
        let detected =
            agent_studio_scaffold_lib::logstream::bypass::detect(command).expect("a proxy bypass");
        bp.record_bypass(agent_studio_scaffold_lib::supervisor::bypass_input(
            Some("term-gazelle".into()),
            agent_studio_scaffold_lib::agent::tools::BypassEvent {
                agent_id: "agent-gazelle".into(),
                tool_use_id: tool_use_id.into(),
                ts_ms: Some(ts as i64),
                command: command.into(),
                detected,
            },
        ));
    }
    let rows = bp.snapshot();
    assert_eq!(rows.len(), 2);
    summaries.insert("bypass-curl-neutralized", rows[0].clone());
    summaries.insert("bypass-python", rows[1].clone());
    let _ = std::fs::remove_dir_all(&dir);

    check_golden("netcap-flows.json", &flows);
    check_golden("netcap-summaries.json", &summaries);
    check_golden("netcap-status.json", &status);
}

// ── The level heuristic: one rule table, two languages ─────────────────────

/// One case of `level-cases.json`. The TS classifier (block-output rows) must return
/// `level` for `line` on every case.
#[derive(Serialize)]
struct LevelCase {
    line: &'static str,
    level: LogLevel,
}

/// `classify_level` over a hand-written table, checked against Rust FIRST, written to
/// `level-cases.json` for the TS mirror, so drift on either side is named.
#[test]
fn level_cases_match_the_golden() {
    use LogLevel::{Debug, Error, Info, Warn};
    let table: &[(&str, LogLevel)] = &[
        // os_log compact — the type column is the process's own declaration and wins.
        (
            "2026-01-01 12:00:00.250 E  Demo[1234:5678] [com.app:net] request failed",
            Error,
        ),
        ("2026-01-01 12:00:00.250 Fa Demo[1:2] fault", Error),
        ("2026-01-01 12:00:00.250 F  Demo[1:2] fault", Error),
        (
            "2026-01-01 12:00:00.250 Df Demo[1234:5678] retrying after error",
            Debug,
        ),
        ("2026-01-01 12:00:00.250 Db Demo[1:2] noise", Debug),
        ("2026-01-01 12:00:00.250 D  Demo[1:2] noise", Debug),
        ("2026-01-01 12:00:00.250 I  Demo[1:2] all good", Info),
        ("2026-01-01 12:00:00.250 A  Demo[1:2] activity", Info),
        (
            "2026-01-01 12:00:00.250-0700 E  Demo[1:2] tz offset form",
            Error,
        ),
        ("2026-01-01 12:00:00 E no millis so not compact", Info),
        // tracing / env_logger / Python logging level columns — the column wins.
        (
            "2026-01-01T12:00:05.152Z  INFO gazelle: listening on 0.0.0.0:8080",
            Info,
        ),
        (
            "2026-01-01T12:00:05.152Z  INFO gazelle::retry: recovered from error after 2 attempts",
            Info,
        ),
        (
            "2026-01-01T12:00:05.152345Z  WARN gazelle::db: pool at 90%",
            Warn,
        ),
        (
            "2026-01-01T12:00:05.152Z ERROR gazelle: upstream closed the connection",
            Error,
        ),
        (
            "2026-01-01T12:00:05.152Z DEBUG hyper::proto::h1: flushed 212 bytes",
            Debug,
        ),
        (
            "2026-01-01T12:00:05.152Z TRACE gazelle: tick, no error",
            Debug,
        ),
        ("[2026-01-01 12:00:05 WARN foo] disk slow", Warn),
        (
            "[2026-01-01T12:00:05Z INFO  gazelle] fatal flag is off",
            Info,
        ),
        (
            "[2026-01-01T12:00:05Z ERROR gazelle::api] 500 on /health",
            Error,
        ),
        ("2026-01-01 12:00:05,152 WARNING root: low memory", Warn),
        (
            "2026-01-01 12:00:05,152 CRITICAL root: out of memory",
            Error,
        ),
        ("2026-01-01T12:00:05-05:00 INFO svc: tick 1", Info),
        // A leading level token (no timer) — including the block-output case: a WARN row
        // whose message says "error" is a warning.
        ("WARN gazelle::health: upstream error rate 2%", Warn),
        ("INFO gazelle: started, error budget 0", Info),
        ("ERROR: relation \"users\" does not exist", Error),
        ("[DEBUG] connecting", Debug),
        ("INF server started port=8080", Info),
        ("WRN retrying", Warn),
        ("DBG cache miss", Debug),
        ("NOTICE: table created", Info),
        ("  WARN indented still leads", Warn),
        // logfmt / JSON keyed levels, any case.
        (
            "time=2026-01-01T12:00:05Z level=error msg=\"db down\"",
            Error,
        ),
        ("ts=1 level=info msg=\"error count reset\"", Info),
        ("level=WARN msg=x", Warn),
        (
            r#"{"level":"debug","msg":"panic handler installed"}"#,
            Debug,
        ),
        (r#"{"ts":1,"level": "error","msg":"boom"}"#, Error),
        ("releveled=error", Error),
        // Keywords (no declared level) — error beats warn beats debug.
        ("error[E0308]: mismatched types", Error),
        ("thread 'main' panicked at src/lib.rs:1:1", Error),
        ("Traceback (most recent call last):", Error),
        ("test result: FAILED. 1 passed; 2 failed", Error),
        ("✗ 3 tests failed", Error),
        ("warning: unused variable `x`", Warn),
        ("npm WARN deprecated left-pad@1.0.0", Warn),
        ("the build has a warning and an error", Error),
        ("TRACE hyper::proto", Debug),
        ("the INFO panel shows an error", Error),
        // Word boundaries and non-columns.
        ("DeprecationWarning is not a whole word", Info),
        ("errorless run, terrors none", Info),
        ("forewarned", Info),
        ("INFORMATION about the build", Info),
        ("ERRORS: 0", Info),
        ("Compiling agentstudio v0.1.0", Info),
        ("", Info),
        // Unicode around the words (JS `\b` is ASCII-only too — these pin that both agree).
        ("⚠ warning: disk almost full", Warn),
        ("❌ error: build failed", Error),
        ("échec: error — réessayer", Error),
        ("ошибка error ошибка", Error),
        ("naïve warnings only", Info),
        ("日本語のログ 情報", Info),
        ("✓ 12 passed", Info),
        // Rust's `regex` is Unicode-aware (`\b`, `\s` incl. U+00A0, `\d` = Nd); JS's is ASCII,
        // so these pin the TS mirror to Rust's recorded answers.
        ("éerror in a word", Info),
        ("日本error", Info),
        ("エラー: error happened", Error),
        ("level=érror", Info),
        (
            "2026-01-01 12:00:00.250\u{a0}E  Demo[1:2] nbsp before the type column, fine",
            Error,
        ),
        (
            "2026-01-01 12:00:00.250\u{a0}Df Demo[1:2] nbsp, error in the message",
            Debug,
        ),
        (
            "٢٠٢٦-٠١-٠١ ١٢:٠٠:٠٠.٢٥٠ Df Demo[1:2] arabic-indic digits, error",
            Debug,
        ),
        (
            "٢٠٢٦-٠١-٠١T12:00:05Z WARN svc: arabic-indic date, error",
            Warn,
        ),
        ("\u{a0}WARN nbsp-led, error", Warn),
    ];
    let mut cases = Vec::new();
    for (line, want) in table {
        assert_eq!(
            agent_studio_scaffold_lib::logstream::classify_level(line),
            *want,
            "the Rust rule disagrees with the hand-written expectation for {line:?}"
        );
        cases.push(LevelCase { line, level: *want });
    }
    check_golden("level-cases.json", &cases);
}

// ── Agent Logs: the real supervisor, real PTYs, the real transcript parser ──

async fn wait_line(hub: &LogHub, what: &str, pred: impl Fn(&LogLine) -> bool) -> LogLine {
    let start = Instant::now();
    loop {
        if let Some(l) = hub.snapshot().into_iter().find(|l| pred(l)) {
            return l;
        }
        assert!(
            start.elapsed() < TIMEOUT,
            "timed out waiting for {what}; ring = {:#?}",
            hub.snapshot()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap().flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            std::fs::copy(&path, &target).unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn logstream_wire_values_match_the_golden() {
    let hub = LogHub::spawn(Arc::new(NullLogSink));
    let sup = spawn_supervisor_with_logs(
        Arc::new(NullSink),
        vec![Arc::new(StubAdapter::interactive())],
        None,
        Some(hub.clone()),
    );
    // A cwd whose basename is fixed, so the source label is `sh · proj` on every machine.
    let root = std::env::temp_dir().join(format!("golden-logs-{}", ulid::Ulid::new()));
    let cwd_path = root.join("proj");
    std::fs::create_dir_all(&cwd_path).unwrap();
    let cwd = cwd_path.to_string_lossy().into_owned();
    let shell_id = format!("golden-shell-{}", ulid::Ulid::new());
    let agent_id = format!("golden-agent-{}", ulid::Ulid::new());

    // Terminal A: a plain shell's output (ANSI, a CR progress bar, each level) and exit.
    let (_out, channel) = ChannelSink::new();
    let (program, args) = sh("printf 'hello-%s\\n' 42; \
         printf '\\033[31merror: red\\033[0m\\n'; \
         printf 'warning: flag --x is deprecated\\n'; \
         printf 'progress 10%%\\rprogress 100%%\\n'; \
         printf 'DEBUG cache hit\\n'; exit 3");
    sup.open_terminal(
        OpenSpec {
            terminal_id: shell_id.clone(),
            program: Some(program),
            args,
            cwd: cwd.clone(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .unwrap();
    wait_line(&hub, "exit line", |l| {
        l.terminal_id.as_deref() == Some(shell_id.as_str()) && l.text.starts_with("terminal exited")
    })
    .await;
    wait_line(&hub, "last output line", |l| l.text == "DEBUG cache hit").await;

    // Terminal B: a shell a session binds to (agent started / ended), then closed.
    let (_out_b, channel_b) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: agent_id.clone(),
            program: Some(program),
            args,
            cwd: cwd.clone(),
            rows: 24,
            cols: 80,
        },
        channel_b,
    )
    .await
    .unwrap();
    sup.deliver_hook(
        agent_id.clone(),
        hook_payload("SessionStart", "sess-golden", None),
    );
    wait_line(&hub, "agent started", |l| {
        l.text.starts_with("agent started")
    })
    .await;
    sup.deliver_hook(
        agent_id.clone(),
        hook_payload("SessionEnd", "sess-golden", None),
    );
    wait_line(&hub, "session ended", |l| l.text == "agent session ended").await;
    sup.close(agent_id.clone()).await.unwrap();
    wait_line(&hub, "closed", |l| l.text == "terminal closed").await;

    // Tool lines: the real adapter + `TranscriptToolTail`, mapped exactly as the supervisor's
    // private `on_tool_events` does; the live path is proven by `logstream_tailer_live.rs`.
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/logstream/tool-calls");
    let session = root.join("sess");
    std::fs::create_dir_all(&session).unwrap();
    std::fs::copy(fixture.join("session.jsonl"), root.join("sess.jsonl")).unwrap();
    copy_dir(&fixture.join("subagents"), &session.join("subagents"));
    let loc = TranscriptLocation {
        root_transcript: root.join("sess.jsonl"),
        subagents_dir: session.join("subagents"),
    };
    let adapter = ClaudeAdapter::new();
    let files = adapter.tool_transcripts(&loc, &agent_id);
    let events = TranscriptToolTail::new(0).poll(&files, |l| adapter.parse_tool_line(l));
    assert!(events.len() > 5, "{events:?}");
    let root_label = source_label("claude", &cwd);
    for ev in events {
        let source = if ev.agent_id == agent_id {
            root_label.clone()
        } else {
            ev.agent_id.clone()
        };
        hub.push(LineDraft {
            terminal_id: Some(agent_id.clone()),
            agent_id: Some(ev.agent_id),
            source,
            kind: if ev.is_result {
                LogKind::ToolResult
            } else {
                LogKind::Tool
            },
            level: if ev.is_error {
                LogLevel::Error
            } else {
                LogLevel::Info
            },
            text: ev.text,
            detail: ev.detail,
            ts_ms: ev.ts_ms,
            tool_use_id: Some(ev.tool_use_id),
        });
    }
    wait_line(&hub, "the last tool line", |l| {
        l.text == "Edit → The file has been updated"
    })
    .await;

    // Background-task lines via the real TaskTails and `poll_task_tails`, root terminal set as
    // `on_task_lines` does; the live path is proven by `logstream_tasks_live.rs`.
    let claude_root = root.join("claude-4242");
    let task_dir = claude_root.join("-work-gazelle/sess/tasks");
    std::fs::create_dir_all(&task_dir).unwrap();
    let tasks_fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/logstream/tasks");
    let task_path = task_dir.join("bgen1a2b3.output");
    std::fs::copy(tasks_fixture.join("gazelle.output"), &task_path).unwrap();
    let task_tx = root.join("tasks-sess.jsonl");
    let fill = |name: &str| {
        std::fs::read_to_string(tasks_fixture.join(name))
            .unwrap()
            .replace("@NOW@", "2026-01-01T12:00:04.000Z")
            .replace("@TASK_PATH@", &task_path.to_string_lossy())
    };
    std::fs::write(&task_tx, fill("start.jsonl")).unwrap();
    let task_files = vec![(agent_id.clone(), task_tx.clone())];
    let mut task_tool_tail = TranscriptToolTail::new(0);
    let mut tails = TaskTails::new(vec![claude_root.clone()], TaskSlots::new(MAX_TASK_TAILS));
    let derive = |id: &str| Some(task_dir.join(format!("{id}.output")));
    let on_root_terminal = |mut drafts: Vec<LineDraft>| {
        for d in &mut drafts {
            d.terminal_id = Some(agent_id.clone());
        }
        drafts
    };
    task_tool_tail.poll(&task_files, |l| adapter.parse_tool_line(l));
    let drafts = poll_task_tails(&mut tails, task_tool_tail.take_task_events(), derive);
    hub.push_batch(on_root_terminal(drafts));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&task_path)
        .unwrap()
        .write_all(b"2026-01-01T12:00:06.001Z ERROR gazelle::api: upstream closed the connection\n")
        .unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&task_tx)
        .unwrap()
        .write_all(fill("stop.jsonl").as_bytes())
        .unwrap();
    task_tool_tail.poll(&task_files, |l| adapter.parse_tool_line(l));
    let drafts = poll_task_tails(&mut tails, task_tool_tail.take_task_events(), derive);
    hub.push_batch(on_root_terminal(drafts));
    wait_line(&hub, "the task stopped line", |l| {
        l.text == "background task stopped · gazelle (bgen1a2b3) — stopped by the agent"
    })
    .await;

    // ── order canonically, normalise, compare ──
    // Terminal A's output lines race its exit line through the PTY; the golden pins the
    // order a reader sees in a settled log: opened, output (splitter order), exited.
    let snap = hub.snapshot();
    let a: Vec<&LogLine> = snap
        .iter()
        .filter(|l| l.terminal_id.as_deref() == Some(shell_id.as_str()))
        .collect();
    let rank = |l: &LogLine| match (l.kind, l.text.as_str()) {
        (LogKind::System, t) if t.starts_with("terminal opened") => 0,
        (LogKind::System, _) => 2,
        _ => 1,
    };
    let mut a = a;
    a.sort_by_key(|l| (rank(l), l.id));
    // Terminal B: lifecycle only (an interactive shell's prompt differs between machines).
    let is_task = |l: &LogLine| {
        l.kind == LogKind::Task || (l.kind == LogKind::System && l.source.ends_with(" · bg"))
    };
    let b = snap.iter().filter(|l| {
        l.terminal_id.as_deref() == Some(agent_id.as_str())
            && matches!(l.kind, LogKind::System)
            && !is_task(l)
    });
    let tools = snap
        .iter()
        .filter(|l| matches!(l.kind, LogKind::Tool | LogKind::ToolResult));
    let tasks = snap.iter().filter(|l| is_task(l));
    let claude_root_str = claude_root.to_string_lossy().into_owned();

    let fix = |s: &str| {
        s.replace(&cwd, "/work/proj")
            .replace(&claude_root_str, "/private/tmp/claude-501")
            .replace(&shell_id, TERM_SHELL)
            .replace(&agent_id, TERM_AGENT)
    };
    let lines: Vec<LogLine> = a
        .into_iter()
        .chain(b)
        .chain(tools)
        .chain(tasks)
        .cloned()
        .enumerate()
        .map(|(i, mut l)| {
            l.id = i as u64 + 1;
            if !matches!(l.kind, LogKind::Tool | LogKind::ToolResult) {
                // Tool lines keep the transcript's own (fixed) timestamps.
                l.ts_ms = T0 as i64 + i as i64 * 250;
            }
            l.terminal_id = l.terminal_id.as_deref().map(fix);
            l.agent_id = l.agent_id.as_deref().map(fix);
            l.source = fix(&l.source);
            l.text = fix(&l.text);
            l.detail = l.detail.as_deref().map(fix);
            l
        })
        .collect();
    let _ = std::fs::remove_dir_all(&root);
    check_golden("logstream-lines.json", &lines);
}
