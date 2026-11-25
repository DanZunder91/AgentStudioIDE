//! Persisted API-client store: saved requests (collections)
//! + environment variables.
//!
//! Backs the built-in API client's "save this request" and "reusable environment
//! variables" features, so it must survive app restarts. Stored as a single pretty
//! JSON blob: an [`ApiStore`] holding the whole collection list, the environment
//! list, and which environment is active.
//!
//! **WHERE it lives — the secret-safety guarantee:** this store is
//! written to the OS **app config dir** (`~/.config/agent-studio/api-store.json` on
//! the fallback path), the SAME place `recent_projects.rs` uses — and NEVER inside a
//! workspace/repo. Environment variables hold **live tokens** (a screenshot or a
//! commit that shows one leaks it), so keeping this file outside any git working
//! tree is exactly what stops a secret from ever being committed.
//! No git operation can reach it. That is not an implementation detail; it is a standing rule.
//!
//! **Robustness over correctness of the file:** a missing, unreadable, or corrupt
//! store is treated as an empty [`ApiStore`], never an error — loading the API store
//! must not be able to break UI startup. (Same contract as `recent_projects.rs`.)
//!
//! The store logic ([`load`], [`save`]) operates on an explicit file path so it is
//! unit-testable against a temp dir, with no dependency on the real app config dir.
//! The `#[tauri::command]`s are the thin glue that resolves that path from the
//! `AppHandle`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name inside the config dir.
const FILE_NAME: &str = "api-store.json";

/// One request/response header. Same shape (and camelCase wire form) as
/// `http::HttpHeader`, so a saved request's headers round-trip straight into a send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

/// A saved request in a collection. `id` is a stable client-generated key; the rest
/// is everything needed to replay the request.
///
/// **Protocol-aware:** a collection holds HTTP, WebSocket, AND gRPC
/// requests, so the shared fields carry each protocol's core and the optional tail
/// carries what only one protocol needs. The tail is `#[serde(default,
/// skip_serializing_if = "Option::is_none")]` so pre-existing HTTP-only store files
/// (written before this field set) still load, and an HTTP save stays byte-identical
/// on the wire (no `null` noise). Field reuse mirrors the live `ApiRequestState`:
///   • HTTP — `method`/`url`/`headers`/`body`.
///   • WS   — `url` is the socket URL, `headers` the connect headers; `protocol="ws"`.
///   • gRPC — `url` is the endpoint, `body` the request message, `headers` the
///     metadata, plus `grpc_service`/`grpc_method`/`plaintext`; `protocol="grpc"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: String,
    /// `"http"` (or absent, for legacy files) / `"ws"` / `"grpc"`. Decides which
    /// surface the request re-opens into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// gRPC: the picked service FQN. Absent for HTTP/WS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grpc_service: Option<String>,
    /// gRPC: the picked method name. Absent for HTTP/WS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grpc_method: Option<String>,
    /// gRPC: h2c (no TLS) when `Some(true)`. Absent for HTTP/WS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaintext: Option<bool>,
    /// The [`Folder`] this request is filed under, or `None` for **the root**.
    ///
    /// `None`-means-root is what makes folders a zero-migration change: every request
    /// written before folders existed has no `folderId` key, loads as `None`, and shows
    /// up at the root — which is exactly the rule that requests saved before
    /// folders existed stay at the root. `skip_serializing_if` keeps a root request's
    /// JSON byte-identical to what it was before this field existed, so an unused
    /// feature costs the file nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

/// A folder grouping saved requests.
///
/// Deliberately **flat**: a folder holds requests, never other folders. Nesting is not
/// required, and a tree would bring cycle checks, a move-into-descendant rule and a
/// recursive delete — three ways to lose someone's saved work in exchange for depth
/// the feature does not need.
///
/// `order` is the display rank, stamped by this module. The invariant every mutator
/// upholds — and [`folders_are_ranked_in_vec_order`] asserts — is that
/// [`ApiStore::folders`] is **stored in display order** and `order` equals the index.
/// One ordering, in one place: the frontend renders the vec as it comes and never
/// re-sorts, so there is no second sort to disagree with this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub order: u32,
}

/// One environment variable — a `key`/`value` pair. **`value` may be a live secret**
/// (an API token), which is the whole reason this store lives in the config dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// A named environment: a bag of variables the user switches between (e.g. `dev` vs
/// `prod`). `id` is a stable client-generated key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub variables: Vec<EnvVar>,
}

/// The whole persisted blob: every saved request, every environment, and which
/// environment (if any) is active. Persisted as one file — the store is small and
/// the UI saves it wholesale.
///
/// [`Default`] is an **empty** store: no collections, no environments, no active id.
/// That is exactly what a missing/corrupt file loads as.
///
/// 🔴 **Every field here MUST carry `#[serde(default)]`, forever.** [`load`] falls back
/// to `ApiStore::default()` on *any* parse failure, and a missing field IS a parse
/// failure — so one field added without a default would make every store file on every
/// existing install fail to parse, load as empty, and then be **overwritten with that
/// emptiness** by the next save. That is not a lost feature, it is the user's saved
/// requests *and* their live API tokens (and the DB client's Vault, which is this same
/// file) deleted without a word. `folders_field_is_optional_so_a_pre_folders_file_survives`
/// is the regression test; it loads a file written before folders existed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStore {
    #[serde(default)]
    pub collections: Vec<SavedRequest>,
    #[serde(default)]
    pub environments: Vec<Environment>,
    /// The active environment's `id`, or `None` if no environment is selected.
    #[serde(default)]
    pub active_environment_id: Option<String>,
    /// Folders grouping the collections, **in display order** (see [`Folder`]).
    /// `#[serde(default)]` is what lets a pre-folders file load — see the type doc.
    #[serde(default)]
    pub folders: Vec<Folder>,
}

/* ───────────────────────────── folders: pure mutators ───────────────────────────── */

/// Said when a folder id names nothing. One sentence, one site — a message duplicated
/// per call site is a message that drifts.
fn no_such_folder(id: &str) -> String {
    format!("That folder no longer exists (id {id}).")
}

/// Said when a request id names nothing.
fn no_such_request(id: &str) -> String {
    format!("That saved request no longer exists (id {id}).")
}

/// Said when a folder name is blank. Rejected rather than defaulted: a "sensible
/// default" name is a value the user never typed, and an unnamed folder
/// is indistinguishable from every other unnamed folder in the rail.
const BLANK_FOLDER_NAME: &str = "A folder needs a name.";

/// Re-stamp `order` from the vec position, restoring the module invariant after any
/// mutation that inserts, removes or reorders.
fn restamp(store: &mut ApiStore) {
    for (i, f) in store.folders.iter_mut().enumerate() {
        f.order = i as u32;
    }
}

/// Append a folder named `name` with the client-opaque `id`, and return it.
///
/// New folders land at the END, which is the only placement that cannot reorder
/// anything the user already arranged.
pub fn create_folder(store: &mut ApiStore, id: String, name: &str) -> Result<Folder, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(BLANK_FOLDER_NAME.to_string());
    }
    let folder = Folder {
        id,
        name: name.to_string(),
        order: store.folders.len() as u32,
    };
    store.folders.push(folder.clone());
    Ok(folder)
}

/// Rename a folder in place. Unknown id or a blank name is an `Err` — never a silent
/// no-op, because the rail would then show the old name with no explanation.
pub fn rename_folder(store: &mut ApiStore, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(BLANK_FOLDER_NAME.to_string());
    }
    let folder = store
        .folders
        .iter_mut()
        .find(|f| f.id == id)
        .ok_or_else(|| no_such_folder(id))?;
    folder.name = name.to_string();
    Ok(())
}

/// Delete a folder and **return its requests to the root** — they are NOT deleted.
/// Returns how many requests moved.
///
/// 🔴 The destructive alternative (cascade-delete the contents) was rejected: the
/// dangerous case is a user who filed thirty saved requests into a folder and then
/// tidies up the folder. A cascade there is unrecoverable — this store has no undo and
/// no trash — while "the requests come back to the root" is at worst a moment of
/// untidiness the user can fix by dragging. Same reasoning as `db_connection_delete`'s
/// cascade being *explicit* rather than incidental: destruction is opt-in, never the
/// default of an unrelated gesture.
pub fn delete_folder(store: &mut ApiStore, id: &str) -> Result<usize, String> {
    if !store.folders.iter().any(|f| f.id == id) {
        return Err(no_such_folder(id));
    }
    store.folders.retain(|f| f.id != id);
    let mut orphaned = 0usize;
    for c in store.collections.iter_mut() {
        if c.folder_id.as_deref() == Some(id) {
            c.folder_id = None;
            orphaned += 1;
        }
    }
    restamp(store);
    Ok(orphaned)
}

/// File `request_id` under `folder_id`, or at the root when `folder_id` is `None`.
///
/// Both ids are checked: a drop onto a folder another window just deleted must say so
/// rather than quietly filing the request somewhere it is not visible.
pub fn move_request(
    store: &mut ApiStore,
    request_id: &str,
    folder_id: Option<&str>,
) -> Result<(), String> {
    if let Some(fid) = folder_id {
        if !store.folders.iter().any(|f| f.id == fid) {
            return Err(no_such_folder(fid));
        }
    }
    let request = store
        .collections
        .iter_mut()
        .find(|c| c.id == request_id)
        .ok_or_else(|| no_such_request(request_id))?;
    request.folder_id = folder_id.map(str::to_string);
    Ok(())
}

/// Reorder the folders to exactly the sequence `ids`, re-stamping `order`.
///
/// `ids` must be a **permutation** of the stored folder ids — same length, no
/// duplicates, every id known. Anything else is an `Err`, not a best-effort merge: a
/// short list would silently drop folders from the file, which is the whole class of
/// bug this module is being careful about. The frontend produces `ids` with the shared,
/// property-tested `moveBefore`, so this end never re-implements the move.
pub fn reorder_folders(store: &mut ApiStore, ids: &[String]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            return Err(format!("Folder {id} was listed twice in the new order."));
        }
        if !store.folders.iter().any(|f| &f.id == id) {
            return Err(no_such_folder(id));
        }
    }
    if ids.len() != store.folders.len() {
        return Err(format!(
            "The new order lists {} folders but the store holds {}.",
            ids.len(),
            store.folders.len()
        ));
    }
    let mut rest = std::mem::take(&mut store.folders);
    let mut reordered: Vec<Folder> = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(at) = rest.iter().position(|f| &f.id == id) {
            reordered.push(rest.remove(at));
        }
    }
    // `rest` is empty here: the checks above proved `ids` is a permutation.
    store.folders = reordered;
    restamp(store);
    Ok(())
}

/// Load the store from `path`. **Any** failure — missing file, unreadable, corrupt
/// JSON, or a JSON value that isn't a well-shaped [`ApiStore`] — yields
/// [`ApiStore::default()`] (an empty store), so startup can never break on a bad
/// file. (Exactly `recent_projects::load`'s robustness contract.)
pub fn load(path: &Path) -> ApiStore {
    let Ok(text) = std::fs::read_to_string(path) else {
        return ApiStore::default();
    };
    serde_json::from_str::<ApiStore>(&text).unwrap_or_default()
}

/// Write `store` to `path` as pretty JSON, creating the parent dir if needed.
///
/// **CRASH-SAFE and owner-only.** This file is the app's one secret store — the DB client reuses
/// it as its Vault rather than inventing a second one — so:
///
/// * the writer is `pinned_agents::save`'s: sibling temp → `write_all` → `sync_all` → atomic
///   `rename`. A crash leaves either the old file or the new one, never a half-written blob. The
///   previous plain `std::fs::write` could truncate this file and lose every stored secret;
/// * the mode is `0600`, which stops other *users* on a shared machine reading it. This is
///   not encryption and must not be described as such.
///
/// `pub(crate)` rather than private because `db::` writes the Vault when a connection's password
/// is saved `forever`. One writer, one file.
///
/// **Locked, with a unique temp** ([`crate::store_file`]): the file has four
/// writers (the blob save, the folder commands, `db::upsert`, the portability import) and they
/// used to share one fixed temp name with no lock — one could delete or rename another's
/// half-written temp. A save now queues behind any in-flight [`edit_store`] / [`update`].
pub(crate) fn save(path: &Path, store: &ApiStore) -> std::io::Result<()> {
    let _guard = crate::store_file::lock(path);
    let json = serde_json::to_string_pretty(store).unwrap_or_else(|_| "{}".to_string());
    crate::store_file::write_atomic(path, json.as_bytes(), true)
}

/// Load → `edit` → save under the store's lock, so no other writer in this process can land
/// between the read and the write. Returns the saved store and `edit`'s value.
/// `edit` returning `Err` writes nothing.
pub(crate) fn update<R, E>(
    path: &Path,
    edit: impl FnOnce(&mut ApiStore) -> Result<R, E>,
    write_err: impl FnOnce(std::io::Error) -> E,
) -> Result<(ApiStore, R), E> {
    let _guard = crate::store_file::lock(path);
    let mut store = load(path);
    let out = edit(&mut store)?;
    save(path, &store).map_err(write_err)?;
    Ok((store, out))
}

/// The store file inside the app config dir `dir` — where [`store_path`] puts it, for a
/// caller that already holds the dir (the agent tools, whose tests pass a temp dir).
pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The store file's path: the Tauri app config dir if available (created on write),
/// else a `home_dir()`-based fallback. **Always outside any workspace/repo** — that
/// is the secret-safety guarantee.
fn store_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        return dir.join(FILE_NAME);
    }
    fallback_store_path()
}

/// [`store_path`] for the rest of the crate. `db::` needs it because the DB client's Vault **is**
/// this file (one secret store, not two), and it resolves the path at the same gesture it
/// writes it. Deliberately a thin alias rather than making `store_path` public, so the name at
/// the call site says whose file it is.
pub(crate) fn store_path_for(app: &tauri::AppHandle) -> PathBuf {
    store_path(app)
}

/// `~/.config/agent-studio/api-store.json` — used when the Tauri config dir can't be
/// resolved. Reuses `claude::home_dir` (the same fallback `recent_projects.rs` uses).
fn fallback_store_path() -> PathBuf {
    crate::agent::claude::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("agent-studio")
        .join(FILE_NAME)
}

/// The persisted API store. Missing/corrupt file → an empty [`ApiStore`].
///
/// Frontend contract: `invoke<ApiStore>('api_store_load')`.
#[tauri::command]
pub fn api_store_load(app: tauri::AppHandle) -> ApiStore {
    load(&store_path(&app))
}

/// Persist the whole `store` blob, replacing whatever was there.
///
/// Frontend contract: `invoke('api_store_save', { store })`. A write failure surfaces
/// as an `Err(String)` so the UI can note it — but this never panics.
#[tauri::command]
pub fn api_store_save(app: tauri::AppHandle, store: ApiStore) -> Result<(), String> {
    save(&store_path(&app), &store).map_err(|e| e.to_string())
}

/* ───────────────────────────── folders: the commands ───────────────────────────── */

/// Load → mutate → save → hand the WHOLE store back. The path-injected core of every
/// folder command, so all five share one transaction shape and one test seam.
///
/// 🔴 **Read-modify-write, deliberately** — and the reason folders are commands
/// rather than more fields on the frontend's `api_store_save` blob. The webview holds an
/// in-memory mirror of this file hydrated ONCE per app run, while Rust also writes the
/// file (`db_connection_upsert` puts a DB password in the Vault). A blob save from a
/// stale mirror overwrites whatever Rust wrote in between. These commands re-read the
/// file at the moment of the change, so a folder gesture can never lose a password —
/// and because they return the fresh store, the frontend re-hydrates its mirror on
/// every one of them, which shrinks that window for the blob path too.
///
/// The write is [`save`]'s atomic temp→fsync→rename, so a crash mid-gesture leaves the
/// old file, never a half-written one.
fn edit_store<F>(path: &Path, edit: F) -> Result<ApiStore, String>
where
    F: FnOnce(&mut ApiStore) -> Result<(), String>,
{
    // Under the store's lock (`update`): a concurrent `db::upsert` or blob save waits for
    // this gesture instead of interleaving with it.
    update(path, edit, |e| {
        format!("Could not write the API store: {e}")
    })
    .map(|(s, ())| s)
}

/// Create a folder named `name`; returns the whole updated store.
///
/// The id is minted HERE rather than by the client, for the same reason `order` is: the
/// file's shape is this module's invariant, and a duplicate id arriving from a webview
/// would put two folders in the rail that delete and rename as one.
///
/// Frontend contract: `invoke<ApiStore>('api_folder_create', { name })`.
#[tauri::command]
pub fn api_folder_create(app: tauri::AppHandle, name: String) -> Result<ApiStore, String> {
    edit_store(&store_path(&app), |store| {
        create_folder(store, ulid::Ulid::new().to_string(), &name).map(|_| ())
    })
}

/// Rename a folder. Frontend contract: `invoke<ApiStore>('api_folder_rename', { id, name })`.
#[tauri::command]
pub fn api_folder_rename(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<ApiStore, String> {
    edit_store(&store_path(&app), |store| rename_folder(store, &id, &name))
}

/// Delete a folder; **its requests return to the root** (see [`delete_folder`]).
///
/// Frontend contract: `invoke<ApiStore>('api_folder_delete', { id })`.
#[tauri::command]
pub fn api_folder_delete(app: tauri::AppHandle, id: String) -> Result<ApiStore, String> {
    edit_store(&store_path(&app), |store| {
        delete_folder(store, &id).map(|_| ())
    })
}

/// Reorder the folders to `ids` (a permutation — see [`reorder_folders`]).
///
/// Frontend contract: `invoke<ApiStore>('api_folder_reorder', { ids })`.
#[tauri::command]
pub fn api_folder_reorder(app: tauri::AppHandle, ids: Vec<String>) -> Result<ApiStore, String> {
    edit_store(&store_path(&app), |store| reorder_folders(store, &ids))
}

/// File a saved request under a folder, or at the root when `folderId` is null.
///
/// Frontend contract: `invoke<ApiStore>('api_request_move', { requestId, folderId })`.
#[tauri::command]
pub fn api_request_move(
    app: tauri::AppHandle,
    request_id: String,
    folder_id: Option<String>,
) -> Result<ApiStore, String> {
    edit_store(&store_path(&app), |store| {
        move_request(store, &request_id, folder_id.as_deref())
    })
}

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
            let dir = std::env::temp_dir().join(format!(
                "agentstudio-apistore-{label}-{}",
                ulid::Ulid::new()
            ));
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

    /// A representative, fully-populated store: a saved request (with headers + body)
    /// and an environment with variables, plus an active id — everything the wire
    /// contract carries.
    fn sample_store() -> ApiStore {
        ApiStore {
            collections: vec![SavedRequest {
                id: "req-1".into(),
                name: "Get user".into(),
                method: "GET".into(),
                url: "https://api.example.com/user".into(),
                headers: vec![
                    HttpHeader {
                        name: "Authorization".into(),
                        value: "Bearer {{TOKEN}}".into(),
                    },
                    HttpHeader {
                        name: "Accept".into(),
                        value: "application/json".into(),
                    },
                ],
                body: "{\"q\":\"v\"}".into(),
                protocol: Some("http".into()),
                grpc_service: None,
                grpc_method: None,
                plaintext: None,
                folder_id: None,
            }],
            environments: vec![Environment {
                id: "env-1".into(),
                name: "prod".into(),
                variables: vec![EnvVar {
                    key: "BASE".into(),
                    value: "https://api.example.com".into(),
                }],
            }],
            active_environment_id: Some("env-1".into()),
            folders: Vec::new(),
        }
    }

    /// A bare saved request — only the fields a caller cares about here. Keeps the
    /// folder tests about folders instead of about the protocol tail.
    fn req(id: &str, folder_id: Option<&str>) -> SavedRequest {
        SavedRequest {
            id: id.into(),
            name: format!("Request {id}"),
            method: "GET".into(),
            url: "https://api.example.com/x".into(),
            headers: Vec::new(),
            body: String::new(),
            protocol: None,
            grpc_service: None,
            grpc_method: None,
            plaintext: None,
            folder_id: folder_id.map(str::to_string),
        }
    }

    #[test]
    fn round_trips_a_full_store() {
        let f = Fixture::new("roundtrip");
        let store = sample_store();
        save(&f.store, &store).unwrap();
        // A brand-new read of the same file returns exactly what we saved.
        assert_eq!(load(&f.store), store);
    }

    #[test]
    fn path_in_is_the_store_file_inside_the_config_dir() {
        let f = Fixture::new("path-in");
        assert_eq!(path_in(&f.dir), f.store);
    }

    #[test]
    fn missing_file_reads_as_default_empty_store() {
        let f = Fixture::new("missing");
        assert_eq!(
            load(&f.store),
            ApiStore::default(),
            "no file yet => empty store"
        );
        // Spell out the "empty" contract, not just equality with default.
        let s = load(&f.store);
        assert!(s.collections.is_empty());
        assert!(s.environments.is_empty());
        assert!(s.active_environment_id.is_none());
    }

    #[test]
    fn corrupt_file_reads_as_default_never_errors() {
        let f = Fixture::new("corrupt");
        // Junk, a bare scalar, empty, and a wrong-shape value (an array where an
        // object is expected) all fall back to the empty store rather than erroring.
        for junk in ["{ not json", "42", "", "[1, 2, 3]", "\"a string\"", "null"] {
            std::fs::write(&f.store, junk).unwrap();
            assert_eq!(
                load(&f.store),
                ApiStore::default(),
                "corrupt {junk:?} must read as the default store"
            );
        }
    }

    #[test]
    fn a_secret_value_round_trips_intact() {
        // The store holds real secrets — which is exactly why it must live in the
        // app config dir, never the repo. Prove a token survives a
        // save/load with byte-for-byte fidelity.
        let f = Fixture::new("secret");
        let secret = "sk-live-abc";
        let store = ApiStore {
            environments: vec![Environment {
                id: "env-secret".into(),
                name: "live".into(),
                variables: vec![EnvVar {
                    key: "TOKEN".into(),
                    value: secret.into(),
                }],
            }],
            ..ApiStore::default()
        };
        save(&f.store, &store).unwrap();
        let loaded = load(&f.store);
        assert_eq!(loaded.environments[0].variables[0].key, "TOKEN");
        assert_eq!(
            loaded.environments[0].variables[0].value, secret,
            "the secret token must round-trip intact"
        );
    }

    /// The Vault's four writers, concurrently: folder gestures (`edit_store`) and
    /// Vault puts (`update`, the `db::upsert` path) racing on one file. Every one must land —
    /// without the lock, a save from a store loaded before another
    /// writer's save dropped that writer's change. Falsify: drop the lock in `update`.
    #[test]
    fn concurrent_vault_writers_lose_no_update() {
        let f = Fixture::new("concurrent");
        save(&f.store, &ApiStore::default()).unwrap();
        let store = std::sync::Arc::new(f.store.clone());
        let threads: Vec<_> = (0..12)
            .map(|i| {
                let store = std::sync::Arc::clone(&store);
                std::thread::spawn(move || {
                    if i % 2 == 0 {
                        edit_store(&store, |s| {
                            create_folder(s, format!("f{i}"), &format!("folder {i}")).map(|_| ())
                        })
                        .unwrap();
                    } else {
                        update(
                            &store,
                            |s| {
                                crate::db::secret::put(s, &format!("PW_{i}"), "hunter2");
                                Ok::<_, String>(())
                            },
                            |e| e.to_string(),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let got = load(&f.store);
        assert_eq!(got.folders.len(), 6, "a folder gesture was lost");
        let vars: usize = got.environments.iter().map(|e| e.variables.len()).sum();
        assert_eq!(vars, 6, "a Vault secret was lost");
        let names: Vec<String> = std::fs::read_dir(&f.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![FILE_NAME.to_string()],
            "a temp (with secrets) was left behind"
        );
    }

    #[test]
    fn save_creates_the_parent_dir_if_absent() {
        let f = Fixture::new("mkdir");
        // A store path nested under directories that don't exist yet.
        let nested = f.dir.join("a").join("b").join(FILE_NAME);
        assert!(!nested.parent().unwrap().exists(), "parent absent to start");
        save(&nested, &sample_store()).unwrap();
        assert!(nested.exists(), "save must create the file");
        assert_eq!(load(&nested), sample_store(), "…and it must be readable");
    }

    #[test]
    fn saved_json_is_camel_case_on_the_wire() {
        // The frontend reads camelCase keys; assert the serialized
        // form uses `activeEnvironmentId`, not the Rust `active_environment_id`.
        let f = Fixture::new("camel");
        save(&f.store, &sample_store()).unwrap();
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("activeEnvironmentId"),
            "wire form must be camelCase: {text}"
        );
        assert!(
            !text.contains("active_environment_id"),
            "must not leak the snake_case field name: {text}"
        );
    }

    #[test]
    fn grpc_saved_request_round_trips_its_protocol_tail() {
        // A gRPC collection entry carries the protocol tail (service/method/plaintext);
        // all of it must survive a save/load intact so it re-opens into the gRPC surface.
        let f = Fixture::new("grpc");
        let store = ApiStore {
            collections: vec![SavedRequest {
                id: "g-1".into(),
                name: "Echo".into(),
                method: String::new(),
                url: "localhost:50051".into(),
                headers: vec![HttpHeader {
                    name: "authorization".into(),
                    value: "Bearer {{TOKEN}}".into(),
                }],
                body: "{\"msg\":\"hi\"}".into(),
                protocol: Some("grpc".into()),
                grpc_service: Some("echo.Echo".into()),
                grpc_method: Some("Unary".into()),
                plaintext: Some(true),
                folder_id: None,
            }],
            ..ApiStore::default()
        };
        save(&f.store, &store).unwrap();
        let loaded = load(&f.store);
        assert_eq!(loaded, store, "the gRPC tail must round-trip intact");
        let c = &loaded.collections[0];
        assert_eq!(c.protocol.as_deref(), Some("grpc"));
        assert_eq!(c.grpc_service.as_deref(), Some("echo.Echo"));
        assert_eq!(c.grpc_method.as_deref(), Some("Unary"));
        assert_eq!(c.plaintext, Some(true));
    }

    #[test]
    fn legacy_http_only_entry_loads_with_an_absent_protocol_tail() {
        // A store file from before WS/gRPC support has NO protocol/grpc* keys. It must
        // still load — the tail defaults to None (treated as HTTP by the frontend),
        // never an error. This is the back-compat guarantee of the serde defaults.
        let f = Fixture::new("legacy");
        let legacy = r#"{
            "collections": [
                { "id": "old-1", "name": "Get", "method": "GET",
                  "url": "https://api.example.com/x", "headers": [], "body": "" }
            ],
            "environments": [],
            "activeEnvironmentId": null
        }"#;
        std::fs::write(&f.store, legacy).unwrap();
        let loaded = load(&f.store);
        assert_eq!(loaded.collections.len(), 1, "legacy entry must load");
        let c = &loaded.collections[0];
        assert_eq!(c.protocol, None, "absent protocol => None (HTTP)");
        assert_eq!(c.grpc_service, None);
        assert_eq!(c.plaintext, None);
    }

    #[test]
    fn http_save_omits_the_grpc_tail_on_the_wire() {
        // skip_serializing_if keeps an HTTP save clean: no grpcService/grpcMethod/
        // plaintext keys, and `protocol` only if set. Guards against `null` noise
        // creeping into every saved HTTP request.
        let f = Fixture::new("http-clean");
        save(&f.store, &sample_store()).unwrap();
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("\"protocol\": \"http\""),
            "http protocol kept: {text}"
        );
        assert!(
            !text.contains("grpcService"),
            "no gRPC tail on an HTTP save: {text}"
        );
        assert!(
            !text.contains("grpcMethod"),
            "no gRPC tail on an HTTP save: {text}"
        );
        assert!(
            !text.contains("plaintext"),
            "no gRPC tail on an HTTP save: {text}"
        );
    }

    /* ─────────────────────────────────── folders ──────────────────────────────────── */

    /// 🔴 THE test that protects real user data, and the reason every `ApiStore` field
    /// carries `#[serde(default)]`.
    ///
    /// The JSON below is written **by hand** to be exactly what an install from before
    /// folders existed has on disk: three keys, no `folders`, no `folderId`. It is not
    /// produced by serializing today's struct — that would round-trip the current shape
    /// and prove nothing about the old one (an expectation derived from the
    /// code under test can only catch plumbing).
    ///
    /// Without `#[serde(default)] folders`, `load` fails to parse → `unwrap_or_default()`
    /// → an EMPTY store → the next save writes that emptiness over the file. The user
    /// loses every saved request **and** every environment variable, which in this file
    /// means live API tokens and the DB client's Vault. Falsified before being trusted:
    /// removing the attribute turns this red on the very first assertion.
    #[test]
    fn folders_field_is_optional_so_a_pre_folders_file_survives() {
        let f = Fixture::new("pre-folders");
        let old_file = r#"{
          "collections": [
            {
              "id": "c-1",
              "name": "CreateWidget",
              "method": "POST",
              "url": "https://api.example.com/widget",
              "headers": [{ "name": "Authorization", "value": "Bearer {{API_TOKEN}}" }],
              "body": "{\"seed\":1}",
              "protocol": "http"
            },
            {
              "id": "c-2",
              "name": "Booking",
              "method": "GET",
              "url": "localhost:50051",
              "headers": [],
              "body": "{}",
              "protocol": "grpc",
              "grpcService": "widget.Widget",
              "grpcMethod": "Booking",
              "plaintext": true
            }
          ],
          "environments": [
            {
              "id": "env-1",
              "name": "live",
              "variables": [
                { "key": "API_TOKEN", "value": "token-do-not-lose-me" },
                { "key": "DB_PASSWORD", "value": "hunter2" }
              ]
            }
          ],
          "activeEnvironmentId": "env-1"
        }"#;
        std::fs::write(&f.store, old_file).unwrap();

        let loaded = load(&f.store);

        // Not `!= default()` — spell out that EVERY request and EVERY secret survived.
        assert_eq!(
            loaded.collections.len(),
            2,
            "both saved requests must survive"
        );
        assert_eq!(loaded.collections[0].name, "CreateWidget");
        assert_eq!(
            loaded.collections[0].headers[0].value, "Bearer {{API_TOKEN}}",
            "the placeholder header must survive verbatim"
        );
        assert_eq!(
            loaded.collections[1].grpc_service.as_deref(),
            Some("widget.Widget")
        );
        assert_eq!(loaded.collections[1].plaintext, Some(true));
        // The secrets — the half of this file that cannot be reconstructed by hand.
        let vars = &loaded.environments[0].variables;
        assert_eq!(vars.len(), 2, "both Vault variables must survive");
        assert_eq!(vars[0].value, "token-do-not-lose-me", "the live API token");
        assert_eq!(vars[1].value, "hunter2", "the DB client's Vault password");
        assert_eq!(loaded.active_environment_id.as_deref(), Some("env-1"));
        // …and the new field simply reads as empty, with every old request at the root.
        assert!(loaded.folders.is_empty(), "no folders in an old file");
        assert!(
            loaded.collections.iter().all(|c| c.folder_id.is_none()),
            "requests saved before folders existed stay at the root"
        );

        // The second half of the hazard: a save AFTER the load must not have narrowed
        // the file. Re-save what we loaded and re-read it — everything is still there.
        save(&f.store, &loaded).unwrap();
        assert_eq!(
            load(&f.store),
            loaded,
            "a save-after-load must not lose anything"
        );
    }

    /// The same guarantee taken to its limit: `{}` — a file with NO keys at all — is a
    /// valid empty store rather than a parse failure. Cheap, and it is the assertion
    /// that would still fail if someone added a defaulted field but removed one of the
    /// existing three's attributes.
    #[test]
    fn an_empty_json_object_loads_as_an_empty_store() {
        let f = Fixture::new("empty-object");
        std::fs::write(&f.store, "{}").unwrap();
        assert_eq!(load(&f.store), ApiStore::default());
    }

    /// A root request stays byte-identical on the wire: no `folderId` key at all. An
    /// unused feature must not rewrite every line of everybody's file.
    #[test]
    fn a_root_request_writes_no_folder_id_key() {
        let f = Fixture::new("root-clean");
        save(&f.store, &sample_store()).unwrap();
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            !text.contains("folderId"),
            "no folderId on a root request: {text}"
        );
        // …but the folders list itself IS always written (it is the store's own shape,
        // and an absent key would be indistinguishable from "this build has no folders").
        assert!(
            text.contains("\"folders\": []"),
            "folders always present: {text}"
        );
    }

    /// Create → move a request in → reload FROM DISK → still grouped. The round trip the
    /// whole feature is for, driven through the real command core (`edit_store`), so the
    /// load/mutate/save transaction is what is under test rather than a struct in memory.
    #[test]
    fn a_folder_and_its_requests_survive_a_reload_from_disk() {
        let f = Fixture::new("roundtrip-folders");
        // Seed two saved requests the way an existing user's file has them: at the root.
        save(
            &f.store,
            &ApiStore {
                collections: vec![req("c-1", None), req("c-2", None)],
                ..ApiStore::default()
            },
        )
        .unwrap();

        let after_create = edit_store(&f.store, |s| {
            create_folder(s, "f-1".into(), "Widget").map(|_| ())
        })
        .unwrap();
        assert_eq!(after_create.folders.len(), 1);
        assert_eq!(after_create.folders[0].name, "Widget");
        assert_eq!(after_create.folders[0].order, 0);

        edit_store(&f.store, |s| move_request(s, "c-1", Some("f-1"))).unwrap();

        // The assertion that matters: a FRESH read of the file, as a restart would do.
        let reloaded = load(&f.store);
        assert_eq!(reloaded.folders.len(), 1, "the folder survived the restart");
        assert_eq!(reloaded.folders[0].id, "f-1");
        assert_eq!(
            reloaded.collections[0].folder_id.as_deref(),
            Some("f-1"),
            "the moved request is still grouped"
        );
        assert_eq!(
            reloaded.collections[1].folder_id, None,
            "the untouched request is still at the root"
        );
    }

    /// 🔴 The delete decision, asserted rather than described: deleting a folder does
    /// NOT delete the requests filed in it — they return to the root. If this ever
    /// becomes a cascade it must be a deliberate ADR, not a quiet change under a green
    /// suite.
    #[test]
    fn deleting_a_folder_returns_its_requests_to_the_root_and_never_deletes_them() {
        let f = Fixture::new("delete-folder");
        let store = edit_store(&f.store, |s| {
            s.collections = vec![
                req("c-1", Some("f-1")),
                req("c-2", Some("f-1")),
                req("c-3", None),
            ];
            create_folder(s, "f-1".into(), "Widget").map(|_| ())
        })
        .unwrap();
        assert_eq!(store.collections.len(), 3);

        let after = edit_store(&f.store, |s| delete_folder(s, "f-1").map(|_| ())).unwrap();

        assert!(after.folders.is_empty(), "the folder is gone");
        assert_eq!(after.collections.len(), 3, "NOTHING was deleted with it");
        assert!(
            after.collections.iter().all(|c| c.folder_id.is_none()),
            "every request in the deleted folder came back to the root"
        );
        // And it is on disk that way, not just in the returned value.
        assert_eq!(load(&f.store), after);
    }

    /// `delete_folder` reports how many requests it un-filed, and refuses an unknown id
    /// rather than reporting a cheerful zero (say it in the OUTPUT).
    #[test]
    fn delete_folder_counts_what_it_moved_and_rejects_an_unknown_id() {
        let mut store = ApiStore {
            collections: vec![req("c-1", Some("f-1")), req("c-2", None)],
            folders: vec![Folder {
                id: "f-1".into(),
                name: "W".into(),
                order: 0,
            }],
            ..ApiStore::default()
        };
        assert_eq!(
            delete_folder(&mut store, "f-1").unwrap(),
            1,
            "one request un-filed"
        );
        let err = delete_folder(&mut store, "f-1").unwrap_err();
        assert!(
            err.contains("f-1"),
            "the message names the missing folder: {err}"
        );
        assert!(
            err.contains("no longer exists"),
            "…and says what went wrong: {err}"
        );
    }

    /// Moving to `None` is "back to the root", and both ids are validated. The unknown-
    /// folder case is the one that matters: a silent success would file the request
    /// somewhere the rail cannot show it.
    #[test]
    fn move_request_validates_both_ids_and_none_means_root() {
        let mut store = ApiStore {
            collections: vec![req("c-1", None)],
            folders: vec![Folder {
                id: "f-1".into(),
                name: "W".into(),
                order: 0,
            }],
            ..ApiStore::default()
        };
        move_request(&mut store, "c-1", Some("f-1")).unwrap();
        assert_eq!(store.collections[0].folder_id.as_deref(), Some("f-1"));
        move_request(&mut store, "c-1", None).unwrap();
        assert_eq!(store.collections[0].folder_id, None, "None means root");

        assert!(move_request(&mut store, "c-1", Some("nope"))
            .unwrap_err()
            .contains("nope"));
        assert!(move_request(&mut store, "nope", None)
            .unwrap_err()
            .contains("nope"));
        // The failed moves changed nothing.
        assert_eq!(store.collections[0].folder_id, None);
    }

    /// A blank (or whitespace-only) name is refused on create AND on rename, and rename
    /// refuses an unknown id.
    #[test]
    fn folder_names_are_trimmed_and_never_blank() {
        let mut store = ApiStore::default();
        assert_eq!(
            create_folder(&mut store, "f-1".into(), "   ").unwrap_err(),
            BLANK_FOLDER_NAME
        );
        assert!(
            store.folders.is_empty(),
            "the rejected create wrote nothing"
        );

        let made = create_folder(&mut store, "f-1".into(), "  Widget  ").unwrap();
        assert_eq!(made.name, "Widget", "the stored name is trimmed");

        assert_eq!(
            rename_folder(&mut store, "f-1", " ").unwrap_err(),
            BLANK_FOLDER_NAME
        );
        assert_eq!(
            store.folders[0].name, "Widget",
            "the rejected rename changed nothing"
        );
        rename_folder(&mut store, "f-1", " Maestro ").unwrap();
        assert_eq!(store.folders[0].name, "Maestro");
        assert!(rename_folder(&mut store, "gone", "X")
            .unwrap_err()
            .contains("gone"));
    }

    /// New folders land at the end, and `order` matches the vec index — the invariant
    /// the frontend leans on when it renders the list without re-sorting it.
    #[test]
    fn folders_are_ranked_in_vec_order() {
        let mut store = ApiStore::default();
        for (id, name) in [("f-1", "A"), ("f-2", "B"), ("f-3", "C")] {
            create_folder(&mut store, id.into(), name).unwrap();
        }
        assert_eq!(
            store
                .folders
                .iter()
                .map(|f| (f.id.as_str(), f.order))
                .collect::<Vec<_>>(),
            vec![("f-1", 0), ("f-2", 1), ("f-3", 2)],
            "creation order, ranked by index"
        );

        // Drag C above A → the frontend's `moveBefore` produces this list.
        reorder_folders(&mut store, &["f-3".into(), "f-1".into(), "f-2".into()]).unwrap();
        assert_eq!(
            store
                .folders
                .iter()
                .map(|f| (f.id.as_str(), f.order))
                .collect::<Vec<_>>(),
            vec![("f-3", 0), ("f-1", 1), ("f-2", 2)],
            "the vec IS the display order, and `order` is re-stamped to match"
        );

        // Deleting the middle one re-stamps too — no gap in the ranks.
        delete_folder(&mut store, "f-1").unwrap();
        assert_eq!(
            store
                .folders
                .iter()
                .map(|f| (f.id.as_str(), f.order))
                .collect::<Vec<_>>(),
            vec![("f-3", 0), ("f-2", 1)]
        );
    }

    /// `reorder_folders` takes a permutation or nothing. Each rejection is asserted
    /// separately because each is a different way to silently lose a folder from the
    /// file: a short list drops the ones it omits, a duplicate id clones one over
    /// another, an unknown id is a stale rail.
    #[test]
    fn reorder_rejects_anything_that_is_not_a_permutation() {
        let mut store = ApiStore::default();
        create_folder(&mut store, "f-1".into(), "A").unwrap();
        create_folder(&mut store, "f-2".into(), "B").unwrap();
        let before = store.folders.clone();

        let short = reorder_folders(&mut store, &["f-1".into()]).unwrap_err();
        assert!(
            short.contains("lists 1 folders but the store holds 2"),
            "{short}"
        );

        let dup = reorder_folders(&mut store, &["f-1".into(), "f-1".into()]).unwrap_err();
        assert!(dup.contains("listed twice"), "{dup}");

        let unknown = reorder_folders(&mut store, &["f-1".into(), "ghost".into()]).unwrap_err();
        assert!(unknown.contains("ghost"), "{unknown}");

        assert_eq!(
            store.folders, before,
            "no rejected reorder touched the store"
        );
    }

    /// 🔴 The lost-update guard: `edit_store` RE-READS the file, so a folder gesture
    /// cannot overwrite something written to the same file in between — which is exactly
    /// what `db_connection_upsert` does when it puts a DB password in the Vault.
    ///
    /// The scenario is played out literally: a folder command runs, then Rust writes a
    /// Vault variable behind it (as the DB client does), then a SECOND folder command runs
    /// from the same "session". The password is still there afterwards.
    #[test]
    fn a_folder_command_never_clobbers_a_vault_write_it_did_not_see() {
        let f = Fixture::new("no-clobber");
        edit_store(&f.store, |s| {
            create_folder(s, "f-1".into(), "Widget").map(|_| ())
        })
        .unwrap();

        // …the DB client saves a connection password `forever` (db::upsert's Vault write).
        let mut vault = load(&f.store);
        vault.environments.push(Environment {
            id: "env-1".into(),
            name: "Default".into(),
            variables: vec![EnvVar {
                key: "MAESTRO_PASSWORD".into(),
                value: "hunter2".into(),
            }],
        });
        save(&f.store, &vault).unwrap();

        // …and now another folder gesture, issued with no knowledge of that write.
        let after = edit_store(&f.store, |s| {
            create_folder(s, "f-2".into(), "Maestro").map(|_| ())
        })
        .unwrap();

        assert_eq!(after.folders.len(), 2, "the new folder landed");
        assert_eq!(
            after.environments[0].variables[0].value, "hunter2",
            "the password written between the two commands MUST still be there"
        );
        assert_eq!(load(&f.store), after, "…and that is what is on disk");
    }

    /// A rejected edit writes NOTHING — the `?` in `edit_store` short-circuits before the
    /// save. Without that, a bad gesture would still rewrite the file (harmless today,
    /// but it is the difference between "no-op" and "rewrote your secrets for no reason").
    #[test]
    fn a_rejected_edit_leaves_the_file_untouched() {
        let f = Fixture::new("reject-no-write");
        save(&f.store, &sample_store()).unwrap();
        let before = std::fs::read_to_string(&f.store).unwrap();

        let err = edit_store(&f.store, |s| rename_folder(s, "ghost", "X")).unwrap_err();
        assert!(err.contains("ghost"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&f.store).unwrap(),
            before,
            "a rejected edit must not rewrite the file"
        );
    }

    /// The folder wire form is camelCase, like the rest of the store — the frontend is
    /// built against `folderId`, not `folder_id`.
    #[test]
    fn folder_wire_form_is_camel_case() {
        let f = Fixture::new("folder-camel");
        let mut store = ApiStore {
            collections: vec![req("c-1", Some("f-1"))],
            ..ApiStore::default()
        };
        create_folder(&mut store, "f-1".into(), "Widget").unwrap();
        save(&f.store, &store).unwrap();
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("\"folderId\": \"f-1\""),
            "camelCase folderId: {text}"
        );
        assert!(!text.contains("folder_id"), "no snake_case leak: {text}");
        assert_eq!(load(&f.store), store, "…and it round-trips");
    }

    #[test]
    fn overwriting_replaces_the_whole_blob() {
        let f = Fixture::new("overwrite");
        save(&f.store, &sample_store()).unwrap();
        // A second save with an empty store must fully replace, not merge.
        save(&f.store, &ApiStore::default()).unwrap();
        assert_eq!(load(&f.store), ApiStore::default(), "save is wholesale");
    }
}
