//! Fuzzy filename search (quick open), sibling of [`crate::find`]: same [`crate::find_walk`] walk
//! (ignore rules prune directories, not files), scope guard and result cap, but it matches each
//! file's root-relative path and never opens a file.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::find_cancel::{is_cancelled, CANCELLED};

/// Caps the output (first [`MAX_FILES`] by sorted path, `truncated: true`), not the work: the whole
/// tree is walked and sorted first. Slowness is answered by cancellation, not a smaller cap.
const MAX_FILES: usize = 500;

/// Options for `find_files`. Booleans default false, so the frontend can send a
/// partial (or empty) object. TS: `interface FindFilesOptions { caseSensitive?:
/// boolean }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FindFilesOptions {
    /// `false` (default) → case-insensitive substring match; `true` → exact case.
    pub case_sensitive: bool,
}

/// One filename hit. `path` is relative to the search root (forward-slash
/// separated, cross-platform); `name` is the final path segment (the basename).
/// TS: `interface FindFileHit { path: string; name: string }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindFileHit {
    pub path: String,
    pub name: String,
}

/// The result of `find_files`. `truncated` is `true` when the walk produced more
/// matches than the cap (there are more files than returned). TS: `interface
/// FindFilesResult { files: FindFileHit[]; truncated: boolean }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindFilesResult {
    pub files: Vec<FindFileHit>,
    pub truncated: bool,
}

/// Files under `root` whose root-relative `/` path contains `query` (case-insensitive unless
/// `options.case_sensitive`), sorted and capped. Test-only uncancellable entry point; the product
/// uses [`search_files_cancellable`].
#[cfg(test)]
fn search_files(
    root: &Path,
    query: &str,
    options: &FindFilesOptions,
    allowed_roots: &[PathBuf],
) -> Result<FindFilesResult, String> {
    search_files_cancellable(root, query, options, allowed_roots, None)
}

/// [`search_files`] plus an optional cancel flag, polled once per directory entry. The scope guard
/// runs first, so an out-of-scope root is never touched.
fn search_files_cancellable(
    root: &Path,
    query: &str,
    options: &FindFilesOptions,
    allowed_roots: &[PathBuf],
    cancel: Option<&AtomicBool>,
) -> Result<FindFilesResult, String> {
    let real = crate::fs_tree::resolve_in_scope(root, allowed_roots)?;
    if !real.is_dir() {
        return Err("path is not a directory".to_string());
    }

    // An all-whitespace (or empty) query would match every file — useless and a
    // flood; mirror `find_in_files`'s empty-query behaviour and return nothing.
    if query.trim().is_empty() {
        return Ok(FindFilesResult {
            files: Vec::new(),
            truncated: false,
        });
    }

    // Pre-lower the needle once for the case-insensitive path.
    let needle = if options.case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    let mut files: Vec<FindFileHit> = Vec::new();
    // Ignore rules prune directories; they do not hide files — so a gitignored
    // `.env` is findable while `node_modules/` stays pruned. See `find_walk`.
    for path in crate::find_walk::walk_files(&real, None) {
        // 🔴 The cancellation point. One relaxed atomic load per file — a plain register
        // read, immeasurable against the `readdir` + gitignore-match this loop already
        // does, and the only place a walk this shape can be interrupted.
        if is_cancelled(cancel) {
            return Err(CANCELLED.to_string());
        }

        // Path relative to the root, forward-slash separated so the wire value is
        // stable across platforms (`\` on Windows → `/`).
        let rel = path
            .strip_prefix(&real)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");

        let hay = if options.case_sensitive {
            rel.clone()
        } else {
            rel.to_lowercase()
        };
        if !hay.contains(&needle) {
            continue;
        }

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| rel.clone());
        files.push(FindFileHit { path: rel, name });
    }

    // Sort by path for a deterministic order, THEN cap: `truncated` reflects whether
    // the full match set exceeded the cap, and the kept slice is the first
    // MAX_FILES in sorted order (not an arbitrary prefix of the walk).
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let truncated = files.len() > MAX_FILES;
    if truncated {
        files.truncate(MAX_FILES);
    }

    Ok(FindFilesResult { files, truncated })
}

/// Contract: `invoke<FindFilesResult>('find_files', { root, query, options, searchId })`; `root`
/// must be in scope. Cancelled → `Err("cancelled")`; no `searchId` → uncancellable. `async` is
/// load-bearing (see `find_cancel`'s module doc).
#[tauri::command]
pub async fn find_files(
    app: tauri::AppHandle,
    root: String,
    query: String,
    options: FindFilesOptions,
    search_id: Option<String>,
) -> Result<FindFilesResult, String> {
    // Resolved on the async side and moved in: the scope stays server-authoritative and
    // the check is not skippable.
    let allowed_roots = crate::fs_tree::allowed_roots(&app);
    run_find_files(root, query, options, allowed_roots, search_id).await
}

/// The `AppHandle`-free core of [`find_files`] — registry glue plus the hop onto the
/// blocking pool. Same shape as [`crate::find::run_find`]; see there for why it mirrors
/// `portability::blocking` / `metrics::claude_metrics` rather than inventing a pattern.
pub(crate) async fn run_find_files(
    root: String,
    query: String,
    options: FindFilesOptions,
    allowed_roots: Vec<PathBuf>,
    search_id: Option<String>,
) -> Result<FindFilesResult, String> {
    let handle = crate::find_cancel::begin(search_id);
    let flag = handle.flag();
    let done = tokio::task::spawn_blocking(move || {
        search_files_cancellable(
            Path::new(&root),
            &query,
            &options,
            &allowed_roots,
            Some(flag.as_ref()),
        )
    })
    .await;
    // `handle` drops at the end of this scope on EVERY path, so the registry never leaks.
    match done {
        Ok(result) => result,
        Err(e) => Err(format!("search task failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A self-cleaning temp tree with files to search by name.
    struct Tree {
        root: PathBuf,
    }

    impl Tree {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "agentstudio-findfiles-{label}-{}",
                ulid::Ulid::new()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn write(&self, rel: &str, content: &str) {
            let p = self.root.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, content).unwrap();
        }
        fn roots(&self) -> Vec<PathBuf> {
            vec![crate::paths::canonicalize(&self.root).unwrap()]
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn opts() -> FindFilesOptions {
        FindFilesOptions::default()
    }

    /// A nested fixture: the query matches the right relative paths (sorted,
    /// forward-slash separated) and each hit's `name` is the basename.
    #[test]
    fn matches_relative_paths_with_basename() {
        let t = Tree::new("basic");
        t.write("src/main.rs", "");
        t.write("src/lib.rs", "");
        t.write("src/util/find.rs", "");
        t.write("README.md", "");

        // "rs" is a substring of every `.rs` path (via the extension), of none else.
        let r = search_files(&t.root, "rs", &opts(), &t.roots()).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["src/lib.rs", "src/main.rs", "src/util/find.rs"]);
        // `name` is the final segment, not the whole relative path.
        assert_eq!(r.files[0].name, "lib.rs");
        assert_eq!(r.files[2].name, "find.rs");
        assert!(!r.truncated);
    }

    /// Case-insensitive by default; `caseSensitive: true` narrows to exact case.
    #[test]
    fn case_sensitivity_narrows_matches() {
        let t = Tree::new("case");
        t.write("Widget.tsx", "");

        // Default (insensitive): lowercase query still matches the mixed-case name.
        let ci = search_files(&t.root, "widget", &opts(), &t.roots()).unwrap();
        assert_eq!(ci.files.len(), 1);
        assert_eq!(ci.files[0].name, "Widget.tsx");

        // Case-sensitive: the lowercase query no longer matches "Widget".
        let cs = FindFilesOptions {
            case_sensitive: true,
        };
        let miss = search_files(&t.root, "widget", &cs, &t.roots()).unwrap();
        assert!(miss.files.is_empty());
        // ...but the exact-case query does.
        let hit = search_files(&t.root, "Widget", &cs, &t.roots()).unwrap();
        assert_eq!(hit.files.len(), 1);
    }

    /// Ignore rules prune directories only: a gitignored file such as `.env` is still returned.
    #[test]
    fn gitignore_prunes_directories_but_no_longer_hides_files() {
        let t = Tree::new("ignore");
        t.write(".gitignore", "ignored/\n*.log\n.env\n");
        t.write("kept.rs", "");
        t.write("build.log", "");
        t.write(".env", "");
        t.write("ignored/deep.rs", "");

        let r = search_files(&t.root, ".", &opts(), &t.roots()).unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();

        // A dot-prefixed query (`.env`) finds the file.
        let env = search_files(&t.root, ".env", &opts(), &t.roots()).unwrap();
        assert_eq!(
            env.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec![".env"],
            "typing `.env` must find it"
        );

        // Two-sided: ignored + hidden FILES are listed…
        assert!(paths.contains(&".env"), "got {paths:?}");
        assert!(paths.contains(&"build.log"), "got {paths:?}");
        assert!(paths.contains(&".gitignore"), "got {paths:?}");
        assert!(paths.contains(&"kept.rs"), "got {paths:?}");
        // …and ignored DIRECTORIES are still pruned.
        assert!(
            !paths.iter().any(|p| p.starts_with("ignored/")),
            "ignored directories must still be pruned: got {paths:?}"
        );
    }

    /// Over the cap: `truncated` is set and exactly `MAX_FILES` are returned.
    #[test]
    fn results_are_capped_and_flagged_truncated() {
        let t = Tree::new("cap");
        for i in 0..(MAX_FILES + 50) {
            t.write(&format!("hit_{i:04}.txt"), "");
        }
        let r = search_files(&t.root, "hit", &opts(), &t.roots()).unwrap();
        assert_eq!(r.files.len(), MAX_FILES, "must cap at MAX_FILES");
        assert!(r.truncated, "must flag truncation when capped");
        // The cap keeps the first MAX_FILES in sorted-path order.
        assert_eq!(r.files[0].path, "hit_0000.txt");
    }

    /// A root outside every allowed root is rejected — the shared scope guard.
    #[test]
    fn an_out_of_scope_root_is_rejected() {
        let inside = Tree::new("scope-in");
        let outside = Tree::new("scope-out");
        outside.write("secret.rs", "");
        let err = search_files(&outside.root, "secret", &opts(), &inside.roots()).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    /// A file (non-directory) root is rejected.
    #[test]
    fn a_file_root_is_rejected() {
        let t = Tree::new("fileroot");
        t.write("thing.txt", "");
        let err =
            search_files(&t.root.join("thing.txt"), "thing", &opts(), &t.roots()).unwrap_err();
        assert!(err.contains("not a directory"), "got: {err}");
    }

    /// An empty or all-whitespace query returns an empty, non-truncated result.
    #[test]
    fn empty_or_whitespace_query_returns_nothing() {
        let t = Tree::new("empty");
        t.write("a.rs", "");
        for q in ["", "   ", "\t\n"] {
            let r = search_files(&t.root, q, &opts(), &t.roots()).unwrap();
            assert!(r.files.is_empty(), "query {q:?} should match nothing");
            assert!(!r.truncated);
        }
    }

    /// The wire shape: camelCase fields (`caseSensitive` in, `files`/`path`/`name`/
    /// `truncated` out) — the frontend reads exactly these literals.
    #[test]
    fn wire_contract_is_camel_case() {
        let opts: FindFilesOptions = serde_json::from_str(r#"{"caseSensitive":true}"#).unwrap();
        assert!(opts.case_sensitive);
        // An empty object is a valid (all-default) options object.
        let dflt: FindFilesOptions = serde_json::from_str("{}").unwrap();
        assert!(!dflt.case_sensitive);

        let result = FindFilesResult {
            files: vec![FindFileHit {
                path: "src/main.rs".into(),
                name: "main.rs".into(),
            }],
            truncated: false,
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"files":[{"path":"src/main.rs","name":"main.rs"}],"truncated":false}"#
        );
    }

    // ---- cancellation -----------------------------------------------------
    // Mod+Shift+O froze the window for the same reason Mod+Shift+F did: a synchronous
    // command walking a big tree on the IPC thread. These pin the kill half.

    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Entries in the slow fixture — enough that a full walk takes clearly more time than
    /// a cancel needs to land. The floor assertion below fails loudly if that stops being
    /// true on a faster machine, rather than going quietly green.
    const SLOW_TREE_FILES: usize = 9000;
    /// Files in the slow fixture whose path contains the needle. Far under `MAX_FILES`, so
    /// the cap never truncates and "real results" is an exact number.
    const SLOW_TREE_HITS: usize = 5;

    /// A tree big enough that walking it takes measurable time. Empty files: this search
    /// never opens one, so the cost is purely walk + match, exactly what is being cancelled.
    fn slow_tree(label: &str) -> Tree {
        let t = Tree::new(label);
        for i in 0..SLOW_TREE_FILES {
            t.write(&format!("d{:02}/plain{i:05}.txt", i % 60), "");
        }
        for i in 0..SLOW_TREE_HITS {
            t.write(&format!("zz-needle-{i}.txt"), "");
        }
        t
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("tokio runtime")
    }

    /// Two-sided: the same search, same tree, cancelled and not. Without the
    /// un-cancelled half this also passes against a search that simply returns nothing.
    #[test]
    fn a_set_cancel_flag_stops_the_walk_and_a_clear_one_does_not() {
        let t = slow_tree("cancel-preset");
        let roots = t.roots();
        let flag = AtomicBool::new(false);

        let ok = search_files_cancellable(&t.root, "needle", &opts(), &roots, Some(&flag)).unwrap();
        assert_eq!(
            ok.files.len(),
            SLOW_TREE_HITS,
            "an un-cancelled search must return real results"
        );
        assert!(!ok.truncated);

        flag.store(true, Ordering::Relaxed);
        let err =
            search_files_cancellable(&t.root, "needle", &opts(), &roots, Some(&flag)).unwrap_err();
        assert_eq!(
            err, CANCELLED,
            "a cancelled search must return the bare `cancelled` sentinel"
        );
    }

    /// The real shape of the bug: a walk already in flight, cancelled from another thread.
    #[test]
    fn a_cancel_from_another_thread_cuts_a_running_walk_short() {
        let t = slow_tree("cancel-live");
        let roots = t.roots();

        // The FLOOR: this fixture really does take time on this machine, now.
        // Doubles as the two-sided half — un-cancelled, every hit is found.
        let started = Instant::now();
        let full = search_files(&t.root, "needle", &opts(), &roots).unwrap();
        let uncancelled = started.elapsed();
        assert_eq!(full.files.len(), SLOW_TREE_HITS);
        assert!(
            uncancelled >= Duration::from_millis(15),
            "fixture walks in {uncancelled:?} — too fast to prove a cancel landed early; \
             raise SLOW_TREE_FILES"
        );

        let flag = Arc::new(AtomicBool::new(false));
        let walk_flag = Arc::clone(&flag);
        let root = t.root.clone();
        let walk_roots = roots.clone();
        let started = Instant::now();
        let walker = std::thread::spawn(move || {
            search_files_cancellable(&root, "needle", &opts(), &walk_roots, Some(&walk_flag))
        });
        // Cancel a tenth of the way into the walk we just MEASURED, rather than after a
        // pinned number of milliseconds: a hard-coded delay is a flake waiting for a
        // faster machine (this test caught itself at 28ms against a 30ms floor).
        std::thread::sleep((uncancelled / 10).max(Duration::from_millis(1)));
        flag.store(true, Ordering::Relaxed);
        let err = walker.join().expect("walk thread").unwrap_err();
        let cancelled_in = started.elapsed();

        assert_eq!(err, CANCELLED);
        // The CEILING: it stopped where the cancel landed, not after finishing the tree.
        assert!(
            cancelled_in * 2 < uncancelled,
            "a cancel must cut the walk short: stopped in {cancelled_in:?}, a full walk is \
             {uncancelled:?}"
        );
    }

    /// The scope guard runs BEFORE any walking — pinned by ordering, not by inspection.
    /// The flag is already set, so a guard that had drifted below the walk loop would
    /// answer `cancelled`; the scope error is the proof nothing was walked.
    #[test]
    fn an_out_of_scope_root_is_rejected_before_any_walking() {
        let inside = Tree::new("scope-order-in");
        let outside = Tree::new("scope-order-out");
        outside.write("secret.rs", "");

        let flag = AtomicBool::new(true);
        let err = search_files_cancellable(
            &outside.root,
            "secret",
            &opts(),
            &inside.roots(),
            Some(&flag),
        )
        .unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert_ne!(
            err, CANCELLED,
            "the scope check must run before the walk, not after it"
        );
    }

    /// The registry must never leak a slot: success, error and cancel, through the real
    /// command core. Holds `registry_gate()` because this asserts on the WHOLE registry and
    /// `cargo test` runs the suite as parallel threads in one process.
    #[test]
    fn run_find_files_releases_its_registry_slot_on_success_error_and_cancel() {
        let _gate = crate::find_cancel::registry_gate();
        let rt = rt();
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "gate held: the registry starts clean"
        );

        // 1 — success.
        let t = Tree::new("lifecycle-ok");
        t.write("src/needle.rs", "");
        let ok = rt
            .block_on(run_find_files(
                t.root.to_string_lossy().into_owned(),
                "needle".to_string(),
                opts(),
                t.roots(),
                Some(format!("ok-{}", ulid::Ulid::new())),
            ))
            .unwrap();
        assert_eq!(ok.files.len(), 1, "the command core returns real results");
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "slot released after a successful search"
        );

        // 2 — error. An out-of-scope root, which also pins that the command core still
        // enforces the scope guard after the move onto the blocking pool.
        let outside = Tree::new("lifecycle-outside");
        outside.write("secret.rs", "");
        let err = rt
            .block_on(run_find_files(
                outside.root.to_string_lossy().into_owned(),
                "secret".to_string(),
                opts(),
                t.roots(), // only `t` is allowed
                Some(format!("err-{}", ulid::Ulid::new())),
            ))
            .unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "slot released after an error"
        );

        // 3 — cancel, through the public `find_cancel` entry point.
        let slow = slow_tree("lifecycle-cancel");
        let id = format!("cancel-{}", ulid::Ulid::new());
        let key = id.clone();
        // Spins until the search has registered its slot, then flags it. Deterministic:
        // `run_find_files` registers BEFORE it starts walking.
        let canceller = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if crate::find_cancel::cancel(&key) {
                    return true;
                }
                std::thread::yield_now();
            }
            false
        });
        let err = rt
            .block_on(run_find_files(
                slow.root.to_string_lossy().into_owned(),
                "needle".to_string(),
                opts(),
                slow.roots(),
                Some(id),
            ))
            .unwrap_err();
        assert!(
            canceller.join().expect("canceller thread"),
            "find_cancel must find a live slot for a running search"
        );
        assert_eq!(err, CANCELLED);
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "slot released after a cancel"
        );
    }

    /// Back-compat: a caller that mints no `searchId` still gets a working search.
    #[test]
    fn run_find_files_without_a_search_id_still_searches() {
        let _gate = crate::find_cancel::registry_gate();
        let t = Tree::new("no-id");
        t.write("src/needle.rs", "");

        let r = rt()
            .block_on(run_find_files(
                t.root.to_string_lossy().into_owned(),
                "needle".to_string(),
                opts(),
                t.roots(),
                None,
            ))
            .unwrap();
        assert_eq!(r.files.len(), 1, "no searchId must not mean no search");
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "an anonymous search registers nothing"
        );
    }
}
