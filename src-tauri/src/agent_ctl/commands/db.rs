//! Database tools.
//!
//! Rules on top of the module-wide ones ([`crate::agent_ctl`]):
//! * A new connection is read-only (the §G.2 default); making it writable is the user's click.
//! * A connection that is already saved (same engine, host, port, database and user) is reported
//!   and opened, never changed.
//! * A connection that fails its test is not saved unless the agent passes `force`.
//! * Nothing an agent sees carries a password, a Vault reference or a connection URL.

use crate::agent_ctl::registry::{Args, Param, ParamKind, ToolCtx, ToolFuture, ToolOk, ToolSpec};
use crate::db::engines::{self, EngineSpec};
use crate::db::model::{DbConnection, DbConnectionInput, DbTestResult, ParsedUrl, SavePassword};
use crate::db::{self, url, Paths};

pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "db_connect",
        cli: &["db", "connect"],
        summary: "Add a database connection to Agent Studio from a connection URL, test it and \
                  open it in the DB panel.",
        details: "url: postgres://, postgresql://, mysql://, mariadb://, clickhouse://, \
                  clickhouses://, mongodb://, mongodb+srv://, redis://, rediss:// or valkey:// \
                  (quote it). The password moves \
                  into Agent Studio's Vault and is never printed back. New connections are \
                  read-only; the user can make one writable in the DB panel. A connection that \
                  fails its test is not saved unless force is set. A URL naming a Vault \
                  variable ({{…}}) is refused.",
        params: &[
            Param::new(
                "url",
                ParamKind::String,
                "The connection URL, password included.",
            )
            .required()
            .positional(),
            Param::new(
                "name",
                ParamKind::String,
                "A name for it (default: database@host).",
            ),
            Param::new(
                "force",
                ParamKind::Bool,
                "Save it even when the connection test fails.",
            ),
        ],
        run: run_connect,
    },
    ToolSpec {
        name: "db_list",
        cli: &["db", "list"],
        summary: "List the database connections saved in Agent Studio (no secrets).",
        details: "",
        params: &[],
        run: run_list,
    },
];

fn run_connect(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let url = args.req_str("url")?.to_string();
        let name = args.str("name").map(str::to_string);
        let report = db_connect(&ctx.db_paths(), &url, name.as_deref(), args.bool("force")).await?;
        ctx.emit(
            "dbConnection",
            serde_json::json!({
                "connectionId": report.connection.id,
                "created": report.created,
            }),
        );
        Ok(ToolOk::new(report.message(), report.data()))
    })
}

fn run_list(ctx: ToolCtx, _args: Args) -> ToolFuture {
    Box::pin(async move {
        let store = db::store::load(&ctx.db_paths().store);
        Ok(ToolOk::new(
            list_message(&store.connections),
            serde_json::Value::Array(store.connections.iter().map(summary).collect()),
        ))
    })
}

/// What `db connect` did.
#[derive(Debug, Clone, PartialEq)]
pub struct DbConnectReport {
    pub connection: DbConnection,
    /// `false`: an identical connection was already saved, and nothing was written.
    pub created: bool,
    /// The connection test. `None` for an already-saved connection (not re-tested).
    pub test: Option<DbTestResult>,
}

impl DbConnectReport {
    pub fn message(&self) -> String {
        let c = &self.connection;
        let target = target_label(c);
        if !self.created {
            return format!(
                "Already in Agent Studio as \"{}\" ({target}, {}); nothing was changed. \
                 Opened it in the DB panel.",
                c.name,
                access_label(c.read_only)
            );
        }
        let mut lines = Vec::new();
        match &self.test {
            Some(t) if t.ok => lines.push(format!(
                "Connected to {target}{}{}.",
                t.server_version
                    .as_deref()
                    .map(|v| format!(" ({})", short_version(v)))
                    .unwrap_or_default(),
                t.latency_ms
                    .map(|ms| format!(" in {ms} ms"))
                    .unwrap_or_default(),
            )),
            Some(t) => lines.push(format!(
                "Saved WITHOUT a working connection (--force): {}",
                t.error.as_deref().unwrap_or("the test failed.")
            )),
            None => {}
        }
        lines.push(format!(
            "Saved in Agent Studio as \"{}\" ({}) and opened in the DB panel.",
            c.name,
            access_label(c.read_only)
        ));
        if !c.password_ref.is_empty() {
            lines.push(format!(
                "The password is in Agent Studio's Vault as {}; it is not stored in the \
                 connection and is never printed.",
                c.password_ref
            ));
        }
        if c.read_only {
            lines.push(
                "The user can make it writable in the DB panel (Edit connection).".to_string(),
            );
        }
        lines.join("\n")
    }

    pub fn data(&self) -> serde_json::Value {
        serde_json::json!({
            "created": self.created,
            "connection": summary(&self.connection),
            "test": self.test,
        })
    }
}

/// Add the connection `url_text` describes. `Err` is the sentence the agent is shown.
pub async fn db_connect(
    paths: &Paths,
    url_text: &str,
    name: Option<&str>,
    force: bool,
) -> Result<DbConnectReport, String> {
    let text = url_text.trim();
    if text.is_empty() {
        return Err(
            "Give a connection URL, for example postgres://user:password@host:5432/database."
                .to_string(),
        );
    }
    // Before any parse: a reference anywhere in the string (password, user, a query parameter)
    // would be resolved against the user's Vault on connect.
    if text.contains("{{") {
        return Err(
            "That URL names an Agent Studio Vault variable ({{…}}). Agents cannot use the \
             user's saved secrets: put the password itself in the URL, or ask the user to \
             add the connection in the DB panel."
                .to_string(),
        );
    }
    let parsed = url::parse(text).map_err(|e| e.message)?;
    let split = url::split_url_credentials(text).map_err(|e| e.message)?;
    let engine = parsed.engine.ok_or_else(|| {
        format!(
            "Agent Studio cannot tell which database that URL is for. Use one of: {}.",
            scheme_list()
        )
    })?;
    let spec = engines::require_spec(engine).map_err(|e| e.message)?;
    let input = input_from_parsed(&parsed, &split, spec, name)?;

    let existing = db::store::load(&paths.store)
        .connections
        .into_iter()
        .find(|c| same_target(c, &input, spec));
    if let Some(connection) = existing {
        return Ok(DbConnectReport {
            connection,
            created: false,
            test: None,
        });
    }

    let test = match db::test_connection(paths, input.clone(), split.password.clone()).await {
        Ok(t) => t,
        Err(e) => DbTestResult {
            ok: false,
            server_version: None,
            latency_ms: None,
            error: Some(e.message),
        },
    };
    if !test.ok && !force {
        return Err(format!(
            "Could not connect to {}: {}\nNothing was saved. Check the URL, or run again with \
             --force to save it anyway.",
            input_target_label(&input, spec),
            test.error.as_deref().unwrap_or("the test failed.")
        ));
    }
    let connection = db::upsert(paths, input, split.password.as_deref()).map_err(|e| e.message)?;
    Ok(DbConnectReport {
        connection,
        created: true,
        test: Some(test),
    })
}

/// The dialog's paste, done server-side: the same fields `applyParsedUrl` sets, the stripped URL,
/// the password-parameter hint, the engine's defaults, and **read-only**.
pub fn input_from_parsed(
    parsed: &ParsedUrl,
    split: &url::SplitCredentials,
    spec: &EngineSpec,
    name: Option<&str>,
) -> Result<DbConnectionInput, String> {
    let ssl_mode = match parsed.ssl_mode {
        Some(mode) if spec.ssl_modes.contains(&mode) => mode,
        // Refused, not downgraded: a connection that quietly uses a weaker TLS mode than the
        // string asked for is the divergence the dialog warns about.
        Some(mode) => {
            return Err(format!(
                "{} does not offer the SSL mode that URL asks for ({}).",
                spec.label,
                serde_json::to_value(mode)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default()
            ))
        }
        None => spec.defaults.ssl_mode,
    };
    let mut options = std::collections::BTreeMap::new();
    for f in spec.extra_fields {
        if !f.default.is_empty() {
            options.insert(f.key.to_string(), f.default.to_string());
        }
    }
    options.extend(parsed.options.clone());
    let database = if spec.database_label.is_some() {
        parsed.database.clone()
    } else {
        String::new()
    };
    let user = if spec.supports_user {
        parsed.user.clone()
    } else {
        String::new()
    };
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_name(&parsed.host, &database, spec));
    Ok(DbConnectionInput {
        id: None,
        name,
        engine: spec.id,
        family: None,
        host: parsed.host.clone(),
        port: parsed.port,
        srv: parsed.srv,
        database,
        user,
        password_ref: String::new(),
        save_password: SavePassword::Forever,
        url: Some(split.url.clone()),
        password_param: split.password_param.clone(),
        ssl_mode,
        ca_summary: None,
        options,
        read_only: true,
        row_limit: spec.defaults.row_limit,
        timeout_ms: spec.defaults.timeout_ms,
        allow_multi_statement: spec.defaults.allow_multi_statement,
    })
}

/// `shop@db.example.com`, or `db.example.com` for an engine without a database.
pub fn default_name(host: &str, database: &str, spec: &EngineSpec) -> String {
    let host = if host.is_empty() { spec.label } else { host };
    if database.is_empty() {
        host.to_string()
    } else {
        format!("{database}@{host}")
    }
}

/// The same server, database and user as a saved connection. An empty port is the engine's
/// default, so `host` and `host:5432` are the same Postgres.
pub fn same_target(c: &DbConnection, input: &DbConnectionInput, spec: &EngineSpec) -> bool {
    let port = |p: Option<u16>| p.unwrap_or(spec.default_port);
    c.engine == input.engine
        && c.host.eq_ignore_ascii_case(&input.host)
        && c.srv == input.srv
        && (c.srv || port(c.port) == port(input.port))
        && c.database == input.database
        && c.user == input.user
}

/// Every URL scheme the registry parses, as `postgres://, …`.
pub fn scheme_list() -> String {
    let mut schemes: Vec<&str> = engines::ENGINES
        .iter()
        .flat_map(|e| e.url_schemes.iter().copied())
        .collect();
    schemes.dedup();
    schemes
        .iter()
        .map(|s| format!("{s}://"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn access_label(read_only: bool) -> &'static str {
    if read_only {
        "read-only"
    } else {
        "read-write"
    }
}

/// The first line of a server's version banner, trimmed for a one-line message
/// (Postgres's `version()` is a whole sentence about the compiler).
pub fn short_version(v: &str) -> String {
    let first = v.lines().next().unwrap_or(v).trim();
    match first.find(" on ") {
        Some(i) => first[..i].to_string(),
        None => first.to_string(),
    }
}

/// `PostgreSQL at host:5432/db`.
pub fn target_label(c: &DbConnection) -> String {
    let spec = engines::spec_for(c.engine);
    let label = spec.map(|s| s.label).unwrap_or("database");
    let port = if c.srv {
        String::new()
    } else {
        c.port
            .or(spec.map(|s| s.default_port))
            .map(|p| format!(":{p}"))
            .unwrap_or_default()
    };
    let db = if c.database.is_empty() {
        String::new()
    } else {
        format!("/{}", c.database)
    };
    format!("{label} at {}{port}{db}", c.host)
}

fn input_target_label(input: &DbConnectionInput, spec: &EngineSpec) -> String {
    let port = if input.srv {
        String::new()
    } else {
        format!(":{}", input.port.unwrap_or(spec.default_port))
    };
    let db = if input.database.is_empty() {
        String::new()
    } else {
        format!("/{}", input.database)
    };
    format!("{} at {}{port}{db}", spec.label, input.host)
}

/// A connection as an agent may see it: no password, no Vault reference, no URL.
pub fn summary(c: &DbConnection) -> serde_json::Value {
    serde_json::json!({
        "id": c.id,
        "name": c.name,
        "engine": c.engine,
        "host": c.host,
        "port": c.port,
        "database": c.database,
        "user": c.user,
        "readOnly": c.read_only,
    })
}

fn list_message(connections: &[DbConnection]) -> String {
    if connections.is_empty() {
        return "No database connections are saved in Agent Studio. Add one with \
                `agent-studio db connect <url>`."
            .to_string();
    }
    let mut lines = vec![format!(
        "{} database connection{} in Agent Studio:",
        connections.len(),
        if connections.len() == 1 { "" } else { "s" }
    )];
    for c in connections {
        lines.push(format!(
            "  {}  —  {} ({})",
            c.name,
            target_label(c),
            access_label(c.read_only)
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
#[path = "db_tests.rs"]
mod tests;
