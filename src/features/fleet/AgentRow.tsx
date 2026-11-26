/** One flat fleet row. Subscribes to scalar fields one at a time (selecting the whole `AgentNode`
 * would re-render on every `activity` tick) and is `memo`'d on primitive props, so one agent's
 * change re-renders one row and a tick re-renders none. */

import { memo, useState, type DragEvent, type MouseEvent } from "react";

import { rootOf, useAppStore } from "../../app/store";
import { asAgentId, type AgentId } from "../../app/types";
// Right-click menu (Recover session): reused read-only — it owns surface/focus/dismissal,
// this row owns the items (same division as WorkspaceTree's menus).
import { ContextMenu } from "../../components/ContextMenu";
// The shared ✕ glyph — the same one the tab close uses, so the two dismissal
// affordances read identically.
import { CloseIcon, ResumeIcon } from "../../components/icons";
import { InlineEditInput } from "../../components/InlineEditInput";
import { useHomeDir } from "../../lib/homeDir";
import { tildeHome } from "../../lib/paths";
import { AgentStatusPill } from "./AgentStatusPill";
import { restoredMarkerCopy } from "./restoredMarker";
import { useResumeAgent } from "./useResumeAgent";
import "./fleet.css";

/** Indent per level. Applied as padding so the row's hit target stays full-width. */
const INDENT_PX = 14;

/** Pin glyph, local so the affordance stays in the fleet feature; `currentColor` takes the active
 * row's accent. */
function PinIcon({ size = 12, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      {/* Pin head + collar (the fillable body) and the needle below it. */}
      <path d="M6 2h4l-.6 3 1.6 1.8v.7H5v-.7L6.6 5 6 2Z" />
      <path d="M8 7.5v6" />
    </svg>
  );
}

/** Drag MIME for reordering a root agent in its folder; the value is the agent id (it lands before
 * the target). Distinct from FOLDER_DND_MIME and TAB_DND_MIME so the drags never cross. */
export const AGENT_DND_MIME = "application/x-agentstudio-agent";

/** DnD values are unreadable during `dragover` but types are not, so the cwd rides in a type name
 * and only same-folder targets accept. Lowercased (the spec lowercases formats); the drop's
 * value-compare catches case-only collisions. */
export function agentCwdType(cwd: string): string {
  return `${AGENT_DND_MIME}-cwd:${cwd}`.toLowerCase();
}

/** A marker encoding the source agent's id — read on dragover to suppress the
 *  self-drop indicator (a self-drop is a no-op). Same rationale as `agentCwdType`. */
export function agentIdType(id: string): string {
  return `${AGENT_DND_MIME}-id:${id}`.toLowerCase();
}

export interface AgentRowProps {
  agentId: AgentId;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Error (later waiting_input) somewhere below — surfaces on a collapsed row. */
  attention: boolean;
  /** Subtree status counts (0 when no children). Primitives, so memo holds. */
  rollupRunning: number;
  rollupDone: number;
  rollupError: number;
}

/** "3 running · 1 done · 1 error" — only the non-zero parts. Empty when all 0. */
function rollupSummary(running: number, done: number, error: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (error > 0) parts.push(`${error} error`);
  return parts.join(" · ");
}

function AgentRowImpl({
  agentId,
  depth,
  hasChildren,
  expanded,
  attention,
  rollupRunning,
  rollupDone,
  rollupError,
}: AgentRowProps) {
  // One scalar per subscription — see the header. Never select the node itself.
  // `?? ""` keeps it a string for the rename input; the empty case is only ever
  // the vanished-record race (status guard returns null just below).
  const title = useAppStore((s) => s.agents[agentId]?.title ?? "");
  const customTitle = useAppStore((s) => s.agents[agentId]?.customTitle ?? null);
  const status = useAppStore((s) => s.agents[agentId]?.status);
  const branch = useAppStore((s) => s.agents[agentId]?.branch);
  // `?? ""` keeps it a string (the vanished-record render exercises the empty
  // branch), so the drag handlers can pass it to `agentCwdType` without a fallback.
  const cwd = useAppStore((s) => s.agents[agentId]?.cwd ?? "");
  const unread = useAppStore((s) => s.agents[agentId]?.unread ?? 0);
  // `kind` + `pinned` join the scalar subscriptions (one field each — never the
  // node; see the header's 100%-CPU note).
  const kind = useAppStore((s) => s.agents[agentId]?.kind);
  const pinned = useAppStore((s) => s.agents[agentId]?.pinned ?? false);
  // The "Resumed after restart" marker (open_agents.rs). The marker object is set once
  // at boot and replaced, never mutated, so selecting it compares by reference like a
  // scalar; `error` is the reason a dormant agent was not reopened.
  const restored = useAppStore((s) => s.agents[agentId]?.restored ?? null);
  const error = useAppStore((s) => s.agents[agentId]?.error);
  const selected = useAppStore((s) => s.selection.selectedAgentId === agentId);

  // "Recover session…" lists the root's folder: a sub-agent's work belongs to its root's cwd.
  const rootCwd = useAppStore((s) => rootOf(s.agents, agentId)?.cwd ?? "");
  // For the subtitle's `~` (VISION: `trunk • ~/projects/gazelle`) — fetched once per
  // session for every row, then a plain value.
  const home = useHomeDir();

  const selectAgent = useAppStore((s) => s.agentActions.selectAgent);
  const toggleExpanded = useAppStore((s) => s.agentActions.toggleAgentExpanded);
  // `requestDismissAgent` asks first while the PTY's session is running, else dismisses directly.
  const requestDismissAgent = useAppStore((s) => s.agentActions.requestDismissAgent);
  const renameAgent = useAppStore((s) => s.agentActions.renameAgent);
  const resumeAgent = useResumeAgent();
  const pinAgent = useAppStore((s) => s.agentActions.pinAgent);
  const unpinAgent = useAppStore((s) => s.agentActions.unpinAgent);
  const moveRootAgent = useAppStore((s) => s.agentActions.moveRootAgent);
  const openSessionPickerTab = useAppStore((s) => s.layoutActions.openSessionPickerTab);

  const [editing, setEditing] = useState(false);
  // Right-click menu anchor — screen coords from the contextmenu event;
  // null = closed. The ContextMenu owns every dismissal path.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Local drag chrome only — set in event handlers, never during render, so a row
  // that is not being dragged over keeps the memoized re-render budget.
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);

  // The record can vanish between the parent's flatten and this render.
  if (status === undefined) return null;

  // The user's custom name wins; the caret / close / aria all follow it.
  const displayName = customTitle ?? title;

  // Root-only (sub-agents re-materialize from their root's transcript). Checks kind too: an
  // orphaned sub-agent sits at depth 0 until its parent arrives.
  const isRoot = depth === 0 && kind === "orchestrator";
  const finishedRoot = isRoot && (status === "done" || status === "error");
  const restoredCopy = restored ? restoredMarkerCopy(restored, error) : null;

  // ── drag-to-reorder (root rows only) ──────────────────────────────────────
  // Only ROOT orchestrators reorder; sub-agents are transcript-derived and their
  // order is structural, so they are neither drag sources nor drop targets.
  const onDragStart = (e: DragEvent) => {
    if (!isRoot) return;
    e.dataTransfer.setData(AGENT_DND_MIME, agentId);
    // Markers (empty values) read on dragover: cwd gates to same-folder targets,
    // id suppresses the self-drop indicator. The payload rides on AGENT_DND_MIME.
    e.dataTransfer.setData(agentCwdType(cwd), "");
    e.dataTransfer.setData(agentIdType(agentId), "");
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  };

  const onDragEnd = () => setDragging(false);

  const onDragOver = (e: DragEvent) => {
    if (!isRoot) return;
    const dt = e.dataTransfer;
    if (!dt.types.includes(AGENT_DND_MIME)) return; // not an agent drag
    if (!dt.types.includes(agentCwdType(cwd))) return; // different folder → reject
    if (dt.types.includes(agentIdType(agentId))) return; // dragged over itself
    e.preventDefault();
    dt.dropEffect = "move";
    setDropTarget(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropTarget(false);
  };

  // ── right-click → "Recover session…" ──────────────────────────────────────
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault(); // suppress the OS/webview menu (WorkspaceTree's rule)
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const onDrop = (e: DragEvent) => {
    if (!isRoot || !e.dataTransfer.types.includes(AGENT_DND_MIME)) return;
    e.preventDefault();
    setDropTarget(false);
    const dragged = e.dataTransfer.getData(AGENT_DND_MIME);
    // Same-folder verified by the cwd marker (the "compare on drop" gate); a
    // self-drop is a no-op (moveRootAgent(self, self) would send it to the end).
    if (dragged && dragged !== agentId && e.dataTransfer.types.includes(agentCwdType(cwd))) {
      moveRootAgent(asAgentId(dragged), agentId);
    }
  };

  // Shown only when collapsed: expanded, the children are right there with their
  // own pills, so a summary would be redundant noise.
  const collapsed = hasChildren && !expanded;
  const summary = collapsed ? rollupSummary(rollupRunning, rollupDone, rollupError) : "";
  const showAttention = collapsed && attention;

  const className = [
    "fleet-row",
    selected && "fleet-row--selected",
    depth > 0 && "fleet-row--child",
    (status === "done" || status === "error") && "fleet-row--finished",
    showAttention && "fleet-row--attention",
    dragging && "fleet-row--dragging",
    dropTarget && "fleet-row--drop-target",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className={className}
      style={{ paddingLeft: 10 + depth * INDENT_PX }}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-level={depth + 1}
      tabIndex={selected ? 0 : -1}
      // Root rows are drag-to-reorder handles; a row in inline-rename is frozen so
      // the text drag-select still works (mirrors TabBar). Sub-agents never drag.
      draggable={isRoot && !editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
      onClick={() => selectAgent(agentId)}
      onKeyDown={(e) => {
        // Only when the row itself has focus, or child controls would lose Enter/Space to the row.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectAgent(agentId);
        }
      }}
    >
      <div className="fleet-row__head">
        {/* Reserved even when absent so titles line up across siblings. */}
        <span className="fleet-row__caret">
          {hasChildren && (
            <button
              type="button"
              className="fleet-row__caret-btn"
              aria-label={expanded ? `Collapse ${displayName}` : `Expand ${displayName}`}
              onClick={(e) => {
                e.stopPropagation(); // disclosure is not selection
                toggleExpanded(agentId);
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          )}
        </span>
        {/* The fan-out connector ("↳ explore-codebase").
            A sub-agent reads as descended-from, not just indented. */}
        {depth > 0 && (
          <span className="fleet-row__connector" aria-hidden="true">
            ↳
          </span>
        )}
        {editing ? (
          <InlineEditInput
            className="fleet-row__title-input"
            ariaLabel={`Rename agent ${displayName}`}
            value={displayName}
            onCommit={(name) => {
              setEditing(false);
              renameAgent(agentId, name);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            className="fleet-row__title"
            onDoubleClick={(e) => {
              e.stopPropagation(); // rename, not select
              setEditing(true);
            }}
          >
            {displayName}
          </span>
        )}
        {/* A collapsed subtree with an error below lights up here — the "know
            without expanding" attention signal, bubbled from any depth. */}
        {showAttention && (
          <span
            className="fleet-row__attention-dot"
            role="img"
            aria-label="Attention needed below"
            title="Attention needed below"
          />
        )}
        {unread > 0 && (
          <span className="fleet-row__unread" aria-label={`${unread} unread`}>
            {unread}
          </span>
        )}
        {/* Root agents only. Kept in the DOM (never display:none) so keyboard/AT reach it while
            hover-hidden; pinned rows keep it visible. Pinning is not selecting. */}
        {isRoot && (
          <button
            type="button"
            className={["fleet-row__pin", pinned && "fleet-row__pin--active"]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
            // Every open agent comes back after a restart now (open_agents.rs); what a
            // pin adds is that it comes back even after it ENDED (/exit, a crash).
            title={pinned ? "Unpin agent" : "Pin agent (it comes back on restart even after it ends)"}
            onClick={(e) => {
              e.stopPropagation();
              if (pinned) unpinAgent(agentId);
              else pinAgent(agentId);
            }}
          >
            <PinIcon size={12} filled={pinned} />
          </button>
        )}
        {/* Only on finished roots: a live session is never resumed twice. Not a selection. */}
        {finishedRoot && (
          <button
            type="button"
            className="fleet-row__resume"
            aria-label={`Resume conversation ${displayName}`}
            title="Resume this conversation (claude --resume)"
            onClick={(e) => {
              e.stopPropagation();
              void resumeAgent(agentId, cwd);
            }}
          >
            <ResumeIcon size={12} />
          </button>
        )}
        {/* Dismiss ✕. `stopPropagation` so dismissing does
            not also select the row on its way out. Subtle until hover, but a
            real button — labelled and keyboard-reachable. */}
        <button
          type="button"
          className="fleet-row__close"
          aria-label={`Close agent ${displayName}`}
          title="Close agent"
          onClick={(e) => {
            e.stopPropagation();
            requestDismissAgent(agentId);
          }}
        >
          <CloseIcon size={11} />
        </button>
      </div>
      <div className="fleet-row__status">
        <AgentStatusPill status={status} />
        {/* Roll-up of the hidden subtree — the payoff of collapsing a wall of
            children: know its health at a glance. */}
        {summary && <span className="fleet-row__rollup">{summary}</span>}
        {/* "Resumed after restart" — until its next turn (open_agents.rs). Text, not
            only a tooltip: "was working" is the one thing the user must not miss. */}
        {restoredCopy && (
          <span className="fleet-row__restored" title={restoredCopy.tooltip}>
            {restoredCopy.label}
          </span>
        )}
      </div>
      {/* Two parts so a long path clips at its head, never the branch; the title has it all. */}
      <div className="fleet-row__meta" title={branch ? `${branch} • ${cwd}` : cwd}>
        {branch ? (
          <>
            <span className="fleet-row__branch">{branch}</span>
            <span className="fleet-row__sep"> • </span>
          </>
        ) : null}
        <span className="fleet-row__cwd">
          <bdi dir="ltr">{tildeHome(cwd, home)}</bdi>
        </span>
      </div>
      {/* Right-click menu. One item: open the folder's past-sessions
          picker. The FOLDER is the root's cwd (see `rootCwd`), so the same
          picker tab serves a whole subtree — the store dedupes it by cwd. */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`Actions for agent ${displayName}`}
          onClose={() => setMenu(null)}
          items={[
            ...(finishedRoot
              ? [{ label: "Resume conversation", onSelect: () => void resumeAgent(agentId, cwd) }]
              : []),
            {
              label: "Recover session…",
              onSelect: () => openSessionPickerTab(rootCwd),
            },
          ]}
        />
      )}
    </li>
  );
}

export const AgentRow = memo(AgentRowImpl);
