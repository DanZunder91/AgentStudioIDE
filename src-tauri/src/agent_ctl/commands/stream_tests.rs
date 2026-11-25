//! The WebSocket/gRPC tools without a server: argument rules, the Vault refusal (nothing
//! connects), bounds refused rather than clamped, the transcript and call reports, and message
//! shapes from a hand-built descriptor pool. The live paths are in
//! `tests/agent_stream_tools.rs`.
use super::*;
use crate::agent_ctl::cli::{parse_args, Parsed};
use crate::grpc::GrpcResponse;
use crate::ws::ExchangeEntry;
use prost_reflect::{DescriptorPool, DynamicMessage};
use prost_types::field_descriptor_proto::{Label, Type};
use prost_types::{
    DescriptorProto, EnumDescriptorProto, EnumValueDescriptorProto, FieldDescriptorProto,
    FileDescriptorProto, MessageOptions, MethodDescriptorProto, OneofDescriptorProto,
    ServiceDescriptorProto,
};

fn args(v: Value) -> Args {
    Args(v.as_object().expect("an object").clone())
}

fn call_json(tool: &str, a: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"tool": tool, "args": a})).unwrap()
}

/// A loopback port with a listener that must never see a connection.
fn watched_port() -> (std::net::TcpListener, u16) {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.set_nonblocking(true).unwrap();
    let port = l.local_addr().unwrap().port();
    (l, port)
}

fn assert_never_connected(l: &std::net::TcpListener) {
    match l.accept() {
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
        other => panic!("something connected: {other:?}"),
    }
}

fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

// ── the CLI words reach the right tool with typed arguments ──────────────────

fn parsed(words: &[&str]) -> (String, Value) {
    let words: Vec<String> = words.iter().map(|s| s.to_string()).collect();
    match parse_args(&words).unwrap() {
        Parsed::Call { call, .. } => (call.tool, Value::Object(call.args)),
        other => panic!("not a call: {other:?}"),
    }
}

#[test]
fn the_command_lines_parse_into_each_tools_arguments() {
    assert_eq!(
        parsed(&[
            "ws",
            "exchange",
            "wss://h/chat?room=1&x=2",
            "--header",
            "Authorization: Bearer abc",
            "--send",
            "hello",
            "--send",
            "{\"op\":\"sub\"}",
            "--wait-ms",
            "500",
            "--max-messages",
            "3",
        ]),
        (
            "ws_exchange".to_string(),
            json!({
                "url": "wss://h/chat?room=1&x=2",
                "header": ["Authorization: Bearer abc"],
                "send": ["hello", "{\"op\":\"sub\"}"],
                "wait_ms": 500,
                "max_messages": 3,
            })
        )
    );
    assert_eq!(
        parsed(&["grpc", "services", "localhost:50051", "--plaintext"]),
        (
            "grpc_services".to_string(),
            json!({"target": "localhost:50051", "plaintext": true})
        )
    );
    assert_eq!(
        parsed(&["grpc", "describe", "h:1", "pkg.Svc/M"]),
        (
            "grpc_describe".to_string(),
            json!({"target": "h:1", "name": "pkg.Svc/M"})
        )
    );
    assert_eq!(
        parsed(&[
            "grpc",
            "call",
            "h:1",
            "pkg.Svc/M",
            "--body",
            "{\"name\":\"ada\"}",
            "--header",
            "x-tenant: acme",
            "--timeout-ms",
            "900",
        ]),
        (
            "grpc_call".to_string(),
            json!({
                "target": "h:1",
                "method": "pkg.Svc/M",
                "body": {"name": "ada"},
                "header": ["x-tenant: acme"],
                "timeout_ms": 900,
            })
        )
    );
}

// ── the Vault rule ───────────────────────────────────────────────────────────

/// Every field an agent writes, in every tool: refused with the sentence, before any connect,
/// and nothing is emitted.
#[tokio::test]
async fn a_vault_reference_anywhere_is_refused_before_anything_connects() {
    let (listener, port) = watched_port();
    let dir = std::env::temp_dir().join(format!("agentstudio-stream-{}", ulid::Ulid::new()));
    let (ctx, rec) = crate::agent_ctl::tests::ctx(&dir, "term-1");
    let here = format!("127.0.0.1:{port}");
    let ws_url = format!("ws://{here}/");
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "ws_exchange",
            json!({"url": format!("ws://{here}/?token={{{{API_TOKEN}}}}")}),
            "URL",
        ),
        (
            "ws_exchange",
            json!({"url": ws_url, "header": ["Authorization: Bearer {{API_TOKEN}}"]}),
            "header",
        ),
        (
            "ws_exchange",
            json!({"url": ws_url, "send": ["fine", "{\"token\":\"{{API_TOKEN}}\"}"]}),
            "message",
        ),
        (
            "grpc_services",
            json!({"target": "{{GRPC_HOST}}:443"}),
            "target",
        ),
        (
            "grpc_describe",
            json!({"target": here, "name": "{{X}}", "plaintext": true}),
            "name",
        ),
        (
            "grpc_call",
            json!({"target": here, "method": "a.B/C", "header": ["authorization: Bearer {{API_TOKEN}}"], "plaintext": true}),
            "header",
        ),
        (
            "grpc_call",
            json!({"target": here, "method": "a.B/C", "body": {"token": "{{API_TOKEN}}"}, "plaintext": true}),
            "body",
        ),
        (
            "grpc_call",
            json!({"target": here, "method": "a.B/C", "body": "{\"token\":\"{{API_TOKEN}}\"}", "plaintext": true}),
            "body",
        ),
        (
            "grpc_call",
            json!({"target": here, "method": "{{M}}", "plaintext": true}),
            "method",
        ),
    ];
    for (tool, a, field) in cases {
        let (status, reply) =
            crate::agent_ctl::handle(ctx.clone(), &call_json(tool, a.clone())).await;
        assert_eq!(status, 422, "{tool} {a}");
        assert!(
            reply.message.contains("Vault variable") && reply.message.contains("Nothing was sent"),
            "{tool} {a}: {}",
            reply.message
        );
        assert!(
            reply.message.starts_with(&format!("The {field} contains ")),
            "the refusal names the field ({field}): {}",
            reply.message
        );
    }
    assert!(rec.0.lock().unwrap().is_empty(), "a refusal emits nothing");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_never_connected(&listener);
}

#[test]
fn text_without_a_reference_passes_and_a_lone_brace_is_not_one() {
    assert!(refuse_vault_refs(&[("message", "{\"a\":{}}"), ("header", "x: {y}")]).is_ok());
    assert!(refuse_vault_refs(&[]).is_ok());
}

// ── arguments ────────────────────────────────────────────────────────────────

#[test]
fn a_header_is_name_colon_value_and_anything_else_is_explained() {
    assert_eq!(
        parse_header("Authorization:  Bearer a:b ").unwrap(),
        ("Authorization".to_string(), "Bearer a:b".to_string())
    );
    assert_eq!(
        parse_header("x-empty:").unwrap(),
        ("x-empty".to_string(), String::new())
    );
    assert!(parse_header("no colon here")
        .unwrap_err()
        .contains("has no colon"));
    assert!(parse_header(" : v").unwrap_err().contains("has no name"));
    let long = "y".repeat(500);
    assert!(
        parse_header(&long).unwrap_err().len() < 200,
        "a quoted line is cut"
    );
}

#[test]
fn numbers_outside_their_range_are_refused_not_clamped() {
    let check = |a: Value, name: &str, default: i64, min: i64, max: i64| {
        bounded(&args(a), name, default, min, max)
    };
    assert_eq!(check(json!({}), "wait_ms", 2000, 0, 30000), Ok(2000));
    assert_eq!(
        check(json!({"wait_ms": null}), "wait_ms", 2000, 0, 30000),
        Ok(2000)
    );
    assert_eq!(
        check(json!({"wait_ms": 0}), "wait_ms", 2000, 0, 30000),
        Ok(0)
    );
    assert_eq!(
        check(json!({"wait_ms": 30000}), "wait_ms", 2000, 0, 30000),
        Ok(30000)
    );
    let err = check(json!({"wait_ms": 30001}), "wait_ms", 2000, 0, 30000).unwrap_err();
    assert_eq!(err, "`wait_ms` must be between 0 and 30000; 30001 is not.");
    assert!(check(json!({"wait_ms": -1}), "wait_ms", 2000, 0, 30000).is_err());
    let err = check(json!({"n": u64::MAX}), "n", 1, 1, 5).unwrap_err();
    assert_eq!(err, "`n` must be between 1 and 5.");
}

#[test]
fn the_exchange_is_checked_whole_before_it_runs() {
    let spec = ws_spec(&args(json!({"url": "  ws://h:1/x  "}))).unwrap();
    assert_eq!(spec.url, "ws://h:1/x");
    assert_eq!(spec.wait, Duration::from_millis(2000));
    assert_eq!(spec.max_messages, 50);
    assert_eq!(spec.connect_timeout, WS_CONNECT_TIMEOUT);
    assert_eq!(spec.send_budget, ws::SEND_BUDGET);
    assert!(spec.headers.is_empty() && spec.send.is_empty());

    let spec = ws_spec(&args(json!({
        "url": "WSS://h/",
        "header": ["A: 1", "B: two words"],
        "send": ["x", "y"],
        "wait_ms": 0,
        "max_messages": 500,
    })))
    .unwrap();
    assert_eq!(
        spec.headers
            .iter()
            .map(|h| (h.name.as_str(), h.value.as_str()))
            .collect::<Vec<_>>(),
        [("A", "1"), ("B", "two words")]
    );
    assert_eq!(spec.send, ["x", "y"]);
    assert_eq!(spec.max_messages, 500);

    let refused = |a: Value| ws_spec(&args(a)).unwrap_err();
    assert!(refused(json!({"url": "http://h/"})).contains("ws:// or wss://"));
    assert!(refused(json!({"url": "h:1"})).contains("ws:// or wss://"));
    assert!(
        !refused(json!({"url": "https://u:pw@h/"})).contains("pw"),
        "credentials are not quoted back"
    );
    assert!(refused(json!({"url": "   "})).contains("`url` is required"));
    assert!(refused(json!({"url": "ws://h/", "max_messages": 0})).contains("max_messages"));
    assert!(refused(json!({"url": "ws://h/", "max_messages": 501})).contains("max_messages"));
    assert!(refused(json!({"url": "ws://h/", "wait_ms": 30001})).contains("wait_ms"));
    let sends = vec!["m"; MAX_SENDS + 1];
    assert!(refused(json!({"url": "ws://h/", "send": sends})).contains("At most 100 messages"));
    let big = "z".repeat(MAX_SEND_BYTES + 1);
    assert!(refused(json!({"url": "ws://h/", "send": ["ok", big]})).starts_with("Message 2 is"));
    let headers = vec!["a: b"; MAX_HEADERS + 1];
    assert!(refused(json!({"url": "ws://h/", "header": headers})).contains("At most 50 headers"));
    assert!(refused(json!({"url": "ws://h/", "header": ["nocolon"]})).contains("no colon"));
}

#[test]
fn a_url_is_shown_without_its_credentials() {
    assert_eq!(display_url("ws://h:1/a?b=c"), "ws://h:1/a?b=c");
    assert_eq!(display_url("wss://user:s3cret@h/a"), "wss://h/a");
    assert_eq!(display_url("wss://u:p@h"), "wss://h");
    // An `@` in the path or query is not userinfo.
    assert_eq!(display_url("ws://h/a@b?c=d@e"), "ws://h/a@b?c=d@e");
    assert_eq!(display_url("no scheme"), "no scheme");
}

#[test]
fn a_grpc_target_names_its_endpoint_and_transport() {
    let ok = |t: &str, plaintext: bool| grpc_target(t, plaintext).unwrap();
    assert_eq!(
        ok("localhost:50051", false),
        ("localhost:50051".into(), false)
    );
    assert_eq!(
        ok(" localhost:50051 ", true),
        ("localhost:50051".into(), true)
    );
    assert_eq!(
        ok("http://10.0.0.1:9000/", false),
        ("10.0.0.1:9000".into(), true)
    );
    assert_eq!(
        ok("HTTPS://api.example.com:443", false),
        ("api.example.com:443".into(), false)
    );
    assert_eq!(ok("[::1]:50051", true), ("[::1]:50051".into(), true));

    let err = |t: &str, plaintext: bool| grpc_target(t, plaintext).unwrap_err();
    assert!(err("https://h:1", true).contains("drop --plaintext"));
    assert!(err("grpc://h:1", false).contains("host:port"));
    assert!(err("localhost", false).contains("with the port"));
    assert!(err("h:notaport", false).contains("with the port"));
    assert!(err(":50051", false).contains("with the port"));
    assert!(err("h:1/pkg.Svc", false).contains("without a path"));
    let e = err("https://u:s3cret@h:1", false);
    assert!(e.contains("--header") && !e.contains("s3cret"), "{e}");
}

#[test]
fn a_method_is_service_slash_method_or_dotted() {
    let ok = |t: &str| split_method(t).unwrap();
    assert_eq!(ok("pkg.Svc/Say"), ("pkg.Svc".into(), "Say".into()));
    assert_eq!(ok("/pkg.Svc/Say"), ("pkg.Svc".into(), "Say".into()));
    assert_eq!(ok("pkg.v1.Svc.Say"), ("pkg.v1.Svc".into(), "Say".into()));
    for bad in ["Say", "pkg.Svc/", "/Say", "a/b/c", ""] {
        assert!(
            split_method(bad)
                .unwrap_err()
                .contains("package.Service/Method"),
            "{bad}"
        );
    }
}

#[test]
fn the_body_is_a_json_object_or_a_string_holding_one() {
    assert_eq!(body_text(None).unwrap(), "{}");
    assert_eq!(body_text(Some(&Value::Null)).unwrap(), "{}");
    assert_eq!(body_text(Some(&json!({"a": 1}))).unwrap(), r#"{"a":1}"#);
    assert_eq!(
        body_text(Some(&json!(" {\"a\": 1} "))).unwrap(),
        "{\"a\": 1}"
    );
    for bad in [json!([1]), json!(5), json!("not json"), json!("[1]")] {
        assert!(
            body_text(Some(&bad)).unwrap_err().contains("JSON object"),
            "{bad}"
        );
    }
}

#[test]
fn a_call_is_checked_whole_before_it_runs() {
    let plan = call_plan(&args(json!({
        "target": "http://h:1",
        "method": "pkg.Svc/Say",
        "body": {"name": "ada"},
        "header": ["X-Tenant: acme"],
    })))
    .unwrap();
    assert_eq!(plan.request.endpoint, "h:1");
    assert!(plan.request.plaintext);
    assert_eq!(
        (plan.request.service.as_str(), plan.request.method.as_str()),
        ("pkg.Svc", "Say")
    );
    assert_eq!(plan.request.message, r#"{"name":"ada"}"#);
    assert_eq!(plan.request.metadata[0].name, "X-Tenant");
    assert_eq!(plan.request.metadata[0].value, "acme");
    assert_eq!(plan.timeout, Duration::from_millis(30_000));

    let refused = |a: Value| call_plan(&args(a)).err().unwrap();
    assert!(refused(json!({"target": "h:1", "method": "M"})).contains("package.Service/Method"));
    assert!(refused(json!({"target": "h", "method": "a.B/C"})).contains("port"));
    assert!(
        refused(json!({"target": "h:1", "method": "a.B/C", "timeout_ms": 0}))
            .contains("timeout_ms")
    );
    assert!(
        refused(json!({"target": "h:1", "method": "a.B/C", "timeout_ms": 60_001}))
            .contains("timeout_ms")
    );
    let big = json!({"blob": "b".repeat(MAX_BODY_BYTES)});
    assert!(refused(json!({"target": "h:1", "method": "a.B/C", "body": big})).contains("at most"));
    assert!(
        refused(json!({"target": "h:1", "method": "a.B/C", "body": [1]})).contains("JSON object")
    );
}

// ── what the agent reads ─────────────────────────────────────────────────────

fn entry(
    direction: Direction,
    kind: PayloadKind,
    bytes: usize,
    text: Option<&str>,
    truncated: bool,
) -> ExchangeEntry {
    ExchangeEntry {
        direction,
        at_ms: 7,
        kind,
        bytes,
        text: text.map(str::to_string),
        truncated,
    }
}

#[test]
fn a_transcript_reads_one_message_per_line_and_says_what_it_cut() {
    let t = Exchange {
        handshake_ms: 3,
        entries: vec![
            entry(Direction::Sent, PayloadKind::Text, 5, Some("hello"), false),
            entry(
                Direction::Received,
                PayloadKind::Text,
                12,
                Some("two\nlines \"q\""),
                false,
            ),
            entry(Direction::Received, PayloadKind::Binary, 1, None, false),
            entry(
                Direction::Received,
                PayloadKind::Text,
                9000,
                Some("abc"),
                true,
            ),
            entry(Direction::Received, PayloadKind::Text, 40, None, true),
        ],
        sent: 1,
        unsent: 0,
        received: 4,
        end: ExchangeEnd::Waited,
    };
    let m = ws_message("ws://h/", 2000, 50, &t);
    let lines: Vec<&str> = m.lines().collect();
    assert_eq!(
        lines[0],
        "WebSocket ws://h/: opened in 3 ms; sent 1; received 4 messages; listened 2000 ms after \
         the last send, then Agent Studio closed the socket."
    );
    assert_eq!(lines[1], "  +7 ms  → \"hello\"");
    assert_eq!(
        lines[2], "  +7 ms  ← \"two\\nlines \\\"q\\\"\"",
        "a message is one line"
    );
    assert_eq!(lines[3], "  +7 ms  ← binary, 1 byte");
    assert_eq!(lines[4], "  +7 ms  ← \"abc\" … (cut; 9000 bytes in all)");
    assert!(
        lines[5].contains("not kept: the transcript's text limit"),
        "{}",
        lines[5]
    );
    assert!(lines[6].starts_with("Text is cut at 4 KiB per message and 256 KiB"));
    assert_eq!(lines.len(), 7);
}

#[test]
fn every_way_an_exchange_ends_is_said() {
    let with = |end: ExchangeEnd, unsent: usize| {
        let t = Exchange {
            handshake_ms: 1,
            entries: Vec::new(),
            sent: 2,
            unsent,
            received: 1,
            end,
        };
        ws_message("ws://h/", 100, 5, &t)
    };
    assert!(with(ExchangeEnd::MaxMessages, 0).contains("stopped at 5 messages (--max-messages)"));
    assert!(with(
        ExchangeEnd::ServerClosed {
            code: Some(4001),
            reason: "bye \"now\"".into()
        },
        0
    )
    .contains("the server closed the socket with code 4001 (\"bye \\\"now\\\"\")"));
    assert!(with(
        ExchangeEnd::ServerClosed {
            code: None,
            reason: String::new()
        },
        0
    )
    .ends_with("the server closed the socket."));
    let stalled = with(ExchangeEnd::SendStalled, 3);
    assert!(stalled.contains("sent 2, 3 messages NOT sent"), "{stalled}");
    assert!(stalled.contains("the server stopped reading"), "{stalled}");
    assert!(with(
        ExchangeEnd::Error {
            message: "IO error".into()
        },
        1
    )
    .contains("sent 2, 1 message NOT sent; received 1 message; the socket failed: IO error."));
}

fn request() -> GrpcRequest {
    GrpcRequest {
        endpoint: "h:1".into(),
        service: "pkg.Svc".into(),
        method: "Say".into(),
        message: "{}".into(),
        metadata: Vec::new(),
        plaintext: true,
    }
}

fn outcome(
    code: u32,
    name: &str,
    message: &str,
    error: Option<&str>,
    metadata: Vec<(String, String)>,
) -> GrpcOutcome {
    GrpcOutcome {
        response: GrpcResponse {
            message: message.into(),
            status_code: code,
            status_name: name.into(),
            error: error.map(str::to_string),
        },
        metadata,
    }
}

#[test]
fn an_ok_call_reports_status_metadata_and_pretty_json() {
    let r = call_report(
        &request(),
        &outcome(
            0,
            "OK",
            r#"{"text":"hi","n":2}"#,
            None,
            vec![("x-served-by".into(), "echo".into())],
        ),
        12,
    );
    assert_eq!(
        r.message,
        "gRPC pkg.Svc/Say at h:1 (plaintext): OK, in 12 ms.\nResponse metadata:\n  \
         x-served-by: echo\nResponse:\n{\n  \"n\": 2,\n  \"text\": \"hi\"\n}"
    );
    assert_eq!(r.data["response"], json!({"text": "hi", "n": 2}));
    assert_eq!(r.data["truncated"], false);
    assert_eq!(r.data["responseText"], Value::Null);
    assert_eq!(
        r.data["metadata"][0],
        json!({"name": "x-served-by", "value": "echo", "truncated": false})
    );
    assert_eq!(r.data["statusCode"], 0);
    assert_eq!(r.data["durationMs"], 12);
}

#[test]
fn a_status_is_an_answer_and_says_its_code_and_message() {
    let r = call_report(
        &request(),
        &outcome(5, "NotFound", "", Some("no such echo"), Vec::new()),
        3,
    );
    assert_eq!(
        r.message,
        "gRPC pkg.Svc/Say at h:1 (plaintext): NotFound (5): no such echo, in 3 ms."
    );
    assert_eq!(r.data["statusName"], "NotFound");
    assert_eq!(r.data["error"], "no such echo");
    let r = call_report(
        &request(),
        &outcome(14, "Unavailable", "", None, Vec::new()),
        3,
    );
    assert!(
        r.message.contains(": Unavailable (14), in 3 ms."),
        "{}",
        r.message
    );
}

#[test]
fn a_big_response_and_long_metadata_are_cut_and_the_cut_is_said() {
    let text = "w".repeat(RESPONSE_TEXT_BYTES * 2);
    let body = json!({ "text": text }).to_string();
    let mut metadata: Vec<(String, String)> = (0..MAX_METADATA + 3)
        .map(|i| (format!("x-{i}"), "v".to_string()))
        .collect();
    metadata[0].1 = "m".repeat(METADATA_VALUE_BYTES + 5);
    let r = call_report(&request(), &outcome(0, "OK", &body, None, metadata), 1);
    assert!(
        r.message.len() < RESPONSE_TEXT_BYTES + 8 * 1024,
        "the message is bounded: {}",
        r.message.len()
    );
    assert!(r.message.contains(&format!(
        "…the response is {} bytes of JSON; only the first 64 KiB are shown.",
        body.len()
    )));
    assert!(r.message.contains("  …3 more entries not shown"));
    assert!(r.message.contains("Metadata values are cut at 1024 bytes."));
    assert_eq!(r.data["truncated"], true);
    assert_eq!(r.data["response"], Value::Null);
    assert_eq!(
        r.data["responseText"].as_str().unwrap().len(),
        RESPONSE_TEXT_BYTES
    );
    assert_eq!(r.data["responseBytes"], body.len());
    assert_eq!(r.data["metadata"].as_array().unwrap().len(), MAX_METADATA);
    assert_eq!(r.data["moreMetadata"], 3);
    assert_eq!(r.data["metadata"][0]["truncated"], true);
    assert_eq!(
        r.data["metadata"][0]["value"].as_str().unwrap().len(),
        METADATA_VALUE_BYTES
    );
}

// ── shapes, from a hand-built pool ───────────────────────────────────────────

fn field(
    name: &str,
    json_name: &str,
    number: i32,
    ty: Type,
    type_name: Option<&str>,
) -> FieldDescriptorProto {
    FieldDescriptorProto {
        name: Some(name.into()),
        json_name: Some(json_name.into()),
        number: Some(number),
        label: Some(Label::Optional as i32),
        r#type: Some(ty as i32),
        type_name: type_name.map(str::to_string),
        ..Default::default()
    }
}

fn repeated(mut f: FieldDescriptorProto) -> FieldDescriptorProto {
    f.label = Some(Label::Repeated as i32);
    f
}

fn in_oneof(mut f: FieldDescriptorProto, index: i32) -> FieldDescriptorProto {
    f.oneof_index = Some(index);
    f
}

fn message(name: &str, fields: Vec<FieldDescriptorProto>) -> DescriptorProto {
    DescriptorProto {
        name: Some(name.into()),
        field: fields,
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

/// `google/protobuf/timestamp.proto` and a `test/v1/echo.proto` that imports it: every field
/// kind the description handles (scalar, 64-bit, enum, map, oneof, repeated, a recursive
/// message, a well-known type) and a unary and a streaming method.
fn pool() -> DescriptorPool {
    let timestamp = FileDescriptorProto {
        name: Some("google/protobuf/timestamp.proto".into()),
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
    };
    let mut request = message(
        "EchoRequest",
        vec![
            field("text", "text", 1, Type::String, None),
            field("count", "count", 2, Type::Int32, None),
            repeated(field("tags", "tags", 3, Type::String, None)),
            repeated(field(
                "scores",
                "scores",
                4,
                Type::Message,
                Some(".test.v1.EchoRequest.ScoresEntry"),
            )),
            field("kind", "kind", 5, Type::Enum, Some(".test.v1.Kind")),
            field("inner", "inner", 6, Type::Message, Some(".test.v1.Inner")),
            field(
                "when",
                "when",
                7,
                Type::Message,
                Some(".google.protobuf.Timestamp"),
            ),
            in_oneof(field("pick_a", "pickA", 8, Type::String, None), 0),
            in_oneof(field("pick_b", "pickB", 9, Type::Int64, None), 0),
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
    let echo = FileDescriptorProto {
        name: Some("test/v1/echo.proto".into()),
        package: Some("test.v1".into()),
        syntax: Some("proto3".into()),
        dependency: vec!["google/protobuf/timestamp.proto".into()],
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
            method: vec![method("Say", false), method("Watch", true)],
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut pool = DescriptorPool::new();
    pool.add_file_descriptor_protos([timestamp, echo]).unwrap();
    pool
}

#[test]
fn a_name_resolves_to_a_method_service_message_or_enum() {
    let p = pool();
    for name in [
        "test.v1.Echo/Say",
        "/test.v1.Echo/Say",
        "test.v1.Echo.Say",
        ".test.v1.Echo.Say",
    ] {
        assert!(
            matches!(shape::resolve(&p, name), Some(shape::Found::Method(m)) if m.name() == "Say"),
            "{name}"
        );
    }
    assert!(matches!(
        shape::resolve(&p, "test.v1.Echo"),
        Some(shape::Found::Service(_))
    ));
    assert!(matches!(
        shape::resolve(&p, "test.v1.Inner"),
        Some(shape::Found::Message(_))
    ));
    assert!(matches!(
        shape::resolve(&p, "test.v1.Kind"),
        Some(shape::Found::Enum(_))
    ));
    for none in [
        "test.v1.Echo/Nope",
        "test.v1.Echo.Nope",
        "Nope",
        "nope.Nope/Say",
    ] {
        assert!(shape::resolve(&p, none).is_none(), "{none}");
    }
}

#[test]
fn a_method_is_described_field_by_field_with_an_example_the_server_can_parse() {
    let p = pool();
    let found = shape::resolve(&p, "test.v1.Echo/Say").unwrap();
    let (text, data) = shape::describe(&found);
    for want in [
        "rpc test.v1.Echo/Say(test.v1.EchoRequest) returns (test.v1.EchoReply)",
        "message test.v1.EchoRequest {",
        "  text: string",
        "  tags: repeated string",
        "  scores: map<string, int64 (JSON: a string of digits)>",
        "  kind: enum test.v1.Kind (KIND_UNSPECIFIED | KIND_A)",
        "  inner: test.v1.Inner",
        "  when: google.protobuf.Timestamp (JSON: an RFC 3339 string)",
        "  pickA: string  [proto name pick_a; oneof pick: set at most one]",
        "  pickB: int64 (JSON: a string of digits)  [proto name pick_b; oneof pick: set at most one]",
        "message test.v1.EchoReply {",
        "message test.v1.Inner {",
        "  child: test.v1.Inner",
        "Example JSON for test.v1.Echo/Say (every field is optional; drop what you do not need):",
    ] {
        assert!(text.lines().any(|l| l == want), "missing {want:?} in:\n{text}");
    }
    assert!(
        !text.contains("message google.protobuf.Timestamp"),
        "a well-known type is not spelled out"
    );
    assert!(
        !text.contains("ScoresEntry"),
        "a map entry is not spelled out"
    );
    assert_eq!(
        text.matches("message test.v1.Inner {").count(),
        1,
        "a recursive message once"
    );

    // The example is valid input: it parses as the method's request message.
    let example = &data["methods"][0]["requestExample"];
    assert_eq!(example["pickA"], "", "the first member of the oneof");
    assert!(example.get("pickB").is_none(), "only one member of a oneof");
    assert_eq!(example["scores"], json!({"key": "0"}));
    assert_eq!(example["when"], "1970-01-01T00:00:00Z");
    assert_eq!(example["kind"], "KIND_UNSPECIFIED");
    let input = p.get_message_by_name("test.v1.EchoRequest").unwrap();
    DynamicMessage::deserialize(input, example.clone()).expect("the example parses");
    // The text's example line is the same JSON.
    let printed = text.lines().last().unwrap();
    assert_eq!(serde_json::from_str::<Value>(printed).unwrap(), *example);

    // A recursive message nests to a bounded depth, ending in {}.
    let mut depth = 0;
    let mut inner = &example["inner"];
    while let Some(child) = inner.get("child") {
        depth += 1;
        inner = child;
    }
    assert!(depth < shape::EXAMPLE_DEPTH, "depth {depth}");
    assert_eq!(*inner, json!({}));
}

#[test]
fn a_service_lists_its_methods_and_a_streaming_one_is_marked_and_has_no_example() {
    let p = pool();
    let (text, data) = shape::describe(&shape::resolve(&p, "test.v1.Echo").unwrap());
    assert!(
        text.starts_with("service test.v1.Echo (2 methods)\n"),
        "{text}"
    );
    assert!(text.contains(
        "rpc test.v1.Echo/Watch(test.v1.EchoRequest) returns (stream test.v1.EchoReply)"
    ));
    assert!(text.contains("a stream method cannot be called"));
    assert_eq!(
        text.matches("Example JSON for").count(),
        1,
        "only the unary method"
    );
    assert_eq!(data["methods"][1]["serverStreaming"], true);
    assert!(data["methods"][1].get("requestExample").is_none());
}

#[test]
fn a_message_and_an_enum_are_described_by_name() {
    let p = pool();
    let (text, data) = shape::describe(&shape::resolve(&p, "test.v1.Inner").unwrap());
    assert!(text.starts_with("message test.v1.Inner {"), "{text}");
    assert!(text.contains("Example JSON for test.v1.Inner"));
    assert_eq!(data["example"]["note"], "");
    let (text, data) = shape::describe(&shape::resolve(&p, "test.v1.Kind").unwrap());
    assert_eq!(
        text,
        "enum test.v1.Kind { KIND_UNSPECIFIED | KIND_A }\nIn JSON, use the value's name as a string."
    );
    assert_eq!(data["values"][1], json!({"name": "KIND_A", "number": 1}));
}

/// A chain of messages longer than the cap, a message with more fields than the cap and an enum
/// with more values than the cap: each description stops where it says it stops.
#[test]
fn big_schemas_are_cut_where_the_description_says() {
    let chain = shape::MAX_MESSAGES + 5;
    let mut messages: Vec<DescriptorProto> = (0..chain)
        .map(|i| {
            let next = format!(".big.M{}", i + 1);
            let fields = if i + 1 < chain {
                vec![field("next", "next", 1, Type::Message, Some(&next))]
            } else {
                Vec::new()
            };
            message(&format!("M{i}"), fields)
        })
        .collect();
    messages.push(message(
        "Wide",
        (1..=(shape::MAX_FIELDS as i32 + 3))
            .map(|n| field(&format!("f{n}"), &format!("f{n}"), n, Type::Bool, None))
            .collect(),
    ));
    let file = FileDescriptorProto {
        name: Some("big.proto".into()),
        package: Some("big".into()),
        syntax: Some("proto3".into()),
        message_type: messages,
        enum_type: vec![EnumDescriptorProto {
            name: Some("Many".into()),
            value: (0..(shape::MAX_ENUM_VALUES as i32 + 4))
                .map(|i| EnumValueDescriptorProto {
                    name: Some(format!("V{i}")),
                    number: Some(i),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();

    let (text, data) = shape::describe(&shape::resolve(&p, "big.M0").unwrap());
    assert_eq!(text.matches("message big.M").count(), shape::MAX_MESSAGES);
    assert!(text.contains("…only the first 40 messages are spelled out"));
    assert_eq!(data["messagesCut"], true);

    let (text, data) = shape::describe(&shape::resolve(&p, "big.Wide").unwrap());
    assert!(text.contains("  …3 more fields not listed"));
    assert_eq!(data["messages"][0]["moreFields"], 3);
    assert_eq!(
        data["messages"][0]["fields"].as_array().unwrap().len(),
        shape::MAX_FIELDS
    );

    let (text, data) = shape::describe(&shape::resolve(&p, "big.Many").unwrap());
    assert!(text.contains("V19 | …4 more }"), "{text}");
    assert_eq!(data["moreValues"], 4);
}

#[test]
fn a_services_listing_marks_streaming_and_undescribed_services_and_its_cut() {
    let p = pool();
    let names = vec![
        "test.v1.Echo".to_string(),
        "grpc.reflection.v1.ServerReflection".to_string(),
    ];
    let r = services_report("h:1", true, &names, &p);
    assert_eq!(
        r.message.lines().take(5).collect::<Vec<_>>(),
        [
            "2 services at h:1 (plaintext):",
            "  test.v1.Echo",
            "    rpc test.v1.Echo/Say(test.v1.EchoRequest) returns (test.v1.EchoReply)",
            "    rpc test.v1.Echo/Watch(test.v1.EchoRequest) returns (stream test.v1.EchoReply)  [streaming: not callable with grpc call]",
            "  grpc.reflection.v1.ServerReflection",
        ]
    );
    assert!(r
        .message
        .contains("(the server did not describe its methods)"));
    assert_eq!(
        r.data["services"][0]["methods"][0]["method"],
        "test.v1.Echo/Say"
    );
    assert_eq!(r.data["services"][1]["described"], false);
    assert_eq!(r.data["truncated"], false);

    let many: Vec<String> = (0..MAX_SERVICES + 1).map(|i| format!("s.S{i}")).collect();
    let r = services_report("h:1", false, &many, &p);
    assert!(r.message.starts_with("201 services at h:1 (TLS):"));
    assert!(r
        .message
        .contains("…showing the first 200 of 201 services."));
    assert_eq!(r.data["services"].as_array().unwrap().len(), MAX_SERVICES);
    assert_eq!(r.data["truncated"], true);

    let r = services_report("h:1", true, &[], &p);
    assert_eq!(r.message, "0 services at h:1 (plaintext):\n  (none listed)");
}

// ── through the dispatcher, against nothing ──────────────────────────────────

#[tokio::test]
async fn an_unreachable_server_is_a_clear_failure_and_a_call_still_reaches_history() {
    let dir = std::env::temp_dir().join(format!("agentstudio-stream-{}", ulid::Ulid::new()));
    let (ctx, rec) = crate::agent_ctl::tests::ctx(&dir, "term-4");
    let port = dead_port();

    let (status, r) = crate::agent_ctl::handle(
        ctx.clone(),
        &call_json(
            "ws_exchange",
            json!({"url": format!("ws://u:pw@127.0.0.1:{port}/x")}),
        ),
    )
    .await;
    assert_eq!(status, 422);
    assert!(
        r.message.starts_with(&format!(
            "Could not open a WebSocket to ws://127.0.0.1:{port}/x: "
        )),
        "{}",
        r.message
    );
    assert!(!r.message.contains("pw"));

    let target = format!("127.0.0.1:{port}");
    for (tool, a) in [
        (
            "grpc_services",
            json!({"target": target, "plaintext": true}),
        ),
        (
            "grpc_describe",
            json!({"target": target, "name": "a.B", "plaintext": true}),
        ),
    ] {
        let (status, r) = crate::agent_ctl::handle(ctx.clone(), &call_json(tool, a)).await;
        assert_eq!(status, 422, "{tool}");
        assert!(
            r.message
                .starts_with(&format!("Could not reflect 127.0.0.1:{port} (plaintext): ")),
            "{tool}: {}",
            r.message
        );
    }
    assert!(rec.0.lock().unwrap().is_empty(), "reads emit nothing");

    let (status, r) = crate::agent_ctl::handle(
        ctx.clone(),
        &call_json(
            "grpc_call",
            json!({"target": format!("http://127.0.0.1:{port}"), "method": "a.B/C", "body": {"x": 1}, "header": ["x-tenant: acme"]}),
        ),
    )
    .await;
    assert_eq!(status, 422);
    assert!(
        r.message.starts_with(&format!(
            "gRPC a.B/C at 127.0.0.1:{port} (plaintext) failed: "
        )),
        "{}",
        r.message
    );
    let events = rec.0.lock().unwrap().clone();
    assert_eq!(events.len(), 1, "an attempted call is reported to the UI");
    let e = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(e["kind"], "grpcCall");
    assert_eq!(e["terminalId"], "term-4");
    assert_eq!(e["target"], format!("127.0.0.1:{port}"));
    assert_eq!(e["service"], "a.B");
    assert_eq!(e["method"], "C");
    assert_eq!(e["body"], r#"{"x":1}"#);
    assert_eq!(e["headers"], json!([{"name": "x-tenant", "value": "acme"}]));
    assert_eq!(e["plaintext"], true);
    assert_eq!(e["statusCode"], Value::Null);
    assert!(e["transportError"].as_str().is_some_and(|m| !m.is_empty()));
    assert!(e["durationMs"].is_u64());
}
