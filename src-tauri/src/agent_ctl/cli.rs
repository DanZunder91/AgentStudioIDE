//! `agent-studio <command>` — the app binary in command mode.
//!
//! `main` asks [`run_if_cli`] first: when the first argument is one of our commands the binary
//! acts as a small client of the running app and exits, and Tauri never starts. Being the app's
//! own binary is what makes the name safe: on Linux the installed app *is* `agent-studio` on
//! `PATH`, so whichever `agent-studio` a shell finds first does the same thing. Inside Agent
//! Studio's terminals the script from [`super::tools`] puts it on `PATH` on every OS.
//!
//! The client talks to the hook listener over plain TCP to `127.0.0.1`. Not `reqwest`: it
//! would honour the terminal's `HTTP_PROXY` and send the token through the capture proxy.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use super::{CtlRequest, CtlResponse, CTL_PATH};
use crate::agent::hook::{
    ENV_HOOK_TOKEN, ENV_HOOK_URL, ENV_TERMINAL_ID, HEADER_TERMINAL, HEADER_TOKEN,
};

/// The first arguments that put the binary in command mode. Anything else starts the app.
const COMMANDS: &[&str] = &["db", "help", "--help", "-h"];

/// Exit codes: 0 done, 1 the app refused or the operation failed, 2 a usage error,
/// 3 the app could not be reached.
const EXIT_FAILED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_UNREACHABLE: i32 = 3;

/// The connect timeout. The listener is on loopback, so anything slower is not there.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// The whole reply. Above the slowest connection test an engine allows, so a slow server is
/// reported by the app as a failed test rather than cut off here.
const REPLY_TIMEOUT: Duration = Duration::from_secs(150);

/// Run the command in `std::env::args` if there is one, returning the process exit code.
/// `None` means "not a command": start the app.
pub fn run_if_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !is_command(&args) {
        return None;
    }
    let env = CtlEnv::from_process();
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    Some(run(&args, env.as_ref(), &mut out, &mut err))
}

/// Whether `args` (without the program name) is a command rather than an app launch.
pub fn is_command(args: &[String]) -> bool {
    args.first().is_some_and(|a| COMMANDS.contains(&a.as_str()))
}

/// The three values a terminal inside Agent Studio carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CtlEnv {
    pub url: String,
    pub token: String,
    pub terminal_id: String,
}

impl CtlEnv {
    fn from_process() -> Option<Self> {
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Help,
    Request { request: CtlRequest, json: bool },
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
    let (request, json) = match parsed {
        Parsed::Help => {
            let _ = write!(out, "{}", usage());
            return 0;
        }
        Parsed::Request { request, json } => (request, json),
    };
    let Some(env) = env else {
        let _ = writeln!(
            err,
            "agent-studio: run this from a terminal inside Agent Studio (this terminal does not \
             carry {ENV_HOOK_URL} / {ENV_HOOK_TOKEN} / {ENV_TERMINAL_ID})."
        );
        return EXIT_USAGE;
    };
    let response = match send(env, &request) {
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

/// `db connect <url> [--name <name>] [--force] [--json]`, `db list [--json]`, `help`.
pub fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut rest = args.iter().map(String::as_str);
    match rest.next() {
        None | Some("help" | "--help" | "-h") => Ok(Parsed::Help),
        Some("db") => match rest.next() {
            Some("connect") => {
                let (mut url, mut name, mut force, mut json) = (None, None, false, false);
                while let Some(a) = rest.next() {
                    match a {
                        "--force" => force = true,
                        "--json" => json = true,
                        "--name" => {
                            name = Some(rest.next().ok_or("--name needs a value")?.to_string())
                        }
                        "--help" | "-h" => return Ok(Parsed::Help),
                        _ if a.starts_with("--name=") => {
                            name = Some(a["--name=".len()..].to_string())
                        }
                        _ if a.starts_with("--") => return Err(format!("unknown option {a}")),
                        _ if url.is_none() => url = Some(a.to_string()),
                        _ => {
                            return Err("give one connection URL (quote it: it may contain & or ?)"
                                .to_string())
                        }
                    }
                }
                let url = url.ok_or("db connect needs a connection URL")?;
                Ok(Parsed::Request {
                    request: CtlRequest::DbConnect { url, name, force },
                    json,
                })
            }
            Some("list") => {
                let mut json = false;
                for a in rest {
                    match a {
                        "--json" => json = true,
                        "--help" | "-h" => return Ok(Parsed::Help),
                        _ => return Err(format!("unexpected argument {a}")),
                    }
                }
                Ok(Parsed::Request {
                    request: CtlRequest::DbList,
                    json,
                })
            }
            Some(other) => Err(format!("unknown db command `{other}`")),
            None => Err("db needs a command: connect or list".to_string()),
        },
        Some(other) => Err(format!("unknown command `{other}`")),
    }
}

/// The help text, with the URL schemes the app actually speaks (read from the engine registry).
pub fn usage() -> String {
    format!(
        "agent-studio — drive Agent Studio from one of its terminals\n\
         \n\
         \x20 agent-studio db connect <url> [--name <name>] [--force] [--json]\n\
         \x20     Add a database connection to Agent Studio, test it and open it in the DB panel.\n\
         \x20     <url> is a connection URL: {schemes}\n\
         \x20     The password moves into Agent Studio's Vault and is never printed back.\n\
         \x20     New connections are read-only; the user can make one writable in the DB panel.\n\
         \x20     A connection that fails its test is not saved unless --force is given.\n\
         \n\
         \x20 agent-studio db list [--json]\n\
         \x20     The saved database connections (no secrets).\n",
        schemes = super::scheme_list()
    )
}

/// POST the request to the app and read its reply.
pub fn send(env: &CtlEnv, request: &CtlRequest) -> Result<CtlResponse, String> {
    let addr = loopback_addr(&env.url)?;
    let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
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

    #[test]
    fn only_our_commands_switch_the_binary_into_command_mode() {
        assert!(is_command(&args(&["db", "list"])));
        assert!(is_command(&args(&["help"])));
        assert!(is_command(&args(&["--help"])));
        // A plain launch, and anything an OS or a launcher may pass, starts the app.
        assert!(!is_command(&args(&[])));
        assert!(!is_command(&args(&["-psn_0_12345"])));
        assert!(!is_command(&args(&["/some/file.sql"])));
    }

    #[test]
    fn db_connect_takes_one_url_and_its_options_in_any_order() {
        let p = parse_args(&args(&[
            "db",
            "connect",
            "--force",
            "postgres://u:p@h/db?sslmode=require&x=1",
            "--name",
            "Shop",
            "--json",
        ]))
        .unwrap();
        assert_eq!(
            p,
            Parsed::Request {
                request: CtlRequest::DbConnect {
                    url: "postgres://u:p@h/db?sslmode=require&x=1".into(),
                    name: Some("Shop".into()),
                    force: true,
                },
                json: true,
            }
        );
        let p = parse_args(&args(&["db", "connect", "redis://h", "--name=Cache"])).unwrap();
        assert_eq!(
            p,
            Parsed::Request {
                request: CtlRequest::DbConnect {
                    url: "redis://h".into(),
                    name: Some("Cache".into()),
                    force: false,
                },
                json: false,
            }
        );
    }

    #[test]
    fn mistakes_are_usage_errors_that_name_the_problem() {
        let e = |a: &[&str]| parse_args(&args(a)).unwrap_err();
        assert_eq!(e(&["db", "connect"]), "db connect needs a connection URL");
        assert_eq!(
            e(&["db", "connect", "a://", "--name"]),
            "--name needs a value"
        );
        assert_eq!(
            e(&["db", "connect", "a://", "--bogus"]),
            "unknown option --bogus"
        );
        assert!(e(&["db", "connect", "a://", "b://"]).contains("one connection URL"));
        assert_eq!(e(&["db", "drop"]), "unknown db command `drop`");
        assert_eq!(e(&["db"]), "db needs a command: connect or list");
        assert_eq!(e(&["db", "list", "x"]), "unexpected argument x");
    }

    #[test]
    fn help_lists_every_scheme_the_registry_speaks() {
        assert_eq!(parse_args(&args(&["help"])).unwrap(), Parsed::Help);
        assert_eq!(
            parse_args(&args(&["db", "connect", "--help"])).unwrap(),
            Parsed::Help
        );
        let text = usage();
        for spec in crate::db::engines::ENGINES {
            for scheme in spec.url_schemes {
                assert!(text.contains(&format!("{scheme}://")), "{scheme} missing");
            }
        }
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
