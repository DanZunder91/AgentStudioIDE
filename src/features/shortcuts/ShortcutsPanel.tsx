/** Installs its own global Cmd/Ctrl+/ toggle and Esc; the list comes from `shortcuts.ts`. Open
 * state is the store's `shortcutsOpen` (shared with the titlebar button); the hotkey effect runs
 * before the closed-state null return, so the hotkey can open it. */

import { useEffect } from "react";

import { CloseIcon } from "../../components/icons";
import { useAppStore } from "../../app/store";
import { modChord, shortcutGroups } from "./shortcuts";
import "./shortcuts.css";

export function ShortcutsPanel(): React.JSX.Element | null {
  const open = useAppStore((s) => s.shortcutsOpen);
  const toggleShortcuts = useAppStore((s) => s.uiActions.toggleShortcuts);
  const closeShortcuts = useAppStore((s) => s.uiActions.closeShortcuts);

  // Global Cmd/Ctrl+/ toggles; Esc closes. Installed once (the actions are stable
  // store references), so the hotkey works whether or not the overlay is showing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        toggleShortcuts();
      } else if (e.key === "Escape" && useAppStore.getState().shortcutsOpen) {
        closeShortcuts();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleShortcuts, closeShortcuts]);

  if (!open) return null;

  const groups = shortcutGroups();
  return (
    <div className="shortcuts-backdrop" onClick={closeShortcuts} data-testid="shortcuts-backdrop">
      <div
        className="shortcuts-panel"
        role="dialog"
        aria-label="Keyboard shortcuts"
        aria-modal="true"
        data-testid="shortcuts-panel"
        // Clicks inside the card must not fall through to the backdrop's close.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-panel__bar">
          <span className="shortcuts-panel__title">Keyboard Shortcuts</span>
          <button
            type="button"
            className="shortcuts-panel__close"
            aria-label="Close shortcuts"
            title="Close (Esc)"
            onClick={closeShortcuts}
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="shortcuts-panel__body">
          {groups.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h2 className="shortcuts-group__title">{group.title}</h2>
              <ul className="shortcuts-group__list">
                {group.shortcuts.map((sc) => (
                  <li key={sc.description} className="shortcuts-row">
                    <span className="shortcuts-row__desc">{sc.description}</span>
                    <span className="shortcuts-row__keys">
                      {sc.keys.map((k, i) => (
                        <kbd key={i} className="shortcuts-key">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The titlebar affordance that opens the shortcuts overlay (the "option"). */
export function ShortcutsButton(): React.JSX.Element {
  const toggleShortcuts = useAppStore((s) => s.uiActions.toggleShortcuts);
  return (
    <button
      type="button"
      className="shortcuts-button"
      aria-label="Keyboard shortcuts"
      title={`Keyboard shortcuts (${modChord("/")})`}
      onClick={toggleShortcuts}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
