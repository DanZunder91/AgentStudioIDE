/**
 * RailResizer — a draggable divider that resizes a side rail (the left and right
 * panels must be resizable).
 *
 * A thin vertical grabber sitting on the seam between a rail and the center. On
 * pointer-drag it updates `leftRailWidth`/`rightRailWidth` in the store (clamped
 * there), which feeds the `.app-shell` grid's `--left-col`/`--right-col` vars.
 *
 * Uses window-level move/up listeners (not pointer capture) so the drag keeps
 * tracking even when the cursor leaves the 6px strip — robust and jsdom-testable.
 */

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

    // While dragging, kill text selection + force the resize cursor GLOBALLY —
    // otherwise sweeping the pointer over the rails selects their labels as the
    // pointer passes over them. Done via a
    // body class so the CSS can use BOTH `-webkit-user-select` (WKWebView needs the
    // prefix — the unprefixed property alone did not take) and `user-select`, with
    // `!important` on every descendant.
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
