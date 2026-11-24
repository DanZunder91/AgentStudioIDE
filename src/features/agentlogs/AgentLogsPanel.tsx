/**
 * AgentLogsPanel — the fleet's logs, read like an IDE reads them (logs must help the
 * reader, not confuse them). A
 * singleton center tab: a **Sources sidebar** on the left (Services · Terminals · Agents ·
 * Mac apps, All on top — `SourcesSidebar.tsx`) and the selected stream on the right.
 *
 * How a line renders depends on what produced it (`agentLogsStream.ts`):
 *   - a service / terminal / Mac-app line is RAW — `time  LEVEL  text`, like `tail -f`;
 *   - an agent's tool call and its result are ONE command block — `$ cargo test --lib`
 *     with the output nested under it, folded to 3 lines with "show N more";
 *   - a lifecycle line is a thin centred divider, not a log row.
 * The Source column is the user's choice alone (Columns ▾) — it is never hidden or shown by
 * the selection (its coming and going read as a new, empty column appearing). A solo selection is
 * announced by a STREAM HEADER above the list instead (`gazelle · service · ● running · 26
 * lines`), with an "All sources" way back.
 *
 * Layout: the panel is a definite-height flex column, the list is the one
 * `flex: 1 1 0; min-height: 0; overflow: auto` box, so its `clientHeight` is the pane's
 * share and the windowing actually windows. Every row — raw, divider, a block's header,
 * each of its output lines, its "more" row — is exactly ROW_H tall, so the scroll
 * arithmetic stays one multiplication over `stream.total` (the choice is argued in
 * `agentLogsStream.ts`). The sticky header is one row tall, so row i sits at `(i + 1) · ROW_H`.
 *
 * Columns: the header and every row are CSS grids on the same
 * `gridTemplate(visibleColumns(...))`, so Time · Level · Source keep the user's widths
 * whatever the text is. A block's output rows carry the block's time and source, DIMMED
 * (blank cells read as a broken column), and each line's OWN level (`agentLogsLevel.ts`);
 * only the fold row ("show N more"), which is a control
 * and not a line, keeps blank leading cells.
 *
 * ⌘F / Ctrl+F (`agentLogsFind.ts`): pressed anywhere inside this panel it
 * opens the Logs view's OWN find bar above the list — the key never reaches WebKit's
 * window-wide find or a Markdown preview's window fallback (both skip a `defaultPrevented`
 * keystroke). There is no global ⌘F owner in the app to route through: every find surface
 * (editor, terminal, preview, DB grid, API body) answers the key from its own container's
 * keydown, and this panel does the same, so "inside Logs → the Logs bar, outside → not" is
 * DOM containment, not a registry. The panel root is `tabIndex={-1}` so a click on any
 * non-focusable part of it (the count, a gap in the list) still puts focus inside it.
 * Pressed inside the detail drawer, the same bar searches the drawer's text (`in detail`).
 *
 * A block header reads description first, in bold, then the command dimmed on the same
 * line — a header can begin with 200 characters of `$ S=/private/tmp/…; cp …`. The
 * command ellipsises; the drawer has it whole. When the command or its output names a file
 * the IDE already tails as a service, the header ends in "→ open <service> stream"
 * (`agentLogsLinks.ts`), pinned to the right of the cell so a long command cannot push it
 * out of view.
 *
 * A dev app selected in the sidebar's Apps group shows its CARD
 * (`procs/DevAppCard`) between the stream header and the list: a stream started from it is
 * soloed, "Restart in the IDE" focuses the new terminal's tab, a port's "connections →" opens
 * Network › Whole Mac on that pid. While the app streams nothing, the list says "Pick a log to
 * stream" instead of looking empty for no reason (`agentLogsAppSelection.ts` has the rule
 * that deselects the app when anything else is picked).
 *
 * An app the IDE started gets "requests →" (Network › IDE traffic, its
 * Process picked), its `ide-terminal` console names the terminal by its tab's title and opens
 * it, and a file a Service already tails links to that stream (the ring's `servicePaths`,
 * matched on the exact path). While its console is an IDE terminal the empty-list hint says so
 * instead of "Pick a log". A soloed AGENT's stream header lists the apps that agent is running
 * as links; one selects the app (`selectAppInLogs`, exactly the sidebar row's click).
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { AppPicker } from "../../components/AppPicker";
import {
  ColumnResizer,
  ColumnsMenu,
  gridTemplate,
  useColumnLayout,
  visibleColumns,
  type ColumnDef,
} from "../../components/columns";
import {
  appsLabel,
  displayName,
  filterLines,
  formatTime,
  highlightMachine,
  highlightOsLog,
  levelBadge,
  oneLine,
  rowWindow,
  sourceColorIndex,
  sourceSelection,
  sourcesOf,
  sourceTag,
  type Segment,
} from "./agentLogsFormat";
import { domSelectionSeed } from "../editor/find/selectionSeed";
import {
  clampCursor,
  compileFind,
  findExpansions,
  findInDetail,
  findInStream,
  markSegments,
  marksByPart,
  matchRow,
  revealScrollTop,
  type DetailPart,
  type Mark,
} from "./agentLogsFind";
import { DevAppCard, type TailedBy } from "../procs/DevAppCard";
import { useProcsStore, useSelectedDevApp } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import { agentIdsBySource, appForService, appsOfAgent } from "./agentLogsApps";
import { selectAppInLogs, watchAppSelection } from "./agentLogsAppSelection";
import {
  focusLogSource,
  focusTargetFor,
  focusTerminalTab,
  showConnectionsOf,
  showRequestsOf,
  terminalTitleOf,
  unavailableReason,
  type FocusSource,
} from "./agentLogsFocus";
import { classifyLine } from "./agentLogsLevel";
import { LogsFindBar } from "./LogsFindBar";
import { RenamedSourcesContext, renamedTerminalLabels, useSourceLabel } from "./agentLogsTitles";
import { LOG_COLUMNS, LOGS_VIEW, rowsMinWidth } from "./agentLogsColumns";
import { servicePaths, streamLinkFor } from "./agentLogsLinks";
import { deriveRunning, queryMatcher, sourcePickerItems, streamHeader } from "./agentLogsRunning";
import {
  buildStream,
  errorTargets,
  formatVisualRowForCopy,
  pairToolLines,
  visualRowKey,
  visualRowsIn,
  type ToolBlock,
  type VisualRow,
} from "./agentLogsStream";
import { AgentLogsSources } from "./AgentLogsSources";
import { retryLogstream, startLogstream, startSyslogPoll, useAgentLogsStore } from "./agentLogsStore";
import type { LogLevel, LogLine } from "./agentLogsTypes";
import { SourcesSidebar } from "./SourcesSidebar";
import "./agentLogs.css";

/** Fixed row height in px — must match `.alog-row` in agentLogs.css. */
export const ROW_H = 18;
/** jsdom (and a not-yet-laid-out pane) measures 0; window as if a pane were this tall. */
const FALLBACK_VIEWPORT = 600;

const LEVELS: { level: LogLevel; label: string }[] = [
  { level: "error", label: "Error" },
  { level: "warn", label: "Warn" },
  { level: "info", label: "Info" },
  { level: "debug", label: "Debug" },
];

const noop = () => {};

/** Survives remounts (tab switch / pane move) so an unfollowed reader keeps their place. */
let savedScrollTop = 0;

/* ───────────────────────────── cells ───────────────────────────── */

const NO_MARKS: readonly Mark[] = [];

/**
 * Highlighted text with the ⌘F matches painted over it: every match a
 * subtle `<mark>`, the current one hot. React children, never `innerHTML` — the marks are
 * rebuilt with the row, so no re-render can erase them (React re-assigning `innerHTML` on a
 * new prop object only erases Range-painted marks, so it does not apply).
 */
function Segments({ segs, marks = NO_MARKS, current = -1 }: { segs: Segment[]; marks?: readonly Mark[]; current?: number }): React.JSX.Element {
  return (
    <>
      {markSegments(segs, marks).map((piece, i) => {
        const text =
          piece.kind === "plain" ? (
            piece.text
          ) : (
            <span key={`s${i}`} className={`alog-hl alog-hl--${piece.kind}`}>
              {piece.text}
            </span>
          );
        if (piece.ord === null) return text;
        const hot = piece.ord === current;
        return (
          <mark
            key={i}
            className={cls("alog-find-hit", hot && "alog-find-hit--current")}
            data-testid={hot ? "alog-find-current" : "alog-find-hit"}
            data-ord={piece.ord}
          >
            {text}
          </mark>
        );
      })}
    </>
  );
}

/** Plain text (no os_log highlighting) with the ⌘F marks painted over it. */
function Marked({ text, marks, current }: { text: string; marks: readonly Mark[] | undefined; current: number }): React.JSX.Element {
  if (marks === undefined) return <>{text}</>;
  return <Segments segs={[{ kind: "plain", text }]} marks={marks} current={current} />;
}

/** True when the current match is one of `marks` — the row gets the "you are here" rule. */
const holdsCurrent = (marks: readonly Mark[] | undefined, current: number): boolean =>
  marks !== undefined && marks.some((m) => m.ord === current);

/** Marks a row the filter matched only in its detail — the hit is not on the row itself. */
function ViaDetail(): React.JSX.Element {
  return (
    <span
      className="alog-via-detail"
      data-testid="alog-via-detail"
      title="The filter matched this line's detail (e.g. the rest of a multi-line command) — open the row to see it"
    >
      detail
    </span>
  );
}

/**
 * Why a source label is plain text, led by the full (display) name — the cell ellipsizes a
 * long source, so the title is where the whole name lives. A system app never had an IDE tab.
 */
function plainSourceTitle(line: LogLine, name: string): string {
  if (line.kind === "machine") {
    return line.detail === null ? `${name} — an app on this computer` : `${name} — ${line.detail}`;
  }
  // A dev app's stream: `detail` says where it comes from (`<path> · pid <n>`).
  if (line.kind === "app") return `${name} — ${line.detail ?? "a dev app's log"}`;
  return `${name} — ${unavailableReason(line)}`;
}

/** The display name plus its `service` tag, when it has one. The tag is decoration: not in the accessible name. */
function SourceName({ source }: { source: string }): React.JSX.Element {
  const tag = sourceTag(source);
  const label = useSourceLabel();
  return (
    <>
      {label(source)}
      {tag !== null && (
        <span className="alog-tag" aria-hidden="true">
          {tag}
        </span>
      )}
    </>
  );
}

function SourceCell({
  line, linkable, dim, onSource,
}: { line: LogLine; linkable: boolean; dim: boolean; onSource(line: LogLine): void }): React.JSX.Element {
  const srcCls = `alog-src alog-src--${sourceColorIndex(line.source)}`;
  // A renamed terminal reads by its live title here too (agentLogsTitles), not its spawn label.
  const name = useSourceLabel()(line.source);
  if (linkable) {
    return (
      <button
        type="button"
        className={`${srcCls} alog-src--link`}
        title={`Focus ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          onSource(line);
        }}
      >
        <SourceName source={line.source} />
      </button>
    );
  }
  // A dimmed cell repeats its block's header, which carries the full title (and the link).
  return (
    <span className={`${srcCls}${dim ? " alog-cell--dim" : ""}`} title={dim ? name : plainSourceTitle(line, name)}>
      <SourceName source={line.source} />
    </span>
  );
}

/**
 * The leading cells of a row (Time · Level · Source), in the visible columns' order. `dim`
 * is a block's output row: the time and source repeat the block's, faded, never linkable —
 * the header above is where the row's identity lives. Its Level is NOT
 * faded: it is the line's OWN level (`classifyLine`), not a repeat,
 * so a WARN line inside a block reads `W` in the warn colour like any stream line.
 */
function LeadCells({
  columns, line, level, linkable, dim, onSource,
}: {
  columns: string;
  line: LogLine;
  level: LogLevel;
  linkable: boolean;
  dim: boolean;
  onSource(line: LogLine): void;
}): React.JSX.Element {
  const dimCls = dim ? " alog-cell--dim" : "";
  return (
    <>
      {columns.split(" ").map((col) => {
        if (col === "time") return <span key={col} className={`alog-time${dimCls}`}>{formatTime(line.tsMs)}</span>;
        if (col === "level") {
          return (
            <span key={col} className={`alog-badge alog-badge--${level}`}>
              {levelBadge(level)}
            </span>
          );
        }
        if (col === "source") return <SourceCell key={col} line={line} linkable={linkable && !dim} dim={dim} onSource={onSource} />;
        return null;
      })}
    </>
  );
}

/** Empty leading cells — the fold row is a control, not a line, so it repeats nothing. */
function BlankCells({ columns }: { columns: string }): React.JSX.Element {
  return (
    <>
      {columns
        .split(" ")
        .filter((col) => col !== "text")
        .map((col) => (
          <span key={col} className="alog-cell--blank" aria-hidden="true" />
        ))}
    </>
  );
}

/** The keyboard half of a row's "open the detail" gesture. */
function toggleOnKey(e: React.KeyboardEvent, fn: () => void): void {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}

/* ───────────────────────────── rows ───────────────────────────── */

interface RowProps {
  row: VisualRow;
  /** The drawer shows this row's line. */
  expanded: boolean;
  /** The row's source label is a link to a live tab. */
  linkable: boolean;
  /** The filter matched this line only in its detail. */
  viaDetail: boolean;
  /** The last error jump landed here. */
  target: boolean;
  /** The visible column ids, space-joined (a string so `memo` compares it by value). */
  columns: string;
  /** `grid-template-columns` — the same string the header uses. */
  template: string;
  /** The Source column is visible (the user's Columns ▾ choice) — dividers name their source only then. */
  showSource: boolean;
  /** A head row only: the service whose streamed file this block's command or output names. */
  streamLink: string | null;
  /**
   * ⌘F marks on this row's text cell (a head row: on its command label), from one
   * `marksByPart` map — the same array object while the matches are unchanged, so `memo`
   * keeps an unmarked row cheap. Undefined when the row holds no match.
   */
  marks: readonly Mark[] | undefined;
  /** A head row only: the marks on its description. */
  descMarks: readonly Mark[] | undefined;
  /** The current match's ordinal (-1 for a row that holds no match, so `memo` skips it). */
  findCurrent: number;
  onToggle(id: number): void;
  onSource(line: LogLine): void;
  onBlock(key: string, expanded: boolean): void;
  onStreamLink(source: string): void;
}

const cls = (...parts: (string | false)[]): string => parts.filter(Boolean).join(" ");

/** A service / terminal / Mac-app line: `time  LEVEL  [source]  text`, nothing else. */
function RawRow({ line, expanded, linkable, viaDetail, target, columns, template, marks, findCurrent, onToggle, onSource }: RowProps & { line: LogLine }) {
  const text = oneLine(line.text);
  return (
    <div
      className={cls("alog-row", `alog-row--${line.level}`, `alog-row--kind-${line.kind}`, expanded && "alog-row--expanded", target && "alog-row--target", holdsCurrent(marks, findCurrent) && "alog-row--find-current")}
      style={{ gridTemplateColumns: template }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      data-testid="alog-row"
      data-id={line.id}
      data-source={line.source}
      onClick={() => onToggle(line.id)}
      onKeyDown={(e) => toggleOnKey(e, () => onToggle(line.id))}
    >
      <LeadCells columns={columns} line={line} level={line.level} linkable={linkable} dim={false} onSource={onSource} />
      <span className="alog-text">
        {viaDetail && <ViaDetail />}
        <Segments segs={line.kind === "machine" ? highlightMachine(text) : highlightOsLog(text)} marks={marks} current={findCurrent} />
      </span>
    </div>
  );
}

/** A lifecycle line: a thin centred divider carrying the time and the text. */
function DividerRow({ line, expanded, viaDetail, target, template, showSource, marks, findCurrent, onToggle }: RowProps & { line: LogLine }) {
  return (
    <div
      className={cls("alog-row", "alog-divider", `alog-divider--${line.level}`, expanded && "alog-row--expanded", target && "alog-row--target", holdsCurrent(marks, findCurrent) && "alog-row--find-current")}
      style={{ gridTemplateColumns: template }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      data-testid="alog-divider"
      data-id={line.id}
      data-source={line.source}
      title={line.detail === null ? undefined : "Open for the details"}
      onClick={() => onToggle(line.id)}
      onKeyDown={(e) => toggleOnKey(e, () => onToggle(line.id))}
    >
      <span className="alog-divider__inner">
        <span className="alog-divider__rule" aria-hidden="true" />
        <span className="alog-divider__text">
          <span className="alog-time">{formatTime(line.tsMs)}</span>
          {showSource && (
            <span className={`alog-src alog-src--${sourceColorIndex(line.source)} alog-divider__src`}>
              <SourceName source={line.source} />
            </span>
          )}
          {viaDetail && <ViaDetail />}
          <Marked text={oneLine(line.text)} marks={marks} current={findCurrent} />
        </span>
        <span className="alog-divider__rule" aria-hidden="true" />
      </span>
    </div>
  );
}

/**
 * A command block's header: the description first and bold when the
 * call has one, then the command dimmed — `Run the unit tests · $ cargo test --lib`; without
 * a description the command alone, bold. Red when the result failed. The text cell is a
 * flex row so the command ellipsises while the description and the stream link stay whole.
 */
function HeadRow({ block, expanded, linkable, viaDetail, target, columns, template, streamLink, marks, descMarks, findCurrent, onToggle, onSource, onStreamLink }: RowProps & { block: ToolBlock }) {
  const a = block.anchor;
  const level: LogLevel = block.error ? "error" : a.level;
  const pending = block.result === null && block.tool !== null;
  const described = block.header.description !== null;
  return (
    <div
      className={cls("alog-row", "alog-block__head", `alog-row--${level}`, block.error && "alog-block__head--error", pending && "alog-block__head--pending", expanded && "alog-row--expanded", target && "alog-row--target", (holdsCurrent(marks, findCurrent) || holdsCurrent(descMarks, findCurrent)) && "alog-row--find-current")}
      style={{ gridTemplateColumns: template }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      data-testid="alog-block-head"
      data-id={a.id}
      data-key={block.key}
      data-source={a.source}
      data-error={block.error}
      onClick={() => onToggle(a.id)}
      onKeyDown={(e) => toggleOnKey(e, () => onToggle(a.id))}
    >
      <LeadCells columns={columns} line={a} level={level} linkable={linkable} dim={false} onSource={onSource} />
      <span className="alog-text alog-block__cmd">
        {viaDetail && <ViaDetail />}
        {described && (
          <span className="alog-block__desc">
            <Marked text={oneLine(block.header.description as string)} marks={descMarks} current={findCurrent} />
          </span>
        )}
        <span className={cls("alog-block__label", described && "alog-block__label--after")} title={described ? oneLine(block.header.label) : undefined}>
          <Marked text={oneLine(block.header.label)} marks={marks} current={findCurrent} />
        </span>
        {block.tool === null && (
          <span className="alog-block__orphan" title="The call itself is no longer in the log (it scrolled out of the ring, or the log was cleared)">
            {" "}
            (result only)
          </span>
        )}
        {pending && (
          <span className="alog-block__pending" title="No result yet — still running">
            {" "}
            …
          </span>
        )}
        {streamLink !== null && (
          <button
            type="button"
            className="alog-block__stream"
            data-testid="alog-block-stream"
            data-source={streamLink}
            title={`This command read a file the IDE already tails as the ${displayName(streamLink)} service — show only that stream`}
            onClick={(e) => {
              e.stopPropagation();
              onStreamLink(streamLink);
            }}
          >
            → open {displayName(streamLink)} stream
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * One line of a block's output, nested under its header; a query hit is marked. Its leading
 * cells repeat the block's time and source, dimmed — never blank — and its
 * Level is the LINE's own: `classifyLine`, the TS twin of Rust's
 * `classify_level`, so `WARN gazelle::db: …` is W and yellow, not the result's I. The
 * text is coloured by that level too. A failed result still reads as failed — its header is
 * red and every output row keeps the red rule down its left edge — but a plain
 * `Compiling foo` line under it is no longer painted red: red that means nothing teaches the
 * reader to ignore red (the reason Rust lets a logger's own level column win).
 */
function OutRow({ block, index, text, hit, columns, template, marks, findCurrent, onToggle, onSource }: RowProps & { block: ToolBlock; index: number; text: string; hit: boolean }) {
  const level = classifyLine(text);
  return (
    <div
      className={cls("alog-row", "alog-block__out", `alog-block__out--lvl-${level}`, block.error && "alog-block__out--error", hit && "alog-block__out--hit", holdsCurrent(marks, findCurrent) && "alog-row--find-current")}
      style={{ gridTemplateColumns: template }}
      data-testid="alog-block-out"
      data-key={block.key}
      data-index={index}
      data-level={level}
      onClick={() => onToggle(block.anchor.id)}
    >
      <LeadCells columns={columns} line={block.anchor} level={level} linkable={false} dim={true} onSource={onSource} />
      <span className="alog-text alog-block__outtext">
        <Marked text={text} marks={marks} current={findCurrent} />
      </span>
    </div>
  );
}

/** "show N more" / "show less" — the fold control, its own row so the grid stays fixed. */
function MoreRow({ block, expanded, hidden, columns, template, onBlock }: RowProps & { block: ToolBlock; hidden: number }) {
  return (
    <div className="alog-row alog-block__more" style={{ gridTemplateColumns: template }} data-testid="alog-block-more" data-key={block.key}>
      <BlankCells columns={columns} />
      <span className="alog-text">
        <button
          type="button"
          className="alog-block__toggle"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onBlock(block.key, !expanded);
          }}
        >
          {expanded ? "show less" : `show ${hidden} more`}
        </button>
      </span>
    </div>
  );
}

const StreamRow = memo(function StreamRow(props: RowProps) {
  const { row } = props;
  if (row.kind === "raw") return <RawRow {...props} line={row.line} />;
  if (row.kind === "divider") return <DividerRow {...props} line={row.line} />;
  if (row.kind === "head") return <HeadRow {...props} block={row.block} />;
  if (row.kind === "out") return <OutRow {...props} block={row.block} index={row.index} text={row.text} hit={row.hit} />;
  return <MoreRow {...props} block={row.block} expanded={row.expanded} hidden={row.hidden} />;
});

/** The sticky header: one cell per visible column, a resize handle on every fixed one. */
function Header({
  cols, template,
}: { cols: ReadonlyArray<ColumnDef & { px: number }>; template: string }): React.JSX.Element {
  return (
    <div className="alog-head" data-testid="alog-head" style={{ gridTemplateColumns: template }}>
      {cols.map((c) => (
        <div key={c.id} className="alog-head__cell" data-col={c.id}>
          <span className="alog-head__label">{c.label}</span>
          {!c.flex && <ColumnResizer viewKey={LOGS_VIEW} def={c} width={c.px} />}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────── the panel ───────────────────────────── */

/**
 * The `partKey` (agentLogsFind.ts) of a visual row's text cell — a head row's command
 * label; its description is `d:<key>`. The "show N more" row paints nothing.
 */
function rowPartKey(row: VisualRow): string {
  if (row.kind === "raw" || row.kind === "divider") return `l:${row.line.id}`;
  if (row.kind === "head") return `h:${row.block.key}`;
  if (row.kind === "out") return `o:${row.block.key}:${row.index}`;
  return `m:${row.block.key}`;
}

/** The line a visual row stands for (for the drawer / link / target lookups), if any. */
function lineOf(row: VisualRow): LogLine | null {
  if (row.kind === "raw" || row.kind === "divider") return row.line;
  if (row.kind === "head") return row.block.anchor;
  return null;
}

const NO_DEV_APPS: readonly DevApp[] = [];

export function AgentLogsPanel(): React.JSX.Element {
  const lines = useAgentLogsStore((s) => s.lines);
  const pendingCount = useAgentLogsStore((s) => s.pending.length);
  const status = useAgentLogsStore((s) => s.status);
  const error = useAgentLogsStore((s) => s.error);
  const clearError = useAgentLogsStore((s) => s.clearError);
  const filter = useAgentLogsStore((s) => s.filter);
  const follow = useAgentLogsStore((s) => s.follow);
  const followMark = useAgentLogsStore((s) => s.followMark);
  const paused = useAgentLogsStore((s) => s.paused);
  const expandedId = useAgentLogsStore((s) => s.expandedId);
  const expandedBlocks = useAgentLogsStore((s) => s.expandedBlocks);
  const jumpRequest = useAgentLogsStore((s) => s.jumpRequest);
  const errorCursor = useAgentLogsStore((s) => s.errorCursor);
  const find = useAgentLogsStore((s) => s.find);
  const actions = useAgentLogsStore.getState();

  // Linkability reads the fleet, so the labels update the moment a tab closes.
  const tabs = useAppStore((s) => s.tabs);
  const agents = useAppStore((s) => s.agents);
  const layout = useAppStore((s) => s.layout);
  const views = useAppStore((s) => s.views);
  const activeViewId = useAppStore((s) => s.activeViewId);
  const fleet: FocusSource = useMemo(
    () => ({ tabs, agents, layout, views, activeViewId }),
    [tabs, agents, layout, views, activeViewId],
  );

  const backend = useAgentLogsStore((s) => s.syslog?.backend);
  const machine = appsLabel(backend);
  const [scrollTop, setScrollTop] = useState(savedScrollTop);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const findBarRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  /** Where focus was when ⌘F opened the bar — Esc gives it back (a row, the filter box…). */
  const findReturnRef = useRef<HTMLElement | null>(null);
  /** The last `find.seq` revealed: only a find GESTURE scrolls, never a batch of new lines. */
  const revealedSeq = useRef(-1);

  useEffect(() => startLogstream(), []);
  useEffect(() => startSyslogPoll(), []);
  useEffect(() => watchAppSelection(), []);
  const devApp = useSelectedDevApp();
  // The selected app streams nothing yet: its solo is the empty pick (`soloSources([])`).
  const appHint = devApp !== null && filter.onlySources !== null && filter.onlySources.length === 0;

  const { rows, error: filterError, viaDetail } = useMemo(() => filterLines(lines, filter), [lines, filter]);
  const pairing = useMemo(() => pairToolLines(lines), [lines]);
  const matcher = useMemo(() => queryMatcher(filter.query), [filter.query]);
  const baseStream = useMemo(
    () => buildStream(rows, pairing, { expanded: expandedBlocks, query: matcher }),
    [rows, pairing, expandedBlocks, matcher],
  );

  /* ── ⌘F find ── */
  const findQuery = find?.query ?? "";
  const findCase = find?.caseSensitive ?? false;
  const findRegex = find?.regex ?? false;
  const findOpen = find !== null;
  const compiled = useMemo(
    () => (findOpen ? compileFind({ query: findQuery, caseSensitive: findCase, regex: findRegex }) : null),
    [findOpen, findQuery, findCase, findRegex],
  );
  const findRe = compiled !== null && compiled.ok ? compiled.re : null;
  const findError = compiled !== null && !compiled.ok ? compiled.error : null;
  const touched = find?.touched;
  const expanded = expandedId === null ? undefined : baseStream.shown.get(expandedId);
  const expandedResult = expanded !== undefined && expanded.kind === "tool" ? (pairing.resultOf.get(expanded.id) ?? null) : null;
  // A detail-scoped bar whose drawer has closed searches the stream again rather than nothing.
  const scope = find?.scope === "detail" && expanded !== undefined ? "detail" : "list";
  // The matches are found over the stream the USER folded (every output line is searched,
  // folded or not), then the blocks hiding a match are expanded for as long as the bar is
  // open — an override passed to a rebuild, never written to `expandedBlocks`, so closing
  // the bar gives back exactly the folds the user had.
  const baseMatches = useMemo(
    () => (findRe === null || scope !== "list" ? [] : findInStream(baseStream, findRe)),
    [findRe, scope, baseStream],
  );
  const overrides = useMemo(
    () => (touched === undefined ? {} : findExpansions(baseStream, baseMatches, touched)),
    [baseStream, baseMatches, touched],
  );
  const stream = useMemo(
    () =>
      Object.keys(overrides).length === 0
        ? baseStream
        : buildStream(rows, pairing, { expanded: { ...expandedBlocks, ...overrides }, query: matcher }),
    [overrides, baseStream, rows, pairing, expandedBlocks, matcher],
  );
  // Entries are 1:1 between the two builds (same rows, same order), so the matches found
  // over the first address the second by entry index.
  const listMarks = useMemo(() => marksByPart(stream, baseMatches), [stream, baseMatches]);
  const detailParts = useMemo((): DetailPart[] => {
    if (expanded === undefined) return [];
    const parts: DetailPart[] = [{ id: "text", text: expanded.text }];
    if (expanded.detail !== null) parts.push({ id: "detail", text: expanded.detail });
    if (expandedResult !== null) parts.push({ id: "result", text: expandedResult.detail ?? expandedResult.text });
    return parts;
  }, [expanded, expandedResult]);
  const detailMatches = useMemo(
    () => (findRe === null || scope !== "detail" ? [] : findInDetail(detailParts, findRe)),
    [findRe, scope, detailParts],
  );
  const detailMarks = useMemo(() => {
    const out = new Map<string, Mark[]>();
    detailMatches.forEach((m, ord) => {
      const list = out.get(m.part) ?? [];
      list.push({ from: m.from, to: m.to, ord });
      out.set(m.part, list);
    });
    return out;
  }, [detailMatches]);
  const findTotal = scope === "detail" ? detailMatches.length : baseMatches.length;
  const findCurrent = find === null ? -1 : clampCursor(find.cursor, findTotal);

  const sources = useMemo(() => sourcesOf(lines), [lines]);
  // The picker is grouped like the sidebar (Apps, then Services); Mac apps are listed whether or
  // not they stream right now — a pick is over what has been seen.
  const running = useMemo(() => deriveRunning(lines, true), [lines]);
  // A renamed terminal's live title, for every place below that names a source (agentLogsTitles).
  const renamed = useMemo(() => renamedTerminalLabels(lines, tabs), [lines, tabs]);
  const sourceItems = useMemo(
    () => sourcePickerItems(sources, running, machine, renamed),
    [sources, running, machine, renamed],
  );
  const selection = sourceSelection(filter, sources);
  // One source selected: a stream header names it above the list. The columns are NOT
  // touched — the Source column is the user's Columns ▾ choice alone.
  const solo = selection !== null && selection.length === 1 ? selection[0] : null;
  const header = useMemo(
    () => (solo === null ? null : streamHeader(solo, lines, machine, renamed)),
    [solo, lines, machine, renamed],
  );
  // The files every service tails → the block headers that link to a service's stream.
  const paths = useMemo(() => servicePaths(lines), [lines]);
  // …and the card's "Already streaming as <service>": an EXACT path match.
  const serviceTailing = useCallback((path: string): TailedBy | null => {
    const source = paths.get(path);
    return source === undefined ? null : { source, name: displayName(source) };
  }, [paths]);
  // A soloed agent's running IDE apps — the header's links.
  const procApps = useProcsStore((s) => s.list?.apps ?? NO_DEV_APPS);
  const headerApps = useMemo(
    () => (header?.kind === "agent" ? appsOfAgent(agentIdsBySource(lines).get(header.source), procApps) : NO_DEV_APPS),
    [header, lines, procApps],
  );
  // A soloed Service that tails an app's console is that app's stream: the header names
  // the APP — the service may be named after its launcher (`python3`), never what it runs.
  const headerOwner = useMemo(
    () => (header?.kind === "service" ? appForService(header.source, procApps, paths) : null),
    [header, procApps, paths],
  );
  const terminalTitle = devApp === null || devApp.terminalId === null ? null : terminalTitleOf(devApp.terminalId, fleet);

  const colLayout = useColumnLayout(LOGS_VIEW);
  const cols = useMemo(() => visibleColumns(LOG_COLUMNS, colLayout), [colLayout]);
  const template = gridTemplate(cols);
  const colIds = cols.map((c) => c.id).join(" ");
  const showSource = cols.some((c) => c.id === "source");

  // Rows that arrived since follow was switched off (a backwards scan: they are the tail).
  let newCount = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].id > followMark; i--) newCount++;

  /* ── measuring + follow ── */
  useLayoutEffect(() => {
    const box = listRef.current as HTMLDivElement;
    setViewport(box.clientHeight || FALLBACK_VIEWPORT);
    if (!useAgentLogsStore.getState().follow) box.scrollTop = savedScrollTop;
    return () => {
      savedScrollTop = box.scrollTop;
    };
  }, []);

  useEffect(() => {
    const onResize = () =>
      setViewport((listRef.current as HTMLDivElement).clientHeight || FALLBACK_VIEWPORT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    if (!follow) return;
    const box = listRef.current as HTMLDivElement;
    box.scrollTop = box.scrollHeight;
    setScrollTop(box.scrollTop);
  }, [follow, stream.total]);

  /* ── error navigation: resolve a sidebar jump against THIS render's stream ── */
  useLayoutEffect(() => {
    if (jumpRequest === null) return;
    const st = useAgentLogsStore.getState();
    const targets = errorTargets(stream, jumpRequest.source);
    if (targets.length === 0) {
      st.resolveErrorJump(null);
      return;
    }
    let idx = 0;
    const cur = st.errorCursor;
    if (jumpRequest.step !== "first" && cur !== null && cur.source === jumpRequest.source) {
      const at = targets.findIndex((t) => t.lineId === cur.lineId);
      if (at >= 0) idx = (at + (jumpRequest.step === "next" ? 1 : targets.length - 1)) % targets.length;
    }
    const t = targets[idx];
    // Row i sits at (i + 1) · ROW_H under the one-row sticky header: scrolling to i · ROW_H
    // puts it directly beneath the header (index arithmetic, never scrollIntoView on a
    // windowed list).
    const box = listRef.current as HTMLDivElement;
    box.scrollTop = t.offset * ROW_H;
    setScrollTop(box.scrollTop);
    st.resolveErrorJump({ source: jumpRequest.source, lineId: t.lineId });
  }, [jumpRequest, stream]);

  /*
   * ⌘F reveal: after a find GESTURE (`find.seq` moved — a query, a toggle, a step) bring the
   * current match into view. The list is windowed, so the match's row may not be in the DOM
   * at all: the scroll is index arithmetic on the real scroll box, declared
   * AFTER the follow effect so a query that expands a block (and so grows `stream.total`)
   * cannot have follow snap the list back to the tail over the reveal. A reveal that
   * scrolls stops follow, as a hand scroll would. The drawer is not windowed, so there the
   * current `<mark>` simply scrolls itself into view.
   */
  useLayoutEffect(() => {
    if (find === null || find.seq === revealedSeq.current) return;
    revealedSeq.current = find.seq;
    if (scope === "detail") {
      const hit = (drawerRef.current as HTMLDivElement).querySelector(".alog-find-hit--current");
      // Optional-called: jsdom does not implement scrollIntoView.
      (hit as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (baseMatches.length === 0) return;
    const box = listRef.current as HTMLDivElement;
    const row = matchRow(stream, baseMatches[findCurrent]);
    const next = revealScrollTop(row, box.scrollTop, box.clientHeight || FALLBACK_VIEWPORT, ROW_H);
    if (next === null) return;
    const st = useAgentLogsStore.getState();
    if (st.follow) st.setFollow(false);
    box.scrollTop = next;
    setScrollTop(box.scrollTop);
  }, [find, scope, baseMatches, findCurrent, stream]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= ROW_H;
    const st = useAgentLogsStore.getState();
    // Any scroll away from the bottom pauses follow; scrolling back down resumes it.
    if (st.follow !== atBottom) st.setFollow(atBottom);
  };

  const onToggle = useCallback((id: number) => useAgentLogsStore.getState().toggleExpanded(id), []);
  const onSource = useCallback((line: LogLine) => {
    focusLogSource(line);
  }, []);
  const onBlock = useCallback((key: string, expanded: boolean) => useAgentLogsStore.getState().setBlockExpanded(key, expanded), []);
  const onStreamLink = useCallback((source: string) => useAgentLogsStore.getState().soloSource(source), []);

  const copyVisible = () => {
    if (!navigator.clipboard) return;
    const text = visualRowsIn(stream, 0, stream.total)
      .map(formatVisualRowForCopy)
      .filter((s): s is string => s !== null)
      .join("\n");
    void navigator.clipboard.writeText(text).catch(noop);
  };

  const win = rowWindow(scrollTop, viewport, ROW_H, stream.total);
  const visual = visualRowsIn(stream, win.start, win.end);
  // The drawer shows a row you can SEE. When the filters (or Clear, or the ring's cap) take
  // its row out of view, it closes — deliberately, rather than lingering over a list that
  // no longer contains it (the bug: a drawer stuck on an old "agent started").
  // A block's result counts as seen: its output is on screen under the header.
  // (`expanded` is read from the base stream above: find's expansions add output rows,
  // never lines, so `shown` is the same in both builds.)
  useEffect(() => {
    if (expandedId !== null && expanded === undefined) useAgentLogsStore.getState().closeDetail();
  }, [expandedId, expanded]);
  const empty = lines.length === 0 && pendingCount === 0;

  /** Focus the bar's input with its text selected, once it exists (it renders a tick later). */
  const focusFindInput = (): void => {
    window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
  };

  /** Esc / ✕: forget the find, and give focus back to where ⌘F was pressed. */
  const closeFind = (): void => {
    actions.closeFind();
    const back = findReturnRef.current;
    findReturnRef.current = null;
    (back !== null && back.isConnected ? back : (rootRef.current as HTMLDivElement)).focus();
  };

  const onPanelKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      // Ours: never WebKit's window-wide find, never another surface's fallback.
      e.preventDefault();
      const target = e.target as HTMLElement;
      const inBar = findBarRef.current !== null && findBarRef.current.contains(target);
      const inDrawer = drawerRef.current !== null && drawerRef.current.contains(target);
      // Re-pressed inside the bar: keep the scope it has. Otherwise the drawer if ⌘F was
      // pressed in it, else the stream.
      const nextScope = inBar ? scope : inDrawer ? "detail" : "list";
      if (!inBar) findReturnRef.current = target;
      // Read the selection NOW, synchronously — focusing the input below collapses it
      // (selectionSeed.ts). Scoped to the text being searched, so a selection in the
      // drawer never seeds a stream search and vice versa.
      const seedBox = nextScope === "detail" ? (drawerRef.current as HTMLDivElement) : (listRef.current as HTMLDivElement);
      actions.openFind(nextScope, domSelectionSeed(seedBox));
      focusFindInput();
      return;
    }
    if (e.key !== "Escape") return;
    // One Esc, one layer: an open find closes first, the drawer on the next press.
    if (find !== null) {
      e.preventDefault();
      closeFind();
      return;
    }
    if (expandedId === null) return;
    e.preventDefault();
    actions.closeDetail();
  };

  return (
    <RenamedSourcesContext.Provider value={renamed}>
    <div className="alog" data-testid="agent-logs-panel" ref={rootRef} tabIndex={-1} onKeyDown={onPanelKey}>
      <div className="alog-toolbar" role="toolbar" aria-label="Agent logs controls">
        <div className="alog-filter">
          <input
            type="search"
            className="alog-filter__input"
            aria-label="Filter log lines"
            aria-invalid={filterError !== null}
            placeholder="Filter — text, or /regex/i"
            value={filter.query}
            onChange={(e) => actions.setQuery(e.target.value)}
          />
          {filterError !== null && (
            <span className="alog-filter__error" role="alert">
              Invalid regex: {filterError}
            </span>
          )}
        </div>

        <div
          className="alog-chips"
          role="group"
          aria-label="Levels"
          title="Levels are a heuristic (keywords like error/warn, os_log columns) — a filter, not a verdict"
        >
          {LEVELS.map(({ level, label }) => (
            <button
              key={level}
              type="button"
              className={`alog-chip alog-chip--${level}`}
              aria-pressed={filter.levels[level]}
              onClick={() => actions.toggleLevel(level)}
            >
              {label}
            </button>
          ))}
        </div>

        <AppPicker
          items={sourceItems}
          selected={selection}
          onChange={(next) => actions.setSourcePick(sources, next)}
          noun="sources"
          label="Filter by source"
        />

        <AgentLogsSources />

        <ColumnsMenu viewKey={LOGS_VIEW} defs={LOG_COLUMNS} />

        <span className="alog-spacer" />

        <span className="alog-count" aria-live="polite">
          {rows.length === lines.length
            ? `${lines.length} lines`
            : `${rows.length} of ${lines.length} lines`}
        </span>
        <button
          type="button"
          className="alog-chip"
          aria-pressed={follow}
          title="Keep the newest line in view"
          onClick={() => actions.setFollow(!follow)}
        >
          Follow
        </button>
        <button
          type="button"
          className="alog-chip"
          aria-pressed={paused}
          title={paused ? "Show the lines buffered while paused" : "Freeze the view; new lines are buffered"}
          onClick={() => actions.setPaused(!paused)}
        >
          {paused ? `Resume (${pendingCount} buffered)` : "Pause"}
        </button>
        <button type="button" className="alog-chip" onClick={() => void actions.clear()}>
          Clear
        </button>
        <button
          type="button"
          className="alog-chip"
          title={`Copy the ${rows.length} lines the filters show, as plain text`}
          onClick={copyVisible}
        >
          Copy visible
        </button>
      </div>

      {status === "error" && (
        <div className="alog-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="alog-chip" onClick={retryLogstream}>
            Retry
          </button>
        </div>
      )}
      {clearError !== null && (
        <div className="alog-banner" role="alert">
          {clearError}
        </div>
      )}

      <div className="alog-body">
        <SourcesSidebar />
        <div className="alog-main">
          {header !== null && (
            <div className="alog-stream-head" data-testid="alog-stream-head" data-source={header.source}>
              <span className="alog-stream-head__text">
                <strong className="alog-stream-head__name" title={headerOwner === null ? undefined : `${header.name} — the stream of ${headerOwner.name}`}>
                  {headerOwner?.name ?? header.name}
                </strong>
                {header.text.slice(header.name.length)}
              </span>
              {headerApps.length > 0 && (
                <span className="alog-stream-head__apps" data-testid="alog-stream-head-apps">
                  running
                  {headerApps.map((app) => (
                    <button
                      key={app.key}
                      type="button"
                      className="alog-stream-head__app"
                      data-testid="alog-stream-head-app"
                      data-key={app.key}
                      title={`Show ${app.name} — its card, and the logs it streams`}
                      onClick={() => selectAppInLogs(app)}
                    >
                      {app.name}
                    </button>
                  ))}
                </span>
              )}
              <button
                type="button"
                className="alog-stream-head__all"
                title="Back to every source, one stream"
                onClick={() => actions.setSourcePick([], null)}
              >
                All sources
              </button>
            </div>
          )}
          {devApp !== null && (
            <DevAppCard
              app={devApp}
              onStreamStarted={(source) => actions.soloSource(source)}
              onOpenTerminal={(terminalId) => void focusTerminalTab(terminalId, terminalTitle ?? devApp.name, devApp.cwd)}
              onShowConnections={showConnectionsOf}
              onShowRequests={showRequestsOf}
              terminalTitle={terminalTitle}
              serviceTailing={serviceTailing}
            />
          )}
          {find !== null && (
            <LogsFindBar
              inputRef={findInputRef}
              barRef={findBarRef}
              scope={scope}
              query={find.query}
              caseSensitive={find.caseSensitive}
              regex={find.regex}
              error={findError}
              current={findCurrent}
              total={findTotal}
              onQuery={actions.setFindQuery}
              onToggleCase={actions.toggleFindCase}
              onToggleRegex={actions.toggleFindRegex}
              onStep={(delta) => actions.stepFind(delta, findTotal)}
              onClose={closeFind}
            />
          )}
          <div className="alog-list" ref={listRef} onScroll={onScroll} data-testid="alog-list">
            {appHint ? (
              <div className="alog-empty alog-empty--app" data-testid="alog-app-hint">
                {devApp.console === "ide-terminal" ? (
                  <>
                    <p className="alog-empty__title">Its console is an IDE terminal</p>
                    <p>
                      {devApp.name} prints to the terminal {terminalTitle ?? devApp.launchedBy ?? "it runs in"} — press Open
                      terminal in the card above, or pick that terminal in Sources.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="alog-empty__title">Pick a log to stream</p>
                    <p>
                      {devApp.name} has no log streaming here yet — press Stream next to one of its log files in the
                      card above, or pick a log file it writes.
                    </p>
                  </>
                )}
              </div>
            ) : empty ? (
              status === "loading" ? (
                <div className="alog-empty">Loading the log stream…</div>
              ) : (
                <div className="alog-empty" data-testid="alog-empty">
                  <p className="alog-empty__title">Nothing logged yet</p>
                  <p>
                    Every source your fleet produces gets a stream here: the output of every terminal in
                    the IDE, the services your agents start in the background, every command and tool
                    your agents run (Bash, Edit, Read, sub-agents…) with its result shown under it, and
                    lifecycle events — terminals opening and exiting, agents starting and finishing.
                  </p>
                  <p>
                    While Claude is running in a terminal, its own screen repaints are hidden in
                    favour of its tool calls — a redraw is not a log line.
                  </p>
                  <p>
                    To also see what other apps on this computer are logging, turn on {machine} under
                    Sources — all of them, or just the ones you pick.
                  </p>
                </div>
              )
            ) : stream.total === 0 ? (
              // Name the filter that hides lines, with a one-click way out — a stale text filter left
              // from an earlier search hid a freshly streamed log behind a bare "no lines".
              <div className="alog-empty">
                No lines match the current filters.
                {filter.query.trim() !== "" ? (
                  <>
                    {" "}The text filter <code>{filter.query}</code> hides them.{" "}
                    <button type="button" className="alog-chip" onClick={() => useAgentLogsStore.getState().setQuery("")}>
                      Clear filter
                    </button>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="alog-rows" style={{ minWidth: rowsMinWidth(cols) }}>
                <Header cols={cols} template={template} />
                <div style={{ height: win.padTop }} />
                {visual.map((row) => {
                  const line = lineOf(row);
                  const marks = listMarks.get(rowPartKey(row));
                  const descMarks = row.kind === "head" ? listMarks.get(`d:${row.block.key}`) : undefined;
                  return (
                    <StreamRow
                      key={visualRowKey(row)}
                      row={row}
                      expanded={line !== null && line.id === expandedId}
                      linkable={line !== null && focusTargetFor(line, fleet) !== null}
                      viaDetail={line !== null && viaDetail.has(line.id)}
                      target={line !== null && errorCursor !== null && errorCursor.lineId === line.id}
                      columns={colIds}
                      template={template}
                      showSource={showSource}
                      streamLink={row.kind === "head" ? streamLinkFor(row.block, paths) : null}
                      marks={marks}
                      descMarks={descMarks}
                      findCurrent={marks === undefined && descMarks === undefined ? -1 : findCurrent}
                      onToggle={onToggle}
                      onSource={onSource}
                      onBlock={onBlock}
                      onStreamLink={onStreamLink}
                    />
                  );
                })}
                <div style={{ height: win.padBottom }} />
              </div>
            )}
          </div>
          {!follow && newCount > 0 && (
            <button type="button" className="alog-newpill" onClick={() => actions.setFollow(true)}>
              ↓ {newCount} new
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="alog-detail" data-testid="alog-detail" ref={drawerRef} tabIndex={-1}>
          <div className="alog-detail__head">
            <span className="alog-time">{formatTime(expanded.tsMs)}</span>
            <span className={`alog-badge alog-badge--${expanded.level}`}>{levelBadge(expanded.level)}</span>
            <span className={`alog-src alog-src--${sourceColorIndex(expanded.source)}`}>
              <SourceName source={expanded.source} />
            </span>
            <span className="alog-detail__kind">{expanded.kind}</span>
            <span className="alog-spacer" />
            <button
              type="button"
              className="alog-chip alog-detail__close"
              aria-label="Close detail"
              title="Close the detail (Esc)"
              onClick={() => actions.closeDetail()}
            >
              ✕ Close
            </button>
          </div>
          <pre className="alog-detail__text">
            <Marked text={expanded.text} marks={detailMarks.get("text")} current={findCurrent} />
          </pre>
          {expanded.detail !== null && (
            <pre className="alog-detail__more">
              <Marked text={expanded.detail} marks={detailMarks.get("detail")} current={findCurrent} />
            </pre>
          )}
          {expandedResult !== null && (
            <>
              <div className="alog-detail__sub" data-testid="alog-detail-result">
                <span className="alog-time">{formatTime(expandedResult.tsMs)}</span>
                <span className={`alog-badge alog-badge--${expandedResult.level}`}>{levelBadge(expandedResult.level)}</span>
                <span className="alog-detail__kind">tool-result</span>
              </div>
              <pre className="alog-detail__result">
                <Marked text={expandedResult.detail ?? expandedResult.text} marks={detailMarks.get("result")} current={findCurrent} />
              </pre>
            </>
          )}
        </div>
      )}
    </div>
    </RenamedSourcesContext.Provider>
  );
}
