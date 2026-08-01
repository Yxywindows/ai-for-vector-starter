import { type ReactNode, useState } from 'react'

interface AppShellProps {
  sidebar: ReactNode
  map: ReactNode
  bottom: ReactNode
  inspector?: ReactNode
  /** Shown in the header next to the wordmark, e.g. the open project's name. */
  context?: ReactNode
  /** Live readouts for the bottom status strip (coordinates, zoom, …). */
  status?: ReactNode
  /** The attribute drawer is controlled by the app so selection can open it. */
  tableOpen: boolean
  onToggleTable: () => void
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

function PanelIcon({ side }: { side: 'left' | 'right' }) {
  const x = side === 'left' ? 2.5 : 8.5
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" />
      <rect x={x} y="3" width="3" height="8" rx="0.5" fill="currentColor" opacity="0.55" />
    </svg>
  )
}

function TableIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" />
      <line x1="1.5" y1="8" x2="12.5" y2="8" stroke="currentColor" />
      <line x1="7" y1="8" x2="7" y2="12" stroke="currentColor" />
    </svg>
  )
}

/**
 * Modern GIS chrome: the map is the whole canvas; the layers panel and
 * inspector float over it and collapse; the attribute table is a drawer;
 * a status strip carries live readouts. Panels hide with the `hidden`
 * attribute rather than unmounting so their state (dialogs, style drafts)
 * survives a collapse.
 */
export function AppShell({
  sidebar,
  map,
  bottom,
  inspector,
  context,
  status,
  tableOpen,
  onToggleTable,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)

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

        <div className="app-header__controls">
          <button
            type="button"
            className="icon-btn"
            aria-pressed={sidebarOpen}
            aria-label="Toggle layers panel"
            title="Layers panel"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <PanelIcon side="left" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={tableOpen}
            aria-label="Toggle attribute table"
            title="Attribute table"
            onClick={onToggleTable}
          >
            <TableIcon />
          </button>
          {inspector ? (
            <button
              type="button"
              className="icon-btn"
              aria-pressed={inspectorOpen}
              aria-label="Toggle inspector"
              title="Inspector"
              onClick={() => setInspectorOpen((open) => !open)}
            >
              <PanelIcon side="right" />
            </button>
          ) : null}
        </div>
      </header>

      <div className={tableOpen ? 'app-shell__stage app-shell__stage--drawer' : 'app-shell__stage'}>
        <div className="app-shell__map">{map}</div>

        <aside className="float-panel float-panel--left" hidden={!sidebarOpen}>
          {sidebar}
        </aside>

        {inspector ? (
          <aside className="float-panel float-panel--right" hidden={!inspectorOpen}>
            {inspector}
          </aside>
        ) : null}

        <section className="app-shell__drawer" aria-label="Attribute table" hidden={!tableOpen}>
          {bottom}
        </section>
      </div>

      <footer className="app-shell__status">{status}</footer>
    </div>
  )
}
