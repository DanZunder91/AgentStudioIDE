//! Build script.
//!
//! Beyond `tauri_build::build()`, this stamps the binary with the commit it was
//! compiled from, for the window title (see `src/build_info.rs`).
//!
//! Why the commit and not just the version: `0.1.0` has been the version of every
//! installer ever built, so a bare version answers *"which build
//! is this?"* with the same string every time. The short SHA is the part that
//! actually tells two otherwise-identical DMGs apart.

use std::path::Path;
use std::process::Command;

fn main() {
    stamp_commit();
    tauri_build::build()
}

/// Capture `HEAD`'s short SHA into `AGENTSTUDIO_COMMIT`, or an empty string when
/// git is unavailable (a source tarball, a checkout without history).
///
/// Empty rather than a placeholder like `unknown`: the title then omits the SHA
/// entirely, because not knowing which commit this is must never be rendered in
/// the same shape as knowing.
fn stamp_commit() {
    let sha = git(&["rev-parse", "--short=8", "HEAD"]).unwrap_or_default();
    println!("cargo:rustc-env=AGENTSTUDIO_COMMIT={sha}");

    // Without a rerun trigger, cargo caches this script's output and the SHA goes
    // stale — the binary would name a commit it was not built from, which is
    // worse than naming none. Note the default (rerun when any file in the
    // package changes) is NOT enough on its own: a frontend- or docs-only commit
    // touches nothing in `src-tauri/`, and those are most of the commits here.
    //
    // `logs/HEAD` is the reflog. Git appends to it on every commit, checkout,
    // reset and merge, so it moves whenever HEAD does — including when the branch
    // ref lives in `packed-refs` and has no file of its own to watch.
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
