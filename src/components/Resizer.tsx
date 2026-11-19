import { useRef } from "react";
import { SIDEBAR_WIDTH, clampWidth } from "../sidebarWidth";

type Props = { width: number; onChange: (width: number) => void; onCommit: (width: number) => void };

/** Drag handle on the sidebar's right edge. Arrow keys move it; double-click resets. */
export function Resizer({ width, onChange, onCommit }: Props) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const set = (next: number) => {
    const clamped = clampWidth(next);
    onChange(clamped);
    return clamped;
  };

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width, last: width };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (drag.current) drag.current.last = set(drag.current.startWidth + e.clientX - drag.current.startX);
      }}
      onPointerUp={() => {
        if (drag.current) onCommit(drag.current.last);
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onDoubleClick={() => onCommit(set(SIDEBAR_WIDTH.initial))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowLeft") onCommit(set(width - step));
        else if (e.key === "ArrowRight") onCommit(set(width + step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
