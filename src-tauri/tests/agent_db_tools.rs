//! The database tools the way an agent reaches them: the real app binary run as
//! `agent-studio db …` in a terminal, talking to the real listener's `/ctl` route, which runs the
//! real dispatcher over stores in a temp dir — the webview replaced by a recorder.
//!
//! The hermetic tests need no database: they cover the arguments, the exit codes, the saved
//! queries and the console, against a connection saved at a port nothing listens on. The
//! `#[ignore]`d ones run the same commands against the Docker fixture's PostgreSQL
//! (`npm run db:fixtures:up`, then `cargo test --test agent_db_tools -- --ignored`).

use std::sync::{Arc, Mutex};

use agent_studio_scaffold_lib::agent_ctl::{self, cli, CtlEvent, ToolCtx, UiSink};
use agent_studio_scaffold_lib::db::Paths;
use agent_studio_scaffold_lib::hook_listener::{CtlFuture, CtlHandler, HookListener};

fn temp_paths(tag: &str) -> (std::path::PathBuf, Paths) {
    let dir = std::env::temp_dir().join(format!(
        "agentstudio-dbtools-it-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let paths = Paths::in_dir(&dir);
    (dir, paths)
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

/// A listener whose `/ctl` route is the real dispatcher over `paths`' directory.
fn start(paths: &Paths) -> (cli::CtlEnv, Arc<Events>) {
    let dir = paths.store.parent().unwrap().to_path_buf();
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
        terminal_id: "term-db".into(),
    };
    (env, events)
}

/// What one run of the binary printed.
struct Out {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// `agent-studio <args>` from a terminal carrying `env`, off the async runtime.
async fn run(env: &cli::CtlEnv, args: &[&str]) -> Out {
    let exe = env!("CARGO_BIN_EXE_agent-studio-scaffold");
    let env = env.clone();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new(exe)
            .args(&args)
            .env("AGENTSTUDIO_HOOK_URL", env.url)
            .env("AGENTSTUDIO_HOOK_TOKEN", env.token)
            .env("AGENTSTUDIO_TERMINAL_ID", env.terminal_id)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    Out {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

#[tokio::test]
async fn the_cli_saves_and_lists_queries_and_opens_a_console_with_exit_codes_an_agent_can_read() {
    let (dir, paths) = temp_paths("cli");
    let (env, events) = start(&paths);
    let port = dead_port();
    let url = format!("postgres://app:s3cret@127.0.0.1:{port}/shop");

    let out = run(
        &env,
        &["db", "connect", &url, "--force", "--name", "Shop DB"],
    )
    .await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);

    // Saved queries: added (never overwritten), listed, and shown to the user.
    let out = run(
        &env,
        &[
            "db",
            "save",
            "query",
            "shop db",
            "Top customers",
            "SELECT name FROM customers ORDER BY spent DESC LIMIT 10",
        ],
    )
    .await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);
    assert!(
        out.stdout
            .starts_with("Saved \"Top customers\" in the saved queries of \"Shop DB\""),
        "{}",
        out.stdout
    );
    let out = run(&env, &["db", "queries", "SHOP DB", "--json"]).await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);
    let v: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(v["data"]["queries"][0]["name"], "Top customers");
    assert_eq!(
        v["data"]["queries"][0]["query"],
        "SELECT name FROM customers ORDER BY spent DESC LIMIT 10"
    );

    // A console with the query typed in, not run.
    let out = run(&env, &["db", "console", "Shop DB", "SELECT 1"]).await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);
    assert!(out.stdout.contains("It was NOT run"), "{}", out.stdout);

    let kinds: Vec<String> = events
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.kind.clone())
        .collect();
    assert_eq!(kinds, ["dbConnection", "dbSavedQuery", "dbConsole"]);
    let console = events.0.lock().unwrap()[2].clone();
    assert_eq!(console.terminal_id, "term-db");
    assert_eq!(console.payload["query"], "SELECT 1");

    // An unknown connection: exit 1, the saved names on stderr, nothing opened.
    let out = run(&env, &["db", "query", "billing", "SELECT 1"]).await;
    assert_eq!(out.code, Some(1));
    assert!(
        out.stderr
            .contains("There is no saved connection named \"billing\". Saved: \"Shop DB\"."),
        "{}",
        out.stderr
    );
    assert_eq!(events.0.lock().unwrap().len(), 3, "a refusal opens nothing");

    // An unreachable database: exit 1, said without the password.
    let out = run(&env, &["db", "test", "Shop DB"]).await;
    assert_eq!(out.code, Some(1));
    assert!(
        out.stderr.starts_with("Could not connect to \"Shop DB\""),
        "{}",
        out.stderr
    );
    assert!(!out.stderr.contains("s3cret") && !out.stdout.contains("s3cret"));

    // A missing argument is a usage error (exit 2) and names what is missing.
    let out = run(&env, &["db", "query", "Shop DB"]).await;
    assert_eq!(out.code, Some(2));
    assert!(
        out.stderr.contains("db query needs query"),
        "{}",
        out.stderr
    );
    let out = run(
        &env,
        &["db", "query", "Shop DB", "SELECT 1", "--limit", "many"],
    )
    .await;
    assert_eq!(out.code, Some(2));
    assert!(
        out.stderr.contains("must be a whole number"),
        "{}",
        out.stderr
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_help_lists_every_database_tool_with_its_arguments() {
    let (dir, paths) = temp_paths("help");
    let (env, _) = start(&paths);
    let out = run(&env, &["help"]).await;
    assert_eq!(out.code, Some(0));
    for synopsis in [
        "agent-studio db test <connection>",
        "agent-studio db schema <connection> [--path <path>]",
        "agent-studio db search <connection> <pattern> [--path <path>]",
        "agent-studio db query <connection> <query> [--limit <limit>]",
        "agent-studio db console <connection> [<query>]",
        "agent-studio db queries <connection>",
        "agent-studio db save query <connection> <name> <query>",
    ] {
        assert!(
            out.stdout.contains(synopsis),
            "{synopsis} missing:\n{}",
            out.stdout
        );
    }
    let out = run(&env, &["help", "db", "query"]).await;
    // The real boundary, stated where the agent reads it.
    for said in [
        "Read-only stops data writes, not everything",
        "use a least-privileged account for agent work",
    ] {
        assert!(out.stdout.contains(said), "{said}:\n{}", out.stdout);
    }
    assert!(out.stdout.contains("at most 1000"), "{}", out.stdout);
    let _ = std::fs::remove_dir_all(dir);
}

/* ───────────────────── live: the Docker fixture's PostgreSQL ───────────────────── */

/// TEST FIXTURE ONLY — published in this repo, bound to localhost.
const FIXTURE_URL: &str = "postgresql://agentstudio:agentstudio-test-pw@127.0.0.1:55432/maestro";

#[tokio::test]
#[ignore = "needs the Docker fixture — run with --ignored"]
async fn live_an_agent_queries_postgres_from_its_terminal() {
    let (dir, paths) = temp_paths("live");
    let (env, events) = start(&paths);
    let out = run(&env, &["db", "connect", FIXTURE_URL, "--name", "Maestro"]).await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);

    let out = run(
        &env,
        &[
            "db",
            "query",
            "maestro",
            "SELECT id, title FROM tracks ORDER BY id",
            "--limit",
            "2",
        ],
    )
    .await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);
    assert!(
        out.stdout.contains(
            "id | title\n---+----------\n1  | Amberline\n2  | Bluewater\n(2 rows, more exist)"
        ),
        "{}",
        out.stdout
    );
    assert!(!out.stdout.contains("agentstudio-test-pw"));

    // A query that starts with `--` goes in --query; --json is the structured reply.
    let out = run(
        &env,
        &[
            "db",
            "query",
            "maestro",
            "--query",
            "-- how many\nSELECT count(*) AS n FROM tall",
            "--json",
        ],
    )
    .await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);
    let v: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(
        v["data"]["results"][0]["rows"],
        serde_json::json!([["2000"]])
    );

    // Agent Studio's guard refuses: exit 1, the reason on stderr, and the user is shown it.
    let out = run(
        &env,
        &[
            "db",
            "query",
            "maestro",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
        ],
    )
    .await;
    assert_eq!(out.code, Some(1));
    assert!(out.stderr.contains("read-only"), "{}", out.stderr);
    let runs = events
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.kind == "dbQueryRun")
        .count();
    assert_eq!(runs, 3, "every run on the connection is shown to the user");

    let out = run(
        &env,
        &["db", "schema", "maestro", "--path", "maestro/public/tracks"],
    )
    .await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);
    assert!(out.stdout.contains("column  ensemble"), "{}", out.stdout);

    let out = run(&env, &["db", "search", "maestro", "tall"]).await;
    assert_eq!(out.code, Some(0), "{}", out.stderr);
    assert!(
        out.stdout.contains("table  maestro/public/Tables/tall"),
        "{}",
        out.stdout
    );
    let _ = std::fs::remove_dir_all(dir);
}
