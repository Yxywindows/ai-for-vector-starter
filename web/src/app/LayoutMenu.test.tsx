import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LayoutMenu } from './LayoutMenu'
import { DEFAULT_LAYOUT, listPresets } from './workspaceLayout'

const LAYOUT = { ...DEFAULT_LAYOUT, sidebarSide: 'right' as const, sidebarWidth: 300 }

beforeEach(() => localStorage.clear())

function renderMenu(projectId = 'p1') {
  const onApply = vi.fn()
  render(<LayoutMenu projectId={projectId} layout={LAYOUT} onApply={onApply} />)
  return { onApply }
}

describe('LayoutMenu (R9)', () => {
  it('saves the current layout under a name and applies it back', async () => {
    const { onApply } = renderMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Workspace layouts' }))
    expect(screen.getByText('No saved layouts yet.')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: 'Layout name' }), 'review setup')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    const row = screen.getByRole('button', { name: 'review setup' })
    await userEvent.click(row)
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ sidebarSide: 'right', sidebarWidth: 300 }),
    )
    // Applying closes the menu.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('saves global presets that other projects can see', async () => {
    renderMenu('p1')
    await userEvent.click(screen.getByRole('button', { name: 'Workspace layouts' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Layout name' }), 'everywhere')
    await userEvent.click(screen.getByRole('checkbox', { name: 'all projects' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The row carries the scope tag in its accessible name.
    const row = screen.getByRole('button', { name: /^everywhere/ })
    expect(row).toHaveTextContent('all projects')
    expect(listPresets('some-other-project').map((preset) => preset.name)).toEqual([
      'everywhere',
    ])
  })

  it('deletes a preset', async () => {
    renderMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Workspace layouts' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Layout name' }), 'stale')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await userEvent.click(screen.getByRole('button', { name: 'Delete layout stale' }))
    expect(screen.queryByRole('button', { name: 'stale' })).not.toBeInTheDocument()
    expect(listPresets('p1')).toEqual([])
  })

  it('resets to the default layout', async () => {
    const { onApply } = renderMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Workspace layouts' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset to default layout' }))
    expect(onApply).toHaveBeenCalledWith(DEFAULT_LAYOUT)
  })
})
