import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as featuresApi from '../../api/features'
import { useLayerStore } from '../../state/layerStore'
import { AttributeTable } from './AttributeTable'

const fields = {
  fields: [
    { name: 'fid', dataType: 'integer', nullable: false, editable: false },
    { name: 'name', dataType: 'text', nullable: true, editable: true },
    { name: 'population', dataType: 'integer', nullable: true, editable: true },
  ],
  idColumn: 'fid',
  geometryColumn: 'geometry',
}

const page = {
  columns: ['fid', 'name', 'population'],
  rows: [
    { fid: 1, name: 'Beijing', population: 21540000 },
    { fid: 2, name: 'Lhasa', population: 560000 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
}

function renderTable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AttributeTable layerId="l1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useLayerStore.setState({
    projectId: 'p1',
    selectedLayerId: 'l1',
    selectedFeatureIds: [],
    truncatedLayerIds: [],
  })
  vi.spyOn(featuresApi, 'getFields').mockResolvedValue(fields)
  vi.spyOn(featuresApi, 'getAttributes').mockResolvedValue(page)
})

afterEach(() => vi.restoreAllMocks())

describe('AttributeTable', () => {
  it('renders a header per column and a row per feature', async () => {
    renderTable()
    await screen.findByText('Beijing')
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'fid',
      'name',
      'population',
      '',
    ])
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + 2
  })

  it('shows the total row count', async () => {
    renderTable()
    expect(await screen.findByText(/2 features/i)).toBeInTheDocument()
  })

  it('clicking a header sorts and refetches', async () => {
    renderTable()
    await screen.findByText('Beijing')
    await userEvent.click(screen.getByRole('columnheader', { name: /population/i }))
    await waitFor(() =>
      expect(featuresApi.getAttributes).toHaveBeenLastCalledWith(
        'l1',
        expect.objectContaining({ sortBy: 'population', sortOrder: 'asc' }),
      ),
    )
  })

  it('clicking the same header twice flips the direction', async () => {
    renderTable()
    await screen.findByText('Beijing')
    const header = screen.getByRole('columnheader', { name: /population/i })
    await userEvent.click(header)
    await userEvent.click(header)
    await waitFor(() =>
      expect(featuresApi.getAttributes).toHaveBeenLastCalledWith(
        'l1',
        expect.objectContaining({ sortOrder: 'desc' }),
      ),
    )
  })

  it('editing a cell PATCHes the feature with a coerced value', async () => {
    const spy = vi.spyOn(featuresApi, 'updateFeature').mockResolvedValue({
      type: 'Feature',
      id: '1',
      geometry: null,
      properties: { name: 'Beijing', population: 22000000 },
    })
    renderTable()
    const cell = await screen.findByTestId('cell-1-population')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '22000000{Enter}')
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('l1', '1', { properties: { population: 22000000 } }),
    )
  })

  it('shows an inline error and does not PATCH when the value will not coerce', async () => {
    const spy = vi.spyOn(featuresApi, 'updateFeature')
    renderTable()
    const cell = await screen.findByTestId('cell-1-population')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'lots{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a whole number/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not open an editor on a non-editable column', async () => {
    renderTable()
    const cell = await screen.findByTestId('cell-1-fid')
    await userEvent.dblClick(cell)
    expect(within(cell).queryByRole('textbox')).toBeNull()
  })

  it('escape cancels the edit without patching', async () => {
    const spy = vi.spyOn(featuresApi, 'updateFeature')
    renderTable()
    const cell = await screen.findByTestId('cell-1-name')
    await userEvent.dblClick(cell)
    await userEvent.type(within(cell).getByRole('textbox'), 'X{Escape}')
    expect(spy).not.toHaveBeenCalled()
    expect(cell).toHaveTextContent('Beijing')
  })

  it('selecting a row records the feature id in the store', async () => {
    renderTable()
    await userEvent.click(await screen.findByText('Beijing'))
    expect(useLayerStore.getState().selectedFeatureIds).toEqual(['1'])
  })

  it('deleting a row calls the API', async () => {
    const spy = vi.spyOn(featuresApi, 'deleteFeature').mockResolvedValue(undefined)
    renderTable()
    await screen.findByText('Beijing')
    await userEvent.click(screen.getAllByLabelText(/delete feature/i)[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('l1', '1'))
  })

  it('renders a prompt when no layer is selected', () => {
    useLayerStore.setState({ selectedLayerId: null })
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AttributeTable layerId={null} />
      </QueryClientProvider>,
    )
    expect(screen.getByText(/select a layer/i)).toBeInTheDocument()
  })
})
