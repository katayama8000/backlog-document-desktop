// Small stroke icons drawn in the current text color.

const PATHS = {
  chevron: "M6 4l4 4-4 4",
  plus: "M8 3v10M3 8h10",
  reload: "M13 8a5 5 0 1 1-1.46-3.54M13 3v3h-3",
  settings:
    "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM13 8.8V7.2l-1.6-.4-.5-1.1.9-1.4-1.1-1.1-1.4.9-1.1-.5L7.2 2H5.6l-.4 1.6-1.1.5-1.4-.9-1.1 1.1.9 1.4-.5 1.1L0 7.2v1.6l1.6.4.5 1.1-.9 1.4 1.1 1.1 1.4-.9 1.1.5.4 1.6h1.6l.4-1.6 1.1-.5 1.4.9 1.1-1.1-.9-1.4.5-1.1z",
} as const;

export function Icon({ name, className }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      viewBox={name === "settings" ? "-1.5 0 16 16" : "0 0 16 16"}
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
