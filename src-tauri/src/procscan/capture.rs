//! `DevApp.captured` for an IDE app: `null` if its env is unreadable or we inject no proxy;
//! `true` only if BOTH `HTTP(S)_PROXY` (either case) point at our loopback port and `NO_PROXY`
//! has no `*`. The env holds secrets: read in Rust, reduced to this bool, never sent or logged.

/// The captured-ness of one app (module doc). `env` = its environment, `None` when the OS
/// would not give it; `port` = the port the IDE's proxy is injecting, `None` when it injects
/// nothing.
pub fn captured(env: Option<&[(String, String)]>, port: Option<u16>) -> Option<bool> {
    captured_with(env, port, cfg!(windows))
}

/// [`captured`] with the name rule explicit: `fold` = variable names match without ASCII case,
/// as they do on Windows (`Https_Proxy` IS `HTTPS_PROXY` there, and a process holds one of
/// them, in whatever spelling it was first set). A parameter so every OS tests both answers.
pub fn captured_with(
    env: Option<&[(String, String)]>,
    port: Option<u16>,
    fold: bool,
) -> Option<bool> {
    let port = port?;
    let env = env.filter(|e| !e.is_empty())?;
    let same = |n: &str, k: &str| {
        if fold {
            n.eq_ignore_ascii_case(k)
        } else {
            n == k
        }
    };
    let get = |k: &str| {
        env.iter()
            .find(|(n, _)| same(n, k))
            .map(|(_, v)| v.as_str())
    };
    let bypass_all = ["NO_PROXY", "no_proxy"]
        .iter()
        .any(|k| get(k).is_some_and(|v| v.split(',').any(|e| e.trim() == "*")));
    if bypass_all {
        return Some(false);
    }
    let scheme_ok = |names: [&str; 2]| {
        names
            .iter()
            .any(|k| get(k).is_some_and(|v| points_at(v, port)))
    };
    Some(scheme_ok(["HTTP_PROXY", "http_proxy"]) && scheme_ok(["HTTPS_PROXY", "https_proxy"]))
}

/// Does the proxy URL `v` name loopback:`port`? Scheme optional (`127.0.0.1:4711` is valid to
/// most clients), userinfo ignored (the IDE puts the terminal id there), path ignored.
pub fn points_at(v: &str, port: u16) -> bool {
    let v = v.trim();
    let rest = match v.find("://") {
        Some(i) => &v[i + 3..],
        None => v,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let hostport = authority.rsplit_once('@').map_or(authority, |(_, hp)| hp);
    let Some((host, p)) = hostport.rsplit_once(':') else {
        return false;
    };
    let loopback = matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]"
    );
    loopback && p.parse::<u16>() == Ok(port)
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

    /// (what, the env, the injected port, the expected flag).
    type Case = (
        &'static str,
        Option<Vec<(String, String)>>,
        Option<u16>,
        Option<bool>,
    );

    const OURS: &str = "http://t-term-1:x@127.0.0.1:4711";

    /// The flag rules (module doc), hand-written expectations.
    #[test]
    fn the_flag_table() {
        let all = env(&[
            ("HTTP_PROXY", OURS),
            ("HTTPS_PROXY", OURS),
            ("http_proxy", OURS),
            ("https_proxy", OURS),
            ("PATH", "/bin"),
        ]);
        let cases: Vec<Case> = vec![
            ("every var ours", Some(all.clone()), Some(4711), Some(true)),
            (
                "only the uppercase pair",
                Some(env(&[("HTTP_PROXY", OURS), ("HTTPS_PROXY", OURS)])),
                Some(4711),
                Some(true),
            ),
            (
                "only the lowercase pair",
                Some(env(&[("http_proxy", OURS), ("https_proxy", OURS)])),
                Some(4711),
                Some(true),
            ),
            (
                "stripped (env -u HTTP_PROXY …)",
                Some(env(&[("PATH", "/bin"), ("NO_PROXY", "")])),
                Some(4711),
                Some(false),
            ),
            (
                "HTTP only — HTTPS goes direct",
                Some(env(&[("HTTP_PROXY", OURS), ("http_proxy", OURS)])),
                Some(4711),
                Some(false),
            ),
            (
                "another port (a previous launch's proxy)",
                Some(env(&[
                    ("HTTP_PROXY", "http://t-a:x@127.0.0.1:4712"),
                    ("HTTPS_PROXY", "http://t-a:x@127.0.0.1:4712"),
                ])),
                Some(4711),
                Some(false),
            ),
            (
                "another host on our port",
                Some(env(&[
                    ("HTTP_PROXY", "http://corp:4711"),
                    ("HTTPS_PROXY", "http://corp:4711"),
                ])),
                Some(4711),
                Some(false),
            ),
            (
                "NO_PROXY=* bypasses everything",
                Some({
                    let mut e = all.clone();
                    e.push(("NO_PROXY".into(), "localhost, *".into()));
                    e
                }),
                Some(4711),
                Some(false),
            ),
            (
                "no_proxy without * is fine",
                Some({
                    let mut e = all.clone();
                    e.push(("no_proxy".into(), "corp.internal".into()));
                    e
                }),
                Some(4711),
                Some(true),
            ),
            ("unreadable env", None, Some(4711), None),
            ("hidden env (empty)", Some(Vec::new()), Some(4711), None),
            ("the IDE injects nothing", Some(all.clone()), None, None),
        ];
        for (what, e, port, want) in cases {
            // The table's spellings are exact, so both name rules agree on every row.
            for fold in [false, true] {
                assert_eq!(
                    captured_with(e.as_deref(), port, fold),
                    want,
                    "{what} (fold: {fold})"
                );
            }
            assert_eq!(captured(e.as_deref(), port), want, "{what}");
        }
    }

    /// Windows names are case-insensitive: a mixed spelling is the same variable there, and a
    /// different (unknown) one on unix.
    #[test]
    fn on_windows_proxy_names_match_without_case() {
        let mixed = env(&[("Http_Proxy", OURS), ("Https_Proxy", OURS)]);
        assert_eq!(captured_with(Some(&mixed), Some(4711), true), Some(true));
        assert_eq!(captured_with(Some(&mixed), Some(4711), false), Some(false));
        let bypass = env(&[
            ("HTTP_PROXY", OURS),
            ("HTTPS_PROXY", OURS),
            ("No_Proxy", "*"),
        ]);
        assert_eq!(captured_with(Some(&bypass), Some(4711), true), Some(false));
        assert_eq!(captured_with(Some(&bypass), Some(4711), false), Some(true));
        assert_eq!(
            captured(Some(&mixed), Some(4711)),
            Some(cfg!(windows)),
            "this OS's rule"
        );
    }

    #[test]
    fn proxy_urls() {
        assert!(points_at(OURS, 4711));
        assert!(points_at("127.0.0.1:4711", 4711));
        assert!(points_at(" http://localhost:4711/ ", 4711));
        assert!(points_at("http://[::1]:4711", 4711));
        assert!(points_at("HTTP://LOCALHOST:4711", 4711));
        assert!(!points_at("http://127.0.0.1", 4711));
        assert!(!points_at("http://127.0.0.1:47110", 4711));
        assert!(!points_at("http://127.0.0.1:x", 4711));
        assert!(!points_at("", 4711));
        // A hostile userinfo cannot fake the host.
        assert!(!points_at("http://127.0.0.1:4711@evil:80", 4711));
    }
}
