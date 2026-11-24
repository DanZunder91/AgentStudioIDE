//! `db-connections.json` — the persisted connection store.
//!
//! ## Three properties this file exists to guarantee
//!
//! 1. **It never holds a secret.** Everything written here comes off a
//!    [`crate::db::model::DbConnection`], whose `password_ref` is `""` or a `{{VAR}}` and
//!    whose `url` has already had its credentials split out server-side. This module
//!    does not need to know that — it is a property of the type — but it is the reason the
//!    file is safe to screenshot, and the reason `mode 0600` below is belt-and-braces rather
//!    than the whole defence.
//! 2. **A crash cannot corrupt it.** The writer is `pinned_agents::save`'s, not
//!    `api_store::save`'s: sibling temp → `write_all` → `sync_all` → atomic `rename`. A
//!    connection list is exactly the kind of state whose *loss* is an annoyance and whose
//!    *corruption* is a mystery bug, so it takes the atomic path.
//! 3. **A bad file can never break startup.** Missing, unreadable, non-JSON, or well-formed
//!    JSON of the wrong shape all load as [`DbConnectionStore::default`] — the robustness
//!    contract every store in this repo shares (`recent_projects`, `api_store`,
//!    `pinned_agents`).
//!
//! ## The injected path is not a testing convenience, it is a safety rule
//!
//! Every function here takes an explicit `&Path`. The only place the *real* path is resolved
//! is [`store_path`], which needs an `AppHandle` and is therefore unreachable from
//! `cargo test`. That is deliberate: a test-exercised code path that writes to a real config
//! location can corrupt a developer's real configuration. No writer in this module can be
//! reached by a test without the test naming its own temp directory.
//!
//! ## `version`, and what a mismatch means
//!
//! [`STORE_VERSION`] is bumped when the on-disk schema changes in a way a reader cannot
//! absorb. Reading is deliberately **tolerant** — an older file loads and is re-stamped on
//! the next write, because `#[serde(default)]` on the model's later fields already handles
//! the additive case, which is the only case we have had. A *newer* file (a downgrade) is
//! loaded rather than discarded: throwing away a user's connections because they ran an
//! older build once is a worse outcome than showing a record with a field we ignore.

use std::path::{Path, PathBuf};

use crate::db::model::{DbConnection, DbConnectionStore};

/// The on-disk schema version stamped into every write.
///
/// `1` is the first shipped shape. Bump this **only** for a change a reader cannot absorb
/// with `#[serde(default)]`; adding a field is not one.
pub const STORE_VERSION: u32 = 1;

/// The file name inside the app config dir. Sibling to `api-store.json`.
const FILE_NAME: &str = "db-connections.json";

/// Load the store from `path`. **Any** failure yields [`DbConnectionStore::default`].
pub fn load(path: &Path) -> DbConnectionStore {
    let Ok(text) = std::fs::read_to_string(path) else {
        return DbConnectionStore::default();
    };
    serde_json::from_str::<DbConnectionStore>(&text).unwrap_or_default()
}

/// CRASH-SAFE write: serialize → sibling temp → `fsync` → atomic `rename`, then `0600`.
///
/// `version` is re-stamped on every write, so a file written by this build always says so.
/// The temp file lives in the same directory, which is what keeps the `rename` on one
/// filesystem and therefore atomic.
pub fn save(path: &Path, store: &DbConnectionStore) -> std::io::Result<()> {
    let mut stamped = store.clone();
    stamped.version = STORE_VERSION;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&stamped).unwrap_or_else(|_| "{}".to_string());
    // `store_file`: locked, a unique temp per write (born 0600 on unix), the temp
    // removed on failure, and on Windows a retried rename over a briefly-held file.
    let _guard = crate::store_file::lock(path);
    crate::store_file::write_atomic(path, json.as_bytes(), true)?;
    restrict_permissions(path);
    Ok(())
}

/// `0600` on Unix — stops other *users* on a shared machine, and nothing more (said
/// plainly). Best-effort: a filesystem that cannot express it must not fail the save, because
/// refusing to persist a connection over a permission bit is a worse outcome than the bit.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

/// No-op on non-Unix. Windows ACLs already inherit a per-user profile directory, and
/// pretending otherwise with a stub would be worse than saying nothing.
#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// Insert or replace `conn` in `list`, matching on `id`. Returns `true` when it replaced.
///
/// Pure over the list so the whole upsert decision is unit-testable without a filesystem;
/// the caller does the (atomic) write.
pub fn put(list: &mut Vec<DbConnection>, conn: DbConnection) -> bool {
    match list.iter_mut().find(|c| c.id == conn.id) {
        Some(slot) => {
            *slot = conn;
            true
        }
        None => {
            list.push(conn);
            false
        }
    }
}

/// Remove the connection with `id`. Returns `true` when something was removed, so
/// `db_connection_delete` can report a **measured** outcome rather than assuming one.
pub fn remove(list: &mut Vec<DbConnection>, id: &str) -> bool {
    let before = list.len();
    list.retain(|c| c.id != id);
    list.len() != before
}

/// The store file's path: the Tauri app config dir if available, else a `home_dir()`-based
/// fallback. **Always outside any workspace/repo and never `~/.claude`**.
///
/// Takes an `AppHandle`, so it cannot be called from a unit test — which is the point.
pub fn store_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        return dir.join(FILE_NAME);
    }
    fallback_store_path()
}

/// `~/.config/agent-studio/db-connections.json` — used when the Tauri config dir cannot be
/// resolved. Reuses `claude::home_dir`, the same fallback every sibling store uses.
fn fallback_store_path() -> PathBuf {
    crate::agent::claude::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("agent-studio")
        .join(FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::model::{DbEngineId, DbFamily, SavePassword, SslMode};

    /// A temp directory that removes itself, plus the store path inside it. Every test in
    /// this module writes **here** and nowhere else.
    struct Fixture {
        dir: PathBuf,
        file: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentstudio-db-store-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            let file = dir.join("db-connections.json");
            Self { dir, file }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn conn(id: &str, name: &str) -> DbConnection {
        DbConnection {
            id: id.to_string(),
            name: name.to_string(),
            engine: DbEngineId::Postgres,
            family: DbFamily::Postgres,
            host: "db.internal".into(),
            port: Some(5432),
            database: "maestro".into(),
            user: "ro".into(),
            password_ref: "{{PG_PW}}".into(),
            save_password: SavePassword::Forever,
            url: None,
            srv: false,
            ssl_mode: SslMode::Prefer,
            ca_summary: None,
            options: Default::default(),
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn a_missing_file_loads_as_an_empty_store_stamped_with_the_current_version() {
        let f = Fixture::new("missing");
        let loaded = load(&f.file);
        assert!(loaded.connections.is_empty());
        assert_eq!(loaded.version, STORE_VERSION);
    }

    #[test]
    fn a_corrupt_file_loads_as_empty_rather_than_failing_startup() {
        let f = Fixture::new("corrupt");
        std::fs::write(&f.file, "{ this is not json").unwrap();
        assert!(load(&f.file).connections.is_empty());

        // Well-formed JSON of the wrong shape is the sneakier case: serde must reject it and
        // the loader must still yield a usable store.
        std::fs::write(&f.file, r#"{"connections":"not a list"}"#).unwrap();
        assert!(load(&f.file).connections.is_empty());
    }

    #[test]
    fn a_saved_store_round_trips_and_the_version_is_restamped() {
        let f = Fixture::new("round-trip");
        let mut store = DbConnectionStore {
            connections: vec![conn("A", "Prod")],
            // A deliberately wrong version: `save` must overwrite it, so a file written by
            // this build always declares this build's schema.
            version: 999,
        };
        save(&f.file, &store).expect("save");
        let back = load(&f.file);
        assert_eq!(back.version, STORE_VERSION);
        store.version = STORE_VERSION;
        assert_eq!(back, store);
    }

    #[test]
    fn the_persisted_json_contains_no_secret_only_a_reference() {
        let f = Fixture::new("no-secret");
        save(
            &f.file,
            &DbConnectionStore {
                connections: vec![conn("A", "Prod")],
                version: STORE_VERSION,
            },
        )
        .expect("save");
        let text = std::fs::read_to_string(&f.file).unwrap();
        assert!(text.contains("{{PG_PW}}"), "the reference must survive");
        assert!(!text.contains("hunter2"));
        // camelCase on disk, because the same shape crosses the wire.
        assert!(text.contains("\"passwordRef\""));
        assert!(text.contains("\"readOnly\": true"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new("mode");
        save(&f.file, &DbConnectionStore::default()).expect("save");
        let mode = std::fs::metadata(&f.file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "db-connections.json must be owner-only");
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        let f = Fixture::new("tmp");
        save(&f.file, &DbConnectionStore::default()).expect("save");
        assert!(!f.dir.join("db-connections.json.tmp").exists());
    }

    #[test]
    fn put_replaces_by_id_and_appends_otherwise() {
        let mut list = vec![conn("A", "one")];
        assert!(!put(&mut list, conn("B", "two")), "B is new");
        assert_eq!(list.len(), 2);
        assert!(put(&mut list, conn("A", "renamed")), "A already existed");
        assert_eq!(list.len(), 2, "an update must not grow the list");
        assert_eq!(list[0].name, "renamed");
        assert_eq!(list[0].id, "A", "order is preserved on update");
    }

    #[test]
    fn remove_reports_whether_it_actually_removed_something() {
        let mut list = vec![conn("A", "one"), conn("B", "two")];
        assert!(remove(&mut list, "A"));
        assert_eq!(list.len(), 1);
        assert!(
            !remove(&mut list, "A"),
            "a second delete of the same id removed nothing, and must say so"
        );
    }
}
