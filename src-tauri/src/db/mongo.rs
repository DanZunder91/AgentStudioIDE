//! MongoDB via the official driver, one command document per run. Absent fields share `None` with
//! null, so a `notice` and the `absent` mask carry that third state. Read-only is a client-side
//! allowlist plus a `$out`/`$merge` walk. TLS trusts webpki-roots only; a configured CA is refused.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mongodb::bson::{Bson, Document};
use mongodb::error::{Error as MongoError, ErrorKind};
use mongodb::options::{
    ClientOptions, ConnectionString, Credential, ReadPreference, ReadPreferenceOptions,
    SelectionCriteria, ServerAddress, Tls, TlsOptions,
};
use mongodb::Client;
use serde::Deserialize;

use crate::db::engine::{DbEngine, DbSession, Limits, ResolvedConfig, Script, ServerInfo};
use crate::db::engines::{self, EngineSpec};
use crate::db::error::{DbError, DbErrorCode};
use crate::db::model::{DbEngineId, SslMode};
use crate::db::result::{cell_kind, DbColumn, DbResultKind, DbResultSet};
use crate::db::tree::{count_label, DbGroup, DbNode, DbNodeKind, DbNodeRef};

/// How long to wait for the dial itself when the connection does not say.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The column cap. A document family with more top-level fields than this is projected to
/// the first 64 and the rest are named in the result's `notice` — never as a 65th "+N more"
/// column, which would be a fake column whose cells could only be lies.
const MAX_COLUMNS: usize = 64;

/// How many documents `children` samples to derive a collection's field list. A collection has no
/// schema, so this is an observation and the sub-label says so ("in 3/50 sampled") rather than
/// presenting it as a declaration.
const FIELD_SAMPLE_DOCS: i64 = 50;

/// Databases MongoDB uses for its own bookkeeping — hidden from the tree.
const HIDDEN_DATABASES: &[&str] = &["admin", "local", "config"];

/// Default-deny read-only allowlist, matched exactly on the command's first key. `countDocuments`
/// is a driver helper the server rejects as unknown; kept, since that reply is a normal result.
const READ_ONLY_COMMANDS: &[&str] = &[
    "find",
    "aggregate",
    "count",
    "countDocuments",
    "distinct",
    "listCollections",
    "listDatabases",
    "listIndexes",
    "dbStats",
    "collStats",
    "explain",
    "hello",
    "buildInfo",
    "serverStatus",
];

/// Commands whose reply is a **cursor** rather than a single document, so they must go through
/// `run_cursor_command` (which follows `getMore` and kills the cursor on drop) instead of
/// `run_command` (which would read one batch and leak a server-side cursor).
const CURSOR_COMMANDS: &[&str] = &["find", "aggregate", "listCollections", "listIndexes"];

/// Document keys that write, refused structurally in read-only mode.
const WRITE_STAGES: &[&str] = &["$out", "$merge"];

/// The MongoDB engine.
pub struct MongoEngine;

impl MongoEngine {
    /// `ClientOptions` from a [`ResolvedConfig`]. A raw URL wins and is parsed by the driver as
    /// pasted (`mongodb+srv://` needs the `dns-resolver` feature).
    async fn client_options(cfg: &ResolvedConfig) -> Result<ClientOptions, DbError> {
        // See the module doc: the driver takes a PATH, and the app keeps the PEM in memory on
        // purpose. Refused rather than ignored, so the failure names its own cause.
        if cfg.ca_pem.is_some() {
            return Err(DbError::invalid_config(
                "A custom CA certificate is not supported for MongoDB yet: the driver reads the \
                 CA from a file path, and this app deliberately never re-reads a user-chosen \
                 path at connect time. Use a server whose certificate chains to a public CA, or \
                 lower the SSL mode.",
            ));
        }

        let mut opts = match &cfg.url {
            Some(url) => {
                let mut opts = options_from_connection_string(url, cfg).await?;
                fill_credential_gaps(cfg, &mut opts);
                // Fill-the-gap rule for the database: a URI without a path takes the Database
                // field, else `command_database` falls back to `admin` (see
                // `db::engine::dialled_database`).
                if opts.default_database.is_none() && !cfg.database.is_empty() {
                    opts.default_database = Some(cfg.database.clone());
                }
                opts
            }
            None => {
                // What the *form fields* say to dial. The decision is [`form_dial`], a pure
                // function, so which of the two shapes a record produces is unit-testable without a
                // resolver — see its doc for why the SRV half cannot be a `ServerAddress`.
                let mut opts = match form_dial(cfg) {
                    FormDial::Uri(uri) => options_from_connection_string(&uri, cfg).await?,
                    // `ClientOptions` is `#[non_exhaustive]` and its typed builder changes type per
                    // setter, so conditional fields are assigned on the built value.
                    FormDial::Host(address) => {
                        ClientOptions::builder().hosts(vec![address]).build()
                    }
                };
                // Common to both shapes: the credential never travels inside a URI on the form
                // path, so a resolved password cannot end up in a string that gets logged.
                if !cfg.user.is_empty() {
                    opts.credential = Some(credential(cfg));
                }
                if !cfg.database.is_empty() {
                    opts.default_database = Some(cfg.database.clone());
                }
                opts
            }
        };

        // Applied AFTER the URL branch on purpose: these are the fields the dialog owns, and a
        // pasted string that did not mention them should still get the app's timeouts.
        let connect_timeout = connect_timeout(cfg);
        opts.connect_timeout = Some(connect_timeout);
        // Without this the driver waits its own 30 s default for a server to appear, so a bad
        // host would ignore `connectTimeout` entirely and `open` would hang past the user's
        // patience. The dial timeout is the honest bound for "is anything there".
        opts.server_selection_timeout = Some(connect_timeout);
        if opts.app_name.is_none() {
            opts.app_name = non_empty(cfg, "appName").or_else(|| Some("Agent Studio".to_string()));
        }
        if opts.repl_set_name.is_none() {
            opts.repl_set_name = non_empty(cfg, "replicaSet");
        }
        if opts.direct_connection.is_none() && truthy(cfg, "directConnection") {
            opts.direct_connection = Some(true);
        }
        if opts.selection_criteria.is_none() {
            opts.selection_criteria = read_preference(cfg).map(SelectionCriteria::ReadPreference);
        }
        // The SSL ladder is for the form path only: a URL's TLS answer, even the scheme default
        // (`mongodb://` = off), reaches the driver as-is. SRV arrives TLS-on, so `require` still
        // verifies there (pinned by `an_srv_string_is_tls_enabled_by_the_driver_on_both_paths`).
        if opts.tls.is_none() && cfg.url.is_none() {
            opts.tls = Some(tls_for(cfg.ssl_mode));
        }
        Ok(opts)
    }
}

/// What the form fields (no URL) dial: an SRV seed list must become a URI string (no
/// `ServerAddress` can express it), anything else a host. Pure, so it is testable without DNS.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FormDial {
    /// A connection string — the only representation of a DNS seed list.
    Uri(String),
    /// One host and port.
    Host(ServerAddress),
}

/// [`FormDial`] for `cfg`. Pure: no DNS, no socket, no driver call.
fn form_dial(cfg: &ResolvedConfig) -> FormDial {
    if cfg.srv {
        FormDial::Uri(srv_uri(cfg))
    } else {
        FormDial::Host(ServerAddress::Tcp {
            host: cfg.host.clone(),
            // Empty port → the descriptor's 27017 via the shared helper, so every engine answers
            // alike.
            port: Some(cfg.port_or_default()),
        })
    }
}

/// The driver's `mongodb+srv://` URI for a form SRV connection: host only. No credential (it
/// travels as a [`Credential`]) and never a port; the host was validated by `url::normalise_host`.
fn srv_uri(cfg: &ResolvedConfig) -> String {
    format!("mongodb+srv://{}/", cfg.host.trim())
}

/// `ClientOptions` from a URI in two steps: `ConnectionString::parse` is pure (failure =
/// `invalid-config`); `ClientOptions::parse` does the SRV/TXT lookup (failure = network/DNS).
async fn options_from_connection_string(
    uri: &str,
    cfg: &ResolvedConfig,
) -> Result<ClientOptions, DbError> {
    let secrets = secrets_of(cfg);
    let parsed = ConnectionString::parse(uri).map_err(|e| {
        DbError::invalid_config(format!("That connection string is not usable: {e}"))
            .redacted(&secrets)
    })?;
    ClientOptions::parse(parsed)
        .await
        .map_err(|e| map_mongo_error(&e).redacted(&secrets))
}

/// Apply the User/Password fields to URI-built options only where the URI said nothing. Asks the
/// driver's own parse, the value that authenticates (sqlx engines must use `url::credential_of`).
fn fill_credential_gaps(cfg: &ResolvedConfig, opts: &mut ClientOptions) {
    match &mut opts.credential {
        // No credential in the URI at all. The condition is `user`, not `password`, and matches the
        // form path one line below in `client_options`: Mongo's mechanisms authenticate a *named*
        // account, so a credential with no username is not a thing to build.
        None => {
            if !cfg.user.is_empty() {
                opts.credential = Some(credential(cfg));
            }
        }
        // The URI built its own credential: fill only the password, never the username. A
        // username-less credential may be X.509 (`MONGODB-X509`), named by the certificate subject.
        Some(existing) => {
            if existing.password.is_none() && !cfg.password.is_empty() {
                existing.password = Some(cfg.password.clone());
            }
        }
    }
}

/// The credential block. `authSource` defaults to `admin` in the descriptor, which is where a
/// Mongo user almost always lives — including the fixture's.
fn credential(cfg: &ResolvedConfig) -> Credential {
    // `Credential::default()` rather than its typed builder, for the same reason as
    // `ClientOptions` above: each builder setter returns a different type, so the fields that are
    // only sometimes present cannot be set in a loop or behind an `if`.
    let mut credential = Credential::default();
    credential.username = Some(cfg.user.clone());
    if !cfg.password.is_empty() {
        credential.password = Some(cfg.password.clone());
    }
    credential.source = non_empty(cfg, "authSource");
    credential
}

/// Our SSL ladder → the driver's. `Require` encrypts without verifying (libpq meaning); `VerifyCa`
/// acts as `VerifyFull` (no hostname-only switch without `openssl-tls`); a stray `Prefer` encrypts.
fn tls_for(mode: SslMode) -> Tls {
    match mode {
        SslMode::Disable => Tls::Disabled,
        SslMode::Require => Tls::Enabled(
            TlsOptions::builder()
                .allow_invalid_certificates(Some(true))
                .build(),
        ),
        SslMode::Prefer | SslMode::VerifyCa | SslMode::VerifyFull => {
            Tls::Enabled(TlsOptions::builder().build())
        }
    }
}

/// `readPreference` → the driver's; `primary` is `None` (the driver default), so a URL's
/// `readPreference=` keeps working.
fn read_preference(cfg: &ResolvedConfig) -> Option<ReadPreference> {
    let options = || Some(ReadPreferenceOptions::builder().build());
    match non_empty(cfg, "readPreference")?.as_str() {
        "primaryPreferred" => Some(ReadPreference::PrimaryPreferred { options: options() }),
        "secondary" => Some(ReadPreference::Secondary { options: options() }),
        "secondaryPreferred" => Some(ReadPreference::SecondaryPreferred { options: options() }),
        "nearest" => Some(ReadPreference::Nearest { options: options() }),
        // `primary` and anything unrecognised: the descriptor's `Select` already constrains the
        // value, and an unknown string must not silently route reads somewhere else.
        _ => None,
    }
}

/// A descriptor option, or `None` when it is absent or blank.
fn non_empty(cfg: &ResolvedConfig, key: &str) -> Option<String> {
    cfg.options
        .get(key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// A `Checkbox` option's value. The dialog writes `"true"`/`""`; `"1"` is accepted because a
/// hand-edited config file and a pasted URL both use it.
fn truthy(cfg: &ResolvedConfig, key: &str) -> bool {
    matches!(
        non_empty(cfg, key).as_deref(),
        Some("true") | Some("1") | Some("yes")
    )
}

fn connect_timeout(cfg: &ResolvedConfig) -> Duration {
    cfg.options
        .get("connectTimeout")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_CONNECT_TIMEOUT)
}

fn secrets_of(cfg: &ResolvedConfig) -> Vec<&str> {
    if cfg.password.is_empty() {
        Vec::new()
    } else {
        vec![cfg.password.as_str()]
    }
}

#[async_trait]
impl DbEngine for MongoEngine {
    fn spec(&self) -> &'static EngineSpec {
        engines::spec_for(DbEngineId::Mongodb).expect("the MongoDB row exists")
    }

    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn DbSession>, DbError> {
        // `rustls` is compiled without a default provider, so any TLS config builder
        // PANICS until one is installed. `run()` does it at startup; tests and any non-Tauri
        // caller do not go through `run()`, and this is idempotent.
        crate::tls::install_crypto_provider();

        let secrets = secrets_of(cfg);
        let opts = Self::client_options(cfg).await?;
        // Read BEFORE `with_options` consumes them: this is the database that will actually be
        // dialled, which is not always the one in the Database field (`db::engine::dialled_database`).
        let dialled_database = opts.default_database.clone();
        let client =
            Client::with_options(opts).map_err(|e| map_mongo_error(&e).redacted(&secrets))?;

        let mut session = MongoSession {
            client,
            database: crate::db::engine::dialled_database(dialled_database.as_deref(), cfg),
            read_only: cfg.read_only,
            timeout_ms: cfg.timeout_ms,
            password: cfg.password.clone(),
        };
        // `Client::with_options` dials lazily: probe now so Test Connection cannot pass for a
        // missing host (and a wrong password surfaces, as Mongo authenticates on first use).
        session.probe().await?;
        Ok(Box::new(session))
    }
}

/// One live MongoDB session: a `Client` (driver-owned pool); read-only is applied per run in Rust.
struct MongoSession {
    client: Client,
    /// The database named in the connection. `""` is legal and means "no default", in which case
    /// commands run against `admin` — said out loud in [`MongoSession::command_database`].
    database: String,
    read_only: bool,
    timeout_ms: u32,
    /// Held only to redact it out of driver errors.
    password: String,
}

impl MongoSession {
    fn secrets(&self) -> Vec<&str> {
        if self.password.is_empty() {
            Vec::new()
        } else {
            vec![self.password.as_str()]
        }
    }

    /// Where a command runs. An empty `database` falls back to `admin`, which is the only
    /// database that is guaranteed to exist and is where the diagnostic commands (`buildInfo`,
    /// `serverStatus`, `listDatabases`) belong anyway.
    fn command_database(&self) -> &str {
        if self.database.is_empty() {
            "admin"
        } else {
            self.database.as_str()
        }
    }

    /// Run one validated command document. A server command error becomes a `message` result; a
    /// transport, handshake or auth failure is an `Err`.
    async fn execute(
        &self,
        statement: &str,
        command: Document,
        name: &str,
        limits: &Limits,
        db_override: Option<&str>,
    ) -> Result<Vec<DbResultSet>, DbError> {
        let started = Instant::now();
        let target = db_override.unwrap_or_else(|| self.command_database());
        let db = self.client.database(target);
        let cap = limits.row_limit as usize;
        let want = cap.saturating_add(1);
        let max_time = Duration::from_millis(u64::from(self.timeout_ms));

        if CURSOR_COMMANDS.contains(&name) {
            // Kept before the defaults are injected, so the diagnosis below reads the user's own
            // command rather than one we have rewritten.
            let command_for_target = command.clone();
            let command = with_cursor_defaults(command, want, self.timeout_ms);
            let cursor = match db
                .run_cursor_command(command)
                .batch_size(u32::try_from(want).unwrap_or(u32::MAX))
                .max_time(max_time)
                .await
            {
                Ok(cursor) => cursor,
                Err(e) => return self.outcome_of(statement, &e, limits),
            };
            let mut cursor = cursor;
            let mut docs: Vec<Document> = Vec::new();
            // `want` = cap + 1. Seeing the extra document IS the truncation signal, and
            // stopping here means the cursor is dropped — which kills it server-side — rather
            // than paged to the end and discarded.
            while docs.len() < want {
                match cursor.advance().await {
                    Ok(true) => match cursor.deserialize_current() {
                        Ok(doc) => docs.push(doc),
                        Err(e) => return self.outcome_of(statement, &e, limits),
                    },
                    Ok(false) => break,
                    Err(e) => return self.outcome_of(statement, &e, limits),
                }
            }
            let mut set = shape(
                statement,
                docs,
                limits,
                started.elapsed().as_millis() as u64,
            );
            // Mongo returns an empty cursor for a missing collection, so an empty result names the
            // database and whether the collection exists (one extra round trip, only when empty).
            if set.rows.is_empty() {
                if let Some(collection) = command_target(&command_for_target) {
                    set.notice = Some(join_notice(
                        set.notice,
                        self.empty_result_diagnosis(&collection, target).await,
                    ));
                }
            }
            Ok(vec![set])
        } else {
            let command = with_max_time(command, self.timeout_ms);
            match db.run_command(command).await {
                // A non-cursor command's reply IS a document, so it projects through exactly the
                // same rule as a row would: the union of its top-level field names, one row. That
                // is what makes `count`, `dbStats` and `buildInfo` render as a grid for free.
                Ok(reply) => {
                    let (reply, hidden) = strip_protocol_envelope(reply);
                    let mut set = shape(
                        statement,
                        vec![reply],
                        limits,
                        started.elapsed().as_millis() as u64,
                    );
                    // Never a silent drop: the fields are gone from the grid and named in the
                    // notice, so a reader can see what was removed and ask for it if they need it.
                    if !hidden.is_empty() {
                        set.notice = Some(join_notice(
                            set.notice,
                            format!(
                                "MongoDB's protocol envelope is hidden: {}. Every command reply \
                                 carries these; they say nothing about your data.",
                                hidden.join(", ")
                            ),
                        ));
                    }
                    Ok(vec![set])
                }
                Err(e) => self.outcome_of(statement, &e, limits),
            }
        }
    }

    /// Why a result is empty: the database it ran against and whether the collection exists (one
    /// `listCollections`). Best-effort: if the probe fails the database is still named.
    async fn empty_result_diagnosis(&self, collection: &str, database: &str) -> String {
        let database = database.to_string();
        let exists = self
            .client
            .database(&database)
            .list_collection_names()
            .await
            .map(|names| names.iter().any(|n| n == collection));

        match exists {
            Ok(true) => {
                format!("`{collection}` exists in database `{database}` and no document matched.")
            }
            Ok(false) => format!(
                "There is no collection `{collection}` in database `{database}` — and MongoDB \
                 answers a missing collection with an empty result rather than an error. This \
                 console runs against `{database}`; add `\"$db\": \"<database>\"` to the command to \
                 reach another one, or set the connection's Database field."
            ),
            Err(_) => format!(
                "This ran against database `{database}` — the connection's database, which is not \
                 always the one the tree is showing."
            ),
        }
    }

    /// Classify a driver failure: a server-side command error is a **result**, everything else is
    /// an error the command layer must reject with.
    fn outcome_of(
        &self,
        statement: &str,
        e: &MongoError,
        limits: &Limits,
    ) -> Result<Vec<DbResultSet>, DbError> {
        let mapped = map_mongo_error(e).redacted(&self.secrets());
        if matches!(*e.kind, ErrorKind::Command(_)) {
            return Ok(vec![DbResultSet::message(
                statement,
                mapped.message,
                limits.row_limit,
            )]);
        }
        Err(mapped)
    }

    /// Sample a collection and report each top-level field it saw. A collection has no schema, so
    /// this is an **observation**, and the sub-label says how many of the sampled documents had
    /// the field rather than implying a declaration.
    async fn collection_fields(
        &self,
        database: &str,
        collection: &str,
    ) -> Result<Vec<DbNode>, DbError> {
        let db = self.client.database(database);
        let command = mongodb::bson::doc! {
            "find": collection,
            "limit": FIELD_SAMPLE_DOCS,
            "batchSize": FIELD_SAMPLE_DOCS,
            "maxTimeMS": i64::from(self.timeout_ms),
        };
        let mut cursor = match db.run_cursor_command(command).await {
            Ok(c) => c,
            // A collection that has been dropped since the tree drew it: an empty level is the
            // honest answer, and an error toast for a node the user is merely expanding is noise
            // (the same choice every other engine's `children` makes).
            Err(e) if matches!(*e.kind, ErrorKind::Command(_)) => return Ok(Vec::new()),
            Err(e) => return Err(map_mongo_error(&e).redacted(&self.secrets())),
        };

        let mut sampled = 0usize;
        // First-seen order, with the distinct BSON type names and the presence count per field.
        let mut order: Vec<String> = Vec::new();
        let mut seen: BTreeMap<String, (Vec<String>, usize)> = BTreeMap::new();
        while sampled < FIELD_SAMPLE_DOCS as usize {
            match cursor.advance().await {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => return Err(map_mongo_error(&e).redacted(&self.secrets())),
            }
            let doc: Document = match cursor.deserialize_current() {
                Ok(d) => d,
                Err(e) => return Err(map_mongo_error(&e).redacted(&self.secrets())),
            };
            sampled += 1;
            for (key, value) in &doc {
                let entry = seen.entry(key.clone()).or_insert_with(|| {
                    order.push(key.clone());
                    (Vec::new(), 0)
                });
                entry.1 += 1;
                let type_name = bson_type_name(value).to_string();
                if !entry.0.contains(&type_name) {
                    entry.0.push(type_name);
                }
            }
        }

        Ok(order
            .into_iter()
            .map(|field| {
                let (types, present) = seen.get(&field).cloned().unwrap_or_default();
                let mut label = types.join(" | ");
                if present < sampled {
                    // The absent-vs-null distinction the RESULT GRID cannot carry does survive
                    // here, because a tree sub-label is prose rather than a cell.
                    label.push_str(&format!(" · in {present}/{sampled} sampled"));
                }
                DbNode::column(
                    database, None, collection, &field, &label,
                    // Every Mongo field is "nullable": there is no NOT NULL to report, and
                    // claiming one would be a declaration the server never made.
                    true,
                )
            })
            .collect())
    }
}

#[async_trait]
impl DbSession for MongoSession {
    async fn probe(&mut self) -> Result<ServerInfo, DbError> {
        // `buildInfo` is the only cheap command that returns the server's own version string;
        // `hello` does not carry one. Run against `admin` so it works with an empty `database`.
        let reply = self
            .client
            .database("admin")
            .run_command(mongodb::bson::doc! { "buildInfo": 1 })
            .await
            .map_err(|e| map_mongo_error(&e).redacted(&self.secrets()))?;
        let version = reply
            .get_str("version")
            .ok()
            .map(|v| format!("MongoDB {v}"))
            .unwrap_or_else(|| "MongoDB (version unavailable)".to_string());
        Ok(ServerInfo {
            version,
            // MongoDB's nearest equivalent is the `opid` of an operation, which is per *operation*
            // and needs `currentOp` privileges to read. There is nothing honest to put here, and
            // `cancel` does not read this field.
            backend_pid: None,
        })
    }

    /// Run one command document. `DbRunMode` is inert (no separator to split on); a second document
    /// is refused by [`parse_command`].
    async fn run(&mut self, script: &Script, limits: &Limits) -> Result<Vec<DbResultSet>, DbError> {
        let statement = script.text.trim().to_string();
        // Parsed as one step so BOTH failures — unreadable text and a document with no command
        // name — take the same road out. `command_name`'s borrow ends inside the closure; the
        // name is handed back owned.
        let parsed = parse_command(&script.text).and_then(|parsed| {
            let name = command_name(&parsed.command)?.to_string();
            Ok((parsed, name))
        });
        let (parsed, name) = match parsed {
            Ok(pair) => pair,
            Err(e) => return statement_outcome(&statement, e, limits),
        };
        let ParsedCommand {
            command,
            database: sql_database,
            notices: sql_notices,
        } = parsed;
        // `$db` (MongoDB's own OP_MSG field) targets another database; stripped before sending
        // because the driver adds its own and a duplicate is a protocol error.
        let (command, doc_database) = match take_db_override(command) {
            Ok(pair) => pair,
            Err(e) => return statement_outcome(&statement, e, limits),
        };
        // A SQL `FROM db.collection` and a `$db` key are the same instruction in two languages, and
        // a statement can only be one of them — so `or` here is a merge, never a precedence rule
        // someone has to remember.
        let db_override = sql_database.or(doc_database);
        if self.read_only {
            if let Some(blocked) = read_only_refusal(&command, &name) {
                return Err(blocked);
            }
        }

        let deadline = Duration::from_millis(u64::from(limits.timeout_ms));
        match tokio::time::timeout(
            deadline,
            self.execute(&statement, command, &name, limits, db_override.as_deref()),
        )
        .await
        {
            Ok(result) => result.map(|sets| attach_notices(sets, &sql_notices)),
            Err(_) => Err(DbError::new(
                DbErrorCode::Timeout,
                format!(
                    "The command exceeded this connection's {} ms timeout.",
                    limits.timeout_ms
                ),
            )),
        }
    }

    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        match node {
            // One connection sees every database it is authorised for, like MySQL and ClickHouse
            // and unlike PostgreSQL.
            DbNodeRef::Root => {
                let names = self
                    .client
                    .list_database_names()
                    .await
                    .map_err(|e| map_mongo_error(&e).redacted(&self.secrets()))?;
                Ok(names
                    .into_iter()
                    .filter(|n| !HIDDEN_DATABASES.contains(&n.as_str()))
                    .map(|name| {
                        let n = DbNode::new(
                            DbNodeRef::Database { name: name.clone() },
                            name.clone(),
                            DbNodeKind::Database,
                            true,
                        );
                        if name == self.database {
                            n.with_sub_label("connected")
                        } else {
                            n
                        }
                    })
                    .collect())
            }

            // A database holds exactly one group — its collections. Listed as a group rather than
            // inlined so the level structure matches every other engine's, which is what lets the
            // frontend's tree stay engine-agnostic.
            DbNodeRef::Database { name } => {
                let count = self
                    .client
                    .database(name)
                    .list_collection_names()
                    .await
                    .map_err(|e| map_mongo_error(&e).redacted(&self.secrets()))?
                    .len();
                Ok(vec![DbNode::new(
                    DbNodeRef::Group {
                        database: name.clone(),
                        schema: None,
                        group: DbGroup::Collections,
                    },
                    DbGroup::Collections.label(),
                    DbNodeKind::Group,
                    count > 0,
                )
                .with_sub_label(count_label(count, "collection"))])
            }

            // MongoDB has no schema level. Answered as empty rather than as an error, for the same
            // reason the other engines do: a tree that throws on an unexpected ref takes the panel
            // down and there is nothing the user can do about it.
            DbNodeRef::Schema { .. } => Ok(Vec::new()),

            DbNodeRef::Group { database, .. } => {
                let mut names = self
                    .client
                    .database(database)
                    .list_collection_names()
                    .await
                    .map_err(|e| map_mongo_error(&e).redacted(&self.secrets()))?;
                names.sort();
                Ok(names
                    .into_iter()
                    .map(|name| {
                        DbNode::new(
                            DbNodeRef::Table {
                                database: database.clone(),
                                schema: None,
                                name: name.clone(),
                            },
                            name,
                            // Not `Table`: the icon differs, and a collection is not a table.
                            DbNodeKind::Collection,
                            true,
                        )
                    })
                    .collect())
            }

            // A collection's "columns" are the sampled union of its top-level fields — the same
            // projection the results grid uses, which is the point: the tree shows what a
            // query would show.
            DbNodeRef::Table { database, name, .. } => self.collection_fields(database, name).await,

            // Both are answered by the saved-query store, never by the server — `db_children`
            // intercepts them before an engine is asked.
            DbNodeRef::SavedQueries | DbNodeRef::SavedQuery { .. } => Ok(Vec::new()),
        }
    }

    async fn close(self: Box<Self>) {
        // A graceful shutdown kills any server-side cursors this session opened, which a plain
        // drop would leave to time out after ten minutes. Bounded, because `shutdown` waits for
        // live handles and a wedged socket must not be able to hang `db_close`.
        let _ = tokio::time::timeout(Duration::from_secs(5), self.client.shutdown()).await;
    }
}

/* ────────────────────────────── parsing the command ────────────────────────────── */

/// A runnable statement: the command, where to run it, and translation notices. `database` and
/// `notices` stay empty for a hand-typed document; a SQL statement fills them.
pub struct ParsedCommand {
    pub command: Document,
    pub database: Option<String>,
    pub notices: Vec<String>,
}

/// The console's text → one BSON command, deserialised straight into a `Document` (a
/// `serde_json::Value` would sort keys; the first key is the command). `.end()` refuses extras.
fn parse_command(text: &str) -> Result<ParsedCommand, DbError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(DbError::invalid_statement("There is nothing to run."));
    }
    // SQL is translated client-side (`sqlmongo`, `docs/design/sql-to-mongo.md`). A translator
    // refusal gets one added sentence on what can be read (`invalid-statement` details render
    // verbatim).
    if looks_like_sql(trimmed) {
        return match crate::db::sqlmongo::translate(trimmed) {
            Ok(t) => Ok(ParsedCommand {
                command: t.command,
                database: t.database,
                notices: t.notices,
            }),
            Err(e) => Err(DbError::invalid_statement(format!(
                "{} This console runs `SELECT * FROM collection [WHERE …] [LIMIT n]`, translated \
                 to a MongoDB command — anything beyond that has to be written as a command \
                 document. (MongoDB itself accepts SQL only through an Atlas Data Federation \
                 instance, never a cluster.)",
                e.message
            ))),
        };
    }
    let mut de = serde_json::Deserializer::from_str(trimmed);
    let doc = Document::deserialize(&mut de).map_err(|e| {
        DbError::invalid_statement(format!(
            "That is not a MongoDB command document. A command is one JSON object whose FIRST \
             key is the command name, e.g. {{\"find\": \"tracks\", \"limit\": 10}}. ({e})"
        ))
    })?;
    de.end().map_err(|_| {
        DbError::invalid_statement(
            "There is more than one command here. MongoDB runs exactly one command document per \
             run, so send them one at a time.",
        )
    })?;
    Ok(ParsedCommand {
        command: doc,
        database: None,
        notices: Vec::new(),
    })
}

/// Put the translation's notices (e.g. `IS NULL` also matching absent fields) on the first result
/// set; Mongo runs one command per statement, so there is one.
fn attach_notices(mut sets: Vec<DbResultSet>, notices: &[String]) -> Vec<DbResultSet> {
    if notices.is_empty() {
        return sets;
    }
    if let Some(first) = sets.first_mut() {
        first.notice = Some(join_notice(first.notice.take(), notices.join(" ")));
    }
    sets
}

/// SQL keywords that begin a statement. Only the ones that START one: a `WHERE` or a `JOIN` in the
/// middle of something says nothing about what the user was trying to write.
const SQL_OPENERS: &[&str] = &[
    "select", "insert", "update", "delete", "with", "show", "describe", "explain", "create",
    "drop", "alter", "truncate", "use", "grant",
];

/// Whether this text goes to the SQL translator, decided on the leading keyword only, so a JSON
/// document whose values contain SQL words stays JSON.
fn looks_like_sql(text: &str) -> bool {
    text.split_whitespace()
        .next()
        .map(|first| SQL_OPENERS.contains(&first.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Take `$db` out of a command: the database to run it against (MongoDB's own field, so it must
/// not be sent twice). A connection with no database would otherwise send `find` to `admin`.
fn take_db_override(mut command: Document) -> Result<(Document, Option<String>), DbError> {
    let Some(value) = command.remove("$db") else {
        return Ok((command, None));
    };
    match value.as_str().map(str::trim) {
        Some(name) if !name.is_empty() => Ok((command, Some(name.to_string()))),
        _ => Err(DbError::invalid_statement(
            "`$db` has to be the name of a database, as a string — e.g. \
             {\"find\": \"tracks\", \"$db\": \"maestro\"}.",
        )),
    }
}

/// The collection a command targets: its first key's value when that is a string
/// (`{"aggregate": 1}` → `None`).
fn command_target(command: &Document) -> Option<String> {
    let (_, value) = command.iter().next()?;
    value.as_str().map(str::to_string)
}

/// Reply fields that describe the protocol, not the answer, present on every reply. `ok` is always
/// 1 here: failed commands resolve as `message` results.
const PROTOCOL_ENVELOPE: &[&str] = &["$clusterTime", "operationTime", "ok", "$db", "lsid"];

/// Drop the envelope, returning the reply and the removed names so the caller can say what it hid.
fn strip_protocol_envelope(reply: Document) -> (Document, Vec<String>) {
    let mut kept = Document::new();
    let mut hidden = Vec::new();
    for (key, value) in reply {
        if PROTOCOL_ENVELOPE.contains(&key.as_str()) {
            hidden.push(key);
        } else {
            kept.insert(key, value);
        }
    }
    // An envelope-only reply would otherwise render as a grid with no columns at all, which reads
    // as "nothing happened". Keeping `ok` back is the honest floor.
    if kept.is_empty() {
        kept.insert("ok", crate::db::mongo::Bson::Double(1.0));
        hidden.retain(|k| k != "ok");
    }
    (kept, hidden)
}

/// Join two notices without inventing punctuation when one is absent.
fn join_notice(existing: Option<String>, added: String) -> String {
    match existing {
        Some(first) if !first.is_empty() => format!("{first} {added}"),
        _ => added,
    }
}

/// The command name: the document's **first** key, which is what the server reads.
fn command_name(command: &Document) -> Result<&str, DbError> {
    command.keys().next().map(String::as_str).ok_or_else(|| {
        DbError::invalid_statement(
            "That command document is empty. The first key has to be the command name, \
             e.g. {\"find\": \"tracks\"}.",
        )
    })
}

/// A failure found before sending, resolved as a `message` result (like a Postgres syntax error)
/// so Rust's sentence reaches the user; a lost session or unusable setting still rejects.
fn statement_outcome(
    statement: &str,
    e: DbError,
    limits: &Limits,
) -> Result<Vec<DbResultSet>, DbError> {
    if e.code == DbErrorCode::InvalidStatement {
        return Ok(vec![DbResultSet::message(
            statement,
            e.message,
            limits.row_limit,
        )]);
    }
    Err(e)
}

/// Inject `maxTimeMS` (the timeout's layer 2) only when the user did not write one.
fn with_max_time(mut command: Document, timeout_ms: u32) -> Document {
    if !command.contains_key("maxTimeMS") {
        command.insert("maxTimeMS", Bson::Int64(i64::from(timeout_ms)));
    }
    command
}

/// Cursor defaults, each only if absent: `maxTimeMS`, a `batchSize` matching the row cap (a
/// transport hint, no limit added), and the `cursor` document `aggregate` requires.
fn with_cursor_defaults(command: Document, want: usize, timeout_ms: u32) -> Document {
    let mut command = with_max_time(command, timeout_ms);
    let batch = i64::try_from(want).unwrap_or(i64::MAX);
    let is_aggregate = command.keys().next().map(String::as_str) == Some("aggregate");
    if is_aggregate {
        // `aggregate` fails outright without this — "The 'cursor' option is required" — so it is
        // supplied rather than left for the user to discover.
        if !command.contains_key("cursor") {
            command.insert(
                "cursor",
                mongodb::bson::doc! { "batchSize": Bson::Int64(batch) },
            );
        }
    } else if !command.contains_key("batchSize") {
        command.insert("batchSize", Bson::Int64(batch));
    }
    command
}

/* ─────────────────────────────── the read-only guard ─────────────────────────────── */

/// The read-only refusal: a default-deny name check, then a **structural** `$out`/`$merge`
/// walk. `None` means "allowed".
fn read_only_refusal(command: &Document, name: &str) -> Option<DbError> {
    if !READ_ONLY_COMMANDS.contains(&name) {
        return Some(DbError::blocked(format!(
            "This connection is read-only, and `{name}` is not a read command. Allowed: {}. \
             Untick \"Read-only\" in the connection dialog to run writes.",
            READ_ONLY_COMMANDS.join(", ")
        )));
    }
    if let Some(stage) = find_write_stage(command) {
        return Some(DbError::blocked(format!(
            "This connection is read-only, and this pipeline contains `{stage}`, which WRITES a \
             collection. Untick \"Read-only\" in the connection dialog to run it."
        )));
    }
    None
}

/// Find a `$out`/`$merge` key at any depth. Keys, never values, on parsed BSON: a JSON-escaped `$`
/// hides from a text search, and a `"$out"` string value is a legitimate read.
fn find_write_stage(doc: &Document) -> Option<&'static str> {
    for (key, value) in doc {
        if let Some(stage) = WRITE_STAGES.iter().find(|s| *s == &key.as_str()) {
            return Some(stage);
        }
        if let Some(found) = find_write_stage_in(value) {
            return Some(found);
        }
    }
    None
}

fn find_write_stage_in(value: &Bson) -> Option<&'static str> {
    match value {
        Bson::Document(d) => find_write_stage(d),
        Bson::Array(items) => items.iter().find_map(find_write_stage_in),
        // A JavaScript body could contain anything, and we do not parse JS. It is not on the
        // read-only allowlist as a command, and `$where`/`$function` are refused with it, so
        // there is nothing to walk here.
        _ => None,
    }
}

/* ───────────────────────────────── shaping results ───────────────────────────────── */

/// Documents → one [`DbResultSet`]. Columns are the union of top-level fields in first-seen
/// order, capped at [`MAX_COLUMNS`]; `type_name` lists the BSON `$type` names seen.
fn shape(statement: &str, docs: Vec<Document>, limits: &Limits, duration_ms: u64) -> DbResultSet {
    let cap = limits.row_limit as usize;
    // Measured, not inferred: we asked for cap + 1, so more than cap means there was more.
    let truncated = docs.len() > cap;
    let docs: Vec<Document> = docs.into_iter().take(cap).collect();

    // First-seen order across every document, which is why this is a Vec and not a set.
    let mut order: Vec<String> = Vec::new();
    let mut overflow = 0usize;
    for doc in &docs {
        for key in doc.keys() {
            if order.iter().any(|k| k == key) {
                continue;
            }
            if order.len() < MAX_COLUMNS {
                order.push(key.clone());
            } else {
                overflow += 1;
            }
        }
    }

    let mut types: Vec<Vec<String>> = vec![Vec::new(); order.len()];
    let mut absent: Vec<usize> = vec![0; order.len()];
    let mut rows: Vec<Vec<Option<String>>> = Vec::with_capacity(docs.len());
    // Presence mask (`true` = field absent), so the grid paints `missing`, not NULL; built only
    // when something is absent.
    let mut mask: Vec<Vec<bool>> = Vec::with_capacity(docs.len());
    for doc in &docs {
        let mut row = Vec::with_capacity(order.len());
        let mut row_mask = Vec::with_capacity(order.len());
        for (i, field) in order.iter().enumerate() {
            match doc.get(field) {
                Some(value) => {
                    let name = bson_type_name(value).to_string();
                    if !types[i].contains(&name) {
                        types[i].push(name);
                    }
                    row.push(render_cell(value));
                    row_mask.push(false);
                }
                None => {
                    // 🔴 The state the contract cannot express **in a cell**. Counted for the notice
                    // AND masked for the grid — the cell is still `None`, because that is all a cell
                    // has, and the mask is what stops it being READ as a null.
                    absent[i] += 1;
                    row.push(None);
                    row_mask.push(true);
                }
            }
        }
        rows.push(row);
        mask.push(row_mask);
    }
    let any_absent = mask.iter().flatten().any(|m| *m);

    let columns: Vec<DbColumn> = order
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let type_name = types[i].join(" | ");
            DbColumn {
                name: name.clone(),
                // A mixed-type column gets `Unknown` (plain text), never the first type's kind;
                // `cell_kind` also maps " | " names to `Unknown`, a second defence.
                kind: match types[i].as_slice() {
                    [one] => cell_kind(one),
                    _ => crate::db::result::DbCellKind::Unknown,
                },
                type_name,
            }
        })
        .collect();

    let notice = notice_for(&order, &absent, docs.len(), overflow);

    DbResultSet {
        kind: DbResultKind::Rows,
        statement: statement.to_string(),
        columns,
        rows,
        // MongoDB's read commands report no affected count, and inventing 0 would be a number the
        // server never sent.
        rows_affected: None,
        truncated,
        row_limit: limits.row_limit,
        duration_ms,
        notice,
        absent: any_absent.then_some(mask),
    }
}

/// The result set's `notice`: the absent-field report, plus the column cap if it bit.
fn notice_for(order: &[String], absent: &[usize], total: usize, overflow: usize) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    if let Some(text) = absence_notice(order, absent, total) {
        lines.push(text);
    }
    if overflow > 0 {
        lines.push(format!(
            "{overflow} more field(s) are not shown: a result is capped at {MAX_COLUMNS} columns."
        ));
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join(" "))
    }
}

/// The notice that tells absent from null: each field and how many documents lacked it.
fn absence_notice(order: &[String], absent: &[usize], total: usize) -> Option<String> {
    let missing: Vec<String> = order
        .iter()
        .zip(absent)
        .filter(|(_, n)| **n > 0)
        .map(|(name, n)| format!("`{name}` in {n} of {total}"))
        .collect();
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "Some documents did not have every field: {}. Those cells show NULL because a result \
         cell has only two states (null / a value) while MongoDB has three (absent / null / a \
         value) — an absent field is NOT a null.",
        missing.join(", ")
    ))
}

/// One BSON value → grid text (`None` for Null). Top-level strings render bare; ObjectId, DateTime,
/// Binary, Decimal128 as inner text (Decimal128's exact digits, never an `f64`); everything else as
/// compact relaxed extended JSON.
fn render_cell(value: &Bson) -> Option<String> {
    match value {
        Bson::Null => None,
        Bson::String(s) => Some(s.clone()),
        Bson::ObjectId(oid) => Some(oid.to_hex()),
        // The exact decimal text, never a float.
        Bson::Decimal128(d) => Some(d.to_string()),
        // Subtype 0 (generic) renders as bare base64. Any other subtype keeps the
        // wrapper, because the subtype is type information — a UUID (subtype 4) shown as bare
        // base64 would be indistinguishable from a blob.
        Bson::Binary(bin) if u8::from(bin.subtype) == 0 => Some(base64_of(&bin.bytes)),
        other => {
            // In-range dates unwrap to the bare instant; out-of-range ones keep their
            // `{"$date": {"$numberLong": …}}` wrapper on purpose.
            if let Bson::DateTime(_) = other {
                let json = other.clone().into_relaxed_extjson();
                if let Some(inner) = single_string_field(&json, "$date") {
                    return Some(inner);
                }
            }
            Some(render_value(other))
        }
    }
}

/// One BSON value → compact relaxed extended JSON, walking documents itself to keep field order
/// (`into_relaxed_extjson` sorts keys without `preserve_order`). Scalars still use it.
fn render_value(value: &Bson) -> String {
    match value {
        Bson::Document(doc) => {
            let mut out = String::from("{");
            for (i, (key, v)) in doc.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&json_string(key));
                out.push(':');
                out.push_str(&render_value(v));
            }
            out.push('}');
            out
        }
        Bson::Array(items) => {
            let mut out = String::from("[");
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&render_value(v));
            }
            out.push(']');
            out
        }
        // A **nested** string keeps its quotes, unlike a top-level one: inside JSON it has to be
        // distinguishable from a number or from `null`.
        Bson::String(s) => json_string(s),
        scalar => compact(&scalar.clone().into_relaxed_extjson()),
    }
}

/// A string as a JSON string literal, escaping delegated to `serde_json` (which is where the
/// control characters, the quotes and the surrogate pairs are already right).
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"<unreadable text>\"".to_string())
}

/// Base64 of a Binary's bytes — the `$binary.base64` text, without the wrapper.
fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `{"$date": "…"}` → the inner string, for the one wrapper that unwraps to a plain instant.
fn single_string_field(json: &serde_json::Value, key: &str) -> Option<String> {
    let object = json.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.get(key)?.as_str().map(str::to_string)
}

/// Compact one-line JSON. A serialisation failure is impossible for a value that came out of
/// `into_relaxed_extjson`, so the fallback is a visible marker rather than an empty cell — an
/// unreadable value reported as NULL would be the app lying about the data.
fn compact(json: &serde_json::Value) -> String {
    serde_json::to_string(json).unwrap_or_else(|_| "<unreadable value>".to_string())
}

/// MongoDB's own `$type` spelling for a BSON value — the server's word for it, shown verbatim as
/// every engine shows its type names.
fn bson_type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::Binary(_) => "binData",
        Bson::Undefined => "undefined",
        Bson::ObjectId(_) => "objectId",
        Bson::Boolean(_) => "bool",
        Bson::DateTime(_) => "date",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::DbPointer(_) => "dbPointer",
        Bson::JavaScriptCode(_) => "javascript",
        Bson::JavaScriptCodeWithScope(_) => "javascriptWithScope",
        Bson::Symbol(_) => "symbol",
        Bson::Int32(_) => "int",
        Bson::Timestamp(_) => "timestamp",
        Bson::Int64(_) => "long",
        Bson::Decimal128(_) => "decimal",
        Bson::MinKey => "minKey",
        Bson::MaxKey => "maxKey",
    }
}

/* ─────────────────────────────── error mapping ─────────────────────────────── */

/// Driver failure kinds as data: `ErrorKind`'s struct variants are `#[non_exhaustive]` (E0639),
/// so the decision lives in [`describe`] for unit tests and [`map_mongo_error`] only routes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    /// The server rejected the credentials.
    Credentials,
    /// The TLS configuration itself is unusable.
    TlsConfig,
    /// The socket was **established** and the TLS handshake on top of it did not complete.
    TlsHandshake,
    /// DNS said no.
    Dns,
    /// No server was reachable in time.
    Unreachable,
    /// The driver reset its pool under us.
    PoolReset,
    /// A setting or a command the driver refused before sending it.
    BadSetting,
    /// A reply we could not decode.
    UnreadableReply,
    /// A command we could not encode.
    UnencodableCommand,
}

/// One [`Failure`] plus the driver's words → our code (`auth`, `network`, `tls`,
/// `invalid-config`) and a sentence.
fn describe(failure: Failure, message: &str) -> DbError {
    match failure {
        Failure::Credentials => DbError::new(
            DbErrorCode::Auth,
            format!("The server rejected those credentials. {message}"),
        ),
        Failure::TlsConfig => DbError::new(
            DbErrorCode::Tls,
            format!("The TLS settings are not usable: {message}"),
        ),
        // A handshake EOF happens after TCP connects, so host and port are fine: not `Unreachable`.
        Failure::TlsHandshake => DbError::new(
            DbErrorCode::Tls,
            format!(
                "The server was reached but did not complete a TLS handshake, so the host and the \
                 port are fine. The usual cause is that this server does not have TLS enabled: set \
                 SSL mode to Disable — or, in a pasted connection string, leave `tls=true` out. \
                 ({message})"
            ),
        ),
        Failure::Dns => DbError::new(
            DbErrorCode::Network,
            format!("That host could not be resolved: {message}"),
        ),
        // `network`, not `timeout`: a wrong host, a wrong port, a firewall and a stopped container
        // all look like this from here, and the actionable advice is about reachability. The
        // driver's own server-description detail is kept because it names which host it tried.
        Failure::Unreachable => DbError::new(
            DbErrorCode::Network,
            format!(
                "No MongoDB server could be reached — check the host, the port, and whether a \
                 VPN or firewall is in the way. ({message})"
            ),
        ),
        Failure::PoolReset => DbError::new(
            DbErrorCode::Network,
            format!("The connection pool was reset: {message}"),
        ),
        Failure::BadSetting => DbError::invalid_config(format!(
            "The connection settings or the command are not usable: {message}"
        )),
        Failure::UnreadableReply => DbError::new(
            DbErrorCode::Unknown,
            format!("The server's reply could not be read: {message}"),
        ),
        Failure::UnencodableCommand => DbError::invalid_config(format!(
            "That command could not be encoded as BSON: {message}"
        )),
    }
}

/// The TLS stack's own literals for a handshake failing on an established socket (a plaintext
/// server); the driver folds the `io::Error` into `ServerSelection`'s text. Rejections by a real
/// TLS server (alerts, bad certificates) are deliberately not matched.
const TLS_HANDSHAKE_MARKERS: &[&str] = &["tls handshake eof", "received corrupt message"];

/// Did this failure happen *inside* a TLS handshake on an established socket?
fn is_tls_handshake_failure(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    TLS_HANDSHAKE_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

/// A server-selection failure → its real [`Failure`]: unreachable only if nothing answered, TLS if
/// an accepted socket failed its handshake.
fn server_selection_failure(message: &str) -> Failure {
    if is_tls_handshake_failure(message) {
        Failure::TlsHandshake
    } else {
        Failure::Unreachable
    }
}

/// An `io::Error` → the reachability advice that fits it. Split out for the same reason
/// [`describe`] is: this is a decision, and a decision needs a test that can reach it.
fn describe_io(kind: std::io::ErrorKind, detail: &str) -> DbError {
    // A handshake failure can also arrive here unwrapped — the driver surfaces `ErrorKind::Io` for
    // a connection it was not selecting a server for. Same failure, same sentence, checked before
    // the kind table because `UnexpectedEof` alone does not say what ended the connection.
    if is_tls_handshake_failure(detail) {
        return describe(Failure::TlsHandshake, detail);
    }
    let hint = match kind {
        std::io::ErrorKind::ConnectionRefused => {
            "Nothing is listening there — check the host and the port."
        }
        std::io::ErrorKind::TimedOut => {
            "The connection attempt timed out — a firewall may be dropping it."
        }
        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => {
            "The server closed the connection. If TLS is off, the server may require it."
        }
        _ => "Check the host, the port and the network.",
    };
    DbError::new(DbErrorCode::Network, format!("{hint} ({detail})"))
}

/// A server command error → our code, keyed on the numeric code (stable across versions); the
/// server's words always survive.
fn describe_command(code: i32, message: &str) -> DbError {
    match code {
        // 13 Unauthorized · 18 AuthenticationFailed.
        13 | 18 => DbError::new(
            DbErrorCode::Auth,
            format!("That account is not allowed to do this. {message}"),
        ),
        // 50 MaxTimeMSExpired — the server's own `maxTimeMS` stopped it (the timeout's layer 2).
        50 => DbError::new(
            DbErrorCode::Timeout,
            format!("The server stopped the command at its time limit. {message}"),
        ),
        // 59 CommandNotFound · 9 FailedToParse · 40415 unknown field — "your command is wrong",
        // which is a normal console outcome and not a broken connection. (It used to map to
        // `invalid-config`, which told the user the opposite.)
        59 | 9 | 40415 => DbError::invalid_statement(message.to_string()),
        other => DbError::new(
            DbErrorCode::Unknown,
            format!("MongoDB said: {message} (code {other})"),
        ),
    }
}

/// A driver failure → our code + prose. Pure routing; the decisions are in [`describe`],
/// [`describe_io`] and [`describe_command`].
fn map_mongo_error(e: &MongoError) -> DbError {
    match &*e.kind {
        ErrorKind::Authentication { message, .. } => describe(Failure::Credentials, message),
        ErrorKind::InvalidTlsConfig { message, .. } => describe(Failure::TlsConfig, message),
        ErrorKind::DnsResolve { message, .. } => describe(Failure::Dns, message),
        ErrorKind::ServerSelection { message, .. } => {
            describe(server_selection_failure(message), message)
        }
        ErrorKind::Io(io) => describe_io(io.kind(), &io.to_string()),
        ErrorKind::ConnectionPoolCleared { message, .. } => describe(Failure::PoolReset, message),
        ErrorKind::InvalidArgument { message, .. } => describe(Failure::BadSetting, message),
        ErrorKind::Command(c) => describe_command(c.code, &c.message),
        ErrorKind::BsonDeserialization(inner) => {
            describe(Failure::UnreadableReply, &inner.to_string())
        }
        ErrorKind::BsonSerialization(inner) => {
            describe(Failure::UnencodableCommand, &inner.to_string())
        }
        ErrorKind::Bson(inner) => describe(Failure::UnencodableCommand, &inner.to_string()),
        other => DbError::new(
            DbErrorCode::Unknown,
            format!("The MongoDB driver failed: {other:?}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `parse_command` returns a [`ParsedCommand`] now that a SQL statement carries a database and
    /// notices with it. These tests are about the DOCUMENT, so they unwrap to it — the extra fields
    /// have their own tests below.
    fn parse_doc(text: &str) -> Result<Document, DbError> {
        parse_command(text).map(|p| p.command)
    }
    use mongodb::bson::{doc, oid::ObjectId, Binary, DateTime, Decimal128};

    fn limits(row_limit: u32) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn cfg() -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Mongodb,
            family: crate::db::model::DbFamily::Mongodb,
            host: "mongo.internal".into(),
            port: Some(27017),
            srv: false,
            database: "maestro".into(),
            user: "catalog_ro".into(),
            password: "s3cret-hunter2".into(),
            ssl_mode: SslMode::Require,
            ca_pem: None,
            options: BTreeMap::new(),
            url: None,
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    /// The fixture's document 1, rebuilt from `docker/db-fixtures/seed/mongo.js` — every BSON type
    /// the grid has to render, in the seed's own field order.
    fn doc1() -> Document {
        doc! {
            "_id": ObjectId::parse_str("000000000000000000000001").unwrap(),
            "title": "Amberline",
            "ensemble": "duo",
            "duration": "0.5000".parse::<Decimal128>().unwrap(),
            "tempo": 120.5_f64,
            "ok": true,
            "seq": 9_007_199_254_740_993_i64,
            "small": 7_i32,
            "flags": ["1", "2", "3"],
            "payload": { "studio": "harbor", "mix": { "gain": 0.25, "eq": { "bass": 0.5 } } },
            "raw": Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: b"Hello".to_vec() },
            "at": DateTime::parse_rfc3339_str("2026-07-29T10:00:00Z").unwrap(),
            "tag": "normal",
        }
    }

    /// Documents 2, 3 and 6 — the three states, in the seed's order.
    fn three_states() -> Vec<Document> {
        vec![
            doc! { "_id": 2_i32, "tempo": 96.25_f64, "tag": Bson::Null },
            doc! { "_id": 3_i32, "tempo": 72.75_f64, "tag": "" },
            // 6 omits `tempo` entirely, and `payload` is a real null value.
            doc! { "_id": 6_i32, "payload": Bson::Null, "tag": "json-null-vs-sql-null" },
        ]
    }

    /* ───────────────────────────── the command parser ───────────────────────────── */

    #[test]
    fn the_command_name_is_the_first_key_and_the_parser_keeps_source_order() {
        // 🔴 The whole reason this does not go through `serde_json::Value`: that type's object is
        // a BTreeMap in this tree, so `{"find": …, "filter": …}` would arrive sorted and the
        // server would be handed `filter` as the command name.
        let doc = parse_doc(r#"{"find": "tracks", "filter": {"title": "Amberline"}}"#).unwrap();
        assert_eq!(command_name(&doc).unwrap(), "find");
        let keys: Vec<&str> = doc.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["find", "filter"]);

        // And the sorted spelling is honoured as written, i.e. the parser is not "fixing" it:
        // `aggregate` first here because the user put it first.
        let doc = parse_doc(r#"{"aggregate": "t", "pipeline": [], "cursor": {}}"#).unwrap();
        assert_eq!(command_name(&doc).unwrap(), "aggregate");
    }

    #[test]
    fn extended_json_reaches_bson_so_an_object_id_can_be_addressed() {
        let doc = parse_doc(
            r#"{"find": "tracks", "filter": {"_id": {"$oid": "000000000000000000000001"}}}"#,
        )
        .unwrap();
        let filter = doc.get_document("filter").unwrap();
        assert!(
            matches!(filter.get("_id"), Some(Bson::ObjectId(_))),
            "extended JSON must become a real ObjectId: {filter:?}"
        );
        // …and `$numberDecimal` must not go through an f64 on the way in either.
        let doc =
            parse_doc(r#"{"find": "t", "filter": {"duration": {"$numberDecimal": "0.5000"}}}"#)
                .unwrap();
        let filter = doc.get_document("filter").unwrap();
        assert_eq!(
            filter.get("duration").map(|v| v.to_string()),
            Some("0.5000".to_string())
        );
    }

    #[test]
    fn a_parse_failure_is_invalid_statement_and_says_what_a_command_looks_like() {
        // `invalid-statement`, NOT `invalid-config`: SQL typed here made the frontend, which
        // maps a code to a sentence, say to check a host and port that were fine.
        for text in ["", "   ", "not json", "[1, 2, 3]", "\"find\"", "42"] {
            let err = parse_doc(text).expect_err(text);
            assert_eq!(err.code, DbErrorCode::InvalidStatement, "{text}");
            assert!(!err.message.is_empty(), "{text}");
        }
    }

    #[test]
    fn a_typed_select_is_translated_into_a_find_against_its_own_database() {
        let parsed = parse_command("select * from ARCHIVEDB.temp_playlists LIMIT 10;")
            .expect("a supported SELECT translates");
        assert_eq!(
            parsed.command,
            doc! { "find": "temp_playlists", "limit": 10_i64 }
        );
        // 🔴 The qualifier is the DATABASE, and carrying it is what fixes the empty result: a
        // connection with no database fell back to `admin`, so an unqualified find searched the
        // wrong place. `ARCHIVEDB.temp_playlists` now says where to look.
        assert_eq!(parsed.database.as_deref(), Some("ARCHIVEDB"));
        assert!(
            parsed.notices.is_empty(),
            "nothing was approximated: {:?}",
            parsed.notices
        );
    }

    #[test]
    fn a_where_and_a_missing_limit_are_both_ordinary() {
        // The scope: a WHERE clause may or may not be present, and so may a LIMIT.
        // Both shapes, and the command name stays the FIRST key.
        let bare = parse_command("select * from tracks").expect("no where, no limit");
        assert_eq!(bare.command, doc! { "find": "tracks" });
        assert_eq!(bare.database, None);

        let filtered =
            parse_command("select * from tracks where title = 'Amberline'").expect("where");
        assert_eq!(
            filtered.command,
            doc! { "find": "tracks", "filter": doc! { "title": "Amberline" } }
        );
        assert_eq!(
            filtered.command.keys().next().map(String::as_str),
            Some("find")
        );
    }

    /// A construct outside the subset is refused with **both** halves: what it could not read, and
    /// what this console can. Neither alone is an answer.
    #[test]
    fn an_unsupported_construct_is_refused_with_what_is_supported() {
        for sql in [
            "select id, name from tracks",
            "select count(*) from tracks",
            "select * from tracks order by ts",
            "select * from a join b on a.id = b.id",
            "insert into tracks values (1)",
        ] {
            let err = parse_command(sql).map(|_| ()).expect_err(sql);
            assert_eq!(err.code, DbErrorCode::InvalidStatement, "{sql}");
            assert!(
                err.message.contains("SELECT * FROM collection"),
                "the refusal must say what IS supported — {sql}: {}",
                err.message
            );
            // …and the Atlas fact survives, because "MongoDB cannot do SQL" is not quite true.
            assert!(
                err.message.contains("Data Federation"),
                "{sql}: {}",
                err.message
            );
        }
    }

    #[test]
    fn a_command_document_is_never_mistaken_for_sql() {
        // The way a leading-keyword rule breaks a working query: SQL words inside a VALUE.
        let parsed = parse_command(r#"{"find": "t", "filter": {"note": "select * from x"}}"#)
            .expect("json stays json");
        assert_eq!(
            parsed.command.keys().next().map(String::as_str),
            Some("find")
        );
        assert!(parsed.database.is_none());
        assert!(!looks_like_sql(r#"{"find": "select"}"#));
        assert!(looks_like_sql("  SELECT * FROM t"));
    }

    #[test]
    fn two_documents_are_refused_rather_than_running_the_first_one_silently() {
        // The Mongo equivalent of the multi-statement guard: there is no `;`, so the only way a
        // second command can arrive is as trailing text, and `Deserializer::end` is what sees it.
        let err = parse_doc(r#"{"find": "tracks"} {"drop": "tracks"}"#).expect_err("two");
        assert_eq!(err.code, DbErrorCode::InvalidStatement);
        assert!(err.message.contains("one command"), "{}", err.message);
    }

    #[test]
    fn an_empty_document_names_the_problem_rather_than_panicking() {
        let doc = parse_doc("{}").unwrap();
        let err = command_name(&doc).expect_err("no command name");
        assert_eq!(err.code, DbErrorCode::InvalidStatement);
    }

    #[test]
    fn a_statement_this_engine_cannot_read_resolves_as_a_message_carrying_the_sentence() {
        let limits = limits(500);
        // ⚠️ This used a SQL statement as its example of unreadable text until SQL became a
        // *supported* input and the example stopped being one. Genuinely
        // unreadable text now, which is what the test was always about.
        let text = "this is not a command document at all";
        let err = parse_doc(text).expect_err("unreadable");
        let sentence = err.message.clone();

        let sets = statement_outcome(text, err, &limits).expect("a statement problem resolves");

        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Message);
        // The statement is echoed so a script's results stay attributable, and the notice is
        // Rust's own sentence — unchanged, because the frontend renders it for this code.
        assert_eq!(sets[0].statement, text);
        assert_eq!(sets[0].notice.as_deref(), Some(sentence.as_str()));
        assert!(sets[0].rows.is_empty() && sets[0].columns.is_empty());
    }

    #[test]
    fn every_other_failure_still_rejects_rather_than_posing_as_an_answer() {
        let limits = limits(500);
        // A lost session and an unusable setting are not answers to a query, so they must not
        // arrive in the results pane looking like one.
        for e in [
            DbError::not_found("Session `x` has already been closed."),
            DbError::invalid_config("These settings are not usable."),
            DbError::blocked("This connection is read-only."),
        ] {
            let code = e.code;
            let err = statement_outcome("{\"find\": \"t\"}", e, &limits).expect_err("rejects");
            assert_eq!(err.code, code);
        }
    }

    /* ───────────────────────────── the read-only guard ───────────────────────────── */

    #[test]
    fn the_allowlist_is_default_deny_and_names_the_command_it_refused() {
        for name in [
            "drop",
            "insert",
            "update",
            "delete",
            "createIndexes",
            "eval",
            "shutdown",
        ] {
            let command = doc! { name: "tracks" };
            let err = read_only_refusal(&command, name).expect("must refuse");
            assert_eq!(err.code, DbErrorCode::Blocked, "{name}");
            assert!(
                err.message.contains(&format!("`{name}`")),
                "{name} must be quoted in the message: {}",
                err.message
            );
        }
        // Something nobody has ever heard of is refused for being unrecognised — the point of a
        // default-deny list.
        let err = read_only_refusal(&doc! { "quantumDrop": 1 }, "quantumDrop").expect("refuse");
        assert_eq!(err.code, DbErrorCode::Blocked);
    }

    #[test]
    fn every_command_the_design_allows_is_allowed() {
        // The read-only allowlist, written out literally rather than read from
        // `READ_ONLY_COMMANDS` (an expectation taken from the table under test proves only
        // plumbing).
        for name in [
            "find",
            "aggregate",
            "count",
            "countDocuments",
            "distinct",
            "listCollections",
            "listDatabases",
            "listIndexes",
            "dbStats",
            "collStats",
            "explain",
            "hello",
            "buildInfo",
            "serverStatus",
        ] {
            let command = doc! { name: 1 };
            assert!(
                read_only_refusal(&command, name).is_none(),
                "{name} is on the read-only list and must be allowed"
            );
        }
    }

    #[test]
    fn a_dollar_out_in_a_pipeline_is_refused_structurally() {
        let command =
            parse_doc(r#"{"aggregate": "tracks", "pipeline": [{"$out": "stolen"}], "cursor": {}}"#)
                .unwrap();
        let err = read_only_refusal(&command, "aggregate").expect("must refuse $out");
        assert_eq!(err.code, DbErrorCode::Blocked);
        assert!(err.message.contains("$out"), "{}", err.message);

        // `$merge` too, and nested three levels down inside a `$lookup` sub-pipeline — the case a
        // "check pipeline[i] for a top-level $out" implementation would miss.
        let nested = parse_doc(
            r#"{"aggregate": "tracks", "pipeline": [
                 {"$lookup": {"from": "cues", "pipeline": [{"$merge": {"into": "stolen"}}]}}
               ], "cursor": {}}"#,
        )
        .unwrap();
        let err = read_only_refusal(&nested, "aggregate").expect("must refuse a nested $merge");
        assert!(err.message.contains("$merge"), "{}", err.message);
    }

    /// JSON escapes hide `$out` from the text; the test first asserts the substring's absence so it
    /// stays about that.
    #[test]
    fn a_dollar_out_hidden_behind_a_json_escape_is_still_refused() {
        let text =
            r#"{"aggregate": "tracks", "pipeline": [{"\u0024out": "stolen"}], "cursor": {}}"#;
        assert!(
            !text.contains("$out"),
            "this test is only meaningful while the raw text has no `$out` in it"
        );
        let command = parse_doc(text).unwrap();
        let err = read_only_refusal(&command, "aggregate").expect("must refuse the escaped $out");
        assert_eq!(err.code, DbErrorCode::Blocked);
        assert!(err.message.contains("$out"), "{}", err.message);
    }

    /// The other half of the same point: the structural walk must not refuse a
    /// *read* whose data merely mentions `$out`. A string search refuses this one, wrongly.
    #[test]
    fn a_string_value_that_merely_mentions_dollar_out_is_not_refused() {
        let text =
            r#"{"aggregate": "tracks", "pipeline": [{"$match": {"tag": "$out"}}], "cursor": {}}"#;
        assert!(text.contains("$out"), "the text really does mention it");
        let command = parse_doc(text).unwrap();
        assert!(
            read_only_refusal(&command, "aggregate").is_none(),
            "a $out inside a string VALUE is data, not a write stage"
        );
    }

    #[test]
    fn find_write_stage_looks_at_keys_at_every_depth_and_inside_arrays() {
        assert_eq!(find_write_stage(&doc! { "$out": "x" }), Some("$out"));
        assert_eq!(
            find_write_stage(&doc! { "a": { "b": [ { "c": { "$merge": 1 } } ] } }),
            Some("$merge")
        );
        assert_eq!(
            find_write_stage(&doc! { "a": "$out", "b": ["$merge"] }),
            None
        );
        assert_eq!(find_write_stage(&doc1()), None);
    }

    /* ───────────────────────────── command defaults ───────────────────────────── */

    #[test]
    fn max_time_is_injected_only_when_the_user_did_not_write_one() {
        let injected = with_max_time(doc! { "find": "tracks" }, 7_000);
        assert_eq!(injected.get_i64("maxTimeMS").unwrap(), 7_000);

        // The user's own value wins: silently overriding it would change the query they asked for.
        let theirs = with_max_time(doc! { "find": "tracks", "maxTimeMS": 250_i64 }, 7_000);
        assert_eq!(theirs.get_i64("maxTimeMS").unwrap(), 250);
    }

    #[test]
    fn aggregate_gets_the_cursor_document_the_server_requires_and_find_gets_a_batch_size() {
        let agg = with_cursor_defaults(doc! { "aggregate": "tracks", "pipeline": [] }, 501, 30_000);
        let cursor = agg
            .get_document("cursor")
            .expect("aggregate needs `cursor`");
        assert_eq!(cursor.get_i64("batchSize").unwrap(), 501);
        // `find` takes `batchSize` at the top level instead, and gets no `cursor` field.
        let find = with_cursor_defaults(doc! { "find": "tracks" }, 501, 30_000);
        assert_eq!(find.get_i64("batchSize").unwrap(), 501);
        assert!(!find.contains_key("cursor"));
        // A user-supplied cursor/batchSize is left alone.
        let mine = with_cursor_defaults(
            doc! { "aggregate": "t", "pipeline": [], "cursor": { "batchSize": 5_i64 } },
            501,
            30_000,
        );
        assert_eq!(
            mine.get_document("cursor")
                .unwrap()
                .get_i64("batchSize")
                .unwrap(),
            5
        );
    }

    /* ───────────────────────────── cell rendering ───────────────────────────── */

    #[test]
    fn every_bson_type_in_the_fixture_renders_as_the_text_mongosh_would_print() {
        let set = shape("{}", vec![doc1()], &limits(500), 3);
        let names: Vec<&str> = set.columns.iter().map(|c| c.name.as_str()).collect();
        // First-seen order, i.e. the document's own order — not sorted.
        assert_eq!(
            names,
            vec![
                "_id", "title", "ensemble", "duration", "tempo", "ok", "seq", "small", "flags",
                "payload", "raw", "at", "tag"
            ]
        );
        let cell = |name: &str| -> Option<String> {
            let i = set.columns.iter().position(|c| c.name == name).unwrap();
            set.rows[0][i].clone()
        };
        // An ObjectId as `mongosh` prints it, not as `{"$oid": …}`.
        assert_eq!(cell("_id"), Some("000000000000000000000001".to_string()));
        // A string, bare — no quotes, or the empty-string state would be unreachable.
        assert_eq!(cell("title"), Some("Amberline".to_string()));
        assert_eq!(cell("tempo"), Some("120.5".to_string()));
        assert_eq!(cell("ok"), Some("true".to_string()));
        assert_eq!(cell("small"), Some("7".to_string()));
        // A nested document is compact one-line JSON, with nesting preserved.
        assert_eq!(
            cell("payload"),
            Some(r#"{"studio":"harbor","mix":{"gain":0.25,"eq":{"bass":0.5}}}"#.to_string())
        );
        assert_eq!(cell("flags"), Some(r#"["1","2","3"]"#.to_string()));
        // Binary subtype 0 → bare base64. "SGVsbG8=" is "Hello".
        assert_eq!(cell("raw"), Some("SGVsbG8=".to_string()));
        // A date is the server's own instant, never reformatted.
        assert_eq!(cell("at"), Some("2026-07-29T10:00:00Z".to_string()));
    }

    /// Trailing zeros (`0.5000`) survive only if the exact decimal text travels, never an `f64`.
    #[test]
    fn decimal128_keeps_its_exact_digits_and_never_becomes_a_float() {
        let set = shape("{}", vec![doc1()], &limits(500), 0);
        let i = set
            .columns
            .iter()
            .position(|c| c.name == "duration")
            .unwrap();
        assert_eq!(set.rows[0][i], Some("0.5000".to_string()));
        assert_eq!(set.columns[i].type_name, "decimal");

        // A value with more significant digits than an f64 can hold, and one an f64 cannot
        // represent at all.
        let set = shape(
            "{}",
            vec![doc! {
                "a": "123456789012345678901234.12345678".parse::<Decimal128>().unwrap(),
                "b": "0.1".parse::<Decimal128>().unwrap(),
            }],
            &limits(500),
            0,
        );
        assert_eq!(
            set.rows[0][0],
            Some("123456789012345678901234.12345678".to_string())
        );
        assert_eq!(set.rows[0][1], Some("0.1".to_string()));
    }

    #[test]
    fn a_big_int64_survives_exactly_including_the_one_mongosh_gets_wrong() {
        // 9007199254740993 is 2^53 + 1, the smallest integer an f64 cannot represent. mongosh's
        // own RELAXED extended JSON prints it as …992 (measured against the fixture); ours must
        // print the stored value.
        let set = shape("{}", vec![doc1()], &limits(500), 0);
        let i = set.columns.iter().position(|c| c.name == "seq").unwrap();
        assert_eq!(set.rows[0][i], Some("9007199254740993".to_string()));
        assert_eq!(set.columns[i].type_name, "long");
    }

    #[test]
    fn a_non_generic_binary_subtype_keeps_its_wrapper_so_a_uuid_is_not_mistaken_for_a_blob() {
        let value = Bson::Binary(Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Uuid,
            bytes: vec![0x41, 0x42],
        });
        let text = render_cell(&value).unwrap();
        assert!(text.contains("$binary"), "{text}");
        assert!(text.contains("\"subType\":\"04\""), "{text}");
        // …while the generic subtype is bare base64.
        let generic = Bson::Binary(Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: vec![0x41, 0x42],
        });
        assert_eq!(render_cell(&generic), Some("QUI=".to_string()));
    }

    #[test]
    fn a_date_outside_the_relaxed_range_keeps_its_wrapper_rather_than_being_reformatted() {
        let before_epoch = Bson::DateTime(DateTime::from_millis(-1_000));
        let text = render_cell(&before_epoch).unwrap();
        assert!(text.contains("$date"), "{text}");
        assert!(text.contains("$numberLong"), "{text}");
    }

    #[test]
    fn a_non_utf8_binary_still_renders_because_base64_cannot_fail() {
        // The fixture's document 2 has `raw: BinData(0, "AP8Q")` — deliberately not valid UTF-8.
        let value = Bson::Binary(Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: vec![0x00, 0xff, 0x10],
        });
        assert_eq!(render_cell(&value), Some("AP8Q".to_string()));
    }

    /* ─────────────────── the three states, and the honest notice ─────────────────── */

    /// Absent cannot get its own cell, so the `notice` carries it; this fails if the notice stops.
    #[test]
    fn null_empty_and_absent_are_two_cells_and_one_notice() {
        let set = shape("{}", three_states(), &limits(500), 0);
        let idx = |name: &str| set.columns.iter().position(|c| c.name == name).unwrap();
        let (tempo, tag, payload) = (idx("tempo"), idx("tag"), idx("payload"));

        // Document 2: an explicit BSON null.
        assert_eq!(set.rows[0][tag], None, "an explicit null is a NULL cell");
        // Document 3: the empty string, which must NOT collapse into null.
        assert_eq!(
            set.rows[1][tag],
            Some(String::new()),
            "the empty string must stay the empty string"
        );
        // Document 6: `tempo` is ABSENT. The cell is None — indistinguishable from a null cell…
        assert_eq!(set.rows[2][tempo], None);
        // …and `payload`'s real null is the same cell, which is exactly the collapse.
        assert_eq!(set.rows[2][payload], None);

        // …so the notice has to say so, and name what was missing.
        let notice = set
            .notice
            .clone()
            .expect("an absent field must produce a notice");
        assert!(notice.contains("`tempo` in 1 of 3"), "{notice}");
        assert!(notice.contains("`payload` in 2 of 3"), "{notice}");
        assert!(
            notice.contains("absent field is NOT a null"),
            "the notice must say what the collapse is: {notice}"
        );
    }

    #[test]
    fn a_result_with_no_absent_field_carries_no_notice() {
        // The negative control for the test above. Without it, "the notice appears"
        // could be true of every result and would prove nothing about absence.
        let set = shape("{}", vec![doc1()], &limits(500), 0);
        assert_eq!(set.notice, None, "{:?}", set.notice);
    }

    /// Literal expectations, so a change to `result::cell_kind` names the rows that moved.
    #[test]
    fn the_cell_kinds_mongos_type_names_get_are_pinned_including_the_gaps() {
        use crate::db::result::DbCellKind;
        for (type_name, want) in [
            // Right in the shared table already.
            ("double", DbCellKind::Number),
            ("int", DbCellKind::Number),
            ("decimal", DbCellKind::Number),
            ("string", DbCellKind::Text),
            ("bool", DbCellKind::Bool),
            ("date", DbCellKind::Datetime),
            ("timestamp", DbCellKind::Datetime),
            ("long", DbCellKind::Number),
            ("binData", DbCellKind::Binary),
            ("object", DbCellKind::Json),
            ("array", DbCellKind::Json),
            ("objectId", DbCellKind::Text),
            // Still `Unknown`, and correctly so: a column whose only observed type is `null`
            // says nothing about how the values that arrive next should render.
            ("null", DbCellKind::Unknown),
            // `result.rs` returns `Unknown` for any name with " | "; `shape` keeps its own guard as
            // well.
            ("int | string", DbCellKind::Unknown),
        ] {
            assert_eq!(cell_kind(type_name), want, "{type_name}");
        }
    }

    #[test]
    fn a_heterogeneous_column_gets_no_render_kind_rather_than_the_first_types() {
        // The guard the row above exists for, asserted on the real output.
        let set = shape(
            "{}",
            vec![doc! { "v": 1_i32 }, doc! { "v": "one" }],
            &limits(500),
            0,
        );
        assert_eq!(set.columns[0].type_name, "int | string");
        assert_eq!(set.columns[0].kind, crate::db::result::DbCellKind::Unknown);
        // …while a column with ONE type still gets its kind, or the guard would have thrown the
        // baby out with the bathwater.
        let single = shape("{}", vec![doc! { "v": 1_i32 }], &limits(500), 0);
        assert_eq!(
            single.columns[0].kind,
            crate::db::result::DbCellKind::Number
        );
    }

    #[test]
    fn a_column_that_holds_two_bson_types_reports_both_in_first_seen_order() {
        // Collections are schemaless, so a heterogeneous column is normal rather than an error.
        let set = shape(
            "{}",
            vec![
                doc! { "v": 1_i32 },
                doc! { "v": "one" },
                doc! { "v": 1_i32 },
            ],
            &limits(500),
            0,
        );
        assert_eq!(set.columns[0].type_name, "int | string");
        assert_eq!(set.rows[0][0], Some("1".to_string()));
        assert_eq!(set.rows[1][0], Some("one".to_string()));
    }

    #[test]
    fn the_column_union_is_first_seen_order_across_documents_not_the_first_documents_shape() {
        let set = shape(
            "{}",
            vec![
                doc! { "b": 1_i32, "a": 2_i32 },
                doc! { "c": 3_i32, "a": 4_i32 },
            ],
            &limits(500),
            0,
        );
        let names: Vec<&str> = set.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["b", "a", "c"]);
        // The second document has no `b`, so that cell is None AND the notice names it.
        assert_eq!(set.rows[1][0], None);
        assert!(set.notice.unwrap().contains("`b` in 1 of 2"));
    }

    #[test]
    fn the_column_cap_is_sixty_four_and_the_overflow_is_named_rather_than_faked() {
        let mut wide = Document::new();
        for i in 0..70 {
            wide.insert(format!("f{i:02}"), Bson::Int32(i));
        }
        let set = shape("{}", vec![wide], &limits(500), 0);
        assert_eq!(set.columns.len(), MAX_COLUMNS);
        // No "+6 more" column: a 65th column would have cells, and every one of them would be a
        // value the server never sent.
        assert!(set.columns.iter().all(|c| c.name.starts_with('f')));
        let notice = set.notice.expect("the cap must be reported");
        assert!(notice.contains("6 more field(s)"), "{notice}");
        assert!(notice.contains("64 columns"), "{notice}");
    }

    #[test]
    fn truncation_is_measured_from_the_extra_document_not_inferred_from_the_cap() {
        let docs = |n: usize| -> Vec<Document> { (0..n).map(|i| doc! { "n": i as i32 }).collect() };
        // 3 documents under a cap of 3 is NOT truncation — the wrong version of this test makes a
        // full page of results claim there is more.
        let exact = shape("{}", docs(3), &limits(3), 0);
        assert!(!exact.truncated);
        assert_eq!(exact.rows.len(), 3);
        // We asked for cap + 1 and got it, so there IS more, and the extra row is dropped.
        let capped = shape("{}", docs(4), &limits(3), 0);
        assert!(capped.truncated);
        assert_eq!(capped.rows.len(), 3);
    }

    #[test]
    fn a_single_reply_document_projects_exactly_like_a_row_would() {
        // How `count`, `dbStats` and `buildInfo` render: one row, the reply's own field order.
        let set = shape(
            "{}",
            vec![doc! { "n": 6_i32, "ok": 1.0_f64 }],
            &limits(500),
            1,
        );
        assert_eq!(set.kind, DbResultKind::Rows);
        let names: Vec<&str> = set.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["n", "ok"]);
        assert_eq!(set.rows, vec![vec![Some("6".into()), Some("1.0".into())]]);
    }

    #[test]
    fn an_empty_result_is_a_row_set_with_no_columns_rather_than_an_error() {
        // The fixture's `studios` collection is deliberately empty, and an empty grid is the
        // honest rendering — not a message, and not an error.
        let set = shape("{}", Vec::new(), &limits(500), 0);
        assert_eq!(set.kind, DbResultKind::Rows);
        assert!(set.columns.is_empty() && set.rows.is_empty());
        assert!(!set.truncated);
        assert_eq!(set.notice, None);
    }

    /* ───────────────────────────── connect options ───────────────────────────── */

    #[tokio::test]
    async fn the_form_fields_become_hosts_credentials_and_a_default_database() {
        let opts = MongoEngine::client_options(&cfg())
            .await
            .expect("options build");
        assert_eq!(
            opts.hosts,
            vec![ServerAddress::Tcp {
                host: "mongo.internal".into(),
                port: Some(27017)
            }]
        );
        let credential = opts.credential.expect("a user means a credential");
        assert_eq!(credential.username.as_deref(), Some("catalog_ro"));
        assert_eq!(credential.password.as_deref(), Some("s3cret-hunter2"));
        assert_eq!(opts.default_database.as_deref(), Some("maestro"));
        // The dial bound applies to server selection too, or `connectTimeout` would be ignored
        // for the case it exists for: a host where nothing answers.
        assert_eq!(opts.connect_timeout, Some(DEFAULT_CONNECT_TIMEOUT));
        assert_eq!(opts.server_selection_timeout, Some(DEFAULT_CONNECT_TIMEOUT));
    }

    #[tokio::test]
    async fn a_raw_url_overrides_the_form_fields_and_the_driver_is_what_parses_it() {
        let mut c = cfg();
        c.url = Some("mongodb://someone:pw@other.host:27018/other?authSource=admin".into());
        let opts = MongoEngine::client_options(&c).await.expect("parse");
        assert_eq!(
            opts.hosts,
            vec![ServerAddress::Tcp {
                host: "other.host".into(),
                port: Some(27018)
            }]
        );
        assert_eq!(
            opts.credential.and_then(|c| c.username),
            Some("someone".to_string())
        );
    }

    /// Negative control: a URI carrying its own password keeps it over a different field value, or
    /// an always-apply implementation would pass.
    #[tokio::test]
    async fn a_uri_that_carries_no_password_still_takes_the_one_typed_beside_it() {
        let mut c = cfg(); // user `catalog_ro`, password `s3cret-hunter2`
        c.url = Some("mongodb://catalog_ro@other.host:27018/other?authSource=admin".into());
        let credential = MongoEngine::client_options(&c)
            .await
            .expect("parse")
            .credential
            .expect("the URI names a user");
        assert_eq!(credential.username.as_deref(), Some("catalog_ro"));
        assert_eq!(
            credential.password.as_deref(),
            Some("s3cret-hunter2"),
            "the URI said nothing about the password, so the field must fill the gap"
        );

        // The control: the string speaks for itself.
        c.url = Some("mongodb://catalog_ro:uri-pw@other.host:27018/other?authSource=admin".into());
        let credential = MongoEngine::client_options(&c)
            .await
            .expect("parse")
            .credential
            .expect("credential");
        assert_eq!(credential.password.as_deref(), Some("uri-pw"));
        assert_ne!(credential.password.as_deref(), Some("s3cret-hunter2"));

        // A URI with no userinfo at all says nothing about *either* half, so the fields supply the
        // whole credential — the shape a pasted `mongodb://host/db` actually has.
        c.url = Some("mongodb://other.host:27018/other".into());
        let credential = MongoEngine::client_options(&c)
            .await
            .expect("parse")
            .credential
            .expect("the fields name a user, so there is a credential to build");
        assert_eq!(credential.username.as_deref(), Some("catalog_ro"));
        assert_eq!(credential.password.as_deref(), Some("s3cret-hunter2"));

        // …and with no user configured either there is nothing to authenticate as, which is the
        // same call the form path makes one line below `fill_credential_gaps`: Mongo's mechanisms
        // authenticate a NAMED account, so a password with no user is not a credential.
        c.user = String::new();
        assert!(MongoEngine::client_options(&c)
            .await
            .expect("parse")
            .credential
            .is_none());
    }

    #[tokio::test]
    async fn an_unparseable_url_is_invalid_config_and_carries_no_secret() {
        let mut c = cfg();
        c.url = Some("mongodb://user:s3cret-hunter2@".into());
        let err = MongoEngine::client_options(&c)
            .await
            .expect_err("must refuse");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(!err.message.contains("s3cret-hunter2"), "{}", err.message);
    }

    /* ─────────────── `mongodb+srv://` — the Atlas path ─────────────────────── */

    /// Proves the shape we build, not that an Atlas cluster is reachable: no SRV/TXT lookup,
    /// handshake or auth runs here.
    #[test]
    fn the_srv_uri_is_host_only_with_no_port_and_no_credential_in_it() {
        let mut c = cfg();
        c.srv = true;
        c.host = "cluster0.abcde.mongodb.net".into();
        c.port = None;
        assert_eq!(srv_uri(&c), "mongodb+srv://cluster0.abcde.mongodb.net/");

        // The password must not be in the string, in any spelling: the credential travels as a
        // `Credential`, and a URI is a thing that ends up in logs.
        assert!(!srv_uri(&c).contains("s3cret-hunter2"));
        assert!(!srv_uri(&c).contains("catalog_ro"));
        // …and no port, even if the record somehow carried one (it cannot — `upsert` refuses the
        // pair — but this function must not be the place that depends on that).
        c.port = Some(27017);
        assert!(!srv_uri(&c).contains("27017"), "{}", srv_uri(&c));
    }

    /// Uses the pure `ConnectionString::parse` (no DNS): proves the driver reads the string as a
    /// seed list, not that the cluster exists.
    #[test]
    fn the_driver_reads_our_srv_uri_as_a_dns_seed_list_and_refuses_one_with_a_port() {
        let mut c = cfg();
        c.srv = true;
        c.host = "cluster0.abcde.mongodb.net".into();
        c.port = None;

        let parsed = ConnectionString::parse(srv_uri(&c)).expect("the driver must accept our URI");
        assert_eq!(
            parsed.host_info,
            mongodb::options::HostInfo::DnsRecord("cluster0.abcde.mongodb.net".to_string()),
            "the driver must read this as a seed list, not as a single host"
        );

        // The negative control: the driver refuses the shape we refuse, so our
        // refusal is not merely a house rule and a port really would have been unusable.
        let err = ConnectionString::parse("mongodb+srv://cluster0.abcde.mongodb.net:27017/")
            .expect_err("the driver must refuse a port on an SRV URI");
        assert!(
            err.to_string().contains("port cannot be specified"),
            "{err}"
        );
    }

    /// `form_dial` is pure, so the SRV branch is checked without DNS.
    #[test]
    fn an_srv_record_dials_a_uri_and_every_other_record_dials_a_single_host() {
        let mut c = cfg();
        assert_eq!(
            form_dial(&c),
            FormDial::Host(ServerAddress::Tcp {
                host: "mongo.internal".into(),
                port: Some(27017)
            })
        );

        c.srv = true;
        c.host = "cluster0.abcde.mongodb.net".into();
        c.port = None;
        assert_eq!(
            form_dial(&c),
            FormDial::Uri("mongodb+srv://cluster0.abcde.mongodb.net/".to_string()),
            "an SRV record must become a connection string — a `ServerAddress` cannot hold a seed \
             list, which is why Atlas was unreachable"
        );
    }

    /// Uses `srv: false`: `client_options` with `srv: true` would resolve DNS.
    #[tokio::test]
    async fn a_non_srv_form_connection_still_dials_a_single_host_with_the_descriptors_port() {
        let opts = MongoEngine::client_options(&cfg()).await.expect("options");
        assert_eq!(
            opts.hosts,
            vec![ServerAddress::Tcp {
                host: "mongo.internal".into(),
                port: Some(27017)
            }],
            "the ordinary form path is unchanged by the SRV work"
        );

        // …and with an EMPTY port field it is still 27017 — the descriptor's default, which is also
        // the number the dialog shows as the placeholder.
        let mut c = cfg();
        c.port = None;
        let opts = MongoEngine::client_options(&c).await.expect("options");
        assert_eq!(
            opts.hosts,
            vec![ServerAddress::Tcp {
                host: "mongo.internal".into(),
                port: Some(27017)
            }]
        );
    }

    #[tokio::test]
    async fn a_ca_certificate_is_refused_by_name_because_the_driver_wants_a_path() {
        // Refused, not ignored: the PEM is kept in memory and a user path is never re-read, and
        // silently dropping the CA would surface later as an unexplainable "unknown issuer".
        let mut c = cfg();
        c.ca_pem = Some(b"-----BEGIN CERTIFICATE-----".to_vec());
        let err = MongoEngine::client_options(&c)
            .await
            .expect_err("must refuse");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("CA certificate"), "{}", err.message);
    }

    #[tokio::test]
    async fn the_descriptor_options_reach_the_client_options() {
        let mut c = cfg();
        c.options.insert("replicaSet".into(), "rs0".into());
        c.options
            .insert("appName".into(), "AgentStudio-test".into());
        c.options.insert("directConnection".into(), "true".into());
        c.options
            .insert("readPreference".into(), "secondaryPreferred".into());
        c.options.insert("authSource".into(), "admin".into());
        c.options.insert("connectTimeout".into(), "3".into());
        let opts = MongoEngine::client_options(&c).await.expect("options");
        assert_eq!(opts.repl_set_name.as_deref(), Some("rs0"));
        assert_eq!(opts.app_name.as_deref(), Some("AgentStudio-test"));
        assert_eq!(opts.direct_connection, Some(true));
        assert_eq!(opts.connect_timeout, Some(Duration::from_secs(3)));
        assert_eq!(
            opts.credential.and_then(|c| c.source),
            Some("admin".to_string())
        );
        assert!(matches!(
            opts.selection_criteria,
            Some(SelectionCriteria::ReadPreference(
                ReadPreference::SecondaryPreferred { .. }
            ))
        ));
    }

    #[test]
    fn the_ssl_ladder_never_falls_back_to_plaintext_except_where_asked() {
        assert!(matches!(tls_for(SslMode::Disable), Tls::Disabled));
        // `require` = encrypt, do not verify (the libpq meaning this app borrows).
        match tls_for(SslMode::Require) {
            Tls::Enabled(o) => assert_eq!(o.allow_invalid_certificates, Some(true)),
            Tls::Disabled => panic!("`require` must encrypt"),
        }
        for mode in [SslMode::VerifyCa, SslMode::VerifyFull, SslMode::Prefer] {
            match tls_for(mode) {
                Tls::Enabled(o) => {
                    assert_eq!(o.allow_invalid_certificates, None, "{mode:?} must verify")
                }
                // `prefer` is not on Mongo's ladder; if it ever arrives it must encrypt rather
                // than silently downgrade.
                Tls::Disabled => panic!("{mode:?} must not be plaintext"),
            }
        }
    }

    /// On the URL path `opts.tls` stays as the driver read it; `None` is the plain scheme's default
    /// (no TLS), which a plaintext `mongod` needs.
    #[tokio::test]
    async fn a_pasted_url_keeps_the_drivers_tls_answer_and_the_form_keeps_the_ladder() {
        // `cfg()` carries `SslMode::Require`, which is the MongoDB row's descriptor default — the
        // value a freshly-created record holds, and the one that did the damage.
        assert_eq!(cfg().ssl_mode, SslMode::Require);

        let tls_of = |url: &str| {
            let mut c = cfg();
            c.url = Some(url.to_string());
            async move { MongoEngine::client_options(&c).await.expect("parse").tls }
        };

        // 1. The string says nothing → the driver's own scheme default survives untouched.
        assert!(
            tls_of("mongodb://plaintext.host:27017/maestro")
                .await
                .is_none(),
            "a plain `mongodb://` URL defaults to no TLS and the form's ladder must not override it"
        );

        // 2. The string says `tls=true` → honoured, as it always was. This is the control that the
        //    fix removed the forced DEFAULT and not TLS support.
        match tls_of("mongodb://plaintext.host:27017/maestro?tls=true").await {
            Some(Tls::Enabled(_)) => {}
            other => panic!("a URL asking for TLS must get it, got {other:?}"),
        }

        // 3. …and `tls=false` is an answer too, not a silence.
        match tls_of("mongodb://plaintext.host:27017/maestro?tls=false").await {
            Some(Tls::Disabled) => {}
            other => panic!("a URL refusing TLS must be believed, got {other:?}"),
        }

        // 4. The FORM path is untouched: with no string to respect, the ladder decides both ways.
        let mut c = cfg();
        assert!(c.url.is_none());
        match MongoEngine::client_options(&c).await.expect("options").tls {
            Some(Tls::Enabled(o)) => assert_eq!(o.allow_invalid_certificates, Some(true)),
            other => panic!("`require` on the form path must still enable TLS, got {other:?}"),
        }
        c.ssl_mode = SslMode::Disable;
        match MongoEngine::client_options(&c).await.expect("options").tls {
            Some(Tls::Disabled) => {}
            other => panic!("`disable` on the form path must still say so, got {other:?}"),
        }
    }

    /// The pure `ConnectionString::parse` sets `tls` for SRV on both paths (URL and SRV form), so
    /// the ladder never fires and `sslMode: require` cannot loosen it.
    #[test]
    fn an_srv_string_is_tls_enabled_by_the_driver_on_both_paths() {
        let mut c = cfg();
        c.srv = true;
        c.host = "cluster0.abcde.mongodb.net".into();
        c.port = None;

        let srv = ConnectionString::parse(srv_uri(&c)).expect("the driver accepts our SRV URI");
        match srv.tls {
            Some(Tls::Enabled(_)) => {}
            other => panic!("the SRV scheme defaults to TLS in the driver itself, got {other:?}"),
        }

        // The negative control, and the premise of the fix: the plain scheme leaves it unset, which
        // is the driver saying "this scheme defaults to no TLS".
        assert!(
            ConnectionString::parse("mongodb://plaintext.host:27017/maestro")
                .expect("a plain URL")
                .tls
                .is_none(),
            "if the driver ever started defaulting this, the URL path's behaviour would change \
             silently — which is exactly why it is asserted here"
        );
    }

    #[test]
    fn read_preference_primary_is_left_unset_so_a_urls_own_value_survives() {
        let mut c = cfg();
        c.options.insert("readPreference".into(), "primary".into());
        assert!(read_preference(&c).is_none());
        c.options.insert("readPreference".into(), "nonsense".into());
        assert!(
            read_preference(&c).is_none(),
            "an unknown value must not route reads"
        );
        c.options.insert("readPreference".into(), "nearest".into());
        assert!(matches!(
            read_preference(&c),
            Some(ReadPreference::Nearest { .. })
        ));
    }

    #[test]
    fn the_connect_timeout_comes_from_the_option_and_falls_back_to_ten_seconds() {
        let mut c = cfg();
        assert_eq!(connect_timeout(&c), DEFAULT_CONNECT_TIMEOUT);
        c.options.insert("connectTimeout".into(), "3".into());
        assert_eq!(connect_timeout(&c), Duration::from_secs(3));
        // Nonsense and zero both fall back rather than producing an instant timeout.
        c.options.insert("connectTimeout".into(), "soon".into());
        assert_eq!(connect_timeout(&c), DEFAULT_CONNECT_TIMEOUT);
        c.options.insert("connectTimeout".into(), "0".into());
        assert_eq!(connect_timeout(&c), DEFAULT_CONNECT_TIMEOUT);
    }

    /* ───────────────────────────── error mapping ───────────────────────────── */

    #[test]
    fn an_io_failure_routes_through_map_mongo_error_to_network() {
        // `ErrorKind::Io` is a TUPLE variant, so unlike the struct variants it can be built here —
        // which makes it the one case that proves the routing and the decision together.
        let e = MongoError::from(ErrorKind::Io(std::sync::Arc::new(std::io::Error::from(
            std::io::ErrorKind::ConnectionRefused,
        ))));
        let mapped = map_mongo_error(&e);
        assert_eq!(mapped.code, DbErrorCode::Network);
        assert!(
            mapped.message.contains("Nothing is listening there"),
            "{}",
            mapped.message
        );
    }

    #[test]
    fn the_failure_kinds_a_user_can_act_on_are_distinguished() {
        // Via [`describe`]: `ErrorKind`'s struct variants cannot be constructed (E0639). The live
        // tier proves the routing (wrong password → `auth`, dead port → `network`).
        for (failure, want) in [
            (Failure::Credentials, DbErrorCode::Auth),
            (Failure::TlsConfig, DbErrorCode::Tls),
            (Failure::TlsHandshake, DbErrorCode::Tls),
            (Failure::Dns, DbErrorCode::Network),
            (Failure::Unreachable, DbErrorCode::Network),
            (Failure::PoolReset, DbErrorCode::Network),
            (Failure::BadSetting, DbErrorCode::InvalidConfig),
            (Failure::UnreadableReply, DbErrorCode::Unknown),
            (Failure::UnencodableCommand, DbErrorCode::InvalidConfig),
        ] {
            let mapped = describe(failure, "the driver's own words");
            assert_eq!(mapped.code, want, "{failure:?}");
            // The driver's detail always survives: for several of these it is the only thing that
            // names WHICH host or WHICH setting was the problem.
            assert!(
                mapped.message.contains("the driver's own words"),
                "{failure:?}: {}",
                mapped.message
            );
        }
    }

    #[test]
    fn an_io_kind_picks_the_advice_that_fits_it() {
        for (kind, fragment) in [
            (
                std::io::ErrorKind::ConnectionRefused,
                "Nothing is listening there",
            ),
            (std::io::ErrorKind::TimedOut, "timed out"),
            (
                std::io::ErrorKind::ConnectionReset,
                "The server closed the connection",
            ),
            (
                std::io::ErrorKind::BrokenPipe,
                "The server closed the connection",
            ),
            (
                std::io::ErrorKind::PermissionDenied,
                "Check the host, the port",
            ),
        ] {
            let mapped = describe_io(kind, "detail");
            assert_eq!(mapped.code, DbErrorCode::Network, "{kind:?}");
            assert!(
                mapped.message.contains(fragment),
                "{kind:?}: {}",
                mapped.message
            );
        }
    }

    /// The driver's real words for the handshake-EOF failure, copied out of a failing live-tier
    /// run rather than paraphrased — this is what `ErrorKind::ServerSelection`
    /// actually carries, envelope and all.
    const HANDSHAKE_EOF: &str = "No available servers. Topology: { Type: Unknown, Servers: [ { \
                                 Address: 127.0.0.1:57017, Type: Unknown, Error: Kind: I/O error: \
                                 tls handshake eof, labels: {\"RetryableError\"}, source: None, \
                                 server response: None } ] }";
    /// The same envelope for a server that genuinely is not there.
    const REFUSED: &str = "No available servers. Topology: { Type: Unknown, Servers: [ { Address: \
                          127.0.0.1:57018, Type: Unknown, Error: Kind: I/O error: Connection \
                          refused (os error 61), labels: {}, source: None, server response: None \
                          } ] }";

    /// Every connection failure funnels through `ServerSelection`, so both sides are asserted: a
    /// fix that swallowed the unreachable case would look equally green.
    #[test]
    fn a_failed_handshake_is_told_apart_from_a_server_that_is_not_there() {
        assert_eq!(
            server_selection_failure(HANDSHAKE_EOF),
            Failure::TlsHandshake
        );
        assert_eq!(server_selection_failure(REFUSED), Failure::Unreachable);

        // The sentence, not only the code: the user was sent to the host and the port by a
        // message that had no business mentioning them.
        let handshake = describe(Failure::TlsHandshake, HANDSHAKE_EOF);
        assert_eq!(handshake.code, DbErrorCode::Tls);
        assert!(
            handshake
                .message
                .contains("did not complete a TLS handshake"),
            "{}",
            handshake.message
        );
        assert!(
            handshake.message.contains("SSL mode to Disable"),
            "the message must name the fix, not only the symptom: {}",
            handshake.message
        );
        assert!(
            !handshake.message.contains("check the host, the port"),
            "the host and the port are the two things a completed TCP connection proves are fine: \
             {}",
            handshake.message
        );

        // …and the unreachable branch is untouched, wording included.
        let unreachable = describe(Failure::Unreachable, REFUSED);
        assert_eq!(unreachable.code, DbErrorCode::Network);
        assert!(
            unreachable
                .message
                .contains("No MongoDB server could be reached"),
            "{}",
            unreachable.message
        );
        assert!(
            !unreachable.message.contains("TLS handshake"),
            "{}",
            unreachable.message
        );
    }

    /// The marker set is deliberately narrow: a server that *does* speak TLS and rejected something
    /// specific must keep its own sentence, because "turn TLS off" would be the wrong advice there.
    #[test]
    fn only_a_handshake_that_never_got_off_the_ground_is_reclassified() {
        assert!(is_tls_handshake_failure(
            "Kind: I/O error: tls handshake eof"
        ));
        assert!(is_tls_handshake_failure(
            "Kind: I/O error: received corrupt message of type Handshake"
        ));
        // Case-insensitively, because the driver's envelope capitalises what it wraps.
        assert!(is_tls_handshake_failure("TLS HANDSHAKE EOF"));

        for speaks_tls_but_said_no in [
            "received fatal alert: HandshakeFailure",
            "invalid peer certificate: UnknownIssuer",
            "the server does not support TLS 1.3",
            "Connection refused (os error 61)",
        ] {
            assert!(
                !is_tls_handshake_failure(speaks_tls_but_said_no),
                "`{speaks_tls_but_said_no}` is not a plaintext server, so `set SSL mode to \
                 Disable` would be bad advice"
            );
        }
    }

    /// Through the whole mapping via `ErrorKind::Io` (a tuple variant a test can build); both
    /// errors are `Io`, so only the classification tells them apart.
    #[test]
    fn a_handshake_eof_routes_to_tls_while_a_refused_socket_still_routes_to_network() {
        let io = |kind, text: &str| {
            MongoError::from(ErrorKind::Io(std::sync::Arc::new(std::io::Error::new(
                kind,
                text.to_string(),
            ))))
        };

        let handshake =
            map_mongo_error(&io(std::io::ErrorKind::UnexpectedEof, "tls handshake eof"));
        assert_eq!(handshake.code, DbErrorCode::Tls, "{}", handshake.message);
        assert!(
            handshake
                .message
                .contains("did not complete a TLS handshake"),
            "{}",
            handshake.message
        );

        let refused = map_mongo_error(&io(
            std::io::ErrorKind::ConnectionRefused,
            "Connection refused (os error 61)",
        ));
        assert_eq!(refused.code, DbErrorCode::Network, "{}", refused.message);
        assert!(
            refused.message.contains("Nothing is listening there"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn a_command_errors_numeric_code_drives_the_classification_not_its_prose() {
        // Routed through `map_mongo_error`: `ErrorKind::Command` is a tuple variant, so its whole
        // path is reachable hermetically.
        for (code, want) in [
            (13_i32, DbErrorCode::Auth),
            (18, DbErrorCode::Auth),
            (50, DbErrorCode::Timeout),
            (59, DbErrorCode::InvalidStatement),
            (9, DbErrorCode::InvalidStatement),
            (40415, DbErrorCode::InvalidStatement),
            (26, DbErrorCode::Unknown),
        ] {
            let mapped = map_mongo_error(&command_error(code, "the server's own words"));
            assert_eq!(mapped.code, want, "code {code} mapped to {:?}", mapped.code);
            assert!(
                mapped.message.contains("the server's own words"),
                "the server's own words must survive: {}",
                mapped.message
            );
        }
        // An unclassified code says which code it was, so a user can look it up rather than being
        // told only that "something failed".
        assert!(map_mongo_error(&command_error(26, "ns not found"))
            .message
            .contains("code 26"));
    }

    #[test]
    fn a_password_is_scrubbed_out_of_a_driver_error_on_the_way_out() {
        // Redaction at the seam that matters: drivers echo connection strings into error text, and the
        // live tier proves it against a REAL wrong-password failure
        // (`a_wrong_password_is_auth_and_never_appears_in_the_error`).
        let mapped = describe(
            Failure::Credentials,
            "auth failed for mongodb://u:s3cret-hunter2@h",
        )
        .redacted(&["s3cret-hunter2"]);
        assert!(
            !mapped.message.contains("s3cret-hunter2"),
            "{}",
            mapped.message
        );
        assert!(mapped.message.contains(crate::db::error::MASK));
    }

    /// A `CommandError` cannot be built with a struct literal (it is `#[non_exhaustive]`), so it is
    /// deserialised from the wire shape the server actually sends.
    fn command_error(code: i32, message: &str) -> MongoError {
        let raw = serde_json::json!({ "code": code, "codeName": "X", "errmsg": message });
        let inner: mongodb::error::CommandError =
            serde_json::from_value(raw).expect("the wire shape of a command error");
        MongoError::from(ErrorKind::Command(inner))
    }
}
