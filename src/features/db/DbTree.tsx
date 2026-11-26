/** One connection's object tree plus saved queries, modelled on `WorkspaceTree`: lazy expand,
 * cached, a failed level is an inline note with Retry. No hierarchy is hardcoded; it renders what
 * `db_children` returns. Drag-to-reorder reuses the fleet rail's DnD (`AgentRow.tsx`). */

import { useEffect, useState, type DragEvent } from "react";

import { useAppStore } from "../../app/store";
import { ChevronIcon, DatabaseIcon, FileIcon, FolderIcon, LockIcon } from "../../components/icons";
import { modChord } from "../shortcuts/shortcuts";
import type { DbGroupId, DbNodeKindWire, DbNodeRefWire, DbTreeNode } from "./dbIpc";
import {
  blankDbTree,
  browseQuery,
  isBrowsable,
  levelStatus,
  nodeKey,
  rowKey,
  SAVED_QUERIES_KEY,
  savedQueryCountLabel,
  savedQueryNodes,
} from "./dbTreeFormat";
import { applyOrder } from "./treeOrder";
import type { DbFamily } from "./types";
import "./db.css";

/** px per depth level. The Files tree's number, so the two rails indent identically. */
const INDENT = 12;

/* ───────────────────────── drag-to-reorder: the wire ───────────────────────── */

/** The value is the node's label (unique among siblings; `nodeRef` is not an identity). A DB-only
 * MIME so table, agent-row, saved-request and tab drags never accept one another. */
export const DB_NODE_DND_MIME = "application/x-agentstudio-db-node";

/** `dragover` can read only type names, so the parent level is encoded in one to keep a reorder
 * inside its level. Lowercased per the DnD spec; case-only sibling names fold together, but the
 * store's `moveBefore` makes such a drop a no-op. */
export function dbParentType(parentKey: string): string {
  return `${DB_NODE_DND_MIME}-parent:${parentKey}`.toLowerCase();
}

/** The dragged row's own label, read on `dragover` to suppress the self-drop cue. */
export function dbLabelType(label: string): string {
  return `${DB_NODE_DND_MIME}-label:${label}`.toLowerCase();
}

/** The groups whose children a user may sort. See `isReorderableLevel`. */
const REORDERABLE_GROUPS: readonly DbGroupId[] = ["tables", "views", "collections"];

/** Only children of a tables/views/collections group: column order is data, databases/schemas
 * are containers, and Redis keys are a truncated, changing SCAN. */
function isReorderableLevel(parentRef: DbNodeRefWire): boolean {
  return parentRef.kind === "group" && REORDERABLE_GROUPS.includes(parentRef.group);
}

/** A stable id for one rendered row, for the two bits of local drag chrome. */
function rowId(parentKey: string, label: string): string {
  return `${parentKey}#${label}`;
}

/** "Nobody has arranged this level", as ONE instance: a fresh `[]` per row per render is
 *  garbage a tree with 400 tables in it does not need to make. */
const NO_ORDER: readonly string[] = [];

/** Deliberately coarse (tables and views share a glyph); the group and `subLabel` differ. */
function NodeIcon({ kind }: { kind: DbNodeKindWire }): React.JSX.Element {
  switch (kind) {
    case "database":
      return <DatabaseIcon size={12} />;
    case "schema":
    case "group":
      return <FolderIcon size={12} />;
    case "savedQuery":
      // A padlock would be wrong and a database cylinder would be wrong; a saved query is a
      // document, and it is the same glyph the Files tree uses for one.
      return <FileIcon size={12} />;
    case "key":
      return <LockIcon size={12} />;
    default:
      // table / view / collection / column — the leaf-ish kinds.
      return <FileIcon size={12} />;
  }
}

/** "Never read" and "being read" look the same on purpose: the fetch is about to happen. */
function LoadingNote(): React.JSX.Element {
  return (
    <li className="db-tree__note" role="none" data-testid="db-tree-note" data-note="loading">
      Loading&hellip;
    </li>
  );
}

/** Starts the read for an `idle` level, so a level `refreshDbTree` dropped reloads. A component
 * because a render must not have side effects. `nodeRef` in deps is safe: `loadDbChildren` marks
 * the level loading synchronously, which unmounts this. */
function IdleLevel({
  connectionId,
  sessionId,
  nodeRef,
  load,
}: {
  connectionId: string;
  sessionId: string;
  nodeRef: DbNodeRefWire;
  load: (
    connectionId: string,
    sessionId: string,
    node: DbNodeRefWire,
    force?: boolean,
  ) => Promise<void>;
}): React.JSX.Element {
  useEffect(() => {
    void load(connectionId, sessionId, nodeRef);
  }, [connectionId, sessionId, nodeRef, load]);
  return <LoadingNote />;
}

export interface DbTreeProps {
  connectionId: string;
  /** The engine family, for the browse query's identifier quoting. */
  family: DbFamily;
  /** The connection's row limit — the cap it promises, used in the browse statement. */
  rowLimit: number;
  /** `null` while opening or after a failed connect; saved queries render either way. */
  sessionId: string | null;
}

export function DbTree({
  connectionId,
  family,
  rowLimit,
  sessionId,
}: DbTreeProps): React.JSX.Element {
  const tree = useAppStore((s) => s.dbTrees[connectionId]) ?? blankDbTree();
  const savedList = useAppStore((s) => s.dbSavedQueries[connectionId]);
  // parentKey → the labels this connection's user put that level in. One subscription for the
  // whole connection rather than one per level: the record is replaced wholesale by the store,
  // so a per-level selector would buy nothing and cost a hook per row.
  const orders = useAppStore((s) => s.dbTreeOrders[connectionId]);
  const {
    loadDbChildren,
    toggleDbNode,
    loadDbSavedQueries,
    openDbSavedQuery,
    openDbQueryInConsole,
    deleteDbSavedQuery,
    loadDbTreeOrder,
    moveDbTreeNode,
    resetDbTreeOrder,
  } = useAppStore((s) => s.dbActions);

  // Drag chrome only, and only ever written from an event handler — never during render, so a
  // tree that nobody is dragging over pays nothing for the feature. Each holds a `rowId`.
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);

  // The root loads via `<IdleLevel/>` once there is a session (expanding the row is the first
  // expand). `loadDbChildren` is idempotent, so a re-render issues no second call.

  // The saved queries load once per mount and need no session at all.
  useEffect(() => {
    void loadDbSavedQueries(connectionId);
  }, [connectionId, loadDbSavedQueries]);

  // Load the saved arrangement too, or it comes back alphabetical after a relaunch. A separate
  // effect so a rejection in either load cannot take the other with it.
  useEffect(() => {
    void loadDbTreeOrder(connectionId);
  }, [connectionId, loadDbTreeOrder]);

  const savedOpen = tree.expanded[SAVED_QUERIES_KEY] === true;
  const queries = savedList?.queries ?? [];

  /** `session` is passed explicitly: only the `Saved queries` node passes `null`, which the store
   * handles (`isServerAnswered`). */
  const toggle = (ref: DbNodeRefWire, session: string | null): void => {
    toggleDbNode(connectionId, session, ref);
  };

  /** Double-click a table/view/collection: put a browse statement in the console. */
  const browse = (node: DbTreeNode): void => {
    // Both checks matter: a column carries its table's `nodeRef`, and a malformed wire node could
    // pair a browsable kind with a non-table ref.
    if (!isBrowsable(node.kind)) return;
    if (node.nodeRef.kind !== "table") return;
    const sql = browseQuery(family, node.nodeRef, rowLimit);
    // `null` = this engine has no defensible browse query (Redis). The double-click then does
    // nothing beyond the expand it already triggered, rather than opening a console with a
    // command this build has never run.
    if (sql === null) return;
    openDbQueryInConsole(connectionId, sql);
  };

  /* Drag-to-reorder: a table lands only among its siblings. Every handler returns early unless
   * `reorderable`, so an ineligible row is inert as source and as target. */

  const onDragStart = (e: DragEvent, parentKey: string, label: string, reorderable: boolean) => {
    if (!reorderable) return;
    e.dataTransfer.setData(DB_NODE_DND_MIME, label);
    // The markers (empty values) the `dragover` gate reads — see `dbParentType`. The payload
    // itself rides on `DB_NODE_DND_MIME`, where only the drop can read it.
    e.dataTransfer.setData(dbParentType(parentKey), "");
    e.dataTransfer.setData(dbLabelType(label), "");
    e.dataTransfer.effectAllowed = "move";
    setDragRow(rowId(parentKey, label));
  };

  const onDragOver = (e: DragEvent, parentKey: string, label: string, reorderable: boolean) => {
    if (!reorderable) return;
    const dt = e.dataTransfer;
    // Each `return` here is a REFUSAL, and the refusal is the missing `preventDefault`: a
    // `dragover` that does not preventDefault is how the browser is told this element does not
    // take the drop (and is what stops the cursor promising one).
    if (!dt.types.includes(DB_NODE_DND_MIME)) return; // not a DB-node drag at all
    if (!dt.types.includes(dbParentType(parentKey))) return; // another level → refuse
    if (dt.types.includes(dbLabelType(label))) return; // dragged over itself → no-op
    e.preventDefault();
    dt.dropEffect = "move";
    setDropRow(rowId(parentKey, label));
  };

  const onDragLeave = (e: DragEvent) => {
    // Without this the cue strobes: moving the cursor from the row onto the row's OWN caret or
    // label fires a `dragleave` for the row, whose `relatedTarget` is that child.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropRow(null);
  };

  const onDrop = (e: DragEvent, parentKey: string, label: string, reorderable: boolean) => {
    if (!reorderable || !e.dataTransfer.types.includes(DB_NODE_DND_MIME)) return;
    e.preventDefault();
    setDropRow(null);
    const dragged = e.dataTransfer.getData(DB_NODE_DND_MIME);
    // Belt and braces, exactly as `AgentRow` does it: `dragover` already refused a foreign
    // level and a self-drop, but a drop can arrive on a row that never saw a `dragover` (a
    // fast drag, or a synthetic event), and this is the check that cannot be skipped that way.
    if (!dragged || dragged === label) return;
    if (!e.dataTransfer.types.includes(dbParentType(parentKey))) return;
    // The dragged table lands above the row it was dropped on; "put it last" has no gesture yet.
    moveDbTreeNode(connectionId, parentKey, dragged, label);
  };

  /** Takes the session as an argument: every path here already has one, and a null check in Retry
   * would be an unreachable branch. */
  const renderLevel = (
    parentRef: DbNodeRefWire,
    depth: number,
    session: string,
  ): React.JSX.Element => {
    // The parent's REF, threaded down as we recurse, not looked up from the key. See
    // `dbTreeFormat.ts`'s note on why there is no `refForKey`: every reverse-lookup version had
    // a `null` branch no click could reach.
    const parentKey = nodeKey(parentRef);
    const status = levelStatus(tree, parentKey);
    // `idle` = never read, or invalidated by `refreshDbTree`: same note as `loading`, and
    // `<IdleLevel/>` starts the fetch, so a refresh keeps the user's expanded shape.
    if (status === "idle") {
      return (
        <IdleLevel
          connectionId={connectionId}
          sessionId={session}
          nodeRef={parentRef}
          load={loadDbChildren}
        />
      );
    }
    if (status === "loading") return <LoadingNote />;
    if (status === "failed") {
      return (
        <li className="db-tree__note db-tree__note--error" role="none">
          {/* Inline, on the node, with a way forward. `role="alert"` so it is announced
              without stealing focus, and the Retry `force`s past the cached failure (a Retry
              that the cache short-circuits is a button that cannot succeed). */}
          <span role="alert" data-testid="db-tree-error">
            {tree.failed[parentKey]}
          </span>
          <button
            type="button"
            className="db-tree__retry"
            data-testid="db-tree-retry"
            onClick={() => void loadDbChildren(connectionId, session, parentRef, true)}
          >
            Retry
          </button>
        </li>
      );
    }
    const nodes = tree.children[parentKey];
    if (nodes.length === 0) {
      // "Expand it and find nothing" is the honest answer `tree.rs` deliberately keeps
      // expandable for — an empty schema still has a chevron, because pre-counting every
      // level would cost a query per node just to draw one.
      return (
        <li className="db-tree__note" role="none" data-testid="db-tree-note" data-note="empty">
          Nothing here.
        </li>
      );
    }
    // The one place siblings become rows, so the user's order is applied here, unconditionally:
    // only reorderable levels ever get one. Unnamed tables land at the bottom.
    const ordered = applyOrder(nodes, (n) => n.label, orders?.[parentKey] ?? NO_ORDER);
    const reorderable = isReorderableLevel(parentRef);
    return (
      <>{ordered.map((node, i) => renderNode(node, i, parentKey, depth, session, reorderable))}</>
    );
  };

  const renderNode = (
    node: DbTreeNode,
    index: number,
    parentKey: string,
    depth: number,
    session: string,
    /** May THIS row be dragged, and may it accept a drop? A property of its level. */
    reorderable: boolean,
  ): React.JSX.Element => {
    const key = nodeKey(node.nodeRef);
    const open = node.expandable && tree.expanded[key] === true;
    const id = rowId(parentKey, node.label);
    // A GROUP row owns the reset affordance for the level BELOW it — `key` is that level's
    // parentKey — and only shows it once that level actually carries a hand-made order.
    const resettable = isReorderableLevel(node.nodeRef) && (orders?.[key]?.length ?? 0) > 0;
    return (
      <li
        key={rowKey(parentKey, index, node)}
        role="treeitem"
        aria-expanded={node.expandable ? open : undefined}
      >
        <div
          className={[
            "db-tree__row",
            dragRow === id && "db-tree__row--dragging",
            dropRow === id && "db-tree__row--drop-target",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ paddingLeft: depth * INDENT + 8 }}
          data-testid="db-tree-row"
          data-kind={node.kind}
          data-label={node.label}
          title={node.subLabel === null ? node.label : `${node.label} — ${node.subLabel}`}
          // Only a table-ish child of a Tables/Views/Collections group is a handle; every
          // other row says so in the DOM (`draggable="false"`), so the browser never starts a
          // drag the handlers would have had to refuse.
          draggable={reorderable}
          onDragStart={(e) => onDragStart(e, parentKey, node.label, reorderable)}
          onDragEnd={() => setDragRow(null)}
          onDragOver={(e) => onDragOver(e, parentKey, node.label, reorderable)}
          onDragLeave={onDragLeave}
          onDrop={(e) => onDrop(e, parentKey, node.label, reorderable)}
          onClick={() => {
            if (node.expandable) toggle(node.nodeRef, session);
          }}
          onDoubleClick={() => browse(node)}
        >
          {/* A node with `expandable: false` has no chevron — but keeps the same indent, or
              every column in a table would sit 12px left of its siblings. */}
          {node.expandable ? (
            <span className={`db-tree__caret${open ? " is-open" : ""}`}>
              <ChevronIcon size={11} />
            </span>
          ) : (
            <span className="db-tree__caret db-tree__caret--none" aria-hidden="true" />
          )}
          <span className="db-tree__icon">
            <NodeIcon kind={node.kind} />
          </span>
          <span className="db-tree__label">{node.label}</span>
          {node.subLabel !== null && (
            <span className="db-tree__sub" data-testid="db-tree-sub">
              {node.subLabel}
            </span>
          )}
          {/* Shown only once a level is arranged, as the way back and the sign of a custom order.
              `stopPropagation`: the group row's click is its disclosure. */}
          {resettable && (
            <button
              type="button"
              className="db-tree__reset"
              data-testid="db-tree-reset-order"
              aria-label={`Reset order of ${node.label}`}
              title="Reset to alphabetical order"
              onClick={(e) => {
                e.stopPropagation();
                resetDbTreeOrder(connectionId, key);
              }}
            >
              Reset order
            </button>
          )}
        </div>
        {open && (
          <ul className="db-tree__children" role="group">
            {renderLevel(node.nodeRef, depth + 1, session)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="db-tree" data-testid={`db-tree-${connectionId}`}>
      <ul className="db-tree__list" role="tree" aria-label="Database objects">
        {sessionId === null ? (
          <li className="db-tree__note" role="none" data-testid="db-tree-no-session">
            Databases and tables need an open session. Your saved queries are below either way.
          </li>
        ) : (
          renderLevel({ kind: "root" }, 0, sessionId)
        )}

        {/* Synthetic, and open by default: double-clicking a database must show its
            saved queries. */}
        <li role="treeitem" aria-expanded={!savedOpen}>
          <div
            className="db-tree__row"
            style={{ paddingLeft: 8 }}
            data-testid="db-saved-queries-node"
            onClick={() => toggle({ kind: "savedQueries" }, sessionId)}
          >
            {/* `savedOpen` is inverted throughout: the default (absent from `expanded`) is
                OPEN here, so the flag records "the user collapsed it". */}
            <span className={`db-tree__caret${savedOpen ? "" : " is-open"}`}>
              <ChevronIcon size={11} />
            </span>
            <span className="db-tree__icon">
              <FolderIcon size={12} />
            </span>
            <span className="db-tree__label">Saved queries</span>
            <span className="db-tree__sub" data-testid="db-saved-queries-count">
              {savedList?.loading === true ? "loading…" : savedQueryCountLabel(queries.length)}
            </span>
          </div>
          {!savedOpen && (
            <ul className="db-tree__children" role="group">
              {savedList?.error != null && (
                <li className="db-tree__note db-tree__note--error" role="none">
                  <span role="alert" data-testid="db-saved-queries-error">
                    {savedList.error}
                  </span>
                </li>
              )}
              {queries.length === 0 && savedList?.loading !== true && (
                <li className="db-tree__note" role="none" data-testid="db-saved-queries-empty">
                  Nothing saved yet. {modChord("S")} in a console names and saves the query in it.
                </li>
              )}
              {savedQueryNodes(queries).map((node, i) => (
                <li key={rowKey(SAVED_QUERIES_KEY, i, node)} role="treeitem">
                  <div
                    className="db-tree__row"
                    style={{ paddingLeft: INDENT + 8 }}
                    data-testid="db-saved-query-row"
                    data-label={node.label}
                    title={node.subLabel ?? node.label}
                    // A single click, not a double: this is a list of things whose only
                    // action is "open me", and the tree's double-click is already spoken for
                    // by browse. Opening one adopts its id, so the next ⌘S updates it.
                    onClick={() => openDbSavedQuery(connectionId, queries[i])}
                  >
                    <span className="db-tree__caret db-tree__caret--none" aria-hidden="true" />
                    <span className="db-tree__icon">
                      <NodeIcon kind={node.kind} />
                    </span>
                    <span className="db-tree__label">{node.label}</span>
                    {node.subLabel !== null && (
                      <span className="db-tree__sub">{node.subLabel}</span>
                    )}
                    <button
                      type="button"
                      className="db-tree__del"
                      aria-label={`Delete saved query ${node.label}`}
                      onClick={(e) => {
                        // Without this the click also opens the query into a console, so the
                        // last thing a user sees after deleting is the deleted SQL.
                        e.stopPropagation();
                        void deleteDbSavedQuery(connectionId, queries[i].id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>
    </div>
  );
}
