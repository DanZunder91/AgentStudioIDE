//! IntelliJ-style git blame for the editor.
//!
//! One command, [`git_blame`]: given an absolute file path, return per-line
//! authorship — a **deduped** commit table plus a `lines` vector mapping each line
//! to an index into that table. The frontend renders it as a blame gutter and only
//! needs each commit's metadata once, however many lines it owns.
//!
//! **Security scope.** Blame is a read on a user-supplied path, so it
//! goes through the exact same server-authoritative guard as every other fs
//! command: [`crate::fs_tree::resolve_in_scope`] against
//! [`crate::fs_tree::allowed_roots`] (recents ∪ workspace). The scope is checked
//! *before* anything git-related happens, so an out-of-scope path never even
//! reveals whether it is in a repository.
//!
//! **Why `git2` and not the hand-rolled reader or a subprocess.** `git.rs` reads
//! `.git/HEAD` directly because branch resolution is trivial and stable; blame is
//! full history traversal + diff, which only a real libgit2 does correctly. And we
//! never shell out to `git` — a GUI-launched app has a minimal `PATH` (see
//! `git.rs`'s doc header), so the binary may not even be findable. The crate is
//! built with `default-features = false` (no ssh/https network stack — blame is
//! local-only) plus `vendored-libgit2` (self-contained build; zero-install).
//!
//! The logic ([`blame_scoped`]) takes the allowed roots explicitly so integration
//! tests drive it against real temp repos with no `AppHandle` — the same
//! `*_scoped` pattern as `fs_tree`. The `#[tauri::command]` is thin glue.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One commit in the blame result, deduped — referenced by index from
/// [`FileBlame::lines`].
///
/// Frontend contract (camelCase on the wire): `{ id, author, email, timeMs,
/// summary, message }`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommitWire {
    /// Full 40-char hex commit id.
    pub id: String,
    /// Author name (lossy UTF-8 — git allows arbitrary bytes).
    pub author: String,
    /// Author email (lossy UTF-8).
    pub email: String,
    /// Author time as milliseconds since the Unix epoch, UTC. Git stores the
    /// author time as UTC epoch seconds plus a display-only timezone offset; the
    /// epoch instant is the seconds alone, so this is `seconds * 1000` — the
    /// offset would only matter for rendering the author's local wall clock.
    pub time_ms: i64,
    /// First line of the commit message.
    pub summary: String,
    /// The full commit message (summary + body).
    pub message: String,
}

/// The blame for one file: a deduped commit table + a per-line index into it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    /// The file's path relative to the repository root (what git itself blames).
    pub rel_path: String,
    /// Every distinct commit that owns at least one line, in first-seen order.
    pub commits: Vec<BlameCommitWire>,
    /// `lines[i]` = index into `commits` for line `i + 1` (1-based lines).
    /// `None` = the line is not attributable to any commit — libgit2 marks such
    /// lines with the zero OID. Measured (and pinned by the integration tests):
    /// with the v1 default options `blame_file` blames HEAD's content only, so
    /// unstaged *and* staged local edits are simply absent from this vector
    /// rather than `None`; the `None` mapping is kept as the contract for any
    /// input libgit2 does mark unattributable — measured for the dirty-buffer
    /// `blame_buffer` overlay in
    /// `tests/git_blame.rs::blame_buffer_signatures_are_null_checked_options`: that
    /// path *does* emit zero-OID hunks for unsaved lines, so `None` is the shape
    /// that overlay will use. Such a hunk also has **no signatures**
    /// (`final_signature()`/`orig_signature()` are `None`), which is why the crate
    /// floor is `git2 >= 0.21` — see the `git2` note in `Cargo.toml`.
    pub lines: Vec<Option<u32>>,
}

/// Blame `requested`, confined to `allowed_roots`.
///
/// Steps, in order: scope-check the path (the single [`resolve_in_scope`] guard —
/// out-of-scope fails before any git access), require a regular file, discover the
/// containing repository from the file's parent, blame the repo-relative path, and
/// fold the hunks into the deduped wire shape. Each unique commit is looked up
/// exactly once for its metadata.
///
/// `blame_file` operates on the file's committed/on-disk state; an unsaved editor
/// buffer is the frontend's concern. Blame options are the v1 defaults: no copy
/// tracking, first-parent history as libgit2 defines it.
///
/// [`resolve_in_scope`]: crate::fs_tree::resolve_in_scope
pub fn blame_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Result<FileBlame, String> {
    let real = crate::fs_tree::resolve_in_scope(requested, allowed_roots)?;
    if !real.is_file() {
        return Err("path is not a file".to_string());
    }

    // Discover the repo from the file's parent (the file itself is not a
    // directory to discover from). Not being in a repo is a normal case the UI
    // shows inline — keep the message calm and human.
    let parent = real
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let repo =
        git2::Repository::discover(parent).map_err(|_| "not in a git repository".to_string())?;

    // Blame wants the path relative to the working tree root. Canonicalize the
    // workdir before stripping: `real` is canonical (resolve_in_scope), while the
    // workdir may be a non-canonical spelling (macOS `/tmp` → `/private/tmp`).
    let workdir = repo
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    let workdir = crate::paths::canonicalize(workdir)
        .map_err(|_| "cannot resolve the repository root".to_string())?;
    let rel = real
        .strip_prefix(&workdir)
        .map_err(|_| "file is not inside the repository".to_string())?;

    // v1 defaults: no copy/move tracking (track_copies_* all default off),
    // first-parent traversal as libgit2 defaults it, newest commit = HEAD.
    let mut opts = git2::BlameOptions::new();
    let blame = repo
        .blame_file(rel, Some(&mut opts))
        .map_err(|e| format!("cannot blame file: {}", e.message()))?;

    // Fold hunks → per-line commit indices, looking up each unique commit ONCE.
    let mut commits: Vec<BlameCommitWire> = Vec::new();
    let mut index_of: std::collections::HashMap<git2::Oid, u32> = std::collections::HashMap::new();
    let mut lines: Vec<Option<u32>> = Vec::new();

    for hunk in blame.iter() {
        // libgit2 emits a single ZERO-LENGTH hunk for an empty file; skip it so
        // the invariant holds: `commits` lists only commits owning ≥ 1 line.
        if hunk.lines_in_hunk() == 0 {
            continue;
        }
        let oid = hunk.final_commit_id();
        // The zero OID marks lines libgit2 cannot attribute to any commit (e.g.
        // content that exists in the index/working tree but in no commit yet).
        let entry = if oid.is_zero() {
            None
        } else {
            let idx = match index_of.get(&oid) {
                Some(&i) => i,
                None => {
                    let commit = repo
                        .find_commit(oid)
                        .map_err(|e| format!("cannot read commit: {}", e.message()))?;
                    let i =
                        u32::try_from(commits.len()).map_err(|_| "too many commits".to_string())?;
                    commits.push(commit_wire(&commit));
                    index_of.insert(oid, i);
                    i
                }
            };
            Some(idx)
        };

        // Hunk lines are 1-based and contiguous; hunks arrive in line order, so
        // extending the vector per hunk yields lines[i] = line i+1. `resize` (not
        // plain pushes) keeps this correct even if a gap ever appeared.
        let start = hunk.final_start_line(); // 1-based
        let end = start + hunk.lines_in_hunk();
        if lines.len() < end - 1 {
            lines.resize(end - 1, None);
        }
        for slot in &mut lines[start - 1..end - 1] {
            *slot = entry;
        }
    }

    Ok(FileBlame {
        rel_path: rel.to_string_lossy().into_owned(),
        commits,
        lines,
    })
}

/// A commit's wire metadata. Names/emails/messages are arbitrary bytes in git, so
/// every string field is a lossy UTF-8 conversion — never an error.
fn commit_wire(commit: &git2::Commit) -> BlameCommitWire {
    let author = commit.author();
    let message = String::from_utf8_lossy(commit.message_bytes()).into_owned();
    let summary = message.lines().next().unwrap_or("").to_string();
    BlameCommitWire {
        id: commit.id().to_string(),
        author: String::from_utf8_lossy(author.name_bytes()).into_owned(),
        email: String::from_utf8_lossy(author.email_bytes()).into_owned(),
        // Git's author time is UTC epoch seconds; the offset is display-only (see
        // the field doc on `time_ms`).
        time_ms: author.when().seconds() * 1000,
        summary,
        message,
    }
}

/// Per-line git blame for the editor gutter.
///
/// Frontend contract: `invoke<FileBlame>('git_blame', { path })`. `path` is an
/// absolute file path (e.g. the open editor's file). Out-of-scope / nonexistent /
/// not-a-file / not-in-a-repo / untracked → `Err(<short message>)`, which the UI
/// shows inline rather than as a crash.
#[tauri::command]
pub fn git_blame(app: tauri::AppHandle, path: String) -> Result<FileBlame, String> {
    blame_scoped(Path::new(&path), &crate::fs_tree::allowed_roots(&app))
}
