/** The seam joining the portability store slice and both dialogs (its test drives it end to end).
 * `portability_import` needs the unsealing passphrase, which neither the dialog props nor the store
 * may hold: it lives in a ref here, never rendered or serialised, cleared on close. */

import { useCallback, useRef } from "react";

import { useAppStore } from "../../app/store";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import type { ExportSource } from "./portabilityFormat";
import type { ExportOptions, ImportChoices } from "./types";

/** `hasValue` keeps the "values stay on this machine" list truthful: an empty string counts as no
 * value, so the recipient is never promised a secret that was never there. */
export function exportSourceFrom(
  dbConnections: { id: string; name: string; engine: string }[],
  apiCollections: { id: string; name: string; protocol?: string | null }[],
  apiEnvironments: { id: string; name: string; variables: { key: string; value: string }[] }[],
): ExportSource {
  return {
    // `detail`: engine for a connection, protocol for a request; `null`, not a guessed
    // "http", when a legacy request has no protocol field.
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
      // Kept before the await: the dialog drops it once unsealed. A stale value is
      // harmless: an import needs a plan, and a wrong passphrase produces none.
      passphrase.current = typed;
      void actions.unsealImport(typed);
    },
    [actions],
  );

  const onImport = useCallback(
    (choices: ImportChoices) => {
      // The dialog holds per-item actions and the overwrite flag, but `applyImport` reads the
      // store: without this forwarding the user's choices are silently ignored.
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
