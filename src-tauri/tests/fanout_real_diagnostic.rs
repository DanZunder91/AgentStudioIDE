//! Manual diagnostic (`#[ignore]`d; reads `~/.claude`): the REAL `locate_transcript` +
//! `parse_fanout` over this machine's sessions, printing ids/counts/depths/status, no prose.
//! Run: `cargo test --test fanout_real_diagnostic -- --ignored --nocapture`.

use agent_studio_scaffold_lib::agent::claude::{locate_transcript, parse_fanout};
use std::collections::BTreeMap;

fn report(label: &str, session: &str) {
    println!("\n===== {label}: {session} =====");
    let Some(loc) = locate_transcript(session) else {
        println!("  locate -> NONE");
        return;
    };
    println!("  root .jsonl exists: {}", loc.root_transcript.is_file());
    println!("  subagents dir exists: {}", loc.subagents_dir.is_dir());
    let r = parse_fanout(&loc.root_transcript, &loc.subagents_dir, "ROOT");
    let mut depths = BTreeMap::new();
    let mut statuses = BTreeMap::new();
    for a in &r.agents {
        *depths.entry(a.spawn_depth).or_insert(0) += 1;
        *statuses.entry(format!("{:?}", a.status)).or_insert(0) += 1;
    }
    println!(
        "  parse_fanout -> {} agents, {} mismatches",
        r.agents.len(),
        r.edge_mismatches.len()
    );
    println!("  by depth: {depths:?}   by status: {statuses:?}");
}

#[test]
#[ignore = "reads ~/.claude; run manually"]
fn diagnose_real_sessions() {
    // The session ids come from the environment, so no real id is ever committed:
    // AGENTSTUDIO_DIAG_SESSIONS="<id> <id>" cargo test --test fanout_real_diagnostic -- --ignored --nocapture
    let ids = std::env::var("AGENTSTUDIO_DIAG_SESSIONS").unwrap_or_default();
    if ids.trim().is_empty() {
        println!("set AGENTSTUDIO_DIAG_SESSIONS to one or more session ids");
        return;
    }
    for id in ids.split_whitespace() {
        report("session", id);
    }
}

/// Whole-machine census: sub-agents parsed vs sidecars on disk; evidence, not a gate (the
/// hermetic floor is in `fanout_parser.rs`). Read-only.
#[test]
#[ignore = "reads ~/.claude; run manually"]
fn census_of_every_session_on_this_machine() {
    let projects = match agent_studio_scaffold_lib::agent::claude::home_dir() {
        Some(h) => h.join(".claude/projects"),
        None => return,
    };

    // Ground truth straight off the filesystem, independent of the parser.
    fn count_sidecars(dir: &std::path::Path, flat: &mut usize, nested: &mut usize) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                count_sidecars(&p, flat, nested);
            } else if p.to_string_lossy().ends_with(".meta.json") {
                if p.to_string_lossy().contains("/workflows/") {
                    *nested += 1;
                } else {
                    *flat += 1;
                }
            }
        }
    }

    let (mut flat, mut nested) = (0usize, 0usize);
    count_sidecars(&projects, &mut flat, &mut nested);

    let mut parsed = 0usize;
    let mut workflow_nodes = 0usize;
    let mut orphan_runs = 0usize;
    let mut sessions = 0usize;
    // Dedupe on the RESOLVED dir: one session id can sit under two projects (and `memory/`),
    // so counting entries would total it several times.
    let mut seen: std::collections::HashSet<std::path::PathBuf> = Default::default();
    for project in std::fs::read_dir(&projects).unwrap().flatten() {
        let Ok(entries) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let Some(session) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some(loc) = locate_transcript(&session) else {
                continue;
            };
            if !seen.insert(loc.subagents_dir.clone()) {
                continue;
            }
            sessions += 1;
            let r = parse_fanout(&loc.root_transcript, &loc.subagents_dir, "ROOT");
            parsed += r.agents.len();
            for a in &r.agents {
                if a.kind == "workflow" {
                    workflow_nodes += 1;
                    if a.title.contains("launcher unknown") {
                        orphan_runs += 1;
                    }
                }
            }
        }
    }

    println!("\n===== census over {sessions} sessions =====");
    println!(
        "  sidecars on disk: {flat} flat + {nested} under workflows/ = {}",
        flat + nested
    );
    println!("  parse_fanout total agents: {parsed}");
    println!("    of which synthetic workflow nodes: {workflow_nodes} ({orphan_runs} with an unknown launcher)");
    println!("  sub-agents accounted for: {}", parsed - workflow_nodes);
}
