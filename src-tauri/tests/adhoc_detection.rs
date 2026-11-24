//! Integration tests for ad-hoc agent detection — the binding table
//! and the promotion of a typed `claude` into a rail node.
//!
//! **No real `claude`.** The binding pipeline is driven by delivering hook payloads
//! (the exact JSON a `claude` `SessionStart`/`SessionEnd` hook POSTs) straight to
//! the supervisor via `deliver_hook`, and the stub adapter parses that shape. The
//! real payload schema and the real settings/token mechanism were verified against
//! `claude` 2.1.212 separately; here we pin the *logic*.

mod common;

use std::sync::Arc;
use std::time::Duration;

use agent_studio_scaffold_lib::model::{AgentStatus, TerminalKind};
use agent_studio_scaffold_lib::supervisor::{OpenSpec, SupervisorHandle};
use common::{
    hook_payload, hook_payload_cwd, interactive_sh, supervisor_with, supervisor_with_hook,
    temp_cwd, test_hook_config, ChannelSink, StubAdapter, TIMEOUT,
};

// Used only by the `#[cfg(unix)]` tests (env injection + settings-file install,
// which need a shell that echoes env / a POSIX cwd). Gated to match, so the Windows
// build doesn't warn about unused imports under `-D warnings`.
#[cfg(unix)]
use agent_studio_scaffold_lib::hook_listener::HookConfig;
#[cfg(unix)]
use common::{sh, wait_for_output};

fn tid(label: &str) -> String {
    format!("{label}-{}", ulid::Ulid::new())
}

/// Open a plain terminal (the thing a user would type `claude` into).
async fn open_plain(sup: &SupervisorHandle, id: &str) {
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: id.to_string(),
            program: Some(program),
            args,
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");
}

async fn snapshot_agent(
    sup: &SupervisorHandle,
    id: &str,
) -> Option<agent_studio_scaffold_lib::model::AgentNode> {
    sup.snapshot()
        .await
        .expect("snapshot failed")
        .agents
        .into_iter()
        .find(|n| n.id == id)
}

/// `deliver_hook` is fire-and-forget, so poll the snapshot until `cond` holds.
async fn wait_until_agent(
    sup: &SupervisorHandle,
    id: &str,
    what: &str,
    cond: impl Fn(&Option<agent_studio_scaffold_lib::model::AgentNode>) -> bool,
) {
    let start = std::time::Instant::now();
    loop {
        let node = snapshot_agent(sup, id).await;
        if cond(&node) {
            return;
        }
        if start.elapsed() >= TIMEOUT {
            panic!("timed out waiting for {what}; last node = {node:?}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// **Every PTY carries the detection env** — the whole mechanism rests on a typed
/// `claude` inheriting our terminal id, URL and token. Verified by having the
/// child echo them back.
#[cfg(unix)]
#[tokio::test]
async fn every_pty_gets_the_detection_env_injected() {
    let hook = HookConfig {
        base_url: "http://127.0.0.1:65000".to_string(),
        token: "the-test-token".to_string(),
    };
    let (sup, _sink) = supervisor_with_hook(Arc::new(StubAdapter::interactive()), hook);

    let id = tid("term");
    let (out, channel) = ChannelSink::new();
    let (program, args) = sh(
        "echo tid=$AGENTSTUDIO_TERMINAL_ID url=$AGENTSTUDIO_HOOK_URL tok=$AGENTSTUDIO_HOOK_TOKEN",
    );
    sup.open_terminal(
        OpenSpec {
            terminal_id: id.clone(),
            program: Some(program),
            args,
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");

    wait_for_output(&out, &format!("tid={id}")).await;
    let text = out.text();
    assert!(
        text.contains("url=http://127.0.0.1:65000"),
        "hook URL not injected: {text:?}"
    );
    assert!(
        text.contains("tok=the-test-token"),
        "token not injected: {text:?}"
    );
}

/// **The ad-hoc hook settings are installed into `<cwd>/.claude/settings.local.json`
/// before the shell starts**, so a bare `claude` in that cwd picks them up. The real
/// end-to-end (a real `claude` firing the hook) was verified against `claude`
/// 2.1.212 separately; here we pin that the file is written.
#[cfg(unix)]
#[tokio::test]
async fn opening_a_terminal_installs_the_ad_hoc_hook_file() {
    let dir = std::env::temp_dir().join(format!("agentstudio-adhoc-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();

    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: id,
            program: Some(program),
            args,
            cwd: dir.to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");

    let settings = dir.join(".claude/settings.local.json");
    assert!(settings.is_file(), "the ad-hoc hook file was not written");
    let content = std::fs::read_to_string(&settings).unwrap();
    assert!(
        content.contains("stub-hook-marker"),
        "our hook marker missing: {content}"
    );
    // It must be valid JSON with a SessionStart hook.
    let v: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert!(v["hooks"]["SessionStart"].is_array());

    std::fs::remove_dir_all(&dir).ok();
}

/// **The hook is installed at the git ROOT, not the terminal's subdir.**
/// `claude` walks up from the session's cwd to find `.claude/`, so a hook at the
/// repo root covers every subdirectory the user might `cd` into before running
/// `claude`. Opening a terminal in a nested subdir must land the hook at the root.
#[cfg(unix)]
#[tokio::test]
async fn the_ad_hoc_hook_lands_at_the_git_root_not_the_subdir() {
    // A temp repo: `<repo>/.git` (a plain dir is enough — `git_root` reads `.git`
    // directly), plus a nested subdir the user opens the terminal in. Canonicalize
    // the base so the git walk-up compares like-for-like (macOS /tmp → /private/tmp).
    let base = std::env::temp_dir().join(format!("agentstudio-gitroot-hook-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    let repo = base.join("repo");
    let nested = repo.join("sub/nested");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(repo.join(".git")).unwrap();

    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: id,
            program: Some(program),
            args,
            cwd: nested.to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");

    let at_root = repo.join(".claude/settings.local.json");
    let at_subdir = nested.join(".claude/settings.local.json");
    assert!(
        at_root.is_file(),
        "the hook must be installed at the repo root"
    );
    assert!(
        !at_subdir.exists(),
        "the hook must NOT be installed in the terminal's subdir"
    );
    assert!(std::fs::read_to_string(&at_root)
        .unwrap()
        .contains("stub-hook-marker"));

    std::fs::remove_dir_all(&base).ok();
}

/// **`ensure_agent_hooks` installs the hook for a folder OPENED without a
/// terminal.** The multi-root Files "Open a folder" spawns no PTY, so this
/// command is the only place the hook is installed for it — and it is git-root-aware,
/// so opening a subdir of a repo still lands the hook at the repo root.
#[tokio::test]
async fn ensure_agent_hooks_installs_at_the_git_root_for_an_opened_folder() {
    let base = std::env::temp_dir().join(format!("agentstudio-ensure-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    let repo = base.join("repo");
    let nested = repo.join("pkg/inner");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(repo.join(".git")).unwrap();

    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());

    sup.ensure_agent_hooks(nested.to_string_lossy().into_owned())
        .await
        .expect("ensure_agent_hooks must resolve Ok");

    let at_root = repo.join(".claude/settings.local.json");
    assert!(
        at_root.is_file(),
        "ensure_agent_hooks must install at the repo root"
    );
    assert!(
        !nested.join(".claude/settings.local.json").exists(),
        "must not install in the opened subdir"
    );

    std::fs::remove_dir_all(&base).ok();
}

/// Without a running listener the hook is inert (its env is never injected), so
/// `ensure_agent_hooks` is a no-op — but it must still resolve `Ok`, per its
/// best-effort/non-fatal contract, and write nothing.
#[tokio::test]
async fn ensure_agent_hooks_is_a_noop_but_ok_without_a_listener() {
    let dir = std::env::temp_dir().join(format!("agentstudio-ensure-nohook-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();

    // No hook config → no listener.
    let (sup, _sink) = supervisor_with(Arc::new(StubAdapter::interactive()));

    sup.ensure_agent_hooks(dir.to_string_lossy().into_owned())
        .await
        .expect("must resolve Ok even when the write is skipped");

    assert!(
        !dir.join(".claude/settings.local.json").exists(),
        "no listener means no hook file"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// **The home directory is never written to** — `<home>/.claude/` is the user's
/// global config, and the app never touches it without consent. Opening a
/// terminal whose cwd is home must not create `~/.claude/settings.local.json` (nor
/// modify an existing one).
#[cfg(unix)]
#[tokio::test]
async fn a_terminal_in_the_home_dir_does_not_write_global_config() {
    let home = std::env::var("HOME").expect("HOME set");
    let settings = std::path::Path::new(&home).join(".claude/settings.local.json");
    let before = std::fs::read_to_string(&settings).ok();

    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: id,
            program: Some(program),
            args,
            cwd: home.clone(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");

    let after = std::fs::read_to_string(&settings).ok();
    assert_eq!(
        before, after,
        "opening a terminal in ~ touched the user's global Claude config"
    );
}

/// **The requirement: type `claude` in a plain terminal → it appears in the rail.**
///
/// A plain terminal, then a `SessionStart` on it → an ad-hoc root agent, with
/// `AgentId == TerminalId` (the terminal is *promoted*, its id is the identity).
#[tokio::test]
async fn a_session_start_on_a_plain_terminal_creates_an_adhoc_root() {
    let (sup, sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    open_plain(&sup, &id).await;

    // Before: it's a plain terminal, no agent.
    assert!(
        snapshot_agent(&sup, &id).await.is_none(),
        "no agent before claude runs"
    );

    sup.deliver_hook(
        id.clone(),
        hook_payload(
            "SessionStart",
            "sess-adhoc-1",
            Some("/t/sess-adhoc-1.jsonl"),
        ),
    );

    wait_until_agent(&sup, &id, "the ad-hoc root to appear", |n| n.is_some()).await;

    let node = snapshot_agent(&sup, &id).await.unwrap();
    assert_eq!(node.id, id, "AgentId must equal the promoted terminal's id");
    assert_eq!(node.parent_id, None, "an ad-hoc claude is a root");
    // Born IDLE: `SessionStart` means `claude` just opened and is parked at its
    // prompt — it has not processed a turn. `UserPromptSubmit` is what flips it to
    // Running (turn hooks); defaulting to Running latched an idle welcome screen as
    // "Running" forever.
    assert_eq!(node.status, AgentStatus::Idle);
    // The runtime is the adapter that RECOGNISED the hook — the stub here, the real
    // ClaudeAdapter ("claude-code") in production. (Was hardcoded "claude-code"
    // before the tailer-selection fix; the adapter's id is now the source of truth.)
    assert_eq!(node.runtime, "stub-runtime");
    assert_eq!(node.cwd, temp_cwd());
    // Titled by the RUNTIME (the adapter's default_title), not the promoted shell.
    // Previously inherited the terminal's title ("zsh"), which mislabelled the rail;
    // for the real ClaudeAdapter this is "claude".
    assert_eq!(
        node.title, "stub",
        "ad-hoc agent must be titled by its runtime, not the shell"
    );

    // The terminal was promoted to an agent-terminal, cross-linked to the agent.
    let snap = sup.snapshot().await.unwrap();
    let term = snap.terminals.iter().find(|t| t.id == id).unwrap();
    assert_eq!(
        term.kind,
        TerminalKind::AgentTerminal,
        "the terminal must be promoted"
    );
    assert_eq!(term.agent_id.as_deref(), Some(id.as_str()));

    // And it announced itself on the telemetry channel.
    assert!(
        sink.events().iter().any(|e| matches!(
            e,
            agent_studio_scaffold_lib::model::AgentEvent::AgentStarted { agent_id, .. }
                if agent_id == &id
        )),
        "an ad-hoc root must emit agent_started; got {:?}",
        sink.tags()
    );
}

/// **An ad-hoc root anchors to the payload `cwd`, not the terminal's spawn
/// cwd.** The user opens a terminal in dir A, `cd`s into a different repo B,
/// then types `claude`. The `SessionStart` payload reports B, and the rail node —
/// and the promoted terminal's meta — must both use B, or the rail shows the wrong
/// folder and the git branch is computed from the wrong tree.
#[tokio::test]
async fn an_adhoc_root_anchors_to_the_payload_cwd_not_the_spawn_cwd() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    // The terminal is spawned in cwd A (temp_cwd)...
    open_plain(&sup, &id).await;

    // ...but claude reports it is running in a DIFFERENT dir B (the user cd'd there).
    let dir_b = std::env::temp_dir().join(format!("agentstudio-cwd-b-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir_b).unwrap();
    let cwd_b = dir_b.to_string_lossy().into_owned();
    assert_ne!(cwd_b, temp_cwd(), "B must differ from the spawn cwd A");

    sup.deliver_hook(
        id.clone(),
        hook_payload_cwd("SessionStart", "sess-cwd", &cwd_b, None),
    );
    wait_until_agent(&sup, &id, "the ad-hoc root to appear", |n| n.is_some()).await;

    // The agent node is anchored to B (the payload cwd), never the spawn cwd A.
    let node = snapshot_agent(&sup, &id).await.unwrap();
    assert_eq!(
        node.cwd, cwd_b,
        "the agent must use the payload cwd, not the terminal's spawn cwd"
    );

    // And the terminal's meta cwd was synced to B, so a re-attach snapshot agrees.
    let snap = sup.snapshot().await.unwrap();
    let term = snap.terminals.iter().find(|t| t.id == id).unwrap();
    assert_eq!(
        term.cwd, cwd_b,
        "the promoted terminal's meta cwd must match the payload cwd"
    );

    std::fs::remove_dir_all(&dir_b).ok();
}

/// A `SessionStart` **without** a `cwd` falls back to the terminal's spawn cwd —
/// the agent must never be anchored to an empty path.
#[tokio::test]
async fn an_adhoc_root_without_a_payload_cwd_falls_back_to_the_spawn_cwd() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    open_plain(&sup, &id).await;

    // No cwd in the payload (the old shape).
    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-nocwd", None));
    wait_until_agent(&sup, &id, "the ad-hoc root to appear", |n| n.is_some()).await;

    let node = snapshot_agent(&sup, &id).await.unwrap();
    assert_eq!(
        node.cwd,
        temp_cwd(),
        "a cwd-less payload must fall back to the terminal's spawn cwd"
    );
}

/// **The phantom-root trap (FM-3): a nested `claude -p` must NOT forge a root.**
///
/// The terminal is already bound (here, to a spawned agent). A `SessionStart` with
/// a *different* session id — exactly what a nested `claude` reports, carrying our
/// injected terminal id — is suppressed.
#[tokio::test]
async fn a_nested_session_on_a_bound_terminal_is_suppressed() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());

    // A spawned agent binds its terminal at spawn.
    let agent_id = tid("agent");
    let (_out, channel) = ChannelSink::new();
    sup.spawn_agent(
        agent_studio_scaffold_lib::supervisor::AgentSpawnSpec {
            agent_id: agent_id.clone(),
            runtime: "stub-runtime".into(),
            cwd: temp_cwd(),
            rows: 24,
            cols: 80,
            prompt: None,
            resume_session_id: None,
        },
        channel,
    )
    .await
    .expect("agent_spawn failed");

    let before = sup.snapshot().await.unwrap().agents.len();

    // The agent shells out a nested `claude -p`: same terminal, NEW session id.
    sup.deliver_hook(
        agent_id.clone(),
        hook_payload("SessionStart", "nested-different-session", None),
    );

    // Give the actor time to process (and, if broken, to wrongly create a node).
    tokio::time::sleep(Duration::from_millis(200)).await;

    let after = sup.snapshot().await.unwrap().agents.len();
    assert_eq!(after, before, "a nested claude forged a phantom root");
    // The original agent is untouched and still the only node with its id (born
    // idle: spawned with no prompt, no turn/activity hook has run).
    assert_eq!(
        snapshot_agent(&sup, &agent_id).await.unwrap().status,
        AgentStatus::Idle
    );
}

/// **Two `claude`s in two different terminals, same cwd** — the case the dead cwd
/// heuristic could not tell apart. Two terminals, two bindings, two
/// distinct roots.
#[tokio::test]
async fn two_adhoc_claudes_in_one_cwd_are_two_distinct_roots() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let a = tid("term-a");
    let b = tid("term-b");
    open_plain(&sup, &a).await;
    open_plain(&sup, &b).await;

    sup.deliver_hook(a.clone(), hook_payload("SessionStart", "sess-a", None));
    sup.deliver_hook(b.clone(), hook_payload("SessionStart", "sess-b", None));

    wait_until_agent(&sup, &a, "root a", |n| n.is_some()).await;
    wait_until_agent(&sup, &b, "root b", |n| n.is_some()).await;

    let snap = sup.snapshot().await.unwrap();
    assert_eq!(
        snap.agents
            .iter()
            .filter(|n| n.id == a || n.id == b)
            .count(),
        2
    );
    assert!(
        snap.agents.iter().all(|n| n.parent_id.is_none()),
        "both are roots"
    );
}

/// A `SessionStart` for a terminal we don't have is ignored — only our PTYs carry
/// the env, so a stray/forged POST binds nothing.
#[tokio::test]
async fn a_session_start_for_an_unknown_terminal_is_ignored() {
    let (sup, sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());

    sup.deliver_hook(
        "never-opened-this-terminal".to_string(),
        hook_payload("SessionStart", "sess-x", None),
    );
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(
        sup.snapshot().await.unwrap().agents.is_empty(),
        "an unknown terminal created an agent"
    );
    assert!(
        sink.events().is_empty(),
        "an unknown terminal emitted telemetry"
    );
}

/// A malformed / unrecognised payload is dropped without creating anything.
#[tokio::test]
async fn a_garbage_payload_is_dropped() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    open_plain(&sup, &id).await;

    for bad in [
        &b"not json at all"[..],
        &b"{}"[..],
        &br#"{"hook_event_name":"Nope","session_id":"x"}"#[..],
        &br#"{"hook_event_name":"SessionStart"}"#[..], // no session_id
    ] {
        sup.deliver_hook(id.clone(), bad.to_vec());
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(
        snapshot_agent(&sup, &id).await.is_none(),
        "a garbage payload created an agent"
    );
}

/// **SessionEnd marks an ad-hoc agent `done`** — its `claude` ended, though the
/// shell lives on — and **unbinds**, so the next `claude` in that terminal is a
/// fresh root.
#[tokio::test]
async fn session_end_finishes_the_adhoc_agent_and_unbinds() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    open_plain(&sup, &id).await;

    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-1", None));
    wait_until_agent(&sup, &id, "idle root", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Idle)
            .unwrap_or(false)
    })
    .await;

    sup.deliver_hook(id.clone(), hook_payload("SessionEnd", "sess-1", None));
    wait_until_agent(&sup, &id, "the agent to finish", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Done)
            .unwrap_or(false)
    })
    .await;

    let node = snapshot_agent(&sup, &id).await.unwrap();
    assert_eq!(node.status, AgentStatus::Done);
    assert!(node.finished_at.is_some());
}

/// **Sequential `claude`s in one terminal each become a root**: SessionEnd
/// unbinds between them, so the second's SessionStart lands on an unbound terminal.
#[tokio::test]
async fn sequential_claudes_in_one_terminal_each_bind() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    open_plain(&sup, &id).await;

    // First claude.
    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-1", None));
    wait_until_agent(&sup, &id, "first idle", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Idle)
            .unwrap_or(false)
    })
    .await;
    sup.deliver_hook(id.clone(), hook_payload("SessionEnd", "sess-1", None));
    wait_until_agent(&sup, &id, "first done", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Done)
            .unwrap_or(false)
    })
    .await;

    // Second claude in the SAME terminal — must become a fresh idle root again.
    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-2", None));
    wait_until_agent(&sup, &id, "second idle", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Idle)
            .unwrap_or(false)
    })
    .await;

    // Still exactly one node for this terminal (one agent per terminal).
    let snap = sup.snapshot().await.unwrap();
    assert_eq!(snap.agents.iter().filter(|n| n.id == id).count(), 1);
}

/// A **stale** SessionEnd (for a session that already ended and was superseded)
/// must not unbind the *current* session — otherwise it could wrongly free a
/// terminal that a newer claude just bound.
#[tokio::test]
async fn a_stale_session_end_does_not_unbind_a_newer_session() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    open_plain(&sup, &id).await;

    // First session starts and ends.
    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-old", None));
    wait_until_agent(&sup, &id, "old running", |n| n.is_some()).await;
    sup.deliver_hook(id.clone(), hook_payload("SessionEnd", "sess-old", None));
    wait_until_agent(&sup, &id, "old done", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Done)
            .unwrap_or(false)
    })
    .await;

    // A NEW session binds the terminal (born idle, parked at its prompt).
    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-new", None));
    wait_until_agent(&sup, &id, "new idle", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Idle)
            .unwrap_or(false)
    })
    .await;

    // A duplicate/stale End for the OLD session arrives late. It must NOT finish
    // the new session (its binding is for sess-new, not sess-old).
    sup.deliver_hook(id.clone(), hook_payload("SessionEnd", "sess-old", None));
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(
        snapshot_agent(&sup, &id).await.unwrap().status,
        AgentStatus::Idle,
        "a stale SessionEnd wrongly finished the newer session"
    );
}

/// PTY child exit unbinds too (the half of "SessionEnd ∪ PTY exit" we own): after
/// the shell exits, a subsequent binding must be possible again. Here we close the
/// terminal (which unbinds) and confirm a fresh terminal with a new id binds.
#[tokio::test]
async fn closing_the_terminal_unbinds_it() {
    let (sup, _sink) =
        supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());
    let id = tid("term");
    open_plain(&sup, &id).await;
    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-1", None));
    wait_until_agent(&sup, &id, "running", |n| n.is_some()).await;

    // Close removes the agent + terminal + binding.
    sup.close(id.clone()).await.expect("close failed");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        snapshot_agent(&sup, &id).await.is_none(),
        "closed agent should be gone"
    );

    // A late SessionStart for the now-closed terminal is ignored (unknown terminal).
    sup.deliver_hook(id.clone(), hook_payload("SessionStart", "sess-2", None));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        snapshot_agent(&sup, &id).await.is_none(),
        "a closed terminal must not be resurrected by a late hook"
    );
}

/// POST `body` to a REAL listener the way the hook's `curl` does; returns the status
/// line. The body write is allowed to fail: a listener that refuses on the headers
/// closes the socket mid-upload, and the test must report that refusal, not panic.
async fn post_to_listener(base_url: &str, token: &str, terminal: &str, body: &[u8]) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port: u16 = base_url.rsplit(':').next().unwrap().parse().unwrap();
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect to the hook listener");
    let head = format!(
        "POST / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-AgentStudio-Token: {token}\r\n\
         X-AgentStudio-Terminal: {terminal}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let _ = stream.write_all(body).await;
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;
    String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

/// **A prompt past 64 KiB still turns the agent "running"** — end to end through
/// the production wiring: the REAL listener (as `lib.rs` wires it), the REAL
/// `ClaudeAdapter` parsing, and the supervisor's turn tracking.
///
/// A pasted query result of about 100 KB in the prompt: `UserPromptSubmit` carries
/// the whole prompt, so the hook POSTs a body past 100 KB. A 64 KiB listener cap
/// answered 400, the hook's `curl … || true` swallowed it, and the root stayed
/// `Idle` while it worked for minutes — the Village drew it idle
/// with "0 active". Every other turn-status test hands the payload to `deliver_hook`
/// directly, which is exactly why the listener's cap was never in their path.
#[tokio::test]
async fn a_prompt_past_64_kib_still_marks_the_root_running() {
    use agent_studio_scaffold_lib::agent::claude::ClaudeAdapter;
    use agent_studio_scaffold_lib::hook_listener::HookListener;

    // Its own folder: the real adapter installs its real hook settings into the cwd.
    let cwd = std::env::temp_dir().join(format!("agentstudio-bigprompt-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_str = cwd.to_string_lossy().into_owned();

    let (listener, config) = HookListener::bind().expect("bind the hook listener");
    let (sup, _sink) = supervisor_with_hook(Arc::new(ClaudeAdapter::new()), config.clone());
    let for_hooks = sup.clone();
    listener.serve(move |terminal_id, body| for_hooks.deliver_hook(terminal_id, body));

    let id = tid("term");
    let (_out, channel) = ChannelSink::new();
    let (program, args) = interactive_sh();
    sup.open_terminal(
        OpenSpec {
            terminal_id: id.clone(),
            program: Some(program),
            args,
            cwd: cwd_str.clone(),
            rows: 24,
            cols: 80,
        },
        channel,
    )
    .await
    .expect("terminal_open failed");

    let session = "01a151c3-0000-7000-8000-0000000000f6";
    let transcript = cwd.join(format!("{session}.jsonl"));
    let start = serde_json::json!({
        "session_id": session,
        "transcript_path": transcript,
        "cwd": cwd_str,
        "hook_event_name": "SessionStart",
        "source": "startup",
    });
    let status = post_to_listener(
        &config.base_url,
        &config.token,
        &id,
        &serde_json::to_vec(&start).unwrap(),
    )
    .await;
    assert!(status.contains("204"), "SessionStart refused: {status:?}");
    wait_until_agent(&sup, &id, "the idle root", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Idle)
            .unwrap_or(false)
    })
    .await;

    // The pasted query result: quotes, pipes and newlines, the way psql prints it.
    let mut prompt = String::from("Here is a query result\n\ndemo=> select * from widgets;\n");
    while prompt.len() < 100 * 1024 {
        prompt.push_str(
            " 000000000000000000000001 | 000000000000000000000002 | source:fixture | \
             2026-01-01 00:00:00+00 | t | {\"name\": \"TESTER\"}\n",
        );
    }
    let submit = serde_json::json!({
        "session_id": session,
        "transcript_path": transcript,
        "cwd": cwd_str,
        "permission_mode": "auto",
        "hook_event_name": "UserPromptSubmit",
        "prompt": prompt,
    });
    let body = serde_json::to_vec(&submit).unwrap();
    assert!(
        body.len() > 100 * 1024,
        "the payload must be past the old 64 KiB cap"
    );
    let status = post_to_listener(&config.base_url, &config.token, &id, &body).await;
    assert!(
        status.contains("204"),
        "a {}-byte UserPromptSubmit was refused: {status:?}",
        body.len()
    );
    wait_until_agent(&sup, &id, "the root to run its turn", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Running)
            .unwrap_or(false)
    })
    .await;

    // And the turn ends the same way it started: through the listener.
    let stop = serde_json::json!({
        "session_id": session,
        "transcript_path": transcript,
        "cwd": cwd_str,
        "hook_event_name": "Stop",
        "stop_hook_active": false,
    });
    let status = post_to_listener(
        &config.base_url,
        &config.token,
        &id,
        &serde_json::to_vec(&stop).unwrap(),
    )
    .await;
    assert!(status.contains("204"), "Stop refused: {status:?}");
    wait_until_agent(&sup, &id, "the root back at its prompt", |n| {
        n.as_ref()
            .map(|x| x.status == AgentStatus::Idle)
            .unwrap_or(false)
    })
    .await;

    std::fs::remove_dir_all(&cwd).ok();
}
