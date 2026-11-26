//! Background sub-agents: their launch ack ("Async agent launched …") returns at once and must
//! not mark them `Done`. Sessions are SYNTHESIZED in temp dirs in a real run's shape (CLI
//! 2.1.309), with none of its content; the live test points `HOME` at a temp dir.

mod common;

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use agent_studio_scaffold_lib::agent::claude::{parse_fanout, parse_fanout_at, SUBAGENT_STALE_MS};
use agent_studio_scaffold_lib::agent::fanout::{
    diff_fanout, FanoutAgent, FanoutDelta, FanoutStatus,
};
use serde_json::{json, Value};

/// 2026-10-23T06:39:36.022Z — the first launch's timestamp.
const T0: i64 = 1_792_737_576_022;
const ROOT: &str = "root-agent";
const SID: &str = "11111111-2222-4333-8444-555555555555";

/// Epoch ms → the CLI's ISO form. Written from Hinnant's `civil_from_days`, the
/// INVERSE of the parser's `days_from_civil`, so the two cannot share a bug.
fn iso(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1_000 % 60,
        rem % 1_000
    )
}

#[test]
fn the_test_clock_writes_the_clis_iso_form() {
    // Anchors computed independently (Python `datetime`).
    assert_eq!(iso(T0), "2026-10-23T06:39:36.022Z");
    assert_eq!(iso(1_792_737_661_892), "2026-10-23T06:41:01.892Z");
    assert_eq!(iso(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
}

/// A synthesized session on disk: the root transcript and its `subagents/` dir.
struct Session {
    dir: PathBuf,
    root: PathBuf,
    subs: PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

fn agent_id(i: usize) -> String {
    format!("a{i:016x}") // the CLI's shape: `a` + 16 hex digits
}

fn tool_use_id(i: usize) -> String {
    format!("toolu_bg{i:02}")
}

fn append(path: &Path, lines: &[Value]) {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open transcript");
    for l in lines {
        writeln!(f, "{l}").expect("append");
    }
}

impl Session {
    /// `n` background launches by the root at `t0`: one `Agent` tool_use per line,
    /// each answered at once by the async-launch ack, and each sub-agent mid-task —
    /// its prompt, then a `Bash` call still running.
    fn background(n: usize, t0: i64) -> Self {
        Self::with_shape(n, t0, Some("background"))
    }

    fn with_shape(n: usize, t0: i64, shape: Option<&str>) -> Self {
        let dir = std::env::temp_dir().join(format!("agentstudio-fanout-bg-{}", ulid::Ulid::new()));
        let subs = dir.join("subagents");
        std::fs::create_dir_all(&subs).expect("mkdir");
        let s = Session {
            root: dir.join("session.jsonl"),
            dir,
            subs,
        };
        append(
            &s.root,
            &[
                json!({"type":"user","timestamp":iso(t0 - 5_000),"sessionId":SID,
                "cwd":"/work/gazelle","gitBranch":"trunk",
                "message":{"role":"user","content":"synthetic: launch the background agents"}}),
            ],
        );
        for i in 0..n {
            append(
                &s.root,
                &[
                    json!({"type":"assistant","timestamp":iso(t0 + i as i64),"sessionId":SID,
                    "message":{"role":"assistant","stop_reason":"tool_use","content":[
                        {"type":"tool_use","id":tool_use_id(i),"name":"Agent","input":{
                            "description":format!("synthetic agent {i}"),
                            "subagent_type":"general-purpose","prompt":"synthetic"}}]}}),
                ],
            );
        }
        for i in 0..n {
            append(
                &s.root,
                &[
                    json!({"type":"user","timestamp":iso(t0 + 50 + i as i64),"sessionId":SID,
                    "message":{"role":"user","content":[{"type":"tool_result",
                        "tool_use_id":tool_use_id(i),"content":[{"type":"text","text":
                        format!("Async agent launched successfully.\nagentId: {} (internal ID)\nThe agent is working in the background.", agent_id(i))}]}]},
                    "toolUseResult":{"isAsync":true,"status":"async_launched","agentId":agent_id(i)}}),
                ],
            );
            s.write_meta(i, shape, false);
            append(
                &s.transcript(i),
                &[
                    json!({"type":"user","isSidechain":true,"agentId":agent_id(i),
                        "timestamp":iso(t0 + 100),"cwd":"/work/gazelle","gitBranch":"trunk",
                        "message":{"role":"user","content":format!("synthetic task {i}")}}),
                    json!({"type":"assistant","isSidechain":true,"agentId":agent_id(i),
                        "timestamp":iso(t0 + 2_000),"message":{"role":"assistant",
                        "stop_reason":"tool_use","content":[{"type":"tool_use",
                        "id":format!("toolu_sleep{i}"),"name":"Bash","input":{"command":"sleep 60"}}]}}),
                ],
            );
        }
        s
    }

    fn transcript(&self, i: usize) -> PathBuf {
        self.subs.join(format!("agent-{}.jsonl", agent_id(i)))
    }

    /// The sidecar, the way the CLI writes it — and rewrites it, whole, when the run
    /// finishes (`finished: true`) or is resumed (without it).
    fn write_meta(&self, i: usize, shape: Option<&str>, finished: bool) {
        let mut meta = json!({"agentType":"general-purpose","launchedWithDefaults":true,
            "description":format!("synthetic agent {i}"),"toolUseId":tool_use_id(i),
            "spawnDepth":1,"requestNonInteractive":true});
        if let Some(shape) = shape {
            meta["requestShape"] = json!(shape);
        }
        if finished {
            meta["finished"] = json!(true);
        }
        std::fs::write(
            self.subs.join(format!("agent-{}.meta.json", agent_id(i))),
            meta.to_string(),
        )
        .expect("write meta");
    }

    /// Agent `i` stopped with `status` at `at`: its last line, then every copy of the parent's
    /// notification the CLI writes (enqueue, attachment, delivery, remove, unstamped snapshot);
    /// `run` keeps two stops of one agent distinct, as `<usage>` does.
    fn stop(&self, i: usize, status: &str, at: i64, run: u32) {
        append(
            &self.transcript(i),
            &[
                json!({"type":"user","isSidechain":true,"agentId":agent_id(i),
                "timestamp":iso(at - 12),"message":{"role":"user","content":[
                    {"type":"tool_result","tool_use_id":format!("toolu_sleep{i}"),"content":"ok"}]}}),
            ],
        );
        self.notify_parent(&self.root, i, status, at, run);
    }

    /// Only the parent's half of [`Session::stop`], into `transcript`.
    fn notify_parent(&self, transcript: &Path, i: usize, status: &str, at: i64, run: u32) {
        let block = format!(
            "<task-notification>\n<task-id>{}</task-id>\n<tool-use-id>{}</tool-use-id>\n\
             <status>{status}</status>\n<summary>synthetic</summary>\n\
             <usage><subagent_tokens>{run}</subagent_tokens></usage>\n</task-notification>",
            agent_id(i),
            tool_use_id(i)
        );
        append(
            transcript,
            &[
                json!({"type":"queue-operation","operation":"enqueue","timestamp":iso(at),
                    "sessionId":SID,"content":block}),
                json!({"type":"attachment","timestamp":iso(at),"attachment":{
                    "type":"queued_command","prompt":block,"commandMode":"task-notification"}}),
                json!({"type":"user","timestamp":iso(at + 9_000),"message":{"role":"user","content":block},
                    "origin":{"kind":"task-notification"}}),
                json!({"type":"queue-operation","operation":"remove","timestamp":iso(at + 9_500),
                    "sessionId":SID,"content":block}),
                json!({"type":"api-request-blob","message":{"role":"system","content":[
                    {"type":"text","text":block}]}}),
            ],
        );
    }

    /// Agent `i` was resumed at `at` (a `SendMessage` lands as a new user turn).
    /// The CLI then sends a request, and logs it as an `api-request-blob` — a record
    /// with NO timestamp, so the newest stamp is not simply the last line's.
    fn resume(&self, i: usize, at: i64) {
        self.write_meta(i, Some("background"), false);
        append(
            &self.transcript(i),
            &[
                json!({"type":"user","isSidechain":true,"agentId":agent_id(i),
                "timestamp":iso(at),"message":{"role":"user","content":"synthetic follow-up"}}),
                json!({"type":"api-request-blob","message":{"role":"user","content":[
                    {"type":"text","text":"synthetic follow-up"}]}}),
            ],
        );
    }

    fn parse_at(&self, now: i64) -> Vec<FanoutAgent> {
        parse_fanout_at(&self.root, &self.subs, ROOT, now).agents
    }
}

fn statuses(agents: &[FanoutAgent]) -> HashMap<String, FanoutStatus> {
    agents
        .iter()
        .map(|a| (a.agent_id.clone(), a.status))
        .collect()
}

fn count(agents: &[FanoutAgent], status: FanoutStatus) -> usize {
    agents.iter().filter(|a| a.status == status).count()
}

/// **The headline case.** Twenty background launches, every one already answered by
/// its launch ack, every sub-agent mid-`sleep`: twenty working agents under the root.
#[test]
fn twenty_background_launches_are_twenty_running_agents() {
    let s = Session::background(20, T0);
    let agents = s.parse_at(T0 + 30_000);
    assert_eq!(agents.len(), 20);
    assert_eq!(count(&agents, FanoutStatus::Running), 20, "{agents:#?}");
    assert!(agents
        .iter()
        .all(|a| a.parent_id == ROOT && a.spawn_depth == Some(1)));

    // Two-sided: the same session read as FOREGROUND launches — the
    // shape the fan-out assumed before — is twenty `Done`. The acks are there, and
    // only `requestShape` decides that they are not ends.
    let fg = Session::with_shape(20, T0, Some("foreground"));
    assert_eq!(count(&fg.parse_at(T0 + 30_000), FanoutStatus::Done), 20);
    // A sidecar from a CLI that predates `requestShape` keeps the foreground rule.
    let old = Session::with_shape(1, T0, None);
    assert_eq!(old.parse_at(T0 + 30_000)[0].status, FanoutStatus::Done);
}

/// …through the entry point the adapter calls, on the real clock.
#[test]
fn on_the_real_clock_fresh_background_agents_are_running() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let s = Session::background(20, now - 10_000);
    let agents = parse_fanout(&s.root, &s.subs, ROOT).agents;
    assert_eq!(count(&agents, FanoutStatus::Running), 20, "{agents:#?}");
}

/// **20 Running until EACH ends.** One end at a time, by every signal the CLI writes,
/// re-parsed after each step the way the tailer polls: exactly that agent changes,
/// everyone else keeps working.
#[test]
fn each_background_agent_runs_until_its_own_end() {
    let s = Session::background(20, T0);
    let now = T0 + 60_000;
    let mut known: HashMap<String, FanoutStatus> = HashMap::new();
    let first = s.parse_at(now);
    for d in diff_fanout(&known, &first) {
        assert!(
            matches!(&d, FanoutDelta::Spawned(a) if a.status == FanoutStatus::Running),
            "every agent is born working: {d:?}"
        );
    }
    known = statuses(&first);

    for i in 0..20 {
        let at = T0 + 10_000 + i as i64 * 1_000;
        let want = match i % 4 {
            0 => {
                s.stop(i, "completed", at, 1);
                FanoutStatus::Done
            }
            1 => {
                s.stop(i, "failed", at, 1);
                FanoutStatus::Error
            }
            2 => {
                s.stop(i, "killed", at, 1);
                FanoutStatus::Done
            }
            _ => {
                // The CLI's own flag, with no notification yet in the parent.
                s.write_meta(i, Some("background"), true);
                FanoutStatus::Done
            }
        };
        let now_agents = s.parse_at(now);
        assert_eq!(
            diff_fanout(&known, &now_agents),
            vec![FanoutDelta::StatusChanged {
                agent_id: agent_id(i),
                status: want
            }],
            "step {i}: only agent {i} ends"
        );
        assert_eq!(count(&now_agents, FanoutStatus::Running), 19 - i);
        known = statuses(&now_agents);
    }
}

/// The resume starts 8 ms after the stop, BEFORE the notification's delivery and `remove`
/// copies, so reading the latest copy instead of the earliest would call it finished.
#[test]
fn a_resumed_background_agent_works_again_until_it_stops_again() {
    let s = Session::background(2, T0);
    let stop1 = T0 + 20_000;
    s.stop(0, "completed", stop1, 1);
    s.write_meta(0, Some("background"), true);
    assert_eq!(s.parse_at(stop1 + 1)[0].status, FanoutStatus::Done);

    s.resume(0, stop1 + 8);
    let agents = s.parse_at(stop1 + 5_000);
    assert_eq!(agents[0].status, FanoutStatus::Running, "resumed");
    assert_eq!(agents[1].status, FanoutStatus::Running, "untouched");

    let stop2 = stop1 + 30_000;
    s.stop(0, "completed", stop2, 2);
    assert_eq!(
        s.parse_at(stop2 + 1)[0].status,
        FanoutStatus::Done,
        "stopped again"
    );

    // Killed after a resume: the CLI writes no `finished`, the kill notification ends it.
    s.resume(0, stop2 + 1_000);
    assert_eq!(s.parse_at(stop2 + 2_000)[0].status, FanoutStatus::Running);
    s.stop(0, "killed", stop2 + 3_000, 3);
    assert_eq!(s.parse_at(stop2 + 4_000)[0].status, FanoutStatus::Done);
}

/// With no end marker at all (a parent killed mid-run notifies nobody), a background
/// agent stops counting after [`SUBAGENT_STALE_MS`] of silence in its own transcript.
#[test]
fn a_silent_background_agent_is_done_after_the_stale_window() {
    let s = Session::background(1, T0);
    let last = T0 + 2_000; // its `Bash` call
    let stale = SUBAGENT_STALE_MS as i64;
    assert_eq!(
        s.parse_at(last + stale - 1)[0].status,
        FanoutStatus::Running
    );
    assert_eq!(s.parse_at(last + stale)[0].status, FanoutStatus::Done);
    // A line after the silence makes it working again.
    s.resume(0, last + stale + 10);
    assert_eq!(
        s.parse_at(last + stale + 20)[0].status,
        FanoutStatus::Running
    );

    // A sidecar whose transcript is not written yet has not started being silent.
    let bare = Session::background(1, T0);
    std::fs::remove_file(bare.transcript(0)).unwrap();
    assert_eq!(
        bare.parse_at(T0 + 100 * stale)[0].status,
        FanoutStatus::Running
    );
}

/// A background agent's background child: the child's end lands in its PARENT's
/// transcript (the depth-1 sidecar), not the root's — and ends only the child.
#[test]
fn a_nested_background_child_ends_from_its_parents_transcript() {
    let s = Session::background(2, T0);
    // Agent 1 becomes agent 0's child.
    let mut meta: Value = serde_json::from_str(
        &std::fs::read_to_string(s.subs.join(format!("agent-{}.meta.json", agent_id(1)))).unwrap(),
    )
    .unwrap();
    meta["parentAgentId"] = json!(agent_id(0));
    meta["spawnDepth"] = json!(2);
    std::fs::write(
        s.subs.join(format!("agent-{}.meta.json", agent_id(1))),
        meta.to_string(),
    )
    .unwrap();
    assert_eq!(count(&s.parse_at(T0 + 30_000), FanoutStatus::Running), 2);

    s.notify_parent(&s.transcript(0), 1, "completed", T0 + 20_000, 1);
    let by = statuses(&s.parse_at(T0 + 30_000));
    assert_eq!(by[&agent_id(1)], FanoutStatus::Done, "the child ended");
    assert_eq!(
        by[&agent_id(0)],
        FanoutStatus::Running,
        "its parent did not"
    );
}

// ── Through the real supervisor ─────────────────────────────────────────────

/// The seam: real `ClaudeAdapter`, tailer and supervisor over a fake `claude` writing the
/// real shape; the snapshot shows twenty working sub-agents, then exactly one done.
#[cfg(unix)]
#[tokio::test]
async fn the_supervisor_shows_twenty_working_background_agents() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use agent_studio_scaffold_lib::agent::claude::{ClaudeAdapter, CLAUDE_BIN_ENV};
    use agent_studio_scaffold_lib::model::{AgentEvent, AgentStatus};
    use agent_studio_scaffold_lib::supervisor::{spawn_supervisor, AgentSpawnSpec};
    use common::{ChannelSink, RecordingSink};

    let home =
        std::env::temp_dir().join(format!("agentstudio-fanout-bg-home-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&home).unwrap();
    // Before anything can resolve `~`: this test must never see the real `~/.claude`.
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("AGENTSTUDIO_FANOUT_POLL_MS", "50");

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let fixture = Session::background(20, now - 5_000);
    let bin = home.join("fake-claude");
    std::fs::write(
        &bin,
        format!(
            r#"#!/bin/sh
sid=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
proj="$HOME/.claude/projects/-work-gazelle"
mkdir -p "$proj/$sid/subagents"
cp "{root}" "$proj/$sid.jsonl"
cp "{subs}/"* "$proj/$sid/subagents/"
while true; do sleep 1; done
"#,
            root = fixture.root.display(),
            subs = fixture.subs.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var(CLAUDE_BIN_ENV, &bin);

    let sink = RecordingSink::new();
    let sup = spawn_supervisor(
        Arc::new(sink.clone()),
        vec![Arc::new(ClaudeAdapter::new())],
        None,
    );
    let root_id = format!("root-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: root_id.clone(),
            runtime: "claude-code".into(),
            cwd: home.to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
            prompt: None,
            resume_session_id: None,
        },
        channel,
    )
    .await
    .expect("agent_spawn");

    let subs_of = |agents: &[agent_studio_scaffold_lib::model::AgentNode]| {
        agents
            .iter()
            .filter(|a| a.parent_id.as_deref() == Some(root_id.as_str()))
            .map(|a| (a.id.clone(), a.status))
            .collect::<HashMap<_, _>>()
    };
    let start = Instant::now();
    let subs = loop {
        let subs = subs_of(&sup.snapshot().await.unwrap().agents);
        if subs.len() == 20 || start.elapsed() > common::TIMEOUT {
            break subs;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    // Several polls past the spawn, so a wrong `Done` would have had time to land.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let settled = subs_of(&sup.snapshot().await.unwrap().agents);

    // The copied session: end agent 7 there, as the CLI would.
    let proj = home.join(".claude/projects/-work-gazelle");
    let root_transcript = std::fs::read_dir(&proj)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .expect("the fake claude wrote the root transcript");
    fixture.notify_parent(&root_transcript, 7, "completed", now, 1);
    let start = Instant::now();
    let ended = loop {
        let subs = subs_of(&sup.snapshot().await.unwrap().agents);
        let done = subs.values().filter(|s| **s == AgentStatus::Done).count();
        if done >= 1 || start.elapsed() > common::TIMEOUT {
            break subs;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let events = sink.events();
    std::env::remove_var(CLAUDE_BIN_ENV);
    drop(sup);
    std::fs::remove_dir_all(&home).ok();

    assert_eq!(subs.len(), 20, "twenty sub-agents reach the forest");
    assert!(
        settled.values().all(|s| *s == AgentStatus::Running),
        "all twenty are working: {settled:?}"
    );
    assert_eq!(ended[&agent_id(7)], AgentStatus::Done, "{ended:?}");
    assert_eq!(
        ended
            .values()
            .filter(|s| **s == AgentStatus::Running)
            .count(),
        19,
        "{ended:?}"
    );
    let ends: Vec<&AgentEvent> = events
        .iter()
        .filter(|e| {
            matches!(e, AgentEvent::Status { agent_id, status }
                if subs.contains_key(agent_id) && *status != AgentStatus::Running)
        })
        .collect();
    assert_eq!(
        ends.len(),
        1,
        "exactly one sub-agent end reached the UI: {ends:?}"
    );
}
