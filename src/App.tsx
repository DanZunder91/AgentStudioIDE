import { useEffect } from "react";

import "./App.css";
import { useAppStore } from "./app/store";
import { PaneTreeRoot } from "./components/PaneTree";
import { RailResizer } from "./components/RailResizer";
import { ViewBar } from "./components/ViewBar";
import { PanelLeftIcon, PanelRightIcon, SearchIcon } from "./components/icons";
import {
  ApiRequestButton,
  SequenceButton,
  CollectionsPanel,
  HistoryPanel,
  SaveRequestDialog,
  SaveRequestShortcut,
  VaultPanel,
} from "./features/api";
import { DbPanel } from "./features/db";
import { ReferencesPanel, UnsavedChangesDialog } from "./features/editor";
import { CloseTerminalDialog } from "./features/terminal/CloseTerminalDialog";
import { FindFiles, FindInFiles } from "./features/find";
import { LeftRail } from "./features/fleet";
import { GitPanel } from "./features/git";
import { IconSprite } from "./lib/fileIcons";
import { LogsButton, LogsPanel } from "./features/logs";
// Direct module import rather than the `features/logs` barrel: the reporter is
// effect-only plumbing with no React surface, so it is not part of the feature's
// public component set.
import { startDiskWatch } from "./features/editor/diskWatch";
import { startCspReporter } from "./features/logs/cspReporter";
import { MetricsButton } from "./features/metrics/MetricsButton";
import { AgentLogsButton } from "./features/agentlogs";
import { NetworkButton } from "./features/network";
import { VillageButton } from "./features/village";
import { PortabilityDialogs } from "./features/portability";
import { SettingsMenu } from "./features/settings";
import {
  CloseTabShortcut,
  FindKeysShortcut,
  modChord,
  ShortcutsButton,
  ShortcutsPanel,
} from "./features/shortcuts";
import { ToolsPanel } from "./features/tools";
import { RailTabs, WorkspaceTree } from "./features/workspace";

/**
 * The 3-pane shell.
 * Left: agent fan-out tree (static until M2) · Center: LIVE tabbed/split work
 * area with real PTY terminals (M1) · Right: workspace tree (static until M2).
 * See docs/design/ARCHITECTURE.md.
 */
export default function App() {
  // A shipped Content-Security-Policy fails SILENTLY (a blocked stylesheet is a
  // blank pane, not an error), and a packaged build has no console to check. So
  // the webview's own `securitypolicyviolation` reports go into the diagnostics
  // log — open the Logs panel and you SEE what the policy blocked.
  // See docs/design/csp.md; `startCspReporter` returns its own unsubscribe.
  useEffect(startCspReporter, []);
  // Watch the OPEN files for changes made outside this app — which, in an IDE for
  // orchestrating agents, is the normal case. Refcounted + idempotent, so a
  // StrictMode double-mount cannot start two (the `startGitPolling` contract).
  useEffect(startDiskWatch, []);

  // The right rail's persistent panel: Files (the multi-root tree) or Vault (the
  // secrets manager). Find is not a panel — it is a momentary overlay.
  const rightRailTab = useAppStore((s) => s.rightRailTab);
  const leftRailCollapsed = useAppStore((s) => s.leftRailCollapsed);
  const rightRailCollapsed = useAppStore((s) => s.rightRailCollapsed);
  const leftRailWidth = useAppStore((s) => s.leftRailWidth);
  const rightRailWidth = useAppStore((s) => s.rightRailWidth);
  const { toggleLeftRail, toggleRightRail, toggleFindInFiles } = useAppStore(
    (s) => s.uiActions,
  );

  // The rail widths feed the grid via CSS vars; a collapsed rail is 0 (its column
  // vanishes), independent of its stored width so expanding restores that width.
  const shellVars = {
    "--left-col": leftRailCollapsed ? "0px" : `${leftRailWidth}px`,
    "--right-col": rightRailCollapsed ? "0px" : `${rightRailWidth}px`,
  } as React.CSSProperties;

  return (
    <div className="app" data-testid="app-shell">
      {/* The titlebar carries ACTIONS only — no project label.

          It used to render `basename(workspaceRoot)`, and that had become a lie. This
          app is deliberately MULTI-root: agents are grouped by their own folder in the
          left rail and the Files tree mounts one root per agent cwd. But
          `workspaceRoot` is a SINGLE value, so with two projects open the titlebar
          picked one of them arbitrarily and implied a "current project" that scopes
          nothing — every real scope here is per-agent or per-root. It also duplicated,
          less accurately, information already on screen twice (the folder group rows,
          and the selected agent's cwd), and the leading dot read like a
          connection/status indicator it never was.

          `workspaceRoot` still exists and still matters — it is a fallback launch
          directory. That information moved to the ⚡ quick-launch button's tooltip in
          `LeftRail`, i.e. onto the control it actually governs, which is more useful
          than a passive label. The native window title still shows the app name, so no
          branding is lost. */}
      <header className="titlebar">
        {/* Right-aligned cluster (this wrapper carries the `margin-left: auto`
            now that `.titlebar__hint` is conditionally omitted): the rail
            toggles, then a new API request tab, then the shortcuts reference
            (also Cmd/Ctrl+/). */}
        <div className="titlebar__actions">
          <button
            type="button"
            className="titlebar__icon-btn"
            data-testid="titlebar-find"
            aria-label="Find in files"
            title={`Find in files (${modChord("Shift+F")})`}
            onClick={toggleFindInFiles}
          >
            <SearchIcon />
          </button>
          <button
            type="button"
            className="titlebar__icon-btn"
            data-testid="rail-toggle-left"
            aria-label="Toggle left panel"
            aria-pressed={!leftRailCollapsed}
            onClick={toggleLeftRail}
          >
            <PanelLeftIcon />
          </button>
          <button
            type="button"
            className="titlebar__icon-btn"
            data-testid="rail-toggle-right"
            aria-label="Toggle right panel"
            aria-pressed={!rightRailCollapsed}
            onClick={toggleRightRail}
          >
            <PanelRightIcon />
          </button>
          <ApiRequestButton />
            <SequenceButton />
          {/* Opens the Claude metrics dashboard as a TAB (a
              destination you split beside a terminal, not a momentary overlay). */}
          <MetricsButton />
          {/* The two fleet views — everything the agents print, and every
              API call they make. Tabs, like metrics. */}
          <AgentLogsButton />
          <NetworkButton />
          {/* The Agent Village — every Claude agent on this machine as a
              pixel-art character. A singleton tab, like the two fleet views above. */}
          <VillageButton />
          <LogsButton />
          <ShortcutsButton />
          <SettingsMenu />
        </div>
      </header>

      <div
        className={`app-shell${leftRailCollapsed ? " app-shell--left-collapsed" : ""}${rightRailCollapsed ? " app-shell--right-collapsed" : ""}`}
        style={shellVars}
      >
        {/* LEFT RAIL — the real fleet (M2). Self-subscribing; recursive-capable
            from day one so M3 hangs sub-agents off childIds with no retrofit. */}
        <LeftRail />

        {/* Drag handle on the left rail / center seam (hidden when collapsed). */}
        <RailResizer side="left" />

        {/* CENTER — live work area: real PTY terminals, tabs, split panes (M1).
            Both children self-subscribe to the layout store.

            <ViewBar/> is the TOP-LEVEL strip of views — one chip per whole
            arrangement of terminals (four terminals in one view, then a switch
            to another view that holds two more).
            Today's per-pane tab strips read as the sub-level beneath it. It
            renders nothing until the store's view slice exists, so mounting it
            is inert until then. */}
        <main className="center">
          <ViewBar />
          <PaneTreeRoot />
        </main>

        {/* Drag handle on the center / right rail seam (hidden when collapsed). */}
        <RailResizer side="right" />

        {/* RIGHT RAIL — workspace of the selected agent. The tabs are REAL:
            Files = the multi-root file tree, Vault = the
            secrets / environment manager, History = the API request log, Collections =
            the saved-request library (HTTP/WS/gRPC), DB = the saved database
            connections, Tools = the self-contained developer utilities, Git =
            working-tree changes + open pull requests. Find is a momentary action in
            the titlebar — it opens the global Find-in-Files overlay and does NOT
            change the mounted panel.

            Every arm below is EXPLICIT, including the last. The chain's final `else`
            used to be a bare `<DbPanel/>`: correct only because "db" happened to be the
            last member of `RightRailTab`, and silently wrong the moment another tab is
            appended — adding Git after Tools would have rendered the Tools panel, with
            no type error and no failing render. The fallthrough is now `git`
            (the union's last member) and the `never` exhaustiveness is carried by the
            union itself, so the cost of getting this wrong is one visibly blank rail
            rather than one convincingly wrong panel. */}
        <aside className="rail rail--right">
          <RailTabs />
          {rightRailTab === "files" ? (
            <WorkspaceTree />
          ) : rightRailTab === "vault" ? (
            <VaultPanel />
          ) : rightRailTab === "history" ? (
            <HistoryPanel />
          ) : rightRailTab === "collections" ? (
            <CollectionsPanel />
          ) : rightRailTab === "db" ? (
            <DbPanel />
          ) : rightRailTab === "tools" ? (
            <ToolsPanel />
          ) : (
            <GitPanel />
          )}
        </aside>
      </div>

      {/* Global: the file-type icon sprite (file-icons.md §4) — one
          inline <symbol> sheet every <FileIcon>'s <use href="#mi-…"> resolves
          against. Mounted once here; rendering it is the whole integration. */}
      <IconSprite />

      {/* Global: the diagnostics log overlay (toggled by <LogsButton/> in the
          titlebar). Self-contained — driven by its own log store's `visible`
          flag, so mounting it is the whole integration. */}
      <LogsPanel />

      {/* Global: the unsaved-changes confirm for closing a dirty editor tab. */}
      <UnsavedChangesDialog />
      {/* "Are you sure?" before a close would kill a terminal that is still
          working. Mounted at the root, like the unsaved-
          changes confirm, because the gestures it guards are not all per-tab:
          closing a PANE takes several terminals at once, and the fleet rail's ✕
          closes an agent by id. It renders nothing unless a close is pending. */}
      <CloseTerminalDialog />

      {/* Global: project-wide search. Self-contained overlay — it
          installs its own Cmd/Ctrl+Shift+F toggle + Esc-to-close, so mounting
          it is the whole integration. */}
      <FindInFiles />

      {/* Global: the fuzzy filename finder. Self-contained too — its
          own Cmd/Ctrl+Shift+O toggle + Esc-close, sharing the scope selector with
          Find-in-Files. */}
      <FindFiles />

      {/* Global: the find-usages results. Driven by the `lspReferences`
          store seam that Cmd/Ctrl+Click-on-a-declaration + Shift+F12 populate. */}
      <ReferencesPanel />

      {/* Global: the keyboard-shortcuts reference. Self-contained — its own
          Cmd/Ctrl+/ toggle + Esc-close; the titlebar button drives the same state. */}
      <ShortcutsPanel />

      {/* Global: Cmd/Ctrl+W → close the active tab, any kind (not the app).
          Effect-only host; the macOS path rides the native menu (src-tauri/menu.rs). */}
      <CloseTabShortcut />

      {/* Global: bare Cmd/Ctrl+O → quick-open, and a Cmd/Ctrl+F no focused surface
          claimed → Find in Files, both on this window's workspace. Effect-only host. */}
      <FindKeysShortcut />

      {/* Global: Cmd/Ctrl+S → save the active API request into Collections.
          Effect-only host; a focused editor's own file-save wins via the
          defaultPrevented guard. Its name dialog is the sibling below. */}
      <SaveRequestShortcut />
      <SaveRequestDialog />
      {/* Share-a-config. One mount for both dialogs: the container reads which one the
          store is asking for, so `App` does not need to know either component exists. */}
      <PortabilityDialogs />
    </div>
  );
}
