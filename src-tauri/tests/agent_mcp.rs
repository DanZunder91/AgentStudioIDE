//! `agent-studio mcp` end to end: the real binary as Claude Code's MCP server over pipes to the
//! real `/ctl` listener, and `mcp install|status|uninstall` against a fake `claude`. Hermetic;
//! one `#[ignore]`d test runs the real `claude` in a throwaway config (a blocking verify step).

#[cfg(unix)]
use std::collections::{BTreeMap, BTreeSet};
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
/// link to the Agent Studio or the Claude Code session this test itself may be running in: no
/// `CLAUDE*` variable reaches it (`CLAUDECODE`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_*`, …).
fn binary(args: &[&str], env: Option<&cli::CtlEnv>) -> Command {
    let mut c = Command::new(EXE);
    c.args(args);
    for v in ENV_VARS {
        c.env_remove(v);
    }
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("CLAUDE") {
            c.env_remove(key);
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
    // …and tells the agent reading it what the user can do, not what to run next.
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(said.contains("not added to Claude Code"), "{said}");
    assert!(
        said.contains(
            "Settings → \"Add Agent Studio to Claude Code\", or run `agent-studio mcp install` \
             yourself in a terminal"
        ),
        "{said}"
    );
    assert!(!said.contains("Add it with"), "{said}");
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

/// The real `claude mcp add|get|remove` in a throwaway config (no model call; a blocking
/// `verify` step on macOS/Linux). Asserts the user's `~/.claude.json`, its backups and mirrored
/// paths ([`ClaudeTouch`]) keep length, mtime and hash: an add+remove leaves the same bytes.
#[cfg(unix)]
#[test]
#[ignore = "runs the real claude CLI (in a throwaway config dir; no model call)"]
fn real_claude_adds_checks_and_removes_the_server_in_a_throwaway_config() {
    // The `claude` this machine has, found the way the app finds it, before HOME is moved: its
    // usual places are under the real home.
    let found = agent_ctl::mcp::Claude::resolve().expect("Claude Code is installed");
    let user = UserClaude::of_this_process().expect("a home directory");
    let mut watch = user.seed();
    let mut attempts = Vec::new();
    for _ in 0..ATTEMPTS {
        let dir = temp_dir("real-config");
        let tag = dir.file_name().unwrap().to_string_lossy().into_owned();
        let throwaway = Throwaway {
            config: dir.join("claude-config"),
            home: dir.join("home"),
        };
        let before = snapshot(&watch);
        add_check_and_remove(&found, &throwaway);
        let after = snapshot(&watch);
        let reach = user.reach(&throwaway, &tag);
        // A path named after this run's own temp dir can only have come from this run.
        let ours: Vec<&PathBuf> = reach.absent.iter().filter(|p| p.exists()).collect();
        assert!(
            ours.is_empty(),
            "this run wrote the user's own config: {ours:?}"
        );
        let changed = changes(&before, &after);
        let unwatched: Vec<PathBuf> = reach.cover.difference(&watch).cloned().collect();
        let _ = std::fs::remove_dir_all(&dir);
        if changed.is_empty() && unwatched.is_empty() {
            eprintln!(
                "the user's Claude Code config is byte-identical: {} path(s) compared",
                watch.len()
            );
            return;
        }
        let attempt = format!("changed: {changed:?}; not yet compared: {unwatched:?}");
        eprintln!("run {} again: {attempt}", attempts.len() + 1);
        attempts.push(attempt);
        watch.extend(unwatched);
    }
    panic!(
        "the user's Claude Code config did not come out byte-identical in any of {ATTEMPTS} runs \
         (every running Claude Code session also writes it now and then, which is why a run is \
         repeated; a leak changes it every time): {attempts:#?}"
    );
}

/// Attempts at the ~4 s sequence: live sessions rewrite `~/.claude.json` every 5–7 s, but a leak
/// from this test changes it every run, so one byte-identical run proves it (false fail ≈ 0.5^10).
#[cfg(unix)]
const ATTEMPTS: usize = 10;

/// The throwaway Claude Code config one run of the real `claude` gets.
#[cfg(unix)]
struct Throwaway {
    config: PathBuf,
    home: PathBuf,
}

/// `agent-studio mcp status`, `install`, `status`, `install` again, `uninstall`, `status`, with the
/// real `claude`, in `throwaway`.
#[cfg(unix)]
fn add_check_and_remove(found: &agent_ctl::mcp::Claude, throwaway: &Throwaway) {
    std::fs::create_dir_all(&throwaway.config).unwrap();
    std::fs::create_dir_all(&throwaway.home).unwrap();
    let run = |args: &[&str]| {
        let (stdin, _terminal) = terminal_stdin();
        let home = &throwaway.home;
        let mut cmd = binary(args, None);
        cmd.env("CLAUDE_CONFIG_DIR", &throwaway.config)
            .env("HOME", home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_STATE_HOME", home.join(".local/state"))
            .current_dir(home)
            .stdin(stdin);
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
    // Claude wrote its own config, and wrote it here: the throwaway dir is the one it uses.
    let saved = std::fs::read_to_string(throwaway.config.join(".claude.json")).unwrap();
    assert!(saved.contains("agent-studio"), "{saved}");
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
}

/// The user's own Claude Code config: `~/.claude.json` and the config dir (`~/.claude`, or
/// `CLAUDE_CONFIG_DIR` when the user set one), and the home dir it lives in.
#[cfg(unix)]
struct UserClaude {
    home: PathBuf,
    config: PathBuf,
}

/// Where a [`Throwaway`] `claude` run could have written, mapped onto the user's config dir
/// and home (its `.claude.json` also at `~/.claude.json`).
#[cfg(unix)]
#[derive(Debug, Default, PartialEq)]
struct ClaudeTouch {
    /// Paths compared before and after (length, mtime, hash; folders by entry), so timestamped
    /// names like `backups/.claude.json.backup.<ms>` are caught too.
    cover: BTreeSet<PathBuf>,
    /// Paths named after the run's own temp dir (Claude Code names its per-folder caches after the
    /// folder it runs in): they did not exist before the run, so they must not exist after it.
    absent: Vec<PathBuf>,
}

#[cfg(unix)]
impl UserClaude {
    fn of_this_process() -> Option<Self> {
        let home = agent_studio_scaffold_lib::agent::claude::home_dir()?;
        let config = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        Some(Self { home, config })
    }

    /// What `claude mcp add|get|remove` is known to write, compared from the first run on:
    /// its config file, and the backups it keeps of it.
    fn seed(&self) -> BTreeSet<PathBuf> {
        BTreeSet::from([
            self.home.join(".claude.json"),
            self.config.join(".claude.json"),
            self.config.join("backups"),
        ])
    }

    fn reach(&self, throwaway: &Throwaway, tag: &str) -> ClaudeTouch {
        let mut touch = ClaudeTouch::default();
        for (from, to) in [
            (&throwaway.config, &self.config),
            (&throwaway.home, &self.home),
        ] {
            let written = walk(from);
            for rel in &written {
                let tagged = |p: &Path| p.to_string_lossy().contains(tag);
                if tagged(rel) {
                    touch.absent.push(to.join(rel));
                    continue;
                }
                // A folder holding one named after this run (`Library/Caches/claude-cli-nodejs`):
                // that one is checked; the folder itself is shared with the rest of the machine.
                if written.iter().any(|w| w.starts_with(rel) && tagged(w)) {
                    continue;
                }
                if rel.components().count() == 1 {
                    touch.cover.insert(to.join(rel));
                } else {
                    touch.cover.insert(to.join(rel.parent().unwrap()));
                }
                if rel == Path::new(".claude.json") {
                    touch.cover.insert(self.home.join(".claude.json"));
                }
            }
        }
        touch
    }
}

/// Every file and folder under `root`, relative to it.
#[cfg(unix)]
fn walk(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut todo = vec![PathBuf::new()];
    while let Some(rel) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(root.join(&rel)) else {
            continue;
        };
        for e in entries.flatten() {
            let path = rel.join(e.file_name());
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                todo.push(path.clone());
            }
            found.push(path);
        }
    }
    found.sort();
    found
}

/// What a path held, without its bytes: those are the user's (account details among them).
#[cfg(unix)]
#[derive(Debug, Clone, PartialEq)]
enum Seen {
    Absent,
    File {
        len: u64,
        modified: Option<std::time::SystemTime>,
        hash: Option<u64>,
    },
    /// A folder compared by its entries.
    Dir(BTreeMap<String, Seen>),
    /// A folder inside a compared folder: its modification time, which any entry added or
    /// removed in it changes.
    Subdir(Option<std::time::SystemTime>),
    Unreadable(std::io::ErrorKind),
}

#[cfg(unix)]
fn see(path: &Path, top: bool) -> Seen {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Seen::Absent,
        Err(e) => return Seen::Unreadable(e.kind()),
    };
    if meta.is_dir() {
        if !top {
            return Seen::Subdir(meta.modified().ok());
        }
        return match std::fs::read_dir(path) {
            Ok(entries) => Seen::Dir(
                entries
                    .flatten()
                    .map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        (name, see(&e.path(), false))
                    })
                    .collect(),
            ),
            Err(e) => Seen::Unreadable(e.kind()),
        };
    }
    let hash = std::fs::read(path).ok().map(|bytes| {
        use std::hash::{Hash as _, Hasher as _};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut h);
        h.finish()
    });
    Seen::File {
        len: meta.len(),
        modified: meta.modified().ok(),
        hash,
    }
}

#[cfg(unix)]
fn snapshot(watch: &BTreeSet<PathBuf>) -> BTreeMap<PathBuf, Seen> {
    watch.iter().map(|p| (p.clone(), see(p, true))).collect()
}

/// Each path whose state differs, with what differs: names and sizes, never contents.
#[cfg(unix)]
fn changes(before: &BTreeMap<PathBuf, Seen>, after: &BTreeMap<PathBuf, Seen>) -> Vec<String> {
    fn what(a: &Seen, b: &Seen) -> String {
        match (a, b) {
            (
                Seen::File {
                    len: l1,
                    modified: m1,
                    hash: h1,
                },
                Seen::File {
                    len: l2,
                    modified: m2,
                    hash: h2,
                },
            ) => {
                let mut d = Vec::new();
                if l1 != l2 {
                    d.push(format!("length {l1} → {l2}"));
                }
                if m1 != m2 {
                    d.push("modification time".to_string());
                }
                if h1 != h2 {
                    d.push("content".to_string());
                }
                d.join(", ")
            }
            (Seen::Dir(x), Seen::Dir(y)) => {
                let names: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
                names
                    .into_iter()
                    .filter(|n| x.get(*n) != y.get(*n))
                    .map(|n| match (x.get(n), y.get(n)) {
                        (None, _) => format!("{n} added"),
                        (_, None) => format!("{n} removed"),
                        (Some(a), Some(b)) => format!("{n}: {}", what(a, b)),
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            }
            (Seen::Absent, _) => "appeared".to_string(),
            (_, Seen::Absent) => "disappeared".to_string(),
            (a, b) => format!("{a:?} → {b:?}"),
        }
    }
    before
        .iter()
        .filter_map(|(path, was)| {
            let now = after.get(path).unwrap_or(&Seen::Absent);
            (was != now).then(|| format!("{}: {}", path.display(), what(was, now)))
        })
        .collect()
}

/// The check the real-claude test rests on, against a stand-in for the user's home: a file
/// rewritten with the same bytes, a same-length edit with its time put back, a new backup, and
/// where a throwaway run's writes land.
#[cfg(unix)]
#[test]
fn the_user_config_check_sees_every_kind_of_write_a_run_could_make() {
    let user_dir = temp_dir("user-home");
    let user = UserClaude {
        home: user_dir.clone(),
        config: user_dir.join(".claude"),
    };
    let state = user.home.join(".claude.json");
    let backups = user.config.join("backups");
    std::fs::create_dir_all(&backups).unwrap();
    std::fs::write(&state, br#"{"numStartups":1}"#).unwrap();
    std::fs::write(backups.join(".claude.json.backup.1"), b"{}").unwrap();
    let watch = user.seed();
    let set_time = |path: &Path, t: std::time::SystemTime| {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    };
    let quiet = snapshot(&watch);
    assert_eq!(changes(&quiet, &snapshot(&watch)), Vec::<String>::new());

    // The same bytes written again: only the modification time says so.
    let original = std::fs::metadata(&state).unwrap().modified().unwrap();
    std::fs::write(&state, br#"{"numStartups":1}"#).unwrap();
    set_time(&state, original + Duration::from_secs(1));
    assert_eq!(
        changes(&quiet, &snapshot(&watch)),
        [format!("{}: modification time", state.display())]
    );
    // Other bytes of the same length, with the time put back: only the hash says so.
    std::fs::write(&state, br#"{"numStartups":2}"#).unwrap();
    set_time(&state, original);
    assert_eq!(
        changes(&quiet, &snapshot(&watch)),
        [format!("{}: content", state.display())]
    );
    std::fs::write(&state, br#"{"numStartups":1}"#).unwrap();
    set_time(&state, original);
    // A backup with a name no run could predict.
    std::fs::write(backups.join(".claude.json.backup.2"), b"{}").unwrap();
    assert_eq!(
        changes(&quiet, &snapshot(&watch)),
        [format!(
            "{}: .claude.json.backup.2 added",
            backups.display()
        )]
    );
    std::fs::remove_file(backups.join(".claude.json.backup.2")).unwrap();
    assert_eq!(changes(&quiet, &snapshot(&watch)), Vec::<String>::new());

    // Where a throwaway run's writes land in the user's config.
    let run_dir = temp_dir("real-config");
    let tag = run_dir.file_name().unwrap().to_string_lossy().into_owned();
    let throwaway = Throwaway {
        config: run_dir.join("claude-config"),
        home: run_dir.join("home"),
    };
    let cache = Path::new("Library/Caches/claude-cli-nodejs");
    let per_folder = cache.join(format!("-private-var-{tag}-home/mcp-logs-agent-studio"));
    for dir in [
        throwaway.config.join("backups"),
        throwaway.config.join("plugins/store"),
        throwaway.home.join(&per_folder),
    ] {
        std::fs::create_dir_all(dir).unwrap();
    }
    for file in [
        throwaway.config.join(".claude.json"),
        throwaway.config.join("backups/.claude.json.backup.9"),
        throwaway.config.join("plugins/store/x.json"),
        throwaway.home.join(per_folder.join("1.jsonl")),
    ] {
        std::fs::write(file, b"{}").unwrap();
    }
    let reach = user.reach(&throwaway, &tag);
    assert_eq!(
        reach.cover,
        BTreeSet::from([
            user.home.join(".claude.json"),
            user.config.join(".claude.json"),
            user.config.join("backups"),
            user.config.join("plugins"),
            user.config.join("plugins/store"),
        ])
    );
    let mut absent = reach.absent.clone();
    absent.sort();
    assert_eq!(
        absent,
        [
            user.home
                .join(cache.join(format!("-private-var-{tag}-home"))),
            user.home.join(&per_folder),
            user.home.join(per_folder.join("1.jsonl")),
        ]
    );
    // What the first run is not yet comparing, a later one does.
    assert_eq!(
        reach.cover.difference(&watch).cloned().collect::<Vec<_>>(),
        [
            user.config.join("plugins"),
            user.config.join("plugins/store")
        ]
    );
    let _ = std::fs::remove_dir_all(run_dir);
    let _ = std::fs::remove_dir_all(user_dir);
}
