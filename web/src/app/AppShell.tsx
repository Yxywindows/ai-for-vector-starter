import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import {
  DEFAULT_SIDES,
  clampFloat,
  type DockablePanel,
  type FloatPosition,
  type PanelSide,
  type WorkspaceLayout,
} from './workspaceLayout'
import { Monogram } from './BrandMark'

export type ResizablePanel = 'sidebar' | 'inspector' | 'drawer'

/** Where a drag or a dock button puts a panel. */
export type PanelPlacement = { side: PanelSide } | { float: FloatPosition }

/** Drop a dragged panel this close to a stage edge and it docks there. */
const DOCK_ZONE_PX = 72
/** Pointer travel before a drag counts as a drag, not a sloppy click. */
const DRAG_THRESHOLD_PX = 6

interface AppShellProps {
  sidebar: ReactNode
  map: ReactNode
  bottom: ReactNode
  inspector?: ReactNode
  /** Shown in the header next to the wordmark, e.g. the project switcher. */
  context?: ReactNode
  /** Extra header controls, e.g. the layout preset menu. */
  tools?: ReactNode
  /** Live readouts for the bottom status strip (coordinates, zoom, …). */
  status?: ReactNode
  /** Panel layout is owned by the page so it can persist per project. */
  layout: WorkspaceLayout
  onToggleSidebar: () => void
  onToggleInspector: () => void
  onToggleTable: () => void
  onPanelResize: (panel: ResizablePanel, pixels: number) => void
  /** R9: dock to a side or float at a stage-relative position. */
  onPanelMove: (panel: DockablePanel, placement: PanelPlacement) => void
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

interface DragState {
  panel: DockablePanel
  /** Panel's viewport position while dragging. */
  x: number
  y: number
  /** Pointer offset inside the title bar, so the panel doesn't jump. */
  grabX: number
  grabY: number
  started: boolean
  startClientX: number
  startClientY: number
  /** Stage geometry, captured once at drag start (it can't move mid-drag). */
  stage: { left: number; top: number; width: number; height: number }
}

interface PanelFrameProps {
  panel: DockablePanel
  title: string
  hidden: boolean
  floating: boolean
  dragging: boolean
  side: PanelSide
  stackRole: 'first' | 'second' | null
  width?: number
  floatPosition?: FloatPosition
  children: ReactNode
  onClose: () => void
  onMove: (panel: DockablePanel, placement: PanelPlacement) => void
  onResize: (panel: ResizablePanel, pixels: number) => void
  onDragStart: (state: DragState) => void
}

/**
 * A workspace panel: slim title bar with a drag grip, dock/detach
 * controls and a close button; the feature content below. The title bar
 * is the pointer-drag surface; the buttons are the keyboard path to the
 * same placements. Frames are stable siblings of the stage — docked or
 * floating is purely CSS — so panel state and pointer capture survive
 * every move.
 */
function PanelFrame({
  panel,
  title,
  hidden,
  floating,
  dragging,
  side,
  stackRole,
  width,
  floatPosition,
  children,
  onClose,
  onMove,
  onResize,
  onDragStart,
}: PanelFrameProps) {
  const frameRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const element = frameRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (element.offsetWidth > 0) onResize(panel, element.offsetWidth)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [panel, onResize])

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    // Buttons keep their click semantics; only the bar itself drags.
    if ((event.target as HTMLElement).closest('button')) return
    const rect = frameRef.current?.getBoundingClientRect()
    const stage = frameRef.current?.parentElement?.getBoundingClientRect()
    if (!rect || !stage) return
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Capture is best-effort; the drag also works from bubbled moves.
    }
    onDragStart({
      panel,
      x: rect.left,
      y: rect.top,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      started: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
      stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },
    })
  }

  const detach = () => {
    const rect = frameRef.current?.getBoundingClientRect()
    const stage = frameRef.current?.parentElement?.getBoundingClientRect()
    // Nudge inward from the docked spot, but keep the whole panel on stage.
    const rawX = (rect?.left ?? 48) - (stage?.left ?? 0) + 24
    const rawY = (rect?.top ?? 0) - (stage?.top ?? 0) + 24
    const maxX = (stage?.width ?? 1200) - (rect?.width ?? 320) - 12
    const maxY = (stage?.height ?? 800) - 160
    onMove(panel, {
      float: {
        x: Math.max(12, Math.min(rawX, maxX)),
        y: Math.max(12, Math.min(rawY, maxY)),
      },
    })
  }

  const classes = ['float-panel', `float-panel--${panel}`]
  classes.push(floating ? 'float-panel--floating' : `float-panel--dock-${side}`)
  if (dragging) classes.push('float-panel--dragging')
  if (stackRole) classes.push(`float-panel--stack-${stackRole}`)

  return (
    <section
      ref={frameRef}
      className={classes.join(' ')}
      hidden={hidden}
      style={{
        ...(width ? { width } : undefined),
        ...(floating && floatPosition
          ? { left: floatPosition.x, top: floatPosition.y }
          : undefined),
      }}
      aria-label={`${title} panel`}
    >
      <div
        className="panel-titlebar"
        onPointerDown={beginDrag}
        data-testid={`panel-handle-${panel}`}
      >
        <span className="panel-titlebar__grip" aria-hidden="true">
          ⠿
        </span>
        <span className="panel-titlebar__title">{title}</span>
        <span className="panel-titlebar__actions">
          {floating ? (
            <button
              type="button"
              className="icon-btn icon-btn--panel"
              aria-label={`Dock ${title} panel`}
              title="Dock"
              onClick={() => onMove(panel, { side })}
            >
              <PanelIcon side={side} />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="icon-btn icon-btn--panel"
                aria-label={`Move ${title} panel to the ${side === 'left' ? 'right' : 'left'}`}
                title={side === 'left' ? 'Dock right' : 'Dock left'}
                onClick={() => onMove(panel, { side: side === 'left' ? 'right' : 'left' })}
              >
                <PanelIcon side={side === 'left' ? 'right' : 'left'} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--panel"
                aria-label={`Detach ${title} panel`}
                title="Detach"
                onClick={detach}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="4.5" y="1.5" width="8" height="8" rx="1" stroke="currentColor" />
                  <path d="M1.5 5.5v6a1 1 0 0 0 1 1h6" stroke="currentColor" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            className="icon-btn icon-btn--panel"
            aria-label={`Close ${title} panel`}
            title="Close"
            onClick={onClose}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </span>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  )
}

/**
 * Workspace chrome: the map is the whole canvas; the layers panel and
 * inspector dock on either side (splitting the height when they share
 * one), detach to float anywhere over the map, and collapse; the
 * attribute table is a drawer; a status strip carries live readouts.
 * Panels hide with the `hidden` attribute rather than unmounting so
 * their state (dialogs, style drafts) survives a collapse. Docked
 * panels stay user-resizable (CSS resize); observed sizes flow up so
 * the page can persist them per project. Dragging a panel by its title
 * bar detaches it; dropping near a stage edge docks it there.
 */
export function AppShell({
  sidebar,
  map,
  bottom,
  inspector,
  context,
  tools,
  status,
  layout,
  onToggleSidebar,
  onToggleInspector,
  onToggleTable,
  onPanelResize,
  onPanelMove,
}: AppShellProps) {
  const drawerRef = useRef<HTMLElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  useEffect(() => {
    const element = drawerRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (element.offsetHeight > 0) onPanelResize('drawer', element.offsetHeight)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onPanelResize])

  const onDragMove = (event: React.PointerEvent) => {
    if (!drag) return
    const travel =
      Math.abs(event.clientX - drag.startClientX) + Math.abs(event.clientY - drag.startClientY)
    if (!drag.started && travel < DRAG_THRESHOLD_PX) return
    setDrag({
      ...drag,
      started: true,
      x: event.clientX - drag.grabX,
      y: event.clientY - drag.grabY,
    })
  }

  const onDragEnd = (event: React.PointerEvent) => {
    if (!drag) return
    setDrag(null)
    if (!drag.started) return
    const { stage } = drag
    if (event.clientX - stage.left < DOCK_ZONE_PX) {
      onPanelMove(drag.panel, { side: 'left' })
      return
    }
    if (stage.left + stage.width - event.clientX < DOCK_ZONE_PX) {
      onPanelMove(drag.panel, { side: 'right' })
      return
    }
    onPanelMove(drag.panel, {
      float: clampFloat(
        { x: drag.x - stage.left, y: drag.y - stage.top },
        { width: stage.width, height: stage.height },
        320,
      ),
    })
  }

  const sides: Record<DockablePanel, PanelSide> = {
    sidebar: layout.sidebarSide ?? DEFAULT_SIDES.sidebar,
    inspector: layout.inspectorSide ?? DEFAULT_SIDES.inspector,
  }
  const floats: Record<DockablePanel, FloatPosition | null> = {
    sidebar: layout.sidebarFloat ?? null,
    inspector: layout.inspectorFloat ?? null,
  }
  const open: Record<DockablePanel, boolean> = {
    sidebar: layout.sidebarOpen,
    inspector: layout.inspectorOpen,
  }

  // Both panels docked open on one side split its height instead of
  // overlapping; with only two panels the pairing is fixed.
  const docked = (panel: DockablePanel) =>
    open[panel] && !floats[panel] && !(drag?.started && drag.panel === panel)
  const stacked =
    docked('sidebar') && docked('inspector') && sides.sidebar === sides.inspector

  const renderPanel = (panel: DockablePanel) => {
    const content = panel === 'sidebar' ? sidebar : inspector
    if (!content) return null
    const dragging = Boolean(drag?.started && drag.panel === panel)
    const floatPosition =
      dragging && drag
        ? { x: drag.x - drag.stage.left, y: drag.y - drag.stage.top }
        : (floats[panel] ?? undefined)
    return (
      <PanelFrame
        panel={panel}
        title={panel === 'sidebar' ? 'Layers' : 'Inspector'}
        hidden={!open[panel]}
        floating={Boolean(floats[panel]) || dragging}
        dragging={dragging}
        side={sides[panel]}
        stackRole={stacked ? (panel === 'sidebar' ? 'first' : 'second') : null}
        width={panel === 'sidebar' ? layout.sidebarWidth : layout.inspectorWidth}
        floatPosition={floatPosition}
        onClose={panel === 'sidebar' ? onToggleSidebar : onToggleInspector}
        onMove={onPanelMove}
        onResize={onPanelResize}
        onDragStart={setDrag}
      >
        {content}
      </PanelFrame>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <Link to="/" className="platform__brand" aria-label="返回主舞台">
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
          {tools}
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
        onPointerMove={drag ? onDragMove : undefined}
        onPointerUp={drag ? onDragEnd : undefined}
      >
        <div className="app-shell__map">{map}</div>

        {drag?.started ? (
          <>
            <div className="app-shell__dockhint app-shell__dockhint--left" aria-hidden="true" />
            <div className="app-shell__dockhint app-shell__dockhint--right" aria-hidden="true" />
          </>
        ) : null}

        {renderPanel('sidebar')}
        {renderPanel('inspector')}

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
