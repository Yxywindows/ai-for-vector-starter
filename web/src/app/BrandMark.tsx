/** Lightweight shared identity. Importing it never initializes either renderer. */
export function Monogram() {
  return (
    <svg
      className="app-header__mark"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="7.4" />
      <ellipse cx="9" cy="9" rx="3.4" ry="7.4" />
      <line x1="1.6" y1="9" x2="16.4" y2="9" />
      <path d="M 2.6 5.4 A 11 11 0 0 1 15.4 5.4" />
      <path d="M 2.6 12.6 A 11 11 0 0 0 15.4 12.6" />
    </svg>
  )
}
