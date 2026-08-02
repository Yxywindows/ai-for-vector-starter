import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BasemapSelector } from './BasemapSelector'

afterEach(() => {
  vi.unstubAllEnvs()
})

function renderSelector(value: string | null = null, notice: string | null = null) {
  const onChange = vi.fn()
  render(<BasemapSelector value={value} onChange={onChange} notice={notice} />)
  return { onChange }
}

describe('BasemapSelector (R10)', () => {
  it('collapsed it names the current theme; expanded it lists nine options', async () => {
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.test')
    renderSelector('mapbox-dark')

    const trigger = screen.getByRole('button', { name: /Basemap/ })
    expect(trigger).toHaveTextContent('Dark')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    const options = screen
      .getAllByRole('button')
      .filter((button) => button.className.includes('basemap-selector__option'))
    expect(options).toHaveLength(9) // project basemap + 8 themes
    expect(options[0]).toHaveTextContent('Project basemap')
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('choosing a theme reports it and collapses', async () => {
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.test')
    const { onChange } = renderSelector(null)

    await userEvent.click(screen.getByRole('button', { name: 'Basemap' }))
    await userEvent.click(screen.getByRole('button', { name: 'Satellite' }))
    expect(onChange).toHaveBeenCalledWith('mapbox-satellite')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Basemap/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Project basemap' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('without a token the Mapbox rows are disabled and say what is missing', async () => {
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', '')
    renderSelector(null)

    await userEvent.click(screen.getByRole('button', { name: 'Basemap' }))
    expect(screen.getByRole('button', { name: 'Light' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'High Contrast' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Project basemap' })).toBeEnabled()
    expect(screen.getByText(/VITE_MAPBOX_ACCESS_TOKEN/)).toBeInTheDocument()
  })

  it('surfaces a broken-theme notice', async () => {
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.test')
    renderSelector(null, 'Dark tiles are not loading (bad token?) — using the project basemap.')
    await userEvent.click(screen.getByRole('button', { name: 'Basemap' }))
    expect(screen.getByRole('status')).toHaveTextContent(/not loading/)
  })
})
