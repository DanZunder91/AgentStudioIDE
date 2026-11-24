//! Pinned-agent restore wiring — the supervisor half.
//!
//! The pure `pinned_agents.rs` store is unit-tested next to it (round-trip,
//! missing/corrupt → empty, atomic write, upsert/remove/dedupe/order). This suite
//! covers the two things the store can't reach on its own, both driven by a stub
//! adapter so no real `claude` (auth + network) is involved:
//!
//! 1. **`describe_pinnable`** — the in-process lookup `pin_agent` uses so the session
//!    id never crosses the JS wire: it returns a live ROOT's cwd / runtime / session
//!    id, and returns `None` for an unknown id or a (transcript-derived) sub-agent.
//! 2. **Resume threading** — `AgentSpawnSpec.resume_session_id` reaches the adapter's
//!    `SpawnRequest`, which imposes that exact id and binds the agent + tailer on it
//!    (the fresh path still mints a new one).

mod common;

use std::sync::{Arc, Mutex};

use agent_studio_scaffold_lib::agent::adapter::{
    AgentAdapter, AgentSpawn, SessionKey, SpawnRequest,
};
use agent_studio_scaffold_lib::agent::fanout::{FanoutAgent, FanoutDelta, FanoutStatus};
use agent_studio_scaffold_lib::pty::SpawnSpec;
use agent_studio_scaffold_lib::supervisor::AgentSpawnSpec;
use common::{supervisor_with, temp_cwd, ChannelSink};

/// An adapter that records the `resume_session_id` it was handed and, when one is
/// present, **imposes it verbatim** as the session key (the real `ClaudeAdapter`
/// does the same via `--resume`). With no resume it mints a fresh id. Runs a plain
/// interactive shell so the agent stays alive for `describe_pinnable` to observe.
struct ResumeRecordingAdapter {
    /// Every `resume_session_id` value seen, in spawn order (`None` = fresh spawn).
    seen: Mutex<Vec<Option<String>>>,
}

impl ResumeRecordingAdapter {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
        })
    }
    /// The `resume_session_id`s handed to `spawn`, in order.
    fn seen(&self) -> Vec<Option<String>> {
        self.seen.lock().unwrap().clone()
    }
}

impl AgentAdapter for ResumeRecordingAdapter {
    fn id(&self) -> &'static str {
        "resume-stub"
    }
    fn default_title(&self) -> &'static str {
        "resume-stub"
    }
    fn spawn(&self, req: &SpawnRequest<'_>) -> anyhow::Result<AgentSpawn> {
        let resumed = req.resume_session_id.map(|k| k.0.clone());
        self.seen.lock().unwrap().push(resumed.clone());
        // Impose the resumed id, or mint a fresh one — exactly the real adapter's
        // fresh-vs-resume branch, minus the actual `claude`.
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
}

fn spec(agent_id: &str, resume: Option<&str>) -> AgentSpawnSpec {
    AgentSpawnSpec {
        agent_id: agent_id.to_string(),
        runtime: "resume-stub".into(),
        cwd: temp_cwd(),
        rows: 24,
        cols: 80,
        prompt: None,
        resume_session_id: resume.map(str::to_string),
    }
}

/// A fresh spawn mints its own id; `describe_pinnable` reports the live root's
/// cwd / runtime / session id — the exact facts `pin_agent` persists (in-process, so
/// the session id never crosses the wire).
#[tokio::test]
async fn describe_pinnable_reports_a_live_roots_facts() {
    let adapter = ResumeRecordingAdapter::new();
    let (sup, _sink) = supervisor_with(adapter.clone() as Arc<dyn AgentAdapter>);

    let id = format!("root-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    let meta = sup
        .spawn_agent(spec(&id, None), channel)
        .await
        .expect("spawn failed");

    let info = sup
        .describe_pinnable(id.clone())
        .await
        .expect("describe failed")
        .expect("a live root must be pinnable");

    assert_eq!(info.agent_id, id);
    assert_eq!(info.runtime, "resume-stub");
    assert_eq!(info.cwd, meta.cwd, "cwd matches the spawned terminal");
    assert!(
        info.session_id.starts_with("fresh-"),
        "a fresh spawn minted its own id: {}",
        info.session_id
    );
    // An unrenamed node (title == adapter default) has nothing to preserve.
    assert_eq!(info.custom_title, None);
}

/// The load-bearing restore path: `resume_session_id` reaches the adapter, which
/// imposes it, and the agent is bound on that EXACT id — so `describe_pinnable`
/// (and thus the persisted pin, and the tailer) all key off the resumed session.
#[tokio::test]
async fn resume_session_id_is_threaded_to_the_adapter_and_bound() {
    let adapter = ResumeRecordingAdapter::new();
    let (sup, _sink) = supervisor_with(adapter.clone() as Arc<dyn AgentAdapter>);

    let id = format!("root-{}", ulid::Ulid::new());
    let known = "abc00000-0000-7000-8000-000000000abc";
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(spec(&id, Some(known)), channel)
        .await
        .expect("resume spawn failed");

    // The adapter saw the resume id we passed…
    assert_eq!(adapter.seen().as_slice(), &[Some(known.to_string())]);

    // …and the agent is bound on that exact id, not a freshly minted one.
    let info = sup
        .describe_pinnable(id)
        .await
        .expect("describe failed")
        .expect("root must be pinnable");
    assert_eq!(
        info.session_id, known,
        "the resumed session id must be the one bound + tailed"
    );
}

/// An unknown id is not pinnable — `None`, never an error or a fabricated entry.
#[tokio::test]
async fn describe_pinnable_of_an_unknown_id_is_none() {
    let adapter = ResumeRecordingAdapter::new();
    let (sup, _sink) = supervisor_with(adapter.clone() as Arc<dyn AgentAdapter>);
    assert!(sup
        .describe_pinnable("nobody-home".into())
        .await
        .expect("describe failed")
        .is_none());
}

/// A sub-agent is transcript-derived: it has no process to re-spawn, so it is NOT
/// pinnable. `describe_pinnable` must return `None` for it even though it is a real
/// node in the forest (the hard ROOT-only constraint).
#[tokio::test]
async fn a_subagent_is_not_pinnable() {
    let adapter = ResumeRecordingAdapter::new();
    let (sup, _sink) = supervisor_with(adapter.clone() as Arc<dyn AgentAdapter>);

    let root = format!("root-{}", ulid::Ulid::new());
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(spec(&root, None), channel)
        .await
        .expect("spawn failed");

    // Inject a sub-agent under the root, exactly as the fan-out tailer would.
    let sub = format!("sub-{}", ulid::Ulid::new());
    sup.deliver_fanout_delta(FanoutDelta::Spawned(FanoutAgent {
        agent_id: sub.clone(),
        parent_id: root.clone(),
        title: "Explore".into(),
        kind: "Explore".into(),
        spawn_depth: Some(1),
        status: FanoutStatus::Running,
        cwd: temp_cwd(),
        branch: "main".into(),
    }))
    .await
    .expect("deliver delta failed");

    // The supervisor is a single FIFO actor: the `FanoutDelta` above is fully
    // applied before either `describe_pinnable` below is answered, so the sub-agent
    // is guaranteed present — no polling needed. Confirm it landed via the snapshot.
    let snap = sup.snapshot().await.expect("snapshot failed");
    assert!(
        snap.agents.iter().any(|a| a.id == sub),
        "sub-agent must be in the forest after its delta"
    );

    // The root is pinnable; the sub-agent is not.
    assert!(sup
        .describe_pinnable(root)
        .await
        .expect("describe failed")
        .is_some());
    assert!(
        sup.describe_pinnable(sub)
            .await
            .expect("describe failed")
            .is_none(),
        "a sub-agent has no process to re-spawn and must never be pinnable"
    );
}
