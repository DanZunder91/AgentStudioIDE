/**
 * The fleet render model: recurse at BUILD time, render a FLAT list.
 *
 * ── The decision, and why ────────────────────────────────────────────────────
 * A recursive *component* tree cannot be virtualized: there is no single list to
 * windowe — each level owns its own children, so nothing can compute "row 400 of
 * 900" without rendering the 399 above it. cmux hit exactly this and had to
 * flatten their task manager to `Array<{id, level}>` after the fact.
 * M3 turns this rail into the product's headline — an
 * unbounded, live, recursive fan-out tree — and that is precisely when
 * virtualization stops being optional.
 *
 * So the recursion lives HERE, in a pure function over the normalized forest,
 * and `<AgentTree>` renders `FleetRow[]` as a flat list with `depth` driving
 * indentation. Consequences, all of them the point:
 *
 *   - Arbitrary depth works from day one: this walk is recursive today, so M3
 *     hangs sub-agents off `childIds` and the rail Just Works. Nothing to
 *     retrofit — the recursion is already written, just not in JSX.
 *   - M3 drops a virtualizer over this array without touching a component.
 *   - Every row is a sibling in one list, so one agent's telemetry re-renders
 *     one row (see `<AgentRow>`); a recursive tree re-renders every ancestor.
 *
 * The tradeoff we accept: indentation is a `depth` prop rather than DOM nesting,
 * so there is no ancestor element to hang a subtree background on. That is a
 * styling constraint, not a modelling one.
 */

import { orderFolders } from "../../app/folderOrder";
import type { AgentId, AgentNode } from "../../app/types";

/**
 * Aggregate status of an agent's whole subtree — every descendant, self
 * excluded. `total` is the descendant count; the per-status fields sum to it.
 *
 * This is the roll-up the headline pays off with: a collapsed parent shows it
 * ("3 running · 1 done · 1 error") so you know something is wrong underneath
 * without expanding a wall of children.
 */
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

/**
 * Does this subtree deserve attention that should surface at a collapsed root?
 *
 * The generic "bubble an attention state up the ancestor chain" rule: because a
 * rollup is recursive, an error deep down is counted at EVERY
 * ancestor, so it lights up the collapsed trunk above it. Wired to `error` now;
 * `waiting_input` is included for when the permission-hook telemetry lands (the
 * M3 core does not emit it yet, so it is simply always 0 today — not faked).
 */
export function rollupNeedsAttention(rollup: StatusRollup): boolean {
  return rollup.error > 0 || rollup.waiting_input > 0;
}

/**
 * A folder-group header — the layer ABOVE root agents. Root agents
 * are grouped by their `cwd`; each distinct folder gets one of these, then (when
 * expanded) its agent rows. Defaults EXPANDED — the opposite of the sub-agent
 * tree default, and deliberate: folders open, fan-out trees collapsed.
 */
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
  /**
   * The shared folder order — the SAME list the right (Files) rail sorts
   * by, so both rails show folders in the same sequence. A folder not in the list
   * falls back to first-seen (insertion) order, after the ordered ones — a transient,
   * since `syncFolderOrder` keeps every visible folder listed.
   */
  folderOrder?: readonly string[];
  /** Paths whose folder is collapsed. Absent => expanded (the default). */
  collapsedFolders?: ReadonlySet<string>;
}

/** Last path segment — the folder label. Tolerates trailing separators. */
function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Flatten the agent forest into the rows the rail actually shows.
 *
 * Collapsed subtrees are omitted (that is what collapse means), so the output
 * length is the visible row count — which is exactly what a virtualizer needs.
 *
 * Defensive against telemetry we do not control:
 *   - ids with no record are skipped (an event can name a parent we have not
 *     seen yet);
 *   - **cycles terminate**. A `childIds` loop — from a malformed or replayed
 *     `subagent_spawned` — would otherwise recurse forever and peg a core at
 *     100%, which is the concrete failure cmux shipped (issue #2586). A tree
 *     that renders each agent at most once is worth more than one that hangs.
 */
/**
 * A memoized `agentId → subtree StatusRollup` function, total by construction:
 * it always returns a StatusRollup (empty for a missing record or a cycle), so
 * callers need no fallback.
 *
 * Memoized (the whole forest is O(n), not O(n·depth)) and cycle-safe (an
 * `inProgress` guard mirrors `flattenFleet`'s `seen`, so a malformed `childIds`
 * loop terminates). Traverses through COLLAPSED nodes on purpose: the roll-up
 * must describe the hidden subtree, which is the entire point of showing it on a
 * collapsed row.
 */
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

/**
 * Status aggregate for a whole folder: each root's OWN status plus its subtree,
 * so the header can say "3 running · 1 done" for everything in the folder.
 */
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

  // Order by the shared `folderOrder` — the SAME key the right rail
  // uses, so both sides match. `orderFolders` is stable, so folders not yet in the
  // list keep their first-seen (Map insertion) order after the ordered ones. We sort
  // the ENTRIES (not just the keys) so the loop body stays a guard-free destructure.
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

/* ─────────────────────── the memoized selector ───────────────────────
 * Why this exists, and why it is not just `useAppStore(s => flattenFleet(...))`:
 *
 * Zustand calls a selector on every store change AND every render, comparing
 * with Object.is. A selector that builds a fresh array each call therefore never
 * compares equal — React re-renders, which re-runs the selector, which builds a
 * new array... That is not a hypothetical: it is React's "The result of
 * getSnapshot should be cached to avoid an infinite loop" warning, and it is the
 * shape of cmux's 100%-CPU sidebar spin (issue #2586).
 *
 * Immer gives us structural sharing, so `agents` / `rootAgentIds` keep their
 * identity until something in them actually changes. Caching on that identity
 * makes the selector referentially stable, which closes the loop for good.
 */

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

/**
 * The rail's rows, stable across renders that changed nothing structural.
 *
 * Recomputes when any agent record changes — including a pure `activity` tick,
 * which touches no visible field. That is deliberate: the alternative (a
 * structural signature) costs the same O(n) walk it would be trying to avoid.
 * The tick is absorbed one layer down instead — `<AgentRow>` is memoized on
 * primitive props, so a re-flatten that yields the same rows re-renders nothing.
 */
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
