# Agents survive a restart — phase 1: every open agent comes back

**Status:** implemented. Phase 2 (a
background host that keeps agents RUNNING while the app is closed) is designed separately.
Builds on in-process PTY ownership, terminal re-attach and the pinned-agent restore.

**Requirement:** agents are sometimes still working when the window or the app is closed
(for example, to update). The app reopens with every agent that was open before (working or
idle), so the conversation with each can continue; phase 2 also keeps them running while the
app is closed.

## 1. What phase 1 does — and does not

- **Every root agent the app spawned comes back on the next launch**: ⚡ quick-launch, New
  agent, Recover session…, ↻ Resume — pinned or not, working or idle. Same agent id, so the
  center-layout restore (`layout-prefs.json`, keyed on that id) puts each in
  its own view, pane and tab, wearing its name.
- **Same conversation**: `claude --resume <session id>` (the resume ladder, §3).
- **It does NOT keep anything running.** The quit still kills the PTYs. An agent
  that was mid-turn was interrupted; it comes back at its prompt and says so (§4). Nothing is
  ever sent to an agent on the user's behalf — only the user can tell it to continue.
- **Out of scope for phase 1:**
  - **Plain consoles.** A shell has no conversation to resume; its tab slot is pruned as before.
  - **A `claude` typed by hand into a console** (an ad-hoc root). Its process is a
    child of the shell, not ours to re-launch, and it never enters the registry.
  - Sub-agents need nothing: they re-materialise from the resumed root's transcript.

## 2. The registry — `open-agents.json`

`src-tauri/src/open_agents.rs`. In the app-config dir next to `pinned-agents.json` — never
the repo, never `~/.claude` (the app never writes there). One entry per open root, in spawn order:
`{agentId, cwd, runtime, sessionId, wasWorking?}` (camelCase; `wasWorking` is
`#[serde(default)]`, so older files still load). Atomic writes through the writer `pinned_agents.rs`
shares (`write_json_atomic`: temp → fsync → rename). Missing/corrupt → empty, never an error.

**One writer** — the supervisor actor — behind one small API, `open_agents::Registry`:

| Event | Call | Effect |
|---|---|---|
| a root is spawned (incl. a restore re-launch) | `record` | upsert in place, `wasWorking` cleared (a new run) |
| the user closes it (`terminal_close`: tab ✕, row ✕, closed pane) | `remove` | gone for good |
| its OWN process ends (`/exit`, a crash) | `remove` | the user ended it |
| the app shuts down | `record_working` | ONE write: which agents were mid-turn |
| boot | `entries_to_restore(pins, already_running)` | open ∪ pins, once each, minus `already_running` |

Never per status tick. Renames are NOT here: an agent's name lives in the center layout —
one fact, one writer.

### The shutdown order

The flag that makes `remove` a no-op has exactly one setter, `ShutdownFlag::raise`, reached
through `SupervisorHandle::begin_shutdown` — raised synchronously (an `Arc<AtomicBool>`, no
message) and only then the actor is asked for the `record_working` write (budget 750 ms).
`lib.rs` calls it on the first of:

- the **main window's `Destroyed`** (not `CloseRequested` — a close request can be refused);
- **`RunEvent::ExitRequested`** (last window closed, `app.exit()`);
- **`RunEvent::Exit`** — on macOS **⌘Q only ever arrives as `Exit`** (tao 0.35 routes it
  through `applicationWillTerminate` → `LoopDestroyed`; no `ExitRequested`). Verified in the
  tao / tauri-runtime-wry sources, not assumed.

At each of those the PTYs are still alive (they die with the process), so no exit can be
mistaken for the user's. A **crash** removes nothing either: nothing runs to remove it — and
then `wasWorking` is honestly unknown (`null`).

**Phase-2 seam:** the registry and its flag move into the host; the host
raises the flag on "Stop all agents", never on the app quitting; the restore passes the ids
the host already runs as `already_running` (always empty in phase 1).

## 3. Restore — one restore for open agents and pins

`open_agents::restore_on_boot` (from `setup`) loads the pins and enqueues ONE
`SupervisorMsg::Restore { pins, already_running: ∅ }` — **synchronously, before the webview
exists**. The actor is a FIFO, so the frontend's first `fleet_snapshot` always contains every
restored agent (the old pinned restore spawned detached tasks and relied on winning that race).

`plan_restore` merges: open agents first (spawn order), then pins that are not open (a pinned
agent the user `/exit`ed still comes back — that is what a pin means). An agent in both is
restored once, from the **open** entry — written on every spawn, so its session id is current;
a pin's may predate a fresh-fallback. Pin semantics are unchanged: dismissing a pinned agent
still unpins it (frontend, `removeAgentFromForest`).

Per agent, `choose_rung` (the resume ladder):

1. **folder gone → dormant**: no spawn. An `error` root ("not reopened after the restart: its
   folder no longer exists: …") plus an EXITED terminal under the same id, so its tab is put
   back where it was and re-attach answers `exited`. Kept in the registry (the folder may be on
   an unmounted drive) until the user closes it — the ordinary `terminal_close` removes it.
2. **saved transcript → resume** (`--resume <id>`). Asked of the agent's ADAPTER
   (`locate_transcript`), so the supervisor knows no Claude paths.
3. **otherwise → fresh** `claude` in the same folder; the spawn's `record` stores the NEW
   session id, so the next launch resumes the new conversation.
4. A spawn the runtime refuses (binary missing, unknown runtime) → dormant with that reason.

An id already in the fleet is never spawned twice.

## 4. The "Resumed after restart" marker

Rust keeps one marker per restored agent (`restored_agents` command → `{agentId, outcome,
wasWorking}`, never a session id). Shown on the rail row (words, in the status line) and the
agent's tab (a `↻` glyph with the same tooltip — one copy module, `restoredMarker.ts`). The row's
words are kept SHORT so they never clip at the default rail width (a longer label clipped to
"Reopened after restart · new conversati…"); the full sentence lives in the tooltip:

| | label | tooltip |
|---|---|---|
| resumed, was working | ↻ Resumed · was working | …Agent Studio was closed while it was working — tell it to continue. |
| resumed, idle | ↻ Resumed | …It was idle when Agent Studio closed. |
| resumed, unknown (crash) | ↻ Resumed | …did not close cleanly, so it may have been working — if it was, tell it to continue. |
| fresh | ↻ Reopened · new chat | …its earlier conversation was never saved, so this is a new one. |
| dormant | ↻ Not reopened | Rust's reason + "Close it and it will not come back next time." |

It comes down at the agent's **next turn** (`running` — the user talked to it), at its **end**
(`exited`), or when it is **closed** — in Rust and in the store at the same moments, so a
webview reload re-reads the same truth. `waiting_input` / `idle` do not take it down.

The pin's tooltip says what a pin ADDS: *"Pin agent (it comes back on restart
even after it ends)"*.

## 5. Sub-agents first seen already ended

A resumed session's tailer re-reads sub-agents that ended long ago, so its FIRST sight of each
is `done`/`error`. `SubagentSpawned` carries no status and the UI creates the row `running` —
it read "running" forever. The supervisor now emits a `Status` right after `SubagentSpawned`
whenever the first-seen status is not `running`: no wire change, status keeps its one reducer,
and the boot buffer's replay of a spawn cannot regress a snapshot's `done`.

## 6. Known limits (said plainly)

- A process that ended on its own in the last instant before the quit, whose `ChildExited` was
  still queued when the flag went up, comes back once more. Harmless; closing it removes it.
- `lib.rs`'s window/run-event glue is not reachable by `cargo test` (it needs a real app); the
  ordering it relies on is tested at the supervisor (`begin_shutdown` then exit/close), and
  the Docker E2E below drives the real thing.
- Not covered by the automated tests: that `--resume` of a REAL transcript keeps the TUI
  interactive in our PTY. That needs a manual check with the real `claude`.

## 7. Docker E2E

Drive it with the stub `claude` (wdio.conf's `AGENTSTUDIO_CLAUDE_BIN` →
`e2e/fixtures/claude-stub.sh`):

1. Launch two agents (⚡) in the fixture workspace; put them in two views (or two panes) and
   rename one, so placement is part of the assertion.
2. **Make the resume rung reachable**: the restore only passes `--resume` when the adapter
   finds a transcript (`~/.claude/projects/<any>/<id>.jsonl` or `<id>/`). In the container's
   throwaway `HOME` (never a real one), create
   `$HOME/.claude/projects/agentstudio-e2e/<session-id>.jsonl` for ONE of the two agents, so the
   run covers both rungs: resumed and fresh.
3. `browser.reloadSession()` — tauri-driver restarts the app process; the app-config dir (in
   the container's `HOME`) persists, so does `open-agents.json`.
4. Assert: both agents' rows and tabs are back **in their own view/pane, with the rename**;
   the rows carry "Resumed · was working" / "Reopened · new chat"; and
   the stub was launched with `--resume <id>` for the one with a transcript and
   `--session-id <new>` for the other.
5. Then close one agent's tab, `reloadSession()` again → only the other comes back (the close
   removed it). Optional: type `/exit` into the stub's PTY → it does not come back.

**What the stub does:** it RECORDS its argv — each launch appends `"$@"` as one line to
`${TMPDIR:-/tmp}/agentstudio-e2e-claude-argv.log`. The spec reads the first launch's
`--session-id <uuid>` from it (the session id never crosses to the UI — by design), creates
the transcript for step 2, and after the restart asserts a line `--resume <that uuid>`. For
step 5's `/exit`, the stub reads its input a line at a time and exits 0 on `/exit` — it
still blocks, and still exits only when told.
