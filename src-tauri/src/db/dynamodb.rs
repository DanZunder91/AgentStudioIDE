//! DynamoDB: one SigV4-signed HTTPS `POST /` per request, PartiQL queries. Signing is ours (no
//! SDK) and pinned to AWS's published test vectors, since dynamodb-local skips signature checks.
//! No session token, credential discovery or retries; read-only is a `SELECT`-only filter.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use ring::{digest, hmac};
use serde_json::{json, Value};

use crate::db::engine::{DbEngine, DbSession, Limits, ResolvedConfig, Script, ServerInfo};
use crate::db::engines::{self, EngineSpec};
use crate::db::error::{DbError, DbErrorCode};
use crate::db::guard;
use crate::db::model::DbEngineId;
use crate::db::result::{cell_kind, DbCellKind, DbColumn, DbResultKind, DbResultSet};
use crate::db::tree::{DbGroup, DbNode, DbNodeKind, DbNodeRef};

/// The service name in the SigV4 credential scope. Not configurable: it is part of what is signed.
const SERVICE: &str = "dynamodb";

/// `ListTables` pages at 100 by default; this is the tree's page, bounded for the same reason the
/// Redis key page is — a rail is not a place to render 4000 tables, and the sub-label says so.
const TABLE_PAGE: i64 = 100;

pub struct DynamodbEngine;

#[async_trait]
impl DbEngine for DynamodbEngine {
    fn spec(&self) -> &'static EngineSpec {
        engines::spec_for(DbEngineId::Dynamodb).expect("the DynamoDB row exists")
    }

    async fn open(&self, cfg: &ResolvedConfig) -> Result<Box<dyn DbSession>, DbError> {
        crate::tls::install_crypto_provider();
        let creds = Credentials::from_config(cfg)?;
        let endpoint = Endpoint::from_config(cfg)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(u64::from(cfg.timeout_ms)))
            .build()
            .map_err(|e| {
                DbError::invalid_config(format!("The HTTP client could not be built: {e}"))
            })?;

        let session = DynamodbSession {
            client,
            endpoint,
            creds,
            read_only: cfg.read_only,
        };
        // A real round trip before `open` returns. HTTP is stateless, so without this a connection
        // to a region that does not exist — or with credentials that are refused — would be
        // reported as working, and Test Connection would be a lie (ClickHouse needs the same).
        session.call("ListTables", json!({ "Limit": 1 })).await?;
        Ok(Box::new(session))
    }
}

pub struct DynamodbSession {
    client: reqwest::Client,
    endpoint: Endpoint,
    creds: Credentials,
    read_only: bool,
}

impl DynamodbSession {
    fn secrets(&self) -> Vec<&str> {
        vec![self.creds.secret_access_key.as_str()]
    }

    /// One signed `POST /` — the whole transport for this engine.
    async fn call(&self, target: &str, body: Value) -> Result<Value, DbError> {
        let payload = body.to_string();
        let now = SigningTime::now();
        let signed = sign(&self.creds, &self.endpoint, target, &payload, &now, SERVICE);

        let mut request = self
            .client
            .post(self.endpoint.url())
            .header("content-type", "application/x-amz-json-1.0")
            .header("x-amz-target", format!("DynamoDB_20120810.{target}"))
            .header("x-amz-date", now.amz_date())
            .header("authorization", signed.authorization)
            .body(payload);
        if let Some(host) = self.endpoint.host_header() {
            request = request.header("host", host);
        }

        let response = request
            .send()
            .await
            .map_err(|e| map_transport_error(&e).redacted(&self.secrets()))?;

        let status = response.status();
        let text = response.text().await.map_err(|e| {
            DbError::new(
                DbErrorCode::Unknown,
                format!("The response body could not be read: {e}"),
            )
            .redacted(&self.secrets())
        })?;

        if status.is_success() {
            return serde_json::from_str(&text).map_err(|e| {
                DbError::new(
                    DbErrorCode::Unknown,
                    format!("DynamoDB's reply was not JSON: {e}"),
                )
            });
        }
        Err(map_service_error(status, &text).redacted(&self.secrets()))
    }
}

#[async_trait]
impl DbSession for DynamodbSession {
    async fn probe(&mut self) -> Result<ServerInfo, DbError> {
        // DynamoDB has no version string; the probe proves the credentials work for this region and
        // names the endpoint.
        self.call("ListTables", json!({ "Limit": 1 })).await?;
        Ok(ServerInfo {
            version: format!("DynamoDB · {}", self.endpoint.describe()),
            // No session, so no backend id. `cancel` below says the same thing in words.
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
        // Every statement is vetted before any of them runs, so a script cannot execute halfway
        // (it matters more here because there is no transaction to roll back).
        if self.read_only {
            for statement in &statements {
                if let Some(refusal) = read_only_refusal(statement) {
                    return Err(refusal);
                }
            }
        }

        let mut sets = Vec::with_capacity(statements.len());
        for statement in &statements {
            let started = Instant::now();
            // `Limit` is a **transport** hint, not a rewrite of the user's query: it caps items per
            // page. We ask for cap+1 across pages so `truncated` is MEASURED rather than inferred
            // from `rows.len() == row_limit`.
            let want = limits.row_limit as usize;
            let mut items: Vec<Value> = Vec::new();
            let mut next_token: Option<String> = None;
            let mut truncated = false;

            loop {
                let mut body = json!({ "Statement": statement });
                if let Some(token) = &next_token {
                    body["NextToken"] = json!(token);
                }
                let reply = match self.call("ExecuteStatement", body).await {
                    Ok(v) => v,
                    // A statement DynamoDB refused is an outcome of the statement, not a failure of
                    // the call — the `http_send` contract, as for every other engine here.
                    Err(e) if e.code == DbErrorCode::InvalidStatement => {
                        sets.push(DbResultSet::message(
                            statement.as_str(),
                            e.message,
                            limits.row_limit,
                        ));
                        return Ok(sets);
                    }
                    Err(e) => return Err(e),
                };

                if let Some(Value::Array(page)) = reply.get("Items").cloned() {
                    items.extend(page);
                }
                if items.len() > want {
                    items.truncate(want);
                    truncated = true;
                    break;
                }
                next_token = reply
                    .get("NextToken")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if next_token.is_none() {
                    break;
                }
            }

            sets.push(shape(
                statement,
                &items,
                truncated,
                limits.row_limit,
                started.elapsed().as_millis() as u64,
            ));
        }
        Ok(sets)
    }

    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        match node {
            // Flat: a region holds tables. A single `Tables` group keeps the level structure every
            // other engine's tree has, so one `<DbTree/>` renders them all.
            DbNodeRef::Root => Ok(vec![DbNode::new(
                DbNodeRef::Group {
                    database: String::new(),
                    schema: None,
                    group: DbGroup::Tables,
                },
                DbGroup::Tables.label(),
                DbNodeKind::Group,
                true,
            )
            .with_sub_label(self.endpoint.region.clone())]),

            DbNodeRef::Group {
                group: DbGroup::Tables,
                ..
            } => {
                let reply = self
                    .call("ListTables", json!({ "Limit": TABLE_PAGE }))
                    .await?;
                let names: Vec<String> = reply
                    .get("TableNames")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                // A page boundary is stated rather than hidden: `LastEvaluatedTableName` present
                // means there are more, and a tree that silently showed 100 of 400 tables would be
                // the kind of quiet truncation the row cap exists to prevent.
                let more = reply.get("LastEvaluatedTableName").is_some();
                Ok(names
                    .into_iter()
                    .map(|name| {
                        let node = DbNode::new(
                            DbNodeRef::Table {
                                database: String::new(),
                                schema: None,
                                name: name.clone(),
                            },
                            name,
                            DbNodeKind::Table,
                            true,
                        );
                        if more {
                            node.with_sub_label("first 100 tables in this region")
                        } else {
                            node
                        }
                    })
                    .collect())
            }

            // A table's children are its key schema and indexes, not "columns": items have no fixed
            // attributes.
            DbNodeRef::Table { name, .. } => {
                let reply = self
                    .call("DescribeTable", json!({ "TableName": name }))
                    .await?;
                let table = reply.get("Table").cloned().unwrap_or(Value::Null);
                Ok(key_and_index_nodes(name, &table))
            }

            _ => Ok(Vec::new()),
        }
    }

    async fn close(self: Box<Self>) {
        // Nothing to close: every request is its own HTTP round trip and there is no session state
        // on the service side.
    }
}

/* ────────────────────────────── the tree's leaves ────────────────────────────── */

/// A table's key attributes and secondary indexes, as leaf nodes (pure over a `DescribeTable`
/// reply).
pub fn key_and_index_nodes(table: &str, described: &Value) -> Vec<DbNode> {
    let mut out = Vec::new();

    // The attribute *types* are declared on the table (only key attributes are), so the sub-label
    // is the service's own word — `S`, `N`, `B` — expanded to something readable beside it.
    let declared: BTreeMap<String, String> = described
        .get("AttributeDefinitions")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    Some((
                        d.get("AttributeName")?.as_str()?.to_string(),
                        d.get("AttributeType")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    for key in described
        .get("KeySchema")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let Some(name) = key.get("AttributeName").and_then(Value::as_str) else {
            continue;
        };
        // HASH is the partition key and RANGE the sort key. The service's words are HASH/RANGE; the
        // words a user reads in the console are the documented ones, because "HASH" tells them
        // nothing about which value a PartiQL `WHERE` must pin.
        let role = match key.get("KeyType").and_then(Value::as_str) {
            Some("HASH") => "partition key",
            Some("RANGE") => "sort key",
            other => other.unwrap_or("key"),
        };
        let kind = declared
            .get(name)
            .map(|t| format!("{role} · {}", attribute_type_label(t)))
            .unwrap_or_else(|| role.to_string());
        // `nullable: false` is true here: the service rejects an item that omits a key attribute.
        out.push(DbNode::column("", None, table, name, &kind, false));
    }

    for (field, label) in [
        ("GlobalSecondaryIndexes", "global secondary index"),
        ("LocalSecondaryIndexes", "local secondary index"),
    ] {
        for index in described
            .get(field)
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
        {
            let Some(name) = index.get("IndexName").and_then(Value::as_str) else {
                continue;
            };
            out.push(
                DbNode::new(
                    DbNodeRef::Table {
                        database: String::new(),
                        schema: None,
                        name: name.to_string(),
                    },
                    name,
                    DbNodeKind::View,
                    false,
                )
                .with_sub_label(label),
            );
        }
    }
    out
}

/// `S`/`N`/`B` → the word the AWS console uses, so a key's type is readable.
fn attribute_type_label(t: &str) -> &str {
    match t {
        "S" => "string",
        "N" => "number",
        "B" => "binary",
        other => other,
    }
}

/* ────────────────────────────── PartiQL results ────────────────────────────── */

/// DynamoDB items → one [`DbResultSet`]. Columns are the union of attributes seen, sorted
/// (serde_json `Map` is a `BTreeMap`; attributes have no declared order). `None` means NULL or
/// absent, and the notice says so.
pub fn shape(
    statement: &str,
    items: &[Value],
    truncated: bool,
    row_limit: u32,
    duration_ms: u64,
) -> DbResultSet {
    let mut names: Vec<String> = Vec::new();
    for item in items {
        if let Some(obj) = item.as_object() {
            for key in obj.keys() {
                if !names.contains(key) {
                    names.push(key.clone());
                }
            }
        }
    }

    let mut absent: BTreeMap<&str, usize> = BTreeMap::new();
    let mut types: BTreeMap<&str, &'static str> = BTreeMap::new();
    // The presence mask: `true` where the item does not have the
    // attribute at all, so the grid paints `missing` rather than reading the cell as NULL. Built
    // alongside the rows, and sent only when something really is absent.
    let mut mask: Vec<Vec<bool>> = Vec::with_capacity(items.len());
    let rows: Vec<Vec<Option<String>>> = items
        .iter()
        .map(|item| {
            let obj = item.as_object().cloned().unwrap_or_default();
            let mut row_mask = Vec::with_capacity(names.len());
            let row = names
                .iter()
                .map(|name| match obj.get(name) {
                    Some(v) => {
                        let (type_tag, cell) = attribute(v);
                        types.entry(name.as_str()).or_insert(type_tag);
                        row_mask.push(false);
                        cell
                    }
                    None => {
                        *absent.entry(name.as_str()).or_insert(0) += 1;
                        row_mask.push(true);
                        None
                    }
                })
                .collect();
            mask.push(row_mask);
            row
        })
        .collect();
    let any_absent = mask.iter().flatten().any(|m| *m);

    let columns: Vec<DbColumn> = names
        .iter()
        .map(|name| {
            let type_name = types.get(name.as_str()).copied().unwrap_or("unknown");
            DbColumn {
                name: name.clone(),
                type_name: type_name.to_string(),
                kind: cell_kind_for(type_name),
            }
        })
        .collect();

    // When the data has more states than the contract, the loss goes where the person looking at
    // the data will see it.
    let notice = (!absent.is_empty()).then(|| {
        let mut parts: Vec<String> = absent
            .iter()
            .map(|(name, n)| format!("`{name}` in {n} of {}", rows.len()))
            .collect();
        parts.sort();
        format!(
            "DynamoDB items have no fixed attributes, and these were absent from some of them: {}. \
             Those cells show NULL because a result cell has only two states — an absent attribute \
             is NOT a null.",
            parts.join(", ")
        )
    });

    DbResultSet {
        kind: DbResultKind::Rows,
        statement: statement.to_string(),
        columns,
        rows,
        rows_affected: None,
        truncated,
        row_limit,
        duration_ms,
        notice,
        absent: any_absent.then_some(mask),
    }
}

/// One attribute value → `(type tag, cell)`. `N` arrives as a string and stays one: up to 38
/// significant digits, more than an `f64` holds.
fn attribute(value: &Value) -> (&'static str, Option<String>) {
    let Some(obj) = value.as_object() else {
        // Not an attribute-value wrapper at all. Rendered rather than dropped, so a surprise in the
        // wire format is visible in the grid instead of appearing as an empty column.
        return ("unknown", Some(value.to_string()));
    };
    let Some((tag, inner)) = obj.iter().next() else {
        return ("unknown", None);
    };
    match tag.as_str() {
        "NULL" => ("null", None),
        "S" => ("string", inner.as_str().map(str::to_string)),
        "N" => ("number", inner.as_str().map(str::to_string)),
        "BOOL" => ("boolean", inner.as_bool().map(|b| b.to_string())),
        // Binary is base64 on the wire and stays base64 — it is what the service returned, and
        // decoding it to bytes we would then hex-encode adds a lossy step for nothing.
        "B" => ("binary", inner.as_str().map(str::to_string)),
        "SS" | "NS" | "BS" => ("set", Some(compact(inner))),
        "L" => ("list", Some(compact(inner))),
        "M" => ("map", Some(compact(inner))),
        other => (
            match other {
                "" => "unknown",
                _ => "unknown",
            },
            Some(compact(inner)),
        ),
    }
}

/// A nested list/map/set as compact JSON — the same choice `mongo.rs` makes for a nested document.
fn compact(value: &Value) -> String {
    value.to_string()
}

/// A DynamoDB type tag → how the grid should align it. Routed through the shared [`cell_kind`] for
/// the tags that have a SQL-ish equivalent, so one table decides alignment for every engine.
fn cell_kind_for(type_name: &str) -> DbCellKind {
    match type_name {
        "set" | "list" | "map" => DbCellKind::Json,
        "binary" => DbCellKind::Binary,
        "null" | "unknown" => DbCellKind::Unknown,
        other => cell_kind(other),
    }
}

/* ────────────────────────────── the read-only filter ────────────────────────────── */

/// PartiQL a read-only connection may run: default-deny, only a leading `SELECT` passes.
pub fn read_only_refusal(statement: &str) -> Option<DbError> {
    let first = statement
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if first == "SELECT" {
        return None;
    }
    Some(DbError::blocked(format!(
        "This connection is read-only, so `{}` was refused before it ran. DynamoDB has no \
         read-only session setting — that is an IAM property of the credential — so this app \
         allows only `SELECT` here. For a real guarantee, point the connection at a read-only IAM \
         role; untick \"Read-only\" in this connection's settings if you mean to write.",
        if first.is_empty() {
            "that statement"
        } else {
            &first
        }
    )))
}

/* ────────────────────────────── credentials and endpoint ────────────────────────────── */

/// Static credentials for signing. `Debug` is hand-written so the secret key never reaches a panic
/// or `{:?}`.
#[derive(Clone)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .finish()
    }
}

impl Credentials {
    fn from_config(cfg: &ResolvedConfig) -> Result<Self, DbError> {
        let access_key_id = cfg.user.trim().to_string();
        if access_key_id.is_empty() {
            return Err(DbError::invalid_config(
                "DynamoDB needs an AWS access key id in the user field. It is not a secret — the \
                 secret access key is the password, and it goes to the Vault.",
            ));
        }
        if cfg.password.is_empty() {
            return Err(DbError::secret_missing(
                "DynamoDB needs the AWS secret access key as this connection's password.",
            ));
        }
        // A stated limitation, refused rather than silently ignored: a session token is a
        // second secret and there is nowhere in the contract for it to live yet.
        if cfg
            .options
            .keys()
            .any(|k| k.eq_ignore_ascii_case("sessionToken"))
        {
            return Err(DbError::invalid_config(
                "Temporary credentials are not supported yet: a session token is a second secret, \
                 and this build can hold only one per connection (it would otherwise be persisted \
                 in plain text, which this app does not do). Use a long-lived access key, or an \
                 IAM role's key pair.",
            ));
        }
        Ok(Self {
            access_key_id,
            secret_access_key: cfg.password.clone(),
        })
    }
}

/// Where to send the request, and which region to sign for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub region: String,
    /// The full origin (`https://dynamodb.eu-west-1.amazonaws.com` or an override).
    origin: String,
    /// The value of the signed `host` header.
    host: String,
}

impl Endpoint {
    fn from_config(cfg: &ResolvedConfig) -> Result<Self, DbError> {
        let region = cfg
            .options
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("region"))
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default();
        if region.is_empty() {
            return Err(DbError::invalid_config(
                "DynamoDB needs a region. It is part of every signed request, so it cannot be \
                 guessed — the wrong region reaches a different set of tables and looks like an \
                 empty account.",
            ));
        }
        let override_endpoint = cfg
            .options
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("endpoint"))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty());

        Self::build(&region, override_endpoint.as_deref())
    }

    /// Pure, so every endpoint decision is unit-testable without a config.
    pub fn build(region: &str, override_endpoint: Option<&str>) -> Result<Self, DbError> {
        // The region goes into the signature, so a stray character in it is a signing failure with
        // a confusing message rather than a validation error with a clear one.
        if !region
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(DbError::invalid_config(format!(
                "`{region}` is not a region name. Regions look like `eu-west-1`."
            )));
        }
        match override_endpoint {
            None => Ok(Self {
                region: region.to_string(),
                origin: format!("https://{SERVICE}.{region}.amazonaws.com"),
                host: format!("{SERVICE}.{region}.amazonaws.com"),
            }),
            Some(raw) => {
                let trimmed = raw.trim_end_matches('/');
                let rest = trimmed
                    .strip_prefix("http://")
                    .or_else(|| trimmed.strip_prefix("https://"))
                    .ok_or_else(|| {
                        DbError::invalid_config(format!(
                            "`{raw}` is not a usable endpoint. Include the scheme, e.g. \
                             `http://127.0.0.1:8000`."
                        ))
                    })?;
                if rest.is_empty() || rest.contains('/') {
                    return Err(DbError::invalid_config(format!(
                        "`{raw}` is not a usable endpoint: it must be a host and optional port, \
                         with no path."
                    )));
                }
                Ok(Self {
                    region: region.to_string(),
                    origin: trimmed.to_string(),
                    host: rest.to_string(),
                })
            }
        }
    }

    fn url(&self) -> String {
        format!("{}/", self.origin)
    }

    /// The `host` header value. `reqwest` sets one itself from the URL, but SigV4 signs the header
    /// we declare — so it is sent explicitly to guarantee the signed value and the sent value are
    /// the same string. That mismatch is the single commonest cause of a hand-rolled SigV4 failing.
    fn host_header(&self) -> Option<&str> {
        Some(self.host.as_str())
    }

    fn describe(&self) -> String {
        format!("{} · {}", self.region, self.host)
    }
}

/* ────────────────────────────── SigV4 ────────────────────────────── */

/// The two timestamps a signature needs, taken once so the `x-amz-date` header and the credential
/// scope cannot disagree — a one-second boundary between two `now()` calls is a 403 that reproduces
/// roughly never.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigningTime {
    /// `YYYYMMDDTHHMMSSZ`
    amz_date: String,
    /// `YYYYMMDD`
    date_stamp: String,
}

impl SigningTime {
    fn now() -> Self {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        Self::from_unix(secs)
    }

    /// Pure, so the signer's tests can pin AWS's published vectors, whose timestamps are fixed.
    pub fn from_unix(secs: i64) -> Self {
        let (y, mo, d, h, mi, s) = civil_from_unix(secs);
        Self {
            amz_date: format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z"),
            date_stamp: format!("{y:04}{mo:02}{d:02}"),
        }
    }

    pub fn amz_date(&self) -> &str {
        &self.amz_date
    }
}

/// Days-from-epoch → civil date, Howard Hinnant's algorithm. Hand-rolled for the same reason
/// `usage.rs` hand-rolls RFC-3339: a date library is a dependency for six lines of arithmetic.
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (
        year,
        m,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

/// What [`sign`] produced.
#[derive(Debug, PartialEq, Eq)]
pub struct Signed {
    pub authorization: String,
    /// Exposed for the tests that pin AWS's vectors; never logged.
    pub canonical_request: String,
    pub string_to_sign: String,
    pub signature: String,
}

/// SigV4-sign one request. Exactly the headers sent are signed: `content-type`, `host`,
/// `x-amz-date`, `x-amz-target`.
pub fn sign(
    creds: &Credentials,
    endpoint: &Endpoint,
    target: &str,
    payload: &str,
    now: &SigningTime,
    service: &str,
) -> Signed {
    let payload_hash = hex(digest::digest(&digest::SHA256, payload.as_bytes()).as_ref());
    // Canonical headers: lower-cased names, sorted, trimmed values, each `name:value\n`.
    let headers: Vec<(String, String)> = vec![
        (
            "content-type".to_string(),
            "application/x-amz-json-1.0".to_string(),
        ),
        ("host".to_string(), endpoint.host.clone()),
        ("x-amz-date".to_string(), now.amz_date.clone()),
        (
            "x-amz-target".to_string(),
            format!("DynamoDB_20120810.{target}"),
        ),
    ];
    let signed_headers = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect::<String>();

    // POST to `/` with no query string, which is every DynamoDB request.
    let canonical_request =
        format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!(
        "{}/{}/{service}/aws4_request",
        now.date_stamp, endpoint.region
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        now.amz_date,
        hex(digest::digest(&digest::SHA256, canonical_request.as_bytes()).as_ref())
    );

    let signature = hex(&signing_key_chain(
        &creds.secret_access_key,
        &now.date_stamp,
        &endpoint.region,
        service,
        string_to_sign.as_bytes(),
    ));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, \
         Signature={signature}",
        creds.access_key_id
    );
    Signed {
        authorization,
        canonical_request,
        string_to_sign,
        signature,
    }
}

/// `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")` then the final
/// HMAC over the string to sign — the derived-key chain that makes a signature scoped to one day,
/// one region and one service.
fn signing_key_chain(
    secret: &str,
    date_stamp: &str,
    region: &str,
    service: &str,
    message: &[u8],
) -> Vec<u8> {
    let mut key = format!("AWS4{secret}").into_bytes();
    for part in [date_stamp, region, service, "aws4_request"] {
        key = hmac_sha256(&key, part.as_bytes());
    }
    hmac_sha256(&key, message)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    hmac::sign(&key, message).as_ref().to_vec()
}

/// Lower-case hex, which is what SigV4 requires (an upper-case digest is a 403).
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/* ────────────────────────────── errors ────────────────────────────── */

/// A `reqwest` failure — no HTTP response at all.
fn map_transport_error(e: &reqwest::Error) -> DbError {
    if e.is_timeout() {
        return DbError::new(
            DbErrorCode::Timeout,
            "The request to DynamoDB timed out.".to_string(),
        );
    }
    if e.is_connect() {
        let text = e.to_string().to_ascii_lowercase();
        if text.contains("certificate") || text.contains("tls") {
            return DbError::new(
                DbErrorCode::Tls,
                format!("The TLS connection to DynamoDB failed. ({e})"),
            );
        }
        return DbError::new(
            DbErrorCode::Network,
            format!(
                "DynamoDB could not be reached — check the region and any endpoint override. ({e})"
            ),
        );
    }
    DbError::new(DbErrorCode::Unknown, format!("The request failed: {e}"))
}

/// A non-2xx reply. DynamoDB puts the error type in `__type` (`…#ValidationException`) and the
/// prose in `message`; the **type** is the reliable discriminator and the prose is what a person
/// needs, so both are used.
fn map_service_error(status: reqwest::StatusCode, body: &str) -> DbError {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let error_type = parsed
        .get("__type")
        .and_then(Value::as_str)
        .map(|t| t.rsplit('#').next().unwrap_or(t).to_string())
        .unwrap_or_default();
    let message = parsed
        .get("message")
        .or_else(|| parsed.get("Message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let detail = if message.is_empty() {
        format!("HTTP {status}")
    } else {
        message
    };

    match error_type.as_str() {
        // Signing and credential failures. Deliberately NOT `invalid-config`: the settings may be
        // perfect and the key simply wrong or expired.
        "InvalidSignatureException"
        | "UnrecognizedClientException"
        | "MissingAuthenticationTokenException" => DbError::new(
            DbErrorCode::Auth,
            format!("DynamoDB rejected these credentials. {detail}"),
        ),
        "AccessDeniedException" => DbError::new(
            DbErrorCode::Auth,
            format!(
                "This IAM identity is not allowed to do that. {detail} \
                 (DynamoDB read-only is an IAM property, not a setting this app can send.)"
            ),
        ),
        // A statement problem, which is a RESULT rather than a rejection — the code whose detail
        // the frontend renders verbatim, and here the service's own words name the exact fix.
        "ValidationException" | "ResourceNotFoundException" => DbError::invalid_statement(detail),
        "ProvisionedThroughputExceededException"
        | "RequestLimitExceeded"
        | "ThrottlingException" => DbError::new(
            DbErrorCode::Timeout,
            format!("DynamoDB throttled this request. {detail}"),
        ),
        // The panel renders a `blocked` detail verbatim, so each refusal gets our own sentence.
        "ItemCollectionSizeLimitExceededException" => DbError::blocked(
            "DynamoDB refused that write: the item collection for that partition key has reached \
             the size limit a local secondary index imposes. No setting here can lift it — the \
             items have to be spread across more partition keys.",
        ),
        "TransactionConflictException" => DbError::blocked(
            "DynamoDB refused that statement because another request is writing the same item \
             right now. This one is transient — run it again.",
        ),
        _ if status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::UNAUTHORIZED =>
        {
            DbError::new(
                DbErrorCode::Auth,
                format!("DynamoDB refused the request. {detail}"),
            )
        }
        _ => DbError::new(
            DbErrorCode::Unknown,
            format!("DynamoDB said: {detail} ({error_type} HTTP {status})"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ─────────────────────── SigV4, against AWS's own vectors ─────────────────────── */

    /// AWS's published SigV4 example values (key AKIDEXAMPLE, 20150830T123600Z, us-east-1, iam).
    /// The live tier cannot catch a broken signer (dynamodb-local skips signature checks), so this
    /// does.
    #[test]
    fn the_derived_signing_key_matches_aws_published_value() {
        // AWS's documented intermediate: HMAC chain over "AWS4"+secret → date → region → service →
        // "aws4_request". The published expected signing key for the example above.
        let key_bytes = {
            let mut key =
                format!("AWS4{}", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY").into_bytes();
            for part in ["20150830", "us-east-1", "iam", "aws4_request"] {
                key = hmac_sha256(&key, part.as_bytes());
            }
            key
        };
        assert_eq!(
            hex(&key_bytes),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
            "the derived signing key is AWS's published value"
        );
    }

    /// The full chain, end to end, against AWS's published `string to sign` and `signature` for
    /// their example GET request. This pins [`signing_key_chain`]'s final HMAC too.
    #[test]
    fn the_final_signature_matches_aws_published_value() {
        let string_to_sign = concat!(
            "AWS4-HMAC-SHA256\n",
            "20150830T123600Z\n",
            "20150830/us-east-1/iam/aws4_request\n",
            "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59"
        );
        let signature = hex(&signing_key_chain(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20150830",
            "us-east-1",
            "iam",
            string_to_sign.as_bytes(),
        ));
        assert_eq!(
            signature, "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
            "AWS's published signature for its own example request"
        );
    }

    #[test]
    fn the_canonical_request_has_the_exact_shape_sigv4_requires() {
        let now = SigningTime {
            amz_date: "20150830T123600Z".to_string(),
            date_stamp: "20150830".to_string(),
        };
        let endpoint = Endpoint::build("us-east-1", None).expect("endpoint");
        let signed = sign(&creds(), &endpoint, "ListTables", "{}", &now, SERVICE);

        // Line by line, because every one of these is a 403 when wrong: method, path, empty query,
        // canonical headers each `name:value\n`, blank line, signed-header list, payload hash.
        let lines: Vec<&str> = signed.canonical_request.split('\n').collect();
        assert_eq!(lines[0], "POST");
        assert_eq!(lines[1], "/");
        assert_eq!(lines[2], "", "no query string");
        assert_eq!(lines[3], "content-type:application/x-amz-json-1.0");
        assert_eq!(lines[4], "host:dynamodb.us-east-1.amazonaws.com");
        assert_eq!(lines[5], "x-amz-date:20150830T123600Z");
        assert_eq!(lines[6], "x-amz-target:DynamoDB_20120810.ListTables");
        assert_eq!(lines[7], "", "the blank line after the canonical headers");
        assert_eq!(lines[8], "content-type;host;x-amz-date;x-amz-target");
        // SHA-256 of `{}`, the smallest real payload.
        assert_eq!(
            lines[9],
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );

        // The header list in the Authorization header must be the SAME list, or the server
        // canonicalises a different set than we signed.
        assert!(
            signed
                .authorization
                .contains("SignedHeaders=content-type;host;x-amz-date;x-amz-target"),
            "{}",
            signed.authorization
        );
        assert!(
            signed.authorization.starts_with(
                "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/dynamodb/aws4_request"
            ),
            "{}",
            signed.authorization
        );
    }

    #[test]
    fn the_signature_covers_the_body_so_two_payloads_never_share_one() {
        let now = SigningTime::from_unix(1_440_938_160);
        let endpoint = Endpoint::build("eu-west-1", None).expect("endpoint");
        let a = sign(
            &creds(),
            &endpoint,
            "ExecuteStatement",
            r#"{"Statement":"SELECT * FROM \"a\""}"#,
            &now,
            SERVICE,
        );
        let b = sign(
            &creds(),
            &endpoint,
            "ExecuteStatement",
            r#"{"Statement":"DELETE FROM \"a\""}"#,
            &now,
            SERVICE,
        );
        assert_ne!(a.signature, b.signature, "the payload hash is signed");
        // …and the region is in the scope, so a signature cannot be replayed against another one.
        let other_region = Endpoint::build("us-east-1", None).expect("endpoint");
        let c = sign(
            &creds(),
            &other_region,
            "ExecuteStatement",
            r#"{"Statement":"SELECT * FROM \"a\""}"#,
            &now,
            SERVICE,
        );
        assert_ne!(a.signature, c.signature);
    }

    #[test]
    fn the_secret_never_appears_in_anything_the_signer_returns() {
        // The one failure mode that is NOT safe. A wrong signature denies access; a leaked
        // key is unrecoverable, so this is asserted rather than reasoned about.
        let now = SigningTime::from_unix(1_440_938_160);
        let endpoint = Endpoint::build("eu-west-1", None).expect("endpoint");
        let signed = sign(&creds(), &endpoint, "ListTables", "{}", &now, SERVICE);
        for field in [
            &signed.authorization,
            &signed.canonical_request,
            &signed.string_to_sign,
            &signed.signature,
        ] {
            assert!(
                !field.contains("wJalrXUtnFEMI"),
                "the secret key leaked into a signer output: {field}"
            );
        }
        // The access key id is PUBLIC and must be there — it is how AWS finds the key to verify.
        assert!(signed.authorization.contains("AKIDEXAMPLE"));
    }

    fn creds() -> Credentials {
        // AWS's own published example credentials. Not a real key — and it is the value their
        // documentation uses precisely so implementations can be compared against it.
        Credentials {
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
        }
    }

    #[test]
    fn the_timestamp_pair_is_taken_once_and_agrees_with_itself() {
        // 20150830T123600Z. A `date_stamp` derived from a second `now()` could land on the next day
        // and produce a scope that disagrees with the header — a 403 that reproduces almost never.
        let t = SigningTime::from_unix(1_440_938_160);
        assert_eq!(t.amz_date, "20150830T123600Z");
        assert_eq!(t.date_stamp, "20150830");
        assert!(t.amz_date.starts_with(&t.date_stamp));
        // A leap day, because the civil-date arithmetic is hand-rolled.
        let leap = SigningTime::from_unix(1_582_934_400); // 2020-02-29T00:00:00Z
        assert_eq!(leap.amz_date, "20200229T000000Z");
        assert_eq!(SigningTime::from_unix(0).amz_date, "19700101T000000Z");
    }

    /* ─────────────────────── the endpoint ─────────────────────── */

    #[test]
    fn a_region_becomes_the_real_service_host() {
        let e = Endpoint::build("eu-west-1", None).expect("endpoint");
        assert_eq!(e.url(), "https://dynamodb.eu-west-1.amazonaws.com/");
        assert_eq!(e.host_header(), Some("dynamodb.eu-west-1.amazonaws.com"));
    }

    #[test]
    fn an_override_is_how_dynamodb_local_is_addressed_and_it_keeps_its_scheme() {
        let e = Endpoint::build("eu-west-1", Some("http://127.0.0.1:8000")).expect("endpoint");
        assert_eq!(e.url(), "http://127.0.0.1:8000/");
        // 🔴 The signed `host` header must match what is SENT, port included — the commonest cause
        // of a hand-rolled SigV4 failing against a non-AWS endpoint.
        assert_eq!(e.host_header(), Some("127.0.0.1:8000"));
        // The region still travels in the signature even against a local endpoint.
        assert_eq!(e.region, "eu-west-1");
        // A trailing slash is tolerated rather than producing `//`.
        assert_eq!(
            Endpoint::build("eu-west-1", Some("http://127.0.0.1:8000/"))
                .unwrap()
                .url(),
            "http://127.0.0.1:8000/"
        );
    }

    #[test]
    fn a_bad_region_or_endpoint_is_refused_with_a_reason() {
        // A stray character in a region would otherwise become a signing failure with a confusing
        // message instead of a validation error with a clear one.
        for bad in ["EU-WEST-1", "eu west 1", "eu_west_1"] {
            let err = Endpoint::build(bad, None).expect_err(bad);
            assert_eq!(err.code, DbErrorCode::InvalidConfig);
            assert!(err.message.contains("region"), "{}", err.message);
        }
        for bad in ["127.0.0.1:8000", "http://host/path", "https://"] {
            assert!(Endpoint::build("eu-west-1", Some(bad)).is_err(), "{bad}");
        }
    }

    /* ─────────────────────── credentials ─────────────────────── */

    fn cfg() -> ResolvedConfig {
        let mut options = BTreeMap::new();
        options.insert("region".to_string(), "eu-west-1".to_string());
        ResolvedConfig {
            engine: DbEngineId::Dynamodb,
            family: crate::db::model::DbFamily::Dynamodb,
            host: String::new(),
            port: None,
            srv: false,
            database: String::new(),
            user: "AKIDEXAMPLE".to_string(),
            password: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
            url: None,
            ssl_mode: crate::db::model::SslMode::VerifyFull,
            ca_pem: None,
            options,
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    #[test]
    fn debug_on_the_credentials_never_prints_the_secret() {
        // The leak that is only ever found when someone pastes a panic message into a chat.
        let printed = format!("{:?}", creds());
        assert!(
            printed.contains("AKIDEXAMPLE"),
            "the key id is public: {printed}"
        );
        assert!(!printed.contains("wJalrXUtnFEMI"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
    }

    #[test]
    fn the_access_key_is_the_user_and_the_secret_is_the_password() {
        let c = Credentials::from_config(&cfg()).expect("credentials");
        assert_eq!(c.access_key_id, "AKIDEXAMPLE");
        assert_eq!(
            c.secret_access_key,
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
        );
    }

    #[test]
    fn a_missing_key_or_secret_says_which_one_and_which_field() {
        let mut c = cfg();
        c.user = "  ".to_string();
        let err = Credentials::from_config(&c).expect_err("no key id");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("access key id"), "{}", err.message);

        let mut c = cfg();
        c.password = String::new();
        let err = Credentials::from_config(&c).expect_err("no secret");
        // `secret-missing`, whose sentence points at the Vault — not `invalid-config`, which would
        // send the user to check a region that is fine.
        assert_eq!(err.code, DbErrorCode::SecretMissing);
    }

    #[test]
    fn a_session_token_is_refused_with_the_limitation_named() {
        // A stated limitation (no temporary credentials). Refused, never silently ignored — a temporary
        // credential that "connected" and then failed every request an hour later would be worse.
        let mut c = cfg();
        c.options.insert(
            "sessionToken".to_string(),
            "{{AWS_SESSION_TOKEN}}".to_string(),
        );
        let err = Credentials::from_config(&c).expect_err("session token");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("second secret"), "{}", err.message);
    }

    #[test]
    fn a_missing_region_is_refused_because_it_cannot_be_guessed() {
        let mut c = cfg();
        c.options.clear();
        let err = Endpoint::from_config(&c).expect_err("no region");
        assert_eq!(err.code, DbErrorCode::InvalidConfig);
        assert!(err.message.contains("cannot be guessed"), "{}", err.message);
    }

    /* ─────────────────────── the read-only filter ─────────────────────── */

    #[test]
    fn read_only_allows_select_and_refuses_every_write_verb() {
        assert!(read_only_refusal("SELECT * FROM \"tracks\"").is_none());
        assert!(read_only_refusal("  select pk from \"tracks\"").is_none());
        for statement in [
            "INSERT INTO \"tracks\" VALUE {'pk': '1'}",
            "UPDATE \"tracks\" SET duration = 1 WHERE pk = '1'",
            "DELETE FROM \"tracks\" WHERE pk = '1'",
            "EXECUTE something",
            "",
        ] {
            let err = read_only_refusal(statement).unwrap_or_else(|| panic!("{statement:?}"));
            assert_eq!(err.code, DbErrorCode::Blocked, "{statement:?}");
            // 🔴 The message must name IAM, because that is the only real boundary here — a badge
            // that implied the app was enforcing one would promise a boundary that is not there.
            assert!(err.message.contains("IAM"), "{}", err.message);
        }
    }

    /* ─────────────────────── result shaping ─────────────────────── */

    fn item(pairs: &[(&str, Value)]) -> Value {
        let mut m = serde_json::Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        Value::Object(m)
    }

    #[test]
    fn attribute_values_are_unwrapped_and_a_number_stays_a_string() {
        let items = vec![item(&[
            ("pk", json!({ "S": "Amberline" })),
            ("duration", json!({ "N": "0.5000" })),
            ("ok", json!({ "BOOL": true })),
            ("gone", json!({ "NULL": true })),
        ])];
        let set = shape("SELECT * FROM \"t\"", &items, false, 500, 1);

        let col = |name: &str| set.columns.iter().position(|c| c.name == name).unwrap();
        assert_eq!(set.rows[0][col("pk")], Some("Amberline".to_string()));
        // 🔴 A DynamoDB number holds up to 38 significant digits, which no f64 can. Parsing one to
        // re-render it would silently change a value (the same holds for ClickHouse decimals).
        assert_eq!(set.rows[0][col("duration")], Some("0.5000".to_string()));
        assert_eq!(set.columns[col("duration")].kind, DbCellKind::Number);
        assert_eq!(set.rows[0][col("ok")], Some("true".to_string()));
        // An explicit NULL attribute is a NULL cell, not the string "true".
        assert_eq!(set.rows[0][col("gone")], None);
    }

    #[test]
    fn a_38_digit_number_survives_exactly() {
        let big = "12345678901234567890123456789012345678";
        let items = vec![item(&[("n", json!({ "N": big }))])];
        let set = shape("SELECT * FROM \"t\"", &items, false, 500, 1);
        assert_eq!(set.rows[0][0], Some(big.to_string()));
    }

    #[test]
    fn the_columns_are_the_union_and_an_absent_attribute_is_named_in_the_notice() {
        // 🔴 DynamoDB is schemaless, so two items in one table can have different attributes. The
        // contract has two cell states and the data has three (present, NULL, absent), so the loss
        // goes in the OUTPUT, exactly as MongoDB does it.
        let items = vec![
            item(&[("pk", json!({ "S": "a" })), ("note", json!({ "S": "x" }))]),
            item(&[("pk", json!({ "S": "b" }))]),
        ];
        let set = shape("SELECT * FROM \"t\"", &items, false, 500, 1);
        // Alphabetical, because `serde_json` sorted the item's keys on parse. This
        // assertion used to claim `["pk", "note"]` ("first-seen order") and was WRONG; the honest
        // version pins what actually happens and the doc comment says why it is acceptable here.
        assert_eq!(
            set.columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["note", "pk"]
        );
        let note = set.columns.iter().position(|c| c.name == "note").unwrap();
        assert_eq!(
            set.rows[1][note], None,
            "the item without `note` has a NULL cell"
        );
        let notice = set.notice.as_deref().unwrap_or_default();
        assert!(notice.contains("`note` in 1 of 2"), "{notice}");
        assert!(notice.contains("is NOT a null"), "{notice}");
    }

    #[test]
    fn a_nested_list_or_map_renders_as_compact_json_and_is_a_json_column() {
        let items = vec![item(&[
            ("tags", json!({ "SS": ["a", "b"] })),
            ("meta", json!({ "M": { "studio": { "S": "harbor" } } })),
        ])];
        let set = shape("SELECT * FROM \"t\"", &items, false, 500, 1);
        // Column order is alphabetical (`serde_json` sorts), so the cell is found by
        // NAME. Reading it positionally is what made the first version of this test fail.
        let col = |name: &str| set.columns.iter().position(|c| c.name == name).unwrap();
        assert!(set.rows[0][col("tags")]
            .as_deref()
            .unwrap_or_default()
            .contains("\"a\""));
        assert!(set.rows[0][col("meta")]
            .as_deref()
            .unwrap_or_default()
            .contains("harbor"));
        assert_eq!(set.columns[col("tags")].kind, DbCellKind::Json);
        assert_eq!(set.columns[col("meta")].kind, DbCellKind::Json);
    }

    #[test]
    fn a_zero_item_result_is_still_rows_with_no_columns_to_invent() {
        let set = shape("SELECT * FROM \"t\"", &[], false, 500, 1);
        assert_eq!(set.kind, DbResultKind::Rows);
        assert!(
            set.columns.is_empty(),
            "a schemaless empty result has no columns"
        );
        assert!(set.rows.is_empty());
        assert_eq!(set.notice, None);
    }

    /* ─────────────────────── the flat tree ─────────────────────── */

    #[test]
    fn a_table_shows_its_key_schema_and_its_indexes_and_calls_them_what_they_are() {
        // A captured `DescribeTable` shape, so the parsing is pinned hermetically rather than only
        // against a live table.
        let described = json!({
            "AttributeDefinitions": [
                { "AttributeName": "pk", "AttributeType": "S" },
                { "AttributeName": "ts", "AttributeType": "N" }
            ],
            "KeySchema": [
                { "AttributeName": "pk", "KeyType": "HASH" },
                { "AttributeName": "ts", "KeyType": "RANGE" }
            ],
            "GlobalSecondaryIndexes": [{ "IndexName": "by-studio" }]
        });
        let nodes = key_and_index_nodes("tracks", &described);
        let label = |i: usize| nodes[i].sub_label.clone().unwrap_or_default();
        assert_eq!(nodes[0].label, "pk");
        // "partition key", not "HASH"; `· not null` is true since key attributes are required.
        assert_eq!(label(0), "partition key · string · not null");
        assert_eq!(label(1), "sort key · number · not null");
        assert_eq!(nodes[2].label, "by-studio");
        assert_eq!(label(2), "global secondary index");
        assert_eq!(nodes[2].kind, DbNodeKind::View);
    }

    #[test]
    fn a_table_with_no_indexes_or_an_empty_reply_yields_no_phantom_nodes() {
        assert!(key_and_index_nodes("t", &Value::Null).is_empty());
        assert!(key_and_index_nodes("t", &json!({})).is_empty());
        // A key whose type was not declared still gets a node — the role is the useful part.
        let nodes = key_and_index_nodes(
            "t",
            &json!({ "KeySchema": [{ "AttributeName": "pk", "KeyType": "HASH" }] }),
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            nodes[0].sub_label.as_deref(),
            Some("partition key · not null")
        );
    }

    /* ─────────────────────── errors ─────────────────────── */

    #[test]
    fn a_validation_exception_is_a_statement_problem_carrying_the_services_words() {
        let body = r#"{"__type":"com.amazon.coral.validate#ValidationException","message":"Unexpected keyword: FROMM"}"#;
        let err = map_service_error(reqwest::StatusCode::BAD_REQUEST, body);
        // `invalid-statement`, so the frontend renders the detail verbatim — the
        // service named the exact typo and that is the actionable part.
        assert_eq!(err.code, DbErrorCode::InvalidStatement);
        assert_eq!(err.message, "Unexpected keyword: FROMM");
    }

    /// `blocked` details render verbatim, so they carry our prose only; a size limit and a
    /// transaction conflict need different fixes, so each gets its own sentence.
    #[test]
    fn a_refused_write_says_which_refusal_it_was_and_carries_no_service_text() {
        let leaky = "at https://catalog_ro:hunter2@dynamo.internal:8000/maestro";
        let size = map_service_error(
            reqwest::StatusCode::BAD_REQUEST,
            &format!(
                r#"{{"__type":"x#ItemCollectionSizeLimitExceededException","message":"limit {leaky}"}}"#
            ),
        )
        .redacted(&["hunter2"]);
        assert_eq!(size.code, DbErrorCode::Blocked);
        assert!(
            size.message.contains("partition keys"),
            "the only fix there is names no button, so it must name the data: {}",
            size.message
        );

        let conflict = map_service_error(
            reqwest::StatusCode::BAD_REQUEST,
            &format!(
                r#"{{"__type":"x#TransactionConflictException","message":"conflict {leaky}"}}"#
            ),
        )
        .redacted(&["hunter2"]);
        assert_eq!(conflict.code, DbErrorCode::Blocked);
        assert!(
            conflict.message.contains("run it again"),
            "a transient conflict is the one refusal where retrying IS the answer: {}",
            conflict.message
        );
        // Two refusals, two different answers — a shared sentence would have to drop one.
        assert_ne!(size.message, conflict.message);

        for err in [&size, &conflict] {
            for fragment in [
                "hunter2",
                "dynamo.internal",
                "https://",
                "catalog_ro",
                "8000",
            ] {
                assert!(
                    !err.message.contains(fragment),
                    "{fragment:?} reached a message the panel renders: {}",
                    err.message
                );
            }
        }
    }

    #[test]
    fn a_signature_failure_is_auth_and_says_so_without_blaming_the_settings() {
        for t in [
            "InvalidSignatureException",
            "UnrecognizedClientException",
            "AccessDeniedException",
        ] {
            let body = format!(r#"{{"__type":"x#{t}","message":"nope"}}"#);
            let err = map_service_error(reqwest::StatusCode::FORBIDDEN, &body);
            assert_eq!(err.code, DbErrorCode::Auth, "{t}");
        }
        // And access-denied specifically points at IAM, because that IS the answer.
        let denied = map_service_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"__type":"x#AccessDeniedException","message":"not authorized"}"#,
        );
        assert!(denied.message.contains("IAM"), "{}", denied.message);
    }

    #[test]
    fn throttling_is_a_timeout_and_an_unparseable_body_still_yields_a_sentence() {
        let throttled = map_service_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"__type":"x#ProvisionedThroughputExceededException","message":"slow down"}"#,
        );
        assert_eq!(throttled.code, DbErrorCode::Timeout);

        // A body that is not JSON at all must not read as "no error".
        let garbage = map_service_error(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "<html>502</html>",
        );
        assert_eq!(garbage.code, DbErrorCode::Unknown);
        assert!(!garbage.message.is_empty());
        // A 403 with no parseable type is still an auth failure, not "unknown".
        let forbidden = map_service_error(reqwest::StatusCode::FORBIDDEN, "");
        assert_eq!(forbidden.code, DbErrorCode::Auth);
    }

    #[test]
    fn the_engine_reports_the_dynamodb_descriptor() {
        let spec = DynamodbEngine.spec();
        assert_eq!(spec.id, DbEngineId::Dynamodb);
        // No connection string exists, so the dialog must not offer a URL box.
        assert!(spec.url_schemes.is_empty());
        // IAM decides, so the badge may not promise a server-enforced boundary.
        assert!(!spec.server_enforced_read_only);
        assert!(spec.database_label.is_none(), "a region has no databases");
    }
}
