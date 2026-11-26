//! App names from each pid's executable (nettop truncates, and Claude Code's binary is named by
//! version), else the backend's name. [`display_name`] is pure; [`NameCache`] takes the lookup
//! as a function so its pid-reuse rule is tested without real processes.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// `pid → executable path`, when readable.
pub type ExeLookup = Arc<dyn Fn(u32) -> Option<String> + Send + Sync>;

/// A lookup that never resolves (keeps the backend's names) — tests and fallbacks.
pub fn no_lookup() -> ExeLookup {
    Arc::new(|_| None)
}

/// Name for an executable path: `…/claude/versions/<v>` → `claude <v>`, else the untruncated
/// basename (`\` splits too and `.exe` is dropped, so names match across OSes). `None` if empty.
pub fn display_name(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let base = super::wintable::strip_exe(parts.last()?);
    if parts.len() >= 3 {
        let (parent, grand) = (parts[parts.len() - 2], parts[parts.len() - 3]);
        if parent == "versions" && grand == "claude" && looks_like_version(base) {
            return Some(format!("claude {base}"));
        }
    }
    Some(base.to_string())
}

/// `2.1.281`, `2.1.281-beta.1` — digits first, dotted.
fn looks_like_version(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_digit()) && s.contains('.')
}

/// Resolved names by pid, for the life of a sampler run.
pub struct NameCache {
    lookup: ExeLookup,
    names: HashMap<u32, Option<String>>,
}

impl NameCache {
    pub fn new(lookup: ExeLookup) -> Self {
        Self {
            lookup,
            names: HashMap::new(),
        }
    }

    /// The display name for `pid`, else `fallback` (the backend's name). Pid 0 is the
    /// backend's "no process" (another user's socket on Linux) and is never looked up.
    pub fn name_of(&mut self, pid: u32, fallback: &str) -> String {
        if pid == 0 {
            return fallback.to_string();
        }
        let lookup = &self.lookup;
        self.names
            .entry(pid)
            .or_insert_with(|| lookup(pid).as_deref().and_then(display_name))
            .clone()
            .unwrap_or_else(|| fallback.to_string())
    }

    /// Forget pids not in this sample: a pid that went away may be reused by a
    /// different program, which must not inherit the old name.
    pub fn retain(&mut self, live: &HashSet<u32>) {
        self.names.retain(|pid, _| live.contains(pid));
    }

    /// Rename a sample's apps in place (and prune the cache to its pids).
    pub fn rename(&mut self, apps: &mut [super::RawApp]) {
        let live: HashSet<u32> = apps.iter().map(|a| a.pid).collect();
        self.retain(&live);
        for a in apps {
            a.name = self.name_of(a.pid, &a.name);
        }
    }
}

/// This OS's `pid → executable` lookup.
pub fn system_lookup() -> ExeLookup {
    Arc::new(exe_path)
}

#[cfg(target_os = "macos")]
fn exe_path(pid: u32) -> Option<String> {
    use std::ffi::c_void;
    let pid = i32::try_from(pid).ok()?;
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is writable for its full length, which we pass.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(target_os = "linux")]
fn exe_path(pid: u32) -> Option<String> {
    // Readable only for the user's own processes without root — others fall back.
    let p = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    let s = p.to_string_lossy();
    // An exe replaced on disk reads `/path (deleted)`.
    Some(s.strip_suffix(" (deleted)").unwrap_or(&s).to_string())
}

#[cfg(windows)]
fn exe_path(pid: u32) -> Option<String> {
    // Readable for the user's own processes; others keep the snapshot's image name.
    super::windows::exe_path(pid)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn exe_path(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Expectations written by hand, per path — never computed by the code under test.
    #[test]
    fn the_display_name_table() {
        let table: &[(&str, Option<&str>)] = &[
            (
                "/Users/sam/.local/share/claude/versions/2.1.281",
                Some("claude 2.1.281"),
            ),
            (
                "/opt/homebrew/lib/claude/versions/2.1.272-beta.1",
                Some("claude 2.1.272-beta.1"),
            ),
            (
                "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/140.0/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
                Some("Google Chrome Helper"),
            ),
            (
                "/Applications/Slack.app/Contents/MacOS/Slack",
                Some("Slack"),
            ),
            ("/Users/sam/gazelle/target/debug/gazelle", Some("gazelle")),
            ("/usr/bin/nettop", Some("nettop")),
            // Not the rule: `versions` under something else, or a non-version leaf.
            ("/opt/node/versions/22.20.0", Some("22.20.0")),
            ("/x/claude/versions/latest", Some("latest")),
            // Windows: `\` separates, `.exe` (any case) is not part of the name.
            (r"C:\Program Files\Git\cmd\git.exe", Some("git")),
            (
                r"C:\Users\sam\AppData\Local\Programs\Microsoft VS Code\Code.EXE",
                Some("Code"),
            ),
            (
                r"C:\Users\sam\.local\share\claude\versions\2.1.281.exe",
                Some("claude 2.1.281"),
            ),
            (r"C:\Users\sam\.local\bin\claude.exe", Some("claude")),
            ("/", None),
            ("", None),
        ];
        for (path, want) in table {
            assert_eq!(display_name(path).as_deref(), *want, "path: {path:?}");
        }
    }

    #[test]
    fn an_unreadable_pid_keeps_the_backend_name_and_pid_0_is_never_looked_up() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let mut cache = NameCache::new(Arc::new(move |pid| {
            c.fetch_add(1, Ordering::SeqCst);
            (pid == 7).then(|| "/Users/me/.local/share/claude/versions/2.1.281".to_string())
        }));
        assert_eq!(cache.name_of(7, "2.1.281"), "claude 2.1.281");
        assert_eq!(cache.name_of(8, "Google Chrome H"), "Google Chrome H");
        assert_eq!(cache.name_of(0, "other user"), "other user");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "pid 0 is not looked up");
        // Cached: no second lookup, including for the unresolvable pid.
        cache.name_of(7, "x");
        cache.name_of(8, "y");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_pid_that_left_the_sample_is_looked_up_again() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let mut cache = NameCache::new(Arc::new(move |_| {
            let n = c.fetch_add(1, Ordering::SeqCst);
            Some(format!("/bin/prog{n}"))
        }));
        assert_eq!(cache.name_of(5, "f"), "prog0");
        cache.retain(&HashSet::from([6]));
        assert_eq!(
            cache.name_of(5, "f"),
            "prog1",
            "pid reuse gets a fresh name"
        );
    }
}
