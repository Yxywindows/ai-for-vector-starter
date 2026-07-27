import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as systemApi from '../../api/system'
import { MemoryPanel } from './MemoryPanel'

const usage = [
  { layerId: 'a', bytes: 2_500_000, lastUsed: 1, pinned: true },
  { layerId: 'b', bytes: 500_000, lastUsed: 2, pinned: false },
]

const names = new Map([
  ['a', 'Roads'],
  ['b', 'Cities'],
])

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryPanel usage={usage} totalBytes={3_000_000} budgetBytes={10_000_000} names={names} />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('MemoryPanel', () => {
  it('renders per-layer usage in human units, largest first', () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockResolvedValue({
      rasterPool: {
        openHandles: 2,
        maxOpen: 8,
        idleTtlSeconds: 300,
        hits: 5,
        misses: 3,
        evictions: 1,
        keys: [],
      },
      featureBboxLimit: 2000,
      attributePageMax: 500,
      processRssBytes: 120_000_000,
    })
    renderPanel()
    const rows = screen.getAllByTestId('memory-row').map((row) => row.textContent)
    expect(rows[0]).toContain('Roads')
    expect(rows[0]).toContain('2.4 MB')
    expect(rows[1]).toContain('Cities')
  })

  it('marks pinned layers', () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockRejectedValue(new Error('offline'))
    renderPanel()
    expect(screen.getByLabelText(/Roads is pinned/i)).toBeInTheDocument()
  })

  it('shows the budget as a percentage', () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockRejectedValue(new Error('offline'))
    renderPanel()
    expect(screen.getByText(/30%/)).toBeInTheDocument()
  })

  it('shows the server pool stats once loaded', async () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockResolvedValue({
      rasterPool: {
        openHandles: 2,
        maxOpen: 8,
        idleTtlSeconds: 300,
        hits: 5,
        misses: 3,
        evictions: 1,
        keys: [],
      },
      featureBboxLimit: 2000,
      attributePageMax: 500,
      processRssBytes: 120_000_000,
    })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/2 \/ 8 open/)).toBeInTheDocument())
    expect(screen.getByText(/114\.4 MB/)).toBeInTheDocument()
  })
})
