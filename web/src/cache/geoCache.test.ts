import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api/client'
import {
  _pendingRevalidations,
  cachedFeatures,
  cachedTile,
  getMetrics,
  invalidateLayer,
  resetForTests,
  warmTile,
} from './geoCache'
import { featureKey, tileKey } from './keys'

// Mirrors geoCache.ts's internal FRESH_MS constant (60_000ms) — not exported,
// since it's an implementation constant, not part of the public contract.
const FRESH_MS = 60_000

const DB_NAME = 'graticule-geocache'

// `resetForTests()` now closes the IDB connection it was using (rather than
// just dropping the reference), so it's safe to delete the real (fake)
// database between tests here — same pattern as idb.test.ts.
function deleteRealDb(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

function smallBuf(n: number, fill: number): ArrayBuffer {
  const b = new ArrayBuffer(n)
  new Uint8Array(b).fill(fill)
  return b
}

function tileResponse(
  status: number,
  body: ArrayBuffer | null,
  headers: Record<string, string> = {},
): Response {
  if (status === 204 || status === 304) return new Response(null, { status, headers })
  return new Response(body, { status, headers })
}

function featuresResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  if (status === 204 || status === 304) return new Response(null, { status, headers })
  return new Response(JSON.stringify(body), { status, headers })
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: unknown = null,
): Response {
  return new Response(JSON.stringify({ error: { code, message, details } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  resetForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  // Close this test's IDB connection (resetForTests aborts in-flight work
  // and closes the connection) before deleting the database, so the delete
  // doesn't block behind a still-open connection.
  resetForTests()
  await deleteRealDb()
})

describe('keys', () => {
  it('tileKey embeds the layer, dataset version and tile coordinates', () => {
    expect(tileKey('layer-1', '2026-01-01T00:00:00Z', 4, 8, 3)).toBe(
      'tile:layer-1:2026-01-01T00:00:00Z:4:8:3',
    )
  })

  it('featureKey is deterministic regardless of the input object key order', () => {
    const a = featureKey('L', 'v1', '0,0,1,1', { simplify: 10, precision: 6, limit: 500 })
    const b = featureKey('L', 'v1', '0,0,1,1', { limit: 500, simplify: 10, precision: 6 })
    expect(a).toBe(b)
  })

  it('featureKey uses empty string for absent optionals without shifting fields', () => {
    const withLimit = featureKey('L', 'v1', 'bbox', { limit: 100 })
    const withoutAny = featureKey('L', 'v1', 'bbox', {})
    expect(withoutAny).toBe('feature:L:v1:bbox:::')
    expect(withLimit).not.toBe(withoutAny)
  })
})

describe('cachedTile', () => {
  it('miss -> network -> stored', async () => {
    const buf = smallBuf(4, 1)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(200, buf, { ETag: '"v1"' }))

    const result = await cachedTile('k-miss', '/tiles/miss', 'layerA')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('network')
    expect(new Uint8Array(result.value as ArrayBuffer)).toEqual(new Uint8Array(buf))
    expect(getMetrics().misses).toBe(1)
    expect(getMetrics().networkBytes).toBe(4)
  })

  it('second get is a mem hit with no additional fetch', async () => {
    const buf = smallBuf(4, 2)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(200, buf, { ETag: '"v1"' }))

    await cachedTile('k-mem', '/tiles/mem', 'layerA')
    const second = await cachedTile('k-mem', '/tiles/mem', 'layerA')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(second.source).toBe('mem')
    expect(getMetrics().memHits).toBe(1)
    expect(getMetrics().cachedBytesServed).toBe(4)
    expect(getMetrics().hitLatencyMs.mem.length).toBe(1)
  })

  it('caches a 204 empty tile as null and never refetches it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(204, null, { ETag: '"empty"' }))

    const first = await cachedTile('k-empty', '/tiles/empty', 'layerA')
    expect(first.value).toBeNull()
    expect(first.source).toBe('network')

    const second = await cachedTile('k-empty', '/tiles/empty', 'layerA')
    expect(second.value).toBeNull()
    expect(second.source).toBe('mem')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('throws a typed ApiError on non-OK responses and never caches them', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorResponse(500, 'server_error', 'boom'))

    const rejection = cachedTile('k-err', '/tiles/err', 'layerA')
    await expect(rejection).rejects.toBeInstanceOf(ApiError)
    await expect(rejection.catch((e: unknown) => e)).resolves.toMatchObject({
      status: 500,
      code: 'server_error',
      message: 'boom',
    })

    fetchSpy.mockResolvedValueOnce(tileResponse(200, smallBuf(4, 9), { ETag: '"ok"' }))
    const retried = await cachedTile('k-err', '/tiles/err', 'layerA')
    expect(retried.source).toBe('network')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest memory entries under budget pressure, falling back to IDB for the evicted key', async () => {
    const size = 10 * 1024 * 1024
    const bufs = [smallBuf(size, 0), smallBuf(size, 1), smallBuf(size, 2), smallBuf(size, 3)]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const i = Number(String(url).split('/').pop())
      return Promise.resolve(tileResponse(200, bufs[i] ?? null, { ETag: `"v${i}"` }))
    })

    for (let i = 0; i < 4; i++) {
      await cachedTile(`k-mem-evict-${i}`, `/tiles/mem-evict/${i}`, 'layerA')
    }
    expect(fetchSpy).toHaveBeenCalledTimes(4)

    const result = await cachedTile('k-mem-evict-0', '/tiles/mem-evict/0', 'layerA')

    expect(result.source).toBe('idb')
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  }, 20_000)

  it('evicts IDB entries once the store exceeds its byte budget', async () => {
    const sizeA = 200 * 1024 * 1024
    const sizeB = 60 * 1024 * 1024
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const isA = String(url).endsWith('/A')
      return Promise.resolve(
        tileResponse(200, new ArrayBuffer(isA ? sizeA : sizeB), { ETag: isA ? '"a"' : '"b"' }),
      )
    })

    await cachedTile('k-idb-evict-a', '/tiles/idb-evict/A', 'layerA')
    await cachedTile('k-idb-evict-b', '/tiles/idb-evict/B', 'layerA')

    expect(getMetrics().evictedBytes).toBeGreaterThanOrEqual(sizeA)

    fetchSpy.mockClear()
    const again = await cachedTile('k-idb-evict-a', '/tiles/idb-evict/A', 'layerA')
    expect(again.source).toBe('network')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('a stale hit fires exactly one conditional revalidation; a 304 refreshes storedAt without replacing the value', async () => {
    const buf1 = smallBuf(4, 5)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(200, buf1, { ETag: '"v1"' }))

    const first = await cachedTile('k-stale', '/tiles/stale', 'layerA')
    expect(new Uint8Array(first.value as ArrayBuffer)).toEqual(new Uint8Array(buf1))

    // Only fake Date: fake-indexeddb schedules its own task queue via
    // setImmediate/setTimeout, which must keep running for real or every
    // IDB operation issued from this point on would hang forever.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + FRESH_MS + 1_000)
    fetchSpy.mockResolvedValueOnce(tileResponse(304, null, { ETag: '"v1"' }))

    const second = await cachedTile('k-stale', '/tiles/stale', 'layerA')
    expect(second.source).toBe('mem')
    expect(new Uint8Array(second.value as ArrayBuffer)).toEqual(new Uint8Array(buf1))

    await _pendingRevalidations()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const revalidationInit = fetchSpy.mock.calls[1]?.[1]
    expect(new Headers(revalidationInit?.headers).get('If-None-Match')).toBe('"v1"')
    expect(getMetrics().revalidated304).toBe(1)
    expect(getMetrics().revalidated200).toBe(0)
  })

  it('a stale hit with a 200 revalidation replaces the cached value', async () => {
    const buf1 = smallBuf(4, 6)
    const buf2 = smallBuf(4, 7)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(200, buf1, { ETag: '"v1"' }))

    await cachedTile('k-stale-200', '/tiles/stale-200', 'layerA')

    // Only fake Date: fake-indexeddb schedules its own task queue via
    // setImmediate/setTimeout, which must keep running for real or every
    // IDB operation issued from this point on would hang forever.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + FRESH_MS + 1_000)
    fetchSpy.mockResolvedValueOnce(tileResponse(200, buf2, { ETag: '"v2"' }))

    await cachedTile('k-stale-200', '/tiles/stale-200', 'layerA')
    await _pendingRevalidations()

    expect(getMetrics().revalidated200).toBe(1)
    vi.useRealTimers()
    const third = await cachedTile('k-stale-200', '/tiles/stale-200', 'layerA')
    expect(new Uint8Array(third.value as ArrayBuffer)).toEqual(new Uint8Array(buf2))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('a 204 revalidation response refreshes metadata without discarding the cached value', async () => {
    const buf1 = smallBuf(4, 12)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(200, buf1, { ETag: '"v1"' }))

    await cachedTile('k-reval-204', '/tiles/reval-204', 'layerA')

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + FRESH_MS + 1_000)
    fetchSpy.mockResolvedValueOnce(tileResponse(204, null, { ETag: '"v1"' }))

    const stale = await cachedTile('k-reval-204', '/tiles/reval-204', 'layerA')
    // The 204 must not discard the cached (non-empty) value — it's treated
    // the same as a 304, refreshing metadata only.
    expect(new Uint8Array(stale.value as ArrayBuffer)).toEqual(new Uint8Array(buf1))

    await _pendingRevalidations()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(getMetrics().revalidated304).toBe(1)
    expect(getMetrics().revalidated200).toBe(0)

    vi.useRealTimers()
    const after = await cachedTile('k-reval-204', '/tiles/reval-204', 'layerA')
    expect(new Uint8Array(after.value as ArrayBuffer)).toEqual(new Uint8Array(buf1))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('a network error during revalidation is swallowed and keeps serving the stale cached value', async () => {
    const buf1 = smallBuf(4, 11)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(200, buf1, { ETag: '"v1"' }))

    await cachedTile('k-offline', '/tiles/offline', 'layerA')

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + FRESH_MS + 1_000)
    fetchSpy.mockRejectedValueOnce(new TypeError('network error'))

    const stale = await cachedTile('k-offline', '/tiles/offline', 'layerA')
    expect(stale.source).toBe('mem')
    expect(new Uint8Array(stale.value as ArrayBuffer)).toEqual(new Uint8Array(buf1))

    await _pendingRevalidations()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(getMetrics().revalidated200).toBe(0)
    expect(getMetrics().revalidated304).toBe(0)

    // The failed revalidation must not have corrupted anything — the stale
    // value keeps serving fine afterward too.
    vi.useRealTimers()
    const stillCached = await cachedTile('k-offline', '/tiles/offline', 'layerA')
    expect(stillCached.source).toBe('mem')
    expect(new Uint8Array(stillCached.value as ArrayBuffer)).toEqual(new Uint8Array(buf1))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent requests for the same key', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(tileResponse(200, smallBuf(4, 8), { ETag: '"v1"' }))

    const [r1, r2] = await Promise.all([
      cachedTile('k-dedupe', '/tiles/dedupe', 'layerA'),
      cachedTile('k-dedupe', '/tiles/dedupe', 'layerA'),
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(getMetrics().dedupedRequests).toBe(1)
    expect(r1.source).toBe('network')
    expect(r2.source).toBe('network')
  })

  it('aborts the shared fetch only once every joined caller has aborted', async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      capturedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })

    const c1 = new AbortController()
    const c2 = new AbortController()
    const p1 = cachedTile('k-abort', '/tiles/abort', 'layerA', c1.signal).catch((e: unknown) => e)
    const p2 = cachedTile('k-abort', '/tiles/abort', 'layerA', c2.signal).catch((e: unknown) => e)

    // Wait until both callers have actually joined the shared in-flight
    // fetch (observable as one deduped request, and one real fetch call)
    // before exercising abort semantics — aborting before both have joined
    // would abort against a refcount that isn't yet what the test expects.
    await vi.waitFor(() => {
      if (getMetrics().dedupedRequests !== 1 || fetchSpy.mock.calls.length !== 1) {
        throw new Error('both callers have not joined the in-flight fetch yet')
      }
    })

    c1.abort()
    const r1 = await p1
    expect(r1).toBeInstanceOf(DOMException)
    expect((r1 as DOMException).name).toBe('AbortError')
    expect(capturedSignal?.aborted).toBe(false)

    c2.abort()
    const r2 = await p2
    expect((r2 as DOMException).name).toBe('AbortError')
    expect(capturedSignal?.aborted).toBe(true)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(getMetrics().dedupedRequests).toBe(1)
  })

  it('a caller joining right after the shared fetch aborts gets a fresh fetch, not a spurious AbortError', async () => {
    let call = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      call++
      if (call === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      }
      return Promise.resolve(tileResponse(200, smallBuf(4, 13), { ETag: '"v2"' }))
    })

    const c1 = new AbortController()
    const p1 = cachedTile(
      'k-join-after-abort',
      '/tiles/join-after-abort',
      'layerA',
      c1.signal,
    ).catch((e: unknown) => e)
    await vi.waitFor(() => {
      if (fetchSpy.mock.calls.length !== 1) throw new Error('not started yet')
    })

    // Sole caller aborts — refcount hits 1/1, the shared controller aborts
    // synchronously, and the doomed in-flight entry must be swept out
    // immediately (not left for the rejection to propagate through
    // networkPromise's `.finally`, which happens at least a macrotask later).
    c1.abort()
    const r1 = await p1
    expect(r1).toBeInstanceOf(DOMException)

    // A second caller for the same key, issued right after, must not join
    // the now-doomed entry (which would reject it with a spurious
    // AbortError despite it never aborting anything) — it should see a
    // fresh in-flight slot and get the real second-call response.
    const second = await cachedTile('k-join-after-abort', '/tiles/join-after-abort', 'layerA')
    expect(second.source).toBe('network')
    expect(new Uint8Array(second.value as ArrayBuffer)).toEqual(new Uint8Array(smallBuf(4, 13)))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('cachedFeatures', () => {
  it('parses JSON and records the response byte length as size', async () => {
    const body = { type: 'FeatureCollection', features: [{ id: 1 }] }
    const text = JSON.stringify(body)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(featuresResponse(200, body, { ETag: '"f1"' }))

    const result = await cachedFeatures('k-feat', '/features/f1', 'layerA')

    expect(result.value).toEqual(body)
    expect(result.source).toBe('network')
    expect(getMetrics().networkBytes).toBe(new TextEncoder().encode(text).length)

    const second = await cachedFeatures('k-feat', '/features/f1', 'layerA')
    expect(second.source).toBe('mem')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('invalidateLayer', () => {
  it('clears both cache tiers for that layer only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(tileResponse(200, smallBuf(4, 1), { ETag: '"a"' }))
    fetchSpy.mockResolvedValueOnce(tileResponse(200, smallBuf(4, 2), { ETag: '"b"' }))

    await cachedTile('k-inv-a', '/tiles/inv/a', 'layerA')
    await cachedTile('k-inv-b', '/tiles/inv/b', 'layerB')
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    await invalidateLayer('layerA')

    fetchSpy.mockResolvedValueOnce(tileResponse(200, smallBuf(4, 1), { ETag: '"a2"' }))
    const afterA = await cachedTile('k-inv-a', '/tiles/inv/a', 'layerA')
    expect(afterA.source).toBe('network')
    expect(fetchSpy).toHaveBeenCalledTimes(3)

    const afterB = await cachedTile('k-inv-b', '/tiles/inv/b', 'layerB')
    expect(afterB.source).toBe('mem')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('prevents an in-flight fetch from resurrecting the entry after invalidation', async () => {
    let releaseFetch: ((r: Response) => void) | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return new Promise<Response>((resolve) => {
        releaseFetch = resolve
        // Deliberately does NOT react to abort, so this specifically
        // exercises the generation-check write-back guard rather than
        // relying on the abort alone — both are supposed to cooperate.
      })
    })

    const inFlightGet = cachedTile('k-inv-race', '/tiles/inv-race', 'layerRace')
    await vi.waitFor(() => {
      if (releaseFetch === undefined) throw new Error('not started yet')
    })

    await invalidateLayer('layerRace')

    // Release the response only after invalidation — simulates a fetch that
    // was already on the wire when the forced refresh landed.
    releaseFetch?.(tileResponse(200, smallBuf(4, 9), { ETag: '"late"' }))
    await inFlightGet

    fetchSpy.mockReset()
    fetchSpy.mockResolvedValueOnce(tileResponse(200, smallBuf(4, 10), { ETag: '"fresh"' }))
    const after = await cachedTile('k-inv-race', '/tiles/inv-race', 'layerRace')
    expect(after.source).toBe('network')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('resetForTests', () => {
  it('aborts in-flight fetches so a stale resolution cannot pollute the next test state', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })

    const stray = cachedTile('k-reset-stray', '/tiles/reset-stray', 'layerA').catch(
      (e: unknown) => e,
    )
    await vi.waitFor(() => {
      if (fetchSpy.mock.calls.length !== 1) throw new Error('fetch not called yet')
    })

    resetForTests()

    const strayResult = await stray
    expect(strayResult).toBeInstanceOf(DOMException)
    expect((strayResult as DOMException).name).toBe('AbortError')

    fetchSpy.mockResolvedValueOnce(tileResponse(200, smallBuf(4, 2), { ETag: '"fresh"' }))
    const after = await cachedTile('k-reset-stray', '/tiles/reset-stray', 'layerA')
    expect(after.source).toBe('network')
    expect(getMetrics().misses).toBe(1)
  })
})

describe('warmTile', () => {
  it('is a no-op when the key is already cached', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tileResponse(200, smallBuf(4, 3), { ETag: '"w"' }))
    await cachedTile('k-warm', '/tiles/warm', 'layerA')

    await warmTile('k-warm', '/tiles/warm', 'layerA')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('fetches and stores when not cached, deduping with a concurrent real load', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(tileResponse(200, smallBuf(4, 4), { ETag: '"w2"' }))

    const [warmed, loaded] = await Promise.all([
      warmTile('k-warm2', '/tiles/warm2', 'layerA'),
      cachedTile('k-warm2', '/tiles/warm2', 'layerA'),
    ])

    expect(warmed).toBeUndefined()
    expect(loaded.source).toBe('network')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(getMetrics().dedupedRequests).toBe(1)
  })

  it('swallows fetch errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorResponse(500, 'server_error', 'boom'))

    await expect(warmTile('k-warm-err', '/tiles/warm-err', 'layerA')).resolves.toBeUndefined()
  })
})

describe('IndexedDB unavailable', () => {
  it('falls back to memory-only caching and records idbErrors', async () => {
    const original = globalThis.indexedDB
    // @ts-expect-error simulate an environment without IndexedDB support
    delete globalThis.indexedDB
    resetForTests()

    try {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(tileResponse(200, smallBuf(4, 1), { ETag: '"m"' }))

      const first = await cachedTile('k-no-idb', '/tiles/no-idb', 'layerA')
      expect(first.source).toBe('network')
      expect(getMetrics().idbErrors).toBeGreaterThan(0)

      const second = await cachedTile('k-no-idb', '/tiles/no-idb', 'layerA')
      expect(second.source).toBe('mem')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.indexedDB = original
      resetForTests()
    }
  })
})
