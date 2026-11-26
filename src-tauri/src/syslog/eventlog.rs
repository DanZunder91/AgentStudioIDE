//! Windows Event Log logic (query XML, event fields, levels, providers), pure and tested on
//! every OS; only `winevt.rs` calls the API. `apps` = provider names (an event's pid is often a
//! shared host). Names pass [`xpath_literal`]/[`xml_escape`], so none can break a query.

use std::collections::BTreeSet;

use super::procs::{sort_apps, RunningApp};
use super::{Backend, BackendKind, SyslogFilter, SyslogLevel};
use crate::logstream::{cap_text, LineDraft, LogKind, LogLevel};

/// `SyslogStatus.backend` on Windows.
pub const BACKEND_NAME: &str = "windows-eventlog";
/// The channels every subscription reads. Standard users can read both; `Security` needs
/// administrator rights and is never read by default.
pub const CHANNELS: [&str; 2] = ["Application", "System"];
/// What an Event Log stream says when it is asked for off Windows (only an injected
/// backend can ask — `detect_backend` never builds this one elsewhere).
pub const OFF_WINDOWS: &str = "The Windows Event Log is only available on Windows.";
/// Providers under this prefix are Windows' own; every other one is listed first.
pub const MICROSOFT_PREFIX: &str = "Microsoft-Windows-";
/// `source` when an event names no provider.
pub const NO_PROVIDER: &str = "Event Log";
/// The text of an event that has neither a message nor any EventData.
pub const NO_MESSAGE: &str = "(no message)";
/// `syslog_apps`: how far back the "recently wrote" scan reaches…
pub const RECENT_MAX_AGE_MS: u64 = 7 * 24 * 3600 * 1000;
/// …and how many of the newest events per channel it reads at most.
pub const RECENT_MAX_EVENTS: usize = 2_000;

/// The backend `detect_backend` builds on Windows. Platform-neutral so the contract golden
/// and the plan tests build it on every OS.
pub fn backend() -> Backend {
    Backend {
        available: true,
        name: Some(BACKEND_NAME),
        reason: None,
        program: None,
        kind: BackendKind::WindowsEventLog,
    }
}

/// Event Log `Level` → [`LogLevel`]: 1 Critical / 2 Error → error,
/// 3 Warning → warn, 4 Information and 0 LogAlways → info, 5 Verbose (and the
/// provider-defined levels above it) → debug.
pub fn level_of(level: u8) -> LogLevel {
    match level {
        1 | 2 => LogLevel::Error,
        3 => LogLevel::Warn,
        0 | 4 => LogLevel::Info,
        _ => LogLevel::Debug,
    }
}

/// The XPath `Level` clause keeping what [`level_of`] maps at or above `min`; `None` = all.
/// `default` keeps Information (0–4) like `info`: Windows has nothing between it and Warning,
/// and hiding it makes a quiet machine look dead. `error` = 1–2 (LogAlways maps to info).
pub fn level_clause(min: SyslogLevel) -> Option<&'static str> {
    match min {
        SyslogLevel::Debug => None,
        SyslogLevel::Info | SyslogLevel::Default => {
            Some("(Level=0 or Level=1 or Level=2 or Level=3 or Level=4)")
        }
        SyslogLevel::Error => Some("(Level=1 or Level=2)"),
    }
}

/// A character XML 1.0 can carry in a document — and nothing a real provider or channel name
/// holds is below a space. Control characters cannot even be written as `&#n;` references.
fn xml_carries(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c >= ' ' && c != '\u{FFFE}' && c != '\u{FFFF}')
}

/// `&`, `<`, `>`, `"` and `'` as entities — safe in element text and in either kind of
/// attribute quote.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// An XPath 1.0 literal, `'…'` or `"…"`. `None` when `s` holds both quotes (no escape, no
/// `concat()` in the Event Log subset) or a char XML can't carry: dropping beats a widened query.
pub fn xpath_literal(s: &str) -> Option<String> {
    if !xml_carries(s) {
        return None;
    }
    match (s.contains('\''), s.contains('"')) {
        (false, _) => Some(format!("'{s}'")),
        (true, false) => Some(format!("\"{s}\"")),
        (true, true) => None,
    }
}

/// The XPath one `<Select>` applies (before XML escaping). `Some("*")` when nothing narrows;
/// `None` when the selected providers are none, or none of them can be written as a literal —
/// "nothing to stream", never "everything" (which is what dropping the clause would mean).
pub fn xpath(apps: Option<&[String]>, min: SyslogLevel) -> Option<String> {
    let mut clauses: Vec<String> = Vec::new();
    if let Some(level) = level_clause(min) {
        clauses.push(level.to_string());
    }
    if let Some(apps) = apps {
        let ors: Vec<String> = apps
            .iter()
            .filter_map(|a| xpath_literal(a))
            .map(|lit| format!("@Name={lit}"))
            .collect();
        if ors.is_empty() {
            return None;
        }
        clauses.push(format!("Provider[{}]", ors.join(" or ")));
    }
    if clauses.is_empty() {
        Some("*".to_string())
    } else {
        Some(format!("*[System[{}]]", clauses.join(" and ")))
    }
}

/// `Application`, `System`, then the extra channel — unless it repeats one of them (channel
/// names are case-insensitive) or XML cannot carry it.
pub fn channels(extra: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = CHANNELS.iter().map(|c| c.to_string()).collect();
    if let Some(x) = extra.map(str::trim).filter(|x| xml_carries(x)) {
        if !out.iter().any(|c| c.eq_ignore_ascii_case(x)) {
            out.push(x.to_string());
        }
    }
    out
}

fn query_of(channels: &[String], xpath: &str) -> String {
    let body = xml_escape(xpath);
    let mut q = String::from("<QueryList><Query Id=\"0\">");
    for c in channels {
        q.push_str(&format!(
            "<Select Path=\"{}\">{body}</Select>",
            xml_escape(c)
        ));
    }
    q.push_str("</Query></QueryList>");
    q
}

/// The structured query `EvtSubscribe` takes for a filter. `None` = nothing to stream.
pub fn query_list(f: &SyslogFilter) -> Option<String> {
    let xp = xpath(f.apps.as_deref(), f.min_level)?;
    Some(query_of(&channels(f.subsystem.as_deref()), &xp))
}

/// When channel `i` of `n` must stop, as an offset into `budget`: the end of its equal share, so
/// a slow channel never starves the extra one (read last); time left over still carries on.
pub fn channel_share_end(budget: std::time::Duration, i: usize, n: usize) -> std::time::Duration {
    let n = n.max(1) as u32;
    let i = (i as u32).min(n - 1);
    budget * (i + 1) / n
}

/// `syslog_apps`' query for ONE channel: every event no older than `max_age_ms` (read newest
/// first by the caller). One channel per query, so a busy `System` cannot crowd out
/// `Application` within the per-channel cap.
pub fn recent_query(channel: &str, max_age_ms: u64) -> String {
    let xp = format!("*[System[TimeCreated[timediff(@SystemTime) <= {max_age_ms}]]]");
    query_of(&[channel.to_string()], &xp)
}

/// Why a subscription could not start — naming the channels, since an extra one the user
/// typed is the usual culprit (`os` is the system's text for the error).
pub fn start_failed(channels: &[String], os: &str) -> String {
    format!(
        "System apps log stream could not start (reading {}): {os}",
        channels.join(", ")
    )
}

/// Why a running subscription stopped.
pub fn stream_failed(os: &str) -> String {
    format!("System apps log stream stopped: {os}")
}

// ── rendered event XML → fields ──────────────────────────────────────────────

/// The few fields of an `EvtRender(EvtRenderEventXml)` document the view needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventFields {
    /// `System/Provider/@Name`.
    pub provider: String,
    /// `System/EventID` (the classic `Qualifiers` attribute is not part of the id).
    pub event_id: Option<u32>,
    /// `System/Level`.
    pub level: Option<u8>,
    /// `System/TimeCreated/@SystemTime`, unix ms.
    pub ts_ms: Option<i64>,
    /// `System/Channel`.
    pub channel: String,
    /// `System/Execution/@ProcessID` (0 for classic events).
    pub pid: u32,
    /// `EventData/Data` (`Name` attribute, text) and `UserData` leaves (element name, text),
    /// in document order — the message when the publisher has no message table.
    pub data: Vec<(Option<String>, String)>,
}

/// `&lt;` `&gt;` `&amp;` `&quot;` `&apos;` `&#n;` `&#xh;`. An unknown or broken reference is
/// kept verbatim (lossy, never a failure).
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let decoded = tail.find(';').filter(|&j| j <= 12).and_then(|j| {
            let ent = &tail[1..j];
            let c = match ent {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => {
                    let n = if let Some(h) = ent.strip_prefix("#x").or(ent.strip_prefix("#X")) {
                        u32::from_str_radix(h, 16).ok()
                    } else {
                        ent.strip_prefix('#').and_then(|d| d.parse::<u32>().ok())
                    };
                    n.and_then(char::from_u32)
                }
            };
            c.map(|c| (c, j))
        });
        match decoded {
            Some((c, j)) => {
                out.push(c);
                rest = &tail[j + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A tag or a run of text — the whole of the XML the Event Log renders (no DTD, no
/// processing that matters). Comments, `<?…?>` and `<!…>` are skipped; CDATA is text.
enum Tok<'a> {
    Open {
        name: &'a str,
        attrs: Vec<(&'a str, String)>,
        empty: bool,
    },
    /// A closing tag. Its name is not checked: the Event Log never renders mismatched tags.
    Close,
    Text(String),
}

fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// The next token at `*pos`, or `None` at the end (or at malformed input, which ends the
/// document — whatever was read so far still counts).
fn next_tok<'a>(s: &'a str, pos: &mut usize) -> Option<Tok<'a>> {
    loop {
        let rest = s.get(*pos..)?;
        if rest.is_empty() {
            return None;
        }
        if !rest.starts_with('<') {
            let end = rest.find('<').unwrap_or(rest.len());
            *pos += end;
            return Some(Tok::Text(decode_entities(&rest[..end])));
        }
        if let Some(body) = rest.strip_prefix("<![CDATA[") {
            let end = body.find("]]>")?;
            *pos += 9 + end + 3;
            return Some(Tok::Text(body[..end].to_string()));
        }
        if rest.starts_with("<!--") {
            *pos += rest.find("-->")? + 3;
            continue;
        }
        if rest.starts_with("<?") {
            *pos += rest.find("?>")? + 2;
            continue;
        }
        if rest.starts_with("<!") {
            *pos += rest.find('>')? + 1;
            continue;
        }
        if let Some(body) = rest.strip_prefix("</") {
            let end = body.find('>')?;
            *pos += 2 + end + 1;
            return Some(Tok::Close);
        }
        // An opening tag: name, then attributes until `>` or `/>`.
        let b = rest.as_bytes();
        let mut i = 1;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'/' && b[i] != b'>' {
            i += 1;
        }
        let name = local(&rest[1..i]);
        let mut attrs: Vec<(&str, String)> = Vec::new();
        loop {
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            match b.get(i)? {
                b'>' => {
                    *pos += i + 1;
                    return Some(Tok::Open {
                        name,
                        attrs,
                        empty: false,
                    });
                }
                b'/' => {
                    if b.get(i + 1) != Some(&b'>') {
                        return None;
                    }
                    *pos += i + 2;
                    return Some(Tok::Open {
                        name,
                        attrs,
                        empty: true,
                    });
                }
                _ => {
                    let start = i;
                    while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() && b[i] != b'>'
                    {
                        i += 1;
                    }
                    let key = local(&rest[start..i]);
                    while i < b.len() && b[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    if b.get(i) != Some(&b'=') {
                        return None;
                    }
                    i += 1;
                    while i < b.len() && b[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    let q = *b.get(i)?;
                    if q != b'\'' && q != b'"' {
                        return None;
                    }
                    let vstart = i + 1;
                    let vlen = rest[vstart..].find(q as char)?;
                    attrs.push((key, decode_entities(&rest[vstart..vstart + vlen])));
                    i = vstart + vlen + 1;
                }
            }
        }
    }
}

struct Frame<'a> {
    name: &'a str,
    /// The `Name` attribute (an `EventData/Data` key).
    key: Option<String>,
    text: String,
    has_child: bool,
}

/// One rendered event (`EvtRender(EvtRenderEventXml)`) → its fields. `None` when the
/// document has no `<Event>` element.
pub fn parse_event_xml(xml: &str) -> Option<EventFields> {
    let mut ev = EventFields::default();
    let mut seen_event = false;
    let mut stack: Vec<Frame> = Vec::new();
    let mut pos = 0usize;
    let attr = |attrs: &[(&str, String)], k: &str| -> Option<String> {
        attrs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
    };
    let close = |stack: &mut Vec<Frame>, ev: &mut EventFields| {
        let Some(f) = stack.pop() else { return };
        let parent = stack.last().map(|p| p.name).unwrap_or("");
        let in_user_data = stack.iter().any(|p| p.name == "UserData");
        let text = f.text.trim();
        match (parent, f.name) {
            ("System", "EventID") => ev.event_id = text.parse().ok(),
            ("System", "Level") => ev.level = text.parse().ok(),
            ("System", "Channel") => ev.channel = text.to_string(),
            ("EventData", "Data") => ev.data.push((f.key, text.to_string())),
            _ if in_user_data && !f.has_child => {
                ev.data.push((Some(f.name.to_string()), text.to_string()))
            }
            _ => {}
        }
    };
    while let Some(tok) = next_tok(xml, &mut pos) {
        match tok {
            Tok::Open { name, attrs, empty } => {
                let parent = stack.last().map(|p| p.name).unwrap_or("");
                if let Some(p) = stack.last_mut() {
                    p.has_child = true;
                }
                if name == "Event" && stack.is_empty() {
                    seen_event = true;
                }
                if parent == "System" {
                    match name {
                        "Provider" => ev.provider = attr(&attrs, "Name").unwrap_or_default(),
                        "TimeCreated" => {
                            ev.ts_ms = attr(&attrs, "SystemTime")
                                .as_deref()
                                .and_then(parse_system_time)
                        }
                        "Execution" => {
                            ev.pid = attr(&attrs, "ProcessID")
                                .and_then(|p| p.trim().parse().ok())
                                .unwrap_or(0)
                        }
                        _ => {}
                    }
                }
                stack.push(Frame {
                    name,
                    key: attr(&attrs, "Name"),
                    text: String::new(),
                    has_child: false,
                });
                if empty {
                    close(&mut stack, &mut ev);
                }
            }
            Tok::Close => close(&mut stack, &mut ev),
            Tok::Text(t) => {
                if let Some(f) = stack.last_mut() {
                    f.text.push_str(&t);
                }
            }
        }
    }
    seen_event.then_some(ev)
}

/// `2026-11-18T07:56:15.0951986Z` (the Event Log's UTC `SystemTime`) → unix ms.
pub fn parse_system_time(s: &str) -> Option<i64> {
    let s = s.trim().strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: u32 = d.next()?.parse().ok()?;
    let da: u32 = d.next()?.parse().ok()?;
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let se: i64 = t.next()?.parse().ok()?;
    if !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let ms: i64 = format!("{frac:0<3}")[..3].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let days = super::macos::days_from_civil(y, mo, da);
    Some((days * 86_400 + h * 3600 + mi * 60 + se) * 1000 + ms)
}

// ── fields + message → LineDraft ─────────────────────────────────────────────

/// `EvtFormatMessage` output as text: NULs and trailing whitespace gone, `\r\n` → `\n`,
/// leading blank lines dropped.
pub fn clean_message(raw: &str) -> String {
    let s = raw
        .trim_end_matches('\0')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    s.trim_end().trim_start_matches('\n').to_string()
}

/// The message when the publisher has none: the EventData values in order, `name: value` for
/// named ones, empties skipped, joined with `; `.
pub fn fallback_message(data: &[(Option<String>, String)]) -> String {
    data.iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| match k {
            Some(k) if !k.is_empty() => format!("{k}: {}", v.trim()),
            _ => v.trim().to_string(),
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// One event → a `machine` [`LineDraft`]: `source` = provider, `text` = the message's first
/// line, `detail` = `<channel> · event <id>` (+ ` · pid <n>` when non-zero, + the whole
/// message when it has more than one line). `message` is `EvtFormatMessage`'s text, if any.
pub fn draft(ev: &EventFields, message: Option<&str>) -> LineDraft {
    let msg = message
        .map(clean_message)
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| fallback_message(&ev.data));
    let msg = if msg.trim().is_empty() {
        NO_MESSAGE.to_string()
    } else {
        msg
    };
    let mut lines = msg.lines().filter(|l| !l.trim().is_empty());
    let first = lines.next().unwrap_or(NO_MESSAGE).trim_end().to_string();
    let multiline = lines.next().is_some();

    let mut parts: Vec<String> = Vec::new();
    if !ev.channel.is_empty() {
        parts.push(ev.channel.clone());
    }
    if let Some(id) = ev.event_id {
        parts.push(format!("event {id}"));
    }
    if ev.pid != 0 {
        parts.push(format!("pid {}", ev.pid));
    }
    let mut detail = parts.join(" · ");
    if multiline {
        detail.push('\n');
        detail.push_str(&msg);
    }
    LineDraft {
        terminal_id: None,
        agent_id: None,
        source: if ev.provider.is_empty() {
            NO_PROVIDER.to_string()
        } else {
            ev.provider.clone()
        },
        kind: LogKind::Machine,
        level: ev.level.map(level_of).unwrap_or(LogLevel::Info),
        text: cap_text(&first, super::macos::MAX_TEXT),
        detail: if detail.is_empty() {
            None
        } else {
            Some(cap_text(&detail, super::macos::MAX_DETAIL))
        },
        ts_ms: ev.ts_ms,
        tool_use_id: None,
    }
}

/// Providers that recently wrote → picker rows: each name once, no pids/path (a provider is
/// not a process), `isApp` for every provider outside [`MICROSOFT_PREFIX`], sorted exactly
/// like `procs::group_apps` (apps first, then case-insensitive name).
pub fn group_providers<I: IntoIterator<Item = String>>(names: I) -> Vec<RunningApp> {
    let set: BTreeSet<String> = names
        .into_iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    let mut out: Vec<RunningApp> = set
        .into_iter()
        .map(|name| RunningApp {
            is_app: !name.starts_with(MICROSOFT_PREFIX),
            name,
            pids: Vec::new(),
            path: None,
        })
        .collect();
    sort_apps(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real Windows 11 `EvtRender` output, machine-identifying values (names, SIDs, WER ids)
    /// replaced by placeholders; remaining GUIDs are Microsoft's public ids; structure unedited.
    const WER: &str = include_str!("fixtures/eventlog/application-wer-1001.xml");
    const SPP: &str = include_str!("fixtures/eventlog/application-spp-16384.xml");
    const WU_ERROR: &str = include_str!("fixtures/eventlog/system-windowsupdate-error-20.xml");
    const CLASSIC: &str = include_str!("fixtures/eventlog/application-unregistered-source.xml");

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn level_map_table() {
        let table: [(u8, LogLevel); 9] = [
            (0, LogLevel::Info),  // LogAlways
            (1, LogLevel::Error), // Critical
            (2, LogLevel::Error),
            (3, LogLevel::Warn),
            (4, LogLevel::Info),
            (5, LogLevel::Debug), // Verbose
            (6, LogLevel::Debug), // reserved
            (16, LogLevel::Debug),
            (255, LogLevel::Debug), // provider-defined
        ];
        for (lvl, want) in table {
            assert_eq!(level_of(lvl), want, "Event Log level {lvl}");
        }
    }

    #[test]
    fn the_level_clause_keeps_exactly_what_the_map_puts_at_or_above_the_floor() {
        let rank = |l: LogLevel| match l {
            LogLevel::Debug => 0,
            LogLevel::Info => 1,
            LogLevel::Warn => 2,
            LogLevel::Error => 3,
        };
        let table = [
            (SyslogLevel::Debug, None, LogLevel::Debug),
            (
                SyslogLevel::Info,
                Some("(Level=0 or Level=1 or Level=2 or Level=3 or Level=4)"),
                LogLevel::Info,
            ),
            (
                SyslogLevel::Default,
                Some("(Level=0 or Level=1 or Level=2 or Level=3 or Level=4)"),
                LogLevel::Info,
            ),
            (
                SyslogLevel::Error,
                Some("(Level=1 or Level=2)"),
                LogLevel::Error,
            ),
        ];
        for (floor, clause, lowest) in table {
            assert_eq!(level_clause(floor), clause, "{floor:?}");
            // Cross-check: a level is in the clause iff the map ranks it at/above the floor.
            for lvl in 0u8..=20 {
                let kept = match clause {
                    None => true,
                    Some(c) => {
                        c.contains(&format!("Level={lvl})")) || c.contains(&format!("Level={lvl} "))
                    }
                };
                assert_eq!(
                    kept,
                    rank(level_of(lvl)) >= rank(lowest),
                    "{floor:?}: level {lvl}"
                );
            }
        }
    }

    #[test]
    fn xpath_literal_and_xml_escape_table() {
        let lit = [
            ("Application Error", Some("'Application Error'")),
            ("O'Brien Tools", Some("\"O'Brien Tools\"")),
            ("Say \"hi\"", Some("'Say \"hi\"'")),
            ("Both ' and \"", None),
            ("a&b<c>", Some("'a&b<c>'")),
            ("", None),
            ("tab\there", None),
            ("new\nline", None),
            ("nul\0", None),
            ("Ünïcödé · 日本", Some("'Ünïcödé · 日本'")),
        ];
        for (s, want) in lit {
            assert_eq!(xpath_literal(s).as_deref(), want, "{s:?}");
        }
        assert_eq!(
            xml_escape(r#"a&b<c>"d"'e'"#),
            "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;"
        );
        assert_eq!(xml_escape("plain"), "plain");
    }

    #[test]
    fn xpath_table() {
        let d = SyslogLevel::Debug;
        type Case = (Option<Vec<String>>, SyslogLevel, Option<&'static str>);
        let table: Vec<Case> = vec![
            (None, d, Some("*")),
            (
                None,
                SyslogLevel::Error,
                Some("*[System[(Level=1 or Level=2)]]"),
            ),
            (
                Some(names(&["MsiInstaller"])),
                d,
                Some("*[System[Provider[@Name='MsiInstaller']]]"),
            ),
            (
                Some(names(&["A", "O'B"])),
                SyslogLevel::Default,
                Some(
                    "*[System[(Level=0 or Level=1 or Level=2 or Level=3 or Level=4) and \
                     Provider[@Name='A' or @Name=\"O'B\"]]]",
                ),
            ),
            // An unrepresentable name is dropped; the others still filter…
            (
                Some(names(&["Both ' \"", "Good"])),
                d,
                Some("*[System[Provider[@Name='Good']]]"),
            ),
            // …and if none is left it is "nothing", never "everything".
            (Some(names(&["Both ' \""])), d, None),
            (Some(vec![]), d, None),
            // An injection attempt stays inside its literal.
            (
                Some(names(&["x' or @Name!='"])),
                d,
                Some("*[System[Provider[@Name=\"x' or @Name!='\"]]]"),
            ),
        ];
        for (apps, min, want) in table {
            assert_eq!(
                xpath(apps.as_deref(), min).as_deref(),
                want,
                "{apps:?} {min:?}"
            );
        }
    }

    #[test]
    fn channels_add_one_extra_and_never_repeat() {
        assert_eq!(channels(None), names(&["Application", "System"]));
        assert_eq!(
            channels(Some(" Microsoft-Windows-PowerShell/Operational ")),
            names(&[
                "Application",
                "System",
                "Microsoft-Windows-PowerShell/Operational"
            ])
        );
        assert_eq!(channels(Some("system")), names(&["Application", "System"]));
        assert_eq!(channels(Some("")), names(&["Application", "System"]));
        assert_eq!(
            channels(Some("bad\u{1}")),
            names(&["Application", "System"])
        );
    }

    #[test]
    fn query_list_is_well_formed_and_escaped() {
        let f = SyslogFilter {
            enabled: true,
            apps: Some(names(&["R&D <Tools>", "O'Brien"])),
            subsystem: Some(r#"Odd "Channel"/Operational"#.into()),
            min_level: SyslogLevel::Error,
            ..Default::default()
        };
        let xp =
            "*[System[(Level=1 or Level=2) and Provider[@Name=&apos;R&amp;D &lt;Tools&gt;&apos; \
                  or @Name=&quot;O&apos;Brien&quot;]]]";
        assert_eq!(
            query_list(&f).unwrap(),
            format!(
                "<QueryList><Query Id=\"0\">\
                 <Select Path=\"Application\">{xp}</Select>\
                 <Select Path=\"System\">{xp}</Select>\
                 <Select Path=\"Odd &quot;Channel&quot;/Operational\">{xp}</Select>\
                 </Query></QueryList>"
            )
        );
        // Round trip through our own reader: the escaped query decodes back to the XPath.
        let q = query_list(&f).unwrap();
        let mut pos = 0;
        let mut texts = Vec::new();
        let mut paths = Vec::new();
        while let Some(t) = next_tok(&q, &mut pos) {
            match t {
                Tok::Text(s) => texts.push(s),
                Tok::Open {
                    name: "Select",
                    attrs,
                    ..
                } => paths.push(attrs[0].1.clone()),
                _ => {}
            }
        }
        assert_eq!(
            paths,
            names(&["Application", "System", r#"Odd "Channel"/Operational"#])
        );
        assert_eq!(
            texts[0],
            xpath(f.apps.as_deref(), f.min_level).unwrap(),
            "the service reads back exactly the XPath we built"
        );
        let none = SyslogFilter {
            enabled: true,
            apps: Some(vec![]),
            ..Default::default()
        };
        assert_eq!(query_list(&none), None);
    }

    #[test]
    fn each_channel_reads_until_the_end_of_its_share() {
        use std::time::Duration;
        let b = Duration::from_millis(3000);
        assert_eq!(channel_share_end(b, 0, 3), Duration::from_millis(1000));
        assert_eq!(channel_share_end(b, 1, 3), Duration::from_millis(2000));
        assert_eq!(
            channel_share_end(b, 2, 3),
            b,
            "the last channel ends with the budget"
        );
        assert_eq!(channel_share_end(b, 0, 2), Duration::from_millis(1500));
        assert_eq!(channel_share_end(b, 0, 1), b);
        assert_eq!(channel_share_end(b, 5, 3), b, "never past the budget");
        assert_eq!(
            channel_share_end(b, 0, 0),
            b,
            "no channels: no division by zero"
        );
    }

    #[test]
    fn recent_query_bounds_age_per_channel() {
        assert_eq!(
            recent_query("System", 604_800_000),
            "<QueryList><Query Id=\"0\"><Select Path=\"System\">\
             *[System[TimeCreated[timediff(@SystemTime) &lt;= 604800000]]]\
             </Select></Query></QueryList>"
        );
    }

    #[test]
    fn parses_a_real_named_eventdata_event() {
        let ev = parse_event_xml(WER).unwrap();
        assert_eq!(ev.provider, "Windows Error Reporting");
        assert_eq!(ev.event_id, Some(1001));
        assert_eq!(ev.level, Some(4));
        assert_eq!(ev.channel, "Application");
        assert_eq!(ev.pid, 11924);
        // 2026-11-18T07:56:15.0951986Z
        assert_eq!(ev.ts_ms, Some(1_794_988_575_095));
        assert_eq!(ev.data[0], (Some("Bucket".to_string()), "0".to_string()));
        assert_eq!(
            ev.data.iter().find(|(k, _)| k.as_deref() == Some("P1")),
            Some(&(Some("P1".to_string()), "link.exe".to_string()))
        );
        assert!(ev
            .data
            .iter()
            .any(|(k, v)| k.as_deref() == Some("P4") && v.is_empty()));
    }

    #[test]
    fn parses_a_real_classic_event_with_qualifiers_and_unnamed_data() {
        let ev = parse_event_xml(SPP).unwrap();
        assert_eq!(ev.provider, "Microsoft-Windows-Security-SPP");
        assert_eq!(ev.event_id, Some(16384), "Qualifiers is not the id");
        assert_eq!(ev.pid, 11648);
        assert_eq!(
            ev.data,
            vec![
                (None, "2026-11-19T06:45:45Z".to_string()),
                (None, "RulesEngine".to_string())
            ]
        );
    }

    #[test]
    fn parses_a_real_system_error() {
        let ev = parse_event_xml(WU_ERROR).unwrap();
        assert_eq!(ev.provider, "Microsoft-Windows-WindowsUpdateClient");
        assert_eq!((ev.event_id, ev.level), (Some(20), Some(2)));
        assert_eq!(ev.channel, "System");
        let d = draft(
            &ev,
            Some("Installation Failure: Windows failed to install the following update with error 0x80073D02: 9PC1H9VN18CM-Microsoft.StartExperiencesApp.\r\n\0"),
        );
        assert_eq!(d.level, LogLevel::Error);
        assert_eq!(d.source, "Microsoft-Windows-WindowsUpdateClient");
        assert_eq!(
            d.text,
            "Installation Failure: Windows failed to install the following update with error 0x80073D02: 9PC1H9VN18CM-Microsoft.StartExperiencesApp."
        );
        assert_eq!(d.detail.as_deref(), Some("System · event 20 · pid 7772"));
        assert_eq!(d.kind, LogKind::Machine);
        assert_eq!(d.ts_ms, ev.ts_ms);
    }

    #[test]
    fn an_unregistered_source_falls_back_to_its_inserted_strings() {
        // What `RegisterEventSourceW` + `ReportEventW` writes for a source with no message
        // table (captured from the live test's own writer): the writer's pid (thread 0), the
        // inserted strings as unnamed Data.
        let ev = parse_event_xml(CLASSIC).unwrap();
        assert_eq!(ev.provider, "AgentStudio-test-fixture");
        assert_eq!(ev.pid, 6852);
        assert_eq!(ev.level, Some(3));
        let d = draft(&ev, None);
        assert_eq!(d.level, LogLevel::Warn);
        assert_eq!(d.text, "agent-studio fixture warning");
        assert_eq!(
            d.detail.as_deref(),
            Some("Application · event 1000 · pid 6852")
        );
    }

    #[test]
    fn draft_shapes_text_detail_and_fallbacks() {
        let ev = EventFields {
            provider: String::new(),
            event_id: Some(7),
            level: None,
            ts_ms: None,
            channel: "System".into(),
            pid: 4,
            data: vec![
                (Some("Param1".into()), " value ".into()),
                (Some("Empty".into()), "".into()),
                (None, "loose".into()),
            ],
        };
        let d = draft(&ev, Some("\r\n\r\nFirst line\r\n\r\nSecond line\r\n"));
        assert_eq!(d.source, NO_PROVIDER);
        assert_eq!(d.level, LogLevel::Info, "no Level → info");
        assert_eq!(d.text, "First line");
        assert_eq!(
            d.detail.as_deref(),
            Some("System · event 7 · pid 4\nFirst line\n\nSecond line")
        );
        // A blank formatted message falls back to the data, named as `name: value`.
        let d = draft(&ev, Some("  \r\n"));
        assert_eq!(d.text, "Param1: value; loose");
        // pid 0 is not shown.
        let no_pid = EventFields {
            channel: "Application".into(),
            event_id: Some(1),
            ..Default::default()
        };
        assert_eq!(
            draft(&no_pid, Some("m")).detail.as_deref(),
            Some("Application · event 1")
        );
        let bare = EventFields::default();
        let d = draft(&bare, None);
        assert_eq!(d.text, NO_MESSAGE);
        assert_eq!(d.detail, None);
        // Over-long text is capped like every machine line.
        let long = "x".repeat(10_000);
        assert!(draft(&bare, Some(&long)).text.len() <= super::super::macos::MAX_TEXT + 3);
    }

    #[test]
    fn user_data_leaves_are_the_fallback_and_entities_decode() {
        let xml = "<?xml version='1.0'?><Event xmlns='x'><!-- c --><System>\
                   <Provider Name='P &amp; Q'/><EventID>1</EventID><Level>3</Level>\
                   <Channel>System</Channel></System><UserData><Wrap xmlns='y'>\
                   <Who>a &lt;b&gt; &#65;&#x42; &bogus; &amp</Who><Code><![CDATA[<raw>]]></Code>\
                   </Wrap></UserData></Event>";
        let ev = parse_event_xml(xml).unwrap();
        assert_eq!(ev.provider, "P & Q");
        assert_eq!(
            ev.data,
            vec![
                (Some("Who".into()), "a <b> AB &bogus; &amp".into()),
                (Some("Code".into()), "<raw>".into())
            ]
        );
        assert_eq!(parse_event_xml("<NotAnEvent/>"), None);
        assert_eq!(parse_event_xml(""), None);
        // Truncated input keeps what was read.
        let cut = parse_event_xml("<Event><System><Provider Name='Cut'/><EventID>9</Ev").unwrap();
        assert_eq!((cut.provider.as_str(), cut.event_id), ("Cut", None));
    }

    #[test]
    fn system_time_table() {
        assert_eq!(parse_system_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_system_time("1970-01-01T00:00:01.5Z"), Some(1_500));
        assert_eq!(
            parse_system_time("2026-11-18T07:56:15.0951986Z"),
            Some(1_794_988_575_095)
        );
        assert_eq!(parse_system_time("2026-11-18T07:56:15"), None, "no Z");
        assert_eq!(parse_system_time("2026-13-18T07:56:15Z"), None);
        assert_eq!(parse_system_time("2026-11-18T07:56:15.12aZ"), None);
    }

    #[test]
    fn providers_group_like_running_apps() {
        let got = group_providers(names(&[
            "Microsoft-Windows-WindowsUpdateClient",
            "MsiInstaller",
            "Windows Error Reporting",
            "msiinstaller",
            "MsiInstaller",
            " ",
            "Microsoft-Windows-AppXDeploymentServer/Operational",
            "Application Error",
        ]));
        let n: Vec<&str> = got.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            n,
            [
                "Application Error",
                "MsiInstaller",
                "msiinstaller",
                "Windows Error Reporting",
                "Microsoft-Windows-AppXDeploymentServer/Operational",
                "Microsoft-Windows-WindowsUpdateClient",
            ]
        );
        assert!(got[..4].iter().all(|a| a.is_app));
        assert!(got[4..].iter().all(|a| !a.is_app));
        assert!(got.iter().all(|a| a.pids.is_empty() && a.path.is_none()));
    }

    #[test]
    fn failure_reasons_name_the_channels() {
        assert_eq!(
            start_failed(
                &channels(Some("Foo/Operational")),
                "The specified channel could not be found. (os error 15007)"
            ),
            "System apps log stream could not start (reading Application, System, \
             Foo/Operational): The specified channel could not be found. (os error 15007)"
        );
        assert_eq!(
            stream_failed("x (os error 1)"),
            "System apps log stream stopped: x (os error 1)"
        );
    }

    #[test]
    fn the_backend_is_available_without_a_program() {
        let b = backend();
        assert!(b.available);
        assert_eq!(b.name, Some("windows-eventlog"));
        assert_eq!(b.program, None);
        assert_eq!(b.kind, BackendKind::WindowsEventLog);
    }
}
