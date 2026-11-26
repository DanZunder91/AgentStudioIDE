//! The Rust↔TS wire contract (ARCHITECTURE §2.5), from outside the crate: round-trips, exact key
//! sets, and the deserialize direction (shapes `src/app/types.ts` must produce). Literals duplicate
//! `types.ts` on purpose: if a rename fails here, the frontend was already broken.

use agent_studio_scaffold_lib::model::{
    AgentEvent, AgentKind, AgentNode, AgentStatus, FleetSnapshot, TerminalKind, TerminalMeta,
    TerminalStatus,
};
use serde_json::{json, Value};

fn meta() -> TerminalMeta {
    TerminalMeta {
        id: "01J0ABCDEF".into(),
        kind: TerminalKind::Terminal,
        title: "zsh".into(),
        cwd: "/tmp".into(),
        cols: 80,
        rows: 24,
        status: TerminalStatus::Live,
        exit_code: None,
        agent_id: None,
    }
}

/// The exact key set — no more, no less. A *new* Rust field silently appearing on
/// the wire is how the TS mirror drifts out of sync without anyone noticing;
/// `types.ts` has to gain the field in the same commit.
#[test]
fn terminal_meta_has_exactly_the_contracted_keys() {
    let v: Value = serde_json::to_value(meta()).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["cols", "cwd", "id", "kind", "rows", "status", "title"]
    );

    let mut full = meta();
    full.exit_code = Some(0);
    full.agent_id = Some("a0000000000000001".into());
    let v: Value = serde_json::to_value(full).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["agentId", "cols", "cwd", "exitCode", "id", "kind", "rows", "status", "title"]
    );
}

/// `exitCode?`/`agentId?` are `?`-optional in TS, so absent must be **omitted**,
/// not `null`. `{ exitCode: null }` fails an `exitCode?: number` check and, worse,
/// `'exitCode' in meta` reads true — a dead terminal that looks alive.
#[test]
fn optional_fields_are_omitted_not_nulled() {
    let v: Value = serde_json::to_value(meta()).unwrap();
    assert!(
        v.get("exitCode").is_none(),
        "exitCode must be omitted, not null"
    );
    assert!(
        v.get("agentId").is_none(),
        "agentId must be omitted, not null"
    );
}

/// `exitCode: 0` must survive — a clean exit is the common case, and a
/// `skip_serializing_if` that ate falsy values would drop it.
#[test]
fn a_zero_exit_code_is_not_dropped() {
    let mut m = meta();
    m.status = TerminalStatus::Exited;
    m.exit_code = Some(0);
    let v: Value = serde_json::to_value(m).unwrap();
    assert_eq!(
        v["exitCode"],
        json!(0),
        "a clean exit (0) must reach the UI"
    );
}

/// Negative exit codes (a signal-terminated child on Unix) must survive as
/// numbers, not be clamped or stringified.
#[test]
fn signal_style_exit_codes_survive() {
    for code in [-1i32, 130, 137, 255] {
        let mut m = meta();
        m.status = TerminalStatus::Exited;
        m.exit_code = Some(code);
        let json = serde_json::to_string(&m).unwrap();
        let back: TerminalMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back.exit_code, Some(code));
    }
}

/// A full round trip: everything the UI sends back must land in the same fields.
#[test]
fn terminal_meta_round_trips() {
    let original = TerminalMeta {
        id: "01J1XYZ".into(),
        kind: TerminalKind::AgentTerminal,
        title: "claude".into(),
        cwd: "/Users/sam/projects/proj".into(),
        cols: 120,
        rows: 40,
        status: TerminalStatus::Exited,
        exit_code: Some(130),
        agent_id: Some("a0000000000000001".into()),
    };
    let back: TerminalMeta = serde_json::from_str(&serde_json::to_string(&original).unwrap())
        .expect("TerminalMeta must round-trip");

    assert_eq!(back.id, original.id);
    assert_eq!(back.kind, original.kind);
    assert_eq!(back.title, original.title);
    assert_eq!(back.cwd, original.cwd);
    assert_eq!(back.cols, original.cols);
    assert_eq!(back.rows, original.rows);
    assert_eq!(back.status, original.status);
    assert_eq!(back.exit_code, original.exit_code);
    assert_eq!(back.agent_id, original.agent_id);
}

/// The deserialize direction, from the literal JSON `types.ts` describes — camelCase
/// keys, kebab-case `kind`, optional fields absent entirely.
#[test]
fn deserializes_the_json_the_frontend_produces() {
    let m: TerminalMeta = serde_json::from_str(
        r#"{"id":"01J0","kind":"agent-terminal","title":"claude","cwd":"/projects",
            "cols":120,"rows":40,"status":"live"}"#,
    )
    .expect("must accept the TS shape");

    assert_eq!(m.kind, TerminalKind::AgentTerminal);
    assert_eq!(m.status, TerminalStatus::Live);
    assert_eq!(m.exit_code, None);
    assert_eq!(m.agent_id, None);
}

/// The literals are the contract, so the wrong-case spellings must be rejected —
/// this is what stops `kind: "agent-terminal"` from quietly becoming
/// `"agentTerminal"` or `"agent_terminal"` on a serde attribute edit.
#[test]
fn wrong_case_literals_are_rejected() {
    for bad in [
        "agentTerminal",
        "agent_terminal",
        "AgentTerminal",
        "Terminal",
    ] {
        let json = format!(r#""{bad}""#);
        assert!(
            serde_json::from_str::<TerminalKind>(&json).is_err(),
            "TerminalKind must not accept {bad:?} — the TS union has no such member"
        );
    }
    for bad in ["Live", "LIVE", "exited ", "running"] {
        let json = format!(r#""{bad}""#);
        assert!(
            serde_json::from_str::<TerminalStatus>(&json).is_err(),
            "TerminalStatus must not accept {bad:?}"
        );
    }
}

/// Enum literals, spelled out. `TerminalKind` is **kebab**-case (an explicit
/// `#[serde(rename)]`) while `TerminalStatus` is snake_case — the one asymmetry in
/// the contract, and the one most likely to be "fixed" into a break.
#[test]
fn enum_literals_match_the_ts_string_unions() {
    let cases: [(TerminalKind, &str); 2] = [
        (TerminalKind::AgentTerminal, r#""agent-terminal""#),
        (TerminalKind::Terminal, r#""terminal""#),
    ];
    for (value, expected) in cases {
        assert_eq!(serde_json::to_string(&value).unwrap(), expected);
        assert_eq!(
            serde_json::from_str::<TerminalKind>(expected).unwrap(),
            value
        );
    }

    let cases: [(TerminalStatus, &str); 2] = [
        (TerminalStatus::Live, r#""live""#),
        (TerminalStatus::Exited, r#""exited""#),
    ];
    for (value, expected) in cases {
        assert_eq!(serde_json::to_string(&value).unwrap(), expected);
        assert_eq!(
            serde_json::from_str::<TerminalStatus>(expected).unwrap(),
            value
        );
    }
}

/// `cols`/`rows` are `u16` in Rust and `number` in TS. Pin the edges: xterm's fit
/// addon can briefly report 0 during layout, and a large monitor is well past 255.
#[test]
fn terminal_dimensions_survive_their_edges() {
    for (rows, cols) in [
        (0u16, 0u16),
        (1, 1),
        (24, 80),
        (300, 1000),
        (u16::MAX, u16::MAX),
    ] {
        let mut m = meta();
        m.rows = rows;
        m.cols = cols;
        let back: TerminalMeta = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!((back.rows, back.cols), (rows, cols));
    }
}

/// Ids and paths cross the wire verbatim: real cwds contain spaces, unicode and
/// (on Windows) backslashes, all of which JSON must escape and unescape cleanly.
#[test]
fn paths_and_ids_survive_escaping() {
    for cwd in [
        r"/Users/sam/My Projects/café",
        r"C:\Users\sam\work\proj",
        "/tmp/quote\"and\\backslash",
        "/tmp/新しい/プロジェクト",
    ] {
        let mut m = meta();
        m.cwd = cwd.to_string();
        let back: TerminalMeta = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(back.cwd, cwd, "cwd corrupted by JSON escaping");
    }
}

// ── M2: the agent slice of the contract ──────────────────────────────────────

fn node() -> AgentNode {
    AgentNode {
        id: "01J0AGENT".into(),
        parent_id: None,
        kind: AgentKind::Orchestrator,
        title: "claude".into(),
        status: AgentStatus::Running,
        branch: "trunk".into(),
        cwd: "/projects/proj".into(),
        runtime: "claude-code".into(),
        started_at: Some(1_700_000_000_000),
        finished_at: None,
        last_activity_at: 1_700_000_000_500,
        error: None,
    }
}

/// `childIds`/`sessionId`/`expanded`/`unread` are store-maintained in `types.ts` and must never be
/// sent: the UI owns that state, and its `sessionId` is the UI layout Session, unknown to Rust.
#[test]
fn agent_node_sends_the_wire_fields_and_no_ui_fields() {
    let v: Value = serde_json::to_value(node()).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "branch",
            "cwd",
            "finishedAt",
            "id",
            "kind",
            "lastActivityAt",
            "parentId",
            "runtime",
            "startedAt",
            "status",
            "title",
        ]
    );
    for ui_only in ["childIds", "sessionId", "expanded", "unread"] {
        assert!(
            v.get(ui_only).is_none(),
            "{ui_only} is store-maintained and must not cross the wire"
        );
    }
}

/// `parentId: null` is meaningful — it is what marks a **root orchestrator**
/// (`parentId: AgentId | null`), so unlike `error?` it must be sent, not omitted.
#[test]
fn a_root_agents_null_parent_is_sent_not_omitted() {
    let v: Value = serde_json::to_value(node()).unwrap();
    assert_eq!(
        v["parentId"],
        Value::Null,
        "parentId must be present and null for roots"
    );
    assert!(v.as_object().unwrap().contains_key("parentId"));
    // Same for the nullable timestamps.
    assert_eq!(v["finishedAt"], Value::Null);
}

/// `error?` is optional in TS, so absent means omitted — a present `error: null`
/// reads as truthy-in-key checks and would mark healthy agents as failed.
#[test]
fn agent_error_is_omitted_when_absent_and_sent_when_present() {
    assert!(serde_json::to_value(node()).unwrap().get("error").is_none());

    let mut failed = node();
    failed.status = AgentStatus::Error;
    failed.error = Some("exited with code 9".into());
    let v: Value = serde_json::to_value(failed).unwrap();
    assert_eq!(v["status"], json!("error"));
    assert_eq!(v["error"], json!("exited with code 9"));
}

#[test]
fn agent_node_round_trips() {
    let original = node();
    let back: AgentNode =
        serde_json::from_str(&serde_json::to_string(&original).unwrap()).expect("must round-trip");
    assert_eq!(back.id, original.id);
    assert_eq!(back.kind, original.kind);
    assert_eq!(back.status, original.status);
    assert_eq!(back.branch, original.branch);
    assert_eq!(back.runtime, original.runtime);
    assert_eq!(back.started_at, original.started_at);
    assert_eq!(back.last_activity_at, original.last_activity_at);
}

/// Every literal of both string unions, spelled out (`types.ts` lines 34-35).
#[test]
fn agent_enums_match_the_ts_string_unions() {
    let statuses: [(AgentStatus, &str); 5] = [
        (AgentStatus::Idle, r#""idle""#),
        (AgentStatus::Running, r#""running""#),
        (AgentStatus::WaitingInput, r#""waiting_input""#),
        (AgentStatus::Done, r#""done""#),
        (AgentStatus::Error, r#""error""#),
    ];
    for (v, expected) in statuses {
        assert_eq!(serde_json::to_string(&v).unwrap(), expected);
        assert_eq!(serde_json::from_str::<AgentStatus>(expected).unwrap(), v);
    }

    let kinds: [(AgentKind, &str); 2] = [
        (AgentKind::Orchestrator, r#""orchestrator""#),
        (AgentKind::Subagent, r#""subagent""#),
    ];
    for (v, expected) in kinds {
        assert_eq!(serde_json::to_string(&v).unwrap(), expected);
        assert_eq!(serde_json::from_str::<AgentKind>(expected).unwrap(), v);
    }

    // `waiting_input` is snake_case, NOT the kebab-case TerminalKind uses. That
    // asymmetry is the contract's sharpest edge.
    assert_ne!(
        serde_json::to_string(&AgentStatus::WaitingInput).unwrap(),
        r#""waiting-input""#
    );
}

/// `AgentEvent` is tagged by `t` with camelCase payload fields — the discriminated
/// union `bridge.ts` switches on.
#[test]
fn agent_events_match_the_tagged_union() {
    let started = AgentEvent::AgentStarted {
        agent_id: "01J0".into(),
        parent_id: None,
        title: "claude".into(),
        cwd: "/projects".into(),
        branch: "trunk".into(),
        runtime: "claude-code".into(),
    };
    let v: Value = serde_json::to_value(&started).unwrap();
    assert_eq!(v["t"], json!("agent_started"));
    assert_eq!(v["agentId"], json!("01J0"));
    assert_eq!(v["parentId"], Value::Null);
    assert_eq!(v["runtime"], json!("claude-code"));

    let exited = AgentEvent::Exited {
        agent_id: "01J0".into(),
        code: 130,
    };
    let v: Value = serde_json::to_value(&exited).unwrap();
    assert_eq!(v["t"], json!("exited"));
    assert_eq!(v["code"], json!(130));

    let status = AgentEvent::Status {
        agent_id: "01J0".into(),
        status: AgentStatus::WaitingInput,
    };
    let v: Value = serde_json::to_value(&status).unwrap();
    assert_eq!(v["t"], json!("status"));
    assert_eq!(v["status"], json!("waiting_input"));

    // M3's headline, contract-complete even though M2 never constructs one.
    let spawned = AgentEvent::SubagentSpawned {
        parent_id: "01J0".into(),
        child_agent_id: "a0000000000000001".into(),
        title: "Explore".into(),
        cwd: "/projects".into(),
        branch: "trunk".into(),
        runtime: "claude-code".into(),
    };
    let v: Value = serde_json::to_value(&spawned).unwrap();
    assert_eq!(v["t"], json!("subagent_spawned"));
    assert_eq!(v["childAgentId"], json!("a0000000000000001"));
    assert_eq!(v["parentId"], json!("01J0"));

    let activity = AgentEvent::Activity {
        agent_id: "01J0".into(),
        at: 1_700_000_000_000,
    };
    assert_eq!(
        serde_json::to_value(&activity).unwrap()["t"],
        json!("activity")
    );
    let title = AgentEvent::Title {
        agent_id: "01J0".into(),
        title: "renamed".into(),
    };
    assert_eq!(serde_json::to_value(&title).unwrap()["t"], json!("title"));
}

/// `fleet_snapshot`'s shape: `{ agents, terminals }` (ARCHITECTURE §2.4).
#[test]
fn fleet_snapshot_matches_the_documented_shape() {
    let snap = FleetSnapshot {
        agents: vec![node()],
        terminals: vec![meta()],
    };
    let v: Value = serde_json::to_value(&snap).unwrap();

    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["agents", "terminals"]);
    assert!(v["agents"].is_array() && v["terminals"].is_array());
    assert_eq!(v["agents"][0]["runtime"], json!("claude-code"));
    assert_eq!(v["terminals"][0]["kind"], json!("terminal"));

    // Empty is a valid snapshot — it is what the UI gets on boot. It must be
    // `[]`, never `null`, or the reducer's `.map` throws.
    let empty = FleetSnapshot {
        agents: vec![],
        terminals: vec![],
    };
    let v: Value = serde_json::to_value(&empty).unwrap();
    assert_eq!(v["agents"], json!([]));
    assert_eq!(v["terminals"], json!([]));
}

/// Timestamps are epoch **milliseconds** (TS `number`), and must survive past the
/// i32 boundary — epoch ms passed 2^31 in 1970 terms long ago.
#[test]
fn timestamps_are_millisecond_precision_and_not_truncated() {
    let mut n = node();
    let ms = 1_767_225_600_123i64; // 2026-01-01T00:00:00.123Z
    n.started_at = Some(ms);
    n.last_activity_at = ms;
    let v: Value = serde_json::to_value(&n).unwrap();
    assert_eq!(
        v["startedAt"],
        json!(ms),
        "timestamp truncated (i32 overflow?)"
    );

    let back: AgentNode = serde_json::from_value(v).unwrap();
    assert_eq!(back.started_at, Some(ms));
    assert_eq!(back.last_activity_at, ms);
}
