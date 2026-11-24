//! **The IDE's own API client in the Network view.** A request sent from the built-in API
//! client used to never appear in Network: `http_send` / `ws_*` / `grpc_send` run inside the IDE
//! process, so nothing of theirs crosses the capture proxy. They now record straight into the
//! netcap store; this file is the seam test — the REAL client code paths
//! (`http::send_via`, `ws::connect_via`, `grpc::send_via`), recorded into a real `Netcap`, against
//! real loopback servers, asserting the row AND that `netcap://flow` (the `FlowSink`) carried it.
//!
//! Hermetic: every server is started here on 127.0.0.1 — an HTTP/1.1 server that
//! echoes back the headers it RECEIVED (so the row's "as sent" headers are compared with the
//! wire, not with our own reconstruction), a WebSocket echo / authenticating server, and a
//! hand-rolled h2c gRPC server that speaks server reflection (tonic's server feature is not in
//! the build, so the fixture answers the two reflection queries and one unary method by hand).

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::grpc::{self, GrpcHeader, GrpcRequest};
use agent_studio_scaffold_lib::http::{self, HttpHeader, HttpRequest};
use agent_studio_scaffold_lib::netcap::record::{Tap, IDE_CLIENT_NAME, IDE_TERMINAL_ID};
use agent_studio_scaffold_lib::netcap::{
    FlowProto, FlowSink, FlowState, FlowSummary, Netcap, NetcapConfig, WsCounts,
};
use agent_studio_scaffold_lib::ws::{self, WsHeader};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use prost::Message as _;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::net::TcpListener;

type UBody = UnsyncBoxBody<Bytes, Infallible>;

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

fn netcap() -> (Netcap, Arc<Recorder>) {
    let rec = Arc::new(Recorder::default());
    let nc = Netcap::start(
        NetcapConfig {
            dir: None,
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        },
        rec.clone(),
    )
    .expect("netcap starts");
    (nc, rec)
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

/// Every emitted state of flow `id`, in emit order (waits for the batch to go out).
async fn emitted_states(rec: &Recorder, id: u64, last: FlowState) -> Vec<FlowState> {
    for _ in 0..100 {
        let states: Vec<FlowState> = rec
            .all()
            .iter()
            .filter(|f| f.id == id)
            .map(|f| f.state)
            .collect();
        if states.last() == Some(&last) {
            return states;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("flow {id} never emitted {last:?}: {:#?}", rec.all());
}

/// The attribution contract: the reserved terminal id, and this very process.
fn assert_api_client(f: &FlowSummary) {
    assert_eq!(f.terminal_id.as_deref(), Some(IDE_TERMINAL_ID), "{f:?}");
    assert_eq!(f.terminal_id.as_deref(), Some("ide-api-client"));
    let c = f.client.as_ref().expect("client");
    assert_eq!(c.pid, std::process::id(), "{f:?}");
    assert_eq!(c.name, IDE_CLIENT_NAME);
    assert_eq!(c.name, "Agent Studio");
    assert_eq!(
        c.path.as_deref(),
        Some(std::env::current_exe().unwrap().to_string_lossy().as_ref())
    );
    assert_eq!(f.note, None);
}

fn pairs(p: &[(&str, &str)]) -> Vec<(String, String)> {
    p.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// `/gzip` → a gzip JSON body; anything else → 200 + the request headers it RECEIVED, in wire
/// order, as a JSON `[[name, value], …]` (plus an `x-served-by` header).
async fn echo(req: Request<Incoming>) -> Result<Response<UBody>, Infallible> {
    let path = req.uri().path().to_string();
    let received: Vec<(String, String)> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
        .collect();
    let _ = req.into_body().collect().await;
    let resp = if path == "/gzip" {
        Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .body(Full::new(Bytes::from(gzip(br#"{"zipped":true}"#))).boxed_unsync())
    } else {
        Response::builder()
            .status(201)
            .header("content-type", "application/json")
            .header("x-served-by", "echo")
            .body(Full::new(Bytes::from(serde_json::to_vec(&received).unwrap())).boxed_unsync())
    };
    Ok(resp.unwrap())
}

async fn spawn_echo() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(s), service_fn(echo))
                    .await;
            });
        }
    });
    port
}

fn hreq(method: &str, url: String, headers: &[(&str, &str)], body: Option<&str>) -> HttpRequest {
    HttpRequest {
        method: method.into(),
        url,
        headers: headers
            .iter()
            .map(|(n, v)| HttpHeader {
                name: n.to_string(),
                value: v.to_string(),
            })
            .collect(),
        body: body.map(str::to_string),
    }
}

/// THE bug: a request sent from the API client lands in Network, attributed to the API
/// client, with the request exactly as the server received it and the response as returned —
/// and the emitter (`netcap://flow`) carried it pending, then done.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_http_send_is_a_network_flow_with_the_request_as_the_server_received_it() {
    let up = spawn_echo().await;
    let (nc, rec) = netcap();
    let resp = http::send_via(
        hreq(
            "post",
            format!("http://127.0.0.1:{up}/api/v1/items?x=1"),
            &[
                ("Authorization", "Bearer sk-live-SECRET"),
                ("X-Scope", "a"),
                ("X-Scope", "b"),
                ("Content-Type", "application/json"),
            ],
            Some(r#"{"k":"v"}"#),
        ),
        &Tap::of(&nc),
    )
    .await
    .expect("sent");
    assert_eq!(resp.status, 201);
    let received: Vec<(String, String)> = serde_json::from_str(&resp.body).unwrap();

    let f = wait_for(&nc, "done", |f| f.state == FlowState::Done).await;
    assert_eq!(nc.snapshot().len(), 1, "one send, one row");
    assert_eq!(f.proto, FlowProto::Http);
    assert_eq!(f.method, "POST");
    assert_eq!((f.host.as_str(), f.port), ("127.0.0.1", up));
    assert_eq!(f.path, "/api/v1/items?x=1");
    assert_eq!(f.status, Some(201));
    assert_eq!(f.http_version, "HTTP/1.1");
    assert_eq!(f.content_type.as_deref(), Some("application/json"));
    assert_eq!(f.req_bytes, 9);
    assert_eq!(f.res_bytes, resp.size_bytes as u64);
    assert_eq!(
        f.duration_ms,
        Some(resp.duration_ms),
        "the row and the console show the same time"
    );
    assert_eq!(f.error, None);
    assert_api_client(&f);

    let d = nc.flow(f.id).unwrap();
    assert_eq!(
        d.request_headers, received,
        "the row's request headers are what the server received, in order, verbatim"
    );
    assert!(received.contains(&("authorization".into(), "Bearer sk-live-SECRET".into())));
    assert!(received.contains(&("content-length".into(), "9".into())));
    assert_eq!(
        d.request_body.as_ref().unwrap().text.as_deref(),
        Some(r#"{"k":"v"}"#)
    );
    assert!(d
        .response_headers
        .contains(&("x-served-by".into(), "echo".into())));
    assert_eq!(
        d.response_body.as_ref().unwrap().text.as_deref(),
        Some(resp.body.as_str())
    );

    let states = emitted_states(&rec, f.id, FlowState::Done).await;
    assert_eq!(
        states.first(),
        Some(&FlowState::Pending),
        "netcap://flow: {states:?}"
    );
}

/// The reconstruction of what reqwest + hyper add, case by case, against the wire: URL userinfo
/// (reqwest's Basic, and a user `authorization` replacing it in place), a bodiless GET (no
/// `content-length`), an empty-body PUT, and the user's own `accept`/`accept-encoding`/`host`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_reconstructed_request_headers_match_the_wire_in_every_shape() {
    let up = spawn_echo().await;
    let (nc, _) = netcap();
    let cases: Vec<(&str, HttpRequest)> = vec![
        (
            "userinfo, no body",
            hreq(
                "GET",
                format!("http://al%20ice:p%40ss@127.0.0.1:{up}/u"),
                &[],
                None,
            ),
        ),
        (
            "userinfo + own authorization",
            hreq(
                "GET",
                format!("http://user:pw@127.0.0.1:{up}/u2"),
                &[("x-first", "1"), ("authorization", "Bearer mine")],
                None,
            ),
        ),
        (
            "empty-body PUT",
            hreq("PUT", format!("http://127.0.0.1:{up}/e"), &[], Some("")),
        ),
        (
            "own accept, accept-encoding, host",
            hreq(
                "DELETE",
                format!("http://127.0.0.1:{up}/d"),
                &[
                    ("accept", "text/plain"),
                    ("accept-encoding", "identity"),
                    ("host", "example.test"),
                ],
                None,
            ),
        ),
    ];
    for (name, req) in cases {
        let path = format!("/{}", req.url.rsplit('/').next().unwrap());
        let resp = http::send_via(req, &Tap::of(&nc)).await.expect(name);
        let received: Vec<(String, String)> = serde_json::from_str(&resp.body).unwrap();
        let f = wait_for(&nc, name, |f| f.path == path && f.state == FlowState::Done).await;
        assert_eq!(nc.flow(f.id).unwrap().request_headers, received, "{name}");
    }
}

/// reqwest decodes gzip before we see the body: the row shows the DECODED size and body, and the
/// response headers reqwest exposes (no `content-encoding`, so the detail view does not try to
/// decode twice). Documented in `netcap/record.rs`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_compressed_response_is_recorded_decoded() {
    let up = spawn_echo().await;
    let (nc, _) = netcap();
    let resp = http::send_via(
        hreq("GET", format!("http://127.0.0.1:{up}/gzip"), &[], None),
        &Tap::of(&nc),
    )
    .await
    .unwrap();
    assert_eq!(resp.body, r#"{"zipped":true}"#);
    let f = wait_for(&nc, "gzip", |f| f.state == FlowState::Done).await;
    assert_eq!(f.res_bytes, 15, "decoded size");
    let d = nc.flow(f.id).unwrap();
    assert!(!d
        .response_headers
        .iter()
        .any(|(k, _)| k == "content-encoding"));
    assert_eq!(
        d.response_body.unwrap().text.as_deref(),
        Some(r#"{"zipped":true}"#)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_http_send_is_an_error_row_with_the_same_text_and_a_rejected_one_is_no_row() {
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (nc, rec) = netcap();
    let err = http::send_via(
        hreq("GET", format!("http://127.0.0.1:{dead}/x"), &[], None),
        &Tap::of(&nc),
    )
    .await
    .unwrap_err();
    assert!(err.contains("connect"), "{err}");
    let f = wait_for(&nc, "error", |f| f.state == FlowState::Error).await;
    assert_eq!(f.error.as_deref(), Some(err.as_str()));
    assert_eq!((f.status, f.path.as_str()), (None, "/x"));
    assert!(f.duration_ms.is_some());
    assert_api_client(&f);
    emitted_states(&rec, f.id, FlowState::Error).await;

    // Refused before any I/O: nothing left the machine, so there is nothing to show.
    http::send_via(
        hreq(
            "BOGUS METHOD",
            format!("http://127.0.0.1:{dead}/"),
            &[],
            None,
        ),
        &Tap::of(&nc),
    )
    .await
    .unwrap_err();
    assert_eq!(nc.snapshot().len(), 1);
}

// ── WebSocket ────────────────────────────────────────────────────────────────

fn channel() -> Channel<String> {
    Channel::new(|_body: InvokeResponseBody| Ok(()))
}

/// Echo server that records the handshake headers it received. With `require`, a handshake
/// without `authorization: <require>` gets a 401.
async fn spawn_ws(require: Option<&'static str>) -> (u16, Arc<Mutex<Vec<(String, String)>>>) {
    use tokio_tungstenite::tungstenite::handshake::server::{
        ErrorResponse, Request as SReq, Response as SResp,
    };
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let rec = seen.clone();
    tokio::spawn(async move {
        let (s, _) = l.accept().await.unwrap();
        #[allow(clippy::result_large_err)]
        let cb = move |req: &SReq, resp: SResp| -> Result<SResp, ErrorResponse> {
            *rec.lock().unwrap() = req
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
                .collect();
            match require {
                Some(want) if req.headers().get("authorization").is_none_or(|v| v != want) => {
                    let mut e = ErrorResponse::new(Some("go away".into()));
                    *e.status_mut() = hyper::StatusCode::UNAUTHORIZED;
                    Err(e)
                }
                _ => Ok(resp),
            }
        };
        let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(s, cb).await else {
            return;
        };
        while let Some(Ok(m)) = ws.next().await {
            if m.is_text() || m.is_binary() {
                ws.send(m).await.unwrap();
            }
        }
    });
    (port, seen)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_websocket_session_is_one_ws_flow_with_live_counts_then_done_on_close() {
    let (up, seen) = spawn_ws(None).await;
    let (nc, rec) = netcap();
    let id = ws::connect_via(
        format!("ws://127.0.0.1:{up}/chat?room=1"),
        vec![WsHeader {
            name: "Authorization".into(),
            value: "Bearer ws-SECRET".into(),
        }],
        PathBuf::from("no-vault-read.json"),
        channel(),
        Tap::of(&nc),
    );
    let open = wait_for(&nc, "101", |f| f.status == Some(101)).await;
    assert_eq!(open.state, FlowState::Pending, "open socket = pending");
    assert_eq!(open.ws_messages, Some(WsCounts::default()));
    ws::ws_send(id.clone(), "hello".into()).unwrap();
    ws::ws_send(id.clone(), "hi".into()).unwrap();
    let live = wait_for(&nc, "counts", |f| {
        f.ws_messages == Some(WsCounts { up: 2, down: 2 })
    })
    .await;
    assert_eq!(live.state, FlowState::Pending);
    assert_eq!((live.req_bytes, live.res_bytes), (7, 7), "payload bytes");
    ws::ws_close(id).unwrap();

    let f = wait_for(&nc, "closed", |f| f.state == FlowState::Done).await;
    assert_eq!(nc.snapshot().len(), 1);
    assert_eq!(f.proto, FlowProto::Ws);
    assert_eq!(
        (f.method.as_str(), f.path.as_str()),
        ("GET", "/chat?room=1")
    );
    assert_eq!((f.host.as_str(), f.port), ("127.0.0.1", up));
    assert_eq!(f.http_version, "HTTP/1.1");
    assert_eq!(f.ws_messages, Some(WsCounts { up: 2, down: 2 }));
    assert!(f.duration_ms.is_some());
    assert_api_client(&f);

    let d = nc.flow(f.id).unwrap();
    let mut sent = d.request_headers.clone();
    let mut got = seen.lock().unwrap().clone();
    sent.sort();
    got.sort();
    assert_eq!(sent, got, "the handshake as the server received it");
    assert!(got.contains(&("authorization".into(), "Bearer ws-SECRET".into())));
    assert!(d
        .response_headers
        .iter()
        .any(|(k, v)| k == "upgrade" && v == "websocket"));

    let states = emitted_states(&rec, f.id, FlowState::Done).await;
    assert_eq!(states.first(), Some(&FlowState::Pending));
}

/// The 401 case: a rejected handshake is an error row that still
/// shows what the server answered.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejected_websocket_handshake_is_an_error_row_with_the_servers_status() {
    let (up, _) = spawn_ws(Some("Bearer right")).await;
    let (nc, _) = netcap();
    ws::connect_via(
        format!("ws://127.0.0.1:{up}/ws"),
        Vec::new(),
        PathBuf::from("no-vault-read.json"),
        channel(),
        Tap::of(&nc),
    );
    let f = wait_for(&nc, "rejected", |f| f.state == FlowState::Error).await;
    assert_eq!(f.status, Some(401));
    assert!(f.error.as_deref().unwrap().contains("401"), "{f:?}");
    assert_eq!(f.ws_messages, None, "never opened");
    assert_api_client(&f);
    let body = nc.flow(f.id).unwrap().response_body.unwrap();
    assert_eq!(body.text.as_deref(), Some("go away"));
}

// ── gRPC: a hand-rolled h2c server with reflection ──────────────────────────

/// `test.proto`: `service Greeter { rpc SayHello(HelloRequest) returns (HelloReply); }`, one
/// string field each.
fn test_proto() -> Vec<u8> {
    use prost_types::field_descriptor_proto::{Label, Type};
    use prost_types::{
        DescriptorProto, FieldDescriptorProto, FileDescriptorProto, MethodDescriptorProto,
        ServiceDescriptorProto,
    };
    let msg = |name: &str, field: &str| DescriptorProto {
        name: Some(name.into()),
        field: vec![FieldDescriptorProto {
            name: Some(field.into()),
            number: Some(1),
            label: Some(Label::Optional as i32),
            r#type: Some(Type::String as i32),
            json_name: Some(field.into()),
            ..Default::default()
        }],
        ..Default::default()
    };
    FileDescriptorProto {
        name: Some("test.proto".into()),
        package: Some("test".into()),
        syntax: Some("proto3".into()),
        message_type: vec![msg("HelloRequest", "name"), msg("HelloReply", "message")],
        service: vec![ServiceDescriptorProto {
            name: Some("Greeter".into()),
            method: vec![MethodDescriptorProto {
                name: Some("SayHello".into()),
                input_type: Some(".test.HelloRequest".into()),
                output_type: Some(".test.HelloReply".into()),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    }
    .encode_to_vec()
}

/// A gRPC length-prefixed message.
fn frame(msg: &[u8]) -> Bytes {
    let mut out = vec![0u8];
    out.extend_from_slice(&(msg.len() as u32).to_be_bytes());
    out.extend_from_slice(msg);
    Bytes::from(out)
}

/// A one-string-field protobuf message (field 1).
fn string_field(s: &str) -> Vec<u8> {
    let mut out = vec![0x0a, s.len() as u8];
    out.extend_from_slice(s.as_bytes());
    out
}

fn grpc_response(
    data: Option<Bytes>,
    status: &str,
    message: Option<&str>,
    extra: &[(&str, &str)],
) -> Response<UBody> {
    let mut trailers = hyper::HeaderMap::new();
    trailers.insert("grpc-status", status.parse().unwrap());
    if let Some(m) = message {
        trailers.insert("grpc-message", m.parse().unwrap());
    }
    let mut frames: Vec<Result<Frame<Bytes>, Infallible>> = Vec::new();
    if let Some(d) = data {
        frames.push(Ok(Frame::data(d)));
    }
    frames.push(Ok(Frame::trailers(trailers)));
    let mut b = Response::builder()
        .status(200)
        .header("content-type", "application/grpc");
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    b.body(StreamBody::new(futures_util::stream::iter(frames)).boxed_unsync())
        .unwrap()
}

async fn grpc_service(
    req: Request<Incoming>,
    seen: Arc<Mutex<Vec<(String, String)>>>,
) -> Result<Response<UBody>, Infallible> {
    use tonic_reflection::pb::v1::server_reflection_request::MessageRequest;
    use tonic_reflection::pb::v1::server_reflection_response::MessageResponse;
    use tonic_reflection::pb::v1::{
        FileDescriptorResponse, ListServiceResponse, ServerReflectionRequest,
        ServerReflectionResponse, ServiceResponse,
    };
    let path = req.uri().path().to_string();
    let headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
        .collect();
    let body = req.into_body().collect().await.unwrap().to_bytes();
    let msg = body.get(5..).unwrap_or_default();
    Ok(match path.as_str() {
        "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo" => {
            let r = ServerReflectionRequest::decode(msg).unwrap();
            let answer = match r.message_request {
                Some(MessageRequest::ListServices(_)) => {
                    MessageResponse::ListServicesResponse(ListServiceResponse {
                        service: vec![ServiceResponse {
                            name: "test.Greeter".into(),
                        }],
                    })
                }
                _ => MessageResponse::FileDescriptorResponse(FileDescriptorResponse {
                    file_descriptor_proto: vec![test_proto()],
                }),
            };
            let resp = ServerReflectionResponse {
                message_response: Some(answer),
                ..Default::default()
            };
            grpc_response(Some(frame(&resp.encode_to_vec())), "0", None, &[])
        }
        "/test.Greeter/SayHello" => {
            *seen.lock().unwrap() = headers;
            let name = String::from_utf8_lossy(msg.get(2..).unwrap_or_default()).into_owned();
            if name == "bad" {
                grpc_response(None, "3", Some("bad name"), &[])
            } else {
                grpc_response(
                    Some(frame(&string_field(&format!("hi {name}")))),
                    "0",
                    None,
                    &[("x-served-by", "greeter")],
                )
            }
        }
        _ => grpc_response(None, "12", None, &[]),
    })
}

async fn spawn_grpc() -> (u16, Arc<Mutex<Vec<(String, String)>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            let seen = s2.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |r| grpc_service(r, seen.clone()));
                let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                    .serve_connection(TokioIo::new(s), svc)
                    .await;
            });
        }
    });
    (port, seen)
}

fn greq(port: u16, name: &str) -> GrpcRequest {
    GrpcRequest {
        endpoint: format!("127.0.0.1:{port}"),
        service: "test.Greeter".into(),
        method: "SayHello".into(),
        message: format!(r#"{{ "name": "{name}" }}"#),
        metadata: vec![GrpcHeader {
            name: "X-Tenant".into(),
            value: "acme".into(),
        }],
        plaintext: true,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_grpc_send_is_one_grpc_flow_with_status_bodies_and_headers() {
    let (up, seen) = spawn_grpc().await;
    let (nc, rec) = netcap();
    let r = grpc::send_via(greq(up, "ada"), &Tap::of(&nc))
        .await
        .unwrap();
    assert_eq!(
        (r.status_code, r.message.as_str()),
        (0, r#"{"message":"hi ada"}"#)
    );

    let f = wait_for(&nc, "grpc done", |f| f.state == FlowState::Done).await;
    assert_eq!(
        nc.snapshot().len(),
        1,
        "the reflection round-trips are not rows of their own"
    );
    assert_eq!(f.proto, FlowProto::Grpc);
    assert_eq!(f.method, "POST");
    assert_eq!((f.host.as_str(), f.port), ("127.0.0.1", up));
    assert_eq!(f.path, "/test.Greeter/SayHello");
    assert_eq!(f.http_version, "HTTP/2");
    assert_eq!((f.status, f.grpc_status), (Some(200), Some(0)));
    assert_eq!(
        f.req_bytes,
        string_field("ada").len() as u64,
        "protobuf payload"
    );
    assert_eq!(f.res_bytes, string_field("hi ada").len() as u64);
    assert_api_client(&f);

    let d = nc.flow(f.id).unwrap();
    assert_eq!(
        d.request_body.unwrap().text.as_deref(),
        Some(r#"{"name":"ada"}"#),
        "the canonical JSON of what was sent"
    );
    assert_eq!(
        d.response_body.unwrap().text.as_deref(),
        Some(r#"{"message":"hi ada"}"#)
    );
    assert!(d
        .response_headers
        .contains(&("x-served-by".into(), "greeter".into())));
    // Every header the row claims was sent, was received; the only one the server got that the
    // row does not reconstruct is tonic's own user-agent (documented).
    let got = seen.lock().unwrap().clone();
    for h in &d.request_headers {
        assert!(got.contains(h), "{h:?} not received: {got:?}");
    }
    let extra: Vec<&str> = got
        .iter()
        .filter(|h| !d.request_headers.contains(h))
        .map(|(k, _)| k.as_str())
        .collect();
    assert_eq!(extra, ["user-agent"], "{got:?}");
    assert!(d
        .request_headers
        .contains(&("x-tenant".into(), "acme".into())));

    let states = emitted_states(&rec, f.id, FlowState::Done).await;
    assert_eq!(states.first(), Some(&FlowState::Pending));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_grpc_error_status_is_a_done_row_with_its_trailers_and_a_dead_endpoint_an_error_row() {
    let (up, _) = spawn_grpc().await;
    let (nc, _) = netcap();
    let r = grpc::send_via(greq(up, "bad"), &Tap::of(&nc))
        .await
        .unwrap();
    assert_eq!((r.status_code, r.error.as_deref()), (3, Some("bad name")));
    let f = wait_for(&nc, "status 3", |f| f.state == FlowState::Done).await;
    assert_eq!(f.grpc_status, Some(3));
    assert_eq!(f.status, None, "tonic does not expose it; none is invented");
    assert_eq!(f.error, None, "a status is a response");
    let d = nc.flow(f.id).unwrap();
    assert!(d.response_trailers.starts_with(&pairs(&[
        ("grpc-status", "3"),
        ("grpc-message", "bad name")
    ])));

    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let err = grpc::send_via(greq(dead, "x"), &Tap::of(&nc))
        .await
        .unwrap_err();
    let e = wait_for(&nc, "dead", |f| f.state == FlowState::Error).await;
    assert_eq!(e.error.as_deref(), Some(err.as_str()));
    assert_eq!(e.path, "/test.Greeter/SayHello");
    assert_eq!(e.port, dead);
    assert_api_client(&e);
}

/// No store (the app's proxy never started — every `cargo test`): the clients still work and
/// nothing is recorded anywhere.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_no_tap_the_clients_work_and_record_nothing() {
    let up = spawn_echo().await;
    let (nc, _) = netcap();
    let r = http::send_via(
        hreq("GET", format!("http://127.0.0.1:{up}/"), &[], None),
        &Tap::none(),
    )
    .await
    .unwrap();
    assert_eq!(r.status, 201);
    let (gport, _) = spawn_grpc().await;
    assert_eq!(
        grpc::send_via(greq(gport, "n"), &Tap::none())
            .await
            .unwrap()
            .status_code,
        0
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(nc.snapshot().is_empty());
}
