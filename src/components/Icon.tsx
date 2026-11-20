// Small stroke icons drawn in the current text color.

const PATHS = {
  chevron: "M6 4l4 4-4 4",
  plus: "M8 3v10M3 8h10",
  reload: "M13 8a5 5 0 1 1-1.46-3.54M13 3v3h-3",
  // An 8-tooth gear around a hole, symmetric about the center.
  settings:
    "M6.72 2.86L7.03 1.07L8.97 1.07L9.28 2.86L10.73 3.46L12.21 2.41L13.59 3.79L12.54 5.27L13.14 6.72L14.93 7.03L14.93 8.97L13.14 9.28L12.54 10.73L13.59 12.21L12.21 13.59L10.73 12.54L9.28 13.14L8.97 14.93L7.03 14.93L6.72 13.14L5.27 12.54L3.79 13.59L2.41 12.21L3.46 10.73L2.86 9.28L1.07 8.97L1.07 7.03L2.86 6.72L3.46 5.27L2.41 3.79L3.79 2.41L5.27 3.46ZM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
} as const;

export function Icon({ name, className }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
