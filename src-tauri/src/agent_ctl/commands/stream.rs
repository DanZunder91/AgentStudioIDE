//! WebSocket and gRPC tools: an agent can hold a short conversation with a WebSocket server, and
//! list, describe and call a gRPC server's methods, through the API client's own engines
//! ([`crate::ws`], [`crate::grpc`]).
//!
//! Rules on top of the module-wide ones ([`crate::agent_ctl`]):
//! * Everything here is agent-authored, so nothing resolves Vault variables: a URL, target,
//!   header, message, method or body containing `{{` is refused before anything connects.
//! * Every answer is bounded — time, message count, bytes kept — and says what it cut.
//! * What reaches a server is visible to the user: an exchange and a call are rows in the Network
//!   view (the engines record them like the consoles' traffic), and a call is also added to the
//!   API client's History (`grpcCall` event). `grpc services` and `grpc describe` only read a
//!   server's schema, like `db list` reads the store, and leave no row.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::agent_ctl::registry::{Args, Param, ParamKind, ToolCtx, ToolFuture, ToolOk, ToolSpec};
use crate::grpc::{self, GrpcHeader, GrpcOutcome, GrpcRequest, Reflection};
use crate::netcap::record::Tap;
use crate::ws::{self, Direction, Exchange, ExchangeEnd, ExchangeSpec, PayloadKind, WsHeader};

#[path = "stream_shape.rs"]
pub mod shape;

/// `ws exchange`: listening after the last send, default and ceiling (ms).
pub const WAIT_MS_DEFAULT: i64 = 2_000;
pub const WAIT_MS_MAX: i64 = 30_000;
/// `ws exchange`: messages collected from the server, default and ceiling.
pub const MAX_MESSAGES_DEFAULT: i64 = 50;
pub const MAX_MESSAGES_MAX: i64 = 500;
/// `ws exchange`: messages an agent may send, and the size of each.
pub const MAX_SENDS: usize = 100;
pub const MAX_SEND_BYTES: usize = 1024 * 1024;
/// `ws exchange`: the handshake's deadline.
pub const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Headers (WebSocket handshake) or metadata entries (gRPC) per request.
pub const MAX_HEADERS: usize = 50;
/// `grpc call`: the whole call's deadline, default and ceiling (ms). Under the 120 s the
/// listener gives a tool.
pub const GRPC_TIMEOUT_MS_DEFAULT: i64 = 30_000;
pub const GRPC_TIMEOUT_MS_MAX: i64 = 60_000;
/// `grpc call`: the request body's size.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// `grpc call`: the response JSON kept.
pub const RESPONSE_TEXT_BYTES: usize = 64 * 1024;
/// `grpc call`: response metadata entries kept, and each value's size.
pub const MAX_METADATA: usize = 50;
pub const METADATA_VALUE_BYTES: usize = 1024;
/// `grpc services` / `grpc describe`: the whole reflection's deadline.
pub const REFLECTION_LIMIT: Duration = Duration::from_secs(60);
/// `grpc services`: services described (each is one reflection round trip).
pub const MAX_SERVICES: usize = 200;
/// `grpc services`: the listing's text, and its data serialized. A server decides how many
/// methods a service has and how long their names are, so the count cap alone bounds nothing.
pub const SERVICES_TEXT_BYTES: usize = 64 * 1024;
pub const SERVICES_DATA_BYTES: usize = 256 * 1024;

const TARGET_PARAM: Param = Param::new(
    "target",
    ParamKind::String,
    "host:port, http://host:port (plaintext) or https://host:port (TLS).",
)
.required()
.positional();

const PLAINTEXT_PARAM: Param = Param::new(
    "plaintext",
    ParamKind::Bool,
    "Plaintext HTTP/2 (h2c) instead of TLS, for a local or internal server.",
);

pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "ws_exchange",
        cli: &["ws", "exchange"],
        summary: "Connect to a WebSocket, send messages in order, collect what the server sends \
                  back, close, and print the transcript.",
        details: "url: ws:// or wss:// (quote it). Each --send is one text message, sent in \
                  order as soon as the socket opens (at most 100, 1 MiB each). Listening stops \
                  --wait-ms after the last send (default 2000, at most 30000), after \
                  --max-messages from the server (default 50, at most 500), or when the server \
                  closes. Each message's text is cut at 4 KiB and a transcript keeps 256 KiB of \
                  text; whatever is cut is marked. Binary messages are listed by size. The \
                  session shows in Agent Studio's Network view. A URL, header or message naming \
                  a Vault variable ({{…}}) is refused.",
        params: &[
            Param::new(
                "url",
                ParamKind::String,
                "The WebSocket URL (ws:// or wss://).",
            )
            .required()
            .positional(),
            Param::new(
                "header",
                ParamKind::StringList,
                "A handshake header, 'Name: value' (repeatable).",
            ),
            Param::new(
                "send",
                ParamKind::StringList,
                "A text message to send (repeatable; sent in order).",
            ),
            Param::new(
                "wait_ms",
                ParamKind::Integer,
                "How long to listen after the last send, in ms (default 2000, max 30000).",
            ),
            Param::new(
                "max_messages",
                ParamKind::Integer,
                "Stop after this many messages from the server (default 50, max 500).",
            ),
        ],
        run: run_ws_exchange,
    },
    ToolSpec {
        name: "grpc_services",
        cli: &["grpc", "services"],
        summary: "List a gRPC server's services and methods, with their request and response \
                  types, through server reflection.",
        details: "The server must have reflection enabled. TLS unless --plaintext (or an \
                  http:// target). At most 200 services are described, reflection loads at most \
                  500 descriptor files (16 MiB), names longer than 256 bytes are cut, and the \
                  listing is cut at 64 KiB (--json at 256 KiB); every cut is said. A target \
                  naming a Vault variable ({{…}}) is refused.",
        params: &[TARGET_PARAM, PLAINTEXT_PARAM],
        run: run_grpc_services,
    },
    ToolSpec {
        name: "grpc_describe",
        cli: &["grpc", "describe"],
        summary: "Show the request and response message shapes of a gRPC method, service or \
                  message, with an example request JSON to send.",
        details: "name: package.Service/Method, package.Service.Method, package.Service, or a \
                  message or enum (package.Message). Fields are listed by their JSON names; a \
                  request may use those or the .proto names. One answer spells out at most 100 \
                  methods and 40 messages of 200 fields, walks at most 6000 schema nodes, cuts \
                  names longer than 256 bytes, and its example JSON holds at most 2000 values (a \
                  message nested inside itself is written {}); the text is cut at 64 KiB and \
                  --json at 256 KiB. Every cut is said. Through server reflection, like grpc \
                  services (at most 500 descriptor files, 16 MiB).",
        params: &[
            TARGET_PARAM,
            Param::new(
                "name",
                ParamKind::String,
                "What to describe: package.Service/Method, a service, or a message.",
            )
            .required()
            .positional(),
            PLAINTEXT_PARAM,
        ],
        run: run_grpc_describe,
    },
    ToolSpec {
        name: "grpc_call",
        cli: &["grpc", "call"],
        summary: "Make a unary gRPC call with a JSON request body and print the status, the \
                  response metadata and the JSON response.",
        details: "method: package.Service/Method (see grpc services). --body is the request \
                  message as JSON (default {}; see grpc describe for its shape). --header adds \
                  request metadata, 'name: value' (repeatable). The whole call (connect, \
                  reflection, the call) must finish within --timeout-ms (default 30000, at most \
                  60000). A non-OK gRPC status is an answer, not a failure. The response is cut \
                  at 64 KiB, and the message says so. The call shows in Agent Studio's Network \
                  view and History. A target, header or body naming a Vault variable ({{…}}) is \
                  refused.",
        params: &[
            TARGET_PARAM,
            Param::new(
                "method",
                ParamKind::String,
                "The method, package.Service/Method.",
            )
            .required()
            .positional(),
            Param::new(
                "body",
                ParamKind::Json,
                "The request message as JSON (default {}).",
            ),
            Param::new(
                "header",
                ParamKind::StringList,
                "Request metadata, 'name: value' (repeatable).",
            ),
            PLAINTEXT_PARAM,
            Param::new(
                "timeout_ms",
                ParamKind::Integer,
                "The whole call's deadline in ms (default 30000, max 60000).",
            ),
        ],
        run: run_grpc_call,
    },
];

fn run_ws_exchange(_ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move { ws_exchange_with(&args, &Tap::global()).await })
}

fn run_grpc_services(_ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move { grpc_services(&args).await })
}

fn run_grpc_describe(_ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move { grpc_describe(&args).await })
}

fn run_grpc_call(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move { grpc_call_with(&ctx, &args, &Tap::global()).await })
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared argument rules.
// ─────────────────────────────────────────────────────────────────────────────

/// Rounds of decoding [`names_vault_var`] undoes: enough for an encoding applied two or three
/// times over, and a bound on the work.
const DECODE_ROUNDS: usize = 4;

/// Whether `text` names a Vault variable: a `{{`, also when its braces are written encoded —
/// percent-encoded (`%7B`, any case, encoded again as `%257B`, …) or as a JSON escape
/// (`\u007b`), alone or mixed with a literal brace. A placeholder that only appears once decoded
/// is still one: whatever later decodes the text (a URL parser, a JSON parser, the console
/// replaying History) would hand a Vault resolver a live `{{VAR}}`.
pub fn names_vault_var(text: &str) -> bool {
    let mut current = std::borrow::Cow::Borrowed(text);
    for _ in 0..DECODE_ROUNDS {
        if current.contains("{{") {
            return true;
        }
        match decode_once(&current) {
            Some(next) => current = std::borrow::Cow::Owned(next),
            None => return false,
        }
    }
    current.contains("{{")
}

/// `text` with one layer of percent-encoding and of JSON `\uXXXX` escapes undone, or `None` when
/// it holds neither.
fn decode_once(text: &str) -> Option<String> {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    if !text.contains('%') && !text.contains("\\u") {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut changed = false;
    let mut i = 0;
    while i < bytes.len() {
        let percent = (bytes[i] == b'%')
            .then(|| Some((hex(*bytes.get(i + 1)?)? << 4) | hex(*bytes.get(i + 2)?)?))
            .flatten();
        let unicode = (bytes[i] == b'\\' && bytes.get(i + 1) == Some(&b'u'))
            .then(|| {
                let digits = std::str::from_utf8(bytes.get(i + 2..i + 6)?).ok()?;
                char::from_u32(u32::from_str_radix(digits, 16).ok()?)
            })
            .flatten();
        if let Some(byte) = percent {
            out.push(byte);
            i += 3;
            changed = true;
        } else if let Some(c) = unicode {
            out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
            i += 6;
            changed = true;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    changed.then(|| String::from_utf8_lossy(&out).into_owned())
}

/// Whether any string or key in `value`, decoded, names a Vault variable (see
/// [`names_vault_var`]). The JSON text alone is not enough: `"\u007b\u007bX}}"` holds no `{{`
/// until it is parsed, and the parsed message is what a server receives.
pub fn json_names_vault_var(value: &Value) -> bool {
    match value {
        Value::String(s) => names_vault_var(s),
        Value::Array(items) => items.iter().any(json_names_vault_var),
        Value::Object(map) => map
            .iter()
            .any(|(k, v)| names_vault_var(k) || json_names_vault_var(v)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

/// The refusal for a `what` that names a Vault variable.
fn vault_refusal(what: &str) -> String {
    format!(
        "The {what} contains an Agent Studio Vault variable ({{{{…}}}}, written out or encoded). \
         Agents cannot use the user's saved secrets: put the value itself in the {what}, or ask \
         the user to send it from the API client. Nothing was sent."
    )
}

/// Refuse any field that names a Vault variable, in any encoding [`names_vault_var`] sees
/// through. Agent-authored text never resolves one: if it did, an agent could send a saved
/// secret to a host of its choosing.
pub fn refuse_vault_refs(fields: &[(&str, &str)]) -> Result<(), String> {
    match fields.iter().find(|(_, text)| names_vault_var(text)) {
        Some((what, _)) => Err(vault_refusal(what)),
        None => Ok(()),
    }
}

/// `text` cut to `max` bytes for quoting in a sentence.
fn quote(text: &str, max: usize) -> String {
    let (cut, was_cut) = ws::cut_text(text, max);
    if was_cut {
        format!("{cut}…")
    } else {
        cut.to_string()
    }
}

/// `Name: value` → `(Name, value)`, both trimmed.
pub fn parse_header(line: &str) -> Result<(String, String), String> {
    let (name, value) = line.split_once(':').ok_or_else(|| {
        format!(
            "A header is 'Name: value'; `{}` has no colon.",
            quote(line, 80)
        )
    })?;
    let name = name.trim();
    if name.is_empty() {
        return Err(format!(
            "A header is 'Name: value'; `{}` has no name.",
            quote(line, 80)
        ));
    }
    Ok((name.to_string(), value.trim().to_string()))
}

/// Every `--header`, parsed, at most [`MAX_HEADERS`].
fn headers(args: &Args) -> Result<Vec<(String, String)>, String> {
    let lines = args.list("header");
    if lines.len() > MAX_HEADERS {
        return Err(format!(
            "At most {MAX_HEADERS} headers; {} were given.",
            lines.len()
        ));
    }
    lines.iter().map(|l| parse_header(l)).collect()
}

/// An integer parameter, `default` when absent, refused outside `min..=max` (never clamped:
/// the agent learns the bound instead of getting less than it asked for without a word).
pub fn bounded(args: &Args, name: &str, default: i64, min: i64, max: i64) -> Result<i64, String> {
    let out_of_range = || format!("`{name}` must be between {min} and {max}");
    let value = match args.json(name) {
        None | Some(Value::Null) => default,
        Some(v) => v.as_i64().ok_or_else(|| format!("{}.", out_of_range()))?,
    };
    if (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(format!("{}; {value} is not.", out_of_range()))
    }
}

/// `url` without a `user:password@` part, for anything shown back.
pub fn display_url(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ws exchange
// ─────────────────────────────────────────────────────────────────────────────

/// The exchange `args` ask for, every rule checked before anything connects.
pub fn ws_spec(args: &Args) -> Result<ExchangeSpec, String> {
    let url = args.req_str("url")?;
    let header_lines = args.list("header");
    let sends = args.list("send");
    let mut fields = vec![("URL", url)];
    fields.extend(header_lines.iter().map(|h| ("header", h.as_str())));
    fields.extend(sends.iter().map(|m| ("message", m.as_str())));
    refuse_vault_refs(&fields)?;

    let scheme = url.split("://").next().unwrap_or("").to_ascii_lowercase();
    if url.split_once("://").is_none() || !matches!(scheme.as_str(), "ws" | "wss") {
        return Err(format!(
            "A WebSocket URL starts with ws:// or wss://; `{}` does not.",
            quote(&display_url(url), 120)
        ));
    }
    let headers = headers(args)?
        .into_iter()
        .map(|(name, value)| WsHeader { name, value })
        .collect();
    if sends.len() > MAX_SENDS {
        return Err(format!(
            "At most {MAX_SENDS} messages per exchange; {} were given.",
            sends.len()
        ));
    }
    if let Some(i) = sends.iter().position(|m| m.len() > MAX_SEND_BYTES) {
        return Err(format!(
            "Message {} is {} bytes; at most {MAX_SEND_BYTES} per message.",
            i + 1,
            sends[i].len()
        ));
    }
    let wait = bounded(args, "wait_ms", WAIT_MS_DEFAULT, 0, WAIT_MS_MAX)?;
    let max_messages = bounded(
        args,
        "max_messages",
        MAX_MESSAGES_DEFAULT,
        1,
        MAX_MESSAGES_MAX,
    )?;
    Ok(ExchangeSpec {
        url: url.to_string(),
        headers,
        send: sends,
        wait: Duration::from_millis(wait as u64),
        max_messages: max_messages as usize,
        connect_timeout: WS_CONNECT_TIMEOUT,
        send_budget: ws::SEND_BUDGET,
    })
}

/// `ws_exchange`, recorded on `tap` (the app passes the Network view's).
pub async fn ws_exchange_with(args: &Args, tap: &Tap) -> Result<ToolOk, String> {
    let spec = ws_spec(args)?;
    let shown = display_url(&spec.url);
    let wait_ms = spec.wait.as_millis();
    let max_messages = spec.max_messages;
    let transcript = ws::exchange(spec, tap)
        .await
        .map_err(|e| format!("Could not open a WebSocket to {shown}: {e}"))?;
    let message = ws_message(&shown, wait_ms, max_messages, &transcript);
    let mut data = serde_json::to_value(&transcript).unwrap_or(Value::Null);
    data["url"] = json!(shown);
    data["truncated"] = json!(transcript.entries.iter().any(|e| e.truncated));
    Ok(ToolOk::new(message, data))
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The transcript as the agent reads it: a summary line, one line per message (text as a JSON
/// string, so a line is a message), and what was cut or not done.
pub fn ws_message(url: &str, wait_ms: u128, max_messages: usize, t: &Exchange) -> String {
    let end = match &t.end {
        ExchangeEnd::Waited => format!(
            "listened {wait_ms} ms after the last send, then Agent Studio closed the socket"
        ),
        ExchangeEnd::MaxMessages => format!(
            "stopped at {} (--max-messages); the server may have sent more",
            plural(max_messages, "message", "messages")
        ),
        ExchangeEnd::ServerClosed { code, reason } => {
            let code = code.map(|c| format!(" with code {c}")).unwrap_or_default();
            let reason = if reason.is_empty() {
                String::new()
            } else {
                format!(" ({})", Value::String(quote(reason, 200)))
            };
            format!("the server closed the socket{code}{reason}")
        }
        ExchangeEnd::SendStalled => format!(
            "the server stopped reading; not every message went out within {} s",
            ws::SEND_BUDGET.as_secs()
        ),
        ExchangeEnd::Error { message } => format!("the socket failed: {message}"),
    };
    let unsent = if t.unsent > 0 {
        format!(", {} NOT sent", plural(t.unsent, "message", "messages"))
    } else {
        String::new()
    };
    let mut lines = vec![format!(
        "WebSocket {url}: opened in {} ms; sent {}{unsent}; received {}; {end}.",
        t.handshake_ms,
        t.sent,
        plural(t.received, "message", "messages"),
    )];
    for e in &t.entries {
        let arrow = match e.direction {
            Direction::Sent => "→",
            Direction::Received => "←",
        };
        let body = match (e.kind, &e.text) {
            (PayloadKind::Binary, _) => format!("binary, {}", plural(e.bytes, "byte", "bytes")),
            (PayloadKind::Text, None) => format!(
                "text, {} (not kept: the transcript's text limit is reached)",
                plural(e.bytes, "byte", "bytes")
            ),
            (PayloadKind::Text, Some(text)) => {
                let shown = Value::String(text.clone()).to_string();
                if e.truncated {
                    format!(
                        "{shown} … (cut; {} in all)",
                        plural(e.bytes, "byte", "bytes")
                    )
                } else {
                    shown
                }
            }
        };
        lines.push(format!("  +{} ms  {arrow} {body}", e.at_ms));
    }
    if t.entries.iter().any(|e| e.truncated) {
        lines.push(format!(
            "Text is cut at {} KiB per message and {} KiB per transcript.",
            ws::PREVIEW_BYTES / 1024,
            ws::TRANSCRIPT_TEXT_BYTES / 1024
        ));
    }
    lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// gRPC
// ─────────────────────────────────────────────────────────────────────────────

/// The endpoint (`host:port`) and transport a target names: `host:port` (TLS unless
/// `plaintext`), `http://host:port` (plaintext), `https://host:port` (TLS).
pub fn grpc_target(target: &str, plaintext: bool) -> Result<(String, bool), String> {
    let t = target.trim();
    let usage = "A gRPC target is host:port, http://host:port (plaintext) or https://host:port \
                 (TLS)";
    let (rest, plaintext) = match t.split_once("://") {
        None => (t, plaintext),
        Some((scheme, rest)) => match scheme.to_ascii_lowercase().as_str() {
            "http" => (rest, true),
            "https" if plaintext => {
                return Err(
                    "https:// is TLS: drop --plaintext, or use http:// for a plaintext \
                            server."
                        .to_string(),
                )
            }
            "https" => (rest, false),
            _ => return Err(format!("{usage}; not `{}`.", quote(t, 120))),
        },
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains('@') {
        return Err(
            "Put credentials in a --header (request metadata), not in the target.".to_string(),
        );
    }
    if rest.contains(['/', '?', '#']) || rest.contains(char::is_whitespace) {
        return Err(format!(
            "{usage}, without a path; not `{}`.",
            quote(&display_url(t), 120)
        ));
    }
    match rest.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.parse::<u16>().is_ok() => {
            Ok((rest.to_string(), plaintext))
        }
        _ => Err(format!(
            "{usage}, with the port (gRPC has no default one); not `{}`.",
            quote(t, 120)
        )),
    }
}

/// `package.Service/Method` or `package.Service.Method` → `(package.Service, Method)`.
pub fn split_method(text: &str) -> Result<(String, String), String> {
    let t = text.trim().trim_start_matches('/');
    let split = t.rsplit_once('/').or_else(|| t.rsplit_once('.'));
    match split {
        Some((service, method))
            if !service.is_empty() && !method.is_empty() && !service.contains('/') =>
        {
            Ok((service.to_string(), method.to_string()))
        }
        _ => Err(format!(
            "Name the method as package.Service/Method, not `{}` (list them with `agent-studio \
             grpc services <target>`).",
            quote(t, 120)
        )),
    }
}

/// The request body: `{}` when absent; an object, or a string holding one (some MCP clients send
/// JSON as a string), parsed.
pub fn body_value(body: Option<&Value>) -> Result<Value, String> {
    let not_an_object = || {
        "`body` must be a JSON object (the request message), like {\"name\":\"ada\"}.".to_string()
    };
    match body {
        None | Some(Value::Null) => Ok(json!({})),
        Some(v @ Value::Object(_)) => Ok(v.clone()),
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(v @ Value::Object(_)) => Ok(v),
            _ => Err(not_an_object()),
        },
        Some(_) => Err(not_an_object()),
    }
}

/// The request body as the JSON text that is checked, sent and recorded — one text for all
/// three. It is written from the parsed value, so an escape in what the agent wrote (`\u007b`)
/// is a plain character here, and a key given twice is there once.
pub fn body_text(body: Option<&Value>) -> Result<String, String> {
    body_value(body).map(|v| v.to_string())
}

fn transport(plaintext: bool) -> &'static str {
    if plaintext {
        "plaintext"
    } else {
        "TLS"
    }
}

/// The target and transport `args` name, the Vault rule checked first.
fn target_of(args: &Args, extra: &[(&str, &str)]) -> Result<(String, bool), String> {
    let target = args.req_str("target")?;
    let mut fields = vec![("target", target)];
    fields.extend_from_slice(extra);
    refuse_vault_refs(&fields)?;
    grpc_target(target, args.bool("plaintext"))
}

/// Run `work` within [`REFLECTION_LIMIT`].
async fn within_reflection_limit<T>(
    endpoint: &str,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(REFLECTION_LIMIT, work)
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "{endpoint} did not finish answering reflection within {} s.",
                REFLECTION_LIMIT.as_secs()
            ))
        })
}

async fn reflect(endpoint: &str, plaintext: bool) -> Result<Reflection, String> {
    Reflection::connect(endpoint, plaintext).await.map_err(|e| {
        format!(
            "Could not reflect {endpoint} ({}): {e}",
            transport(plaintext)
        )
    })
}

/// `grpc_services`.
pub async fn grpc_services(args: &Args) -> Result<ToolOk, String> {
    let (endpoint, plaintext) = target_of(args, &[])?;
    within_reflection_limit(&endpoint, async {
        let mut r = reflect(&endpoint, plaintext).await?;
        let names = r
            .list_services()
            .await
            .map_err(|e| format!("{endpoint} did not list its services: {e}"))?;
        let mut stopped_at = None;
        for (i, name) in names.iter().take(MAX_SERVICES).enumerate() {
            // A service the server will not describe is still listed, without methods; once the
            // session's limit is reached, nothing more is loaded.
            if r.load(name).await.is_err() && r.stopped() {
                stopped_at = Some(i);
                break;
            }
        }
        Ok(services_report(
            &endpoint,
            plaintext,
            &names,
            r.pool(),
            stopped_at,
        ))
    })
    .await
}

/// The services listing from what reflection returned: at most [`MAX_SERVICES`] services, the
/// text within [`SERVICES_TEXT_BYTES`] and the data within [`SERVICES_DATA_BYTES`], names cut at
/// [`shape::NAME_BYTES`], each cut said. Each line and entry is checked against its budget before
/// it is built. `stopped_at`: the first service reflection did not load because the session
/// reached its limit ([`grpc::MAX_REFLECTED_FILES`]).
pub fn services_report(
    endpoint: &str,
    plaintext: bool,
    names: &[String],
    pool: &prost_reflect::DescriptorPool,
    stopped_at: Option<usize>,
) -> ToolOk {
    let shown = &names[..names.len().min(MAX_SERVICES)];
    let mut labels = shape::Names::default();
    let mut text = shape::Lines::new(SERVICES_TEXT_BYTES);
    text.push(format!(
        "{} at {endpoint} ({}):",
        plural(names.len(), "service", "services"),
        transport(plaintext)
    ));
    let mut budget = shape::DataBudget::new(SERVICES_DATA_BYTES - shape::ENVELOPE_ROOM);
    let mut services = Vec::new();
    // Services listed in full in the text.
    let mut listed = 0;
    for (i, name) in shown.iter().enumerate() {
        if text.is_cut() && budget.is_cut() {
            break;
        }
        let service = pool.get_service_by_name(name);
        let label = labels.show(name).into_owned();
        if !text.is_cut() {
            text.push(format!("  {label}"));
        }
        // The service's entry is admitted on its own, then each method: the work stops where the
        // budget does, however many methods the server declared.
        let in_data = budget.admit(&json!({
            "name": label,
            "described": service.is_some(),
            "methods": [],
            "methodsCut": false,
        }));
        let mut methods = Vec::new();
        let mut methods_cut = false;
        match &service {
            Some(s) => {
                for m in s.methods() {
                    if text.is_cut() && (!in_data || budget.is_cut()) {
                        methods_cut = true;
                        break;
                    }
                    if !text.is_cut() {
                        let note = if shape::is_unary(&m) {
                            ""
                        } else {
                            "  [streaming: not callable with grpc call]"
                        };
                        text.push(format!("    {}{note}", shape::signature(&m, &mut labels)));
                    }
                    if in_data && !budget.is_cut() {
                        let d = shape::method_data(&m, &mut labels);
                        if budget.admit(&d) {
                            methods.push(d);
                        }
                    }
                    if in_data && budget.is_cut() {
                        methods_cut = true;
                    }
                }
            }
            None if stopped_at.is_some_and(|at| i >= at) => {
                text.push("    (not described: reflection stopped at its limit)");
            }
            None => {
                text.push("    (the server did not describe its methods)");
            }
        }
        if !text.is_cut() {
            listed += 1;
        }
        if in_data {
            services.push(json!({
                "name": label,
                "described": service.is_some(),
                "methods": methods,
                "methodsCut": methods_cut,
            }));
        }
    }
    if names.len() > shown.len() {
        text.push(format!(
            "…showing the first {MAX_SERVICES} of {} services.",
            names.len()
        ));
    }
    if names.is_empty() {
        text.push("  (none listed)");
    } else {
        text.push(
            "Describe a method's messages with `agent-studio grpc describe <target> \
             <package.Service/Method>`; call it with `agent-studio grpc call <target> \
             <package.Service/Method> --body '<json>'`.",
        );
    }
    let total = names.len();
    let data_cut = budget.is_cut();
    let names_cut = labels.any_cut();
    let stopped = stopped_at.is_some();
    let message = text.finish(|text_cut| {
        let mut notes = Vec::new();
        if text_cut {
            notes.push(format!(
                "…the listing is cut at {} KiB: {listed} of {total} services are listed in full \
                 ({}). Describe one service with `agent-studio grpc describe <target> \
                 <package.Service>`.",
                SERVICES_TEXT_BYTES / 1024,
                if data_cut {
                    "--json is cut too"
                } else {
                    "--json has the rest"
                }
            ));
        }
        if stopped {
            notes.push(format!(
                "(Reflection stops at {} descriptor files or {} MiB per listing; the services \
                 after that are listed without their methods.)",
                grpc::MAX_REFLECTED_FILES,
                grpc::MAX_REFLECTED_BYTES / (1024 * 1024)
            ));
        }
        if names_cut {
            notes.push(shape::names_cut_note());
        }
        notes
    });
    ToolOk::new(
        message,
        json!({
            "target": endpoint,
            "plaintext": plaintext,
            "total": total,
            "reflectionStopped": stopped,
            "namesCut": names_cut,
            // What this data holds; the text says its own cut.
            "truncated": names.len() > shown.len() || data_cut || names_cut || stopped,
            "services": services,
        }),
    )
}

/// `grpc_describe`.
pub async fn grpc_describe(args: &Args) -> Result<ToolOk, String> {
    let name = args.req_str("name")?;
    let (endpoint, plaintext) = target_of(args, &[("name", name)])?;
    let symbol = name.trim_start_matches('/').trim_start_matches('.');
    within_reflection_limit(&endpoint, async {
        let mut r = reflect(&endpoint, plaintext).await?;
        // Reflection finds a file by the service, message or enum it declares; a method is found
        // through its service.
        let first = symbol.split('/').next().unwrap_or(symbol);
        let loaded = r.load(first).await;
        if shape::resolve(r.pool(), symbol).is_none() {
            if let Some((parent, _)) = first.rsplit_once('.') {
                let _ = r.load(parent).await;
            }
        }
        let found = shape::resolve(r.pool(), symbol).ok_or_else(|| {
            format!(
                "{endpoint} does not describe `{}`{}. List what it serves with `agent-studio \
                 grpc services {endpoint}{}`.",
                quote(symbol, 200),
                loaded.err().map(|e| format!(" ({e})")).unwrap_or_default(),
                if plaintext { " --plaintext" } else { "" }
            )
        })?;
        // Loading is bounded (`grpc::MAX_REFLECTED_FILES`, `MAX_REFLECTED_BYTES`) and so is
        // describing (a walk of `shape::MAX_VISITS` nodes, names cut at `shape::NAME_BYTES`, every
        // line and entry checked against its budget before it is built): a schema the server
        // chose cannot make this run long or grow large.
        let (message, mut data) = shape::describe(&found);
        data["target"] = json!(endpoint);
        data["plaintext"] = json!(plaintext);
        data["name"] = json!(symbol);
        Ok(ToolOk::new(message, data))
    })
    .await
}

/// A unary call, as asked.
pub struct CallPlan {
    pub request: GrpcRequest,
    pub timeout: Duration,
}

/// The call `args` ask for, every rule checked before anything connects.
pub fn call_plan(args: &Args) -> Result<CallPlan, String> {
    let method_text = args.req_str("method")?;
    let body_json = body_value(args.json("body"))?;
    let body = body_json.to_string();
    let header_lines = args.list("header");
    let mut extra = vec![("method", method_text), ("body", body.as_str())];
    extra.extend(header_lines.iter().map(|h| ("header", h.as_str())));
    let (endpoint, plaintext) = target_of(args, &extra)?;
    if json_names_vault_var(&body_json) {
        return Err(vault_refusal("body"));
    }
    let (service, method) = split_method(method_text)?;
    if body.len() > MAX_BODY_BYTES {
        return Err(format!(
            "The body is {} bytes; at most {MAX_BODY_BYTES}.",
            body.len()
        ));
    }
    let metadata = headers(args)?
        .into_iter()
        .map(|(name, value)| GrpcHeader { name, value })
        .collect();
    let timeout = bounded(
        args,
        "timeout_ms",
        GRPC_TIMEOUT_MS_DEFAULT,
        1,
        GRPC_TIMEOUT_MS_MAX,
    )?;
    Ok(CallPlan {
        request: GrpcRequest {
            endpoint,
            service,
            method,
            message: body,
            metadata,
            plaintext,
        },
        timeout: Duration::from_millis(timeout as u64),
    })
}

/// `grpc_call`, recorded on `tap` (the app passes the Network view's). Every call that was
/// attempted — answered or not — is reported to the UI as a `grpcCall` event, which adds it to
/// the API client's History.
pub async fn grpc_call_with(ctx: &ToolCtx, args: &Args, tap: &Tap) -> Result<ToolOk, String> {
    let plan = call_plan(args)?;
    let request = plan.request.clone();
    let started = Instant::now();
    let outcome = grpc::call(plan.request, tap, Some(plan.timeout)).await;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let response = outcome.as_ref().ok().map(|o| &o.response);
    ctx.emit(
        "grpcCall",
        json!({
            "target": request.endpoint,
            "service": request.service,
            "method": request.method,
            "body": request.message,
            "headers": request.metadata,
            "plaintext": request.plaintext,
            "statusCode": response.map(|r| r.status_code),
            "statusName": response.map(|r| r.status_name.clone()),
            "error": response.and_then(|r| r.error.clone()),
            "transportError": outcome.as_ref().err(),
            "durationMs": duration_ms,
        }),
    );
    let outcome = outcome.map_err(|e| {
        format!(
            "gRPC {}/{} at {} ({}) failed: {e}",
            request.service,
            request.method,
            request.endpoint,
            transport(request.plaintext)
        )
    })?;
    Ok(call_report(&request, &outcome, duration_ms))
}

/// The answer to a call: status, metadata (bounded), the response JSON (pretty, bounded).
pub fn call_report(request: &GrpcRequest, outcome: &GrpcOutcome, duration_ms: u64) -> ToolOk {
    let r = &outcome.response;
    let status = match (&r.error, r.status_code) {
        (_, 0) => "OK".to_string(),
        (Some(e), code) => format!("{} ({code}): {e}", r.status_name),
        (None, code) => format!("{} ({code})", r.status_name),
    };
    let mut lines = vec![format!(
        "gRPC {}/{} at {} ({}): {status}, in {duration_ms} ms.",
        request.service,
        request.method,
        request.endpoint,
        transport(request.plaintext)
    )];

    let mut metadata = Vec::new();
    let mut metadata_cut = false;
    for (name, value) in outcome.metadata.iter().take(MAX_METADATA) {
        let (v, cut) = ws::cut_text(value, METADATA_VALUE_BYTES);
        metadata_cut |= cut;
        metadata.push(json!({"name": name, "value": v, "truncated": cut}));
    }
    let more_metadata = outcome.metadata.len().saturating_sub(MAX_METADATA);
    if !metadata.is_empty() {
        lines.push("Response metadata:".to_string());
        for m in &metadata {
            let cut = if m["truncated"] == true {
                " …(cut)"
            } else {
                ""
            };
            lines.push(format!(
                "  {}: {}{cut}",
                m["name"].as_str().unwrap_or_default(),
                m["value"].as_str().unwrap_or_default()
            ));
        }
        if more_metadata > 0 {
            lines.push(format!("  …{more_metadata} more entries not shown"));
        }
    }

    let bytes = r.message.len();
    let parsed: Option<Value> = serde_json::from_str(&r.message).ok();
    let truncated = bytes > RESPONSE_TEXT_BYTES;
    if r.status_code == 0 {
        let pretty = parsed
            .as_ref()
            .and_then(|v| serde_json::to_string_pretty(v).ok())
            .unwrap_or_else(|| r.message.clone());
        let (shown, cut) = ws::cut_text(&pretty, RESPONSE_TEXT_BYTES);
        lines.push("Response:".to_string());
        lines.push(shown.to_string());
        if cut || truncated {
            lines.push(format!(
                "…the response is {bytes} bytes of JSON; only the first {} KiB are shown.",
                RESPONSE_TEXT_BYTES / 1024
            ));
        }
    }
    if metadata_cut {
        lines.push(format!(
            "Metadata values are cut at {METADATA_VALUE_BYTES} bytes."
        ));
    }

    let (response, response_text) = if truncated {
        (
            Value::Null,
            Some(ws::cut_text(&r.message, RESPONSE_TEXT_BYTES).0.to_string()),
        )
    } else {
        (parsed.unwrap_or(Value::Null), None)
    };
    ToolOk::new(
        lines.join("\n"),
        json!({
            "target": request.endpoint,
            "plaintext": request.plaintext,
            "service": request.service,
            "method": request.method,
            "statusCode": r.status_code,
            "statusName": r.status_name,
            "error": r.error,
            "metadata": metadata,
            "moreMetadata": more_metadata,
            "response": response,
            "responseText": response_text,
            "responseBytes": bytes,
            "truncated": truncated,
            "durationMs": duration_ms,
        }),
    )
}

#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
