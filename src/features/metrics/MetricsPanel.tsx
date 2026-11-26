/** The Claude metrics dashboard as a tab (not a modal: it persists and steals no Esc). It renders
 * only numbers it has (stale/empty states, no `?? 0`), never a summed token total, and labels
 * account figures "All devices" and transcript figures "This machine". */

import { useEffect, useState } from "react";

// The last path segment is the only part of a path this panel renders — either
// separator, so a Windows `C:\Users\…` never leaks whole into the scope button.
import { basename } from "../../lib/paths";
import { ContextCard } from "../context/ContextBar";
import { describeUsageError, formatUsedPct, usageTone } from "../usage/usageFormat";
import { startUsagePolling, useUsageStore } from "../usage/usageStore";
import {
  UNKNOWN,
  describeMetricsError,
  formatAvgContext,
  formatClock,
  formatCount,
  formatCoverageBadge,
  formatDuration,
  formatDurationCoverage,
  formatDurationSource,
  formatEmptyNote,
  formatEmptyTitle,
  formatExact,
  formatHourLabel,
  formatScannedAt,
  formatScopeCoverage,
  formatShare,
  formatTokens,
  formatTurnFooter,
  formatTurnSubtitle,
  scopeLabel,
  turnLabel,
  windowLabel,
} from "./metricsFormat";
import { ensureMetrics, useMetricsStore } from "./metricsStore";
import type { HourBucket, MetricsReport, MetricsWindowKind, TurnRow } from "./metricsTypes";
import "./metrics.css";

/** Local, like `UsageLimits.tsx`'s `RefreshIcon`, so the feature touches no shared file. */
function ChartIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M2 13.25h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <rect x="3.1" y="8" width="2.6" height="4" rx="0.8" fill="currentColor" />
      <rect x="6.7" y="5" width="2.6" height="7" rx="0.8" fill="currentColor" />
      <rect x="10.3" y="2.6" width="2.6" height="9.4" rx="0.8" fill="currentColor" />
    </svg>
  );
}

/** A circular-arrow refresh glyph. Local for the same reason as {@link ChartIcon}. */
function RefreshIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
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

/** The accessible sentence behind the stale marker — asserted verbatim in tests. */
const STALE_LABEL = "Last scan failed — showing the last good numbers";

/** Wall-clock re-read interval, ms: 30 s never leaves a stale minute on screen. Kept in state, not
 * read in render, because `Date.now()` in render is impure (`react-hooks/purity`). */
const CLOCK_TICK_MS = 30_000;

/** Best-effort swallow — a clipboard failure must never throw out of a click. */
const noop = (): void => {};

export function MetricsPanel({ cwd }: { cwd: string | null }): React.JSX.Element {
  const report = useMetricsStore((s) => s.report);
  const error = useMetricsStore((s) => s.error);
  const loading = useMetricsStore((s) => s.loading);
  const query = useMetricsStore((s) => s.query);
  const refresh = useMetricsStore((s) => s.refresh);
  const setWindow = useMetricsStore((s) => s.setWindow);
  const setScope = useMetricsStore((s) => s.setScope);

  /** Which turn's detail is expanded — at most one, so two can never both be open. */
  const [openTurn, setOpenTurn] = useState<string | null>(null);
  /** Whether the coverage block is expanded from its badge. */
  const [coverageOpen, setCoverageOpen] = useState(false);
  /** "Now", one value shared by every relative string so the rows cannot disagree. */
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Point the store at this project and fetch if it must. `ensureMetrics` is what
  // keeps re-opening the tab from re-sweeping the disk.
  useEffect(() => {
    ensureMetrics(cwd);
  }, [cwd]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  /** Numbers we have, that we could not re-verify. Not an error — an unknown. */
  const stale = report !== null && error !== null;

  return (
    <section
      className={stale ? "metrics metrics--stale" : "metrics"}
      aria-label="Claude metrics"
      data-testid="metrics-panel"
    >
      <header className="metrics__header">
        <span className="metrics__brand">
          <ChartIcon />
          <span className="metrics__brand-text">Metrics</span>
        </span>

        <div
          className="metrics__windows"
          role="group"
          aria-label="Window"
          data-testid="metrics-windows"
        >
          {(["last_24h", "last_7d"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={
                query.window === kind
                  ? "metrics__window metrics__window--on"
                  : "metrics__window"
              }
              aria-pressed={query.window === kind}
              data-testid={`metrics-window-${kind}`}
              onClick={() => void setWindow(kind)}
            >
              {kind === "last_24h" ? "24 h" : "7 d"}
            </button>
          ))}
        </div>

        {/* "This project" is disabled with nothing selected (it would error); `title` says why. */}
        <div
          className="metrics__windows"
          role="group"
          aria-label="Scope"
          data-testid="metrics-scopes"
        >
          {(["all", "project"] as const).map((kind) => {
            const unavailable = kind === "project" && cwd === null;
            return (
              <button
                key={kind}
                type="button"
                className={
                  query.scope === kind
                    ? "metrics__window metrics__window--on"
                    : "metrics__window"
                }
                aria-pressed={query.scope === kind}
                disabled={unavailable}
                title={
                  unavailable
                    ? "Select an agent in the rail to scope the dashboard to its project"
                    : undefined
                }
                data-testid={`metrics-scope-${kind}`}
                onClick={() => void setScope(kind)}
              >
                {scopeLabel(kind)}
                {/* `!= null` covers undefined too: a caller omitting the prop would
                    otherwise reach `basename(undefined)` and take down the panel — the
                    same null-cwd family of bug as the no-selection one. */}
                {kind === "project" && cwd != null ? ` · ${basename(cwd)}` : ""}
              </button>
            );
          })}
        </div>

        <span className="metrics__spacer" />

        {report === null ? null : stale ? (
          // role="img" + aria-label: the reliable way to give a text span a name AT
          // will announce (a bare aria-label on a generic role is not).
          <span
            className="metrics__stale"
            role="img"
            aria-label={STALE_LABEL}
            data-testid="metrics-stale"
          >
            stale
          </span>
        ) : (
          <span className="metrics__fresh" data-testid="metrics-scanned">
            {formatScannedAt(report.scannedAtMs, nowMs)}
          </span>
        )}

        {report === null ? null : (
          <button
            type="button"
            className={
              report.coverage.partial
                ? "metrics__badge metrics__badge--partial"
                : "metrics__badge"
            }
            aria-expanded={coverageOpen}
            data-testid="metrics-coverage-badge"
            onClick={() => setCoverageOpen((v) => !v)}
          >
            {formatCoverageBadge(report.coverage)}
          </button>
        )}

        <button
          type="button"
          className={loading ? "metrics__rescan metrics__rescan--busy" : "metrics__rescan"}
          aria-label="Rescan sessions"
          aria-busy={loading}
          disabled={loading}
          data-testid="metrics-rescan"
          onClick={() => void refresh()}
        >
          <RefreshIcon />
          <span>Rescan</span>
        </button>
      </header>

      {/* Tier 1, above everything — and OUTSIDE the report conditional on purpose: the
          account figures are a different data source with a different failure mode, so a
          failed transcript scan must not blank them (nor vice versa). */}
      <AccountUsage />

      {/* Outside the report conditional: a failed transcript scan says nothing about context fill.
          Shown in both scopes (it is always one agent); shares the panel clock. */}
      <ContextCard nowMs={nowMs} />

      {report === null ? (
        error === null ? (
          <div className="metrics__state" data-testid="metrics-placeholder">
            <ChartIcon />
            <p className="metrics__state-title">Reading your sessions…</p>
            <p className="metrics__state-note">
              Counting turns, requests and tokens from this machine&apos;s transcripts.
            </p>
          </div>
        ) : (
          // role="status" so a scan that fails after mount is announced once,
          // politely, instead of silently replacing the placeholder.
          <div className="metrics__state metrics__state--error" role="status" data-testid="metrics-error">
            <p className="metrics__state-title">Could not read your sessions</p>
            <p className="metrics__state-note">{describeMetricsError(error)}</p>
          </div>
        )
      ) : (
        <div className="metrics__body">
          {coverageOpen ? <CoverageBlock report={report} /> : null}
          <p className="metrics__tier" data-testid="metrics-tier">
            This machine · derived from local transcripts
            <span className="metrics__tier-note">
              {scopeLabel(report.scope.kind)} · root sessions only — sub-agent (fan-out)
              transcripts are not counted yet.
            </span>
          </p>
          {/* The report answered a WIDER question than it was asked. Said out loud rather
              than absorbed silently — the honest version of an earlier error. */}
          {report.coverage.scopeFellBackToAll ? (
            <p className="metrics__fallback" role="status" data-testid="metrics-fallback">
              Showing every project on this machine — no agent is selected, so there is no
              project to narrow to.
            </p>
          ) : null}
          {report.totals.turns === 0 ? (
            <EmptyWindow report={report} />
          ) : (
            <>
              <Hero report={report} />
              <KpiRow report={report} />
              <TokenGroup report={report} />
              <HourlyChart buckets={report.hourly} window={query.window} />
              <TopTurns
                report={report}
                openTurn={openTurn}
                onToggle={(id) => setOpenTurn((cur) => (cur === id ? null : id))}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* ── tier 1: the account, and the only cross-device numbers here ─────────────── */

/** "All devices · from your Claude account": `/usage` windows are cross-device; everything below is
 * "This machine". Shares the ref-counted `startUsagePolling()` (no extra `claude` spawn); no bars,
 * as in the rail, and the reset countdown stays the rail's. */
function AccountUsage(): React.JSX.Element {
  const snapshot = useUsageStore((s) => s.snapshot);
  const error = useUsageStore((s) => s.error);

  // Mount starts the shared poll, unmount releases this consumer's reference. Returning
  // the stopper directly is the same shape `UsageLimits` uses.
  useEffect(() => startUsagePolling(), []);

  return (
    <section
      className="metrics__account"
      aria-label="Account usage across all devices"
      data-testid="metrics-account"
    >
      <p className="metrics__account-head" data-testid="metrics-account-label">
        <span className="metrics__account-tier">All devices · from your Claude account</span>
        <span className="metrics__account-note">
          Read from your own <code>claude</code> CLI, so it covers every machine you are
          signed in on — unlike the transcript figures below.
        </span>
      </p>
      {/* `== null` on purpose: undefined from an unset store must render the empty state too. */}
      {snapshot == null ? (
        error === null ? (
          <p className="metrics__account-state" data-testid="metrics-account-placeholder">
            Reading your account limits…
          </p>
        ) : (
          // role="status" so a failure after mount is announced once, politely.
          <p
            className="metrics__account-state metrics__account-state--error"
            role="status"
            data-testid="metrics-account-error"
          >
            {describeUsageError(error)}
          </p>
        )
      ) : (
        <ul className="metrics__account-rows">
          {snapshot.windows.map((w) => (
            <li
              className="metrics__account-row"
              key={w.key}
              data-testid="metrics-account-row"
              data-usage-key={w.key}
            >
              <span className="metrics__account-row-label">{w.label}</span>
              <span
                className="metrics__account-chip"
                data-tone={usageTone(w.usedPct)}
                // Composed, so the chip still says WHICH window it is out of context.
                aria-label={`${w.label}: ${formatUsedPct(w.usedPct)}`}
              >
                {formatUsedPct(w.usedPct)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── the empty window: composed, not broken ─────────────────────────────────── */

function EmptyWindow({ report }: { report: MetricsReport }): React.JSX.Element {
  return (
    <div className="metrics__state" data-testid="metrics-empty">
      <ChartIcon />
      {/* Scope-aware, because "no sessions today" and "no sessions in this folder today"
          are different facts and an earlier version only ever stated the second. */}
      <p className="metrics__state-title">
        {formatEmptyTitle(report.scope.kind, report.window.kind)}
      </p>
      <p className="metrics__state-note">
        {formatEmptyNote(report.scope.kind, report.coverage.filesConsidered)}
      </p>
    </div>
  );
}

/* ── row 1: the hero ────────────────────────────────────────────────────────── */

/** "Time in turns", never "time worked": concurrent agents overlap, so it can exceed wall-clock. */
function Hero({ report }: { report: MetricsReport }): React.JSX.Element {
  const t = report.totals;
  const coverage = formatDurationCoverage(t.turnsWithDuration, t.turns);
  return (
    <div className="metrics__hero" data-testid="metrics-hero">
      <span className="metrics__hero-label">Time in turns</span>
      <span className="metrics__hero-value" data-testid="metrics-hero-value">
        {formatDuration(t.timeInTurnsMs)}
      </span>
      <span className="metrics__hero-sub" data-testid="metrics-hero-sub">
        {formatTurnSubtitle(t.humanTurns, t.turns, t.sessions)}
      </span>
      <span className="metrics__hero-def">
        Σ of each turn&apos;s own duration — not wall clock, because concurrent agents
        overlap.
        {coverage === "" ? "" : ` ${coverage}.`}
      </span>
    </div>
  );
}

/* ── row 2: the KPI tiles ───────────────────────────────────────────────────── */

function KpiRow({ report }: { report: MetricsReport }): React.JSX.Element {
  const t = report.totals;
  return (
    <div className="metrics__kpis" data-testid="metrics-kpis">
      <Kpi label="Sessions" value={t.sessions} />
      <Kpi label="Turns" value={t.turns} />
      <Kpi label="Requests" value={t.requests} hint="Distinct API requests, deduplicated" />
      <Kpi label="Tool calls" value={t.toolCalls} />
      <Kpi label="Tool errors" value={t.toolErrors} />
      <Kpi label="Files changed" value={t.filesChanged} hint="Distinct paths edited" />
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="metrics__kpi" data-testid="metrics-kpi" title={hint}>
      <span className="metrics__kpi-label">{label}</span>
      <span className="metrics__kpi-value">{formatCount(value)}</span>
    </div>
  );
}

/* ── row 3: the token group ─────────────────────────────────────────────────── */

/** Four tiles and no total: the wire has none (see `metricsTypes.ts`), and the reason is shown. */
function TokenGroup({ report }: { report: MetricsReport }): React.JSX.Element {
  const { freshInput, output, cacheWrite, cacheRead } = report.totals.tokens;
  return (
    <section className="metrics__tokens" aria-label="Tokens" data-testid="metrics-tokens">
      <h3 className="metrics__tokens-title">Tokens — four classes, never summed</h3>
      <div className="metrics__tokens-grid">
        <TokenTile label="Fresh input" value={freshInput} />
        <TokenTile label="Output" value={output} />
        <TokenTile label="Cache write" value={cacheWrite} />
        <TokenTile label="Cache read" value={cacheRead} />
        <div
          className="metrics__token metrics__token--derived"
          data-testid="metrics-avg-context"
        >
          <span className="metrics__token-label">Avg context / request</span>
          <span className="metrics__token-value">
            {formatAvgContext(report.totals.avgContextPerRequest)}
          </span>
          <span className="metrics__token-foot">
            {formatShare(report.totals.highContextRequestShare)} at ≥150k
            <abbr title="150k is Claude Code's own threshold, quoted from its /usage output — not a number we invented.">
              ?
            </abbr>
          </span>
        </div>
      </div>
      <p className="metrics__tokens-why">
        Cache reads are ~0.1× the price of fresh input, so a single total would be
        misleading — 97.9% of a typical 24 h here was cache reads. The average context
        per request is the honest headline.
      </p>
    </section>
  );
}

function TokenTile({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="metrics__token" data-testid="metrics-token-tile">
      <span className="metrics__token-label">{label}</span>
      <span className="metrics__token-value" title={`${formatExact(value)} tokens`}>
        {formatTokens(value)}
      </span>
    </div>
  );
}

/* ── row 4: requests per hour ───────────────────────────────────────────────── */

/** Chart geometry, in viewBox units. Vertical units map 1:1 to CSS pixels. */
const CHART = { width: 720, height: 132, gutter: 44, top: 10, bottom: 20 } as const;
/** Widest a column may be — a fat bar at 24 buckets reads as a block, not a series. */
const MAX_BAR = 24;
/** Gap between columns, viewBox units. */
const BAR_GAP = 2;
/** Rounded top, square baseline. */
const BAR_RADIUS = 4;

/** Requests per hour as hand-rolled SVG (no chart dependency in the zero-tolerance prod tree).
 * viewBox height = CSS height with `preserveAspectRatio="none"`: vertical geometry stays exact and
 * only x stretches (BAR_RADIUS may ovalize). Each column has a `<title>`. */
function HourlyChart({
  buckets,
  window: windowKind,
}: {
  buckets: HourBucket[];
  window: MetricsWindowKind;
}): React.JSX.Element {
  const peak = Math.max(...buckets.map((b) => b.requests), 0);
  const top = niceMax(peak);
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const slot = (CHART.width - CHART.gutter) / Math.max(buckets.length, 1);
  const barWidth = Math.max(1, Math.min(MAX_BAR, slot - BAR_GAP));
  const baseline = CHART.top + plotHeight;

  const copy = (): void => {
    if (!navigator.clipboard) return;
    const lines = buckets.map(
      (b) => `${formatHourLabel(b.startMs)}\t${b.requests} requests\t${b.output} output`,
    );
    void navigator.clipboard.writeText(lines.join("\n")).catch(noop);
  };

  return (
    <section className="metrics__chart" aria-label="Requests per hour" data-testid="metrics-chart">
      <div className="metrics__chart-head">
        <h3 className="metrics__chart-title">Requests per hour</h3>
        <span className="metrics__chart-sub">
          {windowLabel(windowKind)} · peak {formatCount(peak)}
        </span>
        <button
          type="button"
          className="metrics__chart-copy"
          data-testid="metrics-copy-summary"
          onClick={copy}
        >
          Copy summary
        </button>
      </div>
      <svg
        className="metrics__chart-svg"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Requests per hour over the ${windowLabel(windowKind)}, peak ${peak}`}
        data-testid="metrics-chart-svg"
      >
        {/* Two y ticks only — 0 and a clean top. A tick per bucket would be chrome. */}
        <text className="metrics__tick" x={CHART.gutter - 8} y={CHART.top + 4} textAnchor="end">
          {formatCount(top)}
        </text>
        <text className="metrics__tick" x={CHART.gutter - 8} y={baseline + 4} textAnchor="end">
          0
        </text>
        {/* The hairline axis, exactly one step off the surface — a rect, not a stroked
            line, so `preserveAspectRatio="none"` cannot make it a half-pixel blur. */}
        <rect
          className="metrics__axis"
          x={CHART.gutter}
          y={baseline}
          width={CHART.width - CHART.gutter}
          height={1}
        />
        {buckets.map((b, i) => {
          const h = top === 0 ? 0 : (b.requests / top) * plotHeight;
          const x = CHART.gutter + i * slot + (slot - barWidth) / 2;
          return (
            <g key={b.startMs}>
              {h > 0 ? (
                <path className="metrics__bar" d={barPath(x, baseline - h, barWidth, h)} />
              ) : null}
              <title>{`${formatHourLabel(b.startMs)} — ${formatCount(b.requests)} requests`}</title>
            </g>
          );
        })}
        {/* Sparse x labels: first, middle, last. More would collide at 168 buckets. */}
        {xTicks(buckets).map(({ index, label }) => (
          <text
            key={index}
            className="metrics__tick"
            x={CHART.gutter + index * slot + slot / 2}
            y={CHART.height - 6}
            textAnchor="middle"
          >
            {label}
          </text>
        ))}
      </svg>
    </section>
  );
}

/** A column with rounded top corners and a square base; the radius is clamped so a 1-unit column
 * cannot invert into a lens. */
export function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(BAR_RADIUS, w / 2, h);
  return [
    `M${round(x)} ${round(y + h)}`,
    `L${round(x)} ${round(y + r)}`,
    `Q${round(x)} ${round(y)} ${round(x + r)} ${round(y)}`,
    `L${round(x + w - r)} ${round(y)}`,
    `Q${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + r)}`,
    `L${round(x + w)} ${round(y + h)}`,
    "Z",
  ].join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Smallest 1/2/5 × 10^n at or above `peak`, for a readable axis top; `0` stays `0`. */
export function niceMax(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 5]) {
    if (peak <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/** First, middle and last bucket labels — enough to orient, few enough to fit. */
function xTicks(buckets: HourBucket[]): Array<{ index: number; label: string }> {
  if (buckets.length === 0) return [];
  const indices = [...new Set([0, Math.floor(buckets.length / 2), buckets.length - 1])];
  return indices.map((index) => ({
    index,
    label: formatHourLabel(buckets[index].startMs),
  }));
}

/* ── row 5: the top-turns table ─────────────────────────────────────────────── */

/** The only place with `tabular-nums` (see `metrics.css`): table columns must align. */
function TopTurns({
  report,
  openTurn,
  onToggle,
}: {
  report: MetricsReport;
  openTurn: string | null;
  onToggle: (turnId: string) => void;
}): React.JSX.Element {
  const capped = report.topTurns.length < report.totals.turns;
  return (
    <section className="metrics__turns" aria-label="Top turns" data-testid="metrics-turns">
      <div className="metrics__chart-head">
        <h3 className="metrics__chart-title">
          {capped
            ? `Top ${formatCount(report.topTurns.length)} of ${formatCount(report.totals.turns)} turns`
            : `${formatCount(report.totals.turns)} turns`}
        </h3>
        <span className="metrics__chart-sub">
          Ranked by context volume (cache read) — not by money; we do not price.
        </span>
      </div>
      <table className="metrics__table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Turn</th>
            <th scope="col" className="metrics__num">Duration</th>
            <th scope="col" className="metrics__num">Reqs</th>
            <th scope="col" className="metrics__num">Output</th>
            <th scope="col" className="metrics__num">Cache read</th>
            <th scope="col" className="metrics__num">Tools</th>
            <th scope="col" className="metrics__num">Files</th>
          </tr>
        </thead>
        <tbody>
          {report.topTurns.map((turn) => (
            <TurnRows
              key={turn.turnId}
              turn={turn}
              open={openTurn === turn.turnId}
              onToggle={() => onToggle(turn.turnId)}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TurnRows({
  turn,
  open,
  onToggle,
}: {
  turn: TurnRow;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const source = formatDurationSource(turn.durationSource);
  return (
    <>
      <tr
        className={open ? "metrics__row metrics__row--open" : "metrics__row"}
        data-testid="metrics-turn-row"
        data-turn-id={turn.turnId}
      >
        <td className="metrics__when">{formatClock(turn.startedAtMs)}</td>
        <td className="metrics__label-cell">
          <button
            type="button"
            className="metrics__turn-button"
            aria-expanded={open}
            data-testid="metrics-turn-toggle"
            onClick={onToggle}
          >
            <span className="metrics__turn-name">{turnLabel(turn)}</span>
            {turn.humanPrompt ? null : (
              <span className="metrics__flag" title="Started by the CLI, not typed">
                system
              </span>
            )}
            {turn.interrupted ? (
              <span className="metrics__flag metrics__flag--warn" title="Interrupted">
                interrupted
              </span>
            ) : null}
          </button>
        </td>
        <td className="metrics__num">
          {formatDuration(turn.durationMs)}
          {source === "" ? null : <span className="metrics__src">{source}</span>}
        </td>
        <td className="metrics__num">{formatCount(turn.requests)}</td>
        <td className="metrics__num">{formatTokens(turn.tokens.output)}</td>
        <td className="metrics__num">{formatTokens(turn.tokens.cacheRead)}</td>
        <td className="metrics__num">
          {formatCount(turn.toolCalls)}
          {turn.toolErrors > 0 ? (
            <span className="metrics__src metrics__src--warn">
              {formatCount(turn.toolErrors)} err
            </span>
          ) : null}
        </td>
        <td className="metrics__num">{formatCount(turn.filesChanged)}</td>
      </tr>
      {open ? (
        <tr className="metrics__detail-row">
          <td colSpan={8}>
            <div className="metrics__detail" data-testid="metrics-turn-detail">
              {/* The corrected form of the CLI's own footer — the four classes kept
                  apart, because even at one-turn scale cache reads dominate by ~250×. */}
              <p className="metrics__footer-line" data-testid="metrics-turn-footer">
                {formatTurnFooter(turn)}
              </p>
              <dl className="metrics__detail-grid">
                <div>
                  <dt>Session</dt>
                  <dd>{turn.sessionId.slice(0, 8)}…</dd>
                </div>
                <div>
                  <dt>Project</dt>
                  <dd>{turn.projectLabel}</dd>
                </div>
                <div>
                  <dt>Models</dt>
                  <dd>{turn.models.length === 0 ? UNKNOWN : turn.models.join(", ")}</dd>
                </div>
                <div>
                  <dt>Cache write</dt>
                  <dd>{formatTokens(turn.tokens.cacheWrite)}</dd>
                </div>
                <div>
                  <dt>Duration source</dt>
                  <dd>{source === "" ? "unknown" : source}</dd>
                </div>
              </dl>
              <p className="metrics__detail-note">
                Sub-agent (fan-out) cost for this turn is not attributed yet.
              </p>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ── the coverage block ─────────────────────────────────────────────────────── */

function CoverageBlock({ report }: { report: MetricsReport }): React.JSX.Element {
  const c = report.coverage;
  return (
    <dl className="metrics__coverage" data-testid="metrics-coverage">
      {/* First, because every other number here is scoped by it — and because the
          fallback case must be readable somewhere other than a toast. */}
      <div>
        <dt>Scope</dt>
        <dd>{formatScopeCoverage(report.scope.kind, c.scopeFellBackToAll)}</dd>
      </div>
      <div>
        <dt>Transcripts</dt>
        <dd>
          {formatCount(c.filesRead)} read of {formatCount(c.filesConsidered)} checked
        </dd>
      </div>
      <div>
        <dt>Bytes</dt>
        <dd>{formatExact(c.bytesRead)}</dd>
      </div>
      <div>
        <dt>Scan</dt>
        <dd>{formatCount(c.scanMs)} ms</dd>
      </div>
      <div>
        <dt>Truncated</dt>
        <dd>{formatCount(c.filesTruncated)}</dd>
      </div>
      <div>
        <dt>Unreadable lines</dt>
        <dd>{formatCount(c.linesUnparseable)}</dd>
      </div>
      <div>
        <dt>Turns without a CLI duration</dt>
        <dd>{formatCount(c.turnsWithoutCliDuration)}</dd>
      </div>
      <div>
        <dt>Turns with inferred boundaries</dt>
        <dd>{formatCount(c.turnsWithoutPromptId)}</dd>
      </div>
      <div>
        <dt>Sources</dt>
        <dd>
          {report.perRoot.map((r) => `${r.label}${r.available ? "" : " (unavailable)"}`).join(", ")}
        </dd>
      </div>
    </dl>
  );
}
