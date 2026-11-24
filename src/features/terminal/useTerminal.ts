/**
 * useTerminal — the entire React surface of the terminal feature.
 *
 * All it does is mount and unmount a DOM host into the TerminalRegistry.
 * No bytes, no xterm state, no re-renders on output (ARCHITECTURE §1).
 *
 * On unmount it DETACHES rather than disposes, so scrollback and cursor
 * survive tab and session switches. Disposal is an explicit act
 * (`dispose(terminalId)` from the registry) that belongs to whoever closes
 * the tab.
 */

import { useLayoutEffect, useRef } from "react";

import type { TerminalId } from "../../app/types";
import { attach, detach, ensureTerminal, focusTerminal } from "./TerminalRegistry";
import type { TerminalSpawnOptions } from "./TerminalRegistry";

export type UseTerminalOptions = TerminalSpawnOptions;

/**
 * Returns a ref to attach to the host element the terminal should fill.
 *
 * `options` is read only when the terminal is first created — a PTY's cwd and
 * program are fixed at spawn — so changing it later re-spawns nothing and does
 * not re-run the effect.
 */
export function useTerminal(
  terminalId: TerminalId,
  options?: UseTerminalOptions,
): React.RefObject<HTMLDivElement | null> {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Capture the spawn options as of the first render, and never write to the
  // ref again: useRef ignores its argument on every render after the first.
  // That is exactly the contract above (options are consumed once, at
  // creation), it keeps `options` out of the dependency list — it is a fresh
  // object literal each render, which would thrash attach/detach — and it
  // stays pure, unlike assigning to a ref during render.
  const spawnRef = useRef(options);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    ensureTerminal(terminalId, spawnRef.current?.cwd, spawnRef.current);
    attach(terminalId, host);

    // Auto-focus the terminal when it becomes active. A pane renders ONLY its
    // active tab's view (see components/Pane), so this effect runs exactly when
    // a terminal is opened or its tab is switched to — a real activation, never
    // an unrelated re-render (the `[terminalId]` dep guarantees that). Standard
    // IDE behaviour (VS Code / iTerm focus the terminal on tab-switch), and the
    // fix for the lost first keystroke: without it the first key after
    // opening a terminal landed on <body>, so ↑ (history recall) did nothing.
    //
    // Deferred a frame: on first mount `attach` synchronously opens xterm and
    // its hidden textarea; focusing after the browser has committed that layout
    // is more reliable than focusing mid-layout-effect, and avoids fighting the
    // detach→re-attach focus churn React StrictMode induces by double-invoking.
    const raf = requestAnimationFrame(() => focusTerminal(terminalId));

    return () => {
      cancelAnimationFrame(raf);
      detach(terminalId);
    };
  }, [terminalId]);

  return hostRef;
}
