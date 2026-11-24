/**
 * City view — the IDE's plain CONSOLES as village agents (every console
 * or agent takes one floor, so more consoles mean more floors).
 *
 * An agent terminal is already its agent's floor, so only PLAIN terminal tabs (`ref.kind ===
 * "terminal"`, in every view) become floors of their own here, the console's user at the
 * leader's desk. Its building is the folder its PTY was opened in — `TerminalMeta.cwd`, read
 * from the terminal registry like the find overlays' context scope does, since the store keeps
 * no cwd for a terminal; before the PTY has opened (a background tab nobody showed yet) the
 * workspace root, where "+ New terminal" opens. A console that has exited is not running, and
 * gets no floor.
 *
 * Whether it has exited is asked of the SUPERVISOR (`fleet_snapshot`), not the registry: the
 * registry's `TerminalMeta` is written once, when the PTY opens or is reattached, and the
 * frontend gets no event when a shell exits mid-session — so a console where the user typed
 * `exit` would keep its floor ("At the prompt") for as long as its tab stayed open. The
 * snapshot's metadata is updated on child exit. Where the snapshot does not answer (it failed,
 * or that PTY is not in it yet) the registry's metadata stands in.
 *
 * What the user is doing comes from `terminalsBusy` — the same backend question the close
 * gate asks ("is something running in this terminal?"). Both questions are local, read-only,
 * and asked every few seconds only while the city is on screen: a running command → typing, a
 * hand-typed `claude` → thinking, else idle.
 *
 * Reads only; never writes the store.
 */

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

/**
 * Every live plain console as a root `VillageAgent`, in tab order. `fallbackCwd` (the
 * workspace root) places a console whose PTY has not opened yet; a cwd that names no folder
 * (empty, ".") lands in {@link CONSOLE_FOLDER}.
 */
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

/**
 * The live consoles while `enabled` (the city is on screen); `[]` otherwise. A tab opened,
 * renamed or closed shows at once (the store is reactive); a PTY's state is not, so the
 * supervisor is asked (and the registry re-read) on every poll. A failed busy check already
 * resolves to "nothing is busy"; a failed snapshot leaves the registry's metadata in charge.
 */
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
