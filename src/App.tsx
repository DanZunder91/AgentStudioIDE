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

/** The 3-pane shell; see docs/design/ARCHITECTURE.md. */
export default function App() {
  // A CSP fails silently and a packaged build has no console, so `securitypolicyviolation`
  // reports go to the Logs panel (docs/design/csp.md). `startCspReporter` returns its unsubscribe.
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
      {/* Actions only, no project label: the app is multi-root, and `workspaceRoot` is
          only a fallback launch dir (in LeftRail's quick-launch tooltip), not a scope. */}
      <header className="titlebar">
        {/* Right-aligned cluster; this wrapper carries `margin-left: auto` since
            `.titlebar__hint` is conditionally omitted. */}
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

        {/* <ViewBar/> is the top-level strip of views (whole terminal arrangements);
            per-pane tab strips sit beneath it. Inert until the store's view slice exists. */}
        <main className="center">
          <ViewBar />
          <PaneTreeRoot />
        </main>

        {/* Drag handle on the center / right rail seam (hidden when collapsed). */}
        <RailResizer side="right" />

        {/* Every arm is explicit; the fallthrough is `git`, the union's last member. A new
            `RightRailTab` without an arm would render the wrong panel with no type error.
            Find is a titlebar overlay, not a panel. */}
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
      {/* Mounted at the root: pane closes and the fleet rail's ✕ close terminals outside
          a tab. Renders nothing unless a close is pending. */}
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
