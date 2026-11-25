//! The MCP server driven over in-memory pipes, with its calls forwarded to a real listener whose
//! `/ctl` route is the real dispatcher over a temp dir; and the install against a fake `claude`
//! that records its argv. Nothing here reads or writes a real Claude Code config or app store.
use super::*;
use crate::agent_ctl::tests::Recorder;
use crate::agent_ctl::{handle, ToolCtx};
use crate::db::Paths;
use crate::hook_listener::{CtlFuture, CtlHandler, HookListener};

/// A writer the test reads back after `serve` (which takes it by value) returns.
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Serve `lines` and return every message written, each checked to be one JSON-RPC 2.0 message
/// on a line of its own: stdout never carries anything else.
fn exchange(lines: &[String], env: Option<CtlEnv>) -> Vec<Value> {
    let input = lines.join("\n") + "\n";
    let sink = Sink::default();
    serve(io::Cursor::new(input.into_bytes()), sink.clone(), env).unwrap();
    let raw = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
    assert!(raw.is_empty() || raw.ends_with('\n'), "{raw}");
    raw.lines()
        .map(|l| {
            let v: Value = serde_json::from_str(l).expect("only JSON-RPC on stdout");
            assert_eq!(v["jsonrpc"], "2.0", "{l}");
            v
        })
        .collect()
}

fn req(id: impl Into<Value>, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id.into(), "method": method, "params": params}).to_string()
}

fn call(id: i64, tool: &str, arguments: Value) -> String {
    req(
        id,
        "tools/call",
        json!({"name": tool, "arguments": arguments}),
    )
}

fn by_id(replies: &[Value], id: i64) -> &Value {
    replies
        .iter()
        .find(|r| r["id"] == id)
        .unwrap_or_else(|| panic!("no reply to {id}: {replies:#?}"))
}

fn text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap()
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("agentstudio-mcp-{tag}-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.local_addr().unwrap().port()
}

/// The running app, as far as an agent can tell: the real listener, its `/ctl` route the real
/// dispatcher over `dir`, recording the UI events the tools emit.
fn app(dir: &Path) -> (CtlEnv, Arc<Recorder>) {
    let (listener, config) = HookListener::bind().unwrap();
    let events = Arc::new(Recorder::default());
    let (ui, dir) = (events.clone(), dir.to_path_buf());
    let on_ctl: Arc<CtlHandler> = Arc::new(move |terminal_id: String, body: Vec<u8>| {
        let ctx = ToolCtx {
            dir: dir.clone(),
            terminal_id,
            ui: ui.clone(),
        };
        Box::pin(async move {
            let (status, reply) = handle(ctx, &body).await;
            (status, serde_json::to_vec(&reply).unwrap())
        }) as CtlFuture
    });
    listener.serve_with_ctl(|_, _| {}, Some(on_ctl));
    let env = CtlEnv {
        url: config.base_url,
        token: config.token,
        terminal_id: "term-mcp".into(),
    };
    (env, events)
}

// ---- the protocol --------------------------------------------------------------------------

#[test]
fn initialize_answers_with_the_clients_version_when_it_is_one_we_speak() {
    let replies = exchange(
        &[
            req(
                0,
                "initialize",
                json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t"}}),
            ),
            req(1, "initialize", json!({"protocolVersion": "2024-11-05"})),
            req(2, "initialize", json!({"protocolVersion": "1999-01-01"})),
            req("s", "initialize", Value::Null),
        ],
        None,
    );
    assert_eq!(replies.len(), 4);
    // Id 0 is an id like any other (it is the one Claude Code sends first).
    let first = &by_id(&replies, 0)["result"];
    assert_eq!(first["protocolVersion"], "2025-11-25");
    assert_eq!(first["serverInfo"]["name"], "agent-studio");
    assert_eq!(first["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(first["capabilities"]["tools"].is_object());
    assert!(first["instructions"]
        .as_str()
        .unwrap()
        .contains("Agent Studio"));
    assert_eq!(
        by_id(&replies, 1)["result"]["protocolVersion"],
        "2024-11-05"
    );
    // A version we do not speak gets our newest; the client decides.
    assert_eq!(
        by_id(&replies, 2)["result"]["protocolVersion"],
        PROTOCOL_VERSIONS[0]
    );
    let named = replies.iter().find(|r| r["id"] == "s").unwrap();
    assert_eq!(named["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
}

#[test]
fn notifications_and_responses_get_no_reply_and_a_ping_gets_an_empty_result() {
    let replies = exchange(
        &[
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}})
                .to_string(),
            json!({"jsonrpc": "2.0", "id": 77, "result": {}}).to_string(),
            String::new(),
            "   ".to_string(),
            req(1, "ping", Value::Null),
        ],
        None,
    );
    assert_eq!(
        replies,
        vec![json!({"jsonrpc": "2.0", "id": 1, "result": {}})]
    );
}

#[test]
fn the_tool_list_is_the_registry_with_its_generated_schemas() {
    let replies = exchange(&[req(1, "tools/list", json!({}))], None);
    let tools = by_id(&replies, 1)["result"]["tools"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(tools.len(), registry::all().len());
    for spec in registry::all() {
        let tool = tools
            .iter()
            .find(|t| t["name"] == spec.name)
            .unwrap_or_else(|| panic!("{} is missing", spec.name));
        assert_eq!(tool["description"], registry::description(spec));
        assert_eq!(tool["inputSchema"], registry::json_schema(spec));
    }
    let connect = tools.iter().find(|t| t["name"] == "db_connect").unwrap();
    assert_eq!(connect["inputSchema"]["required"], json!(["url"]));
    assert_eq!(
        connect["inputSchema"]["properties"]["force"]["type"],
        "boolean"
    );
    let list = tools.iter().find(|t| t["name"] == "db_list").unwrap();
    assert_eq!(list["inputSchema"]["properties"], json!({}));
}

#[test]
fn protocol_mistakes_get_json_rpc_errors() {
    let replies = exchange(
        &[
            "{not json".to_string(),
            "[1, 2]".to_string(),
            req(3, "resources/list", Value::Null),
            req(4, "tools/call", json!({"arguments": {}})),
            req(
                5,
                "tools/call",
                json!({"name": "db_list", "arguments": "x"}),
            ),
            json!({"jsonrpc": "2.0", "id": 6}).to_string(),
        ],
        None,
    );
    assert_eq!(replies.len(), 6, "{replies:#?}");
    let code = |r: &Value| r["error"]["code"].as_i64().unwrap();
    assert_eq!(code(&replies[0]), PARSE_ERROR);
    assert_eq!(replies[0]["id"], Value::Null);
    assert_eq!(code(&replies[1]), INVALID_REQUEST);
    assert_eq!(code(by_id(&replies, 3)), METHOD_NOT_FOUND);
    assert!(by_id(&replies, 3)["error"]["message"]
        .as_str()
        .unwrap()
        .contains("resources/list"));
    assert_eq!(code(by_id(&replies, 4)), INVALID_PARAMS);
    assert_eq!(code(by_id(&replies, 5)), INVALID_PARAMS);
    assert_eq!(code(by_id(&replies, 6)), INVALID_REQUEST);
}

#[test]
fn an_oversized_message_is_refused_without_ending_the_session() {
    let big = format!("{{\"x\":\"{}\"}}", "a".repeat(MAX_LINE));
    let replies = exchange(&[big, req(1, "ping", Value::Null)], None);
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["error"]["code"], INVALID_REQUEST);
    assert!(replies[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("MB"));
    assert_eq!(replies[1]["id"], 1);
}

#[test]
fn lines_are_read_in_any_chunking_and_bounded() {
    let mut r =
        io::BufReader::with_capacity(3, io::Cursor::new(b"short\n0123456789abc\nlast".to_vec()));
    assert_eq!(
        read_line(&mut r, 8).unwrap(),
        Some(Line::Text(b"short".to_vec()))
    );
    assert_eq!(read_line(&mut r, 8).unwrap(), Some(Line::TooLong));
    // The last line needs no newline; then the input is over.
    assert_eq!(
        read_line(&mut r, 8).unwrap(),
        Some(Line::Text(b"last".to_vec()))
    );
    assert_eq!(read_line(&mut r, 8).unwrap(), None);
    let mut empty = io::Cursor::new(Vec::new());
    assert_eq!(read_line(&mut empty, 8).unwrap(), None);
    // A line of exactly the limit is accepted.
    let mut exact = io::Cursor::new(b"12345678\n".to_vec());
    assert_eq!(
        read_line(&mut exact, 8).unwrap(),
        Some(Line::Text(b"12345678".to_vec()))
    );
}

// ---- tools/call ----------------------------------------------------------------------------

#[test]
fn outside_agent_studio_every_call_says_where_to_run_it() {
    let replies = exchange(&[call(1, "db_list", json!({}))], None);
    let result = &by_id(&replies, 1)["result"];
    assert_eq!(result["isError"], true);
    assert!(
        text(result).contains("open this from a terminal inside Agent Studio"),
        "{result}"
    );
    assert!(result.get("structuredContent").is_none());
}

#[test]
fn a_call_is_forwarded_to_the_running_app_and_its_answer_comes_back() {
    let dir = temp_dir("call");
    let (env, events) = app(&dir);
    let port = dead_port();
    let url = format!("postgres://app:s3cret@127.0.0.1:{port}/shop");
    let replies = exchange(
        &[
            call(1, "db_list", json!({})),
            call(
                2,
                "db_connect",
                json!({"url": url, "name": "Shop", "force": true}),
            ),
            call(3, "db_connect", json!({"url": "postgres://a:{{PW}}@h/db"})),
            call(4, "no_such_tool", json!({})),
            // Not validated here: the app answers for the arguments, like it does for the CLI.
            call(5, "db_connect", json!({"url": 5})),
            req(6, "tools/call", json!({"name": "db_list"})),
        ],
        Some(env),
    );
    assert_eq!(replies.len(), 6);

    let listed = &by_id(&replies, 1)["result"];
    assert_eq!(listed["isError"], false);
    assert!(
        text(listed).starts_with("No database connections"),
        "{listed}"
    );
    // A list is kept as data under `result`: structuredContent is always an object.
    assert_eq!(listed["structuredContent"], json!({"result": []}));

    let saved = &by_id(&replies, 2)["result"];
    assert_eq!(saved["isError"], false, "{saved}");
    assert!(text(saved).contains("Saved in Agent Studio as \"Shop\""));
    assert_eq!(saved["structuredContent"]["created"], true);
    assert_eq!(saved["structuredContent"]["connection"]["name"], "Shop");

    let vault = &by_id(&replies, 3)["result"];
    assert_eq!(vault["isError"], true);
    assert!(text(vault).contains("Vault variable"), "{vault}");
    assert!(vault.get("structuredContent").is_none());

    let unknown = &by_id(&replies, 4)["result"];
    assert_eq!(unknown["isError"], true);
    assert!(
        text(unknown).contains("no tool `no_such_tool`"),
        "{unknown}"
    );

    let mistyped = &by_id(&replies, 5)["result"];
    assert_eq!(mistyped["isError"], true);
    assert!(text(mistyped).contains("must be a string"), "{mistyped}");

    // No arguments at all is an empty object.
    assert_eq!(by_id(&replies, 6)["result"]["isError"], false);

    // The password never comes back, in any reply.
    let all = serde_json::to_string(&replies).unwrap();
    assert!(!all.contains("s3cret"));

    // The app saw it as the terminal's own action: one event, attributed to the terminal.
    let ev = events.0.lock().unwrap().clone();
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(ev[0].kind, "dbConnection");
    assert_eq!(ev[0].terminal_id, "term-mcp");
    assert!(Paths::in_dir(&dir).store.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn many_calls_at_once_are_all_answered_each_under_its_own_id() {
    let dir = temp_dir("many");
    let (env, _events) = app(&dir);
    let lines: Vec<String> = (0..(MAX_IN_FLIGHT as i64 + 9))
        .map(|i| call(i, "db_list", json!({})))
        .chain([req(1000, "ping", Value::Null)])
        .collect();
    let replies = exchange(&lines, Some(env));
    assert_eq!(replies.len(), lines.len());
    for i in 0..(MAX_IN_FLIGHT as i64 + 9) {
        assert_eq!(by_id(&replies, i)["result"]["isError"], false);
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_unreachable_app_is_an_error_result_that_says_so() {
    let env = CtlEnv {
        url: format!("http://127.0.0.1:{}", dead_port()),
        token: "0".repeat(64),
        terminal_id: "t".into(),
    };
    let replies = exchange(&[call(1, "db_list", json!({}))], Some(env));
    let result = &by_id(&replies, 1)["result"];
    assert_eq!(result["isError"], true);
    assert!(
        text(result).contains("could not reach Agent Studio"),
        "{result}"
    );
}

#[test]
fn a_reply_becomes_text_structured_content_and_an_error_flag() {
    let object = call_result(Ok(CtlResponse::ok("done", json!({"rows": 1}))));
    assert_eq!(
        object,
        json!({
            "content": [{"type": "text", "text": "done"}],
            "isError": false,
            "structuredContent": {"rows": 1},
        })
    );
    let refused = call_result(Ok(CtlResponse::err("no")));
    assert_eq!(refused["isError"], true);
    assert!(refused.get("structuredContent").is_none());
    let scalar = call_result(Ok(CtlResponse::ok("n", json!(3))));
    assert_eq!(scalar["structuredContent"], json!({"result": 3}));
    let transport = call_result(Err("could not reach Agent Studio".into()));
    assert_eq!(transport["isError"], true);
    assert_eq!(
        text(&transport),
        "agent-studio: could not reach Agent Studio"
    );
}

// ---- reading `claude mcp get` ---------------------------------------------------------------

fn output(code: Option<i32>, stdout: &str, stderr: &str) -> Output {
    Output {
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
}

/// `claude mcp get agent-studio` as Claude Code 2.1.x prints it (here for an entry whose server
/// could not start: the entry is there all the same).
fn get_answer(command: &str, args: &str) -> String {
    format!(
        "agent-studio:\n  Scope: User config (available in all your projects)\n  Status: ✘ \
         Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed\n  Type: stdio\n  \
         Command: {command}\n  Args: {args}\n  Environment:\n\nTo remove this server, run: \
         claude mcp remove agent-studio -s user\n"
    )
}

#[test]
fn claudes_answer_is_read_for_installed_missing_and_another_copy() {
    let exe = Path::new("/Applications/Agent Studio.app/Contents/MacOS/agent-studio");
    let ours = interpret_get(
        &output(Some(0), &get_answer(&exe.to_string_lossy(), "mcp"), ""),
        exe,
    );
    assert_eq!(ours.state, McpState::Installed);
    assert!(ours.ok);
    assert_eq!(ours.configured.as_deref(), Some(&*exe.to_string_lossy()));
    assert!(ours.scope.as_deref().unwrap().starts_with("User config"));
    assert!(ours.message.contains("User config"));

    let missing = interpret_get(
        &output(
            Some(1),
            "",
            "No MCP server named \"agent-studio\". Run `claude mcp add` to add one.",
        ),
        exe,
    );
    assert_eq!((missing.state, missing.ok), (McpState::NotInstalled, true));
    assert!(missing.message.contains("agent-studio mcp install"));

    let other = interpret_get(
        &output(Some(0), &get_answer("/old/agent-studio", "mcp"), ""),
        exe,
    );
    assert_eq!(other.state, McpState::Different);
    assert_eq!(other.configured.as_deref(), Some("/old/agent-studio"));
    assert!(
        other.message.contains("/old/agent-studio mcp"),
        "{}",
        other.message
    );

    // The same binary with other arguments is not this server.
    let flags = interpret_get(
        &output(Some(0), &get_answer(&exe.to_string_lossy(), "mcp --x"), ""),
        exe,
    );
    assert_eq!(flags.state, McpState::Different);

    let http = interpret_get(
        &output(
            Some(0),
            "agent-studio:\n  Scope: Local config\n  Type: http\n  URL: http://127.0.0.1:9/mcp\n",
            "",
        ),
        exe,
    );
    assert_eq!(http.state, McpState::Different);
    assert_eq!(http.configured.as_deref(), Some("http://127.0.0.1:9/mcp"));
}

#[test]
fn an_answer_that_cannot_be_read_is_reported_not_guessed() {
    let exe = Path::new("/a/agent-studio");
    let odd = interpret_get(&output(Some(0), "agent-studio: fine\n", ""), exe);
    assert_eq!((odd.state, odd.ok), (McpState::Failed, false));
    assert!(
        odd.message.contains("agent-studio: fine"),
        "{}",
        odd.message
    );

    let failed = interpret_get(&output(Some(3), "", "boom\nmore"), exe);
    assert_eq!(failed.state, McpState::Failed);
    assert!(failed.message.ends_with("boom"), "{}", failed.message);

    let silent = interpret_get(&output(Some(4), "", ""), exe);
    assert!(silent.message.contains("exited with code 4"));
    let killed = interpret_get(&output(None, "", ""), exe);
    assert!(killed.message.contains("stopped before"));

    let long = "x".repeat(DETAIL_CHARS * 2);
    let cut = interpret_get(&output(Some(2), &long, ""), exe);
    assert!(cut.message.ends_with('…'));
    assert!(cut.message.len() < long.len());
}

#[test]
fn the_binary_claude_starts_is_this_one_or_the_appimage_on_linux() {
    let current = PathBuf::from("/tmp/.mount_x/usr/bin/agent-studio");
    let image = std::env::current_exe().unwrap(); // any file that exists
    assert_eq!(exe_for(current.clone(), Some(image.clone()), true), image);
    assert_eq!(exe_for(current.clone(), Some(image), false), current);
    assert_eq!(
        exe_for(current.clone(), Some(PathBuf::from("rel/x.AppImage")), true),
        current
    );
    assert_eq!(
        exe_for(
            current.clone(),
            Some(PathBuf::from("/no/such.AppImage")),
            true
        ),
        current
    );
    assert_eq!(exe_for(current.clone(), None, true), current);
    assert!(server_exe().unwrap().is_absolute());
}

#[cfg(unix)]
#[test]
fn the_same_binary_is_recognised_through_a_link() {
    let dir = temp_dir("link");
    let real = dir.join("agent-studio");
    std::fs::write(&real, "x").unwrap();
    let link = dir.join("linked");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(same_file(&link.to_string_lossy(), &real));
    assert!(!same_file(&dir.join("other").to_string_lossy(), &real));
    let _ = std::fs::remove_dir_all(dir);
}

// ---- install / uninstall / status against a fake `claude` -----------------------------------

/// A fake `claude` in its own temp dir: it keeps its one server entry and its argv log there.
#[cfg(unix)]
struct FakeClaude {
    dir: PathBuf,
    claude: Claude,
}

#[cfg(unix)]
impl FakeClaude {
    fn new(tag: &str) -> Self {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = temp_dir(&format!("claude-{tag}"));
        let script = dir.join("claude");
        std::fs::write(
            &script,
            include_str!("../../tests/fixtures/fake-claude-mcp.sh"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let claude = Claude {
            invocation: ClaudeInvocation {
                program: script.to_string_lossy().into_owned(),
                prefix: Vec::new(),
            },
            cwd: Some(dir.clone()),
            timeout: Duration::from_secs(20),
        };
        Self { dir, claude }
    }

    /// Every run's argv, in order.
    fn runs(&self) -> Vec<Vec<String>> {
        let log = std::fs::read_to_string(self.dir.join("argv.log")).unwrap_or_default();
        let mut runs = vec![Vec::new()];
        for line in log.lines() {
            if line == "--end--" {
                runs.push(Vec::new());
            } else {
                runs.last_mut().unwrap().push(line.to_string());
            }
        }
        runs.pop();
        runs
    }

    fn entry(&self, command: &str) {
        std::fs::write(self.dir.join("entry"), format!("{command}\nmcp\n")).unwrap();
    }

    fn mode(&self, mode: &str) {
        std::fs::write(self.dir.join("mode"), mode).unwrap();
    }
}

#[cfg(unix)]
impl Drop for FakeClaude {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[cfg(unix)]
#[test]
fn install_status_and_uninstall_run_claudes_own_commands() {
    let fake = FakeClaude::new("cycle");
    // A real app path has spaces in it: it must reach `claude` as one argument.
    let exe = Path::new("/Applications/Agent Studio.app/Contents/MacOS/agent-studio");
    let exe_s = exe.to_string_lossy().into_owned();
    let c = &fake.claude;

    let before = status(c, exe);
    assert_eq!((before.state, before.ok), (McpState::NotInstalled, true));
    assert_eq!(fake.runs(), vec![words(&["mcp", "get", "agent-studio"])]);

    let added = install(c, exe);
    assert_eq!(
        (added.state, added.ok),
        (McpState::Installed, true),
        "{}",
        added.message
    );
    assert!(added.message.contains(&exe_s));
    assert_eq!(
        fake.runs().last().unwrap(),
        &words(&[
            "mcp",
            "add",
            "--scope",
            "user",
            "agent-studio",
            "--",
            &exe_s,
            "mcp"
        ])
    );

    let now = status(c, exe);
    assert_eq!(now.state, McpState::Installed);
    assert_eq!(now.configured.as_deref(), Some(exe_s.as_str()));

    // Again: nothing changes, and it says so.
    let runs = fake.runs().len();
    let again = install(c, exe);
    assert_eq!((again.state, again.ok), (McpState::Installed, true));
    assert!(again.message.contains("already added"), "{}", again.message);
    assert_eq!(
        fake.runs()[runs..]
            .iter()
            .map(|r| r[1].as_str())
            .collect::<Vec<_>>(),
        ["add", "get"],
        "an add Claude refused, then a look; no remove"
    );

    let removed = uninstall(c, exe);
    assert_eq!((removed.state, removed.ok), (McpState::NotInstalled, true));
    assert_eq!(
        fake.runs().last().unwrap(),
        &words(&["mcp", "remove", "--scope", "user", "agent-studio"])
    );
    assert_eq!(status(c, exe).state, McpState::NotInstalled);

    let nothing = uninstall(c, exe);
    assert_eq!((nothing.state, nothing.ok), (McpState::NotInstalled, true));
    assert!(nothing.message.contains("nothing was removed"));
}

#[cfg(unix)]
#[test]
fn an_entry_for_another_copy_of_the_app_is_reported_then_pointed_here() {
    let fake = FakeClaude::new("other");
    fake.entry("/Volumes/Old/Agent Studio.app/Contents/MacOS/agent-studio");
    let exe = Path::new("/Applications/Agent Studio.app/Contents/MacOS/agent-studio");
    let c = &fake.claude;

    let seen = status(c, exe);
    assert_eq!(seen.state, McpState::Different);
    assert!(seen.message.contains("/Volumes/Old"), "{}", seen.message);

    let fixed = install(c, exe);
    assert_eq!(
        (fixed.state, fixed.ok),
        (McpState::Installed, true),
        "{}",
        fixed.message
    );
    assert!(fixed.message.contains("/Volumes/Old"), "{}", fixed.message);
    let verbs: Vec<String> = fake.runs().iter().map(|r| r[1].clone()).collect();
    assert_eq!(verbs, ["get", "add", "get", "remove", "add"]);
    assert_eq!(status(c, exe).state, McpState::Installed);
}

#[cfg(unix)]
#[test]
fn a_claude_that_fails_answers_oddly_or_hangs_is_reported() {
    let exe = Path::new("/opt/agent-studio");

    let fake = FakeClaude::new("fail");
    fake.mode("fail");
    for report in [
        status(&fake.claude, exe),
        install(&fake.claude, exe),
        uninstall(&fake.claude, exe),
    ] {
        assert_eq!((report.state, report.ok), (McpState::Failed, false));
        assert!(
            report.message.contains("boom: the config is locked"),
            "{}",
            report.message
        );
    }

    let fake = FakeClaude::new("garbage");
    fake.mode("garbage");
    let odd = status(&fake.claude, exe);
    assert_eq!(odd.state, McpState::Failed);
    assert!(odd.message.contains("could not read"), "{}", odd.message);
    // An add that "worked" but said it in an unknown form is taken at its exit code.
    assert_eq!(install(&fake.claude, exe).state, McpState::Installed);

    let mut fake = FakeClaude::new("hang");
    fake.mode("hang");
    fake.claude.timeout = Duration::from_millis(300);
    let started = Instant::now();
    let hung = status(&fake.claude, exe);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(hung.state, McpState::Failed);
    assert!(hung.message.contains("did not answer"), "{}", hung.message);

    // A claude that cannot be started at all.
    let gone = Claude {
        invocation: ClaudeInvocation {
            program: "/no/such/claude".into(),
            prefix: Vec::new(),
        },
        cwd: None,
        timeout: Duration::from_secs(5),
    };
    for report in [
        status(&gone, exe),
        install(&gone, exe),
        uninstall(&gone, exe),
    ] {
        assert_eq!(report.state, McpState::Failed);
        assert!(
            report.message.contains("could not be started"),
            "{}",
            report.message
        );
    }
}

#[cfg(unix)]
#[test]
fn an_app_claude_could_not_start_later_is_never_installed() {
    let fake = FakeClaude::new("translocated");
    for exe in [
        "/private/var/folders/x/T/AppTranslocation/ABC/d/Agent Studio.app/Contents/MacOS/agent-studio",
        "agent-studio",
    ] {
        let report = install(&fake.claude, Path::new(exe));
        assert_eq!((report.state, report.ok), (McpState::Failed, false));
        assert!(report.message.contains("Nothing was changed"), "{}", report.message);
    }
    assert!(fake.runs().is_empty(), "claude was never asked");
}

#[cfg(unix)]
#[test]
fn the_command_line_prints_a_sentence_or_json_and_exits_with_the_outcome() {
    let fake = FakeClaude::new("cli");
    let exe = PathBuf::from("/opt/Agent Studio/agent-studio");
    let run = |args: &[&str], claude: Result<Claude, String>, exe: Result<PathBuf, String>| {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = command(&words(args), claude, exe, &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    };
    let ok = || Ok(fake.claude.clone());

    let (code, out, err) = run(&["status", "--json"], ok(), Ok(exe.clone()));
    assert_eq!(code, 0, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["state"], "notInstalled");
    assert_eq!(v["ok"], true);
    assert_eq!(v["exe"], "/opt/Agent Studio/agent-studio");

    let (code, out, _) = run(&["install"], ok(), Ok(exe.clone()));
    assert_eq!(code, 0);
    assert!(
        out.starts_with("Added Agent Studio to Claude Code"),
        "{out}"
    );

    let (code, out, _) = run(&["uninstall"], ok(), Ok(exe.clone()));
    assert_eq!(code, 0);
    assert!(out.starts_with("Removed Agent Studio"), "{out}");

    // Failures go to stderr with exit 1.
    let (code, out, err) = run(
        &["status"],
        Err("could not find the `claude` executable".into()),
        Ok(exe.clone()),
    );
    assert_eq!((code, out.as_str()), (1, ""));
    assert!(err.contains("Claude Code was not found"), "{err}");
    let (code, _, err) = run(&["status"], ok(), Err("no exe".into()));
    assert_eq!(code, 1);
    assert!(err.contains("no exe"));

    // Usage.
    let (code, out, _) = run(&["--help"], ok(), Ok(exe.clone()));
    assert_eq!(code, 0);
    assert!(out.contains("agent-studio mcp install"));
    for bad in [
        &["bogus"][..],
        &["status", "--bogus"],
        &["status", "install"],
        &[],
    ] {
        let (code, _, err) = run(bad, ok(), Ok(exe.clone()));
        assert_eq!(code, 2, "{bad:?}");
        assert!(err.contains("agent-studio mcp status"), "{err}");
    }
}
