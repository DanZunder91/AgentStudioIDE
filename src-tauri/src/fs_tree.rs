//! Workspace file tree and file read/write backend. Every path is canonicalized (`..`, symlinks)
//! and confined to server-side allowed roots by [`resolve_in_scope`], never a client list, so a
//! webview XSS can't reach the whole filesystem. Commands are thin glue over root-explicit fns.

use std::path::{Path, PathBuf};

use crate::model::FsEntry;

/// Roots `read_dir` may browse: recent projects plus the default workspace (so the tree works
/// before a project is picked). Server-authoritative; returned raw, canonicalized by the caller.
pub(crate) fn allowed_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = crate::recent_projects::recent_projects(app.clone())
        .into_iter()
        .map(PathBuf::from)
        .collect();
    roots.push(crate::workspace::default_workspace_dir());
    roots
}

/// Canonicalize `requested` and require it at/under an allowed root: THE single scope check.
/// Canonicalizing first defeats `..` and escaping symlinks; `starts_with` is component-wise.
/// Scope is checked before type, so an out-of-scope path never reveals what it is.
pub(crate) fn resolve_in_scope(
    requested: &Path,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let real =
        crate::paths::canonicalize(requested).map_err(|_| "path does not exist".to_string())?;
    // Canonicalize the roots too (a root may itself be a symlink or non-canonical
    // spelling) before requiring the target to sit at or under one of them.
    let contained = allowed_roots
        .iter()
        .filter_map(|r| crate::paths::canonicalize(r).ok())
        .any(|root| real.starts_with(&root));
    if !contained {
        return Err("path is outside the allowed workspace roots".to_string());
    }
    Ok(real)
}

/// Children of `requested`: directories first, then files, case-insensitive. Entries that can't
/// be stat'd (a broken symlink) are skipped rather than failing the call.
fn list_dir(requested: &Path, allowed_roots: &[PathBuf]) -> Result<Vec<FsEntry>, String> {
    let real = resolve_in_scope(requested, allowed_roots)?;
    if !real.is_dir() {
        return Err("path is not a directory".to_string());
    }

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&real).map_err(|e| format!("cannot read directory: {e}"))?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = real.join(entry.file_name());
        // Skip what can't be stat'd. An out-of-root symlink is listed, but expanding it
        // re-enters `read_dir`, which rejects it.
        let Ok(meta) = std::fs::metadata(&child) else {
            continue;
        };
        entries.push(FsEntry {
            name,
            path: child.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
        });
    }

    // Directories before files (`true` sorts before `false` via reversed cmp), then
    // case-insensitive alphabetical within each group.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Frontend: `invoke<FsEntry[]>('read_dir', { path })`, `path` absolute. Out-of-scope,
/// unreadable or non-directory → `Err`, which the tree renders as "no children".
#[tauri::command]
pub fn read_dir(app: tauri::AppHandle, path: String) -> Result<Vec<FsEntry>, String> {
    list_dir(Path::new(&path), &allowed_roots(&app))
}

/// Files larger than this are refused rather than streamed into the webview — a
/// syntax-highlighting editor chokes on multi-megabyte buffers, and the preview is
/// meant for source files, not blobs. ~2 MiB.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// The head window sniffed for a NUL byte to classify a file as binary. Matches the
/// common "is this text?" heuristic (git checks a similar-sized prefix): a NUL in the
/// first few KB is a reliable binary tell, and valid-UTF-8 source never has one.
const BINARY_SNIFF_BYTES: usize = 8192;

/// Read a scoped UTF-8 text file. Distinct, stable `Err`s for non-files, files over
/// [`MAX_PREVIEW_BYTES`], and binaries (a NUL in the head, or invalid UTF-8).
fn read_file_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Result<String, String> {
    let real = resolve_in_scope(requested, allowed_roots)?;

    let meta = std::fs::metadata(&real).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("path is not a file".to_string());
    }
    // Check the size from metadata *before* reading, so a huge file is never loaded.
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err("file too large to preview".to_string());
    }

    let bytes = std::fs::read(&real).map_err(|e| format!("cannot read file: {e}"))?;
    // A NUL byte in the head is the classic binary tell — catches binaries that are
    // *accidentally* valid UTF-8 up to that point, which `from_utf8` alone would pass.
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return Err("binary file".to_string());
    }
    // Invalid UTF-8 → binary too. We surface one message for both so the editor has a
    // single "can't preview" branch.
    String::from_utf8(bytes).map_err(|_| "binary file".to_string())
}

/// Frontend: `invoke<string>('read_file', { path })`; any failure is `Err(<short message>)`.
/// `async` + `spawn_blocking`: a sync command runs on the event-loop thread, and a `stat`/read
/// on a slow mount would freeze the whole app.
#[tauri::command]
pub async fn read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let roots = allowed_roots(&app);
    tauri::async_runtime::spawn_blocking(move || read_file_scoped(Path::new(&path), &roots))
        .await
        .unwrap_or_else(|e| Err(format!("read task failed: {e}")))
}

/// A file's on-disk identity `(mtime, size)`: some filesystems stamp mtime at 1 s granularity.
/// `None` (gone, unreadable, out of scope) must stay distinct from "unchanged".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    /// Milliseconds since the epoch, or `None` when the platform has no mtime.
    pub mtime_ms: Option<i64>,
    pub size: u64,
}

/// Stamp one path, scope-checked. `None` when it cannot be stamped at all.
pub fn file_stamp_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Option<FileStamp> {
    // Scope FIRST, as everywhere in this module — an out-of-scope
    // path must not even be stat'd.
    let real = resolve_in_scope(requested, allowed_roots).ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = meta.modified().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_millis()).ok())
    });
    Some(FileStamp {
        mtime_ms,
        size: meta.len(),
    })
}

/// Stamp the open editors' files in one IPC round trip, off the event-loop thread.
/// Frontend: `invoke<(FileStamp | null)[]>('file_stamps', { paths })`, one answer per
/// input, in order.
#[tauri::command]
pub async fn file_stamps(app: tauri::AppHandle, paths: Vec<String>) -> Vec<Option<FileStamp>> {
    let roots = allowed_roots(&app);
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| file_stamp_scoped(Path::new(p), &roots))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Images can be larger than source files (a README screenshot), so they get a
/// higher cap than [`MAX_PREVIEW_BYTES`] — but still bounded, so a runaway blob is
/// never base64'd into the webview. ~10 MiB.
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// `data:` MIME for a known image extension, else `None`; SVG is inert in `<img>`. Takes a
/// filesystem path, never a URL: `logo.png?v=2` is refused on purpose. This is the last gate
/// before bytes are base64'd into the webview; URL parsing belongs in the frontend.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Standard-alphabet, padded base64 (encode-only). Hand-rolled to avoid a new
/// dependency (the repo's dependency-light stance); correctness is pinned by the
/// RFC-4648 test vectors in the tests below.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Read a scoped image as a `data:` URL (same [`resolve_in_scope`] guard). Refuses non-files,
/// files over [`MAX_IMAGE_BYTES`] and non-image extensions.
fn read_image_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Result<String, String> {
    let real = resolve_in_scope(requested, allowed_roots)?;
    let meta = std::fs::metadata(&real).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("path is not a file".to_string());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("image too large".to_string());
    }
    let mime = image_mime(&real).ok_or("unsupported image type")?;
    let bytes = std::fs::read(&real).map_err(|e| format!("cannot read file: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// Frontend: `invoke<string>('read_image_data_url', { path })`; `Err` leaves the `<img>` as-is.
/// `async` + `spawn_blocking` like [`read_file`]: up to 10 MiB per image, a dozen per page.
#[tauri::command]
pub async fn read_image_data_url(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let roots = allowed_roots(&app);
    tauri::async_runtime::spawn_blocking(move || read_image_scoped(Path::new(&path), &roots))
        .await
        .unwrap_or_else(|e| Err(format!("read task failed: {e}")))
}

/// Atomically overwrite an existing scoped regular file (never creates one): write a temp
/// sibling in the same dir, then rename over the target. A crash or failure leaves the
/// original intact and no temp behind.
fn write_file_scoped(
    requested: &Path,
    content: &str,
    allowed_roots: &[PathBuf],
) -> Result<(), String> {
    let real = resolve_in_scope(requested, allowed_roots)?;

    let meta = std::fs::metadata(&real).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("path is not a file".to_string());
    }

    // Temp sibling in the SAME directory as the target: a dotfile + ULID name that
    // cannot collide with anything real, on the same filesystem so the rename below is
    // a true atomic replace rather than a copy.
    let parent = real
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let file_name = real.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = parent.join(format!(".{file_name}.{}.tmp", ulid::Ulid::new()));

    let result = atomic_write(&tmp, &real, content.as_bytes(), meta.permissions());
    if result.is_err() {
        // Never leave a partial temp behind; the target is untouched either way.
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".to_string(),
        _ => format!("cannot write file: {e}"),
    })
}

/// Write `bytes` to `tmp`, match `perms` to the original, then rename `tmp` over
/// `target`. The rename is the atomic commit point.
fn atomic_write(
    tmp: &Path,
    target: &Path,
    bytes: &[u8],
    perms: std::fs::Permissions,
) -> std::io::Result<()> {
    std::fs::write(tmp, bytes)?;
    // Best-effort: preserve the original file's mode / read-only flag. A chmod failure
    // (some filesystems reject it) must not fail the save, so it is ignored.
    let _ = std::fs::set_permissions(tmp, perms);
    std::fs::rename(tmp, target)
}

/// Frontend: `invoke('write_file', { path, content })` → `Ok(())` or `Err(<short message>)`.
#[tauri::command]
pub fn write_file(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    write_file_scoped(Path::new(&path), &content, &allowed_roots(&app))
}

// ── Mutations: create dir / create file / rename-or-move / delete ─────────────
// Existing paths go through [`resolve_in_scope`]; not-yet-existing targets through
// [`resolve_new_in_scope`], which scope-checks the parent.

/// Map an `io::Error` to a short, stable message, folding `PermissionDenied` to the
/// same `"permission denied"` string [`write_file_scoped`] uses (so the frontend has
/// one permission branch across every fs command).
fn map_io_err(action: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".to_string(),
        _ => format!("cannot {action}: {e}"),
    }
}

/// Validate a client-supplied final name: one component, never a path. Rejects empty, `.`,
/// `..` and embedded separators.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name cannot be empty".to_string());
    }
    if name == "." || name == ".." {
        return Err("invalid name".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("name cannot contain path separators".to_string());
    }
    Ok(())
}

/// Whether `real` (already canonical) equals one of the canonicalized allowed roots.
/// Used to forbid renaming/moving/deleting a workspace root itself.
fn is_allowed_root(real: &Path, allowed_roots: &[PathBuf]) -> bool {
    allowed_roots
        .iter()
        .filter_map(|r| crate::paths::canonicalize(r).ok())
        .any(|root| root == real)
}

/// Resolve a target whose final component may not exist yet: validate the name, scope-check
/// the existing parent via [`resolve_in_scope`] (so `..` or escaping symlinks still fail),
/// require it be a directory, return `real_parent.join(name)`.
fn resolve_new_in_scope(requested: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let parent = requested
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let name = requested
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "target has no name".to_string())?;
    validate_name(name)?;

    let real_parent = resolve_in_scope(parent, allowed_roots)?;
    if !real_parent.is_dir() {
        return Err("parent is not a directory".to_string());
    }
    Ok(real_parent.join(name))
}

/// Create a new directory at `requested`. The parent must already exist and be in
/// scope; the target must not already exist. Uses `create_dir` (not `create_dir_all`)
/// since the parent is guaranteed present by [`resolve_new_in_scope`].
fn create_directory_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Result<(), String> {
    let target = resolve_new_in_scope(requested, allowed_roots)?;
    if target.try_exists().unwrap_or(false) {
        return Err("a file or folder with that name already exists".to_string());
    }
    std::fs::create_dir(&target).map_err(|e| map_io_err("create directory", &e))
}

/// Create a new empty file at `requested`, race-safely. `create_new(true)` fails if
/// the target already exists (so two concurrent creates cannot both "win"), which is
/// a stronger guarantee than a pre-check + create.
fn create_file_scoped(requested: &Path, allowed_roots: &[PathBuf]) -> Result<(), String> {
    let target = resolve_new_in_scope(requested, allowed_roots)?;
    if target.try_exists().unwrap_or(false) {
        return Err("a file or folder with that name already exists".to_string());
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map(|_| ())
        .map_err(|e| map_io_err("create file", &e))
}

/// Rename or move `from` to `to`. Never clobbers an existing destination; refuses to move a
/// workspace root or a directory into its own subtree.
fn rename_scoped(from: &Path, to: &Path, allowed_roots: &[PathBuf]) -> Result<(), String> {
    let real_from = resolve_in_scope(from, allowed_roots)?;
    let real_to = resolve_new_in_scope(to, allowed_roots)?;

    if is_allowed_root(&real_from, allowed_roots) {
        return Err("cannot move a workspace root".to_string());
    }
    if real_to.try_exists().unwrap_or(false) {
        return Err("a file or folder with that name already exists".to_string());
    }
    // Moving a directory into a path under itself (e.g. /a/b → /a/b/c) would orphan
    // the tree; reject it. `real_to` is `real_parent.join(name)`, both canonical
    // stems, so this component-wise prefix check is exact.
    if real_to.starts_with(&real_from) {
        return Err("cannot move a folder into itself".to_string());
    }
    std::fs::rename(&real_from, &real_to).map_err(|e| map_io_err("rename", &e))
}

/// Delete a file, or a directory (recursively), at `path`. The target must exist and
/// be in scope. Refuses to delete a workspace root itself.
fn delete_scoped(path: &Path, allowed_roots: &[PathBuf]) -> Result<(), String> {
    let real = resolve_in_scope(path, allowed_roots)?;
    if is_allowed_root(&real, allowed_roots) {
        return Err("cannot delete a workspace root".to_string());
    }
    if real.is_dir() {
        std::fs::remove_dir_all(&real).map_err(|e| map_io_err("delete", &e))
    } else {
        std::fs::remove_file(&real).map_err(|e| map_io_err("delete", &e))
    }
}

/// Frontend: `invoke('create_directory', { path })` → `Ok(())` or `Err(<short message>)`.
#[tauri::command]
pub fn create_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    create_directory_scoped(Path::new(&path), &allowed_roots(&app))
}

/// Create an empty file. Frontend: `invoke('create_file', { path })` → `Ok(())` or `Err(msg)`.
#[tauri::command]
pub fn create_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    create_file_scoped(Path::new(&path), &allowed_roots(&app))
}

/// Rename or move. Frontend: `invoke('rename_path', { from, to })` → `Ok(())` or `Err(msg)`.
#[tauri::command]
pub fn rename_path(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    rename_scoped(Path::new(&from), Path::new(&to), &allowed_roots(&app))
}

/// Delete a file, or a directory recursively. Frontend: `invoke('delete_path', { path })`.
#[tauri::command]
pub fn delete_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    delete_scoped(Path::new(&path), &allowed_roots(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A self-cleaning temp directory to build trees in.
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("agentstudio-fstree-{label}-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.root.join(rel);
            std::fs::create_dir_all(&p).unwrap();
            p
        }
        fn file(&self, rel: &str) -> PathBuf {
            let p = self.root.join(rel);
            std::fs::write(&p, b"x").unwrap();
            p
        }
        /// Write a file with exact `bytes` (for UTF-8 / binary / size cases).
        fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let p = self.root.join(rel);
            std::fs::write(&p, bytes).unwrap();
            p
        }
        /// The canonical root — what a caller would pass as an allowed root.
        fn canon_root(&self) -> PathBuf {
            crate::paths::canonicalize(&self.root).unwrap()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Children come back directories-first, then files, each case-insensitive
    /// alphabetical, with `is_dir` set correctly and `path` absolute.
    #[test]
    fn lists_children_sorted_dirs_first_then_alpha() {
        let t = TempTree::new("sort");
        // Deliberately unsorted, mixed case, interleaved dirs/files.
        t.dir("Zebra");
        t.dir("apple");
        t.dir("Mango");
        t.file("banana.txt");
        t.file("Avocado.md");
        t.file("cherry");

        let roots = vec![t.canon_root()];
        let out = list_dir(&t.root, &roots).unwrap();

        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        // Dirs first (apple, Mango, Zebra — case-insensitive), then files
        // (Avocado.md, banana.txt, cherry — case-insensitive).
        assert_eq!(
            names,
            vec![
                "apple",
                "Mango",
                "Zebra",
                "Avocado.md",
                "banana.txt",
                "cherry"
            ]
        );

        // is_dir is correct for each.
        for e in &out {
            let expect_dir = matches!(e.name.as_str(), "apple" | "Mango" | "Zebra");
            assert_eq!(e.is_dir, expect_dir, "wrong is_dir for {}", e.name);
            assert!(
                Path::new(&e.path).is_absolute(),
                "child path must be absolute: {}",
                e.path
            );
        }
    }

    /// Browsing the root itself (path == an allowed root) is allowed.
    #[test]
    fn the_root_itself_is_browsable() {
        let t = TempTree::new("rooteq");
        t.dir("child");
        let roots = vec![t.canon_root()];
        let out = list_dir(&t.root, &roots).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "child");
    }

    /// A nested directory *inside* an allowed root is browsable.
    #[test]
    fn a_nested_dir_inside_the_root_is_allowed() {
        let t = TempTree::new("nested");
        let sub = t.dir("a/b/c");
        t.file("a/b/c/leaf.txt");
        let roots = vec![t.canon_root()];
        let out = list_dir(&sub, &roots).unwrap();
        assert_eq!(
            out.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["leaf.txt"]
        );
    }

    /// A path OUTSIDE every allowed root is rejected — the core scope guard.
    #[test]
    fn rejects_a_path_outside_the_allowed_root() {
        let root = TempTree::new("scope-root");
        let other = TempTree::new("scope-other");
        other.dir("secret");
        // `other` is a sibling temp dir, not under `root`.
        let roots = vec![root.canon_root()];
        let err = list_dir(&other.root, &roots).unwrap_err();
        assert!(
            err.contains("outside"),
            "expected an out-of-scope error, got: {err}"
        );
    }

    /// A component-prefix that is NOT a path-prefix must not slip through:
    /// `/tmp/rootsuffix` is not inside the root `/tmp/root`.
    #[test]
    fn a_sibling_with_a_shared_name_prefix_is_rejected() {
        let base = TempTree::new("prefix");
        let root = base.dir("proj");
        let sibling = base.dir("proj-evil"); // shares the "proj" string prefix
        let roots = vec![crate::paths::canonicalize(&root).unwrap()];
        let err = list_dir(&sibling, &roots).unwrap_err();
        assert!(err.contains("outside"), "prefix sibling leaked in: {err}");
    }

    /// A symlink INSIDE the root that points OUTSIDE it is rejected: canonicalizing
    /// the request resolves the link to its out-of-root target. This is the
    /// symlink-escape defense.
    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_escaping_the_root() {
        let root = TempTree::new("esc-root");
        let outside = TempTree::new("esc-outside");
        outside.dir("loot");
        // Inside the root, a symlink `escape` -> the outside dir.
        std::os::unix::fs::symlink(&outside.root, root.root.join("escape")).unwrap();

        let roots = vec![root.canon_root()];
        let err = list_dir(&root.root.join("escape"), &roots).unwrap_err();
        assert!(
            err.contains("outside"),
            "a symlink escaping the root must be rejected, got: {err}"
        );
    }

    /// A nonexistent path → `Err` (never a panic, never an empty Ok).
    #[test]
    fn errors_on_a_nonexistent_path() {
        let t = TempTree::new("noexist");
        let roots = vec![t.canon_root()];
        let err = list_dir(&t.root.join("nope"), &roots).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }

    /// A path that is a FILE (not a directory) → `Err`.
    #[test]
    fn errors_on_a_file_path() {
        let t = TempTree::new("filepath");
        let file = t.file("thing.txt");
        let roots = vec![t.canon_root()];
        let err = list_dir(&file, &roots).unwrap_err();
        assert!(err.contains("not a directory"), "got: {err}");
    }

    /// Entries that cannot be stat'd (a broken symlink) are skipped, not fatal —
    /// the rest of the directory still lists.
    #[cfg(unix)]
    #[test]
    fn skips_entries_that_cannot_be_stated() {
        let t = TempTree::new("broken");
        t.file("real.txt");
        // A symlink to a target that does not exist: `std::fs::metadata` fails on it.
        std::os::unix::fs::symlink(t.root.join("missing-target"), t.root.join("dangling")).unwrap();

        let roots = vec![t.canon_root()];
        let out = list_dir(&t.root, &roots).unwrap();
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["real.txt"],
            "the broken symlink must be skipped"
        );
    }

    /// With multiple allowed roots, a path under ANY of them is accepted.
    #[test]
    fn accepts_a_path_under_any_of_several_roots() {
        let a = TempTree::new("multi-a");
        let b = TempTree::new("multi-b");
        b.dir("inside");
        let roots = vec![a.canon_root(), b.canon_root()];
        // A dir under the SECOND root resolves fine.
        let out = list_dir(&b.root, &roots).unwrap();
        assert_eq!(
            out.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["inside"]
        );
    }

    // ── read_file ─────────────────────────────────────────────────────────────

    /// A scoped UTF-8 file reads back byte-for-byte, including multibyte content.
    #[test]
    fn reads_a_scoped_utf8_file() {
        let t = TempTree::new("read-ok");
        let content = "fn main() {\n    println!(\"héllo, 世界\");\n}\n";
        t.write("main.rs", content.as_bytes());
        let roots = vec![t.canon_root()];
        let got = read_file_scoped(&t.root.join("main.rs"), &roots).unwrap();
        assert_eq!(got, content);
    }

    /// A file OUTSIDE every allowed root is rejected — same scope guard as read_dir.
    #[test]
    fn read_file_rejects_a_path_outside_the_root() {
        let root = TempTree::new("rf-scope-root");
        let other = TempTree::new("rf-scope-other");
        let secret = other.write("secret.txt", b"top secret");
        let roots = vec![root.canon_root()];
        let err = read_file_scoped(&secret, &roots).unwrap_err();
        assert!(err.contains("outside"), "out-of-root file leaked: {err}");
    }

    /// A symlink INSIDE the root pointing at a file OUTSIDE it is rejected: the
    /// request canonicalizes to the out-of-root target. The read-side symlink escape.
    #[cfg(unix)]
    #[test]
    fn read_file_rejects_a_symlink_escaping_the_root() {
        let root = TempTree::new("rf-esc-root");
        let outside = TempTree::new("rf-esc-outside");
        let target = outside.write("loot.txt", b"secret");
        // Inside the root, a symlink `link.txt` -> the outside file.
        std::os::unix::fs::symlink(&target, root.root.join("link.txt")).unwrap();

        let roots = vec![root.canon_root()];
        let err = read_file_scoped(&root.root.join("link.txt"), &roots).unwrap_err();
        assert!(
            err.contains("outside"),
            "a symlink escaping the root must be rejected, got: {err}"
        );
    }

    // ── read_image_data_url (local images in the Markdown preview) ─────────────

    #[test]
    fn base64_encode_matches_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // Exercise the top of the alphabet (`+` and `/`).
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0xfb]), "+w==");
    }

    /// A scoped image reads back as a `data:` URL with the right MIME + payload.
    #[test]
    fn reads_a_scoped_image_as_a_data_url() {
        let t = TempTree::new("img-ok");
        let bytes = [0x89u8, b'P', b'N', b'G', 0x00, 0x01, 0x02];
        t.write("pic.png", &bytes);
        let roots = vec![t.canon_root()];
        let url = read_image_scoped(&t.root.join("pic.png"), &roots).unwrap();
        assert_eq!(
            url,
            format!("data:image/png;base64,{}", base64_encode(&bytes))
        );
    }

    #[test]
    fn image_read_infers_mime_from_extension() {
        let t = TempTree::new("img-mime");
        t.write("diagram.svg", b"<svg/>");
        let roots = vec![t.canon_root()];
        let url = read_image_scoped(&t.root.join("diagram.svg"), &roots).unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"), "{url}");
    }

    /// A non-image extension is refused, and an image outside every root is rejected
    /// by the SAME scope guard as read_file (no read of an unauthorized file).
    #[test]
    fn image_read_rejects_unsupported_type_and_out_of_scope() {
        let t = TempTree::new("img-bad");
        t.write("notes.txt", b"hi");
        let roots = vec![t.canon_root()];
        let e1 = read_image_scoped(&t.root.join("notes.txt"), &roots).unwrap_err();
        assert!(
            e1.contains("unsupported"),
            "wrong ext should be unsupported: {e1}"
        );

        let other = TempTree::new("img-other");
        let secret = other.write("secret.png", b"x");
        let e2 = read_image_scoped(&secret, &roots).unwrap_err();
        assert!(e2.contains("outside"), "out-of-scope image leaked: {e2}");
    }

    /// A file over the size cap is refused up front (never loaded into memory).
    #[test]
    fn read_file_rejects_an_oversized_file() {
        let t = TempTree::new("rf-big");
        // One byte over the cap.
        let big = vec![b'a'; (MAX_PREVIEW_BYTES + 1) as usize];
        t.write("huge.log", &big);
        let roots = vec![t.canon_root()];
        let err = read_file_scoped(&t.root.join("huge.log"), &roots).unwrap_err();
        assert_eq!(err, "file too large to preview");

        // A file exactly AT the cap is fine (boundary is `>` not `>=`).
        let at_cap = vec![b'a'; MAX_PREVIEW_BYTES as usize];
        t.write("at-cap.log", &at_cap);
        assert!(read_file_scoped(&t.root.join("at-cap.log"), &roots).is_ok());
    }

    /// Invalid UTF-8 → `binary file` (not a garbage string).
    #[test]
    fn read_file_rejects_invalid_utf8() {
        let t = TempTree::new("rf-utf8");
        // 0xFF/0xFE are never valid UTF-8; no NUL, so this exercises the from_utf8 arm.
        t.write("bad.bin", &[0x66, 0x6f, 0xff, 0xfe, 0x6f]);
        let roots = vec![t.canon_root()];
        let err = read_file_scoped(&t.root.join("bad.bin"), &roots).unwrap_err();
        assert_eq!(err, "binary file");
    }

    /// A NUL byte in the head → `binary file`, even though NUL is valid UTF-8 (this
    /// is the sniff that catches binaries `from_utf8` alone would wave through).
    #[test]
    fn read_file_rejects_a_nul_byte_binary() {
        let t = TempTree::new("rf-nul");
        // Valid UTF-8 bytes with an embedded NUL — from_utf8 would accept this.
        t.write("obj.dat", b"MZ\x00\x00text-after-nul");
        let roots = vec![t.canon_root()];
        let err = read_file_scoped(&t.root.join("obj.dat"), &roots).unwrap_err();
        assert_eq!(err, "binary file");
    }

    /// A NUL is valid UTF-8, so only the `.take` bound catches it: at 8191 it is binary, at 8192
    /// it reads fine. Literals, not the constant, so a mutated constant can't move the payload.
    #[test]
    fn the_binary_sniff_window_ends_at_exactly_8192_bytes() {
        let t = TempTree::new("rf-window");
        let roots = vec![t.canon_root()];

        // NUL at index 8191 — the LAST byte inside the window → binary.
        let mut inside = vec![b'a'; 8192];
        inside[8191] = 0;
        t.write("inside.dat", &inside);
        assert_eq!(
            read_file_scoped(&t.root.join("inside.dat"), &roots).unwrap_err(),
            "binary file",
            "a NUL at the last in-window index must still be sniffed"
        );

        // First NUL at index 8192 — the FIRST byte past the window → readable text.
        let mut past = vec![b'a'; 8193];
        past[8192] = 0;
        t.write("past.dat", &past);
        let text = read_file_scoped(&t.root.join("past.dat"), &roots)
            .expect("a NUL past the sniff window is valid UTF-8 and must read");
        assert_eq!(text.len(), 8193, "the whole file must come back");
        assert_eq!(
            text.as_bytes()[8192],
            0,
            "the past-the-window NUL must survive into the string"
        );
    }

    /// A nonexistent file → `Err`, never a panic.
    #[test]
    fn read_file_errors_on_a_nonexistent_path() {
        let t = TempTree::new("rf-noexist");
        let roots = vec![t.canon_root()];
        let err = read_file_scoped(&t.root.join("ghost.rs"), &roots).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }

    /// A directory path → `Err` (the editor previews files, not folders).
    #[test]
    fn read_file_errors_on_a_directory() {
        let t = TempTree::new("rf-dir");
        let sub = t.dir("src");
        let roots = vec![t.canon_root()];
        let err = read_file_scoped(&sub, &roots).unwrap_err();
        assert_eq!(err, "path is not a file");
    }

    // ── write_file ────────────────────────────────────────────────────────────

    /// A scoped write round-trips exactly (incl. multibyte UTF-8) and leaves no temp
    /// litter — the temp sibling was renamed over the target, not abandoned.
    #[test]
    fn write_round_trips_and_leaves_no_temp() {
        let t = TempTree::new("wf-ok");
        let target = t.write("notes.md", b"stale contents");
        let roots = vec![t.canon_root()];

        let content = "# Notes\n— café — 日本語 — 🚀\nfn main() {}\n";
        write_file_scoped(&target, content, &roots).unwrap();

        assert_eq!(std::fs::read_to_string(&target).unwrap(), content);
        // Only the target remains in the directory.
        let names: Vec<String> = std::fs::read_dir(&t.root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec!["notes.md".to_string()],
            "temp litter left behind"
        );
    }

    /// Writing to a file OUTSIDE every allowed root is rejected — same scope guard.
    #[test]
    fn write_file_rejects_a_path_outside_the_root() {
        let root = TempTree::new("wf-scope-root");
        let other = TempTree::new("wf-scope-other");
        let victim = other.write("victim.txt", b"original");
        let roots = vec![root.canon_root()];

        let err = write_file_scoped(&victim, "HACKED", &roots).unwrap_err();
        assert!(err.contains("outside"), "out-of-root write leaked: {err}");
        // The out-of-scope file was NOT modified.
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "original");
    }

    /// A symlink INSIDE the root pointing at a file OUTSIDE it is rejected: the write
    /// target canonicalizes to the out-of-root file. The write-side symlink escape.
    #[cfg(unix)]
    #[test]
    fn write_file_rejects_a_symlink_escaping_the_root() {
        let root = TempTree::new("wf-esc-root");
        let outside = TempTree::new("wf-esc-outside");
        let target = outside.write("loot.txt", b"original");
        std::os::unix::fs::symlink(&target, root.root.join("link.txt")).unwrap();

        let roots = vec![root.canon_root()];
        let err = write_file_scoped(&root.root.join("link.txt"), "HACKED", &roots).unwrap_err();
        assert!(
            err.contains("outside"),
            "symlink-escape write leaked: {err}"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
    }

    /// A nonexistent path → `Err` (this command edits existing files; it never creates
    /// one), and no file is created.
    #[test]
    fn write_file_rejects_a_nonexistent_path() {
        let t = TempTree::new("wf-noexist");
        let ghost = t.root.join("ghost.rs");
        let roots = vec![t.canon_root()];

        let err = write_file_scoped(&ghost, "content", &roots).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
        assert!(!ghost.exists(), "a nonexistent target must not be created");
    }

    /// A directory path → `Err` (never overwrite a folder as if it were a file).
    #[test]
    fn write_file_rejects_a_directory() {
        let t = TempTree::new("wf-dir");
        let sub = t.dir("src");
        let roots = vec![t.canon_root()];
        let err = write_file_scoped(&sub, "content", &roots).unwrap_err();
        assert_eq!(err, "path is not a file");
    }

    /// The temp's parent doesn't exist, so the write fails with ENOENT even under root (which
    /// ignores read-only dirs); the target must stay byte-for-byte intact.
    #[test]
    fn atomic_write_failure_leaves_the_target_intact() {
        let t = TempTree::new("wf-atomic-core");
        let target = t.write("doc.txt", b"ORIGINAL");
        // Temp whose parent dir does not exist → write fails before touching anything.
        let bogus_tmp = t.root.join("no-such-subdir").join("x.tmp");
        let perms = std::fs::metadata(&target).unwrap().permissions();

        let res = atomic_write(&bogus_tmp, &target, b"NEW CONTENT", perms);
        assert!(res.is_err(), "a write into a nonexistent dir must fail");
        // The target is untouched: the atomic path never opens it until the rename,
        // which never runs. A naive `write(target, …)` would have clobbered it.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "ORIGINAL");
        assert!(!bogus_tmp.exists(), "no temp was created");
    }

    /// A read-only dir allows in-place edits but not a new temp, so the atomic write fails at
    /// temp creation: target intact, no litter, "permission denied". Skipped under root.
    #[cfg(unix)]
    #[test]
    fn write_is_atomic_a_failed_write_leaves_the_target_intact() {
        use std::os::unix::fs::PermissionsExt;

        let t = TempTree::new("wf-atomic");
        let locked = t.dir("locked");
        let target = locked.join("doc.txt");
        std::fs::write(&target, b"ORIGINAL").unwrap();
        let roots = vec![t.canon_root()];

        // r-x on the directory: existing files stay writable, but no entry can be
        // created (so an atomic temp+rename cannot even start).
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        // Root ignores dir permission bits (CI containers), so probe and skip if we can't be
        // blocked; `atomic_write_failure_leaves_the_target_intact` covers that case.
        let probe = locked.join(".root-probe");
        let cannot_block = std::fs::write(&probe, b"x").is_ok();
        let _ = std::fs::remove_file(&probe);
        if cannot_block {
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        let err = write_file_scoped(&target, "NEW CONTENT", &roots).unwrap_err();
        // Restore write so we can inspect and clean up.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            err, "permission denied",
            "expected a clean perm error: {err}"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "ORIGINAL",
            "the target was corrupted by a failed write — not atomic"
        );
        // No temp file was left behind next to the target.
        let leftovers: Vec<String> = std::fs::read_dir(&locked)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "doc.txt")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp litter left behind: {leftovers:?}"
        );
    }

    /// The atomic write preserves the original file's permission bits (a temp file
    /// would otherwise land with default umask perms).
    #[cfg(unix)]
    #[test]
    fn write_preserves_the_files_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let t = TempTree::new("wf-perms");
        let target = t.write("secret.env", b"KEY=old");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        let roots = vec![t.canon_root()];

        write_file_scoped(&target, "KEY=new", &roots).unwrap();

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "permissions must survive the atomic write");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "KEY=new");
    }

    // ── validate_name + resolve_new_in_scope helpers ──────────────────────────

    /// Every rejected + accepted branch of `validate_name`.
    #[test]
    fn validate_name_covers_every_branch() {
        assert_eq!(validate_name("").unwrap_err(), "name cannot be empty");
        assert_eq!(validate_name(".").unwrap_err(), "invalid name");
        assert_eq!(validate_name("..").unwrap_err(), "invalid name");
        assert_eq!(
            validate_name("a/b").unwrap_err(),
            "name cannot contain path separators"
        );
        assert_eq!(
            validate_name("a\\b").unwrap_err(),
            "name cannot contain path separators"
        );
        assert_eq!(
            validate_name("a\0b").unwrap_err(),
            "name cannot contain path separators"
        );
        assert!(validate_name("valid-name.txt").is_ok());
    }

    /// `resolve_new_in_scope` returns `real_parent.join(name)` for a not-yet-existing
    /// target whose parent exists and is in scope.
    #[test]
    fn resolve_new_in_scope_joins_onto_the_real_parent() {
        let t = TempTree::new("rns-ok");
        let roots = vec![t.canon_root()];
        let got = resolve_new_in_scope(&t.root.join("new.txt"), &roots).unwrap();
        assert_eq!(got, t.canon_root().join("new.txt"));
        assert!(!got.exists(), "the target itself must not need to exist");
    }

    /// A target whose PARENT is out of scope is rejected (the parent resolves through
    /// the same guard).
    #[test]
    fn resolve_new_in_scope_rejects_out_of_scope_parent() {
        let root = TempTree::new("rns-scope");
        let other = TempTree::new("rns-other");
        let roots = vec![root.canon_root()];
        let err = resolve_new_in_scope(&other.root.join("new.txt"), &roots).unwrap_err();
        assert!(err.contains("outside"), "out-of-scope parent leaked: {err}");
    }

    /// A target whose parent does not exist is rejected (parent canonicalize fails).
    #[test]
    fn resolve_new_in_scope_rejects_missing_parent() {
        let t = TempTree::new("rns-missing");
        let roots = vec![t.canon_root()];
        let err = resolve_new_in_scope(&t.root.join("ghost/new.txt"), &roots).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }

    /// A final component containing an embedded separator reaches `validate_name`
    /// through `resolve_new_in_scope` and is rejected before any fs touch. (A `\` on
    /// Unix stays within one component, so `file_name()` yields the whole `a\b`.)
    #[cfg(unix)]
    #[test]
    fn resolve_new_in_scope_rejects_a_bad_name() {
        let t = TempTree::new("rns-badname");
        let roots = vec![t.canon_root()];
        let err = resolve_new_in_scope(&t.root.join("a\\b"), &roots).unwrap_err();
        assert_eq!(err, "name cannot contain path separators");
    }

    /// A path whose final component is `..` collapses to *no* final component
    /// (`Path::file_name()` is `None` for a `..`-terminated path), so it is rejected
    /// as "target has no name" — still a rejection, never a create outside scope.
    #[test]
    fn resolve_new_in_scope_rejects_dotdot_as_no_name() {
        let t = TempTree::new("rns-dotdot");
        let roots = vec![t.canon_root()];
        let err = resolve_new_in_scope(&t.root.join(".."), &roots).unwrap_err();
        assert_eq!(err, "target has no name");
    }

    /// A parent that resolves to a FILE (not a directory) is rejected.
    #[test]
    fn resolve_new_in_scope_rejects_a_file_parent() {
        let t = TempTree::new("rns-fileparent");
        t.file("afile.txt");
        let roots = vec![t.canon_root()];
        let err = resolve_new_in_scope(&t.root.join("afile.txt/child"), &roots).unwrap_err();
        // The parent "afile.txt" exists + is in scope but is not a directory.
        assert_eq!(err, "parent is not a directory");
    }

    /// A requested path with no final component (e.g. the filesystem root) is rejected.
    #[test]
    fn resolve_new_in_scope_rejects_a_path_with_no_name() {
        let roots = vec![std::env::temp_dir()];
        let err = resolve_new_in_scope(Path::new("/"), &roots).unwrap_err();
        assert_eq!(err, "target has no parent directory");
    }

    /// `is_allowed_root` matches a canonicalized root and rejects a child.
    #[test]
    fn is_allowed_root_matches_only_the_root_itself() {
        let t = TempTree::new("iar");
        let child = t.dir("child");
        let roots = vec![t.canon_root()];
        assert!(is_allowed_root(&t.canon_root(), &roots));
        assert!(!is_allowed_root(
            &crate::paths::canonicalize(&child).unwrap(),
            &roots
        ));
    }

    // ── create_directory ──────────────────────────────────────────────────────

    /// Happy path: the new directory appears.
    #[test]
    fn create_directory_happy_path() {
        let t = TempTree::new("cd-ok");
        let roots = vec![t.canon_root()];
        create_directory_scoped(&t.root.join("newdir"), &roots).unwrap();
        assert!(t.root.join("newdir").is_dir());
    }

    /// Creating over an existing name is refused.
    #[test]
    fn create_directory_rejects_existing() {
        let t = TempTree::new("cd-exists");
        t.dir("already");
        let roots = vec![t.canon_root()];
        let err = create_directory_scoped(&t.root.join("already"), &roots).unwrap_err();
        assert_eq!(err, "a file or folder with that name already exists");
    }

    /// An out-of-scope parent is refused (nothing created).
    #[test]
    fn create_directory_rejects_out_of_scope_parent() {
        let root = TempTree::new("cd-scope");
        let other = TempTree::new("cd-other");
        let roots = vec![root.canon_root()];
        let err = create_directory_scoped(&other.root.join("newdir"), &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert!(!other.root.join("newdir").exists());
    }

    /// A name containing a path separator is refused. A backslash stays inside a
    /// single path component on Unix, so `file_name()` returns the whole `a\b` and
    /// `validate_name` catches the embedded separator.
    #[cfg(unix)]
    #[test]
    fn create_directory_rejects_a_name_with_a_separator() {
        let t = TempTree::new("cd-sep");
        let roots = vec![t.canon_root()];
        let err = create_directory_scoped(&t.root.join("a\\b"), &roots).unwrap_err();
        assert_eq!(err, "name cannot contain path separators");
    }

    /// A `..` final component is refused (it collapses to no final component, so the
    /// guard rejects it as "target has no name" — never a create above the parent).
    #[test]
    fn create_directory_rejects_dotdot() {
        let t = TempTree::new("cd-dotdot");
        let roots = vec![t.canon_root()];
        let err = create_directory_scoped(&t.root.join(".."), &roots).unwrap_err();
        assert_eq!(err, "target has no name");
    }

    /// A parent that does not exist is refused (no recursive create).
    #[test]
    fn create_directory_rejects_missing_parent() {
        let t = TempTree::new("cd-missing");
        let roots = vec![t.canon_root()];
        let err = create_directory_scoped(&t.root.join("ghost/newdir"), &roots).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
        assert!(!t.root.join("ghost").exists(), "no recursive create");
    }

    // ── create_file ───────────────────────────────────────────────────────────

    /// Happy path: an empty file appears and is a file.
    #[test]
    fn create_file_happy_path() {
        let t = TempTree::new("cf-ok");
        let roots = vec![t.canon_root()];
        create_file_scoped(&t.root.join("new.txt"), &roots).unwrap();
        let p = t.root.join("new.txt");
        assert!(p.is_file());
        assert_eq!(std::fs::read(&p).unwrap().len(), 0, "must be empty");
    }

    /// Creating over an existing name is refused.
    #[test]
    fn create_file_rejects_existing() {
        let t = TempTree::new("cf-exists");
        t.file("already.txt");
        let roots = vec![t.canon_root()];
        let err = create_file_scoped(&t.root.join("already.txt"), &roots).unwrap_err();
        assert_eq!(err, "a file or folder with that name already exists");
    }

    /// An out-of-scope parent is refused.
    #[test]
    fn create_file_rejects_out_of_scope() {
        let root = TempTree::new("cf-scope");
        let other = TempTree::new("cf-other");
        let roots = vec![root.canon_root()];
        let err = create_file_scoped(&other.root.join("new.txt"), &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    /// `create_new` is race-safe: creating the same file twice fails the second time
    /// (the existence pre-check would also catch it, but this pins the create_new arm).
    #[test]
    fn create_file_is_race_safe_create_new() {
        let t = TempTree::new("cf-race");
        let roots = vec![t.canon_root()];
        create_file_scoped(&t.root.join("race.txt"), &roots).unwrap();
        let err = create_file_scoped(&t.root.join("race.txt"), &roots).unwrap_err();
        assert_eq!(err, "a file or folder with that name already exists");
    }

    // ── rename_path ───────────────────────────────────────────────────────────

    /// Rename in the same dir: old name gone, new name present, content preserved.
    #[test]
    fn rename_in_same_dir_preserves_content() {
        let t = TempTree::new("mv-rename");
        let from = t.write("old.txt", b"payload");
        let roots = vec![t.canon_root()];
        rename_scoped(&from, &t.root.join("new.txt"), &roots).unwrap();
        assert!(!from.exists(), "old name must be gone");
        assert_eq!(std::fs::read(t.root.join("new.txt")).unwrap(), b"payload");
    }

    /// Move into a subdirectory keeps the basename and the content (round-trip).
    #[test]
    fn move_into_subdir_keeps_basename_and_content() {
        let t = TempTree::new("mv-move");
        let from = t.write("doc.txt", b"round-trip");
        t.dir("sub");
        let roots = vec![t.canon_root()];
        rename_scoped(&from, &t.root.join("sub/doc.txt"), &roots).unwrap();
        assert!(!from.exists());
        assert_eq!(
            std::fs::read(t.root.join("sub/doc.txt")).unwrap(),
            b"round-trip"
        );
    }

    /// A destination that already exists is refused (never clobber).
    #[test]
    fn rename_rejects_existing_destination() {
        let t = TempTree::new("mv-exists");
        let from = t.write("a.txt", b"a");
        t.write("b.txt", b"b");
        let roots = vec![t.canon_root()];
        let err = rename_scoped(&from, &t.root.join("b.txt"), &roots).unwrap_err();
        assert_eq!(err, "a file or folder with that name already exists");
        assert_eq!(std::fs::read(&from).unwrap(), b"a", "source untouched");
        assert_eq!(std::fs::read(t.root.join("b.txt")).unwrap(), b"b");
    }

    /// Renaming a workspace ROOT itself is refused.
    #[test]
    fn rename_rejects_moving_a_workspace_root() {
        let t = TempTree::new("mv-root");
        // A sibling temp dir to be the destination parent — but the source is the root.
        let roots = vec![t.canon_root()];
        let err = rename_scoped(&t.root, &t.root.join("renamed"), &roots).unwrap_err();
        assert_eq!(err, "cannot move a workspace root");
    }

    /// Moving a directory into its own subtree is refused.
    #[test]
    fn rename_rejects_moving_a_dir_into_itself() {
        let t = TempTree::new("mv-into-self");
        let dir = t.dir("parent");
        t.dir("parent/child");
        let roots = vec![t.canon_root()];
        // parent → parent/child/parent would orphan the tree.
        let err = rename_scoped(&dir, &t.root.join("parent/child/parent"), &roots).unwrap_err();
        assert_eq!(err, "cannot move a folder into itself");
    }

    /// An out-of-scope SOURCE is refused.
    #[test]
    fn rename_rejects_out_of_scope_source() {
        let root = TempTree::new("mv-src-scope");
        let other = TempTree::new("mv-src-other");
        let from = other.write("secret.txt", b"x");
        let roots = vec![root.canon_root()];
        let err = rename_scoped(&from, &root.root.join("here.txt"), &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    /// An out-of-scope DESTINATION parent is refused (nothing moved).
    #[test]
    fn rename_rejects_out_of_scope_destination() {
        let root = TempTree::new("mv-dst-scope");
        let other = TempTree::new("mv-dst-other");
        let from = root.write("here.txt", b"payload");
        let roots = vec![root.canon_root()];
        let err = rename_scoped(&from, &other.root.join("stolen.txt"), &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert!(from.exists(), "source must be untouched");
    }

    /// A symlink inside the root whose source points OUTSIDE it is rejected — the
    /// rename source canonicalizes to the out-of-root target.
    #[cfg(unix)]
    #[test]
    fn rename_rejects_a_symlink_escaping_the_root() {
        let root = TempTree::new("mv-esc-root");
        let outside = TempTree::new("mv-esc-outside");
        let target = outside.write("loot.txt", b"secret");
        std::os::unix::fs::symlink(&target, root.root.join("link.txt")).unwrap();
        let roots = vec![root.canon_root()];
        let err = rename_scoped(
            &root.root.join("link.txt"),
            &root.root.join("here.txt"),
            &roots,
        )
        .unwrap_err();
        assert!(
            err.contains("outside"),
            "symlink-escape rename leaked: {err}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"secret");
    }

    // ── delete_path ───────────────────────────────────────────────────────────

    /// Delete a file.
    #[test]
    fn delete_a_file() {
        let t = TempTree::new("del-file");
        let f = t.write("gone.txt", b"x");
        let roots = vec![t.canon_root()];
        delete_scoped(&f, &roots).unwrap();
        assert!(!f.exists());
    }

    /// Delete a non-empty directory recursively.
    #[test]
    fn delete_a_directory_recursively() {
        let t = TempTree::new("del-dir");
        let dir = t.dir("tree");
        t.file("tree/a.txt");
        t.dir("tree/nested");
        t.file("tree/nested/b.txt");
        let roots = vec![t.canon_root()];
        delete_scoped(&dir, &roots).unwrap();
        assert!(!dir.exists(), "the whole subtree must be gone");
    }

    /// Deleting a workspace root itself is refused.
    #[test]
    fn delete_rejects_a_workspace_root() {
        let t = TempTree::new("del-root");
        let roots = vec![t.canon_root()];
        let err = delete_scoped(&t.root, &roots).unwrap_err();
        assert_eq!(err, "cannot delete a workspace root");
        assert!(t.root.exists(), "the root must still be there");
    }

    /// An out-of-scope path is refused (nothing deleted).
    #[test]
    fn delete_rejects_out_of_scope() {
        let root = TempTree::new("del-scope");
        let other = TempTree::new("del-other");
        let victim = other.write("keep.txt", b"safe");
        let roots = vec![root.canon_root()];
        let err = delete_scoped(&victim, &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert!(victim.exists(), "out-of-scope file must be untouched");
    }

    /// A nonexistent path → `Err`.
    #[test]
    fn delete_errors_on_a_nonexistent_path() {
        let t = TempTree::new("del-noexist");
        let roots = vec![t.canon_root()];
        let err = delete_scoped(&t.root.join("ghost"), &roots).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }

    /// A symlink inside the root pointing OUTSIDE it is rejected — the delete target
    /// canonicalizes to the out-of-root target (so the real file is never removed).
    #[cfg(unix)]
    #[test]
    fn delete_rejects_a_symlink_escaping_the_root() {
        let root = TempTree::new("del-esc-root");
        let outside = TempTree::new("del-esc-outside");
        let target = outside.write("loot.txt", b"secret");
        std::os::unix::fs::symlink(&target, root.root.join("link.txt")).unwrap();
        let roots = vec![root.canon_root()];
        let err = delete_scoped(&root.root.join("link.txt"), &roots).unwrap_err();
        assert!(
            err.contains("outside"),
            "symlink-escape delete leaked: {err}"
        );
        assert!(target.exists(), "the real out-of-root file must survive");
    }

    // ── size-cap constants + boundaries (mutation-hardening) ──────────────────
    // Pinned to literals: the size-limit tests build their payloads FROM the consts.

    /// The preview / image caps are exactly the intended byte counts. Hardcoded
    /// literals, so a mutated `*`→`+`/`/` in the const definition is caught here even
    /// though `read_file_rejects_an_oversized_file` derives its payload from the const.
    #[test]
    fn size_cap_constants_are_the_expected_literals() {
        assert_eq!(MAX_PREVIEW_BYTES, 2_097_152, "2 MiB");
        assert_eq!(MAX_IMAGE_BYTES, 10_485_760, "10 MiB");
        assert_eq!(BINARY_SNIFF_BYTES, 8192);
    }

    /// The preview refusal uses a FIXED threshold independent of the constant: a file
    /// of a hardcoded 2 MiB + 1 bytes must be refused, and a hardcoded 2 MiB - 1 file
    /// accepted. Pins the threshold to `2_097_152` even if `MAX_PREVIEW_BYTES` drifts.
    #[test]
    fn read_file_size_threshold_is_two_mib_by_fixed_count() {
        let t = TempTree::new("rf-fixed");
        let roots = vec![t.canon_root()];

        // 2 MiB + 1 → refused.
        t.write("over.log", &vec![b'a'; 2_097_153]);
        assert_eq!(
            read_file_scoped(&t.root.join("over.log"), &roots).unwrap_err(),
            "file too large to preview"
        );
        // 2 MiB - 1 → accepted.
        t.write("under.log", &vec![b'a'; 2_097_151]);
        assert!(read_file_scoped(&t.root.join("under.log"), &roots).is_ok());
    }

    /// One byte over the cap is refused ("image too large"); exactly at the cap is accepted.
    /// A literal 10 MiB pins the threshold regardless of the constant's arithmetic.
    #[test]
    fn read_image_rejects_oversized_and_accepts_at_cap() {
        let t = TempTree::new("img-cap");
        let roots = vec![t.canon_root()];

        // One byte over 10 MiB → refused BEFORE the file is read/encoded.
        t.write("over.png", &vec![0u8; 10_485_761]);
        assert_eq!(
            read_image_scoped(&t.root.join("over.png"), &roots).unwrap_err(),
            "image too large"
        );

        // Exactly 10 MiB → accepted (boundary is strict `>`). Must be a real data URL.
        t.write("at.png", &vec![0u8; 10_485_760]);
        let url = read_image_scoped(&t.root.join("at.png"), &roots).unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "{}", &url[..40]);
    }

    // ── image_mime: every supported extension (mutation-hardening) ────────────

    /// Every supported image extension maps to its correct MIME (only png/svg were
    /// tested before, so the jpg/jpeg/gif/webp/bmp/ico/avif arms' deletions survived).
    /// Also covers case-insensitivity, an unknown extension, and a no-extension path.
    #[test]
    fn image_mime_maps_every_supported_extension() {
        let cases = [
            ("a.png", Some("image/png")),
            ("a.jpg", Some("image/jpeg")),
            ("a.jpeg", Some("image/jpeg")),
            ("a.gif", Some("image/gif")),
            ("a.webp", Some("image/webp")),
            ("a.bmp", Some("image/bmp")),
            ("a.ico", Some("image/x-icon")),
            ("a.svg", Some("image/svg+xml")),
            ("a.avif", Some("image/avif")),
            // Case-insensitive (the fn lowercases the extension).
            ("a.PNG", Some("image/png")),
            ("a.JPEG", Some("image/jpeg")),
            // Not an image, and no extension at all → None.
            ("a.txt", None),
            ("noext", None),
        ];
        for (name, expected) in cases {
            assert_eq!(
                image_mime(Path::new(name)),
                expected,
                "wrong MIME for {name}"
            );
        }
    }

    /// `None` is INTENDED; this test stops a "fix". `image_mime` takes a path, and the last gate
    /// before the webview must not learn URL syntax; the frontend resolves `src` to a path first.
    #[test]
    fn image_mime_never_parses_a_url_query_string() {
        assert_eq!(image_mime(Path::new("logo.png?v=2")), None);
        assert_eq!(image_mime(Path::new("logo.png#anchor")), None);
        assert_eq!(image_mime(Path::new("logo.svg?raw=true")), None);
        // The bare name still works — so the assertions above are about the query,
        // not about the whole function having been broken.
        assert_eq!(image_mime(Path::new("logo.png")), Some("image/png"));
    }

    // ── the file-reading commands must not run on the event-loop thread ───────

    /// A sync command runs inline on the event-loop thread, so a slow `fs::read` freezes the UI.
    /// Pinned at compile time: without `async` (and a `Send` future) this test stops building.
    #[test]
    fn the_file_reading_commands_are_async_and_never_block_the_event_loop() {
        fn assert_async<A, B, R: std::future::Future + Send>(_command: fn(A, B) -> R) {}
        assert_async(read_file);
        assert_async(read_image_data_url);
    }

    // ── map_io_err: exact strings + PermissionDenied folding ──────────────────

    /// Pins the literal strings and the `PermissionDenied` arm (deleting it would fall through
    /// to the generic `cannot {action}: {e}` branch).
    #[test]
    fn map_io_err_folds_permission_denied_and_formats_others() {
        use std::io::{Error, ErrorKind};

        // PermissionDenied → the exact shared string, for every action label.
        for action in ["create directory", "create file", "rename", "delete"] {
            let e = Error::from(ErrorKind::PermissionDenied);
            assert_eq!(map_io_err(action, &e), "permission denied");
        }

        // A different kind → the generic "cannot {action}: {e}" form, carrying the
        // action verbatim (so a `""`/`"xyzzy"` mutation of that arm is caught).
        let e = Error::new(ErrorKind::NotFound, "boom");
        let msg = map_io_err("rename", &e);
        assert!(msg.starts_with("cannot rename: "), "got: {msg}");
        assert!(
            msg.contains("boom"),
            "must carry the underlying error: {msg}"
        );
        assert_ne!(msg, "permission denied", "must NOT fold a non-perm error");
    }
}
