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

/** A detached window's shell (docs/design/tab-tearoff.md): its own pane tree, confirms and
 * overlays. No rails, view bar or titlebar buttons, hence none of their app-wide pollers;
 * `startDiskWatch` covers only THIS window's open editors. */
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
