// Sidebar width: clamped, and remembered between launches.

export const SIDEBAR_WIDTH = { min: 200, max: 520, initial: 280 } as const;

const KEY = "sidebarWidth";

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.initial;
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

export function loadWidth(): number {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === null ? SIDEBAR_WIDTH.initial : clampWidth(Number(saved));
  } catch {
    return SIDEBAR_WIDTH.initial;
  }
}

export function saveWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    // Storage unavailable: the width just isn't remembered.
  }
}
