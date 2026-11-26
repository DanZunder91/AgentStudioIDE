/** Presentational: no store and no invoke (so no CA-file picker here); DbPanel wires the props.
 * No per-engine if: rows come from engineFields.ts. The password never enters the draft; a pasted
 * URL goes straight to onParseUrl. The password shows by default only as it is never prefilled. */

import { useEffect, useRef, useState } from "react";

import {
  MAX_ROW_LIMIT,
  READ_ONLY_OFF_WARNING,
  SAVE_PASSWORD_CHOICES,
  TEST_TIMEOUT_MS,
  URL_COPIED_NOTICE,
  URL_LITERAL_PASSWORD_NOTICE,
  advancedIsDirty,
  applyParsedUrl,
  canonicalScheme,
  connectMode,
  connectModeChoices,
  connectModeNote,
  describeEngineSwitch,
  describeTestResult,
  engineFieldRows,
  errorMessage,
  errorSummary,
  fieldDomId,
  firstErrorDomId,
  hasBlockingErrors,
  hasConnectionString,
  initialEngine,
  initialNotices,
  isExisting,
  newDraft,
  raceTestTimeout,
  readOnlyNote,
  redactSecret,
  removeOption,
  savePasswordHint,
  setConnectMode,
  setRowValue,
  setUrlText,
  switchEngine,
  tabWrapTarget,
  toRecord,
  unmodelledOptionKeys,
  urlHasLiteralPassword,
  urlHint,
  validateDraft,
  type DbConnectMode,
  type DbDraft,
  type FieldRow,
} from "./engineFields";
import type {
  DbConnection,
  DbConnectionDraft,
  DbTestResult,
  EngineSpec,
  ParsedUrl,
  SavePassword,
} from "./types";
import "./db.css";

/* ────────────────────────────── local glyphs ─────────────────────────────── */

/** Feature-local glyph; src/components/icons.tsx holds shared chrome. */
function LockIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="10" height="6.5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** The disclosure caret. Turns rather than swapping glyph — the `.db-tree__caret` idiom. */
function CaretIcon(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** Exported for its own test: the missing-element arm is real (the error may be gone when the
 * effect runs) and a component test cannot reach it. */
export function focusById(id: string): void {
  const el = document.getElementById(id);
  if (el !== null) el.focus();
}

/* ────────────────────────────── props ────────────────────────────────────── */

export interface ConnectionDialogProps {
  /** The engine registry, as `db_engines()` returns it. Rendered, never interpreted. */
  engines: EngineSpec[];
  /** The connection being edited, or `null` for a new one. */
  initial: Partial<DbConnection> | null;
  /** The password is a SEPARATE argument; the draft has no field for it, nor id/timestamps
   * (Rust mints those). */
  onTest: (draft: DbConnectionDraft, password: string) => Promise<DbTestResult>;
  /** Persist the draft. Same rule: the password is out of band —
   * the connection file holds no secret. */
  onSave: (draft: DbConnectionDraft, password: string) => Promise<void>;
  /** Render the draft as its engine's connection string. Has no password parameter. */
  onBuildUrl: (draft: DbConnectionDraft) => Promise<string>;
  /** Parse a pasted connection string. Rejects on malformed input, leaving the form alone. */
  onParseUrl: (text: string) => Promise<ParsedUrl>;
  onCancel: () => void;
  /** Ceiling on the Test Connection pending state. Injectable so tests need no real clock. */
  testTimeoutMs?: number;
}

/** Focusable descendants of the dialog, in DOM order, minus the disabled ones. */
const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]";

const TITLE_ID = "db-connection-dialog-title";

/* ────────────────────────────── the shell ────────────────────────────────── */

/** Overlay, role=dialog, Esc, Tab trap, focus restore. No form state, so the form can remount. */
export function ConnectionDialog(props: ConnectionDialogProps): React.JSX.Element {
  const { engines, initial, onCancel } = props;
  const spec = initialEngine(engines, initial);

  // Focus capture lives in the SHELL: effects run child-first, so the form's own effect would
  // capture its just-focused field and restore focus to a removed input.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Focus INTO the modal so the Tab trap gets keys; the no-engines dialog falls through to Close.
    document.getElementById(fieldDomId("name"))?.focus();
    return () => opener?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const target = tabWrapTarget(nodes, document.activeElement, e.shiftKey);
    if (target !== null) {
      e.preventDefault();
      target.focus();
    }
  };

  return (
    <div className="db-dialog-overlay">
      <div
        className="db-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        data-testid="db-connection-dialog"
        onKeyDown={onKeyDown}
      >
        {spec === null ? (
          <>
            <h2 className="db-dialog__title" id={TITLE_ID}>
              No database engines
            </h2>
            <p className="db-dialog__note">
              This build offers no database drivers, so there is nothing to configure.
            </p>
            <div className="db-dialog__actions">
              <button type="button" className="db-dialog__btn" onClick={onCancel}>
                Close
              </button>
            </div>
          </>
        ) : (
          <ConnectionForm {...props} firstSpec={spec} />
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────── the form ─────────────────────────────────── */

type TestPhase =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "done"; result: DbTestResult };

interface FormProps extends ConnectionDialogProps {
  firstSpec: EngineSpec;
}

function ConnectionForm({
  engines,
  initial,
  onTest,
  onSave,
  onBuildUrl,
  onParseUrl,
  onCancel,
  testTimeoutMs = TEST_TIMEOUT_MS,
  firstSpec,
}: FormProps): React.JSX.Element {
  const [spec, setSpec] = useState<EngineSpec>(firstSpec);
  const [draft, setDraft] = useState<DbDraft>(() => newDraft(firstSpec, initial));
  /** The typed password. Local state, never merged into `draft`. */
  const [password, setPassword] = useState("");
  /** Readable by default (see the header). Rendering only: it feeds the type attribute and a label,
   * so onSave/onTest receive identical payloads. Resets on reopen: the dialog unmounts on close. */
  const [showPassword, setShowPassword] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [notices, setNotices] = useState<string[]>(() => initialNotices(firstSpec, initial));
  const [built, setBuilt] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [test, setTest] = useState<TestPhase>({ phase: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Open when a saved connection uses an advanced field; lazy, decided once, not per keystroke. */
  const [advancedOpen, setAdvancedOpen] = useState(() => advancedIsDirty(firstSpec, draft));
  /** Undo buffer for the URL typed before leaving URL-only; not part of the connection. */
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  /** Focus requests run in an effect (Advanced may have to open first). A counter plus a ref, so a
   * repeat request re-runs and the effect never sets state. */
  const [focusTick, setFocusTick] = useState(0);
  const focusId = useRef("");

  const rows = engineFieldRows(spec, draft);
  const basicRows = rows.filter((r) => r.group === "basic");
  const advancedRows = rows.filter((r) => r.group === "advanced");
  const mode = connectMode(spec, draft);
  const errors = validateDraft(spec, draft);
  const summary = errorSummary(errors);
  const unmodelled = unmodelledOptionKeys(spec, draft);
  /** Focus order for a failed save. `url` sits with the fields; the guardrails come last. */
  const errorOrder = [...rows.map((r) => r.key), "url", "rowLimit", "timeoutMs"];

  /** Any edit invalidates the last test result: it would describe a host since changed. */
  const updateDraft = (next: DbDraft): void => {
    setDraft(next);
    setTest({ phase: "idle" });
  };

  // alive guards ordering: a slow build for an older draft never overwrites a newer preview
  // (nor sets state after unmount).
  useEffect(() => {
    let alive = true;
    onBuildUrl(toRecord(spec, draft)).then(
      (s) => {
        if (alive) {
          setBuilt(s);
          setUrlError(null);
        }
      },
      (e: unknown) => {
        if (alive) {
          setBuilt(null);
          setUrlError(errorMessage(e));
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [spec, draft, onBuildUrl]);

  // Focus the first bad field, after the render that made sure it is on screen.
  useEffect(() => {
    if (focusTick === 0) return;
    focusById(focusId.current);
  }, [focusTick]);

  const changeEngine = (id: string): void => {
    const next = engines.find((e) => e.id === id);
    if (next === undefined) return;
    const result = switchEngine(draft, next);
    setSpec(next);
    updateDraft(result.draft);
    setNotices(describeEngineSwitch(result, next));
    // Never CLOSE a section the user opened; do open it if the new engine's own extras are
    // already off their defaults (they are seeded, so this is about what survived the switch).
    if (advancedIsDirty(next, result.draft)) setAdvancedOpen(true);
  };

  /** URL only is seeded with the user's last URL or the derived one, never left empty. */
  const changeMode = (value: string): void => {
    if (draft.url !== null) setLastUrl(draft.url);
    const next = value as DbConnectMode;
    updateDraft(setConnectMode(draft, next, lastUrl ?? built));
    const note = connectModeNote(spec, next);
    setNotices(note === null ? [] : [note]);
  };

  const importUrl = async (text: string): Promise<void> => {
    setUrlError(null);
    try {
      const parsed = await onParseUrl(text);
      const report = applyParsedUrl(draft, parsed, spec);
      updateDraft(report.draft);
      if (advancedIsDirty(spec, report.draft)) setAdvancedOpen(true);
      // Show the parser's credential-stripped URL now, so the rewrite is VISIBLE at paste
      // time; the preview effect takes over on the next edit.
      setBuilt(report.url);
      setNotices(report.notices);
    } catch (e) {
      // On a malformed string the form is left UNTOUCHED. A half-filled form
      // after a bad paste is worse than a refusal — the user cannot tell which
      // fields are theirs.
      setUrlError(errorMessage(e));
    }
  };

  const runTest = async (): Promise<void> => {
    setTest({ phase: "pending" });
    try {
      const result = await raceTestTimeout(
        onTest(toRecord(spec, draft), password),
        testTimeoutMs,
      );
      setTest({ phase: "done", result });
    } catch (e) {
      setTest({
        phase: "done",
        result: { ok: false, serverVersion: null, latencyMs: null, error: errorMessage(e) },
      });
    }
  };

  const save = async (): Promise<void> => {
    setSubmitted(true);
    setSaveError(null);
    if (hasBlockingErrors(errors)) {
      // Reveal before focusing: a blocking error inside a collapsed section is the dead end
      // this whole disclosure could otherwise create.
      if (advancedRows.some((r) => errors.fields[r.key] !== undefined)) setAdvancedOpen(true);
      focusId.current = firstErrorDomId(errorOrder, errors.fields);
      setFocusTick((n) => n + 1);
      return;
    }
    setSaving(true);
    try {
      // The draft object and the password are SEPARATE arguments. `toConnection` has
      // no access to `password`, so this call cannot carry a secret inside the record.
      await onSave(toRecord(spec, draft), password);
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  /** A stored/typed URL is shown verbatim (it is editable); a derived one is scrubbed by
   * redactSecret, the check behind onBuildUrl's no-password claim. */
  const urlText = draft.url !== null ? draft.url : redactSecret(built ?? "", password);

  const copyUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(urlText);
      setNotices([URL_COPIED_NOTICE]);
    } catch (e) {
      setUrlError(errorMessage(e));
    }
  };

  return (
    <>
      <div className="db-dialog__head">
        <h2 className="db-dialog__title" id={TITLE_ID}>
          {isExisting(initial) ? "Edit connection" : "New connection"}
        </h2>
        <div className="db-dialog__driver">
          <label className="db-dialog__label-text" htmlFor="db-field-engine">
            Driver
          </label>
          <select
            id="db-field-engine"
            className="db-dialog__input"
            value={spec.id}
            onChange={(e) => changeEngine(e.target.value)}
          >
            {engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Connection type, only when there is a choice (DynamoDB has neither a DSN nor SRV). */}
      {connectModeChoices(spec).length > 1 && (
      <div className="db-dialog__row db-dialog__row--mode">
        <label className="db-dialog__label-text" htmlFor="db-field-connectMode">
          Connection type
        </label>
        <select
          id="db-field-connectMode"
          className="db-dialog__input"
          data-testid="db-mode"
          value={mode}
          onChange={(e) => changeMode(e.target.value)}
        >
          {connectModeChoices(spec).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {connectModeNote(spec, mode) !== null && (
          <span className="db-dialog__hint" data-testid="db-mode-note">
            {connectModeNote(spec, mode)}
          </span>
        )}
      </div>
      )}

      {/* ── the engine-driven form ───────────────────────────────────────── */}
      <div className="db-dialog__grid" data-testid="db-fields">
        {basicRows.map((row) => (
          <Field
            key={row.key}
            row={row}
            error={submitted ? errors.fields[row.key] : undefined}
            onChange={(value) => updateDraft(setRowValue(draft, row, value))}
          />
        ))}
      </div>

      {/* ── the password, deliberately outside the generic grid ───────────── */}
      <div className="db-dialog__grid">
        <div className="db-dialog__row">
          <label className="db-dialog__label-text" htmlFor="db-field-password">
            Password
          </label>
          <div className="db-dialog__secretrow">
            <input
              id="db-field-password"
              // The ONLY thing `showPassword` changes. See the state's own note: the value,
              // the draft and both callbacks are identical in either position.
              type={showPassword ? "text" : "password"}
              className="db-dialog__input"
              autoComplete="new-password"
              data-testid="db-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {/* A real button with a state-dependent accessible name, not a div with an
                onClick: this is a toggle, so it is announced as one (`aria-pressed`) and is
                reachable by keyboard through the dialog's own Tab trap. */}
            <button
              type="button"
              className="db-dialog__btn db-dialog__btn--small"
              data-testid="db-password-reveal"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <div className="db-dialog__row">
          <label className="db-dialog__label-text" htmlFor="db-field-savePassword">
            Save:
          </label>
          <select
            id="db-field-savePassword"
            className="db-dialog__input"
            aria-describedby="db-hint-savePassword"
            value={draft.savePassword}
            onChange={(e) => updateDraft({ ...draft, savePassword: e.target.value as SavePassword })}
          >
            {SAVE_PASSWORD_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="db-dialog__hint" id="db-hint-savePassword">
            {savePasswordHint(draft.savePassword)}
          </span>
        </div>
      </div>
      {draft.passwordRef !== "" && (
        <p className="db-dialog__note" data-testid="db-password-ref">
          The saved password is referenced as <code>{draft.passwordRef}</code>. The connection
          record holds that name, never the value.
        </p>
      )}
      {draft.caSummary !== null && (
        <p className="db-dialog__note" data-testid="db-ca-summary">
          CA certificate: {draft.caSummary.count} certificate
          {draft.caSummary.count === 1 ? "" : "s"} ({draft.caSummary.subjects.join(", ")}) ·{" "}
          {draft.caSummary.sha256.slice(0, 12)}
        </p>
      )}

      {/* ── settings this engine does not model, kept rather than dropped ── */}
      {unmodelled.length > 0 && (
        <section className="db-dialog__section" data-testid="db-unmodelled">
          <h3 className="db-dialog__subtitle">Settings passed through unchanged</h3>
          <ul className="db-dialog__list">
            {unmodelled.map((key) => (
              <li key={key}>
                <code>
                  {key}={draft.options[key]}
                </code>
                <button
                  type="button"
                  className="db-dialog__btn db-dialog__btn--small"
                  aria-label={`Remove ${key}`}
                  onClick={() => updateDraft(removeOption(draft, key))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The connection string, one editable box, only for engines that have one. */}
      {hasConnectionString(spec) && (
      <section className="db-dialog__section">
        <h3 className="db-dialog__subtitle">Connection string</h3>
        <div className="db-dialog__urlrow">
          <input
            id={fieldDomId("url")}
            className="db-dialog__input db-dialog__input--mono"
            aria-label="Connection string"
            aria-describedby={
              submitted && errors.fields.url !== undefined ? "db-hint-url db-error-url" : "db-hint-url"
            }
            aria-invalid={submitted && errors.fields.url !== undefined ? true : undefined}
            data-testid="db-url"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${canonicalScheme(spec)}user@host/database`}
            value={urlText}
            // A full connection string goes straight to the parser (preventDefault keeps it
            // out of state and DOM); scheme-less text is a normal edit. A miss costs a notice,
            // never a leak: upsert splits credentials server-side.
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (!text.includes("://")) return;
              e.preventDefault();
              void importUrl(text);
            }}
            onChange={(e) => updateDraft(setUrlText(draft, e.target.value))}
          />
          <button type="button" className="db-dialog__btn" onClick={() => void copyUrl()}>
            Copy
          </button>
          <button
            type="button"
            className="db-dialog__btn"
            title="Read this string into the fields, taking any password out of it."
            disabled={urlText.trim() === ""}
            onClick={() => void importUrl(urlText.trim())}
          >
            Import
          </button>
        </div>
        <span className="db-dialog__hint" id="db-hint-url" data-testid="db-url-hint">
          {urlHint(mode)}
        </span>
        {urlHasLiteralPassword(urlText) && (
          <p className="db-dialog__warning" data-testid="db-url-literal">
            {URL_LITERAL_PASSWORD_NOTICE}
          </p>
        )}
        {submitted && errors.fields.url !== undefined && (
          <span className="db-dialog__error" id="db-error-url">
            {errors.fields.url}
          </span>
        )}
        {urlError !== null && (
          <p className="db-dialog__error" role="alert" data-testid="db-url-error">
            {redactSecret(urlError, password)}
          </p>
        )}
      </section>
      )}

      {/* ── everything the engine offers but a connection does not need ───── */}
      {advancedRows.length > 0 && (
        <section className="db-dialog__section">
          <button
            type="button"
            className="db-dialog__disclose"
            aria-expanded={advancedOpen}
            data-testid="db-advanced-toggle"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <span className={advancedOpen ? "db-dialog__caret is-open" : "db-dialog__caret"}>
              <CaretIcon />
            </span>
            Advanced
          </button>
          {advancedOpen && (
            <div className="db-dialog__grid" data-testid="db-advanced">
              {advancedRows.map((row) => (
                <Field
                  key={row.key}
                  row={row}
                  error={submitted ? errors.fields[row.key] : undefined}
                  onChange={(value) => updateDraft(setRowValue(draft, row, value))}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── guardrails: in the dialog, not in preferences ─────────────────── */}
      <section className="db-dialog__section db-dialog__section--guard">
        <h3 className="db-dialog__subtitle">
          <LockIcon /> Safety
        </h3>
        <label className="db-dialog__check" htmlFor="db-field-readOnly">
          <input
            id="db-field-readOnly"
            type="checkbox"
            checked={draft.readOnly}
            aria-describedby="db-hint-readOnly"
            onChange={(e) => updateDraft({ ...draft, readOnly: e.target.checked })}
          />
          <span className="db-dialog__label-text">Read-only</span>
        </label>
        <span className="db-dialog__hint" id="db-hint-readOnly" data-testid="db-readonly-note">
          {readOnlyNote(spec)}
        </span>
        {!draft.readOnly && (
          <p className="db-dialog__error" role="alert" data-testid="db-readonly-off">
            {READ_ONLY_OFF_WARNING}
          </p>
        )}
        <div className="db-dialog__grid">
          <NumberBox
            id="rowLimit"
            label="Row limit"
            value={draft.rowLimit}
            error={submitted ? errors.fields.rowLimit : undefined}
            hint={`Rows a query may return, up to ${MAX_ROW_LIMIT}.`}
            onChange={(v) => updateDraft({ ...draft, rowLimit: v })}
          />
          <NumberBox
            id="timeoutMs"
            label="Timeout (ms)"
            value={draft.timeoutMs}
            error={submitted ? errors.fields.timeoutMs : undefined}
            hint="How long a statement may run before it is cancelled."
            onChange={(v) => updateDraft({ ...draft, timeoutMs: v })}
          />
        </div>
        <label className="db-dialog__check" htmlFor="db-field-allowMultiStatement">
          <input
            id="db-field-allowMultiStatement"
            type="checkbox"
            checked={draft.allowMultiStatement}
            onChange={(e) => updateDraft({ ...draft, allowMultiStatement: e.target.checked })}
          />
          <span className="db-dialog__label-text">Allow multiple statements</span>
        </label>
      </section>

      {/* ── what just happened ───────────────────────────────────────────── */}
      <div className="db-dialog__say" role="status" aria-live="polite" data-testid="db-notices">
        {notices.map((n) => (
          <p key={n} className="db-dialog__note">
            {n}
          </p>
        ))}
        {errors.warnings.map((w) => (
          <p key={w} className="db-dialog__warning" data-testid="db-warning">
            {w}
          </p>
        ))}
      </div>

      {submitted && summary !== null && (
        <p className="db-dialog__error" role="alert" data-testid="db-summary">
          {summary}
        </p>
      )}
      {saveError !== null && (
        <p className="db-dialog__error" role="alert" data-testid="db-save-error">
          {redactSecret(saveError, password)}
        </p>
      )}

      {/* ── actions ──────────────────────────────────────────────────────── */}
      <div className="db-dialog__actions">
        <button
          type="button"
          className="db-dialog__btn"
          disabled={test.phase === "pending"}
          data-testid="db-test"
          onClick={() => void runTest()}
        >
          Test Connection
        </button>
        <TestOutcome test={test} password={password} />
        <span className="db-dialog__spacer" />
        <button type="button" className="db-dialog__btn" data-testid="db-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="db-dialog__btn db-dialog__btn--primary"
          disabled={saving}
          data-testid="db-save"
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

/* ──────────────────────────── small pieces ───────────────────────────────── */

/** password never reaches here (engineFieldRows drops it; options persist in plain text). number
 * uses inputMode=numeric, not type=number, which swallows invalid input and hides the error. */
function Field({
  row,
  error,
  onChange,
}: {
  row: FieldRow;
  error: string | undefined;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const id = fieldDomId(row.key);
  const hintId = `db-hint-${row.key}`;
  const errorId = `db-error-${row.key}`;
  const describedBy = [row.hint !== null ? hintId : null, error !== undefined ? errorId : null]
    .filter((x) => x !== null)
    .join(" ");
  const common = {
    id,
    className: "db-dialog__input",
    "aria-describedby": describedBy === "" ? undefined : describedBy,
    "aria-invalid": error !== undefined ? true : undefined,
    // The descriptor's prose, one hover away rather than one paragraph per field.
    title: row.tip ?? undefined,
    disabled: row.disabled,
  } as const;

  // Label as a SIBLING (htmlFor + id): a wrapping <label> folds the hint and error into the
  // accessible name, which also breaks getByLabelText.
  return (
    <div className="db-dialog__row">
      <label className="db-dialog__label-text" htmlFor={id}>
        {row.label}
      </label>
      {row.kind === "select" ? (
        <select {...common} value={row.value} onChange={(e) => onChange(e.target.value)}>
          {(row.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : row.kind === "checkbox" ? (
        <input
          {...common}
          type="checkbox"
          checked={row.value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "")}
        />
      ) : (
        <input
          {...common}
          type="text"
          inputMode={row.kind === "number" ? "numeric" : undefined}
          required={row.required}
          placeholder={row.placeholder ?? undefined}
          value={row.value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {row.hint !== null && (
        <span className="db-dialog__hint" id={hintId}>
          {row.hint}
        </span>
      )}
      {error !== undefined && (
        <span className="db-dialog__error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  );
}

/** A guardrail number box. Same `type="text"` reasoning as `Field`'s `number` kind. */
function NumberBox({
  id,
  label,
  value,
  error,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  hint: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const domId = fieldDomId(id);
  const hintId = `db-hint-${id}`;
  const errorId = `db-error-${id}`;
  return (
    <div className="db-dialog__row">
      <label className="db-dialog__label-text" htmlFor={domId}>
        {label}
      </label>
      <input
        id={domId}
        type="text"
        inputMode="numeric"
        className="db-dialog__input"
        aria-describedby={error !== undefined ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error !== undefined ? true : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="db-dialog__hint" id={hintId}>
        {hint}
      </span>
      {error !== undefined && (
        <span className="db-dialog__error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Success shows version and latency (connected, not just a socket opened). Failure shows Rust's
 * redacted sentence, scrubbed of the typed password again. */
function TestOutcome({
  test,
  password,
}: {
  test: TestPhase;
  password: string;
}): React.JSX.Element | null {
  if (test.phase === "idle") return null;
  if (test.phase === "pending") {
    return (
      <p className="db-dialog__test" role="status" data-testid="db-test-result">
        Testing the connection…
      </p>
    );
  }
  const { ok, text } = describeTestResult(test.result, password);
  return (
    <p
      className="db-dialog__test"
      role="status"
      data-tone={ok ? "ok" : "bad"}
      data-testid="db-test-result"
    >
      <span aria-hidden="true">{ok ? "✔" : "✖"}</span> {text}
    </p>
  );
}
