/** The fleet grouped by folder. Header: ⚡ quick-launch (most recent project, else workspace root,
 * else `.`) and `+` open project (folder picker; it becomes the workspace root). Every launch
 * surface goes through `useLaunchAgent`. */

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

  /** Names where a new agent will start, on the control that decides it. */
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
      {/* The footer: last in order, pinned by `margin-top:auto`; owns its store and polling. */}
      <UsageLimits />
    </aside>
  );
}
