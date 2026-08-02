import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as layersApi from '../api/layers'
import * as systemApi from '../api/system'
import { DashboardPage } from './DashboardPage'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(systemApi, 'getOverview').mockResolvedValue({
    projectCount: 2,
    layerCount: 5,
    layersByKind: { vector: 3, raster: 1, basemap: 1 },
    featureTotal: 1_010_004,
    recentLayers: [
      {
        id: 'l9',
        name: 'Cities',
        kind: 'vector',
        geometryType: 'POINT',
        featureCount: 4,
        projectId: 'p1',
        projectName: 'Walkthrough',
        createdAt: '2026-08-01T00:00:00Z',
      },
    ],
  })
  vi.spyOn(layersApi, 'listProjects').mockResolvedValue([
    { id: 'p1', name: 'Walkthrough', layerCount: 4 },
    { id: 'p2', name: 'Benchmarks', layerCount: 3 },
  ])
  vi.spyOn(layersApi, 'getProject').mockResolvedValue({
    id: 'p1',
    name: 'Walkthrough',
    view: { center: [0, 0], zoom: 2 },
    layers: [],
  } as never)
})

afterEach(() => vi.restoreAllMocks())

describe('DashboardPage', () => {
  it('shows platform statistics and project cards without any map machinery', async () => {
    const { container } = renderPage()

    expect(await screen.findByText('1,010,004')).toBeInTheDocument()
    expect(screen.getByText('projects')).toBeInTheDocument()
    expect(await screen.findByText('Benchmarks')).toBeInTheDocument()
    expect(screen.getAllByText(/open map/i).length).toBeGreaterThan(0)

    // The acceptance criterion that defines this page: zero map engine.
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('.ol-viewport')).toBeNull()
  })

  it('lists recent datasets linking to their details', async () => {
    renderPage()
    const link = await screen.findByRole('link', { name: 'Cities' })
    expect(link).toHaveAttribute('href', '/data/l9')
  })
})
