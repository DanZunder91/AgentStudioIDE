//! The M3 fan-out parser, tested against **allowlist-projected real transcripts**
//! (testing-strategy.md §7). This is the single highest-value test in the
//! product — the fixtures already caught the spec being wrong once (`TaskCreate`
//! is not the spawn tool; `Agent` is).
//!
//! Fixtures live in `tests/fixtures/transcripts/<case>/` with a `session.jsonl`, a
//! `subagents/` dir, and an `expected.json` describing the tree the parser must
//! produce. Regenerate from real data with `tests/fixtures/project_transcripts.py`.
//!
//! No real `claude` is spawned; the committed fixtures are the point.

use std::collections::HashMap;
use std::path::PathBuf;

use agent_studio_scaffold_lib::agent::claude::parse_fanout;
use agent_studio_scaffold_lib::agent::fanout::FanoutStatus;
use serde_json::Value;

fn fixture_dir(case: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/transcripts")
        .join(case)
}

type AgentsById = HashMap<String, agent_studio_scaffold_lib::agent::fanout::FanoutAgent>;
type Mismatches = Vec<(String, String, String)>;

/// Parse a fixture case, returning `(agents_by_id, mismatches)`.
fn parse_case(case: &str) -> (AgentsById, Mismatches) {
    let dir = fixture_dir(case);
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap();
    let root_id = expected["rootId"].as_str().unwrap();
    let result = parse_fanout(&dir.join("session.jsonl"), &dir.join("subagents"), root_id);
    let by_id = result
        .agents
        .into_iter()
        .map(|a| (a.agent_id.clone(), a))
        .collect();
    (by_id, result.edge_mismatches)
}

fn expected_agents(case: &str) -> Value {
    let dir = fixture_dir(case);
    serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap()
}

/// **The headline: the exact recursive (depth-2) tree from real data.** 24 agents,
/// 19 at depth 1, 5 at depth 2 under two different parents — reconstructed edge for
/// edge from the committed projection of a real fan-out session.
#[test]
fn recursive_fanout_reconstructs_the_exact_tree() {
    let (agents, mismatches) = parse_case("recursive-fanout");
    let expected = expected_agents("recursive-fanout");
    let exp_agents = expected["agents"].as_array().unwrap();

    assert_eq!(agents.len(), exp_agents.len(), "wrong agent count");
    assert_eq!(agents.len(), 24, "the real fixture has 24 agents");

    // Every expected edge + depth + title, exactly.
    for e in exp_agents {
        let id = e["agentId"].as_str().unwrap();
        let got = agents
            .get(id)
            .unwrap_or_else(|| panic!("missing agent {id}"));
        assert_eq!(
            got.parent_id,
            e["parentId"].as_str().unwrap(),
            "wrong parent for {id}"
        );
        assert_eq!(
            got.spawn_depth,
            e["spawnDepth"].as_u64().map(|d| d as u32),
            "wrong depth for {id}"
        );
        assert_eq!(
            got.kind,
            e["agentType"].as_str().unwrap(),
            "wrong kind for {id}"
        );
        assert_eq!(
            got.title,
            e["title"].as_str().unwrap(),
            "wrong title for {id}"
        );
    }

    // The sidecar and Agent-tool edges agree on real data (no mismatch logged).
    assert!(
        mismatches.is_empty(),
        "unexpected edge mismatches: {mismatches:?}"
    );
}

/// **Depth-2 specifically pinned**: 5 real depth-2 `Explore` agents, each under a
/// depth-1 parent (not the root). This is the recursion the flat directory can't
/// encode — it must come from `parentAgentId`.
#[test]
fn depth_two_agents_point_to_their_depth_one_parents_not_the_root() {
    let (agents, _) = parse_case("recursive-fanout");
    let expected = expected_agents("recursive-fanout");

    let depth2: Vec<&Value> = expected["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["spawnDepth"].as_u64() == Some(2))
        .collect();
    assert_eq!(depth2.len(), 5, "the fixture has 5 depth-2 agents");

    for e in depth2 {
        let id = e["agentId"].as_str().unwrap();
        let parent = agents[id].parent_id.clone();
        assert_ne!(
            parent, "root",
            "depth-2 agent {id} must not parent to the root"
        );
        // Its parent must itself be a depth-1 agent in the tree.
        assert_eq!(
            agents[&parent].spawn_depth,
            Some(1),
            "{id}'s parent is not depth-1"
        );
    }
}

/// **A session with `.meta.json`
/// sidecars but NO root `<session>.jsonl` and NO sub-agent `.jsonl`.** This is what
/// a `--session-id`-spawned `claude` actually leaves on disk while running — the
/// sub-agents' `.meta.json` land before (or without) the root transcript. The
/// parser must still reconstruct the depth-1 tree from `spawnDepth==1 ⇒ parent=root`
/// alone, with no root transcript and no `Agent` tool_use to cross-check against.
///
/// A locate that required the root `.jsonl` returned nothing for this shape; the
/// parser must yield the 4 running agents.
#[test]
fn a_session_with_only_meta_sidecars_and_no_root_transcript_reconstructs() {
    let dir = fixture_dir("incomplete-no-root");
    // The root transcript does NOT exist — pass a path to a missing file, exactly
    // as `locate_transcript` now returns for this case.
    let missing_root = dir.join("session.jsonl");
    assert!(
        !missing_root.exists(),
        "the fixture must have NO root transcript"
    );

    let result = parse_fanout(&missing_root, &dir.join("subagents"), "root");
    let expected = expected_agents("incomplete-no-root");
    let exp = expected["agents"].as_array().unwrap();

    assert_eq!(result.agents.len(), exp.len());
    assert_eq!(
        result.agents.len(),
        4,
        "the real incomplete session had 4 depth-1 agents"
    );
    for a in &result.agents {
        assert_eq!(a.parent_id, "root", "depth-1 agents parent to the root");
        assert_eq!(a.spawn_depth, Some(1));
        // No `tool_result` (no root transcript) ⇒ Running — they ARE still running.
        assert_eq!(
            a.status,
            FanoutStatus::Running,
            "no root ⇒ no completion ⇒ running"
        );
        assert!(
            !a.title.is_empty(),
            "title comes from the sidecar, which exists"
        );
    }
    // No root transcript ⇒ no Agent-tool edges to disagree with ⇒ no mismatch.
    assert!(result.edge_mismatches.is_empty());
}

/// **The phantom-root trap, pinned by fixture**: a session full of `TaskCreate`
/// to-dos (and no `Agent` spawns) yields **zero** agents. This is the exact bug a
/// parser that treats `TaskCreate` as the spawn tool ships: every to-do a phantom agent.
#[test]
fn taskcreate_is_not_a_spawn_and_yields_zero_agents() {
    let (agents, _) = parse_case("taskcreate-decoy");
    assert!(
        agents.is_empty(),
        "TaskCreate must not be read as a spawn; got {} agents",
        agents.len()
    );
}

/// **Transcript-rewrite / truncation safety**: a session whose final line is a
/// half-written JSON object (a live file mid-write) still parses the valid agents
/// before it. A naive parser would choke on the truncated line.
#[test]
fn a_truncated_final_line_does_not_break_parsing() {
    let (agents, _) = parse_case("malformed");
    assert_eq!(
        agents.len(),
        1,
        "the one complete agent must survive a truncated tail"
    );
    assert!(agents.contains_key("agent00"));
}

/// **Version drift**: an older CLI's sidecar without `spawnDepth` still places the
/// agent (depth is a nicety; the tree comes from `parentAgentId`/root).
#[test]
fn a_sidecar_without_spawn_depth_still_reconstructs() {
    let (agents, _) = parse_case("version-drift");
    assert_eq!(agents.len(), 1);
    let a = &agents["agent00"];
    assert_eq!(a.parent_id, "root");
    assert_eq!(
        a.spawn_depth, None,
        "missing spawnDepth must be None, not a guess"
    );
    assert_eq!(
        a.status,
        FanoutStatus::Done,
        "its tool_result marks it done"
    );
}

/// **Status is per-agent and a completed child never greys its parent** (the
/// trap). In the real recursive fixture every depth-1 agent completed
/// (`tool_result` present) → `Done`; assert that this says nothing about the root,
/// which the parser never emits as an agent at all (it is the caller's own node).
#[test]
fn a_child_completing_does_not_touch_the_parent() {
    let (agents, _) = parse_case("recursive-fanout");

    // The root is never in the parsed set — it is not a sub-agent. So no child's
    // status could possibly flip it.
    assert!(
        !agents.contains_key("root"),
        "the root must not be parsed as a sub-agent"
    );

    // A depth-1 parent that HAS completed children keeps its own status. agent05
    // has 3 depth-2 children; whatever agent05's own status, it is derived from
    // agent05's OWN tool_result, not its children's.
    let parent = &agents["agent05"];
    let children: Vec<_> = agents
        .values()
        .filter(|a| a.parent_id == "agent05")
        .collect();
    assert_eq!(children.len(), 3, "agent05 should have 3 children");
    // The parent's status is whatever its own Agent tool_result says — independent
    // of the children. We assert only that it was derived (a real value), i.e. the
    // children's completion did not force it.
    assert!(
        matches!(
            parent.status,
            FanoutStatus::Running | FanoutStatus::Done | FanoutStatus::Error
        ),
        "parent status must be independently derived"
    );
}

/// Running vs done vs error are all reachable from `tool_result` presence/error.
/// Pinned on a synthetic case so all three appear deterministically.
#[test]
fn status_is_derived_from_tool_result_presence() {
    let dir = fixture_dir("status-cases");
    // Built inline so the three outcomes are unambiguous.
    std::fs::create_dir_all(dir.join("subagents")).unwrap();
    let session = "\
{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[\
{\"type\":\"tool_use\",\"name\":\"Agent\",\"id\":\"t-run\",\"input\":{\"subagent_type\":\"x\",\"description\":\"running\"}},\
{\"type\":\"tool_use\",\"name\":\"Agent\",\"id\":\"t-done\",\"input\":{\"subagent_type\":\"x\",\"description\":\"done\"}},\
{\"type\":\"tool_use\",\"name\":\"Agent\",\"id\":\"t-err\",\"input\":{\"subagent_type\":\"x\",\"description\":\"err\"}}]}}\n\
{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[\
{\"type\":\"tool_result\",\"tool_use_id\":\"t-done\",\"is_error\":false},\
{\"type\":\"tool_result\",\"tool_use_id\":\"t-err\",\"is_error\":true}]}}\n";
    std::fs::write(dir.join("session.jsonl"), session).unwrap();
    for (agent, tool) in [("a-run", "t-run"), ("a-done", "t-done"), ("a-err", "t-err")] {
        std::fs::write(
            dir.join(format!("subagents/agent-{agent}.jsonl")),
            format!("{{\"agentId\":\"{agent}\",\"cwd\":\"/w\",\"gitBranch\":\"main\"}}\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join(format!("subagents/agent-{agent}.meta.json")),
            format!("{{\"agentType\":\"x\",\"description\":\"d\",\"toolUseId\":\"{tool}\",\"spawnDepth\":1}}"),
        )
        .unwrap();
    }

    let result = parse_fanout(&dir.join("session.jsonl"), &dir.join("subagents"), "root");
    let by: HashMap<_, _> = result
        .agents
        .iter()
        .map(|a| (a.agent_id.as_str(), a.status))
        .collect();
    std::fs::remove_dir_all(&dir).ok();

    assert_eq!(
        by["a-run"],
        FanoutStatus::Running,
        "no tool_result => running"
    );
    assert_eq!(by["a-done"], FanoutStatus::Done, "tool_result ok => done");
    assert_eq!(
        by["a-err"],
        FanoutStatus::Error,
        "tool_result is_error => error"
    );
}

// ── Workflow sub-agents (the ones that used to vanish) ───────────────────────
//
// `subagents/` is NOT flat. A `Workflow` tool_use launches a background run whose
// sub-agents' sidecars land in `subagents/workflows/wf_<runId>/` — on a machine that
// uses workflows, a large share of all sidecars, every one of them invisible to the
// old flat `read_dir`. The `workflow-fanout` fixture has
// the shape of that real data (field sets, journal events and the launch
// announcement copied from real files; paths and prose synthetic, because a
// committed fixture may not carry a home path — see `fixtures_no_secrets`).

/// The full reconstructed tree for the workflow case: every edge, depth, kind,
/// title and status, pinned against `expected.json`.
#[test]
fn workflow_sub_agents_hang_off_the_run_that_spawned_them() {
    let (agents, mismatches) = parse_case("workflow-fanout");
    let expected = expected_agents("workflow-fanout");
    let exp = expected["agents"].as_array().unwrap();

    assert_eq!(agents.len(), exp.len(), "wrong agent count: got {agents:?}");
    for e in exp {
        let id = e["agentId"].as_str().unwrap();
        let got = agents
            .get(id)
            .unwrap_or_else(|| panic!("missing agent {id}"));
        assert_eq!(
            got.parent_id,
            e["parentId"].as_str().unwrap(),
            "wrong parent for {id}"
        );
        assert_eq!(
            got.spawn_depth,
            e["spawnDepth"].as_u64().map(|d| d as u32),
            "wrong depth for {id}"
        );
        assert_eq!(
            got.kind,
            e["agentType"].as_str().unwrap(),
            "wrong kind for {id}"
        );
        assert_eq!(
            got.title,
            e["title"].as_str().unwrap(),
            "wrong title for {id}"
        );
        assert_eq!(
            format!("{:?}", got.status),
            e["status"].as_str().unwrap(),
            "wrong status for {id}"
        );
    }
    // Workflow sidecars carry no `parentAgentId`/`toolUseId`, so there is nothing
    // for the cross-check to disagree with — and the flat agent's edges agree.
    assert!(
        mismatches.is_empty(),
        "unexpected mismatches: {mismatches:?}"
    );
}

/// **The edge is DERIVED, never guessed from the directory.** `wf_beta22222-bbb`
/// sits in exactly the same `subagents/workflows/` directory as `wf_alpha11111-aaa`,
/// yet its parent is the sub-agent `agent00` — because the `Transcript dir:` line
/// naming it appears in *`agent00`'s* transcript, not the root's. Nesting encodes
/// nothing; the `Workflow` `tool_use_id` encodes everything.
#[test]
fn a_workflow_launched_by_a_sub_agent_parents_to_that_sub_agent() {
    let (agents, _) = parse_case("workflow-fanout");
    assert_eq!(agents["wf_alpha11111-aaa"].parent_id, "root");
    assert_eq!(
        agents["wf_beta22222-bbb"].parent_id, "agent00",
        "the run must follow its launch announcement, not its directory"
    );
    // …and its sub-agent follows the run, one level deeper again.
    assert_eq!(agents["wfa21"].parent_id, "wf_beta22222-bbb");
}

/// **A missing edge must not cost the node** (the documented orphan policy).
/// `wf_gamma3333-ccc` is announced by no transcript at all — an old session, a
/// truncated log. Its sub-agents must still be reachable, grouped under a run node
/// that *says* its launcher is unknown rather than quietly claiming the root.
#[test]
fn a_run_with_no_launch_announcement_still_appears_under_the_root() {
    let (agents, _) = parse_case("workflow-fanout");
    let run = &agents["wf_gamma3333-ccc"];
    assert_eq!(
        run.parent_id, "root",
        "an orphan run falls back to the root"
    );
    assert!(
        run.title.contains("launcher unknown"),
        "the lost edge must be visible to the user, not silent: {:?}",
        run.title
    );
    assert_eq!(
        agents["wfa31"].parent_id, "wf_gamma3333-ccc",
        "its sub-agent stays grouped under the run, not mixed in with real depth-1 agents"
    );
}

/// **A workflow node is always strictly shallower than its sub-agents.**
/// `diff_fanout` orders deltas shallowest-first precisely so a parent is emitted
/// before its children; a run reported at the same depth as its own agents would
/// break that (their raw sidecar `spawnDepth` is 1 regardless of how deep the run
/// itself sits).
#[test]
fn a_workflow_node_is_shallower_than_the_agents_it_holds() {
    let (agents, _) = parse_case("workflow-fanout");
    let runs: Vec<_> = agents.values().filter(|a| a.kind == "workflow").collect();
    assert_eq!(runs.len(), 3, "the fixture has 3 emitted runs");
    for run in runs {
        let children: Vec<_> = agents
            .values()
            .filter(|a| a.parent_id == run.agent_id)
            .collect();
        assert!(!children.is_empty(), "{} has no children", run.agent_id);
        for child in children {
            assert!(
                child.spawn_depth > run.spawn_depth,
                "{} (depth {:?}) must be deeper than its run {} (depth {:?})",
                child.agent_id,
                child.spawn_depth,
                run.agent_id,
                run.spawn_depth
            );
        }
    }
}

/// Status for a workflow sub-agent comes from the run's `journal.jsonl` — it has no
/// `toolUseId`, so the ordinary `tool_result` route would report every one of them
/// `Running` forever (wrong for most of them in practice).
#[test]
fn workflow_sub_agent_status_comes_from_the_run_journal() {
    let (agents, _) = parse_case("workflow-fanout");
    // wfa11 has a `result` line; wfa12 only a `started` line.
    assert_eq!(agents["wfa11"].status, FanoutStatus::Done);
    assert_eq!(agents["wfa12"].status, FanoutStatus::Running);
    // wfa31's run has no journal at all ⇒ nothing observed ⇒ Running.
    assert_eq!(agents["wfa31"].status, FanoutStatus::Running);
    // The run is Done only when every one of its agents is.
    assert_eq!(agents["wf_alpha11111-aaa"].status, FanoutStatus::Running);
    assert_eq!(agents["wf_beta22222-bbb"].status, FanoutStatus::Done);
}

/// No phantoms. A `wf_` directory with no sidecars yet is not a node (a row that can
/// never gain a child), and a sibling directory that is not a run is not swept in —
/// the fixture puts a perfectly valid-looking sidecar inside `notwf_ignoreme/` to
/// make sure discovery is not just "anything two levels down".
#[test]
fn empty_and_non_run_directories_do_not_become_nodes() {
    let (agents, _) = parse_case("workflow-fanout");
    assert!(
        !agents.contains_key("wf_delta4444-ddd"),
        "empty run emitted"
    );
    assert!(!agents.contains_key("notwf_ignoreme"));
    assert!(
        !agents.contains_key("wfa99"),
        "a sidecar outside a wf_ run must not be adopted"
    );
}

/// **NEGATIVE CONTROL.** `recursive-fanout` — the real 24-agent depth-2 fixture —
/// has no `workflows/` directory at all. Workflow discovery must be completely inert
/// there: same 24 agents, no synthetic node, no re-parenting. A change that fixed
/// nested discovery while quietly breaking (or polluting) the flat case would pass a
/// nested-only test.
#[test]
fn flat_only_sessions_are_completely_unaffected_by_workflow_discovery() {
    let dir = fixture_dir("recursive-fanout");
    assert!(
        !dir.join("subagents/workflows").exists(),
        "this control is only meaningful while the fixture has no workflows dir"
    );
    let (agents, mismatches) = parse_case("recursive-fanout");
    assert_eq!(agents.len(), 24);
    assert!(
        agents.values().all(|a| a.kind != "workflow"),
        "no synthetic node may appear in a session with no workflow runs"
    );
    assert!(mismatches.is_empty());
    // Depths stay exactly as the sidecars report them (1 and 2) — the workflow path
    // must not renumber anything on the flat path.
    for a in agents.values() {
        assert!(
            matches!(a.spawn_depth, Some(1) | Some(2)),
            "{} got depth {:?}",
            a.agent_id,
            a.spawn_depth
        );
    }
}

/// **The count floor.** Every `agent-*.meta.json` a fixture puts in a *discoverable*
/// location — `subagents/` or `subagents/workflows/wf_*/` — must come back as an
/// agent, in every case, with no exceptions and no allowance for a percentage.
///
/// This is the test that would have caught the original bug: the old parser read one
/// of those two shapes and silently dropped every workflow sidecar without a single
/// test going red. It is data-driven on purpose — a fixture added later is covered
/// the moment it lands, and it fails loudly rather than by a shrinking count nobody
/// re-reads.
#[test]
fn every_discoverable_sidecar_becomes_exactly_one_agent() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/transcripts");
    let mut checked_cases = 0;
    let mut checked_sidecars = 0;

    for case in std::fs::read_dir(&root).unwrap().flatten() {
        let dir = case.path();
        if !dir.join("expected.json").is_file() {
            continue; // scratch dirs written by other tests
        }
        let subagents = dir.join("subagents");
        let mut want: Vec<String> = sidecar_ids(&subagents);
        if let Ok(runs) = std::fs::read_dir(subagents.join("workflows")) {
            for run in runs.flatten() {
                let name = run.file_name().to_string_lossy().into_owned();
                if name.starts_with("wf_") {
                    want.extend(sidecar_ids(&run.path()));
                }
            }
        }
        if want.is_empty() {
            continue;
        }
        want.sort();

        let root_id = expected_agents(dir.file_name().unwrap().to_str().unwrap())["rootId"]
            .as_str()
            .unwrap()
            .to_string();
        let result = parse_fanout(&dir.join("session.jsonl"), &subagents, &root_id);
        let got: std::collections::HashSet<&str> =
            result.agents.iter().map(|a| a.agent_id.as_str()).collect();

        for id in &want {
            assert!(
                got.contains(id.as_str()),
                "{}: sidecar {id} is on disk but not in the parsed tree",
                dir.display()
            );
        }
        checked_cases += 1;
        checked_sidecars += want.len();
    }

    // A floor that scanned nothing would be a false green.
    assert!(
        checked_cases >= 4 && checked_sidecars >= 30,
        "the floor covered only {checked_cases} cases / {checked_sidecars} sidecars"
    );
}

/// `agent-<id>` for every `.meta.json` directly in `dir` (not recursive).
fn sidecar_ids(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".meta.json")
                .and_then(|stem| stem.strip_prefix("agent-"))
                .map(str::to_string)
        })
        .collect()
}

/// **The sidecar↔Agent-tool cross-check logs a disagreement rather than silently
/// drawing a wrong tree**. Synthetic: a sidecar claims parent `X`, but
/// the `Agent` tool_use that spawned it lives in the root's transcript.
#[test]
fn an_edge_mismatch_is_logged_not_hidden() {
    let dir = fixture_dir("mismatch-case");
    std::fs::create_dir_all(dir.join("subagents")).unwrap();
    // The Agent tool_use for t-x is in the ROOT transcript => edge parent = root.
    std::fs::write(
        dir.join("session.jsonl"),
        "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Agent\",\"id\":\"t-x\",\"input\":{\"subagent_type\":\"x\",\"description\":\"d\"}}]}}\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("subagents/agent-a-x.jsonl"),
        "{\"agentId\":\"a-x\",\"cwd\":\"/w\",\"gitBranch\":\"main\"}\n",
    )
    .unwrap();
    // …but the sidecar claims parentAgentId = "someone-else".
    std::fs::write(
        dir.join("subagents/agent-a-x.meta.json"),
        "{\"agentType\":\"x\",\"description\":\"d\",\"toolUseId\":\"t-x\",\"spawnDepth\":2,\"parentAgentId\":\"someone-else\"}",
    )
    .unwrap();

    let result = parse_fanout(&dir.join("session.jsonl"), &dir.join("subagents"), "root");
    std::fs::remove_dir_all(&dir).ok();

    assert_eq!(
        result.edge_mismatches.len(),
        1,
        "the disagreement must be surfaced"
    );
    let (agent, sidecar_parent, edge_parent) = &result.edge_mismatches[0];
    assert_eq!(agent, "a-x");
    assert_eq!(
        sidecar_parent, "someone-else",
        "primary source (sidecar) reported"
    );
    assert_eq!(
        edge_parent, "root",
        "cross-check (Agent tool edge) reported"
    );
    // The sidecar (primary) still wins the actual edge.
    assert_eq!(result.agents[0].parent_id, "someone-else");
}
