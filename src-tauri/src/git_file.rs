//! Git ▸ Compare and Git ▸ Revert for one file in the workspace tree.
//!
//! Two commands, both keyed on a single absolute file path:
//!
//! * [`git_file_diff`] — "show me what I changed in this file versus HEAD". It
//!   returns both sides ([`FileDiff`]) and lets the UI render the comparison; it
//!   deliberately does **not** compute a hunk list, because the editor already owns
//!   a diff view and a pre-baked patch would only constrain it.
//! * [`git_file_restore`] — "throw away my changes to this file".
//!
//! ## 🔴 "Revert" here is `git restore`, NOT `git revert`
//!
//! The menu item is named **Revert** because that is what an IDE user calls it
//! (IntelliJ says *Rollback*, VS Code says *Discard Changes*). In **git's own**
//! vocabulary `git revert` means something completely different: it creates a new
//! commit that undoes an earlier commit. That is not what this module does and must
//! never become what it does. [`git_file_restore`] implements
//! `git checkout HEAD -- <path>` / `git restore <path>` semantics for exactly one
//! file: the working tree (and that path's index entry) is reset to the file's
//! content at HEAD, and no commit is created, no history is touched.
//!
//! If you are here to "fix" the naming, fix the *comment*, not the behaviour.
//!
//! **Security scope.** Both commands take a user-supplied path, so both
//! go through the server-authoritative guard every fs command uses:
//! [`crate::fs_tree::resolve_in_scope`] against [`crate::fs_tree::allowed_roots`],
//! *before* any git or filesystem access. For [`git_file_restore`] this is not a
//! formality — it is a destructive write, and the scope check is what stands between
//! a bad path and a clobbered file outside the workspace.
//!
//! **Why `git2` and not a subprocess.** Same reasons as `git_blame`/`git_status`: a
//! GUI-launched app has a minimal `PATH` and may not be able to find the `git`
//! binary at all (zero-install: no runtime requirement for users), and the crate is
//! already in-tree, vendored and network-free.
//!
//! **Errors are plain human sentences, not codes — deliberately.** This repo has two
//! error styles and the difference is about the *consumer*, not about taste.
//! `git_status.rs` returns a coded vocabulary (`"out-of-scope"`, `"not-a-repo"`, …)
//! because the frontend's `gitStore` has to *classify* the failure to decide whether
//! to hide the whole decoration layer. `git_blame.rs` returns sentences because its
//! consumer renders the message inline for a human to read. Compare and Revert are
//! the second kind — a diff view and a menu action, each showing the string as-is —
//! so they follow `git_blame`. If you are adding a caller that needs to branch on
//! *which* failure happened, add a code; do not screen-scrape these sentences.
//!
//! All the logic lives in `*_scoped` free functions that take the allowed roots
//! explicitly, so the tests drive real temporary repositories with no `AppHandle`;
//! the `#[tauri::command]`s are thin glue. Tests are split the way `git_status`'s
//! are: the pure helpers and the wire shape are unit-tested in this file, and the
//! real-repository behaviour lives in `tests/git_file.rs`. Neither tier is
//! `#[ignore]`d — matching `tests/git_blame.rs` and `tests/git_status.rs`, which are
//! not either: these tests need no network, no Docker and no signed-in CLI, so a
//! default `cargo test` must run them.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Both sides of one file: its content at `HEAD` and its content on disk.
///
/// Frontend contract (camelCase on the wire):
/// `{ path, relative, head, working, unchanged, binary }`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// Absolute canonical path of the file (as resolved in scope).
    pub path: String,
    /// Repo-relative path — the UI uses it for the tab title and headers. Always
    /// `/`-separated (git's own spelling), on every platform.
    pub relative: String,
    /// The file's content at HEAD. `None` when the file is untracked, or newly
    /// added and not yet committed (nothing to compare against).
    pub head: Option<String>,
    /// The working-tree content. `None` when the file has been deleted on disk.
    pub working: Option<String>,
    /// True when the two sides are byte-identical (the UI says "no changes").
    pub unchanged: bool,
    /// True when either side is not valid UTF-8. Both text fields are `None` in
    /// that case — the UI shows "binary file" rather than a diff. NEVER attempt
    /// a lossy conversion: a mangled diff is worse than an honest refusal.
    pub binary: bool,
}

/// Compare `requested` against `HEAD`, confined to `allowed_roots`.
///
/// Steps, in order: scope-check the path (out-of-scope fails before any git
/// access), refuse anything that exists but is not a regular file, discover the
/// containing repository, read the working-tree bytes and the `HEAD:<rel>` blob,
/// and decide `unchanged`/`binary` from the **bytes** — never from a decoded
/// string.
///
/// The working side is the file's bytes **on disk**, not the index: that is what
/// the user sees in the editor, and "what I changed" means what is in front of
/// them. (Consequence, on purpose: staging an edit changes neither side.)
pub fn file_diff_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Result<FileDiff, String> {
    let real = resolve_file_in_scope(requested, allowed_roots)?;
    if real.exists() && !real.is_file() {
        return Err("path is not a file".to_string());
    }

    let (repo, workdir) = discover_repo(&real)?;
    let rel = relative_git_path(&workdir, &real)?;

    // The working side is the bytes on disk. A missing file is the deleted-in-worktree
    // case, not an error — HEAD still has something to show.
    let working_bytes = match std::fs::read(&real) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("cannot read the file on disk: {e}")),
    };
    let head_bytes = head_blob(&repo, &rel)?;

    if head_bytes.is_none() && working_bytes.is_none() {
        // Not on disk and not in HEAD: there is no file here to compare, and
        // saying "unchanged" about a path that does not exist would be a lie.
        return Err("file does not exist".to_string());
    }

    // Compare BYTES: two sides can be byte-identical and still be undecodable,
    // and a lossy decode would make two different files look the same.
    let unchanged = head_bytes.as_deref() == working_bytes.as_deref();
    let binary = !is_utf8(head_bytes.as_deref()) || !is_utf8(working_bytes.as_deref());

    Ok(FileDiff {
        path: real.to_string_lossy().into_owned(),
        relative: rel,
        head: if binary { None } else { decode(head_bytes) },
        working: if binary { None } else { decode(working_bytes) },
        unchanged,
        binary,
    })
}

/// Discard the working-tree changes to `requested`, confined to `allowed_roots`.
///
/// **This is destructive and irreversible** — the user's edits to that file are
/// gone. Everything about the implementation is shaped by that:
///
/// * The scope guard runs first, so an out-of-scope path never reaches a write.
/// * A directory is refused: this reverts one file, never a subtree.
/// * A path with no blob at `HEAD` is refused rather than "restored" to nothing.
///   Overwriting is not an option (there is nothing to overwrite it *with*), and
///   silently doing nothing would tell the user their revert worked.
/// * The checkout is restricted with `.path(rel)`. **That restriction is the
///   load-bearing safety property of this function**: without it, `checkout_head`
///   with `.force()` would reset the *entire* working tree and destroy every other
///   uncommitted change in the repository. `restore_touches_only_the_named_path`
///   (in `tests/git_file.rs`) exists so that removing it cannot go unnoticed.
///
/// Semantics are `git checkout HEAD -- <path>`: both the working file and that
/// path's index entry go back to HEAD, so a staged change is discarded too. See
/// the module header for why this is called Revert and is not `git revert`.
pub fn file_restore_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Result<(), String> {
    let real = resolve_file_in_scope(requested, allowed_roots)?;
    // A directory (the repo root included) and anything else that is not a regular
    // file are the same refusal: this command reverts exactly one file.
    if real.exists() && !real.is_file() {
        return Err("path is not a file — revert applies to one file at a time".to_string());
    }

    let (repo, workdir) = discover_repo(&real)?;
    let rel = relative_git_path(&workdir, &real)?;

    // Nothing at HEAD means nothing to revert TO. Refuse loudly; a no-op would
    // look like success.
    if head_blob(&repo, &rel)?.is_none() {
        return Err("file is not tracked — there is nothing to revert to".to_string());
    }

    let mut checkout = git2::build::CheckoutBuilder::new();
    // `.force()` = overwrite the modified file (the whole point). `.path()` = do it
    // for THIS path and nothing else. Never separate these two lines.
    checkout.force().path(rel.as_str());
    repo.checkout_head(Some(&mut checkout))
        .map_err(|e| format!("cannot revert file: {}", e.message()))?;
    Ok(())
}

/// Resolve `requested` against the scope, tolerating a file that is **gone from
/// disk** — the deleted-in-worktree case, which is exactly the state Compare and
/// Revert most need to handle.
///
/// [`crate::fs_tree::resolve_in_scope`] canonicalizes, so it cannot resolve a path
/// that no longer exists. Rather than weaken the guard, this mirrors `fs_tree`'s own
/// `resolve_new_in_scope` shape for not-yet-existing targets: when — and **only**
/// when — the path is absent from the filesystem, the *parent* goes through the same
/// `resolve_in_scope` call and the final component is joined onto the canonical
/// parent. A `..` or an escaping symlink anywhere in the path is still resolved and
/// rejected by that call, so the scope stays server-authoritative.
///
/// A path that *does* exist and is rejected keeps its rejection — the fallback never
/// runs for it. `symlink_metadata` (which does not follow links) decides that, so a
/// broken symlink counts as present rather than being laundered into "deleted file".
///
/// No name validation is needed here: `Path::file_name` already yields a single
/// non-empty component — it returns `None` for `..` and normalizes away `.`, and a
/// separator cannot appear inside one component — so the only way it can fail us is
/// non-UTF-8 bytes, which is the one case checked.
fn resolve_file_in_scope(requested: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    match crate::fs_tree::resolve_in_scope(requested, allowed_roots) {
        Ok(real) => Ok(real),
        Err(rejected) => {
            if requested.symlink_metadata().is_ok() {
                return Err(rejected);
            }
            let parent = requested
                .parent()
                .ok_or_else(|| "path has no parent directory".to_string())?;
            let name = requested
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| "path is not valid UTF-8".to_string())?;
            let real_parent = crate::fs_tree::resolve_in_scope(parent, allowed_roots)?;
            if !real_parent.is_dir() {
                return Err("parent is not a directory".to_string());
            }
            Ok(real_parent.join(name))
        }
    }
}

/// The repository containing `real`, plus its **canonicalized** working directory.
///
/// Discovery starts at the file's parent (a file is not a directory to discover
/// from). The workdir is canonicalized before it is ever used as a prefix: `real` is
/// canonical, while libgit2 hands back the workdir in whatever spelling the repo was
/// opened with (on macOS `/tmp` is a symlink to `/private/tmp`, so an uncanonicalized
/// prefix would never match and every file would look "not inside the repository").
fn discover_repo(real: &Path) -> Result<(git2::Repository, PathBuf), String> {
    let parent = real
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    // Not being in a repo is a normal state the UI shows inline — keep it calm.
    let repo =
        git2::Repository::discover(parent).map_err(|_| "not in a git repository".to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    let workdir = crate::paths::canonicalize(workdir)
        .map_err(|_| "cannot resolve the repository root".to_string())?;
    Ok((repo, workdir))
}

/// `real` relative to the repository root, in git's spelling: `/`-separated UTF-8.
///
/// Used for both the wire's `relative` field and the checkout pathspec, so it has to
/// be the form libgit2 matches against — a Windows `\` would silently match nothing,
/// and a silent non-match in [`file_restore_scoped`] is a revert that quietly did not
/// happen. Non-UTF-8 is refused for the same reason: a lossy path is a *different*
/// path, and we will not aim a destructive checkout at a guess.
fn relative_git_path(workdir: &Path, real: &Path) -> Result<String, String> {
    let rel = real
        .strip_prefix(workdir)
        .map_err(|_| "file is not inside the repository".to_string())?;
    let rel = rel
        .to_str()
        .ok_or_else(|| "path is not valid UTF-8".to_string())?;
    Ok(rel.replace(std::path::MAIN_SEPARATOR, "/"))
}

/// The bytes of the blob at `HEAD:<rel>`, or `None` when there is no such blob.
///
/// `None` covers three real states, all of which mean "nothing to compare against":
/// an **unborn HEAD** (a fresh repo with no commits — libgit2 reports this as an
/// error code, and it is not one), a path that is simply absent from HEAD
/// (untracked, or added but not yet committed), and a path that exists in HEAD as a
/// *tree* rather than a blob (it was a directory at that commit).
fn head_blob(repo: &git2::Repository, rel: &str) -> Result<Option<Vec<u8>>, String> {
    let head = match repo.head() {
        Ok(head) => head,
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => return Ok(None),
        Err(e) => return Err(format!("cannot read HEAD: {}", e.message())),
    };
    let tree = head
        .peel_to_commit()
        .and_then(|commit| commit.tree())
        .map_err(|e| format!("cannot read HEAD: {}", e.message()))?;
    let entry = match tree.get_path(Path::new(rel)) {
        Ok(entry) => entry,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read HEAD: {}", e.message())),
    };
    let object = entry
        .to_object(repo)
        .map_err(|e| format!("cannot read HEAD: {}", e.message()))?;
    Ok(object.as_blob().map(|blob| blob.content().to_vec()))
}

/// Whether a side is decodable text. An absent side (`None`) is not binary — it is
/// simply not there.
fn is_utf8(bytes: Option<&[u8]>) -> bool {
    bytes.is_none_or(|b| std::str::from_utf8(b).is_ok())
}

/// Decode a side that [`is_utf8`] has already vouched for.
fn decode(bytes: Option<Vec<u8>>) -> Option<String> {
    // `from_utf8` (not `from_utf8_lossy`): the caller only reaches this for sides
    // already proven valid, so an `Err` here would mean the two checks disagree —
    // dropping the side is the honest outcome, never a mangled one.
    bytes.and_then(|b| String::from_utf8(b).ok())
}

/// HEAD-vs-working-tree comparison for one file (Git ▸ Compare).
///
/// Frontend contract: `invoke<FileDiff>('git_file_diff', { path })`. `path` is an
/// absolute file path. Out-of-scope / not-a-file / not-in-a-repo / nonexistent →
/// `Err(<short message>)`, which the UI shows inline.
#[tauri::command]
pub fn git_file_diff(app: tauri::AppHandle, path: String) -> Result<FileDiff, String> {
    file_diff_scoped(Path::new(&path), &crate::fs_tree::allowed_roots(&app))
}

/// Discard one file's working-tree changes (Git ▸ Revert) — see
/// [`file_restore_scoped`], and the module header on why this is not `git revert`.
///
/// Frontend contract: `invoke<void>('git_file_restore', { path })`. **Destructive**:
/// confirm with the user before calling it.
#[tauri::command]
pub fn git_file_restore(app: tauri::AppHandle, path: String) -> Result<(), String> {
    file_restore_scoped(Path::new(&path), &crate::fs_tree::allowed_roots(&app))
}

#[cfg(test)]
mod tests {
    //! The pure half. Everything that needs a real repository lives in
    //! `tests/git_file.rs`, exactly the split `git_status` uses.

    use super::*;
    use serde_json::json;

    // ── the text/binary decision ──────────────────────────────────────────────

    #[test]
    fn is_utf8_treats_an_absent_side_as_text_and_bad_bytes_as_binary() {
        assert!(is_utf8(None), "an absent side is not binary");
        assert!(is_utf8(Some(b"hello")));
        assert!(is_utf8(Some("é".as_bytes())), "multi-byte UTF-8 is text");
        assert!(is_utf8(Some(&[])), "an empty file is text");
        assert!(!is_utf8(Some(&[0xff])));
        assert!(
            !is_utf8(Some(&[0xe2, 0x82])),
            "a truncated multi-byte sequence is not text"
        );
    }

    #[test]
    fn a_nul_byte_alone_is_text_by_this_definition() {
        // Deliberate divergence from libgit2's `Blob::is_binary()` heuristic (which
        // sniffs for a NUL in the first 8000 bytes): the frozen contract says
        // "not valid UTF-8", and NUL *is* valid UTF-8. Recorded as a test so the
        // choice is visible rather than accidental.
        assert!(is_utf8(Some(&[0x61, 0x00, 0x62])));
    }

    #[test]
    fn decode_returns_the_text_of_a_valid_side_and_nothing_for_an_absent_one() {
        assert_eq!(decode(Some(b"hi\n".to_vec())), Some("hi\n".to_string()));
        assert_eq!(decode(None), None);
        // Unreachable in practice (the caller checks `is_utf8` first), but the
        // fallback must drop the side rather than mangle it.
        assert_eq!(decode(Some(vec![0xff])), None);
    }

    // ── the repo-relative path (both the wire field and the checkout pathspec) ─

    #[test]
    fn relative_git_path_is_slash_separated() {
        let workdir = PathBuf::from("/w");
        let file = Path::new("/w").join("src").join("deep").join("a.txt");
        assert_eq!(
            relative_git_path(&workdir, &file).unwrap(),
            "src/deep/a.txt"
        );
    }

    #[test]
    fn relative_git_path_of_a_top_level_file_is_just_its_name() {
        assert_eq!(
            relative_git_path(Path::new("/w"), &Path::new("/w").join("a.txt")).unwrap(),
            "a.txt"
        );
    }

    #[test]
    fn a_file_outside_the_workdir_is_refused() {
        let err = relative_git_path(Path::new("/w"), Path::new("/elsewhere/a.txt")).unwrap_err();
        assert_eq!(err, "file is not inside the repository");
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_relative_path_is_refused_rather_than_guessed() {
        // A lossy path is a DIFFERENT path; aiming a destructive checkout at a
        // guess is not on the table.
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::OsStr::from_bytes(&[0x66, 0xff, 0x6f]); // "f\xffo"
        let file = Path::new("/w").join(name);
        let err = relative_git_path(Path::new("/w"), &file).unwrap_err();
        assert_eq!(err, "path is not valid UTF-8");
    }

    // ── the wire shape (what the frontend reads) ──────────────────────────────

    #[test]
    fn file_diff_serializes_camel_case_with_null_for_an_absent_side() {
        let wire = serde_json::to_value(FileDiff {
            path: "/r/a.txt".into(),
            relative: "a.txt".into(),
            head: Some("old\n".into()),
            working: None,
            unchanged: false,
            binary: false,
        })
        .unwrap();
        assert_eq!(
            wire,
            json!({
                "path": "/r/a.txt",
                "relative": "a.txt",
                "head": "old\n",
                "working": null,
                "unchanged": false,
                "binary": false
            })
        );
    }

    #[test]
    fn a_binary_file_serializes_with_both_sides_null() {
        let wire = serde_json::to_value(FileDiff {
            path: "/r/a.bin".into(),
            relative: "a.bin".into(),
            head: None,
            working: None,
            unchanged: true,
            binary: true,
        })
        .unwrap();
        assert_eq!(wire["head"], json!(null));
        assert_eq!(wire["working"], json!(null));
        assert_eq!(wire["binary"], json!(true));
        assert_eq!(wire["unchanged"], json!(true));
    }
}
