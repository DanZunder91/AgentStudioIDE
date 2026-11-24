//! Runtime-agnostic fan-out types (ARCHITECTURE §5).
//!
//! The supervisor speaks only these; the Claude-specific *derivation* of them from
//! transcripts + `.meta.json` sidecars lives in `agent/claude.rs`. An aider/codex
//! adapter would produce the same shapes from its own telemetry.

/// A sub-agent the tailer detected in a runtime's telemetry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FanoutAgent {
    /// The runtime's own id for the sub-agent (Claude's `agentId`). Used verbatim
    /// as the wire `AgentId` (ARCHITECTURE §2.0).
    pub agent_id: String,
    /// The **parent** — another sub-agent's id, or the root agent's id for a
    /// top-level (depth-1) spawn.
    pub parent_id: String,
    /// Display title (Claude's Agent-tool `description` / sidecar `description`).
    pub title: String,
    /// The runtime's sub-agent kind (Claude's `subagent_type`/`agentType`, e.g.
    /// `general-purpose`, `Explore`).
    pub kind: String,
    /// Nesting depth reported by the runtime, if any (Claude's `spawnDepth`).
    /// `None` on older CLIs — the tree still reconstructs from `parent_id`.
    pub spawn_depth: Option<u32>,
    pub status: FanoutStatus,
    pub cwd: String,
    pub branch: String,
}

/// Per-agent status derived from the transcript — **independently for each agent**,
/// which is what keeps a child finishing from greying its parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FanoutStatus {
    /// Spawned, no end observed yet. For Claude: no `tool_result` for a foreground
    /// launch; for a BACKGROUND launch (whose `tool_result` is only the launch ack)
    /// no task notification it has not written past, no `finished` flag, and not
    /// silent for `claude::SUBAGENT_STALE_MS`.
    Running,
    /// The parent's transcript carries a successful `tool_result` for this agent —
    /// or, for a background one, a `completed`/`killed` notification, its sidecar's
    /// `finished`, or the silence above.
    Done,
    /// …carries a `tool_result` with `is_error: true`, or a `failed` notification.
    Error,
}

/// The reconstructed tree plus any cross-check disagreements. A mismatch is
/// **logged, not silently resolved**: if the sidecar's `parentAgentId`
/// and the `Agent`-tool edge disagree, drawing either as truth silently could paint
/// a wrong tree, so we surface it.
#[derive(Debug, Clone, Default)]
pub struct FanoutResult {
    pub agents: Vec<FanoutAgent>,
    /// `(agent_id, sidecar_parent, edge_parent)` — the two sources disagreed.
    pub edge_mismatches: Vec<(String, String, String)>,
}

/// Where a runtime's transcript for one root session lives. Produced by the adapter
/// (Claude knows the `~/.claude/projects/` layout); consumed by the generic tailer.
#[derive(Debug, Clone)]
pub struct TranscriptLocation {
    pub root_transcript: std::path::PathBuf,
    pub subagents_dir: std::path::PathBuf,
}

/// A change the tailer observed between two parses. The supervisor turns these into
/// `AgentEvent`s. Deliberately minimal — existence + status, the M3 headline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FanoutDelta {
    /// A sub-agent we hadn't seen. → `AgentEvent::SubagentSpawned` + a node.
    Spawned(FanoutAgent),
    /// A known sub-agent's status changed. → `AgentEvent::Status`.
    StatusChanged {
        agent_id: String,
        status: FanoutStatus,
    },
}

/// Diff a fresh parse against what we've already emitted — **pure**, so the
/// tailer's decision logic is unit-testable without any I/O.
///
/// `known` maps `agent_id → last emitted status`. Returns a `Spawned` for each new
/// agent and a `StatusChanged` for each status transition, in a deterministic order
/// (sorted by id). The parent-stays-running invariant is upheld structurally: each
/// agent's status is compared only to its own prior value.
pub fn diff_fanout(
    known: &std::collections::HashMap<String, FanoutStatus>,
    current: &[FanoutAgent],
) -> Vec<FanoutDelta> {
    let mut deltas = Vec::new();
    // Ordered **shallowest-first** so a `Spawned` for a parent is always emitted
    // before its children: a depth-2 agent's parent is depth-1, so ascending depth
    // guarantees parent-before-child. Without this, a child could reach the UI
    // before its parent node exists and be dropped. Id is the tiebreaker for
    // determinism. (`None` depth — older CLIs — sorts first; those parent to the
    // root, which always exists.)
    let mut sorted: Vec<&FanoutAgent> = current.iter().collect();
    sorted.sort_by(|a, b| {
        a.spawn_depth
            .unwrap_or(0)
            .cmp(&b.spawn_depth.unwrap_or(0))
            .then_with(|| a.agent_id.cmp(&b.agent_id))
    });
    for agent in sorted {
        match known.get(&agent.agent_id) {
            None => deltas.push(FanoutDelta::Spawned(agent.clone())),
            Some(prev) if *prev != agent.status => deltas.push(FanoutDelta::StatusChanged {
                agent_id: agent.agent_id.clone(),
                status: agent.status,
            }),
            Some(_) => {}
        }
    }
    deltas
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn agent(id: &str, parent: &str, status: FanoutStatus) -> FanoutAgent {
        FanoutAgent {
            agent_id: id.into(),
            parent_id: parent.into(),
            title: "t".into(),
            kind: "general-purpose".into(),
            spawn_depth: Some(1),
            status,
            cwd: "/w".into(),
            branch: "main".into(),
        }
    }

    #[test]
    fn a_never_seen_agent_is_spawned() {
        let known = HashMap::new();
        let cur = vec![agent("a", "root", FanoutStatus::Running)];
        let d = diff_fanout(&known, &cur);
        assert_eq!(d.len(), 1);
        assert!(matches!(&d[0], FanoutDelta::Spawned(a) if a.agent_id == "a"));
    }

    #[test]
    fn a_known_agent_with_the_same_status_yields_nothing() {
        let mut known = HashMap::new();
        known.insert("a".to_string(), FanoutStatus::Running);
        let cur = vec![agent("a", "root", FanoutStatus::Running)];
        assert!(
            diff_fanout(&known, &cur).is_empty(),
            "no change => no delta"
        );
    }

    #[test]
    fn a_status_transition_yields_status_changed() {
        let mut known = HashMap::new();
        known.insert("a".to_string(), FanoutStatus::Running);
        let cur = vec![agent("a", "root", FanoutStatus::Done)];
        let d = diff_fanout(&known, &cur);
        assert_eq!(
            d,
            vec![FanoutDelta::StatusChanged {
                agent_id: "a".into(),
                status: FanoutStatus::Done
            }]
        );
    }

    /// **The parent-stays-running invariant, at the diff layer**: a child going
    /// `Running → Done` produces a delta *only* for that child. The parent's entry
    /// is compared solely to its own prior status, so it never appears.
    #[test]
    fn a_child_finishing_does_not_produce_a_delta_for_the_parent() {
        let mut known = HashMap::new();
        known.insert("parent".to_string(), FanoutStatus::Running);
        known.insert("child".to_string(), FanoutStatus::Running);
        let cur = vec![
            agent("parent", "root", FanoutStatus::Running), // unchanged
            agent("child", "parent", FanoutStatus::Done),   // finished
        ];
        let d = diff_fanout(&known, &cur);
        assert_eq!(d.len(), 1, "only the child changed");
        assert!(
            matches!(&d[0], FanoutDelta::StatusChanged { agent_id, .. } if agent_id == "child")
        );
    }

    #[test]
    fn deltas_are_deterministically_ordered_by_id() {
        let known = HashMap::new();
        let cur = vec![
            agent("c", "root", FanoutStatus::Running),
            agent("a", "root", FanoutStatus::Running),
            agent("b", "root", FanoutStatus::Running),
        ];
        let ids: Vec<String> = diff_fanout(&known, &cur)
            .into_iter()
            .map(|d| match d {
                FanoutDelta::Spawned(a) => a.agent_id,
                FanoutDelta::StatusChanged { agent_id, .. } => agent_id,
            })
            .collect();
        assert_eq!(ids, ["a", "b", "c"]);
    }
}
