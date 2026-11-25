//! Agent control end to end, without the GUI: the real listener's `/ctl` route over real TCP, and
//! the real app binary run as `agent-studio db …` against it — the path an agent's
//! `agent-studio db connect <url>` takes, minus the webview.
//!
//! Hermetic: every store is in a temp dir, the database is a port nothing listens on, and the
//! listener is on loopback.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::agent_ctl::{self, cli, CtlCall, CtlEvent, ToolCtx, UiSink};
use agent_studio_scaffold_lib::db::Paths;
use agent_studio_scaffold_lib::hook_listener::{CtlFuture, CtlHandler, HookListener};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn temp_paths(tag: &str) -> (std::path::PathBuf, Paths) {
    let dir = std::env::temp_dir().join(format!("agentstudio-ctl-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let paths = Paths::in_dir(&dir);
    (dir, paths)
}

fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.local_addr().unwrap().port()
}

/// A listener whose `/ctl` route is the real dispatcher over the temp dir, recording every hook
/// and every UI event the tools emit.
type Hooks = Arc<Mutex<Vec<String>>>;

#[derive(Default)]
struct Events(Mutex<Vec<CtlEvent>>);

impl UiSink for Events {
    fn emit(&self, event: CtlEvent) {
        self.0.lock().unwrap().push(event);
    }
}

fn start(paths: Paths) -> (cli::CtlEnv, Hooks, Arc<Events>) {
    let dir = paths.store.parent().unwrap().to_path_buf();
    let (listener, config) = HookListener::bind().expect("bind");
    let hooks: Hooks = Arc::default();
    let events: Arc<Events> = Arc::default();
    let (h, e) = (hooks.clone(), events.clone());
    let on_ctl: Arc<CtlHandler> = Arc::new(move |terminal_id: String, body: Vec<u8>| {
        let ctx = ToolCtx {
            dir: dir.clone(),
            terminal_id,
            ui: e.clone(),
        };
        Box::pin(async move {
            let (status, response) = agent_ctl::handle(ctx, &body).await;
            (status, serde_json::to_vec(&response).unwrap())
        }) as CtlFuture
    });
    listener.serve_with_ctl(
        move |terminal_id, _body| h.lock().unwrap().push(terminal_id),
        Some(on_ctl),
    );
    let env = cli::CtlEnv {
        url: config.base_url,
        token: config.token,
        terminal_id: "term-9".into(),
    };
    (env, hooks, events)
}

fn call(tool: &str, args: serde_json::Value) -> CtlCall {
    CtlCall {
        tool: tool.into(),
        args: args.as_object().unwrap().clone(),
    }
}

/// `cli::send` blocks; run it off the async runtime the listener serves on.
async fn send(env: &cli::CtlEnv, request: CtlCall) -> agent_ctl::CtlResponse {
    let env = env.clone();
    tokio::task::spawn_blocking(move || cli::send(&env, &request))
        .await
        .unwrap()
        .expect("the app answered")
}

#[tokio::test]
async fn the_ctl_route_answers_the_cli_and_hooks_still_go_to_the_hook_callback() {
    let (dir, paths) = temp_paths("route");
    let (env, hooks, events) = start(paths.clone());

    let listed = send(&env, call("db_list", serde_json::json!({}))).await;
    assert!(listed.ok);
    assert!(listed.message.starts_with("No database connections"));

    let port = dead_port();
    let created = send(
        &env,
        call(
            "db_connect",
            serde_json::json!({
                "url": format!("postgres://app:s3cret@127.0.0.1:{port}/shop"),
                "name": "Shop",
                "force": true,
            }),
        ),
    )
    .await;
    assert!(created.ok, "{}", created.message);
    assert!(created
        .message
        .contains("Saved in Agent Studio as \"Shop\""));
    assert!(!created.message.contains("s3cret"));
    let ev = events.0.lock().unwrap().clone();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].kind, "dbConnection");
    assert_eq!(
        ev[0].terminal_id, "term-9",
        "the event names the terminal that asked"
    );
    assert_eq!(ev[0].payload["created"], true);

    // A refusal is a reply with a message, not a transport error.
    let refused = send(
        &env,
        call(
            "db_connect",
            serde_json::json!({"url": format!("postgres://app:s3cret@127.0.0.1:{port}/other")}),
        ),
    )
    .await;
    assert!(!refused.ok);
    assert!(
        refused.message.contains("Nothing was saved"),
        "{}",
        refused.message
    );

    // The hook route on the same listener is untouched by the new one.
    let port = env.url.rsplit(':').next().unwrap().parse::<u16>().unwrap();
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let body = r#"{"hook_event_name":"Stop"}"#;
    s.write_all(
        format!(
            "POST / HTTP/1.1\r\nX-AgentStudio-Token: {}\r\nX-AgentStudio-Terminal: term-3\r\n\
             Content-Length: {}\r\n\r\n{body}",
            env.token,
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut reply = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), s.read_to_end(&mut reply)).await;
    assert!(String::from_utf8_lossy(&reply).starts_with("HTTP/1.1 204"));
    assert_eq!(hooks.lock().unwrap().as_slice(), ["term-3"]);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_ctl_request_without_the_token_never_reaches_the_handler() {
    let (dir, paths) = temp_paths("token");
    let (mut env, _hooks, events) = start(paths.clone());
    env.token = "0".repeat(64);
    let err = tokio::task::spawn_blocking(move || {
        cli::send(&env, &call("db_list", serde_json::json!({})))
    })
    .await
    .unwrap()
    .unwrap_err();
    assert!(err.contains("refused the request"), "{err}");
    assert!(events.0.lock().unwrap().is_empty());
    assert!(!paths.store.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn without_a_ctl_handler_the_route_answers_404_and_calls_no_hook() {
    let (listener, config) = HookListener::bind().unwrap();
    let hooks: Hooks = Arc::default();
    let h = hooks.clone();
    listener.serve(move |t, _| h.lock().unwrap().push(t));
    let env = cli::CtlEnv {
        url: config.base_url,
        token: config.token,
        terminal_id: "t".into(),
    };
    let err = tokio::task::spawn_blocking(move || {
        cli::send(&env, &call("db_list", serde_json::json!({})))
    })
    .await
    .unwrap()
    .unwrap_err();
    assert!(err.contains("404"), "{err}");
    assert!(hooks.lock().unwrap().is_empty());
}

/// The real app binary, run as a command: it must answer and exit — never open a window — and
/// print what the app said, with the exit code the agent reads.
#[tokio::test]
async fn the_app_binary_in_command_mode_talks_to_the_running_app_and_exits() {
    let (dir, paths) = temp_paths("bin");
    let (env, _hooks, _events) = start(paths.clone());
    let exe = env!("CARGO_BIN_EXE_agent-studio-scaffold");
    let port = dead_port();
    let run = move |args: Vec<String>, env: Option<cli::CtlEnv>| {
        let mut c = std::process::Command::new(exe);
        c.args(&args)
            .env_remove("AGENTSTUDIO_HOOK_URL")
            .env_remove("AGENTSTUDIO_HOOK_TOKEN")
            .env_remove("AGENTSTUDIO_TERMINAL_ID");
        if let Some(e) = env {
            c.env("AGENTSTUDIO_HOOK_URL", e.url)
                .env("AGENTSTUDIO_HOOK_TOKEN", e.token)
                .env("AGENTSTUDIO_TERMINAL_ID", e.terminal_id);
        }
        c.output().unwrap()
    };
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    let e = env.clone();
    let url = format!("postgres://app:s3cret@127.0.0.1:{port}/shop");
    let out = tokio::task::spawn_blocking(move || {
        run(
            args(&["db", "connect", &url, "--force", "--name", "From the CLI"]),
            Some(e),
        )
    })
    .await
    .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(
        stdout.contains("Saved in Agent Studio as \"From the CLI\""),
        "{stdout}"
    );
    assert!(!stdout.contains("s3cret"));

    let e = env.clone();
    let out = tokio::task::spawn_blocking(move || run(args(&["db", "list", "--json"]), Some(e)))
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("--json prints JSON");
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"][0]["name"], "From the CLI");
    assert_eq!(v["data"][0]["readOnly"], true);

    // A refusal exits 1 with the reason on stderr.
    let e = env.clone();
    let out = tokio::task::spawn_blocking(move || {
        run(args(&["db", "connect", "postgres://a:{{X}}@h/db"]), Some(e))
    })
    .await
    .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Vault variable"));

    // Outside an Agent Studio terminal: exit 2, and no window ever opened (it returned).
    let out = tokio::task::spawn_blocking(move || run(args(&["db", "list"]), None))
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("inside Agent Studio"));

    let out = tokio::task::spawn_blocking(move || run(args(&["help"]), None))
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("agent-studio db connect <url>"));
    let _ = std::fs::remove_dir_all(dir);
}
