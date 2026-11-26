//! `git_status::git_status_scoped` (HEAD vs working tree, for file-tree decorations) against
//! real repos built with `git2`, never shelling out; scope via canonicalized temp roots.

use std::path::{Path, PathBuf};

use agent_studio_scaffold_lib::git_status::{git_status_scoped, GitChangeStatus, RepoStatus};

/// A throwaway directory that cleans itself up.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let p =
            std::env::temp_dir().join(format!("agentstudio-status-{label}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&p).expect("mkdir");
        // Resolve symlinks (macOS /tmp → /private/tmp) so the root we authorize
        // is the same canonical path `resolve_in_scope` compares against.
        Self(agent_studio_scaffold_lib::paths::canonicalize(&p).unwrap_or(p))
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn roots(&self) -> Vec<PathBuf> {
        vec![self.0.clone()]
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Write `content` to `rel` inside the repo's workdir, stage it, and commit it.
fn commit_file(repo: &git2::Repository, rel: &str, content: &str, message: &str) -> String {
    let workdir = repo.workdir().expect("test repos have a workdir");
    let abs = workdir.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&abs, content).unwrap();

    let mut index = repo.index().unwrap();
    index.add_path(Path::new(rel)).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();

    let sig = git2::Signature::new(
        "Status Tester",
        "status@example.com",
        &git2::Time::new(1_700_000_000, 0),
    )
    .unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
        .to_string()
}

/// Stage `rel` (must already exist on disk) without committing.
fn stage(repo: &git2::Repository, rel: &str) {
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(rel)).unwrap();
    index.write().unwrap();
}

/// A fresh repo with one committed file and a **deterministic** branch name —
/// `Repository::init`'s default branch depends on the machine's global
/// `init.defaultBranch`, so the fixture pins its own (`trunk`) instead.
fn repo_with_commit(d: &TempDir) -> git2::Repository {
    let repo = git2::Repository::init(d.path()).unwrap();
    commit_file(&repo, "base.txt", "base\n", "initial commit");
    {
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("trunk", &head, false).unwrap();
    }
    repo.set_head("refs/heads/trunk").unwrap();
    repo
}

/// The changes as `(absolute-path, status)` pairs, in wire order.
fn change_pairs(status: &RepoStatus) -> Vec<(String, GitChangeStatus)> {
    status
        .changes
        .iter()
        .map(|c| (c.path.clone(), c.status))
        .collect()
}

/// `rel` is git-style (`sub/inner.txt`); join it per component so separators are native, as
/// the product does (on Windows a single `join` keeps the `/`).
fn abs(d: &TempDir, rel: &str) -> String {
    rel.split('/')
        .fold(d.path().to_path_buf(), |p, c| p.join(c))
        .to_string_lossy()
        .into_owned()
}

// ── the calm baseline ─────────────────────────────────────────────────────

/// 1. A clean repo: empty changes, the pinned branch name, and `root` = the
///    canonical workdir.
#[test]
fn a_clean_repo_has_no_changes_and_names_its_branch() {
    let d = TempDir::new("clean");
    let _repo = repo_with_commit(&d);

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(status.changes, vec![], "nothing differs from HEAD");
    assert_eq!(status.branch, "trunk", "the fixture's pinned branch");
    assert_eq!(
        PathBuf::from(&status.root),
        d.path(),
        "root = the canonical repository workdir"
    );
}

// ── the four wire statuses ────────────────────────────────────────────────

/// 2. An untracked file → `untracked`.
#[test]
fn an_untracked_file_is_untracked() {
    let d = TempDir::new("untracked");
    let _repo = repo_with_commit(&d);
    std::fs::write(d.path().join("new.txt"), "hi\n").unwrap();

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(
        change_pairs(&status),
        vec![(abs(&d, "new.txt"), GitChangeStatus::Untracked)]
    );
}

/// 3. A staged new file → `added`.
#[test]
fn a_staged_new_file_is_added() {
    let d = TempDir::new("added");
    let repo = repo_with_commit(&d);
    std::fs::write(d.path().join("staged.txt"), "hi\n").unwrap();
    stage(&repo, "staged.txt");

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(
        change_pairs(&status),
        vec![(abs(&d, "staged.txt"), GitChangeStatus::Added)]
    );
}

/// 4a. A committed file edited in the worktree (UNSTAGED) → `modified`.
#[test]
fn an_unstaged_edit_of_a_committed_file_is_modified() {
    let d = TempDir::new("mod-unstaged");
    let _repo = repo_with_commit(&d);
    std::fs::write(d.path().join("base.txt"), "edited\n").unwrap();

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(
        change_pairs(&status),
        vec![(abs(&d, "base.txt"), GitChangeStatus::Modified)]
    );
}

/// 4b. The same edit STAGED → still `modified` (staged and unstaged are
///     unioned; the IDE view is "differs from HEAD", not the index split).
#[test]
fn a_staged_edit_of_a_committed_file_is_modified() {
    let d = TempDir::new("mod-staged");
    let repo = repo_with_commit(&d);
    std::fs::write(d.path().join("base.txt"), "edited\n").unwrap();
    stage(&repo, "base.txt");

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(
        change_pairs(&status),
        vec![(abs(&d, "base.txt"), GitChangeStatus::Modified)]
    );
}

/// 5. A committed file removed from disk → `deleted`.
#[test]
fn a_removed_committed_file_is_deleted() {
    let d = TempDir::new("deleted");
    let _repo = repo_with_commit(&d);
    std::fs::remove_file(d.path().join("base.txt")).unwrap();

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(
        change_pairs(&status),
        vec![(abs(&d, "base.txt"), GitChangeStatus::Deleted)]
    );
}

/// 6. Staged-modified AND deleted from the worktree → `deleted` (the worktree
///    wins: the file is gone from disk, whatever the index says).
#[test]
fn a_staged_edit_then_worktree_delete_is_deleted() {
    let d = TempDir::new("stage-then-delete");
    let repo = repo_with_commit(&d);
    std::fs::write(d.path().join("base.txt"), "edited\n").unwrap();
    stage(&repo, "base.txt");
    std::fs::remove_file(d.path().join("base.txt")).unwrap();

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(
        change_pairs(&status),
        vec![(abs(&d, "base.txt"), GitChangeStatus::Deleted)]
    );
}

// ── exclusions ────────────────────────────────────────────────────────────

/// 7. An ignored file is absent from the changes entirely.
#[test]
fn an_ignored_file_is_not_a_change() {
    let d = TempDir::new("ignored");
    let repo = repo_with_commit(&d);
    commit_file(&repo, ".gitignore", "ignored.txt\n", "add gitignore");
    std::fs::write(d.path().join("ignored.txt"), "invisible\n").unwrap();

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    assert_eq!(
        status.changes,
        vec![],
        "the ignored file must not appear (and the committed .gitignore is clean)"
    );
}

// ── path shape ────────────────────────────────────────────────────────────

/// 8. Every returned path is absolute and under the repo root — including files
///    in subdirectories (untracked dirs are recursed into, not summarized) —
///    and the list is sorted by path.
#[test]
fn paths_are_absolute_under_the_root_and_sorted() {
    let d = TempDir::new("paths");
    let repo = repo_with_commit(&d);
    commit_file(&repo, "sub/inner.txt", "v1\n", "add inner");
    std::fs::write(d.path().join("sub/inner.txt"), "v2\n").unwrap();
    std::fs::create_dir_all(d.path().join("fresh/deep")).unwrap();
    std::fs::write(d.path().join("fresh/deep/leaf.txt"), "leaf\n").unwrap();

    let status = git_status_scoped(d.path(), &d.roots()).unwrap();
    for c in &status.changes {
        let p = Path::new(&c.path);
        assert!(p.is_absolute(), "not absolute: {}", c.path);
        assert!(p.starts_with(d.path()), "not under the root: {}", c.path);
    }
    assert_eq!(
        change_pairs(&status),
        vec![
            (abs(&d, "fresh/deep/leaf.txt"), GitChangeStatus::Untracked),
            (abs(&d, "sub/inner.txt"), GitChangeStatus::Modified),
        ],
        "recursed into the untracked dir; sorted by path"
    );
}

/// 9. Any allowed directory *inside* the repo works (discover walks up), the
///    changes are repo-wide and still absolute, and `root` is the repo workdir
///    (not the requested subdirectory).
#[test]
fn a_subdirectory_root_reports_the_whole_repo() {
    let d = TempDir::new("subdir");
    let repo = repo_with_commit(&d);
    commit_file(&repo, "sub/inner.txt", "v1\n", "add inner");
    std::fs::write(d.path().join("sub/inner.txt"), "v2\n").unwrap();
    std::fs::write(d.path().join("top-level.txt"), "new\n").unwrap();

    let status = git_status_scoped(&d.path().join("sub"), &d.roots()).unwrap();
    assert_eq!(
        PathBuf::from(&status.root),
        d.path(),
        "root = the discovered repo workdir, not the requested subdir"
    );
    assert_eq!(status.branch, "trunk");
    assert_eq!(
        change_pairs(&status),
        vec![
            (abs(&d, "sub/inner.txt"), GitChangeStatus::Modified),
            (abs(&d, "top-level.txt"), GitChangeStatus::Untracked),
        ],
        "repo-wide changes, absolute, even when asked from a subdir"
    );
}

// ── the calm and the guarded errors ───────────────────────────────────────

/// 10. A directory that is in scope but not in any repository → the bare
///     `not-a-repo` (a normal state the UI hides calmly — no detail).
#[test]
fn a_plain_directory_is_not_a_repo() {
    let d = TempDir::new("norepo");
    let err = git_status_scoped(d.path(), &d.roots()).unwrap_err();
    assert_eq!(err, "not-a-repo");
}

/// 11. Out of scope fails FIRST, with an error that must not reveal whether the
///     path is a repository: a real repo and a plain directory outside the
///     roots produce byte-identical errors.
#[test]
fn out_of_scope_reveals_nothing_about_repo_ness() {
    let allowed = TempDir::new("scope-allowed");
    let outside_repo = TempDir::new("scope-repo");
    let outside_plain = TempDir::new("scope-plain");
    let _repo = repo_with_commit(&outside_repo);

    let err_repo = git_status_scoped(outside_repo.path(), &allowed.roots()).unwrap_err();
    let err_plain = git_status_scoped(outside_plain.path(), &allowed.roots()).unwrap_err();

    assert!(
        err_repo.starts_with("out-of-scope"),
        "coded out-of-scope, got {err_repo:?}"
    );
    assert_eq!(
        err_repo, err_plain,
        "identical for repo and non-repo — the error must not leak repo-ness"
    );
    // A nonexistent path is also out-of-scope (the guard cannot resolve it) —
    // the other resolve_in_scope failure mode, mapped to the same code.
    let err_missing =
        git_status_scoped(&allowed.path().join("never-created"), &allowed.roots()).unwrap_err();
    assert!(
        err_missing.starts_with("out-of-scope"),
        "got {err_missing:?}"
    );
}

/// A file path (in scope) is not a repo working directory — calm `not-a-repo`,
/// pinned so the dir requirement never silently becomes a scarier error.
#[test]
fn a_file_root_is_not_a_repo() {
    let d = TempDir::new("file-root");
    let _repo = repo_with_commit(&d);
    let err = git_status_scoped(&d.path().join("base.txt"), &d.roots()).unwrap_err();
    assert_eq!(err, "not-a-repo");
}
