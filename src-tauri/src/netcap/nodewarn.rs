//! Keep `NODE_USE_ENV_PROXY=1` (capture of Node's built-in `fetch`) without Node 22's
//! experimental warning in every process.
//!
//! **What Node does (measured on 22.23.5).** With `NODE_USE_ENV_PROXY=1` and a
//! proxy variable set, Node 22.21+ builds undici's `EnvHttpProxyAgent` during bootstrap
//! (`setupHttpProxy` in `internal/process/pre_execution`) and undici prints
//! `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any
//! time.` — in every `node` an IDE terminal or agent runs, even `node -e 1`. Older Nodes ignore
//! the variable (no capture, no warning); Node ≥ 24.5 honours it too.
//!
//! **Why not `--disable-warning=UNDICI-EHPA`.** It is the obvious flag, but `NODE_OPTIONS` is
//! read by every Node the terminal ever runs, and a Node that does not know a flag in
//! `NODE_OPTIONS` refuses to start at all (`--disable-warning` exists from 20.11 / 21.3). An
//! nvm user on an older Node would lose every `node`, `npm` and `npx` in IDE terminals to hide
//! one line. A `--require` preload is understood by every Node, so the variable stays safe for
//! all of them.
//!
//! **What the preload does.** It wraps `process.emitWarning` and drops exactly the warnings
//! whose code is `UNDICI-EHPA`; every other warning (deprecations, the user's own) passes
//! through unchanged. Measured: a `--require` module runs BEFORE the bootstrap emits the
//! warning, so the wrapper sees it. Written to `<netcap dir>/node/` like the curl shim
//! (never `~/.claude`), and `pty_env` names it only when the file exists — a `--require` of a
//! missing file would stop Node.
//!
//! **Quoting.** `NODE_OPTIONS` splits on spaces; inside double quotes a backslash escapes the
//! next character (Node's `ParseNodeOptionsEnvVar`). So the path is double-quoted with `\` and
//! `"` escaped — a Windows path (`C:\Users\…`) unescaped inside quotes loses its backslashes
//! (measured: `Cannot find module`), and macOS's `Application Support` needs the quotes.

use std::path::{Path, PathBuf};

/// The preload's directory under the netcap dir.
pub const DIR: &str = "node";
/// The preload's file name (`.cjs`: CommonJS whatever the nearest `package.json` says).
pub const FILE: &str = "quiet-env-proxy-warning.cjs";

/// The preload, verbatim.
pub const PRELOAD: &str = r#"// agentstudio-node-preload v1
// Written by Agent Studio (src-tauri/src/netcap/nodewarn.rs) at every start; edits are overwritten.
// NODE_USE_ENV_PROXY=1 lets the IDE's Network view see Node's fetch; Node 22 then prints an
// "EnvHttpProxyAgent is experimental" warning (code UNDICI-EHPA) in every process. This drops
// that one warning and passes every other warning through unchanged.
'use strict';
(function () {
  var emit = process.emitWarning;
  if (typeof emit !== 'function') return;
  process.emitWarning = function (warning, options) {
    var code = options && typeof options === 'object' ? options.code : arguments[2];
    if (code === undefined && warning && typeof warning === 'object') code = warning.code;
    if (code === 'UNDICI-EHPA') return;
    return emit.apply(this, arguments);
  };
})();
"#;

/// Write `<netcap dir>/node/<FILE>` when missing or different; returns its path. Atomic (temp
/// + rename). `None` on any I/O error (logged: capture still works, the warning shows).
pub fn ensure(netcap_dir: &Path) -> Option<PathBuf> {
    match write(netcap_dir) {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!("netcap: node warning preload not written: {e}");
            None
        }
    }
}

fn write(netcap_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = netcap_dir.join(DIR);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(FILE);
    if std::fs::read(&path).ok().as_deref() != Some(PRELOAD.as_bytes()) {
        let tmp = dir.join(format!(".{FILE}.{}.tmp", ulid::Ulid::new()));
        std::fs::write(&tmp, PRELOAD)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(path)
}

/// `path` as one `NODE_OPTIONS` word: double-quoted, `\` and `"` escaped (module doc).
pub fn quote(path: &Path) -> String {
    let p = path.to_string_lossy();
    format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The `NODE_OPTIONS` a PTY gets: the user's own value (kept verbatim, first) plus
/// `--require <preload>` — unless it already names this preload (an IDE started from an IDE
/// terminal inherits it).
pub fn node_options(user: Option<&str>, preload: &Path) -> String {
    let ours = format!("--require {}", quote(preload));
    match user.map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) if u.contains(&ours) => u.to_string(),
        Some(u) => format!("{u} {ours}"),
        None => ours,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_is_one_quoted_word_with_backslashes_and_quotes_escaped() {
        assert_eq!(
            quote(Path::new(r"C:\Users\A B\AppData\x.cjs")),
            r#""C:\\Users\\A B\\AppData\\x.cjs""#
        );
        assert_eq!(
            quote(Path::new("/Users/a/Library/Application Support/x\".cjs")),
            r#""/Users/a/Library/Application Support/x\".cjs""#
        );
    }

    #[test]
    fn node_options_appends_once_and_keeps_the_users_flags_first() {
        let p = Path::new("/cfg/node/p.cjs");
        assert_eq!(node_options(None, p), r#"--require "/cfg/node/p.cjs""#);
        assert_eq!(
            node_options(Some("  "), p),
            r#"--require "/cfg/node/p.cjs""#
        );
        let once = node_options(Some("--max-old-space-size=4096"), p);
        assert_eq!(
            once,
            r#"--max-old-space-size=4096 --require "/cfg/node/p.cjs""#
        );
        assert_eq!(node_options(Some(&once), p), once, "never twice");
    }

    #[test]
    fn ensure_writes_the_preload_and_repairs_it() {
        let root = std::env::temp_dir().join(format!("nodewarn-{}", ulid::Ulid::new()));
        let p = ensure(&root).expect("written");
        assert_eq!(p, root.join(DIR).join(FILE));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), PRELOAD);
        std::fs::write(&p, "tampered").unwrap();
        assert_eq!(ensure(&root).unwrap(), p);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), PRELOAD);
        let _ = std::fs::remove_dir_all(root);
    }

    /// `node` on this machine's PATH (skipped, with the reason, when absent). `None` = skip.
    fn node_version() -> Option<(u32, u32)> {
        let out = std::process::Command::new("node")
            .arg("--version")
            .output()
            .map_err(|e| eprintln!("SKIP: node is not on PATH ({e})"))
            .ok()?;
        let v = String::from_utf8_lossy(&out.stdout);
        let mut it = v.trim().trim_start_matches('v').split('.');
        let major = it.next()?.parse().ok()?;
        let minor = it.next()?.parse().ok()?;
        Some((major, minor))
    }

    /// The real Node: with the env a terminal gets (proxy variables, `NODE_USE_ENV_PROXY=1`,
    /// the user's own `NODE_OPTIONS` plus our preload, from a directory with a space in its
    /// name), the EHPA warning is gone while every other warning still prints and the user's
    /// own option still applies. Without the preload the same Node prints the warning — the
    /// preload is the cause (skipped where Node is too old to warn).
    #[test]
    fn a_real_node_runs_quietly_with_the_preload_and_keeps_other_warnings() {
        let Some((major, minor)) = node_version() else {
            return;
        };
        let root = std::env::temp_dir().join(format!("nodewarn live {}", ulid::Ulid::new()));
        let preload = ensure(&root).unwrap();
        let script = "process.emitWarning('still here', { code: 'X-OTHER' }); \
                      console.log('heap ' + (require('v8').getHeapStatistics().heap_size_limit > 3e9))";
        let run = |node_options: Option<String>| {
            let mut c = std::process::Command::new("node");
            c.args(["-e", script])
                .env("NODE_USE_ENV_PROXY", "1")
                .env("HTTP_PROXY", "http://127.0.0.1:9")
                .env("HTTPS_PROXY", "http://127.0.0.1:9")
                .env_remove("NODE_NO_WARNINGS");
            match node_options {
                Some(o) => c.env("NODE_OPTIONS", o),
                None => c.env_remove("NODE_OPTIONS"),
            };
            let out = c.output().expect("node runs");
            assert!(out.status.success(), "{out:?}");
            (
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            )
        };
        let opts = node_options(Some("--max-old-space-size=4096"), &preload);
        let (stdout, stderr) = run(Some(opts));
        assert!(!stderr.contains("UNDICI-EHPA"), "{stderr}");
        assert!(stderr.contains("[X-OTHER] Warning: still here"), "{stderr}");
        assert_eq!(
            stdout.trim(),
            "heap true",
            "the user's own option still applies"
        );
        let (_, bare) = run(None);
        if major == 22 && minor >= 21 {
            // Measured on 22.23.5: the warning prints without the preload.
            assert!(bare.contains("[UNDICI-EHPA]"), "the premise: {bare}");
        } else {
            // Not measured on this Node line; say what it did rather than assume.
            eprintln!(
                "NOTE premise: node {major}.{minor} without the preload {} the EHPA warning",
                if bare.contains("[UNDICI-EHPA]") {
                    "prints"
                } else {
                    "does not print"
                }
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
