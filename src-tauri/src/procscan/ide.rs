//! Places each process by its parent chain ([`place`]): an IDE terminal's tree gets `origin`,
//! `terminalId`, `agentId`; the IDE's own → dropped; else external. If the nearest shell-or-claude
//! ancestor is `claude`, it is a claude helper (dropped). [`IdeTerminals`]' lock never spans work.

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

/// Is this the `claude` CLI (native install, argv[0] `claude`, or node running the npm package)?
/// Never a name in a macOS `.app` bundle or the Windows desktop app's install folders (that app
/// is also `Claude`/`claude.exe`); its embedded `claude-code\<v>\claude.exe` is the CLI.
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
