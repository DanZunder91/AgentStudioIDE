//! Database tools: everything the DB panel and its console do, for an agent.
//!
//! Rules on top of the module-wide ones ([`crate::agent_ctl`]):
//! * A new connection is read-only (the §G.2 default); making it writable is the user's click.
//!   No tool makes a connection writable, edits or deletes one, or reads a secret back.
//! * A connection that is already saved (same engine, host, port, database and user) is reported
//!   and opened, never changed.
//! * A connection that fails its test is not saved unless the agent passes `force`.
//! * No tool hands an agent a password, a Vault reference or a connection URL. Commands that read
//!   credentials (Redis `CONFIG`, `ACL`, `AUTH`, …) and statements that read the server's files
//!   (PostgreSQL `pg_read_file`, MySQL `LOAD_FILE`, …) are refused, and every reply and event of a
//!   tool that names a saved connection has that connection's password masked where it appears
//!   as written or URL-encoded ([`db_target::secrets_of`]). The mask is a backstop, not a
//!   boundary: a privileged database account can read secrets the server holds and return them in
//!   another form. The boundary is a least-privileged account, and `db_query`'s help says so.
//! * Every other tool names a **saved** connection (id or name, any case — [`db_target`]); its
//!   password is resolved from the Vault inside Rust, and the agent cannot change where it dials.
//! * Queries run through the console's own path and guardrails ([`db_run`]); on a read-only
//!   PostgreSQL or MySQL connection each statement runs in a `READ ONLY` transaction of its own,
//!   ended with a rollback before the next one starts (the session setting alone can be turned
//!   off by a hostile statement).
//!   That stops data writes. What acts on the server itself rather than its data — `COPY …
//!   PROGRAM`, file and large-object functions, `dblink`, `SET GLOBAL` — is refused on every
//!   connection by [`db_refuse`], a text check. Each run, refused ones included, is shown to the
//!   user (`dbQueryRun`).
//! * Everything returned is bounded — rows, bytes, items, time — and every cut is said.

use std::time::Duration;

use serde_json::Value;

use crate::agent_ctl::registry::{Args, Param, ParamKind, ToolCtx, ToolFuture, ToolOk, ToolSpec};
use crate::db::engines::{self, EngineSpec};
use crate::db::model::{DbConnection, DbConnectionInput, DbTestResult, ParsedUrl, SavePassword};
use crate::db::{self, url, Paths};

#[path = "db_browse.rs"]
pub mod db_browse;
#[path = "db_refuse.rs"]
pub mod db_refuse;
#[path = "db_run.rs"]
pub mod db_run;
#[path = "db_saved.rs"]
pub mod db_saved;
#[path = "db_target.rs"]
pub mod db_target;

/// The most text a reply carries (the readable message, and the cell text in the data), in bytes.
pub const TEXT_BUDGET: usize = 64 * 1024;
/// Every database tool answers within this. Below the CLI's own reply timeout, so the agent
/// always hears from the app rather than from a cut connection.
pub const TOOL_DEADLINE: Duration = Duration::from_secs(120);

/// The connection argument, the same in every tool that takes one.
const CONNECTION: Param = Param::new(
    "connection",
    ParamKind::String,
    "A saved connection's name (any case) or id, as `db list` shows them.",
)
.required()
.positional();

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
    ToolSpec {
        name: "db_test",
        cli: &["db", "test"],
        summary: "Test a saved database connection: dial it with its password from Agent \
                  Studio's Vault and report the server version and how long it took.",
        details: "The password is read inside Agent Studio and never shown. A connection that \
                  does not connect exits 1 with the reason.",
        params: &[CONNECTION],
        run: run_test,
    },
    ToolSpec {
        name: "db_open",
        cli: &["db", "open"],
        summary: "Show a saved database connection to the user: the DB panel comes into view \
                  with the connection connected and its tables listed.",
        details: "The app connects with the password from its Vault (never shown here) and \
                  read-only connections stay read-only. Nothing is queried.",
        params: &[CONNECTION],
        run: run_open,
    },
    ToolSpec {
        name: "db_schema",
        cli: &["db", "schema"],
        summary: "Browse a saved connection's objects one level at a time: databases, schemas, \
                  tables, views, collections, columns, keys.",
        details: "Without --path: the top level. --path walks down by name, levels separated by \
                  / (e.g. maestro/public/Tables/tracks lists the columns of tracks); a folder \
                  level such as Tables can be left out (maestro/public/tracks). A / or \\ inside \
                  a name is written \\/ or \\\\ (the Redis key user/1 is db0/Keys/user\\/1). Each \
                  item comes with the path that looks inside it. At most 500 items per level. A \
                  level the tree reads one page of (Redis keys, DynamoDB tables) says so.",
        params: &[
            CONNECTION,
            Param::new(
                "path",
                ParamKind::String,
                "Where to look: names from the top level down, separated by / (a / or \\ in a \
                 name escaped with \\).",
            ),
        ],
        run: run_schema,
    },
    ToolSpec {
        name: "db_search",
        cli: &["db", "search"],
        summary: "Find the tables, views, collections, columns and keys of a saved connection \
                  whose names contain a text (any case).",
        details: "Walks the object tree breadth-first (every table before any column) from the \
                  top or from --path, for at most 300 levels, 20 s and 200 matches, and says \
                  when it stopped early or met a level the tree lists only one page of (Redis \
                  keys, DynamoDB tables); `db query` searches those directly (e.g. SCAN 0 MATCH \
                  \"*text*\" COUNT 1000).",
        params: &[
            CONNECTION,
            Param::new(
                "pattern",
                ParamKind::String,
                "The text to look for in names (any case).",
            )
            .required()
            .positional(),
            Param::new(
                "path",
                ParamKind::String,
                "Search only below this place (names separated by /, as `db schema` shows).",
            ),
        ],
        run: run_search,
    },
    ToolSpec {
        name: "db_query",
        cli: &["db", "query"],
        summary: "Run a query or command on a saved connection through Agent Studio's console \
                  and its guardrails, and show the rows as a table.",
        details: "The DB console's own path: one statement per run unless the connection \
                  allows multiple statements, and the connection's timeout applies. On a \
                  read-only PostgreSQL or MySQL connection each statement runs in a read-only \
                  transaction of its own, ended (with a rollback) before the next one starts; \
                  other engines refuse writes by command. Read-only stops data writes, not everything: an agent acts with the \
                  database account's privileges, so use a least-privileged account for agent \
                  work. A text check, not a boundary, refuses statements that reach the server \
                  itself: PostgreSQL COPY, DO, LOAD, file, large-object, dblink and session \
                  functions, set_config, SET ROLE; MySQL file reads and writes, KILL, SET \
                  GLOBAL, executable comments, and CALL/EXECUTE on a read-only connection; \
                  Redis/Valkey CONFIG, ACL, AUTH, HELLO … AUTH, MONITOR, SENTINEL. The \
                  connection's password is masked in replies where it appears as written or \
                  URL-encoded; an account that can read the server's files or settings can still \
                  read secrets the server holds. SQL engines take SQL; MongoDB a JSON command \
                  document (or SQL that maps to one); Redis and Valkey a command line; DynamoDB \
                  PartiQL. Another database on the same server is named in the query where the \
                  engine allows it (db.table, \"$db\"); a PostgreSQL connection is bound to its \
                  database. Rows: --limit, default 100, at most 1000; the reply is capped at \
                  64 KB and says what was cut. A query that starts with -- goes in --query. The \
                  user sees each run, with its results, in the connection's console tab. A \
                  database error is a result (exit 0); a refusal by Agent Studio exits 1.",
        params: &[
            CONNECTION,
            Param::new(
                "query",
                ParamKind::String,
                "The query or command to run (quote it).",
            )
            .required()
            .positional(),
            Param::new(
                "limit",
                ParamKind::Integer,
                "Rows to read per statement: default 100, at most 1000.",
            ),
        ],
        run: run_query,
    },
    ToolSpec {
        name: "db_console",
        cli: &["db", "console"],
        summary: "Open a query console tab in Agent Studio for a saved connection, with a query \
                  typed in but not run, for the user to read and run.",
        details: "A console the user is already writing in is left as it is: the query is \
                  shown to them in the DB panel instead, with a button that puts it in the \
                  console.",
        params: &[
            CONNECTION,
            Param::new(
                "query",
                ParamKind::String,
                "The query to type into the console (it is not run).",
            )
            .positional(),
        ],
        run: run_console,
    },
    ToolSpec {
        name: "db_queries",
        cli: &["db", "queries"],
        summary: "List the queries saved for a connection in Agent Studio, with their text.",
        details: "",
        params: &[CONNECTION],
        run: run_queries,
    },
    ToolSpec {
        name: "db_save_query",
        cli: &["db", "save", "query"],
        summary: "Save a query under a name in a connection's saved queries in Agent Studio, \
                  where the user finds it in the DB panel. Never overwrites one.",
        details: "Always adds: a name that is already taken gets a second query beside the \
                  first, and the reply says so.",
        params: &[
            CONNECTION,
            Param::new("name", ParamKind::String, "What to call it.")
                .required()
                .positional(),
            Param::new("query", ParamKind::String, "The query text (quote it).")
                .required()
                .positional(),
        ],
        run: run_save_query,
    },
];

/// Drop whole lines from the end of `lines` until what is left fits in `budget` bytes (each
/// line counted with its newline). Returns how many lines were dropped.
pub fn text_budget_cut(lines: &mut Vec<String>, budget: usize) -> usize {
    let mut used = 0usize;
    let mut keep = 0usize;
    for line in lines.iter() {
        let size = line.len() + 1;
        if used + size > budget {
            break;
        }
        used += size;
        keep += 1;
    }
    let dropped = lines.len() - keep;
    lines.truncate(keep);
    dropped
}

/// The last word on size: a reply longer than [`TEXT_BUDGET`] (plus room for the sentence that
/// says so) is cut at a character boundary, and says it was.
pub fn hard_cap(mut text: String) -> String {
    const ROOM: usize = 4 * 1024;
    if text.len() <= TEXT_BUDGET + ROOM {
        return text;
    }
    let mut at = TEXT_BUDGET;
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    text.truncate(at);
    text.push_str("\n… (cut at 64 KB; --json carries the structured data.)");
    text
}

/// The secrets of the connection `arg` names (none when it names none): what [`scrubbed`] masks.
fn secrets_for(paths: &Paths, arg: &str) -> Vec<String> {
    db_target::load_and_resolve(paths, arg)
        .map(|c| db_target::secrets_of(paths, &c))
        .unwrap_or_default()
}

/// A tool's reply — message, data or refusal — with `secrets` masked in every string of it. The
/// last word on secrets for every tool that names a saved connection, whatever the server sent.
fn scrubbed(result: Result<(String, Value), String>, secrets: &[String]) -> Result<ToolOk, String> {
    match result {
        Ok((message, mut data)) => {
            db_target::redact_json(&mut data, secrets);
            Ok(ToolOk::new(db_target::redact(&message, secrets), data))
        }
        Err(e) => Err(db_target::redact(&e, secrets)),
    }
}

fn run_open(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let c = db_target::load_and_resolve(&ctx.db_paths(), args.req_str("connection")?)?;
        ctx.emit("dbOpen", serde_json::json!({"connectionId": c.id}));
        Ok(ToolOk::new(
            format!(
                "Showing \"{}\" ({}, {}) in Agent Studio's DB panel, connected, with its tables.",
                c.name,
                target_label(&c),
                access_label(c.read_only)
            ),
            summary(&c),
        ))
    })
}

fn run_test(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let (paths, connection) = (ctx.db_paths(), args.req_str("connection")?);
        let secrets = secrets_for(&paths, connection);
        scrubbed(db_browse::db_test(&paths, connection).await, &secrets)
    })
}

fn run_schema(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let (paths, connection) = (ctx.db_paths(), args.req_str("connection")?);
        let secrets = secrets_for(&paths, connection);
        let read = db_browse::db_schema(&paths, connection, args.str("path").unwrap_or("")).await;
        scrubbed(read, &secrets)
    })
}

fn run_search(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let (paths, connection) = (ctx.db_paths(), args.req_str("connection")?);
        let secrets = secrets_for(&paths, connection);
        let found = db_browse::db_search(
            &paths,
            connection,
            args.str("pattern").unwrap_or(""),
            args.str("path").unwrap_or(""),
        )
        .await;
        scrubbed(found, &secrets)
    })
}

fn run_query(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let connection = args.req_str("connection")?.to_string();
        let query = args.str("query").unwrap_or("").to_string();
        let paths = ctx.db_paths();
        let (target, result) = db_run::run(
            &paths,
            &connection,
            &query,
            args.int("limit"),
            db_run::app_deadline(),
        )
        .await;
        let secrets = target
            .as_ref()
            .map(|c| db_target::secrets_of(&paths, c))
            .unwrap_or_default();
        // Every run on a known connection is shown to the user — a refused one too, because an
        // agent that tried to write to a read-only database is exactly what the user must see.
        if let Some(c) = &target {
            let (results, error) = match &result {
                Ok(report) => (serde_json::to_value(&report.results).ok(), None),
                Err(e) => (Some(serde_json::json!([])), Some(e.clone())),
            };
            let mut payload = serde_json::json!({
                "connectionId": c.id,
                "query": query,
                "results": results,
                "error": error,
                "notes": result.as_ref().map(|r| r.notes.clone()).unwrap_or_default(),
            });
            db_target::redact_json(&mut payload, &secrets);
            ctx.emit("dbQueryRun", payload);
        }
        scrubbed(result.map(|r| (r.message(), r.data())), &secrets)
    })
}

fn run_console(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let query = args.str("query").filter(|q| !q.trim().is_empty());
        let paths = ctx.db_paths();
        let c = db_saved::db_console(&paths, args.req_str("connection")?, query)?;
        ctx.emit(
            "dbConsole",
            serde_json::json!({ "connectionId": c.id, "query": query }),
        );
        let reply = (
            db_saved::console_message(&c, query.is_some()),
            serde_json::json!({
                "connection": summary(&c),
                "query": query,
                "run": false,
            }),
        );
        scrubbed(Ok(reply), &db_target::secrets_of(&paths, &c))
    })
}

fn run_queries(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let (paths, connection) = (ctx.db_paths(), args.req_str("connection")?);
        let secrets = secrets_for(&paths, connection);
        scrubbed(db_saved::db_queries(&paths, connection), &secrets)
    })
}

fn run_save_query(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let paths = ctx.db_paths();
        let report = db_saved::db_save_query(
            &paths,
            args.req_str("connection")?,
            args.str("name").unwrap_or(""),
            args.str("query").unwrap_or(""),
        )?;
        ctx.emit(
            "dbSavedQuery",
            serde_json::json!({
                "connectionId": report.connection.id,
                "queryId": report.saved.id,
            }),
        );
        let secrets = db_target::secrets_of(&paths, &report.connection);
        scrubbed(Ok((report.message(), report.data())), &secrets)
    })
}

fn run_connect(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let url = args.req_str("url")?.to_string();
        let name = args.str("name").map(str::to_string);
        let report = db_connect(&ctx.db_paths(), &url, name.as_deref(), args.bool("force")).await?;
        // Shown connected only when it is known to connect: an already-saved one, or a new one
        // whose test passed. A `--force` save of a dead server is not dialled again.
        let open = !report.created || report.test.as_ref().is_some_and(|t| t.ok);
        ctx.emit(
            "dbConnection",
            serde_json::json!({
                "connectionId": report.connection.id,
                "created": report.created,
                "open": open,
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

#[cfg(test)]
#[path = "db_tools_tests.rs"]
mod tools_tests;
