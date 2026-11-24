//! Shareable config bundles — export, inspect, import.
//!
//! Wire contract: `src/features/portability/types.ts`, which is the
//! **authority**; every type mirrors it with `#[serde(rename_all = "camelCase")]`.
//!
//! ```text
//! bundle.rs   the format + every pure transform (redaction, refs, hosts)  ── PURE
//! seal.rs     PBKDF2 → AES-256-GCM, and nothing else                      ── PURE
//! mod.rs      the three commands, the plan, and the file writes           ── I/O
//! ```
//!
//! ## The four properties this file is responsible for
//!
//! 1. **The bundle's bytes never cross IPC, in either direction.** Rust reads and writes the
//!    file itself, given a path the user picked with `@tauri-apps/plugin-dialog`. The webview
//!    only ever sees a [`bundle::BundleHeader`], an [`bundle::ImportPlan`] or an
//!    [`bundle::ImportResult`]. In `sealed` mode the plaintext contains live secrets, and a
//!    design where the webview assembles or receives that string puts it in the renderer's heap,
//!    in any devtools session, and in whatever a future crash reporter captures.
//! 2. **`portability_inspect` writes nothing** — not the stores, not a cache, not on a wrong
//!    passphrase. `inspect_writes_nothing_even_for_a_wrong_passphrase` snapshots all three files'
//!    bytes to prove it.
//! 3. **`structure` mode emits no secret value.** Enforced in [`export`] at three levels: every
//!    environment value becomes `null`, header/URL/body text is swept for the *actual* values
//!    this machine's Vault holds, and a literal-looking credential on a sensitive header is
//!    redacted by heuristic ([`bundle::redact_header_value`], whose limits are written out
//!    there).
//! 4. **Guardrails are re-applied on import, never trusted from the file**:
//!    engine ids validated against `db::engines`, numbers clamped, unknown fields dropped, a
//!    literal in `passwordRef` discarded, and **imported connections forced read-only**.
//!
//! ## The plan and the action are one computation
//!
//! [`plan`] produces the `Vec<PlannedItem>` that [`apply`] then executes, and every derived
//! record comes from one `materialise_*` function that both call. Writing "what would happen"
//! and "what happens" twice is how a preview and an action drift — and this feature's preview
//! *is* its security surface, so a drift there is not cosmetic.
//!
//! ## Threading
//!
//! All three commands are `async` and do their work on [`tokio::task::spawn_blocking`], because
//! 600 000 PBKDF2 rounds take a visible fraction of a second and a synchronous Tauri command
//! would spend it on the UI thread.

pub mod bundle;
pub mod seal;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::api_store::{ApiStore, EnvVar, Environment, HttpHeader, SavedRequest};
use crate::db::engines;
use crate::db::model::{DbConnection, DbConnectionStore, DbEngineId, SavePassword};
use crate::db::queries::{SavedQuery, SavedQueryStore};
use bundle::{
    item_id, Bundle, BundleContents, BundleCounts, BundleHeader, BundleMode, ExportOptions,
    ExportedApiRequest, ExportedDbConnection, ExportedDbQuery, ExportedEnvironment, ExportedHeader,
    ExportedVariable, ImportAction, ImportChoices, ImportCounts, ImportItem, ImportItemKind,
    ImportPlan, ImportResult, PlanVariable, BUNDLE_KIND, BUNDLE_VERSION, MAX_BUNDLE_BYTES,
    REDACTED_PLACEHOLDER,
};

/// The three files this feature reads and writes — **the same struct the DB client uses**.
///
/// Reused rather than redeclared so the two features cannot disagree about *which* files exist;
/// only the resolution of the real locations is repeated below, because `db::Paths::of` is
/// private to that module. [`crate::db::Paths::in_dir`] is what keeps every test in this file
/// pointed at a temp directory and away from a real config dir.
pub use crate::db::Paths;

/// `"Agent Studio 0.1.0"`. Informational metadata, **not** a compatibility gate and **not** a
/// signature — a bundle proves nothing about its author.
const APP: &str = concat!("Agent Studio ", env!("CARGO_PKG_VERSION"));

/* ─────────────────────────────── errors ─────────────────────────────── */

/// What a `portability_*` command failed at. The codes `types.ts` lists, and only those.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PortErrorCode {
    /// The file parsed as JSON but is not a bundle (wrong or missing `kind`).
    NotABundle,
    /// A `version` this build cannot read. Named separately so the message can say "upgrade".
    UnsupportedVersion,
    /// Over [`MAX_BUNDLE_BYTES`].
    TooLarge,
    /// Wrong passphrase — or a tampered ciphertext, which AES-GCM cannot tell apart.
    BadPassphrase,
    /// The file's *sealing parameters* are impossible. See [`seal::open`] for why the split
    /// between this and [`PortErrorCode::BadPassphrase`] is structural rather than cryptographic.
    Tampered,
    /// Shorter than [`seal::MIN_PASSPHRASE_LENGTH`], refused at export.
    WeakPassphrase,
    /// Could not read or write a file.
    Io,
    Unknown,
}

impl PortErrorCode {
    /// The wire spelling, written by hand rather than routed through `serde_json`, so the wire
    /// form of an *error* never depends on a serialiser succeeding (`db::error`'s idiom).
    pub fn as_str(self) -> &'static str {
        match self {
            PortErrorCode::NotABundle => "not-a-bundle",
            PortErrorCode::UnsupportedVersion => "unsupported-version",
            PortErrorCode::TooLarge => "too-large",
            PortErrorCode::BadPassphrase => "bad-passphrase",
            PortErrorCode::Tampered => "tampered",
            PortErrorCode::WeakPassphrase => "weak-passphrase",
            PortErrorCode::Io => "io",
            PortErrorCode::Unknown => "unknown",
        }
    }
}

/// A classified, human-readable failure. Same shape as `db::error::DbError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortError {
    pub code: PortErrorCode,
    pub message: String,
}

impl PortError {
    pub fn new(code: PortErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The `Err(String)` a `#[tauri::command]` rejects with: `"<code>: <detail>"`.
    pub fn to_wire(&self) -> String {
        if self.message.is_empty() {
            self.code.as_str().to_string()
        } else {
            format!("{}: {}", self.code.as_str(), self.message)
        }
    }
}

fn io_error(what: &str, e: &std::io::Error) -> PortError {
    PortError::new(PortErrorCode::Io, format!("Could not {what}: {e}"))
}

fn not_a_bundle(message: impl Into<String>) -> PortError {
    PortError::new(PortErrorCode::NotABundle, message)
}

/* ─────────────────────────────── commands ─────────────────────────────── */

/// The real paths, in the OS app config dir.
///
/// `db::Paths::of` is private to that module, so its lines are repeated here rather than
/// reached into. The *type* is shared, which is what matters: the two features cannot end up
/// disagreeing about which files hold the config. Needs an `AppHandle`, and is therefore
/// unreachable from `cargo test` — deliberately, so no test can touch a real config dir.
///
/// ⚠️ Adding a field to `Paths` breaks this function, and that is the design: a struct literal
/// with a missing field does not compile, so the duplicate cannot silently fall behind the
/// original. Fill the new field in here too rather than reaching for `..Default::default()`.
fn paths_of(app: &tauri::AppHandle) -> Paths {
    let store = crate::db::store::store_path(app);
    let queries = store
        .parent()
        .map(crate::db::queries::store_path_in)
        .unwrap_or_else(|| PathBuf::from(crate::db::queries::FILE_NAME));
    let tree_order = store
        .parent()
        .map(crate::db::tree_order::store_path_in)
        .unwrap_or_else(|| PathBuf::from(crate::db::tree_order::FILE_NAME));
    Paths {
        store,
        vault: crate::api_store::store_path_for(app),
        queries,
        tree_order,
    }
}

/// Write a bundle to `destPath` and return what it says about itself.
///
/// The header comes back so the export dialog can say "3 connections, 2 environments, sealed"
/// without re-reading the file it just wrote.
#[tauri::command]
pub async fn portability_export(
    app: tauri::AppHandle,
    options: ExportOptions,
    dest_path: String,
) -> Result<BundleHeader, String> {
    let paths = paths_of(&app);
    blocking(move || export(&paths, &options, Path::new(&dest_path))).await
}

/// A **dry run**: what importing `srcPath` would do. Writes nothing, on any path.
///
/// Callable twice for a sealed bundle — once with `passphrase: null` to describe the file, then
/// again with the passphrase to unseal and produce the full plan. `unsealed: false` means exactly
/// one thing: **sealed, and no passphrase was supplied.** A *wrong* passphrase rejects with
/// `bad-passphrase`, so one failure has one shape; a retry still costs nothing but the round trip,
/// because nothing was written either time.
#[tauri::command]
pub async fn portability_inspect(
    app: tauri::AppHandle,
    src_path: String,
    passphrase: Option<String>,
) -> Result<ImportPlan, String> {
    let paths = paths_of(&app);
    blocking(move || inspect(&paths, Path::new(&src_path), passphrase.as_deref())).await
}

/// Apply `choices` to `srcPath`. No imported request is ever run.
#[tauri::command]
pub async fn portability_import(
    app: tauri::AppHandle,
    src_path: String,
    passphrase: Option<String>,
    choices: ImportChoices,
) -> Result<ImportResult, String> {
    let paths = paths_of(&app);
    blocking(move || {
        import(
            &paths,
            Path::new(&src_path),
            passphrase.as_deref(),
            &choices,
        )
    })
    .await
}

/// Run `f` off the UI thread and flatten its error onto the wire.
///
/// Not a stylistic wrapper: [`seal::KDF_ITERATIONS`] is 600 000 PBKDF2 rounds, which is a visible
/// fraction of a second by design. A synchronous `#[tauri::command]` would spend it blocking the
/// webview, so every command here is `async` and hands the work to the blocking pool.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, PortError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result.map_err(|e| e.to_wire()),
        Err(e) => Err(PortError::new(
            PortErrorCode::Unknown,
            format!("The bundle task did not finish: {e}"),
        )
        .to_wire()),
    }
}

/* ─────────────────────────────── export ─────────────────────────────── */

/// The path-injected core of [`portability_export`].
pub fn export(
    paths: &Paths,
    options: &ExportOptions,
    dest: &Path,
) -> Result<BundleHeader, PortError> {
    let passphrase = options.passphrase.as_deref().unwrap_or("");
    match options.mode {
        BundleMode::Sealed if passphrase.is_empty() => {
            return Err(PortError::new(
                PortErrorCode::WeakPassphrase,
                "A sealed bundle needs a passphrase, communicated out of band.",
            ));
        }
        // "Required and non-empty when `mode === "sealed"`; **rejected otherwise**." Refused
        // rather than ignored, because silently dropping a passphrase the user typed would
        // produce a file they believe is encrypted and is not.
        BundleMode::Structure if !passphrase.is_empty() => {
            return Err(PortError::new(
                PortErrorCode::Unknown,
                "A passphrase is only used by a sealed export. This bundle would carry no \
                 secret values, so there is nothing to encrypt.",
            ));
        }
        _ => {}
    }
    let sealed = matches!(options.mode, BundleMode::Sealed);

    let vault = crate::api_store::load(&paths.vault);
    let store = crate::db::store::load(&paths.store);
    let saved = crate::db::queries::load(&paths.queries);

    // The exact sweep's material: the values this machine's Vault actually holds. Only used in
    // `structure` mode — a sealed bundle is *meant* to carry them.
    let secrets: Vec<String> = if sealed {
        Vec::new()
    } else {
        bundle::sweepable_secrets(&vault)
    };

    let mut contents = BundleContents::default();
    let mut included_connections: BTreeSet<String> = BTreeSet::new();
    for c in &store.connections {
        if !ExportOptions::selected(options.db_connection_ids.as_ref(), &c.id) {
            continue;
        }
        included_connections.insert(c.id.clone());
        contents.db_connections.push(export_connection(c, &secrets));
    }
    // Saved queries have no id list of their own: they **follow their connection**, because a
    // query's SQL names one server's tables and an orphan is a query you cannot run.
    for q in &saved.queries {
        if included_connections.contains(&q.connection_id) {
            contents.db_queries.push(ExportedDbQuery {
                id: q.id.clone(),
                connection_id: q.connection_id.clone(),
                name: q.name.clone(),
                sql: q.sql.clone(),
            });
        }
    }
    for r in &vault.collections {
        if !ExportOptions::selected(options.api_request_ids.as_ref(), &r.id) {
            continue;
        }
        contents
            .api_requests
            .push(export_request(r, sealed, &secrets));
    }
    for e in &vault.environments {
        if !ExportOptions::selected(options.environment_ids.as_ref(), &e.id) {
            continue;
        }
        contents.environments.push(ExportedEnvironment {
            id: e.id.clone(),
            name: e.name.clone(),
            variables: e
                .variables
                .iter()
                .map(|v| ExportedVariable {
                    key: v.key.clone(),
                    // 🔴 The whole point of `structure` mode. `None` serialises to `null`, which
                    // the contract distinguishes from `""`: "not exported" versus "genuinely
                    // empty".
                    value: if sealed { Some(v.value.clone()) } else { None },
                })
                .collect(),
        });
    }

    // Computed AFTER redaction, so the list describes what is in the file rather than what was
    // in the store before a value became `REDACTED_PLACEHOLDER`.
    contents.referenced_variables = bundle::referenced_variables(&contents);

    let header = BundleHeader {
        kind: BUNDLE_KIND.to_string(),
        version: BUNDLE_VERSION,
        mode: options.mode,
        created_at_ms: now_ms(),
        app: APP.to_string(),
        label: options.label.trim().to_string(),
        counts: counts_of(&contents),
    };

    let file = if sealed {
        let plaintext = serde_json::to_vec(&contents).map_err(|e| {
            PortError::new(
                PortErrorCode::Unknown,
                format!("Could not serialise the bundle's contents: {e}"),
            )
        })?;
        let payload = seal::seal(
            passphrase,
            &bundle::canonical_header(&header),
            &plaintext,
            seal::KDF_ITERATIONS,
        )?;
        Bundle {
            header: header.clone(),
            contents: None,
            sealed: Some(payload),
        }
    } else {
        Bundle {
            header: header.clone(),
            contents: Some(contents),
            sealed: None,
        }
    };

    write_bundle(dest, &file)?;
    Ok(header)
}

/// A connection as it travels. Two things are scrubbed even in `sealed` mode, because
/// `db-connections.json` is only *supposed* to be secret-free and a hand-edited file is not:
/// a `passwordRef` that is a literal rather than a `{{VAR}}`, and a password embedded in the URL.
fn export_connection(c: &DbConnection, secrets: &[String]) -> ExportedDbConnection {
    let password_ref = if c.password_ref.is_empty() || crate::db::secret::is_ref(&c.password_ref) {
        c.password_ref.clone()
    } else {
        String::new()
    };
    // 🔴 The URL is **always** re-rendered through the splitter, never merely inspected.
    //
    // The first draft only replaced it `if split.password.is_some()`, on the reasoning that
    // `split_url_credentials` also strips a `{{VAR}}` and losing `?password={{PG_PASSWORD}}` would
    // export a URL that no longer describes its connection. That reasoning was wrong twice, and
    // `a_literal_password_ref_in_the_store_is_never_exported` caught it: `split.url` *keeps* a
    // reference (it re-renders with `PasswordSlot::Ref`), and a `password: None` verdict on a
    // string our parser read differently than intended would have shipped the original — secret
    // and all. Re-rendering is provably credential-free by construction, and it is a fixed point
    // for anything `db_connection_upsert` wrote, because that is the same rendering.
    //
    // A string the parser cannot read at all is **dropped**. It can only have got into
    // `db-connections.json` by a hand edit (upsert refuses what it cannot split), so we cannot
    // prove it is credential-free — and an unprovable string is not one to email to a colleague.
    let url = match c.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        None => None,
        Some(raw) => match crate::db::url::split_url_credentials(raw) {
            Ok(split) => Some(split.url),
            Err(_) => None,
        },
    };
    // …and the exact sweep runs over whatever survived, for a secret sitting somewhere the
    // credential positions do not cover (a database name, an option value).
    let url = url.map(|u| bundle::redact_body(&u, secrets).0);
    ExportedDbConnection {
        id: c.id.clone(),
        name: c.name.clone(),
        engine: engine_name(c.engine),
        host: c.host.clone(),
        // `None` travels as `null`: a connection whose port field is empty must not acquire one by
        // being shared.
        port: c.port.map(i64::from),
        srv: c.srv,
        database: c.database.clone(),
        user: c.user.clone(),
        password_ref,
        ssl_mode: engines::ssl_mode_name(c.ssl_mode).to_string(),
        read_only: c.read_only,
        row_limit: i64::from(c.row_limit),
        timeout_ms: i64::from(c.timeout_ms),
        allow_multi_statement: c.allow_multi_statement,
        url,
        options: c.options.clone(),
    }
}

/// A saved request as it travels. In `structure` mode the URL, every header value and the body
/// are swept for known Vault values, and sensitive-looking headers get the heuristic too.
fn export_request(r: &SavedRequest, sealed: bool, secrets: &[String]) -> ExportedApiRequest {
    let headers = r
        .headers
        .iter()
        .map(|h| {
            let value = if sealed {
                h.value.clone()
            } else {
                // Exact knowledge first, heuristic second. If the value *is* one of this
                // machine's secrets, the whole value goes — no run-length guessing needed.
                let (swept, hit) = bundle::redact_body(&h.value, secrets);
                if hit {
                    REDACTED_PLACEHOLDER.to_string()
                } else {
                    bundle::redact_header_value(&h.name, &swept)
                        .map(str::to_string)
                        .unwrap_or(swept)
                }
            };
            ExportedHeader {
                name: h.name.clone(),
                value,
            }
        })
        .collect();
    let (url, body) = if sealed {
        (r.url.clone(), r.body.clone())
    } else {
        // The body gets the **exact** sweep only, and deliberately no heuristic. A body is an
        // arbitrary document — a GraphQL query, a protobuf-JSON message, base64 image data — with
        // no field name to gate on, so a run-length scan would shred legitimate payloads while
        // still missing a secret in an unexpected shape: neither safe nor usable. The honest
        // answers are `{{VAR}}` interpolation (which the API client already supports in bodies)
        // and `sealed` mode. Stated here rather than left as an assumed guarantee.
        (
            bundle::redact_body(&r.url, secrets).0,
            bundle::redact_body(&r.body, secrets).0,
        )
    };
    ExportedApiRequest {
        id: r.id.clone(),
        name: r.name.clone(),
        method: r.method.clone(),
        url,
        headers,
        body,
        protocol: r.protocol.clone(),
        grpc_service: r.grpc_service.clone(),
        grpc_method: r.grpc_method.clone(),
        plaintext: r.plaintext,
    }
}

fn counts_of(c: &BundleContents) -> BundleCounts {
    BundleCounts {
        db_connections: count(c.db_connections.len()),
        db_queries: count(c.db_queries.len()),
        api_requests: count(c.api_requests.len()),
        environments: count(c.environments.len()),
        referenced_variables: count(c.referenced_variables.len()),
        secret_values: count(
            c.environments
                .iter()
                .flat_map(|e| e.variables.iter())
                .filter(|v| v.value.is_some())
                .count(),
        ),
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// CRASH-SAFE write: sibling temp → `write_all` → `sync_all` → atomic `rename`, then `0600`.
///
/// The same writer every store in this repo uses. `0600` because even a `structure` bundle names
/// internal hosts, databases and variable names — nobody else's business on a shared machine.
/// It is **not** encryption and must not be described as such.
fn write_bundle(dest: &Path, file: &Bundle) -> Result<(), PortError> {
    use std::io::Write;

    let json = serde_json::to_string_pretty(file).map_err(|e| {
        PortError::new(
            PortErrorCode::Unknown,
            format!("Could not serialise the bundle: {e}"),
        )
    })?;
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| io_error("create the destination folder", &e))?;
        }
    }
    let tmp = dest.with_extension("json.tmp");
    {
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| io_error("create the bundle file", &e))?;
        f.write_all(json.as_bytes())
            .map_err(|e| io_error("write the bundle", &e))?;
        f.sync_all()
            .map_err(|e| io_error("flush the bundle to disk", &e))?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| io_error("save the bundle", &e))?;
    restrict_permissions(dest);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    // Best-effort: a filesystem that cannot express the mode must not fail the export.
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/* ─────────────────────────── read and unseal ─────────────────────────── */

/// Read and validate a bundle file, without touching its contents.
///
/// The size ceiling is checked against the file's **length**, before a byte is read: reading
/// 500 MB into memory to then reject it is the bug the ceiling exists to prevent.
fn read_bundle(src: &Path) -> Result<Bundle, PortError> {
    let meta = std::fs::metadata(src).map_err(|e| io_error("read that file", &e))?;
    if meta.len() > MAX_BUNDLE_BYTES {
        return Err(PortError::new(
            PortErrorCode::TooLarge,
            format!(
                "That file is {} bytes, and a bundle may be at most {MAX_BUNDLE_BYTES}.",
                meta.len()
            ),
        ));
    }
    let text = std::fs::read_to_string(src).map_err(|e| io_error("read that file", &e))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| not_a_bundle(format!("That file is not JSON ({e}).")))?;
    if value.get("kind").and_then(serde_json::Value::as_str) != Some(BUNDLE_KIND) {
        return Err(not_a_bundle(format!(
            "A bundle's `kind` must be `{BUNDLE_KIND}`. This file does not say that, so it was \
             not written by this app's export."
        )));
    }
    // Any version that is not exactly ours, in **either** direction. A `2` is a file from a
    // newer build and a `0` is a file declaring a version this format never defined; both leave
    // the reader in the same position — it cannot know what the fields mean — and both want the
    // same message. `not-a-bundle` would be wrong for either: the `kind` is right.
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if version != BUNDLE_VERSION {
        return Err(PortError::new(
            PortErrorCode::UnsupportedVersion,
            format!(
                "This bundle declares version {version}; this build reads version \
                 {BUNDLE_VERSION}. Upgrade Agent Studio, or ask for an export from a build that \
                 matches."
            ),
        ));
    }
    serde_json::from_value::<Bundle>(value).map_err(|e| {
        not_a_bundle(format!(
            "That file says it is a bundle but its shape is not readable ({e})."
        ))
    })
}

/// The contents, if they can be read.
///
/// `Ok(None)` has **exactly one** meaning: the bundle is sealed and **no passphrase was
/// supplied**. That is the "describe the file before asking for a passphrase" case, and it is a
/// legitimate outcome for `inspect` and never one for `import`.
///
/// A **wrong** passphrase is an `Err`, not an `Ok(None)` (a contract clarification). One
/// failure, one shape: resolving a failed unseal as an empty plan would give the frontend two
/// branches for the same event forever, and an empty plan is indistinguishable from a bundle that
/// genuinely contains nothing.
fn open_contents(
    file: &Bundle,
    passphrase: Option<&str>,
) -> Result<(Option<BundleContents>, Vec<String>), PortError> {
    match file.header.mode {
        BundleMode::Structure => match &file.contents {
            Some(c) => Ok((Some(c.clone()), Vec::new())),
            None => Err(not_a_bundle(
                "This bundle says it is a `structure` export but carries no contents.",
            )),
        },
        BundleMode::Sealed => {
            let Some(payload) = &file.sealed else {
                return Err(not_a_bundle(
                    "This bundle says it is `sealed` but carries no encrypted payload.",
                ));
            };
            let Some(pass) = passphrase.filter(|p| !p.is_empty()) else {
                return Ok((
                    None,
                    vec![
                        "This bundle is sealed. Supply the passphrase the sharer gave you to \
                         see what it contains."
                            .to_string(),
                    ],
                ));
            };
            // The AEAD's additional data is the canonical header, so a relabelled file simply does
            // not open. That failure arrives as `bad-passphrase` rather than `tampered`, and
            // [`seal::open`] documents why: AES-GCM's tag check cannot tell a wrong key from
            // altered additional data, and there is no field in `SealedPayload` that could.
            // `tampered` is reserved for what *is* distinguishable — a structurally impossible
            // parameter, or base64 that will not decode.
            let aad = bundle::canonical_header(&file.header);
            let plain = seal::open(payload, pass, &aad)?;
            let contents: BundleContents = serde_json::from_slice(&plain).map_err(|e| {
                not_a_bundle(format!(
                    "The bundle opened, but its contents are not readable ({e})."
                ))
            })?;
            Ok((Some(contents), Vec::new()))
        }
    }
}

/* ─────────────────────────────── inspect ─────────────────────────────── */

/// The path-injected core of [`portability_inspect`]. **Writes nothing.**
pub fn inspect(
    paths: &Paths,
    src: &Path,
    passphrase: Option<&str>,
) -> Result<ImportPlan, PortError> {
    let file = read_bundle(src)?;
    let (contents, mut notices) = open_contents(&file, passphrase)?;
    let Some(contents) = contents else {
        // Sealed, and no passphrase was supplied — the only thing `unsealed: false` means. The
        // header is still honest about counts, which is the bounded disclosure that lets the
        // dialog describe the file before asking. Names live inside the ciphertext, so a sealed
        // bundle received by accident does not advertise the shape of someone's infrastructure.
        return Ok(ImportPlan {
            header: file.header,
            unsealed: false,
            items: Vec::new(),
            hosts: Vec::new(),
            variables: Vec::new(),
            notices,
        });
    };
    let local = Local::load(paths);
    let planned = plan(&local, &contents);
    notices.extend(planned.notices);
    Ok(ImportPlan {
        header: file.header,
        unsealed: true,
        items: planned.items.into_iter().map(|p| p.item).collect(),
        hosts: planned.hosts,
        variables: planned.variables,
        notices: dedup(notices),
    })
}

/* ─────────────────────────────── import ─────────────────────────────── */

/// The path-injected core of [`portability_import`].
pub fn import(
    paths: &Paths,
    src: &Path,
    passphrase: Option<&str>,
    choices: &ImportChoices,
) -> Result<ImportResult, PortError> {
    let file = read_bundle(src)?;
    let (contents, notices) = open_contents(&file, passphrase)?;
    let Some(contents) = contents else {
        // `inspect` may report "sealed, no passphrase" as a state; `import` may not, because
        // importing nothing and reporting success is indistinguishable from a working import.
        let _ = notices;
        return Err(PortError::new(
            PortErrorCode::BadPassphrase,
            "This bundle is sealed and cannot be imported without its passphrase.",
        ));
    };
    // Hold every store's lock from the read to the last write: the import is a read-modify-
    // write of three files, and the Vault has other writers (a lost update would eat secrets).
    // The saves inside `apply` take the same locks again — re-entrant on this thread
    // (`store_file::lock`).
    let _locks = [&paths.store, &paths.queries, &paths.vault].map(|p| crate::store_file::lock(p));
    let local = Local::load(paths);
    let planned = plan(&local, &contents);
    apply(paths, local, planned, &contents, choices)
}

/* ─────────────────────────── the shared plan ─────────────────────────── */

/// The three local stores, loaded once and shared by the plan and the application of it.
struct Local {
    connections: DbConnectionStore,
    queries: SavedQueryStore,
    vault: ApiStore,
}

impl Local {
    fn load(paths: &Paths) -> Self {
        Self {
            connections: crate::db::store::load(&paths.store),
            queries: crate::db::queries::load(&paths.queries),
            vault: crate::api_store::load(&paths.vault),
        }
    }

    /// `true` when this machine's Vault already has a value for `name`, in **any** environment —
    /// which is the same span `db::secret::resolve` searches, so "have locally" here means the
    /// same thing it means at connect time.
    fn has_variable(&self, name: &str) -> bool {
        self.vault
            .environments
            .iter()
            .flat_map(|e| e.variables.iter())
            .any(|v| v.key == name)
    }
}

/// Which record in the bundle an [`ImportItem`] refers to.
#[derive(Debug, Clone, Copy)]
enum Target {
    DbConnection(usize),
    DbQuery(usize),
    ApiRequest(usize),
    Environment(usize),
    Variable { env: usize, var: usize },
}

/// An [`ImportItem`] plus what [`apply`] needs to execute it.
struct PlannedItem {
    item: ImportItem,
    target: Target,
    /// `false` when the user may **not** override this to create or update: an unknown engine, a
    /// record with no id, a variable the bundle carries no value for. A per-item override is a
    /// choice about *whether* to take something offered, not a way to take something that was
    /// never on offer.
    overridable: bool,
}

struct Planned {
    items: Vec<PlannedItem>,
    hosts: Vec<String>,
    variables: Vec<PlanVariable>,
    notices: Vec<String>,
}

/// Decide, for every record in `contents`, what would happen — and carry enough for [`apply`] to
/// do it. **One computation, two callers**, so the preview and the action cannot drift.
///
/// Item order is load-bearing: connections before the queries that reference them, and
/// environments before the variables that land inside them.
fn plan(local: &Local, contents: &BundleContents) -> Planned {
    let mut items: Vec<PlannedItem> = Vec::new();
    let mut notices: Vec<String> = Vec::new();
    let now = now_ms();

    /* ── DB connections ── */
    let mut importable_connection_ids: BTreeSet<String> = BTreeSet::new();
    for (i, src) in contents.db_connections.iter().enumerate() {
        let existing = local
            .connections
            .connections
            .iter()
            .find(|c| c.id == src.id);
        // The plan is computed before anyone has chosen, so it shows the DEFAULT — read-only. The
        // review screen's toggle then re-plans nothing: `apply` re-materialises with the real
        // choice, and its own notices report what actually happened.
        match materialise_connection(
            src,
            existing,
            &connection_names(local),
            now,
            ImportChoices::default().force_read_only,
        ) {
            Err(reason) => {
                notices.push(reason.clone());
                items.push(PlannedItem {
                    item: ImportItem {
                        kind: ImportItemKind::DbConnection,
                        id: item_id(ImportItemKind::DbConnection, &src.id),
                        label: label_or(&src.name, "(unnamed connection)"),
                        action: ImportAction::Skip,
                        reason,
                    },
                    target: Target::DbConnection(i),
                    overridable: false,
                });
            }
            Ok((record, mut item_notices)) => {
                importable_connection_ids.insert(record.id.clone());
                notices.append(&mut item_notices);
                items.push(PlannedItem {
                    item: ImportItem {
                        kind: ImportItemKind::DbConnection,
                        id: item_id(ImportItemKind::DbConnection, &record.id),
                        label: record.name.clone(),
                        action: existing_action(existing.is_some()),
                        reason: existing_reason(existing.is_some(), "connection"),
                    },
                    target: Target::DbConnection(i),
                    overridable: true,
                });
            }
        }
    }

    /* ── saved queries ── */
    for (i, src) in contents.db_queries.iter().enumerate() {
        let id = src.id.trim();
        let (action, reason, overridable) = if id.is_empty() {
            (
                ImportAction::Skip,
                "This saved query has no id, so it cannot be matched or updated safely."
                    .to_string(),
                false,
            )
        } else if !importable_connection_ids.contains(&src.connection_id)
            && !local
                .connections
                .connections
                .iter()
                .any(|c| c.id == src.connection_id)
        {
            (
                ImportAction::Skip,
                format!(
                    "Its connection (`{}`) is neither in this bundle nor on this machine, and a \
                     query names one server's tables.",
                    src.connection_id
                ),
                false,
            )
        } else {
            let existed = local.queries.queries.iter().any(|q| q.id == id);
            (
                existing_action(existed),
                existing_reason(existed, "saved query"),
                true,
            )
        };
        if !overridable && action == ImportAction::Skip {
            notices.push(reason.clone());
        }
        items.push(PlannedItem {
            item: ImportItem {
                kind: ImportItemKind::DbQuery,
                id: item_id(ImportItemKind::DbQuery, id),
                label: label_or(&src.name, "(unnamed query)"),
                action,
                reason,
            },
            target: Target::DbQuery(i),
            overridable,
        });
    }

    /* ── API requests ── */
    for (i, src) in contents.api_requests.iter().enumerate() {
        let existing = local.vault.collections.iter().find(|r| r.id == src.id);
        match materialise_request(src, existing, &request_names(local)) {
            Err(reason) => {
                notices.push(reason.clone());
                items.push(PlannedItem {
                    item: ImportItem {
                        kind: ImportItemKind::ApiRequest,
                        id: item_id(ImportItemKind::ApiRequest, &src.id),
                        label: label_or(&src.name, "(unnamed request)"),
                        action: ImportAction::Skip,
                        reason,
                    },
                    target: Target::ApiRequest(i),
                    overridable: false,
                });
            }
            Ok((record, mut item_notices)) => {
                notices.append(&mut item_notices);
                items.push(PlannedItem {
                    item: ImportItem {
                        kind: ImportItemKind::ApiRequest,
                        id: item_id(ImportItemKind::ApiRequest, &record.id),
                        label: record.name.clone(),
                        action: existing_action(existing.is_some()),
                        reason: existing_reason(existing.is_some(), "request"),
                    },
                    target: Target::ApiRequest(i),
                    overridable: true,
                });
            }
        }
    }

    /* ── environments, then the variables inside them ── */
    for (i, src) in contents.environments.iter().enumerate() {
        let id = src.id.trim();
        if id.is_empty() {
            notices.push("An environment in this bundle has no id and was skipped.".to_string());
            items.push(PlannedItem {
                item: ImportItem {
                    kind: ImportItemKind::Environment,
                    id: item_id(ImportItemKind::Environment, ""),
                    label: label_or(&src.name, "(unnamed environment)"),
                    action: ImportAction::Skip,
                    reason: "This environment has no id, so it cannot be matched.".to_string(),
                },
                target: Target::Environment(i),
                overridable: false,
            });
            continue;
        }
        let existed = local.vault.environments.iter().any(|e| e.id == id);
        items.push(PlannedItem {
            item: ImportItem {
                kind: ImportItemKind::Environment,
                id: item_id(ImportItemKind::Environment, id),
                label: label_or(&src.name, "(unnamed environment)"),
                action: existing_action(existed),
                reason: existing_reason(existed, "environment"),
            },
            target: Target::Environment(i),
            overridable: true,
        });
    }

    let mut seen_variables: BTreeSet<String> = BTreeSet::new();
    for (ei, env) in contents.environments.iter().enumerate() {
        for (vi, var) in env.variables.iter().enumerate() {
            let key = var.key.trim();
            if key.is_empty() {
                continue;
            }
            if !seen_variables.insert(key.to_string()) {
                notices.push(format!(
                    "`{key}` appears in more than one of this bundle's environments; only the \
                     first was listed."
                ));
                continue;
            }
            let (action, reason, overridable) = match &var.value {
                // 🔴 A `structure` bundle carries names without values, and creating an EMPTY
                // Vault row would be actively harmful: `db::secret::resolve` returns `Ok("")`
                // for a key that exists, so a clear `secret-missing` error naming the variable
                // would silently become an empty-password connection attempt. The name is
                // reported in the plan; the row is not created.
                None => (
                    ImportAction::Skip,
                    format!(
                        "This bundle carries no value for `{key}` — add your own in the Vault \
                         panel."
                    ),
                    false,
                ),
                Some(_) if local.has_variable(key) => (
                    ImportAction::Skip,
                    format!(
                        "You already have a value for `{key}`. Importing would replace it, which \
                         is why it needs the explicit \"replace my values\" choice."
                    ),
                    true,
                ),
                Some(_) => (
                    ImportAction::Create,
                    format!("`{key}` is new on this machine."),
                    true,
                ),
            };
            items.push(PlannedItem {
                item: ImportItem {
                    kind: ImportItemKind::Variable,
                    id: item_id(ImportItemKind::Variable, key),
                    label: key.to_string(),
                    action,
                    reason,
                },
                target: Target::Variable { env: ei, var: vi },
                overridable,
            });
        }
    }

    /* ── the security surface ── */
    let hosts = bundle::hosts_in(contents);
    let variables = plan_variables(local, contents);
    notices.extend(redaction_notices(contents));

    Planned {
        items,
        hosts,
        variables,
        notices: dedup(notices),
    }
}

/// Every `{{VAR}}` the bundle references, flagged against this machine.
///
/// The union of the file's own `referencedVariables` and a **locally recomputed** scan. Both,
/// deliberately: the file's list is the exporter's (and is what the contract says to carry), but
/// trusting it alone would let a hostile bundle *omit* `PROD_API_KEY` from the list and keep
/// the dialog from ever mentioning the variable its request is about to read. The security
/// surface must not be self-reported by the thing being inspected.
fn plan_variables(local: &Local, contents: &BundleContents) -> Vec<PlanVariable> {
    let mut names: BTreeSet<String> = contents
        .referenced_variables
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    names.extend(bundle::referenced_variables(contents));
    names
        .into_iter()
        .map(|name| PlanVariable {
            have_locally: local.has_variable(&name),
            bundle_has_value: contents
                .environments
                .iter()
                .flat_map(|e| e.variables.iter())
                .any(|v| v.key == name && v.value.is_some()),
            name,
        })
        .collect()
}

/// "This header was redacted at export" — the notice the *export* side has nowhere to return.
///
/// ⚠️ Contract gap: `portability_export` returns a `BundleHeader`, which has no `notices` field, so
/// the sharer is never told which of their headers was redacted. Detecting [`REDACTED_PLACEHOLDER`]
/// at inspect time gives the *recipient* the actionable half of that — "you must supply this value"
/// — which is the half that decides whether the imported request works.
fn redaction_notices(contents: &BundleContents) -> Vec<String> {
    let mut out = Vec::new();
    for r in &contents.api_requests {
        for h in &r.headers {
            if h.value.contains(REDACTED_PLACEHOLDER) {
                out.push(format!(
                    "`{}`'s `{}` header was redacted when this bundle was exported — supply your \
                     own value before sending it.",
                    label_or(&r.name, "(unnamed request)"),
                    h.name
                ));
            }
        }
        if r.body.contains(REDACTED_PLACEHOLDER) || r.url.contains(REDACTED_PLACEHOLDER) {
            out.push(format!(
                "`{}` had a secret redacted out of its URL or body when this bundle was exported.",
                label_or(&r.name, "(unnamed request)")
            ));
        }
    }
    out
}

/* ─────────────────────────────── apply ─────────────────────────────── */

/// Execute `planned`. The only function in this file that writes anything.
fn apply(
    paths: &Paths,
    mut local: Local,
    planned: Planned,
    contents: &BundleContents,
    choices: &ImportChoices,
) -> Result<ImportResult, PortError> {
    let mut result = ImportResult::default();
    let mut notices: Vec<String> = Vec::new();
    let (mut store_dirty, mut queries_dirty, mut vault_dirty) = (false, false, false);
    let now = now_ms();

    for p in &planned.items {
        let action = resolve_action(p, choices, contents, &local);
        if action == ImportAction::Skip {
            // A secret we deliberately did NOT take belongs in the report, not only in the plan:
            // it is the difference between "the import worked" and "the import worked and your own
            // value is still the one in use".
            if let Target::Variable { env, var } = p.target {
                let src = &contents.environments[env].variables[var];
                if src.value.is_some() && local.has_variable(src.key.trim()) {
                    notices.push(kept_own_value(src.key.trim()));
                }
            }
            bump(&mut result.skipped, p.item.kind);
            continue;
        }
        match p.target {
            Target::DbConnection(i) => {
                let src = &contents.db_connections[i];
                let existing = local
                    .connections
                    .connections
                    .iter()
                    .find(|c| c.id == src.id);
                let existed = existing.is_some();
                let Ok((record, mut item_notices)) = materialise_connection(
                    src,
                    existing,
                    &connection_names(&local),
                    now,
                    choices.force_read_only,
                ) else {
                    // Unreachable: a record that failed to materialise was planned as a
                    // non-overridable skip. Counted rather than panicking, because "the plan and
                    // the action disagree" must not be able to take the app down.
                    bump(&mut result.skipped, p.item.kind);
                    continue;
                };
                notices.append(&mut item_notices);
                crate::db::store::put(&mut local.connections.connections, record);
                store_dirty = true;
                bump(outcome(&mut result, existed), p.item.kind);
            }
            Target::DbQuery(i) => {
                let src = &contents.db_queries[i];
                // Re-checked here, not only in the plan: the connection may have been skipped by
                // an explicit per-item choice after the plan was built.
                if !local
                    .connections
                    .connections
                    .iter()
                    .any(|c| c.id == src.connection_id)
                {
                    notices.push(format!(
                        "`{}` was skipped: its connection was not imported.",
                        label_or(&src.name, "(unnamed query)")
                    ));
                    bump(&mut result.skipped, p.item.kind);
                    continue;
                }
                // `position` rather than `iter_mut().find()`: the mutable borrow of the scrutinee
                // would still be live in the `None` arm that needs to `push`.
                let slot = local.queries.queries.iter().position(|q| q.id == src.id);
                let existed = slot.is_some();
                let record = materialise_query(src, slot.map(|k| &local.queries.queries[k]), now);
                match slot {
                    Some(k) => local.queries.queries[k] = record,
                    None => local.queries.queries.push(record),
                }
                queries_dirty = true;
                bump(outcome(&mut result, existed), p.item.kind);
            }
            Target::ApiRequest(i) => {
                let src = &contents.api_requests[i];
                let slot = local.vault.collections.iter().position(|r| r.id == src.id);
                let existed = slot.is_some();
                let Ok((record, mut item_notices)) = materialise_request(
                    src,
                    slot.map(|k| &local.vault.collections[k]),
                    &request_names(&local),
                ) else {
                    bump(&mut result.skipped, p.item.kind);
                    continue;
                };
                notices.append(&mut item_notices);
                match slot {
                    Some(k) => local.vault.collections[k] = record,
                    None => local.vault.collections.push(record),
                }
                vault_dirty = true;
                bump(outcome(&mut result, existed), p.item.kind);
            }
            Target::Environment(i) => {
                let src = &contents.environments[i];
                let name = label_or(&src.name, "Imported");
                match local.vault.environments.iter().position(|e| e.id == src.id) {
                    Some(k) => {
                        // The id matched, so this *is* the same environment — almost always an
                        // earlier export of it. Its variables are left alone here; the variable
                        // items below are the only thing that touches a value.
                        local.vault.environments[k].name = name;
                        vault_dirty = true;
                        bump(&mut result.updated, p.item.kind);
                    }
                    None => {
                        local.vault.environments.push(Environment {
                            id: src.id.trim().to_string(),
                            name,
                            variables: Vec::new(),
                        });
                        vault_dirty = true;
                        bump(&mut result.created, p.item.kind);
                    }
                }
            }
            Target::Variable { env, var } => {
                let src = &contents.environments[env].variables[var];
                let key = src.key.trim();
                let Some(value) = src.value.clone() else {
                    bump(&mut result.skipped, p.item.kind);
                    continue;
                };
                if local.has_variable(key) {
                    // Incoming secrets never replace existing ones unless explicitly allowed.
                    // The flag wins over a per-item override: taking someone else's value for a
                    // variable you already use is how a working setup breaks in a way nobody
                    // traces back to an import, and one checkbox is a deliberate act while a
                    // per-row dropdown is a click.
                    if !choices.overwrite_existing_secrets {
                        notices.push(kept_own_value(key));
                        bump(&mut result.skipped, p.item.kind);
                        continue;
                    }
                    // Overwritten **everywhere** it appears, not just in the active environment:
                    // `db::secret::resolve` falls through to every environment, so leaving one
                    // stale copy behind would mean the value that gets used is whichever
                    // environment happens to be active.
                    for e in &mut local.vault.environments {
                        for v in &mut e.variables {
                            if v.key == key {
                                v.value = value.clone();
                            }
                        }
                    }
                    vault_dirty = true;
                    bump(&mut result.updated, p.item.kind);
                    continue;
                }
                let target_env = contents.environments[env].id.trim().to_string();
                match local
                    .vault
                    .environments
                    .iter()
                    .position(|e| e.id == target_env)
                {
                    Some(k) => local.vault.environments[k].variables.push(EnvVar {
                        key: key.to_string(),
                        value,
                    }),
                    // The environment itself was skipped, but the variable was not. `secret::put`
                    // is the existing, tested writer: it targets the active environment and
                    // creates a `Default` one if the Vault has none.
                    None => crate::db::secret::put(&mut local.vault, key, &value),
                }
                vault_dirty = true;
                bump(&mut result.created, p.item.kind);
            }
        }
    }

    if store_dirty {
        crate::db::store::save(&paths.store, &local.connections)
            .map_err(|e| io_error("save the connection list", &e))?;
    }
    if queries_dirty {
        crate::db::queries::save(&paths.queries, &local.queries)
            .map_err(|e| io_error("save the saved queries", &e))?;
    }
    if vault_dirty {
        crate::api_store::save(&paths.vault, &local.vault)
            .map_err(|e| io_error("save the API store and Vault", &e))?;
    }

    result.notices = dedup(notices);
    Ok(result)
}

/// The action to take: the plan's default, overridden by the user only where that is meaningful.
///
/// ## Why `overwriteExistingSecrets` has to be read here and not in [`plan`]
///
/// The plan is a dry run under **default** choices, so for a variable this machine already holds
/// its honest default is `Skip` ("keep mine"). The flag is a *choice*, and it arrives with the
/// import — so if `apply` only ever executed the plan's action, turning the flag on would change
/// nothing at all. That was a real bug, caught by
/// `an_incoming_secret_never_replaces_an_existing_one_unless_explicitly_allowed`, which failed with
/// an empty notice list because the code path holding the overwrite logic was unreachable.
///
/// The promotion is deliberately narrow: only a `variable`, only one the plan marked
/// **overridable** (so a valueless name can never be conjured into an empty Vault row), and only
/// when the flag is on.
fn resolve_action(
    p: &PlannedItem,
    choices: &ImportChoices,
    contents: &BundleContents,
    local: &Local,
) -> ImportAction {
    if !p.overridable {
        return p.item.action;
    }
    let chosen = choices
        .actions
        .get(&p.item.id)
        .copied()
        .unwrap_or(p.item.action);
    if chosen != ImportAction::Skip || !choices.overwrite_existing_secrets {
        return chosen;
    }
    if let Target::Variable { env, var } = p.target {
        let src = &contents.environments[env].variables[var];
        if src.value.is_some() && local.has_variable(src.key.trim()) {
            return ImportAction::Update;
        }
    }
    chosen
}

/// The one wording for "we did not take this secret", so the two code paths that report it cannot
/// drift into two different accounts of the same decision.
fn kept_own_value(key: &str) -> String {
    format!(
        "Kept your own value for `{key}`. Turn on \"replace my existing values\" to take the \
         bundle's."
    )
}

/// Which count bucket an outcome belongs in.
///
/// Keyed on whether the record **existed**, not on whether the plan said "create" or "update".
/// Both actions upsert by id — a `create` for an id that is already present cannot produce a
/// duplicate — so the honest report is what happened, not what was asked for.
fn outcome(result: &mut ImportResult, existed: bool) -> &mut ImportCounts {
    if existed {
        &mut result.updated
    } else {
        &mut result.created
    }
}

fn bump(counts: &mut ImportCounts, kind: ImportItemKind) {
    let slot = match kind {
        ImportItemKind::DbConnection => &mut counts.db_connections,
        ImportItemKind::DbQuery => &mut counts.db_queries,
        ImportItemKind::ApiRequest => &mut counts.api_requests,
        ImportItemKind::Environment => &mut counts.environments,
        ImportItemKind::Variable => &mut counts.variables,
    };
    *slot = slot.saturating_add(1);
}

/* ─────────────────────── materialising the records ─────────────────────── */

/// The `DbConnection` this bundle record becomes, plus every notice that describes.
///
/// **The one function that re-applies the import guardrails**, called by both [`plan`] (for the
/// notices and the skip decision) and [`apply`] (for the record). `Err` is the sentence
/// explaining why the item cannot be imported at all.
fn materialise_connection(
    src: &ExportedDbConnection,
    existing: Option<&DbConnection>,
    taken: &[(String, String)],
    now: u64,
    // The importer's choice (`ImportChoices::force_read_only`). `plan` passes the DEFAULT, because
    // a plan is computed before anyone has decided; `apply` passes what they decided.
    force_read_only: bool,
) -> Result<(DbConnection, Vec<String>), String> {
    let mut notices = Vec::new();
    let id = src.id.trim();
    if id.is_empty() {
        return Err(
            "A connection in this bundle has no id, so it cannot be matched or updated \
                    safely, and was skipped."
                .to_string(),
        );
    }
    // Engine ids validated against the registry, never trusted from the file. An unknown engine
    // is a **skipped item**, not a failed import: one row a newer build wrote must not cost the
    // recipient the other nine.
    let engine = engine_from_name(&src.engine).ok_or_else(|| {
        format!(
            "`{}` uses the engine `{}`, which this build does not know, so it was skipped.",
            label_or(&src.name, id),
            src.engine
        )
    })?;
    let spec = engines::spec_for(engine).ok_or_else(|| {
        format!(
            "`{}` names an engine with no descriptor in this build, so it was skipped.",
            label_or(&src.name, id)
        )
    })?;

    let mut name = src.name.trim().to_string();
    if name.is_empty() {
        name = spec.label.to_string();
        notices.push(format!(
            "A connection in this bundle had no name; it was imported as `{name}`."
        ));
    }
    if existing.is_none() {
        let unique = unique_name(&name, id, taken);
        if unique != name {
            notices.push(format!(
                "You already have a connection called `{name}`, so the imported one was saved as \
                 `{unique}` rather than merged into yours."
            ));
            name = unique;
        }
    }

    // Numbers clamped rather than refused. `db::mod::upsert` *rejects* an out-of-range number,
    // because there a human is looking at the field that is wrong; here there is no field to
    // point at and refusing would discard a record over a value we can safely correct. Both go
    // through the same bounds (`engines::MAX_ROW_LIMIT`, `MIN_/MAX_TIMEOUT_MS`), so a clamped
    // record is one `upsert` would accept.
    // An **absent** port is not an unusable one: it means "use the engine's default", which is a
    // state the record can now hold, so it is carried across unchanged and silently. Only a number
    // that is present and cannot be a port gets the clamp-and-say-so treatment.
    let port = match src.port {
        None => None,
        Some(raw) => match u16::try_from(raw).ok().filter(|p| *p > 0) {
            Some(p) => Some(p),
            None => {
                notices.push(format!(
                    "`{name}` had an unusable port ({raw}), so {}'s default ({}) was used.",
                    spec.label, spec.default_port
                ));
                Some(spec.default_port)
            }
        },
    };
    // A bundle that says both is one a human edited (the exporter cannot produce it, and `upsert`
    // refuses it). Dropped in favour of SRV **with a notice**, rather than refusing the whole
    // record: unlike the dialog there is no field to point the user at, and the alternative is
    // discarding a connection over a contradiction we can describe.
    let (port, srv) = match (src.srv, port) {
        (true, Some(dropped)) => {
            notices.push(format!(
                "`{name}` asked for `mongodb+srv://` **and** port {dropped}. SRV reads the host and \
                 port out of DNS, so the port was dropped — check the connection before you use it."
            ));
            (None, true)
        }
        (srv, port) => (port, srv),
    };
    let row_limit = clamp_i64(src.row_limit, 1, engines::MAX_ROW_LIMIT);
    if i64::from(row_limit) != src.row_limit {
        notices.push(format!(
            "`{name}`'s row limit ({}) was clamped to {row_limit}.",
            src.row_limit
        ));
    }
    let timeout_ms = clamp_i64(
        src.timeout_ms,
        engines::MIN_TIMEOUT_MS,
        engines::MAX_TIMEOUT_MS,
    );
    if i64::from(timeout_ms) != src.timeout_ms {
        notices.push(format!(
            "`{name}`'s timeout ({} ms) was clamped to {timeout_ms} ms.",
            src.timeout_ms
        ));
    }

    let ssl_mode = match engines::ssl_mode_from_name(&src.ssl_mode) {
        Some(m) if spec.ssl_modes.contains(&m) => m,
        _ => {
            let fallback = spec.defaults.ssl_mode;
            notices.push(format!(
                "`{name}` asked for SSL mode `{}`, which this build does not offer for {}, so \
                 `{}` was used.",
                src.ssl_mode,
                spec.label,
                engines::ssl_mode_name(fallback)
            ));
            fallback
        }
    };

    // A `passwordRef` must be `""` or a `{{VAR}}`. A literal here would put a plaintext password
    // into `db-connections.json`, which is the one thing that file guarantees it never holds
    // — so a hand-written bundle cannot smuggle one in.
    let mut password_ref = src.password_ref.trim().to_string();
    if !password_ref.is_empty() && !crate::db::secret::is_ref(&password_ref) {
        notices.push(format!(
            "`{name}` carried a literal value where a `{{{{VAR}}}}` reference belongs. It was \
             discarded — a connection record never holds a password."
        ));
        password_ref = String::new();
    }

    let mut url = src
        .url
        .clone()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    if let Some(raw) = url.clone() {
        match crate::db::url::split_url_credentials(&raw) {
            Ok(split) => {
                if split.password.is_some() {
                    notices.push(format!(
                        "`{name}`'s connection string carried a password. It was stripped — the \
                         Vault is the only place a value lives."
                    ));
                    url = Some(split.url);
                }
                if password_ref.is_empty() {
                    if let Some(r) = split.password_ref {
                        password_ref = r;
                    }
                }
            }
            Err(e) => {
                notices.push(format!(
                    "`{name}`'s connection string could not be read, so it was dropped and the \
                     host/port fields are what will be used ({}).",
                    e.message
                ));
                url = None;
            }
        }
    }

    // Option keys that would defeat a guarantee are dropped rather than refusing the record:
    // a credential parameter would put a secret in a plaintext file, and a key colliding with
    // the family's own TLS parameter would let the query string contradict the SSL control.
    let mut options = src.options.clone();
    let ssl_params = crate::db::url::family_ssl_param_names(spec.family);
    let dropped: Vec<String> = options
        .keys()
        .filter(|k| {
            let lower = k.to_ascii_lowercase();
            crate::db::url::is_credential_param(&lower)
                || ssl_params.iter().any(|n| n.eq_ignore_ascii_case(&lower))
        })
        .cloned()
        .collect();
    for key in &dropped {
        options.remove(key);
    }
    if !dropped.is_empty() {
        notices.push(format!(
            "`{name}`: the option(s) {} were dropped — they would either put a credential in a \
             plaintext file or contradict the SSL setting.",
            dropped
                .iter()
                .map(|k| format!("`{k}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    if src.host.trim().is_empty() && url.is_none() {
        notices.push(format!(
            "`{name}` has no host and no connection string, so it will not connect until you \
             fill one in."
        ));
    }

    // 🔴 **Read-only on import is the DEFAULT, not a forced value.** The
    // original reasoning survives as justification for the default — a connection that has just
    // arrived is new *on this machine*, and the recipient did not make the sharer's choice — but the
    // importer is a person looking at a review screen, and refusing to let them say "yes, I do want
    // this writable" is the app deciding for them. The notice reports what will actually happen in
    // both directions, because an import that silently made a connection writable would be worse
    // than one that silently made it read-only.
    let read_only = if force_read_only { true } else { src.read_only };
    if !src.read_only && force_read_only {
        notices.push(format!(
            "`{name}` was marked read-write by the sharer. It will be imported **read-only**; \
             untick \"Import connections as read-only\" if you mean to write, or change it later \
             in the connection dialog."
        ));
    }
    if !read_only {
        notices.push(format!(
            "`{name}` will be imported **writable**, because you turned off read-only import. \
             DELETE and UPDATE will reach the server."
        ));
    }

    Ok((
        DbConnection {
            id: id.to_string(),
            name,
            engine,
            // Denormalised from the descriptor, never from the file, so the two cannot disagree.
            family: spec.family,
            host: src.host.trim().to_string(),
            port,
            database: src.database.trim().to_string(),
            user: src.user.trim().to_string(),
            // `Forever` only when there is a reference to resolve. With no reference, `Never` is
            // what makes `resolve_password` return an empty password instead of a Vault lookup
            // that would always miss.
            save_password: if password_ref.is_empty() {
                SavePassword::Never
            } else {
                SavePassword::Forever
            },
            password_ref,
            url,
            srv,
            ssl_mode,
            // The contract carries no CA field: a fingerprint describes a certificate file on the
            // sharer's laptop, which the recipient does not have.
            ca_summary: None,
            options,
            read_only,
            row_limit,
            timeout_ms,
            allow_multi_statement: src.allow_multi_statement,
            created_at: existing.map_or(now, |e| e.created_at),
            updated_at: now,
        },
        notices,
    ))
}

fn materialise_query(src: &ExportedDbQuery, existing: Option<&SavedQuery>, now: u64) -> SavedQuery {
    SavedQuery {
        id: src.id.trim().to_string(),
        // A query cannot be moved between connections by an update (its SQL names one server's
        // tables), so an existing record keeps its own.
        connection_id: existing.map_or_else(
            || src.connection_id.trim().to_string(),
            |e| e.connection_id.clone(),
        ),
        name: {
            let n = src.name.trim();
            if n.is_empty() {
                "Imported query".to_string()
            } else {
                n.to_string()
            }
        },
        sql: src.sql.clone(),
        created_at_ms: existing.map_or(now, |e| e.created_at_ms),
        updated_at_ms: now,
    }
}

fn materialise_request(
    src: &ExportedApiRequest,
    existing: Option<&SavedRequest>,
    taken: &[(String, String)],
) -> Result<(SavedRequest, Vec<String>), String> {
    let mut notices = Vec::new();
    let id = src.id.trim();
    if id.is_empty() {
        return Err(
            "A request in this bundle has no id, so it cannot be matched or updated safely, and \
             was skipped."
                .to_string(),
        );
    }
    let mut name = src.name.trim().to_string();
    if name.is_empty() {
        name = "Imported request".to_string();
    }
    if existing.is_none() {
        let unique = unique_name(&name, id, taken);
        if unique != name {
            notices.push(format!(
                "You already have a request called `{name}`, so the imported one was saved as \
                 `{unique}` rather than merged into yours."
            ));
            name = unique;
        }
    }
    Ok((
        SavedRequest {
            id: id.to_string(),
            name,
            method: src.method.trim().to_string(),
            url: src.url.clone(),
            headers: src
                .headers
                .iter()
                .filter(|h| !h.name.trim().is_empty())
                .map(|h| HttpHeader {
                    name: h.name.trim().to_string(),
                    value: h.value.clone(),
                })
                .collect(),
            body: src.body.clone(),
            protocol: src.protocol.clone(),
            grpc_service: src.grpc_service.clone(),
            grpc_method: src.grpc_method.clone(),
            plaintext: src.plaintext,
            // Folders are LOCAL grouping and are not carried in a bundle, so
            // an import must not move requests around the user's rail: updating an
            // existing request keeps whatever folder they filed it in, and a genuinely
            // new one lands at the root. Overwriting with `None` would silently un-file
            // every request an import touched.
            folder_id: existing.and_then(|e| e.folder_id.clone()),
        },
        notices,
    ))
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

fn engine_name(id: DbEngineId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The kebab-case engine id, or `None`. Routed through serde so this can never accept a spelling
/// `DbEngineId` does not, and can never drift as engines are added.
fn engine_from_name(name: &str) -> Option<DbEngineId> {
    serde_json::from_value(serde_json::Value::String(name.trim().to_string())).ok()
}

fn clamp_i64(value: i64, low: u32, high: u32) -> u32 {
    value.clamp(i64::from(low), i64::from(high)) as u32
}

fn label_or(text: &str, fallback: &str) -> String {
    let t = text.trim();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t.to_string()
    }
}

fn existing_action(existed: bool) -> ImportAction {
    if existed {
        ImportAction::Update
    } else {
        ImportAction::Create
    }
}

fn existing_reason(existed: bool, what: &str) -> String {
    if existed {
        format!("A {what} with this id already exists, so it would be updated in place.")
    } else {
        format!("This {what} is new on this machine.")
    }
}

/// `(id, name)` of everything local, so a create can avoid colliding with a *different* record's
/// name (ids are matched exactly; names are not).
fn connection_names(local: &Local) -> Vec<(String, String)> {
    local
        .connections
        .connections
        .iter()
        .map(|c| (c.id.clone(), c.name.clone()))
        .collect()
}

fn request_names(local: &Local) -> Vec<(String, String)> {
    local
        .vault
        .collections
        .iter()
        .map(|r| (r.id.clone(), r.name.clone()))
        .collect()
}

/// `desired`, suffixed until it collides with no *other* record's name.
///
/// Suffixed rather than merged: two things that happen to share a name are still two things, and
/// silently merging them would overwrite the recipient's own record with a stranger's.
fn unique_name(desired: &str, id: &str, taken: &[(String, String)]) -> String {
    let clashes = |candidate: &str| {
        taken
            .iter()
            .any(|(tid, tname)| tid != id && tname == candidate)
    };
    if !clashes(desired) {
        return desired.to_string();
    }
    let first = format!("{desired} (imported)");
    if !clashes(&first) {
        return first;
    }
    for n in 2..1_000 {
        let candidate = format!("{desired} (imported {n})");
        if !clashes(&candidate) {
            return candidate;
        }
    }
    // 999 identically-named records is not a reachable state, but a name is better than a panic.
    format!("{desired} (imported {id})")
}

/// Notices, first occurrence kept. The same guardrail firing on eight connections should say so
/// once, or the dialog is a wall nobody reads.
fn dedup(notices: Vec<String>) -> Vec<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    notices
        .into_iter()
        .filter(|n| seen.insert(n.clone()))
        .collect()
}

/// Wall-clock milliseconds, for `createdAt`/`updatedAt` and the bundle's `createdAtMs` — all
/// display values. Nothing verifies them; clocks lie.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::model::{DbFamily, SslMode};

    /// A secret chosen to break a careless leak check: characters that percent-encode, a
    /// backslash (which JSON escapes to `\\`, so the *raw* bytes are absent from the file even
    /// when the secret is present — the trap [`assert_no_spelling_of`] exists for), and non-ASCII.
    const HOSTILE: &str = "p@ss:w/o?rd#\\ünïcode ✓ hunter2";
    /// A literal-looking credential that is **not** in the Vault, so only the heuristic can catch
    /// it. Distinct from [`HOSTILE`] so a passing test says which mechanism worked.
    const UNKNOWN_TOKEN: &str = "0123456789abcdef0123456789abcdef01234567";
    const PASS: &str = "correct horse battery staple";
    /// Iterations for hand-built fixtures. The count travels in the file, so `open` reads it —
    /// which is exactly why the mechanics can be proven fast and the shipped constant separately.
    const FAST: u32 = 1_000;

    /* ───────────────────────────── fixtures ───────────────────────────── */

    /// A temp directory holding all three stores, removed on drop. Nothing in this module goes
    /// anywhere near a real config directory.
    struct Fixture {
        dir: PathBuf,
        paths: Paths,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentstudio-port-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            let paths = Paths::in_dir(&dir);
            Self { dir, paths }
        }

        fn at(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }

        fn seed_vault(&self, store: &ApiStore) {
            crate::api_store::save(&self.paths.vault, store).expect("seed the vault");
        }

        fn seed_connections(&self, connections: Vec<DbConnection>) {
            crate::db::store::save(
                &self.paths.store,
                &DbConnectionStore {
                    connections,
                    version: 1,
                },
            )
            .expect("seed the connections");
        }

        fn seed_queries(&self, queries: Vec<SavedQuery>) {
            crate::db::queries::save(
                &self.paths.queries,
                &SavedQueryStore {
                    version: 1,
                    queries,
                },
            )
            .expect("seed the queries");
        }

        fn connections(&self) -> Vec<DbConnection> {
            crate::db::store::load(&self.paths.store).connections
        }

        fn vault(&self) -> ApiStore {
            crate::api_store::load(&self.paths.vault)
        }

        fn vault_value(&self, key: &str) -> Option<String> {
            self.vault()
                .environments
                .iter()
                .flat_map(|e| e.variables.iter())
                .find(|v| v.key == key)
                .map(|v| v.value.clone())
        }

        fn text(&self, path: &Path) -> String {
            std::fs::read_to_string(path).unwrap_or_default()
        }

        /// The bytes of every file in the directory, so "wrote nothing" can be *measured* rather
        /// than assumed — including a stray `.tmp` a half-finished atomic write would leave.
        fn snapshot(&self) -> Vec<(String, Vec<u8>)> {
            let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(&self.dir)
                .expect("read the fixture dir")
                .filter_map(Result::ok)
                .filter(|e| e.path().is_file())
                .map(|e| {
                    (
                        e.file_name().to_string_lossy().to_string(),
                        std::fs::read(e.path()).unwrap_or_default(),
                    )
                })
                .collect();
            out.sort();
            out
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Assert `secret` is absent from `text` in **every spelling it could take**.
    ///
    /// The idiom from `db/mod.rs`'s tests, and it is not decoration: a single `contains` on the
    /// raw form passes for a secret containing a backslash, because JSON writes that as `\\`.
    fn assert_no_spelling_of(secret: &str, text: &str, what: &str) {
        let json_escaped = serde_json::to_string(secret).expect("a string serialises");
        for (spelling, form) in [
            ("raw", secret.to_string()),
            ("JSON-escaped", json_escaped.trim_matches('"').to_string()),
            ("percent-encoded", crate::db::url::encode_userinfo(secret)),
        ] {
            assert!(
                !text.contains(&form),
                "the {spelling} form of the secret is in {what}:\n{text}"
            );
        }
    }

    fn conn(id: &str, name: &str, password_ref: &str) -> DbConnection {
        DbConnection {
            id: id.to_string(),
            name: name.to_string(),
            engine: DbEngineId::Postgres,
            family: DbFamily::Postgres,
            host: "db.internal".into(),
            port: Some(5432),
            database: "maestro".into(),
            user: "ro".into(),
            password_ref: password_ref.to_string(),
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
            created_at: 1_000,
            updated_at: 2_000,
        }
    }

    fn saved_query(id: &str, connection_id: &str, name: &str) -> SavedQuery {
        SavedQuery {
            id: id.to_string(),
            connection_id: connection_id.to_string(),
            name: name.to_string(),
            sql: "SELECT * FROM tracks".into(),
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    fn exported_conn(id: &str, name: &str) -> ExportedDbConnection {
        ExportedDbConnection {
            id: id.into(),
            name: name.into(),
            engine: "postgres".into(),
            host: "db.internal".into(),
            port: Some(5432),
            database: "maestro".into(),
            user: "ro".into(),
            password_ref: "{{PG_PASSWORD}}".into(),
            srv: false,
            ssl_mode: "prefer".into(),
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
            url: None,
            options: Default::default(),
        }
    }

    /// `contents` with `referencedVariables` filled in the way a real export would.
    fn with_refs(mut contents: BundleContents) -> BundleContents {
        contents.referenced_variables = bundle::referenced_variables(&contents);
        contents
    }

    /// Build a bundle **without** recomputing `referencedVariables`, so a test can hand it a list
    /// that lies.
    fn make_bundle(
        mode: BundleMode,
        label: &str,
        contents: BundleContents,
        passphrase: Option<&str>,
        iterations: u32,
    ) -> Bundle {
        let header = BundleHeader {
            kind: BUNDLE_KIND.to_string(),
            version: BUNDLE_VERSION,
            mode,
            created_at_ms: 1_785_000_000_000,
            app: APP.to_string(),
            label: label.to_string(),
            counts: counts_of(&contents),
        };
        match mode {
            BundleMode::Structure => Bundle {
                header,
                contents: Some(contents),
                sealed: None,
            },
            BundleMode::Sealed => {
                let plaintext = serde_json::to_vec(&contents).expect("serialise");
                let payload = seal::seal(
                    passphrase.expect("a sealed fixture needs a passphrase"),
                    &bundle::canonical_header(&header),
                    &plaintext,
                    iterations,
                )
                .expect("seal");
                Bundle {
                    header,
                    contents: None,
                    sealed: Some(payload),
                }
            }
        }
    }

    fn write_json(path: &Path, file: &Bundle) {
        std::fs::write(path, serde_json::to_string_pretty(file).expect("serialise"))
            .expect("write the fixture bundle");
    }

    /// A structure bundle at `name`, returning its path.
    fn structure_at(f: &Fixture, name: &str, contents: BundleContents) -> PathBuf {
        let path = f.at(name);
        write_json(
            &path,
            &make_bundle(BundleMode::Structure, "L", with_refs(contents), None, FAST),
        );
        path
    }

    /// The default choices with overrides applied — so `force_read_only` comes from
    /// [`ImportChoices::default`] and every existing test keeps testing the DEFAULT behaviour
    /// (read-only), which is what they were written to assert. The writable path has its own tests.
    fn choices(
        overrides: &[(&str, ImportAction)],
        overwrite_existing_secrets: bool,
    ) -> ImportChoices {
        ImportChoices {
            actions: overrides
                .iter()
                .map(|(k, v)| ((*k).to_string(), *v))
                .collect(),
            overwrite_existing_secrets,
            ..ImportChoices::default()
        }
    }

    fn structure_options() -> ExportOptions {
        serde_json::from_value(serde_json::json!({ "mode": "structure", "label": "Team staging" }))
            .expect("the contract's shape")
    }

    fn sealed_options(passphrase: &str) -> ExportOptions {
        serde_json::from_value(serde_json::json!({
            "mode": "sealed", "label": "Team staging", "passphrase": passphrase
        }))
        .expect("the contract's shape")
    }

    /// A Vault + collections holding real secrets, in the three places a bundle could leak one:
    /// an environment value, a header, and a request body.
    fn vault_with_secrets() -> ApiStore {
        ApiStore {
            collections: vec![SavedRequest {
                id: "req-1".into(),
                name: "Charge".into(),
                method: "POST".into(),
                url: "https://api.stripe.com/v1/charges".into(),
                headers: vec![
                    // The Vault's own value, pasted literally — caught by the EXACT sweep.
                    HttpHeader {
                        name: "Authorization".into(),
                        value: format!("Bearer {HOSTILE}"),
                    },
                    // A credential the Vault has never seen — only the HEURISTIC can catch it.
                    HttpHeader {
                        name: "X-Api-Key".into(),
                        value: UNKNOWN_TOKEN.to_string(),
                    },
                    // Neither: it must survive untouched, or the redactor is shredding the file.
                    HttpHeader {
                        name: "Accept".into(),
                        value: "application/json".into(),
                    },
                ],
                body: format!("{{\"token\":\"{HOSTILE}\",\"amount\":100}}"),
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
                    key: "STRIPE_KEY".into(),
                    value: HOSTILE.to_string(),
                }],
            }],
            active_environment_id: Some("env-1".into()),
            folders: Vec::new(),
        }
    }

    /* ══════════════════ 1. structure mode emits no secret value ══════════════════ */

    /// 🔴 **The feature's central promise**, asserted against the file's raw bytes rather than the
    /// returned header — they are produced by different code.
    ///
    /// Falsified three ways, each watched go red before being restored:
    /// * `value: if sealed { … } else { None }` → `Some(v.value.clone())` gave
    ///   `the raw form of the secret is in the exported bundle`.
    /// * dropping the exact sweep from `export_request` left the secret in the body.
    /// * dropping `redact_header_value` left `UNKNOWN_TOKEN` in the `X-Api-Key` header.
    #[test]
    fn a_structure_export_writes_no_secret_value_in_any_spelling() {
        let f = Fixture::new("structure-no-secret");
        f.seed_vault(&vault_with_secrets());
        let dest = f.at("bundle.json");

        let header = export(&f.paths, &structure_options(), &dest).expect("export");
        let text = f.text(&dest);

        assert_no_spelling_of(HOSTILE, &text, "the exported bundle");
        assert!(
            !text.contains(UNKNOWN_TOKEN),
            "a literal-looking credential on a sensitive header survived:\n{text}"
        );
        // The header must agree with the file: zero secret values, by construction.
        assert_eq!(header.counts.secret_values, 0);
        assert_eq!(header.counts.environments, 1);
        assert_eq!(header.mode, BundleMode::Structure);

        // The variable's NAME survives — that is the whole point of `structure` mode — and its
        // value is `null`, which the contract distinguishes from `""`.
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
        let vars = &parsed["contents"]["environments"][0]["variables"];
        assert_eq!(vars[0]["key"], "STRIPE_KEY");
        assert_eq!(vars[0]["value"], serde_json::Value::Null);

        // Both redacted headers say so loudly rather than emptily, so an imported request fails
        // at send time instead of returning a confusing 401.
        let headers = &parsed["contents"]["apiRequests"][0]["headers"];
        assert_eq!(headers[0]["value"], REDACTED_PLACEHOLDER);
        assert_eq!(headers[1]["value"], REDACTED_PLACEHOLDER);
        // …and the innocent header is untouched: the redactor must not shred the file.
        assert_eq!(headers[2]["name"], "Accept");
        assert_eq!(headers[2]["value"], "application/json");
        // The body keeps its non-secret fields.
        let body = parsed["contents"]["apiRequests"][0]["body"]
            .as_str()
            .expect("a body");
        assert!(body.contains("\"amount\":100"), "{body}");
        assert!(body.contains(REDACTED_PLACEHOLDER), "{body}");

        // And the placeholder is never read back as a variable to supply.
        let refs = parsed["contents"]["referencedVariables"]
            .as_array()
            .expect("an array");
        assert!(
            refs.iter().all(|v| v.as_str() != Some("REDACTED")),
            "{refs:?}"
        );
        for v in refs {
            assert!(
                !v.as_str().unwrap_or_default().contains(' '),
                "the placeholder leaked into referencedVariables: {refs:?}"
            );
        }
    }

    /// A `db-connections.json` that a person hand-edited can hold a literal where a `{{VAR}}`
    /// belongs. Export must not carry it, in either mode.
    #[test]
    fn a_literal_password_ref_in_the_store_is_never_exported() {
        for options in [structure_options(), sealed_options(PASS)] {
            let f = Fixture::new("literal-ref");
            f.seed_connections(vec![DbConnection {
                url: Some(format!(
                    "postgresql://ro:{HOSTILE}@db.internal:5432/maestro"
                )),
                ..conn("c1", "Prod", HOSTILE)
            }]);
            let dest = f.at("bundle.json");
            export(&f.paths, &options, &dest).expect("export");
            assert_no_spelling_of(HOSTILE, &f.text(&dest), "the exported bundle");
        }
    }

    /* ══════════════════ 2. sealed mode, end to end ══════════════════ */

    /// The one test that pays for the **shipped** 600 000 rounds, so the constant that actually
    /// ships is proven through the real command path rather than only in `seal.rs`.
    #[test]
    fn a_sealed_export_uses_the_shipped_iteration_count_and_writes_no_plaintext() {
        let f = Fixture::new("sealed-real");
        f.seed_vault(&vault_with_secrets());
        let dest = f.at("bundle.json");

        let header = export(&f.paths, &sealed_options(PASS), &dest).expect("export");
        assert_eq!(header.mode, BundleMode::Sealed);
        assert_eq!(
            header.counts.secret_values, 1,
            "a sealed bundle carries values"
        );

        let text = f.text(&dest);
        assert_no_spelling_of(HOSTILE, &text, "a sealed bundle");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(parsed["sealed"]["kdf"]["iterations"], 600_000);
        assert_eq!(parsed["sealed"]["kdf"]["algorithm"], "pbkdf2-hmac-sha256");
        assert_eq!(parsed["sealed"]["aead"]["algorithm"], "aes-256-gcm");
        assert!(
            parsed.get("contents").is_none(),
            "a sealed bundle must not also carry cleartext contents: {text}"
        );

        // …and it opens on another machine, delivering the value.
        let recipient = Fixture::new("sealed-real-in");
        let plan = inspect(&recipient.paths, &dest, Some(PASS)).expect("inspect");
        assert!(plan.unsealed);
        let result =
            import(&recipient.paths, &dest, Some(PASS), &choices(&[], false)).expect("import");
        assert_eq!(result.created.variables, 1);
        assert_eq!(
            recipient.vault_value("STRIPE_KEY").as_deref(),
            Some(HOSTILE),
            "the sealed value must arrive byte-for-byte, or nothing works"
        );
    }

    /// Sealed-mode failure modes, through real files. The relabelling case is what the AEAD
    /// binding is for.
    #[test]
    fn a_sealed_file_refuses_a_wrong_passphrase_a_tampered_body_and_a_relabelled_header() {
        let f = Fixture::new("sealed-refuse");
        let contents = with_refs(BundleContents {
            environments: vec![ExportedEnvironment {
                id: "e1".into(),
                name: "prod".into(),
                variables: vec![ExportedVariable {
                    key: "K".into(),
                    value: Some(HOSTILE.to_string()),
                }],
            }],
            ..Default::default()
        });
        let good = f.at("good.json");
        write_json(
            &good,
            &make_bundle(
                BundleMode::Sealed,
                "Team staging",
                contents,
                Some(PASS),
                FAST,
            ),
        );
        // The fixture itself opens — otherwise every assertion below is vacuous.
        assert!(
            inspect(&f.paths, &good, Some(PASS))
                .expect("inspect")
                .unsealed
        );

        // (a) The wrong passphrase **rejects**, from both commands. One failure, one shape: a
        //     resolved `unsealed: false` plan would be indistinguishable from a bundle that
        //     genuinely contains nothing.
        for who in ["inspect", "import"] {
            let err = if who == "inspect" {
                inspect(&f.paths, &good, Some("wrong passphrase!!")).expect_err("must reject")
            } else {
                import(
                    &f.paths,
                    &good,
                    Some("wrong passphrase!!"),
                    &choices(&[], false),
                )
                .expect_err("must reject")
            };
            assert_eq!(
                err.code,
                PortErrorCode::BadPassphrase,
                "{who}: {}",
                err.message
            );
        }
        // …and with no passphrase at all, `inspect` describes the file honestly instead — the ONE
        // case `unsealed: false` covers.
        let blind = inspect(&f.paths, &good, None).expect("inspect");
        assert!(!blind.unsealed);
        assert!(
            blind.items.is_empty(),
            "nothing may be planned from a file that was not opened"
        );
        assert_eq!(
            blind.header.counts.secret_values, 1,
            "counts are readable without opening"
        );
        assert!(
            blind.variables.is_empty(),
            "names are NOT readable without opening"
        );
        // Import may not treat that state as success.
        assert_eq!(
            import(&f.paths, &good, None, &choices(&[], false))
                .expect_err("import needs the passphrase")
                .code,
            PortErrorCode::BadPassphrase
        );

        // (b) A tampered ciphertext.
        let mut raw: serde_json::Value = serde_json::from_str(&f.text(&good)).expect("json");
        let ct = raw["sealed"]["ciphertextB64"].as_str().unwrap().to_string();
        let mut bytes = ct.into_bytes();
        // Flip a base64 character to something else in the same alphabet.
        bytes[3] = if bytes[3] == b'A' { b'B' } else { b'A' };
        raw["sealed"]["ciphertextB64"] =
            serde_json::Value::String(String::from_utf8(bytes).unwrap());
        let tampered = f.at("tampered.json");
        std::fs::write(&tampered, raw.to_string()).unwrap();
        let err = inspect(&f.paths, &tampered, Some(PASS))
            .expect_err("a tampered ciphertext must not open");
        // `bad-passphrase`, not `tampered`: AES-GCM's tag check cannot tell a wrong key from
        // flipped bytes, and inventing the distinction would be a lie about what was measured.
        assert_eq!(err.code, PortErrorCode::BadPassphrase, "{}", err.message);

        // (c) 🔴 A **relabelled** header. The ciphertext is byte-identical; only `label` changed.
        //     Falsified by replacing the AAD with `Aad::empty()` in `seal.rs`, which made this
        //     assertion fail with `a relabelled bundle must not open`.
        let mut relabelled_json: serde_json::Value =
            serde_json::from_str(&f.text(&good)).expect("json");
        relabelled_json["label"] = serde_json::Value::String("Harmless notes".into());
        let relabelled = f.at("relabelled.json");
        std::fs::write(&relabelled, relabelled_json.to_string()).unwrap();
        assert_eq!(
            inspect(&f.paths, &relabelled, Some(PASS))
                .expect_err("a relabelled bundle must not open")
                .code,
            PortErrorCode::BadPassphrase
        );
        assert_eq!(
            import(&f.paths, &relabelled, Some(PASS), &choices(&[], false))
                .expect_err("import must refuse a relabelled bundle")
                .code,
            PortErrorCode::BadPassphrase
        );
        // The ciphertext is byte-identical to the one that DOES open, so the refusal is the AAD
        // binding and nothing else.
        let a: serde_json::Value = serde_json::from_str(&f.text(&good)).unwrap();
        let b: serde_json::Value = serde_json::from_str(&f.text(&relabelled)).unwrap();
        assert_eq!(a["sealed"], b["sealed"], "only `label` may differ");
    }

    #[test]
    fn a_sealed_export_needs_a_passphrase_and_a_structure_export_refuses_one() {
        let f = Fixture::new("options");
        let dest = f.at("b.json");

        let no_pass: ExportOptions =
            serde_json::from_value(serde_json::json!({"mode":"sealed","label":""})).unwrap();
        assert_eq!(
            export(&f.paths, &no_pass, &dest)
                .expect_err("must refuse")
                .code,
            PortErrorCode::WeakPassphrase
        );
        // The floor is enforced in Rust, not only in the dialog.
        assert_eq!(
            export(&f.paths, &sealed_options("short"), &dest)
                .expect_err("must refuse")
                .code,
            PortErrorCode::WeakPassphrase
        );
        // "Rejected otherwise": silently ignoring a passphrase would hand the user a file they
        // believe is encrypted and is not.
        let stray: ExportOptions = serde_json::from_value(
            serde_json::json!({"mode":"structure","label":"","passphrase": PASS}),
        )
        .unwrap();
        assert!(export(&f.paths, &stray, &dest).is_err());
        assert!(!dest.exists(), "a refused export must write nothing");
    }

    /* ══════════════════ 3. inspect writes nothing ══════════════════ */

    /// 🔴 The contract calls `portability_inspect` a **dry run**. Measured over every file in the
    /// fixture directory, so a stray `.tmp` from a half-finished write would fail it too.
    #[test]
    fn inspect_writes_nothing_even_for_a_wrong_passphrase() {
        let f = Fixture::new("inspect-ro");
        f.seed_vault(&vault_with_secrets());
        f.seed_connections(vec![conn("c1", "Prod", "{{STRIPE_KEY}}")]);
        f.seed_queries(vec![saved_query("q1", "c1", "Tracks")]);

        let contents = with_refs(BundleContents {
            db_connections: vec![exported_conn("c9", "Theirs")],
            environments: vec![ExportedEnvironment {
                id: "e9".into(),
                name: "theirs".into(),
                variables: vec![ExportedVariable {
                    key: "THEIR_KEY".into(),
                    value: Some("their-value".into()),
                }],
            }],
            ..Default::default()
        });
        let structure = f.at("structure.json");
        write_json(
            &structure,
            &make_bundle(BundleMode::Structure, "L", contents.clone(), None, FAST),
        );
        let sealed = f.at("sealed.json");
        write_json(
            &sealed,
            &make_bundle(BundleMode::Sealed, "L", contents, Some(PASS), FAST),
        );

        let before = f.snapshot();
        // Every route through `inspect`, including the ones that would be tempting to cache and
        // the failing ones — a rejection must not leave a half-written anything behind either.
        inspect(&f.paths, &structure, None).expect("structure");
        inspect(&f.paths, &sealed, Some(PASS)).expect("sealed, right passphrase");
        inspect(&f.paths, &sealed, Some("definitely wrong")).expect_err("wrong passphrase rejects");
        inspect(&f.paths, &sealed, None).expect("sealed, no passphrase");
        inspect(&f.paths, &f.at("nope.json"), None).expect_err("a missing file");
        assert_eq!(
            f.snapshot(),
            before,
            "portability_inspect must not write a single byte"
        );

        // The negative half: `import` on the same file DOES write, so the equality above is a
        // property of `inspect` and not of a fixture nothing could ever change.
        import(&f.paths, &structure, None, &choices(&[], false)).expect("import");
        assert_ne!(f.snapshot(), before, "import must actually write something");
    }

    /* ══════════════════ 4. guardrails re-applied on import ══════════════════ */

    /// 🔴 Imported connections are read-only, the guardrail most likely to be "simplified" away
    /// later — now a **default** rather than a forced value. This test asserts the
    /// default path, which is the one nobody chooses explicitly and therefore the one that matters
    /// most; `the_importer_may_choose_writable_and_the_report_says_so` covers the override.
    ///
    /// Falsified by changing `read_only` to `src.read_only` in `materialise_connection`, which
    /// failed with `an imported connection is read-only by default`.
    #[test]
    fn an_imported_connection_is_read_only_by_default_whatever_the_bundle_says() {
        let f = Fixture::new("forced-ro");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![ExportedDbConnection {
                    read_only: false,
                    allow_multi_statement: true,
                    ..exported_conn("c1", "Prod")
                }],
                ..Default::default()
            },
        );

        let result = import(&f.paths, &path, None, &choices(&[], false)).expect("import");
        let stored = f.connections();
        assert_eq!(stored.len(), 1);
        assert!(
            stored[0].read_only,
            "an imported connection is read-only by default"
        );
        assert!(
            result
                .notices
                .iter()
                .any(|n| n.contains("read-only") && n.contains("Prod")),
            "the report must SAY so: {:?}",
            result.notices
        );
        // The rest of the record survives, so "forced read-only" is not a stand-in for "ignored".
        assert!(stored[0].allow_multi_statement);
        assert_eq!(stored[0].host, "db.internal");
        assert_eq!(
            stored[0].family,
            DbFamily::Postgres,
            "denormalised from the descriptor"
        );
        // And the plan said the same thing before anything was written.
        let plan = inspect(&f.paths, &path, None).expect("inspect");
        assert!(plan.notices.iter().any(|n| n.contains("read-only")));
    }

    /// 🔴 **The amendment: enforced but OPTIONAL.** The importer is a person looking at a
    /// review screen, and refusing to let them say "yes, I do want this writable" is the app
    /// deciding for them.
    ///
    /// What this pins is both halves: the record really is writable, and the report **says so** —
    /// because a writable import that looked identical to a read-only one would be the worst of the
    /// three possible behaviours.
    #[test]
    fn the_importer_may_choose_writable_and_the_report_says_so() {
        let f = Fixture::new("optional-ro");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![ExportedDbConnection {
                    read_only: false,
                    ..exported_conn("c1", "Prod")
                }],
                ..Default::default()
            },
        );

        let writable = ImportChoices {
            force_read_only: false,
            ..ImportChoices::default()
        };
        let result = import(&f.paths, &path, None, &writable).expect("import");
        let stored = f.connections();
        assert!(
            !stored[0].read_only,
            "the importer chose writable, so the record must be writable"
        );
        assert!(
            result
                .notices
                .iter()
                .any(|n| n.contains("writable") && n.contains("Prod")),
            "a writable import must be RECORDED, not silent: {:?}",
            result.notices
        );
    }

    /// 🔴 **A bundle that says read-write does NOT become writable just because the flag is off.**
    ///
    /// The flag means "make imported connections read-only"; with it off, the *bundle's* value is
    /// honoured — so a sharer who exported a read-only connection still hands over a read-only one.
    /// Turning the toggle off must not silently promote every connection to writable.
    #[test]
    fn turning_the_flag_off_honours_the_bundle_rather_than_forcing_writable() {
        let f = Fixture::new("ro-bundle");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                // The sharer's own connection was read-only.
                db_connections: vec![exported_conn("c1", "Reader")],
                ..Default::default()
            },
        );
        assert!(
            exported_conn("c1", "Reader").read_only,
            "the fixture's premise: this bundle says read-only"
        );

        let writable = ImportChoices {
            force_read_only: false,
            ..ImportChoices::default()
        };
        import(&f.paths, &path, None, &writable).expect("import");
        assert!(
            f.connections()[0].read_only,
            "the bundle said read-only, so it stays read-only"
        );
    }

    /// 🔴 **An absent `forceReadOnly` deserialises to `true`.**
    ///
    /// The struct is `#[serde(default)]`, so without the explicit `default = "read_only_by_default"`
    /// a missing field would be `false` — and an older frontend, or any hand-written IPC call, would
    /// silently import **writable** connections. The safe value must be the one that appears when
    /// nobody said anything, and that is a property of the deserialiser, so it is tested there.
    #[test]
    fn an_absent_force_read_only_field_deserialises_to_read_only() {
        let from_empty: ImportChoices = serde_json::from_str("{}").expect("empty object");
        assert!(from_empty.force_read_only, "absent must mean read-only");
        assert!(
            !from_empty.overwrite_existing_secrets,
            "absent means do not overwrite"
        );

        let only_actions: ImportChoices =
            serde_json::from_str(r#"{"actions":{},"overwriteExistingSecrets":true}"#)
                .expect("older frontend's payload");
        assert!(
            only_actions.force_read_only,
            "an older frontend that does not know the field still gets read-only"
        );

        // And an explicit `false` is honoured — the whole point of the amendment.
        let explicit: ImportChoices =
            serde_json::from_str(r#"{"forceReadOnly":false}"#).expect("explicit");
        assert!(!explicit.force_read_only);

        // `Default` agrees with the serde default. These are two different code paths (the impl and
        // the attribute), and a divergence would make the safe value depend on which one ran.
        assert!(ImportChoices::default().force_read_only);
    }

    /// An engine one row of the file names and this build does not know is a **skipped item**,
    /// not a failed import: a newer sharer's Cassandra row must not cost the recipient their
    /// Postgres one.
    #[test]
    fn an_unknown_engine_is_a_skipped_item_rather_than_a_failed_import() {
        let f = Fixture::new("unknown-engine");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![
                    ExportedDbConnection {
                        engine: "cassandra".into(),
                        ..exported_conn("c1", "Wide column")
                    },
                    exported_conn("c2", "Prod PG"),
                ],
                ..Default::default()
            },
        );

        let plan = inspect(&f.paths, &path, None).expect("inspect");
        let skipped: Vec<&ImportItem> = plan
            .items
            .iter()
            .filter(|i| i.action == ImportAction::Skip)
            .collect();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].id, "dbConnection:c1");
        assert!(
            skipped[0].reason.contains("cassandra"),
            "{}",
            skipped[0].reason
        );

        let result =
            import(&f.paths, &path, None, &choices(&[], false)).expect("import must succeed");
        assert_eq!(result.created.db_connections, 1);
        assert_eq!(result.skipped.db_connections, 1);
        assert_eq!(f.connections().len(), 1);
        assert_eq!(f.connections()[0].id, "c2");

        // …and a per-item override cannot conjure it into existence: the choice is whether to
        // take what was offered, not a way to take what was never on offer.
        let forced = import(
            &f.paths,
            &path,
            None,
            &choices(&[("dbConnection:c1", ImportAction::Create)], false),
        )
        .expect("import");
        assert_eq!(forced.skipped.db_connections, 1);
        assert!(f.connections().iter().all(|c| c.id != "c1"));
    }

    #[test]
    fn numeric_fields_are_clamped_the_way_upsert_bounds_them() {
        let f = Fixture::new("clamp");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![ExportedDbConnection {
                    port: Some(-1),
                    row_limit: 99_999_999_999,
                    timeout_ms: 0,
                    ssl_mode: "not-a-mode".into(),
                    ..exported_conn("c1", "Prod")
                }],
                ..Default::default()
            },
        );
        import(&f.paths, &path, None, &choices(&[], false)).expect("import");
        let stored = &f.connections()[0];
        assert_eq!(stored.port, Some(5432), "PostgreSQL's default port");
        assert_eq!(stored.row_limit, engines::MAX_ROW_LIMIT);
        assert_eq!(stored.timeout_ms, engines::MIN_TIMEOUT_MS);
        assert_eq!(stored.ssl_mode, SslMode::Prefer, "the engine's default");

        // A record that arrives inside the bounds is left exactly alone, so the clamp is a
        // correction and not a reset.
        let ok = structure_at(
            &f,
            "ok.json",
            BundleContents {
                db_connections: vec![ExportedDbConnection {
                    port: Some(6543),
                    row_limit: 250,
                    timeout_ms: 9_000,
                    ssl_mode: "verify-full".into(),
                    ..exported_conn("c2", "Pooler")
                }],
                ..Default::default()
            },
        );
        import(&f.paths, &ok, None, &choices(&[], false)).expect("import");
        let kept = f
            .connections()
            .into_iter()
            .find(|c| c.id == "c2")
            .expect("c2");
        assert_eq!(
            (kept.port, kept.row_limit, kept.timeout_ms),
            (Some(6543), 250, 9_000)
        );
        assert_eq!(kept.ssl_mode, SslMode::VerifyFull);
    }

    /// A hand-written bundle must not be able to put a plaintext password into
    /// `db-connections.json` — the one thing that file guarantees it never holds.
    #[test]
    fn a_literal_password_ref_or_url_credential_is_discarded_on_import() {
        let f = Fixture::new("import-literal");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![ExportedDbConnection {
                    password_ref: HOSTILE.into(),
                    url: Some(format!(
                        "postgresql://ro:{}@db.internal:5432/maestro",
                        crate::db::url::encode_userinfo(HOSTILE)
                    )),
                    ..exported_conn("c1", "Prod")
                }],
                ..Default::default()
            },
        );
        let result = import(&f.paths, &path, None, &choices(&[], false)).expect("import");
        let stored = &f.connections()[0];
        assert_eq!(
            stored.password_ref, "",
            "a literal reference must be discarded"
        );
        assert_no_spelling_of(HOSTILE, &f.text(&f.paths.store), "db-connections.json");
        assert_no_spelling_of(HOSTILE, &f.text(&f.paths.vault), "the Vault");
        assert_eq!(
            stored.save_password,
            SavePassword::Never,
            "with no reference there is nothing in the Vault to look up"
        );
        assert!(
            result.notices.iter().any(|n| n.contains("literal")),
            "{:?}",
            result.notices
        );
    }

    #[test]
    fn option_keys_that_would_defeat_a_guarantee_are_dropped() {
        let f = Fixture::new("options-drop");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![ExportedDbConnection {
                    options: [
                        ("password".to_string(), "hunter2".to_string()),
                        ("sslmode".to_string(), "disable".to_string()),
                        ("application_name".to_string(), "mine".to_string()),
                    ]
                    .into_iter()
                    .collect(),
                    ..exported_conn("c1", "Prod")
                }],
                ..Default::default()
            },
        );
        import(&f.paths, &path, None, &choices(&[], false)).expect("import");
        let stored = &f.connections()[0];
        assert!(
            !stored.options.contains_key("password"),
            "{:?}",
            stored.options
        );
        assert!(
            !stored.options.contains_key("sslmode"),
            "{:?}",
            stored.options
        );
        assert_eq!(
            stored.options.get("application_name").map(String::as_str),
            Some("mine"),
            "an ordinary option must survive — dropping everything is not a guardrail"
        );
        assert!(!f.text(&f.paths.store).contains("hunter2"));
    }

    /* ══════════════════ 5. the plan is the security surface ══════════════════ */

    /// 🔴 The plan is the security surface. A plan with empty `hosts`/`variables` is a feature
    /// that looks finished and protects nobody.
    #[test]
    fn the_plan_names_every_host_and_variable_the_bundle_would_use() {
        let f = Fixture::new("plan-surface");
        // The recipient already holds one of the two variables — which *is* the exfiltration
        // risk: an imported request can name a key you own and point anywhere in the world.
        f.seed_vault(&ApiStore {
            environments: vec![Environment {
                id: "mine".into(),
                name: "mine".into(),
                variables: vec![EnvVar {
                    key: "PROD_STRIPE_KEY".into(),
                    value: "sk-live-mine".into(),
                }],
            }],
            active_environment_id: Some("mine".into()),
            ..Default::default()
        });

        let contents = BundleContents {
            db_connections: vec![ExportedDbConnection {
                host: "db.internal".into(),
                url: Some("postgresql://ro@replica.internal:5432/maestro".into()),
                password_ref: "{{PG_PASSWORD}}".into(),
                ..exported_conn("c1", "PG")
            }],
            api_requests: vec![ExportedApiRequest {
                id: "r1".into(),
                name: "Charge".into(),
                method: "POST".into(),
                url: "https://api.stripe.com/v1/charges".into(),
                headers: vec![ExportedHeader {
                    name: "Authorization".into(),
                    value: "Bearer {{PROD_STRIPE_KEY}}".into(),
                }],
                ..Default::default()
            }],
            environments: vec![ExportedEnvironment {
                id: "e1".into(),
                name: "prod".into(),
                variables: vec![ExportedVariable {
                    key: "PG_PASSWORD".into(),
                    value: Some("their-pw".into()),
                }],
            }],
            // 🔴 A LIE. A hostile bundle omits the variable it is about to read, hoping the
            // dialog never mentions it. The plan re-derives, so it cannot work.
            referenced_variables: Vec::new(),
            db_queries: Vec::new(),
        };
        let path = f.at("b.json");
        write_json(
            &path,
            &make_bundle(BundleMode::Structure, "L", contents, None, FAST),
        );

        let plan = inspect(&f.paths, &path, None).expect("inspect");
        assert_eq!(
            plan.hosts,
            vec!["api.stripe.com", "db.internal", "replica.internal"],
            "every host anything in the bundle would contact"
        );
        let names: Vec<&str> = plan.variables.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["PG_PASSWORD", "PROD_STRIPE_KEY"],
            "a bundle must not be able to hide a reference by omitting it from \
             `referencedVariables`"
        );
        let stripe = plan
            .variables
            .iter()
            .find(|v| v.name == "PROD_STRIPE_KEY")
            .expect("listed");
        assert!(stripe.have_locally, "the recipient already holds this one");
        assert!(!stripe.bundle_has_value);
        let pg = plan
            .variables
            .iter()
            .find(|v| v.name == "PG_PASSWORD")
            .expect("listed");
        assert!(!pg.have_locally);
        assert!(pg.bundle_has_value);

        // The negative half: an empty bundle yields empty arrays, so the values above are
        // derived and not constants.
        let empty = structure_at(&f, "empty.json", BundleContents::default());
        let none = inspect(&f.paths, &empty, None).expect("inspect");
        assert!(none.hosts.is_empty() && none.variables.is_empty() && none.items.is_empty());
    }

    /// 🔴 Incoming secrets never replace existing ones unless explicitly allowed — both ways.
    #[test]
    fn an_incoming_secret_never_replaces_an_existing_one_unless_explicitly_allowed() {
        let bundle_contents = || BundleContents {
            environments: vec![ExportedEnvironment {
                id: "e1".into(),
                name: "theirs".into(),
                variables: vec![
                    ExportedVariable {
                        key: "SHARED".into(),
                        value: Some("theirs".into()),
                    },
                    ExportedVariable {
                        key: "BRAND_NEW".into(),
                        value: Some("also-theirs".into()),
                    },
                ],
            }],
            ..Default::default()
        };
        let seed = || ApiStore {
            environments: vec![Environment {
                id: "mine".into(),
                name: "mine".into(),
                variables: vec![EnvVar {
                    key: "SHARED".into(),
                    value: "mine".into(),
                }],
            }],
            active_environment_id: Some("mine".into()),
            ..Default::default()
        };

        // (a) The default: my value stands, and a genuinely new one still lands.
        let keep = Fixture::new("secrets-keep");
        keep.seed_vault(&seed());
        let path = structure_at(&keep, "b.json", bundle_contents());
        let result = import(&keep.paths, &path, None, &choices(&[], false)).expect("import");
        assert_eq!(keep.vault_value("SHARED").as_deref(), Some("mine"));
        assert_eq!(
            keep.vault_value("BRAND_NEW").as_deref(),
            Some("also-theirs")
        );
        assert_eq!(result.skipped.variables, 1);
        assert_eq!(result.created.variables, 1);
        assert!(
            result.notices.iter().any(|n| n.contains("SHARED")),
            "{:?}",
            result.notices
        );
        // Not even an explicit per-item "update" overrides the flag: one checkbox is a
        // deliberate act, a per-row dropdown is a click.
        import(
            &keep.paths,
            &path,
            None,
            &choices(&[("variable:SHARED", ImportAction::Update)], false),
        )
        .expect("import");
        assert_eq!(keep.vault_value("SHARED").as_deref(), Some("mine"));

        // (b) With the flag on, it is replaced — and the plan said it would need this.
        let replace = Fixture::new("secrets-replace");
        replace.seed_vault(&seed());
        let path = structure_at(&replace, "b.json", bundle_contents());
        let plan = inspect(&replace.paths, &path, None).expect("inspect");
        let shared = plan
            .items
            .iter()
            .find(|i| i.id == "variable:SHARED")
            .expect("planned");
        assert_eq!(shared.action, ImportAction::Skip);
        assert!(shared.reason.contains("already have"), "{}", shared.reason);

        let result = import(&replace.paths, &path, None, &choices(&[], true)).expect("import");
        assert_eq!(replace.vault_value("SHARED").as_deref(), Some("theirs"));
        assert_eq!(result.updated.variables, 1);
    }

    /// A `structure` bundle carries variable **names** without values. Creating an empty Vault
    /// row would turn a clear `secret-missing` error naming the variable into a silent
    /// empty-password connection attempt, because `db::secret::resolve` returns `Ok("")` for a
    /// key that exists. So the name is reported and the row is not created.
    #[test]
    fn a_valueless_variable_is_reported_but_never_created_as_an_empty_row() {
        let f = Fixture::new("no-value");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                environments: vec![ExportedEnvironment {
                    id: "e1".into(),
                    name: "prod".into(),
                    variables: vec![ExportedVariable {
                        key: "PG_PASSWORD".into(),
                        value: None,
                    }],
                }],
                ..Default::default()
            },
        );
        let plan = inspect(&f.paths, &path, None).expect("inspect");
        let item = plan
            .items
            .iter()
            .find(|i| i.id == "variable:PG_PASSWORD")
            .expect("the name is still reported");
        assert_eq!(item.action, ImportAction::Skip);
        assert!(item.reason.contains("no value"), "{}", item.reason);

        // Not even an explicit override creates it — an empty row is worse than no row.
        import(
            &f.paths,
            &path,
            None,
            &choices(&[("variable:PG_PASSWORD", ImportAction::Create)], true),
        )
        .expect("import");
        assert_eq!(f.vault_value("PG_PASSWORD"), None);
        // The environment itself was created, so the recipient has somewhere to type it.
        assert!(f.vault().environments.iter().any(|e| e.id == "e1"));
    }

    /* ══════════════════ 6. idempotency and collisions ══════════════════ */

    /// 🔴 Importing the same bundle twice must UPDATE, not duplicate.
    #[test]
    fn importing_the_same_bundle_twice_updates_rather_than_duplicating() {
        let f = Fixture::new("idempotent");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![exported_conn("c1", "Prod")],
                db_queries: vec![ExportedDbQuery {
                    id: "q1".into(),
                    connection_id: "c1".into(),
                    name: "Tracks".into(),
                    sql: "SELECT 1".into(),
                }],
                api_requests: vec![ExportedApiRequest {
                    id: "r1".into(),
                    name: "Charge".into(),
                    url: "https://api.stripe.com/v1".into(),
                    ..Default::default()
                }],
                environments: vec![ExportedEnvironment {
                    id: "e1".into(),
                    name: "prod".into(),
                    variables: vec![ExportedVariable {
                        key: "K".into(),
                        value: Some("v".into()),
                    }],
                }],
                ..Default::default()
            },
        );

        let first = import(&f.paths, &path, None, &choices(&[], false)).expect("first");
        assert_eq!(first.created.db_connections, 1);
        assert_eq!(first.created.db_queries, 1);
        assert_eq!(first.created.api_requests, 1);
        assert_eq!(first.created.environments, 1);
        assert_eq!(first.created.variables, 1);

        let second = import(&f.paths, &path, None, &choices(&[], false)).expect("second");
        assert_eq!(second.created, ImportCounts::default(), "nothing was new");
        assert_eq!(second.updated.db_connections, 1);
        assert_eq!(second.updated.db_queries, 1);
        assert_eq!(second.updated.api_requests, 1);
        assert_eq!(second.updated.environments, 1);
        // The variable already has a value, and the flag is off, so it is kept — which is the
        // *correct* idempotent outcome for a secret.
        assert_eq!(second.skipped.variables, 1);

        assert_eq!(
            f.connections().len(),
            1,
            "a second import duplicated a connection"
        );
        assert_eq!(
            crate::db::queries::load(&f.paths.queries).queries.len(),
            1,
            "a second import duplicated a saved query"
        );
        assert_eq!(f.vault().collections.len(), 1);
        assert_eq!(f.vault().environments.len(), 1);
        assert_eq!(f.vault().environments[0].variables.len(), 1);

        // `createdAt` survives an update; `updatedAt` moves.
        let stored = &f.connections()[0];
        assert!(stored.updated_at >= stored.created_at);
    }

    #[test]
    fn a_name_collision_is_suffixed_rather_than_merged_into_the_recipients_record() {
        let f = Fixture::new("collision");
        f.seed_connections(vec![conn("mine", "Prod", "")]);
        f.seed_vault(&ApiStore {
            collections: vec![SavedRequest {
                id: "mine-r".into(),
                name: "Charge".into(),
                method: "GET".into(),
                url: "https://mine.example.com".into(),
                headers: vec![],
                body: String::new(),
                protocol: None,
                grpc_service: None,
                grpc_method: None,
                plaintext: None,
                folder_id: None,
            }],
            ..Default::default()
        });
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![exported_conn("theirs", "Prod")],
                api_requests: vec![ExportedApiRequest {
                    id: "theirs-r".into(),
                    name: "Charge".into(),
                    url: "https://theirs.example.com".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        );

        let result = import(&f.paths, &path, None, &choices(&[], false)).expect("import");
        let names: Vec<String> = f.connections().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["Prod", "Prod (imported)"]);
        let request_names: Vec<String> =
            f.vault().collections.into_iter().map(|r| r.name).collect();
        assert_eq!(request_names, vec!["Charge", "Charge (imported)"]);
        // The recipient's own records are untouched.
        assert_eq!(
            f.vault()
                .collections
                .iter()
                .find(|r| r.id == "mine-r")
                .map(|r| r.url.clone()),
            Some("https://mine.example.com".to_string())
        );
        assert!(
            result.notices.iter().any(|n| n.contains("(imported)")),
            "{:?}",
            result.notices
        );
    }

    /// A saved query names one server's tables, so an orphan is a query you cannot run.
    #[test]
    fn a_saved_query_whose_connection_is_absent_is_skipped_and_one_whose_connection_arrives_is_not()
    {
        let f = Fixture::new("query-follow");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![exported_conn("c1", "Prod")],
                db_queries: vec![
                    ExportedDbQuery {
                        id: "q1".into(),
                        connection_id: "c1".into(),
                        name: "Lands".into(),
                        sql: "SELECT 1".into(),
                    },
                    ExportedDbQuery {
                        id: "q2".into(),
                        connection_id: "nowhere".into(),
                        name: "Orphan".into(),
                        sql: "SELECT 2".into(),
                    },
                ],
                ..Default::default()
            },
        );
        let result = import(&f.paths, &path, None, &choices(&[], false)).expect("import");
        assert_eq!(result.created.db_queries, 1);
        assert_eq!(result.skipped.db_queries, 1);
        let stored = crate::db::queries::load(&f.paths.queries).queries;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "q1");

        // …and skipping the connection by hand takes its query with it, re-checked at apply time
        // rather than only in the plan.
        let f2 = Fixture::new("query-follow-2");
        let path2 = structure_at(
            &f2,
            "b.json",
            BundleContents {
                db_connections: vec![exported_conn("c1", "Prod")],
                db_queries: vec![ExportedDbQuery {
                    id: "q1".into(),
                    connection_id: "c1".into(),
                    name: "Lands".into(),
                    sql: "SELECT 1".into(),
                }],
                ..Default::default()
            },
        );
        let r2 = import(
            &f2.paths,
            &path2,
            None,
            &choices(&[("dbConnection:c1", ImportAction::Skip)], false),
        )
        .expect("import");
        assert_eq!(r2.skipped.db_connections, 1);
        assert_eq!(r2.skipped.db_queries, 1);
        assert!(crate::db::queries::load(&f2.paths.queries)
            .queries
            .is_empty());
    }

    /* ══════════════════ 7. reading a hostile file ══════════════════ */

    /// The ceiling is checked against the file's **length**, before a byte is parsed. The fixture
    /// is deliberately *not* JSON: a `too-large` verdict proves the size check ran first, because
    /// a parse-first implementation would have said `not-a-bundle`.
    #[test]
    fn a_file_over_the_size_ceiling_is_refused_before_it_is_parsed() {
        let f = Fixture::new("too-large");
        let path = f.at("huge.json");
        let filler = vec![b'x'; usize::try_from(MAX_BUNDLE_BYTES).unwrap() + 1];
        std::fs::write(&path, &filler).expect("write");
        let err = inspect(&f.paths, &path, None).expect_err("must be refused");
        assert_eq!(err.code, PortErrorCode::TooLarge, "{}", err.message);
        // One byte under the ceiling reaches the parser, which is what makes the check a
        // boundary and not a blanket refusal.
        std::fs::write(&path, &filler[..filler.len() - 2]).expect("write");
        assert_eq!(
            inspect(&f.paths, &path, None)
                .expect_err("still not a bundle")
                .code,
            PortErrorCode::NotABundle
        );
    }

    #[test]
    fn every_way_a_file_can_fail_to_be_a_readable_bundle_has_its_own_code() {
        let f = Fixture::new("codes");
        let cases: &[(&str, &str, PortErrorCode)] = &[
            ("junk.json", "{ this is not json", PortErrorCode::NotABundle),
            (
                "wrong-kind.json",
                r#"{"kind":"something.else","version":1}"#,
                PortErrorCode::NotABundle,
            ),
            (
                "no-kind.json",
                r#"{"version":1,"mode":"structure"}"#,
                PortErrorCode::NotABundle,
            ),
            (
                "future.json",
                r#"{"kind":"agentstudio.bundle","version":2,"mode":"structure"}"#,
                PortErrorCode::UnsupportedVersion,
            ),
            (
                "zero.json",
                r#"{"kind":"agentstudio.bundle","version":0,"mode":"structure"}"#,
                PortErrorCode::UnsupportedVersion,
            ),
            (
                "negative.json",
                r#"{"kind":"agentstudio.bundle","version":-1,"mode":"structure"}"#,
                PortErrorCode::UnsupportedVersion,
            ),
            (
                "no-mode.json",
                r#"{"kind":"agentstudio.bundle","version":1}"#,
                PortErrorCode::NotABundle,
            ),
            (
                "structure-no-contents.json",
                r#"{"kind":"agentstudio.bundle","version":1,"mode":"structure","createdAtMs":0,
                    "app":"x","label":"","counts":{}}"#,
                PortErrorCode::NotABundle,
            ),
            (
                "sealed-no-payload.json",
                r#"{"kind":"agentstudio.bundle","version":1,"mode":"sealed","createdAtMs":0,
                    "app":"x","label":"","counts":{}}"#,
                PortErrorCode::NotABundle,
            ),
        ];
        for (name, body, want) in cases {
            let path = f.at(name);
            std::fs::write(&path, body).expect("write");
            let err = inspect(&f.paths, &path, Some(PASS)).expect_err(name);
            assert_eq!(err.code, *want, "{name}: {}", err.message);
        }
        // A missing file is `io`, not `not-a-bundle`: the difference decides whether the message
        // says "pick another file" or "that file is not a bundle".
        assert_eq!(
            inspect(&f.paths, &f.at("nope.json"), None)
                .expect_err("missing")
                .code,
            PortErrorCode::Io
        );
    }

    /// An out-of-range iteration count in the file is `tampered`, not a passphrase problem — and
    /// it must be refused rather than obeyed, or the file is a one-line denial of service.
    #[test]
    fn a_denial_of_service_iteration_count_in_a_file_is_refused() {
        let f = Fixture::new("dos-iterations");
        let good = f.at("good.json");
        write_json(
            &good,
            &make_bundle(
                BundleMode::Sealed,
                "L",
                BundleContents::default(),
                Some(PASS),
                FAST,
            ),
        );
        let mut raw: serde_json::Value = serde_json::from_str(&f.text(&good)).expect("json");
        raw["sealed"]["kdf"]["iterations"] = serde_json::json!(4_000_000_000u64);
        let path = f.at("dos.json");
        std::fs::write(&path, raw.to_string()).expect("write");
        let err = inspect(&f.paths, &path, Some(PASS)).expect_err("must be refused");
        assert_eq!(err.code, PortErrorCode::Tampered, "{}", err.message);
    }

    /* ══════════════════ 8. export selection ══════════════════ */

    #[test]
    fn an_export_includes_exactly_what_was_selected_and_the_queries_that_follow_it() {
        let f = Fixture::new("selection");
        f.seed_connections(vec![conn("c1", "Kept", ""), conn("c2", "Dropped", "")]);
        f.seed_queries(vec![
            saved_query("q1", "c1", "Follows"),
            saved_query("q2", "c2", "Orphaned by the selection"),
        ]);
        f.seed_vault(&ApiStore {
            collections: vec![
                SavedRequest {
                    id: "r1".into(),
                    name: "Kept".into(),
                    method: "GET".into(),
                    url: "https://kept.example.com".into(),
                    headers: vec![],
                    body: String::new(),
                    protocol: None,
                    grpc_service: None,
                    grpc_method: None,
                    plaintext: None,
                    folder_id: None,
                },
                SavedRequest {
                    id: "r2".into(),
                    name: "Dropped".into(),
                    method: "GET".into(),
                    url: "https://dropped.example.com".into(),
                    headers: vec![],
                    body: String::new(),
                    protocol: None,
                    grpc_service: None,
                    grpc_method: None,
                    plaintext: None,
                    folder_id: None,
                },
            ],
            environments: vec![Environment {
                id: "e1".into(),
                name: "prod".into(),
                variables: vec![],
            }],
            ..Default::default()
        });

        let options: ExportOptions = serde_json::from_value(serde_json::json!({
            "mode": "structure",
            "label": "Just the one",
            "dbConnectionIds": ["c1"],
            "apiRequestIds": ["r1"],
            // An EMPTY array means none of that kind — distinct from omitting the field.
            "environmentIds": [],
        }))
        .expect("options");
        let dest = f.at("bundle.json");
        let header = export(&f.paths, &options, &dest).expect("export");
        assert_eq!(header.counts.db_connections, 1);
        assert_eq!(header.counts.api_requests, 1);
        assert_eq!(header.counts.environments, 0, "an empty array means none");
        assert_eq!(
            header.counts.db_queries, 1,
            "a saved query follows its connection — it has no id list of its own"
        );
        let text = f.text(&dest);
        assert!(text.contains("Follows"), "{text}");
        assert!(!text.contains("Orphaned"), "{text}");
        assert!(!text.contains("dropped.example.com"), "{text}");
        assert_eq!(header.label, "Just the one");
    }

    /* ══════════════════ 9. the wire contract ══════════════════ */

    #[test]
    fn the_error_wire_form_is_code_colon_detail_and_lists_only_the_contracts_codes() {
        // Literal expectations in the contract's order, not derived from the enum.
        let want: &[(PortErrorCode, &str)] = &[
            (PortErrorCode::NotABundle, "not-a-bundle"),
            (PortErrorCode::UnsupportedVersion, "unsupported-version"),
            (PortErrorCode::TooLarge, "too-large"),
            (PortErrorCode::BadPassphrase, "bad-passphrase"),
            (PortErrorCode::Tampered, "tampered"),
            (PortErrorCode::WeakPassphrase, "weak-passphrase"),
            (PortErrorCode::Io, "io"),
            (PortErrorCode::Unknown, "unknown"),
        ];
        for (code, spelling) in want {
            assert_eq!(code.as_str(), *spelling);
            // The hand-written spelling and serde's must agree, or a rejection and a serialised
            // code would describe the same failure differently.
            assert_eq!(
                serde_json::to_string(code).unwrap(),
                format!("\"{spelling}\"")
            );
        }
        assert_eq!(
            PortError::new(PortErrorCode::TooLarge, "8 MB").to_wire(),
            "too-large: 8 MB"
        );
        assert_eq!(PortError::new(PortErrorCode::Io, "").to_wire(), "io");
    }

    #[test]
    fn the_plan_and_result_serialise_to_the_contracts_camel_case_shape() {
        let f = Fixture::new("wire");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![exported_conn("c1", "Prod")],
                ..Default::default()
            },
        );
        let plan = serde_json::to_value(inspect(&f.paths, &path, None).expect("inspect")).unwrap();
        let obj = plan.as_object().expect("an object");
        for key in [
            "header",
            "unsealed",
            "items",
            "hosts",
            "variables",
            "notices",
        ] {
            assert!(obj.contains_key(key), "missing {key}: {plan}");
        }
        assert_eq!(plan["items"][0]["kind"], "dbConnection");
        assert_eq!(plan["items"][0]["action"], "create");
        assert_eq!(
            plan["items"][0]["id"], "dbConnection:c1",
            "namespaced, not bare"
        );
        assert!(plan["items"][0].get("label").is_some());
        assert!(plan["items"][0].get("reason").is_some());

        let result =
            serde_json::to_value(import(&f.paths, &path, None, &choices(&[], false)).unwrap())
                .unwrap();
        for key in ["created", "updated", "skipped", "notices"] {
            assert!(result.get(key).is_some(), "missing {key}: {result}");
        }
        assert_eq!(result["created"]["dbConnections"], 1);
        assert!(!result.to_string().contains("db_connections"));
        // `ImportCounts`, not `BundleCounts`: `variables` (written), and NOT the file-shaped
        // `secretValues`/`referencedVariables` that would make the receipt report a wrong number.
        let counts = result["created"].as_object().expect("an object");
        assert!(counts.contains_key("variables"), "{result}");
        assert!(!counts.contains_key("secretValues"), "{result}");
        assert!(!counts.contains_key("referencedVariables"), "{result}");
        assert_eq!(counts.len(), 5, "an unlisted count appeared: {result}");
    }

    #[test]
    fn a_per_item_override_reaches_the_item_it_names() {
        let f = Fixture::new("override");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![exported_conn("c1", "Taken"), exported_conn("c2", "Left")],
                ..Default::default()
            },
        );
        let result = import(
            &f.paths,
            &path,
            None,
            &choices(&[("dbConnection:c2", ImportAction::Skip)], false),
        )
        .expect("import");
        assert_eq!(result.created.db_connections, 1);
        assert_eq!(result.skipped.db_connections, 1);
        let ids: Vec<String> = f.connections().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["c1"]);
    }

    /// 🔴 The reason `ImportItem.id` is `"<kind>:<native id>"` rather than the bare record id.
    ///
    /// A variable's id is its **name** and a connection's is a ULID, so the two spaces can
    /// collide — and `ImportChoices.actions` keys on the id alone, so a collision would apply one
    /// item's decision to another with no error anywhere. Here a variable is literally *called*
    /// `c1` while a connection *has the id* `c1`, and skipping one must leave the other alone.
    ///
    /// Falsified by reverting the ids to bare (`id: src.id.clone()` / `id: key.to_string()`),
    /// which made this fail with `the connection was collateral damage`: the variable's `skip`
    /// hit the connection too.
    #[test]
    fn a_namespaced_item_id_stops_a_variable_name_from_colliding_with_a_record_id() {
        let f = Fixture::new("id-namespace");
        let path = structure_at(
            &f,
            "b.json",
            BundleContents {
                db_connections: vec![exported_conn("c1", "Prod")],
                environments: vec![ExportedEnvironment {
                    id: "c1".into(), // …and an environment sharing it, for good measure
                    name: "prod".into(),
                    variables: vec![ExportedVariable {
                        key: "c1".into(),
                        value: Some("a value".into()),
                    }],
                }],
                ..Default::default()
            },
        );

        // Every plan id is distinct despite three native ids all being `c1`.
        let plan = inspect(&f.paths, &path, None).expect("inspect");
        let ids: Vec<&str> = plan.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["dbConnection:c1", "environment:c1", "variable:c1"],
            "three native `c1`s must not share one plan key"
        );

        // Skipping the VARIABLE leaves the connection and the environment untouched.
        let result = import(
            &f.paths,
            &path,
            None,
            &choices(&[("variable:c1", ImportAction::Skip)], false),
        )
        .expect("import");
        assert_eq!(
            f.connections().len(),
            1,
            "the connection was collateral damage"
        );
        assert_eq!(result.created.db_connections, 1);
        assert_eq!(result.created.environments, 1);
        assert_eq!(result.skipped.variables, 1);
        assert_eq!(f.vault_value("c1"), None, "the variable really was skipped");
    }

    #[test]
    fn the_item_kind_spelling_is_the_same_by_hand_and_by_serde() {
        // The hand-written spelling is an ID PREFIX that travels into `ImportChoices.actions`
        // keys, and the serde one is what the frontend reads off `item.kind`. If they disagreed,
        // the UI would build a key Rust never mints. Literal expectations.
        let want: &[(ImportItemKind, &str)] = &[
            (ImportItemKind::DbConnection, "dbConnection"),
            (ImportItemKind::DbQuery, "dbQuery"),
            (ImportItemKind::ApiRequest, "apiRequest"),
            (ImportItemKind::Environment, "environment"),
            (ImportItemKind::Variable, "variable"),
        ];
        for (kind, spelling) in want {
            assert_eq!(kind.as_str(), *spelling);
            assert_eq!(
                serde_json::to_string(kind).unwrap(),
                format!("\"{spelling}\"")
            );
            assert_eq!(
                bundle::item_id(*kind, " x "),
                format!("{spelling}:x"),
                "the native id is trimmed, so a stray space cannot make a key nobody can match"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_exported_bundle_is_owner_only_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new("perms");
        let dest = f.at("bundle.json");
        export(&f.paths, &structure_options(), &dest).expect("export");
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        // Even a `structure` bundle names internal hosts, databases and variable names. NOT
        // encryption — and must not be described as such.
        assert_eq!(mode, 0o600, "mode was {mode:o}");
        assert!(!f.at("bundle.json.tmp").exists());
    }

    #[test]
    fn an_export_of_an_empty_machine_is_a_valid_bundle_that_imports_as_nothing() {
        // The degenerate case a fresh install produces. It must round-trip rather than produce a
        // file the importer chokes on.
        let f = Fixture::new("empty");
        let dest = f.at("bundle.json");
        let header = export(&f.paths, &structure_options(), &dest).expect("export");
        assert_eq!(header.counts, BundleCounts::default());
        let plan = inspect(&f.paths, &dest, None).expect("inspect");
        assert!(plan.unsealed && plan.items.is_empty());
        let result = import(&f.paths, &dest, None, &choices(&[], false)).expect("import");
        assert_eq!(result.created, ImportCounts::default());
        assert_eq!(result.skipped, ImportCounts::default());
    }
}
