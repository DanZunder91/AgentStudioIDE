//! The one writer for the app's JSON stores: a per-file process-wide lock for
//! load → modify → save, and a crash-safe atomic replace with a **unique** temp name.
//!
//! **Why.** `api-store.json` (the Vault) has four writers — the webview's blob save, the folder
//! commands, a DB password saved "forever", and a portability import — and before this module none
//! of them took a lock, and every one wrote the same fixed temp name (`api-store.json.tmp`),
//! `remove_file`-ing it before `create_new`. So:
//! * two concurrent load → edit → save cycles lost one update (the second save wrote a store
//!   loaded before the first save landed); and
//! * writer B could delete writer A's half-written temp, or rename it into place, or A could
//!   rename B's — a torn or foreign file where a store should be.
//!
//! The fix, on every OS:
//! * [`lock`] — one re-entrant lock per store file, held across the whole read-modify-write.
//!   Re-entrant on the same thread, so a caller holding it (an import editing three stores) can
//!   still call a `save` that takes it again without deadlocking.
//! * [`write_atomic`] — a sibling temp named `<file>.<ulid>.tmp` (unique per write, so no
//!   writer can touch another's), `create_new`, `sync_all`, `rename` over the target, and the
//!   temp removed on ANY failure — it may hold secrets, and a leftover is a copy nobody tracks.
//!   A crash can still strand one between the fsync and the rename, so each write also removes
//!   the store's temps older than [`STALE_TEMP_AGE`].
//!   `private` makes both the temp and the result `0600` on unix (born that way, never chmod-ed
//!   after the bytes are in).
//!
//! **Windows only:** `rename` over a file that another process holds open without
//! `FILE_SHARE_DELETE` — antivirus scanning the new file, the search indexer, an editor —
//! fails with `ERROR_ACCESS_DENIED` (5) or `ERROR_SHARING_VIOLATION` (32). Those holds are
//! brief, so the rename is retried with a short backoff ([`RENAME_BACKOFF`]) and then fails
//! cleanly. macOS and Linux replace an open file without complaint and never retry.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock, PoisonError};
use std::thread::ThreadId;

/// One file's lock: the owning thread and its re-entry depth.
struct FileLock {
    state: Mutex<(Option<ThreadId>, usize)>,
    freed: Condvar,
}

/// Held while a store file is being read-modified-written. Dropping it releases the lock
/// (once the outermost guard on this thread drops).
pub struct StoreGuard {
    lock: &'static FileLock,
}

impl Drop for StoreGuard {
    fn drop(&mut self) {
        let mut s = self
            .lock
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        s.1 -= 1;
        if s.1 == 0 {
            s.0 = None;
            self.lock.freed.notify_all();
        }
    }
}

/// The map key for `path`: absolute, and on Windows case-folded (`C:\X\a.json` and
/// `c:\x\A.json` are one file there).
fn key(path: &Path) -> PathBuf {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    if cfg!(windows) {
        PathBuf::from(abs.to_string_lossy().to_lowercase())
    } else {
        abs
    }
}

/// Take the process-wide lock for the store at `path`, blocking until no other thread holds
/// it. Re-entrant on the same thread. Hold it across load → modify → save; [`write_atomic`]
/// alone does not take it (a `save` that only replaces the whole file still should, so it
/// queues behind an in-flight edit instead of overwriting it).
pub fn lock(path: &Path) -> StoreGuard {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static FileLock>>> = OnceLock::new();
    let lock: &'static FileLock = {
        let mut map = LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Leaked on purpose: one small struct per store file for the life of the process
        // (the app has a handful of stores; tests a few hundred temp paths).
        map.entry(key(path)).or_insert_with(|| {
            Box::leak(Box::new(FileLock {
                state: Mutex::new((None, 0)),
                freed: Condvar::new(),
            }))
        })
    };
    let me = std::thread::current().id();
    let mut s = lock.state.lock().unwrap_or_else(PoisonError::into_inner);
    loop {
        match s.0 {
            None => {
                *s = (Some(me), 1);
                break;
            }
            Some(owner) if owner == me => {
                s.1 += 1;
                break;
            }
            Some(_) => s = lock.freed.wait(s).unwrap_or_else(PoisonError::into_inner),
        }
    }
    StoreGuard { lock }
}

/// A fresh sibling temp name for `path`: `<file name>.<ulid>.tmp`. Unique per call, in the
/// same directory (so the rename stays on one file system and is atomic).
pub fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "store".to_string());
    path.with_file_name(format!("{name}.{}.tmp", ulid::Ulid::new()))
}

/// Waits between rename attempts on Windows: 5 tries over ~380 ms in total.
pub const RENAME_BACKOFF: &[u64] = &[10, 20, 50, 100, 200];

/// A temp of a store this much older than now is an orphan (a write takes milliseconds), and is
/// removed by the next write of that store. Generous on purpose: a second app instance's write in
/// flight must never be swept from under it.
pub const STALE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(60);

/// Is `candidate` a temp of the store named `name`? This module's `<name>.<ulid>.tmp`, or
/// `<name>.tmp` — the fixed name every store used in older builds.
fn is_temp_of(name: &str, candidate: &str) -> bool {
    let Some(rest) = candidate
        .strip_prefix(name)
        .and_then(|r| r.strip_prefix('.'))
    else {
        return false;
    };
    let Some(middle) = rest.strip_suffix("tmp") else {
        return false;
    };
    middle.is_empty()
        || middle
            .strip_suffix('.')
            .is_some_and(|id| ulid::Ulid::from_string(id).is_ok())
}

/// Remove `path`'s temps last written [`STALE_TEMP_AGE`] or more before `now`.
/// A crash between the temp's `fsync` and the rename leaves one behind, and every
/// write uses a new name, so nothing else would ever remove it, and for the Vault, history
/// and DB stores it is a full copy of their secrets. The same goes for a temp whose `remove_file`
/// failed because antivirus still held it. Best-effort: a sweep that fails must not fail the save.
fn sweep_stale_temps(path: &Path, now: std::time::SystemTime) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let dir = if dir.as_os_str().is_empty() {
        Path::new(".")
    } else {
        dir
    };
    let name = name.to_string_lossy();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !is_temp_of(&name, &entry.file_name().to_string_lossy()) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).unwrap_or_default() >= STALE_TEMP_AGE);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write `bytes` to `path` crash-safely (module doc). Creates the parent dir. `private`:
/// owner-only `0600` on unix (a no-op elsewhere — Windows' per-user profile ACL is the
/// equivalent there). Also removes the store's orphaned temps ([`sweep_stale_temps`]).
pub fn write_atomic(path: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    sweep_stale_temps(path, std::time::SystemTime::now());
    let tmp = temp_path(path);
    let written = write_temp(&tmp, bytes, private).and_then(|()| rename_replacing(&tmp, path));
    if written.is_err() {
        // The temp may hold a secret: never leave it behind, whatever failed.
        let _ = std::fs::remove_file(&tmp);
    }
    written?;
    #[cfg(unix)]
    {
        if private {
            use std::os::unix::fs::PermissionsExt;
            // Best-effort: a filesystem that cannot express the mode must not fail the save.
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    Ok(())
}

/// Create `tmp` (never an existing file — `create_new`), write, and `fsync` before the rename.
fn write_temp(tmp: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        if private {
            // Born 0600: a umask-mode temp is readable by other
            // users between create and a later chmod, and an fd opened then survives it.
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut f = opts.open(tmp)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// `rename(from, to)`, replacing `to`. On Windows a transient share-mode refusal is retried
/// ([`RENAME_BACKOFF`]); elsewhere one attempt.
fn rename_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    rename_with_retry(from, to, if cfg!(windows) { RENAME_BACKOFF } else { &[] }).map(|_| ())
}

/// Is `e` the transient "someone has the target open without delete-sharing" refusal? Only
/// Windows raises these codes from a rename; on other OSes the numbers mean something else, so
/// it is `false` there.
fn is_transient_share_error(e: &std::io::Error) -> bool {
    cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32))
}

/// The retry loop, with the waits as a parameter. Returns how many attempts it took (tests
/// prove the retry happened, not only that the write ended up on disk).
fn rename_with_retry(from: &Path, to: &Path, backoff_ms: &[u64]) -> std::io::Result<usize> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(attempt),
            Err(e) if is_transient_share_error(&e) && attempt <= backoff_ms.len() => {
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms[attempt - 1]));
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("store-file-{tag}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Only the target remains in the directory: no temp of any name.
    fn only_target_left(dir: &Path, target: &str) {
        let names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![target.to_string()], "leftover files in {dir:?}");
    }

    #[test]
    fn every_write_gets_its_own_temp_name_beside_the_target() {
        let p = Path::new("dir").join("api-store.json");
        let names: std::collections::HashSet<PathBuf> = (0..500).map(|_| temp_path(&p)).collect();
        assert_eq!(names.len(), 500, "temp names must never repeat");
        for t in names.iter().take(3) {
            assert_eq!(t.parent(), p.parent(), "same directory → atomic rename");
            let n = t.file_name().unwrap().to_string_lossy();
            assert!(
                n.starts_with("api-store.json.") && n.ends_with(".tmp"),
                "{n}"
            );
        }
    }

    #[test]
    fn a_write_replaces_the_file_and_leaves_no_temp() {
        let dir = temp_dir("ok");
        let p = dir.join("s.json");
        write_atomic(&p, b"one", true).unwrap();
        write_atomic(&p, b"two", true).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        only_target_left(&dir, "s.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Set `path`'s last-modified time to `age` ago.
    fn backdate(path: &Path, age: std::time::Duration) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(std::time::SystemTime::now() - age).unwrap();
    }

    /// A crash between the temp's fsync and the rename leaves `<store>.<ulid>.tmp`, a copy of
    /// the store's secrets, and a new name per write means nothing else ever removes it.
    /// The next write of that store does, and touches nothing else.
    #[test]
    fn a_write_sweeps_its_stores_orphaned_temps_and_nothing_else() {
        let dir = temp_dir("sweep");
        let target = dir.join("api-store.json");
        let old = STALE_TEMP_AGE + std::time::Duration::from_secs(5);
        let orphan = temp_path(&target);
        let legacy = dir.join("api-store.json.tmp"); // the fixed name in older builds
        let in_flight = temp_path(&target); // e.g. a second instance mid-write: too young
        let other_store = temp_path(&dir.join("history.json"));
        let unrelated = dir.join("api-store.json.bak");
        let lookalike = dir.join("api-store.json.notaulid.tmp");
        for (p, age) in [
            (&orphan, old),
            (&legacy, old),
            (&in_flight, std::time::Duration::ZERO),
            (&other_store, old),
            (&unrelated, old),
            (&lookalike, old),
        ] {
            std::fs::write(p, "secret").unwrap();
            backdate(p, age);
        }

        write_atomic(&target, b"{}", true).unwrap();

        assert!(!orphan.exists(), "an orphaned temp survived the write");
        assert!(
            !legacy.exists(),
            "the old fixed-name temp survived the write"
        );
        for kept in [&in_flight, &other_store, &unrelated, &lookalike] {
            assert!(kept.exists(), "{kept:?} must not be swept");
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn temp_names_are_recognised_exactly() {
        let id = ulid::Ulid::new();
        assert!(is_temp_of("a.json", "a.json.tmp"));
        assert!(is_temp_of("a.json", &format!("a.json.{id}.tmp")));
        for not_a_temp in [
            "a.json".to_string(),
            "ba.json.tmp".to_string(),
            "a.jsonx.tmp".to_string(),
            "a.json.x.tmp".to_string(),
            "a.json.tmpx".to_string(),
            format!("a.json.{id}.tmp.bak"),
            format!("b.json.{id}.tmp"),
        ] {
            assert!(!is_temp_of("a.json", &not_a_temp), "{not_a_temp}");
        }
    }

    /// A rename that cannot happen (the target is a non-empty directory) fails the write —
    /// and the temp, which may hold a secret, is gone.
    #[test]
    fn a_failed_write_removes_its_temp() {
        let dir = temp_dir("fail");
        let target = dir.join("s.json");
        std::fs::create_dir_all(target.join("inside")).unwrap();
        assert!(write_atomic(&target, b"secret", true).is_err());
        only_target_left(&dir, "s.json");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_lock_is_reentrant_on_one_thread_and_exclusive_across_threads() {
        let p = temp_dir("lock").join("x.json");
        let outer = lock(&p);
        let inner = lock(&p); // same thread: no deadlock
        let p2 = p.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let t = std::thread::spawn(move || {
            let _g = lock(&p2);
            tx.send(()).unwrap();
        });
        drop(inner);
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(150))
                .is_err(),
            "another thread got in while the outer guard was held"
        );
        drop(outer);
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("released after the outer guard");
        t.join().unwrap();
    }

    /// Many threads each doing load → add one key → save on ONE file: with the lock every key
    /// survives. (Without it, a save from a store loaded before another thread's save drops
    /// that thread's key — the Vault's lost update.)
    #[test]
    fn concurrent_read_modify_writes_lose_nothing() {
        let dir = temp_dir("rmw");
        let p = Arc::new(dir.join("store.json"));
        write_atomic(&p, b"{}", false).unwrap();
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let p = Arc::clone(&p);
                std::thread::spawn(move || {
                    for j in 0..5 {
                        let _g = lock(&p);
                        let text = std::fs::read_to_string(&*p).unwrap();
                        let mut map: HashMap<String, u32> = serde_json::from_str(&text).unwrap();
                        std::thread::yield_now();
                        map.insert(format!("k{i}-{j}"), i);
                        let json = serde_json::to_vec(&map).unwrap();
                        write_atomic(&p, &json, false).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let map: HashMap<String, u32> =
            serde_json::from_str(&std::fs::read_to_string(&*p).unwrap()).unwrap();
        assert_eq!(map.len(), 80, "updates were lost");
        only_target_left(&dir, "store.json");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn off_windows_share_codes_are_not_retried() {
        let e = std::io::Error::from_raw_os_error(32);
        assert_eq!(is_transient_share_error(&e), cfg!(windows));
        assert!(!is_transient_share_error(&std::io::Error::other("x")));
    }

    /// Open `path` the way an antivirus scanner or an editor might: reading, sharing read and
    /// write but NOT delete — which is what makes a rename over it fail on Windows.
    #[cfg(windows)]
    fn hold_without_delete_sharing(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        const FILE_SHARE_WRITE: u32 = 2;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
            .unwrap()
    }

    /// The first rename fails while the target is held; the hold ends; a retry succeeds.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_rename_over_a_briefly_held_file_is_retried_until_it_lands() {
        let dir = temp_dir("held");
        let target = dir.join("s.json");
        std::fs::write(&target, "old").unwrap();
        let held = hold_without_delete_sharing(&target);
        let tmp = dir.join("s.json.new.tmp");
        std::fs::write(&tmp, "new").unwrap();
        // Precondition, so the test cannot pass without exercising the retry: a single
        // rename really is refused with a share code while the hold lasts.
        let refused = std::fs::rename(&tmp, &target).unwrap_err();
        assert!(is_transient_share_error(&refused), "{refused:?}");
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            drop(held);
        });
        let attempts = rename_with_retry(&tmp, &target, RENAME_BACKOFF).expect("retried");
        release.join().unwrap();
        assert!(
            attempts > 1,
            "succeeded at once — the hold was not in effect"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");

        // The same through the real writer: `write_atomic` must use the retrying rename.
        let held = hold_without_delete_sharing(&target);
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            drop(held);
        });
        write_atomic(&target, b"newer", true).expect("the writer retries a briefly-held target");
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "newer");
        only_target_left(&dir, "s.json");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A hold that outlasts every retry fails the write cleanly: an error, the old content
    /// intact, and no temp left behind.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_hold_that_outlasts_the_retries_fails_cleanly() {
        let dir = temp_dir("stuck");
        let target = dir.join("s.json");
        std::fs::write(&target, "old").unwrap();
        let held = hold_without_delete_sharing(&target);
        let err = write_atomic(&target, b"new", true).unwrap_err();
        assert!(is_transient_share_error(&err), "{err:?}");
        drop(held);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
        only_target_left(&dir, "s.json");
        let _ = std::fs::remove_dir_all(dir);
    }
}
