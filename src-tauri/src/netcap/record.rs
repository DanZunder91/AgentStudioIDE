//! Tap for the IDE's own in-process API client (HTTP, WS, gRPC), whose traffic never crosses
//! the proxy. Rows use [`IDE_TERMINAL_ID`], always recorded and decrypted, headers verbatim.
//! Sizes are library-level payloads. Nothing here can fail a request; a store-less [`Tap`] no-ops.

use std::sync::Arc;
use std::time::Instant;

use super::store::{Captured, FlowRecord, BODY_CAP};
use super::types::{ClientProcess, FlowProto, FlowState, FlowSummary, WsCounts};
use super::{Inner, Netcap, GLOBAL};

/// The reserved `terminalId` of every API-client flow.
pub const IDE_TERMINAL_ID: &str = "ide-api-client";
/// The `client.name` of every API-client flow.
pub const IDE_CLIENT_NAME: &str = "Agent Studio";

/// This process, as the `client` of an API-client flow.
pub fn ide_client() -> ClientProcess {
    ClientProcess {
        pid: std::process::id(),
        name: IDE_CLIENT_NAME.to_string(),
        path: std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

/// `"HTTP/1.1"` / `"HTTP/2"` — the `httpVersion` label a proxied flow uses, for a client's
/// negotiated version.
pub fn http_version(v: hyper::Version) -> String {
    super::proxy::version_label(v)
}

/// Where an API-client flow is recorded: the app's proxy ([`Tap::global`]), a specific instance
/// ([`Tap::of`] — tests), or nowhere ([`Tap::none`]).
#[derive(Clone, Default)]
pub struct Tap {
    inner: Option<Arc<Inner>>,
}

impl Tap {
    /// The app's one proxy. Records nothing when it never started (tests, or `start` failed).
    pub fn global() -> Tap {
        Tap {
            inner: GLOBAL.get().map(|nc| nc.inner.clone()),
        }
    }

    /// Records nothing.
    pub fn none() -> Tap {
        Tap::default()
    }

    /// Records into this instance.
    pub fn of(nc: &Netcap) -> Tap {
        Tap {
            inner: Some(nc.inner.clone()),
        }
    }

    pub fn is_recording(&self) -> bool {
        self.inner.is_some()
    }

    /// Insert a pending row for a request that is about to go out. `request_headers` are the
    /// headers **as sent**; `http_version` is `""` until the client knows it (HTTP), or the
    /// version the transport always speaks (WebSocket `HTTP/1.1`, gRPC `HTTP/2`).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        proto: FlowProto,
        method: &str,
        host: &str,
        port: u16,
        path: &str,
        http_version: &str,
        request_headers: Vec<(String, String)>,
    ) -> Flow {
        let started = Instant::now();
        let Some(inner) = &self.inner else {
            return Flow::none();
        };
        let mut s = FlowSummary::pending(proto, method, host, port, path);
        s.terminal_id = Some(IDE_TERMINAL_ID.to_string());
        s.client = Some(ide_client());
        s.http_version = http_version.to_string();
        let id = inner.insert(s, |r| r.request_headers = request_headers);
        Flow {
            inner: Some(inner.clone()),
            id,
            started,
        }
    }
}

/// One in-flight API-client flow. Every method is a no-op when nothing is recording.
pub struct Flow {
    inner: Option<Arc<Inner>>,
    id: u64,
    started: Instant,
}

/// The first [`BODY_CAP`] bytes of a body plus its true length.
fn captured(bytes: &[u8]) -> Captured {
    let mut c = Captured::default();
    c.push(bytes, BODY_CAP);
    c
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

impl Flow {
    /// A flow that records nothing.
    pub fn none() -> Flow {
        Flow {
            inner: None,
            id: 0,
            started: Instant::now(),
        }
    }

    pub fn is_recording(&self) -> bool {
        self.inner.is_some()
    }

    /// The store id, when recording.
    pub fn id(&self) -> Option<u64> {
        self.inner.as_ref().map(|_| self.id)
    }

    fn update(&self, f: impl FnOnce(&mut FlowRecord)) {
        if let Some(inner) = &self.inner {
            inner.update(self.id, f);
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Replace the request headers — HTTP does this once the negotiated version is known
    /// (HTTP/2 carries no `host` header).
    pub fn request_headers(&self, headers: Vec<(String, String)>) {
        self.update(|r| r.request_headers = headers);
    }

    /// The request body (captured up to the cap) and the bytes it was on the wire.
    pub fn request_body(&self, body: &[u8], wire_bytes: u64) {
        let c = captured(body);
        self.update(move |r| {
            r.summary.req_bytes = wire_bytes;
            r.request_body = Some(c);
        });
    }

    /// The response head as received: status, negotiated version, headers verbatim.
    /// `contentType` and the body's `content-encoding` (for the detail view's decoder) are
    /// read from the headers.
    pub fn response_head(&self, status: u16, http_version: &str, headers: Vec<(String, String)>) {
        let content_type = header(&headers, "content-type").map(str::to_string);
        let encoding = header(&headers, "content-encoding").map(str::to_string);
        let version = http_version.to_string();
        self.update(move |r| {
            r.summary.status = Some(status);
            r.summary.http_version = version;
            r.summary.content_type = content_type;
            r.response_encoding = encoding;
            r.response_headers = headers;
        });
    }

    /// The response body (captured up to the cap) and the bytes it was on the wire.
    pub fn response_body(&self, body: &[u8], wire_bytes: u64) {
        let c = captured(body);
        self.update(move |r| {
            r.summary.res_bytes = wire_bytes;
            r.response_body = Some(c);
        });
    }

    /// gRPC trailers as received (`grpc-status`, `grpc-message`, the rest).
    pub fn response_trailers(&self, trailers: Vec<(String, String)>) {
        self.update(|r| r.response_trailers = trailers);
    }

    pub fn grpc_status(&self, code: i32) {
        self.update(move |r| r.summary.grpc_status = Some(code));
    }

    /// The WebSocket handshake succeeded: message counts start at 0/0 (the row stays pending
    /// while the socket is open).
    pub fn ws_open(&self) {
        self.update(|r| r.summary.ws_messages = Some(WsCounts::default()));
    }

    /// One data message went to the server (`payload` bytes).
    pub fn ws_sent(&self, payload: usize) {
        self.update(move |r| {
            r.summary.req_bytes += payload as u64;
            if let Some(w) = r.summary.ws_messages.as_mut() {
                w.up += 1;
            }
        });
    }

    /// One data message came from the server (`payload` bytes).
    pub fn ws_received(&self, payload: usize) {
        self.update(move |r| {
            r.summary.res_bytes += payload as u64;
            if let Some(w) = r.summary.ws_messages.as_mut() {
                w.down += 1;
            }
        });
    }

    /// The flow completed. `duration_ms` is the client's own measurement when it has one
    /// (`http_send` reports the same number to the console), else the time since `start`.
    pub fn done(&self, duration_ms: Option<u64>) {
        let d = duration_ms.unwrap_or_else(|| self.elapsed_ms());
        self.update(move |r| {
            r.summary.duration_ms = Some(d);
            r.summary.state = FlowState::Done;
        });
    }

    /// The request failed — the same text the console shows.
    pub fn fail(&self, error: impl Into<String>) {
        let e = error.into();
        let d = self.elapsed_ms();
        self.update(move |r| {
            r.summary.duration_ms = Some(d);
            r.summary.state = FlowState::Error;
            r.summary.error = Some(e);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::{lock, FlowSink, NetcapConfig};
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Vec<FlowSummary>>>);
    impl FlowSink for Recorder {
        fn emit(&self, flows: &[FlowSummary]) {
            lock(&self.0).push(flows.to_vec());
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

    fn pairs(p: &[(&str, &str)]) -> Vec<(String, String)> {
        p.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// The identity every API-client row carries: the reserved terminal id and
    /// this very process, named `Agent Studio`.
    fn assert_ide_attribution(f: &FlowSummary) {
        assert_eq!(f.terminal_id.as_deref(), Some("ide-api-client"), "{f:?}");
        let c = f.client.as_ref().expect("client set");
        assert_eq!(c.pid, std::process::id());
        assert_eq!(c.name, "Agent Studio");
        assert_eq!(
            c.path.as_deref(),
            Some(std::env::current_exe().unwrap().to_string_lossy().as_ref())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_http_flow_goes_pending_then_done_with_the_ide_attribution() {
        let rec = Arc::new(Recorder::default());
        let nc = start(rec.clone());
        let tap = Tap::of(&nc);
        assert!(tap.is_recording());

        let flow = tap.start(
            FlowProto::Https,
            "POST",
            "api.example.com",
            443,
            "/v1/items?x=1",
            "",
            pairs(&[
                ("authorization", "Bearer sk-live-SECRET"),
                ("host", "api.example.com"),
            ]),
        );
        assert!(flow.is_recording());
        let id = flow.id().expect("an id when recording");
        flow.request_body(b"{\"k\":\"v\"}", 9);

        let pending = nc.snapshot().pop().unwrap();
        assert_eq!(pending.id, id);
        assert_eq!(pending.state, FlowState::Pending);
        assert_eq!(
            (pending.proto, pending.method.as_str()),
            (FlowProto::Https, "POST")
        );
        assert_eq!(
            (pending.host.as_str(), pending.port),
            ("api.example.com", 443)
        );
        assert_eq!(pending.path, "/v1/items?x=1");
        assert_eq!(pending.http_version, "");
        assert_eq!(pending.req_bytes, 9);
        assert_eq!((pending.status, pending.duration_ms), (None, None));
        assert_ide_attribution(&pending);
        // Let the pending row go out before completing (the emitter coalesces within 100 ms).
        tokio::time::sleep(Duration::from_millis(150)).await;

        flow.response_head(
            201,
            "HTTP/2",
            pairs(&[
                ("content-type", "application/json; charset=utf-8"),
                ("x-request-id", "r1"),
            ]),
        );
        flow.response_body(br#"{"ok":true}"#, 11);
        flow.done(Some(120));

        let done = nc.snapshot().pop().unwrap();
        assert_eq!(done.state, FlowState::Done);
        assert_eq!(done.status, Some(201));
        assert_eq!(done.http_version, "HTTP/2");
        assert_eq!(
            done.content_type.as_deref(),
            Some("application/json; charset=utf-8")
        );
        assert_eq!((done.req_bytes, done.res_bytes), (9, 11));
        assert_eq!(
            done.duration_ms,
            Some(120),
            "the console's own measurement, not a second clock"
        );
        assert_eq!(done.error, None);
        assert_ide_attribution(&done);

        let d = nc.flow(id).unwrap();
        assert_eq!(
            d.request_headers,
            pairs(&[
                ("authorization", "Bearer sk-live-SECRET"),
                ("host", "api.example.com")
            ]),
            "verbatim — nothing redacted"
        );
        assert_eq!(
            d.response_headers,
            pairs(&[
                ("content-type", "application/json; charset=utf-8"),
                ("x-request-id", "r1")
            ])
        );
        assert_eq!(
            d.request_body.as_ref().unwrap().text.as_deref(),
            Some("{\"k\":\"v\"}")
        );
        assert_eq!(
            d.response_body.as_ref().unwrap().text.as_deref(),
            Some(r#"{"ok":true}"#)
        );
        assert!(d.response_trailers.is_empty());

        // The emitter carried it: pending first, then done, both under the same id.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let states: Vec<FlowState> = lock(&rec.0)
            .iter()
            .flatten()
            .filter(|f| f.id == id)
            .map(|f| f.state)
            .collect();
        assert_eq!(states.first(), Some(&FlowState::Pending), "{states:?}");
        assert_eq!(states.last(), Some(&FlowState::Done), "{states:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_request_is_an_error_row_with_the_console_text() {
        let nc = start(Arc::new(Recorder::default()));
        let flow = Tap::of(&nc).start(FlowProto::Http, "GET", "127.0.0.1", 9, "/", "", Vec::new());
        flow.fail("could not connect: 127.0.0.1");
        let f = nc.snapshot().pop().unwrap();
        assert_eq!(f.state, FlowState::Error);
        assert_eq!(f.error.as_deref(), Some("could not connect: 127.0.0.1"));
        assert!(f.duration_ms.is_some(), "an error row still has a duration");
        assert_eq!(f.status, None);
        assert_ide_attribution(&f);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_binary_body_is_base64_and_a_body_past_the_cap_is_truncated() {
        let nc = start(Arc::new(Recorder::default()));
        let flow = Tap::of(&nc).start(FlowProto::Http, "GET", "h", 80, "/", "", Vec::new());
        flow.response_body(&[0, 159, 146, 150], 4);
        let body = nc.flow(flow.id().unwrap()).unwrap().response_body.unwrap();
        assert_eq!(
            (body.text, body.base64.as_deref()),
            (None, Some("AJ+Slg=="))
        );

        let big = vec![b'a'; BODY_CAP + 1];
        flow.request_body(&big, big.len() as u64);
        let d = nc.flow(flow.id().unwrap()).unwrap();
        let body = d.request_body.unwrap();
        assert!(body.truncated);
        assert_eq!(
            body.size,
            BODY_CAP as u64 + 1,
            "the true length, past the cap"
        );
        assert_eq!(
            body.text.unwrap().len(),
            BODY_CAP,
            "only the first MiB is kept"
        );
        assert_eq!(d.summary.req_bytes, BODY_CAP as u64 + 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_websocket_flow_counts_messages_and_payload_bytes_and_stays_pending_until_closed() {
        let nc = start(Arc::new(Recorder::default()));
        let flow = Tap::of(&nc).start(
            FlowProto::Wss,
            "GET",
            "ws.example.com",
            443,
            "/chat",
            "HTTP/1.1",
            pairs(&[("host", "ws.example.com"), ("upgrade", "websocket")]),
        );
        let f = nc.snapshot().pop().unwrap();
        assert_eq!(
            f.ws_messages, None,
            "not a socket until the handshake succeeds"
        );
        assert_eq!(f.http_version, "HTTP/1.1");

        flow.response_head(101, "HTTP/1.1", pairs(&[("upgrade", "websocket")]));
        flow.ws_open();
        flow.ws_sent(5);
        flow.ws_sent(3);
        flow.ws_received(11);
        let f = nc.snapshot().pop().unwrap();
        assert_eq!(f.status, Some(101));
        assert_eq!(f.ws_messages, Some(WsCounts { up: 2, down: 1 }));
        assert_eq!((f.req_bytes, f.res_bytes), (8, 11), "payload bytes");
        assert_eq!(
            f.state,
            FlowState::Pending,
            "open = still pending, like a proxied socket"
        );
        assert_eq!(f.duration_ms, None);

        flow.done(None);
        let f = nc.snapshot().pop().unwrap();
        assert_eq!(f.state, FlowState::Done);
        assert!(f.duration_ms.is_some());
        assert_eq!(f.ws_messages, Some(WsCounts { up: 2, down: 1 }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_grpc_flow_records_the_status_and_trailers() {
        let nc = start(Arc::new(Recorder::default()));
        let flow = Tap::of(&nc).start(
            FlowProto::Grpc,
            "POST",
            "127.0.0.1",
            50051,
            "/pkg.Greeter/SayHello",
            "HTTP/2",
            pairs(&[("te", "trailers"), ("content-type", "application/grpc")]),
        );
        flow.request_body(br#"{"name":"x"}"#, 3);
        flow.grpc_status(3);
        flow.response_trailers(pairs(&[("grpc-status", "3"), ("grpc-message", "bad name")]));
        flow.done(None);
        let f = nc.snapshot().pop().unwrap();
        assert_eq!(
            (f.proto, f.http_version.as_str()),
            (FlowProto::Grpc, "HTTP/2")
        );
        assert_eq!(f.grpc_status, Some(3));
        assert_eq!(f.status, None, "no HTTP status was seen — none is invented");
        assert_eq!(
            f.state,
            FlowState::Done,
            "a gRPC status is a response, not a failure"
        );
        assert_eq!(f.req_bytes, 3, "the protobuf payload, not the JSON");
        let d = nc.flow(f.id).unwrap();
        assert_eq!(
            d.response_trailers,
            pairs(&[("grpc-status", "3"), ("grpc-message", "bad name")])
        );
        assert_eq!(d.request_body.unwrap().size, 12, "the JSON shown");
    }

    #[test]
    fn a_tap_with_no_store_records_nothing_and_never_fails() {
        // `cargo test` never runs `setup`, so the app's tap is empty here — the exact state
        // every `http_send` test runs in.
        for tap in [Tap::none(), Tap::global()] {
            assert!(!tap.is_recording());
            let flow = tap.start(FlowProto::Http, "GET", "h", 80, "/", "", Vec::new());
            assert!(!flow.is_recording());
            assert_eq!(flow.id(), None);
            flow.request_body(b"x", 1);
            flow.response_head(200, "HTTP/1.1", Vec::new());
            flow.response_body(b"y", 1);
            flow.response_trailers(Vec::new());
            flow.grpc_status(0);
            flow.ws_open();
            flow.ws_sent(1);
            flow.ws_received(1);
            flow.done(None);
            flow.fail("nope");
        }
        assert!(!Flow::none().is_recording());
    }

    #[test]
    fn the_ide_client_is_this_process() {
        let c = ide_client();
        assert_eq!(c.pid, std::process::id());
        assert_eq!(c.name, IDE_CLIENT_NAME);
        assert!(c.path.as_deref().is_some_and(|p| !p.is_empty()));
        assert_eq!(http_version(hyper::Version::HTTP_2), "HTTP/2");
        assert_eq!(http_version(hyper::Version::HTTP_11), "HTTP/1.1");
    }
}
