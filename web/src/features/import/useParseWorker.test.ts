import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ParseError, parseGeoJson } from './parseGeoJson'
import { useParseWorker } from './useParseWorker'
import type { ParseRequest } from './workerTypes'

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

/**
 * jsdom cannot construct a module Worker, so the hook's worker branch would
 * otherwise go untested. This stand-in implements just enough of the Worker
 * surface (listeners, postMessage, terminate) for tests to deliver canned
 * responses and fire error events by hand.
 */
class FakeWorker {
  static instances: FakeWorker[] = []
  terminated = false
  posted: ParseRequest[] = []
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(data: ParseRequest) {
    this.posted.push(data)
  }

  terminate() {
    this.terminated = true
  }

  emit(type: string, event: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

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

describe('useParseWorker with a live worker', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
  })

  it('resolves with the worker response and does not use the fallback', async () => {
    const { result } = renderHook(() => useParseWorker())
    const promise = result.current.parse(DOCUMENT)

    const worker = FakeWorker.instances[0]!
    const request = worker.posted[0]!
    const canned = parseGeoJson(DOCUMENT)
    worker.emit('message', { data: { requestId: request.requestId, ok: true, result: canned } })

    await expect(promise).resolves.toBe(canned)
    expect(result.current.usedFallback).toBe(false)
  })

  it('rethrows a worker error response as a ParseError with the same code and message', async () => {
    const { result } = renderHook(() => useParseWorker())
    const promise = result.current.parse('"just a string"')

    const worker = FakeWorker.instances[0]!
    const { requestId } = worker.posted[0]!
    worker.emit('message', {
      data: { requestId, ok: false, code: 'unsupported_root', message: 'no records found' },
    })

    await expect(promise).rejects.toMatchObject({
      name: 'ParseError',
      code: 'unsupported_root',
      message: 'no records found',
    })
  })

  it('delivers each response to the call that requested it', async () => {
    const { result } = renderHook(() => useParseWorker())
    const first = result.current.parse(DOCUMENT)
    const second = result.current.parse(DOCUMENT)

    const worker = FakeWorker.instances[0]!
    expect(worker.posted).toHaveLength(2)
    const [a, b] = worker.posted
    expect(a!.requestId).not.toBe(b!.requestId)

    const resultA = parseGeoJson(DOCUMENT)
    const resultB = parseGeoJson(DOCUMENT)
    worker.emit('message', { data: { requestId: a!.requestId, ok: true, result: resultA } })
    worker.emit('message', { data: { requestId: b!.requestId, ok: true, result: resultB } })

    await expect(first).resolves.toBe(resultA)
    await expect(second).resolves.toBe(resultB)
  })

  it('falls back inline when the worker fires an error mid-parse', async () => {
    const { result } = renderHook(() => useParseWorker())
    const promise = result.current.parse(DOCUMENT)

    const worker = FakeWorker.instances[0]!
    worker.emit('error', new Event('error'))

    const parsed = await promise
    expect(parsed.features).toHaveLength(1)
    expect(result.current.usedFallback).toBe(true)
    expect(worker.terminated).toBe(true)
  })

  it('settles via the inline fallback when the worker never responds', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useParseWorker())
      const promise = result.current.parse(DOCUMENT)

      vi.advanceTimersByTime(30_000)

      const parsed = await promise
      expect(parsed.features).toHaveLength(1)
      expect(result.current.usedFallback).toBe(true)
      expect(FakeWorker.instances[0]!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates the worker on unmount', () => {
    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() => useParseWorker())
      void result.current.parse(DOCUMENT)
      const worker = FakeWorker.instances[0]!
      expect(worker.terminated).toBe(false)

      unmount()
      expect(worker.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
