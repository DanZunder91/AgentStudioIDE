//! Every background `Command` calls [`NoWindow::no_window`]: on Windows a GUI app's console child
//! otherwise gets a visible window. `CREATE_NO_WINDOW`, not `DETACHED_PROCESS` (its children pop
//! their own); no-op elsewhere; not for PTY terminals. Guarded by a source-scanning test.

/// `CREATE_NO_WINDOW` (winbase.h). Spelled out so no Windows API crate is needed for one flag.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Start this child without a console window on Windows; a no-op on every other OS.
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// How far below a `Command::new(` its `.no_window()` may sit. The longest builder chain in
    /// the crate is 11 lines; a spawn that needs more than this should be split up anyway.
    const WINDOW_LINES: usize = 16;

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read src dir").flatten() {
            let p = entry.path();
            if p.is_dir() {
                rust_files(&p, out);
            } else if p.extension().is_some_and(|e| e == "rs") {
                out.push(p);
            }
        }
    }

    /// The lines of `text` that are not in its test module: everything before the first
    /// `#[cfg(…test…)]` attribute that is directly followed by a `mod` item.
    fn production_lines(text: &str) -> Vec<&str> {
        let lines: Vec<&str> = text.lines().collect();
        let cut = lines
            .windows(2)
            .position(|w| {
                w[0].starts_with("#[cfg(") && w[0].contains("test") && w[1].starts_with("mod ")
            })
            .unwrap_or(lines.len());
        lines[..cut].to_vec()
    }

    /// `file:line` of every `Command::new(` in `lines` with no `.no_window()` within
    /// [`WINDOW_LINES`] below it. Comment lines are not code.
    fn unguarded(file: &str, lines: &[&str]) -> Vec<String> {
        let mut out = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if line.trim_start().starts_with("//") || !line.contains("Command::new(") {
                continue;
            }
            let end = (i + WINDOW_LINES).min(lines.len());
            if !lines[i..end].iter().any(|l| l.contains(".no_window()")) {
                out.push(format!("{file}:{}", i + 1));
            }
        }
        out
    }

    #[test]
    fn every_background_spawn_hides_its_console() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        assert!(files.len() > 50, "the crate's sources were not found");

        let mut missing = Vec::new();
        let mut spawns = 0;
        for f in &files {
            let text = std::fs::read_to_string(f).expect("read source");
            let lines = production_lines(&text);
            spawns += lines
                .iter()
                .filter(|l| !l.trim_start().starts_with("//") && l.contains("Command::new("))
                .count();
            let rel = f.strip_prefix(&src).unwrap_or(f).display().to_string();
            missing.extend(unguarded(&rel, &lines));
        }
        // A scan that finds nothing to check proves nothing.
        assert!(
            spawns >= 10,
            "only {spawns} spawns found — the scan is broken"
        );
        assert!(
            missing.is_empty(),
            "these spawns would open a console window on Windows — add `.no_window()` \
             (crate::spawn::NoWindow): {missing:#?}"
        );
    }

    #[test]
    fn the_scan_flags_a_bare_spawn_and_accepts_a_guarded_one() {
        let bare = [
            "let out = Command::new(\"gh\")",
            "    .arg(\"pr\")",
            "    .output();",
        ];
        assert_eq!(unguarded("x.rs", &bare), vec!["x.rs:1".to_string()]);

        let chained = [
            "let out = Command::new(\"gh\")",
            "    .arg(\"pr\")",
            "    .no_window()",
            "    .output();",
        ];
        assert!(unguarded("x.rs", &chained).is_empty());

        let two_statements = [
            "let mut cmd = Command::new(program);",
            "cmd.arg(\"-p\")",
            "    .kill_on_drop(true)",
            "    .no_window();",
        ];
        assert!(unguarded("x.rs", &two_statements).is_empty());

        // A `.no_window()` too far below belongs to some other spawn.
        let mut far = vec!["let a = Command::new(\"a\").output();"];
        far.extend(std::iter::repeat_n("let x = 1;", WINDOW_LINES));
        far.push("let b = Command::new(\"b\").no_window().output();");
        assert_eq!(unguarded("x.rs", &far), vec!["x.rs:1".to_string()]);

        // Prose about spawning is not a spawn.
        let doc = ["/// Never call `Command::new(\"claude\")` directly."];
        assert!(unguarded("x.rs", &doc).is_empty());
    }

    #[test]
    fn test_modules_are_not_scanned() {
        let text = "fn real() {}\n#[cfg(all(test, unix))]\nmod tests {\n    fn t() { Command::new(\"/bin/sh\"); }\n}\n";
        let lines = production_lines(text);
        assert_eq!(lines, vec!["fn real() {}"]);
        // A `cfg` that merely mentions `test` on an ordinary item does not end the scan.
        let text = "#[cfg(any(unix, test))]\nuse std::time::Instant;\nfn spawn() { Command::new(\"x\"); }\n";
        assert_eq!(production_lines(text).len(), 3);
    }

    /// On every OS the builder still builds and runs a child; on Windows this is also the one
    /// place that exercises the real flag (a wrong value makes `spawn` fail).
    #[test]
    fn a_no_window_child_still_runs_and_is_captured() {
        let (program, args): (&str, &[&str]) = if cfg!(windows) {
            ("cmd", &["/C", "echo hidden"])
        } else {
            ("/bin/sh", &["-c", "echo hidden"])
        };
        let out = std::process::Command::new(program)
            .args(args)
            .no_window()
            .output()
            .expect("the child runs");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hidden");
    }

    #[tokio::test]
    async fn a_no_window_tokio_child_still_runs_and_is_captured() {
        let (program, args): (&str, &[&str]) = if cfg!(windows) {
            ("cmd", &["/C", "echo hidden"])
        } else {
            ("/bin/sh", &["-c", "echo hidden"])
        };
        let out = tokio::process::Command::new(program)
            .args(args)
            .no_window()
            .output()
            .await
            .expect("the child runs");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hidden");
    }
}
