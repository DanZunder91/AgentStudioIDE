//! The `AgentAdapter` trait — **the runtime seam** (ARCHITECTURE §5.3).
//!
//! Exactly one rule: nothing Claude-specific may exist outside `agent/claude.rs`.
//! The supervisor drives agents entirely through this trait, so adding aider/codex
//! is a new impl and nothing else. If you find yourself reaching for a Claude
//! concept in `supervisor/`, it belongs here as a general one.
//!
//! # Identity is dictated, never inferred
//!
//! The load-bearing decision: **we spawn the process, so we tell it
//! who it is** rather than guessing afterwards.
//!
//! cmux built the inference approach and then deleted it; their
//! `agent-session-tracking-spec.md` is the postmortem — *"Never from
//! terminal-title matching. Never from newest-file-by-mtime."* ARCHITECTURE §5.2's
//! original "mangle the cwd into a project-dir path" is that same class of
//! heuristic, and it breaks on a completely ordinary case: **two agents in one
//! cwd**. It is also, measured on macOS, wrong about the path at all — `claude`
//! resolves symlinks, so an agent started in `/tmp/x` writes its transcript under
//! `-private-tmp-x`, not the `-tmp-x` we would have computed.
//!
//! So [`AgentAdapter::spawn`] returns a [`SessionKey`]: the identity the adapter
//! **imposed** on the process. `TerminalId ↔ AgentId ↔ SessionKey` is then a
//! recorded fact, and M3's tailer knows exactly which file belongs to which
//! terminal instead of racing mtimes.

use std::path::Path;

use anyhow::Result;

use crate::agent::fanout::{FanoutResult, TranscriptLocation};
use crate::agent::hook::SessionEvent;
use crate::model::AgentId;
use crate::pty::SpawnSpec;

/// The runtime's own session identity, as dictated by the adapter at spawn.
///
/// **Opaque to the supervisor**, which only stores it and hands it back to the
/// adapter. For `claude-code` it is the `--session-id` UUID; another runtime may
/// use something else entirely. Keeping it a newtype rather than a bare `String`
/// is what stops it from being confused with `AgentId`, `TerminalId`, or the
/// UI-side `SessionId` — four different ids in one system, and this is the only
/// one the *child process* knows about.
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
    /// A **known** session identity to resume rather than mint (pinned
    /// agents). `Some` on boot-restore of a pinned root: the adapter must impose
    /// this exact id and resume its conversation (`claude --resume <id>`) instead
    /// of minting a fresh one, so the same transcript is re-anchored and the
    /// fan-out tailer keeps working. `None` on a normal `+`/⚡ spawn (mint fresh).
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

    /// Resolve the binary, mint (or, when [`SpawnRequest::resume_session_id`] is
    /// set, impose) a session identity, and describe the launch.
    ///
    /// Fails when the runtime is not installed — a normal, actionable condition
    /// (the user simply hasn't got `claude`), so it must surface as an error the
    /// UI can show, never a panic or a half-created agent.
    ///
    /// Must be **pure with respect to our process**: no spawning, no global state.
    /// That is what lets `claude.rs` be unit-tested without a real `claude`, which
    /// would otherwise need auth and a network.
    fn spawn(&self, req: &SpawnRequest<'_>) -> Result<AgentSpawn>;

    // ── Ad-hoc detection seam ────────────────────────────────────────────────
    //
    // These carry the Claude-specific parts of the binding hook. The supervisor
    // and the listener speak only `SessionEvent` and the binding rule, both
    // runtime-agnostic. Default impls make ad-hoc detection opt-in per adapter, so
    // a stub/other runtime need not implement them.

    /// Parse a hook POST body (a runtime's `SessionStart`/`SessionEnd` payload) into
    /// a runtime-agnostic [`SessionEvent`]. `None` if the body is not one of this
    /// runtime's session events. **The only place a payload schema is known.**
    fn parse_session_event(&self, _body: &[u8]) -> Option<SessionEvent> {
        None
    }

    /// The settings JSON to install in a plain terminal's `<cwd>/.claude/` so a
    /// bare `claude` the user types picks up the binding hook. `None`
    /// if this runtime has no ad-hoc hook. The command inside reads the injected
    /// `AGENTSTUDIO_*` env and is inert when it is unset, so the file is harmless even
    /// if a `claude` runs in that dir from some unrelated terminal.
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

    /// Locate a root session's transcript from its session id. Claude globs
    /// `~/.claude/projects/*/<session-id>.jsonl` — globbing by the **unique** id
    /// sidesteps the dead cwd→dir mangling entirely (`claude` resolves symlinks).
    /// `None` if not found (yet) or unsupported.
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
