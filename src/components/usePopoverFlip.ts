/**
 * Keep an anchored popover on screen: it opens under its trigger's LEFT edge, and flips to the
 * RIGHT edge (by adding `flipClass`) when that would run past the window's right side. Both
 * directions matter — anchored right, the Columns menu ran off the panel's
 * left edge; anchored left, the Network host picker ran off the window's right edge and
 * WebDriver read its rows as blank. "Past the edge" means past the nearest ancestor that clips
 * (`overflow` other than visible — a pane is one), or the window when none does: the first fix
 * checked only the window and the pane still clipped it. A DOM class, not React state: this is a
 * measurement of the rendered box, and setting state from a layout effect would render twice.
 */

/** The right edge the popover must stay inside: the nearest clipping ancestor's, else the window's. */
export function clipRight(el: HTMLElement): number {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const o = getComputedStyle(a);
    if ([o.overflow, o.overflowX, o.overflowY].some((v) => v !== "" && v !== "visible")) {
      return Math.min(a.getBoundingClientRect().right, window.innerWidth);
    }
  }
  return window.innerWidth;
}

import { useLayoutEffect } from "react";

export function usePopoverFlip(open: boolean, pop: React.RefObject<HTMLElement | null>, flipClass: string): void {
  useLayoutEffect(() => {
    if (!open) return;
    // The popover is rendered whenever `open` is true, so the ref is attached here.
    const el = pop.current as HTMLElement;
    el.classList.remove(flipClass);
    el.classList.toggle(flipClass, el.getBoundingClientRect().right > clipRight(el));
  }, [open, pop, flipClass]);
}
