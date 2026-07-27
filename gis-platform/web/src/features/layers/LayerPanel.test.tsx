import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as layersApi from '../../api/layers'
import type { Layer } from '../../api/types'
import { useLayerStore } from '../../state/layerStore'
import { LayerPanel } from './LayerPanel'

function makeLayer(id: string, name: string, zIndex: number): Layer {
  return {
    id,
    projectId: 'p1',
    name,
    kind: 'vector',
    source: {
      type: 'postgis',
      schemaName: 'gis_data',
      tableName: name.toLowerCase(),
      geometryColumn: 'geometry',
      idColumn: 'fid',
      srid: 4326,
    },
    style: null,
    visible: true,
    opacity: 1,
    zIndex,
    extent: null,
    featureCount: 12,
    srid: 4326,
    geometryType: 'POINT',
  } as Layer
}

const layers = [makeLayer('a', 'Roads', 0), makeLayer('b', 'Cities', 1)]

function renderPanel(overrides: Layer[] = layers) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LayerPanel projectId="p1" layers={overrides} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useLayerStore.setState({
    projectId: 'p1',
    selectedLayerId: null,
    selectedFeatureIds: [],
    truncatedLayerIds: [],
  })
})

afterEach(() => vi.restoreAllMocks())

describe('LayerPanel', () => {
  it('lists layers with the topmost first', () => {
    renderPanel()
    const names = screen.getAllByTestId('layer-name').map((el) => el.textContent)
    expect(names).toEqual(['Cities', 'Roads'])
  })

  it('shows the feature count and geometry type', () => {
    renderPanel()
    expect(screen.getAllByText(/12 features/)).toHaveLength(2)
    expect(screen.getAllByText(/POINT/)).toHaveLength(2)
  })

  it('toggling visibility calls updateLayer', async () => {
    const spy = vi.spyOn(layersApi, 'updateLayer').mockResolvedValue(layers[0]!)
    renderPanel()
    await userEvent.click(screen.getAllByLabelText(/toggle visibility/i)[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b', { visible: false }))
  })

  it('changing opacity calls updateLayer with the new value', async () => {
    const spy = vi.spyOn(layersApi, 'updateLayer').mockResolvedValue(layers[0]!)
    renderPanel()
    const slider = screen.getAllByLabelText(/opacity/i)[0]!
    fireOpacity(slider, 0.4)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b', { opacity: 0.4 }))
  })

  it('clicking a layer selects it in the store', async () => {
    renderPanel()
    await userEvent.click(screen.getByText('Roads'))
    expect(useLayerStore.getState().selectedLayerId).toBe('a')
  })

  it('removing a layer asks the API', async () => {
    const spy = vi.spyOn(layersApi, 'deleteLayer').mockResolvedValue(undefined)
    renderPanel()
    await userEvent.click(screen.getAllByLabelText(/remove layer/i)[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b'))
  })

  it('moving a layer up posts the full new order', async () => {
    const spy = vi.spyOn(layersApi, 'reorderLayers').mockResolvedValue(layers)
    renderPanel()
    // Displayed order is [Cities(b), Roads(a)]; move Roads up so it becomes
    // topmost. The server assigns z_index by list position (0 = bottom), so
    // the posted order is ascending z: Cities at the bottom, Roads on top.
    await userEvent.click(screen.getAllByLabelText(/move layer up/i)[1]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('p1', ['b', 'a']))
  })

  it('warns when a layer was truncated', () => {
    useLayerStore.setState({ truncatedLayerIds: ['a'] })
    renderPanel()
    expect(screen.getByRole('status')).toHaveTextContent(/showing a subset/i)
  })

  it('renders an empty state with no layers', () => {
    renderPanel([])
    expect(screen.getByText(/no layers yet/i)).toBeInTheDocument()
  })
})

/** `userEvent` cannot drag a range input; set the value and fire input. */
function fireOpacity(element: HTMLElement, value: number) {
  const input = element as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, String(value))
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
