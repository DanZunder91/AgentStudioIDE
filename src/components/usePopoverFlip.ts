/** Keep an anchored popover on screen: under its trigger's LEFT edge, flipped to the RIGHT edge
 * (`flipClass`) past the nearest clipping ancestor (or the window). A DOM class, not React state:
 * it measures the rendered box, and state from a layout effect would render twice. */

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
