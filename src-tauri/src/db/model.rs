//! The database client's wire types — the Rust mirror of `src/features/db/types.ts`.
//!
//! `types.ts` is the **committed contract and the source of truth**; this file mirrors it
//! with `#[serde(rename_all = "camelCase")]`, exactly as `api_store.rs`'s `SavedRequest`
//! mirrors its frontend counterpart. Where the two could drift, `tests/wire_contract.rs`'s
//! sibling checks and the golden `db_engines()` snapshot in `engines.rs` are what notice.
//!
//! ## The two invariants this file exists to make structural
//!
//! 1. **No secret is expressible here.** [`DbConnection::password_ref`] is `""` or a
//!    `{{VAR}}` reference; [`DbConnection::url`] has had its credentials split out
//!    server-side before it ever reaches this struct; a CA certificate crosses as a
//!    [`CaSummary`], never as PEM. The one place a plaintext password appears in the whole
//!    module is the `password` **argument** to `db_connection_upsert` /
//!    `db_test_connection` (the two stated exceptions) and
//!    [`crate::db::engine::ResolvedConfig`], which is in-process only and has a hand-written
//!    `Debug` that redacts it.
//! 2. **`null` is SQL NULL; `""` is the empty string.** Used by the result sets, and the
//!    reason the whole design has no type-mapping dependencies, so it
//!    is stated where the types live.
//!
//! ## Serde spellings, and why each is what it is
//!
//! Every enum here is `rename_all = "kebab-case"`, which yields `"verify-ca"`,
//! `"aurora-postgres"` and — because they are single words — `"disable"`, `"postgres"`,
//! `"forever"`, `"sql"`. That is one attribute instead of five, and it cannot disagree with
//! `types.ts` for any of the values the contract actually lists. `DbErrorCode` is the one
//! multi-word set that needs it visibly (`not-found`, `invalid-config`, `secret-missing`).

use serde::{Deserialize, Serialize};

/// The driver family behind an engine — what the connect path switches on.
///
/// Note this is deliberately coarser than [`DbEngineId`]: Aurora is *wire-compatible* with
/// its upstream, so `aurora-postgres` and `postgres` share one family and therefore one
/// driver code path. Shipping "Aurora" costs two data rows, not a second driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbFamily {
    Postgres,
    Mysql,
    Clickhouse,
    Mongodb,
    Redis,
    /// DynamoDB — a family of one, and the only one with no wire protocol of its own: requests are
    /// HTTPS POSTs signed with AWS SigV4. It shares no machinery with the others, which
    /// is exactly why it is its own family rather than a preset on one of them.
    Dynamodb,
}

/// A user-selectable engine. **Nine rows, six families, five drivers** — the two Aurora rows
/// are presets on the PostgreSQL/MySQL drivers rather than drivers of their own, and DynamoDB is
/// neither (no connection string, PartiQL, SigV4 over HTTPS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbEngineId {
    Postgres,
    Mysql,
    AuroraPostgres,
    AuroraMysql,
    Clickhouse,
    Mongodb,
    Redis,
    Valkey,
    /// The "KVS" of the requirements, i.e. DynamoDB. Nine rows now, six families.
    Dynamodb,
}

/// The TLS ladder, spelled with libpq's names because they are the ones a database user has
/// already met. Each engine offers a **subset** (`EngineSpec::ssl_modes`); MongoDB has no
/// opportunistic mode, so it does not offer `Prefer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// How long a password may be retained — the dialog's "Save: Forever" control.
///
/// `Forever` writes a Vault variable and stores the `{{VAR}}` reference. `Session` and
/// `Never` write **nothing**: the typed value is used for one connect and dropped, which is
/// why `db_connection_upsert` must not persist a password just because it was handed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SavePassword {
    Forever,
    Session,
    Never,
}

/// How `db_query` treats the editor's text. Mirrors `DbRunMode` in `types.ts`.
///
/// `Statement` is the default **and the safe one**: it runs exactly one statement and refuses
/// text that holds more, so a stray semicolon cannot smuggle a second one past the user's
/// intent. `Script` runs the whole text and is gated on the connection's `allowMultiStatement`.
/// Neither is a security boundary — read-only is, and it is the server's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbRunMode {
    Statement,
    Script,
}

impl Default for DbRunMode {
    /// The conservative one. A caller that omits `mode` gets single-statement execution, for
    /// the same reason [`DbConnectionInput::read_only`] defaults to `true`: the asymmetry
    /// between one extra click and one extra statement against production is not close.
    fn default() -> Self {
        Self::Statement
    }
}

/// A CA certificate as it crosses the IPC boundary: **a summary, never the PEM**.
///
/// This is what stops the store/load pair from being an arbitrary-file-read oracle for the
/// webview: only PEM-parseable bytes can go in, and nothing comes back out but subjects, a
/// count and a fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaSummary {
    pub subjects: Vec<String>,
    pub count: usize,
    pub sha256: String,
}

/// A saved connection, as persisted and as returned to the UI.
///
/// Persisted in the OS **app config dir**, never a workspace and never `~/.claude`.
/// `id`/`created_at`/`updated_at` are Rust's: the UI hands up a
/// [`DbConnectionInput`] and never invents a `0` timestamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnection {
    /// ULID, minted in Rust on first upsert.
    pub id: String,
    pub name: String,
    pub engine: DbEngineId,
    /// Denormalised from the descriptor on save, so a reader never needs the engine table
    /// and the copy can never disagree with `engine` (Rust overwrites whatever came in).
    pub family: DbFamily,
    pub host: String,
    /// The TCP port, or **`None` for "the engine's default"**.
    ///
    /// 🔴 Optional, and this was a real bug rather than a nicety. It was a
    /// required `u16`, the dialog pre-filled the descriptor's default, and so a port was
    /// *always* stored and always emitted into the built connection string. Pasting an Atlas
    /// URI gave `mongodb://…:27017/` back — a port nobody typed, and for
    /// `mongodb+srv` a port is not merely redundant but **invalid**: SRV resolves host and port
    /// from DNS, so the URI must not carry one.
    ///
    /// `#[serde(default)]` is the backward-compatibility half: an existing record's number
    /// still loads, and a record written before the field existed loads as `None`.
    #[serde(default)]
    pub port: Option<u16>,
    /// Database / catalog / Redis db index as a string / `""`.
    pub database: String,
    pub user: String,
    /// **NEVER a secret** — `""` or a `{{VAR}}` Vault reference.
    pub password_ref: String,
    pub save_password: SavePassword,
    /// Raw URL override. Credentials are split out server-side on save, so this may
    /// contain `{{VAR}}` but never a password.
    pub url: Option<String>,
    /// `mongodb+srv://` — DNS seed-list discovery, which is how MongoDB Atlas is reached.
    ///
    /// 🔴 Exists because without it **Atlas could not be connected to at all**. SRV-ness existed
    /// only inside the transient [`crate::db::url::UrlParts`], so pasting an Atlas URI parsed
    /// correctly, filled the form, and then lost the one bit that made it work; the saved record
    /// built a plain single-host `mongodb://host:port`, which Atlas does not answer.
    ///
    /// **Forbids a port** ([`crate::db::engines::validate`] refuses the pair rather than dropping
    /// one silently) and implies TLS — the driver's own `mongodb+srv` handling switches TLS on,
    /// and this app keeps that rather than letting the SSL ladder weaken it (see
    /// [`crate::db::mongo`]). Only meaningful for the MongoDB family; other engines ignore it.
    #[serde(default)]
    pub srv: bool,
    pub ssl_mode: SslMode,
    /// Summary only; the PEM never crosses the wire.
    pub ca_summary: Option<CaSummary>,
    /// Per-engine extras. A `BTreeMap` rather than a `HashMap` **on purpose**: it makes the
    /// persisted JSON, the built connection string's query order and the golden snapshots
    /// all deterministic, which a `HashMap`'s iteration order would not.
    pub options: std::collections::BTreeMap<String, String>,

    /* ── guardrails, per connection ── */
    /// Default **true**, unconditionally, for a new connection.
    pub read_only: bool,
    pub row_limit: u32,
    pub timeout_ms: u32,
    pub allow_multi_statement: bool,

    pub created_at: u64,
    pub updated_at: u64,
}

/// What the UI hands to `db_connection_upsert` / `db_test_connection` / `db_url_build`:
/// `DbConnectionDraft` from the contract, plus an **optional `id`**.
///
/// ## Why `id` lives here rather than as a second command argument
///
/// `DbConnectionDraft` is `Omit<DbConnection, "id" | "createdAt" | "updatedAt">`, so the
/// dialog genuinely cannot name which record it is editing — and it should not have to; it
/// is handed an `initial` record by the wiring layer, which *does* know the id. Carrying it
/// as an optional field means one shape covers both calls: absent (or `""`) creates, present
/// updates, and handing a **whole `DbConnection`** back in works unchanged because serde
/// ignores the `createdAt`/`updatedAt` it does not declare. A separate `id` argument would
/// have made a full record's own `id` silently ignored, which is a worse failure than a
/// missing one.
///
/// ## Defaults, and the one that is a safety property
///
/// `read_only` defaults to **`true`** when absent. That is not tidiness: read-only
/// is the boundary, `EngineSpec.defaults` deliberately cannot express it, and a
/// serde default of `false` would mean any caller that omitted the field got a
/// **read-write** connection to production. The asymmetry is one checkbox click versus a
/// dropped table, so the absent case has to fail safe.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionInput {
    /// Absent or `""` → create. Present → update that record in place.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub engine: DbEngineId,
    /// Accepted for shape-compatibility with `DbConnection` and then **ignored** — the
    /// descriptor is the only source of `family` ("denormalised on save").
    #[serde(default)]
    pub family: Option<DbFamily>,
    pub host: String,
    /// Absent, `null` or omitted → **the engine's default port** (see [`DbConnection::port`]).
    /// `#[serde(default)]` so the dialog can send an empty port field as nothing at all.
    #[serde(default)]
    pub port: Option<u16>,
    /// `mongodb+srv://` (see [`DbConnection::srv`]). Absent → `false`, which is every engine's
    /// ordinary single-host form.
    #[serde(default)]
    pub srv: bool,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password_ref: String,
    pub save_password: SavePassword,
    #[serde(default)]
    pub url: Option<String>,
    /// WHICH query parameter the pasted string carried the password in (`"password"`,
    /// `"pwd"`, …) — `None` when it came from the `user:password@` userinfo, which is also
    /// the default and the ordinary form-driven case.
    ///
    /// 🔴 **This exists because a fresh paste's placement was otherwise unrecoverable.**
    /// `db_url_parse` is pure: it strips the credential out of the string and *discards*
    /// the value, so by the time Save arrives the `?password=` parameter is gone and
    /// [`crate::db::url::UrlParts::password_param`] — which is read off the string — is
    /// `None`. Upsert then put the `{{VAR}}` in the userinfo, and the user who pasted
    /// `?password=…` got a saved string that described their connection differently from
    /// how they wrote it.
    ///
    /// It is a HINT, not an instruction: a URL that still carries its own parameter wins,
    /// because the string in hand is better evidence than a field alongside it.
    #[serde(default)]
    pub password_param: Option<String>,
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub ca_summary: Option<CaSummary>,
    #[serde(default)]
    pub options: std::collections::BTreeMap<String, String>,
    /// Absent → `true`. See the type doc: this default is a guardrail, not a convenience.
    #[serde(default = "read_only_default")]
    pub read_only: bool,
    pub row_limit: u32,
    pub timeout_ms: u32,
    #[serde(default)]
    pub allow_multi_statement: bool,
}

/// `true` — the fail-safe default for [`DbConnectionInput::read_only`].
fn read_only_default() -> bool {
    true
}

/// The on-disk / on-the-wire shape of `db-connections.json`.
///
/// `version` is bumped when the schema changes so a mismatch is a decision rather than a
/// guess (see [`crate::db::store`] for what each direction does).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionStore {
    #[serde(default)]
    pub connections: Vec<DbConnection>,
    #[serde(default)]
    pub version: u32,
}

impl Default for DbConnectionStore {
    fn default() -> Self {
        Self {
            connections: Vec::new(),
            version: crate::db::store::STORE_VERSION,
        }
    }
}

/// What `db_connection_delete` reports, so the confirm dialog can say "…and its 12 saved
/// queries" instead of deleting silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub removed: bool,
    /// How many saved queries went with it. Named in the confirm dialog so deleting a connection
    /// cannot quietly discard someone's work.
    pub saved_queries_removed: u32,
}

/// The outcome of Test Connection. **Resolves on failure** — an unreachable server is a
/// result, not an exception, exactly like `http_send`'s "a 500 is a response" contract.
///
/// `error` is human prose (the dialog renders it verbatim), already **mapped and redacted**:
/// `sqlx` and libpq echo connection strings into error text, so a wrong password must never
/// be able to reach this field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTestResult {
    pub ok: bool,
    /// The server's own version string when reachable — the proof a real round trip
    /// happened rather than a socket merely opening.
    pub server_version: Option<String>,
    pub latency_ms: Option<u64>,
    /// Present iff `ok` is false.
    pub error: Option<String>,
}

/// What `db_url_parse` returns. On failure the command **rejects** and the form is left
/// untouched — a half-filled form after a bad paste is worse than a refusal, because the
/// user cannot tell which fields are still theirs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrl {
    pub engine: Option<DbEngineId>,
    pub family: Option<DbFamily>,
    pub host: String,
    pub port: Option<u16>,
    /// True iff the pasted scheme was `mongodb+srv://`.
    ///
    /// 🔴 **Mirrored in `types.ts` as `ParsedUrl.srv`.** Without it the *paste* path cannot recover the one fact that makes an Atlas URI
    /// work: the parser knows, `DbConnection::srv` can now hold it, and the only missing link is
    /// the dialog being told. The alternative — sniffing `mongodb+srv` out of [`Self::url`] in the
    /// frontend — is exactly the "UI guesswork about a structural fact" that the contract already
    /// rejected for [`Self::ssl_mode`].
    pub srv: bool,
    pub database: String,
    pub user: String,
    /// True iff the pasted string carried a **real** password. A `{{VAR}}` reference does
    /// not count — it is not a secret, it survives into `url`, and telling the user their
    /// reference "was taken out and stored separately" would be false.
    ///
    /// The value itself is never returned and never written: see [`crate::db::url::parse`].
    pub had_password: bool,
    /// WHICH query parameter carried the password (`"password"`, `"pwd"`, …), or `None` when
    /// it came from the `user:password@` userinfo.
    ///
    /// Returned so the *paste* path can honour the decision to keep `?password=` as part of
    /// the string. Without it the dialog rebuilds from fields and
    /// the `{{VAR}}` reappears in the userinfo — silently moving the credential to a
    /// different place in the string, which is the one real concern inside the refusal this
    /// replaced. The NAME is returned, never the value.
    pub password_param: Option<String>,
    /// The TLS mode the string asked for, or `None` when it said nothing. Parsed here rather
    /// than left as an ordinary `options` entry, because a form that shows `prefer` while
    /// the connection uses `verify-full` is a silent security divergence.
    pub ssl_mode: Option<SslMode>,
    /// The string rewritten with credentials removed, ready to display.
    pub url: String,
    /// Query parameters we did not consume, preserved verbatim rather than dropped —
    /// `authSource`, `replicaSet` and `target_session_attrs` all change behaviour.
    pub options: std::collections::BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact strings `types.ts` lists. Written out literally rather than derived from
    /// the enums, so this fails if a `rename_all` is ever "tidied" (an
    /// expectation computed from the code under test proves only plumbing).
    #[test]
    fn every_enum_serialises_to_the_spelling_the_contract_lists() {
        let pairs: &[(SslMode, &str)] = &[
            (SslMode::Disable, "\"disable\""),
            (SslMode::Prefer, "\"prefer\""),
            (SslMode::Require, "\"require\""),
            (SslMode::VerifyCa, "\"verify-ca\""),
            (SslMode::VerifyFull, "\"verify-full\""),
        ];
        for (v, want) in pairs {
            assert_eq!(&serde_json::to_string(v).unwrap(), want);
        }

        let engines: &[(DbEngineId, &str)] = &[
            (DbEngineId::Postgres, "\"postgres\""),
            (DbEngineId::Mysql, "\"mysql\""),
            (DbEngineId::AuroraPostgres, "\"aurora-postgres\""),
            (DbEngineId::AuroraMysql, "\"aurora-mysql\""),
            (DbEngineId::Clickhouse, "\"clickhouse\""),
            (DbEngineId::Mongodb, "\"mongodb\""),
            (DbEngineId::Redis, "\"redis\""),
            (DbEngineId::Valkey, "\"valkey\""),
        ];
        for (v, want) in engines {
            assert_eq!(&serde_json::to_string(v).unwrap(), want);
        }

        let families: &[(DbFamily, &str)] = &[
            (DbFamily::Postgres, "\"postgres\""),
            (DbFamily::Mysql, "\"mysql\""),
            (DbFamily::Clickhouse, "\"clickhouse\""),
            (DbFamily::Mongodb, "\"mongodb\""),
            (DbFamily::Redis, "\"redis\""),
        ];
        for (v, want) in families {
            assert_eq!(&serde_json::to_string(v).unwrap(), want);
        }

        let saves: &[(SavePassword, &str)] = &[
            (SavePassword::Forever, "\"forever\""),
            (SavePassword::Session, "\"session\""),
            (SavePassword::Never, "\"never\""),
        ];
        for (v, want) in saves {
            assert_eq!(&serde_json::to_string(v).unwrap(), want);
        }
    }

    #[test]
    fn a_connection_serialises_camel_case_and_never_snake_case() {
        let c = DbConnection {
            id: "01J".into(),
            name: "Prod Postgres".into(),
            engine: DbEngineId::Postgres,
            family: DbFamily::Postgres,
            host: "db.internal".into(),
            port: Some(5432),
            database: "maestro".into(),
            user: "catalog_ro".into(),
            password_ref: "{{PG_PASSWORD}}".into(),
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
            updated_at: 2,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(
            json.contains(r#""port":5432"#),
            "an explicit port must serialise as a number, not as a wrapper: {json}"
        );
        assert!(
            json.contains(r#""srv":false"#),
            "`srv` must be on the wire even when false — the dialog reads it: {json}"
        );
        for key in [
            "passwordRef",
            "savePassword",
            "sslMode",
            "caSummary",
            "readOnly",
            "rowLimit",
            "timeoutMs",
            "allowMultiStatement",
            "createdAt",
            "updatedAt",
        ] {
            assert!(json.contains(key), "missing camelCase `{key}` in {json}");
        }
        for key in [
            "password_ref",
            "save_password",
            "ssl_mode",
            "ca_summary",
            "read_only",
            "row_limit",
            "timeout_ms",
            "allow_multi_statement",
            "created_at",
            "updated_at",
        ] {
            assert!(!json.contains(key), "leaked snake_case `{key}` in {json}");
        }
    }

    #[test]
    fn an_input_that_omits_read_only_defaults_to_true() {
        // The safety default, asserted at the serde boundary because that is where a caller
        // that "forgot" the field lands. A `false` here would be a read-write production
        // connection nobody asked for.
        let input: DbConnectionInput = serde_json::from_str(
            r#"{"name":"x","engine":"postgres","host":"h","port":5432,
                "savePassword":"never","sslMode":"prefer","rowLimit":500,"timeoutMs":30000}"#,
        )
        .expect("a minimal draft must deserialise");
        assert!(input.read_only, "an absent readOnly must mean read-only");
        assert!(
            !input.allow_multi_statement,
            "and multi-statement stays off"
        );
        assert_eq!(input.id, None);
        assert_eq!(input.password_ref, "");
        assert!(input.options.is_empty());

        // An EXPLICIT false is still honoured — the user can untick the box.
        let off: DbConnectionInput = serde_json::from_str(
            r#"{"name":"x","engine":"postgres","host":"h","port":5432,"readOnly":false,
                "savePassword":"never","sslMode":"prefer","rowLimit":500,"timeoutMs":30000}"#,
        )
        .unwrap();
        assert!(!off.read_only);
    }

    #[test]
    fn a_whole_db_connection_deserialises_as_an_input_carrying_its_id() {
        // The wiring contract: handing a full record back in must UPDATE it, not create a
        // duplicate. `createdAt`/`updatedAt` are undeclared on the input and simply ignored.
        let full = r#"{"id":"01JEXISTING","name":"x","engine":"aurora-mysql","family":"mysql",
            "host":"h","port":3306,"database":"d","user":"u","passwordRef":"{{V}}",
            "savePassword":"forever","url":null,"sslMode":"require","caSummary":null,
            "options":{"charset":"utf8mb4"},"readOnly":true,"rowLimit":500,
            "timeoutMs":30000,"allowMultiStatement":false,"createdAt":7,"updatedAt":8}"#;
        let input: DbConnectionInput = serde_json::from_str(full).unwrap();
        assert_eq!(input.id.as_deref(), Some("01JEXISTING"));
        assert_eq!(input.engine, DbEngineId::AuroraMysql);
        assert_eq!(
            input.options.get("charset").map(String::as_str),
            Some("utf8mb4")
        );
        // The previous shape: a bare number where an `Option<u16>` now lives, and no `srv`
        // key at all. Both must land on their old meanings.
        assert_eq!(input.port, Some(3306));
        assert!(!input.srv);
    }

    /// 🔴 **Backward compatibility, at the serde boundary.** The port went from `u16` to
    /// `Option<u16>` and `srv` did not exist, so every record already on a user's disk is written
    /// in the old shape. Reading one must yield the *same* connection it always was — a number
    /// stays a number, and an absent `srv` is `false`, not "unknown".
    ///
    /// This is the `SavedRequest` protocol-tail rule the contract's header states, asserted rather
    /// than assumed: without `#[serde(default)]` on `srv` this fails with
    /// `missing field \`srv\``, and the whole connection list would have loaded as
    /// [`DbConnectionStore::default`] — i.e. every saved connection silently gone.
    #[test]
    fn a_record_written_before_this_change_still_loads_with_its_port_and_no_srv() {
        // Verbatim the old on-disk shape, keys and all. Written out as a literal on purpose: a
        // fixture generated by today's serialiser could not express the old shape at all.
        let old = r#"{"connections":[{"id":"01JOLD","name":"Prod Postgres",
            "engine":"postgres","family":"postgres","host":"db.internal","port":5432,
            "database":"maestro","user":"ro","passwordRef":"{{PG_PASSWORD}}",
            "savePassword":"forever","url":null,"sslMode":"prefer","caSummary":null,
            "options":{},"readOnly":true,"rowLimit":500,"timeoutMs":30000,
            "allowMultiStatement":false,"createdAt":7,"updatedAt":8}],"version":1}"#;
        let store: DbConnectionStore =
            serde_json::from_str(old).expect("an existing file must still parse");
        let c = &store.connections[0];
        assert_eq!(c.port, Some(5432), "an existing number must survive");
        assert!(!c.srv, "an absent `srv` is the ordinary single-host form");
        assert_eq!(c.id, "01JOLD");
    }

    /// The new states, both directions. `null` and *absent* both mean "the engine's default", and
    /// an `srv` record round-trips — which is the bit that made Atlas unreachable when the record
    /// could not carry it.
    #[test]
    fn a_null_port_an_absent_port_and_an_srv_flag_all_survive_a_round_trip() {
        let srv_record = r#"{"connections":[{"id":"01JATLAS","name":"Atlas",
            "engine":"mongodb","family":"mongodb","host":"cluster0.abcde.mongodb.net",
            "port":null,"database":"maestro","user":"ro","passwordRef":"{{M}}",
            "savePassword":"forever","url":"mongodb+srv://ro:{{M}}@cluster0.abcde.mongodb.net/maestro",
            "srv":true,"sslMode":"verify-full","caSummary":null,"options":{"authSource":"admin"},
            "readOnly":true,"rowLimit":500,"timeoutMs":30000,"allowMultiStatement":false,
            "createdAt":1,"updatedAt":2}],"version":1}"#;
        let store: DbConnectionStore = serde_json::from_str(srv_record).expect("parses");
        let c = store.connections[0].clone();
        assert_eq!(c.port, None, "`null` is the absent port");
        assert!(
            c.srv,
            "the flag that makes Atlas reachable must survive a load"
        );

        // …and back out again, in the spelling `types.ts` declares (`number | null`).
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains(r#""port":null"#), "{json}");
        assert!(json.contains(r#""srv":true"#), "{json}");
        // A second pass, so this is a fixed point rather than a one-way read.
        let again: DbConnection = serde_json::from_str(&json).unwrap();
        assert_eq!(again, c);

        // An input that simply omits the field is the dialog's empty port box.
        let omitted: DbConnectionInput = serde_json::from_str(
            r#"{"name":"x","engine":"postgres","host":"h","savePassword":"never",
                "sslMode":"prefer","rowLimit":500,"timeoutMs":30000}"#,
        )
        .expect("an omitted port must be accepted, not a missing-field error");
        assert_eq!(omitted.port, None);
        assert!(!omitted.srv);
    }

    #[test]
    fn a_parsed_url_serialises_the_fields_the_dialog_reads() {
        let p = ParsedUrl {
            engine: Some(DbEngineId::Postgres),
            family: Some(DbFamily::Postgres),
            host: "h".into(),
            port: Some(5432),
            srv: false,
            database: "d".into(),
            user: "u".into(),
            had_password: true,
            // A query-string credential, so this serialisation test also pins the field the
            // dialog needs in order to put the credential back where the user typed it.
            password_param: Some("password".into()),
            ssl_mode: Some(SslMode::VerifyFull),
            url: "postgresql://u@h:5432/d".into(),
            options: Default::default(),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"hadPassword\":true"), "{json}");
        assert!(json.contains("\"passwordParam\":\"password\""), "{json}");
        assert!(json.contains("\"sslMode\":\"verify-full\""), "{json}");
        assert!(
            !json.contains("password\":\""),
            "no password value may appear: {json}"
        );
    }

    #[test]
    fn a_delete_report_is_camel_case() {
        let json = serde_json::to_string(&DeleteReport {
            removed: true,
            saved_queries_removed: 0,
        })
        .unwrap();
        assert_eq!(json, r#"{"removed":true,"savedQueriesRemoved":0}"#);
    }

    #[test]
    fn an_empty_store_carries_the_current_version() {
        let s = DbConnectionStore::default();
        assert!(s.connections.is_empty());
        assert_eq!(s.version, crate::db::store::STORE_VERSION);
    }
}
