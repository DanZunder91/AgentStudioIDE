/** Host div handed to the registry; the parent must be a sized box. Mod+F is caught by a
 * capture-phase host keydown (before xterm's textarea swallows it; also in the overlay) and seeds
 * from the selection. Open state: the store's `findBars` (Pane remounts); query: `searchUi`. */

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
  /** Absolute PTY cwd, used only on first creation; falls back to `configureTerminal()`, then
   * `setDefaultTerminalCwd()`. */
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
  /** One Mod+F press: `n` bumps to re-focus an open overlay, `seed` is the selection then (`null`
   * = leave the query). One state so both land in one commit; local, so a remount won't re-seed. */
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
      // Read synchronously: the overlay focuses its input on mount, collapsing a selection.
      // xterm's selection survives as stopPropagation hides the key from its clear-on-input.
      const seed = seedFromSelectionText(getTerminalSelection(terminalId));
      patchFindBar(findBarKey, { open: true });
      setSearchRequest((r) => ({ n: r.n + 1, seed }));
    };
    host.addEventListener("keydown", onKeyDown, { capture: true });
    return () => host.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [hostRef, findBarKey, patchFindBar, terminalId]);

  // <TerminalSearch> refocuses the terminal before calling this. Dropping the record is the
  // closed state; a mere unmount keeps it (Esc vs moving the tab).
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
