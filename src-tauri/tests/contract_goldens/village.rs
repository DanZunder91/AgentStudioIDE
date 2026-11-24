//! **Agent Village — `list_external_agents`** (`src/features/village/villageTypes.ts`
//! `ExternalAgentsReport`). Same rules as the parent file: the real production path,
//! the typed struct serialised as Tauri would, normalised only where volatile.
//!
//! | golden | produced by |
//! |---|---|
//! | `external-agents.json` (`ExternalAgentsReport` by scenario) | `external_agents::scan_external` over a tempdir copy of `tests/fixtures/external_agents` (mtimes stamped `T0 - secs` from its `mtimes.json`), the IDE's own session excluded; `macos-linux`: a live `claude` for every in-window session (bare in alpha and beta, `--resume` in gamma under iTerm2, `--session-id` in zeta under Terminal, the IDE's own by id), so every activity and both host answers show; `dead-hidden`: only beta's `claude` lives, so every other session is dropped; `windows`: no process table (liveness unknown, nothing hidden); `no-sessions`: an empty projects dir |
//!
//! **Normalised:** the opaque keys (a per-process random SipHash) → `k1`, `k2`, … in
//! order of appearance, `parentKey` mapped through the same table — so the TREE is
//! pinned while the hash is not.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use agent_studio_scaffold_lib::external_agents::{
    scan_external, ExternalAgentsReport, HostApp, HostTarget, LiveClaude,
};

use super::{check_golden, T0};

const TEN_MIN: u64 = 10 * 60_000;
/// The fixture's IDE-owned session (delta).
const IDE_SESSION: &str = "44444444-4444-4444-8444-444444444444";
const GAMMA: &str = "33333333-3333-4333-8333-333333333333";
const ZETA: &str = "66666666-6666-4666-8666-666666666666";

fn live(pid: u32, cwd: &str, args: &[&str], host: Option<(&str, &str)>) -> LiveClaude {
    let mut argv = vec!["claude".to_string()];
    argv.extend(args.iter().map(|a| a.to_string()));
    LiveClaude {
        pid,
        cwd: PathBuf::from(cwd),
        argv,
        started_ms: Some(T0 - 3_600_000),
        host: host.map(|(name, bundle)| HostApp {
            name: name.to_string(),
            target: HostTarget::Bundle(PathBuf::from(bundle)),
        }),
    }
}

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/external_agents")
}

fn copy_tree(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).expect("mkdir");
    for e in std::fs::read_dir(src).expect("read").flatten() {
        let to = dst.join(e.file_name());
        if e.path().is_dir() {
            copy_tree(&e.path(), &to);
        } else {
            std::fs::copy(e.path(), &to).expect("copy");
        }
    }
}

/// The fixture projects dir in a tempdir, every mtime stamped `T0 - secs`.
fn stage() -> PathBuf {
    let dst = std::env::temp_dir()
        .join(format!("agentstudio-village-golden-{}", ulid::Ulid::new()))
        .join("projects");
    copy_tree(&fixture_root().join("projects"), &dst);
    let table: HashMap<String, u64> = serde_json::from_str(
        &std::fs::read_to_string(fixture_root().join("mtimes.json")).expect("mtimes"),
    )
    .expect("mtimes json");
    for (rel, secs) in table {
        std::fs::File::options()
            .write(true)
            .open(dst.join(&rel))
            .expect("open")
            .set_modified(UNIX_EPOCH + Duration::from_millis(T0 - secs * 1000))
            .expect("set mtime");
    }
    dst
}

/// Opaque keys → `k1`, `k2`, … (first appearance), parent keys through the same map.
fn normalise(mut report: ExternalAgentsReport) -> ExternalAgentsReport {
    let mut table: HashMap<String, String> = HashMap::new();
    for a in &report.agents {
        let n = format!("k{}", table.len() + 1);
        table.entry(a.key.clone()).or_insert(n);
    }
    for a in &mut report.agents {
        a.key = table[&a.key].clone();
        a.parent_key = a.parent_key.as_ref().map(|p| {
            table
                .get(p)
                .cloned()
                .unwrap_or_else(|| panic!("a parentKey that is not listed: {p}"))
        });
    }
    report
}

#[test]
fn external_agents_values_match_the_golden() {
    let projects = stage();
    let exclude = HashSet::from([IDE_SESSION.to_string()]);
    let all = vec![
        live(1, "/work/alpha", &["--session-id", IDE_SESSION], None),
        live(2, "/work/alpha", &[], None),
        live(3, "/work/beta", &[], None),
        live(
            4,
            "/work/gamma",
            &["--resume", GAMMA],
            Some(("iTerm2", "/Applications/iTerm.app")),
        ),
        live(
            5,
            "/work/zeta",
            &["--session-id", ZETA],
            Some(("Terminal", "/System/Applications/Utilities/Terminal.app")),
        ),
    ];
    let beta_only = vec![live(3, "/work/beta", &[], None)];
    let report = |live: Option<&[LiveClaude]>| {
        normalise(ExternalAgentsReport {
            agents: scan_external(&projects, T0, TEN_MIN, &exclude, live),
            scanned_at_ms: T0,
        })
    };
    let empty = projects.parent().unwrap().join("empty");
    std::fs::create_dir_all(&empty).expect("mkdir");

    let mut scenarios: BTreeMap<&str, ExternalAgentsReport> = BTreeMap::new();
    scenarios.insert("macos-linux", report(Some(&all)));
    scenarios.insert("dead-hidden", report(Some(&beta_only)));
    scenarios.insert("windows", report(None));
    scenarios.insert(
        "no-sessions",
        ExternalAgentsReport {
            agents: scan_external(&empty, T0, TEN_MIN, &exclude, Some(&all)),
            scanned_at_ms: T0,
        },
    );
    // Not an empty-looking golden by accident.
    assert_eq!(scenarios["macos-linux"].agents.len(), 7);
    assert_eq!(scenarios["dead-hidden"].agents.len(), 1);
    assert_eq!(scenarios["windows"].agents.len(), 7);
    check_golden("external-agents.json", &scenarios);
    let _ = std::fs::remove_dir_all(projects.parent().unwrap());
}
