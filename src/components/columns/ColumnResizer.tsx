/**
 * The drag handle on a header cell's right edge. Pointer drag resizes; ←/→ nudge by 10 px
 * (Shift: 40) for keyboard users; double-click resets to the default width.
 */

import { useRef } from "react";

import { resetColumnWidth, setColumnWidth, type ColumnDef } from "./columnLayout";
import "./columns.css";

export function ColumnResizer({
  viewKey, def, width,
}: { viewKey: string; def: ColumnDef; width: number }): React.JSX.Element {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${def.label} column`}
      aria-valuenow={width}
      tabIndex={0}
      className="col-resizer"
      data-testid={`col-resizer-${def.id}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        drag.current = { x: e.clientX, w: width };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setColumnWidth(viewKey, def, drag.current.w + (e.clientX - drag.current.x));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        resetColumnWidth(viewKey, def.id);
      }}
      onKeyDown={(e) => {
        // A focused handle owns the keyboard: no key reaches the table's own shortcuts
        // (in the Network table `c` would otherwise clear every flow).
        e.stopPropagation();
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowRight") setColumnWidth(viewKey, def, width + step);
        else if (e.key === "ArrowLeft") setColumnWidth(viewKey, def, width - step);
        else return;
        e.preventDefault();
      }}
    />
  );
}
