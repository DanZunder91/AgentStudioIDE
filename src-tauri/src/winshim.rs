//! Runs npm `.cmd`/`.bat` shim targets without cmd.exe: cmd re-parses the command line
//! (`%VAR%` expands even in quotes) and sits between us and the real program. The shim is read
//! ([`parse_cmd_shim`]) and its target run directly; text-only, so every OS tests it.

use std::path::{Path, PathBuf};

/// What an npm `cmd-shim` runs: its target relative to the shim's folder, and the
/// interpreter it hands the target to (`None`: the target is itself an executable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShimTarget {
    pub rel: String,
    pub interpreter: Option<String>,
}

/// Is `path` a Windows batch script (`x.cmd`, `X.BAT`)? Case-insensitive, like Windows.
pub fn is_batch(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// Read an npm/pnpm `cmd-shim`: the target is the last quoted `%dp0%\…`/`%~dp0\…` path on the
/// `%*` line that is not the interpreter. Interpreter: none for `.exe`/`.com`, else
/// `SET "_prog=…"`, else the bare word before the target, else `node`.
pub fn parse_cmd_shim(text: &str) -> Option<ShimTarget> {
    let line = text.lines().rev().find(|l| l.contains("%*"))?;
    let quoted: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
    let rel = quoted.iter().rev().find_map(|q| {
        let rest = q
            .strip_prefix("%dp0%")
            .or_else(|| q.strip_prefix("%~dp0"))?;
        let rest = rest.trim_start_matches(['\\', '/']);
        let is_interp = rest.to_ascii_lowercase().ends_with("node.exe");
        (!rest.is_empty() && !is_interp).then_some(rest)
    })?;
    // This OS's separator, so the target joins onto the shim's folder as a real path.
    let rel = rel.replace(['\\', '/'], std::path::MAIN_SEPARATOR_STR);
    let lower = rel.to_ascii_lowercase();
    if lower.ends_with(".exe") || lower.ends_with(".com") {
        return Some(ShimTarget {
            rel,
            interpreter: None,
        });
    }
    let from_set = text.lines().find_map(|l| {
        let v = l.trim().strip_prefix("SET \"_prog=")?.strip_suffix('"')?;
        (!v.contains('%')).then(|| v.to_string())
    });
    let bare = || {
        let before = line.split('"').next()?.trim().trim_start_matches('@');
        let word = before.split_whitespace().last()?;
        word.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            .then(|| word.to_string())
    };
    let interpreter = from_set.or_else(bare).unwrap_or_else(|| "node".to_string());
    Some(ShimTarget {
        rel,
        interpreter: Some(interpreter),
    })
}

/// A batch shim made runnable: the program `CreateProcess` starts and the arguments that go in
/// front of the caller's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unwrapped {
    pub program: PathBuf,
    pub prefix: Vec<String>,
}

/// Why a batch file could not be unwrapped. Callers word the message (each knows what the user
/// should do instead), so this carries only the cause.
#[derive(Debug)]
pub enum UnwrapError {
    /// The shim could not be read.
    Read(std::io::Error),
    /// Not an npm shim, and no `fallback_script` beside it.
    NotAShim,
    /// The shim runs a script with Node.js and no `node.exe` was found.
    NoNode,
}

/// Unwrap npm shim `shim` into interpreter + script (or its `.exe`); a non-npm shim runs
/// `fallback_script` (relative to the shim's folder) with `node` if it exists. `node` is a
/// parameter so tests need no Node install.
pub fn unwrap_npm_shim(
    shim: &Path,
    fallback_script: Option<&str>,
    node: impl FnOnce() -> Option<PathBuf>,
) -> Result<Unwrapped, UnwrapError> {
    let dir = shim.parent().unwrap_or(Path::new("."));
    let text = std::fs::read(shim)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(UnwrapError::Read)?;
    let target = parse_cmd_shim(&text)
        .map(|t| (dir.join(&t.rel), t.interpreter))
        .or_else(|| {
            let script = dir.join(fallback_script?);
            script.is_file().then(|| (script, Some("node".to_string())))
        });
    let Some((target, interpreter)) = target else {
        return Err(UnwrapError::NotAShim);
    };
    let Some(interp) = interpreter else {
        return Ok(Unwrapped {
            program: target,
            prefix: Vec::new(),
        });
    };
    let local = dir.join(format!("{interp}.exe"));
    let program = if local.is_file() {
        local
    } else if interp.eq_ignore_ascii_case("node") {
        node().ok_or(UnwrapError::NoNode)?
    } else {
        PathBuf::from(interp)
    };
    Ok(Unwrapped {
        program,
        prefix: vec![target.to_string_lossy().into_owned()],
    })
}

/// `node.exe` for an npm shim whose own folder has none: `PATH`, then the Node installer's
/// default folder (a GUI app's `PATH` can lack it, as it can lack `%APPDATA%\npm`).
pub fn find_node() -> Option<PathBuf> {
    // Absolute `PATH` entries only: a relative one would resolve against the app's cwd.
    let on_path = std::env::var_os("PATH").and_then(|path| {
        crate::agent::claude::absolute_path_dirs(&path)
            .into_iter()
            .map(|dir| dir.join("node.exe"))
            .find(|p| p.is_file())
    });
    on_path.or_else(|| {
        std::env::var_os("ProgramFiles")
            .map(|p| PathBuf::from(p).join("nodejs").join("node.exe"))
            .filter(|p| p.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_file_is_named_by_its_extension_in_any_case() {
        for (name, want) in [
            ("x.cmd", true),
            ("X.CMD", true),
            ("run.bat", true),
            ("run.Bat", true),
            ("x.exe", false),
            ("x.cmdx", false),
            ("cmd", false),
            ("x", false),
        ] {
            assert_eq!(is_batch(Path::new(name)), want, "{name}");
        }
    }

    /// A temp folder with a non-shim `.cmd` and a package script beside it.
    #[test]
    fn a_non_shim_uses_the_fallback_script_only_when_it_exists() {
        let dir = std::env::temp_dir().join(format!("winshim-fb-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir.join("pkg")).unwrap();
        std::fs::write(dir.join("x.cmd"), "@echo off\r\nreal-x %*\r\n").unwrap();
        let node = || Some(PathBuf::from("node.exe"));
        assert!(matches!(
            unwrap_npm_shim(&dir.join("x.cmd"), None, node),
            Err(UnwrapError::NotAShim)
        ));
        assert!(matches!(
            unwrap_npm_shim(&dir.join("x.cmd"), Some("pkg/cli.js"), node),
            Err(UnwrapError::NotAShim)
        ));
        std::fs::write(dir.join("pkg/cli.js"), "").unwrap();
        let got = unwrap_npm_shim(&dir.join("x.cmd"), Some("pkg/cli.js"), node).unwrap();
        assert_eq!(got.program, PathBuf::from("node.exe"));
        assert_eq!(
            got.prefix,
            vec![dir.join("pkg/cli.js").to_string_lossy().into_owned()]
        );
        assert!(matches!(
            unwrap_npm_shim(&dir.join("missing.cmd"), None, node),
            Err(UnwrapError::Read(_))
        ));
        let _ = std::fs::remove_dir_all(dir);
    }
}
