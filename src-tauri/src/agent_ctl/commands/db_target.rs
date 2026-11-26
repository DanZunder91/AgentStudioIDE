//! Shared start of the DB tools: resolve the saved connection (id or name, any case; a shared name
//! is refused, never guessed), open a per-call session (never the user's: no shared transaction or
//! held locks; closed on drop), and answer before the CLI's reply timeout.

use std::time::{Duration, Instant};

use crate::db::model::{DbConnection, SavePassword};
use crate::db::{self, session, Paths};

use super::{target_label, TOOL_DEADLINE};

/// How many saved names an error lists before it says how many more there are.
const NAMES_LISTED: usize = 30;

/// `arg` is an id, or a name ignoring case and surrounding spaces; `Err` is the sentence the agent
/// reads.
pub fn resolve(connections: &[DbConnection], arg: &str) -> Result<DbConnection, String> {
    let wanted = arg.trim();
    if connections.is_empty() {
        return Err(
            "No database connections are saved in Agent Studio. Add one with \
             `agent-studio db connect <url>`, or ask the user to add one in the DB panel."
                .to_string(),
        );
    }
    if wanted.is_empty() {
        return Err(format!(
            "Name a saved connection (its name or id). Saved: {}.",
            name_list(connections)
        ));
    }
    if let Some(c) = connections
        .iter()
        .find(|c| c.id.eq_ignore_ascii_case(wanted))
    {
        return Ok(c.clone());
    }
    let by_name: Vec<&DbConnection> = connections
        .iter()
        .filter(|c| c.name.trim().to_lowercase() == wanted.to_lowercase())
        .collect();
    match by_name.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!(
            "There is no saved connection named \"{wanted}\". Saved: {}. \
             `agent-studio db list` shows each one's details.",
            name_list(connections)
        )),
        many => Err(format!(
            "\"{wanted}\" names {} saved connections: {}. Use the id instead.",
            many.len(),
            many.iter()
                .map(|c| format!("\"{}\" (id {}, {})", c.name, c.id, target_label(c)))
                .collect::<Vec<_>>()
                .join("; ")
        )),
    }
}

/// `"a", "b", "c" and 4 more`.
fn name_list(connections: &[DbConnection]) -> String {
    let mut names: Vec<String> = connections
        .iter()
        .take(NAMES_LISTED)
        .map(|c| format!("\"{}\"", c.name))
        .collect();
    if connections.len() > NAMES_LISTED {
        names.push(format!("and {} more", connections.len() - NAMES_LISTED));
    }
    names.join(", ")
}

/// Load the store and resolve `arg` in it.
pub fn load_and_resolve(paths: &Paths, arg: &str) -> Result<DbConnection, String> {
    resolve(&db::store::load(&paths.store).connections, arg)
}

/// `"Orders" (PostgreSQL at db:5432/shop, read-only)` — how a reply names the connection.
pub fn describe(c: &DbConnection) -> String {
    format!(
        "\"{}\" ({}, {})",
        c.name,
        target_label(c),
        super::access_label(c.read_only)
    )
}

/// Closed by [`ToolSession::close`], or on drop if the call is abandoned (deadline, panic), so no
/// agent session outlives its call.
pub struct ToolSession {
    id: Option<String>,
    /// The server's version string from the open.
    pub server_version: String,
    pub latency_ms: u32,
}

impl ToolSession {
    /// Dial `c` exactly as the DB panel's Connect does: the password from the Vault, read-only
    /// applied at connect. `Err` names the connection and carries the engine's (redacted) reason.
    pub async fn open(paths: &Paths, c: &DbConnection) -> Result<Self, String> {
        match db::open(paths, &c.id, None).await {
            Ok(opened) => Ok(Self {
                id: Some(opened.session_id),
                server_version: opened.server_version,
                latency_ms: opened.latency_ms,
            }),
            Err(e) => Err(connect_failure(c, &e.message)),
        }
    }

    /// The registry id, for [`crate::db::query`] and [`crate::db::children`].
    pub fn id(&self) -> &str {
        self.id.as_deref().unwrap_or_default()
    }

    /// Close the connection and wait for it.
    pub async fn close(mut self) {
        if let Some(live) = self.id.take().and_then(|id| session::take(&id)) {
            session::close(&live).await;
        }
    }

    /// Without the server-side cancel, a slow statement would keep running after the agent was told
    /// it had stopped waiting.
    pub async fn cancel_and_close(self) {
        if let Some(cancel) = self
            .id
            .as_deref()
            .and_then(|id| session::get(id).ok()?.cancel)
        {
            let _ = tokio::time::timeout(Duration::from_secs(5), cancel.cancel()).await;
        }
        self.close().await;
    }
}

impl Drop for ToolSession {
    fn drop(&mut self) {
        let Some(live) = self.id.take().and_then(|id| session::take(&id)) else {
            return;
        };
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move { session::close(&live).await });
        }
    }
}

/// "Could not connect to …: why." — with a hint when the connection keeps no password.
pub fn connect_failure(c: &DbConnection, reason: &str) -> String {
    let mut text = format!("Could not connect to {}: {reason}", describe(c));
    if matches!(c.save_password, SavePassword::Session | SavePassword::Never) {
        text.push_str(
            " This connection does not keep its password in Agent Studio's Vault, so an agent \
             cannot open it; the user connects it in the DB panel.",
        );
    }
    text
}

/// Values no DB tool reply or event may carry, masked as written or percent-encoded. A backstop
/// only: a server that can read the password can return it reversed or encoded.
pub fn secrets_of(paths: &Paths, c: &DbConnection) -> Vec<String> {
    let vault = crate::api_store::load(&paths.vault);
    let mut refs = vec![c.password_ref.clone()];
    let mut out = Vec::new();
    if let Some(split) = c
        .url
        .as_deref()
        .and_then(|u| db::url::split_url_credentials(u).ok())
    {
        out.extend(split.password);
        refs.extend(split.password_ref);
    }
    for r in refs.iter().filter(|r| db::secret::is_ref(r)) {
        if let Ok(v) = db::secret::resolve(r, &vault) {
            out.push(v);
        }
    }
    // A literal (hand-edited) password in the record is still the password.
    if !c.password_ref.is_empty() && !db::secret::is_ref(&c.password_ref) {
        out.push(c.password_ref.clone());
    }
    out.retain(|s| !s.is_empty());
    out.sort();
    out.dedup();
    out
}

/// `text` with every one of `secrets` masked.
pub fn redact(text: &str, secrets: &[String]) -> String {
    if secrets.is_empty() {
        return text.to_string();
    }
    let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
    db::secret::redact(text, &refs)
}

/// Every string inside `value` (keys included) with every one of `secrets` masked.
pub fn redact_json(value: &mut serde_json::Value, secrets: &[String]) {
    use serde_json::Value;
    if secrets.is_empty() {
        return;
    }
    match value {
        Value::String(s) => {
            let masked = redact(s, secrets);
            if masked != *s {
                *s = masked;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| redact_json(v, secrets)),
        Value::Object(map) => {
            let old = std::mem::take(map);
            for (k, mut v) in old {
                redact_json(&mut v, secrets);
                map.insert(redact(&k, secrets), v);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// The point by which a tool must answer.
pub fn deadline() -> Instant {
    Instant::now() + TOOL_DEADLINE
}

/// Time left until `deadline` (zero once it has passed).
pub fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// "Agent Studio stopped waiting after 120 s …" — the sentence for a passed deadline.
pub fn stopped_waiting(what: &str, waited: Duration) -> String {
    format!(
        "Agent Studio stopped waiting for {what} after {} s. The agent's connection was closed, \
         and where the engine can cancel, the server was asked to stop the statement.",
        waited.as_secs().max(1)
    )
}
