/** jsdom DnD helpers, one per jsdom gap: no layout (`stubRect`); no `DragEvent`, so RTL drops
 * `clientX`/`clientY`/`relatedTarget` (`fireDragAt`, `fireDragLeave`); no `DataTransfer`
 * (`makeDataTransfer`). Without them a zone test asserts "center" anywhere. */

import { createEvent, fireEvent } from "@testing-library/react";

/** A `DataTransfer` stand-in: jsdom ships no implementation. */
export function makeDataTransfer(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    // A GETTER: a real `DataTransfer` recomputes `types` on each `setData`, and the dragover/drop
    // guards read `types`; a snapshot would make a self-drop guard's test unable to fail.
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

/** Coordinates are defined onto the event explicitly: RTL's plain `Event` fallback drops them. */
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

/** `relatedTarget` is defined explicitly: RTL's plain `Event` drops it, and `Pane`'s
 * `contains(relatedTarget)` guard would then always take the "left the pane" branch. */
export function fireDragLeave(el: HTMLElement, relatedTarget: Node | null): void {
  const event = createEvent.dragLeave(el);
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  fireEvent(el, event);
}
