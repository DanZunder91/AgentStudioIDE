/**
 * SettingsMenu — the titlebar gear that opens a small settings popover.
 *
 * Self-contained, like `<ShortcutsButton/>` but with LOCAL open/closed state (this
 * is a lightweight menu, not a global overlay, so it does not live in the store):
 * a gear button toggles a popover that closes on outside-click or Esc. Inside is
 * an accessible switch ("Focus follows agent") bound straight to the store's
 * `focusFollowsAgent` / `setFocusFollowsAgent`.
 *
 * App only imports `{ SettingsMenu }` and mounts it in the titlebar; everything
 * else (open state, keyboard, click-away) is owned here.
 */

import { useEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import "./settings.css";

/** A small gear icon (inherits `currentColor`), sized to match the titlebar cluster. */
function GearIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.55 1.55M17.55 17.55l1.55 1.55M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.55-1.55M17.55 6.45l1.55-1.55"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SettingsMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const focusFollowsAgent = useAppStore((s) => s.focusFollowsAgent);
  // Config bundles: the only two actions in this menu. Selected narrowly (not the whole actions object)
  // so a change elsewhere in the portability slice cannot re-render the titlebar.
  const openPortabilityDialog = useAppStore((s) => s.portabilityActions.openPortabilityDialog);
  const setFocusFollowsAgent = useAppStore(
    (s) => s.workspaceActions.setFocusFollowsAgent,
  );

  // Close on Esc or a click outside the menu. Installed only while open, so a
  // closed menu adds no listeners.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        type="button"
        className="titlebar__icon-btn settings-menu__trigger"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </button>

      {open && (
        <div
          className="settings-menu__popover"
          role="menu"
          aria-label="Settings menu"
          data-testid="settings-popover"
        >
          <div className="settings-menu__row">
            <label className="settings-menu__label" htmlFor="focus-follows-agent">
              <span className="settings-menu__label-text">Focus follows agent</span>
              <span className="settings-menu__hint">
                Selecting an agent collapses other folders and reveals its own.
              </span>
            </label>
            <button
              type="button"
              id="focus-follows-agent"
              role="switch"
              aria-checked={focusFollowsAgent}
              className="settings-menu__switch"
              onClick={() => setFocusFollowsAgent(!focusFollowsAgent)}
            >
              <span className="settings-menu__switch-knob" aria-hidden="true" />
            </button>
          </div>

          {/* ── share-a-config ─────────────────────────────────────────────────
              Here rather than in a new titlebar button because the titlebar already
              carries five, and rather than in the macOS app menu because `menu.rs` is
              macOS-only — a feature reachable on one platform is not a finished feature.
              Closing the popover on click is deliberate: both of these open a modal
              dialog, and leaving a menu open behind a modal is how you end up with two
              things claiming focus. */}
          <div className="settings-menu__separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="settings-menu__item"
            data-testid="settings-export-config"
            onClick={() => {
              setOpen(false);
              openPortabilityDialog("export");
            }}
          >
            <span className="settings-menu__label-text">Export configuration…</span>
            <span className="settings-menu__hint">
              Share your database connections and API requests as a JSON file.
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="settings-menu__item"
            data-testid="settings-import-config"
            onClick={() => {
              setOpen(false);
              openPortabilityDialog("import");
            }}
          >
            <span className="settings-menu__label-text">Import configuration…</span>
            <span className="settings-menu__hint">
              Review a colleague&rsquo;s file before anything is added.
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
