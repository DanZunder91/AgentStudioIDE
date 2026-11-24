/**
 * contextStore — per-agent readings, single-flight per agent, the idle edge.
 *
 * `contextUsage` is a `vi.fn()` handed deferreds, so WHEN a response lands is the
 * test's decision. `parseContextError` stays REAL: it is this feature's own splitter
 * (unlike `usageStore.test.ts`, which stubs another module's classifier), and the store's
 * contract is "the code the user sees", which is only observable through it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextUsage } from "./contextTypes";

const { mockContext } = vi.hoisted(() => ({
  mockContext: vi.fn<(agentId: string) => Promise<ContextUsage>>(),
}));

vi.mock("./contextIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contextIpc")>()),
  contextUsage: mockContext,
}));

import { noteAgentStatus, resetContextStore, useContextStore } from "./contextStore";

const A = "root-a";
const B = "root-b";

const reading = (usedTokens: number): ContextUsage => ({
  model: "claude-opus-5-5",
  usedTokens,
  windowTokens: 1_000_000,
  usedPercent: usedTokens / 10_000,
  categories: [],
  measuredAtMs: 1_785_200_000_000,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const entry = (id: string) => useContextStore.getState().entries[id];

beforeEach(() => {
  resetContextStore();
  mockContext.mockReset();
});
afterEach(() => {
  resetContextStore();
});

describe("refresh", () => {
  it("starts with nothing, marks loading, then stores the reading", async () => {
    const d = deferred<ContextUsage>();
    mockContext.mockReturnValueOnce(d.promise);

    expect(entry(A)).toBeUndefined();
    const p = useContextStore.getState().refresh(A);
    expect(entry(A)).toEqual({ data: null, error: null, loading: true });
    expect(mockContext).toHaveBeenCalledWith(A);

    d.resolve(reading(290_700));
    await p;
    expect(entry(A)).toEqual({ data: reading(290_700), error: null, loading: false });
  });

  it("a failure stores the CODE, not the raw text, and never blanks the last good reading", async () => {
    mockContext.mockResolvedValueOnce(reading(100_000));
    await useContextStore.getState().refresh(A);

    mockContext.mockRejectedValueOnce("cli-failed: exit 1: secret-ish stderr");
    await useContextStore.getState().refresh(A);
    expect(entry(A)).toEqual({ data: reading(100_000), error: "cli-failed", loading: false });

    // ...and the next success clears the error.
    mockContext.mockResolvedValueOnce(reading(120_000));
    await useContextStore.getState().refresh(A);
    expect(entry(A)).toEqual({ data: reading(120_000), error: null, loading: false });
  });

  it("an unclassifiable rejection is 'unknown'", async () => {
    mockContext.mockRejectedValueOnce(new Error("invalid args"));
    await useContextStore.getState().refresh(A);
    expect(entry(A).error).toBe("unknown");
  });

  it("is single-flight PER AGENT: concurrent refreshes of one agent are one spawn and share its promise", async () => {
    const d = deferred<ContextUsage>();
    mockContext.mockReturnValueOnce(d.promise);

    const { refresh } = useContextStore.getState();
    const first = refresh(A);
    const second = refresh(A);
    const third = refresh(A);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mockContext).toHaveBeenCalledTimes(1);

    d.resolve(reading(1));
    await Promise.all([first, second, third]);
    // The gate re-opens once the read settles.
    mockContext.mockResolvedValueOnce(reading(2));
    await refresh(A);
    expect(mockContext).toHaveBeenCalledTimes(2);
  });

  it("re-opens the gate after a FAILED read too", async () => {
    mockContext.mockRejectedValueOnce("timeout");
    await useContextStore.getState().refresh(A);
    mockContext.mockResolvedValueOnce(reading(3));
    await useContextStore.getState().refresh(A);
    expect(mockContext).toHaveBeenCalledTimes(2);
    expect(entry(A)).toEqual({ data: reading(3), error: null, loading: false });
  });

  it("two DIFFERENT agents read independently, and neither touches the other's entry", async () => {
    const da = deferred<ContextUsage>();
    const db = deferred<ContextUsage>();
    mockContext.mockReturnValueOnce(da.promise).mockReturnValueOnce(db.promise);

    const pa = useContextStore.getState().refresh(A);
    const pb = useContextStore.getState().refresh(B);
    expect(mockContext).toHaveBeenCalledTimes(2);

    db.reject("no-session");
    await pb;
    expect(entry(B)).toEqual({ data: null, error: "no-session", loading: false });
    expect(entry(A)).toEqual({ data: null, error: null, loading: true });

    da.resolve(reading(5));
    await pa;
    expect(entry(A).data).toEqual(reading(5));
    expect(entry(B).error).toBe("no-session");
  });
});

describe("noteAgentStatus — the turn-ended edge", () => {
  it("the first sighting only records — it does not read (the card's mount already did)", () => {
    noteAgentStatus(A, "idle");
    noteAgentStatus(B, "running");
    expect(mockContext).not.toHaveBeenCalled();
  });

  it("running → idle reads once; staying idle does not read again", async () => {
    mockContext.mockResolvedValue(reading(9));
    noteAgentStatus(A, "running");
    noteAgentStatus(A, "idle");
    expect(mockContext).toHaveBeenCalledTimes(1);
    expect(mockContext).toHaveBeenCalledWith(A);

    await vi.waitFor(() => expect(entry(A).data).toEqual(reading(9)));
    noteAgentStatus(A, "idle");
    noteAgentStatus(A, "idle");
    expect(mockContext).toHaveBeenCalledTimes(1);
  });

  it("waiting_input → idle is also a turn ending", () => {
    mockContext.mockResolvedValue(reading(1));
    noteAgentStatus(A, "waiting_input");
    noteAgentStatus(A, "idle");
    expect(mockContext).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "waiting_input", "done", "error"] as const)("an edge into %s does not read", (to) => {
    noteAgentStatus(A, "idle");
    noteAgentStatus(A, to);
    expect(mockContext).not.toHaveBeenCalled();
  });

  it("an idle edge landing on an in-flight read joins it — still one spawn", () => {
    const d = deferred<ContextUsage>();
    mockContext.mockReturnValueOnce(d.promise);
    void useContextStore.getState().refresh(A); // the card's mount
    noteAgentStatus(A, "running");
    noteAgentStatus(A, "idle");
    expect(mockContext).toHaveBeenCalledTimes(1);
    d.resolve(reading(1));
  });

  it("edges are tracked per agent", () => {
    mockContext.mockResolvedValue(reading(1));
    noteAgentStatus(A, "running");
    noteAgentStatus(B, "idle"); // B's FIRST sighting: no read
    expect(mockContext).not.toHaveBeenCalled();
    noteAgentStatus(A, "idle");
    expect(mockContext).toHaveBeenCalledWith(A);
    expect(mockContext).toHaveBeenCalledTimes(1);
  });

  it("resetContextStore forgets the last-seen statuses", () => {
    noteAgentStatus(A, "running");
    resetContextStore();
    noteAgentStatus(A, "idle"); // a first sighting again
    expect(mockContext).not.toHaveBeenCalled();
  });
});

describe("view", () => {
  it("defaults to bar and switches to grid", () => {
    expect(useContextStore.getState().view).toBe("bar");
    useContextStore.getState().setView("grid");
    expect(useContextStore.getState().view).toBe("grid");
    resetContextStore();
    expect(useContextStore.getState().view).toBe("bar");
  });
});
