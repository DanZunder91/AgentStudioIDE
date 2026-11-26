//! Opens an `https://` URL in the default browser. Links can come from any cloned repo's
//! README, so the webview is untrusted: non-https and shell metacharacters are refused
//! ([`validate_https`]). Openers are pure per OS; Windows uses `ShellExecuteW`, never cmd.

use crate::spawn::NoWindow as _;

/// The complete error vocabulary. `bad-url` = refused by [`validate_https`];
/// `unknown` = the opener could not be spawned.
pub const ERROR_CODES: [&str; 2] = ["bad-url", "unknown"];

const HTTPS_PREFIX: &str = "https://";

/// Refused beyond controls and whitespace: `"` and `cmd.exe` metacharacters, kept as defence
/// in depth though the Windows opener skips cmd. A GitHub PR URL never contains any of them.
const REFUSED_CHARS: [char; 7] = ['"', '&', '|', '<', '>', '^', '`'];

/// Accept exactly the URLs this command exists for: `https://` (lowercase — the
/// only producer is `gh`'s own `url` field, which is always lowercase) with a
/// non-empty remainder and none of the refused characters.
pub fn validate_https(url: &str) -> Result<(), String> {
    if !url.starts_with(HTTPS_PREFIX) {
        return Err("bad-url: only https:// URLs can be opened".to_string());
    }
    if url.len() == HTTPS_PREFIX.len() {
        return Err("bad-url: the URL has no host".to_string());
    }
    if url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || REFUSED_CHARS.contains(&c))
    {
        return Err(
            "bad-url: the URL contains characters that cannot be passed safely".to_string(),
        );
    }
    Ok(())
}

// --- Per-OS opener commands: pure, tested on every host; only `os_opener` is cfg'd ---

/// macOS: `/usr/bin/open <url>` — OS-shipped, absolute.
pub fn macos_command(url: &str) -> (String, Vec<String>) {
    ("/usr/bin/open".to_string(), vec![url.to_string()])
}

/// Where `xdg-open` lives on every mainstream distro.
const LINUX_XDG_OPEN: &str = "/usr/bin/xdg-open";

/// Linux: `xdg-open <url>`. `installed_at_usr_bin` is injected (probed by the
/// glue) so both branches of the lenient resolution are unit-testable.
pub fn linux_command(installed_at_usr_bin: bool, url: &str) -> (String, Vec<String>) {
    let program = if installed_at_usr_bin {
        LINUX_XDG_OPEN.to_string()
    } else {
        // Lenient fallback: PATH lookup at spawn. A failure surfaces as
        // `unknown` from the spawn, never silently.
        "xdg-open".to_string()
    };
    (program, vec![url.to_string()])
}

/// How a URL reaches the browser on this OS.
#[derive(Debug, PartialEq, Eq)]
pub enum Opener {
    /// Spawn `program args` (macOS `open`, Linux `xdg-open`).
    Spawn(String, Vec<String>),
    /// Windows: `ShellExecuteW("open", url)`, the shell's own URL handler.
    ShellExecute(String),
}

/// Windows: `ShellExecuteW("open", <url>)`, never `cmd /c start`: cmd expands `%NAME%`, so a
/// README link like `?k=%GITHUB_TOKEN%` would leak the variable, and `%` cannot be refused.
pub fn windows_opener(url: &str) -> Opener {
    Opener::ShellExecute(url.to_string())
}

#[cfg(target_os = "macos")]
fn os_opener(url: &str) -> Opener {
    let (program, args) = macos_command(url);
    Opener::Spawn(program, args)
}

#[cfg(target_os = "linux")]
fn os_opener(url: &str) -> Opener {
    let (program, args) = linux_command(std::path::Path::new(LINUX_XDG_OPEN).is_file(), url);
    Opener::Spawn(program, args)
}

#[cfg(target_os = "windows")]
fn os_opener(url: &str) -> Opener {
    windows_opener(url)
}

/// Spawn the opener detached. Not a zombie: a throwaway thread reaps it (it exits in
/// milliseconds) without blocking the command.
fn spawn_detached(program: &str, args: &[String]) -> Result<(), String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .no_window()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "unknown: the browser could not be opened".to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// `ShellExecuteW(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL)`. A return value above 32 is
/// success (the documented contract of this API).
#[cfg(windows)]
fn shell_execute(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(url));
    // SAFETY: both strings are NUL-terminated UTF-16 buffers that outlive the call; the
    // optional pointers are null, which the API documents as "none".
    let code = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if code > 32 {
        Ok(())
    } else {
        Err("unknown: the browser could not be opened".to_string())
    }
}

#[cfg(not(windows))]
fn shell_execute(_url: &str) -> Result<(), String> {
    Err("unknown: ShellExecute exists only on Windows".to_string())
}

// ---------------------------------------------------------------------------
// The command (glue)
// ---------------------------------------------------------------------------

/// Open `url` in the default browser. `Err` is coded per [`ERROR_CODES`].
#[tauri::command]
pub fn url_open(url: String) -> Result<(), String> {
    validate_https(&url)?;
    match os_opener(&url) {
        Opener::Spawn(program, args) => spawn_detached(&program, &args),
        Opener::ShellExecute(url) => shell_execute(&url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PR_URL: &str = "https://github.com/acme/widgets/pull/41";

    // ── validation: the https gate ────────────────────────────────────────

    #[test]
    fn a_pull_request_url_is_accepted() {
        assert_eq!(validate_https(PR_URL), Ok(()));
        assert_eq!(
            validate_https("https://ghe.example.invalid/org/repo/pull/7"),
            Ok(()),
            "GHES hosts are https too"
        );
    }

    #[test]
    fn every_non_https_scheme_is_bad_url() {
        for url in [
            "http://github.com/acme/widgets/pull/41",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.invalid/x",
            "HTTPS://github.com/acme/widgets/pull/41", // strict lowercase: gh's own URLs are
            "https:/github.com/one-slash",
            "github.com/no-scheme",
            "",
        ] {
            let err = validate_https(url).unwrap_err();
            assert!(
                err.starts_with("bad-url"),
                "{url:?} must be bad-url, got {err:?}"
            );
        }
    }

    #[test]
    fn a_bare_scheme_or_unsafe_characters_are_bad_url() {
        for url in [
            "https://",            // no host
            "https://x/pull/1 2",  // whitespace
            "https://x/pull/1\n2", // control
            "https://x/\"quote",   // quote-breakout
            "https://x/?a=1&b=2",  // cmd metachar &
            "https://x/pipe|calc", // cmd metachar |
            "https://x/^caret",    // cmd metachar ^
            "https://x/`tick`",    // cmd metachar `
        ] {
            let err = validate_https(url).unwrap_err();
            assert!(
                err.starts_with("bad-url"),
                "{url:?} must be bad-url, got {err:?}"
            );
        }
    }

    // ── the per-OS opener commands (pure) ─────────────────────────────────

    #[test]
    fn macos_opens_via_usr_bin_open() {
        assert_eq!(
            macos_command(PR_URL),
            ("/usr/bin/open".to_string(), vec![PR_URL.to_string()])
        );
    }

    #[test]
    fn linux_prefers_the_absolute_xdg_open_and_falls_back_to_path() {
        assert_eq!(
            linux_command(true, PR_URL),
            ("/usr/bin/xdg-open".to_string(), vec![PR_URL.to_string()])
        );
        assert_eq!(
            linux_command(false, PR_URL),
            ("xdg-open".to_string(), vec![PR_URL.to_string()])
        );
    }

    /// Through `cmd /c start`, a README link's `%GITHUB_TOKEN%` was
    /// expanded into the URL the browser fetched. Windows hands the URL to the shell untouched.
    #[test]
    fn windows_opens_through_the_shell_with_the_url_untouched_never_cmd() {
        assert_eq!(
            windows_opener(PR_URL),
            Opener::ShellExecute(PR_URL.to_string())
        );
        let link = "https://evil.example/?k=%GITHUB_TOKEN%;u=%USERPROFILE%".to_string();
        assert_eq!(
            validate_https(&link),
            Ok(()),
            "`%` is a legal URL character"
        );
        assert_eq!(windows_opener(&link), Opener::ShellExecute(link.clone()));
        assert!(
            !matches!(windows_opener(&link), Opener::Spawn(..)),
            "no command interpreter on Windows"
        );
    }

    // ── the command refuses before it ever spawns ─────────────────────────

    #[test]
    fn url_open_refuses_a_bad_url_without_spawning() {
        // Callable directly (no AppHandle). Validation runs first, so nothing
        // is ever spawned for a refused URL.
        for url in ["http://insecure.example.invalid", "file:///etc/passwd", ""] {
            let err = url_open(url.to_string()).unwrap_err();
            assert!(err.starts_with("bad-url"), "{url:?} → {err:?}");
        }
    }
}
