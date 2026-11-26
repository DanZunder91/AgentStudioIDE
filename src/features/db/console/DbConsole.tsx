/** Presentational body of a db-console tab. The split is INTERNAL (ConsoleSplit): not the pane tree
 * (results aren't a tab; canonicalize stays free) nor allotment (never lays out in jsdom). A failed
 * statement is a message result in the list; the error prop means the call itself failed. */

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

/** Feature-local glyphs: adding to src/components/icons.tsx is a write race. */
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
  /** text is what to run, decided by the editor (it knows the caret); omitted means the whole
   * buffer, as Script sends. */
  onRun: (mode: DbRunMode, text?: string) => void;
  onCancel: () => void;
  running: boolean;
  /** One entry per statement, in execution order. */
  results: DbResultSet[];
  /** The call failed (a failed statement is a message result). The store picks the prose
   * (describeDbFailure); this only prints it. */
  error: DbFailure | null;
  readOnly: boolean;
  /** `EngineSpec.serverEnforcedReadOnly` — changes what the badge may promise. */
  serverEnforcedReadOnly: boolean;
  rowLimit: number;
  /** Default false: whole-buffer runs are opt-in per connection, so Script never runs a draft. */
  allowMultiStatement?: boolean;
  /** Session-only; reported via onSplitFractionChange so the store keeps it across tab switches. */
  splitFraction?: number;
  onSplitFractionChange?: (fraction: number) => void;
  /** Grids key findBars as grid:<findScope>:<resultIndex>, so bars survive unmounts and never
   * collide. DbConsoleTab passes the connection id. */
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
  /** Non-null by construction: <QueryEditor/> always renders, so the ref is set before handlers. */
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

  // For focus outside the editor; its keymap preventDefaults first, so one ⌘⏎ runs once.
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
          // A cancel is requested, never guaranteed: pg_cancel_backend is advisory,
          // and three engines have no server-side cancel.
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
          {/* The grammar follows the buffer: SQL in a MongoDB console is coloured as SQL. */}
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

/** message is styled as a notice, not an error: DbResultSet carries no severity, and telling them
 * apart by the words would be value-sniffing. */
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
