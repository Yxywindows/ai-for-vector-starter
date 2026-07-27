import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as featuresApi from '../../api/features'
import * as layersApi from '../../api/layers'
import * as systemApi from '../../api/system'
import type { Layer } from '../../api/types'
import { StyleEditor } from './StyleEditor'

const vectorLayer = {
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

const rasterLayer = {
  ...vectorLayer,
  id: 'l2',
  kind: 'raster',
  source: { type: 'raster_file', path: 'a.tif', bandCount: 1, nodata: null, isCog: true },
} as Layer

function renderEditor(layer: Layer) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StyleEditor projectId="p1" layer={layer} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(featuresApi, 'getFields').mockResolvedValue({
    fields: [
      { name: 'fid', dataType: 'integer', nullable: false, editable: false },
      { name: 'name', dataType: 'text', nullable: true, editable: true },
      { name: 'population', dataType: 'integer', nullable: true, editable: true },
    ],
    idColumn: 'fid',
    geometryColumn: 'geometry',
  })
  vi.spyOn(featuresApi, 'getAttributes').mockResolvedValue({
    columns: ['fid', 'name', 'population'],
    rows: [
      { fid: 1, name: 'Beijing', population: 100 },
      { fid: 2, name: 'Lhasa', population: 900 },
    ],
    page: 1,
    pageSize: 500,
    total: 2,
  })
})

afterEach(() => vi.restoreAllMocks())

describe('StyleEditor (vector)', () => {
  it('starts on the single-symbol renderer', async () => {
    renderEditor(vectorLayer)
    expect(await screen.findByLabelText(/renderer/i)).toHaveValue('single')
  })

  it('changing the fill colour saves the style', async () => {
    const spy = vi.spyOn(layersApi, 'updateLayer').mockResolvedValue(vectorLayer)
    renderEditor(vectorLayer)
    const picker = await screen.findByLabelText(/fill colour/i)
    fireColor(picker, '#ff0000')
    await userEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'l1',
        expect.objectContaining({
          style: expect.objectContaining({ fill: expect.objectContaining({ color: '#ff0000' }) }),
        }),
      ),
    )
  })

  it('switching to categorized offers the layer fields', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'categorized')
    const field = await screen.findByLabelText(/classify by/i)
    expect(within(field).getAllByRole('option').map((o) => o.textContent)).toContain('population')
  })

  it('classifying builds one class per distinct value', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'categorized')
    await userEvent.selectOptions(await screen.findByLabelText(/classify by/i), 'name')
    await userEvent.click(screen.getByRole('button', { name: /classify/i }))
    await waitFor(() => expect(screen.getAllByTestId('class-row')).toHaveLength(2))
  })

  it('graduated classification builds the requested number of classes', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'graduated')
    await userEvent.selectOptions(await screen.findByLabelText(/classify by/i), 'population')
    await userEvent.click(screen.getByRole('button', { name: /classify/i }))
    await waitFor(() => expect(screen.getAllByTestId('class-row')).toHaveLength(5))
  })

  it('warns when a graduated classification finds no numeric values', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'graduated')
    await userEvent.selectOptions(await screen.findByLabelText(/classify by/i), 'name')
    await userEvent.click(screen.getByRole('button', { name: /classify/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no numeric values/i)
  })
})

describe('StyleEditor (raster)', () => {
  it('shows band and rescale controls, not vector controls', async () => {
    vi.spyOn(systemApi, 'getRasterStatistics').mockResolvedValue({
      bands: [{ band: 1, min: 0, max: 255, mean: 100, std: 20, percentile2: 5, percentile98: 250 }],
    })
    renderEditor(rasterLayer)
    expect(await screen.findByLabelText(/colour map/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/marker shape/i)).toBeNull()
  })

  it('fills the rescale range from band statistics', async () => {
    vi.spyOn(systemApi, 'getRasterStatistics').mockResolvedValue({
      bands: [{ band: 1, min: 0, max: 255, mean: 100, std: 20, percentile2: 5, percentile98: 250 }],
    })
    renderEditor(rasterLayer)
    await userEvent.click(await screen.findByRole('button', { name: /from statistics/i }))
    await waitFor(() => expect(screen.getByLabelText(/minimum/i)).toHaveValue(5))
    expect(screen.getByLabelText(/maximum/i)).toHaveValue(250)
  })
})

/** `userEvent` cannot type into a colour input; set the value natively and fire input. */
function fireColor(element: HTMLElement, value: string) {
  const input = element as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
