/** Suppress the webview's page menu (WebKitGTK's Back/Forward/Reload) window-wide, in the bubble
 * phase so feature menus (which preventDefault first) win. The native editing menu stays for
 * editable targets and clicks inside the selection's rects (WebKit uses the hit test). */

/** CSS for "the native menu here is the editing menu, keep it". The bare
 *  `[contenteditable]` values are enumerated because `contenteditable="false"`
 *  explicitly opts OUT of editing and must not match. */
const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(", ");

/** Is the event target inside an editable region? Non-`Element` targets (the
 *  document itself, a text node re-targeted oddly) answer false — there is
 *  nothing to edit, so there is nothing to carve out. */
function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

/** Per-range `getClientRects`, not one bounding box: a multi-line selection's box covers the dead
 * space right of short lines, where WebKit's hit test gives the page menu. */
function pointInSelection(x: number, y: number): boolean {
  const sel = window.getSelection();
  if (sel === null || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of sel.getRangeAt(i).getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
  }
  return false;
}

/** Install once from main.tsx (not `<App>`, so App renders in tests without it). Returns the
 * uninstaller, for tests; the app never uninstalls it. */
export function suppressNativeContextMenu(): () => void {
  const onContextMenu = (e: MouseEvent): void => {
    // A feature menu already claimed this click — never double-handle it.
    if (e.defaultPrevented) return;
    if (isEditableTarget(e.target)) return;
    if (pointInSelection(e.clientX, e.clientY)) return;
    e.preventDefault();
  };
  window.addEventListener("contextmenu", onContextMenu);
  return () => window.removeEventListener("contextmenu", onContextMenu);
}
