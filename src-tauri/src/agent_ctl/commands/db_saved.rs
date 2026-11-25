//! `db_queries`, `db_save_query` and `db_console`: the user's saved queries and console, from an
//! agent.
//!
//! * Saved queries go through the DB client's own store ([`crate::db::upsert_saved_query`]: the
//!   connection must exist, the write is atomic and locked). An agent only ever **adds** one —
//!   never updates or deletes the user's — so a name that is already taken gets a second query
//!   beside it (names are not unique in that store) and the reply says so.
//! * A console is opened by the webview (`dbConsole` event): with the query typed in and **not
//!   run**, because the point of the tool is that the user reads it and presses Run.

use serde_json::{json, Value};

use crate::db::model::DbConnection;
use crate::db::queries::{self, SavedQuery, SavedQueryInput};
use crate::db::{self, Paths};

use super::db_run::MAX_QUERY_BYTES;
use super::db_target as target;
use super::{hard_cap, summary, text_budget_cut, TEXT_BUDGET};

/// The longest name a saved query can be given, in characters.
pub const MAX_NAME_CHARS: usize = 200;
/// The most saved queries a listing returns.
pub const MAX_LISTED: usize = 200;
/// The longest query text a listing shows per query, in characters (the data carries up to
/// [`MAX_QUERY_BYTES`] of each, and [`TEXT_BUDGET`] of query text in all).
pub const PREVIEW_CHARS: usize = 2000;

/// The queries saved for the connection `connection` names, newest first.
pub fn db_queries(paths: &Paths, connection: &str) -> Result<(String, Value), String> {
    let c = target::load_and_resolve(paths, connection)?;
    let all = queries::for_connection(&queries::load(&paths.queries), &c.id);
    Ok(queries_reply(&c, &all))
}

/// The reply for [`db_queries`].
pub fn queries_reply(c: &DbConnection, all: &[SavedQuery]) -> (String, Value) {
    let total = all.len();
    let listed = &all[..total.min(MAX_LISTED)];
    if listed.is_empty() {
        return (
            format!(
                "No queries are saved for {}. Save one with `agent-studio db save query`.",
                target::describe(c)
            ),
            json!({ "connection": summary(c), "queries": [], "total": 0 }),
        );
    }
    let mut lines = Vec::new();
    for q in listed {
        lines.push(format!("• {}  (id {})", q.name, q.id));
        let mut text = q.sql.clone();
        let cut = cut_to(&mut text, PREVIEW_CHARS);
        for l in text.lines() {
            lines.push(format!("    {l}"));
        }
        if cut {
            lines.push("    … (cut; --json has the whole text)".to_string());
        }
    }
    let left_out = text_budget_cut(&mut lines, TEXT_BUDGET);
    let mut head = vec![format!(
        "{total} saved quer{} for {}:",
        if total == 1 { "y" } else { "ies" },
        target::describe(c)
    )];
    head.extend(lines);
    if left_out > 0 {
        head.push("(The rest is left out: 64 KB text cap. --json lists them.)".to_string());
    }
    if total > MAX_LISTED {
        head.push(format!("Only the newest {MAX_LISTED} are listed."));
    }
    // The query text in the data shares one budget, as the message does: 200 queries of 256 KB
    // each would otherwise be 50 MB of reply.
    let mut budget = TEXT_BUDGET;
    let mut queries = Vec::new();
    for q in listed {
        if budget == 0 {
            break;
        }
        let mut sql = q.sql.clone();
        let cut = cut_bytes(&mut sql, MAX_QUERY_BYTES.min(budget));
        budget = budget.saturating_sub(sql.len() + q.name.len());
        queries.push(json!({
            "id": q.id,
            "name": q.name,
            "query": sql,
            "cut": cut,
            "updatedAtMs": q.updated_at_ms,
        }));
    }
    let shown = queries.len();
    if shown < listed.len() {
        head.push(format!(
            "The data lists the first {shown}: query text is capped at {} KB.",
            TEXT_BUDGET / 1024
        ));
    }
    let data = json!({
        "connection": summary(c),
        "queries": queries,
        "total": total,
        "truncated": shown < total,
    });
    (hard_cap(head.join("\n")), data)
}

/// Cut `text` to at most `max` bytes at a character boundary (marking the cut); `true` when it was
/// cut.
fn cut_bytes(text: &mut String, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    let mut at = max;
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    text.truncate(at);
    text.push('…');
    true
}

/// Cut `text` to `max` characters (marking the cut); `true` when it was cut.
fn cut_to(text: &mut String, max: usize) -> bool {
    match text.char_indices().nth(max) {
        Some((at, _)) => {
            text.truncate(at);
            text.push('…');
            true
        }
        None => false,
    }
}

/// What [`db_save_query`] did.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedReport {
    pub connection: DbConnection,
    pub saved: SavedQuery,
    /// Other saved queries of this connection with the same name (left untouched).
    pub same_name: usize,
}

impl SavedReport {
    pub fn message(&self) -> String {
        let mut text = format!(
            "Saved \"{}\" in the saved queries of {} (id {}). The user finds it under that \
             connection in the DB panel.",
            self.saved.name,
            target::describe(&self.connection),
            self.saved.id
        );
        if self.same_name > 0 {
            text.push_str(&format!(
                " {} other saved quer{} already had that name; {} left as {}, and this one was \
                 saved beside {}.",
                self.same_name,
                if self.same_name == 1 { "y" } else { "ies" },
                if self.same_name == 1 {
                    "it was"
                } else {
                    "they were"
                },
                if self.same_name == 1 {
                    "it was"
                } else {
                    "they were"
                },
                if self.same_name == 1 { "it" } else { "them" },
            ));
        }
        text
    }

    pub fn data(&self) -> Value {
        json!({
            "connection": summary(&self.connection),
            "query": {
                "id": self.saved.id,
                "name": self.saved.name,
                "query": self.saved.sql,
            },
            "sameName": self.same_name,
        })
    }
}

/// Add a saved query to the connection `connection` names. Never updates an existing one.
pub fn db_save_query(
    paths: &Paths,
    connection: &str,
    name: &str,
    query: &str,
) -> Result<SavedReport, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the saved query a name.".to_string());
    }
    if query.trim().is_empty() {
        return Err("Give the query text to save.".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "That name is {} characters; keep it to {MAX_NAME_CHARS}.",
            name.chars().count()
        ));
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(format!(
            "That query is {} KB; the most an agent can save is {} KB.",
            query.len() / 1024,
            MAX_QUERY_BYTES / 1024
        ));
    }
    let c = target::load_and_resolve(paths, connection)?;
    let same_name = queries::for_connection(&queries::load(&paths.queries), &c.id)
        .iter()
        .filter(|q| q.name.trim().eq_ignore_ascii_case(name))
        .count();
    let saved = db::upsert_saved_query(
        paths,
        SavedQueryInput {
            // Always a new record: an agent adds to the user's saved queries, it never edits one.
            id: None,
            connection_id: c.id.clone(),
            name: name.to_string(),
            sql: query.to_string(),
        },
    )
    .map_err(|e| e.message)?;
    Ok(SavedReport {
        connection: c,
        saved,
        same_name,
    })
}

/// Check a `db_console` call; the webview does the opening. Returns the connection.
pub fn db_console(
    paths: &Paths,
    connection: &str,
    query: Option<&str>,
) -> Result<DbConnection, String> {
    if query.is_some_and(|q| q.len() > MAX_QUERY_BYTES) {
        return Err(format!(
            "That query is too long for a console; the most an agent can send is {} KB.",
            MAX_QUERY_BYTES / 1024
        ));
    }
    target::load_and_resolve(paths, connection)
}

/// The reply for [`db_console`].
pub fn console_message(c: &DbConnection, with_query: bool) -> String {
    if with_query {
        format!(
            "Opened a query console for {} in Agent Studio with the query typed in, or, when \
             the user was already writing there, left their text as it is and showed the query \
             in the DB panel with a button that puts it in the console. It was NOT run: the user \
             reads it and presses Run (Connect first, if the console asks).",
            target::describe(c)
        )
    } else {
        format!(
            "Opened a query console for {} in Agent Studio.",
            target::describe(c)
        )
    }
}
