//! DB errors: stable codes for command rejections ([`DbError::to_wire`], `<code>[: <detail>]`) and
//! a human sentence the test dialog renders verbatim ([`DbError::message`]), from one struct.
//! Drivers echo the DSN, so every error leaving `db::` goes through [`DbError::redacted`].

use serde::Serialize;

/// What a `db_*` command failed at. Mirrors `DbErrorCode` in `src/features/db/types.ts`, so
/// the panel can always say something true and specific and never has to invent a cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbErrorCode {
    /// No such connection / session id.
    NotFound,
    /// The config is invalid before we ever dial.
    InvalidConfig,
    /// The statement cannot run (unparseable, empty, or refused as malformed); the connection is
    /// fine. Kept apart from `InvalidConfig` because the frontend maps each code to one sentence.
    InvalidStatement,
    /// DNS / refused / unreachable.
    Network,
    /// TLS handshake or certificate verification failed.
    Tls,
    /// The server rejected the credentials.
    Auth,
    /// A `{{VAR}}` reference has nothing behind it in the Vault.
    SecretMissing,
    /// A statement refused by policy (read-only or multi-statement guard, a server's read-only
    /// refusal). Every message is our prose, built only via [`DbError::blocked`].
    Blocked,
    /// Exceeded `timeout_ms`.
    Timeout,
    /// The user cancelled.
    #[allow(dead_code)] // Part of the wire contract; no engine constructs it yet.
    Cancelled,
    /// Anything unclassified — so the UI never renders a raw driver string.
    Unknown,
}

impl DbErrorCode {
    /// The wire spelling, identical to the serde one. Written out by hand rather than routed
    /// through `serde_json` so the wire format of an *error* never depends on a serialiser
    /// succeeding.
    pub fn as_str(self) -> &'static str {
        match self {
            DbErrorCode::NotFound => "not-found",
            DbErrorCode::InvalidConfig => "invalid-config",
            DbErrorCode::InvalidStatement => "invalid-statement",
            DbErrorCode::Network => "network",
            DbErrorCode::Tls => "tls",
            DbErrorCode::Auth => "auth",
            DbErrorCode::SecretMissing => "secret-missing",
            DbErrorCode::Blocked => "blocked",
            DbErrorCode::Timeout => "timeout",
            DbErrorCode::Cancelled => "cancelled",
            DbErrorCode::Unknown => "unknown",
        }
    }
}

/// A classified, human-readable, already-redacted failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbError {
    pub code: DbErrorCode,
    /// A complete sentence for a person. Never a raw driver dump, never a bare code.
    pub message: String,
}

impl DbError {
    pub fn new(code: DbErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_config(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::InvalidConfig, message)
    }

    /// The statement cannot run. Written for the person who typed it: the frontend renders it
    /// verbatim (`dbErrors.ts`'s `DETAIL_IS_THE_ANSWER`). Still redacted on the way out.
    pub fn invalid_statement(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::InvalidStatement, message)
    }

    /// A refused statement. The message is our prose, never driver or server text, so `blocked`
    /// details render verbatim safely (drivers echo the DSN); it may quote the user's statement.
    /// Enforced by `no_blocked_error_is_built_outside_the_…` and per-mapper leak tests.
    pub fn blocked(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::Blocked, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::NotFound, message)
    }

    pub fn secret_missing(message: impl Into<String>) -> Self {
        Self::new(DbErrorCode::SecretMissing, message)
    }

    /// The `Err(String)` a `#[tauri::command]` rejects with: `"<code>: <detail>"`.
    pub fn to_wire(&self) -> String {
        if self.message.is_empty() {
            self.code.as_str().to_string()
        } else {
            format!("{}: {}", self.code.as_str(), self.message)
        }
    }

    /// The prose the dialog renders for a failed Test Connection.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// `self` with every non-empty secret in `secrets` replaced by `••••`. Idempotent; empty
    /// secrets are skipped so they cannot mask every empty substring.
    pub fn redacted(mut self, secrets: &[&str]) -> Self {
        self.message = crate::db::secret::redact(&self.message, secrets);
        self
    }

    /// On an auth failure, prepend the account and host dialled, from our own non-secret fields,
    /// after redaction (which masks a server echo of a user equal to the password). A user name
    /// equal to the password stays masked, and the message says the two are identical.
    pub fn with_auth_identity(mut self, user: &str, password: &str, host: &str) -> Self {
        if self.code != DbErrorCode::Auth {
            return self;
        }
        let subject = if user.is_empty() {
            "with no user name".to_string()
        } else if user == password {
            // Naming it would print the password. Saying so is strictly more useful than the bare
            // mask shown before, and it explains that mask instead of leaving it looking like
            // damage.
            "as the user this connection names — not shown here because its name and its \
             password are the same string, which is also why the server's own message below is \
             masked"
                .to_string()
        } else {
            format!("as user `{user}`")
        };
        // Prepended rather than folded in: `self.message` is a whole sentence from
        // `map_sqlx_error` (and the 42501 privilege case is an `Auth` code too), so rewriting it
        // would mean this function knowing every message that can reach it.
        self.message = format!(
            "Agent Studio tried to sign in to {host} {subject}. {}",
            self.message
        );
        self
    }
}

/// The redaction mask. Matches `SECRET_MASK` in `engineFields.ts`, so a value scrubbed in
/// Rust and one scrubbed by the frontend's defence-in-depth pass look the same.
pub const MASK: &str = "••••";

/// Map a `sqlx` error to code + prose, distinguishing `auth`, `network`, `tls`, `invalid-config`
/// by SQLSTATE where available (stable, unlike English). Server text appended is redacted by the
/// caller.
pub fn map_sqlx_error(e: &sqlx::Error) -> DbError {
    use sqlx::Error as E;
    match e {
        E::Database(d) => {
            let sqlstate = d.code().map(|c| c.to_string()).unwrap_or_default();
            let server = d.message().to_string();
            match sqlstate.as_str() {
                // 28P01 invalid_password (Postgres) · 28000 invalid_authorization_specification
                "28P01" | "28000" => DbError::new(
                    DbErrorCode::Auth,
                    format!("The server rejected those credentials. {server}"),
                ),
                // 3D000 invalid_catalog_name — the database does not exist.
                "3D000" => DbError::invalid_config(format!(
                    "That database does not exist on the server. {server}"
                )),
                // 42501 insufficient_privilege — the account cannot do what was asked.
                "42501" => DbError::new(
                    DbErrorCode::Auth,
                    format!("That account is not allowed to do this. {server}"),
                ),
                // 25006 read_only_sql_transaction: the server-side guardrail. The one arm that does
                // not append `server`: `blocked` carries our prose only (see `DbError::blocked`).
                "25006" => DbError::blocked(
                    "The server refused that statement because the transaction is read-only. \
                     Untick \"Read-only\" in this connection's settings if you mean to write — and \
                     if it is already off, the server itself is read-only (a standby, or a \
                     read-only default).",
                ),
                // 57014 query_canceled — either `db_cancel` or `statement_timeout`.
                "57014" => DbError::new(
                    DbErrorCode::Timeout,
                    format!("The statement was cancelled by the server. {server}"),
                ),
                _ if sqlstate.is_empty() => {
                    DbError::new(DbErrorCode::Unknown, format!("The database said: {server}"))
                }
                _ => DbError::new(
                    DbErrorCode::Unknown,
                    format!("The database said: {server} (SQLSTATE {sqlstate})"),
                ),
            }
        }
        E::Io(io) => {
            let hint = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => {
                    "Nothing is listening there — check the host and the port."
                }
                std::io::ErrorKind::TimedOut => {
                    "The connection attempt timed out — a firewall may be dropping it."
                }
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => {
                    "The server closed the connection. If SSL is off, the server may require it."
                }
                // `UnexpectedEof` comes only after the socket is up (sqlx-core's buffered reader):
                // the server closed mid-protocol, so host and port are fine. `5 bytes` is the
                // message header; the named causes drop a connection at its first reply.
                std::io::ErrorKind::UnexpectedEof => {
                    "The server accepted the connection and then closed it without answering, so \
                     the host and the port are reachable and something else ended it. The usual \
                     causes are an SSL mismatch (try another SSL mode — some servers hang up \
                     instead of negotiating), a connection pooler in front of the database, or a \
                     port that belongs to a different service."
                }
                _ => "Check the host, the port and the network.",
            };
            DbError::new(DbErrorCode::Network, format!("{hint} ({io})"))
        }
        E::Tls(inner) => DbError::new(
            DbErrorCode::Tls,
            format!(
                "The TLS handshake failed. If the server uses a private CA, add its \
                 certificate — or lower the SSL mode. ({inner})"
            ),
        ),
        E::Configuration(inner) => {
            DbError::invalid_config(format!("The connection settings are not usable: {inner}"))
        }
        E::InvalidArgument(s) => {
            DbError::invalid_config(format!("The connection settings are not usable: {s}"))
        }
        E::PoolTimedOut => DbError::new(
            DbErrorCode::Timeout,
            "Timed out waiting for a connection to the database.".to_string(),
        ),
        // `Protocol` is where sqlx puts "the server said something we could not read". A TLS
        // requirement refused mid-handshake surfaces here rather than in `Tls`, so it is
        // sniffed — narrowly, and only to pick between two of OUR codes.
        E::Protocol(s) => {
            let lower = s.to_ascii_lowercase();
            if lower.contains("tls") || lower.contains("ssl") {
                DbError::new(
                    DbErrorCode::Tls,
                    format!("The server would not negotiate TLS as configured: {s}"),
                )
            } else {
                DbError::new(
                    DbErrorCode::Unknown,
                    format!("The driver could not read the server's reply: {s}"),
                )
            }
        }
        other => DbError::new(
            DbErrorCode::Unknown,
            format!("The database driver failed: {other}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_the_wire_spelling_the_contract_lists() {
        // Literal expectations, in the contract's order. Not derived from the enum.
        let want: &[(DbErrorCode, &str)] = &[
            (DbErrorCode::NotFound, "not-found"),
            (DbErrorCode::InvalidConfig, "invalid-config"),
            (DbErrorCode::InvalidStatement, "invalid-statement"),
            (DbErrorCode::Network, "network"),
            (DbErrorCode::Tls, "tls"),
            (DbErrorCode::Auth, "auth"),
            (DbErrorCode::SecretMissing, "secret-missing"),
            (DbErrorCode::Blocked, "blocked"),
            (DbErrorCode::Timeout, "timeout"),
            (DbErrorCode::Cancelled, "cancelled"),
            (DbErrorCode::Unknown, "unknown"),
        ];
        for (code, spelling) in want {
            assert_eq!(code.as_str(), *spelling);
            // The serde spelling must agree with the hand-written one, or a rejection and a
            // serialised code would disagree about the same failure.
            assert_eq!(
                serde_json::to_string(code).unwrap(),
                format!("\"{spelling}\"")
            );
        }
    }

    #[test]
    fn to_wire_is_code_colon_detail_and_a_bare_code_when_there_is_none() {
        assert_eq!(
            DbError::new(DbErrorCode::Network, "refused").to_wire(),
            "network: refused"
        );
        assert_eq!(DbError::new(DbErrorCode::Timeout, "").to_wire(), "timeout");
    }

    #[test]
    fn redacted_scrubs_every_secret_and_ignores_the_empty_one() {
        let e = DbError::new(DbErrorCode::Auth, "auth failed for url pg://u:hunter2@h");
        let r = e.redacted(&["hunter2", ""]);
        assert!(!r.message.contains("hunter2"), "{}", r.message);
        assert!(r.message.contains(MASK), "{}", r.message);
        // The empty secret must not have masked anything else.
        assert!(r.message.contains("auth failed for url"), "{}", r.message);
    }

    #[test]
    fn an_io_error_maps_to_network_with_an_actionable_hint() {
        let e = sqlx::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        let m = map_sqlx_error(&e);
        assert_eq!(m.code, DbErrorCode::Network);
        assert!(
            m.message.contains("Nothing is listening there"),
            "{}",
            m.message
        );
    }

    /// Negative control: the catch-all sentence must still apply to truly unreachable kinds, or a
    /// renamed default arm would pass.
    #[test]
    fn an_eof_mid_protocol_does_not_blame_the_host_and_port_it_just_reached() {
        let m = map_sqlx_error(&sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "expected to read 5 bytes, got 0 bytes at EOF",
        )));
        assert_eq!(m.code, DbErrorCode::Network);
        assert!(
            !m.message
                .contains("Check the host, the port and the network"),
            "the one advice that cannot be right here: {}",
            m.message
        );
        assert!(m.message.contains("reachable"), "{}", m.message);
        // The three causes that actually end a connection at that point, so the sentence is
        // actionable rather than merely inoffensive.
        for cause in ["SSL", "pooler", "different service"] {
            assert!(m.message.contains(cause), "no {cause:?} in {}", m.message);
        }
        // The driver's own words survive — they are how anyone recognises this failure again.
        assert!(m.message.contains("got 0 bytes at EOF"), "{}", m.message);

        // The control: a kind we genuinely cannot place still gets the general advice.
        let other = map_sqlx_error(&sqlx::Error::Io(std::io::Error::from(
            std::io::ErrorKind::AddrNotAvailable,
        )));
        assert!(
            other
                .message
                .contains("Check the host, the port and the network"),
            "{}",
            other.message
        );
    }

    #[test]
    fn a_timed_out_io_error_says_so_rather_than_blaming_the_port() {
        let e = sqlx::Error::Io(std::io::Error::from(std::io::ErrorKind::TimedOut));
        let m = map_sqlx_error(&e);
        assert_eq!(m.code, DbErrorCode::Network);
        assert!(m.message.contains("timed out"), "{}", m.message);
    }

    #[test]
    fn a_configuration_error_is_invalid_config_not_network() {
        let e = sqlx::Error::Configuration("bad port".into());
        assert_eq!(map_sqlx_error(&e).code, DbErrorCode::InvalidConfig);
    }

    #[test]
    fn a_protocol_error_mentioning_tls_maps_to_tls_and_otherwise_to_unknown() {
        assert_eq!(
            map_sqlx_error(&sqlx::Error::Protocol("server does not support TLS".into())).code,
            DbErrorCode::Tls
        );
        assert_eq!(
            map_sqlx_error(&sqlx::Error::Protocol("unexpected message 0x5a".into())).code,
            DbErrorCode::Unknown
        );
    }

    #[test]
    fn a_pool_timeout_is_a_timeout_and_an_unmapped_variant_is_unknown() {
        assert_eq!(
            map_sqlx_error(&sqlx::Error::PoolTimedOut).code,
            DbErrorCode::Timeout
        );
        assert_eq!(
            map_sqlx_error(&sqlx::Error::RowNotFound).code,
            DbErrorCode::Unknown
        );
        assert_eq!(
            map_sqlx_error(&sqlx::Error::InvalidArgument("nope".into())).code,
            DbErrorCode::InvalidConfig
        );
    }

    /// A stub `DatabaseError` keeps the SQLSTATE table hermetic; `db_live.rs` proves the codes a
    /// real Postgres sends.
    #[derive(Debug)]
    struct StubDbError {
        sqlstate: Option<&'static str>,
        message: &'static str,
    }

    impl std::fmt::Display for StubDbError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.message)
        }
    }
    impl std::error::Error for StubDbError {}

    impl sqlx::error::DatabaseError for StubDbError {
        fn message(&self) -> &str {
            self.message
        }
        fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
            self.sqlstate.map(std::borrow::Cow::Borrowed)
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
    }

    fn db_err(sqlstate: Option<&'static str>, message: &'static str) -> sqlx::Error {
        sqlx::Error::Database(Box::new(StubDbError { sqlstate, message }))
    }

    #[test]
    fn the_sqlstate_table_maps_each_state_to_its_own_code() {
        // Last column: whether the server's words are kept. Per row because 25006 deliberately
        // drops them (`DbError::blocked`).
        let cases: &[(
            Option<&'static str>,
            &'static str,
            DbErrorCode,
            &'static str,
            bool,
        )] = &[
            (
                Some("28P01"),
                "password authentication failed for user \"agentstudio\"",
                DbErrorCode::Auth,
                "rejected those credentials",
                true,
            ),
            (
                Some("28000"),
                "no pg_hba.conf entry for host",
                DbErrorCode::Auth,
                "rejected those credentials",
                true,
            ),
            (
                Some("3D000"),
                "database \"nope\" does not exist",
                DbErrorCode::InvalidConfig,
                "does not exist on the server",
                true,
            ),
            (
                Some("42501"),
                "permission denied for table tracks",
                DbErrorCode::Auth,
                "not allowed to do this",
                true,
            ),
            (
                Some("25006"),
                "cannot execute INSERT in a read-only transaction",
                DbErrorCode::Blocked,
                "read-only",
                false,
            ),
            (
                Some("57014"),
                "canceling statement due to statement timeout",
                DbErrorCode::Timeout,
                "cancelled by the server",
                true,
            ),
            (
                Some("42601"),
                "syntax error at or near \"SELCT\"",
                DbErrorCode::Unknown,
                "SQLSTATE 42601",
                true,
            ),
            (None, "something odd", DbErrorCode::Unknown, "said:", true),
        ];
        for (state, server_msg, want_code, want_fragment, keeps_server_words) in cases {
            let mapped = map_sqlx_error(&db_err(*state, server_msg));
            assert_eq!(
                mapped.code, *want_code,
                "SQLSTATE {state:?} mapped to {:?}",
                mapped.code
            );
            assert!(
                mapped.message.contains(want_fragment),
                "SQLSTATE {state:?} message {:?} lacks {want_fragment:?}",
                mapped.message
            );
            assert_eq!(
                mapped.message.contains(server_msg),
                *keeps_server_words,
                "SQLSTATE {state:?}: the server's own words are {} in {:?}",
                if *keeps_server_words {
                    "missing"
                } else {
                    "present and must not be"
                },
                mapped.message
            );
        }
    }

    /// The DSN is the point: [`DbError::redacted`] removes only the password, so this asserts host,
    /// port, database and user are absent too.
    #[test]
    fn a_read_only_refusal_carries_none_of_the_servers_text_because_the_panel_renders_it() {
        let leaky = "cannot execute INSERT in a read-only transaction \
                     (connection postgresql://catalog_ro:hunter2@db.internal:5432/maestro)";
        let mapped = map_sqlx_error(&db_err(Some("25006"), leaky)).redacted(&["hunter2"]);
        assert_eq!(mapped.code, DbErrorCode::Blocked);
        for fragment in [
            "hunter2",
            "db.internal",
            "postgresql://",
            "catalog_ro",
            "5432",
        ] {
            assert!(
                !mapped.message.contains(fragment),
                "{fragment:?} reached a message the panel renders: {}",
                mapped.message
            );
        }
        // And it is not merely empty — it still says which read-only this could be, and what to do
        // about the half we control. (The dialog's checkbox is labelled "Read-only".)
        assert!(
            mapped.message.contains("Untick \"Read-only\""),
            "{}",
            mapped.message
        );
        assert!(mapped.message.contains("standby"), "{}", mapped.message);
    }

    /// Bans the raw `Blocked` variant outside this module so every `blocked` message goes through
    /// [`DbError::blocked`]. Catches drift, not `blocked(server_text)`; line comments are stripped
    /// before the scan.
    #[test]
    fn no_blocked_error_is_built_outside_the_constructor_that_owns_the_contract() {
        // Assembled, so this file does not contain the needle it searches for.
        let needle = concat!("DbError", "::new(", "DbErrorCode", "::Blocked");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/db");
        let mut scanned = 0usize;
        let mut offenders: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("src/db is readable") {
            let path = entry.expect("a readable dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("a readable source file");
            // Comments out, then ALL whitespace out — rustfmt is free to put the code and the
            // variant on separate lines, and it does exactly that today.
            let code: String = source
                .lines()
                .map(|line| line.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect();
            if code.contains(needle) {
                offenders.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
            scanned += 1;
        }
        // The scanner must actually have read something — an empty sweep passes vacuously.
        assert!(scanned >= 8, "only {scanned} files scanned in {dir:?}");
        assert!(
            offenders.is_empty(),
            "a `blocked` error built without the constructor that owns its contract, in {offenders:?} \
             — use `DbError::blocked` and give it prose we wrote, never a server's"
        );
    }

    /* ──────────────────────── naming the account on an auth failure ──────────────────────── */

    /// User and password are both `gazelle`: the redaction masks the server's echo of the user, so
    /// the account is named from our own field after redaction.
    #[test]
    fn an_auth_failure_names_the_account_from_our_own_field() {
        let mapped = map_sqlx_error(&db_err(
            Some("28P01"),
            "password authentication failed for user \"catalog_ro\"",
        ))
        .redacted(&["hunter2"])
        .with_auth_identity("catalog_ro", "hunter2", "db.internal:5432");
        assert_eq!(mapped.code, DbErrorCode::Auth);
        assert!(
            mapped.message.contains("as user `catalog_ro`"),
            "{}",
            mapped.message
        );
        assert!(
            mapped.message.contains("db.internal:5432"),
            "{}",
            mapped.message
        );
        // The password is still nowhere near it, and the server's own words still survive.
        assert!(!mapped.message.contains("hunter2"), "{}", mapped.message);
        assert!(
            mapped.message.contains("password authentication failed"),
            "{}",
            mapped.message
        );
    }

    /// Naming the user and never printing the password cannot both hold here, so the user is
    /// withheld and the `••••` explained.
    #[test]
    fn a_user_name_identical_to_the_password_is_explained_rather_than_printed() {
        let mapped = map_sqlx_error(&db_err(
            Some("28P01"),
            "password authentication failed for user \"gazelle\"",
        ))
        .redacted(&["gazelle"])
        .with_auth_identity("gazelle", "gazelle", "localhost:5433");
        assert!(
            !mapped.message.contains("gazelle"),
            "the password was printed: {}",
            mapped.message
        );
        assert!(
            mapped.message.contains("same string"),
            "the message must explain the mask rather than leave it looking like damage: {}",
            mapped.message
        );
        assert!(
            mapped.message.contains("localhost:5433"),
            "{}",
            mapped.message
        );
        // The redaction is untouched — the server's echo is still masked, which is the half that
        // was already correct.
        assert!(mapped.message.contains(MASK), "{}", mapped.message);
    }

    /// The negative control. Without it the reconstruction could be unconditional and
    /// this suite would not notice: a timeout, a refused socket or a read-only refusal must be left
    /// exactly as it was, because "Agent Studio tried to sign in as…" is a lie about all three.
    #[test]
    fn a_failure_that_is_not_an_auth_failure_is_left_alone() {
        for code in [
            DbErrorCode::Network,
            DbErrorCode::Timeout,
            DbErrorCode::Blocked,
            DbErrorCode::Tls,
            DbErrorCode::InvalidConfig,
        ] {
            let before = DbError::new(code, "the original sentence");
            let after =
                before
                    .clone()
                    .with_auth_identity("catalog_ro", "hunter2", "db.internal:5432");
            assert_eq!(after, before, "{code:?} was rewritten by an auth-only fix");
        }
    }

    /// A connection with no user name at all (Redis's `requirepass` shape) still gets a true
    /// sentence rather than an empty backtick pair.
    #[test]
    fn an_auth_failure_with_no_user_name_says_so() {
        let mapped = DbError::new(
            DbErrorCode::Auth,
            "WRONGPASS invalid username-password pair",
        )
        .with_auth_identity("", "hunter2", "127.0.0.1:6379");
        assert!(
            mapped.message.contains("with no user name"),
            "{}",
            mapped.message
        );
        assert!(!mapped.message.contains("``"), "{}", mapped.message);
    }

    #[test]
    fn a_mapped_database_error_that_echoes_the_password_is_scrubbed_on_the_way_out() {
        // The redaction shape, at the seam where it actually matters: the driver hands us a
        // message with the DSN in it, and what leaves is masked.
        let e = db_err(
            Some("28P01"),
            "password authentication failed for postgresql://u:s3cret-pw@h:5432/db",
        );
        let out = map_sqlx_error(&e).redacted(&["s3cret-pw"]);
        assert_eq!(out.code, DbErrorCode::Auth);
        assert!(!out.message.contains("s3cret-pw"), "{}", out.message);
        assert!(out.message.contains(MASK), "{}", out.message);
    }
}
