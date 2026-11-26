//! `db_query` via the console's path, tightened against prompt injection: on read-only PG/MySQL
//! each statement runs in its own READ ONLY transaction, rolled back (a session setting can be
//! undone); the password is masked before any cut. Query text is never Vault-resolved; bounded.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::db::model::{DbConnection, DbFamily, DbRunMode};
use crate::db::result::{DbResultKind, DbResultSet};
use crate::db::{self, Paths};

use super::db_target::{self as target, ToolSession};
use super::{summary, TEXT_BUDGET, TOOL_DEADLINE};

/// Rows per statement when the agent does not say.
pub const DEFAULT_LIMIT: u32 = 100;
/// The most rows per statement an agent can ask for.
pub const MAX_LIMIT: u32 = 1000;
/// The longest value the structured data carries, in characters.
pub const CELL_CHARS: usize = 2000;
/// The widest column in the readable table, in characters.
pub const COLUMN_CHARS: usize = 40;
/// Result sets returned (a script can produce one per statement).
pub const MAX_RESULT_SETS: usize = 20;
/// The longest query text accepted, in bytes.
pub const MAX_QUERY_BYTES: usize = 256 * 1024;
/// What one cell costs against [`TEXT_BUDGET`] on top of its text: its share of the JSON around
/// it (`null,` or `"",`) and of the absent-mask beside it. Without it a NULL or empty cell cost
/// nothing, and a thousand rows of hundreds of empty columns went out whole.
pub const CELL_COST: usize = 8;

/// Each reads a credential or the auth set-up, or acts with one, whatever the connection allows
/// (`CONFIG GET requirepass` returns the very password Agent Studio dialled with).
const REDIS_REFUSED: &[(&str, &str)] = &[
    (
        "CONFIG",
        "it reads and changes the server's configuration, which holds its passwords",
    ),
    (
        "ACL",
        "it reads and changes the server's users, their rules and their password hashes",
    ),
    ("AUTH", "it logs the connection in with a password"),
    (
        "MONITOR",
        "it streams every other client's commands, credentials included",
    ),
    (
        "SENTINEL",
        "it reads a sentinel's view of the servers it watches, their auth settings included",
    ),
];

/// Uses the engine's own splitter and tokenizer, so quoting, escaping or case cannot make the words
/// checked differ from the words sent; a line it cannot read is refused by the engine.
pub fn redis_refusal(text: &str) -> Option<String> {
    for line in db::redis::command_lines(text) {
        let Ok(tokens) = db::redis::tokenize(&line) else {
            continue;
        };
        let words: Vec<String> = tokens
            .iter()
            .map(|t| t.trim().to_ascii_uppercase())
            .collect();
        let Some(head) = words.first() else {
            continue;
        };
        if let Some((name, why)) = REDIS_REFUSED.iter().find(|(name, _)| name == head) {
            return Some(format!(
                "`{name}` is not available to an agent: {why}. A password Agent Studio keeps in \
                 its Vault never reaches an agent."
            ));
        }
        if head == "HELLO" && words.iter().skip(1).any(|w| w == "AUTH") {
            return Some(
                "`HELLO … AUTH` is not available to an agent: it logs the connection in with a \
                 password. `HELLO` without AUTH is."
                    .to_string(),
            );
        }
    }
    None
}

/// What a run returned, after the caps.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryReport {
    pub connection: DbConnection,
    pub query: String,
    pub limit: u32,
    /// The result sets, cut to what the agent receives (the UI shows the same).
    pub results: Vec<DbResultSet>,
    /// Every cut, as a sentence.
    pub notes: Vec<String>,
    pub elapsed: Duration,
}

/// The row limit to use and, when the asked one was out of range, a note saying what happened.
pub fn effective_limit(asked: Option<i64>) -> Result<(u32, Option<String>), String> {
    match asked {
        None => Ok((DEFAULT_LIMIT, None)),
        Some(n) if n < 1 => Err(format!(
            "--limit must be at least 1 (and at most {MAX_LIMIT}); it was {n}."
        )),
        Some(n) if n > i64::from(MAX_LIMIT) => Ok((
            MAX_LIMIT,
            Some(format!(
                "--limit {n} was lowered to {MAX_LIMIT}, the most an agent can read per \
                 statement."
            )),
        )),
        Some(n) => Ok((u32::try_from(n).unwrap_or(MAX_LIMIT), None)),
    }
}

/// The run mode the console would use: a script when the connection allows multiple
/// statements (the Script button), else one statement (Run).
pub fn mode_for(c: &DbConnection) -> DbRunMode {
    if c.allow_multi_statement {
        DbRunMode::Script
    } else {
        DbRunMode::Statement
    }
}

/// `Err` is a refusal; a database error is a `message` inside `Ok`, as in the console. The returned
/// connection is `Some` once resolved, so a refused run can be shown to the user too.
pub async fn run(
    paths: &Paths,
    connection: &str,
    query: &str,
    limit: Option<i64>,
    deadline: Duration,
) -> (Option<DbConnection>, Result<QueryReport, String>) {
    let c = match target::load_and_resolve(paths, connection) {
        Ok(c) => c,
        Err(e) => return (None, Err(e)),
    };
    let result = run_on(paths, &c, query, limit, deadline).await;
    (Some(c), result)
}

async fn run_on(
    paths: &Paths,
    c: &DbConnection,
    query: &str,
    limit: Option<i64>,
    deadline: Duration,
) -> Result<QueryReport, String> {
    if query.trim().is_empty() {
        return Err("Give the query to run.".to_string());
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(format!(
            "That query is {} KB; the most an agent can send is {} KB.",
            query.len() / 1024,
            MAX_QUERY_BYTES / 1024
        ));
    }
    let (limit, limit_note) = effective_limit(limit)?;
    let refusal = match c.family {
        DbFamily::Redis => redis_refusal(query),
        family => super::db_refuse::sql_refusal(family, query),
    };
    if let Some(why) = refusal {
        return Err(format!(
            "Agent Studio did not run that on {}: {why}",
            target::describe(c)
        ));
    }
    let secrets = target::secrets_of(paths, c);
    let started = Instant::now();
    let until = started + deadline;
    let sess = tokio::time::timeout(deadline, ToolSession::open(paths, c))
        .await
        .map_err(|_| target::stopped_waiting("the connection", deadline))??;
    // Strict: read-only held by a transaction where the engine needs one (decided on the session).
    let ran = tokio::time::timeout(
        target::remaining(until),
        db::query_strict(sess.id(), query.to_string(), mode_for(c), Some(limit)),
    )
    .await;
    let mut sets = match ran {
        Ok(Ok(sets)) => {
            sess.close().await;
            sets
        }
        Ok(Err(e)) => {
            sess.close().await;
            return Err(format!(
                "Agent Studio did not run that on {}: {}",
                target::describe(c),
                e.message
            ));
        }
        Err(_) => {
            sess.cancel_and_close().await;
            return Err(target::stopped_waiting("the query", deadline));
        }
    };
    // Masked before anything is cut, so a cut can never leave part of a secret behind.
    for set in &mut sets {
        redact_set(set, &secrets);
    }
    let (results, mut notes) = bound(sets, limit);
    if let Some(n) = limit_note {
        notes.insert(0, n);
    }
    Ok(QueryReport {
        connection: c.clone(),
        query: query.to_string(),
        limit,
        results,
        notes,
        elapsed: started.elapsed(),
    })
}

/// Every text of `set` — cells, column names, the statement, the notice — with `secrets` masked.
pub fn redact_set(set: &mut DbResultSet, secrets: &[String]) {
    if secrets.is_empty() {
        return;
    }
    let mask = |s: &mut String| {
        let masked = target::redact(s, secrets);
        if masked != *s {
            *s = masked;
        }
    };
    set.rows.iter_mut().flatten().flatten().for_each(mask);
    set.columns.iter_mut().for_each(|c| {
        mask(&mut c.name);
        mask(&mut c.type_name);
    });
    mask(&mut set.statement);
    if let Some(n) = set.notice.as_mut() {
        mask(n);
    }
}

/// The deadline the app uses.
pub fn app_deadline() -> Duration {
    TOOL_DEADLINE
}

/// Cut `value` to `max` characters; `true` when it was cut.
fn cut_chars(value: &mut String, max: usize) -> bool {
    match value.char_indices().nth(max) {
        Some((at, _)) => {
            value.truncate(at);
            value.push('…');
            true
        }
        None => false,
    }
}

/// Apply the caps: at most [`MAX_RESULT_SETS`] sets, each value at most [`CELL_CHARS`], and cell
/// text across every set within [`TEXT_BUDGET`]. Returns the cut sets and a note per cut.
pub fn bound(mut sets: Vec<DbResultSet>, limit: u32) -> (Vec<DbResultSet>, Vec<String>) {
    let mut notes = Vec::new();
    if sets.len() > MAX_RESULT_SETS {
        notes.push(format!(
            "Only the first {MAX_RESULT_SETS} of {} results are included.",
            sets.len()
        ));
        sets.truncate(MAX_RESULT_SETS);
    }
    let mut budget = TEXT_BUDGET;
    let mut cells_cut = 0usize;
    let many = sets.len() > 1;
    for (i, set) in sets.iter_mut().enumerate() {
        let which = if many {
            format!(" of result {}", i + 1)
        } else {
            String::new()
        };
        if set.truncated {
            notes.push(format!(
                "Only the first {} rows{which} were read: that is the limit ({limit}). More rows \
                 exist; raise --limit (at most {MAX_LIMIT}) or narrow the query.",
                set.rows.len()
            ));
        }
        let mut keep = 0usize;
        for row in set.rows.iter_mut() {
            // Every cell costs, NULL and empty included (see [`CELL_COST`]), and the row its
            // brackets.
            let mut size = 2usize;
            let mut cut_here = 0usize;
            for cell in row.iter_mut() {
                size += CELL_COST;
                if let Some(text) = cell.as_mut() {
                    if cut_chars(text, CELL_CHARS) {
                        cut_here += 1;
                    }
                    size += text.len();
                }
            }
            if size > budget {
                break;
            }
            budget -= size;
            cells_cut += cut_here;
            keep += 1;
        }
        if keep < set.rows.len() {
            notes.push(format!(
                "Rows after the first {keep}{which} (of {} read) were left out: the reply is \
                 capped at {} KB.",
                set.rows.len(),
                TEXT_BUDGET / 1024
            ));
            set.rows.truncate(keep);
            if let Some(mask) = set.absent.as_mut() {
                mask.truncate(keep);
            }
            set.truncated = true;
        }
        if let Some(notice) = set.notice.as_mut() {
            cut_chars(notice, CELL_CHARS);
        }
        cut_chars(&mut set.statement, CELL_CHARS);
    }
    if cells_cut > 0 {
        notes.push(format!(
            "{cells_cut} long value{} cut to {CELL_CHARS} characters.",
            if cells_cut == 1 { " was" } else { "s were" }
        ));
    }
    (sets, notes)
}

/// A cell as the readable table shows it: `NULL`, `(absent)`, control characters escaped, cut
/// to [`COLUMN_CHARS`].
pub fn display_cell(cell: Option<&str>, absent: bool) -> String {
    let Some(text) = cell else {
        return if absent { "(absent)" } else { "NULL" }.to_string();
    };
    let mut out = String::with_capacity(text.len().min(COLUMN_CHARS * 4));
    for ch in text.chars() {
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push('?'),
            c => out.push(c),
        }
        if out.chars().count() > COLUMN_CHARS + 4 {
            break;
        }
    }
    cut_chars(&mut out, COLUMN_CHARS);
    out
}

fn pad(s: &str, width: usize) -> String {
    let n = s.chars().count();
    if n >= width {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(width - n))
    }
}

/// One rows-result as a table, `|`-separated, each column as wide as its widest shown cell.
pub fn table(set: &DbResultSet) -> Vec<String> {
    let header: Vec<String> = set
        .columns
        .iter()
        .map(|c| display_cell(Some(&c.name), false))
        .collect();
    let body: Vec<Vec<String>> = set
        .rows
        .iter()
        .enumerate()
        .map(|(r, row)| {
            (0..header.len().max(row.len()))
                .map(|i| {
                    let absent = set
                        .absent
                        .as_ref()
                        .and_then(|m| m.get(r))
                        .and_then(|m| m.get(i))
                        .copied()
                        .unwrap_or(false);
                    display_cell(row.get(i).and_then(|c| c.as_deref()), absent)
                })
                .collect()
        })
        .collect();
    let ncols = header
        .len()
        .max(body.iter().map(Vec::len).max().unwrap_or(0));
    let widths: Vec<usize> = (0..ncols)
        .map(|i| {
            std::iter::once(header.get(i))
                .chain(body.iter().map(|r| r.get(i)))
                .flatten()
                .map(|s| s.chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    let line = |cells: &[String]| -> String {
        (0..ncols)
            .map(|i| pad(cells.get(i).map(String::as_str).unwrap_or(""), widths[i]))
            .collect::<Vec<_>>()
            .join(" | ")
            .trim_end()
            .to_string()
    };
    let mut out = vec![
        line(&header),
        widths
            .iter()
            .map(|w| "-".repeat(*w))
            .collect::<Vec<_>>()
            .join("-+-"),
    ];
    out.extend(body.iter().map(|r| line(r)));
    out
}

impl QueryReport {
    /// The readable reply: what ran where, then each result, then every cut — within
    /// [`TEXT_BUDGET`].
    pub fn message(&self) -> String {
        let mut lines = vec![format!(
            "Ran on {} in {} ms.",
            target::describe(&self.connection),
            self.elapsed.as_millis()
        )];
        let many = self.results.len() > 1;
        let mut budget = TEXT_BUDGET;
        for (i, set) in self.results.iter().enumerate() {
            lines.push(if many {
                format!(
                    "\n[{}] {}",
                    i + 1,
                    crate::db::guard::first_line(&set.statement)
                )
            } else {
                String::new()
            });
            match set.kind {
                DbResultKind::Rows if set.columns.is_empty() && set.rows.is_empty() => {
                    lines.push("(0 rows)".to_string());
                }
                DbResultKind::Rows => {
                    let mut head = table(set);
                    let mut rows = head.split_off(2);
                    budget = budget.saturating_sub(lines_size(&head));
                    lines.extend(head);
                    let total = rows.len();
                    let cut = super::text_budget_cut(&mut rows, budget);
                    budget = budget.saturating_sub(lines_size(&rows));
                    lines.extend(rows);
                    lines.push(format!(
                        "({total} row{}{})",
                        if total == 1 { "" } else { "s" },
                        if set.truncated { ", more exist" } else { "" }
                    ));
                    if cut > 0 {
                        lines.push(format!(
                            "The table shows {} of these {total} rows (64 KB text cap); --json \
                             carries all {total}.",
                            total - cut
                        ));
                    }
                }
                DbResultKind::Affected => lines.push(match set.rows_affected {
                    Some(n) => format!("OK: {n} row{} affected.", if n == 1 { "" } else { "s" }),
                    None => "OK.".to_string(),
                }),
                DbResultKind::Message => lines.push(format!(
                    "The database said: {}",
                    set.notice.as_deref().unwrap_or("(no text)")
                )),
            }
            if set.kind != DbResultKind::Message {
                if let Some(n) = set.notice.as_deref() {
                    lines.push(format!("Notice: {n}"));
                }
            }
        }
        if self.results.is_empty() {
            lines.push("The database returned nothing.".to_string());
        }
        if !self.notes.is_empty() {
            lines.push(String::new());
            lines.extend(self.notes.iter().cloned());
        }
        super::hard_cap(lines.join("\n"))
    }

    /// The structured reply.
    pub fn data(&self) -> Value {
        // The rows once, in their result: a second copy at the top level doubled the reply.
        let results: Vec<Value> = self.results.iter().map(result_json).collect();
        json!({
            "connection": summary(&self.connection),
            "limit": self.limit,
            "results": results,
            "truncated": self.results.iter().any(|s| s.truncated),
            "notes": self.notes,
            "elapsedMs": u64::try_from(self.elapsed.as_millis()).unwrap_or(u64::MAX),
        })
    }
}

fn lines_size(lines: &[String]) -> usize {
    lines.iter().map(|l| l.len() + 1).sum()
}

/// One result set as an agent reads it: column names and server type names side by side.
fn result_json(set: &DbResultSet) -> Value {
    let mut v = json!({
        "kind": set.kind,
        "statement": set.statement,
        "columns": set.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        "columnTypes": set.columns.iter().map(|c| c.type_name.clone()).collect::<Vec<_>>(),
        "rows": set.rows,
        "rowCount": set.rows.len(),
        "truncated": set.truncated,
        "rowsAffected": set.rows_affected,
        "notice": set.notice,
        "durationMs": set.duration_ms,
    });
    if let Some(mask) = &set.absent {
        v["absent"] = json!(mask);
    }
    v
}
