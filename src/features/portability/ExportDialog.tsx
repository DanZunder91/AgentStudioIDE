/**
 * ExportDialog — "share this config with someone" (config bundles).
 *
 * ── Presentational on purpose ────────────────────────────────────────────────
 * No store subscription, no `invoke`, no `@tauri-apps/plugin-dialog`. Every action is a
 * prop and every piece of data arrives as data, so the dialog is independent of the IPC
 * wrappers and the store slice behind those props. It is the same seam `ConnectionDialog`
 * uses for the database client, and it lets each half be tested on its own.
 *
 * Note what that means for the destination path: this dialog never asks for one. It hands
 * `ExportOptions` to `onExport` and the wiring layer runs the native save picker, because
 * a picker is an IPC call and the bundle's *bytes* stay out of the webview
 * entirely — the only thing that crosses is a path, and the path is not ours to know.
 *
 * ── Props API ────────────────────────────────────────────────────────────────
 * | Prop       | Meaning |
 * |---|---|
 * | `source`   | Everything on this machine that could be included, with per-variable `hasValue`. |
 * | `busy`     | An export is in flight. Owned by the caller so there is ONE source of truth. |
 * | `error`    | Already a sentence. This file does not map error codes — see below. |
 * | `exported` | The `BundleHeader` the command returned, or `null`. Non-null switches to the receipt. |
 * | `onExport` | `(options: ExportOptions) => void`. Fire-and-forget; the caller reports back through `busy`/`error`/`exported`. |
 * | `onClose`  | Esc, Cancel, and the receipt's Done button. |
 *
 * Three of those (`busy`, `error`, `exported`) are caller-owned deliberately: a dialog that
 * owns its own pending state ends up with two truths about whether an export is running,
 * and one of them is always stale.
 *
 * `error` is a **sentence, not a code**. Mapping `PortabilityErrorCode` → English lives in
 * `portabilityErrors.ts`; a second table here would be a duplicate free to drift.
 *
 * ── What this dialog is careful about ────────────────────────────────────────
 * 1. **`structure` is the default**, from `DEFAULT_EXPORT_MODE` rather than a literal, so
 *    the design's most consequential line has exactly one home.
 * 2. **The passphrase copy does not reassure.** The format's own stated limitation is that
 *    the passphrase is the weak link; the sealed block therefore leads with why, not with
 *    a padlock. See `PASSPHRASE_TRUTH`.
 * 3. **Structure mode says what it is LEAVING OUT**, by name. A user who believes they
 *    shared a working config and did not is the most preventable complaint here.
 * 4. **Nothing is confirmed with `alert`/`confirm`.** Errors render in the dialog.
 * 5. **The passphrase is local state and travels only inside `ExportOptions`**, which is
 *    the one object the contract says may carry it — and only in `sealed` mode, where the
 *    contract requires it. `toExportOptions` omits the key otherwise.
 */

import { useEffect, useState } from "react";

import { tabWrapTarget } from "../db/engineFields";
import {
  DEFAULT_EXPORT_MODE,
  KDF_NOTE,
  MODE_CHOICES,
  PASSPHRASE_ADVICE,
  PASSPHRASE_TRUTH,
  REDACTED_HEADER_NOTE,
  WITHHELD_INTRO,
  WITHHELD_NONE,
  describeCounts,
  describeSelection,
  exportBlockedReason,
  initialSelection,
  passphraseState,
  selectionCounts,
  toExportOptions,
  toggleId,
  withheldVariableNames,
  type ExportSelectable,
  type ExportSelection,
  type ExportSource,
} from "./portabilityFormat";
import {
  MIN_PASSPHRASE_LENGTH,
  type BundleHeader,
  type BundleMode,
  type ExportOptions,
} from "./types";
import "./portability.css";

/* ────────────────────────────── props ────────────────────────────────────── */

export interface ExportDialogProps {
  /** Everything that could be included. Rendered, never interpreted. */
  source: ExportSource;
  /** An export is in flight. The caller owns this, so the button and the copy agree. */
  busy: boolean;
  /** A ready-made sentence, or `null`. Code→English mapping is the IPC layer's job. */
  error: string | null;
  /** What the command wrote, or `null` while the form is still being filled in. */
  exported: BundleHeader | null;
  /** Hand the options over. The caller picks the destination path and reports back. */
  onExport: (options: ExportOptions) => void;
  onClose: () => void;
}

/** Focusable descendants, in DOM order, minus the disabled ones. Same set as the DB dialog. */
const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]";

const TITLE_ID = "portability-export-title";
const LABEL_ID = "portability-export-label";

/* ────────────────────────────── the shell ────────────────────────────────── */

/**
 * The modal shell: overlay, labelled `role="dialog"`, Esc, the Tab trap, focus in and
 * focus restored. Identical in behaviour to `ConnectionDialog`'s shell on purpose — two
 * dialogs that trap focus differently in one app is a bug, not a style choice.
 *
 * `tabWrapTarget` is imported from the database feature rather than reimplemented: it is
 * a pure, already-tested function with no database semantics in it.
 */
export function ExportDialog(props: ExportDialogProps): React.JSX.Element {
  const { onClose } = props;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.getElementById(LABEL_ID)?.focus();
    return () => opener?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
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
    <div className="pb-dialog-overlay">
      <div
        className="pb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        data-testid="portability-export-dialog"
        onKeyDown={onKeyDown}
      >
        {props.exported === null ? (
          <ExportForm {...props} />
        ) : (
          <Receipt header={props.exported} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────── the form ─────────────────────────────────── */

function ExportForm({
  source,
  busy,
  error,
  onExport,
  onClose,
}: ExportDialogProps): React.JSX.Element {
  const [mode, setMode] = useState<BundleMode>(DEFAULT_EXPORT_MODE);
  const [label, setLabel] = useState("");
  const [selection, setSelection] = useState<ExportSelection>(() => initialSelection(source));
  /** Local state, never merged into anything but `ExportOptions` (§5 of the header note). */
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");

  const counts = selectionCounts(source, selection);
  const blocked = exportBlockedReason(mode, counts, passphrase, confirm);
  const pass = passphraseState(passphrase, confirm);
  const withheld = withheldVariableNames(source, selection);

  return (
    <>
      <div className="pb-dialog__head">
        <h2 className="pb-dialog__title" id={TITLE_ID}>
          Export a config bundle
        </h2>
      </div>

      <div className="pb-dialog__row">
        <label className="pb-dialog__label-text" htmlFor={LABEL_ID}>
          Name this bundle
        </label>
        <input
          id={LABEL_ID}
          className="pb-dialog__input"
          placeholder="Team staging DB + API"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <span className="pb-dialog__hint">
          Shown to whoever opens the file. Informational only — nothing verifies it.
        </span>
      </div>

      {/* ── the mode choice: the whole security posture of the file ───────── */}
      <fieldset className="pb-dialog__section pb-dialog__modes">
        <legend className="pb-dialog__subtitle">What travels in the file</legend>
        {MODE_CHOICES.map((choice) => (
          <label
            key={choice.value}
            className="pb-dialog__mode"
            htmlFor={`pb-mode-${choice.value}`}
            data-selected={mode === choice.value ? "yes" : "no"}
          >
            <input
              id={`pb-mode-${choice.value}`}
              type="radio"
              name="pb-mode"
              value={choice.value}
              checked={mode === choice.value}
              data-testid={`pb-mode-${choice.value}`}
              aria-describedby={`pb-mode-blurb-${choice.value}`}
              onChange={() => setMode(choice.value)}
            />
            <span className="pb-dialog__mode-text">
              <span className="pb-dialog__mode-title">{choice.title}</span>
              <span className="pb-dialog__hint" id={`pb-mode-blurb-${choice.value}`}>
                {choice.blurb}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* ── what to include ──────────────────────────────────────────────── */}
      <section className="pb-dialog__section">
        <h3 className="pb-dialog__subtitle">Include</h3>
        <IncludeGroup
          title="Database connections"
          items={source.dbConnections}
          selected={selection.dbConnectionIds}
          testId="pb-include-dbConnections"
          onToggle={(id) =>
            setSelection({ ...selection, dbConnectionIds: toggleId(selection.dbConnectionIds, id) })
          }
        />
        <IncludeGroup
          title="API requests"
          items={source.apiRequests}
          selected={selection.apiRequestIds}
          testId="pb-include-apiRequests"
          onToggle={(id) =>
            setSelection({ ...selection, apiRequestIds: toggleId(selection.apiRequestIds, id) })
          }
        />
        <IncludeGroup
          title="Environments"
          items={source.environments.map((e) => ({
            id: e.id,
            name: e.name,
            detail: `${e.variables.length} variable${e.variables.length === 1 ? "" : "s"}`,
          }))}
          selected={selection.environmentIds}
          testId="pb-include-environments"
          onToggle={(id) =>
            setSelection({ ...selection, environmentIds: toggleId(selection.environmentIds, id) })
          }
        />
        <p className="pb-dialog__note" data-testid="pb-summary">
          {describeSelection(counts)}
        </p>
      </section>

      {/* ── the consequence of the mode, spelled out ─────────────────────── */}
      {mode === "structure" ? (
        <section
          className="pb-dialog__section pb-dialog__section--callout"
          data-testid="pb-withheld"
        >
          <h3 className="pb-dialog__subtitle">What stays on this machine</h3>
          {withheld.length === 0 ? (
            <p className="pb-dialog__note">{WITHHELD_NONE}</p>
          ) : (
            <>
              <p className="pb-dialog__note">{WITHHELD_INTRO}</p>
              <ul className="pb-dialog__list pb-dialog__list--vars" data-testid="pb-withheld-list">
                {withheld.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="pb-dialog__note">{REDACTED_HEADER_NOTE}</p>
        </section>
      ) : (
        <section className="pb-dialog__section pb-dialog__section--callout" data-testid="pb-sealed">
          <h3 className="pb-dialog__subtitle">Passphrase</h3>
          {/* The truth FIRST, above the fields. Below them it reads as fine print. */}
          <p className="pb-dialog__warning" data-testid="pb-passphrase-truth">
            {PASSPHRASE_TRUTH}
          </p>
          <p className="pb-dialog__note">{PASSPHRASE_ADVICE}</p>
          <div className="pb-dialog__grid">
            <div className="pb-dialog__row">
              <label className="pb-dialog__label-text" htmlFor="pb-passphrase">
                Passphrase
              </label>
              <input
                id="pb-passphrase"
                type="password"
                className="pb-dialog__input"
                autoComplete="new-password"
                aria-describedby="pb-passphrase-hint"
                data-testid="pb-passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <span className="pb-dialog__hint" id="pb-passphrase-hint">
                At least {MIN_PASSPHRASE_LENGTH} characters. Refused below that, here and in the
                app core.
              </span>
            </div>
            <div className="pb-dialog__row">
              <label className="pb-dialog__label-text" htmlFor="pb-passphrase-confirm">
                Confirm passphrase
              </label>
              <input
                id="pb-passphrase-confirm"
                type="password"
                className="pb-dialog__input"
                autoComplete="new-password"
                data-testid="pb-passphrase-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>
          {pass.message !== null && (
            <p className="pb-dialog__error" data-testid="pb-passphrase-message">
              {pass.message}
            </p>
          )}
          <p className="pb-dialog__note">{KDF_NOTE}</p>
        </section>
      )}

      {error !== null && (
        <p className="pb-dialog__error" role="alert" data-testid="pb-export-error">
          {error}
        </p>
      )}

      <div className="pb-dialog__actions">
        {blocked !== null && (
          <span className="pb-dialog__hint" id="pb-blocked" data-testid="pb-blocked">
            {blocked}
          </span>
        )}
        <span className="pb-dialog__spacer" />
        <button type="button" className="pb-dialog__btn" data-testid="pb-cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="pb-dialog__btn pb-dialog__btn--primary"
          disabled={busy || blocked !== null}
          aria-describedby={blocked === null ? undefined : "pb-blocked"}
          data-testid="pb-export"
          onClick={() => onExport(toExportOptions(mode, label, selection, passphrase))}
        >
          {busy ? "Exporting…" : "Export…"}
        </button>
      </div>
    </>
  );
}

/* ────────────────────────── small pieces ─────────────────────────────────── */

/**
 * One tick-list. The empty case is a sentence rather than an absent block: "you have no
 * saved requests" and "requests are not exportable" look the same when nothing renders.
 */
function IncludeGroup({
  title,
  items,
  selected,
  testId,
  onToggle,
}: {
  title: string;
  items: ExportSelectable[];
  selected: string[];
  testId: string;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const chosen = items.filter((i) => selected.includes(i.id)).length;
  return (
    <div className="pb-dialog__group" data-testid={testId}>
      <p className="pb-dialog__group-head">
        {title}
        <span className="pb-dialog__count" data-testid={`${testId}-count`}>
          {chosen} of {items.length}
        </span>
      </p>
      {items.length === 0 ? (
        <p className="pb-dialog__note">Nothing of this kind on this machine.</p>
      ) : (
        <ul className="pb-dialog__list">
          {items.map((item) => (
            <li key={item.id}>
              <label className="pb-dialog__check" htmlFor={`pb-include-${item.id}`}>
                <input
                  id={`pb-include-${item.id}`}
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={() => onToggle(item.id)}
                />
                <span className="pb-dialog__label-text">{item.name}</span>
              </label>
              {item.detail !== null && <span className="pb-dialog__hint">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The receipt. It restates the mode, because "did I send them the sealed one?" is a
 * question people ask thirty seconds later and the file name will not answer it.
 */
function Receipt({
  header,
  onClose,
}: {
  header: BundleHeader;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <>
      <h2 className="pb-dialog__title" id={TITLE_ID}>
        Bundle exported
      </h2>
      <p className="pb-dialog__note" data-testid="pb-receipt">
        {header.mode === "sealed"
          ? `Sealed bundle written, containing ${describeCounts(header.counts)}. Send the ` +
            "passphrase separately — not in the same message as the file."
          : `Structure-only bundle written, containing ${describeCounts(header.counts)}. It ` +
            "holds no secret values, so it is safe to paste anywhere."}
      </p>
      <div className="pb-dialog__actions">
        <span className="pb-dialog__spacer" />
        <button
          type="button"
          className="pb-dialog__btn pb-dialog__btn--primary"
          data-testid="pb-done"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </>
  );
}
