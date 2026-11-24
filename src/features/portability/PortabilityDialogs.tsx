/**
 * The container that joins the two halves of config bundles (export/import) — the store slice
 * and the two dialogs.
 *
 * Both are written against `types.ts` and neither imports the other, which is what lets them
 * reach 100% coverage each. **This file is the seam**, and a seam is where a blank screen ships:
 * a tested button can meet a tested command across an untested join, or both halves can be
 * finished with nothing that renders them. So this file is deliberately small, and
 * `PortabilityDialogs.test.tsx` drives it end to end with only the IPC edge mocked.
 *
 * ── The passphrase lives HERE, in a ref, and nowhere else ─────────────────────
 *
 * 🔴 `portability_import` needs the passphrase that unsealed the bundle, and `ImportDialogProps`
 * deliberately does not carry one: the dialog forgets it the moment the plan unlocks. The store
 * must not hold it either — the slice has a test asserting the serialised store never contains one.
 *
 * That left the passphrase with nowhere to live, and a sealed bundle therefore could not be
 * imported at all. It lives in a `useRef` for the lifetime of this component: never rendered,
 * never serialised, never in a store snapshot, and cleared when the dialog closes. A ref is not
 * "secure storage" — it is heap like anything else — but it is the narrowest scope that can
 * actually complete the flow, and it disappears with the dialog rather than persisting in state
 * that other code reads.
 */

import { useCallback, useRef } from "react";

import { useAppStore } from "../../app/store";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import type { ExportSource } from "./portabilityFormat";
import type { ExportOptions, ImportChoices } from "./types";

/**
 * Build the export dialog's `source` from what this machine actually holds.
 *
 * `hasValue` is the field the dialog needs and no bundle shape carries: it is what makes the
 * "these values stay on this machine" list truthful. A variable declared but never filled in has
 * nothing to withhold, so an empty string counts as **no** value — otherwise the dialog would
 * promise the recipient a secret that was never there.
 */
export function exportSourceFrom(
  dbConnections: { id: string; name: string; engine: string }[],
  apiCollections: { id: string; name: string; protocol?: string | null }[],
  apiEnvironments: { id: string; name: string; variables: { key: string; value: string }[] }[],
): ExportSource {
  return {
    // `detail` is the dim line the dialog shows beside each row: the engine for a connection, the
    // protocol for a request. `null` rather than a guess when a request predates the protocol
    // field (legacy store files omit it), because "http" would be an assumption about someone
    // else's saved request.
    dbConnections: dbConnections.map((c) => ({ id: c.id, name: c.name, detail: c.engine })),
    apiRequests: apiCollections.map((r) => ({
      id: r.id,
      name: r.name,
      detail: r.protocol ?? null,
    })),
    environments: apiEnvironments.map((e) => ({
      id: e.id,
      name: e.name,
      variables: e.variables.map((v) => ({ key: v.key, hasValue: v.value !== "" })),
    })),
  };
}

export function PortabilityDialogs(): React.JSX.Element | null {
  const which = useAppStore((s) => s.portabilityDialog);
  const actions = useAppStore((s) => s.portabilityActions);

  const dbConnections = useAppStore((s) => s.dbConnections);
  const apiCollections = useAppStore((s) => s.apiCollections);
  const apiEnvironments = useAppStore((s) => s.apiEnvironments);

  const exportState = useAppStore((s) => s.portabilityExport);
  const importState = useAppStore((s) => s.portabilityImport);

  // See the module doc. Not state: a re-render must not depend on it, and no snapshot may contain
  // it. `null` means "the bundle was never sealed", which is also the value `portability_import`
  // wants for a structure bundle.
  const passphrase = useRef<string | null>(null);

  const close = useCallback(() => {
    passphrase.current = null;
    actions.closePortabilityDialog();
  }, [actions]);

  const onInspect = useCallback(
    (typed: string) => {
      // Remembered BEFORE the await: if it unseals, this is the value the import needs, and the
      // dialog will have dropped it by then. A wrong passphrase overwrites it on the next attempt,
      // and a rejection leaves the previous value — harmless, because an import cannot run without
      // a plan and a wrong passphrase produces none.
      passphrase.current = typed;
      void actions.unsealImport(typed);
    },
    [actions],
  );

  const onImport = useCallback(
    (choices: ImportChoices) => {
      // 🔴 The dialog holds the per-item actions and the overwrite flag in its own state, and
      // `applyImport` reads them from the STORE. Without this forwarding the user's choices were
      // silently ignored — every item would take the plan's default and nothing would say so.
      // Found by writing the seam test, not by either half's suite: both were right about their
      // own side.
      //
      // Forwarding rather than changing either signature keeps the dialog presentational (it owns
      // its form state, exactly as `ExportDialog` owns mode and label) while the store stays the
      // single source of truth at the moment the action is taken — and it is the store's copy that
      // survives the dialog being unmounted and reopened.
      for (const [itemId, action] of Object.entries(choices.actions)) {
        actions.setImportAction(itemId, action);
      }
      actions.setOverwriteExistingSecrets(choices.overwriteExistingSecrets);
      // The read-only toggle takes the same road, and for the same reason: the dialog owns its form
      // state, the store owns what is sent. Forgetting this line is exactly how the per-item
      // choices came to be silently ignored before the seam test existed.
      actions.setImportForceReadOnly(choices.forceReadOnly);
      void actions.applyImport(passphrase.current);
    },
    [actions],
  );

  const onExport = useCallback(
    (options: ExportOptions) => {
      void actions.exportBundle(options);
    },
    [actions],
  );

  if (which === null) return null;

  if (which === "export") {
    return (
      <ExportDialog
        source={exportSourceFrom(dbConnections, apiCollections, apiEnvironments)}
        busy={exportState.busy}
        error={exportState.error}
        exported={exportState.done?.header ?? null}
        onExport={onExport}
        onClose={close}
      />
    );
  }

  return (
    <ImportDialog
      path={importState.srcPath}
      plan={importState.plan}
      busy={importState.busy}
      error={importState.error}
      result={importState.result}
      onPickFile={() => void actions.chooseImportFile()}
      onInspect={onInspect}
      onImport={onImport}
      onClose={close}
    />
  );
}
