//! Git branch resolution for `AgentNode.branch` (ARCHITECTURE §2.2). Reads `.git` directly, never
//! `git`: a GUI-launched app has a minimal `PATH`. A non-repo directory is normal, never an error:
//! every failure path returns an empty string.

use std::path::{Path, PathBuf};

/// The branch checked out at `cwd`, or `""` for no repo, unreadable/malformed `.git` or no
/// commits (`branch` is a required string on the wire). Detached HEAD yields the short SHA.
pub fn current_branch(cwd: &Path) -> String {
    match find_git_dir(cwd) {
        Some(git_dir) => read_head(&git_dir).unwrap_or_default(),
        None => String::new(),
    }
}

/// The working root (the dir holding `.git`) of the repo containing `start`, or `None`. Unlike
/// [`find_git_dir`], which returns the gitdir resolved through worktree indirection.
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

/// The repo working root containing `path` (like `git rev-parse --show-toplevel`), or `None`.
/// The ad-hoc-detection hook is installed here, not in the cwd: `claude` walks up to find
/// `.claude/`, so one hook at the root covers every subdirectory.
pub fn git_root(path: &Path) -> Option<PathBuf> {
    find_repo_root(path)
}

/// Walk up from `cwd` (agents often start in a subdirectory) looking for `.git`, resolving the
/// worktree/submodule indirection.
fn find_git_dir(cwd: &Path) -> Option<PathBuf> {
    let mut dir = Some(cwd);
    while let Some(d) = dir {
        let dot_git = d.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        if dot_git.is_file() {
            // Worktree or submodule: `.git` is a file `gitdir: /abs/path`. Unfollowed,
            // every agent in a worktree reports no branch (ARCHITECTURE §9).
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
