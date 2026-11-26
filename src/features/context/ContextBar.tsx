/** The SELECTED agent's context window, as /context breaks it down; proportions come from
 * contextFormat.ts. Follows the selection, not the tab's cwd; a sub-agent gets a note (its turns
 * live in the root's window). Never a number we don't have; the estimate caveat stays visible. */

import { useEffect } from "react";

import { useAppStore } from "../../app/store";
import type { AgentNode } from "../../app/types";
import {
  BUFFER_KEY,
  FREE_KEY,
  GRID_COLUMNS,
  barLayout,
  contextColour,
  contextTone,
  describeContextError,
  formatContextPct,
  formatContextSummary,
  formatContextTokens,
  formatMeasuredAt,
  gridCells,
  isCalmError,
} from "./contextFormat";
import type { ContextError } from "./contextIpc";
import { noteAgentStatus, useContextStore, type ContextView } from "./contextStore";
import type { ContextUsage } from "./contextTypes";
import "./context.css";

/** The caveat under every reading — asserted verbatim in tests. */
export const CONTEXT_CAVEAT = "Estimated by the claude CLI for this session (same as /context)";

/** The calm notes for the two "nothing to measure" selections. */
export const NO_SELECTION_NOTE = "Select an agent to see its context window";
export const SUB_AGENT_NOTE = "Context is shown for root agents — select this agent's root to see its window";

/** A circular-arrow refresh glyph — feature-local, for the reason `MetricsPanel`'s is. */
function RefreshIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M13.4 2.4v3.1h-3.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The one place bar, grid and legend decide how a key is drawn, so they agree on "free". */
function kindClass(base: string, key: string): string {
  if (key === FREE_KEY) return `${base} ${base}--free`;
  if (key === BUFFER_KEY) return `${base} ${base}--buffer`;
  return base;
}

/** As --seg-colour so hatch/cross patterns can reuse it. Free space has none: it IS the track. */
function colourStyle(key: string): React.CSSProperties {
  return key === FREE_KEY ? {} : ({ "--seg-colour": contextColour(key) } as React.CSSProperties);
}

/** What the selection lets the card measure. */
type Target =
  | { kind: "none" }
  | { kind: "sub-agent" }
  | { kind: "ready"; agentId: string; status: AgentNode["status"] };

function targetOf(agent: AgentNode | null): Target {
  if (agent === null) return { kind: "none" };
  if (agent.parentId !== null) return { kind: "sub-agent" };
  return { kind: "ready", agentId: agent.id, status: agent.status };
}

/** nowMs is the host panel's tick (MetricsPanel), so "measured … ago" moves with the dashboard. */
export function ContextCard({ nowMs }: { nowMs: number }): React.JSX.Element {
  // The agent OBJECT, not a derived target: a selector that builds a new object on
  // every call would re-render forever. The store hands back the same reference until
  // that agent actually changes.
  const agent = useAppStore((s) => {
    const id = s.selection.selectedAgentId;
    return id === null ? null : (s.agents[id] ?? null);
  });
  const target = targetOf(agent);
  const agentId = target.kind === "ready" ? target.agentId : null;
  const status = target.kind === "ready" ? target.status : null;

  const entry = useContextStore((s) => (agentId === null ? undefined : s.entries[agentId]));
  const refresh = useContextStore((s) => s.refresh);
  const view = useContextStore((s) => s.view);
  const setView = useContextStore((s) => s.setView);

  // Mount and selection change: take a reading. Single-flight in the store makes a
  // StrictMode double-mount, or this landing on top of the idle edge below, one spawn.
  useEffect(() => {
    if (agentId !== null) void refresh(agentId);
  }, [agentId, refresh]);

  // The turn-ended edge. The store decides whether this status is an edge; the card
  // only reports what it sees.
  useEffect(() => {
    if (agentId !== null && status !== null) noteAgentStatus(agentId, status);
  }, [agentId, status]);

  const data = entry?.data ?? null;
  const error = entry?.error ?? null;
  const loading = entry?.loading ?? false;
  const stale = data !== null && error !== null;

  return (
    <section
      className={stale ? "context-card context-card--stale" : "context-card"}
      aria-label="Context window"
      data-testid="context-card"
    >
      <header className="context-card__head">
        <span className="context-card__brand">
          <span className="context-card__diamond" aria-hidden="true">
            ◆
          </span>
          context
        </span>
        {data ? (
          <span className="context-card__head-right">
            <span className="context-card__summary" data-testid="context-summary">
              {formatContextSummary(data)}
            </span>
            <span
              className="context-card__chip"
              data-tone={contextTone(data.usedPercent)}
              aria-label={`Context window ${formatContextPct(data.usedPercent)} full`}
              data-testid="context-chip"
            >
              {formatContextPct(data.usedPercent)}
            </span>
            <ViewToggle view={view} onChange={setView} />
          </span>
        ) : null}
      </header>

      {target.kind === "ready" ? (
        <>
          <ReadingBody data={data} error={error} view={view} />
          <footer className="context-card__foot">
            <span className="context-card__meta">
              {data ? (
                <>
                  <span className="context-card__model" data-testid="context-model">
                    {data.model}
                  </span>
                  <span className="context-card__measured" data-testid="context-measured">
                    {formatMeasuredAt(data.measuredAtMs, nowMs)}
                  </span>
                </>
              ) : null}
              <button
                type="button"
                className={loading ? "context-card__refresh context-card__refresh--busy" : "context-card__refresh"}
                aria-label="Refresh context window"
                aria-busy={loading}
                disabled={loading}
                data-testid="context-refresh"
                onClick={() => void refresh(target.agentId)}
              >
                <RefreshIcon />
              </button>
            </span>
            {data ? (
              <span className="context-card__caveat" data-testid="context-caveat">
                {CONTEXT_CAVEAT}
              </span>
            ) : null}
          </footer>
        </>
      ) : (
        <p className="context-card__note" data-testid="context-note">
          {target.kind === "none" ? NO_SELECTION_NOTE : SUB_AGENT_NOTE}
        </p>
      )}
    </section>
  );
}

/** The `Bar | Grid` segmented toggle. */
function ViewToggle({
  view,
  onChange,
}: {
  view: ContextView;
  onChange: (view: ContextView) => void;
}): React.JSX.Element {
  return (
    <span className="context-card__views" role="group" aria-label="Context drawing" data-testid="context-views">
      {(["bar", "grid"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={view === v ? "context-card__view context-card__view--on" : "context-card__view"}
          aria-pressed={view === v}
          data-testid={`context-view-${v}`}
          onClick={() => onChange(v)}
        >
          {v === "bar" ? "Bar" : "Grid"}
        </button>
      ))}
    </span>
  );
}

/** Everything between header and footer, for a selection we can measure. */
function ReadingBody({
  data,
  error,
  view,
}: {
  data: ContextUsage | null;
  error: ContextError | null;
  view: ContextView;
}): React.JSX.Element {
  if (data === null) {
    if (error === null) {
      return (
        <p className="context-card__note" data-testid="context-loading">
          Measuring context…
        </p>
      );
    }
    // role="status" so a failure that lands after mount is announced once, politely.
    return (
      <p
        className={isCalmError(error) ? "context-card__note" : "context-card__note context-card__note--error"}
        role="status"
        data-testid="context-error"
        data-code={error}
      >
        {describeContextError(error)}
      </p>
    );
  }
  return (
    <>
      <div className="context-card__drawing">
        {view === "bar" ? <ContextStackedBar usage={data} /> : <ContextGrid usage={data} />}
      </div>
      <ContextLegend usage={data} />
      {error !== null ? (
        <p className="context-card__stale" role="status" data-testid="context-stale" data-code={error}>
          Last refresh failed — showing the last good reading. {describeContextError(error)}
        </p>
      ) : null}
    </>
  );
}

/** The stacked horizontal bar. Exported for the browser-tier layout test. */
export function ContextStackedBar({ usage }: { usage: ContextUsage }): React.JSX.Element {
  const { segments, compactAtPct } = barLayout(usage);
  return (
    <div
      className="context-bar"
      role="img"
      aria-label={`Context window: ${formatContextSummary(usage)}`}
      data-testid="context-bar"
    >
      {segments.map(({ category, widthPct }) => (
        <span
          key={category.key}
          className={kindClass("context-bar__seg", category.key)}
          data-testid="context-seg"
          data-key={category.key}
          title={`${category.label}: ${formatContextTokens(category.tokens)}`}
          // The colour comes from the one map the legend also reads.
          style={{ width: `${widthPct}%`, ...colourStyle(category.key) }}
        />
      ))}
      {compactAtPct !== null ? (
        <span className="context-bar__marker" data-testid="context-marker" style={{ left: `${compactAtPct}%` }} />
      ) : null}
    </div>
  );
}

/** The `/context`-style 20×10 grid. Exported for the browser-tier layout test. */
export function ContextGrid({ usage }: { usage: ContextUsage }): React.JSX.Element {
  const cells = gridCells(usage);
  return (
    <div
      className="context-grid"
      role="img"
      aria-label={`Context window grid: ${formatContextSummary(usage)}`}
      data-testid="context-grid"
      style={{ "--grid-columns": GRID_COLUMNS } as React.CSSProperties}
    >
      {cells.map((key, i) => (
        <span
          // Cells are positional by nature: cell 37 is cell 37 whatever paints it.
          key={i}
          className={kindClass("context-grid__cell", key)}
          data-testid="context-cell"
          data-key={key}
          style={colourStyle(key)}
        />
      ))}
    </div>
  );
}

/** The legend. Free space shows tokens only — its percent is just "the rest". */
function ContextLegend({ usage }: { usage: ContextUsage }): React.JSX.Element {
  return (
    <ul className="context-legend" aria-label="Context by category" data-testid="context-legend">
      {usage.categories.map((c) => (
        <li key={c.key} className="context-legend__item" data-testid="context-legend-item" data-key={c.key}>
          <span
            className={kindClass("context-legend__swatch", c.key)}
            aria-hidden="true"
            style={colourStyle(c.key)}
          />
          <span className="context-legend__label">{c.label}</span>
          <span className="context-legend__tokens">{formatContextTokens(c.tokens)}</span>
          {c.key === FREE_KEY ? null : <span className="context-legend__pct">{formatContextPct(c.percent)}</span>}
        </li>
      ))}
    </ul>
  );
}
