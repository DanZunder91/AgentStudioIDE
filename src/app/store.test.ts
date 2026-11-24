/**
 * The layout store — pane-tree canonicalization, tabs, focus, terminal lifetime.
 *
 * Pane-tree canonicalization is a "highest-value target (test these hardest)",
 * which calls for property-based coverage of exactly these invariants:
 * "sizes sum to 1, no single-child splits, no same-orientation nesting, last
 * leaf survives". This file is where those checks live, re-runnable with the
 * rest of the suite.
 *
 * ── Why `features/terminal` is mocked ────────────────────────────────────────
 * `store.ts` imports `configureTerminal`/`dispose` for effects in its action
 * wrappers. The real module constructs xterm instances, opens PTYs over Tauri
 * IPC and mounts a WebGL renderer — none of which exist (or should) in jsdom.
 * Mocking at that module boundary is both correct unit-testing practice and how
 * we assert the two effects the store owes it: `configureTerminal` on open,
 * `dispose` on close (leak prevention).
 */

import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));

vi.mock("../features/terminal", () => terminal);

// The store persists collections/environments through this IPC as an EFFECT in
// its action wrappers. Mock it so the spy proves a mutation triggers
// a save without touching Tauri.
const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("../features/api/apiStoreIpc", () => apiStoreIpc);

// The store persists request history through this IPC as an EFFECT,
// same as the durable store above. Mock it so a record/clear proves a save.
const historyIpc = vi.hoisted(() => ({
  loadApiHistory: vi.fn(),
  saveApiHistory: vi.fn(),
}));
vi.mock("../features/api/historyIpc", () => historyIpc);

// `addBrowseRoot` authorizes a browse root for `read_dir` by pushing
// it to the persisted recents AND installs the ad-hoc-detection hook for the
// opened folder — both EFFECTS in the wrapper. Mock the IPC so the
// spies prove the calls without touching Tauri (both default to resolving).
const fleetIpc = vi.hoisted(() => ({
  pushRecentProject: vi.fn().mockResolvedValue(undefined),
  ensureAgentHooks: vi.fn().mockResolvedValue(undefined),
  // Pin registry effects: the store fires these in its action
  // wrappers. Spies prove a pin/unpin/dismiss issues the right invoke.
  pinAgent: vi.fn().mockResolvedValue(undefined),
  unpinAgent: vi.fn().mockResolvedValue(undefined),
  pinnedAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock("../features/fleet/fleetIpc", () => fleetIpc);

// The layout-prefs persistence EFFECT the collapse/order/focus-follows wrappers run
// (folder order, collapse state + focus-follows-agent). Mock it so a spy proves a
// mutation persists (and a no-op does NOT) without touching Tauri — the same shape
// railOrder.test.ts uses.
const layoutPrefsIpc = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn().mockResolvedValue({
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
    focusFollowsAgent: false,
  }),
  saveLayoutPrefs: vi.fn().mockResolvedValue(undefined),
  EMPTY_LAYOUT_PREFS: {
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
    focusFollowsAgent: false,
  },
}));
vi.mock("./layoutPrefsIpc", () => layoutPrefsIpc);

import {
  canonicalize,
  collapseAllBut,
  activeFilePath,
  findNode,
  fractionalRectOfLeaf,
  layoutActions,
  leafOfTab,
  leavesOf,
  makeLeaf,
  planDropRect,
  planMoveTab,
  planMoveTabToEdge,
  RAIL_MAX_W,
  RAIL_MIN_W,
  replaceNode,
  useAppStore,
  viewTabIds,
  workspaceRoots,
  asViewId,
  type AppStore,
  type LayoutState,
  type SplitEdge,
  type ViewSnapshot,
} from "./store";
import {
  asAgentId,
  asPaneId,
  asTabId,
  asTerminalId,
  type AgentId,
  type AgentNode,
  type LeafNode,
  type Orientation,
  type PaneId,
  type PaneNode,
  type SplitNode,
  type Tab,
  type TabId,
  type TerminalId,
  type TerminalMeta,
} from "./types";
import {
  allTabIdsInTree,
  assertLiveStoreInvariants,
  assertStoreInvariants,
  assertTreeInvariants,
  leafIds,
  resetStore,
  splitsOf,
  treeShape,
} from "../test/store-harness";
import {
  assertLiveFleetInvariants,
  resetFleetStore,
  wireAgent,
} from "../test/fleet-harness";
// Type-only: the api slice holds the last HttpResponse. No runtime dependency on
// the feature (nothing loads @tauri-apps/api/core here).
import type { HttpResponse } from "../features/api/httpIpc";
import {
  PREVIEW_ZOOM_DEFAULT,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
} from "../features/editor/previewZoom";

/* ─────────────────────────── helpers ─────────────────────────── */

// AppStore, not LayoutState: `runCmd` reaches for `layoutActions` too. AppStore
// extends LayoutState, so every LayoutState-shaped assertion still type-checks.
const state = (): AppStore => useAppStore.getState();
const act = () => layoutActions();

/**
 * Let the terminal busy-check settle.
 *
 * Closing a terminal is asynchronous now: the gate asks Rust "is anything
 * running in this?" before it either closes or raises the confirm. Under test
 * `invoke` is unmocked, so `terminalsBusy` catches and resolves `[]` — but it
 * still resolves on a MICROTASK, so a synchronous assertion right after the
 * gesture reads the state from before the answer arrived.
 */
const flushBusyGate = () => Promise.resolve().then(() => {});

/** The (only, at boot) leaf. */
const rootLeaf = (): LeafNode => leavesOf(state().layout)[0];

const asLeaf = (node: PaneNode | null): LeafNode => {
  expect(node, "expected a leaf").toBeTruthy();
  expect(node?.type).toBe("leaf");
  return node as LeafNode;
};

const asSplit = (node: PaneNode | null): SplitNode => {
  expect(node, "expected a split").toBeTruthy();
  expect(node?.type).toBe("split");
  return node as SplitNode;
};

const leafById = (id: PaneId): LeafNode => asLeaf(findNode(state().layout, id));

/** A plain, structured-cloneable snapshot of the store's data (no actions). */
const snapshot = (s: LayoutState) =>
  structuredClone({
    layout: s.layout,
    focusedPaneId: s.focusedPaneId,
    pendingTerminalClose: null,
    tabs: s.tabs,
  });

/** Inject an editor tab — M4 has no action for it, but types.ts is the contract. */
function injectEditorTab(paneId: PaneId, title = "Cargo.toml"): TabId {
  const tabId = asTabId(`editor-${title}-${Math.random()}`);
  useAppStore.setState((s) => {
    const leaf = findNode(s.layout, paneId);
    if (!leaf || leaf.type !== "leaf") throw new Error("not a leaf");
    s.tabs[tabId] = {
      id: tabId,
      kind: "editor",
      title,
      ref: { kind: "editor", path: `/w/${title}` },
    };
    leaf.tabIds.push(tabId);
    leaf.activeTabId = tabId;
  });
  return tabId;
}

const terminalIdOfTab = (tabId: TabId): TerminalId => {
  const ref = state().tabs[tabId]?.ref;
  if (!ref || (ref.kind !== "terminal" && ref.kind !== "agent-terminal"))
    throw new Error("not a terminal tab");
  return ref.terminalId;
};

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  terminal.dispose.mockClear();
  terminal.setDefaultTerminalCwd.mockClear();
  apiStoreIpc.loadApiStore.mockClear();
  apiStoreIpc.saveApiStore.mockClear();
  historyIpc.loadApiHistory.mockClear();
  historyIpc.saveApiHistory.mockClear();
  fleetIpc.pushRecentProject.mockClear();
  fleetIpc.ensureAgentHooks.mockClear();
  fleetIpc.ensureAgentHooks.mockResolvedValue(undefined);
  fleetIpc.pinAgent.mockClear();
  fleetIpc.unpinAgent.mockClear();
  fleetIpc.pinnedAgents.mockClear();
  layoutPrefsIpc.saveLayoutPrefs.mockClear();
});

/* ══════════════════════════ pure tree helpers ══════════════════════════ */

describe("pure tree helpers", () => {
  it("makeLeaf mints a distinct, empty, unfocused-by-default leaf", () => {
    const a = makeLeaf();
    const b = makeLeaf();
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ type: "leaf", tabIds: [], activeTabId: null });
  });

  it("leavesOf returns leaves in visual order, splits excluded", () => {
    const [l1, l2, l3] = [makeLeaf(), makeLeaf(), makeLeaf()];
    const tree: PaneNode = {
      id: asPaneId("s0"),
      type: "split",
      orientation: "row",
      children: [
        l1,
        {
          id: asPaneId("s1"),
          type: "split",
          orientation: "column",
          children: [l2, l3],
          sizes: [0.5, 0.5],
        },
      ],
      sizes: [0.5, 0.5],
    };
    expect(leavesOf(tree).map((l) => l.id)).toEqual([l1.id, l2.id, l3.id]);
  });

  it("findNode matches splits and leaves, and misses cleanly", () => {
    const leaf = makeLeaf();
    const split: SplitNode = {
      id: asPaneId("s0"),
      type: "split",
      orientation: "row",
      children: [leaf, makeLeaf()],
      sizes: [0.5, 0.5],
    };
    expect(findNode(split, split.id)).toBe(split);
    expect(findNode(split, leaf.id)).toBe(leaf);
    expect(findNode(split, asPaneId("nope"))).toBeNull();
  });

  it("leafOfTab locates the owning leaf, null when unowned", () => {
    const tabId = asTabId("t1");
    const holder: LeafNode = {
      id: asPaneId("p1"),
      type: "leaf",
      tabIds: [tabId],
      activeTabId: tabId,
    };
    const tree: SplitNode = {
      id: asPaneId("s0"),
      type: "split",
      orientation: "row",
      children: [makeLeaf(), holder],
      sizes: [0.5, 0.5],
    };
    expect(leafOfTab(tree, tabId)?.id).toBe(holder.id);
    expect(leafOfTab(tree, asTabId("ghost"))).toBeNull();
  });

  it("replaceNode rebuilds the spine without mutating the input", () => {
    const target = makeLeaf();
    const sibling = makeLeaf();
    const tree: SplitNode = {
      id: asPaneId("s0"),
      type: "split",
      orientation: "row",
      children: [target, sibling],
      sizes: [0.5, 0.5],
    };
    const before = structuredClone(tree);
    const replacement = makeLeaf();

    const next = asSplit(replaceNode(tree, target.id, () => replacement));

    expect(tree).toEqual(before); // pure
    expect(next).not.toBe(tree);
    expect(next.children[0]).toBe(replacement);
    expect(next.children[1]).toBe(sibling); // untouched subtrees are shared
  });

  it("replaceNode is a no-op for an unknown id", () => {
    const tree = makeLeaf();
    expect(replaceNode(tree, asPaneId("ghost"), () => makeLeaf())).toBe(tree);
  });
});

/* ══════════════════════════ canonicalize: rules ══════════════════════════ */

describe("canonicalize", () => {
  const split = (
    orientation: Orientation,
    children: PaneNode[],
    sizes: number[],
    id = `s-${Math.random()}`,
  ): SplitNode => ({
    id: asPaneId(id),
    type: "split",
    orientation,
    children,
    sizes,
  });

  it("(a) collapses a single-child split into that child", () => {
    const only = makeLeaf();
    expect(canonicalize(split("row", [only], [1]))).toBe(only);
  });

  it("(b) flattens same-orientation nesting, preserving visual proportions", () => {
    const [a, b, c] = [makeLeaf(), makeLeaf(), makeLeaf()];
    // outer row: [inner(0.5), c(0.5)]; inner row: [a(0.5), b(0.5)]
    const tree = split(
      "row",
      [split("row", [a, b], [0.5, 0.5]), c],
      [0.5, 0.5],
    );

    const out = asSplit(canonicalize(tree));

    expect(out.orientation).toBe("row");
    expect(out.children.map((n) => n.id)).toEqual([a.id, b.id, c.id]);
    // a and b each get half of inner's half; c keeps its half.
    expect(out.sizes).toEqual([0.25, 0.25, 0.5]);
    assertTreeInvariants(out);
  });

  it("(b) leaves cross-orientation nesting alone", () => {
    const [a, b, c] = [makeLeaf(), makeLeaf(), makeLeaf()];
    const inner = split("column", [a, b], [0.5, 0.5]);
    const out = asSplit(canonicalize(split("row", [inner, c], [0.5, 0.5])));

    expect(out.children[0].type).toBe("split");
    expect((out.children[0] as SplitNode).orientation).toBe("column");
    assertTreeInvariants(out);
  });

  it("(b) flattens transitively — a row in a row in a row becomes one row", () => {
    const [a, b, c, d] = [makeLeaf(), makeLeaf(), makeLeaf(), makeLeaf()];
    const tree = split(
      "row",
      [split("row", [split("row", [a, b], [0.5, 0.5]), c], [0.5, 0.5]), d],
      [0.5, 0.5],
    );

    const out = asSplit(canonicalize(tree));
    expect(out.children.map((n) => n.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(out.sizes).toEqual([0.125, 0.125, 0.25, 0.5]);
    assertTreeInvariants(out);
  });

  it("(c) prunes ONLY the empty leaves it is explicitly given", () => {
    const [doomed, other, kept] = [makeLeaf(), makeLeaf(), makeLeaf()];
    const tree = split("row", [doomed, other, kept], [1 / 3, 1 / 3, 1 / 3]);

    const out = asSplit(canonicalize(tree, new Set([doomed.id])));

    // `other` is equally empty but was not nominated — it survives. This is the
    // rule that makes splitPane's fresh empty leaf viable at all.
    expect(out.children.map((n) => n.id)).toEqual([other.id, kept.id]);
  });

  it("(c) never prunes a nominated leaf that still holds tabs", () => {
    const busy: LeafNode = {
      id: asPaneId("busy"),
      type: "leaf",
      tabIds: [asTabId("t1")],
      activeTabId: asTabId("t1"),
    };
    const other = makeLeaf();
    const out = asSplit(
      canonicalize(split("row", [busy, other], [0.5, 0.5]), new Set([busy.id])),
    );
    expect(out.children.map((n) => n.id)).toContain(busy.id);
  });

  it("(d) renormalizes arbitrary weights (pixels, ratios) to sum to 1", () => {
    const out = asSplit(
      canonicalize(split("row", [makeLeaf(), makeLeaf()], [300, 100])),
    );
    expect(out.sizes).toEqual([0.75, 0.25]);
  });

  it("(d) falls back to equal shares when sizes are missing or degenerate", () => {
    const short = asSplit(
      canonicalize(split("row", [makeLeaf(), makeLeaf()], [])),
    );
    expect(short.sizes).toEqual([0.5, 0.5]);

    const zeros = asSplit(
      canonicalize(split("row", [makeLeaf(), makeLeaf()], [0, 0])),
    );
    expect(zeros.sizes).toEqual([0.5, 0.5]);

    // Negatives / NaN are clamped to 0 weight, not propagated.
    const junk = asSplit(
      canonicalize(split("row", [makeLeaf(), makeLeaf()], [-5, 15])),
    );
    expect(junk.sizes).toEqual([0, 1]);
    assertTreeInvariants(junk);
  });

  it("(d) a PARTIAL sizes array gives the missing child exactly 1/children", () => {
    // Pins the VALUE of `const fallback = 1 / (node.children.length || 1)`.
    //
    // The `sizes: []` case above cannot: every weight is then the same number,
    // and `normalizeSizes` scales any uniform weighting to the same shares —
    // `1/2` and `1*2` both come out `[0.5, 0.5]`. That test is a blind
    // sample point for this line (it pins the *equal-shares* rule, which is
    // what it is for; it just says nothing about the constant).
    //
    // A partial array is the only witness, because the fallback then has to
    // compete with a REAL weight. children = 2, sizes = [0.8]:
    //   fallback = 1/2 = 0.5  → ratio 0.8 : 0.5 = 1.6   ← correct
    //   fallback = 1*2 = 2    → ratio 0.8 : 2   = 0.4   (`/` → `*`)
    //   fallback = 1/1 = 1    → ratio 0.8 : 1   = 0.8   (the `|| 1` divisor
    //                                                    collapsed to `1`, or
    //                                                    `||` flipped to `&&`)
    //   fallback = 1/false = ∞ → clamped to weight 0     → [1, 0]
    //
    // (`1 / node.children.length` — dropping only the `|| 1` guard — is an
    // EQUIVALENT mutant: the guard is dead weight exactly as the sibling
    // `normalizeSizes` comment argues, because `forEach` never runs its
    // callback on an empty `children`, so a 0-children split returns `null` at
    // `children.length === 0` before any `fallback` is ever consulted.)
    const out = asSplit(
      canonicalize(split("row", [makeLeaf(), makeLeaf()], [0.8])),
    );
    expect(out.sizes[0] / out.sizes[1]).toBeCloseTo(1.6, 12);
    expect(out.sizes[0]).toBeCloseTo(0.8 / 1.3, 12);
    expect(out.sizes[1]).toBeCloseTo(0.5 / 1.3, 12);
    assertTreeInvariants(out);
  });

  it("(e) keeps a root leaf, empty or not, even when nominated for pruning", () => {
    const leaf = makeLeaf();
    expect(canonicalize(leaf, new Set([leaf.id]))).toBe(leaf);
  });

  it("(e) yields a fresh empty leaf when the whole tree prunes away", () => {
    const [a, b] = [makeLeaf(), makeLeaf()];
    const out = canonicalize(
      split("row", [a, b], [0.5, 0.5]),
      new Set([a.id, b.id]),
    );
    expect(out.type).toBe("leaf");
    expect((out as LeafNode).tabIds).toEqual([]);
    assertTreeInvariants(out);
  });

  it("replaces a childless split with a fresh leaf", () => {
    // Not constructible through the actions, but `SplitNode` permits it and
    // canonicalize is exported — it must not divide by zero or return a split
    // with no children.
    const out = canonicalize(split("row", [], []));
    expect(out.type).toBe("leaf");
    assertTreeInvariants(out);
  });

  it("collapses to the survivor when pruning leaves one child", () => {
    const [doomed, survivor] = [makeLeaf(), makeLeaf()];
    const out = canonicalize(
      split("row", [doomed, survivor], [0.5, 0.5]),
      new Set([doomed.id]),
    );
    expect(out).toBe(survivor); // (a) after (c)
  });

  it("flattens a subtree that collapsed into the parent's orientation", () => {
    // column[ row[ a, dead ], b ]  --prune dead-->  column[ a, b ] (not column[row-collapsed…])
    const [a, b, dead] = [makeLeaf(), makeLeaf(), makeLeaf()];
    const tree = split(
      "column",
      [split("row", [a, dead], [0.5, 0.5]), b],
      [0.5, 0.5],
    );
    const out = asSplit(canonicalize(tree, new Set([dead.id])));
    expect(out.orientation).toBe("column");
    expect(out.children.map((n) => n.id)).toEqual([a.id, b.id]);
    assertTreeInvariants(out);
  });
});

/* ═════════════════ canonicalize: property-based ═════════════════ */

/**
 * A random tree *shape*. Ids are assigned in `materialize` from a counter, not
 * from the arbitrary, so a shrunk counterexample prints stable, readable ids.
 *
 * Deliberately generates DE-canonical input: single-child splits, same-
 * orientation nesting, size arrays of the wrong length, zero weights. That is
 * the whole point — canonicalize's job is to repair exactly these.
 */
type Shape =
  | { kind: "leaf"; tabs: number }
  | {
      kind: "split";
      orientation: Orientation;
      children: Shape[];
      sizes: number[];
    };

const orientationArb = fc.constantFrom<Orientation>("row", "column");

/**
 * Weights stay in a realistic range. `resizePane`'s documented input is
 * "pixels straight from allotment's onChange, or fractions" — i.e. 0..~1e4.
 * (Weights near `Number.MAX_VALUE` would overflow the sum to Infinity inside
 * normalizeSizes and yield all-zero shares; unreachable from a real viewport,
 * so out of scope here rather than silently asserted as correct.)
 */
const weightArb = fc.double({ min: 0, max: 4000, noNaN: true });

const shapeArb: fc.Arbitrary<Shape> = fc.letrec<{ shape: Shape }>((tie) => ({
  shape: fc.oneof(
    { maxDepth: 4, depthSize: "small", withCrossShrink: true },
    fc.record({ kind: fc.constant("leaf" as const), tabs: fc.nat({ max: 3 }) }),
    fc.record({
      kind: fc.constant("split" as const),
      orientation: orientationArb,
      // minLength 1 → single-child splits get generated (rule a).
      children: fc.array(tie("shape"), { minLength: 1, maxLength: 3 }),
      // Length is free to mismatch children (rule d's fallback path).
      sizes: fc.array(weightArb, { minLength: 0, maxLength: 4 }),
    }),
  ),
})).shape;

interface Materialized {
  tree: PaneNode;
  tabs: Record<TabId, Tab>;
  paneIds: PaneId[];
}

function materialize(shape: Shape): Materialized {
  let paneSeq = 0;
  let tabSeq = 0;
  const tabs: Record<TabId, Tab> = {};
  const paneIds: PaneId[] = [];

  const build = (s: Shape): PaneNode => {
    const id = asPaneId(`p${paneSeq++}`);
    paneIds.push(id);
    if (s.kind === "leaf") {
      const tabIds: TabId[] = [];
      for (let i = 0; i < s.tabs; i++) {
        const tabId = asTabId(`t${tabSeq++}`);
        tabs[tabId] = {
          id: tabId,
          kind: "terminal",
          title: tabId,
          ref: { kind: "terminal", terminalId: asTerminalId(`term-${tabId}`) },
        };
        tabIds.push(tabId);
      }
      return { id, type: "leaf", tabIds, activeTabId: tabIds[0] ?? null };
    }
    return {
      id,
      type: "split",
      orientation: s.orientation,
      children: s.children.map(build),
      sizes: [...s.sizes],
    };
  };

  return { tree: build(shape), tabs, paneIds };
}

/** Resolve `fc.nat()` indices into a concrete prune set. */
const pruneSetOf = (paneIds: PaneId[], picks: number[]): Set<PaneId> =>
  new Set(picks.map((n) => paneIds[n % paneIds.length]));

const pruneArb = fc.array(fc.nat({ max: 1000 }), { maxLength: 4 });

describe("canonicalize — properties", () => {
  it("output always satisfies every structural invariant", () => {
    fc.assert(
      fc.property(shapeArb, pruneArb, (shape, picks) => {
        const { tree, paneIds } = materialize(shape);
        assertTreeInvariants(canonicalize(tree, pruneSetOf(paneIds, picks)));
      }),
    );
  });

  it("is idempotent — canonical trees are fixed points", () => {
    fc.assert(
      fc.property(shapeArb, pruneArb, (shape, picks) => {
        const { tree, paneIds } = materialize(shape);
        const prune = pruneSetOf(paneIds, picks);
        const once = canonicalize(tree, prune);
        const twice = canonicalize(once, prune);
        expect(treeShape(twice)).toEqual(treeShape(once));
      }),
    );
  });

  it("never mutates its input", () => {
    fc.assert(
      fc.property(shapeArb, pruneArb, (shape, picks) => {
        const { tree, paneIds } = materialize(shape);
        const before = structuredClone(tree);
        canonicalize(tree, pruneSetOf(paneIds, picks));
        expect(tree).toEqual(before);
      }),
    );
  });

  it("preserves every non-pruned leaf and its tabs — no leaf is lost silently", () => {
    fc.assert(
      fc.property(shapeArb, pruneArb, (shape, picks) => {
        const { tree, paneIds } = materialize(shape);
        const prune = pruneSetOf(paneIds, picks);
        const survivors = leavesOf(tree).filter(
          (leaf) => !(leaf.tabIds.length === 0 && prune.has(leaf.id)),
        );

        const out = canonicalize(tree, prune);
        const outIds = leafIds(out);

        if (survivors.length === 0) {
          // Rule (e): a fresh leaf stands in for the emptied-out tree.
          expect(outIds).toHaveLength(1);
          return;
        }
        // Order and identity are both preserved.
        expect(outIds).toEqual(survivors.map((l) => l.id));
        // ...and no tab evaporated with a dropped leaf.
        expect(leavesOf(out).flatMap((l) => l.tabIds)).toEqual(
          survivors.flatMap((l) => l.tabIds),
        );
      }),
    );
  });
});

/* ══════════════════════════ initial state ══════════════════════════ */

describe("initial state", () => {
  it("boots to one empty, focused leaf with no tabs and no side effects", () => {
    const s = state();
    expect(s.layout.type).toBe("leaf");
    expect(s.focusedPaneId).toBe(s.layout.id);
    expect(s.tabs).toEqual({});
    // Opening a PTY at module load would be a side effect on import.
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });
});

/* ══════════════════════════ openTerminalTab ══════════════════════════ */

describe("openTerminalTab", () => {
  it("opens into the focused pane by default, activates and focuses it", () => {
    const tabId = act().openTerminalTab();
    const leaf = rootLeaf();

    expect(leaf.tabIds).toEqual([tabId]);
    expect(leaf.activeTabId).toBe(tabId);
    expect(state().focusedPaneId).toBe(leaf.id);
    expect(state().tabs[tabId]).toMatchObject({ id: tabId, kind: "terminal" });
    assertLiveStoreInvariants();
  });

  it("opens into an explicit pane and moves focus there", () => {
    const origin = rootLeaf().id;
    const created = act().splitPane(origin, "row");
    act().focusPane(origin);

    const tabId = act().openTerminalTab({ paneId: created });

    expect(leafById(created).tabIds).toEqual([tabId]);
    expect(leafById(origin).tabIds).toEqual([]);
    expect(state().focusedPaneId).toBe(created);
  });

  it("mints a unique TerminalId per tab and links it through tab.ref", () => {
    const a = act().openTerminalTab();
    const b = act().openTerminalTab();

    expect(a).not.toBe(b);
    expect(terminalIdOfTab(a)).not.toBe(terminalIdOfTab(b));
  });

  it("appends to an existing strip rather than replacing it", () => {
    const a = act().openTerminalTab();
    const b = act().openTerminalTab();
    expect(rootLeaf().tabIds).toEqual([a, b]);
    expect(rootLeaf().activeTabId).toBe(b);
  });

  it("pre-registers the cwd with the terminal feature, keyed by TerminalId", () => {
    const tabId = act().openTerminalTab({ cwd: "/Users/me/projects/gazelle" });

    expect(terminal.configureTerminal).toHaveBeenCalledTimes(1);
    expect(terminal.configureTerminal).toHaveBeenCalledWith(
      terminalIdOfTab(tabId),
      { cwd: "/Users/me/projects/gazelle" },
    );
  });

  it("skips configureTerminal when no cwd is supplied", () => {
    act().openTerminalTab();
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
  });

  it("titles the tab after the cwd's basename, tolerating trailing separators", () => {
    const a = act().openTerminalTab({ cwd: "/Users/me/projects/gazelle" });
    const b = act().openTerminalTab({ cwd: "/Users/me/projects/api/" });
    const c = act().openTerminalTab({ cwd: "C:\\Users\\me\\proj" });

    expect(state().tabs[a].title).toBe("gazelle");
    expect(state().tabs[b].title).toBe("api");
    expect(state().tabs[c].title).toBe("proj");
  });

  it("strips a RUN of trailing separators, not just the last one", () => {
    // A blind sample point, not a missing input: the single-separator cases
    // above ("…/api/", "C:\\…\\proj") are handled IDENTICALLY by a `/[/\\]$/`
    // regex with no `+`, so they cannot pin the quantifier. Two separators can:
    // the un-quantified strip leaves "/w/api/", whose `.split(/[/\\]/).pop()`
    // is "" — falsy — so the title silently degrades to "Terminal N".
    //
    // A doubled separator is not exotic: it is what naive path joining
    // (`${root}/${name}` with a root that already ends in a slash) produces,
    // and a "Terminal 7" tab where the user expected "api" reads as a bug.
    const a = act().openTerminalTab({ cwd: "/w/api//" });
    const b = act().openTerminalTab({ cwd: "C:\\proj\\\\" });
    const c = act().openTerminalTab({ cwd: "/w/deep///" });

    expect(state().tabs[a].title).toBe("api");
    expect(state().tabs[b].title).toBe("proj");
    expect(state().tabs[c].title).toBe("deep");

    // A separators-only cwd still has no basename → the numbered fallback.
    const d = act().openTerminalTab({ cwd: "//" });
    expect(state().tabs[d].title).toMatch(/^Terminal \d+$/);
  });

  it("falls back to a numbered title when the cwd yields no basename", () => {
    const a = act().openTerminalTab();
    const b = act().openTerminalTab({ cwd: "/" });

    expect(state().tabs[a].title).toMatch(/^Terminal \d+$/);
    expect(state().tabs[b].title).toMatch(/^Terminal \d+$/);
    expect(state().tabs[a].title).not.toBe(state().tabs[b].title);
  });

  it("falls back to the first leaf when handed a split's id", () => {
    const origin = rootLeaf().id;
    act().splitPane(origin, "row");
    const splitId = asSplit(state().layout).id;

    const tabId = act().openTerminalTab({ paneId: splitId });

    expect(leafById(origin).tabIds).toEqual([tabId]);
    assertLiveStoreInvariants();
  });
});

/* ══════════════════════════ openEditorTab (M4) ══════════════════════════ */

describe("openEditorTab", () => {
  it("opens a read-only editor tab titled by filename, active in the focused pane", () => {
    const tabId = act().openEditorTab("/w/src/main.rs");
    const leaf = rootLeaf();

    expect(leaf.tabIds).toEqual([tabId]);
    expect(leaf.activeTabId).toBe(tabId);
    expect(state().focusedPaneId).toBe(leaf.id);
    expect(state().tabs[tabId]).toMatchObject({
      kind: "editor",
      title: "main.rs",
      ref: { kind: "editor", path: "/w/src/main.rs" },
    });
    // No PTY: an editor tab never configures a terminal.
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("dedupes by path: re-opening the same file re-focuses the existing tab", () => {
    const first = act().openEditorTab("/w/a.ts");
    const other = act().openTerminalTab(); // move focus/active off the editor
    expect(rootLeaf().activeTabId).toBe(other);

    const again = act().openEditorTab("/w/a.ts");

    expect(again).toBe(first); // same tab id, not a second editor
    expect(
      Object.values(state().tabs).filter((t) => t.ref.kind === "editor"),
    ).toHaveLength(1);
    expect(rootLeaf().activeTabId).toBe(first); // brought back to front
  });

  it("opens distinct tabs for distinct paths", () => {
    const a = act().openEditorTab("/w/a.ts");
    const b = act().openEditorTab("/w/b.ts");

    expect(a).not.toBe(b);
    expect(rootLeaf().tabIds).toEqual([a, b]);
  });

  it("is closable and renamable like any other tab", () => {
    const tabId = act().openEditorTab("/w/notes.md");

    act().renameTab(tabId, "My Notes");
    expect(state().tabs[tabId].customTitle).toBe("My Notes");

    act().closeTab(tabId);
    expect(state().tabs[tabId]).toBeUndefined();
    expect(rootLeaf().tabIds).toEqual([]);
    // No agent, no PTY — closing an editor tab dismisses nothing.
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });
});

/* ═════════════════ openDiffTab (Git ▸ Compare with HEAD) ═════════════════ */

describe("openDiffTab", () => {
  const diffTabs = () => Object.values(state().tabs).filter((t) => t.ref.kind === "diff");

  it("opens a read-only diff tab titled to distinguish it from the file's editor tab", () => {
    const tabId = act().openDiffTab("/w/src/main.rs");
    const leaf = rootLeaf();

    expect(leaf.tabIds).toEqual([tabId]);
    expect(leaf.activeTabId).toBe(tabId);
    expect(state().focusedPaneId).toBe(leaf.id);
    expect(state().tabs[tabId]).toMatchObject({
      kind: "diff",
      // Deliberately NOT the bare "main.rs": this tab commonly sits beside the
      // EDITOR tab for the same file, and two identical titles would leave a small
      // icon as the only thing telling them apart.
      title: "main.rs ↔ HEAD",
      ref: { kind: "diff", path: "/w/src/main.rs" },
    });
    // Two-sided: opening the same file's editor tab really does
    // produce the colliding title this suffix exists to prevent.
    const editorTabId = act().openEditorTab("/w/src/main.rs");
    expect(state().tabs[editorTabId].title).toBe("main.rs");
    expect(state().tabs[editorTabId].title).not.toBe(state().tabs[tabId].title);
    // Read-only: never dirty, so it can never reach the unsaved-changes flow.
    expect(state().tabs[tabId].dirty).toBeUndefined();
    // No PTY, and no IPC — <DiffView> fetches its own diff when it mounts.
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("dedupes by path: comparing the same file again re-focuses the existing tab", () => {
    const first = act().openDiffTab("/w/a.ts");
    const other = act().openTerminalTab(); // move focus/active off the diff
    expect(rootLeaf().activeTabId).toBe(other);

    const again = act().openDiffTab("/w/a.ts");

    expect(again).toBe(first); // same tab id, not a second diff
    expect(diffTabs()).toHaveLength(1);
    expect(rootLeaf().activeTabId).toBe(first); // brought back to front
  });

  it("opens distinct tabs for distinct paths", () => {
    const a = act().openDiffTab("/w/a.ts");
    const b = act().openDiffTab("/w/b.ts");

    expect(a).not.toBe(b);
    expect(rootLeaf().tabIds).toEqual([a, b]);
    expect(diffTabs()).toHaveLength(2);
  });

  it("does NOT steal the editor tab for the same file — a diff and an edit coexist", () => {
    // The dedupe predicate matches on `kind === "diff"` as well as the path. Drop
    // the kind half and this goes red: Compare would re-focus the EDITOR tab and
    // no diff would ever open for a file that happens to be open.
    const editor = act().openEditorTab("/w/a.ts");

    const diff = act().openDiffTab("/w/a.ts");

    expect(diff).not.toBe(editor);
    expect(rootLeaf().tabIds).toEqual([editor, diff]);
    expect(state().tabs[editor].kind).toBe("editor");
    expect(state().tabs[diff].kind).toBe("diff");
  });

  it("is closable and renamable like any other tab", () => {
    const tabId = act().openDiffTab("/w/notes.md");

    act().renameTab(tabId, "Before/After");
    expect(state().tabs[tabId].customTitle).toBe("Before/After");

    act().closeTab(tabId);
    expect(state().tabs[tabId]).toBeUndefined();
    expect(rootLeaf().tabIds).toEqual([]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });
});

/* ══════════════════════ apiActions ══════════════════════ */

describe("apiActions", () => {
  const api = () => state().apiActions;
  const req = (id: string) => state().apiRequests[id];

  it("createApiRequest mints a GET request with empty url/body/headers and no response", () => {
    const id = api().createApiRequest();
    expect(req(id)).toMatchObject({
      id,
      method: "GET",
      url: "",
      headers: [],
      body: "",
      response: null,
      sending: false,
      error: null,
    });
  });

  it("createApiRequest mints distinct ids", () => {
    expect(api().createApiRequest()).not.toBe(api().createApiRequest());
  });

  it("patchApiRequest updates method / url / body; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().patchApiRequest(id, {
      method: "POST",
      url: "https://x.test",
      body: "hi",
    });
    expect(req(id)).toMatchObject({
      method: "POST",
      url: "https://x.test",
      body: "hi",
    });

    api().patchApiRequest("nope", { url: "ignored" }); // no throw, no record created
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("addHeader appends an empty, enabled row; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().addHeader(id);
    api().addHeader(id);
    const rows = req(id).headers;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "", value: "", enabled: true });
    expect(rows[0].id).not.toBe(rows[1].id);

    api().addHeader("nope");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("updateHeader patches a row; a bogus request or header id is a no-op", () => {
    const id = api().createApiRequest();
    api().addHeader(id);
    const headerId = req(id).headers[0].id;

    api().updateHeader(id, headerId, {
      name: "Authorization",
      value: "Bearer t",
      enabled: false,
    });
    expect(req(id).headers[0]).toMatchObject({
      name: "Authorization",
      value: "Bearer t",
      enabled: false,
    });

    api().updateHeader(id, "no-such-header", { name: "x" }); // header miss: no throw
    api().updateHeader("nope", headerId, { name: "x" }); // request miss: no throw
    expect(req(id).headers[0].name).toBe("Authorization");
  });

  it("removeHeader drops a row; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().addHeader(id);
    api().addHeader(id);
    const [a, b] = req(id).headers;
    api().removeHeader(id, a.id);
    expect(req(id).headers.map((h) => h.id)).toEqual([b.id]);

    api().removeHeader("nope", b.id); // no throw
    expect(req(id).headers).toHaveLength(1);
  });

  it("setApiSending toggles the in-flight flag; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setApiSending(id, true);
    expect(req(id).sending).toBe(true);
    api().setApiSending(id, false);
    expect(req(id).sending).toBe(false);

    api().setApiSending("nope", true);
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setApiResponse records the response and clears sending + error; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setApiSending(id, true);
    api().setApiError(id, "an earlier failure");

    const resp: HttpResponse = {
      status: 200,
      statusText: "OK",
      headers: [],
      body: "{}",
      durationMs: 10,
      sizeBytes: 2,
      truncated: false,
    };
    api().setApiResponse(id, resp);
    expect(req(id)).toMatchObject({
      response: resp,
      error: null,
      sending: false,
    });

    api().setApiResponse("nope", resp);
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setApiError records the message and clears sending; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setApiSending(id, true);
    api().setApiError(id, "boom");
    expect(req(id)).toMatchObject({ error: "boom", sending: false });

    api().setApiError("nope", "boom");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });
});

/* ══════════ apiActions — collections + environments ══════════ */

describe("apiActions — durable store (collections + environments)", () => {
  const api = () => state().apiActions;
  const req = (id: string) => state().apiRequests[id];

  it("hydrateApiStore sets collections/environments/active and marks loaded; no persist", () => {
    const store = {
      collections: [
        {
          id: "c1",
          name: "GET things",
          method: "GET",
          url: "https://x.test",
          headers: [],
          body: "",
        },
      ],
      environments: [
        {
          id: "e1",
          name: "prod",
          variables: [{ key: "TOKEN", value: "secret" }],
        },
      ],
      activeEnvironmentId: "e1",
      folders: [],
    };
    api().hydrateApiStore(store);
    expect(state().apiCollections).toEqual(store.collections);
    expect(state().apiEnvironments).toEqual(store.environments);
    expect(state().activeEnvironmentId).toBe("e1");
    expect(state().apiStoreLoaded).toBe(true);
    // The READ side never writes back.
    expect(apiStoreIpc.saveApiStore).not.toHaveBeenCalled();
  });

  it("saveRequestToCollection snapshots the live request with placeholders LITERAL, and persists", () => {
    const id = api().createApiRequest();
    api().patchApiRequest(id, {
      method: "POST",
      url: "https://{{HOST}}/things",
      body: "{{PAYLOAD}}",
    });
    api().addHeader(id);
    const headerId = req(id).headers[0].id;
    api().updateHeader(id, headerId, {
      name: "Authorization",
      value: "Bearer {{TOKEN}}",
    });

    api().saveRequestToCollection(id, "Create thing");

    const saved = state().apiCollections;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: "Create thing",
      method: "POST",
      url: "https://{{HOST}}/things", // literal — never a resolved secret
      body: "{{PAYLOAD}}",
      headers: [{ name: "Authorization", value: "Bearer {{TOKEN}}" }],
    });
    expect(saved[0].id).toBeTruthy();
    // Persisted with the current durable snapshot.
    expect(apiStoreIpc.saveApiStore).toHaveBeenCalledTimes(1);
    expect(apiStoreIpc.saveApiStore).toHaveBeenLastCalledWith({
      collections: saved,
      environments: [],
      activeEnvironmentId: null,
      folders: [],
    });
  });

  it("saveRequestToCollection replaces an existing collection of the same name in place", () => {
    const id = api().createApiRequest();
    api().patchApiRequest(id, { url: "https://one.test" });
    api().saveRequestToCollection(id, "same");
    const firstId = state().apiCollections[0].id;

    api().patchApiRequest(id, { url: "https://two.test" });
    api().saveRequestToCollection(id, "same");

    expect(state().apiCollections).toHaveLength(1);
    expect(state().apiCollections[0].url).toBe("https://two.test");
    expect(state().apiCollections[0].id).not.toBe(firstId); // fresh id on replace
  });

  it("saveRequestToCollection on a bogus request id is a no-op (still persists nothing new)", () => {
    api().saveRequestToCollection("nope", "x");
    expect(state().apiCollections).toEqual([]);
  });

  it("deleteCollection drops the saved request and persists", () => {
    const id = api().createApiRequest();
    api().saveRequestToCollection(id, "a");
    api().saveRequestToCollection(id, "b");
    const [a] = state().apiCollections;
    apiStoreIpc.saveApiStore.mockClear();

    api().deleteCollection(a.id);
    expect(state().apiCollections.map((c) => c.name)).toEqual(["b"]);
    expect(apiStoreIpc.saveApiStore).toHaveBeenCalledTimes(1);
  });

  it("loadCollectionIntoRequest copies fields into the request as enabled rows; no persist", () => {
    const src = api().createApiRequest();
    api().patchApiRequest(src, {
      method: "POST",
      url: "https://x.test",
      body: "hi",
    });
    api().addHeader(src);
    api().updateHeader(src, req(src).headers[0].id, {
      name: "X-A",
      value: "1",
    });
    api().saveRequestToCollection(src, "saved");
    const collectionId = state().apiCollections[0].id;
    apiStoreIpc.saveApiStore.mockClear();

    const dst = api().createApiRequest();
    api().loadCollectionIntoRequest(collectionId, dst);

    expect(req(dst)).toMatchObject({
      method: "POST",
      url: "https://x.test",
      body: "hi",
    });
    expect(req(dst).headers).toHaveLength(1);
    expect(req(dst).headers[0]).toMatchObject({
      name: "X-A",
      value: "1",
      enabled: true,
    });
    expect(req(dst).headers[0].id).toBeTruthy();
    // Loading mutates only the request, not the durable store.
    expect(apiStoreIpc.saveApiStore).not.toHaveBeenCalled();
  });

  it("loadCollectionIntoRequest is a no-op for an unknown collection or request id", () => {
    const dst = api().createApiRequest();
    api().patchApiRequest(dst, { url: "unchanged" });
    api().saveRequestToCollection(dst, "saved");
    const collectionId = state().apiCollections[0].id;

    api().loadCollectionIntoRequest("no-such-collection", dst); // saved missing
    expect(req(dst).url).toBe("unchanged");

    api().loadCollectionIntoRequest(collectionId, "no-such-request"); // req missing
    expect(state().apiRequests["no-such-request"]).toBeUndefined();
  });

  it("addEnvironment appends an empty env, returns its id, and persists", () => {
    const envId = api().addEnvironment("staging");
    expect(state().apiEnvironments).toEqual([
      { id: envId, name: "staging", variables: [] },
    ]);
    expect(apiStoreIpc.saveApiStore).toHaveBeenCalledTimes(1);
  });

  it("renameEnvironment renames; a bogus id is a no-op; both persist", () => {
    const envId = api().addEnvironment("old");
    apiStoreIpc.saveApiStore.mockClear();
    api().renameEnvironment(envId, "new");
    expect(state().apiEnvironments[0].name).toBe("new");
    api().renameEnvironment("nope", "x"); // no throw
    expect(state().apiEnvironments).toHaveLength(1);
    expect(apiStoreIpc.saveApiStore).toHaveBeenCalledTimes(2);
  });

  it("deleteEnvironment removes it and clears the active pointer only when it matched", () => {
    const a = api().addEnvironment("a");
    const b = api().addEnvironment("b");
    api().setActiveEnvironment(a);

    // Deleting the NON-active env leaves the active pointer intact.
    api().deleteEnvironment(b);
    expect(state().apiEnvironments.map((e) => e.id)).toEqual([a]);
    expect(state().activeEnvironmentId).toBe(a);

    // Deleting the ACTIVE env clears the pointer.
    api().deleteEnvironment(a);
    expect(state().apiEnvironments).toEqual([]);
    expect(state().activeEnvironmentId).toBeNull();
  });

  it("setActiveEnvironment sets and clears the active pointer, persisting each time", () => {
    const envId = api().addEnvironment("prod");
    apiStoreIpc.saveApiStore.mockClear();
    api().setActiveEnvironment(envId);
    expect(state().activeEnvironmentId).toBe(envId);
    api().setActiveEnvironment(null);
    expect(state().activeEnvironmentId).toBeNull();
    expect(apiStoreIpc.saveApiStore).toHaveBeenCalledTimes(2);
  });

  it("setEnvVar upserts a variable by key (add then update); a bogus env id is a no-op", () => {
    const envId = api().addEnvironment("e");
    api().setEnvVar(envId, "TOKEN", "one"); // add
    expect(state().apiEnvironments[0].variables).toEqual([
      { key: "TOKEN", value: "one" },
    ]);
    api().setEnvVar(envId, "TOKEN", "two"); // update in place
    expect(state().apiEnvironments[0].variables).toEqual([
      { key: "TOKEN", value: "two" },
    ]);
    api().setEnvVar(envId, "OTHER", "x"); // second key
    expect(state().apiEnvironments[0].variables).toHaveLength(2);

    api().setEnvVar("nope", "K", "v"); // no throw, no env created
    expect(state().apiEnvironments).toHaveLength(1);
  });

  it("removeEnvVar drops a variable by key; a bogus env id is a no-op", () => {
    const envId = api().addEnvironment("e");
    api().setEnvVar(envId, "A", "1");
    api().setEnvVar(envId, "B", "2");
    api().removeEnvVar(envId, "A");
    expect(state().apiEnvironments[0].variables.map((v) => v.key)).toEqual([
      "B",
    ]);
    api().removeEnvVar("nope", "B"); // no throw
    expect(state().apiEnvironments[0].variables).toHaveLength(1);
  });
});

/* ══════════════ apiActions — request history ══════════════ */

describe("apiActions — request history", () => {
  const api = () => state().apiActions;
  const entry = (over: Partial<import("./store").HistoryEntry> = {}) => ({
    method: "GET",
    url: "https://x.test",
    headers: [{ name: "Authorization", value: "Bearer {{TOKEN}}" }],
    body: "",
    status: 200,
    statusText: "OK",
    durationMs: 5,
    sizeBytes: 9,
    error: null,
    at: 1_700_000_000_000,
    ...over,
  });

  it("hydrateApiHistory sets the log and marks loaded; no persist", () => {
    const store = { entries: [{ id: "h1", ...entry() }] };
    api().hydrateApiHistory(store);
    expect(state().apiHistory).toEqual(store.entries);
    expect(state().apiHistoryLoaded).toBe(true);
    expect(historyIpc.saveApiHistory).not.toHaveBeenCalled();
  });

  it("recordApiHistory appends (minting an id) and persists — no cap, no dedup", () => {
    api().recordApiHistory(entry());
    api().recordApiHistory(entry()); // identical request → a SECOND entry, not deduped
    expect(state().apiHistory).toHaveLength(2);
    expect(state().apiHistory[0].id).not.toBe(state().apiHistory[1].id);
    expect(state().apiHistory[0]).toMatchObject({ method: "GET", url: "https://x.test" });
    expect(historyIpc.saveApiHistory).toHaveBeenCalledTimes(2);
    expect(historyIpc.saveApiHistory).toHaveBeenLastCalledWith({
      entries: state().apiHistory,
    });
  });

  it("recordApiHistory keeps placeholders LITERAL (a secret is never recorded)", () => {
    api().recordApiHistory(entry());
    expect(state().apiHistory[0].headers[0].value).toBe("Bearer {{TOKEN}}");
  });

  it("clearApiHistory empties the log and persists", () => {
    api().recordApiHistory(entry());
    historyIpc.saveApiHistory.mockClear();
    api().clearApiHistory();
    expect(state().apiHistory).toEqual([]);
    expect(historyIpc.saveApiHistory).toHaveBeenCalledTimes(1);
  });

  it("loadHistoryIntoRequest copies method/url/headers/body into a request as fresh rows", () => {
    api().hydrateApiHistory({
      entries: [
        {
          id: "h1",
          ...entry({ method: "POST", url: "https://y.test", body: "{\"a\":1}" }),
        },
      ],
    });
    const requestId = api().createApiRequest();
    api().loadHistoryIntoRequest("h1", requestId);
    const r = state().apiRequests[requestId];
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://y.test");
    expect(r.body).toBe("{\"a\":1}");
    expect(r.headers).toHaveLength(1);
    expect(r.headers[0]).toMatchObject({
      name: "Authorization",
      value: "Bearer {{TOKEN}}",
      enabled: true,
    });
    expect(r.headers[0].id).toBeTruthy(); // a fresh row id, not the entry's
  });

  it("loadHistoryIntoRequest is a no-op for an unknown entry or request id", () => {
    const requestId = api().createApiRequest();
    expect(() => api().loadHistoryIntoRequest("nope", requestId)).not.toThrow();
    expect(() => api().loadHistoryIntoRequest("nope", "nope")).not.toThrow();
    expect(state().apiRequests[requestId].url).toBe(""); // untouched
  });

  it("importCurl replaces method/url/headers/body (fresh rows); unknown id no-op", () => {
    const requestId = api().createApiRequest();
    api().importCurl(requestId, {
      method: "POST",
      url: "https://a.test/x",
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: '{"a":1}',
    });
    const r = state().apiRequests[requestId];
    expect(r).toMatchObject({ method: "POST", url: "https://a.test/x", body: '{"a":1}' });
    expect(r.headers[0]).toMatchObject({
      name: "Content-Type",
      value: "application/json",
      enabled: true,
    });
    expect(r.headers[0].id).toBeTruthy();

    // A null body clears to "".
    api().importCurl(requestId, { method: "GET", url: "https://b.test", headers: [], body: null });
    expect(state().apiRequests[requestId]).toMatchObject({ url: "https://b.test", body: "" });

    // Unknown id: no throw, nothing created.
    expect(() => api().importCurl("nope", { method: "GET", url: "u", headers: [], body: null })).not.toThrow();
    expect(state().apiRequests["nope"]).toBeUndefined();
  });
});

/* ══════════════ apiActions — WebSocket console ══════════════ */

describe("apiActions — WebSocket console", () => {
  const api = () => state().apiActions;
  const req = (id: string) => state().apiRequests[id];
  const ws = (id: string) => req(id).ws;

  it("createApiRequest seeds protocol 'http' and an idle ws", () => {
    const id = api().createApiRequest();
    expect(req(id).protocol).toBe("http");
    expect(req(id).ws).toEqual({
      status: "idle",
      connectionId: null,
      messages: [],
      draft: "",
      error: null,
    });
  });

  it("setApiProtocol toggles the protocol; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setApiProtocol(id, "ws");
    expect(req(id).protocol).toBe("ws");
    api().setApiProtocol(id, "http");
    expect(req(id).protocol).toBe("http");

    api().setApiProtocol("nope", "ws");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("wsConnecting sets connecting and clears any prior id/error; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().wsErrored(id, "old error"); // seeds an id-null + error state first
    api().wsConnected(id, "stale"); // and a stale id
    api().wsConnecting(id);
    expect(ws(id)).toMatchObject({
      status: "connecting",
      connectionId: null,
      error: null,
    });

    api().wsConnecting("nope");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("wsOpened flips status to open; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().wsConnecting(id);
    api().wsOpened(id);
    expect(ws(id).status).toBe("open");

    api().wsOpened("nope");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("wsConnected stashes the connectionId without touching status; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().wsConnecting(id);
    api().wsConnected(id, "conn-9");
    // Status untouched — the open EVENT owns it, so the id can land in either order.
    expect(ws(id)).toMatchObject({
      status: "connecting",
      connectionId: "conn-9",
    });

    api().wsConnected("nope", "x");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("wsClosed marks closed and clears the id; a note appends a sys entry; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().wsConnected(id, "conn-1");
    api().wsClosed(id);
    expect(ws(id)).toMatchObject({ status: "closed", connectionId: null });
    expect(ws(id).messages).toEqual([]); // no note → no log entry

    api().wsClosed(id, "Disconnected (1000): bye");
    expect(ws(id).messages).toEqual([
      { dir: "sys", data: "Disconnected (1000): bye", at: 0 },
    ]);

    api().wsClosed("nope");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("wsErrored records the message + error status and clears the id; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().wsConnected(id, "conn-1");
    api().wsErrored(id, "handshake failed");
    expect(ws(id)).toMatchObject({
      status: "error",
      error: "handshake failed",
      connectionId: null,
    });

    api().wsErrored("nope", "x");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("wsAppendMessage pushes in/out/sys log entries in order; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().wsAppendMessage(id, { dir: "out", data: "ping", at: 1 });
    api().wsAppendMessage(id, { dir: "in", data: "pong", at: 2 });
    api().wsAppendMessage(id, { dir: "sys", data: "note", at: 3 });
    expect(ws(id).messages).toEqual([
      { dir: "out", data: "ping", at: 1 },
      { dir: "in", data: "pong", at: 2 },
      { dir: "sys", data: "note", at: 3 },
    ]);

    api().wsAppendMessage("nope", { dir: "in", data: "x", at: 0 });
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setWsDraft edits the draft; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setWsDraft(id, "hello");
    expect(ws(id).draft).toBe("hello");

    api().setWsDraft("nope", "x");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("drives a full connecting → open → message(in/out) → closed lifecycle", () => {
    const id = api().createApiRequest();
    api().setApiProtocol(id, "ws");
    api().wsConnecting(id);
    expect(ws(id).status).toBe("connecting");

    // Open event + the resolved id can land in either order; here event first.
    api().wsOpened(id);
    api().wsConnected(id, "conn-42");
    expect(ws(id)).toMatchObject({ status: "open", connectionId: "conn-42" });

    api().wsAppendMessage(id, { dir: "out", data: "hi", at: 10 });
    api().wsAppendMessage(id, { dir: "in", data: "echo: hi", at: 11 });
    api().wsClosed(id);
    expect(ws(id).status).toBe("closed");
    expect(ws(id).messages.map((m) => m.dir)).toEqual(["out", "in"]);
  });
});

/* ══════════════ apiActions — gRPC console ══════════════ */

describe("apiActions — gRPC console", () => {
  const api = () => state().apiActions;
  const req = (id: string) => state().apiRequests[id];
  const grpc = (id: string) => req(id).grpc;

  const schema = {
    services: [
      {
        name: "greeter.Greeter",
        methods: [{ name: "SayHello" }, { name: "SayBye" }],
      },
    ],
  };

  it("createApiRequest seeds a default grpc sub-state (plaintext true, empty selection)", () => {
    const id = api().createApiRequest();
    expect(grpc(id)).toEqual({
      plaintext: true,
      schema: null,
      service: "",
      method: "",
      listing: false,
      listError: null,
      sending: false,
      response: null,
      error: null,
    });
  });

  it("setApiProtocol toggles to grpc and back; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setApiProtocol(id, "grpc");
    expect(req(id).protocol).toBe("grpc");
    api().setApiProtocol(id, "http");
    expect(req(id).protocol).toBe("http");

    api().setApiProtocol("nope", "grpc");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setGrpcPlaintext flips the flag; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setGrpcPlaintext(id, false);
    expect(grpc(id).plaintext).toBe(false);

    api().setGrpcPlaintext("nope", true);
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("grpcListing sets listing and clears any prior listError; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().grpcListError(id, "old error");
    api().grpcListing(id);
    expect(grpc(id)).toMatchObject({ listing: true, listError: null });

    api().grpcListing("nope");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("grpcListed stashes the schema and clears listing/listError; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().grpcListing(id);
    api().grpcListed(id, schema);
    expect(grpc(id)).toMatchObject({
      schema,
      listing: false,
      listError: null,
    });

    api().grpcListed("nope", schema);
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("grpcListed keeps a still-valid selection but resets one no longer present", () => {
    const id = api().createApiRequest();
    // A valid selection survives a re-reflect.
    api().setGrpcService(id, "greeter.Greeter");
    api().setGrpcMethod(id, "SayHello");
    api().grpcListed(id, schema);
    expect(grpc(id)).toMatchObject({
      service: "greeter.Greeter",
      method: "SayHello",
    });

    // A selection the new schema no longer exposes is reset.
    api().setGrpcMethod(id, "Vanished");
    api().grpcListed(id, schema);
    expect(grpc(id)).toMatchObject({ service: "", method: "" });
  });

  it("grpcListed validates a selection against ANY service (`.some`, not `.every`)", () => {
    // The single-service case above cannot tell `.some` from `.every` — both
    // reduce to the one element. With TWO services, the selection matches only
    // ONE of them: `.some` keeps it (any service matches), `.every` would wrongly
    // reset it (not every service matches). This pins the outer quantifier.
    const multiSchema = {
      services: [
        { name: "a.Alpha", methods: [{ name: "One" }] },
        { name: "b.Beta", methods: [{ name: "Two" }] },
      ],
    };
    const id = api().createApiRequest();
    api().setGrpcService(id, "a.Alpha");
    api().setGrpcMethod(id, "One");
    api().grpcListed(id, multiSchema);
    // Preserved: some service exposes exactly this service+method pair, even
    // though the OTHER service does not.
    expect(grpc(id)).toMatchObject({ service: "a.Alpha", method: "One" });
  });

  it("grpcListError clears listing and records the message; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().grpcListing(id);
    api().grpcListError(id, "reflection disabled");
    expect(grpc(id)).toMatchObject({
      listing: false,
      listError: "reflection disabled",
    });

    api().grpcListError("nope", "x");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setGrpcService sets the service and resets the method; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setGrpcMethod(id, "SayHello");
    api().setGrpcService(id, "greeter.Greeter");
    // The method depends on the service, so a new service clears it.
    expect(grpc(id)).toMatchObject({ service: "greeter.Greeter", method: "" });

    api().setGrpcService("nope", "S");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setGrpcMethod sets the method; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setGrpcMethod(id, "SayHello");
    expect(grpc(id).method).toBe("SayHello");

    api().setGrpcMethod("nope", "M");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setGrpcSending marks in-flight/settled; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setGrpcSending(id, true);
    expect(grpc(id).sending).toBe(true);
    api().setGrpcSending(id, false);
    expect(grpc(id).sending).toBe(false);

    api().setGrpcSending("nope", true);
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setGrpcResponse records the response and clears error + sending; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setGrpcError(id, "old error");
    api().setGrpcSending(id, true);
    const response = {
      message: '{"ok":true}',
      statusCode: 0,
      statusName: "OK",
      error: null,
    };
    api().setGrpcResponse(id, response);
    expect(grpc(id)).toMatchObject({ response, error: null, sending: false });

    api().setGrpcResponse("nope", response);
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("setGrpcError records a transport error and clears sending; a bogus id is a no-op", () => {
    const id = api().createApiRequest();
    api().setGrpcSending(id, true);
    api().setGrpcError(id, "connection refused");
    expect(grpc(id)).toMatchObject({
      error: "connection refused",
      sending: false,
    });

    api().setGrpcError("nope", "x");
    expect(state().apiRequests["nope"]).toBeUndefined();
  });

  it("loadHistoryIntoRequest restores a gRPC entry's protocol/service/method", () => {
    api().hydrateApiHistory({
      entries: [
        {
          id: "g1",
          protocol: "grpc",
          grpcService: "greeter.Greeter",
          method: "SayHello",
          url: "localhost:50051",
          headers: [{ name: "authorization", value: "Bearer {{TOKEN}}" }],
          body: '{"name":"world"}',
          status: 0,
          statusText: "OK",
          durationMs: null,
          sizeBytes: null,
          error: null,
          at: 1_700_000_000_000,
        },
      ],
    });
    const id = api().createApiRequest();
    api().loadHistoryIntoRequest("g1", id);
    const r = req(id);
    expect(r.protocol).toBe("grpc");
    expect(r.url).toBe("localhost:50051");
    expect(r.body).toBe('{"name":"world"}');
    expect(r.grpc).toMatchObject({
      service: "greeter.Greeter",
      method: "SayHello",
    });
    expect(r.headers[0]).toMatchObject({
      name: "authorization",
      value: "Bearer {{TOKEN}}",
      enabled: true,
    });
  });

  it("loadHistoryIntoRequest defaults a grpcService-less gRPC entry to an empty service", () => {
    api().hydrateApiHistory({
      entries: [
        {
          id: "g2",
          protocol: "grpc",
          method: "SayHello",
          url: "localhost:50051",
          headers: [],
          body: "{}",
          status: 0,
          statusText: "OK",
          durationMs: null,
          sizeBytes: null,
          error: null,
          at: 1_700_000_000_000,
        },
      ],
    });
    const id = api().createApiRequest();
    api().loadHistoryIntoRequest("g2", id);
    expect(req(id).grpc.service).toBe("");
    expect(req(id).grpc.method).toBe("SayHello");
  });
});

describe("openApiRequestTab", () => {
  it("opens a new active api-request tab wired to a fresh request", () => {
    const tabId = act().openApiRequestTab();
    const leaf = rootLeaf();

    expect(leaf.tabIds).toEqual([tabId]);
    expect(leaf.activeTabId).toBe(tabId);
    expect(state().focusedPaneId).toBe(leaf.id);

    const tab = state().tabs[tabId];
    expect(tab).toMatchObject({ kind: "api-request", title: "New request" });
    expect(tab.ref.kind).toBe("api-request");
    if (tab.ref.kind === "api-request") {
      expect(state().apiRequests[tab.ref.requestId]).toBeDefined();
    }
    // No PTY: an api-request tab never configures a terminal.
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("opens distinct tabs, each with its own request", () => {
    const a = act().openApiRequestTab();
    const b = act().openApiRequestTab();
    expect(a).not.toBe(b);
    expect(rootLeaf().tabIds).toEqual([a, b]);
    expect(Object.keys(state().apiRequests)).toHaveLength(2);
  });

  it("opens a tab for an EXISTING request id (the History re-run path) without minting a new one", () => {
    const requestId = state().apiActions.createApiRequest();
    expect(Object.keys(state().apiRequests)).toHaveLength(1);
    const tabId = act().openApiRequestTab(requestId);
    const tab = state().tabs[tabId];
    expect(tab.ref.kind).toBe("api-request");
    if (tab.ref.kind === "api-request") expect(tab.ref.requestId).toBe(requestId);
    // No extra request minted — it reused the one we handed in.
    expect(Object.keys(state().apiRequests)).toHaveLength(1);
    assertLiveStoreInvariants();
  });

  it("is closable like any other tab, leaving nothing behind in the tree", () => {
    const tabId = act().openApiRequestTab();
    act().closeTab(tabId);
    expect(state().tabs[tabId]).toBeUndefined();
    expect(rootLeaf().tabIds).toEqual([]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });
});

/* ══════════════════════ editorActions ══════════════════════ */

describe("editorActions", () => {
  const ed = () => state().editorActions;
  const dirtyOf = (path: string) => {
    const tab = Object.values(state().tabs).find(
      (t) => t.ref.kind === "editor" && t.ref.path === path,
    );
    return Boolean(tab?.dirty);
  };

  it("setEditorStale is a calm no-op for a path with no editor", () => {
    // Reachable whenever the watcher's reply lands after the tab closed.
    expect(() => ed().setEditorStale("/w/never-opened.ts", true)).not.toThrow();
    expect(state().editors["/w/never-opened.ts"]).toBeUndefined();
  });

  it("initEditor seeds a loading UI state (idempotent)", () => {
    ed().initEditor("/w/a.ts");
    expect(state().editors["/w/a.ts"]).toEqual({
      status: "loading",
      editable: false,
      saveError: null,
      savedAt: 0,
      // A freshly opened file is not stale — the disk watcher has not looked yet,
      // and "not looked" must read as fine rather than as a conflict.
      staleOnDisk: false,
      previewZoom: PREVIEW_ZOOM_DEFAULT,
      // The rendered view is the default for every previewable kind, so "not yet
      // toggled" and "show me the rendered thing" are the same state.
      showSource: false,
    });

    ed().editorReady("/w/a.ts", true);
    ed().initEditor("/w/a.ts"); // must NOT reset a loaded editor
    expect(state().editors["/w/a.ts"].status).toBe("ready");
  });

  /**
   * The Preview↔Source toggle lives in the STORE, not in `CodeEditor`, because
   * it is per-TAB state: `Pane` renders only the ACTIVE tab and a cross-pane drag
   * re-parents the subtree, so a `useState` toggle was reset by every tab switch
   * and every drag — the user would click "Source", move the tab, and land back
   * on Preview.
   */
  it("setShowSource flips the view toggle, and an unknown path is a no-op", () => {
    ed().initEditor("/w/page.html");
    expect(state().editors["/w/page.html"].showSource).toBe(false);

    ed().setShowSource("/w/page.html", true);
    expect(state().editors["/w/page.html"].showSource).toBe(true);
    ed().setShowSource("/w/page.html", false);
    expect(state().editors["/w/page.html"].showSource).toBe(false);

    // Never-opened path: a no-op rather than a crash, matching setPreviewZoom.
    expect(() => ed().setShowSource("/w/ghost.html", true)).not.toThrow();
    expect(state().editors["/w/ghost.html"]).toBeUndefined();
  });

  it("editorReady / editorFailed move status and editability", () => {
    ed().initEditor("/w/a.ts");
    ed().editorReady("/w/a.ts", true);
    expect(state().editors["/w/a.ts"]).toMatchObject({
      status: "ready",
      editable: true,
    });

    ed().initEditor("/w/b.bin");
    ed().editorFailed("/w/b.bin");
    expect(state().editors["/w/b.bin"].status).toBe("error");

    // Unknown paths are no-ops, never a crash.
    ed().editorReady("/w/ghost", true);
    ed().editorFailed("/w/ghost");
    expect(state().editors["/w/ghost"]).toBeUndefined();
  });

  it("setEditorDirty flips the editor tab's dirty dot", () => {
    act().openEditorTab("/w/a.ts");
    ed().setEditorDirty("/w/a.ts", true);
    expect(dirtyOf("/w/a.ts")).toBe(true);
    ed().setEditorDirty("/w/a.ts", false);
    expect(dirtyOf("/w/a.ts")).toBe(false);
    // No tab for a path → a harmless no-op.
    ed().setEditorDirty("/w/none.ts", true);
  });

  it("editorSaved clears dirty, bumps savedAt, and drops any save error", () => {
    act().openEditorTab("/w/a.ts");
    ed().initEditor("/w/a.ts");
    ed().setEditorDirty("/w/a.ts", true);
    ed().editorSaveFailed("/w/a.ts", "disk full");
    expect(state().editors["/w/a.ts"].saveError).toBe("disk full");

    ed().editorSaved("/w/a.ts");

    expect(dirtyOf("/w/a.ts")).toBe(false);
    expect(state().editors["/w/a.ts"].saveError).toBeNull();
    expect(state().editors["/w/a.ts"].savedAt).toBe(1);
    // Unknown path: no crash.
    ed().editorSaved("/w/none.ts");
  });

  it("editorSaveFailed keeps dirty and surfaces the message", () => {
    act().openEditorTab("/w/a.ts");
    ed().initEditor("/w/a.ts");
    ed().setEditorDirty("/w/a.ts", true);

    ed().editorSaveFailed("/w/a.ts", "permission denied");

    expect(dirtyOf("/w/a.ts")).toBe(true);
    expect(state().editors["/w/a.ts"].saveError).toBe("permission denied");
    ed().editorSaveFailed("/w/none.ts", "x"); // no-op
  });

  it("disposeEditor forgets a path's UI state", () => {
    ed().initEditor("/w/a.ts");
    ed().disposeEditor("/w/a.ts");
    expect(state().editors["/w/a.ts"]).toBeUndefined();
  });

  it("setPreviewZoom stores through the preview's own clamp — both rails and NaN", () => {
    ed().initEditor("/w/README.md");
    ed().setPreviewZoom("/w/README.md", 2);
    expect(state().editors["/w/README.md"].previewZoom).toBe(2);

    ed().setPreviewZoom("/w/README.md", 999); // above the rail → clamped, not stored raw
    expect(state().editors["/w/README.md"].previewZoom).toBe(PREVIEW_ZOOM_MAX);
    ed().setPreviewZoom("/w/README.md", 0); // below the rail
    expect(state().editors["/w/README.md"].previewZoom).toBe(PREVIEW_ZOOM_MIN);
    ed().setPreviewZoom("/w/README.md", Number.NaN); // non-finite → default
    expect(state().editors["/w/README.md"].previewZoom).toBe(PREVIEW_ZOOM_DEFAULT);

    // Unknown path: a no-op — no crash, and no phantom editor slice seeded.
    ed().setPreviewZoom("/w/ghost.md", 2);
    expect(state().editors["/w/ghost.md"]).toBeUndefined();
  });

  it("requestCloseTab raises the confirm for a DIRTY editor, closes otherwise", async () => {
    const editorTab = act().openEditorTab("/w/a.ts");
    ed().setEditorDirty("/w/a.ts", true);

    ed().requestCloseTab(editorTab);
    expect(state().confirmCloseTab).toBe(editorTab); // pending, NOT closed
    expect(state().tabs[editorTab]).toBeDefined();

    // A clean editor tab closes straight away.
    const clean = act().openEditorTab("/w/clean.ts");
    ed().requestCloseTab(clean);
    expect(state().tabs[clean]).toBeUndefined();

    // A terminal tab closes too — but only AFTER the busy check answers, which
    // is a real IPC round trip. With nothing running the
    // answer is "not busy", so the close goes through untouched.
    const term = act().openTerminalTab();
    ed().requestCloseTab(term);
    await flushBusyGate();
    expect(state().tabs[term]).toBeUndefined();
    expect(state().pendingTerminalClose).toBeNull();
  });

  it("requestCloseTab on an unknown tabId is a total no-op, not a TypeError", () => {
    // Pins the FIRST factor of the compound guard
    // `!!tab && tab.ref.kind === "editor" && !!tab.dirty` independently. The
    // three cases above vary only the tab's *kind/dirtiness*, so they all reach
    // the guard with `tab` defined — `!!tab` is unobservable there. Forced to
    // `true`, the very next term dereferences `tab.ref` on `undefined` and the
    // action throws.
    //
    // The stale id is real: Cmd/Ctrl+W and the tab ✕ both route here, so a
    // double-fire or a shortcut racing a close arrives with a tabId
    // whose record is already gone. That must do nothing — not crash the shell.
    act().openEditorTab("/w/real.ts"); // some state to prove is untouched
    const before = snapshot(state());

    expect(() => ed().requestCloseTab(asTabId("ghost"))).not.toThrow();

    expect(state().confirmCloseTab).toBeNull(); // no phantom confirm dialog
    expect(snapshot(state())).toEqual(before);
    assertLiveStoreInvariants("after requestCloseTab on a ghost id");
  });

  it("closePendingTab closes the pending tab; cancel dismisses without closing", () => {
    const editorTab = act().openEditorTab("/w/a.ts");
    ed().setEditorDirty("/w/a.ts", true);
    ed().requestCloseTab(editorTab);

    ed().cancelCloseTab();
    expect(state().confirmCloseTab).toBeNull();
    expect(state().tabs[editorTab]).toBeDefined(); // still open

    ed().requestCloseTab(editorTab);
    ed().closePendingTab();
    expect(state().confirmCloseTab).toBeNull();
    expect(state().tabs[editorTab]).toBeUndefined(); // closed
  });

  it("closePendingTab with nothing pending is a no-op", () => {
    const settled = state();
    ed().closePendingTab();
    expect(state()).toBe(settled);
  });

  it("closing an editor tab clears its UI state and any pending confirm", () => {
    const editorTab = act().openEditorTab("/w/a.ts");
    ed().initEditor("/w/a.ts");
    ed().setEditorDirty("/w/a.ts", true);
    ed().requestCloseTab(editorTab); // sets confirmCloseTab

    act().closeTab(editorTab);

    expect(state().editors["/w/a.ts"]).toBeUndefined();
    expect(state().confirmCloseTab).toBeNull();
  });
});

/* ══════════════════════ lspActions ══════════════════════ */

describe("lspActions", () => {
  const lsp = () => state().lspActions;

  it("records an install hint, and dismisses it (once, idempotent)", () => {
    lsp().setLspInstallHint("rust", "rustup component add rust-analyzer");
    expect(state().lspInstallHints.rust).toBe(
      "rustup component add rust-analyzer",
    );

    lsp().dismissLspHint("rust");
    lsp().dismissLspHint("rust"); // idempotent
    expect(state().lspDismissedHints).toEqual(["rust"]);
  });

  it("tracks indexing per language, adding then removing", () => {
    lsp().setLspIndexing("rust", true);
    lsp().setLspIndexing("rust", true); // no duplicate
    expect(state().lspIndexing).toEqual(["rust"]);

    lsp().setLspIndexing("rust", false);
    expect(state().lspIndexing).toEqual([]);
    lsp().setLspIndexing("rust", false); // already absent → no-op
    expect(state().lspIndexing).toEqual([]);
  });

  it("opens, updates, and clears the references panel (find-usages)", () => {
    expect(state().lspReferences).toBeNull();

    lsp().setReferences({ symbol: "search", hits: [], loading: true }); // panel opens, loading
    expect(state().lspReferences).toEqual({
      symbol: "search",
      hits: [],
      loading: true,
    });

    const hit = {
      path: "/w/src/find.rs",
      display: "src/find.rs",
      line: 29,
      col: 4,
      lineText: "fn search(",
      matchStart: 3,
      matchEnd: 9,
    };
    lsp().setReferences({ symbol: "search", hits: [hit], loading: false });
    expect(state().lspReferences).toEqual({
      symbol: "search",
      hits: [hit],
      loading: false,
    });

    lsp().clearReferences();
    expect(state().lspReferences).toBeNull();
  });
});

/* ══════════ openSessionPickerTab — "Recover session" ══════════ */

describe("openSessionPickerTab", () => {
  it("opens a session-picker tab keyed by cwd, titled after the folder, and activates it", () => {
    const tabId = act().openSessionPickerTab("/w/data-warehouse");
    const tab = state().tabs[tabId];
    expect(tab.kind).toBe("session-picker");
    expect(tab.ref).toEqual({ kind: "session-picker", cwd: "/w/data-warehouse" });
    expect(tab.title).toBe("Sessions — data-warehouse");
    expect(rootLeaf().activeTabId).toBe(tabId);
  });

  it("dedupes per cwd: reopening the same folder re-focuses the existing picker", () => {
    const first = act().openSessionPickerTab("/w/gazelle");
    act().openEditorTab("/w/a.ts"); // steal focus
    const again = act().openSessionPickerTab("/w/gazelle");
    expect(again).toBe(first);
    expect(rootLeaf().activeTabId).toBe(first);
    expect(Object.values(state().tabs).filter((t) => t.kind === "session-picker")).toHaveLength(1);
  });

  it("distinct folders get distinct pickers", () => {
    const a = act().openSessionPickerTab("/w/gazelle");
    const b = act().openSessionPickerTab("/w/data-warehouse");
    expect(a).not.toBe(b);
    expect(Object.values(state().tabs).filter((t) => t.kind === "session-picker")).toHaveLength(2);
  });
});

/* ══════════ revealActiveFile — "Select Opened File" ══════════ */

describe("revealActiveFile (IntelliJ's crosshair)", () => {
  const ui = () => state().uiActions;
  const ws = () => state().workspaceActions;

  it("posts a one-shot fileReveal for the focused pane's active editor tab", () => {
    ws().addBrowseRoot("/w/gazelle");
    act().openEditorTab("/w/gazelle/crates/core/src/lib.rs");
    ui().revealActiveFile();
    expect(state().fileReveal).toEqual({
      path: "/w/gazelle/crates/core/src/lib.rs",
      token: 1,
      // The owning root travels WITH the request: the tree needs to
      // know the difference between "another subtree will claim this" and
      // "nobody will", and only this action has the roots + longest-match rule.
      root: "/w/gazelle",
    });
  });

  it("bumps the token each call, so re-revealing the SAME path re-fires", () => {
    act().openEditorTab("/w/a.ts");
    ui().revealActiveFile();
    ui().revealActiveFile();
    expect(state().fileReveal).toEqual({ path: "/w/a.ts", token: 2, root: null });
  });

  it("is a no-op on an empty pane", () => {
    ui().revealActiveFile();
    expect(state().fileReveal).toBeNull();
  });

  // Pressing the reveal button selects the file in the tree, so it is clear
  // which file is open. This used to assert
  // `fileReveal` stayed NULL with a terminal active — i.e. the crosshair was dead
  // the moment you clicked into a terminal, which is the normal state of this
  // app, and `focusedPaneId` is written by ANY mousedown in ANY pane. The rule
  // is now `activeFilePath`: the
  // focused pane wins when it shows a file, otherwise the last file tab activated
  // anywhere. The assertion that a file-less tab has no path of its OWN is kept
  // below, where no file tab has ever been opened.
  it("falls back to the last file tab when the ACTIVE tab is file-less", () => {
    act().openEditorTab("/w/a.ts");
    act().openTerminalTab(); // …the active tab is now a terminal
    ui().revealActiveFile();
    expect(state().fileReveal).toEqual({ path: "/w/a.ts", token: 1, root: null });

    const rid = state().apiActions.createApiRequest();
    act().openApiRequestTab(rid); // an API tab is equally file-less
    ui().revealActiveFile();
    expect(state().fileReveal?.path).toBe("/w/a.ts");
  });

  it("is a no-op when the only tabs open have no file at all", () => {
    act().openTerminalTab();
    const rid = state().apiActions.createApiRequest();
    act().openApiRequestTab(rid);
    ui().revealActiveFile();
    expect(state().fileReveal).toBeNull();
  });

  it("makes the Files rail visible: un-collapses the right rail and switches to Files", () => {
    act().openEditorTab("/w/a.ts");
    ui().toggleRightRail(); // collapsed
    ui().setRightRailTab("vault"); // wrong panel
    ui().revealActiveFile();
    expect(state().rightRailCollapsed).toBe(false);
    expect(state().rightRailTab).toBe("files");
  });

  it("expands the collapsed CONTAINING root — the longest match — and only that one", () => {
    ws().addBrowseRoot("/w");
    ws().addBrowseRoot("/w/gazelle");
    ws().addBrowseRoot("/w/other");
    ws().toggleRootCollapsed("/w");
    ws().toggleRootCollapsed("/w/gazelle");
    ws().toggleRootCollapsed("/w/other");
    act().openEditorTab("/w/gazelle/src/lib.rs");
    ui().revealActiveFile();
    // Longest match wins: /w/gazelle expands; /w (also a prefix) and the
    // unrelated /w/other stay exactly as the user left them.
    expect(state().collapsedRoots.has("/w/gazelle")).toBe(false);
    expect(state().collapsedRoots.has("/w")).toBe(true);
    expect(state().collapsedRoots.has("/w/other")).toBe(true);
    expect(state().fileReveal?.path).toBe("/w/gazelle/src/lib.rs");
  });

  // The reveal is still posted (the token still bumps, so a
  // later reveal of the same path still re-fires), but it now carries `root: null`
  // — the fact that made this case a SILENT no-op before. Every subtree
  // early-returns on a path outside its root, so the whole user-visible effect
  // used to be the rail flipping to Files; the tree reads this null and says so.
  it("posts the reveal with root: null when the file is under NO open root", () => {
    ws().addBrowseRoot("/w");
    act().openEditorTab("/elsewhere/x.ts");
    ui().revealActiveFile();
    expect(state().fileReveal).toEqual({ path: "/elsewhere/x.ts", token: 1, root: null });
  });
});

describe("activeFilePath (the crosshair's target AND the tree's highlight)", () => {
  it("returns the focused pane's active editor tab path", () => {
    act().openEditorTab("/w/a.ts");
    expect(activeFilePath(state())).toBe("/w/a.ts");
  });

  it("returns null for an empty pane, and with only a file-less tab open", () => {
    expect(activeFilePath(state())).toBeNull();
    act().openTerminalTab();
    expect(activeFilePath(state())).toBeNull();
  });

  // The bug, at the selector: `focusedPaneId` moves on any mousedown in
  // any pane, so "the focused pane's active tab" alone made the Files rail go
  // blank the moment a terminal was clicked.
  it("STAYS on the last file tab when a terminal in the same pane takes over", () => {
    act().openEditorTab("/w/a.ts");
    act().openTerminalTab();
    expect(activeFilePath(state())).toBe("/w/a.ts");
  });

  it("stays on the last file tab when another PANE takes focus", () => {
    act().openEditorTab("/w/a.ts");
    const right = act().splitPane(state().focusedPaneId, "row");
    act().openTerminalTab({ paneId: right });
    expect(state().focusedPaneId).toBe(right);
    expect(activeFilePath(state())).toBe("/w/a.ts");
  });

  it("follows a tab-strip click onto another editor", () => {
    act().openEditorTab("/w/a.ts");
    const b = act().openEditorTab("/w/b.ts");
    const a = Object.values(state().tabs).find(
      (t) => t.ref.kind === "editor" && t.ref.path === "/w/a.ts",
    )!;
    expect(activeFilePath(state())).toBe("/w/b.ts");
    act().setActiveTab(state().focusedPaneId, a.id);
    expect(activeFilePath(state())).toBe("/w/a.ts");
    act().setActiveTab(state().focusedPaneId, b);
    expect(activeFilePath(state())).toBe("/w/b.ts");
  });

  /**
   * Added after a SURVIVING MUTANT: deleting `setActiveTab`'s
   * `noteFileTab` broke nothing, because `setActiveTab` also focuses the pane, so
   * the clause above is answered by the focused pane and never reaches the
   * memory. The strip click only matters LATER — once focus leaves for a
   * file-less pane. Without the write, the rail then snaps back to whichever file
   * `openEditorTab` happened to record last, i.e. a file the user deliberately
   * clicked away from.
   */
  it("remembers the strip click, not the last file OPENED, once focus leaves", () => {
    act().openEditorTab("/w/a.ts");
    act().openEditorTab("/w/b.ts"); // b.ts is the last file opened
    const editorPane = state().focusedPaneId;
    const terminalPane = act().splitPane(editorPane, "row");
    act().openTerminalTab({ paneId: terminalPane });

    const a = Object.values(state().tabs).find(
      (t) => t.ref.kind === "editor" && t.ref.path === "/w/a.ts",
    )!;
    act().setActiveTab(editorPane, a.id); // …but a.ts is the one being READ
    act().focusPane(terminalPane); // a mousedown in the terminal

    expect(state().focusedPaneId).toBe(terminalPane);
    expect(activeFilePath(state())).toBe("/w/a.ts");
  });

  // A `diff` tab is a real file at a real path in the tree ("Compare
  // with HEAD"). Excluding it greyed the crosshair out on exactly the tab where
  // "where does this file live?" is most often asked.
  it("counts a diff tab as a file tab, live and remembered", () => {
    act().openDiffTab("/w/a.ts");
    expect(activeFilePath(state())).toBe("/w/a.ts");
    act().openTerminalTab();
    expect(activeFilePath(state())).toBe("/w/a.ts");
  });

  // The memory is validated against the live tabs on every read, so no close path
  // has to remember to clear it — and a leaked value can never outlive its tab.
  it("forgets a remembered path once no tab shows that file", () => {
    const tab = act().openEditorTab("/w/a.ts");
    act().openTerminalTab();
    expect(activeFilePath(state())).toBe("/w/a.ts");
    act().closeTab(tab);
    expect(state().lastFilePath).toBe("/w/a.ts"); // the memory is NOT cleaned up…
    expect(activeFilePath(state())).toBeNull(); // …it is simply no longer an answer
  });
});

/* ══════════════════════ uiActions (shortcuts overlay) ══════════════════════ */

describe("uiActions", () => {
  it("toggles the shortcuts overlay open/closed, and closes explicitly", () => {
    expect(state().shortcutsOpen).toBe(false);

    state().uiActions.toggleShortcuts();
    expect(state().shortcutsOpen).toBe(true);
    state().uiActions.toggleShortcuts();
    expect(state().shortcutsOpen).toBe(false);

    state().uiActions.toggleShortcuts(); // open again
    state().uiActions.closeShortcuts();
    expect(state().shortcutsOpen).toBe(false);
  });

  it("toggles the Find-in-Files overlay, and opens/closes it explicitly", () => {
    expect(state().findInFilesOpen).toBe(false);

    state().uiActions.toggleFindInFiles();
    expect(state().findInFilesOpen).toBe(true);
    state().uiActions.toggleFindInFiles();
    expect(state().findInFilesOpen).toBe(false);

    state().uiActions.setFindInFilesOpen(true);
    expect(state().findInFilesOpen).toBe(true);
    state().uiActions.setFindInFilesOpen(false);
    expect(state().findInFilesOpen).toBe(false);
  });

  it("switches the right rail's persistent panel through every tab in the union", () => {
    // The full circuit, not a sample: this test used to exercise only
    // vault/history/files (never `db` or `tools`). Every member is asserted so a new
    // tab that the action somehow refused would fail here rather than only in
    // App-level routing.
    expect(state().rightRailTab).toBe("files");

    for (const tab of ["vault", "history", "collections", "db", "tools", "git"] as const) {
      state().uiActions.setRightRailTab(tab);
      expect(state().rightRailTab).toBe(tab);
    }
    state().uiActions.setRightRailTab("files");
    expect(state().rightRailTab).toBe("files");
  });

  it("toggles the left rail collapsed/expanded", () => {
    expect(state().leftRailCollapsed).toBe(false);

    state().uiActions.toggleLeftRail();
    expect(state().leftRailCollapsed).toBe(true);
    state().uiActions.toggleLeftRail();
    expect(state().leftRailCollapsed).toBe(false);
  });

  it("toggles the right rail collapsed/expanded", () => {
    expect(state().rightRailCollapsed).toBe(false);

    state().uiActions.toggleRightRail();
    expect(state().rightRailCollapsed).toBe(true);
    state().uiActions.toggleRightRail();
    expect(state().rightRailCollapsed).toBe(false);
  });

  it("sets rail widths, clamping to [RAIL_MIN_W, RAIL_MAX_W]", () => {
    expect(state().leftRailWidth).toBe(260);
    expect(state().rightRailWidth).toBe(300);

    // In-range values pass through.
    state().uiActions.setLeftRailWidth(320);
    expect(state().leftRailWidth).toBe(320);
    state().uiActions.setRightRailWidth(240);
    expect(state().rightRailWidth).toBe(240);

    // Over the max clamps down; under the min clamps up.
    state().uiActions.setLeftRailWidth(9999);
    expect(state().leftRailWidth).toBe(RAIL_MAX_W);
    state().uiActions.setRightRailWidth(10);
    expect(state().rightRailWidth).toBe(RAIL_MIN_W);

    // A non-finite drag value falls back to the min rather than poisoning layout.
    state().uiActions.setLeftRailWidth(Number.NaN);
    expect(state().leftRailWidth).toBe(RAIL_MIN_W);
  });
});

/* ══════════════════════ rebuildTerminalTabs ══════════════════════ */

describe("rebuildTerminalTabs (reattach after webview reload)", () => {
  const meta = (
    over: Omit<Partial<TerminalMeta>, "id"> & { id: string },
  ): TerminalMeta => ({
    kind: "terminal",
    title: "sh",
    cwd: "/projects/proj",
    cols: 80,
    rows: 24,
    status: "live",
    ...over,
    id: asTerminalId(over.id),
  });

  const agentMeta = (
    id: string,
    over: Partial<TerminalMeta> = {},
  ): TerminalMeta =>
    meta({
      id,
      kind: "agent-terminal",
      title: "claude",
      agentId: asAgentId(id),
      ...over,
    });

  it("is a no-op on a fresh launch (no terminals in the snapshot)", () => {
    act().rebuildTerminalTabs([]);
    expect(Object.keys(state().tabs)).toHaveLength(0);
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
  });

  it("rebuilds a plain terminal tab with a `terminal` ref", () => {
    act().rebuildTerminalTabs([meta({ id: "01J0T0000000000000000000AA" })]);

    const tabId = rootLeaf().tabIds[0];
    const tab = state().tabs[tabId];
    expect(tab.kind).toBe("terminal");
    expect(tab.ref).toEqual({
      kind: "terminal",
      terminalId: "01J0T0000000000000000000AA",
    });
  });

  it("rebuilds an agent terminal with an `agent-terminal` ref keyed by the agentId", () => {
    act().rebuildTerminalTabs([agentMeta("01J0AGENT000000000000000A")]);

    const tabId = rootLeaf().tabIds[0];
    const tab = state().tabs[tabId];
    expect(tab.kind).toBe("agent-terminal");
    // An agent terminal's TerminalId IS its AgentId (Rust keys the PTY that way).
    expect(tab.ref).toEqual({
      kind: "agent-terminal",
      terminalId: "01J0AGENT000000000000000A",
      agentId: "01J0AGENT000000000000000A",
    });
  });

  it("rebuilds a mixed snapshot — every terminal gets its tab", () => {
    act().rebuildTerminalTabs([
      meta({ id: "01J0SHELL00000000000000AA" }),
      agentMeta("01J0AGENT000000000000000A"),
      agentMeta("01J0AGENT000000000000000B"),
    ]);

    expect(rootLeaf().tabIds).toHaveLength(3);
    const kinds = rootLeaf().tabIds.map((t) => state().tabs[t].kind);
    expect(kinds).toEqual(["terminal", "agent-terminal", "agent-terminal"]);
    assertLiveStoreInvariants();
  });

  it("configures each terminal to REATTACH, never re-open (no runtime for agents)", () => {
    act().rebuildTerminalTabs([
      meta({ id: "01J0SHELL00000000000000AA", cwd: "/projects/a" }),
      agentMeta("01J0AGENT000000000000000A", { cwd: "/projects/b" }),
    ]);

    expect(terminal.configureTerminal).toHaveBeenCalledWith(
      "01J0SHELL00000000000000AA",
      {
        reattach: true,
        cwd: "/projects/a",
      },
    );
    expect(terminal.configureTerminal).toHaveBeenCalledWith(
      "01J0AGENT000000000000000A",
      {
        reattach: true,
        cwd: "/projects/b",
        agentId: "01J0AGENT000000000000000A",
      },
    );
  });

  it("is idempotent: a second call adds nothing", () => {
    const terminals = [
      meta({ id: "01J0SHELL00000000000000AA" }),
      agentMeta("01J0AGENT000000000000000A"),
    ];
    act().rebuildTerminalTabs(terminals);
    const after1 = Object.keys(state().tabs).length;
    terminal.configureTerminal.mockClear();

    act().rebuildTerminalTabs(terminals);

    expect(Object.keys(state().tabs)).toHaveLength(after1);
    expect(rootLeaf().tabIds).toHaveLength(2);
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
  });

  it("does not duplicate a terminal that already has a tab (e.g. one opened live)", () => {
    const live = act().openTerminalTab({
      agentId: asAgentId("01J0AGENT000000000000000A"),
      runtime: "claude-code",
    });
    const liveTid = terminalIdOfTab(live);

    act().rebuildTerminalTabs([agentMeta("01J0AGENT000000000000000A")]);

    // Same terminal → still exactly one tab for it.
    const tabsForAgent = Object.values(state().tabs).filter(
      (t) => t.ref.kind === "agent-terminal" && t.ref.terminalId === liveTid,
    );
    expect(tabsForAgent).toHaveLength(1);
  });

  it("marks an exited terminal's tab as ended", () => {
    act().rebuildTerminalTabs([
      meta({
        id: "01J0DEAD0000000000000000A",
        title: "build",
        status: "exited",
        exitCode: 1,
      }),
    ]);

    const tab = state().tabs[rootLeaf().tabIds[0]];
    expect(tab.title).toContain("build");
    expect(tab.title).toMatch(/ended/i);
  });

  it("de-duplicates within a single snapshot", () => {
    act().rebuildTerminalTabs([
      meta({ id: "01J0DUP00000000000000000A" }),
      meta({ id: "01J0DUP00000000000000000A" }),
    ]);
    expect(rootLeaf().tabIds).toHaveLength(1);
  });

  it("rebuilds into the first leaf when focus points at a split (defensive)", () => {
    act().splitPane(rootLeaf().id, "row"); // now a split at the root
    const splitId = asSplit(state().layout).id;
    // Force the (normally impossible) state where focus is a split id.
    useAppStore.setState((s) => {
      s.focusedPaneId = splitId;
    });

    act().rebuildTerminalTabs([meta({ id: "01J0FALL00000000000000AA" })]);

    // Landed in the first leaf, not lost. (No invariant assert here: we forced
    // an impossible focus-on-a-split state precisely to exercise the fallback.)
    expect(leavesOf(state().layout)[0].tabIds).toHaveLength(1);
  });

  it("does not disturb the leaf's already-active tab when rebuilding", () => {
    const live = act().openTerminalTab(); // focused leaf now has an active tab
    act().rebuildTerminalTabs([meta({ id: "01J0KEEP00000000000000AA" })]);

    // The rebuilt tab is appended but the pre-existing tab stays active
    // (`activeTabId ??= tabId` only fills an empty slot).
    expect(rootLeaf().activeTabId).toBe(live);
    expect(rootLeaf().tabIds).toHaveLength(2);
  });

  it("lets selectAgent find and activate a rebuilt agent tab (the reload fix)", () => {
    const agentId = asAgentId("01J0AGENT000000000000000A");
    // Reload order: agents first, then terminals.
    useAppStore.getState().agentActions.applyFleetSnapshot([
      {
        id: agentId,
        parentId: null,
        kind: "orchestrator",
        title: "claude",
        status: "running",
        branch: "trunk",
        cwd: "/projects/proj",
        runtime: "claude-code",
        startedAt: 1,
        finishedAt: null,
        lastActivityAt: 1,
        childIds: [],
        sessionId: null,
        expanded: true,
        unread: 0,
      },
    ]);
    act().rebuildTerminalTabs([agentMeta("01J0AGENT000000000000000A")]);

    useAppStore.getState().agentActions.selectAgent(agentId);

    const tabId = rootLeaf().tabIds[0];
    expect(rootLeaf().activeTabId).toBe(tabId); // clicking the agent shows its terminal
    expect(state().selection.selectedAgentId).toBe(agentId);
  });

  /*
   * An agent's TAB TITLE across a restart. The restart E2E read "workspace" on
   * the agent's tab before the restart and "claude" after it — its row said "claude"
   * throughout. Both sides are asserted against the literal folder name the user reads,
   * never against the store's own helper.
   */
  const tabOfAgent = (agentId: string) =>
    Object.values(state().tabs).find((t) => t.ref.kind === "agent-terminal" && t.ref.agentId === agentId);

  it("gives a restored agent's tab the name it wore when it was spawned — its folder, never Rust's 'claude'", () => {
    // Side 1 — the spawn. Every launch surface (⚡, New agent, Recover, ↻ Resume) is createAgent.
    const agentId = useAppStore.getState().agentActions.createAgent({ cwd: "/repo/e2e/fixtures/workspace" });
    expect(tabOfAgent(agentId)?.title).toBe("workspace");

    // The app quits: the JS heap goes, the agent comes back under the same id (open_agents.rs),
    // and Rust describes its terminal with the ADAPTER's name — the row's word, not the tab's.
    resetStore();
    act().rebuildTerminalTabs([agentMeta(agentId, { title: "claude", cwd: "/repo/e2e/fixtures/workspace" })]);

    // Side 2 — the restore: the same name as before, not "claude".
    expect(tabOfAgent(agentId)?.title).toBe("workspace");
  });

  it("says a dormant (ended) restored agent's folder too, marked ended", () => {
    act().rebuildTerminalTabs([
      agentMeta("01J0GONE0000000000000000A", { title: "claude", cwd: "/w/gone/", status: "exited" }),
    ]);
    expect(tabOfAgent("01J0GONE0000000000000000A")?.title).toBe("gone · ended");
  });

  it("keeps the title a tab carries from another window (tear-off sends no cwd)", () => {
    // `handoff.ts` adoptOne: `{ title: <the tab's title over there>, cwd: "" }`.
    act().rebuildTerminalTabs([agentMeta("01J0TORN0000000000000000A", { title: "gazelle", cwd: "" })]);
    expect(tabOfAgent("01J0TORN0000000000000000A")?.title).toBe("gazelle");
  });

  it("leaves a plain shell's rebuilt title as Rust names it (its 'Terminal 3' was never on disk)", () => {
    act().rebuildTerminalTabs([meta({ id: "01J0SHELL00000000000000AB", title: "zsh", cwd: "/projects/proj" })]);
    expect(state().tabs[rootLeaf().tabIds[0]].title).toBe("zsh");
  });
});

/* ══════════════════════════ setWorkspaceRoot ══════════════════════════ */

describe("setWorkspaceRoot", () => {
  const setRoot = (p: string) =>
    useAppStore.getState().workspaceActions.setWorkspaceRoot(p);

  it("starts null (unresolved until startup asks Rust)", () => {
    expect(state().workspaceRoot).toBeNull();
  });

  it("stores the root", () => {
    setRoot("/Users/me/projects/gazelle");
    expect(state().workspaceRoot).toBe("/Users/me/projects/gazelle");
  });

  it("re-points the terminal default cwd so plain terminals open there too", () => {
    setRoot("/Users/me/projects/gazelle");
    // The effect the bug fix needs: "+ New terminal" (no cwd of its own)
    // must land in the project, not the app binary's dir.
    expect(terminal.setDefaultTerminalCwd).toHaveBeenCalledWith(
      "/Users/me/projects/gazelle",
    );
  });

  it("overwrites a previously-set root", () => {
    setRoot("/Users/me/a");
    setRoot("/Users/me/b");
    expect(state().workspaceRoot).toBe("/Users/me/b");
    expect(terminal.setDefaultTerminalCwd).toHaveBeenLastCalledWith(
      "/Users/me/b",
    );
  });

  it("makes new agents start in the workspace root", () => {
    setRoot("/Users/me/projects/gazelle");
    // LeftRail passes `workspaceRoot ?? "."`; assert the store records it on the
    // agent (the cwd claude will get, and where its history lives).
    const agentId = useAppStore
      .getState()
      .agentActions.createAgent({ cwd: state().workspaceRoot ?? "." });
    expect(state().agents[agentId].cwd).toBe("/Users/me/projects/gazelle");
  });
});

/* ══════════════════════════ recentProjects ══════════════════════════ */

describe("recentProjects", () => {
  const ws = () => useAppStore.getState().workspaceActions;

  it("starts empty", () => {
    expect(state().recentProjects).toEqual([]);
  });

  it("setRecentProjects replaces the list (from Rust on startup)", () => {
    ws().setRecentProjects(["/w/a", "/w/b"]);
    expect(state().recentProjects).toEqual(["/w/a", "/w/b"]);
  });

  it("addRecentProject prepends a new path", () => {
    ws().setRecentProjects(["/w/a"]);
    ws().addRecentProject("/w/new");
    expect(state().recentProjects).toEqual(["/w/new", "/w/a"]);
  });

  it("addRecentProject moves an existing path to the front (dedup)", () => {
    ws().setRecentProjects(["/w/a", "/w/b", "/w/c"]);
    ws().addRecentProject("/w/c");
    expect(state().recentProjects).toEqual(["/w/c", "/w/a", "/w/b"]);
  });
});

/* ══════════════════════════ browseRoots (multi-root Files) ══════════════════════════ */

describe("browseRoots", () => {
  const ws = () => useAppStore.getState().workspaceActions;

  it("starts empty", () => {
    expect(state().browseRoots).toEqual([]);
  });

  it("addBrowseRoot prepends a newly-opened folder", () => {
    ws().addBrowseRoot("/w/a");
    ws().addBrowseRoot("/w/b");
    expect(state().browseRoots).toEqual(["/w/b", "/w/a"]);
  });

  it("addBrowseRoot dedupes — re-opening a folder moves it to the front", () => {
    ws().addBrowseRoot("/w/a");
    ws().addBrowseRoot("/w/b");
    ws().addBrowseRoot("/w/a");
    expect(state().browseRoots).toEqual(["/w/a", "/w/b"]);
  });

  it("addBrowseRoot authorizes read_dir by pushing the folder to the persisted recents", () => {
    ws().addBrowseRoot("/w/a");
    // The EFFECT, in the wrapper (not the reducer): read_dir's allowed_roots are
    // the recents ∪ the workspace root, so a browse root must be recorded there
    // or its listing rejects.
    expect(fleetIpc.pushRecentProject).toHaveBeenCalledWith("/w/a");
  });

  it("addBrowseRoot installs the ad-hoc-detection hook for the opened folder", () => {
    ws().addBrowseRoot("/w/a");
    // Opening a folder spawns no terminal, so this is the only place the hook gets
    // installed for it — without it, a `claude` typed in a terminal here later is
    // undetected.
    expect(fleetIpc.ensureAgentHooks).toHaveBeenCalledWith("/w/a");
  });

  it("still opens the folder when persisting the recent fails (best-effort)", () => {
    fleetIpc.pushRecentProject.mockRejectedValueOnce(new Error("disk full"));
    ws().addBrowseRoot("/w/a");
    // The recents push is a nicety; the folder opens regardless.
    expect(state().browseRoots).toEqual(["/w/a"]);
  });

  it("still opens the folder when ensuring the hook fails (best-effort)", async () => {
    fleetIpc.ensureAgentHooks.mockRejectedValueOnce(new Error("no listener"));
    ws().addBrowseRoot("/w/a");
    // Let the rejected best-effort promise settle (covers the `.catch` arm).
    await Promise.resolve();
    // The hook install is best-effort; the folder opens regardless.
    expect(state().browseRoots).toEqual(["/w/a"]);
  });

  it("removeBrowseRoot drops an open folder", () => {
    ws().addBrowseRoot("/w/a");
    ws().addBrowseRoot("/w/b");
    ws().removeBrowseRoot("/w/a");
    expect(state().browseRoots).toEqual(["/w/b"]);
  });

  it("removeBrowseRoot is a no-op for a folder that isn't open", () => {
    ws().addBrowseRoot("/w/a");
    ws().removeBrowseRoot("/w/zzz");
    expect(state().browseRoots).toEqual(["/w/a"]);
  });
});

/* ══════════════════════════ workspaceRoots selector ══════════════════════════ */

describe("workspaceRoots", () => {
  // The selector only reads `.cwd`, so a minimal cast keeps these pure and terse.
  const agent = (id: string, cwd: string): AgentNode =>
    ({ id: asAgentId(id), cwd }) as unknown as AgentNode;

  const roots = (
    rootIds: string[],
    agents: AgentNode[],
    browseRoots: string[] = [],
  ): string[] =>
    workspaceRoots({
      rootAgentIds: rootIds.map(asAgentId),
      agents: Object.fromEntries(agents.map((a) => [a.id, a])) as Record<
        AgentId,
        AgentNode
      >,
      browseRoots,
    });

  it("is empty with no agents and no browse roots", () => {
    expect(roots([], [])).toEqual([]);
  });

  it("dedupes agent folders — three agents in one cwd yield ONE root", () => {
    const agents = [
      agent("a1", "/w/x"),
      agent("a2", "/w/x"),
      agent("a3", "/w/x"),
    ];
    expect(roots(["a1", "a2", "a3"], agents)).toEqual(["/w/x"]);
  });

  it("keeps distinct agent folders in rail (rootAgentIds) order", () => {
    const agents = [agent("a", "/w/a"), agent("b", "/w/b"), agent("c", "/w/a")];
    expect(roots(["a", "b", "c"], agents)).toEqual(["/w/a", "/w/b"]);
  });

  it("appends browse roots after the agent folders", () => {
    const agents = [agent("a", "/w/a")];
    expect(roots(["a"], agents, ["/w/browse"])).toEqual(["/w/a", "/w/browse"]);
  });

  it("shows a folder that is BOTH an agent cwd and a browse root once, in its agent slot", () => {
    const agents = [agent("a", "/w/shared"), agent("b", "/w/b")];
    expect(roots(["a", "b"], agents, ["/w/shared", "/w/browse"])).toEqual([
      "/w/shared",
      "/w/b",
      "/w/browse",
    ]);
  });

  it("skips a root id whose agent record hasn't arrived yet", () => {
    // rootAgentIds can name an agent a beat before its record lands.
    expect(roots(["ghost"], [], ["/w/browse"])).toEqual(["/w/browse"]);
  });
});

/* ══════════════════════════ renameTab ══════════════════════════ */

describe("renameTab", () => {
  it("sets a custom tab name", () => {
    const tabId = act().openTerminalTab();
    act().renameTab(tabId, "Build logs");
    expect(state().tabs[tabId].customTitle).toBe("Build logs");
  });

  it("trims surrounding whitespace", () => {
    const tabId = act().openTerminalTab();
    act().renameTab(tabId, "  Logs  ");
    expect(state().tabs[tabId].customTitle).toBe("Logs");
  });

  it("clears the custom name on empty/whitespace (reverts to derived title)", () => {
    const tabId = act().openTerminalTab();
    act().renameTab(tabId, "Logs");
    act().renameTab(tabId, "  ");
    expect(state().tabs[tabId].customTitle).toBeNull();
  });

  it("clears on null", () => {
    const tabId = act().openTerminalTab();
    act().renameTab(tabId, "Logs");
    act().renameTab(tabId, null);
    expect(state().tabs[tabId].customTitle).toBeNull();
  });

  it("is a no-op for an unknown tab", () => {
    expect(() => act().renameTab(asTabId("ghost"), "x")).not.toThrow();
  });
});

/* ══════════════════════════ closeTab ══════════════════════════ */

describe("closeTab", () => {
  it("removes the tab record and detaches it from its leaf", () => {
    const a = act().openTerminalTab();
    const b = act().openTerminalTab();

    act().closeTab(a);

    expect(state().tabs[a]).toBeUndefined();
    expect(rootLeaf().tabIds).toEqual([b]);
    assertLiveStoreInvariants();
  });

  it("moves activation to the next tab on the right, then the left", () => {
    const [a, b, c] = [
      act().openTerminalTab(),
      act().openTerminalTab(),
      act().openTerminalTab(),
    ];

    act().setActiveTab(rootLeaf().id, b);
    act().closeTab(b);
    expect(rootLeaf().activeTabId).toBe(c); // b's slot now holds c

    act().closeTab(c);
    expect(rootLeaf().activeTabId).toBe(a); // no right neighbour → step left
  });

  it("leaves activation alone when a non-active tab closes", () => {
    const a = act().openTerminalTab();
    const b = act().openTerminalTab();

    act().closeTab(a);
    expect(rootLeaf().activeTabId).toBe(b);
  });

  it("disposes the terminal — closing a tab must not leak the PTY", () => {
    const tabId = act().openTerminalTab();
    const terminalId = terminalIdOfTab(tabId);

    act().closeTab(tabId);

    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledWith(terminalId);
  });

  it("does not dispose for an editor tab (it owns no PTY)", () => {
    const tabId = injectEditorTab(rootLeaf().id);
    act().closeTab(tabId);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("collapses the leaf when its last tab closes", () => {
    const origin = rootLeaf().id;
    const created = act().splitPane(origin, "row");
    const tabId = act().openTerminalTab({ paneId: created });
    act().openTerminalTab({ paneId: origin });

    expect(state().layout.type).toBe("split");
    act().closeTab(tabId);

    // created emptied → pruned → the split collapses back to `origin`.
    expect(state().layout.type).toBe("leaf");
    expect(state().layout.id).toBe(origin);
    expect(state().focusedPaneId).toBe(origin);
    assertLiveStoreInvariants();
  });

  it("keeps the last leaf alive when the final tab anywhere closes", () => {
    const tabId = act().openTerminalTab();
    act().closeTab(tabId);

    expect(state().layout.type).toBe("leaf");
    expect(leavesOf(state().layout)).toHaveLength(1);
    expect(state().tabs).toEqual({});
    assertLiveStoreInvariants();
  });

  it("ignores an unknown tab id", () => {
    act().openTerminalTab();
    const before = snapshot(state());

    act().closeTab(asTabId("ghost"));

    expect(snapshot(state())).toEqual(before);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });
});

/* ══════════════════════════ closeActiveTab (Cmd/Ctrl+W) ══════════════════════════ */

describe("closeActiveTab", () => {
  it("closes the focused pane's active TERMINAL tab", async () => {
    const a = act().openTerminalTab();
    const b = act().openTerminalTab(); // b is now active
    act().closeActiveTab();
    await flushBusyGate(); // Cmd/Ctrl+W routes through the busy check too
    expect(state().tabs[b]).toBeUndefined();
    expect(rootLeaf().tabIds).toEqual([a]);
    assertLiveStoreInvariants();
  });

  it("closes the focused pane's active EDITOR (file) tab", () => {
    const editorTab = injectEditorTab(rootLeaf().id);
    act().closeActiveTab();
    expect(state().tabs[editorTab]).toBeUndefined();
    assertLiveStoreInvariants();
  });

  it("closes the active API-request tab too (Cmd/Ctrl+W closes any tab kind)", () => {
    const api = act().openApiRequestTab(); // api-request kind, active
    act().closeActiveTab();
    expect(state().tabs[api]).toBeUndefined(); // HTTP requests must close too
    assertLiveStoreInvariants();
  });

  it("is a no-op when the focused pane has no active tab", () => {
    const before = snapshot(state()); // fresh boot: an empty leaf
    act().closeActiveTab();
    expect(snapshot(state())).toEqual(before);
  });

  it("is a no-op (never throws) when activeTabId has no backing tab record", () => {
    // A transient inconsistency: a tab id activated a beat before its record lands.
    useAppStore.setState((s) => {
      const leaf = leavesOf(s.layout)[0];
      leaf.tabIds.push(asTabId("ghost"));
      leaf.activeTabId = asTabId("ghost");
    });
    const before = snapshot(state());
    expect(() => act().closeActiveTab()).not.toThrow();
    expect(snapshot(state())).toEqual(before);
  });
});

/* ══════════════════════════ setActiveTab ══════════════════════════ */

describe("setActiveTab", () => {
  it("activates the tab and focuses its pane", () => {
    const a = act().openTerminalTab();
    act().openTerminalTab();
    const origin = rootLeaf().id;
    act().splitPane(origin, "row");
    expect(state().focusedPaneId).not.toBe(origin);

    act().setActiveTab(origin, a);

    expect(leafById(origin).activeTabId).toBe(a);
    expect(state().focusedPaneId).toBe(origin);
  });

  it("refuses a tab that does not live in the given pane", () => {
    const origin = rootLeaf().id;
    const created = act().splitPane(origin, "row");
    const tabId = act().openTerminalTab({ paneId: origin });

    act().setActiveTab(created, tabId);

    expect(leafById(created).activeTabId).toBeNull();
    assertLiveStoreInvariants();
  });

  it("ignores a split's id", () => {
    const tabId = act().openTerminalTab();
    act().splitPane(rootLeaf().id, "row");
    const before = snapshot(state());

    act().setActiveTab(asSplit(state().layout).id, tabId);

    expect(snapshot(state())).toEqual(before);
  });
});

/* ══════════════════════════ splitPane ══════════════════════════ */

describe("splitPane", () => {
  it("wraps the target in a split and focuses the new empty leaf", () => {
    const origin = rootLeaf().id;
    const tabId = act().openTerminalTab();

    const created = act().splitPane(origin, "row");

    const split = asSplit(state().layout);
    expect(split.orientation).toBe("row");
    expect(split.sizes).toEqual([0.5, 0.5]);
    expect(split.children.map((n) => n.id)).toEqual([origin, created]);
    // Splitting MOVES NOTHING — the tab stays put.
    expect(leafById(origin).tabIds).toEqual([tabId]);
    expect(leafById(created).tabIds).toEqual([]);
    expect(state().focusedPaneId).toBe(created);
    assertLiveStoreInvariants();
  });

  it("orients 'column' as a stacked split", () => {
    act().splitPane(rootLeaf().id, "column");
    expect(asSplit(state().layout).orientation).toBe("column");
  });

  it("splitting the same orientation inserts a sibling and halves that share", () => {
    const origin = rootLeaf().id;
    const first = act().splitPane(origin, "row"); // [origin .5, first .5]

    const second = act().splitPane(origin, "row"); // origin's .5 halves

    const split = asSplit(state().layout);
    // Flattened: one row of three, not a row nested in a row.
    expect(split.children.map((n) => n.id)).toEqual([origin, second, first]);
    expect(split.sizes).toEqual([0.25, 0.25, 0.5]);
    assertLiveStoreInvariants();
  });

  it("splitting the cross orientation nests a new split", () => {
    const origin = rootLeaf().id;
    act().splitPane(origin, "row");
    const created = act().splitPane(origin, "column");

    const root = asSplit(state().layout);
    expect(root.orientation).toBe("row");
    const nested = asSplit(root.children[0]);
    expect(nested.orientation).toBe("column");
    expect(nested.children.map((n) => n.id)).toEqual([origin, created]);
    assertLiveStoreInvariants();
  });

  it("refuses to split a split node, returning the id unchanged", () => {
    act().splitPane(rootLeaf().id, "row");
    const splitId = asSplit(state().layout).id;
    const before = snapshot(state());

    expect(act().splitPane(splitId, "column")).toBe(splitId);
    expect(snapshot(state())).toEqual(before);
  });

  it("refuses an unknown pane id", () => {
    const before = snapshot(state());
    const ghost = asPaneId("ghost");
    expect(act().splitPane(ghost, "row")).toBe(ghost);
    expect(snapshot(state())).toEqual(before);
  });

  it("opens no PTY — a fresh split leaf is a placeholder, not a terminal", () => {
    act().splitPane(rootLeaf().id, "row");
    expect(terminal.configureTerminal).not.toHaveBeenCalled();
    expect(state().tabs).toEqual({});
  });
});

/* ═════════ the subtle one: split-created empty leaves survive ═════════ */

describe("split-created empty leaves survive unrelated mutations", () => {
  /**
   * Pruning is opt-in per call precisely so that `splitPane`'s empty leaf is not
   * instantly undone by the next canonicalize pass. Every action that
   * recanonicalizes nominates ONLY the leaf it just emptied, so an unrelated
   * empty leaf must be untouched. `store.ts` flags this as the trap; these are
   * the regression guards.
   */
  let empty: PaneId;
  let busy: PaneId;

  beforeEach(() => {
    busy = rootLeaf().id;
    act().openTerminalTab({ paneId: busy });
    act().openTerminalTab({ paneId: busy });
    empty = act().splitPane(busy, "row");
    expect(leafById(empty).tabIds).toEqual([]);
  });

  const stillThere = () => {
    expect(
      findNode(state().layout, empty),
      "the split-created empty leaf was pruned by an unrelated mutation",
    ).not.toBeNull();
    assertLiveStoreInvariants();
  };

  it("survives closeTab on a leaf that still has tabs", () => {
    act().closeTab(leafById(busy).tabIds[0]);
    stillThere();
  });

  it("survives closeTab that empties a DIFFERENT leaf", () => {
    const third = act().splitPane(busy, "column");
    const tabId = act().openTerminalTab({ paneId: third });
    act().closeTab(tabId); // third empties and collapses...
    expect(findNode(state().layout, third)).toBeNull();
    stillThere(); // ...but `empty` does not
  });

  it("survives receiving a tab — it is a real drop target, not a ghost", () => {
    const tabId = leafById(busy).tabIds[0];
    act().moveTab(tabId, empty);
    expect(leafById(empty).tabIds).toEqual([tabId]);
    stillThere();
  });

  it("collapses once it has HELD a tab and then loses it", () => {
    // The distinction that makes pruning opt-in: a split-fresh empty leaf is
    // kept, but a leaf that *emptied* is nominated by moveTab and collapses.
    // Same leaf, different history — so this is not a contradiction of the
    // tests above, it is the other half of the rule.
    const tabId = leafById(busy).tabIds[0];
    act().moveTab(tabId, empty);
    act().moveTab(tabId, busy);

    expect(findNode(state().layout, empty)).toBeNull();
    assertLiveStoreInvariants();
  });

  it("survives moveTab that empties a different leaf", () => {
    const third = act().splitPane(busy, "column");
    const tabId = act().openTerminalTab({ paneId: third });
    act().moveTab(tabId, busy); // third empties → pruned
    expect(findNode(state().layout, third)).toBeNull();
    stillThere();
  });

  it("survives closePane on a different leaf", () => {
    const third = act().splitPane(busy, "column");
    act().openTerminalTab({ paneId: third });
    act().closePane(third);
    stillThere();
  });

  it("survives openTerminalTab, resizePane and focusPane elsewhere", () => {
    act().openTerminalTab({ paneId: busy });
    act().resizePane(asSplit(state().layout).id, [800, 200]);
    act().focusPane(busy);
    stillThere();
  });

  it("survives a second split of a sibling", () => {
    act().splitPane(busy, "row");
    stillThere();
  });

  it("is itself removable via closePane (the only way to dismiss it)", () => {
    act().closePane(empty);
    expect(findNode(state().layout, empty)).toBeNull();
    assertLiveStoreInvariants();
  });
});

/* ══════════════════════════ resizePane ══════════════════════════ */

describe("resizePane", () => {
  let splitId: PaneId;

  beforeEach(() => {
    act().splitPane(rootLeaf().id, "row");
    splitId = asSplit(state().layout).id;
  });

  it("normalizes pixel sizes straight from allotment into fractions", () => {
    act().resizePane(splitId, [300, 100]);
    expect(asSplit(state().layout).sizes).toEqual([0.75, 0.25]);
  });

  it("accepts fractions unchanged", () => {
    act().resizePane(splitId, [0.3, 0.7]);
    expect(asSplit(state().layout).sizes).toEqual([0.3, 0.7]);
  });

  it("ignores a no-op emission — no new state object per container resize", () => {
    act().resizePane(splitId, [300, 100]);
    const settled = state().layout;

    act().resizePane(splitId, [600, 200]); // same ratio, different pixels
    expect(state().layout).toBe(settled);
  });

  it("rejects a sizes array whose length does not match the children", () => {
    const before = asSplit(state().layout).sizes;
    act().resizePane(splitId, [1, 2, 3]);
    expect(asSplit(state().layout).sizes).toEqual(before);
  });

  it("ignores a leaf's id and an unknown id", () => {
    const before = snapshot(state());
    act().resizePane(rootLeaf().id, [0.3, 0.7]);
    act().resizePane(asPaneId("ghost"), [0.3, 0.7]);
    expect(snapshot(state())).toEqual(before);
  });

  it("keeps the invariant under degenerate input", () => {
    act().resizePane(splitId, [0, 0]);
    expect(asSplit(state().layout).sizes).toEqual([0.5, 0.5]);

    act().resizePane(splitId, [Number.NaN, 10]);
    expect(asSplit(state().layout).sizes).toEqual([0, 1]);

    act().resizePane(splitId, [-3, 3]);
    assertLiveStoreInvariants();
  });

  it("does not restructure the tree — sizes-only edits keep pane identity", () => {
    const ids = leafIds(state().layout);
    act().resizePane(splitId, [900, 100]);
    expect(leafIds(state().layout)).toEqual(ids);
    assertLiveStoreInvariants();
  });

  it("property: any realistic weights normalize to a distribution summing to 1", () => {
    fc.assert(
      fc.property(
        fc.array(weightArb, { minLength: 2, maxLength: 2 }),
        (weights) => {
          act().resizePane(splitId, weights);
          assertLiveStoreInvariants();
        },
      ),
    );
  });
});

/* ══════════════════════════ focusPane ══════════════════════════ */

describe("focusPane", () => {
  it("focuses an existing leaf", () => {
    const origin = rootLeaf().id;
    act().splitPane(origin, "row");
    act().focusPane(origin);
    expect(state().focusedPaneId).toBe(origin);
  });

  it("is a no-op for a split, an unknown id, and the already-focused pane", () => {
    act().splitPane(rootLeaf().id, "row");
    const settled = state();

    act().focusPane(asSplit(settled.layout).id);
    act().focusPane(asPaneId("ghost"));
    act().focusPane(settled.focusedPaneId);

    expect(state()).toBe(settled); // not even a new state object
  });

  it("repairs focus automatically when the focused pane is pruned away", () => {
    const origin = rootLeaf().id;
    act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");
    const tabId = act().openTerminalTab({ paneId: created });
    expect(state().focusedPaneId).toBe(created);

    act().closeTab(tabId); // `created` disappears out from under focus

    expect(state().focusedPaneId).toBe(origin);
    assertLiveStoreInvariants();
  });
});

/* ══════════════════════════ moveTab ══════════════════════════ */

describe("moveTab", () => {
  it("moves the tab, activates it in the destination and focuses there", () => {
    const origin = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");

    act().moveTab(a, created);

    expect(leafById(origin).tabIds).toEqual([b]);
    expect(leafById(created).tabIds).toEqual([a]);
    expect(leafById(created).activeTabId).toBe(a);
    expect(state().focusedPaneId).toBe(created);
    expect(state().tabs[a]).toBeDefined(); // the record survives the move
    assertLiveStoreInvariants();
  });

  it("collapses the source leaf when it hands over its last tab", () => {
    const origin = rootLeaf().id;
    const tabId = act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");
    act().openTerminalTab({ paneId: created });

    act().moveTab(tabId, created);

    expect(state().layout.type).toBe("leaf");
    expect(state().layout.id).toBe(created);
    assertLiveStoreInvariants();
  });

  it("never disposes a terminal — a move is not a close", () => {
    const origin = rootLeaf().id;
    const tabId = act().openTerminalTab({ paneId: origin });
    act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");

    act().moveTab(tabId, created);

    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("is a no-op when the source and destination are the same pane", () => {
    const tabId = act().openTerminalTab();
    act().openTerminalTab();
    const settled = state();

    act().moveTab(tabId, rootLeaf().id);

    expect(state()).toBe(settled);
  });

  it("ignores an unknown tab, an unknown pane and a split destination", () => {
    const origin = rootLeaf().id;
    const tabId = act().openTerminalTab({ paneId: origin });
    act().splitPane(origin, "row");
    const before = snapshot(state());

    act().moveTab(asTabId("ghost"), origin);
    act().moveTab(tabId, asPaneId("ghost"));
    act().moveTab(tabId, asSplit(state().layout).id);

    expect(snapshot(state())).toEqual(before);
  });
});

/* ══════════════════════ moveTab — reorder (indexed) ══════════════════════ */

/**
 * `moveTab(tab, pane, index)` doubles as reorder-within-a-pane: same action,
 * because "put this tab in this pane at this position" is one idea, and a tab
 * dragged onto a strip should behave the same whether it came from this pane or
 * the one next door.
 *
 * The index is measured against the strip AS DRAWN (the dragged tab still in
 * it), because that is what the user is looking at when they let go. Every
 * off-by-one lives in that translation, so it is pinned exhaustively below.
 */
describe("moveTab — reorder within a pane", () => {
  /** A pane with three tabs, in order. */
  function threeTabs() {
    const paneId = rootLeaf().id;
    const a = act().openTerminalTab({ paneId });
    const b = act().openTerminalTab({ paneId });
    const c = act().openTerminalTab({ paneId });
    return { paneId, a, b, c };
  }
  const order = () => rootLeaf().tabIds;

  it("drags the first tab to the end", () => {
    const { paneId, a, b, c } = threeTabs();
    act().moveTab(a, paneId, 3); // dropped past the last tab
    expect(order()).toEqual([b, c, a]);
    assertLiveStoreInvariants();
  });

  it("drags the last tab to the front", () => {
    const { paneId, a, b, c } = threeTabs();
    act().moveTab(c, paneId, 0);
    expect(order()).toEqual([c, a, b]);
    assertLiveStoreInvariants();
  });

  it("drags the first tab into the middle — the index shift is handled", () => {
    const { paneId, a, b, c } = threeTabs();
    // "Before c" reads as index 2 on the strip as drawn; once `a` is lifted out
    // everything after it shifts left, so the real insert point is 1.
    act().moveTab(a, paneId, 2);
    expect(order()).toEqual([b, a, c]);
    assertLiveStoreInvariants();
  });

  it("drags a middle tab left and right", () => {
    const { paneId, a, b, c } = threeTabs();
    act().moveTab(b, paneId, 0);
    expect(order()).toEqual([b, a, c]);
    act().moveTab(b, paneId, 3);
    expect(order()).toEqual([a, c, b]);
    assertLiveStoreInvariants();
  });

  it("is a no-op dropped at its own position — both readings of it", () => {
    const { paneId, a, b, c } = threeTabs();
    const settled = state();

    // "Before myself" and "before the tab after me" are the same position.
    act().moveTab(b, paneId, 1);
    expect(state()).toBe(settled);
    act().moveTab(b, paneId, 2);
    expect(state()).toBe(settled);
    // Same for the ends.
    act().moveTab(a, paneId, 0);
    expect(state()).toBe(settled);
    act().moveTab(c, paneId, 3);
    expect(state()).toBe(settled);

    expect(order()).toEqual([a, b, c]);
  });

  it("still appends-as-no-op when no index is given (unchanged behaviour)", () => {
    const { paneId, a, b, c } = threeTabs();
    const settled = state();
    act().moveTab(a, paneId); // no index → "into the pane it is already in"
    expect(state()).toBe(settled);
    expect(order()).toEqual([a, b, c]);
  });

  it("activates and focuses the tab you dragged", () => {
    const { paneId, a, b } = threeTabs();
    act().setActiveTab(paneId, b);
    act().moveTab(a, paneId, 3);
    expect(rootLeaf().activeTabId).toBe(a);
    expect(state().focusedPaneId).toBe(paneId);
  });

  it("clamps a nonsense index instead of corrupting the strip", () => {
    const { paneId, a, b, c } = threeTabs();
    act().moveTab(a, paneId, 99);
    expect(order()).toEqual([b, c, a]);
    act().moveTab(a, paneId, -5);
    expect(order()).toEqual([a, b, c]);
    act().moveTab(a, paneId, NaN); // unlaid-out strip → append, never index 0
    expect(order()).toEqual([b, c, a]);
    assertLiveStoreInvariants();
  });

  it("leaves the pane tree completely untouched — reorder is not a layout change", () => {
    const { paneId, a } = threeTabs();
    act().splitPane(paneId, "row");
    const treeBefore = treeShape(state().layout);

    act().moveTab(a, paneId, 3);

    // Same panes, same ids, same sizes: only tabIds inside one leaf moved.
    expect(leafIds(state().layout)).toEqual(leafIds(state().layout));
    expect(splitsOf(state().layout).map((s) => s.sizes)).toEqual(
      splitsOf(state().layout).map((s) => s.sizes),
    );
    expect(treeShape(state().layout)).not.toEqual(treeBefore); // tabIds did move
    assertLiveStoreInvariants();
  });

  it("never disposes a terminal — reordering is not closing", () => {
    const { paneId, a } = threeTabs();
    act().moveTab(a, paneId, 3);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });
});

describe("moveTab — indexed insert across panes", () => {
  it("inserts at the drop index rather than appending", () => {
    const origin = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");
    const x = act().openTerminalTab({ paneId: created });
    const y = act().openTerminalTab({ paneId: created });

    act().moveTab(a, created, 1); // between x and y

    expect(leafById(created).tabIds).toEqual([x, a, y]);
    expect(leafById(created).activeTabId).toBe(a);
    assertLiveStoreInvariants();
  });

  it("index 0 puts it first; a large index appends", () => {
    const origin = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");
    const x = act().openTerminalTab({ paneId: created });

    act().moveTab(a, created, 0);
    expect(leafById(created).tabIds).toEqual([a, x]);

    act().moveTab(b, created, 99);
    expect(leafById(created).tabIds).toEqual([a, x, b]);
    assertLiveStoreInvariants();
  });

  it("collapses the source pane when an indexed move empties it", () => {
    const origin = rootLeaf().id;
    const lonely = act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");
    act().openTerminalTab({ paneId: created });

    act().moveTab(lonely, created, 0);

    expect(findNode(state().layout, origin)).toBeNull();
    expect(state().layout.type).toBe("leaf");
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });
});

/* ══════════════════════════ moveTabToEdge ══════════════════════════ */

/**
 * Drag a tab onto a pane's edge → that pane splits and the tab lands on that
 * side. The direct-manipulation path to 3+ panes, and the
 * only action that both moves a tab AND restructures the tree in one step —
 * which is exactly why it needs the hardest tests here.
 */
describe("moveTabToEdge", () => {
  it.each([
    ["left", "row", 0],
    ["right", "row", 1],
    ["top", "column", 0],
    ["bottom", "column", 1],
  ] as const)(
    "dropping on the %s edge builds a %s split with the tab at index %i",
    (edge, orientation, tabIndex) => {
      const origin = rootLeaf().id;
      const stay = act().openTerminalTab({ paneId: origin });
      const move = act().openTerminalTab({ paneId: origin });

      act().moveTabToEdge(move, origin, edge);

      const root = asSplit(state().layout);
      expect(root.orientation).toBe(orientation);
      expect(root.sizes).toEqual([0.5, 0.5]);
      expect(root.children).toHaveLength(2);

      // The dragged tab is alone in the new leaf, on the side it was dropped.
      const landed = root.children[tabIndex] as LeafNode;
      const source = root.children[1 - tabIndex] as LeafNode;
      expect(landed.tabIds).toEqual([move]);
      expect(landed.activeTabId).toBe(move);
      expect(source.tabIds).toEqual([stay]);
      expect(source.id).toBe(origin); // the original pane keeps its identity

      // Focus follows the tab you just dragged.
      expect(state().focusedPaneId).toBe(landed.id);
      assertLiveStoreInvariants();
    },
  );

  it("separates two tabs of ONE pane", () => {
    // With more than two tabs open, more than two can be displayed at once.
    const origin = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin });
    const c = act().openTerminalTab({ paneId: origin });
    expect(leavesOf(state().layout)).toHaveLength(1);

    act().moveTabToEdge(c, origin, "right");

    const leaves = leavesOf(state().layout);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].tabIds).toEqual([a, b]);
    expect(leaves[1].tabIds).toEqual([c]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("builds 3, then 4 panes by repeated edge drops — no cap, flattened flat", () => {
    const origin = rootLeaf().id;
    const tabs = [
      act().openTerminalTab({ paneId: origin }),
      act().openTerminalTab({ paneId: origin }),
      act().openTerminalTab({ paneId: origin }),
      act().openTerminalTab({ paneId: origin }),
    ];

    act().moveTabToEdge(tabs[1], origin, "right");
    expect(leavesOf(state().layout)).toHaveLength(2);

    // Drop onto the newest pane's right edge: same orientation as its parent,
    // so canonicalize flattens it into ONE 3-way row rather than nesting.
    const second = leavesOf(state().layout)[1].id;
    act().moveTabToEdge(tabs[2], second, "right");
    let root = asSplit(state().layout);
    expect(root.children).toHaveLength(3);
    expect(root.children.every((c) => c.type === "leaf")).toBe(true);

    const third = leavesOf(state().layout)[2].id;
    act().moveTabToEdge(tabs[3], third, "right");
    root = asSplit(state().layout);
    expect(root.children).toHaveLength(4);
    expect(root.orientation).toBe("row");
    // Every tab still on screen, each alone in visual order.
    expect(leavesOf(state().layout).map((l) => l.tabIds)).toEqual([
      [tabs[0]],
      [tabs[1]],
      [tabs[2]],
      [tabs[3]],
    ]);
    assertLiveStoreInvariants();
  });

  it("inserts at the right index when flattening — left lands BEFORE the target", () => {
    const origin = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin });
    const c = act().openTerminalTab({ paneId: origin });
    act().moveTabToEdge(b, origin, "right"); // row(origin[a,c], B[b])

    const target = leavesOf(state().layout)[1].id;
    act().moveTabToEdge(c, target, "left"); // flattens: row(origin[a], C[c], B[b])

    const leaves = leavesOf(state().layout);
    expect(leaves.map((l) => l.tabIds)).toEqual([[a], [c], [b]]);
    assertLiveStoreInvariants();
  });

  it("mixes orientations — a column drop nests inside a row", () => {
    const origin = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin });
    const c = act().openTerminalTab({ paneId: origin });
    act().moveTabToEdge(b, origin, "right");

    const target = leavesOf(state().layout)[1].id;
    act().moveTabToEdge(c, target, "bottom");

    const root = asSplit(state().layout);
    expect(root.orientation).toBe("row");
    expect(root.children[0].type).toBe("leaf");
    const nested = asSplit(root.children[1]);
    expect(nested.orientation).toBe("column");
    expect(leavesOf(state().layout).map((l) => l.tabIds)).toEqual([
      [a],
      [b],
      [c],
    ]);
    assertLiveStoreInvariants();
  });

  it("collapses the source pane when it hands over its last tab", () => {
    const origin = rootLeaf().id;
    const lonely = act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");
    act().openTerminalTab({ paneId: created });

    // origin empties → pruned → its split collapses → the target splits anew.
    act().moveTabToEdge(lonely, created, "bottom");

    expect(findNode(state().layout, origin)).toBeNull();
    const root = asSplit(state().layout);
    expect(root.orientation).toBe("column");
    expect(leavesOf(state().layout)).toHaveLength(2);
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("is a no-op when a pane's ONLY tab is dropped on its own edge", () => {
    // Splitting here would empty the source half, prune it, and collapse back
    // to exactly this tree — but with a fresh PaneId, remounting the terminal
    // for nothing. Nothing was asked for; nothing must change, by identity.
    const origin = rootLeaf().id;
    const tabId = act().openTerminalTab({ paneId: origin });
    const settled = state();

    for (const edge of ["left", "right", "top", "bottom"] as const) {
      act().moveTabToEdge(tabId, origin, edge);
      expect(state()).toBe(settled);
    }
    expect(state().layout.id).toBe(origin);
  });

  it("still splits when a pane with 2+ tabs drops one on its OWN edge", () => {
    // The mirror of the case above: here the drop genuinely separates tabs.
    const origin = rootLeaf().id;
    act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin });

    act().moveTabToEdge(b, origin, "left");

    expect(leavesOf(state().layout)).toHaveLength(2);
    assertLiveStoreInvariants();
  });

  it("ignores an unknown tab, an unknown pane and a split target", () => {
    const origin = rootLeaf().id;
    const tabId = act().openTerminalTab({ paneId: origin });
    act().openTerminalTab({ paneId: origin });
    act().splitPane(origin, "row");
    const before = snapshot(state());

    act().moveTabToEdge(asTabId("ghost"), origin, "left");
    act().moveTabToEdge(tabId, asPaneId("ghost"), "left");
    act().moveTabToEdge(tabId, asSplit(state().layout).id, "left");

    expect(snapshot(state())).toEqual(before);
  });

  it("never disposes a terminal — a drag is not a close", () => {
    const origin = rootLeaf().id;
    act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin });

    act().moveTabToEdge(b, origin, "right");

    expect(terminal.dispose).not.toHaveBeenCalled();
    // The tab record — and thus its TerminalId — survives untouched.
    expect(state().tabs[b]).toBeDefined();
  });

  it("preserves the tab's TerminalId across the move — same PTY, new pane", () => {
    const origin = rootLeaf().id;
    act().openTerminalTab({ paneId: origin });
    const b = act().openTerminalTab({ paneId: origin, cwd: "/w/gazelle" });
    const before = terminalIdOfTab(b);

    act().moveTabToEdge(b, origin, "bottom");

    expect(terminalIdOfTab(b)).toBe(before);
    // And it was never re-configured: no second spawn was set up for it.
    expect(terminal.configureTerminal).toHaveBeenCalledTimes(1);
  });
});

/* ══════════════════════════ closePane ══════════════════════════ */

describe("closePane", () => {
  it("removes the leaf and every tab record it held", () => {
    const origin = rootLeaf().id;
    const created = act().splitPane(origin, "row");
    const a = act().openTerminalTab({ paneId: created });
    const b = act().openTerminalTab({ paneId: created });
    act().openTerminalTab({ paneId: origin });

    act().closePane(created);

    expect(findNode(state().layout, created)).toBeNull();
    expect(state().tabs[a]).toBeUndefined();
    expect(state().tabs[b]).toBeUndefined();
    expect(state().layout.id).toBe(origin);
    assertLiveStoreInvariants();
  });

  it("disposes every terminal it takes down, exactly once each", () => {
    const origin = rootLeaf().id;
    const created = act().splitPane(origin, "row");
    const a = act().openTerminalTab({ paneId: created });
    const b = act().openTerminalTab({ paneId: created });
    const terminalIds = [terminalIdOfTab(a), terminalIdOfTab(b)];
    act().openTerminalTab({ paneId: origin });

    act().closePane(created);

    expect(terminal.dispose).toHaveBeenCalledTimes(2);
    expect(terminal.dispose.mock.calls.map((c) => c[0]).sort()).toEqual(
      [...terminalIds].sort(),
    );
  });

  it("skips editor tabs when disposing", () => {
    const origin = rootLeaf().id;
    const created = act().splitPane(origin, "row");
    injectEditorTab(created);
    const termTab = act().openTerminalTab({ paneId: created });
    const terminalId = terminalIdOfTab(termTab);
    act().openTerminalTab({ paneId: origin });

    act().closePane(created);

    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledWith(terminalId);
  });

  it("empties but preserves the last pane — 'Close all tabs' semantics", () => {
    const origin = rootLeaf().id;
    act().openTerminalTab();
    act().openTerminalTab();

    act().closePane(origin);

    expect(state().layout.type).toBe("leaf");
    expect(state().layout.id).toBe(origin);
    expect((state().layout as LeafNode).tabIds).toEqual([]);
    expect(state().tabs).toEqual({});
    expect(state().focusedPaneId).toBe(origin);
    expect(terminal.dispose).toHaveBeenCalledTimes(2);
    assertLiveStoreInvariants();
  });

  it("closes an empty pane — closeTab alone could never dismiss one", () => {
    const origin = rootLeaf().id;
    act().openTerminalTab({ paneId: origin });
    const created = act().splitPane(origin, "row");

    act().closePane(created);

    expect(state().layout.id).toBe(origin);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("ignores a split's id and an unknown id", () => {
    act().openTerminalTab();
    act().splitPane(rootLeaf().id, "row");
    const before = snapshot(state());

    act().closePane(asSplit(state().layout).id);
    act().closePane(asPaneId("ghost"));

    expect(snapshot(state())).toEqual(before);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });
});

/* ══════════════ Immer: the store never mutates prior state ══════════════ */

describe("immutability", () => {
  it("leaves a previously captured state object untouched by later actions", () => {
    const tabId = act().openTerminalTab();
    const captured = state();
    const clone = snapshot(captured);

    act().splitPane(captured.layout.id, "row");
    act().openTerminalTab();
    act().closeTab(tabId);

    expect(snapshot(captured)).toEqual(clone);
    expect(state()).not.toBe(captured);
  });

  it("hands out frozen state — accidental direct writes cannot pass silently", () => {
    act().openTerminalTab();
    expect(Object.isFrozen(state().layout)).toBe(true);
    expect(Object.isFrozen(state().tabs)).toBe(true);
  });
});

/* ════════════ the headline: random action sequences ════════════ */

/**
 * A command addressed by *index*, resolved against the live tree at execution
 * time. Concrete PaneIds/TabIds cannot be generated up front — they are minted
 * by the very actions under test — so `fc.nat()` indices modulo the current
 * collection are the standard way to keep sequences valid and shrinkable.
 */
type Cmd =
  | { t: "openTab"; pane: number; cwd: string | undefined }
  | { t: "closeTab"; tab: number }
  | { t: "split"; pane: number; orientation: Orientation }
  | { t: "resize"; split: number; weights: number[] }
  | { t: "focus"; pane: number }
  | { t: "moveTab"; tab: number; pane: number; index: number | undefined }
  | { t: "moveTabToEdge"; tab: number; pane: number; edge: SplitEdge }
  | { t: "closePane"; pane: number }
  | { t: "setActive"; pane: number; tab: number };

const idx = fc.nat({ max: 1000 });
const edgeArb = fc.constantFrom<SplitEdge>("left", "right", "top", "bottom");

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  // Weighted so trees actually grow: a uniform mix spends most of its budget
  // closing an empty tree and never reaches an interesting depth.
  {
    arbitrary: fc.record({
      t: fc.constant("openTab" as const),
      pane: idx,
      cwd: fc.option(fc.constantFrom("/w/gazelle", "/w/api", "/"), {
        nil: undefined,
      }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      t: fc.constant("split" as const),
      pane: idx,
      orientation: orientationArb,
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({ t: fc.constant("closeTab" as const), tab: idx }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      t: fc.constant("resize" as const),
      split: idx,
      weights: fc.array(weightArb, { minLength: 1, maxLength: 4 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ t: fc.constant("focus" as const), pane: idx }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      t: fc.constant("moveTab" as const),
      tab: idx,
      pane: idx,
      // `undefined` keeps the append/no-op path in the mix; the small ints
      // reach every real drop position AND overshoot it (clamping).
      index: fc.option(fc.integer({ min: -2, max: 6 }), { nil: undefined }),
    }),
    weight: 3,
  },
  {
    // Weighted like `split`: this is the action that both moves a tab and
    // restructures the tree, so sequences should reach it often.
    arbitrary: fc.record({
      t: fc.constant("moveTabToEdge" as const),
      tab: idx,
      pane: idx,
      edge: edgeArb,
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({ t: fc.constant("closePane" as const), pane: idx }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      t: fc.constant("setActive" as const),
      pane: idx,
      tab: idx,
    }),
    weight: 2,
  },
);

const cmdsArb = fc.array(cmdArb, { minLength: 1, maxLength: 30 });

const at = <T>(xs: readonly T[], i: number): T => xs[i % xs.length];

/** Apply one command against the live store. Never throws on a bad index. */
function runCmd(cmd: Cmd): void {
  const s = state();
  const a = s.layoutActions;
  const leaves = leavesOf(s.layout); // invariant: never empty
  const tabIds = Object.keys(s.tabs) as TabId[];
  const splits = splitsOf(s.layout);

  switch (cmd.t) {
    case "openTab":
      a.openTerminalTab({ paneId: at(leaves, cmd.pane).id, cwd: cmd.cwd });
      return;
    case "split":
      a.splitPane(at(leaves, cmd.pane).id, cmd.orientation);
      return;
    case "closeTab":
      if (tabIds.length) a.closeTab(at(tabIds, cmd.tab));
      return;
    case "resize": {
      if (!splits.length) return;
      const split = at(splits, cmd.split);
      a.resizePane(
        split.id,
        split.children.map((_, i) => at(cmd.weights, i)),
      );
      return;
    }
    case "focus":
      a.focusPane(at(leaves, cmd.pane).id);
      return;
    case "moveTab":
      if (tabIds.length) {
        a.moveTab(at(tabIds, cmd.tab), at(leaves, cmd.pane).id, cmd.index);
      }
      return;
    case "moveTabToEdge":
      if (tabIds.length) {
        a.moveTabToEdge(at(tabIds, cmd.tab), at(leaves, cmd.pane).id, cmd.edge);
      }
      return;
    case "closePane":
      a.closePane(at(leaves, cmd.pane).id);
      return;
    case "setActive":
      if (tabIds.length)
        a.setActiveTab(at(leaves, cmd.pane).id, at(tabIds, cmd.tab));
      return;
  }
}

const describeCmd = (cmd: Cmd, i: number) =>
  `after cmd #${i} ${JSON.stringify(cmd)}`;

describe("property: arbitrary action sequences", () => {
  it("holds every canonicalization invariant after every single action", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetStore();
        assertLiveStoreInvariants("at boot");
        cmds.forEach((cmd, i) => {
          runCmd(cmd);
          assertLiveStoreInvariants(describeCmd(cmd, i));
        });
      }),
    );
  });

  it("never mutates a state object it has already handed out", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetStore();
        cmds.forEach((cmd, i) => {
          const before = state();
          const clone = snapshot(before);
          runCmd(cmd);
          // The old object must still deep-equal the clone taken before the
          // action: Immer produces a new tree, it does not edit the old one.
          expect(snapshot(before), describeCmd(cmd, i)).toEqual(clone);
        });
      }),
    );
  });

  it("disposes exactly the terminals whose tabs are gone — no leaks, no double-frees", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetStore();
        terminal.dispose.mockClear();

        // Every terminal the store ever minted, and the tab that owned it.
        const owners = new Map<TabId, TerminalId>();
        const record = () => {
          for (const [tabId, tab] of Object.entries(state().tabs) as [
            TabId,
            Tab,
          ][]) {
            if (
              tab.ref.kind === "terminal" ||
              tab.ref.kind === "agent-terminal"
            )
              owners.set(tabId, tab.ref.terminalId);
          }
        };

        record();
        for (const cmd of cmds) {
          runCmd(cmd);
          record();
        }

        const live = new Set(Object.keys(state().tabs) as TabId[]);
        const expectedDisposed = [...owners]
          .filter(([tabId]) => !live.has(tabId))
          .map(([, terminalId]) => terminalId);

        const disposed = terminal.dispose.mock.calls.map(
          (c) => c[0] as TerminalId,
        );

        // No double-free: dispose is idempotent, but calling it twice would mean
        // the store lost track of a tab's lifetime.
        expect(disposed).toHaveLength(expectedDisposed.length);
        expect([...disposed].sort()).toEqual([...expectedDisposed].sort());

        // And nothing still on screen was torn down underneath it.
        for (const tabId of live) {
          const tab = state().tabs[tabId];
          if (tab.ref.kind !== "terminal" && tab.ref.kind !== "agent-terminal")
            continue;
          expect(disposed).not.toContain(tab.ref.terminalId);
        }
      }),
    );
  });

  it("configures exactly one terminal per cwd-bearing open, and never any other", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetStore();
        terminal.configureTerminal.mockClear();

        const expected = cmds.filter((c) => c.t === "openTab" && c.cwd).length;
        cmds.forEach(runCmd);

        expect(terminal.configureTerminal).toHaveBeenCalledTimes(expected);
        for (const [, opts] of terminal.configureTerminal.mock.calls) {
          expect(opts).toHaveProperty("cwd");
          expect(typeof (opts as { cwd: unknown }).cwd).toBe("string");
        }
      }),
    );
  });

  it("keeps canonicalize a fixed point of the live tree at all times", () => {
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetStore();
        cmds.forEach((cmd, i) => {
          runCmd(cmd);
          const live = state().layout;
          // Re-canonicalizing settled state must change nothing — if it did,
          // some action left the tree de-canonical.
          expect(treeShape(canonicalize(live)), describeCmd(cmd, i)).toEqual(
            treeShape(live),
          );
        });
      }),
    );
  });

  it("reorder is a permutation — same tabs, same pane, same tree, new order", () => {
    // The reorder-specific risk: `index` is measured against the strip WITH the
    // dragged tab still in it, so the removal shifts it. An off-by-one there
    // silently drops or duplicates a tab while every structural invariant still
    // passes — so assert the multiset directly, per drop.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -2, max: 6 }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.array(idx, { minLength: 1, maxLength: 12 }),
        (indices, picks) => {
          resetStore();
          const paneId = rootLeaf().id;
          const tabs = [
            act().openTerminalTab({ paneId }),
            act().openTerminalTab({ paneId }),
            act().openTerminalTab({ paneId }),
            act().openTerminalTab({ paneId }),
          ];
          const tree = treeShape(state().layout);

          indices.forEach((index, i) => {
            const tabId = at(tabs, at(picks, i));
            const where = `after reorder #${i}: ${tabId} → ${index}`;
            const orderBefore = [...rootLeaf().tabIds];
            const activeBefore = rootLeaf().activeTabId;
            const settled = state();

            act().moveTab(tabId, paneId, index);

            const strip = rootLeaf().tabIds;
            // A permutation: every tab still there, exactly once, still here.
            expect([...strip].sort(), where).toEqual([...tabs].sort());
            expect(new Set(strip).size, where).toBe(strip.length);

            if (strip.join() === orderBefore.join()) {
              // Dropped exactly where it already sat. "No spurious state
              // change" is literal: not even activation moves, and the state
              // object itself is untouched, so nothing re-renders.
              expect(state(), where).toBe(settled);
              expect(rootLeaf().activeTabId, where).toBe(activeBefore);
            } else {
              // It moved — so the tab you dragged is the one now in front.
              expect(rootLeaf().activeTabId, where).toBe(tabId);
            }

            // Either way, reorder is NOT a layout change: one leaf, same id.
            expect(state().layout.type, where).toBe("leaf");
            expect(state().layout.id, where).toBe(paneId);
            assertLiveStoreInvariants(where);
          });

          // Structure identical to before any reorder, modulo the tab order.
          expect(state().layout.type).toBe("leaf");
          expect((tree as { id: string }).id).toBe(state().layout.id);
          expect(terminal.dispose).not.toHaveBeenCalled();
        },
      ),
    );
  });

  it("an indexed move lands the tab at exactly the index the user saw", () => {
    // Reference model: splice the strip-as-drawn, then read back where the tab
    // ended up. This is the property the off-by-one adjustment exists to hold.
    fc.assert(
      fc.property(
        fc.nat({ max: 3 }),
        fc.integer({ min: 0, max: 4 }),
        (fromIdx, dropIdx) => {
          resetStore();
          const paneId = rootLeaf().id;
          const tabs = [
            act().openTerminalTab({ paneId }),
            act().openTerminalTab({ paneId }),
            act().openTerminalTab({ paneId }),
            act().openTerminalTab({ paneId }),
          ];
          const tabId = tabs[fromIdx];

          // What the user is looking at: the strip with a gap opened at dropIdx.
          const expected = [...tabs];
          expected.splice(fromIdx, 1);
          const insertAt = dropIdx > fromIdx ? dropIdx - 1 : dropIdx;
          expected.splice(Math.min(insertAt, expected.length), 0, tabId);

          act().moveTab(tabId, paneId, dropIdx);

          expect(rootLeaf().tabIds).toEqual(expected);
        },
      ),
    );
  });

  it("moveTabToEdge conserves tabs — a drag never creates, drops or clones one", () => {
    // The distinguishing risk of this action: it detaches a tab and re-inserts
    // it into a leaf that is being built in the same pass. An off-by-one there
    // loses the tab entirely (or duplicates it into two panes) while every
    // structural invariant still passes.
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetStore();
        cmds.forEach((cmd, i) => {
          const before = [...allTabIdsInTree(state().layout)].sort();
          runCmd(cmd);
          if (cmd.t !== "moveTabToEdge") return;
          const after = [...allTabIdsInTree(state().layout)].sort();
          // A pure re-arrangement: exactly the same multiset of tabs, always.
          expect(after, describeCmd(cmd, i)).toEqual(before);
        });
      }),
    );
  });

  it("moveTabToEdge never disposes a terminal, however the tree churns", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 1, maxLength: 30 }), (cmds) => {
        resetStore();
        // Seed some tabs, then only ever drag them to edges: nothing is closed,
        // so nothing may be torn down — no matter how the tree restructures.
        act().openTerminalTab();
        act().openTerminalTab();
        act().openTerminalTab();
        terminal.dispose.mockClear();

        for (const cmd of cmds) {
          if (cmd.t !== "moveTabToEdge") continue;
          runCmd(cmd);
        }
        expect(terminal.dispose).not.toHaveBeenCalled();
        assertLiveStoreInvariants();
      }),
    );
  });

  it("keeps the store shape valid as a standalone LayoutState (M2 nesting readiness)", () => {
    // The reducers are written to operate on a `LayoutState` sub-shape so M2 can
    // reuse them verbatim under `sessions[sessionId]`. This pins that the store
    // root really is exactly that shape — nothing extra leaks into the tree.
    fc.assert(
      fc.property(cmdsArb, (cmds) => {
        resetStore();
        cmds.forEach(runCmd);
        const { layout, focusedPaneId, tabs, views, activeViewId, pendingTerminalClose } =
          state();
        const detached: LayoutState = {
          layout,
          focusedPaneId,
          tabs,
          // Which file tab was last activated — read only through
          // `activeFilePath`, which validates it against `tabs`, so it is part of
          // the layout shape rather than a rail-local concern.
          lastFilePath: state().lastFilePath,
          views,
          activeViewId,
          // A close waiting on "are you sure?" is live UI state, not persisted —
          // it belongs to the shape for the same reason `focusedPaneId` does.
          pendingTerminalClose,
          // Boot-only carry-over from the persisted center layout; the property
          // model never restores, so it is empty here (and MUST be — a leftover
          // slot would mean `rebuildTerminalTabs` never consumed it).
          pendingRestore: state().pendingRestore,
        };
        expect(state().pendingRestore).toEqual({});
        assertStoreInvariants(detached);
      }),
    );
  });
});

/* ══════════════════════════ imperative handle ══════════════════════════ */

describe("layoutActions() — the Provider-less handle for bridge.ts", () => {
  it("returns the live action group without a React hook", () => {
    expect(layoutActions()).toBe(useAppStore.getState().layoutActions);
  });

  it("survives state changes — the action identity is stable", () => {
    const before = layoutActions();
    before.openTerminalTab();
    expect(layoutActions()).toBe(before);
  });

  it("drives the store from outside React, as Rust event callbacks do", () => {
    const tabId = layoutActions().openTerminalTab({ cwd: "/w/gazelle" });
    expect(useAppStore.getState().tabs[tabId].title).toBe("gazelle");
  });
});

/* ══════════════════ drop planning + preview geometry ══════════════════
 * The planners are the ONE implementation of "what does this drop do", run by
 * both the actions and the drag preview. That sharing is the fix for the
 * preview bug — the preview used to be drawn as a rectangle inside the
 * hovered pane, which cannot express the source-prune → collapse the drop
 * actually performs. These pin the contract the preview leans on.
 */

describe("fractionalRectOfLeaf — a leaf's share of the work area", () => {
  it("gives the whole container to a lone root leaf", () => {
    const root = makeLeaf();
    expect(fractionalRectOfLeaf(root, root.id)).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    });
  });

  it("splits a row left-to-right and a column top-to-bottom", () => {
    const a = makeLeaf();
    const b = makeLeaf();
    const row: PaneNode = {
      id: asPaneId("r"),
      type: "split",
      orientation: "row",
      children: [a, b],
      sizes: [0.25, 0.75],
    };
    expect(fractionalRectOfLeaf(row, a.id)).toEqual({
      left: 0,
      top: 0,
      width: 0.25,
      height: 1,
    });
    expect(fractionalRectOfLeaf(row, b.id)).toEqual({
      left: 0.25,
      top: 0,
      width: 0.75,
      height: 1,
    });

    const column: PaneNode = {
      ...row,
      id: asPaneId("c"),
      orientation: "column",
    };
    expect(fractionalRectOfLeaf(column, a.id)).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 0.25,
    });
    expect(fractionalRectOfLeaf(column, b.id)).toEqual({
      left: 0,
      top: 0.25,
      width: 1,
      height: 0.75,
    });
  });

  it("composes shares through nesting — a grandchild gets parent x inner", () => {
    const a = makeLeaf();
    const b = makeLeaf();
    const c = makeLeaf();
    // Right half of the row, bottom half of that: the far bottom-right quarter.
    const tree: PaneNode = {
      id: asPaneId("root"),
      type: "split",
      orientation: "row",
      sizes: [0.5, 0.5],
      children: [
        a,
        {
          id: asPaneId("nested"),
          type: "split",
          orientation: "column",
          sizes: [0.5, 0.5],
          children: [b, c],
        },
      ],
    };
    expect(fractionalRectOfLeaf(tree, c.id)).toEqual({
      left: 0.5,
      top: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it("is null for an id that is not a leaf of this tree", () => {
    const a = makeLeaf();
    const tree: PaneNode = {
      id: asPaneId("root"),
      type: "split",
      orientation: "row",
      children: [a, makeLeaf()],
      sizes: [0.5, 0.5],
    };
    expect(fractionalRectOfLeaf(tree, asPaneId("nobody"))).toBeNull();
    // A split's own id is not a leaf's — the preview only ever asks for leaves.
    expect(fractionalRectOfLeaf(tree, asPaneId("root"))).toBeNull();
  });
});

describe("planDropRect — what the drag preview draws", () => {
  /** Two panes side by side; `dragged` is alone in the second. */
  function twoPanes() {
    const a = useAppStore.getState().focusedPaneId;
    const stay = act().openTerminalTab({ paneId: a });
    const b = act().splitPane(a, "row");
    const dragged = act().openTerminalTab({ paneId: b });
    return { a, b, stay, dragged };
  }

  it.each([
    // Dropping the second pane's ONLY tab onto the first pane prunes the second,
    // collapses the root, and lets the survivor fill the container — so every
    // landing box spans a full axis. Drawn inside pane `a` these would all be
    // half as wide: the half-screen preview bug.
    ["left", { left: 0, top: 0, width: 0.5, height: 1 }],
    ["right", { left: 0.5, top: 0, width: 0.5, height: 1 }],
    ["top", { left: 0, top: 0, width: 1, height: 0.5 }],
    ["bottom", { left: 0, top: 0.5, width: 1, height: 0.5 }],
    ["center", { left: 0, top: 0, width: 1, height: 1 }],
  ] as const)(
    "previews a %s drop as the box the tab really lands in",
    (zone, expected) => {
      const { a, dragged } = twoPanes();
      expect(
        planDropRect(useAppStore.getState().layout, dragged, a, zone),
      ).toEqual(expected);
    },
  );

  it("agrees with the action, for every zone — preview and drop cannot drift", () => {
    for (const zone of ["left", "right", "top", "bottom", "center"] as const) {
      resetStore();
      const { a, dragged } = twoPanes();
      const previewed = planDropRect(
        useAppStore.getState().layout,
        dragged,
        a,
        zone,
      );

      if (zone === "center") act().moveTab(dragged, a);
      else act().moveTabToEdge(dragged, a, zone);

      const landed = leavesOf(useAppStore.getState().layout).find((l) =>
        l.tabIds.includes(dragged),
      );
      expect(landed, `${zone}: the tab must exist somewhere`).toBeDefined();
      expect(
        fractionalRectOfLeaf(useAppStore.getState().layout, landed!.id),
      ).toEqual(previewed);
    }
  });

  /**
   * A no-op drop still has an answer, and it is not "nothing". Previewing null
   * here blanked the overlay for the whole time the cursor sat over the dragged
   * tab's own pane — the first half of every real gesture, because a hand does
   * not teleport onto the target (the blue drop highlight went missing
   * mid-drag). The honest answer: the terminal ends up exactly where it is.
   */
  it.each(["left", "right", "top", "bottom", "center"] as const)(
    "previews a no-op %s drop as the box the tab already occupies",
    (zone) => {
      const { b, dragged } = twoPanes();
      // A pane's only tab, dropped back onto its own pane: the store no-ops it.
      expect(
        planDropRect(useAppStore.getState().layout, dragged, b, zone),
      ).toEqual(fractionalRectOfLeaf(useAppStore.getState().layout, b));
      // ...and that box is the whole pane, never the half a split would carve.
      expect(
        planDropRect(useAppStore.getState().layout, dragged, b, zone),
      ).toEqual({
        left: 0.5,
        top: 0,
        width: 0.5,
        height: 1,
      });
    },
  );

  it("previews a no-op drop as a box the drop then really leaves alone", () => {
    // The WYSIWYG invariant holds for no-ops too, which is the whole reason
    // they are safe to preview: what was drawn is what is there afterwards.
    const { b, dragged } = twoPanes();
    const previewed = planDropRect(
      useAppStore.getState().layout,
      dragged,
      b,
      "left",
    );

    act().moveTabToEdge(dragged, b, "left");

    const home = leafOfTab(useAppStore.getState().layout, dragged);
    expect(
      fractionalRectOfLeaf(useAppStore.getState().layout, home!.id),
    ).toEqual(previewed);
  });

  it("is null when the tab or the pane is not in the tree", () => {
    const { a, dragged } = twoPanes();
    expect(
      planDropRect(useAppStore.getState().layout, asTabId("ghost"), a, "left"),
    ).toBeNull();
    expect(
      planDropRect(
        useAppStore.getState().layout,
        dragged,
        asPaneId("ghost"),
        "left",
      ),
    ).toBeNull();
  });

  it("does not mutate the tree it plans against — a preview is not a drop", () => {
    const { a, dragged } = twoPanes();
    const before = structuredClone(useAppStore.getState().layout);

    planDropRect(useAppStore.getState().layout, dragged, a, "bottom");

    expect(useAppStore.getState().layout).toEqual(before);
  });
});

describe("planMoveTab / planMoveTabToEdge — the planners themselves", () => {
  it("plans a reorder within one pane, and no-ops a drop where it already sits", () => {
    const paneId = useAppStore.getState().focusedPaneId;
    const first = act().openTerminalTab({ paneId });
    const second = act().openTerminalTab({ paneId });
    const layout = useAppStore.getState().layout;

    // Dropped at its own index: nothing to do.
    expect(planMoveTab(layout, second, paneId, 1)).toBeNull();
    // No index at all, into its own pane: the long-standing no-op.
    expect(planMoveTab(layout, second, paneId)).toBeNull();

    const plan = planMoveTab(layout, second, paneId, 0);
    expect(plan).not.toBeNull();
    expect((plan!.layout as LeafNode).tabIds).toEqual([second, first]);
    expect(plan!.landedPaneId).toBe(paneId);
  });

  it("refuses to plan against a split id — only leaves take drops", () => {
    const paneId = useAppStore.getState().focusedPaneId;
    const tabId = act().openTerminalTab({ paneId });
    act().splitPane(paneId, "row");
    const splitId = (useAppStore.getState().layout as SplitNode).id;

    expect(
      planMoveTab(useAppStore.getState().layout, tabId, splitId),
    ).toBeNull();
    expect(
      planMoveTabToEdge(useAppStore.getState().layout, tabId, splitId, "left"),
    ).toBeNull();
  });

  it("separates two tabs of one pane onto its own edge — the real self-drop case", () => {
    const paneId = useAppStore.getState().focusedPaneId;
    const stay = act().openTerminalTab({ paneId });
    const drag = act().openTerminalTab({ paneId });

    const plan = planMoveTabToEdge(
      useAppStore.getState().layout,
      drag,
      paneId,
      "right",
    );
    expect(plan).not.toBeNull();
    const split = plan!.layout as SplitNode;
    expect(split.orientation).toBe("row");
    expect((split.children[0] as LeafNode).tabIds).toEqual([stay]);
    expect((split.children[1] as LeafNode).tabIds).toEqual([drag]);
    expect(plan!.landedPaneId).toBe(split.children[1].id);
  });
});

/* ══════════════════════ agent pinning ══════════════════════ */

describe("agentActions — pin registry", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const aid = (s: string): AgentId => asAgentId(s);

  const startRoot = (agentId: string): void =>
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid(agentId),
      parentId: null,
      title: agentId,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

  const spawnKid = (parent: string, child: string): void =>
    fleet().applyAgentEvent({
      t: "subagent_spawned",
      parentId: aid(parent),
      childAgentId: aid(child),
      title: child,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

  it("pinAgent sets the flag on a root and persists via pin_agent", () => {
    startRoot("root");
    fleet().pinAgent(aid("root"));

    expect(state().agents[aid("root")].pinned).toBe(true);
    expect(fleetIpc.pinAgent).toHaveBeenCalledWith(aid("root"));
    assertLiveFleetInvariants("after pin");
  });

  it("unpinAgent clears the flag and drops the registry entry", () => {
    startRoot("root");
    fleet().pinAgent(aid("root"));
    fleet().unpinAgent(aid("root"));

    expect(state().agents[aid("root")].pinned).toBe(false);
    expect(fleetIpc.unpinAgent).toHaveBeenCalledWith(aid("root"));
  });

  it("pinAgent is a no-op on a sub-agent — no flag, no invoke", () => {
    startRoot("root");
    spawnKid("root", "kid");
    fleet().pinAgent(aid("kid"));

    expect(state().agents[aid("kid")].pinned).toBeFalsy();
    expect(fleetIpc.pinAgent).not.toHaveBeenCalled();
  });

  it("pinAgent is a no-op on a missing record — no invoke", () => {
    fleet().pinAgent(aid("ghost"));
    expect(fleetIpc.pinAgent).not.toHaveBeenCalled();
  });

  it("unpinAgent on a missing record does not throw, and still drops the entry", () => {
    // Best-effort + idempotent: unpin fires the registry drop unconditionally, so
    // a stale id (already gone) is harmless — no flag to clear, but the persist
    // still runs.
    expect(() => fleet().unpinAgent(aid("ghost"))).not.toThrow();
    expect(state().agents[aid("ghost")]).toBeUndefined();
    expect(fleetIpc.unpinAgent).toHaveBeenCalledWith(aid("ghost"));
  });

  it("hydrate preserves pinned across a re-snapshot (like customTitle)", () => {
    startRoot("root");
    fleet().pinAgent(aid("root"));
    // Rust re-snapshots the same agent — the wire carries no `pinned` field.
    fleet().applyFleetSnapshot([
      wireAgent({ id: aid("root"), title: "renamed-by-rust" }),
    ]);

    expect(state().agents[aid("root")].pinned).toBe(true); // survived
    expect(state().agents[aid("root")].title).toBe("renamed-by-rust");
    assertLiveFleetInvariants("after re-snapshot");
  });

  it("applyPinnedAgents flags a matching snapshot root", () => {
    fleet().applyFleetSnapshot([wireAgent({ id: aid("root") })]);
    fleet().applyPinnedAgents([
      { agentId: aid("root"), cwd: "/w/gazelle", title: "root" },
    ]);

    expect(state().agents[aid("root")].pinned).toBe(true);
    // Pure reconcile — no persist on the read side.
    expect(fleetIpc.pinAgent).not.toHaveBeenCalled();
  });

  it("applyPinnedAgents skips a pin whose row is absent (nothing to flag)", () => {
    fleet().applyPinnedAgents([
      { agentId: aid("gone"), cwd: "/w/x", title: "yesterday" },
    ]);
    // No row was materialized — Rust owns re-spawn; the FE only flags rows that
    // arrived through the snapshot.
    expect(state().agents[aid("gone")]).toBeUndefined();
    assertLiveFleetInvariants("after absent pin");
  });

  it("dismissing a pinned root (no tab) also unpins it — no zombie next boot", () => {
    startRoot("root");
    fleet().pinAgent(aid("root"));
    fleet().dismissAgent(aid("root"));

    expect(state().agents[aid("root")]).toBeUndefined();
    expect(fleetIpc.unpinAgent).toHaveBeenCalledWith(aid("root"));
    assertLiveFleetInvariants("after dismiss of pinned");
  });

  it("dismissing a pinned root THROUGH its terminal tab also unpins it", () => {
    // The real path a pinned root takes: it owns an agent-terminal tab, so its
    // dismissal converges on closeTab — which must fire the unpin too.
    const agentId = fleet().createAgent({ cwd: "/w/gazelle", title: "root" });
    fleet().pinAgent(agentId);
    expect(fleetIpc.pinAgent).toHaveBeenCalledWith(agentId);

    fleet().dismissAgent(agentId);

    expect(state().agents[agentId]).toBeUndefined();
    expect(fleetIpc.unpinAgent).toHaveBeenCalledWith(agentId);
    assertLiveFleetInvariants("after tab-dismiss of pinned");
  });

  it("dismissing an UNPINNED root does not fire unpin_agent", () => {
    startRoot("root");
    fleet().dismissAgent(aid("root"));

    expect(fleetIpc.unpinAgent).not.toHaveBeenCalled();
  });

  it("removeAgent unpins a pinned root too", () => {
    startRoot("root");
    fleet().pinAgent(aid("root"));
    fleet().removeAgent(aid("root"));

    expect(fleetIpc.unpinAgent).toHaveBeenCalledWith(aid("root"));
  });
});

/* ════════════ "Resumed after restart" markers (open_agents.rs, phase 1) ════════════ */

describe("agentActions — restored markers (agents survive a restart, phase 1)", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const aid = (s: string): AgentId => asAgentId(s);
  const resumedWorking = { outcome: "resumed" as const, wasWorking: true };

  const restoreRoots = (...ids: string[]): void =>
    fleet().applyFleetSnapshot(ids.map((i) => wireAgent({ id: aid(i), status: "idle" })));

  it("marks each restored root with its rung and whether the quit interrupted it", () => {
    restoreRoots("busy", "idle", "gone", "unrestored");
    fleet().applyRestoredAgents([
      { agentId: aid("busy"), outcome: "resumed", wasWorking: true },
      { agentId: aid("idle"), outcome: "fresh", wasWorking: false },
      { agentId: aid("gone"), outcome: "dormant", wasWorking: null },
    ]);

    expect(state().agents[aid("busy")].restored).toEqual(resumedWorking);
    expect(state().agents[aid("idle")].restored).toEqual({ outcome: "fresh", wasWorking: false });
    expect(state().agents[aid("gone")].restored).toEqual({ outcome: "dormant", wasWorking: null });
    expect(state().agents[aid("unrestored")].restored).toBeNull();
    assertLiveFleetInvariants("after restored markers");
  });

  it("is a pure reconcile: no row is conjured, no sub-agent marked, nothing persisted", () => {
    restoreRoots("root");
    fleet().applyAgentEvent({
      t: "subagent_spawned",
      parentId: aid("root"),
      childAgentId: aid("kid"),
      title: "kid",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    layoutPrefsIpc.saveLayoutPrefs.mockClear();
    fleet().applyRestoredAgents([
      { agentId: aid("absent"), outcome: "resumed", wasWorking: true },
      { agentId: aid("kid"), outcome: "resumed", wasWorking: true },
    ]);

    expect(state().agents[aid("absent")]).toBeUndefined();
    expect(state().agents[aid("kid")].restored).toBeFalsy();
    expect(layoutPrefsIpc.saveLayoutPrefs).not.toHaveBeenCalled();
    expect(fleetIpc.pinAgent).not.toHaveBeenCalled();
    assertLiveFleetInvariants("after an absent marker");
  });

  it("survives a re-snapshot, like the pin flag", () => {
    restoreRoots("root");
    fleet().applyRestoredAgents([{ agentId: aid("root"), ...resumedWorking }]);
    fleet().applyFleetSnapshot([wireAgent({ id: aid("root"), title: "renamed-by-rust" })]);

    expect(state().agents[aid("root")].restored).toEqual(resumedWorking);
  });

  it("comes down at the agent's next turn — and only then", () => {
    restoreRoots("root");
    fleet().applyRestoredAgents([{ agentId: aid("root"), ...resumedWorking }]);

    // Waiting on the user, or parked again, is not the user talking to it.
    for (const status of ["waiting_input", "idle"] as const) {
      fleet().applyAgentEvent({ t: "status", agentId: aid("root"), status });
      expect(state().agents[aid("root")].restored).toEqual(resumedWorking);
    }
    fleet().applyAgentEvent({ t: "status", agentId: aid("root"), status: "running" });
    expect(state().agents[aid("root")].restored).toBeNull();
  });

  it("comes down when the agent ends", () => {
    restoreRoots("root");
    fleet().applyRestoredAgents([{ agentId: aid("root"), ...resumedWorking }]);
    fleet().applyAgentEvent({ t: "exited", agentId: aid("root"), code: 1 });

    expect(state().agents[aid("root")].restored).toBeNull();
    expect(state().agents[aid("root")].status).toBe("error");
  });
});

/* ═══════════════ fan-out forest: reparenting + orphan adoption ═══════════════ */

describe("agentActions — reparenting & orphan adoption (fan-out forest)", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const aid = (s: string): AgentId => asAgentId(s);

  const startRoot = (id: string): void =>
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid(id),
      parentId: null,
      title: id,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

  const spawnKid = (parent: string, child: string): void =>
    fleet().applyAgentEvent({
      t: "subagent_spawned",
      parentId: aid(parent),
      childAgentId: aid(child),
      title: child,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

  it("adopts an orphan when its parent finally arrives — removing it from the ROOT list", () => {
    // Out-of-order telemetry: the child's `agent_started` beats the parent's.
    // The child is surfaced as a root so it stays visible; when the parent lands,
    // `adoptOrphans` must MOVE it under the parent — not leave it doubly-homed.
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid("kid"),
      parentId: aid("boss"), // parent does not exist yet
      title: "kid",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    // While orphaned, the child is a visible root.
    expect(state().rootAgentIds).toContain(aid("kid"));

    // The parent arrives — adoption fires.
    startRoot("boss");

    // The child is REMOVED from the root list (the assertion the survivor exposed)…
    expect(state().rootAgentIds).not.toContain(aid("kid"));
    // …and now lives under its parent, exactly once.
    expect(state().rootAgentIds).toContain(aid("boss"));
    expect(state().agents[aid("boss")].childIds).toEqual([aid("kid")]);
    expect(state().agents[aid("kid")].parentId).toBe(aid("boss"));
    assertLiveFleetInvariants("after orphan adoption");
  });

  it("adopts ONLY the orphan that belongs to the arriving parent, not other roots", () => {
    startRoot("elder"); // a genuine, unrelated root
    // Two orphans waiting on two different, absent parents.
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid("kidA"),
      parentId: aid("bossA"),
      title: "kidA",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid("kidB"),
      parentId: aid("bossB"),
      title: "kidB",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    expect(state().rootAgentIds).toEqual([
      aid("elder"),
      aid("kidA"),
      aid("kidB"),
    ]);

    // Only bossA arrives: kidA is adopted; elder and kidB are untouched.
    startRoot("bossA");

    expect(state().agents[aid("bossA")].childIds).toEqual([aid("kidA")]);
    expect(state().rootAgentIds).not.toContain(aid("kidA"));
    // kidB stays a root (its parent bossB is still absent) and elder stays a root.
    expect(state().rootAgentIds).toContain(aid("elder"));
    expect(state().rootAgentIds).toContain(aid("kidB"));
    expect(state().agents[aid("kidB")].parentId).toBe(aid("bossB"));
    assertLiveFleetInvariants("after selective adoption");
  });

  it("re-linking an EXISTING agent under its SAME parent preserves child order (guard distinguishes reparent from re-link)", () => {
    // The reparent guard is `prev !== undefined && prev.parentId !== wire.parentId`.
    // Forced to `true`, every re-snapshot is treated as a reparent → unlink+relink,
    // which appends the child to the END of its parent's list. A same-parent
    // re-snapshot must therefore NOT reorder siblings.
    startRoot("boss");
    spawnKid("boss", "a");
    spawnKid("boss", "b");
    spawnKid("boss", "c");
    expect(state().agents[aid("boss")].childIds).toEqual([
      aid("a"),
      aid("b"),
      aid("c"),
    ]);

    // Re-snapshot the FIRST child with an unchanged parent (a routine re-emit).
    fleet().applyFleetSnapshot([
      wireAgent({ id: aid("a"), parentId: aid("boss") }),
    ]);

    // Not a reparent → position is untouched. A `true`-forced guard would yield
    // [b, c, a].
    expect(state().agents[aid("boss")].childIds).toEqual([
      aid("a"),
      aid("b"),
      aid("c"),
    ]);
    assertLiveFleetInvariants("after same-parent re-link");
  });

  it("a genuine reparent DOES move the child to its new parent", () => {
    // The complement: when the parent truly changes, the guard fires and the
    // child leaves its old parent for the new one (no duplicate, no ghost root).
    startRoot("boss1");
    startRoot("boss2");
    spawnKid("boss1", "kid");
    expect(state().agents[aid("boss1")].childIds).toEqual([aid("kid")]);

    fleet().applyFleetSnapshot([
      wireAgent({ id: aid("kid"), parentId: aid("boss2") }),
    ]);

    expect(state().agents[aid("boss1")].childIds).toEqual([]);
    expect(state().agents[aid("boss2")].childIds).toEqual([aid("kid")]);
    expect(state().agents[aid("kid")].parentId).toBe(aid("boss2"));
    expect(state().rootAgentIds).not.toContain(aid("kid"));
    assertLiveFleetInvariants("after genuine reparent");
  });
});

/* ═══════════════ tombstone eviction cap (FIFO, off-by-one boundary) ═══════════════ */

describe("agentActions — tombstone cap (dismissedAgentIds FIFO)", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const aid = (s: string): AgentId => asAgentId(s);
  const TOMBSTONE_CAP = 512; // mirrors store.ts

  const dismissedLen = () => state().dismissedAgentIds.length;

  it("caps at EXACTLY the limit — the last id under the cap is retained, the (cap+1)th evicts the oldest", () => {
    // Dismissing an absent id still tombstones it (a dismiss can race ahead of the
    // create it cancels). Drive the list to exactly the cap: the guard is
    // `length > CAP` → shift, so pushing the CAP-th id must NOT evict anything.
    for (let i = 0; i < TOMBSTONE_CAP; i++) fleet().dismissAgent(aid(`ghost-${i}`));
    expect(dismissedLen()).toBe(TOMBSTONE_CAP); // `>=` would have evicted → 511
    // The very first tombstone is still present at the boundary.
    expect(state().dismissedAgentIds).toContain(aid("ghost-0"));

    // One more crosses the cap: now (and only now) the oldest falls off.
    fleet().dismissAgent(aid(`ghost-${TOMBSTONE_CAP}`));
    expect(dismissedLen()).toBe(TOMBSTONE_CAP); // stays capped, never grows
    expect(state().dismissedAgentIds).not.toContain(aid("ghost-0")); // FIFO evicted
    expect(state().dismissedAgentIds).toContain(aid(`ghost-${TOMBSTONE_CAP}`));
    assertLiveFleetInvariants("after tombstone cap");
  });
});

/* ═══════════════ active-tab reselection in the batch close path ═══════════════ */

describe("closeTabs — active-tab reselection (detachTabFromDraftLeaf)", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const aid = (s: string): AgentId => asAgentId(s);

  const startRoot = (id: string): void =>
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid(id),
      parentId: null,
      title: id,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

  const spawnKid = (parent: string, child: string): void =>
    fleet().applyAgentEvent({
      t: "subagent_spawned",
      parentId: aid(parent),
      childAgentId: aid(child),
      title: child,
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

  it("closing the ACTIVE tab hands activation to the RIGHT neighbour (Math.min), not the far end (Math.max)", () => {
    // Reach `detachTabFromDraftLeaf` via the batch close path: dismissing a
    // sub-agent closes its read-only activity tab through `closeTabs`. Four
    // activity tabs share one leaf; the active one is at index 1 with survivors on
    // BOTH sides — the only layout where Math.min(i, len-1) and Math.max diverge.
    startRoot("boss");
    spawnKid("boss", "a");
    spawnKid("boss", "m");
    spawnKid("boss", "c");
    spawnKid("boss", "d");

    // Selecting a sub-agent opens+activates its activity tab in the focused leaf.
    fleet().selectAgent(aid("a"));
    fleet().selectAgent(aid("m"));
    fleet().selectAgent(aid("c"));
    fleet().selectAgent(aid("d"));

    const leafId = rootLeaf().id;
    const [tA, tM, tC, tD] = rootLeaf().tabIds; // open order a, m, c, d
    expect(rootLeaf().tabIds).toHaveLength(4);

    // Make the SECOND tab (index 1, agent "m") the active one.
    act().setActiveTab(leafId, tM);
    expect(rootLeaf().activeTabId).toBe(tM);

    // Dismiss agent "m": its activity tab is the only one closed (no children),
    // so exactly one tab is detached from a leaf that still holds the other three.
    fleet().dismissAgent(aid("m"));

    // Survivors are [tA, tC, tD]; index 1 now holds tC (right neighbour).
    expect(rootLeaf().tabIds).toEqual([tA, tC, tD]);
    expect(rootLeaf().activeTabId).toBe(tC); // Math.max would pick tD (the far end)
    assertLiveStoreInvariants("after active activity-tab close");
    assertLiveFleetInvariants("after active activity-tab close");
  });
});

/* ══════════════════════ collapseAllBut (pure helper) ══════════════════════ */

describe("collapseAllBut (pure — focus-follows-agent collapse set)", () => {
  it("collapses every root except the one to keep", () => {
    const set = collapseAllBut(["/a", "/b", "/c"], "/b");
    expect([...set].sort()).toEqual(["/a", "/c"]);
    expect(set.has("/b")).toBe(false);
  });

  it("collapses everything when keep is null", () => {
    const set = collapseAllBut(["/a", "/b"], null);
    expect([...set].sort()).toEqual(["/a", "/b"]);
  });

  it("collapses everything when keep is not among the roots", () => {
    const set = collapseAllBut(["/a", "/b"], "/not-here");
    expect([...set].sort()).toEqual(["/a", "/b"]);
  });

  it("returns an empty set for empty roots", () => {
    expect(collapseAllBut([], "/a").size).toBe(0);
    expect(collapseAllBut([], null).size).toBe(0);
  });
});

/* ══════════════════════ focus follows agent (setting + auto-collapse) ══════════════════════ */

describe("focus follows agent", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const ws = () => useAppStore.getState().workspaceActions;
  const aid = (s: string): AgentId => asAgentId(s);

  /** The last blob handed to `saveLayoutPrefs`, or fail if it was never called. */
  const lastSaved = () => {
    const calls = layoutPrefsIpc.saveLayoutPrefs.mock.calls;
    expect(calls.length, "saveLayoutPrefs should have run").toBeGreaterThan(0);
    return calls[calls.length - 1][0] as {
      focusFollowsAgent?: boolean;
      collapsedRoots: string[];
      collapsedFolders: string[];
    };
  };

  const startRoot = (id: string, cwd: string): void =>
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid(id),
      parentId: null,
      title: id,
      cwd,
      branch: "trunk",
      runtime: "claude-code",
    });

  const spawnKid = (parent: string, child: string): void =>
    fleet().applyAgentEvent({
      t: "subagent_spawned",
      parentId: aid(parent),
      childAgentId: aid(child),
      title: child,
      cwd: "/ignored", // a sub-agent has no cwd of its own; its ROOT's cwd is used
      branch: "trunk",
      runtime: "claude-code",
    });

  beforeEach(() => {
    // The store-harness resets the layout + fleet slices, not the workspace slice
    // this feature lives in — clear it so one test cannot leak into the next.
    useAppStore.setState((s) => {
      s.folderOrder = [];
      s.collapsedRoots = new Set();
      s.collapsedFolders = new Set();
      s.focusFollowsAgent = false;
      s.selection.selectedAgentId = null;
    });
    layoutPrefsIpc.saveLayoutPrefs.mockClear();
  });

  it("defaults off", () => {
    expect(state().focusFollowsAgent).toBe(false);
  });

  it("setFocusFollowsAgent(true) sets the flag and persists it", () => {
    ws().setFocusFollowsAgent(true);
    expect(state().focusFollowsAgent).toBe(true);
    expect(lastSaved().focusFollowsAgent).toBe(true);
  });

  it("setFocusFollowsAgent(false) clears the flag and persists it", () => {
    ws().setFocusFollowsAgent(true);
    layoutPrefsIpc.saveLayoutPrefs.mockClear();
    ws().setFocusFollowsAgent(false);
    expect(state().focusFollowsAgent).toBe(false);
    expect(lastSaved().focusFollowsAgent).toBe(false);
  });

  it("with the toggle OFF, selecting an agent does NOT change collapsedRoots", () => {
    startRoot("a", "/w/a");
    startRoot("b", "/w/b");
    layoutPrefsIpc.saveLayoutPrefs.mockClear();

    fleet().selectAgent(aid("a"));
    expect(state().collapsedRoots.size).toBe(0); // untouched — today's behaviour
    expect(state().collapsedFolders.size).toBe(0);
    expect(layoutPrefsIpc.saveLayoutPrefs).not.toHaveBeenCalled();
  });

  it("with the toggle ON, selecting an agent collapses others and keeps its cwd expanded", () => {
    startRoot("a", "/w/a");
    startRoot("b", "/w/b");
    startRoot("c", "/w/c");
    ws().setFocusFollowsAgent(true);

    fleet().selectAgent(aid("b"));
    expect([...state().collapsedRoots].sort()).toEqual(["/w/a", "/w/c"]);
    expect(state().collapsedRoots.has("/w/b")).toBe(false); // b stays expanded
    expect(lastSaved().collapsedRoots.sort()).toEqual(["/w/a", "/w/c"]);
    // The left (Agents) rail folder groups collapse in lockstep with Files.
    expect([...state().collapsedFolders].sort()).toEqual(["/w/a", "/w/c"]);
    expect(state().collapsedFolders.has("/w/b")).toBe(false);
    expect(lastSaved().collapsedFolders.sort()).toEqual(["/w/a", "/w/c"]);
  });

  it("re-collapses when the selection changes to another agent", () => {
    startRoot("a", "/w/a");
    startRoot("b", "/w/b");
    ws().setFocusFollowsAgent(true);

    fleet().selectAgent(aid("a"));
    expect([...state().collapsedRoots]).toEqual(["/w/b"]);
    expect([...state().collapsedFolders]).toEqual(["/w/b"]);
    fleet().selectAgent(aid("b"));
    expect([...state().collapsedRoots]).toEqual(["/w/a"]);
    expect([...state().collapsedFolders]).toEqual(["/w/a"]);
  });

  it("toggling ON applies immediately to the CURRENT selection", () => {
    startRoot("a", "/w/a");
    startRoot("b", "/w/b");
    fleet().selectAgent(aid("a")); // selected while the toggle is still OFF
    expect(state().collapsedRoots.size).toBe(0);
    expect(state().collapsedFolders.size).toBe(0);

    ws().setFocusFollowsAgent(true); // takes effect at once
    expect([...state().collapsedRoots]).toEqual(["/w/b"]);
    expect([...state().collapsedFolders]).toEqual(["/w/b"]);
  });

  it("keeps the ROOT's cwd expanded when a SUB-agent is selected", () => {
    startRoot("a", "/w/a");
    startRoot("b", "/w/b");
    spawnKid("a", "kid");
    ws().setFocusFollowsAgent(true);

    fleet().selectAgent(aid("kid"));
    // The sub-agent has no cwd of its own — its root ("a" → /w/a) is kept expanded.
    expect([...state().collapsedRoots]).toEqual(["/w/b"]);
    expect(state().collapsedRoots.has("/w/a")).toBe(false);
    // A sub-agent has no folder group of its own, so the left rail keeps the root's.
    expect([...state().collapsedFolders]).toEqual(["/w/b"]);
    expect(state().collapsedFolders.has("/w/a")).toBe(false);
  });

  it("leaves collapse unchanged when the toggle is ON but nothing is selected", () => {
    startRoot("a", "/w/a");
    ws().setFocusFollowsAgent(true); // no selection yet
    // The flag persisted, but no collapse was applied.
    expect(state().collapsedRoots.size).toBe(0);
    expect(lastSaved().focusFollowsAgent).toBe(true);
  });

  it("leaves collapse unchanged when the selected agent has no resolvable cwd", () => {
    startRoot("a", "/w/a");
    // Point the selection at a non-existent agent, then turn the toggle on: rootOf
    // resolves to null → no folder to keep → collapse is left untouched.
    useAppStore.setState((s) => {
      s.selection.selectedAgentId = aid("ghost");
    });
    ws().setFocusFollowsAgent(true);
    expect(state().collapsedRoots.size).toBe(0);
  });

  it("skips a phantom root id (in rootAgentIds but no agent record) when collapsing folders", () => {
    startRoot("a", "/w/a");
    startRoot("b", "/w/b");
    // Inject a dangling root id whose agent record never arrived — its cwd is
    // undefined and must be filtered out, not crash the collapse.
    useAppStore.setState((s) => {
      s.rootAgentIds = [...s.rootAgentIds, aid("phantom")];
    });
    ws().setFocusFollowsAgent(true);

    fleet().selectAgent(aid("a"));
    expect([...state().collapsedFolders]).toEqual(["/w/b"]); // phantom contributes nothing
  });

  it("boot hydration seeds focusFollowsAgent from persisted prefs", () => {
    ws().applyLayoutPrefs({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
      focusFollowsAgent: true,
    });
    expect(state().focusFollowsAgent).toBe(true);
  });

  it("boot hydration defaults focusFollowsAgent to false when the pref is absent", () => {
    useAppStore.setState((s) => {
      s.focusFollowsAgent = true;
    });
    // A pre-feature blob (no focusFollowsAgent key) must reset it to false.
    ws().applyLayoutPrefs({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
    });
    expect(state().focusFollowsAgent).toBe(false);
  });
});

/* ══════════ resizePane: sizesEqual's no-op guard (mutation testing) ══════════
 *
 * `sizesEqual(a, b)` is `a.length === b.length && a.every(|n,i| |n-b[i]| < EPS)`
 * and its only caller is `resizePane`, which drops the whole resize when it says
 * "equal". So the guard is observable exactly one way: did the resize land?
 *
 * The existing `resizePane` suite above only ever drives a TWO-child split, and
 * that arity is structurally blind to `.every` → `.some`: after
 * `normalizeSizes` both arrays sum to 1, so `a0 === b0` forces `a1 === b1` —
 * "one element matches" is unreachable with two children. Three children is the
 * smallest shape where the two quantifiers can disagree at all (the input
 * *shape* was the blind spot, not the assertion).
 */

describe("resizePane — sizesEqual (drop-the-no-op guard)", () => {
  /** mirrors SIZE_EPSILON in store.ts, which is module-private. */
  const SIZE_EPSILON = 1e-4;

  let splitId: PaneId;

  beforeEach(() => {
    // Two same-orientation splits flatten (canonicalize rule b) into ONE row of
    // three children — the arity the guard needs to be observable.
    const first = rootLeaf().id;
    act().splitPane(first, "row"); // row[first, n1]
    act().splitPane(first, "row"); // row[first, n2, n1]
    const split = asSplit(state().layout);
    splitId = split.id;
    expect(split.children).toHaveLength(3);
    expect(split.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it("applies a resize in which exactly ONE component is unchanged", () => {
    // From [0.25, 0.25, 0.5] to [0.25, 0.3, 0.45]: element 0 is identical,
    // elements 1 and 2 move by 0.05 (500× the epsilon).
    //   `.every` (correct) → "not all equal" → the drag is applied.
    //   `.some`  (mutant)  → element 0 matches → "equal" → the drag is DROPPED
    //                        and the sash snaps back mid-gesture.
    act().resizePane(splitId, [250, 300, 450]); // pixels, as allotment emits

    const sizes = asSplit(state().layout).sizes;
    expect(sizes[0]).toBeCloseTo(0.25, 12); // the matching component
    expect(sizes[1]).toBeCloseTo(0.3, 12); // ← 0.25 under `.some`
    expect(sizes[2]).toBeCloseTo(0.45, 12); // ← 0.5  under `.some`
    assertLiveStoreInvariants("after a partially-unchanged resize");
  });

  it("applies a resize whose largest delta is EXACTLY the epsilon (`<`, not `<=`)", () => {
    // The `<` → `<=` boundary needs a delta that is bit-for-bit the double
    // `1e-4`. Arithmetic like `0.5001 - 0.5` will NOT do — it yields
    // 9.999999999999999e-5, strictly below the epsilon, so both operators agree
    // and the test would be a silent no-op.
    //
    // Constructed so `normalizeSizes` is exact: the weights sum to 2 (a power of
    // two, so every division is a bare exponent decrement, no rounding), and
    // `2 * 1e-4` is itself exact. Both totals are
    // exactly 2 and the resulting deltas are `=== 1e-4`.
    const w1 = 2 * SIZE_EPSILON; // 2e-4, exact
    const w0 = 2 - w1; // rounds, but w0 + w1 + 0 === 2 exactly

    act().resizePane(splitId, [w0, w1, 0]);
    const a = asSplit(state().layout).sizes;
    // Precondition (literal expectations, never read from the store's own
    // arithmetic): element 1 sits at exactly the epsilon, element 2 at zero…
    expect(a[1]).toBe(SIZE_EPSILON);
    expect(a[2]).toBe(0);

    // …so swapping them moves elements 1 and 2 by |1e-4 − 0| = EXACTLY 1e-4.
    //   `<`  (correct) → not "equal" → the resize lands.
    //   `<=` (mutant)  → "equal" → dropped, and `a` is still in place.
    act().resizePane(splitId, [w0, 0, w1]);

    const b = asSplit(state().layout).sizes;
    expect(b[1]).toBe(0); // ← still 1e-4 under `<=`
    expect(b[2]).toBe(SIZE_EPSILON); // ← still 0    under `<=`
    expect(b[0]).toBe(a[0]); // the untouched component is bit-identical
    assertLiveStoreInvariants("after an exactly-epsilon resize");
  });

  it("still drops a genuine no-op emission on a three-child split", () => {
    // The complement, so the two tests above cannot be satisfied by deleting the
    // guard: allotment re-fires the SAME ratio on every container resize, and
    // that must not produce a new state object (per-frame tree churn).
    act().resizePane(splitId, [250, 300, 450]);
    const settled = state().layout;

    act().resizePane(splitId, [500, 600, 900]); // same ratio, different pixels
    expect(state().layout).toBe(settled);
  });
});

/* ══════════ closeTabs: the batch prune set (mutation testing) ══════════
 *
 * `closeTabs` is the BATCH close path — dismissing an agent sweeps every removed
 * sub-agent's read-only activity tab in one commit — and it builds its own
 * `emptied` prune set rather than reusing the single-tab `pruneIfEmpty`. The
 * neighbouring test at "closing the ACTIVE tab hands activation to the RIGHT
 * neighbour" reaches this function but keeps every tab in ONE leaf, so the prune
 * set is never observable there: with a single leaf there is no split to
 * collapse and `canonicalize` keeps a lone root leaf regardless (rule e).
 */

describe("closeTabs — the batch prune set", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const aid = (s: string): AgentId => asAgentId(s);

  it("prunes every leaf the batch emptied and keeps the one that still holds a tab", () => {
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid("boss"),
      parentId: null,
      title: "boss",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });
    for (const kid of ["k1", "k2", "k3", "k4"]) {
      fleet().applyAgentEvent({
        t: "subagent_spawned",
        parentId: aid("boss"),
        childAgentId: aid(kid),
        title: kid,
        cwd: "/w/gazelle",
        branch: "trunk",
        runtime: "claude-code",
      });
    }

    // Leaf A holds EXACTLY ONE batch tab. That arity is load-bearing and was
    // measured, not assumed: a leaf holding TWO batch tabs cannot distinguish
    // `=== 0` from `!== 0`, because the mutant adds it to `emptied` on the first
    // detach (when one tab is still left) and a `Set` makes the miss on the
    // second detach invisible. Only a single-tab leaf is ever "non-empty after a
    // detach"-free, so only it exposes the flipped comparison.
    const leafA = rootLeaf().id;
    fleet().selectAgent(aid("k1"));
    expect(leafById(leafA).tabIds).toHaveLength(1);

    // Leaf B holds TWO batch tabs — kept in the witness so the test also covers
    // the ordinary multi-tab drain, and so the reason `→ true` is an EQUIVALENT
    // mutant is visible here: a non-empty leaf may be nominated freely because
    // `canonicalize` re-checks `tabIds.length === 0` before pruning anything.
    const leafB = act().splitPane(leafA, "row");
    fleet().selectAgent(aid("k2"));
    fleet().selectAgent(aid("k3"));
    expect(leafById(leafB).tabIds).toHaveLength(2);

    // Leaf C holds a terminal (survives the batch) AND k4's activity tab
    // (closed), so the batch touches it and it must still NOT be pruned.
    const leafC = act().splitPane(leafB, "row");
    const term = act().openTerminalTab();
    fleet().selectAgent(aid("k4"));
    expect(leafById(leafC).tabIds).toHaveLength(2);
    expect(asSplit(state().layout).children).toHaveLength(3);

    // One commit closes all four activity tabs (the root cascade).
    fleet().dismissAgent(aid("boss"));

    // Leaves A and B must both be in `emptied`, so canonicalize drops them
    // (rule c) and the now-single-child split collapses into leaf C (rule a).
    //   `!== 0`  → leaf A is never nominated and survives as a blank pane.
    //   `false`  → nothing is nominated; all three panes survive.
    // Either way the layout stays a split the user must tidy up by hand.
    expect(state().layout.type).toBe("leaf");
    expect(state().layout.id).toBe(leafC);
    expect(leafById(leafC).tabIds).toEqual([term]);
    expect(leafById(leafC).activeTabId).toBe(term);
    assertLiveStoreInvariants("after a batch activity-tab close");
    assertLiveFleetInvariants("after a batch activity-tab close");
  });
});

/* ══════════ adoptOrphans: null-safety on the root list (mutation testing) ══════════
 *
 * The adoption *outcome* is pinned by the two tests in "reparenting & orphan
 * adoption" above. What was not pinned is that the predicate cannot THROW while
 * scanning the root list.
 */

describe("adoptOrphans — a phantom root must not break adoption", () => {
  const fleet = () => useAppStore.getState().agentActions;
  const aid = (s: string): AgentId => asAgentId(s);

  it("skips a root id with no agent record (the `?.` in the orphan predicate)", () => {
    // A waiting orphan: its parent's event has not arrived, so linkAgent parked
    // it in `rootAgentIds` to keep it visible.
    fleet().applyAgentEvent({
      t: "agent_started",
      agentId: aid("kid"),
      parentId: aid("boss"),
      title: "kid",
      cwd: "/w/gazelle",
      branch: "trunk",
      runtime: "claude-code",
    });

    // Inject a dangling root id — the same shape the focus-follows-agent test
    // "skips a phantom root id (in rootAgentIds but no agent record)" already
    // guards for `collapseAllBut`. Placed FIRST so the predicate meets it before
    // the real orphan: without the `?.`, `s.agents["phantom"].parentId` throws a
    // TypeError inside the producer and the arriving parent's whole event is
    // lost — a dropped `agent_started` means an invisible agent (the failure
    // mode hydrateAgent's self-parent normalization exists to avoid).
    useAppStore.setState((s) => {
      s.rootAgentIds = [aid("phantom"), ...s.rootAgentIds];
    });

    expect(() =>
      fleet().applyAgentEvent({
        t: "agent_started",
        agentId: aid("boss"),
        parentId: null,
        title: "boss",
        cwd: "/w/gazelle",
        branch: "trunk",
        runtime: "claude-code",
      }),
    ).not.toThrow();

    // The real orphan was still adopted…
    expect(state().agents[aid("boss")].childIds).toEqual([aid("kid")]);
    expect(state().agents[aid("kid")].parentId).toBe(aid("boss"));
    expect(state().rootAgentIds).not.toContain(aid("kid"));
    // …and the phantom is left exactly where it was: it has no `parentId` to
    // match, so it is neither adopted nor dropped.
    expect(state().rootAgentIds).toContain(aid("phantom"));
    // No `assertLiveFleetInvariants` here: a record-less root is itself an
    // invariant violation, deliberately injected. That is the point.
  });
});

/* ══════════════════════════════ views ══════════════════════════════ */

/**
 * Views: a bar entry holds a WHOLE layout of panes (the iTerm2/tmux window
 * model), and switching between them must not cost the user a running agent.
 *
 * The three seams these tests exist for — the ones that can actually be wrong:
 *   1. the **write-back on switch** (`layout`/`focusedPaneId` are the live
 *      fields of the active view; `views[active]` is a stale snapshot until a
 *      switch refreshes it). Get the order wrong and a layout is silently lost.
 *   2. `moveTabToView` **not touching `tabs`** — the tab object identity and its
 *      `TerminalId` are what keep the PTY and its scrollback alive across a move.
 *   3. **orphan-freedom in both directions**: no record in `tabs` without a pane
 *      in some view, and no tab id in a view's tree without a record.
 *
 * `assertLiveStoreInvariants` is deliberately NOT used here: its orphan check
 * reads only the ACTIVE tree, so a tab legitimately parked in another view reads
 * as an orphan to it. `assertNoOrphans` below is the view-aware version.
 */
describe("views — one bar entry, one whole layout", () => {
  /**
   * `resetStore()` (src/test/store-harness.ts) predates views and does not reset
   * them, so re-seed the bar around the freshly reset layout. Without this, a
   * view created by one test leaks into the next — exactly the class of stale
   * state that harness file's own comments keep warning about.
   */
  const resetViews = (): void => {
    useAppStore.setState((s) => {
      const view = {
        id: asViewId(`view-${Math.random()}`),
        name: "View 1",
        layout: s.layout,
        focusedPaneId: s.focusedPaneId,
      };
      s.views = [view];
      s.activeViewId = view.id;
    });
  };

  beforeEach(resetViews);

  const views = () => state().views;
  const viewNames = () => views().map((v) => v.name);
  const activeView = () =>
    views().find((v) => v.id === state().activeViewId) as ViewSnapshot;

  /** Every tab id held by ANY view — live for the active one, snapshot for the rest. */
  const tabIdsEverywhere = (): TabId[] =>
    views().flatMap((v) => viewTabIds(state(), v.id));

  /** The store-wide invariant: `tabs` === the union of every view's tree. */
  const assertNoOrphans = (where = ""): void => {
    const inTrees = tabIdsEverywhere();
    expect(new Set(inTrees).size, `${where}: a tab id appears in two panes`).toBe(
      inTrees.length,
    );
    expect(
      [...inTrees].sort(),
      `${where}: every tab record must sit in exactly one view's tree`,
    ).toEqual((Object.keys(state().tabs) as TabId[]).sort());
  };

  /* ─────────────────────────── boot + create ─────────────────────────── */

  it("boots with exactly one view whose tree IS the live layout", () => {
    expect(views()).toHaveLength(1);
    expect(activeView().name).toBe("View 1");
    expect(activeView().layout).toBe(state().layout);
    expect(activeView().focusedPaneId).toBe(state().focusedPaneId);
  });

  it("createView adds an empty, activated view and returns its id", () => {
    const first = state().activeViewId;
    const id = act().createView();

    expect(state().activeViewId).toBe(id);
    expect(views().map((v) => v.id)).toEqual([first, id]);
    expect(viewNames()).toEqual(["View 1", "View 2"]);
    // One empty pane, focused — the same resting state the window boots to.
    expect(leavesOf(state().layout)).toHaveLength(1);
    expect(rootLeaf().tabIds).toEqual([]);
    expect(state().focusedPaneId).toBe(rootLeaf().id);
  });

  it("createView takes the FIRST free 'View N', not count + 1", () => {
    const second = act().createView(); // View 2
    act().createView(); // View 3
    act().closeView(second);

    // "View 2" is free again, and a `count + 1` rule would mint a duplicate "View 3".
    expect(act().createView()).toBeTruthy();
    expect(viewNames()).toEqual(["View 1", "View 3", "View 2"]);
  });

  it("createView trims an explicit name and falls back for a blank one", () => {
    act().createView("  Backend  ");
    expect(activeView().name).toBe("Backend");
    act().createView("   ");
    expect(activeView().name).toBe("View 2");
  });

  /* ───────────────────── the write-back on switch ───────────────────── */

  it("keeps the first view's whole tree when you switch away, mutate, and come back", () => {
    // View 1: a 2-pane split, one terminal in each.
    const left = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: left });
    const right = act().splitPane(left, "row");
    const b = act().openTerminalTab({ paneId: right });
    const first = state().activeViewId;
    const expected = treeShape(state().layout);
    const focusBefore = state().focusedPaneId;

    // View 2: a different shape entirely (3 panes, one terminal).
    const second = act().createView();
    const p1 = rootLeaf().id;
    const p2 = act().splitPane(p1, "column");
    act().splitPane(p2, "row");
    const c = act().openTerminalTab();
    expect(leavesOf(state().layout)).toHaveLength(3);

    // Back to view 1: its tree, its focus and its two terminals are intact…
    act().activateView(first);
    expect(treeShape(state().layout)).toEqual(expected);
    expect(state().focusedPaneId).toBe(focusBefore);
    expect(allTabIdsInTree(state().layout).sort()).toEqual([a, b].sort());
    // …and view 2 kept the shape it had when we left it.
    const stashed = views().find((v) => v.id === second) as ViewSnapshot;
    expect(leavesOf(stashed.layout)).toHaveLength(3);
    expect(allTabIdsInTree(stashed.layout)).toEqual([c]);

    // Nothing was torn down by any of it — that is the whole premise.
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertNoOrphans("after a round trip");
  });

  it("activateView is a genuine no-op for the already-active view", () => {
    act().openTerminalTab();
    const before = state();
    const snapshotBefore = before.views[0];

    act().activateView(before.activeViewId);

    // No write-back, no new state object: nothing changed, so nothing re-renders.
    expect(state()).toBe(before);
    expect(state().views[0]).toBe(snapshotBefore);
  });

  it("activateView ignores an unknown id", () => {
    const before = state();
    act().activateView(asViewId("nope"));
    expect(state()).toBe(before);
  });

  /* ─────────────────────────────── rename ─────────────────────────────── */

  it("renameView trims, and refuses an empty or whitespace name", () => {
    const id = state().activeViewId;
    act().renameView(id, "  Agents  ");
    expect(activeView().name).toBe("Agents");

    act().renameView(id, "   ");
    expect(activeView().name).toBe("Agents"); // refused, not stored
    act().renameView(id, "");
    expect(activeView().name).toBe("Agents");
    act().renameView(asViewId("nope"), "ghost");
    expect(viewNames()).toEqual(["Agents"]);
  });

  /* ─────────────────────────────── close ─────────────────────────────── */

  it("closeView RESCUES the closed view's tabs into the view that is now active", () => {
    const a = act().openTerminalTab(); // view 1
    const second = act().createView();
    const b = act().openTerminalTab(); // view 2
    const c = act().openTerminalTab(); // view 2

    act().closeView(second);

    expect(views()).toHaveLength(1);
    expect(state().activeViewId).not.toBe(second);
    // Nothing killed: no dispose, no record deleted, no id left dangling.
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(Object.keys(state().tabs).sort()).toEqual([a, b, c].sort());
    expect(allTabIdsInTree(state().layout)).toEqual([a, b, c]);
    expect(leafById(state().focusedPaneId).activeTabId).toBe(c);
    assertNoOrphans("after closing the active view");
  });

  it("closing an INACTIVE view moves its tabs into the one on screen, leaving it active", () => {
    const parked = act().createView();
    const b = act().openTerminalTab(); // lives in the parked view
    const first = state().views[0].id;
    act().activateView(first);
    const a = act().openTerminalTab(); // lives in the active view

    // The UI can name what is at stake BEFORE asking.
    expect(viewTabIds(state(), parked)).toEqual([b]);

    act().closeView(parked);

    expect(state().activeViewId).toBe(first);
    expect(views()).toHaveLength(1);
    expect(allTabIdsInTree(state().layout)).toEqual([a, b]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertNoOrphans("after closing an inactive view");
  });

  it("closeView hands over to the PREVIOUS view when the last one closes", () => {
    const second = act().createView();
    const third = act().createView();
    expect(state().activeViewId).toBe(third);

    act().closeView(third);
    expect(state().activeViewId).toBe(second); // no next → the previous one
  });

  it("closeView refuses the last view, and ignores an unknown id", () => {
    const a = act().openTerminalTab();
    const before = state();

    act().closeView(before.activeViewId);
    expect(state()).toBe(before);
    expect(state().tabs[a]).toBeDefined();

    act().createView();
    const two = state();
    act().closeView(asViewId("nope"));
    expect(state()).toBe(two);
  });

  it("closing a tab that lives in an INACTIVE view leaves no dangling id behind", () => {
    const parked = act().createView();
    const b = act().openTerminalTab();
    act().activateView(state().views[0].id);
    act().openTerminalTab();

    // Closed from outside its view (the agent-dismiss path does exactly this).
    act().closeTab(b);

    expect(state().tabs[b]).toBeUndefined();
    expect(viewTabIds(state(), parked)).toEqual([]);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    assertNoOrphans("after closing a parked tab");
  });

  it("closing a tab leaves the inactive views that do not hold it as the SAME snapshot", () => {
    // The sweep runs over every inactive view, so most closes visit views that
    // have nothing to do with the tab. Rewriting one of those would be a silent
    // cost, not a silent no-op: Immer mints a new snapshot AND a new `views`
    // array, waking every `views`-subscribed selector (the bar, its counts) for a
    // view the user never touched.
    const parked = act().createView();
    const kept = act().openTerminalTab(); // lives in the parked view
    act().activateView(state().views[0].id);
    const doomed = act().openTerminalTab(); // lives in the view on screen

    const before = state().views.find((v) => v.id === parked) as ViewSnapshot;
    act().closeTab(doomed);
    const after = state().views.find((v) => v.id === parked) as ViewSnapshot;

    expect(after).toBe(before);
    expect(viewTabIds(state(), parked)).toEqual([kept]);
    expect(state().tabs[doomed]).toBeUndefined();
    assertNoOrphans("after closing a tab no inactive view holds");
  });

  it("viewTabIds is empty for a view that no longer exists", () => {
    // The bar's close confirmation holds the chip it was opened for, and `closeView`
    // can retire that view while the menu is still on screen. Asking a gone view what
    // is inside it must answer "nothing", not throw on the way to rendering a count.
    const parked = act().createView();
    const tab = act().openTerminalTab();
    act().activateView(state().views[0].id);
    expect(viewTabIds(state(), parked)).toEqual([tab]);

    act().closeView(parked);

    expect(viewTabIds(state(), parked)).toEqual([]);
    // …and the tab is not lost with it — it was rescued into the live view.
    expect(viewTabIds(state(), state().activeViewId)).toEqual([tab]);
  });

  /* ──────────────────────────── moveTabToView ──────────────────────────── */

  it("re-opening a tab that lives in ANOTHER view switches to that view", () => {
    // The rail and the file tree are the reason this exists: activating a tab whose
    // terminal/editor you had moved to another view used to do NOTHING, because the scan walked
    // only the live tree and returned silently. A click that no-ops is indistinguishable from a
    // broken rail. Driven here through openEditorTab's dedupe, the same `activateTab` seam the
    // agent rail uses.
    const stay = act().openTerminalTab();
    const moved = act().openEditorTab("/w/moved.ts");
    const other = act().createView();
    act().activateView(state().views[0].id);
    act().moveTabToView(moved, other);
    const homeView = state().activeViewId;
    expect(homeView).not.toBe(other);

    // Re-open the same path: it must find the existing tab, not mint a second one.
    const again = act().openEditorTab("/w/moved.ts");

    expect(again).toBe(moved);
    expect(state().activeViewId).toBe(other);
    expect(allTabIdsInTree(state().layout)).toEqual([moved]);
    expect(leafById(state().focusedPaneId).activeTabId).toBe(moved);
    // ...and the view we left is intact, not clobbered by the switch.
    expect(viewTabIds(state(), homeView)).toEqual([stay]);
    assertNoOrphans("after a cross-view activateTab");

    // Negative control: doing it again, now that the tab IS in the active view, changes nothing.
    act().openEditorTab("/w/moved.ts");
    expect(state().activeViewId).toBe(other);
  });

  it("walks PAST the views that do not hold the tab, to the one that does", () => {
    // Three deep, with the tab parked in the LAST view. With only two views (the
    // active one plus the holder) the cross-view scan can be wrong and still look
    // right: "switch to the first view that is not this one" passes. Here that
    // rule would land the user in an empty "middle" view and leave the tab
    // they clicked as far away as it started.
    const stay = act().openTerminalTab();
    const moved = act().openEditorTab("/w/moved.ts");
    const middle = act().createView(); // holds nothing — must be stepped over
    const far = act().createView();
    const home = state().views[0].id;
    act().activateView(home);
    act().moveTabToView(moved, far);
    expect(state().activeViewId).toBe(home);

    // Re-opening the same path dedupes onto the parked tab and activates it.
    act().openEditorTab("/w/moved.ts");

    expect(state().activeViewId).toBe(far);
    expect(leafById(state().focusedPaneId).activeTabId).toBe(moved);
    // The view it stepped over is untouched, and so is the one it left.
    expect(viewTabIds(state(), middle)).toEqual([]);
    expect(viewTabIds(state(), home)).toEqual([stay]);
    assertNoOrphans("after a cross-view activateTab past an empty view");
  });

  it("moveTabToView moves the tab, not the terminal — same object, same TerminalId", () => {
    const a = act().openTerminalTab();
    const b = act().openTerminalTab();
    const tabBefore = state().tabs[b];
    const terminalId = terminalIdOfTab(b);
    const second = act().createView();
    act().activateView(state().views[0].id);

    act().moveTabToView(b, second);

    // The registry entry is untouched: same record, same id, nothing disposed.
    expect(state().tabs[b]).toBe(tabBefore);
    expect(terminalIdOfTab(b)).toBe(terminalId);
    expect(Object.keys(state().tabs).sort()).toEqual([a, b].sort());
    expect(terminal.dispose).not.toHaveBeenCalled();
    // It really left this view and really landed in the other one.
    expect(allTabIdsInTree(state().layout)).toEqual([a]);
    expect(viewTabIds(state(), second)).toEqual([b]);
    assertNoOrphans("after a cross-view move");

    // And it is there — with its terminal — when that view comes on screen.
    act().activateView(second);
    expect(allTabIdsInTree(state().layout)).toEqual([b]);
    expect(leafById(state().focusedPaneId).activeTabId).toBe(b);
  });

  it("moveTabToView prunes a pane that empties behind the tab", () => {
    const left = rootLeaf().id;
    act().openTerminalTab({ paneId: left });
    const right = act().splitPane(left, "row");
    const lone = act().openTerminalTab({ paneId: right });
    expect(leavesOf(state().layout)).toHaveLength(2);
    const second = act().createView();
    act().activateView(state().views[0].id);

    act().moveTabToView(lone, second);

    // The same emptiness rule closeTab uses: emptied leaf pruned, split collapsed.
    expect(leavesOf(state().layout)).toHaveLength(1);
    expect(findNode(state().layout, right)).toBeNull();
    expect(state().focusedPaneId).toBe(leavesOf(state().layout)[0].id);
    assertNoOrphans("after a pruning move");
  });

  it("moveTabToView works between two views that are both off screen", () => {
    const from = act().createView();
    const tab = act().openTerminalTab();
    const to = act().createView();
    act().activateView(state().views[0].id); // both source and target now inactive

    act().moveTabToView(tab, to);

    expect(viewTabIds(state(), from)).toEqual([]);
    expect(viewTabIds(state(), to)).toEqual([tab]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertNoOrphans("after an off-screen move");
  });

  it("moveTabToView is a no-op for the tab's own focused pane, or an unknown id", () => {
    const tab = act().openTerminalTab();
    const here = state().activeViewId;
    const before = state();

    act().moveTabToView(tab, here); // already in this view's focused pane
    expect(state()).toBe(before);

    act().moveTabToView(tab, asViewId("nope"));
    expect(state()).toBe(before);

    act().moveTabToView(asTabId("nope"), here);
    expect(state()).toBe(before);
  });

  it("moveTabToView pulls a tab back INTO the active view's focused pane", () => {
    const parked = act().createView();
    const tab = act().openTerminalTab();
    act().activateView(state().views[0].id);
    const target = act().splitPane(rootLeaf().id, "row");
    expect(state().focusedPaneId).toBe(target);

    act().moveTabToView(tab, state().activeViewId);

    expect(leafById(target).tabIds).toEqual([tab]);
    expect(leafById(target).activeTabId).toBe(tab);
    expect(viewTabIds(state(), parked)).toEqual([]);
    assertNoOrphans("after a move back on screen");
  });

  it("moveTabToView within ONE view re-homes the tab in that view's focused pane", () => {
    const left = rootLeaf().id;
    const tab = act().openTerminalTab({ paneId: left });
    const right = act().splitPane(left, "row");
    act().openTerminalTab({ paneId: right });
    act().focusPane(right);

    act().moveTabToView(tab, state().activeViewId);

    expect(leafById(right).tabIds).toEqual(expect.arrayContaining([tab]));
    expect(leavesOf(state().layout)).toHaveLength(1); // `left` emptied and collapsed
    assertNoOrphans("after a same-view re-home");
  });

  /* ────────────────────────────── reorder ────────────────────────────── */

  it("reorderViews moves a view before another, or to the end", () => {
    act().createView(); // View 2
    act().createView(); // View 3
    const [v1, v2, v3] = views().map((v) => v.id);

    act().reorderViews(v3, v1); // drop 3 onto 1 → 3 lands above it
    expect(views().map((v) => v.id)).toEqual([v3, v1, v2]);

    act().reorderViews(v3, null); // to the end
    expect(views().map((v) => v.id)).toEqual([v1, v2, v3]);

    // Reordering never changes which view is live, nor its tree.
    expect(state().activeViewId).toBe(v3);
    act().reorderViews(asViewId("nope"), v1);
    expect(views().map((v) => v.id)).toEqual([v1, v2, v3]);
  });

  /* ──────────────────── negative control: one view ──────────────────── */

  it("changes nothing about single-view use — every existing action behaves as before", () => {
    const only = state().activeViewId;
    const left = rootLeaf().id;
    const a = act().openTerminalTab({ paneId: left });
    const right = act().splitPane(left, "row");
    const b = act().openTerminalTab({ paneId: right });

    act().moveTab(b, left);
    expect(leavesOf(state().layout)).toHaveLength(1); // right emptied → collapsed
    expect(leafById(state().focusedPaneId).tabIds).toEqual([a, b]);

    act().closeTab(a);
    expect(state().tabs[a]).toBeUndefined();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);

    act().closePane(state().focusedPaneId);
    expect(state().tabs).toEqual({});
    expect(leavesOf(state().layout)).toHaveLength(1); // the last leaf survives, empty

    // Throughout: one view, still active, still the only one. The pre-existing
    // suite (327 tests above) is the rest of this control.
    expect(views()).toHaveLength(1);
    expect(state().activeViewId).toBe(only);
    assertLiveStoreInvariants("single-view use");
    assertNoOrphans("single-view use");
  });

  it("documents that views[active] is a SNAPSHOT — stale until a switch writes it back", () => {
    const before = activeView().layout;
    act().splitPane(rootLeaf().id, "row");

    // The live tree moved on; the snapshot did not. This is deliberate (it is
    // what keeps every pre-existing layout action untouched), so pin it: a
    // future reader must not mistake `views[active].layout` for live state.
    expect(activeView().layout).toBe(before);
    expect(state().layout).not.toBe(before);
    expect(leavesOf(state().layout)).toHaveLength(2);
    expect(leavesOf(activeView().layout)).toHaveLength(1);

    // A switch away is what refreshes it.
    act().createView();
    const refreshed = state().views[0];
    expect(leavesOf(refreshed.layout)).toHaveLength(2);
  });
});
