//! `agent-studio <command>`: the app binary in command mode, a client of the running app (Tauri
//! never starts). Plain TCP to 127.0.0.1, not `reqwest`: that would honour the terminal's
//! `HTTP_PROXY` and send the token through the capture proxy.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::{Map, Value};

use super::registry::{self, ParamKind, ToolSpec};
use super::{CtlCall, CtlResponse, CTL_PATH};
use crate::agent::hook::{
    ENV_HOOK_TOKEN, ENV_HOOK_URL, ENV_TERMINAL_ID, HEADER_TERMINAL, HEADER_TOKEN,
};

/// Exit codes: 0 done, 1 the app refused or the operation failed, 2 a usage error,
/// 3 the app could not be reached.
const EXIT_FAILED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_UNREACHABLE: i32 = 3;

/// The connect timeout. The listener is on loopback, so anything slower is not there.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// The whole reply. Above the slowest operation a tool allows (a connection test, a request
/// timeout), so a slow server is reported by the app rather than cut off here.
const REPLY_TIMEOUT: Duration = Duration::from_secs(150);

/// Run the command in `std::env::args` if there is one, returning the process exit code.
/// `None` means "not a command": start the app.
pub fn run_if_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !is_command(&args) {
        return None;
    }
    // `agent-studio mcp …`: the MCP server (which needs this process's stdin) and its install.
    if args[0] == super::mcp::WORD {
        return Some(super::mcp::main(&args[1..]));
    }
    let env = CtlEnv::from_process();
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    Some(run(&args, env.as_ref(), &mut out, &mut err))
}

/// Whether `args` (without the program name) is a command rather than an app launch: the first
/// word is a tool group (`db`, `http`, …), `mcp`, or a request for help. `mcp` must be here: it
/// is how Claude Code starts the server, and as an app launch it would open a second window.
pub fn is_command(args: &[String]) -> bool {
    args.first().is_some_and(|a| {
        matches!(a.as_str(), "help" | "--help" | "-h")
            || a == super::mcp::WORD
            || registry::groups().contains(&a.as_str())
    })
}

/// The three values a terminal inside Agent Studio carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CtlEnv {
    pub url: String,
    pub token: String,
    pub terminal_id: String,
}

impl CtlEnv {
    pub fn from_process() -> Option<Self> {
        Some(Self {
            url: std::env::var(ENV_HOOK_URL).ok().filter(|v| !v.is_empty())?,
            token: std::env::var(ENV_HOOK_TOKEN)
                .ok()
                .filter(|v| !v.is_empty())?,
            terminal_id: std::env::var(ENV_TERMINAL_ID)
                .ok()
                .filter(|v| !v.is_empty())?,
        })
    }
}

/// What the command line asked for.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    /// The whole list, or one tool's (`None` / `Some(name)`).
    Help(Option<&'static str>),
    Call {
        call: CtlCall,
        json: bool,
    },
}

/// The whole command, with its output streams injected (tests read them).
pub fn run(args: &[String], env: Option<&CtlEnv>, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let parsed = match parse_args(args) {
        Ok(p) => p,
        Err(message) => {
            let _ = writeln!(err, "agent-studio: {message}\n");
            let _ = write!(err, "{}", usage());
            return EXIT_USAGE;
        }
    };
    let (call, json) = match parsed {
        Parsed::Help(None) => {
            let _ = write!(out, "{}", usage());
            return 0;
        }
        Parsed::Help(Some(name)) => {
            let _ = write!(
                out,
                "{}",
                registry::find(name).map(tool_usage).unwrap_or_default()
            );
            return 0;
        }
        Parsed::Call { call, json } => (call, json),
    };
    let Some(env) = env else {
        let _ = writeln!(
            err,
            "agent-studio: run this from a terminal inside Agent Studio (this terminal does not \
             carry {ENV_HOOK_URL} / {ENV_HOOK_TOKEN} / {ENV_TERMINAL_ID})."
        );
        return EXIT_USAGE;
    };
    let response = match send(env, &call) {
        Ok(r) => r,
        Err(message) => {
            let _ = writeln!(err, "agent-studio: {message}");
            return EXIT_UNREACHABLE;
        }
    };
    if json {
        let body = serde_json::json!({
            "ok": response.ok,
            "message": response.message,
            "data": response.data,
        });
        let _ = writeln!(out, "{body}");
    } else if response.ok {
        let _ = writeln!(out, "{}", response.message);
    } else {
        let _ = writeln!(err, "{}", response.message);
    }
    if response.ok {
        0
    } else {
        EXIT_FAILED
    }
}

/// `<group> <verb> [positional…] [--param value]… [--flag] [--json] [--help]`, or `help`.
pub fn parse_args(args: &[String]) -> Result<Parsed, String> {
    match args.first().map(String::as_str) {
        None | Some("help" | "--help" | "-h") => {
            // `agent-studio help db query` → that tool's help.
            return Ok(Parsed::Help(
                registry::find_cli(args.get(1..).unwrap_or(&[])).map(|t| t.name),
            ));
        }
        _ => {}
    }
    let Some(spec) = registry::find_cli(args) else {
        let group = &args[0];
        let verbs: Vec<&str> = registry::all()
            .iter()
            .filter(|t| t.cli.first() == Some(&group.as_str()))
            .filter_map(|t| t.cli.get(1).copied())
            .collect();
        return Err(match (verbs.is_empty(), args.get(1)) {
            (true, _) => format!("unknown command `{group}`"),
            (false, None) => format!("{group} needs a command: {}", verbs.join(", ")),
            (false, Some(v)) => format!("unknown {group} command `{v}`"),
        });
    };
    let rest = &args[spec.cli.len()..];
    let mut map = Map::new();
    let mut json = false;
    let mut positionals = spec.params.iter().filter(|p| p.positional);
    let mut i = 0;
    while i < rest.len() {
        let a = rest[i].as_str();
        i += 1;
        match a {
            "--json" => json = true,
            "--help" | "-h" => return Ok(Parsed::Help(Some(spec.name))),
            _ if a.starts_with("--") => {
                let (flag, inline) = match a.split_once('=') {
                    Some((f, v)) => (f, Some(v.to_string())),
                    None => (a, None),
                };
                let p = spec
                    .params
                    .iter()
                    .find(|p| p.flag() == flag)
                    .ok_or_else(|| format!("unknown option {flag}"))?;
                if p.kind == ParamKind::Bool {
                    let v = match inline.as_deref() {
                        None | Some("true") => true,
                        Some("false") => false,
                        Some(other) => return Err(format!("{flag} is a flag, not `{other}`")),
                    };
                    map.insert(p.name.to_string(), Value::Bool(v));
                    continue;
                }
                let raw = match inline {
                    Some(v) => v,
                    None => {
                        let v = rest
                            .get(i)
                            .ok_or_else(|| format!("{flag} needs a value"))?
                            .clone();
                        i += 1;
                        v
                    }
                };
                let value = convert(p.kind, &raw, flag)?;
                if p.kind == ParamKind::StringList {
                    let list = map
                        .entry(p.name.to_string())
                        .or_insert_with(|| Value::Array(Vec::new()));
                    if let (Value::Array(items), Value::String(s)) = (list, value) {
                        items.push(Value::String(s));
                    }
                } else {
                    map.insert(p.name.to_string(), value);
                }
            }
            _ => {
                let p = positionals.next().ok_or_else(|| {
                    format!(
                        "unexpected argument `{a}` (quote a value that contains spaces, & or ?)"
                    )
                })?;
                map.insert(p.name.to_string(), convert(p.kind, a, p.name)?);
            }
        }
    }
    if let Some(p) = spec
        .params
        .iter()
        .find(|p| p.required && !map.contains_key(p.name))
    {
        return Err(if p.positional {
            format!("{} needs {}", spec.cli.join(" "), p.name.replace('_', " "))
        } else {
            format!("{} needs {}", spec.cli.join(" "), p.flag())
        });
    }
    Ok(Parsed::Call {
        call: CtlCall {
            tool: spec.name.to_string(),
            args: map,
        },
        json,
    })
}

/// A command-line string as the JSON value of a parameter kind.
fn convert(kind: ParamKind, raw: &str, what: &str) -> Result<Value, String> {
    Ok(match kind {
        ParamKind::String | ParamKind::StringList => Value::String(raw.to_string()),
        ParamKind::Integer => Value::from(
            raw.parse::<i64>()
                .map_err(|_| format!("{what} must be a whole number, not `{raw}`"))?,
        ),
        ParamKind::Bool => Value::Bool(raw == "true"),
        ParamKind::Json => {
            serde_json::from_str(raw).map_err(|e| format!("{what} must be JSON ({e}): {raw}"))?
        }
    })
}

/// The help text: every tool, grouped by its first word, from the registry.
pub fn usage() -> String {
    let mut s = String::from(
        "agent-studio — drive Agent Studio from one of its terminals\n\n\
         Every command prints a sentence; add --json for structured output.\n\
         `agent-studio help <command>` shows a command's options.\n",
    );
    let mut group = "";
    for t in registry::all() {
        let g = t.cli.first().copied().unwrap_or("");
        if g != group {
            s.push('\n');
            group = g;
        }
        s.push_str(&format!(
            "  agent-studio {}\n      {}\n",
            synopsis(t),
            t.summary
        ));
    }
    s.push_str(&super::mcp::agent_usage());
    s
}

/// `db connect <url> [--name <name>] [--force]`.
fn synopsis(t: &ToolSpec) -> String {
    let mut parts: Vec<String> = t.cli.iter().map(|w| w.to_string()).collect();
    for p in t.params.iter().filter(|p| p.positional) {
        let n = p.name.replace('_', "-");
        parts.push(if p.required {
            format!("<{n}>")
        } else {
            format!("[<{n}>]")
        });
    }
    for p in t.params.iter().filter(|p| !p.positional) {
        let value = match p.kind {
            ParamKind::Bool => String::new(),
            ParamKind::Json => " <json>".to_string(),
            _ => format!(" <{}>", p.name.replace('_', "-")),
        };
        let repeat = if p.kind == ParamKind::StringList {
            "…"
        } else {
            ""
        };
        parts.push(if p.required {
            format!("{}{value}{repeat}", p.flag())
        } else {
            format!("[{}{value}]{repeat}", p.flag())
        });
    }
    parts.join(" ")
}

/// One tool's help: synopsis, summary, details, and each parameter.
pub fn tool_usage(t: &ToolSpec) -> String {
    let mut s = format!("agent-studio {}\n\n{}\n", synopsis(t), t.summary);
    if !t.details.is_empty() {
        s.push_str(&format!("\n{}\n", t.details));
    }
    if !t.params.is_empty() {
        s.push('\n');
        for p in t.params {
            let name = if p.positional {
                format!("<{}>", p.name.replace('_', "-"))
            } else {
                p.flag()
            };
            s.push_str(&format!("  {name:<18} {}\n", p.help));
        }
    }
    s.push_str("  --json             Print the result as JSON.\n");
    s
}

/// POST the call to the app and read its reply.
pub fn send(env: &CtlEnv, call: &CtlCall) -> Result<CtlResponse, String> {
    let addr = loopback_addr(&env.url)?;
    let body = serde_json::to_vec(call).map_err(|e| e.to_string())?;
    let unreachable = |e: std::io::Error| {
        format!("could not reach Agent Studio at {addr} ({e}). Is the app still running?")
    };
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(unreachable)?;
    stream
        .set_read_timeout(Some(REPLY_TIMEOUT))
        .map_err(unreachable)?;
    let head = format!(
        "POST {CTL_PATH} HTTP/1.1\r\nHost: {addr}\r\n{HEADER_TOKEN}: {}\r\n\
         {HEADER_TERMINAL}: {}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        env.token,
        env.terminal_id,
        body.len()
    );
    stream.write_all(head.as_bytes()).map_err(unreachable)?;
    stream.write_all(&body).map_err(unreachable)?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("Agent Studio did not answer in time ({e})."))?;
    parse_reply(&raw)
}

/// `http://127.0.0.1:<port>` → the socket address. Anything that is not loopback is refused:
/// the token must never leave this machine, even if the environment was tampered with.
pub fn loopback_addr(url: &str) -> Result<SocketAddr, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("{ENV_HOOK_URL} is not an http:// URL"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let addr: SocketAddr = authority
        .replace("localhost", "127.0.0.1")
        .parse()
        .map_err(|_| format!("{ENV_HOOK_URL} does not name host:port"))?;
    if !addr.ip().is_loopback() {
        return Err(format!("{ENV_HOOK_URL} is not a loopback address"));
    }
    Ok(addr)
}

/// The status line and the JSON body of the listener's reply.
pub fn parse_reply(raw: &[u8]) -> Result<CtlResponse, String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("Agent Studio sent an incomplete reply.")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("Agent Studio sent a malformed reply.")?;
    let body = &raw[split + 4..];
    match serde_json::from_slice::<CtlResponse>(body) {
        Ok(r) => Ok(r),
        // The listener answers 403 with an empty body: the token did not match this app.
        Err(_) if status == 403 => Err(
            "Agent Studio refused the request: this terminal belongs to another Agent Studio \
             window or an earlier run. Open a new terminal."
                .to_string(),
        ),
        Err(_) => Err(format!("Agent Studio answered {status} without a result.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn call(a: &[&str]) -> (CtlCall, bool) {
        match parse_args(&args(a)).unwrap() {
            Parsed::Call { call, json } => (call, json),
            other => panic!("not a call: {other:?}"),
        }
    }

    #[test]
    fn only_tool_groups_and_help_switch_the_binary_into_command_mode() {
        assert!(is_command(&args(&["db", "list"])));
        assert!(is_command(&args(&["help"])));
        assert!(is_command(&args(&["--help"])));
        assert!(is_command(&args(&["mcp"])));
        assert!(is_command(&args(&["mcp", "install"])));
        // A plain launch, and anything an OS or a launcher may pass, starts the app.
        assert!(!is_command(&args(&[])));
        assert!(!is_command(&args(&["-psn_0_12345"])));
        assert!(!is_command(&args(&["/some/file.sql"])));
    }

    #[test]
    fn positionals_flags_and_inline_values_become_typed_arguments() {
        let (c, json) = call(&[
            "db",
            "connect",
            "--force",
            "postgres://u:p@h/db?sslmode=require&x=1",
            "--name",
            "Shop",
            "--json",
        ]);
        assert!(json);
        assert_eq!(c.tool, "db_connect");
        assert_eq!(
            Value::Object(c.args),
            serde_json::json!({
                "url": "postgres://u:p@h/db?sslmode=require&x=1",
                "name": "Shop",
                "force": true,
            })
        );
        let (c, json) = call(&[
            "db",
            "connect",
            "redis://h",
            "--name=Cache",
            "--force=false",
        ]);
        assert!(!json);
        assert_eq!(
            Value::Object(c.args),
            serde_json::json!({"url": "redis://h", "name": "Cache", "force": false})
        );
    }

    #[test]
    fn every_kind_converts_from_its_command_line_spelling() {
        assert_eq!(convert(ParamKind::Integer, "42", "n").unwrap(), 42);
        assert!(convert(ParamKind::Integer, "4x", "--limit")
            .unwrap_err()
            .contains("--limit must be a whole number"));
        assert_eq!(
            convert(ParamKind::Json, r#"{"a":[1]}"#, "b").unwrap(),
            serde_json::json!({"a": [1]})
        );
        assert!(convert(ParamKind::Json, "{", "--body")
            .unwrap_err()
            .contains("must be JSON"));
        assert_eq!(convert(ParamKind::String, "x", "s").unwrap(), "x");
        assert_eq!(convert(ParamKind::Bool, "true", "b").unwrap(), true);
    }

    #[test]
    fn mistakes_are_usage_errors_that_name_the_problem() {
        let e = |a: &[&str]| parse_args(&args(a)).unwrap_err();
        assert_eq!(e(&["db", "connect"]), "db connect needs url");
        assert_eq!(
            e(&["db", "connect", "a://", "--name"]),
            "--name needs a value"
        );
        assert_eq!(
            e(&["db", "connect", "a://", "--bogus"]),
            "unknown option --bogus"
        );
        assert!(e(&["db", "connect", "a://", "b://"]).contains("unexpected argument `b://`"));
        assert_eq!(e(&["db", "drop"]), "unknown db command `drop`");
        assert!(e(&["db"]).starts_with("db needs a command: connect, list"));
        assert!(e(&["db", "connect", "a://", "--force=maybe"]).contains("is a flag"));
    }

    #[test]
    fn help_is_generated_from_the_registry() {
        assert_eq!(parse_args(&args(&["help"])).unwrap(), Parsed::Help(None));
        assert_eq!(
            parse_args(&args(&["help", "db", "connect"])).unwrap(),
            Parsed::Help(Some("db_connect"))
        );
        assert_eq!(
            parse_args(&args(&["db", "connect", "--help"])).unwrap(),
            Parsed::Help(Some("db_connect"))
        );
        let all = usage();
        for t in registry::all() {
            assert!(
                all.contains(&format!("agent-studio {}", t.cli.join(" "))),
                "{}",
                t.name
            );
            assert!(all.contains(t.summary), "{}", t.name);
        }
        // The help every agent is pointed at names the MCP server and its status, but never the
        // commands that change the user's Claude Code config: the user adds it from Settings.
        assert!(all.contains("agent-studio mcp\n"));
        assert!(all.contains("agent-studio mcp status"));
        assert!(all.contains("Settings"));
        for word in ["install", "uninstall", "claude mcp add"] {
            assert!(!all.contains(word), "{word}");
        }
        let one = tool_usage(registry::find("db_connect").unwrap());
        assert!(one.starts_with("agent-studio db connect <url> [--name <name>] [--force]"));
        assert!(one.contains("--force"));
        assert!(one.contains("--json"));
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(
            run(&args(&["help", "db", "list"]), None, &mut out, &mut err),
            0
        );
        assert!(String::from_utf8_lossy(&out).starts_with("agent-studio db list"));
    }

    #[test]
    fn outside_agent_studio_it_says_so_and_sends_nothing() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&args(&["db", "list"]), None, &mut out, &mut err);
        assert_eq!(code, EXIT_USAGE);
        assert!(String::from_utf8_lossy(&err).contains("inside Agent Studio"));
        assert!(out.is_empty());
    }

    #[test]
    fn the_token_only_ever_goes_to_loopback() {
        assert_eq!(
            loopback_addr("http://127.0.0.1:5123").unwrap(),
            "127.0.0.1:5123".parse::<SocketAddr>().unwrap()
        );
        assert!(loopback_addr("http://localhost:5123").is_ok());
        assert!(loopback_addr("http://[::1]:5123").is_ok());
        assert!(loopback_addr("http://10.0.0.5:5123")
            .unwrap_err()
            .contains("not a loopback"));
        assert!(loopback_addr("https://127.0.0.1:5123").is_err());
        assert!(loopback_addr("http://example.com:80").is_err());
    }

    #[test]
    fn a_reply_is_read_off_the_status_line_and_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"message\":\"hi\",\"data\":[1]}";
        let r = parse_reply(raw).unwrap();
        assert!(r.ok);
        assert_eq!(r.message, "hi");
        assert!(
            parse_reply(b"HTTP/1.1 403 forbidden\r\nContent-Length: 0\r\n\r\n")
                .unwrap_err()
                .contains("another Agent Studio")
        );
        assert!(parse_reply(b"HTTP/1.1 200").is_err());
    }
}
