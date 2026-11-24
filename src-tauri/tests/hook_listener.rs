//! Integration tests for the hook listener — the **security
//! boundary**. A real `TcpStream` client POSTs to the real listener; we assert the
//! token gate lets valid requests through and drops everything else.
//!
//! These use raw TCP + hand-written HTTP requests (exactly what the `curl` in the
//! hook produces), so the parser and the token check are exercised for real, not
//! mocked.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::hook_listener::HookListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// One delivered hook: `(terminal_id, body)`.
type Delivery = (String, Vec<u8>);

/// Records what the listener delivered to its callback.
#[derive(Clone, Default)]
struct Received(Arc<Mutex<Vec<Delivery>>>);

impl Received {
    fn list(&self) -> Vec<Delivery> {
        self.0.lock().unwrap().clone()
    }
}

/// Bind + serve a listener wired to a recorder. Returns `(base_url, token,
/// recorder)`.
fn start_listener() -> (String, String, Received) {
    let (listener, config) = HookListener::bind().expect("bind failed");
    let received = Received::default();
    let sink = received.clone();
    listener.serve(move |terminal_id, body| {
        sink.0.lock().unwrap().push((terminal_id, body));
    });
    (config.base_url, config.token, received)
}

fn port_of(base_url: &str) -> u16 {
    base_url.rsplit(':').next().unwrap().parse().unwrap()
}

/// Send a raw request and return the status line.
///
/// The write may fail: a listener that refuses on the headers answers and closes
/// while a large body is still uploading. The caller asserts on the answer, which
/// names the refusal; a panic here would hide it behind "broken pipe".
async fn send_raw(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect failed");
    let _ = stream.write_all(request.as_bytes()).await;
    stream.flush().await.ok();
    let mut response = Vec::new();
    // The listener responds then closes; read to EOF (bounded by a timeout).
    let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut response)).await;
    String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

/// Build a POST like the hook's `curl` does: token + terminal headers, JSON body.
fn post(token: &str, terminal: &str, body: &str) -> String {
    format!(
        "POST /hook HTTP/1.1\r\nHost: 127.0.0.1\r\nX-AgentStudio-Token: {token}\r\n\
         X-AgentStudio-Terminal: {terminal}\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

async fn wait_for(received: &Received, n: usize) {
    let start = std::time::Instant::now();
    while received.list().len() < n {
        if start.elapsed() > Duration::from_secs(5) {
            panic!(
                "timed out waiting for {n} deliveries; got {}",
                received.list().len()
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A correctly-tokened POST is delivered verbatim to the callback.
#[tokio::test]
async fn a_valid_request_is_delivered() {
    let (url, token, received) = start_listener();
    let body = r#"{"hook_event_name":"SessionStart","session_id":"s1"}"#;
    let status = send_raw(port_of(&url), &post(&token, "term-42", body)).await;

    assert!(status.contains("204"), "expected 204, got {status:?}");
    wait_for(&received, 1).await;
    let got = received.list();
    assert_eq!(got[0].0, "term-42", "terminal id must round-trip");
    assert_eq!(got[0].1, body.as_bytes(), "body must be delivered verbatim");
}

/// **The security boundary: a wrong token is rejected and delivered to nothing.**
/// This is what stops any local process from forging phantom agents.
#[tokio::test]
async fn a_wrong_token_is_rejected() {
    let (url, _token, received) = start_listener();
    let body = r#"{"hook_event_name":"SessionStart","session_id":"s1"}"#;
    let status = send_raw(port_of(&url), &post("not-the-token", "term-42", body)).await;

    assert!(status.contains("403"), "expected 403, got {status:?}");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        received.list().is_empty(),
        "a forged request reached the callback"
    );
}

/// A request with **no token header** is rejected — absence is not a bypass.
#[tokio::test]
async fn a_missing_token_is_rejected() {
    let (url, _token, received) = start_listener();
    let body = r#"{"x":1}"#;
    let request = format!(
        "POST /hook HTTP/1.1\r\nX-AgentStudio-Terminal: t\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let status = send_raw(port_of(&url), &request).await;

    assert!(status.contains("403"), "expected 403, got {status:?}");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(received.list().is_empty());
}

/// A valid token but **no terminal header** is a malformed hook — nothing to bind,
/// so it is dropped (400), not delivered.
#[tokio::test]
async fn a_valid_token_without_a_terminal_is_dropped() {
    let (url, token, received) = start_listener();
    let body = r#"{"x":1}"#;
    let request = format!(
        "POST /hook HTTP/1.1\r\nX-AgentStudio-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let status = send_raw(port_of(&url), &request).await;

    assert!(status.contains("400"), "expected 400, got {status:?}");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(received.list().is_empty());
}

/// A non-POST verb is refused (we serve exactly one shape).
#[tokio::test]
async fn a_get_is_refused() {
    let (url, _token, received) = start_listener();
    let status = send_raw(port_of(&url), "GET /hook HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert!(status.contains("400"), "expected 400, got {status:?}");
    assert!(received.list().is_empty());
}

/// An oversized body is refused, not buffered unboundedly (DoS guard). The listener
/// caps a body at 16 MiB; a declared Content-Length past that is rejected outright.
#[tokio::test]
async fn an_oversized_body_is_refused() {
    let (url, token, received) = start_listener();
    let request = format!(
        "POST /hook HTTP/1.1\r\nX-AgentStudio-Token: {token}\r\nX-AgentStudio-Terminal: t\r\n\
         Content-Length: 100000000\r\n\r\n"
    );
    let status = send_raw(port_of(&url), &request).await;
    assert!(
        status.contains("400"),
        "expected 400 for an oversized body, got {status:?}"
    );
    assert!(received.list().is_empty());
}

/// **A prompt-sized body is delivered whole.** `UserPromptSubmit` carries the user's
/// prompt, and a prompt with a pasted query result easily makes a payload past
/// 100 KB. The old 64 KiB cap answered 400, the hook's
/// `curl … || true` swallowed it, and the agent stayed "idle" for its whole turn.
#[tokio::test]
async fn a_body_past_64_kib_is_delivered_whole() {
    let (url, token, received) = start_listener();
    let prompt = "x".repeat(1024 * 1024);
    let body = format!(
        r#"{{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"{prompt}"}}"#
    );
    let status = send_raw(port_of(&url), &post(&token, "term-big", &body)).await;

    assert!(status.contains("204"), "expected 204, got {status:?}");
    wait_for(&received, 1).await;
    let got = received.list();
    assert_eq!(got[0].0, "term-big");
    assert_eq!(got[0].1.len(), body.len(), "the body must not be truncated");
    assert_eq!(got[0].1, body.as_bytes(), "body must be delivered verbatim");
}

/// **The token is checked on the headers, before any body byte is read.** A forger
/// that declares a large body and never sends it is answered 403 at once — it does
/// not hold a task open waiting for bytes, and the body cap only ever bounds a peer
/// that already proved it is one of our hooks.
#[tokio::test]
async fn a_wrong_token_is_refused_before_its_body_is_read() {
    let (url, _token, received) = start_listener();
    // Under the cap, and the body never comes: only a headers-first check answers.
    let request = "POST /hook HTTP/1.1\r\nX-AgentStudio-Token: not-the-token\r\n\
                   X-AgentStudio-Terminal: t\r\nContent-Length: 1000000\r\n\r\n";

    let mut stream = TcpStream::connect(("127.0.0.1", port_of(&url)))
        .await
        .unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    // Keep the write half OPEN (a client mid-upload): the answer must not wait for it.
    let mut response = vec![0u8; 256];
    let n = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut response))
        .await
        .expect("no answer while the body was outstanding — the token was not checked first")
        .unwrap();
    let status = String::from_utf8_lossy(&response[..n]);
    assert!(
        status.starts_with("HTTP/1.1 403"),
        "expected 403, got {status:?}"
    );
    assert!(received.list().is_empty());
}

/// The body can arrive split across writes (as a real socket may deliver it) and is
/// still reassembled to exactly `Content-Length`.
#[tokio::test]
async fn a_body_split_across_writes_is_reassembled() {
    let (url, token, received) = start_listener();
    let body = r#"{"hook_event_name":"SessionEnd","session_id":"s9"}"#;
    let head = format!(
        "POST /hook HTTP/1.1\r\nX-AgentStudio-Token: {token}\r\nX-AgentStudio-Terminal: split\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );

    let mut stream = TcpStream::connect(("127.0.0.1", port_of(&url)))
        .await
        .unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Send the body in two halves after a gap.
    let (a, b) = body.split_at(body.len() / 2);
    stream.write_all(a.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    stream.write_all(b.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    wait_for(&received, 1).await;
    assert_eq!(received.list()[0].1, body.as_bytes());
}

/// Each launch mints a distinct token, so a token leaked from one run can't drive
/// another (the base URL is per-instance too — FM-2).
#[tokio::test]
async fn two_listeners_have_distinct_tokens_and_ports() {
    let (url_a, token_a, _a) = start_listener();
    let (url_b, token_b, _b) = start_listener();
    assert_ne!(token_a, token_b, "tokens must differ per launch");
    assert_ne!(url_a, url_b, "ports must differ per instance");

    // token_a must not work against listener B.
    let body = r#"{"hook_event_name":"SessionStart","session_id":"s"}"#;
    let status = send_raw(port_of(&url_b), &post(&token_a, "t", body)).await;
    assert!(
        status.contains("403"),
        "one instance's token opened another's listener"
    );
}
