/** Twin of <ApiRequestButton/>, beside it in App.tsx. */

import { useAppStore } from "../../app/store";

export function SequenceButton(): React.JSX.Element {
  const openSequenceTab = useAppStore((s) => s.layoutActions.openSequenceTab);
  return (
    <button
      type="button"
      className="api-launch-button"
      aria-label="New request sequence"
      title="New request sequence — run several requests in order"
      onClick={() => openSequenceTab()}
    >
      {/* Two stacked steps with a flow between them — the same mark the tab
          carries, so the launcher and the tab read as one feature. */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="3" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
        <rect x="4" y="16" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M12 8v8m-2.5-2.5L12 16l2.5-2.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
