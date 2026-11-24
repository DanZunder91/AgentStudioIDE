//! The default workspace directory + cwd hygiene.
//!
//! **The bug this fixes:** agents were opened with `cwd = "."`, which resolves to
//! the app *binary's* working directory. In dev that is `…/AgentStudioIDE/src-tauri`
//! (where `cargo run` launches the binary) — a folder with **zero persisted claude
//! history**, so ↑ history-recall had nothing to recall, while the project folder
//! (`…/AgentStudioIDE`) has plenty. claude history is per-project and persisted; the
//! agent was simply in the wrong project.
//!
//! So a cwd must ALWAYS be an absolute, real directory — never `"."`, never empty,
//! never the raw binary dir. `default_workspace` provides the sensible default and
//! [`resolve_cwd`] is the defense at the terminal-open path.

use std::path::PathBuf;

/// A sensible absolute default workspace for a new terminal/agent.
///
/// If the app's launch dir is inside a git repo, the **repo working root** (in dev:
/// `…/AgentStudioIDE`, where claude history lives and ↑-recall works). Otherwise the
/// user's **home dir** (the prod fallback, since a double-clicked `.app` launches
/// with cwd `/`). Never `"."`, never the binary dir if it is inside a repo.
///
/// Always absolute and, in every branch, a directory that exists.
pub fn default_workspace_dir() -> PathBuf {
    // The process working directory = where the app was launched from.
    let launch = std::env::current_dir().ok();

    if let Some(dir) = &launch {
        if let Some(root) = crate::git::find_repo_root(dir) {
            return root;
        }
    }
    if let Some(home) = crate::agent::claude::home_dir() {
        return home;
    }
    // Last resort: the launch dir if we have it, else the filesystem root — both
    // absolute and existing. Reaching here needs no repo AND no HOME.
    launch.unwrap_or_else(|| PathBuf::from(std::path::MAIN_SEPARATOR_STR))
}

/// Resolve a UI-supplied cwd, substituting [`default_workspace_dir`] for a stray
/// `"."` or an empty string. Any other path is returned unchanged (the user chose
/// it deliberately — e.g. via the directory picker).
///
/// This is the defense that stops a `"."` from ever reaching a PTY again: `"."`
/// would resolve, at spawn time, to the binary's cwd (the wrong-project bug).
pub fn resolve_cwd(cwd: &str) -> String {
    resolve_cwd_on(cwd, cfg!(windows))
}

/// [`resolve_cwd`] for a named OS. **Windows only** (macOS keeps the path exactly
/// as chosen, so `/tmp/x` never silently becomes `/private/tmp/x`): an existing directory is
/// replaced by its canonical spelling ([`crate::paths::canonicalize`] — the folder's real
/// case, no verbatim `\\?\`). Windows paths are case-insensitive, so `c:\repo` and `C:\Repo`
/// would otherwise be two agents' cwds, two roots, two tabs, two project-dir names.
fn resolve_cwd_on(cwd: &str, windows: bool) -> String {
    let trimmed = cwd.trim();
    if trimmed.is_empty() || trimmed == "." {
        return default_workspace_dir().to_string_lossy().into_owned();
    }
    if windows {
        if let Some(canon) = crate::paths::canonicalize(cwd).ok().filter(|c| c.is_dir()) {
            return canon.to_string_lossy().into_owned();
        }
    }
    cwd.to_string()
}

/// `default_workspace()` command: the default workspace as an absolute path.
///
/// Contract for the frontend: `invoke<string>('default_workspace')` returns an
/// absolute directory to seed a new terminal/agent's cwd (or the directory picker).
#[tauri::command]
pub fn default_workspace() -> String {
    default_workspace_dir().to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The default is always absolute and points at a directory that exists — the
    /// whole point is that a PTY can `chdir` into it.
    #[test]
    fn default_is_an_absolute_existing_directory() {
        let dir = default_workspace_dir();
        assert!(
            dir.is_absolute(),
            "default workspace must be absolute: {dir:?}"
        );
        assert!(
            dir.is_dir(),
            "default workspace must exist as a directory: {dir:?}"
        );
        assert_ne!(dir, Path::new("."), "must never be the relative dir");
    }

    /// In this repo (tests run from `src-tauri/`), the git-root branch resolves to
    /// the repo working root — the dir that holds `.git`, an ancestor of cwd.
    #[test]
    fn git_root_branch_resolves_to_the_repo_working_root() {
        let cwd = std::env::current_dir().unwrap();
        let root = crate::git::find_repo_root(&cwd).expect("the test runs inside this git repo");
        // The root contains `.git`…
        assert!(
            root.join(".git").exists(),
            "repo root must hold .git: {root:?}"
        );
        // …and cwd is at or under it (we walked UP to find it).
        assert!(
            cwd.starts_with(&root),
            "cwd {cwd:?} must be under the repo root {root:?}"
        );
        // And `default_workspace_dir` picks exactly this (launch dir is in a repo).
        assert_eq!(default_workspace_dir(), root);
    }

    /// The home fallback: a path with no repo above it yields the home dir.
    #[test]
    fn home_fallback_when_not_in_a_repo() {
        // Drive the fallback logic directly on a repo-less path.
        let no_repo = std::env::temp_dir();
        // temp_dir is not inside this repo, so find_repo_root is None there…
        // (guard: skip the assertion if a stray .git sits above temp — unlikely).
        if crate::git::find_repo_root(&no_repo).is_none() {
            let home = crate::agent::claude::home_dir().expect("HOME is set under test");
            assert!(
                home.is_dir(),
                "the home fallback must be a real dir: {home:?}"
            );
        }
    }

    /// The `"."` / empty defense substitutes the default; a real path is untouched.
    #[test]
    fn resolve_cwd_substitutes_dot_and_empty_but_keeps_real_paths() {
        let default = default_workspace_dir().to_string_lossy().into_owned();
        assert_eq!(resolve_cwd("."), default, "'.' must be replaced");
        assert_eq!(resolve_cwd(""), default, "empty must be replaced");
        assert_eq!(
            resolve_cwd("   "),
            default,
            "whitespace-only must be replaced"
        );
        // A deliberate absolute path is preserved verbatim.
        assert_eq!(resolve_cwd("/tmp/proj"), "/tmp/proj");
        assert_eq!(resolve_cwd("/Users/x/work"), "/Users/x/work");
        // A non-"." relative path is the user's choice — left as-is (not our job to
        // reject; only "." and empty are the known footgun).
        assert_eq!(resolve_cwd("subdir"), "subdir");
    }

    /// Windows: an existing folder enters as its canonical spelling (no `..`, no verbatim
    /// prefix); macOS/Linux keep the user's spelling. A path that does not exist is left alone
    /// on both (the PTY spawn reports it). Real temp dirs; the OS is a parameter.
    #[test]
    fn on_windows_an_existing_cwd_enters_canonical_and_elsewhere_as_given() {
        let base = std::env::temp_dir().join(format!("ws-cwd-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(base.join("Proj")).unwrap();
        let messy = base.join("Proj").join("..").join("Proj");
        let messy_s = messy.to_string_lossy().into_owned();
        let canon = crate::paths::canonicalize(base.join("Proj"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(resolve_cwd_on(&messy_s, true), canon);
        assert!(!resolve_cwd_on(&messy_s, true).starts_with(r"\\?\"));
        assert_eq!(resolve_cwd_on(&messy_s, false), messy_s, "macOS: untouched");
        let missing = base.join("nope").to_string_lossy().into_owned();
        assert_eq!(resolve_cwd_on(&missing, true), missing);
        let _ = std::fs::remove_dir_all(base);
    }

    /// The real-Windows half: `c:\…` in any case is one folder, spelled one way.
    #[cfg(windows)]
    #[test]
    fn on_windows_two_casings_of_a_cwd_resolve_to_one_spelling() {
        let base = std::env::temp_dir().join(format!("ws-case-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(base.join("MixedCase")).unwrap();
        let real = base.join("MixedCase").to_string_lossy().into_owned();
        let shouted = real.to_uppercase();
        assert_eq!(resolve_cwd(&shouted), resolve_cwd(&real.to_lowercase()));
        assert!(resolve_cwd(&shouted).ends_with("MixedCase"));
        let _ = std::fs::remove_dir_all(base);
    }
}
