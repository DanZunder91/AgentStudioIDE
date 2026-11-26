//! On Windows `std::fs::canonicalize` returns verbatim `\\?\C:\…` paths nothing else uses, so
//! comparisons silently miss. Use [`canonicalize`] (verbatim prefix stripped) wherever a
//! canonical path is returned, compared or shown. Unchanged on macOS and Linux.

use std::path::{Path, PathBuf};

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share\x` → `\\srv\share\x`; anything else as it is.
/// Text only, so every OS tests it. A verbatim path that is neither a drive path nor UNC
/// (`\\?\Volume{…}\`, a device) has no plain spelling and is returned unchanged.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Is `s` spelled as a Windows path — `C:…`, `\\server\…`, `\\?\…`? Text only, so a path from
/// a transcript or a stored file is judged by its own spelling, on any OS (path rules are
/// written once).
pub fn is_windows_spelling(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || s.starts_with(r"\\")
}

/// A cwd as a comparison key (never shown or built on). Unix: trailing `/` trimmed. Windows
/// spelling: verbatim prefix removed, `/` → `\`, trailing `\` trimmed (`C:\` kept), ASCII case
/// folded, so typed, canonical and transcript cwds meet.
pub fn cwd_key(s: &str) -> String {
    if !is_windows_spelling(s) {
        let t = s.trim_end_matches('/');
        return if t.is_empty() {
            "/".to_string()
        } else {
            t.to_string()
        };
    }
    let plain = strip_verbatim(Path::new(s))
        .to_string_lossy()
        .replace('/', r"\");
    let mut t = plain.trim_end_matches('\\').to_string();
    if t.len() == 2 && t.ends_with(':') {
        t.push('\\');
    }
    t.to_ascii_lowercase()
}

/// `std::fs::canonicalize`, minus Windows' verbatim prefix ([`strip_verbatim`]). Symlinks and
/// `..` are resolved exactly as before; only the spelling of the answer changes, and only on
/// Windows. Errors are `std::fs::canonicalize`'s (the path does not exist, …).
pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    if cfg!(windows) {
        Ok(strip_verbatim(&real))
    } else {
        Ok(real)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_drive_and_unc_paths_lose_their_prefix_and_nothing_else_changes() {
        for (input, want) in [
            (r"\\?\C:\Users\me\app", r"C:\Users\me\app"),
            (r"\\?\c:\", r"c:\"),
            (r"\\?\UNC\srv\share\x", r"\\srv\share\x"),
            // No plain spelling exists: left verbatim rather than guessed.
            (r"\\?\Volume{0b1e}\x", r"\\?\Volume{0b1e}\x"),
            // Already plain, or not Windows at all: untouched.
            (r"C:\Users\me", r"C:\Users\me"),
            (r"\\srv\share", r"\\srv\share"),
            ("/Users/me/app", "/Users/me/app"),
            ("/private/tmp/x", "/private/tmp/x"),
        ] {
            assert_eq!(
                strip_verbatim(Path::new(input)),
                PathBuf::from(want),
                "{input}"
            );
        }
    }

    #[test]
    fn a_cwd_key_folds_windows_spellings_and_leaves_unix_ones_alone() {
        for (a, b) in [
            (r"C:\Users\me\Repo", r"c:\users\me\repo\"),
            (r"\\?\C:\Users\me\repo", r"C:/Users/me/repo/"),
            (r"C:\", "c:"),
            (r"\\?\UNC\srv\share\p", r"\\SRV\share\p\"),
        ] {
            assert_eq!(cwd_key(a), cwd_key(b), "{a} vs {b}");
        }
        assert_eq!(cwd_key(r"C:\"), r"c:\", "a drive root stays a root");
        // Unix: trailing slash only, case kept (a case-sensitive file system).
        assert_eq!(cwd_key("/a/B/"), "/a/B");
        assert_eq!(cwd_key("/"), "/");
        assert_ne!(cwd_key("/a/B"), cwd_key("/a/b"));
        assert!(is_windows_spelling(r"d:\x") && is_windows_spelling(r"\\srv\s"));
        assert!(!is_windows_spelling("/c:/x") && !is_windows_spelling("rel"));
    }

    #[test]
    fn a_canonical_path_has_no_verbatim_prefix_and_still_resolves_dot_dot() {
        let dir = std::env::temp_dir();
        let got = canonicalize(dir.join(".")).expect("the temp dir exists");
        assert!(
            !got.to_string_lossy().starts_with(r"\\?\"),
            "verbatim prefix leaked: {}",
            got.display()
        );
        assert_eq!(got, canonicalize(&dir).unwrap());
        assert!(got.is_absolute() && got.is_dir());
        assert!(canonicalize(dir.join("agentstudio-no-such-dir-7f3a")).is_err());
    }
}
