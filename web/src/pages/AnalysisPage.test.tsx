import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as analysisApi from '../api/analysis'
import * as layersApi from '../api/layers'
import * as tasksApi from '../api/tasks'
import type { Task } from '../api/types'
import { AnalysisPage } from './AnalysisPage'

const LAYERS = [
  {
    id: 'l-cities',
    projectId: 'p1',
    name: 'Cities',
    kind: 'vector',
    source: { type: 'postgis' },
  },
  {
    id: 'l-zones',
    projectId: 'p1',
    name: 'Zones',
    kind: 'vector',
    source: { type: 'postgis' },
  },
  { id: 'l-osm', projectId: 'p1', name: 'OSM', kind: 'basemap', source: { type: 'xyz' } },
]

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    projectId: 'p1',
    projectName: 'Walkthrough',
    layerId: null,
    kind: 'analysis_buffer',
    state: 'queued',
    progress: 0,
    stage: null,
    params: {},
    result: null,
    error: null,
    retryOf: null,
    retryable: false,
    cancelRequested: false,
    provenance: { outputName: 'Buffered' },
    createdAt: '2026-08-02T10:00:00Z',
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-08-02T10:00:00Z',
    durationMs: null,
    ...overrides,
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AnalysisPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(layersApi, 'listProjects').mockResolvedValue([
    { id: 'p1', name: 'Walkthrough', layerCount: 3 },
  ])
  vi.spyOn(layersApi, 'getProject').mockResolvedValue({
    id: 'p1',
    name: 'Walkthrough',
    view: { center: [0, 0], zoom: 2 },
    layers: LAYERS,
  } as never)
  vi.spyOn(tasksApi, 'listTasks').mockResolvedValue({
    items: [
      makeTask({
        id: 'done',
        state: 'succeeded',
        layerId: 'l-out',
        provenance: { outputName: 'Cities buffered' },
      }),
      makeTask({ id: 'not-analysis', kind: 'vector_import' }),
    ],
    total: 2,
    page: 1,
    pageSize: 50,
  })
})

afterEach(() => vi.restoreAllMocks())

describe('AnalysisPage', () => {
  it('submits a buffer with typed parameters from vector layers only', async () => {
    const spy = vi
      .spyOn(analysisApi, 'submitAnalysis')
      .mockResolvedValue(makeTask({ id: 'fresh' }))
    renderPage()

    const input = await screen.findByRole('combobox', { name: 'Input layer' })
    await screen.findByRole('option', { name: 'Cities' }) // layers loaded
    // Only postgis vector layers are offered — no basemaps.
    expect(
      [...input.querySelectorAll('option')].map((option) => option.textContent),
    ).toEqual(['Choose a layer…', 'Cities', 'Zones'])

    await userEvent.selectOptions(input, 'l-cities')
    await userEvent.clear(screen.getByRole('spinbutton', { name: /distance/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /distance/i }), '2500')
    await userEvent.type(screen.getByRole('textbox', { name: /output dataset/i }), 'Buffered')
    await userEvent.click(screen.getByRole('button', { name: /run analysis/i }))

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('p1', 'buffer', {
        outputName: 'Buffered',
        layerId: 'l-cities',
        distanceMeters: 2500,
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(/submitted/i)
  })

  it('shows two-layer tools with their second input', async () => {
    renderPage()
    await screen.findByRole('combobox', { name: 'Input layer' })
    await userEvent.click(screen.getByRole('button', { name: 'Clip' }))
    expect(screen.getByRole('combobox', { name: 'Mask layer' })).toBeInTheDocument()
  })

  it('lists recent analysis runs with dataset links, excluding other task kinds', async () => {
    renderPage()
    expect(await screen.findByText('Cities buffered')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dataset/ })).toHaveAttribute('href', '/data/l-out')
    expect(screen.getByRole('link', { name: /open on map/ })).toHaveAttribute(
      'href',
      '/projects/p1/map',
    )
    expect(screen.queryByText('vector_import')).toBeNull()
  })

  it('never loads the map engine', async () => {
    const { container } = renderPage()
    await screen.findByRole('combobox', { name: 'Input layer' })
    expect(container.querySelector('canvas')).toBeNull()
  })
})
