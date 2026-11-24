//! Project-wide "Find in Files" (Cmd+Shift+F).
//!
//! The **ripgrep libraries, in-process** — never shelling out to `rg`.
//! [`crate::find_walk`] walks the tree (ignore rules prune DIRECTORIES, they do
//! not hide files — so a gitignored `.env` is searched); `grep-regex` builds
//! the matcher (literal or regex, case, whole-word); `grep-searcher` does the
//! line-oriented, binary-aware search. Confined to the workspace/recent roots by the
//! shared [`crate::fs_tree::resolve_in_scope`] guard, and capped so a broad query
//! can't flood the UI/IPC.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::{Override, OverrideBuilder};

use crate::find_cancel::{is_cancelled, CANCELLED};
use crate::model::{FindOptions, FindResult, Match};

/// Hard caps so a broad query cannot flood the IPC channel / UI. On hit, the result
/// is `truncated: true`.
///
/// 🔴 **These bound the OUTPUT, not the WORK.** They stop a broad query flooding the
/// wire; they are not a time bound and never were. A query with *zero* matches walks
/// and greps the entire tree at full cost and returns instantly-empty — which is
/// exactly the case a typing user hits on every keystroke. That is what the
/// cancellation below is for.
const MAX_MATCHES: usize = 1000;
const MAX_FILES: usize = 500;

/// Search `root` for `query` under `options`, confined to `allowed_roots`.
///
/// Testable core (explicit roots, no `AppHandle`). Errors: out-of-scope / nonexistent
/// root, a non-directory root, or an invalid regex.
///
/// The uncancellable entry point, signature unchanged, so the suite below proves the walk
/// directly. `#[cfg(test)]` because the product always goes through
/// [`search_cancellable`]; the app never ships an uncancellable search.
#[cfg(test)]
fn search(
    root: &Path,
    query: &str,
    options: &FindOptions,
    allowed_roots: &[PathBuf],
) -> Result<FindResult, String> {
    search_cancellable(root, query, options, allowed_roots, None)
}

/// [`search`], plus a flag that stops the walk early.
///
/// `cancel` is `None` for a search nobody can cancel (the back-compat path, and every
/// existing test). When it is `Some`, the flag is polled **once per directory entry**
/// at the top of the walk loop, and once per matched line inside
/// [`CancellableSink`] — see those two sites for what that means for latency.
///
/// The scope guard runs FIRST, before the matcher, the walker or a single `readdir`:
/// an out-of-scope root is refused without the process ever touching it.
fn search_cancellable(
    root: &Path,
    query: &str,
    options: &FindOptions,
    allowed_roots: &[PathBuf],
    cancel: Option<&AtomicBool>,
) -> Result<FindResult, String> {
    let real = crate::fs_tree::resolve_in_scope(root, allowed_roots)?;
    if !real.is_dir() {
        return Err("path is not a directory".to_string());
    }

    // An empty query would match every position in every file — useless and a flood.
    if query.is_empty() {
        return Ok(FindResult {
            matches: Vec::new(),
            truncated: false,
        });
    }

    let matcher = build_matcher(query, options)?;
    let overrides = build_overrides(&real, options)?;
    let mut searcher = SearcherBuilder::new()
        // A NUL byte marks a binary file: stop searching it (ripgrep's default).
        .binary_detection(BinaryDetection::quit(0))
        .line_number(true)
        .build();

    let mut matches: Vec<Match> = Vec::new();
    let mut truncated = false;
    let mut distinct_files = 0usize;

    // Ignore rules prune directories; they do not hide files (see `find_walk`), so
    // a gitignored `.env` is searchable while `node_modules/` stays pruned.
    for path in crate::find_walk::walk_files(&real, Some(overrides)) {
        // 🔴 The cancellation point. One poll per file: a relaxed atomic load
        // is a plain register read, so it costs nothing measurable even on a 100k-entry
        // tree, and a cancel lands within ONE file's search rather than at the end of the
        // walk. (A single enormous file is handled inside `CancellableSink` below, which
        // aborts mid-file and lets the next iteration turn that into the error.)
        if is_cancelled(cancel) {
            return Err(CANCELLED.to_string());
        }

        let rel = path
            .strip_prefix(&real)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();

        let before = matches.len();
        {
            let mut sink = CancellableSink {
                inner: MatchSink {
                    matcher: &matcher,
                    file: rel,
                    out: &mut matches,
                    cap: MAX_MATCHES,
                },
                cancel,
            };
            // A per-file search error (e.g. an unreadable file) skips the file, never
            // fails the whole query.
            let _ = searcher.search_path(&matcher, &path, &mut sink);
        }

        if matches.len() > before {
            distinct_files += 1;
            if distinct_files > MAX_FILES {
                matches.truncate(before); // over the file cap: drop this file's hits
                truncated = true;
                break;
            }
        }
        if matches.len() >= MAX_MATCHES {
            matches.truncate(MAX_MATCHES);
            truncated = true;
            break;
        }
    }

    Ok(FindResult { matches, truncated })
}

/// Build the regex matcher from the query + options. Literal search escapes the
/// query so metacharacters are matched verbatim.
fn build_matcher(query: &str, options: &FindOptions) -> Result<RegexMatcher, String> {
    let pattern = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|e| format!("invalid regex: {e}"))
}

/// Build the caller's glob mask (`--glob`), which [`crate::find_walk::walk_files`]
/// applies to the files it yields.
///
/// The walk itself lives in `find_walk` and is shared with the filename search, so
/// "which files does a search see" has ONE answer for both — it used to have two,
/// and both of them hid `.env`.
fn build_overrides(root: &Path, options: &FindOptions) -> Result<Override, String> {
    let mut overrides = OverrideBuilder::new(root);
    if let Some(glob) = &options.glob {
        overrides
            .add(glob)
            .map_err(|e| format!("invalid glob: {e}"))?;
    }
    overrides.build().map_err(|e| format!("invalid glob: {e}"))
}

/// Collects one [`Match`] per matching line into a shared buffer, stopping the file's
/// search once the global cap is reached.
struct MatchSink<'a> {
    matcher: &'a RegexMatcher,
    file: String,
    out: &'a mut Vec<Match>,
    cap: usize,
}

impl Sink for MatchSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch) -> Result<bool, Self::Error> {
        let bytes = mat.bytes();
        // Re-find the span within the line with the SAME matcher (same case/word
        // flags), for an accurate column + offsets. Infallible for a regex matcher.
        if let Ok(Some(m)) = self.matcher.find(bytes) {
            let text = String::from_utf8_lossy(bytes);
            let line_text = text.trim_end_matches(['\r', '\n']).to_string();
            self.out.push(Match {
                file: self.file.clone(),
                line: mat.line_number().unwrap_or(0) as u32,
                col: (m.start() as u32) + 1,
                line_text,
                match_start: m.start() as u32,
                match_end: m.end() as u32,
            });
        }
        // Stop this file once the whole result is at the cap; the caller truncates.
        Ok(self.out.len() < self.cap)
    }
}

/// [`MatchSink`] with a cancellation poll in front of it.
///
/// **Why this is a wrapper and not a field on `MatchSink`.** The per-entry poll in the
/// walk loop is not enough on its own: one minified bundle or one giant log file can hold
/// `search_path` for seconds inside a *single* entry, which is exactly the file a user
/// most wants to escape. Polling per matched line makes a cancel land inside that file.
/// It is a separate type so `MatchSink`'s own contract (and the test that pins its
/// off-by-one on `cap`) is untouched.
///
/// **Known limit, stated plainly:** `grep_searcher::Sink` has no "still scanning" callback,
/// so a huge file with **no** matches offers nowhere to poll — a cancel on that file still
/// waits for it to finish. Matching files abort at the first line after the flag is set.
struct CancellableSink<'a, 'c> {
    inner: MatchSink<'a>,
    cancel: Option<&'c AtomicBool>,
}

impl Sink for CancellableSink<'_, '_> {
    type Error = std::io::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch) -> Result<bool, Self::Error> {
        if is_cancelled(self.cancel) {
            // Stop this file. The walk loop's next iteration sees the same flag and
            // returns `CANCELLED`; nothing here needs to know how that is reported.
            return Ok(false);
        }
        self.inner.matched(searcher, mat)
    }
}

/// Search the workspace file tree for `query`.
///
/// Frontend contract:
/// `invoke<FindResult>('find_in_files', { root, query, options, searchId })`.
/// `root` must be inside an allowed workspace root (same scope as `read_dir`).
/// Out-of-scope / non-directory root → `Err`; an invalid regex → `Err(<message>)`
/// the FE shows inline; a search cancelled via `find_cancel` → `Err("cancelled")`, which
/// the FE drops silently.
///
/// `searchId` is **optional**: a caller that omits it gets an ordinary, uncancellable
/// search rather than an error.
///
/// 🔴 **`async` is load-bearing.** As a sync command this ran inline on the thread
/// processing the IPC message and froze the entire window — see `find_cancel`'s module
/// doc. `async` alone would only move the stall onto a tokio worker, so the walk goes to
/// the blocking pool.
#[tauri::command]
pub async fn find_in_files(
    app: tauri::AppHandle,
    root: String,
    query: String,
    options: FindOptions,
    search_id: Option<String>,
) -> Result<FindResult, String> {
    // Resolved here, on the async side, and moved in: the scope is server-authoritative
    // and the check is not skippable. This body already runs off the
    // event-loop thread, so reading the recents store costs the UI nothing.
    let allowed_roots = crate::fs_tree::allowed_roots(&app);
    run_find(root, query, options, allowed_roots, search_id).await
}

/// The `AppHandle`-free core of [`find_in_files`] — registry glue plus the hop onto the
/// blocking pool, so a test can drive the real command path without standing up an app.
///
/// Mirrors `portability::blocking` (private there, and typed to that module's error, so it
/// cannot be reused directly) and `metrics::claude_metrics`: `async` command → the work on
/// `tokio::task::spawn_blocking`. Not a third pattern — the same one, finally applied here.
pub(crate) async fn run_find(
    root: String,
    query: String,
    options: FindOptions,
    allowed_roots: Vec<PathBuf>,
    search_id: Option<String>,
) -> Result<FindResult, String> {
    // Registered BEFORE the work starts, so a `find_cancel` arriving a millisecond later
    // already has something to flag.
    let handle = crate::find_cancel::begin(search_id);
    let flag = handle.flag();
    let done = tokio::task::spawn_blocking(move || {
        search_cancellable(
            Path::new(&root),
            &query,
            &options,
            &allowed_roots,
            Some(flag.as_ref()),
        )
    })
    .await;
    // `handle` drops at the end of this scope on EVERY path — Ok, Err, cancel, or a
    // dropped future — which is what guarantees the registry never leaks a slot.
    match done {
        Ok(result) => result,
        Err(e) => Err(format!("search task failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A self-cleaning temp tree with a couple of files to search.
    struct Tree {
        root: PathBuf,
    }

    impl Tree {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("agentstudio-find-{label}-{}", ulid::Ulid::new()));
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
        fn write_bytes(&self, rel: &str, content: &[u8]) {
            std::fs::write(self.root.join(rel), content).unwrap();
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

    fn opts() -> FindOptions {
        FindOptions::default()
    }

    #[test]
    fn literal_match_reports_file_line_col_and_span() {
        let t = Tree::new("literal");
        t.write("a.txt", "hello world\nsecond needle line\n");
        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();

        assert_eq!(r.matches.len(), 1);
        let m = &r.matches[0];
        assert_eq!(m.file, "a.txt");
        assert_eq!(m.line, 2);
        assert_eq!(m.col, 8); // "second " = 7 bytes, needle starts at col 8
        assert_eq!(m.line_text, "second needle line");
        assert_eq!(m.match_start, 7);
        assert_eq!(m.match_end, 13);
        assert!(!r.truncated);
    }

    #[test]
    fn literal_search_treats_regex_metacharacters_verbatim() {
        let t = Tree::new("meta");
        t.write("a.txt", "a.b matches\naxb should not\n");
        // As a literal, "a.b" must match "a.b", NOT "axb" (which `.` would match).
        let r = search(&t.root, "a.b", &opts(), &t.roots()).unwrap();
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].line, 1);
    }

    #[test]
    fn regex_search_matches_a_pattern() {
        let t = Tree::new("regex");
        t.write("a.txt", "fn one() {}\nfn two() {}\nlet x = 1;\n");
        let o = FindOptions {
            regex: true,
            ..opts()
        };
        let r = search(&t.root, r"fn \w+\(\)", &o, &t.roots()).unwrap();
        assert_eq!(r.matches.len(), 2);
        assert_eq!(r.matches[0].line, 1);
        assert_eq!(r.matches[1].line, 2);
    }

    #[test]
    fn case_sensitivity_toggles() {
        let t = Tree::new("case");
        t.write("a.txt", "Needle\nneedle\nNEEDLE\n");

        // Default: case-insensitive → all three.
        let ci = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        assert_eq!(ci.matches.len(), 3);

        // Case-sensitive → only the exact-case line.
        let cs = FindOptions {
            case_sensitive: true,
            ..opts()
        };
        let r = search(&t.root, "needle", &cs, &t.roots()).unwrap();
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].line, 2);
    }

    #[test]
    fn whole_word_respects_boundaries() {
        let t = Tree::new("word");
        t.write("a.txt", "foo\nfoobar\nbarfoo\na foo b\n");
        let o = FindOptions {
            whole_word: true,
            ..opts()
        };
        let r = search(&t.root, "foo", &o, &t.roots()).unwrap();
        // "foo" (l1) and " foo " (l4) — NOT "foobar" or "barfoo".
        let lines: Vec<u32> = r.matches.iter().map(|m| m.line).collect();
        assert_eq!(lines, vec![1, 4]);
    }

    #[test]
    fn glob_filters_the_file_set() {
        let t = Tree::new("glob");
        t.write("keep.rs", "let needle = 1;\n");
        t.write("skip.txt", "needle here too\n");
        let o = FindOptions {
            glob: Some("*.rs".to_string()),
            ..opts()
        };
        let r = search(&t.root, "needle", &o, &t.roots()).unwrap();
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].file, "keep.rs");
    }

    /// The SECOND symptom: with `.env` open in a tab, Find in
    /// Files for a phrase plainly visible in it answered *"No matches"*. Same root
    /// cause as the quick-open one — the file was never enumerated — which is why
    /// both searches now share `find_walk`. A phrase, not a word, because that is
    /// what was typed.
    #[test]
    fn a_phrase_inside_a_gitignored_dotenv_is_found() {
        let t = Tree::new("dotenv-phrase");
        t.write(".gitignore", ".env\n");
        t.write(
            ".env",
            "# every other value - behind your back. To escape an inherited\n",
        );

        let r = search(&t.root, "behind your back", &opts(), &t.roots()).unwrap();
        let files: Vec<&str> = r.matches.iter().map(|m| m.file.as_str()).collect();
        assert_eq!(files, vec![".env"], "got {files:?}");
    }

    /// ⚠️ The contract CHANGED (search was ignoring `.env` files). `.gitignore` prunes
    /// **directories**; it no longer hides **files**. This test used to assert
    /// `["kept.txt"]` — that expectation was the bug, not the guard, because a
    /// gitignored `.env` is exactly the file people search for. See `find_walk`'s module docs.
    #[test]
    fn gitignore_prunes_directories_but_no_longer_hides_files() {
        let t = Tree::new("ignore");
        t.write(".gitignore", "ignored/\n*.log\n.env\n");
        t.write("kept.txt", "needle\n");
        t.write("noisy.log", "needle\n");
        t.write(".env", "needle\n");
        t.write("ignored/deep.txt", "needle\n");

        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        let files: Vec<&str> = r.matches.iter().map(|m| m.file.as_str()).collect();

        // Two-sided. The half that changed: ignored FILES — hidden
        // or not — are searched now.
        assert!(
            files.contains(&".env"),
            "the gitignored dotfile: got {files:?}"
        );
        assert!(files.contains(&"noisy.log"), "got {files:?}");
        assert!(files.contains(&"kept.txt"), "got {files:?}");
        // The half that must NOT change: an ignored DIRECTORY is still pruned.
        // Without this, the fix trades "cannot find .env" for "every search drags
        // node_modules behind it", which is the worse problem.
        assert!(
            !files.iter().any(|f| f.starts_with("ignored/")),
            "ignored directories must still be pruned: got {files:?}"
        );
    }

    #[test]
    fn binary_files_are_skipped() {
        let t = Tree::new("binary");
        // A NUL early in the file marks it binary; the match after it is not reported.
        t.write_bytes("blob.bin", b"\x00\x00needle after nul\n");
        t.write("text.txt", "needle in text\n");

        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        let files: Vec<&str> = r.matches.iter().map(|m| m.file.as_str()).collect();
        assert_eq!(files, vec!["text.txt"], "the binary file must be skipped");
    }

    #[test]
    fn an_out_of_scope_root_is_rejected() {
        let inside = Tree::new("scope-in");
        let outside = Tree::new("scope-out");
        outside.write("secret.txt", "needle\n");
        // `outside` is not under the only allowed root (`inside`).
        let err = search(&outside.root, "needle", &opts(), &inside.roots()).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    #[test]
    fn an_invalid_regex_is_an_error() {
        let t = Tree::new("badre");
        t.write("a.txt", "x\n");
        let o = FindOptions {
            regex: true,
            ..opts()
        };
        let err = search(&t.root, "(unclosed", &o, &t.roots()).unwrap_err();
        assert!(err.contains("invalid regex"), "got: {err}");
    }

    #[test]
    fn an_empty_query_returns_nothing() {
        let t = Tree::new("empty");
        t.write("a.txt", "content\n");
        let r = search(&t.root, "", &opts(), &t.roots()).unwrap();
        assert!(r.matches.is_empty());
        assert!(!r.truncated);
    }

    #[test]
    fn results_are_capped_and_flagged_truncated() {
        let t = Tree::new("cap");
        // One file, far more than MAX_MATCHES matching lines.
        let body = "needle\n".repeat(MAX_MATCHES + 250);
        t.write("big.txt", &body);

        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        assert_eq!(r.matches.len(), MAX_MATCHES, "must cap at MAX_MATCHES");
        assert!(r.truncated, "must flag truncation when capped");
    }

    #[test]
    fn a_clean_search_is_not_truncated() {
        let t = Tree::new("clean");
        t.write("a.txt", "needle\nneedle\n");
        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        assert_eq!(r.matches.len(), 2);
        assert!(!r.truncated);
    }

    // ---- file-flood cap (MAX_FILES) ---------------------------------------
    // These pin the distinct-file counter path (find.rs lines 85-87), which had
    // ZERO coverage: `matches.len() > before`, `distinct_files += 1`, and
    // `distinct_files > MAX_FILES`. Each fixture writes one match per file so the
    // MAX_MATCHES cap (1000) never fires first (MAX_FILES = 500 < 1000).

    #[test]
    fn file_cap_not_triggered_at_exactly_max_files() {
        // Boundary: EXACTLY MAX_FILES matching files must NOT trip the cap.
        // Kills `distinct_files > MAX_FILES` -> `==` / `>=` (both would truncate
        // the 500th file here, yielding 499 matches + truncated).
        let t = Tree::new("filecap-eq");
        for i in 0..MAX_FILES {
            t.write(&format!("f{i:04}.txt"), "needle\n");
        }
        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        assert_eq!(
            r.matches.len(),
            MAX_FILES,
            "at exactly MAX_FILES every matching file's hit is kept"
        );
        assert!(
            !r.truncated,
            "at exactly MAX_FILES the file cap must NOT fire"
        );
    }

    #[test]
    fn file_cap_triggers_past_max_files() {
        // Boundary: MAX_FILES + 1 matching files must trip the cap. The extra
        // file's hits are dropped and `truncated` fires. Kills:
        //   - `distinct_files += 1` -> `*= 1` (pins counter at 0, cap never fires),
        //   - `matches.len() > before` -> `==` / `<` (counter never increments),
        //   - `distinct_files > MAX_FILES` -> `==` / `>=` (would drop the 500th file
        //     too, leaving 499 matches).
        let t = Tree::new("filecap-over");
        for i in 0..(MAX_FILES + 1) {
            t.write(&format!("f{i:04}.txt"), "needle\n");
        }
        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        assert_eq!(
            r.matches.len(),
            MAX_FILES,
            "over the file cap: exactly MAX_FILES files' hits are kept, the extra dropped"
        );
        assert!(
            r.truncated,
            "more than MAX_FILES distinct matching files must flag truncation"
        );
    }

    #[test]
    fn file_counter_only_counts_matching_files() {
        // Distinguishes `matches.len() > before` from the `>=` mutant: `>=` counts
        // EVERY walked file (even ones that add no match) toward the file cap. Here
        // MAX_FILES matching files + 1 non-matching file = MAX_FILES + 1 files
        // walked, but only MAX_FILES match, so the correct `>` guard must NOT
        // truncate. Under `>=` the non-matching file pushes the counter to
        // MAX_FILES + 1 and `truncated` wrongly fires.
        let t = Tree::new("filecap-nonmatch");
        for i in 0..MAX_FILES {
            t.write(&format!("f{i:04}.txt"), "needle\n");
        }
        t.write("zzz-no-match.txt", "nothing to see here\n");
        let r = search(&t.root, "needle", &opts(), &t.roots()).unwrap();
        assert_eq!(
            r.matches.len(),
            MAX_FILES,
            "only matching files count toward the file cap"
        );
        assert!(
            !r.truncated,
            "a non-matching file must not push the distinct-file counter over the cap"
        );
    }

    // ---- match cap off-by-one (MatchSink) ---------------------------------

    #[test]
    fn match_sink_stops_at_exactly_cap() {
        // Pins the off-by-one in `Ok(self.out.len() < self.cap)` (find.rs:171): the
        // `<=` mutant lets one extra match through (cap + 1) before stopping.
        // Exercised on MatchSink directly with a tiny cap, so the caller's
        // MAX_MATCHES safety-truncate cannot mask the extra push.
        let matcher = build_matcher("needle", &opts()).unwrap();
        let mut searcher = SearcherBuilder::new().line_number(true).build();
        let body = "needle\n".repeat(5);
        let mut out: Vec<Match> = Vec::new();
        {
            let mut sink = MatchSink {
                matcher: &matcher,
                file: "x.txt".to_string(),
                out: &mut out,
                cap: 3,
            };
            searcher
                .search_slice(&matcher, body.as_bytes(), &mut sink)
                .unwrap();
        }
        assert_eq!(
            out.len(),
            3,
            "MatchSink must stop at EXACTLY cap matches, not cap + 1"
        );
    }

    // ---- cancellation -----------------------------------------------------
    // A long-running search used to freeze the whole program; it now runs in
    // parallel so that it can be cancelled. These
    // pin the kill half; the freeze half is the `async` + `spawn_blocking` signature of
    // `find_in_files`, which the type system enforces.

    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Files of noise in the slow fixture. Sized so a full walk takes clearly more time
    /// than the few milliseconds a cancel needs to land — if a future machine makes this
    /// fixture too fast, the floor assertion below says so out loud rather than going
    /// quietly green.
    const SLOW_TREE_FILES: usize = 2500;
    /// How many files in the slow fixture actually contain the needle. Far under
    /// `MAX_FILES`, so the cap never truncates and "real results" is an exact number.
    const SLOW_TREE_HITS: usize = 5;

    /// A tree big enough that walking + grepping it takes measurable time.
    fn slow_tree(label: &str) -> Tree {
        let t = Tree::new(label);
        // ~1 KB of non-matching text per file, spread over 50 directories so the walk
        // pays real `readdir` costs and not just one huge directory listing.
        let noise = "the quick brown fox jumps over the lazy dog\n".repeat(24);
        for i in 0..SLOW_TREE_FILES {
            t.write(&format!("d{:02}/f{i:05}.txt", i % 50), &noise);
        }
        for i in 0..SLOW_TREE_HITS {
            t.write(&format!("hit{i}.txt"), "a needle in here\n");
        }
        t
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("tokio runtime")
    }

    /// Two-sided: the same search, same tree, cancelled and not.
    ///
    /// The un-cancelled half is what makes the cancelled half mean anything — without it
    /// this test also passes against a search that is simply broken and returns nothing.
    #[test]
    fn a_set_cancel_flag_stops_the_walk_and_a_clear_one_does_not() {
        let t = slow_tree("cancel-preset");
        let roots = t.roots();
        let flag = AtomicBool::new(false);

        // Clear flag → the real result set.
        let ok = search_cancellable(&t.root, "needle", &opts(), &roots, Some(&flag)).unwrap();
        assert_eq!(
            ok.matches.len(),
            SLOW_TREE_HITS,
            "an un-cancelled search must return real results"
        );
        assert!(!ok.truncated);

        // Set flag → the walk aborts on its very first entry.
        flag.store(true, Ordering::Relaxed);
        let err = search_cancellable(&t.root, "needle", &opts(), &roots, Some(&flag)).unwrap_err();
        assert_eq!(
            err, CANCELLED,
            "a cancelled search must return the bare `cancelled` sentinel"
        );
    }

    /// The real shape of the bug: a walk already in flight, cancelled from another
    /// thread — which is what `find_cancel` does from the main thread while the walk sits
    /// on the blocking pool.
    #[test]
    fn a_cancel_from_another_thread_cuts_a_running_walk_short() {
        let t = slow_tree("cancel-live");
        let roots = t.roots();

        // Warm the file cache first, so the measured walk and the cancelled one cost the
        // same per file. On Windows the FIRST read of a just-written file pays for the
        // antivirus on-access scan: the cold measured walk was many times slower than the
        // warm cancelled one, so a cancel timed at a tenth of the COLD walk landed after the
        // warm walk had already finished (seen natively on Windows 11).
        // `find_files` walks names only and never reads content, so it has no such gap.
        search(&t.root, "needle", &opts(), &roots).unwrap();

        // The FLOOR: prove this fixture actually takes time, on this machine, in
        // this moment — otherwise "it came back early" is trivially true and proves
        // nothing. Doubles as the two-sided half: un-cancelled, every needle is found.
        let started = Instant::now();
        let full = search(&t.root, "needle", &opts(), &roots).unwrap();
        let uncancelled = started.elapsed();
        assert_eq!(full.matches.len(), SLOW_TREE_HITS);
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
            search_cancellable(&root, "needle", &opts(), &walk_roots, Some(&walk_flag))
        });
        // Cancel a tenth of the way into the walk we just MEASURED, rather than after a
        // pinned number of milliseconds: a hard-coded delay is a flake waiting for a
        // faster machine (the sibling test in `find_files` caught itself at 28ms against
        // a 30ms floor).
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

    /// The per-matched-line poll, which is what stops a cancel appearing to hang on one
    /// enormous file. Driven on the sink directly, exactly like the cap test above, so a
    /// whole-tree walk cannot mask it.
    #[test]
    fn the_sink_stops_a_files_search_once_the_flag_is_set() {
        let matcher = build_matcher("needle", &opts()).unwrap();
        let body = "needle\n".repeat(5);

        let collect = |cancelled: bool| -> Vec<Match> {
            let flag = AtomicBool::new(cancelled);
            let mut searcher = SearcherBuilder::new().line_number(true).build();
            let mut out: Vec<Match> = Vec::new();
            {
                let mut sink = CancellableSink {
                    inner: MatchSink {
                        matcher: &matcher,
                        file: "big.min.js".to_string(),
                        out: &mut out,
                        cap: MAX_MATCHES,
                    },
                    cancel: Some(&flag),
                };
                searcher
                    .search_slice(&matcher, body.as_bytes(), &mut sink)
                    .unwrap();
            }
            out
        };

        // Two-sided: clear flag → the whole file is searched...
        assert_eq!(
            collect(false).len(),
            5,
            "un-cancelled: every match is collected"
        );
        // ...set flag → not one more line is taken from this file.
        assert!(
            collect(true).is_empty(),
            "cancelled: the sink must stop the file, not wait for it to end"
        );
    }

    /// The scope guard runs BEFORE any walking — pinned by ordering, not by inspection.
    ///
    /// The cancel flag is already set, so if `resolve_in_scope` had drifted to *after* the
    /// walk loop the first thing this search would meet is the cancellation point and the
    /// error would be `cancelled`. Getting the scope error instead is the proof that
    /// nothing was walked (the scope is server-authoritative and unskippable).
    #[test]
    fn an_out_of_scope_root_is_rejected_before_any_walking() {
        let inside = Tree::new("scope-order-in");
        let outside = Tree::new("scope-order-out");
        outside.write("secret.txt", "needle\n");

        let flag = AtomicBool::new(true);
        let err = search_cancellable(
            &outside.root,
            "needle",
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

    /// The registry must never leak a slot — one leaked flag per keystroke is a slow
    /// memory leak in the most-typed-in surface of the app. Success, error and cancel, all
    /// through the real command core.
    ///
    /// Holds `registry_gate()` because `cargo test` runs the suite as parallel threads in
    /// one process and this asserts on the WHOLE registry (see `find_cancel`).
    #[test]
    fn run_find_releases_its_registry_slot_on_success_error_and_cancel() {
        let _gate = crate::find_cancel::registry_gate();
        let rt = rt();
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "gate held: the registry starts clean"
        );

        // 1 — success.
        let t = Tree::new("lifecycle-ok");
        t.write("a.txt", "hello needle\n");
        let ok = rt
            .block_on(run_find(
                t.root.to_string_lossy().into_owned(),
                "needle".to_string(),
                opts(),
                t.roots(),
                Some(format!("ok-{}", ulid::Ulid::new())),
            ))
            .unwrap();
        assert_eq!(ok.matches.len(), 1, "the command core returns real results");
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "slot released after a successful search"
        );

        // 2 — error. An out-of-scope root, so this also pins that the command core still
        // enforces the scope guard after the move onto the blocking pool.
        let outside = Tree::new("lifecycle-outside");
        outside.write("secret.txt", "needle\n");
        let err = rt
            .block_on(run_find(
                outside.root.to_string_lossy().into_owned(),
                "needle".to_string(),
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
        // `run_find` registers BEFORE it starts walking, so this cannot miss the window —
        // and if it wins the race outright the flag is simply already set when the walk
        // begins, which is the same outcome.
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
            .block_on(run_find(
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

    /// Back-compat: a caller that mints no `searchId` still gets a working search — it is
    /// simply uncancellable, and registers nothing.
    #[test]
    fn run_find_without_a_search_id_still_searches() {
        let _gate = crate::find_cancel::registry_gate();
        let t = Tree::new("no-id");
        t.write("a.txt", "hello needle\n");

        let r = rt()
            .block_on(run_find(
                t.root.to_string_lossy().into_owned(),
                "needle".to_string(),
                opts(),
                t.roots(),
                None,
            ))
            .unwrap();
        assert_eq!(r.matches.len(), 1, "no searchId must not mean no search");
        assert_eq!(
            crate::find_cancel::live_count(),
            0,
            "an anonymous search registers nothing"
        );
    }
}
