/** jsdom has no layout, so the rect is stubbed: past the right edge ⇒ flip class; fits ⇒ none; closed ⇒ untouched. */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { clipRight, usePopoverFlip } from "./usePopoverFlip";

const refAt = (right: number) => {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ right } as DOMRect);
  return { current: el };
};

describe("usePopoverFlip", () => {
  it("adds the flip class when the open popover runs past the window's right edge", () => {
    const ref = refAt(window.innerWidth + 50);
    renderHook(() => usePopoverFlip(true, ref, "flip"));
    expect(ref.current.classList.contains("flip")).toBe(true);
  });

  it("removes it when the popover fits", () => {
    const ref = refAt(window.innerWidth - 10);
    ref.current.classList.add("flip");
    renderHook(() => usePopoverFlip(true, ref, "flip"));
    expect(ref.current.classList.contains("flip")).toBe(false);
  });

  it("does nothing while closed", () => {
    const ref = refAt(window.innerWidth + 50);
    renderHook(() => usePopoverFlip(false, ref, "flip"));
    expect(ref.current.classList.contains("flip")).toBe(false);
  });
});

describe("clipRight", () => {
  it("is the nearest clipping ancestor's right edge, capped by the window", () => {
    const pane = document.createElement("div");
    pane.style.overflow = "hidden";
    pane.getBoundingClientRect = () => ({ right: 600 } as DOMRect);
    const inner = document.createElement("div");
    const pop = document.createElement("div");
    inner.appendChild(pop);
    pane.appendChild(inner);
    document.body.appendChild(pane);
    expect(clipRight(pop)).toBe(Math.min(600, window.innerWidth));
    pane.remove();
  });

  it("is the window's edge when nothing clips", () => {
    const pop = document.createElement("div");
    document.body.appendChild(pop);
    expect(clipRight(pop)).toBe(window.innerWidth);
    pop.remove();
  });
});
