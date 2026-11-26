//! Build identity for the window title: version plus commit, since the version stays `0.1.0`
//! across builds. The version comes from `tauri.conf.json` via `package_info()` (same value as
//! the bundle's Info.plist); `versions_agree` keeps the three version files in sync.

/// Short SHA of `HEAD` at compile time (stamped by `build.rs`), or `""` without git.
/// Names HEAD, not the working tree: shipped installers are built from a committed tree.
pub const COMMIT: &str = env!("AGENTSTUDIO_COMMIT");

/// `Agent Studio 0.1.0 (5312aa6b)`, or `Agent Studio 0.1.0` when the commit is unknown.
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

    /// `tauri.conf.json` (bundle + title), `Cargo.toml` and `package.json` each declare the
    /// version; nothing else keeps them in step.
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
