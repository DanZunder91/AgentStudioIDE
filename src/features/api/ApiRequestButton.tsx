/** Titlebar button opening a new API request tab; like `<ShortcutsButton/>`, one store action. */

import { useAppStore } from "../../app/store";

export function ApiRequestButton(): React.JSX.Element {
  const openApiRequestTab = useAppStore((s) => s.layoutActions.openApiRequestTab);
  return (
    <button
      type="button"
      className="api-launch-button"
      aria-label="New API request"
      title="New API request"
      onClick={() => openApiRequestTab()}
    >
      {/* A globe — the API client's mark. Stroked with currentColor like the
          other titlebar icons so it inherits the palette. */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M3 12h18M12 3c2.5 2.4 3.8 5.6 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.6-3.8-9S9.5 5.4 12 3z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
