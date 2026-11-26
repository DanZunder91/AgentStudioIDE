//! Open PRs for the current repo via `gh pr list --json` (never the GitHub API: `gh` owns the
//! credential, host and base repo). `gh` is found by absolute path via [`GhProber`] (GUI apps
//! have a minimal `PATH`); runs are classified by the pure [`interpret`] into [`ERROR_CODES`].

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::spawn::NoWindow as _;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Whole-call deadline — same reasoning as `usage.rs`: generous for a network
/// CLI, but self-clearing (a wedged `gh` can never pile up).
const GH_TIMEOUT: Duration = Duration::from_secs(15);

/// The `--json` field list — exactly the wire fields, so `gh` does the
/// projection server-side and the output is bounded.
const PR_LIST_FIELDS: &str = "number,title,author,url,headRefName,baseRefName,isDraft,updatedAt";

/// Cap on returned PRs; the rail shows a short list, not a database.
const PR_LIMIT: &str = "50";

/// The complete error vocabulary, mirrored by the frontend union.
pub const ERROR_CODES: [&str; 8] = [
    "gh-missing",
    "gh-not-signed-in",
    "no-remote",
    "gh-failed",
    "timeout",
    "parse",
    "out-of-scope",
    "unknown",
];

/// Lowercase substrings meaning "gh is not authenticated", consulted ONLY on a non-zero exit
/// (see [`interpret`]). gh's real signed-out message carries the first two.
const SIGNED_OUT_MARKERS: [&str; 3] = ["gh auth login", "authentication token", "not logged in"];

/// Lowercase substrings meaning "this directory has no usable GitHub remote"
/// (which includes not being a git repository at all — the UI treats both as the
/// same calm "nothing to list here" state).
const NO_REMOTE_MARKERS: [&str; 4] = [
    "no git remotes",
    "could not determine base repo",
    "not a git repository",
    "no default remote",
];

/// One open pull request, camelCase on the wire
/// (`headRef`, `baseRef`, `isDraft`, `updatedAt`).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// The author's login; `""` when GitHub reports no author (deleted account).
    pub author: String,
    pub url: String,
    pub head_ref: String,
    pub base_ref: String,
    pub is_draft: bool,
    /// ISO-8601 as `gh` prints it (e.g. `2026-08-21T03:07:24Z`) — the frontend
    /// formats it; we never re-encode a timestamp we did not mint.
    pub updated_at: String,
}

/// Open PRs of the repo at `root` (any allowed directory). `Err` is an [`ERROR_CODES`] entry,
/// optionally `": <detail>"` (first non-blank ANSI-stripped line, truncated).
#[tauri::command]
pub async fn gh_prs(app: tauri::AppHandle, root: String) -> Result<Vec<PullRequest>, String> {
    // Scope FIRST: both guard messages map to `out-of-scope`, so an
    // out-of-scope path reveals nothing about what it is.
    let real =
        crate::fs_tree::resolve_in_scope(Path::new(&root), &crate::fs_tree::allowed_roots(&app))
            .map_err(|msg| format!("out-of-scope: {msg}"))?;
    let program = resolve_gh_with(&SystemGhProber)?;
    let captured = run_gh(&program, &real).await?;
    interpret(&captured)
}

// ---------------------------------------------------------------------------
// Finding `gh`
// ---------------------------------------------------------------------------

/// The environment probe, abstracted so resolution is unit-testable with a stub.
pub trait GhProber: Send + Sync {
    /// Resolve `command` to an executable path, or `None`.
    fn which(&self, command: &str) -> Option<PathBuf>;
}

/// Resolve the `gh` binary with `prober`, or the coded `gh-missing` error.
pub fn resolve_gh_with<P: GhProber + ?Sized>(prober: &P) -> Result<PathBuf, String> {
    prober
        .which("gh")
        .ok_or_else(|| "gh-missing: the gh CLI could not be found".to_string())
}

/// The real prober: `$PATH` entries first (a user's own install wins), then the
/// known install dirs a GUI launch's thin `PATH` misses.
pub struct SystemGhProber;

impl GhProber for SystemGhProber {
    fn which(&self, command: &str) -> Option<PathBuf> {
        search_dirs(command, &candidate_dirs())
    }
}

/// Every directory the real prober searches, in order.
fn candidate_dirs() -> Vec<PathBuf> {
    candidate_dirs_from(
        std::env::var_os("PATH").as_deref(),
        crate::agent::claude::home_dir().as_deref(),
        cfg!(windows),
    )
}

/// [`candidate_dirs`] with inputs injected. Only absolute `PATH` entries, and Unix install dirs
/// only off Windows: there `/usr/local/bin` is a drive-relative folder any user could plant
/// a `gh.exe` in.
fn candidate_dirs_from(
    path: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    windows: bool,
) -> Vec<PathBuf> {
    let mut dirs = path
        .map(crate::agent::claude::absolute_path_dirs)
        .unwrap_or_default();
    if let Some(home) = home {
        dirs.push(home.join(".local/bin"));
    }
    if !windows {
        for abs in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            dirs.push(PathBuf::from(abs));
        }
    }
    dirs
}

/// `which(1)` over an **injected** dir list, spawning nothing — the injection is
/// what lets the found / not-found / non-executable cases be tested hermetically
/// against a temp dir instead of the live machine.
fn search_dirs(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(file_name(command)))
        .find(|candidate| is_executable(candidate))
}

/// Windows needs the `.exe` extension; unix uses the bare name.
fn file_name(command: &str) -> String {
    #[cfg(windows)]
    {
        format!("{command}.exe")
    }
    #[cfg(not(windows))]
    {
        command.to_string()
    }
}

/// Is `path` an existing, executable regular file?
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/// What one `gh pr list` run produced.
#[derive(Debug, Clone)]
pub struct Captured {
    /// The process exit code — `None` when it was killed by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Spawn `gh`, wait (bounded), capture both streams — `usage.rs`'s discipline:
/// null stdin (a CLI pausing for input must time out, not hang forever), piped
/// streams, `kill_on_drop` so an elapsed timeout SIGKILLs and reaps the child.
async fn run_gh(program: &Path, root: &Path) -> Result<Captured, String> {
    let mut cmd = Command::new(program);
    cmd.arg("pr")
        .arg("list")
        .arg("--json")
        .arg(PR_LIST_FIELDS)
        .arg("--limit")
        .arg(PR_LIMIT)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window();

    let child = cmd.spawn().map_err(|e| spawn_error(e.kind()))?;
    match tokio::time::timeout(GH_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => Ok(Captured {
            code: out.status.code(),
            // Lossy on purpose: one stray byte must not fail a good listing.
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Ok(Err(_)) => Err("unknown: the gh CLI could not be run".to_string()),
        Err(_elapsed) => Err("timeout".to_string()),
    }
}

/// Coded error for a failed spawn. `NotFound` = the resolved path has since gone
/// (an uninstall mid-flight) — same user-visible problem as never finding it.
fn spawn_error(kind: std::io::ErrorKind) -> String {
    match kind {
        std::io::ErrorKind::NotFound => "gh-missing: the gh CLI could not be run".to_string(),
        _ => "unknown: the gh CLI could not be started".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Interpreting a finished run (pure)
// ---------------------------------------------------------------------------

/// Classify a finished run. Markers are consulted only on a non-zero exit: exit-0 JSON is never
/// second-guessed (a PR titled "run gh auth login" isn't sign-out); exit-0 garbage is `parse`.
pub fn interpret(captured: &Captured) -> Result<Vec<PullRequest>, String> {
    match captured.code {
        Some(0) => parse_pr_list(&captured.stdout),
        Some(code) => Err(classify_failure(captured, code)),
        // No exit code = killed by a signal. Our own timeout returns `timeout`
        // before this can happen, so something else killed it.
        None => Err("unknown: the gh CLI ended without an exit code".to_string()),
    }
}

/// A non-zero exit → the most specific code its output supports.
/// Signed-out first (the more actionable state), then no-remote, then a generic
/// `gh-failed` carrying the first output line.
fn classify_failure(captured: &Captured, code: i32) -> String {
    let haystack = format!("{}\n{}", captured.stdout, captured.stderr).to_lowercase();
    if SIGNED_OUT_MARKERS.iter().any(|m| haystack.contains(m)) {
        return "gh-not-signed-in".to_string();
    }
    if NO_REMOTE_MARKERS.iter().any(|m| haystack.contains(m)) {
        return "no-remote".to_string();
    }
    match first_line(&captured.stderr).or_else(|| first_line(&captured.stdout)) {
        Some(detail) => format!("gh-failed: exit {code} ({detail})"),
        None => format!("gh-failed: exit {code}"),
    }
}

/// One PR as `gh --json` prints it (gh 2.87.3; `author` is an object). All fields but `number`
/// are defaulted so one odd PR degrades to empty fields instead of failing the listing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: Option<RawAuthor>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    updated_at: String,
}

#[derive(Deserialize)]
struct RawAuthor {
    #[serde(default)]
    login: Option<String>,
}

/// Exit-0 stdout → the wire list. Anything unparseable is `parse` with the
/// serde error's first line as detail — never the captured output itself.
fn parse_pr_list(stdout: &str) -> Result<Vec<PullRequest>, String> {
    let raw: Vec<RawPr> = serde_json::from_str(stdout.trim()).map_err(|e| {
        let msg = e.to_string();
        format!("parse: {}", first_line(&msg).unwrap_or_default())
    })?;
    Ok(raw
        .into_iter()
        .map(|pr| PullRequest {
            number: pr.number,
            title: pr.title,
            author: pr.author.and_then(|a| a.login).unwrap_or_default(),
            url: pr.url,
            head_ref: pr.head_ref_name,
            base_ref: pr.base_ref_name,
            is_draft: pr.is_draft,
            updated_at: pr.updated_at,
        })
        .collect())
}

/// Cap on an error detail — long enough to be useful, never a transcript.
const DETAIL_MAX_CHARS: usize = 80;

/// The first non-blank line, ANSI-stripped and truncated. (`usage.rs` has a
/// private twin; its helpers are not exported and this module may not edit it.)
fn first_line(text: &str) -> Option<String> {
    let line = strip_ansi(text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .to_string();
    let mut short: String = line.chars().take(DETAIL_MAX_CHARS).collect();
    if short.chars().count() < line.chars().count() {
        short.push('…');
    }
    Some(short)
}

/// Strip ANSI CSI/OSC escapes. `gh` disables color on a pipe, but a future
/// release colouring a hint must not corrupt an error detail.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            // CSI … final byte in @–~
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC … BEL or ESC \
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On Windows the Unix install dirs are
    /// `<current drive>:\usr\…`, creatable by any standard user. Searched only off Windows, after
    /// `PATH`'s absolute entries and `~/.local/bin`.
    #[test]
    fn gh_is_looked_for_in_absolute_dirs_and_unix_dirs_only_off_windows() {
        let abs = std::env::temp_dir();
        let path = std::env::join_paths([abs.as_os_str(), std::ffi::OsStr::new("rel")]).unwrap();
        let home = abs.join("home");
        let unix_dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from);

        let off_windows = candidate_dirs_from(Some(&path), Some(&home), false);
        let mut expected = vec![abs.clone(), home.join(".local/bin")];
        expected.extend(unix_dirs.clone());
        assert_eq!(off_windows, expected);

        let on_windows = candidate_dirs_from(Some(&path), Some(&home), true);
        assert_eq!(on_windows, vec![abs, home.join(".local/bin")]);
        assert!(!on_windows.iter().any(|d| unix_dirs.contains(d)));
    }

    /// A hand-written fixture in exactly the shape `gh` 2.87.3 prints (verified
    /// read-only against a public repo, then rewritten with fake data — no real
    /// logins, ids or repos are committed).
    const TWO_PRS: &str = r#"[
      {"author":{"id":"U_fake001","is_bot":false,"login":"octo-dev","name":"Octo Developer"},
       "baseRefName":"main","headRefName":"feat/tree-colors","isDraft":false,"number":41,
       "title":"Color the file tree by git status","updatedAt":"2026-08-20T10:00:00Z",
       "url":"https://example.invalid/acme/widgets/pull/41"},
      {"author":{"id":"U_fake002","is_bot":true,"login":"release-bot","name":"Release Bot"},
       "baseRefName":"develop","headRefName":"bot/bump-deps","isDraft":true,"number":40,
       "title":"Bump dependencies","updatedAt":"2026-08-19T09:30:00Z",
       "url":"https://example.invalid/acme/widgets/pull/40"}
    ]"#;

    fn ok(stdout: &str) -> Captured {
        Captured {
            code: Some(0),
            stdout: stdout.to_string(),
            stderr: String::new(),
        }
    }

    fn failed(code: i32, stderr: &str) -> Captured {
        Captured {
            code: Some(code),
            stdout: String::new(),
            stderr: stderr.to_string(),
        }
    }

    // ── the happy path ────────────────────────────────────────────────────

    #[test]
    fn a_real_shaped_listing_parses_with_exact_field_mapping() {
        let prs = interpret(&ok(TWO_PRS)).expect("fixture must parse");
        assert_eq!(prs.len(), 2);
        let first = &prs[0];
        assert_eq!(first.number, 41);
        assert_eq!(first.title, "Color the file tree by git status");
        assert_eq!(first.author, "octo-dev", "author = the object's login");
        assert_eq!(first.url, "https://example.invalid/acme/widgets/pull/41");
        assert_eq!(first.head_ref, "feat/tree-colors");
        assert_eq!(first.base_ref, "main");
        assert!(!first.is_draft);
        assert_eq!(first.updated_at, "2026-08-20T10:00:00Z");
        assert!(prs[1].is_draft, "draft flag survives");
        assert_eq!(prs[1].author, "release-bot");
    }

    #[test]
    fn an_empty_repo_lists_zero_prs() {
        assert_eq!(interpret(&ok("[]")), Ok(vec![]));
        assert_eq!(interpret(&ok("  []\n")), Ok(vec![]), "whitespace tolerated");
    }

    #[test]
    fn a_missing_or_null_author_becomes_an_empty_login() {
        // GitHub reports no author for deleted accounts; `gh` prints null.
        let prs = interpret(&ok(r#"[{"number":7,"title":"t","author":null,"url":"u",
                "headRefName":"h","baseRefName":"b","isDraft":false,
                "updatedAt":"2026-01-01T00:00:00Z"}]"#))
        .unwrap();
        assert_eq!(prs[0].author, "");
        let prs = interpret(&ok(r#"[{"number":8}]"#)).unwrap();
        assert_eq!(prs[0].author, "", "absent author field");
        assert_eq!(prs[0].title, "", "other absent fields default calmly");
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let prs = interpret(&ok(TWO_PRS)).unwrap();
        let wire = serde_json::to_value(&prs[1]).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "number": 40,
                "title": "Bump dependencies",
                "author": "release-bot",
                "url": "https://example.invalid/acme/widgets/pull/40",
                "headRef": "bot/bump-deps",
                "baseRef": "develop",
                "isDraft": true,
                "updatedAt": "2026-08-19T09:30:00Z"
            })
        );
    }

    // ── classification of failures ────────────────────────────────────────

    #[test]
    fn the_signed_out_message_is_gh_not_signed_in() {
        // gh's real wording, paraphrased — both markers present.
        let c = failed(
            4,
            "To get started with GitHub CLI, please run:  gh auth login\n\
             Alternatively, populate the GH_TOKEN environment variable with a \
             GitHub API authentication token.\n",
        );
        assert_eq!(interpret(&c), Err("gh-not-signed-in".to_string()));
    }

    #[test]
    fn remoteless_and_non_repo_directories_are_no_remote() {
        for stderr in [
            "no git remotes found",
            "could not determine base repo: no git remotes",
            "failed to run git: fatal: not a git repository (or any of the parent directories): .git",
            "no default remote repository has been set",
        ] {
            assert_eq!(
                interpret(&failed(1, stderr)),
                Err("no-remote".to_string()),
                "for stderr {stderr:?}"
            );
        }
    }

    #[test]
    fn an_unrecognised_failure_is_gh_failed_with_the_first_line() {
        let c = failed(
            1,
            "GraphQL: Something went wrong (repository.pullRequests)\nsecond line",
        );
        assert_eq!(
            interpret(&c),
            Err(
                "gh-failed: exit 1 (GraphQL: Something went wrong (repository.pullRequests))"
                    .to_string()
            )
        );
        assert_eq!(
            interpret(&failed(1, "")),
            Err("gh-failed: exit 1".to_string()),
            "no output at all still yields the code"
        );
    }

    #[test]
    fn a_signal_death_is_unknown() {
        let c = Captured {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(
            interpret(&c),
            Err("unknown: the gh CLI ended without an exit code".to_string())
        );
    }

    // ── the fence ─────────────────────────────────────────────────────────

    #[test]
    fn exit_zero_garbage_is_parse_never_a_marker_guess() {
        // Garbage stdout on success is a parse error — markers are not consulted
        // on exit 0, so even garbage CONTAINING a marker stays `parse`.
        let err = interpret(&ok("not json at all")).unwrap_err();
        assert!(err.starts_with("parse"), "got {err:?}");
        let err = interpret(&ok("please run gh auth login")).unwrap_err();
        assert!(
            err.starts_with("parse"),
            "markers must not fire on exit 0 — got {err:?}"
        );
    }

    #[test]
    fn a_successful_parse_is_never_second_guessed_by_markers() {
        // A PR titled with the signed-out wording must stay an ordinary PR.
        let listing = r#"[{"number":9,
            "title":"Docs: tell users to run gh auth login and mention the authentication token",
            "author":{"login":"octo-dev"},"url":"https://example.invalid/acme/widgets/pull/9",
            "headRefName":"docs","baseRefName":"main","isDraft":false,
            "updatedAt":"2026-08-01T00:00:00Z"}]"#;
        let prs = interpret(&ok(listing)).expect("must parse, not be re-classified");
        assert_eq!(prs[0].number, 9);
    }

    #[test]
    fn markers_in_stdout_of_a_failed_run_are_still_consulted() {
        // The haystack is stdout+stderr — gh sometimes hints on stdout.
        let c = Captured {
            code: Some(1),
            stdout: "please run gh auth login".to_string(),
            stderr: String::new(),
        };
        assert_eq!(interpret(&c), Err("gh-not-signed-in".to_string()));
    }

    // ── resolving the binary ──────────────────────────────────────────────

    /// A stub prober answering from a fixed table.
    struct Stub(Option<PathBuf>);
    impl GhProber for Stub {
        fn which(&self, command: &str) -> Option<PathBuf> {
            assert_eq!(command, "gh", "only gh is ever resolved here");
            self.0.clone()
        }
    }

    #[test]
    fn resolution_returns_the_probers_path_or_gh_missing() {
        assert_eq!(
            resolve_gh_with(&Stub(Some(PathBuf::from("/opt/homebrew/bin/gh")))),
            Ok(PathBuf::from("/opt/homebrew/bin/gh"))
        );
        assert_eq!(
            resolve_gh_with(&Stub(None)),
            Err("gh-missing: the gh CLI could not be found".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn search_dirs_finds_executables_and_skips_non_executable_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("agentstudio-gh-probe-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("gh");

        // Nothing there yet → not found.
        assert_eq!(search_dirs("gh", std::slice::from_ref(&dir)), None);

        // A NON-executable file named gh → still not found (mode 0644).
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            search_dirs("gh", std::slice::from_ref(&dir)),
            None,
            "a plain file must not resolve"
        );

        // Executable → found, at the exact path.
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            search_dirs("gh", std::slice::from_ref(&dir)),
            Some(bin.clone())
        );

        // A directory named gh must never resolve.
        let dir2 =
            std::env::temp_dir().join(format!("agentstudio-gh-probe2-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir2.join("gh")).unwrap();
        assert_eq!(search_dirs("gh", std::slice::from_ref(&dir2)), None);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    // ── details ───────────────────────────────────────────────────────────

    #[test]
    fn details_are_first_line_ansi_stripped_and_truncated() {
        assert_eq!(first_line("\x1b[31mboom\x1b[0m\nmore"), Some("boom".into()));
        assert_eq!(first_line("\n\n  hint  \n"), Some("hint".into()));
        assert_eq!(first_line("   \n"), None);
        let long = "y".repeat(200);
        let d = first_line(&long).unwrap();
        assert_eq!(d.chars().count(), 81, "80 chars + ellipsis");
    }

    // ── live smoke: the ONE test that talks to a real gh ──────────────────
    // `#[ignore]`d so `cargo test` stays hermetic; external and non-blocking in verify.
    // Run: `--ignored --exact gh_prs::tests::live_smoke_lists_prs_via_gh`.
    #[test]
    #[ignore = "spawns the real `gh` CLI against this repo — run with --ignored"]
    fn live_smoke_lists_prs_via_gh() {
        let program = resolve_gh_with(&SystemGhProber)
            .expect("gh not found — install the GitHub CLI to run this smoke");
        // This repo's root: the crate lives in <root>/src-tauri.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .to_path_buf();

        let outcome = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(async {
                let captured = run_gh(&program, &root).await?;
                interpret(&captured)
            });

        match outcome {
            Ok(prs) => {
                // A parsed list (possibly empty). Spot-check invariants only —
                // this repo's PR count is not a fixture.
                for pr in &prs {
                    assert!(pr.number > 0, "PR numbers are 1-based");
                    assert!(
                        pr.url.starts_with("https://"),
                        "gh URLs are https ({})",
                        pr.url
                    );
                }
            }
            // The calm typed states a healthy machine may legitimately be in.
            Err(code) if code == "gh-not-signed-in" || code == "no-remote" => {}
            Err(other) => {
                panic!("live gh run must parse or fail with a calm typed code, got: {other}")
            }
        }
    }
}
