import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as exportsApi from '../api/exports'
import * as featuresApi from '../api/features'
import * as layersApi from '../api/layers'
import * as tasksApi from '../api/tasks'
import type { Task } from '../api/types'
import { ExportsPage } from './ExportsPage'

const LAYERS = [
  {
    id: 'l-cities',
    projectId: 'p1',
    name: 'Cities',
    kind: 'vector',
    source: { type: 'postgis' },
  },
  { id: 'l-dem', projectId: 'p1', name: 'Elevation', kind: 'raster', source: { type: 'raster_file' } },
  { id: 'l-osm', projectId: 'p1', name: 'OSM', kind: 'basemap', source: { type: 'xyz' } },
]

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    projectId: 'p1',
    projectName: 'Walkthrough',
    layerId: 'l-cities',
    kind: 'export_vector',
    state: 'queued',
    progress: 0,
    stage: null,
    params: {},
    result: null,
    error: null,
    retryOf: null,
    retryable: false,
    cancelRequested: false,
    provenance: { format: 'geojson' },
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
        <ExportsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(layersApi, 'listProjects').mockResolvedValue([
    { id: 'p1', name: 'Walkthrough', layerCount: 3 },
  ] as never)
  vi.spyOn(layersApi, 'getProject').mockResolvedValue({
    id: 'p1',
    name: 'Walkthrough',
    view: { center: [0, 0], zoom: 2 },
    layers: LAYERS,
  } as never)
  vi.spyOn(featuresApi, 'getFields').mockResolvedValue({
    fields: [
      { name: 'name', dataType: 'text', nullable: true, editable: true },
      { name: 'population', dataType: 'integer', nullable: true, editable: true },
    ],
    idColumn: 'fid',
    geometryColumn: 'geometry',
  })
  vi.spyOn(tasksApi, 'listTasks').mockResolvedValue({
    items: [
      makeTask({
        id: 'ready',
        state: 'succeeded',
        result: {
          downloadName: 'cities.geojson',
          sizeBytes: 2048,
          format: 'geojson',
          retention: 'manual',
        },
      }),
      makeTask({
        id: 'broken',
        state: 'failed',
        error: { code: 'invalid_request', message: 'Unknown export fields', details: {} },
      }),
      makeTask({ id: 'not-export', kind: 'analysis_buffer' }),
    ],
    total: 3,
    page: 1,
    pageSize: 50,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ExportsPage', () => {
  it('lists only exportable datasets (postgis vector + raster, no basemaps)', async () => {
    renderPage()
    const picker = await screen.findByRole('combobox', { name: 'Dataset' })
    await screen.findByRole('option', { name: /Cities/ })
    const options = within(picker).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Choose a dataset…',
      'Cities ',
      'Elevation (raster)',
    ])
  })

  it('submits a vector export with format, CRS and a narrowed field list', async () => {
    const submitted = vi
      .spyOn(exportsApi, 'submitVectorExport')
      .mockResolvedValue(makeTask({ id: 'new' }))
    renderPage()
    const user = userEvent.setup()

    await screen.findByRole('option', { name: /Cities/ })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dataset' }), 'l-cities')

    // Field checkboxes come from getFields; uncheck one.
    const population = await screen.findByRole('checkbox', { name: 'population' })
    await user.click(population)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'gpkg')
    const crsInput = screen.getByRole('spinbutton', { name: 'Output CRS' })
    await user.clear(crsInput)
    await user.type(crsInput, '3857')
    await user.type(screen.getByRole('textbox', { name: 'File name' }), 'my cities')

    await user.click(screen.getByRole('button', { name: 'Start export' }))

    expect(submitted).toHaveBeenCalledWith('p1', {
      layerId: 'l-cities',
      format: 'gpkg',
      crs: 3857,
      filename: 'my cities',
      fields: ['name'],
    })
    await screen.findByRole('status')
  })

  it('omits the fields list entirely when every field stays checked', async () => {
    const submitted = vi
      .spyOn(exportsApi, 'submitVectorExport')
      .mockResolvedValue(makeTask({ id: 'new' }))
    renderPage()
    const user = userEvent.setup()

    await screen.findByRole('option', { name: /Cities/ })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dataset' }), 'l-cities')
    await screen.findByRole('checkbox', { name: 'population' })
    await user.click(screen.getByRole('button', { name: 'Start export' }))

    expect(submitted).toHaveBeenCalledWith('p1', {
      layerId: 'l-cities',
      format: 'geojson',
      crs: 4326,
      filename: undefined,
      fields: undefined,
    })
  })

  it('routes raster datasets to the raster endpoint and hides vector controls', async () => {
    const submitted = vi
      .spyOn(exportsApi, 'submitRasterExport')
      .mockResolvedValue(makeTask({ id: 'new', kind: 'export_raster' }))
    renderPage()
    const user = userEvent.setup()

    await screen.findByRole('option', { name: /Elevation/ })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dataset' }), 'l-dem')

    expect(screen.getByText('Raster datasets export as GeoTIFF.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Format' })).not.toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: 'Output CRS' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Start export' }))
    expect(submitted).toHaveBeenCalledWith('p1', { layerId: 'l-dem', filename: undefined })
  })

  it('shows finished exports with size and a direct download link, failures with codes', async () => {
    renderPage()

    const list = within(await screen.findByRole('list'))
    expect(await list.findByText('cities.geojson')).toBeInTheDocument()
    expect(list.getByText(/2 KB/)).toBeInTheDocument()

    const download = list.getByRole('link', { name: /download/ })
    expect(download).toHaveAttribute('href', '/api/v1/tasks/ready/download')
    expect(download).toHaveAttribute('download')

    expect(list.getByText('invalid_request')).toBeInTheDocument()
    // Non-export tasks stay out of this list.
    expect(list.queryByText(/analysis/)).not.toBeInTheDocument()
  })

  it('loads no map machinery', async () => {
    renderPage()
    await screen.findByRole('combobox', { name: 'Dataset' })
    expect(document.querySelector('canvas')).toBeNull()
    expect(document.querySelector('.ol-viewport')).toBeNull()
  })
})
