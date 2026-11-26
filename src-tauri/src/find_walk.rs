//! The file walk behind content ([`crate::find`]) and filename ([`crate::find_files`]) search.
//! Ignore rules prune DIRECTORIES only (noise, speed); every file in a surviving dir is listed, so
//! hidden or gitignored files like `.env` stay findable. `.git`/`.hg`/`.svn` are pruned by hand.

use std::path::{Path, PathBuf};

use ignore::overrides::Override;
use ignore::{DirEntry, WalkBuilder};

/// Version-control metadata dirs. With dotfiles searchable, this is the only thing keeping
/// `.git`'s object store out of results.
const VCS_DIRS: [&str; 3] = [".git", ".hg", ".svn"];

/// True for a `.git`/`.hg`/`.svn` directory below the root. Depth-guarded: pruning a `.git`
/// opened as the root would silently return nothing.
fn is_pruned_vcs_dir(entry: &DirEntry) -> bool {
    entry.depth() > 0
        && entry.file_type().is_some_and(|t| t.is_dir())
        && entry
            .file_name()
            .to_str()
            .is_some_and(|n| VCS_DIRS.contains(&n))
}

/// Every file to search under `root`: dirs pruned by ignore files and [`VCS_DIRS`], files kept
/// even if hidden or ignored. `overrides` (the `--glob` mask) must be applied here since files no
/// longer come from the walker. Files are sorted per directory so results are deterministic.
pub fn walk_files(root: &Path, overrides: Option<Override>) -> impl Iterator<Item = PathBuf> {
    WalkBuilder::new(root)
        .git_ignore(true)
        // ⚠️ NOT the ripgrep default. `hidden(true)` is what made `.env`,
        // `.gitignore` and `.github/**` unsearchable. See the module docs.
        .hidden(false)
        // Honour `.gitignore` even outside a git checkout — an IDE workspace
        // folder may be a subdir of a repo, or not yet `git init`ed.
        .require_git(false)
        .filter_entry(|e| !is_pruned_vcs_dir(e))
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_dir()))
        .flat_map(move |dir| files_in(dir.path(), overrides.as_ref()))
}

/// The files directly inside one directory, sorted, honouring the glob mask. An unreadable
/// directory yields nothing: one permission error must not fail the whole search.
fn files_in(dir: &Path, overrides: Option<&Override>) -> std::vec::IntoIter<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out.into_iter();
    };
    for entry in entries.flatten() {
        // `DirEntry::file_type` does NOT follow symlinks, so a symlinked file is
        // excluded here exactly as `ignore::Walk` excluded it before.
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if overrides.is_some_and(|ov| ov.matched(&path, false).is_ignore()) {
            continue;
        }
        out.push(path);
    }
    out.sort();
    out.into_iter()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ignore::overrides::OverrideBuilder;
    use std::fs;

    /// A throwaway tree under the OS temp dir, removed on drop.
    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aide-walk-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Tree(dir)
        }
        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
        /// Relative, forward-slash paths of every walked file, sorted.
        fn walked(&self, overrides: Option<Override>) -> Vec<String> {
            let mut v: Vec<String> = walk_files(&self.0, overrides)
                .map(|p| {
                    p.strip_prefix(&self.0)
                        .unwrap()
                        .to_string_lossy()
                        .replace(std::path::MAIN_SEPARATOR, "/")
                })
                .collect();
            v.sort();
            v
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// THE bug, in one assertion: a gitignored dotfile is findable.
    #[test]
    fn a_gitignored_dotfile_is_found() {
        let t = Tree::new("env");
        t.write(".gitignore", ".env\nnode_modules/\n");
        t.write(".env", "SECRET=1\n");
        t.write(".env.example", "SECRET=\n");
        t.write("src/main.rs", "");
        t.write("node_modules/pkg/index.js", "");

        let files = t.walked(None);

        // The `.env` itself, and the tracked example beside it.
        assert!(files.contains(&".env".to_string()), "got {files:?}");
        assert!(files.contains(&".env.example".to_string()), "got {files:?}");
        // Two-sided: un-hiding files must NOT un-prune directories,
        // or every search grows a node_modules tail and the fix trades one
        // problem for a worse one.
        assert!(
            !files.iter().any(|f| f.starts_with("node_modules/")),
            "ignored DIRECTORIES must still be pruned, got {files:?}"
        );
        // The ignore file itself is a dotfile, and is now findable too.
        assert!(files.contains(&".gitignore".to_string()), "got {files:?}");
        assert!(files.contains(&"src/main.rs".to_string()), "got {files:?}");
    }

    /// A gitignored file in a *nested* directory is found; a nested ignored
    /// directory is still pruned. This is the case a hand-rolled root-only
    /// matcher would get wrong, which is why the crate still does the matching.
    #[test]
    fn nested_ignore_rules_still_prune_directories() {
        let t = Tree::new("nested");
        t.write(".gitignore", "dist/\n");
        t.write("pkg/.gitignore", "*.local\nbuild/\n");
        t.write("pkg/app.local", "");
        t.write("pkg/app.ts", "");
        t.write("pkg/build/out.js", "");
        t.write("dist/bundle.js", "");

        let files = t.walked(None);

        assert!(
            files.contains(&"pkg/app.local".to_string()),
            "got {files:?}"
        );
        assert!(files.contains(&"pkg/app.ts".to_string()), "got {files:?}");
        assert!(
            !files.iter().any(|f| f.starts_with("dist/")),
            "root-level ignored dir must be pruned, got {files:?}"
        );
        assert!(
            !files.iter().any(|f| f.starts_with("pkg/build/")),
            "NESTED ignored dir must be pruned, got {files:?}"
        );
    }

    /// A root-level dotfile is listed whatever `hidden` is; only descending into a dot-directory
    /// pins `hidden(false)`.
    #[test]
    fn files_inside_hidden_directories_are_found() {
        let t = Tree::new("hiddendir");
        t.write(".github/workflows/ci.yml", "");
        t.write(".vscode/settings.json", "");
        t.write("README.md", "");

        let files = t.walked(None);

        assert!(
            files.contains(&".github/workflows/ci.yml".to_string()),
            "got {files:?}"
        );
        assert!(
            files.contains(&".vscode/settings.json".to_string()),
            "got {files:?}"
        );
    }

    /// `.git` lost its only protection when `hidden(false)` landed.
    #[test]
    fn vcs_directories_are_pruned() {
        let t = Tree::new("vcs");
        t.write(".git/objects/ab/cdef", "");
        t.write(".git/config", "");
        t.write("README.md", "");

        let files = t.walked(None);

        assert_eq!(files, vec!["README.md".to_string()], "got {files:?}");
    }

    /// The glob mask used to be applied by the walker. Files no longer come from
    /// the walker, so this proves the re-application is real and not decorative.
    #[test]
    fn the_glob_mask_still_filters_files() {
        let t = Tree::new("glob");
        t.write("a.ts", "");
        t.write("b.rs", "");
        t.write(".env", "");

        let mut ob = OverrideBuilder::new(&t.0);
        ob.add("*.ts").unwrap();
        let files = t.walked(Some(ob.build().unwrap()));

        assert_eq!(files, vec!["a.ts".to_string()], "got {files:?}");
    }

    /// Sorted per directory, so a result set does not depend on `readdir` order.
    #[test]
    fn files_are_returned_in_sorted_order() {
        let t = Tree::new("sort");
        for name in ["c.txt", "a.txt", "b.txt"] {
            t.write(name, "");
        }
        let files: Vec<String> = walk_files(&t.0, None)
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, vec!["a.txt", "b.txt", "c.txt"], "got {files:?}");
    }
}
