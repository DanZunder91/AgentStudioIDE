//! Per-file language-server root resolution.
//!
//! `attachLsp` used to hand every server the app's single PRIMARY workspace
//! root. rust-analyzer then looked for a `Cargo.toml` at that directory's top
//! level and, for any repo that keeps its crates in subfolders (`src-tauri/`,
//! `crates/api/`), failed discovery and
//! spammed "Failed to discover workspace" dialogs. With several projects open
//! the same wiring also rooted a file from project B at project A.
//!
//! `project_root_scoped` fixes both: starting from the FILE, it walks up to the
//! file's own containing workspace root and returns the **outermost** ancestor
//! directory holding one of the language's project markers — outermost, so a
//! Cargo *workspace* root wins over the member crate the file happens to sit
//! in. No marker on the path → the containing workspace root (which is also
//! the answer for languages with no marker table yet: that alone repairs the
//! multi-root wrong-project case for every server).
//!
//! **Security scope.** The path is a client-supplied string, so it
//! goes through [`crate::fs_tree::resolve_in_scope`] FIRST, and the walk is
//! bounded by the containing allowed root — the resolver can neither read nor
//! reveal anything above it.

use std::path::{Path, PathBuf};

/// Project markers per language id, most-specific table this app needs today.
/// A language absent from this table resolves to the containing workspace
/// root — correct for servers that treat the root as a search scope rather
/// than a manifest location.
fn markers_for(language_id: &str) -> &'static [&'static str] {
    match language_id {
        "rust" => &["Cargo.toml"],
        _ => &[],
    }
}

/// The outermost marker directory between `requested`'s parent and its
/// containing allowed root (inclusive); the containing root when no marker
/// exists on that path.
pub fn project_root_scoped(
    requested: &Path,
    language_id: &str,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let real = crate::fs_tree::resolve_in_scope(requested, allowed_roots)?;

    // The file's own containing root: the LONGEST canonicalized allowed root
    // that prefixes it (roots can nest — recents may hold both a repo and a
    // folder inside it; the nearest one is the honest boundary).
    let containing = allowed_roots
        .iter()
        .filter_map(|root| crate::paths::canonicalize(root).ok())
        .filter(|root| real.starts_with(root))
        .max_by_key(|root| root.components().count())
        // Unreachable after resolve_in_scope admitted the path, but never a panic.
        .ok_or_else(|| "path is outside the allowed workspace roots".to_string())?;

    let markers = markers_for(language_id);
    let start = if real.is_dir() {
        real.clone()
    } else {
        real.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| containing.clone())
    };

    // Walk UP from the file's directory to the containing root. Each match
    // overwrites the last, so the final assignment is the outermost one.
    let mut best: Option<PathBuf> = None;
    let mut dir = start;
    loop {
        if markers.iter().any(|m| dir.join(m).is_file()) {
            best = Some(dir.clone());
        }
        if dir == containing {
            break;
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => break,
        }
    }
    Ok(best.unwrap_or(containing))
}

/// Resolve the directory a language server should be rooted at for `path`.
#[tauri::command]
pub fn lsp_project_root(
    app: tauri::AppHandle,
    language_id: String,
    path: String,
) -> Result<String, String> {
    project_root_scoped(
        Path::new(&path),
        &language_id,
        &crate::fs_tree::allowed_roots(&app),
    )
    .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Unique, canonicalized temp tree (the git_blame TempDir shape: canonical
    /// on construction so macOS `/tmp` → `/private/tmp` matches the scope).
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentstudio-lsproot-{label}-{}-{:?}",
                std::process::id(),
                std::thread::current().id(),
            ));
            fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(crate::paths::canonicalize(&dir).expect("canonicalize temp dir"))
        }
        fn roots(&self) -> Vec<PathBuf> {
            vec![self.0.clone()]
        }
        fn write(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().expect("parent")).expect("mkdirs");
            fs::write(&p, b"x").expect("write");
            p
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_member_crate_inside_a_cargo_workspace_roots_at_the_workspace() {
        let t = TempDir::new("workspace");
        t.write("Cargo.toml");
        t.write("crates/catalog/Cargo.toml");
        let file = t.write("crates/catalog/src/search.rs");
        let got = project_root_scoped(&file, "rust", &t.roots()).expect("resolves");
        assert_eq!(got, t.0, "outermost marker (the workspace root) must win");
    }

    #[test]
    fn a_crate_in_a_subfolder_of_a_manifestless_repo_roots_at_the_crate() {
        // The real shape: repo root has NO Cargo.toml; the crate
        // lives below it (a `crates/` layout, this repo's src-tauri/).
        let t = TempDir::new("subcrate");
        t.write("crates/catalog/Cargo.toml");
        let file = t.write("crates/catalog/src/search.rs");
        let got = project_root_scoped(&file, "rust", &t.roots()).expect("resolves");
        assert_eq!(got, t.0.join("crates/catalog"));
    }

    #[test]
    fn no_marker_anywhere_falls_back_to_the_containing_workspace_root() {
        let t = TempDir::new("nomarker");
        let file = t.write("src/search.rs");
        let got = project_root_scoped(&file, "rust", &t.roots()).expect("resolves");
        assert_eq!(got, t.0);
    }

    #[test]
    fn a_language_with_no_marker_table_roots_at_the_containing_root_even_beside_a_cargo_toml() {
        let t = TempDir::new("nolang");
        t.write("sub/Cargo.toml");
        let file = t.write("sub/notes.md");
        let got = project_root_scoped(&file, "markdown", &t.roots()).expect("resolves");
        assert_eq!(got, t.0, "markers are per-language; markdown has none");
    }

    #[test]
    fn a_file_directly_under_the_root_with_a_root_manifest_roots_at_the_root() {
        let t = TempDir::new("atroot");
        t.write("Cargo.toml");
        let file = t.write("build.rs");
        let got = project_root_scoped(&file, "rust", &t.roots()).expect("resolves");
        assert_eq!(got, t.0);
    }

    #[test]
    fn the_walk_never_escapes_the_containing_root() {
        // A marker ABOVE the allowed root must be invisible: the walk stops at
        // the scope boundary, so the outer Cargo.toml cannot be chosen (or
        // even probed as an answer).
        let outer = TempDir::new("outer");
        outer.write("Cargo.toml");
        outer.write("inner/src/lib.rs");
        let inner_root = outer.0.join("inner");
        let file = outer.0.join("inner/src/lib.rs");
        let got = project_root_scoped(&file, "rust", std::slice::from_ref(&inner_root))
            .expect("resolves");
        assert_eq!(got, crate::paths::canonicalize(&inner_root).expect("canon"));
    }

    #[test]
    fn an_out_of_scope_path_is_rejected_with_the_scope_error() {
        let t = TempDir::new("scope");
        let elsewhere = TempDir::new("scope-elsewhere");
        let file = elsewhere.write("src/lib.rs");
        let err = project_root_scoped(&file, "rust", &t.roots()).expect_err("must reject");
        assert!(
            err.contains("outside the allowed workspace roots"),
            "unexpected error: {err}"
        );
    }
}
