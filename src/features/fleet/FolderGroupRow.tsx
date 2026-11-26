/** A folder-group header above its root agents: name, count, status rollup, disclosure (expanded
 * by default) and a per-folder `+`. `memo`'d on primitives like `<AgentRow>`, so a tick
 * re-renders nothing. */

import { memo, useState, type CSSProperties, type DragEvent } from "react";

import { useAppStore } from "../../app/store";
import { FolderIcon, PlusIcon } from "../../components/icons";
import { projectColor, projectMonogram } from "./projectBadge";
import { useLaunchAgent } from "./useLaunchAgent";
import "./fleet.css";

/** Drag MIME for reordering folder headers; the value is the folder path (it lands before the
 * target). Distinct from AGENT_DND_MIME and TAB_DND_MIME so the drags never cross. */
export const FOLDER_DND_MIME = "application/x-agentstudio-folder";

/** DnD values are unreadable during `dragover` but types are not, so the source path rides in a
 * type name and the dragged row hides its own drop indicator. Lowercased, as the spec does. */
export function folderPathType(path: string): string {
  return `${FOLDER_DND_MIME}-path:${path}`.toLowerCase();
}

export interface FolderGroupRowProps {
  path: string;
  name: string;
  agentCount: number;
  rollupRunning: number;
  /** Agents waiting for the user's input — the count a project header most needs to show. */
  rollupWaiting: number;
  rollupDone: number;
  rollupError: number;
  collapsed: boolean;
}

type StatKind = "running" | "waiting_input" | "done" | "error";

/** "3 running · 1 waiting · 2 done · 1 error" as parts — only the non-zero ones. */
function statParts(
  running: number,
  waiting: number,
  done: number,
  error: number,
): { kind: StatKind; text: string }[] {
  const parts: { kind: StatKind; text: string }[] = [];
  if (running > 0) parts.push({ kind: "running", text: `${running} running` });
  if (waiting > 0) parts.push({ kind: "waiting_input", text: `${waiting} waiting` });
  if (done > 0) parts.push({ kind: "done", text: `${done} done` });
  if (error > 0) parts.push({ kind: "error", text: `${error} error` });
  return parts;
}

function FolderGroupRowImpl({
  path,
  name,
  agentCount,
  rollupRunning,
  rollupWaiting,
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

  const stats = statParts(rollupRunning, rollupWaiting, rollupDone, rollupError);
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
        collapsed && "folder-group--collapsed",
        attention && "folder-group--attention",
        dragging && "folder-group--dragging",
        dropTarget && "folder-group--drop-target",
      ]
        .filter(Boolean)
        .join(" ")}
      // The project's color, for the styles that show one (monogram, folder icon).
      style={{ "--pc": projectColor(path) } as CSSProperties}
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
        {/* Both badges always render; each project style shows the one it uses. */}
        <span className="folder-group__mono" aria-hidden="true">
          {projectMonogram(name)}
        </span>
        <span className="folder-group__icon" aria-hidden="true">
          <FolderIcon size={14} />
        </span>
        <span className="folder-group__name" title={path}>
          {name}
        </span>
        <span className="folder-group__count" aria-label={`${agentCount} agents`}>
          {agentCount}
        </span>
      </button>
      {/* On a line of its own, so the counts never squeeze the name to an ellipsis. */}
      {stats.length > 0 && (
        <div className="folder-group__stats">
          {stats.map((part, i) => (
            <span key={part.kind} className="folder-group__stat-wrap">
              {i > 0 && <span className="folder-group__sep">·</span>}
              <span className={`folder-group__stat folder-group__stat--${part.kind}`}>
                {part.text}
              </span>
            </span>
          ))}
        </div>
      )}
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
