//! `~/.claude` is READ-ONLY for us, checked on the Agent Village's external scan (the
//! `metrics_no_home_writes.rs` pattern): replica byte-identity, a read-only root, the real home.
//! Setting the process-global `HOME` holds [`HOME_LOCK`] and restores it ([`HomeRestore`]).

#![cfg(unix)]

mod common;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_studio_scaffold_lib::agent::adapter::AgentAdapter;
use agent_studio_scaffold_lib::external_agents::{
    external_agents_report_with, scan_external, ExternalActivity, LanguageCache, LiveClaude,
};
use agent_studio_scaffold_lib::supervisor::AgentSpawnSpec;
use common::{supervisor_with, temp_cwd, ChannelSink, StubAdapter};

/// Serializes every test in this binary that sets or reads `HOME`.
static HOME_LOCK: Mutex<()> = Mutex::new(());

/// Puts `HOME`/`USERPROFILE` back as they were when dropped — also on a panic, so a
/// failing replica test cannot leave the process pointing at a deleted directory.
struct HomeRestore {
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
}

impl HomeRestore {
    fn capture() -> Self {
        Self {
            home: std::env::var_os("HOME"),
            userprofile: std::env::var_os("USERPROFILE"),
        }
    }
}

impl Drop for HomeRestore {
    fn drop(&mut self) {
        for (key, value) in [("HOME", &self.home), ("USERPROFILE", &self.userprofile)] {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

const FIXTURE_SESSIONS: usize = 6;
/// Every root session id in `tests/fixtures/external_agents/projects`.
const FIXTURE_IDS: [&str; 6] = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
];

#[derive(Debug, PartialEq, Eq)]
struct Fingerprint {
    size: u64,
    mtime_nanos: u128,
    digest: u64,
}

/// FNV-1a — detecting our own accidental writes, not defending against forgery.
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

/// Every file AND directory under `dir`, relative to it (a created empty dir counts).
fn fingerprint_tree(dir: &Path) -> BTreeMap<PathBuf, Option<Fingerprint>> {
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Option<Fingerprint>>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        if path.is_dir() {
            out.insert(rel, None);
            walk(root, &path, out);
        } else {
            out.insert(rel, fingerprint_file(&path));
        }
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

fn set_mtime(path: &Path, ms: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("open")
        .set_modified(UNIX_EPOCH + Duration::from_millis(ms))
        .expect("set mtime");
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
}

/// A replica `~/.claude`: settings + history + the fixture projects tree, its mtimes
/// stamped against the REAL clock (the command under test reads the real clock), plus
/// one transcript for `ide_session` — a session the IDE owns.
fn build_replica_home(ide_session: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!("agentstudio-ext-home-{}", ulid::Ulid::new()));
    let claude = home.join(".claude");
    std::fs::create_dir_all(&claude).expect("mkdir");
    std::fs::write(
        claude.join("settings.json"),
        "{\n  \"hooks\": {},\n  \"model\": \"opus\"\n}\n",
    )
    .expect("settings");
    std::fs::write(claude.join("history.jsonl"), "{\"display\":\"x\"}\n").expect("history");

    let projects = claude.join("projects");
    copy_tree(&fixture_root().join("projects"), &projects);
    let now = now_ms();
    let table: HashMap<String, u64> = serde_json::from_str(
        &std::fs::read_to_string(fixture_root().join("mtimes.json")).expect("mtimes"),
    )
    .expect("mtimes json");
    for (rel, secs) in table {
        set_mtime(&projects.join(rel), now - secs * 1000);
    }
    let ide = projects.join(format!("-work-ide/{ide_session}.jsonl"));
    std::fs::create_dir_all(ide.parent().unwrap()).expect("mkdir");
    std::fs::write(
        &ide,
        "{\"type\":\"user\",\"cwd\":\"/work/ide\",\"gitBranch\":\"ide-owned\",\
         \"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    )
    .expect("ide transcript");
    home
}

// ===========================================================================
// 1. The strong, deterministic assertion
// ===========================================================================

/// Sync, with its own runtime (`block_on`): [`HOME_LOCK`] is a std mutex and must not
/// be held across an `.await` (`clippy::await_holding_lock`).
#[test]
fn the_full_command_path_writes_nothing_under_a_replica_home() {
    let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");

    // A real supervisor with one spawned agent: its minted session id is what the
    // command must leave out — read in-process, never sent anywhere.
    let adapter = Arc::new(StubAdapter::interactive());
    let (sup, _sink) = supervisor_with(adapter.clone() as Arc<dyn AgentAdapter>);
    let owned = rt.block_on(async {
        let (_out, channel) = ChannelSink::new();
        sup.spawn_agent(
            AgentSpawnSpec {
                agent_id: format!("root-{}", ulid::Ulid::new()),
                runtime: "stub-runtime".into(),
                cwd: temp_cwd(),
                rows: 24,
                cols: 80,
                prompt: None,
                resume_session_id: None,
            },
            channel,
        )
        .await
        .expect("spawn");
        sup.owned_session_ids().await.expect("owned ids")
    });
    let minted = adapter.minted_keys();
    assert_eq!(minted.len(), 1);
    assert!(
        owned.contains(&minted[0]),
        "the spawned root's session is owned"
    );

    let home = build_replica_home(&minted[0]);
    // Declared after `_guard`, so it drops (restoring HOME) before the lock is released.
    let _restore = HomeRestore::capture();
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    let before = fingerprint_tree(&home);

    // The process table is the one injected input: a `claude` per fixture session (by
    // id — the replica's `/work/*` folders exist on no machine) plus the IDE's own, so
    // per-session liveness keeps them all and the exclusion is what drops the IDE's.
    let mut ids: Vec<String> = FIXTURE_IDS.iter().map(|s| s.to_string()).collect();
    ids.push(minted[0].clone());
    let probe = move || {
        Some(
            ids.iter()
                .enumerate()
                .map(|(i, id)| LiveClaude {
                    pid: 1_000 + i as u32,
                    cwd: PathBuf::from("/work/replica"),
                    argv: vec!["claude".into(), "--session-id".into(), id.clone()],
                    started_ms: None,
                    host: None,
                })
                .collect(),
        )
    };
    let report = rt
        .block_on(external_agents_report_with(owned, Some(10), probe))
        .expect("the scan must succeed");

    // Sanity — it really read the replica (a "nothing changed" over an empty scan
    // would be a false green): the fixture's five in-window sessions.
    let roots: Vec<&str> = report
        .agents
        .iter()
        .filter(|a| a.parent_key.is_none())
        .map(|a| a.title.as_str())
        .collect();
    assert_eq!(roots.len(), FIXTURE_SESSIONS - 1, "{roots:?}");
    assert!(roots.contains(&"quiet-running-otter"));
    assert!(
        !roots.contains(&"ide-owned"),
        "the IDE's own session must not show up as external"
    );
    assert!(report
        .agents
        .iter()
        .any(|a| a.activity == ExternalActivity::Waiting));
    // The project's language rides along (the City's neon sign), read through the app's own
    // offset cache — which now holds exactly the sessions this scan reported (the lock above
    // keeps every other report path in this binary out meanwhile).
    assert!(report
        .agents
        .iter()
        .any(|a| a.language.as_deref() == Some("rust")));
    assert_eq!(
        LanguageCache::global()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions()
            .len(),
        roots.len()
    );

    let after = fingerprint_tree(&home);
    assert_eq!(
        after.keys().collect::<Vec<_>>(),
        before.keys().collect::<Vec<_>>(),
        "no file or directory may appear or disappear under ~/.claude"
    );
    for (path, fp) in &before {
        assert_eq!(
            after.get(path),
            Some(fp),
            "{} changed — size, mtime or content. ~/.claude is READ-ONLY for us.",
            path.display()
        );
    }
    let _ = std::fs::remove_dir_all(&home);
}

// ===========================================================================
// 2. Belt and braces: the OS refuses the write we claim never to attempt
// ===========================================================================

#[test]
fn the_scan_succeeds_against_a_read_only_transcript_root() {
    let home = build_replica_home("77777777-7777-4777-8777-777777777777");
    let claude = home.join(".claude");
    let mut dirs = Vec::new();
    lock_down(&claude, &mut dirs);

    let agents = scan_external(
        &claude.join("projects"),
        now_ms(),
        10 * 60_000,
        &HashSet::new(),
        None,
    );
    // The fixture's five in-window sessions + the IDE one (nothing excluded here).
    let roots = agents.iter().filter(|a| a.parent_key.is_none()).count();
    assert_eq!(
        roots, FIXTURE_SESSIONS,
        "a read-only ~/.claude must be fully readable — if this fails because \
         something tried to WRITE, that is the finding"
    );

    for dir in dirs.iter().rev() {
        set_mode(dir, 0o755);
    }
    let _ = std::fs::remove_dir_all(&home);
}

/// chmod every file 0444 and every directory 0555, children before parents; `dirs`
/// collects the directories (outermost first) for the restore.
fn lock_down(dir: &Path, dirs: &mut Vec<PathBuf>) {
    dirs.push(dir.to_path_buf());
    for e in std::fs::read_dir(dir).expect("read").flatten() {
        let p = e.path();
        if p.is_dir() {
            lock_down(&p, dirs);
        } else {
            set_mode(&p, 0o444);
        }
    }
    set_mode(dir, 0o555);
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

// ===========================================================================
// 3. The developer's real ~/.claude
// ===========================================================================

/// Scoped as in `metrics_no_home_writes.rs` (a running `claude` rewrites `projects/**`):
/// `settings.json` is byte-identical and nothing that existed is gone.
#[test]
fn the_real_home_is_not_disturbed_by_a_real_scan() {
    // Never while the replica test has HOME pointed elsewhere (it restores before it
    // unlocks). A poisoned lock still serialises — the restore ran on the panic.
    let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(home) = agent_studio_scaffold_lib::agent::claude::home_dir() else {
        return;
    };
    let claude = home.join(".claude");
    if !claude.is_dir() {
        return; // a machine that has never run `claude`
    }
    let settings = claude.join("settings.json");
    let settings_before = fingerprint_file(&settings);
    let entries_before: Vec<PathBuf> = std::fs::read_dir(&claude)
        .map(|es| es.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();

    // A day's window: the widest read the village can ask for.
    let _ = scan_external(
        &claude.join("projects"),
        now_ms(),
        24 * 3_600_000,
        &HashSet::new(),
        None,
    );

    assert_eq!(
        fingerprint_file(&settings),
        settings_before,
        "~/.claude/settings.json changed across an external-agents scan — the user's \
         global config must never be written"
    );
    for path in &entries_before {
        assert!(
            path.exists(),
            "{} disappeared across a scan",
            path.display()
        );
    }
}
