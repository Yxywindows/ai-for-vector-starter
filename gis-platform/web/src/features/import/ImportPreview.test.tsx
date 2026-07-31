import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../api/client'
import * as importsApi from '../../api/imports'
import { ImportPreview } from './ImportPreview'

const DOCUMENT = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: { name: 'Beijing', pop: 21540000 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [91.1, 29.6] },
      properties: { name: 'Lhasa', pop: 560000 },
    },
  ],
})

function fileOf(text: string, name = 'cities.geojson'): File {
  const file = new File([text], name, { type: 'application/geo+json' })
  // jsdom's File.text() is unreliable across versions; make it explicit.
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) })
  return file
}

const LIMITS = {
  allowedExtensions: ['.json', '.geojson'],
  maxFileBytes: 64 * 1024 * 1024,
  maxFeatures: 50_000,
  previewMaxFeatures: 5_000,
}

function renderPreview(file: File, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ImportPreview projectId="p1" file={file} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onClose }
}

beforeEach(() => {
  vi.spyOn(importsApi, 'getImportLimits').mockResolvedValue(LIMITS)
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('no worker in jsdom')
      }
    },
  )
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ImportPreview', () => {
  it('shows file metadata and the detected format without importing anything', async () => {
    const spy = vi.spyOn(importsApi, 'confirmImportDraft')
    renderPreview(fileOf(DOCUMENT))

    expect(await screen.findByText('cities.geojson')).toBeInTheDocument()
    expect(screen.getByText(/featurecollection/i)).toBeInTheDocument()
    expect(screen.getByText(/2 features/i)).toBeInTheDocument()
    expect(screen.getByText(/point/i)).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })

  it('selecting a grid row highlights the feature on the map', async () => {
    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    await userEvent.click(screen.getAllByRole('checkbox')[1]!)
    await waitFor(() =>
      expect(screen.getByTestId('preview-selection')).toHaveTextContent('1 selected'),
    )
  })

  it('confirms the import and reports the result', async () => {
    const spy = vi.spyOn(importsApi, 'confirmImportDraft').mockResolvedValue({
      layer: { id: 'l1', name: 'cities' } as never,
      importedCount: 2,
      rejectedCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
    })
    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    await userEvent.click(screen.getByRole('button', { name: /confirm import/i }))

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('p1', {
        name: 'cities',
        sourceFilename: 'cities.geojson',
        featureCollection: expect.objectContaining({ type: 'FeatureCollection' }),
      }),
    )
    expect(await screen.findByText(/imported 2/i)).toBeInTheDocument()
  })

  it('blocks a second confirmation while the first is in flight', async () => {
    let release: (value: never) => void = () => {}
    const spy = vi
      .spyOn(importsApi, 'confirmImportDraft')
      .mockReturnValue(new Promise((resolve) => (release = resolve as never)))

    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    const confirm = screen.getByRole('button', { name: /confirm import/i })
    await userEvent.click(confirm)
    await userEvent.click(confirm)
    await userEvent.click(confirm)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(confirm).toBeDisabled()
    release(undefined as never)
  })

  it('disables confirm while the draft has a validation error', async () => {
    const broken = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 0] }, properties: {} },
      ],
    })
    renderPreview(fileOf(broken))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm import/i })).toBeDisabled(),
    )
    expect(screen.getByText(/coordinate/i)).toBeInTheDocument()
  })

  it('renders a parse failure as an error state instead of crashing', async () => {
    renderPreview(fileOf('{not json'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not read/i)
    expect(screen.queryByRole('button', { name: /confirm import/i })).not.toBeInTheDocument()
  })

  it('surfaces a server rejection with its feature-level detail', async () => {
    vi.spyOn(importsApi, 'confirmImportDraft').mockRejectedValue(
      new ApiError(422, 'invalid_request', 'The import draft failed validation', {
        errors: [
          { featureIndex: 1, field: null, code: 'coordinate_out_of_range', message: 'Out of range' },
        ],
      }),
    )
    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    await userEvent.click(screen.getByRole('button', { name: /confirm import/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/out of range/i)
  })

  it('rejects a file above the configured size limit before parsing', async () => {
    vi.spyOn(importsApi, 'getImportLimits').mockResolvedValue({ ...LIMITS, maxFileBytes: 5 })
    renderPreview(fileOf(DOCUMENT))
    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i)
  })

  it('asks for confirmation before closing with unsaved edits', async () => {
    const { onClose } = renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')

    // No edits yet: closing is immediate.
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(window.confirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('prompts when cancelling after an edit and leaves the server untouched', async () => {
    const spy = vi.spyOn(importsApi, 'confirmImportDraft')
    const { onClose } = renderPreview(fileOf(DOCUMENT))
    const cell = await screen.findByTestId('cell-0-name')
    await userEvent.dblClick(cell)
    await userEvent.keyboard('X{Enter}')

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(window.confirm).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
  })
})
