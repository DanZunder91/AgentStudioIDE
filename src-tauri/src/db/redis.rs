//! Redis and Valkey — the seventh and eighth engine rows.
//!
//! ## What makes this engine different from the other six
//!
//! Everything else here speaks a query language over a connection that holds state. Redis speaks
//! **one command line at a time**, has no schema, no rows and no columns, and its reply is a
//! [`Value`] tree rather than a result set. So this module is mostly two translations:
//!
//! * **text → command** ([`tokenize`]): shell-style quoting, because `SET greeting "hello world"`
//!   is what a person types and `redis-cli` accepts. The prior art is
//!   `src/features/api/curlParse.ts`, which is TypeScript — its *rules* are reused, not its code.
//! * **reply → [`DbResultSet`]** ([`shape`]): a scalar becomes a one-cell grid, an array becomes
//!   one row per element, and a status reply (`OK`) becomes a `message` result because it is an
//!   acknowledgement rather than data. The lossy case — a nested array, which `XRANGE` returns —
//!   is rendered as compact text **and named in the result's notice**, never collapsed silently.
//!
//! ## RESP2, deliberately
//!
//! `redis-rs` can negotiate RESP3 (`HELLO 3`), which would return `HGETALL` as a real map and let
//! this file build a two-column field/value grid for free. It is not used, for one reason: RESP3
//! needs Redis ≥ 6, and a `HELLO 3` against an older server (or one of the several forks and
//! managed proxies that answer Redis's protocol) fails the *connection*, not the command. Trading
//! "connects everywhere" for "nicer tables on one command family" is the wrong way round for an
//! engine whose users include ElastiCache and every embedded fork. The consequence is honest and
//! visible: a `HGETALL` renders as the flat field, value, field, value list the server sends.
//!
//! ## Read-only here is OURS, and the badge says so
//!
//! There is no session read-only mode to ask the server for, so read-only is a default-deny
//! **allowlist of command names**, exactly like MongoDB's. Two rules beyond the allowlist,
//! both about the same failure:
//!
//! * **`KEYS` is refused in BOTH modes.** On a production Redis it is O(N) and blocks the
//!   single-threaded server for the whole scan — a read-only command that takes the database down.
//!   The tree browses with cursored `SCAN` for the same reason.
//! * **A short list is refused in EVERY mode** (`FLUSHALL`, `SHUTDOWN`, `DEBUG`, `EVAL`, …). There
//!   is no console-shaped reason to run them and a very short path from running one to a bad
//!   afternoon.
//!
//! ## The catalog is not the console
//!
//! [`RedisSession::children`] runs `SCAN`, `TYPE` and `INFO` itself, and those are not filtered by
//! the allowlist above — the same split MongoDB's tree already makes. The allowlist governs what
//! the *user's text* may do; the tree is our own code asking a bounded question.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use redis::{Client, ConnectionAddr, ConnectionInfo, ProtocolVersion, RedisConnectionInfo, Value};

use crate::db::engine::{DbEngine, DbSession, Limits, ResolvedConfig, Script, ServerInfo};
use crate::db::engines::{self, EngineSpec};
use crate::db::error::{DbError, DbErrorCode};
use crate::db::guard;
use crate::db::model::{DbEngineId, SslMode};
use crate::db::result::{DbCellKind, DbColumn, DbResultKind, DbResultSet};
use crate::db::tree::{DbGroup, DbNode, DbNodeKind, DbNodeRef};

/// How many keys one expand of the **Keys** group lists.
///
/// A bound rather than "all of them": a real Redis holds millions of keys, the tree is a rail and
/// the reply has to cross the IPC boundary. The group's sub-label says how many are shown so the
/// number is never mistaken for the database's size — the row-cap discipline applied to the tree.
const KEY_PAGE: usize = 500;

/// `SCAN COUNT` per round trip. Redis's own default is 10, which would need 50 round trips to fill
/// one page; 500 fills it in one on a small database and stays a bounded amount of work per trip
/// on a large one (COUNT is a hint about work done, not a limit on keys returned).
const SCAN_COUNT: usize = 500;

/// The engine, carrying its preset id.
///
/// Two descriptor rows (`redis`, `valkey`) share one driver because Valkey is Redis's protocol
/// under a different name. The id is **data on the struct** rather than a constant in `spec()` —
/// the earlier bug where a zero-sized `PostgresEngine` reported Aurora connections as
/// plain PostgreSQL and served the wrong defaults.
pub struct RedisEngine {
    id: DbEngineId,
}

impl RedisEngine {
    pub const fn new(id: DbEngineId) -> Self {
        Self { id }
    }

    /// What to dial, from a [`ResolvedConfig`].
    ///
    /// A raw URL wins over the fields (the dialog's *"Overrides settings above"*) and is
    /// parsed by **redis-rs**, so the string the user pasted is the string that dials — including
    /// `rediss://` and a `/0` database suffix.
    fn connection_info(cfg: &ResolvedConfig) -> Result<ConnectionInfo, DbError> {
        if cfg.ca_pem.is_some() {
            return Err(DbError::invalid_config(
                "A custom CA certificate is not supported for Redis yet: this build passes no \
                 root store to the TLS client, so it would be accepted and then ignored. Use a \
                 server whose certificate chains to a CA this machine already trusts.",
            ));
        }

        if let Some(url) = cfg.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            // `IntoConnectionInfo` for `&str` is redis-rs's own parser, which understands
            // `redis://`, `rediss://`, `redis+unix://` and the `/db` suffix. Its error text can
            // echo the string — and the string can hold the password — so it is redacted, like
            // every other message leaving this module.
            let info = redis::IntoConnectionInfo::into_connection_info(url).map_err(|e| {
                DbError::invalid_config(format!("That connection string is not usable: {e}"))
                    .redacted(&config_secrets(cfg))
            })?;
            return Ok(info_with_field_gaps_filled(cfg, info));
        }

        let host = cfg.host.trim();
        if host.is_empty() {
            return Err(DbError::invalid_config(
                "This connection has no host. Enter the server's host name, or paste a \
                 `redis://` URL.",
            ));
        }
        // Both structs have private fields, so the builders are the only constructor — and they
        // are `self`-consuming, which is why this is a chain rather than a literal.
        let mut redis = RedisConnectionInfo::default()
            .set_db(database_index(&cfg.database)?)
            .set_protocol(ProtocolVersion::RESP2);
        // An empty user is left UNSET rather than sent as `""`: Redis before 6 has no ACL users at
        // all, and an AUTH carrying a username is rejected outright by such a server.
        let user = cfg.user.trim();
        if !user.is_empty() {
            redis = redis.set_username(user);
        }
        if !cfg.password.is_empty() {
            redis = redis.set_password(&cfg.password);
        }
        // `ConnectionInfo` has no public constructor and no `Default`; `ConnectionAddr` implements
        // `IntoConnectionInfo`, which is the supported way in to a value whose settings can then be
        // replaced. Infallible for an addr, so the `?` is a formality the signature requires.
        let info = redis::IntoConnectionInfo::into_connection_info(Self::addr(cfg, host))
            .map_err(|e| DbError::invalid_config(format!("That address is not usable: {e}")))?;
        Ok(info.set_redis_settings(redis))
    }

    /// TCP or TLS, and how strict the TLS is.
    ///
    /// The engine descriptor offers `disable | require | verify-ca | verify-full` (there is no
    /// opportunistic mode — Redis either speaks TLS on a port or it does not). `require` maps to
    /// redis-rs's `insecure: true`, which is the honest reading of "encrypt but do not verify",
    /// and the two verifying modes are **identical here**: rustls always checks the hostname, so
    /// `verify-ca` errs stricter. Same documented limitation as ClickHouse, and erring stricter is
    /// the safe direction.
    fn addr(cfg: &ResolvedConfig, host: &str) -> ConnectionAddr {
        let port = cfg.port_or_default();
        match cfg.ssl_mode {
            SslMode::Disable => ConnectionAddr::Tcp(host.to_string(), port),
            SslMode::Prefer | SslMode::Require => ConnectionAddr::TcpTls {
                host: host.to_string(),
                port,
                insecure: true,
                tls_params: None,
            },
            SslMode::VerifyCa | SslMode::VerifyFull => ConnectionAddr::TcpTls {
                host: host.to_string(),
                port,
                insecure: false,
                tls_params: None,
            },
        }
    }
}

/// Apply the User and Password **fields** to a [`ConnectionInfo`] the URL override produced — but
/// only where the string said nothing.
///
/// 🔴 **Same bug as the sqlx engines had, and it was worse here**: the URL branch of
/// [`RedisEngine::connection_info`] returned early, so a `redis://` override discarded the User and
/// Password fields **entirely**. The dialog says the URL *"overrides settings above"*, and a string
/// that carries no `:password@` overrides nothing about the password — it is silent on the subject.
/// A URL that does carry one keeps it, because the string in hand is better evidence than a field
/// beside it (and by this point `db::substitute_url` has already put the resolved secret back into
/// any `{{VAR}}`, so a reference counts as carrying one).
///
/// **The question is asked of redis-rs, not of [`crate::db::url::credential_of`]**, and that is a
/// deliberate exception to "one parser answers one question": redis-rs is the parser that will
/// *dial*, and it accepts strings our own grammar does not (`redis+unix://` has no row in
/// `engine_for_scheme`). Asking the dialling parser is what guarantees the two answers cannot drift
/// — which is the same reason the sqlx engines, whose driver keeps its password private, have to
/// use ours.
fn info_with_field_gaps_filled(cfg: &ResolvedConfig, info: ConnectionInfo) -> ConnectionInfo {
    let mut settings = info.redis_settings().clone();
    // An empty user stays UNSET rather than becoming `""` — the pre-6 `requirepass` shape, same as
    // the field path below.
    let user = cfg.user.trim();
    if settings.username().is_none() && !user.is_empty() {
        settings = settings.set_username(user);
    }
    if settings.password().is_none() && !cfg.password.is_empty() {
        settings = settings.set_password(&cfg.password);
    }
    info.set_redis_settings(settings)
}

#[async_trait]
impl DbEngine for RedisEngine {
    fn spec(&self) -> &'static EngineSpec {
        engines::spec_for(self.id).expect("every engine id has a descriptor row")
    }

    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn DbSession>, DbError> {
        // `redis` builds its rustls config from the PROCESS-DEFAULT provider, and
        // `cargo test` never runs `run()`. Installing here is what makes a `rediss://` connection
        // use our `ring` rather than panicking or picking a second backend.
        crate::tls::install_crypto_provider();

        let info = Self::connection_info(cfg)?;
        // Read BEFORE `Client::open` consumes it. redis-rs has already resolved the `/N` suffix of a
        // URL override into this number, so it is the database that will actually be SELECTed —
        // which is not necessarily the Database field (`db::engine::dialled_database`). Recorded as
        // the tree's label so the rail cannot claim `db0` while the connection sits on `db4`.
        let dialled_db = info.redis_settings().db();
        let client =
            Client::open(info).map_err(|e| map_redis_error(&e).redacted(&config_secrets(cfg)))?;

        // A CONNECT timeout of its own, because the config's `timeout_ms` is a *query* budget and
        // a dial to a host that silently drops packets would otherwise hang for it.
        let connect = Duration::from_millis(u64::from(cfg.timeout_ms).min(15_000));
        let mut conn =
            match tokio::time::timeout(connect, client.get_multiplexed_async_connection()).await {
                Ok(Ok(conn)) => conn,
                Ok(Err(e)) => return Err(map_redis_error(&e).redacted(&config_secrets(cfg))),
                Err(_) => {
                    return Err(DbError::new(
                        DbErrorCode::Network,
                        format!(
                            "Connecting to {} timed out after {} ms.",
                            cfg.host_label(),
                            connect.as_millis()
                        ),
                    ))
                }
            };

        // A round trip before `open` returns, for the reason ClickHouse needed one: without it a
        // multiplexed connection to a host that answers TCP but not Redis would be reported as a
        // working connection by Test Connection.
        let info: String = redis::cmd("INFO")
            .arg("server")
            .query_async(&mut conn)
            .await
            .map_err(|e| map_redis_error(&e).redacted(&config_secrets(cfg)))?;

        Ok(Box::new(RedisSession {
            conn,
            server_info: info,
            read_only: cfg.read_only,
            // The number redis-rs resolved, always — `database_index` round-trips it, and it agrees
            // with the field on every form-driven connection because that is where it came from.
            database: dialled_db.to_string(),
            password: cfg.password.clone(),
            engine: self.id,
        }))
    }
}

/// One open connection.
pub struct RedisSession {
    conn: MultiplexedConnection,
    /// The `INFO server` block read at connect — where [`RedisSession::probe`]'s version comes
    /// from, so a probe costs no second round trip.
    server_info: String,
    read_only: bool,
    database: String,
    password: String,
    engine: DbEngineId,
}

impl RedisSession {
    fn secrets(&self) -> Vec<&str> {
        if self.password.is_empty() {
            Vec::new()
        } else {
            vec![self.password.as_str()]
        }
    }

    /// Run one already-tokenised command under the run's timeout.
    async fn one(
        &mut self,
        line: &str,
        tokens: &[String],
        limits: &Limits,
    ) -> Result<DbResultSet, DbError> {
        let mut cmd = redis::cmd(&tokens[0]);
        for arg in &tokens[1..] {
            cmd.arg(arg.as_str());
        }
        let started = Instant::now();
        let deadline = Duration::from_millis(u64::from(limits.timeout_ms));
        match tokio::time::timeout(deadline, cmd.query_async::<Value>(&mut self.conn)).await {
            Ok(Ok(value)) => Ok(shape(
                line,
                value,
                limits.row_limit,
                started.elapsed().as_millis() as u64,
            )),
            // A command the SERVER refused (a wrong type, a bad argument count, a disabled
            // command) is an outcome of the statement, not a failure of the call — the same rule
            // as a SQL syntax error and as `mongo.rs`'s `outcome_of`.
            Ok(Err(e)) => {
                let mapped = map_redis_error(&e).redacted(&self.secrets());
                if is_server_refusal(&e) {
                    Ok(DbResultSet::message(line, mapped.message, limits.row_limit))
                } else {
                    Err(mapped)
                }
            }
            Err(_) => Err(DbError::new(
                DbErrorCode::Timeout,
                format!(
                    "`{}` exceeded this connection's {} ms timeout.",
                    guard::first_line(line),
                    limits.timeout_ms
                ),
            )),
        }
    }

    /// One page of keys, newest cursor first, with each key's `TYPE` in a single pipelined round
    /// trip rather than one per key.
    async fn key_nodes(&mut self) -> Result<Vec<DbNode>, DbError> {
        let mut cursor = 0u64;
        let mut keys: Vec<String> = Vec::new();
        // Bounded by the page AND by a cursor-trip cap: `SCAN` on a large keyspace can return an
        // empty batch many times over, and an unbounded loop here would be a rail that hangs.
        for _ in 0..64 {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("COUNT")
                .arg(SCAN_COUNT)
                .query_async(&mut self.conn)
                .await
                .map_err(|e| map_redis_error(&e).redacted(&self.secrets()))?;
            keys.extend(batch);
            cursor = next;
            if cursor == 0 || keys.len() >= KEY_PAGE {
                break;
            }
        }
        keys.truncate(KEY_PAGE);
        keys.sort();

        let mut types: Vec<String> = Vec::new();
        if !keys.is_empty() {
            let mut pipe = redis::pipe();
            for key in &keys {
                pipe.cmd("TYPE").arg(key);
            }
            types = pipe
                .query_async(&mut self.conn)
                .await
                .map_err(|e| map_redis_error(&e).redacted(&self.secrets()))?;
        }

        Ok(keys
            .into_iter()
            .enumerate()
            .map(|(i, key)| {
                let node = DbNode::new(
                    DbNodeRef::Table {
                        database: self.database.clone(),
                        schema: None,
                        name: key.clone(),
                    },
                    key,
                    DbNodeKind::Key,
                    false,
                );
                // The server's own word for the type, shown verbatim like every other engine's
                // type name. No size: that needs a per-type command per key (`HLEN`, `LLEN`, …),
                // which is a second pipeline for a sub-label, so a "hash · 3 fields" label is
                // NOT delivered yet rather than guessed at.
                match types.get(i) {
                    Some(t) if !t.is_empty() => node.with_sub_label(t.clone()),
                    _ => node,
                }
            })
            .collect())
    }
}

#[async_trait]
impl DbSession for RedisSession {
    async fn probe(&mut self) -> Result<ServerInfo, DbError> {
        Ok(ServerInfo {
            version: server_version(&self.server_info, self.engine),
            // Redis has no per-session id that a cancel could use, and `CLIENT ID` is a *connection*
            // id, not a query handle. Reporting one would imply `cancel` could act on it — see
            // `cancel` below, which refuses in words rather than pretending.
            backend_pid: None,
        })
    }

    async fn run(&mut self, script: &Script, limits: &Limits) -> Result<Vec<DbResultSet>, DbError> {
        let lines = command_lines(&script.text);
        if lines.is_empty() {
            return Err(DbError::invalid_statement("There is nothing to run."));
        }
        // The shared guard, so Redis cannot drift into its own idea of when a multi-command buffer
        // is refused. Here a "statement" is a line — Redis has no `;`.
        if let Some(blocked) = guard::multi_statement_refusal(&lines, script.mode, limits) {
            return Err(blocked);
        }

        // Tokenise and vet EVERY line before running any of them. A script whose third line is
        // refused must not have already executed the first two — the same reason the read-only
        // escape filter refuses a whole run.
        let mut planned: Vec<(String, Vec<String>)> = Vec::new();
        for line in &lines {
            let tokens = match tokenize(line) {
                Ok(t) if !t.is_empty() => t,
                Ok(_) => continue,
                // Unreadable text is an answer about the statement, not a broken connection
                // (see `error.rs`'s note on `InvalidStatement`).
                Err(e) => {
                    return Ok(vec![DbResultSet::message(
                        line.as_str(),
                        e.message,
                        limits.row_limit,
                    )])
                }
            };
            if let Some(refusal) = command_refusal(&tokens, self.read_only) {
                return Err(refusal);
            }
            planned.push((line.clone(), tokens));
        }

        let mut sets = Vec::with_capacity(planned.len());
        for (line, tokens) in &planned {
            let set = self.one(line, tokens, limits).await?;
            let failed = set.kind == DbResultKind::Message && set.rows.is_empty();
            sets.push(set);
            // Stop at the first failure, like every other engine's script path: continuing would
            // run later commands against a state the user did not expect.
            if failed {
                break;
            }
        }
        Ok(sets)
    }

    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        match node {
            // The CONNECTED database only, like PostgreSQL and unlike MySQL — and for a sharper
            // reason: `SELECT`ing another index on this connection would silently re-point every
            // subsequent command the user runs in the console beside the tree.
            DbNodeRef::Root => {
                let label = format!("db{}", database_index(&self.database)?);
                Ok(vec![DbNode::new(
                    DbNodeRef::Database {
                        name: label.clone(),
                    },
                    label,
                    DbNodeKind::Database,
                    true,
                )
                .with_sub_label("the connected database")])
            }
            // One group, so the level structure matches every other engine's — which is what lets
            // one `<DbTree/>` render all eight.
            DbNodeRef::Database { name } => {
                let count: i64 = redis::cmd("DBSIZE")
                    .query_async(&mut self.conn)
                    .await
                    .map_err(|e| map_redis_error(&e).redacted(&self.secrets()))?;
                Ok(vec![DbNode::new(
                    DbNodeRef::Group {
                        database: name.clone(),
                        schema: None,
                        group: DbGroup::Keys,
                    },
                    DbGroup::Keys.label(),
                    DbNodeKind::Group,
                    true,
                )
                .with_sub_label(format!("{count} keys"))])
            }
            DbNodeRef::Group {
                group: DbGroup::Keys,
                ..
            } => self.key_nodes().await,
            // A key is a leaf. Its VALUE is what the console is for, and a tree that expanded a
            // hash into 10 000 field nodes would be a worse way to read it than `HGETALL`.
            _ => Ok(Vec::new()),
        }
    }

    async fn close(self: Box<Self>) {
        // A multiplexed connection closes when dropped; there is no server-side session state to
        // release (no cursors, no temp tables), so there is nothing to await and nothing to log.
    }
}

/// The secrets that must not appear in any message leaving this module. `ResolvedConfig`
/// keeps its own copy of this list private to `engine.rs`, so each engine module repeats the two
/// lines rather than widening that type's surface.
fn config_secrets(cfg: &ResolvedConfig) -> Vec<&str> {
    if cfg.password.is_empty() {
        Vec::new()
    } else {
        vec![cfg.password.as_str()]
    }
}

/* ────────────────────────────── the command line ────────────────────────────── */

/// The non-blank, non-comment lines of a buffer, in order.
///
/// `#` starts a comment because that is what `redis-cli` scripts and the fixture's own seed file
/// use. There is no `;` splitting: `SET k "a;b"` is one command with a semicolon in its value, and
/// splitting on it would corrupt data rather than merely misparse.
pub fn command_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// One command line → its tokens, with shell-style quoting.
///
/// The rules, which are `redis-cli`'s and `curlParse.ts`'s: whitespace separates; `'…'` is
/// literal; `"…"` allows `\\` escapes; a backslash outside quotes escapes the next character. An
/// unterminated quote is an **error**, not a silent best effort — `SET k "value` reaching the
/// server as `SET k value` would store something the user did not type.
pub fn tokenize(line: &str) -> Result<Vec<String>, DbError> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            '\'' => {
                started = true;
                let mut closed = false;
                for c in chars.by_ref() {
                    if c == '\'' {
                        closed = true;
                        break;
                    }
                    cur.push(c);
                }
                if !closed {
                    return Err(unterminated('\''));
                }
            }
            '"' => {
                started = true;
                let mut closed = false;
                while let Some(c) = chars.next() {
                    match c {
                        '"' => {
                            closed = true;
                            break;
                        }
                        '\\' => match chars.next() {
                            // The escapes a person actually types in a Redis value. An unknown
                            // escape keeps BOTH characters rather than dropping the backslash:
                            // `"C:\path"` is a plausible value and `C:path` would be wrong.
                            Some('n') => cur.push('\n'),
                            Some('r') => cur.push('\r'),
                            Some('t') => cur.push('\t'),
                            Some('"') => cur.push('"'),
                            Some('\\') => cur.push('\\'),
                            Some(other) => {
                                cur.push('\\');
                                cur.push(other);
                            }
                            None => return Err(unterminated('"')),
                        },
                        other => cur.push(other),
                    }
                }
                if !closed {
                    return Err(unterminated('"'));
                }
            }
            '\\' => {
                started = true;
                match chars.next() {
                    Some(other) => cur.push(other),
                    None => {
                        return Err(DbError::invalid_statement(
                            "That line ends with a backslash, so the last character is escaping \
                             nothing. Remove it, or double it to mean a literal backslash.",
                        ))
                    }
                }
            }
            other => {
                started = true;
                cur.push(other);
            }
        }
    }
    if started {
        out.push(cur);
    }
    Ok(out)
}

fn unterminated(quote: char) -> DbError {
    DbError::invalid_statement(format!(
        "That line has an unclosed {quote} quote. Close it, so the value that reaches the server \
         is the one you typed."
    ))
}

/* ────────────────────────────── the guardrails ────────────────────────────── */

/// Commands refused in **every** mode, read-write included.
///
/// Not a safety guarantee — a read-write connection can still overwrite every key one `SET` at a
/// time — but there is no console-shaped reason to run any of these, and a very short path from
/// one keystroke to a destroyed database or a stopped server. `EVAL`/`SCRIPT` are here because a
/// Lua script would bypass every name-based rule below it: an allowlist that can be handed
/// arbitrary code to run is not an allowlist.
const ALWAYS_REFUSED: &[&str] = &[
    "FLUSHALL",
    "FLUSHDB",
    "SHUTDOWN",
    "DEBUG",
    "SWAPDB",
    "MIGRATE",
    "REPLICAOF",
    "SLAVEOF",
    "EVAL",
    "EVALSHA",
    "EVAL_RO",
    "EVALSHA_RO",
    "SCRIPT",
    "FUNCTION",
    "CONFIG SET",
    "CONFIG RESETSTAT",
    "CONFIG REWRITE",
    "CLUSTER RESET",
    "ACL SETUSER",
    "ACL DELUSER",
    "CLIENT KILL",
    "RESET",
    // `SELECT` would silently re-point every later command in this console — and the tree beside
    // it would then describe a different database than the one the user is querying.
    "SELECT",
];

/// The read-only allowlist, default-deny.
///
/// Written out rather than derived from a "writes" list, because a denylist of write commands is a
/// list someone forgets to update when Redis adds a command — and the failure mode of forgetting
/// is a write that was supposed to be impossible.
const READ_ONLY_ALLOWED: &[&str] = &[
    "GET",
    "MGET",
    "GETRANGE",
    "SUBSTR",
    "STRLEN",
    "EXISTS",
    "TYPE",
    "TTL",
    "PTTL",
    "EXPIRETIME",
    "PEXPIRETIME",
    "HGET",
    "HMGET",
    "HGETALL",
    "HKEYS",
    "HVALS",
    "HLEN",
    "HEXISTS",
    "HSTRLEN",
    "HRANDFIELD",
    "LRANGE",
    "LLEN",
    "LINDEX",
    "LPOS",
    "SMEMBERS",
    "SCARD",
    "SISMEMBER",
    "SMISMEMBER",
    "SRANDMEMBER",
    "SINTERCARD",
    "ZRANGE",
    "ZRANGEBYSCORE",
    "ZRANGEBYLEX",
    "ZREVRANGE",
    "ZCARD",
    "ZCOUNT",
    "ZSCORE",
    "ZMSCORE",
    "ZRANK",
    "ZREVRANK",
    "ZRANDMEMBER",
    "XRANGE",
    "XREVRANGE",
    "XLEN",
    "XINFO",
    "SCAN",
    "HSCAN",
    "SSCAN",
    "ZSCAN",
    "DBSIZE",
    "INFO",
    "MEMORY USAGE",
    "MEMORY STATS",
    "MEMORY DOCTOR",
    "CLIENT INFO",
    "CLIENT ID",
    "CLIENT LIST",
    "COMMAND",
    "COMMAND DOCS",
    "COMMAND COUNT",
    "COMMAND INFO",
    "CONFIG GET",
    "OBJECT",
    "OBJECT ENCODING",
    "OBJECT FREQ",
    "OBJECT IDLETIME",
    "OBJECT REFCOUNT",
    "LOLWUT",
    "PING",
    "ECHO",
    "TIME",
    "LASTSAVE",
    "RANDOMKEY",
    "KEYS",
    "GETBIT",
    "BITCOUNT",
    "BITPOS",
    "GEOPOS",
    "GEODIST",
    "GEOSEARCH",
    "JSON.GET",
    "JSON.MGET",
    "JSON.TYPE",
    "JSON.OBJLEN",
    "JSON.ARRLEN",
    "LATENCY HISTORY",
    "LATENCY LATEST",
    "SLOWLOG GET",
    "SLOWLOG LEN",
    "DUMP",
    "SORT_RO",
    "ACL WHOAMI",
    "ACL CAT",
    "HELLO",
    "WAIT",
];

/// Commands whose SECOND word is part of their identity (`CONFIG GET` vs `CONFIG SET`).
///
/// Without this, one rule would have to cover a container command's every subcommand, and
/// `CONFIG SET` — the one that can turn off persistence or change `maxmemory-policy` — would be
/// indistinguishable from the harmless `CONFIG GET`.
const CONTAINER_COMMANDS: &[&str] = &[
    "CONFIG", "CLIENT", "CLUSTER", "COMMAND", "MEMORY", "OBJECT", "SCRIPT", "FUNCTION", "ACL",
    "LATENCY", "SLOWLOG", "XINFO", "XGROUP", "PUBSUB",
];

/// The command's identity for the rules above: the first word upper-cased, plus the second when
/// the first is a container command.
pub fn command_name(tokens: &[String]) -> String {
    let head = tokens
        .first()
        .map(|t| t.to_ascii_uppercase())
        .unwrap_or_default();
    if CONTAINER_COMMANDS.contains(&head.as_str()) {
        if let Some(sub) = tokens.get(1) {
            return format!("{head} {}", sub.to_ascii_uppercase());
        }
    }
    head
}

/// `Some(refusal)` when this command must not run, in the mode the session is in.
///
/// Three rules, in the order that makes the *message* most useful: the always-refused list first
/// (it is true regardless of read-only, so saying "turn read-only off" would be wrong advice),
/// then `KEYS` (whose reason is performance and applies to both modes), then the allowlist.
pub fn command_refusal(tokens: &[String], read_only: bool) -> Option<DbError> {
    let name = command_name(tokens);
    // A container command with no subcommand (`CONFIG` alone) is checked against the bare head
    // too, so `CONFIG` cannot slip past a rule written for `CONFIG SET`.
    let head = tokens
        .first()
        .map(|t| t.to_ascii_uppercase())
        .unwrap_or_default();

    if ALWAYS_REFUSED.contains(&name.as_str()) || ALWAYS_REFUSED.contains(&head.as_str()) {
        return Some(DbError::blocked(format!(
            "`{name}` is refused by this app in every mode, read-write included — it can stop the \
             server, destroy a whole database, or run code that would bypass every other rule \
             here. Use `redis-cli` if you genuinely need it."
        )));
    }

    // 🔴 Refused in BOTH modes, and the message has to say WHY or it reads as an arbitrary
    // restriction on a read command: `KEYS` is O(N) and Redis is single-threaded, so on a
    // production database it blocks every other client for the length of the scan.
    if name == "KEYS" {
        return Some(DbError::blocked(
            "`KEYS` is refused in every mode: it scans the entire keyspace, and Redis runs one \
             command at a time, so on a busy server it blocks every other client until it \
             finishes. Use `SCAN 0 MATCH <pattern> COUNT 500`, which the connection tree also \
             uses.",
        ));
    }

    if read_only && !READ_ONLY_ALLOWED.contains(&name.as_str()) {
        return Some(DbError::blocked(format!(
            "This connection is read-only and `{name}` is not on this app's read-only list, so it \
             was refused before it ran. Redis has no server-side read-only mode for a session, so \
             the list is enforced here — an unrecognised command is refused rather than assumed \
             safe. Untick \"Read-only\" in this connection's settings if you mean to write."
        )));
    }
    None
}

/* ────────────────────────────── the reply ────────────────────────────── */

/// A [`Value`] → one [`DbResultSet`].
///
/// The shape rules, and each is a decision:
///
/// * **A status reply (`OK`, `QUEUED`) is a `message`**, not a one-cell table. It acknowledges a
///   command rather than answering a question, and `redis-cli` prints it the same way.
/// * **A scalar is a one-row, one-column grid**, because the requirement is that data
///   renders as a table, and because `null` (key absent) and `""` (key present, empty value) are
///   different answers that only a grid's NULL chip distinguishes.
/// * **An array is one row per element.** Flat arrays cover `LRANGE`/`SMEMBERS`/`HGETALL`/`SCAN`.
/// * **A nested array is rendered as compact text and the notice says so** — `XRANGE` returns
///   entry → [id, [field, value, …]], which two columns cannot hold. Put the loss in
///   the output where the person reading the data will see it.
pub fn shape(statement: &str, value: Value, row_limit: u32, duration_ms: u64) -> DbResultSet {
    // 🔴 **`+OK` and ONLY `+OK` is an acknowledgement.** An earlier version sent every RESP simple
    // string to a `message` result, and the live tier caught what that costs: `TYPE fixture:hash`
    // answers `+hash`, which is *data* — the answer to a question the user asked — and it was
    // rendering as prose instead of in the grid. `+PONG` is the same shape.
    // `+OK` is Redis's universal "I did the thing" and is the one that genuinely is not data.
    if let Value::Okay = value {
        return DbResultSet::message(statement, "OK", row_limit);
    }

    let cap = row_limit as usize;
    let (rows, truncated, nested, columns) = match value {
        // A map only arrives under RESP3, which this module does not negotiate — kept because the
        // enum is exhaustive and a future protocol switch must not silently stringify a map.
        Value::Map(pairs) => {
            let truncated = pairs.len() > cap;
            let rows: Vec<Vec<Option<String>>> = pairs
                .into_iter()
                .take(cap)
                .map(|(k, v)| vec![render(&k).1, render(&v).1])
                .collect();
            (
                rows,
                truncated,
                false,
                vec![text_column("field"), text_column("value")],
            )
        }
        Value::Array(items) | Value::Set(items) => {
            let truncated = items.len() > cap;
            let mut nested = false;
            let rows: Vec<Vec<Option<String>>> = items
                .into_iter()
                .take(cap)
                .map(|item| {
                    let (was_nested, cell) = render(&item);
                    nested |= was_nested;
                    vec![cell]
                })
                .collect();
            (rows, truncated, nested, vec![text_column("value")])
        }
        other => {
            let (nested, cell) = render(&other);
            let kind = match other {
                Value::Int(_) | Value::Double(_) => DbCellKind::Number,
                Value::Boolean(_) => DbCellKind::Bool,
                _ => DbCellKind::Text,
            };
            (
                vec![vec![cell]],
                false,
                nested,
                vec![DbColumn {
                    name: "value".to_string(),
                    type_name: type_name_of(&other).to_string(),
                    kind,
                }],
            )
        }
    };

    DbResultSet {
        kind: DbResultKind::Rows,
        statement: statement.to_string(),
        columns,
        rows,
        rows_affected: None,
        truncated,
        row_limit,
        duration_ms,
        // Redis has no documents and no absent fields: a reply is a value or a list of values, and
        // `Nil` is the one empty state. Nothing to mask.
        absent: None,
        notice: nested.then(|| {
            "This reply contains nested arrays, which a row of cells cannot hold, so each nested \
             value is rendered as text. Nothing was dropped."
                .to_string()
        }),
    }
}

fn text_column(name: &str) -> DbColumn {
    DbColumn {
        name: name.to_string(),
        type_name: "string".to_string(),
        kind: DbCellKind::Text,
    }
}

/// The server's own word for what a value is, shown verbatim in the column header like every
/// other engine's type name.
fn type_name_of(value: &Value) -> &'static str {
    match value {
        Value::Nil => "nil",
        Value::Int(_) => "integer",
        Value::Double(_) => "double",
        Value::Boolean(_) => "boolean",
        Value::BulkString(_) => "string",
        Value::VerbatimString { .. } => "verbatim",
        Value::SimpleString(_) => "status",
        Value::BigNumber(_) => "big number",
        _ => "value",
    }
}

/// One value → `(contained a nested collection, the cell)`.
///
/// `Nil` is `None` — SQL NULL's slot, and the only thing that distinguishes "no such key" from a
/// key holding the empty string. Non-UTF-8 bytes become `\x`-hex, the spelling the sqlx engines
/// already use for `bytea`/`BLOB`, rather than lossy U+FFFD replacement: a Redis value is a byte
/// string and a console that silently corrupts one is worse than one that shows hex.
fn render(value: &Value) -> (bool, Option<String>) {
    match value {
        Value::Nil => (false, None),
        Value::Int(n) => (false, Some(n.to_string())),
        Value::Double(f) => (false, Some(f.to_string())),
        Value::Boolean(b) => (false, Some(b.to_string())),
        // A RESP3 big number arrives as raw bytes here (redis-rs only decodes it to a `BigInt`
        // with a feature this build does not enable), so it renders through the same byte path as
        // a bulk string rather than through a numeric formatter that does not exist.
        Value::BigNumber(n) => (false, Some(bytes_cell(n))),
        Value::BulkString(bytes) => (false, Some(bytes_cell(bytes))),
        Value::VerbatimString { text, .. } => (false, Some(text.clone())),
        Value::Okay => (false, Some("OK".to_string())),
        Value::SimpleString(s) => (false, Some(s.clone())),
        Value::Array(items) | Value::Set(items) => {
            let inner: Vec<String> = items
                .iter()
                .map(|i| render(i).1.unwrap_or_else(|| "nil".to_string()))
                .collect();
            (true, Some(format!("[{}]", inner.join(", "))))
        }
        Value::Map(pairs) => {
            let inner: Vec<String> = pairs
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}: {}",
                        render(k).1.unwrap_or_else(|| "nil".to_string()),
                        render(v).1.unwrap_or_else(|| "nil".to_string())
                    )
                })
                .collect();
            (true, Some(format!("{{{}}}", inner.join(", "))))
        }
        // `Attribute`/`Push`/`ServerError` arrive only from pub-sub and RESP3 attributes, neither
        // of which a console command produces. Rendered rather than dropped so a surprise is
        // visible in the grid instead of appearing as an empty result.
        other => (false, Some(format!("{other:?}"))),
    }
}

/// A byte string as text when it is UTF-8, `\x…` hex when it is not.
fn bytes_cell(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let mut s = String::with_capacity(2 + bytes.len() * 2);
            s.push_str("\\x");
            for b in bytes {
                s.push_str(&format!("{b:02x}"));
            }
            s
        }
    }
}

/* ────────────────────────────── odds and ends ────────────────────────────── */

/// The `db` index from the connection's `database` field.
///
/// Redis names databases by number, so `"maestro"` is not a database here — it is a typo the user
/// should see, not a value to coerce to 0. An empty field is index 0, which is what every Redis
/// client defaults to.
pub fn database_index(database: &str) -> Result<i64, DbError> {
    let t = database.trim();
    if t.is_empty() {
        return Ok(0);
    }
    // `db3` is what a Redis user reads in `INFO keyspace` and in our own tree, so it is accepted
    // as well as the bare number — the tree's own labels round-trip through this function.
    let digits = t.strip_prefix("db").unwrap_or(t);
    digits
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 0)
        .ok_or_else(|| {
            DbError::invalid_config(format!(
            "Redis names its databases by number, so `{t}` cannot be one. Use an index like `0`, \
             or leave it empty."
        ))
        })
}

/// The version line out of an `INFO server` block.
///
/// Valkey reports **both** `valkey_version` and a compatibility `redis_version`, so the fork's own
/// field is read first — a Valkey server reporting itself as "Redis 7.2.4" would be a small lie in
/// the one string whose job is to say what answered.
pub fn server_version(info: &str, engine: DbEngineId) -> String {
    let fields: BTreeMap<&str, &str> = info
        .lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim(), v.trim()))
        .collect();
    if let Some(v) = fields.get("valkey_version") {
        return format!("Valkey {v}");
    }
    if let Some(v) = fields.get("redis_version") {
        let name = match engine {
            DbEngineId::Valkey => "Valkey-compatible Redis",
            _ => "Redis",
        };
        return format!("{name} {v}");
    }
    // Never a guessed number. A server that answered `INFO` with something unrecognised has still
    // proven it is there, and that is all this string promises.
    "Redis (version not reported)".to_string()
}

/// Whether the server refused the command (so it is a RESULT) as opposed to the connection or the
/// protocol failing (so it is an ERROR).
///
/// The distinction is the `http_send` contract applied to Redis: a `WRONGTYPE`, an unknown command
/// or a bad argument count is an answer, and the console must keep the session and show it beside
/// whatever else ran. A broken socket is not an answer.
fn is_server_refusal(e: &redis::RedisError) -> bool {
    use redis::ErrorKind as K;
    // redis-rs 1.5's own spellings, read from `errors/redis_error.rs` rather than guessed: there is
    // no `ResponseError`/`TypeError` here (those are the 0.2x names), and a server-side rejection
    // arrives as `Server(_)` or as a type mismatch while decoding the reply.
    matches!(
        e.kind(),
        K::Server(_) | K::UnexpectedReturnType | K::Extension | K::Parse
    )
}

/// A driver error → our code and prose.
///
/// `AuthenticationFailed`/`InvalidClientConfig` are the two a user can act on directly, and IO is
/// separated from protocol so "check the host and port" is never the advice for a server that
/// answered and said no.
pub fn map_redis_error(e: &redis::RedisError) -> DbError {
    use redis::ErrorKind as K;
    let detail = e.to_string();
    match e.kind() {
        K::AuthenticationFailed => DbError::new(
            DbErrorCode::Auth,
            format!("The server rejected these credentials. {detail}"),
        ),
        K::InvalidClientConfig => DbError::invalid_config(format!(
            "These connection settings are not usable: {detail}"
        )),
        K::Io => {
            // The kind alone does not say which IO failure it was, and redis-rs folds TLS
            // failures in here too — so the one narrow sniff is for TLS/certificate wording,
            // exactly as `map_sqlx_error` does for sqlx's `Protocol`.
            let lower = detail.to_ascii_lowercase();
            if lower.contains("tls") || lower.contains("certificate") || lower.contains("handshake")
            {
                DbError::new(
                    DbErrorCode::Tls,
                    format!(
                        "The TLS connection failed. If the server uses a private CA, use a \
                         certificate this machine trusts, or lower the SSL mode. ({detail})"
                    ),
                )
            } else {
                DbError::new(
                    DbErrorCode::Network,
                    format!(
                        "The server could not be reached — check the host, the port, and whether \
                         TLS is required on that port. ({detail})"
                    ),
                )
            }
        }
        // A replica refusing a write is a guardrail-shaped answer, so it keeps `blocked` — the
        // code whose sentence is about a statement stopped before it ran. Redis's own words
        // (`READONLY You can't write against a read only replica.`) are dropped rather than
        // appended: `blocked` is the code whose detail the panel renders verbatim, and that is
        // only safe while every one of them is prose we wrote (`DbError::blocked`).
        K::Server(redis::ServerErrorKind::ReadOnly) => DbError::blocked(
            "This server is a replica, and a replica refuses every write. Point this connection \
             at the primary if you mean to write — no setting in this app can change a replica's \
             answer.",
        ),
        // The server's own words, and they are the actionable part: `WRONGTYPE Operation against a
        // key holding the wrong kind of value` says exactly what to fix. `invalid-statement` is
        // the code whose detail the frontend renders verbatim.
        K::Server(_) | K::UnexpectedReturnType | K::Extension | K::Parse => {
            DbError::invalid_statement(detail)
        }
        _ => DbError::new(DbErrorCode::Unknown, format!("Redis said: {detail}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::model::DbRunMode;

    fn cfg() -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Redis,
            family: crate::db::model::DbFamily::Redis,
            host: "cache.internal".to_string(),
            port: None,
            srv: false,
            database: String::new(),
            user: String::new(),
            password: "s3cret-pw".to_string(),
            url: None,
            ssl_mode: SslMode::Disable,
            ca_pem: None,
            options: BTreeMap::new(),
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn limits(row_limit: u32) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn tok(line: &str) -> Vec<String> {
        tokenize(line).expect(line)
    }

    /* ───────────────────────────── the tokeniser ───────────────────────────── */

    #[test]
    fn a_command_line_splits_on_whitespace_and_keeps_quoted_runs_whole() {
        assert_eq!(tok("GET fixture:string"), vec!["GET", "fixture:string"]);
        assert_eq!(
            tok(r#"SET greeting "hello world""#),
            vec!["SET", "greeting", "hello world"]
        );
        assert_eq!(
            tok("  HGETALL   fixture:hash  "),
            vec!["HGETALL", "fixture:hash"]
        );
        // A key name with a colon and a space in it — the fixture has one, because a tokeniser
        // that split on either would make it unreachable.
        assert_eq!(
            tok(r#"GET "fixture:key with spaces""#),
            vec!["GET", "fixture:key with spaces"]
        );
    }

    #[test]
    fn single_quotes_are_literal_and_double_quotes_take_escapes() {
        assert_eq!(tok(r#"SET k 'a\nb'"#), vec!["SET", "k", r"a\nb"]);
        assert_eq!(tok(r#"SET k "a\nb""#), vec!["SET", "k", "a\nb"]);
        assert_eq!(
            tok(r#"SET k "say \"hi\"""#),
            vec!["SET", "k", r#"say "hi""#]
        );
        assert_eq!(
            tok(r#"SET k "back\\slash""#),
            vec!["SET", "k", r"back\slash"]
        );
        // An unknown escape keeps both characters: `C:\path` is a plausible value, and dropping
        // the backslash would store something the user did not type.
        assert_eq!(tok(r#"SET k "C:\path""#), vec!["SET", "k", r"C:\path"]);
    }

    #[test]
    fn an_empty_quoted_argument_survives_as_an_empty_string() {
        // The NULL-vs-empty distinction at the input end: `SET k ""` must store the empty string, and a
        // tokeniser that dropped the empty token would turn it into a one-argument `SET`.
        assert_eq!(
            tok(r#"SET fixture:empty """#),
            vec!["SET", "fixture:empty", ""]
        );
        assert_eq!(tok("SET k ''"), vec!["SET", "k", ""]);
    }

    #[test]
    fn an_unclosed_quote_is_a_statement_error_and_never_a_best_effort() {
        for line in [r#"SET k "value"#, "SET k 'value", r"SET k value\"] {
            let err = tokenize(line).expect_err(line);
            assert_eq!(err.code, DbErrorCode::InvalidStatement, "{line}");
            assert!(!err.message.is_empty(), "{line}");
        }
        // 🔴 The reason it is an error: `SET k "value` tokenised leniently would send
        // `SET k value` — a DIFFERENT value silently stored under the user's key.
        assert!(tokenize(r#"SET k "value"#).is_err());
    }

    #[test]
    fn comments_and_blank_lines_are_not_commands() {
        let lines = command_lines("# a comment\n\nGET a\n  \nGET b\n# trailing\n");
        assert_eq!(lines, vec!["GET a", "GET b"]);
    }

    #[test]
    fn a_semicolon_is_data_and_never_a_separator() {
        // Redis has no statement terminator. Splitting on `;` — the SQL habit — would corrupt a
        // value rather than merely misparse it.
        assert_eq!(command_lines(r#"SET k "a;b""#), vec![r#"SET k "a;b""#]);
        assert_eq!(tok(r#"SET k "a;b""#), vec!["SET", "k", "a;b"]);
    }

    /* ───────────────────────────── the guardrails ───────────────────────────── */

    #[test]
    fn the_read_only_allowlist_is_default_deny_and_names_the_command() {
        for line in [
            "SET k v",
            "DEL k",
            "HSET h f v",
            "EXPIRE k 10",
            "PERSIST k",
            "RENAME a b",
        ] {
            let err = command_refusal(&tok(line), true).unwrap_or_else(|| panic!("{line}"));
            assert_eq!(err.code, DbErrorCode::Blocked, "{line}");
            let name = tok(line)[0].to_ascii_uppercase();
            assert!(err.message.contains(&name), "{}", err.message);
        }
        // An unrecognised command — including a future one and a module's — is refused rather
        // than assumed safe, which is the whole point of default-deny.
        assert!(command_refusal(&tok("FT.CREATE idx SCHEMA n TEXT"), true).is_some());
        assert!(command_refusal(&tok("TOTALLY.NEW.COMMAND x"), true).is_some());
    }

    #[test]
    fn the_read_only_allowlist_admits_the_commands_a_console_actually_uses() {
        for line in [
            "GET fixture:string",
            "MGET a b c",
            "TYPE fixture:hash",
            "TTL fixture:ttl",
            "HGETALL fixture:hash",
            "LRANGE fixture:list 0 -1",
            "SMEMBERS fixture:set",
            "ZRANGE fixture:zset 0 -1 WITHSCORES",
            "XRANGE fixture:stream - +",
            "SCAN 0 COUNT 10",
            "DBSIZE",
            "INFO server",
            "PING",
            "OBJECT ENCODING fixture:hash",
            "MEMORY USAGE fixture:string",
            "CONFIG GET maxmemory",
            "CLIENT INFO",
        ] {
            assert!(
                command_refusal(&tok(line), true).is_none(),
                "read-only refused `{line}`"
            );
        }
    }

    #[test]
    fn keys_is_refused_in_both_modes_and_the_message_says_why() {
        // 🔴 It is ON the read-only allowlist (it is genuinely a read), and still refused — the
        // rule is about blocking a single-threaded server, not about writes. A test that only
        // checked read-only mode would miss the half that matters on a production database.
        for read_only in [true, false] {
            let err = command_refusal(&tok("KEYS *"), read_only)
                .unwrap_or_else(|| panic!("read_only={read_only}"));
            assert_eq!(err.code, DbErrorCode::Blocked);
            assert!(
                err.message.contains("one command at a time"),
                "{}",
                err.message
            );
            // And it must point at the alternative, or the refusal is a dead end.
            assert!(err.message.contains("SCAN"), "{}", err.message);
        }
        assert!(READ_ONLY_ALLOWED.contains(&"KEYS"), "the point of the test");
    }

    #[test]
    fn the_always_refused_list_holds_in_read_write_mode_too() {
        for line in [
            "FLUSHALL",
            "FLUSHDB ASYNC",
            "SHUTDOWN NOSAVE",
            "DEBUG SLEEP 30",
            "SWAPDB 0 1",
            "REPLICAOF NO ONE",
            "EVAL \"return 1\" 0",
            "SCRIPT LOAD \"return 1\"",
            "CONFIG SET appendonly no",
            "CLUSTER RESET HARD",
            "SELECT 3",
        ] {
            let err = command_refusal(&tok(line), false).unwrap_or_else(|| panic!("{line}"));
            assert_eq!(err.code, DbErrorCode::Blocked, "{line}");
            assert!(
                err.message.contains("every mode"),
                "{line}: {}",
                err.message
            );
        }
    }

    #[test]
    fn a_container_commands_subcommand_is_part_of_its_identity() {
        // The reason `command_name` exists: one rule for all of `CONFIG` would either refuse the
        // harmless `CONFIG GET` or admit `CONFIG SET`, which can turn off persistence.
        assert_eq!(command_name(&tok("CONFIG SET appendonly no")), "CONFIG SET");
        assert_eq!(command_name(&tok("config get maxmemory")), "CONFIG GET");
        assert_eq!(command_name(&tok("GET k")), "GET");
        // A bare container command has no subcommand and must not slip through as unrecognised.
        assert_eq!(command_name(&tok("CONFIG")), "CONFIG");
        assert!(command_refusal(&tok("CONFIG"), true).is_some());
        assert!(command_refusal(&tok("CONFIG GET maxmemory"), true).is_none());
        assert!(command_refusal(&tok("CONFIG SET appendonly no"), true).is_some());
    }

    #[test]
    fn case_does_not_matter_to_any_rule() {
        assert!(command_refusal(&tok("flushall"), false).is_some());
        assert!(command_refusal(&tok("keys *"), false).is_some());
        assert!(command_refusal(&tok("get k"), true).is_none());
        assert!(command_refusal(&tok("set k v"), true).is_some());
    }

    /* ───────────────────────────── the reply shaping ───────────────────────────── */

    #[test]
    fn a_status_reply_is_a_message_and_a_value_is_a_grid() {
        let ok = shape("SET k v", Value::Okay, 500, 1);
        assert_eq!(ok.kind, DbResultKind::Message);
        assert_eq!(ok.notice.as_deref(), Some("OK"));
        assert!(ok.rows.is_empty());

        let got = shape("GET k", Value::BulkString(b"hello".to_vec()), 500, 1);
        assert_eq!(got.kind, DbResultKind::Rows);
        assert_eq!(got.columns.len(), 1);
        assert_eq!(got.rows, vec![vec![Some("hello".to_string())]]);
    }

    #[test]
    fn a_simple_string_that_is_not_ok_is_data_and_goes_in_the_grid() {
        // 🔴 Found by the live tier, not by this file: `TYPE fixture:hash` answers with the RESP
        // simple string `+hash`, and an earlier version rendered every simple string as prose — so
        // the answer to a question the user asked appeared as a notice instead of in the table.
        // `+OK` is the acknowledgement; `+hash` and `+PONG` are answers.
        let typed = shape(
            "TYPE fixture:hash",
            Value::SimpleString("hash".into()),
            500,
            1,
        );
        assert_eq!(typed.kind, DbResultKind::Rows);
        assert_eq!(typed.rows, vec![vec![Some("hash".to_string())]]);

        let pong = shape("PING", Value::SimpleString("PONG".into()), 500, 1);
        assert_eq!(pong.kind, DbResultKind::Rows);
        assert_eq!(pong.rows, vec![vec![Some("PONG".to_string())]]);

        // …and the acknowledgement still is one.
        assert_eq!(
            shape("SET k v", Value::Okay, 500, 1).kind,
            DbResultKind::Message
        );
    }

    #[test]
    fn nil_and_the_empty_string_stay_different_answers() {
        // 🔴 NULL vs empty, and for Redis it is the difference between "no such key" and "a key holding
        // the empty string" — two facts a user acts on differently.
        let absent = shape("GET fixture:absent", Value::Nil, 500, 1);
        assert_eq!(absent.rows, vec![vec![None]]);
        let empty = shape("GET fixture:empty", Value::BulkString(Vec::new()), 500, 1);
        assert_eq!(empty.rows, vec![vec![Some(String::new())]]);
        assert_ne!(absent.rows, empty.rows);
    }

    #[test]
    fn an_integer_is_right_aligned_and_a_string_is_not() {
        assert_eq!(
            shape("DBSIZE", Value::Int(5007), 500, 1).columns[0].kind,
            DbCellKind::Number
        );
        assert_eq!(
            shape("GET k", Value::BulkString(b"42".to_vec()), 500, 1).columns[0].kind,
            DbCellKind::Text
        );
        // The type name is the server's own vocabulary, shown verbatim like every other engine's.
        assert_eq!(
            shape("DBSIZE", Value::Int(1), 500, 1).columns[0].type_name,
            "integer"
        );
    }

    #[test]
    fn non_utf8_bytes_become_hex_rather_than_replacement_characters() {
        // The fixture stores `\x00\xff\x10` on purpose. A Redis value is a byte string, and a
        // console that renders it as U+FFFD has silently corrupted the data it was asked to show.
        let set = shape(
            "GET fixture:binary",
            Value::BulkString(vec![0, 255, 16]),
            500,
            1,
        );
        assert_eq!(set.rows, vec![vec![Some("\\x00ff10".to_string())]]);
    }

    #[test]
    fn an_array_is_one_row_per_element() {
        let value = Value::Array(vec![
            Value::BulkString(b"first".to_vec()),
            Value::BulkString(b"second".to_vec()),
            Value::Nil,
        ]);
        let set = shape("LRANGE l 0 -1", value, 500, 1);
        assert_eq!(set.rows.len(), 3);
        assert_eq!(set.rows[2], vec![None]);
        assert_eq!(set.notice, None);
    }

    #[test]
    fn the_row_cap_is_measured_and_the_notice_names_a_flattened_nesting() {
        let many = Value::Array((0..10).map(Value::Int).collect());
        let capped = shape("LRANGE l 0 -1", many, 3, 1);
        assert_eq!(capped.rows.len(), 3);
        assert!(
            capped.truncated,
            "10 elements under a cap of 3 is truncated"
        );

        // `XRANGE` returns entry → [id, [field, value, …]]. Two states the contract cannot hold,
        // so the loss goes in the OUTPUT rather than being chosen silently.
        let nested = Value::Array(vec![Value::Array(vec![
            Value::BulkString(b"1-0".to_vec()),
            Value::Array(vec![
                Value::BulkString(b"event".to_vec()),
                Value::BulkString(b"track".to_vec()),
            ]),
        ])]);
        let set = shape("XRANGE s - +", nested, 500, 1);
        assert_eq!(set.rows.len(), 1);
        let cell = set.rows[0][0].as_deref().unwrap_or_default();
        assert!(cell.contains("event"), "{cell}");
        assert!(cell.contains("track"), "{cell}");
        assert!(
            set.notice.as_deref().unwrap_or_default().contains("nested"),
            "{:?}",
            set.notice
        );
        // "Nothing was dropped" has to be TRUE: every leaf is in the rendered text.
        assert!(cell.contains("1-0"), "{cell}");
    }

    /* ───────────────────────────── the dial ───────────────────────────── */

    #[test]
    fn the_default_port_comes_from_the_descriptor_and_an_empty_database_is_index_zero() {
        let info = RedisEngine::connection_info(&cfg()).expect("info");
        assert_eq!(
            *info.addr(),
            ConnectionAddr::Tcp("cache.internal".to_string(), 6379)
        );
        assert_eq!(info.redis_settings().db(), 0);
        // No user configured means NO username on the wire: a pre-6 Redis rejects an AUTH that
        // carries one, so an empty string would break every server without ACLs.
        assert_eq!(info.redis_settings().username(), None);
        assert_eq!(info.redis_settings().password(), Some("s3cret-pw"));
    }

    #[test]
    fn a_database_must_be_a_number_and_says_so_when_it_is_not() {
        assert_eq!(database_index("").unwrap(), 0);
        assert_eq!(database_index("3").unwrap(), 3);
        // The tree's own label round-trips, which is what lets `children` re-read it.
        assert_eq!(database_index("db7").unwrap(), 7);
        let err = database_index("maestro").expect_err("not a number");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("by number"), "{}", err.message);
        assert!(database_index("-1").is_err());
    }

    #[test]
    fn ssl_mode_decides_tls_and_how_strict_it_is() {
        let mut c = cfg();
        c.ssl_mode = SslMode::Require;
        assert!(matches!(
            *RedisEngine::connection_info(&c).unwrap().addr(),
            ConnectionAddr::TcpTls { insecure: true, .. }
        ));
        c.ssl_mode = SslMode::VerifyFull;
        assert!(matches!(
            *RedisEngine::connection_info(&c).unwrap().addr(),
            ConnectionAddr::TcpTls {
                insecure: false,
                ..
            }
        ));
        // `verify-ca` and `verify-full` are the same request here, and that is documented rather
        // than smoothed over: rustls always checks the hostname, so we err STRICTER than asked.
        c.ssl_mode = SslMode::VerifyCa;
        assert!(matches!(
            *RedisEngine::connection_info(&c).unwrap().addr(),
            ConnectionAddr::TcpTls {
                insecure: false,
                ..
            }
        ));
    }

    #[test]
    fn a_url_override_wins_over_the_fields() {
        // The dialog says the URL box "Overrides settings above", so it has to (and
        // `clickhouse.rs::base_url` honours the override too).
        let mut c = cfg();
        c.url = Some("redis://other.host:6380/4".to_string());
        let info = RedisEngine::connection_info(&c).expect("info");
        assert_eq!(
            *info.addr(),
            ConnectionAddr::Tcp("other.host".to_string(), 6380)
        );
        assert_eq!(info.redis_settings().db(), 4);
    }

    /// 🔴 **The dropped-password bug — and it was at its worst here.** The URL branch returned
    /// early, so a `redis://` override discarded the Password field *entirely*: the string overrode
    /// a setting it had said nothing about.
    ///
    /// Every row of the negative control matters. A URL that carries `:pw@` keeps its
    /// own password, proved by making the field's value different and watching the URL's survive —
    /// without that, an implementation that simply always applied the field would pass.
    #[test]
    fn a_url_that_carries_no_password_still_takes_the_one_typed_beside_it() {
        let mut c = cfg(); // password `s3cret-pw`, no user (the `requirepass` shape)
        c.url = Some("redis://other.host:6380/4".to_string());
        let info = RedisEngine::connection_info(&c).expect("info");
        assert_eq!(
            info.redis_settings().password(),
            Some("s3cret-pw"),
            "the URL said nothing about the password, so the field must fill the gap"
        );
        // An empty user is still left UNSET — a pre-6 Redis rejects an AUTH carrying one, and the
        // gap-fill must not be the thing that reintroduces `""`.
        assert_eq!(info.redis_settings().username(), None);

        // The control: a string that speaks for itself keeps its own credential.
        c.url = Some("redis://:url-pw@other.host:6380/4".to_string());
        let info = RedisEngine::connection_info(&c).expect("info");
        assert_eq!(info.redis_settings().password(), Some("url-pw"));

        // …and an ACL user in the string wins over the User field, while a string with no userinfo
        // takes it.
        c.user = "acl_ro".to_string();
        c.url = Some("redis://someone:url-pw@other.host:6380/4".to_string());
        let info = RedisEngine::connection_info(&c).expect("info");
        assert_eq!(info.redis_settings().username(), Some("someone"));
        c.url = Some("redis://other.host:6380/4".to_string());
        let info = RedisEngine::connection_info(&c).expect("info");
        assert_eq!(info.redis_settings().username(), Some("acl_ro"));
        assert_eq!(info.redis_settings().password(), Some("s3cret-pw"));
    }

    #[test]
    fn a_rediss_url_dials_tls_even_when_the_ssl_control_says_disable() {
        // The string wins, because it is the more specific statement of intent — and silently
        // dialling plaintext for a `rediss://` URL would be the "control that does not do what it
        // says" failure this project has already had once (SRV + sslMode).
        let mut c = cfg();
        c.ssl_mode = SslMode::Disable;
        c.url = Some("rediss://secure.host/0".to_string());
        assert!(matches!(
            *RedisEngine::connection_info(&c).unwrap().addr(),
            ConnectionAddr::TcpTls { .. }
        ));
    }

    #[test]
    fn an_unparseable_url_is_invalid_config_and_carries_no_secret() {
        let mut c = cfg();
        c.url = Some("redis://user:s3cret-pw@:::/".to_string());
        let err = RedisEngine::connection_info(&c).expect_err("unparseable");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(!err.message.contains("s3cret-pw"), "{}", err.message);
    }

    #[test]
    fn a_missing_host_is_refused_before_anything_dials() {
        let mut c = cfg();
        c.host = "   ".to_string();
        let err = RedisEngine::connection_info(&c).expect_err("no host");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("no host"), "{}", err.message);
    }

    #[test]
    fn a_configured_ca_is_refused_rather_than_accepted_and_ignored() {
        // The MongoDB precedent: a setting that reports one thing and does another is not
        // something this app ships again.
        let mut c = cfg();
        c.ca_pem = Some(b"-----BEGIN CERTIFICATE-----".to_vec());
        let err = RedisEngine::connection_info(&c).expect_err("ca");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("not supported"), "{}", err.message);
    }

    /* ───────────────────────────── versions and errors ───────────────────────────── */

    #[test]
    fn the_version_string_names_what_actually_answered() {
        let redis_info = "# Server\r\nredis_version:8.2.1\r\nprocess_id:1\r\n";
        assert_eq!(server_version(redis_info, DbEngineId::Redis), "Redis 8.2.1");
        // A Valkey server reports BOTH fields; its own must win, or the one string whose job is to
        // say what answered would name the wrong product.
        let valkey_info = "# Server\r\nredis_version:7.2.4\r\nvalkey_version:8.1.0\r\n";
        assert_eq!(
            server_version(valkey_info, DbEngineId::Redis),
            "Valkey 8.1.0"
        );
        // A Redis-compatible fork under the Valkey preset reports only `redis_version`, and the
        // label says compatible rather than claiming to be Valkey.
        assert_eq!(
            server_version(redis_info, DbEngineId::Valkey),
            "Valkey-compatible Redis 8.2.1"
        );
        // Never a guessed number.
        assert_eq!(
            server_version("# Server\r\nnothing:here\r\n", DbEngineId::Redis),
            "Redis (version not reported)"
        );
    }

    #[test]
    fn a_response_error_is_a_statement_problem_carrying_the_servers_words() {
        // `WRONGTYPE` names exactly what to fix, so it is `invalid-statement` — the code whose
        // detail the frontend renders verbatim. Reporting it as `invalid-config`
        // would send the user to check a host that is fine.
        let e: redis::RedisError = (
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "WRONGTYPE Operation against a key holding the wrong kind of value",
        )
            .into();
        let mapped = map_redis_error(&e);
        assert_eq!(mapped.code, DbErrorCode::InvalidStatement);
        assert!(mapped.message.contains("WRONGTYPE"), "{}", mapped.message);
        assert!(is_server_refusal(&e), "a refusal is a RESULT, not an error");
    }

    /// The sibling of the test above, and the contrast is the point: a `WRONGTYPE` keeps the
    /// server's words because `invalid-statement` is about the command the user typed, while a
    /// replica's `READONLY` does not, because `blocked` is a code whose detail the panel renders
    /// and which therefore carries our prose only (`DbError::blocked`).
    ///
    /// Redis's own sentence is `READONLY You can't write against a read only replica.` — true, and
    /// it names no way out. Ours does, and it is honest that the way out is not a setting here.
    #[test]
    fn a_replica_refusal_says_what_to_do_and_keeps_none_of_the_servers_text() {
        let e: redis::RedisError = (
            redis::ErrorKind::Server(redis::ServerErrorKind::ReadOnly),
            "READONLY You can't write against a read only replica. \
             (redis://catalog_ro:hunter2@cache.internal:6379/0)",
        )
            .into();
        let mapped = map_redis_error(&e).redacted(&["hunter2"]);
        assert_eq!(mapped.code, DbErrorCode::Blocked);
        for fragment in [
            "hunter2",
            "cache.internal",
            "redis://",
            "catalog_ro",
            "6379",
        ] {
            assert!(
                !mapped.message.contains(fragment),
                "{fragment:?} reached a message the panel renders: {}",
                mapped.message
            );
        }
        assert!(mapped.message.contains("primary"), "{}", mapped.message);
        // …and it must not send the user to a checkbox that cannot help — a replica is a replica.
        assert!(
            !mapped.message.contains("Untick"),
            "advises a setting that cannot change a replica's answer: {}",
            mapped.message
        );
    }

    #[test]
    fn an_auth_failure_is_auth_and_an_io_failure_is_network() {
        let auth: redis::RedisError =
            (redis::ErrorKind::AuthenticationFailed, "invalid password").into();
        assert_eq!(map_redis_error(&auth).code, DbErrorCode::Auth);
        assert!(
            !is_server_refusal(&auth),
            "auth must not resolve as a result"
        );

        let io: redis::RedisError = (redis::ErrorKind::Io, "connection refused").into();
        assert_eq!(map_redis_error(&io).code, DbErrorCode::Network);

        // TLS failures are folded into IoError by redis-rs, so the one narrow sniff separates
        // them — otherwise "check the host and the port" is the advice for a certificate problem.
        let tls: redis::RedisError = (
            redis::ErrorKind::Io,
            "invalid peer certificate: UnknownIssuer",
        )
            .into();
        assert_eq!(map_redis_error(&tls).code, DbErrorCode::Tls);
    }

    #[test]
    fn the_engine_reports_the_spec_of_the_id_it_is_registered_under() {
        // The bug that once cost an Aurora connection its defaults: a zero-sized engine
        // hardcoding one id reports the wrong descriptor for its second registration.
        assert_eq!(
            RedisEngine::new(DbEngineId::Redis).spec().id,
            DbEngineId::Redis
        );
        assert_eq!(
            RedisEngine::new(DbEngineId::Valkey).spec().id,
            DbEngineId::Valkey
        );
        assert_eq!(
            RedisEngine::new(DbEngineId::Valkey).spec().label,
            "Valkey (Redis-compatible)"
        );
    }

    #[test]
    fn the_shared_multi_command_guard_governs_a_multi_line_buffer() {
        // Reused rather than reimplemented, so Redis cannot drift into its own idea of when a
        // buffer with several commands is refused.
        let lines = command_lines("GET a\nGET b");
        assert!(
            guard::multi_statement_refusal(&lines, DbRunMode::Statement, &limits(500)).is_some()
        );
        assert!(
            guard::multi_statement_refusal(&lines, DbRunMode::Script, &limits(500)).is_some(),
            "a script still needs the connection's opt-in"
        );
        let mut opted_in = limits(500);
        opted_in.allow_multi_statement = true;
        assert!(guard::multi_statement_refusal(&lines, DbRunMode::Script, &opted_in).is_none());
    }
}
