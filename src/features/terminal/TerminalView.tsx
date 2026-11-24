/**
 * TerminalView — the public component. Renders a host div that fills its
 * parent and hands it to the registry; everything else happens outside React.
 *
 * Public contract (imported by `components/**`):
 *   <TerminalView terminalId={id} />
 *
 * The parent must be a sized box (a flex/grid child with a definite height).
 *
 * The find-in-terminal overlay: Cmd/Ctrl+F while the terminal is
 * focused opens `<TerminalSearch>` over the host, SEEDED with whatever the
 * terminal has selected (pressing Cmd+F with text selected must search for
 * that selection — the rule is
 * `find/selectionSeed`, shared with the editor and every other bar). The
 * shortcut is intercepted
 * with a CAPTURE-phase keydown listener on the host div — it runs before the
 * event reaches xterm's hidden textarea (which would otherwise swallow the key
 * and send it to the PTY), and it also fires when the overlay's own input is
 * focused, so a second Cmd/Ctrl+F re-focuses the query (shortcuts over
 * editable elements need a focus-local handler). Every other key passes
 * through untouched — a closed overlay steals nothing.
 *
 * The overlay's OPEN state lives in the store (`findBars["terminal:<id>"]`),
 * not in `useState`: `Pane` renders only the active tab and a cross-pane drag
 * re-parents the subtree, so local state here dies on every tab switch/move
 * and the bar closed with it. ONLY `open` moved there —
 * the query + Cc/W/.* toggles already survive in the registry (`searchUi`,
 * restored by `<TerminalSearch>`'s lazy initializers, which also re-run the
 * search on mount so a remounted-open bar re-highlights), and a second copy
 * of them would be a second source of truth.
 */

import { useCallback, useEffect, useState } from "react";

import { useAppStore } from "../../app/store";
import type { TerminalId } from "../../app/types";
import { seedFromSelectionText } from "../editor/find/selectionSeed";
import { isMac } from "../shortcuts/shortcuts";
import { isFindShortcut } from "./find/searchModel";
import { TerminalSearch } from "./find/TerminalSearch";
import { getTerminalSelection } from "./TerminalRegistry";
import { useTerminal } from "./useTerminal";

const HOST_STYLE: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  background: "var(--bg-app, #0d1117)",
};

export interface TerminalViewProps {
  terminalId: TerminalId;
  /**
   * Absolute cwd for this terminal's PTY, used only on first creation.
   * Optional: falls back to `configureTerminal()` then to the registry default
   * (`setDefaultTerminalCwd()`).
   */
  cwd?: string;
}

export function TerminalView({ terminalId, cwd }: TerminalViewProps): React.JSX.Element {
  const hostRef = useTerminal(terminalId, cwd ? { cwd } : undefined);

  // Store-backed so it survives the unmount a tab switch/move is (see the
  // header). An absent record is the closed state.
  const findBarKey = `terminal:${terminalId}`;
  const searchOpen = useAppStore((s) => s.findBars[findBarKey]?.open ?? false);
  const patchFindBar = useAppStore((s) => s.uiActions.patchFindBar);
  const dropFindBar = useAppStore((s) => s.uiActions.dropFindBar);
  /**
   * One Cmd/Ctrl+F press: `n` bumps so an already-open overlay re-focuses its
   * input, and `seed` carries what the terminal had selected at the moment the
   * key was pressed (`null` = nothing usable, leave the query alone).
   *
   * One piece of state rather than two because they are one gesture and must
   * reach `<TerminalSearch>` in the same commit. Deliberately local: a keypress
   * is a per-mount gesture, not state a remount needs — which is also why a tab
   * switch re-mounts the overlay WITHOUT re-seeding it.
   */
  const [searchRequest, setSearchRequest] = useState<{ n: number; seed: string | null }>({
    n: 0,
    seed: null,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mac = isMac();
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (!isFindShortcut(ev, mac)) return;
      ev.preventDefault();
      ev.stopPropagation(); // never reaches xterm's textarea
      // Read the selection HERE, synchronously: the overlay focuses its input
      // on mount, and focusing collapses a selection. xterm's own selection
      // survives this keypress because of the stopPropagation above — its
      // clear-on-user-input never sees the key.
      const seed = seedFromSelectionText(getTerminalSelection(terminalId));
      patchFindBar(findBarKey, { open: true });
      setSearchRequest((r) => ({ n: r.n + 1, seed }));
    };
    host.addEventListener("keydown", onKeyDown, { capture: true });
    return () => host.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [hostRef, findBarKey, patchFindBar, terminalId]);

  // <TerminalSearch> hands focus back to the terminal itself before calling
  // this (Esc/✕ must land the user back in the shell). Dropping the record is
  // the closed state — a mere unmount keeps it, which is the whole difference
  // between pressing Esc and moving the tab.
  const closeSearch = useCallback(() => dropFindBar(findBarKey), [dropFindBar, findBarKey]);

  return (
    <div ref={hostRef} className="terminal-view" style={HOST_STYLE} data-terminal-id={terminalId}>
      {searchOpen && (
        <TerminalSearch
          terminalId={terminalId}
          focusSignal={searchRequest.n}
          seed={searchRequest.seed}
          onClose={closeSearch}
        />
      )}
    </div>
  );
}

export default TerminalView;
