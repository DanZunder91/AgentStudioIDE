//! A dev app's console kind (from fds 1/2: file, terminal, pipe or none) and offered log files
//! (redirected stdout/stderr, then other log-like files open for writing, at most
//! [`MAX_LOG_FILES`]). Pure over [`Fd`]; table-tested.

use serde::{Deserialize, Serialize};

/// Cap on `logFiles` per app.
pub const MAX_LOG_FILES: usize = 16;

/// One open file descriptor, as the platform glue classified it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fd {
    pub fd: i32,
    pub kind: FdKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FdKind {
    /// A regular file (its path as the kernel reports it — symlinks already resolved).
    File {
        path: String,
        writable: bool,
    },
    /// A terminal, by its device path (`/dev/ttys003`, `/dev/pts/2`) — compared against
    /// an IDE terminal's pty slave for `console: "ide-terminal"`.
    Tty(String),
    /// `/dev/null`.
    Null,
    Pipe,
    /// A socket that is not a TCP listener (a unix socket, a connection).
    Socket,
    /// A listening TCP socket on this port.
    Listen(u16),
    /// Anything else (a directory, a kqueue, another device).
    Other,
}

/// `console` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Console {
    Terminal,
    Pipe,
    File,
    None,
    /// fd 1 is the pty slave of an **IDE terminal** ("Console is the terminal <title>"). Never
    /// produced by [`console_of`] — only [`super::assemble`] knows which ttys are the IDE's, and
    /// it upgrades `terminal` to this.
    #[serde(rename = "ide-terminal")]
    IdeTerminal,
}

/// How a log file was found (`LogFile.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogVia {
    /// fd 1 (or fds 1 and 2, the same file).
    Stdout,
    /// fd 2 only.
    Stderr,
    /// Open for writing and log-shaped.
    Log,
}

fn fd(fds: &[Fd], n: i32) -> Option<&FdKind> {
    fds.iter().find(|f| f.fd == n).map(|f| &f.kind)
}

/// The terminal device fd 1 is (`None` when fd 1 is not a tty).
pub fn stdout_tty(fds: &[Fd]) -> Option<&str> {
    match fd(fds, 1) {
        Some(FdKind::Tty(path)) => Some(path.as_str()),
        _ => None,
    }
}

/// The console kind from fds 1 and 2 (module doc).
pub fn console_of(fds: &[Fd]) -> Console {
    let std = [fd(fds, 1), fd(fds, 2)];
    let any = |pred: fn(&FdKind) -> bool| std.iter().flatten().any(|k| pred(k));
    if any(|k| matches!(k, FdKind::File { .. })) {
        Console::File
    } else if any(|k| matches!(k, FdKind::Tty(_))) {
        Console::Terminal
    } else if any(|k| matches!(k, FdKind::Pipe | FdKind::Socket | FdKind::Listen(_))) {
        Console::Pipe
    } else {
        Console::None
    }
}

/// Extensions that are never a log, even in a temp dir.
const NOT_LOGS: &[&str] = &[
    "db", "sqlite", "sqlite3", "db-wal", "db-shm", "wal", "shm", "lock", "pid", "sock", "json",
    "jar", "class", "so", "dylib", "dll", "zip", "gz", "tar", "png", "jpg", "jpeg", "bin", "dat",
    "idx", "pack", "mmap", "ldb", "sst", "mdb", "parquet", "rlib", "rmeta", "o",
];

/// Log-shaped: `*.log`, `*.out`, `*.err`, `*.output`, rotated logs, `*.txt` in a `log(s)` dir,
/// or any non-[`NOT_LOGS`] file in user log/temp dirs. Windows paths split on both separators and
/// compare case-insensitively; device paths are never logs; `/` paths are read unchanged.
pub fn looks_like_log(path: &str, home: Option<&str>) -> bool {
    let b = path.as_bytes();
    let windows =
        path.starts_with(r"\\") || (b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic());
    if path.starts_with("/dev/") || (windows && path.starts_with(r"\\.\")) {
        return false;
    }
    let seps: &[char] = if windows { &['/', '\\'] } else { &['/'] };
    let name = path
        .rsplit(seps)
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if matches!(ext, "log" | "out" | "err" | "output") || name.contains(".log.") {
        return true;
    }
    let parent = path.rsplit(seps).nth(1).unwrap_or("").to_ascii_lowercase();
    if ext == "txt" && matches!(parent.as_str(), "log" | "logs") {
        return true;
    }
    if NOT_LOGS.contains(&ext) {
        return false;
    }
    if windows {
        return home.is_some_and(|h| {
            let temp = format!(
                "{}/appdata/local/temp/",
                super::classify::norm_path(h)
                    .trim_end_matches('/')
                    .to_ascii_lowercase()
            );
            super::classify::norm_path(path)
                .to_ascii_lowercase()
                .starts_with(&temp)
        });
    }
    let under_library_logs = home.is_some_and(|h| {
        let h = h.trim_end_matches('/');
        path.starts_with(&format!("{h}/Library/Logs/"))
    });
    under_library_logs
        || [
            "/tmp/",
            "/private/tmp/",
            "/var/folders/",
            "/private/var/folders/",
        ]
        .iter()
        .any(|p| path.starts_with(p))
}

/// The files `logFiles` offers, in order (module doc). `(path, via)`.
pub fn log_files(fds: &[Fd], home: Option<&str>) -> Vec<(String, LogVia)> {
    let file = |n| match fd(fds, n) {
        Some(FdKind::File { path, .. }) => Some(path.clone()),
        _ => None,
    };
    let mut out: Vec<(String, LogVia)> = Vec::new();
    match (file(1), file(2)) {
        (Some(a), Some(b)) if a == b => out.push((a, LogVia::Stdout)),
        (a, b) => {
            if let Some(a) = a {
                out.push((a, LogVia::Stdout));
            }
            if let Some(b) = b {
                out.push((b, LogVia::Stderr));
            }
        }
    }
    for f in fds {
        if out.len() >= MAX_LOG_FILES {
            break;
        }
        if let FdKind::File {
            path,
            writable: true,
        } = &f.kind
        {
            if looks_like_log(path, home) && !out.iter().any(|(p, _)| p == path) {
                out.push((path.clone(), LogVia::Log));
            }
        }
    }
    out.truncate(MAX_LOG_FILES);
    out
}

/// Listening TCP ports, ascending, once each.
pub fn listen_ports(fds: &[Fd]) -> Vec<u16> {
    let mut ports: Vec<u16> = fds
        .iter()
        .filter_map(|f| match f.kind {
            FdKind::Listen(p) => Some(p),
            _ => None,
        })
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(fd: i32, path: &str, writable: bool) -> Fd {
        Fd {
            fd,
            kind: FdKind::File {
                path: path.into(),
                writable,
            },
        }
    }
    fn k(fd: i32, kind: FdKind) -> Fd {
        Fd { fd, kind }
    }
    fn tty(path: &str) -> FdKind {
        FdKind::Tty(path.into())
    }

    /// Hand-written expectations per path (never derived from the code under test).
    #[test]
    fn the_log_name_table() {
        let home = Some("/Users/sam");
        let table: &[(&str, bool)] = &[
            ("/work/gazelle/gazelle.log", true),
            ("/work/app/nohup.out", true),
            ("/work/app/server.err", true),
            ("/private/tmp/claude-501/p/s/tasks/b1.output", true),
            ("/work/app/logs/app.log.1", true),
            ("/work/app/app.log.2026-09-28", true),
            ("/work/app/logs/today.txt", true),
            ("/work/app/notes.txt", false),
            ("/work/app/data.db", false),
            ("/Users/sam/Library/Logs/MyApp/main", true),
            ("/Users/sam/Library/Logs/MyApp/cache.sqlite", false),
            ("/tmp/svc-output", true),
            ("/private/var/folders/x/T/tmp.abc", true),
            ("/var/folders/x/T/app.lock", false),
            ("/private/tmp/state.json", false),
            ("/work/app/target/debug/gazelle", false),
            ("/dev/ttys003", false),
            ("/Users/sam/.zsh_history", false),
        ];
        for (path, want) in table {
            assert_eq!(looks_like_log(path, home), *want, "path: {path}");
        }
        assert!(
            !looks_like_log("/Users/sam/Library/Logs/x/main", None),
            "no home, no ~/Library/Logs rule"
        );
    }

    /// The same rules on Windows-shaped paths (hand-written expectations).
    #[test]
    fn the_log_name_table_on_windows_paths() {
        let home = Some(r"C:\Users\sam");
        let table: &[(&str, bool)] = &[
            (r"C:\w\gazelle\gazelle.log", true),
            (r"C:\w\app\logs\app.LOG", true),
            (r"C:\w\app\logs\today.txt", true),
            (r"C:\w\app\Logs\today.TXT", true),
            (r"\\srv\share\svc\log\today.txt", true),
            (r"C:\w\app\app.log.2026-11-18", true),
            (r"C:\w\app\notes.txt", false),
            (r"C:\w\app\data.db", false),
            (r"C:\w.d\app", false),
            (r"C:\Users\sam\AppData\Local\Temp\svc-output", true),
            (r"c:\users\SAM\appdata\local\temp\x\out", true),
            (r"C:/Users/sam/AppData/Local/Temp/mixed", true),
            (
                r"C:\Users\sam\AppData\Local\Temp\claude\0a1b\s\tasks\b1.output",
                true,
            ),
            (r"C:\Users\sam\AppData\Local\Temp\app.lock", false),
            (r"C:\Users\sam\AppData\Local\Temp\state.json", false),
            (r"C:\Users\sam\AppData\Local\Programs\x\main", false),
            (r"C:\Users\sam\.zsh_history", false),
            (r"\\.\pipe\svc.log", false),
        ];
        for (path, want) in table {
            assert_eq!(looks_like_log(path, home), *want, "path: {path}");
        }
        assert!(
            !looks_like_log(r"C:\Users\sam\AppData\Local\Temp\svc-output", None),
            "no home, no temp rule"
        );
        assert!(
            looks_like_log(r"C:\Users\sam\AppData\Local\Temp\x", Some("C:/Users/sam/")),
            "a home spelled with `/` (Git Bash exports one) still matches"
        );
        // A unix path with a backslash in a file name is still a unix path.
        assert!(looks_like_log(r"/tmp/a\b", home));
    }

    #[test]
    fn the_console_table() {
        let table: Vec<(Vec<Fd>, Console)> = vec![
            (vec![file(1, "/w/svc.log", true)], Console::File),
            (
                vec![k(1, tty("/dev/ttys001")), file(2, "/w/err.log", true)],
                Console::File,
            ),
            (
                vec![k(1, tty("/dev/ttys001")), k(2, tty("/dev/ttys001"))],
                Console::Terminal,
            ),
            (vec![k(1, FdKind::Pipe), k(2, FdKind::Pipe)], Console::Pipe),
            (vec![k(1, FdKind::Socket)], Console::Pipe),
            (vec![k(1, FdKind::Null), k(2, FdKind::Null)], Console::None),
            // fd 0 does not count; nothing on 1/2.
            (vec![k(0, tty("/dev/ttys001"))], Console::None),
            (vec![], Console::None),
        ];
        for (fds, want) in table {
            assert_eq!(console_of(&fds), want, "fds: {fds:?}");
        }
    }

    #[test]
    fn stdout_tty_is_fd_1s_device_only() {
        assert_eq!(
            stdout_tty(&[k(0, tty("/dev/pts/0")), k(1, tty("/dev/pts/3"))]),
            Some("/dev/pts/3")
        );
        assert_eq!(
            stdout_tty(&[k(2, tty("/dev/pts/3"))]),
            None,
            "fd 2 is not fd 1"
        );
        assert_eq!(stdout_tty(&[file(1, "/w/a.log", true)]), None);
        assert_eq!(stdout_tty(&[]), None);
    }

    #[test]
    fn log_files_put_the_console_file_first_and_skip_what_is_not_a_written_log() {
        let fds = vec![
            k(0, FdKind::Null),
            file(1, "/w/svc.log", true),
            file(2, "/w/svc.log", true),
            file(3, "/w/other.log", false), // read-only: not a log it writes
            file(4, "/w/app.log", true),
            file(5, "/w/app.db", true),
            file(6, "/w/app.log", true), // same file twice
            k(7, FdKind::Listen(3000)),
        ];
        assert_eq!(
            log_files(&fds, None),
            vec![
                ("/w/svc.log".to_string(), LogVia::Stdout),
                ("/w/app.log".to_string(), LogVia::Log),
            ]
        );
        let split = vec![file(1, "/w/out.txt", true), file(2, "/w/err.txt", true)];
        assert_eq!(
            log_files(&split, None),
            vec![
                ("/w/out.txt".to_string(), LogVia::Stdout),
                ("/w/err.txt".to_string(), LogVia::Stderr),
            ],
            "a console file is offered whatever its name"
        );
    }

    #[test]
    fn at_most_sixteen_log_files() {
        let fds: Vec<Fd> = (3..40)
            .map(|n| file(n, &format!("/w/f{n}.log"), true))
            .collect();
        assert_eq!(MAX_LOG_FILES, 16);
        assert_eq!(log_files(&fds, None).len(), 16);
    }

    #[test]
    fn ports_are_sorted_and_unique() {
        let fds = vec![
            k(3, FdKind::Listen(8080)),
            k(4, FdKind::Listen(3000)),
            k(5, FdKind::Listen(8080)),
            k(6, FdKind::Socket),
        ];
        assert_eq!(listen_ports(&fds), vec![3000, 8080]);
    }

    #[test]
    fn wire_spellings() {
        assert_eq!(
            serde_json::to_value(LogVia::Log).unwrap(),
            serde_json::json!("log")
        );
        assert_eq!(
            serde_json::to_value(Console::Terminal).unwrap(),
            serde_json::json!("terminal")
        );
        assert_eq!(
            serde_json::to_value(Console::IdeTerminal).unwrap(),
            serde_json::json!("ide-terminal")
        );
    }
}
