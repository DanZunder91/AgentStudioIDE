//! The bundle **format** and every pure transform over it.
//!
//! `src/features/portability/types.ts` is the **authority**; every type here mirrors it with
//! `#[serde(rename_all = "camelCase")]`. Crypto lives in [`super::seal`] and
//! nothing in this file knows any.
//!
//! ## Why the record types are deliberately lenient on the way in
//!
//! A bundle is a file a person was emailed. Every field below is `#[serde(default)]`, and the
//! numbers are `i64` rather than `u16`/`u32`, so a hostile or merely old file lands as *values
//! this code can refuse individually* instead of as one serde error that would read as
//! "not a bundle". A port of `-1` must become a clamped port with a notice, not a rejected
//! import — guardrails are re-applied on import, and you cannot re-apply a guardrail to a
//! record that failed to parse. Unknown JSON fields are dropped, which is serde's default and is
//! why `deny_unknown_fields` appears nowhere here.
//!
//! ## The redaction heuristic, and what it cannot do
//!
//! See [`redact_header_value`]. It is the single most likely place this feature leaks a
//! credential, and its limits are written out there rather than implied.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use super::seal::SealedPayload;

/// The file's discriminator. A JSON file without exactly this is not a bundle.
pub const BUNDLE_KIND: &str = "agentstudio.bundle";
/// The format version. Bumped only for a change a reader cannot absorb.
pub const BUNDLE_VERSION: i64 = 1;
/// What replaces a redacted header value in `structure` mode.
///
/// A visible marker rather than an empty string, so an imported request fails loudly at send
/// time instead of silently sending `Authorization: ` and returning a confusing 401.
pub const REDACTED_PLACEHOLDER: &str = "{{REDACTED — supply this value}}";
/// Bundle size ceiling, checked against the file's **length** before a byte is read.
pub const MAX_BUNDLE_BYTES: u64 = 8 * 1024 * 1024;

/* ─────────────────────────────── the bundle ─────────────────────────────── */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BundleMode {
    Structure,
    Sealed,
}

impl BundleMode {
    /// The wire spelling, written by hand so the canonical header (which is AEAD additional
    /// data) never depends on a serialiser succeeding.
    pub fn as_str(self) -> &'static str {
        match self {
            BundleMode::Structure => "structure",
            BundleMode::Sealed => "sealed",
        }
    }
}

/// What a bundle says about itself **without** being decrypted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleHeader {
    pub kind: String,
    /// `i64` so a `0` or a negative version arrives as a value the reader can *name* in an
    /// `unsupported-version` message, rather than as a serde failure that would read as
    /// "not a bundle".
    pub version: i64,
    pub mode: BundleMode,
    pub created_at_ms: u64,
    pub app: String,
    pub label: String,
    pub counts: BundleCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BundleCounts {
    pub db_connections: u32,
    pub db_queries: u32,
    pub api_requests: u32,
    pub environments: u32,
    /// Distinct `{{VAR}}` names the contents reference. A count only — a sealed bundle must not
    /// advertise `PROD_API_KEY` on the outside.
    pub referenced_variables: u32,
    /// How many of those carry a VALUE. `0` in `structure` mode, by construction.
    pub secret_values: u32,
}

/// The payload. One shape for both modes; sealing is a wrapper, not a second format.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BundleContents {
    pub db_connections: Vec<ExportedDbConnection>,
    pub db_queries: Vec<ExportedDbQuery>,
    pub api_requests: Vec<ExportedApiRequest>,
    pub environments: Vec<ExportedEnvironment>,
    /// Every `{{VAR}}` anything in this bundle refers to, deduplicated and sorted. Computed at
    /// export because the exporter knows which references were live.
    pub referenced_variables: Vec<String>,
}

/// A whole bundle as it appears on disk. `Bundle extends BundleHeader` in the contract, which is
/// what `flatten` mirrors.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    #[serde(flatten)]
    pub header: BundleHeader,
    /// Present iff `mode == "structure"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contents: Option<BundleContents>,
    /// Present iff `mode == "sealed"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed: Option<SealedPayload>,
}

/* ────────────────────────── the exported records ────────────────────────── */

/// A DB connection, minus everything meaningless or dangerous on another machine.
///
/// Deliberately **not** the full `DbConnection`: no `createdAt`/`updatedAt` (the importer stamps
/// its own), no `family` (denormalised from the engine descriptor on import, never trusted from
/// the file), no `savePassword` (derived from whether a `passwordRef` survived), and **no
/// `caSummary`** — a CA fingerprint describes a certificate file on the sharer's laptop, which
/// the recipient does not have.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportedDbConnection {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub host: String,
    /// `null` (or absent) = **no port**, i.e. the recipient's build should use the engine's
    /// default. `i64` rather than `u16` because a bundle is a file a human can edit: an
    /// out-of-range number must arrive as a *clampable value with a notice*, not as a serde error
    /// that discards the whole import (guardrails are re-applied on import).
    ///
    /// 🔴 `Option`, like `DbConnection::port`. It used to be a plain `i64`, so exporting a
    /// connection whose port field was empty would have invented one — the same defect the record
    /// itself had. `src/features/portability/types.ts` mirrors it as `number | null`.
    pub port: Option<i64>,
    pub database: String,
    pub user: String,
    /// `""` or a `{{VAR}}` name. **Never a value** — and re-checked on import, because a
    /// hand-written bundle could put a literal here.
    pub password_ref: String,
    /// `mongodb+srv://` — DNS seed-list discovery (see `DbConnection::srv`).
    ///
    /// 🔴 Without it an exported Atlas connection arrives on the recipient's machine as a plain
    /// `mongodb://host`, which is precisely the bug that made Atlas unreachable in the first
    /// place — a bundle that silently drops the one bit that makes a connection work is worse than
    /// one that refuses to carry it. The container-level `#[serde(default)]` means an older
    /// bundle still imports (as `false`, the ordinary single-host form).
    pub srv: bool,
    pub ssl_mode: String,
    /// Carried for information and **not honoured on import** (guardrails are re-applied).
    pub read_only: bool,
    pub row_limit: i64,
    pub timeout_ms: i64,
    pub allow_multi_statement: bool,
    pub url: Option<String>,
    pub options: BTreeMap<String, String>,
}

/// A saved query. Travels with its connection's id so the two re-associate on import.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportedDbQuery {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
}

/// An HTTP / WebSocket / gRPC request, headers and all.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportedApiRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<ExportedHeader>,
    pub body: String,
    pub protocol: Option<String>,
    pub grpc_service: Option<String>,
    pub grpc_method: Option<String>,
    pub plaintext: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportedHeader {
    pub name: String,
    pub value: String,
}

/// An environment. `structure` mode makes every `value` `null`; `sealed` mode carries the real
/// one. `null` and `""` are distinguished: `null` means "not exported", `""` means the variable
/// genuinely holds an empty string.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportedEnvironment {
    pub id: String,
    pub name: String,
    pub variables: Vec<ExportedVariable>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportedVariable {
    pub key: String,
    pub value: Option<String>,
}

/* ────────────────────────── inspect, then import ────────────────────────── */

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub header: BundleHeader,
    /// `false` when the bundle is sealed and no passphrase was supplied, or it was wrong.
    pub unsealed: bool,
    pub items: Vec<ImportItem>,
    /// Distinct hosts anything in the bundle would talk to, deduplicated and sorted.
    pub hosts: Vec<String>,
    pub variables: Vec<PlanVariable>,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportAction {
    Create,
    Update,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportItemKind {
    DbConnection,
    DbQuery,
    ApiRequest,
    Environment,
    Variable,
}

impl ImportItemKind {
    /// The wire spelling, written by hand because it is also the **id prefix** — a value that
    /// travels into `ImportChoices.actions` keys and must therefore not depend on a serialiser.
    /// `the_item_kind_spelling_is_the_same_by_hand_and_by_serde` pins the two together.
    pub fn as_str(self) -> &'static str {
        match self {
            ImportItemKind::DbConnection => "dbConnection",
            ImportItemKind::DbQuery => "dbQuery",
            ImportItemKind::ApiRequest => "apiRequest",
            ImportItemKind::Environment => "environment",
            ImportItemKind::Variable => "variable",
        }
    }
}

/// A **plan-scoped key, unique across every kind**: `"<kind>:<native id>"`.
///
/// Namespaced because `ImportChoices.actions` keys on this alone, and the native ids are not drawn
/// from one space — a `variable`'s id is its *name*, an `environment`'s is a uuid, a `dbQuery`'s a
/// ULID. Nothing stopped a variable called `01J…` from colliding with a connection of that id, and
/// the consequence would be one item's "skip" silently applied to another: a mis-routed override
/// that no error would ever report.
pub fn item_id(kind: ImportItemKind, native_id: &str) -> String {
    format!("{}:{}", kind.as_str(), native_id.trim())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub kind: ImportItemKind,
    /// See [`item_id`] — namespaced, **not** the bare record id.
    pub id: String,
    pub label: String,
    pub action: ImportAction,
    pub reason: String,
}

/// One `{{VAR}}` the bundle references, and what this machine already knows about it.
///
/// This and [`ImportPlan::hosts`] are the security surface of the whole feature:
/// an imported request may name `{{PROD_API_KEY}}` — which the recipient's Vault may well
/// hold — while pointing at any host in the world. Intent is not decidable here, so visibility
/// before anything runs is the honest mitigation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanVariable {
    pub name: String,
    pub have_locally: bool,
    pub bundle_has_value: bool,
}

/// The user's decisions, sent back to `portability_import`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportChoices {
    /// Per-item override, keyed by `ImportItem.id`.
    pub actions: HashMap<String, ImportAction>,
    /// Whether an incoming secret value may replace one this machine already has. Defaults to
    /// **false**.
    pub overwrite_existing_secrets: bool,
    /// Whether imported DB connections are made read-only.
    ///
    /// 🔴 **Defaults to `true`, and the explicit `serde` default is load-bearing.** The struct is
    /// `#[serde(default)]`, so a missing field would otherwise become `false` — i.e. an older
    /// frontend, or a hand-written IPC call, would silently import **writable** connections. The
    /// safe value has to be the one that appears when nobody said anything.
    ///
    /// An earlier version *forced* this. It is now **enforced but optional**: the reasoning still
    /// justifies the default — a connection that has just arrived is new *on this machine*, and
    /// the recipient did not make the sharer's choice — but it does not justify removing the
    /// decision from the person looking at the review screen.
    #[serde(default = "read_only_by_default")]
    pub force_read_only: bool,
}

/// `true` — see [`ImportChoices::force_read_only`]. A named function because `serde`'s `default`
/// attribute needs a path, and because the value deserves somewhere to be explained.
fn read_only_by_default() -> bool {
    true
}

impl Default for ImportChoices {
    /// Hand-written because `#[derive(Default)]` would make `force_read_only` **false**, which is
    /// the unsafe value. `Default` is what `#[serde(default)]` uses for a wholly absent object.
    fn default() -> Self {
        Self {
            actions: HashMap::new(),
            overwrite_existing_secrets: false,
            force_read_only: read_only_by_default(),
        }
    }
}

/// What an import did to each kind of thing.
///
/// Deliberately **not** [`BundleCounts`], which describes a *file*. Two differences make them
/// genuinely different types rather than a reuse opportunity: `BundleCounts.referencedVariables`
/// counts distinct `{{VAR}}` **names mentioned**, which is meaningless as an outcome; and what a
/// result needs is the number of variables **written**, which `secretValues` ("how many carry a
/// value") is not. Sharing one type made the receipt read "3 variables" off a field meaning "3
/// names were referenced" — a wrong number in user-facing copy. Two meanings, two types.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub db_connections: u32,
    pub db_queries: u32,
    pub api_requests: u32,
    pub environments: u32,
    /// Variables actually written into this machine's Vault.
    pub variables: u32,
}

/// What actually happened. Counts, not prose, so the UI renders its own summary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created: ImportCounts,
    pub updated: ImportCounts,
    pub skipped: ImportCounts,
    pub notices: Vec<String>,
}

/* ───────────────────────────── export options ───────────────────────────── */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub mode: BundleMode,
    #[serde(default)]
    pub label: String,
    /// Which id sets to include. `None` = all of that kind; `Some(vec![])` = none.
    #[serde(default)]
    pub db_connection_ids: Option<Vec<String>>,
    #[serde(default)]
    pub api_request_ids: Option<Vec<String>>,
    #[serde(default)]
    pub environment_ids: Option<Vec<String>>,
    /// Required and non-empty when `mode == "sealed"`; rejected otherwise.
    #[serde(default)]
    pub passphrase: Option<String>,
}

impl ExportOptions {
    /// Whether `id` is in an optional selection. `None` means "everything".
    pub fn selected(selection: Option<&Vec<String>>, id: &str) -> bool {
        match selection {
            None => true,
            Some(ids) => ids.iter().any(|s| s == id),
        }
    }
}

/* ───────────────────────── the canonical header ───────────────────────── */

/// `kind|version|mode|createdAtMs|label` — the AEAD additional data.
///
/// Built by hand from the header's own fields rather than by serialising it, because a
/// serialiser's key order or number formatting changing would silently make every previously
/// sealed bundle unopenable. `label` goes last so it can contain a `|` without shifting the
/// meaning of any earlier field.
pub fn canonical_header(header: &BundleHeader) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        header.kind,
        header.version,
        header.mode.as_str(),
        header.created_at_ms,
        header.label
    )
}

/* ───────────────────────── `{{VAR}}` references ───────────────────────── */

/// Every `{{VAR}}` name in `text`, in order of appearance (duplicates included).
///
/// A name must be non-empty and contain no whitespace and no braces. That is not pedantry: it is
/// exactly what excludes [`REDACTED_PLACEHOLDER`] (`{{REDACTED — supply this value}}`) from being
/// re-read as a variable named "REDACTED — supply this value", and it matches what
/// `db::secret::vault_var_name` can actually mint (`[A-Z0-9_]`).
pub fn references_in(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != b'{' || bytes[i + 1] != b'{' {
            i += 1;
            continue;
        }
        match text[i + 2..].find("}}") {
            None => break,
            Some(rel) => {
                let inner = &text[i + 2..i + 2 + rel];
                if !inner.is_empty()
                    && !inner.chars().any(|c| c.is_whitespace())
                    && !inner.contains('{')
                    && !inner.contains('}')
                {
                    out.push(inner.to_string());
                }
                i = i + 2 + rel + 2;
            }
        }
    }
    out
}

/// `text` with every `{{…}}` span removed, so what is left is the literal part.
fn strip_references(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("}}") {
            Some(rel) => rest = &rest[start + 2 + rel + 2..],
            None => {
                // An unterminated `{{` is literal text, not a reference.
                out.push_str(&rest[start..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Every distinct `{{VAR}}` the whole payload references, sorted.
///
/// Computed **after** redaction, so the list describes what is actually in the file rather than
/// what was in the store before a value was replaced by [`REDACTED_PLACEHOLDER`].
pub fn referenced_variables(contents: &BundleContents) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for c in &contents.db_connections {
        set.extend(references_in(&c.password_ref));
        if let Some(u) = &c.url {
            set.extend(references_in(u));
        }
        for v in c.options.values() {
            set.extend(references_in(v));
        }
    }
    for q in &contents.db_queries {
        set.extend(references_in(&q.sql));
    }
    for r in &contents.api_requests {
        set.extend(references_in(&r.url));
        set.extend(references_in(&r.body));
        for h in &r.headers {
            set.extend(references_in(&h.value));
        }
    }
    set.into_iter().collect()
}

/* ───────────────────────────────── hosts ───────────────────────────────── */

/// The host component of `text`, tolerating everything the API client accepts.
///
/// Not delegated to the `url` crate for the reason `db/url.rs`'s module doc gives at length:
/// WHATWG-"special" schemes are only `http(s)`/`ws(s)`/`ftp`/`file`, so `postgresql://` and
/// friends get an opaque host the crate rewrites. And a gRPC endpoint (`localhost:50051`) has no
/// scheme at all, while a saved request's URL may begin with `{{BASE_URL}}`.
///
/// Returns `None` when there is nothing host-shaped to show, which is a better plan entry than a
/// row saying `""`.
///
/// Known limitation: a comma-separated **seed list** (`mongodb://a.h:27017,b.h:27017/d`) reports
/// only its first host. Stated rather than glossed — no MongoDB driver is wired in this build, so
/// nothing can currently *reach* the second one, and a plan row per seed would be revisited when
/// one is.
pub fn host_of(text: &str) -> Option<String> {
    let mut s = text.trim();
    if s.is_empty() {
        return None;
    }
    // Strip a scheme, if there is one. Checked by hand rather than by splitting on `://`, so a
    // path containing `://` cannot be mistaken for a scheme.
    if let Some(pos) = s.find("://") {
        let scheme = &s[..pos];
        if !scheme.is_empty()
            && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            s = &s[pos + 3..];
        }
    }
    // The authority ends at the first `/`, `?` or `#`.
    s = s.split(['/', '?', '#']).next().unwrap_or_default();
    // Userinfo, if any. `rfind` because a password may itself contain an `@`.
    if let Some(at) = s.rfind('@') {
        s = &s[at + 1..];
    }
    // A seed list names several servers; the first one is what gets reported. After the userinfo
    // split, so a comma inside a password cannot cut the host off.
    s = s.split(',').next().unwrap_or_default();
    // A port, unless we are inside an IPv6 literal.
    let host = if let Some(end) = s.find(']') {
        &s[..=end]
    } else {
        match s.rfind(':') {
            Some(colon) => &s[..colon],
            None => s,
        }
    };
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    // Hosts are case-insensitive, so folding makes the deduplication real — but only when there
    // is no `{{VAR}}` in play, because lowercasing `{{BASE_URL}}` would print a variable name
    // that does not exist.
    if host.contains("{{") {
        Some(host.to_string())
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Every distinct host anything in `contents` would contact, sorted.
pub fn hosts_in(contents: &BundleContents) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for c in &contents.db_connections {
        set.extend(host_of(&c.host));
        // A URL override names the server that is actually dialled, which may not be `host`.
        if let Some(u) = &c.url {
            set.extend(host_of(u));
        }
    }
    for r in &contents.api_requests {
        set.extend(host_of(&r.url));
    }
    set.into_iter().collect()
}

/* ─────────────────────── the header-redaction heuristic ─────────────────────── */

/// Header names whose value is a credential by definition.
const SENSITIVE_HEADER_NAMES: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
];

/// Substrings that make *any* header name suspect.
const SENSITIVE_HEADER_SUBSTRINGS: &[&str] = &["token", "secret", "key", "password", "passwd"];

/// The alphabet a base64/hex/JWT/`sk-live-…` credential is drawn from.
///
/// `=` is deliberately **excluded** so base64 padding splits a run rather than extending it —
/// which is what lets `session=` (7) stay under the threshold while the base64 body it introduces
/// does not.
fn is_secretish(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '~')
}

/// Longest run of [`is_secretish`] characters. 8 is the threshold; the auth-scheme words a header
/// legitimately contains are all shorter (`Bearer` 6, `Basic` 5, `Token` 5, `Digest` 6).
const SECRETISH_RUN_LIMIT: usize = 8;

/// A Vault value shorter than this is not swept for by exact match.
///
/// A variable holding `1`, `true` or `dev` would otherwise turn every request that contains those
/// three characters into a redacted mess — the classic way a redactor destroys the message while
/// looking like it worked (`db::secret::redact`'s empty-secret guard is the same lesson).
const EXACT_SWEEP_MIN_LEN: usize = 6;

/// `true` iff `name` is a header whose value we treat as secret-bearing.
pub fn header_is_sensitive(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    SENSITIVE_HEADER_NAMES.iter().any(|n| *n == lower)
        || SENSITIVE_HEADER_SUBSTRINGS
            .iter()
            .any(|s| lower.contains(s))
}

/// Longest run of secret-alphabet characters left after every `{{VAR}}` span is removed.
fn longest_secretish_run(text: &str) -> usize {
    let mut best = 0usize;
    let mut run = 0usize;
    for c in text.chars() {
        if is_secretish(c) {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

/// What `structure` mode writes for one header, and whether it redacted.
///
/// ## The rule
///
/// 1. A value on a **non-sensitive** header name is kept verbatim.
/// 2. An **empty** value is kept — there is nothing to leak.
/// 3. On a sensitive name, the value is kept iff, with every `{{VAR}}` span removed, no run of
///    [`SECRETISH_RUN_LIMIT`] or more secret-alphabet characters remains. So
///    `Bearer {{TOKEN}}` → `Bearer ` → run 6 → **kept**; `Bearer sk-live-abc123` → run 18 →
///    **redacted**; `session={{SID}}` → `session=` → run 7 → **kept**.
/// 4. Otherwise the whole value becomes [`REDACTED_PLACEHOLDER`] and the caller adds a notice
///    naming the header.
///
/// ## What this CANNOT catch — stated plainly rather than implied
///
/// * **A secret on a header whose name looks innocent.** `X-Custom-Auth: sk-live-…` and
///   `X-Trace: <a bearer token>` are **not** redacted. Widening rule 3 to every header was
///   measured and rejected: `User-Agent: Mozilla/5.0 (Macintosh; …)` has an 11-character run, so
///   an unconditional scan redacts ordinary requests, and a redactor people learn to distrust is
///   worse than a narrow one. This is a real, accepted false negative.
/// * **A secret shaped like prose.** A passphrase-style credential
///   (`Authorization: my dog has fleas`) has no long run, so rule 3 keeps it.
/// * **A secret that is over-redacted.** `Authorization: Negotiate` (9) is redacted although it
///   carries nothing. Over-redaction is the safe direction and the notice says which header.
/// * **A secret in the request body** — see [`redact_body`], which uses the *exact* sweep only.
///
/// The exact sweep in [`redact_header_value`]'s caller closes the largest part of the real gap,
/// because it needs no heuristic at all: any occurrence of a value this machine's Vault actually
/// holds is certainly a secret, on any header and in any body. And the whole heuristic layer is
/// irrelevant in `sealed` mode, which is the answer for a config whose credentials must travel.
pub fn redact_header_value(name: &str, value: &str) -> Option<&'static str> {
    if value.trim().is_empty() || !header_is_sensitive(name) {
        return None;
    }
    if longest_secretish_run(&strip_references(value)) < SECRETISH_RUN_LIMIT {
        return None;
    }
    Some(REDACTED_PLACEHOLDER)
}

/// Every Vault value long enough to sweep for by exact match, longest first.
///
/// Longest first so a value that contains another (`sk-live-abc` inside `sk-live-abcdef`) does not
/// leave the longer one's tail behind.
pub fn sweepable_secrets(vault: &crate::api_store::ApiStore) -> Vec<String> {
    let mut values: Vec<String> = vault
        .environments
        .iter()
        .flat_map(|e| e.variables.iter())
        .map(|v| v.value.clone())
        .filter(|v| v.chars().count() >= EXACT_SWEEP_MIN_LEN)
        .collect();
    values.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    values.dedup();
    values
}

/// `text` with every known Vault value replaced by [`REDACTED_PLACEHOLDER`]. `true` when
/// something was replaced.
///
/// This is **not** a heuristic: it is exact knowledge of what the secrets on this machine are, so
/// it catches a literal token pasted into any header, any URL and any body — the cases
/// [`redact_header_value`] admits it cannot see.
pub fn redact_body(text: &str, secrets: &[String]) -> (String, bool) {
    let mut out = text.to_string();
    let mut hit = false;
    for s in secrets {
        if out.contains(s.as_str()) {
            out = out.replace(s.as_str(), REDACTED_PLACEHOLDER);
            hit = true;
        }
    }
    (out, hit)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ─────────────────────────── references ─────────────────────────── */

    #[test]
    fn references_are_scanned_out_of_any_position() {
        assert_eq!(references_in("{{A}}"), vec!["A"]);
        assert_eq!(references_in("Bearer {{TOKEN}}"), vec!["TOKEN"]);
        assert_eq!(
            references_in("{{BASE}}/users/{{ID}}?k={{KEY}}"),
            vec!["BASE", "ID", "KEY"]
        );
        // Duplicates survive here; `referenced_variables` is what deduplicates.
        assert_eq!(references_in("{{A}}{{A}}"), vec!["A", "A"]);
    }

    #[test]
    fn the_redaction_placeholder_is_never_read_back_as_a_variable() {
        // 🔴 The specific trap: `REDACTED_PLACEHOLDER` is itself `{{…}}`-shaped. If the scanner
        // accepted it, every redacted header would add a phantom variable to
        // `referencedVariables`, and the import dialog would tell the recipient to supply a
        // variable called "REDACTED — supply this value".
        assert!(REDACTED_PLACEHOLDER.starts_with("{{"));
        assert_eq!(references_in(REDACTED_PLACEHOLDER), Vec::<String>::new());
    }

    #[test]
    fn reference_lookalikes_are_not_references() {
        for text in [
            "", "{}", "{{}}", "{{", "}}", "{{ A }}", "{{a b}}", "{{a{{b}}", "{ {A} }",
        ] {
            assert!(
                references_in(text).is_empty(),
                "{text:?} yielded {:?}",
                references_in(text)
            );
        }
    }

    #[test]
    fn strip_references_leaves_only_the_literal_part() {
        assert_eq!(strip_references("Bearer {{TOKEN}}"), "Bearer ");
        assert_eq!(strip_references("{{A}}x{{B}}y"), "xy");
        // An unterminated `{{` is literal text, so it must survive rather than eat the tail.
        assert_eq!(strip_references("abc {{def"), "abc {{def");
    }

    #[test]
    fn referenced_variables_spans_every_field_and_is_sorted_and_deduped() {
        let contents = BundleContents {
            db_connections: vec![ExportedDbConnection {
                password_ref: "{{PG_PASSWORD}}".into(),
                url: Some("postgresql://ro@h:5432/d?password={{PG_PASSWORD}}".into()),
                options: BTreeMap::from([("application_name".to_string(), "{{APP}}".to_string())]),
                ..Default::default()
            }],
            db_queries: vec![ExportedDbQuery {
                sql: "SELECT * FROM t WHERE k = '{{IN_SQL}}'".into(),
                ..Default::default()
            }],
            api_requests: vec![ExportedApiRequest {
                url: "{{BASE}}/v1/users".into(),
                body: "{\"k\":\"{{IN_BODY}}\"}".into(),
                headers: vec![ExportedHeader {
                    name: "Authorization".into(),
                    value: "Bearer {{TOKEN}}".into(),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            referenced_variables(&contents),
            vec!["APP", "BASE", "IN_BODY", "IN_SQL", "PG_PASSWORD", "TOKEN"]
        );
    }

    /* ───────────────────────────── hosts ───────────────────────────── */

    #[test]
    fn host_of_handles_every_url_shape_the_api_client_accepts() {
        // Literal expectations, hand-written — none derived from the function.
        let cases: &[(&str, Option<&str>)] = &[
            ("https://api.example.com/user", Some("api.example.com")),
            ("https://api.example.com:8443/x", Some("api.example.com")),
            ("http://user:pa@ss@h.example.com/p", Some("h.example.com")),
            ("wss://ws.example.com/socket", Some("ws.example.com")),
            // gRPC endpoints have no scheme at all.
            ("localhost:50051", Some("localhost")),
            (
                "postgresql://ro@db.internal:5432/maestro",
                Some("db.internal"),
            ),
            ("mongodb://a.h:27017,b.h:27017/d", Some("a.h")),
            ("https://[::1]:8080/x", Some("[::1]")),
            ("https://[2001:db8::1]/x", Some("[2001:db8::1]")),
            // Case-folded, so the deduplication in `hosts_in` is real.
            ("https://API.Example.COM/x", Some("api.example.com")),
            // …but NOT when a variable is in play: `{{base_url}}` names nothing.
            ("{{BASE_URL}}/users", Some("{{BASE_URL}}")),
            ("https://{{HOST}}/x", Some("{{HOST}}")),
            ("", None),
            ("   ", None),
            ("/relative/only", None),
            ("https://", None),
        ];
        for (input, want) in cases {
            assert_eq!(host_of(input).as_deref(), *want, "host_of({input:?})");
        }
    }

    #[test]
    fn hosts_in_covers_db_hosts_db_url_overrides_and_request_urls() {
        // 🔴 The hosts are the security surface: a plan with an empty `hosts` array protects
        // nobody.
        let contents = BundleContents {
            db_connections: vec![
                ExportedDbConnection {
                    host: "db.internal".into(),
                    url: Some("postgresql://ro@replica.internal:5432/maestro".into()),
                    ..Default::default()
                },
                ExportedDbConnection {
                    host: "DB.Internal".into(), // same host, different spelling
                    ..Default::default()
                },
            ],
            api_requests: vec![
                ExportedApiRequest {
                    url: "https://api.example.com/v1".into(),
                    ..Default::default()
                },
                ExportedApiRequest {
                    url: "localhost:50051".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            hosts_in(&contents),
            vec![
                "api.example.com",
                "db.internal",
                "localhost",
                "replica.internal"
            ],
            "the URL override's host must be listed too — it is the server actually dialled"
        );
    }

    /* ──────────────────────── header redaction ──────────────────────── */

    #[test]
    fn a_literal_looking_secret_on_a_sensitive_header_is_redacted() {
        let redacted: &[(&str, &str)] = &[
            ("Authorization", "Bearer sk-live-EXAMPLE0000"),
            ("authorization", "Basic YWxhZGRpbjpvcGVuc2VzYW1l"),
            ("Cookie", "session=8f14e45fceea167a5a36dedd4bea2543"),
            ("X-API-Key", "0123456789abcdef0123456789abcdef01234567"),
            ("x-auth-token", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            ("Proxy-Authorization", "Basic dXNlcjpwYXNz"),
            ("X-Refresh-Secret", "hunter2hunter2"),
            ("my-password-header", "correcthorse"),
        ];
        for (name, value) in redacted {
            assert_eq!(
                redact_header_value(name, value),
                Some(REDACTED_PLACEHOLDER),
                "{name}: {value}"
            );
        }
    }

    #[test]
    fn a_reference_an_empty_value_and_an_ordinary_header_are_kept() {
        let kept: &[(&str, &str)] = &[
            // The whole point of `{{VAR}}`: the value lives in the Vault, not in the file.
            ("Authorization", "Bearer {{TOKEN}}"),
            ("Authorization", "Basic {{BASIC_AUTH}}"),
            ("Authorization", "{{AUTH_HEADER}}"),
            ("Cookie", "session={{SESSION_ID}}"),
            ("Authorization", ""),
            ("Authorization", "   "),
            // Not a sensitive name — kept verbatim, which is the documented false negative.
            ("Accept", "application/json"),
            (
                "User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            ),
            ("Content-Type", "application/x-www-form-urlencoded"),
        ];
        for (name, value) in kept {
            assert_eq!(redact_header_value(name, value), None, "{name}: {value}");
        }
    }

    /// The false negative the doc comment admits, asserted so it is a **known** hole rather than
    /// an assumed absence of one. If someone later widens the heuristic, this test says so out
    /// loud instead of quietly passing.
    #[test]
    fn a_secret_on_an_innocent_looking_header_is_a_documented_false_negative() {
        assert_eq!(
            redact_header_value("X-Custom-Auth", "sk-live-EXAMPLE0000"),
            None,
            "the name-gated heuristic cannot see this — sealed mode is the answer"
        );
        // …and prose-shaped secrets slip rule 3 even on a sensitive name.
        assert_eq!(
            redact_header_value("Authorization", "my dog has fleas"),
            None
        );
    }

    #[test]
    fn header_sensitivity_is_case_insensitive_and_substring_based() {
        for name in [
            "Authorization",
            "AUTHORIZATION",
            "  authorization  ",
            "X-Api-Key",
            "x-session-token",
            "Client-Secret",
            "db_password",
            "X-Signing-Key",
        ] {
            assert!(header_is_sensitive(name), "{name}");
        }
        for name in ["Accept", "Content-Type", "User-Agent", "X-Request-Id"] {
            assert!(!header_is_sensitive(name), "{name}");
        }
    }

    /* ──────────────────────── the exact sweep ──────────────────────── */

    #[test]
    fn the_exact_sweep_replaces_a_known_vault_value_anywhere() {
        let secrets = vec!["sk-live-abcdef".to_string()];
        let (out, hit) = redact_body("{\"key\":\"sk-live-abcdef\"}", &secrets);
        assert!(hit);
        assert!(!out.contains("sk-live-abcdef"), "{out}");
        assert!(out.contains(REDACTED_PLACEHOLDER), "{out}");

        let (untouched, miss) = redact_body("{\"key\":\"nothing here\"}", &secrets);
        assert!(!miss);
        assert_eq!(untouched, "{\"key\":\"nothing here\"}");
    }

    #[test]
    fn the_exact_sweep_takes_the_longest_value_first_so_no_tail_survives() {
        // Two Vault rows where one value contains the other. Sweeping the short one first would
        // leave `def` behind in the file — a partial secret is still a leak of its shape.
        let vault = crate::api_store::ApiStore {
            environments: vec![crate::api_store::Environment {
                id: "e".into(),
                name: "e".into(),
                variables: vec![
                    crate::api_store::EnvVar {
                        key: "SHORT".into(),
                        value: "abcdef".into(),
                    },
                    crate::api_store::EnvVar {
                        key: "LONG".into(),
                        value: "abcdefghijkl".into(),
                    },
                ],
            }],
            ..Default::default()
        };
        let secrets = sweepable_secrets(&vault);
        assert_eq!(secrets.first().map(String::as_str), Some("abcdefghijkl"));
        let (out, _) = redact_body("token=abcdefghijkl", &secrets);
        assert!(!out.contains("abcdef"), "{out}");
    }

    #[test]
    fn a_short_vault_value_is_not_swept_for() {
        // A variable holding `1`, `dev` or `true` would otherwise shred every request.
        let vault = crate::api_store::ApiStore {
            environments: vec![crate::api_store::Environment {
                id: "e".into(),
                name: "e".into(),
                variables: vec![
                    crate::api_store::EnvVar {
                        key: "STAGE".into(),
                        value: "dev".into(),
                    },
                    crate::api_store::EnvVar {
                        key: "ON".into(),
                        value: "true".into(),
                    },
                ],
            }],
            ..Default::default()
        };
        assert!(sweepable_secrets(&vault).is_empty());
        let (out, hit) = redact_body("{\"stage\":\"dev\",\"on\":true}", &[]);
        assert!(!hit);
        assert_eq!(out, "{\"stage\":\"dev\",\"on\":true}");
    }

    /* ───────────────────────── the canonical header ───────────────────────── */

    #[test]
    fn the_canonical_header_is_the_five_fields_in_order() {
        let header = BundleHeader {
            kind: BUNDLE_KIND.to_string(),
            version: 1,
            mode: BundleMode::Sealed,
            created_at_ms: 1_785_000_000_000,
            app: "Agent Studio 0.1.0".into(),
            label: "Team staging DB + API".into(),
            counts: BundleCounts::default(),
        };
        assert_eq!(
            canonical_header(&header),
            "agentstudio.bundle|1|sealed|1785000000000|Team staging DB + API"
        );
        // `app` is deliberately NOT bound: it is informational and would break every bundle on
        // a version bump of this app. `counts` is not bound either — it is derived from the
        // ciphertext's own contents, so a lie there is caught by reading them.
        assert!(!canonical_header(&header).contains("Agent Studio"));
    }

    /* ─────────────────────────── the wire shape ─────────────────────────── */

    #[test]
    fn a_structure_bundle_serialises_to_the_contracts_camel_case_shape() {
        let bundle = Bundle {
            header: BundleHeader {
                kind: BUNDLE_KIND.to_string(),
                version: BUNDLE_VERSION,
                mode: BundleMode::Structure,
                created_at_ms: 7,
                app: "Agent Studio 0.1.0".into(),
                label: "L".into(),
                counts: BundleCounts {
                    db_connections: 1,
                    ..Default::default()
                },
            },
            contents: Some(BundleContents::default()),
            sealed: None,
        };
        let json = serde_json::to_value(&bundle).unwrap();
        let obj = json.as_object().expect("an object");
        // `Bundle extends BundleHeader`, so the header's fields are at the top level.
        assert_eq!(obj["kind"], "agentstudio.bundle");
        assert_eq!(obj["mode"], "structure");
        assert_eq!(obj["createdAtMs"], 7);
        assert_eq!(obj["counts"]["dbConnections"], 1);
        assert_eq!(obj["counts"]["referencedVariables"], 0);
        assert!(obj.contains_key("contents"));
        assert!(
            !obj.contains_key("sealed"),
            "a structure bundle must not carry a null `sealed` key: {json}"
        );
        let text = json.to_string();
        for snake in ["created_at_ms", "db_connections", "referenced_variables"] {
            assert!(!text.contains(snake), "snake_case leaked: {snake}");
        }
    }

    #[test]
    fn an_exported_record_serialises_every_field_the_contract_lists() {
        let json = serde_json::to_value(ExportedDbConnection::default()).unwrap();
        let obj = json.as_object().unwrap();
        for key in [
            "id",
            "name",
            "engine",
            "host",
            "port",
            "database",
            "user",
            "passwordRef",
            // Mirrors `DbConnection::srv`. It is on this list — and the count
            // below is 16 rather than 15 — because a bundle that cannot carry the SRV bit re-creates
            // the unreachable-Atlas bug on the recipient's machine.
            "srv",
            "sslMode",
            "readOnly",
            "rowLimit",
            "timeoutMs",
            "allowMultiStatement",
            "url",
            "options",
        ] {
            assert!(obj.contains_key(key), "missing {key}: {json}");
        }
        assert_eq!(obj.len(), 16, "an unlisted field appeared: {json}");
        // `null`, not absent and not a number: an exported connection with an empty port field must
        // not acquire one by being shared (`types.ts` declares `number | null`).
        assert_eq!(obj["port"], serde_json::Value::Null);

        let req = serde_json::to_value(ExportedApiRequest::default()).unwrap();
        for key in [
            "id",
            "name",
            "method",
            "url",
            "headers",
            "body",
            "protocol",
            "grpcService",
            "grpcMethod",
            "plaintext",
        ] {
            assert!(req.get(key).is_some(), "missing {key}: {req}");
        }
        // `null`, not absent: the contract types these as `string | null`.
        assert_eq!(req["protocol"], serde_json::Value::Null);

        let env = serde_json::to_value(ExportedEnvironment {
            id: "e".into(),
            name: "prod".into(),
            variables: vec![ExportedVariable {
                key: "K".into(),
                value: None,
            }],
        })
        .unwrap();
        assert_eq!(env["variables"][0]["value"], serde_json::Value::Null);
    }

    #[test]
    fn an_unknown_json_field_is_dropped_rather_than_failing_the_parse() {
        // A newer app's bundle, or someone's hand edit. Dropping is serde's default and is what
        // re-applying guardrails asks for; `deny_unknown_fields` would make every
        // forward-compatible addition a hard failure on this build.
        let value = serde_json::json!({
            "id": "c1", "name": "Prod", "engine": "postgres", "host": "h",
            "port": 5432, "somethingNew": {"nested": true}
        });
        let parsed: ExportedDbConnection = serde_json::from_value(value).expect("lenient");
        assert_eq!(parsed.id, "c1");
        assert_eq!(parsed.port, Some(5432));
        // Absent fields take their defaults rather than failing. `srv` is one of them, and its
        // default is the ordinary single-host form — an older bundle must not import as SRV.
        assert!(!parsed.srv);
        assert_eq!(parsed.password_ref, "");
        assert!(parsed.options.is_empty());
    }

    #[test]
    fn hostile_numbers_parse_as_values_that_can_be_clamped_rather_than_parse_errors() {
        // The reason `port`/`rowLimit`/`timeoutMs` are `i64`: a negative or huge number must
        // reach the clamp, not abort the whole import as "not a bundle".
        let parsed: ExportedDbConnection = serde_json::from_value(serde_json::json!({
            "id": "c", "port": -1, "rowLimit": 99999999999i64, "timeoutMs": 0
        }))
        .expect("hostile numbers must still parse");
        assert_eq!(parsed.port, Some(-1));
        assert_eq!(parsed.row_limit, 99_999_999_999);
        assert_eq!(parsed.timeout_ms, 0);

        // …and an ABSENT port is not a hostile number: it is the legitimate "no port, use the
        // engine's default" state `DbConnection::port` can hold. It must arrive as
        // `None` so the importer carries it across instead of clamping it to a default it then
        // reports as a correction.
        let no_port: ExportedDbConnection =
            serde_json::from_value(serde_json::json!({"id": "c"})).expect("parses");
        assert_eq!(no_port.port, None);
    }

    #[test]
    fn selection_treats_absent_as_all_and_empty_as_none() {
        assert!(ExportOptions::selected(None, "anything"));
        assert!(!ExportOptions::selected(Some(&vec![]), "anything"));
        assert!(ExportOptions::selected(Some(&vec!["a".into()]), "a"));
        assert!(!ExportOptions::selected(Some(&vec!["a".into()]), "b"));
    }
}
