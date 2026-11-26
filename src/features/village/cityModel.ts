/** Each live PLAIN terminal tab is a floor, in the folder its PTY opened in (`TerminalMeta.cwd`;
 * the store keeps none). Exit comes from the supervisor snapshot (the registry never learns a
 * shell exited); activity from `terminalsBusy`. Read-only. */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../app/store";
import type { Tab, TabId, TerminalId } from "../../app/types";
import { fleetSnapshot } from "../fleet/fleetIpc";
import { getTerminalMeta } from "../terminal";
import { terminalsBusy, type BusyReason } from "../terminal/terminalBusyIpc";
import { folderOf } from "./villageModel";
import type { VillageActivity, VillageAgent } from "./villageTypes";

/** The building a console goes to when nothing says where it runs. */
export const CONSOLE_FOLDER = "Terminals";
/** The key prefix of a console's pseudo-agent (never collides with an AgentId or an "ext:" key). */
export const CONSOLE_PREFIX = "term:";

/** What is known of a terminal's PTY — by the supervisor, else the registry (null: not opened yet). */
export type ConsoleMetaLookup = (terminalId: TerminalId) => { cwd: string; status: "live" | "exited" } | null;

const ACTIVITY: Record<BusyReason, VillageActivity> = { command: "typing", agent: "thinking" };

/** Live plain consoles as root agents, in tab order. `fallbackCwd` (the workspace root) places one
 * whose PTY has not opened; a cwd naming no folder (empty, ".") lands in {@link CONSOLE_FOLDER}. */
export function consoleAgents(
  tabs: Record<TabId, Tab>,
  metaOf: ConsoleMetaLookup,
  fallbackCwd: string | null,
  busy: ReadonlyMap<string, BusyReason>,
): VillageAgent[] {
  const out: VillageAgent[] = [];
  for (const tab of Object.values(tabs)) {
    if (tab.ref.kind !== "terminal") continue;
    const id = tab.ref.terminalId;
    const meta = metaOf(id);
    if (meta?.status === "exited") continue;
    const cwd = meta?.cwd ?? fallbackCwd ?? "";
    const folder = folderOf(cwd);
    const reason = busy.get(id);
    out.push({
      key: `${CONSOLE_PREFIX}${id}`,
      parentKey: null,
      origin: "ide",
      title: tab.customTitle ?? tab.title,
      folder: folder === "" || folder === "." ? CONSOLE_FOLDER : folder,
      activity: reason ? ACTIVITY[reason] : "idle",
      tool: null,
      ideAgentId: null,
      lastActivityAt: null,
      consoleId: id,
    });
  }
  return out;
}

const registryMeta: ConsoleMetaLookup = (id) => getTerminalMeta(id);

type MetaMap = ReadonlyMap<string, { cwd: string; status: "live" | "exited" }>;

/** The supervisor's view of every PTY (fresh status), or null when it could not be asked. */
async function supervisorMeta(): Promise<MetaMap | null> {
  try {
    const { terminals } = await fleetSnapshot();
    return new Map(terminals.map((t) => [t.id as string, { cwd: t.cwd, status: t.status }]));
  } catch {
    return null;
  }
}

/** One poll's answers: what runs in each console, and what the supervisor knows of its PTY. */
interface Polled {
  busy: ReadonlyMap<string, BusyReason>;
  meta: MetaMap | null;
}

export interface UseCityConsolesOptions {
  /** Poll the busy state (only while mounted, enabled and the document is visible). */
  enabled: boolean;
  /** Poll interval in ms. Default 3000 (the external scan's cadence). */
  pollMs?: number;
}

/** Live consoles while `enabled` (city on screen), else `[]`. PTY state is not reactive, so each
 * poll re-asks the supervisor and re-reads the registry; a failed snapshot leaves the registry. */
export function useCityConsoles({ enabled, pollMs = 3000 }: UseCityConsolesOptions): VillageAgent[] {
  const tabs = useAppStore((s) => s.tabs);
  const root = useAppStore((s) => s.workspaceRoot);
  // A fresh answer every poll, even an equal one: that is what re-reads the (non-reactive)
  // registry below, so a PTY that opened since shows up within a poll.
  const [polled, setPolled] = useState<Polled>(() => ({ busy: new Map(), meta: null }));

  // The consoles' ids as one string: an unrelated tab change (an editor's dirty dot) gives
  // an equal string, so it neither restarts the poll nor fires an extra one.
  const idKey = useMemo(
    () => Object.values(tabs).flatMap((t) => (t.ref.kind === "terminal" ? [t.ref.terminalId] : [])).join(" "),
    [tabs],
  );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const ids = idKey.split(" ").filter(Boolean) as TerminalId[];
    const poll = (): void => {
      if (document.visibilityState !== "visible") return;
      // No console, nothing to ask (terminalsBusy short-circuits an empty list itself).
      const meta = ids.length > 0 ? supervisorMeta() : Promise.resolve(null);
      void Promise.all([terminalsBusy(ids), meta]).then(([list, known]) => {
        if (disposed) return;
        setPolled({ busy: new Map(list.map((b) => [b.id as string, b.reason])), meta: known });
      });
    };
    poll();
    const timer = setInterval(poll, pollMs);
    document.addEventListener("visibilitychange", poll);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [enabled, idKey, pollMs]);

  return useMemo(() => {
    if (!enabled) return [];
    const { busy, meta } = polled;
    return consoleAgents(tabs, (id) => meta?.get(id) ?? registryMeta(id), root, busy);
  }, [enabled, tabs, root, polled]);
}
