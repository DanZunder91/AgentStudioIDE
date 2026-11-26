/** Live usage-limits strip. Never renders a number it lacks: no snapshot → placeholder or the error
 * sentence; snapshot + error → last numbers marked stale. Rows are the data's windows, not a
 * schema. "Now" is state ticked by an interval, never read during render (`react-hooks/purity`). */

import { useEffect, useState } from "react";

import {
  describeUsageError,
  formatFetchedAt,
  formatResetsAt,
  formatUsedPct,
  usageTone,
} from "./usageFormat";
import { startUsagePolling, useUsageStore } from "./usageStore";
import "./usage.css";

/** A circular-arrow refresh glyph; `src/components/icons.tsx` has none. */
function RefreshIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
const STALE_LABEL = "Last refresh failed — showing the last good reading";

/** 30s: the coarsest tick that never leaves a stale minute on screen. Independent of
 * `USAGE_POLL_MS`, so the display keeps ticking while fetches fail and the store backs off. */
const CLOCK_TICK_MS = 30_000;

export function UsageLimits(): React.JSX.Element {
  const snapshot = useUsageStore((s) => s.snapshot);
  const error = useUsageStore((s) => s.error);
  const loading = useUsageStore((s) => s.loading);
  const refresh = useUsageStore((s) => s.refresh);

  /** The chip whose reset tooltip is open: a key, not a per-row boolean, so two can't be open. */
  const [openKey, setOpenKey] = useState<string | null>(null);

  /** One shared "now" so rows never disagree: set at mount and by the tick, never in render. */
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Mount starts the data poll, unmount stops it. The arrow returns the store's
  // stop function, which React uses as the cleanup — no fetch timer lives here.
  useEffect(() => startUsagePolling(), []);

  // The display clock. Cleared on unmount, so an unmounted rail leaves nothing
  // behind ticking.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  /** Numbers we have, that we could not re-verify. Not an error — an unknown. */
  const stale = snapshot !== null && error !== null;

  return (
    <section
      className={stale ? "usage usage--stale" : "usage"}
      aria-label="Usage limits"
      data-testid="usage-panel"
    >
      <div className="usage__header">
        <span className="usage__title">Usage</span>

        {snapshot === null ? null : stale ? (
          // role="img" + aria-label: the reliable way to give a text span a name
          // AT will actually announce (a bare aria-label on a generic role is not).
          <span
            className="usage__stale"
            role="img"
            aria-label={STALE_LABEL}
            data-testid="usage-stale"
          >
            stale
          </span>
        ) : (
          <span className="usage__updated" data-testid="usage-updated">
            {formatFetchedAt(snapshot.fetchedAtMs, nowMs)}
          </span>
        )}

        <button
          type="button"
          className={loading ? "usage__refresh usage__refresh--busy" : "usage__refresh"}
          aria-label="Refresh usage limits"
          aria-busy={loading}
          disabled={loading}
          title="Refresh usage limits"
          data-testid="usage-refresh"
          onClick={() => void refresh()}
        >
          <RefreshIcon />
        </button>
      </div>

      {snapshot === null ? (
        error === null ? (
          <p className="usage__placeholder" data-testid="usage-placeholder">
            Reading usage…
          </p>
        ) : (
          // `role="status"` so a fetch that fails after mount is announced once,
          // politely, instead of silently replacing the placeholder.
          <p className="usage__error" role="status" data-testid="usage-error">
            {describeUsageError(error)}
          </p>
        )
      ) : (
        <ul className="usage__rows">
          {snapshot.windows.map((w) => {
            const used = formatUsedPct(w.usedPct);
            // "" when the API omitted the reset time — then there is nothing to
            // reveal, so the chip gets no tooltip AND no tab stop (a focus stop
            // that reveals nothing is noise).
            const resetText = formatResetsAt(w.resetsAtMs, nowMs);
            const tipId = `usage-reset-${w.key}`;
            const tipOpen = resetText !== "" && openKey === w.key;

            return (
              <li className="usage__row" key={w.key} data-testid="usage-row" data-usage-key={w.key}>
                <span className="usage__label">{w.label}</span>
                <span
                  className="usage__chip"
                  data-tone={usageTone(w.usedPct)}
                  data-testid="usage-chip"
                  // Composed so the chip still says WHICH window it is when a
                  // keyboard user tabs straight to it, out of the row's context.
                  aria-label={`${w.label}: ${used}`}
                  // Only wired while the tooltip is actually in the DOM — a
                  // describedby pointing at a missing id is worse than none.
                  aria-describedby={tipOpen ? tipId : undefined}
                  tabIndex={resetText === "" ? undefined : 0}
                  onMouseEnter={() => setOpenKey(w.key)}
                  onMouseLeave={() => setOpenKey(null)}
                  onFocus={() => setOpenKey(w.key)}
                  onBlur={() => setOpenKey(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setOpenKey(null);
                  }}
                >
                  {used}
                </span>
                {tipOpen ? (
                  <span className="usage__tip" id={tipId} role="tooltip" data-testid="usage-tip">
                    {resetText}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
