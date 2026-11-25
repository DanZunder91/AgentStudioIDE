//! `agent-studio mcp` end to end, without the GUI: the real app binary as the MCP server Claude
//! Code starts, over real pipes, forwarding to the real listener's `/ctl` route; and the real
//! binary's `mcp install|status|uninstall` running a fake `claude` through the same
//! `AGENTSTUDIO_CLAUDE_BIN` override every spawn of `claude` honours.
//!
//! Hermetic: every store is in a temp dir, the database is a port nothing listens on, the
//! listener is on loopback, and the `claude` is a script that keeps its "config" next to itself.
//! The one test that runs the real, signed-in `claude` is `#[ignore]`d.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::agent_ctl::{self, cli, CtlCall, CtlEvent, ToolCtx, UiSink};
use agent_studio_scaffold_lib::hook_listener::{CtlFuture, CtlHandler, HookListener};
use serde_json::{json, Value};

const EXE: &str = env!("CARGO_BIN_EXE_agent-studio-scaffold");
const ENV_VARS: [&str; 3] = [
    "AGENTSTUDIO_HOOK_URL",
    "AGENTSTUDIO_HOOK_TOKEN",
    "AGENTSTUDIO_TERMINAL_ID",
];

fn temp_dir(tag: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "agentstudio-mcp-it-{tag}-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.local_addr().unwrap().port()
}

#[derive(Default)]
struct Events(Mutex<Vec<CtlEvent>>);

impl UiSink for Events {
    fn emit(&self, event: CtlEvent) {
        self.0.lock().unwrap().push(event);
    }
}

/// The running app: the real listener, its `/ctl` route the real dispatcher over `dir`. Records
/// every UI event and the name of every tool asked for.
fn app(dir: &Path, terminal: &str) -> (cli::CtlEnv, Arc<Events>, Arc<Mutex<Vec<String>>>) {
    let (listener, config) = HookListener::bind().expect("bind");
    let events: Arc<Events> = Arc::default();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let (ui, seen, dir) = (events.clone(), asked.clone(), dir.to_path_buf());
    let on_ctl: Arc<CtlHandler> = Arc::new(move |terminal_id: String, body: Vec<u8>| {
        if let Ok(call) = serde_json::from_slice::<CtlCall>(&body) {
            seen.lock().unwrap().push(call.tool);
        }
        let ctx = ToolCtx {
            dir: dir.clone(),
            terminal_id,
            ui: ui.clone(),
        };
        Box::pin(async move {
            let (status, reply) = agent_ctl::handle(ctx, &body).await;
            (status, serde_json::to_vec(&reply).unwrap())
        }) as CtlFuture
    });
    listener.serve_with_ctl(|_, _| {}, Some(on_ctl));
    let env = cli::CtlEnv {
        url: config.base_url,
        token: config.token,
        terminal_id: terminal.into(),
    };
    (env, events, asked)
}

/// The app binary with `args`, inside the terminal `env` describes (or outside any), with no
/// link to the Agent Studio this test itself may be running in.
fn binary(args: &[&str], env: Option<&cli::CtlEnv>) -> Command {
    let mut c = Command::new(EXE);
    c.args(args);
    for v in ENV_VARS {
        c.env_remove(v);
    }
    if let Some(e) = env {
        c.env(ENV_VARS[0], &e.url)
            .env(ENV_VARS[1], &e.token)
            .env(ENV_VARS[2], &e.terminal_id);
    }
    c
}

/// Wait for `child`, killing it past `limit`: a server that never exits on end of input must
/// fail the test, not hang it.
fn finish(mut child: std::process::Child, limit: Duration) -> Output {
    use std::io::Read as _;
    let read = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = read(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = read(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("the process did not exit within {limit:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Output {
        status,
        stdout: stdout.join().unwrap(),
        stderr: stderr.join().unwrap(),
    }
}

/// Run the binary as `agent-studio mcp`, send `lines`, close its input, and read every reply.
/// Each stdout line must be one JSON-RPC 2.0 message: nothing else may reach stdout.
fn mcp_session(env: Option<&cli::CtlEnv>, lines: &[Value]) -> (Vec<Value>, Output) {
    let mut child = binary(&["mcp"], env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        for l in lines {
            writeln!(stdin, "{l}").unwrap();
        }
    }
    let out = finish(child, Duration::from_secs(60));
    let stdout = String::from_utf8(out.stdout.clone()).unwrap();
    let replies = stdout
        .lines()
        .map(|l| {
            let v: Value = serde_json::from_str(l)
                .unwrap_or_else(|e| panic!("stdout carried a non-JSON line ({e}): {l}"));
            assert_eq!(v["jsonrpc"], "2.0");
            v
        })
        .collect();
    (replies, out)
}

fn by_id(replies: &[Value], id: i64) -> &Value {
    replies
        .iter()
        .find(|r| r["id"] == id)
        .unwrap_or_else(|| panic!("no reply to {id}: {replies:#?}"))
}

fn req(id: i64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

fn initialize(id: i64) -> Value {
    req(
        id,
        "initialize",
        json!({
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "agent-mcp-test", "version": "0"},
        }),
    )
}

fn text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap()
}

#[test]
fn the_app_binary_is_an_mcp_server_that_answers_and_exits_outside_agent_studio() {
    let (replies, out) = mcp_session(
        None,
        &[
            initialize(0),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            req(1, "tools/list", json!({})),
            req(2, "tools/call", json!({"name": "db_list", "arguments": {}})),
            req(3, "ping", json!({})),
        ],
    );
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(replies.len(), 4, "{replies:#?}");

    let init = &by_id(&replies, 0)["result"];
    assert_eq!(init["protocolVersion"], "2025-11-25");
    assert_eq!(init["serverInfo"]["name"], "agent-studio");

    let tools = by_id(&replies, 1)["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(
        names.contains(&"db_connect") && names.contains(&"db_list"),
        "{names:?}"
    );
    let connect = tools.iter().find(|t| t["name"] == "db_connect").unwrap();
    assert_eq!(connect["inputSchema"]["required"], json!(["url"]));

    // The tools explain themselves rather than failing obscurely.
    let call = &by_id(&replies, 2)["result"];
    assert_eq!(call["isError"], true);
    assert!(text(call).contains("open this from a terminal inside Agent Studio"));
    assert_eq!(by_id(&replies, 3)["result"], json!({}));
}

#[test]
fn inside_an_agent_studio_terminal_a_tool_call_reaches_the_running_app() {
    let dir = temp_dir("inside");
    let (env, events, asked) = app(&dir, "term-7");
    let url = format!("postgres://app:s3cret@127.0.0.1:{}/shop", dead_port());
    let (replies, out) = mcp_session(
        Some(&env),
        &[
            initialize(0),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            req(
                1,
                "tools/call",
                json!({"name": "db_connect", "arguments": {"url": url, "name": "Via MCP", "force": true}}),
            ),
        ],
    );
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let saved = &by_id(&replies, 1)["result"];
    assert_eq!(saved["isError"], false, "{saved}");
    assert!(text(saved).contains("Saved in Agent Studio as \"Via MCP\""));
    assert_eq!(saved["structuredContent"]["connection"]["readOnly"], true);

    let (replies, _) = mcp_session(
        Some(&env),
        &[req(
            2,
            "tools/call",
            json!({"name": "db_list", "arguments": {}}),
        )],
    );
    let listed = &by_id(&replies, 2)["result"];
    assert!(text(listed).contains("Via MCP"), "{listed}");
    assert_eq!(listed["structuredContent"]["result"][0]["name"], "Via MCP");

    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!stdout.contains("s3cret"), "the password never comes back");
    assert_eq!(asked.lock().unwrap().as_slice(), ["db_connect", "db_list"]);
    let ev = events.0.lock().unwrap().clone();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].kind, "dbConnection");
    assert_eq!(ev[0].terminal_id, "term-7", "the terminal that asked");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn help_lists_the_mcp_commands() {
    let out = binary(&["help"], None).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let help = String::from_utf8_lossy(&out.stdout);
    for line in [
        "agent-studio mcp\n",
        "agent-studio mcp install",
        "agent-studio mcp status",
    ] {
        assert!(help.contains(line), "{line}");
    }
    let out = binary(&["mcp", "--help"], None).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("claude mcp add --scope user"));
    let out = binary(&["mcp", "bogus"], None).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

/// The fake `claude` in its own dir (its "config" and argv log live there).
#[cfg(unix)]
fn fake_claude(tag: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = temp_dir(tag);
    let script = dir.join("claude");
    std::fs::write(&script, include_str!("fixtures/fake-claude-mcp.sh")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[cfg(unix)]
#[test]
fn install_status_and_uninstall_run_claudes_cli_with_this_binarys_absolute_path() {
    let claude = fake_claude("claude-bin");
    let dir = claude.parent().unwrap().to_path_buf();
    let run = |args: &[&str]| {
        binary(args, None)
            .env("AGENTSTUDIO_CLAUDE_BIN", &claude)
            .output()
            .unwrap()
    };
    let json = |out: &Output| -> Value {
        serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{e}: {out:?}"))
    };
    let exe = std::fs::canonicalize(EXE).unwrap();

    let out = run(&["mcp", "status", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(json(&out)["state"], "notInstalled");

    let out = run(&["mcp", "install", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let report = json(&out);
    assert_eq!(report["state"], "installed");
    let reported = PathBuf::from(report["exe"].as_str().unwrap());
    assert!(reported.is_absolute());
    assert_eq!(std::fs::canonicalize(&reported).unwrap(), exe);

    // What `claude` was asked to run: exactly this binary, by absolute path, with `mcp`.
    let log = std::fs::read_to_string(dir.join("argv.log")).unwrap();
    let add: Vec<&str> = log
        .split("--end--\n")
        .find(|run| run.starts_with("mcp\nadd\n"))
        .unwrap()
        .lines()
        .collect();
    assert_eq!(
        &add[..6],
        ["mcp", "add", "--scope", "user", "agent-studio", "--"]
    );
    assert_eq!(std::fs::canonicalize(add[6]).unwrap(), exe);
    assert_eq!(add[7], "mcp");
    assert_eq!(add.len(), 8);

    let out = run(&["mcp", "status"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("is added to Claude Code"));

    let out = run(&["mcp", "uninstall"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("Removed Agent Studio"));
    assert!(!dir.join("entry").exists());

    // An override that is not a program: reported, nothing run.
    let out = binary(&["mcp", "install"], None)
        .env("AGENTSTUDIO_CLAUDE_BIN", dir.join("nope"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("Claude Code was not found"), "{err}");
    assert!(err.contains("AGENTSTUDIO_CLAUDE_BIN"), "{err}");
    let _ = std::fs::remove_dir_all(dir);
}

/// The real `claude mcp add|get|remove` behind `agent-studio mcp install|status|uninstall`, in a
/// throwaway `CLAUDE_CONFIG_DIR` so the user's Claude Code config is never read or written. Checks
/// the reading of Claude's real `get` output, and that Claude's own health check starts this
/// binary as a server and connects. No model call, but it needs the real `claude`, so:
///
/// `cargo test --test agent_mcp -- --ignored --nocapture`
#[test]
#[ignore = "runs the real claude CLI (in a throwaway config dir)"]
fn real_claude_adds_checks_and_removes_the_server_in_a_throwaway_config() {
    let dir = temp_dir("real-config");
    let config = dir.join("claude-config");
    std::fs::create_dir_all(&config).unwrap();
    let home_config = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude.json"));
    let before = home_config
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.contains(&format!("\"command\": \"{EXE}\"")));
    let run = |args: &[&str]| {
        let out = binary(args, None)
            .env("CLAUDE_CONFIG_DIR", &config)
            .output()
            .unwrap();
        eprintln!(
            "{args:?} → {:?}\n{}{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        out
    };
    let report = |out: &Output| -> Value { serde_json::from_slice(&out.stdout).unwrap() };

    assert_eq!(
        report(&run(&["mcp", "status", "--json"]))["state"],
        "notInstalled"
    );
    let added = run(&["mcp", "install", "--json"]);
    assert_eq!(report(&added)["state"], "installed", "{added:?}");
    let saved = std::fs::read_to_string(config.join(".claude.json")).unwrap();
    assert!(
        saved.contains("agent-studio"),
        "Claude wrote its own config: {saved}"
    );
    // Claude's `get` health-checks the entry: it starts this binary with `mcp` and connects.
    let status = run(&["mcp", "status", "--json"]);
    assert_eq!(report(&status)["state"], "installed", "{status:?}");
    assert!(report(&status)["scope"].as_str().unwrap().contains("User"));
    let again = run(&["mcp", "install"]);
    assert!(String::from_utf8_lossy(&again.stdout).contains("already added"));
    assert_eq!(
        report(&run(&["mcp", "uninstall", "--json"]))["state"],
        "notInstalled"
    );
    assert_eq!(
        report(&run(&["mcp", "status", "--json"]))["state"],
        "notInstalled"
    );

    // The user's own config did not gain an entry for this binary.
    let after = home_config
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.contains(&format!("\"command\": \"{EXE}\"")));
    assert_eq!(before, after);
    let _ = std::fs::remove_dir_all(dir);
}

/// The real thing: the signed-in `claude`, told about the built binary as an MCP server, asked to
/// call `db_list` — inside an environment where a test listener stands in for the app, so the
/// call goes all the way through. Uses the user's Claude account (one tiny prompt), so it is not
/// part of the default run:
///
/// `cargo test --test agent_mcp -- --ignored --nocapture`
#[test]
#[ignore = "runs the real, signed-in claude CLI"]
fn real_claude_calls_an_agent_studio_tool_through_the_mcp_server() {
    let dir = temp_dir("real-claude");
    let (env, _events, asked) = app(&dir, "term-smoke");
    let name = format!("Smoke {}", std::process::id());
    let seeded = cli::send(
        &env,
        &CtlCall {
            tool: "db_connect".into(),
            args: json!({
                "url": format!("postgres://smoke:pw@127.0.0.1:{}/smoke", dead_port()),
                "name": name,
                "force": true,
            })
            .as_object()
            .unwrap()
            .clone(),
        },
    )
    .expect("seed");
    assert!(seeded.ok, "{}", seeded.message);
    asked.lock().unwrap().clear();

    let config = dir.join("mcp.json");
    std::fs::write(
        &config,
        json!({"mcpServers": {"agent-studio": {"type": "stdio", "command": EXE, "args": ["mcp"]}}})
            .to_string(),
    )
    .unwrap();
    let claude = std::env::var("AGENTSTUDIO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    let mut cmd = Command::new(claude);
    cmd.current_dir(&dir)
        .args([
            "-p",
            "--strict-mcp-config",
            "--mcp-config",
            &config.to_string_lossy(),
            "--allowedTools",
            "mcp__agent-studio__db_list",
            "--no-session-persistence",
            "Call the db_list tool once, then reply with only the connection names it lists.",
        ])
        .env(ENV_VARS[0], &env.url)
        .env(ENV_VARS[1], &env.token)
        .env(ENV_VARS[2], &env.terminal_id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A session this test may itself run inside must not be mistaken for this one's parent.
    for (key, _) in std::env::vars() {
        if key == "CLAUDECODE" || key == "CLAUDE_PID" || key.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(key);
        }
    }
    let out = finish(cmd.spawn().expect("claude"), Duration::from_secs(240));
    let stdout = String::from_utf8_lossy(&out.stdout);
    eprintln!(
        "claude exit {:?}\nstdout:\n{stdout}\nstderr:\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.status.code(), Some(0));
    assert!(
        asked.lock().unwrap().iter().any(|t| t == "db_list"),
        "the app never received db_list: the tool was not called through MCP"
    );
    assert!(
        stdout.contains(&name),
        "the answer did not carry the tool's result"
    );
    let _ = std::fs::remove_dir_all(dir);
}
