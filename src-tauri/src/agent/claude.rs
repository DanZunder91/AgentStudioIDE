//! The Claude Code adapter: the only Claude-specific code in the core (verified against
//! `claude` 2.1.212 on macOS).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context as _, Result};

use super::adapter::{AgentAdapter, AgentSpawn, SessionKey, SpawnRequest};
use crate::agent::fanout::{FanoutAgent, FanoutResult, FanoutStatus};
use crate::agent::hook::{SessionEvent, SessionEventKind, HEADER_TERMINAL, HEADER_TOKEN};
use crate::agent::hook::{ENV_HOOK_TOKEN, ENV_HOOK_URL, ENV_TERMINAL_ID};
use crate::pty::SpawnSpec;

/// `AgentNode.runtime` for this adapter; also the `runtime` arg of `agent_spawn`.
pub const RUNTIME_ID: &str = "claude-code";

/// A stable marker inside our hook command, so a settings-file merge can tell our
/// hook from the user's and stay idempotent + reversible.
const HOOK_MARKER: &str = "agentstudio-hook";

/// User escape hatch for non-standard installs, and the seam tests use to drive a stub.
pub const CLAUDE_BIN_ENV: &str = "AGENTSTUDIO_CLAUDE_BIN";

/// Why the app works when double-clicked: a GUI process doesn't inherit the shell's `PATH`, and
/// the installer's `~/.local/bin` is on none of the defaults. A bare lookup works in dev only.
const KNOWN_INSTALL_PATHS: &[&str] = &[
    ".local/bin/claude",    // official installer (home-relative)
    ".claude/local/claude", // `claude migrate-installer` / local install
];

/// Absolute fallbacks, checked after the home-relative ones. **macOS and Linux only**
/// ([`known_absolute_paths`]).
const KNOWN_ABSOLUTE_PATHS: &[&str] = &[
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude", // Apple-silicon Homebrew
    "/usr/bin/claude",
];

/// None on Windows: `/usr/local/bin/claude` there is `<drive>:\usr\local\bin`, creatable by any
/// user, and the usage strip resolves `claude` every 5 s, so a planted file would run unprompted.
fn known_absolute_paths(windows: bool) -> &'static [&'static str] {
    if windows {
        &[]
    } else {
        KNOWN_ABSOLUTE_PATHS
    }
}

/// `PATH`'s absolute entries. A relative one (`.`, the empty entry of a `;;` or `::`, a
/// drive-less `\bin` on Windows) resolves against the app's working directory, a folder nobody
/// chose to run programs from.
pub(crate) fn absolute_path_dirs(path: &std::ffi::OsStr) -> Vec<PathBuf> {
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .collect()
}

#[derive(Debug, Default, Clone)]
pub struct ClaudeAdapter;

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl AgentAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        RUNTIME_ID
    }

    fn default_title(&self) -> &'static str {
        "claude"
    }

    fn parse_session_event(&self, body: &[u8]) -> Option<SessionEvent> {
        parse_session_event(body)
    }

    fn ad_hoc_hook_settings(&self) -> Option<serde_json::Value> {
        Some(hook_settings())
    }

    fn hook_marker(&self) -> Option<&'static str> {
        Some(HOOK_MARKER)
    }

    fn locate_transcript(
        &self,
        session_id: &str,
    ) -> Option<crate::agent::fanout::TranscriptLocation> {
        locate_transcript(session_id)
    }

    fn parse_fanout(
        &self,
        loc: &crate::agent::fanout::TranscriptLocation,
        root_id: &crate::model::AgentId,
    ) -> FanoutResult {
        parse_fanout(&loc.root_transcript, &loc.subagents_dir, root_id)
    }

    fn tool_transcripts(
        &self,
        loc: &crate::agent::fanout::TranscriptLocation,
        root_id: &crate::model::AgentId,
    ) -> Vec<(crate::model::AgentId, PathBuf)> {
        tool_transcripts(loc, root_id)
    }

    fn parse_tool_line(&self, line: &str) -> Vec<crate::agent::tools::ToolBlock> {
        parse_tool_line(line)
    }

    fn task_output_path(
        &self,
        loc: &crate::agent::fanout::TranscriptLocation,
        task_id: &str,
    ) -> Option<PathBuf> {
        task_output_path(loc, task_id, &crate::logstream::tasks::claude_temp_roots())
    }

    fn spawn(&self, req: &SpawnRequest<'_>) -> Result<AgentSpawn> {
        // An npm `claude.cmd` on Windows becomes `node <cli.js>` here (`invocation_for`):
        // ConPTY's `CreateProcessW` cannot run a batch file, and cmd.exe would re-parse the
        // prompt.
        let claude = resolve_invocation()?;
        // `resume_session_id` comes only when the transcript exists (`claude --resume` errors
        // otherwise); either way `session_key` is what the supervisor binds and tails.
        let (session_key, args) = match req.resume_session_id {
            Some(resume) => (resume.clone(), build_resume_args(resume, req.prompt)),
            None => {
                let key = mint_session_key();
                let args = build_args(&key, req.prompt);
                (key, args)
            }
        };

        Ok(AgentSpawn {
            spec: SpawnSpec {
                args: claude.with_args(args),
                program: claude.program,
                cwd: req.cwd.to_path_buf(),
                env: Vec::new(),
                rows: req.rows,
                cols: req.cols,
            },
            session_key,
        })
    }
}

/// A UUID (`--session-id` requires one), unlike our ULID `AgentId`. ULID bytes are UUIDv7's
/// layout, so stamping the version/variant nibbles gives an RFC 4122 UUID without a `uuid` dep.
/// The stamping is not cosmetic: raw bytes yield invalid nibbles only a lax parser accepts.
fn mint_session_key() -> SessionKey {
    let mut bytes = ulid::Ulid::new().to_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122 (10xx)
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    SessionKey(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// Interactive on purpose (no `-p`): the TUI draws into our PTY. `--session-id` makes
/// `TerminalId ↔ AgentId ↔ SessionKey` a fact (transcript at `projects/<project>/<uuid>.jsonl`).
fn build_args(session_key: &SessionKey, prompt: Option<&str>) -> Vec<String> {
    let mut args = vec!["--session-id".to_string(), session_key.0.clone()];
    // A positional prompt seeds the conversation but keeps the session
    // interactive; `-p` would make it print-and-exit, which is not a terminal.
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) {
        args.push(p.to_string());
    }
    args
}

/// `--resume <id>` continues the same transcript, so the tailer re-anchors. Only reached when it
/// exists on disk; an unknown id exits cleanly. Unverified: that a real resume stays interactive
/// in our PTY needs a live in-app check.
fn build_resume_args(session_key: &SessionKey, prompt: Option<&str>) -> Vec<String> {
    let mut args = vec!["--resume".to_string(), session_key.0.clone()];
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) {
        args.push(p.to_string());
    }
    args
}

/// Payload (claude 2.1.212): `hook_event_name`, `session_id`, `cwd`, and on SessionStart an
/// absolute `transcript_path`, returned verbatim, never computed (`claude` resolves symlinks).
/// `cwd` is where claude actually runs (the user may have `cd`'d).
fn parse_session_event(body: &[u8]) -> Option<SessionEvent> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let kind = match v.get("hook_event_name")?.as_str()? {
        "SessionStart" => SessionEventKind::Start,
        "SessionEnd" => SessionEventKind::End,
        // Turn/activity hooks — the real idle/running signal. All carry
        // `session_id`, so the supervisor can match them to the bound root.
        "UserPromptSubmit" => SessionEventKind::Busy,
        "Stop" => SessionEventKind::Idle,
        "Notification" => SessionEventKind::AwaitingInput,
        _ => return None,
    };
    let session_id = v.get("session_id")?.as_str()?.to_string();
    if session_id.is_empty() {
        return None;
    }
    let transcript_path = v
        .get("transcript_path")
        .and_then(|t| t.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let cwd = v
        .get("cwd")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(SessionEvent {
        kind,
        session_id,
        transcript_path,
        cwd,
    })
}

/// The hook for `<cwd>/.claude/settings.local.json`. Inert unless our env is set, so a leftover
/// file is a no-op elsewhere; `|| true` keeps a dead listener from failing the session. Verified
/// with `claude` 2.1.212.
fn hook_command() -> String {
    // The marker makes the merge idempotent and reversible. `--noproxy '*'` keeps the hook and
    // token off the capture proxy; `AGENTSTUDIO_PROXY_STRICT=0` stops the curl shim dropping it.
    // Changed commands reach installs via settings_merge's in-place upgrade.
    format!(
        "[ -n \"${ENV_HOOK_URL}\" ] && {} || true  # {HOOK_MARKER}",
        hook_post()
    )
}

/// The POST of the hook payload (stdin) to our listener, without the our-env guard, the
/// trailing `|| true` or the marker — shared by [`hook_command`] and
/// [`session_start_hook_command`].
fn hook_post() -> String {
    format!(
        "AGENTSTUDIO_PROXY_STRICT=0 curl --noproxy '*' -sS -m 3 -X POST \"${ENV_HOOK_URL}\" \
         -H \"{HEADER_TOKEN}: ${ENV_HOOK_TOKEN}\" \
         -H \"{HEADER_TERMINAL}: ${ENV_TERMINAL_ID}\" \
         --data-binary @- >/dev/null 2>&1"
    )
}

/// Corrects stale agent advice to strip proxy vars (the proxy never decrypts a client that does
/// not trust it). It has an apostrophe, so the JSON is built with serde and shell-quoted by
/// [`sh_single_quote`], never concatenated.
pub(crate) const PROXY_CONTEXT: &str = "This terminal runs inside Agent Studio. Its HTTP(S) goes \
through Agent Studio's local capture proxy (HTTP_PROXY/HTTPS_PROXY, localhost included) so the \
user can see every request in the Network view. The proxy only decrypts programs that trust its \
certificate; everything else (for example Rust or Go binaries with built-in roots) is tunnelled \
untouched, so it cannot cause TLS UnknownIssuer errors. Do not remove *_proxy variables when \
launching programs, and do not use curl --noproxy, NO_PROXY=* or similar to bypass it, unless \
the user asks. Any older note saying the Agent Studio proxy breaks TLS is out of date. A memory or \
project note that tells you to pass --noproxy, set NO_PROXY=* or strip *_proxy vars is out of \
date: the Agent Studio proxy serves loopback and keeps TLS working. A connection the target \
refuses or cannot be reached fails through the proxy exactly as without it (a transport error, \
never an HTTP 502), so tests that expect a refused connection pass unchanged.";

/// What the `SessionStart` hook tells the agent about the `agent-studio` command
/// (`crate::agent_ctl`). Advice, but here advice is the whole mechanism: the agent has to know the
/// command exists to use it when the user says "connect me to this database".
pub(crate) const TOOLS_CONTEXT: &str = "Agent Studio tools: this terminal has an `agent-studio` \
command that acts on the Agent Studio app itself (also available as the agent-studio MCP server \
when it is configured). Use it when the user asks you to do something in Agent Studio: connect to \
a database (`agent-studio db connect '<connection-url>'`, URL quoted), list, browse or query the \
databases saved there (`agent-studio db list`, …), or open and send HTTP, WebSocket and gRPC \
requests with its API client. Run `agent-studio help` for every command and \
`agent-studio help <command>` for its options. It never prints passwords or Vault secrets, new \
connections are read-only, and an agent cannot use the user's saved secrets.";

/// Everything the `SessionStart` hook adds to the session's context.
pub(crate) fn session_context() -> String {
    format!("{PROXY_CONTEXT}\n\n{TOOLS_CONTEXT}")
}

/// Claude's Bash tool runs from a login-shell snapshot where `path_helper` puts `/usr/bin` ahead
/// of the curl shim, so this `$CLAUDE_ENV_FILE` line re-prepends the shim dir. Written literally
/// (expanded on source), once per file, inert unless both variables are set.
fn env_file_shim_path() -> String {
    env_file_shim_path_for(cfg!(windows))
}

/// The env-file line for macOS and Linux — unchanged since it shipped.
const ENV_FILE_LINE: &str = r#"export PATH="$AGENTSTUDIO_SHIM_DIR:$PATH"  # agentstudio-curl-shim"#;

/// Git Bash would split a Windows `AGENTSTUDIO_SHIM_DIR` at the drive colon, so it is converted
/// with `cygpath -u` when sourced. Guarded both ways, and an `if` (not `&&`) so the file exits 0.
const ENV_FILE_LINE_WINDOWS: &str = r#"if [ -n "${AGENTSTUDIO_SHIM_DIR:-}" ] && command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$AGENTSTUDIO_SHIM_DIR"):$PATH"; export PATH; fi  # agentstudio-curl-shim"#;

/// [`env_file_shim_path`] for a named platform (a parameter, so both are tested everywhere).
fn env_file_shim_path_for(windows: bool) -> String {
    let line = if windows {
        ENV_FILE_LINE_WINDOWS
    } else {
        ENV_FILE_LINE
    };
    format!(
        "{{ [ -z \"$CLAUDE_ENV_FILE\" ] || [ -z \"${SHIM}\" ] || \
         grep -qsF agentstudio-curl-shim \"$CLAUDE_ENV_FILE\" || \
         printf '%s\\n' {line} >> \"$CLAUDE_ENV_FILE\"; }} 2>/dev/null",
        SHIM = crate::netcap::env::SHIM_DIR_VAR,
        line = sh_single_quote(line),
    )
}

/// The `agent-studio` command's directory, put in front of `PATH` for every later Bash command
/// the same way as the curl shim ([`env_file_shim_path`]), and for the same reason (LESSONS §85).
/// Independent of capture: the command works whether or not the proxy is on.
fn env_file_tools_path() -> String {
    env_file_tools_path_for(cfg!(windows))
}

const TOOLS_ENV_FILE_LINE: &str =
    r#"export PATH="$AGENTSTUDIO_TOOLS_DIR:$PATH"  # agentstudio-tools-path"#;

const TOOLS_ENV_FILE_LINE_WINDOWS: &str = r#"if [ -n "${AGENTSTUDIO_TOOLS_DIR:-}" ] && command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$AGENTSTUDIO_TOOLS_DIR"):$PATH"; export PATH; fi  # agentstudio-tools-path"#;

/// [`env_file_tools_path`] for a named platform.
fn env_file_tools_path_for(windows: bool) -> String {
    let line = if windows {
        TOOLS_ENV_FILE_LINE_WINDOWS
    } else {
        TOOLS_ENV_FILE_LINE
    };
    format!(
        "{{ [ -z \"$CLAUDE_ENV_FILE\" ] || [ -z \"${VAR}\" ] || \
         grep -qsF agentstudio-tools-path \"$CLAUDE_ENV_FILE\" || \
         printf '%s\\n' {line} >> \"$CLAUDE_ENV_FILE\"; }} 2>/dev/null",
        VAR = crate::agent_ctl::tools::TOOLS_DIR_VAR,
        line = sh_single_quote(line),
    )
}

/// POSIX single-quote `s` as one shell word (`'` → `'\''`).
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Prints `hookSpecificOutput.additionalContext` JSON (a top-level one is ignored) as the ONLY
/// stdout, even with a dead listener; `; true` since a non-zero exit shows as a hook error.
/// Prints nothing outside our PTYs.
fn session_start_hook_command() -> String {
    let json = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": session_context(),
        }
    })
    .to_string();
    format!(
        "[ -n \"${ENV_HOOK_URL}\" ] && {{ {post}; {shim}; {tools}; printf '%s\\n' {json}; }}; true  # {HOOK_MARKER}",
        post = hook_post(),
        shim = env_file_shim_path(),
        tools = env_file_tools_path(),
        json = sh_single_quote(&json),
    )
}

fn hook_settings() -> serde_json::Value {
    let entry = serde_json::json!({
        "hooks": [ { "type": "command", "command": hook_command() } ]
    });
    // SessionStart also injects the proxy context (see [`PROXY_CONTEXT`]).
    let start = serde_json::json!({
        "hooks": [ { "type": "command", "command": session_start_hook_command() } ]
    });
    // SessionStart/End bind and unbind; the turn events drive status. All share the inert command
    // and marker (idempotent merge) and are workspace-scoped, never ~/.claude.
    serde_json::json!({
        "hooks": {
            "SessionStart":     [ start ],
            "SessionEnd":       [ entry ],
            "UserPromptSubmit": [ entry ],
            "Stop":             [ entry ],
            "Notification":     [ entry ],
        }
    })
}

/// `pub(crate)` so the usage strip resolves `claude` exactly as a spawn does: a second copy would
/// drift, visibly only in a packaged build (the GUI-PATH case), where we don't test.
pub(crate) fn resolve_binary() -> Result<String> {
    // 1. Explicit override always wins.
    if let Some(p) = std::env::var_os(CLAUDE_BIN_ENV) {
        let p = PathBuf::from(p);
        if is_executable(&p) {
            return Ok(p.to_string_lossy().into_owned());
        }
        bail!(
            "{CLAUDE_BIN_ENV} is set to `{}`, which is not an executable file",
            p.display()
        );
    }

    // 2. PATH — correct when launched from a terminal, and on Linux/Windows.
    if let Some(p) = search_path("claude") {
        return Ok(p.to_string_lossy().into_owned());
    }

    // 3. Known install locations — the GUI-launch case.
    if let Some(home) = home_dir() {
        for rel in KNOWN_INSTALL_PATHS {
            let p = home.join(known_install_file(rel, cfg!(windows)));
            if is_executable(&p) {
                return Ok(p.to_string_lossy().into_owned());
            }
        }
    }
    for abs in known_absolute_paths(cfg!(windows)) {
        let p = PathBuf::from(abs);
        if is_executable(&p) {
            return Ok(p.to_string_lossy().into_owned());
        }
    }
    // Windows: npm's global shim, for an app whose PATH lacks `%APPDATA%\npm`.
    if cfg!(windows) {
        if let Some(p) = std::env::var_os("APPDATA")
            .map(|a| PathBuf::from(a).join("npm").join("claude.cmd"))
            .filter(|p| is_executable(p))
        {
            return Ok(p.to_string_lossy().into_owned());
        }
    }

    // Actionable, because this is a normal condition: the user may simply not
    // have Claude Code installed.
    bail!(
        "could not find the `claude` executable. Install Claude Code, or set \
         {CLAUDE_BIN_ENV} to its full path."
    )
}

/// `which(1)`, without spawning anything.
fn search_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    find_in_dirs(
        &absolute_path_dirs(&path),
        &program_file_names(program, cfg!(windows)),
    )
}

/// The first of `names` found in any of `dirs`: every dir is searched for the first name
/// before any is searched for the second — so on Windows a native `claude.exe` anywhere on
/// `PATH` wins over an npm `claude.cmd` shim, which needs `node` and a shim to read.
fn find_in_dirs(dirs: &[PathBuf], names: &[String]) -> Option<PathBuf> {
    names.iter().find_map(|name| {
        dirs.iter()
            .map(|dir| dir.join(name))
            .find(|candidate| is_executable(candidate))
    })
}

/// How to start the resolved `claude`: the program the OS runs and the arguments that go
/// in front of ours. For a native binary `prefix` is empty; for an npm install on Windows
/// it is `node` + the package's script ([`invocation_for`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeInvocation {
    pub program: String,
    pub prefix: Vec<String>,
}

impl ClaudeInvocation {
    /// `prefix` followed by `args` — the whole argv after the program.
    pub fn with_args(&self, args: impl IntoIterator<Item = String>) -> Vec<String> {
        self.prefix.iter().cloned().chain(args).collect()
    }
}

/// [`resolve_binary`], made runnable: every spawn of `claude` (an agent's PTY, the usage
/// probe, the context probe) goes through this, so a `.cmd` never reaches `CreateProcess`.
pub(crate) fn resolve_invocation() -> Result<ClaudeInvocation> {
    let binary = resolve_binary()?;
    invocation_for(Path::new(&binary), cfg!(windows), find_node)
}

/// `node.exe` for an npm shim whose own folder has none (shared: [`crate::winshim::find_node`]).
use crate::winshim::find_node;

/// An npm `claude.cmd` is unwrapped, never run via `cmd.exe`: cmd re-parses the prompt (`%VAR%`,
/// `^&|<>`, newlines), an injection seam. The shim's target runs directly, else the npm package
/// layout, else an error saying what to do ([`crate::winshim::unwrap_npm_shim`]).
pub fn invocation_for(
    binary: &Path,
    windows: bool,
    node: impl FnOnce() -> Option<PathBuf>,
) -> Result<ClaudeInvocation> {
    if !windows || !crate::winshim::is_batch(binary) {
        return Ok(ClaudeInvocation {
            program: binary.to_string_lossy().into_owned(),
            prefix: Vec::new(),
        });
    }
    use crate::winshim::UnwrapError;
    match crate::winshim::unwrap_npm_shim(binary, Some(NPM_CLI_JS), node) {
        Ok(u) => Ok(ClaudeInvocation {
            program: u.program.to_string_lossy().into_owned(),
            prefix: u.prefix,
        }),
        Err(UnwrapError::Read(e)) => {
            Err(e).with_context(|| format!("could not read `{}`", binary.display()))
        }
        Err(UnwrapError::NotAShim) => bail!(
            "`{}` is not an npm shim this app can read, and running it through cmd.exe \
             would let a prompt's `%`, `&` or `^` be interpreted. Install the native Claude \
             Code (claude.exe), or set {CLAUDE_BIN_ENV} to it.",
            binary.display()
        ),
        Err(UnwrapError::NoNode) => bail!(
            "`{}` runs Claude Code with Node.js, and `node.exe` was not found",
            binary.display()
        ),
    }
}

/// The npm package's entry script, relative to the folder holding the global shims.
const NPM_CLI_JS: &str = "node_modules/@anthropic-ai/claude-code/cli.js";

pub use crate::winshim::{parse_cmd_shim, ShimTarget};

/// The installer writes `claude.exe` on Windows; without the extension the fallback never matched.
fn known_install_file(rel: &str, windows: bool) -> String {
    if windows {
        format!("{rel}.exe")
    } else {
        rel.to_string()
    }
}

/// Windows: `.exe`, then npm's `.cmd` shim (a global npm install is only `.cmd` + `.ps1`, and
/// `CreateProcess` cannot run a `.ps1`).
fn program_file_names(program: &str, windows: bool) -> Vec<String> {
    if windows {
        vec![format!("{program}.exe"), format!("{program}.cmd")]
    } else {
        vec![program.to_string()]
    }
}

/// The user's home directory (`$HOME`, or `%USERPROFILE%` on Windows). `pub` so
/// `workspace::default_workspace` can reuse it as its fallback.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// `is_file` matters: a directory named `claude` on PATH would fail at spawn confusingly.
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

// ── Fan-out parsing (M3, ARCHITECTURE §5) ──
// Claims are verified against real transcripts, not the spec (the spawn tool is `Agent`, not
// `TaskCreate`); see [`parse_fanout`] on `subagents/workflows/`.

/// The spawn tool. **`Agent`, never `TaskCreate`** — the latter is a to-do tool. A
/// parser matching `TaskCreate` reconstructs a tree of phantoms.
const SPAWN_TOOL: &str = "Agent";

/// The other spawn tool: `Workflow` fans out a batch at once. Nearly half of measured sidecars
/// belong to one, so knowing only [`SPAWN_TOOL`] loses nearly half the tree.
const WORKFLOW_TOOL: &str = "Workflow";

/// The directory under `<session>/subagents/` that holds one dir per workflow run.
const WORKFLOWS_DIR: &str = "workflows";

/// Every workflow run directory is named `wf_<id>` (measured: every run).
const WORKFLOW_RUN_PREFIX: &str = "wf_";

/// The line inside a `Workflow` `tool_result` that names the run's directory. It is
/// the **only** link between a workflow's sub-agents and the agent that launched
/// them — their sidecars carry neither `toolUseId` nor `parentAgentId`.
const TRANSCRIPT_DIR_LINE: &str = "Transcript dir:";

/// The line in the same `tool_result` carrying the run's one-sentence description —
/// the workflow node's title, since a run has no sidecar of its own.
const SUMMARY_LINE: &str = "Summary:";

/// [`FanoutAgent::kind`] for the synthetic node that stands for a workflow run.
/// Not an `agentType` any sidecar reports: the run is a container, not an agent.
const WORKFLOW_KIND: &str = "workflow";

/// A workflow run's append-only log beside its sidecars: one `started` per sidecar and one
/// `result` per finished sub-agent; the ONLY completion signal these sub-agents have.
const WORKFLOW_JOURNAL: &str = "journal.jsonl";

/// Cap a derived title (the fallback label — see [`Sidecar::title`]).
const SIDECAR_TITLE_MAX: usize = 120;

/// Background launches ack at once (`async_launched`), so that `tool_result` says nothing about
/// the end ([`background_end`]). On CLI 2.1.30x every ordinary `Agent` launch is background.
const BACKGROUND_SHAPE: &str = "background";

/// A background sub-agent silent this long with no end marker counts as finished (a killed parent
/// leaves none). A heuristic: a long tool call reads `Done` until its next line. Shared with
/// `external_agents` so both views agree.
pub const SUBAGENT_STALE_MS: u64 = 5 * 60_000;

/// The tags around one background task's end report in its parent's transcript.
const TASK_NOTIFICATION_OPEN: &str = "<task-notification>";
const TASK_NOTIFICATION_CLOSE: &str = "</task-notification>";

/// The `AgentNode.runtime` label for a Claude sub-agent.
pub const FANOUT_RUNTIME: &str = RUNTIME_ID;

/// Globs `~/.claude/projects/*/` by the unique session id, never computing the dir (symlinks).
/// Matches the root `<id>.jsonl` OR the `<id>/` dir: claude may write only sidecars, and
/// `parse_fanout` tolerates a missing root transcript.
pub fn locate_transcript(session_id: &str) -> Option<crate::agent::fanout::TranscriptLocation> {
    let projects = home_dir()?.join(".claude/projects");
    // Reject anything that isn't a bare id, so we can't be steered outside the dir.
    if session_id.is_empty()
        || session_id.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return None;
    }
    for project in std::fs::read_dir(&projects).ok()?.flatten() {
        let dir = project.path();
        let root_transcript = dir.join(format!("{session_id}.jsonl"));
        let session_dir = dir.join(session_id);
        // Either signal that this project dir hosts the session is enough.
        if root_transcript.is_file() || session_dir.is_dir() {
            return Some(crate::agent::fanout::TranscriptLocation {
                subagents_dir: session_dir.join("subagents"),
                // Returned even if it doesn't exist yet; parse handles absence.
                root_transcript,
            });
        }
    }
    None
}

/// Sidecars: `subagents/` and `subagents/workflows/wf_<run>/`; paths never encode parentage. Edges:
/// sidecar `parentAgentId`, checked against `Agent` tool_use; a workflow run hangs off its launch
/// (else root). Status: foreground `tool_result`, [`background_end`], [`WORKFLOW_JOURNAL`].
pub fn parse_fanout(root_transcript: &Path, subagents_dir: &Path, root_id: &str) -> FanoutResult {
    parse_fanout_at(root_transcript, subagents_dir, root_id, now_ms())
}

/// [`parse_fanout`] as of `now_ms` (epoch ms) — the clock is an input so the
/// silence rule for background sub-agents ([`SUBAGENT_STALE_MS`]) is testable
/// against fixed fixture timestamps.
pub fn parse_fanout_at(
    root_transcript: &Path,
    subagents_dir: &Path,
    root_id: &str,
    now_ms: i64,
) -> FanoutResult {
    let mut scan = SessionScan::default();
    scan_transcript_edges(root_transcript, root_id, &mut scan);

    // Read sidecars + each sub-agent's identity line, and scan each sub-agent's own
    // transcript for the sub-agents *it* spawned (recursion is real and runs deep)
    // and for the background ones it heard end.
    let mut sidecars = read_sidecars(subagents_dir);
    for sc in &mut sidecars {
        sc.last_write = scan_transcript_edges(&sc.transcript, &sc.agent_id, &mut scan);
    }
    let SessionScan {
        tool_owner,
        tool_results,
        launches,
        ends,
    } = scan;

    // Depth of every ordinary sub-agent, so a workflow node can be placed one level
    // below whoever launched it (see the `spawn_depth` note in the loop below).
    let depth_of: HashMap<&str, u32> = sidecars
        .iter()
        .map(|sc| (sc.agent_id.as_str(), sc.spawn_depth.unwrap_or(1)))
        .collect();

    let mut workflow_nodes = Vec::new();
    for run in read_workflow_runs(subagents_dir) {
        let launch = launches.get(&run.run_id);
        // `Workflow tool_use → tool_result → run dir` is the whole edge. Both halves
        // must be present: a result whose tool_use we never saw names no launcher.
        let launcher = launch.and_then(|l| tool_owner.get(&l.tool_use_id));
        let parent_id = launcher.cloned().unwrap_or_else(|| root_id.to_string());
        let parent_depth = if parent_id == root_id {
            0
        } else {
            depth_of.get(parent_id.as_str()).copied().unwrap_or(0)
        };

        let title = match (launcher, launch.map(|l| l.summary.as_str()).unwrap_or("")) {
            (Some(_), summary) if !summary.is_empty() => summary.to_string(),
            (Some(_), _) => format!("Workflow {}", run.run_id),
            // The orphan case, named in the UI rather than hidden.
            (None, _) => format!("Workflow {} (launcher unknown)", run.run_id),
        };
        let launch_failed = launch
            .and_then(|l| tool_results.get(&l.tool_use_id))
            .copied()
            .unwrap_or(false);

        let WorkflowRun {
            run_id,
            sidecars,
            completed,
        } = run;
        let all_done = sidecars.iter().all(|sc| completed.contains(&sc.agent_id));
        // The run has no transcript of its own; borrow its first sub-agent's, which
        // ran in the same place. (The supervisor also inherits from the parent when
        // these are blank, so an empty pair is safe, just less specific.)
        let (cwd, branch) = sidecars
            .first()
            .map(|sc| (sc.cwd.clone(), sc.branch.clone()))
            .unwrap_or_default();

        workflow_nodes.push(FanoutAgent {
            agent_id: run_id.clone(),
            parent_id,
            title,
            kind: WORKFLOW_KIND.to_string(),
            // Strictly below the launcher, so `diff_fanout`'s shallowest-first
            // ordering still emits a parent before its children.
            spawn_depth: Some(parent_depth + 1),
            status: match (launch_failed, all_done) {
                (true, _) => FanoutStatus::Error,
                (false, true) => FanoutStatus::Done,
                (false, false) => FanoutStatus::Running,
            },
            cwd,
            branch,
        });

        for sc in sidecars {
            let status = if completed.contains(&sc.agent_id) {
                FanoutStatus::Done
            } else {
                FanoutStatus::Running
            };
            let title = sc.title();
            // `spawnDepth` here is depth inside the run (1 almost always); honoured so deeper runs
            // place correctly, and `.max(1)` keeps a child below its run node.
            let depth = parent_depth + 1 + sc.spawn_depth.unwrap_or(1).max(1);
            workflow_nodes.push(FanoutAgent {
                agent_id: sc.agent_id,
                parent_id: run_id.clone(),
                title,
                kind: sc.agent_type,
                spawn_depth: Some(depth),
                status,
                cwd: sc.cwd,
                branch: sc.branch,
            });
        }
    }

    let mut result = FanoutResult::default();
    for sc in sidecars {
        let sidecar_parent = sc
            .parent_agent_id
            .clone()
            .unwrap_or_else(|| root_id.to_string());

        // Cross-check against the tool-use edge.
        if let Some(edge_parent) = tool_owner.get(&sc.tool_use_id) {
            if edge_parent != &sidecar_parent {
                result.edge_mismatches.push((
                    sc.agent_id.clone(),
                    sidecar_parent.clone(),
                    edge_parent.clone(),
                ));
            }
        }

        let status = if sc.background {
            background_status(&ends, &sc, now_ms)
        } else {
            match tool_results.get(&sc.tool_use_id) {
                Some(true) => FanoutStatus::Error,
                Some(false) => FanoutStatus::Done,
                None => FanoutStatus::Running,
            }
        };

        let title = sc.title();
        result.agents.push(FanoutAgent {
            agent_id: sc.agent_id,
            parent_id: sidecar_parent, // primary source wins; the mismatch is logged
            title,
            kind: sc.agent_type,
            spawn_depth: sc.spawn_depth,
            status,
            cwd: sc.cwd,
            branch: sc.branch,
        });
    }
    result.agents.append(&mut workflow_nodes);
    // Deterministic order (ids are random; sort so callers/tests are stable).
    result.agents.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    result
}

/// What a `Workflow` `tool_result` tells us about one run: which tool_use announced
/// it (⇒ which agent launched it) and how the run described itself.
struct WorkflowLaunch {
    tool_use_id: String,
    summary: String,
}

/// Everything [`scan_transcript_edges`] gathers across one session's transcripts.
#[derive(Default)]
struct SessionScan {
    /// toolUseId -> the agent whose transcript issued that `Agent`/`Workflow` call
    /// (the parent by the edge derivation). Root transcript's calls own `root_id`.
    tool_owner: HashMap<String, String>,
    /// toolUseId -> is_error, for every answered `Agent`/`Workflow` call (the result
    /// lives in the parent's transcript). For a background launch it is only the
    /// launch ack, and [`parse_fanout_at`] does not read it as an end.
    tool_results: HashMap<String, bool>,
    /// wf_<runId> -> the `Workflow` tool_result that announced it.
    launches: HashMap<String, WorkflowLaunch>,
    /// Every `<task-notification>` in any of the transcripts: how background
    /// sub-agents (at any depth — a child's lands in its parent's transcript) ended.
    ends: TaskEnds,
}

/// Spawns ([`SPAWN_TOOL`], [`WORKFLOW_TOOL`]), results, workflow launches and task notifications,
/// attributed to `owner`; torn lines are skipped. Returns the newest record timestamp, which tells
/// a background sub-agent's resume from its end ([`background_end`]).
fn scan_transcript_edges(path: &Path, owner: &str, scan: &mut SessionScan) -> Option<i64> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return None;
    };
    let mut last_write = None;
    for line in content.lines() {
        // Cheap raw-line pre-filter: the marker survives JSON escaping verbatim; launches are rare.
        let maybe_launch = line.contains(TRANSCRIPT_DIR_LINE);
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // truncated/garbage line — skip (transcript-rewrite safe)
        };
        let at = line_timestamp(&v);
        last_write = last_write.max(at);
        // Before the content check: the first copy of a notification is a
        // `queue-operation`, which has no `message` at all.
        if line.contains(TASK_NOTIFICATION_OPEN) {
            scan.ends.absorb(line, at);
        }
        let Some(content) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("tool_use")
                    if matches!(
                        block.get("name").and_then(|n| n.as_str()),
                        Some(SPAWN_TOOL | WORKFLOW_TOOL)
                    ) =>
                {
                    if let Some(id) = block.get("id").and_then(|i| i.as_str()) {
                        scan.tool_owner.insert(id.to_string(), owner.to_string());
                    }
                }
                Some("tool_result") => {
                    if let Some(id) = block.get("tool_use_id").and_then(|i| i.as_str()) {
                        let is_error = block
                            .get("is_error")
                            .and_then(|e| e.as_bool())
                            .unwrap_or(false);
                        scan.tool_results.insert(id.to_string(), is_error);
                        if maybe_launch {
                            if let Some((run_id, summary)) =
                                parse_workflow_launch(block.get("content"))
                            {
                                scan.launches.insert(
                                    run_id,
                                    WorkflowLaunch {
                                        tool_use_id: id.to_string(),
                                        summary,
                                    },
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    last_write
}

// ── Background sub-agents: how they end (measured on CLI 2.1.309; shared with external_agents) ──

/// One `<task-notification>` block: the task it reports on and how it stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskNotification<'a> {
    pub task_id: String,
    pub status: String,
    /// Byte-identical in every copy of one notification, which tells a copy apart from a SECOND
    /// notification for the same agent.
    pub block: &'a str,
}

/// String search, not JSON: the block sits in various escaped containers and its tags survive.
/// Missing `task-id`/`status` → skipped; a block torn at line end counts if both made it.
pub(crate) fn task_notifications(line: &str) -> Vec<TaskNotification<'_>> {
    let mut out = Vec::new();
    for chunk in line.split(TASK_NOTIFICATION_OPEN).skip(1) {
        let block = chunk
            .split_once(TASK_NOTIFICATION_CLOSE)
            .map_or(chunk, |(block, _)| block);
        if let (Some(task_id), Some(status)) = (tag(block, "task-id"), tag(block, "status")) {
            out.push(TaskNotification {
                task_id,
                status,
                block,
            });
        }
    }
    out
}

/// The trimmed text of the first `<name>…</name>` in `s`; `None` when absent,
/// unclosed or blank.
fn tag(s: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let start = s.find(&open)? + open.len();
    let end = s[start..].find(&format!("</{name}>"))? + start;
    let text = s[start..end].trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// A transcript record's own `timestamp`, in epoch ms. A record that copies an
/// earlier one into a later request (`api-request-blob`) carries none.
pub(crate) fn line_timestamp(v: &serde_json::Value) -> Option<i64> {
    v.get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_iso_millis_opt)
}

/// When a background task last stopped, and whether that stop was a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TaskEnd {
    /// The earliest stamped copy of the notification (≈ the stop); `None` when no
    /// copy carried a timestamp.
    pub at: Option<i64>,
    /// `failed` (or `error`). `completed` and `killed` (stopped by its parent with
    /// `TaskStop`) are not failures of the agent.
    pub failed: bool,
}

/// An agent may notify many times (it can be resumed), and each notification is written several
/// times up to ~10 s apart. So copies merge by block text, an instance stops at its EARLIEST
/// stamped copy, and a task's end is its newest instance (an unstamped one counts as newest).
#[derive(Debug, Default)]
pub(crate) struct TaskEnds {
    /// task id → notification block → that instance's end.
    by_task: HashMap<String, HashMap<String, TaskEnd>>,
}

impl TaskEnds {
    /// Fold every notification in `line`, a record stamped `at`.
    pub(crate) fn absorb(&mut self, line: &str, at: Option<i64>) {
        for n in task_notifications(line) {
            let failed = matches!(n.status.as_str(), "failed" | "error");
            let end = self
                .by_task
                .entry(n.task_id)
                .or_default()
                .entry(n.block.to_string())
                .or_insert(TaskEnd { at, failed });
            end.at = match (end.at, at) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
        }
    }

    /// The task's newest end, if it ever notified. Ties go to a failure, so the
    /// answer never depends on hash order.
    pub(crate) fn latest(&self, task_id: &str) -> Option<TaskEnd> {
        self.by_task
            .get(task_id)?
            .values()
            .copied()
            .max_by_key(|e| (e.at.unwrap_or(i64::MAX), e.failed))
    }
}

/// `None` while it may be working (the caller applies [`SUBAGENT_STALE_MS`]). Ends: the parent's
/// newest notification unless the agent wrote after it (a resume), else sidecar `finished: true`.
/// Never its own last line: a Stop-hook nudge often brings more work.
pub(crate) fn background_end(
    end: Option<TaskEnd>,
    last_write: Option<i64>,
    finished: bool,
) -> Option<bool> {
    if let Some(end) = end {
        let resumed = matches!((end.at, last_write), (Some(stop), Some(wrote)) if wrote > stop);
        if !resumed {
            return Some(end.failed);
        }
    }
    finished.then_some(false)
}

/// A sidecar with no stamped record yet is never stale: it has not started being silent.
fn background_status(ends: &TaskEnds, sc: &Sidecar, now_ms: i64) -> FanoutStatus {
    match background_end(ends.latest(&sc.agent_id), sc.last_write, sc.finished) {
        Some(true) => FanoutStatus::Error,
        Some(false) => FanoutStatus::Done,
        None if sc
            .last_write
            .is_some_and(|w| now_ms.saturating_sub(w) >= SUBAGENT_STALE_MS as i64) =>
        {
            FanoutStatus::Done
        }
        None => FanoutStatus::Running,
    }
}

/// Wall-clock epoch milliseconds (`0` for a clock before 1970).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Only the last segment of `Transcript dir:` is used: the value is an absolute path into the
/// authoring machine's `~/.claude`.
fn parse_workflow_launch(content: Option<&serde_json::Value>) -> Option<(String, String)> {
    let text = brief_tool_result(content);
    let mut run_id = None;
    let mut summary = String::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(TRANSCRIPT_DIR_LINE) {
            let name = rest
                .trim()
                .trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("");
            if name.starts_with(WORKFLOW_RUN_PREFIX) {
                run_id = Some(name.to_string());
            }
        } else if let Some(rest) = line.strip_prefix(SUMMARY_LINE) {
            summary = rest.trim().to_string();
        }
    }
    Some((run_id?, summary))
}

/// One sub-agent's projected facts, gathered from its `.meta.json` + identity line.
struct Sidecar {
    agent_id: String,
    parent_agent_id: Option<String>,
    agent_type: String,
    description: String,
    tool_use_id: String,
    spawn_depth: Option<u32>,
    /// `requestShape == "background"` ([`BACKGROUND_SHAPE`]): its launch's
    /// `tool_result` is an ack, not an end.
    background: bool,
    /// The sidecar's `"finished": true` — see [`background_end`].
    finished: bool,
    /// The newest record timestamp in its own transcript, filled by the edge scan
    /// in [`parse_fanout_at`] (workflow sub-agents are not scanned and keep `None`).
    last_write: Option<i64>,
    cwd: String,
    branch: String,
    /// First line of the task this agent was handed, from its transcript's opening
    /// line. Only ever used as a title fallback — see [`Sidecar::title`].
    prompt: String,
    transcript: PathBuf,
}

impl Sidecar {
    /// `description` wins; workflow sub-agents have none, so: the opening prompt's first line, then
    /// the id. Nothing is invented.
    fn title(&self) -> String {
        if !self.description.is_empty() {
            return self.description.clone();
        }
        if !self.prompt.is_empty() {
            return self.prompt.clone();
        }
        self.agent_id.clone()
    }
}

/// One workflow run: its sidecars plus the completion set from its journal.
struct WorkflowRun {
    run_id: String,
    sidecars: Vec<Sidecar>,
    /// `agentId`s the run's [`WORKFLOW_JOURNAL`] reports a `result` for.
    completed: std::collections::HashSet<String>,
}

/// Runs with no sidecars yet are skipped (a row that can never gain a child is a phantom); they
/// appear on the poll after their first sidecar lands.
fn read_workflow_runs(subagents_dir: &Path) -> Vec<WorkflowRun> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(subagents_dir.join(WORKFLOWS_DIR)) else {
        return out; // no workflows in this session — the common case
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Some(run_id) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !run_id.starts_with(WORKFLOW_RUN_PREFIX) {
            continue;
        }
        let sidecars = read_sidecars(&dir);
        if sidecars.is_empty() {
            continue;
        }
        out.push(WorkflowRun {
            run_id: run_id.to_string(),
            completed: read_workflow_journal(&dir.join(WORKFLOW_JOURNAL)),
            sidecars,
        });
    }
    out
}

/// No journal → empty set, so every sub-agent reads `Running`: the state before any completion.
fn read_workflow_journal(path: &Path) -> std::collections::HashSet<String> {
    let mut done = std::collections::HashSet::new();
    let Ok(content) = std::fs::read_to_string(path) else {
        return done;
    };
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // the journal is appended live; a torn last line is normal
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("result") {
            continue;
        }
        if let Some(id) = v.get("agentId").and_then(|i| i.as_str()) {
            done.insert(id.to_string());
        }
    }
    done
}

/// Not recursive: `read_workflow_runs` enumerates run dirs explicitly, so a future third shape
/// is noticed rather than swept in under the wrong parent.
fn read_sidecars(subagents_dir: &Path) -> Vec<Sidecar> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(subagents_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Drive off the `.meta.json` sidecar (the primary source); pair it with the
        // transcript of the same stem.
        let Some(stem) = name.strip_suffix(".meta.json") else {
            continue;
        };
        let agent_id = stem.strip_prefix("agent-").unwrap_or(stem).to_string();
        let Ok(meta) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta) else {
            continue;
        };

        let transcript = subagents_dir.join(format!("{stem}.jsonl"));
        let (cwd, branch, prompt) = read_identity(&transcript);

        out.push(Sidecar {
            agent_id,
            parent_agent_id: meta
                .get("parentAgentId")
                .and_then(|p| p.as_str())
                .map(str::to_string),
            agent_type: meta
                .get("agentType")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
            description: meta
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string(),
            tool_use_id: meta
                .get("toolUseId")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
            spawn_depth: meta
                .get("spawnDepth")
                .and_then(|d| d.as_u64())
                .map(|d| d as u32),
            background: meta.get("requestShape").and_then(|s| s.as_str()) == Some(BACKGROUND_SHAPE),
            finished: meta.get("finished").and_then(|f| f.as_bool()) == Some(true),
            last_write: None,
            cwd,
            branch,
            prompt,
            transcript,
        });
    }
    // `read_dir` order is unspecified, and a workflow run borrows its first
    // sidecar's cwd/branch — without this the run node's subtitle would depend on
    // the filesystem's whim.
    out.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    out
}

/// Streams only the first line: this runs per sidecar on every poll, over 100 KB+ transcripts.
/// Workflow transcripts open with a `type:"user"` line whose content is the task.
fn read_identity(transcript: &Path) -> (String, String, String) {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(transcript) else {
        return Default::default();
    };
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let cwd = v
            .get("cwd")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let branch = v
            .get("gitBranch")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .to_string();
        // Only a plain-string content is a prompt; a block array is a resumed or
        // tool-carrying turn and makes no sensible one-line label.
        let prompt = first_line_label(
            v.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or(""),
        );
        return (cwd, branch, prompt);
    }
    Default::default()
}

/// The first non-blank line of `text`, capped at [`SIDECAR_TITLE_MAX`] on a char
/// boundary (multi-byte prompts are ordinary), with `…` when it was cut.
fn first_line_label(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.len() <= SIDECAR_TITLE_MAX {
        return line.to_string();
    }
    let mut end = SIDECAR_TITLE_MAX;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &line[..end])
}

// ── Sub-agent activity feed (a sub-agent has no PTY; its transcript is its work) ──

/// Cap each entry's text (~2 KB), so one giant tool result can't bloat the feed.
const ACTIVITY_TEXT_MAX: usize = 2048;

/// Missing or unwritten transcript → empty, never an error (it may have just spawned).
#[tauri::command]
pub fn subagent_activity(agent_id: String) -> Vec<crate::model::ActivityEntry> {
    match locate_subagent_transcript(&agent_id) {
        Some(path) => parse_subagent_activity(&path),
        None => Vec::new(),
    }
}

/// Searched by agent id, never a computed path, in both sidecar shapes (see [`parse_fanout`]):
/// otherwise workflow sub-agents open to an empty feed.
pub fn locate_subagent_transcript(agent_id: &str) -> Option<PathBuf> {
    // Reject anything that isn't a bare id, so a crafted id can't escape the tree.
    if agent_id.is_empty()
        || agent_id.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return None;
    }
    let projects = home_dir()?.join(".claude/projects");
    let filename = format!("agent-{agent_id}.jsonl");

    for project in std::fs::read_dir(&projects).ok()?.flatten() {
        let project = project.path();
        if !project.is_dir() {
            continue;
        }
        // Each project dir holds `<session>.jsonl` files and `<session>/` dirs; the
        // sub-agents live under the session dirs.
        let Ok(sessions) = std::fs::read_dir(&project) else {
            continue;
        };
        for session in sessions.flatten() {
            let subagents = session.path().join("subagents");
            let candidate = subagents.join(&filename);
            if candidate.is_file() {
                return Some(candidate);
            }
            let Ok(runs) = std::fs::read_dir(subagents.join(WORKFLOWS_DIR)) else {
                continue; // no workflows in this session — the common case
            };
            for run in runs.flatten() {
                let candidate = run.path().join(&filename);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// File order is chronological; truncated lines and unknown blocks are skipped, never fatal.
pub fn parse_subagent_activity(transcript: &Path) -> Vec<crate::model::ActivityEntry> {
    use crate::model::ActivityEntry;
    let Ok(content) = std::fs::read_to_string(transcript) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if line_type == "attachment" {
            continue; // pure noise
        }
        let ts = parse_iso_millis(v.get("timestamp").and_then(|t| t.as_str()).unwrap_or(""));
        let message = v.get("message");
        let role = message
            .and_then(|m| m.get("role"))
            .and_then(|r| r.as_str())
            .unwrap_or(line_type);
        let content = message.and_then(|m| m.get("content"));

        match content {
            // A bare-string message is the user's prompt (or an assistant string).
            Some(serde_json::Value::String(s)) => {
                out.push(ActivityEntry {
                    role: if role == "assistant" {
                        "assistant"
                    } else {
                        "user"
                    }
                    .to_string(),
                    text: truncate_text(s),
                    tool: None,
                    timestamp: ts,
                });
            }
            Some(serde_json::Value::Array(blocks)) => {
                for block in blocks {
                    if let Some(entry) = activity_from_block(block, role, ts) {
                        out.push(entry);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Map one content block to an activity entry, or `None` for blocks we skip
/// (`thinking`, and anything unrecognised).
fn activity_from_block(
    block: &serde_json::Value,
    role: &str,
    ts: i64,
) -> Option<crate::model::ActivityEntry> {
    use crate::model::ActivityEntry;
    match block.get("type").and_then(|t| t.as_str())? {
        "text" => Some(ActivityEntry {
            role: if role == "user" { "user" } else { "assistant" }.to_string(),
            text: truncate_text(block.get("text").and_then(|t| t.as_str()).unwrap_or("")),
            tool: None,
            timestamp: ts,
        }),
        "tool_use" => {
            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
            Some(ActivityEntry {
                role: "tool".to_string(),
                text: truncate_text(&brief_tool_input(block.get("input"))),
                tool: Some(name.to_string()),
                timestamp: ts,
            })
        }
        "tool_result" => Some(ActivityEntry {
            role: "tool_result".to_string(),
            text: truncate_text(&brief_tool_result(block.get("content"))),
            tool: None,
            timestamp: ts,
        }),
        // `thinking` (internal reasoning) and anything else: skip.
        _ => None,
    }
}

/// A brief, readable rendering of a tool's input: the most salient string field if
/// there is one (the file read, the command run, …), else compact JSON.
fn brief_tool_input(input: Option<&serde_json::Value>) -> String {
    let Some(obj) = input.and_then(|i| i.as_object()) else {
        return String::new();
    };
    for key in [
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
    ] {
        if let Some(s) = obj.get(key).and_then(|v| v.as_str()) {
            return s.to_string();
        }
    }
    serde_json::to_string(&obj).unwrap_or_default()
}

/// A brief rendering of a `tool_result`'s content, which may be a string or a list
/// of `{type:"text", text}` blocks.
fn brief_tool_result(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
        None => String::new(),
    }
}

/// Truncate to [`ACTIVITY_TEXT_MAX`] bytes on a char boundary, appending `…` if cut.
fn truncate_text(s: &str) -> String {
    if s.len() <= ACTIVITY_TEXT_MAX {
        return s.to_string();
    }
    let mut end = ACTIVITY_TEXT_MAX;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut t = s[..end].to_string();
    t.push('…');
    t
}

/// Parse a Claude ISO-8601 UTC timestamp (`"2026-07-17T05:51:45.178Z"`) to epoch
/// milliseconds. Best-effort: any deviation from the expected shape yields `0`.
fn parse_iso_millis(ts: &str) -> i64 {
    parse_iso_millis_opt(ts).unwrap_or(0)
}

fn parse_iso_millis_opt(ts: &str) -> Option<i64> {
    let (date, time) = ts.trim().split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;

    let time = time.trim_end_matches('Z');
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let min: i64 = t.next()?.parse().ok()?;
    let sec: i64 = t.next()?.parse().ok()?;

    // Fractional seconds → milliseconds: pad/truncate to exactly 3 digits.
    let mut millis_digits: String = frac
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(3)
        .collect();
    while millis_digits.len() < 3 {
        millis_digits.push('0');
    }
    let millis: i64 = millis_digits.parse().ok()?;

    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + (hour * 3600 + min * 60 + sec) * 1000 + millis)
}

/// Days from 1970-01-01 to `y-m-d` (Howard Hinnant's algorithm). Proleptic
/// Gregorian; handles leap years exactly, no external crate.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 }; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

// ── Agent Logs: tool calls off the transcripts ──────────────────────────────

/// Lists directories only, both sidecar shapes. The agent id is the file stem after `agent-`,
/// the same id the fan-out uses.
pub fn tool_transcripts(
    loc: &crate::agent::fanout::TranscriptLocation,
    root_id: &str,
) -> Vec<(String, PathBuf)> {
    let mut out = vec![(root_id.to_string(), loc.root_transcript.clone())];
    let push_dir = |dir: &Path, out: &mut Vec<(String, PathBuf)>| {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut found: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let name = path.file_name()?.to_str()?;
                let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?;
                Some((id.to_string(), path.clone()))
            })
            .collect();
        found.sort();
        out.extend(found);
    };
    push_dir(&loc.subagents_dir, &mut out);
    if let Ok(runs) = std::fs::read_dir(loc.subagents_dir.join(WORKFLOWS_DIR)) {
        let mut runs: Vec<PathBuf> = runs
            .flatten()
            .map(|r| r.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(WORKFLOW_RUN_PREFIX))
            })
            .collect();
        runs.sort();
        for run in runs {
            push_dir(&run, &mut out);
        }
    }
    out
}

/// Summaries: `Bash: <command>`, `<file tool>: <file_path>`, `WebFetch: <url>`,
/// `WebSearch: <query>`, `Grep|Glob: <pattern>`, `Agent|Task: <description>`, else the tool name.
pub fn parse_tool_line(line: &str) -> Vec<crate::agent::tools::ToolBlock> {
    use crate::agent::tools::ToolBlock;
    // Cheap pre-filter: most lines carry no tool block at all, and parsing each one
    // just to find out would dominate the tail's cost.
    if !line.contains("tool_") {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new(); // torn / garbage line
    };
    let ts_ms = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_iso_millis_opt);
    let Some(blocks) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };
    // The agent's working directory when it wrote this line: a background launch's
    // relative redirect target (`> svc.log`) is resolved against it.
    let cwd = v
        .get("cwd")
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .map(PathBuf::from);
    let mut out = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") => {
                let Some(id) = block.get("id").and_then(|i| i.as_str()) else {
                    continue;
                };
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let input = block.get("input");
                let (summary, detail) = summarize_tool_use(name, input);
                // The full command, so the result can open with `$ <command>`; Windows Claude
                // Code's `PowerShell` tool has the same input shape.
                let command = matches!(name, "Bash" | "PowerShell")
                    .then(|| {
                        input
                            .and_then(|i| i.get("command"))
                            .and_then(|c| c.as_str())
                            .map(str::trim)
                            .filter(|c| !c.is_empty())
                            .map(str::to_string)
                    })
                    .flatten();
                out.push(ToolBlock::Use {
                    id: id.to_string(),
                    name: name.to_string(),
                    summary,
                    detail,
                    ts_ms,
                    command,
                });
                if let Some(bg) = background_signal(id, name, input, cwd.clone()) {
                    out.push(bg);
                }
            }
            Some("tool_result") => {
                let Some(id) = block.get("tool_use_id").and_then(|i| i.as_str()) else {
                    continue;
                };
                let output = brief_tool_result(block.get("content"));
                let started = parse_bg_started(&output, v.get("toolUseResult"));
                out.push(ToolBlock::Result {
                    tool_use_id: id.to_string(),
                    output,
                    is_error: block
                        .get("is_error")
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false),
                    ts_ms,
                });
                if let Some((task_id, output_path)) = started {
                    out.push(ToolBlock::BgStarted {
                        tool_use_id: id.to_string(),
                        task_id,
                        output_path,
                        ts_ms,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// The marker Claude puts in a background Bash's result (verified against real
/// transcripts, CLI 2.1.x): `Command running in background with ID: <id>. Output is being
/// written to: <path>. You will be notified when it completes. …`.
const BG_OUTPUT_MARKER: &str = "Output is being written to: ";
/// A `Monitor`'s result: `Monitor started (task <id>, timeout …ms). …` — no path.
const MONITOR_MARKER: &str = "Monitor started (task ";
/// A background Bash's result: `Command running in background with ID: <id>.`
const BG_ID_MARKER: &str = "with ID: ";

/// `Bash` with `run_in_background` or `Monitor` launches; `TaskStop`/`KillShell`/`KillBash`
/// stop. `cwd` resolves a launch's relative redirect targets.
fn background_signal(
    id: &str,
    name: &str,
    input: Option<&serde_json::Value>,
    cwd: Option<PathBuf>,
) -> Option<crate::agent::tools::ToolBlock> {
    use crate::agent::tools::ToolBlock;
    let str_field = |k: &str| {
        input
            .and_then(|i| i.get(k))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    match name {
        "Bash" => {
            let bg = input
                .and_then(|i| i.get("run_in_background"))
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            bg.then(|| ToolBlock::BgLaunch {
                id: id.to_string(),
                command: str_field("command").unwrap_or_default(),
                cwd,
            })
        }
        "Monitor" => Some(ToolBlock::BgLaunch {
            id: id.to_string(),
            command: str_field("command")
                .or_else(|| {
                    input
                        .and_then(|i| i.get("ws"))
                        .and_then(|w| w.get("url"))
                        .and_then(|u| u.as_str())
                        .map(|u| format!("ws {u}"))
                })
                .unwrap_or_default(),
            cwd,
        }),
        "TaskStop" | "KillShell" | "KillBash" => ["task_id", "shell_id", "bash_id"]
            .iter()
            .find_map(|k| str_field(k))
            .filter(|t| !t.trim().is_empty())
            .map(|task_id| ToolBlock::BgStop {
                id: id.to_string(),
                task_id,
            }),
        _ => None,
    }
}

/// Path and id read off the text (the id falls back to `toolUseResult`, then the file stem);
/// whether the result belongs to a launch is the tail's call.
fn parse_bg_started(
    output: &str,
    tool_use_result: Option<&serde_json::Value>,
) -> Option<(String, Option<PathBuf>)> {
    let path = output.find(BG_OUTPUT_MARKER).and_then(|at| {
        let rest = &output[at + BG_OUTPUT_MARKER.len()..];
        // The file is always `<id>.output`, so the path ends there — which keeps a temp dir
        // with a space in it whole (`C:\Users\Dev User\AppData\Local\Temp\claude\…`).
        // Without that suffix on the line, the first word, as before.
        let line = rest.lines().next().unwrap_or("");
        let raw = match line.find(".output") {
            Some(end) => line[..end + ".output".len()].trim(),
            None => rest.split_whitespace().next()?,
        };
        let raw = raw.trim_end_matches(['.', ',', ';']);
        (!raw.is_empty()).then(|| PathBuf::from(raw))
    });
    let word_after = |marker: &str| {
        output.find(marker).and_then(|at| {
            let id: String = output[at + marker.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            (!id.is_empty()).then_some(id)
        })
    };
    let from_json = || {
        ["backgroundTaskId", "taskId"].iter().find_map(|k| {
            tool_use_result
                .and_then(|t| t.get(*k))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
    };
    let monitor = output.contains(MONITOR_MARKER);
    if path.is_none() && !monitor {
        return None;
    }
    let task_id = word_after(BG_ID_MARKER)
        .or_else(|| word_after(MONITOR_MARKER))
        .or_else(from_json)
        .or_else(|| {
            path.as_deref()
                .and_then(|p| p.file_stem())
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })?;
    Some((task_id, path))
}

/// `<claude temp>/<project>/<session>/tasks/<task>.output` (verified, CLI 2.1.x); creates nothing.
/// On Windows the project level is a 16-hex hash, so the session dir is searched for by name.
pub fn task_output_path(
    loc: &crate::agent::fanout::TranscriptLocation,
    task_id: &str,
    roots: &[PathBuf],
) -> Option<PathBuf> {
    let session = loc.root_transcript.file_stem()?.to_str()?;
    let project = loc.root_transcript.parent()?.file_name()?.to_str()?;
    if task_id.is_empty() || task_id.contains(['/', '\\']) || task_id.starts_with('.') {
        return None;
    }
    let file = format!("{task_id}.output");
    let named = |root: &PathBuf| root.join(project).join(session);
    let found = roots
        .iter()
        .map(named)
        .find(|d| d.is_dir())
        .or_else(|| roots.iter().find_map(|r| session_dir_anywhere(r, session)));
    let dir = found.or_else(|| roots.first().map(named))?;
    Some(dir.join("tasks").join(file))
}

/// `<root>/<any>/<session>` when exactly that directory exists — the first in name order,
/// so the answer is deterministic. One `read_dir` of the root.
fn session_dir_anywhere(root: &Path, session: &str) -> Option<PathBuf> {
    let mut hits: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path().join(session))
        .filter(|d| d.is_dir())
        .collect();
    hits.sort();
    hits.into_iter().next()
}

/// `(summary, detail)` for one `tool_use` — see [`parse_tool_line`].
fn summarize_tool_use(name: &str, input: Option<&serde_json::Value>) -> (String, Option<String>) {
    let field = |k: &str| {
        input
            .and_then(|i| i.get(k))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let key = match name {
        "Bash" => "command",
        "Edit" | "Write" | "Read" | "MultiEdit" => "file_path",
        "NotebookEdit" => "notebook_path",
        "WebFetch" => "url",
        "WebSearch" => "query",
        "Grep" | "Glob" => "pattern",
        SPAWN_TOOL | "Task" => "description",
        _ => return (name.to_string(), None),
    };
    let Some(value) = field(key) else {
        return (name.to_string(), None);
    };
    let first = value.lines().next().unwrap_or("");
    let multi_line = value.lines().nth(1).is_some();
    let summary = crate::logstream::cap_text(
        &format!("{name}: {first}{}", if multi_line { " …" } else { "" }),
        crate::logstream::splitter::MAX_LINE_BYTES,
    );
    let mut detail = match name {
        "Bash" => field("description").map(str::to_string),
        _ => None,
    };
    if multi_line {
        // The whole command/value, so the collapsed row is never the only copy.
        detail = Some(match detail {
            Some(d) => format!("{d}\n\n{value}"),
            None => value.to_string(),
        });
    }
    let detail = detail.map(|d| crate::logstream::cap_text(&d, crate::logstream::MAX_DETAIL_BYTES));
    (summary, detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On Windows `/usr/local/bin/claude` is
    /// `<current drive>:\usr\local\bin\claude`, creatable by any standard user, and the usage
    /// strip resolves `claude` every 5 s. The Unix fallbacks must never be searched there.
    #[test]
    fn the_unix_fallbacks_are_never_searched_on_windows() {
        assert!(known_absolute_paths(true).is_empty());
        assert_eq!(known_absolute_paths(false), KNOWN_ABSOLUTE_PATHS);
        assert!(
            KNOWN_ABSOLUTE_PATHS.iter().all(|p| p.starts_with('/')),
            "the macOS/Linux list is rooted paths only"
        );
    }

    /// A relative `PATH` entry resolves against the app's cwd. Only absolute entries are
    /// searched (on Windows a drive-less `\bin` is not absolute either).
    #[test]
    fn relative_path_entries_are_never_searched() {
        use std::ffi::OsStr;
        let abs = std::env::temp_dir();
        let path = std::env::join_paths([
            abs.as_os_str(),
            OsStr::new(""),
            OsStr::new("."),
            OsStr::new("rel"),
            OsStr::new(r"\rooted"),
        ])
        .unwrap();
        assert_eq!(absolute_path_dirs(&path), vec![abs]);
    }

    /// The installer's file is `claude` on macOS/Linux and `claude.exe` on Windows; the
    /// fallback paths must name the one that exists (it never matched on Windows before).
    #[test]
    fn the_known_install_paths_carry_the_windows_extension() {
        assert_eq!(
            known_install_file(".local/bin/claude", false),
            ".local/bin/claude"
        );
        assert_eq!(
            known_install_file(".local/bin/claude", true),
            ".local/bin/claude.exe"
        );
        for rel in KNOWN_INSTALL_PATHS {
            assert!(
                known_install_file(rel, true).ends_with("claude.exe"),
                "{rel}"
            );
            assert_eq!(known_install_file(rel, false), *rel);
        }
    }

    // ── npm-installed Claude Code on Windows: `claude.cmd` ───────────────────

    /// npm 10.9.9's `cmd-shim`, byte for byte (CRLF included), as `npm i -g` writes it on
    /// Windows for a package whose `bin` is `cli.js` — the shape of
    /// `@anthropic-ai/claude-code`.
    const NPM_SHIM_JS: &str =
        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n\
:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  \
SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  \
SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || \
title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";
    /// …and for a package whose `bin` is an `.exe` (no interpreter).
    const NPM_SHIM_EXE: &str =
        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n\
:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\
\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";
    /// npm ≤ 6's shim (cmd-shim 2/3), still on machines that never re-installed.
    const NPM6_SHIM_JS: &str = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \
\"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n\
) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  \
node  \"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n)\r\n";

    fn sep(s: &str) -> String {
        s.replace('/', std::path::MAIN_SEPARATOR_STR)
    }

    #[test]
    fn npm_cmd_shims_are_read_for_their_target_and_interpreter() {
        let cli = sep("node_modules/@anthropic-ai/claude-code/cli.js");
        let node = |rel: &str| {
            Some(ShimTarget {
                rel: rel.to_string(),
                interpreter: Some("node".to_string()),
            })
        };
        assert_eq!(parse_cmd_shim(NPM_SHIM_JS), node(&cli));
        assert_eq!(parse_cmd_shim(NPM6_SHIM_JS), node(&cli));
        assert_eq!(
            parse_cmd_shim(NPM_SHIM_EXE),
            Some(ShimTarget {
                rel: sep("node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
                interpreter: None,
            })
        );
        // Another interpreter named by the shim is kept, not replaced by `node`.
        let bun = NPM_SHIM_JS.replace("\"_prog=node\"", "\"_prog=bun\"");
        assert_eq!(
            parse_cmd_shim(&bun).unwrap().interpreter.as_deref(),
            Some("bun")
        );
        // Not a shim: no `%*` line, or no `%dp0%` target on it.
        for text in [
            "",
            "@echo off\r\nwsl claude\r\n",
            "@echo off\r\n\"C:\\tools\\claude.exe\" %*\r\n",
            "@echo off\r\n\"%dp0%\\node.exe\" %*\r\n",
        ] {
            assert_eq!(parse_cmd_shim(text), None, "{text:?}");
        }
    }

    /// A temp folder laid out like `%APPDATA%\npm` after `npm i -g`.
    fn npm_prefix(tag: &str, shim: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("npmshim-{tag}-{}", ulid::Ulid::new()));
        let pkg = dir.join("node_modules/@anthropic-ai/claude-code");
        std::fs::create_dir_all(pkg.join("bin")).unwrap();
        std::fs::write(pkg.join("cli.js"), "// cli\n").unwrap();
        std::fs::write(dir.join("claude.cmd"), shim).unwrap();
        dir
    }

    #[test]
    fn a_cmd_shim_becomes_its_interpreter_plus_its_script_never_cmd_exe() {
        let dir = npm_prefix("js", NPM_SHIM_JS);
        let shim = dir.join("claude.cmd");
        let cli = dir
            .join(sep("node_modules/@anthropic-ai/claude-code/cli.js"))
            .to_string_lossy()
            .into_owned();
        let path_node = PathBuf::from("/nodejs/node.exe");
        // No node.exe beside the shim → the one on PATH (what the shim's ELSE does).
        let got = invocation_for(&shim, true, || Some(path_node.clone())).unwrap();
        assert_eq!(
            got,
            ClaudeInvocation {
                program: path_node.to_string_lossy().into_owned(),
                prefix: vec![cli.clone()],
            }
        );
        assert_eq!(
            got.with_args(["-p".to_string(), "x".to_string()]),
            vec![cli.clone(), "-p".to_string(), "x".to_string()]
        );
        // No node anywhere → a clear error, not a cmd.exe launch.
        let err = invocation_for(&shim, true, || None)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("node.exe") && err.contains("was not found"),
            "{err}"
        );
        // A node.exe beside the shim wins (the shim's IF EXIST branch).
        std::fs::write(dir.join("node.exe"), "").unwrap();
        let got = invocation_for(&shim, true, || Some(path_node.clone())).unwrap();
        assert_eq!(got.program, dir.join("node.exe").to_string_lossy());
        assert_eq!(got.prefix, vec![cli.clone()]);
        // An upper-case extension (another name: Windows' `CLAUDE.CMD` IS `claude.cmd`).
        let upper = dir.join("CLAUDE-UP.CMD");
        std::fs::copy(&shim, &upper).unwrap();
        assert_eq!(
            invocation_for(&upper, true, || None).unwrap().prefix,
            vec![cli]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cmd_shim_to_an_exe_runs_the_exe_and_anything_else_runs_as_itself() {
        let dir = npm_prefix("exe", NPM_SHIM_EXE);
        let got = invocation_for(&dir.join("claude.cmd"), true, || None).unwrap();
        assert_eq!(
            got,
            ClaudeInvocation {
                program: dir
                    .join(sep("node_modules/@anthropic-ai/claude-code/bin/claude.exe"))
                    .to_string_lossy()
                    .into_owned(),
                prefix: vec![],
            }
        );
        // A native binary, or any path off Windows, is run as itself.
        for (path, windows) in [("C:/x/claude.exe", true), ("/u/bin/claude", false)] {
            assert_eq!(
                invocation_for(Path::new(path), windows, || None).unwrap(),
                ClaudeInvocation {
                    program: path.to_string(),
                    prefix: vec![]
                }
            );
        }
        assert_eq!(
            invocation_for(&dir.join("claude.cmd"), false, || None)
                .unwrap()
                .prefix,
            Vec::<String>::new(),
            "off Windows nothing is unwrapped"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cmd_that_is_not_a_shim_falls_back_to_the_package_layout_or_refuses() {
        let dir = npm_prefix(
            "odd",
            "@echo off\r\nrem a hand-written wrapper\r\nclaude-real %*\r\n",
        );
        let got = invocation_for(&dir.join("claude.cmd"), true, || {
            Some(PathBuf::from("node.exe"))
        })
        .unwrap();
        assert_eq!(got.program, "node.exe");
        assert_eq!(
            got.prefix,
            vec![dir.join(NPM_CLI_JS).to_string_lossy().into_owned()]
        );
        let lone = std::env::temp_dir().join(format!("loneshim-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&lone).unwrap();
        std::fs::write(lone.join("claude.cmd"), "@echo off\r\nwsl claude %*\r\n").unwrap();
        let err = invocation_for(&lone.join("claude.cmd"), true, || None)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("cmd.exe") && err.contains(CLAUDE_BIN_ENV),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(lone);
    }

    /// On Windows `claude.exe` anywhere on PATH beats `claude.cmd` anywhere; elsewhere the
    /// name is bare. Real files in temp dirs.
    #[test]
    fn the_native_binary_is_preferred_over_the_npm_shim_across_the_whole_path() {
        assert_eq!(
            program_file_names("claude", true),
            vec!["claude.exe".to_string(), "claude.cmd".to_string()]
        );
        assert_eq!(
            program_file_names("claude", false),
            vec!["claude".to_string()]
        );
        let base = std::env::temp_dir().join(format!("pathorder-{}", ulid::Ulid::new()));
        let (npm, native) = (base.join("npm"), base.join("native"));
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::create_dir_all(&native).unwrap();
        // `find_in_dirs` takes only executables, and on unix that is the mode bit: each file is
        // made executable as it is written, BEFORE the lookup that expects it (on unix the shim
        // was found only after the native binary's write, so the first assertion saw None).
        let make_executable = |p: &std::path::Path| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            #[cfg(not(unix))]
            let _ = p;
        };
        std::fs::write(npm.join("claude.cmd"), NPM_SHIM_JS).unwrap();
        make_executable(&npm.join("claude.cmd"));
        let names = program_file_names("claude", true);
        // Only the shim → the shim.
        assert_eq!(
            find_in_dirs(&[npm.clone(), native.clone()], &names),
            Some(npm.join("claude.cmd"))
        );
        // A native binary in a LATER dir still wins.
        std::fs::write(native.join("claude.exe"), "").unwrap();
        make_executable(&native.join("claude.exe"));
        assert_eq!(
            find_in_dirs(&[npm.clone(), native.clone()], &names),
            Some(native.join("claude.exe"))
        );
        assert_eq!(find_in_dirs(&[base.join("none")], &names), None);
        let _ = std::fs::remove_dir_all(base);
    }

    /// Arguments a shell would interpret — cmd's `%VAR%`, `!VAR!`, `^ & | < >`, quotes, a
    /// newline, an empty argument, trailing backslashes — arrive at the script exactly.
    #[cfg(windows)]
    const HOSTILE_ARGS: &[&str] = &[
        "-p",
        "100% & echo pwned ^ | <x> \"quoted\" %PATH% !USERNAME!",
        "line one\nline two",
        "",
        "trailing\\",
        "C:\\dir with space\\",
        "%CD%",
    ];

    /// A real npm-style `claude.cmd` whose `cli.js` records its argv (run by the real
    /// `node`), resolved the way the app resolves it.
    #[cfg(windows)]
    fn recording_shim(tag: &str) -> (PathBuf, ClaudeInvocation, PathBuf) {
        let dir = npm_prefix(tag, NPM_SHIM_JS);
        std::fs::write(
            dir.join(NPM_CLI_JS),
            "require('fs').writeFileSync(process.env.ARGV_OUT, \
             JSON.stringify(process.argv.slice(2)));\n",
        )
        .unwrap();
        let inv = invocation_for(&dir.join("claude.cmd"), true, find_node)
            .expect("node.exe is installed on a machine that builds this repo");
        let out = dir.join("argv.json");
        (dir, inv, out)
    }

    #[cfg(windows)]
    fn recorded(out: &Path) -> Vec<String> {
        serde_json::from_str(&std::fs::read_to_string(out).expect("the script ran")).unwrap()
    }

    /// The usage / context probes' path: `tokio::process::Command` (std's quoting).
    #[cfg(windows)]
    #[test]
    fn on_windows_an_npm_claude_cmd_gets_hostile_arguments_verbatim_through_command() {
        use crate::spawn::NoWindow as _;
        let (dir, inv, out) = recording_shim("cmd");
        let args: Vec<String> = HOSTILE_ARGS.iter().map(|s| s.to_string()).collect();
        let status = std::process::Command::new(&inv.program)
            .args(inv.with_args(args.clone()))
            .env("ARGV_OUT", &out)
            .no_window()
            .status()
            .expect("node runs");
        assert!(status.success(), "{status:?}");
        assert_eq!(recorded(&out), args);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The agent's path: the real ConPTY spawn (`portable-pty` builds that command line
    /// itself — a different quoter from std's).
    #[cfg(windows)]
    #[test]
    fn on_windows_an_npm_claude_cmd_gets_hostile_arguments_verbatim_through_the_pty() {
        let (dir, inv, out) = recording_shim("pty");
        let args: Vec<String> = HOSTILE_ARGS.iter().map(|s| s.to_string()).collect();
        let mut term = crate::pty::testterm::TestTerm::spawn(&SpawnSpec {
            program: inv.program.clone(),
            args: inv.with_args(args.clone()),
            cwd: dir.clone(),
            env: vec![("ARGV_OUT".to_string(), out.to_string_lossy().into_owned())],
            rows: 24,
            cols: 80,
        });
        let status = term.wait_exit(30);
        assert!(
            status.as_ref().is_some_and(|s| s.success()),
            "node did not finish: {status:?}; screen: {:?}",
            term.text()
        );
        drop(term);
        assert_eq!(recorded(&out), args);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_background_result_names_its_output_file_even_with_spaces_in_the_temp_dir() {
        let win = "Command running in background with ID: b0test001. Output is being written \
                   to: C:\\Users\\Dev User\\AppData\\Local\\Temp\\claude\\0123456789abcdef\\\
                   5e550000-0000-4000-8000-000000000001\\tasks\\b0test001.output. You will be \
                   notified when it completes.";
        assert_eq!(
            parse_bg_started(win, None),
            Some((
                "b0test001".to_string(),
                Some(PathBuf::from(
                    "C:\\Users\\Dev User\\AppData\\Local\\Temp\\claude\\0123456789abcdef\\\
                     5e550000-0000-4000-8000-000000000001\\tasks\\b0test001.output"
                ))
            ))
        );
        // The macOS shape is unchanged, and a path with no `.output` is still its first word.
        let mac = "Command running in background with ID: b1. Output is being written to: \
                   /private/tmp/claude-501/-w/s/tasks/b1.output. You will be notified.";
        assert_eq!(
            parse_bg_started(mac, None).unwrap().1,
            Some(PathBuf::from(
                "/private/tmp/claude-501/-w/s/tasks/b1.output"
            ))
        );
        let odd = "with ID: b2. Output is being written to: /tmp/x.log. Done.";
        assert_eq!(
            parse_bg_started(odd, None).unwrap().1,
            Some(PathBuf::from("/tmp/x.log"))
        );
    }

    /// Windows' temp layout has a hashed project level; the session id finds it. The macOS
    /// layout (`<root>/<project dir>/<session>`) still wins when it exists.
    #[test]
    fn a_monitors_output_file_is_found_under_a_hashed_project_level() {
        let base = std::env::temp_dir().join(format!("taskroot-{}", ulid::Ulid::new()));
        let root = base.join("claude");
        let session = "5e550000-0000-4000-8000-000000000001";
        let loc = crate::agent::fanout::TranscriptLocation {
            root_transcript: base
                .join("projects")
                .join("C--Users-me-projects-app")
                .join(format!("{session}.jsonl")),
            subagents_dir: base
                .join("projects")
                .join("C--Users-me-projects-app")
                .join(session),
        };
        let roots = vec![root.clone()];
        // Nothing on disk yet → the named layout under the first root.
        assert_eq!(
            task_output_path(&loc, "m1", &roots),
            Some(
                root.join("C--Users-me-projects-app")
                    .join(session)
                    .join("tasks")
                    .join("m1.output")
            )
        );
        let hashed = root.join("0123456789abcdef").join(session);
        std::fs::create_dir_all(&hashed).unwrap();
        std::fs::create_dir_all(root.join("fedcba9876543210").join("other-session")).unwrap();
        assert_eq!(
            task_output_path(&loc, "m1", &roots),
            Some(hashed.join("tasks").join("m1.output"))
        );
        let named = root.join("C--Users-me-projects-app").join(session);
        std::fs::create_dir_all(&named).unwrap();
        assert_eq!(
            task_output_path(&loc, "m1", &roots),
            Some(named.join("tasks").join("m1.output"))
        );
        let _ = std::fs::remove_dir_all(base);
    }

    // ── Sub-agent activity: timestamp + truncation math ──────────────────────

    #[test]
    fn iso_timestamp_parses_to_epoch_millis() {
        // The Unix epoch itself.
        assert_eq!(parse_iso_millis("1970-01-01T00:00:00.000Z"), 0);
        // A known instant (verifiable: 2026-07-17T05:51:45.178Z).
        assert_eq!(
            parse_iso_millis("2026-07-17T05:51:45.178Z"),
            1_784_267_505_178
        );
        // Missing fractional seconds → .000.
        assert_eq!(parse_iso_millis("1970-01-01T00:00:01Z"), 1000);
        // A leap day is handled exactly.
        assert_eq!(
            parse_iso_millis("2024-02-29T00:00:00.000Z"),
            1_709_164_800_000
        );
    }

    #[test]
    fn a_malformed_timestamp_is_zero_not_a_panic() {
        for bad in [
            "",
            "not-a-date",
            "2026-07-17",
            "garbageTgarbage",
            "2026/07/17T00:00:00Z",
        ] {
            assert_eq!(parse_iso_millis(bad), 0, "malformed {bad:?} must be 0");
        }
    }

    #[test]
    fn days_from_civil_matches_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(2000, 3, 1), 11017); // post-leap-day boundary
        assert_eq!(days_from_civil(1969, 12, 31), -1);
    }

    #[test]
    fn truncate_caps_on_a_char_boundary_and_marks_it() {
        assert_eq!(truncate_text("short"), "short"); // under cap, unchanged
        let long = "a".repeat(ACTIVITY_TEXT_MAX + 500);
        let t = truncate_text(&long);
        assert!(t.len() <= ACTIVITY_TEXT_MAX + 4);
        assert!(t.ends_with('…'));
        // A multibyte char straddling the cut must not be split (no panic, valid UTF-8).
        let multibyte = "é".repeat(ACTIVITY_TEXT_MAX); // 2 bytes each
        let t = truncate_text(&multibyte);
        assert!(t.is_char_boundary(t.len() - '…'.len_utf8()));
    }

    /// `--session-id` rejects anything that is not a UUID, so this shape is a hard
    /// requirement, not a preference.
    #[test]
    fn minted_session_key_is_a_valid_uuid() {
        for _ in 0..64 {
            let k = mint_session_key();
            let s = k.as_str();
            assert_eq!(s.len(), 36, "UUID must be 36 chars: {s}");
            let groups: Vec<&str> = s.split('-').collect();
            assert_eq!(
                groups.iter().map(|g| g.len()).collect::<Vec<_>>(),
                vec![8, 4, 4, 4, 12],
                "UUID must be 8-4-4-4-12: {s}"
            );
            assert!(
                s.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
                "UUID must be hex + dashes: {s}"
            );

            // RFC 4122 conformance, not just shape: raw ULID bytes land these nibbles at random.
            let hex: String = s.chars().filter(|c| *c != '-').collect();
            assert_eq!(
                hex.as_bytes()[12] as char,
                '7',
                "must be UUIDv7 (ULID's layout already is one): {s}"
            );
            let variant = u8::from_str_radix(&hex[16..17], 16).unwrap();
            assert_eq!(
                variant & 0b1100,
                0b1000,
                "variant must be RFC 4122 (10xx): {s}"
            );
        }
    }

    /// Version/variant stamping must not clobber the ULID timestamp — that is what
    /// keeps session ids time-ordered, and it lives in the first 6 bytes.
    #[test]
    fn minted_session_keys_stay_time_ordered() {
        let mut previous = String::new();
        for _ in 0..16 {
            let k = mint_session_key();
            // The 48-bit ms timestamp is the first 12 hex chars, big-endian, so
            // lexicographic order is chronological order.
            let ts = k.as_str()[..13].to_string();
            assert!(
                ts >= previous,
                "session ids went backwards: {previous} then {ts}"
            );
            previous = ts;
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    /// Two agents in one cwd is the exact case the cwd heuristic could not tell
    /// apart. Distinct ids are what make it a non-problem.
    #[test]
    fn each_spawn_mints_a_distinct_session_key() {
        let keys: std::collections::HashSet<String> =
            (0..256).map(|_| mint_session_key().0).collect();
        assert_eq!(keys.len(), 256, "session keys must never collide");
    }

    #[test]
    fn args_bind_the_session_id() {
        let key = SessionKey("11111111-2222-3333-4444-555555555555".into());
        let args = build_args(&key, None);
        assert_eq!(
            args,
            vec!["--session-id", "11111111-2222-3333-4444-555555555555"]
        );
    }

    /// No `-p`: an agent terminal must stay interactive.
    #[test]
    fn args_never_request_print_mode() {
        let key = SessionKey("11111111-2222-3333-4444-555555555555".into());
        for prompt in [None, Some("do the thing")] {
            let args = build_args(&key, prompt);
            assert!(
                !args.iter().any(|a| a == "-p" || a == "--print"),
                "print mode would exit immediately instead of giving the user a terminal"
            );
        }
    }

    #[test]
    fn a_prompt_is_passed_positionally_after_the_session_id() {
        let key = SessionKey("11111111-2222-3333-4444-555555555555".into());
        let args = build_args(&key, Some("fix the build"));
        assert_eq!(args.last().unwrap(), "fix the build");
        assert_eq!(args[0], "--session-id");
    }

    /// A blank prompt must not become an empty argv entry — `claude` would treat
    /// `""` as a real (empty) prompt.
    #[test]
    fn blank_prompts_are_dropped() {
        let key = SessionKey("11111111-2222-3333-4444-555555555555".into());
        for blank in ["", "   ", "\n", "\t"] {
            assert_eq!(
                build_args(&key, Some(blank)).len(),
                2,
                "blank prompt {blank:?} leaked"
            );
        }
    }

    /// Resume argv imposes the persisted id via `--resume`, not `--session-id`
    /// (pinned agents). `--session-id` would try to *create* a new session with that id
    /// and clash with the existing transcript; `--resume` re-opens it.
    #[test]
    fn resume_args_use_the_resume_flag_with_the_persisted_id() {
        let key = SessionKey("11111111-2222-3333-4444-555555555555".into());
        let args = build_resume_args(&key, None);
        assert_eq!(
            args,
            vec!["--resume", "11111111-2222-3333-4444-555555555555"]
        );
    }

    /// Resume must stay interactive too — no `-p`, or the resumed session would
    /// print-and-exit instead of giving the user their terminal back.
    #[test]
    fn resume_args_never_request_print_mode() {
        let key = SessionKey("11111111-2222-3333-4444-555555555555".into());
        for prompt in [None, Some("keep going")] {
            let args = build_resume_args(&key, prompt);
            assert!(!args.iter().any(|a| a == "-p" || a == "--print"));
        }
    }

    /// A blank prompt must not leak into the resume argv either (same contract as
    /// the fresh path).
    #[test]
    fn resume_args_drop_blank_prompts() {
        let key = SessionKey("11111111-2222-3333-4444-555555555555".into());
        for blank in ["", "   ", "\n", "\t"] {
            assert_eq!(build_resume_args(&key, Some(blank)).len(), 2);
        }
    }

    /// The `SessionStart` payload's `cwd` is captured — it is the directory the
    /// session is *actually* running in, and the supervisor anchors an
    /// ad-hoc root to it rather than to the terminal's spawn cwd.
    #[test]
    fn parse_session_event_captures_the_payload_cwd() {
        let body = br#"{
            "hook_event_name": "SessionStart",
            "session_id": "sess-1",
            "cwd": "/Users/x/other-repo",
            "transcript_path": "/t/sess-1.jsonl"
        }"#;
        let ev = parse_session_event(body).expect("must parse");
        assert_eq!(ev.kind, SessionEventKind::Start);
        assert_eq!(ev.session_id, "sess-1");
        assert_eq!(ev.cwd.as_deref(), Some("/Users/x/other-repo"));
        assert_eq!(ev.transcript_path.as_deref(), Some("/t/sess-1.jsonl"));
    }

    /// A missing or empty `cwd` is `None`, so the supervisor falls back to the
    /// terminal's meta cwd rather than anchoring the agent to an empty path.
    #[test]
    fn parse_session_event_treats_missing_or_blank_cwd_as_none() {
        let no_cwd = br#"{"hook_event_name":"SessionStart","session_id":"s"}"#;
        assert_eq!(parse_session_event(no_cwd).unwrap().cwd, None);

        let blank_cwd = br#"{"hook_event_name":"SessionStart","session_id":"s","cwd":""}"#;
        assert_eq!(parse_session_event(blank_cwd).unwrap().cwd, None);
    }

    #[test]
    fn parse_session_event_maps_the_turn_activity_hooks() {
        // The turn/activity hooks that drive the real idle/running status.
        let cases = [
            ("UserPromptSubmit", SessionEventKind::Busy),
            ("Stop", SessionEventKind::Idle),
            ("Notification", SessionEventKind::AwaitingInput),
        ];
        for (name, want) in cases {
            let body = format!(r#"{{"hook_event_name":"{name}","session_id":"s1"}}"#).into_bytes();
            let ev = parse_session_event(&body).expect("must parse {name}");
            assert_eq!(ev.kind, want, "{name} maps to the wrong kind");
            assert_eq!(ev.session_id, "s1");
        }
    }

    #[test]
    fn parse_session_event_rejects_an_unknown_hook_name() {
        let body = br#"{"hook_event_name":"PreToolUse","session_id":"s1"}"#;
        assert!(parse_session_event(body).is_none(), "unknown hook → None");
    }

    #[test]
    fn hook_settings_installs_the_turn_activity_events() {
        // All five events must be present so the status transitions actually fire.
        let v = hook_settings();
        let hooks = v["hooks"].as_object().expect("hooks object");
        for event in [
            "SessionStart",
            "SessionEnd",
            "UserPromptSubmit",
            "Stop",
            "Notification",
        ] {
            assert!(hooks.contains_key(event), "missing hook event {event}");
        }
    }

    /// Git Bash on Windows (Claude Code requires it; `CLAUDE_CODE_GIT_BASH_PATH` overrides), so
    /// its absence fails loudly rather than skipping.
    fn hook_shell() -> PathBuf {
        #[cfg(unix)]
        {
            PathBuf::from("/bin/sh")
        }
        #[cfg(not(unix))]
        {
            let candidates = [
                std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(PathBuf::from),
                std::env::var_os("ProgramFiles")
                    .map(|p| PathBuf::from(p).join("Git").join("bin").join("bash.exe")),
                std::env::var_os("ProgramW6432")
                    .map(|p| PathBuf::from(p).join("Git").join("bin").join("bash.exe")),
            ];
            candidates
                .into_iter()
                .flatten()
                .find(|p| p.is_file())
                .expect(
                    "Git Bash not found: Claude Code on Windows runs hooks with it — install \
                     Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH",
                )
        }
    }

    /// `env_clear` minus what a Windows process cannot start without: `SystemRoot` (curl's
    /// Winsock and Git Bash's runtime both need it). Nothing on other OSes.
    fn keep_os_env(c: &mut std::process::Command) {
        if cfg!(windows) {
            for k in ["SystemRoot", "WINDIR"] {
                if let Some(v) = std::env::var_os(k) {
                    c.env(k, v);
                }
            }
        }
    }

    /// As Claude Code runs it (`/bin/sh -c`, payload on stdin) with a scrubbed env; the listener is
    /// a dead port, so curl fails fast: no network, no `~/.claude`.
    fn run_hook(cmd: &str, ours: bool) -> std::process::Output {
        use std::io::Write as _;
        let mut c = std::process::Command::new(hook_shell());
        c.arg("-c").arg(cmd).env_clear();
        keep_os_env(&mut c);
        c.env("PATH", std::env::var("PATH").unwrap_or_default());
        if ours {
            c.env(ENV_HOOK_URL, "http://127.0.0.1:9/hook")
                .env(ENV_HOOK_TOKEN, "tok")
                .env(ENV_TERMINAL_ID, "term-1");
        }
        let mut child = c
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn /bin/sh");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"hook_event_name":"SessionStart","session_id":"s"}"#)
            .unwrap();
        child.wait_with_output().unwrap()
    }

    fn session_start_command() -> String {
        let v = hook_settings();
        v["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// In our PTY, the SessionStart hook prints exactly one JSON document whose
    /// `hookSpecificOutput` carries the proxy context — even though the listener is dead
    /// (the curl fails) — and exits 0.
    #[test]
    fn session_start_hook_injects_the_proxy_context_and_exits_zero() {
        let cmd = session_start_command();
        assert!(cmd.contains(HOOK_MARKER), "{cmd}");
        let out = run_hook(&cmd, true);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        let stdout = String::from_utf8(out.stdout).unwrap();
        // Exactly one document: a deserializer stream yields one value and then ends.
        let docs: Vec<serde_json::Value> = serde_json::Deserializer::from_str(&stdout)
            .into_iter()
            .collect::<Result<_, _>>()
            .unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {stdout:?}"));
        assert_eq!(docs.len(), 1, "{stdout:?}");
        let v = &docs[0];
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(
            v["hookSpecificOutput"]["additionalContext"],
            session_context()
        );
        assert!(v.get("additionalContext").is_none(), "top-level is ignored");
        assert!(PROXY_CONTEXT.starts_with("This terminal runs inside Agent Studio. Its HTTP(S)"));
        assert!(
            PROXY_CONTEXT.ends_with("so tests that expect a refused connection pass unchanged.")
        );
        assert!(
            !PROXY_CONTEXT.contains("502 from"),
            "the proxy no longer answers a refusal with a 502"
        );
        // "Agent Studio's": the one apostrophe survives the shell quoting verbatim.
        assert!(PROXY_CONTEXT.contains("Agent Studio's local capture proxy"));
        assert!(PROXY_CONTEXT.len() < 1024, "{}", PROXY_CONTEXT.len());
    }

    /// Run `cmd` as Claude Code runs a hook (`/bin/sh -c`, payload on stdin) with exactly
    /// `env` — nothing inherited.
    #[cfg(unix)]
    fn run_hook_env(cmd: &str, env: &[(&str, String)]) -> std::process::Output {
        use std::io::Write as _;
        let mut c = std::process::Command::new("/bin/sh");
        c.arg("-c").arg(cmd).env_clear();
        for (k, v) in env {
            c.env(k, v);
        }
        let mut child = c
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn /bin/sh");
        child.stdin.take().unwrap().write_all(b"{}").unwrap();
        child.wait_with_output().unwrap()
    }

    /// Once per file (a resume fires SessionStart again); sourcing it puts the shim dir (with a
    /// space) back ahead of a login shell's `/usr/bin`. Stdout stays one JSON document.
    #[cfg(unix)]
    #[test]
    fn session_start_puts_the_curl_shim_first_for_claudes_bash_tool() {
        let dir = std::env::temp_dir().join(format!("envfile-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let env_file = dir.join("session-env.sh");
        let shim = dir.join("Application Support/netcap/bin");
        let env = [
            ("PATH", "/usr/bin:/bin".to_string()),
            (ENV_HOOK_URL, "http://127.0.0.1:9/hook".to_string()),
            (ENV_HOOK_TOKEN, "tok".to_string()),
            (ENV_TERMINAL_ID, "term-1".to_string()),
            ("CLAUDE_ENV_FILE", env_file.to_string_lossy().into_owned()),
            (
                crate::netcap::env::SHIM_DIR_VAR,
                shim.to_string_lossy().into_owned(),
            ),
        ];
        for _ in 0..2 {
            let out = run_hook_env(&session_start_command(), &env);
            assert_eq!(out.status.code(), Some(0), "{out:?}");
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("one JSON doc");
            assert_eq!(
                v["hookSpecificOutput"]["additionalContext"],
                session_context()
            );
        }
        let text = std::fs::read_to_string(&env_file).unwrap();
        assert_eq!(text.lines().count(), 1, "once per file: {text}");
        let sourced = run_hook_env(
            &format!(". '{}'; printf '%s' \"$PATH\"", env_file.display()),
            &env[..1]
                .iter()
                .cloned()
                .chain([(
                    crate::netcap::env::SHIM_DIR_VAR,
                    shim.to_string_lossy().into_owned(),
                )])
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            String::from_utf8(sourced.stdout).unwrap(),
            format!("{}:/usr/bin:/bin", shim.display())
        );
        // No shim dir (capture off, Windows) or no env file (not Claude) → nothing written.
        let other = dir.join("other.sh");
        let mut no_shim = env.to_vec();
        no_shim.retain(|(k, _)| *k != crate::netcap::env::SHIM_DIR_VAR);
        no_shim.retain(|(k, _)| *k != "CLAUDE_ENV_FILE");
        no_shim.push(("CLAUDE_ENV_FILE", other.to_string_lossy().into_owned()));
        assert_eq!(
            run_hook_env(&session_start_command(), &no_shim)
                .status
                .code(),
            Some(0)
        );
        assert!(!other.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Our own hook POST keeps `--noproxy '*'` even with the strict curl shim first on `PATH`
    /// and the capture proxy set: its token must never transit (and be shown by) the proxy.
    /// The real shim, a fake curl after it that records its argv.
    #[cfg(unix)]
    #[test]
    fn the_hooks_own_curl_is_exempt_from_the_strict_shim() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("hookshim-{}", ulid::Ulid::new()));
        let shim = crate::netcap::shim::ensure(&dir.join("netcap")).unwrap();
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let fake = real.join("curl");
        std::fs::write(
            &fake,
            "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\"; done > \"$FAKE_OUT\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let url = "http://t-term-1:x@127.0.0.1:4711".to_string();
        let out_file = dir.join("argv");
        let env = [
            (
                "PATH",
                format!("{}:{}:/usr/bin:/bin", shim.display(), real.display()),
            ),
            ("HTTP_PROXY", url.clone()),
            ("HTTPS_PROXY", url.clone()),
            (crate::netcap::env::PROXY_URL_VAR, url),
            (crate::netcap::env::STRICT_VAR, "1".to_string()),
            (ENV_HOOK_URL, "http://127.0.0.1:9/hook".to_string()),
            (ENV_HOOK_TOKEN, "tok".to_string()),
            (ENV_TERMINAL_ID, "term-1".to_string()),
            ("FAKE_OUT", out_file.to_string_lossy().into_owned()),
        ];
        let out = run_hook_env(&hook_command(), &env);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        let argv = std::fs::read_to_string(&out_file).expect("the fake curl ran");
        assert!(argv.starts_with("[--noproxy][*][-sS]"), "{argv}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The macOS/Linux env-file line is byte-identical to what shipped (platform-native: the
    /// Windows line is a second variant, never a change to the first), and the Windows variant
    /// is what the Windows build writes.
    #[test]
    fn the_env_file_line_is_unchanged_off_windows_and_converted_on_windows() {
        assert_eq!(
            env_file_shim_path_for(false),
            "{ [ -z \"$CLAUDE_ENV_FILE\" ] || [ -z \"$AGENTSTUDIO_SHIM_DIR\" ] || grep -qsF \
             agentstudio-curl-shim \"$CLAUDE_ENV_FILE\" || printf '%s\\n' 'export \
             PATH=\"$AGENTSTUDIO_SHIM_DIR:$PATH\"  # agentstudio-curl-shim' >> \"$CLAUDE_ENV_FILE\"; \
             } 2>/dev/null"
        );
        let win = env_file_shim_path_for(true);
        assert!(win.contains("cygpath -u"), "{win}");
        assert!(
            win.contains("# agentstudio-curl-shim'"),
            "the once-per-file marker: {win}"
        );
        assert!(
            !win.contains("export PATH=\"$AGENTSTUDIO_SHIM_DIR"),
            "{win}"
        );
        assert_eq!(env_file_shim_path(), env_file_shim_path_for(cfg!(windows)));
        assert!(session_start_command().contains(&env_file_shim_path_for(cfg!(windows))));
    }

    /// The `agent-studio` command's PATH line: its own marker (so it is appended independently
    /// of the curl shim's), the POSIX form off Windows and the `cygpath` form on it, and it is
    /// part of the SessionStart command on this platform.
    #[test]
    fn the_tools_env_file_line_has_its_own_marker_and_a_windows_variant() {
        assert_eq!(
            env_file_tools_path_for(false),
            "{ [ -z \"$CLAUDE_ENV_FILE\" ] || [ -z \"$AGENTSTUDIO_TOOLS_DIR\" ] || grep -qsF \
             agentstudio-tools-path \"$CLAUDE_ENV_FILE\" || printf '%s\\n' 'export \
             PATH=\"$AGENTSTUDIO_TOOLS_DIR:$PATH\"  # agentstudio-tools-path' >> \
             \"$CLAUDE_ENV_FILE\"; } 2>/dev/null"
        );
        let win = env_file_tools_path_for(true);
        assert!(
            win.contains("cygpath -u \"$AGENTSTUDIO_TOOLS_DIR\""),
            "{win}"
        );
        assert!(win.contains("# agentstudio-tools-path'"), "{win}");
        assert!(session_start_command().contains(&env_file_tools_path_for(cfg!(windows))));
    }

    /// The context names the command and its two verbs, keeps the proxy text first and intact,
    /// and stays small enough to sit in every session's context.
    #[test]
    fn the_session_context_tells_the_agent_about_the_agent_studio_command() {
        let ctx = session_context();
        assert!(ctx.starts_with(PROXY_CONTEXT));
        assert!(ctx.contains("agent-studio db connect '<connection-url>'"));
        assert!(ctx.contains("agent-studio db list"));
        assert!(ctx.contains("never prints passwords"));
        assert!(ctx.contains("agent-studio help"));
        // Every scheme it names is one the registry really parses.
        for scheme in [
            "postgres",
            "postgresql",
            "mysql",
            "clickhouse",
            "mongodb",
            "mongodb+srv",
            "redis",
            "rediss",
            "valkey",
        ] {
            assert!(
                crate::db::url::parse(&format!("{scheme}://h/x")).is_ok()
                    || crate::db::url::parse(&format!("{scheme}://h")).is_ok(),
                "{scheme} is not a scheme the URL parser accepts"
            );
        }
        assert!(ctx.len() < 2048, "{}", ctx.len());
    }

    /// Both PATH lines land in `$CLAUDE_ENV_FILE` once each, and sourcing it puts the
    /// `agent-studio` dir and the curl shim dir in front of a login shell's `/usr/bin`. Without
    /// a tools dir (no install) only the shim line is written.
    #[cfg(unix)]
    #[test]
    fn session_start_puts_the_agent_studio_command_on_claudes_path() {
        let dir = std::env::temp_dir().join(format!("envfile-tools-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let env_file = dir.join("session-env.sh");
        let shim = dir.join("Application Support/netcap/bin");
        let tools = dir.join("Application Support/agent-tools/bin");
        let env = [
            ("PATH", "/usr/bin:/bin".to_string()),
            (ENV_HOOK_URL, "http://127.0.0.1:9/hook".to_string()),
            (ENV_HOOK_TOKEN, "tok".to_string()),
            (ENV_TERMINAL_ID, "term-1".to_string()),
            ("CLAUDE_ENV_FILE", env_file.to_string_lossy().into_owned()),
            (
                crate::netcap::env::SHIM_DIR_VAR,
                shim.to_string_lossy().into_owned(),
            ),
            (
                crate::agent_ctl::tools::TOOLS_DIR_VAR,
                tools.to_string_lossy().into_owned(),
            ),
        ];
        for _ in 0..2 {
            let out = run_hook_env(&session_start_command(), &env);
            assert_eq!(out.status.code(), Some(0), "{out:?}");
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("one JSON doc");
            assert_eq!(
                v["hookSpecificOutput"]["additionalContext"],
                session_context()
            );
        }
        let text = std::fs::read_to_string(&env_file).unwrap();
        assert_eq!(text.lines().count(), 2, "once each: {text}");
        let sourced = run_hook_env(
            &format!(". '{}'; printf '%s' \"$PATH\"", env_file.display()),
            &[env[0].clone(), env[5].clone(), env[6].clone()],
        );
        assert_eq!(
            String::from_utf8(sourced.stdout).unwrap(),
            format!("{}:{}:/usr/bin:/bin", tools.display(), shim.display())
        );

        let other = dir.join("other.sh");
        let mut no_tools: Vec<_> = env
            .iter()
            .filter(|(k, _)| {
                *k != crate::agent_ctl::tools::TOOLS_DIR_VAR && *k != "CLAUDE_ENV_FILE"
            })
            .cloned()
            .collect();
        no_tools.push(("CLAUDE_ENV_FILE", other.to_string_lossy().into_owned()));
        assert_eq!(
            run_hook_env(&session_start_command(), &no_tools)
                .status
                .code(),
            Some(0)
        );
        let text = std::fs::read_to_string(&other).unwrap();
        assert!(text.contains("agentstudio-curl-shim"), "{text}");
        assert!(!text.contains("agentstudio-tools-path"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A one-shot HTTP responder on loopback for the Windows Git Bash test: every request head
    /// it reads is kept, and it answers `200 <tag>`. Polls with a deadline, never blocks forever.
    #[cfg(windows)]
    fn responder(tag: &'static str) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read as _, Write as _};
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        l.set_nonblocking(true).unwrap();
        let heads = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = heads.clone();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while std::time::Instant::now() < deadline {
                let Ok((mut s, _)) = l.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    continue;
                };
                let _ = s.set_nonblocking(false);
                let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf).into_owned());
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{tag}",
                    tag.len()
                );
            }
        });
        (port, heads)
    }

    /// Through the real Git Bash: a fresh login shell sourcing the env file finds the shim as
    /// `curl`, and `--noproxy '*'` still reaches the proxy; with strict capture off it goes direct.
    #[cfg(windows)]
    #[test]
    fn on_windows_git_bash_sources_the_env_file_and_curl_goes_through_the_proxy() {
        use crate::spawn::NoWindow as _;
        let Some(bash) = std::env::var_os("ProgramFiles")
            .map(|p| PathBuf::from(p).join("Git").join("bin").join("bash.exe"))
            .filter(|p| p.is_file())
        else {
            eprintln!("SKIP: Git for Windows is not installed");
            return;
        };
        let dir = std::env::temp_dir().join(format!("envfile w {}", ulid::Ulid::new()));
        let shim = crate::netcap::shim::ensure(&dir.join("App Data").join("netcap")).unwrap();
        let env_file = dir.join("session-env.sh");
        let (proxy, heads) = responder("via-proxy");
        let (direct, direct_heads) = responder("direct");
        let url = format!("http://t-term-1:x@127.0.0.1:{proxy}");
        let base: Vec<(&str, String)> = vec![
            ("PATH", r"C:\Windows\System32".to_string()),
            ("http_proxy", url.clone()),
            ("HTTPS_PROXY", url.clone()),
            (crate::netcap::env::PROXY_URL_VAR, url),
            (crate::netcap::env::STRICT_VAR, "1".to_string()),
            (
                crate::netcap::env::SHIM_DIR_VAR,
                shim.to_string_lossy().into_owned(),
            ),
            ("CLAUDE_ENV_FILE", env_file.to_string_lossy().into_owned()),
        ];
        let run = |script: &str, extra: &[(&str, String)]| {
            use std::io::Write as _;
            let mut c = std::process::Command::new(&bash);
            c.arg("-c").arg(script).env_clear();
            keep_os_env(&mut c);
            for (k, v) in base.iter().chain(extra) {
                c.env(k, v);
            }
            let mut child = c
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_window()
                .spawn()
                .expect("Git Bash runs");
            child.stdin.take().unwrap().write_all(b"{}").unwrap();
            child.wait_with_output().unwrap()
        };
        // The hook, twice (a resume fires SessionStart again): one line, and stdout stays JSON.
        let hook_env = [
            (ENV_HOOK_URL, "http://127.0.0.1:9/hook".to_string()),
            (ENV_HOOK_TOKEN, "tok".to_string()),
            (ENV_TERMINAL_ID, "term-1".to_string()),
        ];
        for _ in 0..2 {
            let out = run(&session_start_command(), &hook_env);
            assert_eq!(out.status.code(), Some(0), "{out:?}");
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("one JSON doc");
            assert_eq!(
                v["hookSpecificOutput"]["additionalContext"],
                session_context()
            );
        }
        let text = std::fs::read_to_string(&env_file).unwrap();
        assert_eq!(
            text,
            format!("{ENV_FILE_LINE_WINDOWS}\n"),
            "once, the Windows line"
        );

        let agent_cmd = format!(
            "bash -lc '. \"$(cygpath -u \"$CLAUDE_ENV_FILE\")\"; command -v curl; \
             curl -sS -m 10 --noproxy \"*\" http://127.0.0.1:{direct}/agent-bash; echo'"
        );
        let out = run(&agent_cmd, &[]);
        let stdout = String::from_utf8_lossy(&out.stdout).replace('\r', "");
        let mut lines = stdout.lines();
        let found = lines.next().unwrap_or_default();
        assert!(
            found.ends_with("/App Data/netcap/bin/curl"),
            "the shim leads PATH in the agent's shell: {stdout} / {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(lines.next(), Some("via-proxy"), "{stdout}");
        let seen = heads.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(
            seen[0].starts_with(&format!(
                "GET http://127.0.0.1:{direct}/agent-bash HTTP/1.1"
            )),
            "absolute-form through the proxy: {seen:?}"
        );
        // curl's own credentials from the proxy URL: the terminal's attribution.
        assert!(
            seen[0]
                .to_ascii_lowercase()
                .contains("proxy-authorization: basic dc10zxjtlte6ea=="),
            "{seen:?}"
        );
        assert!(direct_heads.lock().unwrap().is_empty());

        // Falsify: strict off ⇒ the shim leaves `--noproxy` alone and curl goes direct.
        let out = run(
            &agent_cmd,
            &[(crate::netcap::env::STRICT_VAR, "0".to_string())],
        );
        let stdout = String::from_utf8_lossy(&out.stdout).replace('\r', "");
        assert!(stdout.contains("\ndirect\n"), "{stdout}");
        assert_eq!(heads.lock().unwrap().len(), 1, "the proxy saw nothing new");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Outside our PTYs (env unset) the SessionStart hook is inert: no stdout, exit 0.
    #[test]
    fn session_start_hook_is_silent_without_our_env() {
        let out = run_hook(&session_start_command(), false);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        assert!(
            out.stdout.is_empty(),
            "{:?}",
            String::from_utf8_lossy(&out.stdout)
        );
    }

    /// The other events keep the plain POST command: no stdout either way, exit 0.
    #[test]
    fn other_event_hooks_print_nothing() {
        let v = hook_settings();
        for e in ["SessionEnd", "UserPromptSubmit", "Stop", "Notification"] {
            let cmd = v["hooks"][e][0]["hooks"][0]["command"].as_str().unwrap();
            assert_eq!(cmd, hook_command(), "{e}");
            for ours in [true, false] {
                let out = run_hook(cmd, ours);
                assert_eq!(out.status.code(), Some(0), "{e} {ours} {out:?}");
                assert!(out.stdout.is_empty(), "{e} {ours}");
            }
        }
    }

    #[test]
    fn sh_single_quote_round_trips_through_the_shell() {
        let s = "it's \"q\" $HOME *";
        let out = std::process::Command::new(hook_shell())
            .arg("-c")
            .arg(format!("printf %s {}", sh_single_quote(s)))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), s);
    }

    #[test]
    fn a_directory_named_claude_is_not_executable() {
        let dir = std::env::temp_dir();
        assert!(
            !is_executable(&dir),
            "a directory must never resolve as the binary"
        );
    }

    #[test]
    fn missing_paths_are_not_executable() {
        assert!(!is_executable(Path::new("/definitely/not/here/claude")));
    }

    // ── Background sub-agents: how they end ──────────────────────────────────

    #[test]
    fn task_notifications_parse_every_block_and_skip_broken_ones() {
        let line = "x<task-notification><task-id> a1 </task-id><status>completed</status>\
                    </task-notification><task-notification><task-id>a2</task-id>\
                    </task-notification><task-notification><task-id>a3</task-id>\
                    <status>failed</status></task-notification>tail\
                    <task-notification><task-id>a4</task-id><status>killed</status>";
        let got: Vec<(String, String, &str)> = task_notifications(line)
            .into_iter()
            .map(|n| (n.task_id, n.status, n.block))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "a1".to_string(),
                    "completed".to_string(),
                    "<task-id> a1 </task-id><status>completed</status>"
                ),
                (
                    "a3".to_string(),
                    "failed".to_string(),
                    "<task-id>a3</task-id><status>failed</status>"
                ),
                // Cut off by the end of the line (a torn write): both tags made it.
                (
                    "a4".to_string(),
                    "killed".to_string(),
                    "<task-id>a4</task-id><status>killed</status>"
                ),
            ]
        );
        assert!(task_notifications("no tags here").is_empty());
        assert_eq!(tag("<a></a>", "a"), None, "blank");
        assert_eq!(tag("<a>  </a>", "a"), None, "blank after trim");
        assert_eq!(tag("<a>x", "a"), None, "unclosed");
        assert_eq!(tag("<b>x</b>", "a"), None, "absent");
        assert_eq!(
            tag("<a> x </a><a>y</a>", "a").as_deref(),
            Some("x"),
            "first"
        );
    }

    #[test]
    fn a_records_timestamp_is_its_own_and_optional() {
        let v = |j: &str| serde_json::from_str::<serde_json::Value>(j).unwrap();
        // 2026-10-23T06:41:01.892Z — computed independently (Python `datetime`).
        assert_eq!(
            line_timestamp(&v(r#"{"timestamp":"2026-10-23T06:41:01.892Z"}"#)),
            Some(1_792_737_661_892)
        );
        assert_eq!(line_timestamp(&v(r#"{"type":"api-request-blob"}"#)), None);
        assert_eq!(line_timestamp(&v(r#"{"timestamp":42}"#)), None);
        assert_eq!(line_timestamp(&v(r#"{"timestamp":"yesterday"}"#)), None);
    }

    /// A notification for task `id`; `body` is what tells two instances apart.
    fn note(id: &str, status: &str, body: &str) -> String {
        format!("<task-notification><task-id>{id}</task-id><status>{status}</status>{body}</task-notification>")
    }

    #[test]
    fn copies_of_one_notification_stop_at_the_earliest_stamped_copy() {
        let n = note("a", "completed", "<usage>1</usage>");
        let mut ends = TaskEnds::default();
        // The real order: the enqueue, the attachment 1 ms before it, the delivery
        // and the `remove` seconds later, a request snapshot with no stamp at all.
        ends.absorb(&n, Some(1_000));
        ends.absorb(&n, Some(999));
        ends.absorb(&n, Some(9_000));
        ends.absorb(&n, None);
        assert_eq!(
            ends.latest("a"),
            Some(TaskEnd {
                at: Some(999),
                failed: false
            })
        );
        // An unstamped copy first, a stamped one after: the stamp is adopted.
        let mut late = TaskEnds::default();
        late.absorb(&n, None);
        late.absorb(&n, Some(5));
        assert_eq!(late.latest("a").and_then(|e| e.at), Some(5));
        assert_eq!(ends.latest("never-notified"), None);
    }

    #[test]
    fn a_task_ends_at_its_newest_notification() {
        let mut ends = TaskEnds::default();
        ends.absorb(&note("a", "completed", "<usage>run 1</usage>"), Some(100));
        ends.absorb(&note("a", "failed", "<usage>run 3</usage>"), Some(300));
        ends.absorb(&note("a", "completed", "<usage>run 2</usage>"), Some(200));
        assert_eq!(
            ends.latest("a"),
            Some(TaskEnd {
                at: Some(300),
                failed: true
            }),
            "the newest instance, not the last line read"
        );
        // A notification that no copy stamped counts as the newest.
        ends.absorb(&note("a", "killed", "<usage>run 4</usage>"), None);
        assert_eq!(
            ends.latest("a"),
            Some(TaskEnd {
                at: None,
                failed: false
            })
        );
    }

    #[test]
    fn only_failed_and_error_are_failures_and_a_tie_goes_to_the_failure() {
        for (status, failed) in [
            ("completed", false),
            ("killed", false),
            ("failed", true),
            ("error", true),
        ] {
            let mut ends = TaskEnds::default();
            ends.absorb(&note("a", status, ""), Some(1));
            assert_eq!(ends.latest("a").map(|e| e.failed), Some(failed), "{status}");
        }
        // Two different notifications in the same millisecond, in both read orders.
        for order in [["completed", "failed"], ["failed", "completed"]] {
            let mut ends = TaskEnds::default();
            for status in order {
                ends.absorb(&note("a", status, status), Some(7));
            }
            assert_eq!(ends.latest("a").map(|e| e.failed), Some(true), "{order:?}");
        }
    }

    #[test]
    fn background_end_reads_the_notification_unless_the_agent_wrote_past_it() {
        let end = |at: Option<i64>, failed: bool| Some(TaskEnd { at, failed });
        // No evidence: still working.
        assert_eq!(background_end(None, Some(10), false), None);
        assert_eq!(background_end(None, None, false), None);
        // A notification it has not written past ends it, with its verdict.
        assert_eq!(
            background_end(end(Some(10), false), Some(9), false),
            Some(false)
        );
        assert_eq!(
            background_end(end(Some(10), true), Some(9), false),
            Some(true)
        );
        // The same millisecond is not "past" (measured: the last line precedes the
        // enqueue by 1–460 ms, never follows it).
        assert_eq!(
            background_end(end(Some(10), false), Some(10), false),
            Some(false)
        );
        // A line after the stop is a resume: working again.
        assert_eq!(background_end(end(Some(10), false), Some(11), false), None);
        // …unless the sidecar says finished (the stop the parent never enqueued).
        assert_eq!(
            background_end(end(Some(10), false), Some(11), true),
            Some(false)
        );
        // Without a clock on either side there is nothing to call a resume.
        assert_eq!(background_end(end(None, true), Some(11), false), Some(true));
        assert_eq!(
            background_end(end(Some(10), false), None, false),
            Some(false)
        );
        // `finished` alone ends it, and is never a failure.
        assert_eq!(background_end(None, Some(10), true), Some(false));
        // A failure the agent has not written past beats `finished`.
        assert_eq!(
            background_end(end(Some(10), true), Some(9), true),
            Some(true)
        );
    }
}
