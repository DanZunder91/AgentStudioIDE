/** Epoch ⇄ date converter: ONE input, classified by `parseToolInput` and shown (unit, format and
 * reason printed verbatim). No conversion maths here: the engine is `BigInt`-exact. The other
 * readings are always shown unfolded, since a wrong unit is a plausible answer decades off. */

import { useEffect, useState } from "react";

import { parseToolInput } from "./epoch";
import {
  EPOCH_UNITS,
  UNIT_LABEL,
  civilInZone,
  epochIn,
  viewInstant,
  type EpochReading,
  type Instant,
  type NumericEpoch,
} from "./instant";
import type { DateParse, DateReading } from "./dateParse";

/** Best-effort swallow — a clipboard rejection must never throw out of a click. */
const noop = (): void => {};

/** The host's IANA zone, or `UTC` when the platform names none. Exported so the test can falsify
 * the fallback; an `undefined` here would poison every local line. */
export function hostTimeZone(): string {
  const zone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === undefined || zone === "" ? "UTC" : zone;
}

/** The shapes the empty state names — real inputs, not a grammar. */
const HINT =
  "Type an epoch (1700000000), an ISO timestamp (2023-11-14T22:13:20Z), a plain date (2024/01/25 or 25 Jan 2024), or “now”. Which way to convert is decided from what you type, and what was decided is shown.";

/** What an unrepresentable reading says instead of a date. */
const OUT_OF_RANGE = "Out of the range a calendar can represent.";

/** The house copy pattern (`LogsPanel.tsx`): no clipboard → bail, rejection → swallowed. Each
 * gets a distinct `aria-label` for screen readers. */
function CopyButton({ label, value }: { label: string; value: string }): React.JSX.Element {
  const copy = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).catch(noop);
  };
  return (
    <button type="button" className="tools-copy" aria-label={label} title={label} onClick={copy}>
      copy
    </button>
  );
}

/** Label ABOVE value, not beside: the rail can be 180px and clips (see `tools.css`). */
function ValueRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}): React.JSX.Element {
  return (
    <div className="epoch-row">
      <span className="epoch-row__label">{label}</span>
      <span className="epoch-row__line">
        <span className="epoch-row__value">{value}</span>
        <CopyButton label={copyLabel} value={value} />
      </span>
    </div>
  );
}

/** The same row without a copy button — for values nobody pastes ("2 hours ago"). */
function PlainRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="epoch-row">
      <span className="epoch-row__label">{label}</span>
      <span className="epoch-row__line">
        <span className="epoch-row__value">{value}</span>
      </span>
    </div>
  );
}

/** The four lines of every instant, UTC first, in ONE order for both directions: two layouts of
 * one instant would read as two answers. */
function InstantLines({
  instant,
  now,
  timeZone,
}: {
  instant: Instant;
  now: number;
  timeZone: string;
}): React.JSX.Element {
  const view = viewInstant(instant, { now, timeZone });
  return (
    <div className="epoch-lines">
      <ValueRow label="UTC" value={view.utc} copyLabel="Copy UTC" />
      <ValueRow label="ISO 8601" value={view.iso} copyLabel="Copy ISO 8601" />
      <ValueRow
        label={`Local · ${view.zoneName}`}
        value={`${view.local} · ${view.zoneOffset}`}
        copyLabel="Copy local time"
      />
      <PlainRow label="Relative" value={view.relative} />
    </div>
  );
}

/** The four epoch numbers, coarsest first — the copy targets of a date→epoch answer. */
function EpochLines({
  instant,
  now,
  timeZone,
}: {
  instant: Instant;
  now: number;
  timeZone: string;
}): React.JSX.Element {
  const view = viewInstant(instant, { now, timeZone });
  return (
    <div className="epoch-lines">
      {EPOCH_UNITS.map((unit) => (
        <ValueRow
          key={unit}
          label={UNIT_LABEL[unit]}
          value={view.epochs[unit]}
          copyLabel={`Copy ${UNIT_LABEL[unit]}`}
        />
      ))}
    </div>
  );
}

/** One of the three alternative unit readings of a bare number. */
function OtherReading({
  reading,
  now,
  timeZone,
}: {
  reading: EpochReading;
  now: number;
  timeZone: string;
}): React.JSX.Element {
  return (
    <li className="epoch-other" data-testid="epoch-other" data-unit={reading.unit}>
      <span className="epoch-other__unit">{UNIT_LABEL[reading.unit]}</span>
      {reading.instant === null ? (
        <span className="epoch-other__void">{OUT_OF_RANGE}</span>
      ) : (
        <OtherLines instant={reading.instant} now={now} timeZone={timeZone} />
      )}
    </li>
  );
}

/** An alternative reading's two lines. Deliberately UTC + ISO only — see {@link EpochView}. */
function OtherLines({
  instant,
  now,
  timeZone,
}: {
  instant: Instant;
  now: number;
  timeZone: string;
}): React.JSX.Element {
  const view = viewInstant(instant, { now, timeZone });
  return (
    <span className="epoch-other__lines">
      <span className="epoch-other__utc">{view.utc}</span>
      <span className="epoch-other__iso">{view.iso}</span>
    </span>
  );
}

/** A bare number: the winning unit and why, the instant, then the other readings (UTC and ISO
 * only: a wrong unit is decades off, so scanning for a plausible year is enough). */
function EpochView({
  epoch,
  now,
  timeZone,
}: {
  epoch: NumericEpoch;
  now: number;
  timeZone: string;
}): React.JSX.Element {
  return (
    <div className="epoch-result" data-testid="epoch-result">
      <p className="epoch-verdict">
        Read as <strong>{UNIT_LABEL[epoch.chosen.unit]}</strong>
        <span className="epoch-verdict__how">
          {epoch.explicit ? "from the suffix you typed" : "guessed from the digit count"}
        </span>
      </p>
      <p className="epoch-because">{epoch.chosen.because}</p>
      {epoch.chosen.instant === null ? (
        <p className="epoch-void">{OUT_OF_RANGE}</p>
      ) : (
        <InstantLines instant={epoch.chosen.instant} now={now} timeZone={timeZone} />
      )}
      <p className="epoch-subhead">Also reads as</p>
      <ul className="epoch-others">
        {epoch.others.map((reading) => (
          <OtherReading key={reading.unit} reading={reading} now={now} timeZone={timeZone} />
        ))}
      </ul>
    </div>
  );
}

/** One date reading: format, assumptions, epochs, instant, and for an offset-less string the epoch
 * of the same wall clock in the user's zone (what they usually mean). Skipped when `civil` is null
 * or `civilInZone` cannot resolve the zone. */
function DateReadingView({
  reading,
  now,
  timeZone,
}: {
  reading: DateReading;
  now: number;
  timeZone: string;
}): React.JSX.Element {
  const alternative = reading.civil === null ? null : civilInZone(reading.civil, timeZone);
  return (
    <div className="epoch-reading" data-testid="epoch-reading">
      <p className="epoch-verdict">
        Read as <strong>{reading.format}</strong>
      </p>
      {reading.assumption !== null && <p className="epoch-because">{reading.assumption}</p>}
      <EpochLines instant={reading.instant} now={now} timeZone={timeZone} />
      <InstantLines instant={reading.instant} now={now} timeZone={timeZone} />
      {alternative !== null && (
        <div className="epoch-alt" data-testid="epoch-alt">
          <span className="epoch-row__label">{`Or, read in ${timeZone} — seconds`}</span>
          <span className="epoch-row__line">
            <span className="epoch-row__value">{epochIn(alternative, "s")}</span>
            <CopyButton
              label={`Copy seconds read in ${timeZone}`}
              value={epochIn(alternative, "s")}
            />
          </span>
        </div>
      )}
    </div>
  );
}

/** A date string. An ambiguous one (`05/06/2010`) renders BOTH readings with equal weight under
 * the engine's explanation; hiding one would silently pick, wrong half the time. */
function DateView({
  parse,
  now,
  timeZone,
}: {
  parse: DateParse;
  now: number;
  timeZone: string;
}): React.JSX.Element {
  return (
    <div className="epoch-result" data-testid="epoch-result">
      {parse.ambiguity !== null && <p className="epoch-ambiguity">{parse.ambiguity}</p>}
      {parse.readings.map((reading) => (
        <DateReadingView
          key={reading.format}
          reading={reading}
          now={now}
          timeZone={timeZone}
        />
      ))}
    </div>
  );
}

/** How often the "now" row re-reads the clock. */
const TICK_MS = 1000;

export function EpochTool({
  clock = () => Date.now(),
  timeZone = hostTimeZone(),
}: {
  clock?: () => number;
  timeZone?: string;
}): React.JSX.Element {
  const [raw, setRaw] = useState("");
  // The tick exists only to re-render; the clock is read during render, so there is no
  // second copy of "now" to fall out of sync with the one the parse used.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const now = clock();
  // Floored: `epochIn` is exact `BigInt` arithmetic and a fractional millisecond is not
  // an instant. `Date.now()` is already integral; an injected clock need not be.
  const nowSeconds = epochIn({ epochMs: Math.floor(now), nanos: 0 }, "s");
  const result = parseToolInput(raw, now);

  return (
    <section className="epoch-tool" aria-label="Epoch converter" data-testid="epoch-tool">
      <div className="epoch-now">
        <span className="epoch-row__label">Now — seconds</span>
        <span className="epoch-row__line">
          <button
            type="button"
            className="epoch-now__value"
            aria-label={`Use the current epoch ${nowSeconds}`}
            title="Put this value in the box"
            onClick={() => setRaw(nowSeconds)}
          >
            {nowSeconds}
          </button>
          <CopyButton label="Copy the current epoch" value={nowSeconds} />
        </span>
      </div>

      <div className="epoch-input-row">
        <input
          type="text"
          className="epoch-input"
          aria-label="Epoch or date to convert"
          placeholder="1700000000 or 2024/01/25"
          spellCheck={false}
          autoComplete="off"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        {raw !== "" && (
          <button
            type="button"
            className="epoch-clear"
            aria-label="Clear the input"
            title="Clear"
            onClick={() => setRaw("")}
          >
            ×
          </button>
        )}
      </div>

      {result.kind === "empty" && <p className="epoch-hint">{HINT}</p>}
      {result.kind === "unknown" && (
        <p className="epoch-unknown" role="alert" data-testid="epoch-unknown">
          {result.message}
        </p>
      )}
      {result.kind === "epoch" && <EpochView epoch={result} now={now} timeZone={timeZone} />}
      {result.kind === "date" && <DateView parse={result} now={now} timeZone={timeZone} />}
    </section>
  );
}
