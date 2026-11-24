//! Persisted "recently-used project folders" list.
//!
//! Feeds the rail's ⚡ "launch in last project" button and by-folder grouping, so it
//! must survive app restarts. Stored as a JSON array of **absolute** directory
//! paths, **most-recent-first**, deduped by path, capped at [`CAP`].
//!
//! **Robustness over correctness of the file:** a missing, unreadable, or corrupt
//! store is treated as an empty list, never an error — reading recent projects must
//! not be able to break UI startup.
//!
//! The list logic ([`load`], [`push`], [`merge_front`]) operates on an explicit file
//! path so it is unit-testable against a temp dir, with no dependency on the real
//! app config dir. The `#[tauri::command]`s are the thin glue that resolves that
//! path from the `AppHandle`.

use std::path::{Path, PathBuf};

/// File name inside the config dir.
const FILE_NAME: &str = "recent-projects.json";

/// Keep at most this many; the oldest (tail) is dropped past the cap.
const CAP: usize = 10;

/// Load the list from `path`. **Any** failure — missing file, unreadable, corrupt
/// JSON, or a JSON value that isn't an array of strings — yields an empty vec, so
/// startup can never break on a bad store.
pub fn load(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    clean(serde_json::from_str::<Vec<String>>(&text).unwrap_or_default())
}

/// Entries written by older builds on Windows hold the verbatim `\\?\C:\…` spelling
/// (`std::fs::canonicalize`'s), which then showed as an agent's cwd in quick-launch and never
/// matched a plain `C:\…` path. Read them back plain, and drop the duplicate a plain re-push
/// of the same folder would otherwise sit beside — keeping the first (most recent) position.
fn clean(list: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    list.into_iter()
        .map(|p| {
            crate::paths::strip_verbatim(Path::new(&p))
                .to_string_lossy()
                .into_owned()
        })
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Validate `raw` is an **existing directory**, canonicalize it to an absolute
/// path, move-or-insert it at the front, persist to `path`, and return the updated
/// list.
///
/// A path that does not exist (or is a file, not a directory) returns the current
/// list **unchanged** — not an error. Canonicalization resolves symlinks, so two
/// spellings of the same directory dedup correctly.
pub fn push(path: &Path, raw: &str) -> Vec<String> {
    // Load → merge → save under the file's lock: two pushes at once must not drop one.
    let _guard = crate::store_file::lock(path);
    let current = load(path);

    // `canonicalize` fails if the path does not exist; it also gives us an absolute
    // path. Reject non-directories (canonicalize succeeds for files too). `paths::` so a
    // Windows path is stored `C:\…`, never the verbatim `\\?\C:\…`.
    let Ok(canon) = crate::paths::canonicalize(raw) else {
        return current;
    };
    if !canon.is_dir() {
        return current;
    }
    let abs = canon.to_string_lossy().into_owned();

    let updated = merge_front(current, abs, CAP);
    // Best-effort persist: a write failure still returns the in-memory list, so the
    // UI reflects the push even if the disk write raced.
    let _ = save(path, &updated);
    updated
}

/// Move-or-insert `new` at the front, dedup by exact path, cap the length. Pure —
/// the whole ordering contract, testable without I/O.
fn merge_front(mut list: Vec<String>, new: String, cap: usize) -> Vec<String> {
    // Remove any existing occurrence first, so a re-push MOVES rather than
    // duplicates.
    list.retain(|p| p != &new);
    list.insert(0, new);
    // Most-recent-first, so truncating the tail drops the oldest.
    list.truncate(cap);
    list
}

/// Write the list to `path`, creating the parent dir if needed.
fn save(path: &Path, list: &[String]) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(list).unwrap_or_else(|_| "[]".to_string());
    let _guard = crate::store_file::lock(path);
    crate::store_file::write_atomic(path, json.as_bytes(), false)
}

/// The store file's path: the Tauri app config dir if available (created on write),
/// else a `home_dir()`-based fallback.
fn store_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        return dir.join(FILE_NAME);
    }
    fallback_store_path()
}

/// `~/.config/agent-studio/recent-projects.json` — used when the Tauri config dir
/// can't be resolved. Reuses `claude::home_dir`.
fn fallback_store_path() -> PathBuf {
    crate::agent::claude::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("agent-studio")
        .join(FILE_NAME)
}

/// The recent-projects list, most-recent-first. Missing/corrupt store → `[]`.
///
/// Frontend contract: `invoke<string[]>('recent_projects')`.
#[tauri::command]
pub fn recent_projects(app: tauri::AppHandle) -> Vec<String> {
    load(&store_path(&app))
}

/// Record `path` as the most recent project and return the updated list. A path
/// that is not an existing directory leaves the list unchanged.
///
/// Frontend contract: `invoke<string[]>('push_recent_project', { path })`.
#[tauri::command]
pub fn push_recent_project(app: tauri::AppHandle, path: String) -> Vec<String> {
    push(&store_path(&app), &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh temp directory that cleans itself up, plus the store path inside it.
    struct Fixture {
        dir: PathBuf,
        store: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("agentstudio-recent-{label}-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&dir).unwrap();
            let store = dir.join("recent-projects.json");
            Self { dir, store }
        }
        /// Make a real subdirectory to push, returning its **canonical** path (what
        /// `push` will store).
        fn project(&self, name: &str) -> String {
            let p = self.dir.join(name);
            std::fs::create_dir_all(&p).unwrap();
            crate::paths::canonicalize(&p)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn push_prepends_a_new_path() {
        let f = Fixture::new("prepend");
        let a = f.project("a");
        let b = f.project("b");
        assert_eq!(push(&f.store, &a), vec![a.clone()]);
        assert_eq!(
            push(&f.store, &b),
            vec![b.clone(), a.clone()],
            "newest first"
        );
    }

    #[test]
    fn re_pushing_moves_to_front_without_duplicating() {
        let f = Fixture::new("move");
        let a = f.project("a");
        let b = f.project("b");
        let c = f.project("c");
        push(&f.store, &a);
        push(&f.store, &b);
        push(&f.store, &c);
        // Re-push `a`: it must move to the front, not appear twice.
        let list = push(&f.store, &a);
        assert_eq!(list, vec![a.clone(), c.clone(), b.clone()]);
        assert_eq!(list.iter().filter(|p| **p == a).count(), 1, "no duplicate");
    }

    #[test]
    fn caps_at_ten_dropping_the_oldest() {
        let f = Fixture::new("cap");
        let mut pushed = Vec::new();
        for i in 0..13 {
            let p = f.project(&format!("p{i}"));
            push(&f.store, &p);
            pushed.push(p);
        }
        let list = load(&f.store);
        assert_eq!(list.len(), 10, "capped at 10");
        // The 10 most-recent survive, newest first; the 3 oldest are gone.
        let expected: Vec<String> = pushed.iter().rev().take(10).cloned().collect();
        assert_eq!(list, expected);
        assert!(!list.contains(&pushed[0]), "the oldest was dropped");
    }

    #[test]
    fn persists_across_a_fresh_read() {
        let f = Fixture::new("persist");
        let a = f.project("a");
        let b = f.project("b");
        push(&f.store, &a);
        push(&f.store, &b);
        // A brand-new read of the same store file sees the persisted order.
        assert_eq!(load(&f.store), vec![b, a]);
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let f = Fixture::new("missing");
        assert!(load(&f.store).is_empty(), "no file yet => empty");
    }

    #[test]
    fn corrupt_file_reads_as_empty_never_errors() {
        let f = Fixture::new("corrupt");
        for junk in ["{ not json", "\"a string\"", "42", "[1, 2, 3]", ""] {
            std::fs::write(&f.store, junk).unwrap();
            assert!(
                load(&f.store).is_empty(),
                "corrupt {junk:?} must read as empty"
            );
        }
    }

    #[test]
    fn a_nonexistent_path_leaves_the_list_unchanged() {
        let f = Fixture::new("noexist");
        let a = f.project("a");
        push(&f.store, &a);
        let before = load(&f.store);
        let after = push(&f.store, "/definitely/not/here/at/all");
        assert_eq!(after, before, "a missing path must not change the list");
        assert_eq!(
            load(&f.store),
            before,
            "…and must not have been persisted away"
        );
    }

    #[test]
    fn a_file_path_is_rejected_only_directories_count() {
        let f = Fixture::new("filepath");
        let file = f.dir.join("not-a-dir.txt");
        std::fs::write(&file, "x").unwrap();
        let list = push(&f.store, &file.to_string_lossy());
        assert!(list.is_empty(), "a file is not a project directory");
    }

    #[test]
    fn stored_paths_are_absolute() {
        let f = Fixture::new("abs");
        let a = f.project("a");
        let list = push(&f.store, &a);
        assert!(
            std::path::Path::new(&list[0]).is_absolute(),
            "stored paths must be absolute: {:?}",
            list[0]
        );
    }

    /// `push` **canonicalizes**: a non-canonical spelling of a real dir is stored as
    /// its clean absolute path (no `.`/`..`), so the same dir spelled two ways dedups
    /// and the stored value is always absolute.
    #[test]
    fn push_canonicalizes_the_stored_path() {
        let f = Fixture::new("canon");
        let a = f.dir.join("a");
        std::fs::create_dir_all(&a).unwrap();
        // A messy but valid spelling of the same directory: <dir>/a/../a
        let messy = a.join("..").join("a");
        let list = push(&f.store, &messy.to_string_lossy());
        let clean = crate::paths::canonicalize(&a)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(list[0], clean, "the stored path must be canonicalized");
        assert!(
            !list[0].contains(".."),
            "a canonical path has no `..` components"
        );

        // The canonical spelling of the SAME dir must dedup, not double-count.
        let again = push(&f.store, &clean);
        assert_eq!(
            again.len(),
            1,
            "two spellings of one dir must be a single entry"
        );
    }

    /// A file written by an earlier Windows build holds `\\?\C:\…` entries: they read back
    /// plain, and a plain duplicate of one collapses into the first (most recent) position.
    /// Text only, so every OS runs it.
    #[test]
    fn verbatim_entries_from_an_older_build_read_back_plain_and_deduped() {
        let f = Fixture::new("verbatim");
        std::fs::write(
            &f.store,
            r#"["\\\\?\\C:\\Users\\me\\repo", "C:\\Users\\me\\repo", "\\\\?\\UNC\\srv\\share\\p", "/Users/me/app"]"#,
        )
        .unwrap();
        assert_eq!(
            load(&f.store),
            vec![
                r"C:\Users\me\repo".to_string(),
                r"\\srv\share\p".to_string(),
                "/Users/me/app".to_string(),
            ]
        );
    }

    /// What `push` stores has no verbatim prefix — otherwise quick-launch would show
    /// `\\?\C:\…` as an agent's cwd. (On macOS/Linux the assertion is trivially true; Windows is the real run.)
    #[test]
    fn a_pushed_path_is_never_stored_verbatim() {
        let f = Fixture::new("plain");
        let a = f.dir.join("a");
        std::fs::create_dir_all(&a).unwrap();
        let list = push(&f.store, &a.to_string_lossy());
        assert!(!list[0].starts_with(r"\\?\"), "{}", list[0]);
        assert!(!load(&f.store)[0].starts_with(r"\\?\"));
    }

    /// Windows: `c:\…` and `C:\…` (any case) are one folder, so they must be one entry — the
    /// canonical path carries the folder's real spelling.
    #[cfg(windows)]
    #[test]
    fn on_windows_two_casings_of_one_folder_are_one_entry() {
        let f = Fixture::new("case");
        let a = f.project("Proj");
        let lower = a.to_lowercase();
        assert_ne!(lower, a);
        push(&f.store, &a);
        let list = push(&f.store, &lower);
        assert_eq!(list, vec![a]);
    }

    /// Concurrent pushes of different folders: every one survives (falsify: drop the lock in
    /// `push` and some are lost to a load-before-the-other-save).
    #[test]
    fn concurrent_pushes_lose_nothing() {
        let f = Fixture::new("concurrent");
        let dirs: Vec<String> = (0..8).map(|i| f.project(&format!("c{i}"))).collect();
        let store = std::sync::Arc::new(f.store.clone());
        let threads: Vec<_> = dirs
            .iter()
            .cloned()
            .map(|d| {
                let store = std::sync::Arc::clone(&store);
                std::thread::spawn(move || push(&store, &d))
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let mut got = load(&f.store);
        got.sort();
        let mut want = dirs;
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn merge_front_is_pure_and_correct() {
        // No I/O — the ordering contract in isolation.
        assert_eq!(merge_front(vec![], "a".into(), 10), vec!["a"]);
        assert_eq!(
            merge_front(vec!["a".into(), "b".into()], "c".into(), 10),
            vec!["c", "a", "b"]
        );
        // Move-to-front, no dup.
        assert_eq!(
            merge_front(vec!["a".into(), "b".into(), "c".into()], "b".into(), 10),
            vec!["b", "a", "c"]
        );
        // Cap drops the tail (oldest).
        assert_eq!(
            merge_front(vec!["a".into(), "b".into()], "c".into(), 2),
            vec!["c", "a"]
        );
    }
}
