/** Agent Logs store: ingest (snapshot, then `id > lastId`), cap, pause/resume, clear and the
 * ref-counted subscription; only `./logstreamIpc` is mocked. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const state = {
    handler: null as null | ((lines: unknown[]) => void),
    unlisten: vi.fn(),
  };
  return {
    state,
    logstreamSnapshot: vi.fn(),
    logstreamClear: vi.fn(),
    onLogstreamLines: vi.fn(),
    syslogStatus: vi.fn(),
    syslogSet: vi.fn(),
    syslogApps: vi.fn(),
  };
});
vi.mock("./logstreamIpc", () => ({
  logstreamSnapshot: ipc.logstreamSnapshot,
  logstreamClear: ipc.logstreamClear,
  onLogstreamLines: ipc.onLogstreamLines,
  syslogStatus: ipc.syslogStatus,
  syslogSet: ipc.syslogSet,
  syslogApps: ipc.syslogApps,
}));

import {
  resetAgentLogsForTests,
  retryLogstream,
  startLogstream,
  startSyslogPoll,
  useAgentLogsStore,
} from "./agentLogsStore";
import { LOG_CAP, type LogLine, type SyslogFilter, type SyslogStatus } from "./agentLogsTypes";

const L = (id: number, p: Partial<LogLine> = {}): LogLine => ({
  id,
  tsMs: 1_700_000_000_000 + id,
  terminalId: "t1",
  agentId: null,
  source: "zsh",
  kind: "output",
  level: "info",
  text: `line ${id}`,
  detail: null,
  toolUseId: null,
  ...p,
});
const FILTER = (p: Partial<SyslogFilter> = {}): SyslogFilter => ({
  enabled: false,
  apps: null,
  subsystem: null,
  minLevel: "default",
  simulator: false,
  simulatorApps: null,
  ...p,
});
const STATUS = (p: Partial<SyslogStatus> = {}): SyslogStatus => ({
  available: true,
  backend: "macos-unified-log",
  reason: null,
  running: false,
  filter: FILTER(),
  simulator: { available: false, reason: null, running: false },
  linesPerSec: 0,
  droppedPerSec: 0,
  ...p,
});
const ids = () => useAgentLogsStore.getState().lines.map((l) => l.id);
const st = () => useAgentLogsStore.getState();
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A deferred promise, so a test controls exactly when IPC resolves. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetAgentLogsForTests();
  ipc.state.handler = null;
  ipc.state.unlisten.mockReset();
  ipc.logstreamSnapshot.mockReset().mockResolvedValue([]);
  ipc.logstreamClear.mockReset().mockResolvedValue(undefined);
  ipc.syslogStatus.mockReset().mockResolvedValue(STATUS());
  ipc.syslogSet.mockReset().mockImplementation((filter: SyslogFilter) =>
    Promise.resolve(STATUS({ filter, running: filter.enabled })),
  );
  ipc.syslogApps.mockReset().mockResolvedValue([]);
  ipc.onLogstreamLines.mockReset().mockImplementation((h: (lines: unknown[]) => void) => {
    ipc.state.handler = h;
    return Promise.resolve(ipc.state.unlisten);
  });
});
afterEach(() => resetAgentLogsForTests());

const emit = (lines: LogLine[]) => (ipc.state.handler as (l: LogLine[]) => void)(lines);

describe("ingest", () => {
  it("appends in id order and records lastId", () => {
    st().ingest([L(1), L(2)]);
    st().ingest([L(3)]);
    expect(ids()).toEqual([1, 2, 3]);
    expect(st().lastId).toBe(3);
  });

  it("drops ids ≤ lastId (a replay, an overlap) and duplicates inside a batch", () => {
    st().ingest([L(1), L(2), L(3)]);
    st().ingest([L(2), L(3), L(4), L(4), L(5)]);
    expect(ids()).toEqual([1, 2, 3, 4, 5]);
  });

  it("sorts an out-of-order batch", () => {
    st().ingest([L(3), L(1), L(2)]);
    expect(ids()).toEqual([1, 2, 3]);
  });

  it("an all-stale batch changes nothing (same state object)", () => {
    st().ingest([L(1), L(2)]);
    const before = st().lines;
    st().ingest([L(1), L(2)]);
    expect(st().lines).toBe(before);
  });

  it(`caps at ${LOG_CAP}, dropping the oldest`, () => {
    const many = Array.from({ length: LOG_CAP + 5 }, (_, i) => L(i + 1));
    st().ingest(many);
    expect(st().lines).toHaveLength(LOG_CAP);
    expect(st().lines[0].id).toBe(6);
    expect(st().lines[LOG_CAP - 1].id).toBe(LOG_CAP + 5);
    st().ingest([L(LOG_CAP + 6)]);
    expect(st().lines).toHaveLength(LOG_CAP);
    expect(st().lines[0].id).toBe(7);
  });
});

describe("pause / resume", () => {
  it("while paused new lines buffer; resume shows them in order", () => {
    st().ingest([L(1)]);
    st().setPaused(true);
    st().ingest([L(2), L(3)]);
    expect(ids()).toEqual([1]);
    expect(st().pending.map((l) => l.id)).toEqual([2, 3]);
    expect(st().lastId).toBe(3); // the dedupe keeps working while paused
    st().ingest([L(3)]);
    expect(st().pending).toHaveLength(2);
    st().setPaused(false);
    expect(ids()).toEqual([1, 2, 3]);
    expect(st().pending).toEqual([]);
    expect(st().paused).toBe(false);
  });

  it("the buffer and the merged result are both capped", () => {
    st().setPaused(true);
    st().ingest(Array.from({ length: LOG_CAP + 2 }, (_, i) => L(i + 1)));
    expect(st().pending).toHaveLength(LOG_CAP);
    expect(st().pending[0].id).toBe(3);
    st().setPaused(false);
    expect(st().lines).toHaveLength(LOG_CAP);
  });
});

describe("clear", () => {
  it("calls logstream_clear, empties the view, keeps lastId so a replay cannot resurrect", async () => {
    st().ingest([L(1), L(2)]);
    st().toggleExpanded(2);
    await st().clear();
    expect(ipc.logstreamClear).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual([]);
    expect(st().expandedId).toBeNull();
    expect(st().lastId).toBe(2);
    st().ingest([L(1), L(2), L(3)]);
    expect(ids()).toEqual([3]);
  });

  it("a line that lands while the command is in flight survives the clear", async () => {
    const d = deferred<void>();
    ipc.logstreamClear.mockReturnValue(d.promise);
    st().ingest([L(1), L(2)]);
    const p = st().clear();
    st().ingest([L(3)]);
    d.resolve();
    await p;
    expect(ids()).toEqual([3]);
  });

  it("clears the paused buffer too, and moves the follow mark past what was cleared", async () => {
    st().ingest([L(1)]);
    st().setFollow(false);
    st().setPaused(true);
    st().ingest([L(2)]);
    await st().clear();
    expect(st().pending).toEqual([]);
    expect(st().followMark).toBe(2);
  });

  it("a failed clear keeps the lines and says why", async () => {
    ipc.logstreamClear.mockRejectedValue("not-running");
    st().ingest([L(1)]);
    await st().clear();
    expect(ids()).toEqual([1]);
    expect(st().clearError).toBe("Could not clear the log: not-running");
    ipc.logstreamClear.mockResolvedValue(undefined);
    await st().clear();
    expect(st().clearError).toBeNull();
  });
});

describe("view state", () => {
  it("filter actions", () => {
    st().setQuery("/err/");
    st().toggleLevel("debug");
    st().setIde(false);
    st().setSourcePick(["vite", "x", "zsh"], ["x"]);
    expect(st().filter).toEqual({
      query: "/err/",
      levels: { error: true, warn: true, info: true, debug: false },
      ide: false,
      hiddenSources: [],
      onlySources: ["x"],
    });
    st().setSourcePick(["vite", "x", "zsh"], null);
    expect(st().filter).toMatchObject({ hiddenSources: [], onlySources: null });
    st().setSourcePick(["vite", "x", "zsh"], ["x", "zsh"]);
    expect(st().filter).toMatchObject({ hiddenSources: ["vite"], onlySources: null });
    st().toggleLevel("debug");
    expect(st().filter.levels.debug).toBe(true);
    st().setIde(true);
    expect(st().filter.ide).toBe(true);
  });

  it("unfollow records the mark; follow keeps it", () => {
    st().ingest([L(1), L(2)]);
    st().setFollow(false);
    expect(st()).toMatchObject({ follow: false, followMark: 2 });
    st().ingest([L(3)]);
    st().setFollow(true);
    expect(st()).toMatchObject({ follow: true, followMark: 2 });
  });

  it("toggleExpanded opens, switches, closes", () => {
    st().toggleExpanded(1);
    expect(st().expandedId).toBe(1);
    st().toggleExpanded(2);
    expect(st().expandedId).toBe(2);
    st().toggleExpanded(2);
    expect(st().expandedId).toBeNull();
  });

  it("the sidebar is open by default; setSidebarOpen flips it", () => {
    expect(st().sidebarOpen).toBe(true);
    st().setSidebarOpen(false);
    expect(st().sidebarOpen).toBe(false);
    st().setSidebarOpen(true);
    expect(st().sidebarOpen).toBe(true);
  });

  it("toggleOnlySource solos, re-solos another, and un-solos; it drops any exclusion list", () => {
    st().setSourcePick(["a", "b", "c"], ["a", "b"]); // an exclusion of c
    st().toggleOnlySource("a");
    expect(st().filter).toMatchObject({ hiddenSources: [], onlySources: ["a"] });
    st().toggleOnlySource("b");
    expect(st().filter.onlySources).toEqual(["b"]);
    st().toggleOnlySource("b");
    expect(st().filter.onlySources).toBeNull();
  });

  it("soloSource shows only that source whatever the pick was — a solo, never an exclusion", () => {
    // With exactly two sources seen, `setSourcePick(sources, [one])` reads as "untick the other"
    // and becomes an exclusion; a solo must be a positive pick so the sidebar row presses and
    // the stream header shows. That is why this is its own action.
    st().setSourcePick(["a", "b"], ["a"]);
    expect(st().filter).toMatchObject({ hiddenSources: ["b"], onlySources: null });
    st().soloSource("a");
    expect(st().filter).toMatchObject({ hiddenSources: [], onlySources: ["a"] });
    // Already solo on another source: it switches, it does not toggle off.
    st().soloSource("b");
    expect(st().filter).toMatchObject({ hiddenSources: [], onlySources: ["b"] });
    st().soloSource("b");
    expect(st().filter).toMatchObject({ hiddenSources: [], onlySources: ["b"] });
  });

  it("setBlockExpanded records an explicit choice per block key, absent = automatic", () => {
    expect(st().expandedBlocks).toEqual({});
    st().setBlockExpanded("tu_1", true);
    st().setBlockExpanded("tu_2", false);
    expect(st().expandedBlocks).toEqual({ tu_1: true, tu_2: false });
    st().setBlockExpanded("tu_1", false);
    expect(st().expandedBlocks).toEqual({ tu_1: false, tu_2: false });
  });

  it("dismissRunning keeps a watermark per source", () => {
    st().dismissRunning("tail · bg", 7);
    st().dismissRunning("old", 3);
    expect(st().runningDismissed).toEqual({ "tail · bg": 7, old: 3 });
  });
});

describe("error navigation", () => {
  it("requestErrorJump solos the source, turns the Error level on, stops follow, and posts a fresh request each time", () => {
    st().ingest([L(1), L(2)]);
    st().toggleLevel("error");
    st().setSourcePick(["a", "b"], ["b"]);
    st().requestErrorJump("gazelle · bg", "first");
    expect(st().filter).toMatchObject({
      levels: { error: true, warn: true, info: true, debug: true },
      hiddenSources: [],
      onlySources: ["gazelle · bg"],
    });
    expect(st()).toMatchObject({ follow: false, followMark: 2 });
    const first = st().jumpRequest;
    expect(first).toEqual({ source: "gazelle · bg", step: "first", seq: 1 });
    st().requestErrorJump("gazelle · bg", "next");
    expect(st().jumpRequest).toEqual({ source: "gazelle · bg", step: "next", seq: 2 });
    expect(st().jumpRequest).not.toBe(first);
  });

  it("resolveErrorJump clears the request and records (or clears) the cursor", () => {
    st().requestErrorJump("x", "first");
    st().resolveErrorJump({ source: "x", lineId: 9 });
    expect(st()).toMatchObject({ jumpRequest: null, errorCursor: { source: "x", lineId: 9 } });
    st().requestErrorJump("x", "prev");
    st().resolveErrorJump(null);
    expect(st()).toMatchObject({ jumpRequest: null, errorCursor: null });
  });

  it("reset restarts the request sequence", () => {
    st().requestErrorJump("x", "first");
    resetAgentLogsForTests();
    st().requestErrorJump("x", "first");
    expect(st().jumpRequest?.seq).toBe(1);
  });
});

describe("the subscription", () => {
  it("subscribes FIRST, then snapshots, then appends events", async () => {
    ipc.logstreamSnapshot.mockResolvedValue([L(1), L(2)]);
    const release = startLogstream();
    expect(st().status).toBe("loading");
    expect(ipc.onLogstreamLines).toHaveBeenCalledTimes(1);
    expect(ipc.logstreamSnapshot).not.toHaveBeenCalled(); // not before listen resolves
    await flush();
    expect(ipc.logstreamSnapshot).toHaveBeenCalledTimes(1);
    expect(st().status).toBe("ready");
    expect(ids()).toEqual([1, 2]);
    emit([L(2), L(3)]);
    expect(ids()).toEqual([1, 2, 3]);
    release();
    expect(ipc.state.unlisten).toHaveBeenCalledTimes(1);
  });

  it("events that land before the snapshot are held and replayed after it", async () => {
    const snap = deferred<LogLine[]>();
    ipc.logstreamSnapshot.mockReturnValue(snap.promise);
    startLogstream();
    await flush();
    emit([L(3), L(4)]); // newer than anything in the snapshot
    expect(ids()).toEqual([]); // held, not ingested ahead of the snapshot
    snap.resolve([L(1), L(2), L(3)]);
    await flush();
    expect(ids()).toEqual([1, 2, 3, 4]);
  });

  it("is ref-counted: two mounts share one listener; the last release unsubscribes", async () => {
    const a = startLogstream();
    const b = startLogstream();
    await flush();
    expect(ipc.onLogstreamLines).toHaveBeenCalledTimes(1);
    a();
    a(); // idempotent — a double release must not tear down b's stream
    expect(ipc.state.unlisten).not.toHaveBeenCalled();
    b();
    expect(ipc.state.unlisten).toHaveBeenCalledTimes(1);
  });

  it("a release before `listen` resolves unsubscribes as soon as it does, and never snapshots", async () => {
    const sub = deferred<() => void>();
    ipc.onLogstreamLines.mockReturnValue(sub.promise);
    const release = startLogstream();
    release();
    sub.resolve(ipc.state.unlisten);
    await flush();
    expect(ipc.state.unlisten).toHaveBeenCalledTimes(1);
    expect(ipc.logstreamSnapshot).not.toHaveBeenCalled();
  });

  it("a release while the snapshot is in flight ignores its result and later events", async () => {
    const snap = deferred<LogLine[]>();
    ipc.logstreamSnapshot.mockReturnValue(snap.promise);
    const release = startLogstream();
    await flush();
    const handler = ipc.state.handler as (l: LogLine[]) => void;
    release();
    snap.resolve([L(1)]);
    handler([L(2)]);
    await flush();
    expect(ids()).toEqual([]);
    expect(st().status).toBe("loading");
  });

  it("a failed subscribe is an error state", async () => {
    ipc.onLogstreamLines.mockRejectedValue("no event plugin");
    startLogstream();
    await flush();
    expect(st()).toMatchObject({
      status: "error",
      error: "Could not read the log stream: no event plugin",
    });
  });

  it("a failed snapshot is an error, but held events are shown and the stream stays live", async () => {
    const snap = deferred<LogLine[]>();
    ipc.logstreamSnapshot.mockReturnValue(snap.promise);
    startLogstream();
    await flush();
    emit([L(5)]);
    snap.reject("ring poisoned");
    await flush();
    expect(st().status).toBe("error");
    expect(st().error).toBe("Could not read the log stream: ring poisoned");
    expect(ids()).toEqual([5]);
    emit([L(6)]);
    expect(ids()).toEqual([5, 6]);
  });

  it("an error after release is swallowed (no state change)", async () => {
    const sub = deferred<() => void>();
    ipc.onLogstreamLines.mockReturnValue(sub.promise);
    const release = startLogstream();
    release();
    sub.reject("late");
    await flush();
    expect(st().status).toBe("loading");
    expect(st().error).toBeNull();
  });

  it("retry tears down and reconnects; a no-op with no subscriber", async () => {
    retryLogstream();
    expect(ipc.onLogstreamLines).not.toHaveBeenCalled();
    ipc.logstreamSnapshot.mockRejectedValueOnce("down").mockResolvedValueOnce([L(1)]);
    startLogstream();
    await flush();
    expect(st().status).toBe("error");
    retryLogstream();
    expect(ipc.state.unlisten).toHaveBeenCalledTimes(1);
    expect(st()).toMatchObject({ status: "loading", error: null });
    await flush();
    expect(ipc.onLogstreamLines).toHaveBeenCalledTimes(2);
    expect(st().status).toBe("ready");
    expect(ids()).toEqual([1]);
  });
});

/* ───────────────────────── system apps ───────────────────────── */

describe("syslog status + apply", () => {
  it("refreshSyslogStatus stores the answer; a failure is surfaced and the last status kept", async () => {
    await st().refreshSyslogStatus();
    expect(st().syslog).toEqual(STATUS());
    ipc.syslogStatus.mockRejectedValueOnce("no log binary");
    await st().refreshSyslogStatus();
    expect(st().syslogError).toBe("Could not read the system log status: no log binary");
    expect(st().syslog).toEqual(STATUS());
    await st().refreshSyslogStatus();
    expect(st().syslogError).toBeNull();
  });

  it("setSyslogFilter is a no-op before the first status (nothing to merge over)", async () => {
    await st().setSyslogFilter({ enabled: true });
    expect(ipc.syslogSet).not.toHaveBeenCalled();
    expect(st().syslogPending).toBeNull();
  });

  it("merges the patch over the active filter, sends the WHOLE filter, and reflects the returned status", async () => {
    await st().refreshSyslogStatus();
    const d = deferred<SyslogStatus>();
    ipc.syslogSet.mockReturnValueOnce(d.promise);
    const p = st().setSyslogFilter({ enabled: true, apps: ["Appdemo2"] });
    expect(ipc.syslogSet).toHaveBeenCalledWith(FILTER({ enabled: true, apps: ["Appdemo2"] }));
    // In flight: the controls show what was sent.
    expect(st().syslogPending).toEqual(FILTER({ enabled: true, apps: ["Appdemo2"] }));
    d.resolve(STATUS({ running: true, linesPerSec: 12, filter: FILTER({ enabled: true, apps: ["Appdemo2"] }) }));
    await p;
    expect(st().syslogPending).toBeNull();
    expect(st().syslog).toMatchObject({ running: true, linesPerSec: 12 });
    expect(st().syslog?.filter.apps).toEqual(["Appdemo2"]);
  });

  it("two quick changes compose (the second merges over the first, not over the stale status)", async () => {
    await st().refreshSyslogStatus();
    const d1 = deferred<SyslogStatus>();
    const d2 = deferred<SyslogStatus>();
    ipc.syslogSet.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const p1 = st().setSyslogFilter({ enabled: true });
    const p2 = st().setSyslogFilter({ minLevel: "error" });
    expect(ipc.syslogSet).toHaveBeenLastCalledWith(FILTER({ enabled: true, minLevel: "error" }));
    // The FIRST answer lands: still pending (the second is in flight).
    d1.resolve(STATUS({ filter: FILTER({ enabled: true }) }));
    await p1;
    expect(st().syslogPending).toEqual(FILTER({ enabled: true, minLevel: "error" }));
    d2.resolve(STATUS({ filter: FILTER({ enabled: true, minLevel: "error" }) }));
    await p2;
    expect(st().syslogPending).toBeNull();
    expect(st().syslog?.filter.minLevel).toBe("error");
  });

  it("an apply answered AFTER a newer answer does not overwrite it (but still clears pending)", async () => {
    await st().refreshSyslogStatus();
    const set = deferred<SyslogStatus>();
    const poll = deferred<SyslogStatus>();
    ipc.syslogSet.mockReturnValueOnce(set.promise);
    ipc.syslogStatus.mockReturnValueOnce(poll.promise);
    const p = st().setSyslogFilter({ enabled: true });
    const q = st().refreshSyslogStatus(); // newer ticket
    poll.resolve(STATUS({ running: true, linesPerSec: 99, filter: FILTER({ enabled: true }) }));
    await q;
    set.resolve(STATUS({ running: false, linesPerSec: 0, filter: FILTER({ enabled: true }) }));
    await p;
    expect(st().syslog?.linesPerSec).toBe(99);
    expect(st().syslogPending).toBeNull();
  });

  it("a poll sent BEFORE an apply and answered after it is dropped (no snap-back)", async () => {
    await st().refreshSyslogStatus();
    const poll = deferred<SyslogStatus>();
    ipc.syslogStatus.mockReturnValueOnce(poll.promise);
    const q = st().refreshSyslogStatus();
    await st().setSyslogFilter({ enabled: true });
    expect(st().syslog?.filter.enabled).toBe(true);
    poll.resolve(STATUS()); // the old, disabled filter
    await q;
    expect(st().syslog?.filter.enabled).toBe(true);
  });

  it("a failed apply is surfaced, drops pending, keeps the status, and survives the next poll", async () => {
    await st().refreshSyslogStatus();
    ipc.syslogSet.mockRejectedValueOnce("predicate rejected");
    await st().setSyslogFilter({ enabled: true, subsystem: "com.x" });
    expect(st().applyError).toBe("Could not apply the log sources: predicate rejected");
    expect(st().syslogPending).toBeNull();
    expect(st().syslog?.filter.enabled).toBe(false);
    await st().refreshSyslogStatus();
    expect(st().applyError).toBe("Could not apply the log sources: predicate rejected");
    await st().setSyslogFilter({ enabled: true });
    expect(st().applyError).toBeNull();
  });

  it("an older apply's failure is superseded by a newer one in flight", async () => {
    await st().refreshSyslogStatus();
    const d1 = deferred<SyslogStatus>();
    const d2 = deferred<SyslogStatus>();
    ipc.syslogSet.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const p1 = st().setSyslogFilter({ enabled: true });
    const p2 = st().setSyslogFilter({ enabled: true, apps: ["A"] });
    d1.reject("old");
    await p1;
    expect(st().applyError).toBeNull();
    expect(st().syslogPending).toEqual(FILTER({ enabled: true, apps: ["A"] }));
    d2.resolve(STATUS({ filter: FILTER({ enabled: true, apps: ["A"] }) }));
    await p2;
    expect(st().syslogPending).toBeNull();
  });
});

describe("the All-apps volume notice", () => {
  it("shows once per app run when the filter becomes all apps; dismissable", async () => {
    await st().refreshSyslogStatus();
    await st().setSyslogFilter({ enabled: true }); // enabled with apps null = ALL
    expect(st().volumeNotice).toBe(true);
    st().dismissVolumeNotice();
    expect(st().volumeNotice).toBe(false);
    await st().setSyslogFilter({ apps: ["A"] });
    await st().setSyslogFilter({ apps: null }); // All again — already warned
    expect(st().volumeNotice).toBe(false);
  });

  it("does not show for a pick, for a change that stays all, or for disabling", async () => {
    ipc.syslogStatus.mockResolvedValue(STATUS({ filter: FILTER({ enabled: true, apps: null }) }));
    await st().refreshSyslogStatus();
    await st().setSyslogFilter({ minLevel: "error" }); // already all → no news
    expect(st().volumeNotice).toBe(false);
    await st().setSyslogFilter({ enabled: false });
    expect(st().volumeNotice).toBe(false);
    await st().setSyslogFilter({ apps: ["A"], enabled: true });
    expect(st().volumeNotice).toBe(false);
    await st().setSyslogFilter({ apps: null });
    expect(st().volumeNotice).toBe(true);
  });
});

describe("running apps", () => {
  it("refreshApps loads the list, flags loading, and surfaces a failure", async () => {
    const d = deferred<unknown[]>();
    ipc.syslogApps.mockReturnValueOnce(d.promise);
    const p = st().refreshApps();
    expect(st().appsLoading).toBe(true);
    d.resolve([{ name: "Xcode", pids: [1], path: null, isApp: true }]);
    await p;
    expect(st()).toMatchObject({ appsLoading: false, appsError: null });
    expect(st().apps.map((a) => a.name)).toEqual(["Xcode"]);

    ipc.syslogApps.mockRejectedValueOnce("ps failed");
    await st().refreshApps();
    expect(st()).toMatchObject({ appsLoading: false, appsError: "Could not list running apps: ps failed" });
    expect(st().apps.map((a) => a.name)).toEqual(["Xcode"]); // kept
    await st().refreshApps();
    expect(st().appsError).toBeNull();
  });
});

describe("the status poll", () => {
  afterEach(() => vi.useRealTimers());

  it("reads now, then every 2 s; the last release stops it; releases are idempotent", async () => {
    vi.useFakeTimers();
    const a = startSyslogPoll();
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(1);
    const b = startSyslogPoll(); // a second mount shares the timer
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(3);
    a();
    a(); // idempotent — must not release b's ref
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(4);
    b();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(4);
    expect(st().syslog).toEqual(STATUS());
    // A fresh start polls again.
    const c = startSyslogPoll();
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(5);
    c();
  });

  it("reset stops a live poll", async () => {
    vi.useFakeTimers();
    startSyslogPoll();
    resetAgentLogsForTests();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ipc.syslogStatus).toHaveBeenCalledTimes(1);
  });
});
