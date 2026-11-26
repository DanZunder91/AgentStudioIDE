/** Hermetic like the usage suite: `gitIpc` mocked; `vi.resetModules()` + a dynamic import per
 * test, with the app store from the same fresh registry (else gitStore reads another instance).
 * The real `lib/wireCode` parser pins the stored `{code, detail}` contract. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoStatus } from "./gitIpc";
import type { PullRequest } from "./gitStore";

const { mockGitStatus, mockGhPrs } = vi.hoisted(() => ({
  mockGitStatus: vi.fn<(root: string) => Promise<RepoStatus>>(),
  mockGhPrs: vi.fn<(root: string) => Promise<PullRequest[]>>(),
}));

vi.mock("./gitIpc", () => ({
  gitStatus: mockGitStatus,
  ghPrs: mockGhPrs,
  urlOpen: vi.fn(),
}));

type GitModule = typeof import("./gitStore");
type AppModule = typeof import("../../app/store");

/** Fresh module instances ⇒ fresh ref count, timer, failure streak AND app store. */
async function load(): Promise<{ git: GitModule; app: AppModule }> {
  vi.resetModules();
  const git = await import("./gitStore");
  const app = await import("../../app/store");
  return { git, app };
}

/** Seed the workspace roots directly (no action side effects). */
function seedRoots(app: AppModule, roots: string[]): void {
  app.useAppStore.setState((s) => {
    s.browseRoots = roots;
  });
}

const stoppers: Array<() => void> = [];

/** Register a stopper so `afterEach` can guarantee no timer outlives its test. */
function track(stop: () => void): () => void {
  stoppers.push(stop);
  return stop;
}

/** A promise whose settlement this test controls. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain microtasks: fake timers don't, and the refresh chain is several awaits deep. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Advance the fake clock and let anything it triggered settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
}

function fireVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

const A = "/w/alpha";
const B = "/w/beta";

const statusOf = (root: string, branch = "main", changes: RepoStatus["changes"] = []): RepoStatus => ({
  root,
  branch,
  changes,
});

const pr = (number: number, author = "alex"): PullRequest => ({
  number,
  title: `PR ${number}`,
  author,
  url: `https://github.com/o/r/pull/${number}`,
  headRef: `branch-${number}`,
  baseRef: "main",
  isDraft: false,
  updatedAt: "2026-08-20T10:00:00Z",
});

beforeEach(() => {
  vi.useFakeTimers();
  mockGitStatus.mockReset();
  mockGhPrs.mockReset();
  setVisibility("visible");
});

afterEach(() => {
  while (stoppers.length > 0) stoppers.pop()?.();
  vi.useRealTimers();
});

describe("the cadence constants", () => {
  it("polls every 5s on the happy path and escalates 5s → 15s → 30s → 60s", async () => {
    const { git } = await load();
    expect(git.GIT_POLL_MS).toBe(5000);
    expect(git.GIT_BACKOFF_MS).toEqual([5000, 15_000, 30_000, 60_000]);
  });
});

describe("refreshGitStatus", () => {
  it("asks git_status once per workspace root, in workspaceRoots order", async () => {
    const { git, app } = await load();
    seedRoots(app, [A, B]);
    mockGitStatus.mockImplementation((root) => Promise.resolve(statusOf(root, `br-${root}`)));

    await git.useGitStore.getState().refreshGitStatus();

    expect(mockGitStatus.mock.calls.map((c) => c[0])).toEqual([A, B]);
    expect(git.useGitStore.getState().status).toEqual({
      [A]: { branch: `br-${A}`, changes: [], error: null },
      [B]: { branch: `br-${B}`, changes: [], error: null },
    });
  });

  it("stores the changes exactly as the wire delivered them", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    const changes = [
      { path: `${A}/src/x.ts`, status: "modified" as const },
      { path: `${A}/gone.ts`, status: "deleted" as const },
    ];
    mockGitStatus.mockResolvedValue(statusOf(A, "main", changes));

    await git.useGitStore.getState().refreshGitStatus();

    expect(git.useGitStore.getState().status[A].changes).toEqual(changes);
  });

  it("a failed root keeps its last good branch+changes with the error beside them", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    const changes = [{ path: `${A}/a.ts`, status: "added" as const }];
    mockGitStatus.mockResolvedValueOnce(statusOf(A, "main", changes));
    await git.useGitStore.getState().refreshGitStatus();

    mockGitStatus.mockRejectedValueOnce("git: index locked");
    await git.useGitStore.getState().refreshGitStatus();

    // Never-blank: stale-but-true rows beat no rows; the error rides beside them.
    expect(git.useGitStore.getState().status[A]).toEqual({
      branch: "main",
      changes,
      error: { code: "git", detail: "index locked" },
    });
  });

  it("a root that fails before ever succeeding gets an empty never-blank entry", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockRejectedValue("not-a-repo");

    await git.useGitStore.getState().refreshGitStatus();

    expect(git.useGitStore.getState().status[A]).toEqual({
      branch: "",
      changes: [],
      error: { code: "not-a-repo", detail: null },
    });
  });

  it("one broken root does not blank its healthy neighbour", async () => {
    const { git, app } = await load();
    seedRoots(app, [A, B]);
    mockGitStatus.mockImplementation((root) =>
      root === A ? Promise.resolve(statusOf(A)) : Promise.reject("git: boom"),
    );

    await git.useGitStore.getState().refreshGitStatus();

    expect(git.useGitStore.getState().status[A].error).toBeNull();
    expect(git.useGitStore.getState().status[B].error).toEqual({ code: "git", detail: "boom" });
  });

  it.each([
    ["out-of-scope: /etc", "out-of-scope", "/etc"],
    ["not-a-repo", "not-a-repo", null],
    ["git: exit 128", "git", "exit 128"],
    ["some raw driver text", "unknown", null],
  ])("classifies the rejection %j as { %s, %j }", async (wire, code, detail) => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockRejectedValue(wire);

    await git.useGitStore.getState().refreshGitStatus();

    expect(git.useGitStore.getState().status[A].error).toEqual({ code, detail });
  });

  it("clears a root's error on the next success", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockRejectedValueOnce("git: boom").mockResolvedValueOnce(statusOf(A));

    await git.useGitStore.getState().refreshGitStatus();
    await git.useGitStore.getState().refreshGitStatus();

    expect(git.useGitStore.getState().status[A].error).toBeNull();
  });

  it("prunes a root that left workspaceRoots", async () => {
    const { git, app } = await load();
    seedRoots(app, [A, B]);
    mockGitStatus.mockImplementation((root) => Promise.resolve(statusOf(root)));
    await git.useGitStore.getState().refreshGitStatus();
    expect(Object.keys(git.useGitStore.getState().status).sort()).toEqual([A, B]);

    seedRoots(app, [A]);
    await git.useGitStore.getState().refreshGitStatus();

    expect(Object.keys(git.useGitStore.getState().status)).toEqual([A]);
  });

  it("two concurrent refreshes collapse into ONE round of IPC calls", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    const d = deferred<RepoStatus>();
    mockGitStatus.mockReturnValue(d.promise);

    const first = git.useGitStore.getState().refreshGitStatus();
    const second = git.useGitStore.getState().refreshGitStatus();
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    d.resolve(statusOf(A));
    // The joiner AWAITS the outstanding fetch, so `await refresh()` still means
    // "the rows on screen are now fresh".
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(git.useGitStore.getState().status[A].branch).toBe("main");
  });

  it("re-opens the single-flight gate once the flight settles", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    await git.useGitStore.getState().refreshGitStatus();
    await git.useGitStore.getState().refreshGitStatus();

    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });

  it("resolves instead of rejecting, so no rejection can escape", async () => {
    const { git, app } = await load();
    seedRoots(app, [A, B]);
    mockGitStatus.mockRejectedValue("git: everything is on fire");

    // An escaped rejection would fail the browser tier's default-throw render
    // of the whole App (testing-strategy anti-pattern #11).
    await expect(git.useGitStore.getState().refreshGitStatus()).resolves.toBeUndefined();
  });
});

describe("refreshPrs", () => {
  it("asks gh_prs once per root and stores the lists", async () => {
    const { git, app } = await load();
    seedRoots(app, [A, B]);
    mockGhPrs.mockImplementation((root) => Promise.resolve(root === A ? [pr(1)] : []));

    await git.useGitStore.getState().refreshPrs();

    expect(mockGhPrs.mock.calls.map((c) => c[0])).toEqual([A, B]);
    expect(git.useGitStore.getState().prs).toEqual({
      [A]: { items: [pr(1)], error: null },
      [B]: { items: [], error: null },
    });
  });

  it("a failed re-fetch keeps the last loaded list with the error beside it", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGhPrs.mockResolvedValueOnce([pr(1), pr(2)]);
    await git.useGitStore.getState().refreshPrs();

    mockGhPrs.mockRejectedValueOnce("gh-failed: rate limited");
    await git.useGitStore.getState().refreshPrs();

    expect(git.useGitStore.getState().prs[A]).toEqual({
      items: [pr(1), pr(2)],
      error: { code: "gh-failed", detail: "rate limited" },
    });
  });

  it("a root that fails before ever loading keeps items null (never invented)", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGhPrs.mockRejectedValue("gh-missing");

    await git.useGitStore.getState().refreshPrs();

    expect(git.useGitStore.getState().prs[A]).toEqual({
      items: null,
      error: { code: "gh-missing", detail: null },
    });
  });

  it.each([
    ["gh-missing", "gh-missing", null],
    ["gh-not-signed-in: run gh auth login", "gh-not-signed-in", "run gh auth login"],
    ["no-remote", "no-remote", null],
    ["gh-failed: exit 1", "gh-failed", "exit 1"],
    ["timeout: 10s", "timeout", "10s"],
    ["parse", "parse", null],
    ["out-of-scope: /etc", "out-of-scope", "/etc"],
    ["mystery meat", "unknown", null],
  ])("classifies the rejection %j as { %s, %j }", async (wire, code, detail) => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGhPrs.mockRejectedValue(wire);

    await git.useGitStore.getState().refreshPrs();

    expect(git.useGitStore.getState().prs[A].error).toEqual({ code, detail });
  });

  it("prunes a root that left workspaceRoots", async () => {
    const { git, app } = await load();
    seedRoots(app, [A, B]);
    mockGhPrs.mockResolvedValue([]);
    await git.useGitStore.getState().refreshPrs();

    seedRoots(app, [B]);
    await git.useGitStore.getState().refreshPrs();

    expect(Object.keys(git.useGitStore.getState().prs)).toEqual([B]);
  });

  it("two concurrent refreshes collapse into ONE round of IPC calls", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    const d = deferred<PullRequest[]>();
    mockGhPrs.mockReturnValue(d.promise);

    const first = git.useGitStore.getState().refreshPrs();
    const second = git.useGitStore.getState().refreshPrs();
    expect(mockGhPrs).toHaveBeenCalledTimes(1);

    d.resolve([pr(1)]);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("does not join the STATUS single-flight — the two refreshers are independent", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    const hang = deferred<RepoStatus>();
    mockGitStatus.mockReturnValue(hang.promise);
    mockGhPrs.mockResolvedValue([]);

    const statusPending = git.useGitStore.getState().refreshGitStatus();
    await git.useGitStore.getState().refreshPrs();

    // The PR fetch completed while the status fetch was still in flight.
    expect(mockGhPrs).toHaveBeenCalledTimes(1);
    expect(git.useGitStore.getState().prs[A]).toEqual({ items: [], error: null });

    hang.resolve(statusOf(A));
    await statusPending;
  });

  it("resolves instead of rejecting, so no rejection can escape", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGhPrs.mockRejectedValue("gh-failed");

    await expect(git.useGitStore.getState().refreshPrs()).resolves.toBeUndefined();
  });
});

describe("setPrAuthorFilter", () => {
  it("sets and clears the author filter", async () => {
    const { git } = await load();
    git.useGitStore.getState().setPrAuthorFilter("alex");
    expect(git.useGitStore.getState().prAuthorFilter).toBe("alex");
    git.useGitStore.getState().setPrAuthorFilter(null);
    expect(git.useGitStore.getState().prAuthorFilter).toBeNull();
  });
});

describe("startGitPolling — cadence", () => {
  it("fetches the status IMMEDIATELY on the first start, and never touches gh_prs", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    track(git.startGitPolling());
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    // PRs are on-demand only (a network fetch is never on a timer).
    await advance(git.GIT_POLL_MS * 120);
    expect(mockGhPrs).not.toHaveBeenCalled();
  });

  it("fetches again at exactly GIT_POLL_MS, and not before", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    track(git.startGitPolling());
    await flush();

    await advance(git.GIT_POLL_MS - 1);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });

  it("stops fetching after the stopper runs", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    const stop = track(git.startGitPolling());
    await flush();
    stop();

    await advance(git.GIT_POLL_MS * 3);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);
  });

  it("arms the next attempt from when the fetch FINISHED, not when it started", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    const d = deferred<RepoStatus>();
    mockGitStatus.mockReturnValueOnce(d.promise).mockResolvedValue(statusOf(A));

    track(git.startGitPolling());
    // A slow response must not let ticks pile up behind it.
    await advance(git.GIT_POLL_MS * 4);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    d.resolve(statusOf(A));
    await flush();
    await advance(git.GIT_POLL_MS - 1);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });
});

describe("startGitPolling — failure backoff", () => {
  it("escalates 15s → 30s → 60s and HOLDS at 60s while a root keeps failing", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockRejectedValue("git: boom");

    track(git.startGitPolling());
    await flush();
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    for (const [delay, expected] of [
      [15_000, 2],
      [30_000, 3],
      [60_000, 4],
      [60_000, 5],
    ] as const) {
      // One millisecond short of the rung must still be silent.
      await advance(delay - 1);
      expect(mockGitStatus).toHaveBeenCalledTimes(expected - 1);
      await advance(1);
      expect(mockGitStatus).toHaveBeenCalledTimes(expected);
    }
  });

  it("snaps back to the 5s cadence on the next success", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockRejectedValueOnce("git: boom").mockResolvedValue(statusOf(A));

    track(git.startGitPolling());
    await flush();

    await advance(15_000);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);

    await advance(git.GIT_POLL_MS - 1);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mockGitStatus).toHaveBeenCalledTimes(3);
  });

  it("a `not-a-repo` root does NOT escalate the cadence — it is a steady state, not a fault", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockRejectedValue("not-a-repo");

    track(git.startGitPolling());
    await flush();
    expect(mockGitStatus).toHaveBeenCalledTimes(1);
    expect(git.useGitStore.getState().status[A].error).toEqual({
      code: "not-a-repo",
      detail: null,
    });

    // Still the happy-path 5s — one non-repo folder must not degrade the tree
    // decoration of every real repo beside it.
    await advance(git.GIT_POLL_MS);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
    await advance(git.GIT_POLL_MS);
    expect(mockGitStatus).toHaveBeenCalledTimes(3);
  });
});

describe("startGitPolling — reference counting", () => {
  it("two starts share ONE timer and one immediate fetch", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    track(git.startGitPolling());
    track(git.startGitPolling());
    await flush();
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    await advance(git.GIT_POLL_MS);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after the FIRST stopper, stops on the second, and a double-stop is harmless", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    const stopA = track(git.startGitPolling());
    const stopB = track(git.startGitPolling());
    await flush();

    stopA();
    stopA(); // StrictMode double-invokes cleanups — must not unsubscribe B.
    await advance(git.GIT_POLL_MS);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);

    stopB();
    await advance(git.GIT_POLL_MS * 3);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });
});

describe("startGitPolling — document visibility", () => {
  it("does not fetch at all while the document starts hidden", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));
    setVisibility("hidden");

    track(git.startGitPolling());
    await advance(git.GIT_POLL_MS * 3);
    expect(mockGitStatus).not.toHaveBeenCalled();
  });

  it("pauses when hidden, and fetches IMMEDIATELY on becoming visible again", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    track(git.startGitPolling());
    await flush();
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    fireVisibilityChange();
    await advance(git.GIT_POLL_MS * 4);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    fireVisibilityChange();
    // The returning user must not be greeted by a stale tree.
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
    await flush();
    await advance(git.GIT_POLL_MS);
    expect(mockGitStatus).toHaveBeenCalledTimes(3);
  });

  it("a redundant visibilitychange while already visible adds no timer and no fetch", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    track(git.startGitPolling());
    await flush();

    fireVisibilityChange(); // still "visible"
    fireVisibilityChange();
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    // Two timers would show up here as two calls per cadence.
    await advance(git.GIT_POLL_MS);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });

  it("removes the visibilitychange listener on the FINAL stop", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const stopA = track(git.startGitPolling());
    const stopB = track(git.startGitPolling());
    await flush();

    stopA();
    expect(removeSpy).not.toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    stopB();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    removeSpy.mockRestore();

    // And it is really gone — a later event cannot revive a stopped poller.
    setVisibility("hidden");
    fireVisibilityChange();
    setVisibility("visible");
    fireVisibilityChange();
    await advance(git.GIT_POLL_MS * 2);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);
  });

  it("survives a non-DOM environment: polls, and stops without a listener", async () => {
    const { git, app } = await load();
    seedRoots(app, [A]);
    mockGitStatus.mockResolvedValue(statusOf(A));

    // Stub AFTER load: the modules exist, but the polling lifecycle must not
    // reach for a document that is not there (a headless harness, node).
    vi.stubGlobal("document", undefined);
    try {
      const stop = git.startGitPolling();
      await flush();
      // No document ⇒ nothing can say we are hidden, so poll.
      expect(mockGitStatus).toHaveBeenCalledTimes(1);

      await advance(git.GIT_POLL_MS);
      expect(mockGitStatus).toHaveBeenCalledTimes(2);

      stop();
      await advance(git.GIT_POLL_MS * 2);
      expect(mockGitStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the tree-decoration selectors", () => {
  const entry = (changes: Array<{ path: string; status: "modified" | "added" | "deleted" | "untracked" }>) => ({
    branch: "main",
    changes,
    error: null,
  });

  it("fileStatusMap flattens every root's changes into one path → status lookup", async () => {
    const { git } = await load();
    const map = git.fileStatusMap({
      [A]: entry([
        { path: `${A}/src/x.ts`, status: "modified" },
        { path: `${A}/y.ts`, status: "deleted" },
      ]),
      [B]: entry([{ path: `${B}/z.ts`, status: "untracked" }]),
    });
    expect(map).toEqual({
      [`${A}/src/x.ts`]: "modified",
      [`${A}/y.ts`]: "deleted",
      [`${B}/z.ts`]: "untracked",
    });
  });

  it("dirsWithChanges collects every ancestor STRICTLY below the root", async () => {
    const { git } = await load();
    const dirs = git.dirsWithChanges({
      [A]: entry([
        { path: `${A}/src/deep/x.ts`, status: "modified" },
        { path: `${A}/top.ts`, status: "added" },
      ]),
    });
    // `src` and `src/deep` carry the dot; the root itself never does, and a
    // root-level file contributes no directory at all.
    expect(dirs).toEqual(new Set([`${A}/src`, `${A}/src/deep`]));
  });

  it("terminates the ancestor walk at the filesystem root (a '/'-rooted workspace)", async () => {
    const { git } = await load();
    // Pathological but representable: the workspace root IS "/". The walk from
    // "/x.ts" reaches the empty parent and must stop — this is the guard that
    // keeps `dirsWithChanges` from spinning on a top-level path.
    const dirs = git.dirsWithChanges({
      "/": entry([{ path: "/x.ts", status: "modified" }]),
    });
    expect(dirs).toEqual(new Set());
  });

  it("walks a Windows path at its backslashes — the tree's folder dots on Windows", async () => {
    const { git } = await load();
    const W = "C:\\Users\\me\\repo";
    const dirs = git.dirsWithChanges({
      [W]: entry([
        { path: `${W}\\src\\deep\\x.ts`, status: "modified" },
        { path: `${W}\\top.ts`, status: "added" },
      ]),
    });
    expect(dirs).toEqual(new Set([`${W}\\src`, `${W}\\src\\deep`]));
  });

  it("matches a Windows root case-insensitively and keeps the change's own spelling", async () => {
    const { git } = await load();
    const dirs = git.dirsWithChanges({
      "c:\\repo": entry([{ path: "C:\\Repo\\Src\\x.ts", status: "modified" }]),
    });
    // The tree's `data-path` is canonical (git's spelling), so the dot must be too.
    expect(dirs).toEqual(new Set(["C:\\Repo\\Src"]));
  });

  it("terminates at a Windows drive root", async () => {
    const { git } = await load();
    const dirs = git.dirsWithChanges({
      "C:\\": entry([{ path: "C:\\x.ts", status: "modified" }]),
      "C:\\w": entry([{ path: "D:\\elsewhere\\y.ts", status: "modified" }]),
    });
    expect(dirs).toEqual(new Set());
  });

  it("never counts a sibling that merely shares the root's prefix", async () => {
    const { git } = await load();
    // Workspace `/w/a` inside a repo at `/w`: git reports `/w/ab/x.ts` too.
    const dirs = git.dirsWithChanges({
      "/w/a": entry([{ path: "/w/ab/x.ts", status: "modified" }]),
    });
    expect(dirs).toEqual(new Set());
  });
});
