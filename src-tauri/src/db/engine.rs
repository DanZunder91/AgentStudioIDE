//! The engine seam and the PostgreSQL implementation (plus the MySQL one beside it).
//!
//! ## The seam, and why it is a trait
//!
//! Same philosophy as `AgentAdapter` and `lsp::registry`'s `Prober`: every
//! engine-specific line lives behind [`DbEngine`] / [`DbSession`], so adding MySQL, ClickHouse,
//! Mongo or Redis cannot reach into the command layer, the store or the guard. [`engine_for`]
//! is the only door, and an engine that is not wired returns an error that **names the
//! engine** rather than a silent `None` — a row the dialog offers and nothing can connect
//! to would be the worst of both.
//!
//! ## The read-only guarantee, and the measurement that shaped it
//!
//! Read-only is the boundary, and the **server** must enforce it. For Postgres
//! that is `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`. The non-obvious part, which
//! was measured against the Docker fixture in both directions:
//!
//! ```text
//! psql -c "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; INSERT …"
//!    → SET / INSERT 0 1        ← the write SUCCEEDED
//! psql -c "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY" -c "INSERT …"
//!    → ERROR: cannot execute INSERT in a read-only transaction
//! ```
//!
//! A simple-query batch runs inside one implicit transaction that has **already begun** with
//! the old characteristics, so a `SET` at the head of the batch does not bind the statements
//! behind it. Since [`sqlx::raw_sql`] takes multiple `;`-separated statements, the natural
//! implementation — prepend the `SET` to the user's script — would silently void the single
//! most important guardrail in this feature. So the `SET` is **its own round trip at connect**
//! ([`PostgresEngine::open`]) and is never concatenated with user SQL.
//!
//! `src-tauri/tests/db_live.rs::read_only_survives_a_multi_statement_script` is the proof, and
//! it asserts on **the absence of the row**, not on the presence of an error: the first attempt
//! at that measurement failed with a NOT NULL violation, which looks exactly like the guard
//! working while the guard had in fact let the write through.
//!
//! ## Every value is read as text
//!
//! [`sqlx::raw_sql`] executes unprepared, which puts the Postgres connection in the **simple
//! query protocol**, where the server text-encodes every type it has — including ones an
//! extension added this morning. So one `try_get_unchecked::<Option<String>, _>(i)` per cell
//! yields exactly what `psql` would print, `None` is SQL NULL and `Some("")` is the empty
//! string. `try_get_unchecked` is load-bearing: the checked `try_get` would consult
//! `Type::compatible` and reject `String` for an `int4` column.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::StreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgSslMode};
use sqlx::{AssertSqlSafe, Column, Connection, Either, Row, TypeInfo};

use crate::db::engines::{self, EngineSpec};
use crate::db::error::{map_sqlx_error, DbError, DbErrorCode};
use crate::db::guard;
use crate::db::model::{DbEngineId, DbFamily, DbRunMode, SslMode};
use crate::db::result::{cell_kind, DbColumn, DbResultKind, DbResultSet};
use crate::db::tree::{count_label, DbGroup, DbNode, DbNodeKind, DbNodeRef};

/* ─────────────────────────────── the seam's types ─────────────────────────────── */

/// Everything an engine needs to dial, **with the secret resolved**.
///
/// In-process only: this is built inside `db_open` / `db_test_connection` and never crosses
/// the IPC boundary in either direction. Its [`std::fmt::Debug`] is hand-written so a
/// stray `dbg!`, a `tracing` field or a panic message cannot print the password — the class of
/// leak that is only ever found when someone pastes a log.
#[derive(Clone)]
pub struct ResolvedConfig {
    pub engine: DbEngineId,
    pub family: DbFamily,
    pub host: String,
    /// `None` = the record's port field was empty. **Not resolved on the way in on purpose**: the
    /// engine is what knows whether a port is even meaningful, and for `mongodb+srv` it is not —
    /// substituting 27017 here would put a port into a place that must not have one. Every engine
    /// that does need a number gets it from [`Self::port_or_default`].
    pub port: Option<u16>,
    /// `mongodb+srv://` — DNS seed-list discovery (Atlas). Meaningful only to
    /// [`crate::db::mongo`]; the other engines have no seed-list form and ignore it.
    pub srv: bool,
    pub database: String,
    pub user: String,
    /// **Radioactive.** Empty means "no password", which is a legitimate configuration.
    pub password: String,
    pub ssl_mode: SslMode,
    /// The CA chain as PEM bytes, read and validated at the user's gesture.
    pub ca_pem: Option<Vec<u8>>,
    pub options: BTreeMap<String, String>,
    /// A raw connection string that **wins over the fields above**, already `{{VAR}}`-resolved
    /// and therefore secret-bearing. `None` for the ordinary form-driven case.
    pub url: Option<String>,
    pub read_only: bool,
    pub row_limit: u32,
    pub timeout_ms: u32,
    pub allow_multi_statement: bool,
}

impl std::fmt::Debug for ResolvedConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedConfig")
            .field("engine", &self.engine)
            .field("family", &self.family)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("srv", &self.srv)
            .field("database", &self.database)
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .field("ssl_mode", &self.ssl_mode)
            .field("ca_pem", &self.ca_pem.as_ref().map(|p| p.len()))
            .field("options", &self.options)
            // A URL can carry the password in its userinfo, so it is redacted wholesale
            // rather than trusted to have been split — this struct is the *resolved* one.
            .field("url", &self.url.as_ref().map(|_| "<redacted>"))
            .field("read_only", &self.read_only)
            .field("row_limit", &self.row_limit)
            .field("timeout_ms", &self.timeout_ms)
            .field("allow_multi_statement", &self.allow_multi_statement)
            .finish()
    }
}

impl ResolvedConfig {
    /// The port to dial: the record's, or **the descriptor's `default_port`** when the field was
    /// left empty.
    ///
    /// One function for every engine, so "what does an empty port mean" is answered in exactly one
    /// place. The descriptor rather than each driver's own default, for a measured reason:
    /// `sqlx-postgres`'s `PgConnectOptions::new_without_pgpass()` defaults its port to
    /// **`$PGPORT` or 5432** (`sqlx-postgres-0.9.0/src/options/mod.rs:57`), while
    /// `MySqlConnectOptions::new()` hardcodes 3306 and ClickHouse has no driver default at all
    /// because *we* build the URL. Taking "the driver's default" would therefore mean three
    /// different rules, one of which depends on the environment the app was launched from — and it
    /// would make the dialog's placeholder (`EngineSpec::default_port`, which is what the user
    /// *sees* in the empty box) a lie whenever `PGPORT` was set. The number is the same 5432/3306
    /// either way; what differs is whether it is predictable.
    ///
    /// ⚠️ Meaningless when [`Self::srv`] is set — an SRV connection has no port, and
    /// [`crate::db::mongo`] never calls this on that path.
    pub fn port_or_default(&self) -> u16 {
        match self.port {
            Some(port) => port,
            None => engines::spec_for(self.engine)
                .map(|s| s.default_port)
                // Unreachable: `engine` came off `DbEngineId`, and every variant has a row (the
                // registry's routing test asserts it). A `0` here would fail to connect loudly
                // rather than dial something arbitrary.
                .unwrap_or(0),
        }
    }

    /// `host:port` for a message, or just the host when there is no port to name. Used by the
    /// timeout paths, which would otherwise print `db.internal:0` for an empty port field.
    pub fn host_label(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}", self.host),
            None => self.host.clone(),
        }
    }

    /// What the URL override says about the credential, or "nothing" when there is no override.
    ///
    /// One call site's worth of code, kept here so *every* engine asks the question the same way
    /// and gets the same answer — see [`crate::db::url::credential_of`] for the rule and for the
    /// bug that came of two engines answering it differently.
    pub fn url_credential(&self) -> crate::db::url::UrlCredential {
        self.url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(crate::db::url::credential_of)
            .unwrap_or_default()
    }

    /// The secrets that must not appear in any message leaving this module.
    fn secrets(&self) -> Vec<&str> {
        let mut v = Vec::new();
        if !self.password.is_empty() {
            v.push(self.password.as_str());
        }
        v
    }
}

/// What a live session knows about the server it is talking to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    /// The server's own version string — the proof a real round trip happened rather than a
    /// socket merely opening.
    pub version: String,
    /// The backend/session id, when the engine has one. Postgres's is what `db_cancel` needs.
    pub backend_pid: Option<i32>,
}

/// The text the console asked to run, and how to treat it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Script {
    pub text: String,
    pub mode: DbRunMode,
}

/// The per-run guardrails. `read_only` is deliberately **absent**: it is applied once, at
/// connect, by the server (see the module doc). A per-run read-only flag would imply it could
/// be turned off per run, which is exactly the guarantee we are not making.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub row_limit: u32,
    pub timeout_ms: u32,
    pub allow_multi_statement: bool,
}

// `async_trait` marks its boxed futures `#[must_use]`; clippy ≥ 1.99 flags that as
// double_must_use on every async method. The futures are awaited; nothing to fix here.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait DbEngine: Send + Sync {
    fn spec(&self) -> &'static EngineSpec;
    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn DbSession>, DbError>;
}

/// Cancels a session's running statement, from outside the session.
///
/// Owned independently of [`DbSession`] so it stays reachable while a query holds the session's
/// mutex — see [`DbSession::cancel_handle`]. `Send + Sync` because it is stored in the session
/// registry and called from a different task than the one running the query.
// `async_trait` marks its boxed futures `#[must_use]`; clippy ≥ 1.99 flags that as
// double_must_use on every async method. The futures are awaited; nothing to fix here.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait DbCancel: Send + Sync {
    /// Ask the server to stop the statement this session is running.
    ///
    /// Returns `Ok(())` when the request was **delivered**, which is not the same as "the query has
    /// stopped": every engine's cancel is advisory and asynchronous. The caller must not report
    /// more than was done.
    async fn cancel(&self) -> Result<(), DbError>;
}

// `async_trait` marks its boxed futures `#[must_use]`; clippy ≥ 1.99 flags that as
// double_must_use on every async method. The futures are awaited; nothing to fix here.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait DbSession: Send {
    /// A round trip that asks the server what it is. Used by Test Connection.
    async fn probe(&mut self) -> Result<ServerInfo, DbError>;
    /// Ensure this session's connection is still usable, re-establishing it if it is not.
    ///
    /// 🔴 **The bug: Test Connection passed, but no query would run.** A
    /// session is one connection cached in this process for the lifetime of the app
    /// ([`crate::db::session`]), and until this method existed nothing ever asked whether its socket
    /// was still there. A laptop suspend, a pooler's idle timeout, a NAT table expiring, a server
    /// restart — every one of those closes a long-lived TCP socket, and every one of them turned
    /// each later `db_query` on that session into a write to a corpse: `UnexpectedEof`, classified
    /// by `error.rs` into *"the server accepted the connection and then closed it without
    /// answering"*. Worse, **Test Connection kept saying the connection was fine**, because
    /// [`crate::db::test_connection`] dials a fresh connection every call and never touches the
    /// cache — so the one diagnostic a user reaches for agreed with them that the server was up.
    /// The only cure was restarting the app, which empties the map. That is the defect this
    /// removes: the user keeps their session id, and it keeps working.
    ///
    /// **A reconnect is a NEW server session, and that is a property of the feature, not a
    /// footnote.** Temp tables, `SET`s the user issued themselves, advisory locks, open cursors and
    /// an uncommitted `BEGIN` are all gone. They died with the socket — this call does not destroy
    /// them, it finds them already destroyed — but someone who ran `BEGIN; UPDATE …` and comes back
    /// to a silently fresh session could reasonably believe their transaction was still open. So an
    /// implementation re-applies **only the setup this app itself owns** (the read-only guardrail
    /// and the statement timeout, in `open`'s order) and never tries to replay anything the user
    /// ran. Guessing at their session state would be worse than losing it.
    ///
    /// The default is a **no-op**, and it is safe for the engines that take it because they hold no
    /// single long-lived socket that can go stale under them:
    ///
    /// * **ClickHouse** and **DynamoDB** are per-request HTTP over a `reqwest::Client`, whose pool
    ///   discards a dead connection and dials another for the next request.
    /// * **MongoDB** holds a `mongodb::Client`, which owns a monitored, self-healing connection
    ///   pool — reconnecting is the driver's job, and it does it.
    /// * ⚠️ **Redis does NOT belong on that list, and taking the default there is a KNOWN GAP.**
    ///   `crate::db::redis::RedisSession` holds a `redis::aio::MultiplexedConnection` — one socket,
    ///   for the life of the session, with no reconnect logic anywhere in it (`ConnectionManager` is
    ///   redis-rs's reconnecting type and we do not use it). A Redis session therefore has exactly
    ///   the bug described above and is not yet fixed. Written down here rather than smoothed into
    ///   the comfortable list, because a doc that quietly implies a guarantee we do not make is how
    ///   the next person stops looking.
    async fn ensure_live(&mut self, _limits: &Limits) -> Result<(), DbError> {
        Ok(())
    }
    /// Run `script` under `limits`. A **database** error resolves as a `message` result
    /// alongside whatever succeeded; only a transport failure is an `Err` (the `http_send`
    /// contract — a 500 is a response, not an exception).
    async fn run(&mut self, script: &Script, limits: &Limits) -> Result<Vec<DbResultSet>, DbError>;
    /// Run `script` the way [`DbSession::run`] does, but with read-only as a **boundary** rather
    /// than a default: on a session opened read-only, an engine whose read-only is session state
    /// holds the run in a `READ ONLY` transaction that is always rolled back. The agent tools'
    /// path. Decided on the session itself, so a connection made read-only a moment before the
    /// open still gets it.
    ///
    /// Why a second path at all: a read-only session is only `SET SESSION CHARACTERISTICS AS
    /// TRANSACTION READ ONLY` (a *default* for later transactions) plus
    /// [`guard::read_only_escape`], which by its own doc is a speed bump and not a boundary. An
    /// agent can be prompt-injected, so for an agent the boundary has to hold against a hostile
    /// statement: `DO $$ … set_config('default_transaction_read_only','off',false); COMMIT;
    /// INSERT … $$` passed the filter and wrote. Inside an explicit read-only transaction block
    /// that same `COMMIT` is "invalid transaction termination", `set_config('transaction_read_only'
    /// …)` is refused, and every write is refused by the server.
    ///
    /// What keeps the transaction in place, statement by statement (the SQL engines' contract):
    /// * the guards of [`DbSession::run`] first, unchanged;
    /// * each statement is sent on its own, after **the server** confirmed it is exactly one
    ///   statement (a prepare, which executes nothing). The splitter cannot be talked into sending
    ///   `SELECT '\''; COMMIT; …` as "one statement", because the server is asked, not the
    ///   splitter;
    /// * after each statement, a check that the run is still inside its own transaction (and, on
    ///   MySQL, that the session is still read-only). A statement that ended it — `COMMIT`,
    ///   `ROLLBACK`, an implicit commit — stops the run there with a refusal, so nothing runs
    ///   outside the transaction;
    /// * on MySQL, `CALL`, `EXECUTE` and executable comments are refused up front: a MySQL
    ///   procedure may `COMMIT` inside the one statement (see `mysql_unheld`);
    /// * `ROLLBACK` at the end, whatever happened.
    ///
    /// A session opened read-write has nothing to hold, and the run is [`DbSession::run`]'s. So is
    /// the default's: the other engines enforce read-only per command (Redis's and MongoDB's
    /// allowlists) or per request (ClickHouse's `readonly`, DynamoDB), which `run` already is.
    async fn run_strict(
        &mut self,
        script: &Script,
        limits: &Limits,
    ) -> Result<Vec<DbResultSet>, DbError> {
        self.run(script, limits).await
    }
    /// A handle that can cancel this session's running statement, or `None` when the engine has
    /// no server-side cancel at all.
    ///
    /// 🔴 **It is a separate handle rather than a method for one reason, and that reason is the
    /// whole of why an earlier version had no working `db_cancel`.** `db::query` holds
    /// `LiveSession::session`'s mutex for the entire duration of `run` — it must, the session is
    /// `&mut` for a query. So anything reachable only *through* the session is, by construction,
    /// unreachable exactly while a query is running: a `cancel(&self)` method would deadlock behind
    /// the statement it was asked to cancel. Three engines had complete, correct cancel code that
    /// no caller could ever reach.
    ///
    /// The handle is taken ONCE at `session::insert`, before the session goes behind the mutex, and
    /// stored beside it. It owns everything it needs (connect options, a backend id, a query-id
    /// prefix) and dials a **sibling** connection — the busy one cannot service a cancel against
    /// itself.
    ///
    /// `None` is the honest answer for MongoDB, Redis and DynamoDB, and it is **structural**: the
    /// command reports "this engine has no server-side cancel" without a round trip, rather than
    /// each engine returning a runtime `Err` that reads like a failure.
    fn cancel_handle(&self) -> Option<Arc<dyn DbCancel>> {
        None
    }
    /// One level of the connection tree, shaped like `read_dir`.
    ///
    /// Each engine describes its own hierarchy here, and there is deliberately no `hierarchy`
    /// table on `EngineSpec` to disagree with it — see `db::tree`'s module doc. The levels really
    /// do differ: MySQL and ClickHouse can see every database on the server, while a PostgreSQL
    /// connection is bound to one and cannot read another's catalog.
    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError>;
    /// Close the connection. `Box<Self>` because `sqlx`'s `close` consumes.
    async fn close(self: Box<Self>);
}

/* ─────────────────────────────── the registry door ─────────────────────────────── */

static POSTGRES: PostgresEngine = PostgresEngine {
    id: DbEngineId::Postgres,
};
/// Aurora PostgreSQL is wire-compatible with PostgreSQL and dials identically; only the
/// descriptor differs. Proven against the fixture's PostgreSQL, which is what "wire-compatible"
/// means in practice — stated plainly, no Aurora cluster was dialled.
static AURORA_POSTGRES: PostgresEngine = PostgresEngine {
    id: DbEngineId::AuroraPostgres,
};
static CLICKHOUSE: crate::db::clickhouse::ClickhouseEngine =
    crate::db::clickhouse::ClickhouseEngine;
static MYSQL: MysqlEngine = MysqlEngine {
    id: DbEngineId::Mysql,
};
static AURORA_MYSQL: MysqlEngine = MysqlEngine {
    id: DbEngineId::AuroraMysql,
};
static MONGODB: crate::db::mongo::MongoEngine = crate::db::mongo::MongoEngine;
/// Redis and Valkey share one driver: Valkey is Redis's protocol under a different name, and the
/// live tier proves the Redis half against the fixture. The Valkey row is therefore the same claim
/// the two Aurora rows make — wire compatibility, verified against the upstream server, stated
/// rather than implied.
/// DynamoDB signs its own requests over the `reqwest` already in the tree — no AWS SDK,
/// so this row costs zero packages.
static DYNAMODB: crate::db::dynamodb::DynamodbEngine = crate::db::dynamodb::DynamodbEngine;
static REDIS: crate::db::redis::RedisEngine = crate::db::redis::RedisEngine::new(DbEngineId::Redis);
static VALKEY: crate::db::redis::RedisEngine =
    crate::db::redis::RedisEngine::new(DbEngineId::Valkey);

/// The engine for `id`, or an `invalid-config` error **naming the engine**.
///
/// Wired: the **PostgreSQL family** (PostgreSQL, Aurora PostgreSQL), the **MySQL family**
/// (MySQL, Aurora MySQL), **ClickHouse** over its HTTP interface, **MongoDB** through the
/// official driver, Redis/Valkey and DynamoDB. `db_engines()` drives the whole dialog, so a new
/// engine adds a driver here and nothing else.
///
/// This function only claims what the live tier has actually run. The two Aurora rows are the
/// one place that needs care: they are wire-compatible re-uses of the engine beside them,
/// verified against the fixture's PostgreSQL/MySQL rather than against an Aurora cluster. That
/// is a real distinction and it is recorded rather than smoothed over — "wire-compatible" is a
/// claim about the protocol, and Aurora's failure modes at the *edges* (failover, reader
/// endpoints) are not exercised by anything here.
pub fn engine_for(id: DbEngineId) -> Result<&'static dyn DbEngine, DbError> {
    // Still called for its ERROR: an id with no descriptor row is a bug, and it must fail here
    // rather than inside an engine that would then serve another engine's defaults.
    engines::require_spec(id)?;
    match id {
        DbEngineId::Postgres => Ok(&POSTGRES),
        DbEngineId::AuroraPostgres => Ok(&AURORA_POSTGRES),
        DbEngineId::Mysql => Ok(&MYSQL),
        DbEngineId::AuroraMysql => Ok(&AURORA_MYSQL),
        DbEngineId::Clickhouse => Ok(&CLICKHOUSE),
        DbEngineId::Mongodb => Ok(&MONGODB),
        DbEngineId::Redis => Ok(&REDIS),
        DbEngineId::Valkey => Ok(&VALKEY),
        DbEngineId::Dynamodb => Ok(&DYNAMODB),
    }
}

/* ──────────────────────────────── PostgreSQL ──────────────────────────────── */

/// The PostgreSQL engine — also Amazon Aurora PostgreSQL, which is wire-compatible.
///
/// Carries its preset id for the same reason [`MysqlEngine`] does: one type, two descriptor
/// rows. It used to be zero-sized and hardcode `DbEngineId::Postgres` in `spec()`, which was
/// correct while Postgres was the only wired engine and became a **bug** the moment Aurora
/// PostgreSQL was registered against the same type — an Aurora connection would have reported
/// itself as plain "PostgreSQL" and served Postgres's defaults.
pub struct PostgresEngine {
    id: DbEngineId,
}

/// How long to wait for the dial itself when the connection does not say. Separate from the
/// query timeout, because a firewall black-holing a SYN and a slow query are different
/// failures with different advice.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Apply the User and Password **fields** to driver options the URL override has already filled —
/// but only where the URL said nothing.
///
/// 🔴 **This is the dropped-password bug, and its shape is worth keeping.** Both sqlx engines
/// used to read
///
/// ```ignore
/// if cfg.url.is_none() && !cfg.password.is_empty() { opts = opts.password(&cfg.password); }
/// ```
///
/// — i.e. *the presence of a URL suppresses the password field*, which is a different rule from the
/// one the dialog promises (*"Overrides settings above"*). A URL that carries no password does not
/// override anything about the password; it is silent on the subject. And silence was the common
/// case, because our own importer **strips** a pasted password out of the string and does not put a
/// `{{VAR}}` back in its place. So `postgresql://gazelle@localhost:5433/orders` plus a password
/// typed into the box the dialog points at dialled with **no password at all**.
///
/// The same reasoning applies to the user, and it is not decoration: without it a bare
/// `postgresql://localhost/db` dials as whatever `PgConnectOptions`'s URL parse defaults the
/// username to (the OS user), silently ignoring a User field sitting right there — and
/// [`ResolvedConfig::effective_user`] would then name an account the connection never tried.
///
/// By the time this runs, `db::substitute_url` has already put the resolved secret back into any
/// `{{VAR}}`, so a URL that carried a *reference* genuinely carries the *password* here and is
/// correctly left alone.
///
/// Generic over the two option types rather than written twice: "what does an empty field mean
/// beside a URL" must have exactly one answer, and the previous copy-paste is how the two engines
/// came to share one bug (duplication across a boundary does not announce itself).
/// Which database a live session should say it is on: **the one the driver actually dialled**.
///
/// 🔴 **The bug: it connected, but queries returned nothing.** Every
/// engine built its session with `database: cfg.database.clone()` — the *form field* — while the
/// connection itself had been made from the URL override. With `Connection type: URL only` the
/// field is empty, so the field and the connection disagreed about the most load-bearing string in
/// the feature. The visible damage differs per engine and is worst where it is quietest: MongoDB's
/// `command_database()` falls back to **`admin`** when this is empty, so `{"find": "tracks"}` ran
/// against a database that has no `tracks` and returned **zero documents and no error at all** —
/// a connection that works, a query that succeeds, and an empty grid.
///
/// The fix is the same principle as [`dial_error`]'s: **ask the thing that dialled.**
/// `get_database()` is the option value sqlx parsed out of the URL (or that we set from the field on
/// the form path), so it cannot disagree with the connection the way a second parse of the string
/// could. `cfg.database` remains only as the fallback for a driver that reports nothing.
pub fn dialled_database(dialled: Option<&str>, cfg: &ResolvedConfig) -> String {
    dialled
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| cfg.database.clone())
}

/// A failed **dial**, mapped, redacted, and — when the server rejected the credentials — told which
/// account and which server were actually used.
///
/// The identity comes from the driver's own `get_username`/`get_host`/`get_port`, never from the
/// [`ResolvedConfig`] fields: with a URL override in play those two can disagree, and a message that
/// names the form's user while the string dialled someone else would be worse than the redacted
/// original it replaces. See [`DbError::with_auth_identity`].
fn dial_error(
    e: &sqlx::Error,
    secrets: &[&str],
    dialled_user: &str,
    password: &str,
    dialled_host: &str,
    dialled_port: u16,
) -> DbError {
    map_sqlx_error(e).redacted(secrets).with_auth_identity(
        dialled_user,
        password,
        &format!("{dialled_host}:{dialled_port}"),
    )
}

/// The error for a session whose socket had died and could not be re-dialled.
///
/// 🔴 **The one thing it must never do is repeat the dead socket's own error.** That failure is the
/// `UnexpectedEof` — *"(expected to read 5 bytes, got 0 bytes at EOF)"* — and it
/// is about a socket that has already been thrown away. Reporting it would send the user off to
/// check a host and a port that are demonstrably fine, which is precisely the misattribution
/// `error.rs`'s `UnexpectedEof` arm was written to end. So [`DbSession::ensure_live`] discards the
/// liveness probe's error entirely and reports **this** instead: the connection dropped, re-opening
/// it was attempted, and here is what that *fresh* attempt said — a current answer about a current
/// dial, which is the only part the user can act on.
///
/// `dial`'s code is preserved rather than flattened to `network`: a rotated password surfaces here
/// as `auth`, and the panel's sentence for it is the useful one.
pub(crate) fn reconnect_failed(host_label: &str, dial: DbError) -> DbError {
    DbError::new(
        dial.code,
        format!(
            "This connection had been closed by the server and could not be re-established. \
             Re-connecting to {host_label} failed: {}",
            dial.message
        ),
    )
}

/// The session setup [`PostgresEngine::open`] applies to a freshly dialled connection — and the
/// **only** thing [`DbSession::ensure_live`] re-applies after a reconnect.
///
/// One function rather than two copies, because the order is load-bearing and a second copy is how
/// it drifts. The read-only guardrail goes first, before anything else can run on this connection
/// (see the module doc for the measurement that shaped it); a reconnect that re-applied it second,
/// or forgot it, would hand back a session the user believes is read-only and the server does not.
///
/// Returns the backend pid — it belongs to the *connection*, so it must be re-read here and never
/// carried over from the socket that died.
async fn apply_pg_session_setup(
    conn: &mut PgConnection,
    read_only: bool,
    timeout_ms: u32,
    secrets: &[&str],
) -> Result<Option<i32>, DbError> {
    if read_only {
        exec_one(
            &mut *conn,
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
            secrets,
        )
        .await?;
    }
    // A server-side statement timeout, so a query that outlives the client's patience dies on the
    // server too instead of leaving a backend spinning.
    exec_one(
        &mut *conn,
        &format!("SET statement_timeout = {timeout_ms}"),
        secrets,
    )
    .await?;
    Ok(sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
        .fetch_one(&mut *conn)
        .await
        .ok())
}

/// MySQL's half of [`apply_pg_session_setup`], same contract and same ordering rule. Returns the
/// connection id, which is what `KILL QUERY` addresses and which changes on every reconnect.
async fn apply_mysql_session_setup(
    conn: &mut MySqlConnection,
    read_only: bool,
    timeout_ms: u32,
    secrets: &[&str],
) -> Result<Option<u64>, DbError> {
    if read_only {
        exec_one(&mut *conn, "SET SESSION TRANSACTION READ ONLY", secrets).await?;
    }
    // SELECT-only by MySQL's design — see `MysqlEngine`'s doc. Sent anyway because it is the only
    // server-side bound available, and a bounded SELECT is the common runaway.
    exec_one(
        &mut *conn,
        &format!("SET SESSION max_execution_time = {timeout_ms}"),
        secrets,
    )
    .await?;
    Ok(sqlx::query_scalar::<_, u64>("SELECT CONNECTION_ID()")
        .fetch_one(&mut *conn)
        .await
        .ok())
}

/// A backend id shared between a session and the cancel handle standing beside it.
///
/// 🔴 **This exists because a reconnect changes the id, and a stale one is not inert.**
/// `LiveSession::cancel` is captured ONCE at `session::insert` and outlives any number of
/// reconnects. PostgreSQL's cancel here is `SELECT pg_cancel_backend(pid)` — a SQL function against
/// whatever backend currently holds that pid, **not** libpq's cancel-key protocol, which is the
/// thing that would make a stale handle harmlessly wrong. Backend pids are OS pids and OS pids are
/// recycled, and `pg_cancel_backend` succeeds against any backend the same role owns — which
/// emphatically includes this app's *other* session on the same database. A handle frozen at the
/// old pid could therefore cancel a stranger's query, and the stranger is most likely the user
/// themselves, in another tab, wondering why their statement died.
///
/// So the id is shared, not copied: [`DbSession::ensure_live`] stores the new one and the handle
/// reads it at cancel time. `0` means "unknown" — no PostgreSQL backend pid and no MySQL connection
/// id is ever zero — and a handle that reads `0` refuses rather than guessing.
#[derive(Debug)]
pub(crate) struct BackendId(std::sync::atomic::AtomicU64);

impl BackendId {
    fn new(id: Option<u64>) -> Arc<Self> {
        Arc::new(Self(std::sync::atomic::AtomicU64::new(id.unwrap_or(0))))
    }
    fn set(&self, id: Option<u64>) {
        self.0
            .store(id.unwrap_or(0), std::sync::atomic::Ordering::SeqCst);
    }
    /// The current id, or `None` when the server never told us one.
    fn get(&self) -> Option<u64> {
        match self.0.load(std::sync::atomic::Ordering::SeqCst) {
            0 => None,
            id => Some(id),
        }
    }
}

fn fill_credential_gaps<T>(
    cfg: &ResolvedConfig,
    mut opts: T,
    set_user: fn(T, &str) -> T,
    set_password: fn(T, &str) -> T,
) -> T {
    let says = cfg.url_credential();
    // No URL → `says` is the default, so the form path falls out of the same rule rather than
    // needing a branch of its own.
    // `cfg.user` verbatim, NOT trimmed: the form branch of both `connect_options` already sets it
    // that way, and a helper that quietly normalised it would make the same field mean two things
    // depending on whether a URL was present.
    if says.user.is_none() && !cfg.user.is_empty() {
        opts = set_user(opts, &cfg.user);
    }
    if !says.has_password && !cfg.password.is_empty() {
        opts = set_password(opts, &cfg.password);
    }
    opts
}

impl PostgresEngine {
    /// Build the driver's connect options from a [`ResolvedConfig`].
    ///
    /// Starts from `new_without_pgpass()` rather than `new()`: reading the developer's
    /// `~/.pgpass` would mean a connection could succeed with a credential the user never gave
    /// this app, which is both surprising and unreproducible on another machine.
    fn connect_options(cfg: &ResolvedConfig) -> Result<PgConnectOptions, DbError> {
        let mut opts = match &cfg.url {
            // A raw URL wins over the fields (the dialog's "Overrides settings above"). It is
            // parsed by the driver, so exactly the string the user pasted is what dials.
            Some(url) => url.parse::<PgConnectOptions>().map_err(|e| {
                // Deliberately `invalid-config` rather than whatever `map_sqlx_error` would
                // classify it as: nothing was dialled, so this is a bad *setting*, and telling
                // the user to "check the network" would send them looking in the wrong place.
                DbError::invalid_config(format!("That connection string is not usable: {e}"))
                    .redacted(&cfg.secrets())
            })?,
            None => PgConnectOptions::new_without_pgpass()
                .host(&cfg.host)
                // An empty port field lands on the descriptor's 5432 rather than on sqlx's own
                // default, which is `$PGPORT` first — see `ResolvedConfig::port_or_default`.
                .port(cfg.port_or_default())
                .username(&cfg.user)
                .database(&cfg.database)
                .ssl_mode(pg_ssl_mode(cfg.ssl_mode)),
        };
        opts = fill_credential_gaps(
            cfg,
            opts,
            PgConnectOptions::username,
            PgConnectOptions::password,
        );
        if let Some(pem) = &cfg.ca_pem {
            opts = opts.ssl_root_cert_from_pem(pem.clone());
        }
        // `applicationName` shows up in `pg_stat_activity`, which is how a runaway query gets
        // traced back to this app rather than to "some client".
        if let Some(app) = cfg.options.get("applicationName").filter(|v| !v.is_empty()) {
            opts = opts.application_name(app);
        }
        if let Some(path) = cfg.options.get("searchPath").filter(|v| !v.is_empty()) {
            opts = opts.options([("search_path", path.as_str())]);
        }
        // `raw_sql` never prepares, so a statement cache would only hold entries nothing reads.
        Ok(opts.statement_cache_capacity(0))
    }

    /// The dial timeout: `connectTimeout` seconds when the connection sets it, else 10 s.
    fn connect_timeout(cfg: &ResolvedConfig) -> Duration {
        cfg.options
            .get("connectTimeout")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|s| *s > 0)
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT)
    }
}

#[async_trait]
impl DbEngine for PostgresEngine {
    fn spec(&self) -> &'static EngineSpec {
        engines::spec_for(self.id).expect("a PostgreSQL-family row exists for this id")
    }

    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn DbSession>, DbError> {
        let secrets = cfg.secrets();
        let opts = Self::connect_options(cfg)?;

        let mut conn = tokio::time::timeout(
            Self::connect_timeout(cfg),
            PgConnection::connect_with(&opts),
        )
        .await
        .map_err(|_| {
            DbError::new(
                DbErrorCode::Timeout,
                format!(
                    "Timed out connecting to {} — a firewall may be dropping it.",
                    cfg.host_label()
                ),
            )
        })?
        .map_err(|e| {
            dial_error(
                &e,
                &secrets,
                opts.get_username(),
                &cfg.password,
                opts.get_host(),
                opts.get_port(),
            )
        })?;

        // ── the guardrail, as its OWN round trip, then the statement timeout. See the module doc:
        //    prepending the guardrail to the user's script would make it a decoration, and the
        //    order matters — it must land before anything else can run on this connection. Both
        //    live in `apply_pg_session_setup` so `ensure_live`'s reconnect cannot re-apply a
        //    different set, or the same set in a different order.
        let backend_pid =
            apply_pg_session_setup(&mut conn, cfg.read_only, cfg.timeout_ms, &secrets).await?;

        Ok(Box::new(PgSession {
            conn,
            // From the OPTIONS THAT DIALLED, not from `cfg.database` — see `dialled_database`.
            database: dialled_database(opts.get_database(), cfg),
            read_only: cfg.read_only,
            opts,
            // Kept so a reconnect dials under the SAME policy `open` used, rather than under a
            // second, quietly different default.
            connect_timeout: Self::connect_timeout(cfg),
            backend_pid: BackendId::new(backend_pid.and_then(|p| u64::try_from(p).ok())),
            password: cfg.password.clone(),
        }))
    }
}

/* ──────────────────────────────── MySQL family ──────────────────────────────── */

/// The MySQL engine — also Amazon Aurora MySQL, which is wire-compatible.
///
/// ## Read-only is server-enforced here, and MORE strictly than on Postgres
///
/// `SET SESSION TRANSACTION READ ONLY` makes the server reject DML with
/// `ERROR 1792 (25006) Cannot execute statement in a READ ONLY transaction`. **Measured on the
/// fixture (MySQL 8.4.6)**, including the case that escapes on Postgres: sending
/// `SET SESSION … READ ONLY; INSERT …` as ONE batch is still refused, where libpq's simple
/// query protocol happily runs the INSERT (see this module's header). We still send the
/// guardrail as its own round trip — not because MySQL needs it, but because relying on a
/// difference between two servers' batch semantics is not a guarantee worth building on.
///
/// ## `max_execution_time` only covers SELECTs, and that is why it is layer 2
///
/// MySQL's server-side statement timeout applies to read-only SELECT statements *only* — there
/// is no equivalent for DML. So it is a genuine partial: the client-side `tokio::time::timeout`
/// in [`DbSession::run`] is what bounds every other statement, and `cancel` is what stops the
/// server-side work. Postgres's `statement_timeout` has no such carve-out; not saying so here
/// would leave the impression the two engines offer the same protection.
pub struct MysqlEngine {
    /// Which preset this instance serves. One type, two rows: MySQL and Aurora MySQL differ
    /// only in their descriptor (label, defaults), never in how they are dialled — so the id is
    /// data rather than a second copy of this file.
    id: DbEngineId,
}

impl MysqlEngine {
    fn connect_options(cfg: &ResolvedConfig) -> Result<MySqlConnectOptions, DbError> {
        let mut opts = match &cfg.url {
            Some(url) => url.parse::<MySqlConnectOptions>().map_err(|e| {
                DbError::invalid_config(format!("That connection string is not usable: {e}"))
                    .redacted(&cfg.secrets())
            })?,
            None => MySqlConnectOptions::new()
                .host(&cfg.host)
                // 3306 for an empty field. `MySqlConnectOptions::new()` happens to hardcode the
                // same number, but going through one helper keeps every engine's answer to "what
                // does an empty port mean" identical and testable.
                .port(cfg.port_or_default())
                .username(&cfg.user)
                .database(&cfg.database)
                .ssl_mode(mysql_ssl_mode(cfg.ssl_mode)),
        };
        opts = fill_credential_gaps(
            cfg,
            opts,
            MySqlConnectOptions::username,
            MySqlConnectOptions::password,
        );
        if let Some(pem) = &cfg.ca_pem {
            opts = opts.ssl_ca_from_pem(pem.clone());
        }
        // `raw_sql` never prepares, so a statement cache would only hold entries nothing reads —
        // the same reasoning as the Postgres side.
        Ok(opts.statement_cache_capacity(0))
    }
}

#[async_trait]
impl DbEngine for MysqlEngine {
    fn spec(&self) -> &'static EngineSpec {
        engines::spec_for(self.id).expect("a MySQL-family row exists for this id")
    }

    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn DbSession>, DbError> {
        let secrets = cfg.secrets();
        let opts = Self::connect_options(cfg)?;

        let mut conn = tokio::time::timeout(
            PostgresEngine::connect_timeout(cfg),
            MySqlConnection::connect_with(&opts),
        )
        .await
        .map_err(|_| {
            DbError::new(
                DbErrorCode::Network,
                format!(
                    "The server did not answer within {} s.",
                    PostgresEngine::connect_timeout(cfg).as_secs()
                ),
            )
        })?
        .map_err(|e| {
            dial_error(
                &e,
                &secrets,
                opts.get_username(),
                &cfg.password,
                opts.get_host(),
                opts.get_port(),
            )
        })?;

        // The guardrail first, as its own round trip, before anything else can run here — and the
        // statement timeout after it. Shared with `ensure_live`'s reconnect for the reason given on
        // `apply_pg_session_setup`.
        let connection_id =
            apply_mysql_session_setup(&mut conn, cfg.read_only, cfg.timeout_ms, &secrets).await?;

        Ok(Box::new(MySqlSession {
            conn,
            // From the OPTIONS THAT DIALLED — see `dialled_database`.
            database: dialled_database(opts.get_database(), cfg),
            read_only: cfg.read_only,
            opts,
            connect_timeout: PostgresEngine::connect_timeout(cfg),
            connection_id: BackendId::new(connection_id),
            password: cfg.password.clone(),
        }))
    }
}

/// Our SSL ladder → the driver's. Written out for the same reason as `pg_ssl_mode`: a new mode
/// on either side must be a compile error, never a silent downgrade.
///
/// ⚠️ `VerifyCa` maps to `VerifyCa` and `VerifyFull` to `VerifyIdentity` — MySQL's names for
/// the same two rungs (chain only, chain + hostname).
fn mysql_ssl_mode(mode: SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disable => MySqlSslMode::Disabled,
        SslMode::Prefer => MySqlSslMode::Preferred,
        SslMode::Require => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

/// One live MySQL connection. A single connection, not a pool — `SET SESSION` is session state,
/// exactly as on the Postgres side.
struct MySqlSession {
    conn: MySqlConnection,
    /// The database named in the connection — used only to mark which of the server's schemas the
    /// tree is connected to, since MySQL can list them all.
    database: String,
    /// Whether this session was opened read-only — see [`PgSession::read_only`].
    read_only: bool,
    /// Kept so [`DbSession::cancel_handle`] can dial a **sibling** — and so
    /// [`DbSession::ensure_live`] can re-dial this one after the server drops it.
    opts: MySqlConnectOptions,
    /// The dial timeout `open` used, so a reconnect waits exactly as long and no longer.
    connect_timeout: Duration,
    /// Shared with the cancel handle and **rewritten on every reconnect** — see [`BackendId`] for
    /// why a frozen copy would be a live hazard rather than a stale curiosity.
    connection_id: Arc<BackendId>,
    /// Held only to redact it out of driver errors.
    password: String,
}

impl MySqlSession {
    fn secrets(&self) -> Vec<&str> {
        if self.password.is_empty() {
            Vec::new()
        } else {
            vec![self.password.as_str()]
        }
    }

    fn owned_secrets(&self) -> Vec<String> {
        self.secrets().into_iter().map(str::to_string).collect()
    }
}

#[async_trait]
impl DbSession for MySqlSession {
    async fn probe(&mut self) -> Result<ServerInfo, DbError> {
        let secrets = self.owned_secrets();
        let rows = sqlx::raw_sql(AssertSqlSafe("SELECT version()".to_string()))
            .fetch_all(&mut self.conn)
            .await
            .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
        let version = rows
            .first()
            .and_then(|r| r.try_get_unchecked::<Option<String>, _>(0).ok().flatten())
            // Prefixed, because `version()` returns bare `8.4.6` — a number with no engine name
            // beside it is not something a user can act on when three engines are configured.
            .map(|v| format!("MySQL {v}"))
            .unwrap_or_else(|| "MySQL (version unavailable)".to_string());
        Ok(ServerInfo {
            version,
            // Deliberately narrowed: `ServerInfo::backend_pid` is an `i32` (Postgres's type) and
            // MySQL's connection id is a `u64`. A wrapping cast would print a negative id that
            // matches no connection, so an id that does not fit is reported as absent — and
            // `cancel` still works, because it reads `self.connection_id`, not this field.
            backend_pid: self
                .connection_id
                .get()
                .and_then(|id| i32::try_from(id).ok()),
        })
    }

    /// MySQL's reconnect. Identical in shape to [`PgSession::ensure_live`]; read that one for the
    /// reasoning, including why a ping must never turn into a retry.
    async fn ensure_live(&mut self, limits: &Limits) -> Result<(), DbError> {
        if Connection::ping(&mut self.conn).await.is_ok() {
            return Ok(());
        }
        let secrets = self.owned_secrets();
        let host = format!("{}:{}", self.opts.get_host(), self.opts.get_port());
        let mut conn = tokio::time::timeout(
            self.connect_timeout,
            MySqlConnection::connect_with(&self.opts),
        )
        .await
        .map_err(|_| reconnect_failed(&host, dial_timeout(self.connect_timeout)))?
        .map_err(|e| reconnect_failed(&host, map_sqlx_error(&e).redacted(&as_refs(&secrets))))?;

        let id = apply_mysql_session_setup(
            &mut conn,
            self.read_only,
            limits.timeout_ms,
            &as_refs(&secrets),
        )
        .await
        .map_err(|e| reconnect_failed(&host, e))?;

        self.conn = conn;
        self.connection_id.set(id);
        Ok(())
    }

    async fn run(&mut self, script: &Script, limits: &Limits) -> Result<Vec<DbResultSet>, DbError> {
        let statements = vet_sql_script(script, limits, self.read_only)?;
        let sql = if matches!(script.mode, DbRunMode::Statement) {
            statements[0].clone()
        } else {
            script.text.clone()
        };

        let secrets = self.owned_secrets();
        let deadline = Duration::from_millis(u64::from(limits.timeout_ms));
        match tokio::time::timeout(
            deadline,
            collect(&mut self.conn, sql, &statements, limits, &as_refs(&secrets)),
        )
        .await
        {
            Ok(sets) => Ok(sets),
            Err(_) => Err(DbError::new(
                DbErrorCode::Timeout,
                format!(
                    "The query exceeded this connection's {} ms timeout.",
                    limits.timeout_ms
                ),
            )),
        }
    }

    async fn run_strict(
        &mut self,
        script: &Script,
        limits: &Limits,
    ) -> Result<Vec<DbResultSet>, DbError> {
        if !self.read_only {
            return self.run(script, limits).await;
        }
        let pieces = run_pieces(script, vet_sql_script(script, limits, self.read_only)?);
        if let Some(refused) = mysql_unheld(&pieces) {
            return Err(refused);
        }
        let secrets = self.owned_secrets();
        let deadline = Duration::from_millis(u64::from(limits.timeout_ms));
        tokio::time::timeout(
            deadline,
            mysql_read_only_run(&mut self.conn, &pieces, limits, &as_refs(&secrets)),
        )
        .await
        .unwrap_or_else(|_| Err(run_timed_out(limits)))
    }

    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        let secrets = self.owned_secrets();
        // Bound parameters throughout — see the PostgreSQL implementation's note.
        match node {
            // Unlike PostgreSQL, one MySQL connection CAN see every schema on the server, so the
            // root lists them. MySQL's "schema" and "database" are the same thing, which is why
            // there is no schema level below.
            DbNodeRef::Root => {
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT schema_name FROM information_schema.schemata \
                     WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') \
                     ORDER BY schema_name",
                )
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                Ok(rows
                    .into_iter()
                    .map(|(name,)| {
                        let node = DbNode::new(
                            DbNodeRef::Database { name: name.clone() },
                            name.clone(),
                            DbNodeKind::Database,
                            true,
                        );
                        // The one you connected to, marked — with several databases visible it is
                        // otherwise indistinguishable from the rest.
                        if name == self.database {
                            node.with_sub_label("connected")
                        } else {
                            node
                        }
                    })
                    .collect())
            }

            // No schema level: MySQL's schemata ARE its databases, so a database expands straight
            // into its groups.
            DbNodeRef::Database { name } => {
                let rows: Vec<(String, i64)> = sqlx::query_as(
                    "SELECT table_type, count(*) FROM information_schema.tables \
                     WHERE table_schema = ? GROUP BY table_type",
                )
                .bind(name)
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                let (tables, views) = split_table_counts(&rows);
                Ok(group_nodes(name, None, tables, views))
            }

            // Reachable only if a caller invents one, since this engine never emits a schema node.
            // Answered as empty rather than as an error: a tree that throws on an unexpected ref
            // takes the panel down, and there is nothing for the user to do about it.
            DbNodeRef::Schema { .. } => Ok(Vec::new()),

            DbNodeRef::Group {
                database, group, ..
            } => {
                let want = if matches!(group, DbGroup::Views) {
                    "VIEW"
                } else {
                    "BASE TABLE"
                };
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT table_name FROM information_schema.tables \
                     WHERE table_schema = ? AND table_type = ? ORDER BY table_name",
                )
                .bind(database)
                .bind(want)
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                Ok(rows
                    .into_iter()
                    .map(|(name,)| {
                        table_node(database, None, &name, matches!(group, DbGroup::Views))
                    })
                    .collect())
            }

            DbNodeRef::Table { database, name, .. } => {
                // `column_type` is the full declared spelling (`varchar(64)`, `enum('duo','trio')`)
                // — `data_type` would give a bare `varchar` and lose the length.
                let rows: Vec<(String, String, String)> = sqlx::query_as(
                    "SELECT column_name, column_type, is_nullable FROM information_schema.columns \
                     WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
                )
                .bind(database)
                .bind(name)
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                Ok(rows
                    .into_iter()
                    .map(|(column, type_name, nullable)| {
                        DbNode::column(
                            database,
                            None,
                            name,
                            &column,
                            &type_name,
                            // `information_schema` spells it "YES"/"NO", not a boolean.
                            nullable.eq_ignore_ascii_case("YES"),
                        )
                    })
                    .collect())
            }

            // Both are answered by the saved-query store, never by the server —
            // `db_children` intercepts them before an engine is asked.
            DbNodeRef::SavedQueries | DbNodeRef::SavedQuery { .. } => Ok(Vec::new()),
        }
    }

    fn cancel_handle(&self) -> Option<Arc<dyn DbCancel>> {
        // `None` when the server never told us a connection id — the handle is taken once, at
        // insert, so a session that starts without one never gets a cancel. Honest and structural.
        self.connection_id.get()?;
        Some(Arc::new(MySqlCancel {
            opts: self.opts.clone(),
            // The SHARED id, not a copy of today's value — see `BackendId`.
            connection_id: self.connection_id.clone(),
            secrets: self.owned_secrets(),
        }))
    }

    async fn close(self: Box<Self>) {
        self.conn.close().await.ok();
    }
}

/* ────────────────────────────── the cancel handles ──────────────────────────────
 * One per family that HAS a server-side cancel. Each owns everything it needs and dials a
 * **sibling** connection, because the connection running the query is busy running it.
 *
 * They live outside their sessions so they stay reachable while `db::query` holds the session
 * mutex — see `DbSession::cancel_handle`. That is the whole reason cancel now works.
 */

/// The refusal a cancel handle gives when its session currently has no backend to address — the
/// only state a reconnect can leave it in, and far better than firing at a remembered pid.
fn nothing_to_cancel() -> DbError {
    DbError::new(
        DbErrorCode::Unknown,
        "This connection has no server-side statement to cancel right now — it was re-established \
         after the server dropped it, and the new session did not report a backend id.",
    )
}

/// PostgreSQL: `pg_cancel_backend(pid)` from a sibling connection.
struct PgCancel {
    opts: PgConnectOptions,
    /// 🔴 **Read at cancel time, never captured at handle time** — see [`BackendId`]. The handle
    /// outlives any number of reconnects, and `pg_cancel_backend` is a SQL call against whichever
    /// backend holds that pid *now*, not libpq's cancel-key handshake. A frozen pid is not inert.
    pid: Arc<BackendId>,
    secrets: Vec<String>,
}

#[async_trait]
impl DbCancel for PgCancel {
    async fn cancel(&self) -> Result<(), DbError> {
        let secrets: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
        let pid = self
            .pid
            .get()
            .and_then(|id| i32::try_from(id).ok())
            .ok_or_else(nothing_to_cancel)?;
        let mut sibling = PgConnection::connect_with(&self.opts)
            .await
            .map_err(|e| map_sqlx_error(&e).redacted(&secrets))?;
        // `pg_cancel_backend` sends SIGINT — it asks, and the backend stops at its next
        // interruptible point. `pg_terminate_backend` would be certain and would also drop the
        // user's session, so a cancel would silently cost them their connection.
        let result = sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .execute(&mut sibling)
            .await
            .map(|_| ())
            .map_err(|e| map_sqlx_error(&e).redacted(&secrets));
        let _ = sibling.close().await;
        result
    }
}

/// MySQL: `KILL QUERY <connection_id>` from a sibling connection.
struct MySqlCancel {
    opts: MySqlConnectOptions,
    /// Shared with the session, for the reason spelled out on [`PgCancel::pid`]. MySQL's exposure
    /// is the same shape: `KILL QUERY <id>` addresses whatever connection holds that id now, and
    /// connection ids are handed out again after a server restart.
    connection_id: Arc<BackendId>,
    secrets: Vec<String>,
}

#[async_trait]
impl DbCancel for MySqlCancel {
    async fn cancel(&self) -> Result<(), DbError> {
        let secrets: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
        let id = self.connection_id.get().ok_or_else(nothing_to_cancel)?;
        let mut sibling = MySqlConnection::connect_with(&self.opts)
            .await
            .map_err(|e| map_sqlx_error(&e).redacted(&secrets))?;
        // 🔴 `KILL QUERY` ends the running statement and LEAVES THE CONNECTION OPEN. Bare `KILL`
        // drops the whole session, so the console would silently need a reconnect after every
        // cancel — the user asked to stop a query, not to lose their connection.
        let killed = exec_one(&mut sibling, &format!("KILL QUERY {id}"), &secrets).await;
        sibling.close().await.ok();
        killed
    }
}

/// The inner error for a reconnect whose **dial** ran out of time, so [`reconnect_failed`] has one
/// sentence to wrap rather than each engine inventing its own.
fn dial_timeout(after: Duration) -> DbError {
    DbError::new(
        DbErrorCode::Timeout,
        format!(
            "the connection attempt timed out after {} s",
            after.as_secs()
        ),
    )
}

/// Run one statement as its own round trip, mapping and redacting any failure.
///
/// Generic for the same reason `collect` is: the session-setup statements differ per engine but
/// the "one statement, its own trip, mapped and redacted" shape does not.
async fn exec_one<'c, DB, E>(executor: E, sql: &str, secrets: &[&str]) -> Result<(), DbError>
where
    DB: sqlx::Database,
    E: sqlx::Executor<'c, Database = DB>,
{
    sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
        .execute(executor)
        .await
        .map(|_| ())
        .map_err(|e| map_sqlx_error(&e).redacted(secrets))
}

/// Our SSL ladder → the driver's. 1:1, and written out so a new mode on either side is a
/// compile error rather than a silent downgrade.
fn pg_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

/// One live PostgreSQL connection.
///
/// A single connection rather than a pool, deliberately: `SET SESSION CHARACTERISTICS` is
/// *session* state, and a pool would hand out connections that never received it. The pooling
/// question belongs to whatever feature first needs concurrency.
struct PgSession {
    conn: PgConnection,
    /// The database this connection is bound to. Held because the tree's root node names it: a
    /// PostgreSQL connection cannot read another database's catalog, so this is the ONLY database
    /// it can honestly offer (see `children`).
    database: String,
    /// Whether this session was opened read-only.
    ///
    /// Session state, not a per-run limit — which is why it lives here and not on [`Limits`]
    /// (see that type's doc: a per-run read-only flag would imply it could be switched off per
    /// run). `run` reads it to refuse statements that would change the transaction access mode;
    /// see [`guard::read_only_escape`] for what that does and does not guarantee.
    read_only: bool,
    /// Kept so [`DbSession::cancel_handle`] can dial a **sibling** connection (the busy one cannot
    /// service a cancel request) — and so [`DbSession::ensure_live`] can re-dial *this* one after
    /// the server, a pooler or a laptop suspend has closed it. `PgConnectOptions` carries the
    /// password, which is what makes both possible without going back to the store.
    opts: PgConnectOptions,
    /// The dial timeout `open` used, so a reconnect waits exactly as long and no longer.
    connect_timeout: Duration,
    /// Shared with the cancel handle and **rewritten on every reconnect** — see [`BackendId`] for
    /// why a frozen copy would be a live hazard rather than a stale curiosity.
    backend_pid: Arc<BackendId>,
    /// Held only to redact it out of driver errors.
    password: String,
}

impl PgSession {
    /// The secrets that must be scrubbed out of any message leaving this session.
    fn secrets(&self) -> Vec<&str> {
        if self.password.is_empty() {
            Vec::new()
        } else {
            vec![self.password.as_str()]
        }
    }

    /// The same list, owned. Needed wherever the call also takes `&mut self.conn`: a borrowed
    /// `Vec<&str>` would keep `self` immutably borrowed across the query.
    fn owned_secrets(&self) -> Vec<String> {
        self.secrets().into_iter().map(str::to_string).collect()
    }
}

/* ───────────────────────── the connection tree's shared shaping ───────────────────────── */

/// The two group nodes under a schema (or, for schema-less engines, a database).
///
/// Shared by every SQL engine so "Tables" and "Views" cannot end up spelled or counted
/// differently per engine. `counts` is what the one catalog query returned, keyed by
/// `information_schema.tables.table_type`.
pub(crate) fn group_nodes(
    database: &str,
    schema: Option<&str>,
    tables: usize,
    views: usize,
) -> Vec<DbNode> {
    let mut out = Vec::with_capacity(2);
    for (group, n, singular) in [
        (DbGroup::Tables, tables, "table"),
        (DbGroup::Views, views, "view"),
    ] {
        // A group with nothing in it is still listed: "this database has no views" is
        // information, and a row that vanishes is indistinguishable from a failed query.
        out.push(
            DbNode::new(
                DbNodeRef::Group {
                    database: database.to_string(),
                    schema: schema.map(str::to_string),
                    group,
                },
                group.label(),
                DbNodeKind::Group,
                n > 0,
            )
            .with_sub_label(count_label(n, singular)),
        );
    }
    out
}

/// One table/view node.
pub(crate) fn table_node(
    database: &str,
    schema: Option<&str>,
    name: &str,
    is_view: bool,
) -> DbNode {
    DbNode::new(
        DbNodeRef::Table {
            database: database.to_string(),
            schema: schema.map(str::to_string),
            name: name.to_string(),
        },
        name,
        if is_view {
            DbNodeKind::View
        } else {
            DbNodeKind::Table
        },
        // Expandable into its columns. True even for a view, which has them too.
        true,
    )
}

/// `information_schema.tables.table_type` → (tables, views).
///
/// Anything that is neither `BASE TABLE` nor `VIEW` (a Postgres foreign table, a MySQL
/// `SYSTEM VIEW`) is counted as a table rather than dropped: a node the user can see and expand
/// beats an object that silently is not there.
fn split_table_counts(rows: &[(String, i64)]) -> (usize, usize) {
    let mut tables = 0usize;
    let mut views = 0usize;
    for (kind, n) in rows {
        let n = usize::try_from(*n).unwrap_or(0);
        if kind.eq_ignore_ascii_case("VIEW") {
            views += n;
        } else {
            tables += n;
        }
    }
    (tables, views)
}

/// The one thing `sqlx`'s `QueryResult` types have in common that we need, and which `sqlx`
/// does not expose as a trait: how many rows the statement changed.
///
/// Written as a two-impl local trait rather than duplicating `collect` per engine. The
/// alternative — a `collect` for Postgres and a near-identical one for MySQL — is exactly the
/// duplication that once produced two drifting error-sentence tables in the frontend.
trait RowsAffected {
    fn rows_affected(&self) -> u64;
}

impl RowsAffected for sqlx::postgres::PgQueryResult {
    fn rows_affected(&self) -> u64 {
        self.rows_affected()
    }
}

impl RowsAffected for sqlx::mysql::MySqlQueryResult {
    fn rows_affected(&self) -> u64 {
        self.rows_affected()
    }
}

/// `&[String]` → `&[&str]`, for the redactor's signature.
fn as_refs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

#[async_trait]
impl DbSession for PgSession {
    async fn probe(&mut self) -> Result<ServerInfo, DbError> {
        // Cloned, not borrowed: `secrets()` borrows `self` immutably and the query below needs
        // `&mut self.conn`. One small allocation on a path that already did a round trip.
        let secrets = self.owned_secrets();
        // Read through the same text path everything else uses, so Test Connection exercises
        // the machinery the console depends on rather than a private shortcut.
        let rows = sqlx::raw_sql(AssertSqlSafe("SELECT version()".to_string()))
            .fetch_all(&mut self.conn)
            .await
            .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
        let version = rows
            .first()
            .and_then(|r| r.try_get_unchecked::<Option<String>, _>(0).ok().flatten())
            .unwrap_or_else(|| "PostgreSQL (version unavailable)".to_string());
        Ok(ServerInfo {
            version,
            backend_pid: self.backend_pid.get().and_then(|p| i32::try_from(p).ok()),
        })
    }

    /// PostgreSQL's reconnect — the stale-connection fix. See
    /// [`DbSession::ensure_live`] for what the whole thing is for.
    ///
    /// 🔴 **Ping first, and NEVER a retry.** The order is the safety property: the statement is only
    /// sent after liveness has been *proven*, so nothing is ever re-sent. If the connection dies in
    /// the gap between the ping and the query, that error is surfaced and the run fails — because an
    /// `INSERT` that died mid-flight may well have committed, and a silent retry would apply it
    /// twice. This must not grow into a retry loop, however tempting the remaining sliver of race
    /// looks; the same warning is at the call site in `db::query`.
    ///
    /// The ping's own error is deliberately thrown away rather than reported: it is the
    /// `UnexpectedEof` about a socket we are in the middle of replacing, and it is precisely the
    /// message that sent the user to check a host and a port that were fine. What a failure
    /// reports instead is [`reconnect_failed`].
    async fn ensure_live(&mut self, limits: &Limits) -> Result<(), DbError> {
        // The overwhelmingly common path, and it must stay cheap: one round trip, then nothing.
        if Connection::ping(&mut self.conn).await.is_ok() {
            return Ok(());
        }
        let secrets = self.owned_secrets();
        let host = format!("{}:{}", self.opts.get_host(), self.opts.get_port());
        let mut conn =
            tokio::time::timeout(self.connect_timeout, PgConnection::connect_with(&self.opts))
                .await
                .map_err(|_| reconnect_failed(&host, dial_timeout(self.connect_timeout)))?
                .map_err(|e| {
                    reconnect_failed(&host, map_sqlx_error(&e).redacted(&as_refs(&secrets)))
                })?;

        // `open`'s exact set, in `open`'s exact order, and nothing of the user's own session state
        // — see `apply_pg_session_setup` and `DbSession::ensure_live`.
        let pid = apply_pg_session_setup(
            &mut conn,
            self.read_only,
            limits.timeout_ms,
            &as_refs(&secrets),
        )
        .await
        .map_err(|e| reconnect_failed(&host, e))?;

        // Only now is the dead connection dropped: a failure above leaves the session exactly as it
        // was, so a second attempt starts from the same place rather than from a half-built one.
        self.conn = conn;
        self.backend_pid
            .set(pid.and_then(|p| u64::try_from(p).ok()));
        Ok(())
    }

    async fn run(&mut self, script: &Script, limits: &Limits) -> Result<Vec<DbResultSet>, DbError> {
        let statements = vet_sql_script(script, limits, self.read_only)?;

        // In `statement` mode we send exactly the one statement, not the surrounding text: the
        // console's editor may hold a whole script and only one of them was asked for.
        let sql = if matches!(script.mode, DbRunMode::Statement) {
            statements[0].clone()
        } else {
            script.text.clone()
        };

        let secrets = self.owned_secrets();
        let deadline = Duration::from_millis(u64::from(limits.timeout_ms));
        match tokio::time::timeout(
            deadline,
            collect(&mut self.conn, sql, &statements, limits, &as_refs(&secrets)),
        )
        .await
        {
            Ok(sets) => Ok(sets),
            Err(_) => Err(DbError::new(
                DbErrorCode::Timeout,
                format!(
                    "The query exceeded this connection's {} ms timeout.",
                    limits.timeout_ms
                ),
            )),
        }
    }

    async fn run_strict(
        &mut self,
        script: &Script,
        limits: &Limits,
    ) -> Result<Vec<DbResultSet>, DbError> {
        if !self.read_only {
            return self.run(script, limits).await;
        }
        let pieces = run_pieces(script, vet_sql_script(script, limits, self.read_only)?);
        let secrets = self.owned_secrets();
        let deadline = Duration::from_millis(u64::from(limits.timeout_ms));
        tokio::time::timeout(
            deadline,
            pg_read_only_run(&mut self.conn, &pieces, limits, &as_refs(&secrets)),
        )
        .await
        .unwrap_or_else(|_| Err(run_timed_out(limits)))
    }

    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        let secrets = self.owned_secrets();
        // 🔴 Every catalog query below uses BOUND parameters, not interpolation. A schema or table
        // name is server-provided *data* — and a schema someone created as `x'; …` would otherwise
        // splice into our SQL. Introspection is the one place in this file that prepares
        // statements; `raw_sql` is for the user's own text, where the whole point is not to.
        match node {
            // A PostgreSQL connection is bound to ONE database and cannot read another's catalog,
            // so listing `pg_database` would produce nodes that fail when expanded. The root shows
            // the connected database and says why.
            DbNodeRef::Root => Ok(vec![DbNode::new(
                DbNodeRef::Database {
                    name: self.database.clone(),
                },
                self.database.clone(),
                DbNodeKind::Database,
                true,
            )
            .with_sub_label("the connected database")]),

            DbNodeRef::Database { name } => {
                // User schemas only: `pg_catalog`, `pg_toast`, `information_schema` are the
                // server's own bookkeeping and burying `public` under them is not helpful.
                let rows: Vec<(String, i64)> = sqlx::query_as(
                    "SELECT n.nspname::text, count(c.oid) \
                     FROM pg_namespace n \
                     LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','v','m','p','f') \
                     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
                     GROUP BY n.nspname ORDER BY n.nspname",
                )
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                Ok(rows
                    .into_iter()
                    .map(|(schema, n)| {
                        DbNode::new(
                            DbNodeRef::Schema {
                                database: name.clone(),
                                name: schema.clone(),
                            },
                            schema,
                            DbNodeKind::Schema,
                            true,
                        )
                        .with_sub_label(count_label(usize::try_from(n).unwrap_or(0), "object"))
                    })
                    .collect())
            }

            DbNodeRef::Schema { database, name } => {
                let rows: Vec<(String, i64)> = sqlx::query_as(
                    "SELECT table_type::text, count(*) FROM information_schema.tables \
                     WHERE table_schema = $1 GROUP BY table_type",
                )
                .bind(name)
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                let (tables, views) = split_table_counts(&rows);
                Ok(group_nodes(database, Some(name), tables, views))
            }

            DbNodeRef::Group {
                database,
                schema,
                group,
            } => {
                let want = if matches!(group, DbGroup::Views) {
                    "VIEW"
                } else {
                    "BASE TABLE"
                };
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT table_name::text FROM information_schema.tables \
                     WHERE table_schema = $1 AND table_type = $2 ORDER BY table_name",
                )
                .bind(schema.as_deref().unwrap_or("public"))
                .bind(want)
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                Ok(rows
                    .into_iter()
                    .map(|(name,)| {
                        table_node(
                            database,
                            schema.as_deref(),
                            &name,
                            matches!(group, DbGroup::Views),
                        )
                    })
                    .collect())
            }

            DbNodeRef::Table {
                database,
                schema,
                name,
            } => {
                // `format_type` gives the server's OWN spelling **with its length** —
                // `character varying(16)`, `numeric(12,4)` — which is what the tree means by verbatim.
                // `information_schema.columns` would hand back a bare `character varying` and a
                // separate length column, i.e. a type name we would have to reassemble ourselves
                // (and would get subtly wrong for arrays and numerics).
                let rows: Vec<(String, String, bool)> = sqlx::query_as(
                    "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull \
                     FROM pg_attribute a \
                     JOIN pg_class c ON c.oid = a.attrelid \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
                     ORDER BY a.attnum",
                )
                .bind(schema.as_deref().unwrap_or("public"))
                .bind(name)
                .fetch_all(&mut self.conn)
                .await
                .map_err(|e| map_sqlx_error(&e).redacted(&as_refs(&secrets)))?;
                Ok(rows
                    .into_iter()
                    .map(|(column, type_name, nullable)| {
                        DbNode::column(
                            database,
                            schema.as_deref(),
                            name,
                            &column,
                            &type_name,
                            nullable,
                        )
                    })
                    .collect())
            }

            // Answered by the saved-query store, not the server — it must work with no session
            // at all, so `db_children` intercepts it before reaching an engine.
            // Both are answered by the saved-query store, never by the server —
            // `db_children` intercepts them before an engine is asked.
            DbNodeRef::SavedQueries | DbNodeRef::SavedQuery { .. } => Ok(Vec::new()),
        }
    }

    fn cancel_handle(&self) -> Option<Arc<dyn DbCancel>> {
        // No backend pid, nothing to cancel — and `None` says so without a round trip.
        self.backend_pid.get()?;
        Some(Arc::new(PgCancel {
            opts: self.opts.clone(),
            // The SHARED id, not a copy of today's value — see `BackendId`.
            pid: self.backend_pid.clone(),
            secrets: self.owned_secrets(),
        }))
    }

    async fn close(self: Box<Self>) {
        let _ = self.conn.close().await;
    }
}

/* ───────────────────── the checks both SQL engines run before sending ───────────────────── */

/// What every SQL run is checked against before anything is sent, in one place for both engines
/// and both run paths: something to run, the multi-statement setting, and — on a read-only session
/// — the access-mode filter. Returns the statements.
///
/// The access-mode filter refuses the whole run rather than the one statement: a script that flips
/// the mode and then writes must not execute halfway. See [`guard::read_only_escape`] for what it
/// does and does not guarantee.
fn vet_sql_script(
    script: &Script,
    limits: &Limits,
    read_only: bool,
) -> Result<Vec<String>, DbError> {
    let statements = guard::split_statements(&script.text);
    if statements.is_empty() {
        return Err(DbError::invalid_statement("There is nothing to run."));
    }
    // The multi-statement guard, shared with every other engine so two engines cannot drift into
    // disagreeing about when a script is refused.
    if let Some(blocked) = guard::multi_statement_refusal(&statements, script.mode, limits) {
        return Err(blocked);
    }
    if read_only {
        if let Some(blocked) = guard::read_only_escape(&statements) {
            return Err(blocked);
        }
    }
    Ok(statements)
}

/* ───────────────── a run held in a read-only transaction (the agent tools' path) ───────────────── */

/// The transaction-local setting a PostgreSQL read-only run sets when it begins and reads after
/// every statement. `set_config(…, true)` lasts until the transaction ends, so a value that is
/// gone means a statement ended the transaction (see [`DbSession::run_strict`]).
const PG_RUN_MARKER: &str = "agent_studio.read_only_run";

/// MySQL's "this command is not supported in the prepared statement protocol yet". The server
/// says it only after reading the text as ONE statement (a second statement is a syntax error,
/// 1064, measured on 8.4), so for the one-statement check it counts as a yes.
const MYSQL_ER_UNSUPPORTED_PS: u16 = 1295;

/// The statements a run sends, in order: the first one in `statement` mode (the console's Run),
/// all of them in `script` mode.
fn run_pieces(script: &Script, mut statements: Vec<String>) -> Vec<String> {
    if matches!(script.mode, DbRunMode::Statement) {
        statements.truncate(1);
    }
    statements
}

fn run_timed_out(limits: &Limits) -> DbError {
    DbError::new(
        DbErrorCode::Timeout,
        format!(
            "The query exceeded this connection's {} ms timeout.",
            limits.timeout_ms
        ),
    )
}

/// The refusal for a statement after which the run was no longer inside its read-only
/// transaction (or, on MySQL, the session was no longer read-only).
fn left_the_transaction(index: usize, statement: &str) -> DbError {
    DbError::blocked(format!(
        "Statement {} (`{}`) ended the read-only transaction this run is held in, or turned the \
         session's read-only off, so Agent Studio stopped there: nothing after it ran, and the \
         run was rolled back. On a read-only connection a run cannot commit, end or change the \
         transaction it is held in.",
        index + 1,
        guard::first_line(statement)
    ))
}

/// The server's answer to "is this exactly one statement?", as a result: the prepare's error,
/// stated, and nothing run.
fn not_prepared(
    statement: &str,
    e: &sqlx::Error,
    limits: &Limits,
    secrets: &[&str],
) -> DbResultSet {
    let mapped = map_sqlx_error(e).redacted(secrets);
    let several = e
        .as_database_error()
        .is_some_and(|d| d.message().contains("multiple commands"));
    let text = if several {
        format!(
            "{} The server reads this text as more than one statement, so it was not run: on a \
             read-only connection each statement is sent on its own.",
            mapped.message
        )
    } else {
        mapped.message
    };
    DbResultSet::message(statement, text, limits.row_limit)
}

fn failed(sets: &[DbResultSet]) -> bool {
    sets.iter().any(|s| s.kind == DbResultKind::Message)
}

/// PostgreSQL: `BEGIN TRANSACTION READ ONLY`, the statements, `ROLLBACK` — always.
async fn pg_read_only_run(
    conn: &mut PgConnection,
    pieces: &[String],
    limits: &Limits,
    secrets: &[&str],
) -> Result<Vec<DbResultSet>, DbError> {
    exec_one(&mut *conn, "BEGIN TRANSACTION READ ONLY", secrets).await?;
    let ran = pg_read_only_statements(conn, pieces, limits, secrets).await;
    // Whatever happened above. A failed ROLLBACK leaves nothing to undo that closing the
    // connection would not: the callers of this path close their session when the run ends.
    let _ = exec_one(&mut *conn, "ROLLBACK", secrets).await;
    ran
}

async fn pg_read_only_statements(
    conn: &mut PgConnection,
    pieces: &[String],
    limits: &Limits,
    secrets: &[&str],
) -> Result<Vec<DbResultSet>, DbError> {
    // A ULID is digits and capitals only, so it is safe inside the literal.
    let marker = ulid::Ulid::new().to_string();
    exec_one(
        &mut *conn,
        &format!("SELECT set_config('{PG_RUN_MARKER}', '{marker}', true)"),
        secrets,
    )
    .await?;
    let mut sets = Vec::new();
    for (i, piece) in pieces.iter().enumerate() {
        // One statement, by the server's reading. A Parse executes nothing; a second statement in
        // the text is "cannot insert multiple commands into a prepared statement".
        if let Err(e) = sqlx::Executor::prepare(
            &mut *conn,
            sqlx::SqlSafeStr::into_sql_str(AssertSqlSafe(piece.clone())),
        )
        .await
        {
            sets.push(not_prepared(piece, &e, limits, secrets));
            break;
        }
        let got = collect(
            &mut *conn,
            piece.clone(),
            std::slice::from_ref(piece),
            limits,
            secrets,
        )
        .await;
        let stop = failed(&got);
        sets.extend(got);
        if stop {
            break;
        }
        let held = sqlx::query_scalar::<_, Option<String>>(AssertSqlSafe(format!(
            "SELECT current_setting('{PG_RUN_MARKER}', true)"
        )))
        .persistent(false)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| map_sqlx_error(&e).redacted(secrets))?;
        if held.as_deref() != Some(marker.as_str()) {
            return Err(left_the_transaction(i, piece));
        }
    }
    Ok(sets)
}

/// MySQL: `START TRANSACTION READ ONLY`, the statements, `ROLLBACK` — always.
async fn mysql_read_only_run(
    conn: &mut MySqlConnection,
    pieces: &[String],
    limits: &Limits,
    secrets: &[&str],
) -> Result<Vec<DbResultSet>, DbError> {
    exec_one(&mut *conn, "START TRANSACTION READ ONLY", secrets).await?;
    let ran = mysql_read_only_statements(conn, pieces, limits, secrets).await;
    let _ = exec_one(&mut *conn, "ROLLBACK", secrets).await;
    ran
}

async fn mysql_read_only_statements(
    conn: &mut MySqlConnection,
    pieces: &[String],
    limits: &Limits,
    secrets: &[&str],
) -> Result<Vec<DbResultSet>, DbError> {
    // MySQL has no transaction-local variable, but a savepoint lives exactly as long as its
    // transaction: `RELEASE SAVEPOINT` of one that is gone is error 1305.
    let savepoint = format!(
        "agent_studio_{}",
        ulid::Ulid::new().to_string().to_ascii_lowercase()
    );
    exec_one(&mut *conn, &format!("SAVEPOINT {savepoint}"), secrets).await?;
    // Read after every statement as well: inside a read-only transaction MySQL still lets
    // `SET SESSION TRANSACTION READ WRITE` (say, through `PREPARE`/`EXECUTE`, which the access-mode
    // filter does not read) change the session, and the next DDL's implicit commit would then run
    // read-write. Measured on 8.4.
    let check = format!(
        "RELEASE SAVEPOINT {savepoint}; SAVEPOINT {savepoint}; \
         SELECT @@SESSION.transaction_read_only"
    );
    let mut sets = Vec::new();
    for (i, piece) in pieces.iter().enumerate() {
        match sqlx::Executor::prepare(
            &mut *conn,
            sqlx::SqlSafeStr::into_sql_str(AssertSqlSafe(piece.clone())),
        )
        .await
        {
            Ok(_) => {}
            Err(e) if mysql_error_number(&e) == Some(MYSQL_ER_UNSUPPORTED_PS) => {}
            Err(e) => {
                sets.push(not_prepared(piece, &e, limits, secrets));
                break;
            }
        }
        let got = collect(
            &mut *conn,
            piece.clone(),
            std::slice::from_ref(piece),
            limits,
            secrets,
        )
        .await;
        let stop = failed(&got);
        sets.extend(got);
        if stop {
            break;
        }
        let held = sqlx::raw_sql(AssertSqlSafe(check.clone()))
            .fetch_all(&mut *conn)
            .await
            .ok()
            .and_then(|rows| {
                rows.first()
                    .and_then(|r| r.try_get_unchecked::<Option<String>, _>(0).ok().flatten())
            });
        if held.as_deref() != Some("1") {
            return Err(left_the_transaction(i, piece));
        }
    }
    Ok(sets)
}

/// What a read-only MySQL run refuses before anything is sent, because no transaction can hold it.
///
/// * `CALL` (and `EXECUTE`, which can run a prepared `CALL`): MySQL lets a procedure `COMMIT`, so
///   one `CALL` can end the transaction, turn the session read-write and write — inside a single
///   statement, before any check between statements can see it. PostgreSQL refuses a `COMMIT` in
///   a procedure called inside a transaction block, so it needs no such rule.
/// * An executable comment (`/*! … */`): MySQL runs what is inside it, so it hides SQL from every
///   check that reads the text.
fn mysql_unheld(pieces: &[String]) -> Option<DbError> {
    for piece in pieces {
        if piece.contains("/*!") {
            return Some(DbError::blocked(format!(
                "On a read-only connection a run cannot hold an executable comment (`/*! … */`): \
                 MySQL runs what is inside it, where no check reads it. Write the SQL without \
                 one: {}",
                guard::first_line(piece)
            )));
        }
        let keyword = mysql_leading_keyword(piece);
        if keyword == "call" || keyword == "execute" {
            return Some(DbError::blocked(format!(
                "On a read-only MySQL connection a run cannot `{}`: a procedure can commit and turn \
                 read-only off inside one statement, which no read-only transaction can hold. \
                 Run the procedure's SELECTs directly.",
                keyword.to_ascii_uppercase()
            )));
        }
    }
    None
}

/// The first word of a MySQL statement, lower-cased, after MySQL's comments (`#`, `-- `, `/* */`).
fn mysql_leading_keyword(statement: &str) -> String {
    let after_line = |s: &str| -> String { s.split_once('\n').map_or("", |(_, t)| t).to_string() };
    let mut rest = statement.to_string();
    loop {
        let trimmed = rest.trim_start().to_string();
        // `#` always starts a comment; `--` only when whitespace (or the end) follows it.
        let line_comment = trimmed.starts_with('#')
            || trimmed
                .strip_prefix("--")
                .is_some_and(|after| after.chars().next().is_none_or(char::is_whitespace));
        if line_comment {
            rest = after_line(&trimmed);
        } else if let Some(r) = trimmed.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, t)| t).to_string();
        } else {
            rest = trimmed;
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_ascii_lowercase()
}

/// The server's error number of a MySQL error, when `e` is one.
fn mysql_error_number(e: &sqlx::Error) -> Option<u16> {
    e.as_database_error()?
        .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
        .map(|d| d.number())
}

/// Drive the driver's per-statement stream into one [`DbResultSet`] per statement.
///
/// The whole script goes to the server as **one** `raw_sql` batch, which is both what makes the
/// simple query protocol (and therefore the text encoding every cell is read in) available and the exact shape the
/// read-only measurement in the module doc is about.
///
/// A database error ends the batch — Postgres rolls the implicit transaction back — and is
/// appended as a `message` result attributed to the statement that was running, so the output
/// pane shows "statements 1 and 2 produced this, statement 3 said that".
async fn collect<'c, DB, E>(
    executor: E,
    sql: String,
    statements: &[String],
    limits: &Limits,
    secrets: &[&str],
) -> Vec<DbResultSet>
where
    DB: sqlx::Database,
    E: sqlx::Executor<'c, Database = DB>,
    // The two decodes every cell goes through (text first, bytes as the fallback).
    for<'r> Option<String>: sqlx::Decode<'r, DB> + sqlx::Type<DB>,
    for<'r> Option<Vec<u8>>: sqlx::Decode<'r, DB> + sqlx::Type<DB>,
    // Positional cell access. Both drivers implement it; naming it is what lets this function
    // be written once instead of once per engine.
    usize: sqlx::ColumnIndex<DB::Row>,
    // `rows_affected` lives on the concrete QueryResult types, not on a shared trait, so the
    // bound has to be spelled structurally.
    DB::QueryResult: RowsAffected,
{
    let cap = limits.row_limit as usize;
    let mut sets: Vec<DbResultSet> = Vec::new();
    let mut idx = 0usize;
    let mut started = Instant::now();
    let mut columns: Vec<DbColumn> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    let mut saw_rows = false;

    let label = |i: usize| -> String {
        statements
            .get(i)
            .cloned()
            .unwrap_or_else(|| statements.last().cloned().unwrap_or_default())
    };

    {
        let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(executor);
        while let Some(item) = stream.next().await {
            match item {
                Ok(Either::Right(row)) => {
                    saw_rows = true;
                    if columns.is_empty() {
                        columns = columns_of(&row);
                    }
                    if rows.len() < cap {
                        rows.push(read_row(&row, columns.len()));
                    } else {
                        // We *saw* the extra row — truncation is measured, not inferred from
                        // `rows.len() == cap`, which is wrong exactly when the table has that
                        // many rows. Keep draining so later statements still report.
                        truncated = true;
                    }
                }
                Ok(Either::Left(done)) => {
                    let affected = done.rows_affected();
                    let stmt = label(idx);
                    let kind = if saw_rows || guard::is_row_returning(&stmt) {
                        DbResultKind::Rows
                    } else {
                        DbResultKind::Affected
                    };
                    sets.push(DbResultSet {
                        kind,
                        statement: stmt,
                        columns: std::mem::take(&mut columns),
                        rows: std::mem::take(&mut rows),
                        rows_affected: i64::try_from(affected).ok(),
                        truncated,
                        row_limit: limits.row_limit,
                        duration_ms: started.elapsed().as_millis() as u64,
                        notice: None,
                        // A SQL row is a fixed tuple: every column is present or NULL, so there is
                        // no third state and no mask to send.
                        absent: None,
                    });
                    idx += 1;
                    truncated = false;
                    saw_rows = false;
                    started = Instant::now();
                }
                Err(e) => {
                    // A SQL error is a normal outcome of a console, so it resolves as a result
                    // rather than rejecting the command.
                    let mapped = map_sqlx_error(&e).redacted(secrets);
                    sets.push(DbResultSet::message(
                        label(idx),
                        mapped.message,
                        limits.row_limit,
                    ));
                    break;
                }
            }
        }
    }
    sets
}

/// The column headers of a row, with each cell kind taken from the **declared type**.
fn columns_of<R: Row>(row: &R) -> Vec<DbColumn>
where
    <R as Row>::Database: sqlx::Database,
{
    row.columns()
        .iter()
        .map(|c| {
            let type_name = c.type_info().name().to_string();
            DbColumn {
                name: c.name().to_string(),
                kind: cell_kind(&type_name),
                type_name,
            }
        })
        .collect()
}

/// Read every cell of `row` as `Option<String>`.
fn read_row<R: Row>(row: &R, ncols: usize) -> Vec<Option<String>>
where
    for<'r> Option<String>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    for<'r> Option<Vec<u8>>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    (0..ncols).map(|i| read_cell(row, i)).collect()
}

/// One cell, as text.
///
/// `try_get_unchecked` skips sqlx's `Type::compatible` check, which is what allows `String` for
/// an `int4` column — in the simple query protocol every value on the wire already *is* text.
/// The `Vec<u8>` fallback covers a column whose text encoding is not valid UTF-8; the final
/// placeholder is deliberately visible rather than `None`, because reporting an unreadable
/// value as SQL NULL would be the app lying about the data.
fn read_cell<R: Row>(row: &R, i: usize) -> Option<String>
where
    for<'r> Option<String>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    for<'r> Option<Vec<u8>>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    match row.try_get_unchecked::<Option<String>, _>(i) {
        Ok(v) => v,
        Err(_) => match row.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
            Ok(Some(bytes)) => Some(hex(&bytes)),
            Ok(None) => None,
            Err(_) => Some("<unreadable value>".to_string()),
        },
    }
}

/// `\x`-prefixed lower-case hex, the spelling Postgres itself uses for `bytea`.
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("\\x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Postgres,
            family: DbFamily::Postgres,
            host: "db.internal".into(),
            port: Some(5432),
            srv: false,
            database: "maestro".into(),
            user: "ro".into(),
            password: "s3cret-hunter2".into(),
            ssl_mode: SslMode::Prefer,
            ca_pem: None,
            options: BTreeMap::new(),
            url: None,
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    #[test]
    fn postgres_is_wired_and_reports_its_own_spec() {
        let e = engine_for(DbEngineId::Postgres).expect("postgres is wired");
        assert_eq!(e.spec().id, DbEngineId::Postgres);
    }

    /// 🔴 **Each wired engine must report the descriptor for the id it was registered under.**
    ///
    /// This pins a trap that is easy to reintroduce. `PostgresEngine` was zero-sized and
    /// hardcoded `DbEngineId::Postgres` in `spec()`, which was fine while it served one row —
    /// and the moment Aurora PostgreSQL was registered against the same type, an Aurora
    /// connection would have reported itself as "PostgreSQL" and served Postgres's defaults
    /// (including its `sslMode`, which differs). Same trap on the MySQL side. Nothing else in
    /// the suite looks at the pairing, because every other test asks for one engine by name.
    #[test]
    fn every_wired_engine_reports_the_spec_of_the_id_it_is_registered_under() {
        for id in [
            DbEngineId::Postgres,
            DbEngineId::AuroraPostgres,
            DbEngineId::Mysql,
            DbEngineId::AuroraMysql,
            DbEngineId::Clickhouse,
            DbEngineId::Mongodb,
        ] {
            let e = engine_for(id).expect("wired");
            assert_eq!(
                e.spec().id,
                id,
                "{id:?} reports another engine's descriptor"
            );
        }
    }

    /// The two families share one type each, so the labels are the cheapest proof the pairing
    /// is not merely self-consistent but actually distinct.
    #[test]
    fn the_aurora_rows_are_not_just_aliases_of_the_engine_beside_them() {
        let pg = engine_for(DbEngineId::Postgres).unwrap().spec();
        let aurora_pg = engine_for(DbEngineId::AuroraPostgres).unwrap().spec();
        assert_eq!(pg.label, "PostgreSQL");
        assert_eq!(aurora_pg.label, "Amazon Aurora PostgreSQL");
        let my = engine_for(DbEngineId::Mysql).unwrap().spec();
        let aurora_my = engine_for(DbEngineId::AuroraMysql).unwrap().spec();
        assert_eq!(my.label, "MySQL");
        assert_eq!(aurora_my.label, "Amazon Aurora MySQL");
    }

    /// **Every descriptor row resolves to an engine, and each reports the row it was registered
    /// under.** That is every row — this test used to assert the opposite for Redis and Valkey
    /// while they were not wired, and it earned its keep on the way through: both halves of the
    /// pairing are what an earlier Aurora bug was, where one engine type served two rows and
    /// hardcoded one id.
    #[test]
    fn every_descriptor_row_resolves_to_an_engine_that_knows_which_row_it_is() {
        for spec in engines::ENGINES {
            let engine = engine_for(spec.id).unwrap_or_else(|e| {
                panic!(
                    "{:?} has a descriptor but no engine: {}",
                    spec.id, e.message
                )
            });
            assert_eq!(
                engine.spec().id,
                spec.id,
                "{:?} resolved to an engine reporting {:?} — the one-type-two-rows Aurora bug",
                spec.id,
                engine.spec().id
            );
            assert_eq!(engine.spec().label, spec.label);
        }
    }

    #[test]
    fn debug_on_the_resolved_config_never_prints_the_password() {
        // This is the leak that is only ever found when someone pastes a log, so it is a test
        // rather than a convention.
        let printed = format!("{:?}", cfg());
        assert!(
            !printed.contains("s3cret-hunter2"),
            "ResolvedConfig's Debug leaked the password: {printed}"
        );
        assert!(printed.contains("<redacted>"));
        // The non-secret fields must still be there, or the redaction has made the type
        // useless for the debugging it exists for.
        assert!(printed.contains("db.internal") && printed.contains("maestro"));
    }

    #[test]
    fn debug_redacts_a_url_wholesale_because_its_userinfo_can_carry_the_secret() {
        let mut c = cfg();
        c.url = Some("postgresql://ro:s3cret-hunter2@db.internal:5432/maestro".into());
        let printed = format!("{c:?}");
        assert!(!printed.contains("s3cret-hunter2"), "{printed}");
    }

    #[test]
    fn connect_options_take_the_form_fields_and_the_declared_ssl_mode() {
        let mut c = cfg();
        c.ssl_mode = SslMode::VerifyFull;
        c.options
            .insert("applicationName".into(), "Agent Studio".into());
        let opts = PostgresEngine::connect_options(&c).expect("options build");
        assert_eq!(opts.get_host(), "db.internal");
        assert_eq!(opts.get_port(), 5432);
        assert_eq!(opts.get_username(), "ro");
        assert_eq!(opts.get_database(), Some("maestro"));
        // `PgSslMode` implements neither `PartialEq` nor `Display`, so its `Debug` spelling is
        // the only thing available to compare. Found the first time this compiled.
        assert_eq!(format!("{:?}", opts.get_ssl_mode()), "VerifyFull");
        assert_eq!(opts.get_application_name(), Some("Agent Studio"));
    }

    /// 🔴 **An empty port field dials the engine's standard port**, for both sqlx engines, and it is
    /// the *descriptor's* number — the same one the dialog shows in the empty box.
    ///
    /// Hand-written expectations (5432/3306) rather than `spec.default_port`: a test that reads its
    /// expectation from the table under test can only prove plumbing, and the claim
    /// here is about these two values specifically.
    ///
    /// ⚠️ For Postgres this deliberately does **not** use sqlx's own default. Measured in
    /// `sqlx-postgres-0.9.0/src/options/mod.rs:57`: `new_without_pgpass()` sets its port from
    /// **`$PGPORT`**, falling back to 5432. Letting that stand would make the dialog's placeholder
    /// wrong on any machine where `PGPORT` is set and would make this test depend on the developer's
    /// environment — so `connect_options` always calls `.port()`, with
    /// `port_or_default()`.
    #[test]
    fn an_empty_port_field_dials_the_engines_standard_port() {
        let mut c = cfg();
        c.port = None;
        assert_eq!(
            PostgresEngine::connect_options(&c).unwrap().get_port(),
            5432,
            "PostgreSQL's standard port"
        );
        // Independent of the environment, which is the reason for not taking sqlx's default. If the
        // `.port()` call were removed, this assertion would silently start tracking `$PGPORT`.
        assert_eq!(c.port_or_default(), 5432);

        let mut m = cfg();
        m.engine = DbEngineId::Mysql;
        m.family = DbFamily::Mysql;
        m.port = None;
        assert_eq!(
            MysqlEngine::connect_options(&m).unwrap().get_port(),
            3306,
            "MySQL's standard port"
        );

        // Aurora shares its upstream's port through its own descriptor row, so the preset cannot
        // quietly inherit the wrong number.
        let mut aurora = cfg();
        aurora.engine = DbEngineId::AuroraPostgres;
        aurora.port = None;
        assert_eq!(aurora.port_or_default(), 5432);

        // …and an explicit port is still exactly what it says.
        let mut explicit = cfg();
        explicit.port = Some(6543);
        assert_eq!(explicit.port_or_default(), 6543);
        assert_eq!(
            PostgresEngine::connect_options(&explicit)
                .unwrap()
                .get_port(),
            6543
        );
    }

    /// A message must not print `db.internal:0`, or a made-up port, for a connection that has none.
    #[test]
    fn the_host_label_names_a_port_only_when_there_is_one() {
        let mut c = cfg();
        assert_eq!(c.host_label(), "db.internal:5432");
        c.port = None;
        assert_eq!(c.host_label(), "db.internal");
    }

    #[test]
    fn a_raw_url_overrides_the_form_fields() {
        // The dialog says the URL field "Overrides settings above"; this is that,
        // and it is the driver — not us — that parses the string.
        let mut c = cfg();
        c.url = Some("postgresql://someone:pw@other.host:6543/other".into());
        let opts = PostgresEngine::connect_options(&c).expect("options build");
        assert_eq!(opts.get_host(), "other.host");
        assert_eq!(opts.get_port(), 6543);
        assert_eq!(opts.get_username(), "someone");
        assert_eq!(opts.get_database(), Some("other"));
    }

    /* ────────── the URL override and the password typed beside it ────────── */

    /// `PgConnectOptions`/`MySqlConnectOptions` expose `get_username` but **no** password getter,
    /// so the only hermetic way to see whether the password reached the driver is their derived
    /// `Debug` — which does print it (`password: Option<String>`, `#[derive(Debug)]`, measured in
    /// `sqlx-postgres-0.9.0/src/options/mod.rs:16`).
    ///
    /// That is a fragile-looking assertion and it is deliberate: if sqlx ever starts redacting its
    /// own `Debug`, this goes **red** rather than quietly passing, and someone re-reads it. The
    /// claim it stands in for is proved for real against a live server in
    /// `db_live.rs::…a_url_with_no_password_still_uses_the_typed_one`; this one is the fast guard
    /// that runs in the ordinary `cargo test`.
    fn sends_password(printed: &str, password: &str) -> bool {
        printed.contains(&format!("password: Some({password:?})"))
    }

    /// 🔴 **The dropped-password bug.** `Connection type: URL only`, a string our own importer
    /// had stripped the password out of, and the password typed into the field the dialog points
    /// at — and the app dialled with no password at all.
    ///
    /// The negative half is the load-bearing one: a URL that *does* carry a password
    /// must keep its own, so the typed one must be **absent** from what dials. Without that, this
    /// test would pass on an implementation that simply always applies the field.
    #[test]
    fn a_url_that_carries_no_password_still_takes_the_one_typed_beside_it() {
        let mut c = cfg();
        c.user = "gazelle".into();
        c.password = "typed-pw".into();
        c.url = Some("postgresql://gazelle@localhost:5433/orders".into());
        let opts = PostgresEngine::connect_options(&c).expect("options build");
        assert_eq!(
            opts.get_host(),
            "localhost",
            "the URL still wins on the host"
        );
        assert_eq!(opts.get_username(), "gazelle");
        assert!(
            sends_password(&format!("{opts:?}"), "typed-pw"),
            "the typed password never reached the driver"
        );

        // The negative control: the string speaks for itself, so the field must not overwrite it.
        let mut carried = c.clone();
        carried.url = Some("postgresql://gazelle:url-pw@localhost:5433/orders".into());
        let printed = format!("{:?}", PostgresEngine::connect_options(&carried).unwrap());
        assert!(
            sends_password(&printed, "url-pw"),
            "the URL's own password must survive: {printed}"
        );
        assert!(
            !printed.contains("typed-pw"),
            "the field overwrote a password the string already carried: {printed}"
        );

        // MySQL shares the rule through `fill_credential_gaps`, and shared code is exactly where a
        // second engine silently keeps the old behaviour.
        let mut m = c.clone();
        m.engine = DbEngineId::Mysql;
        m.family = DbFamily::Mysql;
        m.url = Some("mysql://gazelle@localhost:3307/orders".into());
        assert!(sends_password(
            &format!("{:?}", MysqlEngine::connect_options(&m).unwrap()),
            "typed-pw"
        ));
        m.url = Some("mysql://gazelle:url-pw@localhost:3307/orders".into());
        let printed = format!("{:?}", MysqlEngine::connect_options(&m).unwrap());
        assert!(sends_password(&printed, "url-pw"), "{printed}");
        assert!(!printed.contains("typed-pw"), "{printed}");
    }

    /// A credential in a **query parameter** is the same credential in a different place
    /// (`url::parse_parts` folds it into the one slot), so it must suppress the field just as the
    /// userinfo does — libpq and sqlx both honour `?password=`.
    #[test]
    fn a_password_in_a_query_parameter_counts_as_the_url_speaking() {
        let mut c = cfg();
        c.password = "typed-pw".into();
        c.url = Some("postgresql://ro@db.internal:5432/maestro?password=url-pw".into());
        let printed = format!("{:?}", PostgresEngine::connect_options(&c).unwrap());
        assert!(
            !printed.contains("typed-pw"),
            "a `?password=` is a password the string carries: {printed}"
        );
    }

    /// The other half of "the URL wins where it *says* something": a string with no userinfo says
    /// nothing about the user either, and without this the connection would dial as whatever
    /// `PgConnectOptions`'s URL parse defaults the username to (the OS user) while a User field sat
    /// right there — and `dial_error` would then name an account nothing tried.
    #[test]
    fn a_url_that_names_no_user_still_takes_the_user_field() {
        let mut c = cfg();
        c.user = "gazelle".into();
        c.url = Some("postgresql://localhost:5433/orders".into());
        assert_eq!(
            PostgresEngine::connect_options(&c).unwrap().get_username(),
            "gazelle"
        );
        // …and a URL that DOES name one keeps it (the control for the line above).
        c.url = Some("postgresql://someone@localhost:5433/orders".into());
        assert_eq!(
            PostgresEngine::connect_options(&c).unwrap().get_username(),
            "someone"
        );
    }

    /// `url::credential_of` returns "says nothing" for a string it cannot parse, so a URL our
    /// grammar is narrower than the driver's still gets the typed password rather than silently
    /// dropping it. Postgres's socket form is the real example: sqlx accepts it, `parse_parts` has
    /// no host to find.
    #[test]
    fn a_url_our_own_parser_cannot_read_still_gets_the_typed_password() {
        let mut c = cfg();
        c.password = "typed-pw".into();
        c.url = Some("postgresql://%2Fvar%2Frun%2Fpostgresql/maestro".into());
        let opts = PostgresEngine::connect_options(&c).expect("sqlx accepts the socket form");
        assert!(
            sends_password(&format!("{opts:?}"), "typed-pw"),
            "a string we cannot parse says nothing, so the field still fills the gap"
        );
    }

    #[test]
    fn an_unparseable_url_is_invalid_config_and_carries_no_secret() {
        let mut c = cfg();
        c.url = Some("not a url at all".into());
        let err = PostgresEngine::connect_options(&c).expect_err("must refuse");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(!err.message.contains("s3cret-hunter2"));
    }

    /// Compared through `Debug`, because `PgSslMode` derives neither `PartialEq` nor `Display`.
    /// The strings are the driver's own variant names, so a renamed variant is a failure here
    /// rather than a silent downgrade of somebody's TLS posture.
    #[test]
    fn the_ssl_ladder_maps_one_to_one() {
        for (ours, theirs) in [
            (SslMode::Disable, "Disable"),
            (SslMode::Prefer, "Prefer"),
            (SslMode::Require, "Require"),
            (SslMode::VerifyCa, "VerifyCa"),
            (SslMode::VerifyFull, "VerifyFull"),
        ] {
            assert_eq!(format!("{:?}", pg_ssl_mode(ours)), theirs, "{ours:?}");
        }
    }

    #[test]
    fn the_connect_timeout_comes_from_the_option_and_falls_back_to_ten_seconds() {
        let mut c = cfg();
        assert_eq!(PostgresEngine::connect_timeout(&c), DEFAULT_CONNECT_TIMEOUT);
        c.options.insert("connectTimeout".into(), "3".into());
        assert_eq!(PostgresEngine::connect_timeout(&c), Duration::from_secs(3));
        // Nonsense and zero both fall back rather than producing an instant timeout.
        c.options.insert("connectTimeout".into(), "soon".into());
        assert_eq!(PostgresEngine::connect_timeout(&c), DEFAULT_CONNECT_TIMEOUT);
        c.options.insert("connectTimeout".into(), "0".into());
        assert_eq!(PostgresEngine::connect_timeout(&c), DEFAULT_CONNECT_TIMEOUT);
    }

    #[test]
    fn hex_uses_the_spelling_postgres_itself_uses() {
        assert_eq!(hex(b"Hello"), "\\x48656c6c6f");
        assert_eq!(hex(&[0x00, 0xff, 0x10]), "\\x00ff10");
        assert_eq!(hex(&[]), "\\x");
    }

    /* ─────────────────────────── the stale-connection fix ─────────────────────────── */

    fn test_limits() -> Limits {
        Limits {
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    /// An engine that takes the **default** [`DbSession::ensure_live`] — ClickHouse, DynamoDB and
    /// MongoDB, whose transports cannot hold a stale socket the way a single `PgConnection` does.
    ///
    /// It counts every call that reaches it, so "the default is a no-op" is an *observation* rather
    /// than a restatement of the source. An "improvement" that made the default probe the server
    /// would cost three engines a round trip per query and would show up here immediately.
    #[derive(Default)]
    struct DefaultSession {
        probes: usize,
        runs: usize,
        children: usize,
    }

    #[async_trait]
    impl DbSession for DefaultSession {
        async fn probe(&mut self) -> Result<ServerInfo, DbError> {
            self.probes += 1;
            Ok(ServerInfo {
                version: "default".into(),
                backend_pid: None,
            })
        }
        async fn run(
            &mut self,
            _script: &Script,
            _limits: &Limits,
        ) -> Result<Vec<DbResultSet>, DbError> {
            self.runs += 1;
            Ok(Vec::new())
        }
        async fn children(&mut self, _node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
            self.children += 1;
            Ok(Vec::new())
        }
        async fn close(self: Box<Self>) {}
    }

    #[tokio::test]
    async fn the_default_ensure_live_succeeds_and_reaches_nothing() {
        let mut s = DefaultSession::default();
        assert!(
            s.ensure_live(&test_limits()).await.is_ok(),
            "an engine that does not override `ensure_live` must not be broken by its existence"
        );
        assert_eq!(
            (s.probes, s.runs, s.children),
            (0, 0, 0),
            "the default `ensure_live` must touch NOTHING. ClickHouse, DynamoDB and MongoDB take it \
             precisely because their transports need no liveness check, and a default that quietly \
             made one would spend a round trip per query on all three."
        );
    }

    #[tokio::test]
    async fn an_engine_whose_read_only_is_per_command_runs_strictly_as_it_always_does() {
        let mut s = DefaultSession::default();
        let script = Script {
            text: "GET k".into(),
            mode: DbRunMode::Statement,
        };
        assert!(s.run_strict(&script, &test_limits()).await.is_ok());
        assert_eq!(s.runs, 1, "its own run, once");
    }

    #[test]
    fn a_read_only_run_sends_the_first_statement_or_all_of_them() {
        let statements = vec!["SELECT 1".to_string(), "SELECT 2".to_string()];
        let script = |mode| Script {
            text: String::new(),
            mode,
        };
        assert_eq!(
            run_pieces(&script(DbRunMode::Statement), statements.clone()),
            ["SELECT 1"]
        );
        assert_eq!(
            run_pieces(&script(DbRunMode::Script), statements),
            ["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn a_read_only_mysql_run_refuses_what_no_transaction_can_hold() {
        for refused in [
            "CALL p()",
            "call p()",
            "  -- why\nCALL p()",
            "# why\nCALL p()",
            "/* why */ call p()",
            "/* a */ /* b */\n\tEXECUTE s",
            "EXECUTE s USING @a",
            "SELECT 1 /*! ; COMMIT */",
            "/*!50000 CALL p() */",
        ] {
            let err = mysql_unheld(&[refused.to_string()])
                .unwrap_or_else(|| panic!("{refused:?} was not refused"));
            assert_eq!(err.code, DbErrorCode::Blocked, "{refused:?}");
        }
        for allowed in [
            "SELECT 1",
            "SELECT 'call me'",
            "SELECT callback FROM t",
            "PREPARE s FROM 'SELECT 1'",
            "--1",
            "/*+ MAX_EXECUTION_TIME(10) */ SELECT 1",
            "WITH call AS (SELECT 1) SELECT * FROM call",
        ] {
            assert!(
                mysql_unheld(&[allowed.to_string()]).is_none(),
                "{allowed:?}"
            );
        }
        assert_eq!(
            mysql_leading_keyword("# a\n-- b\n/* c */ Select 1"),
            "select"
        );
        assert_eq!(mysql_leading_keyword("--1"), "");
        assert_eq!(mysql_leading_keyword("/* never closed"), "");
        assert_eq!(mysql_leading_keyword("# never ends"), "");
    }

    #[test]
    fn the_read_only_run_refusal_names_the_statement_and_what_did_not_run() {
        let err = left_the_transaction(1, "COMMIT");
        assert_eq!(err.code, DbErrorCode::Blocked);
        assert!(
            err.message
                .starts_with("Statement 2 (`COMMIT`) ended the read-only transaction"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("nothing after it ran"),
            "{}",
            err.message
        );
    }

    /// 🔴 **The failure the user must NOT be shown is the dead socket's own.**
    ///
    /// That error — `UnexpectedEof`, *"(expected to read 5 bytes, got 0 bytes at EOF)"* — is what
    /// a dead socket produces, and `error.rs` renders it as advice about SSL modes and poolers. It is
    /// about a socket we have already thrown away, so repeating it sends the user to inspect a host
    /// and a port that are fine. `ensure_live` discards the probe's error and reports the reconnect
    /// attempt instead; this pins the sentence that replaces it.
    #[test]
    fn a_failed_reconnect_says_the_connection_dropped_and_never_replays_the_eof() {
        // The exact shape of the dead socket's error, built through the real mapper.
        let eof = map_sqlx_error(&sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "expected to read 5 bytes, got 0 bytes at EOF",
        )));
        assert!(
            eof.message.contains("expected to read 5 bytes"),
            "the fixture for this test stopped being the dead-socket error: {}",
            eof.message
        );

        // A reconnect that failed for a *current*, actionable reason — a server that is now down.
        let refused = map_sqlx_error(&sqlx::Error::Io(std::io::Error::from(
            std::io::ErrorKind::ConnectionRefused,
        )));
        let out = reconnect_failed("db.internal:5432", refused.clone());

        assert!(
            out.message.starts_with(
                "This connection had been closed by the server and could not be re-established."
            ),
            "the first sentence is the diagnosis, and it must be first: {}",
            out.message
        );
        assert!(
            out.message.contains("db.internal:5432") && out.message.contains(&refused.message),
            "the FRESH dial's answer is the actionable half and must survive: {}",
            out.message
        );
        assert!(
            !out.message.contains("expected to read 5 bytes"),
            "the dead socket's EOF leaked into the message the user reads: {}",
            out.message
        );
        assert_eq!(
            out.code, refused.code,
            "the fresh dial's classification is what the panel should branch on — flattening it to \
             `unknown` would lose `auth` for a rotated password"
        );
    }

    /// The classification really is carried through, not merely equal by luck on one input.
    #[test]
    fn a_failed_reconnect_keeps_the_fresh_dials_code() {
        for code in [
            DbErrorCode::Auth,
            DbErrorCode::Tls,
            DbErrorCode::Network,
            DbErrorCode::Timeout,
        ] {
            let out = reconnect_failed("h:1", DbError::new(code, "why"));
            assert_eq!(out.code, code);
        }
    }

    /// 🔴 **A stale backend id is not a stale curiosity — it is a cancel aimed at a stranger.**
    ///
    /// `PgCancel` runs `SELECT pg_cancel_backend(pid)`: a SQL call against whichever backend holds
    /// that pid *now*. A handle frozen at the pid the session had before a reconnect would, once the
    /// OS recycled it, ask the server to interrupt somebody else's statement — most plausibly this
    /// app's own other session, since `pg_cancel_backend` succeeds for any backend the same role
    /// owns. Sharing the id is the fix, and this is the property that makes it true.
    #[test]
    fn a_reconnect_moves_the_id_the_cancel_handle_will_read() {
        let id = BackendId::new(Some(4242));
        let handle = id.clone(); // what `cancel_handle` keeps
        assert_eq!(handle.get(), Some(4242));

        id.set(Some(9001)); // what `ensure_live` does after a re-dial
        assert_eq!(
            handle.get(),
            Some(9001),
            "the cancel handle is still pointing at the backend that DIED — the next Stop would be \
             aimed at whatever process inherited that pid"
        );

        // A reconnect that could not learn an id disarms the handle rather than guessing.
        id.set(None);
        assert_eq!(handle.get(), None);
        assert_eq!(
            nothing_to_cancel().code,
            DbErrorCode::Unknown,
            "and the refusal is a real, classified error rather than a silent Ok"
        );
    }
}
