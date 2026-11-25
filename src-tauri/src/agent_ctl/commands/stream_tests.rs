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
        // Encoded: the braces escaped in JSON (a string body is parsed before it is checked)…
        (
            "grpc_call",
            json!({"target": here, "method": "a.B/C", "body": r#"{"t":"\u007b\u007bAPI_TOKEN}}"}"#, "plaintext": true}),
            "body",
        ),
        (
            "grpc_call",
            json!({"target": here, "method": "a.B/C", "body": r#"{"\u007B{API_TOKEN}}":1}"#, "plaintext": true}),
            "body",
        ),
        // …or percent-encoded, in any case, mixed, or encoded twice.
        (
            "grpc_call",
            json!({"target": here, "method": "a.B/C", "body": {"t": ["%7B%7BAPI_TOKEN%7D%7D"]}, "plaintext": true}),
            "body",
        ),
        (
            "grpc_call",
            json!({"target": here, "method": "a.B/C", "header": ["authorization: Bearer %7b%7bAPI_TOKEN%7d%7d"], "plaintext": true}),
            "header",
        ),
        (
            "grpc_services",
            json!({"target": "%7B%7BGRPC_HOST%7D%7D:443"}),
            "target",
        ),
        (
            "grpc_describe",
            json!({"target": here, "name": "{%7BX}}", "plaintext": true}),
            "name",
        ),
        (
            "ws_exchange",
            json!({"url": format!("ws://{here}/?t=%257B%257BAPI_TOKEN%257D%257D")}),
            "URL",
        ),
        (
            "ws_exchange",
            json!({"url": ws_url, "header": ["X-Token: \\u007b\\u007bAPI_TOKEN}}"]}),
            "header",
        ),
        (
            "ws_exchange",
            json!({"url": ws_url, "send": [r#"{"token":"\u007b\u007bAPI_TOKEN}}"}"#]}),
            "message",
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

#[test]
fn a_reference_is_seen_through_every_encoding_and_only_a_reference_is() {
    for named in [
        "{{X}}",
        "a {{ X }} b",
        "%7B%7BX%7D%7D",
        "%7b%7bX%7d%7d",
        "%7B{X}}",
        "{%7bX}}",
        "%257B%257BX%257D%257D",
        "%25257B%25257BX",
        r"\u007b\u007bX}}",
        r"\u007B{X}}",
        r"%5Cu007b%5Cu007bX",
    ] {
        assert!(names_vault_var(named), "{named}");
    }
    for plain in [
        "",
        "{}",
        "{ {",
        "{x}{y}",
        "100% sure",
        "%7B only one %7D",
        "%7Bx%7B",
        "%zz%7",
        r"\u007b alone",
        r"\u00",
        r"\uZZZZ",
        "%E2%82%AC",
    ] {
        assert!(!names_vault_var(plain), "{plain}");
    }
    assert!(json_names_vault_var(&json!({"a": [1, {"b": "%7B%7BX"}]})));
    assert!(json_names_vault_var(&json!({"{{X}}": null})));
    assert!(!json_names_vault_var(
        &json!({"a": [1, true, null, {"b": "{x}"}]})
    ));
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
    // A string body is written from its parsed value: what is checked, sent and recorded is one
    // text, with escapes undone and a repeated key once.
    assert_eq!(
        body_text(Some(&json!(" {\"a\": 1} "))).unwrap(),
        r#"{"a":1}"#
    );
    assert_eq!(
        body_text(Some(&json!(r#"{"t":"\u007b\u007bTOKEN}}","t":"x"}"#))).unwrap(),
        r#"{"t":"x"}"#
    );
    assert_eq!(
        body_text(Some(&json!(r#"{"t":"\u007b\u007bTOKEN}}"}"#))).unwrap(),
        r#"{"t":"{{TOKEN}}"}"#
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
    let lines: Vec<&str> = text.lines().collect();
    let at = lines
        .iter()
        .position(|l| l.starts_with("Example JSON for test.v1.Echo/Say"))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(lines[at + 1]).unwrap(),
        *example
    );

    // A message inside itself stops at once: `{}` where it would nest, and the text says so.
    assert_eq!(example["inner"], json!({"note": "", "child": {}}));
    assert!(text.lines().any(|l| l
        == "(Recursive: test.v1.Inner contains itself; the example writes {} where a message \
            would nest inside itself.)"));
    assert_eq!(data["recursive"], json!(["test.v1.Inner"]));
    assert_eq!(data["exampleCut"], false);
    assert_eq!(data["truncated"], false);
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
    let r = services_report("h:1", true, &names, &p, None);
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
    let r = services_report("h:1", false, &many, &p, None);
    assert!(r.message.starts_with("201 services at h:1 (TLS):"));
    assert!(r
        .message
        .contains("…showing the first 200 of 201 services."));
    assert_eq!(r.data["services"].as_array().unwrap().len(), MAX_SERVICES);
    assert_eq!(r.data["truncated"], true);

    let r = services_report("h:1", true, &[], &p, None);
    assert_eq!(r.message, "0 services at h:1 (plaintext):\n  (none listed)");
}

/// Run `work` on a thread of its own and fail if it takes longer than `limit`: a bound that broke
/// would otherwise hang the test (the thread is left behind; the test process ends anyway).
fn within<T: Send + 'static>(limit: Duration, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    match rx.recv_timeout(limit) {
        Ok(out) => out,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("did not finish within {limit:?}: a bound is broken")
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("the work panicked"),
    }
}

fn data_bytes(v: &Value) -> usize {
    serde_json::to_string(v).unwrap().len()
}

/// Field entries in an example (every object entry and array item, nested).
fn entries(v: &Value) -> usize {
    match v {
        Value::Object(m) => m.values().map(|v| 1 + entries(v)).sum(),
        Value::Array(a) => a.iter().map(|v| 1 + entries(v)).sum(),
        _ => 0,
    }
}

/// A schema built to blow up a naive walk: `bomb.Node` has `width - 1` fields of its own type and
/// a string; `bomb.L0`…`bomb.L4` each have `width` fields of the next level (distinct types, so
/// only a budget stops a walk through them); `bomb.Svc` has `methods` unary methods from a
/// `Node` to an `L0`.
fn bomb_pool(width: i32, methods: usize) -> DescriptorPool {
    let mut node: Vec<FieldDescriptorProto> = (1..width)
        .map(|n| {
            let name = format!("n{n}");
            field(&name, &name, n, Type::Message, Some(".bomb.Node"))
        })
        .collect();
    node.push(field("label", "label", width, Type::String, None));
    let mut messages = vec![message("Node", node)];
    for level in 0..5 {
        let next = format!(".bomb.L{}", level + 1);
        messages.push(message(
            &format!("L{level}"),
            (1..=width)
                .map(|n| {
                    let name = format!("f{n}");
                    if level < 4 {
                        field(&name, &name, n, Type::Message, Some(&next))
                    } else {
                        field(&name, &name, n, Type::Bool, None)
                    }
                })
                .collect(),
        ));
    }
    let file = FileDescriptorProto {
        name: Some("bomb.proto".into()),
        package: Some("bomb".into()),
        syntax: Some("proto3".into()),
        message_type: messages,
        service: vec![ServiceDescriptorProto {
            name: Some("Svc".into()),
            method: (0..methods)
                .map(|i| MethodDescriptorProto {
                    name: Some(format!("M{i}")),
                    input_type: Some(".bomb.Node".into()),
                    output_type: Some(".bomb.L0".into()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();
    p
}

/// A message with 199 fields of its own type: walked naively its example is 199^4 objects. It is
/// described at once, small, with `{}` where it would nest inside itself, and the example is
/// still a request the method parses.
#[test]
fn a_message_that_contains_itself_many_times_is_described_quickly_and_small() {
    let p = bomb_pool(200, 1);
    let pool = p.clone();
    let (text, data, cost) = within(Duration::from_secs(20), move || {
        shape::describe_costed(&shape::resolve(&pool, "bomb.Svc/M0").unwrap())
    });
    assert_bounded(&text, &data, cost);
    let example = &data["methods"][0]["requestExample"];
    assert_eq!(example["n1"], json!({}), "{{}} where Node would nest");
    assert_eq!(example["n199"], json!({}));
    assert_eq!(example["label"], "");
    assert_eq!(
        entries(example),
        200,
        "one level, nothing nested inside itself"
    );
    DynamicMessage::deserialize(p.get_message_by_name("bomb.Node").unwrap(), example.clone())
        .expect("the example parses as the request");
    assert!(text.contains(
        "(Recursive: bomb.Node contains itself; the example writes {} where a message would \
         nest inside itself.)"
    ));
    assert_eq!(data["recursive"], json!(["bomb.Node"]));
    assert_eq!(data["exampleCut"], false);
}

/// Five levels of 200 fields, each of the next level's type: nothing nests inside itself, so only
/// the shared example budget stops the walk (200^4 objects without it). It stops there and says
/// so, and the field lists stay whole.
#[test]
fn a_wide_tree_of_distinct_messages_spends_one_example_budget_and_says_so() {
    let p = bomb_pool(200, 1);
    let (text, data, cost) = within(Duration::from_secs(20), move || {
        shape::describe_costed(&shape::resolve(&p, "bomb.L0").unwrap())
    });
    assert_bounded(&text, &data, cost);
    let example = &data["example"];
    assert!(example.is_object());
    assert!(
        entries(example) <= shape::EXAMPLE_NODES,
        "{}",
        entries(example)
    );
    assert!(data_bytes(example) <= shape::EXAMPLE_BYTES * 2);
    assert_eq!(data["exampleCut"], true);
    assert!(text.contains(
        "(The example JSON is cut short: one answer's examples hold at most 2000 values."
    ));
    assert!(text.len() <= shape::TEXT_BYTES, "{}", text.len());
    assert!(data_bytes(&data) <= shape::DATA_BYTES);
}

/// A service with more methods than one answer describes: at most [`shape::MAX_METHODS`], the
/// rest counted; their examples share one budget, so the whole answer is no bigger than one.
#[test]
fn a_service_with_many_methods_describes_a_bounded_number_on_one_budget() {
    let p = bomb_pool(200, shape::MAX_METHODS + 50);
    let (text, data, cost) = within(Duration::from_secs(20), move || {
        shape::describe_costed(&shape::resolve(&p, "bomb.Svc").unwrap())
    });
    assert_bounded(&text, &data, cost);
    assert!(
        text.starts_with("service bomb.Svc (150 methods)\n"),
        "{text}"
    );
    assert!(text.contains("…50 more methods not described; describe one by name"));
    assert_eq!(data["moreMethods"], 50);
    let methods = data["methods"].as_array().unwrap();
    assert_eq!(methods.len(), shape::MAX_METHODS);
    let spent: usize = methods.iter().map(|m| entries(&m["requestExample"])).sum();
    assert!(spent <= shape::EXAMPLE_NODES, "{spent}");
    assert_eq!(data["exampleCut"], true);
    assert!(text.len() <= shape::TEXT_BYTES, "{}", text.len());
    assert!(data_bytes(&data) <= shape::DATA_BYTES);
}

/// The bound every description keeps, whatever the schema: the text and the data within their
/// budgets, the walk within its visits, and the bytes of server-chosen names written — kept or not
/// — within what the answer kept, plus each described method's path (its example's heading) and a
/// few lines or entries past the budgets. Names built for lines or entries that were never going
/// to be kept would show here.
fn assert_bounded(text: &str, data: &Value, cost: shape::Cost) {
    assert!(text.len() <= shape::TEXT_BYTES, "text {}", text.len());
    assert!(
        data_bytes(data) <= shape::DATA_BYTES,
        "data {}",
        data_bytes(data)
    );
    assert!(cost.visits <= shape::MAX_VISITS, "{cost:?}");
    let methods = data["methods"].as_array().map_or(0, Vec::len)
        + data["moreMethods"].as_u64().unwrap_or(0) as usize;
    let names = text.len()
        + data_bytes(data)
        + methods.min(shape::MAX_METHODS) * 2 * shape::NAME_BYTES
        + 16 * 1024;
    assert!(cost.name_bytes <= names, "{cost:?}, at most {names}");
}

/// Five messages of 200 fields with 200-byte names, each field of the next message's type: the
/// text stops at its budget and the data at its own, both inside a message. Each field is
/// admitted on its own, so the message the data budget runs out in is there with the fields that
/// fit, and every cut is said.
#[test]
fn long_lists_are_cut_at_the_text_and_data_budgets_field_by_field_and_the_cut_is_said() {
    let long = |n: i32| format!("f{n}_{}", "x".repeat(200));
    let messages = (0..5)
        .map(|i| {
            let next = format!(".long.W{}", i + 1);
            message(
                &format!("W{i}"),
                (1..=shape::MAX_FIELDS as i32)
                    .map(|n| {
                        if i < 4 {
                            field(&long(n), &long(n), n, Type::Message, Some(&next))
                        } else {
                            field(&long(n), &long(n), n, Type::String, None)
                        }
                    })
                    .collect(),
            )
        })
        .collect();
    let file = FileDescriptorProto {
        name: Some("long.proto".into()),
        package: Some("long".into()),
        syntax: Some("proto3".into()),
        message_type: messages,
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();
    let (text, data, cost) = within(Duration::from_secs(20), move || {
        shape::describe_costed(&shape::resolve(&p, "long.W0").unwrap())
    });
    assert_bounded(&text, &data, cost);
    assert!(
        text.ends_with(
            "…the description is cut at 64 KiB (--json is cut too); describe one method or \
             message by name for the rest."
        ),
        "{}",
        &text[text.len() - 300..]
    );
    assert_eq!(data["truncated"], true);
    assert_eq!(data["namesCut"], false, "no name is over the limit");
    assert_eq!(data["exampleCut"], true);
    let messages = data["messages"].as_array().unwrap();
    let (last, whole) = messages.split_last().unwrap();
    for m in whole {
        assert_eq!(m["fields"].as_array().unwrap().len(), shape::MAX_FIELDS);
    }
    let fit = last["fields"].as_array().unwrap().len();
    assert!(
        fit > 0 && fit < shape::MAX_FIELDS,
        "the budget ran out inside {}: {fit} of its fields fit",
        last["name"]
    );
}

/// A schema built so that names it declares once are repeated in every field that refers to them:
/// an enum whose 20 values have 64 KiB names (an enum-typed field's type lists its values), a
/// oneof with a 256 KiB name (each member's line names it), and a 64 KiB package that each
/// relative type reference spells out in full. Described naively it writes hundreds of megabytes
/// to answer with a few bytes.
fn amplifying_pool() -> (DescriptorPool, String) {
    let package = format!("p{}", "x".repeat(64 * 1024));
    let fields = (1..=shape::MAX_FIELDS as i32)
        .map(|n| {
            let name = format!("f{n}");
            match n % 3 {
                0 => field(&name, &name, n, Type::Enum, Some("E")),
                1 => in_oneof(field(&name, &name, n, Type::String, None), 0),
                _ => field(&name, &name, n, Type::Message, Some("Leaf")),
            }
        })
        .collect();
    let mut root = message("Root", fields);
    root.oneof_decl = vec![OneofDescriptorProto {
        name: Some(format!("o{}", "y".repeat(256 * 1024))),
        ..Default::default()
    }];
    let file = FileDescriptorProto {
        name: Some("amp.proto".into()),
        package: Some(package.clone()),
        syntax: Some("proto3".into()),
        message_type: vec![
            root,
            message("Leaf", vec![field("s", "s", 1, Type::String, None)]),
        ],
        enum_type: vec![EnumDescriptorProto {
            name: Some("E".into()),
            value: (0..20)
                .map(|i| EnumValueDescriptorProto {
                    name: Some(format!("V{i}_{}", "z".repeat(64 * 1024))),
                    number: Some(i),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }],
        service: vec![ServiceDescriptorProto {
            name: Some("Svc".into()),
            method: vec![MethodDescriptorProto {
                name: Some("Call".into()),
                input_type: Some("Root".into()),
                output_type: Some("Leaf".into()),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();
    (p, package)
}

/// Whether `name` is a server name as an answer writes it when it was too long: cut, then `…`.
fn cut_name(name: &str) -> bool {
    name.ends_with('…') && name.len() <= shape::NAME_BYTES + '…'.len_utf8()
}

/// Every name the amplifying schema repeats is written once per use at most [`shape::NAME_BYTES`]
/// long, and a field's enum values at about [`shape::VALUES_BYTES`]: describing the method, the
/// message, the enum and listing the service each costs no more than the budgets, at once, and
/// says that names were cut.
#[test]
fn names_a_schema_repeats_in_every_field_cost_no_more_than_the_budgets() {
    let (p, package) = amplifying_pool();
    for name in [
        format!("{package}.Svc/Call"),
        format!("{package}.Root"),
        format!("{package}.Svc"),
    ] {
        let pool = p.clone();
        let started = std::time::Instant::now();
        let (text, data, cost) = within(Duration::from_secs(10), move || {
            shape::describe_costed(&shape::resolve(&pool, &name).unwrap())
        });
        let took = started.elapsed();
        assert!(took < Duration::from_secs(5), "{took:?}");
        assert_bounded(&text, &data, cost);
        assert_eq!(data["namesCut"], true);
        assert_eq!(data["truncated"], true);
        assert!(text.contains(&shape::names_cut_note()), "{}", text.len());
        let root = data["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["fields"].as_array().unwrap().len() == shape::MAX_FIELDS)
            .expect("Root is listed whole");
        assert!(cut_name(root["name"].as_str().unwrap()));
        // f1: a member of the oneof; f2: a Leaf; f3: an enum.
        let fields = root["fields"].as_array().unwrap();
        assert!(cut_name(fields[0]["oneof"].as_str().unwrap()));
        assert!(cut_name(fields[1]["type"].as_str().unwrap()));
        let enum_type = fields[2]["type"].as_str().unwrap();
        assert!(
            enum_type.len() <= shape::VALUES_BYTES + 2 * (shape::NAME_BYTES + 3) + 32,
            "{}",
            enum_type.len()
        );
        assert!(enum_type.ends_with(" more)"), "the rest are counted");
    }

    let pool = p.clone();
    let enum_name = format!("{package}.E");
    let (text, data, cost) = within(Duration::from_secs(10), move || {
        shape::describe_costed(&shape::resolve(&pool, &enum_name).unwrap())
    });
    assert_bounded(&text, &data, cost);
    assert!(cut_name(data["enum"].as_str().unwrap()));
    let values = data["values"].as_array().unwrap();
    assert_eq!(values.len(), 20);
    assert!(values.iter().all(|v| cut_name(v["name"].as_str().unwrap())));
    assert_eq!(data["truncated"], true, "its names are cut");
    assert!(text.ends_with(&shape::names_cut_note()));

    let names = vec![format!("{package}.Svc")];
    let r = within(Duration::from_secs(10), move || {
        services_report("h:1", true, &names, &p, None)
    });
    assert!(r.message.len() <= SERVICES_TEXT_BYTES);
    assert!(data_bytes(&r.data) <= SERVICES_DATA_BYTES);
    assert!(r.message.ends_with(&shape::names_cut_note()));
    assert!(cut_name(r.data["services"][0]["name"].as_str().unwrap()));
    let method = &r.data["services"][0]["methods"][0];
    assert!(cut_name(method["input"].as_str().unwrap()));
    assert_eq!(r.data["namesCut"], true);
    assert_eq!(r.data["truncated"], true);
}

/// `count` messages `R0`… in a package with a long name, each holding a field of its own type and
/// `filler` string fields with short JSON names (cheap in an example) and 200-byte proto names
/// (not cheap in the data), and a `Root` with a field of each.
fn recursive_pool(count: i32, filler: i32) -> DescriptorPool {
    let package = format!("r{}", "q".repeat(4096));
    let mut messages: Vec<DescriptorProto> = (0..count)
        .map(|i| {
            let own = format!("R{i}");
            let mut fields = vec![field("again", "again", 1, Type::Message, Some(&own))];
            fields.extend((0..filler).map(|n| {
                let name = format!("s{n}_{}", "w".repeat(200));
                field(&name, &format!("a{n}"), n + 2, Type::String, None)
            }));
            message(&own, fields)
        })
        .collect();
    messages.push(message(
        "Root",
        (0..count)
            .map(|i| {
                let name = format!("r{i}");
                field(&name, &name, i + 1, Type::Message, Some(&format!("R{i}")))
            })
            .collect(),
    ));
    let file = FileDescriptorProto {
        name: Some("rec.proto".into()),
        package: Some(package),
        syntax: Some("proto3".into()),
        message_type: messages,
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();
    p
}

/// The messages written `{}` because they nest inside themselves are data too: their names are cut
/// like any other, at most five are given and the rest counted, and they are admitted against the
/// data budget like every other entry — when it ran out, they are counted, not added past it.
#[test]
fn recursive_names_are_cut_counted_and_within_the_data_budget() {
    let p = recursive_pool(6, 0);
    let root = format!("r{}.Root", "q".repeat(4096));
    let (text, data, cost) = shape::describe_costed(&shape::resolve(&p, &root).unwrap());
    assert_bounded(&text, &data, cost);
    let recursive = data["recursive"].as_array().unwrap();
    assert_eq!(recursive.len(), 5);
    assert!(recursive.iter().all(|n| cut_name(n.as_str().unwrap())));
    assert_eq!(data["moreRecursive"], 1);
    assert!(
        text.contains(" and 1 more contain themselves; the example writes {} where"),
        "{text}"
    );

    // Enough filler to spend the data budget before the names come.
    let p = recursive_pool(60, 30);
    let (text, data, cost) = within(Duration::from_secs(20), move || {
        shape::describe_costed(&shape::resolve(&p, &root).unwrap())
    });
    assert_bounded(&text, &data, cost);
    assert_eq!(data["truncated"], true);
    let given = data["recursive"].as_array().unwrap().len() as u64;
    assert!(given < 5, "{given}: the data was full");
    assert!(data["moreRecursive"].as_u64().unwrap() + given > 5);
}

/// A server may mark a message as a map entry without giving it a value field (or a key). Such a
/// field is described as the repeated message it is, never by assuming the entry's fields.
#[test]
fn a_map_entry_without_its_value_field_is_described_not_a_panic() {
    let mut holder = message(
        "Holder",
        vec![repeated(field(
            "odd",
            "odd",
            1,
            Type::Message,
            Some(".odd.Holder.OddEntry"),
        ))],
    );
    holder.nested_type = vec![DescriptorProto {
        name: Some("OddEntry".into()),
        field: vec![field("key", "key", 1, Type::String, None)],
        options: Some(MessageOptions {
            map_entry: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    }];
    let file = FileDescriptorProto {
        name: Some("odd.proto".into()),
        package: Some("odd".into()),
        syntax: Some("proto3".into()),
        message_type: vec![holder],
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();
    let (text, data) = within(Duration::from_secs(10), move || {
        shape::describe(&shape::resolve(&p, "odd.Holder").unwrap())
    });
    assert!(
        text.lines()
            .any(|l| l == "  odd: repeated odd.Holder.OddEntry"),
        "{text}"
    );
    assert_eq!(data["example"]["odd"], json!([{"key": ""}]));
}

/// Forty-one messages of 200 short fields, chained: every line and entry is small, so the budgets
/// alone would let the walk go on through 8000 fields. The visit bound stops it, and says so.
#[test]
fn a_walk_stops_at_its_visit_bound_and_says_so() {
    let short = |n: i32| {
        format!(
            "{}{}",
            (b'a' + (n / 26) as u8) as char,
            (b'a' + (n % 26) as u8) as char
        )
    };
    let messages = (0..=shape::MAX_MESSAGES as i32)
        .map(|i| {
            let mut fields: Vec<FieldDescriptorProto> = (1..shape::MAX_FIELDS as i32)
                .map(|n| field(&short(n), &short(n), n, Type::Bool, None))
                .collect();
            let next = format!(".chain.C{}", i + 1);
            if i < shape::MAX_MESSAGES as i32 {
                fields.push(field(
                    "n",
                    "n",
                    shape::MAX_FIELDS as i32,
                    Type::Message,
                    Some(&next),
                ));
            }
            message(&format!("C{i}"), fields)
        })
        .collect();
    let file = FileDescriptorProto {
        name: Some("chain.proto".into()),
        package: Some("chain".into()),
        syntax: Some("proto3".into()),
        message_type: messages,
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();
    let (text, data, cost) = within(Duration::from_secs(20), move || {
        shape::describe_costed(&shape::resolve(&p, "chain.C0").unwrap())
    });
    assert_bounded(&text, &data, cost);
    assert_eq!(cost.visits, shape::MAX_VISITS);
    assert_eq!(data["walkCut"], true);
    assert_eq!(data["truncated"], true);
    assert_eq!(data["messagesCut"], false, "the walk stopped first");
    assert!(
        text.ends_with(
            "(The schema is too large to walk whole: this description stopped after 6000 schema \
             nodes; describe one method or message by name.)"
        ),
        "{}",
        &text[text.len() - 300..]
    );
}

/// A listing whose reflection reached its limit says which services it could not load, and why.
#[test]
fn a_services_listing_says_when_reflection_stopped_at_its_limit() {
    let p = pool();
    let names = vec![
        "test.v1.Echo".to_string(),
        "other.Svc".to_string(),
        "third.Svc".to_string(),
    ];
    let r = services_report("h:1", true, &names, &p, Some(1));
    assert!(r.message.contains(
        "  other.Svc\n    (not described: reflection stopped at its limit)\n  third.Svc\n    \
         (not described: reflection stopped at its limit)"
    ));
    assert!(r.message.ends_with(
        "(Reflection stops at 500 descriptor files or 16 MiB per listing; the services after \
         that are listed without their methods.)"
    ));
    assert_eq!(r.data["reflectionStopped"], true);
    assert_eq!(r.data["truncated"], true);
    assert_eq!(r.data["services"][0]["described"], true);
}

/// A server that declares thousands of methods with long names: the listing stops at its text
/// and data budgets, and both say so.
#[test]
fn a_services_listing_is_cut_at_its_byte_budgets_and_says_so() {
    let file = FileDescriptorProto {
        name: Some("many.proto".into()),
        package: Some("many".into()),
        syntax: Some("proto3".into()),
        message_type: vec![message("Req", Vec::new())],
        service: vec![ServiceDescriptorProto {
            name: Some("Svc".into()),
            method: (0..3000)
                .map(|i| MethodDescriptorProto {
                    name: Some(format!("Method{i}_{}", "m".repeat(60))),
                    input_type: Some(".many.Req".into()),
                    output_type: Some(".many.Req".into()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut p = DescriptorPool::new();
    p.add_file_descriptor_proto(file).unwrap();
    let names = vec!["many.Svc".to_string(), "other.Svc".to_string()];
    let r = within(Duration::from_secs(20), move || {
        services_report("h:1", true, &names, &p, None)
    });
    assert!(
        r.message.len() <= SERVICES_TEXT_BYTES,
        "{}",
        r.message.len()
    );
    assert!(r
        .message
        .starts_with("2 services at h:1 (plaintext):\n  many.Svc\n"));
    assert!(
        r.message.ends_with(
            "…the listing is cut at 64 KiB: 0 of 2 services are listed in full (--json is cut \
             too). Describe one service with `agent-studio grpc describe <target> \
             <package.Service>`."
        ),
        "{}",
        &r.message[r.message.len() - 300..]
    );
    assert!(data_bytes(&r.data) <= SERVICES_DATA_BYTES);
    assert_eq!(r.data["truncated"], true);
    assert_eq!(r.data["total"], 2);
    let services = r.data["services"].as_array().unwrap();
    assert_eq!(services.len(), 1, "the budget ran out inside the first");
    assert_eq!(services[0]["methodsCut"], true);
    let listed = services[0]["methods"].as_array().unwrap().len();
    assert!(listed > 100 && listed < 3000, "{listed}");
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
