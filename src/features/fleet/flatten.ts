/** The fleet render model: recurse at build time, render a flat `FleetRow[]` with `depth`, so the
 * unbounded fan-out tree can be virtualized and one agent's update re-renders one row. Cost:
 * indentation is a prop, so there is no ancestor element to style a subtree on. */

import { orderFolders } from "../../app/folderOrder";
import type { AgentId, AgentNode } from "../../app/types";

/** Status counts over an agent's descendants (self excluded); the fields sum to `total`. A
 * collapsed parent shows it so trouble underneath is visible without expanding. */
export interface StatusRollup {
  idle: number;
  running: number;
  waiting_input: number;
  done: number;
  error: number;
  total: number;
}

function emptyRollup(): StatusRollup {
  return { idle: 0, running: 0, waiting_input: 0, done: 0, error: 0, total: 0 };
}

/** Errors (and `waiting_input`, not emitted yet) surface at every collapsed ancestor, since a
 * rollup counts the whole subtree. */
export function rollupNeedsAttention(rollup: StatusRollup): boolean {
  return rollup.error > 0 || rollup.waiting_input > 0;
}

/** A folder header above the root agents grouped by `cwd`. Folders default expanded; fan-out
 * trees default collapsed. */
export interface FolderFleetRow {
  kind: "folder";
  /** Absolute cwd shared by this group's root agents — the group key. */
  path: string;
  /** Basename, shown as the header label (e.g. "Agent Studio"). */
  name: string;
  /** Number of ROOT agents in this folder. */
  agentCount: number;
  /** Status aggregate across the folder's agents (roots + their subtrees). */
  rollup: StatusRollup;
  collapsed: boolean;
}

/** One agent row of the rail. `depth` 0 = a root orchestrator under its folder. */
export interface AgentFleetRow {
  kind: "agent";
  agentId: AgentId;
  depth: number;
  /** Drives the disclosure caret — hidden entirely when false. */
  hasChildren: boolean;
  expanded: boolean;
  /** Subtree status aggregate; null when the node has no children. */
  rollup: StatusRollup | null;
  /** An error (later waiting_input) exists somewhere below — bubbles to the top. */
  attention: boolean;
}

/** A visible row of the rail: a folder-group header, or an agent. */
export type FleetRow = FolderFleetRow | AgentFleetRow;

/** Grouping inputs beyond the forest itself (folder order + collapse state). */
export interface FleetGroupingOptions {
  /** The shared folder order the Files rail sorts by too; unlisted folders follow in first-seen
   * order (`syncFolderOrder` keeps every visible one listed). */
  folderOrder?: readonly string[];
  /** Paths whose folder is collapsed. Absent => expanded (the default). */
  collapsedFolders?: ReadonlySet<string>;
}

/** Last path segment — the folder label. Tolerates trailing separators. */
function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Memoized, cycle-safe `agentId → subtree StatusRollup`; always returns one (empty for a missing
 * record or a cycle). Walks collapsed nodes on purpose: the rollup describes the hidden subtree. */
function makeRollupFn(
  agents: Record<AgentId, AgentNode>,
): (agentId: AgentId) => StatusRollup {
  const memo = new Map<AgentId, StatusRollup>();
  const inProgress = new Set<AgentId>();

  const statsOf = (agentId: AgentId): StatusRollup => {
    const hit = memo.get(agentId);
    if (hit) return hit;
    const agent = agents[agentId];
    const acc = emptyRollup();
    if (!agent || inProgress.has(agentId)) return acc; // missing record / cycle
    inProgress.add(agentId);

    for (const childId of agent.childIds) {
      const child = agents[childId];
      if (!child) continue; // a child whose record has not arrived yet
      acc[child.status] += 1;
      acc.total += 1;
      const sub = statsOf(childId);
      acc.idle += sub.idle;
      acc.running += sub.running;
      acc.waiting_input += sub.waiting_input;
      acc.done += sub.done;
      acc.error += sub.error;
      acc.total += sub.total;
    }

    inProgress.delete(agentId);
    memo.set(agentId, acc);
    return acc;
  };

  return statsOf;
}

/** Each root's own status plus its subtree, for the folder header's counts. */
function folderRollupOf(
  rootNodes: readonly AgentNode[],
  rollupOf: (agentId: AgentId) => StatusRollup,
): StatusRollup {
  const acc = emptyRollup();
  for (const root of rootNodes) {
    acc[root.status] += 1;
    acc.total += 1;
    const sub = rollupOf(root.id);
    acc.idle += sub.idle;
    acc.running += sub.running;
    acc.waiting_input += sub.waiting_input;
    acc.done += sub.done;
    acc.error += sub.error;
    acc.total += sub.total;
  }
  return acc;
}

/** Visible rows only (collapsed subtrees omitted). Skips unknown ids and terminates on `childIds`
 * cycles from malformed telemetry, so each agent renders at most once. */
export function flattenFleet(
  agents: Record<AgentId, AgentNode>,
  rootAgentIds: readonly AgentId[],
  options: FleetGroupingOptions = {},
): FleetRow[] {
  const rows: FleetRow[] = [];
  const seen = new Set<AgentId>();
  const rollupOf = makeRollupFn(agents);
  const collapsedFolders = options.collapsedFolders ?? EMPTY_SET;
  const folderOrder = options.folderOrder ?? [];

  const walk = (agentId: AgentId, depth: number): void => {
    const agent = agents[agentId];
    if (!agent || seen.has(agentId)) return;
    seen.add(agentId);

    // Only children we actually hold records for are real children — a caret
    // that discloses nothing is worse than no caret.
    const childIds = agent.childIds.filter((id) => agents[id] && !seen.has(id));
    const hasChildren = childIds.length > 0;
    // `rollupOf` is total, so no fallback branch. null only when childless.
    const rollup = hasChildren ? rollupOf(agentId) : null;

    rows.push({
      kind: "agent",
      agentId,
      depth,
      hasChildren,
      expanded: agent.expanded,
      rollup,
      // Attention only bubbles from BELOW: a node's own error shows in its own
      // pill, so it does not raise attention on itself — only on its ancestors.
      attention: rollup ? rollupNeedsAttention(rollup) : false,
    });

    if (!agent.expanded) return;
    for (const childId of childIds) walk(childId, depth + 1);
  };

  // Group root agents by cwd. Map preserves insertion order (first-seen folder).
  const groups = new Map<string, AgentNode[]>();
  for (const rootId of rootAgentIds) {
    const agent = agents[rootId];
    if (!agent) continue; // an id whose record has not arrived yet
    const list = groups.get(agent.cwd);
    if (list) list.push(agent);
    else groups.set(agent.cwd, [agent]);
  }

  // Same `folderOrder` key as the right rail; `orderFolders` is stable, so unlisted folders keep
  // first-seen order. Entries are sorted so the loop body is a guard-free destructure.
  const rank = new Map(orderFolders([...groups.keys()], folderOrder).map((p, i) => [p, i] as const));
  const orderedEntries = [...groups.entries()].sort(
    ([a], [b]) => (rank.get(a) as number) - (rank.get(b) as number),
  );

  for (const [path, rootNodes] of orderedEntries) {
    const collapsed = collapsedFolders.has(path);
    rows.push({
      kind: "folder",
      path,
      name: folderName(path),
      agentCount: rootNodes.length,
      rollup: folderRollupOf(rootNodes, rollupOf),
      collapsed,
    });
    if (collapsed) continue; // header only — its agents are hidden
    for (const root of rootNodes) walk(root.id, 0);
  }
  return rows;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/* Memoized selector: a fresh array per call never passes Zustand's Object.is check and loops
 * renders ("getSnapshot should be cached"). Caching on Immer-shared `agents` / `rootAgentIds`
 * identity keeps it referentially stable. */

interface FleetSlice {
  agents: Record<AgentId, AgentNode>;
  rootAgentIds: readonly AgentId[];
  collapsedFolders: ReadonlySet<string>;
  folderOrder: readonly string[];
}

let cachedAgents: Record<AgentId, AgentNode> | null = null;
let cachedRoots: readonly AgentId[] | null = null;
let cachedCollapsed: ReadonlySet<string> | null = null;
let cachedFolderOrder: readonly string[] | null = null;
let cachedRows: FleetRow[] = [];

/** Stable across structurally unchanged renders. Recomputes on any agent change, even an
 * `activity` tick; memoized `<AgentRow>`s absorb that, so equal rows re-render nothing. */
export function selectFleetRows(state: FleetSlice): FleetRow[] {
  if (
    state.agents === cachedAgents &&
    state.rootAgentIds === cachedRoots &&
    state.collapsedFolders === cachedCollapsed &&
    state.folderOrder === cachedFolderOrder
  ) {
    return cachedRows;
  }
  cachedAgents = state.agents;
  cachedRoots = state.rootAgentIds;
  cachedCollapsed = state.collapsedFolders;
  cachedFolderOrder = state.folderOrder;
  cachedRows = flattenFleet(state.agents, state.rootAgentIds, {
    collapsedFolders: state.collapsedFolders,
    folderOrder: state.folderOrder,
  });
  return cachedRows;
}

/** Test-only: drop the memo so one test's store cannot leak into the next. */
export function resetFleetRowsCache(): void {
  cachedAgents = null;
  cachedRoots = null;
  cachedCollapsed = null;
  cachedFolderOrder = null;
  cachedRows = [];
}
