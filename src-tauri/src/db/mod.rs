//! The built-in database client — module root and the `#[tauri::command]` surface.
//!
//! Wire contract: `src/features/db/types.ts`, which is the
//! **authority**; every type here mirrors it with `#[serde(rename_all = "camelCase")]`.
//!
//! ## What this file is, and what it is deliberately not
//!
//! Thin glue. Every command below resolves a path or an id, calls into a pure
//! module, and maps a [`error::DbError`] onto the shared wire error string. There is no business
//! logic here, for the ordinary reason: a `#[tauri::command]` is the one function in the module
//! a unit test cannot call without an `AppHandle`, so anything interesting must live where a
//! test can reach it.
//!
//! ```text
//! engines.rs  descriptor registry + validation          ── PURE
//! url.rs      build / parse / credential splitting      ── PURE
//! secret.rs   {{VAR}} resolution, minting, redaction     ── PURE
//! guard.rs    statement splitting + row-returning test  ── PURE
//! result.rs   result-set wire types + cell kinds        ── PURE
//! model.rs    the wire mirror of types.ts               ── PURE
//! error.rs    codes, prose, driver mapping, redaction   ── PURE
//! store.rs    db-connections.json (atomic, 0600)        ── PURE(+fs, injected path)
//! engine.rs   the DbEngine/DbSession seam + PostgreSQL  ── I/O
//! session.rs  the live-session registry                 ── state
//! ```
//!
//! ## The three properties the command layer is responsible for
//!
//! 1. **No secret is ever persisted.** `db_connection_upsert` is the only writer, and it splits
//!    credentials out of a raw URL **server-side** before anything reaches
//!    [`store::save`]. The frontend cannot save a URL with an inline password even by mistake,
//!    because the split does not depend on the frontend having tried.
//! 2. **No resolved secret crosses the IPC boundary.** `db_open` takes a *connection id* and
//!    returns a *session id*; the password is read from the Vault inside Rust and stays here
//!    The two stated exceptions are the `password` argument to `db_connection_upsert`
//!    and `db_test_connection`, which exist because the user just typed it into a draft that is
//!    not saved anywhere yet.
//! 3. **No driver string reaches the UI unredacted.** `sqlx` and libpq echo connection strings —
//!    and therefore passwords — into their error text. Every fallible path here maps
//!    through `error.rs` and redacts with the secrets that were in play.
//!
//! ## Scope
//!
//! The descriptor registry, the store, URL build/parse, Test Connection, open/query, the
//! connection tree (`db_children`), saved queries, the hand-arranged table order and
//! `db_cancel`. [`engine::engine_for`] maps every engine id to its implementation.

pub mod clickhouse;
pub mod dynamodb;
pub mod engine;
pub mod engines;
pub mod error;
pub mod guard;
pub mod model;
pub mod mongo;
pub mod queries;
pub mod redis;
pub mod result;
pub mod secret;
pub mod session;
pub mod sqlmongo;
pub mod store;
pub mod tree;
pub mod tree_order;
pub mod url;

use crate::db::engine::{Limits, ResolvedConfig, Script};
use crate::db::engines::{EngineSpec, MAX_ROW_LIMIT};
use crate::db::error::{DbError, DbErrorCode};
use crate::db::model::{
    DbConnection, DbConnectionInput, DbConnectionStore, DbRunMode, DbTestResult, DeleteReport,
    ParsedUrl, SavePassword,
};
use crate::db::result::DbResultSet;

/* ────────────────────────── the two files this feature touches ────────────────────────── */

/// The two paths every stateful command needs: the connection store and the Vault.
///
/// Bundled and **injected** rather than resolved inside each function, so that no
/// test-exercised code path can write to a real config location. Only [`Paths::of`] knows the
/// real locations, it needs an `AppHandle`, and it is therefore unreachable from `cargo test`.
/// Everything below it takes whatever paths it is given — which is also what lets
/// `tests/db_live.rs` drive the **whole** command path against a temp directory and a real
/// server, instead of only the halves either side of the glue.
#[derive(Debug, Clone)]
pub struct Paths {
    /// `db-connections.json`.
    pub store: std::path::PathBuf,
    /// `api-store.json` — the Vault. The DB client invents no second secret store.
    pub vault: std::path::PathBuf,
    /// `db-queries.json` — the saved queries. A separate file from the connections so a
    /// corrupt query list cannot cost you your connections, and vice versa.
    pub queries: std::path::PathBuf,
    /// `db-tree-order.json` — the user's hand-arranged table order.
    /// Its own file for the same reason as the queries: it is the least important of the three,
    /// and a corrupt ordering must cost you an arrangement, never a connection.
    pub tree_order: std::path::PathBuf,
}

impl Paths {
    /// The real paths, in the OS app config dir. The one function here that an `AppHandle` gates.
    pub(crate) fn of(app: &tauri::AppHandle) -> Self {
        Self {
            store: store::store_path(app),
            vault: crate::api_store::store_path_for(app),
            queries: store::store_path(app)
                .parent()
                .map(queries::store_path_in)
                .unwrap_or_else(|| std::path::PathBuf::from(queries::FILE_NAME)),
            tree_order: store::store_path(app)
                .parent()
                .map(tree_order::store_path_in)
                .unwrap_or_else(|| std::path::PathBuf::from(tree_order::FILE_NAME)),
        }
    }

    /// Every store inside `dir` — for the live tier, which needs a real save/load round trip
    /// without going anywhere near the user's config directory.
    pub fn in_dir(dir: &std::path::Path) -> Self {
        Self {
            store: dir.join("db-connections.json"),
            vault: dir.join("api-store.json"),
            queries: queries::store_path_in(dir),
            tree_order: tree_order::store_path_in(dir),
        }
    }
}

/* ─────────────────────────────── the registry ─────────────────────────────── */

/// Every engine descriptor, in the order the dialog's driver picker shows them.
///
/// Served over IPC rather than duplicated in TypeScript **on purpose**: the frontend needs the
/// whole form spec (labels, kinds, defaults, requiredness, hints), and any duplicate of that
/// would drift from the validator that has to agree with it. `src/features/db/engines.ts` keeps
/// only what Rust has no business knowing — the icon and the editor language.
#[tauri::command]
pub fn db_engines() -> Vec<EngineSpec> {
    engines::ENGINES.to_vec()
}

/* ─────────────────────────────── persistence ─────────────────────────────── */

/// The persisted connections. A missing or corrupt file loads as an empty store, never an error.
#[tauri::command]
pub fn db_connections_load(app: tauri::AppHandle) -> DbConnectionStore {
    store::load(&Paths::of(&app).store)
}

/// Validate, split credentials, mint/write the Vault variable, and persist — atomically.
///
/// `password` is the plaintext the user typed into the dialog (one of the two IPC exceptions).
/// It is written to the **Vault** and nowhere else, and only when `savePassword` is `forever`;
/// `session` and `never` deliberately persist nothing, so the record on disk is identical whether
/// or not a password was typed.
/// `async` because of the session invalidation below. (A sync `#[tauri::command]`
/// also runs inline on the event-loop thread, so this is the right execution context for a
/// command that writes two files.)
#[tauri::command]
pub async fn db_connection_upsert(
    app: tauri::AppHandle,
    input: DbConnectionInput,
    password: Option<String>,
) -> Result<DbConnection, String> {
    let record = upsert(&Paths::of(&app), input, password.as_deref()).map_err(|e| e.to_wire())?;
    // 🔴 **An edit must not leave the OLD connection live** (otherwise, after the database URL
    // is edited, a reopened query console keeps using the old URL).
    //
    // `open()` re-reads the store on every call, so a FRESH dial always uses the edited record —
    // the staleness was entirely in the session that already existed. `db_connection_delete` has
    // cascaded over live sessions since it was written; upsert never did, so the socket opened
    // from the previous host/port/database stayed in the registry and the console kept using it.
    //
    // Unconditional, not gated on "did anything actually change": a new connection has no
    // sessions, so the loop is simply empty for it (no branch that only ever takes
    // one path). Deliberately AFTER the save, so a rejected edit never costs a working session.
    //
    // ⚠️ This also covers `Limits`: `session::insert` copies `row_limit` / `timeout_ms` /
    // `allow_multi_statement` into the live session at open time, so without this, turning
    // read-only ON would leave a session that is still writable — the worst outcome this
    // subsystem has.
    invalidate_sessions(&record.id).await;
    Ok(record)
}

/// Every level of the tree this connection has a hand-arranged order for (tables must be
/// movable, so that the user can put them in whatever order they like).
///
/// Takes a connection id and **no session**, like `db_saved_queries` and for the same reason: the
/// arrangement is the user's, not the server's, so it is readable while the database is
/// unreachable. Never fails — a missing or corrupt file reads as "no custom order", which renders
/// as the engines' own alphabetical order.
#[tauri::command]
pub async fn db_tree_order(
    app: tauri::AppHandle,
    connection_id: String,
) -> Result<Vec<tree_order::LevelOrder>, String> {
    Ok(tree_order::for_connection(
        &tree_order::load(&Paths::of(&app).tree_order),
        &connection_id,
    ))
}

/// Record one level's order. An empty `keys` clears it (back to alphabetical), so the UI's
/// "reset" and its "drag" are the same command and cannot drift apart.
#[tauri::command]
pub async fn db_tree_order_set(
    app: tauri::AppHandle,
    connection_id: String,
    parent_key: String,
    keys: Vec<String>,
) -> Result<(), String> {
    set_tree_order(
        &Paths::of(&app).tree_order,
        &connection_id,
        &parent_key,
        keys,
    )
    .map_err(|e| {
        DbError::new(
            DbErrorCode::Unknown,
            format!("Could not save the table order: {e}"),
        )
        .to_wire()
    })
}

/// The path-injected core of [`db_tree_order_set`].
///
/// Read-modify-write: Rust re-reads the file at the moment of the change, so a
/// drag in one level can never clobber a drag in another. The webview holds no wholesale blob
/// of this file, which is what keeps it single-writer-safe.
///
/// **Under the file's lock from the read to the write.** The UI fires this
/// without waiting, and each call is its own task on tokio's multi-threaded pool, so two quick
/// drags in two levels really do run at once. With only the save locked, both loaded the same
/// file and the second save wrote the first drag away.
pub fn set_tree_order(
    path: &std::path::Path,
    connection_id: &str,
    parent_key: &str,
    keys: Vec<String>,
) -> std::io::Result<()> {
    let _guard = crate::store_file::lock(path);
    let mut store = tree_order::load(path);
    tree_order::set_level(&mut store, connection_id, parent_key, keys);
    tree_order::save(path, &store)
}

/// Drop every live session opened from `connection_id`: out of the registry first — so a stale
/// session id cannot be used the instant this returns — and then the socket, gracefully.
///
/// Shared by delete (the record is going away) and upsert (the record still exists but no longer
/// describes what the socket is connected to).
pub async fn invalidate_sessions(connection_id: &str) {
    for live in session::take_for_connection(connection_id) {
        session::close(&live).await;
    }
}

/// The path-injected core of [`db_connection_upsert`], so the ordering of its five side effects is
/// reviewable in one place — and so a test can run all five against a temp directory.
pub fn upsert(
    paths: &Paths,
    input: DbConnectionInput,
    typed_password: Option<&str>,
) -> Result<DbConnection, DbError> {
    let spec = engines::require_spec(input.engine)?;
    engines::validate(spec, &input)?;

    let mut password_ref = input.password_ref.trim().to_string();
    let mut url = input.url.clone().filter(|u| !u.trim().is_empty());
    // A password can arrive from three places: the password field, the userinfo of a pasted URL,
    // or a credential parameter in that URL's query string (`?password=…`, which libpq, sqlx and
    // ClickHouse all honour). Both of the URL's positions lose to the field, because the field is
    // what the user last touched; a URL carrying a password in two positions at once is refused
    // by `parse_parts` rather than resolved by a coin toss.
    let mut secret_value = typed_password
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    // Kept so the Vault write below can re-render **from the parts** rather than by re-parsing
    // the stripped string. Re-parsing would work for a userinfo credential and silently move a
    // query-borne one: the stripped string no longer has the `?password=` parameter to put the
    // `{{VAR}}` back into, so the reference would land in the userinfo instead.
    let mut url_parts: Option<url::UrlParts> = None;

    if let Some(raw) = &url {
        let split = url::split_url_credentials(raw)?;
        if secret_value.is_none() {
            secret_value = split.password.clone();
        }
        if password_ref.is_empty() {
            if let Some(r) = &split.password_ref {
                password_ref = r.clone();
            }
        }
        // The credential-free rendering is what gets persisted, whatever the client sent.
        url = Some(split.url);
        let mut parts = split.parts;
        // A stripped paste has no parameter left to read the placement off, so the client's
        // hint is the only surviving evidence of where the user put the credential. The
        // STRING wins when it still says: `parts.password_param` is read off the URL in
        // hand, and a field alongside it is a claim about a URL that may have been edited
        // since. Only fills a gap, never overrides.
        if parts.password_param.is_none() {
            if let Some(name) = input
                .password_param
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                parts.password_param = Some(name.to_string());
            }
        }
        url_parts = Some(parts);
    }

    // The Vault write. Only `forever` persists anything; the other two modes use the typed value
    // for one connect and drop it, which is why they clear the reference rather than
    // leaving a stale one pointing at an old value.
    match input.save_password {
        SavePassword::Forever => {
            if let Some(value) = &secret_value {
                // Load → put → save under the Vault's lock (`api_store::update`): the folder
                // commands and the blob save write this file too.
                let (_, name) = crate::api_store::update(
                    &paths.vault,
                    |vault| {
                        // Reuse the reference this connection already has, so editing a
                        // password overwrites one Vault row instead of growing a `_2`, `_3` tail.
                        let name = secret::ref_name(&password_ref)
                            .map(|n| n.to_string())
                            .unwrap_or_else(|| {
                                secret::vault_var_name(&input.name, &secret::taken_names(vault))
                            });
                        secret::put(vault, &name, value);
                        Ok::<_, DbError>(name)
                    },
                    |e| {
                        DbError::new(
                            DbErrorCode::Unknown,
                            format!("Could not write the Vault: {e}"),
                        )
                    },
                )?;
                password_ref = secret::wrap_ref(&name);
                // A URL that carried the credential gets the reference put back **in its place** —
                // the userinfo, or the very query parameter the value came out of, under the name
                // it came out of. That is what keeps the string describing the connection it came
                // from instead of a nearby one.
                if let Some(parts) = &url_parts {
                    url = Some(url::render_with_ref(parts, &name)?);
                }
            }
        }
        SavePassword::Session | SavePassword::Never => password_ref = String::new(),
    }

    // The connection list's lock, from this read to the save below. Without it an
    // import, a delete or a second save could land between the two, and this save would put the
    // list back the way it was when it was read: imported connections gone, a deleted one back.
    // The Vault's lock above is already released, so the two are never held at once.
    let _guard = crate::store_file::lock(&paths.store);
    let mut current = store::load(&paths.store);
    let now = now_ms();
    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let created_at = id
        .as_deref()
        .and_then(|id| current.connections.iter().find(|c| c.id == id))
        .map(|c| c.created_at)
        .unwrap_or(now);

    let record = DbConnection {
        id: id.unwrap_or_else(|| ulid::Ulid::new().to_string()),
        name: input.name.trim().to_string(),
        engine: input.engine,
        // Denormalised from the descriptor, never from the client: the two cannot disagree
        // because only one of them is ever read.
        family: spec.family,
        host: input.host.trim().to_string(),
        // Both persisted as given. `port: None` is "the engine's default" and `srv` is the bit that
        // makes an Atlas URI work — the pair is validated as mutually exclusive above, so no
        // reconciliation is done (or possible) here.
        port: input.port,
        database: input.database.trim().to_string(),
        user: input.user.trim().to_string(),
        password_ref,
        save_password: input.save_password,
        url,
        srv: input.srv,
        ssl_mode: input.ssl_mode,
        ca_summary: input.ca_summary,
        options: input.options,
        read_only: input.read_only,
        row_limit: input.row_limit,
        timeout_ms: input.timeout_ms,
        allow_multi_statement: input.allow_multi_statement,
        created_at,
        updated_at: now,
    };

    store::put(&mut current.connections, record.clone());
    store::save(&paths.store, &current).map_err(|e| {
        DbError::new(
            DbErrorCode::Unknown,
            format!("Could not save the connection: {e}"),
        )
    })?;
    Ok(record)
}

/// Delete a connection and cascade: close its live sessions, then report **measured** counts so
/// the confirm dialog can say what happened instead of assuming it.
#[tauri::command]
pub async fn db_connection_delete(
    app: tauri::AppHandle,
    id: String,
) -> Result<DeleteReport, String> {
    invalidate_sessions(&id).await;
    delete_connection(&Paths::of(&app), &id).map_err(|e| e.to_wire())
}

/// The path-injected core of [`db_connection_delete`], after its sessions are closed.
///
/// **Locked.** The connection list's lock is held from its read to the end of the
/// cascade, and each cascaded file's lock from its read to its write. Before, only the saves
/// took a lock: a concurrent save loaded the list before this delete wrote it and put the
/// deleted connection back, and a query saved meanwhile could land after the cascade, as an
/// orphan. The order (connections, then queries or table order) is the import's and
/// [`upsert_saved_query`]'s, so no two of them can deadlock.
pub fn delete_connection(paths: &Paths, id: &str) -> Result<DeleteReport, DbError> {
    let _connections = crate::store_file::lock(&paths.store);
    let mut current = store::load(&paths.store);
    let removed = store::remove(&mut current.connections, id);
    if removed {
        store::save(&paths.store, &current).map_err(|e| {
            DbError::new(
                DbErrorCode::Unknown,
                format!("Could not save the connection list: {e}"),
            )
        })?;
    }
    // The cascade. A query names one server's tables, so an orphan is a query you cannot
    // run — and the count is reported so the confirm dialog can say what is being discarded
    // rather than quietly dropping someone's work.
    let saved_queries_removed = {
        let _queries = crate::store_file::lock(&paths.queries);
        let mut saved = queries::load(&paths.queries);
        let n = queries::remove_for_connection(&mut saved, id);
        if n > 0 {
            // Best-effort by design: the connection is already gone, and failing the whole delete
            // because the query file could not be rewritten would leave the UI unable to make
            // progress. The orphans are invisible (nothing lists a deleted connection's queries)
            // and the next successful save drops them.
            let _ = queries::save(&paths.queries, &saved);
        }
        n
    };
    // Third cascade, for the hand-arranged table order: a cascade on one path is a checklist
    // for every other path that stores per-connection data. Best-effort for the same reason as the
    // queries above it — the connection is already gone, and the orphans are invisible because
    // nothing reads a deleted connection's order.
    {
        let _order = crate::store_file::lock(&paths.tree_order);
        let mut orders = tree_order::load(&paths.tree_order);
        if tree_order::remove_for_connection(&mut orders, id) > 0 {
            let _ = tree_order::save(&paths.tree_order, &orders);
        }
    }
    Ok(DeleteReport {
        removed,
        // A real count of the saved queries the cascade removed.
        saved_queries_removed: u32::try_from(saved_queries_removed).unwrap_or(u32::MAX),
    })
}

/* ───────────────────────── the tree and saved queries ───────────────────────── */

/// One level of the connection tree.
///
/// The two saved-query refs are answered **here**, from the store, and never reach an engine.
///
/// ⚠️ **This arm still needs an OPEN SESSION.** The connection id is taken from the session
/// precisely so a webview cannot read another connection's queries by passing an id, and that is
/// worth more than making one tree arm sessionless.
///
/// The saved-query list being there after the app is closed and reopened is served by
/// [`db_saved_queries`], which takes a connection id and needs no session. That is the command the
/// panel actually calls.
#[tauri::command]
pub async fn db_children(
    app: tauri::AppHandle,
    session_id: String,
    node: tree::DbNodeRef,
) -> Result<Vec<tree::DbNode>, String> {
    if let tree::DbNodeRef::SavedQueries = node {
        // The connection id comes from the session rather than the caller, so a webview cannot
        // ask for another connection's queries by passing an id.
        let live = session::get(&session_id).map_err(|e| e.to_wire())?;
        return Ok(saved_query_nodes(
            &Paths::of(&app).queries,
            &live.connection_id,
        ));
    }
    if let tree::DbNodeRef::SavedQuery { .. } = node {
        // A leaf. Returning empty rather than erroring, because a double-click that also expands
        // must not produce an error toast.
        return Ok(Vec::new());
    }
    children(&session_id, &node).await.map_err(|e| e.to_wire())
}

/// The core of [`db_children`] for the server-answered refs, reachable without an `AppHandle`.
pub async fn children(
    session_id: &str,
    node: &tree::DbNodeRef,
) -> Result<Vec<tree::DbNode>, DbError> {
    let live = session::get(session_id)?;
    let mut guard = live.session.lock().await;
    let sess = guard.as_mut().ok_or_else(|| {
        DbError::not_found(format!("Session `{session_id}` has already been closed."))
    })?;
    // The tree browses over the SAME cached connection the console runs on, so it has exactly the
    // same defect and gets exactly the same guard: expanding a node after a laptop wakes up must not
    // report a dead socket as a broken database. A catalog read is idempotent, so the retry warning
    // on `query` is less sharp here — but the rule is kept identical rather than special-cased,
    // because two call sites with two rules is how one of them ends up wrong.
    sess.ensure_live(&live.limits).await?;
    sess.children(node).await
}

/// The saved queries of `connection_id`, as tree nodes.
pub(crate) fn saved_query_nodes(path: &std::path::Path, connection_id: &str) -> Vec<tree::DbNode> {
    queries::for_connection(&queries::load(path), connection_id)
        .into_iter()
        .map(|q| {
            let node = tree::DbNode::new(
                tree::DbNodeRef::SavedQuery { id: q.id },
                q.name,
                tree::DbNodeKind::SavedQuery,
                false,
            );
            // The first line of the SQL as the sub-label: enough to tell two similarly-named
            // queries apart without opening either.
            match q.sql.lines().find(|l| !l.trim().is_empty()) {
                Some(line) => node.with_sub_label(first_line_preview(line)),
                None => node,
            }
        })
        .collect()
}

/// A one-line, length-capped preview of a query's first non-blank line.
pub(crate) fn first_line_preview(line: &str) -> String {
    let line = line.trim();
    if line.chars().count() <= 60 {
        return line.to_string();
    }
    let head: String = line.chars().take(57).collect();
    format!("{head}…")
}

/// Every saved query for a connection, newest-updated first.
#[tauri::command]
pub async fn db_saved_queries(
    app: tauri::AppHandle,
    connection_id: String,
) -> Result<Vec<queries::SavedQuery>, String> {
    let path = Paths::of(&app).queries;
    Ok(queries::for_connection(
        &queries::load(&path),
        &connection_id,
    ))
}

/// Create or update a saved query. `id: null` creates.
#[tauri::command]
pub async fn db_saved_query_upsert(
    app: tauri::AppHandle,
    input: queries::SavedQueryInput,
) -> Result<queries::SavedQuery, String> {
    upsert_saved_query(&Paths::of(&app), input).map_err(|e| e.to_wire())
}

/// The core of [`db_saved_query_upsert`], with its paths **injected** — the `Paths` idiom this
/// module uses everywhere, and the reason the connection check below is testable at all (`Paths::of`
/// needs an `AppHandle`, which `cargo test` has none of).
pub fn upsert_saved_query(
    paths: &Paths,
    input: queries::SavedQueryInput,
) -> Result<queries::SavedQuery, DbError> {
    // 🔴 **The connection must exist.** Without this check a query could be
    // saved against any id at all — an orphan that no tree node can ever show, in a file whose
    // delete cascade is keyed on connection id, so it would never be cleaned up either. Storage
    // that silently accepts unreachable records is how a file grows garbage nobody can explain.
    //
    // Both locks, connections first (the order of `delete_connection` and the import), from the
    // check to the write: a delete can no longer land between "it exists" and the
    // save and leave this query behind as an orphan, and a second save can no longer write a
    // query list loaded before this one landed.
    let _connections = crate::store_file::lock(&paths.store);
    let _queries = crate::store_file::lock(&paths.queries);
    let connections = store::load(&paths.store);
    if !connections
        .connections
        .iter()
        .any(|c| c.id == input.connection_id)
    {
        return Err(DbError::not_found(
            "That connection no longer exists, so this query has nowhere to be saved. Reload the DB \
             panel and try again.",
        ));
    }
    let path = &paths.queries;
    let mut store = queries::load(path);
    let saved = queries::upsert(&mut store, input, now_ms(), || {
        ulid::Ulid::new().to_string()
    })
    .map_err(DbError::invalid_config)?;
    // Unlike the delete cascade, a failed write here IS fatal: the user pressed Save and must not
    // be told it worked when the file did not change.
    queries::save(path, &store).map_err(|e| {
        DbError::new(
            DbErrorCode::Unknown,
            format!("Could not save the query list: {e}"),
        )
    })?;
    Ok(saved)
}

/// Delete a saved query. `removed: false` means our list was stale — reported, not hidden.
#[tauri::command]
pub async fn db_saved_query_delete(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    delete_saved_query(&Paths::of(&app).queries, &id).map_err(|e| {
        DbError::new(
            DbErrorCode::Unknown,
            format!("Could not save the query list: {e}"),
        )
        .to_wire()
    })
}

/// The path-injected core of [`db_saved_query_delete`]: load → remove → save under the file's
/// lock, so a query saved at the same moment is not written away by this delete.
pub fn delete_saved_query(path: &std::path::Path, id: &str) -> std::io::Result<bool> {
    let _guard = crate::store_file::lock(path);
    let mut store = queries::load(path);
    let removed = queries::remove(&mut store, id);
    if removed {
        queries::save(path, &store)?;
    }
    Ok(removed)
}

/* ─────────────────────────── connection strings ─────────────────────────── */

/// Form → canonical connection string. Refuses a literal password: the output of this
/// command is meant for a clipboard.
#[tauri::command]
pub fn db_url_build(input: DbConnectionInput) -> Result<String, String> {
    url::build(&input).map_err(|e| e.to_wire())
}

/// Connection string → form. **The password value is never returned** — `hadPassword`
/// says it was there so the UI can explain. On `Err` the caller leaves the form untouched.
#[tauri::command]
pub fn db_url_parse(text: String) -> Result<ParsedUrl, String> {
    url::parse(&text).map_err(|e| e.to_wire())
}

/* ─────────────────────────────── connecting ─────────────────────────────── */

/// Test an **unsaved draft**. Resolves on failure — an unreachable server is a result, not an
/// exception (the `http_send` contract).
///
/// `password` is the typed plaintext (one of the two IPC exceptions). When it is absent and the
/// draft carries a `{{VAR}}`, the reference is resolved against the Vault, so testing a saved
/// connection behaves the same as opening it.
#[tauri::command]
pub async fn db_test_connection(
    app: tauri::AppHandle,
    input: DbConnectionInput,
    password: Option<String>,
) -> DbTestResult {
    match test_connection(&Paths::of(&app), input, password).await {
        Ok(r) => r,
        Err(e) => DbTestResult {
            ok: false,
            server_version: None,
            latency_ms: None,
            // Prose, not a code: the dialog renders this field verbatim. Already redacted.
            error: Some(e.message),
        },
    }
}

/// The path-injected core of [`db_test_connection`]. `Err` here is what the command turns into a
/// resolved `ok: false` result.
pub async fn test_connection(
    paths: &Paths,
    input: DbConnectionInput,
    password: Option<String>,
) -> Result<DbTestResult, DbError> {
    let spec = engines::require_spec(input.engine)?;
    engines::validate(spec, &input)?;
    let engine = engine::engine_for(input.engine)?;

    let resolved = resolve_from_input(&paths.vault, &input, password.as_deref())?;
    let started = std::time::Instant::now();
    let mut sess = engine.open(&resolved).await?;
    let info = sess.probe().await;
    sess.close().await;
    let info = info?;
    Ok(DbTestResult {
        ok: true,
        server_version: Some(info.version),
        latency_ms: Some(started.elapsed().as_millis() as u64),
        error: None,
    })
}

/// Open a session on a **saved** connection, by id.
///
/// The webview names a connection and gets back a session id; the password is read from the
/// Vault inside Rust and never crosses IPC. `password` is only for `savePassword:
/// "never"`/`"session"`, where by construction there is nothing in the Vault to read.
#[tauri::command]
pub async fn db_open(
    app: tauri::AppHandle,
    connection_id: String,
    password: Option<String>,
) -> Result<DbOpened, String> {
    open(&Paths::of(&app), &connection_id, password.as_deref())
        .await
        .map_err(|e| e.to_wire())
}

/// The path-injected core of [`db_open`]. Returns the session **and what answered**; the resolved
/// password stays here.
pub async fn open(
    paths: &Paths,
    connection_id: &str,
    password: Option<&str>,
) -> Result<DbOpened, DbError> {
    let started = std::time::Instant::now();
    let conn = store::load(&paths.store)
        .connections
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| {
            DbError::not_found(format!("There is no saved connection `{connection_id}`."))
        })?;

    let engine = engine::engine_for(conn.engine)?;
    let resolved = resolve_from_connection(&paths.vault, &conn, password)?;
    let limits = Limits {
        row_limit: conn.row_limit,
        timeout_ms: conn.timeout_ms,
        allow_multi_statement: conn.allow_multi_statement,
    };
    let mut sess = engine.open(&resolved).await?;
    // 🔴 **The version comes from THIS connection, not from a second one.**
    //
    // The store used to call `db_test_connection` and then `db_open` — **two complete dials**: two
    // DNS lookups, two TLS handshakes, two authentications, the first thrown away. Against a local
    // Postgres that is invisible; against a remote MongoDB Atlas cluster it roughly doubles the
    // time to open. Halving that is the whole point of returning the server info from here.
    //
    // `probe()` on the session we just opened is a *query on an established connection*, not a dial
    // — and for MongoDB, ClickHouse and DynamoDB it is a second cheap round trip whose first one
    // their own `open` already made to prove reachability ("open really dials"). Restructuring the
    // trait so `open` returned `ServerInfo` would remove even that, and it would touch all eight
    // engines to save a round trip that is not the cost being fixed here.
    let info = sess.probe().await?;
    let latency_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    Ok(DbOpened {
        session_id: session::insert(&conn.id, limits, sess),
        server_version: info.version,
        // The WHOLE open — dial, handshake, auth and probe — because that is what the user waited
        // for. `DbTestResult.latencyMs` measures the same span for the same reason.
        latency_ms,
    })
}

/// What a successful [`open`] knows: the session, and what answered.
///
/// Returned instead of a bare session id, so opening a connection costs **one**
/// dial instead of two — see the note in `open`. Shaped like [`DbTestResult`]'s success half on
/// purpose; the difference is that this one carries a live session, so it **rejects** on failure
/// rather than resolving with an `error` string (a caller cannot be handed "no session, but here is
/// why" and be expected to notice).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbOpened {
    pub session_id: String,
    /// The server's own version string — proof a real round trip happened.
    pub server_version: String,
    /// How long the whole open took, in ms.
    pub latency_ms: u32,
}

/// Drop a session's connection. Idempotent — closing an id twice is not an error, because the
/// UI cannot always know whether a tab already closed it.
#[tauri::command]
pub async fn db_close(session_id: String) {
    if let Some(live) = session::take(&session_id) {
        session::close(&live).await;
    }
}

/// Ask the server to stop the statement this session is running.
///
/// 🔴 **The cancel handle lives outside the session's mutex.** `db_query` holds
/// `LiveSession::session`'s mutex for the whole of `run`, so anything behind that lock is
/// unreachable precisely while a query is running. The cancel handle is therefore lifted out of
/// the session and stored beside the mutex (see [`session::LiveSession::cancel`]), which is what
/// lets this command reach it.
///
/// **What `Ok` means, exactly:** the cancel request was *delivered*. Every engine's cancel is
/// advisory — PostgreSQL's `pg_cancel_backend` sends SIGINT and the backend stops at its next
/// interruptible point; ClickHouse's `KILL … SYNC` waits but can report `finished` for a query that
/// had already completed. So the caller must not claim the query stopped, only that it was asked
/// to. The console keeps saying "the server may still be running it" for that reason.
///
/// **`Err` for an engine that has none.** MongoDB, Redis and DynamoDB return `None` from
/// `cancel_handle`, so this refuses *structurally*, without a round trip, and names the bound that
/// does still apply. Reported as an error rather than a silent `Ok` because a Stop button that
/// quietly did nothing would be the control-that-lies this codebase keeps refusing.
///
/// Frontend contract: `invoke('db_cancel', { sessionId })`.
#[tauri::command]
pub async fn db_cancel(session_id: String) -> Result<(), String> {
    let live = session::get(&session_id).map_err(|e| e.to_wire())?;
    let Some(cancel) = live.cancel else {
        return Err(DbError::new(
            DbErrorCode::Unknown,
            "This engine has no server-side cancel. The query stops on its own when it finishes or \
             hits the connection's timeout.",
        )
        .to_wire());
    };
    cancel.cancel().await.map_err(|e| e.to_wire())
}

/// Run SQL on an open session.
///
/// A **database** error resolves as a `message` result next to whatever succeeded — a syntax
/// error is a normal outcome of a console, not an exception (the `http_send` contract).
/// Only a stale session id, a blocked script or a transport failure rejects.
#[tauri::command]
pub async fn db_query(
    session_id: String,
    sql: String,
    mode: Option<DbRunMode>,
    row_limit: Option<u32>,
) -> Result<Vec<DbResultSet>, String> {
    query(&session_id, sql, mode.unwrap_or_default(), row_limit)
        .await
        .map_err(|e| e.to_wire())
}

/// The core of [`db_query`], reachable without an `AppHandle` because a session id is all it needs.
pub async fn query(
    session_id: &str,
    sql: String,
    mode: DbRunMode,
    row_limit: Option<u32>,
) -> Result<Vec<DbResultSet>, DbError> {
    run_on_session(session_id, sql, mode, row_limit, false).await
}

/// [`query`], with read-only as a boundary rather than a default: on a read-only PostgreSQL or
/// MySQL session the run is held in a `READ ONLY` transaction that is always rolled back, because
/// the session's read-only setting alone does not stand against a hostile statement. The agent
/// tools' path. See [`engine::DbSession::run_strict`]; every other session runs as [`query`] does.
pub async fn query_strict(
    session_id: &str,
    sql: String,
    mode: DbRunMode,
    row_limit: Option<u32>,
) -> Result<Vec<DbResultSet>, DbError> {
    run_on_session(session_id, sql, mode, row_limit, true).await
}

async fn run_on_session(
    session_id: &str,
    sql: String,
    mode: DbRunMode,
    row_limit: Option<u32>,
    strict: bool,
) -> Result<Vec<DbResultSet>, DbError> {
    let live = session::get(session_id)?;
    // A per-run row limit may only ever be *clamped*, never trusted: it arrives from the webview
    // and the ceiling exists because above it the webview is the bottleneck no matter what.
    let limits = Limits {
        row_limit: row_limit
            .filter(|n| *n > 0)
            .unwrap_or(live.limits.row_limit)
            .min(MAX_ROW_LIMIT),
        ..live.limits
    };
    let mut guard = live.session.lock().await;
    let sess = guard.as_mut().ok_or_else(|| {
        DbError::not_found(format!("Session `{session_id}` has already been closed."))
    })?;
    // 🔴 **Ping, then run — and this must NEVER become a retry.** `ensure_live` proves the socket is
    // alive (re-dialling if it is not) *before* the statement goes out, which is what makes it safe:
    // nothing is ever re-sent. If the connection dies in the sliver between this line and the next,
    // that error is surfaced as-is. Do not "improve" this into a retry-on-failure loop — an `INSERT`
    // that died mid-flight may already have committed on the server, and re-sending it would apply
    // the user's write twice. See `DbSession::ensure_live`.
    sess.ensure_live(&limits).await?;
    let script = Script { text: sql, mode };
    if strict {
        sess.run_strict(&script, &limits).await
    } else {
        sess.run(&script, &limits).await
    }
}

/* ──────────────────────────── secret resolution ──────────────────────────── */

/// Build a [`ResolvedConfig`] from a saved connection, reading the Vault for its `{{VAR}}`.
fn resolve_from_connection(
    vault_path: &std::path::Path,
    conn: &DbConnection,
    typed: Option<&str>,
) -> Result<ResolvedConfig, DbError> {
    let password = resolve_password(vault_path, &conn.password_ref, conn.save_password, typed)?;
    Ok(ResolvedConfig {
        engine: conn.engine,
        family: conn.family,
        host: conn.host.clone(),
        // Passed through as `Option`, **not** defaulted here: only the engine knows whether a port
        // is meaningful at all (it is not, for `mongodb+srv`), so the fallback belongs at the point
        // of use — `ResolvedConfig::port_or_default`.
        port: conn.port,
        srv: conn.srv,
        database: conn.database.clone(),
        user: conn.user.clone(),
        url: substitute_url(conn.url.as_deref(), &conn.password_ref, &password),
        password,
        ssl_mode: conn.ssl_mode,
        // No PEM is stored: the contract's `caSummary` is a summary and there is no
        // `caPem`/`caPath` field on the wire to read one from. This is a contract gap, not an
        // omission here.
        ca_pem: None,
        options: conn.options.clone(),
        read_only: conn.read_only,
        row_limit: conn.row_limit,
        timeout_ms: conn.timeout_ms,
        allow_multi_statement: conn.allow_multi_statement,
    })
}

/// Build a [`ResolvedConfig`] from an unsaved draft — Test Connection's path.
fn resolve_from_input(
    vault_path: &std::path::Path,
    input: &DbConnectionInput,
    typed: Option<&str>,
) -> Result<ResolvedConfig, DbError> {
    let spec = engines::require_spec(input.engine)?;
    let password = resolve_password(vault_path, &input.password_ref, input.save_password, typed)?;
    let url = input.url.clone().filter(|u| !u.trim().is_empty());
    Ok(ResolvedConfig {
        engine: input.engine,
        family: spec.family,
        host: input.host.trim().to_string(),
        port: input.port,
        srv: input.srv,
        database: input.database.trim().to_string(),
        user: input.user.trim().to_string(),
        url: substitute_url(url.as_deref(), &input.password_ref, &password),
        password,
        ssl_mode: input.ssl_mode,
        ca_pem: None,
        options: input.options.clone(),
        read_only: input.read_only,
        row_limit: input.row_limit,
        timeout_ms: input.timeout_ms,
        allow_multi_statement: input.allow_multi_statement,
    })
}

/// The password to dial with.
///
/// A typed value always wins — it is the one the user just entered. Otherwise a `{{VAR}}` is
/// resolved against the Vault, which is the only place a secret lives. `session`/`never`
/// connections have nothing stored by construction, so an absent typed value there is an empty
/// password rather than a Vault lookup that would always miss.
fn resolve_password(
    vault_path: &std::path::Path,
    password_ref: &str,
    save: SavePassword,
    typed: Option<&str>,
) -> Result<String, DbError> {
    if let Some(v) = typed {
        return Ok(v.to_string());
    }
    if matches!(save, SavePassword::Session | SavePassword::Never) {
        return Ok(String::new());
    }
    let vault = crate::api_store::load(vault_path);
    secret::resolve(password_ref, &vault)
}

/// Put the resolved secret back into a stored URL's `{{VAR}}` slot, **percent-encoded**.
///
/// Encoded, not raw: the reference was written verbatim (`{`/`}` are not RFC 3986 characters and
/// escaping them would be unreadable), but the *value* replacing it sits in a position where an
/// `@` or a `:` would silently change which host and port the string names. That is the classic
/// "works until someone's password has a slash in it" bug.
///
/// One replacement covers both positions the reference can occupy. `encode_userinfo` is not a
/// mistake in the query-parameter case: its set is *stricter* than the query set — it also
/// encodes `&`, `=` and `,` — so the spliced value cannot terminate its own parameter, and every
/// reader that percent-decodes a query value (libpq, sqlx, and [`url::parse_parts`]) gets the
/// bytes back exactly. `&` and `=` inside a value are precisely where naive splicing breaks, and
/// `+` is encoded too because a form-urlencoded reader would otherwise read it as a space.
fn substitute_url(url: Option<&str>, password_ref: &str, password: &str) -> Option<String> {
    let raw = url?;
    if password_ref.is_empty() || password.is_empty() || !raw.contains(password_ref) {
        return Some(raw.to_string());
    }
    Some(raw.replace(password_ref, &url::encode_userinfo(password)))
}

/// Wall-clock milliseconds. Only used for `createdAt`/`updatedAt`, which are display values.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {

    /* ─────────────── saved queries as tree nodes (they survive a restart) ─────────────── */

    /// 🔴 Saved queries surviving a restart, through the TREE, which is the surface the user
    /// sees: double-clicking the database must show its list of saved queries.
    ///
    /// `queries.rs` proves the file survives a reload; this proves the reloaded file becomes the
    /// nodes the panel draws — the seam between the two, which is where a working backend can
    /// still sit behind a blank screen.
    /// 🔴 **A saved query cannot be written against a connection that does not exist.**
    ///
    /// An orphan is a record no tree node can ever show, in a file whose delete cascade is
    /// keyed on connection id — so it would never be cleaned up either. Storage that silently
    /// accepts unreachable records is how a file grows garbage nobody can explain.
    #[test]
    fn a_saved_query_needs_a_connection_that_exists() {
        let f = Fixture::new("orphan-query");
        let input = |connection_id: &str| -> queries::SavedQueryInput {
            serde_json::from_value(serde_json::json!({
                "connectionId": connection_id, "name": "Daily", "sql": "SELECT 1"
            }))
            .expect("input")
        };

        let err = upsert_saved_query(&f.paths, input("no-such-connection"))
            .expect_err("an orphan must be refused");
        assert_eq!(err.code, DbErrorCode::NotFound);
        assert!(err.message.contains("no longer exists"), "{}", err.message);
        // 🔴 And nothing was written: a refusal that still touched the file would leave the orphan
        // behind while telling the user it failed.
        assert!(
            !f.paths.queries.exists(),
            "a refused save must not create the query file"
        );

        // The control: the SAME input against a real connection succeeds, so the
        // refusal above is the check firing and not "saving never works here".
        let saved_conn =
            upsert(&f.paths, draft(serde_json::json!({})), None).expect("save the connection");
        let saved = upsert_saved_query(&f.paths, input(&saved_conn.id)).expect("a real connection");
        assert_eq!(saved.connection_id, saved_conn.id);
        assert_eq!(saved.name, "Daily");
    }

    #[test]
    fn saved_queries_become_tree_nodes_newest_first_with_a_readable_preview() {
        let dir =
            std::env::temp_dir().join(format!("agentstudio-db-qnodes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = queries::store_path_in(&dir);

        let mut store = queries::SavedQueryStore::default();
        for (id, name, sql, at) in [
            (
                "Q1",
                "Minutes per title",
                "SELECT title, sum(duration)\nFROM tracks\nGROUP BY title",
                1_000u64,
            ),
            (
                "Q2",
                "Nulls",
                "-- which tags are missing?\nSELECT * FROM tracks WHERE tag IS NULL",
                9_000,
            ),
        ] {
            queries::upsert(
                &mut store,
                serde_json::from_value(serde_json::json!({
                    "connectionId": "conn-1", "name": name, "sql": sql
                }))
                .unwrap(),
                at,
                || id.to_string(),
            )
            .unwrap();
        }
        // Another connection's query must not appear under this one.
        queries::upsert(
            &mut store,
            serde_json::from_value(serde_json::json!({
                "connectionId": "other", "name": "Elsewhere", "sql": "SELECT 1"
            }))
            .unwrap(),
            99_000,
            || "Q3".to_string(),
        )
        .unwrap();
        queries::save(&path, &store).expect("saved");

        // Read from DISK, the way a relaunch does.
        let nodes = saved_query_nodes(&path, "conn-1");
        let labels: Vec<&str> = nodes.iter().map(|n| n.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["Nulls", "Minutes per title"],
            "newest-updated first"
        );
        assert!(
            nodes.iter().all(|n| !n.expandable),
            "a saved query is a leaf"
        );
        assert!(nodes.iter().all(|n| n.kind == tree::DbNodeKind::SavedQuery));

        // The sub-label is the first NON-BLANK line, so a leading comment is what identifies the
        // query — which is exactly what a user writes there.
        assert_eq!(
            nodes[0].sub_label.as_deref(),
            Some("-- which tags are missing?")
        );
        assert_eq!(
            nodes[1].sub_label.as_deref(),
            Some("SELECT title, sum(duration)")
        );

        // And the id travels, because "open this one" cannot work from a label — two queries may
        // legitimately share a name.
        assert_eq!(
            nodes[0].node_ref,
            tree::DbNodeRef::SavedQuery { id: "Q2".into() }
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_first_line_is_capped_rather_than_stretching_the_tree() {
        let long = format!("SELECT {}", "x".repeat(200));
        let preview = first_line_preview(&long);
        assert!(
            preview.chars().count() <= 60,
            "{} chars",
            preview.chars().count()
        );
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn a_missing_query_file_yields_no_nodes_rather_than_failing_the_expand() {
        // The common case on a fresh install: the file does not exist yet. Expanding "Saved
        // queries" must show an empty list, not an error.
        let nodes = saved_query_nodes(std::path::Path::new("/nonexistent/db-queries.json"), "c");
        assert!(nodes.is_empty());
    }
    use super::*;

    /// A password chosen to break a careless implementation: characters that percent-encode, that
    /// are meaningful in a URL's userinfo (`@`, `:`, `/`), and non-ASCII. The whole point of the
    /// credential split is that none of it ever reaches a file, so the test password has to be
    /// able to prove that.
    const HOSTILE: &str = "p@ss:w/o?rd#\\ünïcode ✓";

    /// The query-string counterpart of [`HOSTILE`]. `&` and `=` inside a query-parameter value are
    /// exactly where a naive splice breaks — the value terminates its own parameter and invents a
    /// new one — and `?`/`#` are where a naive parse breaks.
    const HOSTILE_QUERY: &str = "p@ss:w/rd#1&x=2?y";

    /// …and a unicode one, because percent-encoding a multi-byte character and decoding it back is
    /// a different code path from escaping an ASCII delimiter.
    const HOSTILE_UNICODE: &str = "contraseña-🔐-中文-✓";

    /// A temp directory holding both files, removed on drop. Nothing in this module's tests goes
    /// anywhere near a real config directory.
    struct Fixture {
        dir: std::path::PathBuf,
        paths: Paths,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentstudio-db-cmd-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            let paths = Paths::in_dir(&dir);
            Self { dir, paths }
        }

        fn store_text(&self) -> String {
            std::fs::read_to_string(&self.paths.store).unwrap_or_default()
        }

        fn vault_text(&self) -> String {
            std::fs::read_to_string(&self.paths.vault).unwrap_or_default()
        }

        /// The Vault's value for `name`, read back through the real loader.
        fn vault_value(&self, name: &str) -> Option<String> {
            crate::api_store::load(&self.paths.vault)
                .environments
                .iter()
                .flat_map(|e| e.variables.iter())
                .find(|v| v.key == name)
                .map(|v| v.value.clone())
        }
    }

    /// Assert `secret` is absent from `text` in **all three spellings it could take**.
    ///
    /// A single `contains` is not enough, and this is the trap that makes such a check pass for
    /// the wrong reason: the hostile password contains a backslash, and JSON encodes
    /// that as `\\`, so the raw bytes are simply not in the file even when the secret **is**. A
    /// leak check that only looks for the raw form is the classic false pass — the same reason
    /// `secret::redact` scrubs the percent-encoded form too.
    fn assert_no_spelling_of(secret: &str, text: &str, what: &str) {
        let json_escaped = serde_json::to_string(secret).expect("a string serialises");
        for (spelling, form) in [
            ("raw", secret.to_string()),
            ("JSON-escaped", json_escaped.trim_matches('"').to_string()),
            ("percent-encoded", url::encode_userinfo(secret)),
        ] {
            assert!(
                !text.contains(&form),
                "the {spelling} form of the secret is in {what}:\n{text}"
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A draft with `overrides` merged over the base, so each test states only what it varies.
    ///
    /// Merged as a `serde_json::Value` rather than concatenated as text: string concatenation
    /// produced *duplicate keys*, which serde rejects outright — so a test that meant to override
    /// `name` did not run at all.
    fn draft(overrides: serde_json::Value) -> DbConnectionInput {
        let mut base = serde_json::json!({
            "name": "Prod Postgres",
            "engine": "postgres",
            "host": "db.internal",
            "port": 5432,
            "database": "maestro",
            "user": "ro",
            "passwordRef": "",
            "savePassword": "forever",
            "sslMode": "prefer",
            "options": {},
            "readOnly": true,
            "rowLimit": 500,
            "timeoutMs": 30000,
        });
        let map = base.as_object_mut().expect("an object");
        for (k, v) in overrides.as_object().expect("overrides is an object") {
            map.insert(k.clone(), v.clone());
        }
        serde_json::from_value(base).expect("the base draft is the contract's shape")
    }

    #[test]
    fn a_typed_password_goes_to_the_vault_and_the_store_keeps_only_a_reference() {
        let f = Fixture::new("typed");
        let saved = upsert(&f.paths, draft(serde_json::json!({})), Some(HOSTILE)).expect("upsert");

        assert_eq!(saved.password_ref, "{{PROD_POSTGRES_PASSWORD}}");
        assert_no_spelling_of(HOSTILE, &f.store_text(), "db-connections.json");
        assert_eq!(
            f.vault_value("PROD_POSTGRES_PASSWORD").as_deref(),
            Some(HOSTILE),
            "the password never reached the Vault, so nothing could ever connect"
        );
        // Rust owns these three, so the client can never hand up a `0` timestamp.
        assert!(!saved.id.is_empty() && saved.created_at > 0 && saved.updated_at > 0);
    }

    /// The likeliest place this feature could leak a production credential: a pasted URL with
    /// an inline password. The split is **server-side**, so it happens whether or not the frontend
    /// tried — and the reference is put back into the URL, so the string still describes its
    /// connection instead of quietly losing its credentials.
    #[test]
    fn a_url_password_is_split_out_server_side_and_replaced_by_the_reference() {
        let f = Fixture::new("url");
        let encoded = url::encode_userinfo(HOSTILE);
        let pasted = format!("postgresql://catalog_ro:{encoded}@db.internal:5432/maestro");
        let saved =
            upsert(&f.paths, draft(serde_json::json!({"url": pasted})), None).expect("upsert");

        let stored_url = saved.url.clone().expect("the url survives");
        assert!(!stored_url.contains(HOSTILE), "{stored_url}");
        assert!(!stored_url.contains(&encoded), "{stored_url}");
        assert!(
            stored_url.contains("{{PROD_POSTGRES_PASSWORD}}"),
            "the reference must take the password's place: {stored_url}"
        );
        // The file, not just the returned record — they are written by different code.
        assert_no_spelling_of(HOSTILE, &f.store_text(), "db-connections.json");
        assert_eq!(
            f.vault_value("PROD_POSTGRES_PASSWORD").as_deref(),
            Some(HOSTILE)
        );
    }

    /// The typed field wins over the URL's userinfo, because it is what the user last touched.
    #[test]
    fn the_typed_password_wins_over_one_in_the_url() {
        let f = Fixture::new("both");
        let saved = upsert(
            &f.paths,
            draft(serde_json::json!({
                "url": "postgresql://ro:from-the-url@db.internal:5432/maestro"
            })),
            Some("from-the-field"),
        )
        .expect("upsert");
        assert!(f.vault_text().contains("from-the-field"));
        assert!(!f.vault_text().contains("from-the-url"));
        assert!(!saved.url.unwrap().contains("from-the-url"));
    }

    /// **A credential in the query string is saved, not refused** (`?password=` stays part of
    /// the string, because every database system accepts a credential there).
    ///
    /// It is treated exactly like one in the userinfo: the value goes to the Vault, and the
    /// persisted string keeps `?<name>={{VAR}}` in the **same parameter**. Against the Docker
    /// fixture,
    /// `psql "postgresql://agentstudio@postgres:5432/maestro?password=agentstudio-test-pw"` connects and
    /// the wrong value fails authentication — so this parameter is load-bearing, not decoration.
    /// The earlier refusal's premise ("a place we cannot put a `{{VAR}}` back into without
    /// changing what the string means") was simply wrong: `?password={{PG_PASSWORD}}` is a
    /// well-formed query string, and this module already writes a reference verbatim into a URL's
    /// userinfo for exactly the same reason.
    #[test]
    fn a_query_string_credential_goes_to_the_vault_and_leaves_a_reference_in_its_parameter() {
        let f = Fixture::new("qs");
        let pasted = format!(
            "postgresql://ro@db.internal:5432/maestro?password={}",
            url::encode_userinfo(HOSTILE)
        );
        let saved = upsert(&f.paths, draft(serde_json::json!({"url": pasted})), None)
            .expect("a query-string credential is saved, not refused");

        let stored_url = saved.url.clone().expect("the url survives");
        assert_eq!(
            stored_url,
            "postgresql://ro@db.internal:5432/maestro?password={{PROD_POSTGRES_PASSWORD}}",
            "the reference must take the value's place, in the same parameter"
        );
        // The record, in every spelling, and the file too — they are written by different code.
        assert_no_spelling_of(HOSTILE, &f.store_text(), "db-connections.json");
        assert_eq!(
            f.vault_value("PROD_POSTGRES_PASSWORD").as_deref(),
            Some(HOSTILE),
            "the password never reached the Vault, so nothing could ever connect"
        );
        assert_eq!(saved.password_ref, "{{PROD_POSTGRES_PASSWORD}}");
        // …and the resolved string puts the real value back in that parameter, percent-encoded,
        // which is the half that makes the feature work rather than merely save.
        let dialled = substitute_url(Some(&stored_url), &saved.password_ref, HOSTILE)
            .expect("a url to dial with");
        assert!(!dialled.contains("{{"), "{dialled}");
        let reparsed = url::parse_parts(&dialled).expect("the dialled string is well-formed");
        assert_eq!(
            reparsed.password,
            url::PasswordSlot::Value(HOSTILE.to_string()),
            "the value must decode back byte-for-byte on the wire: {dialled}"
        );
        assert_eq!(reparsed.password_param.as_deref(), Some("password"));
    }

    /// **The whole save-then-dial cycle, for both positions, over the passwords that break naive
    /// implementations.** One test because the two halves are only worth anything together: a save
    /// that hides the secret but dials with the wrong bytes is a feature that does not work, and a
    /// dial that works while the file holds the password is the leak this feature exists to
    /// prevent. Asserted for each password:
    ///
    /// * the store holds it in **no spelling** (raw, JSON-escaped, percent-encoded),
    /// * the Vault holds it **byte-for-byte**,
    /// * the string we dial with decodes back to exactly it, in the position it came from,
    /// * and no extra parameter appeared — which is what `&`/`=` in a value would have caused.
    #[test]
    fn a_hostile_password_survives_the_save_and_dial_cycle_in_either_position() {
        for secret in [HOSTILE, HOSTILE_QUERY, HOSTILE_UNICODE] {
            for (tag, template) in [
                ("userinfo", "postgresql://ro:{}@db.internal:5432/maestro"),
                (
                    "query",
                    "postgresql://ro@db.internal:5432/maestro?password={}",
                ),
            ] {
                let f = Fixture::new(&format!("cycle-{tag}-{}", secret.len()));
                // Percent-encoded on the way in, as any tool that produced the string would.
                let pasted = template.replace("{}", &url::encode_userinfo(secret));
                let saved = upsert(&f.paths, draft(serde_json::json!({"url": pasted})), None)
                    .unwrap_or_else(|e| panic!("{tag}/{secret}: {}", e.message));

                assert_no_spelling_of(secret, &f.store_text(), "db-connections.json");
                assert_eq!(
                    f.vault_value("PROD_POSTGRES_PASSWORD").as_deref(),
                    Some(secret),
                    "{tag}: the Vault must hold the value byte-for-byte"
                );

                let stored = saved.url.clone().expect("the url survives");
                let dialled = substitute_url(Some(&stored), &saved.password_ref, secret)
                    .expect("a url to dial with");
                let parts = url::parse_parts(&dialled)
                    .unwrap_or_else(|e| panic!("{tag}/{secret}: {dialled}: {}", e.message));
                assert_eq!(
                    parts.password,
                    url::PasswordSlot::Value(secret.to_string()),
                    "{tag}: the dialled string does not decode back to the password: {dialled}"
                );
                assert_eq!(
                    parts.password_param.is_some(),
                    tag == "query",
                    "{tag}: the credential moved position: {dialled}"
                );
                assert!(
                    parts.options.is_empty(),
                    "{tag}: a spliced `&`/`=` invented a parameter: {:?} from {dialled}",
                    parts.options
                );
                assert_eq!(parts.host, "db.internal");
                assert_eq!(parts.port, Some(5432));
                assert_eq!(
                    parts.database, "maestro",
                    "a spliced `/` moved the database"
                );
                assert_eq!(parts.user, "ro");
            }
        }
    }

    /// **Saving the same connection a second time.** The record we wrote last time comes straight
    /// back in as `input.url`, `?password={{VAR}}` and all, so the reference has to be recognised
    /// where it now lives: reuse the same Vault row, keep the same parameter, and do not mint a
    /// `_2`. Before this change this shape could not be re-saved at all — the reference sat in a
    /// denylisted parameter and the old code refused every string that had one, `{{VAR}}` or not.
    #[test]
    fn re_saving_a_url_that_already_holds_a_reference_in_its_parameter_reuses_the_vault_row() {
        let f = Fixture::new("qs-again");
        let first = upsert(
            &f.paths,
            draft(serde_json::json!({
                "url": "postgresql://ro@db.internal:5432/maestro?password=old-password"
            })),
            None,
        )
        .expect("first");
        let stored = first.url.clone().expect("a url");
        assert!(
            stored.contains("?password={{PROD_POSTGRES_PASSWORD}}"),
            "{stored}"
        );

        // …exactly what the dialog would send back on the next Save.
        let second = upsert(
            &f.paths,
            draft(serde_json::json!({
                "id": first.id,
                "passwordRef": first.password_ref,
                "url": stored,
            })),
            Some("new-password"),
        )
        .expect("second");

        assert_eq!(second.id, first.id);
        assert_eq!(second.url, first.url, "the string must be a fixed point");
        assert_eq!(second.password_ref, first.password_ref);
        let vault = f.vault_text();
        assert!(vault.contains("new-password"), "{vault}");
        assert!(!vault.contains("old-password"), "the old secret lingers");
        assert_eq!(
            vault.matches("PROD_POSTGRES_PASSWORD").count(),
            1,
            "a second Vault row was minted:\n{vault}"
        );
        assert_eq!(store::load(&f.paths.store).connections.len(), 1);
    }

    /// **The fresh-paste path — the `?password=` rule, end to end.**
    ///
    /// `?password=` stays part of the string, because every
    /// database system accepts it there. The URL-carried case was already covered above, but
    /// the case a user actually performs was not: paste a string with `?password=hunter2`, and
    /// the dialog's `db_url_parse` strips the credential out **and discards the value** before
    /// Save. So the string arriving at upsert no longer has the parameter to read the placement
    /// off, and the `{{VAR}}` used to land in the userinfo — a saved connection that described
    /// itself differently from how the user wrote it. `DbConnectionInput::password_param` is the
    /// surviving evidence, and this is the test that it is honoured.
    #[test]
    fn a_stripped_paste_still_saves_its_reference_into_the_parameter_the_user_pasted() {
        let f = Fixture::new("qs-fresh");
        let saved = upsert(
            &f.paths,
            draft(serde_json::json!({
                // Exactly what the dialog holds after a paste: the credential-free string
                // `db_url_parse` returned, plus the parameter name it reported.
                "url": "postgresql://ro@db.internal:5432/maestro",
                "passwordParam": "password",
            })),
            // The value the user typed — `db_url_parse` threw the pasted one away.
            Some("hunter2"),
        )
        .expect("save");

        let stored = saved.url.clone().expect("a url");
        assert!(
            stored.contains("?password={{PROD_POSTGRES_PASSWORD}}"),
            "the reference did not go back into the parameter the user pasted: {stored}"
        );
        // The other half of the claim, and the half that was actually broken: it must not have
        // been moved into the userinfo. Asserting only the line above would pass for a string
        // that carried the credential in BOTH places.
        assert!(
            !stored.contains("ro:{{PROD_POSTGRES_PASSWORD}}@"),
            "the reference was ALSO put in the userinfo: {stored}"
        );
        assert!(
            !stored.contains("hunter2"),
            "the secret is in the record: {stored}"
        );
        assert_no_spelling_of("hunter2", &f.store_text(), "db-connections.json");

        // And it still dials: substituting the Vault value back yields a string whose password
        // decodes to what the user typed, from the parameter it was put in.
        let dialled = substitute_url(Some(&stored), &saved.password_ref, "hunter2")
            .expect("a url to dial with");
        let parts = url::parse_parts(&dialled).expect("re-parse");
        assert_eq!(parts.password, url::PasswordSlot::Value("hunter2".into()));
        assert_eq!(parts.password_param.as_deref(), Some("password"));
    }

    /// A non-canonical spelling survives the same path: we do not rename `pwd` to `password`,
    /// because renaming it changes what the string says (and `?pwd=` is what some MySQL tooling
    /// emits). The **driver** caveat — only exact lowercase `password` authenticates for most
    /// drivers — is surfaced in the dialog, not silently repaired here.
    #[test]
    fn a_stripped_pastes_parameter_name_is_kept_verbatim_not_normalised() {
        let f = Fixture::new("qs-fresh-pwd");
        let saved = upsert(
            &f.paths,
            draft(serde_json::json!({
                "url": "mysql://ro@db.internal:3306/maestro",
                "passwordParam": "pwd",
            })),
            Some("hunter2"),
        )
        .expect("save");
        let stored = saved.url.expect("a url");
        assert!(
            stored.contains("?pwd={{PROD_POSTGRES_PASSWORD}}"),
            "{stored}"
        );
        assert!(
            !stored.contains("password="),
            "the name was normalised: {stored}"
        );
    }

    /// The hint only ever FILLS A GAP. A URL that still carries its own `?pwd=` is better
    /// evidence than a field beside it — the field could be describing a string the user has
    /// since edited — so the string wins and the credential does not move parameters.
    ///
    /// ⚠️ Honest label: this is a **regression guard, not a proof**. It passes with the
    /// gap-filling code removed too, because the string's own parameter is what the old code
    /// read anyway. Its job is to go red if someone later makes the hint override the URL.
    #[test]
    fn the_urls_own_parameter_wins_over_a_disagreeing_hint() {
        let f = Fixture::new("qs-conflict");
        let saved = upsert(
            &f.paths,
            draft(serde_json::json!({
                "url": "postgresql://ro@db.internal:5432/maestro?pwd=hunter2",
                // A stale hint from an earlier paste, disagreeing with the string in hand.
                "passwordParam": "password",
            })),
            None,
        )
        .expect("save");
        let stored = saved.url.expect("a url");
        assert!(
            stored.contains("?pwd={{PROD_POSTGRES_PASSWORD}}"),
            "{stored}"
        );
        assert!(
            !stored.contains("?password="),
            "a stale hint moved the credential to another parameter: {stored}"
        );
    }

    /// The parameter's **name** is preserved, never normalised to `password`. Putting a MySQL
    /// secret into a parameter called `password` when it arrived as `pass` would silently change
    /// what the string means, which is the one thing the old refusal was right to worry about.
    #[test]
    fn the_credential_parameter_keeps_its_own_name_through_a_save() {
        for name in ["password", "pwd", "pass", "auth_token", "api-key", "secret"] {
            let f = Fixture::new(&format!("qs-{name}"));
            let saved = upsert(
                &f.paths,
                draft(serde_json::json!({
                    "url": format!("postgresql://ro@db.internal:5432/maestro?{name}=hunter2")
                })),
                None,
            )
            .expect("upsert");
            assert_eq!(
                saved.url.as_deref(),
                Some(
                    format!(
                        "postgresql://ro@db.internal:5432/maestro\
                         ?{name}={{{{PROD_POSTGRES_PASSWORD}}}}"
                    )
                    .as_str()
                ),
                "`{name}` must not become `password`"
            );
            assert!(!f.store_text().contains("hunter2"), "{}", f.store_text());
            assert_eq!(
                f.vault_value("PROD_POSTGRES_PASSWORD").as_deref(),
                Some("hunter2")
            );
        }
    }

    /// The typed field wins over a query-string password too — the same precedence the userinfo
    /// case has, for the same reason (the field is what the user last touched). The URL keeps the
    /// reference in its own parameter, and that reference now names the **typed** value.
    #[test]
    fn the_typed_password_wins_over_one_in_a_query_parameter() {
        let f = Fixture::new("qs-both");
        let saved = upsert(
            &f.paths,
            draft(serde_json::json!({
                "url": "postgresql://ro@db.internal:5432/maestro?password=from-the-url"
            })),
            Some("from-the-field"),
        )
        .expect("upsert");
        assert_eq!(
            f.vault_value("PROD_POSTGRES_PASSWORD").as_deref(),
            Some("from-the-field"),
            "the typed password must be the one that goes to the Vault"
        );
        assert!(
            !f.vault_text().contains("from-the-url"),
            "{}",
            f.vault_text()
        );
        assert_eq!(
            saved.url.as_deref(),
            Some("postgresql://ro@db.internal:5432/maestro?password={{PROD_POSTGRES_PASSWORD}}")
        );
        assert!(
            !f.store_text().contains("from-the-url"),
            "{}",
            f.store_text()
        );
    }

    /// `never`/`session` persist **nothing** for a query-borne credential either: no value, no
    /// reference, and the parameter is gone from the string rather than left behind empty.
    #[test]
    fn a_query_string_credential_is_not_persisted_under_never_or_session() {
        for mode in ["never", "session"] {
            let f = Fixture::new(&format!("qs-{mode}"));
            let pasted = format!(
                "postgresql://ro@db.internal:5432/maestro?password={}",
                url::encode_userinfo(HOSTILE)
            );
            let saved = upsert(
                &f.paths,
                draft(serde_json::json!({"savePassword": mode, "url": pasted})),
                None,
            )
            .expect("upsert");
            assert_eq!(saved.password_ref, "", "{mode} must keep no reference");
            assert_eq!(
                saved.url.as_deref(),
                Some("postgresql://ro@db.internal:5432/maestro"),
                "{mode}: the parameter must be removed, not emptied"
            );
            assert_no_spelling_of(HOSTILE, &f.store_text(), "db-connections.json");
            assert_no_spelling_of(HOSTILE, &f.vault_text(), "the Vault");
        }
    }

    /// A string carrying a password in **two** places is refused, naming every one of them — the
    /// decision recorded in `url.rs`'s module doc: this record has one password field and one
    /// Vault reference, so keeping one of two and dropping the other silently is the outcome that
    /// must not be possible. Nothing is written when it is refused.
    #[test]
    fn a_url_with_two_credentials_is_refused_and_writes_nothing() {
        let f = Fixture::new("qs-two");
        let err = upsert(
            &f.paths,
            draft(serde_json::json!({
                "url": "postgresql://ro:in-the-userinfo@db.internal:5432/maestro?password=hunter2"
            })),
            None,
        )
        .expect_err("two credentials must be refused");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("`password=`"), "{}", err.message);
        assert!(err.message.contains("user:password@"), "{}", err.message);
        for secret in ["hunter2", "in-the-userinfo"] {
            assert!(!err.message.contains(secret), "{}", err.message);
        }
        assert!(
            !f.paths.store.exists() && !f.paths.vault.exists(),
            "a refused upsert must not have written anything"
        );
    }

    /// `build`'s refusal is **unchanged**: the string behind *Copy connection string* still cannot
    /// contain a literal password, whatever position it would go in. Only `upsert`'s refusal went
    /// away — that output goes to a file we control, this one goes to a clipboard, a ticket or a
    /// screenshot.
    #[test]
    fn build_still_refuses_a_literal_password_after_the_upsert_refusal_was_lifted() {
        let err = db_url_build(draft(serde_json::json!({"passwordRef": HOSTILE})))
            .expect_err("build must still refuse a literal");
        assert!(err.contains("never contains a password"), "{err}");
        assert_no_spelling_of(HOSTILE, &err, "the build error");
        // And the reference form still works, so the refusal is about literals only.
        let s = db_url_build(draft(serde_json::json!({"passwordRef": "{{PG_PASSWORD}}"})))
            .expect("a reference is fine");
        assert_eq!(
            s,
            "postgresql://ro:{{PG_PASSWORD}}@db.internal:5432/maestro?sslmode=prefer"
        );
    }

    /// `session` and `never` write **nothing**: the record on disk is identical whether or not a
    /// password was typed, which is the property that makes those two modes meaningful at all.
    #[test]
    fn save_password_never_or_session_persists_no_secret_and_no_reference() {
        for mode in ["never", "session"] {
            let f = Fixture::new(mode);
            let saved = upsert(
                &f.paths,
                draft(serde_json::json!({"savePassword": mode})),
                Some(HOSTILE),
            )
            .expect("upsert");
            assert_eq!(saved.password_ref, "", "{mode} must keep no reference");
            assert_no_spelling_of(HOSTILE, &f.store_text(), "db-connections.json");
            assert_no_spelling_of(HOSTILE, &f.vault_text(), "the Vault");
        }
    }

    /// Editing a password overwrites the **same** Vault row. Minting a new name each time would
    /// grow a `_2`, `_3`, `_4` tail of stale secrets that nothing reads and nobody cleans up.
    #[test]
    fn editing_a_password_reuses_the_reference_instead_of_minting_a_second_one() {
        let f = Fixture::new("edit");
        let first =
            upsert(&f.paths, draft(serde_json::json!({})), Some("old-password")).expect("first");

        let again = draft(serde_json::json!({
            "id": first.id,
            "passwordRef": "{{PROD_POSTGRES_PASSWORD}}",
        }));
        let second = upsert(&f.paths, again, Some("new-password")).expect("second");

        assert_eq!(second.id, first.id, "the same record was updated");
        assert_eq!(second.password_ref, first.password_ref);
        assert_eq!(
            second.created_at, first.created_at,
            "createdAt is preserved across an edit"
        );
        let vault = f.vault_text();
        assert!(vault.contains("new-password"));
        assert!(!vault.contains("old-password"), "the old secret lingers");
        assert_eq!(
            vault.matches("PROD_POSTGRES_PASSWORD").count(),
            1,
            "a second Vault row was minted:\n{vault}"
        );
        assert_eq!(
            store::load(&f.paths.store).connections.len(),
            1,
            "an update must not append a second connection"
        );
    }

    /* ────────── the port / srv pair through the real save path ────────── */

    /// 🔴 **A connection saved with no port keeps no port.** The dialog used to pre-fill the
    /// descriptor's default, `DbConnectionInput::port` was a mandatory `u16`, and so every record
    /// carried a port whether or not the user typed one — which is how a connection ended up
    /// showing `mongodb://…:27017/` for a host pasted without one.
    #[test]
    fn a_draft_with_no_port_is_saved_with_no_port_and_the_file_says_null() {
        let f = Fixture::new("no-port");
        let mut draft = draft(serde_json::json!({}));
        draft.port = None;
        let saved = upsert(&f.paths, draft, None).expect("an empty port must save");

        assert_eq!(saved.port, None, "a port was invented on the way to disk");
        assert!(
            f.store_text().contains("\"port\": null"),
            "the file must say `null`, which is what `types.ts` declares: {}",
            f.store_text()
        );
        // …and it loads back as absent, which is the half that matters at connect time.
        let back = store::load(&f.paths.store);
        assert_eq!(back.connections[0].port, None);
    }

    /// 🔴 **An Atlas connection survives a save** — the headline defect. `srv` had nowhere to live
    /// on the record, so a pasted `mongodb+srv://` URI parsed correctly, filled the form, and then
    /// came back out as a plain single-host `mongodb://host:27017`, which Atlas does not answer.
    #[test]
    fn an_atlas_paste_is_saved_as_an_srv_connection_with_no_port() {
        let f = Fixture::new("atlas");
        let saved = upsert(
            &f.paths,
            draft(serde_json::json!({
                "name": "Atlas Maestro",
                "engine": "mongodb",
                "host": "cluster0.abcde.mongodb.net",
                "srv": true,
                "port": null,
                "sslMode": "verify-full",
                "options": {"authSource": "admin"},
                "url": "mongodb+srv://catalog_ro@cluster0.abcde.mongodb.net/maestro?authSource=admin&tls=true",
            })),
            Some("hunter2"),
        )
        .expect("an Atlas draft must save");

        assert!(saved.srv, "the bit that makes Atlas reachable must persist");
        assert_eq!(saved.port, None);
        let url = saved.url.clone().expect("the url survives");
        assert!(
            url.starts_with("mongodb+srv://"),
            "the scheme must survive the save: {url}"
        );
        assert!(!url.contains(":27017"), "a port was invented: {url}");
        assert!(!url.contains("hunter2"), "{url}");

        // From DISK, the way a relaunch reads it — a field that serialises but does not deserialise
        // would pass every in-memory assertion above.
        let reloaded = store::load(&f.paths.store).connections.remove(0);
        assert!(reloaded.srv, "srv did not survive the file");
        assert_eq!(reloaded.port, None);
        assert!(
            f.store_text().contains("\"srv\": true"),
            "{}",
            f.store_text()
        );

        // And the string it dials with is still a portless SRV URI once the Vault value is spliced
        // back in — this is the whole point of the record carrying `srv`.
        let dialled = substitute_url(reloaded.url.as_deref(), &reloaded.password_ref, "hunter2")
            .expect("a url to dial with");
        let parts = url::parse_parts(&dialled).expect("well-formed");
        assert!(parts.srv);
        assert_eq!(parts.port, None);
    }

    /// A port **and** `srv` is refused at save time, by name, and nothing is written — the same
    /// shape as the two-credentials refusal above, and for the same reason: choosing which of the
    /// user's two answers to discard is not ours to do.
    #[test]
    fn upsert_refuses_a_port_together_with_srv_and_writes_nothing() {
        let f = Fixture::new("srv-port");
        let err = upsert(
            &f.paths,
            draft(serde_json::json!({
                "engine": "mongodb",
                "host": "cluster0.abcde.mongodb.net",
                "srv": true,
                "port": 27017,
                "sslMode": "verify-full",
                "options": {"authSource": "admin"},
            })),
            Some("hunter2"),
        )
        .expect_err("the pair must be refused");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("27017"), "{}", err.message);
        assert!(err.message.contains("SRV"), "{}", err.message);
        assert!(
            !f.paths.store.exists() && !f.paths.vault.exists(),
            "a refused upsert must not have written anything"
        );
    }

    /// `family` is denormalised from the descriptor and the client's value is ignored, so the two
    /// copies cannot disagree — only one of them is ever read.
    #[test]
    fn family_comes_from_the_descriptor_and_not_from_the_client() {
        let f = Fixture::new("family");
        let saved = upsert(
            &f.paths,
            draft(serde_json::json!({"family": "redis"})),
            None,
        )
        .expect("upsert");
        assert_eq!(saved.family, model::DbFamily::Postgres);
    }

    /// The store round-trips through a real file, and a second connection is appended rather than
    /// replacing the first.
    #[test]
    fn two_connections_both_persist_and_load_back() {
        let f = Fixture::new("two");
        upsert(&f.paths, draft(serde_json::json!({})), None).expect("first");
        upsert(
            &f.paths,
            draft(serde_json::json!({"name": "Staging"})),
            None,
        )
        .expect("second");
        let names: Vec<String> = store::load(&f.paths.store)
            .connections
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["Prod Postgres", "Staging"]);
    }

    #[test]
    fn the_registry_is_served_whole_and_postgres_is_first() {
        let list = db_engines();
        // Nine engines, DynamoDB included.
        assert_eq!(list.len(), 9);
        assert_eq!(list[0].id, model::DbEngineId::Postgres);
    }

    #[test]
    fn a_url_without_a_reference_is_passed_through_untouched() {
        let out = substitute_url(Some("postgresql://ro@h:5432/d"), "", "pw");
        assert_eq!(out.as_deref(), Some("postgresql://ro@h:5432/d"));
    }

    #[test]
    fn a_reference_in_a_url_is_replaced_with_the_percent_encoded_secret() {
        // The `/` is the point: raw substitution would make the string name a different path.
        let out =
            substitute_url(Some("postgresql://ro:{{PW}}@h:5432/d"), "{{PW}}", "a/b@c:d").unwrap();
        assert!(!out.contains("{{PW}}"));
        assert!(
            out.starts_with("postgresql://ro:a%2Fb%40c%3Ad@h:5432/d"),
            "userinfo must be percent-encoded: {out}"
        );
    }

    #[test]
    fn substitution_is_a_no_op_when_there_is_no_secret_to_substitute() {
        // Otherwise an unset password would replace `{{PW}}` with the empty string and the URL
        // would quietly become one that tries to authenticate with no password at all.
        let url = Some("postgresql://ro:{{PW}}@h:5432/d");
        assert_eq!(
            substitute_url(url, "{{PW}}", "").as_deref(),
            Some("postgresql://ro:{{PW}}@h:5432/d")
        );
    }

    /* ─────────── concurrent read-modify-writes on the DB stores ─────────── */

    // Every DB command is its own task on tokio's multi-threaded pool, so these really run at
    // once. When only the saves took `store_file::lock` and each load ran outside it, a save
    // wrote a file loaded before another save landed, losing that save.

    /// `n` threads released together by a barrier, thread `i` running `f(i)`.
    fn race(n: usize, f: impl Fn(usize) + Sync) {
        let barrier = std::sync::Barrier::new(n);
        std::thread::scope(|s| {
            for i in 0..n {
                let (f, barrier) = (&f, &barrier);
                s.spawn(move || {
                    barrier.wait();
                    f(i)
                });
            }
        });
    }

    fn connection_names(f: &Fixture) -> std::collections::BTreeSet<String> {
        store::load(&f.paths.store)
            .connections
            .into_iter()
            .map(|c| c.name)
            .collect()
    }

    fn save_named(f: &Fixture, name: String) -> DbConnection {
        upsert(
            &f.paths,
            draft(serde_json::json!({ "name": name, "savePassword": "never" })),
            None,
        )
        .expect("save the connection")
    }

    #[test]
    fn concurrent_connection_saves_lose_none() {
        let f = Fixture::new("race-upsert");
        race(8, |i| {
            for j in 0..3 {
                save_named(&f, format!("c{i}-{j}"));
            }
        });
        let names = connection_names(&f);
        assert_eq!(names.len(), 24, "saves were lost: {names:?}");
    }

    #[test]
    fn a_delete_racing_saves_neither_brings_the_connection_back_nor_loses_a_save() {
        let f = Fixture::new("race-delete");
        let doomed: Vec<String> = (0..4)
            .map(|i| save_named(&f, format!("doomed{i}")).id)
            .collect();
        race(8, |i| {
            if i < 4 {
                let report = delete_connection(&f.paths, &doomed[i]).expect("delete");
                assert!(report.removed, "{} was not there to delete", doomed[i]);
            } else {
                for j in 0..3 {
                    save_named(&f, format!("new{i}-{j}"));
                }
            }
        });
        let names = connection_names(&f);
        assert!(
            names.iter().all(|n| !n.starts_with("doomed")),
            "a deleted connection came back: {names:?}"
        );
        assert_eq!(names.len(), 12, "saves were lost: {names:?}");
    }

    #[test]
    fn concurrent_table_order_drags_in_different_levels_lose_none() {
        let f = Fixture::new("race-order");
        race(8, |i| {
            for j in 0..3 {
                set_tree_order(
                    &f.paths.tree_order,
                    "conn-1",
                    &format!("level-{i}-{j}"),
                    vec!["b".to_string(), "a".to_string()],
                )
                .expect("save the order");
            }
        });
        let levels = tree_order::for_connection(&tree_order::load(&f.paths.tree_order), "conn-1");
        assert_eq!(levels.len(), 24, "drags were lost: {levels:?}");
    }

    #[test]
    fn concurrent_query_saves_and_deletes_lose_nothing() {
        let f = Fixture::new("race-queries");
        let conn = save_named(&f, "Prod".to_string());
        let input = |name: String| -> queries::SavedQueryInput {
            serde_json::from_value(serde_json::json!({
                "connectionId": conn.id, "name": name, "sql": "SELECT 1"
            }))
            .expect("input")
        };
        let doomed: Vec<String> = (0..4)
            .map(|i| {
                upsert_saved_query(&f.paths, input(format!("doomed{i}")))
                    .expect("save")
                    .id
            })
            .collect();
        race(8, |i| {
            if i < 4 {
                assert!(delete_saved_query(&f.paths.queries, &doomed[i]).expect("delete"));
            } else {
                for j in 0..3 {
                    upsert_saved_query(&f.paths, input(format!("q{i}-{j}"))).expect("save");
                }
            }
        });
        let names: std::collections::BTreeSet<String> =
            queries::for_connection(&queries::load(&f.paths.queries), &conn.id)
                .into_iter()
                .map(|q| q.name)
                .collect();
        assert!(
            names.iter().all(|n| !n.starts_with("doomed")),
            "a deleted query came back: {names:?}"
        );
        assert_eq!(names.len(), 12, "saves were lost: {names:?}");
    }

    #[test]
    fn a_query_save_checks_its_connection_under_the_connection_lists_lock() {
        // The check ("the connection exists") and the write used to be separate, unlocked steps:
        // a delete between them left a query no tree node can show and no cascade will remove.
        // A free-running race almost never hits that window (100 rounds stayed green with the
        // locks removed), so the delete is staged: it holds the list's lock while the save
        // starts, and only then removes the connection.
        let f = Fixture::new("orphan-lock");
        let conn = save_named(&f, "Doomed".to_string());
        let input: queries::SavedQueryInput = serde_json::from_value(serde_json::json!({
            "connectionId": conn.id, "name": "Daily", "sql": "SELECT 1"
        }))
        .expect("input");
        let (held, is_held) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            s.spawn(|| {
                let _list = crate::store_file::lock(&f.paths.store);
                held.send(()).expect("signal");
                // Ample time for a save that does not wait for the lock to check and write.
                std::thread::sleep(std::time::Duration::from_millis(300));
                let mut current = store::load(&f.paths.store);
                assert!(store::remove(&mut current.connections, &conn.id));
                store::save(&f.paths.store, &current).expect("delete");
            });
            is_held.recv().expect("the delete holds the lock");
            let err = upsert_saved_query(&f.paths, input)
                .expect_err("the save must wait for the delete, then find no connection");
            assert_eq!(err.code, DbErrorCode::NotFound);
        });
        assert!(
            queries::for_connection(&queries::load(&f.paths.queries), &conn.id).is_empty(),
            "an orphan query outlived its connection"
        );
    }
}
