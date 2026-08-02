import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as catalogApi from '../api/catalog'
import * as layersApi from '../api/layers'
import { DataCatalogPage } from './DataCatalogPage'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DataCatalogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(layersApi, 'listProjects').mockResolvedValue([
    { id: 'p1', name: 'Walkthrough', layerCount: 1 },
  ])
  vi.spyOn(layersApi, 'getProject').mockResolvedValue({
    id: 'p1',
    name: 'Walkthrough',
    view: { center: [0, 0], zoom: 2 },
    layers: [
      {
        id: 'l1',
        projectId: 'p1',
        name: 'Cities',
        kind: 'vector',
        source: { type: 'postgis' },
        style: null,
        visible: true,
        opacity: 1,
        zIndex: 0,
        extent: [0, 0, 1, 1],
        featureCount: 4,
        srid: 4326,
        geometryType: 'POINT',
      },
    ],
  } as never)
  vi.spyOn(catalogApi, 'listPostgisTables').mockResolvedValue([
    {
      schemaName: 'gis_data',
      tableName: 'parcels',
      geometryColumn: 'geom',
      srid: 4326,
      geometryType: 'POLYGON',
      primaryKey: 'id',
      estimatedRows: 12004,
    },
  ])
})

afterEach(() => vi.restoreAllMocks())

describe('DataCatalogPage', () => {
  it('lists project layers and unregistered PostGIS tables together', async () => {
    renderPage()
    expect(await screen.findByRole('link', { name: 'Cities' })).toHaveAttribute(
      'href',
      '/data/l1',
    )
    expect(await screen.findByText('gis_data.parcels')).toBeInTheDocument()
    expect(screen.getByText('(unregistered)')).toBeInTheDocument()
    expect(screen.getByText('12,004')).toBeInTheDocument()
  })

  it('narrows rows with the search box', async () => {
    renderPage()
    await screen.findByText('gis_data.parcels')
    await userEvent.type(screen.getByRole('searchbox', { name: /search datasets/i }), 'parcels')
    expect(screen.queryByRole('link', { name: 'Cities' })).toBeNull()
    expect(screen.getByText('gis_data.parcels')).toBeInTheDocument()
  })
})
