//! What an agent reads back from the HTTP tools: bounded, and with the user's secrets out.
//!
//! * Bounded: a response body is cut at [`BODY_CAP`] bytes of text, headers at [`HEADER_CAP`]
//!   rows of at most [`VALUE_CAP`] characters, a compare at [`DIFF_CAP`] differences — and every
//!   cut is said in the output, never silent.
//! * Secret-free: [`Redactor`] puts `{{NAME}}` back wherever a value Agent Studio substituted into
//!   a saved request comes back in the response (an echo endpoint, a redirect, an error naming
//!   the URL); [`redact_url`] hides the password of a `user:password@` URL and the value of a
//!   query parameter whose name says it is a credential.

use serde_json::{json, Value};

use crate::http::{HttpHeader, HttpResponse};

/// The most response-body text an agent is handed (after pretty-printing).
pub const BODY_CAP: usize = 64 * 1024;
/// The most response headers listed.
pub const HEADER_CAP: usize = 50;
/// The longest header value (and compared value) shown, in characters.
pub const VALUE_CAP: usize = 300;
/// The most differences a compare lists.
pub const DIFF_CAP: usize = 100;
/// How deep a JSON compare walks.
const DIFF_DEPTH: usize = 64;

/// `text` cut to at most `max` bytes on a character boundary, and whether it was cut.
pub fn cut(text: &str, max: usize) -> (&str, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

/// A value for a one-line listing: newlines flattened, cut at [`VALUE_CAP`] characters.
pub fn short(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if flat.chars().count() <= VALUE_CAP {
        return flat;
    }
    let mut s: String = flat.chars().take(VALUE_CAP).collect();
    s.push('…');
    s
}

/// `1234567` → `"1,234,567"`.
pub fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `512 B`, `1.5 KB`, `2.0 MB`.
pub fn human_size(n: usize) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

/// `text` re-indented with two spaces when it is valid JSON, keys in the order the server sent
/// them (a parse into `serde_json::Value` would sort them and round large numbers). `None` when
/// it is not JSON.
pub fn pretty_json(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str::<serde::de::IgnoredAny>(trimmed).ok()?;
    let mut out = String::with_capacity(trimmed.len() + trimmed.len() / 4);
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut chars = trimmed.chars().peekable();
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '{' | '[' => {
                out.push(c);
                // `{}` / `[]` stay on one line.
                while chars.peek().is_some_and(|c| c.is_whitespace()) {
                    chars.next();
                }
                if matches!(chars.peek(), Some('}') | Some(']')) {
                    out.push(chars.next().unwrap_or(']'));
                } else {
                    depth += 1;
                    newline(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                newline(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(c);
                newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            c if c.is_whitespace() => {}
            c => out.push(c),
        }
    }
    Some(out)
}

/// Replaces values Agent Studio substituted into a request with the `{{NAME}}` they came from.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    /// `(value, "{{NAME}}")`, longest value first so a value containing another is replaced
    /// whole.
    pairs: Vec<(String, String)>,
}

impl Redactor {
    /// Values shorter than this are not redacted: replacing every `1` or `on` in a response would
    /// garble it, and a two-character value is not a secret worth hiding.
    pub const MIN_LEN: usize = 4;

    /// `used`: `(NAME, value)` for every variable substituted into the request.
    pub fn new(used: &[(String, String)]) -> Self {
        let mut pairs: Vec<(String, String)> = Vec::new();
        for (k, v) in used {
            if v.chars().count() < Self::MIN_LEN {
                continue;
            }
            let name = format!("{{{{{k}}}}}");
            for form in Self::forms(v) {
                pairs.push((form, name.clone()));
            }
        }
        pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        pairs.dedup_by(|a, b| a.0 == b.0);
        Self { pairs }
    }

    /// The spellings a value can come back in: as sent, percent-encoded the way the URL parser
    /// encodes a path or a query (a server or an error message echoing the request URL), and
    /// percent-encoded as a server building a link would (`encodeURIComponent`, RFC 3986
    /// unreserved, everything).
    fn forms(value: &str) -> Vec<String> {
        use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
        /// `encodeURIComponent` leaves `A–Z a–z 0–9 - _ . ! ~ * ' ( )`.
        const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
            .remove(b'-')
            .remove(b'_')
            .remove(b'.')
            .remove(b'!')
            .remove(b'~')
            .remove(b'*')
            .remove(b'\'')
            .remove(b'(')
            .remove(b')');
        /// RFC 3986's unreserved set.
        const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
            .remove(b'-')
            .remove(b'_')
            .remove(b'.')
            .remove(b'~');
        let mut forms = vec![value.to_string()];
        // Inside a JSON string (`"…"` stripped): an echo endpoint escapes `"` and `\`.
        if let Ok(quoted) = serde_json::to_string(value) {
            forms.push(quoted[1..quoted.len() - 1].to_string());
        }
        if let Ok(u) = reqwest::Url::parse(&format!("http://h/{value}?{value}")) {
            forms.push(u.path()[1..].to_string());
            forms.push(u.query().unwrap_or_default().to_string());
        }
        // A value that is a URL (`BASE=https://internal.example:8443`) comes back as its host in
        // a connect error or a `Host` echo.
        if let Ok(u) = reqwest::Url::parse(value) {
            if let Some(host) = u.host_str() {
                forms.push(host.to_string());
                if let Some(port) = u.port() {
                    forms.push(format!("{host}:{port}"));
                }
            }
        }
        for set in [URI_COMPONENT, UNRESERVED, NON_ALPHANUMERIC] {
            forms.push(utf8_percent_encode(value, set).to_string());
        }
        forms.retain(|f| f.chars().count() >= Self::MIN_LEN);
        forms.sort();
        forms.dedup();
        forms
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    /// `text` with every known value (in every spelling) replaced by its `{{NAME}}`.
    pub fn apply(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (value, name) in &self.pairs {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), name);
            }
        }
        out
    }

    /// The response with the body and every header value redacted.
    pub fn response(&self, mut r: HttpResponse) -> HttpResponse {
        if self.is_empty() {
            return r;
        }
        r.body = self.apply(&r.body);
        for h in &mut r.headers {
            h.value = self.apply(&h.value);
        }
        r
    }
}

/// Is `name` (a query parameter) a credential by its name?
fn secret_param(name: &str) -> bool {
    let n: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    n.ends_with("key")
        || n == "sig"
        || [
            "token",
            "secret",
            "password",
            "passwd",
            "pwd",
            "auth",
            "signature",
            "credential",
            "session",
        ]
        .iter()
        .any(|w| n.contains(w))
}

/// Is `value` exactly one `{{NAME}}` reference (safe to show: it names, it does not reveal)?
fn is_ref(value: &str) -> bool {
    crate::db::secret::is_ref(value)
}

/// A URL as written, safe to show an agent: the password in `user:password@` and the value of a
/// credential-named query parameter (`?api_key=…`, `token=…`) become `***`, unless they are a
/// `{{NAME}}` reference. Works on text, so a URL built from `{{HOST}}` (not parseable) is
/// handled the same.
pub fn redact_url(url: &str) -> String {
    let (before_frag, frag) = match url.find('#') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    };
    let (base, query) = match before_frag.find('?') {
        Some(i) => (&before_frag[..i], Some(&before_frag[i + 1..])),
        None => (before_frag, None),
    };
    let mut out = String::with_capacity(url.len());
    // userinfo: between `://` and the last `@` of the authority.
    match base.find("://") {
        Some(s) => {
            let auth_start = s + 3;
            let auth_end = base[auth_start..]
                .find('/')
                .map(|i| auth_start + i)
                .unwrap_or(base.len());
            let authority = &base[auth_start..auth_end];
            out.push_str(&base[..auth_start]);
            match authority.rfind('@') {
                Some(at) => {
                    let userinfo = &authority[..at];
                    match userinfo.split_once(':') {
                        Some((user, pw)) if !pw.is_empty() && !is_ref(pw) => {
                            out.push_str(user);
                            out.push_str(":***");
                        }
                        _ => out.push_str(userinfo),
                    }
                    out.push_str(&authority[at..]);
                }
                None => out.push_str(authority),
            }
            out.push_str(&base[auth_end..]);
        }
        None => out.push_str(base),
    }
    if let Some(q) = query {
        out.push('?');
        let parts: Vec<String> = q
            .split('&')
            .map(|pair| match pair.split_once('=') {
                Some((k, v)) if secret_param(k) && !v.is_empty() && !is_ref(v) => {
                    format!("{k}=***")
                }
                _ => pair.to_string(),
            })
            .collect();
        out.push_str(&parts.join("&"));
    }
    out.push_str(frag);
    out
}

/// The headers block of a reply: at most [`HEADER_CAP`] rows, values cut at [`VALUE_CAP`].
fn header_lines(headers: &[HttpHeader]) -> Vec<String> {
    let mut lines = vec![format!("Headers ({}):", headers.len())];
    for h in headers.iter().take(HEADER_CAP) {
        lines.push(format!("  {}: {}", h.name, short(&h.value)));
    }
    if headers.len() > HEADER_CAP {
        lines.push(format!(
            "  [{} more headers not shown.]",
            headers.len() - HEADER_CAP
        ));
    }
    lines
}

/// The `Content-Type` header's value, if any.
pub fn content_type(headers: &[HttpHeader]) -> Option<&str> {
    headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.as_str())
}

/// A response, as the agent reads it (`message`) and as `--json` / MCP return it (`data`).
/// `request_line` is what was sent (`GET https://…`), `note` a line about how it was sent.
pub fn response_report(r: &HttpResponse, request_line: &str, note: &str) -> (String, Value) {
    let pretty = pretty_json(&r.body);
    let format = if pretty.is_some() { "json" } else { "text" };
    let text = pretty.as_deref().unwrap_or(&r.body);
    let (shown, cut_here) = cut(text, BODY_CAP);
    let mut lines = vec![
        format!(
            "{} {} in {} ms, {}{}",
            r.status,
            r.status_text,
            r.duration_ms,
            human_size(r.size_bytes),
            content_type(&r.headers)
                .map(|t| format!(" ({t})"))
                .unwrap_or_default()
        ),
        request_line.to_string(),
    ];
    if !note.is_empty() {
        lines.push(note.to_string());
    }
    lines.push(String::new());
    lines.extend(header_lines(&r.headers));
    lines.push(String::new());
    if r.body.is_empty() {
        lines.push("No body.".to_string());
    } else {
        lines.push(if pretty.is_some() {
            "Body (JSON, re-indented):".to_string()
        } else {
            "Body:".to_string()
        });
        lines.push(shown.to_string());
    }
    let truncated = cut_here || r.truncated;
    if cut_here {
        lines.push(format!(
            "[Body truncated: showing the first {} of {} bytes{}.]",
            thousands(shown.len()),
            thousands(text.len()),
            if pretty.is_some() {
                " of the re-indented JSON"
            } else {
                ""
            }
        ));
    } else if r.truncated {
        lines.push(format!(
            "[Body truncated by the API client at {}; the response was {} bytes.]",
            human_size(crate::http::MAX_BODY_BYTES),
            thousands(r.size_bytes)
        ));
    }
    let headers: Vec<Value> = r
        .headers
        .iter()
        .take(HEADER_CAP)
        .map(|h| json!({"name": h.name, "value": short(&h.value)}))
        .collect();
    let data = json!({
        "status": r.status,
        "statusText": r.status_text,
        "durationMs": r.duration_ms,
        "sizeBytes": r.size_bytes,
        "headers": headers,
        "headersTruncated": r.headers.len() > HEADER_CAP,
        "bodyFormat": format,
        "body": shown,
        "bodyTruncated": truncated,
    });
    (lines.join("\n"), data)
}

/// One side of a compare, once sent.
#[derive(Debug, Clone)]
pub struct Side {
    /// `A: GET https://…` or `A: "Get user" (saved)`.
    pub label: String,
    pub outcome: Result<HttpResponse, String>,
}

/// One difference between two JSON bodies, at a path like `$.items[0].name`.
#[derive(Debug, Clone, PartialEq)]
pub enum Diff {
    OnlyA(String, Value),
    OnlyB(String, Value),
    Changed(String, Value, Value),
}

impl Diff {
    fn line(&self) -> String {
        let v = |v: &Value| short(&v.to_string());
        match self {
            Diff::OnlyA(p, a) => format!("  - {p}: {} (only in A)", v(a)),
            Diff::OnlyB(p, b) => format!("  + {p}: {} (only in B)", v(b)),
            Diff::Changed(p, a, b) => format!("  ~ {p}: {} → {}", v(a), v(b)),
        }
    }

    fn data(&self) -> Value {
        let v = |v: &Value| Value::String(short(&v.to_string()));
        match self {
            Diff::OnlyA(p, a) => json!({"path": p, "change": "onlyA", "a": v(a)}),
            Diff::OnlyB(p, b) => json!({"path": p, "change": "onlyB", "b": v(b)}),
            Diff::Changed(p, a, b) => json!({"path": p, "change": "changed", "a": v(a), "b": v(b)}),
        }
    }
}

/// Every difference between `a` and `b`, object keys in sorted order and array elements by
/// index; stops collecting at `limit` + 1 so a huge diff costs no more than the cap.
pub fn json_diff(a: &Value, b: &Value, limit: usize) -> Vec<Diff> {
    let mut out = Vec::new();
    walk("$".to_string(), Some(a), Some(b), 0, limit + 1, &mut out);
    out
}

fn walk(
    path: String,
    a: Option<&Value>,
    b: Option<&Value>,
    depth: usize,
    limit: usize,
    out: &mut Vec<Diff>,
) {
    if out.len() >= limit {
        return;
    }
    match (a, b) {
        (Some(Value::Object(x)), Some(Value::Object(y))) if depth < DIFF_DEPTH => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let p = if k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !k.is_empty()
                {
                    format!("{path}.{k}")
                } else {
                    format!("{path}[{}]", Value::String(k.clone()))
                };
                walk(p, x.get(k), y.get(k), depth + 1, limit, out);
            }
        }
        (Some(Value::Array(x)), Some(Value::Array(y))) if depth < DIFF_DEPTH => {
            for i in 0..x.len().max(y.len()) {
                walk(
                    format!("{path}[{i}]"),
                    x.get(i),
                    y.get(i),
                    depth + 1,
                    limit,
                    out,
                );
            }
        }
        (Some(x), Some(y)) if x != y => out.push(Diff::Changed(path, x.clone(), y.clone())),
        (Some(x), None) => out.push(Diff::OnlyA(path, x.clone())),
        (None, Some(y)) => out.push(Diff::OnlyB(path, y.clone())),
        _ => {}
    }
}

/// Header names (lowercased) → their values joined with `, `, sorted by name.
fn header_map(headers: &[HttpHeader]) -> std::collections::BTreeMap<String, String> {
    let mut m: std::collections::BTreeMap<String, String> = Default::default();
    for h in headers {
        m.entry(h.name.to_ascii_lowercase())
            .and_modify(|v| {
                v.push_str(", ");
                v.push_str(&h.value);
            })
            .or_insert_with(|| h.value.clone());
    }
    m
}

/// Two responses side by side: status, timing, size, header differences and a JSON key/value
/// diff (or, for text, whether and where the bodies differ). Bounded at [`DIFF_CAP`] lines per
/// section, and says so when it cuts.
pub fn compare_report(a: &Side, b: &Side) -> (String, Value) {
    let mut lines = vec![a.label.clone(), b.label.clone(), String::new()];
    let outcome = |s: &Side| match &s.outcome {
        Ok(r) => format!(
            "{} {} in {} ms, {}",
            r.status,
            r.status_text,
            r.duration_ms,
            human_size(r.size_bytes)
        ),
        Err(e) => format!("failed: {e}"),
    };
    lines.push(format!("A: {}", outcome(a)));
    lines.push(format!("B: {}", outcome(b)));
    let side_data = |s: &Side| match &s.outcome {
        Ok(r) => json!({
            "label": s.label, "status": r.status, "statusText": r.status_text,
            "durationMs": r.duration_ms, "sizeBytes": r.size_bytes, "error": null,
        }),
        Err(e) => json!({"label": s.label, "status": null, "error": e}),
    };
    let (Ok(ra), Ok(rb)) = (&a.outcome, &b.outcome) else {
        lines.push(String::new());
        lines.push("Nothing more to compare: a side did not get a response.".to_string());
        return (
            lines.join("\n"),
            json!({"a": side_data(a), "b": side_data(b), "headers": null, "body": null}),
        );
    };
    lines.push(match ra.status == rb.status {
        true => format!("Same status ({}).", ra.status),
        false => format!("Different status: {} vs {}.", ra.status, rb.status),
    });
    let (fast, slow, d) = if ra.duration_ms <= rb.duration_ms {
        ("A", "B", rb.duration_ms - ra.duration_ms)
    } else {
        ("B", "A", ra.duration_ms - rb.duration_ms)
    };
    lines.push(format!("{fast} was {d} ms faster than {slow}."));

    // Headers.
    let (ha, hb) = (header_map(&ra.headers), header_map(&rb.headers));
    let mut header_diffs: Vec<Value> = Vec::new();
    let mut header_lines = Vec::new();
    let mut names: Vec<&String> = ha.keys().chain(hb.keys()).collect();
    names.sort();
    names.dedup();
    let mut header_total = 0usize;
    for n in names {
        let (x, y) = (ha.get(n), hb.get(n));
        if x == y {
            continue;
        }
        header_total += 1;
        if header_diffs.len() >= DIFF_CAP {
            continue;
        }
        let (line, d) = match (x, y) {
            (Some(x), Some(y)) => (
                format!("  ~ {n}: {} → {}", short(x), short(y)),
                json!({"name": n, "change": "changed", "a": short(x), "b": short(y)}),
            ),
            (Some(x), None) => (
                format!("  - {n}: {} (only in A)", short(x)),
                json!({"name": n, "change": "onlyA", "a": short(x)}),
            ),
            (None, Some(y)) => (
                format!("  + {n}: {} (only in B)", short(y)),
                json!({"name": n, "change": "onlyB", "b": short(y)}),
            ),
            (None, None) => continue,
        };
        header_lines.push(line);
        header_diffs.push(d);
    }
    lines.push(String::new());
    if header_total == 0 {
        lines.push("Headers: the same.".to_string());
    } else {
        lines.push(format!("Headers: {header_total} differ."));
        lines.extend(header_lines);
        if header_total > DIFF_CAP {
            lines.push(format!(
                "  [{} more header differences not shown.]",
                header_total - DIFF_CAP
            ));
        }
    }

    // Bodies.
    lines.push(String::new());
    let ja = serde_json::from_str::<Value>(ra.body.trim()).ok();
    let jb = serde_json::from_str::<Value>(rb.body.trim()).ok();
    let body = match (&ja, &jb) {
        (Some(x), Some(y)) => {
            let diffs = json_diff(x, y, DIFF_CAP);
            let more = diffs.len() > DIFF_CAP;
            let shown = &diffs[..diffs.len().min(DIFF_CAP)];
            if diffs.is_empty() {
                lines.push("Body (JSON): the same values.".to_string());
            } else {
                lines.push(format!(
                    "Body (JSON, keys sorted): {}{} difference{}.",
                    shown.len(),
                    if more { "+" } else { "" },
                    if shown.len() == 1 && !more { "" } else { "s" }
                ));
                lines.extend(shown.iter().map(Diff::line));
                if more {
                    lines.push(format!(
                        "  [Stopped after {DIFF_CAP} differences; there are more.]"
                    ));
                }
            }
            json!({
                "format": "json",
                "same": diffs.is_empty(),
                "diffs": shown.iter().map(Diff::data).collect::<Vec<_>>(),
                "truncated": more,
            })
        }
        _ => {
            let same = ra.body == rb.body;
            let kind = match (&ja, &jb) {
                (Some(_), None) => "A is JSON, B is not",
                (None, Some(_)) => "B is JSON, A is not",
                _ => "text",
            };
            if same {
                lines.push("Body: identical.".to_string());
            } else {
                lines.push(format!(
                    "Body ({kind}): differs ({} vs {}).",
                    human_size(ra.body.len()),
                    human_size(rb.body.len())
                ));
            }
            let first = (!same).then(|| {
                let (la, lb): (Vec<&str>, Vec<&str>) =
                    (ra.body.lines().collect(), rb.body.lines().collect());
                let at = (0..la.len().max(lb.len()))
                    .find(|&i| la.get(i) != lb.get(i))
                    .unwrap_or(0);
                let (x, y) = (
                    la.get(at).copied().unwrap_or(""),
                    lb.get(at).copied().unwrap_or(""),
                );
                lines.push(format!("  First difference at line {}:", at + 1));
                lines.push(format!("  A: {}", short(x)));
                lines.push(format!("  B: {}", short(y)));
                json!({"line": at + 1, "a": short(x), "b": short(y)})
            });
            json!({"format": kind, "same": same, "firstDifference": first})
        }
    };
    let data = json!({
        "a": side_data(a),
        "b": side_data(b),
        "headers": {
            "same": header_total == 0,
            "diffs": header_diffs,
            "truncated": header_total > DIFF_CAP,
        },
        "body": body,
    });
    (lines.join("\n"), data)
}

#[cfg(test)]
#[path = "http_report_tests.rs"]
mod tests;
