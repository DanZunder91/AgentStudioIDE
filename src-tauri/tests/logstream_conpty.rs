//! Agent Logs on Windows: ConPTY repaints rows with cursor moves, so `logstream::screen`, not
//! the stream splitter, makes the lines. Replays (every OS) use recorded `conpty/*.vt` fixtures;
//! re-record on Windows with `-- --ignored record_conpty_fixtures`.

#[cfg(windows)]
mod common;

use agent_studio_scaffold_lib::logstream::screen::ScreenSplitter;
use agent_studio_scaffold_lib::logstream::splitter::LineSplitter;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/logstream/conpty"
);

/// What a recording holds, in order.
enum Ev {
    /// The PTY size the terminal was spawned with.
    Spawn(u16, u16),
    /// One PTY read.
    Read(Vec<u8>),
    /// The PTY was resized — what the hub learns from the supervisor.
    Resize(u16, u16),
    /// The PTY was silent long enough for the hub's partial-line flush.
    Quiet,
}

fn size(s: &str) -> (u16, u16) {
    let (r, c) = s.split_once('x').unwrap();
    (r.parse().unwrap(), c.parse().unwrap())
}

fn load(name: &str) -> Vec<Ev> {
    let path = format!("{FIXTURES}/{name}");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut evs = Vec::new();
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("< ") {
            evs.push(Ev::Read(unescape(data)));
        } else if let Some(rest) = line.strip_prefix("# spawn ") {
            let (r, c) = size(rest.split(' ').nth(1).unwrap());
            evs.push(Ev::Spawn(r, c));
        } else if let Some(rest) = line.strip_prefix("# resize ") {
            let (r, c) = size(rest);
            evs.push(Ev::Resize(r, c));
        } else if line == "# quiet" {
            evs.push(Ev::Quiet);
        }
    }
    assert!(
        evs.iter().any(|e| matches!(e, Ev::Read(_))),
        "{path} holds no reads"
    );
    evs
}

fn unescape(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            if b.get(i + 1) == Some(&b'\\') {
                out.push(b'\\');
                i += 2;
            } else {
                let hex = std::str::from_utf8(&b[i + 2..i + 4]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                i += 4;
            }
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

/// Replay a recording through the screen splitter the way the hub drives it: the spawn size,
/// every resize, a flush at every silence (`flush_at_quiet`), and a flush at the end (EOF). Fed
/// read by read and — asserted equal — byte by byte, so no line depends on where a read ended.
fn replay(name: &str, flush_at_quiet: bool) -> Vec<String> {
    let evs = load(name);
    let run = |byte_by_byte: bool| {
        let mut sp = ScreenSplitter::new();
        let mut out = Vec::new();
        for ev in &evs {
            match ev {
                Ev::Spawn(r, c) => sp = ScreenSplitter::with_size(*r, *c),
                Ev::Resize(r, c) => sp.resize(*r, *c),
                Ev::Quiet if flush_at_quiet => out.extend(sp.flush_partial()),
                Ev::Quiet => {}
                Ev::Read(bytes) if byte_by_byte => {
                    for b in bytes {
                        out.extend(sp.feed(std::slice::from_ref(b)));
                    }
                }
                Ev::Read(bytes) => out.extend(sp.feed(bytes)),
            }
        }
        out.extend(sp.flush_partial());
        out
    };
    let whole = run(false);
    assert_eq!(
        whole,
        run(true),
        "{name}: the read boundaries changed the lines"
    );
    whole
}

/// The app's lines: flushed at every silence, as the hub does.
fn screen_lines(name: &str) -> Vec<String> {
    replay(name, true)
}

fn count(lines: &[String], needle: &str) -> usize {
    lines.iter().filter(|l| l.as_str() == needle).count()
}

fn assert_no_line_twice(lines: &[String], allowed: &[&str]) {
    let mut seen = std::collections::HashSet::new();
    for l in lines {
        if allowed.contains(&l.as_str()) {
            continue;
        }
        assert!(seen.insert(l.clone()), "logged twice: {l:?} in {lines:#?}");
    }
}

// ── Windows PowerShell 5.1 + PSReadLine ──────────────────────────────────────────────────────────

/// Everything the recording becomes, exactly. The prompt is flushed on its own after a silence
/// (as on Unix) and the command typed after it is the rest of that line; the two resizes at
/// the end (a split pane) add nothing.
#[test]
fn powershell_reads_as_the_screen_did() {
    let lines = screen_lines("powershell.vt");
    let want = [
        r"PS C:\>",
        "Get-Location",
        "Path",
        "----",
        r"C:\",
        r"PS C:\>",
        "ping -n 2 127.0.0.1",
        "Pinging 127.0.0.1 with 32 bytes of data:",
        "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128",
        "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128",
        "Ping statistics for 127.0.0.1:",
        "    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),",
        "Approximate round trip times in milli-seconds:",
        "    Minimum = 0ms, Maximum = 0ms, Average = 0ms",
        r"PS C:\>",
        "exit",
    ];
    assert_eq!(lines, want);
}

/// With no silence at all (every key, every resize back to back), the typed command is still
/// one line — on the prompt's line, since nothing flushed the prompt first.
#[test]
fn a_command_typed_key_by_key_is_logged_once() {
    let lines = replay("powershell.vt", false);
    assert_eq!(count(&lines, r"PS C:\> Get-Location"), 1, "{lines:#?}");
    assert_eq!(
        count(&lines, r"PS C:\> ping -n 2 127.0.0.1"),
        1,
        "{lines:#?}"
    );
    for l in &lines {
        assert!(
            !(l.contains("GeGet") || l.ends_with("Get-Lo") || l.ends_with("> G")),
            "a key-by-key repaint leaked: {l:?} in {lines:#?}"
        );
        if let Some(at) = l.find(r"PS C:\>") {
            assert_eq!(at, 0, "prompt glued to output: {l:?}");
        }
    }
    let replies = lines.iter().filter(|l| l.starts_with("Reply from")).count();
    assert_eq!(
        replies, 2,
        "two replies, each once, a resize between them: {lines:#?}"
    );
}

/// The old splitter, fed the same bytes, is what was on screen — this pins the cause, so the
/// fixture provably exercises the bug and is not a recording ConPTY happened to render plainly.
#[test]
fn the_stream_splitter_garbles_this_recording_which_is_why_windows_needs_the_screen_model() {
    let mut sp = LineSplitter::new();
    let mut lines = Vec::new();
    for ev in load("powershell.vt") {
        if let Ev::Read(bytes) = ev {
            lines.extend(sp.feed(&bytes));
        }
    }
    lines.extend(sp.flush_partial());
    assert!(lines.iter().any(|l| l.contains("GeGetGet-")), "{lines:#?}");
}

/// 40 columns: `'ab'*60` and the statistics line wrap, and a resize to 30 then 100 columns
/// reflows them. Each is one line, logged once.
#[test]
fn wrapped_lines_are_whole_and_a_reflowing_resize_adds_nothing() {
    let lines = screen_lines("powershell-narrow.vt");
    let want = [
        r"PS C:\>",
        "'ab'*60",
        &"ab".repeat(60),
        r"PS C:\>",
        "ping -n 1 127.0.0.1",
        "Pinging 127.0.0.1 with 32 bytes of data:",
        "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128",
        "Ping statistics for 127.0.0.1:",
        "    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),",
        "Approximate round trip times in milli-seconds:",
        "    Minimum = 0ms, Maximum = 0ms, Average = 0ms",
        r"PS C:\>",
        "exit",
    ];
    assert_eq!(lines, want);
    assert_no_line_twice(&replay("powershell-narrow.vt", false), &[]);
}

/// 10 rows: `1..14` scrolls the screen, PSReadLine then repaints the input on the bottom row
/// (a viewport address), and shrinking to 6 rows shifts every line up — the repaint puts `12`
/// on row 1. Nothing is logged twice.
#[test]
fn scrolling_and_a_height_shrinking_resize_log_each_line_once() {
    let lines = screen_lines("powershell-scroll.vt");
    let mut want = vec![r"PS C:\>".to_string(), "1..14".to_string()];
    want.extend((1..=14).map(|n| n.to_string()));
    want.extend([r"PS C:\>", "echo done", "done", r"PS C:\>", "exit"].map(String::from));
    assert_eq!(lines, want);
    assert_no_line_twice(&replay("powershell-scroll.vt", false), &[]);
}

// ── cmd ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn cmd_reads_as_the_screen_did() {
    let lines = screen_lines("cmd.vt");
    let want = [
        "Microsoft Windows [Version 10.0.26300.9974]",
        "(c) Microsoft Corporation. All rights reserved.",
        r"C:\>",
        "echo hello",
        "hello",
        r"C:\>",
        "ping -n 2 127.0.0.1",
        "Pinging 127.0.0.1 with 32 bytes of data:",
        "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128",
        "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128",
        "Ping statistics for 127.0.0.1:",
        "    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),",
        "Approximate round trip times in milli-seconds:",
        "    Minimum = 0ms, Maximum = 0ms, Average = 0ms",
        r"C:\>",
        "exit",
    ];
    assert_eq!(lines, want);
    let raw = replay("cmd.vt", false);
    assert_eq!(count(&raw, r"C:\>echo hello"), 1, "{raw:#?}");
    assert_no_line_twice(&raw, &["Reply from 127.0.0.1: bytes=32 time<1ms TTL=128"]);
}
// ── The real thing: supervisor → ConPTY → hub ────────────────────────────────────────────────────

/// End to end: PowerShell via the real supervisor, `Get-Location` typed key by key, two pane
/// resizes; the command and output are logged once each, no keystroke repaint leaks.
#[cfg(windows)]
#[tokio::test]
async fn a_powershell_terminal_logs_a_typed_command_once_through_the_supervisor() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use agent_studio_scaffold_lib::events::NullSink;
    use agent_studio_scaffold_lib::logstream::{LogHub, LogLine, NullLogSink};
    use agent_studio_scaffold_lib::supervisor::{spawn_supervisor_with_logs, OpenSpec};
    use common::{temp_cwd, wait_for_output, ChannelSink, StubAdapter, TIMEOUT};

    let hub = LogHub::spawn(Arc::new(NullLogSink));
    let sup = spawn_supervisor_with_logs(
        Arc::new(NullSink),
        vec![Arc::new(StubAdapter::interactive())],
        None,
        Some(hub.clone()),
    );
    let id = format!("conpty-{}", ulid::Ulid::new());
    let (out, channel) = ChannelSink::new();
    sup.open_terminal(
        OpenSpec {
            terminal_id: id.clone(),
            program: Some("powershell".into()),
            args: Vec::new(),
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .unwrap();
    let mine = |hub: &LogHub| -> Vec<LogLine> {
        hub.snapshot()
            .into_iter()
            .filter(|l| l.terminal_id.as_deref() == Some(id.as_str()))
            .collect()
    };
    let wait_line = |want: &'static str| {
        let hub = hub.clone();
        let mine = &mine;
        async move {
            let start = Instant::now();
            while !mine(&hub).iter().any(|l| l.text == want) {
                assert!(
                    start.elapsed() < TIMEOUT,
                    "no {want:?} line; got {:#?}",
                    mine(&hub).iter().map(|l| &l.text).collect::<Vec<_>>()
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };

    wait_for_output(&out, "PS ").await;
    tokio::time::sleep(Duration::from_millis(600)).await; // the prompt flushes on its own
    for ch in "Get-Location".chars() {
        sup.write(id.clone(), ch.to_string().into_bytes())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    sup.write(id.clone(), b"\r".to_vec()).await.unwrap();
    wait_line("Path").await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    sup.resize(id.clone(), 20, 40).await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    sup.resize(id.clone(), 30, 100).await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;

    let texts: Vec<String> = mine(&hub).into_iter().map(|l| l.text).collect();
    let _ = tokio::time::timeout(Duration::from_secs(10), sup.close(id.clone())).await;
    let typed = texts
        .iter()
        .filter(|t| *t == "Get-Location" || t.ends_with("> Get-Location"))
        .count();
    assert_eq!(typed, 1, "the typed command, once: {texts:#?}");
    assert!(
        !texts
            .iter()
            .any(|t| t.contains("GeGet") || t.contains("Get-LocationGet")),
        "a keystroke repaint leaked: {texts:#?}"
    );
    assert_eq!(
        texts.iter().filter(|t| *t == "Path").count(),
        1,
        "two resizes re-logged the screen: {texts:#?}"
    );
    assert_eq!(
        texts.iter().filter(|t| *t == "----").count(),
        1,
        "{texts:#?}"
    );
}

// ── The recorder ─────────────────────────────────────────────────────────────────────────────────

/// Record the fixtures above from a real ConPTY. Windows only, `#[ignore]`d (it needs PowerShell
/// and writes into the repo). Every wait has a deadline.
#[cfg(windows)]
#[test]
#[ignore = "recorder: writes tests/fixtures/logstream/conpty/*.vt on Windows"]
fn record_conpty_fixtures() {
    recorder::record_powershell();
    recorder::record_cmd();
    recorder::record_powershell_narrow();
    recorder::record_powershell_scroll();
}

#[cfg(windows)]
mod recorder {
    use std::fmt::Write as _;
    use std::io::Read;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use agent_studio_scaffold_lib::pty::{self, PtyHandle, SpawnSpec};

    const WAIT: Duration = Duration::from_secs(30);
    const PARTIAL_FLUSH_AFTER: Duration = agent_studio_scaffold_lib::logstream::PARTIAL_FLUSH_AFTER;

    struct Rec {
        handle: Option<PtyHandle>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        rx: mpsc::Receiver<Vec<u8>>,
        /// The fixture text so far.
        out: String,
        /// Bytes since the last action — what `wait_for` searches.
        since: Vec<u8>,
    }

    fn system_root_dir() -> PathBuf {
        // `C:\` — no user name in any prompt that ends up in a committed fixture.
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        PathBuf::from(format!("{drive}\\"))
    }

    impl Rec {
        fn start(program: &str, args: Vec<String>, rows: u16, cols: u16, title: &str) -> Self {
            let spawned = pty::spawn_pty(&SpawnSpec {
                program: program.to_string(),
                args,
                cwd: system_root_dir(),
                env: Vec::new(),
                rows,
                cols,
            })
            .expect("spawn");
            let (tx, rx) = mpsc::channel();
            let mut reader = spawned.reader;
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            let mut out = String::new();
            let _ = writeln!(out, "# {title}");
            let _ = writeln!(
                out,
                "# recorded by tests/logstream_conpty.rs::record_conpty_fixtures"
            );
            let _ = writeln!(out, "# spawn {program} {rows}x{cols} in C:\\");
            Self {
                handle: Some(spawned.handle),
                child: spawned.child,
                rx,
                out,
                since: Vec::new(),
            }
        }

        fn h(&mut self) -> &mut PtyHandle {
            self.handle.as_mut().expect("open")
        }

        fn note(&mut self, what: &str) {
            let _ = writeln!(self.out, "# {what}");
        }

        fn take(&mut self, chunk: Vec<u8>) {
            self.out.push_str("< ");
            for &b in &chunk {
                match b {
                    b'\\' => self.out.push_str("\\\\"),
                    0x20..=0x7e => self.out.push(b as char),
                    _ => {
                        let _ = write!(self.out, "\\x{b:02x}");
                    }
                }
            }
            self.out.push('\n');
            self.since.extend_from_slice(&chunk);
        }

        /// Read until `needle` has appeared since the last action, then until the PTY has been
        /// quiet for `settle`.
        fn wait_for(&mut self, needle: &str, settle: Duration) {
            let deadline = Instant::now() + WAIT;
            while !contains(&self.since, needle.as_bytes()) {
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !left.is_zero(),
                    "never saw {needle:?}; tail: {:?}",
                    String::from_utf8_lossy(&self.since[self.since.len().saturating_sub(400)..])
                );
                if let Ok(c) = self.rx.recv_timeout(left.min(Duration::from_millis(200))) {
                    self.take(c);
                }
            }
            self.settle(settle);
        }

        /// Read until the PTY has been quiet for `quiet`. A silence long enough for the hub's
        /// partial-line flush is written down as `# quiet`, so a replay flushes where the app would.
        fn settle(&mut self, quiet: Duration) {
            let deadline = Instant::now() + WAIT;
            while Instant::now() < deadline {
                match self.rx.recv_timeout(quiet) {
                    Ok(c) => self.take(c),
                    Err(_) => {
                        if quiet >= PARTIAL_FLUSH_AFTER {
                            self.note("quiet");
                        }
                        break;
                    }
                }
            }
        }

        /// Paste `text` in one write (no key-by-key repaint wanted).
        fn send(&mut self, text: &str) {
            self.since.clear();
            self.note(&format!("send {text:?}"));
            self.h().write_input(text.as_bytes()).expect("write");
        }

        fn type_keys(&mut self, text: &str) {
            for ch in text.chars() {
                self.since.clear();
                self.note(&format!("type {ch:?}"));
                let mut b = [0u8; 4];
                self.h()
                    .write_input(ch.encode_utf8(&mut b).as_bytes())
                    .expect("write");
                self.settle(Duration::from_millis(120));
            }
        }

        fn enter(&mut self) {
            self.since.clear();
            self.note("type Enter");
            self.h().write_input(b"\r").expect("write");
        }

        fn resize(&mut self, rows: u16, cols: u16) {
            self.note(&format!("resize {rows}x{cols}"));
            self.h().resize(rows, cols).expect("resize");
        }

        fn finish(mut self, file: &str) {
            self.since.clear();
            self.note("type exit + Enter");
            self.h().write_input(b"exit\r").expect("write");
            let deadline = Instant::now() + WAIT;
            loop {
                if let Ok(Some(_)) = self.child.try_wait() {
                    break;
                }
                if Instant::now() > deadline {
                    let _ = self.child.kill();
                    break;
                }
                if let Ok(c) = self.rx.recv_timeout(Duration::from_millis(100)) {
                    self.take(c);
                }
            }
            drop(self.handle.take()); // closes the pseudo-console, so the reader sees EOF
            let deadline = Instant::now() + WAIT;
            while Instant::now() < deadline {
                match self.rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(c) => self.take(c),
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            let path = format!("{}/{file}", super::FIXTURES);
            std::fs::create_dir_all(super::FIXTURES).unwrap();
            std::fs::write(&path, self.out).unwrap();
            eprintln!("wrote {path}");
        }
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    /// Windows PowerShell 5.1 with the IDE's startup args: type `Get-Location`, run `ping`,
    /// resize mid-output (to wrap), then resize twice at the idle prompt.
    pub fn record_powershell() {
        let args = pty::shell_startup_args("powershell", Vec::new(), true);
        let mut r = Rec::start(
            "powershell",
            args,
            24,
            80,
            "Windows PowerShell 5.1 + PSReadLine through ConPTY",
        );
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.type_keys("Get-Location");
        r.enter();
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.type_keys("ping -n 2 127.0.0.1");
        r.enter();
        r.wait_for("Reply from", Duration::from_millis(50));
        r.resize(20, 40);
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.resize(30, 100);
        r.settle(Duration::from_millis(800));
        r.resize(24, 60);
        r.settle(Duration::from_millis(800));
        r.finish("powershell.vt");
    }

    /// cmd: the same shape without PSReadLine.
    pub fn record_cmd() {
        let mut r = Rec::start("cmd.exe", Vec::new(), 24, 80, "cmd through ConPTY");
        r.wait_for("C:\\>", Duration::from_millis(800));
        r.type_keys("echo hello");
        r.enter();
        r.wait_for("C:\\>", Duration::from_millis(800));
        r.type_keys("ping -n 2 127.0.0.1");
        r.enter();
        r.wait_for("Reply from", Duration::from_millis(50));
        r.resize(20, 40);
        r.wait_for("C:\\>", Duration::from_millis(800));
        r.resize(30, 100);
        r.settle(Duration::from_millis(800));
        r.finish("cmd.vt");
    }

    /// A narrow terminal: lines longer than the width wrap (ConPTY leaves them to the terminal's
    /// autowrap), and a resize reflows them.
    pub fn record_powershell_narrow() {
        let args = pty::shell_startup_args("powershell", Vec::new(), true);
        let mut r = Rec::start(
            "powershell",
            args,
            24,
            40,
            "Windows PowerShell 5.1 in a 40-column terminal: wrapped lines and a reflowing resize",
        );
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.send("'ab'*60\r");
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.send("ping -n 1 127.0.0.1\r");
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.resize(24, 30);
        r.settle(Duration::from_millis(800));
        r.resize(24, 100);
        r.settle(Duration::from_millis(800));
        r.finish("powershell-narrow.vt");
    }

    /// A short terminal: output scrolls, PSReadLine then repaints the input on the bottom row
    /// (cursor addresses are viewport rows), and a resize that shrinks the height shifts the
    /// viewport — the repaint puts old lines on different rows.
    pub fn record_powershell_scroll() {
        let args = pty::shell_startup_args("powershell", Vec::new(), true);
        let mut r = Rec::start(
            "powershell",
            args,
            10,
            80,
            "Windows PowerShell 5.1 in a 10-row terminal: scrolling, then a height-shrinking resize",
        );
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.send("1..14\r");
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.type_keys("echo done");
        r.enter();
        r.wait_for("PS C:\\>", Duration::from_millis(800));
        r.resize(6, 80);
        r.settle(Duration::from_millis(800));
        r.resize(12, 80);
        r.settle(Duration::from_millis(800));
        r.finish("powershell-scroll.vt");
    }
}
