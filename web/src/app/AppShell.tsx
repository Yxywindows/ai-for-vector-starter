import { type ReactNode, useEffect, useRef } from 'react'
import { Link } from 'react-router'

import type { WorkspaceLayout } from './workspaceLayout'
import { Monogram } from './PlatformShell'

export type ResizablePanel = 'sidebar' | 'inspector' | 'drawer'

interface AppShellProps {
  sidebar: ReactNode
  map: ReactNode
  bottom: ReactNode
  inspector?: ReactNode
  /** Shown in the header next to the wordmark, e.g. the project switcher. */
  context?: ReactNode
  /** Live readouts for the bottom status strip (coordinates, zoom, …). */
  status?: ReactNode
  /** Panel layout is owned by the page so it can persist per project. */
  layout: WorkspaceLayout
  onToggleSidebar: () => void
  onToggleInspector: () => void
  onToggleTable: () => void
  onPanelResize: (panel: ResizablePanel, pixels: number) => void
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
 * Workspace chrome: the map is the whole canvas; the layers panel and
 * inspector float over it and collapse; the attribute table is a drawer;
 * a status strip carries live readouts. Panels hide with the `hidden`
 * attribute rather than unmounting so their state (dialogs, style drafts)
 * survives a collapse. Panels are user-resizable (CSS resize); observed
 * sizes flow up so the page can persist them per project.
 */
export function AppShell({
  sidebar,
  map,
  bottom,
  inspector,
  context,
  status,
  layout,
  onToggleSidebar,
  onToggleInspector,
  onToggleTable,
  onPanelResize,
}: AppShellProps) {
  const sidebarRef = useRef<HTMLElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const drawerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const watched: Array<[HTMLElement | null, ResizablePanel, 'width' | 'height']> = [
      [sidebarRef.current, 'sidebar', 'width'],
      [inspectorRef.current, 'inspector', 'width'],
      [drawerRef.current, 'drawer', 'height'],
    ]
    const observers = watched.map(([element, panel, dimension]) => {
      if (!element) return null
      const observer = new ResizeObserver(() => {
        const value = dimension === 'width' ? element.offsetWidth : element.offsetHeight
        if (value > 0) onPanelResize(panel, value)
      })
      observer.observe(element)
      return observer
    })
    return () => observers.forEach((observer) => observer?.disconnect())
  }, [onPanelResize])

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <Link to="/" className="platform__brand" aria-label="Back to dashboard">
          <Monogram />
          <span className="app-header__name">Graticule</span>
        </Link>
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
            aria-pressed={layout.sidebarOpen}
            aria-label="Toggle layers panel"
            title="Layers panel"
            onClick={onToggleSidebar}
          >
            <PanelIcon side="left" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={layout.tableOpen}
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
              aria-pressed={layout.inspectorOpen}
              aria-label="Toggle inspector"
              title="Inspector"
              onClick={onToggleInspector}
            >
              <PanelIcon side="right" />
            </button>
          ) : null}
        </div>
      </header>

      <div
        className={
          layout.tableOpen ? 'app-shell__stage app-shell__stage--drawer' : 'app-shell__stage'
        }
        // Custom drawer height flows through the CSS var so the zoom
        // control offset and panel max-heights track it too.
        style={
          layout.drawerHeight
            ? ({ '--h-drawer': `${layout.drawerHeight}px` } as React.CSSProperties)
            : undefined
        }
      >
        <div className="app-shell__map">{map}</div>

        <aside
          ref={sidebarRef}
          className="float-panel float-panel--left"
          style={layout.sidebarWidth ? { width: layout.sidebarWidth } : undefined}
          hidden={!layout.sidebarOpen}
        >
          {sidebar}
        </aside>

        {inspector ? (
          <aside
            ref={inspectorRef}
            className="float-panel float-panel--right"
            style={layout.inspectorWidth ? { width: layout.inspectorWidth } : undefined}
            hidden={!layout.inspectorOpen}
          >
            {inspector}
          </aside>
        ) : null}

        <section
          ref={drawerRef}
          className="app-shell__drawer"
          aria-label="Attribute table"
          hidden={!layout.tableOpen}
        >
          {bottom}
        </section>
      </div>

      <footer className="app-shell__status">{status}</footer>
    </div>
  )
}
