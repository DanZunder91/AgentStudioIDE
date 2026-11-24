/**
 * nativeContextMenu.test — the window-level guard that keeps the webview's
 * default right-click menu (Back/Forward/Reload on WebKitGTK) out of the app.
 *
 * The observable contract is `defaultPrevented` on the event: `true` means the
 * native menu was suppressed, `false` means the webview may show its own. Every
 * test asserts THAT bit, because it is exactly what the engine reads.
 *
 * jsdom has no layout, so the selection-rectangle tests stub
 * `Range.prototype.getClientRects` with hand-placed rects (saved/restored around
 * every test) — the same geometry-stub approach as `find/cmTestKit`. What jsdom
 * cannot prove — that WebKitGTK really builds its menu from the hit test — is
 * the documented reason the module checks the click POINT against the rects
 * rather than the selection's mere existence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { suppressNativeContextMenu } from "./nativeContextMenu";

/** Dispatch a `contextmenu` at `target` and hand back the event for asserting. */
function fire(target: EventTarget, init?: MouseEventInit): MouseEvent {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** A DOMRect-shaped box — only the four sides the module reads. */
function box(left: number, right: number, top: number, bottom: number): DOMRect {
  return { left, right, top, bottom } as DOMRect;
}

/** Stub the selection geometry (jsdom has none) for the current test. */
function stubSelectionRects(rects: DOMRect[]): void {
  (Range.prototype as { getClientRects: () => DOMRectList }).getClientRects = () =>
    rects as unknown as DOMRectList;
}

/** Select the contents of `el` so `window.getSelection()` is non-collapsed. */
function selectContentsOf(el: Element): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("suppressNativeContextMenu", () => {
  let uninstall: () => void;
  const savedGetClientRects = (Range.prototype as { getClientRects?: unknown }).getClientRects;

  beforeEach(() => {
    uninstall = suppressNativeContextMenu();
  });

  afterEach(() => {
    uninstall();
    window.getSelection()?.removeAllRanges();
    (Range.prototype as { getClientRects?: unknown }).getClientRects = savedGetClientRects;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("suppresses the menu on a plain surface (the rails, panels, terminal bg)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(fire(div).defaultPrevented).toBe(true);
  });

  it("suppresses it on a non-Element target too (the document itself)", () => {
    expect(fire(document).defaultPrevented).toBe(true);
  });

  it("the uninstaller removes the guard", () => {
    uninstall();
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(fire(div).defaultPrevented).toBe(false);
    // Re-install so afterEach's uninstall has something to remove.
    uninstall = suppressNativeContextMenu();
  });

  it("never double-handles a click a feature menu already claimed", () => {
    // The workspace tree / editor / agent rows preventDefault in their own
    // handlers, which run before a window bubble listener. The guard must see
    // `defaultPrevented` and step aside — pinned by counting preventDefault
    // calls on the event itself: exactly one (the feature's), not two.
    const container = document.createElement("div");
    const row = document.createElement("div");
    container.appendChild(row);
    document.body.appendChild(container);
    container.addEventListener("contextmenu", (e) => e.preventDefault());

    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const preventDefault = vi.fn(e.preventDefault.bind(e));
    Object.defineProperty(e, "preventDefault", { value: preventDefault });
    row.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("keeps the native EDITING menu on inputs, textareas and contenteditable", () => {
    for (const make of [
      (): Element => document.createElement("input"),
      (): Element => document.createElement("textarea"),
      (): Element => {
        const d = document.createElement("div");
        d.setAttribute("contenteditable", "");
        return d;
      },
      (): Element => {
        const d = document.createElement("div");
        d.setAttribute("contenteditable", "true");
        return d;
      },
      (): Element => {
        const d = document.createElement("div");
        d.setAttribute("contenteditable", "plaintext-only");
        return d;
      },
      // A child INSIDE an editable region — `closest` walks up to find it.
      (): Element => {
        const d = document.createElement("div");
        d.setAttribute("contenteditable", "true");
        const span = document.createElement("span");
        d.appendChild(span);
        document.body.appendChild(d);
        return span;
      },
    ]) {
      const el = make();
      if (!el.isConnected) document.body.appendChild(el);
      expect(fire(el).defaultPrevented, `should allow the menu on ${el.tagName}`).toBe(false);
    }
  });

  it("contenteditable=\"false\" opts OUT of editing — the menu is suppressed there", () => {
    const d = document.createElement("div");
    d.setAttribute("contenteditable", "false");
    document.body.appendChild(d);
    expect(fire(d).defaultPrevented).toBe(true);
  });

  it("keeps the native COPY menu for a right-click ON selected text", () => {
    const span = document.createElement("span");
    span.textContent = "copy me out of a read-only pane";
    document.body.appendChild(span);
    selectContentsOf(span);
    stubSelectionRects([box(10, 110, 20, 40)]);

    expect(fire(span, { clientX: 50, clientY: 30 }).defaultPrevented).toBe(false);
  });

  it("a click OUTSIDE the selection's rects gets the suppression, not the page menu", () => {
    const span = document.createElement("span");
    span.textContent = "selected elsewhere";
    document.body.appendChild(span);
    selectContentsOf(span);
    stubSelectionRects([box(10, 110, 20, 40)]);

    // Miss the box on each side in turn — every comparison must actually gate.
    for (const [x, y] of [
      [5, 30], // left of it
      [200, 30], // right of it
      [50, 10], // above it
      [50, 50], // below it
    ]) {
      expect(
        fire(span, { clientX: x, clientY: y }).defaultPrevented,
        `(${x}, ${y}) is outside the selection`,
      ).toBe(true);
    }
  });

  it("a multi-line selection is its per-line rects, not one bounding box", () => {
    const span = document.createElement("span");
    span.textContent = "two\nlines";
    document.body.appendChild(span);
    selectContentsOf(span);
    // Two line boxes; the point is in the SECOND — the loop must reach it.
    stubSelectionRects([box(10, 110, 20, 40), box(10, 60, 40, 60)]);

    expect(fire(span, { clientX: 30, clientY: 50 }).defaultPrevented).toBe(false);
    // …and the dead space right of the short second line (inside the union's
    // bounding box) is NOT the selection — WebKit's hit test says page there.
    expect(fire(span, { clientX: 100, clientY: 50 }).defaultPrevented).toBe(true);
  });

  it("a collapsed selection is no selection", () => {
    const span = document.createElement("span");
    span.textContent = "caret only";
    document.body.appendChild(span);
    window.getSelection()!.removeAllRanges();
    // Even with geometry that WOULD contain the point, collapsed means no menu.
    stubSelectionRects([box(0, 1000, 0, 1000)]);

    expect(fire(span, { clientX: 50, clientY: 50 }).defaultPrevented).toBe(true);
  });

  it("an environment with no selection object at all suppresses calmly", () => {
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(fire(div).defaultPrevented).toBe(true);
  });
});
