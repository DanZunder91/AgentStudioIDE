//! Agent Logs tool events: tails the adapter's transcripts by byte offset (complete lines only; a
//! shorter file is a rewrite, re-read from 0 and silenced by id dedupe). Events before `since_ms`
//! aren't replayed. `BgStarted` counts only on a launch's own result (any output can quote it).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// A result's `detail` keeps at most this many lines of output.
pub const RESULT_DETAIL_LINES: usize = 40;
/// The invocation line that opens a result's `detail` (`$ <command>`) is capped here,
/// separately from the output part: a 2 KiB command is already unreadable in a drawer,
/// and the call's own line keeps the full text.
pub const RESULT_COMMAND_BYTES: usize = 2 * 1024;

/// One tool block, as the adapter read it off a transcript line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolBlock {
    Use {
        id: String,
        /// The tool's name (`Bash`, `Read`, …).
        name: String,
        /// The one-line summary (`Bash: cargo test`).
        summary: String,
        /// Extra context (Bash's `description`, a multi-line command).
        detail: Option<String>,
        ts_ms: Option<i64>,
        /// The full shell command, for a tool that runs one (Bash). Its result's
        /// `detail` opens with `$ <command>` (module doc); `None` = the result opens
        /// with `summary` instead.
        command: Option<String>,
    },
    Result {
        tool_use_id: String,
        /// The output as text (all of it; this module trims it).
        output: String,
        is_error: bool,
        ts_ms: Option<i64>,
    },
    /// This call starts a background task (a `run_in_background` Bash, a `Monitor`).
    /// Emitted alongside the call's [`ToolBlock::Use`].
    BgLaunch {
        id: String,
        /// The full command it runs.
        command: String,
        /// The agent's working directory when it launched (the transcript line's `cwd`):
        /// a relative redirect target in `command` is resolved against it
        /// ([`crate::logstream::tasks::redirect_targets`]).
        cwd: Option<PathBuf>,
    },
    /// This call stops a background task (`TaskStop`, `KillShell`). Takes effect when
    /// its result arrives and is not an error.
    BgStop { id: String, task_id: String },
    /// A result that reports a background task started. Emitted alongside the
    /// result's [`ToolBlock::Result`]; honoured only for a [`ToolBlock::BgLaunch`] call.
    BgStarted {
        tool_use_id: String,
        task_id: String,
        /// From the result's `Output is being written to:`; `None` = the adapter derives it.
        output_path: Option<PathBuf>,
        ts_ms: Option<i64>,
    },
}

/// A background task's lifecycle, as the transcript told it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEvent {
    Started {
        /// The agent whose call launched it.
        agent_id: String,
        task_id: String,
        command: String,
        output_path: Option<PathBuf>,
        /// See [`ToolBlock::BgLaunch::cwd`].
        cwd: Option<PathBuf>,
    },
    Stopped {
        task_id: String,
    },
}

/// A Bash call routing around the capture proxy ([`crate::logstream::bypass::detect`]); it becomes
/// a `bypass` row in Network, so nothing an agent runs goes missing silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BypassEvent {
    pub agent_id: String,
    pub tool_use_id: String,
    pub ts_ms: Option<i64>,
    /// The command, verbatim (nothing is redacted).
    pub command: String,
    pub detected: crate::logstream::bypass::Detected,
}

/// A tool event attributed to the agent whose transcript it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolEvent {
    /// The agent that made the call (a sub-agent for its own calls).
    pub agent_id: String,
    /// The transcript's `tool_use.id` — the same on a call and on its result, which is
    /// how the UI pairs them (`LogLine.toolUseId`).
    pub tool_use_id: String,
    pub ts_ms: Option<i64>,
    /// `false` = a call (`tool`), `true` = its result (`tool-result`).
    pub is_result: bool,
    pub is_error: bool,
    pub text: String,
    pub detail: Option<String>,
}

/// What a result needs to know about its call (module doc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallInfo {
    /// The tool's name (`Bash`, `Read`, …).
    pub name: String,
    /// The line a result's `detail` opens with: `$ <command>` or the call's summary.
    pub invocation: String,
}

/// Incremental, deduping tail over one root's transcript files.
#[derive(Debug)]
pub struct TranscriptToolTail {
    offsets: HashMap<PathBuf, u64>,
    seen_uses: HashSet<String>,
    seen_results: HashSet<String>,
    /// Calls by tool-use id (kept for the session: a result can come long after).
    calls: HashMap<String, CallInfo>,
    since_ms: i64,
    /// Launch calls by tool-use id → their command and the agent's cwd at the time.
    launches: HashMap<String, (String, Option<PathBuf>)>,
    /// Stop calls by tool-use id → the task they stop.
    stops: HashMap<String, String>,
    seen_started: HashSet<String>,
    task_events: Vec<TaskEvent>,
    bypasses: Vec<BypassEvent>,
    /// Whether this machine's PowerShell tool is Windows PowerShell 5.1
    /// ([`crate::logstream::bypass::powershell_tool_is_desktop`]).
    powershell_desktop: bool,
}

/// Claude Code's PowerShell tool (Windows), whose `input.command` is a PowerShell line.
pub const POWERSHELL_TOOL: &str = "PowerShell";

impl TranscriptToolTail {
    /// `since_ms`: events stamped earlier than this are history (seen, not emitted).
    pub fn new(since_ms: i64) -> Self {
        Self {
            offsets: HashMap::new(),
            seen_uses: HashSet::new(),
            seen_results: HashSet::new(),
            calls: HashMap::new(),
            since_ms,
            launches: HashMap::new(),
            stops: HashMap::new(),
            seen_started: HashSet::new(),
            task_events: Vec::new(),
            bypasses: Vec::new(),
            powershell_desktop: crate::logstream::bypass::powershell_tool_is_desktop(),
        }
    }

    /// Read PowerShell tool calls as Windows PowerShell 5.1 (`true`) or PowerShell 7 — the
    /// test seam for [`Self::new`]'s machine-derived default.
    pub fn with_powershell_desktop(mut self, desktop: bool) -> Self {
        self.powershell_desktop = desktop;
        self
    }

    /// The proxy-bypassing Bash calls read since the last call ([`BypassEvent`]).
    pub fn take_bypasses(&mut self) -> Vec<BypassEvent> {
        std::mem::take(&mut self.bypasses)
    }

    /// The background-task starts/stops read since the last call.
    pub fn take_task_events(&mut self) -> Vec<TaskEvent> {
        std::mem::take(&mut self.task_events)
    }

    /// Read what was appended to each `(agent_id, transcript)` since the last poll.
    pub fn poll(
        &mut self,
        files: &[(String, PathBuf)],
        parse: impl Fn(&str) -> Vec<ToolBlock>,
    ) -> Vec<ToolEvent> {
        let mut out = Vec::new();
        for (agent_id, path) in files {
            let Some(chunk) = self.read_appended(path) else {
                continue;
            };
            for line in chunk.lines() {
                for block in parse(line) {
                    if let Some(ev) = self.accept(agent_id, block) {
                        out.push(ev);
                    }
                }
            }
        }
        out
    }

    /// The complete lines appended to `path` since the last read, advancing the offset.
    fn read_appended(&mut self, path: &Path) -> Option<String> {
        let len = std::fs::metadata(path).ok()?.len();
        let offset = self.offsets.entry(path.to_path_buf()).or_insert(0);
        if len < *offset {
            *offset = 0; // rewritten shorter — start over; dedupe keeps it silent
        }
        if len == *offset {
            return None;
        }
        let mut file = std::fs::File::open(path).ok()?;
        file.seek(SeekFrom::Start(*offset)).ok()?;
        let mut buf = Vec::with_capacity((len - *offset) as usize);
        file.take(len - *offset).read_to_end(&mut buf).ok()?;
        // Only whole lines: a live file's last line may still be mid-write.
        let end = buf.iter().rposition(|&b| b == b'\n')? + 1;
        *offset += end as u64;
        buf.truncate(end);
        Some(String::from_utf8_lossy(&buf).into_owned())
    }

    fn accept(&mut self, agent_id: &str, block: ToolBlock) -> Option<ToolEvent> {
        match block {
            ToolBlock::Use {
                id,
                name,
                summary,
                detail,
                ts_ms,
                command,
            } => {
                if !self.seen_uses.insert(id.clone()) {
                    return None;
                }
                // History is not replayed here either: a resumed session's old bypasses
                // are not news. A PowerShell tool call (Claude Code on Windows) is read with
                // PowerShell's rules: its 5.1 web cmdlets ignore the proxy variables.
                if let Some(c) = command.as_deref().filter(|_| !self.is_history(ts_ms)) {
                    let detected = if name == POWERSHELL_TOOL {
                        crate::logstream::bypass::detect_powershell(c, self.powershell_desktop)
                    } else {
                        crate::logstream::bypass::detect(c)
                    };
                    if let Some(detected) = detected {
                        self.bypasses.push(BypassEvent {
                            agent_id: agent_id.to_string(),
                            tool_use_id: id.clone(),
                            ts_ms,
                            command: c.to_string(),
                            detected,
                        });
                    }
                }
                let invocation = match command {
                    Some(c) => format!(
                        "$ {}",
                        crate::logstream::cap_text(c.trim(), RESULT_COMMAND_BYTES)
                    ),
                    None => summary.clone(),
                };
                self.calls.insert(id.clone(), CallInfo { name, invocation });
                if self.is_history(ts_ms) {
                    return None;
                }
                Some(ToolEvent {
                    agent_id: agent_id.to_string(),
                    tool_use_id: id,
                    ts_ms,
                    is_result: false,
                    is_error: false,
                    text: summary,
                    detail,
                })
            }
            ToolBlock::Result {
                tool_use_id,
                output,
                is_error,
                ts_ms,
            } => {
                if !self.seen_results.insert(tool_use_id.clone()) {
                    return None;
                }
                if self.is_history(ts_ms) {
                    return None;
                }
                if let Some(task_id) = self.stops.remove(&tool_use_id) {
                    if !is_error {
                        self.task_events.push(TaskEvent::Stopped { task_id });
                    }
                }
                let (text, detail) = summarize_result(self.calls.get(&tool_use_id), &output);
                Some(ToolEvent {
                    agent_id: agent_id.to_string(),
                    tool_use_id,
                    ts_ms,
                    is_result: true,
                    is_error,
                    text,
                    detail,
                })
            }
            ToolBlock::BgLaunch { id, command, cwd } => {
                self.launches.insert(id, (command, cwd));
                None
            }
            ToolBlock::BgStop { id, task_id } => {
                self.stops.insert(id, task_id);
                None
            }
            ToolBlock::BgStarted {
                tool_use_id,
                task_id,
                output_path,
                ts_ms,
            } => {
                // Only the launch call's own result starts a task (module doc).
                let (command, cwd) = self.launches.get(&tool_use_id)?.clone();
                if !self.seen_started.insert(tool_use_id) || self.is_history(ts_ms) {
                    return None;
                }
                self.task_events.push(TaskEvent::Started {
                    agent_id: agent_id.to_string(),
                    task_id,
                    command,
                    output_path,
                    cwd,
                });
                None
            }
        }
    }

    fn is_history(&self, ts_ms: Option<i64>) -> bool {
        ts_ms.is_some_and(|t| t < self.since_ms)
    }
}

/// `text` = `<Tool> → <first non-blank line>`; `detail` = invocation, blank line, output head.
/// With no known call: `text` is the bare first line, `detail` only for multi-line output.
pub fn summarize_result(call: Option<&CallInfo>, output: &str) -> (String, Option<String>) {
    let first = output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("(no output)");
    let first = crate::logstream::cap_text(first, crate::logstream::splitter::MAX_LINE_BYTES);
    let text = match call {
        Some(c) => format!("{} → {first}", c.name),
        None => first.clone(),
    };
    let total = output.lines().count();
    let non_blank = output.lines().filter(|l| !l.trim().is_empty()).count();
    let output_part = || {
        if non_blank == 0 {
            return first.clone();
        }
        let mut d: String = output
            .lines()
            .take(RESULT_DETAIL_LINES)
            .collect::<Vec<_>>()
            .join("\n");
        if total > RESULT_DETAIL_LINES {
            d.push_str(&format!("\n… ({} more lines)", total - RESULT_DETAIL_LINES));
        }
        crate::logstream::cap_text(&d, crate::logstream::MAX_DETAIL_BYTES)
    };
    let detail = match call {
        Some(c) => Some(format!("{}\n\n{}", c.invocation, output_part())),
        None => (non_blank > 1).then(output_part),
    };
    (text, detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A toy line format (`U id name summary@ts` / `R id err text@ts`) so this module's
    /// offset/dedupe logic is tested apart from any runtime's JSON. A `Bash` call's
    /// command is the summary after `Bash: ` (as the real adapter's summary reads).
    fn parse(line: &str) -> Vec<ToolBlock> {
        let (body, ts) = line.rsplit_once('@').unwrap_or((line, "0"));
        let ts = ts.parse().ok();
        let parts: Vec<&str> = body.splitn(4, ' ').collect();
        match parts.as_slice() {
            ["U", id, name, summary] => vec![ToolBlock::Use {
                id: id.to_string(),
                name: name.to_string(),
                summary: summary.to_string(),
                detail: None,
                ts_ms: ts,
                command: (*name == "Bash").then(|| {
                    summary
                        .strip_prefix("Bash: ")
                        .unwrap_or(summary)
                        .to_string()
                }),
            }],
            ["R", id, err, text] => vec![ToolBlock::Result {
                tool_use_id: id.to_string(),
                output: text.replace("\\n", "\n"),
                is_error: *err == "1",
                ts_ms: ts,
            }],
            _ => vec![],
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tooltail-{}-{name}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("t.jsonl")
    }

    fn append(path: &Path, s: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(s.as_bytes()).unwrap();
    }

    #[test]
    fn only_appended_complete_lines_are_read_and_ids_are_deduped() {
        let p = tmp("append");
        let files = vec![("root".to_string(), p.clone())];
        let mut tail = TranscriptToolTail::new(0);

        append(&p, "U t1 Bash Bash: ls@10\nU t1 Bash Bash: ls@10\n");
        let evs = tail.poll(&files, parse);
        assert_eq!(evs.len(), 1, "a repeated tool_use id is emitted once");
        assert_eq!(evs[0].text, "Bash: ls");
        assert_eq!(evs[0].tool_use_id, "t1");
        assert!(!evs[0].is_result);

        // A torn last line waits for its newline.
        append(&p, "R t1 0 a\\nb@11\nU t2 Read Rea");
        let evs = tail.poll(&files, parse);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].text, "Bash → a");
        assert_eq!(
            evs[0].detail.as_deref(),
            Some("$ ls\n\na\nb"),
            "a shell result opens with the command that produced it"
        );
        assert_eq!(evs[0].tool_use_id, "t1", "the result carries its call's id");
        assert!(evs[0].is_result);

        append(&p, "d: /x@12\nR t2 0 one line@13\n");
        let evs = tail.poll(&files, parse);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].text, "Read: /x");
        assert_eq!(evs[0].tool_use_id, "t2");
        assert_eq!(
            evs[1].detail.as_deref(),
            Some("Read: /x\n\none line"),
            "a non-shell result opens with its call's summary, even for one line of output"
        );

        assert!(
            tail.poll(&files, parse).is_empty(),
            "nothing new, nothing emitted"
        );
    }

    #[test]
    fn a_rewritten_shorter_file_is_reread_silently() {
        let p = tmp("rewrite");
        let files = vec![("root".to_string(), p.clone())];
        let mut tail = TranscriptToolTail::new(0);
        append(&p, "U t1 Bash Bash: one@1\nU t2 Bash Bash: two@2\n");
        assert_eq!(tail.poll(&files, parse).len(), 2);
        // Rewritten shorter, with one genuinely new call.
        std::fs::write(&p, "U t1 Bash Bash: one@1\nU t3 X X@3\n").unwrap();
        let evs = tail.poll(&files, parse);
        assert_eq!(evs.len(), 1, "{evs:?}");
        assert_eq!(evs[0].text, "X");
    }

    #[test]
    fn history_before_since_is_not_replayed() {
        let p = tmp("history");
        let files = vec![("root".to_string(), p.clone())];
        let mut tail = TranscriptToolTail::new(100);
        append(
            &p,
            "U old Bash Bash: old@50\nR old 0 x@51\nU new Bash Bash: new@150\n",
        );
        let evs = tail.poll(&files, parse);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].text, "Bash: new");
    }

    #[test]
    fn an_error_result_is_flagged_and_output_is_capped_at_40_lines() {
        let p = tmp("error");
        let files = vec![("sub".to_string(), p.clone())];
        let mut tail = TranscriptToolTail::new(0);
        let many: Vec<String> = (1..=45).map(|i| format!("l{i}")).collect();
        append(
            &p,
            &format!("U t1 Bash Bash: x@1\nR t1 1 {}@2\n", many.join("\\n")),
        );
        let evs = tail.poll(&files, parse);
        let r = &evs[1];
        assert!(r.is_error);
        assert_eq!(r.agent_id, "sub");
        let detail = r.detail.as_deref().unwrap();
        assert_eq!(
            detail.lines().count(),
            43,
            "the command line, a blank, 40 lines + the '… more' note"
        );
        assert!(detail.ends_with("… (5 more lines)"));
        assert!(detail.starts_with("$ x\n\nl1\nl2\n"), "{detail:?}");
    }

    #[test]
    fn a_result_without_a_known_call_still_reads() {
        assert_eq!(summarize_result(None, "only"), ("only".to_string(), None));
        assert_eq!(
            summarize_result(None, "two\nlines"),
            ("two".to_string(), Some("two\nlines".to_string()))
        );
        let bash = CallInfo {
            name: "Bash".into(),
            invocation: "$ true".into(),
        };
        assert_eq!(
            summarize_result(Some(&bash), "\n\n"),
            (
                "Bash → (no output)".to_string(),
                Some("$ true\n\n(no output)".to_string())
            )
        );
    }

    /// The command half of a result's detail has its own cap; the output half keeps its
    /// 40-line / 16 KiB one, so a long command cannot eat the output's budget.
    #[test]
    fn the_command_part_of_a_result_is_capped_apart_from_the_output() {
        let p = tmp("cap");
        let files = vec![("root".to_string(), p.clone())];
        let mut tail = TranscriptToolTail::new(0);
        let long = "x".repeat(RESULT_COMMAND_BYTES + 100);
        append(
            &p,
            &format!("U t1 Bash Bash: {long}@1\nR t1 0 out\\nput@2\n"),
        );
        let evs = tail.poll(&files, parse);
        let detail = evs[1].detail.as_deref().unwrap();
        let (cmd, out) = detail.split_once("\n\n").unwrap();
        assert!(cmd.starts_with("$ xxx"));
        assert_eq!(
            cmd.len(),
            "$ ".len() + RESULT_COMMAND_BYTES + '…'.len_utf8()
        );
        assert!(cmd.ends_with('…'));
        assert_eq!(out, "out\nput");
    }

    /// A Claude transcript line, shaped exactly like the real CLI writes an assistant
    /// `tool_use` (see tests/fixtures/transcripts), with the command JSON-escaped by serde.
    fn claude_bash_line(id: &str, ts: &str, command: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "cwd": "/Users/dev/gazelle",
            "sessionId": "sess-gazelle",
            "requestId": "req-1",
            "timestamp": ts,
            "message": {
                "id": "msg-1",
                "role": "assistant",
                "model": "claude-opus-5",
                "stop_reason": "tool_use",
                "content": [
                    {"type": "text", "text": "Checking the health endpoint."},
                    {"type": "tool_use", "id": id, "name": "Bash",
                     "input": {"command": command, "description": "Probe the service"}}
                ],
                "usage": {"input_tokens": 4, "output_tokens": 60}
            }
        })
        .to_string()
    }

    /// A gazelle session, through the REAL Claude line parser: the curl that
    /// bypassed the proxy and a python probe given `NO_PROXY='*'` both surface, verbatim; a
    /// plain curl, a replayed id and pre-`since` history do not.
    #[test]
    fn bypassing_bash_calls_are_collected_from_real_transcript_lines() {
        let p = tmp("bypass");
        let files = vec![("agent-gazelle".to_string(), p.clone())];
        // 2026-01-01T10:00:00Z
        let mut tail = TranscriptToolTail::new(1_767_261_600_000);
        let noproxy = "curl -s --noproxy '*' http://127.0.0.1:3000/api/v1/health | head -c 300";
        let py = "cd /Users/dev/gazelle && NO_PROXY='*' python3 scripts/probe.py --port 3000";
        let lines = [
            claude_bash_line("toolu_old", "2026-01-01T09:00:00.000Z", noproxy),
            claude_bash_line("toolu_01", "2026-01-01T10:01:00.000Z", noproxy),
            claude_bash_line("toolu_01", "2026-01-01T10:01:00.000Z", noproxy),
            claude_bash_line(
                "toolu_02",
                "2026-01-01T10:02:00.000Z",
                "curl -s http://127.0.0.1:3000/api/v1/health",
            ),
            claude_bash_line("toolu_03", "2026-01-01T10:03:00.000Z", py),
        ];
        append(&p, &(lines.join("\n") + "\n"));
        let events = tail.poll(&files, crate::agent::claude::parse_tool_line);
        assert_eq!(events.len(), 3, "the three new calls still log: {events:?}");
        let b = tail.take_bypasses();
        let got: Vec<(&str, &str, &[String], bool)> = b
            .iter()
            .map(|e| {
                (
                    e.tool_use_id.as_str(),
                    e.command.as_str(),
                    e.detected.reasons.as_slice(),
                    e.detected.shim_covers,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("toolu_01", noproxy, &["--noproxy".to_string()][..], true),
                ("toolu_03", py, &["NO_PROXY=*".to_string()][..], false),
            ]
        );
        assert!(b.iter().all(|e| e.agent_id == "agent-gazelle"));
        assert_eq!(b[0].ts_ms, Some(1_767_261_660_000));
        let url = b[0].detected.curl.as_ref().unwrap();
        assert_eq!((url.host.as_str(), url.port), ("127.0.0.1", 3000));
        assert!(tail.take_bypasses().is_empty(), "taken once");
        // A rewrite re-read (same ids) is silent here too.
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        let _ = tail.poll(&files, crate::agent::claude::parse_tool_line);
        assert!(tail.take_bypasses().is_empty());
    }

    /// A `PowerShell` tool line exactly as Claude Code on Windows writes it (shape read from
    /// real transcripts: `input` = `command` + `description`, Windows `cwd`).
    fn claude_powershell_line(id: &str, ts: &str, command: &str) -> String {
        let bash = claude_bash_line(id, ts, command);
        let mut v: serde_json::Value = serde_json::from_str(&bash).unwrap();
        v["cwd"] = serde_json::json!(r"C:\Users\dev\gazelle");
        v["message"]["content"][1]["name"] = serde_json::json!("PowerShell");
        v.to_string()
    }

    /// PowerShell 5.1's web cmdlets ignore `HTTP(S)_PROXY` (7's honour it); bash judges the same
    /// text by POSIX rules.
    #[test]
    fn a_powershell_51_web_cmdlet_call_is_a_bypass_and_pwsh_7_is_not() {
        let iwr = "Invoke-WebRequest -Uri http://127.0.0.1:3000/api/v1/health -UseBasicParsing \
                   | Select-Object -ExpandProperty Content";
        let lines = [
            claude_powershell_line("toolu_ps1", "2026-11-18T10:01:00.000Z", iwr),
            claude_powershell_line(
                "toolu_ps2",
                "2026-11-18T10:02:00.000Z",
                "git --version; Get-ChildItem -Force | Select-Object Mode, Name",
            ),
            claude_bash_line("toolu_sh1", "2026-11-18T10:03:00.000Z", iwr),
        ];
        let run = |desktop: bool| {
            let p = tmp(if desktop { "ps-desktop" } else { "ps-core" });
            append(&p, &(lines.join("\n") + "\n"));
            let files = vec![("agent-win".to_string(), p)];
            let mut tail = TranscriptToolTail::new(0).with_powershell_desktop(desktop);
            let events = tail.poll(&files, crate::agent::claude::parse_tool_line);
            assert_eq!(events.len(), 3, "{events:?}");
            tail.take_bypasses()
        };
        let b = run(true);
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!(b[0].tool_use_id, "toolu_ps1");
        assert_eq!(b[0].command, iwr);
        assert_eq!(
            b[0].detected.reasons,
            [crate::logstream::bypass::R_PS51_WEB]
        );
        assert!(!b[0].detected.shim_covers);
        let t = b[0].detected.curl.as_ref().unwrap();
        assert_eq!(
            (t.method.as_str(), t.host.as_str(), t.port, t.path.as_str()),
            ("GET", "127.0.0.1", 3000, "/api/v1/health")
        );
        assert!(
            run(false).is_empty(),
            "PowerShell 7 reads the proxy variables"
        );
    }
}
