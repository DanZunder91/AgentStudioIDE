//! The WebSocket and gRPC agent tools (`ws_exchange`, `grpc_services`, `grpc_describe`,
//! `grpc_call`) against real servers: the tool path through the dispatcher, the engines'
//! recording into a real `Netcap` (what the Network view shows), the UI event a call sends to
//! History, the bounds (wait, count, bytes, deadlines) on servers built to push each one, and the
//! real `agent-studio` binary end to end.
//!
//! Hermetic: every server is started here on 127.0.0.1 — WebSocket servers with one behaviour
//! each, and a hand-rolled h2c gRPC server that speaks server reflection v1 (tonic's server
//! feature is not in the build; adding it would lock new crates for a test, so the fixture answers
//! the reflection queries and five unary methods itself). Nothing reads or writes the user's
//! config: the tools that need a directory get a temp one, and none of these tools writes.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::agent_ctl::commands::stream;
use agent_studio_scaffold_lib::agent_ctl::registry::Args;
use agent_studio_scaffold_lib::agent_ctl::{self, cli, CtlEvent, CtlResponse, ToolCtx, UiSink};
use agent_studio_scaffold_lib::hook_listener::{CtlFuture, CtlHandler, HookListener};
use agent_studio_scaffold_lib::netcap::record::Tap;
use agent_studio_scaffold_lib::netcap::{
    FlowProto, FlowSink, FlowState, FlowSummary, Netcap, NetcapConfig, WsCounts,
};
use agent_studio_scaffold_lib::ws::{self, Direction, ExchangeEnd, ExchangeSpec, PayloadKind};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage, Value as PValue};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

// ── harness ──────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Events(Mutex<Vec<CtlEvent>>);

impl UiSink for Events {
    fn emit(&self, event: CtlEvent) {
        self.0.lock().unwrap().push(event);
    }
}

impl Events {
    fn all(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|e| serde_json::to_value(e).unwrap())
            .collect()
    }
}

/// A tool context over a temp dir (never the user's config dir), recording UI events.
fn ctx() -> (ToolCtx, Arc<Events>) {
    let events = Arc::new(Events::default());
    let dir = std::env::temp_dir().join(format!("agentstudio-stream-it-{}", ulid::Ulid::new()));
    (
        ToolCtx {
            dir,
            terminal_id: "term-5".into(),
            ui: events.clone(),
        },
        events,
    )
}

async fn handle(ctx: &ToolCtx, tool: &str, args: Value) -> (u16, CtlResponse) {
    let body = serde_json::to_vec(&json!({"tool": tool, "args": args})).unwrap();
    agent_ctl::handle(ctx.clone(), &body).await
}

fn args(v: Value) -> Args {
    Args(v.as_object().unwrap().clone())
}

struct NoFlows;
impl FlowSink for NoFlows {
    fn emit(&self, _flows: &[FlowSummary]) {}
}

/// A real capture store, as the Network view reads it.
fn netcap() -> Netcap {
    Netcap::start(
        NetcapConfig {
            dir: None,
            trust_anchors: Some(Vec::new()),
            user_env: Vec::new(),
            preferred_port: None,
        },
        Arc::new(NoFlows),
    )
    .expect("netcap starts")
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

fn spec(url: String, send: &[&str], wait_ms: u64, max_messages: usize) -> ExchangeSpec {
    ExchangeSpec {
        url,
        headers: Vec::new(),
        send: send.iter().map(|s| s.to_string()).collect(),
        wait: Duration::from_millis(wait_ms),
        max_messages,
        connect_timeout: Duration::from_secs(5),
        send_budget: ws::SEND_BUDGET,
    }
}

// ── WebSocket servers ────────────────────────────────────────────────────────

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// What a test server saw: the handshake's `authorization`, and the close code the client sent.
#[derive(Default)]
struct Seen {
    authorization: Option<String>,
    close_code: Option<u16>,
}

/// A server on 127.0.0.1 that accepts connections and runs `behave` on each socket. With
/// `require`, a handshake without `authorization: <require>` is answered 401.
async fn spawn_ws<F, Fut>(require: Option<&'static str>, behave: F) -> (u16, Arc<Mutex<Seen>>)
where
    F: Fn(Socket, Arc<Mutex<Seen>>) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    use tokio_tungstenite::tungstenite::handshake::server::{
        ErrorResponse, Request as SReq, Response as SResp,
    };
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let s2 = seen.clone();
    let behave = Arc::new(behave);
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let seen = s2.clone();
            let behave = behave.clone();
            tokio::spawn(async move {
                let rec = seen.clone();
                #[allow(clippy::result_large_err)]
                let cb = move |req: &SReq, resp: SResp| -> Result<SResp, ErrorResponse> {
                    let got = req
                        .headers()
                        .get("authorization")
                        .map(|v| v.to_str().unwrap().to_string());
                    rec.lock().unwrap().authorization = got.clone();
                    match require {
                        Some(want) if got.as_deref() != Some(want) => {
                            let mut e = ErrorResponse::new(Some("go away".into()));
                            *e.status_mut() = hyper::StatusCode::UNAUTHORIZED;
                            Err(e)
                        }
                        _ => Ok(resp),
                    }
                };
                if let Ok(ws) = tokio_tungstenite::accept_hdr_async(s, cb).await {
                    behave(ws, seen).await;
                }
            });
        }
    });
    (port, seen)
}

/// Echo every data message; note the client's close code.
async fn echo(mut ws: Socket, seen: Arc<Mutex<Seen>>) {
    while let Some(Ok(m)) = ws.next().await {
        match m {
            Message::Text(_) | Message::Binary(_) => {
                if ws.send(m).await.is_err() {
                    return;
                }
            }
            Message::Close(frame) => {
                seen.lock().unwrap().close_code = frame.map(|f| u16::from(f.code));
                let _ = ws.close(None).await;
                return;
            }
            _ => {}
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exchange_sends_in_order_collects_the_answers_closes_cleanly_and_is_a_network_row() {
    let (port, seen) = spawn_ws(None, echo).await;
    let nc = netcap();
    let url = format!("ws://127.0.0.1:{port}/chat?room=1");
    let t = ws::exchange(spec(url, &["hello", "world"], 300, 50), &Tap::of(&nc))
        .await
        .unwrap();

    let texts = |d: Direction| -> Vec<String> {
        t.entries
            .iter()
            .filter(|e| e.direction == d)
            .map(|e| e.text.clone().unwrap())
            .collect()
    };
    assert_eq!(texts(Direction::Sent), ["hello", "world"], "sent in order");
    assert_eq!(
        texts(Direction::Received),
        ["hello", "world"],
        "collected in order"
    );
    let first_reply = t
        .entries
        .iter()
        .position(|e| e.direction == Direction::Received)
        .unwrap();
    assert_eq!(
        t.entries[0].direction,
        Direction::Sent,
        "nothing came before the first send"
    );
    assert!(first_reply >= 1);
    assert!(
        t.entries.windows(2).all(|w| w[0].at_ms <= w[1].at_ms),
        "the transcript is in time order: {:?}",
        t.entries
    );
    assert_eq!((t.sent, t.unsent, t.received), (2, 0, 2));
    assert_eq!(t.end, ExchangeEnd::Waited);
    assert!(t
        .entries
        .iter()
        .all(|e| !e.truncated && e.kind == PayloadKind::Text));

    // The client closed with a normal close the server saw.
    for _ in 0..100 {
        if seen.lock().unwrap().close_code.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(seen.lock().unwrap().close_code, Some(1000));

    // One ws row, done, with the counts and payload bytes of what went both ways.
    let f = wait_for(&nc, "done", |f| f.state == FlowState::Done).await;
    assert_eq!(nc.snapshot().len(), 1);
    assert_eq!(f.proto, FlowProto::Ws);
    assert_eq!(f.path, "/chat?room=1");
    assert_eq!(f.status, Some(101));
    assert_eq!(f.ws_messages, Some(WsCounts { up: 2, down: 2 }));
    assert_eq!((f.req_bytes, f.res_bytes), (10, 10));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_tool_answers_with_a_readable_transcript_and_records_its_session() {
    let (port, _) = spawn_ws(None, echo).await;
    let (ctx, events) = ctx();
    let (status, r) = handle(
        &ctx,
        "ws_exchange",
        json!({"url": format!("ws://127.0.0.1:{port}/"), "send": ["ping \"1\""], "wait_ms": 200}),
    )
    .await;
    assert_eq!(status, 200, "{}", r.message);
    let lines: Vec<&str> = r.message.lines().collect();
    assert!(
        lines[0].starts_with(&format!("WebSocket ws://127.0.0.1:{port}/: opened in ")),
        "{}",
        r.message
    );
    assert!(lines[0].ends_with(
        "sent 1; received 1 message; listened 200 ms after the last send, then Agent Studio \
         closed the socket."
    ));
    assert!(lines[1].ends_with(r#"→ "ping \"1\"""#), "{}", lines[1]);
    assert!(lines[2].ends_with(r#"← "ping \"1\"""#), "{}", lines[2]);
    assert_eq!(r.data["received"], 1);
    assert_eq!(r.data["end"], json!({"kind": "waited"}));
    assert_eq!(r.data["entries"][1]["direction"], "received");
    assert_eq!(r.data["truncated"], false);
    assert!(
        events.all().is_empty(),
        "the Network row is the exchange's trace"
    );

    // The tool records on the tap it is given (the app passes the Network view's).
    let nc = netcap();
    let a = args(json!({"url": format!("ws://127.0.0.1:{port}/t"), "send": ["x"], "wait_ms": 100}));
    stream::ws_exchange_with(&a, &Tap::of(&nc)).await.unwrap();
    let f = wait_for(&nc, "tool row", |f| f.state == FlowState::Done).await;
    assert_eq!((f.proto, f.path.as_str()), (FlowProto::Ws, "/t"));
    assert_eq!(f.ws_messages, Some(WsCounts { up: 1, down: 1 }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_server_that_speaks_first_binary_by_size_and_long_text_cut_and_marked() {
    let (port, _) = spawn_ws(None, |mut ws: Socket, _| async move {
        ws.send(Message::Text("welcome".into())).await.unwrap();
        ws.send(Message::Binary(vec![1u8, 2, 3].into()))
            .await
            .unwrap();
        ws.send(Message::Text("é".repeat(5000).into()))
            .await
            .unwrap();
        while let Some(Ok(m)) = ws.next().await {
            if m.is_close() {
                break;
            }
        }
    })
    .await;
    let (ctx, _) = ctx();
    let (status, r) = handle(
        &ctx,
        "ws_exchange",
        json!({"url": format!("ws://127.0.0.1:{port}/"), "wait_ms": 400}),
    )
    .await;
    assert_eq!(status, 200, "{}", r.message);
    let e = r.data["entries"].as_array().unwrap();
    assert_eq!(e.len(), 3);
    assert_eq!(e[0]["text"], "welcome");
    assert_eq!(
        (e[1]["kind"].as_str(), e[1]["bytes"].as_u64(), &e[1]["text"]),
        (Some("binary"), Some(3), &Value::Null)
    );
    let long = e[2]["text"].as_str().unwrap();
    assert!(long.len() <= ws::PREVIEW_BYTES && long.len() > ws::PREVIEW_BYTES - 2);
    assert!(
        long.chars().all(|c| c == 'é'),
        "cut on a character boundary"
    );
    assert_eq!(e[2]["truncated"], true);
    assert_eq!(e[2]["bytes"], 10_000);
    assert_eq!(r.data["truncated"], true);
    assert!(r.message.contains("← binary, 3 bytes"));
    assert!(r.message.contains("… (cut; 10000 bytes in all)"));
    assert!(r.message.contains("Text is cut at 4 KiB per message"));
}

/// A flood: the count stops it, and the transcript keeps no more text than its budget.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_flood_is_stopped_by_the_count_and_the_text_budget() {
    let (port, _) = spawn_ws(None, |mut ws: Socket, _| async move {
        let chunk = "a".repeat(ws::PREVIEW_BYTES);
        for _ in 0..2000 {
            if ws.send(Message::Text(chunk.clone().into())).await.is_err() {
                return;
            }
        }
    })
    .await;
    let started = Instant::now();
    let t = ws::exchange(
        spec(format!("ws://127.0.0.1:{port}/"), &[], 5_000, 100),
        &Tap::none(),
    )
    .await
    .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the count, not the wait, ended it"
    );
    assert_eq!(t.end, ExchangeEnd::MaxMessages);
    assert_eq!(t.received, 100);
    assert_eq!(t.entries.len(), 100);
    let kept: usize = t
        .entries
        .iter()
        .filter_map(|e| e.text.as_ref())
        .map(String::len)
        .sum();
    assert_eq!(kept, ws::TRANSCRIPT_TEXT_BYTES);
    let full = ws::TRANSCRIPT_TEXT_BYTES / ws::PREVIEW_BYTES;
    assert!(t.entries[..full]
        .iter()
        .all(|e| e.text.is_some() && !e.truncated));
    assert!(t.entries[full..]
        .iter()
        .all(|e| e.text.is_none() && e.truncated));

    let message = stream::ws_message("ws://h/", 5000, 100, &t);
    assert!(message.contains("stopped at 100 messages (--max-messages)"));
    assert!(message.contains("(not kept: the transcript's text limit is reached)"));
    assert!(
        message.len() < ws::TRANSCRIPT_TEXT_BYTES * 2 + 64 * 1024,
        "{}",
        message.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_server_close_is_reported_with_its_code_and_reason() {
    let (port, _) = spawn_ws(None, |mut ws: Socket, _| async move {
        if let Some(Ok(_)) = ws.next().await {
            let _ = ws
                .close(Some(CloseFrame {
                    code: CloseCode::Library(4001),
                    reason: "bye".into(),
                }))
                .await;
            while let Some(Ok(_)) = ws.next().await {}
        }
    })
    .await;
    let nc = netcap();
    let t = ws::exchange(
        spec(format!("ws://127.0.0.1:{port}/"), &["one"], 5_000, 50),
        &Tap::of(&nc),
    )
    .await
    .unwrap();
    assert_eq!(
        t.end,
        ExchangeEnd::ServerClosed {
            code: Some(4001),
            reason: "bye".into()
        }
    );
    let f = wait_for(&nc, "closed", |f| f.state == FlowState::Done).await;
    assert_eq!(f.error, None, "a close is not an error");
    let m = stream::ws_message("ws://h/", 5000, 50, &t);
    assert!(
        m.contains("the server closed the socket with code 4001 (\"bye\")"),
        "{m}"
    );
}

/// A server that never reads: the sends stall, and the exchange still ends at the send budget,
/// says so, and settles its Network row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_server_that_stops_reading_cannot_hold_the_exchange() {
    let (port, _) = spawn_ws(None, |ws: Socket, _| async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        drop(ws);
    })
    .await;
    let nc = netcap();
    let big = "s".repeat(1024 * 1024);
    let sends: Vec<&str> = vec![big.as_str(); 64];
    let mut s = spec(format!("ws://127.0.0.1:{port}/"), &sends, 100, 50);
    s.send_budget = Duration::from_millis(300);
    let started = Instant::now();
    let t = ws::exchange(s, &Tap::of(&nc)).await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(t.end, ExchangeEnd::SendStalled);
    assert!(t.unsent > 0, "{t:?}");
    assert_eq!(t.sent + t.unsent, 64);
    let f = wait_for(&nc, "settled", |f| f.state != FlowState::Pending).await;
    assert_eq!(f.state, FlowState::Done);
    let m = stream::ws_message("ws://h/", 100, 50, &t);
    assert!(m.contains("NOT sent"), "{m}");
    assert!(m.contains("the server stopped reading"), "{m}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_wait_bounds_a_silent_server() {
    let (port, _) = spawn_ws(None, |mut ws: Socket, _| async move {
        while let Some(Ok(m)) = ws.next().await {
            if m.is_close() {
                let _ = ws.close(None).await;
                break;
            }
        }
    })
    .await;
    let started = Instant::now();
    let t = ws::exchange(
        spec(format!("ws://127.0.0.1:{port}/"), &["anyone?"], 200, 50),
        &Tap::none(),
    )
    .await
    .unwrap();
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(200) && took < Duration::from_secs(3),
        "{took:?}"
    );
    assert_eq!((t.end, t.sent, t.received), (ExchangeEnd::Waited, 1, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handshake_header_reaches_the_server_and_a_rejection_is_explained() {
    let (port, seen) = spawn_ws(Some("Bearer right"), echo).await;
    let (ctx, _) = ctx();
    let url = format!("ws://127.0.0.1:{port}/secure");
    let (status, r) = handle(
        &ctx,
        "ws_exchange",
        json!({"url": url, "header": ["Authorization: Bearer right"], "wait_ms": 50}),
    )
    .await;
    assert_eq!(status, 200, "{}", r.message);
    assert_eq!(
        seen.lock().unwrap().authorization.as_deref(),
        Some("Bearer right")
    );

    let (status, r) = handle(&ctx, "ws_exchange", json!({"url": url, "wait_ms": 50})).await;
    assert_eq!(status, 422);
    assert!(
        r.message
            .starts_with(&format!("Could not open a WebSocket to {url}: "))
            && r.message.contains("401"),
        "{}",
        r.message
    );

    let (status, r) = handle(
        &ctx,
        "ws_exchange",
        json!({"url": url, "header": ["Host: elsewhere"]}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(
        r.message
            .contains("written by the WebSocket handshake itself"),
        "{}",
        r.message
    );
}

/// A server that accepts TCP but never answers the upgrade: the handshake deadline ends it and
/// the Network row is settled as an error, never left pending.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handshake_that_never_completes_times_out_and_settles_its_row() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = l.accept().await {
            held.push(s);
        }
    });
    let nc = netcap();
    let mut s = spec(format!("ws://127.0.0.1:{port}/"), &[], 100, 50);
    s.connect_timeout = Duration::from_millis(300);
    let started = Instant::now();
    // The outer timeout turns a broken deadline into a failure instead of a hung test.
    let err = tokio::time::timeout(Duration::from_secs(5), ws::exchange(s, &Tap::of(&nc)))
        .await
        .expect("the handshake deadline must end the exchange")
        .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(err, "the WebSocket handshake did not finish within 300 ms");
    let f = wait_for(&nc, "error row", |f| f.state == FlowState::Error).await;
    assert_eq!(f.error.as_deref(), Some(err.as_str()));
}

// ── gRPC: a hand-rolled h2c server with reflection v1 ────────────────────────

mod proto {
    use prost_types::field_descriptor_proto::{Label, Type};
    use prost_types::{
        DescriptorProto, EnumDescriptorProto, EnumValueDescriptorProto, FieldDescriptorProto,
        FileDescriptorProto, MessageOptions, MethodDescriptorProto, OneofDescriptorProto,
        ServiceDescriptorProto,
    };

    fn field(
        name: &str,
        json: &str,
        n: i32,
        ty: Type,
        type_name: Option<&str>,
    ) -> FieldDescriptorProto {
        FieldDescriptorProto {
            name: Some(name.into()),
            json_name: Some(json.into()),
            number: Some(n),
            label: Some(Label::Optional as i32),
            r#type: Some(ty as i32),
            type_name: type_name.map(str::to_string),
            ..Default::default()
        }
    }

    fn message(name: &str, field: Vec<FieldDescriptorProto>) -> DescriptorProto {
        DescriptorProto {
            name: Some(name.into()),
            field,
            ..Default::default()
        }
    }

    fn method(name: &str, server_streaming: bool) -> MethodDescriptorProto {
        MethodDescriptorProto {
            name: Some(name.into()),
            input_type: Some(".test.v1.EchoRequest".into()),
            output_type: Some(".test.v1.EchoReply".into()),
            server_streaming: Some(server_streaming),
            ..Default::default()
        }
    }

    pub const TIMESTAMP_FILE: &str = "google/protobuf/timestamp.proto";
    pub const ECHO_FILE: &str = "test/v1/echo.proto";

    pub fn timestamp() -> FileDescriptorProto {
        FileDescriptorProto {
            name: Some(TIMESTAMP_FILE.into()),
            package: Some("google.protobuf".into()),
            syntax: Some("proto3".into()),
            message_type: vec![message(
                "Timestamp",
                vec![
                    field("seconds", "seconds", 1, Type::Int64, None),
                    field("nanos", "nanos", 2, Type::Int32, None),
                ],
            )],
            ..Default::default()
        }
    }

    /// `test.v1.Echo`: Say, Fail, Big, Slow (unary) and Watch (server streaming), over a request
    /// with every kind of field and an import.
    pub fn echo() -> FileDescriptorProto {
        let mut repeated = field("tags", "tags", 3, Type::String, None);
        repeated.label = Some(Label::Repeated as i32);
        let mut map = field(
            "scores",
            "scores",
            4,
            Type::Message,
            Some(".test.v1.EchoRequest.ScoresEntry"),
        );
        map.label = Some(Label::Repeated as i32);
        let mut pick_a = field("pick_a", "pickA", 8, Type::String, None);
        pick_a.oneof_index = Some(0);
        let mut pick_b = field("pick_b", "pickB", 9, Type::Int64, None);
        pick_b.oneof_index = Some(0);
        let mut request = message(
            "EchoRequest",
            vec![
                field("text", "text", 1, Type::String, None),
                field("count", "count", 2, Type::Int32, None),
                repeated,
                map,
                field("kind", "kind", 5, Type::Enum, Some(".test.v1.Kind")),
                field("inner", "inner", 6, Type::Message, Some(".test.v1.Inner")),
                field(
                    "when",
                    "when",
                    7,
                    Type::Message,
                    Some(".google.protobuf.Timestamp"),
                ),
                pick_a,
                pick_b,
            ],
        );
        request.nested_type = vec![DescriptorProto {
            name: Some("ScoresEntry".into()),
            field: vec![
                field("key", "key", 1, Type::String, None),
                field("value", "value", 2, Type::Int64, None),
            ],
            options: Some(MessageOptions {
                map_entry: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        }];
        request.oneof_decl = vec![OneofDescriptorProto {
            name: Some("pick".into()),
            ..Default::default()
        }];
        FileDescriptorProto {
            name: Some(ECHO_FILE.into()),
            package: Some("test.v1".into()),
            syntax: Some("proto3".into()),
            dependency: vec![TIMESTAMP_FILE.into()],
            message_type: vec![
                request,
                message(
                    "EchoReply",
                    vec![
                        field("text", "text", 1, Type::String, None),
                        field("count", "count", 2, Type::Int32, None),
                    ],
                ),
                message(
                    "Inner",
                    vec![
                        field("note", "note", 1, Type::String, None),
                        field("child", "child", 2, Type::Message, Some(".test.v1.Inner")),
                    ],
                ),
            ],
            enum_type: vec![EnumDescriptorProto {
                name: Some("Kind".into()),
                value: ["KIND_UNSPECIFIED", "KIND_A"]
                    .iter()
                    .enumerate()
                    .map(|(i, n)| EnumValueDescriptorProto {
                        name: Some((*n).into()),
                        number: Some(i as i32),
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }],
            service: vec![ServiceDescriptorProto {
                name: Some("Echo".into()),
                method: vec![
                    method("Say", false),
                    method("Fail", false),
                    method("Big", false),
                    method("Slow", false),
                    method("Watch", true),
                ],
                ..Default::default()
            }],
            ..Default::default()
        }
    }
}

type UBody = UnsyncBoxBody<Bytes, Infallible>;

fn frame(msg: &[u8]) -> Bytes {
    let mut out = vec![0u8];
    out.extend_from_slice(&(msg.len() as u32).to_be_bytes());
    out.extend_from_slice(msg);
    Bytes::from(out)
}

fn grpc_response(
    data: Option<Bytes>,
    trailers: &[(&str, &str)],
    headers: &[(&str, String)],
) -> Response<UBody> {
    let mut t = hyper::HeaderMap::new();
    for (k, v) in trailers {
        t.insert(
            hyper::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            v.parse().unwrap(),
        );
    }
    let mut frames: Vec<Result<Frame<Bytes>, Infallible>> = Vec::new();
    if let Some(d) = data {
        frames.push(Ok(Frame::data(d)));
    }
    frames.push(Ok(Frame::trailers(t)));
    let mut b = Response::builder()
        .status(200)
        .header("content-type", "application/grpc");
    for (k, v) in headers {
        b = b.header(*k, v.as_str());
    }
    b.body(StreamBody::new(futures_util::stream::iter(frames)).boxed_unsync())
        .unwrap()
}

/// The symbols the reflection fixture finds a file for. Methods are not among them, as on servers
/// that only index types: a dotted method name has to be found through its service.
const KNOWN: [&str; 5] = [
    "test.v1.Echo",
    "test.v1.EchoRequest",
    "test.v1.EchoReply",
    "test.v1.Inner",
    "test.v1.Kind",
];

fn reflection_answer(msg: &[u8]) -> Bytes {
    use tonic_reflection::pb::v1::server_reflection_request::MessageRequest;
    use tonic_reflection::pb::v1::server_reflection_response::MessageResponse;
    use tonic_reflection::pb::v1::{
        ErrorResponse, FileDescriptorResponse, ListServiceResponse, ServerReflectionRequest,
        ServerReflectionResponse, ServiceResponse,
    };
    let file = |f: prost_types::FileDescriptorProto| {
        MessageResponse::FileDescriptorResponse(FileDescriptorResponse {
            file_descriptor_proto: vec![f.encode_to_vec()],
        })
    };
    let not_found = || {
        MessageResponse::ErrorResponse(ErrorResponse {
            error_code: 5,
            error_message: "not found".into(),
        })
    };
    let r = ServerReflectionRequest::decode(msg).unwrap();
    let answer = match r.message_request {
        Some(MessageRequest::ListServices(_)) => {
            MessageResponse::ListServicesResponse(ListServiceResponse {
                service: ["test.v1.Echo", "grpc.reflection.v1.ServerReflection"]
                    .iter()
                    .map(|n| ServiceResponse { name: (*n).into() })
                    .collect(),
            })
        }
        // Only the file itself: its import is chased by name.
        Some(MessageRequest::FileContainingSymbol(s)) if KNOWN.contains(&s.as_str()) => {
            file(proto::echo())
        }
        Some(MessageRequest::FileByFilename(f)) if f == proto::TIMESTAMP_FILE => {
            file(proto::timestamp())
        }
        Some(MessageRequest::FileByFilename(f)) if f == proto::ECHO_FILE => file(proto::echo()),
        _ => not_found(),
    };
    let resp = ServerReflectionResponse {
        message_response: Some(answer),
        ..Default::default()
    };
    frame(&resp.encode_to_vec())
}

fn server_pool() -> DescriptorPool {
    let mut pool = DescriptorPool::new();
    pool.add_file_descriptor_protos([proto::timestamp(), proto::echo()])
        .unwrap();
    pool
}

/// `EchoReply { text, count }`.
fn reply(pool: &DescriptorPool, text: &str, count: i32) -> Bytes {
    let mut m = DynamicMessage::new(pool.get_message_by_name("test.v1.EchoReply").unwrap());
    m.set_field_by_name("text", PValue::String(text.into()));
    m.set_field_by_name("count", PValue::I32(count));
    frame(&m.encode_to_vec())
}

async fn grpc_service(req: Request<Incoming>) -> Result<Response<UBody>, Infallible> {
    let pool = server_pool();
    let path = req.uri().path().to_string();
    let tenant = req
        .headers()
        .get("x-tenant")
        .map(|v| v.to_str().unwrap().to_string());
    let body = req.into_body().collect().await.unwrap().to_bytes();
    let msg = body.get(5..).unwrap_or_default();
    let ok = [("grpc-status", "0")];
    Ok(match path.as_str() {
        "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo" => {
            grpc_response(Some(reflection_answer(msg)), &ok, &[])
        }
        "/test.v1.Echo/Say" => {
            let input = DynamicMessage::decode(
                pool.get_message_by_name("test.v1.EchoRequest").unwrap(),
                msg,
            )
            .unwrap();
            let text = input
                .get_field_by_name("text")
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            let count = input
                .get_field_by_name("count")
                .and_then(|v| v.as_i32())
                .unwrap_or(0);
            let mut headers = Vec::new();
            if let Some(t) = tenant {
                headers.push(("x-tenant-seen", t));
            }
            grpc_response(
                Some(reply(&pool, &text.repeat(count.max(1) as usize), count)),
                &ok,
                &headers,
            )
        }
        "/test.v1.Echo/Fail" => grpc_response(
            None,
            &[
                ("grpc-status", "5"),
                ("grpc-message", "no such echo"),
                ("x-debug", "trail"),
            ],
            &[],
        ),
        "/test.v1.Echo/Big" => {
            grpc_response(Some(reply(&pool, &"b".repeat(100 * 1024), 1)), &ok, &[])
        }
        "/test.v1.Echo/Slow" => {
            tokio::time::sleep(Duration::from_secs(3)).await;
            grpc_response(Some(reply(&pool, "late", 1)), &ok, &[])
        }
        _ => grpc_response(None, &[("grpc-status", "12")], &[]),
    })
}

async fn spawn_grpc() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            tokio::spawn(async move {
                let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                    .serve_connection(TokioIo::new(s), service_fn(grpc_service))
                    .await;
            });
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn services_are_listed_with_their_signatures_through_reflection() {
    let port = spawn_grpc().await;
    let (ctx, events) = ctx();
    let (status, r) = handle(
        &ctx,
        "grpc_services",
        json!({"target": format!("http://127.0.0.1:{port}")}),
    )
    .await;
    assert_eq!(status, 200, "{}", r.message);
    let lines: Vec<&str> = r.message.lines().collect();
    assert_eq!(
        lines[0],
        format!("2 services at 127.0.0.1:{port} (plaintext):")
    );
    assert_eq!(lines[1], "  test.v1.Echo");
    assert_eq!(
        lines[2],
        "    rpc test.v1.Echo/Say(test.v1.EchoRequest) returns (test.v1.EchoReply)"
    );
    assert!(r.message.contains(
        "rpc test.v1.Echo/Watch(test.v1.EchoRequest) returns (stream test.v1.EchoReply)  \
         [streaming: not callable with grpc call]"
    ));
    assert!(r.message.contains(
        "  grpc.reflection.v1.ServerReflection\n    (the server did not describe its methods)"
    ));
    assert_eq!(
        r.data["services"][0]["methods"].as_array().unwrap().len(),
        5
    );
    assert_eq!(r.data["services"][1]["described"], false);
    assert!(events.all().is_empty(), "a read emits nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn describe_finds_every_form_and_its_example_is_a_request_the_server_accepts() {
    let port = spawn_grpc().await;
    let (ctx, _) = ctx();
    let target = format!("127.0.0.1:{port}");
    let describe = |name: &str| {
        let ctx = ctx.clone();
        let a = json!({"target": target, "name": name, "plaintext": true});
        async move { handle(&ctx, "grpc_describe", a).await }
    };

    let (status, r) = describe("test.v1.Echo/Say").await;
    assert_eq!(status, 200, "{}", r.message);
    assert!(r
        .message
        .starts_with("rpc test.v1.Echo/Say(test.v1.EchoRequest) returns (test.v1.EchoReply)"));
    assert!(
        r.message
            .contains("  when: google.protobuf.Timestamp (JSON: an RFC 3339 string)"),
        "the import was chased"
    );
    assert!(r
        .message
        .contains("  scores: map<string, int64 (JSON: a string of digits)>"));
    assert_eq!(r.data["name"], "test.v1.Echo/Say");
    let example = r.data["methods"][0]["requestExample"].clone();
    assert!(example.is_object());

    // Dotted: found through its service, because the server does not index methods.
    let (status, dotted) = describe("test.v1.Echo.Say").await;
    assert_eq!(status, 200, "{}", dotted.message);
    assert_eq!(dotted.data["methods"], r.data["methods"]);

    let (status, svc) = describe("test.v1.Echo").await;
    assert_eq!(status, 200);
    assert!(svc.message.starts_with("service test.v1.Echo (5 methods)"));
    let (status, msg) = describe("test.v1.Inner").await;
    assert_eq!(status, 200);
    assert!(msg.message.starts_with("message test.v1.Inner {"));
    let (status, en) = describe("test.v1.Kind").await;
    assert_eq!(status, 200);
    assert!(en
        .message
        .starts_with("enum test.v1.Kind { KIND_UNSPECIFIED | KIND_A }"));

    let (status, none) = describe("test.v1.Nope").await;
    assert_eq!(status, 422);
    assert!(
        none.message
            .starts_with(&format!("{target} does not describe `test.v1.Nope` (")),
        "{}",
        none.message
    );
    assert!(none
        .message
        .contains(&format!("agent-studio grpc services {target} --plaintext")));

    // The example, sent as is, is a request the server's own method parses and answers.
    let (status, called) = handle(
        &ctx,
        "grpc_call",
        json!({"target": target, "method": "test.v1.Echo/Say", "body": example, "plaintext": true}),
    )
    .await;
    assert_eq!(status, 200, "{}", called.message);
    assert_eq!(called.data["statusCode"], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_call_returns_status_metadata_and_json_and_shows_in_network_and_history() {
    let port = spawn_grpc().await;
    let (ctx, events) = ctx();
    let nc = netcap();
    let a = args(json!({
        "target": format!("127.0.0.1:{port}"),
        "method": "test.v1.Echo/Say",
        "body": {"text": "hi", "count": 2},
        "header": ["X-Tenant: acme"],
        "plaintext": true,
    }));
    let r = stream::grpc_call_with(&ctx, &a, &Tap::of(&nc))
        .await
        .unwrap();
    let head = format!("gRPC test.v1.Echo/Say at 127.0.0.1:{port} (plaintext): OK, in ");
    assert!(r.message.starts_with(&head), "{}", r.message);
    assert!(r.message.contains("Response metadata:\n"));
    assert!(
        r.message.contains("  x-tenant-seen: acme\n"),
        "{}",
        r.message
    );
    assert!(
        r.message
            .ends_with("Response:\n{\n  \"count\": 2,\n  \"text\": \"hihi\"\n}"),
        "{}",
        r.message
    );
    assert_eq!(r.data["response"], json!({"text": "hihi", "count": 2}));
    assert!(r.data["metadata"]
        .as_array()
        .unwrap()
        .contains(&json!({"name": "x-tenant-seen", "value": "acme", "truncated": false})));
    assert!(
        !r.message.contains("grpc-status"),
        "the status is the status line, not metadata: {}",
        r.message
    );

    // The Network view: one grpc row, as the console's call would be.
    let f = wait_for(&nc, "grpc done", |f| f.state == FlowState::Done).await;
    assert_eq!(nc.snapshot().len(), 1);
    assert_eq!(
        (f.proto, f.path.as_str(), f.grpc_status),
        (FlowProto::Grpc, "/test.v1.Echo/Say", Some(0))
    );

    // History: the UI hears the call, with what it needs for an entry.
    let e = events.all();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["kind"], "grpcCall");
    assert_eq!(e[0]["terminalId"], "term-5");
    assert_eq!(e[0]["target"], format!("127.0.0.1:{port}"));
    assert_eq!(
        (e[0]["service"].as_str(), e[0]["method"].as_str()),
        (Some("test.v1.Echo"), Some("Say"))
    );
    assert_eq!(e[0]["body"], r#"{"count":2,"text":"hi"}"#);
    assert_eq!(
        e[0]["headers"],
        json!([{"name": "X-Tenant", "value": "acme"}])
    );
    assert_eq!(
        (e[0]["statusCode"].as_u64(), e[0]["statusName"].as_str()),
        (Some(0), Some("OK"))
    );
    assert_eq!(e[0]["error"], Value::Null);
    assert_eq!(e[0]["transportError"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_status_is_an_answer_a_big_response_is_cut_and_a_stream_is_refused() {
    let port = spawn_grpc().await;
    let (ctx, events) = ctx();
    let call = |method: &str| {
        let ctx = ctx.clone();
        let a = json!({"target": format!("http://127.0.0.1:{port}"), "method": method});
        async move { handle(&ctx, "grpc_call", a).await }
    };

    let (status, r) = call("test.v1.Echo/Fail").await;
    assert_eq!(status, 200, "a gRPC status is an answer: {}", r.message);
    assert!(
        r.message.contains(": NotFound (5): no such echo, in "),
        "{}",
        r.message
    );
    assert!(r.message.contains("  x-debug: trail"), "{}", r.message);
    assert!(!r.message.contains("Response:"));
    assert_eq!(
        (r.data["statusCode"].as_u64(), r.data["error"].as_str()),
        (Some(5), Some("no such echo"))
    );

    let (status, r) = call("test.v1.Echo/Big").await;
    assert_eq!(status, 200, "{}", r.message);
    assert_eq!(r.data["truncated"], true);
    assert_eq!(r.data["response"], Value::Null);
    assert!(r.data["responseBytes"].as_u64().unwrap() > 100 * 1024);
    assert!(r.message.contains("only the first 64 KiB are shown"));
    assert!(r.message.len() < stream::RESPONSE_TEXT_BYTES + 4096);

    let (status, r) = call("test.v1.Echo/Watch").await;
    assert_eq!(status, 422);
    assert!(r.message.contains("is a streaming method"), "{}", r.message);

    let statuses: Vec<Value> = events
        .all()
        .iter()
        .map(|e| e["statusCode"].clone())
        .collect();
    assert_eq!(
        statuses,
        [json!(5), json!(0), Value::Null],
        "each call reached History"
    );
}

/// The deadline covers the whole call, and the abandoned call's Network row is settled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_call_is_abandoned_at_its_deadline_and_its_row_settles() {
    let port = spawn_grpc().await;
    let (ctx, events) = ctx();
    let nc = netcap();
    let a = args(json!({
        "target": format!("127.0.0.1:{port}"),
        "method": "test.v1.Echo/Slow",
        "plaintext": true,
        "timeout_ms": 400,
    }));
    let started = Instant::now();
    let err = stream::grpc_call_with(&ctx, &a, &Tap::of(&nc))
        .await
        .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "{:?}",
        started.elapsed()
    );
    assert!(err.contains("no answer within 400 ms"), "{err}");
    let f = wait_for(&nc, "settled", |f| f.state != FlowState::Pending).await;
    assert_eq!(f.state, FlowState::Error);
    assert!(f
        .error
        .as_deref()
        .unwrap()
        .contains("no answer within 400 ms"));
    let e = events.all();
    assert!(e[0]["transportError"].as_str().unwrap().contains("400 ms"));
}

/// A deadline that passes on our side — here the request's own `grpc-timeout`, which tonic
/// enforces in the client and reports as a `Cancelled` status — is the call's timeout, not a
/// status a server sent: the tool fails, the Network row is an error with no gRPC status, and
/// History hears a transport error.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deadline_that_passes_on_our_side_is_a_timeout_not_a_server_status() {
    let port = spawn_grpc().await;
    let (ctx, events) = ctx();
    let nc = netcap();
    let a = args(json!({
        "target": format!("127.0.0.1:{port}"),
        "method": "test.v1.Echo/Slow",
        "header": ["grpc-timeout: 200m"],
        "plaintext": true,
        "timeout_ms": 10_000,
    }));
    let started = Instant::now();
    let err = stream::grpc_call_with(&ctx, &a, &Tap::of(&nc))
        .await
        .expect_err("a deadline is not an answer");
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "{:?}",
        started.elapsed()
    );
    assert!(
        err.contains("no answer before the request's deadline"),
        "{err}"
    );
    let f = wait_for(&nc, "settled", |f| f.state != FlowState::Pending).await;
    assert_eq!(f.state, FlowState::Error);
    assert_eq!(f.grpc_status, None, "no server sent a status");
    let e = events.all();
    assert_eq!(e[0]["statusCode"], Value::Null);
    assert!(e[0]["transportError"]
        .as_str()
        .unwrap()
        .contains("deadline"));
}

// ── the real binary, end to end ──────────────────────────────────────────────

/// The listener's `/ctl` route over the real dispatcher, as the app wires it.
fn start_listener() -> cli::CtlEnv {
    let (listener, config) = HookListener::bind().expect("bind");
    let (ctx, _) = ctx();
    let on_ctl: Arc<CtlHandler> = Arc::new(move |terminal_id: String, body: Vec<u8>| {
        let ctx = ToolCtx {
            terminal_id,
            ..ctx.clone()
        };
        Box::pin(async move {
            let (status, response) = agent_ctl::handle(ctx, &body).await;
            (status, serde_json::to_vec(&response).unwrap())
        }) as CtlFuture
    });
    listener.serve_with_ctl(|_, _| {}, Some(on_ctl));
    cli::CtlEnv {
        url: config.base_url,
        token: config.token,
        terminal_id: "term-6".into(),
    }
}

async fn run_binary(env: &cli::CtlEnv, words: &[&str]) -> std::process::Output {
    let exe = env!("CARGO_BIN_EXE_agent-studio-scaffold");
    let words: Vec<String> = words.iter().map(|s| s.to_string()).collect();
    let env = env.clone();
    tokio::task::spawn_blocking(move || {
        std::process::Command::new(exe)
            .args(&words)
            .env("AGENTSTUDIO_HOOK_URL", env.url)
            .env("AGENTSTUDIO_HOOK_TOKEN", env.token)
            .env("AGENTSTUDIO_TERMINAL_ID", env.terminal_id)
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_agent_studio_command_runs_the_tools_end_to_end() {
    let (ws_port, _) = spawn_ws(None, echo).await;
    let grpc_port = spawn_grpc().await;
    let env = start_listener();

    let url = format!("ws://127.0.0.1:{ws_port}/");
    let out = run_binary(
        &env,
        &[
            "ws",
            "exchange",
            &url,
            "--send",
            "hi there",
            "--wait-ms",
            "200",
        ],
    )
    .await;
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(stdout.contains("← \"hi there\""), "{stdout}");

    let target = format!("127.0.0.1:{grpc_port}");
    let out = run_binary(
        &env,
        &[
            "grpc",
            "call",
            &target,
            "test.v1.Echo/Say",
            "--plaintext",
            "--body",
            r#"{"text":"yo"}"#,
            "--json",
        ],
    )
    .await;
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v: Value = serde_json::from_slice(&out.stdout).expect("--json prints JSON");
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"]["response"]["text"], "yo");

    let out = run_binary(
        &env,
        &["grpc", "describe", &target, "test.v1.Kind", "--plaintext"],
    )
    .await;
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("enum test.v1.Kind"));

    // A refusal exits 1 with the reason on stderr.
    let out = run_binary(
        &env,
        &[
            "ws",
            "exchange",
            &url,
            "--header",
            "Authorization: {{TOKEN}}",
        ],
    )
    .await;
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Vault variable"));

    // A usage error exits 2 before reaching the app.
    let out = run_binary(&env, &["grpc", "call", &target]).await;
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("grpc call needs method"));
}
