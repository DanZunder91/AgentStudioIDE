/** Review screen for an untrusted, unsigned bundle: its claims as reported speech (never
 * "verified"), the hosts, the `{{VAR}}`s it reads (marked where held here: the exfiltration risk),
 * per-item actions. Presentational; locked state comes from `plan.unsealed`, never error text. */

import { useEffect, useState } from "react";

import { tabWrapTarget } from "../db/engineFields";
import {
  ACTION_CHOICES,
  IMPORT_READ_ONLY_HINT,
  IMPORT_READ_ONLY_LABEL,
  HOSTS_INTRO,
  HOSTS_NONE,
  OVERWRITE_HINT,
  OVERWRITE_LABEL,
  PICK_FILE_NOTE,
  SEALED_LOCKED_NOTE,
  UNVERIFIED_NOTE,
  actionLabel,
  describeCounts,
  describeResult,
  describeSecretValues,
  effectiveAction,
  groupPlanItems,
  itemDomId,
  needsPassphrase,
  overrideActions,
  provenanceSentence,
  variableSummary,
} from "./portabilityFormat";
import type { ImportAction, ImportChoices, ImportPlan, ImportResult } from "./types";
import "./portability.css";

/* ────────────────────────────── props ────────────────────────────────────── */

export interface ImportDialogProps {
  path: string | null;
  plan: ImportPlan | null;
  busy: boolean;
  error: string | null;
  result: ImportResult | null;
  onPickFile: () => void;
  onInspect: (passphrase: string) => void;
  onImport: (choices: ImportChoices) => void;
  onClose: () => void;
}

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]";

const TITLE_ID = "portability-import-title";
/** Whichever control is the point of the current step carries this id, so exactly one exists. */
const FOCUS_ID = "portability-import-focus";

type Phase = "pick" | "locked" | "review" | "done";

/* ────────────────────────────── the shell ────────────────────────────────── */

export function ImportDialog(props: ImportDialogProps): React.JSX.Element {
  const { path, plan, busy, error, result, onPickFile, onInspect, onImport, onClose } = props;

  const phase: Phase =
    result !== null ? "done" : plan === null ? "pick" : needsPassphrase(plan) ? "locked" : "review";

  // Own effect with empty deps: capture the opener once at mount, restore it at unmount. In the
  // effect below it would re-capture each step and restore focus to this dialog's own control.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus();
  }, []);

  // Focus follows the step. After picking a sealed file the point of the screen is the
  // passphrase box; after unlocking it is the Import button. Leaving focus on a control
  // that has just been unmounted drops it to `<body>`, out of the Tab trap.
  useEffect(() => {
    document.getElementById(FOCUS_ID)?.focus();
  }, [phase]);

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
        data-testid="portability-import-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 className="pb-dialog__title" id={TITLE_ID}>
          {phase === "done" ? "Import finished" : "Import a config bundle"}
        </h2>

        {path !== null && (
          <p className="pb-dialog__note pb-dialog__path" data-testid="pb-path">
            {path}
          </p>
        )}

        {/* Narrowed on `result` itself rather than on `phase`, so no cast is needed —
            `phase` is derived from it and TypeScript cannot see that. */}
        {result !== null ? (
          <Receipt result={result} />
        ) : plan === null ? (
          <p className="pb-dialog__note" data-testid="pb-pick-note">
            {PICK_FILE_NOTE}
          </p>
        ) : (
          <>
            <Claims plan={plan} />
            {phase === "locked" ? (
              <Unlock busy={busy} onInspect={onInspect} />
            ) : (
              <Review plan={plan} busy={busy} onImport={onImport} />
            )}
          </>
        )}

        {error !== null && (
          <p className="pb-dialog__error" role="alert" data-testid="pb-import-error">
            {error}
          </p>
        )}

        <div className="pb-dialog__actions">
          {phase !== "done" && (
            <button
              type="button"
              className="pb-dialog__btn"
              id={phase === "pick" ? FOCUS_ID : undefined}
              data-testid="pb-pick"
              disabled={busy}
              onClick={onPickFile}
            >
              {plan === null ? "Choose a bundle…" : "Choose a different file…"}
            </button>
          )}
          <span className="pb-dialog__spacer" />
          <button
            type="button"
            className={
              phase === "done" ? "pb-dialog__btn pb-dialog__btn--primary" : "pb-dialog__btn"
            }
            id={phase === "done" ? FOCUS_ID : undefined}
            data-testid="pb-import-close"
            onClick={onClose}
          >
            {phase === "done" ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── what the file CLAIMS ─────────────────────────── */

/** The unverified note sits right under the claims, not in a tooltip: a claim without its
 * caveat reads as fact. */
function Claims({ plan }: { plan: ImportPlan }): React.JSX.Element {
  return (
    <section className="pb-dialog__section" data-testid="pb-claims">
      <h3 className="pb-dialog__subtitle">What this file says it is</h3>
      <p className="pb-dialog__note" data-testid="pb-provenance">
        {provenanceSentence(plan.header)}
      </p>
      <p className="pb-dialog__note" data-testid="pb-header-counts">
        It says it contains {describeCounts(plan.header.counts)}.{" "}
        {describeSecretValues(plan.header.counts)}
      </p>
      <p className="pb-dialog__warning" data-testid="pb-unverified">
        {UNVERIFIED_NOTE}
      </p>
    </section>
  );
}

/* ────────────────────────── the locked state ─────────────────────────────── */

/** The same instance across retries, so a wrong passphrase costs a correction, not a file
 * re-pick (`portability_inspect` writes nothing either way). */
function Unlock({
  busy,
  onInspect,
}: {
  busy: boolean;
  onInspect: (passphrase: string) => void;
}): React.JSX.Element {
  const [passphrase, setPassphrase] = useState("");
  return (
    <section className="pb-dialog__section pb-dialog__section--callout" data-testid="pb-locked">
      <h3 className="pb-dialog__subtitle">Sealed</h3>
      <p className="pb-dialog__note">{SEALED_LOCKED_NOTE}</p>
      <div className="pb-dialog__urlrow">
        <label className="pb-dialog__label-text" htmlFor={FOCUS_ID}>
          Passphrase
        </label>
        <input
          id={FOCUS_ID}
          type="password"
          className="pb-dialog__input"
          autoComplete="off"
          data-testid="pb-import-passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            onInspect(passphrase);
          }}
        />
        <button
          type="button"
          className="pb-dialog__btn"
          disabled={busy || passphrase === ""}
          data-testid="pb-unlock"
          onClick={() => onInspect(passphrase)}
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </div>
    </section>
  );
}

/* ────────────────────────── the review ───────────────────────────────────── */

function Review({
  plan,
  busy,
  onImport,
}: {
  plan: ImportPlan;
  busy: boolean;
  onImport: (choices: ImportChoices) => void;
}): React.JSX.Element {
  const [overrides, setOverrides] = useState<Record<string, ImportAction>>({});
  const [overwrite, setOverwrite] = useState(false);
  // 🔴 Initialised to **true**, matching Rust's serde default. An amendment made this a
  // choice rather than a forced value, and the default is the safe one: turning
  // it back on is one click, while a `DELETE` you did not mean to be able to run is not recoverable.
  const [readOnly, setReadOnly] = useState(true);
  const groups = groupPlanItems(plan.items);
  const vars = variableSummary(plan);

  return (
    <>
      {/* ── where it would connect ──────────────────────────────────────── */}
      <section className="pb-dialog__section" data-testid="pb-hosts">
        <h3 className="pb-dialog__subtitle">Hosts it would contact</h3>
        <p className="pb-dialog__note">{plan.hosts.length === 0 ? HOSTS_NONE : HOSTS_INTRO}</p>
        {plan.hosts.length > 0 && (
          <ul className="pb-dialog__list pb-dialog__list--vars" data-testid="pb-hosts-list">
            {plan.hosts.map((host) => (
              <li key={host}>
                <code>{host}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── which secrets it would read ─────────────────────────────────── */}
      <section className="pb-dialog__section" data-testid="pb-variables">
        <h3 className="pb-dialog__subtitle">Variables it would read</h3>
        <p className="pb-dialog__note" data-testid="pb-variables-summary">
          {vars.message}
        </p>
        {plan.variables.length > 0 && (
          <ul className="pb-dialog__list pb-dialog__list--vars" data-testid="pb-variables-list">
            {plan.variables.map((v) => (
              <li key={v.name} data-have={v.haveLocally ? "yes" : "no"}>
                <code>{v.name}</code>
                <span className="pb-dialog__hint">
                  {v.haveLocally
                    ? "you already have a value for this"
                    : "you have no value for this yet"}
                  {v.bundleHasValue
                    ? " · the bundle carries a value"
                    : " · the bundle carries no value"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── per item: what would happen, and why ────────────────────────── */}
      <section className="pb-dialog__section" data-testid="pb-items">
        <h3 className="pb-dialog__subtitle">What would change</h3>
        {groups.length === 0 ? (
          <p className="pb-dialog__note" data-testid="pb-items-empty">
            This bundle contains nothing this app can import.
          </p>
        ) : (
          groups.map((group) => (
            <div className="pb-dialog__group" key={group.kind}>
              <p className="pb-dialog__group-head">{group.label}</p>
              <ul className="pb-dialog__list">
                {group.items.map((item) => {
                  const id = itemDomId(item);
                  return (
                    <li className="pb-dialog__item" key={id}>
                      <label className="pb-dialog__label-text" htmlFor={id}>
                        {item.label}
                      </label>
                      <select
                        id={id}
                        className="pb-dialog__input"
                        data-testid={id}
                        value={effectiveAction(item, overrides)}
                        onChange={(e) =>
                          setOverrides({ ...overrides, [item.id]: e.target.value as ImportAction })
                        }
                      >
                        {ACTION_CHOICES.map((a) => (
                          <option key={a} value={a}>
                            {actionLabel(a)}
                          </option>
                        ))}
                      </select>
                      <span className="pb-dialog__hint">{item.reason}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
        <label className="pb-dialog__label" htmlFor="pb-read-only">
          <input
            id="pb-read-only"
            type="checkbox"
            checked={readOnly}
            aria-describedby="pb-read-only-hint"
            data-testid="pb-read-only"
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          <span className="pb-dialog__label-text">{IMPORT_READ_ONLY_LABEL}</span>
        </label>
        <span className="pb-dialog__hint" id="pb-read-only-hint">
          {IMPORT_READ_ONLY_HINT}
        </span>
      </section>

      {/* ── the one destructive switch, off by default ───────────────────── */}
      <section className="pb-dialog__section pb-dialog__section--callout">
        <label className="pb-dialog__check" htmlFor="pb-overwrite">
          <input
            id="pb-overwrite"
            type="checkbox"
            checked={overwrite}
            aria-describedby="pb-overwrite-hint"
            data-testid="pb-overwrite"
            onChange={(e) => setOverwrite(e.target.checked)}
          />
          <span className="pb-dialog__label-text">{OVERWRITE_LABEL}</span>
        </label>
        <span className="pb-dialog__hint" id="pb-overwrite-hint">
          {OVERWRITE_HINT}
        </span>
      </section>

      {plan.notices.length > 0 && (
        <section className="pb-dialog__section" data-testid="pb-plan-notices">
          <h3 className="pb-dialog__subtitle">Notes from reading the file</h3>
          <ul className="pb-dialog__list">
            {plan.notices.map((n) => (
              <li key={n} className="pb-dialog__note">
                {n}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="pb-dialog__actions pb-dialog__actions--bare">
        <span className="pb-dialog__spacer" />
        <button
          type="button"
          className="pb-dialog__btn pb-dialog__btn--primary"
          id={FOCUS_ID}
          disabled={busy}
          data-testid="pb-import"
          onClick={() =>
            onImport({
              actions: overrideActions(plan.items, overrides),
              overwriteExistingSecrets: overwrite,
              forceReadOnly: readOnly,
            })
          }
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
    </>
  );
}

/* ────────────────────────── the receipt ──────────────────────────────────── */

function Receipt({ result }: { result: ImportResult }): React.JSX.Element {
  return (
    <section className="pb-dialog__section" data-testid="pb-import-receipt">
      <p className="pb-dialog__note">{describeResult(result)}</p>
      {result.notices.length > 0 && (
        <ul className="pb-dialog__list" data-testid="pb-result-notices">
          {result.notices.map((n) => (
            <li key={n} className="pb-dialog__note">
              {n}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
