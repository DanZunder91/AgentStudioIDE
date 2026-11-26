//! The env every PTY the IDE spawns gets. Pure: the user's environment is a parameter, never
//! read here, so the tests need no `set_var` (a global env write races every parallel test
//! thread).

use std::path::Path;

/// Set to `http://t-<terminalId>:x@127.0.0.1:<port>`.
pub const PROXY_VARS: [&str; 5] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "grpc_proxy",
];

/// Pointed at the CA bundle (OS anchors + Mozilla set + our CA).
pub const CA_VARS: [&str; 9] = [
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "AWS_CA_BUNDLE",
    "DENO_CERT",
    "CARGO_HTTP_CAINFO",
    "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
];

/// `1` makes Node's built-in `fetch`/`http` honour `HTTP(S)_PROXY` (Node ≥ 24.5, 22.21+).
/// Node 22.21+ then warns `EnvHttpProxyAgent is experimental` in EVERY process; the preload in
/// `NODE_OPTIONS` ([`super::nodewarn`]) silences it.
pub const NODE_USE_ENV_PROXY: &str = "NODE_USE_ENV_PROXY";
/// Node's options variable. The user's own value is kept; [`super::nodewarn::node_options`]
/// appends the warning preload to it.
pub const NODE_OPTIONS: &str = "NODE_OPTIONS";

/// `0` = strict agent capture off (the curl shim leaves bypass arguments alone), else `1`.
/// The `strictAgentCapture` pref ([`super::prefs::Prefs::strict_agent_capture`]).
pub const STRICT_VAR: &str = "AGENTSTUDIO_PROXY_STRICT";
/// This terminal's proxy URL — what the shim compares `HTTP(S)_PROXY` against, so it only
/// rewrites curl when the proxy in effect is ours.
pub const PROXY_URL_VAR: &str = "AGENTSTUDIO_PROXY_URL";
/// The IDE's `NO_PROXY` ([`no_proxy_union`]) — what the shim resets an inherited `*` to.
pub const NO_PROXY_VAR: &str = "AGENTSTUDIO_NO_PROXY";
/// The shim's directory — what the SessionStart hook puts back at the front of `PATH` for
/// Claude Code's Bash tool via `$CLAUDE_ENV_FILE` (see [`super::shim`]).
pub const SHIM_DIR_VAR: &str = "AGENTSTUDIO_SHIM_DIR";

/// A user proxy variable we must not override, matched case-insensitively.
const USER_PROXY_NAMES: [&str; 3] = ["http_proxy", "https_proxy", "all_proxy"];

/// The name of the first non-empty proxy variable in the user's environment, if any.
pub fn user_proxy_var(user_env: &[(String, String)]) -> Option<String> {
    user_env
        .iter()
        .find(|(k, v)| {
            !v.trim().is_empty() && USER_PROXY_NAMES.contains(&k.to_ascii_lowercase().as_str())
        })
        .map(|(k, _)| k.clone())
}

/// The variables of `user_env` that [`compute`] reads (`*_proxy` / `no_proxy` /
/// `NODE_OPTIONS`, any case) — what a long-lived proxy keeps of the user's environment instead
/// of the whole thing.
pub fn proxy_related(user_env: &[(String, String)]) -> Vec<(String, String)> {
    user_env
        .iter()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            USER_PROXY_NAMES.contains(&k.as_str()) || k == "no_proxy" || k == "node_options"
        })
        .cloned()
        .collect()
}

/// The user's `NODE_OPTIONS` (any case on Windows, where variable names are case-insensitive).
fn user_node_options(user_env: &[(String, String)], windows: bool) -> Option<&str> {
    user_env
        .iter()
        .find(|(k, _)| {
            if windows {
                k.eq_ignore_ascii_case(NODE_OPTIONS)
            } else {
                k == NODE_OPTIONS
            }
        })
        .map(|(_, v)| v.as_str())
}

/// The terminal a process belongs to, from its [`PROXY_URL_VAR`] for THIS `port`: attribution
/// for clients that don't send the URL's credentials (PS 5.1 only answers a 407, which we
/// never send). Variable names match case-insensitively (Windows).
pub fn terminal_from_env(env: &[(String, String)], port: u16) -> Option<String> {
    let url = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(PROXY_URL_VAR))
        .map(|(_, v)| v.as_str())?;
    let rest = url.strip_prefix("http://")?;
    let (userinfo, host) = rest.rsplit_once('@')?;
    if host.trim_end_matches('/') != format!("127.0.0.1:{port}") {
        return None;
    }
    let user = userinfo.split_once(':').map_or(userinfo, |(u, _)| u);
    let id = percent_encoding::percent_decode_str(user.strip_prefix("t-")?)
        .decode_utf8()
        .ok()?
        .into_owned();
    (!id.is_empty()).then_some(id)
}

/// The status line's explanation when injection is skipped.
pub fn skipped_reason(user_env: &[(String, String)]) -> Option<String> {
    user_proxy_var(user_env).map(|k| format!("{k} already set in your environment"))
}

/// User's `NO_PROXY` ∪ `no_proxy`, deduped, in order. Loopback is deliberately NOT added (it is
/// captured); our hook command opts itself out so its token never transits the proxy.
pub fn no_proxy_union(user_env: &[(String, String)]) -> String {
    let mut out: Vec<String> = Vec::new();
    let user = user_env
        .iter()
        .filter(|(k, _)| k == "NO_PROXY" || k == "no_proxy")
        .flat_map(|(_, v)| v.split(','));
    for entry in user.map(str::trim) {
        if !entry.is_empty() && !out.iter().any(|e| e.eq_ignore_ascii_case(entry)) {
            out.push(entry.to_string());
        }
    }
    out.join(",")
}

/// RFC 3986 `unreserved` stays literal; everything else is escaped in the userinfo.
const USERINFO: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The proxy URL for one terminal. The id is percent-encoded into the userinfo so any id
/// survives the URL grammar; [`super::proxy::attribution`] decodes it.
pub fn proxy_url(terminal_id: &str, port: u16) -> String {
    let user = percent_encoding::utf8_percent_encode(terminal_id, USERINFO);
    format!("http://t-{user}:x@127.0.0.1:{port}")
}

/// What `pty_env` knows about the running proxy.
#[derive(Debug, Clone, Copy)]
pub struct EnvInputs<'a> {
    /// `None` = the proxy is not running.
    pub port: Option<u16>,
    pub enabled: bool,
    /// The CA bundle, once written. `None` = no CA vars (decrypt is then passthrough-only).
    pub ca_bundle: Option<&'a Path>,
    /// The `curl` shim's directory ([`super::shim::ensure`]). `None` = no shim (no config
    /// dir, or it could not be written): `PATH` is left alone.
    pub shim_dir: Option<&'a Path>,
    /// The `PATH` the PTY would otherwise inherit — the shim goes in front of it.
    pub base_path: Option<&'a str>,
    /// `strictAgentCapture` → [`STRICT_VAR`].
    pub strict: bool,
    /// The Node warning preload ([`super::nodewarn::ensure`]). `None` = `NODE_OPTIONS` is
    /// left alone.
    pub node_preload: Option<&'a Path>,
    /// Compute for Windows (a parameter, so every OS tests both): the shim is never on `PATH` there
    /// (PowerShell opens the extensionless `curl` as a document); only [`SHIM_DIR_VAR`] is set.
    pub windows: bool,
}

/// The env to add to a PTY. Empty when the proxy is not running, capture is disabled, or the
/// user's environment already names a proxy (we never silently override a corporate proxy).
pub fn compute(
    inputs: EnvInputs<'_>,
    terminal_id: &str,
    user_env: &[(String, String)],
) -> Vec<(String, String)> {
    let Some(port) = inputs.port else {
        return Vec::new();
    };
    if !inputs.enabled || user_proxy_var(user_env).is_some() {
        return Vec::new();
    }
    let url = proxy_url(terminal_id, port);
    let mut out: Vec<(String, String)> = PROXY_VARS
        .iter()
        .map(|k| (k.to_string(), url.clone()))
        .collect();
    let no_proxy = no_proxy_union(user_env);
    out.push(("NO_PROXY".into(), no_proxy.clone()));
    out.push(("no_proxy".into(), no_proxy.clone()));
    out.push((NODE_USE_ENV_PROXY.into(), "1".into()));
    if let Some(preload) = inputs.node_preload {
        out.push((
            NODE_OPTIONS.into(),
            super::nodewarn::node_options(user_node_options(user_env, inputs.windows), preload),
        ));
    }
    out.push((
        STRICT_VAR.into(),
        if inputs.strict { "1" } else { "0" }.into(),
    ));
    out.push((PROXY_URL_VAR.into(), url));
    out.push((NO_PROXY_VAR.into(), no_proxy));
    if let Some(dir) = inputs.shim_dir {
        if !inputs.windows {
            out.push((
                "PATH".into(),
                super::shim::prepend_path(dir, inputs.base_path),
            ));
        }
        out.push((SHIM_DIR_VAR.into(), dir.to_string_lossy().into_owned()));
    }
    if let Some(bundle) = inputs.ca_bundle {
        let b = bundle.to_string_lossy().into_owned();
        out.extend(CA_VARS.iter().map(|k| (k.to_string(), b.clone())));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn get<'a>(out: &'a [(String, String)], k: &str) -> Option<&'a str> {
        out.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    const RUNNING: EnvInputs<'static> = EnvInputs {
        port: Some(4711),
        enabled: true,
        ca_bundle: None,
        shim_dir: None,
        base_path: None,
        strict: true,
        node_preload: None,
        windows: false,
    };

    #[test]
    fn a_running_enabled_proxy_injects_every_proxy_var_with_attribution() {
        let out = compute(RUNNING, "term-1", &env(&[("PATH", "/bin")]));
        for k in PROXY_VARS {
            assert_eq!(
                get(&out, k),
                Some("http://t-term-1:x@127.0.0.1:4711"),
                "{k}"
            );
        }
        // Loopback is captured, so it is NOT in NO_PROXY.
        assert_eq!(get(&out, "NO_PROXY"), Some(""));
        assert_eq!(get(&out, "no_proxy"), Some(""));
        assert_eq!(get(&out, "NODE_USE_ENV_PROXY"), Some("1"));
        assert_eq!(get(&out, "SSL_CERT_FILE"), None, "no bundle, no CA vars");
    }

    #[test]
    fn nothing_is_injected_when_not_running_or_disabled() {
        let stopped = EnvInputs {
            port: None,
            ..RUNNING
        };
        assert!(compute(stopped, "t", &[]).is_empty());
        let off = EnvInputs {
            enabled: false,
            ..RUNNING
        };
        assert!(compute(off, "t", &[]).is_empty());
    }

    #[test]
    fn a_user_proxy_var_in_any_case_skips_injection() {
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "Https_Proxy",
        ] {
            let user = env(&[(name, "http://corp:3128")]);
            assert!(compute(RUNNING, "t", &user).is_empty(), "{name}");
            assert_eq!(
                skipped_reason(&user),
                Some(format!("{name} already set in your environment"))
            );
        }
    }

    #[test]
    fn an_empty_or_unrelated_proxy_var_does_not_skip() {
        let user = env(&[("HTTPS_PROXY", "  "), ("NO_PROXY", "corp.internal")]);
        assert!(!compute(RUNNING, "t", &user).is_empty());
        assert_eq!(skipped_reason(&user), None);
    }

    #[test]
    fn no_proxy_is_the_union_of_both_spellings_without_adding_loopback() {
        let user = env(&[
            ("NO_PROXY", "corp.internal, .svc"),
            ("no_proxy", "10.0.0.0/8,corp.internal"),
        ]);
        assert_eq!(no_proxy_union(&user), "corp.internal,.svc,10.0.0.0/8");
        let out = compute(RUNNING, "t", &user);
        let np = get(&out, "NO_PROXY").unwrap();
        assert_eq!(np, "corp.internal,.svc,10.0.0.0/8");
        for local in ["localhost", "127.0.0.1", "::1"] {
            assert!(
                !np.split(',').any(|e| e == local),
                "{local} must be captured, not bypassed: {np}"
            );
        }
        // …but a user who bypasses loopback themselves is still honoured.
        let theirs = env(&[("NO_PROXY", "localhost")]);
        assert_eq!(
            get(&compute(RUNNING, "t", &theirs), "NO_PROXY"),
            Some("localhost")
        );
    }

    #[test]
    fn the_ca_bundle_is_named_by_every_ca_var() {
        let p = Path::new("/cfg/netcap/ca-bundle.pem");
        let out = compute(
            EnvInputs {
                ca_bundle: Some(p),
                ..RUNNING
            },
            "t",
            &[],
        );
        for k in CA_VARS {
            assert_eq!(get(&out, k), Some("/cfg/netcap/ca-bundle.pem"), "{k}");
        }
        assert_eq!(out.len(), PROXY_VARS.len() + 6 + CA_VARS.len());
    }

    #[test]
    fn proxy_related_keeps_only_what_compute_reads_and_computes_the_same() {
        let user = env(&[
            ("PATH", "/bin"),
            ("NPM_TOKEN", "sentinel"),
            ("Https_Proxy", "http://corp:3128"),
            ("no_proxy", "corp.internal"),
            ("ALL_PROXY", "socks5://x"),
        ]);
        let kept = proxy_related(&user);
        let keys: Vec<&str> = kept.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["Https_Proxy", "no_proxy", "ALL_PROXY"]);
        assert_eq!(compute(RUNNING, "t", &kept), compute(RUNNING, "t", &user));
        let plain = env(&[
            ("PATH", "/bin"),
            ("NO_PROXY", "a,b"),
            ("NODE_OPTIONS", "--max-old-space-size=4096"),
        ]);
        let with_preload = EnvInputs {
            node_preload: Some(Path::new("/cfg/netcap/node/p.cjs")),
            ..RUNNING
        };
        assert_eq!(
            compute(with_preload, "t", &proxy_related(&plain)),
            compute(with_preload, "t", &plain),
            "NODE_OPTIONS is read by compute, so the proxy keeps it"
        );
    }

    /// Node's `NODE_OPTIONS` gets the warning preload appended to the user's own value — never
    /// replaced — and only when there is a preload; on Windows the user's variable is found in
    /// any case.
    #[test]
    fn node_options_keeps_the_users_value_and_appends_the_preload() {
        let p = Path::new("/cfg/netcap/node/p.cjs");
        let on = EnvInputs {
            node_preload: Some(p),
            ..RUNNING
        };
        assert_eq!(get(&compute(RUNNING, "t", &[]), NODE_OPTIONS), None);
        assert_eq!(
            get(&compute(on, "t", &[]), NODE_OPTIONS),
            Some("--require \"/cfg/netcap/node/p.cjs\"")
        );
        let theirs = env(&[("NODE_OPTIONS", "--max-old-space-size=4096")]);
        assert_eq!(
            get(&compute(on, "t", &theirs), NODE_OPTIONS),
            Some("--max-old-space-size=4096 --require \"/cfg/netcap/node/p.cjs\"")
        );
        // `Node_Options` is the same variable on Windows only.
        let odd = env(&[("Node_Options", "--inspect")]);
        assert_eq!(
            get(&compute(on, "t", &odd), NODE_OPTIONS),
            Some("--require \"/cfg/netcap/node/p.cjs\"")
        );
        let win = EnvInputs {
            windows: true,
            ..on
        };
        assert_eq!(
            get(&compute(win, "t", &odd), NODE_OPTIONS),
            Some("--inspect --require \"/cfg/netcap/node/p.cjs\"")
        );
        // Capture off: nothing at all, NODE_OPTIONS included.
        let off = EnvInputs {
            enabled: false,
            ..on
        };
        assert!(compute(off, "t", &theirs).is_empty());
    }

    /// Windows: the shim dir is exported for agents' Git Bash but NEVER put on `PATH`
    /// (Windows PowerShell would try to open the extensionless `curl` as a document).
    #[test]
    fn on_windows_the_shim_dir_is_exported_but_path_is_left_alone() {
        let shim = Path::new(r"C:\Users\a b\AppData\Roaming\ide\netcap\bin");
        let win = EnvInputs {
            shim_dir: Some(shim),
            base_path: Some(r"C:\Windows\System32;C:\Program Files\Git\cmd"),
            windows: true,
            ..RUNNING
        };
        let out = compute(win, "t", &[]);
        assert_eq!(get(&out, "PATH"), None, "{out:?}");
        assert!(
            !out.iter().any(|(k, _)| k.eq_ignore_ascii_case("path")),
            "{out:?}"
        );
        assert_eq!(
            get(&out, SHIM_DIR_VAR),
            Some(r"C:\Users\a b\AppData\Roaming\ide\netcap\bin")
        );
        // The same inputs off Windows: PATH gets the shim first, as before.
        let unix = compute(
            EnvInputs {
                windows: false,
                ..win
            },
            "t",
            &[],
        );
        assert!(get(&unix, "PATH").is_some_and(|p| p.starts_with(r"C:\Users\a b")));
    }

    #[test]
    fn a_processes_terminal_is_read_from_its_proxy_url_for_this_port_only() {
        let url = proxy_url("a:b/term 1", 4711);
        let e = env(&[("AGENTSTUDIO_PROXY_URL", url.as_str())]);
        assert_eq!(terminal_from_env(&e, 4711).as_deref(), Some("a:b/term 1"));
        // Windows hands variable names back in whatever case they were set.
        let lower = env(&[("agentstudio_proxy_url", url.as_str())]);
        assert_eq!(
            terminal_from_env(&lower, 4711).as_deref(),
            Some("a:b/term 1")
        );
        // Another IDE's proxy, or not ours at all.
        assert_eq!(terminal_from_env(&e, 4712), None);
        for bad in [
            "http://corp:3128",
            "http://u-x:x@127.0.0.1:4711",
            "http://t-:x@127.0.0.1:4711",
            "https://t-a:x@127.0.0.1:4711",
            "http://t-a:x@10.0.0.1:4711",
            "",
        ] {
            assert_eq!(
                terminal_from_env(&env(&[("AGENTSTUDIO_PROXY_URL", bad)]), 4711),
                None,
                "{bad}"
            );
        }
        assert_eq!(terminal_from_env(&env(&[("HTTP_PROXY", &url)]), 4711), None);
    }

    #[test]
    fn the_shim_vars_ride_along_and_path_gets_the_shim_first() {
        let out = compute(RUNNING, "term-1", &env(&[("NO_PROXY", "corp.internal")]));
        assert_eq!(get(&out, STRICT_VAR), Some("1"));
        assert_eq!(
            get(&out, PROXY_URL_VAR),
            Some("http://t-term-1:x@127.0.0.1:4711"),
            "the shim compares HTTP(S)_PROXY against exactly this"
        );
        assert_eq!(get(&out, PROXY_URL_VAR), get(&out, "HTTPS_PROXY"));
        assert_eq!(get(&out, NO_PROXY_VAR), Some("corp.internal"));
        assert_eq!(get(&out, "PATH"), None, "no shim, PATH untouched");
        assert_eq!(get(&out, SHIM_DIR_VAR), None);

        let shim = Path::new("/cfg/netcap/bin");
        let with = EnvInputs {
            shim_dir: Some(shim),
            base_path: Some("/opt/homebrew/bin:/usr/bin:/bin"),
            strict: false,
            ..RUNNING
        };
        let out = compute(with, "t", &[]);
        assert_eq!(
            get(&out, "PATH"),
            Some("/cfg/netcap/bin:/opt/homebrew/bin:/usr/bin:/bin")
        );
        assert_eq!(get(&out, SHIM_DIR_VAR), Some("/cfg/netcap/bin"));
        assert_eq!(get(&out, STRICT_VAR), Some("0"));
        // Capture off ⇒ not even the shim: nothing at all is injected.
        let off = EnvInputs {
            enabled: false,
            ..with
        };
        assert!(compute(off, "t", &[]).is_empty());
    }

    #[test]
    fn a_hostile_terminal_id_cannot_escape_the_userinfo() {
        let url = proxy_url("a:b@evil/x", 1);
        assert_eq!(url, "http://t-a%3Ab%40evil%2Fx:x@127.0.0.1:1");
    }
}
