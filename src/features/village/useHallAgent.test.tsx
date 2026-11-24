/**
 * useHallAgent — whose context window the Village's Seats hall seats (the rail's selection), and
 * when it is read: on selection and when the Village comes back on screen, and again when that
 * agent's turn ends (the idle EDGE) — never while the hall is off screen, never for a sub-agent or
 * for nothing, never on a timer.
 *
 * Only the IPC call is mocked (`contextUsage`, a `vi.fn()`): the app store's selection, the context
 * store (its single-flight and its idle-edge detector `noteAgentStatus`) are the real code, so "a
 * read" below is one `claude … /context` process the real app would spawn.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextUsage } from "../context/contextTypes";

const { mockContext } = vi.hoisted(() => ({
  mockContext: vi.fn<(agentId: string) => Promise<ContextUsage>>(),
}));

vi.mock("../context/contextIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/contextIpc")>()),
  contextUsage: mockContext,
}));

import { useAppStore } from "../../app/store";
import { asAgentId, type AgentNode, type AgentStatus } from "../../app/types";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetContextStore } from "../context/contextStore";
import { hallAgentOf, useHallAgent } from "./useHallAgent";

const READING: ContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 109_900,
  windowTokens: 1_000_000,
  usedPercent: 11,
  categories: [],
  measuredAtMs: 1_785_200_000_000,
};

/** An agent as the client holds it (wire shape + client fields). */
function node(partial: Omit<Partial<AgentNode>, "id"> & { id: string }): AgentNode {
  const id = asAgentId(partial.id);
  return { ...wireAgent({ ...partial, id }), childIds: [], sessionId: null, expanded: false, unread: 0, ...partial, id };
}

function seed(partial: Omit<Partial<AgentNode>, "id"> & { id: string }): void {
  const n = node(partial);
  act(() => {
    useAppStore.setState((s) => {
      s.agents[n.id] = n;
      if (n.parentId === null && !s.rootAgentIds.includes(n.id)) s.rootAgentIds.push(n.id);
    });
  });
}

function select(id: string | null): void {
  act(() => {
    useAppStore.setState((s) => {
      s.selection.selectedAgentId = id === null ? null : asAgentId(id);
    });
  });
}

function patch(id: string, change: Partial<AgentNode>): void {
  act(() => {
    useAppStore.setState((s) => {
      Object.assign(s.agents[asAgentId(id)], change);
    });
  });
}

const setStatus = (id: string, status: AgentStatus) => patch(id, { status });

/** Let resolved reads land. */
const settle = () => act(async () => {});

/** The ids each read was for, in order. */
const reads = () => mockContext.mock.calls.map((c) => c[0]);

const hook = (enabled = true) =>
  renderHook(({ on }: { on: boolean }) => useHallAgent(on), { initialProps: { on: enabled } });

beforeEach(() => {
  resetFleetStore();
  resetContextStore();
  mockContext.mockReset();
  mockContext.mockResolvedValue(READING);
});
afterEach(() => {
  resetContextStore();
  resetFleetStore();
});

describe("hallAgentOf — the rail's selection as the hall sees it", () => {
  it("nothing selected: none", () => {
    expect(hallAgentOf(null)).toEqual({ kind: "none" });
  });

  it("a root agent: ready, measured by its agent id, named by its title", () => {
    expect(hallAgentOf(node({ id: "root-a", title: "gazelle" }))).toEqual({ kind: "ready", agentId: "root-a", label: "gazelle" });
  });

  it("a sub-agent: no reading of its own — just its name", () => {
    expect(hallAgentOf(node({ id: "sub-1", title: "fix-tests", parentId: asAgentId("root-a"), kind: "subagent" }))).toEqual({
      kind: "sub-agent",
      label: "fix-tests",
    });
  });

  it("the name the user gave it wins over the title — for a root and a sub-agent alike; a cleared one falls back", () => {
    expect(hallAgentOf(node({ id: "root-a", title: "gazelle", customTitle: "Payments" }))).toEqual({
      kind: "ready",
      agentId: "root-a",
      label: "Payments",
    });
    expect(hallAgentOf(node({ id: "sub-1", title: "fix-tests", customTitle: "Flaky", parentId: asAgentId("root-a") }))).toEqual({
      kind: "sub-agent",
      label: "Flaky",
    });
    expect(hallAgentOf(node({ id: "root-a", title: "gazelle", customTitle: null }))).toEqual({ kind: "ready", agentId: "root-a", label: "gazelle" });
  });
});

describe("useHallAgent — when the hall reads the selected agent's context", () => {
  it("a root selected while on screen: read once, by its agent id — not again on a re-render", async () => {
    seed({ id: "root-a", title: "gazelle", status: "running" });
    select("root-a");
    const { result, rerender } = hook(true);
    expect(result.current).toEqual({ kind: "ready", agentId: "root-a", label: "gazelle" });
    expect(reads()).toEqual(["root-a"]);
    await settle();
    rerender({ on: true });
    await settle();
    expect(reads()).toEqual(["root-a"]);
  });

  it("off screen (the City, or a hidden document): no read — but the agent is still named; on screen again: read", async () => {
    seed({ id: "root-a", title: "gazelle" });
    select("root-a");
    const { result, rerender } = hook(false);
    await settle();
    expect(reads()).toEqual([]);
    expect(result.current).toEqual({ kind: "ready", agentId: "root-a", label: "gazelle" });
    rerender({ on: true });
    await settle();
    expect(reads()).toEqual(["root-a"]);
    // Off and back on: the Village came back on screen, so it reads again.
    rerender({ on: false });
    await settle();
    expect(reads()).toEqual(["root-a"]);
    rerender({ on: true });
    await settle();
    expect(reads()).toEqual(["root-a", "root-a"]);
  });

  it("a sub-agent selected: no read (it has no /context of its own)", async () => {
    seed({ id: "root-a" });
    seed({ id: "sub-1", title: "fix-tests", parentId: asAgentId("root-a"), kind: "subagent" });
    select("sub-1");
    const { result } = hook(true);
    await settle();
    expect(reads()).toEqual([]);
    expect(result.current).toEqual({ kind: "sub-agent", label: "fix-tests" });
  });

  it("nothing selected, or a selection naming an agent that is gone: none, and no read", async () => {
    seed({ id: "root-a" });
    const { result } = hook(true);
    await settle();
    expect(result.current).toEqual({ kind: "none" });
    select("ghost");
    await settle();
    expect(result.current).toEqual({ kind: "none" });
    expect(reads()).toEqual([]);
  });

  it("each new selection is read — a root, another root, a sub-agent (not read), the first root again", async () => {
    seed({ id: "root-a", title: "gazelle" });
    seed({ id: "root-b", title: "atlas" });
    seed({ id: "sub-1", parentId: asAgentId("root-a"), kind: "subagent" });
    select("root-a");
    const { result } = hook(true);
    await settle();
    select("root-b");
    await settle();
    expect(result.current).toEqual({ kind: "ready", agentId: "root-b", label: "atlas" });
    expect(reads()).toEqual(["root-a", "root-b"]);
    select("sub-1");
    await settle();
    expect(reads()).toEqual(["root-a", "root-b"]);
    select("root-a");
    await settle();
    expect(reads()).toEqual(["root-a", "root-b", "root-a"]);
  });

  it("its turn ends (running → idle): read again — once per edge, never for staying idle or for a prompt", async () => {
    seed({ id: "root-a", status: "running" });
    select("root-a");
    hook(true);
    await settle();
    expect(reads()).toEqual(["root-a"]);
    setStatus("root-a", "idle");
    await settle();
    expect(reads()).toEqual(["root-a", "root-a"]);
    // Still idle (another field moves, the hook re-renders): no new edge, no read.
    patch("root-a", { lastActivityAt: 99 });
    await settle();
    expect(reads()).toHaveLength(2);
    // Mid-turn permission prompt is not the end of a turn.
    setStatus("root-a", "waiting_input");
    await settle();
    expect(reads()).toHaveLength(2);
  });

  it("a turn that ends while the hall is off screen is not read (nothing on screen to show it)", async () => {
    seed({ id: "root-a", status: "running" });
    select("root-a");
    hook(false);
    setStatus("root-a", "idle");
    await settle();
    expect(reads()).toEqual([]);
  });

  it("the returned object is stable until the selection or its name changes", async () => {
    seed({ id: "root-a", title: "gazelle", status: "running" });
    select("root-a");
    const { result, rerender } = hook(true);
    const first = result.current;
    rerender({ on: true });
    expect(result.current).toBe(first);
    // The agent object changes under it (activity, status) — the hall's agent does not.
    patch("root-a", { lastActivityAt: 42 });
    expect(result.current).toBe(first);
    setStatus("root-a", "idle");
    await settle();
    expect(result.current).toBe(first);
    rerender({ on: false });
    expect(result.current).toBe(first);
    // Renamed: a new object, with the new name.
    patch("root-a", { customTitle: "Payments" });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ kind: "ready", agentId: "root-a", label: "Payments" });
    // Nothing selected is stable too.
    select(null);
    const none = result.current;
    rerender({ on: true });
    expect(result.current).toBe(none);
  });
});
