/** Titlebar gear popover with local open state (a lightweight menu, not a store overlay); owns its
 * keyboard and click-away. "Interface…" is a second page, so the menu stays short as appearance
 * options are added. */

import { useEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import {
  DEFAULT_RAIL_GROUP_STYLE,
  RAIL_GROUP_STYLE_OPTIONS,
  railGroupStyleLabel,
  type RailGroupStyle,
} from "../fleet/railGroupStyle";
import { ClaudeMcpItem } from "./ClaudeMcpItem";
import "./settings.css";

type Page = "main" | "interface";

/** A drawing of each project style, so the choice is made by eye; `currentColor` strokes. */
function RailGroupPreview({ style }: { style: RailGroupStyle }): React.JSX.Element {
  const line = (y: number, x = 9) => (
    <rect x={x} y={y} width={30 - x} height="2" rx="1" fill="currentColor" opacity="0.45" />
  );
  return (
    <svg
      className="settings-menu__preview"
      width="36"
      height="28"
      viewBox="0 0 36 28"
      aria-hidden="true"
    >
      {style === "card" && (
        <>
          <rect x="2.5" y="2.5" width="31" height="23" rx="4" fill="none" stroke="currentColor" opacity="0.7" />
          <path d="M3 9.5h30" stroke="currentColor" opacity="0.35" />
          <rect x="6" y="5" width="12" height="2" rx="1" fill="currentColor" />
          {line(14, 7)}
          {line(19, 7)}
        </>
      )}
      {style === "well" && (
        <>
          <rect x="3" y="3" width="12" height="2" rx="1" fill="currentColor" />
          <rect x="2" y="8" width="32" height="18" rx="4" fill="currentColor" opacity="0.18" />
          {line(13, 6)}
          {line(19, 6)}
        </>
      )}
      {style === "divider" && (
        <>
          <rect x="2" y="3" width="10" height="2" rx="1" fill="currentColor" />
          <path d="M14 4h20" stroke="currentColor" opacity="0.5" />
          {line(11, 6)}
          {line(17, 6)}
          {line(23, 6)}
        </>
      )}
      {style === "pinned" && (
        <>
          <rect x="2" y="2" width="32" height="8" rx="2.5" fill="currentColor" opacity="0.35" />
          <rect x="5" y="5" width="12" height="2" rx="1" fill="currentColor" />
          {line(15, 7)}
          {line(21, 7)}
        </>
      )}
    </svg>
  );
}

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
  const [page, setPage] = useState<Page>("main");
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Focus follows the page change, so a keyboard user lands on the page they opened
  // (its Back button) and back on the item they came from.
  const backRef = useRef<HTMLButtonElement | null>(null);
  const interfaceItemRef = useRef<HTMLButtonElement | null>(null);
  const pageChanged = useRef(false);

  const focusFollowsAgent = useAppStore((s) => s.focusFollowsAgent);
  // Config bundles: the two store actions in this menu. Selected narrowly (not the whole actions object)
  // so a change elsewhere in the portability slice cannot re-render the titlebar.
  const openPortabilityDialog = useAppStore((s) => s.portabilityActions.openPortabilityDialog);
  const setFocusFollowsAgent = useAppStore(
    (s) => s.workspaceActions.setFocusFollowsAgent,
  );
  const railGroupStyle = useAppStore((s) => s.railGroupStyle);
  const setRailGroupStyle = useAppStore((s) => s.workspaceActions.setRailGroupStyle);

  const goTo = (next: Page) => {
    pageChanged.current = true;
    setPage(next);
  };
  useEffect(() => {
    if (!pageChanged.current) return;
    pageChanged.current = false;
    (page === "interface" ? backRef : interfaceItemRef).current?.focus();
  }, [page]);

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
        onClick={() => {
          setOpen((v) => !v);
          // Every opening starts on the first page.
          setPage("main");
        }}
      >
        <GearIcon />
      </button>

      {open && page === "interface" && (
        <div
          className="settings-menu__popover"
          role="menu"
          aria-label="Interface settings"
          data-testid="settings-popover"
        >
          <div className="settings-menu__page-head">
            <button
              type="button"
              ref={backRef}
              className="settings-menu__back"
              aria-label="Back to settings"
              data-testid="settings-back"
              onClick={() => goTo("main")}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <span className="settings-menu__title">Interface</span>
          </div>

          <div
            className="settings-menu__section"
            role="group"
            aria-labelledby="settings-rail-groups-label"
          >
            <span className="settings-menu__section-label" id="settings-rail-groups-label">
              Project groups in the agent rail
            </span>
            {RAIL_GROUP_STYLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={railGroupStyle === option.value}
                className="settings-menu__choice"
                data-testid={`rail-group-style-${option.value}`}
                onClick={() => setRailGroupStyle(option.value)}
              >
                <RailGroupPreview style={option.value} />
                <span className="settings-menu__choice-text">
                  <span className="settings-menu__label-text">
                    {option.label}
                    {option.value === DEFAULT_RAIL_GROUP_STYLE && (
                      <span className="settings-menu__default"> · default</span>
                    )}
                  </span>
                  <span className="settings-menu__hint">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {open && page === "main" && (
        <div
          className="settings-menu__popover"
          role="menu"
          aria-label="Settings menu"
          data-testid="settings-popover"
        >
          <button
            type="button"
            ref={interfaceItemRef}
            role="menuitem"
            aria-haspopup="true"
            className="settings-menu__item settings-menu__item--nav"
            data-testid="settings-interface"
            onClick={() => goTo("interface")}
          >
            <span className="settings-menu__label-text">Interface</span>
            <span className="settings-menu__hint">
              Project groups: {railGroupStyleLabel(railGroupStyle)}
            </span>
            <span className="settings-menu__chevron" aria-hidden="true">
              ›
            </span>
          </button>
          <div className="settings-menu__separator" role="separator" />

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

          {/* Share-a-config: the titlebar is full and `menu.rs` is macOS-only. A click closes the
              popover on purpose: both open a modal, and a menu behind one fights for focus. */}
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

          {/* ── Agent Studio's tools in Claude Code ─────────────────────────────
              The menu's way to `agent-studio mcp install|uninstall`. It asks Claude Code
              for the status when it mounts, i.e. when this popover opens. */}
          <div className="settings-menu__separator" role="separator" />
          <ClaudeMcpItem />
        </div>
      )}
    </div>
  );
}
