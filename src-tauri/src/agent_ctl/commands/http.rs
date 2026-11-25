//! API-client tools: HTTP requests, collections, environments, history and compare.
//!
//! Two kinds of request, with different rights:
//! * **Agent-authored** (`http send`, `http open`, a URL side of `api compare`): the agent wrote
//!   every byte, so nothing is substituted. Anything containing `{{` — URL, a header, the body,
//!   the curl command — is **refused**: it would name a Vault variable, and an agent that could
//!   get one substituted could send the user's saved secret to a host it chose. (`http open`
//!   needs this most: the tab it opens substitutes on the user's Send.)
//! * **User-saved** (`api run`, a saved side of `api compare`): the request is sent exactly as the
//!   user saved it — the agent picks which one and which of the user's environments, and cannot
//!   change its method, URL, headers or body. Its `{{VAR}}`s are resolved here, in Rust, by the
//!   API client's own rule (the chosen environment, or the active one; an unset name becomes
//!   empty). Whatever comes back is passed through [`report::Redactor`], so a substituted value
//!   an echo endpoint or an error repeats reads as its `{{NAME}}` again.
//!
//! Nothing an agent reads carries a Vault value: environments are listed by variable **name**,
//! saved requests by URL as written ({{HOST}} stays a name) with credential-looking URL parts
//! masked, history without headers or bodies.
//!
//! Bounded: request inputs ([`MAX_URL`], [`MAX_HEADERS`], [`MAX_BODY`]), time
//! ([`crate::http::REQUEST_TIMEOUT`] at most), and every reply ([`report`]'s caps), each cut said
//! in the reply.
//!
//! Visible: every send is recorded in the API history (the literal request, as the app records
//! its own) and the `apiHistory` event brings the History rail into view; `http open` opens a
//! request tab (`httpOpen`). Every send also shows in the Network view, as the API client's do.

use std::time::Duration;

use serde_json::{json, Value};

use crate::agent_ctl::registry::{Args, Param, ParamKind, ToolCtx, ToolFuture, ToolOk, ToolSpec};
use crate::api_store::{self, ApiStore, Environment, SavedRequest};
use crate::history_store::{self, HistoryEntry};
use crate::http::{self as engine, HttpHeader, HttpRequest, HttpResponse};

#[path = "http_curl.rs"]
pub mod curl;
#[path = "http_report.rs"]
pub mod report;

use report::{redact_url, Redactor, Side};

/// The longest URL an agent may send.
pub const MAX_URL: usize = 8 * 1024;
/// The most request headers.
pub const MAX_HEADERS: usize = 64;
/// The largest request body.
pub const MAX_BODY: usize = 1024 * 1024;
/// How many history entries `api history` lists at most (and by default).
pub const HISTORY_MAX: i64 = 200;
pub const HISTORY_DEFAULT: i64 = 20;
/// How many saved requests `api collections` lists.
pub const LIST_CAP: usize = 500;

const URL_HELP: &str = "The URL (http:// or https://). A whole `curl …` command is read as --curl.";
const METHOD_HELP: &str = "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS… (default GET, or POST \
                           with a body).";
const HEADER_HELP: &str = "A header, 'Name: value'. Repeat for more.";
const BODY_HELP: &str = "The request body, sent as written.";
const BODY_JSON_HELP: &str =
    "A JSON body; adds Content-Type: application/json unless a header sets one.";
const CURL_HELP: &str = "A whole curl command instead of url/method/header/body.";
const TIMEOUT_HELP: &str = "Give up after this many milliseconds (default and most: 30000).";
const ENV_HELP: &str = "The user's environment to resolve {{VARS}} from (default: the active one).";

const SEND_PARAMS: &[Param] = &[
    Param::new("url", ParamKind::String, URL_HELP).positional(),
    Param::new("method", ParamKind::String, METHOD_HELP),
    Param::new("header", ParamKind::StringList, HEADER_HELP),
    Param::new("body", ParamKind::String, BODY_HELP),
    Param::new("body_json", ParamKind::Json, BODY_JSON_HELP),
    Param::new("curl", ParamKind::String, CURL_HELP),
    Param::new("timeout_ms", ParamKind::Integer, TIMEOUT_HELP),
];

const OPEN_PARAMS: &[Param] = &[
    Param::new("url", ParamKind::String, URL_HELP).positional(),
    Param::new("method", ParamKind::String, METHOD_HELP),
    Param::new("header", ParamKind::StringList, HEADER_HELP),
    Param::new("body", ParamKind::String, BODY_HELP),
    Param::new("body_json", ParamKind::Json, BODY_JSON_HELP),
    Param::new("curl", ParamKind::String, CURL_HELP),
];

pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "http_send",
        cli: &["http", "send"],
        summary: "Send an HTTP request with Agent Studio's API client and print the status, \
                  time, headers and body. Recorded in the API history.",
        details: "Give a URL with --method/--header/--body/--body-json, or a whole curl \
                  command (--curl, or as the URL). The body shown is capped at 64 KB (JSON is \
                  re-indented); the reply says when it was cut. A request that names a Vault \
                  variable ({{…}}) is refused: agents cannot use the user's saved secrets — to \
                  use them, run a request the user saved (`agent-studio api run`).",
        params: SEND_PARAMS,
        run: run_send,
    },
    ToolSpec {
        name: "http_open",
        cli: &["http", "open"],
        summary: "Open an HTTP request in a new API client tab for the user to review and send \
                  (nothing is sent).",
        details: "Same inputs as `http send`. A request that names a Vault variable ({{…}}) is \
                  refused: agents cannot use the user's saved secrets.",
        params: OPEN_PARAMS,
        run: run_open,
    },
    ToolSpec {
        name: "api_collections",
        cli: &["api", "collections"],
        summary: "List the requests the user saved in the API client: name, folder, method and \
                  URL as written ({{VARS}} stay names).",
        details: "Header values and bodies are not shown; credential-looking URL parts are \
                  masked. Run one with `agent-studio api run <name>`.",
        params: &[],
        run: run_collections,
    },
    ToolSpec {
        name: "api_envs",
        cli: &["api", "envs"],
        summary: "List the API client's environments, which one is active, and their variable \
                  names (never values).",
        details: "",
        params: &[],
        run: run_envs,
    },
    ToolSpec {
        name: "api_history",
        cli: &["api", "history"],
        summary: "List recent requests from the API history: method, URL, status and time, \
                  newest first.",
        details: "--limit defaults to 20, at most 200.",
        params: &[Param::new(
            "limit",
            ParamKind::Integer,
            "How many entries (default 20, at most 200).",
        )],
        run: run_history,
    },
    ToolSpec {
        name: "api_run",
        cli: &["api", "run"],
        summary: "Send a request the user saved in the API client (by name or id), resolving its \
                  {{VARS}} from the user's environment. Recorded in the API history.",
        details: "The request is sent exactly as saved: its method, URL, headers and body cannot \
                  be changed. Values substituted from the environment are shown as their \
                  {{NAME}} wherever the response repeats them. HTTP requests only.",
        params: &[
            Param::new(
                "request",
                ParamKind::String,
                "The saved request's name or id.",
            )
            .required()
            .positional(),
            Param::new("env", ParamKind::String, ENV_HELP),
            Param::new("timeout_ms", ParamKind::Integer, TIMEOUT_HELP),
        ],
        run: run_saved,
    },
    ToolSpec {
        name: "api_compare",
        cli: &["api", "compare"],
        summary: "Send two requests at once and compare the responses: status, timing, header \
                  differences and a JSON key/value diff.",
        details: "Each side is a saved request (name or id) or an http(s):// URL. \
                  --method/--header/--body/--body-json apply to the URL sides (both get the \
                  same, as in the app's A/B compare); a saved request is sent exactly as saved, \
                  resolved from --env. Lists at most 100 differences per section. A URL side \
                  that names a Vault variable ({{…}}) is refused.",
        params: &[
            Param::new("a", ParamKind::String, "Side A: a saved request or a URL.")
                .required()
                .positional(),
            Param::new("b", ParamKind::String, "Side B: a saved request or a URL.")
                .required()
                .positional(),
            Param::new("method", ParamKind::String, METHOD_HELP),
            Param::new("header", ParamKind::StringList, HEADER_HELP),
            Param::new("body", ParamKind::String, BODY_HELP),
            Param::new("body_json", ParamKind::Json, BODY_JSON_HELP),
            Param::new("env", ParamKind::String, ENV_HELP),
            Param::new("timeout_ms", ParamKind::Integer, TIMEOUT_HELP),
        ],
        run: run_compare,
    },
];

/* ───────────────────────────── agent-authored requests ───────────────────────────── */

/// A request an agent wrote, validated and free of Vault references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// From a curl command's `-m` / `--max-time`.
    pub timeout_ms: Option<u64>,
}

impl AgentRequest {
    pub fn wire(&self) -> HttpRequest {
        HttpRequest {
            method: self.method.clone(),
            url: self.url.clone(),
            headers: self
                .headers
                .iter()
                .map(|(name, value)| HttpHeader {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
            body: self.body.clone(),
        }
    }

    /// What the history records: the request as the agent wrote it (there is nothing to keep
    /// literal — it named no variable).
    fn literal(&self) -> Literal {
        Literal {
            method: self.method.clone(),
            url: self.url.clone(),
            headers: self.headers.clone(),
            body: self.body.clone().unwrap_or_default(),
        }
    }
}

/// The sentence for a `{{` in an agent's request. `part` names where it was found.
pub fn vault_refusal(part: &str) -> String {
    format!(
        "That request names an Agent Studio Vault variable ({{{{…}}}}) in its {part}. Agents \
         cannot use the user's saved secrets: put the value itself in the request, or run a \
         request the user saved with `agent-studio api run <name>` (`agent-studio api \
         collections` lists them)."
    )
}

/// Refuse when any part of an agent-written request contains `{{`.
pub fn refuse_vault_refs(parts: &[(&str, &str)]) -> Result<(), String> {
    match parts.iter().find(|(_, text)| text.contains("{{")) {
        Some((part, _)) => Err(vault_refusal(part)),
        None => Ok(()),
    }
}

/// `Name: value` from `--header`.
fn header_arg(raw: &str) -> Result<(String, String), String> {
    match raw.split_once(':') {
        Some((name, value)) if !name.trim().is_empty() => {
            Ok((name.trim().to_string(), value.trim().to_string()))
        }
        _ => Err(format!(
            "A header is written 'Name: value'; `{}` has no name before a colon.",
            report::short(raw)
        )),
    }
}

/// The request in `args`: url/method/header/body/body_json, or a curl command.
pub fn agent_request(args: &Args) -> Result<AgentRequest, String> {
    agent_request_for(args, args.str("url"), true)
}

/// [`agent_request`] with the URL given separately (`api compare`'s sides), and whether a curl
/// command is accepted.
fn agent_request_for(
    args: &Args,
    url_arg: Option<&str>,
    curl_ok: bool,
) -> Result<AgentRequest, String> {
    let url_arg = url_arg.map(str::trim).filter(|u| !u.is_empty());
    let curl_text = match (args.str("curl"), url_arg) {
        (Some(c), _) if curl_ok => Some(c),
        (None, Some(u)) if curl_ok && curl::is_curl_command(u) => Some(u),
        _ => None,
    };
    let header_args = args.list("header");
    let body_arg = args.str("body");
    let body_json = args.json("body_json");

    let mut req = if let Some(text) = curl_text {
        let own_url = args.str("curl").is_some() && url_arg.is_some();
        if own_url
            || args.str("method").is_some()
            || !header_args.is_empty()
            || body_arg.is_some()
            || body_json.is_some()
        {
            return Err(
                "Give either a curl command or url/--method/--header/--body, not both.".into(),
            );
        }
        if text.len() > MAX_BODY + MAX_URL {
            return Err(format!(
                "That curl command is {} bytes; the most an agent may send is {} KB.",
                report::thousands(text.len()),
                (MAX_BODY + MAX_URL) / 1024
            ));
        }
        refuse_vault_refs(&[("curl command", text)])?;
        let p = curl::parse(text)?;
        AgentRequest {
            method: p.method,
            url: p.url,
            headers: p.headers,
            body: p.body,
            timeout_ms: p.timeout_ms,
        }
    } else {
        let Some(url) = url_arg else {
            return Err("Give a URL (http:// or https://) or a curl command (--curl).".into());
        };
        refuse_vault_refs(&[("URL", url)])?;
        for h in &header_args {
            refuse_vault_refs(&[("headers", h)])?;
        }
        let mut headers = header_args
            .iter()
            .map(|h| header_arg(h))
            .collect::<Result<Vec<_>, _>>()?;
        let body = match (body_arg, body_json) {
            (Some(_), Some(_)) => return Err("Give --body or --body-json, not both.".into()),
            (Some(b), None) => Some(b.to_string()),
            (None, Some(v)) => {
                if !headers
                    .iter()
                    .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                {
                    headers.push(("Content-Type".into(), "application/json".into()));
                }
                Some(v.to_string())
            }
            (None, None) => None,
        };
        let method = match args.str("method").map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => m.to_ascii_uppercase(),
            None if body.is_some() => "POST".into(),
            None => "GET".into(),
        };
        AgentRequest {
            method,
            url: url.to_string(),
            headers,
            body,
            timeout_ms: None,
        }
    };

    // Again on what the request became: a curl command can spell `{{` without writing it
    // (`\{\{` is unescaped like curl does), and a JSON body is re-serialized.
    let mut parts: Vec<(&str, &str)> = vec![("URL", req.url.as_str())];
    for (name, value) in &req.headers {
        parts.push(("headers", name));
        parts.push(("headers", value));
    }
    if let Some(b) = &req.body {
        parts.push(("body", b));
    }
    refuse_vault_refs(&parts)?;

    req.url = req.url.trim().to_string();
    if req.url.len() > MAX_URL {
        return Err(format!(
            "That URL is {} bytes; the most is {} KB.",
            report::thousands(req.url.len()),
            MAX_URL / 1024
        ));
    }
    match reqwest::Url::parse(&req.url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => {}
        Ok(u) => {
            return Err(format!(
                "Agent Studio's API client sends http:// and https:// requests, not {}://.",
                u.scheme()
            ))
        }
        Err(e) => {
            return Err(format!(
                "`{}` is not a URL ({e}). Give a full URL such as https://api.example.com/path.",
                report::short(&req.url)
            ))
        }
    }
    if req.method.is_empty() || !req.method.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err(format!(
            "`{}` is not an HTTP method.",
            report::short(&req.method)
        ));
    }
    if req.headers.len() > MAX_HEADERS {
        return Err(format!(
            "That request has {} headers; the most is {MAX_HEADERS}.",
            req.headers.len()
        ));
    }
    if let Some(b) = &req.body {
        if b.len() > MAX_BODY {
            return Err(format!(
                "That body is {} bytes; the most an agent may send is {} KB.",
                report::thousands(b.len()),
                MAX_BODY / 1024
            ));
        }
    }
    Ok(req)
}

/// The deadline: `--timeout-ms`, else a curl command's `-m`, else the API client's 30 s; never
/// more than that. The note says when a longer one was asked for.
pub fn deadline(args: &Args, from_curl: Option<u64>) -> Result<(Duration, Option<String>), String> {
    let max = engine::REQUEST_TIMEOUT.as_millis() as u64;
    let asked = match args.int("timeout_ms") {
        Some(ms) if ms < 1 => return Err("`timeout_ms` must be at least 1.".to_string()),
        Some(ms) => Some(ms as u64),
        None => from_curl,
    };
    Ok(match asked {
        Some(ms) if ms > max => (
            engine::REQUEST_TIMEOUT,
            Some(format!(
                "The timeout was capped at {max} ms (the API client's limit), not the {ms} ms \
                 asked for."
            )),
        ),
        Some(ms) => (Duration::from_millis(ms), None),
        None => (engine::REQUEST_TIMEOUT, None),
    })
}

/* ───────────────────────────── user-saved requests ───────────────────────────── */

/// The API client's `{{VAR}}` rule (`substitute.ts`): `{{ NAME }}` (trimmed) becomes the
/// variable's value, an unset name becomes the empty string, and an unterminated `{{` is left
/// alone. Every substituted `(NAME, value)` is pushed to `used`, every unset name to `missing`.
pub fn substitute(
    text: &str,
    vars: &[(String, String)],
    used: &mut Vec<(String, String)>,
    missing: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        // `[^{}]*` then `}}`: the first `{` or `}` after the opening decides.
        let stop = after.find(['{', '}']);
        match stop {
            Some(i) if after[i..].starts_with("}}") => {
                out.push_str(&rest[..start]);
                let name = after[..i].trim();
                // The last definition wins, as the app's lookup map is built.
                match vars.iter().rev().find(|(k, _)| k == name) {
                    Some((k, v)) => {
                        out.push_str(v);
                        if !used.iter().any(|(u, _)| u == k) {
                            used.push((k.clone(), v.clone()));
                        }
                    }
                    None => {
                        if !missing.iter().any(|m| m == name) {
                            missing.push(name.to_string());
                        }
                    }
                }
                rest = &after[i + 2..];
            }
            _ => {
                // Not a placeholder: keep one `{` and look again from the next character, so
                // `{{{A}}` still finds `{{A}}`.
                out.push_str(&rest[..start + 1]);
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The `{{NAME}}`s in `text`, in order, without repeats.
pub fn var_names(text: &str) -> Vec<String> {
    let mut used = Vec::new();
    let mut names = Vec::new();
    substitute(text, &[], &mut used, &mut names);
    names
}

/// The saved request `key` names: its id, else its name (case-insensitive). `Err` says what
/// there is instead.
pub fn find_saved<'a>(store: &'a ApiStore, key: &str) -> Result<&'a SavedRequest, String> {
    let key = key.trim();
    if let Some(r) = store.collections.iter().find(|r| r.id == key) {
        return Ok(r);
    }
    let matches: Vec<&SavedRequest> = store
        .collections
        .iter()
        .filter(|r| r.name.trim().eq_ignore_ascii_case(key))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] if store.collections.is_empty() => Err(
            "The user has no saved requests in the API client. They save one with ⌘S / Ctrl+S \
             in a request tab."
                .to_string(),
        ),
        [] => {
            let names: Vec<String> = store
                .collections
                .iter()
                .take(15)
                .map(|r| format!("\"{}\"", r.name))
                .collect();
            Err(format!(
                "No saved request is called \"{key}\". Saved requests: {}{}. \
                 `agent-studio api collections` lists them all.",
                names.join(", "),
                if store.collections.len() > 15 {
                    ", …"
                } else {
                    ""
                }
            ))
        }
        many => Err(format!(
            "{} saved requests are called \"{key}\"; give the id of the one to run: {}.",
            many.len(),
            many.iter()
                .map(|r| format!("{} ({})", r.id, folder_name(store, r)))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn folder_name(store: &ApiStore, r: &SavedRequest) -> String {
    r.folder_id
        .as_deref()
        .and_then(|id| store.folders.iter().find(|f| f.id == id))
        .map(|f| format!("in {}", f.name))
        .unwrap_or_else(|| "at the root".to_string())
}

/// The environment `--env` names (name, case-insensitive, or id), else the active one.
pub fn pick_env<'a>(
    store: &'a ApiStore,
    env: Option<&str>,
) -> Result<Option<&'a Environment>, String> {
    match env.map(str::trim).filter(|e| !e.is_empty()) {
        Some(key) => store
            .environments
            .iter()
            .find(|e| e.id == key)
            .or_else(|| {
                store
                    .environments
                    .iter()
                    .find(|e| e.name.trim().eq_ignore_ascii_case(key))
            })
            .map(Some)
            .ok_or_else(|| {
                format!(
                    "The API client has no environment \"{key}\". Environments: {}.",
                    if store.environments.is_empty() {
                        "none".to_string()
                    } else {
                        store
                            .environments
                            .iter()
                            .map(|e| format!("\"{}\"", e.name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                )
            }),
        None => Ok(store
            .active_environment_id
            .as_deref()
            .and_then(|id| store.environments.iter().find(|e| e.id == id))),
    }
}

/// A saved request made ready to send: the wire request (secrets in), the literal one (the
/// history's), the redactor for what comes back, and what to tell the agent about it.
pub struct Resolved {
    pub wire: HttpRequest,
    literal: Literal,
    pub redactor: Redactor,
    /// `Saved request "List users": GET {{BASE}}/users (environment "dev")`.
    pub label: String,
    /// Names the request uses that the environment does not set (sent empty).
    pub missing: Vec<String>,
}

/// Resolve `saved` against `env` by the API client's rules (see the module doc).
pub fn resolve(saved: &SavedRequest, env: Option<&Environment>) -> Result<Resolved, String> {
    match saved.protocol.as_deref() {
        None | Some("http") => {}
        Some(p) => {
            return Err(format!(
                "\"{}\" is a {} request; `api run` sends HTTP requests.",
                saved.name,
                match p {
                    "ws" => "WebSocket",
                    "grpc" => "gRPC",
                    other => other,
                }
            ))
        }
    }
    let vars: Vec<(String, String)> = env
        .map(|e| {
            e.variables
                .iter()
                .map(|v| (v.key.clone(), v.value.clone()))
                .collect()
        })
        .unwrap_or_default();
    let (mut used, mut missing) = (Vec::new(), Vec::new());
    // Only named header rows travel; an empty-named row is scaffolding (execute.ts).
    let headers: Vec<&api_store::HttpHeader> = saved
        .headers
        .iter()
        .filter(|h| !h.name.trim().is_empty())
        .collect();
    let wire = HttpRequest {
        method: saved.method.clone(),
        url: substitute(&saved.url, &vars, &mut used, &mut missing),
        headers: headers
            .iter()
            .map(|h| HttpHeader {
                name: h.name.clone(),
                value: substitute(&h.value, &vars, &mut used, &mut missing),
            })
            .collect(),
        // An empty body is no body, whatever the method (execute.ts).
        body: (!saved.body.is_empty())
            .then(|| substitute(&saved.body, &vars, &mut used, &mut missing)),
    };
    let literal = Literal {
        method: saved.method.clone(),
        url: saved.url.clone(),
        headers: headers
            .iter()
            .map(|h| (h.name.clone(), h.value.clone()))
            .collect(),
        body: saved.body.clone(),
    };
    let label = format!(
        "Saved request \"{}\": {} {} ({})",
        saved.name,
        saved.method,
        redact_url(&saved.url),
        env.map(|e| format!("environment \"{}\"", e.name))
            .unwrap_or_else(|| "no environment".to_string())
    );
    Ok(Resolved {
        wire,
        literal,
        redactor: Redactor::new(&used),
        label,
        missing,
    })
}

fn missing_note(missing: &[String], env: &str) -> Option<String> {
    (!missing.is_empty()).then(|| {
        format!(
            "Not set in {env}, so sent empty (as the API client does): {}.",
            missing
                .iter()
                .map(|m| format!("{{{{{m}}}}}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

/* ───────────────────────────── sending and recording ───────────────────────────── */

/// The request the history records — literal, as the app records its own sends.
#[derive(Debug, Clone)]
struct Literal {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: String,
}

/// One send's outcome and whether it reached the history.
struct Sent {
    outcome: Result<HttpResponse, String>,
    history_id: String,
    /// `Err` when the history file could not be written.
    recorded: Result<(), String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Send `wire` through the API client's engine, redact what comes back, and append the literal
/// request and its outcome to the API history.
async fn send_recorded(
    ctx: &ToolCtx,
    wire: HttpRequest,
    literal: Literal,
    timeout: Duration,
    redactor: &Redactor,
) -> Sent {
    let at = now_ms();
    let outcome = engine::send_bounded(wire, timeout)
        .await
        .map(|r| redactor.response(r))
        .map_err(|e| redactor.apply(&e));
    let history_id = ulid::Ulid::new().to_string();
    let (status, status_text, duration_ms, size_bytes, error) = match &outcome {
        Ok(r) => (
            Some(r.status),
            Some(r.status_text.clone()),
            Some(r.duration_ms),
            Some(r.size_bytes as u64),
            None,
        ),
        Err(e) => (None, None, None, None, Some(e.clone())),
    };
    let entry = HistoryEntry {
        id: history_id.clone(),
        method: literal.method,
        url: literal.url,
        headers: literal
            .headers
            .into_iter()
            .map(|(name, value)| api_store::HttpHeader { name, value })
            .collect(),
        body: literal.body,
        status,
        status_text,
        duration_ms,
        size_bytes,
        error,
        at,
        protocol: None,
        grpc_service: None,
    };
    let recorded = history_store::append(&history_store::path_in(&ctx.dir), entry)
        .map_err(|e| format!("Could not record it in the API history: {e}."));
    Sent {
        outcome,
        history_id,
        recorded,
    }
}

/// Bring the History rail into view with the new entries (`handlers/http.ts`).
fn emit_history(ctx: &ToolCtx, sent: &[&Sent]) {
    let ids: Vec<&str> = sent
        .iter()
        .filter(|s| s.recorded.is_ok())
        .map(|s| s.history_id.as_str())
        .collect();
    if !ids.is_empty() {
        ctx.emit("apiHistory", json!({ "historyIds": ids }));
    }
}

fn recorded_note(sent: &Sent) -> String {
    match &sent.recorded {
        Ok(()) => "Recorded in Agent Studio's API history.".to_string(),
        Err(e) => e.clone(),
    }
}

/// The reply for one sent request: the response report, or the failure as an `Err`.
fn sent_reply(
    sent: &Sent,
    request_line: &str,
    notes: &[Option<String>],
    extra: Value,
) -> Result<ToolOk, String> {
    let mut note_lines: Vec<String> = notes.iter().flatten().cloned().collect();
    note_lines.push(recorded_note(sent));
    match &sent.outcome {
        Ok(r) => {
            let (message, mut data) =
                report::response_report(r, request_line, &note_lines.join("\n"));
            if let (Value::Object(d), Value::Object(e)) = (&mut data, extra) {
                d.extend(e);
                d.insert("historyId".into(), Value::String(sent.history_id.clone()));
            }
            Ok(ToolOk::new(message, data))
        }
        Err(e) => Err(format!(
            "{request_line}\nfailed: {e}\n{}",
            note_lines.join("\n")
        )),
    }
}

/* ───────────────────────────── the tools ───────────────────────────── */

fn run_send(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let req = agent_request(&args)?;
        let (timeout, timeout_note) = deadline(&args, req.timeout_ms)?;
        let sent = send_recorded(
            &ctx,
            req.wire(),
            req.literal(),
            timeout,
            &Redactor::default(),
        )
        .await;
        emit_history(&ctx, &[&sent]);
        sent_reply(
            &sent,
            &format!("{} {}", req.method, req.url),
            &[timeout_note],
            json!({"request": {"method": req.method, "url": req.url}}),
        )
    })
}

/// A tab title: `POST api.example.com/users`, at most 60 characters.
fn tab_title(method: &str, url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut title = format!("{method} {rest}");
    if title.chars().count() > 60 {
        title = title.chars().take(59).collect::<String>() + "…";
    }
    title
}

fn run_open(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let req = agent_request(&args)?;
        let headers: Vec<Value> = req
            .headers
            .iter()
            .map(|(name, value)| json!({"name": name, "value": value}))
            .collect();
        let title = tab_title(&req.method, &req.url);
        ctx.emit(
            "httpOpen",
            json!({
                "method": req.method,
                "url": req.url,
                "headers": headers,
                "body": req.body,
                "title": title,
            }),
        );
        Ok(ToolOk::new(
            format!(
                "Opened {} {} in a new API client tab (\"{title}\"). Nothing was sent; the user \
                 can review it and press Send.",
                req.method, req.url
            ),
            json!({
                "method": req.method,
                "url": req.url,
                "headers": headers,
                "body": req.body,
                "title": title,
            }),
        ))
    })
}

fn load_store(ctx: &ToolCtx) -> ApiStore {
    api_store::load(&api_store::path_in(&ctx.dir))
}

/// A saved request as an agent may see it: no header values, no body, the URL as written with
/// credential-looking parts masked, and the `{{NAME}}`s it needs.
pub fn saved_summary(store: &ApiStore, r: &SavedRequest) -> Value {
    let mut vars = var_names(&r.url);
    for h in &r.headers {
        vars.extend(var_names(&h.value));
    }
    vars.extend(var_names(&r.body));
    let mut seen = std::collections::HashSet::new();
    vars.retain(|v| seen.insert(v.clone()));
    json!({
        "id": r.id,
        "name": r.name,
        "folder": r.folder_id.as_deref()
            .and_then(|id| store.folders.iter().find(|f| f.id == id))
            .map(|f| f.name.clone()),
        "protocol": r.protocol.clone().unwrap_or_else(|| "http".into()),
        "method": r.method,
        "url": redact_url(&r.url),
        "headers": r.headers.iter().filter(|h| !h.name.trim().is_empty()).map(|h| h.name.clone()).collect::<Vec<_>>(),
        "hasBody": !r.body.is_empty(),
        "variables": vars,
    })
}

fn verb(r: &SavedRequest) -> String {
    match r.protocol.as_deref() {
        Some("ws") => "WS".into(),
        Some("grpc") => "gRPC".into(),
        _ => r.method.clone(),
    }
}

fn run_collections(ctx: ToolCtx, _args: Args) -> ToolFuture {
    Box::pin(async move {
        let store = load_store(&ctx);
        if store.collections.is_empty() {
            return Ok(ToolOk::new(
                "The user has no saved requests in the API client.",
                json!({"folders": [], "requests": [], "count": 0, "truncated": false}),
            ));
        }
        // Folders in display order, then the root — the rail's order.
        let mut groups: Vec<(Option<&str>, Vec<&SavedRequest>)> = store
            .folders
            .iter()
            .map(|f| {
                (
                    Some(f.name.as_str()),
                    store
                        .collections
                        .iter()
                        .filter(|r| r.folder_id.as_deref() == Some(f.id.as_str()))
                        .collect(),
                )
            })
            .collect();
        groups.push((
            None,
            store
                .collections
                .iter()
                .filter(|r| {
                    r.folder_id
                        .as_deref()
                        .is_none_or(|id| !store.folders.iter().any(|f| f.id == id))
                })
                .collect(),
        ));
        let duplicate = |r: &SavedRequest| {
            store
                .collections
                .iter()
                .filter(|o| o.name.trim().eq_ignore_ascii_case(r.name.trim()))
                .count()
                > 1
        };
        let total = store.collections.len();
        let mut lines = vec![format!(
            "{total} saved request{} in Agent Studio's API client{}:",
            if total == 1 { "" } else { "s" },
            match store.folders.len() {
                0 => String::new(),
                1 => " (1 folder)".into(),
                n => format!(" ({n} folders)"),
            }
        )];
        let mut listed = Vec::new();
        for (folder, requests) in &groups {
            if requests.is_empty() {
                continue;
            }
            if listed.len() >= LIST_CAP {
                break;
            }
            lines.push(match folder {
                Some(name) => format!("{name}/"),
                None if store.folders.is_empty() => String::new(),
                None => "(no folder)".into(),
            });
            for r in requests {
                if listed.len() >= LIST_CAP {
                    break;
                }
                lines.push(format!(
                    "  {:<6} {}  —  \"{}\"{}",
                    verb(r),
                    redact_url(&r.url),
                    r.name,
                    if duplicate(r) {
                        format!(" [id {}]", r.id)
                    } else {
                        String::new()
                    }
                ));
                listed.push(saved_summary(&store, r));
            }
        }
        lines.retain(|l| !l.is_empty());
        if total > LIST_CAP {
            lines.push(format!("[{} more not listed.]", total - LIST_CAP));
        }
        lines.push(
            "Run one with `agent-studio api run \"<name>\"`; {{VARS}} resolve from the user's \
             environment (`agent-studio api envs`)."
                .into(),
        );
        Ok(ToolOk::new(
            lines.join("\n"),
            json!({
                "folders": store.folders.iter().map(|f| json!({"id": f.id, "name": f.name})).collect::<Vec<_>>(),
                "requests": listed,
                "count": total,
                "truncated": total > LIST_CAP,
            }),
        ))
    })
}

fn run_envs(ctx: ToolCtx, _args: Args) -> ToolFuture {
    Box::pin(async move {
        let store = load_store(&ctx);
        let active = pick_env(&store, None)?;
        if store.environments.is_empty() {
            return Ok(ToolOk::new(
                "The API client has no environments.",
                json!({"active": null, "environments": []}),
            ));
        }
        let mut lines = vec![format!(
            "{} environment{}; {}:",
            store.environments.len(),
            if store.environments.len() == 1 {
                ""
            } else {
                "s"
            },
            match active {
                Some(e) => format!("\"{}\" is active", e.name),
                None => "none is active".into(),
            }
        )];
        let mut envs = Vec::new();
        for e in &store.environments {
            let is_active = active.is_some_and(|a| a.id == e.id);
            let mut names: Vec<String> = e.variables.iter().map(|v| v.key.clone()).collect();
            names.dedup();
            let shown: Vec<&String> = names.iter().take(LIST_CAP).collect();
            lines.push(format!(
                "{} {} — {}{}",
                if is_active { "*" } else { " " },
                e.name,
                if shown.is_empty() {
                    "no variables".to_string()
                } else {
                    shown
                        .iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                },
                if names.len() > LIST_CAP {
                    format!(" [{} more]", names.len() - LIST_CAP)
                } else {
                    String::new()
                }
            ));
            envs.push(json!({
                "id": e.id,
                "name": e.name,
                "active": is_active,
                "variables": shown,
            }));
        }
        lines.push(
            "Values are never shown. A saved request run with `agent-studio api run` resolves \
             its {{VARS}} from the active environment, or from --env."
                .into(),
        );
        Ok(ToolOk::new(
            lines.join("\n"),
            json!({"active": active.map(|e| e.name.clone()), "environments": envs}),
        ))
    })
}

/// `2026-11-25 10:42:01 UTC`.
fn utc(ms: i64) -> String {
    match time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000) {
        Ok(t) => format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
            t.year(),
            u8::from(t.month()),
            t.day(),
            t.hour(),
            t.minute(),
            t.second()
        ),
        Err(_) => "?".into(),
    }
}

fn run_history(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let limit = match args.int("limit") {
            Some(n) if n < 1 => return Err("`limit` must be at least 1.".to_string()),
            Some(n) => n.min(HISTORY_MAX),
            None => HISTORY_DEFAULT,
        } as usize;
        let capped = args.int("limit").is_some_and(|n| n > HISTORY_MAX);
        let history = history_store::load(&history_store::path_in(&ctx.dir));
        let total = history.entries.len();
        if total == 0 {
            return Ok(ToolOk::new("The API history is empty.", json!([])));
        }
        let recent: Vec<&HistoryEntry> = history.entries.iter().rev().take(limit).collect();
        let mut lines = vec![format!(
            "{} request{} in the API history, newest first{}:",
            if recent.len() == total {
                format!("All {total}")
            } else {
                format!("The last {} of {total}", recent.len())
            },
            if total == 1 { "" } else { "s" },
            if capped {
                format!(" (at most {HISTORY_MAX} are listed)")
            } else {
                String::new()
            }
        )];
        let mut data = Vec::new();
        for e in &recent {
            let grpc = e.protocol.as_deref() == Some("grpc");
            let what = if grpc {
                format!(
                    "gRPC {}/{}",
                    e.grpc_service.as_deref().unwrap_or("?"),
                    e.method
                )
            } else {
                e.method.clone()
            };
            let outcome = match (&e.error, e.status) {
                (Some(err), _) => format!("failed: {}", report::short(err)),
                (None, Some(s)) => format!(
                    "{s} {}{}",
                    e.status_text.as_deref().unwrap_or(""),
                    e.duration_ms
                        .map(|d| format!(", {d} ms"))
                        .unwrap_or_default()
                ),
                (None, None) => "no outcome".into(),
            };
            let url = redact_url(&e.url);
            lines.push(format!(
                "  {}  {what} {}  →  {}",
                utc(e.at),
                report::short(&url),
                outcome.trim_end()
            ));
            data.push(json!({
                "id": e.id,
                "at": e.at,
                "protocol": e.protocol.clone().unwrap_or_else(|| "http".into()),
                "method": e.method,
                "url": url,
                "status": e.status,
                "statusText": e.status_text,
                "durationMs": e.duration_ms,
                "sizeBytes": e.size_bytes,
                "error": e.error.as_deref().map(report::short),
            }));
        }
        Ok(ToolOk::new(lines.join("\n"), Value::Array(data)))
    })
}

fn run_saved(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let store = load_store(&ctx);
        let saved = find_saved(&store, args.req_str("request")?)?.clone();
        let env = pick_env(&store, args.str("env"))?.cloned();
        let (timeout, timeout_note) = deadline(&args, None)?;
        let r = resolve(&saved, env.as_ref())?;
        let env_label = env
            .as_ref()
            .map(|e| format!("environment \"{}\"", e.name))
            .unwrap_or_else(|| "no environment (none is active)".into());
        let sent = send_recorded(&ctx, r.wire, r.literal, timeout, &r.redactor).await;
        emit_history(&ctx, &[&sent]);
        let redaction_note = (!r.redactor.is_empty()).then(|| {
            "Values substituted from the environment are shown as their {{NAME}} wherever the \
             response repeats them."
                .to_string()
        });
        sent_reply(
            &sent,
            &r.label,
            &[
                missing_note(&r.missing, &env_label),
                redaction_note,
                timeout_note,
            ],
            json!({
                "request": {
                    "id": saved.id,
                    "name": saved.name,
                    "method": saved.method,
                    "url": redact_url(&saved.url),
                    "environment": env.as_ref().map(|e| e.name.clone()),
                    "unsetVariables": r.missing,
                }
            }),
        )
    })
}

/// Is `side` a URL (agent-authored) rather than a saved request's name or id?
fn is_url_side(side: &str) -> bool {
    let s = side.trim().to_ascii_lowercase();
    s.starts_with("http://") || s.starts_with("https://")
}

/// One side of a compare, ready to send.
struct Prepared {
    label: String,
    wire: HttpRequest,
    literal: Literal,
    redactor: Redactor,
    note: Option<String>,
}

fn prepare_side(
    tag: &str,
    side: &str,
    args: &Args,
    store: &ApiStore,
    env: Option<&Environment>,
) -> Result<Prepared, String> {
    if is_url_side(side) {
        let req = agent_request_for(args, Some(side), false).map_err(|e| format!("{tag}: {e}"))?;
        return Ok(Prepared {
            label: format!("{tag}: {} {}", req.method, req.url),
            wire: req.wire(),
            literal: req.literal(),
            redactor: Redactor::default(),
            note: None,
        });
    }
    let saved = find_saved(store, side).map_err(|e| format!("{tag}: {e}"))?;
    let r = resolve(saved, env).map_err(|e| format!("{tag}: {e}"))?;
    let env_label = env
        .map(|e| format!("environment \"{}\"", e.name))
        .unwrap_or_else(|| "no environment".into());
    Ok(Prepared {
        label: format!("{tag}: {}", r.label),
        note: missing_note(&r.missing, &env_label).map(|n| format!("{tag}: {n}")),
        wire: r.wire,
        literal: r.literal,
        redactor: r.redactor,
    })
}

fn run_compare(ctx: ToolCtx, args: Args) -> ToolFuture {
    Box::pin(async move {
        let (a, b) = (args.req_str("a")?, args.req_str("b")?);
        let any_url = is_url_side(a) || is_url_side(b);
        let shaping = args.str("method").is_some()
            || !args.list("header").is_empty()
            || args.str("body").is_some()
            || args.json("body_json").is_some();
        if shaping && !any_url {
            return Err(
                "--method/--header/--body/--body-json apply to URL sides; a saved \
                        request is sent exactly as the user saved it."
                    .into(),
            );
        }
        let store = load_store(&ctx);
        let env = pick_env(&store, args.str("env"))?;
        let pa = prepare_side("A", a, &args, &store, env)?;
        let pb = prepare_side("B", b, &args, &store, env)?;
        let (timeout, timeout_note) = deadline(&args, None)?;
        // Both at once, as the app's compare sends them: B never waits on A.
        let (sa, sb) = tokio::join!(
            send_recorded(&ctx, pa.wire, pa.literal, timeout, &pa.redactor),
            send_recorded(&ctx, pb.wire, pb.literal, timeout, &pb.redactor),
        );
        emit_history(&ctx, &[&sa, &sb]);
        let side = |label: String, s: &Sent| Side {
            label,
            outcome: s.outcome.clone(),
        };
        let (mut message, mut data) =
            report::compare_report(&side(pa.label, &sa), &side(pb.label, &sb));
        let mut notes: Vec<String> = [pa.note, pb.note, timeout_note]
            .into_iter()
            .flatten()
            .collect();
        if !pa.redactor.is_empty() || !pb.redactor.is_empty() {
            notes.push(
                "Values substituted from the environment are shown as their {{NAME}} wherever \
                 a response repeats them."
                    .into(),
            );
        }
        notes.push(match (&sa.recorded, &sb.recorded) {
            (Ok(()), Ok(())) => "Both requests are recorded in Agent Studio's API history.".into(),
            (Err(e), _) | (_, Err(e)) => e.clone(),
        });
        message.push_str("\n\n");
        message.push_str(&notes.join("\n"));
        if let Value::Object(d) = &mut data {
            d.insert("historyIds".into(), json!([sa.history_id, sb.history_id]));
        }
        Ok(ToolOk::new(message, data))
    })
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
