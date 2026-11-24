//! **Apps the IDE's own terminals and agents started**: apps started inside an IDE terminal
//! appear on the list as their own separate rows, such as `cargo gazelle`.
//!
//! An earlier version dropped the IDE's whole process tree. Now every process is **placed**
//! by walking its parent chain ([`place`]), and a dev app gains `origin` / `terminalId` /
//! `agentId` / `launchedBy` on the wire.
//!
//! # The terminal table — [`IdeTerminals`]
//!
//! The supervisor actor owns the terminals; procscan runs on a blocking worker every 3 s.
//! They share one `Arc<RwLock<Arc<HashMap<pid, IdeTerminal>>>>`: the actor rebuilds the map
//! after each message and **writes only when it changed** (so the lock is taken for a
//! pointer swap a handful of times per terminal lifetime, never per keystroke); a scan takes
//! the read lock for one `Arc` clone. Neither side ever holds it across work, so the actor
//! loop cannot stall on a scan. Keyed by the PTY child's pid — the terminal's shell, or for
//! an agent spawned with `+` the `claude` CLI itself (it *is* the PTY child there).
//!
//! # Placement rules (in walk order, starting at the process itself)
//!
//! | reached first | placement |
//! |---|---|
//! | an IDE terminal's PTY child pid | [`Placement::Ide`] — `terminalId`, `launchedBy` = terminal title; `agentId`/`launchedBy` = the terminal's **bound** root agent when a `claude` CLI process is on the chain (the PTY child counts) |
//! | the IDE's own pid (not via a terminal) | [`Placement::Internal`] — the IDE's tooling (LSP servers, `docker logs`, the usage probe): dropped |
//! | nothing (the chain ends) | [`Placement::External`] |
//!
//! Independently of where it lands, a process whose **nearest shell-or-`claude`
//! ancestor-or-self is the `claude` CLI** is one of claude's own helpers (its ripgrep, its
//! MCP/node workers) → [`Placement::ClaudeHelper`], dropped. A dev app the agent launched
//! through its Bash tool has a shell between it and claude (`claude → zsh -c … → node
//! server.js`), so it is kept. That relies on the Bash tool wrapping every command in a
//! compound shell line (it appends its own `&& pwd -P >| …` cwd probe), which stops the
//! shell from `exec`-ing into the command; an agent that `exec`s a server directly from
//! claude would be read as a helper — the price of not guessing by name.
//!
//! The `claude` CLI itself ([`is_claude_cli`]) is dropped wherever it runs.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use super::classify::{basename, is_shell, is_windows_path, norm_path};
use super::os::RawProc;
use crate::netmachine::wintable::strip_exe;

/// One live IDE terminal, as procscan needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdeTerminal {
    pub terminal_id: String,
    /// The tab title (`zsh`, `claude`).
    pub title: String,
    /// The pty slave's device path (`/dev/ttys003`) — fd 1 of a process whose console is
    /// this terminal.
    pub tty: Option<String>,
    /// The root agent bound to this terminal right now (the supervisor's binding table), if any.
    pub agent_id: Option<String>,
    pub agent_title: Option<String>,
}

/// `{ PTY child pid → terminal }`, immutable once published.
pub type IdeSnapshot = Arc<HashMap<u32, IdeTerminal>>;

/// The shared, lock-cheap terminal table (module doc). Cloning shares it.
#[derive(Debug, Clone, Default)]
pub struct IdeTerminals(Arc<RwLock<IdeSnapshot>>);

impl IdeTerminals {
    /// The current table (one `Arc` clone under the read lock).
    pub fn snapshot(&self) -> IdeSnapshot {
        self.0.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Replace the table when `next` differs from what is published. Returns whether it
    /// wrote. The comparison runs on a read lock; the write lock is a pointer swap.
    pub fn publish(&self, next: HashMap<u32, IdeTerminal>) -> bool {
        if **self.0.read().unwrap_or_else(|p| p.into_inner()) == next {
            return false;
        }
        *self.0.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(next);
        true
    }
}

/// `origin` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Ide,
    External,
}

/// Where a process belongs (module doc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placement {
    External,
    Ide(Attribution),
    /// Under the IDE but not under a terminal: the IDE's own tooling.
    Internal,
    /// The `claude` CLI, or one of its own helpers.
    ClaudeHelper,
}

/// An IDE-origin app's attribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribution {
    pub terminal_id: String,
    /// The agent's title when `agent_id` is set, else the terminal's.
    pub launched_by: String,
    pub agent_id: Option<String>,
    /// The terminal's pty slave, for `console: "ide-terminal"`.
    pub tty: Option<String>,
}

/// Is this the `claude` CLI? The native install (`~/.local/bin/claude` →
/// `~/.local/share/claude/versions/<v>`), anything whose argv[0] is `claude` (node sets
/// `process.title`), or the npm package run by node (`node …/@anthropic-ai/claude-code/cli.js`).
///
/// A NAME inside a macOS app bundle (`….app/Contents/…`) is never the CLI: the Claude desktop
/// app's binary is `/Applications/Claude.app/Contents/MacOS/Claude`, and the case-insensitive
/// match took it — and every Electron helper under it — for agents.
///
/// **Windows**: the native install is `%USERPROFILE%\.local\bin\claude.exe`
/// (`.exe` is dropped before the name is compared — measured on a real install), the npm
/// package is `node.exe …\node_modules\@anthropic-ai\claude-code\cli.js` (either separator).
/// The Windows desktop app's binary is also `claude.exe`, so the same rule as the macOS bundle
/// applies to its install folders — `…\AnthropicClaude\…` (Squirrel) and `…\WindowsApps\…`
/// (Store): never the CLI. (Those two paths are reasoned from how the desktop app installs,
/// not observed on a machine with it installed.) Its embedded Claude Code,
/// `%APPDATA%\Claude\claude-code\<v>\claude.exe`, IS the CLI, as on macOS.
pub fn is_claude_cli(exe: Option<&str>, argv: &[String]) -> bool {
    // A process whose executable IS the Windows desktop app is not the CLI, whatever its
    // argv[0] says (an Electron helper may be started as a bare `claude.exe`).
    if exe.is_some_and(windows_desktop_app) {
        return false;
    }
    let named = |s: &str| {
        !s.contains(".app/Contents/")
            && !windows_desktop_app(s)
            && strip_exe(basename(s.trim_start_matches('-'))).eq_ignore_ascii_case("claude")
    };
    exe.is_some_and(|e| named(e) || norm_path(e).contains("/claude/versions/"))
        || argv.first().is_some_and(|a| named(a))
        || argv
            .iter()
            .skip(1)
            .take(3)
            .any(|a| norm_path(a).contains("/@anthropic-ai/claude-code/"))
}

/// Is this path inside the Windows Claude DESKTOP app's install (see [`is_claude_cli`])?
fn windows_desktop_app(path: &str) -> bool {
    if !is_windows_path(path) {
        return false;
    }
    let n = norm_path(path).to_ascii_lowercase();
    n.contains("/anthropicclaude/") || n.contains("/windowsapps/")
}

/// Place `pid` (module doc). `by_pid` is the whole process table. Bounded: a ppid cycle in
/// a malformed table ends the walk as [`Placement::External`].
pub fn place(
    pid: u32,
    by_pid: &HashMap<u32, &RawProc>,
    ide_pid: Option<u32>,
    terminals: &HashMap<u32, IdeTerminal>,
) -> Placement {
    let Some(me) = by_pid.get(&pid) else {
        return Placement::External;
    };
    if is_claude_cli(me.exe.as_deref(), &me.argv) {
        return Placement::ClaudeHelper;
    }
    // Has the walk met a shell yet (the process itself counts)? A claude reached before
    // any shell makes this claude's helper.
    let mut passed_shell = is_shell(me.exe.as_deref(), &me.argv);
    let mut through_claude = false;
    let mut cur: &RawProc = me;
    for _ in 0..512 {
        if cur.pid != pid && is_claude_cli(cur.exe.as_deref(), &cur.argv) {
            if !passed_shell {
                return Placement::ClaudeHelper;
            }
            through_claude = true;
        }
        if let Some(t) = terminals.get(&cur.pid) {
            let agent = t.agent_id.clone().filter(|_| through_claude);
            let launched_by = match (&agent, &t.agent_title) {
                (Some(_), Some(title)) if !title.is_empty() => title.clone(),
                _ => t.title.clone(),
            };
            return Placement::Ide(Attribution {
                terminal_id: t.terminal_id.clone(),
                launched_by,
                agent_id: agent,
                tty: t.tty.clone(),
            });
        }
        if Some(cur.pid) == ide_pid {
            return Placement::Internal;
        }
        if cur.pid != pid && is_shell(cur.exe.as_deref(), &cur.argv) {
            passed_shell = true;
        }
        match by_pid.get(&cur.ppid) {
            Some(parent) if cur.ppid != cur.pid && cur.ppid != 0 => cur = parent,
            _ => break,
        }
    }
    Placement::External
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_claude_cli_by_install_by_title_and_by_npm_package() {
        let yes: &[(Option<&str>, &[&str])] = &[
            (
                Some("/Users/me/.local/share/claude/versions/2.1.212"),
                &["claude"],
            ),
            (Some("/Users/me/.local/bin/claude"), &["claude", "-p", "hi"]),
            (Some("/opt/homebrew/bin/node"), &["claude"]),
            // The desktop app's embedded Claude Code is the CLI.
            (
                Some("/Users/me/Library/Application Support/Claude/claude-code/2.1.300/claude"),
                &["claude"],
            ),
            (
                Some("/opt/homebrew/bin/node"),
                &[
                    "node",
                    "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
                ],
            ),
        ];
        for (exe, argv) in yes {
            assert!(is_claude_cli(*exe, &v(argv)), "{exe:?} {argv:?}");
        }
        let no: &[(Option<&str>, &[&str])] = &[
            (Some("/opt/homebrew/bin/node"), &["node", "server.js"]),
            (
                Some("/w/claude-proxy/target/debug/claude-proxy"),
                &["claude-proxy"],
            ),
            (Some("/opt/homebrew/bin/rg"), &["rg", "claude"]),
            // The Claude DESKTOP app: its bundle binary is named `Claude`.
            (
                Some("/Applications/Claude.app/Contents/MacOS/Claude"),
                &["/Applications/Claude.app/Contents/MacOS/Claude"],
            ),
            (None, &["/Applications/Claude.app/Contents/MacOS/Claude"]),
            (None, &[]),
        ];
        for (exe, argv) in no {
            assert!(!is_claude_cli(*exe, &v(argv)), "{exe:?} {argv:?}");
        }
    }

    #[test]
    fn the_claude_cli_on_windows() {
        let yes: &[(Option<&str>, &[&str])] = &[
            // The native install's layout on Windows 11 ARM64 (CLI 2.1.327).
            (
                Some(r"C:\Users\u\.local\bin\claude.exe"),
                &[r"C:\Users\u\.local\bin\claude.exe"],
            ),
            (Some(r"C:\Users\u\.local\bin\CLAUDE.EXE"), &["claude"]),
            (None, &["claude.exe", "-p", "hi"]),
            (
                Some(r"C:\Users\u\.local\share\claude\versions\2.1.327"),
                &["x"],
            ),
            // The npm package, run by node.
            (
                Some(r"C:\Program Files\nodejs\node.exe"),
                &[
                    "node.exe",
                    r"C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js",
                ],
            ),
            // The desktop app's embedded Claude Code is the CLI.
            (
                Some(r"C:\Users\u\AppData\Roaming\Claude\claude-code\2.1.300\claude.exe"),
                &["claude.exe"],
            ),
        ];
        for (exe, argv) in yes {
            assert!(is_claude_cli(*exe, &v(argv)), "{exe:?} {argv:?}");
        }
        let no: &[(Option<&str>, &[&str])] = &[
            // The desktop app itself and its Electron helpers.
            (
                Some(r"C:\Users\u\AppData\Local\AnthropicClaude\app-0.14.1\claude.exe"),
                &[r"C:\Users\u\AppData\Local\AnthropicClaude\app-0.14.1\claude.exe"],
            ),
            (
                Some(r"C:\Users\u\AppData\Local\AnthropicClaude\app-0.14.1\claude.exe"),
                &["claude.exe", "--type=renderer"],
            ),
            (
                Some(r"C:\Program Files\WindowsApps\Claude_0.14.1.0_arm64__abc\app\claude.exe"),
                &["claude.exe"],
            ),
            (
                None,
                &[r"C:\Users\u\AppData\Local\AnthropicClaude\claude.exe"],
            ),
            (
                Some(r"C:\w\claude-proxy\target\debug\claude-proxy.exe"),
                &["claude-proxy.exe"],
            ),
            (
                Some(r"C:\Program Files\nodejs\node.exe"),
                &["node.exe", "server.js"],
            ),
        ];
        for (exe, argv) in no {
            assert!(!is_claude_cli(*exe, &v(argv)), "{exe:?} {argv:?}");
        }
    }

    #[test]
    fn publish_writes_only_on_change() {
        let t = IdeTerminals::default();
        assert!(t.snapshot().is_empty());
        let one = HashMap::from([(
            7,
            IdeTerminal {
                terminal_id: "t1".into(),
                title: "zsh".into(),
                tty: None,
                agent_id: None,
                agent_title: None,
            },
        )]);
        assert!(t.publish(one.clone()), "a change is written");
        let before = t.snapshot();
        assert!(!t.publish(one), "the same table is not rewritten");
        assert!(
            Arc::ptr_eq(&before, &t.snapshot()),
            "…so readers keep the same Arc"
        );
        assert!(
            t.clone().publish(HashMap::new()),
            "a clone shares the table"
        );
        assert!(t.snapshot().is_empty());
    }
}
