/** A renamed terminal's name in Logs. The source label Rust stamps at spawn (`bash · workspace`)
 * is the KEY and never changes; this maps it to the tab's custom title for display only. */

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

/** Terminal source → its tab's custom title, for renamed plain terminals. Only when every
 * terminal carrying the source has that one title: older lines can share a label across
 * terminals, and a shared source keeps its own name. */
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

/** What Logs shows for a source everywhere: the renamed terminal's live title, else the
 * display name. The source string stays the key. */
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
