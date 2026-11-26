//! DB client wire types, mirroring `src/features/db/types.ts` (the source of truth). No secret is
//! expressible here (`password_ref` is `""` or `{{VAR}}`, CAs cross as [`CaSummary`]); `null` is
//! SQL NULL and `""` the empty string. Enums are `kebab-case`.

use serde::{Deserialize, Serialize};

/// The driver family an engine connects through; coarser than [`DbEngineId`] so Aurora shares its
/// upstream's driver path.
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

/// Password retention. `Forever` stores a Vault `{{VAR}}` reference; `Session`/`Never` write
/// nothing, so `db_connection_upsert` must not persist a password just because it got one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SavePassword {
    Forever,
    Session,
    Never,
}

/// How `db_query` treats the editor's text (mirrors `DbRunMode`). `Statement`, the default, refuses
/// more than one; `Script` is gated on `allowMultiStatement`. Neither is a security boundary.
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

/// A CA certificate across IPC: a summary, never the PEM, so store/load cannot become a file-read
/// oracle for the webview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaSummary {
    pub subjects: Vec<String>,
    pub count: usize,
    pub sha256: String,
}

/// A saved connection, persisted in the OS app config dir (never a workspace or `~/.claude`).
/// `id` and timestamps are set by Rust, never the UI.
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
    /// The TCP port, or `None` for the engine's default (an SRV URI must carry no port).
    /// `#[serde(default)]` lets records written before the field load as `None`.
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
    /// `mongodb+srv://` (DNS seed list, how Atlas is reached); MongoDB family only. Forbids a port
    /// ([`crate::db::engines::validate`]) and keeps the driver's implied TLS (see
    /// [`crate::db::mongo`]).
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

/// Input to `db_connection_upsert`/`db_test_connection`/`db_url_build`: the contract's draft plus
/// an optional `id` (absent or `""` creates; a whole `DbConnection` also fits). `read_only`
/// defaults to `true` when absent: an omitted field must fail safe.
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
    /// The query parameter a pasted string carried the password in (`password`, `pwd`, …), or
    /// `None` for userinfo. `db_url_parse` discards the value, so Save needs this hint to keep the
    /// placement; a URL still carrying its own parameter wins.
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

/// The shape of `db-connections.json`; `version` is bumped on schema change (see
/// [`crate::db::store`]).
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

/// Test Connection's outcome; resolves on failure. `error` is prose the dialog renders verbatim,
/// already mapped and redacted (drivers echo connection strings).
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
    /// True iff the pasted scheme was `mongodb+srv://` (mirrored as `ParsedUrl.srv`), so the dialog
    /// need not sniff it from [`Self::url`].
    pub srv: bool,
    pub database: String,
    pub user: String,
    /// True iff the pasted string carried a real password; a `{{VAR}}` reference does not count.
    /// The value is never returned or written (see [`crate::db::url::parse`]).
    pub had_password: bool,
    /// The query parameter that carried the password (`password`, `pwd`, …), or `None` for
    /// userinfo, so the paste path keeps `?password=` in place. The name only, never the value.
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

    /// Records on disk predate `Option<u16>` ports and `srv`; without `#[serde(default)]` on `srv`
    /// the whole list would load as empty.
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
