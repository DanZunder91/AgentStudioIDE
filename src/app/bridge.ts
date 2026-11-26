/** Rust telemetry to the store (ARCHITECTURE §1, §4): the only `agent://event` subscriber, written
 * imperatively via `getState()`, no React. Pure plumbing: any decision belongs in a reducer. */

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

/** Folders already registered as recent projects this session, so each registers once. */
const registeredRoots = new Set<string>();

/** Shared best-effort swallow — registering a root must never break telemetry. */
const noop = (): void => {};

/** Register every Files-panel root as a recent project so `read_dir`'s scope (`allowed_roots` =
 * recents ∪ workspace) admits an ad-hoc agent's folder; also (re)installs the ad-hoc hook there.
 * Idempotent and best-effort: a failure must never take telemetry down. */
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

/** Subscribe to telemetry and paint the initial fleet. Order is load-bearing: listen, snapshot,
 * buffering events between and replaying them after the snapshot is applied; otherwise an event is
 * lost (snapshot first) or stale snapshot state resurrects a dead agent (no buffer). */
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

  // Load layout prefs (never throws) before the snapshot: `syncFolderOrder` must append onto the
  // restored folder order, and views must exist before `rebuildTerminalTabs` places terminals,
  // or every restored agent lands in the boot view.
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
    // A tab per terminal the supervisor holds (a webview reload); agents first so tabs bind.
    // Skip terminals a detached window holds: re-attaching here would steal its PTY stream and
    // freeze that window. `tearoffHoldings` never throws.
    const elsewhere = heldTerminalIds(await tearoffHoldings());
    // Their NAMES, though, are still this window's to keep: it alone writes them to disk,
    // and the blob it saved last carries them (`serializeCenterLayout`'s parked agents).
    // Back onto the agent rows now — the rebuild that would restore them skips these.
    keepHeldAgentNames(prefs.views ?? [], elsewhere);
    layoutActions.rebuildTerminalTabs(snapshot.terminals.filter((t) => !elsewhere.has(t.id)));

    // Rust auto-spawns pinned roots, so they already arrived as rows; this only flags them pinned.
    // After the snapshot so the rows exist; `pinnedAgents()` yields [] on failure.
    agentActions.applyPinnedAgents(await pinnedAgents());
    // …and label the agents the boot restore re-spawned before the snapshot (open_agents.rs) as
    // "Resumed after restart". `restoredAgents()` yields [] on failure.
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

/** The terminal half of an agent event: an agent's id IS its terminal's id, so `exited`
 * un-sticks that terminal via `noteAgentExited` (else a killed `claude` freezes the tab). */
export function onTerminalSideOf(event: AgentEvent): void {
  if (event.t === "exited") noteAgentExited(asTerminalId(event.agentId), event.code);
}

/** Restore persisted names of agents a detached window holds (`rebuildTerminalTabs` skips them).
 * Named rows, unheld terminals and agents that did not come back are left alone. Plain state, no
 * effect: the layout must not be saved mid-boot. */
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
