import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PreviewMap } from './PreviewMap'
import type { DraftFeature } from './parseGeoJson'

const features: DraftFeature[] = [
  { id: '0', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { n: 1 } },
  { id: '1', geometry: { type: 'Point', coordinates: [91.1, 29.6] }, properties: { n: 2 } },
  { id: '2', geometry: null, properties: { n: 3 } },
]

describe('PreviewMap', () => {
  it('renders a named map region without crashing on a null geometry', () => {
    render(
      <PreviewMap features={features} selectedIds={[]} maxRendered={100} onSelect={vi.fn()} />,
    )
    expect(screen.getByRole('region', { name: /import preview map/i })).toBeInTheDocument()
  })

  it('reports how many features it is showing when the draft exceeds the cap', () => {
    render(<PreviewMap features={features} selectedIds={[]} maxRendered={1} onSelect={vi.fn()} />)
    expect(screen.getByText(/showing 1 of 2/i)).toBeInTheDocument()
  })

  it('does not announce a subset when everything fits', () => {
    render(<PreviewMap features={features} selectedIds={[]} maxRendered={100} onSelect={vi.fn()} />)
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument()
  })

  it('survives a feature whose geometry is malformed', () => {
    const broken: DraftFeature[] = [
      { id: '0', geometry: { type: 'Point', coordinates: 'nonsense' }, properties: {} },
    ]
    expect(() =>
      render(<PreviewMap features={broken} selectedIds={[]} maxRendered={10} onSelect={vi.fn()} />),
    ).not.toThrow()
  })
})
