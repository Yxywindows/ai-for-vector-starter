import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from './AppShell'
import { DEFAULT_LAYOUT, type WorkspaceLayout } from './workspaceLayout'

const STAGE_RECT = {
  left: 0,
  top: 0,
  right: 1200,
  bottom: 800,
  width: 1200,
  height: 800,
  x: 0,
  y: 0,
  toJSON: () => ({}),
}

function renderShell(layout: Partial<WorkspaceLayout> = {}) {
  const onPanelMove = vi.fn()
  const onToggleSidebar = vi.fn()
  const onToggleInspector = vi.fn()
  render(
    <MemoryRouter>
      <AppShell
        sidebar={<div>layer list</div>}
        inspector={<div>style editor</div>}
        map={<div>the map</div>}
        bottom={<div>attributes</div>}
        layout={{ ...DEFAULT_LAYOUT, ...layout }}
        onToggleSidebar={onToggleSidebar}
        onToggleInspector={onToggleInspector}
        onToggleTable={vi.fn()}
        onPanelResize={vi.fn()}
        onPanelMove={onPanelMove}
      />
    </MemoryRouter>,
  )
  return { onPanelMove, onToggleSidebar, onToggleInspector }
}

const panelOf = (label: string) => screen.getByLabelText(`${label} panel`)

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(STAGE_RECT)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AppShell panel docking (R9)', () => {
  it('docks panels to their default sides with title bars', () => {
    renderShell()
    expect(panelOf('Layers').className).toContain('float-panel--dock-left')
    expect(panelOf('Inspector').className).toContain('float-panel--dock-right')
    expect(screen.getByText('Layers')).toBeInTheDocument()
    expect(screen.getByText('Inspector')).toBeInTheDocument()
  })

  it('moves a panel to the other side from its title bar button', async () => {
    const { onPanelMove } = renderShell()
    await userEvent.click(
      screen.getByRole('button', { name: 'Move Layers panel to the right' }),
    )
    expect(onPanelMove).toHaveBeenCalledWith('sidebar', { side: 'right' })
  })

  it('detaches a panel into a clamped floating position', async () => {
    const { onPanelMove } = renderShell()
    await userEvent.click(screen.getByRole('button', { name: 'Detach Inspector panel' }))
    // Mocked rects make the panel as wide as the stage, so the clamp
    // pins x to the 12px minimum; y keeps the +24 nudge.
    expect(onPanelMove).toHaveBeenCalledWith('inspector', {
      float: { x: 12, y: 24 },
    })
  })

  it('renders a floating panel at its stored position and can re-dock it', async () => {
    const { onPanelMove } = renderShell({ inspectorFloat: { x: 340, y: 120 } })
    const inspector = panelOf('Inspector')
    expect(inspector.className).toContain('float-panel--floating')
    expect(inspector.style.left).toBe('340px')
    expect(inspector.style.top).toBe('120px')

    await userEvent.click(screen.getByRole('button', { name: 'Dock Inspector panel' }))
    expect(onPanelMove).toHaveBeenCalledWith('inspector', { side: 'right' })
  })

  it('splits a side when both panels dock on it', () => {
    renderShell({ sidebarSide: 'right' })
    expect(panelOf('Layers').className).toContain('float-panel--stack-first')
    expect(panelOf('Inspector').className).toContain('float-panel--stack-second')
  })

  it('keeps a closed panel mounted but hidden, and closes from the title bar', async () => {
    const { onToggleSidebar } = renderShell({ inspectorOpen: false })
    expect(screen.getByText('style editor')).not.toBeVisible()
    expect(screen.getByText('layer list')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Close Layers panel' }))
    expect(onToggleSidebar).toHaveBeenCalled()
  })

  it('drag-drops a panel into a floating position', () => {
    const { onPanelMove } = renderShell()
    const handle = screen.getByTestId('panel-handle-sidebar')
    const stage = document.querySelector('.app-shell__stage')!

    fireEvent.pointerDown(handle, { clientX: 100, clientY: 50, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 600, clientY: 400, pointerId: 1 })
    // Mid-drag the panel floats under the pointer and edge hints show.
    expect(panelOf('Layers').className).toContain('float-panel--dragging')
    expect(document.querySelector('.app-shell__dockhint--left')).not.toBeNull()

    fireEvent.pointerUp(stage, { clientX: 600, clientY: 400, pointerId: 1 })
    expect(onPanelMove).toHaveBeenCalledWith('sidebar', { float: { x: 500, y: 350 } })
  })

  it('drag-drops near an edge to dock there instead', () => {
    const { onPanelMove } = renderShell()
    const handle = screen.getByTestId('panel-handle-sidebar')
    const stage = document.querySelector('.app-shell__stage')!

    fireEvent.pointerDown(handle, { clientX: 100, clientY: 50, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 1180, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: 1180, clientY: 300, pointerId: 1 })
    expect(onPanelMove).toHaveBeenCalledWith('sidebar', { side: 'right' })
  })

  it('treats a sub-threshold wiggle as a click, not a drag', () => {
    const { onPanelMove } = renderShell()
    const handle = screen.getByTestId('panel-handle-sidebar')
    const stage = document.querySelector('.app-shell__stage')!

    fireEvent.pointerDown(handle, { clientX: 100, clientY: 50, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 102, clientY: 51, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: 102, clientY: 51, pointerId: 1 })
    expect(onPanelMove).not.toHaveBeenCalled()
  })
})
