//! Dev-app goldens: `procs-list.json` (`procscan::assemble` over a synthetic process table +
//! `docker::parse_ps`), `app-lines.json` (real `AppTails` → `LogHub`), `procs-commands.json`.
//! The IDE is pid 100 with two terminals. Normalised: ids, timestamps, temp prefix → `/work`.

use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::logstream::{LogHub, LogKind, LogLine, NullLogSink};
use agent_studio_scaffold_lib::procscan::ide::{IdeTerminal, Origin};
use agent_studio_scaffold_lib::procscan::logfiles::{Console, Fd, FdKind};
use agent_studio_scaffold_lib::procscan::os::RawProc;
use agent_studio_scaffold_lib::procscan::restart::{RestartDone, RestartPrepared, RestartSummary};
use agent_studio_scaffold_lib::procscan::{
    assemble, docker, mark_captured, mask, procs_list_of, unavailable_list, AssembleOpts, Procs,
    ProcsList,
};
use serde::Serialize;

use super::{check_golden, T0};

const HOME: &str = "/Users/dev";

fn raw(pid: u32, ppid: u32, exe: &str, argv: &[&str], cwd: &str, fds: Vec<Fd>) -> RawProc {
    RawProc {
        pid,
        ppid,
        exe: Some(exe.into()),
        argv: argv.iter().map(|s| s.to_string()).collect(),
        cwd: Some(cwd.into()),
        started_ms: Some(T0 as i64 - i64::from(pid) * 1000),
        fds,
    }
}

fn file(fd: i32, path: &str, writable: bool) -> Fd {
    Fd {
        fd,
        kind: FdKind::File {
            path: path.into(),
            writable,
        },
    }
}

fn k(fd: i32, kind: FdKind) -> Fd {
    Fd { fd, kind }
}

/// A console on some terminal app's tty (iTerm, Terminal.app).
fn tty() -> Vec<Fd> {
    tty_at("/dev/ttys001")
}

fn tty_at(dev: &str) -> Vec<Fd> {
    (0..3).map(|n| k(n, FdKind::Tty(dev.into()))).collect()
}

/// The IDE terminal (a zsh, pid 101) and agent terminal (`claude` is the PTY child, pid 110)
/// the supervisor would publish.
const IDE_TTY: &str = "/dev/ttys004";
const AGENT_TTY: &str = "/dev/ttys005";

fn ide_terminals() -> HashMap<u32, IdeTerminal> {
    HashMap::from([
        (
            101,
            IdeTerminal {
                terminal_id: "01J0000000000000000000TERM".into(),
                title: "zsh".into(),
                tty: Some(IDE_TTY.into()),
                agent_id: None,
                agent_title: None,
            },
        ),
        (
            110,
            IdeTerminal {
                terminal_id: "01J000000000000000000AGENT".into(),
                title: "claude".into(),
                tty: Some(AGENT_TTY.into()),
                agent_id: Some("01J000000000000000000AGENT".into()),
                agent_title: Some("claude · gazelle".into()),
            },
        ),
    ])
}

/// A machine with one of each runtime, the IDE's own tree, a collapsed launcher and noise.
fn process_table() -> Vec<RawProc> {
    let mut gazelle_fds = vec![
        k(0, FdKind::Null),
        file(1, "/work/gazelle/gazelle.log", true),
        file(2, "/work/gazelle/gazelle.log", true),
        k(9, FdKind::Listen(3000)),
        k(10, FdKind::Listen(3000)),
        file(11, "/work/gazelle/data/state.db", true),
    ];
    gazelle_fds.push(file(12, "/work/gazelle/logs/audit.log", true));
    vec![
        raw(1, 0, "/sbin/launchd", &["/sbin/launchd"], "/", vec![]),
        // The IDE, and a vite typed in one of its terminals: listed, origin ide, its
        // console that terminal (fd 1 is the terminal's pty slave).
        raw(
            100,
            1,
            "/Applications/Agent Studio.app/Contents/MacOS/agent-studio",
            &["agent-studio"],
            "/",
            vec![],
        ),
        raw(
            101,
            100,
            "/bin/zsh",
            &["-zsh"],
            "/work/web",
            tty_at(IDE_TTY),
        ),
        raw(
            102,
            101,
            "/opt/homebrew/bin/node",
            &["node", "/work/web/node_modules/.bin/vite"],
            "/work/web",
            {
                let mut f = tty_at(IDE_TTY);
                f.push(k(21, FdKind::Listen(5174)));
                f
            },
        ),
        // An agent terminal: `claude` is the PTY child. Its Bash tool ran a server through a
        // shell (kept: origin ide, agentId); its own MCP node worker and ripgrep are dropped.
        raw(
            110,
            100,
            "/Users/dev/.local/share/claude/versions/2.1.212",
            &["claude"],
            "/work/gazelle",
            tty_at(AGENT_TTY),
        ),
        raw(
            111,
            110,
            "/bin/zsh",
            &[
                "/bin/zsh",
                "-c",
                "-l",
                "eval 'node server.js' && pwd -P >| /tmp/claude-cwd",
            ],
            "/work/gazelle",
            vec![k(0, FdKind::Null), k(1, FdKind::Pipe), k(2, FdKind::Pipe)],
        ),
        raw(
            112,
            111,
            "/opt/homebrew/bin/node",
            &["node", "server.js"],
            "/work/gazelle",
            vec![
                k(0, FdKind::Null),
                k(1, FdKind::Pipe),
                k(2, FdKind::Pipe),
                k(30, FdKind::Listen(4000)),
            ],
        ),
        raw(
            113,
            110,
            "/opt/homebrew/bin/node",
            &[
                "node",
                "/Users/dev/.npm/_npx/1/node_modules/.bin/mcp-server-git",
            ],
            "/work/gazelle",
            vec![k(0, FdKind::Pipe), k(1, FdKind::Pipe), k(2, FdKind::Pipe)],
        ),
        raw(
            114,
            110,
            "/Users/dev/.local/share/claude/versions/2.1.212/vendor/ripgrep/rg",
            &["rg", "--files"],
            "/work/gazelle",
            vec![k(1, FdKind::Pipe)],
        ),
        // The IDE's own tooling (not under a terminal): dropped.
        raw(
            120,
            100,
            "/opt/homebrew/bin/node",
            &[
                "node",
                "/Users/dev/.npm/node_modules/typescript-language-server/lib/cli.mjs",
                "--stdio",
            ],
            "/work/web",
            vec![k(0, FdKind::Pipe), k(1, FdKind::Pipe), k(2, FdKind::Pipe)],
        ),
        // cargo run → target/debug/gazelle (the launcher collapses into it).
        raw(200, 1, "/bin/zsh", &["-zsh"], "/work/gazelle", tty()),
        raw(
            201,
            200,
            "/Users/dev/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo",
            &["cargo", "run", "--", "--db-password=hunter2"],
            "/work/gazelle",
            tty(),
        ),
        raw(
            202,
            201,
            "/work/gazelle/target/debug/gazelle",
            &[
                "target/debug/gazelle",
                "--db-password=hunter2",
                "--port",
                "3000",
            ],
            "/work/gazelle",
            gazelle_fds,
        ),
        // A Spring Boot jar in iTerm, and a Gradle daemon.
        raw(
            300,
            1,
            "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java",
            &[
                "java",
                "-Dspring.datasource.password=pw",
                "-jar",
                "build/libs/shop-0.1.jar",
            ],
            "/work/shop",
            {
                let mut f = tty();
                f.push(k(40, FdKind::Listen(8080)));
                f.push(file(41, "/work/shop/logs/spring.log", true));
                f
            },
        ),
        raw(
            310,
            1,
            "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java",
            &[
                "java",
                "-Xmx2g",
                "-cp",
                "/Users/dev/.gradle/lib/gradle-daemon-main-8.10.jar",
                "org.gradle.launcher.daemon.bootstrap.GradleDaemon",
                "8.10",
            ],
            "/Users/dev/.gradle/daemon/8.10",
            vec![k(0, FdKind::Null), k(1, FdKind::Pipe), k(2, FdKind::Pipe)],
        ),
        // npm run dev → sh -c vite → node vite (npm collapses into vite).
        raw(
            400,
            1,
            "/opt/homebrew/bin/node",
            &["npm run dev"],
            "/work/site",
            tty(),
        ),
        raw(
            401,
            400,
            "/bin/sh",
            &["sh", "-c", "vite"],
            "/work/site",
            tty(),
        ),
        raw(
            402,
            401,
            "/opt/homebrew/bin/node",
            &["node", "/work/site/node_modules/.bin/vite"],
            "/work/site",
            {
                let mut f = tty();
                f.push(k(20, FdKind::Listen(5173)));
                f
            },
        ),
        // A python API under a pipe, a go run child.
        raw(
            500,
            1,
            "/work/api/.venv/bin/python3.12",
            &[
                "/work/api/.venv/bin/python3",
                "-m",
                "uvicorn",
                "main:app",
                "--port",
                "8000",
            ],
            "/work/api",
            vec![
                k(0, FdKind::Null),
                k(1, FdKind::Pipe),
                k(2, FdKind::Pipe),
                k(5, FdKind::Listen(8000)),
            ],
        ),
        raw(
            600,
            1,
            "/opt/homebrew/bin/go",
            &["go", "run", "."],
            "/work/gateway",
            tty(),
        ),
        raw(
            601,
            600,
            "/var/folders/x1/T/go-build31415/b001/exe/gateway",
            &["/var/folders/x1/T/go-build31415/b001/exe/gateway"],
            "/work/gateway",
            tty(),
        ),
        // A shell service writing to a file, started by hand with a secret in its env args.
        raw(
            700,
            1,
            "/bin/sh",
            &[
                "/bin/sh",
                "-c",
                "exec >/tmp/worker.out 2>&1; API_TOKEN=abc ./worker",
            ],
            "/work/worker",
            vec![
                k(0, FdKind::Null),
                file(1, "/tmp/worker.out", true),
                file(2, "/tmp/worker.out", true),
            ],
        ),
        // Noise: an interactive shell, RustRover, a system daemon.
        raw(800, 1, "/bin/zsh", &["-zsh"], "/Users/dev", tty()),
        raw(
            801,
            1,
            "/Applications/RustRover.app/Contents/MacOS/rustrover",
            &["rustrover"],
            "/",
            vec![],
        ),
        raw(
            802,
            1,
            "/usr/libexec/trustd",
            &["/usr/libexec/trustd", "--agent"],
            "/",
            vec![],
        ),
    ]
}

const DOCKER_PS: &str = r#"{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-09-28 09:00:00 +0000 UTC","ID":"3f2a9c1b0d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4","Image":"postgres:16","Labels":"com.docker.compose.project=db-fixtures,com.docker.compose.project.working_dir=/work/db-fixtures,com.docker.compose.service=postgres","LocalVolumes":"1","Mounts":"pgdata","Names":"db-fixtures-postgres-1","Networks":"db-fixtures_default","Ports":"0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp","RunningFor":"2 hours ago","Size":"0B","State":"running","Status":"Up 2 hours"}
{"Command":"\"redis-server\"","ID":"9b8a7c6d5e4f","Image":"redis:7","Labels":"","Names":"cache","Ports":"6379/tcp","State":"running","Status":"Up 5 minutes"}
"#;

fn opts() -> AssembleOpts {
    AssembleOpts {
        ide_pid: Some(100),
        home: Some(HOME.into()),
        terminals: Arc::new(ide_terminals()),
        proxy_port: Some(4711),
    }
}

#[test]
fn procs_list_values_match_the_golden() {
    let mut apps = assemble(&process_table(), &opts());
    // `captured` (procscan::capture): vite's env still points at the proxy; the agent's server
    // was started with the proxy vars stripped (as an agent sometimes does). Synthetic
    // envs — `scan` reads the real ones, this golden never does.
    let ours = "http://t-01J0000000000000000000TERM:x@127.0.0.1:4711".to_string();
    mark_captured(&mut apps, opts().proxy_port, |pid| match pid {
        102 => Some(vec![
            ("HTTP_PROXY".into(), ours.clone()),
            ("HTTPS_PROXY".into(), ours.clone()),
        ]),
        112 => Some(vec![("PATH".into(), "/usr/bin".into())]),
        _ => None,
    });
    // Asserted before goldening (the golden only pins shape and spelling).
    let pids: Vec<Option<u32>> = apps.iter().map(|a| a.pid).collect();
    let app = |pid: u32| apps.iter().find(|a| a.pid == Some(pid));
    let vite = app(102).expect("an app in an IDE terminal is listed");
    assert_eq!(vite.origin, Origin::Ide);
    assert_eq!(
        vite.terminal_id.as_deref(),
        Some("01J0000000000000000000TERM")
    );
    assert_eq!(vite.console, Console::IdeTerminal);
    assert_eq!(
        (vite.agent_id.as_deref(), vite.launched_by.as_deref()),
        (None, Some("zsh"))
    );
    let server = app(112).expect("what the agent ran through a shell is kept");
    assert_eq!(server.origin, Origin::Ide);
    assert_eq!(
        server.agent_id.as_deref(),
        Some("01J000000000000000000AGENT")
    );
    assert_eq!(server.launched_by.as_deref(), Some("claude · gazelle"));
    assert_eq!(server.console, Console::Pipe);
    assert_eq!(vite.captured, Some(true));
    assert_eq!(server.captured, Some(false), "proxy vars stripped");
    assert!(
        apps.iter()
            .filter(|a| a.origin == Origin::External)
            .all(|a| a.captured.is_none()),
        "an external app is never judged"
    );
    for dropped in [100, 110, 113, 114, 120] {
        assert!(
            !pids.contains(&Some(dropped)),
            "pid {dropped} must be dropped"
        );
    }
    assert_eq!(app(402).map(|a| a.origin), Some(Origin::External));
    assert!(
        !pids.contains(&Some(201)) && !pids.contains(&Some(400)),
        "launchers collapsed"
    );
    assert!(pids.contains(&Some(202)) && pids.contains(&Some(402)));
    let wire = serde_json::to_string(&apps).unwrap();
    assert!(
        !wire.contains("hunter2") && !wire.contains("=pw") && !wire.contains("TOKEN=abc"),
        "{wire}"
    );

    let containers = docker::parse_ps(DOCKER_PS);
    let mut scenarios: BTreeMap<&str, ProcsList> = BTreeMap::new();
    scenarios.insert(
        "machine",
        procs_list_of(apps.clone(), Some(&Ok(containers))),
    );
    scenarios.insert(
        "dockerDown",
        procs_list_of(
            apps.clone(),
            Some(&Err(docker::ps_failure_reason(
                "Cannot connect to the Docker daemon at unix:///Users/dev/.docker/run/docker.sock. Is the docker daemon running?",
            ))),
        ),
    );
    scenarios.insert("noDocker", procs_list_of(Vec::new(), None));
    scenarios.insert("unavailable", unavailable_list());
    check_golden("procs-list.json", &scenarios);
}

/// A tmp dir whose last component is fixed, so a picked file's name rule gives `gazelle`.
fn work_dir() -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("agentstudio-golden-procs-{}", ulid::Ulid::new()));
    let dir = base.join("gazelle");
    std::fs::create_dir_all(&dir).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();
    (base.clone(), base.join("gazelle"))
}

async fn wait_ring(hub: &LogHub, what: &str, pred: impl Fn(&[LogLine]) -> bool) -> Vec<LogLine> {
    let start = Instant::now();
    loop {
        let snap = hub.snapshot();
        if pred(&snap) {
            return snap;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "timed out waiting for {what}: {snap:#?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Commands {
    tail_app: agent_studio_scaffold_lib::logstream::apps::AppTailInfo,
    tail_docker: agent_studio_scaffold_lib::logstream::apps::AppTailInfo,
    restart_prepare: RestartPrepared,
    restart_in_ide: RestartDone,
    untail: bool,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn app_lines_and_command_values_match_the_goldens() {
    let (base, dir) = work_dir();
    let log = dir.join("gazelle.log");
    let mut f = std::fs::File::create(&log).unwrap();
    writeln!(
        f,
        "2026-09-28T10:00:00.000Z  INFO gazelle::server: listening on 0.0.0.0:3000"
    )
    .unwrap();
    writeln!(
        f,
        "2026-09-28T10:00:01.000Z  WARN gazelle::db: slow query (812 ms)"
    )
    .unwrap();
    writeln!(
        f,
        "2026-09-28T10:00:02.000Z ERROR gazelle::upstream: geo refused: 429"
    )
    .unwrap();
    f.flush().unwrap();

    let (hub, task) = LogHub::new(Arc::new(NullLogSink));
    tokio::spawn(task);
    // A fake `docker` (never the real CLI in a test).
    let fake = base.join("docker");
    std::fs::write(&fake, "#!/bin/sh\nexec sleep 30\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let procs = Procs::new(hub.clone(), AssembleOpts::default(), Some(fake));
    procs.allow_picked(&log).unwrap();
    let tail_app = procs.tail_file(None, log.to_str().unwrap()).unwrap();
    wait_ring(&hub, "the backfill", |s| {
        s.iter().filter(|l| l.kind == LogKind::App).count() == 3
    })
    .await;
    writeln!(
        f,
        "2026-09-28T10:00:03.000Z DEBUG gazelle::health: GET /health 200"
    )
    .unwrap();
    f.flush().unwrap();
    wait_ring(&hub, "the live line", |s| {
        s.iter().filter(|l| l.kind == LogKind::App).count() == 4
    })
    .await;
    let untail = procs.tails.stop(&tail_app.key);
    let mut lines = wait_ring(&hub, "the stop line", |s| {
        s.iter().any(|l| l.text.starts_with("app log stopped"))
    })
    .await;

    procs.set_containers_for_test(docker::parse_ps(DOCKER_PS));
    let tail_docker = procs
        .tail_docker("3f2a9c1b0d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4")
        .unwrap();
    procs.tails.stop(&tail_docker.key);

    let prefix = base.display().to_string();
    let norm = |s: &str| s.replace(&prefix, "/work");
    for (i, l) in lines.iter_mut().enumerate() {
        l.id = i as u64 + 1;
        l.ts_ms = T0 as i64 + i as i64 * 250;
        l.detail = l.detail.as_deref().map(norm);
    }
    check_golden("app-lines.json", &lines);

    let argv: Vec<String> = [
        "target/debug/gazelle",
        "--db-password=hunter2",
        "--port",
        "3000",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let commands = Commands {
        tail_app: agent_studio_scaffold_lib::logstream::apps::AppTailInfo {
            key: norm(&tail_app.key),
            source: tail_app.source,
        },
        tail_docker,
        // The shapes of the restart pair (the live path is `tests/procscan.rs`); the argv is
        // masked by the real masker, the token is the store's format.
        restart_prepare: RestartPrepared {
            token: "rs-01J0000000000000000000000".into(),
            summary: RestartSummary {
                name: "gazelle".into(),
                cwd: "/work/gazelle".into(),
                argv: mask::mask_argv(&argv),
            },
        },
        restart_in_ide: RestartDone {
            terminal_id: "01J00000000000000000000000".into(),
        },
        untail,
    };
    check_golden("procs-commands.json", &commands);
}
