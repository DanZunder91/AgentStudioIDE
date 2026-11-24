//! Session index: list a folder's past Claude Code sessions so the UI
//! can offer "Recover session" (double-click → resume via `agent_spawn`'s
//! `resume_session_id`). This module only *lists*; the resume path
//! already exists.
//!
//! **Strategy: scan-and-match, never compute.** `agent::claude::locate_transcript`
//! established that the cwd→project-dir mangling is dead — `claude` resolves
//! symlinks before mangling, so `/tmp/x` lands under `-private-tmp-x` and the dir
//! name cannot be derived reliably. We therefore scan `~/.claude/projects/*/` and
//! match each transcript's **own `cwd` field** (every message line carries one)
//! against the requested cwd (raw and symlink-canonicalized). The mangled dir name
//! is used only as a *secondary attribution hint*, because empty and summary-only
//! transcripts carry no `cwd` field at all and would otherwise be unattributable.
//! Since we never build a path from the caller's `cwd` — it is only *compared*
//! against names `read_dir` returned — a crafted cwd cannot escape
//! `~/.claude/projects` (and the mangle maps every non-alphanumeric char,
//! including `.`, to `-`, so `..` could not survive it anyway).
//!
//! **`~/.claude` is read-only for us** — this module never writes
//! there; tests build a fake projects tree under a tempdir `HOME`.
//!
//! **Bounded reads.** Transcripts can be 100 MB+; we never read a whole file.
//! `label` / `resumable` / `cwd` come from the first [`HEAD_SCAN_BOUND`] bytes,
//! read line-by-line with early exit (typically a few KiB). The honest tradeoff:
//! a transcript whose first user message sits beyond the bound gets the fallback
//! label — but a file that large is certainly a real conversation, so a truncated
//! head is *assumed* resumable rather than mislabeled unresumable.

use std::collections::HashSet;
use std::io::{BufRead, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::agent::claude::home_dir;

/// How much of a transcript's head we are willing to read to derive its metadata.
const HEAD_SCAN_BOUND: u64 = 256 * 1024;

/// Label cap, in characters (labels are human handles in a list row).
const LABEL_MAX_CHARS: usize = 120;

/// The fallback label for a transcript with no summary and no user message.
const NO_MESSAGES_LABEL: &str = "(no messages)";

/// One past session, as the "Recover session" list renders it.
///
/// Frontend contract (built in parallel against this — camelCase on the wire):
/// `invoke<ClaudeSessionMeta[]>('list_claude_sessions', { cwd })`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionMeta {
    /// The transcript filename stem — exactly what `resume_session_id` wants.
    pub session_id: String,
    /// File mtime, ms epoch — the session's last activity.
    pub mtime_ms: i64,
    pub size_bytes: u64,
    /// Human handle: the transcript's summary line if present, else the first
    /// user message (single-line, ~120 chars), else [`NO_MESSAGES_LABEL`].
    pub label: String,
    /// `true` iff the transcript has at least one real message line:
    /// `claude --resume` errors on an id with no conversation, so the UI must not
    /// offer to resume one.
    pub resumable: bool,
}

/// List the past Claude Code sessions that ran in `cwd`, newest-first.
///
/// A cwd with no sessions (or no `~/.claude/projects` at all) is a **normal case**
/// and returns `Ok(vec![])`, never an error — same philosophy as `git.rs`.
#[tauri::command]
pub fn list_claude_sessions(cwd: String) -> Result<Vec<ClaudeSessionMeta>, String> {
    Ok(sessions_for_cwd(&cwd))
}

/// The scan itself, separated from the command for direct test drive.
pub fn sessions_for_cwd(cwd: &str) -> Vec<ClaudeSessionMeta> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let projects = home.join(".claude").join("projects");

    // The cwd shapes a transcript's `cwd` field may carry: the path as given, and
    // its symlink-resolved form (`claude` canonicalizes — /tmp/x runs as
    // /private/tmp/x on macOS). Normalized so a trailing slash never misses.
    //
    // Windows: `paths::canonicalize` (`std`'s answers `\\?\C:\…`, which no
    // transcript holds) and `paths::cwd_key`, which folds case and reads `/` as `\` for a
    // Windows spelling — a typed `c:\repo` and Claude Code's `C:\Repo` are one folder. The
    // keys of a Windows cwd are lower-case, so its dir names are compared lower-cased too.
    let mut targets: HashSet<String> = HashSet::new();
    targets.insert(normalize_cwd(cwd));
    if let Ok(canon) = crate::paths::canonicalize(cwd) {
        targets.insert(normalize_cwd(&canon.to_string_lossy()));
    }
    let fold_names = crate::paths::is_windows_spelling(cwd);
    let mangled: HashSet<String> = targets.iter().map(|t| mangle(t)).collect();

    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return out; // no projects dir yet — a fresh machine, not an error
    };
    for project in entries.flatten() {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        let candidates = scan_project_dir(&dir);

        // Does this project dir host the requested cwd? Primary evidence: any
        // transcript inside carries a matching `cwd`. Secondary: the dir name is
        // the mangle of the cwd (covers a dir whose only transcripts are
        // empty/summary-only and thus carry no `cwd` field).
        let name_matches = dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            if fold_names {
                mangled.contains(&n.to_ascii_lowercase())
            } else {
                mangled.contains(n)
            }
        });
        let any_transcript_matches = candidates.iter().any(|c| {
            c.head
                .cwd
                .as_deref()
                .is_some_and(|fc| targets.contains(&normalize_cwd(fc)))
        });
        if !name_matches && !any_transcript_matches {
            continue;
        }

        for c in candidates {
            // A transcript's own `cwd` is authoritative: if present and different
            // it belongs elsewhere (the mangling is lossy — two cwds can share a
            // dir). Absent (empty/summary-only/garbage) → dir attribution stands.
            if let Some(fc) = &c.head.cwd {
                if !targets.contains(&normalize_cwd(fc)) {
                    continue;
                }
            }
            out.push(ClaudeSessionMeta {
                session_id: c.session_id,
                mtime_ms: c.mtime_ms,
                size_bytes: c.size_bytes,
                label: label_of(&c.head),
                resumable: c.head.has_message || c.head.truncated,
            });
        }
    }
    // Newest-first; id tiebreak so equal mtimes stay deterministic.
    out.sort_by(|a, b| {
        b.mtime_ms
            .cmp(&a.mtime_ms)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    out
}

/// One transcript file found in a project dir, with its bounded head scan.
struct Candidate {
    session_id: String,
    mtime_ms: i64,
    size_bytes: u64,
    head: HeadScan,
}

/// Everything derivable from a transcript's first [`HEAD_SCAN_BOUND`] bytes.
#[derive(Default)]
pub(crate) struct HeadScan {
    /// The first `cwd` field seen — the session's true working directory.
    pub(crate) cwd: Option<String>,
    /// The first `{"type":"summary","summary":…}` line's text.
    summary: Option<String>,
    /// The first real user prompt's text.
    first_user_text: Option<String>,
    /// A real message line (user/assistant with a `message` object) exists.
    has_message: bool,
    /// The file is larger than the bound — the scan may have missed lines.
    truncated: bool,
}

/// Collect every `<session-id>.jsonl` directly inside a project dir.
///
/// Skips calmly: non-`.jsonl` names, directories (a `<session-id>/` subdir holds
/// sub-agent files, not a session), and files that cannot be opened/statted.
fn scan_project_dir(dir: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(stem) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue; // unstatable — skip the file entirely
        };
        if !meta.is_file() {
            continue;
        }
        let Some(head) = scan_head(&path, meta.len()) else {
            continue; // unopenable — skip the file entirely
        };
        out.push(Candidate {
            session_id: stem.to_string(),
            mtime_ms: mtime_ms(&meta),
            size_bytes: meta.len(),
            head,
        });
    }
    out
}

/// Bounded, line-by-line head scan. `None` only when the file cannot be opened;
/// malformed *lines* (garbage, truncated tail mid-write) are skipped calmly and
/// the scan keeps whatever it has — same robustness stance as `parse_fanout`.
pub(crate) fn scan_head(path: &Path, file_len: u64) -> Option<HeadScan> {
    let file = std::fs::File::open(path).ok()?;
    let truncated = file_len > HEAD_SCAN_BOUND;
    let mut reader = std::io::BufReader::new(file).take(HEAD_SCAN_BOUND);

    let mut scan = HeadScan {
        truncated,
        ..HeadScan::default()
    };
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        // `read_until` (not `read_line`) so a non-UTF-8 garbage line doesn't
        // abort the scan; `take` caps total bytes even if one line is gigantic.
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break, // EOF, bound hit, or I/O error — keep what we have
            Ok(_) => {}
        }
        // A line cut off by the byte bound (no terminator, more file beyond) is
        // incomplete JSON — drop it rather than misparse it.
        if truncated && !buf.ends_with(b"\n") {
            break;
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) else {
            continue; // malformed line — skip calmly
        };
        absorb_line(&mut scan, &v);
        // Early exit once nothing further can change the result: identity known,
        // resumable known, and a label source found (summary outranks user text,
        // so either one settles the label).
        if scan.cwd.is_some()
            && scan.has_message
            && (scan.summary.is_some() || scan.first_user_text.is_some())
        {
            break;
        }
    }
    Some(scan)
}

/// Fold one parsed transcript line into the scan (first occurrence wins).
fn absorb_line(scan: &mut HeadScan, v: &serde_json::Value) {
    if scan.cwd.is_none() {
        scan.cwd = nonblank_str(v.get("cwd"));
    }
    let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if line_type == "summary" && scan.summary.is_none() {
        scan.summary = nonblank_str(v.get("summary"));
    }
    if (line_type == "user" || line_type == "assistant")
        && v.get("message").is_some_and(|m| m.is_object())
    {
        scan.has_message = true;
    }
    if scan.first_user_text.is_none() {
        scan.first_user_text = user_prompt_text(v, line_type);
    }
}

/// The text of a real user prompt line, or `None` for anything else (assistant
/// turns, tool_result-only user lines, meta/command noise).
fn user_prompt_text(v: &serde_json::Value, line_type: &str) -> Option<String> {
    if line_type != "user" {
        return None;
    }
    // `isMeta` lines are local-command echoes and caveats, not the user's words.
    if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
        return None;
    }
    let msg = v.get("message")?;
    if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    match msg.get("content")? {
        serde_json::Value::String(s) => nonblank(s),
        serde_json::Value::Array(blocks) => blocks.iter().find_map(|b| {
            (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .then(|| b.get("text").and_then(|t| t.as_str()).and_then(nonblank))
                .flatten()
        }),
        _ => None,
    }
}

/// Summary if present, else first user message, else the placeholder — the wire
/// contract's exact precedence.
fn label_of(head: &HeadScan) -> String {
    if let Some(s) = &head.summary {
        return single_line_label(s);
    }
    if let Some(t) = &head.first_user_text {
        return single_line_label(t);
    }
    NO_MESSAGES_LABEL.to_string()
}

/// Collapse all whitespace runs (newlines included) to single spaces and cap at
/// [`LABEL_MAX_CHARS`] characters, appending `…` if cut. Char-based, so a
/// multibyte char is never split.
fn single_line_label(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= LABEL_MAX_CHARS {
        return collapsed;
    }
    let mut t: String = collapsed.chars().take(LABEL_MAX_CHARS).collect();
    t.push('…');
    t
}

/// Trailing-slash-insensitive comparison form (`/a/b/` ≡ `/a/b`; `/` stays `/`).
fn normalize_cwd(s: &str) -> String {
    // Unix spellings exactly as before; Windows ones folded (`paths::cwd_key`).
    crate::paths::cwd_key(s)
}

/// `claude`'s project-dir mangle: every non-alphanumeric char becomes `-`
/// (`/work/proj` → `-work-proj`). Used only to *compare* against dir names read
/// from disk — never to build a path — and it cannot preserve `..` anyway.
fn mangle(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// File mtime as ms epoch; anything unusual (pre-epoch, unsupported) yields 0.
fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn nonblank(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| s.to_string())
}

fn nonblank_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).and_then(nonblank)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mangle_matches_claudes_dir_names_and_cannot_preserve_traversal() {
        assert_eq!(mangle("/work/proj"), "-work-proj");
        assert_eq!(
            mangle("/Users/sam/my.app_v2"),
            "-Users-sam-my-app-v2",
            "dots and underscores mangle too"
        );
        assert!(
            !mangle("/a/../../etc").contains(".."),
            "traversal must not survive the mangle"
        );
    }

    #[test]
    fn normalize_cwd_is_trailing_slash_insensitive() {
        assert_eq!(normalize_cwd("/a/b/"), "/a/b");
        assert_eq!(normalize_cwd("/a/b"), "/a/b");
        assert_eq!(normalize_cwd("/"), "/", "root must survive");
        // Windows spellings: one key for every spelling of one folder, and its mangle is the
        // lower-cased project-dir name Claude Code writes (`C--Users-me-repo`).
        assert_eq!(
            normalize_cwd(r"c:\Users\me\Repo\"),
            normalize_cwd(r"\\?\C:\users\me\repo")
        );
        assert_eq!(
            mangle(&normalize_cwd(r"C:\Users\me\repo")),
            "C--Users-me-repo".to_ascii_lowercase()
        );
    }

    #[test]
    fn labels_collapse_newlines_and_cap_at_120_chars() {
        assert_eq!(
            single_line_label("fix\nthe   build\t now"),
            "fix the build now"
        );
        let long = "word ".repeat(100);
        let l = single_line_label(&long);
        assert_eq!(l.chars().count(), LABEL_MAX_CHARS + 1, "cap + ellipsis");
        assert!(l.ends_with('…'));
        // Multibyte chars are counted as chars, never split mid-encoding.
        let accented = "é".repeat(200);
        let l = single_line_label(&accented);
        assert_eq!(l.chars().count(), LABEL_MAX_CHARS + 1);
    }
}

/// The Claude session id to resume a FINISHED root agent with — the "Resume
/// conversation" action on an agent whose `claude` died (a killed session left the tab
/// frozen with no way back into the conversation).
///
/// Frontend contract: `invoke('agent_resume_session', { agentId })` → the id, which
/// the UI hands to the existing `agent_spawn` `resumeSessionId` path. This exposes a
/// session id exactly as `list_claude_sessions` ("Recover session…") already does,
/// and only for a root that has **finished** — a live session is never resumable
/// twice. Errors: `"not-finished"`, `"not-a-root"`, `"no-session"` (no saved
/// transcript, so `claude --resume` would fail).
#[tauri::command]
pub async fn agent_resume_session(
    supervisor: tauri::State<'_, crate::supervisor::SupervisorHandle>,
    agent_id: String,
) -> Result<String, String> {
    let info = supervisor
        .describe_pinnable(agent_id)
        .await?
        .ok_or_else(|| "not-a-root".to_string())?;
    if !info.finished {
        return Err("not-finished".to_string());
    }
    resumable(&info.session_id, |id| {
        crate::agent::claude::locate_transcript(id).is_some()
    })
}

/// `Ok(id)` when a transcript exists for it. Pure over `exists` so it is testable.
fn resumable(session_id: &str, exists: impl Fn(&str) -> bool) -> Result<String, String> {
    if exists(session_id) {
        Ok(session_id.to_string())
    } else {
        Err("no-session".to_string())
    }
}

#[cfg(test)]
mod resume_tests {
    use super::resumable;

    #[test]
    fn resumable_needs_a_saved_transcript() {
        assert_eq!(resumable("abc", |_| true), Ok("abc".to_string()));
        assert_eq!(resumable("abc", |_| false), Err("no-session".to_string()));
    }
}
