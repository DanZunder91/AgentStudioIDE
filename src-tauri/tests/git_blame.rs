//! `git_blame::blame_scoped` — per-line authorship for the editor gutter.
//!
//! Built against **real repositories constructed with `git2` itself** (init,
//! explicit signatures, commits) — never by shelling out to `git` (a CI runner may
//! not have it; the zero-install principle applies to tests too). Every commit is
//! made with an explicit `Signature` + epoch time, so the wire fields (`author`,
//! `email`, `timeMs`, `summary`, `message`) are asserted against exact values.
//!
//! The scope guard is exercised through the same explicit-roots pattern as
//! `fs_tree`'s tests: `blame_scoped(path, roots)` with a canonicalized temp root.

use std::path::{Path, PathBuf};

use agent_studio_scaffold_lib::git_blame::blame_scoped;

/// A throwaway directory that cleans itself up.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let p =
            std::env::temp_dir().join(format!("agentstudio-blame-{label}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&p).expect("mkdir");
        // Resolve symlinks (macOS /tmp → /private/tmp) so the root we authorize is
        // the same canonical path `resolve_in_scope` compares against.
        Self(agent_studio_scaffold_lib::paths::canonicalize(&p).unwrap_or(p))
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn roots(&self) -> Vec<PathBuf> {
        vec![self.0.clone()]
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Write `content` to `rel` inside the repo's workdir, stage it, and commit it
/// with an exact author (`name`/`email`) and an exact epoch time in seconds.
/// Returns the new commit's full hex id.
fn commit_file(
    repo: &git2::Repository,
    rel: &str,
    content: &str,
    name: &str,
    email: &str,
    time_secs: i64,
    message: &str,
) -> String {
    let workdir = repo.workdir().expect("test repos have a workdir");
    let abs = workdir.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&abs, content).unwrap();

    let mut index = repo.index().unwrap();
    index.add_path(Path::new(rel)).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();

    // Offset 0 keeps the expected `timeMs` arithmetic self-evident; the offset is
    // display-only either way (asserted separately below).
    let sig = git2::Signature::new(name, email, &git2::Time::new(time_secs, 0)).unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
        .to_string()
}

/// 1. Single-author repo: every line maps to the same (single) commit, and every
///    wire field carries the exact values the commit was made with — including a
///    multi-line message whose first line is the summary.
#[test]
fn single_commit_owns_every_line_with_exact_metadata() {
    let d = TempDir::new("single");
    let repo = git2::Repository::init(d.path()).unwrap();
    let message = "Add greeting\n\nExplain why the greeting exists.\nAnd a second body line.\n";
    let id = commit_file(
        &repo,
        "hello.txt",
        "line one\nline two\nline three\n",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        message,
    );

    let blame = blame_scoped(&d.path().join("hello.txt"), &d.roots()).unwrap();

    // The commit table is deduped to the single commit, with exact metadata.
    assert_eq!(blame.commits.len(), 1, "one commit, one table entry");
    let c = &blame.commits[0];
    assert_eq!(c.id, id);
    assert_eq!(c.id.len(), 40, "full 40-char hex id, not abbreviated");
    assert!(c.id.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_eq!(c.author, "Ada Lovelace");
    assert_eq!(c.email, "ada@example.com");
    assert_eq!(c.time_ms, 1_700_000_000_000, "epoch seconds → epoch ms");
    assert_eq!(c.summary, "Add greeting", "summary = first message line");
    assert_eq!(c.message, message, "message = the FULL commit message");

    // Every line points at that commit.
    assert_eq!(blame.lines, vec![Some(0), Some(0), Some(0)]);
}

/// `timeMs` is the UTC epoch instant: git stores author time as UTC epoch seconds
/// plus a *display-only* timezone offset, so a nonzero offset must NOT shift the
/// wire value.
#[test]
fn timezone_offset_does_not_shift_time_ms() {
    let d = TempDir::new("tz");
    let repo = git2::Repository::init(d.path()).unwrap();
    let workdir = repo.workdir().unwrap().to_path_buf();
    std::fs::write(workdir.join("f.txt"), "x\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("f.txt")).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    // +02:00 (120 minutes): the epoch instant is still 1_700_000_000.
    let sig =
        git2::Signature::new("Tz", "tz@example.com", &git2::Time::new(1_700_000_000, 120)).unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "tz", &tree, &[])
        .unwrap();

    let blame = blame_scoped(&d.path().join("f.txt"), &d.roots()).unwrap();
    assert_eq!(blame.commits[0].time_ms, 1_700_000_000_000);
}

/// 2. Two commits touching different lines: each line maps to the commit that
///    wrote it, and the commit table is DEDUPED (2 entries, not one per line).
#[test]
fn two_commits_map_lines_correctly_and_the_table_is_deduped() {
    let d = TempDir::new("two");
    let repo = git2::Repository::init(d.path()).unwrap();
    let first = commit_file(
        &repo,
        "story.txt",
        "alpha\nbeta\n",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "First two lines",
    );
    let second = commit_file(
        &repo,
        "story.txt",
        "alpha\nbeta\ngamma\n",
        "Grace Hopper",
        "grace@example.com",
        1_700_100_000,
        "Append gamma",
    );

    let blame = blame_scoped(&d.path().join("story.txt"), &d.roots()).unwrap();

    assert_eq!(
        blame.commits.len(),
        2,
        "the commit table must be deduped: 2 commits, not one entry per line"
    );
    assert_eq!(blame.lines.len(), 3);

    // Resolve each line through the table and pin it to the right commit id.
    let id_of = |line: usize| -> &str {
        let idx = blame.lines[line].expect("committed line must be attributed") as usize;
        &blame.commits[idx].id
    };
    assert_eq!(id_of(0), first, "line 1 was written by the first commit");
    assert_eq!(id_of(1), first, "line 2 was written by the first commit");
    assert_eq!(id_of(2), second, "line 3 was written by the second commit");

    // Both lines of the first commit share ONE table entry (the dedup itself).
    assert_eq!(blame.lines[0], blame.lines[1]);
    // And the metadata rides along per unique commit.
    let grace = &blame.commits[blame.lines[2].unwrap() as usize];
    assert_eq!(grace.author, "Grace Hopper");
    assert_eq!(grace.summary, "Append gamma");
}

/// 3a. File modified on disk but NOT staged or committed: blame still succeeds,
///     and the committed lines stay attributed. Pinned actual
///     `git2::blame_file` semantics, honestly measured: with default options
///     (newest commit = HEAD) libgit2 blames **HEAD's content, not the working
///     tree**, so the appended unstaged line simply does not appear in `lines`
///     at all (2 entries, not 3). The dirty-buffer overlay is the frontend's
///     concern.
#[test]
fn an_unstaged_on_disk_edit_is_not_part_of_the_blame() {
    let d = TempDir::new("dirty");
    let repo = git2::Repository::init(d.path()).unwrap();
    let id = commit_file(
        &repo,
        "notes.txt",
        "committed one\ncommitted two\n",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "Committed lines",
    );

    // Append a third line on disk only — no add, no commit.
    let path = d.path().join("notes.txt");
    std::fs::write(&path, "committed one\ncommitted two\nlocal only\n").unwrap();

    let blame = blame_scoped(&path, &d.roots()).unwrap();

    assert_eq!(
        blame.commits.len(),
        1,
        "only the real commit is in the table"
    );
    assert_eq!(blame.commits[0].id, id);
    assert_eq!(
        blame.lines,
        vec![Some(0), Some(0)],
        "blame covers the committed content only; the unstaged line is absent"
    );
}

/// 3b. A STAGED-but-uncommitted line: pinned actual behavior, honestly measured —
///     with default options `git2::blame_file` blames HEAD's content only, so
///     even a *staged* line is absent from `lines` (it does NOT surface as a
///     zero-OID hunk in this mode; the wire's `None` mapping stays defensive for
///     any input libgit2 does mark with the zero OID, per its documentation).
///     Committed lines stay attributed either way.
#[test]
fn a_staged_uncommitted_line_is_not_part_of_the_blame() {
    let d = TempDir::new("staged");
    let repo = git2::Repository::init(d.path()).unwrap();
    let id = commit_file(
        &repo,
        "notes.txt",
        "committed one\ncommitted two\n",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "Committed lines",
    );

    // Append a third line AND stage it — but do not commit.
    let path = d.path().join("notes.txt");
    std::fs::write(&path, "committed one\ncommitted two\nstaged only\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("notes.txt")).unwrap();
    index.write().unwrap();

    let blame = blame_scoped(&path, &d.roots()).unwrap();

    assert_eq!(
        blame.commits.len(),
        1,
        "no phantom commit may enter the table for staged content"
    );
    assert_eq!(blame.commits[0].id, id);
    assert_eq!(
        blame.lines,
        vec![Some(0), Some(0)],
        "blame covers HEAD's content only; the staged-uncommitted line is absent"
    );
}

/// 4. The scope guard: a path outside every allowed root is rejected before any
///    git access — even though it is a perfectly blame-able file in a real repo.
#[test]
fn a_path_outside_the_allowed_roots_is_rejected() {
    let inside = TempDir::new("scope-in");
    let outside = TempDir::new("scope-out");
    let repo = git2::Repository::init(outside.path()).unwrap();
    commit_file(
        &repo,
        "secret.txt",
        "loot\n",
        "Eve",
        "eve@example.com",
        1_700_000_000,
        "secret",
    );

    // Roots authorize only `inside`; the file lives under `outside`.
    let err = blame_scoped(&outside.path().join("secret.txt"), &inside.roots()).unwrap_err();
    assert!(
        err.contains("outside"),
        "expected the fs_tree scope error, got: {err}"
    );
}

/// 5. A file in scope but not inside any repository → a calm, human error the UI
///    shows inline.
#[test]
fn a_file_not_in_a_repository_errors_calmly() {
    let d = TempDir::new("norepo");
    let path = d.path().join("plain.txt");
    std::fs::write(&path, "no repo here\n").unwrap();

    let err = blame_scoped(&path, &d.roots()).unwrap_err();
    assert!(
        err.contains("not in a git repository"),
        "expected the not-a-repo message, got: {err}"
    );
}

/// A nonexistent path and a directory are rejected with the fs_tree-consistent
/// messages (never a panic, never a git error for a non-file).
#[test]
fn nonexistent_paths_and_directories_are_rejected() {
    let d = TempDir::new("notafile");
    let repo = git2::Repository::init(d.path()).unwrap();
    commit_file(
        &repo,
        "sub/f.txt",
        "x\n",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "add",
    );

    let err = blame_scoped(&d.path().join("ghost.txt"), &d.roots()).unwrap_err();
    assert!(err.contains("does not exist"), "got: {err}");

    let err = blame_scoped(&d.path().join("sub"), &d.roots()).unwrap_err();
    assert_eq!(err, "path is not a file");
}

/// 6. `relPath` is repo-relative (what git blames), never absolute — including for
///    a file nested in subdirectories.
#[test]
fn rel_path_is_relative_to_the_repo_root() {
    let d = TempDir::new("relpath");
    let repo = git2::Repository::init(d.path()).unwrap();
    commit_file(
        &repo,
        "src/deep/module.rs",
        "fn main() {}\n",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "add module",
    );

    let blame = blame_scoped(&d.path().join("src/deep/module.rs"), &d.roots()).unwrap();
    assert!(
        !Path::new(&blame.rel_path).is_absolute(),
        "relPath must not be absolute: {}",
        blame.rel_path
    );
    assert_eq!(
        Path::new(&blame.rel_path),
        Path::new("src/deep/module.rs"),
        "relPath is the repo-relative path"
    );
}

/// 7a. An empty committed file blames to an empty `lines` vector (and an empty
///     commit table) — a normal Ok, not an error.
#[test]
fn an_empty_file_yields_empty_lines() {
    let d = TempDir::new("empty");
    let repo = git2::Repository::init(d.path()).unwrap();
    commit_file(
        &repo,
        "empty.txt",
        "",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "add empty file",
    );

    let blame = blame_scoped(&d.path().join("empty.txt"), &d.roots()).unwrap();
    assert_eq!(blame.lines, Vec::<Option<u32>>::new());
    assert!(
        blame.commits.is_empty(),
        "no lines → no commits in the table"
    );
    assert_eq!(Path::new(&blame.rel_path), Path::new("empty.txt"));
}

/// 7b. A single-line file (no trailing newline — the harder edge) blames to
///     exactly one attributed line.
#[test]
fn a_single_line_file_blames_that_one_line() {
    let d = TempDir::new("oneline");
    let repo = git2::Repository::init(d.path()).unwrap();
    let id = commit_file(
        &repo,
        "one.txt",
        "the only line", // deliberately no trailing newline
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "one line",
    );

    let blame = blame_scoped(&d.path().join("one.txt"), &d.roots()).unwrap();
    assert_eq!(blame.lines, vec![Some(0)]);
    assert_eq!(blame.commits.len(), 1);
    assert_eq!(blame.commits[0].id, id);
}

/// 8. **RUSTSEC-2026-0184 regression gate** (the reason we require `git2 >= 0.21`).
///
/// Under git2 0.20 a `BlameHunk` obtained from a `blame_buffer()`-created `Blame`
/// could carry NULL author/committer pointers, and `final_signature()` /
/// `orig_signature()` built a `Signature` over them unconditionally — dereferencing
/// null (UB). 0.21 makes all four accessors return `Option<Signature>` and
/// null-checks the pointer first.
///
/// `blame_scoped` uses `blame_file`, so production code is not on that path *today* —
/// but the dirty-buffer overlay contemplated in `git_blame.rs`'s docs would be, so
/// this test walks the exact advisory surface: it creates a `Blame` via
/// `blame_buffer` and calls **every** signature accessor on **every** hunk,
/// including the not-yet-committed hunk whose signatures are absent.
///
/// It is a *compile-time* floor as well as a runtime one: the `Option` matching below
/// does not type-check against 0.20's bare-`Signature` return, so silently
/// downgrading `git2` breaks the build instead of quietly reintroducing the UB.
#[test]
fn blame_buffer_signatures_are_null_checked_options() {
    let d = TempDir::new("bufsound");
    let repo = git2::Repository::init(d.path()).unwrap();
    commit_file(
        &repo,
        "f.txt",
        "a\nb\n",
        "Ada Lovelace",
        "ada@example.com",
        1_700_000_000,
        "init",
    );

    let mut opts = git2::BlameOptions::new();
    let blame = repo
        .blame_file(Path::new("f.txt"), Some(&mut opts))
        .unwrap();

    // Baseline: a committed hunk HAS signatures, so `Some` is not vacuously true.
    let committed = blame.get_index(0).expect("one hunk for the committed file");
    // `name_bytes()` (not `name()`) for the same reason production does it: git
    // names are arbitrary bytes. In 0.21 `name()` also changed shape — it returns
    // `Result<&str, Error>` now, not `Option<&str>`.
    assert_eq!(
        committed
            .final_signature()
            .map(|s| String::from_utf8_lossy(s.name_bytes()).into_owned()),
        Some("Ada Lovelace".to_string()),
        "a hunk from a real commit must expose its author signature"
    );
    assert!(committed.final_committer().is_some());
    assert!(committed.orig_signature().is_some());
    assert!(committed.orig_committer().is_some());

    // The advisory surface: overlay an unsaved buffer with an extra line. The extra
    // line belongs to no commit, so libgit2 leaves its hunk's signature pointers
    // NULL — the exact input that was UB before 0.21.
    let dirty = blame.blame_buffer(b"a\nb\nunsaved line\n").unwrap();
    assert!(dirty.len() >= 2, "committed hunk + the unsaved hunk");

    let mut saw_unattributed = false;
    for hunk in dirty.iter() {
        // Touching all four accessors is the point: each must null-check rather
        // than construct a Signature over a null pointer.
        let sigs = [
            hunk.final_signature(),
            hunk.final_committer(),
            hunk.orig_signature(),
            hunk.orig_committer(),
        ];
        if hunk.final_commit_id().is_zero() {
            saw_unattributed = true;
            for sig in &sigs {
                assert!(
                    sig.is_none(),
                    "a zero-OID buffer hunk has no commit, so every signature must \
                     be None — a `Some` here would be a Signature over a null pointer"
                );
            }
        } else {
            for sig in &sigs {
                // Reading through the Signature proves the pointer is live.
                assert!(sig.is_some());
                let _ = sig.as_ref().unwrap().name_bytes();
            }
        }
    }
    assert!(
        saw_unattributed,
        "the unsaved line must produce a zero-OID hunk, or this test asserts nothing"
    );
}
