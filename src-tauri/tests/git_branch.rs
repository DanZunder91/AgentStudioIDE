//! `git::current_branch` — resolves `AgentNode.branch` (ARCHITECTURE §2.2).
//!
//! Built against **real `.git` layouts on disk**, not string fixtures: the whole
//! risk here is the file format and the walk, so faking either would test nothing.
//! `git init` is cheap and hermetic (a temp dir, no network), which is why this is
//! worth doing for real where spawning a real `claude` is not.
//!
//! The `#[cfg(unix)]`-free design is deliberate — `.git` is identical on Windows.

use std::path::{Path, PathBuf};
use std::process::Command;

use agent_studio_scaffold_lib::git::{current_branch, git_root};

/// A throwaway directory that cleans itself up.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let p = std::env::temp_dir().join(format!("agentstudio-git-{label}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&p).expect("mkdir");
        // Resolve symlinks: on macOS /tmp is /private/tmp, and a non-canonical
        // path would make the `.git` walk compare apples to oranges.
        Self(plain(p.canonicalize().unwrap_or(p)))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

/// `p` without the `\\?\` verbatim prefix Windows' `canonicalize` puts on a drive path.
/// Git cannot take that spelling: handed `\\?\C:\…\wt-linked`, `git worktree add` fails
/// with "could not create leading directories of '//?/C:/…'". A no-op on every other OS,
/// and for a UNC path (`\\?\UNC\…`).
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => p,
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git must be installed to run these tests");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repo with one commit on `branch`.
fn init_repo(dir: &Path, branch: &str) {
    git(dir, &["init", "-q", "--initial-branch", branch]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("f.txt"), "hello").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "init"]);
}

#[test]
fn reports_the_checked_out_branch() {
    let d = TempDir::new("basic");
    init_repo(d.path(), "trunk");
    assert_eq!(current_branch(d.path()), "trunk");
}

/// **A non-git directory is a normal case, never an error** — agents run wherever
/// the user points them, and most directories are not repos.
#[test]
fn a_non_git_directory_yields_an_empty_branch() {
    let d = TempDir::new("plain");
    assert_eq!(
        current_branch(d.path()),
        "",
        "a non-repo must not error or invent a branch"
    );
}

/// Nor may a nonexistent path panic: the cwd could be deleted between the UI
/// choosing it and the agent spawning.
#[test]
fn a_missing_directory_yields_an_empty_branch() {
    assert_eq!(current_branch(Path::new("/definitely/not/here/at/all")), "");
}

/// Agents are very often started in a subdirectory; only the repo root holds
/// `.git`, so the walk upward is what makes `branch` appear at all.
#[test]
fn finds_the_branch_from_a_nested_subdirectory() {
    let d = TempDir::new("nested");
    init_repo(d.path(), "main");
    let deep = d.path().join("a/b/c");
    std::fs::create_dir_all(&deep).unwrap();
    assert_eq!(current_branch(&deep), "main");
}

/// Branch names contain slashes constantly (`feature/x`). Splitting on `/` instead
/// of stripping the known prefix would truncate them to `x`.
#[test]
fn branch_names_containing_slashes_survive_intact() {
    let d = TempDir::new("slashes");
    init_repo(d.path(), "main");
    for name in ["feature/login", "release/v1.2", "sam/fix/deep/nesting"] {
        git(d.path(), &["checkout", "-q", "-b", name]);
        assert_eq!(current_branch(d.path()), name, "branch name was mangled");
    }
}

/// Detached HEAD shows the short SHA — what the user sees in their own prompt.
#[test]
fn detached_head_reports_the_short_sha() {
    let d = TempDir::new("detached");
    init_repo(d.path(), "main");
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(d.path())
        .output()
        .unwrap();
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();

    git(d.path(), &["checkout", "-q", "--detach", &sha]);

    let branch = current_branch(d.path());
    assert_eq!(
        branch,
        sha[..7],
        "detached HEAD should read as the short sha"
    );
}

/// **Worktrees matter**: `.git` is a *file* pointing elsewhere, and worktree-per-agent
/// is the isolation model prior-art says we will adopt (ARCHITECTURE §9). Without
/// following the `gitdir:` indirection, every agent in a worktree reports no branch.
#[test]
fn resolves_the_branch_inside_a_linked_worktree() {
    let d = TempDir::new("wt-main");
    init_repo(d.path(), "main");

    let wt = d.path().join("../wt-linked");
    let _ = std::fs::remove_dir_all(&wt);
    git(
        d.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "wt-branch",
            wt.to_str().unwrap(),
        ],
    );

    let branch = current_branch(&wt);
    // Clean up the worktree registration before asserting, so a failure doesn't
    // leave the repo wedged.
    let _ = Command::new("git")
        .args(["worktree", "remove", "--force", wt.to_str().unwrap()])
        .current_dir(d.path())
        .output();

    assert_eq!(
        branch, "wt-branch",
        "`.git`-as-a-file (worktree) was not followed"
    );
}

/// A repo with no commits still has a HEAD pointing at the unborn branch. Reporting
/// it is right — a freshly `git init`ed project is a normal place to start an agent.
#[test]
fn a_repo_with_no_commits_still_reports_its_branch() {
    let d = TempDir::new("unborn");
    git(d.path(), &["init", "-q", "--initial-branch", "main"]);
    assert_eq!(current_branch(d.path()), "main");
}

// ── git_root: where the ad-hoc-detection hook is installed ───────────────────
//
// The hook must land at the repo root, because `claude` walks UP from the
// session's cwd to find `.claude/`. `git_root` is what resolves that root.

/// The repo root is returned from the root itself AND from any nested subdir —
/// the whole point, since a hook there covers every directory the user `cd`s into.
#[test]
fn git_root_returns_the_toplevel_from_the_root_and_from_a_subdir() {
    let d = TempDir::new("gitroot");
    init_repo(d.path(), "main");

    assert_eq!(
        git_root(d.path()).as_deref(),
        Some(d.path()),
        "the repo root resolves to itself"
    );

    let deep = d.path().join("a/b/c");
    std::fs::create_dir_all(&deep).unwrap();
    assert_eq!(
        git_root(&deep).as_deref(),
        Some(d.path()),
        "a nested subdir must resolve UP to the repo root"
    );
}

/// A directory outside any repo has no git root — the caller then falls back to
/// installing the hook in the cwd itself.
#[test]
fn git_root_is_none_outside_a_repo() {
    let d = TempDir::new("gitroot-plain");
    assert_eq!(
        git_root(d.path()),
        None,
        "a non-repo directory must have no git root"
    );
}

/// Garbage in `.git/HEAD` must yield "", not a panic and not nonsense on the wire.
#[test]
fn a_malformed_head_yields_an_empty_branch() {
    let d = TempDir::new("malformed");
    std::fs::create_dir_all(d.path().join(".git")).unwrap();
    for junk in ["", "not a ref at all", "ref:", "\0\0\0"] {
        std::fs::write(d.path().join(".git/HEAD"), junk).unwrap();
        assert_eq!(
            current_branch(d.path()),
            "",
            "junk HEAD {junk:?} produced a branch"
        );
    }
}
