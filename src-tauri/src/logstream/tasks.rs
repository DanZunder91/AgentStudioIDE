//! Background-task output as a log source.
//!
//! An agent that starts its service with Claude's `run_in_background` Bash would
//! otherwise have its logs appear nowhere: Claude writes a background task's stdout/stderr to
//! `<temp>/claude-<uid>/<project>/<session>/tasks/<id>.output`, never to the PTY. The
//! transcript tail ([`crate::agent::tools`]) recognises the launch and its result; this
//! module tails the file and turns it into [`LogKind::Task`] lines.
//!
//! # Redirects are followed
//!
//! A typical launch redirects: `python3 …/run_server.py KEY=… > …/gazelle.log 2>&1` —
//! so the `.output` file stays **empty** and the real log is `gazelle.log`, which nothing
//! would tail. A task therefore tails, besides its `.output` file, **every file its command
//! redirects to** ([`redirect_targets`]: `>`, `>>`, `>|`, `N>`, `&>`, `&>>`, `>& file`,
//! `| tee [-a] file…`; a `2>&1`-style dup, an input redirection and `/dev/*` name no file).
//! A relative target is placed against the agent's cwd (the transcript line's). Every
//! target goes through the path guard below; one outside the root is not tailed and says
//! so once (`not tailing gazelle.log: outside the IDE's temp root`); one named twice is
//! tailed once. All of a task's files count as **one** against the cap, and the task's
//! `source` is named after the redirect ([`source_name`]: `gazelle.log` → `gazelle · bg`)
//! unless that name is generic (`out.log`, `nohup.out`, a hex id…), in which case the
//! program's name stays.
//!
//! # Only Claude's own temp root, read-only
//!
//! A path comes from a transcript, i.e. from text a model wrote. So before anything is
//! opened it must be absolute, free of `..`, and — **with every symlink resolved** — a
//! regular file strictly under `claude-<uid>` in one of the temp roots
//! ([`claude_temp_roots`]). A task file that is a symlink out of the root (Claude's own
//! sub-agent `.output` files are symlinks into `~/.claude`, for one) is refused, not
//! followed; the file is then opened with `O_NOFOLLOW` and re-checked on the open handle,
//! so a swap between check and open cannot redirect the read. A file that does not exist
//! yet is waited for only when it lies under a root lexically — a redirect to
//! `/work/server.log` is refused now, not watched forever. Nothing is ever written.
//!
//! # Bounded
//!
//! At most [`MAX_TASK_TAILS`] tasks at once across the whole app ([`TaskSlots`], shared
//! through the hub), each with at most [`MAX_TASK_FILES`] files. A file is read from the
//! start — a service's startup lines are the ones that matter — but only its last
//! [`TASK_BACKFILL_LINES`] lines (within the last [`TASK_BACKFILL_BYTES`]) are backfilled.
//! After that, lines are admitted at most [`TASK_LINES_PER_SEC`] a second per file by the
//! same fixed-window [`RateLimiter`] the machine lines use, with the drops reported. A
//! task's tail stops when none of its files has grown for [`TASK_IDLE_STOP`], when a
//! `TaskStop` names it, when its last file is gone, or when its session ends (the owning
//! tailer task is aborted and drops it).
//!
//! # Testability
//!
//! The clock is a parameter (`now`) and the roots are injected, so every rule above is
//! tested against real files under a fake root with made-up instants; the command
//! grammar ([`redirect_targets`], [`program_of`], [`source_name`]) is pure and
//! table-tested.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::time::{Duration, Instant};

use super::splitter::LineSplitter;
use super::{
    cap_text, classify_level, LineDraft, LogKind, LogLevel, RateLimiter, MACHINE_LINES_PER_SEC,
    PARTIAL_FLUSH_AFTER,
};

/// Background tasks tailed at once, app-wide (a task's files count as one).
pub const MAX_TASK_TAILS: usize = 16;
/// Files tailed per task: its `.output` plus redirect targets. A command naming more
/// files than this is a script, not a service; the rest are announced as not tailed.
pub const MAX_TASK_FILES: usize = 8;
/// A task none of whose files has grown for this long is no longer tailed.
pub const TASK_IDLE_STOP: Duration = Duration::from_secs(10 * 60);
/// At most this many lines of what a file held before the tail started.
pub const TASK_BACKFILL_LINES: usize = 2_000;
/// …read from at most this many trailing bytes (2 000 capped lines fit twice over).
pub const TASK_BACKFILL_BYTES: u64 = 16 * 1024 * 1024;
/// At most this much is read from one file per poll after the backfill.
pub const TASK_READ_PER_POLL: u64 = 1024 * 1024;
/// A file this far behind skips ahead instead of replaying a flood nobody can read.
pub const TASK_MAX_BACKLOG: u64 = 8 * 1024 * 1024;
/// Per-file line cap — the machine lines' number, the machine lines' limiter.
pub const TASK_LINES_PER_SEC: u32 = MACHINE_LINES_PER_SEC;
/// Appended to the task's name in `source` (`gazelle · bg`).
pub const BG_SUFFIX: &str = " · bg";
/// A task line's `detail` (command + paths) is capped here: it is repeated on every line
/// of the ring, and a `Monitor` script can be kilobytes long.
pub const TASK_DETAIL_BYTES: usize = 2 * 1024;

/// Where Claude may put task output for this user: `claude-<uid>` under the process temp
/// dir, `/tmp` and `/private/tmp` (macOS's `/tmp` is a symlink to it). On Windows it is
/// `%TEMP%\claude` ([`windows_temp_roots`]). Candidates only — [`validate_task_path`]
/// resolves them, and a root that does not exist contains nothing.
pub fn claude_temp_roots() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        let name = format!("claude-{uid}");
        let mut out = vec![
            std::env::temp_dir().join(&name),
            PathBuf::from("/tmp").join(&name),
            PathBuf::from("/private/tmp").join(&name),
        ];
        out.dedup();
        out
    }
    #[cfg(not(unix))]
    {
        windows_temp_roots(
            std::env::var_os("TEMP"),
            std::env::var_os("TMP"),
            std::env::temp_dir(),
        )
    }
}

/// Claude Code on Windows writes `%TEMP%\claude\<project hash>\<session>\tasks\<id>.output`
/// (measured on CLI 2.1.x — no uid in the name, and the project level is a hash,
/// not the transcript's project-dir name). It takes the dir from Node's `os.tmpdir()`, which
/// reads `TEMP` before `TMP`; ours ([`std::env::temp_dir`], `GetTempPath2W`) reads `TMP`
/// first. They are normally the same folder, but both are candidates so a machine where
/// they differ still finds the files. Pure (the environment is passed in) so every OS tests
/// the Windows answer.
pub fn windows_temp_roots(
    temp: Option<std::ffi::OsString>,
    tmp: Option<std::ffi::OsString>,
    temp_dir: PathBuf,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let candidates = [temp, tmp]
        .into_iter()
        .flatten()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .chain(std::iter::once(temp_dir));
    for dir in candidates {
        let root = dir.join("claude");
        if !out.contains(&root) {
            out.push(root);
        }
    }
    out
}

/// Why a task path was not tailed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathRefusal {
    NotAbsolute,
    /// A `..` component: refused before resolving, whatever it would resolve to.
    ParentComponent,
    /// Does not exist (yet) but lies under a root — the only refusal a pending tail
    /// retries.
    Missing,
    /// Resolves outside every Claude temp root (or to a root itself) — or does not exist
    /// and is not under one even lexically.
    OutsideRoot,
    NotRegularFile,
    Unreadable(String),
}

impl std::fmt::Display for PathRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathRefusal::NotAbsolute => write!(f, "the path is not absolute"),
            PathRefusal::ParentComponent => write!(f, "the path contains `..`"),
            PathRefusal::Missing => write!(f, "the file does not exist"),
            PathRefusal::OutsideRoot => write!(f, "the file is outside Claude's temp dir"),
            PathRefusal::NotRegularFile => write!(f, "not a regular file"),
            PathRefusal::Unreadable(e) => write!(f, "unreadable: {e}"),
        }
    }
}

/// Strictly under one of `roots` without touching the file itself (it may not exist):
/// against each root as given and as it resolves (`/tmp` vs `/private/tmp`). On Windows
/// the comparison ignores ASCII case, as the file system does.
fn lexically_under(path: &Path, roots: &[PathBuf]) -> bool {
    let fold = cfg!(windows);
    let inside = |r: &Path| strictly_under(path, r, fold);
    roots
        .iter()
        .any(|r| inside(r) || std::fs::canonicalize(r).is_ok_and(|c| inside(&c)))
}

/// `path` is below `root` (never `root` itself), component by component — so
/// `claude-42420` is not under `claude-4242`. `fold`: compare components ignoring ASCII
/// case (Windows' `C:\Users\Me\…\Temp` and `c:\users\me\…\temp` are one folder).
fn strictly_under(path: &Path, root: &Path, fold: bool) -> bool {
    if !fold {
        return path != root && path.starts_with(root);
    }
    let mut p = path.components();
    for r in root.components() {
        match p.next() {
            Some(c) if c.as_os_str().eq_ignore_ascii_case(r.as_os_str()) => {}
            _ => return false,
        }
    }
    p.next().is_some()
}

/// The resolved path of a task file we may read, or why not (module doc).
pub fn validate_task_path(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, PathRefusal> {
    if !path.is_absolute() {
        return Err(PathRefusal::NotAbsolute);
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(PathRefusal::ParentComponent);
    }
    let canon = std::fs::canonicalize(path).map_err(|e| match e.kind() {
        // Worth waiting for only where a task file can appear.
        std::io::ErrorKind::NotFound if lexically_under(path, roots) => PathRefusal::Missing,
        std::io::ErrorKind::NotFound => PathRefusal::OutsideRoot,
        _ => PathRefusal::Unreadable(e.to_string()),
    })?;
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| canon != r && canon.starts_with(&r));
    if !inside {
        return Err(PathRefusal::OutsideRoot);
    }
    let md = std::fs::metadata(&canon).map_err(|e| PathRefusal::Unreadable(e.to_string()))?;
    if !md.is_file() {
        return Err(PathRefusal::NotRegularFile);
    }
    Ok(canon)
}

/// Open a validated path without following a (newly planted) symlink, and re-check that
/// the handle is a regular file.
///
/// Windows: `FILE_FLAG_OPEN_REPARSE_POINT` opens a symlink or junction ITSELF instead of
/// its target (the `O_NOFOLLOW` of `CreateFileW`), and a handle whose attributes say
/// reparse point is refused — so a link swapped in between [`validate_task_path`] and here
/// is never read through. The canonical path is a verbatim `\\?\C:\…` one there; opening it
/// is ordinary. std's default share mode (read | write | delete) lets Claude keep appending.
pub(super) fn open_checked(canon: &Path) -> Result<File, PathRefusal> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts
        .open(canon)
        .map_err(|e| PathRefusal::Unreadable(e.to_string()))?;
    let md = file
        .metadata()
        .map_err(|e| PathRefusal::Unreadable(e.to_string()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let reparse = windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if md.file_attributes() & reparse != 0 {
            return Err(PathRefusal::NotRegularFile);
        }
    }
    if !md.is_file() {
        return Err(PathRefusal::NotRegularFile);
    }
    Ok(file)
}

// ── the command grammar ─────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum Tok {
    Word(String),
    /// `;`, newline, `&&`, `||`, `&`, `(`, `)` — ends a simple command.
    Sep,
    /// `|` — the next simple command is a filter of this one.
    Pipe,
}

/// A small shell lexer: enough quoting (`'…'`, `"…"`, `\`, `$(…)`, backticks) that a
/// separator inside a string or a command substitution does not split the command.
fn lex(cmd: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let chars: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    let flush = |word: &mut String, in_word: &mut bool, out: &mut Vec<Tok>| {
        if *in_word {
            out.push(Tok::Word(std::mem::take(word)));
            *in_word = false;
        }
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                in_word = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
            }
            '"' => {
                in_word = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
            }
            '\\' => {
                in_word = true;
                if i + 1 < chars.len() && chars[i + 1] != '\n' {
                    word.push(chars[i + 1]);
                }
                i += 1;
            }
            '`' => {
                in_word = true;
                word.push(c);
                i += 1;
                while i < chars.len() && chars[i] != '`' {
                    word.push(chars[i]);
                    i += 1;
                }
                word.push('`');
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                // `$(…)`, nested: one word however many separators it holds.
                in_word = true;
                let mut depth = 0usize;
                while i < chars.len() {
                    let ch = chars[i];
                    word.push(ch);
                    if ch == '(' {
                        depth += 1;
                    } else if ch == ')' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    i += 1;
                }
            }
            ' ' | '\t' => flush(&mut word, &mut in_word, &mut out),
            '\n' | ';' | '(' | ')' => {
                flush(&mut word, &mut in_word, &mut out);
                out.push(Tok::Sep);
            }
            '&' => {
                // `2>&1`, `>&2`, `&>file` are redirections, not separators.
                if word.ends_with('>') || word.ends_with('<') || chars.get(i + 1) == Some(&'>') {
                    in_word = true;
                    word.push(c);
                } else {
                    flush(&mut word, &mut in_word, &mut out);
                    if chars.get(i + 1) == Some(&'&') {
                        i += 1;
                    }
                    out.push(Tok::Sep);
                }
            }
            '|' if word.ends_with('>') => {
                // `>|` (clobber) is a redirection, not a pipe.
                in_word = true;
                word.push(c);
            }
            '|' => {
                flush(&mut word, &mut in_word, &mut out);
                if chars.get(i + 1) == Some(&'|') {
                    i += 1;
                    out.push(Tok::Sep);
                } else {
                    out.push(Tok::Pipe);
                }
            }
            _ => {
                in_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    flush(&mut word, &mut in_word, &mut out);
    out
}

fn is_assignment(w: &str) -> bool {
    let Some((name, _)) = w.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// What a redirection word does with its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Redir {
    /// `>`, `>>`, `>|`, `&>`, `&>>`: the target is a file written to.
    Out,
    /// `>&`: a descriptor dup when the target is a digit or `-` (`2>&1`, `>&-`), else
    /// bash's `>& file` (both streams to a file).
    DupOrOut,
    /// `<`, `<<`, `<<<`, `<>`: the target is read, not written.
    In,
    /// `<&`: a dup, never a file.
    Dup,
}

/// `(what it does, the target attached to the word)` for a redirection word — `>file`,
/// `2>&1`, `&>log`, `>` (target is the NEXT word: attached is empty) — else `None`.
fn parse_redirection(w: &str) -> Option<(Redir, &str)> {
    let rest = w.trim_start_matches(|c: char| c.is_ascii_digit());
    const OPS: &[(&str, Redir)] = &[
        ("&>>", Redir::Out),
        ("&>", Redir::Out),
        (">>", Redir::Out),
        (">|", Redir::Out),
        (">&", Redir::DupOrOut),
        ("<&", Redir::Dup),
        ("<<<", Redir::In),
        ("<<", Redir::In),
        ("<>", Redir::In),
        (">", Redir::Out),
        ("<", Redir::In),
    ];
    let (op, kind) = OPS.iter().find(|(op, _)| rest.starts_with(op))?;
    Some((*kind, &rest[op.len()..]))
}

/// `>file`, `2>&1`, `<in`, `&>log` — and whether the target is the NEXT word.
fn redirection(w: &str) -> Option<bool> {
    parse_redirection(w).map(|(_, attached)| attached.is_empty())
}

/// Words that only prefix the real program.
const WRAPPERS: &[&str] = &[
    "exec",
    "nohup",
    "time",
    "command",
    "builtin",
    "env",
    "sudo",
    "nice",
    "stdbuf",
    "setsid",
    "caffeinate",
];
/// Shell grammar that opens or continues a compound command: strip and look further.
const LEADING_KEYWORDS: &[&str] = &[
    "if", "then", "else", "elif", "while", "until", "do", "!", "{", "}", "done", "fi",
];
/// Headers whose whole simple command is grammar, not a program.
const HEADER_KEYWORDS: &[&str] = &["for", "case", "select", "function", "esac", "in"];
/// Commands that prepare for the program rather than being it.
const SETUP: &[&str] = &[
    "cd", "pushd", "popd", "export", "set", "unset", "source", ".", "alias", "umask", "ulimit",
    "trap", ":", "true", "false", "shopt", "local", "declare", "typeset", "readonly", "sleep",
    "mkdir", "rm", "touch", "echo", "printf", "test", "[", "[[", "wait",
];

fn basename(w: &str) -> &str {
    w.rsplit('/').find(|s| !s.is_empty()).unwrap_or(w)
}

/// One simple command of a line: its words, and whether it is the right-hand side of a
/// pipe (a filter of the command before it).
struct Simple<'a> {
    words: Vec<&'a str>,
    is_filter: bool,
}

fn simple_commands(toks: &[Tok]) -> Vec<Simple<'_>> {
    let mut out = Vec::new();
    let mut filter = false;
    let mut i = 0;
    while i < toks.len() {
        let mut j = i;
        while j < toks.len() && matches!(toks[j], Tok::Word(_)) {
            j += 1;
        }
        let is_filter = filter;
        filter = matches!(toks.get(j), Some(Tok::Pipe));
        let words = toks[i..j]
            .iter()
            .filter_map(|t| match t {
                Tok::Word(w) => Some(w.as_str()),
                _ => None,
            })
            .collect();
        i = j + 1;
        out.push(Simple { words, is_filter });
    }
    out
}

/// Index of the program word of a simple command: env assignments, wrappers (`exec`,
/// `nohup`, `env …`) and redirections are skipped. `None` = only grammar (`for i in …`).
fn program_index(words: &[&str]) -> Option<usize> {
    let mut k = 0;
    let mut wrapper = false;
    while k < words.len() {
        let w = words[k];
        if let Some(next_is_target) = redirection(w) {
            k += if next_is_target { 2 } else { 1 };
            continue;
        }
        if is_assignment(w) || LEADING_KEYWORDS.contains(&w) {
            k += 1;
            continue;
        }
        if wrapper && w.starts_with('-') {
            k += 1;
            continue;
        }
        if WRAPPERS.contains(&w) {
            wrapper = true;
            k += 1;
            continue;
        }
        if HEADER_KEYWORDS.contains(&w) {
            return None;
        }
        return Some(k);
    }
    None
}

/// The program a background command actually runs, by basename: env assignments,
/// wrappers (`exec`, `nohup`, `env …`), redirections and setup commands (`cd … &&`,
/// `export`, `source`) are skipped, and in a pipeline the producer wins
/// (`cargo run 2>&1 | tee log` → `cargo`). When every command is setup, the first one
/// is the answer; an empty command is `task`.
pub fn program_of(command: &str) -> String {
    let toks = lex(command);
    let mut first_any: Option<String> = None;
    for cmd in simple_commands(&toks) {
        if cmd.is_filter {
            continue;
        }
        let Some(p) = program_index(&cmd.words) else {
            continue;
        };
        let name = basename(cmd.words[p]);
        if name.is_empty() {
            continue;
        }
        if SETUP.contains(&name) {
            first_any.get_or_insert_with(|| name.to_string());
            continue;
        }
        return name.to_string();
    }
    first_any.unwrap_or_else(|| "task".to_string())
}

/// Every simple command of `command` as `(words, index of its program word)` — the same
/// quote-aware grammar as [`program_of`] (quotes removed, so `-x ''` is `-x` then an empty
/// word), for the proxy-bypass detector ([`super::bypass`]).
pub(crate) fn simple_command_words(command: &str) -> Vec<(Vec<String>, Option<usize>)> {
    let toks = lex(command);
    simple_commands(&toks)
        .into_iter()
        .map(|c| {
            let at = program_index(&c.words);
            (c.words.iter().map(|w| (*w).to_string()).collect(), at)
        })
        .collect()
}

/// Every file the command redirects output to, in command order, each once, as written
/// (quotes removed; a `$VAR` stays — it cannot be expanded here). The grammar: `> f`,
/// `>f`, `>> f`, `>| f`, `N> f`, `N>> f`, `&> f`, `&>> f`, `>& f` (a file when `f` is not
/// a descriptor), and `| tee [-a|-i|-p|--append|…] f…`. A dup (`2>&1`, `>&2`, `>&-`), an
/// input redirection (`< f`, `<< EOF`, `<<< s`) and `/dev/*` name no file to tail. Every
/// simple command of the line is looked at — a filter's `> out` counts, a setup step's
/// `echo x > f` too (it is what the agent wrote) — but not inside `$(…)` or backticks.
pub fn redirect_targets(command: &str) -> Vec<String> {
    let toks = lex(command);
    let mut out: Vec<String> = Vec::new();
    let mut push = |t: &str| {
        if !t.is_empty() && !t.starts_with("/dev/") && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    };
    for cmd in simple_commands(&toks) {
        let words = &cmd.words;
        let mut k = 0;
        while k < words.len() {
            if let Some((kind, attached)) = parse_redirection(words[k]) {
                let (target, consumed) = if attached.is_empty() {
                    (words.get(k + 1).copied(), 2)
                } else {
                    (Some(attached), 1)
                };
                if let Some(t) = target {
                    let is_file = match kind {
                        Redir::Out => true,
                        Redir::DupOrOut => !(t == "-" || t.chars().all(|c| c.is_ascii_digit())),
                        Redir::In | Redir::Dup => false,
                    };
                    if is_file {
                        push(t);
                    }
                }
                k += consumed;
                continue;
            }
            k += 1;
        }
        // `… | tee svc.log`: tee's operands are files it writes.
        let Some(p) = program_index(words) else {
            continue;
        };
        if basename(words[p]) != "tee" {
            continue;
        }
        let mut k = p + 1;
        while k < words.len() {
            let w = words[k];
            if let Some(next_is_target) = redirection(w) {
                k += if next_is_target { 2 } else { 1 };
                continue;
            }
            if !w.starts_with('-') {
                push(w);
            }
            k += 1;
        }
    }
    out
}

/// The stem of a redirect target: its basename up to the first `.` (`gazelle.log` →
/// `gazelle`, `server.log.1` → `server`, `.log` → empty).
fn target_stem(target: &str) -> &str {
    basename(target).split('.').next().unwrap_or("")
}

/// Names that say nothing about WHAT is logging — the program's name is better than these.
const GENERIC_STEMS: &[&str] = &[
    "out", "output", "log", "logs", "stdout", "stderr", "nohup", "tmp", "temp", "null",
];

/// Whether a redirect target's name is too generic to name the task after (see
/// [`source_name`]): one of [`GENERIC_STEMS`] (any case), Claude's own `<id>.output`, an
/// unexpanded `$VAR`, an id (all digits, or all hex digits with at least one digit — a
/// hex-looking word with no digit, `beef`, is more likely a name), or empty.
pub fn is_generic_target(target: &str) -> bool {
    let name = basename(target);
    let stem = target_stem(target);
    let lower = stem.to_ascii_lowercase();
    lower.is_empty()
        || GENERIC_STEMS.contains(&lower.as_str())
        || name.ends_with(".output")
        || stem.contains(['$', '`'])
        || (stem.chars().all(|c| c.is_ascii_hexdigit()) && stem.chars().any(|c| c.is_ascii_digit()))
}

/// What a task's `source` is named after: the first redirect target whose name is not
/// generic — the agent named the log after the service (`> gazelle.log` → `gazelle`) —
/// else the program ([`program_of`]). A pure function of the command: it names the
/// intent, whether or not that target ends up tailed.
pub fn source_name(command: &str) -> String {
    redirect_targets(command)
        .iter()
        .find(|t| !is_generic_target(t))
        .map(|t| target_stem(t).to_string())
        .unwrap_or_else(|| program_of(command))
}

/// `"<name> · bg"` — a task line's `source` ([`source_name`] + [`BG_SUFFIX`]).
pub fn task_source(command: &str) -> String {
    format!("{}{BG_SUFFIX}", source_name(command))
}

/// A redirect target placed on the filesystem, or why it could not be.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Placed {
    Path(PathBuf),
    /// An unexpanded variable, a `~`, or a relative path with no cwd to place it against.
    Unplaceable(String),
}

impl Placed {
    fn shown(&self) -> String {
        match self {
            Placed::Path(p) => p.display().to_string(),
            Placed::Unplaceable(raw) => raw.clone(),
        }
    }
    fn label(&self) -> String {
        basename(&self.shown()).to_string()
    }
}

/// Absolute as written; relative against `cwd` (the agent's, from the transcript). The
/// path guard decides afterwards whether the result is under a root.
fn place(raw: &str, cwd: Option<&Path>) -> Placed {
    place_for(raw, cwd, cfg!(windows))
}

/// [`place`] with the platform as a parameter, so every OS tests the Windows answer.
///
/// On Windows Claude's Bash tool is Git Bash, so a command names files the MSYS way:
/// `/c/Users/me/out.log` is `C:\Users\me\out.log` ([`msys_drive_path`]). Any other path that
/// starts at a root without a drive (`/tmp/x.log`, `\x.log`) means something only that
/// shell knows (its mount table) — unplaceable, never silently `C:\tmp\x.log`.
fn place_for(raw: &str, cwd: Option<&Path>, windows: bool) -> Placed {
    if raw.contains(['$', '`']) || raw.starts_with('~') {
        return Placed::Unplaceable(raw.to_string());
    }
    if windows && raw.starts_with(['/', '\\']) {
        return match msys_drive_path(raw) {
            Some(p) => Placed::Path(p),
            None => Placed::Unplaceable(raw.to_string()),
        };
    }
    let p = Path::new(raw);
    if p.is_absolute() {
        return Placed::Path(p.to_path_buf());
    }
    match cwd {
        Some(c) if c.is_absolute() => Placed::Path(c.join(p)),
        _ => Placed::Unplaceable(raw.to_string()),
    }
}

/// `/c/Users/me/x.log` → `C:\Users\me\x.log` (`C:/Users/me/x.log` on a non-Windows
/// host, where only the text matters): Git Bash's spelling of a drive path. `None` for
/// anything that is not `/<one letter>/…` or `/<one letter>`.
fn msys_drive_path(raw: &str) -> Option<PathBuf> {
    let rest = raw.strip_prefix('/')?;
    let mut chars = rest.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    let tail = chars.as_str();
    if !(tail.is_empty() || tail.starts_with('/')) {
        return None;
    }
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let tail = tail.trim_start_matches('/').replace('/', &sep.to_string());
    Some(PathBuf::from(format!(
        "{}:{sep}{tail}",
        drive.to_ascii_uppercase()
    )))
}

// ── the concurrency budget ──────────────────────────────────────────────────

/// How many tasks may be tailed at once, app-wide. Cheap to clone; a slot is released
/// when its [`TaskSlot`] drops — including when an aborted tailer drops its tails, so a
/// session ending always gives its slots back.
#[derive(Clone, Debug)]
pub struct TaskSlots {
    used: Arc<AtomicUsize>,
    max: usize,
}

impl TaskSlots {
    pub fn new(max: usize) -> Self {
        Self {
            used: Arc::new(AtomicUsize::new(0)),
            max,
        }
    }

    // `fetch_update` is deprecated (renamed `try_update`) from Rust 1.99, but
    // `try_update` doesn't exist on the 1.97 toolchain this repo is verified with.
    #[allow(deprecated)]
    pub fn try_acquire(&self) -> Option<TaskSlot> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < self.max).then_some(n + 1)
            })
            .ok()
            .map(|_| TaskSlot(self.used.clone()))
    }

    pub fn in_use(&self) -> usize {
        self.used.load(Ordering::Acquire)
    }
}

/// One held slot of a [`TaskSlots`].
#[derive(Debug)]
pub struct TaskSlot(Arc<AtomicUsize>);

impl Drop for TaskSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

// ── the tails ───────────────────────────────────────────────────────────────

/// A background task to tail, as the transcript reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSpec {
    /// The agent that launched it.
    pub agent_id: String,
    pub task_id: String,
    pub command: String,
    /// The output file, as reported (validated before it is opened).
    pub path: PathBuf,
    /// The agent's working directory at the launch (the transcript line's `cwd`), for a
    /// relative redirect target in `command`. `None` = a relative target is not placed.
    pub cwd: Option<PathBuf>,
}

/// One file of a task's tail: its `.output`, or a file its command redirects to. Also the
/// reader behind an app's log tail ([`super::apps`]), which opens the file itself
/// (its guard is "the process has it open", not the temp root) and backfills less.
pub(super) struct TailFile {
    /// As requested (validated before it is opened).
    path: PathBuf,
    /// Its basename, for the line that says it is no longer tailed.
    label: String,
    file: Option<File>,
    /// The resolved path the open handle came from (to notice the file being removed).
    canon: Option<PathBuf>,
    offset: u64,
    backfilled: bool,
    splitter: LineSplitter,
    last_growth: Instant,
    limiter: RateLimiter,
    /// At most this many lines of what the file held before the tail started.
    backfill_lines: usize,
}

impl TailFile {
    fn new(path: PathBuf, now: Instant) -> Self {
        let label = basename(&path.to_string_lossy()).to_string();
        Self {
            path,
            label,
            file: None,
            canon: None,
            offset: 0,
            backfilled: false,
            splitter: LineSplitter::new(),
            last_growth: now,
            limiter: RateLimiter::new(TASK_LINES_PER_SEC),
            backfill_lines: TASK_BACKFILL_LINES,
        }
    }

    /// A file the caller has already validated and opened (`canon` = what it resolved to),
    /// backfilling at most `backfill_lines` lines.
    pub(super) fn opened(
        path: PathBuf,
        file: File,
        canon: PathBuf,
        now: Instant,
        backfill_lines: usize,
    ) -> Self {
        let mut t = Self::new(path, now);
        t.file = Some(file);
        t.canon = Some(canon);
        t.backfill_lines = backfill_lines;
        t
    }

    /// The resolved path of the open handle.
    pub(super) fn canon(&self) -> Option<&Path> {
        self.canon.as_deref()
    }

    /// Resolve and open the file if not yet open. `Err` = give up on this file.
    fn ensure_open(&mut self, roots: &[PathBuf]) -> Result<bool, PathRefusal> {
        if self.file.is_some() {
            return Ok(true);
        }
        match validate_task_path(&self.path, roots) {
            Ok(canon) => {
                self.file = Some(open_checked(&canon)?);
                self.canon = Some(canon);
                Ok(true)
            }
            Err(PathRefusal::Missing) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Everything new in the file, as `(level, text)` task lines. `final_read`: flush a
    /// partial line too.
    pub(super) fn read_new(&mut self, now: Instant, final_read: bool) -> Vec<(LogLevel, String)> {
        let mut out = Vec::new();
        let Some(file) = self.file.as_mut() else {
            return out;
        };
        let Ok(len) = file.metadata().map(|m| m.len()) else {
            return out;
        };
        if len < self.offset {
            // Truncated / rewritten: start over.
            self.offset = 0;
            self.splitter.reset();
        }
        let mut skip_partial_first = false;
        let mut notice: Option<String> = None;
        let budget = if self.backfilled {
            if len - self.offset > TASK_MAX_BACKLOG {
                let skipped = len - TASK_READ_PER_POLL - self.offset;
                self.offset = len - TASK_READ_PER_POLL;
                self.splitter.reset();
                skip_partial_first = true;
                notice = Some(format!(
                    "… {skipped} bytes skipped (output faster than the log)"
                ));
            }
            TASK_READ_PER_POLL
        } else {
            if len > TASK_BACKFILL_BYTES {
                self.offset = len - TASK_BACKFILL_BYTES;
                skip_partial_first = true;
            }
            TASK_BACKFILL_BYTES
        };
        let want = (len - self.offset).min(budget);
        let mut buf = Vec::with_capacity(want as usize);
        if want > 0 {
            let read = file
                .seek(SeekFrom::Start(self.offset))
                .and_then(|_| file.by_ref().take(want).read_to_end(&mut buf));
            if read.is_err() {
                buf.clear();
            }
        }
        self.offset += buf.len() as u64;
        let grew = !buf.is_empty();
        if skip_partial_first {
            // We landed mid-line: drop up to the first newline.
            let cut = buf
                .iter()
                .position(|&b| b == b'\n')
                .map_or(buf.len(), |p| p + 1);
            buf.drain(..cut);
        }
        let mut lines = self.splitter.feed(&buf);
        if grew {
            self.last_growth = now;
        }
        if (final_read || now.duration_since(self.last_growth) >= PARTIAL_FLUSH_AFTER)
            && self.splitter.has_partial()
        {
            lines.extend(self.splitter.flush_partial());
        }
        if !self.backfilled {
            self.backfilled = true;
            let mut skipped = skip_partial_first;
            let keep = self.backfill_lines;
            if lines.len() > keep {
                lines.drain(..lines.len() - keep);
                skipped = true;
            }
            if skipped {
                out.push((
                    LogLevel::Info,
                    format!("… earlier output not shown (the last {keep} lines are)"),
                ));
            }
            // The backfill is one bounded burst; the rate cap is for what follows.
            out.extend(lines.into_iter().map(|t| (classify_level(&t), t)));
            return out;
        }
        if let Some(n) = notice {
            out.push((LogLevel::Warn, n));
        }
        for t in lines {
            if self.limiter.admit(now) {
                out.push((classify_level(&t), t));
            }
        }
        if let Some(n) = self.limiter.take_drop_report(now) {
            out.push((LogLevel::Warn, format!("… {n} lines dropped (rate limit)")));
        }
        out
    }
}

struct Tail {
    spec: TaskSpec,
    /// `program_of(command)` — the name in the start/stop lines.
    program: String,
    source: String,
    detail: String,
    _slot: TaskSlot,
    started: Instant,
    /// The `.output` file first, then the redirect targets that passed (or await) the
    /// guard. Never empty while the tail lives.
    files: Vec<TailFile>,
}

impl Tail {
    fn line(&self, kind: LogKind, level: LogLevel, text: String) -> LineDraft {
        LineDraft {
            terminal_id: None,
            agent_id: Some(self.spec.agent_id.clone()),
            source: self.source.clone(),
            kind,
            level,
            text,
            detail: Some(self.detail.clone()),
            ts_ms: None,
            tool_use_id: None,
        }
    }

    /// When any of the task's files last grew.
    fn last_growth(&self) -> Instant {
        self.files
            .iter()
            .map(|f| f.last_growth)
            .max()
            .unwrap_or(self.started)
    }

    /// A last read of every open file (a partial line is flushed).
    fn read_all(&mut self, now: Instant) -> Vec<LineDraft> {
        let mut lines = Vec::new();
        for f in &mut self.files {
            if f.file.is_some() {
                lines.extend(f.read_new(now, true));
            }
        }
        lines
            .into_iter()
            .map(|(lv, t)| self.line(LogKind::Task, lv, t))
            .collect()
    }
}

/// The fixed opening of a tail's first `system` line. **Wire text**: the UI builds its
/// "Running" list from this prefix and [`STOPPED_PREFIX`] — do not reword them.
pub const STARTED_PREFIX: &str = "background task started · ";
/// The fixed opening of a tail's last `system` line (see [`STARTED_PREFIX`]).
pub const STOPPED_PREFIX: &str = "background task stopped · ";

/// Why a tail ended — the ` — <reason>` of its closing line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// No growth in any file for [`TASK_IDLE_STOP`].
    Idle,
    /// A `TaskStop` / `KillShell` named it.
    TaskStopped,
    /// Its session ended (the owning tailer was dropped).
    SessionEnded,
    /// Its last file was deleted.
    FileGone,
    /// Its only file appeared after the start and failed the path guard.
    Refused(PathRefusal),
}

impl std::fmt::Display for StopReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StopReason::Idle => write!(f, "no output for {} min", TASK_IDLE_STOP.as_secs() / 60),
            StopReason::TaskStopped => write!(f, "stopped by the agent"),
            StopReason::SessionEnded => write!(f, "session ended"),
            StopReason::FileGone => write!(f, "output file removed"),
            StopReason::Refused(e) => write!(f, "not tailed: {e}"),
        }
    }
}

/// Where the closing lines of tails still open when their [`TaskTails`] is dropped go
/// (a session ending aborts its tailer, which drops it).
pub type DropSink = Box<dyn FnOnce(Vec<LineDraft>) + Send>;

/// The background-task tails of one root session (owned by its tailer task).
pub struct TaskTails {
    roots: Vec<PathBuf>,
    slots: TaskSlots,
    tails: Vec<Tail>,
    on_drop: Option<DropSink>,
}

impl TaskTails {
    pub fn new(roots: Vec<PathBuf>, slots: TaskSlots) -> Self {
        Self {
            roots,
            slots,
            tails: Vec::new(),
            on_drop: None,
        }
    }

    /// Deliver `session ended` closing lines through `sink` when dropped.
    pub fn on_drop(mut self, sink: DropSink) -> Self {
        self.on_drop = Some(sink);
        self
    }

    /// Task ids being tailed (or waiting for their file), in start order.
    pub fn task_ids(&self) -> Vec<String> {
        self.tails.iter().map(|t| t.spec.task_id.clone()).collect()
    }

    /// The files a task tails (or waits for), as requested: its `.output` first.
    pub fn tailed_paths(&self, task_id: &str) -> Vec<PathBuf> {
        self.tails
            .iter()
            .find(|t| t.spec.task_id == task_id)
            .map(|t| t.files.iter().map(|f| f.path.clone()).collect())
            .unwrap_or_default()
    }

    /// Start tailing. Returns the `system` line announcing it (or why not), then one
    /// `warn` line per redirect target that will not be tailed. The files are read on
    /// the next [`TaskTails::poll`].
    pub fn start(&mut self, spec: TaskSpec, now: Instant) -> Vec<LineDraft> {
        if self.tails.iter().any(|t| t.spec.task_id == spec.task_id) {
            return Vec::new();
        }
        let program = program_of(&spec.command);
        let source = task_source(&spec.command);
        let targets: Vec<Placed> = redirect_targets(&spec.command)
            .iter()
            .map(|raw| place(raw, spec.cwd.as_deref()))
            .collect();
        // The command, then every path: the `.output` file and each redirect target as
        // placed (or as written when it could not be) — the refused ones too, so the
        // drawer still says where the agent sent the output.
        let mut paths = vec![spec.path.display().to_string()];
        paths.extend(targets.iter().map(Placed::shown));
        let detail = cap_text(
            &format!("{}\n{}", spec.command, paths.join("\n")),
            TASK_DETAIL_BYTES,
        );
        let system = |level, text: String| LineDraft {
            terminal_id: None,
            agent_id: Some(spec.agent_id.clone()),
            source: source.clone(),
            kind: LogKind::System,
            level,
            text,
            detail: Some(detail.clone()),
            ts_ms: None,
            tool_use_id: None,
        };
        // Refuse a bad `.output` path now rather than holding a slot for it.
        match validate_task_path(&spec.path, &self.roots) {
            Ok(_) | Err(PathRefusal::Missing) => {}
            Err(e) => {
                return vec![system(
                    LogLevel::Warn,
                    format!("not tailing background task {}: {e}", spec.task_id),
                )]
            }
        }
        let Some(slot) = self.slots.try_acquire() else {
            return vec![system(
                LogLevel::Warn,
                format!(
                    "not tailing background task {}: {MAX_TASK_TAILS} background tasks are already tailed",
                    spec.task_id
                ),
            )];
        };
        let mut out = vec![system(
            LogLevel::Info,
            format!("{STARTED_PREFIX}{program} ({})", spec.task_id),
        )];
        let mut files = vec![TailFile::new(spec.path.clone(), now)];
        for target in targets {
            let name = target.label();
            let path = match target {
                Placed::Path(p) => p,
                Placed::Unplaceable(raw) => {
                    out.push(system(
                        LogLevel::Warn,
                        format!("not tailing {name}: {raw} could not be resolved"),
                    ));
                    continue;
                }
            };
            if files.iter().any(|f| f.path == path) {
                continue; // named twice, or the `.output` file itself
            }
            if files.len() >= MAX_TASK_FILES {
                out.push(system(
                    LogLevel::Warn,
                    format!("not tailing {name}: a task tails at most {MAX_TASK_FILES} files"),
                ));
                continue;
            }
            match validate_task_path(&path, &self.roots) {
                Ok(_) | Err(PathRefusal::Missing) => files.push(TailFile::new(path, now)),
                Err(PathRefusal::OutsideRoot | PathRefusal::NotAbsolute) => out.push(system(
                    LogLevel::Warn,
                    format!("not tailing {name}: outside the IDE's temp root"),
                )),
                Err(e) => out.push(system(LogLevel::Warn, format!("not tailing {name}: {e}"))),
            }
        }
        self.tails.push(Tail {
            program,
            source,
            detail,
            _slot: slot,
            started: now,
            files,
            spec,
        });
        out
    }

    /// Stop tailing `task_id` (a `TaskStop` named it), after reading what it wrote last.
    pub fn stop(&mut self, task_id: &str, now: Instant) -> Vec<LineDraft> {
        let Some(i) = self.tails.iter().position(|t| t.spec.task_id == task_id) else {
            return Vec::new();
        };
        let mut tail = self.tails.remove(i);
        let mut out = tail.read_all(now);
        out.push(closing(&tail, &StopReason::TaskStopped));
        out
    }

    /// Read every tail; end the idle ones and those whose last file is gone. A file that
    /// turns out refused or removed while others remain is dropped on its own (with a
    /// `warn` line when refused), and the task goes on.
    pub fn poll(&mut self, now: Instant) -> Vec<LineDraft> {
        let mut out = Vec::new();
        let roots = self.roots.clone();
        self.tails.retain_mut(|tail| {
            let mut i = 0;
            while i < tail.files.len() {
                let only = tail.files.len() == 1;
                match tail.files[i].ensure_open(&roots) {
                    Ok(true) => {
                        // Two names for one file (`/tmp/…` and `/private/tmp/…`, a link
                        // inside the root): the first one read is enough.
                        let canon = tail.files[i].canon.clone();
                        if tail.files[..i].iter().any(|f| f.canon == canon) {
                            tail.files.remove(i);
                            continue;
                        }
                        let lines = tail.files[i].read_new(now, false);
                        out.extend(
                            lines
                                .into_iter()
                                .map(|(lv, t)| tail.line(LogKind::Task, lv, t)),
                        );
                    }
                    Ok(false) => {}
                    Err(e) => {
                        if only {
                            out.push(closing(tail, &StopReason::Refused(e)));
                            return false;
                        }
                        out.push(tail.line(
                            LogKind::System,
                            LogLevel::Warn,
                            format!("not tailing {}: {e}", tail.files[i].label),
                        ));
                        tail.files.remove(i);
                        continue;
                    }
                }
                if tail.files[i].canon.as_deref().is_some_and(|c| !c.exists()) {
                    if only {
                        out.extend(tail.read_all(now));
                        out.push(closing(tail, &StopReason::FileGone));
                        return false;
                    }
                    tail.files.remove(i);
                    continue;
                }
                i += 1;
            }
            if now.duration_since(tail.last_growth()) >= TASK_IDLE_STOP {
                out.extend(tail.read_all(now));
                out.push(closing(tail, &StopReason::Idle));
                return false;
            }
            true
        });
        out
    }
}

impl Drop for TaskTails {
    fn drop(&mut self) {
        let Some(sink) = self.on_drop.take() else {
            return;
        };
        let lines: Vec<LineDraft> = self
            .tails
            .iter()
            .map(|t| closing(t, &StopReason::SessionEnded))
            .collect();
        if !lines.is_empty() {
            sink(lines);
        }
    }
}

/// `background task stopped · <program> (<task id>) — <reason>`.
fn closing(tail: &Tail, why: &StopReason) -> LineDraft {
    let level = match why {
        StopReason::Refused(_) => LogLevel::Warn,
        _ => LogLevel::Info,
    };
    tail.line(
        LogKind::System,
        level,
        format!(
            "{STOPPED_PREFIX}{} ({}) — {why}",
            tail.program, tail.spec.task_id
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slot_is_released_when_it_drops() {
        let s = TaskSlots::new(2);
        let a = s.try_acquire().unwrap();
        let _b = s.try_acquire().unwrap();
        assert!(s.try_acquire().is_none());
        drop(a);
        assert_eq!(s.in_use(), 1);
        assert!(s.try_acquire().is_some());
    }

    #[test]
    fn redirections_are_recognised_with_and_without_their_target() {
        assert_eq!(redirection(">"), Some(true));
        assert_eq!(redirection(">log"), Some(false));
        assert_eq!(redirection("2>&1"), Some(false));
        assert_eq!(redirection("&>"), Some(true));
        assert_eq!(redirection(">|"), Some(true));
        assert_eq!(redirection("gazelle"), None);
        assert_eq!(redirection("2"), None);
        assert_eq!(parse_redirection("2>>x"), Some((Redir::Out, "x")));
        assert_eq!(parse_redirection(">&2"), Some((Redir::DupOrOut, "2")));
        assert_eq!(parse_redirection("<&0"), Some((Redir::Dup, "0")));
        assert_eq!(parse_redirection("<<<"), Some((Redir::In, "")));
    }

    #[test]
    fn the_lexer_keeps_separators_inside_quotes_and_substitutions() {
        assert_eq!(
            lex("T=$(grep a b | cut -d= -f2-); ./x 'a;b' \"c|d\""),
            vec![
                Tok::Word("T=$(grep a b | cut -d= -f2-)".into()),
                Tok::Sep,
                Tok::Word("./x".into()),
                Tok::Word("a;b".into()),
                Tok::Word("c|d".into()),
            ]
        );
    }

    #[test]
    fn the_lexer_reads_clobber_as_a_redirection_not_a_pipe() {
        assert_eq!(
            lex("./x >| out.log | tee t.log"),
            vec![
                Tok::Word("./x".into()),
                Tok::Word(">|".into()),
                Tok::Word("out.log".into()),
                Tok::Pipe,
                Tok::Word("tee".into()),
                Tok::Word("t.log".into()),
            ]
        );
    }

    #[test]
    fn a_relative_target_is_placed_against_the_cwd_and_a_variable_is_not() {
        // An absolute cwd and an absolute target, in this OS's own spelling (`/w` is not
        // absolute on Windows — it has no drive).
        let (cwd, abs) = if cfg!(windows) {
            (Path::new(r"C:\w"), r"C:\abs.log")
        } else {
            (Path::new("/w"), "/abs.log")
        };
        assert_eq!(
            place("svc.log", Some(cwd)),
            Placed::Path(cwd.join("svc.log"))
        );
        assert_eq!(place(abs, Some(cwd)), Placed::Path(PathBuf::from(abs)));
        assert_eq!(
            place("svc.log", None),
            Placed::Unplaceable("svc.log".into())
        );
        assert_eq!(
            place("$R/svc.log", Some(cwd)),
            Placed::Unplaceable("$R/svc.log".into())
        );
        assert_eq!(
            place("~/svc.log", Some(cwd)),
            Placed::Unplaceable("~/svc.log".into())
        );
        assert_eq!(place("$R/svc.log", None).label(), "svc.log");
    }

    /// Windows semantics, on every OS: Git Bash's `/c/…` is drive C:, and any other
    /// drive-less root (`/tmp`, `\x`) is unplaceable rather than guessed at.
    #[test]
    fn on_windows_a_git_bash_drive_path_is_placed_and_other_rooted_paths_are_not() {
        let sep = if cfg!(windows) { r"\" } else { "/" };
        let drive = |s: &str| Placed::Path(PathBuf::from(s.replace('/', sep)));
        let cwd = Some(Path::new(r"C:\w"));
        assert_eq!(
            place_for("/c/Users/me/out.log", cwd, true),
            drive("C:/Users/me/out.log")
        );
        assert_eq!(place_for("/d", cwd, true), drive("D:/"));
        assert_eq!(place_for("/z/", None, true), drive("Z:/"));
        for raw in ["/tmp/x.log", r"\x.log", "/cc/x.log", "/1/x.log", "/"] {
            assert_eq!(
                place_for(raw, cwd, true),
                Placed::Unplaceable(raw.to_string()),
                "{raw}"
            );
        }
        // The same text off Windows is an ordinary absolute path.
        if !cfg!(windows) {
            assert_eq!(
                place_for("/c/Users/me/out.log", None, false),
                Placed::Path(PathBuf::from("/c/Users/me/out.log"))
            );
        }
    }

    /// Every expectation written out: `TEMP` first (Node's `os.tmpdir()`),
    /// then `TMP`, then `GetTempPath2W`'s answer — each once, each `…\claude`.
    #[test]
    fn the_windows_roots_are_claude_under_each_temp_candidate_once() {
        use std::ffi::OsString;
        let t = |s: &str| Some(OsString::from(s));
        assert_eq!(
            windows_temp_roots(t("/a"), t("/b"), PathBuf::from("/c")),
            vec![
                PathBuf::from("/a").join("claude"),
                PathBuf::from("/b").join("claude"),
                PathBuf::from("/c").join("claude"),
            ]
        );
        assert_eq!(
            windows_temp_roots(t("/a"), t("/a"), PathBuf::from("/a")),
            vec![PathBuf::from("/a").join("claude")]
        );
        assert_eq!(
            windows_temp_roots(None, t(""), PathBuf::from("/c")),
            vec![PathBuf::from("/c").join("claude")]
        );
    }

    #[test]
    fn strictly_under_is_per_component_and_folds_case_only_when_asked() {
        let p = |s: &str| PathBuf::from(s);
        // Not the root itself, not a sibling that merely shares a prefix.
        for fold in [false, true] {
            assert!(strictly_under(&p("/r/claude/x"), &p("/r/claude"), fold));
            assert!(!strictly_under(&p("/r/claude"), &p("/r/claude"), fold));
            assert!(!strictly_under(&p("/r/claude-2/x"), &p("/r/claude"), fold));
            assert!(!strictly_under(&p("/r"), &p("/r/claude"), fold));
        }
        assert!(strictly_under(&p("/R/Claude/x"), &p("/r/claude"), true));
        assert!(!strictly_under(&p("/R/Claude/x"), &p("/r/claude"), false));
    }

    // ── Windows: the real temp root, real files, the no-follow open ─────────

    /// A private stand-in for `%TEMP%\claude` with one session's `tasks\`.
    #[cfg(windows)]
    struct WinRoot {
        base: PathBuf,
        root: PathBuf,
        tasks: PathBuf,
    }

    #[cfg(windows)]
    impl WinRoot {
        fn new(tag: &str) -> WinRoot {
            let base = std::env::temp_dir().join(format!("tasktail-{tag}-{}", ulid::Ulid::new()));
            let root = base.join("claude");
            let tasks = root.join("0123456789abcdef").join("sess").join("tasks");
            std::fs::create_dir_all(&tasks).unwrap();
            WinRoot { base, root, tasks }
        }
    }

    #[cfg(windows)]
    impl Drop for WinRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    /// `mklink /J` — a directory junction needs no privilege (a file symlink does, unless
    /// Developer Mode is on), so it is the reparse point every Windows user can plant.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        use crate::spawn::NoWindow as _;
        let out = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .no_window()
            .output()
            .expect("cmd runs");
        assert!(out.status.success(), "mklink /J failed: {out:?}");
    }

    /// The guard on real Windows files: canonical paths are verbatim (`\\?\C:\…`) on both
    /// sides, a junction out of the root is refused, a junction that stays inside is fine,
    /// `..` and a sibling are refused, a missing file under the root is waited for — also
    /// when the transcript spells the root in another case.
    #[cfg(windows)]
    #[test]
    fn on_windows_only_a_regular_file_under_the_claude_root_is_accepted() {
        let r = WinRoot::new("guard");
        let roots = vec![r.root.clone()];
        let ok = r.tasks.join("b1.output");
        std::fs::write(&ok, "x\n").unwrap();
        let canon_ok = std::fs::canonicalize(&ok).unwrap();
        assert!(
            canon_ok.to_string_lossy().starts_with(r"\\?\"),
            "std canonicalises to a verbatim path: {canon_ok:?}"
        );
        assert_eq!(validate_task_path(&ok, &roots), Ok(canon_ok.clone()));

        let outside_dir = r.base.join("elsewhere");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("secret.txt"), "secret\n").unwrap();
        let out_link = r.tasks.join("out");
        junction(&out_link, &outside_dir);
        assert_eq!(
            validate_task_path(&out_link.join("secret.txt"), &roots),
            Err(PathRefusal::OutsideRoot)
        );
        let in_link = r.tasks.join("in");
        junction(&in_link, &r.tasks);
        assert_eq!(
            validate_task_path(&in_link.join("b1.output"), &roots),
            Ok(canon_ok.clone())
        );
        assert_eq!(
            validate_task_path(&r.tasks.join("..").join("tasks").join("b1.output"), &roots),
            Err(PathRefusal::ParentComponent)
        );
        assert_eq!(
            validate_task_path(&r.tasks, &roots),
            Err(PathRefusal::NotRegularFile)
        );
        assert_eq!(
            validate_task_path(&r.root, &roots),
            Err(PathRefusal::OutsideRoot)
        );
        assert_eq!(
            validate_task_path(Path::new(r"tasks\b1.output"), &roots),
            Err(PathRefusal::NotAbsolute)
        );
        assert_eq!(
            validate_task_path(&r.tasks.join("later.output"), &roots),
            Err(PathRefusal::Missing)
        );
        let shouted = PathBuf::from(r.tasks.to_string_lossy().to_uppercase()).join("later.output");
        assert_eq!(
            validate_task_path(&shouted, &roots),
            Err(PathRefusal::Missing),
            "the file system ignores case, so the guard does too"
        );
        assert_eq!(
            validate_task_path(&outside_dir.join("later.log"), &roots),
            Err(PathRefusal::OutsideRoot)
        );
        let sibling = r.base.join("claude2");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("x.output"), "x\n").unwrap();
        assert_eq!(
            validate_task_path(&sibling.join("x.output"), &roots),
            Err(PathRefusal::OutsideRoot)
        );
    }

    /// The open refuses a reparse point even when the path that reaches it was validated:
    /// `FILE_FLAG_OPEN_REPARSE_POINT` opens the junction itself, and its attributes say so.
    /// A plain file opens, reads, and keeps reading while it is appended to.
    #[cfg(windows)]
    #[test]
    fn on_windows_the_checked_open_refuses_a_reparse_point_and_reads_a_growing_file() {
        use std::io::Write as _;
        let r = WinRoot::new("open");
        let ok = r.tasks.join("b1.output");
        std::fs::write(&ok, "one\n").unwrap();
        let canon = validate_task_path(&ok, std::slice::from_ref(&r.root)).unwrap();
        let mut f = open_checked(&canon).expect("a regular file opens");
        let mut text = String::new();
        f.read_to_string(&mut text).unwrap();
        assert_eq!(text, "one\n");
        // Claude keeps the file open for append while we read it.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&ok)
            .unwrap()
            .write_all(b"two\n")
            .unwrap();
        f.read_to_string(&mut text).unwrap();
        assert_eq!(text, "one\ntwo\n");

        // A junction (a directory reparse point): refused — Windows will not even open a
        // directory without FILE_FLAG_BACKUP_SEMANTICS, so this is `Unreadable`.
        let link = r.tasks.join("link");
        junction(&link, &r.tasks);
        let refused = |p: &Path| {
            matches!(
                open_checked(p).map(|_| ()),
                Err(PathRefusal::NotRegularFile | PathRefusal::Unreadable(_))
            )
        };
        assert!(refused(&link), "the junction itself");
        assert!(
            refused(&std::fs::canonicalize(&link).unwrap()),
            "its target, a directory"
        );

        // A FILE symlink to a regular file — the swap the flag exists for: opened as the link
        // itself, whose attributes say reparse point, so `NotRegularFile`, never the target's
        // bytes. Creating one needs Developer Mode or elevation (`SeCreateSymbolicLink`);
        // without it this part cannot be built and says so.
        let file_link = r.tasks.join("swapped.output");
        match std::os::windows::fs::symlink_file(&ok, &file_link) {
            Ok(()) => assert_eq!(
                open_checked(&file_link).map(|_| ()),
                Err(PathRefusal::NotRegularFile),
                "a file symlink is the link, not the file it names"
            ),
            Err(e) if e.raw_os_error() == Some(1314) => {
                println!("file-symlink case not run: no symlink privilege on this machine ({e})")
            }
            Err(e) => panic!("symlink_file: {e}"),
        }
    }

    /// The whole task-tail engine on Windows, as a session drives it: a `Bash` task whose
    /// command is `npm run dev > dev.log 2>&1` (cwd = the session's tasks dir, so the target is
    /// under the root) and whose `.output` does not exist yet; ANOTHER process then creates
    /// the files and keeps appending, holding them open the way Claude and a shell do. Every
    /// file's lines arrive as `task` lines — including a target written the Git Bash way
    /// (`/c/Users/…`, what Claude's Bash tool on Windows writes); a target outside the root is
    /// refused up front with the reason; `TaskStop` ends it with the closing line.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn on_windows_a_tasks_output_and_redirect_target_stream_while_another_process_writes() {
        use crate::spawn::NoWindow as _;
        let r = WinRoot::new("engine");
        let roots = vec![r.root.clone()];
        let outside = r.base.join("outside.log");
        // `C:\Users\…\tasks\msys.log` as Git Bash spells it: `/c/Users/…/tasks/msys.log`.
        let native = r.tasks.join("msys.log").to_string_lossy().into_owned();
        let (drive, rest) = native.split_once(":\\").expect("a drive path");
        let msys = format!(
            "/{}/{}",
            drive.to_ascii_lowercase(),
            rest.replace('\\', "/")
        );
        let mut tails = TaskTails::new(roots, TaskSlots::new(4));
        let t0 = Instant::now();
        let started = tails.start(
            TaskSpec {
                agent_id: "a1".into(),
                task_id: "b1".into(),
                command: format!(
                    "npm run dev > dev.log 2>&1; echo x > \"{}\"; tail -f y >> {msys}",
                    outside.display()
                ),
                path: r.tasks.join("b1.output"),
                cwd: Some(r.tasks.clone()),
            },
            t0,
        );
        let texts = |lines: &[LineDraft]| lines.iter().map(|l| l.text.clone()).collect::<Vec<_>>();
        assert!(
            started[0].text.starts_with(STARTED_PREFIX),
            "{:?}",
            texts(&started)
        );
        assert!(
            started.iter().any(
                |l| l.level == LogLevel::Warn && l.text.contains("outside the IDE's temp root")
            ),
            "{:?}",
            texts(&started)
        );
        assert_eq!(
            tails.tailed_paths("b1"),
            vec![
                r.tasks.join("b1.output"),
                r.tasks.join("dev.log"),
                r.tasks.join("msys.log")
            ]
        );
        let script = "$o = [System.IO.File]::Open('b1.output', 'Append', 'Write', 'ReadWrite, Delete'); \
                      $d = [System.IO.File]::Open('dev.log', 'Append', 'Write', 'ReadWrite, Delete'); \
                      $m = [System.IO.File]::Open('msys.log', 'Append', 'Write', 'ReadWrite, Delete'); \
                      $wo = New-Object System.IO.StreamWriter($o); $wo.AutoFlush = $true; \
                      $wd = New-Object System.IO.StreamWriter($d); $wd.AutoFlush = $true; \
                      $wm = New-Object System.IO.StreamWriter($m); $wm.AutoFlush = $true; \
                      1..300 | ForEach-Object { $wo.WriteLine(\"out $_\"); $wd.WriteLine(\"ERROR dev $_\"); \
                      $wm.WriteLine(\"msys $_\"); Start-Sleep -Milliseconds 100 }";
        struct Kill(std::process::Child);
        impl Drop for Kill {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let _writer = Kill(
            std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .current_dir(&r.tasks)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .no_window()
                .spawn()
                .expect("powershell starts"),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut got: Vec<LineDraft> = Vec::new();
        let has = |got: &[LineDraft], prefix: &str| {
            got.iter()
                .any(|l| l.kind == LogKind::Task && l.text.starts_with(prefix))
        };
        while !(has(&got, "out 3") && has(&got, "ERROR dev 3") && has(&got, "msys 3")) {
            assert!(
                std::time::Instant::now() < deadline,
                "task lines: {:?}",
                texts(&got)
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            got.extend(tails.poll(Instant::now()));
        }
        let dev = got
            .iter()
            .find(|l| l.text.starts_with("ERROR dev"))
            .unwrap();
        assert_eq!(dev.level, LogLevel::Error);
        assert_eq!(dev.agent_id.as_deref(), Some("a1"));
        assert!(
            got.iter().all(|l| !l.text.contains('\r')),
            "CRLF lines lose their CR: {:?}",
            texts(&got)
        );
        let stopped = tails.stop("b1", Instant::now());
        let last = stopped.last().unwrap();
        assert_eq!(
            last.text,
            format!("{STOPPED_PREFIX}npm ({}) — stopped by the agent", "b1")
        );
        assert!(tails.task_ids().is_empty());
    }

    /// Real data (read-only): the `.output` files of the Claude sessions on this machine
    /// that the validator accepts under the real roots. Prints what it found; asserts only
    /// that every accepted path is a regular file under a canonical root, and that every
    /// session's task file is accepted (none of them is a link on Windows).
    #[cfg(windows)]
    #[test]
    fn on_windows_this_machines_task_files_pass_the_guard() {
        let roots = claude_temp_roots();
        let mut seen = 0;
        for root in &roots {
            let Ok(projects) = std::fs::read_dir(root) else {
                continue;
            };
            for tasks in projects
                .flatten()
                .flat_map(|p| std::fs::read_dir(p.path()).into_iter().flatten().flatten())
                .map(|s| s.path().join("tasks"))
            {
                let Ok(files) = std::fs::read_dir(&tasks) else {
                    continue;
                };
                for f in files.flatten() {
                    let path = f.path();
                    if path.extension().is_none_or(|e| e != "output") {
                        continue;
                    }
                    let got = validate_task_path(&path, &roots);
                    println!("{} -> {got:?}", path.display());
                    if got == Err(PathRefusal::Missing) {
                        continue; // deleted by its session between the listing and here
                    }
                    let canon = got.expect("a real task file is accepted");
                    assert!(open_checked(&canon).is_ok(), "{canon:?} opens");
                    seen += 1;
                }
            }
        }
        println!("{seen} task file(s) accepted under {roots:?}");
    }
}
