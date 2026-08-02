import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DraftGrid } from './DraftGrid'
import type { DraftColumn, DraftFeature } from './parseGeoJson'

const columns: DraftColumn[] = [
  { name: 'name', type: 'text', mixed: false },
  { name: 'pop', type: 'number', mixed: false },
  { name: 'meta', type: 'json', mixed: false },
]

const features: DraftFeature[] = [
  {
    id: '0',
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { name: 'Beijing', pop: 21540000, meta: { a: 1 } },
  },
  {
    id: '1',
    geometry: { type: 'Point', coordinates: [3, 4] },
    properties: { name: 'Lhasa', pop: 560000, meta: null },
  },
]

function renderGrid(overrides: Partial<Parameters<typeof DraftGrid>[0]> = {}) {
  const props = {
    columns,
    features,
    selectedIds: [] as string[],
    search: '',
    cellErrors: {} as Record<string, string>,
    onSelectionChange: vi.fn(),
    onCellEdit: vi.fn(),
    onCellError: vi.fn(),
    ...overrides,
  }
  render(<DraftGrid {...props} />)
  return props
}

describe('DraftGrid', () => {
  it('renders a column per inferred property and a row per feature', async () => {
    renderGrid()
    expect(await screen.findByText('Beijing')).toBeInTheDocument()
    expect(screen.getByText('Lhasa')).toBeInTheDocument()
    for (const name of ['name', 'pop', 'meta']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(name, 'i') })).toBeInTheDocument()
    }
  })

  it('renders an explicit null distinctly from an empty cell', async () => {
    renderGrid()
    expect(await screen.findByText('null')).toBeInTheDocument()
  })

  it('shows nested values as compact JSON rather than [object Object]', async () => {
    renderGrid()
    expect(await screen.findByText('{"a":1}')).toBeInTheDocument()
  })

  it('reports a coerced value when a cell is edited', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-pop')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '22000000{Enter}')
    expect(props.onCellEdit).toHaveBeenCalledWith('0', 'pop', 22000000)
  })

  it('reports an error and does not edit when a value will not coerce', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-pop')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'lots{Enter}')
    expect(props.onCellEdit).not.toHaveBeenCalled()
    expect(props.onCellError).toHaveBeenCalledWith('0', 'pop', expect.stringMatching(/number/i))
  })

  it('clearing a cell yields null rather than an empty string', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-name')
    await userEvent.dblClick(cell)
    await userEvent.clear(within(cell).getByRole('textbox'))
    await userEvent.keyboard('{Enter}')
    expect(props.onCellEdit).toHaveBeenCalledWith('0', 'name', null)
  })

  it('rejects invalid JSON in a json cell and keeps the prior value', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-meta')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '{{not json{Enter}')
    expect(props.onCellEdit).not.toHaveBeenCalled()
    expect(props.onCellError).toHaveBeenCalledWith('0', 'meta', expect.stringMatching(/json/i))
  })

  it('marks a cell that carries a validation error', async () => {
    renderGrid({ cellErrors: { '0:pop': 'Not a finite number' } })
    expect(await screen.findByTestId('cell-0-pop')).toHaveClass('draft-grid__cell--error')
  })

  it('filters rows by a case-insensitive substring across every column', async () => {
    renderGrid({ search: 'lha' })
    expect(await screen.findByText('Lhasa')).toBeInTheDocument()
    expect(screen.queryByText('Beijing')).not.toBeInTheDocument()
  })

  it('reports selection changes by feature id', async () => {
    const props = renderGrid()
    await screen.findByText('Beijing')
    await userEvent.click(screen.getAllByRole('checkbox')[1]!)
    expect(props.onSelectionChange).toHaveBeenCalledWith(expect.arrayContaining(['0']))
  })
})
