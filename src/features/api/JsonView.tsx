/** Tree for an ALREADY-PARSED value, depth-capped (MAX_DEPTH). With onSelectKey keys are buttons
 * beside a caret-only toggle (buttons can't nest); key elements carry data-key for ComparePanel.
 * Search counts within one key/primitive slot, never summaries; nodes with hits are pinned open. */

import { useState } from "react";

import { listMatches, type MatchRange } from "../editor/find/findModel";
import { markMatches } from "./matchMarks";
import "./jsonview.css";

/** Past this nesting depth a collapsible node renders a summary, not children. */
const MAX_DEPTH = 100;

/** A single object entry or array item: its label prefix + child value. */
type Entry = readonly [key: string, value: unknown];

/** Shared by the renderer and searchJsonTree: find ordinals must follow row order. */
function entriesOf(value: unknown): Entry[] | null {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v, i) => [String(i), v] as const);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>);
  }
  return null;
}

/** The two searchable text slots a row can own. */
type SlotKind = "k" | "v";

/** U+0001 can't appear in a JSON key except as an escape. Shared by walk and render so both
 * build identical paths. */
const PATH_SEP = "\u0001";
const childPath = (path: string, key: string): string =>
  `${path}${PATH_SEP}${key}`;
const slotId = (path: string, kind: SlotKind): string => `${path}${PATH_SEP}${kind}`;

/** The matches inside one slot's text, plus the ordinal of its FIRST match. */
export interface TreeSlot {
  matches: MatchRange[];
  offset: number;
}

/** Everything the tree needs to draw one query's hits. See the docblock above. */
export interface TreeSearch {
  /** Total matched substrings across every rendered key name and value. */
  total: number;
  /** Keyed by `slotId(path, kind)`; absent means "this slot has no hit". */
  slots: Map<string, TreeSlot>;
  /** Paths of nodes pinned open because a match lives somewhere inside them. */
  pinned: Set<string>;
}

/** Match semantics come from findModel (shared with the editor and Raw view). Query non-empty. */
export function searchJsonTree(value: unknown, query: string): TreeSearch {
  const spec = {
    search: query,
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
  };
  const slots = new Map<string, TreeSlot>();
  const pinned = new Set<string>();
  let total = 0;

  /** Register a slot's hits, in render order. True when it had any. */
  const addSlot = (path: string, kind: SlotKind, text: string): boolean => {
    const matches = listMatches(spec, text);
    if (matches.length === 0) return false;
    slots.set(slotId(path, kind), { matches, offset: total });
    total += matches.length;
    return true;
  };

  /** True when this node — its own key, or anything under it — matched. */
  const walk = (
    path: string,
    nodeKey: string | undefined,
    v: unknown,
    depth: number,
  ): boolean => {
    // The key renders before the value, so it is counted before it too.
    let hit = nodeKey !== undefined && addSlot(path, "k", nodeKey);
    const entries = entriesOf(v);
    if (entries === null) return addSlot(path, "v", primitiveView(v).text) || hit;
    // An empty container and a depth-capped one both render WITHOUT children
    // (bare brackets / a summary), so neither has anything more to search.
    if (entries.length > 0 && depth < MAX_DEPTH) {
      let inside = false;
      for (const [k, child] of entries) {
        if (walk(childPath(path, k), k, child, depth + 1)) inside = true;
      }
      if (inside) pinned.add(path);
      hit = hit || inside;
    }
    return hit;
  };

  walk("", undefined, value, 0);
  return { total, slots, pinned };
}

/** What the find bar hands the tree: where the hits are, and which is current. */
interface Find {
  search: TreeSearch | null;
  current: number;
}

/** No search running — the shape every existing caller renders with. */
const NO_FIND: Find = { search: null, current: 0 };

/** One slot's text with its hits marked, or the bare text when it has none. */
function marked(
  text: string,
  path: string,
  kind: SlotKind,
  find: Find,
): React.ReactNode {
  const slot = find.search?.slots.get(slotId(path, kind));
  if (slot === undefined) return text;
  // `current - offset` lands inside this slot's own match list only for the
  // slot that actually holds the cursor; every other slot gets an out-of-range
  // index, which `markMatches` reads as "none of these is current".
  return markMatches(text, slot.matches, find.current - slot.offset);
}

/** The A/B-compare selection surface, threaded through the whole tree. */
type SelectionProps = {
  /** Key NAME to highlight everywhere it appears (A/B compare cross-highlight). */
  selectedKey?: string | null;
  /** When provided, key labels become clickable; called with the clicked key name. */
  onSelectKey?: (key: string) => void;
};

/** Where a node sits, and what the find bar wants marked there. */
type NodeContext = {
  path: string;
  find: Find;
};

/** The inline styling + text for a primitive value, keyed by its JS type. */
function primitiveView(value: unknown): { className: string; text: string } {
  if (value === null) return { className: "jsonview__null", text: "null" };
  switch (typeof value) {
    case "string":
      // JSON.stringify gives us the quoting + escaping for free.
      return { className: "jsonview__string", text: JSON.stringify(value) };
    case "number":
      return { className: "jsonview__number", text: String(value) };
    case "boolean":
      return { className: "jsonview__bool", text: String(value) };
    case "undefined":
      return { className: "jsonview__null", text: "undefined" };
    default:
      // bigint / symbol / function — no JSON form; show the coerced string.
      return { className: "jsonview__string", text: String(value) };
  }
}

/** Read-only: a <span>. With onSelectKey: a <button>, its ": " in a sibling so the chip hugs the
 * name. Both carry data-key and the selection mark; find <mark>s are independent of it. */
function KeyLabel({
  name,
  path,
  find,
  selectedKey,
  onSelectKey,
}: { name: string } & NodeContext & SelectionProps): React.JSX.Element {
  const selected = name === selectedKey;
  const className = selected
    ? "jsonview__key jsonview__key--selected"
    : "jsonview__key";
  const dataSelected = selected ? "true" : undefined;
  const label = marked(name, path, "k", find);
  if (onSelectKey) {
    return (
      <>
        <button
          type="button"
          className={className}
          data-testid="json-key"
          data-key={name}
          data-selected={dataSelected}
          onClick={() => onSelectKey(name)}
        >
          {label}
        </button>
        <span className="jsonview__punct">{": "}</span>
      </>
    );
  }
  return (
    <span className={className} data-key={name} data-selected={dataSelected}>
      {label}
      {": "}
    </span>
  );
}

/** A collapsible object/array node, with an optional `key:`/`index:` prefix. */
function CollapsibleNode({
  nodeKey,
  value,
  isArray,
  depth,
  path,
  find,
  selectedKey,
  onSelectKey,
}: {
  nodeKey?: string;
  value: object;
  isArray: boolean;
  depth: number;
} & NodeContext & SelectionProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);

  // Non-null by construction: JsonNode only routes arrays and objects here.
  const entries = entriesOf(value) as Entry[];

  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";

  const keyEl =
    nodeKey === undefined ? null : (
      <KeyLabel
        name={nodeKey}
        path={path}
        find={find}
        selectedKey={selectedKey}
        onSelectKey={onSelectKey}
      />
    );

  // Empty container: no caret, just the (empty) brackets.
  if (entries.length === 0) {
    return (
      <div className="jsonview__row">
        {keyEl}
        <span className="jsonview__punct">
          {open}
          {close}
        </span>
      </div>
    );
  }

  const summary = isArray ? `Array(${entries.length})` : "{…}";

  // Too deep to keep recursing: collapse to a summary (never a caret / children).
  if (depth >= MAX_DEPTH) {
    return (
      <div className="jsonview__row">
        {keyEl}
        <span className="jsonview__summary">{summary}</span>
      </div>
    );
  }

  // A hit inside this subtree pins the node open, and disables its caret while
  // it does: the counter claims that match exists, so the tree must not let it
  // be hidden. Clearing the query hands the node straight back to `expanded`.
  const pinned = find.search !== null && find.search.pinned.has(path);
  const isOpen = expanded || pinned;
  const label = `${isOpen ? "Collapse" : "Expand"} ${isArray ? "array" : "object"}`;
  const pinnedTitle = pinned ? "Kept open — a search match is inside" : undefined;

  const childRows = isOpen && (
    <>
      <div className="jsonview__children">
        {entries.map(([k, v]) => (
          <JsonNode
            key={k}
            nodeKey={k}
            value={v}
            depth={depth + 1}
            path={childPath(path, k)}
            find={find}
            selectedKey={selectedKey}
            onSelectKey={onSelectKey}
          />
        ))}
      </div>
      <div className="jsonview__row">
        <span className="jsonview__punct">{close}</span>
      </div>
    </>
  );

  // A button can't nest in a button: the toggle shrinks to a caret; key and punct are siblings.
  if (onSelectKey) {
    return (
      <div className="jsonview__node">
        <div className="jsonview__row">
          <button
            type="button"
            className="jsonview__toggle jsonview__toggle--caret"
            data-testid="json-node-toggle"
            aria-expanded={isOpen}
            aria-label={label}
            disabled={pinned}
            title={pinnedTitle}
            onClick={() => setExpanded((e) => !e)}
          >
            <span className="jsonview__caret">{isOpen ? "▾" : "▸"}</span>
          </button>
          {keyEl}
          {isOpen ? (
            <span className="jsonview__punct">{open}</span>
          ) : (
            <span className="jsonview__summary">{summary}</span>
          )}
        </div>
        {childRows}
      </div>
    );
  }

  // Read-only mode: the whole row stays one toggle button, exactly as before.
  return (
    <div className="jsonview__node">
      <button
        type="button"
        className="jsonview__row jsonview__toggle"
        data-testid="json-node-toggle"
        aria-expanded={isOpen}
        aria-label={label}
        disabled={pinned}
        title={pinnedTitle}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="jsonview__caret">{isOpen ? "▾" : "▸"}</span>
        {keyEl}
        {isOpen ? (
          <span className="jsonview__punct">{open}</span>
        ) : (
          <span className="jsonview__summary">{summary}</span>
        )}
      </button>
      {childRows}
    </div>
  );
}

/** Dispatch one value: collapsible for object/array, inline for primitives. */
function JsonNode({
  nodeKey,
  value,
  depth,
  path,
  find,
  selectedKey,
  onSelectKey,
}: {
  nodeKey?: string;
  value: unknown;
  depth: number;
} & NodeContext & SelectionProps): React.JSX.Element {
  if (Array.isArray(value)) {
    return (
      <CollapsibleNode
        nodeKey={nodeKey}
        value={value}
        isArray
        depth={depth}
        path={path}
        find={find}
        selectedKey={selectedKey}
        onSelectKey={onSelectKey}
      />
    );
  }
  if (value !== null && typeof value === "object") {
    return (
      <CollapsibleNode
        nodeKey={nodeKey}
        value={value}
        isArray={false}
        depth={depth}
        path={path}
        find={find}
        selectedKey={selectedKey}
        onSelectKey={onSelectKey}
      />
    );
  }
  const { className, text } = primitiveView(value);
  return (
    <div className="jsonview__row">
      {nodeKey === undefined ? null : (
        <KeyLabel
          name={nodeKey}
          path={path}
          find={find}
          selectedKey={selectedKey}
          onSelectKey={onSelectKey}
        />
      )}
      <span className={className}>{marked(text, path, "v", find)}</span>
    </div>
  );
}

/** Render an already-parsed JSON `value` as a collapsible tree. */
export function JsonView({
  value,
  selectedKey,
  onSelectKey,
  search = null,
  currentMatch = 0,
}: {
  value: unknown;
  /** Hits to mark, from `searchJsonTree` over this same value. */
  search?: TreeSearch | null;
  /** Global ordinal of the find bar's cursor. */
  currentMatch?: number;
} & SelectionProps): React.JSX.Element {
  const find: Find =
    search === null ? NO_FIND : { search, current: currentMatch };
  return (
    <div className="jsonview" data-testid="json-view">
      <JsonNode
        value={value}
        depth={0}
        path=""
        find={find}
        selectedKey={selectedKey}
        onSelectKey={onSelectKey}
      />
    </div>
  );
}
