//! Agent control: what an agent running in an Agent Studio terminal can ask the app to do.
//!
//! The user says "connect me to postgres://…" to whatever agent they are talking to; the agent
//! runs `agent-studio db connect <url>` ([`cli`]), and the connection appears in the DB panel,
//! tested, with its password in the Vault. Every agent can do this — a `claude` the IDE launched,
//! one the user typed into a plain terminal, a non-Claude agent — because the only requirement is
//! a shell in one of our PTYs.
//!
//! # The channel
//!
//! No new server and no network exposure. Requests go to the hook listener that already exists
//! ([`crate::hook_listener`]), on `127.0.0.1`, as `POST /ctl` carrying the same per-launch token
//! and terminal id every PTY already has in its environment. A process without the token is
//! dropped before a byte of its body is read; the terminal id says who asked.
//!
//! # What an agent may and may not do
//!
//! The agent already holds whatever the user typed into the conversation, so a URL with a literal
//! password gives it nothing new. What it must never get is the user's **saved** secrets:
//!
//! * A URL that names a Vault variable (`{{VAR}}`) is refused. Otherwise an agent could point a
//!   connection at a host of its choosing and have the app send the user's secret there
//!   (ADR-0025 §5, the same risk the import review exists for).
//! * Nothing is ever printed back that contains a password; the reply names the Vault variable
//!   the password went into, never its value.
//! * A new connection is read-only (the §G.2 default). Making it writable is the user's click in
//!   the DB panel.
//! * A connection that is already saved (same engine, host, port, database and user) is reported
//!   and opened, never changed.
//! * A connection that fails its test is not saved unless the agent passes `--force`, so a typo
//!   does not leave a broken row in the panel.

pub mod cli;
pub mod tools;

use serde::{Deserialize, Serialize};

use crate::db::engines::{self, EngineSpec};
use crate::db::model::{DbConnection, DbConnectionInput, DbTestResult, ParsedUrl, SavePassword};
use crate::db::{self, url, Paths};

/// The path the listener routes to [`handle`].
pub const CTL_PATH: &str = "/ctl";

/// The Tauri event the webview listens on for what an agent just did.
pub const EVENT: &str = "agent-ctl://event";

/// One request, as the CLI sends it (JSON, tagged by `command`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command")]
pub enum CtlRequest {
    /// Add a database connection from a connection URL, test it and open it in the DB panel.
    #[serde(rename = "db.connect")]
    DbConnect {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        /// Save it even when the connection test fails.
        #[serde(default)]
        force: bool,
    },
    /// The saved connections, without secrets.
    #[serde(rename = "db.list")]
    DbList,
}

/// The reply. `message` is what the CLI prints; `data` is what `--json` prints.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CtlResponse {
    pub ok: bool,
    pub message: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

impl CtlResponse {
    fn ok(message: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            ok: true,
            message: message.into(),
            data,
        }
    }

    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            data: serde_json::Value::Null,
        }
    }
}

/// What the webview is told, so the user sees what an agent did and which terminal asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CtlEvent {
    #[serde(rename_all = "camelCase")]
    DbConnection {
        connection_id: String,
        terminal_id: String,
        /// `false` when the connection was already saved and only opened.
        created: bool,
    },
}

/// The outcome of one request: the HTTP status, the reply, and the event to emit (if any).
#[derive(Debug, Clone, PartialEq)]
pub struct CtlOutcome {
    pub status: u16,
    pub response: CtlResponse,
    pub event: Option<CtlEvent>,
}

impl CtlOutcome {
    fn reply(status: u16, response: CtlResponse) -> Self {
        Self {
            status,
            response,
            event: None,
        }
    }
}

/// Handle one authenticated request body. Path-injected, so tests run it against a temp dir.
pub async fn handle(paths: &Paths, terminal_id: &str, body: &[u8]) -> CtlOutcome {
    let request: CtlRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return CtlOutcome::reply(
                400,
                CtlResponse::err(format!(
                    "Agent Studio did not understand that request ({e}). The `agent-studio` \
                     command and the app may be different versions: restart the terminal."
                )),
            )
        }
    };
    match request {
        CtlRequest::DbConnect { url, name, force } => {
            match db_connect(paths, &url, name.as_deref(), force).await {
                Ok(report) => {
                    let event = CtlEvent::DbConnection {
                        connection_id: report.connection.id.clone(),
                        terminal_id: terminal_id.to_string(),
                        created: report.created,
                    };
                    CtlOutcome {
                        status: 200,
                        response: CtlResponse::ok(report.message(), report.data()),
                        event: Some(event),
                    }
                }
                Err(message) => CtlOutcome::reply(422, CtlResponse::err(message)),
            }
        }
        CtlRequest::DbList => {
            let store = db::store::load(&paths.store);
            CtlOutcome::reply(
                200,
                CtlResponse::ok(
                    list_message(&store.connections),
                    serde_json::Value::Array(store.connections.iter().map(summary).collect()),
                ),
            )
        }
    }
}

/// The listener's `/ctl` handler for the real app: [`handle`] against the real stores, then the
/// event that makes the DB panel show what the agent did. Real boot only (`lib.rs`).
pub fn tauri_handler(app: tauri::AppHandle) -> std::sync::Arc<crate::hook_listener::CtlHandler> {
    std::sync::Arc::new(move |terminal_id: String, body: Vec<u8>| {
        let app = app.clone();
        Box::pin(async move {
            let outcome = handle(&Paths::of(&app), &terminal_id, &body).await;
            if let Some(event) = &outcome.event {
                use tauri::Emitter as _;
                let _ = app.emit(EVENT, event);
            }
            let body = serde_json::to_vec(&outcome.response).unwrap_or_default();
            (outcome.status, body)
        }) as crate::hook_listener::CtlFuture
    })
}

/* ─────────────────────────────── db connect ─────────────────────────────── */

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
    fn message(&self) -> String {
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

    fn data(&self) -> serde_json::Value {
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
fn same_target(c: &DbConnection, input: &DbConnectionInput, spec: &EngineSpec) -> bool {
    let port = |p: Option<u16>| p.unwrap_or(spec.default_port);
    c.engine == input.engine
        && c.host.eq_ignore_ascii_case(&input.host)
        && c.srv == input.srv
        && (c.srv || port(c.port) == port(input.port))
        && c.database == input.database
        && c.user == input.user
}

fn scheme_list() -> String {
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

fn access_label(read_only: bool) -> &'static str {
    if read_only {
        "read-only"
    } else {
        "read-write"
    }
}

/// The first line of a server's version banner, trimmed for a one-line message
/// (Postgres's `version()` is a whole sentence about the compiler).
fn short_version(v: &str) -> String {
    let first = v.lines().next().unwrap_or(v).trim();
    match first.find(" on ") {
        Some(i) => first[..i].to_string(),
        None => first.to_string(),
    }
}

fn target_label(c: &DbConnection) -> String {
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
fn summary(c: &DbConnection) -> serde_json::Value {
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
mod tests;
