/** Arbitrary depth is tested now: the flat build is what makes the fan-out tree virtualizable. */

import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import type { AgentId, AgentNode, AgentStatus } from "../../app/types";
import {
  flattenFleet,
  resetFleetRowsCache,
  selectFleetRows,
  type AgentFleetRow,
  type FleetRow,
  type FolderFleetRow,
  type StatusRollup,
} from "./flatten";

const id = (s: string) => s as AgentId;

/** Only the agent rows — folder-group headers are asserted separately (below). */
const agentRowsOf = (rows: FleetRow[]): AgentFleetRow[] =>
  rows.filter((r): r is AgentFleetRow => r.kind === "agent");

/** Full selector state; the walk tests default folders open with no manual order. */
const slice = (
  agents: Record<AgentId, AgentNode>,
  rootAgentIds: AgentId[],
  extra: Partial<{ collapsedFolders: ReadonlySet<string>; folderOrder: readonly string[] }> = {},
) => ({
  agents,
  rootAgentIds,
  collapsedFolders: extra.collapsedFolders ?? new Set<string>(),
  folderOrder: extra.folderOrder ?? [],
});

/** A store-shaped AgentNode; only the fields the walk reads matter. */
function agent(partial: Partial<AgentNode> & { id: AgentId }): AgentNode {
  return {
    parentId: null,
    kind: "orchestrator",
    title: partial.id,
    status: "running",
    branch: "trunk",
    cwd: "/w",
    runtime: "claude-code",
    startedAt: 0,
    finishedAt: null,
    lastActivityAt: 0,
    childIds: [],
    sessionId: null,
    expanded: true,
    unread: 0,
    ...partial,
  };
}

/** Build a forest from `id -> childIds`, wiring parentId both ways. */
function forest(spec: Record<string, string[]>, expanded: string[] = []) {
  const agents: Record<AgentId, AgentNode> = {};
  const collapsed = new Set(expanded);
  for (const [key, children] of Object.entries(spec)) {
    agents[id(key)] = agent({
      id: id(key),
      childIds: children.map(id),
      expanded: !collapsed.has(key),
    });
  }
  for (const [key, children] of Object.entries(spec)) {
    for (const child of children) {
      if (agents[id(child)]) agents[id(child)].parentId = id(key);
    }
  }
  return agents;
}

const shape = (rows: FleetRow[]) =>
  agentRowsOf(rows).map((r) => `${"  ".repeat(r.depth)}${r.agentId}`);

/** Build a forest with per-node status, wiring parentId both ways. */
function statusForest(spec: Record<string, { children: string[]; status?: AgentStatus }>) {
  const agents: Record<AgentId, AgentNode> = {};
  for (const [key, node] of Object.entries(spec)) {
    agents[id(key)] = agent({
      id: id(key),
      childIds: node.children.map(id),
      status: node.status ?? "running",
    });
  }
  for (const [key, node] of Object.entries(spec)) {
    for (const child of node.children) {
      if (agents[id(child)]) agents[id(child)].parentId = id(key);
    }
  }
  return agents;
}

const rowFor = (rows: FleetRow[], key: string): AgentFleetRow =>
  agentRowsOf(rows).find((r) => r.agentId === id(key))!;

beforeEach(() => resetFleetRowsCache());

describe("flattenFleet — depth", () => {
  it("flattens roots at depth 0", () => {
    const agents = forest({ a: [], b: [] });
    expect(shape(flattenFleet(agents, [id("a"), id("b")]))).toEqual(["a", "b"]);
  });

  it("emits children depth-first, in childIds order", () => {
    // The order the rail draws is the order this returns — a breadth-first walk
    // would put every root's children after every root.
    const agents = forest({ a: ["a1", "a2"], a1: [], a2: [], b: [] });
    expect(shape(flattenFleet(agents, [id("a"), id("b")]))).toEqual([
      "a",
      "  a1",
      "  a2",
      "b",
    ]);
  });

  it("recurses to arbitrary depth — M3's whole point", () => {
    // M2 never produces this. M3 does, and the model must already handle it.
    const agents = forest({
      a: ["b"], b: ["c"], c: ["d"], d: ["e"], e: [],
    });
    const rows = flattenFleet(agents, [id("a")]);
    expect(shape(rows)).toEqual(["a", "  b", "    c", "      d", "        e"]);
    expect(agentRowsOf(rows).map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports hasChildren so the caret only shows where it discloses something", () => {
    const agents = forest({ a: ["a1"], a1: [] });
    const a = agentRowsOf(flattenFleet(agents, [id("a")]));
    expect(a[0].hasChildren).toBe(true);
    expect(a[1].hasChildren).toBe(false);
  });
});

describe("flattenFleet — collapse", () => {
  it("omits a collapsed subtree entirely", () => {
    // Collapsed rows must not be in the output at all: the array length IS the
    // visible row count, which is what a virtualizer windows over.
    const agents = forest({ a: ["a1"], a1: ["a2"], a2: [] }, ["a"]);
    const rows = flattenFleet(agents, [id("a")]);
    expect(shape(rows)).toEqual(["a"]);
    const a = agentRowsOf(rows);
    expect(a[0].expanded).toBe(false);
    expect(a[0].hasChildren).toBe(true); // caret still shows
  });

  it("collapses only the subtree, not its siblings", () => {
    const agents = forest({ a: ["a1"], a1: [], b: ["b1"], b1: [] }, ["a"]);
    expect(shape(flattenFleet(agents, [id("a"), id("b")]))).toEqual(["a", "b", "  b1"]);
  });
});

describe("flattenFleet — roll-up (the collapsed-subtree summary)", () => {
  it("counts a parent's direct children by status", () => {
    const agents = statusForest({
      root: { children: ["a", "b", "c", "d"] },
      a: { children: [], status: "running" },
      b: { children: [], status: "running" },
      c: { children: [], status: "done" },
      d: { children: [], status: "error" },
    });
    const rows = flattenFleet(agents, [id("root")]);
    const rollup = rowFor(rows, "root").rollup!;
    expect(rollup).toMatchObject({ running: 2, done: 1, error: 1, total: 4 });
  });

  it("aggregates across depth — grandchildren count toward the root", () => {
    // root → mid → {leaf-running, leaf-error}. root's rollup covers ALL below.
    const agents = statusForest({
      root: { children: ["mid"] },
      mid: { children: ["x", "y"], status: "running" },
      x: { children: [], status: "running" },
      y: { children: [], status: "error" },
    });
    const rows = flattenFleet(agents, [id("root")]);
    // root sees mid + x + y = 2 running (mid, x) + 1 error (y).
    expect(rowFor(rows, "root").rollup).toMatchObject({
      running: 2,
      error: 1,
      total: 3,
    });
    // mid sees only x + y.
    expect(rowFor(rows, "mid").rollup).toMatchObject({ running: 1, error: 1, total: 2 });
  });

  it("rolls idle and waiting_input UP a subtree (grandchildren count toward the root)", () => {
    // root's idle/waiting_input can only come from the recursive sums (its direct child runs), so
    // a sign flip there goes negative.
    const agents = statusForest({
      root: { children: ["mid"], status: "running" },
      mid: { children: ["li", "lw"], status: "running" },
      li: { children: [], status: "idle" },
      lw: { children: [], status: "waiting_input" },
    });
    const rows = flattenFleet(agents, [id("root")]);
    // root sees mid(running) + li(idle) + lw(waiting_input) = 3 descendants; the
    // idle (1) and waiting_input (1) reach root ONLY through mid's sub-rollup.
    expect(rowFor(rows, "root").rollup).toEqual({
      idle: 1,
      running: 1,
      waiting_input: 1,
      done: 0,
      error: 0,
      total: 3,
    });
    // And mid's own rollup carries idle+waiting_input from its direct children.
    expect(rowFor(rows, "mid").rollup).toEqual({
      idle: 1,
      running: 0,
      waiting_input: 1,
      done: 0,
      error: 0,
      total: 2,
    });
  });

  it("rolls up EACH status as an exact descendant count (property)", () => {
    // A general statement of the roll-up contract: for any pure tree, an agent's
    // rollup equals the per-status tally of its descendants. Catches sign/operator
    // flips in every `acc.<status> += sub.<status>` line, at any depth.
    const statusArb = fc.constantFrom<AgentStatus>(
      "idle",
      "running",
      "waiting_input",
      "done",
      "error",
    );
    const treeArb = fc
      .array(
        fc.record({ parent: fc.option(fc.nat({ max: 20 }), { nil: null }), status: statusArb }),
        { minLength: 1, maxLength: 20 },
      )
      .map((specs) => {
        const agents: Record<AgentId, AgentNode> = {};
        const rootIds: AgentId[] = [];
        specs.forEach((spec, i) => {
          const self = id(`a${i}`);
          // Parent is always an earlier index => a pure forest (no cycles/diamonds),
          // so descendants-via-childIds is unambiguous.
          const parentIdx = spec.parent === null ? null : spec.parent % Math.max(i, 1);
          const parentId = i > 0 && parentIdx !== null ? id(`a${parentIdx}`) : null;
          agents[self] = agent({ id: self, parentId, status: spec.status, expanded: true });
          if (parentId) agents[parentId].childIds.push(self);
          else rootIds.push(self);
        });
        return { agents, rootIds };
      });

    fc.assert(
      fc.property(treeArb, ({ agents, rootIds }) => {
        const rows = agentRowsOf(flattenFleet(agents, rootIds));
        for (const row of rows) {
          const node = agents[row.agentId];
          if (node.childIds.length === 0) {
            expect(row.rollup).toBeNull();
            continue;
          }
          const expected: StatusRollup = {
            idle: 0,
            running: 0,
            waiting_input: 0,
            done: 0,
            error: 0,
            total: 0,
          };
          const stack = [...node.childIds];
          while (stack.length) {
            const d = agents[stack.pop()!];
            expected[d.status] += 1;
            expected.total += 1;
            stack.push(...d.childIds);
          }
          expect(row.rollup).toEqual(expected);
        }
      }),
    );
  });

  it("gives a childless node a null roll-up", () => {
    const agents = statusForest({ solo: { children: [] } });
    expect(rowFor(flattenFleet(agents, [id("solo")]), "solo").rollup).toBeNull();
  });

  it("counts through COLLAPSED nodes — collapse hides rows, not the roll-up", () => {
    // The whole point: a collapsed parent must still summarize what it hides.
    const agents = statusForest({
      root: { children: ["a", "b"] },
      a: { children: [], status: "done" },
      b: { children: [], status: "error" },
    });
    agents[id("root")].expanded = false;
    const rows = flattenFleet(agents, [id("root")]);
    expect(shape(rows)).toEqual(["root"]); // children hidden
    expect(rowFor(rows, "root").rollup).toMatchObject({ done: 1, error: 1, total: 2 });
  });

  it("does not count the node itself, only its descendants", () => {
    // An errored parent with healthy children rolls up 0 errors — its own error
    // is shown by its own pill, not as a subtree problem.
    const agents = statusForest({
      root: { children: ["a"], status: "error" },
      a: { children: [], status: "running" },
    });
    expect(rowFor(flattenFleet(agents, [id("root")]), "root").rollup).toMatchObject({
      running: 1,
      error: 0,
    });
  });

  it("terminates the roll-up on a cycle", () => {
    const agents = statusForest({
      a: { children: ["b"] },
      b: { children: ["a"], status: "error" },
    });
    // Must return, and count each node at most once.
    const rows = flattenFleet(agents, [id("a")]);
    expect(rowFor(rows, "a").rollup!.total).toBeLessThanOrEqual(2);
  });

  it("skips a dangling child id in the roll-up (record not arrived yet)", () => {
    // A parent whose childIds names one real child and one whose record has not
    // landed — a spawn whose child event is still in flight. The roll-up counts
    // only the real one and does not crash on the ghost.
    const agents = statusForest({
      root: { children: ["real", "ghost"] },
      real: { children: [], status: "running" },
      // "ghost" is referenced but never created — no record.
    });
    const rows = flattenFleet(agents, [id("root")]);
    expect(rowFor(rows, "root").rollup).toMatchObject({ running: 1, total: 1 });
  });
});

describe("flattenFleet — attention (bubbles from below)", () => {
  it("raises attention on a parent with an error child", () => {
    const agents = statusForest({
      root: { children: ["ok", "bad"] },
      ok: { children: [], status: "running" },
      bad: { children: [], status: "error" },
    });
    const rows = flattenFleet(agents, [id("root")]);
    expect(rowFor(rows, "root").attention).toBe(true);
  });

  it("bubbles attention from a DEEP descendant to the root", () => {
    // The headline: a blocked/errored agent two levels down is visible from the
    // collapsed root, without expanding.
    const agents = statusForest({
      root: { children: ["mid"] },
      mid: { children: ["deep"], status: "running" },
      deep: { children: [], status: "error" },
    });
    const rows = flattenFleet(agents, [id("root")]);
    expect(rowFor(rows, "root").attention).toBe(true);
    expect(rowFor(rows, "mid").attention).toBe(true);
  });

  it("does NOT raise attention when the subtree is healthy", () => {
    const agents = statusForest({
      root: { children: ["a", "b"] },
      a: { children: [], status: "running" },
      b: { children: [], status: "done" },
    });
    expect(rowFor(flattenFleet(agents, [id("root")]), "root").attention).toBe(false);
  });

  it("a node's OWN error does not raise attention on itself", () => {
    // Attention is about what is hidden below; a leaf shows its own error pill.
    const agents = statusForest({ solo: { children: [], status: "error" } });
    expect(rowFor(flattenFleet(agents, [id("solo")]), "solo").attention).toBe(false);
  });
});

describe("flattenFleet — hostile input", () => {
  it("skips ids with no record", () => {
    // Telemetry can name a parent or child we have not seen yet.
    const agents = forest({ a: ["ghost"] });
    const rows = flattenFleet(agents, [id("a"), id("missing")]);
    expect(shape(rows)).toEqual(["a"]);
    expect(agentRowsOf(rows)[0].hasChildren).toBe(false); // a ghost child discloses nothing
  });

  it("TERMINATES on a cycle — the 100%-CPU guard", () => {
    // A childIds loop from malformed/replayed telemetry. Without the seen-set
    // this recurses forever and pegs a core (cmux #2586). Each agent must
    // appear at most once, and the call must return.
    const agents = forest({ a: ["b"], b: ["a"] });
    const rows = flattenFleet(agents, [id("a")]);
    expect(shape(rows)).toEqual(["a", "  b"]);
    expect(agentRowsOf(rows)).toHaveLength(2);
  });

  it("terminates on a self-cycle", () => {
    const agents = forest({ a: ["a"] });
    expect(agentRowsOf(flattenFleet(agents, [id("a")]))).toHaveLength(1);
  });

  it("terminates on a long cycle", () => {
    const agents = forest({ a: ["b"], b: ["c"], c: ["a"] });
    expect(agentRowsOf(flattenFleet(agents, [id("a")]))).toHaveLength(3);
  });

  it("renders a diamond once, not twice", () => {
    // Two parents naming the same child. The tree shows it under the first.
    const agents = forest({ a: ["c"], b: ["c"], c: [] });
    const rows = flattenFleet(agents, [id("a"), id("b")]);
    expect(shape(rows)).toEqual(["a", "  c", "b"]);
  });

  it("ignores a duplicated root", () => {
    const agents = forest({ a: [] });
    expect(agentRowsOf(flattenFleet(agents, [id("a"), id("a")]))).toHaveLength(1);
  });
});

describe("flattenFleet — properties", () => {
  /** An arbitrary forest: n agents, each optionally parented to an earlier one. */
  const forestArb = fc
    .array(
      fc.record({
        parent: fc.option(fc.nat({ max: 20 }), { nil: null }),
        expanded: fc.boolean(),
      }),
      { minLength: 1, maxLength: 20 },
    )
    .map((specs) => {
      const agents: Record<AgentId, AgentNode> = {};
      const rootIds: AgentId[] = [];
      specs.forEach((spec, i) => {
        const self = id(`a${i}`);
        // Parent must be an earlier index, so the arbitrary is acyclic by
        // construction — cycles are covered by the explicit tests above.
        const parentIdx = spec.parent === null ? null : spec.parent % Math.max(i, 1);
        const parentId = i > 0 && parentIdx !== null ? id(`a${parentIdx}`) : null;
        agents[self] = agent({ id: self, parentId, expanded: spec.expanded });
        if (parentId) agents[parentId].childIds.push(self);
        else rootIds.push(self);
      });
      return { agents, rootIds };
    });

  it("always terminates and never repeats an agent", () => {
    fc.assert(
      fc.property(forestArb, ({ agents, rootIds }) => {
        const rows = agentRowsOf(flattenFleet(agents, rootIds));
        const ids = rows.map((r) => r.agentId);
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });

  it("every row's parent is either absent (collapsed away) or immediately above it", () => {
    // The invariant that makes `depth` renderable as indentation: a row's parent
    // is the nearest preceding row at depth-1.
    fc.assert(
      fc.property(forestArb, ({ agents, rootIds }) => {
        const rows = agentRowsOf(flattenFleet(agents, rootIds));
        rows.forEach((row, i) => {
          const parentId = agents[row.agentId].parentId;
          if (row.depth === 0) {
            expect(parentId === null || !rows.some((r) => r.agentId === parentId)).toBe(true);
            return;
          }
          const ancestor = [...rows.slice(0, i)].reverse().find((r) => r.depth === row.depth - 1);
          expect(ancestor?.agentId).toBe(parentId);
        });
      }),
    );
  });

  it("a collapsed agent contributes exactly one row", () => {
    fc.assert(
      fc.property(forestArb, ({ agents, rootIds }) => {
        const rows = agentRowsOf(flattenFleet(agents, rootIds));
        for (const row of rows) {
          if (row.expanded) continue;
          // Nothing below a collapsed row may be deeper than it.
          const next = rows[rows.indexOf(row) + 1];
          if (next) expect(next.depth).toBeLessThanOrEqual(row.depth);
        }
      }),
    );
  });

  it("depth never jumps by more than one", () => {
    fc.assert(
      fc.property(forestArb, ({ agents, rootIds }) => {
        const rows = agentRowsOf(flattenFleet(agents, rootIds));
        rows.forEach((row, i) => {
          if (i === 0) return expect(row.depth).toBe(0);
          expect(row.depth).toBeLessThanOrEqual(rows[i - 1].depth + 1);
        });
      }),
    );
  });
});

const folderRowsOf = (rows: FleetRow[]): FolderFleetRow[] =>
  rows.filter((r): r is FolderFleetRow => r.kind === "folder");

describe("flattenFleet — folder grouping", () => {
  /** Roots with explicit cwds (and optional childIds), parentId wired for kids. */
  function folders(spec: Record<string, { cwd: string; children?: string[]; status?: AgentStatus }>) {
    const agents: Record<AgentId, AgentNode> = {};
    for (const [key, node] of Object.entries(spec)) {
      agents[id(key)] = agent({
        id: id(key),
        cwd: node.cwd,
        childIds: (node.children ?? []).map(id),
        status: node.status ?? "running",
      });
    }
    for (const [key, node] of Object.entries(spec)) {
      for (const child of node.children ?? []) {
        if (agents[id(child)]) agents[id(child)].parentId = id(key);
      }
    }
    return agents;
  }

  it("groups root agents by cwd — one header per distinct folder, basename named", () => {
    const agents = folders({
      a: { cwd: "/w/gazelle" },
      b: { cwd: "/w/gazelle" },
      c: { cwd: "/w/api" },
    });
    const headers = folderRowsOf(flattenFleet(agents, [id("a"), id("b"), id("c")]));
    expect(headers.map((f) => f.path)).toEqual(["/w/gazelle", "/w/api"]);
    expect(headers.map((f) => f.name)).toEqual(["gazelle", "api"]);
    expect(headers.map((f) => f.agentCount)).toEqual([2, 1]);
  });

  it("emits the folder header, then its agents", () => {
    const agents = folders({ a: { cwd: "/w/gazelle" } });
    const rows = flattenFleet(agents, [id("a")]);
    expect(rows[0]).toMatchObject({ kind: "folder", name: "gazelle", agentCount: 1 });
    expect(rows[1]).toMatchObject({ kind: "agent", agentId: id("a") });
  });

  it("rolls the folder's agents up onto its header (roots + subtrees)", () => {
    // One folder: a running root with a done child and an error grandchild.
    const agents = folders({
      root: { cwd: "/w/gazelle", children: ["kid"], status: "running" },
      kid: { cwd: "/w/gazelle", children: ["deep"], status: "done" },
      deep: { cwd: "/w/gazelle", status: "error" },
    });
    const header = folderRowsOf(flattenFleet(agents, [id("root")]))[0];
    // root(running) + kid(done) + deep(error) = 3 agents.
    expect(header.rollup).toMatchObject({ running: 1, done: 1, error: 1, total: 3 });
  });

  it("rolls idle/running/waiting_input up onto the folder header (not only done/error)", () => {
    // The root is `done`, so idle/running/waiting_input come only from the subtree sums.
    const agents = folders({
      root: { cwd: "/w/gazelle", children: ["ci", "cr", "cw"], status: "done" },
      ci: { cwd: "/w/gazelle", status: "idle" },
      cr: { cwd: "/w/gazelle", status: "running" },
      cw: { cwd: "/w/gazelle", status: "waiting_input" },
    });
    const header = folderRowsOf(flattenFleet(agents, [id("root")]))[0];
    // root(done) + ci(idle) + cr(running) + cw(waiting_input) = 4 agents.
    expect(header.rollup).toEqual({
      idle: 1,
      running: 1,
      waiting_input: 1,
      done: 1,
      error: 0,
      total: 4,
    });
  });

  it("defaults folders EXPANDED — agents show with no collapse state", () => {
    const agents = folders({ a: { cwd: "/w/gazelle" } });
    const rows = flattenFleet(agents, [id("a")]);
    expect(folderRowsOf(rows)[0].collapsed).toBe(false);
    expect(shape(rows)).toEqual(["a"]);
  });

  it("collapses a folder — its agents vanish, the header stays with its rollup", () => {
    const agents = folders({
      a: { cwd: "/w/gazelle", status: "error" },
      b: { cwd: "/w/gazelle" },
    });
    const rows = flattenFleet(agents, [id("a"), id("b")], {
      collapsedFolders: new Set(["/w/gazelle"]),
    });
    const header = folderRowsOf(rows)[0];
    expect(header.collapsed).toBe(true);
    expect(header.rollup).toMatchObject({ error: 1, total: 2 }); // still summarized
    expect(agentRowsOf(rows)).toHaveLength(0); // agents hidden
  });

  it("collapsing one folder does not hide another's agents", () => {
    const agents = folders({
      a: { cwd: "/w/gazelle" },
      b: { cwd: "/w/api" },
    });
    const rows = flattenFleet(agents, [id("a"), id("b")], {
      collapsedFolders: new Set(["/w/gazelle"]),
    });
    expect(shape(rows)).toEqual(["b"]); // gazelle collapsed, api open
  });

  it("orders folders by the shared folderOrder, insertion order otherwise", () => {
    const agents = folders({
      a: { cwd: "/w/first" },
      b: { cwd: "/w/second" },
      c: { cwd: "/w/third" },
    });
    // folderOrder puts /w/third at the top; the rest keep first-seen (insertion)
    // order after the ordered ones (the SAME key the right rail uses).
    const headers = folderRowsOf(
      flattenFleet(agents, [id("a"), id("b"), id("c")], { folderOrder: ["/w/third"] }),
    );
    expect(headers.map((f) => f.path)).toEqual(["/w/third", "/w/first", "/w/second"]);
  });

  it("honours a full manual folderOrder (a drag reordering every folder)", () => {
    const agents = folders({
      a: { cwd: "/w/first" },
      b: { cwd: "/w/second" },
      c: { cwd: "/w/third" },
    });
    const headers = folderRowsOf(
      flattenFleet(agents, [id("a"), id("b"), id("c")], {
        folderOrder: ["/w/second", "/w/third", "/w/first"],
      }),
    );
    expect(headers.map((f) => f.path)).toEqual(["/w/second", "/w/third", "/w/first"]);
  });

  it("names a filesystem-root folder by the raw path (no basename)", () => {
    const agents = folders({ a: { cwd: "/" } });
    expect(folderRowsOf(flattenFleet(agents, [id("a")]))[0].name).toBe("/");
  });

  it("keeps sub-agent fan-out nested under its agent, inside the folder", () => {
    const agents = folders({
      root: { cwd: "/w/gazelle", children: ["kid"] },
      kid: { cwd: "/w/gazelle" },
    });
    const rows = flattenFleet(agents, [id("root")]);
    expect(rows[0].kind).toBe("folder");
    expect(shape(rows)).toEqual(["root", "  kid"]); // kid nested under root
  });
});

describe("selectFleetRows — referential stability (the infinite-loop guard)", () => {
  it("returns the SAME array when nothing changed", () => {
    // This is the whole reason the selector is memoized: Zustand compares with
    // Object.is on every render, so a fresh array here is an infinite loop.
    const state = slice(forest({ a: [] }), [id("a")]);
    expect(selectFleetRows(state)).toBe(selectFleetRows(state));
  });

  it("recomputes when the agents record changes identity", () => {
    const first = slice(forest({ a: [] }), [id("a")]);
    const rowsA = selectFleetRows(first);
    const second = slice(forest({ a: [], b: [] }), [id("a"), id("b")]);
    const rowsB = selectFleetRows(second);
    expect(rowsB).not.toBe(rowsA);
    expect(agentRowsOf(rowsB)).toHaveLength(2);
  });

  it("recomputes when only rootAgentIds changes identity", () => {
    const agents = forest({ a: [], b: [] });
    const rowsA = selectFleetRows(slice(agents, [id("a")]));
    const rowsB = selectFleetRows(slice(agents, [id("a"), id("b")]));
    expect(rowsB).not.toBe(rowsA);
    expect(shape(rowsB)).toEqual(["a", "b"]);
  });
});
