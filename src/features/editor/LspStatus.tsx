/** Editor-header LSP indicator: "indexing…" while retrying -32801, an install hint, or nothing. */

import { useAppStore } from "../../app/store";
import { detectLanguage } from "../../lib/language";
import { LSP_SERVER_NAMES } from "./lsp/languages";

export function LspStatus({ path }: { path: string }): React.JSX.Element | null {
  const languageId = detectLanguage(path);
  const indexing = useAppStore((s) => s.lspIndexing.includes(languageId));
  const hint = useAppStore((s) => s.lspInstallHints[languageId] ?? null);
  const dismissed = useAppStore((s) => s.lspDismissedHints.includes(languageId));
  const dismissHint = useAppStore((s) => s.lspActions.dismissLspHint);

  const server = LSP_SERVER_NAMES[languageId] ?? languageId;

  if (indexing) {
    return (
      <span className="lsp-status lsp-status--indexing">{server}: indexing&hellip;</span>
    );
  }
  if (hint && !dismissed) {
    return (
      <span className="lsp-status lsp-status--hint" role="status">
        {hint}
        <button
          type="button"
          className="lsp-status__dismiss"
          aria-label="Dismiss"
          onClick={() => dismissHint(languageId)}
        >
          ×
        </button>
      </span>
    );
  }
  return null;
}
