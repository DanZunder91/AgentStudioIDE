//! Account rate-limit windows for the usage strip (wire: `src/features/usage/usageTypes.ts`),
//! parsed from `claude -p --no-session-persistence "/usage"`: no token, Keychain or socket here.
//! Never drop `--no-session-persistence`: each poll would write a transcript into `~/.claude`.

use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::spawn::NoWindow as _;
use regex::Regex;
use serde::Serialize;
use tokio::process::Command;

/// Whole-call deadline. The strip polls every ~5 s and one `/usage` answers in ~1 s,
/// so 15 s is generous while still self-clearing: a wedged CLI can never pile up.
const CLI_TIMEOUT: Duration = Duration::from_secs(15);

/// The flag that keeps a poll from leaving a transcript behind (module doc). Named
/// so it cannot be dropped by an accidental edit to an argument list.
const NO_SESSION_PERSISTENCE: &str = "--no-session-persistence";

/// The slash command whose output we parse.
const USAGE_COMMAND: &str = "/usage";

/// Every `Err` from [`claude_usage`] is `"<code>"` or `"<code>: <detail>"` from this list, which
/// mirrors `UsageErrorCode` in `usageTypes.ts`; the frontend splits on the first `':'`.
pub const ERROR_CODES: [&str; 6] = [
    "cli-missing",
    "not-signed-in",
    "cli-failed",
    "timeout",
    "parse",
    "unknown",
];

/// Phrasings meaning "not authenticated", a guess (no signed-out run captured). Consulted only
/// when the run otherwise failed; never `"authenticat"`, which matches the success word.
const SIGNED_OUT_MARKERS: [&str; 8] = [
    "not logged in",
    "not signed in",
    "logged out",
    "log in",
    "/login",
    "authenticate",
    "authentication required",
    "invalid api key",
];

/// One usage window, exactly as `UsageWindow` in `usageTypes.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Stable slug of the CLI's own row label (`current-session`,
    /// `current-week-all-models`, …) — the React key and the test handle.
    pub key: String,
    /// What the user reads: the CLI's wording, condensed
    /// ("Current session", "All models", "Fable").
    pub label: String,
    /// Percent consumed, 0..=100, as the CLI reported it (unrounded; the UI rounds).
    pub used_pct: f64,
    /// When the window resets, unix **ms** — `None` when the CLI's wording could not
    /// be parsed confidently. The UI then shows no reset hint, which is honest; we
    /// never guess an instant.
    pub resets_at_ms: Option<i64>,
}

/// A whole reading of the account's limits, in the order the CLI printed them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub windows: Vec<UsageWindow>,
    /// When this reading was taken, unix ms.
    pub fetched_at_ms: i64,
}

/// Read the account's usage windows via the local `claude` CLI. `Err` is an [`ERROR_CODES`]
/// code; a detail never carries the captured output beyond its truncated first line.
#[tauri::command]
pub async fn claude_usage() -> Result<UsageSnapshot, String> {
    // Resolve exactly as an agent spawn does (packaged apps get a minimal PATH; Windows npm
    // shims): never reimplement it here, a second copy would drift untested.
    let claude = crate::agent::claude::resolve_invocation()
        .map_err(|_| "cli-missing: the claude CLI could not be found".to_string())?;
    let captured = run_usage_cli(&claude).await?;
    interpret(&captured, now_ms(), local_offset_secs())
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/// What one `claude -p "/usage"` run produced.
#[derive(Debug, Clone)]
pub struct Captured {
    /// The process exit code — `None` when it was killed by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Spawn the CLI with null stdin (never hang on a prompt) and cwd = home, wait bounded, capture
/// both streams. `kill_on_drop` makes the timeout non-leaky: dropping the `Child` kills it.
async fn run_usage_cli(
    claude: &crate::agent::claude::ClaudeInvocation,
) -> Result<Captured, String> {
    let mut cmd = Command::new(&claude.program);
    cmd.args(&claude.prefix)
        .arg("-p")
        .arg(NO_SESSION_PERSISTENCE)
        .arg(USAGE_COMMAND)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window();
    if let Some(home) = crate::agent::claude::home_dir() {
        cmd.current_dir(home);
    }

    let child = cmd.spawn().map_err(|e| spawn_error(e.kind()))?;
    match tokio::time::timeout(CLI_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => Ok(Captured {
            code: out.status.code(),
            // Lossy on purpose: a stray non-UTF-8 byte in a progress spinner must
            // not turn a perfectly good reading into an error.
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Ok(Err(_)) => Err("unknown: the CLI could not be run".to_string()),
        Err(_elapsed) => Err("timeout".to_string()),
    }
}

/// `NotFound` (the resolved path vanished, e.g. mid-upgrade) is `cli-missing`; any other
/// spawn failure can't be named honestly, so it is `unknown`.
fn spawn_error(kind: std::io::ErrorKind) -> String {
    match kind {
        std::io::ErrorKind::NotFound => "cli-missing: the claude CLI could not be run".to_string(),
        _ => "unknown: the claude CLI could not be started".to_string(),
    }
}

/// Turn a finished run into a snapshot or a coded error. A parseable reading is never
/// second-guessed: signed-out markers are consulted only when the run failed or had no rows.
fn interpret(
    captured: &Captured,
    now_ms: i64,
    offset_secs: Option<i32>,
) -> Result<UsageSnapshot, String> {
    match captured.code {
        Some(0) => parse_usage_output_with_offset(&captured.stdout, now_ms, offset_secs).map_err(
            |parse_err| {
                if looks_signed_out(captured) {
                    "not-signed-in".to_string()
                } else {
                    parse_err
                }
            },
        ),
        Some(code) => Err(if looks_signed_out(captured) {
            "not-signed-in".to_string()
        } else {
            match first_line(&captured.stderr).or_else(|| first_line(&captured.stdout)) {
                Some(detail) => format!("cli-failed: exit {code} ({detail})"),
                None => format!("cli-failed: exit {code}"),
            }
        }),
        // No exit code = killed by a signal. Our own timeout returns `timeout`
        // before this can happen, so reaching here means something else killed it.
        None => Err(if looks_signed_out(captured) {
            "not-signed-in".to_string()
        } else {
            "unknown: the CLI ended without an exit code".to_string()
        }),
    }
}

/// Does either stream say the CLI is not authenticated? Case-insensitive.
fn looks_signed_out(captured: &Captured) -> bool {
    let haystack = format!("{}\n{}", captured.stdout, captured.stderr).to_lowercase();
    SIGNED_OUT_MARKERS
        .iter()
        .any(|marker| haystack.contains(marker))
}

/// The first non-blank line, ANSI-stripped and truncated — short enough to be an
/// error detail, never the whole capture.
fn first_line(text: &str) -> Option<String> {
    let line = strip_ansi(text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .to_string();
    let mut short: String = line.chars().take(DETAIL_MAX_CHARS).collect();
    if short.chars().count() < line.chars().count() {
        short.push('…');
    }
    Some(short)
}

/// Cap on an error detail. Long enough to be useful, short enough that it cannot be
/// a transcript.
const DETAIL_MAX_CHARS: usize = 80;

/// Wall clock as unix ms (0 if the clock is somehow before the epoch).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// The machine's UTC offset
// ---------------------------------------------------------------------------

/// Seconds east of UTC now, via `git2` (std has no local-time API); the CLI prints reset times
/// in local wall clock. A DST change before the reset (up to 7 days out) shifts it an hour,
/// acceptable for a coarse "resets in …" hint.
fn local_offset_secs() -> Option<i32> {
    // The name/email are placeholders: libgit2 only rejects empty ones (and angle
    // brackets). Nothing is written anywhere — no repo is even opened.
    let minutes = git2::Signature::now("agentstudio", "usage@localhost")
        .ok()?
        .when()
        .offset_minutes();
    // Real offsets live in ±14:00; anything wilder means we misread it, and a wrong
    // offset must degrade to "no reset hint", never to a wrong time.
    (-14 * 60..=14 * 60)
        .contains(&minutes)
        .then_some(minutes * 60)
}

// ---------------------------------------------------------------------------
// The parser (pure)
// ---------------------------------------------------------------------------

/// A usage row: `<label>: <number>% used`, optional `· resets <when>`. The literal `% used` is
/// the key guard: contribution lines (`80% of your usage came from…`) must never be windows.
static RE_PCT_USED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([0-9]+(?:\.[0-9]+)?)\s*%\s*used\b").expect("static regex"));

/// The reset clause; `·` is not required, since the CLI also uses it in lists (`Last 24h · …`).
static RE_RESET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\breset(?:s|ting)?\b\s*(.+)$").expect("static regex"));

/// A trailing parenthesised timezone name, e.g. ` (UTC)` — dropped.
static RE_TRAILING_PARENS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*\([^()]*\)\s*$").expect("static regex"));

/// Relative wording: `in 4 hr 34 min`, `in 34 min`, `in 2 days`, `in 1 h 5 m`. At
/// least one component must be present (enforced by the caller).
static RE_RELATIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?ix)
        ^in \s+
        (?: ([0-9]+) \s* (?: days|day|d )   \b \s* )?
        (?: ([0-9]+) \s* (?: hours|hour|hrs|hr|h ) \b \s* )?
        (?: ([0-9]+) \s* (?: minutes|minute|mins|min|m ) \b \s* )?
        $",
    )
    .expect("static regex")
});

/// The clock part of an absolute reset, anchored at the END of the wording:
/// `3:10pm`, `11am`, `15:10`, `3:10 p.m.`. Anchoring at the end is what lets the
/// date be whatever precedes it without a grammar for it.
static RE_TIME_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([0-9]{1,2})(?::([0-9]{2}))?\s*(?:([ap])\.?\s?m\.?)?\s*$")
        .expect("static regex")
});

/// `Jul 29` / `July 29`, optionally `on `/`at `-prefixed (the CLI writes
/// `resets Jul 29 at …`, but `resets at Jul 29 …` is just as plausible a wording).
static RE_MONTH_DAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:on|at)\s+)?([a-z]{3,9})\s+([0-9]{1,2})$").expect("static regex")
});

/// `29 Jul` — the other order, accepted because it costs one regex and a
/// non-US-formatted CLI would otherwise silently lose every reset hint.
static RE_DAY_MONTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:on|at)\s+)?([0-9]{1,2})\s+([a-z]{3,9})$").expect("static regex")
});

/// A dangling `at` and/or `,`/`-`/`·` left after cutting the clock. `at` is optional: newer
/// CLIs write `resets Aug 26, 4am`, and a kept comma would make `RE_MONTH_DAY` refuse the day.
static RE_TRAILING_AT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[\s,\-·]*(?:\bat\b)?[\s,\-·]*$").expect("static regex"));

/// Parse `/usage` output, resolving reset times against the machine's current UTC offset;
/// tests use [`parse_usage_output_with_offset`] to stay hermetic.
pub fn parse_usage_output(stdout: &str, now_ms: i64) -> Result<UsageSnapshot, String> {
    parse_usage_output_with_offset(stdout, now_ms, local_offset_secs())
}

/// [`parse_usage_output`] with the UTC offset injected (`None` = unknown, which makes
/// every *absolute* reset wording unparseable — relative wording still resolves).
pub fn parse_usage_output_with_offset(
    stdout: &str,
    now_ms: i64,
    offset_secs: Option<i32>,
) -> Result<UsageSnapshot, String> {
    let clean = strip_ansi(stdout);
    let mut windows: Vec<UsageWindow> = Vec::new();
    for line in clean.lines() {
        if let Some(window) = parse_window_row(line, now_ms, offset_secs, &windows) {
            windows.push(window);
        }
    }
    if windows.is_empty() {
        return Err("parse: no usage rows in the CLI output".to_string());
    }
    Ok(UsageSnapshot {
        // Print order is the CLI's, and the CLI's order is the product's: session
        // first, then the weeklies. We do not re-rank it.
        windows,
        fetched_at_ms: now_ms,
    })
}

/// One line → a window, or `None` when the line is not a usage row.
///
/// `existing` is only used to keep `key` unique (the UI uses it as a React key).
fn parse_window_row(
    line: &str,
    now_ms: i64,
    offset_secs: Option<i32>,
    existing: &[UsageWindow],
) -> Option<UsageWindow> {
    let line = line.trim();
    // 1. The `% used` marker — the row/contribution discriminator.
    let pct_match = RE_PCT_USED.captures(line)?;
    let whole = pct_match.get(0)?;
    // 2. A label, separated by a colon, entirely BEFORE the percentage. This is the
    //    second guard: a contribution line has no colon before its percent.
    let colon = line.find(':')?;
    if colon >= whole.start() {
        return None;
    }
    let raw_label = line[..colon].trim();
    if raw_label.is_empty() {
        return None;
    }
    // 3. The number. `f64::parse` cannot fail on the regex's own capture, but a
    //    ridiculous count of digits can overflow to inf — clamping handles it.
    let used_pct = pct_match
        .get(1)?
        .as_str()
        .parse::<f64>()
        .ok()
        .filter(|n| !n.is_nan())?
        .clamp(0.0, 100.0);
    // 4. Everything after `% used` may hold a reset clause. Unparseable → None.
    let resets_at_ms = parse_reset_clause(&line[whole.end()..], now_ms, offset_secs);

    Some(UsageWindow {
        key: unique_key(&slugify(raw_label), existing),
        label: condense_label(raw_label),
        used_pct,
        resets_at_ms,
    })
}

/// `resets Jul 29 at 3:10pm (UTC)` → unix ms, or `None`.
fn parse_reset_clause(tail: &str, now_ms: i64, offset_secs: Option<i32>) -> Option<i64> {
    let when = RE_RESET.captures(tail)?.get(1)?.as_str().trim();
    // The parenthesised zone name is dropped: see `local_offset_secs` for why the OS
    // offset is used instead of trying to honour the name.
    let when = RE_TRAILING_PARENS.replace(when, "").trim().to_string();
    parse_reset_when(&when, now_ms, offset_secs)
}

/// The reset *wording* → unix ms. Split out from the clause so every supported form
/// can be tested directly.
fn parse_reset_when(when: &str, now_ms: i64, offset_secs: Option<i32>) -> Option<i64> {
    parse_relative_when(when, now_ms).or_else(|| parse_absolute_when(when, now_ms, offset_secs?))
}

/// `in 4 hr 34 min` → `now + 4h34m`. Needs no timezone at all.
fn parse_relative_when(when: &str, now_ms: i64) -> Option<i64> {
    let caps = RE_RELATIVE.captures(when)?;
    let part = |i: usize| -> i64 {
        caps.get(i)
            .and_then(|m| m.as_str().parse::<i64>().ok())
            .unwrap_or(0)
    };
    let (days, hours, mins) = (part(1), part(2), part(3));
    if days == 0 && hours == 0 && mins == 0 {
        // `in ` with nothing quantified (or all zeroes) is not a time we can honour.
        return None;
    }
    Some(now_ms + ((days * 24 + hours) * 3600 + mins * 60) * 1000)
}

/// `Jul 29 at 3:10pm`, `Aug 2 at 11am`, `tomorrow at 9am`, `15:10`, `3:10pm` → unix ms.
fn parse_absolute_when(when: &str, now_ms: i64, offset_secs: i32) -> Option<i64> {
    let caps = RE_TIME_TAIL.captures(when)?;
    let whole = caps.get(0)?;
    let hour_raw: i64 = caps.get(1)?.as_str().parse().ok()?;
    let minute: i64 = match caps.get(2) {
        Some(m) => m.as_str().parse().ok()?,
        None => 0,
    };
    if minute > 59 {
        return None;
    }
    let meridiem = caps.get(3).map(|m| m.as_str().to_ascii_lowercase());
    let hour = match meridiem.as_deref() {
        Some("a") if (1..=12).contains(&hour_raw) => hour_raw % 12,
        Some("p") if (1..=12).contains(&hour_raw) => hour_raw % 12 + 12,
        Some(_) => return None,
        // No am/pm: a colon form is read as a 24-hour clock (what a 24h locale
        // means), but a BARE hour is genuinely ambiguous — `11` could be either
        // half of the day — so we refuse it rather than guess.
        None if caps.get(2).is_some() && hour_raw <= 23 => hour_raw,
        None => return None,
    };

    // Whatever preceded the clock is the date (possibly nothing).
    let head = RE_TRAILING_AT
        .replace(line_head(when, whole.start()), "")
        .trim()
        .to_string();
    let (today_y, today_m, today_d) = local_civil_date(now_ms, offset_secs);

    if head.is_empty() || head.eq_ignore_ascii_case("today") {
        let candidate = local_instant_ms(today_y, today_m, today_d, hour, minute, offset_secs);
        // A bare clock with no date means the next occurrence: if it already passed
        // today, the CLI meant tomorrow. An explicit "today" is taken literally.
        if head.is_empty() && candidate <= now_ms {
            return Some(local_instant_ms(
                today_y,
                today_m,
                today_d + 1,
                hour,
                minute,
                offset_secs,
            ));
        }
        return Some(candidate);
    }
    if head.eq_ignore_ascii_case("tomorrow") {
        return Some(local_instant_ms(
            today_y,
            today_m,
            today_d + 1,
            hour,
            minute,
            offset_secs,
        ));
    }

    let (month, day) = parse_month_day(&head)?;
    // The CLI never prints a year, so pick the one that puts the date NEAREST to
    // now — which is what makes a Dec→Jan (or Jan→Dec) rollover come out right.
    [today_y - 1, today_y, today_y + 1]
        .into_iter()
        .filter(|y| day <= days_in_month(*y, month))
        .map(|y| local_instant_ms(y, month, day, hour, minute, offset_secs))
        .min_by_key(|ms| (ms - now_ms).abs())
}

/// `&when[..end]`, on a char boundary (the regex gives us one, but slicing a `&str`
/// deserves a named helper rather than an inline panic risk).
fn line_head(when: &str, end: usize) -> &str {
    when.get(..end).unwrap_or("")
}

/// `Jul 29` or `29 Jul` → `(month, day)`. Anything else (a weekday name, a date
/// format we have not seen) is `None`, which becomes "no reset hint".
fn parse_month_day(head: &str) -> Option<(i64, i64)> {
    if let Some(c) = RE_MONTH_DAY.captures(head) {
        let month = month_from_name(c.get(1)?.as_str())?;
        let day: i64 = c.get(2)?.as_str().parse().ok()?;
        return (day >= 1).then_some((month, day));
    }
    let c = RE_DAY_MONTH.captures(head)?;
    let day: i64 = c.get(1)?.as_str().parse().ok()?;
    let month = month_from_name(c.get(2)?.as_str())?;
    (day >= 1).then_some((month, day))
}

/// English month name or 3+ letter prefix → 1..=12. A prefix must be a real prefix
/// (`jul`/`july` yes, `juliet` no), so a stray word cannot masquerade as a month.
fn month_from_name(name: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    let lower = name.to_ascii_lowercase();
    if lower.len() < 3 {
        return None;
    }
    MONTHS
        .iter()
        .position(|m| m.starts_with(&lower))
        .map(|i| i as i64 + 1)
}

// ---------------------------------------------------------------------------
// Labels + keys
// ---------------------------------------------------------------------------

/// Condense the CLI's row label (`Current week (all models)` → `All models`, `(<Model>)` →
/// `<Model>`); anything unknown passes through unchanged so a new row still renders.
fn condense_label(raw: &str) -> String {
    let raw = raw.trim();
    let Some(inner) = week_parenthetical(raw) else {
        return raw.to_string();
    };
    if inner.eq_ignore_ascii_case("all models") {
        return "All models".to_string();
    }
    inner.to_string()
}

/// The `X` of `Current week (X)`, case-insensitively, or `None`. `Current weekend
/// (X)` is deliberately NOT a match — only the exact prefix plus a parenthetical.
fn week_parenthetical(raw: &str) -> Option<&str> {
    const PREFIX_LEN: usize = "current week".len();
    if !raw.get(..PREFIX_LEN)?.eq_ignore_ascii_case("current week") {
        return None;
    }
    let inner = raw
        .get(PREFIX_LEN..)?
        .trim_start()
        .strip_prefix('(')?
        .strip_suffix(')')?
        .trim();
    (!inner.is_empty()).then_some(inner)
}

/// Stable slug of the CLI's ORIGINAL label (`current-week-all-models`), so the key survives a
/// change to our display wording.
fn slugify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Keep keys unique (React needs that) without changing the first one: a second row
/// slugging to the same value becomes `<key>-2`, then `-3`, …
fn unique_key(base: &str, existing: &[UsageWindow]) -> String {
    let base = if base.is_empty() { "window" } else { base };
    if !existing.iter().any(|w| w.key == base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !existing.iter().any(|w| &w.key == candidate))
        .unwrap_or_else(|| base.to_string())
}

// ---------------------------------------------------------------------------
// Calendar arithmetic (no date crate in the tree we may depend on)
// ---------------------------------------------------------------------------

const SECS_PER_DAY: i64 = 86_400;

/// The local civil date (`y`, `m`, `d`) at `now_ms`.
fn local_civil_date(now_ms: i64, offset_secs: i32) -> (i64, i64, i64) {
    let local_secs = div_floor(now_ms, 1000) + offset_secs as i64;
    civil_from_days(div_floor(local_secs, SECS_PER_DAY))
}

/// A local wall-clock date+time → unix ms. `d` may be out of range (e.g. `32`);
/// `days_from_civil` normalises it, which is how "tomorrow" is expressed as `d + 1`.
fn local_instant_ms(y: i64, m: i64, d: i64, hour: i64, minute: i64, offset_secs: i32) -> i64 {
    let secs =
        days_from_civil(y, m, d) * SECS_PER_DAY + hour * 3600 + minute * 60 - offset_secs as i64;
    secs * 1000
}

/// Floor division (`-1 / 2 == 0` in Rust, but a date before the epoch needs `-1`).
fn div_floor(a: i64, b: i64) -> i64 {
    let q = a / b;
    if a % b != 0 && ((a < 0) != (b < 0)) {
        q - 1
    } else {
        q
    }
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (month + 9) % 12; // Mar=0 … Feb=11
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of [`days_from_civil`] (Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Days in a month, so `Feb 31` is refused instead of silently becoming March 3.
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Strip ANSI CSI/OSC escapes. `-p` output was measured plain, but a future release
/// that colours a percentage must not break the row matcher.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            // CSI … final byte in @–~
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC … BEL or ESC \
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// A sample of what `claude -p --no-session-persistence "/usage"` prints, in the
    /// CLI's exact shape — U+00B7 middle dots included. Everything the parser
    /// promises is asserted against this, not against a hand-tidied idealisation.
    const SAMPLE_OUTPUT: &str = "\
You are currently using your subscription to power your Claude Code usage

Current session: 20% used · resets Jul 29 at 3:10pm (UTC)
Current week (all models): 40% used · resets Aug 2 at 11am (UTC)
Current week (Fable): 60% used · resets Aug 2 at 10:59am (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — the numbers below are a guide
Last 24h · 500 requests · 4 sessions
  80% of your usage came from subagent-heavy sessions
  10% came from long single-agent turns
";

    /// Its contribution block holds the nastiest negatives: `Top subagents: general-purpose 30%`
    /// is a window row's shape minus `% used`.
    const SAMPLE_OUTPUT_2: &str = "\
You are currently using your subscription to power your Claude Code usage

Current session: 25% used · resets Jul 29 at 3:09pm (UTC)
Current week (all models): 45% used · resets Aug 2 at 10:59am (UTC)
Current week (Fable): 65% used · resets Aug 2 at 10:59am (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 600 requests · 4 sessions
  80% of your usage came from subagent-heavy sessions
  50% of your usage was at >150k context
  Top subagents: general-purpose 30%, Explore 10%
  Top MCP servers: example-mcp 5%

Last 7d · 3000 requests · 20 sessions
  90% of your usage came from subagent-heavy sessions
  70% of your usage was at >150k context
  40% of your usage came from sessions active for 8+ hours
  Top subagents: general-purpose 20%, Explore 5%, claude 2%, workflow-subagent 1%
  Top MCP servers: example-mcp 5%
";

    /// A newer CLI's shape: `resets Aug 26, 4am` (comma, no `at`) and a session row with no
    /// reset clause.
    const SAMPLE_OUTPUT_3: &str = "\
You are currently using your subscription to power your Claude Code usage

Current session: 0% used
Current week (all models): 10% used · resets Aug 26, 4am (UTC)
Current week (Fable): 5% used · resets Aug 26, 4am (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 100 requests · 3 sessions
  50% of your usage was at >150k context
  Top MCP servers: example-mcp 5%

Last 7d · 2000 requests · 12 sessions
  70% of your usage came from subagent-heavy sessions
  40% of your usage was at >150k context
  Top subagents: general-purpose 40%
  Top MCP servers: example-mcp 10%
";

    /// 2026-07-29 12:00 UTC = 2026-07-29T12:00:00Z (verified with `date -u`).
    const NOW: i64 = 1_785_326_400_000;
    /// The offset every test injects, so no test depends on the tester's timezone.
    const UTC_OFFSET: Option<i32> = Some(0);

    fn keys(s: &UsageSnapshot) -> Vec<&str> {
        s.windows.iter().map(|w| w.key.as_str()).collect()
    }

    fn labels(s: &UsageSnapshot) -> Vec<&str> {
        s.windows.iter().map(|w| w.label.as_str()).collect()
    }

    fn sample() -> UsageSnapshot {
        parse_usage_output_with_offset(SAMPLE_OUTPUT, NOW, UTC_OFFSET)
            .expect("the sample output must parse")
    }

    // ── the sample output ──────────────────────────────────────────────────

    #[test]
    fn parses_all_three_windows_of_the_sample_output_in_print_order() {
        let snap = sample();
        assert_eq!(
            keys(&snap),
            vec![
                "current-session",
                "current-week-all-models",
                "current-week-fable"
            ],
            "keys are slugs of the CLI's own labels, in the CLI's order"
        );
        assert_eq!(
            labels(&snap),
            vec!["Current session", "All models", "Fable"],
            "the condensed wording"
        );
        assert_eq!(
            snap.windows.iter().map(|w| w.used_pct).collect::<Vec<_>>(),
            vec![20.0, 40.0, 60.0]
        );
        assert_eq!(
            snap.fetched_at_ms, NOW,
            "the injected clock, never a real one"
        );
    }

    #[test]
    fn resolves_every_reset_time_of_the_sample_output() {
        let snap = sample();
        // Verified with `date -u -j`: 3:10pm UTC on Jul 29 is 15:10Z, etc.
        assert_eq!(
            snap.windows[0].resets_at_ms,
            Some(1_785_337_800_000),
            "Jul 29 at 3:10pm (UTC)"
        );
        assert_eq!(
            snap.windows[1].resets_at_ms,
            Some(1_785_668_400_000),
            "Aug 2 at 11am — no minutes"
        );
        assert_eq!(
            snap.windows[2].resets_at_ms,
            Some(1_785_668_340_000),
            "Aug 2 at 10:59am"
        );
    }

    #[test]
    fn the_middle_dot_separator_is_not_used_to_split_rows() {
        // The `·` appears in BOTH the window rows and the `Last 24h · …` line, so a
        // matcher that split on it would either mis-parse or drop rows. Proof: the
        // same rows parse with the dot removed entirely.
        let no_dots = SAMPLE_OUTPUT.replace(" · ", " ");
        let snap = parse_usage_output_with_offset(&no_dots, NOW, UTC_OFFSET).unwrap();
        assert_eq!(snap.windows.len(), 3);
        assert_eq!(snap.windows[0].resets_at_ms, Some(1_785_337_800_000));
    }

    // ── negative cases: what is NOT a window ──────────────────────────────

    #[test]
    fn the_contribution_percentage_line_is_not_a_window() {
        // THE critical negative case: it contains a percent AND the word usage.
        let line = "  80% of your usage came from subagent-heavy sessions";
        assert!(parse_window_row(line, NOW, UTC_OFFSET, &[]).is_none());
        // Two independent guards reject it (no `% used`, and no colon before the
        // percent). Pin them separately, so neither can rot behind the other: this
        // variant HAS a label-shaped colon and must still be rejected on `% used`.
        assert!(
            parse_window_row(
                "Contribution: 80% of your usage came from subagent-heavy sessions",
                NOW,
                UTC_OFFSET,
                &[]
            )
            .is_none(),
            "`% used` is the discriminator — a colon does not make prose a row"
        );
        assert_eq!(
            parse_usage_output_with_offset(line, NOW, UTC_OFFSET).unwrap_err(),
            "parse: no usage rows in the CLI output",
            "a whole output of contribution lines yields no windows at all"
        );
        // And it is not silently absorbed into the sample reading either.
        assert_eq!(sample().windows.len(), 3);
    }

    #[test]
    fn the_second_sample_parses_to_the_same_three_windows() {
        let snap = parse_usage_output_with_offset(SAMPLE_OUTPUT_2, NOW, UTC_OFFSET)
            .expect("the second sample must parse");
        assert_eq!(
            keys(&snap),
            vec![
                "current-session",
                "current-week-all-models",
                "current-week-fable"
            ],
            "a longer contribution block must not add phantom windows"
        );
        assert_eq!(
            snap.windows.iter().map(|w| w.used_pct).collect::<Vec<_>>(),
            vec![25.0, 45.0, 65.0]
        );
        assert_eq!(
            snap.windows[0].resets_at_ms,
            Some(1_785_337_740_000),
            "Jul 29 at 3:09pm UTC = 2026-07-29T15:09:00Z"
        );
        assert_eq!(snap.windows[1].resets_at_ms, Some(1_785_668_340_000));
        assert_eq!(snap.windows[2].resets_at_ms, Some(1_785_668_340_000));
    }

    #[test]
    fn the_third_sample_parses_including_the_comma_reset_wording() {
        // The variable is the CLI version, not the platform: newer CLIs drop the `at`.
        let snap = parse_usage_output_with_offset(SAMPLE_OUTPUT_3, NOW, UTC_OFFSET)
            .expect("the third sample must parse");
        assert_eq!(
            keys(&snap),
            vec![
                "current-session",
                "current-week-all-models",
                "current-week-fable"
            ]
        );
        assert_eq!(
            snap.windows.iter().map(|w| w.used_pct).collect::<Vec<_>>(),
            vec![0.0, 10.0, 5.0]
        );
        assert_eq!(
            snap.windows[0].resets_at_ms, None,
            "the session row has no reset clause — honest None, not a guess"
        );
        // Aug 26 at 4am UTC = 2026-08-26T04:00:00Z (verified with `date -u`).
        assert_eq!(snap.windows[1].resets_at_ms, Some(1_787_716_800_000));
        assert_eq!(snap.windows[2].resets_at_ms, Some(1_787_716_800_000));
    }

    #[test]
    fn the_top_subagents_and_top_mcp_lines_are_not_windows() {
        // Lines from the second sample, and the closest thing in the output to
        // a false positive: `<label>: … <number>%`. Only `% used` separates them.
        for line in [
            "  Top subagents: general-purpose 30%, Explore 10%",
            "  Top MCP servers: example-mcp 5%",
            "  Top subagents: general-purpose 20%, Explore 5%, claude 2%",
            "  50% of your usage was at >150k context",
            "  40% of your usage came from sessions active for 8+ hours",
            "Last 7d · 3000 requests · 20 sessions",
        ] {
            assert!(
                parse_window_row(line, NOW, UTC_OFFSET, &[]).is_none(),
                "must not be a window: {line:?}"
            );
        }
    }

    #[test]
    fn the_last_24h_stats_line_is_not_a_window() {
        let line = "Last 24h · 500 requests · 4 sessions";
        assert!(parse_window_row(line, NOW, UTC_OFFSET, &[]).is_none());
    }

    #[test]
    fn the_preamble_and_prose_lines_are_not_windows() {
        for line in [
            "You are currently using your subscription to power your Claude Code usage",
            "What's contributing to your limits usage?",
            "Approximate, based on local sessions on this machine — a guide",
            "",
            "   ",
        ] {
            assert!(
                parse_window_row(line, NOW, UTC_OFFSET, &[]).is_none(),
                "must not be a window: {line:?}"
            );
        }
    }

    #[test]
    fn a_percentage_with_a_colon_after_it_is_not_a_window() {
        // The colon must come BEFORE the percentage, or it is not a label separator.
        assert!(parse_window_row("80% used: whatever", NOW, UTC_OFFSET, &[]).is_none());
        assert!(
            parse_window_row("20% used", NOW, UTC_OFFSET, &[]).is_none(),
            "no label"
        );
        assert!(
            parse_window_row(": 20% used", NOW, UTC_OFFSET, &[]).is_none(),
            "blank label"
        );
    }

    #[test]
    fn an_empty_output_is_a_parse_error() {
        for text in ["", "   ", "\n\n", "Something went sideways"] {
            let err = parse_usage_output_with_offset(text, NOW, UTC_OFFSET).unwrap_err();
            assert_eq!(
                err, "parse: no usage rows in the CLI output",
                "for {text:?}"
            );
        }
    }

    #[test]
    fn the_header_without_any_rows_is_a_parse_error() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\n\
                    What's contributing to your limits usage?\n\
                    Last 24h · 500 requests · 4 sessions\n\
                    \x2080% of your usage came from subagent-heavy sessions\n";
        assert!(parse_usage_output_with_offset(text, NOW, UTC_OFFSET).is_err());
    }

    // ── percentages ───────────────────────────────────────────────────────

    #[test]
    fn percentages_parse_as_integers_and_decimals_and_clamp_to_0_100() {
        let pct = |line: &str| parse_window_row(line, NOW, UTC_OFFSET, &[]).map(|w| w.used_pct);
        assert_eq!(pct("W: 0% used"), Some(0.0));
        assert_eq!(pct("W: 100% used"), Some(100.0));
        assert_eq!(pct("W: 20% used"), Some(20.0));
        assert_eq!(
            pct("W: 42.5% used"),
            Some(42.5),
            "decimals survive unrounded"
        );
        assert_eq!(pct("W: 140% used"), Some(100.0), "clamped high");
        assert_eq!(pct("W: 20 % used"), Some(20.0), "spacing is tolerated");
        assert_eq!(pct("W: 20%used"), Some(20.0), "so is no spacing");
        assert_eq!(pct("W: 20% USED"), Some(20.0), "case-insensitive");
    }

    #[test]
    fn a_row_with_no_number_is_not_a_window() {
        // Never invent a number: no digits means no row.
        assert!(parse_window_row("W: % used", NOW, UTC_OFFSET, &[]).is_none());
        assert!(parse_window_row("W: some% used", NOW, UTC_OFFSET, &[]).is_none());
        assert!(parse_window_row("W: forty-one percent used", NOW, UTC_OFFSET, &[]).is_none());
    }

    #[test]
    fn used_is_required_so_a_bare_percentage_row_is_ignored() {
        assert!(parse_window_row("Current session: 20%", NOW, UTC_OFFSET, &[]).is_none());
        assert!(parse_window_row("Current session: 20% remaining", NOW, UTC_OFFSET, &[]).is_none());
    }

    // ── labels + keys ─────────────────────────────────────────────────────

    #[test]
    fn labels_condense_to_the_short_wording() {
        assert_eq!(condense_label("Current session"), "Current session");
        assert_eq!(condense_label("Current week (all models)"), "All models");
        assert_eq!(condense_label("Current week (All Models)"), "All models");
        assert_eq!(condense_label("Current week (Fable)"), "Fable");
        assert_eq!(condense_label("Current week (Opus 4.5)"), "Opus 4.5");
        assert_eq!(
            condense_label("current week (sonnet)"),
            "sonnet",
            "the parenthetical is passed through verbatim, case included"
        );
    }

    #[test]
    fn an_unknown_label_passes_through_unchanged() {
        // A row the CLI adds tomorrow must render in ITS words, never be dropped.
        for raw in [
            "Current month",
            "Extra quota",
            "Current week",
            "Current weekend (Fable)",
            "Uso de la sesión",
        ] {
            assert_eq!(condense_label(raw), raw, "{raw} must pass through");
        }
        let snap =
            parse_usage_output_with_offset("Current month: 12% used", NOW, UTC_OFFSET).unwrap();
        assert_eq!(labels(&snap), vec!["Current month"]);
        assert_eq!(keys(&snap), vec!["current-month"]);
    }

    #[test]
    fn slugs_are_stable_lowercase_and_punctuation_free() {
        assert_eq!(slugify("Current session"), "current-session");
        assert_eq!(
            slugify("Current week (all models)"),
            "current-week-all-models"
        );
        assert_eq!(slugify("Current week (Fable)"), "current-week-fable");
        assert_eq!(
            slugify("Current week (Opus 4.5!)"),
            "current-week-opus-4-5",
            "a model name with punctuation still slugs cleanly"
        );
        assert_eq!(slugify("  spaced   out  "), "spaced-out");
        assert_eq!(slugify("--weird--"), "weird");
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn slugify_is_deterministic() {
        // Same input, same key, every time and in any order — the UI uses it as a
        // React key and our tests use it as a handle.
        for raw in [
            "Current session",
            "Current week (all models)",
            "Current week (Fable)",
            "Ünïcode Wéek (Fable)",
        ] {
            let first = slugify(raw);
            for _ in 0..5 {
                assert_eq!(slugify(raw), first);
            }
        }
        // Two runs of the sample output agree exactly.
        assert_eq!(keys(&sample()), keys(&sample()));
    }

    #[test]
    fn duplicate_labels_get_distinct_keys() {
        let text =
            "Current session: 10% used\nCurrent session: 20% used\nCurrent session: 30% used";
        let snap = parse_usage_output_with_offset(text, NOW, UTC_OFFSET).unwrap();
        assert_eq!(
            keys(&snap),
            vec!["current-session", "current-session-2", "current-session-3"],
            "React keys must be unique even if the CLI repeats a label"
        );
    }

    #[test]
    fn a_label_that_slugs_to_nothing_still_gets_a_key() {
        let snap = parse_usage_output_with_offset("!!!: 5% used", NOW, UTC_OFFSET).unwrap();
        assert_eq!(keys(&snap), vec!["window"]);
    }

    // ── reset wording ─────────────────────────────────────────────────────

    /// `Some(ms)` for a reset wording, resolved at UTC at [`NOW`].
    fn reset(when: &str) -> Option<i64> {
        parse_reset_when(when, NOW, UTC_OFFSET)
    }

    #[test]
    fn reset_parses_a_month_day_and_12h_clock() {
        assert_eq!(reset("Jul 29 at 3:10pm"), Some(1_785_337_800_000));
        assert_eq!(
            reset("Jul 29 at 3:10 PM"),
            Some(1_785_337_800_000),
            "case and spacing"
        );
        assert_eq!(
            reset("Jul 29 at 3:10 p.m."),
            Some(1_785_337_800_000),
            "dotted meridiem"
        );
        assert_eq!(
            reset("July 29 at 3:10pm"),
            Some(1_785_337_800_000),
            "a full month name"
        );
        assert_eq!(
            reset("29 Jul at 3:10pm"),
            Some(1_785_337_800_000),
            "day-first order"
        );
        assert_eq!(
            reset("Jul 29 3:10pm"),
            Some(1_785_337_800_000),
            "the word `at` is optional"
        );
    }

    #[test]
    fn a_comma_between_date_and_clock_reads_like_at() {
        // The newer CLI's wording (`resets Aug 26, 4am`) — the missing-tooltip bug.
        // Aug 26 at 4am UTC = 2026-08-26T04:00:00Z.
        assert_eq!(reset("Aug 26, 4am"), Some(1_787_716_800_000));
        assert_eq!(
            reset("Aug 26, 4:00am"),
            Some(1_787_716_800_000),
            "with minutes"
        );
        assert_eq!(
            reset("26 Aug, 4am"),
            Some(1_787_716_800_000),
            "day-first order"
        );
        assert_eq!(
            reset("Jul 29, 3:10pm"),
            reset("Jul 29 at 3:10pm"),
            "comma and `at` are the same instant"
        );
        assert_eq!(
            reset("Aug 26, at 4am"),
            Some(1_787_716_800_000),
            "both separators at once — strip them all"
        );
    }

    #[test]
    fn reset_parses_the_no_minutes_form() {
        assert_eq!(reset("Aug 2 at 11am"), Some(1_785_668_400_000));
        assert_eq!(
            reset("Aug 2 at 12am"),
            reset("Aug 2 at 12:00am"),
            "midnight"
        );
        assert_eq!(reset("Aug 2 at 12pm"), reset("Aug 2 at 12:00pm"), "noon");
    }

    #[test]
    fn midnight_and_noon_map_to_the_right_half_of_the_day() {
        // 12am is 00:00 and 12pm is 12:00 — the classic off-by-twelve.
        let midnight = reset("Jul 29 at 12am").unwrap();
        let noon = reset("Jul 29 at 12pm").unwrap();
        assert_eq!(noon - midnight, 12 * 3600 * 1000);
        // 12am UTC on Jul 29 = 2026-07-29T00:00:00Z.
        assert_eq!(midnight, 1_785_283_200_000);
    }

    #[test]
    fn reset_parses_a_24h_clock() {
        assert_eq!(reset("Jul 29 at 15:10"), Some(1_785_337_800_000));
        assert_eq!(reset("Jul 29 at 06:10"), reset("Jul 29 at 6:10am"));
        assert_eq!(reset("Jul 29 at 00:00"), reset("Jul 29 at 12am"));
        assert_eq!(
            reset("Jul 29 at 24:10"),
            None,
            "hour 24 is not a time we will guess at"
        );
    }

    #[test]
    fn reset_with_no_date_means_today_or_tomorrow() {
        // NOW is 12:00 UTC. 3:10pm is later today…
        assert_eq!(reset("3:10pm"), Some(1_785_337_800_000));
        // …and 10:00am has already passed, so it must mean tomorrow.
        assert_eq!(
            reset("10:00am"),
            Some(1_785_405_600_000),
            "2026-07-30T10:00:00Z"
        );
        assert_eq!(
            reset("at 10:00am"),
            Some(1_785_405_600_000),
            "a dangling `at` is stripped"
        );
        // An explicit "today" is taken literally, even in the past.
        assert_eq!(
            reset("today at 10:00am"),
            Some(1_785_319_200_000),
            "2026-07-29T10:00:00Z — `today` is not silently advanced"
        );
        assert_eq!(reset("tomorrow at 3:10pm"), Some(1_785_424_200_000));
    }

    #[test]
    fn a_bare_hour_with_no_minutes_and_no_meridiem_is_refused() {
        // "11" could be either half of the day. None > a coin flip.
        assert_eq!(reset("11"), None);
        assert_eq!(reset("Jul 29 at 11"), None);
        // But with a meridiem it is unambiguous.
        assert_eq!(
            reset("Jul 29 at 11am"),
            Some(1_785_322_800_000),
            "2026-07-29T11:00:00Z"
        );
    }

    #[test]
    fn reset_parses_relative_wording_without_needing_a_timezone() {
        assert_eq!(
            reset("in 4 hr 34 min"),
            Some(NOW + (4 * 60 + 34) * 60 * 1000)
        );
        assert_eq!(reset("in 34 min"), Some(NOW + 34 * 60 * 1000));
        assert_eq!(reset("in 2 hours"), Some(NOW + 2 * 3600 * 1000));
        assert_eq!(reset("in 1 hour 5 minutes"), Some(NOW + 65 * 60 * 1000));
        assert_eq!(reset("in 3h 5m"), Some(NOW + 185 * 60 * 1000));
        assert_eq!(reset("in 2 days"), Some(NOW + 2 * 24 * 3600 * 1000));
        assert_eq!(
            parse_reset_when("in 4 hr 34 min", NOW, None),
            Some(NOW + (4 * 60 + 34) * 60 * 1000),
            "relative wording resolves even when the machine offset is unknown"
        );
    }

    #[test]
    fn the_year_is_the_one_that_puts_the_date_nearest_to_now() {
        // Dec → Jan rollover: NOW is 2026-12-31 20:00 UTC.
        const NEW_YEARS_EVE: i64 = 1_798_747_200_000;
        assert_eq!(
            parse_reset_when("Jan 1 at 9am", NEW_YEARS_EVE, UTC_OFFSET),
            Some(1_798_794_000_000),
            "Jan 1 9am UTC = 2027-01-01T09:00:00Z — next year, not this one"
        );
        // …and the other direction: just past midnight, a Dec 31 reset is LAST year.
        const NEW_YEARS_DAY: i64 = 1_798_794_000_000; // 2027-01-01 09:00 UTC
        assert_eq!(
            parse_reset_when("Dec 31 at 11pm", NEW_YEARS_DAY, UTC_OFFSET),
            Some(1_798_758_000_000),
            "2026-12-31T23:00:00Z — the nearest Dec 31, which is behind us"
        );
    }

    #[test]
    fn a_reset_wording_we_cannot_read_is_none_never_a_guess() {
        for bad in [
            "",
            "soon",
            "at some point",
            "next week",
            "Monday at 9am",
            "Foo 29 at 3:10pm",
            "Juliet 29 at 3:10pm",
            "Feb 31 at 3:10pm",
            "Jul 0 at 3:10pm",
            "Jul 29 at 3:75pm",
            "Jul 29 at 13:10pm",
            "2026-07-29T15:10:00Z",
            "in a while",
            "in 0 min",
            "in",
        ] {
            assert_eq!(reset(bad), None, "must not guess an instant for {bad:?}");
        }
    }

    #[test]
    fn an_absolute_reset_needs_the_machine_offset_and_degrades_to_none_without_it() {
        assert_eq!(
            parse_reset_when("Jul 29 at 3:10pm", NOW, None),
            None,
            "without an offset a wall clock is not an instant — say nothing"
        );
        let snap = parse_usage_output_with_offset(SAMPLE_OUTPUT, NOW, None).unwrap();
        assert!(
            snap.windows.iter().all(|w| w.resets_at_ms.is_none()),
            "the percentages still render; only the reset hints go quiet"
        );
        assert_eq!(snap.windows.len(), 3);
    }

    #[test]
    fn a_row_with_no_reset_clause_yields_none() {
        let snap =
            parse_usage_output_with_offset("Current session: 20% used", NOW, UTC_OFFSET).unwrap();
        assert_eq!(snap.windows[0].resets_at_ms, None);
        assert_eq!(snap.windows[0].used_pct, 20.0);
    }

    #[test]
    fn the_parenthesised_timezone_name_is_ignored_not_honoured() {
        // Same wall clock, three zone names → the same instant, resolved from the
        // machine offset. (Documented track: honouring the name needs a tz database.)
        let a = parse_reset_clause(" · resets Jul 29 at 3:10pm (UTC)", NOW, UTC_OFFSET);
        let b = parse_reset_clause(
            " · resets Jul 29 at 3:10pm (America/New_York)",
            NOW,
            UTC_OFFSET,
        );
        let c = parse_reset_clause(" · resets Jul 29 at 3:10pm", NOW, UTC_OFFSET);
        assert_eq!(a, Some(1_785_337_800_000));
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn the_reset_verb_is_matched_tolerantly() {
        for clause in [
            " · resets Jul 29 at 3:10pm (UTC)",
            " - reset Jul 29 at 3:10pm",
            ", resetting Jul 29 at 3:10pm",
            " · Resets at Jul 29 3:10pm",
        ] {
            assert_eq!(
                parse_reset_clause(clause, NOW, UTC_OFFSET),
                Some(1_785_337_800_000),
                "clause: {clause:?}"
            );
        }
        assert_eq!(
            parse_reset_clause(" · Jul 29 at 3:10pm", NOW, UTC_OFFSET),
            None,
            "without the word `reset` the tail is not a reset clause"
        );
    }

    // ── calendar helpers ──────────────────────────────────────────────────

    #[test]
    fn civil_days_round_trip_including_leap_days_and_before_the_epoch() {
        for (y, m, d) in [
            (1970, 1, 1),
            (2024, 2, 29),
            (2026, 7, 29),
            (2027, 1, 1),
            (1969, 12, 31),
            (2100, 3, 1),
        ] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d), "{y}-{m}-{d}");
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn local_civil_date_uses_the_offset_not_utc() {
        // 2026-07-29T15:00:00Z is already Jul 30 twelve hours east of UTC.
        let late = 1_785_337_200_000;
        assert_eq!(local_civil_date(late, 12 * 3600), (2026, 7, 30));
        assert_eq!(local_civil_date(late, 0), (2026, 7, 29));
        assert_eq!(local_civil_date(late, -5 * 3600), (2026, 7, 29));
        // Just after the epoch, west of UTC, the local date is 1969.
        assert_eq!(local_civil_date(0, -5 * 3600), (1969, 12, 31));
    }

    #[test]
    fn div_floor_rounds_toward_negative_infinity() {
        assert_eq!(div_floor(-1, 2), -1, "Rust's `/` would give 0");
        assert_eq!(div_floor(-2, 2), -1);
        assert_eq!(div_floor(1, 2), 0);
        assert_eq!(div_floor(-86_400_000, 1000), -86_400);
    }

    #[test]
    fn month_names_accept_prefixes_but_not_impostors() {
        assert_eq!(month_from_name("Jan"), Some(1));
        assert_eq!(month_from_name("jul"), Some(7));
        assert_eq!(month_from_name("July"), Some(7));
        assert_eq!(month_from_name("DECEMBER"), Some(12));
        assert_eq!(month_from_name("may"), Some(5));
        assert_eq!(month_from_name("ju"), None, "too short to disambiguate");
        assert_eq!(month_from_name("juliet"), None, "not a real prefix");
        assert_eq!(month_from_name("foo"), None);
        assert_eq!(month_from_name(""), None);
    }

    #[test]
    fn days_in_month_knows_leap_years() {
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2000, 2), 29, "a 400-year leap year");
        assert_eq!(days_in_month(1900, 2), 28, "a century that is not");
        assert_eq!(days_in_month(2026, 4), 30);
        assert_eq!(days_in_month(2026, 12), 31);
        assert_eq!(days_in_month(2026, 13), 0, "no such month");
    }

    // ── the process boundary, without a process ───────────────────────────

    fn captured(code: Option<i32>, stdout: &str, stderr: &str) -> Captured {
        Captured {
            code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn a_successful_run_is_interpreted_as_a_snapshot() {
        let snap = interpret(&captured(Some(0), SAMPLE_OUTPUT, ""), NOW, UTC_OFFSET).unwrap();
        assert_eq!(snap.windows.len(), 3);
        assert_eq!(snap.fetched_at_ms, NOW);
    }

    #[test]
    fn a_non_zero_exit_is_cli_failed_with_a_short_detail() {
        let err = interpret(
            &captured(Some(2), "", "boom: something broke\nline two"),
            NOW,
            UTC_OFFSET,
        )
        .unwrap_err();
        assert_eq!(err, "cli-failed: exit 2 (boom: something broke)");
        assert_eq!(
            interpret(&captured(Some(2), "", ""), NOW, UTC_OFFSET).unwrap_err(),
            "cli-failed: exit 2",
            "no stderr, no parenthetical"
        );
    }

    #[test]
    fn a_failure_detail_is_truncated_and_never_the_whole_output() {
        let long = "x".repeat(500);
        let err = interpret(&captured(Some(1), "", &long), NOW, UTC_OFFSET).unwrap_err();
        assert!(err.chars().count() < 120, "detail must stay short: {err}");
        assert!(err.contains('…'), "truncation is visible: {err}");
        assert!(!err.contains(&long));
    }

    #[test]
    fn a_signed_out_cli_is_not_signed_in_however_it_words_it() {
        for text in [
            "You are not logged in",
            "Please log in with `claude /login`",
            "Run /login to continue",
            "Unable to authenticate",
            "Authentication required",
            "Invalid API key",
            "You have been logged out",
            "not signed in",
        ] {
            assert_eq!(
                interpret(&captured(Some(1), text, ""), NOW, UTC_OFFSET).unwrap_err(),
                "not-signed-in",
                "stdout: {text:?}"
            );
            assert_eq!(
                interpret(&captured(Some(1), "", text), NOW, UTC_OFFSET).unwrap_err(),
                "not-signed-in",
                "stderr: {text:?}"
            );
        }
    }

    #[test]
    fn a_signed_out_message_on_a_zero_exit_is_still_not_signed_in() {
        // The CLI could report it without failing; a parse error would be misleading.
        let err = interpret(
            &captured(Some(0), "Please log in to continue", ""),
            NOW,
            UTC_OFFSET,
        )
        .unwrap_err();
        assert_eq!(err, "not-signed-in");
    }

    #[test]
    fn a_good_reading_is_never_overridden_by_the_signed_out_heuristic() {
        // A working run that happens to contain a marker word must still parse —
        // the markers are only consulted when there is nothing to report.
        let text = format!("{SAMPLE_OUTPUT}\nTip: run /login to switch accounts\n");
        let snap = interpret(&captured(Some(0), &text, ""), NOW, UTC_OFFSET).unwrap();
        assert_eq!(snap.windows.len(), 3);
    }

    #[test]
    fn a_zero_exit_with_unreadable_output_is_a_parse_error() {
        let err = interpret(&captured(Some(0), "hello there", ""), NOW, UTC_OFFSET).unwrap_err();
        assert_eq!(err, "parse: no usage rows in the CLI output");
    }

    #[test]
    fn a_signal_killed_run_is_unknown() {
        let err = interpret(&captured(None, "", ""), NOW, UTC_OFFSET).unwrap_err();
        assert_eq!(err, "unknown: the CLI ended without an exit code");
    }

    #[test]
    fn a_missing_binary_at_spawn_time_is_cli_missing() {
        assert_eq!(
            spawn_error(std::io::ErrorKind::NotFound),
            "cli-missing: the claude CLI could not be run"
        );
        assert_eq!(
            spawn_error(std::io::ErrorKind::PermissionDenied),
            "unknown: the claude CLI could not be started",
            "a failure we cannot name honestly is `unknown`, not a guess"
        );
    }

    #[test]
    fn every_error_string_starts_with_a_documented_code() {
        // The frontend splits on the first ':' — an undocumented prefix renders as a
        // raw Rust string, so pin the whole vocabulary. All six codes appear here.
        let samples = vec![
            "cli-missing: the claude CLI could not be found".to_string(),
            spawn_error(std::io::ErrorKind::NotFound),
            spawn_error(std::io::ErrorKind::Other),
            "timeout".to_string(),
            interpret(&captured(Some(1), "not logged in", ""), NOW, UTC_OFFSET).unwrap_err(),
            interpret(&captured(Some(3), "", "nope"), NOW, UTC_OFFSET).unwrap_err(),
            interpret(&captured(None, "", ""), NOW, UTC_OFFSET).unwrap_err(),
            interpret(&captured(Some(0), "nothing here", ""), NOW, UTC_OFFSET).unwrap_err(),
            parse_usage_output_with_offset("", NOW, UTC_OFFSET).unwrap_err(),
            "unknown: the CLI could not be run".to_string(),
        ];
        for s in &samples {
            let code = s.split(':').next().unwrap();
            assert!(
                ERROR_CODES.contains(&code),
                "undocumented error code in {s:?}"
            );
        }
        // …and every documented code is actually produced by one of them.
        for code in ERROR_CODES {
            assert!(
                samples.iter().any(|s| s.split(':').next() == Some(code)),
                "no sample produces {code}"
            );
        }
    }

    #[test]
    fn the_timeout_is_bounded_so_polls_cannot_pile_up() {
        assert!(CLI_TIMEOUT <= Duration::from_secs(20));
        assert!(CLI_TIMEOUT >= Duration::from_secs(5));
    }

    #[test]
    fn the_no_session_persistence_flag_is_still_the_one_we_pass() {
        // Dropping this flag would write ~720 transcripts/hour into ~/.claude and
        // flood the Recover session picker (module doc). Pin the literal.
        assert_eq!(NO_SESSION_PERSISTENCE, "--no-session-persistence");
        assert_eq!(USAGE_COMMAND, "/usage");
    }

    // ── the wire shape ────────────────────────────────────────────────────

    #[test]
    fn the_snapshot_serializes_camel_case_exactly_as_the_frontend_expects() {
        let snap = parse_usage_output_with_offset(
            "Current session: 20% used · resets Jul 29 at 3:10pm (UTC)",
            NOW,
            UTC_OFFSET,
        )
        .unwrap();
        let v = serde_json::to_value(&snap).unwrap();
        assert_eq!(
            v,
            json!({
                "windows": [{
                    "key": "current-session",
                    "label": "Current session",
                    "usedPct": 20.0,
                    "resetsAtMs": 1_785_337_800_000_i64,
                }],
                "fetchedAtMs": NOW,
            })
        );
        assert_eq!(
            v.as_object().unwrap().len(),
            2,
            "exactly two top-level fields"
        );
    }

    #[test]
    fn an_absent_reset_serializes_as_null_not_a_missing_field() {
        let snap =
            parse_usage_output_with_offset("Current session: 0% used", NOW, UTC_OFFSET).unwrap();
        let v = serde_json::to_value(&snap).unwrap();
        assert_eq!(v["windows"][0]["resetsAtMs"], Value::Null);
        assert!(
            v["windows"][0]
                .as_object()
                .unwrap()
                .contains_key("resetsAtMs"),
            "the field must exist so the TS `number | null` is honest"
        );
    }

    // ── ANSI hygiene ──────────────────────────────────────────────────────

    #[test]
    fn ansi_coloured_output_still_parses() {
        let coloured = "Current session: \x1b[1m20%\x1b[0m used · resets Jul 29 at 3:10pm";
        let snap = parse_usage_output_with_offset(coloured, NOW, UTC_OFFSET).unwrap();
        assert_eq!(snap.windows[0].used_pct, 20.0);
        assert_eq!(snap.windows[0].resets_at_ms, Some(1_785_337_800_000));
    }

    #[test]
    fn strip_ansi_removes_csi_and_osc_and_keeps_text() {
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("\x1b]0;title\x07after"), "after");
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\after"), "after");
        assert_eq!(strip_ansi("a\x1bZb"), "ab", "a stray two-byte escape");
        assert_eq!(strip_ansi("keeps · dots"), "keeps · dots");
    }

    // Live smoke, the ONE test against the real CLI (`-- --ignored live_smoke` after an upgrade):
    // captured fixtures only prove we read output we saw once; `/usage` wording is no contract.
    #[test]
    #[ignore = "spawns the real `claude` CLI — run with --ignored"]
    fn live_smoke_reads_real_usage_from_the_cli() {
        let snap = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(claude_usage())
            .expect("claude_usage should succeed on a signed-in machine");

        assert!(
            !snap.windows.is_empty(),
            "no windows parsed from the live CLI — its wording has probably changed"
        );
        for w in &snap.windows {
            assert!(!w.key.is_empty(), "window has no key");
            assert!(!w.label.is_empty(), "window has no label");
            assert!(
                !w.label.contains('_'),
                "label `{}` looks like a raw slug, not display text",
                w.label
            );
            assert!(
                (0.0..=100.0).contains(&w.used_pct),
                "used_pct {} out of range",
                w.used_pct
            );
        }
        assert!(snap.fetched_at_ms > 0, "fetched_at_ms not stamped");

        let claude = crate::agent::claude::resolve_invocation().expect("resolved above");
        let captured = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(run_usage_cli(&claude))
            .expect("the CLI ran above");

        // Every `<label>: N% used` line printed must be a parsed window; no specific row is
        // required (newer CLIs can omit `Current session`).
        let parsed: Vec<&str> = snap.windows.iter().map(|w| w.label.as_str()).collect();
        for line in captured.stdout.lines().map(str::trim) {
            let Some((label, rest)) = line.split_once(':') else {
                continue;
            };
            if !rest.contains("% used") {
                continue;
            }
            let label = condense_label(label);
            assert!(
                parsed.contains(&label.as_str()),
                "the CLI printed `{line}`, but no window `{label}` was parsed (got {parsed:?})"
            );
        }

        // Rows can parse while reset wording silently doesn't: if the CLI printed reset wording and
        // the offset is readable, at least one window must resolve an instant.
        if captured.stdout.to_lowercase().contains("reset") && local_offset_secs().is_some() {
            assert!(
                snap.windows.iter().any(|w| w.resets_at_ms.is_some()),
                "the CLI printed reset wording but no window resolved a reset time — \
                 its wording has changed again"
            );
        }
    }

    // ── the machine offset (tolerant on purpose: it IS the machine's) ─────

    #[test]
    fn the_local_offset_is_a_plausible_utc_offset() {
        // Cannot assert a value without pinning the tester's timezone,
        // so assert the contract instead: a real offset, or None — never nonsense.
        if let Some(secs) = local_offset_secs() {
            assert!(
                (-14 * 3600..=14 * 3600).contains(&secs),
                "implausible offset {secs}"
            );
            assert_eq!(secs % 900, 0, "real offsets are whole quarter-hours");
        }
    }

    #[test]
    fn the_public_entry_point_parses_without_a_clock_or_a_pinned_timezone() {
        // `parse_usage_output` = the injected-offset parser + the machine's offset, so
        // this asserts only what is timezone-INDEPENDENT. The exact ms
        // values are pinned by the injected-offset tests above.
        let snap = parse_usage_output(SAMPLE_OUTPUT, NOW).expect("the sample output must parse");
        assert_eq!(
            labels(&snap),
            vec!["Current session", "All models", "Fable"]
        );
        assert_eq!(
            snap.windows.iter().map(|w| w.used_pct).collect::<Vec<_>>(),
            vec![20.0, 40.0, 60.0]
        );
        assert_eq!(snap.fetched_at_ms, NOW, "no hidden SystemTime::now");
        // Whatever the tester's zone, a resolved reset must land within a fortnight of
        // `now` — the windows are 5h/7d, so anything further means a broken offset.
        for w in &snap.windows {
            if let Some(ms) = w.resets_at_ms {
                assert!(
                    (ms - NOW).abs() < 14 * 24 * 3600 * 1000,
                    "{} resets implausibly far from now: {ms}",
                    w.key
                );
            }
        }
        assert!(parse_usage_output("", NOW).is_err());
    }

    #[test]
    fn the_offset_is_used_as_seconds_east_of_utc() {
        // Sign convention, pinned without touching the machine: a positive offset
        // means the same wall clock is EARLIER in UTC.
        let east = local_instant_ms(2026, 7, 29, 15, 10, 12 * 3600);
        let utc = local_instant_ms(2026, 7, 29, 15, 10, 0);
        let west = local_instant_ms(2026, 7, 29, 15, 10, -4 * 3600);
        assert!(east < utc && utc < west);
        assert_eq!(utc - east, 12 * 3600 * 1000);
        assert_eq!(west - utc, 4 * 3600 * 1000);
    }
}
