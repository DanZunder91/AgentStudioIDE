/** Mounts/unmounts a DOM host into the TerminalRegistry; no bytes or re-renders on output
 * (ARCHITECTURE §1). Unmount detaches, so scrollback survives; disposal is the tab closer's job. */

import { useLayoutEffect, useRef } from "react";

import type { TerminalId } from "../../app/types";
import { attach, detach, ensureTerminal, focusTerminal } from "./TerminalRegistry";
import type { TerminalSpawnOptions } from "./TerminalRegistry";

export type UseTerminalOptions = TerminalSpawnOptions;

/** `options` is read only at first creation (cwd and program are fixed at spawn); later changes
 * re-spawn nothing. */
export function useTerminal(
  terminalId: TerminalId,
  options?: UseTerminalOptions,
): React.RefObject<HTMLDivElement | null> {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // First-render options, never rewritten: consumed once at creation, and kept out of the deps
  // (a fresh literal each render would thrash attach/detach).
  const spawnRef = useRef(options);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    ensureTerminal(terminalId, spawnRef.current?.cwd, spawnRef.current);
    attach(terminalId, host);

    // Focus on activation (a pane renders only its active tab), or the first key hits <body>.
    // Deferred a frame: focus after xterm's textarea layout commits, avoiding StrictMode churn.
    const raf = requestAnimationFrame(() => focusTerminal(terminalId));

    return () => {
      cancelAnimationFrame(raf);
      detach(terminalId);
    };
  }, [terminalId]);

  return hostRef;
}
