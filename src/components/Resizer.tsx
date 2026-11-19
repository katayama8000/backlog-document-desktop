import { getCurrentWindow, type CursorIcon } from "@tauri-apps/api/window";
import { useRef } from "react";
import { SIDEBAR_WIDTH, clampWidth } from "../sidebarWidth";

/**
 * On macOS the native window resets the cursor to the arrow shortly after
 * WebKit applies the CSS one, so the resize cursor only flashes. Setting it
 * on the window keeps it while the pointer is on (or dragging) the handle.
 */
function setWindowCursor(icon: CursorIcon) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  getCurrentWindow().setCursorIcon(icon).catch(() => {});
}

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
      onPointerEnter={() => setWindowCursor("colResize")}
      onPointerLeave={() => {
        if (!drag.current) setWindowCursor("default");
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width, last: width };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (drag.current) drag.current.last = set(drag.current.startWidth + e.clientX - drag.current.startX);
      }}
      onPointerUp={(e) => {
        if (drag.current) onCommit(drag.current.last);
        drag.current = null;
        document.body.classList.remove("resizing");
        if (document.elementFromPoint(e.clientX, e.clientY) !== e.currentTarget) setWindowCursor("default");
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
