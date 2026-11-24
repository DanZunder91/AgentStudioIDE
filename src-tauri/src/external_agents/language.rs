//! **The project's language, for the City's neon signs** (every
//! building carries a neon sign naming its project's language, styled for that language — a Rust
//! project such as gazelle gets Rust-style neon).
//!
//! ## Where it comes from — zero permission prompts
//!
//! NOT from the project folder. A marker file (`Cargo.toml`, `package.json`) would mean reading
//! the agent's cwd, and an outside agent's cwd can sit in `~/Documents` or `~/Desktop`, where
//! touching anything raises a macOS TCC prompt. The transcript the scan ALREADY reads under
//! `~/.claude/projects` says it instead: every file the agent touched is named in a `tool_use`
//! input — `Read` / `Edit` / `Write` / `MultiEdit` `file_path`, `NotebookEdit` `notebook_path`, and
//! a `Grep` / `Glob` `path`. A directory has no source extension, so only a FILE path can vote:
//! no `stat` is needed to tell the two apart, and none is made. Each path's extension votes
//! through the shared table `src/features/village/projectLanguages.json` — the very table the
//! Village tallies the IDE's own agents with, so both sides name a language the same way. The
//! most votes win; a tie goes to the first id in code-unit order (`planCity`'s rule).
//!
//! ## What crosses the wire (the privacy rules)
//!
//! Only the winning id (`"rust"`). The paths are read inside Rust and dropped here: no path, no
//! file name, no extension and no vote count ever leaves this module.
//!
//! ## Cost — it runs every ~3 s for every live session
//!
//! Incremental, `agent::tools`'s discipline: a byte offset per transcript, and a scan reads only
//! what was APPENDED since the last one — usually nothing (one `stat`) or a few KiB. A file seen
//! for the first time, or one that grew by more than [`LANGUAGE_BOUND`] between two scans, is read
//! only its last [`LANGUAGE_BOUND`] bytes. Lines are pre-filtered by substring before any JSON
//! parse. A file that got SHORTER was rewritten (`claude` does that on an interrupted exit): its
//! votes are dropped and it is read again. The cache is in memory for the app run, holds only the
//! sessions of the last scan ([`LanguageCache::retain`]), and nothing is written anywhere —
//! least of all under `~/.claude`.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The most bytes one catch-up reads off a transcript: its tail on first sight, else what was
/// appended since the last scan (more than this, and only the newest this much). Hundreds of
/// tool calls — plenty to tell a project's language — and a bounded read on a 40 MB transcript.
pub const LANGUAGE_BOUND: u64 = 512 * 1024;

/// The shared extension → language table (see the module doc).
const TABLE_JSON: &str = include_str!("../../../src/features/village/projectLanguages.json");

/// Extension (lowercase, no dot) → language id, parsed once from [`TABLE_JSON`].
pub fn table() -> &'static HashMap<String, String> {
    static TABLE: OnceLock<HashMap<String, String>> = OnceLock::new();
    TABLE.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct Shape {
            extensions: HashMap<String, String>,
        }
        // A compile-time constant: `table_is_the_shared_json` pins that it parses.
        serde_json::from_str::<Shape>(TABLE_JSON)
            .expect("src/features/village/projectLanguages.json must parse")
            .extensions
    })
}

/// The language a path's extension votes for, or `None` (no extension, a dotfile, a directory,
/// or a language that does not vote — Markdown, TOML, JSON…). Either separator; any case.
pub fn language_of_path(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None; // `.rs` is a dotfile named "rs", not a Rust file
    }
    table()
        .get(&name[dot + 1..].to_ascii_lowercase())
        .map(String::as_str)
}

/// The input field that names the file a tool worked on, for the tools that have one.
fn path_field(tool: &str) -> Option<&'static str> {
    match tool {
        "Read" | "Edit" | "Write" | "MultiEdit" => Some("file_path"),
        "NotebookEdit" => Some("notebook_path"),
        "Grep" | "Glob" => Some("path"),
        _ => None,
    }
}

/// The paths one transcript line's `tool_use` blocks name ([`path_field`]), in block order.
pub fn tool_paths(line: &str) -> Vec<String> {
    // Cheap pre-filter: `file_path"`, `notebook_path"` and `"path"` all end in `path"`, and most
    // lines (results, thinking, text) carry neither marker — never parsed.
    if !line.contains("\"tool_use\"") || !line.contains("path\"") {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new(); // torn / garbage line
    };
    let Some(blocks) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        .filter_map(|b| {
            let field = path_field(b.get("name")?.as_str()?)?;
            let path = b.get("input")?.get(field)?.as_str()?;
            Some(path.to_string())
        })
        .collect()
}

/// Votes per language.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Tally(HashMap<&'static str, u32>);

impl Tally {
    /// Count every path a transcript line's tool calls name.
    pub fn add_line(&mut self, line: &str) {
        for path in tool_paths(line) {
            if let Some(lang) = language_of_path(&path) {
                *self.0.entry(lang).or_default() += 1;
            }
        }
    }

    fn merge(&mut self, other: &Tally) {
        for (lang, n) in &other.0 {
            *self.0.entry(lang).or_default() += n;
        }
    }

    /// The most-voted language; a tie goes to the first id in code-unit order. `None` = no vote.
    pub fn winner(&self) -> Option<&'static str> {
        self.0
            .iter()
            .max_by(|(la, na), (lb, nb)| na.cmp(nb).then_with(|| lb.cmp(la)))
            .map(|(lang, _)| *lang)
    }
}

/// One transcript's votes, and how far into it they were counted.
#[derive(Debug, Default)]
struct FileVotes {
    offset: u64,
    tally: Tally,
}

/// Bring `votes` up to date with what was appended to `path` since `votes.offset` (module doc:
/// bounded, whole lines only, a shrunk file counted afresh). An unreadable file — it can vanish
/// between the listing and the read — keeps what it said before.
fn catch_up(path: &Path, votes: &mut FileVotes) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < votes.offset {
        *votes = FileVotes::default(); // rewritten: what it said is no longer there
    }
    if len == votes.offset {
        return;
    }
    let start = votes.offset.max(len.saturating_sub(LANGUAGE_BOUND));
    let mut buf = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err()
        || file.take(len - start).read_to_end(&mut buf).is_err()
    {
        return;
    }
    // Whole lines only: a torn last line (mid-write) waits for its newline. A first line cut by
    // the bound (a first look, a big append) needs no special case: the tail of a JSON line is
    // never JSON, so it fails to parse and votes for nothing — and a bound that lands exactly on
    // a line's start keeps that whole line.
    let to = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    for line in buf[..to].split(|&b| b == b'\n') {
        if !line.is_empty() {
            votes.tally.add_line(&String::from_utf8_lossy(line));
        }
    }
    votes.offset = start + to as u64;
}

/// Every live session's votes, file by file, kept between scans (module doc: the cost).
#[derive(Debug, Default)]
pub struct LanguageCache {
    sessions: HashMap<String, HashMap<PathBuf, FileVotes>>,
}

impl LanguageCache {
    /// The app's one cache — the `list_external_agents` command's.
    pub fn global() -> &'static Mutex<LanguageCache> {
        static CACHE: OnceLock<Mutex<LanguageCache>> = OnceLock::new();
        CACHE.get_or_init(Mutex::default)
    }

    /// Catch `session_id`'s votes up with `files` (its root transcript and the sub-agent sidecars
    /// in the window) and return its language. A sidecar no longer passed keeps its votes: a
    /// sub-agent that went quiet still did that work, so the sign does not flip when it leaves.
    pub fn session_language<'a>(
        &mut self,
        session_id: &str,
        files: impl IntoIterator<Item = &'a Path>,
    ) -> Option<String> {
        let votes = self.sessions.entry(session_id.to_string()).or_default();
        for path in files {
            catch_up(path, votes.entry(path.to_path_buf()).or_default());
        }
        let mut total = Tally::default();
        for v in votes.values() {
            total.merge(&v.tally);
        }
        total.winner().map(str::to_string)
    }

    /// Forget every session not in `keep` (the ones the last scan reported), so the cache is
    /// never bigger than the live sessions.
    pub fn retain(&mut self, keep: &HashSet<String>) {
        self.sessions.retain(|id, _| keep.contains(id));
    }

    /// The session ids held (for the tests).
    pub fn sessions(&self) -> HashSet<&str> {
        self.sessions.keys().map(String::as_str).collect()
    }
}

#[cfg(test)]
mod tests {
    //! Hermetic: every file is a tempdir file written here; nothing touches `~/.claude`.

    use super::*;
    use serde_json::json;

    fn temp_file(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agentstudio-lang-{tag}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.join("t.jsonl")
    }

    /// An assistant line calling `tool` with `input`.
    fn call(tool: &str, input: serde_json::Value) -> String {
        json!({"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use",
               "content":[{"type":"tool_use","id":"toolu_1","name":tool,"input":input}]}})
        .to_string()
    }

    fn read(path: &str) -> String {
        call("Read", json!({ "file_path": path }))
    }

    fn append(path: &Path, text: &str) {
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("open")
            .write_all(text.as_bytes())
            .expect("append");
    }

    fn lines(ls: &[String]) -> String {
        ls.iter().map(|l| format!("{l}\n")).collect()
    }

    #[test]
    fn table_is_the_shared_json() {
        let t = table();
        // The flagship rows, written by hand (never read the expectation off the table).
        for (ext, lang) in [
            ("rs", "rust"),
            ("ts", "typescript"),
            ("tsx", "typescript"),
            ("js", "javascript"),
            ("py", "python"),
            ("go", "go"),
            ("java", "java"),
            ("kt", "kotlin"),
            ("swift", "swift"),
            ("cpp", "cpp"),
            ("cs", "csharp"),
            ("rb", "ruby"),
            ("sh", "shell"),
        ] {
            assert_eq!(t.get(ext).map(String::as_str), Some(lang), "{ext}");
        }
        // Only programming languages vote.
        for ext in [
            "md", "toml", "json", "yaml", "yml", "lock", "css", "html", "txt", "sql",
        ] {
            assert_eq!(t.get(ext), None, "{ext} must not vote");
        }
        assert!(t.len() >= 50, "the whole table, not a stub: {}", t.len());
        for (ext, lang) in t {
            assert_eq!(ext, &ext.to_ascii_lowercase(), "keys are lowercase");
            assert!(!ext.starts_with('.') && !ext.is_empty(), "{ext:?}");
            assert!(
                !lang.is_empty() && lang.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{lang:?} is a lowercase-kebab id"
            );
        }
    }

    #[test]
    fn a_path_votes_by_its_extension_only() {
        assert_eq!(language_of_path("/w/gazelle/src/main.rs"), Some("rust"));
        assert_eq!(language_of_path("C:\\code\\App.TSX"), Some("typescript"));
        assert_eq!(language_of_path("src/types.d.ts"), Some("typescript"));
        assert_eq!(language_of_path("main.go"), Some("go"));
        for none in [
            "/w/gazelle/README.md", // docs never vote
            "/w/gazelle/Cargo.toml",
            "/w/gazelle/Makefile", // no extension
            "/w/gazelle/src",      // a directory (a Grep `path`)
            "/w/gazelle/.rs",      // a dotfile, not a Rust file
            "C:\\w\\.rs",          // …on Windows too: the basename follows either separator
            "/w/gazelle/x.rs/",    // a trailing separator: nothing after it
            "/w/archive.tar.gz",
            "",
        ] {
            assert_eq!(language_of_path(none), None, "{none:?}");
        }
    }

    #[test]
    fn tool_paths_reads_the_file_tools_and_nothing_else() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"working"},
            {"type":"tool_use","id":"1","name":"Read","input":{"file_path":"/a/r.rs"}},
            {"type":"tool_use","id":"2","name":"Edit","input":{"file_path":"/a/e.ts","old_string":"x"}},
            {"type":"tool_use","id":"3","name":"Write","input":{"file_path":"/a/w.py"}},
            {"type":"tool_use","id":"4","name":"MultiEdit","input":{"file_path":"/a/m.go"}},
            {"type":"tool_use","id":"5","name":"NotebookEdit","input":{"notebook_path":"/a/n.ipynb"}},
            {"type":"tool_use","id":"6","name":"Grep","input":{"pattern":"fn","path":"/a/src"}},
            {"type":"tool_use","id":"7","name":"Glob","input":{"pattern":"*.rs","path":"/a/g.rb"}},
            {"type":"tool_use","id":"8","name":"Bash","input":{"command":"cat /a/b.rs","path":"/a/x.c"}},
            {"type":"tool_use","id":"9","name":"Read","input":{"limit":3}},
            {"type":"tool_use","id":"10","name":"Read","input":{"file_path":7}},
            {"type":"tool_use","id":"11","input":{"file_path":"/a/nameless.rs"}},
            {"type":"tool_result","name":"Read","input":{"file_path":"/a/result.rs"}}
        ]}})
        .to_string();
        assert_eq!(
            tool_paths(&line),
            [
                "/a/r.rs",
                "/a/e.ts",
                "/a/w.py",
                "/a/m.go",
                "/a/n.ipynb",
                "/a/src",
                "/a/g.rb"
            ]
        );
        // No tool call, or no path marker: never parsed — and nothing found.
        let result = json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"1","content":"see \"file_path\": /a/b.rs"}]}})
        .to_string();
        assert!(tool_paths(&result).is_empty());
        assert!(tool_paths(&call("Bash", json!({"command":"ls"}))).is_empty());
        // The pre-filter lets through a line whose only path is a Grep's `path` (or a notebook's).
        assert_eq!(
            tool_paths(&call("Grep", json!({"pattern":"fn","path":"/a/lib.rs"}))),
            ["/a/lib.rs"]
        );
        assert_eq!(
            tool_paths(&call("NotebookEdit", json!({"notebook_path":"/a/n.ipynb"}))),
            ["/a/n.ipynb"]
        );
        assert!(tool_paths("{\"tool_use\" \"file_path\": torn").is_empty());
        assert!(tool_paths(&json!({"type":"tool_use","path":"/a/b.rs"}).to_string()).is_empty());
    }

    #[test]
    fn the_most_votes_win_and_a_tie_goes_to_the_first_id() {
        let mut t = Tally::default();
        assert_eq!(t.winner(), None);
        t.add_line(&read("/a/b.ts"));
        t.add_line(&read("/a/a.rs"));
        // One each: "rust" < "typescript".
        assert_eq!(t.winner(), Some("rust"));
        t.add_line(&read("/a/c.tsx"));
        assert_eq!(t.winner(), Some("typescript"));
        // Paths that do not vote change nothing.
        t.add_line(&read("/a/README.md"));
        t.add_line(&read("/a/x.rs/"));
        assert_eq!(t.0.values().sum::<u32>(), 3);
        let mut other = Tally::default();
        other.add_line(&read("/a/d.rs"));
        other.add_line(&read("/a/e.rs"));
        t.merge(&other);
        assert_eq!(t.winner(), Some("rust"));
        assert_eq!(t.0.get("rust"), Some(&3));
    }

    #[test]
    fn a_transcript_is_read_incrementally_whole_lines_only() {
        let path = temp_file("incr");
        let mut cache = LanguageCache::default();
        std::fs::write(&path, lines(&[read("/a/1.rs"), read("/a/2.rs")])).unwrap();
        assert_eq!(
            cache.session_language("s", [path.as_path()]),
            Some("rust".into())
        );
        // A torn last line (no newline yet) waits; the whole one before it counts once.
        append(&path, &format!("{}\n", read("/a/3.ts")));
        append(&path, &read("/a/4.ts"));
        assert_eq!(
            cache.session_language("s", [path.as_path()]),
            Some("rust".into())
        );
        let votes = |c: &LanguageCache| c.sessions["s"][&path].tally.0.clone();
        assert_eq!(votes(&cache).get("typescript"), Some(&1));
        // Its newline lands: now it counts — and nothing before it is counted twice.
        append(&path, &format!("\n{}\n", read("/a/5.ts")));
        assert_eq!(
            cache.session_language("s", [path.as_path()]),
            Some("typescript".into())
        );
        assert_eq!(votes(&cache).get("typescript"), Some(&3));
        assert_eq!(votes(&cache).get("rust"), Some(&2));
        // Nothing new: a no-op.
        cache.session_language("s", [path.as_path()]);
        assert_eq!(votes(&cache).get("typescript"), Some(&3));
        let len = std::fs::metadata(&path).unwrap().len();
        assert_eq!(cache.sessions["s"][&path].offset, len);
    }

    #[test]
    fn a_rewritten_transcript_is_counted_afresh() {
        let path = temp_file("shrink");
        let mut cache = LanguageCache::default();
        std::fs::write(
            &path,
            lines(&[read("/a/1.rs"), read("/a/2.rs"), read("/a/3.rs")]),
        )
        .unwrap();
        assert_eq!(
            cache.session_language("s", [path.as_path()]),
            Some("rust".into())
        );
        // `claude` rewrote it shorter: the old votes are gone with the old text.
        std::fs::write(&path, lines(&[read("/a/1.py")])).unwrap();
        assert_eq!(
            cache.session_language("s", [path.as_path()]),
            Some("python".into())
        );
        assert_eq!(cache.sessions["s"][&path].tally.0.get("rust"), None);
    }

    #[test]
    fn a_first_look_reads_only_the_bounded_tail_and_drops_the_cut_line() {
        let path = temp_file("bound");
        let rs = read("/a/old.rs");
        // Old Rust work well past the bound, then a little Go at the end.
        let mut body = String::new();
        while (body.len() as u64) < LANGUAGE_BOUND + 64 * 1024 {
            body.push_str(&rs);
            body.push('\n');
        }
        body.push_str(&lines(&[read("/a/new.go"), read("/a/new2.go")]));
        std::fs::write(&path, &body).unwrap();
        let mut cache = LanguageCache::default();
        cache.session_language("s", [path.as_path()]);
        let tally = &cache.sessions["s"][&path].tally.0;
        let per_line = rs.len() as u64 + 1;
        let rust = u64::from(tally["rust"]);
        // Only the last LANGUAGE_BOUND bytes were looked at; the line the bound cut voted for nothing.
        assert!(rust < LANGUAGE_BOUND / per_line, "{rust} votes");
        assert!(rust + 4 >= LANGUAGE_BOUND / per_line, "{rust} votes");
        assert_eq!(tally["go"], 2);
        assert_eq!(cache.sessions["s"][&path].offset, body.len() as u64);

        // One line longer than the whole bound: only its tail is read, which votes for nothing —
        // and it is skipped, never re-read.
        let huge = temp_file("huge");
        let giant = read(&format!("/a/{}.rs", "x".repeat(LANGUAGE_BOUND as usize)));
        std::fs::write(&huge, format!("{giant}\n")).unwrap();
        let mut cache = LanguageCache::default();
        assert_eq!(cache.session_language("h", [huge.as_path()]), None);
        assert_eq!(
            cache.sessions["h"][&huge].offset,
            std::fs::metadata(&huge).unwrap().len()
        );
    }

    #[test]
    fn a_session_sums_its_files_and_keeps_a_quiet_sidecars_votes() {
        let root = temp_file("root");
        let sub = root.with_file_name("agent-a1.jsonl");
        std::fs::write(&root, lines(&[read("/a/1.ts")])).unwrap();
        std::fs::write(&sub, lines(&[read("/a/1.rs"), read("/a/2.rs")])).unwrap();
        let mut cache = LanguageCache::default();
        assert_eq!(
            cache.session_language("s", [root.as_path(), sub.as_path()]),
            Some("rust".into())
        );
        // The sidecar left the window: its work still counts.
        append(&root, &lines(&[read("/a/2.ts")]));
        assert_eq!(
            cache.session_language("s", [root.as_path()]),
            Some("rust".into())
        );
        // A file that vanished keeps what it said; a missing one never seen says nothing.
        std::fs::remove_file(&sub).unwrap();
        let ghost = root.with_file_name("agent-ghost.jsonl");
        assert_eq!(
            cache.session_language("s", [sub.as_path(), ghost.as_path()]),
            Some("rust".into())
        );
        // Sessions do not mix.
        assert_eq!(
            cache.session_language("t", [root.as_path()]),
            Some("typescript".into())
        );
    }

    #[test]
    fn retain_keeps_only_the_last_scans_sessions() {
        let path = temp_file("retain");
        std::fs::write(&path, lines(&[read("/a/1.rs")])).unwrap();
        let mut cache = LanguageCache::default();
        for s in ["a", "b", "c"] {
            cache.session_language(s, [path.as_path()]);
        }
        cache.retain(&HashSet::from(["b".to_string(), "zz".to_string()]));
        assert_eq!(cache.sessions(), HashSet::from(["b"]));
        // The global one is a cache like any other (and starts out holding nothing of a test's).
        assert!(!LanguageCache::global()
            .lock()
            .unwrap()
            .sessions()
            .contains("b"));
    }
}
