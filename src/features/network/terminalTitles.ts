/** Last title of every IDE terminal, so a closed terminal's flows read `gazelle (closed)`. Titles
 * must be recorded while the tab is open (the app store drops them); watchers are ref-counted
 * (titlebar button, panel). App-run only: a previous run's ids fall back to the short id. */

import { useAppStore } from "../../app/store";
import { sourceIndex } from "./networkSource";
import { useNetworkStore } from "./networkStore";

/** Merge `index` (terminal id → current title) into the remembered titles; a no-op when nothing changed. */
export function rememberTitles(index: ReadonlyMap<string, string>): void {
  const known = useNetworkStore.getState().terminalTitles;
  let next: Map<string, string> | null = null;
  for (const [id, title] of index) {
    if (known.get(id) === title) continue;
    next ??= new Map(known);
    next.set(id, title);
  }
  if (next) useNetworkStore.setState({ terminalTitles: next });
}

let watchers = 0;
let unsubscribe: (() => void) | null = null;

/** Start following terminal titles; returns the stop function (reference-counted). */
export function watchTerminalTitles(): () => void {
  watchers += 1;
  if (unsubscribe === null) {
    let tabs: unknown = null;
    let agents: unknown = null;
    const record = (s: ReturnType<typeof useAppStore.getState>): void => {
      if (s.tabs === tabs && s.agents === agents) return;
      tabs = s.tabs;
      agents = s.agents;
      rememberTitles(sourceIndex(s.tabs, s.agents));
    };
    record(useAppStore.getState());
    unsubscribe = useAppStore.subscribe(record);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers -= 1;
    if (watchers === 0) {
      (unsubscribe as () => void)();
      unsubscribe = null;
    }
  };
}
