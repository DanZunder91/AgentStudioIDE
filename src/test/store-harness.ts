/**
 * Shared harness for the layout store: reset + the canonicalization invariants.
 *
 * The invariants live here (not inline in one test file) because they are the
 * spec — they are the highest-value frontend target, and they are
 * asserted from three angles: after every action in the property-based
 * sequences, on `canonicalize`'s output directly, and after component
 * interactions. One definition, three call sites.
 *
 * Source of the rules: `store.ts` `canonicalize()` docblock (a–e) and
 * ARCHITECTURE §4 "the tree is canonicalized after every mutation".
 */

import { expect } from "vitest";

import {
  asViewId,
  initialPortabilityState,
  makeLeaf,
  useAppStore,
  type LayoutState,
} from "../app/store";
import type {
  LeafNode,
  PaneId,
  PaneNode,
  SplitNode,
  TabId,
} from "../app/types";

/**
 * `sizes` are renormalized floats, so an exact `=== 1` is the wrong assertion.
 * Generous vs. IEEE754 drift (~1e-16 per term), still far tighter than any
 * error a real bug would produce.
 */
export const SUM_TOLERANCE = 1e-9;

/** Reset the module-singleton store to its boot state: one empty focused leaf. */
export function resetStore(): void {
  useAppStore.setState((s) => {
    const leaf = makeLeaf();
    s.layout = leaf;
    s.focusedPaneId = leaf.id;
    // Views are part of boot state, so they must be part of the reset. Without this a view
    // created in one test survives into the next, and `activeViewId` can even name a view that
    // no longer exists — a leak that reads as an unrelated failure three files later.
    s.views = [{ id: asViewId("view-boot"), name: "View 1", layout: leaf, focusedPaneId: leaf.id }];
    s.activeViewId = asViewId("view-boot");
    // Single-use restore state: a slot left behind by a test that exercised
    // `applyCenterLayout` would make the NEXT test's `rebuildTerminalTabs` prune
    // panes and re-place tabs for a layout that no longer exists.
    s.pendingRestore = {};
    s.tabs = {};
    // The crosshair's "last file tab activated anywhere". Harmless to leave —
    // `activeFilePath` discards any remembered path no live tab shows, and
    // `tabs` is cleared right above — but resetting it keeps boot state honest
    // rather than relying on a selector to launder a leak.
    s.lastFilePath = null;
    s.workspaceRoot = null;
    s.recentProjects = [];
    s.browseRoots = [];
    s.editors = {};
    s.confirmCloseTab = null;
    s.lspInstallHints = {};
    s.lspDismissedHints = [];
    s.lspIndexing = [];
    s.lspReferences = null;
    s.shortcutsOpen = false;
    s.findInFilesOpen = false;
    s.rightRailTab = "files";
    s.leftRailCollapsed = false;
    s.rightRailCollapsed = false;
    s.leftRailWidth = 260;
    s.rightRailWidth = 300;
    s.fileReveal = null;
    // Reset because the reveal tests toggle roots collapsed — without it, a
    // latent cross-test leak (absence means expanded, so nothing would notice).
    s.collapsedRoots = new Set<string>();
    s.apiRequests = {};
    s.sequences = {};
    s.apiCollections = [];
    // Saved-request folders + their disclosure set. Both belong here for the reason the
    // comments below record twice over: a new key nobody resets is a value that leaks
    // between tests, and a leaked collapse set makes a "the folder's requests are
    // visible" assertion pass or fail for reasons the test never mentions.
    s.apiFolders = [];
    s.collapsedApiFolders = new Set<string>();
    s.apiEnvironments = [];
    s.activeEnvironmentId = null;
    s.apiStoreLoaded = false;
    s.apiHistory = [];
    s.apiHistoryLoaded = false;
    s.saveRequestPrompt = null;
    // The database client. `dbLoaded` back to false is the load-once gate re-arming —
    // it lives in state (not a module latch) precisely so this reset works.
    s.dbEngines = [];
    s.dbConnections = [];
    s.dbLoaded = false;
    s.dbError = null;
    s.dbSessions = {};
    s.dbDialog = null;
    // The query consoles' buffers and last results. Missing this reset is not theoretical:
    // it made the "a blank buffer is not a round trip" test read `no-session` left behind by
    // the test before it — a stale error asserted as a fresh one. The same one-line
    // omission, for the consumed-usage store, once turned a whole run of unrelated tests red.
    s.dbConsoles = {};
    // The object tree's cache, the saved-query lists, and the "name this query"
    // dialog. All three are new keys, and this file is where omissions of that exact kind
    // have already cost red tests and a stale error asserted as a fresh one (see above). The
    // dangerous one here is `dbTrees`: a leaked cached level makes a lazy-expand test pass
    // WITHOUT calling `db_children` at all, which is precisely the assertion it exists to make.
    s.dbTrees = {};
    s.dbSavedQueries = {};
    // …and the hand-arranged table order, for a nastier reason than the others: a leaked
    // arrangement changes the ROW ORDER of a level, so it does not fail the test that leaked
    // it — it fails a later, unrelated one as "the wrong row was clicked", which is about the
    // most expensive shape a test-isolation bug can take.
    s.dbTreeOrders = {};
    // Find bars are keyed by request/path/connection ids that repeat across
    // tests; a leaked one re-opens a bar in an unrelated suite's render.
    // A close left waiting on "are you sure?" would make the NEXT suite's close
    // gesture look like a replay (the gate treats a non-null pending record as
    // "the user already answered"), so a leak here shows up as an unrelated test
    // closing something it never confirmed.
    s.pendingTerminalClose = null;
    s.findBars = {};
    s.scrollOffsets = {};
    s.gridViews = {};
    s.dbSaveQueryPrompt = null;
    // Shareable config bundles. Reset as a WHOLE slice through its own factory rather
    // than key by key, because the two failures the comments above record were both a new
    // key that nobody added here — and this slice's most dangerous stale value is
    // `overwriteExistingSecrets`, where a leaked `true` from a previous test would make the
    // security-default assertion pass for the wrong reason.
    Object.assign(s, initialPortabilityState());
  });
}

/** Every split node in the tree, depth-first. */
export function splitsOf(node: PaneNode): SplitNode[] {
  if (node.type === "leaf") return [];
  return [node, ...node.children.flatMap(splitsOf)];
}

/** Every node (splits and leaves), depth-first. */
export function nodesOf(node: PaneNode): PaneNode[] {
  if (node.type === "leaf") return [node];
  return [node, ...node.children.flatMap(nodesOf)];
}

/** Every leaf's tabIds concatenated — duplicates preserved, so we can spot them. */
export function allTabIdsInTree(node: PaneNode): TabId[] {
  return leavesOfNode(node).flatMap((leaf) => leaf.tabIds);
}

function leavesOfNode(node: PaneNode): LeafNode[] {
  return node.type === "leaf" ? [node] : node.children.flatMap(leavesOfNode);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * The structural invariants of a canonical `PaneNode` tree. Holds for anything
 * `canonicalize()` returned, regardless of how it got there.
 *
 * `where` is prepended to failures so a shrunk property-test counterexample
 * says which command in the sequence broke it.
 */
export function assertTreeInvariants(root: PaneNode, where = ""): void {
  const at = (msg: string) => `${where ? `${where}: ` : ""}${msg}`;

  // (e) the tree always has at least one leaf — never bottoms out to nothing.
  const leaves = leavesOfNode(root);
  expect(leaves.length, at("tree has no leaves")).toBeGreaterThan(0);

  // Pane ids are the identity used by every action + React's reconciler keys;
  // a duplicate would make findNode/replaceNode target the wrong node.
  const ids = nodesOf(root).map((n) => n.id);
  expect(new Set(ids).size, at(`duplicate PaneId in ${JSON.stringify(ids)}`)).toBe(
    ids.length,
  );

  for (const split of splitsOf(root)) {
    const label = `split ${split.id} (${split.orientation})`;

    // (a) no single-child (or childless) splits — they would render a sash-less
    // allotment wrapping one pane, i.e. pure noise in the tree.
    expect(
      split.children.length,
      at(`${label} has ${split.children.length} child(ren); must collapse`),
    ).toBeGreaterThanOrEqual(2);

    // (d) sizes line up with children and form a probability distribution.
    expect(
      split.sizes.length,
      at(`${label} sizes/children length mismatch`),
    ).toBe(split.children.length);
    for (const size of split.sizes) {
      expect(Number.isFinite(size), at(`${label} has non-finite size`)).toBe(true);
      expect(size, at(`${label} has negative size`)).toBeGreaterThanOrEqual(0);
    }
    expect(sum(split.sizes), at(`${label} sizes must sum to 1`)).toBeCloseTo(
      1,
      9,
    );

    // (b) no same-orientation nesting — a row inside a row is the same visual
    // layout as one flat row, so it must have been flattened.
    for (const child of split.children) {
      if (child.type !== "split") continue;
      expect(
        child.orientation,
        at(`${label} nests same-orientation split ${child.id}`),
      ).not.toBe(split.orientation);
    }
  }
}

/**
 * Full store-level invariants: the tree, plus focus and tab bookkeeping.
 */
export function assertStoreInvariants(s: LayoutState, where = ""): void {
  const at = (msg: string) => `${where ? `${where}: ` : ""}${msg}`;

  assertTreeInvariants(s.layout, where);

  // Focus always names a leaf that exists — `focusedPaneId` is where new tabs
  // open, so a dangling or split-pointing focus silently misroutes them.
  const leaves = leavesOfNode(s.layout);
  const focused = leaves.find((leaf) => leaf.id === s.focusedPaneId);
  expect(
    focused,
    at(`focusedPaneId ${s.focusedPaneId} is not an existing leaf`),
  ).toBeDefined();

  // No orphaned tabs, in either direction — ACROSS EVERY VIEW, not just the visible one.
  //
  // `s.tabs` is global and a tab may legitimately be parked in an inactive view, so checking
  // `s.layout` alone would report every such tab as an orphan. Read the live tree for the active
  // view (its snapshot in `s.views` is stale by design) and the snapshot for every other.
  const inTree = (s.views ?? []).flatMap((v) =>
    allTabIdsInTree(v.id === s.activeViewId ? s.layout : v.layout),
  );
  expect(
    new Set(inTree).size,
    at(`a TabId appears in more than one leaf: ${JSON.stringify(inTree)}`),
  ).toBe(inTree.length);

  const records = Object.keys(s.tabs) as TabId[];
  expect(
    [...inTree].sort(),
    at("every tab in SOME view must have a record, and vice versa"),
  ).toEqual([...records].sort());

  for (const leaf of leaves) {
    // activeTabId is null exactly when the leaf is empty; otherwise it points
    // at one of this leaf's own tabs (never a neighbour's).
    if (leaf.tabIds.length === 0) {
      expect(
        leaf.activeTabId,
        at(`empty leaf ${leaf.id} must have activeTabId null`),
      ).toBeNull();
    } else {
      expect(
        leaf.activeTabId,
        at(`leaf ${leaf.id} activeTabId not among its tabs`),
      ).not.toBeNull();
      expect(
        leaf.tabIds.includes(leaf.activeTabId as TabId),
        at(`leaf ${leaf.id} activeTabId ${leaf.activeTabId} not among its tabs`),
      ).toBe(true);
    }
  }
}

/** Convenience: assert invariants against the live store. */
export function assertLiveStoreInvariants(where = ""): void {
  assertStoreInvariants(useAppStore.getState(), where);
}

/** Structural identity, ignoring key order — for idempotence comparisons. */
export function treeShape(node: PaneNode): unknown {
  if (node.type === "leaf") {
    return {
      id: node.id,
      type: "leaf",
      tabIds: [...node.tabIds],
      activeTabId: node.activeTabId,
    };
  }
  return {
    id: node.id,
    type: "split",
    orientation: node.orientation,
    // Round away IEEE drift so a re-normalized-but-identical tree compares equal.
    sizes: node.sizes.map((n) => Number(n.toFixed(9))),
    children: node.children.map(treeShape),
  };
}

/** All leaf ids, in visual order. */
export function leafIds(node: PaneNode): PaneId[] {
  return leavesOfNode(node).map((leaf) => leaf.id);
}
