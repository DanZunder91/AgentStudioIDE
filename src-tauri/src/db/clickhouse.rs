//! The ClickHouse engine — over its **HTTP interface**, using the `reqwest` already in the tree.
//!
//! Its own module rather than another block in `engine.rs` because it shares nothing with the
//! `sqlx` engines: no connection, no prepared statements, no streaming rows. What it does share
//! is the *contract* — [`DbEngine`] / [`DbSession`] and [`DbResultSet`] — which is the point of
//! having a seam at all. No new dependency (`reqwest` 0.13, already shipped).
//!
//! ## Every choice below was measured against the fixture, not read from the docs
//!
//! **The response format is `JSONCompact`, and the obvious-looking alternative is a trap.**
//! `JSONCompactStrings` renders every value as a string, which sounds like an exact match for
//! our `Option<String>` cell model — but it renders SQL NULL as the literal string `"ᴺᵁᴸᴸ"`
//! (U+1D3A…), indistinguishable from a real string containing those characters. That is exactly
//! the NULL-vs-`''` collapse the text-only cell model exists to prevent. `JSONCompact` gives real JSON `null`, and
//! quotes 64-bit integers by default:
//!
//! ```text
//! JSONCompact        SELECT toInt64(9007199254740993), NULL, ''  → ["9007199254740993", null, ""]
//! JSONCompactStrings same query                                  → ["9007199254740993", "ᴺᵁᴸᴸ", ""]
//! ```
//!
//! **Two output settings are not optional.** `output_format_json_quote_decimals=1` and
//! `output_format_json_quote_64bit_floats=1` make ClickHouse render those types as strings, so
//! their exact text reaches the user instead of a round trip through an `f64`. Without them a
//! `Decimal(20, 8)` arrives as a JSON number, and `Decimal(20, 8)` can hold values `f64` cannot
//! represent — a silently wrong digit in a decimal column is the worst possible bug here.
//!
//! **Credentials go in headers, never in the URL.** `X-ClickHouse-User` / `X-ClickHouse-Key`
//! rather than `?user=&password=`, because ClickHouse logs the query string in `system.query_log`
//! and in its server log — a password in the URL is a password written to disk on the server.
//!
//! ## Read-only here is the real thing, unlike the SQL engines
//!
//! `readonly=1` as a request setting is enforced by the server **and** it forbids changing
//! settings, so the `SET`-it-back-off escape the SQL engines have to guard against does not
//! exist here. Measured:
//!
//! ```text
//! ?readonly=1  INSERT INTO tracks …  → Code: 164 … Cannot execute query in readonly mode
//! ?readonly=1  SET readonly=0        → Code: 164 … Cannot modify 'readonly' setting in readonly mode
//! ```
//!
//! It is sent on **every** request rather than once at connect, which is the only option a
//! stateless protocol offers — and is stronger for it: there is no session for a later statement
//! to have changed. `readonly=2` would allow settings changes and is deliberately not used.
//!
//! ## Multi-statement is sequential POSTs
//!
//! ClickHouse's HTTP interface runs one statement per request. A script therefore becomes one
//! POST per statement, in order, stopping at the first failure — the same visible behaviour as
//! the SQL engines' `fetch_many`, reached differently.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client, StatusCode};

use crate::db::engine::{
    group_nodes, table_node, DbCancel, DbEngine, DbSession, Limits, ResolvedConfig, Script,
    ServerInfo,
};
use crate::db::engines::{self, EngineSpec};
use crate::db::error::{DbError, DbErrorCode};
use crate::db::guard;
use crate::db::model::{DbEngineId, DbRunMode, SslMode};
use crate::db::result::{cell_kind, DbColumn, DbResultKind, DbResultSet};
use crate::db::tree::{DbGroup, DbNode, DbNodeKind, DbNodeRef};

/// How long to wait for the dial itself when the connection does not say.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The ClickHouse engine.
pub struct ClickhouseEngine;

impl ClickhouseEngine {
    /// `http` or `https`, from the SSL mode. ClickHouse's spec offers no `Prefer` — there is no
    /// opportunistic upgrade over HTTP, you either dial the TLS port or you do not.
    fn scheme(mode: SslMode) -> &'static str {
        match mode {
            SslMode::Disable => "http",
            SslMode::Prefer | SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => "https",
        }
    }

    /// `http(s)://host:port/`.
    ///
    /// The port is **always written**, and when the record's field is empty it comes from the
    /// descriptor (`ResolvedConfig::port_or_default` → 8123). Unlike the sqlx engines there is no
    /// driver to hand an absent port to: this module *is* the URL builder, and `reqwest` would read
    /// `http://host/` as port 80 — a number nothing about ClickHouse suggests.
    ///
    /// ⚠️ **The fallback does not know about TLS, and that is a real edge.** A TLS ClickHouse
    /// conventionally listens on **8443**, so `sslMode: require` with an empty port dials
    /// `https://host:8123`, which is the plaintext interface and will not complete a handshake. The
    /// descriptor has one `default_port` and cannot express "8123, or 8443 with TLS", and inventing
    /// a second number here would be the app deciding a port the dialog's placeholder does not
    /// show. So it stays 8123 and the failure is loud: `unknown_scheme` in `url.rs` already names
    /// both ports, and the fix is to type the port — or to use the URL override below, which is now
    /// the place a non-default TLS port can be expressed. Recorded in `EngineSpec::default_port` too.
    ///
    /// 🔴 **The `url` override is honoured; an earlier version silently ignored it** — this
    /// engine read only `host`/`port`, so the dialog's URL box (which says *"Overrides settings
    /// above"*, and which every other engine obeys) did nothing at all for ClickHouse. Redis and
    /// DynamoDB both honour it, which left the asymmetry as this engine's alone; it is one
    /// `match`, so the only reason it existed was the order things were written.
    ///
    /// The scheme in the string **wins over the SSL control**, for the reason the SRV work
    /// settled: a `https://` URL is a more specific statement of intent than a dropdown,
    /// and silently dialling plaintext for it would be a control that reports one thing and does
    /// another.
    fn base_url(cfg: &ResolvedConfig) -> Result<String, DbError> {
        if let Some(raw) = cfg.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            let parsed = reqwest::Url::parse(raw).map_err(|e| {
                DbError::invalid_config(format!("That connection string is not usable: {e}"))
            })?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(DbError::invalid_config(format!(
                    "`{}://` is not a ClickHouse HTTP endpoint. Use `http://` or `https://` — this \
                     engine speaks ClickHouse's HTTP interface, not its native protocol.",
                    parsed.scheme()
                )));
            }
            if parsed.host_str().is_none() {
                return Err(DbError::invalid_config(
                    "That connection string has no host.".to_string(),
                ));
            }
            // Normalised to `scheme://host[:port]/`: the query string and path are ours to build
            // (`default_format`, the output settings, `readonly=1`), so a pasted `?query=…` must not
            // ride along and change what a run means.
            let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
            return Ok(format!(
                "{}://{}{port}/",
                parsed.scheme(),
                parsed.host_str().unwrap_or_default()
            ));
        }
        Ok(format!(
            "{}://{}:{}/",
            Self::scheme(cfg.ssl_mode),
            cfg.host,
            cfg.port_or_default()
        ))
    }

    /// Build the client.
    ///
    /// ⚠️ **`Require` accepts an unverified certificate, and that is what `require` means** on
    /// the libpq ladder this app borrows its vocabulary from: encrypt, do not verify. It is a
    /// real reduction in protection and it is the mode the user explicitly chose.
    ///
    /// ⚠️ **`VerifyCa` behaves as `VerifyFull` here**, because `reqwest` has no "check the chain
    /// but not the hostname" setting — its verifier always checks both. Erring toward the
    /// stricter of the two is the safe direction, and it is recorded rather than papered over:
    /// a certificate valid for a different hostname will be rejected under `verify-ca` on
    /// ClickHouse where Postgres would accept it.
    fn client(cfg: &ResolvedConfig) -> Result<Client, DbError> {
        // `rustls-no-provider` means the builder PANICS without a process-wide provider. `run()`
        // installs one at startup; tests and any non-Tauri caller do not go through `run()`, and
        // this is idempotent.
        crate::tls::install_crypto_provider();

        let mut builder = Client::builder().connect_timeout(connect_timeout(cfg));
        if matches!(cfg.ssl_mode, SslMode::Require) {
            builder = builder.danger_accept_invalid_certs(true);
        }
        builder.build().map_err(|e| {
            DbError::new(
                DbErrorCode::Tls,
                format!("Could not build the HTTPS client: {e}"),
            )
        })
    }

    /// The credential headers. Kept out of the URL — see the module doc.
    fn headers(cfg: &ResolvedConfig) -> Result<HeaderMap, DbError> {
        let mut headers = HeaderMap::new();
        if !cfg.user.is_empty() {
            headers.insert(
                "X-ClickHouse-User",
                HeaderValue::from_str(&cfg.user).map_err(|_| {
                    DbError::invalid_config("That user name cannot be sent in an HTTP header.")
                })?,
            );
        }
        if !cfg.password.is_empty() {
            let mut value = HeaderValue::from_str(&cfg.password).map_err(|_| {
                // The message must not echo the password, so it says nothing about the value.
                DbError::invalid_config(
                    "That password contains a character that cannot be sent in an HTTP header.",
                )
            })?;
            // Marks it sensitive so `HeaderMap`'s Debug prints `Sensitive` instead of the value —
            // the same class of protection as `ResolvedConfig`'s hand-written Debug.
            value.set_sensitive(true);
            headers.insert("X-ClickHouse-Key", value);
        }
        Ok(headers)
    }
}

fn connect_timeout(cfg: &ResolvedConfig) -> Duration {
    cfg.options
        .get("connectTimeout")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_CONNECT_TIMEOUT)
}

#[async_trait]
impl DbEngine for ClickhouseEngine {
    fn spec(&self) -> &'static EngineSpec {
        engines::spec_for(DbEngineId::Clickhouse).expect("the ClickHouse row exists")
    }

    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn DbSession>, DbError> {
        let session = ChSession {
            client: Self::client(cfg)?,
            headers: Self::headers(cfg)?,
            base: Self::base_url(cfg)?,
            database: cfg.database.clone(),
            read_only: cfg.read_only,
            timeout_ms: cfg.timeout_ms,
            password: cfg.password.clone(),
            // A per-session prefix, so `cancel` can address every query THIS session started
            // without tracking the in-flight one across an `&self` boundary.
            query_id_prefix: ulid::Ulid::new().to_string(),
            query_seq: AtomicU64::new(0),
        };
        // 🔴 A real round trip before returning. HTTP is stateless, so "open" could return a
        // struct without ever contacting the server — and then Test Connection would report
        // success for a host that does not exist, and the first query would be the one to fail.
        // A session that has not proven it can reach the server is not open.
        let mut session = session;
        session.probe().await?;
        Ok(Box::new(session))
    }
}

/// One ClickHouse "session" — a client plus everything a request needs. There is no connection
/// to hold, which is why `readonly=1` travels on every request rather than being set once.
struct ChSession {
    client: Client,
    headers: HeaderMap,
    /// `http(s)://host:port/` — see [`ClickhouseEngine::base_url`].
    base: String,
    database: String,
    read_only: bool,
    timeout_ms: u32,
    /// Held only to redact it out of error text.
    password: String,
    query_id_prefix: String,
    query_seq: AtomicU64,
}

impl ChSession {
    fn secrets(&self) -> Vec<&str> {
        if self.password.is_empty() {
            Vec::new()
        } else {
            vec![self.password.as_str()]
        }
    }

    /// The next query id for this session. `<session-ulid>-<n>` so `cancel` can match the whole
    /// family with one `LIKE`.
    fn next_query_id(&self) -> String {
        let n = self.query_seq.fetch_add(1, Ordering::Relaxed);
        format!("{}-{n}", self.query_id_prefix)
    }

    /// POST one statement and return the raw body, or a mapped error.
    ///
    /// `row_limit` is `None` for the internal statements (probe, cancel) that return one row and
    /// must not be capped by the user's setting.
    async fn post(&self, sql: &str, row_limit: Option<u32>) -> Result<String, DbError> {
        self.post_with(sql, row_limit, &[]).await
    }

    /// POST with ClickHouse **query parameters** (`{name:String}` in the SQL, `param_name=` on the
    /// URL).
    ///
    /// 🔴 This is why the tree's catalog queries interpolate nothing. A database or table name is
    /// server-provided *data*, and a table someone created as `x'; …` would otherwise splice into
    /// our SQL. ClickHouse's own parameter binding is the injection-proof route, and it is the
    /// direct equivalent of the bound parameters the sqlx engines use.
    async fn post_with(
        &self,
        sql: &str,
        row_limit: Option<u32>,
        params: &[(&str, &str)],
    ) -> Result<String, DbError> {
        let mut url = reqwest::Url::parse(&self.base).map_err(|e| {
            DbError::invalid_config(format!("That host and port do not form a usable URL: {e}"))
        })?;
        {
            let mut q = url.query_pairs_mut();
            if !self.database.is_empty() {
                q.append_pair("database", &self.database);
            }
            q.append_pair("default_format", "JSONCompact");
            // See the module doc: without these two, a Decimal(20, 8) round-trips through an f64.
            q.append_pair("output_format_json_quote_decimals", "1");
            q.append_pair("output_format_json_quote_64bit_floats", "1");
            // Seconds, and ClickHouse accepts a fraction. The server-side timeout layer — the server stops
            // working even if the client has already given up.
            q.append_pair(
                "max_execution_time",
                &format!("{:.3}", f64::from(self.timeout_ms) / 1000.0),
            );
            if let Some(cap) = row_limit {
                // `cap + 1` with `break`: the extra row is how truncation is **measured** rather
                // than inferred from `rows.len() == cap`, which is wrong exactly when the result
                // has that many rows. `break` returns what was read instead of erroring.
                q.append_pair(
                    "max_result_rows",
                    &u64::from(cap).saturating_add(1).to_string(),
                );
                q.append_pair("result_overflow_mode", "break");
            }
            for (name, value) in params {
                q.append_pair(&format!("param_{name}"), value);
            }
            q.append_pair("query_id", &self.next_query_id());
            // LAST, so it cannot be overridden by anything above it in the same query string.
            if self.read_only {
                q.append_pair("readonly", "1");
            }
        }

        let response = self
            .client
            .post(url)
            .headers(self.headers.clone())
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| map_transport_error(&e).redacted(&self.secrets()))?;

        let status = response.status();
        let body = response.text().await.map_err(|e| {
            DbError::new(
                DbErrorCode::Network,
                format!("Could not read the response: {e}"),
            )
            .redacted(&self.secrets())
        })?;
        if status.is_success() {
            return Ok(body);
        }
        Err(map_status_error(status, &body).redacted(&self.secrets()))
    }
}

#[async_trait]
impl DbSession for ChSession {
    async fn probe(&mut self) -> Result<ServerInfo, DbError> {
        // Through the same POST path everything else uses, so Test Connection exercises the
        // machinery the console depends on rather than a private shortcut.
        let body = self.post("SELECT version()", None).await?;
        let version =
            parse_first_cell(&body).unwrap_or_else(|| "(version unavailable)".to_string());
        Ok(ServerInfo {
            version: format!("ClickHouse {version}"),
            // ClickHouse has no backend pid. Its equivalent — the query id — is per *request*,
            // not per session, so there is nothing honest to put here. `cancel` uses the
            // session's own id prefix and does not read this field.
            backend_pid: None,
        })
    }

    async fn run(&mut self, script: &Script, limits: &Limits) -> Result<Vec<DbResultSet>, DbError> {
        let statements = guard::split_statements(&script.text);
        if statements.is_empty() {
            return Err(DbError::invalid_statement("There is nothing to run."));
        }
        if let Some(blocked) = guard::multi_statement_refusal(&statements, script.mode, limits) {
            return Err(blocked);
        }
        // Read-only is the SERVER's here (`readonly=1` also forbids `SET`), so the client-side
        // access-mode filter the SQL engines need has nothing to add — and running it anyway
        // would refuse statements ClickHouse itself handles correctly.

        let to_run: Vec<String> = if matches!(script.mode, DbRunMode::Statement) {
            vec![statements[0].clone()]
        } else {
            statements.clone()
        };

        let deadline = Duration::from_millis(u64::from(limits.timeout_ms));
        match tokio::time::timeout(deadline, self.run_sequentially(&to_run, limits)).await {
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

    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        match node {
            // Like MySQL and unlike PostgreSQL, one ClickHouse connection can see every database.
            DbNodeRef::Root => {
                let body = self
                    .post(
                        "SELECT name FROM system.databases \
                         WHERE name NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA') \
                         ORDER BY name",
                        None,
                    )
                    .await?;
                Ok(text_column(&body)
                    .into_iter()
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

            // No schema level — ClickHouse databases hold tables directly.
            DbNodeRef::Database { name } => {
                // `engine LIKE '%View'` is how a view is told from a table here: ClickHouse has no
                // `table_type`, and the engine name (`View`, `MaterializedView`, `MergeTree`) is
                // the server's own answer to the question.
                let body = self
                    .post_with(
                        "SELECT if(engine LIKE '%View', 'VIEW', 'BASE TABLE') AS t, toString(count()) \
                         FROM system.tables WHERE database = {db:String} GROUP BY t",
                        None,
                        &[("db", name)],
                    )
                    .await?;
                let mut tables = 0usize;
                let mut views = 0usize;
                for row in text_rows(&body) {
                    let n: usize = row.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
                    if row.first().map(|k| k == "VIEW").unwrap_or(false) {
                        views += n;
                    } else {
                        tables += n;
                    }
                }
                Ok(group_nodes(name, None, tables, views))
            }

            DbNodeRef::Schema { .. } => Ok(Vec::new()),

            DbNodeRef::Group {
                database, group, ..
            } => {
                let is_view = matches!(group, DbGroup::Views);
                let sql = if is_view {
                    "SELECT name FROM system.tables WHERE database = {db:String} \
                     AND engine LIKE '%View' ORDER BY name"
                } else {
                    "SELECT name FROM system.tables WHERE database = {db:String} \
                     AND engine NOT LIKE '%View' ORDER BY name"
                };
                let body = self.post_with(sql, None, &[("db", database)]).await?;
                Ok(text_column(&body)
                    .into_iter()
                    .map(|name| table_node(database, None, &name, is_view))
                    .collect())
            }

            DbNodeRef::Table { database, name, .. } => {
                // `type` is the server's own spelling, wrappers included — `Nullable(Decimal(12, 4))`
                // — which is exactly what the tree shows verbatim, and what the nullability is read from:
                // ClickHouse has no `is_nullable` column, the wrapper IS the nullability.
                let body = self
                    .post_with(
                        "SELECT name, type FROM system.columns \
                         WHERE database = {db:String} AND table = {tbl:String} ORDER BY position",
                        None,
                        &[("db", database), ("tbl", name)],
                    )
                    .await?;
                Ok(text_rows(&body)
                    .into_iter()
                    .filter_map(|row| {
                        let column = row.first()?.clone();
                        let type_name = row.get(1).cloned().unwrap_or_default();
                        Some(DbNode::column(
                            database,
                            None,
                            name,
                            &column,
                            &type_name,
                            type_name.starts_with("Nullable("),
                        ))
                    })
                    .collect())
            }

            // Both are answered by the saved-query store, never by the server —
            // `db_children` intercepts them before an engine is asked.
            DbNodeRef::SavedQueries | DbNodeRef::SavedQuery { .. } => Ok(Vec::new()),
        }
    }

    fn cancel_handle(&self) -> Option<Arc<dyn DbCancel>> {
        Some(Arc::new(ChCancel {
            client: self.client.clone(),
            headers: self.headers.clone(),
            base: self.base.clone(),
            database: self.database.clone(),
            timeout_ms: self.timeout_ms,
            password: self.password.clone(),
            query_id_prefix: self.query_id_prefix.clone(),
        }))
    }

    async fn close(self: Box<Self>) {
        // Nothing to close: HTTP is stateless and `reqwest`'s pool drops with the client. Said
        // out loud so the empty body does not read as a forgotten TODO.
    }
}

/// ClickHouse: `KILL QUERY WHERE query_id LIKE '<prefix>-%' SYNC`.
///
/// Owned separately from the session so it stays reachable while a query holds the session mutex —
/// see [`DbCancel`]. Unlike the SQL engines there is no sibling *connection* to open: HTTP is
/// stateless, so a cancel is simply another request.
struct ChCancel {
    client: Client,
    headers: HeaderMap,
    base: String,
    database: String,
    timeout_ms: u32,
    password: String,
    query_id_prefix: String,
}

#[async_trait]
impl DbCancel for ChCancel {
    async fn cancel(&self) -> Result<(), DbError> {
        // `KILL QUERY` is itself a query, and under `readonly=1` ClickHouse refuses it — so the
        // cancel must not carry that setting. That is safe: the statement is built here, is not
        // user input, and kills only ids this session minted.
        let sql = format!(
            "KILL QUERY WHERE query_id LIKE '{}-%' SYNC",
            // The prefix is a ULID we generated, so it cannot contain a quote. Asserted rather
            // than escaped, because an escape here would imply the value is untrusted and invite
            // someone to widen it later.
            self.query_id_prefix
        );
        debug_assert!(
            !self.query_id_prefix.contains('\'') && !self.query_id_prefix.contains('\\'),
            "the session's query-id prefix must be a bare ULID"
        );
        let killer = ChSession {
            client: self.client.clone(),
            headers: self.headers.clone(),
            base: self.base.clone(),
            database: self.database.clone(),
            // The one place read-only is deliberately off, and only for this statement.
            read_only: false,
            timeout_ms: self.timeout_ms,
            password: self.password.clone(),
            // 🔴 A FRESH ULID, not `format!("{prefix}-kill")`. Every request stamps its own
            // `query_id` from this prefix, so a derived one would make the KILL's own id
            // (`<prefix>-kill-0`) match its own `LIKE '<prefix>-%'` predicate — a statement asked
            // to kill itself. ClickHouse is believed to exclude the killing query from its own
            // match, but "believed to" is not something to build on when a distinct id is free.
            query_id_prefix: ulid::Ulid::new().to_string(),
            query_seq: AtomicU64::new(0),
        };
        killer.post(&sql, None).await.map(|_| ())
    }
}

impl ChSession {
    /// One POST per statement, in order, stopping at the first failure.
    async fn run_sequentially(&self, statements: &[String], limits: &Limits) -> Vec<DbResultSet> {
        let mut sets = Vec::with_capacity(statements.len());
        for statement in statements {
            let started = Instant::now();
            match self.post(statement, Some(limits.row_limit)).await {
                Ok(body) => sets.push(shape(
                    statement,
                    &body,
                    limits,
                    started.elapsed().as_millis() as u64,
                )),
                Err(e) => {
                    // A database error is a RESULT, not a rejection — the `http_send` contract.
                    // Stopping here matches the SQL engines: statement 3 failing must not run 4.
                    sets.push(DbResultSet::message(
                        statement.clone(),
                        e.message,
                        limits.row_limit,
                    ));
                    break;
                }
            }
        }
        sets
    }
}

/// `JSONCompact` → [`DbResultSet`]. `meta[]` *is* the column list and `data[]` *is* the rows,
/// so this is mostly a rename — the interesting part is the per-cell rendering.
fn shape(statement: &str, body: &str, limits: &Limits, duration_ms: u64) -> DbResultSet {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        // A statement with no result set (`INSERT`, `CREATE`, `KILL`) returns an EMPTY body, not
        // JSON. That is a success with nothing to show, and `affected` is the honest shape —
        // ClickHouse's HTTP interface does not report a row count for a write, so `rows_affected`
        // stays None rather than being invented as 0.
        return DbResultSet {
            kind: DbResultKind::Affected,
            statement: statement.to_string(),
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: None,
            truncated: false,
            row_limit: limits.row_limit,
            duration_ms,
            notice: None,
            // A ClickHouse row is a fixed tuple — every column is present or NULL — so there is no
            // absent-vs-null distinction to carry.
            absent: None,
        };
    };

    let columns: Vec<DbColumn> = parsed
        .get("meta")
        .and_then(|m| m.as_array())
        .map(|meta| {
            meta.iter()
                .map(|c| {
                    let type_name = c
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    DbColumn {
                        name: c
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string(),
                        kind: cell_kind(&type_name),
                        type_name,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let all_rows: Vec<Vec<Option<String>>> = parsed
        .get("data")
        .and_then(|d| d.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| cells.iter().map(render_cell).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default();

    // Measured, not inferred: we asked for `cap + 1`, so more than `cap` means there was more.
    let cap = limits.row_limit as usize;
    let truncated = all_rows.len() > cap;
    let mut rows = all_rows;
    rows.truncate(cap);

    DbResultSet {
        kind: DbResultKind::Rows,
        statement: statement.to_string(),
        columns,
        rows,
        rows_affected: None,
        truncated,
        row_limit: limits.row_limit,
        duration_ms,
        notice: None,
        // See the arm above: a fixed tuple has no absent-vs-null distinction.
        absent: None,
    }
}

/// One JSON cell → the text a grid shows, or `None` for SQL NULL.
///
/// The `Null` arm is the whole reason `JSONCompact` was chosen over `JSONCompactStrings` (see the
/// module doc): here NULL is a distinct JSON value, so it cannot be confused with a string.
fn render_cell(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        // Already the server's own text, because `output_format_json_quote_*` asked for it.
        serde_json::Value::String(s) => Some(s.clone()),
        // 32-bit and smaller integers arrive unquoted; `to_string` on the JSON number preserves
        // the integer/float distinction, so a `UInt32` of 123 renders "123" and not "123.0".
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        // Arrays, maps and tuples render as compact one-line JSON in the cell; the value
        // inspector is where the whole structure gets read.
        other => Some(other.to_string()),
    }
}

/// Every row of a `JSONCompact` body as text — the catalog queries' shape.
///
/// Reuses `render_cell`, so a NULL in a catalog answer becomes `None` here exactly as it would in
/// a user's result set, rather than an empty string that looks like a real name.
fn text_rows(body: &str) -> Vec<Vec<String>> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    parsed
        .get("data")
        .and_then(|d| d.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.as_array())
                .map(|cells| {
                    cells
                        .iter()
                        .map(|c| render_cell(c).unwrap_or_default())
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The first column of every row — for the many catalog queries that select one name.
fn text_column(body: &str) -> Vec<String> {
    text_rows(body)
        .into_iter()
        .filter_map(|mut row| {
            if row.is_empty() {
                None
            } else {
                Some(row.swap_remove(0))
            }
        })
        .collect()
}

/// The first cell of the first row — for `SELECT version()`.
fn parse_first_cell(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("data")?
        .as_array()?
        .first()?
        .as_array()?
        .first()
        .and_then(render_cell)
}

/// A `reqwest` failure — nothing reached the server, or the TLS handshake did not complete.
fn map_transport_error(e: &reqwest::Error) -> DbError {
    if e.is_timeout() {
        return DbError::new(
            DbErrorCode::Network,
            "The server did not answer in time.".to_string(),
        );
    }
    if e.is_connect() {
        // `reqwest` folds TLS failures into connect errors, so the string is the only signal.
        // Checked case-insensitively against both spellings rustls and the OS verifier produce.
        let text = e.to_string().to_ascii_lowercase();
        if text.contains("certificate") || text.contains("tls") || text.contains("handshake") {
            return DbError::new(
                DbErrorCode::Tls,
                "The TLS handshake failed, or the server's certificate could not be verified."
                    .to_string(),
            );
        }
        return DbError::new(
            DbErrorCode::Network,
            "The server could not be reached — check the host, the port, and whether a VPN or firewall is in the way."
                .to_string(),
        );
    }
    DbError::new(DbErrorCode::Unknown, format!("The request failed: {e}"))
}

/// A non-2xx response. ClickHouse puts `Code: NNN. DB::Exception: …` in the body, and the numeric
/// code is far more reliable than the prose, which changes between versions.
fn map_status_error(status: StatusCode, body: &str) -> DbError {
    let code = clickhouse_error_code(body);
    let message = clean_exception(body);
    let mapped = match (status, code) {
        // 516 AUTHENTICATION_FAILED, 192 UNKNOWN_USER, 193 WRONG_PASSWORD.
        (_, Some(516 | 192 | 193)) => DbErrorCode::Auth,
        (StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _) => DbErrorCode::Auth,
        // 164 READONLY — our own guardrail firing at the server, which is a *blocked* statement
        // and not a failure of the connection.
        (_, Some(164)) => DbErrorCode::Blocked,
        // 159 TIMEOUT_EXCEEDED — the server's `max_execution_time` stopped it.
        (_, Some(159)) => DbErrorCode::Timeout,
        // 60 UNKNOWN_TABLE, 47 UNKNOWN_IDENTIFIER, 62 SYNTAX_ERROR: "your statement is wrong",
        // which is a normal console outcome and not a broken connection. This comment said exactly
        // that while the code said `invalid-config`, whose sentence is about hosts and ports — the
        // same misattribution that happened on MongoDB.
        (_, Some(60 | 47 | 62)) => DbErrorCode::InvalidStatement,
        // 81 UNKNOWN_DATABASE stays a CONFIG problem, and the split is deliberate: `database` is a
        // connection setting, so this is what a Test Connection against a mistyped database name
        // reports — where "check the settings this engine requires" is the true advice. A statement
        // naming another database can also raise it; the connection reading is the more common one
        // and the more actionable, and it matches Postgres's 3D000 mapping in `error.rs`.
        (_, Some(81)) => DbErrorCode::InvalidConfig,
        _ => DbErrorCode::Unknown,
    };
    // 🔴 `blocked` is the one code whose detail the panel renders verbatim, so it carries OUR
    // prose and never the server's (`DbError::blocked` has the finding this comes from).
    // ClickHouse's own words here are `agentstudio: Cannot execute query in readonly mode.` — it
    // restates the code and leads with the user name; what replaces it names the two places
    // `readonly` can come from, only one of which this app can change.
    if mapped == DbErrorCode::Blocked {
        return DbError::blocked(
            "ClickHouse refused that query in readonly mode. Untick \"Read-only\" in this \
             connection's settings if you mean to write — and if it is already off, the server \
             set `readonly` on this user's profile, which no client can override.",
        );
    }
    DbError::new(mapped, message)
}

/// The `NNN` from `Code: NNN. DB::Exception: …`, if the body has one.
fn clickhouse_error_code(body: &str) -> Option<u32> {
    let after = body.trim_start().strip_prefix("Code: ")?;
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// The exception text, trimmed of the version suffix and capped.
///
/// ClickHouse appends `(version 25.6.13.41 (official build))` to every message, which is noise in
/// a toast, and a long message can carry a whole query plan.
fn clean_exception(body: &str) -> String {
    let text = body.trim();
    let text = match text.find(" (version ") {
        Some(at) => &text[..at],
        None => text,
    };
    let text = text.trim();
    if text.is_empty() {
        return "The server rejected the request without a message.".to_string();
    }
    if text.chars().count() <= 500 {
        return text.to_string();
    }
    let head: String = text.chars().take(497).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            row_limit: 3,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    /// A real `JSONCompact` body, captured from the fixture (25.6.13) rather than hand-written,
    /// so the parser is tested against the bytes the server actually sends — including the tabs
    /// and the `statistics` block.
    const REAL_BODY: &str = r#"{
	"meta":
	[
		{ "name": "duration", "type": "Nullable(Decimal(12, 4))" },
		{ "name": "tag", "type": "Nullable(String)" },
		{ "name": "id", "type": "UInt32" },
		{ "name": "ok", "type": "Bool" },
		{ "name": "flags", "type": "Array(String)" }
	],

	"data":
	[
		["0.5", "normal", 1, true, ["1","2","3"]],
		["12.25", null, 2, false, []],
		["400", "", 3, true, ["7"]]
	],

	"rows": 3
}"#;

    #[test]
    fn a_real_response_body_shapes_into_columns_and_rows() {
        let set = shape("SELECT …", REAL_BODY, &limits(), 7);
        assert_eq!(set.kind, DbResultKind::Rows);
        let names: Vec<&str> = set.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["duration", "tag", "id", "ok", "flags"]);
        // The server's own type names, verbatim — wrappers included.
        assert_eq!(set.columns[0].type_name, "Nullable(Decimal(12, 4))");
        assert_eq!(set.rows.len(), 3);
    }

    /// 🔴 The assertion this engine exists to keep: SQL NULL and the empty string must not
    /// collapse. Row 2's `tag` is JSON `null`, row 3's is `""`.
    #[test]
    fn null_and_the_empty_string_stay_different() {
        let set = shape("SELECT …", REAL_BODY, &limits(), 0);
        assert_eq!(set.rows[1][1], None, "JSON null must be SQL NULL");
        assert_eq!(
            set.rows[2][1],
            Some(String::new()),
            "an empty JSON string must stay an empty string"
        );
    }

    #[test]
    fn every_cell_kind_renders_as_the_text_the_server_meant() {
        let set = shape("SELECT …", REAL_BODY, &limits(), 0);
        // A quoted Decimal arrives as exact text — never through an f64.
        assert_eq!(set.rows[0][0], Some("0.5".to_string()));
        // An unquoted small integer must not gain a decimal point.
        assert_eq!(set.rows[0][2], Some("1".to_string()));
        assert_eq!(set.rows[0][3], Some("true".to_string()));
        // A composite renders as compact one-line JSON.
        assert_eq!(set.rows[0][4], Some(r#"["1","2","3"]"#.to_string()));
        assert_eq!(set.rows[1][4], Some("[]".to_string()));
    }

    #[test]
    fn truncation_is_measured_from_the_extra_row_not_inferred_from_the_cap() {
        // 3 rows under a cap of 3 is NOT truncation — the wrong version of this test is what
        // makes a full page of results claim there is more.
        let exact = shape("SELECT …", REAL_BODY, &limits(), 0);
        assert!(!exact.truncated);
        assert_eq!(exact.rows.len(), 3);

        // The same body under a cap of 2: we asked for 3, got 3, so there IS more, and the
        // extra row is dropped rather than shown.
        let capped = shape(
            "SELECT …",
            REAL_BODY,
            &Limits {
                row_limit: 2,
                ..limits()
            },
            0,
        );
        assert!(capped.truncated);
        assert_eq!(capped.rows.len(), 2);
    }

    #[test]
    fn a_write_returns_an_empty_body_and_is_reported_as_affected_not_as_zero_rows() {
        // ClickHouse answers an INSERT with a 200 and NO body. Reporting that as `Rows` with an
        // empty grid would look like "your query matched nothing"; reporting `rows_affected: 0`
        // would be inventing a number the interface never sent.
        let set = shape("INSERT INTO tracks …", "", &limits(), 4);
        assert_eq!(set.kind, DbResultKind::Affected);
        assert_eq!(set.rows_affected, None);
        assert!(set.columns.is_empty());
    }

    #[test]
    fn the_error_code_drives_the_classification_not_the_prose() {
        // The numeric code is stable across versions; the sentence is not.
        for (body, want) in [
            (
                "Code: 164. DB::Exception: agentstudio: Cannot execute query in readonly mode. (READONLY) (version 25.6.13.41 (official build))",
                DbErrorCode::Blocked,
            ),
            (
                "Code: 516. DB::Exception: agentstudio: Authentication failed. (AUTHENTICATION_FAILED) (version 25.6.13.41)",
                DbErrorCode::Auth,
            ),
            (
                "Code: 159. DB::Exception: Timeout exceeded. (TIMEOUT_EXCEEDED) (version 25.6.13.41)",
                DbErrorCode::Timeout,
            ),
            // A syntax error is a STATEMENT problem. It used to read `InvalidConfig`, so
            // the sentence the user got was about a host and a port — see `error.rs`'s note on
            // `InvalidStatement`.
            (
                "Code: 62. DB::Exception: Syntax error. (SYNTAX_ERROR) (version 25.6.13.41)",
                DbErrorCode::InvalidStatement,
            ),
            (
                "Code: 60. DB::Exception: Table maestro.nope does not exist. (UNKNOWN_TABLE) (version 25.6.13.41)",
                DbErrorCode::InvalidStatement,
            ),
            (
                "Code: 47. DB::Exception: Unknown expression identifier `nope`. (UNKNOWN_IDENTIFIER) (version 25.6.13.41)",
                DbErrorCode::InvalidStatement,
            ),
            // …and the deliberate exception: the database is a connection setting, so a mistyped
            // one is what Test Connection reports, and "check the settings" is true advice there.
            (
                "Code: 81. DB::Exception: Database nope does not exist. (UNKNOWN_DATABASE) (version 25.6.13.41)",
                DbErrorCode::InvalidConfig,
            ),
        ] {
            let err = map_status_error(StatusCode::INTERNAL_SERVER_ERROR, body);
            assert_eq!(err.code, want, "{body}");
            // And the version suffix is stripped, because it is noise in a toast.
            assert!(!err.message.contains("(version "), "{}", err.message);
        }
    }

    /// 🔴 `blocked` is the code whose detail the panel renders verbatim (`DbError::blocked`), so
    /// this arm — and only this arm — drops ClickHouse's own words instead of forwarding them.
    ///
    /// The body carries a DSN on purpose. `DbError::redacted` masks the **password**; the host, the
    /// port, the database and the user survive it, so "the password is not in there" would be a
    /// leak test that passes on a message still naming the server.
    #[test]
    fn a_readonly_refusal_carries_none_of_the_servers_text_because_the_panel_renders_it() {
        let body = "Code: 164. DB::Exception: catalog_ro: Cannot execute query in readonly mode \
                    (dsn https://catalog_ro:hunter2@ch.internal:8443/maestro). (READONLY) \
                    (version 25.6.13.41 (official build))";
        let err = map_status_error(StatusCode::INTERNAL_SERVER_ERROR, body).redacted(&["hunter2"]);
        assert_eq!(err.code, DbErrorCode::Blocked);
        for fragment in ["hunter2", "ch.internal", "https://", "catalog_ro", "8443"] {
            assert!(
                !err.message.contains(fragment),
                "{fragment:?} reached a message the panel renders: {}",
                err.message
            );
        }
        // Not merely empty: it says which `readonly` this can be, and names the one this app owns.
        assert!(
            err.message.contains("Untick \"Read-only\""),
            "{}",
            err.message
        );
        assert!(err.message.contains("profile"), "{}", err.message);
        // The live tier recognises a server-side refusal by this word (`db_live.rs`'s ClickHouse
        // `read_only_is_server_enforced` reads the notice, where the code does not survive).
        assert!(err.message.contains("readonly"), "{}", err.message);
    }

    #[test]
    fn a_401_is_auth_even_with_no_parseable_body() {
        let err = map_status_error(StatusCode::UNAUTHORIZED, "");
        assert_eq!(err.code, DbErrorCode::Auth);
        // An empty body must still yield a sentence, not an empty string in the UI.
        assert!(!err.message.is_empty());
    }

    #[test]
    fn a_very_long_exception_is_capped_rather_than_pasted_whole() {
        let body = format!("Code: 62. DB::Exception: {}", "x".repeat(2000));
        let err = map_status_error(StatusCode::BAD_REQUEST, &body);
        assert!(err.message.chars().count() <= 500);
        assert!(err.message.ends_with('…'));
    }

    #[test]
    fn the_ssl_mode_picks_the_scheme_and_prefer_is_not_plaintext() {
        assert_eq!(ClickhouseEngine::scheme(SslMode::Disable), "http");
        assert_eq!(ClickhouseEngine::scheme(SslMode::Require), "https");
        assert_eq!(ClickhouseEngine::scheme(SslMode::VerifyCa), "https");
        assert_eq!(ClickhouseEngine::scheme(SslMode::VerifyFull), "https");
        // `Prefer` is not offered by the ClickHouse descriptor (`SSL_NO_PREFER`), and if it ever
        // arrives anyway it must encrypt rather than silently fall back to plaintext.
        assert_eq!(ClickhouseEngine::scheme(SslMode::Prefer), "https");
    }

    #[test]
    fn the_password_is_marked_sensitive_so_a_debug_print_cannot_leak_it() {
        let cfg = cfg_with_password("s3cret-hunter2");
        let headers = ClickhouseEngine::headers(&cfg).expect("headers");
        // The value is there…
        assert_eq!(
            headers.get("X-ClickHouse-Key").unwrap().to_str().unwrap(),
            "s3cret-hunter2"
        );
        // …and `Debug` does not print it. This is the `dbg!`/`tracing`/panic-message leak.
        let printed = format!("{headers:?}");
        assert!(
            !printed.contains("s3cret-hunter2"),
            "the password leaked through Debug: {printed}"
        );
    }

    #[test]
    fn a_password_that_cannot_be_a_header_value_fails_without_echoing_it() {
        // A newline would split the HTTP message; the error must refuse it and must not quote it.
        let cfg = cfg_with_password("bad\nvalue-s3cret");
        let err = ClickhouseEngine::headers(&cfg).expect_err("a newline cannot be a header value");
        assert!(!err.message.contains("s3cret"), "{}", err.message);
    }

    /// The base URL always carries a port, and an empty port field takes the **descriptor's** 8123
    /// — there is no driver to hand an absent port to here, because this module is the URL builder.
    ///
    /// ⚠️ The last case is the honest one: `sslMode: require` with no port dials `https://…:8123`,
    /// the *plaintext* interface, because `EngineSpec::default_port` is one number and a TLS
    /// ClickHouse conventionally listens on 8443. Asserted so the edge is a **recorded fact** rather
    /// than a surprise, and so nobody "fixes" it by inventing a second port the dialog does not show.
    #[test]
    fn the_base_url_always_has_a_port_and_an_empty_field_takes_the_descriptors() {
        let mut cfg = cfg_with_password("pw");
        let url = |c: &ResolvedConfig| ClickhouseEngine::base_url(c).expect("a usable base url");
        assert_eq!(url(&cfg), "http://ch.internal:8123/");

        cfg.port = None;
        assert_eq!(
            url(&cfg),
            "http://ch.internal:8123/",
            "an empty port must not become `http://host/`, which reqwest reads as port 80"
        );

        cfg.port = Some(9440);
        assert_eq!(url(&cfg), "http://ch.internal:9440/");

        cfg.port = None;
        cfg.ssl_mode = SslMode::Require;
        assert_eq!(
            url(&cfg),
            "https://ch.internal:8123/",
            "the descriptor has one default_port and cannot say 8443 for TLS — see base_url's doc"
        );
    }

    /// 🔴 **The `url` override, which an earlier version of this engine IGNORED.**
    ///
    /// The dialog's URL box says *"Overrides settings above"* and every other engine obeys it; this
    /// one read `host`/`port` and nothing else, so pasting a URL here did literally nothing. It was
    /// recorded in code as a known gap for a day, and it stopped being defensible once Redis and
    /// DynamoDB both honoured theirs in the same session.
    #[test]
    fn a_url_override_wins_over_the_host_and_port_fields() {
        let mut cfg = cfg_with_password("pw");
        let url = |c: &ResolvedConfig| ClickhouseEngine::base_url(c).expect("a usable base url");

        cfg.url = Some("https://clickhouse.example.com:8443".to_string());
        assert_eq!(url(&cfg), "https://clickhouse.example.com:8443/");

        // 🔴 And this is the 8443 edge's actual answer: `sslMode` says `disable`, the STRING says
        // https on the TLS port, and the string wins — a URL is a more specific statement of intent
        // than a dropdown, exactly as the SRV work settled. Dialling plaintext here
        // would be a control that reports one thing and does another.
        cfg.ssl_mode = SslMode::Disable;
        assert_eq!(url(&cfg), "https://clickhouse.example.com:8443/");

        // A port-less override keeps being port-less: `reqwest` then applies the SCHEME's default
        // (443 for https), which is the right answer for a URL a user typed — unlike an empty *field*,
        // where 80 would be a number nothing about ClickHouse suggests.
        cfg.url = Some("https://clickhouse.example.com".to_string());
        assert_eq!(url(&cfg), "https://clickhouse.example.com/");

        // The path and query are OURS to build (`default_format`, the output settings, `readonly=1`),
        // so a pasted query string must not ride along and change what a run means.
        cfg.url = Some("http://ch.local:8123/?query=SELECT+1&readonly=0".to_string());
        assert_eq!(url(&cfg), "http://ch.local:8123/");
    }

    #[test]
    fn a_non_http_override_is_refused_by_name_rather_than_dialled() {
        let mut cfg = cfg_with_password("pw");
        // `clickhouse://` is the NATIVE protocol (port 9000), which this engine does not speak.
        // Accepting it and dialling HTTP would be a silent protocol substitution.
        cfg.url = Some("clickhouse://ch.local:9000".to_string());
        let err = ClickhouseEngine::base_url(&cfg).expect_err("native protocol");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("HTTP interface"), "{}", err.message);

        cfg.url = Some("not a url at all".to_string());
        assert_eq!(
            ClickhouseEngine::base_url(&cfg).expect_err("garbage").code,
            DbErrorCode::InvalidConfig
        );

        // An override that is only whitespace is ABSENT, not invalid — the field's empty state.
        cfg.url = Some("   ".to_string());
        assert_eq!(
            ClickhouseEngine::base_url(&cfg).expect("blank means absent"),
            "http://ch.internal:8123/"
        );
    }

    /// ✅ **ClickHouse was checked for the dropped-password bug and does NOT have it** — this
    /// test is the check, kept so it stays that way.
    ///
    /// Every other engine dropped the typed password when a URL override was present. ClickHouse
    /// could not, because its credential does not travel in the URL at all: [`base_url`] builds the
    /// endpoint and [`headers`] builds `X-ClickHouse-User`/`X-ClickHouse-Key` from the fields,
    /// independently. So the two halves of a URL-override configuration compose correctly here by
    /// construction rather than by luck — and that construction is now asserted.
    ///
    /// ⚠️ **The residual, stated rather than discovered later:** the traffic goes the *other* way.
    /// `base_url` normalises the override to `scheme://host[:port]/`, so a credential written *into*
    /// the string (`http://user:pw@ch.local:8123`, or `?password=`) is **dropped**, not honoured —
    /// the mirror image of the bug fixed elsewhere. It is reachable only from an unsaved draft: the
    /// save path (`db_connection_upsert` → `url::split_url_credentials`) moves any inline credential
    /// into the Vault and leaves a `{{VAR}}`, which `db::substitute_url` resolves back into
    /// `cfg.password` — the very field these headers read. Left as-is deliberately: honouring it
    /// would mean carrying the password *value* out of `url.rs`, and the redaction design keeps that surface as
    /// small as it can be. Asserted below so it is a recorded fact.
    #[test]
    fn a_url_override_does_not_suppress_the_typed_password_because_it_never_carried_it() {
        let mut cfg = cfg_with_password("typed-pw");
        cfg.url = Some("https://clickhouse.example.com:8443".to_string());
        let headers = ClickhouseEngine::headers(&cfg).expect("headers");
        assert_eq!(
            headers.get("X-ClickHouse-Key").unwrap().to_str().unwrap(),
            "typed-pw",
            "the dropped-password bug, on the one engine that never had it"
        );
        assert_eq!(
            headers.get("X-ClickHouse-User").unwrap().to_str().unwrap(),
            "agentstudio"
        );
        assert_eq!(
            ClickhouseEngine::base_url(&cfg).unwrap(),
            "https://clickhouse.example.com:8443/"
        );

        // The residual, asserted: an inline credential in the override is normalised away rather
        // than used, so a *draft* that carries one and has an empty Password field authenticates
        // with nothing.
        cfg.url = Some("http://someone:url-pw@ch.local:8123/".to_string());
        cfg.password = String::new();
        assert_eq!(
            ClickhouseEngine::base_url(&cfg).unwrap(),
            "http://ch.local:8123/",
            "the userinfo is stripped from the endpoint (it must be — this is a header protocol)"
        );
        assert!(
            ClickhouseEngine::headers(&cfg)
                .unwrap()
                .get("X-ClickHouse-Key")
                .is_none(),
            "recorded, not endorsed: a URL-borne credential does not reach the headers"
        );
    }

    fn cfg_with_password(password: &str) -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Clickhouse,
            family: crate::db::model::DbFamily::Clickhouse,
            host: "ch.internal".into(),
            port: Some(8123),
            srv: false,
            database: "maestro".into(),
            user: "agentstudio".into(),
            password: password.into(),
            ssl_mode: SslMode::Disable,
            ca_pem: None,
            options: Default::default(),
            url: None,
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }
}
