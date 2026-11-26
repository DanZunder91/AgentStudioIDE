/** The right rail's tab bar: icon-only, the label in `aria-label` and the tooltip. The width budget
 * is `railTabsLayout.ts`; tabs past it fold behind "⋯". Plain buttons with `aria-selected`, not
 * `role="tab"`: the smoke-core E2E expects a single `role="tab"` group (the center `TabBar`). */

import { useEffect, useRef, useState } from "react";

import {
  BookmarkIcon,
  ClockIcon,
  DatabaseIcon,
  EllipsisIcon,
  FolderIcon,
  GitBranchIcon,
  LockIcon,
  WrenchIcon,
} from "../../components/icons";
import { useAppStore } from "../../app/store";
import type { RightRailTab } from "../../app/types";
import { visibleTabCount } from "./railTabsLayout";
import "./railTabs.css";

type RailTabId = RightRailTab;

/** Display order. NOT exported: tests state their own literal expectations. */
const TABS: ReadonlyArray<{
  id: RailTabId;
  label: string;
  Icon: (props: { size?: number }) => React.JSX.Element;
}> = [
  { id: "files", label: "Files", Icon: FolderIcon },
  { id: "vault", label: "Vault", Icon: LockIcon },
  { id: "history", label: "History", Icon: ClockIcon },
  { id: "collections", label: "Collections", Icon: BookmarkIcon },
  // The database client. Label "DB", not "Database" — the tooltip is the only place
  // the word appears now, but the id and the label are also what the E2E and the a11y
  // name are read from, so the short form is fixed.
  { id: "db", label: "DB", Icon: DatabaseIcon },
  // Tools sits next to the database tab, so it goes last rather than in some
  // alphabetical or importance order — the requirement WAS a position. Label "Tools",
  // which is also the accessible name.
  { id: "tools", label: "Tools", Icon: WrenchIcon },
  // Source control. Last because it is newest (`RightRailTab`'s union order
  // is the display order), and the tab that tipped the strip over its width budget —
  // see the header: it is why the overflow trigger exists at all.
  { id: "git", label: "Git", Icon: GitBranchIcon },
];

/** Icon edge, px. Matches the `components/icons` house default. */
const ICON_SIZE = 13;

export function RailTabs(): React.JSX.Element {
  const rightRailTab = useAppStore((s) => s.rightRailTab);
  const rightRailWidth = useAppStore((s) => s.rightRailWidth);
  const setRightRailTab = useAppStore((s) => s.uiActions.setRightRailTab);

  // The overflow menu is a lightweight popover, not a global overlay, so its open
  // state is LOCAL (the SettingsMenu precedent) — the store never learns about it.
  const [open, setOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);

  const visible = visibleTabCount(rightRailWidth, TABS.length);
  const shown = TABS.slice(0, visible);
  const hidden = TABS.slice(visible);
  // When the ACTIVE panel's tab is folded away, the trigger lights up in its stead —
  // otherwise a narrow rail shows a strip with no lit tab and the selection looks lost.
  const activeHidden = hidden.some(({ id }) => id === rightRailTab);

  // A cut that moves under an open menu closes it (no stale list, no pre-opened trigger on return).
  // Done during render, not in an effect, so the close lands in the render that moved the cut.
  const [prevVisible, setPrevVisible] = useState(visible);
  if (prevVisible !== visible) {
    setPrevVisible(visible);
    setOpen(false);
  }

  // Close on Esc or a click outside the trigger+menu cluster (SettingsMenu pattern).
  // Installed only while open, so a closed menu adds no listeners. A click on a
  // VISIBLE tab is outside the cluster, so it both switches panels and closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
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
    <div className="rail__tabs" aria-label="Workspace panels">
      {shown.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className={`rail__tab${rightRailTab === id ? " rail__tab--active" : ""}`}
          aria-selected={rightRailTab === id}
          // Icon-only (text made the strip wrap), so the name must come from `aria-label`:
          // `title` is a tooltip, not an accessible name.
          aria-label={label}
          title={label}
          data-testid={`rail-tab-${id}`}
          onClick={() => setRightRailTab(id)}
        >
          <Icon size={ICON_SIZE} />
        </button>
      ))}

      {hidden.length > 0 && (
        // Plain (unpositioned) wrapper: outside-click covers trigger + menu, and the menu anchors
        // to `.rail__tabs` at full width; trigger-anchored, `.rail`'s overflow would clip it.
        <div className="rail-tabs__overflow" ref={overflowRef}>
          <button
            type="button"
            className={`rail__tab rail__tab--overflow${activeHidden ? " rail__tab--active" : ""}`}
            data-testid="rail-tab-overflow"
            aria-label="More panels"
            title="More panels"
            aria-haspopup="true"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <EllipsisIcon size={ICON_SIZE} />
          </button>

          {open && (
            <div
              className="rail-tabs__menu"
              role="menu"
              aria-label="More panels"
              data-testid="rail-overflow-menu"
            >
              {hidden.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  className={`rail-tabs__item${
                    rightRailTab === id ? " rail-tabs__item--current" : ""
                  }`}
                  data-testid={`rail-menu-${id}`}
                  onClick={() => {
                    setRightRailTab(id);
                    setOpen(false);
                  }}
                >
                  <Icon size={ICON_SIZE} />
                  {/* In the MENU the label is visible text (there is room; the strip's
                      width pressure is exactly what put the tab here), so it is also
                      the accessible name — no aria-label needed. */}
                  <span className="rail-tabs__item-label">{label}</span>
                  {rightRailTab === id && (
                    // `aria-selected` is not valid on a menuitem, so the "this is the
                    // active panel" signal is visual: a checkmark + class, hidden from
                    // the accessible name.
                    <span className="rail-tabs__item-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
