//! Drag-reordered tree levels in `db-tree-order.json` (crash-safe, `0600`, unencrypted). Keyed by
//! the frontend's opaque `nodeKey` (stored verbatim, never re-derived), children named by label;
//! cascaded on connection delete. The applier skips unknown names and appends new ones.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The on-disk schema version. Bump only for a change a reader cannot absorb with
/// `#[serde(default)]` — adding a field is not one.
pub const STORE_VERSION: u32 = 1;

/// Sibling to `db-connections.json` and `db-queries.json` in the app config dir.
pub const FILE_NAME: &str = "db-tree-order.json";

/// One tree level's user-defined order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelOrder {
    /// Which connection's tree this level belongs to. `#[serde(default)]` is permanent on every
    /// field: [`load`] defaults on a parse error, and the next save would write that emptiness
    /// back.
    #[serde(default)]
    pub connection_id: String,
    /// The frontend's `nodeKey(ref)` string, e.g. `["group","gazelle","public","tables"]`.
    /// Opaque to Rust on purpose — it is already a canonical, stable identifier, and
    /// re-deriving it here would be a second implementation free to disagree.
    #[serde(default)]
    pub parent_key: String,
    /// Child LABELS (table names) in display order.
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeOrderStore {
    /// 🔴 `#[serde(default)]` here is permanent too — see [`LevelOrder::connection_id`].
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub levels: Vec<LevelOrder>,
}

/// The full path, given the app config dir.
pub fn store_path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Load from `path`. **Any** failure — missing, unreadable, corrupt — yields an empty store, for
/// the same reason `store::load` and `queries::load` do: a database tree that refuses to open
/// because one JSON file has a stray comma is far worse than one that opens alphabetically.
pub fn load(path: &Path) -> TreeOrderStore {
    let Ok(text) = std::fs::read_to_string(path) else {
        return TreeOrderStore::default();
    };
    serde_json::from_str::<TreeOrderStore>(&text).unwrap_or_default()
}

/// CRASH-SAFE write: serialize → sibling temp → `fsync` → atomic `rename`, then `0600`.
pub fn save(path: &Path, store: &TreeOrderStore) -> std::io::Result<()> {
    let mut stamped = store.clone();
    stamped.version = STORE_VERSION;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&stamped).unwrap_or_else(|_| "{}".to_string());
    // `store_file`: locked, a unique 0600 temp per write (removed on failure), retried rename on
    // Windows.
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

/// Every level saved for one connection, in stored order (deterministic: [`set_level`] replaces
/// in place).
pub fn for_connection(store: &TreeOrderStore, connection_id: &str) -> Vec<LevelOrder> {
    store
        .levels
        .iter()
        .filter(|l| l.connection_id == connection_id)
        .cloned()
        .collect()
}

/// Replace or insert one level's order; an empty `keys` removes the entry, so absence is the only
/// way to say use the server's order. Pure; the caller does [`load`]/[`save`].
pub fn set_level(
    store: &mut TreeOrderStore,
    connection_id: &str,
    parent_key: &str,
    keys: Vec<String>,
) {
    if keys.is_empty() {
        clear_level(store, connection_id, parent_key);
        return;
    }
    match store
        .levels
        .iter_mut()
        .find(|l| l.connection_id == connection_id && l.parent_key == parent_key)
    {
        // Replaced IN PLACE rather than removed-and-pushed, so the stored order stays stable and
        // `for_connection` does not reshuffle itself every time one level is dragged.
        Some(existing) => existing.keys = keys,
        None => store.levels.push(LevelOrder {
            connection_id: connection_id.to_string(),
            parent_key: parent_key.to_string(),
            keys,
        }),
    }
}

/// Forget one level's order. `false` = nothing to forget, reported so a stale caller and a
/// successful clear differ.
pub fn clear_level(store: &mut TreeOrderStore, connection_id: &str, parent_key: &str) -> bool {
    let before = store.levels.len();
    store
        .levels
        .retain(|l| !(l.connection_id == connection_id && l.parent_key == parent_key));
    store.levels.len() != before
}

/// The delete cascade: drop every level of a connection, returning the count for the report.
pub fn remove_for_connection(store: &mut TreeOrderStore, connection_id: &str) -> usize {
    let before = store.levels.len();
    store.levels.retain(|l| l.connection_id != connection_id);
    before - store.levels.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLES: &str = r#"["group","gazelle","public","tables"]"#;
    const VIEWS: &str = r#"["group","gazelle","public","views"]"#;

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_set_level_round_trips_through_for_connection() {
        // The requirement, as literally as a pure test can put it: A,B,C dragged to C,B,A.
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["C", "B", "A"]));

        let levels = for_connection(&store, "conn-1");
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].parent_key, TABLES);
        assert_eq!(levels[0].keys, keys(&["C", "B", "A"]));
    }

    #[test]
    fn setting_the_same_level_twice_replaces_it_in_place() {
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["A", "B"]));
        set_level(&mut store, "conn-1", VIEWS, keys(&["V1"]));
        set_level(&mut store, "conn-1", TABLES, keys(&["B", "A"]));

        let levels = for_connection(&store, "conn-1");
        assert_eq!(levels.len(), 2, "a re-drag must not append a second entry");
        // In place: `tables` is still first, so the listing does not reshuffle on every drag.
        assert_eq!(levels[0].parent_key, TABLES);
        assert_eq!(levels[0].keys, keys(&["B", "A"]));
        assert_eq!(levels[1].parent_key, VIEWS);
    }

    #[test]
    fn the_same_parent_key_under_two_connections_is_two_different_levels() {
        // `["group","gazelle","public","tables"]` is only unique *within* a connection — two
        // servers can each have a `gazelle.public.tables`, and their orders must not overwrite
        // each other.
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["A", "B"]));
        set_level(&mut store, "conn-2", TABLES, keys(&["B", "A"]));

        assert_eq!(store.levels.len(), 2);
        assert_eq!(for_connection(&store, "conn-1")[0].keys, keys(&["A", "B"]));
        assert_eq!(for_connection(&store, "conn-2")[0].keys, keys(&["B", "A"]));
    }

    #[test]
    fn an_empty_keys_removes_the_entry_rather_than_storing_an_empty_one() {
        // "No custom order" and "an order of nothing" must not be two states on disk: absent is
        // the single unambiguous way to say *use the server's alphabetical order*.
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["C", "B", "A"]));
        set_level(&mut store, "conn-1", TABLES, Vec::new());

        assert!(
            store.levels.is_empty(),
            "an empty order must leave NO entry behind, not an entry with no keys: {:?}",
            store.levels
        );
        assert!(for_connection(&store, "conn-1").is_empty());
    }

    #[test]
    fn an_empty_keys_on_a_level_that_was_never_set_stores_nothing() {
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, Vec::new());
        assert!(store.levels.is_empty());
    }

    #[test]
    fn clear_level_reports_whether_there_was_an_order_to_forget() {
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["C", "B", "A"]));

        assert!(clear_level(&mut store, "conn-1", TABLES));
        // A second clear is `false`, not an error: there was simply no custom order. Reported so a
        // stale caller and a successful reset do not look identical.
        assert!(!clear_level(&mut store, "conn-1", TABLES));
        assert!(store.levels.is_empty());
    }

    #[test]
    fn clear_level_is_scoped_to_one_connection_and_one_parent() {
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["A"]));
        set_level(&mut store, "conn-1", VIEWS, keys(&["V"]));
        set_level(&mut store, "conn-2", TABLES, keys(&["Z"]));

        assert!(clear_level(&mut store, "conn-1", TABLES));
        assert_eq!(store.levels.len(), 2);
        assert_eq!(for_connection(&store, "conn-1")[0].parent_key, VIEWS);
        assert_eq!(for_connection(&store, "conn-2")[0].keys, keys(&["Z"]));
    }

    #[test]
    fn the_cascade_reports_its_count_and_leaves_other_connections_untouched() {
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["A"]));
        set_level(&mut store, "conn-1", VIEWS, keys(&["V"]));
        set_level(&mut store, "conn-2", TABLES, keys(&["Z"]));

        assert_eq!(remove_for_connection(&mut store, "conn-1"), 2);
        // Two-sided: the count is right AND the other connection's order is still there. A sweep
        // would pass the first assertion on its own.
        assert_eq!(store.levels.len(), 1);
        assert_eq!(store.levels[0].connection_id, "conn-2");
        assert_eq!(store.levels[0].keys, keys(&["Z"]));
        // And a second cascade removes nothing.
        assert_eq!(remove_for_connection(&mut store, "conn-1"), 0);
    }

    #[test]
    fn for_connection_returns_nothing_for_a_connection_that_was_never_dragged() {
        let mut store = TreeOrderStore::default();
        set_level(&mut store, "conn-1", TABLES, keys(&["A"]));
        assert!(for_connection(&store, "conn-unknown").is_empty());
    }

    /* ───────────────────────── the filesystem half ───────────────────────── */

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentstudio-db-tree-order-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// 🔴 The durability requirement, as literally as a test can put it: drag A,B,C to C,B,A, then
    /// read it back from a **fresh load of the file** — which is what "after a restart" means here.
    #[test]
    fn a_dragged_order_survives_a_reload_of_the_file() {
        let dir = temp_dir("reload");
        let path = store_path_in(&dir);

        let mut store = load(&path);
        assert!(store.levels.is_empty(), "a missing file is an empty store");
        set_level(&mut store, "conn-1", TABLES, keys(&["C", "B", "A"]));
        save(&path, &store).expect("saved");

        // Nothing of the in-memory store survives into this call.
        let reloaded = load(&path);
        let levels = for_connection(&reloaded, "conn-1");
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].parent_key, TABLES);
        assert_eq!(levels[0].keys, keys(&["C", "B", "A"]));
        assert_eq!(
            reloaded.version, STORE_VERSION,
            "the write must stamp a version"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_rather_than_taking_the_tree_down() {
        let dir = temp_dir("corrupt");
        let path = store_path_in(&dir);
        std::fs::write(&path, "{ this is not json").unwrap();
        assert!(load(&path).levels.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_reads_as_empty() {
        let dir = temp_dir("missing");
        assert!(load(&store_path_in(&dir)).levels.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The older-build JSON is hand-written, not serialized from today's struct, and must keep its
    /// orders through a save→reload (the write-back is half the hazard).
    #[test]
    fn a_file_missing_a_field_still_loads_its_orders_and_survives_a_write_back() {
        let dir = temp_dir("legacy");
        let path = store_path_in(&dir);
        std::fs::write(
            &path,
            r#"{
  "levels": [
    { "connectionId": "conn-1", "parentKey": "[\"group\",\"gazelle\",\"public\",\"tables\"]",
      "keys": ["C", "B", "A"] }
  ]
}"#,
        )
        .unwrap();

        let loaded = load(&path);
        assert_eq!(
            loaded.levels.len(),
            1,
            "the dragged order must survive a file with no `version`"
        );
        assert_eq!(loaded.levels[0].keys, keys(&["C", "B", "A"]));

        save(&path, &loaded).expect("saved");
        let again = load(&path);
        assert_eq!(again.levels.len(), 1, "the write-back erased the order");
        assert_eq!(again.levels[0].keys, keys(&["C", "B", "A"]));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        // The frontend reads these names; a snake_case slip would surface as `undefined` and the
        // drag would silently stop sticking.
        let level = LevelOrder {
            connection_id: "conn-1".into(),
            parent_key: TABLES.into(),
            keys: keys(&["C", "B", "A"]),
        };
        assert_eq!(
            serde_json::to_value(&level).unwrap(),
            serde_json::json!({
                "connectionId": "conn-1",
                "parentKey": TABLES,
                "keys": ["C", "B", "A"],
            })
        );

        let store = TreeOrderStore {
            version: STORE_VERSION,
            levels: vec![level],
        };
        assert_eq!(
            serde_json::to_value(&store).unwrap(),
            serde_json::json!({
                "version": STORE_VERSION,
                "levels": [{
                    "connectionId": "conn-1",
                    "parentKey": TABLES,
                    "keys": ["C", "B", "A"],
                }],
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_written_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perms");
        let path = store_path_in(&dir);
        save(&path, &TreeOrderStore::default()).expect("saved");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        // Not a secret store, but these are someone's table names — nobody else's business on a
        // shared machine. NOT encryption, and nothing here claims it is.
        assert_eq!(mode, 0o600, "mode was {mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_temp_file_cannot_collide_with_the_connection_or_query_stores() {
        // All three live in the same directory. `store_file::temp_path` starts with the target's
        // own file name and ends in a fresh ULID — asserted because a shared temp name would make
        // two concurrent saves corrupt each other.
        let dir = temp_dir("tmpname");
        let order = crate::store_file::temp_path(&store_path_in(&dir));
        let connections = crate::store_file::temp_path(&dir.join("db-connections.json"));
        let queries = crate::store_file::temp_path(&dir.join("db-queries.json"));
        assert_ne!(order, connections);
        assert_ne!(order, queries);
        assert_ne!(
            order,
            crate::store_file::temp_path(&store_path_in(&dir)),
            "per write"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
