/**
 * The CONTEXT-WINDOW store — one `/context` reading per root agent, fetched on
 * demand.
 *
 * Its OWN `create(...)`, not the main app store, for the reason `usageStore.ts` gives:
 * a feature-local async cache has nothing to do with the pane-tree
 * reducers, and must never contend for `src/app/store.ts`.
 *
 * ── What is deliberately different from `usageStore` ─────────────────────────
 *
 * **No timer.** Usage is one account-wide reading worth a 5 s poll; this is one reading
 * PER AGENT, and each one spawns `claude -p --resume … "/context"` (~1–3 s of CPU). A
 * fixed-interval poll would pay that cost forever for a number that only moves when the
 * agent finishes a turn. So a reading is taken only when something can have changed it:
 *   - the card mounts or the selection moves to another agent (the card calls
 *     {@link ContextStoreState.refresh});
 *   - the user presses ↻ (same call);
 *   - that agent's status transitions INTO `idle` — its turn just ended, so its context
 *     just grew ({@link noteAgentStatus}).
 *
 * **Keyed by agent id.** Switching between two agents must not blank the card while the
 * second reading loads, and switching back must show the first agent's numbers at once.
 * So readings live in `entries[agentId]`, and every rule below is per key. (The key is the
 * agent id, not a session id: Rust resolves the session itself and the session id
 * never crosses the wire.)
 *
 * ── The rules that are the same, and why ─────────────────────────────────────
 *
 * 1. **A failed refresh never blanks the card.** `data` keeps the last SUCCESSFUL
 *    reading; `error` rides alongside it. Stale-but-true beats nothing.
 *
 * 2. **Single-flight, per agent.** A mount, a ↻ click and an idle transition can all
 *    land in the same tick (selecting an agent the moment its turn ends does exactly
 *    that). They must collapse into ONE process spawn. A second `refresh()` for a
 *    agent that is already being read awaits the outstanding promise instead of
 *    starting another, so `await refresh()` still means "the numbers are fresh".
 *    Because at most one request per agent exists at a time, an older response can
 *    never land on top of a newer one for the same agent — there is no second
 *    response to be stale relative to (`usageStore.ts` requirement 2, same argument).
 *
 * Side effects live in module scope, not in the store: the in-flight map
 * and the last-seen statuses are plumbing the UI never renders.
 */

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
  /**
   * Bar or Grid. Kept in the store rather than in the card's `useState` because the
   * card unmounts whenever its tab is hidden, and a toggle that silently snaps back to
   * Bar every time you look away is a toggle that does not work.
   */
  view: ContextView;
  /**
   * Read `agentId`'s context now, or join the read already running for it. Never
   * throws: a failure lands in that entry's `error`.
   */
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

/**
 * Read once and fold the outcome into the entry. Resolves either way and never
 * rejects, so every call site can fire-and-forget.
 */
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

/**
 * Tell the store what status agent `agentId` is in; re-read its context when the
 * agent has just gone IDLE.
 *
 * An EDGE, not a level: "is idle" would re-read on every render of an idle agent,
 * which is exactly the polling this store refuses to do. The first sighting of a
 * agent only records its status — the card's mount already took a reading, and an
 * agent that was idle when you selected it has not changed since.
 *
 * Only `idle` counts. `waiting_input` is mid-turn (a permission prompt), and `done` /
 * `error` mean the process is gone, so `--resume` has nothing new to say.
 */
export function noteAgentStatus(agentId: string, status: AgentStatus): void {
  const prev = lastStatus.get(agentId);
  lastStatus.set(agentId, status);
  if (prev !== undefined && prev !== "idle" && status === "idle") {
    void refreshContext(agentId);
  }
}

/**
 * Back to boot state — tests only. Clears the module-scope plumbing too, so a status
 * edge or an in-flight read cannot leak into the next test.
 */
export function resetContextStore(): void {
  inFlight.clear();
  lastStatus.clear();
  useContextStore.setState({ entries: {}, view: "bar" });
}
