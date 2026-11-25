//! `agent-studio mcp`: the agent tools as an MCP server, and its install into Claude Code.
//!
//! # The server
//!
//! `agent-studio mcp` speaks MCP over stdio: JSON-RPC 2.0, one message per line. Its tool list is
//! [`registry::all`] — names, descriptions and input schemas generated from the same `ToolSpec`s
//! the command line is generated from — and a `tools/call` is forwarded, unvalidated, to the
//! running app with [`cli::send`], exactly as `agent-studio <group> <verb>` does. The app
//! validates and runs it, so an MCP client gets every tool the CLI has, with the same rules and
//! the same refusals, and a tool another module adds appears here without a line changing.
//!
//! The calls only work for an agent inside an Agent Studio terminal: the address and token of the
//! app's listener travel in that terminal's environment, and Claude Code passes its environment
//! to the stdio servers it starts. Elsewhere the server still answers `initialize` and
//! `tools/list`, so an installed server never shows as broken, and every call says where to run
//! it.
//!
//! stdout carries protocol messages and nothing else; anything for a human goes to stderr.
//!
//! # The install
//!
//! `agent-studio mcp install|uninstall|status`, and the Settings menu item, run Claude Code's own
//! `claude mcp add|remove|get`: Claude writes its own config, and only when the user asks. The
//! app never writes `~/.claude` or `~/.claude.json` itself (LESSONS §1), never installs on its
//! own, and gives launched agents no `--mcp-config` (one mechanism, explicit). The entry points
//! at this binary by absolute path, so the server also starts for a `claude` running outside
//! Agent Studio — where its tools then explain themselves.

use std::io::{self, BufRead, IsTerminal as _, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::cli::{self, CtlEnv};
use super::{registry, CtlCall, CtlResponse};
use crate::agent::claude::ClaudeInvocation;
use crate::agent::hook::{ENV_HOOK_TOKEN, ENV_HOOK_URL, ENV_TERMINAL_ID};
use crate::spawn::NoWindow as _;

/// The command-line word (`agent-studio mcp`), and the argument Claude Code starts the server with.
pub const WORD: &str = "mcp";
/// The server's name in `serverInfo`, and the name it is added to Claude Code under.
pub const SERVER_NAME: &str = "agent-studio";
/// The MCP revisions this server speaks, newest first. A client asking for one of these gets it;
/// any other gets the newest, and decides for itself whether it can speak that.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// What every `tools/call` answers in a process that is not in an Agent Studio terminal.
pub fn outside_message() -> String {
    format!(
        "Agent Studio's tools act in the Agent Studio app that opened this terminal, so they only \
         work for an agent started in one of its terminals: open this from a terminal inside \
         Agent Studio (this process does not carry {ENV_HOOK_URL} / {ENV_HOOK_TOKEN} / \
         {ENV_TERMINAL_ID})."
    )
}

/// What the client is told about the server at `initialize`.
const INSTRUCTIONS: &str = "Agent Studio is the IDE whose terminal this agent runs in. These \
    tools act in the app the user is looking at — its database client and its API client — and \
    what they do shows up there. Use them when the user asks to connect to or query a database, \
    send or save a request, or compare endpoints in Agent Studio. The user's saved secrets \
    (Vault variables, {{…}}) are never returned and cannot be used in a request an agent writes. \
    The tools work only for an agent started in an Agent Studio terminal.";

/// The longest message accepted: the listener's own body cap, so whatever fits there fits here.
const MAX_LINE: usize = 16 * 1024 * 1024;
/// `tools/call`s answered at once. Calls run on their own threads so a slow one (a connection
/// test) does not hold up a `ping`; past this, a new call waits for the oldest.
const MAX_IN_FLIGHT: usize = 16;

// JSON-RPC 2.0 error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// `agent-studio mcp …`, `args` without the `mcp` word. Called from [`cli::run_if_cli`]; returns
/// the exit code.
pub fn main(args: &[String]) -> i32 {
    if args.is_empty() {
        let stdin = io::stdin();
        if stdin.is_terminal() {
            eprintln!(
                "agent-studio mcp: an MCP server on stdin/stdout, for Claude Code to start. \
                 To add it to Claude Code: agent-studio mcp install"
            );
        }
        return match serve(stdin.lock(), io::stdout(), CtlEnv::from_process()) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("agent-studio mcp: {e}");
                1
            }
        };
    }
    command(
        args,
        Claude::resolve(),
        server_exe(),
        &mut io::stdout(),
        &mut io::stderr(),
    )
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

/// Serve MCP on `input`/`output` until `input` ends. `env` is the terminal's link to the app;
/// `None` outside Agent Studio. Returns after every call in flight has been answered.
pub fn serve<R, W>(mut input: R, output: W, env: Option<CtlEnv>) -> io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let out = Arc::new(Mutex::new(output));
    let env = env.map(Arc::new);
    let mut calls: Vec<JoinHandle<()>> = Vec::new();
    while let Some(line) = read_line(&mut input, MAX_LINE)? {
        let step = match line {
            Line::Text(text) => step(&text),
            Line::TooLong => Step::Reply(error(
                Value::Null,
                INVALID_REQUEST,
                &format!("A message must be under {} MB.", MAX_LINE >> 20),
            )),
        };
        match step {
            Step::Quiet => {}
            Step::Reply(message) => write_message(&out, &message)?,
            Step::Call { id, call } => {
                let Some(env) = env.clone() else {
                    write_message(&out, &response(id, text_result(&outside_message(), true)))?;
                    continue;
                };
                calls.retain(|h| !h.is_finished());
                if calls.len() >= MAX_IN_FLIGHT {
                    let _ = calls.remove(0).join();
                }
                let out = out.clone();
                calls.push(std::thread::spawn(move || {
                    let result = call_result(cli::send(&env, &call));
                    let _ = write_message(&out, &response(id, result));
                }));
            }
        }
    }
    for call in calls {
        let _ = call.join();
    }
    Ok(())
}

/// What one incoming message asks of the loop.
#[derive(Debug, Clone, PartialEq)]
enum Step {
    /// A notification, or a response to a request this server never sends: nothing to say.
    Quiet,
    Reply(Value),
    /// A `tools/call` for the app.
    Call {
        id: Value,
        call: CtlCall,
    },
}

fn step(raw: &[u8]) -> Step {
    let raw = raw.trim_ascii();
    if raw.is_empty() {
        return Step::Quiet;
    }
    let message: Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            return Step::Reply(error(
                Value::Null,
                PARSE_ERROR,
                &format!("Parse error: {e}"),
            ))
        }
    };
    // MCP dropped JSON-RPC batches in 2025-06-18; one message per line is an object.
    let Value::Object(message) = message else {
        return Step::Reply(error(
            Value::Null,
            INVALID_REQUEST,
            "Expected one JSON-RPC message (an object) per line.",
        ));
    };
    let id = message.get("id").cloned();
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        if message.contains_key("result") || message.contains_key("error") {
            return Step::Quiet;
        }
        return Step::Reply(error(
            id.unwrap_or(Value::Null),
            INVALID_REQUEST,
            "A request needs a method.",
        ));
    };
    // No id: a notification (`notifications/initialized`, `…/cancelled`), never answered.
    let Some(id) = id else {
        return Step::Quiet;
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    match method {
        "initialize" => Step::Reply(response(id, initialize(params))),
        "ping" => Step::Reply(response(id, json!({}))),
        "tools/list" => Step::Reply(response(id, tool_list())),
        "tools/call" => match tool_call(params) {
            Ok(call) => Step::Call { id, call },
            Err(message) => Step::Reply(error(id, INVALID_PARAMS, &message)),
        },
        other => Step::Reply(error(
            id,
            METHOD_NOT_FOUND,
            &format!("Method not found: {other}"),
        )),
    }
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .and_then(|v| PROTOCOL_VERSIONS.iter().find(|s| **s == v))
        .unwrap_or(&PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {
            "name": SERVER_NAME,
            "title": "Agent Studio",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": INSTRUCTIONS,
    })
}

/// Every tool in the registry, as MCP describes a tool.
pub fn tool_list() -> Value {
    let tools: Vec<Value> = registry::all()
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": registry::description(t),
                "inputSchema": registry::json_schema(t),
            })
        })
        .collect();
    json!({ "tools": tools })
}

/// `{"name", "arguments"}` as the app's request. Only the shape is checked here; the app
/// validates the tool and its arguments, the same way for every front door.
fn tool_call(params: &Value) -> Result<CtlCall, String> {
    let tool = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("tools/call needs the tool's name.")?;
    let args = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err("tools/call arguments must be an object.".to_string()),
    };
    Ok(CtlCall {
        tool: tool.to_string(),
        args,
    })
}

/// The app's reply as a `tools/call` result: the sentence as text, the data as
/// `structuredContent`, and a refusal as `isError`. A transport failure is an error result too,
/// with the sentence the CLI would print, so the agent can tell the user what happened.
pub fn call_result(reply: Result<CtlResponse, String>) -> Value {
    match reply {
        Ok(r) => {
            let mut result = text_result(&r.message, !r.ok);
            if let Some(data) = structured(r.data) {
                result["structuredContent"] = data;
            }
            result
        }
        Err(message) => text_result(&format!("agent-studio: {message}"), true),
    }
}

/// `structuredContent` must be an object: a tool's object is passed as it is, anything else
/// (a list) is kept under `result` rather than dropped. No data, no field.
fn structured(data: Value) -> Option<Value> {
    match data {
        Value::Null => None,
        Value::Object(_) => Some(data),
        other => Some(json!({ "result": other })),
    }
}

fn text_result(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    })
}

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// One message, one line. `serde_json` escapes every newline inside a string, so a message can
/// never span two.
fn write_message<W: Write>(out: &Mutex<W>, message: &Value) -> io::Result<()> {
    let mut line = serde_json::to_vec(message).map_err(io::Error::other)?;
    line.push(b'\n');
    let mut out = out.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    out.write_all(&line)?;
    out.flush()
}

/// One line of input, or the fact that it was longer than allowed (its bytes are dropped as they
/// arrive, so an oversized message never sits in memory).
#[derive(Debug, PartialEq)]
enum Line {
    Text(Vec<u8>),
    TooLong,
}

/// The next line without its `\n`; `None` at the end of the input. A last line without a newline
/// still counts.
fn read_line<R: BufRead>(input: &mut R, max: usize) -> io::Result<Option<Line>> {
    let mut text = Vec::new();
    let mut too_long = false;
    let mut started = false;
    loop {
        let chunk = match input.fill_buf() {
            Ok(c) => c,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            if !started {
                return Ok(None);
            }
            break;
        }
        started = true;
        let newline = chunk.iter().position(|&b| b == b'\n');
        let take = newline.unwrap_or(chunk.len());
        if !too_long {
            if text.len() + take > max {
                too_long = true;
                text = Vec::new();
            } else {
                text.extend_from_slice(&chunk[..take]);
            }
        }
        input.consume(newline.map_or(take, |i| i + 1));
        if newline.is_some() {
            break;
        }
    }
    Ok(Some(if too_long {
        Line::TooLong
    } else {
        Line::Text(text)
    }))
}

// ---------------------------------------------------------------------------------------------
// The install: Claude Code's own `claude mcp add|remove|get`
// ---------------------------------------------------------------------------------------------

/// How long one `claude mcp …` may take. `get` health-checks the server it finds (it starts it
/// and waits up to Claude's own connect timeout, 30 s by default), so this sits above that.
pub const CLAUDE_TIMEOUT: Duration = Duration::from_secs(45);
/// How much of `claude`'s output is kept: plenty for `mcp get`, never a transcript.
const OUTPUT_CAP: usize = 64 * 1024;
/// How much of `claude`'s own words an error repeats.
const DETAIL_CHARS: usize = 200;

/// Claude Code's CLI, ready to run.
#[derive(Debug, Clone)]
pub struct Claude {
    pub invocation: ClaudeInvocation,
    /// Where it runs. The home directory, so the answer is about the user's config and not the
    /// project the app happened to be started in.
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
}

/// What one `claude` run printed.
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    /// `None` when it was killed by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Claude {
    /// The `claude` every other spawn uses: `AGENTSTUDIO_CLAUDE_BIN` first, then `PATH`, then
    /// the known install locations (`agent::claude::resolve_binary`), never a copy of that logic.
    pub fn resolve() -> Result<Self, String> {
        let invocation = crate::agent::claude::resolve_invocation().map_err(|e| e.to_string())?;
        Ok(Self {
            invocation,
            cwd: crate::agent::claude::home_dir(),
            timeout: CLAUDE_TIMEOUT,
        })
    }

    /// Run `claude <args>` with no input, bounded in time and in what is kept of its output.
    pub fn run(&self, args: &[&str]) -> Result<Output, String> {
        let mut cmd = std::process::Command::new(&self.invocation.program);
        cmd.args(&self.invocation.prefix)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window();
        if let Some(dir) = &self.cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Claude Code could not be started ({e})."))?;
        let stdout = drain(child.stdout.take());
        let stderr = drain(child.stderr.take());
        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Claude Code did not answer within {} seconds.",
                        self.timeout.as_secs()
                    ));
                }
                Err(e) => return Err(format!("Claude Code could not be waited for ({e}).")),
            }
        };
        // A grandchild that kept a pipe open must not hold this up past the exit.
        let collect = |rx: mpsc::Receiver<String>| {
            rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
        };
        Ok(Output {
            code: status.code(),
            stdout: collect(stdout),
            stderr: collect(stderr),
        })
    }
}

/// Read a pipe to its end on its own thread, keeping the first [`OUTPUT_CAP`] bytes. It keeps
/// reading past the cap, so the child never blocks on a full pipe.
fn drain<P: Read + Send + 'static>(pipe: Option<P>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut pipe) = pipe {
            let mut buf = [0u8; 8192];
            while let Ok(n @ 1..) = pipe.read(&mut buf) {
                let room = OUTPUT_CAP.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).into_owned());
    });
    rx
}

/// Where Claude Code stands with the `agent-studio` server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpState {
    /// Added, and it runs this app's binary.
    Installed,
    NotInstalled,
    /// An `agent-studio` entry exists but runs something else (another copy of the app).
    Different,
    /// No `claude` to ask.
    ClaudeMissing,
    /// `claude` ran but did not say, or the action failed; the message says why.
    Failed,
}

/// What `status`, `install` and `uninstall` report, to the command line and to the webview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReport {
    /// Whether the action did what was asked; for `status`, whether the state could be read.
    pub ok: bool,
    pub state: McpState,
    pub message: String,
    /// What Claude Code's `agent-studio` entry runs, when there is one.
    pub configured: Option<String>,
    /// The scope Claude Code names for it ("User config (available in all your projects)").
    pub scope: Option<String>,
    /// This app's binary: what `install` points Claude Code at.
    pub exe: String,
}

impl McpReport {
    fn new(ok: bool, state: McpState, exe: &Path, message: impl Into<String>) -> Self {
        Self {
            ok,
            state,
            message: message.into(),
            configured: None,
            scope: None,
            exe: exe.to_string_lossy().into_owned(),
        }
    }

    fn failed(exe: &Path, message: impl Into<String>) -> Self {
        Self::new(false, McpState::Failed, exe, message)
    }

    fn claude_missing(exe: &Path, reason: &str) -> Self {
        Self::new(
            false,
            McpState::ClaudeMissing,
            exe,
            format!("Claude Code was not found: {reason}"),
        )
    }
}

/// The binary Claude Code should start: this one, by absolute path. On Linux an AppImage runs
/// from a mount that disappears when it quits, so the AppImage file itself is what to start.
pub fn server_exe() -> Result<PathBuf, String> {
    let current = std::env::current_exe()
        .map_err(|e| format!("could not tell where this Agent Studio is installed ({e})."))?;
    Ok(exe_for(
        current,
        std::env::var_os("APPIMAGE").map(PathBuf::from),
        cfg!(target_os = "linux"),
    ))
}

fn exe_for(current: PathBuf, appimage: Option<PathBuf>, linux: bool) -> PathBuf {
    match appimage {
        Some(image) if linux && image.is_absolute() && image.is_file() => image,
        _ => current,
    }
}

/// Whether `exe` can be what Claude Code starts from now on.
fn installable(exe: &Path) -> Result<(), String> {
    if !exe.is_absolute() {
        return Err(format!(
            "Agent Studio's own path ({}) is not absolute, so Claude Code could not start it \
             from anywhere else. Nothing was changed.",
            exe.display()
        ));
    }
    if exe.to_string_lossy().contains("/AppTranslocation/") {
        return Err(
            "macOS is running this Agent Studio from a temporary read-only copy (App \
             Translocation) that disappears when it quits. Move Agent Studio to Applications, \
             open it from there, and add it again. Nothing was changed."
                .to_string(),
        );
    }
    Ok(())
}

/// `claude mcp get agent-studio`, read.
pub fn status(claude: &Claude, exe: &Path) -> McpReport {
    match claude.run(&[WORD, "get", SERVER_NAME]) {
        Ok(out) => interpret_get(&out, exe),
        Err(e) => McpReport::failed(exe, format!("Could not ask Claude Code: {e}")),
    }
}

/// Read `claude mcp get`'s answer. Defensive: only the `Scope:`, `Command:` (or `URL:`) and
/// `Args:` lines are read, and an answer without them is reported, not guessed at.
pub fn interpret_get(out: &Output, exe: &Path) -> McpReport {
    if out.code != Some(0) {
        if says_missing(out) {
            return McpReport::new(
                true,
                McpState::NotInstalled,
                exe,
                "Agent Studio is not added to Claude Code. Add it with `agent-studio mcp \
                 install`, or from Agent Studio's Settings menu.",
            );
        }
        return McpReport::failed(
            exe,
            format!(
                "Claude Code could not say whether it has Agent Studio: {}",
                detail(out)
            ),
        );
    }
    let field = |name: &str| {
        out.stdout
            .lines()
            .find_map(|l| l.trim().strip_prefix(name).map(|v| v.trim().to_string()))
    };
    let Some(target) = field("Command:").or_else(|| field("URL:")) else {
        return McpReport::failed(
            exe,
            format!(
                "Claude Code answered in a form Agent Studio could not read: {}",
                detail(out)
            ),
        );
    };
    let args = field("Args:").unwrap_or_default();
    let scope = field("Scope:");
    let mut report = if same_file(&target, exe) && args == WORD {
        McpReport::new(
            true,
            McpState::Installed,
            exe,
            format!(
                "Agent Studio is added to Claude Code{}: it runs `{} {WORD}`.",
                scope
                    .as_deref()
                    .map(|s| format!(" ({s})"))
                    .unwrap_or_default(),
                exe.display()
            ),
        )
    } else {
        McpReport::new(
            true,
            McpState::Different,
            exe,
            format!(
                "Claude Code's `{SERVER_NAME}` server runs `{}`, not this Agent Studio (`{}`). \
                 `agent-studio mcp install` points it here.",
                [target.as_str(), args.as_str()].join(" ").trim_end(),
                exe.display()
            ),
        )
    };
    report.configured = Some(target);
    report.scope = scope;
    report
}

/// Add Agent Studio to Claude Code's user config. An entry that already runs this binary is left
/// alone; one that runs another copy of the app is pointed here.
pub fn install(claude: &Claude, exe: &Path) -> McpReport {
    if let Err(message) = installable(exe) {
        return McpReport::failed(exe, message);
    }
    let exe_text = exe.to_string_lossy();
    let add = || {
        claude.run(&[
            WORD,
            "add",
            "--scope",
            "user",
            SERVER_NAME,
            "--",
            exe_text.as_ref(),
            WORD,
        ])
    };
    let added = |out: Output, message: String| {
        if out.code == Some(0) {
            McpReport::new(true, McpState::Installed, exe, message)
        } else {
            McpReport::failed(exe, format!("Claude Code did not add it: {}", detail(&out)))
        }
    };
    let done = format!(
        "Added Agent Studio to Claude Code (user config): Claude Code now starts `{} {WORD}`. \
         Agents in Agent Studio's terminals get its tools; a running Claude Code session picks \
         them up when it restarts.",
        exe.display()
    );
    let out = match add() {
        Ok(out) => out,
        Err(e) => return McpReport::failed(exe, format!("Could not ask Claude Code: {e}")),
    };
    if out.code == Some(0) || !all_text(&out).contains("already exists") {
        return added(out, done);
    }
    // An `agent-studio` entry is already there: this copy, or another one.
    let now = status(claude, exe);
    match now.state {
        McpState::Installed => McpReport {
            message: format!(
                "Agent Studio was already added to Claude Code (it runs `{} {WORD}`); nothing \
                 was changed.",
                exe.display()
            ),
            ..now
        },
        McpState::Different => {
            let before = now.configured.unwrap_or_default();
            let removed = remove(claude, exe);
            if !removed.ok {
                return removed;
            }
            match add() {
                Ok(out) => added(
                    out,
                    format!(
                        "Claude Code's `{SERVER_NAME}` server ran `{before}`; it now runs `{} \
                         {WORD}`. A running Claude Code session picks it up when it restarts.",
                        exe.display()
                    ),
                ),
                Err(e) => McpReport::failed(exe, format!("Could not ask Claude Code: {e}")),
            }
        }
        _ => McpReport { ok: false, ..now },
    }
}

/// Remove Agent Studio from Claude Code's user config.
pub fn uninstall(claude: &Claude, exe: &Path) -> McpReport {
    remove(claude, exe)
}

fn remove(claude: &Claude, exe: &Path) -> McpReport {
    let out = match claude.run(&[WORD, "remove", "--scope", "user", SERVER_NAME]) {
        Ok(out) => out,
        Err(e) => return McpReport::failed(exe, format!("Could not ask Claude Code: {e}")),
    };
    if out.code == Some(0) {
        McpReport::new(
            true,
            McpState::NotInstalled,
            exe,
            "Removed Agent Studio from Claude Code (user config). A running Claude Code session \
             keeps its tools until it restarts.",
        )
    } else if says_missing(&out) {
        McpReport::new(
            true,
            McpState::NotInstalled,
            exe,
            "Agent Studio was not in Claude Code's user config; nothing was removed.",
        )
    } else {
        McpReport::failed(
            exe,
            format!("Claude Code did not remove it: {}", detail(&out)),
        )
    }
}

/// `claude mcp get|remove` for a name it does not have.
fn says_missing(out: &Output) -> bool {
    all_text(out).contains("No MCP server named")
}

fn all_text(out: &Output) -> String {
    format!("{}\n{}", out.stdout, out.stderr)
}

/// The first line `claude` printed (its error first), cut short: enough to act on, never all of
/// its output.
fn detail(out: &Output) -> String {
    let line = [&out.stderr, &out.stdout]
        .iter()
        .flat_map(|s| s.lines())
        .map(str::trim)
        .find(|l| !l.is_empty());
    let Some(line) = line else {
        return match out.code {
            Some(code) => format!("it exited with code {code} and said nothing."),
            None => "it was stopped before it said anything.".to_string(),
        };
    };
    let mut short: String = line.chars().take(DETAIL_CHARS).collect();
    if short.len() < line.len() {
        short.push('…');
    }
    short
}

/// Whether Claude Code's command is this binary, however each path is spelled.
fn same_file(configured: &str, exe: &Path) -> bool {
    let configured = Path::new(configured);
    configured == exe
        || matches!(
            (std::fs::canonicalize(configured), std::fs::canonicalize(exe)),
            (Ok(a), Ok(b)) if a == b
        )
}

/// One of the three actions, given what it needs, or the report of why it could not run.
fn act(
    action: fn(&Claude, &Path) -> McpReport,
    claude: Result<Claude, String>,
    exe: Result<PathBuf, String>,
) -> McpReport {
    match (claude, exe) {
        (_, Err(e)) => McpReport::failed(Path::new(""), e),
        (Err(e), Ok(exe)) => McpReport::claude_missing(&exe, &e),
        (Ok(claude), Ok(exe)) => action(&claude, &exe),
    }
}

/// `agent-studio mcp install|uninstall|status [--json]`. Prints the report's sentence (stdout
/// when it worked, stderr when not) or, with `--json`, the report. Exit 0 when it worked, 1 when
/// not, 2 for a usage error.
pub fn command(
    args: &[String],
    claude: Result<Claude, String>,
    exe: Result<PathBuf, String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let mut json = false;
    let mut words = Vec::new();
    for a in args {
        match a.as_str() {
            "--json" => json = true,
            "help" | "--help" | "-h" => {
                let _ = write!(out, "{}", usage());
                return 0;
            }
            flag if flag.starts_with('-') => {
                return usage_error(err, &format!("unknown option {flag}"))
            }
            word => words.push(word),
        }
    }
    let action: fn(&Claude, &Path) -> McpReport = match words.as_slice() {
        ["install"] => install,
        ["uninstall"] => uninstall,
        ["status"] => status,
        _ => return usage_error(err, &format!("unknown mcp command `{}`", words.join(" "))),
    };
    let report = act(action, claude, exe);
    if json {
        let _ = writeln!(out, "{}", serde_json::to_value(&report).unwrap_or_default());
    } else if report.ok {
        let _ = writeln!(out, "{}", report.message);
    } else {
        let _ = writeln!(err, "{}", report.message);
    }
    if report.ok {
        0
    } else {
        1
    }
}

fn usage_error(err: &mut dyn Write, message: &str) -> i32 {
    let _ = writeln!(err, "agent-studio: {message}\n");
    let _ = write!(err, "{}", usage());
    2
}

/// The `mcp` commands' help, also appended to `agent-studio help`.
pub fn usage() -> String {
    format!(
        "\n  agent-studio {WORD}\n      Serve these tools over MCP on stdin/stdout: what Claude \
         Code starts once Agent Studio is added to it.\n  agent-studio {WORD} install [--json]\n      \
         Add Agent Studio to Claude Code (runs `claude mcp add --scope user {SERVER_NAME} -- \
         <this app> {WORD}`).\n  agent-studio {WORD} uninstall [--json]\n      Remove it \
         (`claude mcp remove --scope user {SERVER_NAME}`).\n  agent-studio {WORD} status \
         [--json]\n      Whether Claude Code has it, and which copy of the app it runs (`claude \
         mcp get {SERVER_NAME}`).\n"
    )
}

// ---------------------------------------------------------------------------------------------
// The Settings menu item
// ---------------------------------------------------------------------------------------------

/// Run an action off the async runtime: `claude` can take seconds.
async fn off_thread(action: fn(&Claude, &Path) -> McpReport) -> McpReport {
    tauri::async_runtime::spawn_blocking(move || act(action, Claude::resolve(), server_exe()))
        .await
        .unwrap_or_else(|e| McpReport::failed(Path::new(""), format!("The check stopped ({e}).")))
}

/// Whether Claude Code has Agent Studio. Asked when the Settings menu opens, never at startup.
#[tauri::command]
pub async fn claude_mcp_status() -> McpReport {
    off_thread(status).await
}

/// The Settings menu's "Add Agent Studio to Claude Code".
#[tauri::command]
pub async fn claude_mcp_install() -> McpReport {
    off_thread(install).await
}

/// The Settings menu's "Remove Agent Studio from Claude Code".
#[tauri::command]
pub async fn claude_mcp_uninstall() -> McpReport {
    off_thread(uninstall).await
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
