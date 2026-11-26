//! Connection strings: build, parse, and the server-side credential split both share (userinfo
//! or a denylisted query parameter, kept under its own name). Structure is hand-rolled: `url`
//! mangles non-special-scheme hosts. No IDNA; one credential per string; Aurora reads as its base.

use std::collections::BTreeMap;

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

use crate::db::engines::{self, EngineSpec};
use crate::db::error::DbError;
use crate::db::model::{DbConnectionInput, DbEngineId, DbFamily, ParsedUrl, SslMode};
use crate::db::secret;

/// RFC 3986 unreserved only; encoding `:` too makes the user/password split unambiguous for any
/// value, so the hostile round trip is total.
const USERINFO: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The path segment (the database name) — same strict set, so a database called `a/b` or
/// `a?b` survives.
const PATH_SEGMENT: &AsciiSet = USERINFO;

/// Query keys and values: unreserved plus `,` (common, e.g. `search_path=a,b`); `+` is encoded so
/// form-urlencoded readers do not read a space.
const QUERY: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~')
    .remove(b',');

/// Percent-encode for userinfo. `pub` for [`secret::redact`]: a driver echoing a DSN has already
/// encoded the password.
pub fn encode_userinfo(s: &str) -> String {
    utf8_percent_encode(s, USERINFO).to_string()
}

fn encode_path(s: &str) -> String {
    utf8_percent_encode(s, PATH_SEGMENT).to_string()
}

fn encode_query(s: &str) -> String {
    utf8_percent_encode(s, QUERY).to_string()
}

/// Percent-decode, requiring valid UTF-8. A component that is not UTF-8 is a paste error we
/// must name rather than lossily accept — a database name silently rewritten with U+FFFD would
/// fail to connect for a reason nobody could see.
fn decode(s: &str, what: &str) -> Result<String, DbError> {
    percent_decode_str(s)
        .decode_utf8()
        .map(|c| c.into_owned())
        .map_err(|_| {
            DbError::invalid_config(format!(
                "The {what} in that string is not valid UTF-8 once percent-decoding is undone."
            ))
        })
}

/* ────────────────────────── the credential denylist ────────────────────────── */

/// Query-parameter names whose value is a credential (sent to the Vault). Exact match after
/// lowercasing, so `authSource` survives; an unknown vendor secret parameter is stored as typed.
pub fn is_credential_param(lower_key: &str) -> bool {
    matches!(
        lower_key,
        "password"
            | "passwd"
            | "pwd"
            | "pass"
            | "auth"
            | "authtoken"
            | "auth_token"
            | "token"
            | "secret"
            | "apikey"
            | "api_key"
            | "api-key"
            | "accesskey"
            | "access_key"
            | "credentials"
    )
}

/// The query parameters carrying a family's SSL mode, refused as `options` keys by
/// [`engines::validate`] so the string cannot contradict the SSL control.
pub fn family_ssl_param_names(family: DbFamily) -> &'static [&'static str] {
    match family {
        DbFamily::Postgres => &["sslmode"],
        DbFamily::Mysql => &["ssl-mode", "sslmode"],
        DbFamily::Clickhouse => &["sslmode", "secure"],
        DbFamily::Redis => &["sslmode"],
        // DynamoDB has no connection string; `sslMode` exists only so DynamoDB Local can use plain
        // HTTP.
        DbFamily::Dynamodb => &[],
        DbFamily::Mongodb => &[
            "tls",
            "ssl",
            "tlsAllowInvalidCertificates",
            "tlsAllowInvalidHostnames",
            "tlsInsecure",
        ],
    }
}

/* ────────────────────────────── the intermediate form ────────────────────────────── */

/// Where a password stands in a connection string. The three states are genuinely different
/// and collapsing any two of them is how this feature would leak: a [`Self::Ref`] is **public**
/// (it survives into the stored URL and onto a clipboard), a [`Self::Value`] is radioactive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordSlot {
    None,
    Ref(String),
    Value(String),
}

/// Everything a connection string carries, after splitting and before rendering. One shape for
/// both directions, so `build` and `parse` cannot disagree about what a string means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlParts {
    pub engine: DbEngineId,
    pub family: DbFamily,
    /// `mongodb+srv://`. Preserved through a parse→render so an Atlas URI stays an Atlas URI.
    pub srv: bool,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub user: String,
    /// The one credential this string carries, wherever it carried it. [`Self::password_param`]
    /// says where.
    pub password: PasswordSlot,
    /// The query parameter that carried the password (`None` = userinfo), kept verbatim (`?pass=`
    /// is not `?password=`) so [`render_with`] puts the `{{VAR}}` back in place.
    pub password_param: Option<String>,
    pub ssl_mode: Option<SslMode>,
    /// Whether the *scheme* implied TLS (`rediss`, `https`). Kept so a render reproduces the
    /// scheme faithfully even when no explicit mode parameter was present.
    pub scheme_tls: Option<bool>,
    pub options: BTreeMap<String, String>,
}

/* ──────────────────────────────────── build ──────────────────────────────────── */

/// Render a draft into its engine's canonical string, explicit about every default except the
/// port (absent renders as none; SRV forbids one). Refuses a literal `password_ref`, so the output
/// is safe to copy.
pub fn build(input: &DbConnectionInput) -> Result<String, DbError> {
    let spec = engines::require_spec(input.engine)?;
    let parts = parts_from_input(spec, input)?;
    render(&parts)
}

fn parts_from_input(spec: &EngineSpec, input: &DbConnectionInput) -> Result<UrlParts, DbError> {
    let host = normalise_host(&input.host)?;
    // `None` is legal and means "the engine's default" — the string simply omits `:port`, exactly
    // as `psql` and every driver read an absent port. `Some(0)` cannot come from the dialog (the
    // field is empty or a number) but can from a hand-built IPC call, and 0 is not a port.
    if input.port == Some(0) {
        return Err(DbError::invalid_config(
            "Port must be a whole number from 1 to 65535.",
        ));
    }
    // Also refused here: `db_url_build` skips the validator, and its output is what gets copied.
    reject_port_with_srv(input.srv, input.port)?;
    if !spec.ssl_modes.contains(&input.ssl_mode) {
        return Err(DbError::invalid_config(format!(
            "{} does not offer SSL mode `{}`.",
            spec.label,
            engines::ssl_mode_name(input.ssl_mode)
        )));
    }
    let password = if input.password_ref.is_empty() {
        PasswordSlot::None
    } else if secret::is_ref(&input.password_ref) {
        PasswordSlot::Ref(input.password_ref.trim().to_string())
    } else {
        // Defence in depth against the worst outcome in this module: a real password rendered
        // into the string behind the *Copy connection string* button.
        return Err(DbError::invalid_config(
            "`passwordRef` must be empty or a `{{VAR}}` Vault reference. A connection string \
             this app builds never contains a password.",
        ));
    };
    Ok(UrlParts {
        engine: input.engine,
        family: spec.family,
        // Carried from the record, no longer hardcoded `false`. That constant made
        // a saved Atlas connection render as `mongodb://`, which Atlas does not answer.
        srv: input.srv,
        host,
        port: input.port,
        database: if spec.database_label.is_none() {
            String::new()
        } else {
            input.database.trim().to_string()
        },
        user: if spec.supports_user {
            input.user.trim().to_string()
        } else {
            String::new()
        },
        password,
        // A form-driven string always writes the userinfo: the dialog has a password *field*,
        // not a "which parameter should the password go in" control. A query-borne credential
        // only ever arrives from a paste, and only [`parse_parts`] can see one.
        password_param: None,
        ssl_mode: Some(input.ssl_mode),
        scheme_tls: None,
        options: input.options.clone(),
    })
}

/// A port and `srv` are mutually exclusive (SRV takes both from DNS), refused rather than dropping
/// one. Shared by [`parts_from_input`], [`render_with`] and [`crate::db::engines::validate`].
pub fn reject_port_with_srv(srv: bool, port: Option<u16>) -> Result<(), DbError> {
    match (srv, port) {
        (true, Some(port)) => Err(DbError::invalid_config(format!(
            "A `mongodb+srv://` connection cannot have a port, and this one has `{port}`. SRV \
             discovery reads the host and the port out of DNS, so the port must be empty — or \
             turn SRV off and use a plain `mongodb://` host and port."
        ))),
        _ => Ok(()),
    }
}

/// Refuse `srv` with `sslMode: disable`: the driver forces TLS for SRV, so the control would lie.
/// `require` stays allowed; SRV only makes it stricter.
pub fn reject_disabled_tls_with_srv(srv: bool, ssl_mode: SslMode) -> Result<(), DbError> {
    if srv && matches!(ssl_mode, SslMode::Disable) {
        return Err(DbError::invalid_config(
            "A `mongodb+srv://` connection is always encrypted — SRV discovery implies TLS in the \
             driver, so `disable` cannot be honoured. Choose `require` (or stricter), or turn SRV \
             off to connect to a plain host without TLS.",
        ));
    }
    Ok(())
}

/// Trim, drop IPv6 brackets (re-added on render), ASCII-lowercase (non-ASCII untouched: no IDNA),
/// and refuse characters that would change what the string means.
fn normalise_host(raw: &str) -> Result<String, DbError> {
    let mut host = raw.trim();
    if host.starts_with('[') && host.ends_with(']') && host.len() > 2 {
        host = &host[1..host.len() - 1];
    }
    if host.is_empty() {
        return Err(DbError::invalid_config("Host is required."));
    }
    for bad in ['/', '?', '#', '@', '[', ']', ' ', '\t', '\n'] {
        if host.contains(bad) {
            return Err(DbError::invalid_config(format!(
                "The host cannot contain `{}`.",
                bad.escape_debug()
            )));
        }
    }
    Ok(host.to_ascii_lowercase())
}

/// The scheme a rendered string uses, from the family since Redis's depends on the TLS mode; a
/// routing test keeps it within `EngineSpec::url_schemes`.
fn scheme_for(
    family: DbFamily,
    srv: bool,
    ssl: Option<SslMode>,
    scheme_tls: Option<bool>,
) -> &'static str {
    match family {
        DbFamily::Postgres => "postgresql",
        DbFamily::Mysql => "mysql",
        DbFamily::Clickhouse => "clickhouse",
        // No `dynamodb://` exists and no caller reaches this; the empty string makes a stray call
        // visible.
        DbFamily::Dynamodb => "",
        DbFamily::Mongodb => {
            if srv {
                "mongodb+srv"
            } else {
                "mongodb"
            }
        }
        DbFamily::Redis => {
            let tls = match ssl {
                Some(SslMode::Disable) => false,
                Some(_) => true,
                None => scheme_tls.unwrap_or(false),
            };
            if tls {
                "rediss"
            } else {
                "redis"
            }
        }
    }
}

/// Render `parts` with its own password slot.
pub fn render(parts: &UrlParts) -> Result<String, DbError> {
    render_with(parts, &parts.password)
}

/// Render `parts` with `password` in the slot [`UrlParts::password_param`] names (userinfo or that
/// parameter); one walk for the display, stored and canonical strings.
pub fn render_with(parts: &UrlParts, password: &PasswordSlot) -> Result<String, DbError> {
    if parts.host.is_empty() {
        return Err(DbError::invalid_config("Host is required."));
    }
    // The one place a string is produced, so no caller can render an SRV URI with a port.
    reject_port_with_srv(parts.srv, parts.port)?;
    let scheme = scheme_for(parts.family, parts.srv, parts.ssl_mode, parts.scheme_tls);
    let mut out = format!("{scheme}://");

    let mut userinfo = false;
    if !parts.user.is_empty() {
        out.push_str(&encode_userinfo(&parts.user));
        userinfo = true;
    }
    // Nothing in the userinfo when the credential belongs to a query parameter: writing it in
    // both places would send the server two passwords, and writing it in the other one would
    // move it.
    let userinfo_password = match parts.password_param {
        Some(_) => &PasswordSlot::None,
        None => password,
    };
    match userinfo_password {
        PasswordSlot::None => {}
        // `{{VAR}}` is written verbatim so it stays readable; parsing decodes either form.
        PasswordSlot::Ref(r) => {
            out.push(':');
            out.push_str(r);
            userinfo = true;
        }
        PasswordSlot::Value(v) => {
            out.push(':');
            out.push_str(&encode_userinfo(v));
            userinfo = true;
        }
    }
    if userinfo {
        out.push('@');
    }

    if parts.host.contains(':') {
        // An IPv6 literal. Bracketed here rather than stored bracketed, so `host` is always
        // just the host.
        out.push('[');
        out.push_str(&parts.host);
        out.push(']');
    } else {
        out.push_str(&parts.host);
    }
    if let Some(port) = parts.port {
        out.push(':');
        out.push_str(&port.to_string());
    }

    out.push('/');
    if !parts.database.is_empty() {
        out.push_str(&encode_path(&parts.database));
    }

    // SSL parameters first, in their fixed order, then the options sorted by key (a `BTreeMap`
    // is already sorted). Deterministic, which is what makes the string-stability property
    // `build(parse(build(c))) == build(c)` provable rather than probable.
    let mut pairs: Vec<(String, String)> = Vec::new();
    if let Some(mode) = parts.ssl_mode {
        pairs.extend(ssl_params(parts.family, mode)?);
    }
    for (k, v) in &parts.options {
        pairs.push((k.clone(), v.clone()));
    }
    let mut encoded: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (encode_query(k), encode_query(v)))
        .collect();
    // The credential parameter, **last** and at a fixed position, so this render is
    // deterministic for the same reason the rest of the query is. Its name is `parts`'s, never a
    // canonical one (see [`UrlParts::password_param`]).
    if let Some(name) = &parts.password_param {
        match password {
            // Removed, not emitted empty: a `password=` left behind still tells a reader there
            // was one, and a driver would still act on it.
            PasswordSlot::None => {}
            // Verbatim, for exactly the reason the userinfo arm above gives — a query value is
            // no different, and `?password=%7B%7BPG_PASSWORD%7D%7D` shows a human nothing.
            PasswordSlot::Ref(r) => encoded.push((encode_query(name), r.clone())),
            PasswordSlot::Value(v) => encoded.push((encode_query(name), encode_query(v))),
        }
    }
    if !encoded.is_empty() {
        out.push('?');
        for (i, (k, v)) in encoded.iter().enumerate() {
            if i > 0 {
                out.push('&');
            }
            out.push_str(k);
            out.push('=');
            out.push_str(v);
        }
    }
    Ok(out)
}

/// The SSL-mode query parameters for `family`, spelled as its own tooling expects; ClickHouse
/// borrows libpq's (and [`take_ssl_mode`] also accepts `secure=true`).
fn ssl_params(family: DbFamily, mode: SslMode) -> Result<Vec<(String, String)>, DbError> {
    let pair = |k: &str, v: &str| (k.to_string(), v.to_string());
    Ok(match family {
        DbFamily::Postgres | DbFamily::Clickhouse => {
            vec![pair("sslmode", engines::ssl_mode_name(mode))]
        }
        DbFamily::Mysql => vec![pair("ssl-mode", mysql_ssl_name(mode))],
        // No connection string to put a parameter in — see `canonical_scheme`'s DynamoDB arm.
        DbFamily::Dynamodb => Vec::new(),
        // Redis puts TLS in the scheme (`rediss`), which every Redis tool understands. The
        // parameter only appears for the two modes the scheme cannot distinguish, so the plain
        // `rediss://` stays the strict one.
        DbFamily::Redis => match mode {
            SslMode::Disable | SslMode::VerifyFull => vec![],
            other => vec![pair("sslmode", engines::ssl_mode_name(other))],
        },
        // Mongo has no single mode parameter; it has `tls` plus two "and don't check this"
        // escape hatches. The mapping is chosen to be **invertible**, which is what lets the
        // round-trip property include MongoDB at all.
        DbFamily::Mongodb => {
            match mode {
                SslMode::Disable => vec![pair("tls", "false")],
                SslMode::Require => vec![
                    pair("tls", "true"),
                    pair("tlsAllowInvalidCertificates", "true"),
                ],
                SslMode::VerifyCa => vec![
                    pair("tls", "true"),
                    pair("tlsAllowInvalidHostnames", "true"),
                ],
                SslMode::VerifyFull => vec![pair("tls", "true")],
                SslMode::Prefer => return Err(DbError::invalid_config(
                    "MongoDB has no opportunistic TLS mode, so `prefer` cannot be written into \
                     a MongoDB connection string.",
                )),
            }
        }
    })
}

/// MySQL's own spelling of the ladder (`--ssl-mode` / the connector URI parameter).
fn mysql_ssl_name(mode: SslMode) -> &'static str {
    match mode {
        SslMode::Disable => "DISABLED",
        SslMode::Prefer => "PREFERRED",
        SslMode::Require => "REQUIRED",
        SslMode::VerifyCa => "VERIFY_CA",
        SslMode::VerifyFull => "VERIFY_IDENTITY",
    }
}

/* ──────────────────────────────────── parse ──────────────────────────────────── */

/// Engine, family, scheme-implied TLS and SRV-ness from a scheme. Returns the family's base engine
/// (Aurora is indistinguishable); the dialog asks rather than switching drivers.
fn engine_for_scheme(scheme: &str) -> Option<(DbEngineId, DbFamily, Option<bool>, bool)> {
    Some(match scheme {
        "postgres" | "postgresql" => (DbEngineId::Postgres, DbFamily::Postgres, None, false),
        "mysql" | "mariadb" => (DbEngineId::Mysql, DbFamily::Mysql, None, false),
        "mongodb" => (DbEngineId::Mongodb, DbFamily::Mongodb, None, false),
        "mongodb+srv" => (DbEngineId::Mongodb, DbFamily::Mongodb, Some(true), true),
        "redis" | "valkey" => (DbEngineId::Redis, DbFamily::Redis, Some(false), false),
        "rediss" | "valkeys" => (DbEngineId::Redis, DbFamily::Redis, Some(true), false),
        "clickhouse" | "http" => (
            DbEngineId::Clickhouse,
            DbFamily::Clickhouse,
            Some(false),
            false,
        ),
        "clickhouses" | "https" => (
            DbEngineId::Clickhouse,
            DbFamily::Clickhouse,
            Some(true),
            false,
        ),
        _ => return None,
    })
}

/// The error for a scheme we do not speak. Named engines get named answers — *"Agent Studio has
/// no SQL Server driver"* is actionable and *"invalid URL"* is not.
fn unknown_scheme(scheme: &str) -> DbError {
    let named = match scheme {
        "tcp" => Some(
            "`tcp://` is ClickHouse's native protocol. Agent Studio connects over HTTP — use \
             port 8123, or 8443 with `sslmode=require`."
                .to_string(),
        ),
        "sqlserver" | "mssql" | "jdbc" => {
            Some("Agent Studio has no SQL Server driver.".to_string())
        }
        "oracle" => Some("Agent Studio has no Oracle driver.".to_string()),
        "sqlite" | "file" => Some("Agent Studio has no SQLite driver.".to_string()),
        "cassandra" => Some("Agent Studio has no Cassandra driver.".to_string()),
        "snowflake" => Some("Agent Studio has no Snowflake driver.".to_string()),
        "dynamodb" => Some("Agent Studio has no DynamoDB driver.".to_string()),
        _ => None,
    };
    DbError::invalid_config(named.unwrap_or_else(|| {
        format!("`{scheme}://` is not a connection string Agent Studio understands.")
    }))
}

/// Split a connection string into its parts. The single walk behind [`parse`] and
/// [`split_url_credentials`].
pub fn parse_parts(text: &str) -> Result<UrlParts, DbError> {
    let s = text.trim();
    if s.is_empty() {
        return Err(DbError::invalid_config("Enter a connection string."));
    }
    let Some(sep) = s.find("://") else {
        return Err(DbError::invalid_config(
            "No scheme — a connection string starts with e.g. `postgresql://`.",
        ));
    };
    let scheme_raw = &s[..sep];
    if scheme_raw.is_empty() {
        return Err(DbError::invalid_config(
            "No scheme — a connection string starts with e.g. `postgresql://`.",
        ));
    }
    let scheme = scheme_raw.to_ascii_lowercase();
    let (engine, family, scheme_tls, srv) =
        engine_for_scheme(&scheme).ok_or_else(|| unknown_scheme(&scheme))?;

    let rest = &s[sep + 3..];
    if let Some(i) = rest.find('#') {
        // Not silently dropped: a fragment carries meaning in at least one real form
        // (`rediss://h#insecure`) and losing it would change the TLS posture without saying so.
        return Err(DbError::invalid_config(format!(
            "`{}` is a URL fragment, which is not part of a connection string. Set the SSL \
             mode with the SSL control instead.",
            &rest[i..]
        )));
    }

    let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..auth_end];
    let tail = &rest[auth_end..];

    // Split at the LAST `@`: a password may legitimately contain an unencoded `@` in a
    // hand-written string, and the host may not.
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(i) => (Some(&authority[..i]), &authority[i + 1..]),
        None => (None, authority),
    };

    let (user, password) = match userinfo {
        None => (String::new(), PasswordSlot::None),
        Some(ui) => match ui.find(':') {
            Some(i) => {
                let user = decode(&ui[..i], "user")?;
                let raw = decode(&ui[i + 1..], "password")?;
                let slot = if raw.is_empty() {
                    PasswordSlot::None
                } else if secret::is_ref(&raw) {
                    PasswordSlot::Ref(raw)
                } else {
                    PasswordSlot::Value(raw)
                };
                (user, slot)
            }
            None => (decode(ui, "user")?, PasswordSlot::None),
        },
    };

    let (host, port) = split_host_port(hostport, family, srv)?;

    let (path, query) = match tail.find('?') {
        Some(i) => (&tail[..i], Some(&tail[i + 1..])),
        None => (tail, None),
    };
    let database = match path.strip_prefix('/') {
        None => String::new(),     // no path at all
        Some("") => String::new(), // a bare trailing `/`
        Some(p) => {
            if p.contains('/') {
                return Err(DbError::invalid_config(format!(
                    "Expected one path segment (the database), but got `{p}`."
                )));
            }
            decode(p, "database")?
        }
    };

    let mut options: BTreeMap<String, String> = BTreeMap::new();
    if let Some(q) = query {
        for pair in q.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = match pair.find('=') {
                Some(i) => (&pair[..i], &pair[i + 1..]),
                None => (pair, ""),
            };
            let key = decode(k, "parameter name")?;
            if key.is_empty() {
                continue;
            }
            options.insert(key, decode(v, "parameter value")?);
        }
    }

    // The query-string denylist, applied before anything else looks at the options, so a
    // secret cannot reach `DbConnection.options` even transiently.
    let mut query_credentials: Vec<(String, String)> = Vec::new();
    for key in options.keys().cloned().collect::<Vec<_>>() {
        if is_credential_param(&key.to_ascii_lowercase()) {
            if let Some(value) = options.remove(&key) {
                // An empty credential parameter is no credential (libpq reads it as no password);
                // counting it would move a typed password into it on the next save.
                if !value.is_empty() {
                    query_credentials.push((key, value));
                }
            }
        }
    }

    // One credential per string (see the module doc). Refused, never resolved by precedence:
    // this record has one password field and one Vault reference, so keeping one of two and
    // dropping the other is the silent-secret-loss outcome the whole area exists to prevent.
    let userinfo_credential = !matches!(password, PasswordSlot::None);
    if query_credentials.len() > 1 || (userinfo_credential && !query_credentials.is_empty()) {
        let mut places: Vec<String> = query_credentials
            .iter()
            .map(|(k, _)| format!("`{k}=`"))
            .collect();
        if userinfo_credential {
            places.insert(0, "the `user:password@` part".to_string());
        }
        return Err(DbError::invalid_config(format!(
            "That connection string carries a password in {} places at once ({}). A connection \
             has one password, so keep the one you want and remove the rest — Agent Studio will \
             not choose for you and will not drop one silently.",
            places.len(),
            places.join(", ")
        )));
    }

    // A query-borne credential is the *same* credential, in a different place: it goes into the
    // one password slot, and `password_param` records where to put it back.
    let (password, password_param) = match query_credentials.pop() {
        Some((key, value)) => {
            let slot = if secret::is_ref(&value) {
                PasswordSlot::Ref(value)
            } else {
                PasswordSlot::Value(value)
            };
            (slot, Some(key))
        }
        None => (password, None),
    };

    let ssl_mode = take_ssl_mode(family, &mut options, scheme_tls)?;

    Ok(UrlParts {
        engine,
        family,
        srv,
        host,
        port,
        database,
        user,
        password,
        password_param,
        ssl_mode,
        scheme_tls,
        options,
    })
}

fn split_host_port(s: &str, family: DbFamily, srv: bool) -> Result<(String, Option<u16>), DbError> {
    let (host, port) = split_host_port_inner(s, family, srv)?;
    // A pasted SRV URI with a port is refused, not repaired (the driver refuses it too); own
    // message, since the fix is to edit the string.
    if let (true, Some(port)) = (srv, port) {
        return Err(DbError::invalid_config(format!(
            "`mongodb+srv://` must not carry a port, and this one has `:{port}`. SRV discovery \
             reads the host and the port from DNS — remove the port, or use `mongodb://` to name a \
             host and port yourself."
        )));
    }
    Ok((host, port))
}

fn split_host_port_inner(
    s: &str,
    family: DbFamily,
    srv: bool,
) -> Result<(String, Option<u16>), DbError> {
    if s.is_empty() {
        return Err(DbError::invalid_config("No host."));
    }
    if s.contains(',') {
        return Err(DbError::invalid_config(if srv {
            "`mongodb+srv://` takes exactly one host; use `mongodb://` for a seed list.".to_string()
        } else if family == DbFamily::Mongodb {
            "A MongoDB seed list (`host1,host2`) is not supported yet — use a single host, or \
             an `mongodb+srv://` URI."
                .to_string()
        } else {
            "A connection string takes one host; `,` is not valid here.".to_string()
        }));
    }
    // Bracketed IPv6.
    if let Some(inner) = s.strip_prefix('[') {
        let Some(close) = inner.find(']') else {
            return Err(DbError::invalid_config(
                "An IPv6 address needs a closing `]`, e.g. `[::1]:5432`.",
            ));
        };
        let host = &inner[..close];
        if host.is_empty() {
            return Err(DbError::invalid_config("No host."));
        }
        let after = &inner[close + 1..];
        let port = match after {
            "" => None,
            _ => match after.strip_prefix(':') {
                Some(p) => Some(parse_port(p)?),
                None => {
                    return Err(DbError::invalid_config(format!(
                        "`{after}` is not a port — expected `:port` after `]`."
                    )))
                }
            },
        };
        return Ok((host.to_ascii_lowercase(), port));
    }
    let colons = s.bytes().filter(|b| *b == b':').count();
    if colons > 1 {
        return Err(DbError::invalid_config(format!(
            "`{s}` looks like an IPv6 address, which must be bracketed: `[{s}]:5432`."
        )));
    }
    match s.rfind(':') {
        Some(i) => {
            let host = &s[..i];
            if host.is_empty() {
                return Err(DbError::invalid_config("No host."));
            }
            Ok((host.to_ascii_lowercase(), Some(parse_port(&s[i + 1..])?)))
        }
        None => Ok((s.to_ascii_lowercase(), None)),
    }
}

fn parse_port(s: &str) -> Result<u16, DbError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(DbError::invalid_config(format!(
            "Port `{s}` is not a number."
        )));
    }
    match s.parse::<u32>() {
        Ok(n) if (1..=65535).contains(&n) => Ok(n as u16),
        _ => Err(DbError::invalid_config(format!(
            "Port `{s}` is out of range — it must be from 1 to 65535."
        ))),
    }
}

/// Remove a key ignoring ASCII case, returning its value.
fn take_ci(options: &mut BTreeMap<String, String>, name: &str) -> Option<String> {
    let key = options
        .keys()
        .find(|k| k.eq_ignore_ascii_case(name))
        .cloned()?;
    options.remove(&key)
}

/// Peek a key ignoring ASCII case.
fn get_ci<'a>(options: &'a BTreeMap<String, String>, name: &str) -> Option<&'a String> {
    options
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v)
}

/// Parse a boolean-ish parameter value. An unrecognised value is an **error**, not a guess:
/// `tls=maybe` treated as `true` (or `false`) would set a TLS posture the string did not ask
/// for, which is the silent security divergence this whole area exists to prevent.
fn truthy(name: &str, value: &str) -> Result<bool, DbError> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(DbError::invalid_config(format!(
            "`{name}={value}` is not a true/false value."
        ))),
    }
}

/// Consume whichever parameters carry `family`'s SSL mode and return it, or `None` when the
/// string said nothing about TLS.
fn take_ssl_mode(
    family: DbFamily,
    options: &mut BTreeMap<String, String>,
    scheme_tls: Option<bool>,
) -> Result<Option<SslMode>, DbError> {
    // libpq-style `sslmode=` / MySQL's `ssl-mode=`, tried in the order that family prefers.
    let libpq_keys: &[&str] = match family {
        DbFamily::Mysql => &["ssl-mode", "sslmode"],
        _ => &["sslmode"],
    };
    for key in libpq_keys {
        if let Some(raw) = take_ci(options, key) {
            let Some(mode) = engines::ssl_mode_from_name(&raw) else {
                return Err(DbError::invalid_config(format!(
                    "`{key}={raw}` is not an SSL mode Agent Studio knows."
                )));
            };
            return Ok(Some(mode));
        }
    }

    match family {
        DbFamily::Postgres | DbFamily::Mysql => Ok(None),
        // Nothing to take: a DynamoDB connection is a region plus credentials, never a string.
        DbFamily::Dynamodb => Ok(None),
        DbFamily::Clickhouse => {
            // The JDBC/ops-world spelling, accepted on input though never emitted.
            if let Some(raw) = take_ci(options, "secure") {
                return Ok(Some(if truthy("secure", &raw)? {
                    SslMode::Require
                } else {
                    SslMode::Disable
                }));
            }
            Ok(scheme_tls.map(|t| {
                if t {
                    SslMode::Require
                } else {
                    SslMode::Disable
                }
            }))
        }
        // `rediss://` with nothing else is the STRICT reading, not the lax one: a scheme that
        // asks for TLS and says nothing about verification should not silently skip it.
        DbFamily::Redis => Ok(scheme_tls.map(|t| {
            if t {
                SslMode::VerifyFull
            } else {
                SslMode::Disable
            }
        })),
        DbFamily::Mongodb => {
            let tls_key = if get_ci(options, "tls").is_some() {
                "tls"
            } else if get_ci(options, "ssl").is_some() {
                "ssl"
            } else {
                // No TLS statement at all. The `tlsAllowInvalid*` flags are left in `options`
                // rather than consumed, so nothing is dropped.
                return Ok(scheme_tls.map(|t| {
                    if t {
                        SslMode::VerifyFull
                    } else {
                        SslMode::Disable
                    }
                }));
            };
            let raw = take_ci(options, tls_key).expect("just found it");
            if !truthy(tls_key, &raw)? {
                return Ok(Some(SslMode::Disable));
            }
            let bad_certs = take_ci(options, "tlsAllowInvalidCertificates")
                .or_else(|| take_ci(options, "tlsInsecure"));
            let bad_hosts = take_ci(options, "tlsAllowInvalidHostnames");
            let certs_off = match &bad_certs {
                Some(v) => truthy("tlsAllowInvalidCertificates", v)?,
                None => false,
            };
            let hosts_off = match &bad_hosts {
                Some(v) => truthy("tlsAllowInvalidHostnames", v)?,
                None => false,
            };
            Ok(Some(if certs_off {
                SslMode::Require
            } else if hosts_off {
                SslMode::VerifyCa
            } else {
                SslMode::VerifyFull
            }))
        }
    }
}

/// Parse a connection string for the dialog. A real password is dropped (`had_password` says so);
/// a `{{VAR}}` survives. On `Err` the caller leaves the form untouched.
pub fn parse(text: &str) -> Result<ParsedUrl, DbError> {
    let parts = parse_parts(text)?;
    // One check for both positions, because by now there is only one slot to look at — which is
    // the point of folding a `?password=` into it.
    let had_password = matches!(parts.password, PasswordSlot::Value(_));
    // Render with the value stripped and a reference kept. This is also what normalises a
    // messy paste into our canonical form, which is what the dialog then shows the user.
    let display_password = match &parts.password {
        PasswordSlot::Ref(r) => PasswordSlot::Ref(r.clone()),
        _ => PasswordSlot::None,
    };
    let url = render_with(&parts, &display_password)?;
    // Carried out to the dialog so a paste can be rebuilt with the credential in the place
    // the user typed it (see `ParsedUrl::password_param`). Cloned before `parts` is consumed.
    let password_param = parts.password_param.clone();
    Ok(ParsedUrl {
        engine: Some(parts.engine),
        family: Some(parts.family),
        host: parts.host,
        port: parts.port,
        // 🔴 Reported to the dialog, which is the half that was missing: the parser has always
        // known an Atlas URI was an SRV one, and until `DbConnection::srv` existed there was
        // nowhere for the answer to go, so it was not returned at all.
        srv: parts.srv,
        database: parts.database,
        user: parts.user,
        had_password,
        password_param,
        ssl_mode: parts.ssl_mode,
        url,
        options: parts.options,
    })
}

/* ─────────────────── what a string SAYS about the credential (the dial path) ─────────────────── */

/// Who a connection string connects as: the user name and whether a password is present, never
/// the value (one less place a `Debug` could leak it).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UrlCredential {
    /// The user the string names, `None` when its authority carries no userinfo at all.
    pub user: Option<String>,
    /// Whether the string carries a password of its own — in the userinfo **or** in a denylisted
    /// query parameter, which are the same credential in two places (see [`parse_parts`]).
    pub has_password: bool,
}

/// A string's credential positions: a URL wins only where it says something, so a password-less
/// URL lets the typed password fill the gap. Unparseable → says nothing (only adds a typed
/// credential). Redis and MongoDB ask their own drivers instead.
pub fn credential_of(text: &str) -> UrlCredential {
    let Ok(parts) = parse_parts(text) else {
        return UrlCredential::default();
    };
    UrlCredential {
        // `parse_parts` returns `""` for "no userinfo" and for `://@host` alike; only a non-empty
        // name is a statement about the user.
        user: Some(parts.user).filter(|u| !u.is_empty()),
        has_password: !matches!(parts.password, PasswordSlot::None),
    }
}

/* ─────────────────────── the credential split, for the save path ─────────────────────── */

/// What [`split_url_credentials`] found and took out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitCredentials {
    /// The string with every credential removed. Safe to persist as-is.
    pub url: String,
    /// The user from the string, `""` when it carried none.
    pub user: String,
    /// A **real** password, from the userinfo *or* from a denylisted query parameter. `None` for
    /// absent or for a `{{VAR}}`. Which of the two places it came from does not change what the
    /// caller does with it — it goes to the Vault either way — so there is one field.
    pub password: Option<String>,
    /// A `{{VAR}}` the string already carried, if any.
    pub password_ref: Option<String>,
    /// The query parameter the credential came from, when it came from one. Informational for a
    /// caller; [`Self::parts`] already carries it, which is how the re-render puts it back.
    pub password_param: Option<String>,
    /// The parts, so a caller can re-render with a freshly minted `{{VAR}}`.
    pub parts: UrlParts,
}

/// Take every credential out of `text` server-side on the save path, whatever the client did:
/// userinfo (plain or percent-encoded), an existing `{{VAR}}`, or a denylisted query parameter.
pub fn split_url_credentials(text: &str) -> Result<SplitCredentials, DbError> {
    let parts = parse_parts(text)?;
    let (password, password_ref) = match &parts.password {
        PasswordSlot::None => (None, None),
        PasswordSlot::Ref(r) => (None, Some(r.clone())),
        PasswordSlot::Value(v) => (Some(v.clone()), None),
    };
    let stripped = match &password_ref {
        Some(r) => PasswordSlot::Ref(r.clone()),
        None => PasswordSlot::None,
    };
    Ok(SplitCredentials {
        url: render_with(&parts, &stripped)?,
        user: parts.user.clone(),
        password,
        password_ref,
        password_param: parts.password_param.clone(),
        parts,
    })
}

/// `parts` re-rendered with `{{name}}` in the password position — whichever position that is
/// (the userinfo, or the query parameter the credential arrived in). What
/// `db_connection_upsert` persists once it has minted a Vault variable.
pub fn render_with_ref(parts: &UrlParts, var_name: &str) -> Result<String, DbError> {
    render_with(parts, &PasswordSlot::Ref(secret::wrap_ref(var_name)))
}

#[cfg(test)]
mod tests {

    /* ───────────── srv + TLS: a control that cannot do what it says ───────────── */

    /// 🔴 The driver turns TLS on for every `mongodb+srv://` connection, so `disable` is
    /// unhonourable. Refused rather than silently overridden — see the function's doc.
    #[test]
    fn srv_with_tls_disabled_is_refused_rather_than_silently_overridden() {
        let err = reject_disabled_tls_with_srv(true, SslMode::Disable)
            .expect_err("srv + disable must be refused");
        assert_eq!(err.code, crate::db::error::DbErrorCode::InvalidConfig);
        // The message has to say WHY, or the user just sees a rejection of a combination that
        // looks reasonable.
        assert!(err.message.contains("always encrypted"), "{}", err.message);
        assert!(err.message.contains("require"), "{}", err.message);
    }

    #[test]
    fn srv_with_any_encrypting_mode_is_allowed_including_the_one_srv_makes_stricter() {
        // `require` means "encrypt, do not verify"; SRV upgrades it to full verification. Allowed
        // on purpose: being stricter than asked is the safe direction to be wrong, and refusing it
        // would block the ordinary Atlas connection this whole change exists to enable.
        for mode in [
            SslMode::Require,
            SslMode::VerifyCa,
            SslMode::VerifyFull,
            SslMode::Prefer,
        ] {
            assert!(reject_disabled_tls_with_srv(true, mode).is_ok(), "{mode:?}");
        }
    }

    #[test]
    fn without_srv_disable_is_none_of_this_functions_business() {
        // Every non-Mongo engine, and a plain `mongodb://` host, may legitimately disable TLS —
        // the fixture does exactly that.
        assert!(reject_disabled_tls_with_srv(false, SslMode::Disable).is_ok());
    }

    use super::*;
    use crate::db::engines::ENGINES;

    fn input(engine: DbEngineId) -> DbConnectionInput {
        let spec = engines::spec_for(engine).unwrap();
        serde_json::from_str(&format!(
            r#"{{"name":"c","engine":{engine},"host":"db.internal","port":{port},
                "database":"maestro","user":"ro","passwordRef":"","savePassword":"never",
                "sslMode":{ssl},"options":{{}},"readOnly":true,"rowLimit":500,
                "timeoutMs":30000}}"#,
            engine = serde_json::to_string(&engine).unwrap(),
            port = spec.default_port,
            ssl = serde_json::to_string(&spec.defaults.ssl_mode).unwrap(),
        ))
        .unwrap()
    }

    /* ───────────────────────────── build, literally ───────────────────────────── */

    #[test]
    fn build_renders_each_family_the_way_its_own_tooling_spells_it() {
        // Hand-written expectations — the whole string, per family. If a spelling changes, this
        // names it (the value assertions a property test cannot make).
        let cases: &[(DbEngineId, &str)] = &[
            (
                DbEngineId::Postgres,
                "postgresql://ro@db.internal:5432/maestro?sslmode=prefer",
            ),
            (
                DbEngineId::AuroraPostgres,
                "postgresql://ro@db.internal:5432/maestro?sslmode=require",
            ),
            (
                DbEngineId::Mysql,
                "mysql://ro@db.internal:3306/maestro?ssl-mode=REQUIRED",
            ),
            (
                DbEngineId::AuroraMysql,
                "mysql://ro@db.internal:3306/maestro?ssl-mode=REQUIRED",
            ),
            (
                DbEngineId::Clickhouse,
                "clickhouse://ro@db.internal:8123/maestro?sslmode=require",
            ),
            (
                DbEngineId::Mongodb,
                "mongodb://ro@db.internal:27017/maestro?tls=true&tlsAllowInvalidCertificates=true",
            ),
            (DbEngineId::Redis, "redis://ro@db.internal:6379/maestro"),
            (DbEngineId::Valkey, "redis://ro@db.internal:6379/maestro"),
        ];
        for (engine, want) in cases {
            let mut i = input(*engine);
            if *engine == DbEngineId::Mongodb {
                // `authSource` is required on Mongo, but `build` is not `validate` — assert the
                // string without it so this test stays about rendering.
                i.options.clear();
            }
            assert_eq!(&build(&i).unwrap(), want, "{engine:?}");
        }
    }

    #[test]
    fn build_emits_a_vault_reference_verbatim_and_refuses_a_literal_password() {
        let mut i = input(DbEngineId::Postgres);
        i.password_ref = "{{PG_PROD_PASSWORD}}".into();
        assert_eq!(
            build(&i).unwrap(),
            "postgresql://ro:{{PG_PROD_PASSWORD}}@db.internal:5432/maestro?sslmode=prefer",
            "a reference is written verbatim so the user can SEE their password is not in it"
        );

        // The most important refusal in this module: the string behind *Copy connection
        // string* must never be able to contain a password.
        i.password_ref = "hunter2".into();
        let err = build(&i).expect_err("a literal password must be refused");
        assert!(
            err.message.contains("never contains a password"),
            "{}",
            err.message
        );
        assert!(
            !err.message.contains("hunter2"),
            "and must not echo it: {}",
            err.message
        );
    }

    #[test]
    fn build_brackets_an_ipv6_host_and_lowercases_a_mixed_case_one() {
        let mut i = input(DbEngineId::Postgres);
        i.host = "::1".into();
        assert!(
            build(&i).unwrap().contains("@[::1]:5432/"),
            "{}",
            build(&i).unwrap()
        );
        // Already bracketed input is not double-bracketed.
        i.host = "[2001:db8::1]".into();
        assert!(build(&i).unwrap().contains("@[2001:db8::1]:5432/"));
        i.host = "HOST.Example.COM".into();
        assert!(build(&i).unwrap().contains("@host.example.com:5432/"));
    }

    #[test]
    fn build_percent_encodes_the_user_the_database_and_the_options() {
        let mut i = input(DbEngineId::Postgres);
        i.user = "user@corp".into();
        i.database = "my db/1".into();
        i.options
            .insert("searchPath".into(), "public,extra one".into());
        let s = build(&i).unwrap();
        assert_eq!(
            s,
            "postgresql://user%40corp@db.internal:5432/my%20db%2F1\
             ?sslmode=prefer&searchPath=public,extra%20one"
        );
    }

    #[test]
    fn build_emits_a_trailing_slash_for_an_empty_database() {
        let mut i = input(DbEngineId::Postgres);
        i.database = String::new();
        assert_eq!(
            build(&i).unwrap(),
            "postgresql://ro@db.internal:5432/?sslmode=prefer"
        );
    }

    #[test]
    fn build_omits_the_userinfo_entirely_when_there_is_neither_user_nor_password() {
        let mut i = input(DbEngineId::Postgres);
        i.user = String::new();
        assert_eq!(
            build(&i).unwrap(),
            "postgresql://db.internal:5432/maestro?sslmode=prefer"
        );
    }

    #[test]
    fn build_writes_the_redis_password_only_form() {
        // `redis://:pw@host` is the standard shape for a `requirepass`-only server.
        let mut i = input(DbEngineId::Redis);
        i.user = String::new();
        i.password_ref = "{{REDIS_PASSWORD}}".into();
        assert_eq!(
            build(&i).unwrap(),
            "redis://:{{REDIS_PASSWORD}}@db.internal:6379/maestro"
        );
    }

    #[test]
    fn build_switches_the_redis_scheme_on_tls_and_only_refines_when_it_must() {
        let cases: &[(SslMode, &str)] = &[
            (SslMode::Disable, "redis://ro@db.internal:6379/maestro"),
            (
                SslMode::Require,
                "rediss://ro@db.internal:6379/maestro?sslmode=require",
            ),
            (
                SslMode::VerifyCa,
                "rediss://ro@db.internal:6379/maestro?sslmode=verify-ca",
            ),
            (SslMode::VerifyFull, "rediss://ro@db.internal:6379/maestro"),
        ];
        for (mode, want) in cases {
            let mut i = input(DbEngineId::Redis);
            i.ssl_mode = *mode;
            assert_eq!(&build(&i).unwrap(), want, "{mode:?}");
        }
    }

    #[test]
    fn build_maps_every_mongo_mode_to_real_driver_parameters() {
        let cases: &[(SslMode, &str)] = &[
            (SslMode::Disable, "?tls=false"),
            (
                SslMode::Require,
                "?tls=true&tlsAllowInvalidCertificates=true",
            ),
            (SslMode::VerifyCa, "?tls=true&tlsAllowInvalidHostnames=true"),
            (SslMode::VerifyFull, "?tls=true"),
        ];
        for (mode, want_query) in cases {
            let mut i = input(DbEngineId::Mongodb);
            i.options.clear();
            i.ssl_mode = *mode;
            let s = build(&i).unwrap();
            assert!(s.ends_with(want_query), "{mode:?} → {s}");
        }
    }

    #[test]
    fn build_refuses_a_mode_the_engine_does_not_offer() {
        let mut i = input(DbEngineId::Mongodb);
        i.ssl_mode = SslMode::Prefer;
        let err = build(&i).expect_err("Mongo has no opportunistic TLS");
        assert!(err.message.contains("prefer"), "{}", err.message);
    }

    #[test]
    fn ssl_params_refuses_mongo_prefer_directly() {
        // The one arm `build` can no longer reach once it validates the ladder. Exercised here
        // so it is covered by an assertion rather than by being unreachable.
        let err = ssl_params(DbFamily::Mongodb, SslMode::Prefer).expect_err("no such mode");
        assert!(err.message.contains("opportunistic"), "{}", err.message);
    }

    #[test]
    fn build_refuses_a_missing_host_a_zero_port_and_a_structural_character() {
        let mut i = input(DbEngineId::Postgres);
        i.host = "  ".into();
        assert!(build(&i).unwrap_err().message.contains("Host is required"));
        i = input(DbEngineId::Postgres);
        i.port = Some(0);
        assert!(build(&i).unwrap_err().message.contains("Port must be"));
        for bad in ["a/b", "a?b", "a#b", "a@b", "a b"] {
            let mut i = input(DbEngineId::Postgres);
            i.host = bad.into();
            assert!(
                build(&i).is_err(),
                "host {bad:?} must be refused, not silently reinterpreted"
            );
        }
    }

    /* ───────────────────────────── parse, literally ───────────────────────────── */

    #[test]
    fn parse_reads_a_realistic_postgres_string() {
        let p = parse("postgresql://catalog_ro:s3cret@db.internal:5432/maestro?sslmode=require&target_session_attrs=read-write").unwrap();
        assert_eq!(p.engine, Some(DbEngineId::Postgres));
        assert_eq!(p.family, Some(DbFamily::Postgres));
        assert_eq!(p.host, "db.internal");
        assert_eq!(p.port, Some(5432));
        assert_eq!(p.database, "maestro");
        assert_eq!(p.user, "catalog_ro");
        assert!(p.had_password);
        assert_eq!(p.ssl_mode, Some(SslMode::Require));
        assert_eq!(
            p.options.get("target_session_attrs").map(String::as_str),
            Some("read-write"),
            "an unmodelled parameter is preserved, never dropped"
        );
        // The headline: the password is gone from everything we return.
        assert!(!p.url.contains("s3cret"), "{}", p.url);
        assert_eq!(
            p.url,
            "postgresql://catalog_ro@db.internal:5432/maestro\
             ?sslmode=require&target_session_attrs=read-write"
        );
    }

    #[test]
    fn parse_reports_no_password_for_a_vault_reference_and_keeps_it_in_the_url() {
        // A reference is public. Saying "that URL carried a password" about it would be false,
        // and stripping it would lose the user's own configuration.
        let p = parse("postgresql://u:{{PG_PASSWORD}}@h:5432/d?sslmode=prefer").unwrap();
        assert!(!p.had_password);
        assert_eq!(
            p.url,
            "postgresql://u:{{PG_PASSWORD}}@h:5432/d?sslmode=prefer"
        );
    }

    #[test]
    fn parse_decodes_percent_encoded_credentials_and_still_returns_none_of_the_password() {
        let secret = "p@ss:w/ord ✓";
        let text = format!("postgresql://us%40er:{}@h:5432/d", encode_userinfo(secret));
        let p = parse(&text).unwrap();
        assert_eq!(p.user, "us@er");
        assert!(p.had_password);
        assert!(!p.url.contains(secret), "{}", p.url);
        assert!(!p.url.contains(&encode_userinfo(secret)), "{}", p.url);
        assert_eq!(p.url, "postgresql://us%40er@h:5432/d");
    }

    #[test]
    fn parse_moves_a_denylisted_query_parameter_out_and_flags_it() {
        // ClickHouse's own `?password=` is the realistic case.
        let p =
            parse("clickhouse://agentstudio@h:8123/maestro?password=s3cret&compress=1").unwrap();
        assert!(p.had_password, "a query-string credential counts");
        assert!(!p.options.contains_key("password"));
        assert!(!p.url.contains("s3cret"), "{}", p.url);
        assert_eq!(p.options.get("compress").map(String::as_str), Some("1"));
    }

    #[test]
    fn parse_reports_which_parameter_carried_the_password_so_a_paste_can_be_rebuilt() {
        // Without the parameter's name the rebuilt URL would move `{{VAR}}` into the userinfo; only
        // the name is returned, never the value.
        let q =
            parse("clickhouse://agentstudio@h:8123/maestro?password=s3cret&compress=1").unwrap();
        assert_eq!(q.password_param.as_deref(), Some("password"));
        assert!(q.had_password);
        assert!(!q.url.contains("s3cret"), "{}", q.url);

        // A non-canonical spelling survives as itself — normalising it to `password` would be
        // the meaning change we refuse to make.
        let odd = parse("mysql://u@h:3306/db?pwd=s3cret").unwrap();
        assert_eq!(odd.password_param.as_deref(), Some("pwd"));

        // Userinfo is the other position, and reports `None` rather than a made-up name.
        let ui = parse("postgresql://u:s3cret@h:5432/db").unwrap();
        assert_eq!(ui.password_param, None);
        assert!(ui.had_password);

        // No password at all: no position.
        let bare = parse("postgresql://u@h:5432/db").unwrap();
        assert_eq!(bare.password_param, None);
        assert!(!bare.had_password);
    }

    #[test]
    fn parse_does_not_mistake_auth_source_for_a_credential() {
        // The denylist is exact-match for exactly this reason: substring matching would strip
        // `authSource` and break every Atlas string.
        let p = parse("mongodb://u@h:27017/maestro?authSource=admin&tls=true").unwrap();
        assert_eq!(
            p.options.get("authSource").map(String::as_str),
            Some("admin")
        );
        assert!(!p.had_password);
    }

    #[test]
    fn parse_detects_the_engine_from_every_scheme_we_accept() {
        // Written out literally; includes the aliases `build` never emits.
        let cases: &[(&str, DbEngineId, DbFamily)] = &[
            ("postgres://h/d", DbEngineId::Postgres, DbFamily::Postgres),
            ("postgresql://h/d", DbEngineId::Postgres, DbFamily::Postgres),
            ("POSTGRESQL://h/d", DbEngineId::Postgres, DbFamily::Postgres),
            ("mysql://h/d", DbEngineId::Mysql, DbFamily::Mysql),
            ("mariadb://h/d", DbEngineId::Mysql, DbFamily::Mysql),
            ("mongodb://h/d", DbEngineId::Mongodb, DbFamily::Mongodb),
            ("mongodb+srv://h/d", DbEngineId::Mongodb, DbFamily::Mongodb),
            ("redis://h/0", DbEngineId::Redis, DbFamily::Redis),
            ("rediss://h/0", DbEngineId::Redis, DbFamily::Redis),
            ("valkey://h/0", DbEngineId::Redis, DbFamily::Redis),
            ("valkeys://h/0", DbEngineId::Redis, DbFamily::Redis),
            (
                "clickhouse://h/d",
                DbEngineId::Clickhouse,
                DbFamily::Clickhouse,
            ),
            (
                "clickhouses://h/d",
                DbEngineId::Clickhouse,
                DbFamily::Clickhouse,
            ),
            (
                "http://h:8123/d",
                DbEngineId::Clickhouse,
                DbFamily::Clickhouse,
            ),
            (
                "https://h:8443/d",
                DbEngineId::Clickhouse,
                DbFamily::Clickhouse,
            ),
        ];
        for (text, engine, family) in cases {
            let p = parse(text).unwrap_or_else(|e| panic!("{text}: {}", e.message));
            assert_eq!(p.engine, Some(*engine), "{text}");
            assert_eq!(p.family, Some(*family), "{text}");
        }
    }

    #[test]
    fn parse_reads_tls_from_the_scheme_when_no_parameter_says_otherwise() {
        let cases: &[(&str, Option<SslMode>)] = &[
            ("redis://h:6379/0", Some(SslMode::Disable)),
            // `rediss://` with nothing else is the STRICT reading.
            ("rediss://h:6379/0", Some(SslMode::VerifyFull)),
            ("rediss://h:6379/0?sslmode=require", Some(SslMode::Require)),
            ("valkeys://h:6379/0", Some(SslMode::VerifyFull)),
            ("http://h:8123/d", Some(SslMode::Disable)),
            ("https://h:8443/d", Some(SslMode::Require)),
            ("clickhouse://h:8123/d?secure=true", Some(SslMode::Require)),
            ("clickhouse://h:8123/d?secure=0", Some(SslMode::Disable)),
            // Postgres and MySQL have no TLS-bearing scheme, so silence really is silence.
            ("postgresql://h:5432/d", None),
            ("mysql://h:3306/d", None),
            ("mongodb://h:27017/d", None),
            ("mongodb+srv://h/d", Some(SslMode::VerifyFull)),
        ];
        for (text, want) in cases {
            assert_eq!(parse(text).unwrap().ssl_mode, *want, "{text}");
        }
    }

    #[test]
    fn parse_reads_mysql_and_mongo_ssl_spellings_and_the_libpq_aliases() {
        let cases: &[(&str, SslMode)] = &[
            ("mysql://h/d?ssl-mode=VERIFY_IDENTITY", SslMode::VerifyFull),
            ("mysql://h/d?ssl-mode=DISABLED", SslMode::Disable),
            ("mysql://h/d?ssl-mode=PREFERRED", SslMode::Prefer),
            // A `sslmode=` on a MySQL string is accepted as an alias — people write it.
            ("mysql://h/d?sslmode=require", SslMode::Require),
            ("postgresql://h/d?sslmode=allow", SslMode::Prefer),
            ("postgresql://h/d?SSLMODE=VERIFY-CA", SslMode::VerifyCa),
            ("mongodb://h/d?ssl=true", SslMode::VerifyFull),
            ("mongodb://h/d?tls=true&tlsInsecure=true", SslMode::Require),
            (
                "mongodb://h/d?tls=true&tlsAllowInvalidHostnames=yes",
                SslMode::VerifyCa,
            ),
            ("mongodb://h/d?tls=off", SslMode::Disable),
        ];
        for (text, want) in cases {
            assert_eq!(parse(text).unwrap().ssl_mode, Some(*want), "{text}");
        }
    }

    #[test]
    fn parse_keeps_mongo_tls_flags_that_have_no_tls_statement_to_attach_to() {
        // Nothing is dropped: with no `tls=`, the flags stay as pass-through options.
        let p = parse("mongodb://h:27017/d?tlsAllowInvalidHostnames=true").unwrap();
        assert_eq!(p.ssl_mode, None);
        assert_eq!(
            p.options
                .get("tlsAllowInvalidHostnames")
                .map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn parse_reads_ipv6_and_a_missing_port_and_a_bare_authority() {
        let p = parse("postgresql://u@[2001:DB8::1]:5432/d").unwrap();
        assert_eq!(p.host, "2001:db8::1");
        assert_eq!(p.port, Some(5432));
        assert_eq!(p.url, "postgresql://u@[2001:db8::1]:5432/d");

        let p = parse("postgresql://h/d").unwrap();
        assert_eq!(p.port, None, "an absent port stays absent, never guessed");
        assert_eq!(p.url, "postgresql://h/d");

        let p = parse("postgresql://h").unwrap();
        assert_eq!(p.database, "");
        assert_eq!(
            p.url, "postgresql://h/",
            "normalised to a canonical empty path"
        );

        let p = parse("postgresql://[::1]").unwrap();
        assert_eq!((p.host.as_str(), p.port), ("::1", None));
    }

    #[test]
    fn parse_splits_at_the_last_at_sign_so_an_unencoded_at_in_a_password_still_works() {
        let p = parse("postgresql://u:p@ss@db.internal:5432/d").unwrap();
        assert_eq!(p.host, "db.internal");
        assert_eq!(p.user, "u");
        assert!(p.had_password);
        assert!(!p.url.contains("p@ss"), "{}", p.url);
    }

    #[test]
    fn parse_rejects_every_malformed_shape_with_a_precise_message() {
        let cases: &[(&str, &str)] = &[
            ("", "Enter a connection string."),
            ("   ", "Enter a connection string."),
            ("db.internal:5432/maestro", "No scheme"),
            ("://h/d", "No scheme"),
            ("postgresql://h:abc/db", "Port `abc` is not a number."),
            ("postgresql://h:0/db", "out of range"),
            ("postgresql://h:70000/db", "out of range"),
            ("postgresql://h:/db", "Port `` is not a number."),
            ("postgresql://u:p@/db", "No host."),
            ("postgresql://", "No host."),
            ("postgresql://h/a/b", "one path segment"),
            ("postgresql://::1:5432/d", "must be bracketed"),
            ("postgresql://[::1:5432/d", "closing `]`"),
            ("postgresql://[::1]x/d", "is not a port"),
            ("rediss://h#insecure", "URL fragment"),
            ("postgresql://h/d?sslmode=sideways", "not an SSL mode"),
            ("mongodb://h/d?tls=maybe", "not a true/false value"),
            ("clickhouse://h/d?secure=perhaps", "not a true/false value"),
            ("tcp://h:9000/d", "native protocol"),
            ("sqlserver://h/d", "no SQL Server driver"),
            ("oracle://h/d", "no Oracle driver"),
            ("dynamodb://h/d", "no DynamoDB driver"),
            (
                "gopher://h/d",
                "not a connection string Agent Studio understands",
            ),
            ("mongodb://a:27017,b:27017/d", "seed list"),
            ("mongodb+srv://a:1,b:2/d", "exactly one host"),
            ("postgresql://a,b:5432/d", "`,` is not valid here"),
        ];
        // A plain `match`: both `Ok` (a failure) and the `Err` message must be asserted, and an
        // `unwrap_or_else` closure runs only on `Err`.
        for (text, want) in cases {
            match parse(text) {
                Ok(p) => panic!("{text:?} must be refused, but parsed as {p:?}"),
                Err(e) => assert!(
                    e.message.contains(want),
                    "{text:?}: message {:?} does not contain {want:?}",
                    e.message
                ),
            }
        }
    }

    #[test]
    fn parse_accepts_a_valueless_and_a_repeated_query_parameter() {
        let p = parse("postgresql://h/d?flag&x=1&x=2&=ignored&").unwrap();
        assert_eq!(p.options.get("flag").map(String::as_str), Some(""));
        assert_eq!(
            p.options.get("x").map(String::as_str),
            Some("2"),
            "last wins, as every URL query reader does"
        );
        assert!(
            !p.options.contains_key(""),
            "a nameless parameter is dropped"
        );
    }

    /* ────────── what a string SAYS about the credential (the dial path) ────────── */

    /// One table so every engine gets the same answer. The `false` rows are load-bearing;
    /// `postgres://u:@h` has an empty password position, which libpq reads as no password.
    #[test]
    fn credential_of_reports_only_what_the_string_actually_says() {
        let cases: &[(&str, Option<&str>, bool)] = &[
            // ── the string says nothing about the password ──
            (
                "postgresql://gazelle@localhost:5433/orders",
                Some("gazelle"),
                false,
            ),
            ("postgresql://localhost:5433/orders", None, false),
            // An empty password position is "no password", exactly as libpq reads it.
            (
                "postgresql://gazelle:@localhost:5433/orders",
                Some("gazelle"),
                false,
            ),
            // An empty credential parameter is not a credential either (see `parse_parts`).
            ("postgresql://ro@h:5432/d?password=", Some("ro"), false),
            ("redis://127.0.0.1:6379/0", None, false),
            (
                "mongodb://gazelle@localhost:27017/orders",
                Some("gazelle"),
                false,
            ),
            // ── the string speaks for itself ──
            (
                "postgresql://gazelle:s3cret@localhost:5433/orders",
                Some("gazelle"),
                true,
            ),
            // A query-borne credential is the same credential in a different place.
            ("postgresql://ro@h:5432/d?password=s3cret", Some("ro"), true),
            ("mysql://ro@h:3306/d?pwd=s3cret", Some("ro"), true),
            // A `{{VAR}}` counts: by the time an engine asks, `db::substitute_url` has already put
            // the real secret in its place, so the string genuinely carries one.
            ("postgresql://ro:{{PG_PW}}@h:5432/d", Some("ro"), true),
            // ── a string we cannot read says nothing (see the function's doc) ──
            ("not a url at all", None, false),
            ("sqlserver://ro:s3cret@h:1433/d", None, false),
            // Two credentials is a `parse_parts` refusal, so it also says nothing here; a typed
            // password then wins a string the save path would refuse.
            ("postgresql://ro:a@h:5432/d?password=b", None, false),
        ];
        for (text, user, has_password) in cases {
            let got = credential_of(text);
            assert_eq!(got.user.as_deref(), *user, "user of {text:?}");
            assert_eq!(got.has_password, *has_password, "password of {text:?}");
        }
    }

    /// The struct must never become a place a secret can sit — it answers *whether*, never *what*.
    #[test]
    fn credential_of_never_carries_the_password_value_anywhere() {
        let got = credential_of("postgresql://ro:s3cret-hunter2@h:5432/d");
        assert!(got.has_password);
        assert!(
            !format!("{got:?}").contains("s3cret-hunter2"),
            "UrlCredential leaked the value: {got:?}"
        );
    }

    /* ─────────────────────── the credential split ─────────────────────── */

    #[test]
    fn split_url_credentials_rewrites_the_userinfo_and_hands_back_the_value() {
        let s = split_url_credentials(
            "postgresql://catalog_ro:s3cret@db.internal:5432/maestro?sslmode=require",
        )
        .unwrap();
        assert_eq!(s.user, "catalog_ro");
        assert_eq!(s.password.as_deref(), Some("s3cret"));
        assert_eq!(s.password_ref, None);
        assert!(!s.url.contains("s3cret"), "{}", s.url);
        assert_eq!(
            s.url,
            "postgresql://catalog_ro@db.internal:5432/maestro?sslmode=require"
        );
        // …and the caller can re-render with a minted variable, which is what upsert persists.
        assert_eq!(
            render_with_ref(&s.parts, "PG_MAESTRO_PASSWORD").unwrap(),
            "postgresql://catalog_ro:{{PG_MAESTRO_PASSWORD}}@db.internal:5432/maestro\
             ?sslmode=require"
        );
    }

    #[test]
    fn split_url_credentials_handles_every_userinfo_shape() {
        struct Case {
            text: &'static str,
            user: &'static str,
            password: Option<&'static str>,
            password_ref: Option<&'static str>,
        }
        let cases = [
            Case {
                text: "postgresql://h:5432/d",
                user: "",
                password: None,
                password_ref: None,
            },
            Case {
                text: "postgresql://u@h:5432/d",
                user: "u",
                password: None,
                password_ref: None,
            },
            Case {
                text: "postgresql://u:@h:5432/d",
                user: "u",
                password: None,
                password_ref: None,
            },
            Case {
                text: "postgresql://u:pw@h:5432/d",
                user: "u",
                password: Some("pw"),
                password_ref: None,
            },
            Case {
                text: "postgresql://:pw@h:5432/d",
                user: "",
                password: Some("pw"),
                password_ref: None,
            },
            Case {
                text: "postgresql://u:%70%77@h:5432/d",
                user: "u",
                password: Some("pw"),
                password_ref: None,
            },
            Case {
                text: "postgresql://u:{{V}}@h:5432/d",
                user: "u",
                password: None,
                password_ref: Some("{{V}}"),
            },
            Case {
                // An already-encoded reference normalises to the readable form.
                text: "postgresql://u:%7B%7BV%7D%7D@h:5432/d",
                user: "u",
                password: None,
                password_ref: Some("{{V}}"),
            },
            Case {
                text: "mongodb+srv://u:pw@cluster0.abcde.mongodb.net/maestro?authSource=admin",
                user: "u",
                password: Some("pw"),
                password_ref: None,
            },
        ];
        for c in cases {
            let s = split_url_credentials(c.text)
                .unwrap_or_else(|e| panic!("{}: {}", c.text, e.message));
            assert_eq!(s.user, c.user, "{}", c.text);
            assert_eq!(s.password.as_deref(), c.password, "{}", c.text);
            assert_eq!(s.password_ref.as_deref(), c.password_ref, "{}", c.text);
            if let Some(pw) = c.password {
                assert!(
                    !s.url.contains(pw),
                    "{} kept the password: {}",
                    c.text,
                    s.url
                );
            }
        }
    }

    /// Values are distinctive (`pw-alpha`): a one-letter secret matches almost any URL by accident.
    #[test]
    fn split_url_credentials_takes_a_denylisted_query_parameter_and_keeps_its_name() {
        // ClickHouse's own `?password=`, the realistic case; drivers do authenticate from it.
        let s = split_url_credentials(
            "clickhouse://u@h:8123/d?password=pw-alpha&compress=1&authSource=keepme",
        )
        .unwrap();
        assert_eq!(s.password.as_deref(), Some("pw-alpha"));
        assert_eq!(s.password_ref, None);
        assert_eq!(s.password_param.as_deref(), Some("password"));
        assert!(!s.url.contains("pw-alpha"), "{}", s.url);
        // The parameter itself must be gone too: a `password=` left behind with an empty value
        // still tells a reader there was one, and would still be sent to the server.
        assert!(!s.url.contains("password="), "{}", s.url);
        assert!(s.url.contains("compress=1"), "{}", s.url);
        assert!(s.url.contains("authSource=keepme"), "{}", s.url);

        // …and the caller re-renders with a minted variable, which is what upsert persists: the
        // reference goes back into the SAME parameter, last, and the userinfo stays password-less.
        assert_eq!(
            render_with_ref(&s.parts, "CH_PASSWORD").unwrap(),
            "clickhouse://u@h:8123/d?sslmode=disable&authSource=keepme&compress=1\
             &password={{CH_PASSWORD}}"
        );
    }

    /// Each denylisted name keeps its spelling: rewriting MySQL's `pass=` to `password=` would send
    /// a different parameter.
    #[test]
    fn a_credential_parameter_keeps_the_name_it_arrived_under() {
        for name in [
            "password",
            "passwd",
            "pwd",
            "pass",
            "auth",
            "authToken",
            "auth_token",
            "token",
            "secret",
            "apikey",
            "api_key",
            "api-key",
            "accesskey",
            "access_key",
            "credentials",
            // Case is part of the name: libpq and sqlx ignore `PASSWORD`, and preserving it beats
            // renaming; the secret still leaves the file.
            "PASSWORD",
            "Password",
        ] {
            let text = format!("postgresql://u@h:5432/d?{name}=pw-alpha&sslmode=require");
            let s =
                split_url_credentials(&text).unwrap_or_else(|e| panic!("{text}: {}", e.message));
            assert_eq!(s.password.as_deref(), Some("pw-alpha"), "{text}");
            assert_eq!(s.password_param.as_deref(), Some(name), "{text}");
            assert!(!s.url.contains("pw-alpha"), "{text} → {}", s.url);
            assert_eq!(
                render_with_ref(&s.parts, "V").unwrap(),
                format!("postgresql://u@h:5432/d?sslmode=require&{name}={{{{V}}}}"),
                "the reference must go back under `{name}`, not under `password`"
            );
        }
    }

    /// One password field and one Vault reference per connection, so a second secret cannot be
    /// kept, and dropping one silently would hide which password was lost.
    #[test]
    fn two_credentials_in_one_string_are_refused_naming_every_place() {
        let cases: &[(&str, &[&str])] = &[
            (
                "clickhouse://u@h:8123/d?password=pw-alpha&token=tok-beta",
                &["`password=`", "`token=`"],
            ),
            (
                "clickhouse://u@h:8123/d?password=pw-alpha&token=tok-beta&api_key=key-gamma",
                &["`api_key=`", "`password=`", "`token=`"],
            ),
            (
                "postgresql://u:pw-alpha@h:5432/d?password=pw-beta",
                &["the `user:password@` part", "`password=`"],
            ),
            // A `{{VAR}}` counts as a place a password lives: it is where THIS connection's
            // secret already goes, so a second one still has nowhere to be.
            (
                "postgresql://u:{{PG_PASSWORD}}@h:5432/d?password=pw-beta",
                &["the `user:password@` part", "`password=`"],
            ),
        ];
        for (text, wants) in cases {
            let err = match parse(text) {
                Ok(p) => panic!("{text} must be refused, parsed as {p:?}"),
                Err(e) => e,
            };
            assert_eq!(err.code, crate::db::error::DbErrorCode::InvalidConfig);
            for want in *wants {
                assert!(
                    err.message.contains(want),
                    "{text}: {:?} does not name {want}",
                    err.message
                );
            }
            // …and never echoes the secrets it is complaining about.
            for secret in ["pw-alpha", "pw-beta", "tok-beta", "key-gamma"] {
                assert!(!err.message.contains(secret), "{text}: {}", err.message);
            }
            // The split path refuses identically — it is the same walk, which is the point.
            assert!(split_url_credentials(text).is_err(), "{text}");
        }
    }

    #[test]
    fn an_empty_credential_parameter_is_dropped_rather_than_treated_as_a_place() {
        let p = parse_parts("postgresql://u:pw-alpha@h:5432/d?password=&sslmode=require").unwrap();
        assert_eq!(p.password, PasswordSlot::Value("pw-alpha".into()));
        assert_eq!(
            p.password_param, None,
            "an empty parameter must not capture the credential"
        );
        assert!(!p.options.contains_key("password"));
        assert_eq!(
            render_with_ref(&p, "V").unwrap(),
            "postgresql://u:{{V}}@h:5432/d?sslmode=require",
            "the reference stays where the password was"
        );

        // …and on its own it is simply absent, not a reported password.
        let p = parse("postgresql://u@h:5432/d?password=").unwrap();
        assert!(!p.had_password);
        assert!(!p.url.contains("password"), "{}", p.url);
    }

    #[test]
    fn srv_ness_survives_a_split_and_a_re_render() {
        let s = split_url_credentials("mongodb+srv://u:pw@cluster0.x.mongodb.net/maestro?tls=true")
            .unwrap();
        assert!(s.url.starts_with("mongodb+srv://"), "{}", s.url);
        assert!(s.parts.srv);
    }

    /* ────────────── the SRV / absent-port pair ───────────────────────────────── */

    /// `srv: true` with no port must render `mongodb+srv://host/db` and re-parse to both facts.
    #[test]
    fn an_srv_connection_with_no_port_round_trips_as_a_portless_srv_uri() {
        let mut i = input(DbEngineId::Mongodb);
        i.host = "cluster0.abcde.mongodb.net".into();
        i.srv = true;
        i.port = None;
        i.ssl_mode = SslMode::VerifyFull; // what Atlas needs, and what SRV implies
        i.options.clear();
        i.user = "catalog_ro".into();
        i.database = "maestro".into();

        let text = build(&i).expect("an Atlas draft must build");
        // The whole string, so there is nowhere for a port to hide.
        assert_eq!(
            text,
            "mongodb+srv://catalog_ro@cluster0.abcde.mongodb.net/maestro?tls=true"
        );
        assert!(!text.contains(":27017"), "{text}");
        // Belt and braces: no `:` after the host at all (the scheme's own `://` is before it).
        assert!(
            !text["mongodb+srv://".len()..].contains(':'),
            "a port crept into the authority: {text}"
        );

        let back = parse(&text).expect("our own output must parse");
        assert!(back.srv, "SRV-ness must survive the round trip");
        assert_eq!(
            back.port, None,
            "and no port may be invented on the way back"
        );
        assert_eq!(back.host, "cluster0.abcde.mongodb.net");
        assert_eq!(back.database, "maestro");
        assert_eq!(back.ssl_mode, Some(SslMode::VerifyFull));
        assert_eq!(back.url, text, "the display string is the input string");

        // …and the parts-level round trip, which is stronger than field equality: a build/parse
        // pair can agree on every field while drifting the text.
        let parts = parse_parts(&text).unwrap();
        assert!(parts.srv);
        assert_eq!(parts.port, None);
        assert_eq!(render(&parts).unwrap(), text, "not a fixed point");
    }

    /// An absent port renders as **no `:port`**, for every engine — not as the descriptor's
    /// default. Whole strings, because "contains no colon" is not the claim; "this exact string" is.
    #[test]
    fn build_omits_the_port_entirely_when_the_record_has_none() {
        let cases: &[(DbEngineId, &str)] = &[
            (
                DbEngineId::Postgres,
                "postgresql://ro@db.internal/maestro?sslmode=prefer",
            ),
            (
                DbEngineId::Mysql,
                "mysql://ro@db.internal/maestro?ssl-mode=REQUIRED",
            ),
            (
                DbEngineId::Clickhouse,
                "clickhouse://ro@db.internal/maestro?sslmode=require",
            ),
            (DbEngineId::Redis, "redis://ro@db.internal/maestro"),
        ];
        for (engine, want) in cases {
            let mut i = input(*engine);
            i.port = None;
            assert_eq!(&build(&i).unwrap(), want, "{engine:?}");
            // And it comes back as absent rather than as the default — an "absent port stays
            // absent" claim `parse` already made for a pasted string, now closed on our own output.
            assert_eq!(parse(want).unwrap().port, None, "{want}");
        }
    }

    #[test]
    fn a_pasted_srv_uri_carrying_a_port_is_refused_by_name() {
        let err = match parse("mongodb+srv://cluster0.abcde.mongodb.net:27017/maestro") {
            Ok(p) => panic!("an SRV URI with a port must be refused, parsed as {p:?}"),
            Err(e) => e,
        };
        assert_eq!(err.code, crate::db::error::DbErrorCode::InvalidConfig);
        assert!(err.message.contains(":27017"), "{}", err.message);
        assert!(err.message.contains("DNS"), "{}", err.message);
        // The same string without the port is what the message tells them to type, so it must work.
        let ok = parse("mongodb+srv://cluster0.abcde.mongodb.net/maestro").expect("the fix parses");
        assert!(ok.srv);
        assert_eq!(ok.port, None);
    }

    /// The pair is refused on **every** path that could produce a string, because each guard covers
    /// a different entry point: `build` is reachable from `db_url_build` without the validator, and
    /// `render_with` is the only place a string is actually assembled.
    #[test]
    fn a_port_together_with_srv_is_refused_by_build_and_by_render() {
        let mut i = input(DbEngineId::Mongodb);
        i.options.clear();
        i.srv = true;
        i.port = Some(27017);
        let err = build(&i).expect_err("build must refuse the pair");
        assert!(
            err.message.contains("cannot have a port"),
            "{}",
            err.message
        );
        assert!(err.message.contains("27017"), "{}", err.message);

        // Hand-built parts, i.e. the case no upstream guard can see. `render_with` is the backstop.
        let parts = UrlParts {
            engine: DbEngineId::Mongodb,
            family: DbFamily::Mongodb,
            srv: true,
            host: "cluster0.abcde.mongodb.net".into(),
            port: Some(27017),
            database: "maestro".into(),
            user: "ro".into(),
            password: PasswordSlot::None,
            password_param: None,
            ssl_mode: Some(SslMode::VerifyFull),
            scheme_tls: None,
            options: BTreeMap::new(),
        };
        let err = render(&parts).expect_err("render must refuse it too");
        assert!(
            err.message.contains("cannot have a port"),
            "{}",
            err.message
        );

        // …and with the port cleared it renders the Atlas string, so the refusal is about the pair
        // and not about SRV.
        let ok = UrlParts {
            port: None,
            ..parts
        };
        assert_eq!(
            render(&ok).unwrap(),
            "mongodb+srv://ro@cluster0.abcde.mongodb.net/maestro?tls=true"
        );
    }

    /// `reject_port_with_srv` is the one function all three call sites share, so its contract is
    /// asserted directly: only the `(true, Some(_))` corner is an error.
    #[test]
    fn only_srv_plus_a_port_is_refused_and_the_other_three_combinations_are_fine() {
        reject_port_with_srv(false, Some(5432)).expect("a port without srv is the ordinary case");
        reject_port_with_srv(false, None).expect("no port, no srv");
        reject_port_with_srv(true, None).expect("srv with no port is the Atlas shape");
        let err = reject_port_with_srv(true, Some(1)).expect_err("the pair");
        assert_eq!(err.code, crate::db::error::DbErrorCode::InvalidConfig);
    }

    /* ─────────────────── the round-trip property ─────────────────── */

    /// Canonical configs (what [`build`] emits: lowercase host, explicit port, sorted options), so
    /// the assertion compares against the input itself, not a re-derived value.
    fn canonical_inputs() -> Vec<DbConnectionInput> {
        // Hosts: an ordinary name, an IPv4 literal, an IPv6 literal, a long label, and a
        // unicode one (preserved verbatim — see the module doc on IDNA).
        let hosts = [
            "db.internal",
            "127.0.0.1",
            "::1",
            "a-very-long-hostname-label-that-is-still-legal.example.com",
            "münchen.example",
        ];
        // Users and databases drawn from the same hostile alphabet as the passwords, because
        // they go through the same encoder and the failures are all in the corners.
        let hostile = crate::db::secret::tests::hostile_secrets();
        let mut out = Vec::new();
        for spec in ENGINES {
            // DynamoDB has no connection string; skipped via a named predicate (see
            // `has_connection_string`).
            if !has_connection_string(spec.family) {
                continue;
            }
            for host in hosts {
                for ssl in spec.ssl_modes {
                    for (n, hostile_value) in hostile.iter().enumerate() {
                        let mut i = input(spec.id);
                        i.engine = spec.id;
                        i.host = host.to_string();
                        i.port = Some(spec.default_port);
                        i.ssl_mode = *ssl;
                        i.user = hostile_value.clone();
                        i.database = hostile[hostile.len() - 1 - n].clone();
                        i.password_ref = if n % 3 == 0 {
                            String::new()
                        } else {
                            "{{PG_PROD_PASSWORD}}".to_string()
                        };
                        i.options = BTreeMap::new();
                        if n % 4 == 0 {
                            i.options.insert("zeta".into(), hostile_value.clone());
                            i.options.insert("alpha".into(), "1".into());
                        }
                        out.push(i);
                    }
                }
            }
        }
        out
    }

    #[test]
    fn parse_of_build_returns_the_generated_config_for_every_engine() {
        let cases = canonical_inputs();
        assert!(
            cases.len() > 1_000,
            "the sweep must actually be a sweep, got {}",
            cases.len()
        );
        for i in &cases {
            let spec = engines::spec_for(i.engine).unwrap();
            let text = build(i).unwrap_or_else(|e| panic!("build failed: {}", e.message));
            let p = parse(&text).unwrap_or_else(|e| panic!("parse of {text:?}: {}", e.message));

            // Compared against the family's base engine: Aurora is not recoverable from
            // `postgresql://`.
            assert_eq!(p.family, Some(spec.family), "{text}");
            assert_eq!(
                p.engine,
                Some(base_engine_of(spec.family)),
                "{text} — parse must report the family's base engine"
            );
            assert_eq!(p.host, i.host.to_ascii_lowercase(), "{text}");
            assert_eq!(p.port, i.port, "{text}");
            assert_eq!(p.database, i.database, "{text}");
            assert_eq!(p.user, i.user, "{text}");
            assert_eq!(p.ssl_mode, Some(i.ssl_mode), "{text}");
            assert_eq!(p.options, i.options, "{text}");
            assert!(
                !p.had_password,
                "{text} — build never emits a real password"
            );
            assert_eq!(
                p.url, text,
                "{text} — the display string is the input string"
            );
        }
    }

    #[test]
    fn build_of_parse_of_build_is_byte_identical() {
        // String stability: catches a build/parse pair that round-trips the STRUCT while
        // drifting the TEXT (an aliased parameter name, a re-ordered query).
        for i in canonical_inputs() {
            let once = build(&i).unwrap();
            let p = parse(&once).unwrap();
            let mut again = i.clone();
            again.host = p.host;
            again.port = p.port;
            again.database = p.database;
            again.user = p.user;
            again.ssl_mode = p.ssl_mode.unwrap();
            again.options = p.options;
            assert_eq!(build(&again).unwrap(), once);
        }
    }

    /// Query-borne credentials must round-trip totally over the hostile alphabet and every
    /// denylisted name (`&`, `=`, `+`, `%` break naive encoding), checked by struct equality.
    #[test]
    fn a_query_borne_credential_round_trips_through_render_and_parse_unchanged() {
        let names = [
            "password",
            "passwd",
            "pwd",
            "pass",
            "auth",
            "token",
            "secret",
            "api_key",
            "api-key",
            "access_key",
            "credentials",
        ];
        let mut checked = 0usize;
        for name in names {
            for secret in crate::db::secret::tests::hostile_secrets() {
                if secret.is_empty() {
                    continue; // an absent password is not a credential
                }
                let text = format!(
                    "postgresql://ro@db.internal:5432/maestro?sslmode=require&{name}={}",
                    encode_query(&secret)
                );
                let p = parse_parts(&text).unwrap_or_else(|e| panic!("{text}: {}", e.message));
                assert_eq!(
                    p.password,
                    PasswordSlot::Value(secret.clone()),
                    "the value must survive percent-decoding byte-for-byte: {text}"
                );
                assert_eq!(p.password_param.as_deref(), Some(name), "{text}");
                assert!(
                    p.options.is_empty(),
                    "a credential must never reach the options: {:?}",
                    p.options
                );
                // Total: the input is already canonical, so rendering it back is byte-identical…
                assert_eq!(render(&p).unwrap(), text);
                // …and re-parsing that gives the same struct, which is the strongest form of the
                // property (a build/parse pair can round-trip the text while drifting the parts).
                assert_eq!(parse_parts(&render(&p).unwrap()).unwrap(), p, "{text}");

                // The stored form: the reference replaces the value in the same parameter, the
                // secret is in neither spelling, and the result is a fixed point of render/parse.
                let stored = render_with_ref(&p, "PG_PROD_PASSWORD").unwrap();
                // Asserted as the WHOLE string, which is what makes it airtight: every other
                // character is fixed, so there is no room left for the secret to hide in.
                assert_eq!(
                    stored,
                    format!(
                        "postgresql://ro@db.internal:5432/maestro\
                         ?sslmode=require&{name}={{{{PG_PROD_PASSWORD}}}}"
                    )
                );
                // Leak checks only for secrets longer than 2 chars: a short one (`-` in `api-key`)
                // can match by accident.
                if secret.len() > 2 {
                    assert!(!stored.contains(&secret), "{stored}");
                    assert!(!stored.contains(&encode_query(&secret)), "{stored}");
                    assert!(!stored.contains(&encode_userinfo(&secret)), "{stored}");
                }
                let reparsed = parse_parts(&stored).unwrap();
                assert_eq!(
                    reparsed.password,
                    PasswordSlot::Ref("{{PG_PROD_PASSWORD}}".to_string())
                );
                assert_eq!(reparsed.password_param.as_deref(), Some(name));
                assert_eq!(render(&reparsed).unwrap(), stored, "not a fixed point");
                checked += 1;
            }
        }
        assert!(checked > 250, "the sweep must be a sweep, got {checked}");
    }

    /// A `{{VAR}}` in a query parameter is written **verbatim**, for the same reason the userinfo
    /// arm is: the string's first job is to show a human their password is not in it, and
    /// `?password=%7B%7BV%7D%7D` does not do that. Parsing still accepts either spelling.
    #[test]
    fn a_reference_in_a_query_parameter_is_readable_and_parses_either_spelling() {
        let p = parse("postgresql://ro@h:5432/d?password={{PG_PASSWORD}}").unwrap();
        assert!(
            !p.had_password,
            "a reference is public, so it is not a password we took out"
        );
        assert_eq!(p.url, "postgresql://ro@h:5432/d?password={{PG_PASSWORD}}");

        let encoded = parse("postgresql://ro@h:5432/d?password=%7B%7BPG_PASSWORD%7D%7D").unwrap();
        assert_eq!(
            encoded.url, p.url,
            "an already-encoded reference normalises to the readable form"
        );
    }

    fn base_engine_of(family: DbFamily) -> DbEngineId {
        match family {
            DbFamily::Postgres => DbEngineId::Postgres,
            DbFamily::Mysql => DbEngineId::Mysql,
            DbFamily::Clickhouse => DbEngineId::Clickhouse,
            DbFamily::Mongodb => DbEngineId::Mongodb,
            DbFamily::Redis => DbEngineId::Redis,
            DbFamily::Dynamodb => DbEngineId::Dynamodb,
        }
    }

    /// DynamoDB has no connection string (`url_schemes` empty, `url` always `null`), so the
    /// round-trip properties skip it instead of inventing a `dynamodb://` scheme.
    fn has_connection_string(family: DbFamily) -> bool {
        family != DbFamily::Dynamodb
    }

    /// For every hostile password, nothing parse or split returns contains it (display URL, stored
    /// URL, any field).
    #[test]
    fn no_hostile_password_ever_survives_into_anything_we_return() {
        for secret in crate::db::secret::tests::hostile_secrets() {
            if secret.is_empty() {
                continue; // an absent password is not a leak
            }
            let encoded = encode_userinfo(&secret);
            for text in [
                format!("postgresql://u:{encoded}@db.internal:5432/maestro?sslmode=require"),
                format!("mysql://u:{encoded}@db.internal:3306/maestro"),
                format!("mongodb+srv://u:{encoded}@cluster0.x.mongodb.net/m?tls=true"),
                format!("redis://:{encoded}@h:6379/0"),
                format!("clickhouse://u@h:8123/d?password={}", encode_query(&secret)),
            ] {
                let p = parse(&text).unwrap_or_else(|e| panic!("{text}: {}", e.message));
                assert!(
                    p.had_password,
                    "{text} — the flag must say a password was there"
                );
                assert!(!p.url.contains(&secret), "raw secret in url: {}", p.url);
                assert!(
                    !p.url.contains(&encoded),
                    "encoded secret in url: {}",
                    p.url
                );
                for field in [&p.host, &p.database, &p.user] {
                    assert!(
                        !field.contains(&secret),
                        "secret leaked into a field: {field}"
                    );
                }
                for (k, v) in &p.options {
                    assert!(!v.contains(&secret), "secret left in option {k}={v}");
                }

                let s = split_url_credentials(&text).unwrap();
                assert!(!s.url.contains(&secret), "stored url: {}", s.url);
                assert!(!s.url.contains(&encoded), "stored url: {}", s.url);
                // The split MUST hand back the exact value — the Vault entry has to work. One
                // field for both positions, which is what folding `?password=` into the single
                // password slot bought.
                assert_eq!(
                    s.password.as_deref(),
                    Some(secret.as_str()),
                    "the split must recover the password byte-for-byte from {text}"
                );
                // …and the re-rendered stored form carries only the reference.
                let stored = render_with_ref(&s.parts, "PG_PROD_PASSWORD").unwrap();
                assert!(stored.contains("{{PG_PROD_PASSWORD}}"), "{stored}");
                assert!(!stored.contains(&secret), "{stored}");
                assert!(!stored.contains(&encoded), "{stored}");
            }
        }
    }

    #[test]
    fn every_scheme_render_can_emit_is_declared_by_its_engine() {
        // The routing guard against `scheme_for` drifting from `EngineSpec::url_schemes` — the
        // one place this module duplicates the registry.
        for spec in ENGINES {
            // DynamoDB declares NO schemes because it has no connection string, so
            // there is nothing for this guard to check — see `has_connection_string`.
            if !has_connection_string(spec.family) {
                assert!(
                    spec.url_schemes.is_empty(),
                    "{:?} has no connection string, so it must declare no schemes",
                    spec.id
                );
                continue;
            }
            for ssl in spec.ssl_modes {
                let scheme = scheme_for(spec.family, false, Some(*ssl), None);
                assert!(
                    spec.url_schemes.contains(&scheme),
                    "{:?} can emit `{scheme}://` but does not declare it in url_schemes",
                    spec.id
                );
            }
            // The SRV variant, for the family that has one.
            let srv = scheme_for(spec.family, true, Some(spec.defaults.ssl_mode), None);
            assert!(
                spec.url_schemes.contains(&srv),
                "{:?} can emit `{srv}://` undeclared",
                spec.id
            );
        }
    }

    #[test]
    fn the_credential_denylist_and_the_ssl_names_do_not_overlap() {
        // If they did, a family's own TLS parameter would be treated as a secret and moved to
        // the Vault, which would be an extremely confusing failure.
        for spec in ENGINES {
            for name in family_ssl_param_names(spec.family) {
                assert!(
                    !is_credential_param(&name.to_ascii_lowercase()),
                    "{name} is both a TLS parameter and on the credential denylist"
                );
            }
        }
    }
}
