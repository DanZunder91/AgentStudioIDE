/**
 * DbConsole — the body of a `db-console` tab: a toolbar, the query
 * editor, a draggable divider, and the output.
 *
 * The original sketch, made real: a double-click opens a new tab split in
 * two — the query, and below it either a table with the response or the error output.
 *
 * ── Presentational, deliberately ─────────────────────────────────────────────
 * Every input is a prop and every action is a callback. No store, no `invoke`, no
 * `TabKind` — the store/IPC half is a separate workstream, and this is the same seam
 * that let `ConnectionDialog` be finished before the Rust side existed. It also means
 * every string a user reads is assertable without mocking a single command.
 *
 * ── The split is INTERNAL to the tab, and that is the load-bearing bit ──
 * The editor/output divider is `<ConsoleSplit>` below — the `RailResizer` pointer-drag
 * pattern, ~40 lines, session-local fraction. It is emphatically **not** the app's
 * pane tree, for reasons that outlive convenience:
 *   • Pane-tree leaves own *tab strips*, so splitting the console into two leaves
 *     would make the results grid a **tab** — closable on its own, draggable to
 *     another region. A results grid with no query editor is not a thing.
 *   • It would need the invariant "these two leaves stay adjacent and neither closes
 *     alone", which is precisely the coupling `canonicalize` exists to destroy
 *     (it collapses single-child splits, flattens same-orientation nests, drops empty
 *     leaves). That is the highest-value logic in the frontend and it is
 *     property-tested; trading it for a divider would be a bad track.
 *   • The two splits *compose*: the whole console is one tab, so the existing
 *     machinery already drags it beside a terminal. That is JetBrains' behaviour too —
 *     an internal output divider inside a separately splittable console window.
 *   • And the repo already does it three times (`ApiRequestView`, `WsConsole`,
 *     `GrpcConsole`). A DB console reaching for the pane tree would be the odd one out.
 * `allotment` is not used either: `SplitContainer` writes back into the pane tree
 * through `resizePane`, and raw `Allotment` learns its size from `ResizeObserver`
 * alone — which `src/test/setup.ts` stubs to a no-op, so under jsdom it never lays out
 * and every assertion about it is vacuously green.
 *
 * ── A failed statement is an outcome, not a crash ────────────────────────────
 * `kind: "message"` results (a syntax error, a NOTICE, a `redis-cli`-style scalar)
 * render **in the output list beside the other results**, not as a global error
 * state — because that is what makes a script's third statement failing still show
 * statements 1 and 2. The `error` prop is the other thing entirely: the *call*
 * failed (no session, TLS, timeout, cancel), so there are no results to show.
 */

import { useRef, useState } from "react";

import { modKey } from "../../shortcuts/shortcuts";
import type { DbFailure } from "../dbErrors";
import type { DbResultSet, DbRunMode } from "../types";
import {
  clampSplit,
  messageBody,
  placeholderFor,
  readOnlyBadge,
  resultSummary,
  runHint,
  shikiIdForText,
  SPLIT_STEP,
} from "./consoleFormat";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultsGrid } from "./ResultsGrid";
import "./console.css";

/**
 * A filled triangle (Run) / double triangle (Script) / square (Stop). Defined here
 * rather than in `src/components/icons.tsx`: that file belongs to nobody in
 * particular and a feature adding to it is a write race — the same
 * call `UsageLimits.tsx` made for its refresh glyph.
 */
function RunIcon({ double = false }: { double?: boolean }): React.JSX.Element {
  return (
    <svg width="9" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 1v8l6-4z" fill="currentColor" />
      {double && <path d="M6 1v8l4-4z" fill="currentColor" />}
    </svg>
  );
}

function StopIcon(): React.JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}

export interface DbConsoleProps {
  /** "PostgreSQL" / "MongoDB" — the engine, shown so the tab is unambiguous. */
  engineLabel: string;
  /** Which editor/Run semantics this engine has (`EngineSpec.queryLanguage`). */
  queryLanguage: "sql" | "json" | "commandline";
  text: string;
  onTextChange: (text: string) => void;
  /**
   * Run something. `text` is **what to run** — the selection, the statement under the cursor,
   * or the whole buffer, decided by the editor because it is the only place the caret is known.
   * Omitted means "the whole buffer", which is what Script means and what any caller
   * with no editor to ask must fall back to.
   */
  onRun: (mode: DbRunMode, text?: string) => void;
  onCancel: () => void;
  running: boolean;
  /** One entry per statement, in execution order. */
  results: DbResultSet[];
  /**
   * The *call* failed. A failed statement is a `message` result instead.
   *
   * A {@link DbFailure} — code **and** the sentence to print — not a bare code. This component
   * used to re-describe the code itself, which is how a MongoDB console came to tell the user
   * to check a host and port that were fine: the sentence for `invalid-config` was the only thing
   * a code could produce, and the failure was a bad *statement*. Choosing prose is the store's job
   * (`describeDbFailure`); this file stays presentational and prints what it is given.
   */
  error: DbFailure | null;
  readOnly: boolean;
  /** `EngineSpec.serverEnforcedReadOnly` — changes what the badge may promise. */
  serverEnforcedReadOnly: boolean;
  rowLimit: number;
  /**
   * `DbConnection.allowMultiStatement`. Default **false**, matching the
   * contract: ⌘⏎ runs the statement under the cursor and running the whole buffer is
   * opt-in per connection. Added to the suggested props because the alternative — a
   * Script button that is always live — would silently run a buffer the user was
   * still drafting, the exact accident the flag exists to prevent.
   */
  allowMultiStatement?: boolean;
  /**
   * Initial editor share of the split. Session-only in v1: held locally here
   * and reported through `onSplitFractionChange` so the store can keep it across a
   * tab switch. Persisting it belongs in `layout-prefs.json` with the other durable
   * layout state, not in a third store file.
   */
  splitFraction?: number;
  onSplitFractionChange?: (fraction: number) => void;
  /**
   * Identity for the results grids' find bars: each grid keys its `findBars`
   * record as `grid:<findScope>:<resultIndex>`, so a bar survives the unmount
   * a tab switch/move is, and two connections — or two
   * grids of one script — never share one. `DbConsoleTab` passes the
   * connection id, matching its own `dbConsoles[connectionId]` keying. A
   * plain string on purpose: this component stays presentational.
   */
  findScope?: string;
}

export function DbConsole({
  engineLabel,
  queryLanguage,
  text,
  onTextChange,
  onRun,
  onCancel,
  running,
  results,
  error,
  readOnly,
  serverEnforcedReadOnly,
  rowLimit,
  allowMultiStatement = false,
  splitFraction = 0.5,
  onSplitFractionChange,
  findScope,
}: DbConsoleProps): React.JSX.Element {
  const [fraction, setFraction] = useState(() => clampSplit(splitFraction));
  const splitRef = useRef<HTMLDivElement>(null);
  /**
   * The editor, asked at click/keystroke time what ⌘⏎ would run.
   *
   * Non-null by construction — `<QueryEditor/>` is rendered unconditionally below, so the ref is
   * attached before any handler here can fire — hence the assertion rather than a `?.` whose
   * other arm no gesture can reach (the same call `splitRef` makes above).
   */
  const editorRef = useRef<QueryEditorHandle>(null);
  /** What Run sends: the selection, else the statement/line/document under the cursor. */
  const runText = (): string => (editorRef.current as QueryEditorHandle).runText();

  const applyFraction = (next: number) => {
    const clamped = clampSplit(next);
    setFraction(clamped);
    onSplitFractionChange?.(clamped);
  };

  // ⌘ on macOS, Ctrl elsewhere — the app's one source of truth for that label.
  const mod = modKey();
  const badge = readOnlyBadge(readOnly, serverEnforcedReadOnly);
  const blank = text.trim() === "";
  const canRun = !running && !blank;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const height = (splitRef.current as HTMLDivElement).getBoundingClientRect().height;
    // No layout yet (or no layout engine at all): a drag has no meaning, and
    // dividing by zero would hand `NaN` to flex-grow and collapse a pane.
    if (height <= 0) return;
    const startY = e.clientY;
    const startFraction = fraction;
    // Window-level listeners rather than pointer capture, so the drag keeps tracking
    // when the cursor leaves the 6px strip — and kill text selection globally while
    // it does (`RailResizer`'s pattern, and the bug it was written for).
    document.body.classList.add("is-resizing");
    const onMove = (ev: PointerEvent | MouseEvent) => {
      applyFraction(startFraction + (ev.clientY - startY) / height);
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onDividerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    applyFraction(fraction + (e.key === "ArrowDown" ? SPLIT_STEP : -SPLIT_STEP));
  };

  // ⌘/Ctrl+⏎ for when focus is NOT in the editor (a toolbar button, the divider).
  // The editor's own CM6 keymap has already handled it in that case and called
  // preventDefault, so deferring to `defaultPrevented` is what keeps one keystroke
  // from running one statement twice.
  const onContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.shiftKey) {
      // Script is the whole buffer by definition, so it needs nothing from the editor.
      if (allowMultiStatement && canRun) onRun("script");
      return;
    }
    if (canRun) onRun("statement", runText());
  };

  return (
    <div className="db-console" data-testid="db-console" onKeyDown={onContainerKeyDown}>
      <div className="db-console__toolbar">
        <button
          type="button"
          className="db-console__btn db-console__btn--primary"
          data-testid="db-run"
          disabled={!canRun}
          title={`${mod}⏎ — ${runHint(queryLanguage)}`}
          // The SAME text ⌘⏎ would send. A Run button that ran the whole buffer while its own
          // tooltip promised the statement under the cursor is the bug this fixed.
          onClick={() => onRun("statement", runText())}
        >
          <RunIcon />
          {running ? "Running…" : "Run"}
        </button>
        <button
          type="button"
          className="db-console__btn"
          data-testid="db-run-script"
          disabled={!canRun || !allowMultiStatement}
          title={
            allowMultiStatement
              ? `⇧${mod}⏎ — runs every statement in the buffer, stopping at the first error.`
              : "Multi-statement execution is off for this connection. Turn it on in the connection settings if you mean to run a whole script."
          }
          onClick={() => onRun("script")}
        >
          <RunIcon double />
          Script
        </button>
        <button
          type="button"
          className="db-console__btn"
          data-testid="db-cancel"
          disabled={!running}
          // Precise on purpose: the cancel is ASKED FOR, never guaranteed. PostgreSQL's
          // `pg_cancel_backend` sends SIGINT and the backend stops at its next interruptible
          // point, and three engines have no server-side cancel at all — in which case the
          // console says so rather than the button pretending.
          title="Stop this query. The server is asked to cancel it; some engines cannot, and a cancel is always advisory."
          onClick={onCancel}
        >
          <StopIcon />
          Stop
        </button>
        <span className="db-console__spacer" />
        <span className="db-console__chip" data-testid="db-engine">
          {engineLabel}
        </span>
        <span
          className="db-console__chip"
          data-testid="db-rowlimit"
          title="Rows are capped per query. The backend reads one row past the cap, so a truncated result is a measured fact, not a guess."
        >
          Rows {rowLimit}
        </span>
        <span
          className="db-console__badge"
          data-testid="db-guard-badge"
          data-tone={badge.tone}
          title={badge.title}
        >
          {badge.label}
        </span>
      </div>

      {badge.caveat !== null && (
        <p className="db-console__caveat" data-testid="db-guard-caveat" data-tone={badge.tone}>
          {badge.caveat}
        </p>
      )}

      <div className="db-console__split" ref={splitRef} data-testid="db-console-split">
        <section
          className="db-console__pane db-console__pane--editor"
          aria-label="Query"
          data-testid="db-console-editor-pane"
          style={{ flexGrow: fraction }}
        >
          {/* The grammar follows the BUFFER, not just the engine: SQL typed into a
              MongoDB console is coloured as SQL. `QueryEditor` re-runs Shiki whenever the
              `shikiId` prop or the text changes, so switching grammars mid-buffer needs no
              change there. */}
          <QueryEditor
            ref={editorRef}
            text={text}
            onTextChange={onTextChange}
            shikiId={shikiIdForText(queryLanguage, text)}
            queryLanguage={queryLanguage}
            placeholderText={placeholderFor(queryLanguage)}
            onRun={onRun}
            allowScript={allowMultiStatement}
            ariaLabel={`Query (${engineLabel})`}
          />
        </section>

        <div
          className="db-console__divider"
          data-testid="db-console-divider"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize query and output"
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuemin={15}
          aria-valuemax={85}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onDividerKeyDown}
        />

        <section
          className="db-console__pane db-console__pane--output"
          aria-label="Output"
          data-testid="db-console-output-pane"
          style={{ flexGrow: 1 - fraction }}
        >
          <div className="db-console__outhead">
            <span className="db-console__outtitle">Output</span>
            {running && (
              <span className="db-console__running" data-testid="db-console-running">
                Running…
              </span>
            )}
          </div>

          {error !== null && (
            <p className="db-console__error" data-testid="db-console-error" role="alert">
              {error.message}
            </p>
          )}

          {results.length === 0 && error === null && !running && (
            <p className="db-console__empty" data-testid="db-console-idle">
              Nothing has run yet. {mod}⏎ {runHint(queryLanguage).toLowerCase()}
            </p>
          )}

          <div className="db-console__results">
            {results.map((result, i) => (
              <ResultBlock
                key={i}
                index={i}
                result={result}
                many={results.length > 1}
                findKey={findScope === undefined ? undefined : `grid:${findScope}:${i}`}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * One statement's outcome. `rows` gets the grid; `affected` and `message` get a line
 * of prose — and `message` is styled as a *notice*, not an error, because
 * `DbResultSet` carries no severity: the text of a Postgres syntax error and the text
 * of a Postgres NOTICE arrive in the same `notice` field, and telling them apart by
 * reading the words would be value-sniffing, which the cell model forbids.
 */
function ResultBlock({
  index,
  result,
  many,
  findKey,
}: {
  index: number;
  result: DbResultSet;
  many: boolean;
  /** The grid's `findBars` key (see `DbConsoleProps.findScope`); `undefined` uses the grid's default. */
  findKey?: string;
}): React.JSX.Element {
  return (
    <section className="db-result" data-testid="db-result" data-kind={result.kind}>
      <header className="db-result__head">
        {many && <span className="db-result__index">{index + 1}</span>}
        <code className="db-result__statement" title={result.statement}>
          {result.statement}
        </code>
        <span className="db-result__summary" data-testid="db-result-summary">
          {resultSummary(result)}
        </span>
      </header>
      {result.kind === "rows" && <ResultsGrid result={result} findKey={findKey} />}
      {result.kind === "affected" && (
        <p className="db-result__line" data-testid="db-result-affected">
          {resultSummary(result)}
        </p>
      )}
      {result.kind === "message" && (
        <p className="db-result__message" data-testid="db-result-message">
          {messageBody(result)}
        </p>
      )}
      {/* A server notice that came alongside rows or an affected-count. On a
          `message` result the notice IS the body, so it is not repeated here. */}
      {result.kind !== "message" && result.notice !== null && (
        <p className="db-result__notice" data-testid="db-result-notice">
          {result.notice}
        </p>
      )}
    </section>
  );
}
