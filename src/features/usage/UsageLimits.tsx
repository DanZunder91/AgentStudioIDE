/**
 * UsageLimits — the signed-in account's live usage limits, as a status strip at
 * the top of the left (Agents) rail.
 *
 * A distillation of Claude Code's own "Your usage limits" dialog: one row per
 * window, the label from the data on the left, a colour-coded `N% used` chip on
 * the right, the reset time on hover/focus. **No progress bars** — the number
 * is the signal. Colour comes from `usageTone()` and is
 * painted in `usage.css` off `data-tone` (see that file for the colourblind
 * lightness ramp).
 *
 * ── Honesty rules this component obeys ──────────────────────────────────────
 * It never renders a number it does not have. There is no `?? 0`, no placeholder
 * zero, no invented reset time:
 *   - no snapshot, no error  → a breathing "Reading usage…" placeholder;
 *   - no snapshot, an error  → the one true sentence from `describeUsageError`;
 *   - a snapshot + an error  → the last good numbers, marked **stale** (a failed
 *     refresh must not be able to pass old numbers off as live);
 *   - `resetsAtMs === null`  → the chip renders with no tooltip at all.
 *
 * ── Windows are data, not a schema ──────────────────────────────────────────
 * The rows are `snapshot.windows.map(...)` in the order Rust emitted, keyed by
 * the raw api key. Nothing here hard-codes three rows or a known key set — the
 * day the plan meters another model, the row simply appears (see the note on
 * `UsageWindow.key` in `usageTypes.ts`).
 *
 * ── Two clocks, both owned elsewhere in spirit ──────────────────────────────
 * `startUsagePolling()` owns the DATA cadence; this component only starts it on
 * mount and returns its stop function as the effect cleanup.
 *
 * The second clock is the panel's own "now", which the relative strings
 * ("Resets in 4 hr 34 min", "Updated 3 min ago") are measured against. It lives
 * in state and is advanced by a slow interval rather than read during render:
 * `Date.now()` in a render body is an impure read (`react-hooks/purity`), and it
 * would also mean the countdown only moved when some *other* state changed —
 * a panel whose "Updated just now" is 20 minutes old is exactly the dishonesty
 * this component is built to avoid.
 */

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

/**
 * A circular-arrow refresh glyph. Defined locally rather than in
 * `src/components/icons.tsx`: that file has no refresh glyph, and the feature
 * keeps its own.
 */
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

/**
 * How often the panel re-reads the wall clock, ms.
 *
 * Every string this drives has minute granularity at its finest, so 30s is the
 * coarsest tick that can never leave a stale minute on screen — and it is two
 * orders of magnitude cheaper than a per-second countdown nobody is watching.
 * Independent of `USAGE_POLL_MS`: this ticks the *display* of numbers we already
 * have, and must keep working at the same rate even while fetches are failing
 * and the store has backed off.
 */
const CLOCK_TICK_MS = 30_000;

export function UsageLimits(): React.JSX.Element {
  const snapshot = useUsageStore((s) => s.snapshot);
  const error = useUsageStore((s) => s.error);
  const loading = useUsageStore((s) => s.loading);
  const refresh = useUsageStore((s) => s.refresh);

  /**
   * Which chip's reset tooltip is open — at most one at a time. Hover or focus
   * opens it, leave/blur/Esc closes it. Kept as the window key (not a boolean per
   * row) so moving the pointer between chips can never leave two open.
   */
  const [openKey, setOpenKey] = useState<string | null>(null);

  /**
   * "Now", as one value shared by every relative-time string on screen, so the
   * rows can never disagree about it. Seeded by the lazy initializer (which runs
   * once, at mount) and advanced by the tick below — never read during render.
   */
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
