/**
 * jsdom drag-and-drop helpers.
 *
 * Three jsdom facts make the naive version of a DnD test worthless, and every
 * helper here exists to defeat exactly one of them:
 *
 *   1. **No layout engine** — every `getBoundingClientRect()` is 0x0, so
 *      `zoneFor` takes its degenerate branch and returns "center" for every
 *      coordinate. → `stubRect`.
 *   2. **No `DragEvent`** — `window.DragEvent` is undefined, so RTL falls back
 *      to a plain `Event`, which silently drops `clientX`/`clientY` (verified:
 *      they arrive as `undefined`) and `relatedTarget` from the init.
 *      → `fireDragAt`, `fireDragLeave`.
 *   3. **No `DataTransfer`** — → `makeDataTransfer`.
 *
 * Each one alone makes `fireEvent.dragOver(pane, { clientX: 390 })` assert
 * "center" no matter where you aim: green for the wrong reason.
 *
 * The real-pixel half of this contract belongs to the browser tier
 * (`*.browser.test.tsx`), which needs none of this scaffolding because Chromium
 * implements all three.
 */

import { createEvent, fireEvent } from "@testing-library/react";

/** A `DataTransfer` stand-in: jsdom ships no implementation. */
export function makeDataTransfer(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    // A GETTER, not a snapshot. A real `DataTransfer` recomputes `types` on every
    // `setData`, and `types` is what every `dragover`/`drop` guard in this app reads —
    // so a snapshot taken at construction makes "the handler wrote the marker type"
    // untestable, and quietly turns a self-drop guard into a test that cannot fail.
    get types() {
      return [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => data.set(type, value),
    dropEffect: "",
    effectAllowed: "",
  };
}

export type FakeDataTransfer = ReturnType<typeof makeDataTransfer>;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pin an element's rect, as if it had been laid out. */
export function stubRect(el: HTMLElement, rect: Rect): HTMLElement {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

/**
 * Fire a drag event carrying real coordinates.
 *
 * The coordinates are defined onto the event explicitly because RTL's plain
 * `Event` fallback drops them from the init — without this every assertion
 * about *which zone* is vacuous.
 */
export function fireDragAt(
  el: HTMLElement,
  type: "dragOver" | "drop" | "dragStart" | "dragEnd",
  [clientX, clientY]: readonly [number, number],
  dataTransfer: FakeDataTransfer,
): void {
  const event = createEvent[type](el, { dataTransfer });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(el, event);
}

/**
 * Fire a dragLeave carrying a real `relatedTarget`.
 *
 * jsdom implements no `DragEvent`, so RTL falls back to plain `Event` and
 * silently DROPS a `relatedTarget` passed in the init — which would make
 * `Pane`'s `currentTarget.contains(relatedTarget)` guard see `null` and always
 * take the "left the pane" branch. That would let the descendant-crossing test
 * pass without ever exercising the guard, so define the property explicitly.
 */
export function fireDragLeave(el: HTMLElement, relatedTarget: Node | null): void {
  const event = createEvent.dragLeave(el);
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  fireEvent(el, event);
}
