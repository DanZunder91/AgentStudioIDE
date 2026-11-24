//! The wire types of the Network view — `src/features/network/networkTypes.ts` mirrors these
//! field for field (serde camelCase).

use serde::{Deserialize, Serialize};

pub use super::client::ClientProcess;

/// What kind of traffic a flow is. `tunnel` = a `CONNECT` we did not (or could not) decrypt.
/// `bypass` = NOT traffic the proxy saw: an agent command that skipped the proxy
/// (`curl --noproxy '*'`, `NO_PROXY=*`), recorded from the command itself so the table can say
/// it happened (its [`FlowSummary::bypass`] carries the command). Additive: no proxy path ever
/// produces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowProto {
    Http,
    Https,
    Ws,
    Wss,
    Grpc,
    Tunnel,
    Bypass,
}

/// What is known about a command that bypassed the proxy (`proto: "bypass"`). `method` / `url`
/// are what could be parsed from a `curl` command line; `None` when it was not a curl or the
/// URL could not be read. The TS mirror is `BypassInfo` in `networkTypes.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassInfo {
    /// The command, verbatim as the agent ran it (captured traffic is never redacted).
    pub command: String,
    pub method: Option<String>,
    pub url: Option<String>,
    /// The agent whose transcript held the command (a sub-agent for its own calls). The row's
    /// `terminalId` is that agent's root terminal. Added with the curl shim.
    pub agent_id: Option<String>,
    /// The transcript's `tool_use.id` — the same id its Agent Logs line carries.
    pub tool_use_id: Option<String>,
    /// What bypassed, in command order, each once (`logstream::bypass`): `--noproxy`,
    /// `-x ''`, `NO_PROXY=*`, `NO_PROXY=`, `*_PROXY=''`, `unset *_proxy`, `env -u *_proxy`,
    /// `env -i`, `--no-proxy`.
    pub reasons: Vec<String>,
    /// The `curl` shim undid it (strict agent capture on, and every reason was a curl's own
    /// `--noproxy` / `-x ''` / `NO_PROXY=*`): the request itself IS in Network as a normal row.
    /// `false` = it really was not captured.
    pub neutralized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowState {
    Pending,
    Done,
    Error,
}

/// WebSocket data-message counts. `up` = client → server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WsCounts {
    pub up: u64,
    pub down: u64,
}

/// One row of the Network table. Emitted on `netcap://flow` as an upsert keyed by `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSummary {
    pub id: u64,
    pub started_ms: u64,
    pub proto: FlowProto,
    pub method: String,
    pub host: String,
    pub port: u16,
    /// `""` for a tunnel; `/pkg.Svc/Method` for gRPC; path + query otherwise.
    pub path: String,
    pub status: Option<u16>,
    pub grpc_status: Option<i32>,
    pub content_type: Option<String>,
    pub req_bytes: u64,
    pub res_bytes: u64,
    pub duration_ms: Option<u64>,
    pub state: FlowState,
    pub error: Option<String>,
    /// From the proxy userinfo (`t-<terminalId>:x@`). `None` = unattributed.
    pub terminal_id: Option<String>,
    /// `"HTTP/1.1"`, `"HTTP/2"`, or `""` for a tunnel.
    pub http_version: String,
    pub ws_messages: Option<WsCounts>,
    /// The process that opened the proxy connection. `None` = not resolved
    /// (Windows, or the process could not be found).
    pub client: Option<ClientProcess>,
    /// Informational text that is not an error — e.g. why a decrypt-mode connection was
    /// tunnelled (`not decrypted: gazelle doesn't read the IDE's CA`).
    pub note: Option<String>,
    /// Set only on a `bypass` row. Omitted from the wire when `None`, so every proxied flow
    /// (and every golden) keeps exactly the keys it had.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bypass: Option<BypassInfo>,
}

impl FlowSummary {
    /// A fresh pending row; the store assigns `id`.
    pub fn pending(proto: FlowProto, method: &str, host: &str, port: u16, path: &str) -> Self {
        FlowSummary {
            id: 0,
            started_ms: now_ms(),
            proto,
            method: method.to_string(),
            host: host.to_string(),
            port,
            path: path.to_string(),
            status: None,
            grpc_status: None,
            content_type: None,
            req_bytes: 0,
            res_bytes: 0,
            duration_ms: None,
            state: FlowState::Pending,
            error: None,
            terminal_id: None,
            http_version: String::new(),
            ws_messages: None,
            client: None,
            note: None,
            bypass: None,
        }
    }

    /// A finished `bypass` row for a command that skipped the proxy: nothing went through us,
    /// so there is no status, no bytes and no duration — only the command and, when it could be
    /// parsed, its method and URL (host / port / path are filled from the URL for the table's
    /// Host and Path columns and its host filter).
    pub fn bypassed(command: &str, method: Option<&str>, url: Option<&str>) -> Self {
        let (host, port, path) = url.map(split_url).unwrap_or_default();
        let mut s =
            FlowSummary::pending(FlowProto::Bypass, method.unwrap_or(""), &host, port, &path);
        s.state = FlowState::Done;
        s.bypass = Some(BypassInfo {
            command: command.to_string(),
            method: method.map(str::to_string),
            url: url.map(str::to_string),
            agent_id: None,
            tool_use_id: None,
            reasons: Vec::new(),
            neutralized: false,
        });
        s
    }
}

/// `https://api.x.io:8443/v1?q=1` → (`api.x.io`, 8443, `/v1?q=1`). A missing scheme is read as
/// `http`; a missing port is the scheme's default; anything unreadable yields empty parts.
fn split_url(url: &str) -> (String, u16, String) {
    let (scheme, rest) = url.split_once("://").unwrap_or(("http", url));
    let default_port = if scheme.eq_ignore_ascii_case("https") {
        443
    } else {
        80
    };
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, String::new()),
    };
    // Userinfo is never part of the host (and never shown).
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // `[::1]:9000` — only a colon after the closing bracket is a port separator.
    let port_sep = if authority.starts_with('[') {
        authority.find("]:").map(|i| i + 1)
    } else {
        authority.rfind(':')
    };
    let (host, port) = match port_sep.map(|i| (&authority[..i], authority[i + 1..].parse())) {
        Some((h, Ok(p))) => (h, p),
        _ => (authority, default_port),
    };
    let path = if path.starts_with('?') {
        format!("/{path}")
    } else {
        path
    };
    (host.to_string(), port, path)
}

/// A captured body as the UI sees it. Exactly one of `text` / `base64` is set when the body
/// is non-empty (`text` when the — decoded — bytes are valid UTF-8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowBody {
    /// Bytes seen on the wire (before content-decoding), even past the capture cap.
    pub size: u64,
    /// The capture hit the 1 MiB cap; `text`/`base64` hold only the first MiB.
    pub truncated: bool,
    pub text: Option<String>,
    pub base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDetail {
    pub summary: FlowSummary,
    /// Redacted at capture — the raw value of a sensitive header never entered the store.
    pub request_headers: Vec<(String, String)>,
    pub response_headers: Vec<(String, String)>,
    pub response_trailers: Vec<(String, String)>,
    pub request_body: Option<FlowBody>,
    pub response_body: Option<FlowBody>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetcapStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub enabled: bool,
    pub decrypt: bool,
    pub ca_path: Option<String>,
    pub skipped_reason: Option<String>,
    pub passthrough_hosts: Vec<String>,
    pub flow_count: usize,
    /// Apps the user opted in to decryption, in the order they were added.
    pub decrypt_apps: Vec<String>,
    /// Set when the saved port was taken at startup and the proxy moved, so the UI can
    /// say "Postman must be updated to port N". `None` = the port is the one apps were given.
    pub port_changed: Option<PortChange>,
    /// The `strictAgentCapture` pref ([`super::prefs::Prefs::strict_agent_capture`]).
    pub strict_agent_capture: bool,
}

/// The proxy could not have its saved port back: it was `from`, it is `to` now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortChange {
    pub from: u16,
    pub to: u16,
}

/// Unix milliseconds, saturating at 0 on a clock before 1970.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS side reads these exact keys; a rename here is a silent UI break.
    #[test]
    fn summary_serialises_with_the_contract_keys() {
        let mut s = FlowSummary::pending(FlowProto::Grpc, "POST", "h", 443, "/a.B/C");
        s.ws_messages = Some(WsCounts { up: 1, down: 2 });
        let v = serde_json::to_value(&s).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "client",
                "contentType",
                "durationMs",
                "error",
                "grpcStatus",
                "host",
                "httpVersion",
                "id",
                "method",
                "note",
                "path",
                "port",
                "proto",
                "reqBytes",
                "resBytes",
                "startedMs",
                "state",
                "status",
                "terminalId",
                "wsMessages"
            ]
        );
        assert_eq!(obj["proto"], "grpc");
        assert_eq!(obj["state"], "pending");
        assert_eq!(obj["wsMessages"], serde_json::json!({"up": 1, "down": 2}));
        assert!(obj["client"].is_null() && obj["note"].is_null());
        s.client = Some(ClientProcess {
            pid: 42,
            name: "curl".into(),
            path: Some("/usr/bin/curl".into()),
        });
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v["client"],
            serde_json::json!({"pid": 42, "name": "curl", "path": "/usr/bin/curl"})
        );
    }

    /// A proxied flow never carries `bypass` on the wire (the contract keys above are exact);
    /// a bypass row carries it in the TS mirror's shape.
    #[test]
    fn a_bypass_row_carries_the_command_and_its_parsed_request() {
        let s = FlowSummary::bypassed(
            "curl --noproxy '*' -X POST https://api.example.com:8443/v1/items?x=1",
            Some("POST"),
            Some("https://api.example.com:8443/v1/items?x=1"),
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["proto"], "bypass");
        assert_eq!(v["state"], "done");
        assert_eq!(v["method"], "POST");
        assert_eq!(
            (v["host"].as_str(), v["port"].as_u64(), v["path"].as_str()),
            (Some("api.example.com"), Some(8443), Some("/v1/items?x=1"))
        );
        assert!(v["status"].is_null() && v["durationMs"].is_null());
        assert_eq!(
            v["bypass"],
            serde_json::json!({
                "command": "curl --noproxy '*' -X POST https://api.example.com:8443/v1/items?x=1",
                "method": "POST",
                "url": "https://api.example.com:8443/v1/items?x=1",
                "agentId": null,
                "toolUseId": null,
                "reasons": [],
                "neutralized": false
            })
        );
        // Round-trips (the store clones through serde in tests).
        let back: FlowSummary = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn an_unparsed_bypass_has_only_the_command() {
        let s = FlowSummary::bypassed("NO_PROXY='*' ./fetch-things", None, None);
        assert_eq!(
            (s.host.as_str(), s.port, s.path.as_str(), s.method.as_str()),
            ("", 0, "", "")
        );
        let b = s.bypass.unwrap();
        assert_eq!((b.method, b.url), (None, None));
        // A proxied flow without the key still deserialises (older payloads, goldens).
        let mut v =
            serde_json::to_value(FlowSummary::pending(FlowProto::Http, "GET", "h", 80, "/"))
                .unwrap();
        assert!(
            v.get("bypass").is_none(),
            "absent, not null, on a proxied flow"
        );
        v.as_object_mut().unwrap().remove("bypass");
        let f: FlowSummary = serde_json::from_value(v).unwrap();
        assert_eq!(f.bypass, None);
    }

    #[test]
    fn urls_split_into_host_port_and_path() {
        let cases = [
            ("https://a.io/x", ("a.io", 443, "/x")),
            ("http://a.io:8080", ("a.io", 8080, "")),
            ("a.io/p?q", ("a.io", 80, "/p?q")),
            ("https://u:pw@a.io?q=1", ("a.io", 443, "/?q=1")),
            ("http://[::1]:9000/h", ("[::1]", 9000, "/h")),
            ("http://a.io:nope/", ("a.io:nope", 80, "/")),
        ];
        for (url, (h, p, path)) in cases {
            let got = split_url(url);
            assert_eq!(
                (got.0.as_str(), got.1, got.2.as_str()),
                (h, p, path),
                "{url}"
            );
        }
    }

    #[test]
    fn header_pairs_serialise_as_two_element_arrays() {
        let d = FlowDetail {
            summary: FlowSummary::pending(FlowProto::Http, "GET", "h", 80, "/"),
            request_headers: vec![("a".into(), "b".into())],
            response_headers: vec![],
            response_trailers: vec![],
            request_body: None,
            response_body: None,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["requestHeaders"], serde_json::json!([["a", "b"]]));
        assert!(v["responseBody"].is_null());
    }
}
