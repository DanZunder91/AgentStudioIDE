//! The level heuristic — a **filter, not a verdict**.
//!
//! Terminal output carries no level. We guess one from the text so the Agent Logs view
//! can offer error/warn/info/debug chips, and the UI says it is a guess.
//!
//! One refinement over a bare keyword match, deliberate: an **os_log compact row**
//! (`log stream --style compact`, which is what `xcrun simctl … log stream` prints)
//! carries its level in a column of its own —
//!
//! ```text
//! 2026-01-01 12:00:00.250 E  Demo[1234:5678] …    ← Error
//! 2026-01-01 12:00:00.250 Df Demo[1234:5678] …    ← Default (debug here)
//! ```
//!
//! — and when that column is present it is the process's **own** declaration, so it
//! wins over a keyword in the message. A `Df` row whose message mentions "error" is a
//! chatty debug line about an error, not an error; letting the keyword win would paint
//! half of a simulator log red and teach the user to ignore red.
//!
//! The same precedence applies to a **structured-logger level column** (a background
//! service Claude started, e.g. `gazelle`):
//!
//! ```text
//! 2026-01-01T12:00:05.152Z  INFO gazelle: listening on 0.0.0.0:8080     ← tracing
//! [2026-01-01T12:00:05Z WARN  gazelle::db] pool nearly exhausted        ← env_logger
//! time=… level=error msg="upstream failed"                              ← logfmt
//! {"level":"debug","msg":"…"}                                           ← JSON loggers
//! INFO gazelle: started                                                 ← tracing, no time
//! ```
//!
//! An `INFO` row whose message says "error" is the service telling us it handled one.

use std::sync::LazyLock;

use regex::Regex;

use super::LogLevel;

/// `YYYY-MM-DD HH:MM:SS.fff[+zzzz] <TYPE> ` — the os_log compact prefix. The type
/// column is 1–2 letters: `E` error, `F`/`Fa` fault, `Df` default, `Db`/`D` debug,
/// `I` info, `A` activity.
static OS_LOG_COMPACT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,9}(?:[+-]\d{4})?\s+(E|Fa|F|Df|Db|D|I|A)\s",
    )
    .expect("os_log regex")
});

/// The level tokens a structured logger prints in its level column, uppercase (tracing,
/// env_logger, log4rs, slog, zerolog's three-letter forms, Python's `CRITICAL`).
const LEVEL_TOKENS: &str =
    "ERROR|ERRO|ERR|FATAL|CRITICAL|CRIT|PANIC|WARNING|WARN|WRN|INFO|INF|NOTICE|DEBUG|DBG|TRACE|TRC";

/// A timestamp (ISO date + time, optional fraction and zone, optionally in `[`), then the
/// level token as its own whitespace-separated column.
static TIMESTAMP_LEVEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^\s*\[?\d{{4}}-\d{{2}}-\d{{2}}[T ]\d{{2}}:\d{{2}}:\d{{2}}(?:[.,]\d{{1,9}})?(?:Z|[+-]\d{{2}}:?\d{{2}})?\]?\s+\[?({LEVEL_TOKENS})\]?(?:\s|$)"
    ))
    .expect("timestamp-level regex")
});

/// The level token first on the line (tracing without a timer, `INFO:` prefixes).
static LEADING_LEVEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^\s*\[?({LEVEL_TOKENS})\]?(?:[\s:]|$)")).expect("leading-level regex")
});

/// `level=error` (logfmt) / `"level":"error"` (JSON), any case.
static KEYED_LEVEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?:\blevel=|"level"\s*:\s*)"?(error|err|fatal|critical|crit|panic|warning|warn|info|notice|debug|trace)\b"#,
    )
    .expect("keyed-level regex")
});

fn level_of_token(token: &str) -> LogLevel {
    match token.to_ascii_uppercase().as_str() {
        "ERROR" | "ERRO" | "ERR" | "FATAL" | "CRITICAL" | "CRIT" | "PANIC" => LogLevel::Error,
        "WARNING" | "WARN" | "WRN" => LogLevel::Warn,
        "DEBUG" | "DBG" | "TRACE" | "TRC" => LogLevel::Debug,
        _ => LogLevel::Info, // INFO, INF, NOTICE
    }
}

/// The level a structured logger declared in a column of its own, if the line has one.
fn declared_level(line: &str) -> Option<LogLevel> {
    [&*TIMESTAMP_LEVEL, &*LEADING_LEVEL, &*KEYED_LEVEL]
        .iter()
        .find_map(|re| re.captures(line))
        .map(|c| level_of_token(&c[1]))
}

static ERROR_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(error|ERROR|Error|fatal|FATAL|Fatal|panic|panicked|PANIC|Traceback|FAILED)\b")
        .expect("error regex")
});

static WARN_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(warn|WARN|Warn|warning|Warning|WARNING|deprecated|Deprecated|DEPRECATED)\b")
        .expect("warn regex")
});

static DEBUG_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(DEBUG|TRACE)\b").expect("debug regex"));

/// Guess a level for one ANSI-stripped output line. Pure; table-tested below.
pub fn classify_level(line: &str) -> LogLevel {
    if let Some(caps) = OS_LOG_COMPACT.captures(line) {
        return match &caps[1] {
            "E" | "F" | "Fa" => LogLevel::Error,
            "Df" | "Db" | "D" => LogLevel::Debug,
            _ => LogLevel::Info, // I, A
        };
    }
    if let Some(level) = declared_level(line) {
        return level;
    }
    // `✗` is not a word character, so `\b` cannot anchor it — checked on its own.
    if ERROR_WORDS.is_match(line) || line.contains('✗') {
        return LogLevel::Error;
    }
    if WARN_WORDS.is_match(line) {
        return LogLevel::Warn;
    }
    if DEBUG_WORDS.is_match(line) {
        return LogLevel::Debug;
    }
    LogLevel::Info
}

#[cfg(test)]
mod tests {
    use super::*;
    use LogLevel::*;

    /// The expected levels are written out literally, never derived from the regexes
    /// under test.
    #[test]
    fn the_level_table() {
        let table: &[(&str, LogLevel)] = &[
            // os_log compact — a real simulator stream.
            (
                "2026-01-01 12:00:00.250 E  Demo[1234:5678] [com.app:net] request failed",
                Error,
            ),
            (
                "2026-01-01 12:00:00.250 Df Demo[1234:5678] [com.app:ui] layout pass",
                Debug,
            ),
            // The column wins over a keyword in the message, in both directions.
            (
                "2026-01-01 12:00:00.250 Df Demo[1234:5678] retrying after error",
                Debug,
            ),
            ("2026-01-01 12:00:00.250 I  Demo[1234:5678] all good", Info),
            ("2026-01-01 12:00:00.250 F  Demo[1234:5678] fault", Error),
            ("2026-01-01 12:00:00.250 Db Demo[1234:5678] noise", Debug),
            (
                "2026-01-01 12:00:00.250-0700 E  Demo[1:2] tz offset form",
                Error,
            ),
            // Keyword heuristics.
            ("error[E0308]: mismatched types", Error),
            ("Error: ENOENT: no such file", Error),
            ("thread 'main' panicked at src/lib.rs:1:1", Error),
            ("Traceback (most recent call last):", Error),
            ("test result: FAILED. 1 passed; 2 failed", Error),
            ("✗ 3 tests failed", Error),
            ("FATAL: role does not exist", Error),
            ("warning: unused variable `x`", Warn),
            ("npm WARN deprecated left-pad@1.0.0", Warn),
            ("DeprecationWarning is not a whole word", Info),
            ("[DEBUG] connecting", Debug),
            ("TRACE hyper::proto", Debug),
            // Word boundaries: substrings must not trigger.
            ("errorless run, terrors none", Info),
            ("forewarned", Info),
            ("Compiling agentstudio v0.1.0", Info),
            ("", Info),
            // A line that merely looks like a timestamp is not an os_log row.
            ("2026-01-01 12:00:00 E no millis so not compact", Info),
        ];
        for (line, want) in table {
            assert_eq!(classify_level(line), *want, "line: {line:?}");
        }
    }

    /// Structured-logger level columns: the service's own declaration wins
    /// over a keyword in its message. Expectations written by hand, per line.
    #[test]
    fn the_structured_level_column_table() {
        let table: &[(&str, LogLevel)] = &[
            // tracing-subscriber's default fmt (ANSI already stripped), two-space padding.
            (
                "2026-01-01T12:00:05.152Z  INFO gazelle: listening on 0.0.0.0:8080",
                Info,
            ),
            // The column wins: an INFO row that mentions an error is not an error…
            (
                "2026-01-01T12:00:05.152Z  INFO gazelle::retry: recovered from error after 2 attempts",
                Info,
            ),
            // …and a WARN row that says nothing alarming is still a warning.
            (
                "2026-01-01T12:00:05.152345Z  WARN gazelle::db: pool at 90%",
                Warn,
            ),
            (
                "2026-01-01T12:00:05.152Z ERROR gazelle: upstream closed the connection",
                Error,
            ),
            (
                "2026-01-01T12:00:05.152Z DEBUG hyper::proto::h1: flushed 212 bytes",
                Debug,
            ),
            (
                "2026-01-01T12:00:05.152Z TRACE gazelle: tick, no error",
                Debug,
            ),
            // env_logger / log4rs bracket forms.
            ("[2026-01-01 12:00:05 WARN foo] disk slow", Warn),
            ("[2026-01-01T12:00:05Z INFO  gazelle] fatal flag is off", Info),
            ("[2026-01-01T12:00:05Z ERROR gazelle::api] 500 on /health", Error),
            // A zone offset and a comma fraction (Python logging's asctime).
            (
                "2026-01-01 12:00:05,152 WARNING root: low memory",
                Warn,
            ),
            ("2026-01-01T12:00:05-05:00 INFO svc: tick 1", Info),
            // No timer: the token leads the line.
            ("INFO gazelle: started, error budget 0", Info),
            ("WARN gazelle: slow query", Warn),
            ("ERROR: relation \"users\" does not exist", Error),
            ("INF server started port=8080", Info),
            ("WRN retrying", Warn),
            // logfmt / JSON keyed levels, any case.
            ("time=2026-01-01T12:00:05Z level=error msg=\"db down\"", Error),
            ("ts=1 level=info msg=\"error count reset\"", Info),
            ("level=WARN msg=x", Warn),
            (r#"{"level":"debug","msg":"panic handler installed"}"#, Debug),
            (r#"{"ts":1,"level": "error","msg":"boom"}"#, Error),
            // Not columns: a word that merely starts with a token, or a token mid-line.
            ("INFORMATION about the build", Info),
            ("ERRORS: 0", Info),
            ("the INFO panel shows an error", Error),
            ("releveled=error", Error),
        ];
        for (line, want) in table {
            assert_eq!(classify_level(line), *want, "line: {line:?}");
        }
    }
}
