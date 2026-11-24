//! `git_file::file_diff_scoped` / `file_restore_scoped` — Git ▸ Compare and
//! Git ▸ Revert for one file.
//!
//! Built against **real repositories constructed with `git2` itself** (init,
//! explicit signatures, commits) — never by shelling out to `git` (tests stay hermetic;
//! the zero-install principle applies to tests too, and the one shelling test in
//! this repo, `git_branch`, is a known flake we do not multiply).
//!
//! Hermetic in two further ways that matter here: every commit is made with an
//! explicit `Signature`, so nothing depends on the developer's global
//! `user.name`/`user.email`; and every fixture repo pins `core.autocrlf` and
//! `core.safecrlf` **off** in its own config, so a developer with CRLF filters set
//! globally cannot rewrite the bytes these tests commit, compare and restore.
//!
//! The scope guard is exercised through the same explicit-roots pattern as
//! `git_blame`'s and `git_status`'s tests: `*_scoped(path, roots)` with a
//! canonicalized temp root and no `AppHandle`.
//!
//! **Revert here is `git restore`, not `git revert`** — see the module header of
//! `src/git_file.rs`. These tests assert `git checkout HEAD -- <path>` semantics
//! for one file: worktree and index both back at HEAD, no commit created.

use std::path::{Path, PathBuf};

use agent_studio_scaffold_lib::git_file::{file_diff_scoped, file_restore_scoped};

/// A throwaway directory that cleans itself up.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let p =
            std::env::temp_dir().join(format!("agentstudio-gitfile-{label}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&p).expect("mkdir");
        // Resolve symlinks (macOS /tmp → /private/tmp) so the root we authorize is
        // the same canonical path `resolve_in_scope` compares against.
        Self(agent_studio_scaffold_lib::paths::canonicalize(&p).unwrap_or(p))
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn roots(&self) -> Vec<PathBuf> {
        vec![self.0.clone()]
    }
    fn join(&self, rel: &str) -> PathBuf {
        let mut p = self.0.clone();
        for comp in rel.split('/') {
            p.push(comp);
        }
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A fixed author/committer — never the machine's `user.name`/`user.email`.
fn sig() -> git2::Signature<'static> {
    git2::Signature::new(
        "Diff Tester",
        "diff@example.com",
        &git2::Time::new(1_700_000_000, 0),
    )
    .unwrap()
}

/// An empty repo at `path` with the line-ending filters pinned OFF, so a developer
/// with `core.autocrlf = true` globally cannot rewrite the bytes under test.
fn init_repo_at(path: &Path) -> git2::Repository {
    let repo = git2::Repository::init(path).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_bool("core.autocrlf", false).unwrap();
    cfg.set_bool("core.safecrlf", false).unwrap();
    drop(cfg);
    repo
}

fn init_repo(d: &TempDir) -> git2::Repository {
    init_repo_at(d.path())
}

/// Write `content` to `rel`, stage it, and commit it.
fn commit_bytes(repo: &git2::Repository, rel: &str, content: &[u8]) {
    let workdir = repo
        .workdir()
        .expect("test repos have a workdir")
        .to_path_buf();
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

    let s = sig();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &s, &s, "commit", &tree, &parents)
        .unwrap();
}

fn commit_file(repo: &git2::Repository, rel: &str, content: &str) {
    commit_bytes(repo, rel, content.as_bytes());
}

/// Overwrite a file in the working tree without staging or committing.
fn write_worktree(d: &TempDir, rel: &str, content: &str) {
    let abs = d.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(abs, content).unwrap();
}

fn read_worktree(d: &TempDir, rel: &str) -> String {
    std::fs::read_to_string(d.join(rel)).unwrap()
}

/// Stage `rel` (already on disk) without committing.
fn stage(repo: &git2::Repository, rel: &str) {
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(rel)).unwrap();
    index.write().unwrap();
}

// ── Compare: the ordinary states ──────────────────────────────────────────────

/// 1. A committed, untouched file: both sides equal, `unchanged`.
#[test]
fn a_clean_file_reports_unchanged_with_both_sides_equal() {
    let d = TempDir::new("clean");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "hello\n");

    let diff = file_diff_scoped(&d.join("a.txt"), &d.roots()).unwrap();
    assert!(diff.unchanged, "a committed, untouched file has no changes");
    assert!(!diff.binary);
    assert_eq!(diff.head.as_deref(), Some("hello\n"));
    assert_eq!(diff.working.as_deref(), Some("hello\n"));
    assert_eq!(diff.relative, "a.txt");
    assert_eq!(PathBuf::from(&diff.path), d.join("a.txt"));
}

/// 2. A modified file: HEAD keeps the old text, the working side is what is on disk.
#[test]
fn a_modified_file_shows_the_head_side_and_the_disk_side() {
    let d = TempDir::new("modified");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "old\n");
    write_worktree(&d, "a.txt", "new\n");

    let diff = file_diff_scoped(&d.join("a.txt"), &d.roots()).unwrap();
    assert!(!diff.unchanged);
    assert_eq!(
        diff.head.as_deref(),
        Some("old\n"),
        "HEAD keeps the old text"
    );
    assert_eq!(
        diff.working.as_deref(),
        Some("new\n"),
        "the working side is what is on DISK"
    );
}

/// 3. Staging is not a third opinion: the two sides are still HEAD and disk.
#[test]
fn a_staged_but_uncommitted_edit_still_compares_against_head() {
    let d = TempDir::new("staged");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "old\n");
    write_worktree(&d, "a.txt", "new\n");
    stage(&repo, "a.txt");

    let diff = file_diff_scoped(&d.join("a.txt"), &d.roots()).unwrap();
    assert_eq!(diff.head.as_deref(), Some("old\n"));
    assert_eq!(diff.working.as_deref(), Some("new\n"));
    assert!(!diff.unchanged);
}

/// 4. `relative` is git's spelling: `/`-separated, relative to the repo root — and
///    the repo is discovered by walking up from a nested file.
#[test]
fn a_nested_file_reports_a_slash_separated_relative_path() {
    let d = TempDir::new("nested");
    let repo = init_repo(&d);
    commit_file(&repo, "src/deep/a.txt", "x\n");

    let diff = file_diff_scoped(&d.join("src/deep/a.txt"), &d.roots()).unwrap();
    assert_eq!(diff.relative, "src/deep/a.txt");
}

// ── Compare: the states that have no HEAD side ────────────────────────────────

/// 5. Untracked: nothing at HEAD to compare against.
#[test]
fn an_untracked_file_has_no_head_side() {
    let d = TempDir::new("untracked");
    let repo = init_repo(&d);
    commit_file(&repo, "base.txt", "base\n");
    write_worktree(&d, "fresh.txt", "brand new\n");

    let diff = file_diff_scoped(&d.join("fresh.txt"), &d.roots()).unwrap();
    assert_eq!(diff.head, None, "nothing at HEAD to compare against");
    assert_eq!(diff.working.as_deref(), Some("brand new\n"));
    assert!(!diff.unchanged);
    assert!(!diff.binary);
}

/// 6. Staged but never committed — still no HEAD side (the index is not HEAD).
#[test]
fn a_newly_added_but_uncommitted_file_has_no_head_side() {
    let d = TempDir::new("added");
    let repo = init_repo(&d);
    commit_file(&repo, "base.txt", "base\n");
    write_worktree(&d, "fresh.txt", "brand new\n");
    stage(&repo, "fresh.txt");

    let diff = file_diff_scoped(&d.join("fresh.txt"), &d.roots()).unwrap();
    assert_eq!(diff.head, None);
    assert_eq!(diff.working.as_deref(), Some("brand new\n"));
}

/// 7. **Unborn HEAD.** A repo with no commits: libgit2 reports `repo.head()` as an
///    ERROR (`UnbornBranch`), and treating that as a failure would break Compare on
///    every brand-new project.
#[test]
fn an_unborn_head_is_a_normal_state_not_an_error() {
    let d = TempDir::new("unborn");
    let _repo = init_repo(&d);
    write_worktree(&d, "a.txt", "first\n");

    let diff = file_diff_scoped(&d.join("a.txt"), &d.roots()).unwrap();
    assert_eq!(diff.head, None);
    assert_eq!(diff.working.as_deref(), Some("first\n"));
    assert!(!diff.unchanged);
}

/// 8. Deleted on disk: no working side, but HEAD still has something to show — and
///    the scope guard had to resolve a path that no longer exists to get here.
#[test]
fn a_file_deleted_on_disk_keeps_its_head_side() {
    let d = TempDir::new("deleted");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "gone soon\n");
    std::fs::remove_file(d.join("a.txt")).unwrap();

    let diff = file_diff_scoped(&d.join("a.txt"), &d.roots()).unwrap();
    assert_eq!(diff.head.as_deref(), Some("gone soon\n"));
    assert_eq!(diff.working, None, "nothing on disk");
    assert!(!diff.unchanged);
    assert_eq!(diff.relative, "a.txt");
}

/// 9. Neither on disk nor in HEAD: saying "unchanged" about a path that does not
///    exist would be a lie.
#[test]
fn a_path_in_neither_head_nor_the_worktree_is_reported_missing() {
    let d = TempDir::new("missing");
    let repo = init_repo(&d);
    commit_file(&repo, "base.txt", "base\n");

    let err = file_diff_scoped(&d.join("nope.txt"), &d.roots()).unwrap_err();
    assert_eq!(err, "file does not exist");
}

// ── Compare: binary ───────────────────────────────────────────────────────────

/// 10. Binary at HEAD → both sides withheld. Never a lossy conversion, and never
///     half a diff.
#[test]
fn a_binary_head_side_refuses_to_produce_text() {
    let d = TempDir::new("binhead");
    let repo = init_repo(&d);
    commit_bytes(&repo, "a.bin", &[0xff, 0xfe, 0x00, 0x01]);
    write_worktree(&d, "a.bin", "now it is text\n");

    let diff = file_diff_scoped(&d.join("a.bin"), &d.roots()).unwrap();
    assert!(diff.binary, "HEAD's bytes are not valid UTF-8");
    assert_eq!(diff.head, None, "never a lossy conversion");
    assert_eq!(diff.working, None, "and never half a diff either");
    assert!(!diff.unchanged);
}

/// 11. Binary in the working tree → the same refusal from the other side.
#[test]
fn a_binary_working_side_refuses_to_produce_text() {
    let d = TempDir::new("binwork");
    let repo = init_repo(&d);
    commit_file(&repo, "a.bin", "was text\n");
    std::fs::write(d.join("a.bin"), [0x00, 0x9f, 0x92, 0x96]).unwrap();

    let diff = file_diff_scoped(&d.join("a.bin"), &d.roots()).unwrap();
    assert!(diff.binary);
    assert_eq!(diff.head, None);
    assert_eq!(diff.working, None);
}

/// 12. `unchanged` is decided on BYTES, before decodability — so an untouched
///     binary file reads "no changes", not "binary file that differs".
#[test]
fn an_identical_binary_file_is_unchanged_and_still_binary() {
    let d = TempDir::new("binsame");
    let repo = init_repo(&d);
    commit_bytes(&repo, "a.bin", &[0xff, 0x00, 0x10]);

    let diff = file_diff_scoped(&d.join("a.bin"), &d.roots()).unwrap();
    assert!(diff.unchanged);
    assert!(diff.binary);
    assert_eq!(diff.head, None);
    assert_eq!(diff.working, None);
}

// ── Compare: the refusals ─────────────────────────────────────────────────────

/// 13. Not in a repository — a normal state the UI shows inline, said calmly.
#[test]
fn a_file_outside_any_repository_says_so_calmly() {
    let d = TempDir::new("norepo");
    std::fs::write(d.join("a.txt"), "loose\n").unwrap();

    let err = file_diff_scoped(&d.join("a.txt"), &d.roots()).unwrap_err();
    assert_eq!(err, "not in a git repository");
}

/// 14. A directory is not a file to compare.
#[test]
fn a_directory_is_not_a_file_to_compare() {
    let d = TempDir::new("dirdiff");
    let repo = init_repo(&d);
    commit_file(&repo, "src/a.txt", "x\n");

    let err = file_diff_scoped(&d.join("src"), &d.roots()).unwrap_err();
    assert_eq!(err, "path is not a file");
}

/// 15. Out of scope → rejected **before** any git access. The repo is real and the
///     file is really modified; the only thing wrong is the path, so the error must
///     be the scope rejection — a git error here would prove git ran first.
#[test]
fn an_out_of_scope_path_is_rejected_before_any_git_access() {
    let repo_dir = TempDir::new("oos-repo");
    let allowed = TempDir::new("oos-allowed");
    let repo = init_repo(&repo_dir);
    commit_file(&repo, "a.txt", "committed\n");
    write_worktree(&repo_dir, "a.txt", "modified\n");

    let err = file_diff_scoped(&repo_dir.join("a.txt"), &allowed.roots()).unwrap_err();
    assert_eq!(err, "path is outside the allowed workspace roots");
}

/// 16. The deleted-file fallback resolves the PARENT through the same guard, so a
///     nonexistent path cannot be used to slip past the scope check.
#[test]
fn an_out_of_scope_path_that_does_not_exist_is_still_rejected() {
    let repo_dir = TempDir::new("oos-missing-repo");
    let allowed = TempDir::new("oos-missing-allowed");
    let repo = init_repo(&repo_dir);
    commit_file(&repo, "a.txt", "committed\n");
    std::fs::remove_file(repo_dir.join("a.txt")).unwrap();

    let err = file_diff_scoped(&repo_dir.join("a.txt"), &allowed.roots()).unwrap_err();
    assert_eq!(err, "path is outside the allowed workspace roots");
}

/// 17. `..` is canonicalized away and then rejected — the escape is not spelled out
///     of existence, it is resolved and refused.
#[test]
fn a_dot_dot_escape_is_resolved_and_rejected() {
    let outer = TempDir::new("escape-outer");
    let inner = outer.join("inside");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::write(outer.path().join("secret.txt"), "top secret\n").unwrap();

    let roots = vec![inner.clone()];
    let err = file_diff_scoped(&inner.join("..").join("secret.txt"), &roots).unwrap_err();
    assert_eq!(err, "path is outside the allowed workspace roots");
}

/// 17b. A **symlink that escapes the allowed root** is rejected, never followed.
///
/// This is the case that makes the "does it exist?" branch of the resolver
/// load-bearing. The resolver tolerates a path that is gone from disk
/// by falling back to resolving the *parent* — and a symlink is exactly the input
/// that could abuse that: its parent (the repo) is perfectly in scope, so a fallback
/// taken for the wrong reason would hand back `repo/link.txt` and then read straight
/// through the link to a file outside the workspace. The fixture is built so a
/// regression **returns the secret** rather than merely returning a different error.
#[cfg(unix)]
#[test]
fn a_symlink_escaping_the_allowed_root_is_rejected_not_followed() {
    let outer = TempDir::new("symlink-read");
    std::fs::write(outer.path().join("secret.txt"), "top secret\n").unwrap();
    let repo_dir = outer.join("repo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    let repo = init_repo_at(&repo_dir);
    commit_bytes(&repo, "base.txt", b"base\n");
    std::os::unix::fs::symlink(outer.path().join("secret.txt"), repo_dir.join("link.txt")).unwrap();

    // Only the repo is allowed — the outer directory holding `secret.txt` is not.
    let roots = vec![repo_dir.clone()];
    let err = file_diff_scoped(&repo_dir.join("link.txt"), &roots).unwrap_err();
    assert_eq!(err, "path is outside the allowed workspace roots");
}

/// 17c. The same escape, on the **destructive** command.
#[cfg(unix)]
#[test]
fn restore_refuses_a_symlink_escaping_the_allowed_root() {
    let outer = TempDir::new("symlink-write");
    std::fs::write(outer.path().join("secret.txt"), "top secret\n").unwrap();
    let repo_dir = outer.join("repo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    let repo = init_repo_at(&repo_dir);
    commit_bytes(&repo, "base.txt", b"base\n");
    std::os::unix::fs::symlink(outer.path().join("secret.txt"), repo_dir.join("link.txt")).unwrap();

    let roots = vec![repo_dir.clone()];
    let err = file_restore_scoped(&repo_dir.join("link.txt"), &roots).unwrap_err();
    assert_eq!(
        err, "path is outside the allowed workspace roots",
        "the scope rejection, NOT some later git refusal that happens to also stop it"
    );
    assert_eq!(
        std::fs::read_to_string(outer.path().join("secret.txt")).unwrap(),
        "top secret\n"
    );
}

// ── Revert: the happy paths ───────────────────────────────────────────────────

/// 18. The committed content comes back.
#[test]
fn restore_puts_back_the_committed_content() {
    let d = TempDir::new("restore");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "committed\n");
    write_worktree(&d, "a.txt", "scribbled over\n");
    assert_eq!(
        read_worktree(&d, "a.txt"),
        "scribbled over\n",
        "precondition"
    );

    file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap();
    assert_eq!(read_worktree(&d, "a.txt"), "committed\n");
}

/// 19. 🔴 **The two-sided assertion.** `checkout_head().force()`
///     WITHOUT the `.path(rel)` restriction resets the entire working tree, and a
///     test that only checked file A would pass while the whole repo was blown
///     away. File B is the half that fails.
#[test]
fn restore_touches_only_the_named_path() {
    let d = TempDir::new("restore-scope");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "committed A\n");
    commit_file(&repo, "b.txt", "committed B\n");
    write_worktree(&d, "a.txt", "modified A\n");
    write_worktree(&d, "b.txt", "modified B\n");

    file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap();

    assert_eq!(
        read_worktree(&d, "a.txt"),
        "committed A\n",
        "A was reverted"
    );
    assert_eq!(
        read_worktree(&d, "b.txt"),
        "modified B\n",
        "B's uncommitted work MUST survive — this is the whole safety property"
    );
}

/// 20. The other way a too-wide checkout shows up: deleting a file the user never
///     committed.
#[test]
fn restore_leaves_an_untracked_neighbour_alone() {
    let d = TempDir::new("restore-untracked-neighbour");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "committed A\n");
    write_worktree(&d, "a.txt", "modified A\n");
    write_worktree(&d, "scratch.txt", "never committed\n");

    file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap();

    assert_eq!(read_worktree(&d, "a.txt"), "committed A\n");
    assert_eq!(
        read_worktree(&d, "scratch.txt"),
        "never committed\n",
        "an untracked neighbour is not ours to delete"
    );
}

/// 21. `git checkout HEAD -- <path>` semantics: the index entry goes back too, so
///     the file is fully clean afterwards — not merely "unstaged".
#[test]
fn restore_discards_a_staged_change_too() {
    let d = TempDir::new("restore-staged");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "committed\n");
    write_worktree(&d, "a.txt", "staged edit\n");
    stage(&repo, "a.txt");

    file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap();

    assert_eq!(read_worktree(&d, "a.txt"), "committed\n");
    assert_eq!(
        repo.status_file(Path::new("a.txt")).unwrap(),
        git2::Status::CURRENT,
        "index and worktree both back at HEAD"
    );
}

/// 22. Reverting a deletion brings the file back — the destructive path also has to
///     resolve a name that is not on disk.
#[test]
fn restore_brings_back_a_file_deleted_on_disk() {
    let d = TempDir::new("restore-deleted");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "come back\n");
    std::fs::remove_file(d.join("a.txt")).unwrap();
    assert!(!d.join("a.txt").exists(), "precondition");

    file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap();
    assert_eq!(read_worktree(&d, "a.txt"), "come back\n");
}

/// 23. Revert creates no commit — the naming trap in reverse. If someone ever
///     "fixes" this into `git revert`, HEAD would move.
#[test]
fn restore_creates_no_commit_and_leaves_head_where_it_was() {
    let d = TempDir::new("restore-nocommit");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "committed\n");
    let head_before = repo.head().unwrap().peel_to_commit().unwrap().id();
    write_worktree(&d, "a.txt", "modified\n");

    file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap();

    let head_after = repo.head().unwrap().peel_to_commit().unwrap().id();
    assert_eq!(head_before, head_after, "restore, never `git revert`");
}

// ── Revert: the refusals, each proved to have written nothing ─────────────────

/// 24. Untracked → refused, and the refusal is not a disguised delete.
#[test]
fn restore_refuses_an_untracked_file_and_leaves_it_intact() {
    let d = TempDir::new("restore-untracked");
    let repo = init_repo(&d);
    commit_file(&repo, "base.txt", "base\n");
    write_worktree(&d, "fresh.txt", "never committed\n");

    let err = file_restore_scoped(&d.join("fresh.txt"), &d.roots()).unwrap_err();
    assert_eq!(err, "file is not tracked — there is nothing to revert to");
    assert_eq!(
        read_worktree(&d, "fresh.txt"),
        "never committed\n",
        "refusing must not be a disguised delete"
    );
}

/// 25. Unborn HEAD → the same refusal (there is no HEAD blob for anything).
#[test]
fn restore_refuses_when_head_is_unborn() {
    let d = TempDir::new("restore-unborn");
    let _repo = init_repo(&d);
    write_worktree(&d, "a.txt", "first\n");

    let err = file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap_err();
    assert_eq!(err, "file is not tracked — there is nothing to revert to");
    assert_eq!(read_worktree(&d, "a.txt"), "first\n");
}

/// 26. A directory → refused, and its contents are untouched.
#[test]
fn restore_refuses_a_directory_and_changes_nothing() {
    let d = TempDir::new("restore-dir");
    let repo = init_repo(&d);
    commit_file(&repo, "src/a.txt", "committed\n");
    write_worktree(&d, "src/a.txt", "modified\n");

    let err = file_restore_scoped(&d.join("src"), &d.roots()).unwrap_err();
    assert_eq!(
        err,
        "path is not a file — revert applies to one file at a time"
    );
    assert_eq!(
        read_worktree(&d, "src/a.txt"),
        "modified\n",
        "a refused directory revert must not revert its contents"
    );
}

/// 27. The repository root is a directory like any other — the worst possible
///     target, refused the same way.
#[test]
fn restore_refuses_the_repository_root_itself() {
    let d = TempDir::new("restore-root");
    let repo = init_repo(&d);
    commit_file(&repo, "a.txt", "committed\n");
    write_worktree(&d, "a.txt", "modified\n");

    let err = file_restore_scoped(d.path(), &d.roots()).unwrap_err();
    assert_eq!(
        err,
        "path is not a file — revert applies to one file at a time"
    );
    assert_eq!(read_worktree(&d, "a.txt"), "modified\n");
}

/// 28. Out of scope → refused **with no write**. The repo is real, the file is
///     really modified and really tracked, so the only thing stopping the checkout
///     is `resolve_in_scope` — and the file must still hold the edit.
#[test]
fn restore_refuses_an_out_of_scope_path_without_writing() {
    let repo_dir = TempDir::new("restore-oos-repo");
    let allowed = TempDir::new("restore-oos-allowed");
    let repo = init_repo(&repo_dir);
    commit_file(&repo, "a.txt", "committed\n");
    write_worktree(&repo_dir, "a.txt", "modified\n");

    let err = file_restore_scoped(&repo_dir.join("a.txt"), &allowed.roots()).unwrap_err();
    assert_eq!(err, "path is outside the allowed workspace roots");
    assert_eq!(
        read_worktree(&repo_dir, "a.txt"),
        "modified\n",
        "NO write may happen for an out-of-scope path"
    );
}

/// 29. Not in a repository → calm refusal, file untouched.
#[test]
fn restore_outside_a_repository_says_so_calmly() {
    let d = TempDir::new("restore-norepo");
    std::fs::write(d.join("a.txt"), "loose\n").unwrap();

    let err = file_restore_scoped(&d.join("a.txt"), &d.roots()).unwrap_err();
    assert_eq!(err, "not in a git repository");
    assert_eq!(read_worktree(&d, "a.txt"), "loose\n");
}
