//! Adversarial and property-style tests of the capture proxy (`src/netcap/`).
//!
//! `netcap_e2e.rs` proves the proxy works for well-behaved clients. This file is about the
//! other kind: garbage on the wire, requests that never end, absurd headers, malformed
//! targets, thousands of flows, hundreds at once — plus redaction and the body cap stated
//! as properties over random inputs (fixed seeds, `rand`; no `proptest` in this crate).
//!
//! The proxy runs inside the IDE process, so "a hostile client wedged it" is not a Network
//! tab problem, it is an IDE problem. Every adversarial case therefore asserts three
//! things: the proxy answered 4xx or hung up, it did so **within a bounded time** (a hang
//! is a failure, never a stuck suite — everything runs under `tokio::time::timeout`), and a
//! normal request right after it **still succeeds**.
//!
//! Hermetic: loopback only, every upstream is started here, no DNS lookup of
//! any name (targets are IP literals), no OS trust store. Contract numbers are restated as
//! literals.

use std::convert::Infallible;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::netcap::{
    FlowDetail, FlowSink, FlowState, FlowSummary, Netcap, NetcapConfig,
};
use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The contract: bodies "capped at 1 MiB per side", "ring of 5 000 flows".
const BODY_CAP: usize = 1024 * 1024;
const RING: usize = 5_000;
/// The proxy's header-read deadline (`proxy::HEADER_READ_TIMEOUT`), restated.
const HEADER_DEADLINE: Duration = Duration::from_secs(30);
/// How long an adversarial client may take to be refused. Generous for a debug build on a
/// loaded CI box, finite so a hang fails.
const REFUSE_WITHIN: Duration = Duration::from_secs(10);

type UBody = UnsyncBoxBody<Bytes, Infallible>;

struct NullSink;
impl FlowSink for NullSink {
    fn emit(&self, _: &[FlowSummary]) {}
}

fn proxy() -> Netcap {
    Netcap::start(
        NetcapConfig {
            dir: None,
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        },
        Arc::new(NullSink),
    )
    .expect("proxy starts")
}

/// Run a test body under a hard deadline: a hang is a red test, not a stuck suite.
async fn within<T>(limit: Duration, what: &str, f: impl Future<Output = T>) -> T {
    match tokio::time::timeout(limit, f).await {
        Ok(v) => v,
        Err(_) => panic!("{what}: still running after {limit:?} — the proxy hung"),
    }
}

fn full(b: impl Into<Bytes>) -> UBody {
    Full::new(b.into()).boxed_unsync()
}

/// The 5 MiB response body: `→` (3 bytes) repeated, so the 1 MiB cap (1 048 576 ≡ 1 mod 3)
/// lands inside a character, then two ASCII bytes to make exactly 5 MiB.
fn big_text() -> Vec<u8> {
    let total = 5 * 1024 * 1024;
    let mut v = "→".repeat(total / 3).into_bytes();
    v.resize(total, b'z');
    assert_eq!(v.len(), total);
    v
}

/// FNV-1a — enough to prove a 5 MiB upload arrived byte-exact without echoing it back.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    })
}

async fn upstream(req: Request<Incoming>) -> Result<Response<UBody>, Infallible> {
    let path = req.uri().path().to_string();
    let echoed: Vec<(String, Vec<u8>)> = req
        .headers()
        .iter()
        .filter(|(k, _)| k.as_str().starts_with("x-"))
        .map(|(k, v)| (k.as_str().to_string(), v.as_bytes().to_vec()))
        .collect();
    let body = req
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let mut b = Response::builder();
    let resp = if path == "/echo" {
        for (k, v) in echoed {
            b = b.header(k, v);
        }
        b.status(200).body(full("echo"))
    } else if path == "/big" {
        b.status(200)
            .header("content-type", "text/plain; charset=utf-8")
            .body(full(big_text()))
    } else if path == "/upload" {
        b.status(200)
            .body(full(format!("len={} fnv={:x}", body.len(), fnv(&body))))
    } else if let Some(code) = path.strip_prefix("/status/") {
        b.status(code.parse::<u16>().unwrap()).body(full("s"))
    } else {
        b.status(200)
            .header("content-type", "text/plain")
            .body(full(format!("hello {path}")))
    };
    Ok(resp.unwrap())
}

async fn serve_upstream_on(l: TcpListener) {
    loop {
        let Ok((s, _)) = l.accept().await else {
            continue;
        };
        tokio::spawn(async move {
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(s), service_fn(upstream))
                .await;
        });
    }
}

async fn spawn_upstream() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(serve_upstream_on(l));
    port
}

fn client(nc: &Netcap) -> reqwest::Client {
    agent_studio_scaffold_lib::tls::install_crypto_provider();
    reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://t-rob:x@127.0.0.1:{}", nc.port())).unwrap())
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap()
}

/// A normal request through the proxy right after an attack still works.
async fn assert_healthy(nc: &Netcap, up: u16, after: &str) {
    let path = format!("/healthy-after-{}", after.replace(' ', "-"));
    let res = within(
        Duration::from_secs(10),
        &format!("follow-up after {after}"),
        client(nc)
            .get(format!("http://127.0.0.1:{up}{path}"))
            .send(),
    )
    .await
    .unwrap_or_else(|e| panic!("after {after}: the next normal request failed: {e}"));
    assert_eq!(res.status(), 200, "after {after}");
    assert_eq!(
        res.text().await.unwrap(),
        format!("hello {path}"),
        "after {after}"
    );
}

async fn wait_for(nc: &Netcap, what: &str, pred: impl Fn(&FlowSummary) -> bool) -> FlowSummary {
    for _ in 0..1_000 {
        if let Some(f) = nc.snapshot().into_iter().find(|f| pred(f)) {
            return f;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no flow matching {what}; {} flows", nc.snapshot().len());
}

// The payloads are read through `Debug` in failure messages, which the dead-code lint
// does not count.
#[allow(dead_code)]
#[derive(Debug)]
enum Outcome {
    /// A response: status and the raw head.
    Answered(u16, String),
    /// The proxy closed without a response.
    Closed,
    /// The proxy reset the connection (normal when it hangs up mid-upload).
    Reset(String),
}

impl Outcome {
    /// 4xx or hung up — the acceptable ways to refuse.
    fn is_refusal(&self) -> bool {
        match self {
            Outcome::Answered(s, _) => (400..500).contains(s),
            Outcome::Closed | Outcome::Reset(_) => true,
        }
    }
}

fn parse_outcome(bytes: &[u8]) -> Outcome {
    if bytes.is_empty() {
        return Outcome::Closed;
    }
    let text = String::from_utf8_lossy(bytes).into_owned();
    let status = text
        .strip_prefix("HTTP/1.1 ")
        .or_else(|| text.strip_prefix("HTTP/1.0 "))
        .and_then(|r| r.get(..3))
        .and_then(|c| c.parse().ok())
        .unwrap_or_else(|| panic!("not an HTTP response: {text:?}"));
    let head = text.split("\r\n\r\n").next().unwrap_or("").to_string();
    Outcome::Answered(status, head)
}

/// Send `payload` on a fresh connection (in the background, ignoring write errors — the
/// proxy may hang up mid-write), optionally half-close, and read until a response head or
/// EOF. Panics if the proxy neither answers nor closes within `limit`.
async fn raw(nc: &Netcap, payload: Vec<u8>, half_close: bool, limit: Duration) -> Outcome {
    let s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
    let (mut r, mut w) = s.into_split();
    let writer = tokio::spawn(async move {
        for chunk in payload.chunks(64 * 1024) {
            if w.write_all(chunk).await.is_err() {
                return;
            }
        }
        if half_close {
            let _ = w.shutdown().await;
        } else {
            // Keep the write half open: the proxy must be the one to end this.
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
    let read = async {
        let mut got = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf).await {
                Ok(0) => return parse_outcome(&got),
                Ok(n) => {
                    got.extend_from_slice(&buf[..n]);
                    // A keep-alive refusal (CONNECT's 400/502) leaves the connection open:
                    // a complete head is the answer.
                    if got.windows(4).any(|w| w == b"\r\n\r\n") {
                        return parse_outcome(&got);
                    }
                }
                Err(e) if got.is_empty() => return Outcome::Reset(e.to_string()),
                Err(_) => return parse_outcome(&got),
            }
        }
    };
    let out = match tokio::time::timeout(limit, read).await {
        Ok(o) => o,
        Err(_) => panic!("the proxy neither answered nor closed within {limit:?}"),
    };
    writer.abort();
    out
}

// ---------------------------------------------------------------------------------------
// Hostile clients
// ---------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn garbage_truncated_and_oversized_requests_are_refused_and_the_proxy_stays_up() {
    within(Duration::from_secs(120), "hostile clients", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let mut rng = StdRng::seed_from_u64(0x6a7b);

        let garbage: Vec<u8> = (0..64 * 1024).map(|_| rng.random::<u8>()).collect();
        let mut lines = garbage.clone();
        for i in (0..lines.len()).step_by(97) {
            lines[i] = b'\n';
        }
        // A TLS ClientHello sent to the plain proxy port (a client that thinks the proxy
        // itself speaks HTTPS).
        let tls_hello = vec![
            0x16, 0x03, 0x01, 0x00, 0xa5, 0x01, 0x00, 0x00, 0xa1, 0x03, 0x03,
        ];
        let huge_value = format!(
            "GET http://127.0.0.1:{up}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: {}\r\n\r\n",
            "v".repeat(1024 * 1024 + 7)
        );
        let mut many = format!("GET http://127.0.0.1:{up}/x HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        for i in 0..10_000 {
            many.push_str(&format!("X-H{i}: {i}\r\n"));
        }
        many.push_str("\r\n");

        let cases: Vec<(&str, Vec<u8>, bool)> = vec![
            ("random bytes", garbage, true),
            ("random bytes with newlines", lines, false),
            ("tls hello", tls_hello, false),
            (
                "request line cut short, then EOF",
                format!("GET http://127.0.0.1:{up}/").into_bytes(),
                true,
            ),
            (
                "head cut short, then EOF",
                format!("GET http://127.0.0.1:{up}/ HTTP/1.1\r\nHost: 1").into_bytes(),
                true,
            ),
            (
                "binary in the request line",
                b"G\x00T http://127.0.0.1:1/ HTTP/1.1\r\n\r\n".to_vec(),
                false,
            ),
            ("a 1 MiB header", huge_value.into_bytes(), false),
            ("10 000 headers", many.into_bytes(), false),
            // Smuggling-shaped framing: two different lengths.
            (
                "conflicting content-lengths",
                format!(
                    "POST http://127.0.0.1:{up}/x HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\n\
                 Content-Length: 9\r\n\r\nabc"
                )
                .into_bytes(),
                false,
            ),
        ];
        for (name, payload, half_close) in cases {
            let t0 = Instant::now();
            let out = raw(&nc, payload, half_close, REFUSE_WITHIN).await;
            assert!(
                out.is_refusal(),
                "{name}: expected 4xx or a hang-up, got {out:?}"
            );
            eprintln!("{name}: {out:?} in {:?}", t0.elapsed());
            assert_healthy(&nc, up, name).await;
        }
        let flows = nc.snapshot();
        assert!(
            flows.iter().all(|f| f.path.starts_with("/healthy-after-")),
            "a refused request is not a flow: {flows:#?}"
        );
    })
    .await;
}

/// A client that trickles a request head forever (slowloris) must be cut off by the
/// header deadline — not held open for the life of the IDE, one fd and one task each.
/// Two-sided: still open well before the deadline (it is the deadline doing
/// this, not an instant refusal), closed soon after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_head_that_never_finishes_is_cut_off_by_the_header_deadline() {
    within(
        HEADER_DEADLINE + Duration::from_secs(60),
        "slowloris",
        async {
            let up = spawn_upstream().await;
            let nc = proxy();
            let s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
            let (mut r, mut w) = s.into_split();
            let t0 = Instant::now();
            w.write_all(format!("GET http://127.0.0.1:{up}/slow HTTP/1.1\r\n").as_bytes())
                .await
                .unwrap();
            let trickle = tokio::spawn(async move {
                for i in 0.. {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if w.write_all(format!("X-Drip-{i}: 1\r\n").as_bytes())
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });

            // Floor: after 3 s it is still open.
            let mut buf = [0u8; 1024];
            let early = tokio::time::timeout(Duration::from_secs(3), r.read(&mut buf)).await;
            assert!(
                early.is_err(),
                "closed after only {:?}: {early:?}",
                t0.elapsed()
            );
            // Meanwhile the proxy serves everyone else.
            assert_healthy(&nc, up, "slowloris in progress").await;

            // Ceiling: closed (or answered 408) by the deadline plus slack.
            let ceiling = HEADER_DEADLINE + Duration::from_secs(10);
            let closed = tokio::time::timeout(ceiling.saturating_sub(t0.elapsed()), async {
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => assert!(
                            buf[..n].starts_with(b"HTTP/1.1 4"),
                            "not a refusal: {:?}",
                            String::from_utf8_lossy(&buf[..n])
                        ),
                    }
                }
            })
            .await;
            trickle.abort();
            assert!(
                closed.is_ok(),
                "a never-ending request head was still open after {:?}",
                t0.elapsed()
            );
            assert!(
                t0.elapsed() >= HEADER_DEADLINE - Duration::from_secs(1),
                "cut off at {:?}, before the deadline",
                t0.elapsed()
            );
            assert_healthy(&nc, up, "slowloris").await;
            assert!(
                nc.snapshot().iter().all(|f| f.path != "/slow"),
                "an unfinished head is not a flow"
            );
        },
    )
    .await;
}

// ---------------------------------------------------------------------------------------
// Malformed and unusual targets
// ---------------------------------------------------------------------------------------

async fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connect_to_a_closed_port_is_a_prompt_502_and_an_error_flow() {
    within(Duration::from_secs(60), "connect to closed port", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let dead = dead_port().await;
        let t0 = Instant::now();
        let out = raw(
            &nc,
            format!("CONNECT 127.0.0.1:{dead} HTTP/1.1\r\nHost: x\r\n\r\n").into_bytes(),
            false,
            REFUSE_WITHIN,
        )
        .await;
        assert!(matches!(out, Outcome::Answered(502, _)), "{out:?}");
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
        let f = wait_for(&nc, "error flow", |f| f.port == dead).await;
        assert_eq!(f.state, FlowState::Error);
        assert_healthy(&nc, up, "closed-port CONNECT").await;
    })
    .await;
}

/// A CONNECT target that is not `host:port` is a client bug and gets a 400 — never a
/// silent substitution. The port cases are the finding: `http::Authority` accepts any
/// digits (or letters) after the colon and `port_u16()` returns `None` for them, which the
/// proxy used to read as "no port → default 443", tunnelling `127.0.0.1:99999` to
/// `127.0.0.1:443`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_connect_targets_are_400_and_never_rerouted() {
    within(Duration::from_secs(60), "malformed CONNECT", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        for target in [
            "127.0.0.1:99999",
            "127.0.0.1:65536",
            "127.0.0.1:abc",
            "127.0.0.1:-1",
            "/just/a/path",
            "[::1",
            "127.0.0.1:1:2",
            "@",
        ] {
            let out = raw(
                &nc,
                format!("CONNECT {target} HTTP/1.1\r\nHost: x\r\n\r\n").into_bytes(),
                false,
                REFUSE_WITHIN,
            )
            .await;
            assert!(
                matches!(out, Outcome::Answered(400, _)),
                "CONNECT {target}: {out:?}"
            );
            assert_healthy(&nc, up, &format!("CONNECT {target}")).await;
        }
        let odd: Vec<_> = nc
            .snapshot()
            .into_iter()
            .filter(|f| !f.path.starts_with("/healthy-after-"))
            .collect();
        assert!(odd.is_empty(), "a refused CONNECT is not a flow: {odd:#?}");
    })
    .await;
}

/// The same for an absolute-form URL: an invalid port is a 400, not a request to port 80.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_absolute_form_url_with_an_invalid_port_is_400_not_port_80() {
    within(Duration::from_secs(60), "invalid absolute port", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        for url in ["http://127.0.0.1:99999/x", "http://127.0.0.1:8o/x"] {
            let out = raw(
                &nc,
                format!("GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                    .into_bytes(),
                false,
                REFUSE_WITHIN,
            )
            .await;
            assert!(matches!(out, Outcome::Answered(400, _)), "{url}: {out:?}");
        }
        assert!(
            nc.snapshot().iter().all(|f| f.port != 80),
            "rerouted to port 80: {:#?}",
            nc.snapshot()
        );
        assert_healthy(&nc, up, "invalid absolute port").await;
    })
    .await;
}

/// Userinfo in an absolute-form URL is routed by host:port like any other request, and the
/// password never reaches the store.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn absolute_form_with_userinfo_is_routed_and_the_password_is_not_stored() {
    within(Duration::from_secs(60), "userinfo", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let out = raw(
            &nc,
            format!(
                "GET http://alice:hunter2-PASS@127.0.0.1:{up}/userinfo HTTP/1.1\r\n\
                 Host: 127.0.0.1:{up}\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
            false,
            REFUSE_WITHIN,
        )
        .await;
        assert!(matches!(out, Outcome::Answered(200, _)), "{out:?}");
        let f = wait_for(&nc, "userinfo flow", |f| f.path == "/userinfo").await;
        assert_eq!((f.host.as_str(), f.port), ("127.0.0.1", up));
        let json = serde_json::to_string(&nc.flow(f.id).unwrap()).unwrap();
        assert!(!json.contains("hunter2-PASS"), "{json}");
    })
    .await;
}

/// IPv6 literals: absolute-form `http://[::1]:p/` and `CONNECT [::1]:p`. Skipped — loudly —
/// where the machine has no IPv6 loopback (common in containers).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ipv6_literal_targets_work_for_absolute_form_and_connect() {
    within(Duration::from_secs(60), "ipv6", async {
        let Ok(l) = TcpListener::bind("[::1]:0").await else {
            eprintln!("SKIPPED ipv6_literal_targets…: no IPv6 loopback on this machine");
            return;
        };
        let p = l.local_addr().unwrap().port();
        tokio::spawn(serve_upstream_on(l));
        let nc = proxy();

        let res = client(&nc)
            .get(format!("http://[::1]:{p}/v6"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.text().await.unwrap(), "hello /v6");
        let f = wait_for(&nc, "v6 flow", |f| f.path == "/v6").await;
        assert_eq!((f.host.as_str(), f.port), ("::1", p));

        let mut s = TcpStream::connect(("127.0.0.1", nc.port())).await.unwrap();
        s.write_all(format!("CONNECT [::1]:{p} HTTP/1.1\r\nHost: [::1]:{p}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut b = [0u8; 1];
            assert_eq!(s.read(&mut b).await.unwrap(), 1, "closed mid-head");
            head.push(b[0]);
        }
        assert!(
            head.starts_with(b"HTTP/1.1 200"),
            "{:?}",
            String::from_utf8_lossy(&head)
        );
        s.write_all(b"GET /through-tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut rest = Vec::new();
        s.read_to_end(&mut rest).await.unwrap();
        assert!(String::from_utf8_lossy(&rest).ends_with("hello /through-tunnel"));
        drop(s); // our half-close ends the tunnel (the origin already closed its side)
        let t = wait_for(&nc, "v6 tunnel", |f| {
            f.method == "CONNECT" && f.state == FlowState::Done
        })
        .await;
        assert_eq!((t.host.as_str(), t.port), ("::1", p));
    })
    .await;
}

// ---------------------------------------------------------------------------------------
// Redaction, as a property
// ---------------------------------------------------------------------------------------

fn random_value(rng: &mut StdRng) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/=";
    let n = rng.random_range(16..48);
    let mut v = String::from("S3CR3T");
    v.extend((0..n).map(|_| A[rng.random_range(0..A.len())] as char));
    v
}

fn random_case(rng: &mut StdRng, s: &str) -> String {
    s.chars()
        .map(|c| {
            if rng.random_bool(0.5) {
                c.to_ascii_uppercase()
            } else {
                c
            }
        })
        .collect()
}

fn random_token(rng: &mut StdRng) -> String {
    const T: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    (0..rng.random_range(0..6))
        .map(|_| T[rng.random_range(0..T.len())] as char)
        .collect()
}

/// Nothing is redacted: any header whose name
/// contains `token` / `secret` / `key` / `authorization` / `cookie`, in any case — sent on the
/// request AND echoed back on the response — is stored BYTE-EXACT under its name, exactly
/// like an ordinary control header. Masking is a UI toggle, never the store's business.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sensitive_header_value_is_stored_byte_exact() {
    within(
        Duration::from_secs(120),
        "verbatim-capture property",
        async {
            let up = spawn_upstream().await;
            let nc = proxy();
            let c = client(&nc);
            let keywords = ["token", "secret", "key", "authorization", "cookie"];
            for round in 0..40u64 {
                let mut rng = StdRng::seed_from_u64(0xbee5 + round);
                let mut secrets: Vec<(String, String)> = Vec::new();
                let mut req = c.get(format!("http://127.0.0.1:{up}/echo?round={round}"));
                for i in 0..rng.random_range(3..10) {
                    let kw = keywords[rng.random_range(0..keywords.len())];
                    let name = format!(
                        "x-{}{}{}{}-{i}",
                        random_token(&mut rng),
                        if rng.random_bool(0.5) { "-" } else { "" },
                        random_case(&mut rng, kw),
                        random_token(&mut rng),
                    );
                    let value = random_value(&mut rng);
                    req = req.header(name.as_str(), value.as_str());
                    secrets.push((name.to_ascii_lowercase(), value));
                }
                // The exact names too (request side only: the echo reflects `x-` names).
                for name in ["authorization", "cookie", "x-api-key", "api-key"] {
                    let value = random_value(&mut rng);
                    req = req.header(name, value.as_str());
                    secrets.push((name.to_string(), value));
                }
                let control = format!("visible-{round}-{}", random_token(&mut rng));
                req = req.header("x-plain-note", control.as_str());

                let res = req.send().await.unwrap();
                assert_eq!(res.status(), 200);
                // The client gets the real values back, as before.
                for (name, value) in secrets
                    .iter()
                    .filter(|(n, _)| n.starts_with("x-") && n != "x-api-key")
                {
                    assert_eq!(
                        res.headers()[name.as_str()],
                        value.as_str(),
                        "echo of {name}"
                    );
                }
                let _ = res.bytes().await;

                let path = format!("/echo?round={round}");
                let f =
                    wait_for(&nc, &path, |f| f.path == path && f.state == FlowState::Done).await;
                let detail: FlowDetail = nc.flow(f.id).unwrap();
                let json = serde_json::to_string(&detail).unwrap();
                for (name, value) in &secrets {
                    let stored = detail
                        .request_headers
                        .iter()
                        .find(|(n, _)| n == name)
                        .unwrap_or_else(|| panic!("round {round}: {name} not captured at all"));
                    assert_eq!(
                        &stored.1, value,
                        "round {round}: {name} not stored byte-exact"
                    );
                }
                assert!(
                    json.contains(&control),
                    "round {round}: a control header must be kept verbatim"
                );
                assert!(
                    detail
                        .response_headers
                        .iter()
                        .any(|(n, v)| n == &secrets[0].0 && v == &secrets[0].1),
                    "round {round}: the echoed response header {} was not stored byte-exact",
                    secrets[0].0
                );
            }
        },
    )
    .await;
}

// ---------------------------------------------------------------------------------------
// Body caps
// ---------------------------------------------------------------------------------------

fn stored_bytes(b: &agent_studio_scaffold_lib::netcap::FlowBody) -> Vec<u8> {
    match (&b.text, &b.base64) {
        (Some(t), None) => t.as_bytes().to_vec(),
        (None, Some(b64)) => base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap(),
        other => panic!("exactly one of text/base64 must be set: {other:?}"),
    }
}

/// A 5 MiB response reaches the client byte-exact, while the store keeps at most 1 MiB of
/// it, flagged `truncated`, with the true wire size.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_5_mib_response_is_forwarded_whole_and_stored_capped() {
    within(Duration::from_secs(120), "5 MiB response", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let want = big_text();
        let got = client(&nc)
            .get(format!("http://127.0.0.1:{up}/big"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(got.len(), want.len(), "client got the whole body");
        assert!(got[..] == want[..], "client got the body byte-exact");

        let f = wait_for(&nc, "big", |f| {
            f.path == "/big" && f.state == FlowState::Done
        })
        .await;
        assert_eq!(f.res_bytes, want.len() as u64, "row shows the wire size");
        let body = nc.flow(f.id).unwrap().response_body.expect("captured");
        assert!(body.truncated);
        assert_eq!(body.size, want.len() as u64);
        let kept = stored_bytes(&body);
        assert!(kept.len() <= BODY_CAP, "stored {} bytes", kept.len());
        assert!(
            kept.len() >= BODY_CAP - 3,
            "stored only {} bytes",
            kept.len()
        );
        assert_eq!(
            kept[..],
            want[..kept.len()],
            "the stored copy is the prefix"
        );
    })
    .await;
}

/// The cap cut the (valid UTF-8) text inside a character. That is the cap's doing, not the
/// body's, so the UI still gets `text` — the valid prefix — not a 1.4 MB base64 blob.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_capped_text_body_cut_inside_a_character_is_still_text() {
    within(Duration::from_secs(120), "capped text", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let _ = client(&nc)
            .get(format!("http://127.0.0.1:{up}/big"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let f = wait_for(&nc, "big", |f| {
            f.path == "/big" && f.state == FlowState::Done
        })
        .await;
        let body = nc.flow(f.id).unwrap().response_body.expect("captured");
        let text = body
            .text
            .as_deref()
            .expect("a capped UTF-8 body is shown as text");
        assert!(body.base64.is_none());
        assert!(!text.contains('\u{FFFD}'));
        assert_eq!(
            text.len(),
            BODY_CAP - 1,
            "1 MiB less the cut char's first byte"
        );
        assert!(text.chars().all(|c| c == '→'));
    })
    .await;
}

/// The request side: a 5 MiB random upload reaches the origin byte-exact (it hashes what
/// it got) and the store keeps ≤ 1 MiB, truncated, with the true size.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_5_mib_upload_is_forwarded_whole_and_stored_capped() {
    within(Duration::from_secs(120), "5 MiB upload", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let mut rng = StdRng::seed_from_u64(0x0b0d);
        let payload: Vec<u8> = (0..5 * 1024 * 1024).map(|_| rng.random::<u8>()).collect();
        let res = client(&nc)
            .post(format!("http://127.0.0.1:{up}/upload"))
            .body(payload.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(
            res.text().await.unwrap(),
            format!("len={} fnv={:x}", payload.len(), fnv(&payload)),
            "the origin got the upload byte-exact"
        );
        let f = wait_for(&nc, "upload", |f| {
            f.path == "/upload" && f.state == FlowState::Done
        })
        .await;
        assert_eq!(f.req_bytes, payload.len() as u64);
        let body = nc.flow(f.id).unwrap().request_body.expect("captured");
        assert!(body.truncated);
        assert_eq!(body.size, payload.len() as u64);
        let kept = stored_bytes(&body);
        assert_eq!(kept.len(), BODY_CAP);
        assert_eq!(kept[..], payload[..BODY_CAP]);
    })
    .await;
}

// ---------------------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------------------

/// 5 100 requests → exactly the newest 5 000 flows retained, the oldest 100 evicted, ids
/// strictly increasing with no gaps.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_flow_ring_keeps_exactly_the_newest_5000() {
    within(Duration::from_secs(300), "5 100 requests", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let c = client(&nc);
        let total = RING + 100;
        for i in 0..total {
            let res = c
                .get(format!("http://127.0.0.1:{up}/ring/{i}"))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 200);
            let _ = res.bytes().await.unwrap();
        }
        let last = format!("/ring/{}", total - 1);
        wait_for(&nc, &last, |f| f.path == last && f.state == FlowState::Done).await;
        let flows = nc.snapshot();
        assert_eq!(flows.len(), RING);
        assert_eq!(nc.status().flow_count, RING);
        for w in flows.windows(2) {
            assert_eq!(w[1].id, w[0].id + 1, "ids are consecutive and increasing");
        }
        assert_eq!(flows[0].path, "/ring/100", "the oldest 100 were evicted");
        assert_eq!(flows[RING - 1].path, last);
        assert!(nc.flow(flows[0].id - 1).is_err(), "an evicted flow is gone");
        assert!(flows.iter().all(|f| f.status == Some(200)));
    })
    .await;
}

/// 200 requests at once: all complete with the right status, and each is exactly one
/// flow carrying that status.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_hundred_parallel_requests_all_complete_as_two_hundred_flows() {
    within(Duration::from_secs(120), "200 parallel", async {
        let up = spawn_upstream().await;
        let nc = proxy();
        let c = client(&nc);
        let codes = [200u16, 201, 204, 404, 418, 500, 503];
        let mut tasks = Vec::new();
        for i in 0..200usize {
            let (c, code) = (c.clone(), codes[i % codes.len()]);
            tasks.push(tokio::spawn(async move {
                let res = c
                    .get(format!("http://127.0.0.1:{up}/status/{code}?i={i}"))
                    .send()
                    .await
                    .unwrap_or_else(|e| panic!("request {i}: {e}"));
                assert_eq!(res.status().as_u16(), code, "request {i}");
                let _ = res.bytes().await;
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        for _ in 0..1_000 {
            if nc
                .snapshot()
                .iter()
                .filter(|f| f.state == FlowState::Done)
                .count()
                == 200
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let flows = nc.snapshot();
        assert_eq!(flows.len(), 200, "one flow per request");
        let mut seen = std::collections::BTreeSet::new();
        for f in &flows {
            assert_eq!(f.state, FlowState::Done, "{f:?}");
            let (code, i) = f
                .path
                .strip_prefix("/status/")
                .and_then(|r| r.split_once("?i="))
                .unwrap_or_else(|| panic!("odd path {}", f.path));
            assert_eq!(f.status, Some(code.parse().unwrap()), "{f:?}");
            assert!(seen.insert(i.to_string()), "request {i} recorded twice");
        }
        assert_eq!(seen.len(), 200);
    })
    .await;
}
