import { useEffect } from "react";

import "./App.css";
import { PaneTreeRoot } from "./components/PaneTree";
import { UnsavedChangesDialog } from "./features/editor";
import { startDiskWatch } from "./features/editor/diskWatch";
import { startCspReporter } from "./features/logs/cspReporter";
import { FindFiles, FindInFiles } from "./features/find";
import { CloseTabShortcut, FindKeysShortcut, ShortcutsPanel } from "./features/shortcuts";
import { CloseTerminalDialog } from "./features/terminal/CloseTerminalDialog";
import { IconSprite } from "./lib/fileIcons";

/** The center fills the whole window here: there is no titlebar row and no rail grid. */
const CENTER_STYLE: React.CSSProperties = { flex: "1 1 auto" };

/**
 * The shell of a DETACHED window (tab tear-off, docs/design/tab-tearoff.md) — the same
 * bundle as `<App/>`, booted in a window whose label says it is not the main one.
 *
 * Deliberately minimal: its own pane tree and tab strips (splitting, reordering and
 * dragging tabs all work here as they do in the main window), plus the global pieces those
 * tabs can raise — the unsaved-changes and busy-terminal confirms, Cmd/Ctrl+W, the file-icon
 * sprite — and the overlays a user reaches for from any window: quick-open, find in files
 * and the shortcuts reference. The find overlays default their scope from the focused tab,
 * which here is THIS window's (a file from `gazelle` searches `gazelle`).
 *
 * What it leaves out is the point: no rails, no view bar, no titlebar buttons — and so none
 * of the app-wide pollers they start (usage, git, metrics). `startDiskWatch` runs,
 * but it watches THIS window's open editors only, which no other window watches — a
 * partition of the work, not a second copy of it.
 */
export default function TearoffApp() {
  // A blocked asset fails silently in a packaged build; this window reports its own.
  useEffect(startCspReporter, []);
  useEffect(startDiskWatch, []);

  return (
    <div className="app app--tearoff" data-testid="tearoff-shell">
      <main className="center" style={CENTER_STYLE}>
        <PaneTreeRoot />
      </main>
      <IconSprite />
      <UnsavedChangesDialog />
      <CloseTerminalDialog />
      <CloseTabShortcut />
      <FindInFiles />
      <FindFiles />
      <FindKeysShortcut />
      <ShortcutsPanel />
    </div>
  );
}
