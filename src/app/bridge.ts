/**
 * The bridge — Rust telemetry → the store (ARCHITECTURE §1 cold plane, §4).
 *
 * `agent://event` carries one tagged `AgentEvent`; this module is the only
 * subscriber, and it does nothing but hand each payload to one reducer. Per ARCHITECTURE §4
 * the store is written **imperatively from these callbacks**: `getState()`, no
 * Provider, no hook, no React in the path at all.
 *
 * What is deliberately absent: any decision-making. If a branch belongs
 * anywhere, it belongs in the reducer, where it is testable without a Tauri
 * runtime. This file is plumbing, and should stay boring enough to read in one
 * sitting.
 *
 * (`fs://change` lands with the right rail; the same shape will apply.)
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  defaultWorkspace,
  ensureAgentHooks,
  fleetSnapshot,
  pinnedAgents,
  pushRecentProject,
  recentProjects,
  restoredAgents,
} from "../features/fleet/fleetIpc";
import { logAgentEvent, logWarn } from "../features/logs/logStore";
import { noteAgentExited } from "../features/terminal/TerminalRegistry";
import { loadLayoutPrefs, type PersistedPane, type PersistedView } from "./layoutPrefsIpc";
import { useAppStore, workspaceRoots } from "./store";
import { heldTerminalIds } from "./tearoff/contract";
import { tearoffHoldings } from "./tearoff/ipc";
import { asTerminalId, type AgentEvent, type AgentId } from "./types";

export const AGENT_EVENT = "agent://event";

/**
 * Folders already registered as recent projects this session — the dedup key so a
 * chatty telemetry stream registers each folder once.
 */
const registeredRoots = new Set<string>();

/** Shared best-effort swallow — registering a root must never break telemetry. */
const noop = (): void => {};

/**
 * Register every Files-panel root (an agent's cwd, or a manually-opened browse root)
 * as a recent project, so `read_dir`'s scope (`allowed_roots` = recents ∪ workspace)
 * admits it — otherwise an **ad-hoc** agent's folder shows "Can't read this folder."
 * in the tree, since only ⚡-launched agents and browse roots were being registered.
 * Also (re)installs the ad-hoc hook there. Idempotent + best-effort — a failure must
 * never take telemetry down.
 */
function registerFleetRoots(): void {
  const s = useAppStore.getState();
  const roots = workspaceRoots(s);
  // Keep the shared folder order complete: any newly-visible folder is appended so
  // both rails have a total order to sort by. Idempotent + no-op when
  // nothing is new, so it is safe on every telemetry tick.
  s.workspaceActions.syncFolderOrder(roots);
  const fresh = roots.filter((root) => !registeredRoots.has(root));
  if (fresh.length === 0) return;
  for (const root of fresh) registeredRoots.add(root);
  // Record each on the Rust side (that is what widens `allowed_roots`), then refresh
  // the store's recents ONCE the pushes settle (drives ⚡ + the scope selector). All
  // best-effort; a failure must never take telemetry down.
  for (const root of fresh) void ensureAgentHooks(root).catch(noop);
  void Promise.all(fresh.map((root) => pushRecentProject(root).catch(noop)))
    .then(() => recentProjects())
    .then((list) => s.workspaceActions.setRecentProjects(list))
    .catch(noop);
}

/** Everything needed to shut the bridge down — see `startBridge`. */
export interface Bridge {
  stop: () => void;
}

/**
 * Subscribe to telemetry and paint the initial fleet.
 *
 * ── Order is load-bearing ────────────────────────────────────────────────────
 * Listen FIRST, snapshot SECOND, and buffer anything that arrives in between.
 *
 * The obvious order (snapshot, then listen) drops every event in the gap — an
 * agent that exits while the snapshot is in flight stays "running" forever. But
 * naively listening first is just as wrong in the other direction: the snapshot
 * resolves with state older than the events already applied, and upserting it
 * would resurrect a dead agent.
 *
 * So: buffer live events until the snapshot has been applied, then replay them
 * in arrival order. The snapshot is the floor; the buffer is what happened
 * after it was taken. Both are needed, and only this order gives both.
 */
export async function startBridge(): Promise<Bridge> {
  const { agentActions, layoutActions, workspaceActions } = useAppStore.getState();

  // Resolve the project root Rust picked (git-root-of-launch, else home) and
  // point new agents/terminals at it. Its own try/catch: a failure here must
  // not take telemetry down — new terminals just fall back to the app cwd.
  try {
    const root = await defaultWorkspace();
    workspaceActions.setWorkspaceRoot(root);
    // Install the ad-hoc-detection hook for the boot workspace root, so
    // a `claude` typed in a terminal opened here is detected even in a subdirectory
    // the user `cd`s into. Best-effort — a failure must never take telemetry down.
    void ensureAgentHooks(root).catch(noop);
  } catch (error) {
    console.error("default_workspace failed; new terminals use the app cwd", error);
    logWarn("bridge", "default_workspace failed; new terminals use the app cwd", String(error));
  }

  // Recent projects seed the ⚡ quick-launch and the rail's folder ordering.
  // Independent try/catch: a missing recents list must not stop startup.
  try {
    workspaceActions.setRecentProjects(await recentProjects());
  } catch (error) {
    console.error("recent_projects failed; quick-launch falls back to the workspace root", error);
    logWarn("bridge", "recent_projects failed; quick-launch falls back to the workspace root", String(error));
  }

  // Seed the persisted layout prefs. `loadLayoutPrefs()` yields empty prefs on any
  // failure (never throws), so boot never breaks on a bad store — no try/catch
  // needed. Before the snapshot for BOTH halves:
  //   - the rail prefs (folder order + collapse state), so `syncFolderOrder` appends onto the
  //     restored folder order rather than a blank one;
  //   - the center layout, so the views and their pane arrangement are back
  //     BEFORE `rebuildTerminalTabs` has terminals to place into them. Reversed,
  //     every restored agent lands in the boot view and the arrangement is lost —
  //     which is exactly the bug this call fixes.
  const prefs = await loadLayoutPrefs();
  workspaceActions.applyLayoutPrefs(prefs);
  layoutActions.applyCenterLayout(prefs);

  let ready = false;
  const pending: AgentEvent[] = [];

  const unlisten: UnlistenFn = await listen<AgentEvent>(AGENT_EVENT, (event) => {
    if (!ready) {
      pending.push(event.payload);
      return;
    }
    agentActions.applyAgentEvent(event.payload);
    logAgentEvent(event.payload);
    onTerminalSideOf(event.payload);
    registerFleetRoots();
  });

  try {
    const snapshot = await fleetSnapshot();
    agentActions.applyFleetSnapshot(snapshot.agents);
    registerFleetRoots();
    // Rebuild a tab for every live/exited terminal the supervisor still holds.
    // On a fresh launch `terminals` is empty (no-op); on a webview reload this
    // is what puts the agents' terminals back and lets `selectAgent` find them.
    // Agents first so agent-terminal tabs bind to an agent that already exists.
    //
    // EXCEPT the ones a detached window holds (tab tear-off): they are on screen
    // there, and re-attaching one here would swap its PTY stream into this window and
    // leave that one frozen. `tearoffHoldings` never throws — no holdings, no filter.
    const elsewhere = heldTerminalIds(await tearoffHoldings());
    // Their NAMES, though, are still this window's to keep: it alone writes them to disk,
    // and the blob it saved last carries them (`serializeCenterLayout`'s parked agents).
    // Back onto the agent rows now — the rebuild that would restore them skips these.
    keepHeldAgentNames(prefs.views ?? [], elsewhere);
    layoutActions.rebuildTerminalTabs(snapshot.terminals.filter((t) => !elsewhere.has(t.id)));

    // Reconcile the persisted pin registry on top of the snapshot.
    // Rust auto-spawns pinned roots on boot, so they arrive above as normal rows
    // + live PTYs and re-attach with zero pin-specific code; this last step just
    // flags which of those rows are pinned, so they show their persistent signal.
    // `pinnedAgents()` yields [] on failure, so a missing/broken registry never
    // takes boot down. After the snapshot so the rows exist to be flagged.
    agentActions.applyPinnedAgents(await pinnedAgents());
    // …and mark the agents the boot restore brought back ("Resumed after restart",
    // open_agents.rs). Every open agent of the last session was re-spawned by Rust
    // BEFORE this snapshot was answered, so they all arrived above and the layout
    // restore already put each in its tab; this only labels them. `restoredAgents()`
    // yields [] on failure — a missing marker never takes boot down.
    agentActions.applyRestoredAgents(await restoredAgents());
  } catch (error) {
    // A missing/failed snapshot must not take the telemetry stream down with
    // it: live events still describe a usable fleet, and Rust may simply not
    // implement the command yet. Surface it, keep listening.
    console.error("fleet_snapshot failed; continuing on live telemetry", error);
    logWarn("bridge", "fleet_snapshot failed; continuing on live telemetry", String(error));
  } finally {
    // Flush in arrival order, then switch to the direct path. In `finally` so a
    // failed snapshot cannot strand the buffer and silently freeze the rail.
    ready = true;
    for (const event of pending) {
      agentActions.applyAgentEvent(event);
      logAgentEvent(event);
      onTerminalSideOf(event);
    }
    pending.length = 0;
    registerFleetRoots();
  }

  return { stop: unlisten };
}

/**
 * The terminal half of an agent event. An agent's id IS its terminal's id (agent
 * PTYs and ad-hoc roots alike), so an `exited` agent un-sticks that terminal — see
 * `noteAgentExited` (without it, a killed `claude` froze the tab).
 */
export function onTerminalSideOf(event: AgentEvent): void {
  if (event.t === "exited") noteAgentExited(asTerminalId(event.agentId), event.code);
}

/**
 * Put the persisted names of the agents a detached window holds back on their rows — the
 * half of the restore `rebuildTerminalTabs` would have done for them, had it rebuilt them.
 * A row that already has a name, a terminal no window holds and an agent that did not come
 * back are all left alone. Plain state, no effect: the layout must not be saved mid-boot.
 */
function keepHeldAgentNames(views: readonly PersistedView[], held: ReadonlySet<string>): void {
  const names = new Map<string, string>();
  const walk = (node: PersistedPane): void => {
    if (node.type === "split") {
      node.children.forEach(walk);
      return;
    }
    for (const t of node.terminals) {
      if (t.customTitle !== null && held.has(t.terminalId)) names.set(t.terminalId, t.customTitle);
    }
  };
  for (const view of views) walk(view.layout);
  if (names.size === 0) return;
  useAppStore.setState((s) => {
    for (const [id, name] of names) {
      const agent = s.agents[id as AgentId];
      if (agent && !agent.customTitle) agent.customTitle = name;
    }
  });
}
