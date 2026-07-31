import { afterEach, describe, expect, it, vi } from 'vitest'

import './parseWorker'
import type { ParseResponse } from './workerTypes'

/**
 * jsdom cannot construct a module Worker, so `useParseWorker.test.ts`
 * exercises the fallback path almost exclusively. This file makes up for
 * that by driving `parseWorker.ts`'s `onmessage` handler directly -- the
 * same code that runs inside the real worker thread -- to check its
 * request/response contract in isolation.
 */

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

describe('parseWorker onmessage handler', () => {
  it('installs a message handler at module load', () => {
    expect(self.onmessage).toBeTypeOf('function')
  })

  it('posts a successful ParseResponse for valid GeoJSON, echoing the requestId', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('postMessage', postMessage)

    self.onmessage?.call(self, { data: { requestId: 7, text: DOCUMENT } } as MessageEvent)

    expect(postMessage).toHaveBeenCalledTimes(1)
    const response = postMessage.mock.calls[0]?.[0] as ParseResponse
    expect(response.requestId).toBe(7)
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.result.features).toHaveLength(1)
    }
  })

  it('posts a coded error ParseResponse for malformed JSON, echoing the requestId', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('postMessage', postMessage)

    self.onmessage?.call(self, { data: { requestId: 8, text: '{not json' } } as MessageEvent)

    expect(postMessage).toHaveBeenCalledTimes(1)
    const response = postMessage.mock.calls[0]?.[0] as ParseResponse
    expect(response.requestId).toBe(8)
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.code).toBe('malformed_json')
    }
  })

  it('posts a coded error ParseResponse for an empty document', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('postMessage', postMessage)

    self.onmessage?.call(self, { data: { requestId: 9, text: '   ' } } as MessageEvent)

    expect(postMessage).toHaveBeenCalledTimes(1)
    const response = postMessage.mock.calls[0]?.[0] as ParseResponse
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.code).toBe('empty_document')
    }
  })

  it('posts a coded error ParseResponse for an unsupported root', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('postMessage', postMessage)

    self.onmessage?.call(self, { data: { requestId: 10, text: '"just a string"' } } as MessageEvent)

    expect(postMessage).toHaveBeenCalledTimes(1)
    const response = postMessage.mock.calls[0]?.[0] as ParseResponse
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.code).toBe('unsupported_root')
    }
  })
})
