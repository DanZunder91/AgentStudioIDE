//! THE CONTRACT: canonical wire types, mirrored in `src/app/types.ts` (ARCHITECTURE §2.5).
//! Structs → camelCase, enums → snake_case. Never fork these; change here AND in `types.ts`
//! AND note it in ARCHITECTURE.md §2.

use serde::{Deserialize, Serialize};

/// Fan-out tree node id — ULID, or Claude's own `agentId` for sub-agents.
pub type AgentId = String;

/// 1:1 with a Rust PTY handle. ULID string; the id *is* the handle (§2.0).
pub type TerminalId = String;

/// TS: `type AgentStatus = 'idle' | 'running' | 'waiting_input' | 'done' | 'error'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Running,
    WaitingInput,
    Done,
    Error,
}

/// TS: `type AgentKind = 'orchestrator' | 'subagent'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Orchestrator,
    Subagent,
}

/// A fan-out tree node, wire shape only: `types.ts` adds store-maintained `childIds`,
/// `sessionId` (the UI layout Session, not the runtime's), `expanded`, `unread`; never send them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNode {
    pub id: AgentId,
    /// `None` => root orchestrator. Sub-agent edges arrive in M3.
    pub parent_id: Option<AgentId>,
    pub kind: AgentKind,
    pub title: String,
    pub status: AgentStatus,
    /// Git branch of `cwd`; empty string when the directory is not a repo.
    pub branch: String,
    pub cwd: String,
    /// The `AgentAdapter` id, e.g. `"claude-code"`.
    pub runtime: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_activity_at: i64,
    /// Error detail — flat and optional, so the JSON `status` stays a string union.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The ONLY payload on `agent://event` (ARCHITECTURE §2.5), tagged by `t`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    AgentStarted {
        agent_id: AgentId,
        parent_id: Option<AgentId>,
        title: String,
        cwd: String,
        branch: String,
        runtime: String,
    },
    #[serde(rename_all = "camelCase")]
    SubagentSpawned {
        parent_id: AgentId,
        child_agent_id: AgentId,
        title: String,
        cwd: String,
        branch: String,
        runtime: String,
    },
    #[serde(rename_all = "camelCase")]
    Status {
        agent_id: AgentId,
        status: AgentStatus,
    },
    #[serde(rename_all = "camelCase")]
    Activity { agent_id: AgentId, at: i64 },
    #[serde(rename_all = "camelCase")]
    Exited { agent_id: AgentId, code: i32 },
    #[serde(rename_all = "camelCase")]
    Title { agent_id: AgentId, title: String },
}

/// Return of `fleet_snapshot`: the initial paint and the restart/re-attach path, and how a
/// terminal's death (`status`/`exitCode`) becomes visible.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSnapshot {
    pub agents: Vec<AgentNode>,
    pub terminals: Vec<TerminalMeta>,
}

/// One line of a sub-agent's activity feed (it has no PTY), returned chronologically by
/// `subagent_activity`. TS mirror: `interface ActivityEntry`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// `"user"` | `"assistant"` | `"tool"` | `"tool_result"`.
    pub role: String,
    /// The prompt / assistant text / tool-input summary / tool-result summary,
    /// truncated (~2 KB).
    pub text: String,
    /// The tool name, for a `role: "tool"` entry (an `Agent`-tool / `Read` / …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Epoch milliseconds, parsed from the transcript line's ISO timestamp; `0` if
    /// absent/unparseable.
    pub timestamp: i64,
}

/// One file-tree entry, returned by `read_dir` (dirs first, then case-insensitive). TS mirror:
/// `FsEntry`; `path` is absolute, passed back to `read_dir` to expand.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    /// The entry's own name (final path component), e.g. `src` or `main.rs`.
    pub name: String,
    /// Absolute path to the entry — the argument to a follow-up `read_dir`.
    pub path: String,
    /// `true` for a directory (expandable), `false` for a file.
    pub is_dir: bool,
}

/// Options for `find_in_files`. Booleans default false, `glob` `None`, so
/// the FE can send a partial object. TS: `interface FindOptions { regex?: boolean;
/// caseSensitive?: boolean; wholeWord?: boolean; glob?: string }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FindOptions {
    /// `false` → literal search (the query is escaped); `true` → the query is a regex.
    pub regex: bool,
    pub case_sensitive: bool,
    /// Wrap the pattern in word boundaries.
    pub whole_word: bool,
    /// A file mask (e.g. `*.rs`, `*.{kt,java}`) applied as an `ignore` override.
    pub glob: Option<String>,
}

/// One search hit (TS `Match`): `file` relative to the search root, `line`/`col` 1-based,
/// `matchStart`/`matchEnd` BYTE offsets within `lineText`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub line_text: String,
    pub match_start: u32,
    pub match_end: u32,
}

/// The result of `find_in_files`. `truncated` is `true` when the result cap was hit
/// (there are more matches than returned). TS: `interface FindResult { matches:
/// Match[]; truncated: boolean }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub matches: Vec<Match>,
    pub truncated: bool,
}

/// TS: `type LspStatus = 'running' | 'not_installed'`. `running` = the
/// server spawned and its relay is live; `not_installed` = no binary was found (the
/// feature is simply off, with a calm install hint), never an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspStatus {
    Running,
    NotInstalled,
}

/// Result of `lsp_start` (TS `LspStartInfo`); `serverId` is minted here for `lsp_send`/`lsp_stop`.
/// `installHint` only for `not_installed`; both optionals are omitted, not `null`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LspStartInfo {
    pub server_id: String,
    pub language_id: String,
    pub status: LspStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
}

/// TS: `type TerminalKind = 'agent-terminal' | 'terminal'`.
///
/// The literals are kebab-case, not snake_case — hence the explicit renames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalKind {
    #[serde(rename = "agent-terminal")]
    AgentTerminal,
    #[serde(rename = "terminal")]
    Terminal,
}

/// TS: `type TerminalStatus = 'live' | 'exited'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Live,
    Exited,
}

/// PTY metadata, never bytes; returned by `terminal_open`. `exitCode`/`agentId` are omitted
/// (not `null`) when absent, matching TS `?` optionals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    pub id: TerminalId,
    pub kind: TerminalKind,
    pub title: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The serde output must match `src/app/types.ts` exactly — the frontend is
    /// built against these literals.
    #[test]
    fn terminal_meta_matches_ts_contract() {
        let meta = TerminalMeta {
            id: "01J0".into(),
            kind: TerminalKind::Terminal,
            title: "zsh".into(),
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
            status: TerminalStatus::Live,
            exit_code: None,
            agent_id: None,
        };
        // camelCase fields; `?`-optional fields omitted rather than null.
        assert_eq!(
            serde_json::to_string(&meta).unwrap(),
            r#"{"id":"01J0","kind":"terminal","title":"zsh","cwd":"/tmp","cols":80,"rows":24,"status":"live"}"#
        );
    }

    /// The file-tree entry must serialize with `isDir` (camelCase) — the frontend's
    /// `FsEntry` is built against exactly that field name.
    #[test]
    fn fs_entry_matches_ts_contract() {
        let entry = FsEntry {
            name: "src".into(),
            path: "/projects/src".into(),
            is_dir: true,
        };
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"name":"src","path":"/projects/src","isDir":true}"#
        );
    }

    /// `LspStartInfo` must serialize camelCase, with `installHint` omitted when
    /// absent and `status` a snake_case string union — the frontend is built to it.
    #[test]
    fn lsp_start_info_matches_ts_contract() {
        let running = LspStartInfo {
            server_id: "01J".into(),
            language_id: "rust".into(),
            status: LspStatus::Running,
            install_hint: None,
            server_name: Some("rust-analyzer".into()),
        };
        assert_eq!(
            serde_json::to_string(&running).unwrap(),
            r#"{"serverId":"01J","languageId":"rust","status":"running","serverName":"rust-analyzer"}"#
        );

        let absent = LspStartInfo {
            server_id: "01K".into(),
            language_id: "rust".into(),
            status: LspStatus::NotInstalled,
            install_hint: Some("rustup component add rust-analyzer".into()),
            server_name: Some("rust-analyzer".into()),
        };
        assert_eq!(
            serde_json::to_string(&absent).unwrap(),
            r#"{"serverId":"01K","languageId":"rust","status":"not_installed","installHint":"rustup component add rust-analyzer","serverName":"rust-analyzer"}"#
        );
    }

    /// `FindResult`/`Match` must serialize camelCase — the Find panel is built to it.
    #[test]
    fn find_result_matches_ts_contract() {
        let result = FindResult {
            matches: vec![Match {
                file: "src/main.rs".into(),
                line: 12,
                col: 5,
                line_text: "let needle = 1;".into(),
                match_start: 4,
                match_end: 10,
            }],
            truncated: true,
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"matches":[{"file":"src/main.rs","line":12,"col":5,"lineText":"let needle = 1;","matchStart":4,"matchEnd":10}],"truncated":true}"#
        );
    }

    /// `FindOptions` accepts a partial object (missing fields default false / None).
    #[test]
    fn find_options_deserializes_partial_camelcase() {
        let o: FindOptions = serde_json::from_str(r#"{"regex":true,"wholeWord":true}"#).unwrap();
        assert!(o.regex);
        assert!(o.whole_word);
        assert!(!o.case_sensitive);
        assert!(o.glob.is_none());
    }

    #[test]
    fn terminal_enums_match_ts_string_unions() {
        assert_eq!(
            serde_json::to_string(&TerminalKind::AgentTerminal).unwrap(),
            r#""agent-terminal""#
        );
        assert_eq!(
            serde_json::to_string(&TerminalKind::Terminal).unwrap(),
            r#""terminal""#
        );
        assert_eq!(
            serde_json::to_string(&TerminalStatus::Live).unwrap(),
            r#""live""#
        );
        assert_eq!(
            serde_json::to_string(&TerminalStatus::Exited).unwrap(),
            r#""exited""#
        );
    }

    #[test]
    fn exited_terminal_carries_exit_code() {
        let meta = TerminalMeta {
            id: "01J1".into(),
            kind: TerminalKind::AgentTerminal,
            title: "claude".into(),
            cwd: "/projects".into(),
            cols: 120,
            rows: 40,
            status: TerminalStatus::Exited,
            exit_code: Some(0),
            agent_id: Some("a53ed1b9".into()),
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains(r#""status":"exited""#));
        assert!(json.contains(r#""exitCode":0"#));
        assert!(json.contains(r#""agentId":"a53ed1b9""#));
        assert!(json.contains(r#""kind":"agent-terminal""#));
    }
}
