//! **The single most important safety test in the product**
//! (testing-strategy.md §7): no committed transcript fixture may contain a
//! real-world identifier. Raw transcripts are full of home paths, tokens and
//! secret exports — the allowlist projection is what keeps them out, and *this*
//! test is what makes that provable on every push and catches a careless
//! hand-added fixture.
//!
//! It is a belt-and-braces denylist over the *output*; the allowlist projection
//! (`project_transcripts.py`) is the actual mechanism. Both, deliberately.

use std::path::{Path, PathBuf};

/// `(label, regex, hard)`. **Hard** patterns are real-world secrets and apply to
/// EVERY fixture. The two non-hard ones are *prose heuristics* — `"prompt"` and a
/// long `"text"` body are proxies for "the fan-out allowlist should have dropped
/// this". They do not apply to fixtures that legitimately carry text (the sub-agent
/// **activity** feed, whose whole purpose is to surface text) — see the scan's
/// exemption. The hard secret checks still apply to those fixtures.
fn forbidden() -> Vec<(&'static str, regex::Regex, bool)> {
    let pats: &[(&str, &str, bool)] = &[
        ("home path (/Users)", r"/Users/[a-zA-Z0-9._-]+", true),
        ("home path (/home)", r"/home/[a-zA-Z0-9._-]+", true),
        ("windows home", r"C:\\Users\\[a-zA-Z0-9._-]+", true),
        ("jwt", r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.", true),
        ("aws key", r"AKIA[0-9A-Z]{16}", true),
        ("gh token", r"gh[pousr]_[A-Za-z0-9]{20,}", true),
        ("anthropic key", r"sk-ant-[A-Za-z0-9_-]{20,}", true),
        (
            "email",
            r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
            true,
        ),
        (
            "conn string",
            r"(?i)(postgres|mysql|mongodb|redis)://",
            true,
        ),
        (
            "secret kv",
            r"(?i)(password|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}",
            true,
        ),
        // Prose heuristics (not hard secrets): the fan-out allowlist drops these, so
        // their presence there means prose leaked. Exempted for the activity feed.
        ("prompt key", r#""prompt""#, false),
        ("text-body key", r#""text"\s*:\s*"[^"]{40,}""#, false),
    ];
    pats.iter()
        .map(|(label, p, hard)| (*label, regex::Regex::new(p).unwrap(), *hard))
        .collect()
}

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else if matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("json") | Some("jsonl")
        ) {
            out.push(path);
        }
    }
}

#[test]
fn no_committed_fixture_contains_a_real_world_secret() {
    let patterns = forbidden();
    let mut files = Vec::new();
    walk(&fixtures_root(), &mut files);

    assert!(
        !files.is_empty(),
        "no fixture files found — did the path move?"
    );

    let mut violations = Vec::new();
    for file in &files {
        let Ok(content) = std::fs::read_to_string(file) else {
            continue;
        };
        // The sub-agent activity fixture legitimately holds (synthetic) text — its
        // parser reads text. The prose *heuristics* don't apply to it; the hard
        // secret checks still do.
        let is_activity_fixture = file.to_string_lossy().contains("subagent-activity");
        for (label, re, hard) in &patterns {
            if !hard && is_activity_fixture {
                continue;
            }
            if let Some(m) = re.find(&content) {
                violations.push(format!(
                    "{}: {label} -> {:?}",
                    file.strip_prefix(fixtures_root()).unwrap_or(file).display(),
                    m.as_str().chars().take(40).collect::<String>()
                ));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "committed fixtures contain forbidden identifiers (the allowlist projection \
         leaked, or a raw fixture was hand-added):\n  {}",
        violations.join("\n  ")
    );
}

/// Sanity: the guard actually scans fixtures (a passing test over zero files would
/// be a false green — the exact failure mode the quality gates exist to prevent).
#[test]
fn the_scan_actually_covers_the_fixtures() {
    let mut files = Vec::new();
    walk(&fixtures_root(), &mut files);
    assert!(
        files.len() >= 10,
        "expected the fixture corpus, found {} files",
        files.len()
    );
    assert!(
        files
            .iter()
            .any(|f| f.to_string_lossy().contains("recursive-fanout")),
        "the headline recursive fixture must be covered"
    );
}
