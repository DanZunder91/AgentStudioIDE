/**
 * LeftRail — the fleet, grouped by folder.
 *
 * Header carries two launch controls:
 *   - ⚡ quick-launch — no dialog, spawns in the most-recent project (or the
 *     workspace root, or `.`);
 *   - `+` open project — native folder picker → open that folder as a project
 *     with a first agent (and make it the workspace root).
 *
 * Per-folder `+` lives on each folder header (see `<FolderGroupRow>`). All three
 * launch surfaces funnel through `useLaunchAgent`, so recents stay in sync.
 *
 * This replaces the old standalone `<WorkspaceControl>` picker: folders are now
 * shown as group headers and the header `+` is the project picker, so there is
 * one folder model, not two.
 */

import { open } from "@tauri-apps/plugin-dialog";

import { useAppStore } from "../../app/store";
import { LightningIcon, PlusIcon } from "../../components/icons";
import { UsageLimits } from "../usage/UsageLimits";
import { AgentTree } from "./AgentTree";
import { useLaunchAgent } from "./useLaunchAgent";
import "./fleet.css";

/** "/Users/sam/projects/gazelle" → "gazelle"; separator-agnostic, and a path that
 *  is only separators falls back to itself rather than to "". */
function basename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

export function LeftRail() {
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const setWorkspaceRoot = useAppStore((s) => s.workspaceActions.setWorkspaceRoot);
  const launchAgent = useLaunchAgent();

  const openProject = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return; // cancelled, or a multi-select array
    setWorkspaceRoot(dir);
    launchAgent(dir);
  };

  // Most-recent project, else the workspace root, else the app cwd.
  const quickLaunchTarget = recentProjects[0] ?? workspaceRoot ?? ".";

  const quickLaunch = () => {
    launchAgent(quickLaunchTarget);
  };

  /**
   * The titlebar used to show `basename(workspaceRoot)`, which was removed: in a
   * multi-root app it named one project arbitrarily and scoped
   * nothing (see the comment in `App.tsx`). The one genuinely useful thing it hinted
   * at — *where a new agent will start* — belongs here instead, on the control that
   * actually decides it. A tooltip naming the folder beats a passive label naming a
   * different concept.
   */
  const quickLaunchLabel =
    quickLaunchTarget === "."
      ? "Quick-launch an agent in the current folder"
      : `Quick-launch an agent in ${basename(quickLaunchTarget)}`;

  return (
    <aside className="rail rail--left" data-testid="left-rail">
      <div className="rail__header">
        <span>Agents</span>
        <div className="rail__actions">
          <button
            type="button"
            className="rail__action"
            aria-label={quickLaunchLabel}
            title={quickLaunchLabel}
            onClick={quickLaunch}
          >
            <LightningIcon />
          </button>
          <button
            type="button"
            className="rail__action"
            aria-label="Open project folder"
            title="Open a folder as a project"
            onClick={() => void openProject()}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <AgentTree />
      {/* The usage strip is the rail's FOOTER, not a header. Last in document
          order and pinned to the bottom by `margin-top:auto`, so it stays put
          whether the agents list is empty or overflowing. Self-contained:
          mounting it is the whole integration — it owns its store, its 5s
          polling (paused while the window is hidden) and its refresh button. */}
      <UsageLimits />
    </aside>
  );
}
