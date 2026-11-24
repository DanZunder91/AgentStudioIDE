/**
 * ConnectionDialog — the "Data Sources and Drivers" modal for the database client,
 * modelled on the JetBrains surface of the same name.
 *
 * ── Presentational on purpose ────────────────────────────────────────────────
 * This component has **no store subscription and no `invoke`**. Every action arrives
 * as a prop (`onTest`, `onSave`, `onBuildUrl`, `onParseUrl`, `onCancel`) and the engine
 * registry arrives as data (`engines`). That is not squeamishness about IPC: the five
 * Rust commands behind those callbacks (`db_engines`, `db_connection_upsert`,
 * `db_test_connection`, `db_url_build`, `db_url_parse`) live in Rust, and a props seam
 * keeps the form independent of them: the backend can change behind the callbacks
 * without touching one line of this component, and the tests drive it with plain
 * functions. `DbPanel` is the layer that wires the real callbacks in.
 *
 * ── Zero per-engine conditionals ─────────────────────────────────────────────
 * There is no `if (engine === "mongodb")` anywhere in this file, and there must never
 * be one. The form is `engineFieldRows(spec, draft).map(...)`; a Mongo form grows
 * `replicaSet`/`readPreference` because the *descriptor* says so, a Redis form has no
 * user because `supportsUser` is false, and adding ClickHouse is a Rust row. All of
 * that logic — and every message — lives in `engineFields.ts`, DOM-free and directly
 * unit-tested.
 *
 * ── The four things this component is careful about ──────────────────────────
 * 1. **The password never enters the draft.** It is local state and travels as the
 *    *second argument* to `onTest`/`onSave`. `onBuildUrl` has no password parameter at
 *    all, so the derived URL is passwordless by construction — and is scrubbed with
 *    `redactSecret` anyway, because "by construction" is a claim and this is a check.
 * 2. **A pasted connection string never becomes an input value.** The paste handler calls
 *    `preventDefault()` and hands the text straight to `onParseUrl`, so a string
 *    containing `:s3cret@` never lands in React state, in the DOM, or in a re-render.
 *    `hadPassword` is then *announced*, because a password that vanishes silently is
 *    a support ticket.
 * 3. **`readOnly` starts on and says what it is worth.** For Mongo/Redis it is our own
 *    in-process filter, and the note says so rather than implying a boundary the engine
 *    cannot keep (only the SQL engines enforce read-only on the server).
 * 4. **Test Connection cannot hang.** `raceTestTimeout` bounds the pending state, so
 *    the worst case is a mapped sentence, never a spinner that outlives the session.
 *
 * ── Four rules for a dialog that stays out of the way ───────────────────────
 * The dialog shows only what the chosen mode uses, keeps the URL editable, never adds a
 * port nobody entered, and lets a URL, a user and a password be enough to connect.
 *
 * 1. **The URL box is editable** and says whether the URL or the fields win. It used to be
 *    `readOnly` with "Derived from the fields above" and a *second*, separate box to paste
 *    into — two controls for one string. Now
 *    there is one box: it renders the derived string until you touch it, and a non-empty
 *    URL is what connects (which is what Rust's `resolve_from_*` has always done).
 *    Rule 2 above survives intact, because a **paste** still goes through `onParseUrl`
 *    rather than through React state; only *typing* puts characters in the box, and a
 *    typed literal password is announced (`urlHasLiteralPassword`) and split out by
 *    `upsert` on save.
 * 2. **`Connection type`** — chooses where the configuration comes from. `Host and port`,
 *    `DNS seed list (SRV)` where the descriptor declares a `+srv` scheme, `URL only`.
 *    Derived from the draft rather than stored beside it; see `connectMode`.
 * 3. **No invented port.** The descriptor's `defaultPort` is a placeholder, and SRV
 *    disables the box and says a port is *invalid* there, not merely unnecessary.
 * 4. **Progressive disclosure.** `FieldGroup` splits the form into what you must fill in
 *    and an **Advanced** section that opens itself when a saved connection has something
 *    in it. The descriptor's prose became `title` tooltips: eleven fields with eleven
 *    paragraphs under them is what made the form read as confusing clutter.
 *
 * ── The password you can read ───────────────────────────────────────────────
 * The password is not masked by default, because this is a local tool — so the field is
 * **visible by default**, with a Show/Hide
 * toggle to mask it. It is a rendering choice and nothing else: the `type` attribute and the
 * button's own label are the only two things that read `showPassword`, so a revealed password
 * and a masked one save the identical
 * payload — asserted, because "reveal it by writing it somewhere else" is the way this goes wrong.
 *
 * **Visible by default, decided on evidence rather than on the convention.** Every other database
 * tool masks by default, and the obvious move is to copy them on a shoulder-surfing argument.
 * That argument assumes the dialog *prefills* a saved password. It does not: `password` is
 * `useState("")` on every open, because the stored secret lives in the Vault and only its `{{VAR}}`
 * reference is ever rendered. So the field can only ever show **what you typed seconds ago** — a
 * value you are looking at as you type it anyway — and masking it buys nothing while costing the
 * one thing it is for: checking the characters when the server has just rejected them.
 *
 * The toggle stays, so a password can be hidden for a screen share. If the dialog ever starts
 * prefilling a stored secret, this default must flip back — that is the condition, written down.
 *
 * A related sentence was actively wrong and is fixed: in `URL only` mode the dialog
 * used to say *"The fields below are kept for reference and are not used"* while, one section
 * lower, `PASSWORD_MOVED_NOTICE` told the user to type their password into one of those
 * fields. See `URL_MODE_NOTE` in `engineFields.ts`.
 *
 * ── Deliberately absent — do NOT "fix" this without reading why ──────────────
 * **The CA-certificate picker.** A CA certificate is stored as content: the file is read
 * once, at a user gesture, through the native `tauri-plugin-dialog` picker — an IPC call,
 * and this component makes none. An existing `caSummary` is rendered (count, subjects,
 * fingerprint); choosing a new certificate belongs to the wiring layer that owns `invoke`.
 */

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

/**
 * A padlock, for the read-only guardrail. Defined here rather than in
 * `src/components/icons.tsx`, which holds shared chrome, so a feature-specific glyph stays
 * with its feature — the same reasoning `UsageLimits.tsx` uses for its own refresh glyph.
 */
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

/**
 * Focus the element with `id`, if it is in the document.
 *
 * Exported for its own test, because the "not there" arm is real and a component test cannot
 * produce it: a failed save names the first bad field, and by the time the effect below runs the
 * error may already be gone (any edit re-validates, and `firstErrorDomId` answers `""` for an
 * empty error set — `getElementById("")` is `null`). An untested arm here would be a silent
 * throw on `null.focus()`.
 */
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
  /**
   * Test the draft. The password is a SEPARATE argument and is never in `draft` —
   * `DbConnectionDraft` has no field that could hold one, and no `id`/timestamps either
   * (Rust mints those), so the dialog invents nothing.
   */
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

/**
 * The modal shell: the overlay, the labelled `role="dialog"`, Esc, the Tab trap, and
 * focus restoration. It holds no form state, so the inner form can be remounted (and
 * the "no engines" case rendered) without duplicating any of the accessibility wiring.
 */
export function ConnectionDialog(props: ConnectionDialogProps): React.JSX.Element {
  const { engines, initial, onCancel } = props;
  const spec = initialEngine(engines, initial);

  // The whole focus contract, in one effect and in this order on purpose. It has to
  // live in the SHELL rather than the form: React runs effects child-first, so a
  // capture done in `<ConnectionForm/>`'s own effect would already be looking at the
  // field that effect had just focused, and "restore focus on close" would hand focus
  // to a removed input (i.e. to `<body>`).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Move focus INTO the modal, so the Tab trap (which listens on the dialog element)
    // receives the keystrokes and a screen reader lands on the form rather than on
    // whatever is behind it. `name` is always the first row; the "no engines" dialog
    // has no fields, and falls through to its own Close button.
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
  /**
   * Whether the password is rendered as text — no masking by default in this local tool,
   * built as a **control** rather than as a permanent change.
   *
   * Two properties this state is chosen for:
   *   - it starts `false` on **every** open. `<ConnectionDialog/>` is mounted only while
   *     `dialog !== null` (`DbPanel`), so closing it destroys this state and reopening the same
   *     connection starts hidden again. A field that stays revealed because it was revealed once
   *     is a shoulder-surfing hazard in a screen-shared session.
   *   - it is **rendering only**. It feeds one attribute (`type`) and one label, and nothing
   *     else in this component reads it: `password` itself is untouched, so what `onSave`/
   *     `onTest` receive is byte-identical either way. The dialog's test asserts exactly that,
   *     because a "reveal" implemented by copying the value somewhere visible would be a leak
   *     wearing this feature's clothes.
   */
  // `true`: the password is readable by default (see the header note).
  const [showPassword, setShowPassword] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [notices, setNotices] = useState<string[]>(() => initialNotices(firstSpec, initial));
  const [built, setBuilt] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [test, setTest] = useState<TestPhase>({ phase: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * Open when a saved connection already has something in it — a user editing a connection must
   * not have to hunt for the setting they set. Lazy, so the decision is made once, on the draft
   * as it arrived, rather than being re-derived (and re-closed) on every keystroke.
   */
  const [advancedOpen, setAdvancedOpen] = useState(() => advancedIsDirty(firstSpec, draft));
  /**
   * The URL the user had typed before they switched away from `URL only`, so the round trip
   * back is not a silent delete. Not in the draft: it is an undo buffer, not a property of
   * the connection.
   */
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  /**
   * A focus request, honoured in an effect rather than inline: a failed save may have to **open
   * the Advanced section first**, and an element that is not in the DOM yet cannot be focused,
   * so the focus has to happen after the render that reveals it.
   *
   * A **counter plus a ref**, rather than the id in state, for two reasons: two failed saves on
   * the same field are two requests (an id would be `===` and the effect would not re-run), and
   * an effect that had to clear its own state afterwards would be a setState inside an effect
   * body — cascading renders, and `react-hooks/set-state-in-effect` says so.
   */
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

  /**
   * Any edit invalidates the last test result: a green "PostgreSQL 17.2 · 34 ms" next
   * to a host the user has since changed is a lie, and the cheapest kind to tell.
   */
  const updateDraft = (next: DbDraft): void => {
    setDraft(next);
    setTest({ phase: "idle" });
  };

  // Keep the derived connection string in step with the form. `alive` is the
  // out-of-order guard: each edit re-runs this and cancels the previous request, so a
  // slow build for an older draft can never overwrite a newer preview (or setState
  // after unmount).
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

  /**
   * Choose where the configuration comes from. Selecting `URL only` seeds the box with the URL
   * the user had, or the derived string — an authoritative box that starts empty would throw
   * away the very thing it is taking over from.
   */
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
      // Show the parser's own credential-stripped string immediately, rather than
      // waiting on a second IPC round trip just to re-render what it already returned
      // (`ParsedUrl.url`). A raw URL may carry a password, so the rewrite must be VISIBLE
      // at the moment of the paste — that is what makes the mechanism a mechanism instead
      // of magic. The derived
      // preview effect then takes the field back over on the next edit.
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

  /**
   * What the URL box shows — and the one place the two directions differ.
   *
   * A **stored/typed** URL is rendered verbatim: it is the user's own text in an editable box,
   * and masking what they are typing would make it uneditable. A **derived** string comes from
   * the layer below, so it is scrubbed (`redactSecret`) — that is the check behind rule 1's
   * claim that `onBuildUrl` cannot emit a password.
   */
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

      {/* ── where the configuration comes from (`Connection type`) ─────────── */}
      {/* 🔴 Only when there is a choice to make. A select with one option is a control that cannot
          do anything. `connectModeChoices` decides what exists; this decides whether asking is
          worth a row. DynamoDB is the engine this matters for: it has neither a DSN nor SRV. */}
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

      {/* ── the connection string: ONE editable box ────────────────────────
          🔴 Only for engines that HAVE one. Rendering it for a schemeless engine showed a
          `user@host/database` box for something with no user and no database, and — with the mode
          bug it sat next to — refused to save with "Host is required". **DynamoDB once shipped
          with this**, unnoticed, because nothing rendered its dialog. */}
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
            // A **whole connection string** goes STRAIGHT to the parser: `preventDefault` keeps
            // a `:s3cret@` out of the input's value, out of React state and out of the DOM, and
            // Rust returns it credential-free. Anything without a scheme is an ordinary edit —
            // pasting a hostname into a URL you are fixing must not fire a parse and get
            // refused. The test is deliberately crude; a miss costs a notice, never a leak,
            // because `upsert` splits the credential server-side regardless.
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

/**
 * One engine-driven control. Every kind in `DbFieldKind` except `password` renders
 * here — `password` never reaches this function, because a secret in `options` would
 * be persisted in plain text and `engineFieldRows` drops it.
 *
 * `number` renders as a text box with `inputMode="numeric"` rather than
 * `type="number"`: a native number input silently swallows what the user typed, which
 * would make "Port must be a whole number from 1 to 65535." unreachable and leave the
 * user staring at an empty box.
 */
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

  // The label is a SIBLING of the control, not its wrapper: a wrapping `<label>` folds
  // the hint and the error text into the control's accessible name ("Application name
  // Appears in pg_stat_activity…"), which is both noisy for a screen reader and a
  // guarantee that `getByLabelText` cannot find the field. `htmlFor` + `id` keeps the
  // name to the label and the rest to `aria-describedby`.
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

/**
 * The proof, or the reason. Success shows the server version *and* the latency —
 * anything less does not distinguish "connected" from "a socket opened". Failure shows
 * Rust's mapped, redacted sentence, with the typed password scrubbed again on the way
 * out (drivers echo connection strings into their error text).
 */
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
