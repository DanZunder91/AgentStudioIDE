/**
 * LogsPanel — the diagnostics-log feed overlay.
 *
 * Shown when `useLogStore(s => s.visible)`; the titlebar `<LogsButton/>` toggles
 * it. Entries render newest-first with a formatted time, a level chip, the source
 * and the message (the `detail` is the row's `title`, revealed on hover). Provides
 * a level filter, a text filter, Clear, and Copy (the visible entries as text).
 *
 * Closes on Esc / the ✕ / an outside (backdrop) click. Like the shortcuts overlay,
 * the Esc effect is always mounted (before the null return) so it is installed
 * regardless of visibility. It subscribes only to the LOG store (no Tauri event
 * plumbing), so it is inert in the browser tier — nothing to mock.
 *
 * a11y: plain buttons with aria, NOT a `role="tab"` group (see RailTabs' note — a
 * second tab group would make the E2E single-`role="tab"` lookup ambiguous).
 */

import { useEffect } from "react";

import { CloseIcon } from "../../components/icons";
import {
  filterEntries,
  formatEntry,
  formatTime,
  useLogStore,
  type LevelFilter,
} from "./logStore";
import "./logs.css";

/** Best-effort swallow — a clipboard rejection must never throw out of a click. */
const noop = (): void => {};

const LEVELS: LevelFilter[] = ["all", "info", "event", "warn", "error"];

export function LogsPanel(): React.JSX.Element | null {
  const visible = useLogStore((s) => s.visible);
  const entries = useLogStore((s) => s.entries);
  const levelFilter = useLogStore((s) => s.levelFilter);
  const textFilter = useLogStore((s) => s.textFilter);
  const hide = useLogStore((s) => s.hide);
  const clear = useLogStore((s) => s.clear);
  const setLevelFilter = useLogStore((s) => s.setLevelFilter);
  const setTextFilter = useLogStore((s) => s.setTextFilter);

  // Esc closes. Installed once (the actions are stable store references); it only
  // acts while the overlay is showing, so it never steals Esc from anything else.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && useLogStore.getState().visible) hide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hide]);

  if (!visible) return null;

  // Newest-first for display + copy, so both agree on order.
  const shown = filterEntries(entries, levelFilter, textFilter).slice().reverse();

  const copy = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(shown.map(formatEntry).join("\n")).catch(noop);
  };

  return (
    <div className="logs-backdrop" onClick={hide} data-testid="logs-backdrop">
      <div
        className="logs-panel"
        role="dialog"
        aria-label="Diagnostics log"
        aria-modal="true"
        data-testid="logs-panel"
        // Clicks inside the panel must not fall through to the backdrop's close.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="logs-panel__bar">
          <span className="logs-panel__title">Diagnostics Log</span>
          <span className="logs-panel__spacer" />
          <button
            type="button"
            className="logs-panel__close"
            aria-label="Close logs"
            title="Close (Esc)"
            onClick={hide}
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="logs-toolbar">
          <div className="logs-levels" aria-label="Filter by level">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className={`logs-level-btn${level === levelFilter ? " logs-level-btn--active" : ""}`}
                aria-pressed={level === levelFilter}
                onClick={() => setLevelFilter(level)}
              >
                {level}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="logs-filter"
            placeholder="Filter…"
            aria-label="Filter log text"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
          />
          <button type="button" className="logs-action-btn" onClick={copy}>
            Copy
          </button>
          <button type="button" className="logs-action-btn" onClick={clear}>
            Clear
          </button>
        </div>

        <div className="logs-body" data-testid="logs-body">
          {shown.length === 0 ? (
            <p className="logs-empty">No log entries yet.</p>
          ) : (
            shown.map((e) => (
              <div key={e.id} className="logs-row" title={e.detail ?? e.message}>
                <span className="logs-row__time">{formatTime(e.ts)}</span>
                <span className={`logs-row__level logs-row__level--${e.level}`}>{e.level}</span>
                <span className="logs-row__source">{e.source}</span>
                <span className="logs-row__msg">{e.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
