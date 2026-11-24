//! Which build is this? — the identity shown next to the app name in the window
//! title.
//!
//! The point is telling two installers apart, and the version alone cannot: it stays
//! `0.1.0` across many builds, so on its own it would answer the question with the
//! same string every time. The commit is what discriminates, so the title carries
//! both:
//!
//! ```text
//! Agent Studio 0.1.0 (5312aa6b)
//! ```
//!
//! ## The version is not written down here
//!
//! It comes from `package_info()`, which `generate_context!` fills from
//! `tauri.conf.json`'s `version` field (tauri-codegen `context.rs:273` — the
//! Cargo version is only its fallback). That is the same value that ends up in
//! the bundle's `Info.plist`, so the title cannot claim a version the installer
//! does not have. Three files declare a version in this repo; `versions_agree`
//! below keeps them from drifting apart.

/// The short SHA of `HEAD` when the Rust crate was last compiled, or `""` when
/// the build had no git available. Stamped by `build.rs`.
///
/// ⚠️ It names HEAD, not the working tree: a build made with uncommitted changes
/// carries the SHA of the commit it was *based on*. What makes it trustworthy is
/// the release rule, not the label — every installer that is shipped is built from a
/// committed tree (the gates in `scripts/verify.mjs` green first, then commit).
pub const COMMIT: &str = env!("AGENTSTUDIO_COMMIT");

/// The window title: `Agent Studio 0.1.0 (5312aa6b)`, or `Agent Studio 0.1.0` when
/// the commit is unknown.
///
/// Pure, and split from the window it gets set on, because the formatting holds
/// the only decision in the feature (test the seam).
pub fn window_title(name: &str, version: &str, commit: &str) -> String {
    let commit = commit.trim();
    if commit.is_empty() {
        format!("{name} {version}")
    } else {
        format!("{name} {version} ({commit})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn shows_the_version_and_the_commit() {
        assert_eq!(
            window_title("Agent Studio", "0.1.0", "5312aa6b"),
            "Agent Studio 0.1.0 (5312aa6b)"
        );
    }

    #[test]
    fn omits_the_parentheses_when_the_commit_is_unknown() {
        // Two-sided: dropping the SHA must not also drop the
        // version, which the title must always show.
        assert_eq!(
            window_title("Agent Studio", "0.1.0", ""),
            "Agent Studio 0.1.0"
        );
        // Whitespace is the same as absent — `build.rs` trims, but a stray
        // newline reaching here must not render as `0.1.0 ( )`.
        assert_eq!(
            window_title("Agent Studio", "0.1.0", "  \n"),
            "Agent Studio 0.1.0"
        );
    }

    /// The stamp compiles in and is either empty or a short hex SHA — never a
    /// word like `unknown`, which would read as a real build id at a glance.
    #[test]
    fn the_commit_stamp_is_a_sha_or_nothing() {
        assert!(
            COMMIT.is_empty() || COMMIT.chars().all(|c| c.is_ascii_hexdigit()),
            "AGENTSTUDIO_COMMIT should be a hex SHA or empty, got {COMMIT:?}"
        );
    }

    /// Three files declare the version — `tauri.conf.json` (what the bundle and
    /// this title show), `Cargo.toml` (what cargo builds) and `package.json`
    /// (what npm reports). Nothing keeps them in step, and a title that disagrees
    /// with the installer it came from is worse than no title at all.
    #[test]
    fn versions_agree() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let read = |p: &Path| {
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(p).unwrap()).unwrap()
        };

        let bundle = read(&manifest.join("tauri.conf.json"));
        let bundle = bundle["version"].as_str().expect("tauri.conf.json version");
        let npm = read(&manifest.join("../package.json"));
        let npm = npm["version"].as_str().expect("package.json version");

        assert_eq!(
            bundle,
            env!("CARGO_PKG_VERSION"),
            "tauri.conf.json and Cargo.toml disagree — the window title would name \
             a different version from the one cargo built"
        );
        assert_eq!(
            bundle, npm,
            "tauri.conf.json and package.json disagree — bump them together"
        );
    }
}
