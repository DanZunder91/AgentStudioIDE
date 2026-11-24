/**
 * ContextMenu — a small, reusable right-click menu primitive.
 *
 * Headless-ish: the caller owns WHAT the items do and WHERE the menu appears
 * (screen coords from the triggering `contextmenu` event); this component owns
 * the surface, positioning, focus, and dismissal. It is generic — nothing here
 * knows about the file tree (or about git) — so any feature can render one.
 *
 * Contract:
 *   - `items`: menuitem descriptors, or `{ separator: true }` dividers. A
 *     descriptor is `{ label, onSelect, disabled?, danger? }`; a descriptor that
 *     carries `items` instead of `onSelect` is a SUBMENU parent.
 *   - `x` / `y`: where to anchor (fixed positioning), CLAMPED so the surface
 *     never overflows the viewport — it shifts back from the right/bottom edge.
 *   - `onClose`: called after a selection, and on every dismissal path.
 *   - `ariaLabel`: names the `role="menu"` for assistive tech.
 *
 * Dismissal: selecting an item (fires `onSelect` then `onClose`), Esc,
 * outside-click, a `contextmenu` elsewhere (so opening another menu closes this
 * one), and scroll/resize (the anchor would otherwise drift). A disabled item
 * does nothing (native `disabled` button — no click fires).
 *
 * Keyboard: the first enabled item is focused on open; Up/Down move between
 * enabled items (wrapping); Enter/Space activate (native button activation);
 * Esc closes. All key + pointer events are stopped from propagating, so driving
 * the menu never selects a row or starts a drag underneath it.
 *
 * ── Submenus ────────────────────────────────────────────────────────────────
 * Rendering is recursive, so nesting is not artificially capped.
 *
 *   - A parent renders as a `menuitem` with `aria-haspopup="menu"`,
 *     `aria-expanded`, and a trailing `▸`. It is never itself selectable:
 *     activating it opens the child. Choosing a LEAF inside a child fires that
 *     leaf's `onSelect` and then the **root** `onClose` — the whole tree closes,
 *     because every surface is handed the same root `onClose`.
 *   - Opens on hover, on click/Enter/Space (one native button activation), and
 *     on ArrowRight. Closes on ArrowLeft and Esc — both hand focus back to the
 *     parent item, so Esc peels one layer and a second Esc closes the whole
 *     menu — on hovering another item of the same level, and on any root
 *     dismissal. Exactly ONE submenu is open per level. A `disabled` parent
 *     never opens and is inert to hover (it cannot hold the focus ring either,
 *     so ArrowRight can never reach it).
 *   - The child surface is rendered INSIDE its parent's DOM subtree (fixed
 *     positioning frees it from the parent's box, so nesting costs no layout).
 *     That is deliberate and load-bearing: the outside-click check is
 *     `menuRef.contains(target)`, and a portalled child would read as *outside*
 *     — opening a submenu would instantly dismiss the whole menu. Only the root
 *     installs the global dismissal listeners, for the same reason.
 *   - Geometry: to the RIGHT of the parent item, top-aligned with it, flipping
 *     to its LEFT when the right side would overflow, and then through the very
 *     same viewport clamp the root uses (one copy — two would drift apart).
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import "./contextMenu.css";

/** One entry in a `ContextMenu`: an action, a submenu, or a visual divider. */
export type ContextMenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { label: string; items: ContextMenuItem[]; disabled?: boolean }
  | { separator: true };

export interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  ariaLabel: string;
}

/** Keep the surface at least this far from the viewport edge when clamping. */
export const MENU_MARGIN = 6;

/** The submenu variant — distinguished, per the contract, by carrying `items`. */
type SubmenuItem = Extract<ContextMenuItem, { items: unknown }>;

function isSeparator(item: ContextMenuItem): item is { separator: true } {
  return "separator" in item;
}

function isSubmenu(item: ContextMenuItem): item is SubmenuItem {
  return "items" in item;
}

/**
 * Shift a `w`×`h` surface back inside the viewport so it never overflows the
 * right or bottom edge, keeping `MENU_MARGIN` of air. ONE copy, shared by the
 * root menu and by every submenu — a second copy would drift out of step.
 */
function clampToViewport(x: number, y: number, w: number, h: number): { x: number; y: number } {
  let nx = x;
  let ny = y;
  if (nx + w > window.innerWidth - MENU_MARGIN) {
    nx = Math.max(MENU_MARGIN, window.innerWidth - MENU_MARGIN - w);
  }
  if (ny + h > window.innerHeight - MENU_MARGIN) {
    ny = Math.max(MENU_MARGIN, window.innerHeight - MENU_MARGIN - h);
  }
  return { x: nx, y: ny };
}

/** The open submenu at ONE level — at most one, by construction. */
interface OpenSubmenu {
  /** Index into this level's `items` of the parent whose child is open. */
  index: number;
  /** That parent's button — the child measures its own position from its rect. */
  anchor: HTMLButtonElement;
}

interface MenuSurfaceProps {
  items: ContextMenuItem[];
  /** Desired anchor point. Ignored when `anchor` is set (a submenu). */
  x: number;
  y: number;
  /** The ROOT close — a leaf selection anywhere closes the entire tree. */
  onClose: () => void;
  ariaLabel: string;
  /**
   * The parent menuitem this surface hangs off, when it is a SUBMENU; `null`
   * for the root menu. Travels with `onDismiss`, but is a separate prop because
   * it is a stable DOM node the geometry effect can safely depend on.
   */
  anchor: HTMLButtonElement | null;
  /** Close just THIS submenu (ArrowLeft / Esc) — `null` for the root menu. */
  onDismiss: (() => void) | null;
}

function MenuSurface({ items, x, y, onClose, ariaLabel, anchor, onDismiss }: MenuSurfaceProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<OpenSubmenu | null>(null);

  // Indices (into `items`) of the enabled, selectable entries — the focus ring.
  const enabledIndices = items.reduce<number[]>((acc, item, i) => {
    if (!isSeparator(item) && !item.disabled) acc.push(i);
    return acc;
  }, []);

  // Which item currently holds focus. Starts on the first enabled one (-1 if the
  // menu is somehow all-disabled/separators, so the focus effect is a no-op).
  const [activeIndex, setActiveIndex] = useState(() => (enabledIndices.length > 0 ? enabledIndices[0] : -1));

  // Anchor at (x, y), then clamp back inside the viewport once the surface has a
  // measured size. Runs before paint (useLayoutEffect) so there is no flash at
  // the un-clamped spot. Depends only on x/y/anchor — reopening at a new anchor
  // re-clamps, and each of the three is stable for the surface's lifetime.
  useLayoutEffect(() => {
    // The surface is always mounted while this runs (the menu renders it), so the
    // ref is non-null — no defensive branch to leave uncovered.
    const rect = menuRef.current!.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (anchor !== null) {
      // A submenu: beside its parent item, top-aligned with it — and flipped to
      // the item's LEFT when the right-hand placement would overflow.
      const a = anchor.getBoundingClientRect();
      nx = a.right;
      ny = a.top;
      if (nx + rect.width > window.innerWidth - MENU_MARGIN) {
        nx = Math.max(MENU_MARGIN, a.left - rect.width);
      }
    }
    setPos(clampToViewport(nx, ny, rect.width, rect.height));
  }, [x, y, anchor]);

  // Move browser focus to the active item whenever it changes (open + arrows) —
  // unless a submenu is open, in which case focus belongs to the child, which
  // takes it on mount. Closing the child re-runs this and hands focus back to
  // the parent item, so keys keep reaching a menu instead of the body.
  useEffect(() => {
    if (openSub !== null) return;
    itemRefs.current[activeIndex]?.focus();
  }, [activeIndex, openSub]);

  // Global dismissal: outside-click, a contextmenu elsewhere (opening another
  // menu closes this one), and scroll/resize (the anchor would drift). Captured
  // so it fires even if an underlying handler stops propagation. ROOT ONLY: a
  // submenu lives inside the root's surface, so the root's `contains` check
  // already covers it, and a second copy here would both fire `onClose` twice on
  // a scroll and read a click on the PARENT menu as "outside" its own box.
  useEffect(() => {
    if (anchor !== null) return;
    const outside = (e: Event): void => {
      // Non-null: the surface is mounted for the listener's whole lifetime.
      if (!menuRef.current!.contains(e.target as Node | null)) onClose();
    };
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("contextmenu", outside, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, anchor]);

  const moveFocus = (delta: number): void => {
    if (enabledIndices.length === 0) return;
    const cur = enabledIndices.indexOf(activeIndex);
    const next = (cur + delta + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[next]);
  };

  /** Open the child of the item at `i` (its rendered button is `el`). */
  const openSubmenu = (i: number, el: HTMLButtonElement): void => {
    setActiveIndex(i);
    setOpenSub({ index: i, anchor: el });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      // Esc peels ONE layer: a submenu closes itself and hands focus back to its
      // parent item, so the next Esc reaches the root and closes everything.
      if (onDismiss !== null) onDismiss();
      else onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      // Only an ENABLED item can hold the focus ring, so a disabled parent is
      // unreachable from here — no guard to write and leave uncovered.
      // `activeIndex` is -1 only in an all-disabled menu, where nothing opens.
      if (activeIndex >= 0 && isSubmenu(items[activeIndex])) {
        // Non-null: `activeIndex` names a rendered, enabled button.
        openSubmenu(activeIndex, itemRefs.current[activeIndex]!);
      }
    } else if (e.key === "ArrowLeft" && onDismiss !== null) {
      e.preventDefault();
      onDismiss();
    }
    // Enter/Space fall through to native button activation on the focused item.
  };

  const select = (onSelect: () => void): void => {
    onSelect();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // A right-click ON the menu must not open the OS menu or bubble to a row.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) => {
        if (isSeparator(item)) {
          return <div key={i} className="context-menu__separator" role="separator" />;
        }
        // Split the row's two kinds EAGERLY, here in the render body: a row is
        // either an action (`onSelect`) or a parent (`subItems`), never both, and
        // TypeScript drops a narrowing at the closure boundary of the handlers.
        const subItems = isSubmenu(item) ? item.items : null;
        const onSelect = isSubmenu(item) ? null : item.onSelect;
        const danger = !isSubmenu(item) && item.danger === true;
        const disabled = item.disabled === true;
        // The parent button of THIS row's open child, or null when it is closed.
        // One expression, so "is it open?" and "what does it hang off?" can never
        // disagree — and it narrows `openSub` for the child's `anchor` prop.
        const subAnchor = subItems !== null && openSub !== null && openSub.index === i ? openSub.anchor : null;
        return (
          // `role="none"` keeps this wrapper out of the accessibility tree (a
          // `menu` may only own menuitems), and `display: contents` keeps it out
          // of layout — the button still lays out as a direct child of the menu.
          <div key={i} className="context-menu__row" role="none">
            <button
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              className={`context-menu__item${danger ? " is-danger" : ""}${subItems !== null ? " has-submenu" : ""}`}
              disabled={disabled}
              tabIndex={i === activeIndex ? 0 : -1}
              aria-haspopup={subItems !== null ? "menu" : undefined}
              aria-expanded={subItems !== null ? subAnchor !== null : undefined}
              onClick={(e) => {
                // A submenu parent is not selectable: click / Enter / Space are
                // one native button activation, and all three open the child.
                if (onSelect === null) openSubmenu(i, e.currentTarget);
                else select(onSelect);
              }}
              onMouseEnter={(e) => {
                // No `disabled` guard here on purpose: React never delivers
                // onMouseEnter (or onClick) to a disabled interactive element, so
                // a disabled row is already inert to the mouse and a guard would
                // be a branch this file could not cover. Pinned by the test
                // "a disabled submenu never opens".
                setActiveIndex(i);
                // One submenu per level: hovering anything else closes the open one.
                setOpenSub(subItems === null ? null : { index: i, anchor: e.currentTarget });
              }}
            >
              {item.label}
              {subItems !== null && (
                <span className="context-menu__chevron" aria-hidden="true">
                  ▸
                </span>
              )}
            </button>
            {subItems !== null && subAnchor !== null && (
              <MenuSurface
                items={subItems}
                x={0}
                y={0}
                onClose={onClose}
                ariaLabel={item.label}
                anchor={subAnchor}
                onDismiss={() => setOpenSub(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenu({ items, x, y, onClose, ariaLabel }: ContextMenuProps): React.JSX.Element {
  return <MenuSurface items={items} x={x} y={y} onClose={onClose} ariaLabel={ariaLabel} anchor={null} onDismiss={null} />;
}
