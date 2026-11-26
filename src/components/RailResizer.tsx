/** Draggable divider resizing a side rail via the store's (clamped) rail widths. Window-level
 * move/up listeners, not pointer capture, keep tracking off the 6px strip, jsdom-testable. */

import { useAppStore } from "../app/store";

export function RailResizer({ side }: { side: "left" | "right" }): React.JSX.Element {
  const setLeftRailWidth = useAppStore((s) => s.uiActions.setLeftRailWidth);
  const setRightRailWidth = useAppStore((s) => s.uiActions.setRightRailWidth);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth =
      side === "left"
        ? useAppStore.getState().leftRailWidth
        : useAppStore.getState().rightRailWidth;

    // Kill text selection and force the cursor globally while dragging, via a body class so CSS
    // can set `-webkit-user-select` (WKWebView needs the prefix) and `user-select`, `!important`
    // on every descendant.
    document.body.classList.add("is-resizing");

    const onMove = (ev: PointerEvent | MouseEvent) => {
      const dx = ev.clientX - startX;
      // The left rail grows as you drag right; the right rail grows as you drag
      // left (the seam moves toward the center in both cases).
      const next = side === "left" ? startWidth + dx : startWidth - dx;
      if (side === "left") setLeftRailWidth(next);
      else setRightRailWidth(next);
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className={`rail-resizer rail-resizer--${side}`}
      data-testid={`rail-resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      onPointerDown={onPointerDown}
    />
  );
}
