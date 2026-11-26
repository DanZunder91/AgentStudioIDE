/** Titlebar toggle for the log overlay (like `<ShortcutsButton/>`); no entry-count badge, which
 * would be noise. */

import { useLogStore } from "./logStore";
import "./logs.css";

export function LogsButton(): React.JSX.Element {
  const visible = useLogStore((s) => s.visible);

  return (
    <button
      type="button"
      className="logs-button"
      aria-label="Logs"
      aria-pressed={visible}
      title="Diagnostics log"
      onClick={() => useLogStore.getState().toggle()}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M4.25 6h7.5M4.25 8.5h7.5M4.25 11h4.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
