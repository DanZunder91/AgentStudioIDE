//! `agent-studio mcp` end to end, without the GUI: the real app binary as the MCP server Claude
//! Code starts, over real pipes, forwarding to the real listener's `/ctl` route; and the real
//! binary's `mcp install|status|uninstall` running a fake `claude` through the same
//! `AGENTSTUDIO_CLAUDE_BIN` override every spawn of `claude` honours.
//!
//! Hermetic: every store is in a temp dir, the database is a port nothing listens on, the
//! listener is on loopback, and the `claude` is a script that keeps its "config" next to itself
//! (with `HOME` and `CLAUDE_CONFIG_DIR` pointed at a temp dir too, so even a `claude` found by
//! mistake could not reach the user's config).
//!
//! Two tests run the real `claude` and are `#[ignore]`d. The throwaway-config one makes no model
//! call and is a blocking step of `npm run verify`. The other calls the model, with the user's
//! signed-in account, so it is only run by hand; it leaves nothing in the user's Claude Code
//! config, and asserts so.

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
/// link to the Agent Studio or the Claude Code session this test itself may be running in.
fn binary(args: &[&str], env: Option<&cli::CtlEnv>) -> Command {
    let mut c = Command::new(EXE);
    c.args(args);
    for v in ENV_VARS {
        c.env_remove(v);
    }
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key == "CLAUDECODE" || key == "CLAUDE_CONFIG_DIR" || key.starts_with("CLAUDE_CODE_") {
            c.env_remove(key.as_ref());
        }
    }
    if let Some(e) = env {
        c.env(ENV_VARS[0], &e.url)
            .env(ENV_VARS[1], &e.token)
            .env(ENV_VARS[2], &e.terminal_id);
    }
    c
}

/// stdin as when the user types a command in a terminal: `mcp install|uninstall` refuse to run
/// for anything else. A fresh pty's slave end; the master is returned so the terminal stays open
/// while the child runs.
#[cfg(unix)]
fn terminal_stdin() -> (Stdio, std::os::fd::OwnedFd) {
    use std::os::fd::FromRawFd as _;
    // openpty(3) is not safe to call from several threads at once on macOS.
    static ALLOC: Mutex<()> = Mutex::new(());
    let _one = ALLOC.lock().unwrap_or_else(|p| p.into_inner());
    let (mut master, mut slave) = (-1, -1);
    // SAFETY: openpty writes two fds into the out-pointers; the rest may be null.
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(rc, 0, "openpty: {}", std::io::Error::last_os_error());
    // SAFETY: both fds were just opened by openpty and are owned by nothing else.
    let (master, slave) = unsafe {
        (
            std::os::fd::OwnedFd::from_raw_fd(master),
            std::os::fd::OwnedFd::from_raw_fd(slave),
        )
    };
    (Stdio::from(slave), master)
}

/// On Windows, the console this test was started from.
#[cfg(windows)]
fn terminal_stdin() -> (Stdio, ()) {
    (Stdio::inherit(), ())
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
fn the_help_agents_read_names_the_server_but_not_how_to_install_it() {
    // `agent-studio help` is the help every agent is told to read.
    let out = binary(&["help"], None).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let help = String::from_utf8_lossy(&out.stdout);
    for line in ["agent-studio mcp\n", "agent-studio mcp status"] {
        assert!(help.contains(line), "{line}");
    }
    for word in ["install", "uninstall", "claude mcp add"] {
        assert!(
            !help.contains(word),
            "`agent-studio help` mentions {word}:\n{help}"
        );
    }
    // `mcp --help` is where the user finds them.
    let out = binary(&["mcp", "--help"], None).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let mcp_help = String::from_utf8_lossy(&out.stdout);
    assert!(mcp_help.contains("agent-studio mcp install"));
    assert!(mcp_help.contains("agent-studio mcp uninstall"));
    assert!(mcp_help.contains("claude mcp add --scope user"));
    let out = binary(&["mcp", "bogus"], None).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

/// An agent's command: started by Claude Code (`CLAUDECODE=1`), or read from no terminal. Either
/// way install and uninstall refuse before `claude` runs; the status still answers.
#[cfg(unix)]
#[test]
fn an_agent_running_install_or_uninstall_is_refused_and_claude_never_runs() {
    let claude = fake_claude("agent-refused");
    let dir = claude.parent().unwrap().to_path_buf();
    let fake = |args: &[&str]| {
        let mut c = binary(args, None);
        c.env("AGENTSTUDIO_CLAUDE_BIN", &claude)
            .env("HOME", &dir)
            .env("CLAUDE_CONFIG_DIR", dir.join("claude-config"));
        c
    };
    for verb in ["install", "uninstall"] {
        // From Claude Code's Bash tool: CLAUDECODE is set, even on a terminal.
        let (stdin, _terminal) = terminal_stdin();
        let out = fake(&["mcp", verb])
            .env("CLAUDECODE", "1")
            .stdin(stdin)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1), "{out:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("CLAUDECODE is set"), "{err}");
        assert!(err.contains("Settings →"), "{err}");
        assert!(err.contains("themselves in a terminal"), "{err}");
        // From any other program: its input is not a terminal.
        let out = fake(&["mcp", verb, "--json"]).output().unwrap();
        assert_eq!(out.status.code(), Some(1), "{out:?}");
        let report: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(report["ok"], false);
        assert!(report["message"]
            .as_str()
            .unwrap()
            .contains("not a terminal"));
    }
    assert!(
        !dir.join("argv.log").exists(),
        "claude ran: {:?}",
        std::fs::read_to_string(dir.join("argv.log"))
    );
    let out = fake(&["mcp", "status"])
        .env("CLAUDECODE", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(dir.join("argv.log").exists());
    let _ = std::fs::remove_dir_all(dir);
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
    // The user, at a terminal. HOME and CLAUDE_CONFIG_DIR are a backstop: if the override were
    // ever ignored, a real `claude` would still only see this temp dir.
    let run = |args: &[&str]| {
        let (stdin, _terminal) = terminal_stdin();
        binary(args, None)
            .env("AGENTSTUDIO_CLAUDE_BIN", &claude)
            .env("HOME", &dir)
            .env("CLAUDE_CONFIG_DIR", dir.join("claude-config"))
            .stdin(stdin)
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
    let out = binary(&["mcp", "status"], None)
        .env("AGENTSTUDIO_CLAUDE_BIN", dir.join("nope"))
        .env("HOME", &dir)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("Claude Code was not found"), "{err}");
    assert!(err.contains("AGENTSTUDIO_CLAUDE_BIN"), "{err}");
    let _ = std::fs::remove_dir_all(dir);
}

/// The real `claude mcp add|get|remove` behind `agent-studio mcp install|status|uninstall`, run as
/// the user runs them (at a terminal), in a throwaway `CLAUDE_CONFIG_DIR` and `HOME` so the user's
/// Claude Code config is never read or written. Checks the reading of Claude's real `get` output,
/// and that Claude's own health check starts this binary as a server and connects. No model call;
/// it needs only the installed `claude`, so it is a blocking local-integration step of
/// `npm run verify`:
///
/// `cargo test --test agent_mcp -- --ignored --exact real_claude_adds_checks_and_removes_the_server_in_a_throwaway_config`
#[test]
#[ignore = "runs the real claude CLI (in a throwaway config dir; no model call)"]
fn real_claude_adds_checks_and_removes_the_server_in_a_throwaway_config() {
    let dir = temp_dir("real-config");
    let config = dir.join("claude-config");
    let home = dir.join("home");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let before = user_claude();
    // The `claude` this machine has, found the way the app finds it, before HOME is moved: its
    // usual places are under the real home.
    let found = agent_ctl::mcp::Claude::resolve().expect("Claude Code is installed");
    let run = |args: &[&str]| {
        let (stdin, _terminal) = terminal_stdin();
        let mut cmd = binary(args, None);
        cmd.env("CLAUDE_CONFIG_DIR", &config).stdin(stdin);
        if cfg!(unix) {
            cmd.env("HOME", &home);
        }
        if found.invocation.prefix.is_empty() {
            cmd.env("AGENTSTUDIO_CLAUDE_BIN", &found.invocation.program);
        }
        let out = cmd.output().unwrap();
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

    // The user's own config gained nothing from this test. (Only this test's folders count in
    // `~/.claude/projects`: a session the user starts meanwhile is not this test's doing.)
    let after = user_claude();
    assert_eq!(
        before.servers, after.servers,
        "an agent-studio server appeared"
    );
    assert_eq!(before.temp_projects, after.temp_projects);
    let ours: Vec<&String> = after
        .projects
        .difference(&before.projects)
        .filter(|p| p.contains("agentstudio-mcp-it-"))
        .collect();
    assert!(ours.is_empty(), "~/.claude/projects gained {ours:?}");
    let _ = std::fs::remove_dir_all(dir);
}

/// What a test could leave in the user's own Claude Code config, read without changing it: the
/// entries of `~/.claude/projects`, and where `~/.claude.json` has an `agent-studio` server (user
/// scope, or a project's) or a project for one of this file's temp dirs. Names only, never
/// values: that file holds the user's account details.
#[derive(Debug, Default, PartialEq)]
struct UserClaude {
    projects: std::collections::BTreeSet<String>,
    servers: Vec<String>,
    temp_projects: Vec<String>,
}

fn user_claude() -> UserClaude {
    let Some(home) = agent_studio_scaffold_lib::agent::claude::home_dir() else {
        return UserClaude::default();
    };
    let projects = std::fs::read_dir(home.join(".claude").join("projects"))
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    // A running Claude Code rewrites the file now and then; a read caught mid-write is retried.
    let config: Value = (0..20)
        .find_map(|_| {
            let text = std::fs::read_to_string(home.join(".claude.json")).ok()?;
            let parsed = serde_json::from_str(&text).ok();
            if parsed.is_none() {
                std::thread::sleep(Duration::from_millis(100));
            }
            parsed
        })
        .unwrap_or(Value::Null);
    let mut servers = Vec::new();
    if config["mcpServers"].get("agent-studio").is_some() {
        servers.push("user".to_string());
    }
    let mut temp_projects = Vec::new();
    if let Some(all) = config["projects"].as_object() {
        for (path, project) in all {
            if project["mcpServers"].get("agent-studio").is_some() {
                servers.push(path.clone());
            }
            if path.contains("agentstudio-mcp-it-") {
                temp_projects.push(path.clone());
            }
        }
    }
    UserClaude {
        projects,
        servers,
        temp_projects,
    }
}

/// The real thing, with a model call: the signed-in `claude`, told about the built binary as an
/// MCP server, asked to call `db_list`, inside an environment where a test listener stands in for
/// the app, so the call goes all the way through.
///
/// It must leave nothing in the user's Claude Code config, and asserts that `~/.claude/projects`
/// gained no entry and `~/.claude.json` no `agent-studio` server and no project for its folder.
/// So: `--no-session-persistence` (no transcript), auto-memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`;
/// without it Claude Code makes `~/.claude/projects/<folder>/memory` even for a print-mode run),
/// a temp working folder, and the server only through `--strict-mcp-config --mcp-config <file>`.
/// It uses the user's Claude account (one tiny prompt), so it is not part of `npm run verify`;
/// its name shares no filter with the throwaway-config test, so running that one never runs this:
///
/// `cargo test --test agent_mcp -- --ignored --exact signed_in_claude_calls_an_agent_studio_tool_and_leaves_no_trace`
#[test]
#[ignore = "calls the model with the real, signed-in claude CLI"]
fn signed_in_claude_calls_an_agent_studio_tool_and_leaves_no_trace() {
    let dir = temp_dir("signed-in");
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

    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let config = dir.join("mcp.json");
    std::fs::write(
        &config,
        json!({"mcpServers": {"agent-studio": {"type": "stdio", "command": EXE, "args": ["mcp"]}}})
            .to_string(),
    )
    .unwrap();
    let before = user_claude();
    let claude = std::env::var("AGENTSTUDIO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    let mut cmd = Command::new(claude);
    cmd.current_dir(&work)
        // The prompt first: `--mcp-config` and `--allowedTools` take any number of values, so a
        // prompt after them is read as one more.
        .args([
            "-p",
            "Call the db_list tool once, then reply with only the connection names it lists.",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            &config.to_string_lossy(),
            "--allowedTools",
            "mcp__agent-studio__db_list",
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
    cmd.env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
    let out = finish(cmd.spawn().expect("claude"), Duration::from_secs(240));
    let stdout = String::from_utf8_lossy(&out.stdout);
    eprintln!(
        "claude exit {:?}\nstdout:\n{stdout}\nstderr:\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    let after = user_claude();
    let gained: Vec<&String> = after.projects.difference(&before.projects).collect();
    eprintln!(
        "~/.claude/projects: {} entries before, {} after; new: {gained:?}\n~/.claude.json \
         agent-studio servers: before {:?}, after {:?}; projects for this test's folders: {:?}",
        before.projects.len(),
        after.projects.len(),
        before.servers,
        after.servers,
        after.temp_projects
    );
    assert!(gained.is_empty(), "~/.claude/projects gained {gained:?}");
    assert_eq!(
        before.servers, after.servers,
        "~/.claude.json gained an agent-studio server"
    );
    assert_eq!(
        before.temp_projects, after.temp_projects,
        "~/.claude.json gained a project for this test's folder"
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
