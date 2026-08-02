/** IndexedDB persistence tier for the geo-data cache.
 *
 * Never throws into callers: every operation is caught internally. Reads
 * degrade to `undefined`/`0`; mutations no-op after calling `onError`. If the
 * database can't be opened at all (missing IndexedDB, or open/upgrade keeps
 * failing after one delete+retry), `openGeoDB` resolves `null` and callers
 * fall back to memory-only caching.
 */

export type StoreName = 'tiles' | 'features' | 'meta'

export interface StoredEntry {
  key: string
  value: unknown
  etag: string | null
  storedAt: number
  lastAccess: number
  size: number
  layerId: string
}

export interface GeoDB {
  get(store: StoreName, key: string): Promise<StoredEntry | undefined>
  put(store: StoreName, entry: StoredEntry): Promise<void>
  delete(store: StoreName, key: string): Promise<void>
  deleteByLayer(store: StoreName, layerId: string): Promise<number>
  evictLRU(store: StoreName, targetBytes: number): Promise<number>
  totalBytes(store: StoreName): Promise<number>
  close(): void
}

const DB_NAME = 'graticule-geocache'
const DB_VERSION = 1
const STORE_NAMES: StoreName[] = ['tiles', 'features', 'meta']

// Running per-store byte totals live in `meta` under these keys so
// `totalBytes` avoids a full scan. `layerId: ''` marks them as bookkeeping
// so deleteByLayer/evictLRU (which only ever act on real layerId'd entries)
// can never sweep them up.
function bytesKey(store: StoreName): string {
  return `__bytes:${store}`
}

function bytesEntry(store: StoreName, value: number): StoredEntry {
  const now = Date.now()
  return { key: bytesKey(store), value, etag: null, storedAt: now, lastAccess: now, size: 0, layerId: '' }
}

function storesFor(store: StoreName): StoreName[] {
  return store === 'meta' ? ['meta'] : [store, 'meta']
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IDB request failed'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'))
  })
}

function openOnce(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of STORE_NAMES) {
        if (db.objectStoreNames.contains(name)) continue
        const os = db.createObjectStore(name, { keyPath: 'key' })
        os.createIndex('lastAccess', 'lastAccess')
        os.createIndex('layerId', 'layerId')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IDB open failed'))
  })
}

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

// Reads/writes the running byte total for `store` as part of the caller's
// own transaction, so the count and the mutation it reflects commit or fail
// together — a crash between the two can't desync them.
async function readBytes(tx: IDBTransaction, store: StoreName): Promise<number> {
  const current = await requestToPromise(tx.objectStore('meta').get(bytesKey(store)))
  return (current as StoredEntry | undefined)?.value as number | undefined ?? 0
}

async function bumpBytes(tx: IDBTransaction, store: StoreName, delta: number): Promise<void> {
  if (delta === 0) return
  const current = await readBytes(tx, store)
  tx.objectStore('meta').put(bytesEntry(store, Math.max(0, current + delta)))
}

function wrapDb(db: IDBDatabase, onError: () => void): GeoDB {
  return {
    async get(store, key) {
      try {
        const tx = db.transaction(store, 'readonly')
        const result = await requestToPromise(tx.objectStore(store).get(key))
        return result as StoredEntry | undefined
      } catch {
        return undefined
      }
    },

    async put(store, entry) {
      try {
        const tx = db.transaction(storesFor(store), 'readwrite')
        const os = tx.objectStore(store)
        const existing = (await requestToPromise(os.get(entry.key))) as StoredEntry | undefined
        os.put(entry)
        await bumpBytes(tx, store, entry.size - (existing?.size ?? 0))
        await txDone(tx)
      } catch {
        onError()
      }
    },

    async delete(store, key) {
      try {
        const tx = db.transaction(storesFor(store), 'readwrite')
        const os = tx.objectStore(store)
        const existing = (await requestToPromise(os.get(key))) as StoredEntry | undefined
        os.delete(key)
        if (existing) await bumpBytes(tx, store, -existing.size)
        await txDone(tx)
      } catch {
        onError()
      }
    },

    async deleteByLayer(store, layerId) {
      try {
        const tx = db.transaction(storesFor(store), 'readwrite')
        const os = tx.objectStore(store)
        let removed = 0
        let freed = 0
        await new Promise<void>((resolve, reject) => {
          const cursorReq = os.index('layerId').openCursor(IDBKeyRange.only(layerId))
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor) {
              resolve()
              return
            }
            const value = cursor.value as StoredEntry
            // Bookkeeping entries carry layerId '' and must never match a
            // real layerId, but skip explicitly as a second guard.
            if (value.layerId !== '') {
              freed += value.size
              removed += 1
              cursor.delete()
            }
            cursor.continue()
          }
          cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'))
        })
        await bumpBytes(tx, store, -freed)
        await txDone(tx)
        return removed
      } catch {
        onError()
        return 0
      }
    },

    async evictLRU(store, targetBytes) {
      try {
        const tx = db.transaction(storesFor(store), 'readwrite')
        const os = tx.objectStore(store)
        let remaining = await readBytes(tx, store)
        let evicted = 0
        await new Promise<void>((resolve, reject) => {
          const cursorReq = os.index('lastAccess').openCursor()
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor || remaining <= targetBytes) {
              resolve()
              return
            }
            const value = cursor.value as StoredEntry
            if (value.layerId === '') {
              // Never evict the byte-accounting bookkeeping entries.
              cursor.continue()
              return
            }
            cursor.delete()
            remaining -= value.size
            evicted += value.size
            cursor.continue()
          }
          cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'))
        })
        await bumpBytes(tx, store, -evicted)
        await txDone(tx)
        return evicted
      } catch {
        onError()
        return 0
      }
    },

    async totalBytes(store) {
      try {
        const tx = db.transaction('meta', 'readonly')
        return await readBytes(tx, store)
      } catch {
        return 0
      }
    },

    close() {
      db.close()
    },
  }
}

/** Opens `graticule-geocache` v1 (stores tiles/features/meta, keyPath 'key',
 * indexes 'lastAccess' and 'layerId'). On any open/upgrade failure it deletes
 * the database and retries ONCE; if that fails too, resolves null (caller
 * falls back to memory-only) and increments the passed onError counter. */
export async function openGeoDB(onError: () => void): Promise<GeoDB | null> {
  if (typeof indexedDB === 'undefined') {
    onError()
    return null
  }
  try {
    return wrapDb(await openOnce(), onError)
  } catch {
    await deleteDb()
    try {
      return wrapDb(await openOnce(), onError)
    } catch {
      onError()
      return null
    }
  }
}
