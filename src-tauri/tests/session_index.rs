//! `list_claude_sessions` lists a folder's past Claude Code sessions for "Recover session".
//! Tests build a fake `~/.claude/projects/...` under a temp `HOME` (the real one is never touched);
//! own binary because `HOME`/`USERPROFILE` are process-global, and `HOME_LOCK` serializes tests.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use agent_studio_scaffold_lib::session_index::{list_claude_sessions, ClaudeSessionMeta};

// Serialize the HOME-mutating tests in this binary.
static HOME_LOCK: Mutex<()> = Mutex::new(());

/// The cwd every "matching" fixture session ran in, and its mangled dir name.
const CWD: &str = "/work/proj";
const PROJ_DIR: &str = "-work-proj";

fn set_home() -> PathBuf {
    let home = std::env::temp_dir().join(format!("agentstudio-sessidx-{}", ulid::Ulid::new()));
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    home
}

/// A root-transcript user line as `claude` writes it (see the committed fixtures:
/// message lines carry `cwd`, `sessionId`, `timestamp`).
fn user_line(cwd: &str, text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "cwd": cwd,
        "sessionId": "s",
        "timestamp": "2026-07-20T00:00:00.000Z",
        "message": { "role": "user", "content": text }
    })
    .to_string()
}

fn assistant_line(cwd: &str, text: &str) -> String {
    serde_json::json!({
        "type": "assistant",
        "cwd": cwd,
        "sessionId": "s",
        "timestamp": "2026-07-20T00:00:01.000Z",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }
    })
    .to_string()
}

/// A summary line (`claude` prepends these; they carry NO `cwd` field).
fn summary_line(text: &str) -> String {
    serde_json::json!({ "type": "summary", "summary": text, "leafUuid": "leaf-1" }).to_string()
}

/// Write `<home>/.claude/projects/<project>/<id>.jsonl` with the given lines and
/// a deterministic mtime (`File::set_modified` — no sleeps, no extra crates).
fn write_session(home: &Path, project: &str, id: &str, lines: &[String], mtime_s: u64) -> PathBuf {
    let dir = home.join(".claude/projects").join(project);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = lines.join("\n");
    if !content.is_empty() {
        content.push('\n');
    }
    std::fs::write(&path, content).unwrap();
    set_mtime(&path, mtime_s);
    path
}

fn set_mtime(path: &Path, mtime_s: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(mtime_s))
        .unwrap();
}

fn list(cwd: &str) -> Vec<ClaudeSessionMeta> {
    list_claude_sessions(cwd.to_string()).expect("listing must never error")
}

/// Two sessions in the cwd's project dir are both listed, newest mtime first,
/// with sane `mtimeMs`/`sizeBytes` (the exact values we wrote).
#[test]
fn two_sessions_list_newest_first_with_sane_meta() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    // "older" is written LAST — file order must not leak into the sort.
    let newer = write_session(
        &home,
        PROJ_DIR,
        "bbbb-newer",
        &[user_line(CWD, "newer work")],
        1_700_000_100,
    );
    write_session(
        &home,
        PROJ_DIR,
        "aaaa-older",
        &[user_line(CWD, "older work")],
        1_700_000_000,
    );

    let got = list(CWD);
    let newer_len = std::fs::metadata(&newer).unwrap().len();
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(
        got.iter()
            .map(|m| m.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["bbbb-newer", "aaaa-older"],
        "must sort newest-first by mtime"
    );
    assert_eq!(got[0].mtime_ms, 1_700_000_100_000, "mtime as ms epoch");
    assert_eq!(got[1].mtime_ms, 1_700_000_000_000);
    assert_eq!(got[0].size_bytes, newer_len, "size is the file's byte size");
    assert!(got.iter().all(|m| m.resumable), "real conversations resume");
}

/// The summary line outranks everything as the label (the wire contract's
/// precedence: summary → first user message → placeholder).
#[test]
fn label_comes_from_the_summary_line_when_present() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    write_session(
        &home,
        PROJ_DIR,
        "sess-sum",
        &[
            summary_line("Fixing the flaky PTY test"),
            user_line(CWD, "please fix the flaky test"),
        ],
        1_700_000_000,
    );

    let got = list(CWD);
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(got.len(), 1);
    assert_eq!(got[0].label, "Fixing the flaky PTY test");
    assert!(got[0].resumable, "it has a real user message");
}

/// No summary → the first USER message becomes the label: newlines collapsed to
/// a single line, capped at ~120 chars with an ellipsis. Assistant text and
/// tool_result-only user lines must never be picked over it.
#[test]
fn label_falls_back_to_the_first_user_message_collapsed_and_truncated() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    let long_prompt = format!(
        "fix the\nbuild and\tthen {}",
        "run all the gates ".repeat(20)
    );
    // A tool_result-only user line first — it is not the user's words.
    let tool_result_user = serde_json::json!({
        "type": "user",
        "cwd": CWD,
        "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "t1", "is_error": false }
        ]}
    })
    .to_string();
    write_session(
        &home,
        PROJ_DIR,
        "sess-user",
        &[
            assistant_line(CWD, "assistant text must not become the label"),
            tool_result_user,
            user_line(CWD, &long_prompt),
        ],
        1_700_000_000,
    );

    let got = list(CWD);
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(got.len(), 1);
    let label = &got[0].label;
    assert!(
        label.starts_with("fix the build and then run"),
        "newlines/tabs must collapse to single spaces: {label:?}"
    );
    assert!(
        !label.contains('\n') && !label.contains('\t'),
        "single-line"
    );
    assert_eq!(
        label.chars().count(),
        121,
        "120 chars + ellipsis: {label:?}"
    );
    assert!(label.ends_with('…'));
    assert!(got[0].resumable);
}

/// `claude --resume` errors on an id with no conversation, so an empty transcript is listed with
/// the placeholder label and `resumable:false`. Summary-only is unresumable too, but its summary
/// still wins as the label (the wire contract's label precedence).
#[test]
fn empty_and_summary_only_transcripts_are_listed_but_not_resumable() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    // The dir is attributed to the cwd via a sibling with a real `cwd` field
    // (empty/summary-only files carry none).
    write_session(&home, PROJ_DIR, "sess-real", &[user_line(CWD, "hi")], 3_000);
    write_session(&home, PROJ_DIR, "sess-empty", &[], 2_000);
    write_session(
        &home,
        PROJ_DIR,
        "sess-sum-only",
        &[summary_line("An abandoned thread")],
        1_000,
    );

    let got = list(CWD);
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(got.len(), 3, "empty/summary-only sessions are still listed");
    let empty = got.iter().find(|m| m.session_id == "sess-empty").unwrap();
    assert_eq!(empty.label, "(no messages)");
    assert!(!empty.resumable, "no conversation → resume would error");
    assert_eq!(empty.size_bytes, 0);

    let sum_only = got
        .iter()
        .find(|m| m.session_id == "sess-sum-only")
        .unwrap();
    assert!(!sum_only.resumable, "a summary line is not a conversation");
    assert_eq!(
        sum_only.label, "An abandoned thread",
        "summary still labels it"
    );
}

/// Sessions of a DIFFERENT cwd are never listed — neither those in another
/// project dir, nor a stray transcript in the *matching* dir whose own `cwd`
/// field says it ran elsewhere (the mangling is lossy; the field is authoritative).
#[test]
fn sessions_of_a_different_cwd_are_not_listed() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    write_session(&home, PROJ_DIR, "sess-mine", &[user_line(CWD, "hi")], 2_000);
    // Another project dir entirely.
    write_session(
        &home,
        "-other-proj",
        "sess-other",
        &[user_line("/other/proj", "other work")],
        3_000,
    );
    // Same dir, different `cwd` field — the field wins over the dir name.
    write_session(
        &home,
        PROJ_DIR,
        "sess-stray",
        &[user_line("/elsewhere", "stray work")],
        4_000,
    );

    let got = list(CWD);
    let other = list("/other/proj");
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(
        got.iter()
            .map(|m| m.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-mine"],
        "only the requested cwd's sessions may appear"
    );
    assert_eq!(
        other
            .iter()
            .map(|m| m.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-other"],
        "the other cwd sees exactly its own session"
    );
}

/// A cwd with no project dir — or no `~/.claude/projects` at all — is a NORMAL
/// case: `Ok(vec![])`, never an error (same philosophy as `git.rs`).
#[test]
fn no_project_dir_at_all_is_ok_and_empty() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();
    // Case 1: no ~/.claude/projects at all (fresh machine).
    let fresh = list_claude_sessions("/work/proj".to_string());
    // Case 2: projects exists but hosts nothing for this cwd.
    std::fs::create_dir_all(home.join(".claude/projects/-some-other")).unwrap();
    let no_match = list_claude_sessions("/work/proj".to_string());
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(fresh.expect("must be Ok").len(), 0);
    assert_eq!(no_match.expect("must be Ok").len(), 0);
}

/// Non-`.jsonl` files and a directory named `*.jsonl` are skipped; a garbage
/// `.jsonl` is listed calmly with the fallback label (its lines parse as
/// nothing, its dir attribution still holds) — no error anywhere.
#[test]
fn non_jsonl_and_garbage_files_are_handled_calmly() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    write_session(&home, PROJ_DIR, "sess-good", &[user_line(CWD, "hi")], 2_000);
    let dir = home.join(".claude/projects").join(PROJ_DIR);
    std::fs::write(dir.join("notes.txt"), "not a transcript").unwrap();
    std::fs::create_dir_all(dir.join("subdir.jsonl")).unwrap(); // a dir, not a file
    let garbage = dir.join("garbage.jsonl");
    std::fs::write(&garbage, b"\x00\x01\x02 not json\n{\"broken\": \n").unwrap();
    set_mtime(&garbage, 1_000);

    let got = list(CWD);
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(
        got.iter()
            .map(|m| m.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["sess-good", "garbage"],
        "txt + dir skipped; garbage jsonl listed calmly"
    );
    let g = &got[1];
    assert_eq!(g.label, "(no messages)", "garbage lines → fallback label");
    assert!(!g.resumable, "no parseable message line was found");
}

/// Labels come from the first 256 KiB only; a file that large is surely a real conversation, so it
/// stays `resumable:true` rather than being mislabeled unresumable.
#[test]
fn a_user_message_beyond_the_256kib_scan_bound_gets_the_fallback_label() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();

    // ~330 KiB of non-message padding (each line still carries `cwd`, so the
    // session is attributed correctly), THEN the only user message.
    let filler = "x".repeat(1024);
    let mut lines: Vec<String> = (0..330)
        .map(|i| {
            serde_json::json!({ "type": "progress", "cwd": CWD, "seq": i, "data": filler })
                .to_string()
        })
        .collect();
    lines.push(user_line(CWD, "the real prompt, out of reach"));
    let path = write_session(&home, PROJ_DIR, "sess-big", &lines, 1_000);
    assert!(
        std::fs::metadata(&path).unwrap().len() > 256 * 1024,
        "fixture must actually exceed the scan bound"
    );

    let got = list(CWD);
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(got.len(), 1);
    assert_eq!(
        got[0].label, "(no messages)",
        "the bounded read cannot see the late message — documented tradeoff"
    );
    assert!(
        got[0].resumable,
        "a >256KiB transcript is assumed to hold a real conversation"
    );
}

/// The wire contract is camelCase (`sessionId`, `mtimeMs`, `sizeBytes`, `label`,
/// `resumable`) — the frontend is built against these exact names.
#[test]
fn wire_contract_serializes_camel_case() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();
    write_session(&home, PROJ_DIR, "sess-wire", &[user_line(CWD, "hi")], 1_000);

    let got = list(CWD);
    std::fs::remove_dir_all(&home).ok();

    let v = serde_json::to_value(&got[0]).unwrap();
    // serde_json's map is alphabetically sorted; only the NAMES are the contract.
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["label", "mtimeMs", "resumable", "sessionId", "sizeBytes"],
        "exact camelCase wire keys"
    );
    assert_eq!(v["sessionId"], "sess-wire");
    assert_eq!(v["mtimeMs"], 1_000_000);
}

/// A crafted cwd cannot escape `~/.claude/projects` or error: we never build a
/// path from it (scan-and-match), and the mangle cannot preserve `..` anyway.
#[test]
fn a_crafted_cwd_never_escapes_or_errors() {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_home();
    write_session(&home, PROJ_DIR, "sess-mine", &[user_line(CWD, "hi")], 1_000);

    let crafted = [
        "../../etc",
        "/work/proj/../../etc/passwd",
        "",
        "..",
        "/work/proj/..",
    ];
    let results: Vec<_> = crafted
        .iter()
        .map(|c| list_claude_sessions(c.to_string()))
        .collect();
    std::fs::remove_dir_all(&home).ok();

    for (cwd, r) in crafted.iter().zip(results) {
        assert_eq!(
            r.expect("must never error").len(),
            0,
            "crafted cwd {cwd:?} must match nothing"
        );
    }
}
