/** Layout-store harness: reset + the canonicalization invariants (the spec), asserted after
 * property-test actions, on `canonicalize`'s output and after interactions. Rules: `store.ts`
 * `canonicalize()` (a–e) and ARCHITECTURE §4. */

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

/** `sizes` are renormalized floats: loose vs IEEE754 drift (~1e-16 a term), tight vs any bug. */
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
    // Reset so boot state is honest rather than laundered by `activeFilePath`'s selector.
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
    // Every new store key needs a reset here: a leaked collapse set flips "the folder's requests
    // are visible" for reasons the test never mentions.
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
    // A leaked console buffer lets a later test assert a stale `no-session` error as a fresh one.
    s.dbConsoles = {};
    // A leaked `dbTrees` level lets a lazy-expand test pass without calling `db_children` at all.
    s.dbTrees = {};
    s.dbSavedQueries = {};
    // A leaked arrangement changes a level's ROW ORDER and fails a later, unrelated test as "the
    // wrong row was clicked".
    s.dbTreeOrders = {};
    // A leaked find bar re-opens in an unrelated render; a leaked pending close reads as "already
    // answered", so a later close gesture would skip its confirm.
    s.pendingTerminalClose = null;
    s.findBars = {};
    s.scrollOffsets = {};
    s.gridViews = {};
    s.dbSaveQueryPrompt = null;
    // Reset as a whole slice via its factory so a new key cannot be missed; a leaked
    // `overwriteExistingSecrets: true` would pass the security-default assertion wrongly.
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

/** Structural invariants of any `canonicalize()` output; `where` prefixes failures so a shrunk
 * counterexample names the command that broke it. */
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

  // No orphaned tabs either way, across EVERY view: a tab may be parked in an inactive view. The
  // active view's `s.views` snapshot is stale by design, so read its live tree.
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
