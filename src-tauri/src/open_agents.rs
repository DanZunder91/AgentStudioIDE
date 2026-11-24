//! Open agents come back after a restart — phase 1 of "agents survive a restart".
//!
//! Agents are sometimes still working when the window or the app is closed (for example to
//! update), so the app should reopen with every agent that was working before, and should
//! not kill the agents, so the conversations can continue. Both halves are planned:
//! **phase 1 (this module)** re-opens every agent that was open, in
//! its tab, on the same conversation (`claude --resume <session id>`); **phase 2** (a
//! background process so the agents keep RUNNING while the app is closed — a
//! daemon) is designed separately. Phase 1 does not keep a process alive: an agent that
//! was mid-turn when the app quit was interrupted, and it says so (see
//! [`RestoredAgent::was_working`]).
//!
//! **What comes back.** Every ROOT agent the supervisor SPAWNED (⚡ quick-launch, New
//! agent, Recover session…, ↻ Resume) — pinned or not, working or idle — under the same
//! agent id, so the center-layout restore (`layout-prefs.json`, keyed on that id) puts
//! it back in its own view, pane and tab. **Out of scope for phase 1:** plain consoles
//! (a shell has no conversation to resume) and a `claude` typed by hand into a console
//! (an ad-hoc root — its process is a child of the shell, not ours to
//! re-launch). Sub-agents need nothing: they re-materialise from the root's transcript.
//!
//! **The registry** is `open-agents.json` in the app-config dir — next to
//! `pinned-agents.json`, NEVER the repo and NEVER `~/.claude`. The
//! supervisor actor is its only writer (one fact, one writer), and
//! it writes only on:
//! - **spawn** — upsert `{agentId, cwd, runtime, sessionId}` (a restore that had to fall
//!   back to a fresh conversation records the NEW session id here, so the next launch
//!   resumes the new one, not the dead one);
//! - **the user closing the agent** (`terminal_close`: its tab ✕, the row ✕, a closed
//!   pane) — remove;
//! - **the agent's own process ending** (`/exit`, a crash) — remove: the user ended it;
//! - **the app shutting down** — ONE write recording which agents were working, so the
//!   next launch can say "it was interrupted" honestly. Never per status tick.
//!
//! **The shutdown rule.** When the app quits, the PTYs die with it — and those exits are
//! NOT the user ending their agents. So `lib.rs` raises the supervisor's shutting-down
//! flag on the main window's destruction / `RunEvent::ExitRequested` / `RunEvent::Exit`,
//! BEFORE anything can tear a PTY down; from then on neither a child exit nor a close
//! removes an entry. A crash never removes anything either: nothing runs to remove it.
//!
//! **No renames here.** An agent's name is persisted with the center layout
//! (`serializeCenterLayout`), keyed on the same agent id this registry restores — a
//! second copy here would be two writers for one fact.
//!
//! **The seam phase 2 plugs into.** All of the above sits
//! behind one small writer API, [`Registry`] — `record` / `remove` / `record_working` /
//! `entries_to_restore` — owned by exactly one party: the supervisor actor in phase 1,
//! the background host in phase 2. The shutting-down flag has exactly one setter,
//! [`ShutdownFlag::raise`] (phase 1: the app quitting, via
//! `SupervisorHandle::begin_shutdown`; phase 2: the host's "Stop all agents"). And
//! the restore takes the ids that are ALREADY RUNNING as an input — empty in phase 1,
//! the host's live agents in phase 2 — so nothing that survived is launched twice.
//!
//! **Testability.** A [`Registry`] is built on an EXPLICIT path ([`Registry::at`]) or
//! none at all ([`Registry::inert`] — never writes); the supervisor gets a path only from
//! `lib.rs`'s real boot (`spawn_supervisor_with_store`). `cargo test` never sees the real
//! config dir.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::pinned_agents::{self, PinnedAgent};
use crate::supervisor::SupervisorHandle;

/// File name inside the app-config dir.
pub const FILE_NAME: &str = "open-agents.json";

/// One open root agent — everything needed to re-launch it in place. camelCase on
/// disk, like `pinned-agents.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAgent {
    /// Our ULID; reused verbatim on restore — it is also the terminal id, which is the
    /// key the center layout persists the tab's place and name under.
    pub agent_id: String,
    /// Absolute cwd the agent was spawned in (after `resolve_cwd`).
    pub cwd: String,
    /// The `AgentAdapter` id (e.g. `"claude-code"`).
    pub runtime: String,
    /// The runtime's session id — the key to `claude --resume`. Internal: it never
    /// crosses to the frontend ([`RestoredAgent`] has no such field).
    pub session_id: String,
    /// Was it mid-turn (`running` / `waiting_input`) when the app last shut down
    /// cleanly? Written only by the shutdown write ([`record_working`]) and reset to
    /// `None` by every spawn, so after a crash it is honestly unknown. `#[serde(default)]`
    /// so a file written before the field existed still loads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was_working: Option<bool>,
}

/// The rung of the restore ladder an agent came back on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreOutcome {
    /// `--resume <session id>`: the same conversation.
    Resumed,
    /// No saved conversation to resume (it never got a transcript) — a NEW `claude` in
    /// the same folder, same tab.
    Fresh,
    /// Not re-launched: its folder is gone, or the runtime refused to start. Shown as
    /// an ended row + tab saying why, kept in the registry until the user closes it.
    Dormant,
}

/// What the frontend's "Resumed after restart" marker is drawn from — one per agent
/// the boot restore brought back, until that agent's next turn (or its end).
///
/// Frontend contract: `invoke<RestoredAgent[]>('restored_agents')`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredAgent {
    pub agent_id: String,
    pub outcome: RestoreOutcome,
    /// `Some(true)`: it was working when Agent Studio closed — the quit interrupted it,
    /// and only the user can tell it to continue (we never send a message on their
    /// behalf). `None`: the app did not shut down cleanly, so nobody knows.
    pub was_working: Option<bool>,
}

/// "The app is shutting down": once raised, the registry forgets nothing — every exit
/// from then on is the quit's doing, not the user ending an agent. Shared (an `Arc`)
/// between the registry that reads it and the code that may raise it, so raising it is
/// immediate and needs no message: it must hold BEFORE the next exit is handled.
#[derive(Debug, Clone, Default)]
pub struct ShutdownFlag(Arc<AtomicBool>);

impl ShutdownFlag {
    /// THE one place the flag is set. Returns whether this call raised it (`false`:
    /// it was already up — one quit can announce itself three times).
    pub fn raise(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    pub fn is_raised(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The open-agents registry: ONE writer (the supervisor actor in phase 1, the host in
/// phase 2) and the whole of what it may do. Cheap to clone, but only the owner should
/// hold one — anyone else gets the [`ShutdownFlag`] alone.
#[derive(Debug, Clone, Default)]
pub struct Registry {
    /// `None` → inert: reads see nothing and writes do nothing (every test supervisor,
    /// any headless use).
    path: Option<PathBuf>,
    shutdown: ShutdownFlag,
}

impl Registry {
    /// A registry that never touches disk.
    pub fn inert() -> Self {
        Self::default()
    }

    /// The registry stored at `path` (explicit, so tests point it at a temp dir).
    pub fn at(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            shutdown: ShutdownFlag::default(),
        }
    }

    /// The flag this registry obeys — handed to the code that announces the shutdown.
    pub fn shutdown_flag(&self) -> ShutdownFlag {
        self.shutdown.clone()
    }

    /// A root was spawned (or re-launched): it comes back next launch. See
    /// [`record_spawn`].
    pub fn record(&self, entry: OpenAgent) -> std::io::Result<()> {
        match &self.path {
            Some(path) => record_spawn(path, entry),
            None => Ok(()),
        }
    }

    /// The user ended `agent_id` (closed it, or its own process ended): it does not come
    /// back. A no-op once the shutdown flag is up — and for an id that was never
    /// recorded (a plain console: one read, no write). Returns whether it was removed.
    pub fn remove(&self, agent_id: &str) -> bool {
        if self.shutdown.is_raised() {
            return false;
        }
        self.path
            .as_deref()
            .is_some_and(|path| forget(path, agent_id))
    }

    /// The shutdown stamp: which agents the quit is interrupting. See [`record_working`].
    pub fn record_working(&self, working: &HashMap<String, bool>) -> bool {
        self.path
            .as_deref()
            .is_some_and(|path| record_working(path, working))
    }

    /// What to re-open: the open entries and the pins, once each ([`plan_restore`]),
    /// minus every id in `already_running` (empty in phase 1; the host's live agents in
    /// phase 2 — an agent that survived must not be launched a second time).
    pub fn entries_to_restore(
        &self,
        pins: &[PinnedAgent],
        already_running: &HashSet<String>,
    ) -> Vec<OpenAgent> {
        let open = self.path.as_deref().map(load).unwrap_or_default();
        plan_restore(&open, pins, already_running)
    }
}

/// Load the registry, in insertion (spawn) order. **Any** failure — missing, unreadable,
/// corrupt, wrong shape — yields an empty list: a bad store must never break startup.
/// A duplicated id (a hand-edit) keeps its first occurrence.
pub fn load(path: &Path) -> Vec<OpenAgent> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut list = serde_json::from_str::<Vec<OpenAgent>>(&text).unwrap_or_default();
    let mut seen = HashSet::new();
    list.retain(|a| seen.insert(a.agent_id.clone()));
    list
}

/// Record a spawn: refresh an existing entry IN PLACE (its position is its restore
/// order) or append a new one. Clears `was_working` — that is a fact about the LAST
/// shutdown, and this process is a new run.
fn record_spawn(path: &Path, entry: OpenAgent) -> std::io::Result<()> {
    let _guard = crate::store_file::lock(path); // load → edit → save, one transaction
    let mut list = load(path);
    let entry = OpenAgent {
        was_working: None,
        ..entry
    };
    match list.iter_mut().find(|a| a.agent_id == entry.agent_id) {
        Some(existing) => *existing = entry,
        None => list.push(entry),
    }
    pinned_agents::write_json_atomic(path, &list)
}

/// Drop `agent_id` (the user closed it, or its own process ended). Writes only when
/// something was removed — a plain console or an ad-hoc root closing costs one read and
/// no write. Returns whether an entry was removed.
fn forget(path: &Path, agent_id: &str) -> bool {
    let _guard = crate::store_file::lock(path); // load → edit → save, one transaction
    let mut list = load(path);
    let before = list.len();
    list.retain(|a| a.agent_id != agent_id);
    list.len() != before && pinned_agents::write_json_atomic(path, &list).is_ok()
}

/// The shutdown write: stamp `was_working` on every entry the live fleet reports on
/// (`working[agent_id]`). Entries the fleet does not know (an agent whose restore
/// failed) keep what they had. Writes only when a value changed; returns whether it did.
fn record_working(path: &Path, working: &HashMap<String, bool>) -> bool {
    let _guard = crate::store_file::lock(path); // load → edit → save, one transaction
    let mut list = load(path);
    let mut changed = false;
    for entry in &mut list {
        if let Some(&w) = working.get(&entry.agent_id) {
            if entry.was_working != Some(w) {
                entry.was_working = Some(w);
                changed = true;
            }
        }
    }
    changed && pinned_agents::write_json_atomic(path, &list).is_ok()
}

/// Merge the two registries into ONE restore list — one entry per agent id.
///
/// Open agents first, in spawn order; then pins that are not open (a pinned agent the
/// user ended with `/exit` still comes back — that is what a pin means). An
/// agent in both is restored ONCE, from the open entry: it is written on every spawn,
/// so its session id is the current one, where a pin's is whatever it was when the
/// user pinned (a fresh-fallback restore minted a new one since). An id in
/// `already_running` is left out entirely (phase 2: the host kept it alive).
pub fn plan_restore(
    open: &[OpenAgent],
    pins: &[PinnedAgent],
    already_running: &HashSet<String>,
) -> Vec<OpenAgent> {
    let mut seen: HashSet<&str> = already_running.iter().map(String::as_str).collect();
    let mut plan = Vec::with_capacity(open.len() + pins.len());
    for a in open {
        if seen.insert(a.agent_id.as_str()) {
            plan.push(a.clone());
        }
    }
    for p in pins {
        if seen.insert(p.agent_id.as_str()) {
            plan.push(OpenAgent {
                agent_id: p.agent_id.clone(),
                cwd: p.cwd.clone(),
                runtime: p.runtime.clone(),
                session_id: p.session_id.clone(),
                was_working: None,
            });
        }
    }
    plan
}

/// The restore ladder for one agent, as a pure decision: the folder is gone → dormant
/// (a PTY cannot start in a missing dir, and silently dropping the agent would lose it);
/// a saved conversation exists → resume it; otherwise → a fresh `claude` in the same
/// folder (`claude --resume` errors on an id with no transcript).
pub fn choose_rung(cwd_exists: bool, transcript_exists: bool) -> RestoreOutcome {
    if !cwd_exists {
        RestoreOutcome::Dormant
    } else if transcript_exists {
        RestoreOutcome::Resumed
    } else {
        RestoreOutcome::Fresh
    }
}

/// The registry's real path (app-config dir, never the repo, never `~/.claude`).
pub(crate) fn store_path(app: &tauri::AppHandle) -> PathBuf {
    pinned_agents::config_file(app, FILE_NAME)
}

// ── Boot + command glue (thin; the logic above and in the supervisor is tested) ────

/// Re-open every agent from the last session. Called ONCE from `lib.rs`'s `setup`, a
/// path `cargo test` never runs, so reading the real stores here is safe.
///
/// The restore is ENQUEUED, synchronously, as one supervisor message — before the
/// webview exists, so before any `fleet_snapshot` it could send. The actor is a FIFO,
/// so the frontend's first snapshot always contains every restored agent and the
/// layout restore can put each back in its pane. (The old pinned restore spawned
/// detached tasks and relied on winning that race.) The actor — the registry's one
/// owner — reads the open entries itself and runs the ladder, where the adapter that
/// knows how to find a transcript lives. Nothing is already running in phase 1.
pub fn restore_on_boot(app: &tauri::AppHandle, supervisor: &SupervisorHandle) {
    let pins = pinned_agents::load(&pinned_agents::store_path(app));
    if let Err(e) = supervisor.restore(pins, HashSet::new()) {
        eprintln!("open-agents: restore not started (non-fatal): {e}");
    }
}

/// The agents the boot restore brought back, for the "Resumed after restart" marker.
/// An agent leaves the list at its next turn, when it ends, or when it is closed — so a
/// webview reload re-reads the truth rather than resurrecting a stale marker.
///
/// Frontend contract: `invoke<RestoredAgent[]>('restored_agents')`.
#[tauri::command]
pub async fn restored_agents(
    supervisor: tauri::State<'_, SupervisorHandle>,
) -> Result<Vec<RestoredAgent>, String> {
    supervisor.restored_agents().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp dir that cleans itself up, plus the store path inside it.
    struct Fixture {
        dir: std::path::PathBuf,
        store: std::path::PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("agentstudio-open-{label}-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&dir).unwrap();
            let store = dir.join(FILE_NAME);
            Self { dir, store }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn open(id: &str, session: &str) -> OpenAgent {
        OpenAgent {
            agent_id: id.into(),
            cwd: format!("/w/{id}"),
            runtime: "claude-code".into(),
            session_id: session.into(),
            was_working: None,
        }
    }

    fn pin(id: &str, session: &str) -> PinnedAgent {
        PinnedAgent {
            agent_id: id.into(),
            cwd: format!("/pinned/{id}"),
            runtime: "claude-code".into(),
            session_id: session.into(),
            custom_title: None,
            order: 0,
        }
    }

    fn ids(list: &[OpenAgent]) -> Vec<&str> {
        list.iter().map(|a| a.agent_id.as_str()).collect()
    }

    #[test]
    fn record_spawn_round_trips_every_field_and_keeps_spawn_order() {
        let f = Fixture::new("roundtrip");
        record_spawn(&f.store, open("a", "s-a")).unwrap();
        record_spawn(&f.store, open("b", "s-b")).unwrap();
        let list = load(&f.store);
        assert_eq!(ids(&list), vec!["a", "b"]);
        assert_eq!(list[0], open("a", "s-a"));
        assert_eq!(list[1].cwd, "/w/b");
        assert_eq!(list[1].runtime, "claude-code");
        assert_eq!(list[1].session_id, "s-b");
    }

    /// A restore that fell back to a fresh conversation re-spawns under the SAME agent
    /// id with a NEW session id: the entry must be refreshed in place (keeping its
    /// position) — never duplicated, never left pointing at the dead session.
    #[test]
    fn a_re_spawn_refreshes_in_place_and_clears_the_shutdown_stamp() {
        let f = Fixture::new("respawn");
        record_spawn(&f.store, open("a", "old")).unwrap();
        record_spawn(&f.store, open("b", "s-b")).unwrap();
        record_working(&f.store, &HashMap::from([("a".to_string(), true)]));
        assert_eq!(load(&f.store)[0].was_working, Some(true));

        // `was_working` on the incoming entry is ignored: a spawn is a new run.
        let mut again = open("a", "new");
        again.was_working = Some(true);
        record_spawn(&f.store, again).unwrap();

        let list = load(&f.store);
        assert_eq!(ids(&list), vec!["a", "b"], "same position, no duplicate");
        assert_eq!(list[0].session_id, "new");
        assert_eq!(list[0].was_working, None, "a new run knows nothing yet");
    }

    #[test]
    fn forget_removes_only_that_agent_and_says_whether_it_did() {
        let f = Fixture::new("forget");
        record_spawn(&f.store, open("a", "s-a")).unwrap();
        record_spawn(&f.store, open("b", "s-b")).unwrap();
        assert!(forget(&f.store, "a"));
        assert_eq!(ids(&load(&f.store)), vec!["b"]);
        assert!(!forget(&f.store, "a"), "already gone");
        assert!(!forget(&f.store, "plain-console"), "never registered");
        assert_eq!(ids(&load(&f.store)), vec!["b"]);
    }

    /// `forget` on an id that is not there must not WRITE: a plain console closing is
    /// the common case, and a write per close would also re-create a deleted store.
    #[test]
    fn forget_of_an_unknown_id_does_not_write_the_file() {
        let f = Fixture::new("forget-nowrite");
        assert!(!forget(&f.store, "x"));
        assert!(!f.store.exists(), "no store was created for a no-op");
    }

    #[test]
    fn record_working_stamps_known_entries_and_leaves_the_rest() {
        let f = Fixture::new("working");
        record_spawn(&f.store, open("busy", "s1")).unwrap();
        record_spawn(&f.store, open("idle", "s2")).unwrap();
        record_spawn(&f.store, open("failed-restore", "s3")).unwrap();
        let working = HashMap::from([("busy".to_string(), true), ("idle".to_string(), false)]);
        assert!(record_working(&f.store, &working));
        let list = load(&f.store);
        assert_eq!(list[0].was_working, Some(true));
        assert_eq!(list[1].was_working, Some(false));
        assert_eq!(list[2].was_working, None, "not in the fleet: untouched");
        // Same facts again: nothing changed, so nothing is written.
        assert!(!record_working(&f.store, &working));
    }

    #[test]
    fn missing_corrupt_or_wrong_shape_loads_as_empty() {
        let f = Fixture::new("corrupt");
        assert!(load(&f.store).is_empty(), "missing");
        for junk in [
            "{ not json",
            "42",
            "",
            "null",
            "[1,2]",
            "{\"agentId\":\"x\"}",
        ] {
            std::fs::write(&f.store, junk).unwrap();
            assert!(load(&f.store).is_empty(), "{junk:?} must read as empty");
        }
    }

    /// A file written before `wasWorking` existed (or by a crash-only history) loads.
    #[test]
    fn an_entry_without_was_working_loads_and_a_duplicate_id_keeps_the_first() {
        let f = Fixture::new("legacy");
        std::fs::write(
            &f.store,
            r#"[{"agentId":"a","cwd":"/w/a","runtime":"claude-code","sessionId":"s1"},
                {"agentId":"a","cwd":"/w/other","runtime":"claude-code","sessionId":"s2"}]"#,
        )
        .unwrap();
        let list = load(&f.store);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].cwd, "/w/a");
        assert_eq!(list[0].was_working, None);
    }

    #[test]
    fn the_file_is_camel_case_and_omits_an_unknown_working_state() {
        let f = Fixture::new("wire");
        record_spawn(&f.store, open("a", "s1")).unwrap();
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("\"agentId\"") && text.contains("\"sessionId\""),
            "{text}"
        );
        assert!(!text.contains("wasWorking"), "unknown is omitted: {text}");
        record_working(&f.store, &HashMap::from([("a".to_string(), false)]));
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(text.contains("\"wasWorking\": false"), "{text}");
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temp_file() {
        let f = Fixture::new("atomic");
        record_spawn(&f.store, open("a", "s1")).unwrap();
        forget(&f.store, "a");
        let leftovers: Vec<_> = std::fs::read_dir(&f.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind: {leftovers:?}");
    }

    // ── the merge with pins ──────────────────────────────────────────────────

    #[test]
    fn plan_restores_each_agent_once_open_first_then_pins_not_open() {
        let open_list = vec![open("o1", "s-o1"), open("both", "s-current")];
        let pins = vec![pin("p1", "s-p1"), pin("both", "s-stale-pin")];
        let plan = plan_restore(&open_list, &pins, &HashSet::new());
        assert_eq!(
            ids(&plan),
            vec!["o1", "both", "p1"],
            "one restore per agent"
        );
        // The open entry wins for an agent in both: it has the current session id.
        assert_eq!(plan[1].session_id, "s-current");
        assert_eq!(plan[1].cwd, "/w/both");
        // A pin-only agent is carried over field for field.
        assert_eq!(plan[2].cwd, "/pinned/p1");
        assert_eq!(plan[2].session_id, "s-p1");
        assert_eq!(plan[2].runtime, "claude-code");
    }

    #[test]
    fn plan_keeps_the_shutdown_stamp_and_dedupes_within_one_list() {
        let mut busy = open("a", "s1");
        busy.was_working = Some(true);
        let plan = plan_restore(
            &[busy, open("a", "dup")],
            &[pin("p", "sp"), pin("p", "dup")],
            &HashSet::new(),
        );
        assert_eq!(ids(&plan), vec!["a", "p"]);
        assert_eq!(plan[0].was_working, Some(true));
        assert_eq!(plan[0].session_id, "s1");
        assert_eq!(plan[1].session_id, "sp");
        assert_eq!(
            plan[1].was_working, None,
            "a pin knows nothing about the last run"
        );
    }

    #[test]
    fn plan_of_nothing_is_nothing() {
        assert!(plan_restore(&[], &[], &HashSet::new()).is_empty());
    }

    /// Phase 2's seam: an agent the host kept alive is not launched a second time —
    /// whether the registry, a pin, or both name it.
    #[test]
    fn plan_leaves_out_every_agent_already_running() {
        let running = HashSet::from(["both".to_string(), "open-only".to_string()]);
        let plan = plan_restore(
            &[
                open("open-only", "s1"),
                open("both", "s2"),
                open("down", "s3"),
            ],
            &[pin("both", "s4"), pin("pin-only", "s5")],
            &running,
        );
        assert_eq!(ids(&plan), vec!["down", "pin-only"]);
    }

    // ── the writer API (`Registry`) and its one flag ─────────────────────────

    #[test]
    fn the_flag_has_one_setter_and_says_who_raised_it() {
        let flag = ShutdownFlag::default();
        assert!(!flag.is_raised());
        assert!(flag.raise(), "the first raise");
        assert!(!flag.raise(), "one quit, announced again");
        assert!(flag.is_raised());
    }

    /// The ordering guarantee at its smallest: the same `remove` drops the entry while
    /// the app runs, and does nothing once the flag (shared, not copied) is up.
    #[test]
    fn remove_forgets_while_running_and_nothing_once_shutting_down() {
        let f = Fixture::new("registry-remove");
        let reg = Registry::at(f.store.clone());
        reg.record(open("a", "s-a")).unwrap();
        reg.record(open("b", "s-b")).unwrap();

        assert!(reg.remove("a"));
        assert_eq!(ids(&load(&f.store)), vec!["b"], "running: forgotten");

        assert!(
            reg.shutdown_flag().raise(),
            "raised through a handed-out copy"
        );
        assert!(!reg.remove("b"));
        assert_eq!(ids(&load(&f.store)), vec!["b"], "quitting: kept");
        // …but the shutdown stamp is still written: it IS the shutdown's write.
        assert!(reg.record_working(&HashMap::from([("b".to_string(), true)])));
        assert_eq!(load(&f.store)[0].was_working, Some(true));
    }

    #[test]
    fn entries_to_restore_reads_the_store_and_merges_the_pins() {
        let f = Fixture::new("registry-restore");
        let reg = Registry::at(f.store.clone());
        reg.record(open("o", "s-o")).unwrap();
        let plan = reg.entries_to_restore(&[pin("p", "s-p")], &HashSet::new());
        assert_eq!(ids(&plan), vec!["o", "p"]);
    }

    /// An inert registry (no path) is what every test supervisor gets: it reads nothing,
    /// writes nothing, and still restores pins handed to it.
    #[test]
    fn an_inert_registry_never_touches_disk() {
        let reg = Registry::inert();
        reg.record(open("a", "s")).unwrap();
        assert!(!reg.remove("a"));
        assert!(!reg.record_working(&HashMap::from([("a".to_string(), true)])));
        let plan = reg.entries_to_restore(&[pin("p", "s-p")], &HashSet::new());
        assert_eq!(ids(&plan), vec!["p"]);
    }

    #[test]
    fn the_ladder_resumes_then_falls_back_fresh_then_dormant() {
        assert_eq!(choose_rung(true, true), RestoreOutcome::Resumed);
        assert_eq!(choose_rung(true, false), RestoreOutcome::Fresh);
        // A missing folder wins over a saved transcript: nothing can start there.
        assert_eq!(choose_rung(false, true), RestoreOutcome::Dormant);
        assert_eq!(choose_rung(false, false), RestoreOutcome::Dormant);
    }

    #[test]
    fn the_marker_view_is_camel_case_and_never_carries_a_session_id() {
        let v = RestoredAgent {
            agent_id: "a".into(),
            outcome: RestoreOutcome::Resumed,
            was_working: Some(true),
        };
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(
            json,
            r#"{"agentId":"a","outcome":"resumed","wasWorking":true}"#
        );
        let unknown = RestoredAgent {
            agent_id: "b".into(),
            outcome: RestoreOutcome::Dormant,
            was_working: None,
        };
        assert_eq!(
            serde_json::to_string(&unknown).unwrap(),
            r#"{"agentId":"b","outcome":"dormant","wasWorking":null}"#
        );
        assert_eq!(
            serde_json::to_string(&RestoreOutcome::Fresh).unwrap(),
            r#""fresh""#
        );
    }
}
