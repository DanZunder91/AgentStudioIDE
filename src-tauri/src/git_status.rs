//! Working-tree status for the file tree's git decorations.
//!
//! One command, [`git_status`]: given an allowed directory, return the branch plus
//! every path that differs from `HEAD` — staged and unstaged **unioned**, because
//! the IDE view is "what differs from HEAD", not git's two-column index/worktree
//! split. The wire vocabulary is exactly the frontend's existing `GitStatus` union
//! (`src/app/types.ts`): `modified | added | deleted | untracked`.
//!
//! **Security scope.** The root is a user-supplied path, so it goes
//! through the same server-authoritative guard as every fs command:
//! [`crate::fs_tree::resolve_in_scope`] against [`crate::fs_tree::allowed_roots`]
//! — checked *before* anything git-related happens, so an out-of-scope path never
//! reveals whether it is in a repository (the error is byte-identical for a repo
//! and a plain directory).
//!
//! **Why `git2` and not a subprocess.** Same reasons as `git_blame`: a
//! GUI-launched app has a minimal `PATH` (`git` may not be findable at all), and
//! the crate is already in-tree, vendored and network-free.
//!
//! Errors are `"<code>"` or `"<code>: <detail>"` with the code from
//! [`ERROR_CODES`] — the frontend splits on the first `':'`.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The complete error vocabulary. `not-a-repo` is deliberately bare (no detail):
/// a directory outside any repository is a normal state the UI hides calmly, not
/// a diagnostic.
pub const ERROR_CODES: [&str; 4] = ["out-of-scope", "not-a-repo", "git", "unknown"];

/// How one path differs from `HEAD`. Serialized as the snake_case wire strings
/// the frontend's `GitStatus` union already names: `modified`, `added`,
/// `deleted`, `untracked`.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
}

/// One changed path. `path` is **absolute** (workdir-joined, native separators).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub status: GitChangeStatus,
}

/// The whole reading for one repository.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// The repository's **working-tree root** (canonical, absolute) — the prefix
    /// every `changes[].path` starts with. Deliberately the repo root rather than
    /// an echo of the requested directory: the request may name any allowed
    /// subdirectory, and the caller needs the prefix to relativize paths against.
    pub root: String,
    /// The checked-out branch (short SHA when detached, `""` when unreadable) —
    /// via [`crate::git::current_branch`].
    pub branch: String,
    /// Every path differing from `HEAD`, sorted by path for a stable wire order.
    pub changes: Vec<GitChange>,
}

/// Status of the repository containing `requested`, confined to `allowed_roots`.
///
/// Steps, in order: scope-check the path (out-of-scope fails before any git
/// access), require a directory, discover the containing repository (walking up —
/// any allowed dir inside a repo works, and the changes are repo-wide), then run
/// libgit2's status walk with: untracked included (and recursed into untracked
/// dirs), ignored excluded, submodules excluded, renames not detected (a rename
/// reports `deleted` old + `added` new).
pub fn git_status_scoped(
    requested: &Path,
    allowed_roots: &[PathBuf],
) -> Result<RepoStatus, String> {
    // Both guard failures ("path does not exist" / "path is outside the allowed
    // workspace roots") map to `out-of-scope` with the original message as the
    // detail — neither reveals anything about repo-ness.
    let real = crate::fs_tree::resolve_in_scope(requested, allowed_roots)
        .map_err(|msg| format!("out-of-scope: {msg}"))?;
    if !real.is_dir() {
        // A file is not a repo working directory; a calm, bare `not-a-repo`.
        return Err("not-a-repo".to_string());
    }

    // Not being in a repo is a normal state, never a diagnostic — bare code.
    let repo = git2::Repository::discover(&real).map_err(|_| "not-a-repo".to_string())?;
    // A bare repository has no working tree to diff — same calm code.
    let workdir = repo.workdir().ok_or_else(|| "not-a-repo".to_string())?;
    // Canonicalize before joining: the workdir may be a non-canonical spelling
    // (macOS `/tmp` → `/private/tmp`), and the contract is absolute real paths.
    let workdir = crate::paths::canonicalize(workdir)
        .map_err(|_| "git: cannot resolve the repository root".to_string())?;

    let branch = crate::git::current_branch(&workdir);

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .exclude_submodules(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("git: {}", detail(e.message())))?;

    let mut changes: Vec<GitChange> = Vec::new();
    for entry in statuses.iter() {
        let Some(status) = map_status(entry.status()) else {
            continue;
        };
        // git paths are `/`-separated repo-relative bytes; join component-wise so
        // the result uses native separators on every platform. Lossy UTF-8: git
        // allows arbitrary bytes and a stray one must not fail the whole reading.
        let rel = String::from_utf8_lossy(entry.path_bytes()).into_owned();
        changes.push(GitChange {
            path: join_native(&workdir, &rel),
            status,
        });
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(RepoStatus {
        root: workdir.to_string_lossy().into_owned(),
        branch,
        changes,
    })
}

/// libgit2's status bits → the wire vocabulary, or `None` for "not a change".
///
/// Precedence, in order — each rule documented because several bits can be set at
/// once:
/// 1. **Worktree deletion wins** (`WT_DELETED`): a file both staged-modified and
///    deleted on disk is `deleted` — the worktree is what the user sees. The one
///    exception is `INDEX_NEW | WT_DELETED` (staged brand-new file, then deleted
///    on disk): it never existed in `HEAD` and no longer exists on disk, so
///    nothing differs from `HEAD` — `None`.
/// 2. `INDEX_DELETED`: staged deletion → `deleted`; unless the file is *also*
///    back on disk untracked (`git rm --cached`) → `untracked`.
/// 3. `INDEX_NEW` → `added` (staged new; even if since edited — vs `HEAD` it is
///    an addition either way).
/// 4. `WT_NEW` → `untracked`.
/// 5. Content/typechange on either side (and conflicts) → `modified`.
fn map_status(s: git2::Status) -> Option<GitChangeStatus> {
    use git2::Status as S;
    if s.contains(S::WT_DELETED) {
        return if s.contains(S::INDEX_NEW) {
            None
        } else {
            Some(GitChangeStatus::Deleted)
        };
    }
    if s.contains(S::INDEX_DELETED) {
        return Some(if s.contains(S::WT_NEW) {
            GitChangeStatus::Untracked
        } else {
            GitChangeStatus::Deleted
        });
    }
    if s.contains(S::INDEX_NEW) {
        return Some(GitChangeStatus::Added);
    }
    if s.contains(S::WT_NEW) {
        return Some(GitChangeStatus::Untracked);
    }
    if s.intersects(
        S::INDEX_MODIFIED | S::WT_MODIFIED | S::INDEX_TYPECHANGE | S::WT_TYPECHANGE | S::CONFLICTED,
    ) {
        return Some(GitChangeStatus::Modified);
    }
    None
}

/// Join a `/`-separated repo-relative path onto the workdir **component-wise**,
/// so separators come out native on every platform.
fn join_native(workdir: &Path, rel: &str) -> String {
    let mut p = workdir.to_path_buf();
    for comp in rel.split('/').filter(|c| !c.is_empty()) {
        p.push(comp);
    }
    p.to_string_lossy().into_owned()
}

/// First non-blank line of a libgit2 message, truncated — an error detail, never
/// a transcript.
fn detail(msg: &str) -> String {
    const MAX: usize = 80;
    let line = msg
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let mut short: String = line.chars().take(MAX).collect();
    if short.chars().count() < line.chars().count() {
        short.push('…');
    }
    short
}

/// HEAD-vs-working-tree status for the file tree's git decorations.
///
/// Frontend contract: `invoke<RepoStatus>('git_status', { root })`. `root` is any
/// allowed directory (the repo is discovered by walking up). Errors are coded per
/// [`ERROR_CODES`]; `not-a-repo` is the calm no-repo state the UI hides.
#[tauri::command]
pub fn git_status(app: tauri::AppHandle, root: String) -> Result<RepoStatus, String> {
    git_status_scoped(Path::new(&root), &crate::fs_tree::allowed_roots(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Status as S;
    use serde_json::json;

    // ── the bit mapping (the risky seam: several bits at once) ────────────

    #[test]
    fn plain_single_bit_statuses_map_to_the_wire_vocabulary() {
        assert_eq!(map_status(S::WT_NEW), Some(GitChangeStatus::Untracked));
        assert_eq!(map_status(S::INDEX_NEW), Some(GitChangeStatus::Added));
        assert_eq!(map_status(S::WT_MODIFIED), Some(GitChangeStatus::Modified));
        assert_eq!(
            map_status(S::INDEX_MODIFIED),
            Some(GitChangeStatus::Modified)
        );
        assert_eq!(map_status(S::WT_DELETED), Some(GitChangeStatus::Deleted));
        assert_eq!(map_status(S::INDEX_DELETED), Some(GitChangeStatus::Deleted));
        assert_eq!(
            map_status(S::WT_TYPECHANGE),
            Some(GitChangeStatus::Modified)
        );
        assert_eq!(
            map_status(S::INDEX_TYPECHANGE),
            Some(GitChangeStatus::Modified)
        );
        assert_eq!(map_status(S::CONFLICTED), Some(GitChangeStatus::Modified));
    }

    #[test]
    fn a_clean_or_ignored_entry_is_not_a_change() {
        assert_eq!(map_status(S::CURRENT), None);
        // `include_ignored(false)` should keep these out entirely; the mapping
        // refuses them anyway, so neither guard can rot behind the other.
        assert_eq!(map_status(S::IGNORED), None);
    }

    #[test]
    fn worktree_deletion_wins_over_a_staged_modification() {
        // The contract's named combination: staged-modified + deleted on disk.
        assert_eq!(
            map_status(S::INDEX_MODIFIED | S::WT_DELETED),
            Some(GitChangeStatus::Deleted)
        );
    }

    #[test]
    fn a_staged_new_file_deleted_on_disk_is_no_change_at_all() {
        // Never in HEAD, no longer on disk: nothing differs from HEAD.
        assert_eq!(map_status(S::INDEX_NEW | S::WT_DELETED), None);
    }

    #[test]
    fn a_staged_new_file_since_edited_is_still_added() {
        // vs HEAD it is an addition, however much it was edited after staging.
        assert_eq!(
            map_status(S::INDEX_NEW | S::WT_MODIFIED),
            Some(GitChangeStatus::Added)
        );
    }

    #[test]
    fn git_rm_cached_reports_the_on_disk_file_as_untracked() {
        assert_eq!(
            map_status(S::INDEX_DELETED | S::WT_NEW),
            Some(GitChangeStatus::Untracked)
        );
    }

    #[test]
    fn staged_and_unstaged_modifications_together_are_modified() {
        assert_eq!(
            map_status(S::INDEX_MODIFIED | S::WT_MODIFIED),
            Some(GitChangeStatus::Modified)
        );
    }

    // ── the wire shape (what the frontend reads) ──────────────────────────

    #[test]
    fn statuses_serialize_to_the_frontends_exact_wire_strings() {
        assert_eq!(
            serde_json::to_value(GitChangeStatus::Modified).unwrap(),
            json!("modified")
        );
        assert_eq!(
            serde_json::to_value(GitChangeStatus::Added).unwrap(),
            json!("added")
        );
        assert_eq!(
            serde_json::to_value(GitChangeStatus::Deleted).unwrap(),
            json!("deleted")
        );
        assert_eq!(
            serde_json::to_value(GitChangeStatus::Untracked).unwrap(),
            json!("untracked")
        );
    }

    #[test]
    fn repo_status_serializes_camel_case() {
        let wire = serde_json::to_value(RepoStatus {
            root: "/r".into(),
            branch: "main".into(),
            changes: vec![GitChange {
                path: "/r/a.txt".into(),
                status: GitChangeStatus::Untracked,
            }],
        })
        .unwrap();
        assert_eq!(
            wire,
            json!({
                "root": "/r",
                "branch": "main",
                "changes": [{ "path": "/r/a.txt", "status": "untracked" }]
            })
        );
    }

    // ── helpers ───────────────────────────────────────────────────────────

    #[test]
    fn join_native_joins_slash_separated_components() {
        let joined = join_native(Path::new("/w"), "sub/inner.txt");
        assert_eq!(
            PathBuf::from(&joined),
            Path::new("/w").join("sub").join("inner.txt")
        );
        assert_eq!(join_native(Path::new("/w"), "top.txt"), {
            Path::new("/w")
                .join("top.txt")
                .to_string_lossy()
                .into_owned()
        });
    }

    #[test]
    fn detail_is_first_non_blank_line_truncated() {
        assert_eq!(detail("boom"), "boom");
        assert_eq!(detail("\n\n  second  \nthird"), "second");
        assert_eq!(detail(""), "");
        let long = "x".repeat(200);
        let d = detail(&long);
        assert_eq!(d.chars().count(), 81, "80 chars + ellipsis");
        assert!(d.ends_with('…'));
    }
}
