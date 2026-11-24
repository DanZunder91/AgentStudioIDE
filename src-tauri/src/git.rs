//! Git branch resolution for `AgentNode.branch` (ARCHITECTURE §2.2 — the left
//! rail renders `branch • cwd`).
//!
//! **Reads `.git` directly rather than shelling out to `git`.** A subprocess per
//! agent spawn would be slow on the control path, and — more importantly — a
//! GUI-launched app has a minimal `PATH` (see `agent::claude::resolve_binary`), so
//! `git` may not even be findable. The file format here is stable and trivial.
//!
//! **A directory that is not a repo is a normal case, never an error**: agents run
//! wherever the user points them. Every failure path returns an empty string.

use std::path::{Path, PathBuf};

/// The branch checked out at `cwd`, or `""` when there isn't one.
///
/// Returns `""` — not an error — for: a non-repo directory, an unreadable `.git`,
/// a repo with no commits yet, or anything malformed. `branch` is a required
/// `string` on the wire (`types.ts`), and the UI simply renders nothing for empty.
///
/// Detached HEAD yields the short SHA, which is what a user would recognise from
/// their prompt.
pub fn current_branch(cwd: &Path) -> String {
    match find_git_dir(cwd) {
        Some(git_dir) => read_head(&git_dir).unwrap_or_default(),
        None => String::new(),
    }
}

/// The **working root** of the git repo containing `start` — the directory that
/// holds `.git` — or `None` if `start` is not inside a repo.
///
/// Distinct from [`find_git_dir`], which returns the *gitdir* (resolved through
/// worktree indirection). `default_workspace` wants the folder the user thinks of
/// as "the project", so it wants the working root. `.git` is present (as a dir in a
/// normal repo, a file in a worktree/submodule) exactly at the working root, so we
/// return the first ancestor that has one.
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// The git repository root containing `path` — the working root that holds
/// `.git` — or `None` when `path` is not inside a repo. Equivalent to
/// `git rev-parse --show-toplevel`.
///
/// The ad-hoc-detection hook is installed here rather than in
/// the terminal's cwd: `claude` walks **up** from the session's cwd to find
/// `.claude/`, so a single hook at the repo root covers every subdirectory the
/// user might `cd` into before typing `claude`. A per-cwd install missed exactly
/// that — the user changing directory into another folder of the same (or a
/// different) repo.
///
/// **Reads `.git` directly** (via [`find_repo_root`]), never shelling out to
/// `git`: a GUI-launched app has a minimal `PATH` and may not find `git` at all
/// (see the module header and `agent::claude::resolve_binary`), and a subprocess on
/// the control path is the cost this module exists to avoid. `.git` is present (a
/// dir in a normal repo, a file in a worktree/submodule) exactly at the working
/// root, which is precisely what `--show-toplevel` reports.
pub fn git_root(path: &Path) -> Option<PathBuf> {
    find_repo_root(path)
}

/// Walk up from `cwd` looking for `.git`, resolving the worktree/submodule
/// indirection.
///
/// Walking up matters: an agent is very often started in a subdirectory of the
/// repo, and only the root holds `.git`.
fn find_git_dir(cwd: &Path) -> Option<PathBuf> {
    let mut dir = Some(cwd);
    while let Some(d) = dir {
        let dot_git = d.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        if dot_git.is_file() {
            // A linked worktree or submodule: `.git` is a file containing
            // `gitdir: /abs/path/to/real/gitdir`. Without following it, every
            // agent in a worktree would report no branch — and worktree-per-agent
            // is the isolation model prior-art says we will adopt (ARCHITECTURE §9).
            let contents = std::fs::read_to_string(&dot_git).ok()?;
            let path = contents.strip_prefix("gitdir:")?.trim();
            let resolved = PathBuf::from(path);
            return Some(if resolved.is_absolute() {
                resolved
            } else {
                d.join(resolved)
            });
        }
        dir = d.parent();
    }
    None
}

/// `.git/HEAD` is either `ref: refs/heads/<branch>` or a raw detached SHA.
fn read_head(git_dir: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();

    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        // `refs/heads/feature/foo` -> `feature/foo`: strip only the known prefix,
        // never split on '/', or branch names containing slashes would be truncated.
        return Some(
            reference
                .strip_prefix("refs/heads/")
                .unwrap_or(reference)
                .to_string(),
        );
    }

    // Detached HEAD: a bare 40-char SHA. Show it the way git does.
    if head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(head[..7].to_string());
    }

    None
}
