/**
 * The last title every IDE terminal had — so a flow from a terminal that has since closed is
 * labelled `gazelle (closed)`, not `closed terminal 0000eeee`.
 *
 * A closed tab is gone from the app store, taking its title with it, so the titles have to be
 * recorded WHILE the terminal is open. {@link watchTerminalTitles} follows the app store's
 * tabs/agents and keeps the newest title per terminal id in `networkStore.terminalTitles` (the
 * Network view's own store). It is started by the titlebar's Network button, which
 * is mounted for the app's whole life, and by the panel — reference-counted, so either can stop
 * without silencing the other. Kept for the app run only: a previous run's terminal ids were
 * never seen, and fall back to the short id.
 */

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
