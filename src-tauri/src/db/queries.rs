//! Saved queries — `db-queries.json`.
//!
//! Queries must be saved: after the app has been closed and reopened,
//! double-clicking the database must show its list of queries. That is a durability requirement,
//! so this file is a sibling of `db-connections.json` and takes the same crash-safe write path
//! (temp → `fsync` → atomic `rename` → `0600`); a half-written file of someone's saved SQL is a
//! mystery bug, and losing it is worse than losing a connection record you can retype.
//!
//! ## Keyed by `connection_id`, and deleted with it
//!
//! A query belongs to the connection it was written against — its SQL names that server's tables.
//! An orphan is a query you cannot run, so `db_connection_delete` cascades, and it **reports the
//! count** so the confirm dialog can say "and its 12 saved queries" instead of quietly discarding
//! work.
//!
//! ## No secrets, deliberately
//!
//! Unlike `db-connections.json` this file has no credential handling at all, because SQL text is
//! not a credential and pretending otherwise would invite someone to put one here. It still gets
//! `0600`: a saved query can name internal tables, and that is nobody else's business on a shared
//! machine. What it is NOT is encrypted, and nothing here pretends otherwise.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The on-disk schema version. Bump only for a change a reader cannot absorb with
/// `#[serde(default)]` — adding a field is not one.
pub const STORE_VERSION: u32 = 1;

/// Sibling to `db-connections.json` in the app config dir.
pub const FILE_NAME: &str = "db-queries.json";

/// One saved query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    /// ULID, minted in Rust on first save — the frontend never invents an id.
    pub id: String,
    /// Which connection this belongs to.
    pub connection_id: String,
    /// What the user called it. Not unique: two queries may share a name, because forcing
    /// uniqueness would make a save fail on a name collision the user does not care about.
    pub name: String,
    pub sql: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryStore {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub queries: Vec<SavedQuery>,
}

/// What the frontend sends to create or update one. `id: None` creates.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryInput {
    #[serde(default)]
    pub id: Option<String>,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
}

/// The full path, given the app config dir.
pub fn store_path_in(dir: &Path) -> std::path::PathBuf {
    dir.join(FILE_NAME)
}

/// Load from `path`. **Any** failure — missing, unreadable, corrupt — yields an empty store,
/// for the same reason `store::load` does: a database panel that refuses to open because one
/// JSON file has a stray comma is worse than one that shows no saved queries.
pub fn load(path: &Path) -> SavedQueryStore {
    let Ok(text) = std::fs::read_to_string(path) else {
        return SavedQueryStore::default();
    };
    serde_json::from_str::<SavedQueryStore>(&text).unwrap_or_default()
}

/// CRASH-SAFE write: serialize → sibling temp → `fsync` → atomic `rename`, then `0600`.
pub fn save(path: &Path, store: &SavedQueryStore) -> std::io::Result<()> {
    let mut stamped = store.clone();
    stamped.version = STORE_VERSION;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&stamped).unwrap_or_else(|_| "{}".to_string());
    // The temp name is the target's file name + a fresh ULID, so it can never collide with
    // `db-connections.json`'s (same directory) or with a concurrent save of this same file.
    // `store_file`: locked, a unique temp per write (born 0600 on unix), the temp
    // removed on failure, and on Windows a retried rename over a briefly-held file.
    let _guard = crate::store_file::lock(path);
    crate::store_file::write_atomic(path, json.as_bytes(), true)?;
    restrict_permissions(path);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// The queries for one connection, **newest-updated first**.
///
/// Sorted here rather than in the UI so every surface that lists them agrees, and by
/// `updated_at_ms` rather than name because the one you just edited is the one you want next.
pub fn for_connection(store: &SavedQueryStore, connection_id: &str) -> Vec<SavedQuery> {
    let mut out: Vec<SavedQuery> = store
        .queries
        .iter()
        .filter(|q| q.connection_id == connection_id)
        .cloned()
        .collect();
    out.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            // A stable tiebreak, because two queries saved in the same millisecond would
            // otherwise reorder between calls and make the list flicker.
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// Insert or update. Pure over the list so the whole decision is testable without a filesystem.
///
/// Returns the stored record. `now_ms` is injected rather than read here, so a test can assert
/// that `created_at_ms` is preserved across an update instead of trusting the clock.
pub fn upsert(
    store: &mut SavedQueryStore,
    input: SavedQueryInput,
    now_ms: u64,
    new_id: impl FnOnce() -> String,
) -> Result<SavedQuery, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        // Refused rather than defaulted to "Untitled": a list of four "Untitled" queries is
        // indistinguishable from a bug, and the dialog can ask again for free.
        return Err("A saved query needs a name.".to_string());
    }
    if input.sql.trim().is_empty() {
        return Err("There is nothing to save — the editor is empty.".to_string());
    }
    if input.connection_id.trim().is_empty() {
        return Err("A saved query must belong to a connection.".to_string());
    }

    match input.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            let existing = store
                .queries
                .iter_mut()
                .find(|q| q.id == id)
                // A stale id is the frontend holding a query that was deleted elsewhere. Told
                // apart from a create, because silently creating a second copy under a new id is
                // how duplicates appear that nobody can explain.
                .ok_or_else(|| format!("That saved query no longer exists (`{id}`)."))?;
            existing.name = name;
            existing.sql = input.sql;
            existing.updated_at_ms = now_ms;
            // `created_at_ms` and `connection_id` are NOT taken from the input: a query cannot
            // move between connections (its SQL names one server's tables), and re-stamping the
            // creation time would erase the only record of when it was written.
            Ok(existing.clone())
        }
        None => {
            let record = SavedQuery {
                id: new_id(),
                connection_id: input.connection_id,
                name,
                sql: input.sql,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            };
            store.queries.push(record.clone());
            Ok(record)
        }
    }
}

/// Delete by id. `true` when something was removed — `false` means our list was stale, which the
/// caller reports rather than passing over (the same choice `db_connection_delete` makes).
pub fn remove(store: &mut SavedQueryStore, id: &str) -> bool {
    let before = store.queries.len();
    store.queries.retain(|q| q.id != id);
    store.queries.len() != before
}

/// Drop every query belonging to `connection_id`, returning how many went.
///
/// The count is the point: `db_connection_delete` names it in its report so the confirm dialog can
/// say what is about to be discarded.
pub fn remove_for_connection(store: &mut SavedQueryStore, connection_id: &str) -> usize {
    let before = store.queries.len();
    store.queries.retain(|q| q.connection_id != connection_id);
    before - store.queries.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: Option<&str>, name: &str, sql: &str) -> SavedQueryInput {
        SavedQueryInput {
            id: id.map(str::to_string),
            connection_id: "conn-1".to_string(),
            name: name.to_string(),
            sql: sql.to_string(),
        }
    }

    #[test]
    fn a_create_mints_an_id_and_stamps_both_times() {
        let mut store = SavedQueryStore::default();
        let saved = upsert(
            &mut store,
            input(None, "Recent tracks", "SELECT * FROM tracks"),
            1_000,
            || "Q1".to_string(),
        )
        .expect("saved");
        assert_eq!(saved.id, "Q1");
        assert_eq!(saved.created_at_ms, 1_000);
        assert_eq!(saved.updated_at_ms, 1_000);
        assert_eq!(store.queries.len(), 1);
    }

    #[test]
    fn an_update_keeps_the_creation_time_and_does_not_add_a_row() {
        let mut store = SavedQueryStore::default();
        upsert(&mut store, input(None, "A", "SELECT 1"), 1_000, || {
            "Q1".into()
        })
        .unwrap();
        let updated = upsert(
            &mut store,
            input(Some("Q1"), "A renamed", "SELECT 2"),
            5_000,
            || panic!("an update must not mint an id"),
        )
        .expect("updated");

        assert_eq!(store.queries.len(), 1, "the update created a second row");
        assert_eq!(updated.name, "A renamed");
        assert_eq!(updated.sql, "SELECT 2");
        // The only record of when this was written must survive an edit.
        assert_eq!(updated.created_at_ms, 1_000);
        assert_eq!(updated.updated_at_ms, 5_000);
    }

    #[test]
    fn a_query_cannot_be_moved_to_another_connection_by_an_update() {
        // Its SQL names one server's tables, so a move would produce a query that cannot run.
        let mut store = SavedQueryStore::default();
        upsert(&mut store, input(None, "A", "SELECT 1"), 1, || "Q1".into()).unwrap();
        let moved = upsert(
            &mut store,
            SavedQueryInput {
                id: Some("Q1".into()),
                connection_id: "SOMEWHERE-ELSE".into(),
                name: "A".into(),
                sql: "SELECT 1".into(),
            },
            2,
            || panic!("no new id"),
        )
        .unwrap();
        assert_eq!(moved.connection_id, "conn-1");
    }

    #[test]
    fn a_stale_id_is_an_error_rather_than_a_silent_second_copy() {
        // The frontend holding a query someone deleted on another window. Creating a new record
        // under a new id would produce duplicates nobody can explain.
        let mut store = SavedQueryStore::default();
        let err = upsert(&mut store, input(Some("GONE"), "A", "SELECT 1"), 1, || {
            panic!("must not mint")
        })
        .expect_err("a stale id must not create");
        assert!(err.contains("GONE"), "{err}");
        assert!(store.queries.is_empty());
    }

    #[test]
    fn a_blank_name_or_empty_sql_is_refused_and_says_which() {
        let mut store = SavedQueryStore::default();
        // "Untitled" would be a worse outcome: four of them is indistinguishable from a bug.
        let no_name = upsert(&mut store, input(None, "   ", "SELECT 1"), 1, || "Q".into())
            .expect_err("a blank name must be refused");
        assert!(no_name.to_lowercase().contains("name"), "{no_name}");

        let no_sql = upsert(&mut store, input(None, "A", "  \n "), 1, || "Q".into())
            .expect_err("empty SQL must be refused");
        assert!(no_sql.to_lowercase().contains("empty"), "{no_sql}");
        assert!(store.queries.is_empty());
    }

    #[test]
    fn the_name_is_trimmed_so_two_lists_do_not_disagree_about_alignment() {
        let mut store = SavedQueryStore::default();
        let saved = upsert(&mut store, input(None, "  Tracks  ", "SELECT 1"), 1, || {
            "Q".into()
        })
        .unwrap();
        assert_eq!(saved.name, "Tracks");
    }

    #[test]
    fn for_connection_filters_and_orders_newest_updated_first() {
        let mut store = SavedQueryStore::default();
        upsert(&mut store, input(None, "old", "SELECT 1"), 1_000, || {
            "Q1".into()
        })
        .unwrap();
        upsert(&mut store, input(None, "new", "SELECT 2"), 3_000, || {
            "Q2".into()
        })
        .unwrap();
        upsert(
            &mut store,
            SavedQueryInput {
                id: None,
                connection_id: "other".into(),
                name: "elsewhere".into(),
                sql: "SELECT 3".into(),
            },
            9_000,
            || "Q3".into(),
        )
        .unwrap();

        let mine = for_connection(&store, "conn-1");
        let names: Vec<&str> = mine.iter().map(|q| q.name.as_str()).collect();
        // The one just edited is the one wanted next, and the other connection's is absent.
        assert_eq!(names, vec!["new", "old"]);
    }

    #[test]
    fn a_millisecond_tie_orders_stably_so_the_list_does_not_flicker() {
        let mut store = SavedQueryStore::default();
        upsert(&mut store, input(None, "b", "SELECT 1"), 5_000, || {
            "Q2".into()
        })
        .unwrap();
        upsert(&mut store, input(None, "a", "SELECT 2"), 5_000, || {
            "Q1".into()
        })
        .unwrap();
        let first: Vec<String> = for_connection(&store, "conn-1")
            .iter()
            .map(|q| q.id.clone())
            .collect();
        let second: Vec<String> = for_connection(&store, "conn-1")
            .iter()
            .map(|q| q.id.clone())
            .collect();
        assert_eq!(first, second);
        assert_eq!(first, vec!["Q1", "Q2"], "the tiebreak must be by id");
    }

    #[test]
    fn remove_reports_whether_it_removed_anything() {
        let mut store = SavedQueryStore::default();
        upsert(&mut store, input(None, "A", "SELECT 1"), 1, || "Q1".into()).unwrap();
        assert!(remove(&mut store, "Q1"));
        // A second delete is `false`, not an error: our list was stale, and the caller says so
        // rather than letting a stale list look identical to a successful delete.
        assert!(!remove(&mut store, "Q1"));
    }

    #[test]
    fn the_cascade_reports_its_count_so_a_confirm_can_name_it() {
        let mut store = SavedQueryStore::default();
        for (n, id) in [(1, "Q1"), (2, "Q2")] {
            upsert(
                &mut store,
                input(None, &format!("A{n}"), "SELECT 1"),
                1,
                || id.to_string(),
            )
            .unwrap();
        }
        upsert(
            &mut store,
            SavedQueryInput {
                id: None,
                connection_id: "other".into(),
                name: "keep".into(),
                sql: "SELECT 1".into(),
            },
            1,
            || "Q3".into(),
        )
        .unwrap();

        assert_eq!(remove_for_connection(&mut store, "conn-1"), 2);
        // The other connection's query is untouched — the cascade is scoped, not a sweep.
        assert_eq!(store.queries.len(), 1);
        assert_eq!(store.queries[0].connection_id, "other");
        // And a second cascade removes nothing.
        assert_eq!(remove_for_connection(&mut store, "conn-1"), 0);
    }

    /* ───────────────────────── the filesystem half ───────────────────────── */

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentstudio-db-queries-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// 🔴 Requirement 9, as literally as a test can put it: save a query, and read it back from a
    /// **fresh load of the file** — which is what "the app was closed" means here.
    #[test]
    fn a_saved_query_survives_a_reload_of_the_file() {
        let dir = temp_dir("reload");
        let path = store_path_in(&dir);

        let mut store = load(&path);
        assert!(store.queries.is_empty(), "a missing file is an empty store");
        upsert(
            &mut store,
            input(
                None,
                "Recent tracks",
                "SELECT * FROM tracks ORDER BY at DESC",
            ),
            1_785_000_000_000,
            || "Q1".to_string(),
        )
        .unwrap();
        save(&path, &store).expect("saved");

        // Nothing of the in-memory store survives into this call.
        let reloaded = load(&path);
        let listed = for_connection(&reloaded, "conn-1");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Recent tracks");
        assert_eq!(listed[0].sql, "SELECT * FROM tracks ORDER BY at DESC");
        assert_eq!(
            reloaded.version, STORE_VERSION,
            "the write must stamp a version"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_rather_than_taking_the_panel_down() {
        let dir = temp_dir("corrupt");
        let path = store_path_in(&dir);
        std::fs::write(&path, "{ this is not json").unwrap();
        assert!(load(&path).queries.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        // The frontend reads these names; a snake_case slip would surface as `undefined` in a list.
        let q = SavedQuery {
            id: "Q1".into(),
            connection_id: "conn-1".into(),
            name: "A".into(),
            sql: "SELECT 1".into(),
            created_at_ms: 1,
            updated_at_ms: 2,
        };
        let json = serde_json::to_value(&q).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "Q1",
                "connectionId": "conn-1",
                "name": "A",
                "sql": "SELECT 1",
                "createdAtMs": 1,
                "updatedAtMs": 2,
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_written_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perms");
        let path = store_path_in(&dir);
        save(&path, &SavedQueryStore::default()).expect("saved");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        // Not a secret store, but a saved query can name internal tables — nobody else's
        // business on a shared machine. NOT encryption, and nothing here claims it is.
        assert_eq!(mode, 0o600, "mode was {mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_temp_file_cannot_collide_with_the_connection_stores() {
        // Both live in the same directory. `store_file::temp_path` starts with the target's own
        // file name and ends in a fresh ULID — asserted because a shared temp name would make two
        // concurrent saves corrupt each other.
        let dir = temp_dir("tmpname");
        let queries = crate::store_file::temp_path(&store_path_in(&dir));
        let connections = crate::store_file::temp_path(&dir.join("db-connections.json"));
        assert_ne!(queries, connections);
        assert!(queries
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("db-queries.json."));
        assert_ne!(
            queries,
            crate::store_file::temp_path(&store_path_in(&dir)),
            "per write"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
