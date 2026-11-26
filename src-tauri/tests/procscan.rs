//! Dev apps on this machine: the classifier against real-world command lines, and the live path
//! (discovery, tail guard, `app` lines, Restart) against real children. Hermetic: children are
//! `/bin/sh` scripts in a temp dir, never the user's shell. macOS and Linux (`linux-check.mjs`).

#![cfg(any(target_os = "macos", target_os = "linux"))]

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_studio_scaffold_lib::events::NullSink;
use agent_studio_scaffold_lib::logstream::apps::{APP_STARTED_PREFIX, APP_STOPPED_PREFIX};
use agent_studio_scaffold_lib::logstream::{LogHub, LogKind, LogLevel, LogLine, NullLogSink};
use agent_studio_scaffold_lib::model::TerminalStatus;
use agent_studio_scaffold_lib::netcap::{self, FlowSink, FlowSummary, Netcap, NetcapConfig};
use agent_studio_scaffold_lib::procscan::classify::{app_name, classify, Facts, Runtime};
use agent_studio_scaffold_lib::procscan::ide::{self, IdeTerminal, Origin, Placement};
use agent_studio_scaffold_lib::procscan::logfiles::{Console, Fd, FdKind, LogVia};
use agent_studio_scaffold_lib::procscan::os::RawProc;
use agent_studio_scaffold_lib::procscan::{self, os, AssembleOpts, Procs};
use agent_studio_scaffold_lib::supervisor::spawn_supervisor;
use common::TIMEOUT;

// ── the classifier table ─────────────────────────────────────────────────────

struct Case {
    what: &'static str,
    exe: &'static str,
    argv: &'static [&'static str],
    parent_exe: Option<&'static str>,
    parent_argv: &'static [&'static str],
    console: Console,
    cwd: &'static str,
    /// `None` = not a dev app. Else `(runtime, entry, launcher, name)`.
    want: Option<(Runtime, &'static str, bool, &'static str)>,
}

const HOME: &str = "/Users/sam";

fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[rustfmt::skip]
fn cases() -> Vec<Case> {
    vec![
        Case {
            what: "java -jar",
            exe: "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java",
            argv: &["java", "-Xmx512m", "-jar", "/w/shop/build/libs/shop-0.1.jar", "--server.port=8080"],
            parent_exe: Some("/bin/zsh"), parent_argv: &["-zsh"],
            console: Console::Terminal, cwd: "/w/shop",
            want: Some((Runtime::Jvm, "shop-0.1.jar", false, "shop-0.1.jar · shop")),
        },
        Case {
            what: "java -jar from $HOME: the jar names it",
            exe: "/usr/lib/jvm/java-21-openjdk-amd64/bin/java",
            argv: &["java", "-jar", "/opt/svc/billing-2.3.jar"],
            parent_exe: None, parent_argv: &[],
            console: Console::Pipe, cwd: HOME,
            want: Some((Runtime::Jvm, "billing-2.3.jar", false, "billing-2.3.jar")),
        },
        Case {
            what: "a Gradle daemon on the IDE's bundled JDK",
            exe: "/Applications/IntelliJ IDEA CE.app/Contents/jbr/Contents/Home/bin/java",
            argv: &["java", "--add-opens", "java.base/java.util=ALL-UNNAMED", "-Xmx2g", "-cp",
                    "/Users/sam/.gradle/wrapper/dists/gradle-8.10-bin/x/gradle-8.10/lib/gradle-daemon-main-8.10.jar",
                    "org.gradle.launcher.daemon.bootstrap.GradleDaemon", "8.10"],
            parent_exe: None, parent_argv: &[],
            console: Console::None, cwd: "/Users/sam/.gradle/daemon/8.10",
            want: Some((Runtime::Jvm, "org.gradle.launcher.daemon.bootstrap.GradleDaemon", false, "gradle daemon")),
        },
        Case {
            what: "an app IDEA launched (idea_rt javaagent) is the app, not the IDE",
            exe: "/Applications/IntelliJ IDEA CE.app/Contents/jbr/Contents/Home/bin/java",
            argv: &["java", "-javaagent:/Applications/IntelliJ IDEA CE.app/Contents/lib/idea_rt.jar=5000",
                    "-classpath", "/w/shop/out", "com.acme.shop.App"],
            parent_exe: None, parent_argv: &[],
            console: Console::Pipe, cwd: "/w/shop",
            want: Some((Runtime::Jvm, "com.acme.shop.App", false, "App · shop")),
        },
        Case {
            what: "node node_modules/.bin/vite",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "node_modules/.bin/vite"],
            parent_exe: Some("/bin/sh"), parent_argv: &["sh", "-c", "vite"],
            console: Console::Terminal, cwd: "/w/web",
            want: Some((Runtime::Node, "vite", false, "vite · web")),
        },
        Case {
            what: "pnpm's nested vite",
            exe: "/Users/sam/.nvm/versions/node/v22.20.0/bin/node",
            argv: &["node", "/w/web/node_modules/.pnpm/vite@5.4.1/node_modules/vite/bin/vite.js", "--port", "5173"],
            parent_exe: None, parent_argv: &[],
            console: Console::Pipe, cwd: "/w/web",
            want: Some((Runtime::Node, "vite", false, "vite · web")),
        },
        Case {
            what: "bun run dev",
            exe: "/Users/sam/.bun/bin/bun",
            argv: &["bun", "run", "dev"],
            parent_exe: Some("/bin/zsh"), parent_argv: &["-zsh"],
            console: Console::Terminal, cwd: "/w/site",
            want: Some((Runtime::Node, "bun run dev", true, "bun run dev · site")),
        },
        Case {
            what: "npm run dev (script path form)",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js", "run", "dev"],
            parent_exe: None, parent_argv: &[],
            console: Console::Terminal, cwd: "/w/web",
            want: Some((Runtime::Node, "npm run dev", true, "npm run dev · web")),
        },
        Case {
            what: "npm run dev (process.title rewrote argv)",
            exe: "/opt/homebrew/bin/node",
            argv: &["npm run dev"],
            parent_exe: None, parent_argv: &[],
            console: Console::Terminal, cwd: "/w/web",
            want: Some((Runtime::Node, "npm run dev", true, "npm run dev · web")),
        },
        Case {
            what: "npm install is a one-shot, not an app",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "/opt/homebrew/bin/npm", "install"],
            parent_exe: None, parent_argv: &[],
            console: Console::Terminal, cwd: "/w/web",
            want: None,
        },
        Case {
            what: "target/debug/gazelle under cargo run",
            exe: "/w/gazelle/target/debug/gazelle",
            argv: &["target/debug/gazelle", "--port", "3000"],
            parent_exe: Some("/Users/sam/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo"),
            parent_argv: &["/Users/sam/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo", "run"],
            console: Console::Terminal, cwd: "/w/gazelle",
            want: Some((Runtime::Rust, "gazelle", false, "gazelle")),
        },
        Case {
            what: "a cargo run child with CARGO_TARGET_DIR elsewhere: the parent decides",
            exe: "/tmp/ct/debug/gazelle",
            argv: &["/tmp/ct/debug/gazelle"],
            parent_exe: Some("/Users/sam/.cargo/bin/cargo"),
            parent_argv: &["cargo", "+nightly", "run", "--release"],
            console: Console::Terminal, cwd: "/w/gazelle",
            want: Some((Runtime::Rust, "gazelle", false, "gazelle")),
        },
        Case {
            what: "cargo run itself is a launcher",
            exe: "/Users/sam/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo",
            argv: &["cargo", "run", "--bin", "gazelle"],
            parent_exe: None, parent_argv: &[],
            console: Console::Terminal, cwd: "/w/gazelle",
            want: Some((Runtime::Rust, "cargo run gazelle", true, "cargo run gazelle · gazelle")),
        },
        Case {
            what: "cargo build is not an app",
            exe: "/Users/sam/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo",
            argv: &["cargo", "build"],
            parent_exe: None, parent_argv: &[],
            console: Console::Terminal, cwd: "/w/gazelle",
            want: None,
        },
        Case {
            what: "a test binary under target/debug/deps is not an app",
            exe: "/w/gazelle/target/debug/deps/gazelle-3f2e1d0a",
            argv: &["/w/gazelle/target/debug/deps/gazelle-3f2e1d0a"],
            parent_exe: Some("/Users/sam/.cargo/bin/cargo"), parent_argv: &["cargo", "test"],
            console: Console::Pipe, cwd: "/w/gazelle",
            want: None,
        },
        Case {
            what: "python uvicorn from a venv",
            exe: "/w/api/.venv/bin/python3.12",
            argv: &["/w/api/.venv/bin/python3", "/w/api/.venv/bin/uvicorn", "main:app", "--reload"],
            parent_exe: Some("/bin/zsh"), parent_argv: &["-zsh"],
            console: Console::Terminal, cwd: "/w/api",
            want: Some((Runtime::Python, "uvicorn", false, "uvicorn · api")),
        },
        Case {
            what: "python -m uvicorn",
            exe: "/opt/homebrew/Cellar/python@3.12/3.12.4/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python",
            argv: &["python3", "-u", "-m", "uvicorn", "main:app"],
            parent_exe: None, parent_argv: &[],
            console: Console::Pipe, cwd: "/w/api",
            want: Some((Runtime::Python, "uvicorn", false, "uvicorn · api")),
        },
        Case {
            what: "python -m pip is tooling",
            exe: "/usr/bin/python3",
            argv: &["python3", "-m", "pip", "install", "x"],
            parent_exe: None, parent_argv: &[],
            console: Console::Terminal, cwd: "/w/api",
            want: None,
        },
        Case {
            what: "a go run binary in the go-build cache",
            exe: "/var/folders/x1/abc/T/go-build3141592/b001/exe/main",
            argv: &["/var/folders/x1/abc/T/go-build3141592/b001/exe/main"],
            parent_exe: Some("/opt/homebrew/Cellar/go/1.23.0/libexec/bin/go"),
            parent_argv: &["go", "run", "."],
            console: Console::Terminal, cwd: "/w/gateway",
            want: Some((Runtime::Go, "main", false, "main · gateway")),
        },
        Case {
            what: "an interactive shell",
            exe: "/bin/zsh",
            argv: &["-zsh"],
            parent_exe: Some("/usr/bin/login"), parent_argv: &["login", "-fp", "sam"],
            console: Console::Terminal, cwd: "/w/gazelle",
            want: None,
        },
        Case {
            what: "a shell script typing into a terminal",
            exe: "/bin/bash",
            argv: &["bash", "-c", "while :; do date; sleep 1; done"],
            parent_exe: None, parent_argv: &[],
            console: Console::Terminal, cwd: "/w/gazelle",
            want: None,
        },
        Case {
            what: "a shell service logging to a file",
            exe: "/bin/sh",
            argv: &["/bin/sh", "-c", "exec >svc.log 2>&1; while :; do echo tick; sleep 1; done"],
            parent_exe: None, parent_argv: &[],
            console: Console::File, cwd: "/w/svc",
            want: Some((Runtime::Shell, "exec >svc.log 2>&1; while :; do echo tick; sleep 1; done", false, "sh · svc")),
        },
        Case {
            what: "RustRover itself",
            exe: "/Applications/RustRover.app/Contents/MacOS/rustrover",
            argv: &["/Applications/RustRover.app/Contents/MacOS/rustrover"],
            parent_exe: Some("/sbin/launchd"), parent_argv: &["/sbin/launchd"],
            console: Console::None, cwd: "/",
            want: None,
        },
        Case {
            what: "RustRover's own JVM on Linux",
            exe: "/home/sam/.local/share/JetBrains/Toolbox/apps/rustrover/jbr/bin/java",
            argv: &["java", "-Xmx4g", "-cp", "/home/sam/.local/share/JetBrains/Toolbox/apps/rustrover/lib/app.jar",
                    "com.intellij.idea.Main"],
            parent_exe: None, parent_argv: &[],
            console: Console::None, cwd: "/home/sam",
            want: None,
        },
        Case {
            what: "a language server RustRover runs on the system node",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "/Applications/RustRover.app/Contents/plugins/javascript-plugin/jsLanguageServicesImpl/js-language-service.js"],
            parent_exe: Some("/Applications/RustRover.app/Contents/MacOS/rustrover"), parent_argv: &["rustrover"],
            console: Console::Pipe, cwd: "/w/web",
            want: None,
        },
        Case {
            what: "a VS Code helper",
            exe: "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
            argv: &["Code Helper (Plugin)", "--type=utility"],
            parent_exe: None, parent_argv: &[],
            console: Console::None, cwd: "/",
            want: None,
        },
        Case {
            what: "a vite started from a VS Code terminal is still an app",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "/w/web/node_modules/.bin/vite"],
            parent_exe: Some("/bin/zsh"), parent_argv: &["/bin/zsh", "-il"],
            console: Console::Terminal, cwd: "/w/web",
            want: Some((Runtime::Node, "vite", false, "vite · web")),
        },
        // A typical list: many rows all called `Agent Studio`. Each says
        // what it runs now.
        Case {
            what: "vitest in the IDE's own repo",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "/w/AgentStudioIDE/node_modules/.bin/vitest", "run"],
            parent_exe: Some("/bin/zsh"), parent_argv: &["/bin/zsh", "-c", "npm test"],
            console: Console::Pipe, cwd: "/w/AgentStudioIDE",
            want: Some((Runtime::Node, "vitest", false, "vitest · AgentStudioIDE")),
        },
        Case {
            what: "tsc through .bin",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "/w/AgentStudioIDE/node_modules/.bin/tsc", "--noEmit"],
            parent_exe: None, parent_argv: &[],
            console: Console::Pipe, cwd: "/w/AgentStudioIDE",
            want: Some((Runtime::Node, "tsc", false, "tsc · AgentStudioIDE")),
        },
        Case {
            what: "eslint by its package path",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "/w/AgentStudioIDE/node_modules/eslint/bin/eslint.js", "."],
            parent_exe: None, parent_argv: &[],
            console: Console::Pipe, cwd: "/w/AgentStudioIDE",
            want: Some((Runtime::Node, "eslint", false, "eslint · AgentStudioIDE")),
        },
        Case {
            what: "a plain node script",
            exe: "/opt/homebrew/bin/node",
            argv: &["node", "server.js"],
            parent_exe: Some("/bin/zsh"), parent_argv: &["-zsh"],
            console: Console::Pipe, cwd: "/w/gazelle",
            want: Some((Runtime::Node, "server.js", false, "server.js · gazelle")),
        },
        Case {
            what: "a bash with its output in a file, in the IDE's repo",
            exe: "/bin/bash",
            argv: &["/bin/bash", "-c", "npm run build > /tmp/build.out 2>&1"],
            parent_exe: None, parent_argv: &[],
            console: Console::File, cwd: "/w/AgentStudioIDE",
            want: Some((Runtime::Shell, "npm run build > /tmp/build.out 2>&1", false, "bash · AgentStudioIDE")),
        },
        Case {
            what: "a shell running a script file names the script",
            exe: "/bin/bash",
            argv: &["bash", "scripts/deploy.sh"],
            parent_exe: None, parent_argv: &[],
            console: Console::File, cwd: "/w/gazelle",
            want: Some((Runtime::Shell, "deploy.sh", false, "deploy.sh · gazelle")),
        },
        Case {
            what: "a system daemon",
            exe: "/usr/libexec/trustd",
            argv: &["/usr/libexec/trustd", "--agent"],
            parent_exe: Some("/sbin/launchd"), parent_argv: &["/sbin/launchd"],
            console: Console::None, cwd: "/",
            want: None,
        },
        Case {
            what: "a system python under /System",
            exe: "/System/Library/Frameworks/Python.framework/Versions/2.7/Resources/Python.app/Contents/MacOS/Python",
            argv: &["python", "/System/Library/x.py"],
            parent_exe: None, parent_argv: &[],
            console: Console::None, cwd: "/",
            want: None,
        },
    ]
}

#[test]
fn the_classifier_table() {
    let mut failures = Vec::new();
    for c in cases() {
        let argv = v(c.argv);
        let pargv = v(c.parent_argv);
        let got = classify(&Facts {
            exe: c.exe,
            argv: &argv,
            parent_exe: c.parent_exe,
            parent_argv: &pargv,
            console: c.console,
        })
        .map(|k| {
            let name = app_name(&k, Some(c.cwd), Some(HOME));
            (k.runtime, k.entry.unwrap_or_default(), k.launcher, name)
        });
        let want = c
            .want
            .map(|(r, e, l, n)| (r, e.to_string(), l, n.to_string()));
        if got != want {
            failures.push(format!("{}:\n   got  {got:?}\n   want {want:?}", c.what));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

// ── live: a real child ──────────────────────────────────────────────────────

/// A private, canonical temp dir.
fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("agentstudio-procscan-{tag}-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&d).unwrap();
    std::fs::canonicalize(&d).unwrap()
}

/// Kills and reaps its child on drop, so a failing test leaves no process behind.
struct Reaped(Option<Child>);

impl Reaped {
    fn pid(&self) -> u32 {
        self.0.as_ref().unwrap().id()
    }
    fn kill(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Reaped {
    fn drop(&mut self) {
        self.kill();
    }
}

const SVC_SCRIPT: &str =
    r#"exec >svc.log 2>&1; while :; do echo "INFO svc: tick"; sleep 0.2; done"#;

fn spawn_svc(dir: &Path) -> Reaped {
    let child = Command::new("/bin/sh")
        .arg("-c")
        .arg(SVC_SCRIPT)
        .current_dir(dir)
        .stdin(Stdio::null())
        .spawn()
        .expect("spawn /bin/sh");
    Reaped(Some(child))
}

fn wait_blocking(what: &str, mut cond: impl FnMut() -> bool) {
    let start = Instant::now();
    while !cond() {
        assert!(start.elapsed() < TIMEOUT, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn no_exclusion() -> AssembleOpts {
    AssembleOpts::default()
}

#[test]
fn discovery_sees_a_real_shell_service_with_a_file_console_and_its_log() {
    let dir = temp_dir("disc");
    let mut child = spawn_svc(&dir);
    let log = dir.join("svc.log");
    wait_blocking("svc.log to fill", || {
        std::fs::metadata(&log).is_ok_and(|m| m.len() > 0)
    });

    let apps = procscan::scan(&no_exclusion());
    let app = apps
        .iter()
        .find(|a| a.pid == Some(child.pid()))
        .unwrap_or_else(|| {
            panic!(
                "pid {} not discovered; got {:#?}",
                child.pid(),
                apps.iter()
                    .map(|a| (a.pid, &a.name, &a.argv))
                    .collect::<Vec<_>>()
            )
        });
    assert_eq!(app.runtime, Runtime::Shell);
    assert_eq!(app.console, Console::File, "fd 1/2 → svc.log");
    assert_eq!(app.key, format!("pid:{}", child.pid()));
    let dir_name = dir.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(
        app.name,
        format!("sh · {dir_name}"),
        "the tool, then the project dir (its cwd)"
    );
    assert_eq!(
        app.cwd
            .as_deref()
            .map(|c| std::fs::canonicalize(c).unwrap()),
        Some(dir.clone())
    );
    let svc: Vec<_> = app
        .log_files
        .iter()
        .filter(|f| f.path.ends_with("/svc.log"))
        .collect();
    assert_eq!(svc.len(), 1, "logFiles: {:?}", app.log_files);
    assert_eq!(
        svc[0].kind,
        LogVia::Stdout,
        "the console file is offered as stdout"
    );
    assert_eq!(
        std::fs::canonicalize(&svc[0].path).unwrap(),
        std::fs::canonicalize(&log).unwrap()
    );
    assert!(app.started_ms.is_some_and(|t| t > 1_600_000_000_000));
    assert!(
        app.argv.iter().any(|a| a.contains("svc.log")),
        "argv: {:?}",
        app.argv
    );

    assert_eq!(
        app.origin,
        Origin::External,
        "no IDE terminal table: external"
    );
    // With this test process as "the IDE" and no terminal of it above the child, the child
    // is the IDE's own tooling and is not listed.
    let as_ide = procscan::scan(&AssembleOpts {
        ide_pid: Some(std::process::id()),
        ..AssembleOpts::default()
    });
    assert!(
        !as_ide.iter().any(|a| a.pid == Some(child.pid())),
        "a child of the IDE that is not under one of its terminals must not be listed"
    );
    child.kill();
}

async fn wait_line(hub: &LogHub, what: &str, pred: impl Fn(&LogLine) -> bool) -> LogLine {
    let start = Instant::now();
    loop {
        if let Some(l) = hub.snapshot().into_iter().find(|l| pred(l)) {
            return l;
        }
        if start.elapsed() >= TIMEOUT {
            panic!(
                "timed out waiting for {what}; ring = {:#?}",
                hub.snapshot()
                    .iter()
                    .map(|l| (&l.kind, &l.source, &l.text))
                    .collect::<Vec<_>>()
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn hub() -> LogHub {
    let (hub, task) = LogHub::new(Arc::new(NullLogSink));
    tokio::spawn(task);
    hub
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tailing_a_real_services_log_yields_app_lines_until_it_exits() {
    let dir = temp_dir("tail");
    let mut child = spawn_svc(&dir);
    let log = dir.join("svc.log");
    wait_blocking("svc.log to fill", || {
        std::fs::metadata(&log).is_ok_and(|m| m.len() > 0)
    });
    let hub = hub();
    let procs = Procs::new(hub.clone(), no_exclusion(), None);
    let pid = child.pid();

    let info = procs
        .tail_file(Some(pid), log.to_str().unwrap())
        .expect("the pid has svc.log open");
    let dir_name = dir.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(info.source, format!("sh · {dir_name} · svc.log"));
    let canon = std::fs::canonicalize(&log).unwrap();
    assert_eq!(info.key, format!("file:{pid}:{}", canon.display()));
    // Idempotent: the same key, still one tail.
    assert_eq!(
        procs.tail_file(Some(pid), log.to_str().unwrap()),
        Ok(info.clone())
    );
    assert_eq!(procs.tails.keys(), vec![info.key.clone()]);

    let started = wait_line(&hub, "the start line", |l| {
        l.kind == LogKind::System && l.text.starts_with(APP_STARTED_PREFIX)
    })
    .await;
    assert_eq!(started.source, info.source);
    let line = wait_line(&hub, "an app line", |l| l.kind == LogKind::App).await;
    assert_eq!(line.text, "INFO svc: tick");
    assert_eq!(line.source, info.source);
    assert_eq!(line.level, LogLevel::Info);
    assert_eq!(line.terminal_id, None);
    assert_eq!(line.agent_id, None);
    assert_eq!(
        line.detail.as_deref(),
        Some(format!("{} · pid {pid}", canon.display()).as_str())
    );
    // New lines keep coming (live, not only the backfill).
    let n = hub
        .snapshot()
        .iter()
        .filter(|l| l.kind == LogKind::App)
        .count();
    let later = Instant::now();
    loop {
        let m = hub
            .snapshot()
            .iter()
            .filter(|l| l.kind == LogKind::App)
            .count();
        if m > n {
            break;
        }
        assert!(
            later.elapsed() < TIMEOUT,
            "no live lines after the backfill"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    child.kill();
    let stopped = wait_line(&hub, "the stop line", |l| {
        l.kind == LogKind::System && l.text.starts_with(APP_STOPPED_PREFIX)
    })
    .await;
    assert_eq!(
        stopped.text,
        format!("{APP_STOPPED_PREFIX}{} — process exited", info.source)
    );
    wait_blocking("the tail to be released", || procs.tails.keys().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_tail_guard_refuses_a_file_the_pid_does_not_have_open() {
    let dir = temp_dir("guard");
    let child = spawn_svc(&dir);
    let log = dir.join("svc.log");
    wait_blocking("svc.log to fill", || {
        std::fs::metadata(&log).is_ok_and(|m| m.len() > 0)
    });
    let other = dir.join("secret.txt");
    std::fs::write(&other, "not a log the service writes\n").unwrap();
    let procs = Procs::new(hub(), no_exclusion(), None);

    let err = procs
        .tail_file(Some(child.pid()), other.to_str().unwrap())
        .unwrap_err();
    assert!(err.contains("does not have"), "{err}");
    let err = procs.tail_file(None, other.to_str().unwrap()).unwrap_err();
    assert!(err.contains("not chosen in the file dialog"), "{err}");
    let err = procs.tail_file(Some(child.pid()), "svc.log").unwrap_err();
    assert!(err.contains("not absolute"), "{err}");
    let dotted = format!(
        "{}/../{}/svc.log",
        dir.display(),
        dir.file_name().unwrap().to_string_lossy()
    );
    let err = procs.tail_file(Some(child.pid()), &dotted).unwrap_err();
    assert!(err.contains(".."), "{err}");
    // A symlink to the open file resolves to it: allowed (both sides canonical).
    let link = dir.join("link.log");
    std::os::unix::fs::symlink(&log, &link).unwrap();
    assert!(procs
        .tail_file(Some(child.pid()), link.to_str().unwrap())
        .is_ok());
    assert!(procs.tails.stop(&procs.tails.keys()[0]));
    // A file the user picked in the dialog is allowed with no pid at all.
    procs.allow_picked(&other).unwrap();
    let info = procs.tail_file(None, other.to_str().unwrap()).unwrap();
    assert_eq!(
        info.key,
        format!("file:{}", std::fs::canonicalize(&other).unwrap().display())
    );
    assert!(procs.tails.stop(&info.key));
    assert!(!procs.tails.stop(&info.key), "already stopped");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_docker_tail_is_refused_for_a_container_that_was_not_listed() {
    let procs = Procs::new(
        hub(),
        no_exclusion(),
        Some(PathBuf::from("/nonexistent/docker")),
    );
    let err = procs.tail_docker("abc123").unwrap_err();
    assert!(err.contains("not in the current list"), "{err}");
    let err = procs.tail_docker("-f").unwrap_err();
    assert!(err.contains("not a container id"), "{err}");
    let no_docker = Procs::new(hub(), no_exclusion(), None);
    assert_eq!(
        no_docker.tail_docker("abc123").unwrap_err(),
        "Docker is not installed"
    );
}

/// A fake `docker` (a `/bin/sh` script) proves the docker tail's plumbing: `logs -f --tail
/// 500 <id>` is what runs, both streams become `app` lines, and the child exiting (the
/// container stopped) closes the stream. The real CLI is never run by a test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_docker_tail_follows_the_cli_until_it_exits() {
    let dir = temp_dir("docker");
    let fake = dir.join("docker");
    std::fs::write(
        &fake,
        "#!/bin/sh\necho \"args: $*\"\necho 'ERROR db: boom' >&2\nsleep 0.3\necho 'WARN db: bye'\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let hub = hub();
    let procs = Procs::new(hub.clone(), no_exclusion(), Some(fake));
    let listed = procscan::docker::parse_ps(
        r#"{"ID":"3f2a9c1b0d4e5f60","Names":"db-1","Image":"postgres:16","Ports":"0.0.0.0:5432->5432/tcp","State":"running","Status":"Up 2 hours","Labels":""}"#,
    );
    procs.set_containers_for_test(listed);
    let info = procs.tail_docker("3f2a9c1b0d4e5f60").unwrap();
    assert_eq!(info.source, "db-1 · docker");
    assert_eq!(info.key, "docker:3f2a9c1b0d4e5f60");
    let args = wait_line(&hub, "the args line", |l| l.text.starts_with("args: ")).await;
    assert_eq!(args.text, "args: logs -f --tail 500 3f2a9c1b0d4e5f60");
    assert_eq!(args.kind, LogKind::App);
    let err = wait_line(&hub, "the stderr line", |l| l.text == "ERROR db: boom").await;
    assert_eq!(err.level, LogLevel::Error);
    let stop = wait_line(&hub, "the stop line", |l| {
        l.text.starts_with(APP_STOPPED_PREFIX)
    })
    .await;
    assert_eq!(
        stop.text,
        "app log stopped · db-1 · docker — container stopped"
    );
    assert!(
        hub.snapshot().iter().any(|l| l.text == "WARN db: bye"),
        "the last line before exit is kept"
    );
}

// ── live: Restart in the IDE ─────────────────────────────────────────────────

/// Env var that turns [`helper_restart_service`] into the service the restart test runs.
const HELPER: &str = "PROCS_HELPER";

/// Not a test: the restart test's child (`PROCS_HELPER=restart`); appends a mark to `marks.txt`
/// and waits. A test binary, not `/bin/sh`, because macOS hides the env of Apple's platform
/// binaries from `KERN_PROCARGS2`, and the point is to prove the env is carried over.
#[test]
fn helper_restart_service() {
    if std::env::var(HELPER).as_deref() != Ok("restart") {
        return;
    }
    let mark = std::env::var("PROCS_RESTART_MARK").unwrap_or_default();
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("marks.txt")
        .unwrap();
    writeln!(f, "run {mark}").unwrap();
    drop(f);
    loop {
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_in_the_ide_stops_the_process_and_reruns_it_in_a_terminal_with_its_env() {
    let dir = temp_dir("restart");
    let secret = format!("s3cret-{}", ulid::Ulid::new());
    let me = std::env::current_exe().unwrap();
    let child = Command::new(&me)
        .args([
            "--exact",
            "helper_restart_service",
            "--nocapture",
            "--test-threads=1",
        ])
        .current_dir(&dir)
        .env(HELPER, "restart")
        .env("PROCS_RESTART_MARK", &secret)
        // Console `none` whatever cargo's own stdout is, so the name rule is fixed.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    let mut child = Reaped(Some(child));
    let marks = dir.join("marks.txt");
    let lines = || {
        std::fs::read_to_string(&marks)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    wait_blocking("the first run", || lines().len() == 1);

    let procs = Procs::new(hub(), no_exclusion(), None);
    let prepared = tokio::task::block_in_place(|| procs.prepare_restart(pid)).unwrap();
    // FIRST, and never printing the value: on failure it would hold this machine's real env.
    let wire = serde_json::to_string(&prepared).unwrap();
    assert!(
        !wire.contains(&secret) && !wire.contains("PROCS_RESTART_MARK") && !wire.contains("HOME="),
        "the env must not reach the webview (value withheld: it would be the real env)"
    );
    let want_argv = vec![
        me.display().to_string(),
        "--exact".to_string(),
        "helper_restart_service".to_string(),
        "--nocapture".to_string(),
        "--test-threads=1".to_string(),
    ];
    assert!(
        prepared.summary.argv == want_argv,
        "argv is the (masked) command line — value withheld"
    );
    assert_eq!(
        std::fs::canonicalize(&prepared.summary.cwd).unwrap(),
        dir.clone()
    );
    // A test binary (target/…/deps/) is not a dev app, so not in `procs_list`: the name is
    // the executable's.
    assert_eq!(
        prepared.summary.name,
        me.file_name().unwrap().to_string_lossy()
    );

    // Reap the old child as soon as it dies (a zombie would still look alive to kill(2)).
    let mut old = child.0.take().unwrap();
    let reaper = std::thread::spawn(move || old.wait());

    let sup = spawn_supervisor(Arc::new(NullSink), vec![], None);
    let done = procs
        .restart_in_ide(&sup, &prepared.token, None, None, None)
        .await
        .expect("restart");
    let status = reaper.join().unwrap().expect("the old process was reaped");
    assert!(
        !status.success(),
        "it was stopped by a signal, not by exiting: {status}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            status.signal(),
            Some(libc::SIGTERM),
            "SIGTERM, never SIGKILL"
        );
    }
    assert_eq!(os::proc_start(pid), None, "the old pid is gone");

    let snap = sup.snapshot().await.unwrap();
    let term = snap
        .terminals
        .iter()
        .find(|t| t.id == done.terminal_id)
        .expect("a terminal was opened");
    assert_eq!(term.status, TerminalStatus::Live);
    assert_eq!(std::fs::canonicalize(&term.cwd).unwrap(), dir);
    wait_blocking("the second run, in the IDE's terminal", || {
        lines().len() == 2
    });
    assert_eq!(
        lines(),
        vec![format!("run {secret}"), format!("run {secret}")],
        "the restarted app got its env"
    );
    let snap_wire = serde_json::to_string(&snap).unwrap();
    assert!(
        !snap_wire.contains(&secret),
        "the env leaked into fleet_snapshot"
    );

    // Single use.
    let again = procs
        .restart_in_ide(&sup, &prepared.token, None, None, None)
        .await
        .unwrap_err();
    assert!(again.contains("already used"), "{again}");
    sup.close(done.terminal_id).await.unwrap();
    child.kill();
}

/// macOS hides a platform binary's environment; Restart must refuse rather than restart the
/// service without its settings.
#[cfg(target_os = "macos")]
#[test]
fn restart_is_refused_when_the_os_hides_the_environment() {
    let dir = temp_dir("hidden-env");
    let child = Command::new("/bin/sh")
        .args(["-c", "while :; do sleep 0.1; done"])
        .current_dir(&dir)
        .env("PROCS_HIDDEN", "x")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut child = Reaped(Some(child));
    // Wait until the pid no longer runs this binary (whose env IS readable), or a loaded run can
    // scan before the exec. Not `== "/bin/sh"`: macOS's /bin/sh re-execs into bash/zsh/dash.
    let pid = child.pid();
    let me = std::env::current_exe().unwrap();
    let me = std::fs::canonicalize(&me).unwrap_or(me);
    wait_blocking("the child to exec /bin/sh", || {
        procscan::scan_raw().iter().any(|p| {
            p.pid == pid
                && p.exe
                    .as_deref()
                    .is_some_and(|e| Path::new(e) != me.as_path())
        })
    });
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _g = rt.enter();
    let procs = Procs::new(hub_on(&rt), no_exclusion(), None);
    let err = procs.prepare_restart(child.pid()).unwrap_err();
    assert!(err.contains("cannot be read"), "{err}");
    child.kill();
}

#[cfg(target_os = "macos")]
fn hub_on(rt: &tokio::runtime::Runtime) -> LogHub {
    let (hub, task) = LogHub::new(Arc::new(NullLogSink));
    rt.spawn(task);
    hub
}

// ── Apps the IDE's own terminals and agents started ──────────────────────────

/// A process table row (cwd `/w/gazelle`, stdio on pipes unless `fds` says otherwise).
fn rp(pid: u32, ppid: u32, exe: &str, argv: &[&str]) -> RawProc {
    RawProc {
        pid,
        ppid,
        exe: Some(exe.into()),
        argv: v(argv),
        cwd: Some("/w/gazelle".into()),
        started_ms: Some(1),
        fds: vec![
            Fd {
                fd: 1,
                kind: FdKind::Pipe,
            },
            Fd {
                fd: 2,
                kind: FdKind::Pipe,
            },
        ],
    }
}

fn on_tty(mut p: RawProc, dev: &str) -> RawProc {
    p.fds = (0..3)
        .map(|fd| Fd {
            fd,
            kind: FdKind::Tty(dev.into()),
        })
        .collect();
    p
}

fn to_file(mut p: RawProc, path: &str) -> RawProc {
    p.fds = (1..3)
        .map(|fd| Fd {
            fd,
            kind: FdKind::File {
                path: path.into(),
                writable: true,
            },
        })
        .collect();
    p
}

fn term(id: &str, title: &str, tty: &str, agent: Option<(&str, &str)>) -> IdeTerminal {
    IdeTerminal {
        terminal_id: id.into(),
        title: title.into(),
        tty: Some(tty.into()),
        agent_id: agent.map(|(a, _)| a.into()),
        agent_title: agent.map(|(_, t)| t.into()),
    }
}

const IDE: u32 = 100;
const T1_TTY: &str = "/dev/ttys011";
const T2_TTY: &str = "/dev/ttys012";
const CLAUDE: &str = "/Users/sam/.local/share/claude/versions/2.1.212";

/// The IDE (a dev build, so it classifies as Rust), plain terminal T1 (zsh 101), T2 (zsh 201) with
/// a `claude` bound as agent A, T3 whose PTY child IS the app, unbound T4 with a claude, the world.
fn machine() -> Vec<RawProc> {
    vec![
        rp(1, 0, "/sbin/launchd", &["/sbin/launchd"]),
        rp(
            IDE,
            1,
            "/w/AgentStudioIDE/src-tauri/target/debug/agent-studio-scaffold",
            &["agent-studio-scaffold"],
        ),
        // T1: a plain terminal.
        on_tty(rp(101, IDE, "/bin/zsh", &["-zsh"]), T1_TTY),
        on_tty(
            rp(
                102,
                101,
                "/opt/homebrew/bin/node",
                &["node", "/w/web/node_modules/.bin/vite"],
            ),
            T1_TTY,
        ),
        on_tty(
            rp(103, 101, "/Users/sam/.cargo/bin/cargo", &["cargo", "run"]),
            T1_TTY,
        ),
        on_tty(
            rp(
                104,
                103,
                "/w/gazelle/target/debug/gazelle",
                &["target/debug/gazelle"],
            ),
            T1_TTY,
        ),
        // fd 1 on some other tty: a terminal console, but not this IDE terminal's.
        on_tty(
            rp(105, 101, "/opt/homebrew/bin/node", &["node", "other.js"]),
            "/dev/ttys099",
        ),
        // The IDE's own tooling, under no terminal.
        rp(
            120,
            IDE,
            "/opt/homebrew/bin/node",
            &[
                "node",
                "/Users/sam/.npm/node_modules/typescript-language-server/lib/cli.mjs",
                "--stdio",
            ],
        ),
        // T2: zsh → claude (bound, agent A) → its Bash tool's zsh → node server.js.
        on_tty(rp(201, IDE, "/bin/zsh", &["-zsh"]), T2_TTY),
        on_tty(rp(202, 201, CLAUDE, &["claude"]), T2_TTY),
        rp(
            203,
            202,
            "/bin/zsh",
            &[
                "/bin/zsh",
                "-c",
                "-l",
                "eval 'node server.js' && pwd -P >| /tmp/claude-1a2b-cwd",
            ],
        ),
        rp(204, 203, "/opt/homebrew/bin/node", &["node", "server.js"]),
        // A node typed in T2 before claude started: T2's, not the agent's.
        rp(205, 201, "/opt/homebrew/bin/node", &["node", "early.js"]),
        // claude's own helpers: an MCP server (node) and its ripgrep.
        rp(
            206,
            202,
            "/opt/homebrew/bin/node",
            &[
                "node",
                "/Users/sam/.npm/_npx/9/node_modules/.bin/mcp-server-git",
            ],
        ),
        rp(
            207,
            202,
            "/Users/sam/.local/share/claude/versions/2.1.212/vendor/ripgrep/rg",
            &["rg", "--files"],
        ),
        // A service the agent started with a shell that logs to a file (the shell itself).
        to_file(
            rp(
                208,
                202,
                "/bin/sh",
                &["/bin/sh", "-c", "exec >svc.log 2>&1; ./svc"],
            ),
            "/w/gazelle/svc.log",
        ),
        // The npm-installed claude CLI (node running the package) — it would classify as node.
        rp(
            210,
            201,
            "/opt/homebrew/bin/node",
            &[
                "node",
                "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ],
        ),
        // T3: the PTY child is the app itself.
        rp(300, IDE, "/opt/homebrew/bin/node", &["node", "api.js"]),
        // T4: unbound, but a claude runs in it and ran a server.
        rp(401, IDE, "/bin/zsh", &["-zsh"]),
        rp(402, 401, CLAUDE, &["claude"]),
        rp(403, 402, "/bin/bash", &["bash", "-c", "node srv.js; true"]),
        rp(404, 403, "/opt/homebrew/bin/node", &["node", "srv.js"]),
        // Outside: iTerm's zsh → node on its tty; claude in iTerm with its own MCP worker.
        rp(500, 1, "/bin/zsh", &["-zsh"]),
        on_tty(
            rp(501, 500, "/opt/homebrew/bin/node", &["node", "worker.js"]),
            "/dev/ttys001",
        ),
        rp(502, 500, CLAUDE, &["claude"]),
        rp(
            503,
            502,
            "/opt/homebrew/bin/node",
            &["node", "/Users/sam/mcp/index.js"],
        ),
        rp(
            504,
            502,
            "/bin/zsh",
            &["/bin/zsh", "-c", "node ext.js; true"],
        ),
        rp(505, 504, "/opt/homebrew/bin/node", &["node", "ext.js"]),
        // A malformed table: a ppid cycle.
        rp(600, 601, "/opt/homebrew/bin/node", &["node", "a.js"]),
        rp(601, 600, "/opt/homebrew/bin/node", &["node", "b.js"]),
    ]
}

fn ide_table() -> HashMap<u32, IdeTerminal> {
    HashMap::from([
        (101, term("T1", "zsh", T1_TTY, None)),
        (
            201,
            term("T2", "zsh", T2_TTY, Some(("A", "claude · gazelle"))),
        ),
        (300, term("T3", "node", "/dev/ttys013", None)),
        (401, term("T4", "zsh", "/dev/ttys014", None)),
    ])
}

fn at(terminal: &str, by: &str, agent: Option<&str>, tty: &str) -> Placement {
    Placement::Ide(ide::Attribution {
        terminal_id: terminal.into(),
        launched_by: by.into(),
        agent_id: agent.map(str::to_string),
        tty: Some(tty.into()),
    })
}

/// Parent chain → IDE terminal, hand-written per row.
#[test]
fn the_parent_chain_maps_a_process_to_its_ide_terminal_and_agent() {
    let procs = machine();
    let by_pid: HashMap<u32, &RawProc> = procs.iter().map(|p| (p.pid, p)).collect();
    let table = ide_table();
    let cases: Vec<(&str, u32, Option<u32>, Placement)> = vec![
        ("shell → app", 102, Some(IDE), at("T1", "zsh", None, T1_TTY)),
        (
            "shell → cargo → binary",
            104,
            Some(IDE),
            at("T1", "zsh", None, T1_TTY),
        ),
        (
            "the PTY child is the app",
            300,
            Some(IDE),
            at("T3", "node", None, "/dev/ttys013"),
        ),
        (
            "through claude's Bash tool in a bound terminal",
            204,
            Some(IDE),
            at("T2", "claude · gazelle", Some("A"), T2_TTY),
        ),
        (
            "typed in the bound terminal, not under claude",
            205,
            Some(IDE),
            at("T2", "zsh", None, T2_TTY),
        ),
        (
            "under claude in an unbound terminal: no agent to lend",
            404,
            Some(IDE),
            at("T4", "zsh", None, "/dev/ttys014"),
        ),
        (
            "a shell claude started is kept (the shell itself)",
            208,
            Some(IDE),
            at("T2", "claude · gazelle", Some("A"), T2_TTY),
        ),
        ("the IDE's tooling", 120, Some(IDE), Placement::Internal),
        (
            "…is external when the IDE pid is unknown",
            120,
            None,
            Placement::External,
        ),
        (
            "claude's MCP worker",
            206,
            Some(IDE),
            Placement::ClaudeHelper,
        ),
        ("claude's ripgrep", 207, Some(IDE), Placement::ClaudeHelper),
        ("the claude CLI", 202, Some(IDE), Placement::ClaudeHelper),
        (
            "the npm claude CLI",
            210,
            Some(IDE),
            Placement::ClaudeHelper,
        ),
        ("outside the IDE", 501, Some(IDE), Placement::External),
        (
            "an outside claude's helper",
            503,
            Some(IDE),
            Placement::ClaudeHelper,
        ),
        (
            "what an outside claude ran through a shell",
            505,
            Some(IDE),
            Placement::External,
        ),
        ("a ppid cycle ends", 600, Some(IDE), Placement::External),
        ("an unknown pid", 9999, Some(IDE), Placement::External),
    ];
    let mut failures = Vec::new();
    for (what, pid, ide_pid, want) in cases {
        let got = ide::place(pid, &by_pid, ide_pid, &table);
        if got != want {
            failures.push(format!(
                "{what} (pid {pid}):\n   got  {got:?}\n   want {want:?}"
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// `(pid, origin, terminalId, agentId, console, name)`.
type Row<'a> = (
    u32,
    Origin,
    Option<&'a str>,
    Option<&'a str>,
    Console,
    &'a str,
);

/// What `assemble` lists from the same machine, and how (the exclusions and console).
#[test]
fn the_exclusion_table() {
    let apps = procscan::assemble(
        &machine(),
        &AssembleOpts {
            ide_pid: Some(IDE),
            home: Some(HOME.into()),
            terminals: Arc::new(ide_table()),
            proxy_port: None,
        },
    );
    let got: Vec<Row> = apps
        .iter()
        .map(|a| {
            (
                a.pid.unwrap(),
                a.origin,
                a.terminal_id.as_deref(),
                a.agent_id.as_deref(),
                a.console,
                a.name.as_str(),
            )
        })
        .collect();
    use Origin::{External, Ide};
    let want: Vec<Row> = vec![
        // Sorted by name, then pid.
        (600, External, None, None, Console::Pipe, "a.js · gazelle"),
        // T3's PTY child is the app itself (`node api.js`, stdio on pipes here).
        (
            300,
            Ide,
            Some("T3"),
            None,
            Console::Pipe,
            "api.js · gazelle",
        ),
        (601, External, None, None, Console::Pipe, "b.js · gazelle"),
        (
            205,
            Ide,
            Some("T2"),
            None,
            Console::Pipe,
            "early.js · gazelle",
        ),
        (505, External, None, None, Console::Pipe, "ext.js · gazelle"),
        // 104 listed, its `cargo run` (103) hidden.
        (104, Ide, Some("T1"), None, Console::IdeTerminal, "gazelle"),
        (
            105,
            Ide,
            Some("T1"),
            None,
            Console::Terminal,
            "other.js · gazelle",
        ),
        (
            204,
            Ide,
            Some("T2"),
            Some("A"),
            Console::Pipe,
            "server.js · gazelle",
        ),
        (
            208,
            Ide,
            Some("T2"),
            Some("A"),
            Console::File,
            "sh · gazelle",
        ),
        (
            404,
            Ide,
            Some("T4"),
            None,
            Console::Pipe,
            "srv.js · gazelle",
        ),
        (
            102,
            Ide,
            Some("T1"),
            None,
            Console::IdeTerminal,
            "vite · gazelle",
        ),
        (
            501,
            External,
            None,
            None,
            Console::Terminal,
            "worker.js · gazelle",
        ),
    ];
    assert_eq!(got, want);
    for dropped in [IDE, 101, 103, 120, 202, 206, 207, 210, 402, 502, 503] {
        assert!(
            !apps.iter().any(|a| a.pid == Some(dropped)),
            "pid {dropped} must not be listed"
        );
    }
    let server = apps.iter().find(|a| a.pid == Some(204)).unwrap();
    assert_eq!(server.launched_by.as_deref(), Some("claude · gazelle"));
    let vite = apps.iter().find(|a| a.pid == Some(102)).unwrap();
    assert_eq!(vite.launched_by.as_deref(), Some("zsh"));
    let outside = apps.iter().find(|a| a.pid == Some(501)).unwrap();
    assert_eq!(
        (
            outside.terminal_id.as_deref(),
            outside.launched_by.as_deref()
        ),
        (None, None)
    );
    let wire = serde_json::to_value(server).unwrap();
    assert_eq!(wire["origin"], "ide");
    assert_eq!(wire["terminalId"], "T2");
    assert_eq!(wire["agentId"], "A");
    assert_eq!(wire["launchedBy"], "claude · gazelle");
    assert_eq!(
        serde_json::to_value(vite).unwrap()["console"],
        "ide-terminal"
    );
    assert_eq!(serde_json::to_value(outside).unwrap()["origin"], "external");
}

// ── live: an app in a real IDE terminal ──────────────────────────────────────

/// Not a test: the IDE-terminal test's app, copied to `<project>/target/debug/<name>` so it
/// classifies as a Rust dev app; prints a line and waits under `PROCS_HELPER=probe`.
#[test]
fn helper_ide_probe() {
    if std::env::var(HELPER).as_deref() != Ok("probe") {
        return;
    }
    println!("probe up");
    loop {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Kills a pid on drop (the probes are grandchildren: nothing else reaps them).
struct KillOnDrop(Vec<u32>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        for &pid in &self.0 {
            // SAFETY: kill has no memory preconditions; the pids are our own probes.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_app_run_in_a_real_ide_terminal_is_listed_as_the_ides_with_that_terminal() {
    let dir = temp_dir("ide");
    let project = dir.join("gazelle");
    let bin_dir = project.join("target/debug");
    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::create_dir_all(project.join("tasks")).unwrap();
    let me = std::env::current_exe().unwrap();
    // On APFS `fs::copy` is a clone — no bytes copied.
    let on_tty = bin_dir.join("gazelle");
    let to_file = bin_dir.join("svc-probe");
    std::fs::copy(&me, &on_tty).unwrap();
    std::fs::copy(&me, &to_file).unwrap();
    let output = project.join("tasks/b1.output");
    let run = |bin: &Path| {
        format!(
            "{HELPER}=probe '{}' --exact helper_ide_probe --nocapture --test-threads=1",
            bin.display()
        )
    };
    // `/bin/sh`, never the user's shell; `& … & wait` keeps sh as the parent.
    let script = format!(
        "{} & {} >'{}' 2>&1 & wait",
        run(&on_tty),
        run(&to_file),
        output.display()
    );

    let sup = spawn_supervisor(Arc::new(NullSink), vec![], None);
    let meta = sup
        .open_terminal(
            agent_studio_scaffold_lib::supervisor::OpenSpec {
                terminal_id: format!("ide-probe-{}", ulid::Ulid::new()),
                program: Some("/bin/sh".into()),
                args: vec!["-c".into(), script],
                cwd: project.display().to_string(),
                rows: 24,
                cols: 80,
            },
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .await
        .expect("open the terminal");

    let opts = AssembleOpts {
        ide_pid: Some(std::process::id()),
        ..AssembleOpts::default()
    };
    let with_table = Procs::new(hub(), opts.clone(), None).with_terminals(sup.ide_terminals());
    let is_probe = |a: &procscan::DevApp, bin: &Path| {
        a.exe
            .as_deref()
            .is_some_and(|e| std::fs::canonicalize(e).ok() == std::fs::canonicalize(bin).ok())
    };
    let start = Instant::now();
    let apps = loop {
        let apps = with_table.list().await.apps;
        if apps.iter().any(|a| is_probe(a, &on_tty)) && apps.iter().any(|a| is_probe(a, &to_file)) {
            break apps;
        }
        assert!(
            start.elapsed() < TIMEOUT,
            "the probes never appeared; listed: {:#?}",
            apps.iter()
                .map(|a| (a.pid, &a.name, &a.exe))
                .collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let tty_app = apps.iter().find(|a| is_probe(a, &on_tty)).unwrap();
    let file_app = apps.iter().find(|a| is_probe(a, &to_file)).unwrap();
    let _kill = KillOnDrop(vec![tty_app.pid.unwrap(), file_app.pid.unwrap()]);

    assert_eq!(tty_app.origin, Origin::Ide);
    assert_eq!(tty_app.terminal_id.as_deref(), Some(meta.id.as_str()));
    assert_eq!(
        tty_app.console,
        Console::IdeTerminal,
        "fd 1 is the terminal's pty slave"
    );
    assert_eq!(
        tty_app.launched_by.as_deref(),
        Some("sh"),
        "the terminal's title"
    );
    assert_eq!(tty_app.agent_id, None, "no agent bound");
    assert_eq!(tty_app.runtime, Runtime::Rust);
    assert_eq!(tty_app.name, "gazelle");

    // A gazelle-style service: stdout to a task `.output` file → that exact file.
    assert_eq!(file_app.origin, Origin::Ide);
    assert_eq!(file_app.terminal_id.as_deref(), Some(meta.id.as_str()));
    assert_eq!(file_app.console, Console::File);
    assert_eq!(file_app.name, "svc-probe · gazelle");
    let canon = std::fs::canonicalize(&output)
        .unwrap()
        .display()
        .to_string();
    assert_eq!(
        file_app
            .log_files
            .iter()
            .map(|f| (f.path.as_str(), f.kind))
            .collect::<Vec<_>>(),
        vec![(canon.as_str(), LogVia::Stdout)],
        "fd 1/2 → the .output file, reported by its canonical path"
    );

    // Two-sided: the same scan without the supervisor's table places both
    // probes under "the IDE" but under no terminal of it — its tooling — so neither is listed.
    let without = Procs::new(hub(), opts, None).list().await.apps;
    for app in [tty_app, file_app] {
        assert!(
            !without.iter().any(|a| a.pid == app.pid),
            "pid {:?} listed without the terminal table",
            app.pid
        );
    }

    sup.close(meta.id).await.unwrap();
}

// ── capture guard ───────────────────────────────────────────────────────────

type AppsPred = Box<dyn Fn(&[procscan::DevApp]) -> bool + Send>;

struct NoFlows;
impl FlowSink for NoFlows {
    fn emit(&self, _: &[FlowSummary]) {}
}

/// Installed once per binary so supervisor PTYs get the app's capture env; its own leaked runtime
/// outlives every test's. `user_env: vec![]` so it injects even inside an IDE terminal.
fn capture_proxy_port() -> u16 {
    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *PORT.get_or_init(|| {
        let rt: &'static tokio::runtime::Runtime = Box::leak(Box::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap(),
        ));
        let _g = rt.enter();
        let nc = Netcap::start(
            NetcapConfig {
                dir: None,
                trust_anchors: Some(Vec::new()),
                user_env: Vec::new(),
                preferred_port: None,
            },
            Arc::new(NoFlows),
        )
        .expect("the capture proxy starts");
        let port = nc.port();
        assert!(netcap::install(nc).is_ok(), "installed once");
        port
    })
}

/// A service started with every proxy var stripped is listed `captured: false`; Restart with
/// capture relaunches it in an IDE terminal, giving `true`. Only booleans are asserted and
/// printed: a captured environment must never be printed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ide_app_started_without_the_proxy_is_flagged_and_restart_with_capture_restores_it() {
    let port = capture_proxy_port();
    assert_eq!(netcap::injecting_port(), Some(port));
    let dir = temp_dir("capture");
    let project = dir.join("gazelle");
    let bin_dir = project.join("target/debug");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let me = std::env::current_exe().unwrap();
    let stripped = bin_dir.join("gazelle");
    let control = bin_dir.join("control");
    std::fs::copy(&me, &stripped).unwrap();
    std::fs::copy(&me, &control).unwrap();
    let args = "--exact helper_ide_probe --nocapture --test-threads=1";
    // `/bin/sh`, never the user's shell; `env -u …` is what the agent ran.
    let script = format!(
        "env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy {HELPER}=probe '{}' {args} & \
         {HELPER}=probe '{}' {args} & wait",
        stripped.display(),
        control.display()
    );

    let sup = spawn_supervisor(Arc::new(NullSink), vec![], None);
    let meta = sup
        .open_terminal(
            agent_studio_scaffold_lib::supervisor::OpenSpec {
                terminal_id: format!("capture-{}", ulid::Ulid::new()),
                program: Some("/bin/sh".into()),
                args: vec!["-c".into(), script],
                cwd: project.display().to_string(),
                rows: 24,
                cols: 80,
            },
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .await
        .expect("open the terminal");

    let procs = Procs::new(
        hub(),
        AssembleOpts {
            ide_pid: Some(std::process::id()),
            ..AssembleOpts::default()
        },
        None,
    )
    .with_terminals(sup.ide_terminals())
    .with_live_proxy();
    let is = |a: &procscan::DevApp, bin: &Path| {
        a.exe
            .as_deref()
            .is_some_and(|e| std::fs::canonicalize(e).ok() == std::fs::canonicalize(bin).ok())
    };
    let wait_for = |pred: AppsPred| {
        let procs = &procs;
        async move {
            let start = Instant::now();
            loop {
                let apps = procs.list().await.apps;
                if pred(&apps) {
                    break apps;
                }
                assert!(
                    start.elapsed() < TIMEOUT,
                    "timed out; listed: {:?}",
                    apps.iter()
                        .map(|a| (a.pid, &a.name, a.captured))
                        .collect::<Vec<_>>()
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    };
    let (s2, c2) = (stripped.clone(), control.clone());
    let apps = wait_for(Box::new(move |apps| {
        apps.iter().any(|a| is(a, &s2)) && apps.iter().any(|a| is(a, &c2))
    }))
    .await;
    let old = apps.iter().find(|a| is(a, &stripped)).unwrap().clone();
    let ctl = apps.iter().find(|a| is(a, &control)).unwrap().clone();
    let mut kill = KillOnDrop(vec![old.pid.unwrap(), ctl.pid.unwrap()]);
    assert_eq!(old.origin, Origin::Ide);
    assert_eq!(old.terminal_id.as_deref(), Some(meta.id.as_str()));
    assert_eq!(
        old.captured,
        Some(false),
        "started with the proxy vars stripped"
    );
    // Two-sided: the same terminal, the vars left alone.
    assert_eq!(ctl.captured, Some(true), "started the normal way");

    // Restart with capture — the same two steps as Restart in the IDE.
    let prepared = tokio::task::block_in_place(|| procs.prepare_restart(old.pid.unwrap()))
        .expect("an IDE app can be restarted");
    assert_eq!(
        prepared.summary.name, old.name,
        "the confirm names the same app"
    );
    let done = procs
        .restart_in_ide(&sup, &prepared.token, None, None, None)
        .await
        .expect("restart with capture");
    assert_ne!(done.terminal_id, meta.id, "a NEW terminal");
    let (s3, old_pid) = (stripped.clone(), old.pid);
    let apps = wait_for(Box::new(move |apps| {
        apps.iter().any(|a| is(a, &s3) && a.pid != old_pid)
    }))
    .await;
    assert!(
        !apps.iter().any(|a| a.pid == old.pid),
        "the uncaptured process was stopped"
    );
    let new = apps
        .iter()
        .find(|a| is(a, &stripped) && a.pid != old.pid)
        .unwrap();
    kill.0.push(new.pid.unwrap());
    assert_eq!(new.origin, Origin::Ide);
    assert_eq!(new.terminal_id.as_deref(), Some(done.terminal_id.as_str()));
    assert_eq!(new.captured, Some(true), "capture restored");

    sup.close(done.terminal_id).await.unwrap();
    sup.close(meta.id).await.unwrap();
}
