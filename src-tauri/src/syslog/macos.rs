//! macOS unified log: filter → `log stream` argv, and ndjson line → [`LineDraft`].
//! Pure and compiled on every OS (tested on Linux too); nothing here spawns anything.

use serde_json::Value;

use super::{SyslogFilter, SyslogLevel};
use crate::logstream::{cap_text, LineDraft, LogKind, LogLevel};

pub const LOG_BIN: &str = "/usr/bin/log";
pub const XCRUN_BIN: &str = "/usr/bin/xcrun";
/// Contract: `text` ≤ 4 KiB.
pub const MAX_TEXT: usize = 4 * 1024;
pub const MAX_DETAIL: usize = crate::logstream::MAX_DETAIL_BYTES;

/// A predicate string literal: `"` and `\` escaped. The result travels as ONE argv
/// element — there is no shell — so this guards the predicate grammar, not a shell.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// The `--predicate` for a set of process names, a subsystem prefix and a level floor.
/// `None` when nothing narrows the stream. Clauses are ANDed; names are ORed.
pub fn predicate(
    apps: Option<&[String]>,
    subsystem: Option<&str>,
    min: SyslogLevel,
) -> Option<String> {
    let mut clauses: Vec<String> = Vec::new();
    if let Some(apps) = apps.filter(|a| !a.is_empty()) {
        let ors: Vec<String> = apps
            .iter()
            .map(|a| format!("process == {}", quote(a)))
            .collect();
        clauses.push(if ors.len() == 1 {
            ors.into_iter().next().unwrap_or_default()
        } else {
            format!("({})", ors.join(" OR "))
        });
    }
    if let Some(s) = subsystem.filter(|s| !s.is_empty()) {
        clauses.push(format!("subsystem BEGINSWITH {}", quote(s)));
    }
    if min == SyslogLevel::Error {
        clauses.push(r#"(logType == "error" OR logType == "fault")"#.to_string());
    }
    if clauses.is_empty() {
        None
    } else {
        Some(clauses.join(" AND "))
    }
}

/// `log stream`'s own `--level` (it has no "error" level — that is a predicate clause).
fn level_args(min: SyslogLevel) -> Vec<String> {
    match min {
        SyslogLevel::Debug => vec!["--level".into(), "debug".into()],
        SyslogLevel::Info => vec!["--level".into(), "info".into()],
        SyslogLevel::Default | SyslogLevel::Error => vec![],
    }
}

fn stream_args(apps: Option<&[String]>, f: &SyslogFilter) -> Vec<String> {
    let mut a: Vec<String> = vec!["stream".into(), "--style".into(), "ndjson".into()];
    a.extend(level_args(f.min_level));
    if let Some(p) = predicate(apps, f.subsystem.as_deref(), f.min_level) {
        a.push("--predicate".into());
        a.push(p);
    }
    a
}

/// Args for `/usr/bin/log`.
pub fn log_args(f: &SyslogFilter) -> Vec<String> {
    stream_args(f.apps.as_deref(), f)
}

/// Args for `/usr/bin/xcrun` — `simctl spawn booted log stream …`. Only ever run after
/// the user enables the simulator source (even a read-only-looking `simctl` call can
/// install simulator components, so it is never used as a probe).
pub fn sim_args(f: &SyslogFilter) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "simctl".into(),
        "spawn".into(),
        "booted".into(),
        "log".into(),
    ];
    a.extend(stream_args(f.simulator_apps.as_deref(), f));
    a
}

/// os_log `messageType` → level: Error/Fault → error, Debug → debug,
/// Info/Default (and anything unknown) → info.
pub fn level_of(message_type: &str) -> LogLevel {
    match message_type {
        "Error" | "Fault" => LogLevel::Error,
        "Debug" => LogLevel::Debug,
        _ => LogLevel::Info,
    }
}

/// `2025-12-31 21:00:00.250500-0500` → unix ms.
pub fn parse_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_once(' ')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: u32 = d.next()?.parse().ok()?;
    let da: u32 = d.next()?.parse().ok()?;
    let split = rest.find(['+', '-']);
    let (time, off) = match split {
        Some(i) => (&rest[..i], Some(&rest[i..])),
        None => (rest, None),
    };
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let se: i64 = t.next()?.parse().ok()?;
    let ms: i64 = if frac.is_empty() {
        0
    } else {
        let f3: String = frac.chars().chain("000".chars()).take(3).collect();
        f3.parse().ok()?
    };
    let off_s: i64 = match off {
        None => 0,
        Some(o) if o.len() == 5 => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            let oh: i64 = o[1..3].parse().ok()?;
            let om: i64 = o[3..5].parse().ok()?;
            sign * (oh * 3600 + om * 60)
        }
        Some(_) => return None,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let days = days_from_civil(y, mo, da);
    Some(((days * 86_400 + h * 3600 + mi * 60 + se - off_s) * 1000) + ms)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// One `log stream --style ndjson` line → a `machine` [`LineDraft`]. `None` for the
/// non-JSON header, non-log events, and garbage. `simulator` prefixes the source with
/// `Simulator · `.
pub fn parse_ndjson(line: &str, simulator: bool) -> Option<LineDraft> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let event_type = v
        .get("eventType")
        .and_then(Value::as_str)
        .unwrap_or("logEvent");
    if event_type != "logEvent" {
        return None; // activity/signpost/state events are not log lines
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    let message = s("eventMessage");
    let image = s("processImagePath");
    let process = if image.is_empty() {
        "unknown"
    } else {
        basename(image)
    };
    let subsystem = s("subsystem");
    let category = s("category");
    let pid = v.get("processID").and_then(Value::as_i64);

    let mut lines = message.lines();
    let first = lines.next().unwrap_or("");
    let multiline = lines.next().is_some();
    let text = match (subsystem.is_empty(), category.is_empty()) {
        (true, true) => first.to_string(),
        (false, true) => format!("[{subsystem}] {first}"),
        (true, false) => format!("[{category}] {first}"),
        (false, false) => format!("[{subsystem}:{category}] {first}"),
    };
    let mut detail = String::new();
    if !image.is_empty() {
        detail.push_str(image);
    }
    if let Some(pid) = pid {
        if !detail.is_empty() {
            detail.push_str(" · ");
        }
        detail.push_str(&format!("pid {pid}"));
    }
    if !subsystem.is_empty() {
        detail.push_str(&format!(" · {subsystem}"));
        if !category.is_empty() {
            detail.push_str(&format!(":{category}"));
        }
    }
    if multiline {
        detail.push('\n');
        detail.push_str(message);
    }
    let source = if simulator {
        format!("Simulator · {process}")
    } else {
        process.to_string()
    };
    Some(LineDraft {
        terminal_id: None,
        agent_id: None,
        source,
        kind: LogKind::Machine,
        level: level_of(s("messageType")),
        text: cap_text(&text, MAX_TEXT),
        detail: if detail.is_empty() {
            None
        } else {
            Some(cap_text(&detail, MAX_DETAIL))
        },
        ts_ms: parse_timestamp(s("timestamp")),
        tool_use_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn quote_escapes_quotes_and_backslashes() {
        let cases = [
            ("Safari", r#""Safari""#),
            (r#"a"b"#, r#""a\"b""#),
            (r"a\b", r#""a\\b""#),
            (r#"\""#, r#""\\\"""#),
            // A would-be injection stays inside the literal.
            (r#"x" OR process != "y"#, r#""x\" OR process != \"y""#),
            ("Café 日本", r#""Café 日本""#),
        ];
        for (input, want) in cases {
            assert_eq!(quote(input), want, "{input:?}");
        }
    }

    #[test]
    fn predicate_table() {
        let d = SyslogLevel::Default;
        assert_eq!(predicate(None, None, d), None, "all apps, no floor");
        assert_eq!(predicate(Some(&[]), None, d), None);
        assert_eq!(
            predicate(Some(&apps(&["Safari"])), None, d).as_deref(),
            Some(r#"process == "Safari""#)
        );
        assert_eq!(
            predicate(Some(&apps(&["Safari", "Mail"])), None, d).as_deref(),
            Some(r#"(process == "Safari" OR process == "Mail")"#)
        );
        assert_eq!(
            predicate(None, Some("com.example.demo"), d).as_deref(),
            Some(r#"subsystem BEGINSWITH "com.example.demo""#)
        );
        assert_eq!(
            predicate(Some(&apps(&["A", "B"])), Some("com.x"), SyslogLevel::Error).as_deref(),
            Some(concat!(
                r#"(process == "A" OR process == "B") AND subsystem BEGINSWITH "com.x""#,
                r#" AND (logType == "error" OR logType == "fault")"#
            ))
        );
        assert_eq!(
            predicate(Some(&apps(&[r#"ev"il"#])), None, d).as_deref(),
            Some(r#"process == "ev\"il""#)
        );
    }

    #[test]
    fn log_args_are_one_element_per_argument() {
        let f = SyslogFilter {
            enabled: true,
            apps: Some(apps(&["My App", r#"q"uote"#])),
            min_level: SyslogLevel::Info,
            ..Default::default()
        };
        assert_eq!(
            log_args(&f),
            vec![
                "stream",
                "--style",
                "ndjson",
                "--level",
                "info",
                "--predicate",
                r#"(process == "My App" OR process == "q\"uote")"#,
            ]
        );
        let all = SyslogFilter::default();
        assert_eq!(log_args(&all), vec!["stream", "--style", "ndjson"]);
        let dbg = SyslogFilter {
            min_level: SyslogLevel::Debug,
            ..Default::default()
        };
        assert_eq!(
            log_args(&dbg),
            vec!["stream", "--style", "ndjson", "--level", "debug"]
        );
    }

    #[test]
    fn sim_args_use_the_simulator_app_list_not_the_mac_one() {
        let f = SyslogFilter {
            apps: Some(apps(&["Safari"])),
            simulator: true,
            simulator_apps: Some(apps(&["Demo"])),
            ..Default::default()
        };
        assert_eq!(
            sim_args(&f),
            vec![
                "simctl",
                "spawn",
                "booted",
                "log",
                "stream",
                "--style",
                "ndjson",
                "--predicate",
                r#"process == "Demo""#,
            ]
        );
    }

    #[test]
    fn level_mapping_table() {
        for (t, want) in [
            ("Error", LogLevel::Error),
            ("Fault", LogLevel::Error),
            ("Debug", LogLevel::Debug),
            ("Info", LogLevel::Info),
            ("Default", LogLevel::Info),
            ("", LogLevel::Info),
            ("Something", LogLevel::Info),
        ] {
            assert_eq!(level_of(t), want, "{t:?}");
        }
    }

    #[test]
    fn timestamps_honour_the_offset() {
        // 2026-01-01 02:00:00.250 UTC
        let utc = parse_timestamp("2026-01-01 02:00:00.250000+0000").unwrap();
        assert_eq!(utc, 1_767_232_800_250);
        // A negative offset that crosses the day (and year) boundary; µs truncate to ms.
        assert_eq!(
            parse_timestamp("2025-12-31 21:00:00.250500-0500"),
            Some(utc)
        );
        assert_eq!(parse_timestamp("2026-01-01 07:30:00.250+0530"), Some(utc));
        assert_eq!(parse_timestamp("1970-01-01 00:00:00.000+0000"), Some(0));
        assert_eq!(parse_timestamp("garbage"), None);
        assert_eq!(parse_timestamp(""), None);
        assert_eq!(parse_timestamp("2026-13-01 00:00:00.0+0000"), None);
    }
}
