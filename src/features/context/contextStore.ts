/** One /context reading per root agent, in its own store. No timer (each read spawns the CLI): read
 * on mount/selection, on refresh, and on the edge INTO idle. A failed refresh keeps the last good
 * data; reads are single-flight per agent, so a stale response can't land over a newer one. */

import { create } from "zustand";

import type { AgentStatus } from "../../app/types";
import { contextUsage, parseContextError, type ContextError } from "./contextIpc";
import type { ContextUsage } from "./contextTypes";

/** One agent's reading. */
export interface ContextEntry {
  /** Last SUCCESSFUL reading — kept across a failed refresh. `null` until the first. */
  data: ContextUsage | null;
  /** Code of the most recent failure; cleared by the next success. */
  error: ContextError | null;
  /** True while a read is in flight — drives the ↻ button's spinner. */
  loading: boolean;
}

/** Which drawing the card shows. One choice for every agent, so it is not per entry. */
export type ContextView = "bar" | "grid";

export interface ContextStoreState {
  entries: Record<string, ContextEntry>;
  /** In the store: the card unmounts when its tab is hidden, and the toggle must not snap back. */
  view: ContextView;
  /** Reads now, or joins the running read for that agent. Never throws: failures land in error. */
  refresh: (agentId: string) => Promise<void>;
  setView: (view: ContextView) => void;
}

const EMPTY: ContextEntry = { data: null, error: null, loading: false };

export const useContextStore = create<ContextStoreState>()((set) => ({
  entries: {},
  view: "bar",
  // A hoisted declaration, so its identity is stable and safe in a dep array.
  refresh: refreshContext,
  setView: (view) => set({ view }),
}));

/** The outstanding read per agent — the single-flight gate (rule 2). */
const inFlight = new Map<string, Promise<void>>();

/** Merge a patch into one agent's entry, creating it if this is the first read. */
function patchEntry(agentId: string, patch: Partial<ContextEntry>): void {
  useContextStore.setState((s) => ({
    entries: { ...s.entries, [agentId]: { ...(s.entries[agentId] ?? EMPTY), ...patch } },
  }));
}

/** Never rejects, so callers can fire-and-forget. */
async function readOnce(agentId: string): Promise<void> {
  try {
    const data = await contextUsage(agentId);
    patchEntry(agentId, { data, error: null, loading: false });
  } catch (reason) {
    // `data` is absent from this patch on purpose (rule 1). The raw rejection is
    // classified and dropped: its detail can carry CLI output, which is never rendered.
    patchEntry(agentId, { error: parseContextError(reason), loading: false });
  }
}

function refreshContext(agentId: string): Promise<void> {
  const running = inFlight.get(agentId);
  if (running) return running;
  patchEntry(agentId, { loading: true });
  // `inFlight` is set synchronously before this function returns, so no second caller
  // can observe an empty slot while a read is outstanding.
  const pending = readOnce(agentId).finally(() => inFlight.delete(agentId));
  inFlight.set(agentId, pending);
  return pending;
}

/** The status each agent was last seen in, for edge detection. */
const lastStatus = new Map<string, AgentStatus>();

/** An EDGE into idle, not a level (that would be polling); the first sighting only records status.
 * waiting_input is mid-turn and done/error have no process left, so only idle triggers a read. */
export function noteAgentStatus(agentId: string, status: AgentStatus): void {
  const prev = lastStatus.get(agentId);
  lastStatus.set(agentId, status);
  if (prev !== undefined && prev !== "idle" && status === "idle") {
    void refreshContext(agentId);
  }
}

/** Tests only: clears module-scope plumbing too, so no edge or in-flight read leaks. */
export function resetContextStore(): void {
  inFlight.clear();
  lastStatus.clear();
  useContextStore.setState({ entries: {}, view: "bar" });
}
