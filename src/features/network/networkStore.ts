/**
 * The NETWORK store — the flow table's live mirror of Rust's capture ring.
 *
 * Its own `create(...)`, not the app store. Everything the panel shows lives
 * here rather than in component state — selection, filter, chips, the open detail and its
 * tab — because the panel is a TAB and tabs remount on every switch and move.
 *
 * ── Ordering: listen FIRST, buffer, snapshot, then flush (bridge.ts's pattern) ──
 * Snapshot-then-listen drops every flow that starts in the gap. So `ensureNetwork` listens
 * first, buffers batches until the snapshot lands, installs the snapshot, then replays the
 * buffer through the same upsert. A buffered batch may be OLDER than the snapshot (emitted
 * before Rust took it, delivered after), so the upsert never regresses a finished flow back
 * to pending — see {@link mergeFlow}.
 *
 * ── Flows are kept sorted by id (monotonic per run) ──
 * New flows are almost always the largest id, so the common upsert is an O(1) push; an
 * update of an existing flow is a binary search. At {@link FLOW_CAP} the oldest fall off
 * the front, and an update for an id already evicted is dropped rather than resurrected.
 *
 * ── Clear sets a watermark ──
 * A flow still in flight when the user pressed Clear completes afterwards, and its `done`
 * upsert would otherwise bring a row back into a table the user just emptied. Ids at or
 * below the highest id seen at Clear time are ignored from then on.
 */

import { create } from "zustand";

import { listenFlows, netcapClear, netcapFlow, netcapSet, netcapSetAppDecrypt, netcapSnapshot, netcapStatus } from "./netcapIpc";
import type { AppPick } from "./networkApps";
import type { ProtoChip } from "./networkFilter";
import type { FlowDetail, FlowSummary, NetcapPatch, NetcapStatus } from "./networkTypes";

/** Mirrors Rust's ring. */
export const FLOW_CAP = 5000;

export type DetailTab = "request" | "response";

/** Which traffic the panel shows: the IDE's own proxy, or every app on the machine. */
export type NetworkMode = "ide" | "machine";

export interface DetailState {
  id: number;
  /** The summary `state` the detail was fetched for — a change refetches. */
  forState: FlowSummary["state"];
  loading: boolean;
  detail: FlowDetail | null;
  error: string | null;
}

export interface NetworkState {
  flows: FlowSummary[];
  /** Snapshot landed at least once. */
  loaded: boolean;
  loadError: string | null;
  status: NetcapStatus | null;
  statusError: string | null;
  /** A toggle round-trip is in flight. */
  setting: boolean;
  paused: boolean;
  /** Upserts that arrived while paused, latest per id, in arrival order. */
  buffered: Map<number, FlowSummary>;
  /** Ids ≤ this are ignored (see "Clear sets a watermark"). */
  clearedThrough: number;
  selectedId: number | null;
  filter: string;
  chips: ProtoChip[];
  detailOpen: boolean;
  detailTab: DetailTab;
  detail: DetailState | null;
  clearError: string | null;
  /** Kept here so a tab switch or move returns to the same mode. */
  mode: NetworkMode;
  /** Source keys (`sourceKey` — terminal ids); null = every source (AppPicker's contract). */
  sourceSelection: string[] | null;
  /** Process keys (`processKey` — client names); null = every process. */
  processSelection: string[] | null;
  /** Host keys (`hostKey` — host names); null = every host. */
  hostSelection: string[] | null;
  /** Mask credential header values on screen (display only; exports stay real). Off by default. */
  maskSecrets: boolean;
  /**
   * "Hide AI providers": an agent CLI's own requests to AI providers leave the table
   * (`isAiProviderCall`). On by default — with many agents they are most of the traffic.
   * Display only: the ring, exports and counts keep them.
   */
  hideAiProviders: boolean;
  /**
   * The Apps sidebar's picks (`networkApps` — snapshots, so an exited app's flows stay
   * pickable); null = "All apps" (no app filter). Never empty: unchecking the last is All.
   */
  appSelection: AppPick[] | null;
  /** The IDE-traffic sidebar's width in px (dragged by its edge; {@link clampNetSidebarWidth}). */
  sidebarWidth: number;
  /**
   * The last title each terminal id had (`terminalTitles.ts`) — a CLOSED terminal's flows are
   * labelled with it. Replaced (never mutated) on change, so selectors see a new reference.
   */
  terminalTitles: ReadonlyMap<string, string>;
}

/** The Network sidebar's width — the Logs sidebar's numbers (`agentLogsStore`), so the two read alike. */
export const NET_SIDEBAR_DEFAULT_WIDTH = 280;
export const NET_SIDEBAR_MIN_WIDTH = 180;
export const NET_SIDEBAR_MAX_WIDTH = 560;

export function clampNetSidebarWidth(w: number): number {
  return Math.round(Math.min(NET_SIDEBAR_MAX_WIDTH, Math.max(NET_SIDEBAR_MIN_WIDTH, w)));
}

const initial = (): NetworkState => ({
  flows: [],
  loaded: false,
  loadError: null,
  status: null,
  statusError: null,
  setting: false,
  paused: false,
  buffered: new Map(),
  clearedThrough: 0,
  selectedId: null,
  filter: "",
  chips: [],
  detailOpen: false,
  detailTab: "response",
  detail: null,
  clearError: null,
  mode: "ide",
  sourceSelection: null,
  processSelection: null,
  hostSelection: null,
  maskSecrets: false,
  hideAiProviders: true,
  appSelection: null,
  sidebarWidth: NET_SIDEBAR_DEFAULT_WIDTH,
  terminalTitles: new Map(),
});

export const useNetworkStore = create<NetworkState>()(initial);

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Merge one upsert into the existing row. The incoming value wins — it is newer — except
 * that a finished flow never goes back to pending (an out-of-order replay; see header).
 */
export function mergeFlow(prev: FlowSummary | undefined, next: FlowSummary): FlowSummary {
  if (prev && prev.state !== "pending" && next.state === "pending") return prev;
  return next;
}

/** Binary search on the id-sorted array: index of `id`, or the insertion point as `~index`. */
function locate(flows: readonly FlowSummary[], id: number): number {
  let lo = 0;
  let hi = flows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = flows[mid].id;
    if (at === id) return mid;
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return ~lo;
}

/** Pure: apply a batch of upserts to an id-sorted array, honouring the cap and watermark. */
export function applyUpserts(
  flows: readonly FlowSummary[],
  batch: readonly FlowSummary[],
  clearedThrough: number,
  cap: number = FLOW_CAP,
): FlowSummary[] {
  const out = flows.slice();
  for (const f of batch) {
    if (f.id <= clearedThrough) continue;
    const last = out[out.length - 1];
    if (!last || f.id > last.id) {
      out.push(f);
      continue;
    }
    const at = locate(out, f.id);
    if (at >= 0) {
      out[at] = mergeFlow(out[at], f);
    } else if (out.length < cap || ~at > 0) {
      // A late-arriving new id: insert in order — unless the ring is full and it would be
      // the OLDEST row, i.e. it is already evicted.
      out.splice(~at, 0, f);
    }
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

function highestId(s: NetworkState): number {
  let max = s.clearedThrough;
  const last = s.flows[s.flows.length - 1];
  if (last && last.id > max) max = last.id;
  for (const id of s.buffered.keys()) if (id > max) max = id;
  return max;
}

/** Apply (or, while paused, buffer) one event batch. Exported for the listener and tests. */
export function receiveBatch(batch: readonly FlowSummary[]): void {
  useNetworkStore.setState((s) => {
    if (s.paused) {
      const buffered = new Map(s.buffered);
      for (const f of batch) {
        if (f.id <= s.clearedThrough) continue;
        buffered.set(f.id, mergeFlow(buffered.get(f.id), f));
      }
      return { buffered };
    }
    return withFlows(s, applyUpserts(s.flows, batch, s.clearedThrough));
  });
}

/** Install new flows; drop the selection (and detail) if its row was evicted. */
function withFlows(s: NetworkState, flows: FlowSummary[]): Partial<NetworkState> {
  if (s.selectedId !== null && locate(flows, s.selectedId) < 0) {
    return { flows, selectedId: null, detailOpen: false, detail: null };
  }
  return { flows };
}

/* ── lifecycle ─────────────────────────────────────────────────────────────── */

let started: Promise<void> | null = null;
let unlisten: (() => void) | null = null;

/**
 * Start the subscription (idempotent — the tab remounts on every switch). Once running it
 * keeps running for the app's life, so a background tab is complete when you come back.
 * A FAILED start is not sticky: the next mount tries again.
 */
export function ensureNetwork(): Promise<void> {
  if (started) return started;
  started = start().catch((e: unknown) => {
    started = null;
    useNetworkStore.setState({ loadError: msg(e) });
  });
  return started;
}

async function start(): Promise<void> {
  let ready = false;
  const early: FlowSummary[][] = [];
  unlisten = await listenFlows((batch) => {
    if (ready) receiveBatch(batch);
    else early.push(batch);
  });
  void refreshStatus();
  try {
    const snapshot = await netcapSnapshot();
    useNetworkStore.setState((s) => ({
      ...withFlows(s, applyUpserts([], snapshot, s.clearedThrough)),
      loaded: true,
      loadError: null,
    }));
  } catch (e) {
    // Live events still describe usable traffic; say the history is missing, keep going.
    useNetworkStore.setState({ loaded: true, loadError: msg(e) });
  } finally {
    ready = true;
    for (const batch of early) receiveBatch(batch);
  }
}

export async function refreshStatus(): Promise<void> {
  try {
    const status = await netcapStatus();
    useNetworkStore.setState({ status, statusError: null });
  } catch (e) {
    useNetworkStore.setState({ statusError: msg(e) });
  }
}

/** Flip capture or decrypt; the panel shows what Rust RETURNS, never what was asked. */
export async function setNetcap(patch: NetcapPatch): Promise<void> {
  useNetworkStore.setState({ setting: true });
  try {
    const status = await netcapSet(patch);
    useNetworkStore.setState({ status, statusError: null, setting: false });
  } catch (e) {
    useNetworkStore.setState({ statusError: msg(e), setting: false });
  }
}

/**
 * Opt one app in or out of HTTPS decryption from its capture guide. Same
 * rule as {@link setNetcap}: the switch reflects the `decryptApps` Rust RETURNS.
 */
export async function setAppDecrypt(app: string, on: boolean): Promise<void> {
  useNetworkStore.setState({ setting: true });
  try {
    const status = await netcapSetAppDecrypt(app, on);
    useNetworkStore.setState({ status, statusError: null, setting: false });
  } catch (e) {
    useNetworkStore.setState({ statusError: msg(e), setting: false });
  }
}

/**
 * The tunnel card's "Decrypt this app": the per-app opt-in only matters
 * while Decrypt HTTPS is on, so turning an app ON also turns Decrypt HTTPS on first (one click,
 * not a hunt for the second switch). Turning it off leaves Decrypt HTTPS alone. A failed first
 * step stops there — the error is shown, the app is not opted in behind it.
 */
export async function decryptAppFromTunnel(app: string, on: boolean): Promise<void> {
  if (on && useNetworkStore.getState().status?.decrypt !== true) {
    await setNetcap({ decrypt: true });
    if (useNetworkStore.getState().status?.decrypt !== true) return;
  }
  await setAppDecrypt(app, on);
}

/**
 * The capture guide's "show them": IDE traffic, every other narrowing undone,
 * the Process picker on exactly the client names that were routed from the app — so the
 * link can never land on a table that a leftover pick hides.
 */
export function showAppFlows(processNames: string[]): void {
  showAllFlows();
  useNetworkStore.setState({ mode: "ide", processSelection: processNames });
}

/* ── table actions ─────────────────────────────────────────────────────────── */

export function setPaused(paused: boolean): void {
  useNetworkStore.setState((s) => {
    if (paused === s.paused) return {};
    if (paused) return { paused: true };
    const flows = applyUpserts(s.flows, [...s.buffered.values()], s.clearedThrough);
    return { ...withFlows(s, flows), paused: false, buffered: new Map() };
  });
}

export async function clearFlows(): Promise<void> {
  try {
    await netcapClear();
  } catch (e) {
    useNetworkStore.setState({ clearError: msg(e) });
    return;
  }
  useNetworkStore.setState((s) => ({
    flows: [],
    buffered: new Map(),
    clearedThrough: highestId(s),
    selectedId: null,
    detailOpen: false,
    detail: null,
    clearError: null,
  }));
}

export function setNetworkMode(mode: NetworkMode): void {
  useNetworkStore.setState({ mode });
}

export function setSourceSelection(sourceSelection: string[] | null): void {
  useNetworkStore.setState({ sourceSelection });
}

export function setProcessSelection(processSelection: string[] | null): void {
  useNetworkStore.setState({ processSelection });
}

/* ── the Apps sidebar (networkApps) ────────────────────────────────────────── */

/** A row's checkbox: add or remove this app; removing the last pick is "All apps". */
export function toggleAppPick(pick: AppPick): void {
  useNetworkStore.setState((s) => {
    const cur = s.appSelection ?? [];
    const next = cur.some((p) => p.key === pick.key) ? cur.filter((p) => p.key !== pick.key) : [...cur, pick];
    return { appSelection: next.length === 0 ? null : next };
  });
}

/** A row's click: only this app. */
export function onlyAppPick(pick: AppPick): void {
  useNetworkStore.setState({ appSelection: [pick] });
}

/** "All apps": no app filter. */
export function allAppPicks(): void {
  useNetworkStore.setState({ appSelection: null });
}

/* ── the sidebar's Terminals / Agents / Other rows (they ARE the Source picker's selection) ── */

/**
 * A source row's checkbox: add or remove that source key; removing the last = every source
 * (null), so the toolbar's Source picker reads "All sources" again rather than "No sources".
 */
export function toggleSourcePick(key: string): void {
  useNetworkStore.setState((s) => {
    const cur = s.sourceSelection ?? [];
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    return { sourceSelection: next.length === 0 ? null : next };
  });
}

/** A source row's click: only that source. */
export function onlySourcePick(key: string): void {
  useNetworkStore.setState({ sourceSelection: [key] });
}

/** The sidebar's top "All": no app and no source narrowing (the other pickers are the toolbar's). */
export function allSidebarPicks(): void {
  useNetworkStore.setState({ appSelection: null, sourceSelection: null });
}

export function setNetSidebarWidth(w: number): void {
  useNetworkStore.setState({ sidebarWidth: clampNetSidebarWidth(w) });
}

export function setHostSelection(hostSelection: string[] | null): void {
  useNetworkStore.setState({ hostSelection });
}

export function setMaskSecrets(maskSecrets: boolean): void {
  useNetworkStore.setState({ maskSecrets });
}

export function setHideAiProviders(hideAiProviders: boolean): void {
  useNetworkStore.setState({ hideAiProviders });
}

export function setFilter(filter: string): void {
  useNetworkStore.setState({ filter });
}

/** Undo every control that narrows the table: filter text, proto chips, source, process and host picks, "Hide AI providers". */
export function showAllFlows(): void {
  useNetworkStore.setState({
    filter: "",
    chips: [],
    sourceSelection: null,
    processSelection: null,
    hostSelection: null,
    appSelection: null,
    hideAiProviders: false,
  });
}

export function toggleChip(chip: ProtoChip): void {
  useNetworkStore.setState((s) => ({
    chips: s.chips.includes(chip) ? s.chips.filter((c) => c !== chip) : [...s.chips, chip],
  }));
}

export function selectFlow(id: number | null): void {
  useNetworkStore.setState({ selectedId: id });
  if (useNetworkStore.getState().detailOpen && id !== null) void loadDetail(id);
}

export function openDetail(id: number): void {
  useNetworkStore.setState({ selectedId: id, detailOpen: true });
  void loadDetail(id);
}

export function closeDetail(): void {
  useNetworkStore.setState({ detailOpen: false });
}

export function setDetailTab(tab: DetailTab): void {
  useNetworkStore.setState({ detailTab: tab });
}

export function toggleDetailTab(): void {
  useNetworkStore.setState((s) => ({ detailTab: s.detailTab === "request" ? "response" : "request" }));
}

/**
 * Fetch one flow's detail, unless the cached one is for the same id AND the same state
 * (a pending flow that completed has headers/bodies it did not have before). A response
 * for a flow the user has since moved off is discarded.
 */
export async function loadDetail(id: number): Promise<void> {
  const s = useNetworkStore.getState();
  const summary = s.flows[locate(s.flows, id)] as FlowSummary | undefined;
  const forState = summary?.state ?? "done";
  const cached = s.detail;
  if (cached && cached.id === id && cached.forState === forState && !cached.error) return;
  useNetworkStore.setState({ detail: { id, forState, loading: true, detail: cached?.id === id ? cached.detail : null, error: null } });
  try {
    const detail = await netcapFlow(id);
    if (useNetworkStore.getState().detail?.id !== id) return;
    useNetworkStore.setState({ detail: { id, forState, loading: false, detail, error: null } });
  } catch (e) {
    if (useNetworkStore.getState().detail?.id !== id) return;
    useNetworkStore.setState({ detail: { id, forState, loading: false, detail: null, error: msg(e) } });
  }
}

/** Test seam: forget everything, including the running subscription. */
export function resetNetworkStore(): void {
  unlisten?.();
  unlisten = null;
  started = null;
  useNetworkStore.setState(initial(), true);
}
