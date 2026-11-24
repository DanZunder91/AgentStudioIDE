/**
 * ImportDialog — the review screen for a config bundle somebody sent you.
 *
 * ── This is the security surface, and it is a REVIEW, not a confirm button ───
 * An imported bundle is untrusted input. Nothing signs it, so the file's own
 * claims about where it came from are exactly that — claims — and the dialog says so in
 * those words. Before anything is written, four things are on screen:
 *
 *   1. **What the file says it is**, phrased as reported speech. Never "verified".
 *   2. **Which hosts** anything in it would contact.
 *   3. **Which `{{VAR}}`s it will read**, marked where this machine already holds a value.
 *      That pairing is the exfiltration risk made visible: an imported request can read a
 *      secret the recipient already has and point at any host in the list above it.
 *      Intent is not decidable here, so the honest mitigation is visibility, stated once
 *      and without alarm — a dialog that shouts gets clicked through.
 *   4. **Per item: create / update / skip, with the reason**, every one overridable.
 *
 * ── Presentational on purpose ────────────────────────────────────────────────
 * No store, no `invoke`, no `@tauri-apps/plugin-dialog`. The file picker is the caller's
 * `onPickFile`, and the bundle's bytes never come near this component — they stay in
 * Rust, so all that arrives is a header, a plan, or a result.
 *
 * ── Props API ────────────────────────────────────────────────────────────────
 * | Prop        | Meaning |
 * |---|---|
 * | `path`      | The file the user picked, for display. `null` before they pick one. |
 * | `plan`      | `portability_inspect`'s dry run, or `null` before the first inspect. `plan.unsealed === false` is what puts this dialog in its passphrase state. |
 * | `busy`      | An inspect or import is in flight. The caller owns it, so nothing here can disagree with it. |
 * | `error`     | Already a sentence (`portabilityErrors.ts` owns code→English). Rendered next to whatever the user was doing — a wrong passphrase must be retryable **in place**. |
 * | `result`    | `portability_import`'s outcome, or `null`. Non-null switches to the receipt. |
 * | `onPickFile`| Open the native picker. The caller inspects the file and hands back `path` + `plan`. |
 * | `onInspect` | `(passphrase: string) => void` — re-inspect the same file with a passphrase. Called only from the locked state. |
 * | `onImport`  | `(choices: ImportChoices) => void`. |
 * | `onClose`   | Esc, Cancel, and the receipt's Done. |
 *
 * `path`, `busy`, `error` and `result` are caller-owned on purpose: without them the dialog would have to own its own pending/failure state, which is how two
 * disagreeing truths about "is an import running" get created.
 *
 * ── Retrying a wrong passphrase ─────────────────────────────────────────────
 * The locked state is derived from `plan.unsealed`, never from the error text. So a failed
 * unlock leaves the field, its contents and the file exactly where they were and shows the
 * sentence beside them; there is no path through this component that makes a user re-pick
 * the file to try a second passphrase.
 */

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

  // Focus restoration is its own effect with an EMPTY dep list: it has to capture the
  // opener once, at mount, and hand focus back at unmount. Folding it into the effect
  // below would re-capture on every step and restore focus to a control this dialog
  // itself had focused, i.e. to nothing.
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

/**
 * The provenance block. Every sentence here is about what the file *says*, and the
 * unverified note sits directly underneath rather than in a tooltip — a claim presented
 * without its caveat is indistinguishable from a fact.
 */
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

/**
 * A sealed bundle, before the passphrase. The file is not re-picked to retry: this is the
 * same component instance, with its own `passphrase` state, so a wrong attempt costs one
 * keystroke's worth of correction (`portability_inspect` writes nothing either way).
 */
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
