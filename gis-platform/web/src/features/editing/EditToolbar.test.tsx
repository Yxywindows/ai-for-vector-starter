import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Layer } from '../../api/types'
import { MapProvider } from '../../map/MapProvider'
import { EditToolbar } from './EditToolbar'

const postgisLayer = {
  id: 'l1',
  projectId: 'p1',
  name: 'Cities',
  kind: 'vector',
  source: {
    type: 'postgis',
    schemaName: 'gis_data',
    tableName: 'cities',
    geometryColumn: 'geometry',
    idColumn: 'fid',
    srid: 4326,
  },
  style: null,
  visible: true,
  opacity: 1,
  zIndex: 0,
  extent: null,
  featureCount: 3,
  srid: 4326,
  geometryType: 'POINT',
} as Layer

const basemapLayer = {
  ...postgisLayer,
  id: 'l2',
  kind: 'basemap',
  source: { type: 'xyz', url: 'https://t/{z}/{x}/{y}.png', attribution: null },
} as Layer

function renderToolbar(layer: Layer | null) {
  return render(
    <MapProvider center={[0, 0]} zoom={2}>
      <EditToolbar layer={layer} />
    </MapProvider>,
  )
}

describe('EditToolbar', () => {
  it('renders nothing without a layer', () => {
    const { container } = renderToolbar(null)
    expect(container).toBeEmptyDOMElement()
  })

  it('refuses to edit a non-PostGIS layer', () => {
    renderToolbar(basemapLayer)
    expect(screen.getByText(/not editable/i)).toBeInTheDocument()
  })

  it('starts in browse mode', () => {
    renderToolbar(postgisLayer)
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('switching mode updates the pressed state', async () => {
    renderToolbar(postgisLayer)
    await userEvent.click(screen.getByRole('button', { name: 'Draw' }))
    expect(screen.getByRole('button', { name: 'Draw' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('save and discard are disabled with nothing pending', () => {
    renderToolbar(postgisLayer)
    expect(screen.getByRole('button', { name: /save edits/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled()
  })

  it('shows the pending count', () => {
    renderToolbar(postgisLayer)
    expect(screen.getByTestId('pending-count')).toHaveTextContent('0 pending')
  })
})
