//! Background tasks as a log source: a service an
//! agent starts with `run_in_background` writes to a file under Claude's temp dir, and
//! the Agent Logs view must show it as `task` lines.
//!
//! Hermetic: every file lives under a private temp dir standing in for `claude-<uid>`
//! (the roots are injected), the transcript is the synthetic fixture in
//! `fixtures/logstream/tasks/` (the shape of real CLI 2.1.x lines, none of their content),
//! and the clock is passed in. The one test that runs a real process is `#[ignore]`d.

#![cfg(unix)]

use std::io::Write;
use std::path::{Path, PathBuf};

use agent_studio_scaffold_lib::agent::adapter::AgentAdapter;
use agent_studio_scaffold_lib::agent::claude::{task_output_path, ClaudeAdapter};
use agent_studio_scaffold_lib::agent::fanout::TranscriptLocation;
use agent_studio_scaffold_lib::agent::tools::{TaskEvent, TranscriptToolTail};
use agent_studio_scaffold_lib::logstream::tasks::{
    program_of, redirect_targets, source_name, task_source, validate_task_path, PathRefusal,
    TaskSlots, TaskSpec, TaskTails, MAX_TASK_FILES, MAX_TASK_TAILS, TASK_BACKFILL_LINES,
    TASK_IDLE_STOP, TASK_LINES_PER_SEC,
};
use agent_studio_scaffold_lib::logstream::{LineDraft, LogKind, LogLevel};
use agent_studio_scaffold_lib::supervisor::poll_task_tails;
use tokio::time::{Duration, Instant};

const FIXED_TS: &str = "2026-01-01T12:00:04.000Z";
const GAZELLE_CMD: &str = "cd /work/gazelle && RUST_LOG=info ./target/debug/gazelle serve";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/logstream/tasks")
        .join(name)
}

/// A fake `claude-<uid>` root with a session's `tasks/` and `scratchpad/` dirs in it.
struct Root {
    base: PathBuf,
    root: PathBuf,
    /// `<root>/-work-gazelle/sess` — what an agent's cwd is when it works in its scratchpad.
    session: PathBuf,
    tasks: PathBuf,
    scratch: PathBuf,
}

impl Root {
    fn new(tag: &str) -> Root {
        let base = std::env::temp_dir().join(format!("tasktail-{tag}-{}", ulid::Ulid::new()));
        let root = base.join("claude-4242");
        let session = root.join("-work-gazelle").join("sess");
        let tasks = session.join("tasks");
        let scratch = session.join("scratchpad");
        std::fs::create_dir_all(&tasks).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        Root {
            base,
            root,
            session,
            tasks,
            scratch,
        }
    }
    fn roots(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }
    fn tails(&self) -> TaskTails {
        TaskTails::new(self.roots(), TaskSlots::new(MAX_TASK_TAILS))
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn append(path: &Path, s: &str) {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(s.as_bytes()).unwrap();
}

fn spec(path: &Path, task: &str) -> TaskSpec {
    spec_cmd(path, task, GAZELLE_CMD, None)
}

fn spec_cmd(path: &Path, task: &str, command: &str, cwd: Option<&Path>) -> TaskSpec {
    TaskSpec {
        agent_id: "agent-root".into(),
        task_id: task.into(),
        command: command.into(),
        path: path.to_path_buf(),
        cwd: cwd.map(Path::to_path_buf),
    }
}

fn texts(lines: &[LineDraft], kind: LogKind) -> Vec<String> {
    lines
        .iter()
        .filter(|l| l.kind == kind)
        .map(|l| l.text.clone())
        .collect()
}

/// The fixture transcript with its placeholders filled.
fn transcript(name: &str, task_path: &Path) -> String {
    transcript_in(name, task_path, Path::new("/work/gazelle"))
}

/// …with the agent's `cwd` too (`start-redirect.jsonl`).
fn transcript_in(name: &str, task_path: &Path, cwd: &Path) -> String {
    std::fs::read_to_string(fixture(name))
        .unwrap()
        .replace("@NOW@", FIXED_TS)
        .replace("@TASK_PATH@", &task_path.to_string_lossy())
        .replace("@CWD@", &cwd.to_string_lossy())
}

// ── path guard ──────────────────────────────────────────────────────────────

#[test]
fn only_a_regular_file_strictly_under_the_claude_root_is_accepted() {
    let r = Root::new("guard");
    let ok = r.tasks.join("b1.output");
    std::fs::write(&ok, "x\n").unwrap();
    let outside_dir = r.base.join("elsewhere");
    std::fs::create_dir_all(&outside_dir).unwrap();
    let outside = outside_dir.join("secret.txt");
    std::fs::write(&outside, "secret\n").unwrap();

    // A symlink in the root that escapes it (Claude's own sub-agent `.output` files
    // are exactly this: links into `~/.claude`).
    let escape = r.tasks.join("escape.output");
    std::os::unix::fs::symlink(&outside, &escape).unwrap();
    // A symlink that stays inside is fine — it resolves to a file under the root.
    let inner_link = r.tasks.join("inner.output");
    std::os::unix::fs::symlink(&ok, &inner_link).unwrap();
    // `..` is refused as written, even though this one resolves back inside.
    let dotdot = r.tasks.join("..").join("tasks").join("b1.output");
    let fifo = r.tasks.join("pipe.output");
    let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    // SAFETY: a valid NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);

    let roots = r.roots();
    let canon_ok = std::fs::canonicalize(&ok).unwrap();
    assert_eq!(validate_task_path(&ok, &roots), Ok(canon_ok.clone()));
    assert_eq!(validate_task_path(&inner_link, &roots), Ok(canon_ok));
    assert_eq!(
        validate_task_path(&outside, &roots),
        Err(PathRefusal::OutsideRoot)
    );
    assert_eq!(
        validate_task_path(&escape, &roots),
        Err(PathRefusal::OutsideRoot)
    );
    assert_eq!(
        validate_task_path(&dotdot, &roots),
        Err(PathRefusal::ParentComponent)
    );
    assert_eq!(
        validate_task_path(&r.tasks, &roots),
        Err(PathRefusal::NotRegularFile)
    );
    assert_eq!(
        validate_task_path(&fifo, &roots),
        Err(PathRefusal::NotRegularFile)
    );
    assert_eq!(
        validate_task_path(&r.root, &roots),
        Err(PathRefusal::OutsideRoot),
        "the root itself is not a task file"
    );
    assert_eq!(
        validate_task_path(Path::new("tasks/b1.output"), &roots),
        Err(PathRefusal::NotAbsolute)
    );
    assert_eq!(
        validate_task_path(&r.tasks.join("nope.output"), &roots),
        Err(PathRefusal::Missing)
    );
    // A file that does not exist is only worth waiting for under a root: a redirect to
    // `/work/server.log` is refused now rather than watched forever.
    assert_eq!(
        validate_task_path(&r.base.join("elsewhere").join("later.log"), &roots),
        Err(PathRefusal::OutsideRoot)
    );
    // A sibling whose name merely starts with the root's is not under it.
    let sibling = r.base.join("claude-42420");
    std::fs::create_dir_all(&sibling).unwrap();
    std::fs::write(sibling.join("x.output"), "x\n").unwrap();
    assert_eq!(
        validate_task_path(&sibling.join("x.output"), &roots),
        Err(PathRefusal::OutsideRoot)
    );
}

#[test]
fn a_refused_path_is_announced_and_holds_no_slot() {
    let r = Root::new("refused");
    let outside = r.base.join("outside.output");
    std::fs::write(&outside, "INFO secret line\n").unwrap();
    let slots = TaskSlots::new(MAX_TASK_TAILS);
    let mut tails = TaskTails::new(r.roots(), slots.clone());
    let now = Instant::now();
    let out = tails.start(spec(&outside, "bout1"), now);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].kind, LogKind::System);
    assert_eq!(out[0].level, LogLevel::Warn);
    assert_eq!(
        out[0].text,
        "not tailing background task bout1: the file is outside Claude's temp dir"
    );
    assert_eq!(slots.in_use(), 0);
    assert!(tails.task_ids().is_empty());
    assert!(
        texts(&tails.poll(now), LogKind::Task).is_empty(),
        "nothing outside the root is ever read"
    );
}

// ── command → program ───────────────────────────────────────────────────────

/// Expectations written by hand.
#[test]
fn the_program_table() {
    let table: &[(&str, &str)] = &[
        ("./target/debug/gazelle > /tmp/g.log 2>&1", "gazelle"),
        ("./target/debug/gazelle", "gazelle"),
        ("cargo run -p gazelle-server", "cargo"),
        (GAZELLE_CMD, "gazelle"),
        ("FOO=bar BAZ=1 npm run dev", "npm"),
        ("export PORT=8080 && python3 -m http.server", "python3"),
        ("cd /x; set -a; source .env; set +a; exec ./target/debug/gazelle serve > s.log 2>&1", "gazelle"),
        (
            "R=/private/tmp/claude-501/p/s/scratchpad/rig; cd /w/gazelle-server; set -a; source $R/app.env; set +a; exec ./target/debug/gazelle serve > $R/server.log 2>&1",
            "gazelle",
        ),
        (
            "cd /w; T=$(grep '^TOKEN=' .env | cut -d= -f2-); curl -s -H \"x: $T\" http://localhost:8080/health",
            "curl",
        ),
        ("cargo run 2>&1 | tee run.log", "cargo"),
        ("nohup ./svc --port 1 &", "svc"),
        ("env -i PATH=/bin node server.js", "node"),
        ("(cd web && pnpm dev)", "pnpm"),
        ("while true; do curl -s localhost:1/x || true; sleep 1; done", "curl"),
        ("tail -f /work/gazelle/server.log | grep --line-buffered ERROR", "tail"),
        ("\"/Applications/My App.app/Contents/MacOS/My App\" --serve", "My App"),
        ("sleep 5", "sleep"),
        ("for i in 1 2 3; do echo \"tick $i\"; sleep 0.2; done", "echo"),
        ("/bin/sh -c 'for i in 1 2 3; do echo x; done' > out.txt", "sh"),
        ("", "task"),
    ];
    for (cmd, want) in table {
        assert_eq!(program_of(cmd), *want, "command: {cmd:?}");
    }
    assert_eq!(task_source(GAZELLE_CMD), "gazelle · bg");
}

/// A typical launch: `python3 …/run_local.py KEY=… > …/gazelle.log 2>&1`.
const LAUNCH_CMD: &str = "python3 /private/tmp/claude-501/-w/s/scratchpad/run_local.py APP_ENV=dev > /private/tmp/claude-501/-w/s/scratchpad/gazelle.log 2>&1";

// ── command → redirect targets ──────────────────────────────────────────────

/// Expectations written by hand, one row per grammar rule.
#[test]
fn the_redirect_target_table() {
    let table: &[(&str, &[&str])] = &[
        (
            LAUNCH_CMD,
            &["/private/tmp/claude-501/-w/s/scratchpad/gazelle.log"],
        ),
        ("./target/debug/gazelle > /tmp/g.log 2>&1", &["/tmp/g.log"]),
        ("./svc >> app.log", &["app.log"]),
        ("./svc 1> out.log 2> err.log", &["out.log", "err.log"]),
        ("./svc 2>>errors.log", &["errors.log"]),
        ("./svc >a.log >>b.log", &["a.log", "b.log"]),
        ("./svc &> both.log", &["both.log"]),
        ("./svc &>> both.log", &["both.log"]),
        ("./svc >& both.log", &["both.log"]),
        ("./svc >| clobber.log", &["clobber.log"]),
        // Dups are not files.
        ("./svc 2>&1", &[]),
        ("./svc >&2", &[]),
        ("./svc 1>&2 2>&-", &[]),
        // Input redirections are read, not written.
        ("./svc < in.txt > out.txt", &["out.txt"]),
        ("./svc <<< x > o.log", &["o.log"]),
        ("./svc <<EOF > h.log", &["h.log"]),
        // tee, with and without flags, several files, mid-pipeline.
        ("./svc 2>&1 | tee run.log", &["run.log"]),
        ("./svc | tee -a a.log b.log", &["a.log", "b.log"]),
        ("./svc | tee --append -i t.log", &["t.log"]),
        (
            "./svc | tee out.txt | grep x > hits.txt",
            &["out.txt", "hits.txt"],
        ),
        ("./svc | sudo tee /var/log/s.log", &["/var/log/s.log"]),
        // Quoting.
        ("./svc > 'my log.txt'", &["my log.txt"]),
        ("./svc > \"quoted.log\" 2>&1", &["quoted.log"]),
        ("./svc >\"attached.log\"", &["attached.log"]),
        // /dev/* is never a file to tail.
        ("./svc > /dev/null 2>&1", &[]),
        ("./svc 2> /dev/stderr > real.log", &["real.log"]),
        // Named twice: once.
        ("./svc > same.log 2> same.log", &["same.log"]),
        ("./svc > x.log | tee x.log", &["x.log"]),
        // Every simple command is looked at, in order; substitutions are not.
        (
            "cd /w && rm -f old.log && ./svc > svc.log 2>&1",
            &["svc.log"],
        ),
        ("echo start > run.log; ./svc >> run.log 2>&1", &["run.log"]),
        ("T=$(cat x > y); ./svc > real.log", &["real.log"]),
        ("./svc > `echo z > q`.log", &["`echo z > q`.log"]),
        ("nohup ./svc > nohup.out 2>&1 &", &["nohup.out"]),
        ("./svc > $R/server.log", &["$R/server.log"]),
        ("(cd web && pnpm dev > web.log)", &["web.log"]),
        ("./svc >", &[]),
        ("./svc", &[]),
        ("", &[]),
    ];
    for (cmd, want) in table {
        assert_eq!(
            redirect_targets(cmd),
            want.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            "command: {cmd:?}"
        );
    }
}

// ── command → source name ───────────────────────────────────────────────────

/// Expectations written by hand: the redirect's name when it is not
/// generic, else the program.
#[test]
fn the_source_name_table() {
    let table: &[(&str, &str)] = &[
        (LAUNCH_CMD, "gazelle"),
        ("./target/debug/gazelle serve", "gazelle"),
        ("cargo run 2>&1 | tee build.log", "build"),
        ("node server.js > api-server.log", "api-server"),
        ("node server.js > server.log.1", "server"),
        ("node server.js > 'my svc.log'", "my svc"),
        // Generic names: the program rule.
        ("./target/debug/gazelle > out.log 2>&1", "gazelle"),
        ("python3 app.py > output.txt", "python3"),
        ("python3 app.py > log.txt", "python3"),
        ("python3 app.py > logs/x.log", "x"),
        ("python3 app.py > logs.txt", "python3"),
        ("python3 app.py > stdout.txt 2> stderr.txt", "python3"),
        ("python3 app.py > OUT.LOG", "python3"),
        ("nohup node server.js > nohup.out 2>&1 &", "node"),
        ("node server.js > tmp.log", "node"),
        ("node server.js > temp.log", "node"),
        ("node server.js > .log", "node"),
        ("node server.js > $LOG", "node"),
        ("node server.js > /tmp/claude-1/p/s/tasks/b1.output", "node"),
        // Ids are not names; a hex-looking word without a digit is.
        ("node server.js > 12345.log", "node"),
        ("node server.js > deadbeef01.log", "node"),
        ("node server.js > 3f.log", "node"),
        ("node server.js > beef.log", "beef"),
        // The first non-generic target wins; dups and /dev/* do not count.
        ("./svc > out.log 2> errors.log", "errors"),
        ("./svc > /dev/null 2>&1", "svc"),
        ("./svc 2>&1", "svc"),
        ("", "task"),
    ];
    for (cmd, want) in table {
        assert_eq!(source_name(cmd), *want, "command: {cmd:?}");
    }
    assert_eq!(task_source(LAUNCH_CMD), "gazelle · bg");
    assert_eq!(task_source("python3 app.py > out.log"), "python3 · bg");
}

// ── the transcript side ─────────────────────────────────────────────────────

#[test]
fn only_a_launch_calls_own_result_starts_a_task_and_a_task_stop_ends_it() {
    let r = Root::new("parse");
    let task_path = r.tasks.join("bgen1a2b3.output");
    let tx = r.base.join("sess.jsonl");
    std::fs::write(&tx, transcript("start.jsonl", &task_path)).unwrap();
    let files = vec![("agent-root".to_string(), tx.clone())];
    let adapter = ClaudeAdapter::new();
    let mut tail = TranscriptToolTail::new(0);
    tail.poll(&files, |l| adapter.parse_tool_line(l));
    assert_eq!(
        tail.take_task_events(),
        vec![
            TaskEvent::Started {
                agent_id: "agent-root".into(),
                task_id: "bgen1a2b3".into(),
                command: GAZELLE_CMD.into(),
                output_path: Some(task_path.clone()),
                cwd: Some(PathBuf::from("/work/gazelle")),
            },
            TaskEvent::Started {
                agent_id: "agent-root".into(),
                task_id: "bmon4c5d6".into(),
                command:
                    "tail -f /work/gazelle/server.log | grep --line-buffered -E 'ERROR|panicked'"
                        .into(),
                output_path: None,
                cwd: Some(PathBuf::from("/work/gazelle")),
            },
        ],
        "the Read and the foreground Bash that merely print the marker start nothing"
    );

    // A failed stop stops nothing; a successful one names its task.
    append(&tx, &transcript("stop-failed.jsonl", &task_path));
    tail.poll(&files, |l| adapter.parse_tool_line(l));
    assert!(tail.take_task_events().is_empty());
    append(&tx, &transcript("stop.jsonl", &task_path));
    tail.poll(&files, |l| adapter.parse_tool_line(l));
    assert_eq!(
        tail.take_task_events(),
        vec![TaskEvent::Stopped {
            task_id: "bgen1a2b3".into()
        }]
    );
}

#[test]
fn a_task_started_before_the_tail_is_history() {
    let r = Root::new("history");
    let tx = r.base.join("sess.jsonl");
    std::fs::write(&tx, transcript("start.jsonl", &r.tasks.join("b.output"))).unwrap();
    let adapter = ClaudeAdapter::new();
    // The tail started after FIXED_TS.
    let mut tail = TranscriptToolTail::new(1_900_000_000_000);
    tail.poll(&[("a".to_string(), tx)], |l| adapter.parse_tool_line(l));
    assert!(tail.take_task_events().is_empty());
}

#[test]
fn a_monitor_output_path_is_derived_from_the_session() {
    let r = Root::new("derive");
    let loc = TranscriptLocation {
        root_transcript: PathBuf::from("/h/.claude/projects/-work-gazelle/sess.jsonl"),
        subagents_dir: PathBuf::from("/h/.claude/projects/-work-gazelle/sess/subagents"),
    };
    let missing = r.base.join("no-such-root");
    // The root whose session dir exists wins over an earlier one that lacks it.
    assert_eq!(
        task_output_path(&loc, "bmon4c5d6", &[missing.clone(), r.root.clone()]),
        Some(r.tasks.join("bmon4c5d6.output"))
    );
    assert_eq!(
        task_output_path(&loc, "bmon4c5d6", std::slice::from_ref(&missing)),
        Some(
            missing
                .join("-work-gazelle/sess/tasks")
                .join("bmon4c5d6.output")
        ),
        "no session dir anywhere → the first root"
    );
    assert_eq!(
        task_output_path(&loc, "../x", std::slice::from_ref(&r.root)),
        None
    );
    assert_eq!(
        task_output_path(&loc, "", std::slice::from_ref(&r.root)),
        None
    );
}

// ── the tail ────────────────────────────────────────────────────────────────

#[test]
fn a_live_task_file_becomes_task_lines_until_task_stop() {
    let r = Root::new("live");
    let task_path = r.tasks.join("bgen1a2b3.output");
    // The service already logged its startup before the result was read.
    std::fs::copy(fixture("gazelle.output"), &task_path).unwrap();
    let tx = r.base.join("sess.jsonl");
    std::fs::write(&tx, transcript("start.jsonl", &task_path)).unwrap();
    let adapter = ClaudeAdapter::new();
    let files = vec![("agent-root".to_string(), tx.clone())];
    let mut tool_tail = TranscriptToolTail::new(0);
    let mut tails = r.tails();
    let derive = |id: &str| Some(r.tasks.join(format!("{id}.output")));

    tool_tail.poll(&files, |l| adapter.parse_tool_line(l));
    let first = poll_task_tails(&mut tails, tool_tail.take_task_events(), derive);
    // Both tasks are announced; only gazelle has a file yet (the Monitor's waits).
    assert_eq!(
        texts(&first, LogKind::System),
        [
            "background task started · gazelle (bgen1a2b3)",
            "background task started · tail (bmon4c5d6)",
        ]
    );
    assert_eq!(tails.task_ids(), ["bgen1a2b3", "bmon4c5d6"]);
    let backfill: Vec<&LineDraft> = first.iter().filter(|l| l.kind == LogKind::Task).collect();
    assert_eq!(
        backfill.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
        [
            "2026-01-01T12:00:05.101Z  INFO gazelle: starting, config=/work/gazelle/.env",
            "2026-01-01T12:00:05.152Z  INFO gazelle: listening on 0.0.0.0:8080",
            "2026-01-01T12:00:05.160Z  WARN gazelle::upstream: geo key missing, error budget unaffected",
        ],
        "startup lines are read from the beginning, ANSI stripped"
    );
    let l = backfill[2];
    assert_eq!(l.level, LogLevel::Warn, "the WARN column wins over 'error'");
    assert_eq!(l.source, "gazelle · bg");
    assert_eq!(l.agent_id.as_deref(), Some("agent-root"));
    assert_eq!(
        l.terminal_id, None,
        "the actor fills the root terminal (logstream_tasks_live.rs)"
    );
    assert_eq!(
        l.detail.as_deref(),
        Some(format!("{GAZELLE_CMD}\n{}", task_path.display()).as_str())
    );

    // Appended after the start: they arrive on the next poll, with their levels.
    append(
        &task_path,
        "2026-01-01T12:00:06.001Z ERROR gazelle::api: upstream closed the connection\n\
         2026-01-01T12:00:06.002Z  INFO gazelle::api: GET /health 200\n",
    );
    let next = poll_task_tails(&mut tails, Vec::new(), derive);
    let got: Vec<(String, LogLevel)> = next
        .iter()
        .filter(|l| l.kind == LogKind::Task)
        .map(|l| (l.text.clone(), l.level))
        .collect();
    assert_eq!(
        got,
        [
            (
                "2026-01-01T12:00:06.001Z ERROR gazelle::api: upstream closed the connection"
                    .to_string(),
                LogLevel::Error
            ),
            (
                "2026-01-01T12:00:06.002Z  INFO gazelle::api: GET /health 200".to_string(),
                LogLevel::Info
            ),
        ]
    );
    assert!(poll_task_tails(&mut tails, Vec::new(), derive).is_empty());

    // TaskStop: the last words are read, then the tail ends.
    append(
        &task_path,
        "2026-01-01T12:00:07.000Z  INFO gazelle: shutting down\n",
    );
    append(&tx, &transcript("stop.jsonl", &task_path));
    tool_tail.poll(&files, |l| adapter.parse_tool_line(l));
    let stopped = poll_task_tails(&mut tails, tool_tail.take_task_events(), derive);
    assert_eq!(
        texts(&stopped, LogKind::Task),
        ["2026-01-01T12:00:07.000Z  INFO gazelle: shutting down"]
    );
    assert_eq!(
        texts(&stopped, LogKind::System),
        ["background task stopped · gazelle (bgen1a2b3) — stopped by the agent"]
    );
    assert_eq!(tails.task_ids(), ["bmon4c5d6"]);
    append(&task_path, "after the stop\n");
    assert!(texts(
        &poll_task_tails(&mut tails, Vec::new(), derive),
        LogKind::Task
    )
    .is_empty());
}

#[test]
fn a_monitor_file_that_appears_later_is_picked_up() {
    let r = Root::new("late");
    let mut tails = r.tails();
    let path = r.tasks.join("bmon1.output");
    let now = Instant::now();
    tails.start(spec(&path, "bmon1"), now);
    assert!(tails.poll(now).is_empty(), "waits for the file");
    append(&path, "ERROR boom\n");
    let out = tails.poll(now + Duration::from_secs(1));
    assert_eq!(texts(&out, LogKind::Task), ["ERROR boom"]);
    assert_eq!(out[0].level, LogLevel::Error);
}

#[test]
fn an_idle_file_stops_after_ten_minutes_of_silence() {
    assert_eq!(TASK_IDLE_STOP, Duration::from_secs(600));
    let r = Root::new("idle");
    let path = r.tasks.join("b1.output");
    std::fs::write(&path, "one\n").unwrap();
    let mut tails = r.tails();
    let t0 = Instant::now();
    tails.start(spec(&path, "b1"), t0);
    assert_eq!(texts(&tails.poll(t0), LogKind::Task), ["one"]);

    // Output at 9 min resets the clock.
    let t9 = t0 + Duration::from_secs(9 * 60);
    append(&path, "two\n");
    assert_eq!(texts(&tails.poll(t9), LogKind::Task), ["two"]);
    let almost = t9 + TASK_IDLE_STOP - Duration::from_millis(1);
    assert!(tails.poll(almost).is_empty());
    assert_eq!(tails.task_ids(), ["b1"]);

    let out = tails.poll(t9 + TASK_IDLE_STOP);
    assert_eq!(
        texts(&out, LogKind::System),
        ["background task stopped · gazelle (b1) — no output for 10 min"]
    );
    assert!(tails.task_ids().is_empty());
    append(&path, "three\n");
    assert!(tails.poll(t9 + TASK_IDLE_STOP * 2).is_empty());
}

#[test]
fn the_backfill_keeps_the_last_2000_lines() {
    assert_eq!(TASK_BACKFILL_LINES, 2_000);
    let r = Root::new("backfill");
    let path = r.tasks.join("b1.output");
    let body: String = (1..=2_500).map(|i| format!("line {i}\n")).collect();
    std::fs::write(&path, body).unwrap();
    let mut tails = r.tails();
    let now = Instant::now();
    tails.start(spec(&path, "b1"), now);
    let got = texts(&tails.poll(now), LogKind::Task);
    assert_eq!(got.len(), 2_001, "the notice + 2 000 lines");
    assert_eq!(
        got[0],
        "… earlier output not shown (the last 2000 lines are)"
    );
    assert_eq!(got[1], "line 501");
    assert_eq!(got[2_000], "line 2500");
}

#[test]
fn a_file_faster_than_the_cap_is_rate_limited_and_says_so() {
    assert_eq!(TASK_LINES_PER_SEC, 500);
    let r = Root::new("rate");
    let path = r.tasks.join("b1.output");
    std::fs::write(&path, "").unwrap();
    let mut tails = r.tails();
    let t0 = Instant::now();
    tails.start(spec(&path, "b1"), t0);
    assert!(tails.poll(t0).is_empty());
    let flood: String = (1..=700).map(|i| format!("flood {i}\n")).collect();
    append(&path, &flood);
    let out = texts(&tails.poll(t0 + Duration::from_millis(10)), LogKind::Task);
    assert_eq!(out.len(), 501, "500 lines + the drop report");
    assert_eq!(out[499], "flood 500");
    assert_eq!(out[500], "… 200 lines dropped (rate limit)");
    // The next window admits again.
    append(&path, "after\n");
    assert_eq!(
        texts(
            &tails.poll(t0 + Duration::from_millis(1_100)),
            LogKind::Task
        ),
        ["after"]
    );
}

#[test]
fn at_most_16_tails_at_once_app_wide() {
    assert_eq!(MAX_TASK_TAILS, 16);
    let r = Root::new("slots");
    let slots = TaskSlots::new(MAX_TASK_TAILS);
    // Two roots' tailers share the app-wide budget.
    let mut a = TaskTails::new(r.roots(), slots.clone());
    let mut b = TaskTails::new(r.roots(), slots.clone());
    let now = Instant::now();
    for i in 0..10 {
        a.start(
            spec(&r.tasks.join(format!("a{i}.output")), &format!("a{i}")),
            now,
        );
    }
    for i in 0..6 {
        b.start(
            spec(&r.tasks.join(format!("b{i}.output")), &format!("b{i}")),
            now,
        );
    }
    assert_eq!(slots.in_use(), 16);
    let refused = b.start(spec(&r.tasks.join("b6.output"), "b6"), now);
    assert_eq!(
        texts(&refused, LogKind::System),
        ["not tailing background task b6: 16 background tasks are already tailed"]
    );
    // A session ending drops its tails, and their slots come back.
    drop(a);
    assert_eq!(slots.in_use(), 6);
    let ok = b.start(spec(&r.tasks.join("b6.output"), "b6"), now);
    assert_eq!(
        texts(&ok, LogKind::System),
        ["background task started · gazelle (b6)"]
    );
}

/// The UI's "Running" list is built from these two lines, so their prefixes are wire
/// text, and they carry the same source / agent / detail as the task's own lines.
#[test]
fn start_and_stop_lines_are_system_lines_with_the_tasks_identity() {
    use agent_studio_scaffold_lib::logstream::tasks::{STARTED_PREFIX, STOPPED_PREFIX};
    assert_eq!(STARTED_PREFIX, "background task started · ");
    assert_eq!(STOPPED_PREFIX, "background task stopped · ");
    let r = Root::new("identity");
    let path = r.tasks.join("bgen1.output");
    std::fs::write(&path, "INFO gazelle: up\n").unwrap();
    let mut tails = r.tails();
    let now = Instant::now();
    let mut all = tails.start(spec(&path, "bgen1"), now);
    all.extend(tails.poll(now));
    all.extend(tails.stop("bgen1", now));
    let kinds: Vec<(LogKind, &str)> = all.iter().map(|l| (l.kind, l.text.as_str())).collect();
    assert_eq!(
        kinds,
        [
            (LogKind::System, "background task started · gazelle (bgen1)"),
            (LogKind::Task, "INFO gazelle: up"),
            (
                LogKind::System,
                "background task stopped · gazelle (bgen1) — stopped by the agent"
            ),
        ]
    );
    let detail = format!("{GAZELLE_CMD}\n{}", path.display());
    for l in &all {
        assert_eq!(l.source, "gazelle · bg", "{}", l.text);
        assert_eq!(l.agent_id.as_deref(), Some("agent-root"), "{}", l.text);
        assert_eq!(l.detail.as_deref(), Some(detail.as_str()), "{}", l.text);
    }
}

#[test]
fn a_session_ending_closes_every_open_tail_through_the_drop_sink() {
    let r = Root::new("session");
    let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LineDraft>::new()));
    let sink = got.clone();
    let slots = TaskSlots::new(MAX_TASK_TAILS);
    let mut tails = TaskTails::new(r.roots(), slots.clone()).on_drop(Box::new(move |lines| {
        sink.lock().unwrap().extend(lines);
    }));
    let now = Instant::now();
    tails.start(spec(&r.tasks.join("a.output"), "ba1"), now);
    tails.start(spec(&r.tasks.join("b.output"), "bb2"), now);
    tails.stop("ba1", now);
    drop(tails);
    let got = got.lock().unwrap();
    assert_eq!(
        texts(&got, LogKind::System),
        ["background task stopped · gazelle (bb2) — session ended"],
        "only the tail still open is closed by the session ending"
    );
    assert_eq!(slots.in_use(), 0);
}

#[test]
fn a_removed_output_file_ends_its_tail() {
    let r = Root::new("gone");
    let path = r.tasks.join("b1.output");
    std::fs::write(&path, "one\n").unwrap();
    let mut tails = r.tails();
    let now = Instant::now();
    tails.start(spec(&path, "b1"), now);
    tails.poll(now);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        texts(&tails.poll(now), LogKind::System),
        ["background task stopped · gazelle (b1) — output file removed"]
    );
    assert!(tails.task_ids().is_empty());
}

#[test]
fn a_late_file_that_escapes_the_root_is_refused_and_closed() {
    let r = Root::new("late-escape");
    let outside = r.base.join("secret.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    let path = r.tasks.join("bmon9.output");
    let mut tails = r.tails();
    let now = Instant::now();
    tails.start(spec(&path, "bmon9"), now);
    // The file appears as a link out of the root.
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    let out = tails.poll(now);
    assert!(texts(&out, LogKind::Task).is_empty(), "never read");
    assert_eq!(
        texts(&out, LogKind::System),
        ["background task stopped · gazelle (bmon9) — not tailed: the file is outside Claude's temp dir"]
    );
    assert_eq!(out[0].level, LogLevel::Warn);
}

#[test]
fn a_truncated_file_is_read_again_from_the_start() {
    let r = Root::new("trunc");
    let path = r.tasks.join("b1.output");
    std::fs::write(&path, "old one\nold two\n").unwrap();
    let mut tails = r.tails();
    let now = Instant::now();
    tails.start(spec(&path, "b1"), now);
    assert_eq!(tails.poll(now).len(), 2);
    std::fs::write(&path, "new\n").unwrap();
    assert_eq!(texts(&tails.poll(now), LogKind::Task), ["new"]);
}

// ── redirects (the `.output` file stays empty) ──────────────────────────────

/// The typical case: the agent redirected the service's output to `gazelle.log` in its
/// scratchpad, so Claude's `.output` file never grows. The redirect target is tailed too,
/// under the redirect's name, on the same slot, with every path in the detail.
#[test]
fn an_empty_output_file_with_a_growing_redirect_target_logs_under_the_redirects_name() {
    let r = Root::new("redirect");
    let output = r.tasks.join("bgen9z8y7.output");
    std::fs::write(&output, "").unwrap();
    let log = r.scratch.join("gazelle.log");
    let cmd = format!(
        "python3 {}/run_local.py APP_ENV=dev > {} 2>&1",
        r.scratch.display(),
        log.display()
    );
    let slots = TaskSlots::new(MAX_TASK_TAILS);
    let mut tails = TaskTails::new(r.roots(), slots.clone());
    let now = Instant::now();
    let out = tails.start(spec_cmd(&output, "bgen9z8y7", &cmd, None), now);
    assert_eq!(
        texts(&out, LogKind::System),
        ["background task started · python3 (bgen9z8y7)"],
        "the start line still names the program"
    );
    assert_eq!(out[0].source, "gazelle · bg");
    assert_eq!(out[0].level, LogLevel::Info);
    assert_eq!(slots.in_use(), 1, "two files, one slot");
    assert_eq!(
        tails.tailed_paths("bgen9z8y7"),
        [output.clone(), log.clone()]
    );
    assert!(
        tails.poll(now).is_empty(),
        "gazelle.log does not exist yet; nothing to read, nothing to say"
    );

    append(
        &log,
        "2026-09-25T09:00:00.000Z  INFO gazelle: connected to MongoDB\n\
         2026-09-25T09:00:01.000Z ERROR gazelle: upstream timeout\n",
    );
    let got = tails.poll(now + Duration::from_secs(1));
    let lines: Vec<(&str, LogLevel, &str)> = got
        .iter()
        .filter(|l| l.kind == LogKind::Task)
        .map(|l| (l.source.as_str(), l.level, l.text.as_str()))
        .collect();
    assert_eq!(
        lines,
        [
            (
                "gazelle · bg",
                LogLevel::Info,
                "2026-09-25T09:00:00.000Z  INFO gazelle: connected to MongoDB"
            ),
            (
                "gazelle · bg",
                LogLevel::Error,
                "2026-09-25T09:00:01.000Z ERROR gazelle: upstream timeout"
            ),
        ]
    );
    let detail = format!("{cmd}\n{}\n{}", output.display(), log.display());
    for l in &got {
        assert_eq!(l.detail.as_deref(), Some(detail.as_str()), "{}", l.text);
        assert_eq!(l.agent_id.as_deref(), Some("agent-root"));
    }
    // The `.output` file is still read when it does grow (the launcher's own words).
    append(&output, "Traceback: run_local.py crashed\n");
    assert_eq!(
        texts(&tails.poll(now + Duration::from_secs(2)), LogKind::Task),
        ["Traceback: run_local.py crashed"]
    );
    // A TaskStop reads both files' last words: the `.output` first, then the redirect.
    append(&log, "bye\n");
    append(&output, "exit 0\n");
    let stopped = tails.stop("bgen9z8y7", now + Duration::from_secs(3));
    assert_eq!(texts(&stopped, LogKind::Task), ["exit 0", "bye"]);
    assert_eq!(
        texts(&stopped, LogKind::System),
        ["background task stopped · python3 (bgen9z8y7) — stopped by the agent"]
    );
    assert_eq!(stopped[0].source, "gazelle · bg");
    assert_eq!(slots.in_use(), 0);
}

/// The same through the transcript: the launch line's `cwd` places a relative
/// `> scratchpad/gazelle.log`, and the lines reach the supervisor's seam as `gazelle · bg`.
#[test]
fn a_relative_redirect_target_is_placed_against_the_transcripts_cwd() {
    let r = Root::new("relative");
    let output = r.tasks.join("bgen9z8y7.output");
    std::fs::write(&output, "").unwrap();
    let log = r.scratch.join("gazelle.log");
    std::fs::write(&log, "INFO gazelle: listening on 0.0.0.0:8080\n").unwrap();
    let tx = r.base.join("sess.jsonl");
    std::fs::write(
        &tx,
        transcript_in("start-redirect.jsonl", &output, &r.session),
    )
    .unwrap();
    let adapter = ClaudeAdapter::new();
    let files = vec![("agent-root".to_string(), tx)];
    let mut tool_tail = TranscriptToolTail::new(0);
    let mut tails = r.tails();
    tool_tail.poll(&files, |l| adapter.parse_tool_line(l));
    let events = tool_tail.take_task_events();
    let cmd = "python3 scratchpad/run_local.py APP_ENV=dev > scratchpad/gazelle.log 2>&1";
    assert_eq!(
        events,
        vec![TaskEvent::Started {
            agent_id: "agent-root".into(),
            task_id: "bgen9z8y7".into(),
            command: cmd.into(),
            output_path: Some(output.clone()),
            cwd: Some(r.session.clone()),
        }],
        "the transcript line's cwd rides along with the launch"
    );
    let got = poll_task_tails(&mut tails, events, |_| None);
    assert_eq!(
        texts(&got, LogKind::Task),
        ["INFO gazelle: listening on 0.0.0.0:8080"]
    );
    assert!(got.iter().all(|l| l.source == "gazelle · bg"), "{got:?}");
    assert_eq!(
        tails.tailed_paths("bgen9z8y7"),
        [output.clone(), log.clone()]
    );
    assert_eq!(
        got[0].detail.as_deref(),
        Some(format!("{cmd}\n{}\n{}", output.display(), log.display()).as_str())
    );
}

#[test]
fn a_redirect_target_outside_the_root_is_refused_with_one_warn_line() {
    let r = Root::new("outside");
    let output = r.tasks.join("b1.output");
    std::fs::write(&output, "").unwrap();
    let elsewhere = r.base.join("work");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let outside = elsewhere.join("server.log");
    let cmd = format!("./target/debug/gazelle serve > {} 2>&1", outside.display());
    let slots = TaskSlots::new(MAX_TASK_TAILS);
    let mut tails = TaskTails::new(r.roots(), slots.clone());
    let now = Instant::now();
    let out = tails.start(spec_cmd(&output, "b1", &cmd, None), now);
    assert_eq!(
        texts(&out, LogKind::System),
        [
            "background task started · gazelle (b1)",
            "not tailing server.log: outside the IDE's temp root",
        ]
    );
    assert_eq!(out[1].level, LogLevel::Warn);
    assert_eq!(
        out[1].source, "server · bg",
        "the name still says what the agent called the log"
    );
    assert_eq!(tails.tailed_paths("b1"), std::slice::from_ref(&output));
    assert_eq!(slots.in_use(), 1);
    // Whatever lands there is never read — now or later — and the warning is not repeated.
    std::fs::write(&outside, "secret\n").unwrap();
    assert!(tails.poll(now).is_empty());
    assert!(tails.poll(now + Duration::from_secs(1)).is_empty());

    // A relative target whose cwd is outside the root is outside too; one with an
    // unexpanded variable cannot be placed at all — and the drawer still lists it.
    let out = tails.start(
        spec_cmd(
            &r.tasks.join("b2.output"),
            "b2",
            "./svc > server.log",
            Some(&elsewhere),
        ),
        now,
    );
    assert_eq!(
        texts(&out, LogKind::System)[1],
        "not tailing server.log: outside the IDE's temp root"
    );
    let b3 = r.tasks.join("b3.output");
    let out = tails.start(
        spec_cmd(&b3, "b3", "./svc > $R/server.log", Some(&r.scratch)),
        now,
    );
    assert_eq!(
        texts(&out, LogKind::System)[1],
        "not tailing server.log: $R/server.log could not be resolved"
    );
    assert_eq!(
        out[0].detail.as_deref(),
        Some(format!("./svc > $R/server.log\n{}\n$R/server.log", b3.display()).as_str())
    );
}

#[test]
fn a_target_named_twice_is_tailed_once() {
    let r = Root::new("twice");
    let output = r.tasks.join("b1.output");
    std::fs::write(&output, "").unwrap();
    let log = r.scratch.join("svc.log");
    // Named as stdout and stderr, then again through tee under a second name — a link
    // inside the root to the same file.
    let link = r.scratch.join("svc-link.log");
    std::os::unix::fs::symlink(&log, &link).unwrap();
    let cmd = format!(
        "./svc > {} 2> {} | tee {}",
        log.display(),
        log.display(),
        link.display()
    );
    let mut tails = r.tails();
    let now = Instant::now();
    let out = tails.start(spec_cmd(&output, "b1", &cmd, None), now);
    assert_eq!(
        texts(&out, LogKind::System),
        ["background task started · svc (b1)"]
    );
    assert_eq!(
        tails.tailed_paths("b1"),
        [output.clone(), log.clone(), link.clone()],
        "the same path twice is one candidate; two names for one file are two until one opens"
    );
    append(&log, "once\n");
    assert_eq!(
        texts(&tails.poll(now), LogKind::Task),
        ["once"],
        "one file, one line — whatever it is called"
    );
    assert_eq!(
        tails.tailed_paths("b1"),
        [output.clone(), log.clone()],
        "the alias was dropped once it resolved to an already-open file"
    );
    append(&log, "twice\n");
    assert_eq!(
        texts(&tails.poll(now + Duration::from_secs(1)), LogKind::Task),
        ["twice"]
    );
}

#[test]
fn a_tasks_files_count_once_against_the_cap_and_a_task_tails_at_most_8_files() {
    assert_eq!(MAX_TASK_FILES, 8);
    let r = Root::new("filecap");
    let slots = TaskSlots::new(MAX_TASK_TAILS);
    let mut tails = TaskTails::new(r.roots(), slots.clone());
    let now = Instant::now();
    for i in 0..16 {
        let cmd = format!(
            "./svc > {s}/a{i}.log 2> {s}/b{i}.log",
            s = r.scratch.display()
        );
        let out = tails.start(
            spec_cmd(
                &r.tasks.join(format!("t{i}.output")),
                &format!("t{i}"),
                &cmd,
                None,
            ),
            now,
        );
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(tails.tailed_paths(&format!("t{i}")).len(), 3);
    }
    assert_eq!(slots.in_use(), 16, "16 tasks, 48 files, 16 slots");
    // Nine targets: with the `.output` file that is ten, and the last two are announced
    // rather than tailed.
    let many: Vec<String> = (0..9)
        .map(|i| format!("> {}/m{i}.log", r.scratch.display()))
        .collect();
    let cmd = format!("./svc {}", many.join(" "));
    let mut b = TaskTails::new(r.roots(), TaskSlots::new(MAX_TASK_TAILS));
    let out = b.start(spec_cmd(&r.tasks.join("m.output"), "m", &cmd, None), now);
    assert_eq!(
        texts(&out, LogKind::System),
        [
            "background task started · svc (m)",
            "not tailing m7.log: a task tails at most 8 files",
            "not tailing m8.log: a task tails at most 8 files",
        ]
    );
    assert_eq!(b.tailed_paths("m").len(), 8);
}

#[test]
fn a_removed_or_refused_file_leaves_the_task_on_its_other_files() {
    let r = Root::new("one-of-two");
    let output = r.tasks.join("b1.output");
    let log = r.scratch.join("svc.log");
    std::fs::write(&log, "log\n").unwrap();
    let cmd = format!("./svc > {}", log.display());
    let mut tails = r.tails();
    let now = Instant::now();
    // The `.output` file is not there yet; the redirect target is.
    tails.start(spec_cmd(&output, "b1", &cmd, None), now);
    assert_eq!(texts(&tails.poll(now), LogKind::Task), ["log"]);
    // It appears as a link out of the root: refused on its own, the task goes on.
    let outside = r.base.join("secret.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    std::os::unix::fs::symlink(&outside, &output).unwrap();
    let out = tails.poll(now);
    assert_eq!(
        texts(&out, LogKind::System),
        ["not tailing b1.output: the file is outside Claude's temp dir"]
    );
    assert_eq!(out[0].level, LogLevel::Warn);
    assert!(texts(&out, LogKind::Task).is_empty(), "never read");
    assert_eq!(tails.tailed_paths("b1"), std::slice::from_ref(&log));
    append(&log, "more\n");
    assert_eq!(texts(&tails.poll(now), LogKind::Task), ["more"]);
    // The last file going ends the task.
    std::fs::remove_file(&log).unwrap();
    assert_eq!(
        texts(&tails.poll(now), LogKind::System),
        ["background task stopped · svc (b1) — output file removed"]
    );
    assert!(tails.task_ids().is_empty());
}

#[test]
fn growth_in_any_of_a_tasks_files_keeps_it_from_idling_out() {
    let r = Root::new("idle-two");
    let output = r.tasks.join("b1.output");
    std::fs::write(&output, "").unwrap();
    let log = r.scratch.join("svc.log");
    std::fs::write(&log, "").unwrap();
    let cmd = format!("./svc > {}", log.display());
    let mut tails = r.tails();
    let t0 = Instant::now();
    tails.start(spec_cmd(&output, "b1", &cmd, None), t0);
    tails.poll(t0);
    // Only the redirect target grows, at 9 min: the whole task's clock resets.
    let t9 = t0 + Duration::from_secs(9 * 60);
    append(&log, "tick\n");
    assert_eq!(texts(&tails.poll(t9), LogKind::Task), ["tick"]);
    assert!(tails
        .poll(t9 + TASK_IDLE_STOP - Duration::from_millis(1))
        .is_empty());
    assert_eq!(
        texts(&tails.poll(t9 + TASK_IDLE_STOP), LogKind::System),
        ["background task stopped · svc (b1) — no output for 10 min"]
    );
}

/// Local integration (`cargo test` must not spawn services): a REAL
/// process under a temp Claude root, tailed while it runs. As an agent typically does,
/// the command itself redirects to a log in the scratchpad, so Claude's `.output` file
/// stays empty and every line comes from — and is named after — `svc.log`.
#[test]
#[ignore = "local integration: runs a real /bin/sh background process"]
fn a_real_background_process_is_tailed_as_task_lines() {
    let r = Root::new("real");
    let path = r.tasks.join("breal01.output");
    let out = std::fs::File::create(&path).unwrap();
    let svc_log = r.scratch.join("svc.log");
    let script = format!(
        r#"for i in 1 2 3; do echo "2026-01-01T12:00:05.152Z  INFO svc: tick $i"; sleep 0.2; done > {} 2>&1"#,
        svc_log.display()
    );
    let mut child = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .stdout(out)
        .spawn()
        .unwrap();
    let mut tails = r.tails();
    let announced = tails.start(
        TaskSpec {
            agent_id: "agent-real".into(),
            task_id: "breal01".into(),
            command: script.clone(),
            path: path.clone(),
            cwd: Some(r.session.clone()),
        },
        Instant::now(),
    );
    assert_eq!(
        texts(&announced, LogKind::System),
        ["background task started · echo (breal01)"]
    );
    assert_eq!(
        tails.tailed_paths("breal01"),
        [path.clone(), svc_log.clone()]
    );
    let mut got: Vec<LineDraft> = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while got.len() < 3 && std::time::Instant::now() < deadline {
        got.extend(
            tails
                .poll(Instant::now())
                .into_iter()
                .filter(|l| l.kind == LogKind::Task),
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = child.wait();
    assert_eq!(
        got.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
        [
            "2026-01-01T12:00:05.152Z  INFO svc: tick 1",
            "2026-01-01T12:00:05.152Z  INFO svc: tick 2",
            "2026-01-01T12:00:05.152Z  INFO svc: tick 3",
        ]
    );
    assert!(got
        .iter()
        .all(|l| l.source == "svc · bg" && l.level == LogLevel::Info));
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        0,
        "the .output file stayed empty: every line came through the redirect"
    );
}
