//! Pinned root agents: a pin returns even after its own process ended (restore lives in
//! `open_agents::restore_on_boot`). `pinned-agents.json` in the app config dir, never the repo
//! or `~/.claude`; a corrupt store loads as empty; writes are atomic. Roots only.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::supervisor::SupervisorHandle;

/// File name inside the config dir.
const FILE_NAME: &str = "pinned-agents.json";

/// One pinned root agent — everything needed to re-spawn it and place its tab back
/// camelCase on the wire to match `src/app/types.ts` (serde convention,
/// `model.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedAgent {
    /// Our ULID id; reused verbatim on restore (also the terminal id, 1:1 in v1) so
    /// the row/tab wiring and `fleet_snapshot` binding are unchanged.
    pub agent_id: String,
    /// Absolute cwd; re-spawn here (same per-project history + transcript dir).
    pub cwd: String,
    /// The `AgentAdapter` id, e.g. `"claude-code"` — selects the adapter on restore.
    pub runtime: String,
    /// The minted `--session-id` — the key to `claude --resume` AND the fan-out
    /// tailer. Internal only: it is written here from in-process supervisor state and
    /// deliberately never crosses to the frontend (see [`PinnedAgentView`]).
    pub session_id: String,
    /// User-renamed label; `None` when the agent still wears its adapter default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    /// Stable restore order (ascending). Assigned by [`upsert`]; preserved across a
    /// re-pin so an agent keeps its rail position.
    pub order: u32,
}

/// The restore/reconcile list the frontend reads on startup — **without the session
/// id** (that stays internal). `title` is the user's rename if there was
/// one, else the cwd's final component so the row is never blank.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedAgentView {
    pub agent_id: String,
    pub cwd: String,
    pub title: String,
}

impl From<&PinnedAgent> for PinnedAgentView {
    fn from(p: &PinnedAgent) -> Self {
        let title = p.custom_title.clone().unwrap_or_else(|| basename(&p.cwd));
        PinnedAgentView {
            agent_id: p.agent_id.clone(),
            cwd: p.cwd.clone(),
            title,
        }
    }
}

/// The final path component of `cwd` (a readable fallback title), or the whole
/// string when there is no separator.
fn basename(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd.to_string())
}

/// Load the list, ordered ascending by `order`. **Any** failure — missing,
/// unreadable, corrupt, or wrong-shape — yields an empty vec, so startup can never
/// break on a bad store.
pub fn load(path: &Path) -> Vec<PinnedAgent> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut list = serde_json::from_str::<Vec<PinnedAgent>>(&text).unwrap_or_default();
    dedupe(&mut list);
    list.sort_by_key(|p| p.order);
    list
}

/// Insert-or-refresh by `agent_id` and persist atomically. A re-pin keeps its original `order`
/// (stable rail position); a new id goes after the max. Returns the updated, ordered list.
pub fn upsert(path: &Path, mut entry: PinnedAgent) -> Vec<PinnedAgent> {
    let _guard = crate::store_file::lock(path); // load → edit → save, one transaction
    let mut list = load(path);
    if let Some(existing) = list.iter_mut().find(|p| p.agent_id == entry.agent_id) {
        // Idempotent re-pin: refresh mutable fields, keep the original order.
        existing.cwd = entry.cwd;
        existing.runtime = entry.runtime;
        existing.session_id = entry.session_id;
        existing.custom_title = entry.custom_title;
    } else {
        entry.order = list.iter().map(|p| p.order).max().map_or(0, |m| m + 1);
        list.push(entry);
    }
    list.sort_by_key(|p| p.order);
    // Best-effort persist: return the in-memory list even if the write raced, so the
    // caller reflects the change (the atomic write means a failure loses at most this
    // one update, never corrupts the file).
    let _ = save(path, &list);
    list
}

/// Remove the pin for `agent_id` and persist. An unknown id is a no-op (not an
/// error). Returns the updated, ordered list.
pub fn remove(path: &Path, agent_id: &str) -> Vec<PinnedAgent> {
    let _guard = crate::store_file::lock(path);
    let mut list = load(path);
    list.retain(|p| p.agent_id != agent_id);
    let _ = save(path, &list);
    list
}

/// Drop duplicate `agent_id`s, keeping the first occurrence — defensive against a
/// hand-edited or partially-written store.
fn dedupe(list: &mut Vec<PinnedAgent>) {
    let mut seen = std::collections::HashSet::new();
    list.retain(|p| seen.insert(p.agent_id.clone()));
}

/// Crash-safe write (sibling temp → `fsync` → atomic `rename`): a crash leaves the old file or
/// the new one, never a half-written blob.
pub fn save(path: &Path, list: &[PinnedAgent]) -> std::io::Result<()> {
    write_json_atomic(path, list)
}

/// The crash-safe JSON writer both agent registries share, so neither drifts (a missing
/// `sync_all`, a temp in another dir).
pub(crate) fn write_json_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> std::io::Result<()> {
    // `store_file`: a unique temp per write (no writer can rename or delete another's), the
    // temp removed on failure, and on Windows a retried rename over a briefly-held file.
    let json = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let _guard = crate::store_file::lock(path);
    crate::store_file::write_atomic(path, json.as_bytes(), false)
}

/// The store file's path: the Tauri app config dir if available (created on write),
/// else a `home_dir()`-based fallback. **Always outside any workspace/repo and never
/// `~/.claude`.**
pub(crate) fn store_path(app: &tauri::AppHandle) -> PathBuf {
    config_file(app, FILE_NAME)
}

/// `<app config dir>/<name>`, else `~/.config/agent-studio/<name>`: the path every agent
/// registry uses.
pub(crate) fn config_file(app: &tauri::AppHandle, name: &str) -> PathBuf {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        return dir.join(name);
    }
    crate::agent::claude::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("agent-studio")
        .join(name)
}

// ── Tauri command surface ────────────────────────────────────────────────────
// The session id is read from live supervisor state and never crosses the JS wire.

/// Pinned agents without session ids; missing/corrupt store → `[]`.
/// Frontend contract: `invoke<PinnedAgentView[]>('pinned_agents')`.
#[tauri::command]
pub fn pinned_agents(app: tauri::AppHandle) -> Vec<PinnedAgentView> {
    load(&store_path(&app))
        .iter()
        .map(PinnedAgentView::from)
        .collect()
}

/// Pin a live ROOT agent from supervisor state (the session id stays in-process). An unknown id
/// or a sub-agent is an error. Frontend contract: `invoke('pin_agent', { agentId })`.
#[tauri::command]
pub async fn pin_agent(
    supervisor: tauri::State<'_, SupervisorHandle>,
    app: tauri::AppHandle,
    agent_id: String,
) -> Result<(), String> {
    let info = supervisor
        .describe_pinnable(agent_id.clone())
        .await?
        .ok_or_else(|| format!("cannot pin {agent_id}: not a live root agent"))?;
    upsert(
        &store_path(&app),
        PinnedAgent {
            agent_id: info.agent_id,
            cwd: info.cwd,
            runtime: info.runtime,
            session_id: info.session_id,
            custom_title: info.custom_title,
            order: 0, // assigned by `upsert`
        },
    );
    Ok(())
}

/// Unpin and persist; the live agent keeps running, just isn't restored. Unknown id → no-op.
/// Frontend contract: `invoke('unpin_agent', { agentId })`.
#[tauri::command]
pub fn unpin_agent(app: tauri::AppHandle, agent_id: String) -> Result<(), String> {
    remove(&store_path(&app), &agent_id);
    Ok(())
}

// ── Boot restore ──────────────────────────────────────────────────────────────
// Lives in `open_agents::restore_on_boot`: ONE restore over both registries, deduped by id.

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
                .join(format!("agentstudio-pinned-{label}-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&dir).unwrap();
            let store = dir.join(FILE_NAME);
            Self { dir, store }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn agent(id: &str, cwd: &str) -> PinnedAgent {
        PinnedAgent {
            agent_id: id.into(),
            cwd: cwd.into(),
            runtime: "claude-code".into(),
            session_id: format!("session-{id}"),
            custom_title: None,
            order: 0,
        }
    }

    #[test]
    fn upsert_then_load_round_trips_all_fields() {
        let f = Fixture::new("roundtrip");
        let mut a = agent("a1", "/work/a");
        a.custom_title = Some("Backend agent".into());
        upsert(&f.store, a.clone());

        let loaded = load(&f.store);
        assert_eq!(loaded.len(), 1);
        // Every field intact except `order`, which `upsert` assigns (0 for the first).
        assert_eq!(loaded[0].agent_id, "a1");
        assert_eq!(loaded[0].cwd, "/work/a");
        assert_eq!(loaded[0].runtime, "claude-code");
        assert_eq!(loaded[0].session_id, "session-a1");
        assert_eq!(loaded[0].custom_title.as_deref(), Some("Backend agent"));
        assert_eq!(loaded[0].order, 0);
    }

    #[test]
    fn upsert_assigns_ascending_order_and_load_sorts_by_it() {
        let f = Fixture::new("order");
        upsert(&f.store, agent("a", "/w/a"));
        upsert(&f.store, agent("b", "/w/b"));
        upsert(&f.store, agent("c", "/w/c"));
        let list = load(&f.store);
        assert_eq!(
            list.iter().map(|p| p.agent_id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert_eq!(
            list.iter().map(|p| p.order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn re_pinning_refreshes_mutable_fields_but_keeps_order_and_never_duplicates() {
        let f = Fixture::new("repin");
        upsert(&f.store, agent("a", "/w/a"));
        upsert(&f.store, agent("b", "/w/b")); // a=0, b=1

        // Re-pin `a` with new cwd / session / title — it must keep order 0, not append.
        let mut a2 = agent("a", "/w/a-moved");
        a2.session_id = "session-a-NEW".into();
        a2.custom_title = Some("renamed".into());
        let list = upsert(&f.store, a2);

        assert_eq!(list.len(), 2, "re-pin must not duplicate");
        let a = list.iter().find(|p| p.agent_id == "a").unwrap();
        assert_eq!(a.order, 0, "original order preserved");
        assert_eq!(a.cwd, "/w/a-moved", "cwd refreshed");
        assert_eq!(a.session_id, "session-a-NEW", "session id refreshed");
        assert_eq!(a.custom_title.as_deref(), Some("renamed"));
        // `b` is untouched and still after `a`.
        assert_eq!(list[1].agent_id, "b");
    }

    #[test]
    fn remove_deletes_by_id_and_unknown_id_is_a_noop() {
        let f = Fixture::new("remove");
        upsert(&f.store, agent("a", "/w/a"));
        upsert(&f.store, agent("b", "/w/b"));

        let after = remove(&f.store, "a");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].agent_id, "b");
        assert_eq!(load(&f.store).len(), 1, "persisted");

        // Removing an id that isn't there changes nothing and doesn't error.
        let again = remove(&f.store, "does-not-exist");
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].agent_id, "b");
    }

    #[test]
    fn missing_file_loads_as_empty() {
        let f = Fixture::new("missing");
        assert!(load(&f.store).is_empty(), "no file yet => empty");
    }

    #[test]
    fn corrupt_or_wrong_shape_loads_as_empty_never_errors() {
        let f = Fixture::new("corrupt");
        for junk in [
            "{ not json",
            "42",
            "",
            "\"a string\"",
            "null",
            "[1, 2, 3]",
            "{\"agentId\":\"x\"}", // an object where an array is expected
        ] {
            std::fs::write(&f.store, junk).unwrap();
            assert!(
                load(&f.store).is_empty(),
                "corrupt {junk:?} must read as empty"
            );
        }
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp_file() {
        let f = Fixture::new("atomic");
        upsert(&f.store, agent("a", "/w/a"));
        upsert(&f.store, agent("b", "/w/b"));

        // The final store is complete, valid JSON…
        assert_eq!(load(&f.store).len(), 2);
        // …and no `.json.tmp` sidecar was left behind (the rename cleaned it up).
        let leftovers: Vec<_> = std::fs::read_dir(&f.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.contains("tmp"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic write must leave no temp file, found: {leftovers:?}"
        );
    }

    #[test]
    fn save_creates_the_parent_dir_if_absent() {
        let f = Fixture::new("mkdir");
        let nested = f.dir.join("x").join("y").join(FILE_NAME);
        assert!(!nested.parent().unwrap().exists());
        save(&nested, &[agent("a", "/w/a")]).unwrap();
        assert_eq!(load(&nested).len(), 1, "save creates dirs and is readable");
    }

    #[test]
    fn wire_form_is_camel_case_and_omits_absent_title() {
        // The frontend view is built against camelCase; assert the persisted JSON
        // uses `agentId`/`sessionId`/`customTitle`, and that a `None` title is omitted
        // (not `null`) — the serde contract, like `api_store.rs`'s.
        let f = Fixture::new("camel");
        upsert(&f.store, agent("a", "/w/a")); // custom_title: None
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(text.contains("agentId"), "camelCase agentId: {text}");
        assert!(text.contains("sessionId"), "camelCase sessionId: {text}");
        assert!(
            !text.contains("agent_id") && !text.contains("session_id"),
            "must not leak snake_case: {text}"
        );
        assert!(
            !text.contains("customTitle"),
            "absent title must be omitted, not null: {text}"
        );

        // A present title IS serialized.
        let mut a = agent("b", "/w/b");
        a.custom_title = Some("named".into());
        upsert(&f.store, a);
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("customTitle"),
            "present title serialized: {text}"
        );
    }

    #[test]
    fn dedupe_keeps_the_first_of_a_duplicated_id() {
        // A hand-edited / torn store with two entries for one id must collapse to one
        // on load (first wins), never panic.
        let f = Fixture::new("dedupe");
        let json = r#"[
            {"agentId":"a","cwd":"/w/a","runtime":"claude-code","sessionId":"s1","order":0},
            {"agentId":"a","cwd":"/w/a2","runtime":"claude-code","sessionId":"s2","order":1}
        ]"#;
        std::fs::write(&f.store, json).unwrap();
        let list = load(&f.store);
        assert_eq!(list.len(), 1, "duplicate id collapsed");
        assert_eq!(list[0].cwd, "/w/a", "first occurrence kept");
    }

    #[test]
    fn view_hides_session_id_and_titles_from_cwd_when_unnamed() {
        // An unnamed pin's view title falls back to the cwd's final component…
        let unnamed = agent("a", "/work/my-project");
        let v = PinnedAgentView::from(&unnamed);
        assert_eq!(v.title, "my-project");
        assert_eq!(v.agent_id, "a");
        assert_eq!(v.cwd, "/work/my-project");

        // …and a named pin surfaces the rename.
        let mut named = agent("b", "/work/other");
        named.custom_title = Some("Reviewer".into());
        assert_eq!(PinnedAgentView::from(&named).title, "Reviewer");

        // The view type has no session field at all — a compile-time guarantee the
        // session id can't leak through it (this test documents the contract).
        let json = serde_json::to_string(&v).unwrap();
        assert!(
            !json.contains("session"),
            "the view must never carry a session id: {json}"
        );
    }

    #[test]
    fn pin_unpin_sequences_never_panic_and_stay_loadable() {
        // Robustness: a churn of upserts/removes always leaves a loadable file.
        let f = Fixture::new("churn");
        for i in 0..20 {
            upsert(&f.store, agent(&format!("a{}", i % 5), &format!("/w/{i}")));
            if i % 3 == 0 {
                remove(&f.store, &format!("a{}", i % 5));
            }
            // Never errors, always a valid list.
            let _ = load(&f.store);
        }
        // At most 5 distinct ids ever existed.
        assert!(load(&f.store).len() <= 5);
    }
}
