//! Git ▸ Compare and Git ▸ Revert for one file. Revert is `git checkout HEAD -- <path>`, NEVER
//! `git revert` (no commit). Both are scope-checked before any access; `git2`, not a subprocess.
//! Errors are human sentences shown as-is (like `git_blame`); add a code if a caller must branch.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One file at `HEAD` and on disk. Wire (camelCase):
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

/// Compare `requested` against `HEAD`, scope check first. `unchanged`/`binary` come from bytes,
/// never decoded strings. The working side is the bytes on disk, not the index, so staging an
/// edit changes neither side.
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

/// DESTRUCTIVE: reset one file and its index entry to HEAD. Refuses directories and paths with no
/// HEAD blob. The `.path(rel)` restriction is load-bearing: without it `.force()` resets the whole
/// tree (pinned by `restore_touches_only_the_named_path` in `tests/git_file.rs`).
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

/// Scope-resolve `requested`, tolerating a file deleted from disk: only when absent, the parent
/// goes through `resolve_in_scope` and the name is joined on. `symlink_metadata` decides absence,
/// so a broken symlink stays present instead of being laundered into "deleted".
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

/// The repo containing `real` (discovered from its parent) plus its canonicalized workdir: on
/// macOS `/tmp` → `/private/tmp`, so an uncanonicalized prefix would never match `real`.
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

/// `real` relative to the repo root as `/`-separated UTF-8, the form libgit2 matches: a `\` or a
/// lossy path would silently match nothing, and a restore would quietly not happen.
fn relative_git_path(workdir: &Path, real: &Path) -> Result<String, String> {
    let rel = real
        .strip_prefix(workdir)
        .map_err(|_| "file is not inside the repository".to_string())?;
    let rel = rel
        .to_str()
        .ok_or_else(|| "path is not valid UTF-8".to_string())?;
    Ok(rel.replace(std::path::MAIN_SEPARATOR, "/"))
}

/// The blob at `HEAD:<rel>`, or `None` (nothing to compare against) for an unborn HEAD, a path
/// absent from HEAD, or a path that is a tree at HEAD.
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

/// Frontend: `invoke<FileDiff>('git_file_diff', { path })`; out-of-scope, not a file, not in a
/// repo or missing → `Err(<short message>)`, shown inline.
#[tauri::command]
pub fn git_file_diff(app: tauri::AppHandle, path: String) -> Result<FileDiff, String> {
    file_diff_scoped(Path::new(&path), &crate::fs_tree::allowed_roots(&app))
}

/// Git ▸ Revert (see [`file_restore_scoped`]): `invoke<void>('git_file_restore', { path })`.
/// DESTRUCTIVE: confirm with the user before calling it.
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
        // Deliberately unlike libgit2's `is_binary()` NUL sniff: the contract is "not valid
        // UTF-8", and NUL is valid UTF-8.
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
