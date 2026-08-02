import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openGeoDB } from './idb'
import type { StoredEntry } from './idb'

const DB_NAME = 'graticule-geocache'

function entry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    key: 'k1',
    value: { hello: 'world' },
    etag: null,
    storedAt: 1_000,
    lastAccess: 1_000,
    size: 100,
    layerId: 'layer-1',
    ...overrides,
  }
}

function deleteRealDb(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await deleteRealDb()
})

describe('openGeoDB', () => {
  it('round-trips a put/get', async () => {
    const db = await openGeoDB(vi.fn())
    expect(db).not.toBeNull()
    const stored = entry()
    await db!.put('tiles', stored)
    await expect(db!.get('tiles', 'k1')).resolves.toEqual(stored)
    db!.close()
  })

  it('applies a net byte delta when overwriting a key with a different size', async () => {
    const db = await openGeoDB(vi.fn())
    await db!.put('tiles', entry({ key: 'k', size: 100 }))
    await expect(db!.totalBytes('tiles')).resolves.toBe(100)

    await db!.put('tiles', entry({ key: 'k', size: 40 }))

    await expect(db!.totalBytes('tiles')).resolves.toBe(40)
    db!.close()
  })

  it('deleteByLayer removes only matching-layer keys', async () => {
    const db = await openGeoDB(vi.fn())
    await db!.put('features', entry({ key: 'a', layerId: 'L1' }))
    await db!.put('features', entry({ key: 'b', layerId: 'L1' }))
    await db!.put('features', entry({ key: 'c', layerId: 'L2' }))

    const removed = await db!.deleteByLayer('features', 'L1')

    expect(removed).toBe(2)
    await expect(db!.get('features', 'a')).resolves.toBeUndefined()
    await expect(db!.get('features', 'b')).resolves.toBeUndefined()
    await expect(db!.get('features', 'c')).resolves.toMatchObject({ key: 'c' })
    db!.close()
  })

  it('evictLRU removes oldest-lastAccess entries until under target and returns evicted bytes', async () => {
    const db = await openGeoDB(vi.fn())
    await db!.put('tiles', entry({ key: 'old', lastAccess: 1_000, size: 50, layerId: 'L1' }))
    await db!.put('tiles', entry({ key: 'mid', lastAccess: 2_000, size: 50, layerId: 'L1' }))
    await db!.put('tiles', entry({ key: 'new', lastAccess: 3_000, size: 50, layerId: 'L1' }))
    await expect(db!.totalBytes('tiles')).resolves.toBe(150)

    const evicted = await db!.evictLRU('tiles', 60)

    expect(evicted).toBe(100)
    await expect(db!.totalBytes('tiles')).resolves.toBe(50)
    await expect(db!.get('tiles', 'old')).resolves.toBeUndefined()
    await expect(db!.get('tiles', 'mid')).resolves.toBeUndefined()
    await expect(db!.get('tiles', 'new')).resolves.toMatchObject({ key: 'new' })
    db!.close()
  })

  it('recovers from one failed open by deleting the database and retrying once', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new Error('simulated open failure')
    })
    const deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase')
    const onError = vi.fn()

    const db = await openGeoDB(onError)

    expect(db).not.toBeNull()
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    db!.close()
  })

  it('resolves null and fires onError when both open attempts fail', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('simulated open failure')
    })
    const onError = vi.fn()

    const db = await openGeoDB(onError)

    expect(db).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('resolves null and fires onError when indexedDB is unavailable', async () => {
    const original = globalThis.indexedDB
    // @ts-expect-error simulate an environment without IndexedDB support
    delete globalThis.indexedDB
    const onError = vi.fn()

    try {
      const db = await openGeoDB(onError)
      expect(db).toBeNull()
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.indexedDB = original
    }
  })
})
