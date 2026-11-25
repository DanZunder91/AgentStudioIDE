//! `curl …` → the parts of an HTTP request, for `http send --curl` / `http open --curl`.
//!
//! A port of the API client's cURL import (`src/features/api/curlParse.ts`) for the one dialect
//! an agent's shell writes: bash quoting (single quotes, `$'…'`, double quotes, backslash escapes
//! and line continuations), bundled short flags (`-sX POST`), attached values (`-XPOST`,
//! `-H'A: b'`) and `--flag=value`. The flags it models are the import's — `-X`, `-H`, `--url`,
//! `-d`/`--data*`, `-u`, `-b`, `-g` — and the rules for choosing the URL and the method are the
//! same.
//!
//! Where an agent is concerned it goes further than the paste box, because a request that is
//! quietly different from the command that described it is worse than a refusal:
//! * a form upload (`-F`), a file upload (`-T`), a body read from a file or stdin (`-d @file`),
//!   headers read from a file (`-H @file`), cookies read from a file (`-b <file>`) and a config
//!   file (`-K`) are **refused** with a sentence, not dropped;
//! * `--json`, `-G`/`--get`, `-I`/`--head`, `-A`/`--user-agent`, `-e`/`--referer`,
//!   `--oauth2-bearer` and `-m`/`--max-time` are read, and `--data-urlencode` encodes like curl.

use base64::Engine as _;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// What a curl command asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCurl {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// `-m` / `--max-time`, in milliseconds.
    pub timeout_ms: Option<u64>,
}

/// Does `text` start like a curl command (`curl` or `curl.exe`, then whitespace)?
pub fn is_curl_command(text: &str) -> bool {
    let t = text.trim_start();
    let lower = t.get(..8).unwrap_or(t).to_ascii_lowercase();
    let rest = if lower.starts_with("curl.exe") {
        &t[8..]
    } else if lower.starts_with("curl") {
        &t[4..]
    } else {
        return false;
    };
    rest.starts_with(char::is_whitespace)
}

/// bash's `$'…'` single-character escapes.
fn ansi_c_escape(c: char) -> Option<char> {
    Some(match c {
        '\\' => '\\',
        '\'' => '\'',
        '"' => '"',
        '?' => '?',
        'a' => '\x07',
        'b' => '\x08',
        'e' | 'E' => '\x1b',
        'f' => '\x0c',
        'n' => '\n',
        'r' => '\r',
        't' => '\t',
        'v' => '\x0b',
        _ => return None,
    })
}

/// Read a `$'…'` string from just past its `$'`; returns the text and the index after the
/// closing quote. An escape bash does not define stays as typed, backslash included.
fn read_ansi_c(s: &[char], start: usize) -> (String, usize) {
    let mut i = start;
    let mut text = String::new();
    while i < s.len() && s[i] != '\'' {
        if s[i] != '\\' || i + 1 >= s.len() {
            text.push(s[i]);
            i += 1;
            continue;
        }
        let e = s[i + 1];
        let width = match e {
            'x' => 2,
            'u' => 4,
            'U' => 8,
            _ => 0,
        };
        let digits: String = s[i + 2..]
            .iter()
            .take(width)
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        if !digits.is_empty() {
            if let Some(c) = u32::from_str_radix(&digits, 16)
                .ok()
                .and_then(char::from_u32)
            {
                text.push(c);
            }
            i += 2 + digits.len();
        } else {
            match ansi_c_escape(e) {
                Some(c) => text.push(c),
                None => {
                    text.push('\\');
                    text.push(e);
                }
            }
            i += 2;
        }
    }
    (text, i + 1)
}

/// Split a command line into words the way bash would, quotes removed.
pub fn tokenize(input: &str) -> Vec<String> {
    let s: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c == '$' && s.get(i + 1) == Some(&'\'') {
            let (text, end) = read_ansi_c(&s, i + 2);
            cur.push_str(&text);
            started = true;
            i = end;
        } else if c == '\\' && s.get(i + 1) == Some(&'\n') {
            i += 2;
        } else if c == '\\' && i + 1 < s.len() {
            cur.push(s[i + 1]);
            started = true;
            i += 2;
        } else if c == '\'' {
            started = true;
            i += 1;
            while i < s.len() && s[i] != '\'' {
                cur.push(s[i]);
                i += 1;
            }
            i += 1;
        } else if c == '"' {
            started = true;
            i += 1;
            while i < s.len() && s[i] != '"' {
                if s[i] == '\\' && i + 1 < s.len() {
                    cur.push(s[i + 1]);
                    i += 2;
                } else {
                    cur.push(s[i]);
                    i += 1;
                }
            }
            i += 1;
        } else if c.is_whitespace() {
            if started {
                tokens.push(std::mem::take(&mut cur));
                started = false;
            }
            i += 1;
        } else {
            cur.push(c);
            started = true;
            i += 1;
        }
    }
    if started {
        tokens.push(cur);
    }
    tokens
}

/// Short flags that take a value: the ones read below, and ones only consumed so their value is
/// never mistaken for the URL (`curl -o out.json https://…`).
const SHORT_WITH_VALUE: &str = "XHduAbcCDEFKmoPQrtTUwxyYze";

/// Long flags that take a value but change nothing this client models (output files, TLS and
/// proxy settings, retries): consumed so their value is never taken for the URL.
const LONG_CONSUMED: &[&str] = &[
    "--output",
    "--connect-timeout",
    "--cookie-jar",
    "--proxy",
    "--proxy-user",
    "--noproxy",
    "--write-out",
    "--retry",
    "--retry-delay",
    "--retry-max-time",
    "--cacert",
    "--capath",
    "--cert",
    "--cert-type",
    "--key",
    "--key-type",
    "--resolve",
    "--connect-to",
    "--limit-rate",
    "--max-redirs",
    "--interface",
    "--dns-servers",
    "--range",
    "--continue-at",
    "--trace",
    "--trace-ascii",
    "--stderr",
    "--proto",
    "--proto-redir",
    "--ciphers",
    "--tls-max",
    "--unix-socket",
];

/// One token per flag and one per value: `-sX POST` → `-s -X POST`, `-XPOST` → `-X POST`,
/// `--request=POST` → `--request POST`. Within a bundle each letter is a boolean until one takes
/// a value; that flag claims the rest of the token, or the next token when the rest is empty.
pub fn normalize_flags(tokens: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(tokens.len());
    for tok in tokens {
        if let Some(long) = tok.strip_prefix("--") {
            match long.find('=') {
                Some(eq) if eq > 0 => {
                    out.push(format!("--{}", &long[..eq]));
                    out.push(long[eq + 1..].to_string());
                }
                _ => out.push(tok),
            }
            continue;
        }
        if !tok.starts_with('-') || tok == "-" {
            out.push(tok);
            continue;
        }
        let letters: Vec<char> = tok.chars().skip(1).collect();
        for (i, letter) in letters.iter().enumerate() {
            out.push(format!("-{letter}"));
            if SHORT_WITH_VALUE.contains(*letter) {
                let rest: String = letters[i + 1..].iter().collect();
                if !rest.is_empty() {
                    out.push(rest);
                }
                break;
            }
        }
    }
    out
}

/// `Name: value`, or `Name;` (curl's spelling of an empty value). `None` without a separator.
fn split_header(raw: &str) -> Option<(String, String)> {
    match raw.find(':') {
        Some(idx) if idx > 0 => Some((
            raw[..idx].trim().to_string(),
            raw[idx + 1..].trim().to_string(),
        )),
        _ => {
            let name = raw.strip_suffix(';').map(str::trim).unwrap_or("");
            (!name.is_empty()).then(|| (name.to_string(), String::new()))
        }
    }
}

/// A scheme (`https://`) at the start: what makes a word a better URL candidate than a stray one.
fn looks_like_url(tok: &str) -> bool {
    let Some(idx) = tok.find("://") else {
        return false;
    };
    let scheme = &tok[..idx];
    scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// What curl leaves unescaped in `--data-urlencode`: letters, digits and `-._~`.
const URLENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// `--data-urlencode`'s forms: `content`, `=content`, `name=content` (the content is encoded,
/// the name is not). `@file` forms are refused by the caller.
fn data_urlencode(v: &str) -> String {
    let enc = |s: &str| utf8_percent_encode(s, URLENCODE).to_string();
    match v.find('=') {
        Some(0) => enc(&v[1..]),
        Some(i) => format!("{}={}", &v[..i], enc(&v[i + 1..])),
        None => enc(v),
    }
}

fn refuse_file(flag: &str) -> String {
    format!(
        "That curl command reads its body from a file or stdin ({flag} @…). Agent Studio does \
         not read files for a request: put the content in the command (--data-raw '…'), or use \
         --body."
    )
}

/// Parse a curl command (a leading `curl` is optional). `Err` is a sentence for the agent.
pub fn parse(input: &str) -> Result<ParsedCurl, String> {
    let text = input.trim().replace("\r\n", "\n");
    let mut words = tokenize(&text);
    if words
        .first()
        .is_some_and(|w| w.eq_ignore_ascii_case("curl") || w.eq_ignore_ascii_case("curl.exe"))
    {
        words.remove(0);
    }
    let tokens = normalize_flags(words);

    let mut method: Option<String> = None;
    let mut url: Option<String> = None;
    let mut data: Vec<String> = Vec::new();
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut cookie: Option<usize> = None;
    let mut glob_off = false;
    let mut get = false;
    let mut head = false;
    let mut json = false;
    let mut timeout_ms = None;

    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i].as_str();
        i += 1;
        let value = tokens.get(i).cloned();
        let mut take = || {
            i += 1;
            value.clone()
        };
        match tok {
            "-X" | "--request" => method = take().or(method),
            "-H" | "--header" => {
                let Some(v) = take() else { continue };
                if v.starts_with('@') {
                    return Err(
                        "That curl command reads its headers from a file or stdin (-H @…). \
                         Agent Studio does not read files for a request: write each header \
                         out (-H 'Name: value')."
                            .to_string(),
                    );
                }
                if let Some(h) = split_header(&v) {
                    headers.push(h);
                }
            }
            "--url" => url = take().or(url),
            "-d" | "--data" | "--data-ascii" | "--data-binary" | "--data-raw" | "--json"
            | "--data-urlencode" => {
                let Some(v) = take() else { continue };
                if tok != "--data-raw" && v.starts_with('@') {
                    return Err(refuse_file(tok));
                }
                if tok == "--data-urlencode" && v.split_once('=').is_none() && v.contains('@') {
                    return Err(refuse_file(tok));
                }
                if tok == "--data-urlencode" {
                    data.push(data_urlencode(&v));
                } else {
                    json |= tok == "--json";
                    data.push(v);
                }
            }
            "-u" | "--user" => {
                if let Some(v) = take() {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(v.as_bytes());
                    headers.push(("Authorization".into(), format!("Basic {b64}")));
                }
            }
            "--oauth2-bearer" => {
                if let Some(v) = take() {
                    headers.push(("Authorization".into(), format!("Bearer {v}")));
                }
            }
            "-A" | "--user-agent" => {
                if let Some(v) = take() {
                    headers.push(("User-Agent".into(), v));
                }
            }
            "-e" | "--referer" => {
                if let Some(v) = take() {
                    headers.push(("Referer".into(), v));
                }
            }
            "-b" | "--cookie" => {
                // Without `=` curl reads the value as a cookie FILE (`-` is stdin).
                let Some(v) = take() else { continue };
                if !v.contains('=') && !v.trim().is_empty() {
                    return Err(format!(
                        "That curl command reads cookies from a file (-b {}). Agent Studio \
                         does not read files for a request: write the cookies out \
                         (-b 'name=value; other=value').",
                        super::report::short_to(&v, 80)
                    ));
                }
                if v.contains('=') {
                    match cookie {
                        Some(at) => {
                            headers[at].1.push_str("; ");
                            headers[at].1.push_str(&v);
                        }
                        None => {
                            cookie = Some(headers.len());
                            headers.push(("Cookie".into(), v));
                        }
                    }
                }
            }
            "-m" | "--max-time" => {
                if let Some(v) = take() {
                    let secs: f64 = v
                        .parse()
                        .map_err(|_| format!("--max-time takes seconds, not `{v}`."))?;
                    timeout_ms = Some((secs * 1000.0).max(1.0) as u64);
                }
            }
            "-F" | "--form" | "--form-string" => {
                return Err(
                    "That curl command uploads a form (-F/--form). Agent Studio's API \
                            client does not send multipart forms; send the body with -d or --body."
                        .to_string(),
                )
            }
            "-T" | "--upload-file" => {
                return Err(
                    "That curl command uploads a file (-T/--upload-file). Agent Studio \
                            does not read files for a request: put the content in --body."
                        .to_string(),
                )
            }
            "-K" | "--config" => {
                return Err(
                    "That curl command reads a config file (-K/--config), which Agent \
                            Studio does not read. Write the options out in the command."
                        .to_string(),
                )
            }
            "-g" | "--globoff" => glob_off = true,
            "-G" | "--get" => get = true,
            "-I" | "--head" => head = true,
            _ if tok.len() == 2 && tok.starts_with('-') && SHORT_WITH_VALUE.contains(&tok[1..]) => {
                i += 1;
            }
            _ if LONG_CONSUMED.contains(&tok) => i += 1,
            _ if tok.starts_with('-') && tok != "-" => {}
            _ => {
                let better = url
                    .as_deref()
                    .is_some_and(|u| !looks_like_url(u) && looks_like_url(tok));
                if url.is_none() || better {
                    url = Some(tok.to_string());
                }
            }
        }
    }

    let Some(mut url) = url else {
        return Err("That curl command has no URL.".to_string());
    };
    if !glob_off {
        // curl reads `[ ] { }` as a glob unless escaped, and strips the escape before sending.
        for c in ['[', ']', '{', '}'] {
            url = url.replace(&format!("\\{c}"), &c.to_string());
        }
    }
    let mut body = (!data.is_empty()).then(|| data.join("&"));
    if get {
        if let Some(q) = body.take() {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(&q);
        }
    }
    if json {
        let has = |n: &str| headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(n));
        let (content_type, accept) = (has("content-type"), has("accept"));
        if !content_type {
            headers.push(("Content-Type".into(), "application/json".into()));
        }
        if !accept {
            headers.push(("Accept".into(), "application/json".into()));
        }
    }
    let method = match method {
        Some(m) => m,
        None if head => "HEAD".into(),
        None if body.is_some() => "POST".into(),
        None => "GET".into(),
    };
    Ok(ParsedCurl {
        method: method.to_ascii_uppercase(),
        url,
        headers,
        body,
        timeout_ms,
    })
}

#[cfg(test)]
#[path = "http_curl_tests.rs"]
mod tests;
