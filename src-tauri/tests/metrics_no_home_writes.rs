//! `~/.claude` is READ-ONLY for us, checked on the metrics scan (it reads the most): a replica
//! home stays byte-identical, a read-only root still scans, and the real home's `settings.json`
//! is unchanged. Own binary holding [`HOME_LOCK`]: `HOME` is process-global.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_studio_scaffold_lib::metrics::{
    self, claude_metrics, MetricsScopeKind, MetricsWindowKind, ScanRoot,
};

/// Serializes the `HOME`-mutating tests in this binary.
static HOME_LOCK: Mutex<()> = Mutex::new(());

const CWD: &str = "/work/proj";

/// One file's identity: size, mtime in nanoseconds, and a content digest. All three,
/// because each catches a write the others can miss — a same-length in-place
/// overwrite (digest), a truncation (size), and a touch (mtime).
#[derive(Debug, PartialEq, Eq)]
struct Fingerprint {
    size: u64,
    mtime_nanos: u128,
    digest: u64,
}

/// FNV-1a. A cryptographic hash would be overkill and would need a dependency (this
/// feature adds none): we are detecting our own accidental writes, not
/// defending against a forged collision.
fn digest(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn fingerprint_file(path: &Path) -> Option<Fingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    let bytes = std::fs::read(path).ok()?;
    Some(Fingerprint {
        size: meta.len(),
        mtime_nanos: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        digest: digest(&bytes),
    })
}

/// Fingerprint every file under `dir`, keyed by path relative to it.
fn fingerprint_tree(dir: &Path) -> BTreeMap<PathBuf, Fingerprint> {
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Fingerprint>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out);
        } else if let Some(fp) = fingerprint_file(&path) {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
            out.insert(rel, fp);
        }
    }
}

/// Build a replica `~/.claude` under a tempdir: the global settings file a stray write
/// would corrupt, plus a projects tree with a real transcript in it.
fn build_replica_home() -> PathBuf {
    let home = std::env::temp_dir().join(format!("agentstudio-metrics-home-{}", ulid::Ulid::new()));
    let claude = home.join(".claude");
    std::fs::create_dir_all(claude.join("projects/-work-proj")).expect("mkdir");

    // The file a racing read-modify-write leaves as two concatenated JSON objects.
    std::fs::write(
        claude.join("settings.json"),
        "{\n  \"hooks\": {},\n  \"model\": \"opus\"\n}\n",
    )
    .expect("write settings");
    std::fs::write(claude.join("history.jsonl"), "{\"display\":\"x\"}\n").expect("write history");

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    // Timestamps computed off the real clock so the transcript falls inside a live
    // 24 h window — this test drives the real command, which uses the real clock.
    let ts = iso_ms(now_ms - 60_000);
    let ts2 = iso_ms(now_ms - 30_000);
    let lines = [
        serde_json::json!({
            "type": "user", "cwd": CWD, "sessionId": "s-home",
            "promptId": "p1", "promptSource": "typed", "timestamp": ts,
            "message": { "role": "user", "content": "count me" }
        })
        .to_string(),
        serde_json::json!({
            "type": "assistant", "cwd": CWD, "sessionId": "s-home", "requestId": "r1",
            "timestamp": ts2,
            "message": {
                "id": "m1", "role": "assistant", "model": "claude-opus-5",
                "stop_reason": "end_turn", "content": [{ "type": "text", "text": "ok" }],
                "usage": { "input_tokens": 1, "output_tokens": 33,
                           "cache_creation_input_tokens": 0, "cache_read_input_tokens": 7 }
            }
        })
        .to_string(),
    ];
    std::fs::write(
        claude.join("projects/-work-proj/s-home.jsonl"),
        format!("{}\n", lines.join("\n")),
    )
    .expect("write transcript");
    home
}

/// Epoch ms → `YYYY-MM-DDTHH:MM:SS.mmmZ`, so the replica's transcript is dated
/// against the real clock without pulling in a date crate.
fn iso_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // Inverse of `days_from_civil` (Hinnant's `civil_from_days`).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

// ===========================================================================
// 1. The strong, deterministic assertion
// ===========================================================================

/// Sync, with its own `block_on`: [`HOME_LOCK`] is a `std` mutex, and holding its guard
/// across an `.await` is a real hazard (`clippy::await_holding_lock`).
#[test]
fn the_full_command_path_writes_nothing_under_a_replica_home() {
    let _guard = HOME_LOCK.lock().expect("home lock");
    let home = build_replica_home();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let before = fingerprint_tree(&home);
    assert_eq!(before.len(), 3, "settings + history + one transcript");

    // The REAL command: resolves `home_dir()` itself and runs the scan on
    // `spawn_blocking`, so this is the path a running app takes.
    let report = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(claude_metrics(
            MetricsWindowKind::Last24h,
            MetricsScopeKind::Project,
            Some(CWD.to_string()),
        ))
        .expect("the scan must succeed");

    // Sanity: it really did read the replica. A test that asserts "nothing changed"
    // while silently scanning nothing would be a false green.
    assert_eq!(report.totals.turns, 1);
    assert_eq!(report.totals.requests, 1);
    assert_eq!(report.totals.tokens.output, 33);

    let after = fingerprint_tree(&home);
    assert_eq!(
        after.keys().collect::<Vec<_>>(),
        before.keys().collect::<Vec<_>>(),
        "no file may appear or disappear under ~/.claude"
    );
    for (path, fp) in &before {
        assert_eq!(
            after.get(path),
            Some(fp),
            "{} changed — size, mtime or content. \
             ~/.claude is READ-ONLY for us.",
            path.display()
        );
    }
    // The same command with NO cwd — the shape that used to return
    // `Err("scan-failed: project scope requires a cwd")` and is now the default. It must
    // succeed, cover everything, AND still write nothing.
    let widened = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(claude_metrics(
            MetricsWindowKind::Last24h,
            MetricsScopeKind::All,
            None,
        ))
        .expect("All scope with no cwd is the normal case, never an error");
    assert_eq!(widened.totals.requests, 1);
    assert!(widened.top_turns.iter().all(|t| t.label.is_none()));

    // A metrics cache belongs in the OS app-config dir, and this module writes it
    // nowhere at all.
    assert!(!home.join(".claude/metrics-cache.json").exists());
    let after_widened = fingerprint_tree(&home);
    for (path, fp) in &before {
        assert_eq!(after_widened.get(path), Some(fp), "{}", path.display());
    }
    let _ = std::fs::remove_dir_all(&home);
}

// ===========================================================================
// 2. Belt and braces: the OS refuses the write we claim never to attempt
// ===========================================================================

#[test]
fn the_scan_succeeds_against_a_read_only_transcript_root() {
    let home = build_replica_home();
    let claude = home.join(".claude");

    // Read-only, files first then directories — a directory must stay writable
    // until its children are done.
    set_mode(&claude.join("projects/-work-proj/s-home.jsonl"), 0o444);
    set_mode(&claude.join("settings.json"), 0o444);
    set_mode(&claude.join("history.jsonl"), 0o444);
    set_mode(&claude.join("projects/-work-proj"), 0o555);
    set_mode(&claude.join("projects"), 0o555);
    set_mode(&claude, 0o555);

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let report = metrics::scan(
        &[ScanRoot::local(&home)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::Project,
        Some(CWD),
        now_ms,
    );
    assert_eq!(
        report.totals.requests, 1,
        "a read-only ~/.claude must be fully readable — if this ever fails because \
         something tried to WRITE, that is the finding"
    );
    assert_eq!(report.totals.tokens.output, 33);
    assert!(!report.coverage.partial);

    // Restore so the tempdir can be removed.
    set_mode(&claude, 0o755);
    set_mode(&claude.join("projects"), 0o755);
    set_mode(&claude.join("projects/-work-proj"), 0o755);
    let _ = std::fs::remove_dir_all(&home);
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {
    // Windows has no mode bits worth asserting here; assertion 1 carries the weight.
}

// ===========================================================================
// 3. The developer's real ~/.claude
// ===========================================================================

/// Scoped on purpose: a running `claude` rewrites `projects/**`, `history.jsonl` etc.
/// constantly. Asserts `settings.json` is unchanged, nothing vanished, no cache file created.
#[test]
fn the_real_home_is_not_disturbed_by_a_real_scan() {
    let Some(home) = agent_studio_scaffold_lib::agent::claude::home_dir() else {
        return; // no home on this machine — nothing to protect
    };
    let claude = home.join(".claude");
    if !claude.is_dir() {
        return; // a machine that has never run `claude`
    }

    let settings = claude.join("settings.json");
    let settings_before = fingerprint_file(&settings);
    let entries_before = list_entries(&claude);

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    // `All` scope: the widest read this feature can perform, and now its DEFAULT — so
    // the read-only claim is asserted for the shape real use runs.
    let report = metrics::scan(
        &[ScanRoot::local(&home)],
        MetricsWindowKind::Last24h,
        MetricsScopeKind::All,
        None,
        now_ms,
    );
    // Non-negativity is structural (u64); what matters is that it ran at all.
    assert!(report.coverage.files_read <= report.coverage.files_considered);

    assert_eq!(
        fingerprint_file(&settings),
        settings_before,
        "~/.claude/settings.json changed across a metrics scan — the user's global \
         config must never be written"
    );
    for path in &entries_before {
        assert!(
            path.exists(),
            "{} disappeared across a metrics scan",
            path.display()
        );
    }
    assert!(
        !claude.join("metrics-cache.json").exists(),
        "a metrics cache never goes into ~/.claude"
    );
}

/// Top-level entries of a directory (not recursive — a live `claude` creates files
/// deep inside `projects/`, and a *new* file there is its doing, not ours).
fn list_entries(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}
