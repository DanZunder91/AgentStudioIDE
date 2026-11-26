//! `db_test`, `db_schema`, `db_search` over the DB panel's own tree. A path is `/`-joined labels
//! ([`escape_label`] escapes `/` and `\`), reusable as `--path`. Results are bounded, and a search
//! says which bound stopped it: one that gave up reads like one that found nothing.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::db::error::DbError;
use crate::db::model::DbConnection;
use crate::db::tree::{DbNode, DbNodeKind, DbNodeRef};
use crate::db::{self, Paths};

use super::db_target::{self as target, ToolSession};
use super::{summary, text_budget_cut, TEXT_BUDGET};

/// Items one level lists.
pub const MAX_ITEMS: usize = 500;
/// Levels a search reads.
pub const MAX_LOOKUPS: usize = 300;
/// Matches a search reports.
pub const MAX_MATCHES: usize = 200;
/// How long a search walks.
pub const SEARCH_TIME: Duration = Duration::from_secs(20);
/// How deep a search goes below where it starts. Deep enough for every engine's tree
/// (PostgreSQL: database › schema › folder › table › column).
pub const MAX_DEPTH: usize = 6;

/// Where the levels come from: an open session in the app, a fixed tree in tests.
// `async_trait` marks its boxed futures `#[must_use]`; clippy flags that as double_must_use.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait TreeSource: Send {
    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError>;
}

/// The tree of an open session, as the DB panel reads it — each label and detail with the
/// connection's secrets masked (a key or a table can be named anything).
pub struct SessionTree<'a> {
    pub session: &'a ToolSession,
    pub secrets: Vec<String>,
}

#[async_trait]
impl TreeSource for SessionTree<'_> {
    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        let mut kids = db::children(self.session.id(), node).await?;
        for k in &mut kids {
            k.label = target::redact(&k.label, &self.secrets);
            if let Some(sub) = k.sub_label.as_mut() {
                *sub = target::redact(sub, &self.secrets);
            }
        }
        Ok(kids)
    }
}

/// A kind as one word.
pub fn kind_word(kind: DbNodeKind) -> &'static str {
    match kind {
        DbNodeKind::Database => "database",
        DbNodeKind::Schema => "schema",
        DbNodeKind::Group => "folder",
        DbNodeKind::Table => "table",
        DbNodeKind::View => "view",
        DbNodeKind::Collection => "collection",
        DbNodeKind::Column => "column",
        DbNodeKind::Key => "key",
        DbNodeKind::SavedQuery => "saved query",
    }
}

/// The count a folder's label states (`5013 keys`, `12 tables`, `3 collections`), if any.
pub fn stated_count(node: &DbNode) -> Option<usize> {
    if node.kind != DbNodeKind::Group {
        return None;
    }
    node.sub_label
        .as_deref()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// What a level left out, when the engine says so (a stated count, a first page): otherwise a
/// search that missed a name reads like a name that does not exist.
pub fn shortfall(stated: Option<usize>, kids: &[DbNode]) -> Option<String> {
    if let Some(n) = stated.filter(|n| kids.len() < *n) {
        return Some(format!("{} of {n}", kids.len()));
    }
    kids.iter().find_map(|k| {
        k.sub_label
            .as_deref()
            .filter(|s| s.starts_with("first "))
            .map(|s| format!("{} ({s})", kids.len()))
    })
}

/// `label` as one path segment: `\` → `\\`, `/` → `\/`. [`split_path`] reads it back.
pub fn escape_label(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    for ch in label.chars() {
        if ch == '\\' || ch == '/' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// A path's segments: split at each `/` that is not escaped, each `\x` read as `x` (a trailing
/// lone `\` is kept as itself).
pub fn split_path(path: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut chars = path.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some(next) => out.last_mut().expect("never empty").push(next),
                None => out.last_mut().expect("never empty").push('\\'),
            },
            '/' => out.push(String::new()),
            other => out.last_mut().expect("never empty").push(other),
        }
    }
    out
}

/// `path` with `label` as one more segment.
pub fn join(path: &str, label: &str) -> String {
    if path.is_empty() {
        escape_label(label)
    } else {
        format!("{path}/{}", escape_label(label))
    }
}

/// `s` quoted for a POSIX shell, so a hint line can be pasted as it is.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Segments match exactly, else case-insensitively; a miss is also looked for inside folder levels
/// ("Tables", …), so `maestro/public/tracks` finds `.../Tables/tracks`.
pub async fn walk_to(
    tree: &mut dyn TreeSource,
    path: &str,
) -> Result<(DbNodeRef, String, Option<usize>), String> {
    let mut node = DbNodeRef::Root;
    let mut canonical = String::new();
    let mut stated = None;
    for segment in split_path(path) {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let kids = tree
            .children(&node)
            .await
            .map_err(|e| format!("Could not read {}: {}", place(&canonical), e.message))?;
        let found = match find_label(&kids, segment) {
            Some(k) => Some((k.clone(), String::new())),
            None => find_in_folders(tree, &kids, segment).await?,
        };
        let Some((child, folder)) = found else {
            return Err(format!(
                "There is no \"{segment}\" in {}. It has: {}.",
                place(&canonical),
                label_list(&kids)
            ));
        };
        if !folder.is_empty() {
            canonical = join(&canonical, &folder);
        }
        canonical = join(&canonical, &child.label);
        if !child.expandable {
            return Err(format!(
                "\"{canonical}\" is a {} and has nothing below it.",
                kind_word(child.kind)
            ));
        }
        stated = stated_count(&child);
        node = child.node_ref;
    }
    Ok((node, canonical, stated))
}

fn place(path: &str) -> String {
    if path.is_empty() {
        "the top level".to_string()
    } else {
        format!("\"{path}\"")
    }
}

fn find_label<'a>(kids: &'a [DbNode], segment: &str) -> Option<&'a DbNode> {
    kids.iter().find(|k| k.label == segment).or_else(|| {
        kids.iter()
            .find(|k| k.label.to_lowercase() == segment.to_lowercase())
    })
}

/// `segment` inside one of `kids`' folders: the child and the folder's label.
async fn find_in_folders(
    tree: &mut dyn TreeSource,
    kids: &[DbNode],
    segment: &str,
) -> Result<Option<(DbNode, String)>, String> {
    for folder in kids
        .iter()
        .filter(|k| k.kind == DbNodeKind::Group && k.expandable)
    {
        let inside = tree
            .children(&folder.node_ref)
            .await
            .map_err(|e| format!("Could not read \"{}\": {}", folder.label, e.message))?;
        if let Some(k) = find_label(&inside, segment) {
            return Ok(Some((k.clone(), folder.label.clone())));
        }
    }
    Ok(None)
}

fn label_list(kids: &[DbNode]) -> String {
    if kids.is_empty() {
        return "nothing".to_string();
    }
    let mut names: Vec<String> = kids
        .iter()
        .take(40)
        .map(|k| escape_label(&k.label))
        .collect();
    if kids.len() > 40 {
        names.push(format!("and {} more", kids.len() - 40));
    }
    names.join(", ")
}

/* ─────────────────────────────── db_test ─────────────────────────────── */

/// Dial a saved connection and close it again. `Err` when it does not connect.
pub async fn db_test(paths: &Paths, connection: &str) -> Result<(String, Value), String> {
    let c = target::load_and_resolve(paths, connection)?;
    let deadline = target::deadline();
    let sess = tokio::time::timeout(target::remaining(deadline), ToolSession::open(paths, &c))
        .await
        .map_err(|_| target::stopped_waiting("the connection", super::TOOL_DEADLINE))??;
    let (version, ms) = (sess.server_version.clone(), sess.latency_ms);
    sess.close().await;
    let message = format!(
        "Connected to {}: {} in {ms} ms. The password came from Agent Studio's Vault and was not \
         shown.",
        target::describe(&c),
        super::short_version(&version),
    );
    let data = json!({
        "ok": true,
        "connection": summary(&c),
        "serverVersion": version,
        "latencyMs": ms,
    });
    Ok((message, data))
}

/* ─────────────────────────────── db_schema ─────────────────────────────── */

/// One level of `c`'s tree, at `path` (the top level when empty).
pub async fn schema(
    tree: &mut dyn TreeSource,
    c: &DbConnection,
    path: &str,
) -> Result<(String, Value), String> {
    let (node, canonical, stated) = walk_to(tree, path).await?;
    let kids = tree
        .children(&node)
        .await
        .map_err(|e| format!("Could not read {}: {}", place(&canonical), e.message))?;
    let partial = shortfall(stated, &kids);
    let total = kids.len();
    let shown = &kids[..total.min(MAX_ITEMS)];

    let head = format!(
        "{} › {}:",
        target::describe(c),
        if canonical.is_empty() {
            "top level".to_string()
        } else {
            canonical.clone()
        }
    );
    let width = shown
        .iter()
        .map(|k| kind_word(k.kind).len())
        .max()
        .unwrap_or(0);
    let mut lines: Vec<String> = shown
        .iter()
        .map(|k| {
            let detail = k
                .sub_label
                .as_deref()
                .map(|s| format!("  — {s}"))
                .unwrap_or_default();
            format!("  {:width$}  {}{detail}", kind_word(k.kind), k.label)
        })
        .collect();
    let mut tail = Vec::new();
    if total == 0 {
        tail.push("Nothing here.".to_string());
    } else {
        tail.push(format!(
            "{total} item{}.",
            if total == 1 { "" } else { "s" }
        ));
    }
    if total > MAX_ITEMS {
        tail.push(format!(
            "Only the first {MAX_ITEMS} are listed; `db search` finds one by name."
        ));
    }
    if let Some(p) = &partial {
        tail.push(format!(
            "This level lists {p}: the tree reads one page of it, so names past that page are \
             not here (and `db search` cannot see them either). Query the database to list them."
        ));
    }
    if let Some(next) = shown.iter().find(|k| k.expandable) {
        tail.push(format!(
            "Look inside one with: agent-studio db schema {} --path {}",
            shell_quote(&c.name),
            shell_quote(&join(&canonical, &next.label))
        ));
    }
    let cut = text_budget_cut(&mut lines, TEXT_BUDGET);
    if cut > 0 {
        tail.push(format!(
            "{cut} more lines were left out (64 KB cap); --json lists every one."
        ));
    }
    let message = std::iter::once(head)
        .chain(lines)
        .chain(tail)
        .collect::<Vec<_>>()
        .join("\n");
    let items: Vec<Value> = shown
        .iter()
        .map(|k| {
            json!({
                "name": k.label,
                "kind": kind_word(k.kind),
                "detail": k.sub_label,
                "expandable": k.expandable,
                "path": join(&canonical, &k.label),
            })
        })
        .collect();
    let data = json!({
        "connection": summary(c),
        "path": canonical,
        "items": items,
        "total": total,
        "truncated": total > MAX_ITEMS || partial.is_some(),
        "partial": partial,
    });
    Ok((message, data))
}

/* ─────────────────────────────── db_search ─────────────────────────────── */

/// Why a search stopped before it had read everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CutShort {
    Lookups,
    Time,
    Matches,
}

/// How a search is bounded. The app uses [`SearchLimits::default`]; tests shrink it.
#[derive(Debug, Clone, Copy)]
pub struct SearchLimits {
    pub lookups: usize,
    pub matches: usize,
    pub time: Duration,
    pub depth: usize,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            lookups: MAX_LOOKUPS,
            matches: MAX_MATCHES,
            time: SEARCH_TIME,
            depth: MAX_DEPTH,
        }
    }
}

/// One match.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub kind: DbNodeKind,
    pub name: String,
    pub path: String,
    pub detail: Option<String>,
}

/// What a search read and found.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchOutcome {
    pub found: Vec<Found>,
    pub lookups: usize,
    pub cut: Option<CutShort>,
    /// Levels that could not be read, as `path: reason` (at most ten kept).
    pub unreadable: Vec<String>,
    pub unreadable_count: usize,
    /// Levels the tree listed only part of (see [`shortfall`]), as `path (500 of 5013)` (at most
    /// ten kept).
    pub partial: Vec<String>,
    pub partial_count: usize,
}

/// Which kinds a search reports. Folders and saved queries are the app's, not the database's.
fn searchable(kind: DbNodeKind) -> bool {
    !matches!(kind, DbNodeKind::Group | DbNodeKind::SavedQuery)
}

/// Breadth-first from `start` (so every table is seen before any column), matching labels that
/// contain `pattern` ignoring case.
pub async fn search(
    tree: &mut dyn TreeSource,
    start: DbNodeRef,
    start_path: &str,
    start_stated: Option<usize>,
    pattern: &str,
    limits: SearchLimits,
) -> SearchOutcome {
    let needle = pattern.to_lowercase();
    let started = Instant::now();
    let mut out = SearchOutcome {
        found: Vec::new(),
        lookups: 0,
        cut: None,
        unreadable: Vec::new(),
        unreadable_count: 0,
        partial: Vec::new(),
        partial_count: 0,
    };
    let mut queue: VecDeque<(DbNodeRef, String, usize, Option<usize>)> = VecDeque::new();
    queue.push_back((start, start_path.to_string(), 0, start_stated));
    // A limit is only a cut when something is left to read, so the queue is checked first.
    'walk: while !queue.is_empty() {
        if out.lookups >= limits.lookups {
            out.cut = Some(CutShort::Lookups);
            break;
        }
        let left = limits.time.saturating_sub(started.elapsed());
        if left.is_zero() {
            out.cut = Some(CutShort::Time);
            break;
        }
        let Some((node, path, depth, stated)) = queue.pop_front() else {
            break;
        };
        out.lookups += 1;
        let kids = match tokio::time::timeout(left, tree.children(&node)).await {
            Err(_) => {
                out.cut = Some(CutShort::Time);
                break;
            }
            Ok(Err(e)) => {
                out.unreadable_count += 1;
                if out.unreadable.len() < 10 {
                    out.unreadable
                        .push(format!("{}: {}", place(&path), e.message));
                }
                continue;
            }
            Ok(Ok(kids)) => kids,
        };
        if let Some(p) = shortfall(stated, &kids) {
            out.partial_count += 1;
            if out.partial.len() < 10 {
                out.partial.push(format!("{} ({p})", place(&path)));
            }
        }
        for k in kids {
            let child_path = join(&path, &k.label);
            if searchable(k.kind) && k.label.to_lowercase().contains(&needle) {
                out.found.push(Found {
                    kind: k.kind,
                    name: k.label.clone(),
                    path: child_path.clone(),
                    detail: k.sub_label.clone(),
                });
                if out.found.len() >= limits.matches {
                    out.cut = Some(CutShort::Matches);
                    break 'walk;
                }
            }
            if k.expandable && depth + 1 < limits.depth {
                let stated = stated_count(&k);
                queue.push_back((k.node_ref, child_path, depth + 1, stated));
            }
        }
    }
    out
}

/// The reply for a search of `c`.
pub fn search_reply(
    c: &DbConnection,
    pattern: &str,
    from: &str,
    outcome: &SearchOutcome,
    limits: SearchLimits,
    elapsed: Duration,
) -> (String, Value) {
    let n = outcome.found.len();
    let scope = if from.is_empty() {
        String::new()
    } else {
        format!(" under \"{from}\"")
    };
    let mut lines = vec![format!(
        "{} match{} for \"{pattern}\" in {}{scope} ({} level{} read in {:.1} s):",
        n,
        if n == 1 { "" } else { "es" },
        target::describe(c),
        outcome.lookups,
        if outcome.lookups == 1 { "" } else { "s" },
        elapsed.as_secs_f64()
    )];
    if n == 0 {
        lines[0] = lines[0].trim_end_matches(':').to_string() + ".";
    }
    let width = outcome
        .found
        .iter()
        .map(|f| kind_word(f.kind).len())
        .max()
        .unwrap_or(0);
    let mut rows: Vec<String> = outcome
        .found
        .iter()
        .map(|f| {
            let detail = f
                .detail
                .as_deref()
                .map(|d| format!("  — {d}"))
                .unwrap_or_default();
            format!("  {:width$}  {}{detail}", kind_word(f.kind), f.path)
        })
        .collect();
    let cut_lines = text_budget_cut(&mut rows, TEXT_BUDGET);
    lines.extend(rows);
    if cut_lines > 0 {
        lines.push(format!(
            "{cut_lines} more matches were left out (64 KB cap); --json lists every one."
        ));
    }
    if let Some(cut) = outcome.cut {
        lines.push(format!(
            "The search stopped early: {}. Parts of the tree were not searched; narrow it with \
             --path.",
            match cut {
                CutShort::Lookups => format!("it read its limit of {} levels", limits.lookups),
                CutShort::Time => format!("it ran for its limit of {} s", limits.time.as_secs()),
                CutShort::Matches => format!("it found its limit of {} matches", limits.matches),
            }
        ));
    }
    if outcome.partial_count > 0 {
        lines.push(format!(
            "{} level{} list only one page of what the database holds, so names past that page \
             were not searched: {}. Query the database to search them all.",
            outcome.partial_count,
            if outcome.partial_count == 1 { "" } else { "s" },
            outcome.partial.join("; ")
        ));
    }
    if outcome.unreadable_count > 0 {
        lines.push(format!(
            "{} level{} could not be read: {}",
            outcome.unreadable_count,
            if outcome.unreadable_count == 1 {
                ""
            } else {
                "s"
            },
            outcome.unreadable.join("; ")
        ));
    }
    let data = json!({
        "connection": summary(c),
        "pattern": pattern,
        "from": from,
        "matches": outcome.found.iter().map(|f| json!({
            "name": f.name,
            "kind": kind_word(f.kind),
            "path": f.path,
            "detail": f.detail,
        })).collect::<Vec<_>>(),
        "lookups": outcome.lookups,
        "complete": outcome.cut.is_none()
            && outcome.unreadable_count == 0
            && outcome.partial_count == 0,
        "cutShort": outcome.cut.map(|c| match c {
            CutShort::Lookups => "lookups",
            CutShort::Time => "time",
            CutShort::Matches => "matches",
        }),
        "unreadable": outcome.unreadable,
        "partial": outcome.partial,
    });
    (lines.join("\n"), data)
}

/// `db_schema` end to end: resolve, open, read, close.
pub async fn db_schema(
    paths: &Paths,
    connection: &str,
    path: &str,
) -> Result<(String, Value), String> {
    let c = target::load_and_resolve(paths, connection)?;
    let deadline = target::deadline();
    let sess = open_within(paths, &c, deadline).await?;
    let mut tree = SessionTree {
        session: &sess,
        secrets: target::secrets_of(paths, &c),
    };
    let read = tokio::time::timeout(target::remaining(deadline), schema(&mut tree, &c, path)).await;
    match read {
        Ok(r) => {
            sess.close().await;
            r
        }
        Err(_) => {
            sess.cancel_and_close().await;
            Err(target::stopped_waiting(
                "the object tree",
                super::TOOL_DEADLINE,
            ))
        }
    }
}

/// `db_search` end to end.
pub async fn db_search(
    paths: &Paths,
    connection: &str,
    pattern: &str,
    path: &str,
) -> Result<(String, Value), String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err("Give a text to look for in table, collection and column names.".to_string());
    }
    let c = target::load_and_resolve(paths, connection)?;
    let deadline = target::deadline();
    let sess = open_within(paths, &c, deadline).await?;
    let mut tree = SessionTree {
        session: &sess,
        secrets: target::secrets_of(paths, &c),
    };
    let started = Instant::now();
    // The walk down to --path is bounded by the call's deadline; the search below bounds itself.
    let walked = tokio::time::timeout(target::remaining(deadline), walk_to(&mut tree, path)).await;
    let (start, from, stated) = match walked {
        Ok(Ok(found)) => found,
        Ok(Err(e)) => {
            sess.close().await;
            return Err(e);
        }
        Err(_) => {
            sess.cancel_and_close().await;
            return Err(target::stopped_waiting(
                "the object tree",
                super::TOOL_DEADLINE,
            ));
        }
    };
    let limits = SearchLimits::default();
    let outcome = search(&mut tree, start, &from, stated, pattern, limits).await;
    sess.close().await;
    Ok(search_reply(
        &c,
        pattern,
        &from,
        &outcome,
        limits,
        started.elapsed(),
    ))
}

async fn open_within(
    paths: &Paths,
    c: &DbConnection,
    deadline: Instant,
) -> Result<ToolSession, String> {
    tokio::time::timeout(target::remaining(deadline), ToolSession::open(paths, c))
        .await
        .map_err(|_| target::stopped_waiting("the connection", super::TOOL_DEADLINE))?
}
