//! `AgentAdapter`, the runtime seam (ARCHITECTURE §5.3): nothing Claude-specific outside
//! `agent/claude.rs`. Identity is dictated, never inferred: spawn imposes a [`SessionKey`], since
//! cwd/mtime heuristics break on two agents in one cwd and on symlinks `claude` resolves.

use std::path::Path;

use anyhow::Result;

use crate::agent::fanout::{FanoutResult, TranscriptLocation};
use crate::agent::hook::SessionEvent;
use crate::model::AgentId;
use crate::pty::SpawnSpec;

/// Opaque to the supervisor (for Claude, the `--session-id` UUID); a newtype so it is not confused
/// with `AgentId`, `TerminalId` or the UI's `SessionId`. The only id the child process knows.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey(pub String);

impl SessionKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Everything the supervisor knows about an agent before its process exists.
#[derive(Debug, Clone)]
pub struct SpawnRequest<'a> {
    /// Our id for the agent (a ULID). Distinct from [`SessionKey`]: this one is
    /// ours and crosses the wire; that one is the runtime's and does not.
    pub agent_id: &'a AgentId,
    pub cwd: &'a Path,
    /// Seed prompt, if the caller had one. M2's `agent_spawn` passes `None` and
    /// lets the user type; the parameter exists because ARCHITECTURE §5.3
    /// specifies it and M3+ will seed agents programmatically.
    pub prompt: Option<&'a str>,
    /// `Some` on boot-restore of a pinned root: impose and resume this id so the same transcript is
    /// re-anchored for the tailer. `None` mints a fresh one.
    pub resume_session_id: Option<&'a SessionKey>,
    pub rows: u16,
    pub cols: u16,
}

/// How to launch the runtime, plus the identity the adapter bound to it.
#[derive(Debug, Clone)]
pub struct AgentSpawn {
    /// Handed straight to `pty::spawn_pty` — the same path plain terminals use.
    pub spec: SpawnSpec,
    /// The identity imposed on the process; stored by the supervisor for M3.
    pub session_key: SessionKey,
}

/// A supervised agent runtime (the extension point for new runtimes).
pub trait AgentAdapter: Send + Sync {
    /// Stable identifier, e.g. `"claude-code"`. Crosses the wire verbatim as
    /// `AgentNode.runtime`, and is what `agent_spawn`'s `runtime` argument selects.
    fn id(&self) -> &'static str;

    /// Tab/node title for a freshly spawned agent, before any telemetry renames it.
    fn default_title(&self) -> &'static str;

    /// Not installed must be an error the UI can show, never a panic or a half-created agent.
    /// Pure with respect to our process (no spawning, no global state): testable without `claude`.
    fn spawn(&self, req: &SpawnRequest<'_>) -> Result<AgentSpawn>;

    // ── Ad-hoc detection seam: Claude's binding-hook parts; the defaults make it opt-in ──

    /// Parse a hook POST body (a runtime's `SessionStart`/`SessionEnd` payload) into
    /// a runtime-agnostic [`SessionEvent`]. `None` if the body is not one of this
    /// runtime's session events. **The only place a payload schema is known.**
    fn parse_session_event(&self, _body: &[u8]) -> Option<SessionEvent> {
        None
    }

    /// Settings JSON for a plain terminal's `<cwd>/.claude/`, so a typed `claude` gets the binding
    /// hook. Inert without the injected `AGENTSTUDIO_*` env, so harmless for an unrelated `claude`.
    fn ad_hoc_hook_settings(&self) -> Option<serde_json::Value> {
        None
    }

    /// A stable substring identifying *our* hook inside a settings file, so a merge
    /// can be idempotent (don't append a second copy) and reversible. `None` mirrors
    /// [`Self::ad_hoc_hook_settings`] being `None`.
    fn hook_marker(&self) -> Option<&'static str> {
        None
    }

    // ── Fan-out seam (M3, ARCHITECTURE §5) ───────────────────────────────────

    /// Claude globs `~/.claude/projects/*/<session-id>.jsonl`: the unique id sidesteps cwd→dir
    /// mangling (`claude` resolves symlinks). `None` if not found yet or unsupported.
    fn locate_transcript(&self, _session_id: &str) -> Option<TranscriptLocation> {
        None
    }

    /// Reconstruct the fan-out tree for a located root session. Default: no fan-out.
    fn parse_fanout(&self, _loc: &TranscriptLocation, _root_id: &AgentId) -> FanoutResult {
        FanoutResult::default()
    }

    // ── Agent Logs seam ──────────────────────────────────────────────────────

    /// Every transcript under a located root session, as `(agent_id, path)`: the root's
    /// own (attributed to `root_id`) plus one per sub-agent. The files need not exist
    /// yet. Default: none, so a runtime without transcripts contributes no tool lines.
    fn tool_transcripts(
        &self,
        _loc: &TranscriptLocation,
        _root_id: &AgentId,
    ) -> Vec<(AgentId, std::path::PathBuf)> {
        Vec::new()
    }

    /// The tool calls / results on one transcript line. **The only place the line
    /// schema is known**; [`crate::agent::tools`] does the tailing and dedupe.
    fn parse_tool_line(&self, _line: &str) -> Vec<crate::agent::tools::ToolBlock> {
        Vec::new()
    }

    /// Where a background task's output goes when its start result did not say
    /// (Claude's `Monitor`). Nothing here is read
    /// or created; the log tail validates whatever this returns. Default: unknown.
    fn task_output_path(
        &self,
        _loc: &TranscriptLocation,
        _task_id: &str,
    ) -> Option<std::path::PathBuf> {
        None
    }
}
