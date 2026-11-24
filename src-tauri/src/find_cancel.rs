//! The live-search registry — what makes a project-wide search **killable**.
//!
//! ## The bug this exists for
//!
//! `find_in_files` (Mod+Shift+F) and `find_files` (Mod+Shift+O) were synchronous
//! `#[tauri::command]`s. A sync command is dispatched **inline on the thread processing the
//! IPC message** — `tauri::ipc::InvokeResolver::respond`, reached because
//! `tauri-macros`' `WrapperAttributes::execution_context` defaults to
//! `ExecutionContext::Blocking` — so a multi-second `ignore::WalkBuilder` walk over a big
//! repo froze the whole window, terminals included. Two features in this crate had already
//! learned this and written it down (`portability::blocking`: *"a synchronous
//! `#[tauri::command]` would spend it blocking the webview"*; `metrics::claude_metrics`:
//! *"so the supervisor loop and the PTY hot path never see a filesystem sweep"*). Find never
//! got the same treatment. It has it now: both commands are `async` and hand the walk to
//! `tokio::task::spawn_blocking`.
//!
//! **Moving the walk off the main thread is a precondition for this module, not a separate
//! improvement.** While a sync search held the event-loop thread, a `find_cancel` invoke
//! could not even be *dispatched* — the cancel would have queued up behind the thing it was
//! asked to stop. Same shape as `db_cancel` (see `db/session.rs`): a cancel signal has to
//! be reachable without touching anything the running work holds.
//!
//! ## Shape
//!
//! A `LazyLock<Mutex<HashMap<…>>>` keyed by a frontend-minted `searchId`, exactly the
//! idiom of `ws.rs::CONNECTIONS` and `db/session.rs::SESSIONS`, and for the same reason
//! given there: it keeps the commands free of a `State<…>` parameter and therefore callable
//! from a test without standing up an `AppHandle`.
//!
//! **Lock discipline.** A plain `std::sync::Mutex` is enough, and every critical section is
//! a single `insert` / `get` / `remove` — the guard never outlives one statement, and it is
//! **never held across an `.await`** (the classic way to deadlock a tokio runtime). What
//! crosses the thread boundary into the blocking pool is an `Arc<AtomicBool>`, never a
//! guard: the walk reads a lock-free flag, and `find_cancel` writes it without ever queuing
//! behind the search.
//!
//! **The entry is owned by a guard, not by the code path.** [`begin`] returns a
//! [`SearchHandle`] whose `Drop` removes the id — so the entry is cleaned up on success, on
//! error, on cancel, on an early `?`, and on a panic. A registry that leaked one flag per
//! keystroke would be a slow memory leak in the most-typed-in surface of the app.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

/// The exact `Err` string a cancelled search returns.
///
/// A **bare sentinel**, deliberately: the frontend matches on it to drop the result
/// silently, and a cancel is not something the user should ever see an error toast for.
/// The two find modules otherwise use `"<code>: <detail>"` only where there *is* a detail
/// (`invalid regex: …`, `invalid glob: …`); the detail-free errors there are bare sentences
/// too (`path is not a directory`, `path does not exist`), so this matches house style.
pub const CANCELLED: &str = "cancelled";

/// Every in-flight cancellable search, keyed by the frontend-minted `searchId`.
///
/// An entry existing *is* a search being live — same "the registry is the truth" rule as
/// `ws.rs::CONNECTIONS`. A search launched without an id (the back-compat path) is simply
/// absent here, and is therefore uncancellable rather than special-cased.
///
/// 🔴 **The value is a `Vec`, and that is the whole point.** With one flag per id, a second
/// `begin` on the same id would *replace* the first — and the walk it belonged to would run
/// to completion with nobody able to stop it. That is not hypothetical: an "All workspaces"
/// search fans out to one `invoke` per root, and the obvious implementation gives the whole
/// batch one id. So an id addresses a **set** of live searches, [`cancel`] flags every
/// member, and a duplicate id is safe by construction instead of safe by frontend
/// convention. Callers are still free to mint one id per leg; they are simply no longer
/// *required* to, and nothing silently orphans a walk if they don't.
static SEARCHES: LazyLock<Mutex<HashMap<String, Vec<Arc<AtomicBool>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A live search's registry slot. Holding one is what keeps the search cancellable;
/// dropping one is what removes it from [`SEARCHES`].
pub struct SearchHandle {
    /// `None` for a search that was launched without a `searchId` — nothing was registered,
    /// so nothing is removed.
    id: Option<String>,
    flag: Arc<AtomicBool>,
}

impl SearchHandle {
    /// The flag to hand to the walk. Cloned rather than borrowed so it can cross into
    /// `spawn_blocking` while the handle stays on the async side (which is what guarantees
    /// the `Drop` below runs on every exit path).
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }
}

impl Drop for SearchHandle {
    fn drop(&mut self) {
        let Some(id) = &self.id else { return };
        let mut map = SEARCHES.lock().expect("find-cancel mutex poisoned");
        // Remove OUR flag by identity, never the id's whole entry: a sibling search sharing
        // this id may still be running. The entry itself goes only when its last member
        // leaves, so an id that is finished with leaves nothing behind. The frontend calls
        // this pair on every keystroke, so it stays a hash lookup plus a retain over a
        // one- or two-element vector.
        if let Some(flags) = map.get_mut(id) {
            flags.retain(|live| !Arc::ptr_eq(live, &self.flag));
            if flags.is_empty() {
                map.remove(id);
            }
        }
    }
}

/// Register a search and return the handle that owns its registry slot.
///
/// `id` is `None` for a caller that did not mint a `searchId`: the search still runs, it is
/// simply not cancellable. That is the back-compat path, and it is a plain absence rather
/// than a branch anywhere else.
///
/// **A duplicate id is legal.** Two concurrent searches may share one `searchId` — a
/// fan-out over several workspace roots is the case that motivates it — and one [`cancel`]
/// then stops all of them. See [`SEARCHES`].
pub fn begin(id: Option<String>) -> SearchHandle {
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(id) = &id {
        SEARCHES
            .lock()
            .expect("find-cancel mutex poisoned")
            .entry(id.clone())
            .or_default()
            .push(Arc::clone(&flag));
    }
    SearchHandle { id, flag }
}

/// Flag every live search registered under `id` as cancelled. `true` if at least one was.
///
/// `false` means "there is nothing to cancel". It does **not** distinguish an id that was
/// never registered from one whose search has already finished and dropped its slot — the
/// registry deliberately keeps no tombstones, so those two are the same observation. A
/// cancel racing a completion is the normal case, not a failure, and neither caller has
/// anything different to do about it.
pub fn cancel(id: &str) -> bool {
    // Clone the `Arc`s out and release the map lock BEFORE storing, so a cancel never holds
    // the registry lock for longer than a hash lookup — it must never queue behind the thing
    // it was asked to stop.
    let flags = SEARCHES
        .lock()
        .expect("find-cancel mutex poisoned")
        .get(id)
        .cloned()
        .unwrap_or_default();
    for flag in &flags {
        flag.store(true, Ordering::Relaxed);
    }
    !flags.is_empty()
}

/// Has this search been cancelled? `None` (no `searchId`) is never cancelled.
///
/// `Relaxed` on purpose: the flag *is* the whole message — no other memory is published
/// through it — so this is a plain load with no fence, cheap enough to run once per
/// directory entry and once per matched line without measurably slowing a walk.
pub(crate) fn is_cancelled(flag: Option<&AtomicBool>) -> bool {
    flag.is_some_and(|f| f.load(Ordering::Relaxed))
}

/// Cancel an in-flight `find_in_files` / `find_files`.
///
/// Frontend contract: `invoke<boolean>('find_cancel', { searchId })` → `true` if at least
/// one live search was flagged, `false` if there was nothing to cancel. `false` is
/// best-effort information, not an error: it cannot tell an unknown id from a search that
/// finished a microsecond ago, and nothing should be surfaced to the user either way.
///
/// One id may cover several concurrent searches (a fan-out over workspace roots); all of
/// them are flagged. See [`begin`].
///
/// Deliberately **synchronous**: it is one hash lookup plus a handful of atomic stores, and
/// a cancel wants the shortest possible path from keystroke to flag. That is only safe
/// because the searches themselves are now `async` + `spawn_blocking` — see the module doc.
#[tauri::command]
pub fn find_cancel(search_id: String) -> bool {
    cancel(&search_id)
}

/// How many `searchId`s currently have at least one live search. Test-only.
///
/// Ids, not searches: an id covering a two-leg fan-out counts once. Zero means the registry
/// is genuinely empty, which is the assertion the leak tests care about.
#[cfg(test)]
pub(crate) fn live_count() -> usize {
    SEARCHES.lock().expect("find-cancel mutex poisoned").len()
}

/// Serialises every test that observes the *whole* registry.
///
/// `cargo test` runs the suite as parallel threads in ONE process, so [`SEARCHES`] is
/// shared across `find`, `find_files` and this module's tests. "the map is empty afterwards"
/// is only a meaningful assertion if no sibling test has a search registered at the same
/// moment. Any test that calls [`begin`] (directly or through `run_find*`) takes this first.
/// A poisoned gate is recovered rather than propagated — one failing test must not cascade
/// into every other test in the group.
#[cfg(test)]
pub(crate) static REGISTRY_GATE: Mutex<()> = Mutex::new(());

/// Lock [`REGISTRY_GATE`], ignoring poisoning.
#[cfg(test)]
pub(crate) fn registry_gate() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_GATE.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(label: &str) -> String {
        format!("{label}-{}", ulid::Ulid::new())
    }

    #[test]
    fn cancel_flags_a_live_search_and_reports_true() {
        let _gate = registry_gate();
        let handle = begin(Some(id("live")));
        let flag = handle.flag();

        // Two-sided: a fresh search is NOT cancelled...
        assert!(
            !is_cancelled(Some(&flag)),
            "a search must start un-cancelled"
        );
        // ...and `cancel` both reports the hit and actually sets the flag the walk reads.
        assert!(cancel(handle.id.as_ref().unwrap()), "a live id must be hit");
        assert!(
            is_cancelled(Some(&flag)),
            "cancel must set the flag the walk polls"
        );
    }

    #[test]
    fn cancel_of_an_unknown_id_reports_false() {
        let _gate = registry_gate();
        assert!(!cancel(&id("never-registered")));
    }

    #[test]
    fn cancel_after_the_search_ended_reports_false() {
        let _gate = registry_gate();
        let key = id("finished");
        {
            let _handle = begin(Some(key.clone()));
            assert!(cancel(&key), "live while the handle is alive");
        }
        // The handle dropped — the search is over, so there is nothing left to cancel.
        assert!(
            !cancel(&key),
            "a finished search must no longer be cancellable"
        );
    }

    #[test]
    fn the_registry_is_empty_after_every_handle_drops() {
        let _gate = registry_gate();
        assert_eq!(live_count(), 0, "gate held: the registry starts clean");

        let keys: Vec<String> = (0..25).map(|i| id(&format!("leak{i}"))).collect();
        {
            let _handles: Vec<SearchHandle> = keys.iter().map(|k| begin(Some(k.clone()))).collect();
            assert_eq!(live_count(), 25, "all 25 are registered while they run");
        }
        assert_eq!(
            live_count(),
            0,
            "every slot must be released — one leaked flag per keystroke is a memory leak"
        );
    }

    #[test]
    fn a_search_without_an_id_registers_nothing_but_still_gets_a_flag() {
        let _gate = registry_gate();
        assert_eq!(live_count(), 0);
        let handle = begin(None);
        assert_eq!(live_count(), 0, "no searchId means no registry slot");
        // It still has a (permanently false) flag, so the walk needs no special case.
        assert!(!is_cancelled(Some(&handle.flag())));
        drop(handle);
        assert_eq!(live_count(), 0);
    }

    /// 🔴 The regression this registry was reshaped for. Two concurrent searches sharing one
    /// `searchId` — which is what an "All workspaces" fan-out produces if the batch gets one
    /// id — must BOTH be cancellable by one call. With a single flag per id the second
    /// `begin` replaced the first and that walk ran to completion, uncancellable, with
    /// nothing anywhere reporting a problem.
    #[test]
    fn two_searches_sharing_one_id_are_both_cancelled_by_one_call() {
        let _gate = registry_gate();
        let key = id("fan-out");
        let leg_a = begin(Some(key.clone()));
        let leg_b = begin(Some(key.clone()));
        let (flag_a, flag_b) = (leg_a.flag(), leg_b.flag());

        // Two-sided: neither leg is cancelled before the call...
        assert!(!is_cancelled(Some(&flag_a)));
        assert!(!is_cancelled(Some(&flag_b)));

        assert!(cancel(&key), "a shared id must report the hit");
        // ...and ONE cancel reaches BOTH. The second assertion is the one that used to fail.
        assert!(is_cancelled(Some(&flag_a)), "the first leg must be flagged");
        assert!(
            is_cancelled(Some(&flag_b)),
            "the second leg must be flagged too — no walk may be orphaned"
        );
    }

    /// A shared id's entry survives until its LAST member leaves: one leg finishing must not
    /// make its still-running sibling uncancellable.
    #[test]
    fn a_shared_id_stays_cancellable_until_its_last_search_ends() {
        let _gate = registry_gate();
        let key = id("shared-lifetime");
        let leg_a = begin(Some(key.clone()));
        let leg_b = begin(Some(key.clone()));
        let flag_b = leg_b.flag();
        assert_eq!(live_count(), 1, "one id, however many legs are under it");

        drop(leg_a); // the first leg finishes early
        assert_eq!(live_count(), 1, "the id is still live while a leg runs");
        assert!(cancel(&key), "the surviving leg is still cancellable");
        assert!(is_cancelled(Some(&flag_b)));

        drop(leg_b);
        assert_eq!(live_count(), 0, "the last leg out takes the entry with it");
        assert!(!cancel(&key), "and the id is then unknown again");
    }

    #[test]
    fn the_cancelled_sentinel_is_bare() {
        // The frontend matches this literal to drop a result silently; a `<code>: <detail>`
        // shape here would show the user an error toast for their own cancel.
        assert_eq!(CANCELLED, "cancelled");
    }
}
