/**
 * RailTabs — the right rail's tab bar: Files / Vault / History / Collections / DB /
 * Tools / Git. Find lives OUT of it, as a
 * magnifying-glass icon in the titlebar — it is a momentary overlay
 * toggle, not a mounted panel, so it never belonged among the persistent-panel tabs.
 *
 * The PERSISTENT panels the bar switches between (`rightRailTab`) are Files = the
 * multi-root `<WorkspaceTree/>`, Vault = the `<VaultPanel/>` secrets manager,
 * History = the `<HistoryPanel/>` API request log, Collections = the
 * `<CollectionsPanel/>` saved-request library (HTTP/WS/gRPC), DB = the
 * `<DbPanel/>` saved-connection list, Tools = the `<ToolsPanel/>`
 * self-contained developer utilities, and Git = the `<GitPanel/>` source-control
 * view.
 *
 * Reuses the existing `.rail__tabs` / `.rail__tab` styling (App.css); the overflow
 * trigger + menu styling is feature-local (`./railTabs.css`).
 *
 * Each tab is an inline-SVG icon from `components/icons` — folder / padlock / clock /
 * bookmark / database / spanner / branch — with **no visible text**; the label is the
 * tooltip (only the icon is shown, and the label appears as a tooltip on hover).
 * Icon+label tabs do not fit: four of them needed ~271px of a ~279px content box
 * ("Collections" clipped at the rail edge), so the strip wrapped at the narrow end of the
 * resizer. Dropping the words is what bought the headroom every tab since has spent.
 *
 * ⚠️ **THE WIDTH BUDGET lives in code, not in this comment** (as prose it went stale).
 * Seven tabs do not fit at the 10px gap — 7×17 + 6×10 = **179px against 159px** of
 * content box at `RAIL_MIN_W` — and the answer is an overflow menu, not another gap
 * shave:
 *
 *   `railTabsLayout.ts` owns the constants (TAB_W 17, TAB_GAP 10, STRIP_CHROME 21,
 *   TRIGGER_W 17) and the ONE function, `visibleTabCount(railWidth, tabCount)`.
 *   This component subscribes to the store's `rightRailWidth` — the width only ever
 *   changes through `setRightRailWidth`, so NO ResizeObserver — slices `TABS` to the
 *   visible prefix, and folds the rest behind a tab-sized "⋯" trigger that opens a
 *   `role="menu"` popover (labels visible there, unlike the strip). At the 180px
 *   drag-min that is 5 tabs + trigger = 152px ≤ 159px; at the default 300px all
 *   seven fit outright (179px ≤ 279px) and no trigger renders. Selection never
 *   reorders the strip: visibility is width math alone, and when the ACTIVE tab is
 *   in the hidden set the trigger carries `rail__tab--active` in its stead.
 *   `src/e2e/railChrome.browser.test.tsx` re-derives needed-vs-available from the
 *   live boxes so a pixel drift between the CSS and the constants turns red.
 *
 * Because there is no text, the accessible name comes from `aria-label` on the BUTTON
 * (the glyph itself stays `aria-hidden` + `focusable={false}`, as `components/icons`
 * marks every icon) — a `title` is a tooltip, not a name. Icons stroke with
 * `currentColor`, so each inherits its tab's dim/active colour rather than fighting it.
 *
 * a11y note: these are plain buttons with `aria-selected`, NOT `role="tab"`. The
 * CENTER pane strip (`TabBar`) already owns `role="tab"`, and the smoke-core E2E
 * asserts a SINGLE `getByRole("tab")` there — a second `role="tab"` group in the
 * rail would make that lookup ambiguous. The overflow popover is `role="menu"` /
 * `role="menuitem"` (the SettingsMenu pattern), which stays clear of that lookup.
 */

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

/**
 * The tab strip, in display order. NOT exported: a test must state its own
 * literal expectations (an expectation read from the table under test can only
 * catch plumbing, never a wrong value).
 */
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

  // The cut is width math; if it moves under an open menu (a drag mid-interaction),
  // the menu's contents just changed, so close rather than show a stale list. Also
  // covers the round trip where the trigger unmounts (wide) and comes back (narrow):
  // without this, a lingering `open` would make it reappear pre-opened. Done with
  // the previous-value-during-render pattern (react.dev "adjusting state when a
  // prop changes") rather than an effect — the close must land in the SAME render
  // that moved the cut, and `react-hooks/set-state-in-effect` forbids the effect form.
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
          // ICON-ONLY: the label moved to the tooltip. With the
          // text present, four tabs needed ~271px of a ~279px content box, so at the
          // narrow end of the resizer the strip wrapped — and "Collections" ended up
          // clipped at the rail edge. Glyph-only bought ~254px of
          // that back; see the width budget in the file header for what seven now cost.
          //
          // The accessible name now comes from `aria-label`, NOT from text content, so
          // it must be set explicitly: `title` alone is a tooltip, not a name, and a
          // screen reader would announce an unlabelled button. `aria-label` also keeps
          // every existing `getByRole("button", { name: "Files" })` lookup working.
          aria-label={label}
          title={label}
          data-testid={`rail-tab-${id}`}
          onClick={() => setRightRailTab(id)}
        >
          <Icon size={ICON_SIZE} />
        </button>
      ))}

      {hidden.length > 0 && (
        // The wrapper is a plain (NOT positioned) flex item: it exists so outside-click
        // containment covers trigger + menu together, while the menu's absolute box
        // still anchors to `.rail__tabs` (position: relative, in railTabs.css) and can
        // span the strip's full width — a trigger-anchored popover would be clipped by
        // `.rail`'s `overflow-x: hidden` at the strip's right edge.
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
