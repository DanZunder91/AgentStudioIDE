//! Statement splitting and the row-returning test.
//!
//! ## Why a splitter exists at all
//!
//! The whole no-type-mapping design rests on the driver's **text** protocol, and
//! `sqlx::raw_sql` accepts multiple `;`-separated statements. That means we lose the free
//! backstop a prepared statement gave us ("the server refuses a second statement"). It is
//! replaced deliberately rather than left to the accident, so:
//!
//! * [`split_statements`] is how `db_query` knows whether the user asked for one statement or
//!   five, which is what makes `allowMultiStatement` a real control instead of a decoration.
//! * It is also how each [`crate::db::result::DbResultSet`] gets labelled with **the statement
//!   that produced it**. The driver's stream says "here is the end of a result set"; only the
//!   split text can say *which* statement that was.
//!
//! ## What it is NOT
//!
//! It is **not** a security boundary, and nothing in this feature treats it as one. Read-only
//! is enforced by the *server*, which is the only place it cannot be talked around by a
//! cleverer string. A splitter that is confidently wrong about one exotic quoting form would
//! be a vulnerability; a splitter that is wrong about it while the server refuses the write
//! anyway is a cosmetic bug. That ordering is the whole reason `SET SESSION CHARACTERISTICS AS
//! TRANSACTION READ ONLY` is issued as its own round trip at connect and never prepended to
//! user SQL — see [`crate::db::engine`].
//!
//! ## The lexical forms it does understand
//!
//! `-- line comments`, `/* nested /* block */ comments */`, `'single quoted'` with `''`
//! doubling, `E'escape\'strings'` with backslash escapes, `"quoted identifiers"` with `""`
//! doubling, and `$$dollar quoted$$` / `$tag$…$tag$` bodies. Those are the forms that actually
//! appear in a console, and every one of them can contain a `;` that is not a terminator.

use crate::db::engine::Limits;
use crate::db::error::DbError;
use crate::db::model::DbRunMode;

/// Split `text` into statements, dropping empty ones and trailing semicolons.
///
/// Whitespace and comments outside a statement are dropped; whitespace and comments *inside*
/// one are preserved verbatim, because the statement is echoed back to the user next to its
/// result and rewriting their SQL would be a small lie.
pub fn split_statements(text: &str) -> Vec<String> {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        let c = bytes[i];
        match c {
            // ── line comment ───────────────────────────────────────────────
            '-' if bytes.get(i + 1) == Some(&'-') => {
                i += 2;
                while i < bytes.len() && bytes[i] != '\n' {
                    i += 1;
                }
            }
            // ── block comment, nested (Postgres allows nesting) ────────────
            '/' if bytes.get(i + 1) == Some(&'*') => {
                let mut depth = 1usize;
                i += 2;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == '*' && bytes.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            // ── single-quoted literal, with `''` doubling and `E'…\'…'` escapes ──
            '\'' => {
                // `E'…'` / `e'…'` makes backslash an escape character.
                let escapes = i > 0 && matches!(bytes[i - 1], 'E' | 'e');
                i += 1;
                while i < bytes.len() {
                    if escapes && bytes[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == '\'' {
                        if bytes.get(i + 1) == Some(&'\'') {
                            i += 2; // an escaped quote, still inside the literal
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            // ── quoted identifier, with `""` doubling ──────────────────────
            '"' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == '"' {
                        if bytes.get(i + 1) == Some(&'"') {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            // ── dollar quoting: `$$…$$` or `$tag$…$tag$` ───────────────────
            '$' => match dollar_tag(&bytes, i) {
                Some(tag_len) => {
                    let tag: String = bytes[i..i + tag_len].iter().collect();
                    i += tag_len;
                    // Scan for the closing copy of the same tag.
                    let tag_chars: Vec<char> = tag.chars().collect();
                    while i < bytes.len() {
                        if bytes[i] == '$' && bytes[i..].starts_with(tag_chars.as_slice()) {
                            i += tag_chars.len();
                            break;
                        }
                        i += 1;
                    }
                }
                None => i += 1,
            },
            // ── the terminator ─────────────────────────────────────────────
            ';' => {
                push_trimmed(&mut out, &bytes[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    push_trimmed(&mut out, &bytes[start..]);
    out
}

/// The length of a dollar-quote opening tag at `i` (`$$` → 2, `$tag$` → 5), or `None` when
/// this `$` is not one (a `$1` placeholder, or a bare `$`).
fn dollar_tag(chars: &[char], i: usize) -> Option<usize> {
    debug_assert_eq!(chars[i], '$');
    let mut j = i + 1;
    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
        // A tag cannot start with a digit — that is `$1`, a placeholder.
        if j == i + 1 && chars[j].is_ascii_digit() {
            return None;
        }
        j += 1;
    }
    if chars.get(j) == Some(&'$') {
        Some(j - i + 1)
    } else {
        None
    }
}

/// Push `slice` onto `out` if it holds anything but whitespace and comments.
fn push_trimmed(out: &mut Vec<String>, slice: &[char]) {
    let s: String = slice.iter().collect();
    let trimmed = s.trim();
    if trimmed.is_empty() || is_only_comments(trimmed) {
        return;
    }
    out.push(trimmed.to_string());
}

/// True when `s` is nothing but comments and whitespace — a trailing `-- done` must not count
/// as a statement, or an ordinary script would look multi-statement and be refused.
fn is_only_comments(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            let mut depth = 1usize;
            i += 2;
            while i < chars.len() && depth > 0 {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else {
            return false;
        }
    }
    true
}

/// Whether `statement` is expected to return rows.
///
/// Needed because the simple-query protocol tells us "this result set ended" but not "this
/// result set had a shape": a `SELECT` matching zero rows and a `CREATE TABLE` are the same
/// event on the wire. So the *kind* of an empty result comes from the leading keyword — a
/// display decision only, never a permission one.
/// The multi-statement refusal, shared by every engine.
///
/// `None` means "go ahead". `Some(err)` is a `blocked` error whose sentence says which of the
/// two reasons applied — asking for one statement and finding several, or asking for a script on
/// a connection that has not opted in.
///
/// 🔴 **The sentences name the way out, and which way out depends on `limits`**.
/// The old Statement-mode message said *"Run it as a script to execute more
/// than one"* unconditionally — and the Script button is **disabled** whenever
/// `allow_multi_statement` is off (`DbConsole.tsx`), so on exactly the connection the default
/// creates, the advice pointed at a control the user cannot press. A refusal that names an
/// unreachable action is the same defect as one that names the wrong cause.
///
/// The buttons are named rather than their shortcuts: `⌘⏎` is `Ctrl+⏎` off macOS, and this string
/// is built in Rust where the platform is not the user's.
///
/// **Not a security boundary.** Read-only is, and it is the server's. This is what stops one
/// stray semicolon from sending a second statement the user never meant to run.
///
/// Extracted here when the MySQL engine landed: it was inline in the Postgres
/// session, and a second copy is how two engines end up disagreeing about when a script is
/// refused — with each engine's own tests passing.
pub fn multi_statement_refusal(
    statements: &[String],
    mode: DbRunMode,
    limits: &Limits,
) -> Option<DbError> {
    if statements.len() <= 1 {
        return None;
    }
    let n = statements.len();
    match mode {
        DbRunMode::Statement if limits.allow_multi_statement => Some(DbError::blocked(format!(
            "That is {n} statements, and Run sends one. Select just the statement you mean to \
             run, or use the Script button to run them all in order."
        ))),
        DbRunMode::Statement => Some(DbError::blocked(format!(
            "That is {n} statements, and Run sends one. Select just the statement you mean to \
             run — or tick \"Allow multiple statements\" in this connection's settings, which is \
             what enables the Script button."
        ))),
        DbRunMode::Script if !limits.allow_multi_statement => Some(DbError::blocked(format!(
            "This connection does not allow multiple statements, and that is {n} statements. \
             Tick \"Allow multiple statements\" in this connection's settings to run a script, or \
             select one statement and press Run."
        ))),
        DbRunMode::Script => None,
    }
}

/// Statements that would turn a read-only session back into a writable one.
///
/// 🔴 **This exists because "read-only is server-enforced" was measured to be overstated, on
/// BOTH engines** (against the fixtures):
///
/// ```text
/// run 1:  SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE   → SET
/// run 2:  INSERT INTO tracks …                                     → INSERT 0 1   ← it landed
/// ```
///
/// The session-level setting is a *default for subsequent transactions*, and the user's own SQL
/// can change it. Postgres happens to refuse the same pair inside ONE batch — a multi-statement
/// batch is a single implicit transaction whose access mode is already fixed — and MySQL does
/// not, but across two round trips on one session both engines allow it. Our console sends each
/// run on the same session, so that is a path a user can reach, not a theoretical one.
///
/// So this is the honest split, and both halves matter:
///
/// * The **server** setting is what stops every accidental write, which is what read-only is for.
/// * This filter is what stops the one-liner that undoes it. It is a **client-side speed bump**,
///   not a boundary: a determined user can spell a mode change in a way this does not recognise
///   (a stored procedure, a `DO` block, an obscure synonym), and if they do, the write succeeds.
/// * The only unconditional boundary is a **read-only account** — grants the server enforces
///   without reference to session state. `EngineSpec::server_enforced_read_only` and the UI badge
///   are worded against that reality rather than against the setting.
///
/// Returns `Some(err)` for the first offending statement, naming it, so the user can see which
/// line of a script was the problem.
pub fn read_only_escape(statements: &[String]) -> Option<DbError> {
    for statement in statements {
        if changes_transaction_access_mode(statement) {
            return Some(DbError::blocked(format!(
                "This connection is read-only, and that statement would change its access mode: \
                 {}. Untick \"Read-only\" in this connection's settings if you mean to write.",
                first_line(statement)
            )));
        }
    }
    None
}

/// The first line of a statement, trimmed and capped — for an error message that has to name
/// what it refused without pasting a 200-line script into a toast.
pub fn first_line(statement: &str) -> String {
    let line = statement.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() <= 80 {
        return line.to_string();
    }
    let head: String = line.chars().take(77).collect();
    format!("{head}…")
}

/// Does `statement` change the transaction access mode (or the setting that seeds it)?
///
/// Matched on a whitespace-normalised, upper-cased form so `set   session\n transaction  read
/// write` is caught as readily as the canonical spelling. Deliberately **broad**: a false
/// positive costs a read-only user one confusing refusal on a statement they can rewrite, while a
/// false negative silently re-enables writes on a connection whose badge says read-only.
fn changes_transaction_access_mode(statement: &str) -> bool {
    let normalised: String = {
        let mut out = String::with_capacity(statement.len());
        let mut last_was_space = false;
        for ch in statement.trim().chars() {
            if ch.is_whitespace() {
                if !last_was_space {
                    out.push(' ');
                }
                last_was_space = true;
            } else {
                out.extend(ch.to_uppercase());
                last_was_space = false;
            }
        }
        out
    };
    // `READ WRITE` in any of the SET/BEGIN/START forms. Checked as "mentions a mode change verb
    // AND asks for write", so the many equivalent spellings collapse into two conditions.
    let mode_verb = normalised.starts_with("SET ")
        || normalised.starts_with("BEGIN")
        || normalised.starts_with("START TRANSACTION");
    if mode_verb && normalised.contains("READ WRITE") {
        return true;
    }
    // The GUC/system-variable spellings, which do not contain "READ WRITE" at all:
    //   Postgres: SET default_transaction_read_only = off
    //   MySQL:    SET @@SESSION.TRANSACTION_READ_ONLY = 0   (and the older TX_READ_ONLY)
    if normalised.starts_with("SET ")
        && (normalised.contains("DEFAULT_TRANSACTION_READ_ONLY")
            || normalised.contains("TRANSACTION_READ_ONLY")
            || normalised.contains("TX_READ_ONLY"))
    {
        return true;
    }
    false
}

pub fn is_row_returning(statement: &str) -> bool {
    let first = leading_keyword(statement);
    matches!(
        first.as_str(),
        "select" | "with" | "values" | "table" | "show" | "explain" | "returning" | "call"
    )
}

/// The first SQL keyword of `statement`, lower-cased, with leading comments skipped.
fn leading_keyword(statement: &str) -> String {
    let chars: Vec<char> = statement.chars().collect();
    let mut i = 0;
    // Skip whitespace and leading comments.
    loop {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if chars.get(i) == Some(&'-') && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if chars.get(i) == Some(&'/') && chars.get(i + 1) == Some(&'*') {
            let mut depth = 1usize;
            i += 2;
            while i < chars.len() && depth > 0 {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        break;
    }
    let start = i;
    while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
        i += 1;
    }
    chars[start..i].iter().collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use crate::db::error::DbErrorCode;

    /* ─────────── multi_statement_refusal — the sentence the user actually reads ────────────── */

    fn limits(allow_multi_statement: bool) -> Limits {
        Limits {
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement,
        }
    }

    fn refusal(n: usize, mode: DbRunMode, allow: bool) -> Option<DbError> {
        let statements: Vec<String> = (0..n).map(|i| format!("SELECT {i}")).collect();
        multi_statement_refusal(&statements, mode, &limits(allow))
    }

    /// 🔴 **The multi-statement refusal bug**, at the layer that writes the words. Two statements
    /// were refused with a sentence naming both guards; this function had written the precise one
    /// and it never reached the screen. It is now a `blocked` error whose detail the panel renders
    /// (`DbError::blocked`), so what it says has to be right.
    ///
    /// The half worth a test of its own: **the way out depends on the connection.** The Script
    /// button is disabled unless `allowMultiStatement` is on, so the old unconditional *"run it as
    /// a script"* pointed at a dead control on precisely the connection our defaults create.
    #[test]
    fn a_multi_statement_refusal_names_a_control_the_user_can_actually_reach() {
        let opted_in = refusal(2, DbRunMode::Statement, true).expect("refused");
        assert_eq!(opted_in.code, DbErrorCode::Blocked);
        assert!(opted_in.message.contains("2 statements"), "{opted_in:?}");
        assert!(
            opted_in.message.contains("Script button"),
            "the button that CAN run them is the way out here: {}",
            opted_in.message
        );
        // …and it must not send someone to a settings dialog they have already ticked.
        assert!(
            !opted_in.message.contains("Allow multiple statements"),
            "advises a setting that is already on: {}",
            opted_in.message
        );

        let not_opted_in = refusal(2, DbRunMode::Statement, false).expect("refused");
        assert!(
            not_opted_in.message.contains("Allow multiple statements"),
            "the Script button is DISABLED here, so the setting is the only way out: {}",
            not_opted_in.message
        );
        // Both sentences must still name the alternative that needs no setting at all.
        for m in [&opted_in.message, &not_opted_in.message] {
            assert!(m.contains("Select just the statement"), "{m}");
        }
    }

    #[test]
    fn a_script_on_a_connection_that_did_not_opt_in_names_the_setting_and_counts_the_statements() {
        let err = refusal(3, DbRunMode::Script, false).expect("refused");
        assert_eq!(err.code, DbErrorCode::Blocked);
        assert!(err.message.contains("3 statements"), "{}", err.message);
        assert!(
            err.message.contains("Allow multiple statements"),
            "the refusal must name the setting that lifts it: {}",
            err.message
        );
    }

    /// The negative control. Without it every assertion above would pass on a guard
    /// that refuses *everything*, which is the failure mode that would make the console unusable.
    #[test]
    fn nothing_is_refused_when_the_run_is_within_the_rules() {
        for allow in [true, false] {
            assert!(refusal(1, DbRunMode::Statement, allow).is_none());
            assert!(refusal(1, DbRunMode::Script, allow).is_none());
            assert!(refusal(0, DbRunMode::Script, allow).is_none());
        }
        // The whole point of the setting: with it on, a script runs.
        assert!(refusal(5, DbRunMode::Script, true).is_none());
    }

    /// These strings are built in Rust, where the platform is not the user's. `⌘⏎` is `Ctrl+⏎` off
    /// macOS, so a shortcut baked in here would be wrong for two of the three platforms we ship —
    /// the buttons are named instead. (`DbConsole.tsx` renders the modifier it detects.)
    #[test]
    fn a_refusal_names_buttons_rather_than_a_keystroke_that_is_wrong_off_macos() {
        for mode in [DbRunMode::Statement, DbRunMode::Script] {
            for allow in [true, false] {
                let Some(err) = refusal(2, mode, allow) else {
                    continue;
                };
                for forbidden in ["⌘", "Ctrl", "⇧", "Cmd"] {
                    assert!(
                        !err.message.contains(forbidden),
                        "{forbidden:?} in a platform-agnostic message: {}",
                        err.message
                    );
                }
            }
        }
    }

    /* ───────────── read_only_escape — the guardrail's own guardrail ───────────── */

    /// Every known spelling of "make this session writable again". Broad on purpose: a
    /// false positive costs one confusing refusal, a false negative silently re-enables writes
    /// on a connection whose badge says read-only.
    #[test]
    fn an_access_mode_change_is_refused_in_all_its_spellings() {
        for sql in [
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "set session characteristics as transaction read write",
            "SET SESSION TRANSACTION READ WRITE",
            "SET TRANSACTION READ WRITE",
            "START TRANSACTION READ WRITE",
            "BEGIN READ WRITE",
            // Whitespace-normalised, so a formatted script is caught too.
            "SET   SESSION\n  TRANSACTION   READ  WRITE",
            // The variable spellings, which never contain the words "READ WRITE".
            "SET default_transaction_read_only = off",
            "SET SESSION default_transaction_read_only TO false",
            "SET @@SESSION.transaction_read_only = 0",
            "SET @@session.tx_read_only = 0",
        ] {
            let err = read_only_escape(&[sql.to_string()])
                .unwrap_or_else(|| panic!("not refused: {sql}"));
            assert_eq!(err.code, DbErrorCode::Blocked);
        }
    }

    #[test]
    fn ordinary_statements_are_not_refused() {
        // The false-positive half. A read-only console must stay usable — in particular, going
        // MORE restrictive is fine, and so is any statement that merely mentions the words.
        for sql in [
            "SELECT 1",
            "SELECT * FROM tracks WHERE tag = 'read write'",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
            "SET SESSION TRANSACTION READ ONLY",
            "START TRANSACTION READ ONLY",
            "SET statement_timeout = 1000",
            "SET search_path TO public",
            // `read_write` as an identifier, not a mode.
            "SELECT read_write FROM flags",
        ] {
            assert!(
                read_only_escape(&[sql.to_string()]).is_none(),
                "wrongly refused: {sql}"
            );
        }
    }

    #[test]
    fn a_script_is_refused_for_its_offending_statement_and_names_it() {
        // The realistic shape: an innocuous statement, then the escape, then the write. The
        // message has to name the line that was refused, or the user cannot find it in a script.
        let err = read_only_escape(&[
            "SELECT 1".to_string(),
            "SET SESSION TRANSACTION READ WRITE".to_string(),
            "INSERT INTO tracks (id) VALUES (1)".to_string(),
        ])
        .expect("refused");
        assert!(
            err.message.contains("SET SESSION TRANSACTION READ WRITE"),
            "the refusal does not name the statement: {}",
            err.message
        );
        // …and it names the control that lifts it, by the label the dialog actually shows
        // (`ConnectionDialog.tsx`: a checkbox labelled "Read-only"). This message is rendered to
        // the user now, so "turn read-only off" — a thing, not a control — is not enough.
        assert!(
            err.message.contains("Untick \"Read-only\""),
            "the refusal does not say how to proceed: {}",
            err.message
        );
    }

    #[test]
    fn a_long_offending_statement_is_truncated_rather_than_pasted_whole() {
        // An error that pastes a 200-line script into a toast is unreadable; the first line,
        // capped, is what identifies it.
        let long = format!("SET SESSION TRANSACTION READ WRITE {}", "x".repeat(400));
        let err = read_only_escape(&[long]).expect("refused");
        assert!(err.message.contains('…'), "not truncated: {}", err.message);
        assert!(
            err.message.len() < 300,
            "message is {} chars long",
            err.message.len()
        );
    }

    #[test]
    fn nothing_is_refused_when_there_is_nothing_to_refuse() {
        assert!(read_only_escape(&[]).is_none());
    }

    use super::*;

    #[test]
    fn a_single_statement_with_or_without_a_semicolon_is_one_statement() {
        assert_eq!(split_statements("SELECT 1"), vec!["SELECT 1"]);
        assert_eq!(split_statements("SELECT 1;"), vec!["SELECT 1"]);
        assert_eq!(split_statements("  SELECT 1 ;  \n"), vec!["SELECT 1"]);
    }

    #[test]
    fn empty_input_is_no_statements_rather_than_one_empty_one() {
        assert!(split_statements("").is_empty());
        assert!(split_statements("   \n\t ").is_empty());
        assert!(split_statements(";;;").is_empty());
    }

    #[test]
    fn a_semicolon_inside_a_string_literal_is_not_a_terminator() {
        // The classic way a naive splitter turns one statement into two and then refuses it
        // as "multi-statement" — or worse, runs half of it.
        assert_eq!(
            split_statements("SELECT 'a;b' AS x"),
            vec!["SELECT 'a;b' AS x"]
        );
        assert_eq!(
            split_statements("SELECT 'it''s; fine'"),
            vec!["SELECT 'it''s; fine'"]
        );
        assert_eq!(
            split_statements(r"SELECT E'a\';b'"),
            vec![r"SELECT E'a\';b'"]
        );
    }

    #[test]
    fn a_semicolon_inside_a_quoted_identifier_or_dollar_quote_is_not_a_terminator() {
        assert_eq!(
            split_statements(r#"SELECT 1 AS "a;b""#),
            vec![r#"SELECT 1 AS "a;b""#]
        );
        assert_eq!(split_statements("SELECT $$a;b$$"), vec!["SELECT $$a;b$$"]);
        assert_eq!(
            split_statements("SELECT $tag$a;b$tag$"),
            vec!["SELECT $tag$a;b$tag$"]
        );
        // A function body — the realistic reason dollar quoting matters at all.
        let body = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql";
        assert_eq!(split_statements(body), vec![body]);
    }

    #[test]
    fn a_semicolon_inside_a_comment_is_not_a_terminator() {
        assert_eq!(
            split_statements("SELECT 1 -- ; not a terminator\n"),
            vec!["SELECT 1 -- ; not a terminator"]
        );
        assert_eq!(
            split_statements("SELECT /* ; /* nested ; */ still in */ 1"),
            vec!["SELECT /* ; /* nested ; */ still in */ 1"]
        );
    }

    #[test]
    fn a_trailing_comment_is_not_a_second_statement() {
        // Otherwise an ordinary annotated script would be refused as multi-statement.
        assert_eq!(split_statements("SELECT 1; -- done\n"), vec!["SELECT 1"]);
        assert_eq!(split_statements("-- nothing here\n").len(), 0);
    }

    #[test]
    fn a_real_multi_statement_script_splits_into_its_parts() {
        let script = "SELECT 1;\nINSERT INTO t VALUES (1);\nUPDATE t SET a = 'x;y'";
        assert_eq!(
            split_statements(script),
            vec![
                "SELECT 1",
                "INSERT INTO t VALUES (1)",
                "UPDATE t SET a = 'x;y'"
            ]
        );
    }

    #[test]
    fn a_dollar_placeholder_is_not_a_dollar_quote() {
        // `$1` must not swallow the rest of the script looking for a closing `$1$`.
        assert_eq!(
            split_statements("SELECT $1; SELECT 2"),
            vec!["SELECT $1", "SELECT 2"]
        );
    }

    #[test]
    fn the_row_returning_test_reads_the_leading_keyword_and_not_the_values() {
        for s in [
            "SELECT 1",
            "  select 1",
            "-- a comment\nSELECT 1",
            "/* c */ WITH x AS (SELECT 1) SELECT * FROM x",
            "VALUES (1)",
            "EXPLAIN SELECT 1",
            "SHOW search_path",
        ] {
            assert!(is_row_returning(s), "{s}");
        }
        for s in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "CREATE TABLE t (a int)",
            "SET statement_timeout = 1000",
            // The value says SELECT; the statement is not a select. The kind must come from
            // the statement, exactly as a cell's kind comes from its column.
            "INSERT INTO t VALUES ('SELECT 1')",
        ] {
            assert!(!is_row_returning(s), "{s}");
        }
    }

    #[test]
    fn an_unterminated_literal_does_not_hang_or_panic() {
        // A half-typed console line. It must come back as one statement, not loop forever.
        assert_eq!(split_statements("SELECT 'abc"), vec!["SELECT 'abc"]);
        assert_eq!(split_statements("SELECT $$abc"), vec!["SELECT $$abc"]);
        assert_eq!(split_statements("SELECT /* abc"), vec!["SELECT /* abc"]);
        assert_eq!(split_statements(r#"SELECT "abc"#), vec![r#"SELECT "abc"#]);
    }

    #[test]
    fn unicode_does_not_shift_the_split() {
        // Char-indexed, not byte-indexed: a multi-byte character before a `;` used to be the
        // classic panic here.
        assert_eq!(
            split_statements("SELECT 'ünïcode ✓ 中文'; SELECT 2"),
            vec!["SELECT 'ünïcode ✓ 中文'", "SELECT 2"]
        );
    }
}
