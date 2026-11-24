/**
 * A folder-group header — the layer above root agents.
 *
 * Root agents are grouped by `cwd`; this row names the folder, counts its
 * agents, rolls up their statuses, discloses the group (default EXPANDED), and
 * carries a per-folder `+` to launch another agent in it.
 *
 * `memo` on primitive props, exactly like `<AgentRow>`: a re-flatten on an
 * activity tick hands it identical numbers, so it re-renders nothing — the same
 * budget the fan-out tree holds.
 */

import { memo, useState, type DragEvent } from "react";

import { useAppStore } from "../../app/store";
import { PlusIcon } from "../../components/icons";
import { useLaunchAgent } from "./useLaunchAgent";
import "./fleet.css";

/**
 * Drag payload for reordering a folder-group header (feature: sortable rail). The
 * VALUE is the dragged folder's absolute path; the drop target reads it back and
 * calls `moveFolder(dragged, target)` (dragged lands immediately before target).
 *
 * A folder-specific MIME so a folder drag, an agent-row drag (AGENT_DND_MIME) and
 * a centre-pane tab drag (TAB_DND_MIME) never accept one another.
 */
export const FOLDER_DND_MIME = "application/x-agentstudio-folder";

/**
 * A dragover-readable marker type encoding the SOURCE folder's own path.
 *
 * `dataTransfer` VALUES are unreadable during `dragover` (the drag store is in
 * protected mode until the drop) — but the TYPE list is readable. So the source
 * path is smuggled into a type name, letting a `dragover` suppress the drop
 * indicator on the very row being dragged (a self-drop is a no-op). Lowercased
 * because the HTML5 DnD spec lowercases every format string.
 */
export function folderPathType(path: string): string {
  return `${FOLDER_DND_MIME}-path:${path}`.toLowerCase();
}

export interface FolderGroupRowProps {
  path: string;
  name: string;
  agentCount: number;
  rollupRunning: number;
  rollupDone: number;
  rollupError: number;
  collapsed: boolean;
}

/** "3 running · 1 done · 1 error" — only the non-zero parts. */
function rollupSummary(running: number, done: number, error: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (error > 0) parts.push(`${error} error`);
  return parts.join(" · ");
}

function FolderGroupRowImpl({
  path,
  name,
  agentCount,
  rollupRunning,
  rollupDone,
  rollupError,
  collapsed,
}: FolderGroupRowProps) {
  const toggleFolder = useAppStore((s) => s.agentActions.toggleFolderCollapsed);
  const moveFolder = useAppStore((s) => s.workspaceActions.moveFolder);
  const launchAgent = useLaunchAgent();

  // Local drag chrome only — set in event handlers, never during render, so the
  // rail's re-render budget (memoized rows) is untouched by folders that are not
  // being dragged over.
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);

  const summary = rollupSummary(rollupRunning, rollupDone, rollupError);
  const attention = rollupError > 0;

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(FOLDER_DND_MIME, path);
    // The source-path marker (empty value): read on dragover to suppress the
    // self-drop indicator; the real payload rides on FOLDER_DND_MIME above.
    e.dataTransfer.setData(folderPathType(path), "");
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  };

  const onDragEnd = () => setDragging(false);

  /** A compatible folder drag from a DIFFERENT folder (self is suppressed). */
  const accepts = (e: DragEvent) =>
    e.dataTransfer.types.includes(FOLDER_DND_MIME) &&
    !e.dataTransfer.types.includes(folderPathType(path));

  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropTarget(false);
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(FOLDER_DND_MIME)) return;
    e.preventDefault();
    setDropTarget(false);
    const dragged = e.dataTransfer.getData(FOLDER_DND_MIME);
    // Self-drop is a no-op (moveFolder(path, path) would send it to the end).
    if (dragged && dragged !== path) moveFolder(dragged, path);
  };

  return (
    <li
      className={[
        "folder-group",
        attention && "folder-group--attention",
        dragging && "folder-group--dragging",
        dropTarget && "folder-group--drop-target",
      ]
        .filter(Boolean)
        .join(" ")}
      role="treeitem"
      aria-expanded={!collapsed}
      aria-level={1}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="folder-group__header"
        aria-label={collapsed ? `Expand folder ${name}` : `Collapse folder ${name}`}
        onClick={() => toggleFolder(path)}
      >
        <span className="folder-group__caret" aria-hidden="true">
          {collapsed ? "▶" : "▼"}
        </span>
        <span className="folder-group__name" title={path}>
          {name}
        </span>
        <span className="folder-group__count" aria-label={`${agentCount} agents`}>
          {agentCount}
        </span>
        {summary && <span className="folder-group__rollup">{summary}</span>}
      </button>
      <button
        type="button"
        className="folder-group__add"
        aria-label={`New agent in ${name}`}
        title="New agent in this folder"
        onClick={() => launchAgent(path)}
      >
        <PlusIcon size={12} />
      </button>
    </li>
  );
}

export const FolderGroupRow = memo(FolderGroupRowImpl);
