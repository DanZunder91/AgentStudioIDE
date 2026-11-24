/**
 * nativeContextMenu — keep the webview's browser-ish right-click menu out of the app.
 *
 * The problem (seen on Ubuntu): right-clicking the rails — or any
 * surface without a menu of its own — shows WebKitGTK's default page menu, with
 * **Back / Forward / Reload**. Those are navigation verbs for a browser; in a
 * desktop IDE whose one document IS the app, "Back" is at best dead and at worst
 * navigates the webview away from the bundle. The editor already made the call
 * explicit long ago (`editorMenu.ts`: *our tools, not the native WebKit menu*);
 * this module extends that decision to the whole window.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * One window-level `contextmenu` listener, in the BUBBLE phase, that calls
 * `preventDefault()` — with exactly two carve-outs where the native menu is the
 * *editing* menu (Cut/Copy/Paste…, no navigation items) and genuinely useful:
 *
 *   1. **Editable targets** — `<input>`, `<textarea>`, or anything inside a
 *      `contenteditable` region. Right-click-paste in the HTTP client's URL box,
 *      the DB console inputs, the find fields, etc. must keep working; there is
 *      no app-owned menu there to replace it.
 *   2. **A right-click ON selected text** — WebKit shows the selection menu
 *      (Copy), which is how people copy out of read-only surfaces (HTTP
 *      responses, logs, the markdown preview). Only a click whose point is
 *      inside the selection's own rectangles qualifies: a stale selection
 *      elsewhere on screen must not let the page menu through, because WebKit
 *      builds the menu from the HIT TEST, not from the selection's existence.
 *
 * ── Why bubble phase, and why `defaultPrevented` is respected ────────────────
 * Features with their own menus (workspace tree, editor, agent rows) call
 * `preventDefault()` in their React handlers, which run off the root-container
 * listener — i.e. before a window bubble listener. Checking `defaultPrevented`
 * first means this module can never fight a feature menu; it only catches the
 * clicks nobody claimed. Capture phase would invert that order and break every
 * existing menu, which is why it is not used.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────────
 * Installed once from `main.tsx` (the composition root), for the process's
 * lifetime — same shape as `startBridge()`, and for the same reason: it is
 * wiring to the host environment, not UI, so `<App>` stays renderable in tests
 * without it. The returned uninstaller exists for tests.
 */

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

/**
 * Is the click point inside the current DOM selection's rendered rectangles?
 *
 * Per-range `getClientRects` (not one bounding box): a multi-line selection's
 * bounding box covers the dead space right of short lines, and a right-click
 * there gets the PAGE menu from WebKit's hit test — so the bounding box would
 * answer "selection" exactly where the engine answers "page".
 */
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

/**
 * Install the guard. Returns the uninstaller (tests; the app never calls it —
 * process exit is the teardown, the `startBridge` precedent).
 */
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
