//! What an agent reads back from the HTTP tools: bounded, and with the user's secrets out.
//!
//! * Bounded: a response body is cut at [`BODY_CAP`] bytes of text, headers at [`HEADER_CAP`]
//!   rows of at most [`VALUE_CAP`] characters, a compare at [`DIFF_CAP`] differences — and every
//!   cut is said in the output, never silent.
//! * Secret-free: [`Redactor`] puts `{{NAME}}` back wherever a value Agent Studio substituted into
//!   a saved request comes back (an echo endpoint, a redirect, an error naming the URL), and
//!   `***` wherever a credential typed literally into a saved request does
//!   ([`Redactor::masking`]); [`redact_url`] hides the userinfo of a `user:password@` URL, the
//!   value of a query or fragment parameter whose name says it is a credential, and the
//!   credential in the path of a well-known webhook or bot URL; [`redact_urls_in`] does that to
//!   every URL inside free text; [`scrub`] is both passes.
//!
//! 🔴 Value-based redaction ([`Redactor`]) runs only over what answers a **user-saved** request,
//! with that request's own substituted values: text an agent wrote (its own request, its echo,
//! its error, its history entry) is never matched against Vault values, or the match would tell
//! the agent that a value it guessed is one. Everything else is structural: [`redact_url`] works
//! on the shape of a URL, [`failure_kind`] on the fixed words an engine error starts with.

use serde_json::{json, Value};

use crate::http::{HttpHeader, HttpResponse};

/// What a credential reads as when it has no `{{NAME}}` to stand for it.
pub const MASK: &str = "***";

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
    short_to(text, VALUE_CAP)
}

/// [`short`] at `max` characters; a cut ends in `…`, so it is never silent.
pub fn short_to(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if flat.chars().count() <= max {
        return flat;
    }
    let mut s: String = flat.chars().take(max).collect();
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

/// Replaces values with what may be shown instead: a value Agent Studio substituted with the
/// `{{NAME}}` it came from, a literal credential with [`MASK`].
///
/// 🔴 Only for what answers a request the **user** saved, built from that request's own values.
/// Run over text an agent wrote, a replacement would confirm a value the agent guessed.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    /// `(spelling, replacement)`, longest spelling first so a value containing another is
    /// replaced whole; for one spelling, the pair added first wins.
    pairs: Vec<(String, String)>,
}

impl Redactor {
    /// Values shorter than this are not redacted: replacing every `1` or `on` in a response would
    /// garble it, and a two-character value is not a secret worth hiding.
    pub const MIN_LEN: usize = 4;

    /// `used`: `(NAME, value)` for every variable substituted into the request.
    pub fn new(used: &[(String, String)]) -> Self {
        let mut r = Self::default();
        for (k, v) in used {
            r.add(v, &format!("{{{{{k}}}}}"));
        }
        r.sorted()
    }

    /// Also replace each of `values` — credentials written literally, with no name to show —
    /// by [`MASK`]. Where a value is also a substituted one, its `{{NAME}}` wins.
    pub fn masking(mut self, values: &[String]) -> Self {
        for v in values {
            self.add(v, MASK);
        }
        self.sorted()
    }

    fn add(&mut self, value: &str, replacement: &str) {
        if value.chars().count() < Self::MIN_LEN {
            return;
        }
        for form in Self::forms(value) {
            self.pairs.push((form, replacement.to_string()));
        }
    }

    fn sorted(mut self) -> Self {
        // A stable sort: for one spelling, the pair added first stays first and is kept.
        self.pairs
            .sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        self.pairs.dedup_by(|later, kept| later.0 == kept.0);
        self
    }

    /// The spellings a value can come back in: as sent; read back from a form (`+` as a space);
    /// percent-encoded the way the URL parser encodes a path or a query (a server or an error
    /// message echoing the request URL), as a server building a link would
    /// (`encodeURIComponent`, RFC 3986 unreserved, everything, `application/x-www-form-urlencoded`)
    /// and with lowercase hex; and every one of those inside a JSON string, also from an encoder
    /// that escapes `/` as `\/`.
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
        /// `application/x-www-form-urlencoded` leaves `A–Z a–z 0–9 * - . _` (and writes a space
        /// as `+`).
        const FORM: &AsciiSet = &NON_ALPHANUMERIC
            .remove(b'*')
            .remove(b'-')
            .remove(b'.')
            .remove(b'_');
        let mut forms = vec![value.to_string()];
        // A server that form-decodes the query reads `+` as a space.
        if value.contains('+') {
            forms.push(value.replace('+', " "));
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
        forms.push(
            utf8_percent_encode(value, FORM)
                .to_string()
                .replace("%20", "+"),
        );
        let lower: Vec<String> = forms
            .iter()
            .filter(|f| f.contains('%'))
            .map(|f| lowercase_hex(f))
            .collect();
        forms.extend(lower);
        // Inside a JSON string (`"…"` stripped): an echo endpoint escapes `"` and `\`, and some
        // encoders (PHP's `json_encode`) also `/`.
        let mut json_forms = Vec::new();
        for f in &forms {
            if let Ok(quoted) = serde_json::to_string(f) {
                let inner = quoted[1..quoted.len() - 1].to_string();
                if inner.contains('/') {
                    json_forms.push(inner.replace('/', "\\/"));
                }
                json_forms.push(inner);
            }
        }
        forms.extend(json_forms);
        forms.retain(|f| f.chars().count() >= Self::MIN_LEN);
        forms.sort();
        forms.dedup();
        forms
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    /// `text` with every known value (in every spelling) replaced.
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

/// `%2f` for `%2F`: the hex digits of every percent-escape in lowercase.
fn lowercase_hex(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && b[i + 1].is_ascii_hexdigit()
            && b[i + 2].is_ascii_hexdigit()
        {
            out.extend_from_slice(&[
                b'%',
                b[i + 1].to_ascii_lowercase(),
                b[i + 2].to_ascii_lowercase(),
            ]);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// An engine error for a send, safe to hand an agent: every value `redactor` knows is replaced,
/// and every URL in it (`scheme://…`) is passed through [`redact_url`]. For an agent's own
/// request `redactor` is empty, and only the URLs are masked (by shape, never by value).
///
/// A URL is found on the text as given, before the redactor runs: a substituted value can be
/// the URL's whole base (`BASE=https://api.internal:8443`), and once that reads `{{BASE}}` the
/// scheme that marks the URL is gone — while a credential typed into its query is still there.
pub fn scrub(text: &str, redactor: &Redactor) -> String {
    let mut out = String::with_capacity(text.len());
    for (is_url, piece) in split_urls(text) {
        let piece = redactor.apply(piece);
        if is_url {
            out.push_str(&redact_url(&piece));
        } else {
            out.push_str(&piece);
        }
    }
    // A value that straddles a URL's edge.
    redactor.apply(&out)
}

/// Is `name` (a query or fragment parameter, or a header) a credential by its name?
/// Percent-escapes in the name are decoded first; case and punctuation do not count.
pub fn secret_param(name: &str) -> bool {
    let decoded = percent_encoding::percent_decode_str(name).decode_utf8_lossy();
    let n: String = decoded
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    // `pass` and `pw` count as a whole name or at a name's end (`pass`, `db_pass`, `adminpw`),
    // not anywhere in it (`passenger`, `pwa`).
    ["key", "pass", "pw"].iter().any(|w| n.ends_with(w))
        || ["sig", "code", "sid", "otp", "cookie"].contains(&n.as_str())
        || [
            "token",
            "secret",
            "password",
            "passwd",
            "pwd",
            "passphrase",
            "passcode",
            "privatekey",
            "auth",
            "signature",
            "credential",
            "session",
            "jwt",
            "bearer",
            "assertion",
        ]
        .iter()
        .any(|w| n.contains(w))
}

/// Is `value` exactly one `{{NAME}}` reference (safe to show: it names, it does not reveal)?
fn is_ref(value: &str) -> bool {
    crate::db::secret::is_ref(value)
}

/// Is this piece of a URL a credential to hide: non-empty and not a `{{NAME}}`?
fn hidden(value: &str) -> bool {
    !value.is_empty() && !is_ref(value)
}

/// The schemes the URL parser (WHATWG's, which reqwest uses) calls special: after `scheme:`, any
/// run of `/` and `\` leads to the authority — `https:/key@h`, `https:///key@h` and
/// `https:\\key@h` all send the userinfo `key` — and a `\` ends the authority as a `/` does.
/// (`file` is special too, but has no userinfo.)
const SPECIAL_SCHEMES: [&str; 5] = ["http", "https", "ws", "wss", "ftp"];

/// Where the scheme of `text` ends: the index of the `:` after a letter and then letters,
/// digits, `+`, `-` or `.`. `None` when `text` does not start with a scheme.
fn scheme_end(text: &str) -> Option<usize> {
    let mut chars = text.char_indices();
    if !chars.next()?.1.is_ascii_alphabetic() {
        return None;
    }
    for (i, c) in chars {
        match c {
            ':' => return Some(i),
            c if c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.') => {}
            _ => return None,
        }
    }
    None
}

/// `url` as the URL parser reads it before cutting it up: ASCII tabs and newlines removed
/// wherever they are, C0 controls and spaces trimmed from both ends (`" https:/\t/key@h"` sends
/// the userinfo `key` just as `https://key@h` does).
fn parser_view(url: &str) -> std::borrow::Cow<'_, str> {
    let trimmed = url.trim_matches(|c: char| c <= ' ');
    if trimmed.contains(['\t', '\n', '\r']) {
        std::borrow::Cow::Owned(trimmed.replace(['\t', '\n', '\r'], ""))
    } else {
        std::borrow::Cow::Borrowed(trimmed)
    }
}

/// A URL cut where its credentials can be: `head` (`https://`, `https:/`, `https:`, or empty),
/// the userinfo before the authority's last `@`, the rest of the authority, the path, the query,
/// the fragment.
struct UrlParts<'a> {
    head: &'a str,
    userinfo: Option<&'a str>,
    host: &'a str,
    path: &'a str,
    query: Option<&'a str>,
    fragment: Option<&'a str>,
}

/// Works on text, so a URL built from `{{HOST}}` (not parseable) is cut the same way. Cut as
/// the URL parser cuts it (give it [`parser_view`]'s text): wherever the parser finds a
/// userinfo, this does too.
fn url_parts(url: &str) -> UrlParts<'_> {
    let (before_frag, fragment) = match url.find('#') {
        Some(i) => (&url[..i], Some(&url[i + 1..])),
        None => (url, None),
    };
    let (base, query) = match before_frag.find('?') {
        Some(i) => (&before_frag[..i], Some(&before_frag[i + 1..])),
        None => (before_frag, None),
    };
    let (head, authority_and_path, special) = match scheme_end(base) {
        Some(c) if SPECIAL_SCHEMES.contains(&base[..c].to_ascii_lowercase().as_str()) => {
            let slashes = base[c + 1..]
                .bytes()
                .take_while(|b| matches!(b, b'/' | b'\\'))
                .count();
            let (head, rest) = base.split_at(c + 1 + slashes);
            (head, rest, true)
        }
        Some(c) if base[c + 1..].starts_with("//") => {
            let (head, rest) = base.split_at(c + 3);
            (head, rest, false)
        }
        // No scheme (a gRPC endpoint, `token@grpc.example:443`, `user:pw@db:5432`): the
        // authority is what comes first.
        _ => ("", base, false),
    };
    // The userinfo ends at the authority's last `@`; the authority at the first `/` (or `\`).
    let auth_end = authority_and_path
        .find(|c| c == '/' || (special && c == '\\'))
        .unwrap_or(authority_and_path.len());
    let (authority, path) = authority_and_path.split_at(auth_end);
    let (userinfo, host) = match authority.rfind('@') {
        Some(at) => (Some(&authority[..at]), &authority[at + 1..]),
        None => (None, authority),
    };
    UrlParts {
        head,
        userinfo,
        host,
        path,
        query,
        fragment,
    }
}

/// The credentials in the path of a well-known URL, as byte ranges of `path`. The webhook URLs
/// Slack and Discord hand out are their own credential (`hooks.slack.com/services/T…/B…/<secret>`,
/// `discord.com/api/webhooks/<id>/<token>`), and a Telegram bot call carries the bot's token
/// (`api.telegram.org/bot<token>/getMe`, `…/file/bot<token>/…`). A `{{NAME}}` piece stays.
fn path_secrets(host: &str, path: &str) -> Vec<std::ops::Range<usize>> {
    let host = percent_encoding::percent_decode_str(host)
        .decode_utf8_lossy()
        .to_ascii_lowercase();
    let host = match host.rsplit_once(':') {
        Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => host.as_str(),
    };
    let host = host.trim_end_matches('.');
    let mut segments: Vec<std::ops::Range<usize>> = Vec::new();
    let mut start = 0;
    for (i, c) in path.char_indices().chain([(path.len(), '/')]) {
        if c == '/' || c == '\\' {
            if i > start {
                segments.push(start..i);
            }
            start = i + 1;
        }
    }
    let text = |r: &std::ops::Range<usize>| &path[r.clone()];
    let mut out: Vec<std::ops::Range<usize>> = match host {
        // Everything after `/services/` (or `/workflows/`, `/triggers/`).
        "hooks.slack.com" | "hooks.slack-gov.com" => segments.iter().skip(1).cloned().collect(),
        h if ["discord.com", "discordapp.com"]
            .iter()
            .any(|d| h == *d || h.ends_with(&format!(".{d}"))) =>
        {
            match segments
                .iter()
                .position(|r| text(r).eq_ignore_ascii_case("webhooks"))
            {
                Some(i) => segments[i + 1..].to_vec(),
                None => Vec::new(),
            }
        }
        "api.telegram.org" => segments
            .iter()
            .filter(|r| {
                r.len() > 3
                    && text(r)
                        .get(..3)
                        .is_some_and(|b| b.eq_ignore_ascii_case("bot"))
            })
            .map(|r| r.start + 3..r.end)
            .collect(),
        _ => Vec::new(),
    };
    out.retain(|r| hidden(text(r)));
    out
}

/// `k=v` pairs separated by `&` or `;`, in order, separators kept.
fn params(text: &str) -> Vec<(&str, Option<char>)> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if c == '&' || c == ';' {
            out.push((&text[start..i], Some(c)));
            start = i + 1;
        }
    }
    out.push((&text[start..], None));
    out
}

/// The credentials in `url`: the user and the password of its userinfo, the value of every
/// credential-named query or fragment parameter, and the credential in a well-known webhook or
/// bot URL's path — each as written and percent-decoded, and skipping `{{NAME}}` references
/// (they name, they do not reveal).
pub fn url_secrets(url: &str) -> Vec<String> {
    let url = parser_view(url);
    let p = url_parts(&url);
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: &str| {
        if hidden(v) {
            out.push(v.to_string());
            let decoded = percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned();
            if decoded != v {
                out.push(decoded);
            }
        }
    };
    if let Some(ui) = p.userinfo {
        match ui.split_once(':') {
            Some((user, pw)) => {
                push(user);
                push(pw);
            }
            None => push(ui),
        }
    }
    for r in path_secrets(p.host, p.path) {
        push(&p.path[r]);
    }
    for part in [p.query, p.fragment].into_iter().flatten() {
        for (pair, _) in params(part) {
            if let Some((k, v)) = pair.split_once('=') {
                if secret_param(k) {
                    push(v);
                }
            }
        }
    }
    out
}

/// A URL as written, safe to show an agent: every piece of its userinfo (`user:password@`,
/// `token@`, `token:@`, also in the spellings the URL parser accepts: `https:/key@h`,
/// `https:///key@h`, `https:\\key@h`), the value of every credential-named query or fragment
/// parameter (`?api_key=…`, `#access_token=…`, `;sid=…`) and the credential in a well-known
/// webhook or bot URL's path ([`path_secrets`]) become `***`, unless they are a `{{NAME}}`
/// reference. Works on text, so a URL built from `{{HOST}}` (not parseable) is handled the
/// same. Tabs and newlines are dropped and the ends trimmed, as the URL parser does.
pub fn redact_url(url: &str) -> String {
    let url = parser_view(url);
    let p = url_parts(&url);
    let mask = |v: &str| if hidden(v) { MASK } else { v }.to_string();
    let mut out = String::with_capacity(url.len());
    out.push_str(p.head);
    if let Some(ui) = p.userinfo {
        match ui.split_once(':') {
            Some((user, pw)) => {
                out.push_str(&mask(user));
                out.push(':');
                out.push_str(&mask(pw));
            }
            None => out.push_str(&mask(ui)),
        }
        out.push('@');
    }
    out.push_str(p.host);
    let mut at = 0;
    for r in path_secrets(p.host, p.path) {
        out.push_str(&p.path[at..r.start]);
        out.push_str(MASK);
        at = r.end;
    }
    out.push_str(&p.path[at..]);
    let masked_params = |text: &str| -> String {
        let mut s = String::with_capacity(text.len());
        for (pair, sep) in params(text) {
            match pair.split_once('=') {
                Some((k, v)) if secret_param(k) && hidden(v) => {
                    s.push_str(k);
                    s.push('=');
                    s.push_str(MASK);
                }
                _ => s.push_str(pair),
            }
            if let Some(c) = sep {
                s.push(c);
            }
        }
        s
    };
    if let Some(q) = p.query {
        out.push('?');
        out.push_str(&masked_params(q));
    }
    if let Some(f) = p.fragment {
        out.push('#');
        out.push_str(&masked_params(f));
    }
    out
}

/// `text` with every URL in it passed through [`redact_url`] ([`scrub`] with nothing else to
/// replace). An engine error names the URL it failed on; a credential in it must not come back
/// to an agent.
pub fn redact_urls_in(text: &str) -> String {
    scrub(text, &Redactor::default())
}

/// What kind of failure a recorded error is, read from the fixed words the engines start their
/// sentences with (the HTTP engine's checks and `map_send_error`, the gRPC engine's call
/// errors) — never from the rest, which can quote the request as sent (`{{VAR}}`s substituted),
/// a host, or a server's message. `api history` shows an agent this, never the error's text.
pub fn failure_kind(error: &str) -> &'static str {
    const KINDS: [(&str, &str); 9] = [
        ("request timed out", "timeout"),
        ("could not connect", "connection error"),
        ("grpc channel not ready", "connection error"),
        ("tls configuration failed", "TLS error"),
        ("too many redirects", "redirect error"),
        ("invalid request: error sending request", "send error"),
        ("invalid ", "invalid request"),
        ("error decoding response body", "response error"),
        ("request or response body error", "response error"),
    ];
    let head = error
        .trim_start()
        .chars()
        .take(64)
        .collect::<String>()
        .to_ascii_lowercase();
    KINDS
        .iter()
        .find(|(start, _)| head.starts_with(start))
        .map_or("request failed", |(_, kind)| kind)
}

/// The reason phrase for a recorded status, from the number alone: HTTP's canonical phrase
/// (`404` → `Not Found`), or the gRPC code's name (`16` → `Unauthenticated`). A recorded status
/// text can carry a server's message (a gRPC entry's is `<name>: <grpc-message>`), so it is
/// never handed back as recorded.
pub fn status_reason(grpc: bool, status: u16) -> Option<&'static str> {
    if grpc {
        Some(crate::grpc::status_name_for(u32::from(status)))
    } else {
        reqwest::StatusCode::from_u16(status)
            .ok()?
            .canonical_reason()
    }
}

/// `text` cut into pieces, each `(is_url, piece)`, in order. A URL is `scheme://` and what
/// follows up to whitespace or a quote, less trailing punctuation that closes the sentence
/// around it (`for url (https://…)`): one character of a credential that ends in `)` is all
/// that can stay outside.
fn split_urls(text: &str) -> Vec<(bool, &str)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        // Back to where the scheme starts: letters, digits, `+ . -`, starting with a letter.
        let mut start = i;
        for (j, c) in rest[..i].char_indices().rev() {
            if c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-') {
                start = j;
            } else {
                break;
            }
        }
        while start < i && !rest[start..].starts_with(|c: char| c.is_ascii_alphabetic()) {
            start += 1;
        }
        let mut end = rest[i + 3..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '<' | '>' | '`'))
            .map_or(rest.len(), |e| i + 3 + e);
        while end > i + 3 && rest[..end].ends_with([')', ']', ',', '.', ';', '\'']) {
            end -= 1;
        }
        if start > 0 {
            out.push((false, &rest[..start]));
        }
        out.push((true, &rest[start..end]));
        rest = &rest[end..];
    }
    if !rest.is_empty() {
        out.push((false, rest));
    }
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

/// A response's size for a reply: `1.5 KB`, or `over 8.0 MB` when the API client cut the body
/// (it stopped reading there, so the real size is unknown).
pub fn size_text(r: &HttpResponse) -> String {
    if r.truncated {
        format!("over {}", human_size(crate::http::MAX_BODY_BYTES))
    } else {
        human_size(r.size_bytes)
    }
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
            size_text(r),
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
    let engine_cut = format!(
        "the response is over {} and the API client read no further",
        human_size(crate::http::MAX_BODY_BYTES)
    );
    if cut_here {
        lines.push(format!(
            "[Body truncated: showing the first {} of {} bytes{}{}.]",
            thousands(shown.len()),
            thousands(text.len()),
            if pretty.is_some() {
                " of the re-indented JSON"
            } else {
                ""
            },
            if r.truncated {
                format!("; {engine_cut}")
            } else {
                String::new()
            }
        ));
    } else if r.truncated {
        lines.push(format!("[Body truncated by the API client: {engine_cut}.]"));
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
            size_text(r)
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
