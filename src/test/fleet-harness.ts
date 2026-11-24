/**
 * Shared harness for the fleet slice: reset, wire-shaped fixtures, invariants.
 *
 * Mirrors `store-harness.ts` for the layout slice. The invariants live here
 * rather than inline because they are the spec, and they are asserted from three
 * angles: after telemetry sequences, after component interactions, and in
 * property tests.
 */

import { expect } from "vitest";

import { useAppStore, type FleetState } from "../app/store";
import { resetFleetRowsCache } from "../features/fleet/flatten";
import type { AgentId, AgentNode } from "../app/types";

/** Reset the fleet slice AND the row memo, which is module-level. */
export function resetFleetStore(): void {
  useAppStore.setState((s) => {
    s.agents = {};
    s.rootAgentIds = [];
    s.selection = {
      selectedAgentId: null,
      activeSessionId: null,
      rightRailTab: "files",
    };
    s.dismissedAgentIds = [];
    s.collapsedFolders = new Set<string>();
  });
  resetFleetRowsCache();
}

/**
 * An `AgentNode` **as the wire sends it** — i.e. without the four UI-only
 * fields (ARCHITECTURE §2.2). Typed as AgentNode because that is the declared contract, but
 * the point of the cast is that Rust does not send these: a fixture that
 * included them would let a hydration bug pass unnoticed.
 */
export function wireAgent(partial: Partial<AgentNode> & { id: AgentId }): AgentNode {
  return {
    parentId: null,
    kind: "orchestrator",
    title: partial.id,
    status: "running",
    branch: "trunk",
    cwd: "/w/gazelle",
    runtime: "claude-code",
    startedAt: 1,
    finishedAt: null,
    lastActivityAt: 1,
    ...partial,
  } as AgentNode;
}

/**
 * The fleet's structural invariants. True of the store after ANY sequence of
 * telemetry, however malformed.
 */
export function assertFleetInvariants(s: FleetState, where = ""): void {
  const at = (msg: string) => `${where ? `${where}: ` : ""}${msg}`;
  const ids = Object.keys(s.agents) as AgentId[];

  // Every root is real and rooted.
  for (const rootId of s.rootAgentIds) {
    expect(s.agents[rootId], at(`root ${rootId} has no record`)).toBeDefined();
  }
  expect(
    new Set(s.rootAgentIds).size,
    at(`duplicate root: ${JSON.stringify(s.rootAgentIds)}`),
  ).toBe(s.rootAgentIds.length);

  for (const agentId of ids) {
    const agent = s.agents[agentId];

    // childIds never dangles, never duplicates — it is what the rail walks.
    expect(new Set(agent.childIds).size, at(`${agentId} has duplicate childIds`)).toBe(
      agent.childIds.length,
    );
    for (const childId of agent.childIds) {
      const child = s.agents[childId];
      if (!child) continue; // a child may legitimately not have arrived yet
      expect(child.parentId, at(`${childId}'s parentId disagrees with ${agentId}`)).toBe(
        agentId,
      );
    }

    // Exactly one home: a root, or its parent's childIds — never both, never
    // neither, or the rail shows it twice or not at all.
    const parent = agent.parentId ? s.agents[agent.parentId] : undefined;
    const isRoot = s.rootAgentIds.includes(agentId);
    if (parent) {
      expect(parent.childIds.includes(agentId), at(`${agentId} missing from its parent`)).toBe(
        true,
      );
      expect(isRoot, at(`${agentId} is both a root and a child`)).toBe(false);
    } else {
      expect(isRoot, at(`${agentId} is orphaned — in no list at all`)).toBe(true);
    }

    // UI-only fields are always hydrated; consumers treat them as total.
    expect(Array.isArray(agent.childIds), at(`${agentId}.childIds not hydrated`)).toBe(true);
    expect(typeof agent.expanded, at(`${agentId}.expanded not hydrated`)).toBe("boolean");
    expect(typeof agent.unread, at(`${agentId}.unread not hydrated`)).toBe("number");
    expect(agent.unread, at(`${agentId}.unread went negative`)).toBeGreaterThanOrEqual(0);
  }

  // Selection always names a real agent, or nothing.
  if (s.selection.selectedAgentId !== null) {
    expect(
      s.agents[s.selection.selectedAgentId],
      at(`selectedAgentId ${s.selection.selectedAgentId} has no record`),
    ).toBeDefined();
  }

  // A dismissed agent is GONE: never present, so it can never render. This is
  // the invariant the resurrection guard exists to hold — if a late event
  // re-created a tombstoned id, it would show up here.
  for (const dismissedId of s.dismissedAgentIds) {
    expect(
      s.agents[dismissedId],
      at(`dismissed agent ${dismissedId} was resurrected into the forest`),
    ).toBeUndefined();
  }

  // The tombstone is bounded — it must not grow without limit over a session.
  expect(
    s.dismissedAgentIds.length,
    at(`tombstone set exceeded its cap (${s.dismissedAgentIds.length})`),
  ).toBeLessThanOrEqual(512);
}

export function assertLiveFleetInvariants(where = ""): void {
  assertFleetInvariants(useAppStore.getState(), where);
}
