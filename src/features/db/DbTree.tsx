/**
 * DbTree — one connected connection's object tree, plus its saved queries.
 *
 * The join between Rust's `db_children` and the rail. Each half can be 100% covered on its own
 * and still not add up to a feature, which is why the seam between them is what gets tested.
 *
 * ── The shape is `WorkspaceTree`'s, on purpose ───────────────────────────────
 * `tree.rs` says so in its own header: `db_children` is deliberately modelled on
 * `read_dir`/`FsEntry` so the frontend's lazy-expand, cache and error-note behaviour is a
 * pattern that already exists here. So: one call per first expand, a `Loading…` note while a
 * level lands, cached across collapse, and **a failed expand is a calm inline note on that
 * node with a Retry** — never a panel-level error, because a dropped VPN must not take the rail
 * down. The one deliberate divergence from `WorkspaceTree` is where the cache lives (the store,
 * not `useState`) and it is argued in `DbState.dbTrees`.
 *
 * ── Nothing about the hierarchy is hardcoded ─────────────────────────────────
 * There is no "database → schema → tables" anywhere in this file. `tree.rs` explains why there
 * cannot be: PostgreSQL shows only its connected database (a connection cannot read another's
 * catalog), MySQL and ClickHouse list every database on the server, and MySQL has no schema
 * level at all because its schemata ARE its databases. The tree renders whatever `db_children`
 * returns and asks again wherever `expandable` is true. An engine whose shape changes needs no
 * change here — which is also why the icon map switches on `DbNode.kind` rather than on depth.
 *
 * ── Double-click a table → a browse query ────────────────────────────────────
 * 🔴 The statement is INVENTED. There is no "`browse_template` query": `EngineSpec` has no
 * such field on either side of the wire — see `dbTreeFormat.ts`'s header
 * for what was written instead and why it is conservative about the row limit and quoting.
 *
 * ── Drag a table to sort it ─────────────────────────────────────────────────
 * Tables can be moved into any order the user chooses, for example turning A,B,C into
 * C,B,A. A table row is a drag handle; dropping it on a sibling puts it
 * immediately BEFORE that sibling, and the resulting order is persisted per connection by the
 * store. Everything that is not "a table-ish child of a Tables/Views/Collections group" is
 * neither a source nor a target, and the two halves of that gate are argued on
 * `isReorderableLevel`. The DnD mechanics are the fleet rail's, copied deliberately rather
 * than re-invented — see `AgentRow.tsx`'s `agentCwdType` for the protected-mode trick the
 * marker types below exist for.
 */

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

/**
 * Drag payload for reordering a table row. The VALUE is the dragged node's **label**, which is
 * this feature's whole notion of child identity: `nodeRef` is not one (every column of a table
 * carries the table's ref — `dbIpc.ts`), and a table name is unique among its siblings by the
 * database's own rules. The drop target reads it back and calls `moveDbTreeNode`.
 *
 * A DB-specific MIME so a table drag, an agent-row drag (`AGENT_DND_MIME`), a saved-request
 * drag and a centre-pane tab drag never accept one another.
 */
export const DB_NODE_DND_MIME = "application/x-agentstudio-db-node";

/**
 * A `dragover`-readable marker encoding the dragged row's **parent level**.
 *
 * `dataTransfer` VALUES are unreadable during `dragover` (protected mode until the drop), but
 * the TYPE list is — so every fact the gate needs is smuggled into a type name. This one is
 * what makes a reorder stay inside one level: dragging `tracks` out of `public` and into
 * `legacy` is not a sort, it is a `ALTER TABLE … SET SCHEMA` we have no business implying.
 *
 * Lowercased because the HTML5 DnD spec lowercases every format string. ⚠️ The known cost:
 * two sibling schemas differing only in case (`Public` / `public` — PostgreSQL allows it) fold
 * to one marker, so a cross-level drag between exactly those two would be accepted. The damage
 * is bounded to nothing: the store's `moveBefore` returns the order unchanged for a key that
 * is not in the level, so the drop is a no-op rather than a corrupted order.
 */
export function dbParentType(parentKey: string): string {
  return `${DB_NODE_DND_MIME}-parent:${parentKey}`.toLowerCase();
}

/**
 * A marker encoding the dragged row's own label — read on `dragover` to suppress the
 * self-drop cue, because dropping a row on itself is a click, not a move. Same protected-mode
 * rationale as `dbParentType`.
 */
export function dbLabelType(label: string): string {
  return `${DB_NODE_DND_MIME}-label:${label}`.toLowerCase();
}

/** The groups whose children a user may sort. See `isReorderableLevel`. */
const REORDERABLE_GROUPS: readonly DbGroupId[] = ["tables", "views", "collections"];

/**
 * May the children of `parentRef` be dragged into a user-chosen order?
 *
 * Only the children of a `tables` / `views` / `collections` group, and the exclusions are the
 * argued part:
 *
 * * **Columns** — their order IS data. It is the ordinal position the server returns, it is
 *   what `SELECT *` and `INSERT … VALUES` use, and a UI that let someone "sort" it would be
 *   showing a lie about the table.
 * * **Databases and schemas** — a level whose children are containers, not the wall of 400
 *   names the feature is about; and on PostgreSQL the database level has exactly one
 *   row in it.
 * * **Redis `keys`** — dynamic and truncated (`tree.rs` caps the SCAN), so a saved order would
 *   be a snapshot of a keyspace that has already changed, most of whose entries `applyOrder`
 *   would be skipping by the next expand.
 */
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

/**
 * The glyph per `DbNode.kind`.
 *
 * Reuses `components/icons.tsx` rather than drawing nine more SVGs: those exports are shared
 * chrome (unlike `DbConsole`'s Run/Stop triangles, which are feature-specific and were kept
 * local so the shared icon file stays generic). The mapping is intentionally coarse
 * — a table and a view get the same file glyph — because inventing five near-identical
 * cylinder variants would cost a reader more than it tells them; the `subLabel` and the group
 * they sit under are what distinguish a view from a table.
 */
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

/**
 * The note a level shows while it has nothing to show yet.
 *
 * "Never read" and "being read" deliberately look identical: the fetch IS about to happen, and
 * a separate "not read yet" note would flash for one tick and say something less true.
 */
function LoadingNote(): React.JSX.Element {
  return (
    <li className="db-tree__note" role="none" data-testid="db-tree-note" data-note="loading">
      Loading&hellip;
    </li>
  );
}

/**
 * An `idle` level — and the thing that goes and reads it.
 *
 * 🔴 **This is where "idle means fetch it" became true everywhere**, and it is half of the fix
 * for the stale-tree bug. Before that fix, the only thing that ever kicked a
 * `db_children` was `<DbTree/>`'s ROOT mount effect plus `toggleDbNode`'s first expand — so a
 * level whose cache `refreshDbTree` had just dropped would have sat on "Loading…" for ever,
 * because nothing remounts and nothing re-toggles. Making the *renderer* own the lazy read
 * removes that gap and, incidentally, removes the reverse lookup the fix seemed to need:
 * `dbTreeFormat.ts` documents at length that there is no `refForKey`, and there does not need
 * to be — `renderLevel` already holds the ref of the level it is rendering.
 *
 * It is a component rather than a call in `renderLevel` because **a render must not have side
 * effects**. `nodeRef` sits in the dependency list even though the parent rebuilds that object
 * on every render, which would normally be a re-run-for-ever smell: it is safe and cheap here
 * because `loadDbChildren` marks the level `loading` synchronously, which takes it out of
 * `idle` and unmounts this component on the very next render — and because a call that finds
 * the level already in flight or already cached returns without touching the store, so it
 * cannot feed itself.
 */
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
  /**
   * The live session, or `null` when the row is expanded but not connected (opening, or
   * failed). Server-answered levels need one; the saved queries do NOT, which is why they
   * render either way — the saved queries must survive an unreachable database.
   */
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

  // The ROOT level loads as soon as there is a session, because expanding the connection row
  // IS the first expand — the disclosure in `<DbPanel/>` is the connect gesture, so
  // making the user click a second chevron to see anything would be a level of the tree with
  // no name. That used to be a mount effect here; it is now `<IdleLevel/>`, because the root
  // is simply the first level that is `idle` and one mechanism that handles every level beats
  // two that handle one each (the mount effect could not re-read an invalidated level — see
  // `IdleLevel`'s note). `loadDbChildren` is idempotent, so a re-render (or a rail-tab remount
  // over a warm cache) still issues no second call.

  // The saved queries load once per mount and need no session at all.
  useEffect(() => {
    void loadDbSavedQueries(connectionId);
  }, [connectionId, loadDbSavedQueries]);

  // 🔴 And so does the saved ARRANGEMENT, for exactly the same reason and with the same
  // shape. Without this read the feature works perfectly all afternoon and comes back
  // alphabetical after a relaunch — `dbTreeOrders` would only ever hold what this session's
  // own drags put there, which is the failure a user finds and no test does. It is a
  // separate effect from the queries' so a rejection in either cannot take the other with it
  // (neither rejects today; that is the store's promise, not this component's).
  useEffect(() => {
    void loadDbTreeOrder(connectionId);
  }, [connectionId, loadDbTreeOrder]);

  const savedOpen = tree.expanded[SAVED_QUERIES_KEY] === true;
  const queries = savedList?.queries ?? [];

  /**
   * Expand/collapse a node.
   *
   * `session` is threaded explicitly rather than read from the closure because
   * `renderLevel`/`renderNode` are only ever reached with a live one — see `renderLevel`'s
   * note. The `Saved queries` node is the one caller that passes a possibly-`null` session,
   * and the store is where that is handled (`isServerAnswered`).
   */
  const toggle = (ref: DbNodeRefWire, session: string | null): void => {
    toggleDbNode(connectionId, session, ref);
  };

  /** Double-click a table/view/collection: put a browse statement in the console. */
  const browse = (node: DbTreeNode): void => {
    // Two checks, and neither is redundant. `isBrowsable` is what stops a double-click on a
    // COLUMN browsing: a column node carries its table's `nodeRef` (`tree.rs`), so the ref
    // check alone would pass. The ref check is what stops a malformed wire node — the two
    // fields are independent by design, so a `collection` kind arriving on a `database` ref is
    // expressible, and building `SELECT * FROM …` from it would produce nonsense SQL.
    if (!isBrowsable(node.kind)) return;
    if (node.nodeRef.kind !== "table") return;
    const sql = browseQuery(family, node.nodeRef, rowLimit);
    // `null` = this engine has no defensible browse query (Redis). The double-click then does
    // nothing beyond the expand it already triggered, rather than opening a console with a
    // command this build has never run.
    if (sql === null) return;
    openDbQueryInConsole(connectionId, sql);
  };

  /* ──────────────────────── drag-to-reorder: the handlers ──────────────────────
     The fleet rail's shape (`AgentRow.tsx`), with `parentKey` where it has a folder: a table
     may only land among the tables it was already among. Every handler takes `reorderable`
     and returns early when it is false, so an ineligible row is inert as a SOURCE and as a
     TARGET — a column that refuses to be dragged but happily accepts a drop would be half a
     gate, and the half nobody notices is the one that reorders the wrong level. */

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
    // `before` is always a label here — a row is what one drops ON, and the dragged table
    // lands immediately above it. The contract's `null` ("put it last") has no gesture in this
    // tree yet: it would need an empty strip below the last row, which is a different design
    // question from the one this answers.
    moveDbTreeNode(connectionId, parentKey, dragged, label);
  };

  /**
   * One level's rows, or the note that stands in for them.
   *
   * Takes the session as an argument because every path into it has already established that
   * there is one (the `sessionId === null` arm below renders a note instead). Threading it
   * beats a `null` check inside Retry that no click could ever reach — an untestable dead
   * branch is what the coverage ratchet is for.
   */
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
    // `idle` = never read, or read and then invalidated by `refreshDbTree`. It renders the
    // same note as `loading` on purpose (the fetch IS about to happen) and it also STARTS that
    // fetch — see `<IdleLevel/>`. Originally only the root could be idle, because only
    // the root had an effect behind it; now any level can be, which is what makes a refresh
    // that preserves the user's expanded shape possible at all.
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
    // 🔴 The ONE place a sibling list becomes rows, which is why the user's order is applied
    // exactly here and nowhere else. Applied unconditionally rather than only on a reorderable
    // level: an order can only ever have been WRITTEN for one (the drag gate above is what
    // decides that), and honouring whatever is saved keeps the renderer from having a second,
    // subtly different opinion about eligibility. `applyOrder` appends anything the order does
    // not name — a table created since the drag lands at the bottom rather than vanishing.
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
          {/* Back to alphabetical. A BUTTON, not a right-click item, because that is this
              panel's stated house style (`DbPanel.tsx`: "a control that needs a right-click is
              a control half this rail's users will never find") and because the DB tree has no
              context menu at all to hang one on. Last in the row (pushed right by
              `margin-left: auto`, like the saved query's ✕) so it never displaces the label or
              the count the user is actually reading.
              It appears only once the level has been arranged, which makes it two affordances
              in one: the way out, and the only on-screen sign that this level is no longer in
              the server's order. `stopPropagation` because the group row's click is its
              disclosure — resetting must not also collapse the thing you were looking at. */}
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

        {/* The `Saved queries` node. Synthetic — it is not a row
            `db_children` returned — and OPEN by default, because the requirement is
            that double-clicking a database shows its list of queries, and a node that
            needs one more click to reveal them does not satisfy that requirement. */}
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
