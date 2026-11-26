//! Runtime-agnostic types for ad-hoc agent detection; Claude specifics stay behind `AgentAdapter`.
//! The env vars below are ours, injected into every PTY, so a `claude` typed into a plain shell
//! inherits them and can phone home.

/// The terminal's `TerminalId`. A hook echoes it back so we know which of our PTYs
/// the session is running in — the id we *dictate* (adapter.rs's philosophy), since
/// for a bare `claude` we cannot dictate the session id.
pub const ENV_TERMINAL_ID: &str = "AGENTSTUDIO_TERMINAL_ID";

/// This app instance's callback base URL (ephemeral port). Per-instance, so two
/// running apps never cross-bind (FM-2): each instance's PTYs phone home to that
/// instance's own listener.
pub const ENV_HOOK_URL: &str = "AGENTSTUDIO_HOOK_URL";

/// Per-launch secret the hook echoes back; the listener rejects requests without it, so no other
/// local process can post a phantom agent.
pub const ENV_HOOK_TOKEN: &str = "AGENTSTUDIO_HOOK_TOKEN";

/// HTTP header the hook carries the token in.
pub const HEADER_TOKEN: &str = "X-AgentStudio-Token";
/// HTTP header the hook carries the terminal id in.
pub const HEADER_TERMINAL: &str = "X-AgentStudio-Terminal";

/// The whole runtime-to-core detection contract: the supervisor never sees raw payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvent {
    pub kind: SessionEventKind,
    /// The runtime's own session id (for `claude`, the `session_id`). Becomes the
    /// bound value in the terminal→session table and the ad-hoc agent's
    /// `SessionKey`.
    pub session_id: String,
    /// Absolute path to the transcript the runtime is writing. Present on `Start`;
    /// may be absent on `End`. Stored for M3's tailer so it never has to *compute*
    /// a path (the cwd→dir mangling is dead — `claude` resolves symlinks).
    pub transcript_path: Option<String>,
    /// The payload's `cwd`: where the runtime actually runs (the user may `cd` before `claude`).
    /// Preferred over the terminal's meta cwd when promoting an ad-hoc root.
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEventKind {
    /// Session birth — the bind signal. Fires once, carries stable identity, and
    /// (decisively) fires even under `--dangerously-skip-permissions`.
    Start,
    /// Session end — one of the two unbind signals (the other is PTY child exit,
    /// which we own, because `SessionEnd` is not guaranteed on a hard kill).
    End,
    /// A turn began — the user submitted a prompt, so the agent is now working
    /// (`UserPromptSubmit`). → `AgentStatus::Running` (the real idle/running signal).
    Busy,
    /// A turn ended — the agent finished responding and is parked at its prompt
    /// (`Stop`). → `AgentStatus::Idle`. This is the signal that was missing, so a
    /// root agent's pill was latched on "Running" forever.
    Idle,
    /// The agent is blocked awaiting the user — a permission prompt or an input
    /// request (`Notification`). → `AgentStatus::WaitingInput`.
    AwaitingInput,
}
