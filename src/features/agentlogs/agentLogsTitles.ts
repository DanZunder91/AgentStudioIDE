/**
 * A renamed terminal's name in the Logs Sources sidebar.
 *
 * A terminal's log source is the label the Rust hub stamped on its lines at spawn
 * (`bash · workspace`) — it is the KEY, and it never changes. A user names the terminal
 * that runs their server `gazelle`; Network, the app card ("Console is the terminal gazelle")
 * and the tab all show `gazelle`; without this the Sources row would read `bash · workspace`.
 * This maps a terminal source to its tab's custom title so the row can SHOW it; the source key
 * stays as it is.
 */

import { createContext, useCallback, useContext } from "react";

import type { Tab } from "../../app/types";
import { displayName } from "./agentLogsFormat";
import type { LogLine } from "./agentLogsTypes";

type TitledTabs = Readonly<Record<string, Pick<Tab, "ref" | "customTitle">>>;

/** Terminal id → its tab's custom title, for every plain terminal tab the user renamed. */
export function terminalCustomTitles(tabs: TitledTabs): ReadonlyMap<string, string> {
  const renamed = new Map<string, string>();
  for (const t of Object.values(tabs)) {
    const title = t.customTitle?.trim();
    if (t.ref.kind === "terminal" && title) renamed.set(t.ref.terminalId, title);
  }
  return renamed;
}

/**
 * Terminal source → its tab's custom title, for every plain terminal the user renamed.
 *
 * A source is renamed only when every terminal whose lines carry it has that one title. Rust gives
 * each open terminal its own label (`powershell · Agent Studio (2)` — `LogHub::tap`), but before it
 * did, two terminals in one folder shared a label, and the row — and the `by …` tag of a server
 * started in the OTHER terminal — wore whichever tab was renamed (on Windows, where every
 * terminal is titled `powershell`). Lines from such a run can still be in the ring; a shared
 * source keeps its own name rather than borrow one terminal's.
 */
export function renamedTerminalLabels(
  lines: readonly Pick<LogLine, "source" | "kind" | "terminalId" | "agentId">[],
  tabs: TitledTabs,
): ReadonlyMap<string, string> {
  const renamed = terminalCustomTitles(tabs);
  const out = new Map<string, string>();
  if (renamed.size === 0) return out;
  // source → the title its terminals agree on, or null once two of them disagree.
  const agreed = new Map<string, string | null>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.kind !== "output" || l.agentId !== null || l.terminalId === null) continue;
    const key = `${l.source}\u0000${l.terminalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = renamed.get(l.terminalId) ?? null;
    const prev = agreed.get(l.source);
    agreed.set(l.source, prev === undefined || prev === title ? title : null);
  }
  for (const [source, title] of agreed) if (title !== null) out.set(source, title);
  return out;
}

/**
 * What Logs CALLS a source everywhere it names one (the sidebar used to read
 * `gazelle` while the Source column, the stream header, the source picker and the app's `by …` tag
 * still read `bash · workspace`): the renamed terminal's live title, else the display name. The
 * source string itself stays the key — only what is shown changes.
 */
export function sourceLabel(source: string, renamed: ReadonlyMap<string, string>): string {
  return renamed.get(source) ?? displayName(source);
}

const NO_RENAMES: ReadonlyMap<string, string> = new Map();

/** The panel's {@link renamedTerminalLabels}, for the rows deep in its tree (provided once, read per cell). */
export const RenamedSourcesContext = createContext<ReadonlyMap<string, string>>(NO_RENAMES);

/** `source → label` under the nearest {@link RenamedSourcesContext} (none = display names). */
export function useSourceLabel(): (source: string) => string {
  const renamed = useContext(RenamedSourcesContext);
  return useCallback((source: string) => sourceLabel(source, renamed), [renamed]);
}
