
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FlowDetail, FlowSummary, NetcapStatus } from "./networkTypes";

const ipc = vi.hoisted(() => ({
  netcapStatus: vi.fn(),
  netcapSet: vi.fn(),
  netcapSnapshot: vi.fn(),
  netcapFlow: vi.fn(),
  netcapClear: vi.fn(),
  listenFlows: vi.fn(),
  NETCAP_FLOW_EVENT: "netcap://flow",
}));
vi.mock("./netcapIpc", () => ipc);

import {
  allSidebarPicks,
  applyUpserts,
  clampNetSidebarWidth,
  onlySourcePick,
  setNetSidebarWidth,
  toggleSourcePick,
  clearFlows,
  closeDetail,
  ensureNetwork,
  FLOW_CAP,
  loadDetail,
  mergeFlow,
  openDetail,
  receiveBatch,
  refreshStatus,
  resetNetworkStore,
  selectFlow,
  setDetailTab,
  setFilter,
  setNetcap,
  setPaused,
  toggleChip,
  toggleDetailTab,
  useNetworkStore,
} from "./networkStore";

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id,
    startedMs: 1_700_000_000_000 + id,
    proto: "https",
    method: "GET",
    host: "example.com",
    port: 443,
    path: `/${id}`,
    status: 200,
    grpcStatus: null,
    contentType: "application/json",
    reqBytes: 0,
    resBytes: 10,
    durationMs: 12,
    state: "done",
    error: null,
    terminalId: null,
    httpVersion: "HTTP/1.1",
    wsMessages: null,
    client: null,
    note: null,
    ...o,
  };
}
const pending = (id: number, o: Partial<FlowSummary> = {}) =>
  flow(id, { state: "pending", status: null, durationMs: null, ...o });

const STATUS: NetcapStatus = {
  running: true,
  port: 5555,
  enabled: true,
  decrypt: false,
  caPath: null,
  skippedReason: null,
  passthroughHosts: [],
  flowCount: 0,
  decryptApps: [],
  portChanged: null,
};

let emit: (batch: FlowSummary[]) => void = () => {};
const unlisten = vi.fn();

beforeEach(() => {
  resetNetworkStore();
  vi.clearAllMocks();
  ipc.listenFlows.mockImplementation(async (h: (b: FlowSummary[]) => void) => {
    emit = h;
    return unlisten;
  });
  ipc.netcapStatus.mockResolvedValue(STATUS);
  ipc.netcapSnapshot.mockResolvedValue([]);
  ipc.netcapClear.mockResolvedValue(undefined);
});
afterEach(() => resetNetworkStore());

const ids = () => useNetworkStore.getState().flows.map((f) => f.id);

describe("applyUpserts (pure)", () => {
  it("appends new ids, replaces an existing id in place", () => {
    const out = applyUpserts([flow(1), pending(2)], [flow(2, { status: 201 }), flow(3)], 0);
    expect(out.map((f) => [f.id, f.status])).toEqual([
      [1, 200],
      [2, 201],
      [3, 200],
    ]);
  });

  it("inserts a late-arriving id in order", () => {
    expect(applyUpserts([flow(1), flow(4)], [flow(2), flow(3)], 0).map((f) => f.id)).toEqual([1, 2, 3, 4]);
  });

  it("caps at the ring size, dropping the oldest", () => {
    const out = applyUpserts([flow(1), flow(2), flow(3)], [flow(4), flow(5)], 0, 3);
    expect(out.map((f) => f.id)).toEqual([3, 4, 5]);
  });

  it("an update for an evicted id is not resurrected at a full ring", () => {
    expect(applyUpserts([flow(3), flow(4), flow(5)], [flow(1)], 0, 3).map((f) => f.id)).toEqual([3, 4, 5]);
    // ...but below the cap a late id still lands.
    expect(applyUpserts([flow(3), flow(4)], [flow(1)], 0, 3).map((f) => f.id)).toEqual([1, 3, 4]);
  });

  it("ignores ids at or below the clear watermark", () => {
    expect(applyUpserts([], [flow(1), flow(2), flow(3)], 2).map((f) => f.id)).toEqual([3]);
  });

  it("the default cap is 5 000", () => {
    expect(FLOW_CAP).toBe(5000);
    const many = Array.from({ length: 5003 }, (_, i) => flow(i + 1));
    const out = applyUpserts([], many, 0);
    expect(out).toHaveLength(5000);
    expect(out[0].id).toBe(4);
  });
});

describe("mergeFlow", () => {
  it("never regresses a finished flow back to pending", () => {
    const done = flow(1);
    expect(mergeFlow(done, pending(1))).toBe(done);
    expect(mergeFlow(flow(1, { state: "error" }), pending(1)).state).toBe("error");
    const later = flow(1, { status: 500 });
    expect(mergeFlow(pending(1), later)).toBe(later);
    expect(mergeFlow(undefined, later)).toBe(later);
    // Pending → pending (WS message counts moving) takes the newer value.
    const ws2 = pending(1, { wsMessages: { up: 2, down: 3 } });
    expect(mergeFlow(pending(1, { wsMessages: { up: 1, down: 1 } }), ws2)).toBe(ws2);
  });
});

describe("ensureNetwork", () => {
  it("listens BEFORE the snapshot, and replays what arrived in between", async () => {
    let resolveSnap: (v: FlowSummary[]) => void = () => {};
    ipc.netcapSnapshot.mockReturnValue(new Promise((r) => (resolveSnap = r)));
    const started = ensureNetwork();
    await vi.waitFor(() => expect(ipc.netcapSnapshot).toHaveBeenCalled());
    expect(ipc.listenFlows).toHaveBeenCalledTimes(1);
    // A flow that started after Rust took the snapshot, and a stale pending of one it holds.
    emit([flow(3), pending(2)]);
    expect(ids()).toEqual([]); // buffered, not applied
    resolveSnap([flow(1), flow(2, { status: 204 })]);
    await started;
    const s = useNetworkStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.flows.map((f) => [f.id, f.state, f.status])).toEqual([
      [1, "done", 200],
      [2, "done", 204],
      [3, "done", 200],
    ]);
    expect(s.status).toEqual(STATUS);
    // Live now: events apply directly.
    emit([flow(4)]);
    expect(ids()).toEqual([1, 2, 3, 4]);
  });

  it("is idempotent across remounts", async () => {
    await Promise.all([ensureNetwork(), ensureNetwork()]);
    await ensureNetwork();
    expect(ipc.listenFlows).toHaveBeenCalledTimes(1);
    expect(ipc.netcapSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a failed snapshot still keeps the live stream, and says so", async () => {
    ipc.netcapSnapshot.mockRejectedValue(new Error("boom"));
    await ensureNetwork();
    expect(useNetworkStore.getState()).toMatchObject({ loaded: true, loadError: "boom" });
    emit([flow(1)]);
    expect(ids()).toEqual([1]);
  });

  it("a failed listen is not sticky — the next mount retries", async () => {
    ipc.listenFlows.mockRejectedValueOnce("no event plugin");
    await ensureNetwork();
    expect(useNetworkStore.getState().loadError).toBe("no event plugin");
    await ensureNetwork();
    expect(ipc.listenFlows).toHaveBeenCalledTimes(2);
    expect(ipc.netcapSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reset unsubscribes", async () => {
    await ensureNetwork();
    resetNetworkStore();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("live upserts", () => {
  it("pending → done updates the row in place (no duplicate)", () => {
    receiveBatch([pending(1), pending(2)]);
    receiveBatch([flow(1, { status: 502, durationMs: 30000 })]);
    const f = useNetworkStore.getState().flows;
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ id: 1, state: "done", status: 502, durationMs: 30000 });
    expect(f[1]).toMatchObject({ id: 2, state: "pending" });
  });

  it("evicting the selected flow drops the selection and closes the detail", () => {
    const many = Array.from({ length: FLOW_CAP }, (_, i) => flow(i + 1));
    receiveBatch(many);
    ipc.netcapFlow.mockResolvedValue({});
    openDetail(1);
    receiveBatch([flow(FLOW_CAP + 1)]);
    expect(useNetworkStore.getState()).toMatchObject({ selectedId: null, detailOpen: false, detail: null });
  });

  it("keeps the selection when its row survives", () => {
    receiveBatch([flow(1)]);
    selectFlow(1);
    receiveBatch([flow(2)]);
    expect(useNetworkStore.getState().selectedId).toBe(1);
  });
});

describe("pause", () => {
  it("buffers without rendering, then applies on resume (latest per id)", () => {
    receiveBatch([flow(1)]);
    setPaused(true);
    setPaused(true); // idempotent
    receiveBatch([pending(2)]);
    receiveBatch([flow(2, { status: 201 }), flow(3)]);
    receiveBatch([pending(3)]); // stale — must not regress the buffered done
    expect(ids()).toEqual([1]);
    expect(useNetworkStore.getState().buffered.size).toBe(2);
    setPaused(false);
    const s = useNetworkStore.getState();
    expect(s.paused).toBe(false);
    expect(s.buffered.size).toBe(0);
    expect(s.flows.map((f) => [f.id, f.state, f.status])).toEqual([
      [1, "done", 200],
      [2, "done", 201],
      [3, "done", 200],
    ]);
    setPaused(false); // no-op
    expect(ids()).toEqual([1, 2, 3]);
  });
});

describe("clear", () => {
  it("calls netcap_clear, empties everything, and ignores late completions of cleared flows", async () => {
    receiveBatch([flow(1), pending(2)]);
    setPaused(true);
    receiveBatch([pending(3)]);
    selectFlow(1);
    await clearFlows();
    expect(ipc.netcapClear).toHaveBeenCalledTimes(1);
    const s = useNetworkStore.getState();
    expect(s).toMatchObject({ flows: [], selectedId: null, detailOpen: false, clearedThrough: 3 });
    expect(s.buffered.size).toBe(0);
    receiveBatch([flow(2), flow(3)]); // in flight at Clear time — must not come back
    expect(useNetworkStore.getState().buffered.size).toBe(0);
    setPaused(false);
    receiveBatch([flow(2), flow(4)]);
    expect(ids()).toEqual([4]);
  });

  it("watermark takes the highest of flows, buffer and previous watermark", async () => {
    receiveBatch([flow(5), flow(7)]);
    setPaused(true);
    receiveBatch([flow(5, { status: 500 })]); // buffered, but below the table's max
    await clearFlows();
    expect(useNetworkStore.getState().clearedThrough).toBe(7);
    setPaused(false);
    receiveBatch([flow(7)]);
    await clearFlows();
    await clearFlows(); // nothing left: watermark holds, never goes back
    expect(useNetworkStore.getState().clearedThrough).toBe(7);
  });

  it("a failed clear keeps the flows and says why", async () => {
    receiveBatch([flow(1)]);
    ipc.netcapClear.mockRejectedValue(new Error("nope"));
    await clearFlows();
    expect(ids()).toEqual([1]);
    expect(useNetworkStore.getState().clearError).toBe("nope");
  });
});

describe("status + toggles", () => {
  it("setNetcap passes the patch and shows what Rust RETURNED", async () => {
    ipc.netcapSet.mockResolvedValue({ ...STATUS, decrypt: false, skippedReason: "HTTPS_PROXY already set" });
    const p = setNetcap({ decrypt: true });
    expect(useNetworkStore.getState().setting).toBe(true);
    await p;
    expect(ipc.netcapSet).toHaveBeenCalledWith({ decrypt: true });
    expect(useNetworkStore.getState()).toMatchObject({
      setting: false,
      status: { decrypt: false, skippedReason: "HTTPS_PROXY already set" },
    });
  });

  it("a failed toggle surfaces the error and settles", async () => {
    ipc.netcapSet.mockRejectedValue(new Error("denied"));
    await setNetcap({ enabled: false });
    expect(useNetworkStore.getState()).toMatchObject({ setting: false, statusError: "denied" });
  });

  it("refreshStatus success and failure", async () => {
    ipc.netcapStatus.mockRejectedValueOnce(new Error("down"));
    await refreshStatus();
    expect(useNetworkStore.getState().statusError).toBe("down");
    await refreshStatus();
    expect(useNetworkStore.getState()).toMatchObject({ statusError: null, status: STATUS });
  });
});

describe("filter, chips, detail tab", () => {
  it("set/toggle", () => {
    setFilter("status:5xx");
    toggleChip("grpc");
    toggleChip("ws");
    toggleChip("grpc");
    setDetailTab("request");
    toggleDetailTab();
    expect(useNetworkStore.getState()).toMatchObject({ filter: "status:5xx", chips: ["ws"], detailTab: "response" });
    toggleDetailTab();
    expect(useNetworkStore.getState().detailTab).toBe("request");
  });
});

describe("detail", () => {
  const detailOf = (f: FlowSummary): FlowDetail => ({
    summary: f,
    requestHeaders: [],
    responseHeaders: [],
    responseTrailers: [],
    requestBody: null,
    responseBody: null,
  });

  it("openDetail fetches netcap_flow(id) and caches per id+state", async () => {
    receiveBatch([pending(1)]);
    ipc.netcapFlow.mockImplementation(async (id: number) => detailOf(flow(id)));
    openDetail(1);
    expect(useNetworkStore.getState()).toMatchObject({ detailOpen: true, selectedId: 1, detail: { id: 1, loading: true } });
    await vi.waitFor(() => expect(useNetworkStore.getState().detail?.loading).toBe(false));
    await loadDetail(1); // same state: cached
    expect(ipc.netcapFlow).toHaveBeenCalledTimes(1);
    receiveBatch([flow(1)]); // completed: refetch
    await loadDetail(1);
    expect(ipc.netcapFlow).toHaveBeenCalledTimes(2);
    expect(ipc.netcapFlow).toHaveBeenLastCalledWith(1);
  });

  it("selecting another row while the detail is open fetches that one; closed, it does not", async () => {
    receiveBatch([flow(1), flow(2), flow(3)]);
    ipc.netcapFlow.mockImplementation(async (id: number) => detailOf(flow(id)));
    selectFlow(1);
    expect(ipc.netcapFlow).not.toHaveBeenCalled();
    openDetail(1);
    selectFlow(2);
    await vi.waitFor(() => expect(useNetworkStore.getState().detail).toMatchObject({ id: 2, loading: false }));
    expect(ipc.netcapFlow.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    closeDetail();
    selectFlow(3);
    selectFlow(null);
    expect(ipc.netcapFlow).toHaveBeenCalledTimes(2);
    expect(useNetworkStore.getState().detailOpen).toBe(false);
  });

  it("a response for a flow the user moved off is discarded", async () => {
    receiveBatch([flow(1), flow(2)]);
    let finish1: (d: FlowDetail) => void = () => {};
    ipc.netcapFlow.mockImplementationOnce(() => new Promise((r) => (finish1 = r)));
    ipc.netcapFlow.mockImplementationOnce(async () => detailOf(flow(2)));
    openDetail(1);
    openDetail(2);
    await vi.waitFor(() => expect(useNetworkStore.getState().detail?.loading).toBe(false));
    finish1(detailOf(flow(1)));
    await Promise.resolve();
    expect(useNetworkStore.getState().detail).toMatchObject({ id: 2 });
  });

  it("a rejected fetch is shown, is not cached, and a stale rejection is discarded", async () => {
    receiveBatch([flow(1), flow(2)]);
    ipc.netcapFlow.mockRejectedValueOnce(new Error("not-found"));
    await loadDetail(1);
    expect(useNetworkStore.getState().detail).toMatchObject({ id: 1, error: "not-found", loading: false });
    ipc.netcapFlow.mockResolvedValueOnce(detailOf(flow(1)));
    await loadDetail(1); // an error is retried
    expect(useNetworkStore.getState().detail).toMatchObject({ id: 1, error: null });

    let fail2: (e: unknown) => void = () => {};
    ipc.netcapFlow.mockImplementationOnce(() => new Promise((_r, j) => (fail2 = j)));
    ipc.netcapFlow.mockResolvedValueOnce(detailOf(flow(1)));
    const p = loadDetail(2);
    await loadDetail(1);
    fail2(new Error("late"));
    await p;
    expect(useNetworkStore.getState().detail).toMatchObject({ id: 1, error: null });
  });

  it("an id with no row (evicted) still fetches", async () => {
    ipc.netcapFlow.mockResolvedValue(detailOf(flow(9)));
    await loadDetail(9);
    expect(useNetworkStore.getState().detail).toMatchObject({ id: 9, forState: "done", loading: false });
  });
});

describe("the sidebar's source picks and width", () => {
  it("a source checkbox adds and removes keys; removing the last is every source (null)", () => {
    toggleSourcePick("t:a");
    toggleSourcePick("t:b");
    expect(useNetworkStore.getState().sourceSelection).toEqual(["t:a", "t:b"]);
    toggleSourcePick("t:a");
    expect(useNetworkStore.getState().sourceSelection).toEqual(["t:b"]);
    toggleSourcePick("t:b");
    expect(useNetworkStore.getState().sourceSelection).toBeNull();
  });

  it("Only replaces the pick; All clears the app AND the source picks, not the others", () => {
    useNetworkStore.setState({ sourceSelection: ["t:a", "t:b"], hostSelection: ["h"], appSelection: [{ key: "k", pid: 1, name: "n", process: null }] });
    onlySourcePick("t:c");
    expect(useNetworkStore.getState().sourceSelection).toEqual(["t:c"]);
    allSidebarPicks();
    const s = useNetworkStore.getState();
    expect([s.sourceSelection, s.appSelection, s.hostSelection]).toEqual([null, null, ["h"]]);
  });

  it("the width defaults to 280 and is clamped to 180–560, rounded", () => {
    expect(useNetworkStore.getState().sidebarWidth).toBe(280);
    expect([clampNetSidebarWidth(10), clampNetSidebarWidth(999), clampNetSidebarWidth(300.6)]).toEqual([180, 560, 301]);
    setNetSidebarWidth(1000);
    expect(useNetworkStore.getState().sidebarWidth).toBe(560);
  });
});
