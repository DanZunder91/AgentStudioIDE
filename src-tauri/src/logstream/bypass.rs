//! Proxy-bypass detection on an agent's Bash commands (requirement: every `curl` an
//! agent runs in the IDE must be logged in Network).
//!
//! The `curl` shim ([`crate::netcap::shim`]) undoes a curl's own bypass, but not
//! `NO_PROXY='*' python3 x.py`, `unset HTTPS_PROXY; node …` or `env -u HTTP_PROXY …`. Those
//! cannot be undone from outside the process — so they are **reported**: the transcript tool
//! tail ([`crate::agent::tools`]) runs every Bash command through [`detect`], and a hit becomes
//! a `bypass` row in Network ([`crate::netcap::Netcap::record_bypass`]). Nothing goes missing
//! silently.
//!
//! Pure and quote-aware: the words come from the same small shell lexer the task tail uses
//! ([`super::tasks::simple_command_words`]), so `-x ''` is `-x` + an empty word and a
//! separator inside a string does not split a command. `$(…)` words and `sh -c '…'` bodies
//! are looked into (depth-capped).

use super::tasks::simple_command_words;

/// Where a detected bypass was going — what the Network row shows in its Method / Host / Path
/// columns. Read from a curl's own arguments ([`curl_target`]) when the command has a curl; else
/// from the first `http(s)://` URL anywhere in the command ([`url_target`]: `python3 -c
/// 'urlopen("http://…")'`, `node -e "fetch('https://…')"`, `wget --no-proxy http://…`) —
/// without it a python bypass row would read `—` / `—` in Method and Host. The name
/// stays `CurlTarget` because the wire and `netcap` already carry it as `curl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurlTarget {
    pub method: String,
    /// The URL as written in the command (what the Network row's `bypass.url` shows).
    pub url: String,
    pub https: bool,
    pub host: String,
    pub port: u16,
    /// Path + query (`/` when the URL has none).
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    /// What bypassed, in command order, each once (the wire's `reasons`).
    pub reasons: Vec<String>,
    /// Every reason sits on a curl and is one the shim undoes (`--noproxy`, `-x ''`, an
    /// inline `NO_PROXY=*`) — with strict capture on, the request was captured after all.
    pub shim_covers: bool,
    /// The first curl of the command that bypassed (else the first curl at all); with no curl,
    /// the command's first `http(s)://` URL ([`url_target`]).
    pub curl: Option<CurlTarget>,
}

pub const R_NOPROXY: &str = "--noproxy";
pub const R_EMPTY_PROXY_ARG: &str = "-x ''";
pub const R_NO_PROXY_STAR: &str = "NO_PROXY=*";
pub const R_NO_PROXY_SET: &str = "NO_PROXY=";
pub const R_EMPTY_PROXY_VAR: &str = "*_PROXY=''";
pub const R_UNSET: &str = "unset *_proxy";
pub const R_ENV_U: &str = "env -u *_proxy";
pub const R_ENV_I: &str = "env -i";
pub const R_WGET_NO_PROXY: &str = "--no-proxy";
/// A PowerShell tool call that makes a web request with Windows PowerShell 5.1's own HTTP stack
/// (`Invoke-WebRequest`, `Invoke-RestMethod`, `iwr`, `irm`, 5.1's `curl`/`wget` aliases, .NET's
/// `WebClient` / `HttpClient` / `WebRequest`, `Start-BitsTransfer`), which ignores
/// `HTTP(S)_PROXY` — see [`detect_powershell`].
pub const R_PS51_WEB: &str = "PowerShell 5.1 web cmdlet";
/// PowerShell 7's `Invoke-WebRequest -NoProxy` / `Invoke-RestMethod -NoProxy`.
pub const R_PS_NOPROXY: &str = "-NoProxy";

/// What the curl shim undoes when it is on a curl's own simple command.
const SHIM_UNDOES: &[&str] = &[R_NOPROXY, R_EMPTY_PROXY_ARG, R_NO_PROXY_STAR];

/// How deep `$(…)` / `sh -c` bodies are followed.
const MAX_DEPTH: usize = 3;

/// `None` = the command does not route around the proxy.
pub fn detect(command: &str) -> Option<Detected> {
    let mut found: Vec<(&'static str, bool)> = Vec::new();
    let mut curls: Vec<(CurlTarget, bool)> = Vec::new();
    scan(command, 0, &mut found, &mut curls);
    if found.is_empty() {
        return None;
    }
    let mut reasons: Vec<String> = Vec::new();
    for (r, _) in &found {
        if !reasons.iter().any(|x| x == r) {
            reasons.push((*r).to_string());
        }
    }
    let shim_covers = found
        .iter()
        .all(|(r, on_curl)| *on_curl && SHIM_UNDOES.contains(r));
    let curl = curls
        .iter()
        .find(|(_, bypassed)| *bypassed)
        .or(curls.first())
        .map(|(c, _)| c.clone())
        .or_else(|| url_target(command));
    Some(Detected {
        reasons,
        shim_covers,
        curl,
    })
}

/// Proxy-bypass detection on a **PowerShell** tool call (Claude Code on Windows has a
/// `PowerShell` tool beside `Bash`; input `{command, description, timeout, run_in_background}`,
/// read from real transcripts).
///
/// That tool is not an IDE terminal: it is a fresh `powershell.exe` / `pwsh.exe -NoProfile` the
/// agent starts, so neither the curl shim nor the terminal's startup command
/// (`pty::POWERSHELL_WEB_PROXY`) reaches it. Its environment does carry the capture proxy, and:
///
/// * **Windows PowerShell 5.1** (`desktop`): the web cmdlets and .NET Framework's `WebClient` /
///   `HttpClient` / `WebRequest` ignore `HTTP(S)_PROXY` (they use the system proxy settings),
///   so every such request bypasses capture → [`R_PS51_WEB`]. In 5.1 `curl` and `wget` are
///   aliases of `Invoke-WebRequest`; `curl.exe` is the real curl and is captured.
/// * **PowerShell 7** reads the proxy variables, so its cmdlets are captured — unless they pass
///   `-NoProxy` → [`R_PS_NOPROXY`].
///
/// Which edition the tool runs is not in the transcript; the caller passes what this machine
/// would run ([`powershell_tool_is_desktop`]). Also reported, on either edition: `$env:NO_PROXY
/// = '*'` (and other values), a `*_PROXY` variable set to empty / `$null`, and `Remove-Item
/// Env:*_PROXY` — and everything [`detect`] finds in the text (`curl.exe --noproxy '*' …`).
/// Never `shim_covers`: no shim runs in that shell.
pub fn detect_powershell(command: &str, desktop: bool) -> Option<Detected> {
    let mut reasons: Vec<&'static str> = Vec::new();
    let mut push = |r: &'static str| {
        if !reasons.contains(&r) {
            reasons.push(r);
        }
    };
    let toks = ps_tokens(command);
    let lower = command.to_ascii_lowercase();
    let mut web = false;
    for (i, t) in toks.iter().enumerate() {
        let at_command =
            i == 0 || matches!(toks[i - 1].as_str(), ";" | "|" | "(" | "{" | "=" | "&");
        // `Microsoft.PowerShell.Utility\Invoke-WebRequest` is the same cmdlet.
        let name = t.rsplit('\\').next().unwrap_or(t).to_ascii_lowercase();
        if at_command {
            match name.as_str() {
                "invoke-webrequest" | "invoke-restmethod" | "iwr" | "irm" => web = true,
                // Aliases of Invoke-WebRequest in 5.1 only; `curl.exe` / `wget.exe` are not.
                "curl" | "wget" if desktop => web = true,
                "start-bitstransfer" => push(R_PS51_WEB),
                _ => {}
            }
        }
        // `$env:NO_PROXY = '*'`, `$env:HTTPS_PROXY = ''` / `$null`.
        if let Some(var) = name.strip_prefix("$env:") {
            if toks.get(i + 1).is_some_and(|n| n == "=") {
                let value = toks.get(i + 2).map(String::as_str).unwrap_or("");
                let empty = value.is_empty() || value.eq_ignore_ascii_case("$null");
                if var == "no_proxy" {
                    if value.trim() == "*" {
                        push(R_NO_PROXY_STAR);
                    } else if !empty {
                        push(R_NO_PROXY_SET);
                    }
                } else if proxy_var(var) && empty {
                    push(R_EMPTY_PROXY_VAR);
                }
            }
        }
        // `Remove-Item Env:HTTPS_PROXY` / `Env:\HTTP_PROXY` (`ri`, `del`, `rm` too).
        if at_command && matches!(name.as_str(), "remove-item" | "ri" | "del" | "rm" | "erase") {
            let unsets = toks[i + 1..]
                .iter()
                .take_while(|w| !matches!(w.as_str(), ";" | "|"))
                .filter_map(|w| {
                    let w = w.to_ascii_lowercase();
                    w.strip_prefix("env:")
                        .map(|v| v.trim_start_matches('\\').to_string())
                })
                .any(|v| proxy_var(&v) || v == "*");
            if unsets {
                push(R_UNSET);
            }
        }
    }
    let dotnet = [
        "net.webclient",
        "net.http.httpclient",
        "net.webrequest]::create",
        "net.httpwebrequest",
    ]
    .iter()
    .any(|k| lower.contains(k));
    if desktop && (web || dotnet) {
        push(R_PS51_WEB);
    } else if web
        && toks
            .iter()
            .any(|t| t.eq_ignore_ascii_case("-noproxy") || t.eq_ignore_ascii_case("-noproxy:$true"))
    {
        push(R_PS_NOPROXY);
    }
    let mut reasons: Vec<String> = reasons.into_iter().map(str::to_string).collect();
    let posix = detect(command);
    if let Some(d) = &posix {
        for r in &d.reasons {
            if !reasons.contains(r) {
                reasons.push(r.clone());
            }
        }
    }
    if reasons.is_empty() {
        return None;
    }
    Some(Detected {
        reasons,
        shim_covers: false,
        curl: posix.and_then(|d| d.curl).or_else(|| url_target(command)),
    })
}

/// A PowerShell command line as words and separators (`;` `|` `(` `)` `{` `}` `=` `&` `,` are
/// tokens of their own). Quote-aware: `'…'` (`''` is a quote) and `"…"` (backtick escapes)
/// are one word without their quotes. Detection only — never executed, never re-joined.
fn ps_tokens(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = command.chars().peekable();
    let flush = |cur: &mut String, quoted: &mut bool, out: &mut Vec<String>| {
        if !cur.is_empty() || *quoted {
            out.push(std::mem::take(cur));
        }
        *quoted = false;
    };
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                quoted = true;
                while let Some(q) = chars.next() {
                    if q == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next();
                            cur.push('\'');
                        } else {
                            break;
                        }
                    } else {
                        cur.push(q);
                    }
                }
            }
            '"' => {
                quoted = true;
                while let Some(q) = chars.next() {
                    match q {
                        '`' => {
                            if let Some(e) = chars.next() {
                                cur.push(e);
                            }
                        }
                        '"' => break,
                        _ => cur.push(q),
                    }
                }
            }
            '`' => {
                if let Some(e) = chars.next() {
                    cur.push(e);
                }
            }
            ';' | '|' | '(' | ')' | '{' | '}' | '=' | '&' | ',' => {
                flush(&mut cur, &mut quoted, &mut out);
                out.push(c.to_string());
            }
            c if c.is_whitespace() => flush(&mut cur, &mut quoted, &mut out),
            c => cur.push(c),
        }
    }
    flush(&mut cur, &mut quoted, &mut out);
    out
}

/// Whether Claude Code's PowerShell tool runs **Windows PowerShell 5.1** on this machine.
/// Measured in the CLI (2.1.328): it takes the first of `%ProgramFiles%\PowerShell\7\pwsh.exe`,
/// `…\7-preview\pwsh.exe`, `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` that
/// exists. So: Windows, and no stock PowerShell 7. Always `false` elsewhere (the tool runs
/// `pwsh` there, which reads the proxy variables). Decided once.
pub fn powershell_tool_is_desktop() -> bool {
    static DESKTOP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DESKTOP.get_or_init(|| {
        cfg!(windows)
            && !std::env::var_os("ProgramFiles").is_some_and(|pf| {
                let pf = std::path::PathBuf::from(pf).join("PowerShell");
                ["7", "7-preview"]
                    .iter()
                    .any(|v| pf.join(v).join("pwsh.exe").is_file())
            })
    })
}

fn basename(w: &str) -> &str {
    w.rsplit('/').find(|s| !s.is_empty()).unwrap_or(w)
}

fn proxy_var(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with("_proxy")
}

/// `NAME=value` with a shell-name `NAME`.
fn assignment(w: &str) -> Option<(&str, &str)> {
    let (name, value) = w.split_once('=')?;
    let mut chars = name.chars();
    let ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some((name, value))
}

fn scan(
    command: &str,
    depth: usize,
    found: &mut Vec<(&'static str, bool)>,
    curls: &mut Vec<(CurlTarget, bool)>,
) {
    for (words, at) in simple_command_words(command) {
        let program = at.map(|i| basename(&words[i]));
        let curl_at = words
            .iter()
            .enumerate()
            .skip(at.unwrap_or(0))
            .find(|(_, w)| basename(w) == "curl")
            .map(|(i, _)| i);
        let on_curl = curl_at.is_some();
        let before = found.len();
        let push = |found: &mut Vec<(&'static str, bool)>, r: &'static str| {
            found.push((r, on_curl));
        };

        let mut i = 0;
        while i < words.len() {
            let w = words[i].as_str();
            let next = words.get(i + 1).map(String::as_str);
            if depth < MAX_DEPTH {
                // `$(…)` anywhere in the word (`out=$(curl …)`, `"$(curl …)"`).
                if let Some(at) = w.find("$(") {
                    let inner = &w[at + 2..];
                    scan(
                        inner.strip_suffix(')').unwrap_or(inner),
                        depth + 1,
                        found,
                        curls,
                    );
                }
            }
            match w {
                "--noproxy" if next.is_some_and(|v| !v.is_empty()) => push(found, R_NOPROXY),
                _ if w.starts_with("--noproxy=") && w.len() > "--noproxy=".len() => {
                    push(found, R_NOPROXY)
                }
                "-x" | "--proxy" if next == Some("") => push(found, R_EMPTY_PROXY_ARG),
                "--proxy=" => push(found, R_EMPTY_PROXY_ARG),
                "--no-proxy" => push(found, R_WGET_NO_PROXY),
                _ => {}
            }
            if let Some((name, value)) = assignment(w) {
                if name.eq_ignore_ascii_case("no_proxy") {
                    if value.trim() == "*" {
                        push(found, R_NO_PROXY_STAR);
                    } else if !value.is_empty() {
                        push(found, R_NO_PROXY_SET);
                    }
                } else if proxy_var(name) && value.is_empty() {
                    push(found, R_EMPTY_PROXY_VAR);
                }
            }
            if basename(w) == "env" && at.is_none_or(|p| i <= p) {
                env_args(&words[i + 1..], found, on_curl);
            }
            i += 1;
        }
        if program == Some("unset") && words.iter().skip(1).any(|w| proxy_var(w)) {
            push(found, R_UNSET);
        }
        // `sh -c '<body>'`, `bash -lc "<body>"`: the body is a command line of its own.
        if depth < MAX_DEPTH
            && program.is_some_and(|p| matches!(p, "sh" | "bash" | "zsh" | "dash" | "ksh"))
        {
            let p = at.unwrap_or(0);
            if let Some(k) = words
                .iter()
                .skip(p + 1)
                .position(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('c'))
            {
                if let Some(body) = words.get(p + 1 + k + 1) {
                    scan(body, depth + 1, found, curls);
                }
            }
        }
        if let Some(c) = curl_at {
            if let Some(t) = curl_target(&words[c + 1..]) {
                curls.push((t, found.len() > before));
            }
        }
    }
}

/// `env`'s own options, up to its program: `-u NAME`, `-uNAME`, `--unset=NAME`, `--unset
/// NAME`, `-i` / `-` / `--ignore-environment`.
fn env_args(rest: &[String], found: &mut Vec<(&'static str, bool)>, on_curl: bool) {
    let mut k = 0;
    while k < rest.len() {
        let w = rest[k].as_str();
        let unset = match w {
            "-u" | "--unset" => {
                k += 1;
                rest.get(k).map(String::as_str)
            }
            _ if w.starts_with("--unset=") => Some(&w["--unset=".len()..]),
            _ if w.starts_with("-u") && w.len() > 2 => Some(&w[2..]),
            "-i" | "-" | "--ignore-environment" => {
                found.push((R_ENV_I, on_curl));
                None
            }
            _ if w.starts_with('-') || assignment(w).is_some() => None,
            _ => return, // the program: env's options are over
        };
        if unset.is_some_and(proxy_var) {
            found.push((R_ENV_U, on_curl));
        }
        k += 1;
    }
}

/// Long curl options that take a value (the next word).
const LONG_WITH_VALUE: &[&str] = &[
    "--request",
    "--header",
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "--data-ascii",
    "--json",
    "--form",
    "--form-string",
    "--output",
    "--proxy",
    "--noproxy",
    "--user",
    "--user-agent",
    "--referer",
    "--max-time",
    "--connect-timeout",
    "--write-out",
    "--cookie",
    "--cookie-jar",
    "--upload-file",
    "--resolve",
    "--connect-to",
    "--cacert",
    "--capath",
    "--cert",
    "--key",
    "--config",
    "--retry",
    "--retry-delay",
    "--retry-max-time",
    "--range",
    "--time-cond",
    "--interface",
    "--unix-socket",
    "--proxy-user",
    "--oauth2-bearer",
    "--aws-sigv4",
    "--variable",
    "--expand-url",
    "--limit-rate",
    "--max-filesize",
    "--output-dir",
    "--dump-header",
    "--trace",
    "--trace-ascii",
    "--stderr",
];
/// Short curl options that take a value — a cluster (`-sSo out`) ending in one takes the
/// next word.
const SHORT_WITH_VALUE: &str = "dFHoxuAemwbcTrzKEXYyCUQtPD";
const DATA_LONG: &[&str] = &[
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "--data-ascii",
    "--json",
    "--form",
    "--form-string",
];

/// Method and URL of a curl from its arguments. `None` = no URL found.
fn curl_target(args: &[String]) -> Option<CurlTarget> {
    let mut method: Option<String> = None;
    let (mut head, mut data, mut upload, mut get) = (false, false, false, false);
    let mut url: Option<&str> = None;
    let mut k = 0;
    while k < args.len() {
        let w = args[k].as_str();
        let next = args.get(k + 1).map(String::as_str);
        if w == "--" {
            if url.is_none() {
                url = next;
            }
            break;
        }
        if let Some(long) = w.strip_prefix("--") {
            let name = format!("--{}", long.split('=').next().unwrap_or(long));
            let inline = long.split_once('=').map(|(_, v)| v);
            let value = if inline.is_some() {
                inline
            } else if LONG_WITH_VALUE.contains(&name.as_str()) || name == "--url" {
                k += 1;
                next
            } else {
                None
            };
            match name.as_str() {
                "--request" => method = value.map(str::to_string),
                "--head" => head = true,
                "--get" => get = true,
                "--upload-file" => upload = true,
                "--url" if url.is_none() => url = value,
                n if DATA_LONG.contains(&n) => data = true,
                _ => {}
            }
        } else if w.len() > 1 && w.starts_with('-') {
            let cluster = &w[1..];
            for (j, ch) in cluster.char_indices() {
                if SHORT_WITH_VALUE.contains(ch) {
                    let attached = &cluster[j + ch.len_utf8()..];
                    let value = if attached.is_empty() {
                        k += 1;
                        next
                    } else {
                        Some(attached)
                    };
                    match ch {
                        'X' => method = value.map(str::to_string),
                        'd' | 'F' => data = true,
                        'T' => upload = true,
                        _ => {}
                    }
                    break;
                }
                match ch {
                    'I' => head = true,
                    'G' => get = true,
                    _ => {}
                }
            }
        } else if url.is_none() {
            url = Some(w);
        }
        k += 1;
    }
    let method = method.unwrap_or_else(|| {
        if head {
            "HEAD"
        } else if get {
            "GET"
        } else if upload {
            "PUT"
        } else if data {
            "POST"
        } else {
            "GET"
        }
        .to_string()
    });
    parse_url(url?, method)
}

/// Where a URL in running text ends: whitespace, a quote, a bracket or a shell separator.
fn url_end(c: char) -> bool {
    c.is_whitespace() || "'\"`()<>[]{}|;\\,".contains(c)
}

/// The first `http://` / `https://` URL anywhere in `command` (any program — python, node,
/// wget, a script's argument), with a best-effort method: an explicit one when the command
/// spells it ([`evident_method`]), else `GET`. `None` = no URL in the text.
fn url_target(command: &str) -> Option<CurlTarget> {
    let lower = command.to_ascii_lowercase();
    let at = [lower.find("http://"), lower.find("https://")]
        .into_iter()
        .flatten()
        .min()?;
    let rest = &command[at..];
    let end = rest.find(url_end).unwrap_or(rest.len());
    // A sentence's full stop is not part of the URL.
    let raw = rest[..end].trim_end_matches(['.', ':']);
    parse_url(raw, evident_method(command))
}

/// HTTP methods a command may name explicitly.
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// The method a non-curl command makes evident, else `GET`: an explicit one (`-X POST`,
/// `--method=PUT`, `method='POST'`, `method: "DELETE"`, `requests.post(`), else `POST` when it
/// sends a body (`data=`, `json=`, `--post-data`, `-d `, `body:`). Heuristic by design — the
/// command is shown verbatim beside it, so a wrong guess is visible, never hidden.
fn evident_method(command: &str) -> String {
    let lower = command.to_ascii_lowercase();
    // `-X POST` / `-XPOST` / `--request POST` (wget's `--method=POST`, httpie-style spellings).
    for key in ["-x", "--request", "--method", "method"] {
        let mut from = 0;
        while let Some(i) = lower[from..].find(key) {
            let start = from + i + key.len();
            from = start;
            // `-x` must be curl-style case: `-X`, not a lower-case proxy flag.
            if key == "-x" && command.as_bytes().get(start - 1) != Some(&b'X') {
                continue;
            }
            let tail = lower[start..].trim_start_matches([' ', '=', ':', '\'', '"']);
            let word: String = tail.chars().take_while(char::is_ascii_alphabetic).collect();
            let upper = word.to_ascii_uppercase();
            if METHODS.contains(&upper.as_str()) {
                return upper;
            }
        }
    }
    // `requests.post(`, `axios.put(`, `httpx.delete(` — a client's method-named call.
    for m in METHODS {
        if lower.contains(&format!(".{}(", m.to_ascii_lowercase())) {
            return (*m).to_string();
        }
    }
    let sends_body = [
        "data=",
        "json=",
        "--post-data",
        "--post-file",
        "body:",
        " -d ",
    ]
    .iter()
    .any(|k| lower.contains(k));
    if sends_body { "POST" } else { "GET" }.to_string()
}

fn parse_url(raw: &str, method: String) -> Option<CurlTarget> {
    let (scheme, rest) = match raw.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ("http".to_string(), raw),
    };
    let https = scheme == "https";
    let cut = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(cut);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        (h.to_string(), after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    if host.is_empty() {
        return None;
    }
    let default = if https { 443 } else { 80 };
    let port = port.and_then(|p| p.parse().ok()).unwrap_or(default);
    let tail = tail.split('#').next().unwrap_or("");
    let path = if tail.is_empty() {
        "/".to_string()
    } else if tail.starts_with('?') {
        format!("/{tail}")
    } else {
        tail.to_string()
    };
    Some(CurlTarget {
        method,
        url: raw.to_string(),
        https,
        host,
        port,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reasons(cmd: &str) -> Vec<String> {
        detect(cmd).map(|d| d.reasons).unwrap_or_default()
    }

    /// A realistic command, as an agent writes it in a typical Rust service repo.
    #[test]
    fn a_real_noproxy_curl_is_a_covered_bypass_with_its_url() {
        let d = detect("curl -s --noproxy '*' http://127.0.0.1:3000/api/v1/health | head -c 300")
            .expect("a bypass");
        assert_eq!(d.reasons, [R_NOPROXY]);
        assert!(d.shim_covers);
        assert_eq!(
            d.curl,
            Some(CurlTarget {
                method: "GET".into(),
                url: "http://127.0.0.1:3000/api/v1/health".into(),
                https: false,
                host: "127.0.0.1".into(),
                port: 3000,
                path: "/api/v1/health".into(),
            })
        );
    }

    #[test]
    fn plain_commands_are_not_bypasses() {
        for cmd in [
            "curl -s http://127.0.0.1:3000/x",
            "curl --noproxy '' -x http://127.0.0.1:9 http://h/",
            "NO_PROXY= curl http://h/",
            "cargo test && git status",
            "echo 'use --noproxy * never'",
            "grep -r no_proxy src/",
        ] {
            assert_eq!(detect(cmd), None, "{cmd}");
        }
    }

    #[test]
    fn every_bypass_spelling_is_named() {
        let cases: &[(&str, &[&str])] = &[
            ("curl --noproxy=localhost http://h/", &[R_NOPROXY]),
            ("curl -x '' http://h/", &[R_EMPTY_PROXY_ARG]),
            ("curl --proxy \"\" http://h/", &[R_EMPTY_PROXY_ARG]),
            ("NO_PROXY='*' python3 probe.py", &[R_NO_PROXY_STAR]),
            ("no_proxy=127.0.0.1,localhost node x.js", &[R_NO_PROXY_SET]),
            ("export NO_PROXY=*; python3 x.py", &[R_NO_PROXY_STAR]),
            ("HTTPS_PROXY= HTTP_PROXY= cargo run", &[R_EMPTY_PROXY_VAR]),
            ("unset HTTP_PROXY HTTPS_PROXY && npm start", &[R_UNSET]),
            ("env -u HTTPS_PROXY -u http_proxy ./gazelle", &[R_ENV_U]),
            ("env --unset=ALL_PROXY python3 a.py", &[R_ENV_U]),
            ("env -i PATH=/bin sh -c 'node x'", &[R_ENV_I]),
            ("wget --no-proxy http://h/", &[R_WGET_NO_PROXY]),
        ];
        for (cmd, want) in cases {
            assert_eq!(reasons(cmd), *want, "{cmd}");
        }
    }

    #[test]
    fn only_a_curls_own_shim_handled_bypass_is_covered() {
        assert!(detect("NO_PROXY='*' curl http://h/").unwrap().shim_covers);
        assert!(
            detect("curl -x '' --noproxy '*' http://h/")
                .unwrap()
                .shim_covers
        );
        // python cannot be shimmed; neither can a bypass exported for later commands.
        assert!(!detect("NO_PROXY='*' python3 x.py").unwrap().shim_covers);
        assert!(
            !detect("export NO_PROXY='*' && curl http://h/")
                .unwrap()
                .shim_covers
        );
        assert!(
            !detect("unset HTTPS_PROXY; curl http://h/")
                .unwrap()
                .shim_covers
        );
        assert!(
            !detect("curl --noproxy '*' a && NO_PROXY='*' node b")
                .unwrap()
                .shim_covers
        );
        let d = detect("curl --noproxy '*' http://a/ && NO_PROXY=x python3 b").unwrap();
        assert_eq!(d.reasons, [R_NOPROXY, R_NO_PROXY_SET]);
    }

    #[test]
    fn nested_bodies_are_looked_into() {
        assert_eq!(
            reasons("bash -lc \"curl --noproxy '*' http://h/\""),
            [R_NOPROXY]
        );
        assert_eq!(
            reasons("out=$(curl -s --noproxy '*' http://h/x); echo $out"),
            [R_NOPROXY]
        );
    }

    #[test]
    fn method_and_url_come_from_curls_arguments() {
        let t = |cmd: &str| detect(cmd).unwrap().curl.unwrap();
        let c = t("curl --noproxy '*' -X POST -H 'content-type: application/json' -d '{\"a\":1}' https://api.example.com:8443/v1/x?y=1#frag");
        assert_eq!(
            (
                c.method.as_str(),
                c.https,
                c.host.as_str(),
                c.port,
                c.path.as_str()
            ),
            ("POST", true, "api.example.com", 8443, "/v1/x?y=1")
        );
        let c = t("curl -sS --noproxy '*' -d @body.json localhost:8080");
        assert_eq!(
            (c.method.as_str(), c.host.as_str(), c.port, c.path.as_str()),
            ("POST", "localhost", 8080, "/")
        );
        let c = t("curl -I --noproxy '*' https://user:pw@[::1]/h");
        assert_eq!(
            (c.method.as_str(), c.host.as_str(), c.port),
            ("HEAD", "::1", 443)
        );
        let c = t("curl -XDELETE -o /dev/null --noproxy '*' --url http://h/r/1");
        assert_eq!((c.method.as_str(), c.path.as_str()), ("DELETE", "/r/1"));
        assert_eq!(detect("NO_PROXY='*' python3 x.py").unwrap().curl, None);
    }

    /// A fake agent's `NO_PROXY='*' python3 -c 'urlopen(…)'` row must not read `—` in
    /// Method and Host. Any program's first `http(s)://` URL is the target.
    #[test]
    fn a_non_curl_bypass_reads_its_first_url() {
        let t = |cmd: &str| {
            let c = detect(cmd).expect("a bypass").curl.expect("a target");
            (c.method, c.host, c.port, c.path, c.https)
        };
        let py = "NO_PROXY='*' python3 -c 'import urllib.request; print(urllib.request.urlopen(\"http://127.0.0.1:3000/health\", timeout=15).read().decode())'";
        assert_eq!(
            t(py),
            (
                "GET".into(),
                "127.0.0.1".into(),
                3000,
                "/health".into(),
                false
            )
        );
        let d = detect(py).unwrap();
        assert_eq!(
            d.curl.unwrap().url,
            "http://127.0.0.1:3000/health",
            "the URL ends at its closing quote"
        );
        assert_eq!(
            t("wget --no-proxy -q -O - HTTPS://api.example.com/v1/x?y=1."),
            (
                "GET".into(),
                "api.example.com".into(),
                443,
                "/v1/x?y=1".into(),
                true
            )
        );
        assert_eq!(
            t("unset HTTPS_PROXY; node -e \"fetch('https://h.io/a', {method: 'POST'})\""),
            ("POST".into(), "h.io".into(), 443, "/a".into(), true)
        );
        assert_eq!(
            t("NO_PROXY=* python3 -c \"import urllib.request as u; u.urlopen(u.Request('http://h/p', data=b'x', method='PUT'))\"").0,
            "PUT",
            "an explicit method wins over the body's POST"
        );
        assert_eq!(
            t("NO_PROXY=* python3 -c \"import requests; requests.delete('http://h/r/1')\"").0,
            "DELETE"
        );
        assert_eq!(
            t("NO_PROXY=* python3 -c \"import urllib.request as u; u.urlopen('http://h/', data=b'{}')\"").0,
            "POST"
        );
        assert_eq!(t("wget --no-proxy --post-data 'a=1' http://h/").0, "POST");
        assert_eq!(t("env -u HTTP_PROXY httpie -X PATCH http://h/").0, "PATCH");
        assert_eq!(
            t("env -u HTTP_PROXY ./probe --method=head http://h/").0,
            "HEAD"
        );
        // A lower-case `-x` is a proxy flag, not a method; `-X` with no method word falls through.
        assert_eq!(t("NO_PROXY=* ./probe -x post http://h/").0, "GET");
        assert_eq!(t("NO_PROXY=* ./probe -Xfoo http://h/").0, "GET");
        // A command that names no URL still has no target, and a curl's own arguments still win.
        assert_eq!(detect("NO_PROXY='*' python3 x.py").unwrap().curl, None);
        assert_eq!(detect("NO_PROXY=* ./probe 'http://' x").unwrap().curl, None);
        let c = detect("curl --noproxy '*' -X POST http://a/x && echo http://b/y")
            .unwrap()
            .curl
            .unwrap();
        assert_eq!((c.host.as_str(), c.method.as_str()), ("a", "POST"));
    }

    /// Commands shaped like the real PowerShell tool calls in real transcripts
    /// (`$env:Path = …; git --version` style).
    #[test]
    fn powershell_51_web_requests_are_reported_and_ordinary_commands_are_not() {
        let ps = |cmd: &str| {
            detect_powershell(cmd, true)
                .map(|d| d.reasons)
                .unwrap_or_default()
        };
        for cmd in [
            "Invoke-WebRequest -Uri http://127.0.0.1:3000/health -UseBasicParsing",
            "$r = Invoke-RestMethod 'https://api.example.com/v1/x' -Method Post -Body $b; $r.id",
            "iwr http://localhost:8080/ | Select-Object -Expand Content",
            "(irm \"http://h/a\").status",
            "curl http://127.0.0.1:3000/health",
            "wget https://h.io/file.zip -OutFile f.zip",
            "Microsoft.PowerShell.Utility\\Invoke-WebRequest http://h/",
            "& iwr http://h/",
            "(New-Object System.Net.WebClient).DownloadString('http://h/')",
            "[System.Net.Http.HttpClient]::new().GetStringAsync('http://h/').Result",
            "Start-BitsTransfer -Source http://h/x -Destination x",
            "INVOKE-WEBREQUEST http://h/",
        ] {
            assert_eq!(ps(cmd), [R_PS51_WEB], "{cmd}");
        }
        for cmd in [
            "git --version; (Get-Command gh -ErrorAction SilentlyContinue).Source",
            "Get-Command curl",
            "curl.exe -s http://127.0.0.1:3000/health",
            "Write-Output 'Invoke-WebRequest is a cmdlet'",
            "Get-Help Invoke-WebRequest",
            "$env:Path = [Environment]::GetEnvironmentVariable(\"Path\",\"Machine\"); git --version",
            "[System.Net.WebRequest]::DefaultWebProxy",
        ] {
            assert_eq!(detect_powershell(cmd, true), None, "{cmd}");
        }
    }

    #[test]
    fn powershell_7_cmdlets_are_captured_unless_they_say_noproxy() {
        assert_eq!(
            detect_powershell("Invoke-WebRequest http://h/", false),
            None
        );
        // In PowerShell 7 `curl` is curl.exe (a `-NoProxy` there is just an argument to it),
        // and .NET's clients read the proxy variables.
        assert_eq!(detect_powershell("curl http://h/", false), None);
        assert_eq!(detect_powershell("curl http://h/ -NoProxy", false), None);
        assert_eq!(
            detect_powershell(
                "(New-Object Net.WebClient).DownloadString('http://h/')",
                false
            ),
            None
        );
        let d = detect_powershell("iwr http://127.0.0.1:3000/x -NoProxy", false).unwrap();
        assert_eq!(d.reasons, [R_PS_NOPROXY]);
        assert!(!d.shim_covers);
        let c = d.curl.unwrap();
        assert_eq!(
            (c.method.as_str(), c.host.as_str(), c.port, c.path.as_str()),
            ("GET", "127.0.0.1", 3000, "/x")
        );
        // Start-BitsTransfer uses the system proxy on either edition.
        assert_eq!(
            detect_powershell("Start-BitsTransfer http://h/x x", false)
                .unwrap()
                .reasons,
            [R_PS51_WEB]
        );
    }

    #[test]
    fn powershell_environment_bypasses_and_curl_exe_flags_are_named() {
        let ps = |cmd: &str, desktop| {
            detect_powershell(cmd, desktop)
                .map(|d| d.reasons)
                .unwrap_or_default()
        };
        for desktop in [true, false] {
            assert_eq!(
                ps("$env:NO_PROXY = '*'; node x.js", desktop),
                [R_NO_PROXY_STAR]
            );
            assert_eq!(
                ps("$env:no_proxy='localhost'; node x.js", desktop),
                [R_NO_PROXY_SET]
            );
            assert_eq!(
                ps(
                    "$env:HTTPS_PROXY = ''; $env:HTTP_PROXY=$null; cargo run",
                    desktop
                ),
                [R_EMPTY_PROXY_VAR]
            );
            assert_eq!(
                ps(
                    "Remove-Item Env:\\HTTPS_PROXY, Env:HTTP_PROXY; npm start",
                    desktop
                ),
                [R_UNSET]
            );
            // curl.exe is the real curl: its own bypass is the POSIX detector's — not shimmed here.
            let d = detect_powershell("curl.exe -s --noproxy '*' http://127.0.0.1:3000/h", desktop)
                .unwrap();
            assert_eq!(d.reasons, [R_NOPROXY]);
            assert!(!d.shim_covers, "no shim runs in the PowerShell tool");
            assert_eq!(d.curl.unwrap().path, "/h");
        }
        // A 5.1 cmdlet AND an env bypass: both, in the order found, each once.
        assert_eq!(
            ps("$env:NO_PROXY='*'; iwr http://h/; iwr http://h/b", true),
            [R_NO_PROXY_STAR, R_PS51_WEB]
        );
        // The method comes from `-Method`.
        let c = detect_powershell("Invoke-RestMethod -Method Put -Uri https://h.io/r/1", true)
            .unwrap()
            .curl
            .unwrap();
        assert_eq!(
            (c.method.as_str(), c.https, c.host.as_str()),
            ("PUT", true, "h.io")
        );
    }

    #[test]
    fn hostile_powershell_input_is_harmless() {
        for cmd in [
            "",
            "'",
            "\"",
            "`",
            "$env:",
            "$env:NO_PROXY =",
            "Remove-Item",
            "iwr",
        ] {
            let _ = detect_powershell(cmd, true);
        }
        let long = format!("iwr http://h/{}", "a".repeat(100_000));
        assert!(detect_powershell(&long, true).is_some());
    }

    /// The command text is kept verbatim by the caller; the detector only reads it. A huge or
    /// hostile command must not hang or panic.
    #[test]
    fn hostile_input_is_harmless() {
        let long = format!("curl --noproxy '*' http://h/{}", "a".repeat(100_000));
        assert!(detect(&long).is_some());
        for cmd in [
            "",
            "'",
            "\"",
            "$(",
            "$($($(",
            "curl -x",
            "env -u",
            "curl --noproxy",
            "curl http://[::1",
        ] {
            let _ = detect(cmd);
        }
    }
}
