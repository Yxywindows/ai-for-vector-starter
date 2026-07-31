import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as importsApi from '../../api/imports'
import * as layersApi from '../../api/layers'
import { AddLayerDialog } from './AddLayerDialog'

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AddLayerDialog projectId="p1" open onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(importsApi, 'getImportLimits').mockResolvedValue({
    allowedExtensions: ['.json', '.geojson'],
    maxFileBytes: 64 * 1024 * 1024,
    maxFeatures: 50_000,
    previewMaxFeatures: 5_000,
  })
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('no worker in jsdom')
      }
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AddLayerDialog file routing', () => {
  it('opens the preview for a .geojson instead of importing it', async () => {
    const importSpy = vi.spyOn(layersApi, 'importVector')
    renderDialog()

    const document = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { a: 1 } },
      ],
    })
    const file = new File([document], 'cities.geojson', { type: 'application/geo+json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(document) })

    await userEvent.upload(screen.getByLabelText(/geojson/i), file)

    expect(await screen.findByRole('dialog', { name: /import preview/i })).toBeInTheDocument()
    expect(importSpy).not.toHaveBeenCalled()
  })

  it('still imports a GeoPackage immediately', async () => {
    const importSpy = vi.spyOn(layersApi, 'importVector').mockResolvedValue({ id: 'l1' } as never)
    renderDialog()

    const file = new File([new Uint8Array([1, 2, 3])], 'roads.gpkg')
    await userEvent.upload(screen.getByLabelText(/geojson/i), file)

    await waitFor(() => expect(importSpy).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: /import preview/i })).not.toBeInTheDocument()
  })
})
