//! Build script: stamps the commit for the window title (`src/build_info.rs`); the version alone
//! is the same on every installer.

use std::path::Path;
use std::process::Command;

fn main() {
    stamp_commit();
    tauri_build::build()
}

/// HEAD's short SHA into `AGENTSTUDIO_COMMIT`, or empty without git history: the title then omits
/// it rather than rendering an unknown commit in the same shape as a known one.
fn stamp_commit() {
    let sha = git(&["rev-parse", "--short=8", "HEAD"]).unwrap_or_default();
    println!("cargo:rustc-env=AGENTSTUDIO_COMMIT={sha}");

    // Rerun on HEAD and logs/HEAD (the reflog moves on every HEAD change, even with packed-refs):
    // the default misses frontend-only commits, and a stale SHA is worse than none.
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        for name in ["HEAD", "logs/HEAD"] {
            let path = Path::new(&git_dir).join(name);
            // Only watch what exists: cargo treats a missing watched path as
            // "changed", which would rerun this script — and relink the crate —
            // on every single build.
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

/// Run a git command in the crate directory, or `None` if git is missing or the
/// command fails. Never panics: building must not require git to be installed.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
