import type { ReactNode } from 'react'

interface AppShellProps {
  sidebar: ReactNode
  map: ReactNode
  bottom: ReactNode
  inspector?: ReactNode
  /** Shown in the header next to the wordmark, e.g. the open project's name. */
  context?: ReactNode
}

/** The graticule monogram: a globe reduced to its grid of meridians and parallels. */
function Monogram() {
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

export function AppShell({ sidebar, map, bottom, inspector, context }: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <Monogram />
        <span className="app-header__name">Graticule</span>
        {context ? (
          <>
            <span className="app-header__divider" aria-hidden="true" />
            <span className="app-header__project">{context}</span>
          </>
        ) : null}
      </header>
      <aside className="app-shell__sidebar">{sidebar}</aside>
      <main className="app-shell__main">
        <div className="app-shell__map">{map}</div>
        <div className="app-shell__bottom">{bottom}</div>
      </main>
      {inspector ? <aside className="app-shell__inspector">{inspector}</aside> : null}
    </div>
  )
}
