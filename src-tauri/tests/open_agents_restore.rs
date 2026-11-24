//! Open agents come back after a restart — the supervisor half (phase 1 of "agents
//! survive a restart"; `src/open_agents.rs`).
//!
//! The pure registry and the restore planner are unit-tested next to them. This suite
//! drives the REAL supervisor actor (a stub adapter instead of `claude`, a temp file
//! instead of the app-config dir) through every write and every rung:
//!
//! 1. **The writes** — a spawn records the agent; the user closing it, or its own
//!    process ending, forgets it.
//! 2. **The shutdown order** — once `begin_shutdown` has raised the flag, neither a PTY
//!    exit nor a close forgets anything (the quit is not the user ending them), and the
//!    one shutdown write says which agents were mid-turn.
//! 3. **The ladder** — resume when a transcript exists, else fresh in the same folder
//!    (with the new session id recorded), else a dormant row: missing folder or a
//!    runtime that will not start. Same agent ids throughout.
//! 4. **The markers** — `restored_agents` lists what came back, and an agent leaves it
//!    at its next turn, its end, or its close.

mod common;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_studio_scaffold_lib::agent::adapter::{
    AgentAdapter, AgentSpawn, SessionKey, SpawnRequest,
};
use agent_studio_scaffold_lib::agent::fanout::TranscriptLocation;
use agent_studio_scaffold_lib::agent::hook::{SessionEvent, SessionEventKind};
use agent_studio_scaffold_lib::model::{AgentStatus, TerminalKind, TerminalStatus};
use agent_studio_scaffold_lib::open_agents::{
    self, OpenAgent, Registry, RestoreOutcome, RestoredAgent,
};
use agent_studio_scaffold_lib::pinned_agents::PinnedAgent;
use agent_studio_scaffold_lib::pty::SpawnSpec;
use agent_studio_scaffold_lib::supervisor::{
    spawn_supervisor_with_store, AgentSpawnSpec, SupervisorHandle,
};
use common::{temp_cwd, ChannelSink, RecordingSink, EOL};

const RUNTIME: &str = "restore-stub";

/// The adapter a restore is driven through. Like `ClaudeAdapter`, it imposes a resume
/// id verbatim and mints a fresh one otherwise — and it RECORDS which it got, which is
/// the `claude --resume <id>` assertion without a real `claude`. Its "saved
/// transcripts" are a set the test controls, so the ladder's resume/fresh decision is
/// driven without touching `~/.claude`. It also parses the turn hooks, so a test can
/// put an agent mid-turn exactly as `UserPromptSubmit` does.
struct RestoreAdapter {
    seen: Mutex<Vec<Option<String>>>,
    transcripts: Mutex<HashSet<String>>,
}

impl RestoreAdapter {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            transcripts: Mutex::new(HashSet::new()),
        })
    }
    fn seen(&self) -> Vec<Option<String>> {
        self.seen.lock().unwrap().clone()
    }
    fn has_transcript(&self, session_id: &str) {
        self.transcripts.lock().unwrap().insert(session_id.into());
    }
}

impl AgentAdapter for RestoreAdapter {
    fn id(&self) -> &'static str {
        RUNTIME
    }
    fn default_title(&self) -> &'static str {
        "Restore stub"
    }
    fn spawn(&self, req: &SpawnRequest<'_>) -> anyhow::Result<AgentSpawn> {
        let resumed = req.resume_session_id.map(|k| k.0.clone());
        self.seen.lock().unwrap().push(resumed.clone());
        let key = SessionKey(resumed.unwrap_or_else(|| format!("fresh-{}", ulid::Ulid::new())));
        let (program, args) = common::interactive_sh();
        Ok(AgentSpawn {
            spec: SpawnSpec {
                program,
                args,
                cwd: req.cwd.to_path_buf(),
                env: vec![],
                rows: req.rows,
                cols: req.cols,
            },
            session_key: key,
        })
    }
    fn parse_session_event(&self, body: &[u8]) -> Option<SessionEvent> {
        let v: serde_json::Value = serde_json::from_slice(body).ok()?;
        let kind = match v.get("hook_event_name")?.as_str()? {
            "UserPromptSubmit" => SessionEventKind::Busy,
            "Stop" => SessionEventKind::Idle,
            "Notification" => SessionEventKind::AwaitingInput,
            _ => return None,
        };
        Some(SessionEvent {
            kind,
            session_id: v.get("session_id")?.as_str()?.to_string(),
            transcript_path: None,
            cwd: None,
        })
    }
    fn locate_transcript(&self, session_id: &str) -> Option<TranscriptLocation> {
        self.transcripts
            .lock()
            .unwrap()
            .contains(session_id)
            .then(|| TranscriptLocation {
                root_transcript: PathBuf::from("/nonexistent/root.jsonl"),
                subagents_dir: PathBuf::from("/nonexistent/subagents"),
            })
    }
}

/// A temp dir holding the registry; removed on drop.
struct Store {
    dir: PathBuf,
    path: PathBuf,
}

impl Store {
    fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("agentstudio-open-it-{label}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(open_agents::FILE_NAME);
        Self { dir, path }
    }
    fn ids(&self) -> Vec<String> {
        open_agents::load(&self.path)
            .into_iter()
            .map(|a| a.agent_id)
            .collect()
    }
    fn get(&self, id: &str) -> Option<OpenAgent> {
        open_agents::load(&self.path)
            .into_iter()
            .find(|a| a.agent_id == id)
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn supervisor(adapter: &Arc<RestoreAdapter>, store: &Store) -> (SupervisorHandle, RecordingSink) {
    let sink = RecordingSink::new();
    let sup = spawn_supervisor_with_store(
        Arc::new(sink.clone()),
        vec![adapter.clone() as Arc<dyn AgentAdapter>],
        None,
        None,
        Some(store.path.clone()),
    );
    (sup, sink)
}

fn new_id(label: &str) -> String {
    format!("{label}-{}", ulid::Ulid::new())
}

async fn spawn(sup: &SupervisorHandle, id: &str) {
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        AgentSpawnSpec {
            agent_id: id.to_string(),
            runtime: RUNTIME.into(),
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
            prompt: None,
            resume_session_id: None,
        },
        channel,
    )
    .await
    .expect("spawn failed");
}

/// The bound session of `id` — the minted key the registry must have recorded.
async fn session_of(sup: &SupervisorHandle, id: &str) -> String {
    sup.describe_pinnable(id.to_string())
        .await
        .unwrap()
        .expect("a live root")
        .session_id
}

/// Make the agent's own process end, as `/exit` does: the stub is a shell.
async fn exit_on_its_own(sup: &SupervisorHandle, id: &str) {
    sup.write(id.to_string(), format!("exit 0{EOL}").into_bytes())
        .await
        .unwrap();
}

async fn terminal_status(sup: &SupervisorHandle, id: &str) -> Option<TerminalStatus> {
    sup.snapshot()
        .await
        .unwrap()
        .terminals
        .into_iter()
        .find(|t| t.id == id)
        .map(|t| t.status)
}

async fn wait_exited(sup: &SupervisorHandle, id: &str) {
    let start = std::time::Instant::now();
    while terminal_status(sup, id).await != Some(TerminalStatus::Exited) {
        assert!(start.elapsed() < common::TIMEOUT, "{id} never exited");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// `begin_shutdown` blocks its caller (the event-loop thread in the app), so run it off
/// the test's runtime thread.
async fn shut_down(sup: &SupervisorHandle) -> bool {
    let sup = sup.clone();
    tokio::task::spawn_blocking(move || sup.begin_shutdown(Duration::from_secs(5)))
        .await
        .unwrap()
}

fn turn_hook(event: &str, session: &str) -> Vec<u8> {
    serde_json::json!({ "hook_event_name": event, "session_id": session })
        .to_string()
        .into_bytes()
}

// ── 1. the writes ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_spawn_is_recorded_with_its_session_and_a_close_forgets_it() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("close");
    let (sup, _sink) = supervisor(&adapter, &store);

    let (a, b) = (new_id("a"), new_id("b"));
    spawn(&sup, &a).await;
    spawn(&sup, &b).await;
    assert_eq!(store.ids(), vec![a.clone(), b.clone()], "spawn order");
    let entry = store.get(&a).unwrap();
    assert_eq!(entry.session_id, session_of(&sup, &a).await);
    assert_eq!(entry.runtime, RUNTIME);
    assert_eq!(entry.cwd, temp_cwd());
    assert_eq!(entry.was_working, None);

    // The user closes `a` (its tab ✕ / row ✕ end in `terminal_close`).
    sup.close(a.clone()).await.unwrap();
    assert_eq!(
        store.ids(),
        vec![b],
        "closed for good: it must not come back"
    );
}

#[tokio::test]
async fn the_agents_own_exit_forgets_it() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("own-exit");
    let (sup, _sink) = supervisor(&adapter, &store);

    let (a, stays) = (new_id("a"), new_id("stays"));
    spawn(&sup, &a).await;
    spawn(&sup, &stays).await;
    exit_on_its_own(&sup, &a).await;
    wait_exited(&sup, &a).await;
    // The snapshot answer comes after `ChildExited` was handled (FIFO), so the
    // removal has happened by now.
    assert_eq!(store.ids(), vec![stays], "the user ended it with /exit");
}

#[tokio::test]
async fn a_plain_console_is_never_recorded() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("console");
    let (sup, _sink) = supervisor(&adapter, &store);

    let (_out, channel) = ChannelSink::new();
    let t = new_id("console");
    sup.open_terminal(
        agent_studio_scaffold_lib::supervisor::OpenSpec {
            terminal_id: t.clone(),
            program: None,
            args: vec![],
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .unwrap();
    sup.close(t).await.unwrap();
    assert!(
        !store.path.exists(),
        "out of scope for phase 1: nothing written"
    );
}

// ── 2. the shutdown order ─────────────────────────────────────────────────────

/// The case that matters: quitting must not count as closing. After the flag is up, the
/// PTYs dying (their own exit, or a close) leave every entry for the next launch.
#[tokio::test]
async fn after_begin_shutdown_neither_an_exit_nor_a_close_forgets_an_agent() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("shutdown");
    let (sup, _sink) = supervisor(&adapter, &store);

    let (exits, closed) = (new_id("exits"), new_id("closed"));
    spawn(&sup, &exits).await;
    spawn(&sup, &closed).await;

    assert!(shut_down(&sup).await, "the shutdown write is confirmed");
    assert!(!shut_down(&sup).await, "idempotent: one quit, one write");

    exit_on_its_own(&sup, &exits).await;
    wait_exited(&sup, &exits).await;
    sup.close(closed.clone()).await.unwrap();

    assert_eq!(store.ids(), vec![exits.clone(), closed.clone()]);
    // Both were parked at their prompt when the app quit.
    assert_eq!(store.get(&exits).unwrap().was_working, Some(false));
    assert_eq!(store.get(&closed).unwrap().was_working, Some(false));
}

/// The one shutdown write says WHICH agents the quit interrupted mid-turn — what lets
/// the next launch tell the user "tell it to continue" honestly.
#[tokio::test]
async fn the_shutdown_write_records_which_agents_were_mid_turn() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("working");
    let (sup, _sink) = supervisor(&adapter, &store);

    let (busy, asking, idle) = (new_id("busy"), new_id("asking"), new_id("idle"));
    for id in [&busy, &asking, &idle] {
        spawn(&sup, id).await;
    }
    sup.deliver_hook(
        busy.clone(),
        turn_hook("UserPromptSubmit", &session_of(&sup, &busy).await),
    );
    // A turn that started and ENDED is not working any more.
    let idle_session = session_of(&sup, &idle).await;
    sup.deliver_hook(idle.clone(), turn_hook("UserPromptSubmit", &idle_session));
    sup.deliver_hook(idle.clone(), turn_hook("Stop", &idle_session));
    // Waiting on a permission prompt is still a turn in flight.
    sup.deliver_hook(
        asking.clone(),
        turn_hook("Notification", &session_of(&sup, &asking).await),
    );
    let snap = sup.snapshot().await.unwrap();
    let status = |id: &str| snap.agents.iter().find(|a| a.id == id).unwrap().status;
    assert_eq!(status(&busy), AgentStatus::Running);
    assert_eq!(status(&asking), AgentStatus::WaitingInput);
    assert_eq!(status(&idle), AgentStatus::Idle);

    assert!(shut_down(&sup).await);
    assert_eq!(store.get(&busy).unwrap().was_working, Some(true));
    assert_eq!(store.get(&asking).unwrap().was_working, Some(true));
    assert_eq!(store.get(&idle).unwrap().was_working, Some(false));
}

// ── 3. the ladder ─────────────────────────────────────────────────────────────

fn open_entry(
    id: &str,
    cwd: &str,
    runtime: &str,
    session: &str,
    working: Option<bool>,
) -> OpenAgent {
    OpenAgent {
        agent_id: id.into(),
        cwd: cwd.into(),
        runtime: runtime.into(),
        session_id: session.into(),
        was_working: working,
    }
}

/// Write the registry as the last session left it (through its own writer API — the
/// previous run's supervisor).
fn seed(store: &Store, entries: &[OpenAgent]) {
    let previous_run = Registry::at(store.path.clone());
    for e in entries {
        previous_run.record(e.clone()).unwrap();
    }
    let working: std::collections::HashMap<String, bool> = entries
        .iter()
        .filter_map(|e| e.was_working.map(|w| (e.agent_id.clone(), w)))
        .collect();
    previous_run.record_working(&working);
}

/// Restore exactly as `open_agents::restore_on_boot` does in phase 1: no pins here,
/// nothing already running, one `Restore` message.
fn restore_from(sup: &SupervisorHandle, _store: &Store) {
    sup.restore(vec![], HashSet::new()).unwrap();
}

fn pin_of(id: &str, session: &str) -> PinnedAgent {
    PinnedAgent {
        agent_id: id.into(),
        cwd: temp_cwd(),
        runtime: RUNTIME.into(),
        session_id: session.into(),
        custom_title: None,
        order: 0,
    }
}

#[tokio::test]
async fn restore_walks_the_ladder_under_the_same_agent_ids() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("ladder");
    let gone = std::env::temp_dir().join(format!("agentstudio-gone-{}", ulid::Ulid::new()));
    assert!(!gone.exists());
    let gone = gone.to_string_lossy().into_owned();
    let (resumed, fresh, folder_gone, broken) = (
        new_id("resumed"),
        new_id("fresh"),
        new_id("gone"),
        new_id("broken"),
    );
    seed(
        &store,
        &[
            open_entry(&resumed, &temp_cwd(), RUNTIME, "s-resumed", Some(true)),
            open_entry(&fresh, &temp_cwd(), RUNTIME, "s-never-saved", Some(false)),
            open_entry(&folder_gone, &gone, RUNTIME, "s-gone", Some(true)),
            open_entry(
                &broken,
                &temp_cwd(),
                "uninstalled-runtime",
                "s-broken",
                None,
            ),
        ],
    );
    adapter.has_transcript("s-resumed");
    adapter.has_transcript("s-gone"); // a saved conversation does not help a missing folder

    let (sup, _sink) = supervisor(&adapter, &store);
    restore_from(&sup, &store);

    // FIFO: the very next snapshot already has every restored agent — the guarantee
    // the frontend's layout restore depends on.
    let snap = sup.snapshot().await.unwrap();
    let agent = |id: &str| snap.agents.iter().find(|a| a.id == id).cloned().unwrap();
    let term = |id: &str| snap.terminals.iter().find(|t| t.id == id).cloned().unwrap();

    // `claude --resume s-resumed` for the one with a transcript; fresh for the other.
    // The missing folder and the unknown runtime never reached this adapter.
    assert_eq!(adapter.seen(), vec![Some("s-resumed".to_string()), None]);
    assert_eq!(session_of(&sup, &resumed).await, "s-resumed");
    assert_eq!(term(&resumed).status, TerminalStatus::Live);
    assert_eq!(term(&fresh).status, TerminalStatus::Live);
    assert_eq!(
        agent(&resumed).status,
        AgentStatus::Idle,
        "a root is born idle"
    );

    // Dormant rows: an ended agent (finished, error saying why) with an exited tab
    // terminal under the same id, so the layout restore still finds its slot.
    for (id, why) in [
        (&folder_gone, "its folder no longer exists"),
        (&broken, "it could not start"),
    ] {
        let a = agent(id);
        assert_eq!(a.status, AgentStatus::Error, "{id}");
        assert!(a.finished_at.is_some());
        let error = a.error.unwrap();
        assert!(
            error.starts_with("not reopened after the restart"),
            "{error}"
        );
        assert!(error.contains(why), "{error}");
        let t = term(id);
        assert_eq!(t.status, TerminalStatus::Exited);
        assert_eq!(t.kind, TerminalKind::AgentTerminal);
        assert_eq!(t.agent_id.as_deref(), Some(id.as_str()));
    }
    assert!(agent(&folder_gone).error.unwrap().contains(&gone));

    // The markers: what came back, on which rung, and whether the quit interrupted it.
    let mut want = vec![
        RestoredAgent {
            agent_id: resumed.clone(),
            outcome: RestoreOutcome::Resumed,
            was_working: Some(true),
        },
        RestoredAgent {
            agent_id: fresh.clone(),
            outcome: RestoreOutcome::Fresh,
            was_working: Some(false),
        },
        RestoredAgent {
            agent_id: folder_gone.clone(),
            outcome: RestoreOutcome::Dormant,
            was_working: Some(true),
        },
        RestoredAgent {
            agent_id: broken.clone(),
            outcome: RestoreOutcome::Dormant,
            was_working: None,
        },
    ];
    want.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    assert_eq!(sup.restored_agents().await.unwrap(), want);

    // The registry after the restore: same agents, same order. The fresh fallback's NEW
    // session replaced the dead one (or every launch would re-try a resume that cannot
    // work); each re-launch is a new run, so its shutdown stamp is cleared. The dormant
    // ones were not touched — they still come back until the user closes them.
    assert_eq!(
        store.ids(),
        vec![
            resumed.clone(),
            fresh.clone(),
            folder_gone.clone(),
            broken.clone()
        ]
    );
    assert_eq!(store.get(&resumed).unwrap().session_id, "s-resumed");
    let fresh_now = store.get(&fresh).unwrap();
    assert!(
        fresh_now.session_id.starts_with("fresh-"),
        "{}",
        fresh_now.session_id
    );
    assert_eq!(fresh_now.session_id, session_of(&sup, &fresh).await);
    assert_eq!(store.get(&resumed).unwrap().was_working, None);
    assert_eq!(store.get(&folder_gone).unwrap().was_working, Some(true));
    assert_eq!(store.get(&broken).unwrap().session_id, "s-broken");
}

/// Closing the dormant row is the user saying "forget it": the ordinary close of its
/// tab removes it, from the fleet and from the registry.
#[tokio::test]
async fn closing_a_dormant_agent_forgets_it() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("dormant-close");
    let gone = format!("/definitely/not/here-{}", ulid::Ulid::new());
    let id = new_id("gone");
    seed(&store, &[open_entry(&id, &gone, RUNTIME, "s", None)]);
    let (sup, _sink) = supervisor(&adapter, &store);
    restore_from(&sup, &store);

    // Re-attaching it answers `exited` (the frontend shows the ended tab), never an error.
    let (_out, channel) = ChannelSink::new();
    let meta = sup.reattach(id.clone(), channel).await.unwrap();
    assert_eq!(meta.status, TerminalStatus::Exited);
    // Nothing runs in it, so closing it asks no confirmation.
    assert!(sup
        .terminals_busy(vec![id.clone()])
        .await
        .unwrap()
        .is_empty());

    sup.close(id.clone()).await.unwrap();
    assert!(store.ids().is_empty());
    let snap = sup.snapshot().await.unwrap();
    assert!(snap.agents.iter().all(|a| a.id != id));
    assert!(sup.restored_agents().await.unwrap().is_empty());
}

/// Restore never spawns an agent that is already here (a second `Restore`, or one
/// racing a spawn): a second process on one session would fight over its transcript.
#[tokio::test]
async fn restore_leaves_an_agent_that_already_exists_alone() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("dup");
    let (sup, _sink) = supervisor(&adapter, &store);
    let id = new_id("live");
    spawn(&sup, &id).await; // recorded in the registry by the spawn itself
    sup.restore(vec![pin_of(&id, "other")], HashSet::new())
        .unwrap();
    assert_eq!(sup.snapshot().await.unwrap().agents.len(), 1);
    assert_eq!(adapter.seen(), vec![None], "spawned once, by the user");
    assert!(sup.restored_agents().await.unwrap().is_empty());
}

/// Phase 2's seam, through the real actor: an id the caller says is already running
/// (the host kept it alive) is neither launched nor marked; the rest come back — and a
/// pinned agent that is not in the registry (the user `/exit`ed it) comes back too.
#[tokio::test]
async fn restore_skips_the_already_running_and_brings_back_pins() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("running");
    let (kept, down, pinned) = (new_id("kept"), new_id("down"), new_id("pinned"));
    seed(
        &store,
        &[
            open_entry(&kept, &temp_cwd(), RUNTIME, "s-kept", None),
            open_entry(&down, &temp_cwd(), RUNTIME, "s-down", None),
        ],
    );
    let (sup, _sink) = supervisor(&adapter, &store);
    sup.restore(
        vec![pin_of(&pinned, "s-pinned")],
        HashSet::from([kept.clone()]),
    )
    .unwrap();

    let snap = sup.snapshot().await.unwrap();
    let ids: Vec<&str> = snap.agents.iter().map(|a| a.id.as_str()).collect();
    assert!(!ids.contains(&kept.as_str()), "{ids:?}");
    assert!(
        ids.contains(&down.as_str()) && ids.contains(&pinned.as_str()),
        "{ids:?}"
    );
    assert_eq!(adapter.seen().len(), 2);
    let marked: Vec<String> = sup
        .restored_agents()
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.agent_id)
        .collect();
    assert!(!marked.contains(&kept), "{marked:?}");
    // The pinned one is now an open agent too: spawning it recorded it.
    assert!(store.ids().contains(&pinned));
}

// ── 4. the markers ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_marker_comes_down_at_the_next_turn_the_agents_end_or_its_close() {
    let adapter = RestoreAdapter::new();
    let store = Store::new("markers");
    let (talks, ends, closed) = (new_id("talks"), new_id("ends"), new_id("closed"));
    seed(
        &store,
        &[
            open_entry(&talks, &temp_cwd(), RUNTIME, "s-talks", Some(true)),
            open_entry(&ends, &temp_cwd(), RUNTIME, "s-ends", None),
            open_entry(&closed, &temp_cwd(), RUNTIME, "s-closed", None),
        ],
    );
    for s in ["s-talks", "s-ends", "s-closed"] {
        adapter.has_transcript(s);
    }
    let (sup, _sink) = supervisor(&adapter, &store);
    restore_from(&sup, &store);
    let marked = |list: Vec<RestoredAgent>| -> Vec<String> {
        list.into_iter().map(|r| r.agent_id).collect()
    };
    assert_eq!(sup.restored_agents().await.unwrap().len(), 3);

    // A `Stop` alone is not the user talking to it — the marker stays.
    sup.deliver_hook(talks.clone(), turn_hook("Stop", "s-talks"));
    assert_eq!(sup.restored_agents().await.unwrap().len(), 3);
    // The user tells it to continue → its next turn → the marker has done its job.
    sup.deliver_hook(talks.clone(), turn_hook("UserPromptSubmit", "s-talks"));
    let left = marked(sup.restored_agents().await.unwrap());
    assert!(!left.contains(&talks), "{left:?}");

    exit_on_its_own(&sup, &ends).await;
    wait_exited(&sup, &ends).await;
    let left = marked(sup.restored_agents().await.unwrap());
    assert!(!left.contains(&ends), "{left:?}");

    sup.close(closed.clone()).await.unwrap();
    assert!(sup.restored_agents().await.unwrap().is_empty());
}

/// A supervisor with no store (every other test file's) still answers the shutdown —
/// the quit must never wait out the budget because there is nothing to write.
#[tokio::test]
async fn without_a_store_the_shutdown_still_answers() {
    let adapter = RestoreAdapter::new();
    let sup = spawn_supervisor_with_store(
        Arc::new(RecordingSink::new()),
        vec![adapter.clone() as Arc<dyn AgentAdapter>],
        None,
        None,
        None,
    );
    spawn(&sup, &new_id("a")).await;
    let started = std::time::Instant::now();
    assert!(shut_down(&sup).await, "confirmed, not timed out");
    assert!(started.elapsed() < Duration::from_secs(5));
}

// ── 5. sub-agents first seen already ended (a resumed session's history) ───────

/// After a restart, `claude --resume` re-reads a session whose sub-agents ended long
/// ago: the tailer's FIRST sight of each is already `done`/`error`. The row is created
/// by `SubagentSpawned` (which carries no status, and the UI starts it `running`), so
/// the end must follow on a `Status` — in that order, or the UI has no row to apply it
/// to. A sub-agent first seen running gets no extra event.
#[tokio::test]
async fn a_sub_agent_first_seen_ended_is_followed_by_its_status() {
    use agent_studio_scaffold_lib::agent::fanout::{FanoutAgent, FanoutDelta, FanoutStatus};
    use agent_studio_scaffold_lib::model::AgentEvent;

    let adapter = RestoreAdapter::new();
    let store = Store::new("subagents");
    let (sup, sink) = supervisor(&adapter, &store);
    let root = new_id("root");
    spawn(&sup, &root).await;
    for (kid, status) in [
        ("old-done", FanoutStatus::Done),
        ("old-failed", FanoutStatus::Error),
        ("live", FanoutStatus::Running),
    ] {
        sup.deliver_fanout_delta(FanoutDelta::Spawned(FanoutAgent {
            agent_id: kid.into(),
            parent_id: root.clone(),
            title: kid.into(),
            kind: "Explore".into(),
            spawn_depth: Some(1),
            status,
            cwd: temp_cwd(),
            branch: "main".into(),
        }))
        .await
        .unwrap();
    }
    let snap = sup.snapshot().await.unwrap(); // FIFO: every delta is applied
    let node = |id: &str| snap.agents.iter().find(|a| a.id == id).unwrap().clone();
    assert_eq!(node("old-done").status, AgentStatus::Done);
    assert!(node("old-done").finished_at.is_some());

    // Per child: the events about it, in order.
    let about = |kid: &str| -> Vec<String> {
        sink.events()
            .into_iter()
            .filter_map(|e| match e {
                AgentEvent::SubagentSpawned { child_agent_id, .. } if child_agent_id == kid => {
                    Some("spawned".to_string())
                }
                AgentEvent::Status { agent_id, status } if agent_id == kid => {
                    Some(format!("status:{status:?}"))
                }
                _ => None,
            })
            .collect()
    };
    assert_eq!(about("old-done"), vec!["spawned", "status:Done"]);
    assert_eq!(about("old-failed"), vec!["spawned", "status:Error"]);
    assert_eq!(about("live"), vec!["spawned"]);
}
