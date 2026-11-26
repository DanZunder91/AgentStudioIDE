//! Live-search registry making `find_in_files`/`find_files` cancellable. Both are `async` +
//! `spawn_blocking`: a sync command runs on the IPC thread, freezing the window and the cancel.
//! The std lock is never held across `.await`; the walk polls an `Arc<AtomicBool>`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

/// The `Err` a cancelled search returns: a bare sentinel the frontend drops without a toast.
pub const CANCELLED: &str = "cancelled";

/// In-flight cancellable searches by `searchId`; absent = not cancellable. A `Vec` per id so an
/// "All workspaces" fan-out sharing one id is fully cancelled, never orphaning a walk.
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
        // Remove only our flag (a sibling may share this id); the entry goes with its last member.
        if let Some(flags) = map.get_mut(id) {
            flags.retain(|live| !Arc::ptr_eq(live, &self.flag));
            if flags.is_empty() {
                map.remove(id);
            }
        }
    }
}

/// Register a search; the handle owns its registry slot. `id: None` runs uncancellable. Duplicate
/// ids are legal: one [`cancel`] stops them all.
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

/// Flag every live search under `id`; `true` if any. `false` cannot tell an unknown id from a
/// finished one (no tombstones), and a cancel racing completion is normal.
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

/// Has this search been cancelled? `None` never is. `Relaxed`: the flag publishes nothing else, so
/// a plain load is cheap enough per entry and per line.
pub(crate) fn is_cancelled(flag: Option<&AtomicBool>) -> bool {
    flag.is_some_and(|f| f.load(Ordering::Relaxed))
}

/// Contract: `invoke<boolean>('find_cancel', { searchId })`; `false` = nothing to cancel, never
/// surfaced. Synchronous for the shortest keystroke-to-flag path, safe because the searches are
/// `async`.
#[tauri::command]
pub fn find_cancel(search_id: String) -> bool {
    cancel(&search_id)
}

/// Ids with at least one live search (test-only); zero means the registry is empty.
#[cfg(test)]
pub(crate) fn live_count() -> usize {
    SEARCHES.lock().expect("find-cancel mutex poisoned").len()
}

/// Serialises tests that observe the whole registry (tests share one process); any test calling
/// [`begin`] takes it first. A poisoned gate is recovered so one failure cannot cascade.
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

    /// An "All workspaces" fan-out can give its legs one id; both must stop on one call.
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
