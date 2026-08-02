import { Link, NavLink, Outlet } from 'react-router'

/** The graticule monogram, shared with the workspace header. */
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

const NAV = [
  { to: '/', label: 'Dashboard', exact: true },
  { to: '/projects', label: 'Projects' },
  { to: '/data', label: 'Data' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/analysis', label: 'Analysis' },
  { to: '/exports', label: 'Exports' },
]

/** Last workspace the user had open — the rail's "Map" jump target. */
export function lastProjectId(): string | null {
  return localStorage.getItem('graticule:lastProject')
}

/**
 * The page shell: nav rail + topbar around routed task pages. The map
 * workspace route keeps its own chrome — this shell never initializes any
 * map machinery, by design (IA plan §3).
 */
export function PlatformShell() {
  const last = lastProjectId()

  return (
    <div className="platform">
      <header className="platform__topbar">
        <Link to="/" className="platform__brand">
          <Monogram />
          <span className="app-header__name">Graticule</span>
        </Link>
        {last ? (
          <Link className="platform__map-jump" to={`/projects/${last}/map`}>
            Open map workspace ▸
          </Link>
        ) : null}
      </header>
      <nav className="platform__rail" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              isActive ? 'platform__nav platform__nav--active' : 'platform__nav'
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main className="platform__content">
        <Outlet />
      </main>
    </div>
  )
}
