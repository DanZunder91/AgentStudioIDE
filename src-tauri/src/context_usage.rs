//! One agent session's `/context` breakdown for the Metrics "Context window" card (wire contract:
//! `src/features/context/contextTypes.ts`), asked of the CLI with `--resume`. Never touches
//! `~/.claude`; `--no-session-persistence` is load-bearing: it leaves the transcript untouched.

use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::spawn::NoWindow as _;
use regex::Regex;
use serde::Serialize;
use tokio::process::Command;

/// A resume loads the whole session before answering; long sessions take a few
/// seconds. Bounded so a wedged CLI can never pile up.
const CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// Keeps the read-only run from leaving a transcript behind (module doc). Named so
/// it cannot be dropped by an accidental edit to an argument list.
const NO_SESSION_PERSISTENCE: &str = "--no-session-persistence";

/// One row of the "Estimated usage by category" table — `ContextCategory` in TS.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCategory {
    pub key: String,
    pub label: String,
    pub tokens: u64,
    pub percent: f64,
}

/// A whole reading — `ContextUsage` in TS.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub model: String,
    pub used_tokens: u64,
    pub window_tokens: u64,
    pub used_percent: f64,
    pub categories: Vec<ContextCategory>,
    pub measured_at_ms: i64,
}

/// `invoke('context_usage', { agentId })`. Session id and cwd are looked up in-process so the
/// webview cannot supply them. `Err` is `"<code>"` or `"<code>: <detail>"` (`ContextErrorCode`).
#[tauri::command]
pub async fn context_usage(
    supervisor: tauri::State<'_, crate::supervisor::SupervisorHandle>,
    agent_id: String,
) -> Result<ContextUsage, String> {
    let info = supervisor
        .describe_pinnable(agent_id)
        .await?
        .ok_or_else(|| "bad-session: not a live root agent".to_string())?;
    read_context(info.session_id, info.cwd).await
}

/// Ask the CLI for `session_id`'s breakdown, run in `cwd`. Both inputs are validated
/// before anything is spawned: `session_id` must be a UUID (it becomes an argv
/// element — never let it start with `-`), `cwd` an existing directory.
pub async fn read_context(session_id: String, cwd: String) -> Result<ContextUsage, String> {
    if !is_uuid(&session_id) {
        return Err("bad-session: not a session id".to_string());
    }
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("bad-session: the agent's folder no longer exists".to_string());
    }
    let claude = crate::agent::claude::resolve_invocation()
        .map_err(|_| "cli-missing: the claude CLI could not be found".to_string())?;

    let mut cmd = Command::new(&claude.program);
    cmd.args(&claude.prefix)
        .arg("-p")
        .arg("--resume")
        .arg(&session_id)
        .arg(NO_SESSION_PERSISTENCE)
        .arg("/context")
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window();
    let child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "cli-missing: the claude CLI could not be run".to_string(),
        _ => "cli-failed: the claude CLI could not be started".to_string(),
    })?;
    let out = match tokio::time::timeout(CLI_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(_)) => return Err("cli-failed: the CLI could not be run".to_string()),
        Err(_) => return Err("timeout".to_string()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    interpret(out.status.success(), &stdout, &stderr, now_ms())
}

/// Turn one captured run into the result. Pure, so every branch is tested.
fn interpret(ok: bool, stdout: &str, stderr: &str, now_ms: i64) -> Result<ContextUsage, String> {
    let all = format!("{stdout}\n{stderr}");
    if all.contains("No conversation found") {
        return Err("no-session".to_string());
    }
    if let Some(mut usage) = parse_context_output(stdout) {
        usage.measured_at_ms = now_ms;
        return Ok(usage);
    }
    if !ok {
        return Err(format!("cli-failed: {}", first_line(&all)));
    }
    Err("parse".to_string())
}

/// The first non-empty line, truncated — never the whole output (it is a view of
/// someone's session, not error-message material).
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    line.chars().take(120).collect()
}

static MODEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*Model:\*\*\s*(\S+)").expect("valid regex"));
static TOKENS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\*\*Tokens:\*\*\s*([0-9.]+[kKmM]?)\s*/\s*([0-9.]+[kKmM]?)\s*\(([0-9.]+)%\)")
        .expect("valid regex")
});
static ROW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\|\s*([^|]+?)\s*\|\s*([0-9.]+[kKmM]?)\s*\|\s*([0-9.]+)%\s*\|\s*$")
        .expect("valid regex")
});

/// Parse the CLI's `/context` markdown. `None` unless the header AND at least one
/// category row were found — a half-understood answer is not a reading.
/// `measured_at_ms` is left 0 for the caller to stamp.
pub fn parse_context_output(text: &str) -> Option<ContextUsage> {
    let model = MODEL_RE.captures(text)?.get(1)?.as_str().to_string();
    let t = TOKENS_RE.captures(text)?;
    let used_tokens = parse_tokens(t.get(1)?.as_str())?;
    let window_tokens = parse_tokens(t.get(2)?.as_str())?;
    let used_percent: f64 = t.get(3)?.as_str().parse().ok()?;

    // Only the "Estimated usage by category" table: it ends at the next heading
    // (the Skills / MCP / Memory tables use other columns, but stop anyway).
    let section = text.split("### Estimated usage by category").nth(1)?;
    let section = section.split("\n### ").next().unwrap_or(section);
    let categories: Vec<ContextCategory> = section
        .lines()
        .filter_map(|line| {
            let c = ROW_RE.captures(line.trim())?;
            let label = c.get(1)?.as_str().trim().to_string();
            Some(ContextCategory {
                key: slug(&label),
                tokens: parse_tokens(c.get(2)?.as_str())?,
                percent: c.get(3)?.as_str().parse().ok()?,
                label,
            })
        })
        .collect();
    if categories.is_empty() {
        return None;
    }
    Some(ContextUsage {
        model,
        used_tokens,
        window_tokens,
        used_percent,
        categories,
        measured_at_ms: 0,
    })
}

/// "717" → 717, "2.3k" → 2300, "1m" → 1_000_000 (the CLI's compact form).
fn parse_tokens(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, mult) = match s.chars().last()? {
        'k' | 'K' => (&s[..s.len() - 1], 1_000.0),
        'm' | 'M' => (&s[..s.len() - 1], 1_000_000.0),
        _ => (s, 1.0),
    };
    let v: f64 = num.parse().ok()?;
    Some((v * mult).round() as u64)
}

/// "System tools (deferred)" → "system-tools-deferred".
fn slug(label: &str) -> String {
    let mut out = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// 8-4-4-4-12 hex — the shape `--session-id` mints.
fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sample in the shape `claude -p --resume <id> --no-session-persistence "/context"`
    /// prints (skills table trimmed).
    const SAMPLE: &str = "## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 21k / 1m (2%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.1k | 0.2% |\n| System tools | 6.1k | 0.6% |\n| System tools (deferred) | 13.1k | 1.3% |\n| Skills | 4.2k | 0.4% |\n| Messages | 8.6k | 0.9% |\n| Free space | 946k | 94.6% |\n| Autocompact buffer | 33k | 3.3% |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n| dataviz | Built-in | ~480 |\n";

    #[test]
    fn parses_a_sample_reading() {
        let u = parse_context_output(SAMPLE).unwrap();
        assert_eq!(u.model, "claude-opus-5-5");
        assert_eq!(u.used_tokens, 21_000);
        assert_eq!(u.window_tokens, 1_000_000);
        assert_eq!(u.used_percent, 2.0);
        let keys: Vec<&str> = u.categories.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "system-prompt",
                "system-tools",
                "system-tools-deferred",
                "skills",
                "messages",
                "free-space",
                "autocompact-buffer"
            ]
        );
        assert_eq!(u.categories[2].label, "System tools (deferred)");
        assert_eq!(u.categories[4].tokens, 8_600);
        assert_eq!(u.categories[5].percent, 94.6);
    }

    #[test]
    fn stops_at_the_next_table_and_reads_bare_numbers() {
        let text = SAMPLE.replace("| Messages | 8.6k | 0.9% |", "| Messages | 10 | 0.0% |");
        let u = parse_context_output(&text).unwrap();
        assert_eq!(u.categories[4].tokens, 10);
        assert!(u.categories.iter().all(|c| c.key != "dataviz"));
    }

    #[test]
    fn a_half_understood_answer_is_not_a_reading() {
        assert!(parse_context_output("hello").is_none());
        assert!(parse_context_output("**Model:** x\n").is_none());
        let no_rows = "**Model:** m\n**Tokens:** 1k / 1m (0%)\n### Estimated usage by category\n";
        assert!(parse_context_output(no_rows).is_none());
        let no_section = "**Model:** m\n**Tokens:** 1k / 1m (0%)\n| Messages | 1k | 0.1% |\n";
        assert!(parse_context_output(no_section).is_none());
    }

    #[test]
    fn token_forms() {
        assert_eq!(parse_tokens("717"), Some(717));
        assert_eq!(parse_tokens("2.3k"), Some(2_300));
        assert_eq!(parse_tokens("290.7K"), Some(290_700));
        assert_eq!(parse_tokens("1m"), Some(1_000_000));
        assert_eq!(parse_tokens("1.5M"), Some(1_500_000));
        assert_eq!(parse_tokens(""), None);
        assert_eq!(parse_tokens("k"), None);
        assert_eq!(parse_tokens("abc"), None);
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("MCP server instructions"), "mcp-server-instructions");
        assert_eq!(slug("System tools (deferred)"), "system-tools-deferred");
        assert_eq!(slug("  Free space "), "free-space");
    }

    #[test]
    fn session_ids_must_be_uuids() {
        assert!(is_uuid("0000cccc-0000-4000-8000-0000000000d4"));
        assert!(!is_uuid("--dangerously-skip-permissions"));
        assert!(!is_uuid("4cfa18c6-4dcf-4c09-86f1"));
        assert!(!is_uuid("4cfa18c6-4dcf-4c09-86f1-3fca8eb2d68z"));
    }

    #[test]
    fn interpret_maps_every_outcome() {
        let u = interpret(true, SAMPLE, "", 42).unwrap();
        assert_eq!(u.measured_at_ms, 42);
        assert_eq!(
            interpret(false, "", "No conversation found with session ID: x", 0),
            Err("no-session".to_string())
        );
        assert_eq!(
            interpret(false, "", "\n  boom happened\nmore", 0),
            Err("cli-failed: boom happened".to_string())
        );
        assert_eq!(
            interpret(true, "something else", "", 0),
            Err("parse".to_string())
        );
    }

    /// LOCAL INTEGRATION: `/context` on a real saved session leaves its transcript's size and mtime
    /// unchanged. Picks a transcript quiet for 10+ minutes and excludes this test's own session id,
    /// since a live or waiting session writes on its own.
    #[tokio::test]
    #[ignore = "needs a signed-in claude CLI and at least one saved session"]
    async fn live_context_reads_a_real_session_without_writing_it() {
        let home = crate::agent::claude::home_dir().expect("home");
        let projects = home.join(".claude/projects");
        let running_me = std::env::var("CLAUDE_CODE_SESSION_ID").ok();
        let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
        for dir in std::fs::read_dir(&projects)
            .expect("projects dir")
            .flatten()
        {
            for f in std::fs::read_dir(dir.path())
                .into_iter()
                .flatten()
                .flatten()
            {
                let p = f.path();
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if p.extension().is_some_and(|e| e == "jsonl") && is_uuid(stem) {
                    let m = f.metadata().and_then(|m| m.modified()).unwrap();
                    let quiet = m.elapsed().is_ok_and(|age| age.as_secs() >= 600);
                    let mine = running_me.as_deref() == Some(stem);
                    if quiet && !mine && newest.as_ref().is_none_or(|(t, _)| m > *t) {
                        newest = Some((m, p));
                    }
                }
            }
        }
        let (_, path) = newest.expect("at least one saved session quiet for 10+ minutes");
        let text = std::fs::read_to_string(&path).unwrap();
        let cwd = text
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .find_map(|v| v.get("cwd").and_then(|c| c.as_str()).map(String::from))
            .expect("a cwd in the transcript");
        let session = path.file_stem().unwrap().to_str().unwrap().to_string();
        let before = std::fs::metadata(&path).unwrap();

        let usage = read_context(session, cwd).await.expect("a reading");

        assert!(usage.window_tokens > 0 && !usage.categories.is_empty());
        assert!(usage.categories.iter().any(|c| c.key == "messages"));
        let after = std::fs::metadata(&path).unwrap();
        assert_eq!(before.len(), after.len(), "the transcript grew");
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    }

    #[tokio::test]
    async fn refuses_bad_input_before_spawning() {
        assert_eq!(
            read_context("-x".into(), "/".into()).await,
            Err("bad-session: not a session id".to_string())
        );
        assert_eq!(
            read_context(
                "0000cccc-0000-4000-8000-0000000000d4".into(),
                "/definitely/not/a/dir".into()
            )
            .await,
            Err("bad-session: the agent's folder no longer exists".to_string())
        );
    }
}
