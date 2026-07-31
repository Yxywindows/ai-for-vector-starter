import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ParseError } from './parseGeoJson'
import { useParseWorker } from './useParseWorker'

const DOCUMENT = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { a: 1 },
    },
  ],
})

afterEach(() => vi.unstubAllGlobals())

describe('useParseWorker', () => {
  it('falls back to main-thread parsing when a Worker cannot be constructed', async () => {
    // jsdom has no module-worker support; constructing one throws, which is
    // exactly the condition the fallback exists for.
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker is not supported')
        }
      },
    )

    const { result } = renderHook(() => useParseWorker())
    const parsed = await result.current.parse(DOCUMENT)

    expect(parsed.features).toHaveLength(1)
    expect(result.current.usedFallback).toBe(true)
  })

  it('surfaces a coded ParseError from the fallback path', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker is not supported')
        }
      },
    )

    const { result } = renderHook(() => useParseWorker())
    await expect(result.current.parse('{not json')).rejects.toBeInstanceOf(ParseError)
  })
})
