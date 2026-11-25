//! The HTTP agent tools end to end, without the GUI: the real listener's `/ctl` route over real
//! TCP, the real app binary run as `agent-studio http …` / `agent-studio api …`, the real HTTP
//! engine, and a real hyper server on loopback — the path an agent's command takes, minus the
//! webview.
//!
//! Hermetic: the API store and the history live in a temp dir, the server is in-process on
//! 127.0.0.1, and the listener is on loopback.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use agent_studio_scaffold_lib::agent_ctl::{self, cli, CtlCall, CtlEvent, ToolCtx, UiSink};
use agent_studio_scaffold_lib::api_store::{
    self, ApiStore, EnvVar, Environment, HttpHeader, SavedRequest,
};
use agent_studio_scaffold_lib::history_store;
use agent_studio_scaffold_lib::hook_listener::{CtlFuture, CtlHandler, HookListener};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};

const SECRET: &str = "sk_it_0123456789abcdef";

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentstudio-http-it-{tag}-{}-{}",
        std::process::id(),
        ulid::Ulid::new()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A hyper HTTP/1.1 server: `/json` (a JSON object), `/echo` (the request's method, path,
/// headers and body back as JSON), `/v1/user` and `/v2/user` (two versions of one resource).
async fn serve() -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let svc = service_fn(|req: Request<Incoming>| async move {
                    let method = req.method().to_string();
                    let path = req
                        .uri()
                        .path_and_query()
                        .map(|p| p.to_string())
                        .unwrap_or_default();
                    let headers: Vec<(String, String)> = req
                        .headers()
                        .iter()
                        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into()))
                        .collect();
                    let body = req.into_body().collect().await.unwrap().to_bytes();
                    let (status, extra, out) = match path.split('?').next().unwrap_or("/") {
                        // Written out, not `json!`: the key order on the wire is under test.
                        "/json" => (
                            200,
                            None,
                            Value::String(r#"{"z":1,"a":{"deep":[true]}}"#.into()),
                        ),
                        "/echo" => (
                            200,
                            None,
                            json!({
                                "method": method,
                                "path": path,
                                "headers": headers,
                                "body": String::from_utf8_lossy(&body),
                            }),
                        ),
                        "/v1/user" => (200, None, json!({"id": 7, "name": "Ada", "plan": "free"})),
                        "/v2/user" => (
                            200,
                            Some(("x-api-version", "2")),
                            json!({"id": 7, "name": "Ada", "plan": "pro", "seats": 3}),
                        ),
                        _ => (404, None, json!({"error": "no route"})),
                    };
                    let mut resp = Response::builder()
                        .status(status)
                        .header("content-type", "application/json");
                    if let Some((k, v)) = extra {
                        resp = resp.header(k, v);
                    }
                    let text = match out {
                        Value::String(raw) => raw,
                        other => other.to_string(),
                    };
                    Ok::<_, Infallible>(resp.body(Full::new(Bytes::from(text))).unwrap())
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), svc)
                    .await;
            });
        }
    });
    port
}

#[derive(Default)]
struct Events(Mutex<Vec<CtlEvent>>);

impl UiSink for Events {
    fn emit(&self, event: CtlEvent) {
        self.0.lock().unwrap().push(event);
    }
}

impl Events {
    fn kinds(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.kind.clone())
            .collect()
    }
}

/// The real listener with the real dispatcher over `dir`, recording every UI event.
fn start(dir: &std::path::Path) -> (cli::CtlEnv, Arc<Events>) {
    let dir = dir.to_path_buf();
    let (listener, config) = HookListener::bind().expect("bind");
    let events: Arc<Events> = Arc::default();
    let e = events.clone();
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
    listener.serve_with_ctl(|_, _| {}, Some(on_ctl));
    let env = cli::CtlEnv {
        url: config.base_url,
        token: config.token,
        terminal_id: "term-http".into(),
    };
    (env, events)
}

/// `cli::send` blocks; run it off the runtime the listener serves on.
async fn send(env: &cli::CtlEnv, tool: &str, args: Value) -> agent_ctl::CtlResponse {
    let env = env.clone();
    let call = CtlCall {
        tool: tool.into(),
        args: args.as_object().unwrap().clone(),
    };
    tokio::task::spawn_blocking(move || cli::send(&env, &call))
        .await
        .unwrap()
        .expect("the app answered")
}

/// The app binary in command mode, with this listener's terminal env.
async fn run_binary(env: &cli::CtlEnv, args: &[&str]) -> std::process::Output {
    let exe = env!("CARGO_BIN_EXE_agent-studio-scaffold");
    let env = env.clone();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        std::process::Command::new(exe)
            .args(&args)
            .env("AGENTSTUDIO_HOOK_URL", env.url)
            .env("AGENTSTUDIO_HOOK_TOKEN", env.token)
            .env("AGENTSTUDIO_TERMINAL_ID", env.terminal_id)
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

fn saved(id: &str, name: &str, method: &str, url: &str) -> SavedRequest {
    SavedRequest {
        id: id.into(),
        name: name.into(),
        method: method.into(),
        url: url.into(),
        headers: Vec::new(),
        body: String::new(),
        protocol: None,
        grpc_service: None,
        grpc_method: None,
        plaintext: None,
        folder_id: None,
    }
}

/// The user's API client: requests built on `{{BASE}}` and `{{TOKEN}}`, and an active
/// environment holding a live token.
fn write_user_store(dir: &std::path::Path, port: u16) {
    let mut echo = saved("r-echo", "Who am I", "POST", "{{BASE}}/echo?key={{TOKEN}}");
    echo.headers = vec![HttpHeader {
        name: "Authorization".into(),
        value: "Bearer {{TOKEN}}".into(),
    }];
    echo.body = "{\"token\":\"{{TOKEN}}\"}".into();
    let store = ApiStore {
        collections: vec![
            echo,
            saved("r-v1", "User v1", "GET", "{{BASE}}/v1/user"),
            saved("r-v2", "User v2", "GET", "{{BASE}}/v2/user"),
        ],
        environments: vec![Environment {
            id: "e-local".into(),
            name: "local".into(),
            variables: vec![
                EnvVar {
                    key: "BASE".into(),
                    value: format!("http://127.0.0.1:{port}"),
                },
                EnvVar {
                    key: "TOKEN".into(),
                    value: SECRET.into(),
                },
            ],
        }],
        active_environment_id: Some("e-local".into()),
        folders: Vec::new(),
    };
    // The same file the app's API client reads and writes.
    let path = api_store::path_in(dir);
    std::fs::write(&path, serde_json::to_vec_pretty(&store).unwrap()).unwrap();
    assert_eq!(api_store::load(&path), store);
}

/// An agent's `agent-studio http send` from a shell: the binary posts to the app, the app sends
/// through its own engine, records the exchange and tells the UI; the agent reads the response.
#[tokio::test]
async fn the_binary_sends_an_agents_request_and_the_app_records_it() {
    let port = serve().await;
    let dir = temp_dir("send");
    let (env, events) = start(&dir);
    let url = format!("http://127.0.0.1:{port}/json");

    let out = run_binary(&env, &["http", "send", &url, "--header", "X-From: agent"]).await;
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(stdout.starts_with("200 OK in "), "{stdout}");
    assert!(
        stdout.contains("Body (JSON, re-indented):\n{\n  \"z\": 1,\n  \"a\": {\n    \"deep\": ["),
        "keys stay in the server's order: {stdout}"
    );

    // A whole curl command, and --json for structured output.
    let curl = format!("curl -sX POST http://127.0.0.1:{port}/echo -H 'X-A: 1' --data-raw 'hello'");
    let out = run_binary(&env, &["http", "send", "--curl", &curl, "--json"]).await;
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v: Value = serde_json::from_slice(&out.stdout).expect("--json prints JSON");
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"]["status"], 200);
    let echoed: Value = serde_json::from_str(v["data"]["body"].as_str().unwrap()).unwrap();
    assert_eq!(echoed["method"], "POST");
    assert_eq!(echoed["body"], "hello");

    let h = history_store::load(&history_store::path_in(&dir)).entries;
    assert_eq!(h.len(), 2, "both sends are in the API history");
    assert_eq!(h[0].url, url);
    assert_eq!(h[0].headers[0].name, "X-From");
    assert_eq!(h[1].method, "POST");
    assert_eq!(h[1].body, "hello");
    assert_eq!(events.kinds(), vec!["apiHistory", "apiHistory"]);
    assert_eq!(events.0.lock().unwrap()[0].terminal_id, "term-http");
    let _ = std::fs::remove_dir_all(dir);
}

/// 🔴 The refusal, through the real command: a request naming a Vault variable exits 1 with
/// the reason, sends nothing and records nothing.
#[tokio::test]
async fn the_binary_refuses_a_vault_reference_and_nothing_happens() {
    let port = serve().await;
    let dir = temp_dir("refuse");
    let (env, events) = start(&dir);
    for args in [
        vec!["http", "send", "http://127.0.0.1:1/x?k={{TOKEN}}"],
        vec![
            "http",
            "open",
            "http://127.0.0.1:1/",
            "--header",
            "Authorization: {{TOKEN}}",
        ],
        vec![
            "http",
            "send",
            "--curl",
            "curl http://127.0.0.1:1/ -d '{{TOKEN}}'",
        ],
        vec![
            "http",
            "send",
            "http://127.0.0.1:1/",
            "--body-json",
            "{\"t\":\"{{TOKEN}}\"}",
        ],
    ] {
        let out = run_binary(&env, &args).await;
        assert_eq!(out.status.code(), Some(1), "{args:?}: {out:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("Vault variable"), "{args:?}: {stderr}");
    }
    let url = format!("http://127.0.0.1:{port}/echo");
    let refused = send(
        &env,
        "api_compare",
        json!({"a": url, "b": url, "header": ["X: {{TOKEN}}"]}),
    )
    .await;
    assert!(!refused.ok);
    assert!(refused.message.contains("Vault variable"));
    assert!(events.kinds().is_empty(), "a refusal shows nothing");
    assert!(
        !history_store::path_in(&dir).exists(),
        "a refusal records nothing"
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// 🔴 A request the user saved runs with the user's token, and the token never comes back: the
/// echo server repeats it in the query, the Authorization header and the body, and the agent
/// reads `{{TOKEN}}` in every place. The history keeps the literal request.
#[tokio::test]
async fn api_run_uses_the_users_secret_on_the_wire_and_never_returns_it() {
    let port = serve().await;
    let dir = temp_dir("run");
    write_user_store(&dir, port);
    let (env, events) = start(&dir);

    let out = run_binary(&env, &["api", "run", "who am i", "--json"]).await;
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        !stdout.contains(SECRET),
        "a Vault value reached the agent: {stdout}"
    );
    let v: Value = serde_json::from_str(&stdout).unwrap();
    let echoed: Value = serde_json::from_str(v["data"]["body"].as_str().unwrap()).unwrap();
    assert_eq!(echoed["path"], "/echo?key={{TOKEN}}");
    assert_eq!(echoed["body"], "{\"token\":\"{{TOKEN}}\"}");
    let auth = echoed["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h[0] == "authorization")
        .unwrap();
    assert_eq!(auth[1], "Bearer {{TOKEN}}");
    assert_eq!(v["data"]["request"]["environment"], "local");

    let history_file = std::fs::read_to_string(history_store::path_in(&dir)).unwrap();
    assert!(
        !history_file.contains(SECRET),
        "a resolved secret reached the history"
    );
    let h = history_store::load(&history_store::path_in(&dir)).entries;
    assert_eq!(h[0].url, "{{BASE}}/echo?key={{TOKEN}}");
    assert_eq!(h[0].status, Some(200));
    assert_eq!(events.kinds(), vec!["apiHistory"]);

    // The listings an agent uses to find it carry names, never values.
    for tool in ["api_collections", "api_envs", "api_history"] {
        let r = send(&env, tool, json!({})).await;
        assert!(r.ok, "{tool}: {}", r.message);
        let all = format!("{}{}", r.message, r.data);
        assert!(!all.contains(SECRET), "{tool} leaked the token: {all}");
        assert!(
            !all.contains(&format!("127.0.0.1:{port}")),
            "{tool} leaked a variable's value: {all}"
        );
    }
    let envs = send(&env, "api_envs", json!({})).await;
    assert!(
        envs.message.contains("* local — BASE, TOKEN"),
        "{}",
        envs.message
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn api_compare_reports_the_differences_between_two_saved_requests() {
    let port = serve().await;
    let dir = temp_dir("compare");
    write_user_store(&dir, port);
    let (env, events) = start(&dir);
    let out = run_binary(&env, &["api", "compare", "User v1", "User v2"]).await;
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(stdout.contains("Same status (200)."), "{stdout}");
    assert!(
        stdout.contains("  + x-api-version: 2 (only in B)"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Body (JSON, keys sorted): 2 differences."),
        "{stdout}"
    );
    assert!(
        stdout.contains("  ~ $.plan: \"free\" → \"pro\""),
        "{stdout}"
    );
    assert!(stdout.contains("  + $.seats: 3 (only in B)"), "{stdout}");
    assert_eq!(
        history_store::load(&history_store::path_in(&dir))
            .entries
            .len(),
        2
    );
    assert_eq!(events.kinds(), vec!["apiHistory"]);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn http_open_hands_the_request_to_the_ui_and_sends_nothing() {
    let dir = temp_dir("open");
    let (env, events) = start(&dir);
    let out = run_binary(
        &env,
        &[
            "http",
            "open",
            "https://api.example.com/orders",
            "--method",
            "put",
            "--body-json",
            "{\"qty\":2}",
        ],
    )
    .await;
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stdout).contains("Nothing was sent"));
    let ev = events.0.lock().unwrap().clone();
    assert_eq!(ev.len(), 1);
    assert_eq!(
        serde_json::to_value(&ev[0]).unwrap(),
        json!({
            "kind": "httpOpen",
            "terminalId": "term-http",
            "method": "PUT",
            "url": "https://api.example.com/orders",
            "headers": [{"name": "Content-Type", "value": "application/json"}],
            "body": "{\"qty\":2}",
            "title": "PUT api.example.com/orders",
        })
    );
    assert!(!history_store::path_in(&dir).exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_help_lists_every_http_and_api_command() {
    let dir = temp_dir("help");
    let (env, _) = start(&dir);
    let out = run_binary(&env, &["help"]).await;
    let help = String::from_utf8_lossy(&out.stdout);
    for words in [
        "http send [<url>]",
        "http open [<url>]",
        "api collections",
        "api envs",
        "api history [--limit <limit>]",
        "api run <request>",
        "api compare <a> <b>",
    ] {
        assert!(help.contains(words), "{words} missing from:\n{help}");
    }
    let out = run_binary(&env, &["help", "http", "send"]).await;
    let one = String::from_utf8_lossy(&out.stdout);
    assert!(one.contains("--body-json <json>"), "{one}");
    assert!(one.contains("[--header <header>]…"), "{one}");
    assert!(one.contains("Vault variable"), "{one}");
    let _ = std::fs::remove_dir_all(dir);
}
