//! **The** per-engine descriptor registry, and the validator that has to agree with it.
//!
//! The requirement is that the connection form matches the engine it is
//! for — a Mongo form grows `replicaSet`/`readPreference`, a Redis form is a host and a db
//! index. That is a **data** problem, so it is a table here and not a pile of conditionals in
//! a form component. `src/features/db/ConnectionDialog.tsx` renders whatever
//! `db_engines()` hands it and owns no per-engine knowledge at all; adding ClickHouse to the
//! dialog was already done the moment its row below existed.
//!
//! Shape borrowed from `lsp/registry.rs`'s `spec_for(language_id) -> Option<LspServerSpec>`,
//! with **one deliberate difference**: the descriptor is *served over IPC* rather than
//! mirrored on the frontend. The LSP mirror works because the frontend needs only a name
//! set; here it needs the whole form spec — labels, placeholders, kinds, defaults,
//! requiredness, help text — and any duplicate of that would drift from the validator that
//! has to agree with it. `src/features/db/engineFields.ts` therefore keeps only what Rust has
//! no business knowing.
//!
//! ## Two safety properties are structural here, not enforced by code
//!
//! * **A descriptor cannot ask for a secret.** `DbFieldKind` has no `password` variant,
//!   because every `DbFieldSpec` value lands in `DbConnection.options`, which is *persisted
//!   to disk* — a password-kind field would write a credential into a plaintext file, the
//!   exact failure the Vault exists to prevent. (`types.ts` removed the variant after the
//!   dialog had to defensively refuse it. A type that cannot express the mistake is
//!   a better defence than code that can be deleted.)
//! * **A descriptor cannot weaken read-only.** [`EngineDefaults`] has no `read_only` field.
//!   A new connection is read-only *unconditionally*; letting a data row say `false`
//!   would make the single most important safety default weakenable by data. An engine that
//!   cannot *enforce* read-only server-side says so through
//!   [`EngineSpec::server_enforced_read_only`], which changes what the UI **promises**, not
//!   what it **defaults to**.
//!
//! ## Testing: never read an expectation from the table under test
//!
//! A **routing** loop (every engine has a spec; ids are unique; field keys are unique; ports
//! are non-zero; the default SSL mode is one the engine offers) plus a committed **golden
//! snapshot** of the serialised `db_engines()` output. The loop's comment states that it does
//! not pin values; the snapshot is what makes a changed default a named line in a diff.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::db::error::DbError;
use crate::db::model::{DbConnectionInput, DbEngineId, DbFamily, SslMode};

/// What control renders a descriptor field. Mirrors `DbFieldKind`.
///
/// There is deliberately **no `Password`** — see the module doc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbFieldKind {
    Text,
    Number,
    Select,
    Checkbox,
}

/// One engine-specific form control. Its value lands in `DbConnection.options[key]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbFieldSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: DbFieldKind,
    pub placeholder: Option<&'static str>,
    /// For `Select`.
    pub choices: Option<&'static [&'static str]>,
    /// Pre-filled value, `""` for none. Without this a fresh Mongo form was *invalid* until
    /// the user typed an `authSource` the registry already knew was `admin`.
    pub default: &'static str,
    pub required: bool,
    /// Shown under the field — the *why*, not a restatement of the label.
    pub hint: Option<&'static str>,
}

/// Defaults for the per-connection guardrails. **No `read_only`** — see the module doc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineDefaults {
    pub row_limit: u32,
    pub timeout_ms: u32,
    pub allow_multi_statement: bool,
    pub ssl_mode: SslMode,
}

/// What the console's "Run" means for this engine, and therefore which highlighting it uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueryLanguage {
    Sql,
    Json,
    Commandline,
}

/// One row of the registry. Serialised straight to the dialog as `EngineSpec`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSpec {
    pub id: DbEngineId,
    pub family: DbFamily,
    pub label: &'static str,
    /// The engine's standard port. **Two jobs, and they are deliberately the
    /// same number:**
    ///
    /// 1. The **placeholder the dialog shows** in an empty port box. It is no longer pre-filled
    ///    into the record — `DbConnection::port` is `Option<u16>` and an empty box stays empty,
    ///    because a value silently injected into a record is a value the user never typed.
    /// 2. The port an **empty** port field actually dials
    ///    ([`crate::db::engine::ResolvedConfig::port_or_default`]).
    ///
    /// They must be one number: if the connect path used something else — sqlx-postgres's own
    /// default, say, which is `$PGPORT` or 5432 — the placeholder would be a lie on any machine
    /// where the two disagree, and the app's behaviour would depend on the shell that launched it.
    ///
    /// ⚠️ It cannot express a *per-TLS-mode* default, and ClickHouse is where that bites: this
    /// says 8123 (the plaintext HTTP interface) while a TLS ClickHouse conventionally listens on
    /// 8443, so an SSL-enabled ClickHouse connection with an empty port dials 8123 and fails.
    /// Recorded rather than papered over with a second invented number — see
    /// [`crate::db::clickhouse::ClickhouseEngine`].
    pub default_port: u16,
    /// URI scheme(s) this engine's connection strings use; **first is canonical**, and it is
    /// what [`crate::db::url::build`] emits. For the Redis family the second entry is the TLS
    /// scheme (`rediss`), which `url.rs` selects on; a routing test below asserts that every
    /// scheme `build` can emit appears in this list, so the two cannot drift.
    pub url_schemes: &'static [&'static str],
    /// Whether `database` is meaningful, and what to call it in the UI.
    pub database_label: Option<&'static str>,
    pub supports_user: bool,
    pub ssl_modes: &'static [SslMode],
    pub extra_fields: &'static [DbFieldSpec],
    pub defaults: EngineDefaults,
    /// Whether **server-enforced** read-only exists here. `false` means the flag is a
    /// client-side speed bump and the UI must say so rather than implying a guarantee it
    /// cannot make. A control that pretends to be stronger than it is, is worse than
    /// no control.
    pub server_enforced_read_only: bool,
    pub query_language: QueryLanguage,
}

/* ─────────────────────────── the shared field sets ─────────────────────────── */

const PG_FIELDS: &[DbFieldSpec] = &[
    DbFieldSpec {
        key: "applicationName",
        label: "Application name",
        kind: DbFieldKind::Text,
        placeholder: Some("Agent Studio"),
        choices: None,
        default: "Agent Studio",
        required: false,
        hint: Some(
            "Appears in pg_stat_activity, so a runaway query is traceable back to this app.",
        ),
    },
    DbFieldSpec {
        key: "searchPath",
        label: "Search path",
        kind: DbFieldKind::Text,
        placeholder: Some("public"),
        choices: None,
        default: "",
        required: false,
        hint: Some("Which schemas an unqualified table name resolves against."),
    },
    DbFieldSpec {
        key: "connectTimeout",
        label: "Connect timeout (s)",
        kind: DbFieldKind::Number,
        placeholder: Some("10"),
        choices: None,
        default: "",
        required: false,
        hint: Some("Bounds the dial itself; the query timeout is set separately below."),
    },
    DbFieldSpec {
        key: "targetSessionAttrs",
        label: "Target session",
        kind: DbFieldKind::Select,
        placeholder: None,
        choices: Some(&[
            "any",
            "read-write",
            "read-only",
            "primary",
            "standby",
            "prefer-standby",
        ]),
        default: "",
        required: false,
        hint: Some(
            "For a multi-host cluster: which member to accept. `read-only` steers analytical \
             queries onto a replica.",
        ),
    },
];

const MYSQL_FIELDS: &[DbFieldSpec] = &[
    DbFieldSpec {
        key: "connectTimeout",
        label: "Connect timeout (s)",
        kind: DbFieldKind::Number,
        placeholder: Some("10"),
        choices: None,
        default: "",
        required: false,
        hint: Some("Bounds the dial itself; the query timeout is set separately below."),
    },
    DbFieldSpec {
        key: "charset",
        label: "Character set",
        kind: DbFieldKind::Text,
        placeholder: Some("utf8mb4"),
        choices: None,
        default: "",
        required: false,
        hint: Some("Leave empty to take the server's default."),
    },
];

const CLICKHOUSE_FIELDS: &[DbFieldSpec] = &[DbFieldSpec {
    key: "compress",
    label: "Compress responses",
    kind: DbFieldKind::Checkbox,
    placeholder: None,
    choices: None,
    default: "",
    required: false,
    hint: Some("Asks ClickHouse to gzip result bodies — worth it over a slow link."),
}];

const MONGO_FIELDS: &[DbFieldSpec] = &[
    DbFieldSpec {
        key: "authSource",
        label: "Auth source",
        kind: DbFieldKind::Text,
        placeholder: Some("admin"),
        choices: None,
        default: "admin",
        required: true,
        hint: Some("The database that holds the user — usually `admin`, not the one you query."),
    },
    DbFieldSpec {
        key: "replicaSet",
        label: "Replica set",
        kind: DbFieldKind::Text,
        placeholder: Some("atlas-abc123-shard-0"),
        choices: None,
        default: "",
        required: false,
        hint: None,
    },
    DbFieldSpec {
        key: "readPreference",
        label: "Read preference",
        kind: DbFieldKind::Select,
        placeholder: None,
        choices: Some(&[
            "primary",
            "primaryPreferred",
            "secondary",
            "secondaryPreferred",
            "nearest",
        ]),
        default: "primary",
        required: false,
        hint: Some("Reading from a secondary keeps analytical queries off the primary."),
    },
    DbFieldSpec {
        key: "directConnection",
        label: "Direct connection",
        kind: DbFieldKind::Checkbox,
        placeholder: None,
        choices: None,
        default: "",
        required: false,
        hint: Some("Talk to exactly this host instead of discovering the replica set."),
    },
    DbFieldSpec {
        key: "appName",
        label: "App name",
        kind: DbFieldKind::Text,
        placeholder: Some("Agent Studio"),
        choices: None,
        default: "Agent Studio",
        required: false,
        hint: Some("Appears in Mongo's `currentOp` and its logs."),
    },
];

/// DynamoDB's fields, and every one of them is here because the engine has no connection string
/// to carry it.
///
/// `region` is REQUIRED and has no default: guessing `us-east-1` would silently point a query at
/// the wrong continent's tables, and an empty table list is indistinguishable from "you are in the
/// wrong region". The endpoint override is what addresses DynamoDB Local, and it is the only
/// reason `host`/`port` mean anything for this engine.
const DYNAMODB_FIELDS: &[DbFieldSpec] = &[
    DbFieldSpec {
        key: "region",
        label: "Region",
        kind: DbFieldKind::Text,
        placeholder: Some("eu-west-1"),
        choices: None,
        default: "",
        required: true,
        hint: Some(
            "Part of every signed request, so it cannot be guessed: the wrong region reaches a \
             different set of tables and looks like an empty account.",
        ),
    },
    DbFieldSpec {
        key: "endpoint",
        label: "Endpoint override",
        kind: DbFieldKind::Text,
        placeholder: Some("http://127.0.0.1:8000"),
        choices: None,
        default: "",
        required: false,
        hint: Some(
            "Leave empty for the real service. This is how DynamoDB Local is addressed, and it is \
             the only way to reach anything other than AWS.",
        ),
    },
];

const REDIS_FIELDS: &[DbFieldSpec] = &[DbFieldSpec {
    key: "clientName",
    label: "Client name",
    kind: DbFieldKind::Text,
    placeholder: Some("agent-studio"),
    choices: None,
    default: "agent-studio",
    required: false,
    hint: Some("Shown by `CLIENT LIST`, so this connection is identifiable on the server."),
}];

/// The full SSL ladder — the postgres and mysql families support all five.
const SSL_ALL: &[SslMode] = &[
    SslMode::Disable,
    SslMode::Prefer,
    SslMode::Require,
    SslMode::VerifyCa,
    SslMode::VerifyFull,
];

/// No opportunistic mode. MongoDB, ClickHouse-over-HTTP and Redis either speak TLS or they do
/// not — there is no "try TLS, fall back to plaintext" handshake to offer, and offering
/// `prefer` would be a control that silently does nothing.
const SSL_NO_PREFER: &[SslMode] = &[
    SslMode::Disable,
    SslMode::Require,
    SslMode::VerifyCa,
    SslMode::VerifyFull,
];

const DEFAULT_ROW_LIMIT: u32 = 500;
/// 30 s, the same number as `http.rs`'s `REQUEST_TIMEOUT`, so the app has **one** timeout
/// people can learn.
const DEFAULT_TIMEOUT_MS: u32 = 30_000;

/// Ceiling on `row_limit` — above this the webview is the bottleneck no matter what we do.
pub const MAX_ROW_LIMIT: u32 = 100_000;
/// The `timeout_ms` window the dialog offers, mirrored here so a hand-built IPC call cannot
/// set a 1 ms or a 3-hour timeout.
pub const MIN_TIMEOUT_MS: u32 = 1_000;
pub const MAX_TIMEOUT_MS: u32 = 600_000;

/* ───────────────────────────────── the rows ───────────────────────────────── */

/// Every engine, in the order the dialog's driver picker shows them.
///
/// `db_engines()` drives the whole dialog from this table, so a new engine is a driver module
/// plus (for Aurora) *nothing at all*. See [`crate::db::engine::engine_for`] for the honest
/// error an unwired row would give.
pub const ENGINES: &[EngineSpec] = &[
    EngineSpec {
        id: DbEngineId::Postgres,
        family: DbFamily::Postgres,
        label: "PostgreSQL",
        default_port: 5432,
        url_schemes: &["postgresql", "postgres"],
        database_label: Some("Database"),
        supports_user: true,
        ssl_modes: SSL_ALL,
        extra_fields: PG_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            // `prefer` = encrypt if offered, do not verify — libpq's own default, and
            // what lets a Docker container work out of the box.
            ssl_mode: SslMode::Prefer,
        },
        server_enforced_read_only: true,
        query_language: QueryLanguage::Sql,
    },
    EngineSpec {
        id: DbEngineId::AuroraPostgres,
        family: DbFamily::Postgres,
        label: "Amazon Aurora PostgreSQL",
        default_port: 5432,
        url_schemes: &["postgresql", "postgres"],
        database_label: Some("Database"),
        supports_user: true,
        ssl_modes: SSL_ALL,
        extra_fields: PG_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            // TLS on by default: RDS/Aurora endpoints are reachable from outside the VPC,
            // so the same default as self-hosted would be wrong here.
            ssl_mode: SslMode::Require,
        },
        server_enforced_read_only: true,
        query_language: QueryLanguage::Sql,
    },
    EngineSpec {
        id: DbEngineId::Mysql,
        family: DbFamily::Mysql,
        label: "MySQL",
        default_port: 3306,
        url_schemes: &["mysql", "mariadb"],
        database_label: Some("Database"),
        supports_user: true,
        ssl_modes: SSL_ALL,
        extra_fields: MYSQL_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            // NOT a style choice: `mysql-rsa` cannot be enabled because
            // `rsa 0.10.0-rc.18` carries RUSTSEC-2023-0071 with no fixed version, so MySQL 8's
            // default `caching_sha2_password` can only complete full authentication inside a
            // TLS tunnel. Defaulting to `prefer` here would ship a first-run failure.
            ssl_mode: SslMode::Require,
        },
        server_enforced_read_only: true,
        query_language: QueryLanguage::Sql,
    },
    EngineSpec {
        id: DbEngineId::AuroraMysql,
        family: DbFamily::Mysql,
        label: "Amazon Aurora MySQL",
        default_port: 3306,
        url_schemes: &["mysql", "mariadb"],
        database_label: Some("Database"),
        supports_user: true,
        ssl_modes: SSL_ALL,
        extra_fields: MYSQL_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            ssl_mode: SslMode::Require,
        },
        server_enforced_read_only: true,
        query_language: QueryLanguage::Sql,
    },
    EngineSpec {
        id: DbEngineId::Clickhouse,
        family: DbFamily::Clickhouse,
        label: "ClickHouse",
        default_port: 8123,
        // The HTTP interface — the native port 9000 is a protocol this app does not
        // speak, and `url.rs` says so by name when someone pastes `tcp://…:9000`.
        url_schemes: &["clickhouse", "clickhouses"],
        database_label: Some("Database"),
        supports_user: true,
        ssl_modes: SSL_NO_PREFER,
        extra_fields: CLICKHOUSE_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            ssl_mode: SslMode::Require,
        },
        server_enforced_read_only: true,
        query_language: QueryLanguage::Sql,
    },
    EngineSpec {
        id: DbEngineId::Mongodb,
        family: DbFamily::Mongodb,
        label: "MongoDB",
        default_port: 27017,
        url_schemes: &["mongodb", "mongodb+srv"],
        database_label: Some("Database"),
        supports_user: true,
        ssl_modes: SSL_NO_PREFER,
        extra_fields: MONGO_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            ssl_mode: SslMode::Require,
        },
        // Mongo has no per-connection read-only mode; ours is a command-name allowlist applied
        // in Rust, and the badge says "enforced by this app" for exactly this reason.
        server_enforced_read_only: false,
        query_language: QueryLanguage::Json,
    },
    EngineSpec {
        id: DbEngineId::Redis,
        family: DbFamily::Redis,
        label: "Redis",
        default_port: 6379,
        url_schemes: &["redis", "rediss"],
        database_label: Some("Database index"),
        // Redis 6 ACLs give real usernames; a pre-6 server just leaves it blank.
        supports_user: true,
        ssl_modes: SSL_NO_PREFER,
        extra_fields: REDIS_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            ssl_mode: SslMode::Disable,
        },
        server_enforced_read_only: false,
        query_language: QueryLanguage::Commandline,
    },
    EngineSpec {
        id: DbEngineId::Valkey,
        family: DbFamily::Redis,
        label: "Valkey (Redis-compatible)",
        default_port: 6379,
        // `valkey://` is accepted on *parse* (see `url.rs`'s scheme table) but never *built*:
        // the wire protocol is Redis's, and `redis://` is the string every other tool takes.
        url_schemes: &["redis", "rediss"],
        database_label: Some("Database index"),
        supports_user: true,
        ssl_modes: SSL_NO_PREFER,
        extra_fields: REDIS_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            ssl_mode: SslMode::Disable,
        },
        server_enforced_read_only: false,
        query_language: QueryLanguage::Commandline,
    },
    EngineSpec {
        id: DbEngineId::Dynamodb,
        family: DbFamily::Dynamodb,
        label: "Amazon DynamoDB",
        // Signed HTTPS, so the port is the HTTPS one — and it is only ever used with an endpoint
        // override, since the real service is addressed by region.
        default_port: 443,
        // 🔴 **Empty on purpose.** There is no `dynamodb://` URI, so the dialog must
        // hide the URL box rather than prompt for a shape that does not exist, and `DbConnection.url`
        // stays `null` for this engine forever.
        url_schemes: &[],
        // No databases and no catalogs: a region contains tables. `None` is what makes the dialog
        // drop the field instead of asking for something DynamoDB has no word for.
        database_label: None,
        // The AWS **access key id** — not a secret, which is why it belongs in `user` while the
        // secret access key goes to the Vault as `passwordRef` like every other engine's password.
        supports_user: true,
        // Signed requests are HTTPS by definition against the real service. `Disable` exists only
        // for DynamoDB Local over loopback, which speaks plain HTTP.
        ssl_modes: SSL_NO_PREFER,
        extra_fields: DYNAMODB_FIELDS,
        defaults: EngineDefaults {
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            allow_multi_statement: false,
            ssl_mode: SslMode::VerifyFull,
        },
        // 🔴 **IAM decides, not us.** There is no session setting to send, so read-only
        // here is a client-side statement filter and the badge must say so. The honest advice, and
        // the UI gives it: point the connection at a read-only IAM role.
        server_enforced_read_only: false,
        // PartiQL — `SELECT * FROM "tracks" WHERE pk = 'x'` — so Shiki's SQL highlighting applies.
        query_language: QueryLanguage::Sql,
    },
];

/// The descriptor for `id`. `None` is unreachable for a value that came off the wire (serde
/// already rejected anything not in [`DbEngineId`]), so this is `Option` for the table's sake
/// rather than for the caller's.
pub fn spec_for(id: DbEngineId) -> Option<&'static EngineSpec> {
    ENGINES.iter().find(|e| e.id == id)
}

/// The descriptor for `id`, or an `invalid-config` error naming it.
pub fn require_spec(id: DbEngineId) -> Result<&'static EngineSpec, DbError> {
    spec_for(id).ok_or_else(|| {
        DbError::invalid_config(format!("No descriptor for engine {id:?} — this is a bug."))
    })
}

/* ──────────────────────────────── validation ──────────────────────────────── */

/// Validate an input against its descriptor, **server-authoritatively**.
///
/// This deliberately re-checks what `validateDraft` in `engineFields.ts` already checks. The
/// frontend's copy exists to put a message next to the field the user is looking at; this one
/// exists because the backend never trusts the client to have sanitised something that matters, and `port`, `row_limit` and `timeout_ms`
/// all reach a real driver.
///
/// ## What is deliberately NOT an error
///
/// **An option key the descriptor does not declare.** Refusing an "unknown option key" and
/// *preserving* unknown query parameters cannot both hold, and preservation wins — dropping `?target_session_attrs=read-write`
/// simply breaks the connection, and the dialog already surfaces unmodelled keys as a
/// non-blocking warning. So an undeclared key passes through to the driver, exactly as the
/// dialog told the user it would.
///
/// The keys that *are* refused are the two that would defeat a guarantee: a key colliding
/// with the family's own TLS parameter (which would let the query string quietly contradict
/// the SSL control) and a key on the credential denylist (which would put a secret in a
/// plaintext file).
pub fn validate(spec: &EngineSpec, input: &DbConnectionInput) -> Result<(), DbError> {
    if input.name.trim().is_empty() {
        return Err(DbError::invalid_config("Name is required."));
    }
    if input.host.trim().is_empty() {
        return Err(DbError::invalid_config("Host is required."));
    }
    // 🔴 **An empty port is valid** and means "the engine's default" (see `EngineSpec::default_port`
    // and `DbConnection::port`). It used to be mandatory, so a port was always stored and always
    // rendered into the connection string — pasting an Atlas host with no port gave
    // `mongodb://…:27017/` back. `Some(0)` is still refused: serde already rejects a negative or
    // >65535 value for a `u16`, so 0 is the only unusable number that can reach here.
    if input.port == Some(0) {
        return Err(DbError::invalid_config(
            "Port must be a whole number from 1 to 65535, or empty for the default.",
        ));
    }
    // …and the pair that cannot both be true. Refused, never resolved: see
    // `crate::db::url::reject_port_with_srv` for why dropping one silently is the outcome this
    // exists to prevent.
    crate::db::url::reject_port_with_srv(input.srv, input.port)?;
    // The companion rule: SRV forces TLS on in the driver, so `disable` would be a control that
    // reports one thing and does another. See the function's doc for why refusing beats overriding.
    crate::db::url::reject_disabled_tls_with_srv(input.srv, input.ssl_mode)?;
    if !spec.ssl_modes.contains(&input.ssl_mode) {
        return Err(DbError::invalid_config(format!(
            "{} does not offer SSL mode `{}`.",
            spec.label,
            ssl_mode_name(input.ssl_mode)
        )));
    }
    if input.row_limit == 0 || input.row_limit > MAX_ROW_LIMIT {
        return Err(DbError::invalid_config(format!(
            "Row limit must be a whole number from 1 to {MAX_ROW_LIMIT}."
        )));
    }
    if input.timeout_ms < MIN_TIMEOUT_MS || input.timeout_ms > MAX_TIMEOUT_MS {
        return Err(DbError::invalid_config(format!(
            "Timeout must be a whole number of milliseconds from {MIN_TIMEOUT_MS} to \
             {MAX_TIMEOUT_MS}."
        )));
    }
    if !crate::db::secret::is_ref(&input.password_ref) && !input.password_ref.is_empty() {
        return Err(DbError::invalid_config(
            "`passwordRef` must be empty or a `{{VAR}}` Vault reference — never a password.",
        ));
    }

    // Declared fields: required-but-empty, a `number` that is not one, a `select` off its list.
    for f in spec.extra_fields {
        let value = input.options.get(f.key).map(|s| s.trim()).unwrap_or("");
        if value.is_empty() {
            if f.required {
                return Err(DbError::invalid_config(format!("{} is required.", f.label)));
            }
            continue;
        }
        match f.kind {
            DbFieldKind::Number if value.parse::<u64>().is_err() => {
                return Err(DbError::invalid_config(format!(
                    "{} must be a whole number.",
                    f.label
                )));
            }
            DbFieldKind::Select => {
                let choices = f.choices.unwrap_or(&[]);
                if !choices.is_empty() && !choices.contains(&value) {
                    return Err(DbError::invalid_config(format!(
                        "{} must be one of: {}.",
                        f.label,
                        choices.join(", ")
                    )));
                }
            }
            _ => {}
        }
    }

    check_option_keys(spec, &input.options)?;
    Ok(())
}

/// Refuse the two classes of option key that would defeat a guarantee. See [`validate`].
fn check_option_keys(spec: &EngineSpec, options: &BTreeMap<String, String>) -> Result<(), DbError> {
    for key in options.keys() {
        let lower = key.to_ascii_lowercase();
        if crate::db::url::is_credential_param(&lower) {
            return Err(DbError::invalid_config(format!(
                "`{key}` would put a credential in a plaintext file. Use the password field \
                 instead — it goes to the Vault, and the connection record keeps only a \
                 `{{{{VAR}}}}` reference."
            )));
        }
        if crate::db::url::family_ssl_param_names(spec.family)
            .iter()
            .any(|n| n.eq_ignore_ascii_case(&lower))
        {
            return Err(DbError::invalid_config(format!(
                "`{key}` is how {}'s connection string carries the SSL mode, so setting it as \
                 an option would let the string contradict the SSL control. Use the SSL mode \
                 field.",
                spec.label
            )));
        }
    }
    Ok(())
}

/// The libpq-style name of a mode, used in messages and in every `sslmode=` we emit.
pub fn ssl_mode_name(mode: SslMode) -> &'static str {
    match mode {
        SslMode::Disable => "disable",
        SslMode::Prefer => "prefer",
        SslMode::Require => "require",
        SslMode::VerifyCa => "verify-ca",
        SslMode::VerifyFull => "verify-full",
    }
}

/// Parse a libpq-style SSL mode name. `allow` is accepted as an alias for `prefer` — it is a
/// real libpq mode we do not offer separately, and refusing a pasted `sslmode=allow` would be
/// pedantry with a support cost.
pub fn ssl_mode_from_name(s: &str) -> Option<SslMode> {
    match s.to_ascii_lowercase().as_str() {
        "disable" | "disabled" => Some(SslMode::Disable),
        "prefer" | "preferred" | "allow" => Some(SslMode::Prefer),
        "require" | "required" => Some(SslMode::Require),
        "verify-ca" | "verify_ca" => Some(SslMode::VerifyCa),
        "verify-full" | "verify_identity" | "verify-identity" => Some(SslMode::VerifyFull),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The **routing** half. It proves every row is reachable, internally
    /// consistent and non-degenerate.
    ///
    /// It deliberately **does not pin any value** — a row's label, port or default could be
    /// rewritten and this test would stay green. That is what the golden snapshot below is
    /// for, and separating the two is the whole lesson.
    #[test]
    fn routing_every_row_is_reachable_unique_and_internally_consistent() {
        assert_eq!(
            ENGINES.len(),
            9,
            "the contract lists NINE DbEngineId values"
        );

        let mut ids = Vec::new();
        for spec in ENGINES {
            // Reachable by its own id, and `spec_for` returns *this* row.
            let found = spec_for(spec.id).expect("every row is reachable by its id");
            assert_eq!(found.id, spec.id);
            assert!(!ids.contains(&spec.id), "duplicate engine id {:?}", spec.id);
            ids.push(spec.id);

            assert!(!spec.label.is_empty(), "{:?} has no label", spec.id);
            assert_ne!(spec.default_port, 0, "{:?} has port 0", spec.id);
            // 🔴 **Exactly one engine may declare no scheme, and it is a property of the engine
            // rather than an exemption.** DynamoDB has no connection string at all: a
            // `dynamodb://` URI exists nowhere, so `build`/`parse` are never called for it and the
            // dialog hides its URL box. Every other row MUST declare a scheme, or `build` could not
            // name one.
            if spec.family == DbFamily::Dynamodb {
                assert!(
                    spec.url_schemes.is_empty(),
                    "DynamoDB has no connection string, so it must declare no scheme"
                );
                assert!(
                    spec.database_label.is_none(),
                    "a DynamoDB region has no databases"
                );
            } else {
                assert!(
                    !spec.url_schemes.is_empty(),
                    "{:?} lists no URL scheme, so `build` could not name one",
                    spec.id
                );
            }
            // 🔴 The TLS control is a property of how the engine is ADDRESSED, not a blanket rule.
            // A host-and-port engine must offer a ladder and default to a rung on it. A
            // URL-addressed one must offer NONE: `https://` vs `http://` in the address already IS
            // the choice, and a second control free to contradict the first is the most important
            // divergence to rule out.
            assert!(
                !spec.ssl_modes.is_empty(),
                "{:?} offers no SSL mode at all",
                spec.id
            );
            assert!(
                spec.ssl_modes.contains(&spec.defaults.ssl_mode),
                "{:?} defaults to an SSL mode it does not offer",
                spec.id
            );
            assert!(
                spec.defaults.row_limit > 0 && spec.defaults.row_limit <= MAX_ROW_LIMIT,
                "{:?} default row limit out of range",
                spec.id
            );
            assert!(
                (MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&spec.defaults.timeout_ms),
                "{:?} default timeout out of range",
                spec.id
            );

            // Field keys unique within a row, and no field may be blank or nameless.
            let mut keys = Vec::new();
            for f in spec.extra_fields {
                assert!(!f.key.is_empty(), "{:?} has an unnamed field", spec.id);
                assert!(
                    !keys.contains(&f.key),
                    "{:?} declares `{}` twice",
                    spec.id,
                    f.key
                );
                keys.push(f.key);
                assert!(!f.label.is_empty(), "{:?}.{} has no label", spec.id, f.key);
                // A `select` must offer choices, or the dialog renders an empty picker.
                if f.kind == DbFieldKind::Select {
                    assert!(
                        f.choices.is_some_and(|c| !c.is_empty()),
                        "{:?}.{} is a select with no choices",
                        spec.id,
                        f.key
                    );
                }
                // A default must be a value the field could hold.
                if let (DbFieldKind::Select, Some(choices)) = (f.kind, f.choices) {
                    assert!(
                        f.default.is_empty() || choices.contains(&f.default),
                        "{:?}.{} defaults to `{}`, which is not one of its choices",
                        spec.id,
                        f.key,
                        f.default
                    );
                }
                if f.kind == DbFieldKind::Number && !f.default.is_empty() {
                    assert!(
                        f.default.parse::<u64>().is_ok(),
                        "{:?}.{} is a number defaulting to `{}`",
                        spec.id,
                        f.key,
                        f.default
                    );
                }
                // A required field with no default would make a fresh form invalid before the
                // user has typed anything, which is the bug `default` was added for — allowed,
                // but only when the descriptor genuinely cannot know the value.
                //
                // 🔴 **DynamoDB's `region` is that case, and the comment above already anticipated
                // it.** A region is the engine's *address* — it plays exactly the role `host` plays
                // for every other engine, and `host` is a required top-level field with no default
                // too, so a fresh DynamoDB form starts invalid for the same honest reason a fresh
                // Postgres form does. Defaulting it to `us-east-1` would point queries at the wrong
                // continent's tables and look like an empty account, which is what the field's own
                // hint says. The exception is therefore named for the one field it applies to,
                // rather than the rule being weakened for everybody.
                let is_the_engines_address = spec.family == DbFamily::Dynamodb && f.key == "region";
                if f.required && !is_the_engines_address {
                    assert!(
                        !f.default.is_empty(),
                        "{:?}.{} is required but has no default, so a fresh form starts invalid",
                        spec.id,
                        f.key
                    );
                }
            }

            // Every family must have a *declared* driver story, wired or not: `engine_for`
            // either returns an engine or an error naming the engine. A silent `None` would
            // mean a row the dialog offers and nothing can ever connect to.
            let wired = crate::db::engine::engine_for(spec.id);
            match wired {
                Ok(engine) => assert_eq!(engine.spec().id, spec.id),
                Err(e) => assert!(
                    e.message.contains(spec.label),
                    "{:?}'s not-wired error must name the engine: {}",
                    spec.id,
                    e.message
                ),
            }
        }
    }

    /// Which engines actually have a driver; asserted separately so "which engine works" is a
    /// stated fact rather than an implication of the loop above.
    #[test]
    fn every_engine_the_registry_offers_has_a_driver_behind_it() {
        // 🔴 The point of this test is that the dialog cannot offer an engine the app cannot dial.
        // It used to list the wired ids by hand and assert the remaining ones FAILED;
        // now it walks the registry, so adding a descriptor row without a driver turns it red
        // instead of shipping a dropdown entry that errors on Test Connection.
        for spec in ENGINES {
            assert!(
                crate::db::engine::engine_for(spec.id).is_ok(),
                "{:?} is offered by the registry but has no driver",
                spec.id
            );
        }
        // All nine, spelled out, so a row silently REMOVED from the registry is also visible.
        assert_eq!(ENGINES.len(), 9);
    }

    /// The **values** half: a committed golden snapshot of exactly what
    /// `db_engines()` puts on the wire.
    ///
    /// It fails on any row change, names the exact line in the diff, and needs no
    /// hand-maintenance — and unlike the routing loop it *cannot* pass when a default is
    /// wrong. **Read the diff** before regenerating: this file is where "Postgres now defaults
    /// to read-write TLS-less" would show up as one reviewable line.
    ///
    /// To regenerate deliberately:
    /// `cargo test --manifest-path src-tauri/Cargo.toml db_engines_snapshot -- --nocapture`
    /// prints the actual JSON on failure; paste it into `engines.golden.json`.
    #[test]
    fn db_engines_snapshot_matches_the_committed_golden_file() {
        let actual = serde_json::to_string_pretty(ENGINES).expect("the registry serialises");
        let golden = include_str!("engines.golden.json").trim_end();
        if actual != golden {
            eprintln!("──── actual db_engines() output ────\n{actual}\n──── end ────");
        }
        assert_eq!(
            actual, golden,
            "the engine registry changed. Read the diff, then update \
             src-tauri/src/db/engines.golden.json deliberately."
        );
    }

    #[test]
    fn the_snapshot_is_the_shape_the_frontend_contract_declares() {
        // A guard on the snapshot itself: it is only a useful golden if it is camelCase and
        // carries no `readOnly` default (the safety property from the module doc). Cheap, and
        // it means a serde attribute cannot regress unnoticed even if someone regenerates the
        // golden without reading it.
        let json = serde_json::to_string(ENGINES).unwrap();
        for key in [
            "defaultPort",
            "urlSchemes",
            "databaseLabel",
            "supportsUser",
            "sslModes",
            "extraFields",
            "serverEnforcedReadOnly",
            "queryLanguage",
            "allowMultiStatement",
            "rowLimit",
            "timeoutMs",
        ] {
            assert!(json.contains(key), "missing `{key}` on the wire");
        }
        assert!(
            !json.contains("\"readOnly\""),
            "a descriptor must not be able to express readOnly"
        );
        assert!(
            !json.contains("\"password\""),
            "no field kind may be `password`"
        );
    }

    /* ───────────────────────────── validation ───────────────────────────── */

    fn pg_input() -> DbConnectionInput {
        serde_json::from_str(
            r#"{"name":"Prod","engine":"postgres","host":"db.internal","port":5432,
                "database":"maestro","user":"ro","passwordRef":"",
                "savePassword":"never","sslMode":"prefer","options":{},
                "readOnly":true,"rowLimit":500,"timeoutMs":30000}"#,
        )
        .unwrap()
    }

    fn pg_spec() -> &'static EngineSpec {
        spec_for(DbEngineId::Postgres).unwrap()
    }

    #[test]
    fn a_well_formed_input_validates() {
        validate(pg_spec(), &pg_input()).expect("the happy path must validate");
    }

    /// One validation case: a name for the failure message, a mutation that breaks the input, and
    /// a fragment the resulting error must contain. Named because clippy's `type_complexity` is
    /// right — the inline spelling was unreadable.
    type ValidationCase = (
        &'static str,
        Box<dyn Fn(&mut DbConnectionInput)>,
        &'static str,
    );

    #[test]
    fn validation_rejects_each_bad_field_with_the_message_that_names_it() {
        let cases: Vec<ValidationCase> = vec![
            (
                "blank name",
                Box::new(|i: &mut DbConnectionInput| i.name = "  ".into()),
                "Name is required.",
            ),
            (
                "blank host",
                Box::new(|i: &mut DbConnectionInput| i.host = "".into()),
                "Host is required.",
            ),
            (
                "port 0",
                Box::new(|i: &mut DbConnectionInput| i.port = Some(0)),
                "Port must be",
            ),
            (
                "a port together with srv",
                Box::new(|i: &mut DbConnectionInput| i.srv = true),
                "cannot have a port",
            ),
            (
                "row limit 0",
                Box::new(|i: &mut DbConnectionInput| i.row_limit = 0),
                "Row limit must be",
            ),
            (
                "row limit over the ceiling",
                Box::new(|i: &mut DbConnectionInput| i.row_limit = MAX_ROW_LIMIT + 1),
                "Row limit must be",
            ),
            (
                "timeout too small",
                Box::new(|i: &mut DbConnectionInput| i.timeout_ms = 999),
                "Timeout must be",
            ),
            (
                "timeout too large",
                Box::new(|i: &mut DbConnectionInput| i.timeout_ms = MAX_TIMEOUT_MS + 1),
                "Timeout must be",
            ),
            (
                "a literal password in passwordRef",
                Box::new(|i: &mut DbConnectionInput| i.password_ref = "hunter2".into()),
                "never a password",
            ),
            (
                "a number option that is not a number",
                Box::new(|i: &mut DbConnectionInput| {
                    i.options.insert("connectTimeout".into(), "soon".into());
                }),
                "must be a whole number",
            ),
            (
                "a select option off its list",
                Box::new(|i: &mut DbConnectionInput| {
                    i.options
                        .insert("targetSessionAttrs".into(), "sideways".into());
                }),
                "must be one of",
            ),
            (
                "a credential smuggled in as an option",
                Box::new(|i: &mut DbConnectionInput| {
                    i.options.insert("password".into(), "hunter2".into());
                }),
                "plaintext file",
            ),
            (
                "an option that would contradict the SSL control",
                Box::new(|i: &mut DbConnectionInput| {
                    i.options.insert("sslmode".into(), "disable".into());
                }),
                "contradict the SSL control",
            ),
        ];
        for (label, mutate, want) in cases {
            let mut input = pg_input();
            mutate(&mut input);
            let err = validate(pg_spec(), &input)
                .unwrap_err_or_else_msg(&format!("{label} must be rejected"));
            assert!(
                err.message.contains(want),
                "{label}: message {:?} does not contain {want:?}",
                err.message
            );
            assert_eq!(err.code, crate::db::error::DbErrorCode::InvalidConfig);
        }
    }

    /// Tiny helper so the table above reads as a table. `Result::unwrap_err` cannot carry a
    /// custom message and `expect_err` needs `T: Debug`, which `()` has but the message would
    /// not name the case.
    trait UnwrapErrMsg<E> {
        fn unwrap_err_or_else_msg(self, msg: &str) -> E;
    }
    impl<E> UnwrapErrMsg<E> for Result<(), E> {
        fn unwrap_err_or_else_msg(self, msg: &str) -> E {
            match self {
                Ok(()) => panic!("{msg}"),
                Err(e) => e,
            }
        }
    }

    /// 🔴 **An empty port validates.** It used to be mandatory, and the dialog
    /// pre-filled the descriptor's default, so a port was always stored and always rendered into
    /// the built string. This is the assertion that an empty box is now a legal record — remove the
    /// `Some(0)` narrowing in `validate` and put `input.port.is_none()` back into the refusal, and
    /// this test is what goes red.
    #[test]
    fn an_empty_port_is_valid_and_means_the_engines_default() {
        let mut input = pg_input();
        input.port = None;
        validate(pg_spec(), &input).expect("an empty port must be accepted, not refused");
    }

    /// 🔴 **A port plus `srv` is refused, and the message names the conflict.** Mutually exclusive
    /// by construction — SRV reads host *and* port out of DNS — and the alternative to refusing is
    /// the app choosing which of the user's two answers to throw away.
    #[test]
    fn a_port_together_with_srv_is_refused_naming_both_halves() {
        let mongo = spec_for(DbEngineId::Mongodb).unwrap();
        let mut input = pg_input();
        input.engine = DbEngineId::Mongodb;
        input.ssl_mode = SslMode::VerifyFull;
        input.options.insert("authSource".into(), "admin".into());
        input.host = "cluster0.abcde.mongodb.net".into();
        input.srv = true;
        input.port = Some(27017);

        let err = validate(mongo, &input).expect_err("a port and srv cannot both hold");
        assert_eq!(err.code, crate::db::error::DbErrorCode::InvalidConfig);
        assert!(
            err.message.contains("cannot have a port"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("27017"),
            "the message must name the port it is complaining about: {}",
            err.message
        );
        assert!(
            err.message.contains("SRV"),
            "…and the other half of the conflict: {}",
            err.message
        );

        // The same record with the port cleared is exactly what a user is being asked for, and it
        // must validate — otherwise the error above would be advice that does not work.
        input.port = None;
        validate(mongo, &input).expect("srv with no port is the Atlas shape");
    }

    #[test]
    fn an_ssl_mode_the_engine_does_not_offer_is_refused() {
        // Mongo has no opportunistic mode, and `prefer` there would be a control that silently
        // does nothing — worse than an error.
        let mut input = pg_input();
        input.engine = DbEngineId::Mongodb;
        input.ssl_mode = SslMode::Prefer;
        input.options.insert("authSource".into(), "admin".into());
        let mongo = spec_for(DbEngineId::Mongodb).unwrap();
        let err = validate(mongo, &input).expect_err("prefer is not on Mongo's ladder");
        assert!(err.message.contains("prefer"), "{}", err.message);
        assert!(err.message.contains("MongoDB"), "{}", err.message);
    }

    #[test]
    fn a_required_descriptor_field_left_empty_is_refused_by_its_label() {
        let mut input = pg_input();
        input.engine = DbEngineId::Mongodb;
        input.ssl_mode = SslMode::Require;
        // `authSource` is required on Mongo and has a descriptor default; clearing it is still
        // an error, because at that point the box the user is looking at really is empty.
        input.options.insert("authSource".into(), "   ".into());
        let err = validate(spec_for(DbEngineId::Mongodb).unwrap(), &input).expect_err("required");
        assert_eq!(err.message, "Auth source is required.");
    }

    #[test]
    fn an_option_key_the_descriptor_does_not_model_is_preserved_not_refused() {
        // Unknown query parameters are kept verbatim. Dropping
        // `target_session_attrs=read-write` breaks the connection; refusing the save makes a
        // vendor-supplied string unusable. The dialog already warns about them.
        let mut input = pg_input();
        input
            .options
            .insert("some_vendor_flag".into(), "yes".into());
        validate(pg_spec(), &input).expect("an unmodelled key must pass through");
    }

    #[test]
    fn a_vault_reference_in_password_ref_is_accepted() {
        let mut input = pg_input();
        input.password_ref = "{{PG_PROD_PASSWORD}}".into();
        validate(pg_spec(), &input).expect("a {{VAR}} reference is the normal case");
    }

    #[test]
    fn ssl_mode_names_round_trip_through_their_libpq_spelling() {
        for mode in SSL_ALL {
            assert_eq!(
                ssl_mode_from_name(ssl_mode_name(*mode)),
                Some(*mode),
                "{mode:?}"
            );
        }
        // Aliases, written out literally.
        assert_eq!(ssl_mode_from_name("allow"), Some(SslMode::Prefer));
        assert_eq!(ssl_mode_from_name("REQUIRED"), Some(SslMode::Require));
        assert_eq!(
            ssl_mode_from_name("VERIFY_IDENTITY"),
            Some(SslMode::VerifyFull)
        );
        assert_eq!(ssl_mode_from_name("VERIFY_CA"), Some(SslMode::VerifyCa));
        assert_eq!(ssl_mode_from_name("DISABLED"), Some(SslMode::Disable));
        assert_eq!(ssl_mode_from_name("sideways"), None);
        assert_eq!(ssl_mode_from_name(""), None);
    }
}
