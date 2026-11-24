//! `pty::default_shell()` — the per-OS fallback chain (ARCHITECTURE §2.4).
//!
//! **Why this is its own test binary:** the function reads `$SHELL`, so pinning
//! its branches means mutating process-global env. `cargo test` runs the tests
//! within one binary on parallel threads, and `set_var` is process-wide — a
//! sibling test reading `$SHELL` at the wrong moment would flake. Isolating the
//! mutation in its own binary, in a single sequential `#[test]`, makes that
//! impossible rather than unlikely.

use agent_studio_scaffold_lib::pty::default_shell;

/// Restores whatever `$SHELL` was, whichever way the test leaves.
struct ShellEnvGuard(Option<String>);

impl ShellEnvGuard {
    fn new() -> Self {
        Self(std::env::var("SHELL").ok())
    }
    fn set(&self, value: &str) {
        std::env::set_var("SHELL", value);
    }
    fn unset(&self) {
        std::env::remove_var("SHELL");
    }
}

impl Drop for ShellEnvGuard {
    fn drop(&mut self) {
        match &self.0 {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }
}

/// Windows ignores `$SHELL` entirely and always uses PowerShell.
#[cfg(windows)]
#[test]
fn windows_always_uses_powershell() {
    let guard = ShellEnvGuard::new();

    guard.unset();
    assert_eq!(default_shell(), "powershell");

    // Even a set $SHELL (e.g. under Git Bash) must not win on Windows.
    guard.set("/bin/bash");
    assert_eq!(default_shell(), "powershell");
}

/// The whole Unix chain, in one sequential test so the env mutations cannot race.
#[cfg(unix)]
#[test]
fn unix_shell_resolution_chain() {
    let guard = ShellEnvGuard::new();

    // 1. $SHELL wins when it is set.
    guard.set("/usr/local/bin/fish");
    assert_eq!(
        default_shell(),
        "/usr/local/bin/fish",
        "$SHELL must be honored"
    );

    // 2. Unset → the per-OS default. This is the branch that matters: the fallback
    //    must be a shell that actually exists on the platform, or every plain
    //    terminal fails to open on a machine without $SHELL (a bare CI container).
    guard.unset();
    let fallback = default_shell();
    let expected = if cfg!(target_os = "macos") {
        "/bin/zsh" // the macOS login shell since Catalina
    } else {
        "/bin/bash"
    };
    assert_eq!(fallback, expected, "wrong per-OS fallback shell");
    assert!(
        std::path::Path::new(&fallback).exists(),
        "the fallback shell {fallback} does not exist on this machine — \
         every default terminal would fail to open"
    );

    // 3. Empty and whitespace-only $SHELL are treated as unset, not as a program
    //    named "" (which would be a spawn error, not a fallback).
    for blank in ["", "   ", "\t", "\n"] {
        guard.set(blank);
        assert_eq!(
            default_shell(),
            expected,
            "blank $SHELL {blank:?} must fall back, not be used as a program"
        );
    }

    // 4. `$SHELL` is only *blank-tested* trimmed, not trimmed in use. Pinning the
    //    current behavior so any change to it is deliberate.
    guard.set(" /bin/sh ");
    assert_eq!(default_shell(), " /bin/sh ");

    // Whatever the branch, the result is never empty — an empty program string
    // would reach `CommandBuilder::new("")`.
    for value in ["/usr/local/bin/fish", "", "  "] {
        guard.set(value);
        assert!(!default_shell().trim().is_empty());
    }
}
