/**
 * EpochTool — the Tools rail's epoch ⇄ human-readable date converter.
 *
 * The requirement: type an epoch and get it converted to a human-readable time, in
 * UTC, with an explanation; the tool should also identify what was typed and convert the
 * other way, from any date to an epoch, all from one string input. Every part of that
 * request is a design constraint, and each one is answered here rather than in a
 * settings panel:
 *
 * * **One string input** → ONE text box and no direction toggle. `parseToolInput`
 *   classifies (`empty` / `epoch` / `date` / `unknown`) and this component renders per
 *   class. A toggle would be a second place to be wrong, and it would be wrong exactly
 *   when the user is least likely to notice: at the moment they paste something.
 * * **Identifying the input** → the classification is *shown*, never merely acted on. A guess
 *   the user cannot see is a guess they cannot correct, so the unit, the format name and
 *   the reason are all on screen.
 * * **The explanation** → `chosen.because` and `assumption` are printed **verbatim**. They are
 *   already full sentences written for a human (see `instant.ts` / `dateParse.ts`); a
 *   paraphrase here would be a second copy of the rule, free to drift from the one that
 *   actually decided the answer.
 * * **UTC** → the UTC line leads every instant block, in both directions.
 *
 * ── What this component does NOT do ──────────────────────────────────────────
 * **No conversion maths.** Not one arithmetic operator on a timestamp lives in this
 * file: `parseToolInput`, `viewInstant`, `civilInZone` and `epochIn` own all of it, and
 * they are `BigInt`-exact and separately tested. The one number this tool exists to read
 * correctly (`1700000000123456789`) is precisely the one a `number` corrupts, so a
 * "convenient" `Date` call here would be a bug the tests below could not see.
 *
 * **No debounce, no memo.** The engine is a regex plus a handful of `BigInt` divisions on
 * a string a human is typing by hand; scheduling that would add a stale-state failure
 * mode to buy nothing measurable.
 *
 * ── Why `clock` and `timeZone` are props with defaults ───────────────────────
 * Reading `Date.now()` and the host zone inline would make every assertion below depend
 * on when and where the suite runs — the "2 hours ago" line and the whole
 * local-time block are functions of both. They are injected instead, defaulted to the
 * real host so the panel passes neither, and every test pins both. `Europe/Paris` is the
 * zone the tests use most, chosen because its offset is non-zero *and* DST-dependent, so
 * a hard-coded `+00:00` cannot pass.
 *
 * ── The "also reads as" block, and why it is not collapsible ─────────────────
 * A bare number carries no unit, and the single most common epoch mistake is reading
 * milliseconds as seconds (or a Go nanosecond stamp as anything at all) — a wrong answer
 * that looks completely plausible, decades off. So the other three readings are always
 * rendered, unfolded: the whole value is that the correct one is *one glance away*, and
 * anything behind a disclosure triangle is not.
 *
 * A reading whose `instant` is `null` renders as "out of range" and is a NORMAL state,
 * not an error — three of the four readings of a 19-digit nanosecond stamp are outside
 * what a calendar can represent, and saying so is more useful than hiding the row.
 */

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

/**
 * The host's IANA zone, or `UTC` when the platform will not name one.
 *
 * Exported so the fallback is *falsifiable* (an unfalsifiable guard is
 * dead code, not safety): the test stubs `resolvedOptions` and asserts `UTC`. ECMA-402
 * says the field is always a string, but this value is read once at module-adjacent
 * default-prop time and a `undefined` here would silently poison every local line.
 */
export function hostTimeZone(): string {
  const zone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === undefined || zone === "" ? "UTC" : zone;
}

/** The shapes the empty state names — real inputs, not a grammar. */
const HINT =
  "Type an epoch (1700000000), an ISO timestamp (2023-11-14T22:13:20Z), a plain date (2024/01/25 or 25 Jan 2024), or “now”. Which way to convert is decided from what you type, and what was decided is shown.";

/** What an unrepresentable reading says instead of a date. */
const OUT_OF_RANGE = "Out of the range a calendar can represent.";

/**
 * A copy button.
 *
 * The house pattern exactly (`LogsPanel.tsx`): bail if the platform has no clipboard,
 * and swallow a rejection. A denied clipboard permission is a thing that happens, and a
 * converter that throws out of a click because of it is worse than one that quietly does
 * nothing. Every instance gets a distinct `aria-label` — a rail full of buttons all
 * called "Copy" is a screen reader reading out nothing.
 */
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

/**
 * One label-above-value row, with a copy button.
 *
 * Label ABOVE rather than beside: the rail is 180px at its minimum and `overflow-x` is
 * hidden, so a two-column row turns a long ISO string into a silently clipped one. See
 * `tools.css` — this stack is the fix, not a stylistic preference.
 */
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

/**
 * The four lines every instant gets, in ONE order for both directions.
 *
 * UTC leads because the requirement names it. The order does not vary between the
 * epoch→date and date→epoch cases on purpose: the same instant rendered two ways in two
 * layouts reads as two different answers.
 */
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

/**
 * A bare number was typed: lead with which unit won and why, then the instant, then the
 * three readings that did not win.
 *
 * The alternatives show UTC and ISO only. The full four-line block times three would be
 * twelve rows of near-identical text in a 180px rail — the alternatives exist to be
 * *scanned* for a plausible year, and a wrong-unit reading is always wrong by decades,
 * never by an hour of zone offset.
 */
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

/**
 * One reading of a date string: the format that matched, whatever had to be assumed, the
 * four epochs, the instant, and — when the string carried no offset — the alternative
 * epoch for the same wall clock read in the user's own zone.
 *
 * That alternative is the answer to the question a date converter is actually asked.
 * Someone typing `2024/01/25` usually means *their* 25 January, and the engine has to
 * assume UTC to produce anything at all; showing only the UTC answer would be correct and
 * unhelpful. It is skipped when `civil` is `null` (the string said its own offset, so
 * there is nothing left to re-interpret) and when `civilInZone` cannot resolve the zone.
 */
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

/**
 * A date string was typed. When it is genuinely ambiguous (`05/06/2010`) BOTH readings
 * render with equal weight, under the engine's own one-sentence explanation of what is
 * ambiguous — a contract that can hold two states and data that names
 * neither must say so in the output. Burying the second reading behind "advanced" would
 * be picking one silently, which is wrong half the time by construction.
 */
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
